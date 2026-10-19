import { defineConfig } from "./src/core/config.ts";

export default defineConfig({
	scenariosDir: "datasets/scenarios",
	runsDir: "runs",
	concurrency: 32,
	timeoutMs: 10_000,
	reps: 3,
	subjects: {
		/** 供应商适配器, 密钥从 <供应商>_API_KEY 环境变量读取. 各项配置见 docs/adapters/. */
		bocha: { use: "bocha" },
		brave: { use: "brave" },
		deepseek: { use: "deepseek" },
		exa: { use: "exa" },
		tavily: { use: "tavily" },
		/** 流程自检用的假被测对象, smoke 场景的结果来自固定夹具. */
		mock: {
			use: "mock",
			hitsFile: "test/fixtures/smoke.mock.json",
			latencyMs: 20,
		},
	},
});
