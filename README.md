# 方格战棋

一个回合制战棋：古典到现代五个时代，基于地形的走位、跨河的桥、迷雾、联机对局。
没有 UI 框架，没有后端，一套纯函数规则内核 + 一层手写 DOM。

线上地址：<https://grid-warchess.app.workbuddy.host/?sharecode=XJSBOE55O7>

## 跑起来

```bash
npm ci
npm run dev      # 本地开发，http://127.0.0.1:5178
```

推荐 Node.js 24.15+（本次验证使用 24.21）；也支持 Node 22.22.2+ 或 26+。版本要求同时来自直接运行 TypeScript 的测试脚本和锁定的 jsdom 依赖。使用 `npm ci` 按锁文件安装依赖。

## 常用命令

| 命令 | 做什么 |
|---|---|
| `npm run dev` | 本地开发服务器 |
| `npm test` | 全部离线测试：规则、缺陷回归、开局、调度、存档/联机协议和 DOM |
| `npm run test:rules` | 只跑规则内核（无浏览器、无 mock，直接 import） |
| `npm run test:regressions` | 行动边界、运输编制、战斗预览与可见性回归 |
| `npm run test:policy` | v5 胜负、平局、持久产能、界面提示与报告分类 |
| `npm run test:setup` | 兵种导入、数据隔离与配置重建 |
| `npm run test:app` | AI 暂停/恢复、指挥官五轮批次与联机交接 |
| `npm run test:ai` | AI 威胁、攻守优先级、迷雾公平性与失败重选 |
| `npm run test:controller` | 外部操控者观察隔离、JSON 协议与异步执行的离线测试 |
| `npm run test:model` | DeepSeek 本地代理、模型面板与换局取消的离线测试 |
| `npm run test:model:live` | 真实 DeepSeek 联调，最多 3 次请求，独立测试局面；需先启动 dev，会产生 API 用量 |
| `npm run demo:controller` | 无网络的控制器演示：生产、规则拒绝、反馈和交接 |
| `npm run test:storage` | 存档、房间快照和提交协议的离线测试 |
| `npm run test:ui-safety` | 导入兵种、名称和日志在界面中的文本转义 |
| `npm run check` | TypeScript 类型检查 |
| `npm run test:room` | 真实云端联调，会创建测试房间；不包含在 `npm test` 中 |
| `npm run build` | `tsc --noEmit` + `vite build`，产出 `dist/` |
| `npm run manual` | 从代码里的兵种/能力/扩展数据重新生成规则书 |
| `npm run bench` | 双 AI 对打基准：每个组合 N 个种子，统计回合数与最高时代 |
| `npm run ablate` | 消融实验：逐个"撤销"某轮平衡改动，看它到底影响多少 |
| `npm run balance` | 生成平衡报告（JSON + markdown） |
| `npm run map` | 打印一张地图，排查地图生成问题 |
| `npm run sim` | 单局 AI 对打，逐步打印决策 |

环境变量对基准工具很好用，例如只跑古典 12×12 的 100 局：

```bash
BENCH_ERA=1 BENCH_SIZE=12 BENCH_SEEDS=100 npm run bench
AB_ERA=1 AB_SEEDS=60 npm run ablate
```

## 目录结构

```
src/core/      纯函数规则内核（不含 DOM、不含网络、不含 Math.random）
  types.ts       数据模型，GameState 可 JSON 序列化
  config.ts      ⭐ 所有可调数值都在这里：兵种、时代、地形、城市
  rules.ts       applyAction(state, action) → ActionResult，规则的唯一入口
  rules/         查询、属性修正、战斗计算；rules.ts 保留已有导出兼容调用方
  validation.ts  自定义兵种和存档共用的运行时数据校验
  ai.ts          AI 决策，只吃玩家视图，不作弊
  ai/threat.ts   按实际移动与射程构建的威胁缓存
  mapgen.ts      地图生成：城市布点、河、山脊、出生点
  fog.ts         战争迷雾与视野
  expansions.ts  扩展规则（血战、老兵、堑壕战……）与钩子
  era-packs.ts   ⭐ 五个时代兵种包（65 个新单位），数值推导写在文件头
  abilities.ts   特殊能力表（破甲、破城、盾墙……）
  setup.ts       开局装配、起始金币

src/app/       AI 回合执行、指挥官计划与批次、联机会话判断
src/controllers/ 外部操控者观察、单步指令协议、提示模板与本机代理客户端
server/        仅本机运行的 DeepSeek 代理、凭证读取和调用限额
src/main.ts    页面交互、渲染与应用模块装配
src/ui/        手写 DOM，没有框架
src/net/       联机房间与可离线测试的快照/提交协议
src/storage/   本机存档、房间独立草稿槽、v5 校验与 v4 迁移
scripts/       测试、基准、报告、规则书生成
docs/          重构说明与规则待决清单
```

## 三条硬约束

改代码前值得先知道这三条，它们是这套东西能撑住的原因：

1. **`applyAction` 是纯函数。** 吃一个 `GameState` 和一个 `Action`，返回新的 state，不碰 DOM、不发网络、不用 `Math.random`。所以整套规则能在 Node 里直接测，也能拿去做 AI 对打基准。
2. **一切都是确定性的。** 随机数走 `state.seed`，AI 的"手感"走 `aiNoise(seed, turn, log.length)`。同样的种子和操作序列，结果一定相同——测试和复现靠这个。
3. **AI 不作弊。** 它只拿到 `playerView(state, player)` 同一份迷雾视图，没有上帝视角。

AI 的决策流程、本轮改进与验证记录见 [算法 AI 说明](docs/ai.md)。

大模型操控者已接入 DeepSeek 本地代理。点击顶栏「模型操控」可让模型执行当前方的一回合，最多 12 次决策，随时暂停接管；不会自动连续调用。凭证保留在本机代理中。配置、真实联调记录及边界见 [DeepSeek 本地接入](docs/deepseek-local.md)，协议见 [控制器接口](docs/model-controller.md)。

## 改数值改哪里

绝大多数平衡工作只需要动 `src/core/config.ts` 里的 `UNIT_TYPES`（兵种）和 `ERAS`（时代）。改完跑：

```bash
npm test           # 有回归测试兜底，比如"射程必须大于移速"
npm run manual     # 规则书会跟着数据重新生成
npm run bench      # 看对局长度和时代推进有没有跑偏
```

如果某次改动让对局长度变了，先别猜原因，`npm run ablate` 会把每个改动的影响单独量出来。

## 时代兵种包（大型模组）

五个时代各一套兵种扩展，取材自真实历史的兵种、攻城器械与防御工事，**每套都比原版同期更多**：

| 时代 | 扩展 id | 新增 | 原版同期 | 代表单位 |
|---|---|---:|---:|---|
| 古典 | `pack-antiquity` | 14 | 12 | 重装步兵、军团兵、战车、战象、攻城槌、弩炮、瞭望塔 |
| 中世 | `pack-medieval` | 12 | 8 | 重装军士、弩手、骑射手、瑞士长矛兵、投石机、攻城塔 |
| 火药 | `pack-gunpowder` | 13 | 11 | 线列步兵、胸甲骑兵、猎兵、攻城加农炮、棱堡、风帆战列舰 |
| 工业 | `pack-industry` | 13 | 7 | 堑壕突击队、火焰喷射器、毒气兵、榴弹炮、列车炮、马克 I 坦克 |
| 现代 | `pack-modern` | 13 | 11 | 伞兵、突击队、反坦克炮、喀秋莎、重型坦克、机枪地堡 |

它们在开局面板的扩展列表里单独勾选，不勾选时对原版零影响。
数值怎么定的、每金耐久带、为什么古典包的价格要压在 60 金以内，都写在
`src/core/era-packs.ts` 的文件头注释里。

平衡数据在 `results/packs/report.md`（含每兵种的交换比、每百金杀伤/抗伤、采用率）。
重跑：

```bash
# 五个模组 + 五个基线，各 30 局（约 1 分钟一组）
node --experimental-strip-types scripts/balance-report.ts --era 1 --games 30 --seed 900 \
  --expansions bloodbath,turn-order-comp,pack-antiquity \
  --md results/packs/era1.md --out results/packs/era1.json
# ……其余四个时代同理（基线去掉 pack- 那一项）
npm run pack-report    # 汇总成 results/packs/report.md
```

**一条改数值时容易踩的坑**：开局部队是从 `era === 1 && category === 'combat' && domain !== 'water'`
的池子里**轮流白送且不看价钱**的。所以古典包（唯一 era 1 的包）的陆军战斗单位价格必须压在
60 金以内，否则开局就白送战象，整局基准会直接漂掉——`npm test` 里有一条专门守这个。

## 指挥官模式

开局选「你的角色 → 指挥官模式」后，玩家不再亲自走子，只排**接下来 5 回合各造什么兵**，
建造、升级、走位、攻击全部交给 AI。

- 顶栏下面一条「参谋部」横带，5 格生产序列，第一格标着「本回合」
- 每格可以是**一个兵种**、**「升级时代」**，或者**留空**（这回合故意不产兵也不升级）
- 每格下面标着「≈ N 金」：那一回合大概有多少钱可花（现有金币 + 中间几次收入 − 前面几格的花费），不够就变红
- **点一次「执行 5 回合」，5 个回合一起打完**，中途可中断；打完序列原样留着，排一次能用很多批
- 每回合共享一份产能：**招募 1 个单位或升级 1 座城市，二选一**，所有城市和军营共用；建造仍按建造者的行动次数结算。
- 已用产能随存档保存，刷新、导入或切换 AI 都不能恢复；**造不出来也照样消耗那一格**（钱不够、时代不够、编制满了都算）。失败行动本身不扣钱，结束回合时计划前移。
- 点名的兵不会被顶替：排了坦克造不起就空过，不会自动换个民兵顶上
- **升级权也归你**：没排「升级时代」，AI 不会自作主张升；排了，这一回合就专注升级、不产兵
- 棋盘只看不碰，这一方的走位归 AI

这条限制**对 AI 同样生效**：在指挥官模式下选「双 AI 观战」，两边每回合也只能招募或升级一次，
用来量这套限制下 AI 还能打成什么样（人类能一次排 5 格、AI 只知道当下造什么，
所以测的是下界）。

规则内核通过 `GameState.turnProduction` 记账，`GameState.orders` 保存计划；AI 与界面共用同一份产能检查。

## 胜负与平局（v5）

- 失去全部城市判负；只要还有城市，暂时无兵、无钱仍可等待收入。
- A、B 各行动一次是一完整轮。双方各行动 **100 次**后，城市多者获胜，同数城市为平局；不比较金币、兵力价格或城市等级。
- 最后一轮等 B 结束行动才裁决，保留双方同样次数的行动机会。一次行动的所有伤害先结算完，再判定胜负；双方都无城则平局。
- v5 保存正式平局和终局原因。旧 v4 存档会迁移；已结束的旧局保留结果，旧指挥官局当前回合的生产会保守封存一次，下一次轮到该方时恢复。

设计依据、例子和兼容方式见 [v5 规则说明](docs/rules-v5.md)。

## 联机

房间码就是通行证：把 6 位代码发给对方，谁拿到谁就能进这局。
在**结束回合（提交）或产生胜负结果**时把整局状态写到云端，所以对方看不到你这一回合正在怎么摆兵。终局可以发生在同一行动序号内，不需要强行再结束一回合。

一个必须说清的边界：`GameState` 是整块存进去的，服务端不参与规则计算。
**迷雾是界面约定，不是安全边界**——真要防作弊得把 `playerView` 挪到服务端算。

## 已知的待办

- 本轮重构范围、已修复问题及尚未拍板的玩法见 [重构与规则审查](docs/refactoring.md)。
- 联机防作弊（服务端算视野）
- 高时代攻城单位在中场对峙时推不到城下，工业时代仍有跑满回合上限的局
- 移动端触摸操作只做了基础适配
