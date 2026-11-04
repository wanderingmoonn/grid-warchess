# 修真扩展包 (Cultivation Pack) 架构说明

## 1. 目录结构与职责

本包采用“单向数据流”架构，禁止越级依赖或反向依赖。

| 文件 | 职责 | 备注 |
|---|---|---|
| `cultivation-packs.ts`（上级目录） | **唯一的组装车间**。只负责把各个零件拼装成 `Expansion` 对象。 | 不含业务逻辑；副作用模块在这里 `import` 一次 |
| `identity.ts` | **身份判定器**。判断谁是修士、谁是灵体。 | 不依赖本包其他任何文件 |
| `progression.ts` | **境界 / 经验 / 寿元核心**。管升级、降级、寿元。 | 不认识技能，只通过 `onRankUp` 广播升级事件 |
| `stats.ts` | **属性计算器**。纯数学函数，按境界算攻/防/射程等加成。 | 无副作用 |
| `skills.ts` / `abilities.ts` / `units.ts` | **纯静态数据**。技能、能力、兵种的定义配置。 | 只有数据，没有逻辑 |
| `skill-effects.ts` | **技能执行逻辑**。ready check、效果执行、预览计算。 | 模块加载时 `registerSkillEffect` 自注册副作用 |
| `unlocks.ts` | **解锁系统**。分「机制层」和「触发源层」，详见第 3 节。 | 模块加载时 `onRankUp` 自注册副作用 |
| `hooks.ts` | **事件钩子**。`onUnitKilled`、`modifyDamage`、`onTurnStart` 等 `ExpansionHooks` 的集合。 | 只放引擎回调，不放“给本包内部调用的 API” |
| `panel.ts` | **UI 面板拼接**。把数据拼成给玩家看的字符串。 | 纯查询，不写状态 |

## 2. 依赖方向

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

规则：**箭头只能向上指**。底层永远不 import 上层。
例如 `progression.ts` 不知道 `SKY_STEP_SKILL` 的存在，它只负责在升级时喊一声 `onRankUp`。

## 3. 解锁系统：机制层 vs 触发源层

`unlocks.ts` 内部刻意分成两层。**理解这两层，是以后加新功能不迷路的关键。**

### 3.1 机制层（对外公开）

| 函数 | 作用 | 幂等？ |
|---|---|---|
| `learnSkill(u, skill)` | 让单位学会一个后天技能。返回 `true` 表示本次是新学会。 | 是（已学过返回 `false`，不重复加） |
| `grantAbility(u, id, name, s)` | 让单位获得一个能力，并自动写战报。 | 是（已拥有返回 `false`） |

**机制层只管“怎么学会”，不管“谁触发的”。** 任何途径想发技能/能力，都调这两个函数，不要自己往 `extraSkills` / `extraAbilities` 里 push —— 否则会漏掉幂等判断和日志。

### 3.2 触发源层（本文件私有，不 export）

| 元素 | 作用 |
|---|---|
| `CULTIVATOR_SKILL_UNLOCKS` | 表：境界 ≥ rank 时自动领悟哪些技能 |
| `CULTIVATOR_ABILITY_UNLOCKS` | 表：境界 ≥ rank 时自动获得哪些能力 |
| `checkSkillUnlocks` / `checkAbilityUnlocks` | 遍历上表，调机制层 |
| `onRankUp(...)` | 把上面两个 check 挂到“升级”事件上 |

**触发源层是“升级”这一种途径的实现。** 将来“读秘籍”“拜师”“秘境奇遇”是**新的触发源**，它们：

- 不应该改 `checkSkillUnlocks` / `checkAbilityUnlocks`；
- 应该新建一个监听（或在 `skill-effects.ts` 里写对应的技能效果），直接调 `learnSkill` / `grantAbility`。

### 3.3 为什么能力用 `includes` 判断而不是“学过就不动”标记

技能一旦学会就永久保留，所以 `learnSkill` 用“已存在则跳过”。
能力则可能**被移除**（`progression.ts` 的 `cleanupAfterRankDrop`：灵体重生降级后移除 `spirit-ascension`），修士之后修炼回 rank 4 时要能**重新挂上**。
所以 `checkAbilityUnlocks` 每次调用都检查 `extraAbilities.includes(id)`，没有“只发一次”的标记。这是有意为之，不要“优化”掉。

## 4. 常见任务指引

### 4.1 新增一个“升级自动领悟”的技能

1. `skills.ts`：加技能数据，导出常量（如 `export const MY_SKILL`）。
2. `skill-effects.ts`：加执行逻辑（`registerSkillEffect`）。
3. `unlocks.ts`：在 `CULTIVATOR_SKILL_UNLOCKS` 加一行 `{ rank: N, skill: MY_SKILL }`。
4. 完事。升级会自动触发，日志自动写。

### 4.2 新增一个“升级自动获得”的能力

1. `abilities.ts`：加能力数据，导出常量。
2. `unlocks.ts`：在 `CULTIVATOR_ABILITY_UNLOCKS` 加一行 `{ rank: N, abilityId: '...', name: '...' }`。
3. 如果这个能力有“降级后要移除”的规则：`progression.ts` 的 `cleanupAfterRankDrop` 里加一条对应判断。
4. 完事。

### 4.3 新增一种“非升级”的解锁途径（读秘籍 / 拜师 / 奇遇）

1. **不要改 `unlocks.ts` 的触发源层。**
2. 在 `skill-effects.ts`（如果是某个技能/物品触发）或新建的监听文件里，直接调：
   ```ts
   import { learnSkill, grantAbility } from './unlocks.ts';
   learnSkill(u, BOOK_SKILL);
   ```
3. 如果是新的全局事件（如 `onUseItem`），需要先在 `expansions.ts` 的 `ExpansionHooks` 里加钩子定义，再在 `hooks.ts` 或新文件里注册。
4. 如果新建的文件有**顶层副作用注册**（`onRankUp`、`registerSkillEffect` 等），**记得在 `cultivation-packs.ts` 里 `import` 一次**，否则不生效。

### 4.4 新增一个兵种

1. `units.ts`：加兵种定义，导出常量。
2. `cultivation-packs.ts`：加进 `CULTIVATION_PACK.units` 数组。
3. 如果它需要修士身份：确认 `identity.ts` 的 `isCultivatorUnit` 能识别它（通常按 `type` 白名单，检查一下）。
4. 如果它有专属加成：`stats.ts` 加计算，`hooks.ts` 在对应 hook 里按 `type` 分支。

### 4.5 新增一个技能（完整流程，无解锁门槛）

1. `skills.ts` 加数据。
2. `skill-effects.ts` 加执行逻辑。
3. 如果它是“天生就会”而不是“升级领悟”：在 `units.ts` 的兵种定义里塞进初始技能列表（具体字段名看兵种类型定义）。

## 5. 开发规范约定

1. **依赖方向**：严格遵循第 2 节的图，底层不 import 上层。特别是 `progression.ts` **绝对不允许** import 技能/能力——它只通过 `onRankUp` 广播。
2. **发技能与能力**：统一走 `unlocks.ts` 的机制层（`learnSkill` / `grantAbility`）。**不要**直接改 `extraSkills` / `extraAbilities`。
3. **升级解锁**：只在 `unlocks.ts` 的两张 `*_UNLOCKS` 表里加行。**不要**在 `progression.ts` 或 `hooks.ts` 里写“if rank >= 4 就 push”这种散装逻辑。
4. **新增触发源**（非升级途径）：新建监听，调机制层，不改触发源层。
5. **注册副作用**：`skill-effects.ts` 和 `unlocks.ts` 都在模块加载时自注册。新增同类文件时，**必须在 `cultivation-packs.ts` 里 `import` 一次**，否则注册不执行，且不会有任何报错——这是最隐蔽的坑。
6. **入口文件的 re-export 桥接**：外部模块若从 `cultivation-packs.ts` import，只能拿到底部桥接列表里的东西。想给外部用新 API，去底部加一行 `export { ... } from './cultivation/xxx.ts'`，不要在入口文件里重写实现。

## 6. 老存档兼容

- `custom.rank` 缺失：`getRank` 反推一次并写回。
- `custom.lifespan` 缺失：`ensureLifespan` 反推一次并写回（`onTurnStart` 第一次触碰时）。
- `custom.exp` 与 `custom.rank` **解耦**：改 exp 不会自动改 rank。想“按 exp 反推等级”调 `setCultivationExp`；想“只减经验不掉级”只改 `custom.exp`。
- rank 9（渡劫）的寿元是 `Infinity`，**不落库**（JSON 序列化会变 `null`），走 rank 反推兜底。