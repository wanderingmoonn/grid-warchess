/**
 * 重生：灵体消耗一次行动，重塑肉身。
 *
 * ⚠️ 红线：本文件不许 import `../units.ts`（原因见 sky-step.ts 顶部）。
 */
import type { SkillDef } from '../../types.ts';
import { registerSkillEffect, registerSkillReadyCheck } from '../../skill-hooks.ts';
import { isSpirit } from '../identity.ts';
import {
  getRank,
  expForRank,
  getMaxHp,
  totalHpBonusForRank,
  cleanupAfterRankDrop,
  REALMS,
} from '../progression.ts';

// ── 数值 ──────────────────────────────────────────
/** 重生要跌几个境界 */
export const SPIRIT_REBIRTH_RANK_DROP = 1;
/** 重生后修为按"那一境的门槛"的多少分之一算 */
export const SPIRIT_REBIRTH_EXP_DIV = 2;
/** 重生后恢复多少比例的最大生命 */
export const SPIRIT_REBIRTH_HP_RATIO = 0.1;

// ── 数据 ──────────────────────────────────────────
export const SPIRIT_REBIRTH_SKILL: SkillDef = {
  id: 'spirit-rebirth',
  name: '重生',
  summary:
    `重塑肉身：修为按 1/${SPIRIT_REBIRTH_EXP_DIV} 重算并强制降 ${SPIRIT_REBIRTH_RANK_DROP} 境，` +
    `恢复 ${Math.round(SPIRIT_REBIRTH_HP_RATIO * 100)}% 最大生命。`,
  effect: 'spirit-rebirth',
  cooldown: 0,
  multiCast: false,
};

// ── 实现 ──────────────────────────────────────────
registerSkillReadyCheck('spirit-rebirth', (_s, u) => {
  if (!isSpirit(u)) return '只有灵体能重生';
  if (!u.custom?.originType) return '本源已散失，无法重生';
  return true;
});

registerSkillEffect('spirit-rebirth', (c) => {
  const { self, state } = c;
  if (!isSpirit(self)) {
    c.result.ok = false;
    c.result.reason = '只有灵体能重生';
    return;
  }
  const originType = self.custom?.originType as string | undefined;
  if (!originType) {
    c.result.ok = false;
    c.result.reason = '本源已散失，无法重生';
    return;
  }

  // 此时 TS 已经知道 originType 是 string
  const originDef = state.unitTypes[originType];
  if (!originDef) {
    c.result.ok = false;
    c.result.reason = '本源已散失，无法重生';
    return;
  }

  const oldRank = getRank(self);
  const newRank = Math.max(0, oldRank - SPIRIT_REBIRTH_RANK_DROP);
  // 新经验：原 "x-1 升 x 门槛" 的一半（绝对量）
  const newExp = Math.floor(expForRank(newRank) / SPIRIT_REBIRTH_EXP_DIV);

  // 合并技能（saved ∪ current，按 id 去重）
  const savedExtraSkills = (self.custom?.savedExtraSkills as SkillDef[]) ?? [];
  const currentExtraSkills = self.extraSkills ?? [];
  const mergedExtraSkills = [...savedExtraSkills];
  for (const k of currentExtraSkills) {
    if (!mergedExtraSkills.some((m) => m.id === k.id)) mergedExtraSkills.push(k);
  }
  // 合并能力
  const savedExtraAbilities = (self.custom?.savedExtraAbilities as string[]) ?? [];
  const currentExtraAbilities = self.extraAbilities ?? [];
  const mergedExtraAbilities = [...savedExtraAbilities];
  for (const id of currentExtraAbilities) {
    if (!mergedExtraAbilities.includes(id)) mergedExtraAbilities.push(id);
  }

  // 清 custom 上的灵体暂存字段，保留 rank / lifespan / exp
  const cachedLifespan = self.custom?.lifespan;
  self.custom = { rank: newRank, exp: newExp };
  if (typeof cachedLifespan === 'number') (self.custom as any).lifespan = cachedLifespan;

  self.type = originType;
  self.extraSkills = mergedExtraSkills;
  self.extraAbilities = mergedExtraAbilities;
  // maxHpBonus 按降级后 rank 重算（当前包内唯一来源是升级，安全）。
  // 用"累计值"而不是"逐级作差"：这样和升级路径（addExp 走 maxHpDeltaBetween）
  // 读的是同一个数，重生再练回来不会多出或少掉几点。
  self.maxHpBonus = totalHpBonusForRank(newRank);

  // 血量按比例恢复
  self.hp = Math.max(1, Math.ceil(getMaxHp(state, self) * SPIRIT_REBIRTH_HP_RATIO));
  // 行动状态：本回合不能再行动
  self.moved = true;
  self.acted = true;
  // 清技能状态
  delete self.skillCd;
  delete self.skillCharge;
  delete self.skillTurn;

  // 降级清理（跌破道果门槛时移除 spirit-ascension）
  cleanupAfterRankDrop(self, newRank);

  c.result.log = `${originDef.name} 从灵体重塑肉身（降为 ${REALMS[newRank]} 期，恢复 ${self.hp} 点生命）`;
});
