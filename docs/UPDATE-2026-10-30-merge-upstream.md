# 合并上游：攻城结算重构、修真扩展、选卡修正

日期：2026-10-30

这次是**合并 `origin/main`**（14 个提交），不是自己写的新功能。合并本身零冲突，
下面记的是别人的改动带来了什么，以及合并后查出来的一个真问题和我怎么修的。

## 上游带来什么

| 改动 | 内容 |
| --- | --- |
| 攻城结算重构 | 城市不再有自己的伤害公式：它被包成一个**伪单位**（`type: '__city__'`、`__isCity: true`）喂进 `computeDamage`，攻城与野战从此走同一个算式。顺手修掉"攻城后多段攻击单位只能打一次"和"反击折减不在最后算"两个 bug |
| 修真扩展 | 第一个修真兵种落地；属性条目改成"面板能逐条显示 + 扩展能直接改写"，不必再动核心代码 |
| 选卡与规则书 | 选卡模式经这轮重构后的一串修正（空数据、非法 id 导致测试崩盘等），规则书对应更新 |
| 面板 | 属性的"视野"改由 `effectiveStats(...).vision` 提供，不再单独走 `visionOf` |

## 合并后查出来的问题：伪城市混进了选卡池

`__city__` 为了方便结算，被登记进了 `UNIT_TYPES`（`category: 'building'`、`era: 'none'`、
`cost: 0`）。而 `DEFAULT_CONFIG.enabledUnits` 是 `Object.keys(UNIT_TYPES)`，
所以**每一局**的 `state.unitTypes` 里都躺着它；选卡池又取自"全部兵种"。

实测（合并后、修复前）：

```
candidates: 32 含 __city__: true
pool: 20 含 __city__: true
```

后果三处：

1. **选卡池少一个真兵种**。20 格里有 1 格是伪单位，选卡面板把它渲染成空字符串
   （上游加了一道 `if (id === '__city__') return ''`），于是界面上是 19 张卡 + 一片空白。
2. **它仍然可以被禁、被选**。界面挡住的只是渲染，`DRAFT_BAN` / `DRAFT_PICK`
   收的是 id，池子里有它就仍然选中得了。
3. **计数全错**。`packRow` 数"全部 N"时把它算进原版；`CHEAPEST_COST` 被它 0 元的标签
   拉成 0；单位编辑器的"建筑"列表里多出一个「城市」。

### 怎么修

判据收成一处（`src/core/config.ts`）：

```ts
export const PSEUDO_UNIT_IDS: ReadonlySet<string> = new Set(['__city__']);
export function isPseudoUnit(id: string): boolean { … }
```

然后：

- `setup.ts` 组 `pool` 时剔掉伪单位——**它连"这一局有哪些兵"都不该进**
- `draft.ts` 的 `draftCandidates` / `remainingUnits` 剔掉（池子的唯一入口）
- `setup-panel` / `draft-panel` / `unit-editor` 的 `!== '__city__'` 全部换成这个判据
- `packRow` 不数它，`CHEAPEST_COST` 不算它

### 反过来的一步：攻城结算不能再依赖"它在表里"

把 `__city__` 从 `state.unitTypes` 里拿掉之后，18 条攻城测试一起挂了，全是
`本局没有兵种: __city__`。堆栈指到 `magicDamageOf`：

```ts
export function magicDamageOf(s, attacker, defender) {
  return magicSegment(s, attacker, utype(s, defender.type).magicRes ?? 0, defender);
}
```

`computeDamage` 自己明明写着"城市现场伪造兵种定义，绝不查 `s.unitTypes`"，
但魔法段这一步还是回头查了表。修法是把这条依赖剪断——伪单位没有魔法抗性可言，
按 0 算：

```ts
const res = isPseudoUnit(defender.type) ? 0 : (utype(s, defender.type).magicRes ?? 0);
```

于是两边都成立：伪单位不占池子、不进兵种表，攻城照样算得出来。

## 验证

- `npx tsc --noEmit` 通过
- `npm test` 全绿：规则 **428** / 界面 **144** / 静态服务器 **11**
- 新增两条用例钉住这件事：
  - 规则：`draftCandidates` 与 `draft.pool` 都不含 `__city__`，`'__city__' in s.unitTypes` 为假，
    池子仍然是 20 个且无重复
  - 界面：禁用阶段池子里**正好 20 张卡**，每张卡都有兵种名（空卡片说明混了伪单位），
    且不存在 `[data-draft="__city__"]`

## 回滚

```bash
git revert <本批 commit>        # 只回滚伪单位判定，保留上游合并
# 或者整体回到合并前：
git reset --hard backup-before-merge-20261030
npm run build:static && node scripts/serve-static.mjs
```

无存档字段变更，旧存档照读。
