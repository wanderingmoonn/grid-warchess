/**
 * 释放灵气：散灵台（建筑）的充能技能。
 *
 * 注意这是**建筑技能**，不是修士天赋——它和天/地/人那套境界无关，
 * 只是恰好共用同一套技能框架（奇想包的英雄技能演化来的）。
 *
 * 两个 id 为什么不一样：`tower-charge` 是技能 id（冷却/存档按它记），
 * `spirit-tower-shot` 是效果 id（注册在 SKILL_EFFECTS 上）。历史原因，
 * 已经写进存档，别改。
 *
 * ⚠️ 红线：本文件不许 import `../units.ts`（原因见 sky-step.ts 顶部）。
 * 这里的两个常量就是给 `units.ts` 反向取用的。
 */
import type { SkillDef } from '../../types.ts';
import { registerSkillEffect, registerSkillReadyCheck } from '../../skill-hooks.ts';
import { resOf, addRes } from '../../resources.ts';
import { SPIRIT_STONE } from '../resources.ts';

// ── 数值 ──────────────────────────────────────────
/** 一次充能给几次攻击次数 */
export const TOWER_BURST_CHARGES = 3;
/** 每次充能耗多少灵石 */
export const TOWER_CHARGE_COST = 5;

// ── 数据 ──────────────────────────────────────────
export const TOWER_CHARGE_SKILL: SkillDef = {
  id: 'tower-charge',
  name: '释放灵气',
  summary: `充能：本回合获得 ${TOWER_BURST_CHARGES} 次攻击次数，消耗 ${TOWER_CHARGE_COST} 灵石`,
  effect: 'spirit-tower-shot',
  cooldown: 0,
  multiCast: false, // 一回合只能开一次
};

// ── 实现 ──────────────────────────────────────────
// 就绪检查按 **skill.id** 查（rules.ts 的 SKILL_READY_CHECKS[k.id]），
// 所以这里必须是 'tower-charge'，不是 effect 名。写成后者会静默失效：
// 0 灵石时按钮照样是亮的，点下去才报错。
registerSkillReadyCheck('tower-charge', (s, u) => {
  const p = s.players[u.owner];
  if (resOf(p, SPIRIT_STONE) < TOWER_CHARGE_COST) {
    return `灵石不足（需要 ${TOWER_CHARGE_COST} 灵石）`;
  }
  return true;
});

registerSkillEffect('spirit-tower-shot', (c) => {
  const p = c.state.players[c.self.owner];
  if (resOf(p, SPIRIT_STONE) < TOWER_CHARGE_COST) {
    c.result.ok = false;
    c.result.reason = `需要 ${TOWER_CHARGE_COST} 灵石才能释放灵气`;
    return;
  }

  addRes(p, SPIRIT_STONE, -TOWER_CHARGE_COST);

  // 存"灵气充能层数"：hooks.ts 的 modifyAttacks 读它当攻击次数，
  // 下一回合开始时清掉（实际开火发生在对手回合开始，见 fireBuildings）。
  c.self.custom = { ...(c.self.custom ?? {}), burstCharges: TOWER_BURST_CHARGES };

  const name = c.api.utype(c.state, c.self.type).name;
  c.result.log = `${name} 消耗 ${TOWER_CHARGE_COST} 灵石，灵气激荡，本回合获得 ${TOWER_BURST_CHARGES} 次攻击次数`;
});
