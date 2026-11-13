/**
 * 罡风：远距离、大范围、无视护甲的法术。
 *
 * ── 它要解决的问题（2026-11-13）──────────────────────────
 *
 * 修士的普攻是**单体多段**：境界再高，一回合也只是把一个目标敲几下。
 * 对面三台机甲压上来时，它打谁都得一个一个来，而挨的是三份伤害。
 * 所以「以一敌多」缺的从来不是数值，是**面积**。
 *
 * 罡风就是那个面积：射程 8、半径 2、命中范围内所有敌人、无视护甲。
 * 7/8 代的甲厚（31~43）正好是它最占便宜的地方——这也让它成为
 * 「修士对上重装」时唯一像样的答案。
 *
 * ── 为什么写"所有敌人"而不是"打主目标+溅射"──────────────
 *
 * 溅射是 50% 的边际伤害，半径再大也只是"顺便"。这里要的是**主菜**：
 * 一片人同时掉同样多的血。所以不走 splash 那条路，直接逐个 `hurt`。
 *
 * 代价是它不吃任何"溅射加成/减免"——这是有意的：溅射是物理层面的概念，
 * 罡风不是"一次打偏了的攻击"，它就是法术本身。
 *
 * ⚠️ 红线：本文件不许 import `../units.ts`（见 sky-step.ts 顶部）。
 */
import type { SkillDef } from '../../types.ts';
import { registerSkillEffect, registerSkillPreview, registerSkillReadyCheck } from '../../skill-hooks.ts';
import { distToUnit } from '../../query.ts';
import { getRank } from '../progression.ts';
import { canSpendMana, manaOf, spendMana } from '../mana.ts';

// ── 数值 ──────────────────────────────────────────
/** 施放一次要多少灵力（比掌心雷贵一档：它是主力输出，不是补刀） */
export const GANG_WIND_COST = 80;
/** 施法距离 */
export const GANG_WIND_RANGE = 8;
/** 爆发半径（中心格起算，含斜角） */
export const GANG_WIND_RADIUS = 2;
/** 基础伤害 */
export const GANG_WIND_BASE = 30;
/** 每层境界加多少伤害 */
export const GANG_WIND_PER_RANK = 9;
/** 学它要求的最低境界：4 期（2 期就拿到会把这门法术变成本代最强 AOE） */
export const GANG_WIND_MIN_RANK = 4;
/** 研发要多少灵石（比默认 60 贵：强度摆在这） */
export const GANG_WIND_RESEARCH_COST = 90;

/** 这一发打多少（面板、按钮、结算共用同一份算式） */
export function gangWindDamage(rank: number): number {
  return GANG_WIND_BASE + GANG_WIND_PER_RANK * Math.max(0, rank);
}

/** 施法距离：修士是 1×1，点到点的曼哈顿距离就够了 */
export function gangWindInRange(self: { x: number; y: number }, target: { x: number; y: number }): boolean {
  return Math.abs(self.x - target.x) + Math.abs(self.y - target.y) <= GANG_WIND_RANGE;
}

// ── 数据 ──────────────────────────────────────────
export const GANG_WIND_SKILL: SkillDef = {
  id: 'gang-wind',
  name: '罡风',
  summary:
    `射程 ${GANG_WIND_RANGE} 格，对落点半径 ${GANG_WIND_RADIUS} 格内**所有**敌人造成 ` +
    `${GANG_WIND_BASE} + 境界×${GANG_WIND_PER_RANK} 点伤害（无视护甲）；耗 ${GANG_WIND_COST} 灵力。`,
  effect: 'gang-wind',
  cooldown: 0,
  // 和掌心雷一样：节拍交给灵力池，不额外限每回合一次
  multiCast: true,
  targeting: 'point',
  radius: GANG_WIND_RANGE,
};

// ── 实现 ──────────────────────────────────────────
registerSkillReadyCheck('gang-wind', (_s, u) => {
  if (!canSpendMana(u, GANG_WIND_COST)) {
    return `灵力不足（${manaOf(u)} / ${GANG_WIND_COST}）`;
  }
  return true;
});

registerSkillEffect('gang-wind', (c) => {
  const s = c.state;
  const self = c.self;
  const target = c.target;

  if (!target) {
    c.result.ok = false;
    c.result.reason = '选一个落点';
    return;
  }
  if (!gangWindInRange(self, target)) {
    c.result.ok = false;
    c.result.reason = `太远了（罡风射程 ${GANG_WIND_RANGE} 格）`;
    return;
  }

  /*
   * 先圈人再扣灵力：空放一发不该白花 80 点。
   * 圈人的口径是 `distToUnit`（点到矩形的最短距离），不是"锚点坐标相等"——
   * 2×2 的建筑只要有一角在圈里就算被扫到，这和玩家看到的范围一致。
   */
  const victims = s.units.filter(
    (u) => u.hp > 0 && u.owner !== self.owner && distToUnit(s, target, u) <= GANG_WIND_RADIUS,
  );
  if (victims.length === 0) {
    c.result.ok = false;
    c.result.reason = '那里没有敌人';
    return;
  }
  if (!spendMana(self, GANG_WIND_COST)) {
    c.result.ok = false;
    c.result.reason = `灵力不足（需要 ${GANG_WIND_COST} 点）`;
    return;
  }

  const dmg = gangWindDamage(getRank(self));
  const name = c.api.utype(s, self.type).name;
  let total = 0;
  let killed = 0;

  // `victims` 是 filter 出来的新数组，killUnit 改的是 s.units，边遍历边删是安全的
  for (const victim of victims) {
    const vName = c.api.utype(s, victim.type).name;
    const hpBefore = victim.hp;
    c.api.hurt(s, victim, dmg, { source: self, logText: `${name}的罡风扫过，${vName} 受到 ${dmg} 点伤害` });
    total += Math.max(0, hpBefore - victim.hp);
    if (victim.hp <= 0) {
      c.api.killUnit(s, victim, self, `${vName}被罡风撕碎`);
      killed += 1;
    }
  }

  c.api.noteHeat(s, target.x, target.y);
  c.result.log =
    `${name}施放罡风，命中 ${victims.length} 名敌人，共造成 ${total} 点伤害` +
    (killed > 0 ? `，${killed} 名当场殒命` : '') +
    `（耗 ${GANG_WIND_COST} 灵力）`;
});

/**
 * 瞄准预览：把**落点的爆发范围**亮出来。
 *
 * 和掌心雷相反——那个亮的是"我能打到哪一圈"，因为它只打一点；
 * 罡风要回答的是"我这一下会罩住谁"，所以亮的是落点周围的半径。
 */
registerSkillPreview('gang-wind', (c) => {
  const { state, self, target } = c;
  if (!gangWindInRange(self, target)) return [];
  const cells: number[] = [];
  for (let dy = -GANG_WIND_RADIUS; dy <= GANG_WIND_RADIUS; dy++) {
    for (let dx = -GANG_WIND_RADIUS; dx <= GANG_WIND_RADIUS; dx++) {
      const x = target.x + dx;
      const y = target.y + dy;
      if (x < 0 || y < 0 || x >= state.w || y >= state.h) continue;
      cells.push(y * state.w + x);
    }
  }
  return cells;
});
