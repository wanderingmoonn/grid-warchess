# 修真扩展包 (Cultivation Pack) 架构说明

> **给 AI 的上下文提示（Prompt）**：
> 本项目是一个战棋游戏的扩展包，当前采用“单向数据流”的模块化架构。
> 当你阅读此文件时，请严格遵守下文定义的**目录职责**、**依赖方向**和**核心约定**。不要擅自引入跨层依赖，不要破坏状态解耦。如果你需要修改功能，请先对照“常见任务指引”找到对应的文件。或者询问用户敲定方案。

## 1. 目录结构与职责

本包采用“单向数据流”架构，禁止越级依赖或反向依赖。

| 文件 | 职责 | 备注（AI 必读） |
|---|---|---|
| `cultivation-packs.ts` | **唯一的组装车间**。拼装 `Expansion` 对象。 | **不含任何业务逻辑**。只负责 import 数据、组装对象、注册副作用。 |
| `identity.ts` | **身份判定器**。判断谁是修士、灵体、剑修。 | 不依赖本包其他任何文件。**兵种 id 的唯一来源**（`UNIT_IDS`）——`units.ts` 的 `id:` / `builds:` 也引用它，任何地方都不许再写字面量。 |
| `progression.ts` | **境界/经验/寿元核心**。管升级、降级、寿元。 | **它不认识技能！** 升级时只通过 `onRankUp` 广播事件。 |
| `stats.ts` | **属性计算器**。纯数学函数，按境界算攻/防/射程/次数等加成。 | 无副作用。**所有数值规则（如倍率、公式）的“单一真相”必须放这里。** |
| `units.ts` | **纯静态数据**。兵种的定义配置。 | 只有数据。技能的 `SkillDef` 从 `skills/` 取，别在这里内联。 |
| `skills/` | **一个技能一个文件**：数值常量 + `SkillDef` + 就绪检查 + 效果 + 预览，全在一个文件里。 | `skills/index.ts` 负责 import 全部（触发注册）并汇总导出。**禁止 import `../units.ts`**，见第 2 节。 |
| `abilities/` | **能力实现**。每个能力一个文件，`index.ts` 统一导出并组装成数组。 | 含效果型/光环型逻辑（如 `spirit-aura.ts`）。`unlocks.ts` 在这里，负责能力解锁。 |
| `skills/unlocks.ts` | **技能解锁**。`learnSkill` + 技能触发表 + `onRankUp` 注册。 | 和能力解锁对称。详见第 4 节。 |
| `spell-kernel.ts` | **法术骨架**。数据行类型 `SpellRow`、`defineSpellSkill`、批量挂灵力检查与瞄准高亮、`resolveCast`、`strike`。 | **不含任何一条法术的内容**（无数值、无文案、不注册 effect）。只放"所有法术都一样"的那层机制。见 5.0。 |
| `hooks.ts` | **事件钩子**。`onUnitKilled`、`modifyDamage` 等 `ExpansionHooks` 的集合。 | 只放引擎回调，不含“给本包内部调用的 API”。 |
| `panel.ts` | **UI 面板拼接**。拼成给玩家看的字符串。 | 纯查询。**禁止硬编码数值，必须引用 `stats.ts` 的常量。** |

## 2. 依赖方向（红线）

```
types.ts（核心类型，被所有人依赖）
    ↑
identity.ts（不依赖本包任何文件）
    ↑
progression.ts / stats.ts（状态与数学，不认识技能/能力）
    ↑
skills/*.ts  abilities/*.ts（每个技能/能力自己的数值与实现）
    ↑
skills/unlocks.ts  abilities/unlocks.ts  hooks.ts  panel.ts（业务逻辑）
    ↑
cultivation-packs.ts（组装车间，唯一对外入口）
```

规则：**箭头只能向上指，底层永远不 import 上层。**
- `progression.ts` 绝对不允许 import 技能/能力。
- `skills/*.ts` 要查属性，只能 import `stats.ts`，**绝不能** import `hooks.ts`。

⚠️ **最容易踩的一条环**：`units.ts` 要从 `skills/index.ts` 取 `SkillDef`，
所以 `skills/` 下的文件**一律不许 import `../units.ts`**。
需要"散灵台要花 5 灵石"这类数值，就写在技能文件自己头上，让 `units.ts` 反过来取。
Node 的 ESM 环是**运行时**才炸（`undefined` 或 TDZ），`tsc` 看不出来。

## 3. 核心设计约定

1. **经验与等级解耦**：
   - `custom.exp` 和 `custom.rank` 是解耦的。`addExp` 只升不降。
   - 想“按经验反推等级”，用 `setCultivationExp`；想“只扣经验不掉级”，只改 `custom.exp`。
2. **修饰器语义（加法而非覆盖）**：
   - 所有的 `modify*` 钩子（如 `modifyAttacks`, `modifyDamage`），处理逻辑必须是 **`return 基础值 + 加成值`**，绝不能直接 `return 加成值`（这会吃掉基础武器的属性）。
   - 唯一例外是 `attTimesModifier` 的旧版，现已修复为加法。
3. **寿元落库**：
   - `custom.lifespan` 是第一优先级。`rank 9` 是 `Infinity`，不落库（JSON 不能存 Infinity）。
4. **"被看见"只有一条通路**：
   - 引擎会把不在 `visibleSet` 里的敌方单位整个裁掉（`fog.ts` 开头那句"不是自己的东西不下发"），
     留痕也一样。所以想让敌人看见什么，**只能把格索引塞进视野**——
     光加一个特效元素没用，对面手里连那一格的数据都没有。
   - 本包通过 `ExpansionHooks.extraVision` 做这件事（异象）。它挂在 `visibleTilesOf` 里，
     所以**规则层和 AI 一起认**：被点亮的格子，对面能据此寻路和开火。
     代价是它进了热路径，钩子里要先 `s.current !== player` 早退。
5. **规则单一真相（DRY）**：
   - 如果一个数值规则在三个地方用到（比如“剑修伤害倍率”），必须在 `stats.ts` 抽成函数或常量（如 `swordMul`、`SWORD_BASE_MUL`），在 `hooks.ts` 和 `panel.ts` 里统一调用。**严禁在各个文件里手写 `0.8` / `1.2` 等硬编码魔法数字。**

## 4. 解锁系统：机制层 vs 触发源层

解锁拆成两个对称的文件，各自注册自己的 `onRankUp`：

| | 文件 | 机制层（对外公开） | 触发表 |
|---|---|---|---|
| 技能 | `skills/unlocks.ts` | `learnSkill` | `CULTIVATOR_SKILL_UNLOCKS` |
| 能力 | `abilities/unlocks.ts` | `grantAbility` | `CULTIVATOR_ABILITY_UNLOCKS` |

两边都是：
- **机制层（对外公开）**：自带幂等判断，返回 `true` 表示"这次真的新获得了"。
- **触发源层（文件私有）**：`onRankUp` + 那张 `*_UNLOCKS` 表，仅处理升级。

两张表都 **导出** 了——规则书那张"各境界对照表"的「特殊能力」一列直接从它们生成。
不导出的话，手册里那句"2 级解锁御空"就只能手打，改了门槛两边不一致。

**如果要加一种新途径（如“读秘籍”），绝不要改触发源层！** 在那个技能的实现里直接调用 `learnSkill`。

## 5. 常见任务指引

### 5.0 新增一门**法术**（P0 之后，优先看这条）

法术和"技能"的差别不在数据结构（都是 `SkillDef`），在**数量**：法术要做上百门，
所以它们不走 5.1 那套"一个文件从头写到尾"，而是走 `spell-kernel.ts` 的**数据行**。

一行数据只有"数"和"选哪个实现"：

```ts
const ROW: SpellRow = {
  id: 'palm-thunder',
  name: '掌心雷',
  summary: `射程 3 格……耗 50 灵力。`,   // 按钮上印的就是这句
  effect: 'bolt',        // 走哪个族的实现（SKILL_EFFECTS 的 key）
  cost: 50,              // 灵力
  range: 3,              // 射程；SkillDef.radius 也取它
  preview: 'ring',       // ring = 亮自己周围；blast = 亮落点周围
};

export const PALM_THUNDER_SKILL = defineSpellSkill(ROW);
registerManaReady([ROW]);   // 灵力就绪检查：不用自己写
registerPreview([ROW]);     // 瞄准高亮：不用自己写
```

然后只剩"打中了发生什么"，用骨架的两个零件拼：

- `resolveCast(c, spec)` —— 校验目标/自己人/射程，**通过了才扣灵力**，返回受害者列表。
  射程按谁算要显式写：`rangeFrom: 'victim'`（到目标单位，掌心雷）或
  `'point'`（到落点，罡风）。这两种口径在 2×2 单位上会给不同答案，别让骨架替你猜。
- `strike` / `strikeAll(c, victims, dmg, text)` —— 走唯一扣血出口 `api.hurt`，
  打死了再 `api.killUnit`，顺带算总伤害和击杀数。

**加法术的顺序**是：先看它属于哪个族（`docs/SPELLS-TRIAGE-2026-11-13.md`）→
族已经有了就只加一行；族还没有，先写那个族的 handler（一个族写一次，之后第 2~N 条免费）。

现成的族：
- **族 1 直伤 `bolt`**（`skills/bolt.ts`）：掌心雷、灭神枪、元磁神光、五雷正法；
- **族 2 范围伤害 `blast`**（`skills/blast.ts`）：如来神掌、厚土镇岳、百里毒瘴、
  移山填海、摘星拿月、焱、垚、鑫、淼、森；
- **族 3 场域 `field`**（`skills/field.ts` + `spell-marks.ts`）：十方火海、万仞刀山、
  山河敕令、春风化雨。它自己不算伤害，只把**留痕**放到格子上，
  由 `core/marks.ts` 在"踏入"和"每轮开始"触发。

  ⚠️ 留痕的 `data` 只收数字；要记住"谁放的、当时站在哪"（山河敕令靠这个判失效）
  就写 `mark.custom`。撤场用 `MarkCtx.remove()`，别拿"扣次数"当删除用。
- **族 6 自身增益 `buff`**（`skills/buff.ts`）：灵目术、体术、天魔解体大法、御风术。

  ⚠️ 加成数值**不放 `StatusDef`**：`modifyAtk` 引擎还没接，写状态里会变成
  "面板有、伤害没有"。正确做法是数值放 `Unit.custom.spellBuff`、
  状态 `spell-buff` 只数回合，由 `hooks.ts` 的属性钩子去读。

它们的参数就是"族的开关"长什么样的样板：

```
base / perRank   伤害 = base + perRank × 境界
trueMul          改用「真元 × 倍率」当伤害（写了就忽略上面两个）
line             直线贯穿（四方向射线，和剑气纵横同一份）
chain / chainRadius  连锁（半径内全中，穿迷雾，不跨图）
stun / root      麻痹（整回合不能动）/ 定身（只禁移动）
sunder           熔甲         physical   true = 按护甲结算
downAir          击落         knockback  击退几格
flatten          范围内地形改平原   lifesteal  按伤害比例回血
element          五行（metal/wood/water/fire/earth，族 5 要读）
soulBound        魂法
```

加一条同族法术 = 在 `bolt.ts` 里加一个 `ROW` 常量 + 导出它的 `SkillDef`，
再到 `spells.ts` 的 `SPELLS` 里登记一行。**别在族文件里写第二份 effect**。

⚠️ **没跑通的法术不要登记进 `SPELLS`**：登记即上线，`SKILL_EFFECTS[effect]` 查不到
实现时会当场抛错。半成品留在数据表里、注释掉或放进草稿数组，游戏永远是能玩的。

### 5.1 新增一个技能（90% 的情况只看这一条）
1. 在 `skills/` 下新建 `my-skill.ts`：数值常量 + `SkillDef` + `registerSkillReadyCheck` + `registerSkillEffect`（+ 需要预览就 `registerSkillPreview`）。**四样放同一个文件**。
2. 在 `skills/index.ts` 里加一行 `export ... from './my-skill.ts'` —— 这一行同时负责"触发注册"和"给 `units.ts` 取用"。
3. 要挂在兵种身上，就去 `units.ts` 的 `skills: [...]` 里加它。
4. 要让"升级自动领悟"，去 `skills/unlocks.ts` 的 `CULTIVATOR_SKILL_UNLOCKS` 加一行。
5. 改完跑 `npm run manual`：规则书的对照表会自动多出这一行。

**别做的**：不要在 `units.ts` 里内联 `SkillDef`（散灵台当初就是内联的，后来不得不搬出来）；不要新建 `*effects.ts` 之类的集中注册表（那就是拆分前的老结构）。

### 5.2 新增一种“非升级”的解锁途径
1. 在那个技能的实现里，直接 `import { learnSkill } from './unlocks.ts'` 并调用。
2. **不要**修改 `unlocks.ts` 的触发表。

### 5.3 新增属性计算或修改公式
1. 必须在 `stats.ts` 里写纯函数，更新相关的计算。
2. 如果涉及 UI 显示，去 `panel.ts` 引用该函数或导出的常量，不要硬编码。
3. 如果是修改攻击次数等涉及引擎的修饰，确保在 `hooks.ts` 里用的是 `基础值 + 函数返回值`。

### 5.4 测试与热更新（HMR）防坑
如果测试用例或开发时遇到“监听器重复触发”（如升级弹两次战报），请在测试的 `beforeEach` 中调用：
`_resetRankUpListenersForTest()`（来自 `progression.ts`）。

### 5.5 注册副作用（极度关键）
技能和能力都靠**模块加载时自注册**（`registerSkillEffect`、`onRankUp`）。
**新建了带顶层副作用的文件，必须让它被 import 到一次，否则静默失效。**

现在的链路是：`cultivation-packs.ts` → `skills/index.ts` → 每个技能文件 + `skills/unlocks.ts`；
能力那一侧由 `abilities/index.ts` 统一带进来（它 `export * from './unlocks.ts'`）。
所以你只要在对应的 `index.ts` 里加一行 export，就不会漏。

### 5.6 新增一个能力（含光环）
1. 在 `cultivation/abilities/` 下新建文件（如 `my-aura.ts`），编写并 `export` 能力定义。
2. 在 `cultivation/abilities/index.ts` 中 `import` 它、`export *` 它，并加入 `CULTIVATION_ABILITIES` 数组。
3. 在 `units.ts` 中给对应兵种的 `abilities: [...]` 里加上该能力的 ID。
4. 要让"升级自动获得"，去 `abilities/unlocks.ts` 的 `CULTIVATOR_ABILITY_UNLOCKS` 加一行。

## 6. 测试规范（给 AI 和开发者的红线）

> **给 AI 的提示**：如果你被要求修改修真扩展的测试，**绝对不要**去修改 `scripts/test-rules.ts`。所有的修真测试都在独立文件中，请只修改 `scripts/tests/packs/cultivation.test.ts`。

### 6.1 为什么是独立文件？
以前所有的测试（500多项）全堆在 `scripts/test-rules.ts` 里，每次跑测试极慢，且只要动一个扩展的数值，一跑全量测试就到处飘红，难以定位问题。
现在采用**“测试各回各家”**的策略，修真包的测试文件位于：
`scripts/tests/packs/cultivation.test.ts`

### 6.2 如何运行测试？
- **只跑修真扩展包（开发时推荐，秒出结果）**：
  `npm run test:cultivation`
- **跑全量测试（提交代码前做最终检查）**：
  `npm run test:rules`

### 6.3 编写测试的模版
新建或添加测试时，请严格参考以下结构：

```ts
// @ts-nocheck
import { test, assert, stats, fresh, arena, place2 } from '../support.ts';
import { applyAction } from '../../../src/core/rules.ts';
import { cultivationRank } from '../../../src/core/cultivation-packs.ts';

// 必须包裹在 run() 函数中，供总入口调用
export function run() {
  console.log('\n修真扩展');

  test('测试用例名称：简短说明测什么', () => {
    const s = fresh({ expansionIds: ['cultivation'] });
    // ... 编写你的断言
    assert.equal(cultivationRank(s.units[0]!), 0);
  });
}

// 魔法代码：让这个文件可以被单跑（Node ESM 环境下区分被 import 还是被直接执行）
if (import.meta.url === `file://${process.argv[1]}`) {
  run();
  console.log(`\n通过 ${stats.passed} 项，失败 ${stats.failed} 项\n`);
  if (stats.failed > 0) process.exit(1);
}