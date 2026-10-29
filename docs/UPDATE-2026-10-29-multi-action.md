# 更新公告 · 2026-10-29 · 连击改成"多动"：一回合能打几次，每次都是一击

> 一句话：`burst` 不再是"一次攻击内部拆成 N 段"，而是**一回合能发起 N 次攻击**。
> 每次都是完整的一击、可以换目标，次数没用完就不算行动结束。
> 反击次数也跟着等于 N——所以围攻一个多动兵，比单挑它划算。

---

## 一、以前什么样

连击是在**一次 ATTACK 动作内部**跑一个循环：

```ts
let hits = 0;
while (hits < def.burst && defender.hp > 0) {
  defender.hp -= computeDamage(s, attacker, defender);
  hits++;
}
// 循环结束才写 acted，整次连击算"一次行动"
```

它把三件事绑死在了同一次动作里，三个后果都不太对：

1. **火力会凭空消失**。目标死了循环就停，剩下的段直接蒸发。三连击打一个
   只剩 1 血的民兵，只有 1 段生效。
2. **换不了目标**。想打死 A 之后再顺手扫掉 B，没有表达方式——玩家只能在
   开火前赌一把。
3. **对重甲是负收益**。每段各自减一次护甲，3 段打 6 甲就是 3×(攻−6)。
   "三连击"在数字上看着像三倍，实际是三次减法，重甲面前比一刀还弱。

## 二、现在什么样

`burst` 的含义改成了**一回合的攻击次数**，一次 ATTACK 只结算**一发**：

```ts
// 本回合第一次攻击时把剩余次数填满
if (attacker.attacksLeft === undefined) {
  attacker.attacksLeft = Math.max(1, attacksPerTurn(s, attacker));
}
if (attacker.attacksLeft <= 0) return { ok: false, reason: '该单位本回合没有剩余攻击次数' };

defender.hp -= computeDamage(s, attacker, defender);
attacker.attacksLeft -= 1;
attacker.moved = true;
if (attacker.attacksLeft <= 0) attacker.acted = true;
```

于是玩家能做的事变成：

- **每一发都是完整的一击**：护甲照常减，但减的是同一份攻击力，不再被拆散；
- **每一发都能换目标**：第一发打死 A，第二发可以打 B，也可以什么都不打；
- **次数没用完不算结束**：界面上单位仍然可点，直到次数归零才变灰；
- **攻击之后就走不动了**（`moved` 照旧置上），所以剩下的几发只能站在原地打完
  ——位置没选好，等于站着挨一轮围攻。

### 反击也跟着改了

防守方的反击次数 `countersLeft` 和攻击次数用同一个来源（兵种 `burst`，
再过一遍扩展的 `ExpansionHooks.modifyAttacks`）。含义是：

- 三个单位围攻一个三动兵 → 它能还手三次；
- **同一个**单位连着打它三次 → 它也只还手三次。

所以"围攻"比"单挑"更有效。这是这一版刻意要的效果：多动兵不该一个人守住一条线。

### 自动开火的建筑

`fireBuildings()` 也走同一套：一次回合结束的自动开火会把这个建筑这一回合的
次数**打满**，每一发都重新挑最近的 / 最弱的目标，战报合并成一行。

## 三、和别的机制的接口

| 环节 | 现在是什么样 |
|---|---|
| 每发伤害 | 每发单独调用 `computeDamage`，护甲/地形/光环/天气每次都重算 |
| 命中状态 / 吸血 / 击退 | 每发各结算一次（以前是整次连击一次） |
| 溅射 | 每发各溅射一次，以该发的主目标为中心 |
| 战报 | 每发一行「机枪队 攻击 民兵，造成 14 伤害」；不再有"第几段" |
| 行动次数 | 次数归零才写 `acted`；中途停手（次数还剩）单位仍然可再攻击 |
| 移动 | 第一发之后 `moved` 就置上，剩下的发次不能先挪再打 |
| 反击 | 每次挨打都判定，次数由防守方的 `burst` 决定；`noCounter` 兵种仍然不还手 |
| 预览（`previewAttack`） | 只预演**这一发**，`hits` 恒为 1；"还剩几次"显示在侧栏的「多动」一行 |
| AI | `canAttack()` 已经把剩余次数算进去，所以 AI 会自然地把次数打满 |
| 存档 / 联机 | 只多两个可选字段 `attacksLeft` / `countersLeft`，每回合重置；老存档照常读 |

## 四、代码位置

| 位置 | 改了什么 |
|---|---|
| `src/core/types.ts` `Unit` | 新增 `attacksLeft` / `countersLeft`（剩余攻击次数、剩余反击次数） |
| `src/core/rules.ts` `attacksPerTurn()` | **新增**：一回合攻击几次 = `burst` 过一遍 `modifyAttacks`。攻击、反击、界面三处共用 |
| `src/core/rules.ts` `attacksLeftOf()` | **新增**：还剩几次（没开始打时就是满的），给侧栏用 |
| `src/core/rules.ts` `canAttack()` | 改成 `!acted && (attacksLeft ?? 1) > 0` |
| `src/core/rules.ts` `doAttack()` | 去掉内部的 `while` 循环：一次动作只打一发，扣一次次数，扣完才 `acted`；反击按 `countersLeft` 判定 |
| `src/core/rules.ts` `resetUnitsFor()` | 回合开始 `delete u.attacksLeft` |
| `src/core/rules.ts` `doEndTurn()` | 回合结束清空**所有**单位的 `countersLeft`（不只当前玩家） |
| `src/core/rules.ts` `fireBuildings()` | 自动开火把次数打满，每发重挑目标 |
| `src/core/info.ts` | 兵种说明里"连击 N 段"改成"多动 N 次"，并说明它同时决定反击次数 |
| `src/ui/panel.ts` | 侧栏新增「多动：还剩 x / N 次」一行，替换原来那行「连击 N 段 · 每段独立减甲」 |
| `scripts/build-manual.ts` | 词条、特性列、机制章节全部改成多动口径 |
| `scripts/test-rules.ts` | 新增 `readyAgain()`；旧"连击"用例重写成多动用例，新增"建筑自动开火也要打满" |

## 五、影响范围

- **规则**：所有 `burst > 1` 的兵种（装甲车 2、机枪队 3、重机枪组 4、
  以及几个扩展包里的多动兵）行为全变。`burst = 1` 的兵种逻辑一致，只是多了一次
  `attacksLeft` 的赋值与扣减。
- **数值**：`burst` 现在是**倍率**，`atk` 是"一发"的数。机枪队 atk 20 × 3 次 =
  一回合 60 点理论输出，和老版本"3×(20−甲)"完全不是一个量级。
  这一批**没有重估**多动兵的数值，先让规则跑通；平衡是下一件要做的事
  （`atk` 和 `burst` 必须一起调，只动一个会把整条输出线乘上去）。
- **测试**：老的规则测试里有 6 处靠"手动清 `acted`/`moved` 再打第二次"，
  在多动模型下 `attacksLeft` 已经是 0，会被正当地拒绝。这些都换成了
  `readyAgain()`（清 `moved`/`acted` 之外也清 `attacksLeft`）。
- **兼容**：不涉及存档结构变化；联机里旧客户端收到"次数没用完还可以再攻击"
  的状态时按原有 `canAttack` 逻辑处理即可，最坏情况是少打几发，不会产生非法动作。

## 六、验证

`npm test`：规则 **355** 项、AI 场景 25 项、评估方法 7 项、界面冒烟 128 项，全过。
`npx tsc --noEmit` 与 `npx vite build` 通过，规则书与代码同步（CI 的
「规则书与代码同步」一步不会红）。
