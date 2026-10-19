import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, truncate } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { parseJsonl, toJsonl } from "../core/jsonl.ts";
import { Grade, Meaning, SourceTier, Staleness } from "../core/types.ts";

/** 缓存里的一条判定. 等级上限由刻度决定, 这里只校验在 0 到 4 之间. */
export const CachedJudgment = z.object({
	reason: z.string(),
	grade: Grade,
	sourceTier: SourceTier,
	stale: Staleness,
	meaning: Meaning.optional(),
});
export type CachedJudgment = z.infer<typeof CachedJudgment>;

const CacheEntry = z.object({
	key: z.string(),
	judgment: CachedJudgment,
	judgedAt: z.iso.datetime(),
});
type CacheEntry = z.infer<typeof CacheEntry>;

/** 一个分片: 一个裁判模型在一个场景 rubric 下的全部判定. */
export interface JudgmentShard {
	scenario: string;
	rubric: string;
}

/**
 * 裁判缓存, 存本机 <dir>/<裁判模型>/<场景>@<rubric 哈希>.jsonl, 按行追加, 同键以后写的为准.
 * 键见 judgmentKey: 只要裁判看到的内容不变就复用, 回放与重跑不再付裁判费用.
 */
export class JudgmentCache {
	readonly dir: string;
	readonly model: string;
	readonly #shards = new Map<string, Promise<Map<string, CacheEntry>>>();
	readonly #writes = new Map<string, Promise<void>>();

	constructor(dir: string, model: string) {
		this.dir = dir;
		this.model = model;
	}

	path({ scenario, rubric }: JudgmentShard): string {
		return join(
			this.dir,
			encodeURIComponent(this.model),
			`${encodeURIComponent(scenario)}@${rubric}.jsonl`,
		);
	}

	#load(shard: JudgmentShard): Promise<Map<string, CacheEntry>> {
		const path = this.path(shard);
		let loaded = this.#shards.get(path);
		if (!loaded) {
			loaded = readShard(path);
			this.#shards.set(path, loaded);
		}
		return loaded;
	}

	async get(shard: JudgmentShard, key: string): Promise<CachedJudgment | null> {
		return (await this.#load(shard)).get(key)?.judgment ?? null;
	}

	/** 追加一批判定; 同一分片的写入串行进行. */
	async put(
		shard: JudgmentShard,
		judgments: ReadonlyMap<string, CachedJudgment>,
	): Promise<void> {
		if (judgments.size === 0) return;
		const path = this.path(shard);
		const entries = await this.#load(shard);
		const judgedAt = new Date().toISOString();
		const added: CacheEntry[] = [];
		for (const [key, judgment] of judgments) {
			const entry = { key, judgment, judgedAt };
			entries.set(key, entry);
			added.push(entry);
		}
		const previous = this.#writes.get(path) ?? Promise.resolve();
		const write = previous.then(async () => {
			await mkdir(dirname(path), { recursive: true });
			await appendFile(path, toJsonl(added));
		});
		this.#writes.set(path, write);
		await write;
	}
}

/** 中断可能留下半行, 截掉后再续写. */
async function readShard(path: string): Promise<Map<string, CacheEntry>> {
	const entries = new Map<string, CacheEntry>();
	if (!existsSync(path)) return entries;
	let text = await readFile(path, "utf8");
	if (text !== "" && !text.endsWith("\n")) {
		text = text.slice(0, text.lastIndexOf("\n") + 1);
		await truncate(path, Buffer.byteLength(text));
	}
	for (const entry of parseJsonl(text, CacheEntry, path)) {
		entries.set(entry.key, entry);
	}
	return entries;
}
