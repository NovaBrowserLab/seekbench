import { defineConfig } from "./src/core/config.ts";

export default defineConfig({
	scenariosDir: "datasets/scenarios",
	runsDir: "runs",
	concurrency: 32,
	timeoutMs: 10_000,
	reps: 3,
	subjects: {
		/** 流程自检用的假被测对象, smoke 场景的结果来自固定夹具. */
		mock: {
			use: "mock",
			hitsFile: "test/fixtures/smoke.mock.json",
			latencyMs: 20,
		},
	},
});
