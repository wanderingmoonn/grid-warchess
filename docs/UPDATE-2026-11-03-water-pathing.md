# 修正「寻路判定被水挡住」· 2026-11-03（三）

> 两件事：**地雷改名「哥布林陷阱」**，以及把"谁能不能进水"这条判据从
> 五处各写一遍收成一处。

---

## 一、改名

| 位置 | 旧 | 新 |
|---|---|---|
| 留痕种类显示名 `MARK_KINDS['gb-mine'].name` | 地雷 | **哥布林陷阱** |
| 能力「布雷」的说明 | 埋一枚地雷 | 埋一枚**哥布林陷阱** |
| 战报 / 日志 | 埋下一枚地雷、踩响地雷 | 埋下一枚哥布林陷阱、踩响哥布林陷阱 |
| 规则书（9 册） | 地雷 | 哥布林陷阱 |

**id 仍是 `gb-mine`。** 它已经进了存档、战报和上报的快照；
改 id 会让老存档里地上的那几枚查不到种类，直接在加载时炸掉。
改的只是显示名——玩家看到的那一层。

---

## 二、「寻路判定被水挡住」到底在哪

规则层的 `reachableTiles` 一直是**按兵种**判地形的（`terrainOk`），
这条路径上没问题：`npm run probe:water` 把 36 个兵种逐个摆到河这边，
一个一个试"能不能走到对岸、走到了规则收不收"，**0 条不一致**。

问题全在**旁路判断**上。它们各自写了一遍 `passable(t.terrain)`，
而 `passable` 的语义是"**陆军**能不能走"——对它来说水永远是墙。
于是水军（活在水上）和掠水/飞行的兵，在每一个这样写的地方都被判成"过不去"：

| 位置 | 原来的写法 | 症状 | 现在 |
|---|---|---|---|
| `escapeRoutes`（AI 的"出不了城门"闸门） | `!passable(tile.terrain) → 跳过` | 水军四邻全水 → 判定"出不了城门" → AI 永不采购它 | `terrainWalkable(def, …)`，步耗按水军/掠水固定 1 |
| `recruitSpawnCells` 军营分支（规则层出兵位） | 非水军一律 `passable` | 营门一圈全是水时**飞行兵出不来**，`doRecruit` 直接拒 | `terrainWalkable(def, …)` |
| AI 的 `slotsFor`（采购候选的出兵位） | 同上，且整张表只分"水/陆"两档 | 同上，AI 候选表跟着少一行 | 改成按候选兵种算，结果按 id 缓存 |
| 军营面板的"能不能造"（`panel.ts`） | 自己数 `landSlots` | 按钮变灰，点不了 | 直接问 `recruitSpawnCells`（唯一判据） |
| `blockedFor`（下船落点） | 水军看 `navigable`、其余 `passable` | 飞行兵能**站**在水面上，却**卸**不到水面上 | 统一 `terrainWalkable` |
| `moveRefusal`（点了走不过去时的提示） | `domain !== 'water'` 就算"陆军" | 飞机点水面被告"水面对陆军不通" | 按 `terrainWalkable` 判，并补上深水那句 |
| `pathCells`（移动动画的路径） | 一律按陆军 BFS | 船沿岸线走时路径一步都过不了水 → 退化成"起点直连终点"，一格格跳 | 传入兵种，按它的地形规则找路 |

### 核心：一条判据，一个函数

```ts
// rules.ts
export function terrainWalkable(def: UnitTypeDef, terrain: Terrain): boolean {
  if (def.domain === 'water') return navigable(terrain);
  if (passable(terrain)) return true;
  // 掠水/飞行：水面、深水都能过（空中层连山都能过，这里只回答"水"这一档）
  return crossesWater(def) && (terrain === 'water' || terrain === 'deep');
}
```

`blockedFor` 现在是 `if (!terrainWalkable(def, tile.terrain)) return true;`
外加一条水军的吃水限制（2×2 大舰进不了浅流）。
`reachableTiles` 里那条"掠水单独放行水面"的豁免因此变成死代码，删了——
不是"少了一条规则"，是那条规则搬到了 `blockedFor` 里，所有调用方一起受益。

### 哪些 `passable()` 是故意的

不是所有 `passable()` 都该改。下面这些**就是要"陆军视角"**，留着：

- `cityDistanceField` 的 `land` 模式：这是"陆军走旱路要几步"的图；
- `bestBridgeSite` / `bridgeGap`：找架桥点，两边本来就该是陆地；
- `slotsFor` 之外的建筑选址（`ai.ts` 里找空地盖房）：建筑是陆上的；
- `mapgen` / `setup`：铺地形时"这里能不能长树/放城"。

---

## 三、验证

### ① 兵种级对账（新脚本 `npm run probe:water`）

```
① 跨水能力 vs 可达格（水带在 x=5,6，起点 x=4，进到 x>=6 算过水）
兵种                 能跨水 到对岸 真能走
侦察气球(af_balloon)     true   true   true
...
不一致 0 条 / 共 36 个兵种
```

改之前也在这里对过一次账，`escapeRoutes` 那条不在这张表上（它是 AI 内部的闸门），
但同一批 `passable` 写法影响的 ③ 出兵位是这样——四面全水的营门按旧判据
（非水军一律 `!passable`）算出来是 0 格：

```
③ 四面环水的军营：出兵位
  民兵(militia)            旧判据 0 格（对）
  侦察机(af_scout)         旧判据 0 格（错：它明明能停在水面上）
```

改之后：

```
  民兵(militia)            不出现在列表里（0 格，正确）
  侦察机(af_scout)         出兵格 4
  舢板(boat)               出兵格 4
  舰队航母(nv_fleet_carrier) 出兵格 2   （2×2，只有两个位置放得下）
```

### ② 回归测试

`npm run test:rules` **526 项通过**（+2）：

- `四面环水的军营：飞行兵出得来，陆军出不来（出兵位按兵种判）`
- `下船落点按兵种判：飞行兵能卸在水面上，陆军不能`

其它三套：`test:ai-optimization` 41 + 7 项通过、`test:ui` 167 项通过。

### ③ 没有把 AI 改坏

`ai-duel --era 2 --games 40 --seed 900`（同一批种子、两边互换先手，80 局）：
**51.2%（z=0.22）** 对冻结基线，均 61 回合。

群岛图 60 回合冒烟（`SIM_STYLE=isles SIM_SEED=4242`）：移动 290 / 攻击 226 / 攻城 45，
架桥 4 座、建军营 1 座，战线从 6 推到 0——水军和过河都还在正常工作。

---

## 四、留给下一次

- **AI 还不会故意用水道卡人**：它现在会正确地"进水、过水、沿水走"，
  但不会为了把大舰挤进浅流而布阵。这是"能玩、不精"那一档，和 `NAVAL-PACK.md` 里写的一致。
- **`pathCells` 只是动画**：它不看移动力，也不看单位阻挡。
  真要修"路径提示"的话，得从 `reachableTiles` 的前驱表里回溯，那是另一件事。
