# 扩展开发指南

> 这份文档面向**第一次想给方格战棋做扩展的你**。跟着走一遍，你就能做出自己的第一个扩展——
> 不需要理解整个引擎，只需要认识一个对象、一个数组、几条纪律。

---

## 目录

1. [扩展是什么](#1-扩展是什么)
2. [两条硬约束（先背下来）](#2-两条硬约束先背下来)
3. [第一个扩展：五分钟上手](#3-第一个扩展五分钟上手)
4. [全部钩子速查表](#4-全部钩子速查表)
5. [带兵种的扩展](#5-带兵种的扩展)
6. [能力系统（abilities.ts + rules.ts）](#6-能力系统abilitiest--rulests)
7. [前置依赖 requires](#7-前置依赖-requires)
8. [规则书归册：scale 字段](#8-规则书归册scale-字段)
9. [写测试](#9-写测试)
10. [发布清单（checklist）](#10-发布清单checklist)
11. [常见坑](#11-常见坑)

---

## 1. 扩展是什么

一个扩展 = 一个普通的 JavaScript/TypeScript 对象，注册进 `src/core/expansions.ts`
末尾的 `EXPANSIONS` 数组。玩家在开局界面勾选它之后：

- 它的**钩子（hooks）**会在对局的各种时机被引擎调用，用来改数值或改状态；
- 它的**兵种（units）**会出现在本局的兵种表里，可以被生产。

关键在于：**`rules.ts` 一行都不用改**。引擎在算伤害、算收入、算移动力的时候
都会先问一遍"有哪些扩展在生效"，然后把结果交给它们修正。你只管往数组里加对象。

现有 24 个扩展分布在四个文件里，可以当参考读物：

| 文件 | 内容 |
|---|---|
| `src/core/expansions.ts` | 13 个纯规则扩展（非对称开局、战争经济、堑壕战……） |
| `src/core/era-packs.ts` | 5 个时代兵备包（古典 → 现代） |
| `src/core/fantasy-packs.ts` | 5 个奇想兵种包（法则、骑士团、荒兽、秘术、英雄） |
| `src/core/city-works.ts` | 1 个大改款（城郭与物料：大城、多资源、施工、驻军） |

---

## 2. 两条硬约束（先背下来）

这两条写在 `ExpansionHooks` 接口的注释里，违反它们会产生**极难排查的隐形 bug**：

1. **`modify*` 系列钩子必须是纯函数。**
   它们也会在 UI 的伤害预览里被调用——一旦有副作用，玩家只是把鼠标悬停在
   敌人身上看一眼预览，游戏状态就被悄悄改了。

2. **`on*` 系列钩子可以改 state（加金币、扣血、写日志），但必须是确定性的。**
   不许用 `Math.random`。要随机，就推进 `state.seed`（引擎里有配套的随机函数，
   搜 `rng` 或看 `state.seed` 的现有用法）。否则同一个存档重放会走出不同的结果。

---

## 3. 第一个扩展：五分钟上手

目标：做一个「丰收祭」——每个回合双方收入 +10。

打开 `src/core/expansions.ts`，在 `EXPANSIONS` 数组末尾加一项：

```ts
{
  id: 'harvest',
  name: '丰收祭',
  summary: '每回合双方收入 +10。',
  hooks: {
    modifyIncome: ({ income }) => income + 10,
  },
},
```

就这些。`id` 全局唯一、用小写中划线；`name` 和 `summary` 会直接显示在开局
勾选界面上，`summary` 要**一句话说清它改变了什么**。

保存后：

```bash
npm run test:rules   # 确认没把现有规则改坏
npm run dev          # 开局界面就能看到并勾选「丰收祭」了
```

想让它出现在规则书里？见[第 8 节](#8-规则书归册scale-字段)。
想给它写测试？见[第 9 节](#9-写测试)。

---

## 4. 全部钩子速查表

接口定义在 `src/core/expansions.ts` 的 `ExpansionHooks`。**所有钩子都是可选的**，
只写你需要的。每个钩子收到一个上下文对象（下表"参数"列），返回修正后的值，
或者（对 `on*` 系列）直接改 `state`。

### 4.1 纯函数系列（返回修正值，禁止副作用）

| 钩子 | 参数 | 说明 |
|---|---|---|
| `modifyDamage` | `{ state, attacker, defender, damage, isCounter }` | 修正野战伤害。`damage` 已算好"攻击 − 护甲 − 地形"。`isCounter` 区分主动攻击和反击 |
| `modifySiegeDamage` | `{ state, attacker, city, damage }` | 修正攻城伤害。**和 modifyDamage 分开**：攻城只吃城甲，没有地形、破甲、反击，公式完全不同 |
| `modifyArmor` | `{ state, attacker, defender, armor, isCounter }` | 修正**护甲本身**（在破甲之前生效，会被 armor-pierce 削半）。想表达"多了 2 点甲"用它；想表达"这下少挨 2 点"用 `modifyDamage` |
| `modifyMove` | `{ state, unit, move }` | 修正移动力 |
| `modifyCost` | `{ state, player, unitType, cost }` | 修正兵种造价。`unitType` 是完整兵种定义，可以按 category/era 筛 |
| `modifyIncome` | `{ state, player, income }` | 修正回合收入 |
| `modifyVision` | `{ state, player, base }` | 修正视野半径 |
| `modifyCityRegen` | `{ state, city, regen }` | 修正城市每回合回血量（`regen` 为 0 表示本来不回血） |
| `modifyUpgradeCost` | `{ state, player, city, nextEra, cost }` | 修正升级时代费用。`cost` 为 `null` 表示已封顶；返回 `null` 同样表示封顶 |
| `startRoster` | `{ state }` | 整批换掉开局部队。返回 `{ A: ['militia', …], B: [...] }`（兵种 id 名单，摆位由 setup.ts 统一处理）或 `null`（走默认的"3 战斗 + 2 经济"） |
| `modifySecondGold` | `{ state }` | 返回后手额外起始金的**比例**（0.05 = 多 5%）。只返回比例不动手，加钱和写战报由 setup.ts 统一做 |

### 4.2 副作用系列（可改 state，必须确定性）

| 钩子 | 参数 | 说明 |
|---|---|---|
| `onUnitKilled` | `{ state, victim, killer?, killerOwner }` | 单位被消灭后。`killer` 在同归于尽时为 `undefined` |
| `onTurnStart` | `{ state, player }` | 某方回合开始时 |
| `onMatchStart` | `{ state }` | 开局时改初始状态（改金币、铺地形、写战报……） |

改完状态想留痕迹？用文件里的 `log()` 辅助函数：

```ts
onTurnStart: ({ state, player }) => {
  state.players[player].gold += 5;
  log(state, player, '丰收祭：本回合多收了 5 金币');
},
```

`log()` 会把消息写进战报（上限 80 条），玩家在对局里能直接看到。

### 4.3 挑几个真实例子对照着看

```ts
// 战争经济：歼灭拿赏金（副作用钩子 + log）
{
  id: 'war-economy',
  name: '战争经济',
  summary: '每消灭一个对方单位，立刻获得 15 金币。',
  hooks: {
    onUnitKilled: ({ state, killerOwner, victim }) => {
      state.players[killerOwner].gold += 15;
      log(state, killerOwner, `战争经济：歼灭 ${nameOf(state, victim.type)}，获得 15 金币`);
    },
  },
},

// 闪电战：两个纯函数钩子协同
{
  id: 'blitz',
  name: '闪电战',
  summary: '所有移动力 3 以上的快速单位移动 +2、造价 +10%。',
  hooks: {
    modifyMove: ({ state, unit, move }) =>
      (state.unitTypes[unit.type]?.move ?? 0) >= 3 ? move + 2 : move,
    modifyCost: ({ unitType, cost }) =>
      unitType.move >= 3 ? cost + Math.round(cost * 0.1) : cost,
  },
},

// 堑壕战：改护甲（会被破甲削，这是有意的）
{
  id: 'trench',
  name: '堑壕战',
  summary: '站在森林或丘陵上的单位额外 +2 护甲（吃破甲，也挡得住低时代攻击）。',
  hooks: {
    modifyArmor: ({ state, defender, armor }) => {
      const tile = state.tiles[defender.y * state.w + defender.x];
      if (tile && (tile.terrain === 'forest' || tile.terrain === 'hill')) {
        return armor + 2;
      }
      return armor;
    },
  },
},
```

> **纯表现层的扩展**：如果一个扩展没有钩子、没有兵种，效果全在渲染层
> （比如「浓雾蔽野」只让视野外不画出来），给它的定义加 `presentationOnly: true`，
> 让测试能区分"真的只影响画面"和"注册了个什么都不干的包"。

---

## 5. 带兵种的扩展

给扩展加 `units` 字段，兵种就进了本局的兵种表（不开这个扩展就看不见）：

```ts
{
  id: 'my-pack',
  name: '我的兵种包',
  summary: '带来一个新兵种。',
  hooks: {},
  units: [
    {
      id: 'sky-lancer',
      name: '天空枪骑',
      short: '枪',          // 棋盘上显示的单字图标
      era: 2,               // 城市要到哪个时代才能生产
      category: 'combat',   // combat / economy / builder / building
      cost: 90,
      move: 3,
      atk: 15,
      armor: 3,
      maxHp: 35,
      range: 1,             // 曼哈顿距离
      vision: 2,
      abilities: ['charge'], // 特殊能力 id，见第 6 节
    },
  ],
},
```

### 5.1 UnitTypeDef 字段速查

完整定义在 `src/core/types.ts`（带详细注释，推荐直接读）。必填的是
`id / name / short / era / category / cost / move / atk / armor / maxHp / range / vision`，
下面只列**可选字段**：

| 字段 | 含义 |
|---|---|
| `splash` | 溅射半径：主目标周围的敌人也吃一份伤害（炮的玩法） |
| `burst` | 多段攻击：一次结算 N 下，**每下单独减一次护甲**（机枪打轻甲一串数字、打重甲全被挡） |
| `income` / `incomeByTerrain` | 经济单位收入：固定值，或按所在地形给（牧民在丘陵富、农民在平原富） |
| `autoAttack` | 每回合自动对射程内最近的敌人开火（建筑用） |
| `builds` | 这个单位能建造哪些建筑（建筑 id 列表） |
| `domain` | `'water'` 单位只能待在水面、进不了城、只能在临水城市生产；缺省 `'land'` |
| `bridges` | 桥类建筑：那一格变成可通行桥面，谁都能过、也谁都能打塌 |
| `barracks` | 军营：能像城市一样出兵，用最近己方城市的时代 |
| `obstacle` | **反向标注**：默认所有建筑都能站人（塔有梯子、营有营门），只有墙/栅栏/拒马这类要显式写 `obstacle: true` 表示"这格过不去" |
| `buildOn` | 地形要求：只能建在这些地形上（桥要水面） |
| `transport` / `capacity` | 运输船：把相邻陆军装进货舱运过水面，自己不打架 |
| `layer` / `flight` | 移动层（`'air'` 与地面互不占格）与飞行（掠水、林丘 1 步）。**原版机制**，不是奇想包的私货 |
| `bio` | 这是"活人"还是"东西"：多资源规则靠它决定收粮还是收材。缺省按建筑/机械/水上单位推断 |
| `costRes` / `yield` / `yieldByTerrain` | 金币之外的造价、固定产出、按地形的产出（同一单位换个地方产不同的资源） |
| `buildTurns` | 要几个自己的回合才建成（> 1 就先落工地：能被打、开不了火、产不了兵） |
| `garrison` | 可驻军：友军站上来多 `CONFIG.garrisonArmor` 点护甲，并借用它的视野 |
| `requiresWater` | 必须紧邻水域才能建（军营靠水补给）。"旁边有没有水"是邻居的事，单靠 `buildOn` 表达不了，所以单独开一个开关 |

奇想包还有一整组机制字段（魔法攻击、属性、状态、英雄技能……），同样全部可选、
旧数据不写就是"没有"，不用升存档版本号——见 `types.ts` 里
「奇想兵种包的机制字段」一段的注释。

### 5.1.1 两条**原版**接口：移动层与多资源

这两样是骨架，不是扩展的私货——它们决定"占不占格""吃什么资源"，
而这两件事会渗进寻路、产兵位、造价判断。所以规则层无条件支持，
不需要任何扩展勾选；扩展只负责**用它**。

**移动层**

```ts
{ id: 'balloon', layer: 'air', flight: true, ... }   // 飘在敌人头顶
{ id: 'eagle',   flight: true, ... }                // 会飞，但还在地上那一层
```

* `layer: 'air'` —— 与地面**互不占格**：它可以停在敌人头顶，敌人也能从它脚下走过。
  攻击判定里"地面打空中距离 +1"（`rules.strikeDistance`），所以射程 1 的步兵打不到隔壁那格。
* `flight: true` —— 能掠水、能停在水面、森林丘陵按 1 步。
* 旧数据里的 `fly` / `fly-over` / `leap` 三条能力 id **仍然认**（规则层拿它们当别名），
  自定义兵种编辑器也照旧能勾；新数据建议直接写字段。

**多资源**

```ts
// 造价：金币 60 + 粮食 40
{ cost: 100, costRes: { food: 40 }, ... }
// 产出：站平地出粮、站林子出材
{ yieldByTerrain: { plain: { food: 6 }, forest: { material: 8 } }, ... }
```

* `PlayerState.gold` 仍是主资源，读写照旧；其它资源在 `PlayerState.res[id]`，默认 0。
* 结算一律走 `src/core/resources.ts` 的 helper（`resOf / canPay / payRes / addRes / costLabel`），
  别自己在 `res` 上加减——漏了 `gold` 那一路就会变成"钱够却造不出来"。
* 规则层只认 id；名字、简称、颜色在 `RESOURCES` 注册表里，加一种新资源就注册一行。
* 两个钩子负责"扩展怎么用它"：`modifyResourceCost`（金币之外那份造价）
  和 `modifyYield`（把金币产出改写成粮/材）。`modifyCost` 只管金币，两者分开，
  既有扩展一行都不用改。

### 5.1.2 城市变大、建筑要施工

* `Expansion.citySize`：这个扩展要求的主城边长（缺省 2）。地图生成、建城、画城、
  沙盒摆城四处都读 `config.citySize`，所以扩展只要写一行，城市当场变大。
  棋盘太小时会自动退回 2（一边的 1/4 是硬上限）。
* `buildTurns` → 工地：`unit.buildLeft` 记剩余回合，判断统一走 `rules.underConstruction()`。
  工地不能开火、不能产兵、不能主动攻击，但**能被打**——这就是"塔要两回合"的代价窗口。
* `garrison` → 驻军：加成在 `garrisonBonus()` 里算，护甲与视野两处都读它。

### 5.2 大量兵种放哪

十几个兵种的数据摆进 `expansions.ts` 会把钩子表淹掉。现有的做法是分文件：
时代包在 `src/core/era-packs.ts`，奇想包在 `src/core/fantasy-packs.ts`，
`expansions.ts` 只 `import` 它们的数组。循环依赖是安全的——分文件那边只
`import type`，运行时没有回指。你做大型兵种包时照这个样子办即可。

---

## 6. 能力系统（abilities.ts + rules.ts）

兵种面板之外的特殊行为走**能力**系统，分两步：

**第一步：登记名字。** `src/core/abilities.ts` 的 `ABILITIES` 数组加一项：

```ts
{
  id: 'my-ability',            // 全局唯一，小写中划线
  name: '我的能力',
  summary: '一句话说明，直接印在规则书和悬浮提示里。',
  group: 'attack',             // attack / defense / move / support
},
```

**第二步：给行为。** 在 `src/core/rules.ts` 里找到能力该生效的时机，
用 `hasAbility()` 分支实现。它被大量复用在伤害、移动、地形判定里：

```ts
import { hasAbility } from './abilities.ts';

// 例：伤害计算里加一个分支（节选自现有代码的风格）
if (hasAbility(at, 'my-ability') && attacker.hp * 2 <= at.maxHp) {
  dmg += 3;   // 残血狂暴 +3
}
```

先在 `rules.ts` 里搜一个语义相近的现有能力（`charge`、`first-strike`、
`forest-walk`……）抄它的位置和写法，是成本最低的路。规则书会自动把
`ABILITIES` 里的新能力印进对应分册，不用手写文档。

> 给测试临时发能力有现成辅助：`scripts/test-rules.ts` 的
> `grantAbility(s, typeId, abil)`。

---

## 7. 前置依赖 requires

```ts
{
  id: 'fantasy-knights',
  name: '奇想·骑士团',
  requires: ['fantasy-core'],   // ← 前置
  ...
}
```

语义：`requires` 里的 id 必须同时启用，本扩展才生效（**钩子和兵种都不进场**）。
UI 上子包不勾前置就不会勾上；玩家只勾子包、没勾前置时，子包是摆设。

存在理由不是"权限"，是**语义**：奇想兵种包依赖"魔法/属性/状态/空中层"这套法则，
单开一个兵种包会让玩家以为自己在玩数值包，实际上是半套规则。
前置包把这件事变成显式的、可见的选择。

规则：前置链要指向"本身没有前置"的包，不要成环。
另外别忘了在 `expansionById()` 能查到所有 id——它们都在 `EXPANSIONS` 数组里，
分文件定义的包也要汇入这个数组。

---

## 8. 规则书归册：scale 字段

规则书是从代码**生成**的（`npm run manual`），分成 13 册：

- 核心册 `public/manual.html`（永远存在）
- 小型扩展合订本 `public/manual-small.html`（所有小型扩展一册）
- 每个大型扩展单独一册 `public/manual-pack-<id>.html`

归册靠扩展定义里的 `scale` 字段：

```ts
scale: 'large',   // 单独成册；不写默认 'small'，进合订本
```

**归册是编辑决定，不让生成器猜**（比如"带兵种就算大型"）——「奇想·法则」
一个兵都不带，却带来一整套魔法/属性/状态规则，按兵种数分它会被错误地塞进
合订本。所以：

- 改一两条全局规则的小扩展 → 不写 `scale`；
- 带一整套兵种/机制、值得玩家单独翻阅的 → `scale: 'large'`。

生成之后游戏内的「规则书」按钮会根据本局开了哪些扩展弹书单（只列出相关的册）。
CI 会跑 `npm run manual` 然后 `git diff --exit-code 'public/manual*.html'`——
**改了兵种数值、扩展文案却忘了重新生成，CI 直接红**。所以每次动数据，提交前
本地跑一遍 `npm run manual` 把 `public/` 下的更新一起提交。

---

## 9. 写测试

规则测试在 `scripts/test-rules.ts`（用 `node --experimental-strip-types` 直接跑
TypeScript，不需要编译），UI 冒烟在 `scripts/smoke-dom.ts`：

```bash
npm run test:rules   # 280 项
npm run test:ui      # 92 项
```

### 9.1 基本写法

```ts
test('丰收祭：收入 +10', () => {
  const s = fresh({ expansionIds: ['harvest'] });
  // ... 摆局面、执行动作、断言
});
```

### 9.2 常用辅助（都在 test-rules.ts 里，先搜再造）

| 辅助 | 用途 |
|---|---|
| `fresh(extra?, seed?)` | 建一局标准测试局。`extra` 会并进 `MatchConfig`，最常用 `expansionIds` |
| `place2(s, owner, type, x, y)` | 在指定坐标摆一个兵（会先清干净落点） |
| `duel(s)` | 拿出双方第一枚战斗单位，摆好单挑 |
| `grantAbility(s, typeId, abil)` | 给某兵种临时发一个能力 |
| `emptyPlain(s)` | 找一块空地（摆兵/放建筑用） |
| `woundedCity(garrison?)` | 摆一座残血城（测攻城/回血） |

测钩子类的扩展，最省事的套路是：**开扩展 vs 不开扩展，同一动作各跑一遍，比结果差**：

```ts
test('丰收祭：开了多收 10', () => {
  const on = fresh({ expansionIds: ['harvest'] });
  const off = fresh({});
  // 让两局经济单位对齐后，比对回合收入差是否为 10
});
```

涉及 AI 行为的（如"AI 会不会用这个技能"），参考文件末尾「AI 用不用英雄技能」
一段：把预算改成 `{ ...DEFAULT_BUDGET, maxRecruit: 0, maxUpgrade: 0 }` 逼 AI
只能靠技能/走位做事，再用 `aiNextAction` 断言它做了什么。

### 9.3 UI 冒烟

开局界面要能勾选你的扩展、悬浮提示文案正确之类的，往 `scripts/smoke-dom.ts`
加检查。纯规则层面能测的就别进 smoke-dom——它慢。

---

## 10. 发布清单（checklist）

做完一个扩展，按顺序过一遍：

- [ ] `id` 全局唯一、小写中划线；`summary` 一句话说清改变了什么
- [ ] `modify*` 钩子是纯函数；`on*` 钩子没碰 `Math.random`（随机走 `state.seed`）
- [ ] 有前置依赖的写了 `requires`；大型扩展标了 `scale: 'large'`
- [ ] `test-rules.ts` 里加了至少一条守门测试（开 vs 不开对比最稳）
- [ ] `npm run manual` 重新生成，`public/manual*.html` 的更新已提交
- [ ] `npm run test:rules` 全绿（280+）
- [ ] `npm run test:ui` 全绿（92+）
- [ ] `npm run build`（含 `tsc --noEmit`）通过
- [ ] 开局界面勾上它打一局，看看战报和手感

---

## 11. 常见坑

- **在 `modify*` 里改状态** → 伤害预览会把游戏玩坏。纯函数，纯函数，纯函数。
- **用 `Math.random`** → 同一存档重放对不上。要随机推进 `state.seed`。
- **想表达"少挨 2 点"却用了 `modifyArmor`** → 护甲会被破甲削半、还参与
  "攻不破"判定。减伤用 `modifyDamage`，加甲才用 `modifyArmor`。
- **攻城规则写进了 `modifyDamage`** → 攻城不走野战钩子，要用 `modifySiegeDamage`。
- **改了数值忘跑 `npm run manual`** → CI 的「规则书与代码是否同步」直接红。
- **循环依赖**：分文件放兵种没问题，但那边只能 `import type`，运行时 import
  会成环。
- **前置成环**：`requires` 链必须收敛到一个无前置的包。

---

*文档对应代码版本：`EXPANSIONS` 24 个扩展、规则测试 280 项、UI 测试 93 项。
接口有变动时，以 `src/core/expansions.ts` 和 `src/core/types.ts` 的注释为准——
那两处的注释就是这套系统的第一手文档。*
