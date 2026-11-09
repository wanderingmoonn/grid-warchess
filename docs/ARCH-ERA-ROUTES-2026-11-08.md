# 时代演进路线（Era Routes）：接口与扩展方式

> 2026-11-08。解决的问题：**"升一级去哪儿"原来是 `city.era + 1`**，散在规则、界面、
> AI 三处。于是"第 5 代升到第 6 代"这句话里藏了两个假设——只能 +1、下一级就是
> 数组里的下一个。想插支线、想跳级、想让某段到此为止，都得改三处代码。

代码：`src/core/era-routes.ts`

---

## 一、接口清单

### `EraUpgradeEdge` —— 一条边（一级从哪到哪）

| 字段 | 类型 | 必填 | 含义 |
|---|---|---|---|
| `from` | `number` | ✓ | 从哪一级出发（**时代等级**，不是数组下标） |
| `to` | `number` | ✓ | 升到哪一级（任意已定义的时代，允许跳级/回退） |
| `cost` | `number` | | 覆盖费用。不写就用目标的 `upgradeCost`；**写 0 是合法的**（免费），判空必须用 `=== undefined` |
| `requires` | `(ctx) => string \| null` | | 额外条件。`null` = 可以升；返回字符串 = 不能升，**这句话原样给玩家看** |
| `label` | `string` | | 界面/战报的短标签；不写就用目标时代名 |

极简的一条边就是 `{ from: 1, to: 2 }`。

### `EraUpgradeContext` —— `requires` 的入参（只读）

| 字段 | 类型 | 说明 |
|---|---|---|
| `state` | `GameState` | 当前局面（只读，别在里面改） |
| `player` | `PlayerId` | 城市主人 = 当前行动方 |
| `city` | `City` | 要升级的城 |
| `next` | `EraDef` | **目标时代定义**（已解析，省得每个钩子自己 `eraDef(edge.to)`） |
| `edge` | `EraUpgradeEdge` | 这条边本身（读自定义字段用） |

### `EraRouteTable` —— 一张路线表

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | `string` | 稳定 id，被 `config.eraRoute` 引用、会进存档 |
| `name` | `string` | 给人看的名字 |
| `edges` | `readonly EraUpgradeEdge[]` | 全部边；同一个 `from` 只认第一条 |

### `EraUpgradeTarget` —— 解析结果（**唯一**该被读取的东西）

| 字段 | 类型 | 说明 |
|---|---|---|
| `edge` | `EraUpgradeEdge` | 命中的边 |
| `era` | `EraDef` | 目标时代定义 |
| `cost` | `number \| null` | 实际费用（已过扩展钩子）；`null` = 这一局升不了 |
| `label` | `string` | `edge.label ?? 目标时代名` |
| `blocked` | `string \| null` | 条件不满足的原因；`null` = 可以升 |

---

## 二、函数（输入 → 输出）

| 函数 | 输入 | 输出 | 用途 |
|---|---|---|---|
| `upgradeTargetOf(state, city)` | 局面 + 城 | `EraUpgradeTarget \| null` | **界面/规则/AI 都该用这一个**，一次问清目标、价钱、条件 |
| `upgradeEdgeOf(state, city)` | 同上 | `EraUpgradeEdge \| null` | 只想知道"下一步是哪条边" |
| `nextEraLevelOf(state, city)` | 同上 | `number \| null` | AI 按"代"比兵时用它，不要写 `era + 1` |
| `nextEraOf(state, city)` | 同上 | `EraDef \| null` | 想要目标时代的完整定义 |
| `eraRouteFor(state)` | 局面 | `EraRouteTable` | 这一局用哪张表 |
| `registerEraRoute(route)` | 表 | `void` | 注册/替换（同名覆盖，后注册者赢） |
| `eraRouteById(id)` | id | `EraRouteTable \| undefined` | 查表 |
| `eraRouteList()` | — | `EraRouteTable[]` | 列全部（规则书/设置面板用） |
| `setMatchEraRoute(state, id)` | 局面 + id | `boolean` | 对局中途换线（扩展的 `onMatchStart` 用） |
| `withOverrides(base, id, name, overrides)` | 基础表 + 覆盖 | `EraRouteTable` | 只改一段，别重抄整张表；`null` = 删掉这条边 |

### `upgradeTargetOf` 返回 `null` 的三种情况

1. 路线上**没有出边**（科技线到此为止）；
2. 这一局**封顶**了（`eraCeilingOf`，取决于开没开对应扩展）；
3. 扩展把费用钩成了 `null`（"这回合不卖"）。

**封顶判定在费用钩子之前**，这条顺序是 2026-11 的老结论，别调换：「血战」那种
"照旧价目表收钱"的钩子会在封顶之后把 `null` 又变回一个价格，玩家就会看见一个
点得动、点了却没反应的按钮。

### 路线与封顶是两件事

- **路线**回答"开到了之后往哪走"，不知道也不关心这一局开到第几层；
- **封顶**回答"这一局能不能开到那一层"。

分开之后，扩展才能"既封顶又改道"——原来两者都挤在 `era + 1` 与 `eraCeilingOf`
的比较里，改一个就动另一个。

---

## 三、默认路线从 `ERAS` 派生，不另抄一份

```ts
export const LINEAR_ERA_ROUTE = {
  id: 'linear',
  name: '线性科技线',
  edges: ERAS.slice(0, -1).map((era, i) => ({ from: era.level, to: ERAS[i + 1]!.level })),
};
```

时代表改一个字（改名、加一级、调费用），路线自动跟着变。**两份表迟早对不上**——
这个项目已经有前科（地形字符表 `CHAR` 与 `TERMS` 各写一份，结局是沼泽行整段
被吞掉）。

所以：**不要**在别处再写一份 1→2、2→3 的映射。需要"只改一段"就用
`withOverrides(LINEAR_ERA_ROUTE, ...)`。

---

## 四、扩展方式（三种场景，按需选）

### 场景 1：整条路线换掉（新科技线）

```ts
import { registerEraRoute } from './era-routes.ts';

registerEraRoute({
  id: 'branching',
  name: '分岔科技线',
  edges: [
    { from: 1, to: 2 },
    { from: 2, to: 3, cost: 300 },                       // 覆盖价钱
    { from: 3, to: 4, requires: ({ state, player }) =>
        hasBuilding(state, player, 'university') ? null : '需要先建一座大学' },
    { from: 4, to: 6, label: '直接进现代' },              // 跳级：4 → 6
  ],
});
```

开局生效两种方式：

- 传配置：`createMatch({ ...cfg, eraRoute: 'branching' })`；
- 或扩展在自己的 `onMatchStart` 里：`setMatchEraRoute(state, 'branching')`。

### 场景 2：只改一段（"5 级之后不再指向信息化"）

```ts
registerEraRoute(
  withOverrides(LINEAR_ERA_ROUTE, 'steampunk', '蒸汽朋克线', {
    5: { from: 5, to: 6, label: '蒸汽纪元' },  // 目标仍是 6，但换个说法/条件
    3: null,                                     // 第 3 级之后到此为止
  }),
);
```

`null` 表示"删掉这条边"，不是"改成空边"——写成 `{from:3,to:3}` 会造出一个
永远原地升级的死循环。

### 场景 3：同一个 id 覆盖（离线实验）

`registerEraRoute` 同名覆盖，后注册者赢。适合"整包替换某个扩展的路线"，
**不适合按局变化**——它是全局的，会影响此后所有读这张表的对局。
按局变化请用 `config.eraRoute`。

---

## 五、兼容性

| 情形 | 行为 |
|---|---|
| 老存档 / 老房间 / 分享链接 | 没有 `config.eraRoute` → 走 `linear`，与当初完全一致 |
| 填了不认识的 id | 回退 `linear`（不是别的线）：至少还能玩 |
| 对局中途换线 | 只改"从现在起往哪走"，**不改写已升过的城**（`era` 是既成事实） |
| 不填 `eraRoute` | 不往 config 里写键，老存档读回来不会凭空多字段 |

规则层保留了老入口：`upgradeCostOf(state, city)` 仍然可用（内部委托给
`upgradeTargetOf`），十几处调用点不用跟着改。**条件不满足时它仍然返回价钱**
（界面那颗按钮要能显示"要 200 金"，点下去再由 `doUpgrade` 报原因）。

---

## 六、改动落点（谁读了这个接口）

| 文件 | 改动 |
|---|---|
| `src/core/era-routes.ts` | 新增：接口、注册表、解析、`withOverrides` |
| `src/core/rules.ts` | `upgradeCostOf` 委托；`doUpgrade` 用 `edge.to` 代替 `era + 1`，并处理 `requires` |
| `src/core/ai.ts` | 换代收益按 `nextEraLevelOf` 数兵表；没有下一级就整段跳过（原来会数一张永远造不出的表） |
| `src/ui/panel.ts` | 升级卡片用 `upgradeTargetOf`，目标名/价钱与规则同源 |
| `src/core/types.ts` | `MatchConfig.eraRoute?: string` |
| `scripts/probe-ladder.ts` | 送级也走路线，避免探针量的是另一条线 |

## 七、测试

`test:rules` 新增 6 条：

1. 默认线性表与 `era + 1` 逐级一致，顶级没有出边；
2. 换表能跳级（3 → 5），**规则执行结果**跟着走；
3. `requires` 不满足时升级被拒，理由是钩子给的那句话；
4. `cost` 覆盖生效；`from: 3 → null` 表示科技线到此为止；
5. 开局传 `eraRoute` 要活进 config；不传则不写字段；
6. 不认识的 id 回退 `linear`。

合计 `647` 项全绿；`test:ui` 204 项；`tsc --noEmit` 干净。
