import { existsSync } from "node:fs";
import {
	appendFile,
	mkdir,
	readFile,
	rename,
	writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { constants, gunzip, gzip } from "node:zlib";
import { z } from "zod";
import { stableHash } from "./config.ts";
import { parseJsonl, toJsonl } from "./jsonl.ts";
import { Freshness, SearchLang, SubjectResponse } from "./types.ts";

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

/** 决定一次请求结果的参数, 录制的键由它与被测对象 id、查询算出. */
export const CassetteRequest = z.object({
	lang: SearchLang,
	count: z.int().positive(),
	freshness: Freshness.optional(),
	site: z.string().optional(),
});
export type CassetteRequest = z.infer<typeof CassetteRequest>;

export const CassetteEntry = z.object({
	key: z.string(),
	subject: z.string(),
	query: z.string(),
	request: CassetteRequest,
	/** 录制时被测对象配置的哈希, 回放时与当前配置对照. */
	configHash: z.string(),
	recordedAt: z.iso.datetime(),
	latencyMs: z.number().nonnegative(),
	/** 含 raw 原始响应. */
	response: SubjectResponse,
});
export type CassetteEntry = z.infer<typeof CassetteEntry>;

export function cassetteKey(
	subject: string,
	query: string,
	request: CassetteRequest,
): string {
	return stableHash([subject, query, request]);
}

/** 一个分片: 一个被测对象在一个场景版本下的全部录制. */
export interface ShardId {
	subject: string;
	scenario: string;
	version: string;
}

/**
 * 录制存储, 按 (被测对象, 场景版本) 分片, 一片一个 gzip 压缩的 JSONL 文件:
 * <dir>/<被测对象>/<场景>@<版本>.jsonl.gz. 录制时每条单独压缩后追加, 中断也不丢已录的部分;
 * 读取时多个 gzip 成员按顺序解压, 同键以后写的为准. compact 把分片重写为去重后的单个成员.
 */
export class CassetteStore {
	readonly dir: string;
	readonly #shards = new Map<string, Promise<Map<string, CassetteEntry>>>();
	readonly #writes = new Map<string, Promise<void>>();

	constructor(dir: string) {
		this.dir = dir;
	}

	path({ subject, scenario, version }: ShardId): string {
		return join(
			this.dir,
			encodeURIComponent(subject),
			`${encodeURIComponent(scenario)}@${encodeURIComponent(version)}.jsonl.gz`,
		);
	}

	/** 读取分片, 结果缓存在内存里. */
	load(shard: ShardId): Promise<Map<string, CassetteEntry>> {
		const path = this.path(shard);
		let loaded = this.#shards.get(path);
		if (!loaded) {
			loaded = readShard(path);
			this.#shards.set(path, loaded);
		}
		return loaded;
	}

	async get(shard: ShardId, key: string): Promise<CassetteEntry | null> {
		return (await this.load(shard)).get(key) ?? null;
	}

	/** 追加一条录制; 同一分片的写入串行进行. */
	async put(shard: ShardId, entry: CassetteEntry): Promise<void> {
		const path = this.path(shard);
		const entries = await this.load(shard);
		entries.set(entry.key, entry);
		const previous = this.#writes.get(path) ?? Promise.resolve();
		const write = previous.then(async () => {
			await mkdir(dirname(path), { recursive: true });
			await appendFile(path, await gzipAsync(toJsonl([entry])));
		});
		this.#writes.set(path, write);
		await write;
	}

	/** 把本次写过的分片重写为去重后的单个 gzip 成员. */
	async compact(): Promise<void> {
		for (const [path, write] of this.#writes) {
			await write;
			const entries = await this.#shards.get(path);
			if (!entries) continue;
			const temp = `${path}.tmp`;
			await writeFile(temp, await gzipAsync(toJsonl([...entries.values()])));
			await rename(temp, path);
		}
		this.#writes.clear();
	}
}

async function readShard(path: string): Promise<Map<string, CassetteEntry>> {
	const entries = new Map<string, CassetteEntry>();
	if (!existsSync(path)) return entries;
	/** 中断可能留下不完整的最后一个成员: 宽松解压, 丢掉末尾的半行. */
	let text = (
		await gunzipAsync(await readFile(path), {
			finishFlush: constants.Z_SYNC_FLUSH,
		})
	).toString("utf8");
	if (!text.endsWith("\n")) text = text.slice(0, text.lastIndexOf("\n") + 1);
	for (const entry of parseJsonl(text, CassetteEntry, path)) {
		entries.set(entry.key, entry);
	}
	return entries;
}
