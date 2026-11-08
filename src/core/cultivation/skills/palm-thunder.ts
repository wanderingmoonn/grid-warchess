/**
 * 掌心雷：法术池里的第一条样板法术。
 *
 * ── 它要验证的四件事 ────────────────────────────────────
 *
 * 1. **法术 ≠ 技能**：它不在兵种表上、不随境界领悟，只能去藏经阁学；
 *    学来之后躺在 `extraSkills` 里，和天赋技能共用同一套按钮与释放流程。
 * 2. **吃灵力**：每一发都从自己的灵力池里扣（见 mana.ts），扣不起按钮就是灰的。
 * 3. **无视护甲**：走 `api.hurt`（唯一扣血出口），不经过 `computeDamage` 的护甲段。
 *    所以它对重甲兵特别狠——这正是法术和普攻最干净的分界。
 * 4. **每回合一发**：`multiCast: false`。灵力是跨回合的池子，节拍靠它，
 *    不额外占攻击次数，也不占移动。
 *
 * ── 数值是占位，别当成定稿 ────────────────────────────
 *
 * 伤害 `6 + 3 × 境界`：2 期 12 点、6 期 24 点。同代民兵 13 攻打 2 甲还剩 11，
 * 所以它在低境界是"一发换掉半个兵"，高境界反而被普攻追上——这是有意的：
 * 法术的价值在"无视护甲 + 不还手"，不在数值膨胀。
 *
 * ⚠️ 红线：本文件不许 import `../units.ts`（见 sky-step.ts 顶部）。
 */
import type { SkillDef } from '../../types.ts';
import { registerSkillEffect, registerSkillPreview, registerSkillReadyCheck } from '../../skill-hooks.ts';
import { coversTile, distBetweenUnits } from '../../query.ts';
import { getRank } from '../progression.ts';
import { canSpendMana, manaOf, spendMana } from '../mana.ts';

// ── 数值 ──────────────────────────────────────────
/** 施放一次要多少灵力（设计上全部乘 10，见 mana.ts） */
export const PALM_THUNDER_COST = 50;
/** 基础伤害 */
export const PALM_THUNDER_BASE = 6;
/** 每层境界加多少伤害 */
export const PALM_THUNDER_PER_RANK = 3;
/** 射程（格） */
export const PALM_THUNDER_RANGE = 3;

/** 这一发打多少（面板和规则共用同一份算式） */
export function palmThunderDamage(rank: number): number {
  return PALM_THUNDER_BASE + PALM_THUNDER_PER_RANK * Math.max(0, rank);
}

// ── 数据 ──────────────────────────────────────────
export const PALM_THUNDER_SKILL: SkillDef = {
  id: 'palm-thunder',
  name: '掌心雷',
  summary:
    `射程 ${PALM_THUNDER_RANGE} 格，对一名敌人造成 ${PALM_THUNDER_BASE} + 境界×${PALM_THUNDER_PER_RANK} 点伤害（无视护甲）；` +
    `耗 ${PALM_THUNDER_COST} 灵力。`,
  effect: 'palm-thunder',
  cooldown: 0,
  /*
   * **不限每回合一次**：节拍交给灵力池来管。
   * 一个 9 期修士一回合能连放两发（130 点上限、每发 50），0 期连一发都攒不齐——
   * "什么时候烧掉这池子"本身就是一个决定，比"一回合只能放一次"有意思得多。
   */
  multiCast: true,
  targeting: 'point',
  radius: PALM_THUNDER_RANGE,
};

// ── 实现 ──────────────────────────────────────────
// 就绪检查按 **skill.id** 查（rules.ts 的 SKILL_READY_CHECKS[k.id]）。
registerSkillReadyCheck('palm-thunder', (_s, u) => {
  if (!canSpendMana(u, PALM_THUNDER_COST)) {
    return `灵力不足（${manaOf(u)} / ${PALM_THUNDER_COST}）`;
  }
  return true;
});

registerSkillEffect('palm-thunder', (c) => {
  const s = c.state;
  const self = c.self;
  const target = c.target;

  if (!target) {
    c.result.ok = false;
    c.result.reason = '选一个目标';
    return;
  }
  // 用 coversTile 而不是"锚点坐标相等"：2×2 的单位占四格，
  // 点在它的右下角也该算命中（query.ts 里那是同一份几何）。
  const victim = s.units.find((u) => u.hp > 0 && coversTile(s, u, target.x, target.y));
  if (!victim) {
    // 法术只打单位：城池、空地都要明说，否则玩家会以为"点了没反应"
    c.result.ok = false;
    c.result.reason = '那一格没有单位（法术打不了城池）';
    return;
  }
  if (victim.owner === self.owner) {
    c.result.ok = false;
    c.result.reason = `不能对自己的${c.api.utype(s, victim.type).name}放雷`;
    return;
  }
  if (distBetweenUnits(s, self, victim) > PALM_THUNDER_RANGE) {
    c.result.ok = false;
    c.result.reason = `太远了（掌心雷射程 ${PALM_THUNDER_RANGE} 格）`;
    return;
  }
  if (!spendMana(self, PALM_THUNDER_COST)) {
    c.result.ok = false;
    c.result.reason = `灵力不足（需要 ${PALM_THUNDER_COST} 点）`;
    return;
  }

  const dmg = palmThunderDamage(getRank(self));
  const name = c.api.utype(s, self.type).name;
  // 走唯一扣血出口：守御阵会替它挡、受伤钩子照常触发
  c.api.hurt(s, victim, dmg, { source: self, logText: `${name}以掌心雷击中${c.api.utype(s, victim.type).name}，造成 ${dmg} 点伤害` });
  // 战况烈度：雷落到过哪儿，对面下一回合看得见
  c.api.noteHeat(s, victim.x, victim.y);

  if (victim.hp <= 0) {
    c.api.killUnit(s, victim, self, `${c.api.utype(s, victim.type).name}被掌心雷击穿`);
    c.result.log = `${name}雷光一闪，${c.api.utype(s, victim.type).name}当场殒命（耗 ${PALM_THUNDER_COST} 灵力）`;
    return;
  }
  c.result.log = `${name}施放掌心雷，${c.api.utype(s, victim.type).name} 受到 ${dmg} 点伤害（无视护甲）`;
});

/**
 * 瞄准预览：把射程圈整圈点亮。
 *
 * 单点法术只需要"哪一格够得着"——把整圈亮出来，玩家一眼就知道该往哪走一步。
 * 不按落点算（落点只是最终目标），否则鼠标一动高亮就跟着碎，反而看不清射程。
 */
registerSkillPreview('palm-thunder', (c) => {
  const { state, self } = c;
  const cells: number[] = [];
  for (let dy = -PALM_THUNDER_RANGE; dy <= PALM_THUNDER_RANGE; dy++) {
    for (let dx = -PALM_THUNDER_RANGE; dx <= PALM_THUNDER_RANGE; dx++) {
      if (Math.abs(dx) + Math.abs(dy) > PALM_THUNDER_RANGE) continue;
      if (dx === 0 && dy === 0) continue;
      const x = self.x + dx;
      const y = self.y + dy;
      if (x < 0 || y < 0 || x >= state.w || y >= state.h) continue;
      cells.push(y * state.w + x);
    }
  }
  return cells;
});
