# 修真扩展包 (Cultivation Pack) 架构说明

> **给 AI 的上下文提示（Prompt）**：
> 本项目是一个战棋游戏的扩展包，当前采用“单向数据流”的模块化架构。
> 当你阅读此文件时，请严格遵守下文定义的**目录职责**、**依赖方向**和**核心约定**。不要擅自引入跨层依赖，不要破坏状态解耦。如果你需要修改功能，请先对照“常见任务指引”找到对应的文件。或者询问用户敲定方案。

## 1. 目录结构与职责

本包采用“单向数据流”架构，禁止越级依赖或反向依赖。

| 文件 | 职责 | 备注（AI 必读） |
|---|---|---|
| `cultivation-packs.ts` | **唯一的组装车间**。拼装 `Expansion` 对象。 | **不含任何业务逻辑**。只负责 import 数据、组装对象、注册副作用。 |
| `identity.ts` | **身份判定器**。判断谁是修士、灵体。 | 不依赖本包其他任何文件。 |
| `progression.ts` | **境界/经验/寿元核心**。管升级、降级、寿元。 | **它不认识技能！** 升级时只通过 `onRankUp` 广播事件。 |
| `stats.ts` | **属性计算器**。纯数学函数，按境界算攻/防/射程/次数等加成。 | 无副作用。**所有数值规则（如倍率、公式）的“单一真相”必须放这里。** |
| `skills.ts` / `abilities.ts` / `units.ts` | **纯静态数据**。技能、能力、兵种的定义配置。 | 只有数据，没有逻辑。 |
| `skill-effects.ts` | **技能执行逻辑**。ready check、效果执行、预览计算。 | 模块加载时 `registerSkillEffect` 自注册副作用。 |
| `unlocks.ts` | **解锁系统**。分「机制层」和「触发源层」。 | 模块加载时 `onRankUp` 自注册副作用。详见第 3 节。 |
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
unlocks.ts / skill-effects.ts / hooks.ts / panel.ts（业务逻辑）
    ↑
cultivation-packs.ts（组装车间，唯一对外入口）
```

规则：**箭头只能向上指，底层永远不 import 上层。**
- `progression.ts` 绝对不允许 import 技能/能力。
- `skill-effects.ts` 要查属性，只能 import `stats.ts`，**绝不能** import `hooks.ts`。

## 3. 核心设计约定

1. **经验与等级解耦**：
   - `custom.exp` 和 `custom.rank` 是解耦的。`addExp` 只升不降。
   - 想“按经验反推等级”，用 `setCultivationExp`；想“只扣经验不掉级”，只改 `custom.exp`。
2. **修饰器语义（加法而非覆盖）**：
   - 所有的 `modify*` 钩子（如 `modifyAttacks`, `modifyDamage`），处理逻辑必须是 **`return 基础值 + 加成值`**，绝不能直接 `return 加成值`（这会吃掉基础武器的属性）。
   - 唯一例外是 `attTimesModifier` 的旧版，现已修复为加法。
3. **寿元落库**：
   - `custom.lifespan` 是第一优先级。`rank 9` 是 `Infinity`，不落库（JSON 不能存 Infinity）。
4. **规则单一真相（DRY）**：
   - 如果一个数值规则在三个地方用到（比如“剑修伤害倍率”），必须在 `stats.ts` 抽成函数或常量（如 `swordMul`、`SWORD_BASE_MUL`），在 `hooks.ts` 和 `panel.ts` 里统一调用。**严禁在各个文件里手写 `0.8` / `1.2` 等硬编码魔法数字。**

## 4. 解锁系统：机制层 vs 触发源层

`unlocks.ts` 内部刻意分两层：
- **机制层（对外公开）**：`learnSkill`（学技能）、`grantAbility`（获能力）。自带幂等判断和战报日志。
- **触发源层（文件私有）**：`onRankUp` + 两张 `*_UNLOCKS` 表。仅处理升级。

**如果要加一种新途径（如“读秘籍”），绝不要改触发源层！** 应该在 `skill-effects.ts` 里直接调用 `learnSkill`。

## 5. 常见任务指引

### 5.1 新增一个“升级自动领悟”的技能
1. `skills.ts`：加数据。
2. `skill-effects.ts`：加执行逻辑。
3. `unlocks.ts`：在 `CULTIVATOR_SKILL_UNLOCKS` 加一行。

### 5.2 新增一种“非升级”的解锁途径
1. 在 `skill-effects.ts` 或其他监听里，直接 `import { learnSkill } from './unlocks.ts'` 并调用。
2. **不要**修改 `unlocks.ts` 的触发表。

### 5.3 新增属性计算或修改公式
1. 必须在 `stats.ts` 里写纯函数，更新相关的计算。
2. 如果涉及 UI 显示，去 `panel.ts` 引用该函数或导出的常量，不要硬编码。
3. 如果是修改攻击次数等涉及引擎的修饰，确保在 `hooks.ts` 里用的是 `基础值 + 函数返回值`。

### 5.4 测试与热更新（HMR）防坑
如果测试用例或开发时遇到“监听器重复触发”（如升级弹两次战报），请在测试的 `beforeEach` 中调用：
`_resetRankUpListenersForTest()`（来自 `progression.ts`）。

### 5.5 注册副作用（极度关键）
`skill-effects.ts` 和 `unlocks.ts` 依赖模块加载时自注册。
**如果你新建了包含顶层副作用的文件，必须在 `cultivation-packs.ts` 里 import 一次，否则静默失效。**

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