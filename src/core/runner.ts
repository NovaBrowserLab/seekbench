import { once } from "node:events";
import { createWriteStream, existsSync } from "node:fs";
import {
	mkdir,
	readFile,
	rename,
	rm,
	truncate,
	writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { gzip } from "node:zlib";
import { z } from "zod";
import { SubjectError, type TokenBucket } from "../adapters/_shared.ts";
import { parseJsonl, toJsonl } from "./jsonl.ts";
import { scoreHits } from "./metrics.ts";
import { normalizeHits } from "./normalize.ts";
import type { LoadedScenario } from "./scenarios.ts";
import {
	type Case,
	CaseRecord,
	type ExecutionError,
	Progress,
	type RunPlan,
	type Scenario,
	type SearchLang,
	type SearchSubject,
	SubjectResponse,
} from "./types.ts";

const gzipAsync = promisify(gzip);

export const CASES_FILE = "cases.jsonl";
export const CASES_ARCHIVE = "cases.jsonl.gz";
export const PROGRESS_FILE = "progress.json";

/** progress.json 的最短写入间隔. */
const PROGRESS_INTERVAL_MS = 1000;

export interface RunnerSubject {
	subject: SearchSubject;
	limiter: TokenBucket;
}

export interface ExecuteOptions {
	runId: string;
	runDir: string;
	startedAt: string;
	plan: RunPlan;
	/** 已按计划的过滤条件筛过用例. */
	scenarios: readonly LoadedScenario[];
	subjects: ReadonlyMap<string, RunnerSubject>;
	/** 中止后不再派发新请求, 在途请求的结果丢弃, 留待续跑. */
	signal?: AbortSignal;
	onProgress?: (progress: {
		done: number;
		total: number;
		errors: number;
	}) => void;
}

export interface ExecuteResult {
	/** 按场景、用例、被测对象、重复序号排序的全部明细, 含续跑前已完成的部分. */
	records: CaseRecord[];
	interrupted: boolean;
}

interface WorkItem {
	scenario: Scenario;
	kase: Case;
	runner: RunnerSubject;
	rep: number;
	lang: SearchLang;
}

/** 全局在途请求上限, 等待者先进先出. */
export class Semaphore {
	#available: number;
	readonly #waiters: Array<() => void> = [];

	constructor(size: number) {
		this.#available = size;
	}

	acquire(signal?: AbortSignal): Promise<void> {
		if (signal?.aborted) return Promise.reject(signal.reason);
		if (this.#available > 0) {
			this.#available--;
			return Promise.resolve();
		}
		return new Promise((resolve, reject) => {
			const onAbort = () => {
				const index = this.#waiters.indexOf(grant);
				if (index !== -1) this.#waiters.splice(index, 1);
				reject(signal?.reason);
			};
			const grant = () => {
				signal?.removeEventListener("abort", onAbort);
				resolve();
			};
			this.#waiters.push(grant);
			signal?.addEventListener("abort", onAbort, { once: true });
		});
	}

	release(): void {
		const next = this.#waiters.shift();
		if (next) next();
		else this.#available++;
	}
}

/** 场景语言为 mixed 时按查询里有没有汉字判断. */
export function queryLang(scenario: Scenario, query: string): SearchLang {
	if (scenario.lang !== "mixed") return scenario.lang;
	return /\p{Script=Han}/u.test(query) ? "zh" : "en";
}

function itemKey(
	scenario: string,
	caseId: string,
	subject: string,
	rep: number,
): string {
	return JSON.stringify([scenario, caseId, subject, rep]);
}

/** 等 promise 或 signal 中止, 先到者为准; 不配合 signal 的被测对象也不会让 Runner 无限等. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	promise.catch(() => {});
	return new Promise((resolve, reject) => {
		if (signal.aborted) {
			reject(signal.reason);
			return;
		}
		const onAbort = () => reject(signal.reason);
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error: unknown) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
}

/** 执行一次搜索并生成明细. 运行被中止时返回 null. 超时与被测对象的错误记进明细, 不抛出. */
async function executeItem(
	item: WorkItem,
	timeoutMs: number,
	runSignal: AbortSignal,
): Promise<CaseRecord | null> {
	const { scenario, kase, runner, rep, lang } = item;
	const { subject } = runner;
	const timeout = AbortSignal.timeout(timeoutMs);
	const signal = AbortSignal.any([timeout, runSignal]);
	const startedAt = new Date();
	const started = performance.now();
	let response: SubjectResponse | null = null;
	let error: ExecutionError | null = null;
	let failure: unknown = null;
	try {
		const raw = await untilAborted(
			subject.search(kase.query, {
				lang,
				count: scenario.k,
				signal,
				...kase.options,
			}),
			signal,
		);
		const parsed = SubjectResponse.safeParse(raw);
		if (!parsed.success) {
			throw new SubjectError(
				subject.id,
				`返回结构不符:\n${z.prettifyError(parsed.error)}`,
			);
		}
		response = parsed.data;
	} catch (cause) {
		if (runSignal.aborted) return null;
		failure = cause;
		error = timeout.aborted
			? { kind: "timeout", message: `${timeoutMs} ms 内未返回`, status: null }
			: {
					kind: "error",
					message: cause instanceof Error ? cause.message : String(cause),
					status: cause instanceof SubjectError ? cause.status : null,
				};
	}
	const latencyMs = performance.now() - started;
	const normalized = normalizeHits(response?.hits ?? [], scenario.k);
	const subjectError = failure instanceof SubjectError ? failure : null;
	return {
		scenario: scenario.id,
		caseId: kase.id,
		subject: subject.id,
		rep,
		startedAt: startedAt.toISOString(),
		latencyMs,
		cost: response?.cost ?? 0,
		calls: response?.calls ?? 1,
		retries: response?.diagnostics?.retries ?? subjectError?.retries ?? 0,
		requestId:
			response?.diagnostics?.requestId ?? subjectError?.requestId ?? null,
		totalEstimate: response?.totalEstimate ?? null,
		rawCount: response?.hits.length ?? 0,
		duplicates: normalized.duplicates,
		invalid: normalized.invalid,
		hits: scoreHits(normalized.hits, kase, startedAt),
		error,
	};
}

/** 读取已完成的明细. 进程中断可能留下半行, 截掉后再续写. */
async function readCompleted(path: string): Promise<CaseRecord[]> {
	if (!existsSync(path)) return [];
	let text = await readFile(path, "utf8");
	if (text !== "" && !text.endsWith("\n")) {
		text = text.slice(0, text.lastIndexOf("\n") + 1);
		await truncate(path, Buffer.byteLength(text));
	}
	return parseJsonl(text, CaseRecord, path);
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
	const temp = `${path}.tmp`;
	await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`);
	await rename(temp, path);
}

/** 节流写入 progress.json, 写入串行进行. */
class ProgressWriter {
	readonly #path: string;
	#state: Progress;
	#chain: Promise<void> = Promise.resolve();
	#lastWrite = 0;

	constructor(path: string, initial: Progress) {
		this.#path = path;
		this.#state = initial;
	}

	update(done: number, errors: number): void {
		this.#state = { ...this.#state, done, errors };
		if (Date.now() - this.#lastWrite >= PROGRESS_INTERVAL_MS) this.#write();
	}

	async finish(status: Progress["status"]): Promise<void> {
		this.#state = { ...this.#state, status };
		this.#write();
		await this.#chain;
	}

	#write(): void {
		this.#lastWrite = Date.now();
		const state = { ...this.#state, updatedAt: new Date().toISOString() };
		this.#chain = this.#chain.then(() => writeJsonAtomic(this.#path, state));
	}
}

/**
 * 执行一次运行的全部 (场景, 用例, 被测对象, 重复序号) 组合, 跳过 runDir 里已完成的部分.
 * 每个被测对象按自己的限速器排队, 拿到令牌后再占全局在途名额, 计时与超时从发出请求开始.
 * 明细逐行追加到 cases.jsonl; 全部完成后整理为 cases.jsonl.gz.
 */
export async function executeRun(
	options: ExecuteOptions,
): Promise<ExecuteResult> {
	const { runDir, plan } = options;
	await mkdir(runDir, { recursive: true });
	const casesPath = join(runDir, CASES_FILE);
	const records = await readCompleted(casesPath);
	const completed = new Set(
		records.map((r) => itemKey(r.scenario, r.caseId, r.subject, r.rep)),
	);

	const order = new Map<string, number>();
	const queues = new Map<string, WorkItem[]>();
	let total = 0;
	for (const { scenario, cases } of options.scenarios) {
		for (const kase of cases) {
			const lang = queryLang(scenario, kase.query);
			for (const [id, runner] of options.subjects) {
				if (!runner.subject.langs.includes(lang)) continue;
				for (let rep = 0; rep < plan.settings.reps; rep++) {
					const key = itemKey(scenario.id, kase.id, id, rep);
					order.set(key, total++);
					if (completed.has(key)) continue;
					const queue = queues.get(id) ?? [];
					queue.push({ scenario, kase, runner, rep, lang });
					queues.set(id, queue);
				}
			}
		}
	}

	let errors = records.filter((r) => r.error !== null).length;
	const progress = new ProgressWriter(join(runDir, PROGRESS_FILE), {
		runId: options.runId,
		status: "running",
		startedAt: options.startedAt,
		updatedAt: new Date().toISOString(),
		plan,
		total,
		done: records.length,
		errors,
	});
	progress.update(records.length, errors);
	options.onProgress?.({ done: records.length, total, errors });

	const internal = new AbortController();
	const runSignal = options.signal
		? AbortSignal.any([options.signal, internal.signal])
		: internal.signal;
	const slots = new Semaphore(plan.settings.concurrency);
	const inflight = new Set<Promise<void>>();
	const writer = createWriteStream(casesPath, { flags: "a" });
	let fatal: unknown = null;

	const execute = async (item: WorkItem) => {
		const record = await executeItem(item, plan.settings.timeoutMs, runSignal);
		if (record === null) return;
		records.push(record);
		if (!writer.write(`${JSON.stringify(record)}\n`))
			await once(writer, "drain");
		if (record.error !== null) errors++;
		progress.update(records.length, errors);
		options.onProgress?.({ done: records.length, total, errors });
	};

	await Promise.all(
		[...queues.values()].map(async (items) => {
			for (const item of items) {
				try {
					await item.runner.limiter.take(runSignal);
					await slots.acquire(runSignal);
				} catch {
					return;
				}
				const task: Promise<void> = execute(item)
					.catch((error: unknown) => {
						fatal ??= error;
						internal.abort();
					})
					.finally(() => {
						slots.release();
						inflight.delete(task);
					});
				inflight.add(task);
			}
		}),
	);
	await Promise.all([...inflight]);
	writer.end();
	await once(writer, "finish");
	if (fatal !== null) throw fatal;

	records.sort(
		(a, b) =>
			(order.get(itemKey(a.scenario, a.caseId, a.subject, a.rep)) ?? 0) -
			(order.get(itemKey(b.scenario, b.caseId, b.subject, b.rep)) ?? 0),
	);
	const interrupted = records.length < total;
	if (!interrupted) {
		await writeFile(
			join(runDir, CASES_ARCHIVE),
			await gzipAsync(toJsonl(records)),
		);
		await rm(casesPath);
	}
	await progress.finish(interrupted ? "interrupted" : "finished");
	return { records, interrupted };
}

export async function readProgress(runDir: string): Promise<Progress> {
	const path = join(runDir, PROGRESS_FILE);
	const parsed = Progress.safeParse(JSON.parse(await readFile(path, "utf8")));
	if (!parsed.success)
		throw new Error(`${path} 格式不符:\n${z.prettifyError(parsed.error)}`);
	return parsed.data;
}
