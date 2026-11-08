/**
 * 泉涌：灵泉（建筑）的主动技能。
 *
 * ── 设计（2026-11-08 敲定）────────────────────────────────
 *
 * 每回合一次，把四邻内**己方**伤员的血补上一截，然后按"补了多少"收灵石。
 *
 * · **按比例（10% 生命上限）而不是固定点数**：同一口泉对新兵和元婴修士都说得通，
 *   固定点数只会在某一个境界段好用。
 * · **灵石按实际回血量计费**（每 5 点 1 块，至少 1 块）。这是这条技能真正的闸门：
 *   高境界修士血多，10% 就是几十点，回一次要好几块灵石。
 *   没有它，"一座泉养一个元婴"就会变成无解的续航怪——这正是加灵泉时要防的事。
 * · **灵石不够就整条降级成"每单位 1 点"**，不做"能回多少回多少"的比例折算：
 *   那样玩家永远算不清"我现在这点灵石到底能换来什么"。降级是清楚的两个状态——
 *   要么满额、要么聊胜于无；而且最低价那一块照扣，不能零成本刷。
 * · **一块灵石都没有时按钮是灰的**（有就绪检查）：泉要灵石才启动，这是设计。
 *
 * ── 为什么不做成光环 ──────────────────────────────────────
 *
 * 回血在这套规则里应该是**要付钱的选择**，不是"站在旁边就有"的白给。
 * 做成光环的话它会和「治疗光环」一样变成"放那儿就完事"，灵石那条约束直接作废。
 *
 * ⚠️ 红线：本文件不许 import `../units.ts`（原因见 sky-step.ts 顶部）。
 */
import type { GameState, Unit, SkillDef } from '../../types.ts';
import { registerSkillEffect, registerSkillReadyCheck } from '../../skill-hooks.ts';
import { resOf, addRes } from '../../resources.ts';
import { distBetweenUnits, underConstruction } from '../../query.ts';
import { SPIRIT_STONE } from '../resources.ts';

// ── 数值 ──────────────────────────────────────────
/** 每个单位回多少：生命上限的比例 */
export const SPRING_HEAL_RATIO = 0.1;
/** 每多少点**实际**回血收 1 块灵石 */
export const SPRING_HP_PER_STONE = 5;
/** 最低收费。不给这一条，"没灵石也点一下"就能白刷 1 点血 */
export const SPRING_MIN_COST = 1;
/** 灵石不够时的降级回复量（每人） */
export const SPRING_FLOOR_HEAL = 1;
/** 「相邻」= 四邻（曼哈顿 1 格），和守阵修士、建造工匠同一口径 */
export const SPRING_RADIUS = 1;

/** 一个单位一次能回多少（按上限比例，至少 1 点） */
export function springHealAmount(maxHp: number): number {
  return Math.max(1, Math.round(maxHp * SPRING_HEAL_RATIO));
}

/** 满额泉涌要多少灵石（按实际回血总量算；0 点回血不收钱） */
export function springStoneCost(totalHeal: number): number {
  if (totalHeal <= 0) return 0;
  return Math.max(SPRING_MIN_COST, Math.ceil(totalHeal / SPRING_HP_PER_STONE));
}

/**
 * 四邻内值得治的友军。
 *
 * 只算**己方、活着、没满血、能被治疗**的单位：
 *   · 敌方不算——泉水不替敌人疗伤；
 *   · 满了不算——不然"回 0 点也收 1 块灵石"；
 *   · 机械不算（`canBeHealed` 是本体那条判据，别在这里另写一份）；
 *   · 工地不算：那是一堵正在长的墙，给它回血会变成"修房子免费加速"的错觉。
 *
 * `maxHpOf` / `canBeHealed` 由调用方注入：上限含境界加成与衰老修正，
 * 扩展自己算会漏掉一半（和 artifacts.ts 里 visionOf 同一个理由）。
 */
export function springTargets(
  s: GameState,
  self: Unit,
  maxHpOf: (u: Unit) => number,
  canHeal: (u: Unit) => boolean,
): Unit[] {
  const out: Unit[] = [];
  for (const u of s.units) {
    if (u.id === self.id || u.owner !== self.owner) continue;
    if (u.hp <= 0) continue;
    if (distBetweenUnits(s, u, self) > SPRING_RADIUS) continue;
    if (underConstruction(u)) continue;
    if (!canHeal(u)) continue;
    if (u.hp >= maxHpOf(u)) continue;
    out.push(u);
  }
  return out;
}

// ── 数据 ──────────────────────────────────────────
export const SPRING_SURGE_SKILL: SkillDef = {
  id: 'spring-surge',
  name: '泉涌',
  summary:
    `恢复四邻内每个友军 ${Math.round(SPRING_HEAL_RATIO * 100)}% 生命上限（至少 1 点），` +
    `按实际回血量收灵石：每 ${SPRING_HP_PER_STONE} 点 ${SPRING_MIN_COST} 块，不足时每人只回 ${SPRING_FLOOR_HEAL} 点。` +
    `每回合一次。`,
  effect: 'spring-surge',
  cooldown: 0,
  multiCast: false, // 每回合一次
  // 以泉为圆心，不需要选点：按一下就直接结算
  targeting: 'none',
  radius: SPRING_RADIUS,
};

// ── 实现 ──────────────────────────────────────────
// 就绪检查按 **skill.id** 查（rules.ts 的 SKILL_READY_CHECKS[k.id]），
// 写成 effect 名会静默失效：没灵石、旁边没人时按钮照样亮，点下去才报错。
registerSkillReadyCheck('spring-surge', (s, u, api) => {
  const p = s.players[u.owner];
  if (resOf(p, SPIRIT_STONE) < SPRING_MIN_COST) {
    return `灵石不足（泉涌至少要 ${SPRING_MIN_COST} 块）`;
  }
  // api 缺省时只判灵石：宁可让按钮亮着由效果层拒绝，也不要因为算不出上限而误灰
  if (!api) return true;
  const targets = springTargets(
    s,
    u,
    (t) => api.maxHpOf(s, t),
    (t) => api.canBeHealed(s, t),
  );
  return targets.length > 0 ? true : '四邻没有需要救治的友军';
});

registerSkillEffect('spring-surge', (c) => {
  const s = c.state;
  const self = c.self;
  const p = s.players[self.owner];
  const maxOf = (u: Unit) => c.api.maxHpOf(s, u);

  const targets = springTargets(s, self, maxOf, (u) => c.api.canBeHealed(s, u));
  if (targets.length === 0) {
    c.result.ok = false;
    c.result.reason = '四邻没有需要救治的友军';
    return;
  }

  const stones = resOf(p, SPIRIT_STONE);
  if (stones < SPRING_MIN_COST) {
    c.result.ok = false;
    c.result.reason = `灵石不足（泉涌至少要 ${SPRING_MIN_COST} 块）`;
    return;
  }

  // 先算"满额方案"要多少灵石：按**实际**能回的血，不是按 10% 的名义值。
  // 只剩 2 点血的单位名义上该回 10 点，实际只回 2 点，就按 2 点收钱。
  const plans = targets.map((u) => {
    const max = maxOf(u);
    return { u, want: Math.min(springHealAmount(max), max - u.hp) };
  });
  const totalWant = plans.reduce((n, x) => n + x.want, 0);
  const fullCost = springStoneCost(totalWant);

  // 灵石不够：整条降级成"每人 1 点"，照收最低价。不按比例折算是设计——
  // 见文件头，"穷"和"富"必须是两个清楚的状态。
  const floor = stones < fullCost;
  const cost = floor ? SPRING_MIN_COST : fullCost;
  addRes(p, SPIRIT_STONE, -cost);

  let healed = 0;
  for (const { u, want } of plans) {
    if (want <= 0) continue;
    // want 已经按"离满血还差多少"夹过，直接加不会溢出上限
    const amount = floor ? Math.min(SPRING_FLOOR_HEAL, want) : want;
    u.hp += amount;
    healed += amount;
  }

  const def = c.api.utype(s, self.type);
  c.result.log = floor
    ? `${def.name}灵石不足，泉水只渗出一点：${plans.length} 个单位各恢复 ${SPRING_FLOOR_HEAL} 点生命（耗 ${cost} 块灵石）`
    : `${def.name}泉涌：${plans.length} 个单位共恢复 ${healed} 点生命（耗 ${cost} 块灵石）`;
});
