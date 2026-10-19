import {
	importLogCommand,
	statsCommand,
	synthCommand,
	validateCommand,
} from "./dataset.ts";
import {
	auditCommand,
	calibrateCommand,
	judgeCommand,
	sampleCommand,
} from "./judge.ts";
import { reportCommand, runCommand } from "./run.ts";
import { UsageError } from "./shared.ts";

const HELP = `seekbench: 搜索场景 Benchmark

用法:
  seekbench run --scenarios <ids> [--subjects <ids>] [选项]
  seekbench run --resume <run-id>
  seekbench report [run-id]
  seekbench judge [run-id]               对完成的运行重新打裁判分
  seekbench judge:sample [run-id]        分层抽样, 生成人工复核文件 audit.jsonl
  seekbench judge:audit [run-id]         计算人工复核与裁判的一致率, 并入校准集
  seekbench judge:calibrate              用校准集评估裁判, 报告一致率与加权 Kappa
  seekbench dataset:validate             校验题库
  seekbench dataset:stats                题库数量与长度分布
  seekbench dataset:synth                按场景模板合成 B 层用例
  seekbench dataset:import-log <file>    导入私有查询日志 (CSV 或 JSONL)

run 选项:
  --scenarios <ids>     场景 id, 逗号分隔
  --subjects <ids>      被测对象 id, 逗号分隔; 省略时为配置里的全部
  --mode <mode>         live 直连 (默认) / record 直连并录制 / replay 只读录制, 不需要密钥
  --refresh             record 时重新请求已录制的条目; 默认复用, 只补录缺的
  --reps <n>            每条用例对每个被测对象的重复次数, 只用于 live
  --concurrency <n>     全局在途请求上限
  --timeout <ms>        单次调用超时
  --tier <A|B>          只跑某一层的用例
  --source <prefix>     只跑来源以此开头的用例, 如 handwritten、synth
  --limit <n>           每个场景只跑过滤后的前 n 条用例
  --region <name>       标注机器所在区域, 写入运行记录
  --scenarios-dir <dir> 场景目录, 覆盖配置里的 scenariosDir
  --no-judge            不打裁判分, 只有规则打分
  --judge-fetch         抓取网页正文一起送裁判
  --resume <run-id>     续跑中断的运行, 沿用它的计划

judge 选项:
  --judge-fetch         同上 (judge)
  --size <n>            抽样条数, 默认取配置的 auditSize (judge:sample)
  --seed <text>         抽样种子, 默认为运行 id (judge:sample)
  --force               覆盖已填写过的 audit.jsonl (judge:sample)
  --from-run <run-id>   另取该运行 A 层的规则判定作为标注 (judge:calibrate)

dataset 选项:
  --scenarios <ids>     只处理这些场景; 省略时为场景目录下的全部
  --scenarios-dir <dir> 场景目录, 覆盖配置里的 scenariosDir
  --markdown            输出 Markdown 表格 (dataset:stats)
  --template <id>       只合成这个模板 (dataset:synth)
  --dry-run             只列出各模板还要合成多少条 (dataset:synth)
  --batch <name>        导入批次名, 默认取文件名 (dataset:import-log)
  --format <csv|jsonl>  日志格式, 默认按扩展名 (dataset:import-log)
  --min-length <n>      短于此长度的查询丢弃, 默认 2 (dataset:import-log)
  --names <file>        人名名单, 一行一个, 含名单人名的查询丢弃 (dataset:import-log)
  --out <dir>           输出目录, 默认为配置的 privateDir/<批次> (dataset:import-log)

通用选项:
  --config <path>       配置文件, 默认 seekbench.config.ts
  --runs-dir <dir>      运行记录目录, 覆盖配置里的 runsDir
  --cassettes-dir <dir> 录制目录, 覆盖配置里的 cassettesDir
  --judgments-dir <dir> 裁判缓存目录, 覆盖配置里的 judgmentsDir
  -h, --help            显示帮助

live 与 record 模式从环境变量读密钥, 缺密钥的被测对象跳过并告警; 裁判缺密钥时只用已有的裁判缓存.
不带 run-id 的命令取最近一次完成的运行.`;

const COMMANDS: Record<
	string,
	(args: string[], help: string) => Promise<number>
> = {
	run: runCommand,
	report: reportCommand,
	judge: judgeCommand,
	"judge:sample": sampleCommand,
	"judge:audit": auditCommand,
	"judge:calibrate": calibrateCommand,
	"dataset:validate": validateCommand,
	"dataset:stats": statsCommand,
	"dataset:synth": synthCommand,
	"dataset:import-log": importLogCommand,
};

export async function main(argv: readonly string[]): Promise<number> {
	const [command, ...args] = argv;
	try {
		if (
			command === undefined ||
			command === "help" ||
			command === "-h" ||
			command === "--help"
		) {
			console.log(HELP);
			return 0;
		}
		const handler = COMMANDS[command];
		if (!handler) throw new UsageError(`未知命令: ${command}`);
		return await handler(args, HELP);
	} catch (error) {
		if (
			error instanceof UsageError ||
			(error instanceof TypeError && "code" in error)
		) {
			console.error(`${error.message}\n\n${HELP}`);
			return 2;
		}
		console.error(error instanceof Error ? error.message : error);
		return 1;
	}
}

if (import.meta.main) {
	process.exitCode = await main(process.argv.slice(2));
}
