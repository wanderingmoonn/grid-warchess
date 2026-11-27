# 肉鸽 2.0 的扩展包接入（DLC）

> 2026-11-28 重构。上一版在 `data.ts` 里给每层/每支史**手写兵种名单**，只开 1–2 个包；
> 加一个新 DLC、改一个兵的时代、把一个兵标成 `requiresPack`，肉鸽都不会跟着变。
> 这一版照**原版战役模式**的接法重做：包是声明，兵池是算出来的，关卡自己持有
> `LevelDef.expansions.require`。

## 一、数据流（和战役模式一一对应）

```
EXPANSIONS（core 的包声明：units / hooks / requires / unlockEra）
   │
   ├─ PACK_PLANS（肉鸽定性：story / rule / support / system / locked）
   │
   ├─ poolOf(packs, 层, 低/高/上一代)
   │     ├─ era 窗口（层决定，修真有按层的例外）
   │     ├─ category === 'combat'、非水、非 summonedOnly、cost > 0
   │     ├─ 包级 requires 与兵种级 requiresPack 都要满足
   │     └─ 去重、按造价排序
   │
   ├─ LayerTheme（pool / poolHigh / prevPool / expansions）
   │
   └─ battleFor() → BattleInit.expansions
         → LevelDef.expansions.require
         → createMatch({ expansionIds, level })
         → core 按包注册 hooks / 兵种 / 规则书
```

和战役模式的对应关系：

| 战役模式 | 肉鸽 2.0 |
|---|---|
| 开局面板勾扩展 → `config.expansionIds` | 开局「本局扩展」勾规则/联动包 → `RunState.packs` |
| 关卡 `expansions.require / forbid / warn` | 每场战斗的 `LevelDef.expansions.require`（剧情包 + 可选包 + 队伍兵所属包） |
| `createMatch` 按 `EXPANSIONS` 算兵种表 | 同一入口，未复制一行 DLC 数据 |
| 战役兵种池 = 已开包的全部兵 | 肉鸽兵池 = 已开包 × 时代窗口 × 编制口径（见上） |

## 二、28 个包的定性

`src/roguelike/packs.ts` 的 `PACK_PLANS` 是唯一一张表；少写一个包会在控制台点名。

| 包 | 角色 | 层 / 时代 | 在肉鸽里做什么 |
|---|---|---|---|
| `era-arms` 时代军备 | story | L2（e3/e4）、L3 溢出（e5/e6） | 军械库的兵池；L3 混入机械化兵 |
| `fantasy` 奇想 | story | L2（e3/e4）、L3 溢出（e5/e6） | 异境的兵池；L3 混入神话单位（含 e6 英雄） |
| `cultivation` 修真 | story | L2（e1–e3 / e3–e4）、L3 无 | 池子只有 8+4 个，所以**按境界跨代**取；L3 末法之世没有修士 |
| `pack-contemporary` 信息化 | support（固定） | L3（e6） | 第三层高代底座；也是 e6 兵种的前置 |
| `air` 空军 | support（可勾） | L2 高代、L3 | 勾了之后按 e4–e6 进入池子；有射程的队伍才打得动 |
| `war-economy` 战争经济 | rule（默认开） | 全局 | 击杀赏金进 `state`，战后随金币带走 |
| `veterans` 老兵不死 | rule（默认开） | 全局 | 击杀成长 + 城下回血；击杀数跨战斗保留 |
| `scorched-earth` 死亡枕藉 | rule（默认开） | 全局 | 阵亡波及相邻；小图上放大"挤一团"的代价 |
| `trench` 堑壕战 | rule | 全局 | 林丘 +2 甲；对 e1 互殴影响过大，默认关 |
| `blitz` 闪电战 | rule | 全局 | 快速单位 +2 移；会明显缩短接敌回合 |
| `night-raid` 大雾来了 | rule | 全局 | 视野 −1；战斗屏不开雾，主要在 AI 视野 |
| `fortress` 固若金汤 | rule | 全局 | 所有城 +20 耐久 +1 甲；攻坚/层末变难 |
| `bloodbath` 血战 | rule | 全局 | 城不回血、移动视野 +1；短局影响小 |
| `last-stand` 哀兵必胜 | rule | 全局 | 残部伤害提高；守城战最明显 |
| `high-mobility` 高机动性 | rule | 全局 | 全军移动/射程/视野 +1 |
| `seasons` 季节与气候 | rule | 全局 | 四季改移动/视野/射程/护甲；顶栏有天气徽章与棋盘视图 |
| `naval` 海军 | system | — | 缺海图与临水城；三层地图无水 |
| `space-age` 太空时代 | system | — | 缺月球图/发射井 |
| `space-war` 太空战争 | system | — | 缺星图/空间站；依赖太空时代 |
| `city-works` 城郭与物料 | system | — | 缺城市经济/施工/多资源；玩家前三层没有城 |
| `height-terrain` 地形高差 | system | — | 缺等高线地图；肉鸽地图是平原创成 |
| `action-points` 行动点 | system | — | 会重写移动/攻击的回合结构，战斗屏与 AI 预算未适配 |
| `blackout` 浓雾蔽野 | system | — | 强制锁雾；肉鸽为"小图短兵相接"主动关雾 |
| `conscription` 大征兵 | locked | — | 起始金减半被出征金覆盖；造价修正只影响城内战产 |
| `turn-order-comp` 先后手补偿 | locked | — | 肉鸽没有"后手开局金" |
| `dark-turmoil` 黑暗动乱 | locked | — | 27 个单位全是 `summonedOnly`，不进常规兵池；留给 L4 |
| `armor-era7` 装甲时代 | system | — | e7–e8，前三层最高 e6；留给 L4 |
| `armor-era8` 聚变时代 | system | — | 同上 |

## 三、这次"查缺补漏"具体补了什么

1. **`campOnly` 不能当"不可用"**：修真的法器（青木剑/玄石印/寒水镜/赤炎珠）是
   `campOnly: true`——城市产线造不出来、只能由炼器炉产。肉鸽没有产线，兵只从战利品/
   商店/事件来，所以它们本来就是合格的战斗单位。上一版手写池里有它们，按"通用口径"
   过滤会把池子从 8+4 砍到 5+2。现在只排除 `summonedOnly`，不排除 `campOnly`。
2. **包级 `requires` 的闭包**：`packsForUnit` 只取 `[包, unit.requiresPack]`，
   漏了包自己的前置（`armor-era8 → armor-era7`、`dark-turmoil → cultivation`）。
   现在递归取闭包，部署时不会出现"包没开、兵静默消失"。
3. **`requiresPack` 的单位**：圣剑勇者/邪龙王要 `pack-contemporary`；池子按
   `enabledExpansionIds` 过滤，单开奇想拿不到它们，开信息化才拿得到。
4. **修真不能按"当代"取**：e1–e4 一共 8 个战斗单位（含 4 件法器），按层只取当代会
   退化成 5+2。`PACK_PLANS.cultivation.windows` 给第二层开了 e1–e3 / e3–e4 的窗口；
   第三层仍按 e5/e6 取（取不到，正好是"末法之世"）。
5. **奇想的召唤物**：`goblin-grunt / slimelet / imp / phantom / dragon-egg` 等是
   `summonedOnly`，不会进池、不会拉低"池内最低价"、不会让编成算法退化成一堆杂兵。
6. **`conscription`/`turn-order-comp` 不是"漏了"**：它们的钩子在肉鸽里被出征金覆盖或
   根本没有对应时点；标成 `locked` 并在界面写明，避免下次接手的人重复接一遍。
7. **系统包单列**：海图/星图/等高线/城市经济/行动点/锁雾，每条都写了缺哪一块；
   接的时候照着补，不要"先勾上试试"——那会把规则层推到没调过的状态。
8. **空军是可勾的联动包**：它的 e4–e6 兵按时代进入 L2 高代与 L3；地面纯近战队
   打不到空中目标，`run.ts` 的 `sanitizeAir` 仍保留（一场最多一个飞行单位、
   我方没有射程 ≥2 的兵时不给）。

## 四、加一个新 DLC 的姿势

1. 在 `src/core` 的 `EXPANSIONS` 里加包（兵种/钩子/前置）；
2. 在 `src/roguelike/packs.ts` 的 `PACK_PLANS` 里写一行定性：
   - 兵种包 → `kind:'story'` + `world` + `layers`；
   - 联动包 → `kind:'support'` + `layers` + `choosable/defaultOn`；
   - 纯规则包 → `kind:'rule'` + `choosable/defaultOn` + 一句话理由；
   - 需要新系统 → `kind:'system'` + **缺哪一块**；
3. 如果它的兵要进池，确认 `era` 与 `category` 写对；**不要往肉鸽里抄单位 id**。
4. 跑 `node --experimental-strip-types scripts/rogue-smoke.ts` 与
   `scripts/rogue-ui-smoke.ts`；再跑 `npm run test:rules` / `npm run test:ui`。
5. 更新本文件的表与 `ROGUELIKE-INDEX.md` 的决议。

## 五、战斗 UI 与战役模式的对齐

| 战役模式 | 肉鸽 2.0 |
|---|---|
| 顶栏：回合、目标、扩展徽章、棋盘视图 | 复用（去掉联机/迷雾/看全图/设置） |
| 资源条：金币、每回合收入、撤回 | 复用 `battleStatusShell` / `updateBattleStatus` |
| 侧栏：回合徽章、资源、席位、对局信息 | 复用 `renderPanel` |
| 单位卡：数值、状态、技能、扩展面板 | 复用；**补了「我军」清单**（没有城，队伍散在地图边缘） |
| 城卡 / 地形卡 | 复用（敌城只读；地形可查） |
| 战报、结束行动、认输 | 复用 |
| 攻击预览、缩放、强制模式 | 复用（`forecastCombat` / `fitBoardBox` / `forceMode`） |
| 联机、回放、上帝、选卡、指挥官、战报上传、城市生产/升级 | 删除（肉鸽没有这些玩法） |
| — | **补：外人卡**（中立单位场外交涉）、**补：守城波次**、**补：无城胜负** |

## 六、还没做的

- **L4 的两个终局层**不在本版范围；`armor-era7/8`、`space-*`、`dark-turmoil` 的定性
  已经写好，接 L4 时直接改 `layers` 即可。
- **海军**要等"多水地图 + 临水城"，不是加一行池子能解决的。
- **行动点**要重写战斗屏的"移动/攻击"按钮与 AI 预算，属于另一条改造线。
- **典藏/规则书入口**：本版战斗屏还没有"规则书"按钮；战役模式的设置里有，
  接的时候把 `books.ts` 按 `state.config.expansionIds` 打开即可。
