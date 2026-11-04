# 修真扩展包 (Cultivation Pack) 架构说明

## 1. 目录结构与职责
本包采用“单向数据流”架构，禁止越级依赖或反向依赖。

- `index.ts` / 上级目录的 `cultivation-packs.ts`：**唯一的组装车间**。只负责把各个零件拼装成 `Expansion` 对象，不含任何业务逻辑。
- `identity.ts`：**身份判定器**。判断谁是修士、谁是灵体。不依赖本包其他任何文件。
- `progression.ts`：**境界与经验核心**。管升级、降级、寿元。它不认识技能，只通过 `onRankUp` 广播升级事件。
- `stats.ts`：**属性计算器**。纯数学函数，根据境界算攻击/护甲加成。不包含副作用。
- `skills.ts` / `abilities.ts` / `units.ts`：**纯静态数据**。只存放技能、能力、兵种的定义配置。
- `skill-effects.ts`：**技能执行逻辑**。包含技能的 ready check、效果执行、预览计算等代码。
- `hooks.ts`：**事件钩子**。包含扩展注册的 `onUnitKilled`、`modifyDamage`、`onTurnStart` 等响应。
- `panel.ts`：**UI 面板拼接**。负责把数据拼成给玩家看的字符串。

## 2. 开发规范约定
1. **依赖方向**：`数据/状态 (stats, progression)` ← `业务逻辑 (hooks, skill-effects)` ← `组装 (cultivation-packs.ts)`。绝不允许底层去 import 上层。
2. **发技能与能力**：所有与“升级触发新技能”相关的注册，统一在 `hooks.ts` 或原文件里用 `onRankUp` 监听实现，不要塞回 `progression.ts`。
3. **注册副作用**：`skill-effects.ts` 利用了模块加载时的副作用（`registerSkillEffect`），在主入口 `cultivation-packs.ts` 中被 `import` 一次即可生效。
4. **新增技能**：先在 `skills.ts` 加数据，再在 `skill-effects.ts` 加执行逻辑。