# 战术 AI：创作者接入与测试指南

本指南面向想试玩、复测或接入另一套 AI 的创作者。代码位于 `wanderingmoonn/grid-warchess` 的 `feature/ai-tactics-evaluation` 分支，使用远端原版的规则体系。

## 版本与结果

| 项目 | 固定版本 / 结果 |
| --- | --- |
| 上游基础与冻结对手 | `5fb8e5ba0bbdece226db60c3bc92ae5c5beaee32` |
| 已验证的优化实现 | `a70c29fc65a273f8a1097d51e073dcbb0ead6f5b` |
| 战术档对战 | 208 场，149 胜 / 50 负 / 9 未决，**总胜率 71.6%** |
| 战术档配对 bootstrap 95% 区间 | 64.9%–78.4%；单侧 Hoeffding 95% 下界 59.6% |
| 高级档对战 | 104 场，68 胜 / 32 负 / 4 未决，总胜率 65.4%；未通过预设的保守统计门槛 |
| 回归检查 | 463 项：规则 319、AI 场景 25、评估方法 7、UI 112 |

71.6% 是对指定旧 AI 的实测结果，分母包含未决局；不是对玩家的胜率，也不保证所有地图都领先。工业时代与火山群是已观察到的弱项。原始对手和优化版都使用同一个规则引擎，包括高差相关的攻城、反击与威胁范围修正。

发布时增加的指南、CI 和规则书生成格式修正不改变上述 AI、规则与评估器内容。复现报告的代码指纹应为：

```text
9cb3cda9283080cd6ade3881f910dc3a5521c1f9df598732b8a0223c0d1af19b
```

详细配置、分组胜率和局限见 [合并验证报告](AI-UPSTREAM-MERGE-2026-10-28.md)，配对结果见 [验收记录 JSON](benchmarks/ai-2026-10-28-merged.json)。第一轮 71.1% 的历史记录使用更早对手，不能与这轮混合统计。

## 下载并试玩

安装 Git 和 Node 24。本版使用 Node 24.21.0 验证；Node 18 不支持这些 TypeScript 脚本。以下命令可逐行用于 PowerShell、macOS 或 Linux 终端：

```sh
git clone --branch feature/ai-tactics-evaluation --single-branch https://github.com/wanderingmoonn/grid-warchess.git grid-warchess-ai-test
cd grid-warchess-ai-test
git rev-parse HEAD
npm ci
npm run dev -- --port 5188 --strictPort
```

打开 `http://127.0.0.1:5188`。这个单独端口也将测试版的浏览器存档与默认 5178 端口分开。离线试玩与以下评估无需配置模型 API 密钥或云数据库。

1. 开始**新对局**，AI 难度选择 **「中级 AI」**（2026-10-28 之前叫「战术 AI · 测试」）。该档开启速攻、骚扰和弃城发展。
2. 选择人机对战可体验对手行为，选择双 AI 观战可观察战术。双 AI 观战中的双方都是优化版；新旧 AI 比较请使用下文评估器。
3. 测试高差时启用 **「地形高差」**，选择高原、峡谷、火山群或沼泽地图。
4. 也可以组合英雄、城郭与物料、季节与气候扩展。高级档保留战斗与预算改进，但不启用三种战略倾向；初级档保持入门行为。

本分支提供可运行源码，仓库 README 中原有的线上网址不代表已经部署了这版 AI。

需要锁定历史算法版本时，在这个独立副本中执行 `git switch --detach a70c29fc65a273f8a1097d51e073dcbb0ead6f5b`。该提交早于本指南与发布辅助改动；回到发布分支使用 `git switch feature/ai-tactics-evaluation`。不要在有未保存修改的开发副本中切换版本。

## 先做快速检查

```sh
npm test
npm run build
npm run manual
npm run evaluate:ai -- --profiles ancient,highland --pairs 1 --seed 900000 --level tactic --baseline 5fb8e5b --cap 200 --workers 2 --out results/creator-smoke.json
```

最后一条运行 2 组配置 × 1 个种子 × 2 个席位，共 **4 场**，只检查评估流程是否能运行，样本不足以判断强弱。脚本拒绝覆盖已有结果；再次运行时换一个 `--out` 文件名。`results/` 的新跑批文件按仓库约定不进入 Git。

`npm run test:ai-optimization` 可单独检查战术、高差兼容与统计方法。CI 对每个 PR 执行这些检查，以及规则、UI、规则书一致性和构建检查。

## 复现完整新旧对照

以下命令用的是报告中的固定种子，运行时请保持源码不变。`--workers` 只控制并发，建议按机器能力使用 2–6；它不改变种子和行动顺序。

```sh
npm run evaluate:ai -- --pairs 8 --seed 500000 --level tactic --baseline 5fb8e5b --cap 200 --workers 4 --out results/creator-tactic-208.json
npm run evaluate:ai -- --pairs 4 --seed 600000 --level advanced --baseline 5fb8e5b --cap 200 --workers 4 --out results/creator-advanced-104.json
npm run evaluate:ai -- --self --profiles ancient,highland --pairs 1 --seed 800000 --level tactic --baseline 5fb8e5b --cap 200 --workers 2 --out results/creator-baseline-self.json
```

第三条是**冻结原始 AI 的自对战**，用于检查席位交换和统计口径。它不是新版 AI 的自对战。两局共享同一地图种子，分别让被测一方担任 A 与 B。

| `--profiles` 名称 | 配置 |
| --- | --- |
| `ancient` / `medieval` / `gunpowder` / `industry` / `modern` | 五个时代，尺寸依次为 12 / 16 / 20 / 20 / 20 |
| `heroes` | 16×16、时代 3，奇想基础 + 英雄 + 骑士 |
| `cityworks` | 16×16、时代 2，城郭与物料 |
| `seasons` | 16×16、时代 2，季节与气候 |
| `highland` / `canyon` | 20×20、时代 3，高差高原 / 峡谷 |
| `volcanic` | 20×20、时代 4，高差火山群 |
| `marsh` | 16×16、时代 2，高差沼泽 |
| `combined` | 20×20、时代 3，高原 + 高差 + 季节 + 城郭物料 + 英雄与骑士 |

所有配置还包括默认的血战与先后手补偿。默认运行全部 13 组；`--pairs 8` 表示**每组** 8 个种子对，所以共 208 场。

结果中应关注：

- `fingerprint`：评估前后校验源码、两个冻结基准和依赖清单；指纹不同的运行不能直接当作同版复测。
- `summary.wins / losses / unresolved`：达到 200 个玩家回合仍未结束的局单列为未决，不按平局或半胜计算。
- `observedWinRate`：胜场 ÷ 全部场数，是本报告采用的主指标。
- `pairedBootstrap95`、`pairedHoeffdingLower95`、`clearlyBetter`：以种子对为独立单位。预设门槛要求至少 32 对、总胜率至少 60%，且两个下界均高于 50%。
- `byProfile` 与 `games[].config`：观察薄弱场景，核验实际建局后的配置；不要只报告总体胜率。
- `rejectionReasons`：规则拒绝的动作及原因。它和程序异常不同，新版会在预算内改选候选动作。

对复现结果的胜负与回合数应作确定性核对；耗时指标随机器和并发负载变化，不要求相同。若重新优化参数，请使用新的验收种子，保留全部配置与未决结果。

## 接入自己的程序

这套 AI 是 TypeScript 函数，不需要外部模型服务。主要接口为：

```ts
aiNextAction(state, budget, rejected): Action | null
```

它内部使用 `playerView` 获取本方信息。返回动作后必须通过 `applyAction` 执行；不能直接修改单位坐标、金币或城市。预算在每个己方回合新建，并在每次成功招募 / 升级后累加；失败候选排除后继续选择。

以下示例可保存到本仓库 `scripts/creator-ai-turn.ts`，供离线模拟调用。界面接入应沿用 `src/main.ts` 的异步调度，以保留暂停和换局取消处理。

```ts
import { aiNextAction, aiActionKey, AI_MAX_STEPS, DEFAULT_BUDGET } from '../src/core/ai.ts';
import { applyAction } from '../src/core/rules.ts';
import type { GameState } from '../src/core/types.ts';

export function runAiTurn(initial: GameState): GameState {
  let state = initial;
  const player = state.current;
  const budget = { ...DEFAULT_BUDGET };
  const rejected = new Set<string>();

  for (let step = 0; step < AI_MAX_STEPS && !state.winner; step++) {
    if (state.current !== player) break;
    const action = aiNextAction(state, budget, rejected);
    if (!action) break;
    const result = applyAction(state, action);
    if (!result.ok) {
      rejected.add(aiActionKey(action));
      continue;
    }
    rejected.clear();
    state = result.state;
    if (action.type === 'RECRUIT') budget.recruited++;
    if (action.type === 'UPGRADE') budget.upgraded++;
  }

  if (state.winner || state.current !== player) return state;
  const end = applyAction(state, { type: 'END_TURN' });
  if (!end.ok) throw new Error(end.reason);
  return end.state;
}
```

接入同源工程时，至少一起核对以下模块：

| 模块 | 作用 |
| --- | --- |
| `src/core/ai.ts` + `src/core/ai-tactics.ts` | 决策、预算、战术和威胁估计 |
| `src/core/rules.ts` | 目标高差射程、攻城和反击预览 / 执行一致性 |
| `src/main.ts` | 失败动作排除后继续决策，以及难度标签 |
| `scripts/test-ai-optimization.ts` | 战术触发、迷雾公平性、发展兑现、高差回归 |
| `scripts/evaluate-ai.ts` + `scripts/baselines/` | 可复现的配对评估与冻结对手 |

建议在独立开发分支上以 `5fb8e5b` 为共同基础进行三方合并。只复制一个 `ai.ts` 会遗漏威胁模块和规则兼容修正。自定义规则体系，尤其具有分步累计移动、其他胜负规则或不同生产预算的创作分支，需要额外适配，不能继承这里的 71.6% 结论。

## 接入另一套 AI 做比较

先在独立实验分支保存另一套实现，统一使用本原版规则引擎、兵种、地图与资源配置，再给评估器注册独立的决策函数。当前评估器内置的是“优化版 vs 冻结原版”；`--level tactic` 只选择难度，不能切换成其他实现。

两组对照应分别明确：

1. 新实现 vs `scripts/baselines/ai-5fb8e5b.ts` 中冻结的原始 AI。
2. 新实现 vs `a70c29f` 对应的优化 AI（包含 `ai-tactics.ts`）。

如果新实现包装了一个基础 AI，必须说明包装的具体版本；不能在换目录时让 `./ai.ts` 意外指向另一个实现。两边须使用相同视野、每回合 50 次决策上限、2 次招募与 1 次升级预算。不要为了减少失败动作而让某一方读取隐藏敌军。

新增控制器也应纳入代码指纹，记录各实现版本、实际规则版本、完整配置、种子、席位和动作拒绝原因。使用同一批种子交换先后手，保留所有未决局，并单列高差和英雄等配置。先检查低地仰攻 / 高地俯射、上下坡路径、攻城与反击、失败候选重选，再进行大样本胜率比较。

## 反馈测试结果

提供分支提交号、Node 版本、完整运行命令和结果 JSON 即可定位大多数问题。单局异常还应附配置名称、种子、被测方 A/B、发生回合与 `rejectionReasons`；界面问题可附截图或对局导出。反馈时标明是否改过规则、兵种、预算或 AI 参数。
