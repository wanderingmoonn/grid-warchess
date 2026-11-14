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
 * ── P0 之后 ──────────────────────────────────────────
 *
 * 它和掌心雷共用 `spell-kernel.ts`：校验、扣灵力、瞄准高亮都是骨架给的，
 * 这个文件只剩"圈人 → 挨个打 → 报总数"。族 2（范围伤害）立起来时，
 * 焱、垚、鑫、淼、森都会变成同一行的复制品。
 *
 * ⚠️ 红线：本文件不许 import `../units.ts`（见 sky-step.ts 顶部）。
 */
import { registerSkillEffect } from '../../skill-hooks.ts';
import { getRank } from '../progression.ts';
import {
  defineSpellSkill,
  registerManaReady,
  registerPreview,
  resolveCast,
  strikeAll,
  type SpellRow,
} from '../spell-kernel.ts';

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
const ROW: SpellRow = {
  id: 'gang-wind',
  name: '罡风',
  summary:
    `射程 ${GANG_WIND_RANGE} 格，对落点半径 ${GANG_WIND_RADIUS} 格内**所有**敌人造成 ` +
    `${GANG_WIND_BASE} + 境界×${GANG_WIND_PER_RANK} 点伤害（无视护甲）；耗 ${GANG_WIND_COST} 灵力。`,
  effect: 'gang-wind',
  cost: GANG_WIND_COST,
  range: GANG_WIND_RANGE,
  // 范围法术亮"这一下会罩住谁"，所以画在落点周围
  preview: 'blast',
  radius: GANG_WIND_RADIUS,
  /*
   * 高亮按**曼哈顿距离**取格子：能打到的才画。
   *
   * 这里原来是方框，四个斜角会被点亮却打不到（实际命中用 `distToUnit`，
   * 对 1×1 单位就是曼哈顿距离）。那不是"宽一点的提示"，是骗玩家：
   * 站位时按亮出来的范围数人头，会多算进两个根本不会被扫到的人。
   * 2026-11-14 按作者口径改成和命中一致，`SpellRow.blastShape` 这个过渡字段一并删掉。
   */
  // 和掌心雷一样：节拍交给灵力池，不额外限每回合一次
  multiCast: true,
};

export const GANG_WIND_SKILL = defineSpellSkill(ROW);

registerManaReady([ROW]);
registerPreview([ROW]);

// ── 实现 ──────────────────────────────────────────
registerSkillEffect('gang-wind', (c) => {
  const s = c.state;

  const cast = resolveCast(c, {
    cost: GANG_WIND_COST,
    range: GANG_WIND_RANGE,
    mode: 'area',
    radius: GANG_WIND_RADIUS,
    noTargetReason: () => '选一个落点',
    // 先圈人再扣灵力：空放一发不该白花 80 点
    emptyReason: () => '那里没有敌人',
    tooFarReason: () => `太远了（罡风射程 ${GANG_WIND_RANGE} 格）`,
  });
  if (!cast.ok) {
    c.result.ok = false;
    c.result.reason = cast.reason;
    return;
  }

  const name = c.api.utype(s, c.self.type).name;
  const dmg = gangWindDamage(getRank(c.self));

  // `victims` 是 filter 出来的新数组，killUnit 改的是 s.units，边遍历边删是安全的
  const { total, killed } = strikeAll(c, cast.victims, dmg, {
    hurt: (victim) =>
      `${name}的罡风扫过，${c.api.utype(s, victim.type).name} 受到 ${dmg} 点伤害`,
    kill: (victim) => `${c.api.utype(s, victim.type).name}被罡风撕碎`,
  });

  c.api.noteHeat(s, cast.point.x, cast.point.y);
  c.result.log =
    `${name}施放罡风，命中 ${cast.victims.length} 名敌人，共造成 ${total} 点伤害` +
    (killed > 0 ? `，${killed} 名当场殒命` : '') +
    `（耗 ${GANG_WIND_COST} 灵力）`;
});
