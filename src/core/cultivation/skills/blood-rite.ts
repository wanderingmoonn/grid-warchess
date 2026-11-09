/**
 * 血祭：魔修的立身之本。
 *
 * ── 设计（2026-11-07 敲定）────────────────────────────────────────
 *
 * · 以**自己为圆心**抽取一圈精血，不分敌我。所以它不是"对着敌人放"，
 *   是"站在哪儿放"——站位本身就是要付的代价。
 * · 修为按**实际掉血**折算，不是按人头、也不走 `calcKillExp` 的每回合上限。
 *   这是魔修唯一的常规成长途径（打坐只有 1 点、击杀历练被关掉）。
 * · 折算率随境界下降：`1 / (1 + 0.5 × 境界)`。境界越高，同一次血祭越不值钱，
 *   于是"以命换道"在后期变成一件极不划算的事——这正是要的。
 * · 每次释放减 1 年寿元。寿元本来就挂在境界上，这条等于把"修炼速度"
 *   直接接到了"还能活多久"上。
 *
 * ── 两条不能被绕过的底线 ───────────────────────────────────────────
 *
 * 1. **友军不会被抽死**：伤害照吃，但最低留 1 点。
 *    否则「战争经济」（击杀 +15 金）和「老兵不死」（击杀永久 +1 攻）这些
 *    击杀奖励，就能靠献祭自己 65 金的仆役刷出来。
 * 2. **友军的伤害只算 25% 修为**：友军也能炼，但绝不能让"围一圈自己的肉盾"
 *    成为最优刷法。友军被抽到 1 血之后就抽不出东西了，这是第二道闸。
 *
 * ⚠️ 红线：本文件不许 import `../units.ts`（原因见 sky-step.ts 顶部）。
 */
import type { GameState, Unit, SkillDef } from '../../types.ts';
import { registerSkillEffect, registerSkillReadyCheck } from '../../skill-hooks.ts';
import { distToUnit, inBounds } from '../../query.ts';
import { addExp, ensureLifespan, getRank } from '../progression.ts';

// ── 数值 ──────────────────────────────────────────
/** 基础半径（格）。0 级就是四邻一圈 */
export const BLOOD_RITE_RADIUS_BASE = 1;
/** 境界每提高这么多级，半径再 +1 格 */
export const BLOOD_RITE_RADIUS_STEP = 3;
/** 每 1 点伤害折算多少修为（未按境界衰减前） */
export const BLOOD_RITE_EXP_PER_DAMAGE = 1;
/** 每级境界让折算率衰减多少：1 / (1 + 0.5 × 境界) */
export const BLOOD_RITE_EXP_DECAY = 0.5;
/** 打在友军身上的伤害，只按这个比例折算修为 */
export const BLOOD_RITE_ALLY_EXP_MUL = 0.25;
/** 每次释放要付多少年寿元 */
export const BLOOD_RITE_LIFESPAN_COST = 1;

/** 某个境界的血祭半径 */
export function bloodRiteRadiusForRank(rank: number): number {
  return BLOOD_RITE_RADIUS_BASE + Math.floor(Math.max(0, rank) / BLOOD_RITE_RADIUS_STEP);
}

/**
 * 某个境界下"每点伤害能折多少修为"。
 *
 * 面板直接印百分比，所以它是公开数值；改成查表或曲线也只需要动这一个函数。
 */
export function bloodRiteExpMul(rank: number): number {
  return BLOOD_RITE_EXP_PER_DAMAGE / (1 + Math.max(0, rank) * BLOOD_RITE_EXP_DECAY);
}

/** 血祭覆盖的格子（以自己为圆心的曼哈顿圆盘，含四角） */
export function bloodRiteCells(s: GameState, self: Unit, radius: number): Array<{ x: number; y: number }> {
  const out: Array<{ x: number; y: number }> = [];
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      if (Math.abs(dx) + Math.abs(dy) > radius) continue;
      const x = self.x + dx;
      const y = self.y + dy;
      if (!inBounds(s, x, y)) continue;
      out.push({ x, y });
    }
  }
  return out;
}

// ── 数据 ──────────────────────────────────────────
export const BLOOD_RITE_SKILL: SkillDef = {
  id: 'blood-rite',
  name: '血祭',
  summary:
    '以寿元为引，抽取周围一圈所有单位（含友军）的精血，按伤害折算修为——境界越高折算越低。',
  effect: 'blood-rite',
  cooldown: 0,
  multiCast: true,
  // 以自己为圆心，不需要选点：按一下就直接结算
  targeting: 'none',
  notReadyReason: '攻击次数不足',
};

// ── 实现 ──────────────────────────────────────────
registerSkillReadyCheck('blood-rite', (s, u) => {
  const left = u.attacksLeft ?? (s.unitTypes[u.type].burst ?? 1);
  return left > 0;
});

registerSkillEffect('blood-rite', (c) => {
  const self = c.self;

  // 1. 扣一次攻击（和剑气同一套收尾：出手即定身）
  if (self.attacksLeft === undefined) {
    self.attacksLeft = c.api.attacksPerTurn(c.state, self);
  }
  if (self.attacksLeft <= 0) {
    c.result.ok = false;
    c.result.reason = '本回合的攻击次数已经用光了，无法再血祭';
    return;
  }
  self.attacksLeft -= 1;
  if (self.attacksLeft <= 0) self.acted = true;
  self.moved = true;

  const rank = getRank(self);
  const radius = bloodRiteRadiusForRank(rank);

  // 2. 战况烈度：圆盘每一格都记，空地和友军那几格也算
  //    （"范围"是几何，不是"谁掉了血"）
  for (const cell of bloodRiteCells(c.state, self, radius)) {
    c.api.noteHeat(c.state, cell.x, cell.y);
  }

  // 3. 受害者：半径内除自己以外的所有单位，不分敌我
  const victims = c.state.units.filter(
    (u) =>
      u.id !== self.id &&
      u.hp > 0 &&
      distToUnit(c.state, { x: self.x, y: self.y }, u) <= radius,
  );

  let foeDamage = 0;
  let allyDamage = 0;
  let allyHit = 0;
  const doomed: Unit[] = [];

  for (const v of victims) {
    const dmg = c.api.computeDamage(c.state, self, v);
    if (dmg <= 0) continue;

    if (v.owner === self.owner) {
      // 友军：抽到最后一口气为止。宁可少打，也绝不制造"自己杀自己人"的击杀奖励。
      const capped = Math.min(dmg, v.hp - 1);
      if (capped <= 0) continue;
      c.api.hurt(c.state, v, capped, { source: self });
      allyDamage += capped;
      allyHit += 1;
      continue;
    }

    // 敌人：溢出伤害不算修为（否则打残血小兵最划算）
    foeDamage += Math.min(dmg, v.hp);
    c.api.hurt(c.state, v, dmg, { source: self });
    if (v.hp <= 0) doomed.push(v);
  }

  // 4. 寿元代价。老存档先落库（ensureLifespan），再减；
  //    渡劫期（rank 9）寿元是 Infinity、不落库，那就不用减了。
  const lifespan = ensureLifespan(self);
  if (Number.isFinite(lifespan)) {
    self.custom = {
      ...(self.custom ?? {}),
      lifespan: Math.max(0, lifespan - BLOOD_RITE_LIFESPAN_COST),
    };
  }

  // 5. 修为：敌方全额、友军打折，再按境界衰减。这条**不走**击杀上限。
  const exp = Math.floor(
    (foeDamage + allyDamage * BLOOD_RITE_ALLY_EXP_MUL) * bloodRiteExpMul(rank),
  );
  if (exp > 0) addExp(self, c.state, exp);

  // 6. 死亡走完整流程（亡语、沉船、击杀钩子）
  for (const v of doomed) {
    if (v.hp > 0) continue;
    if (!c.state.units.some((u) => u.id === v.id)) continue;
    c.api.killUnit(c.state, v, self, `${c.api.utype(c.state, v.type).name} 被血祭炼化`);
  }

  // 7. 战报
  const parts: string[] = [];
  if (foeDamage > 0 || doomed.length > 0) parts.push(`重创 ${foeDamage} 点`);
  if (allyHit > 0) parts.push(`波及友军 ${allyHit} 人`);
  if (parts.length === 0) parts.push('一圈之内没有活物');
  parts.push(`修为 +${exp}`);
  parts.push(`寿元 −${BLOOD_RITE_LIFESPAN_COST}`);
  c.result.log = `血祭：${parts.join('，')}`;
});
