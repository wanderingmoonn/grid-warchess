/**
 * ── 修真扩展包入口（组装车间） ──────────────────────────────
 * 注意：本文件只负责把各个零件拼装成最终的 Expansion 对象。
 * 业务逻辑已经被拆分到了 cultivation/ 目录下，详见 cultivation/README.md。
 * 
 * 架构核心原则：
 * 1. 升级发技能 -> 走 onRankUp 事件广播，绝不反向 import。
 * 2. 技能数据 -> skills.ts；技能执行 -> skill-effects.ts。
 * 3. 如果外部模块 import 本文件报错，请检查底部的 re-export 桥接。
 */

import type { 
  Expansion
 } from './expansions.ts';
import type { 
  GameState,
  Unit,
  SkillDef
} from './types.ts';
import { 
  getRank,onRankUp
} from './cultivation/progression.ts';

import { SKY_STEP_SKILL, getSwordSweepReach } from './cultivation/skills.ts';
import { SPIRIT_CULTIVATOR, CULTIVATOR, SWORD_CULTIVATOR } from './cultivation/units.ts';
import { QI_TRUE_DAMAGE, SPIRIT_ASCENSION } from './cultivation/abilities.ts';

import { CULTIVATION_HOOKS } from './cultivation/hooks.ts';

// 把执行逻辑 import 进来（纯为了触发副作用注册）
import './cultivation/skill-effects.ts';

import { cultivationRank, setCultivationExp } from './cultivation/progression.ts';

/**
 * 让单位学会一个后天技能。如果已经学过，什么都不做。
 * 返回 true 表示这是一次「新学会」，方便调用方写战报。
 */
export function learnSkill(u: Unit, skill: SkillDef): boolean {
  u.extraSkills ??= [];
  if (u.extraSkills.some((k) => k.id === skill.id)) return false;
  u.extraSkills.push(skill);
  return true;
}

/** 境界达到对应等级时自动领悟的技能 */
const CULTIVATOR_SKILL_UNLOCKS: Array<{ rank: number; skill: SkillDef }> = [
  { rank: 2, skill: SKY_STEP_SKILL },
];

/** 检查并领悟所有达标的新技能 */
function checkSkillUnlocks(u: Unit, s: GameState): void {
  for (const { rank, skill } of CULTIVATOR_SKILL_UNLOCKS) {
    if (getRank(u) >= rank) {
      if (learnSkill(u, skill)) {
        s.log.push({
          turn: s.turn,
          player: u.owner,
          text: `${s.unitTypes[u.type]?.name ?? u.type} 领悟了「${skill.name}」`,
          open: true,
        });
      }
    }
  }
}

const CULTIVATOR_ABILITY_UNLOCKS: Array<{ rank: number; abilityId: string; name: string }> = [
  { rank: 4, abilityId: 'spirit-ascension', name: '灵体道果' },
];

/**
 * 检查并挂上所有达标的新能力。
 *
 * 和 `checkSkillUnlocks` 的区别：技能学一次就不再补（`learnSkill` 有幂等），
 * 能力则可能**被清理**——比如灵体重生降级后 `spirit-ascension` 被移除，
 * 如果这个修士之后又修炼回 rank 4，这里要能把它重新挂上。
 * 所以没有"学过就不动"的标记，每次调用都检查 id 是否在 `extraAbilities` 里。
 */
function checkAbilityUnlocks(u: Unit, s: GameState): void {
  u.extraAbilities ??= [];
  for (const { rank, abilityId, name } of CULTIVATOR_ABILITY_UNLOCKS) {
    if (getRank(u) < rank) continue;
    if (u.extraAbilities.includes(abilityId)) continue;
    u.extraAbilities.push(abilityId);
    s.log.push({
      turn: s.turn,
      player: u.owner,
      text: `${s.unitTypes[u.type]?.name ?? u.type} 感悟「${name}」`,
      open: true,
    });
  }
}

onRankUp((u, s) => {
  checkSkillUnlocks(u, s);
  checkAbilityUnlocks(u, s);
});

export const CULTIVATION_PACK: Expansion = {
  id: 'cultivation',
  name: '修真',
  summary: '带来了会修炼成长的各种修士。',
  scale: 'large',  
  hooks: CULTIVATION_HOOKS,
  abilities: [QI_TRUE_DAMAGE, SPIRIT_ASCENSION],
  units: [CULTIVATOR, SWORD_CULTIVATOR, SPIRIT_CULTIVATOR],
};

export { cultivationRank, setCultivationExp, getSwordSweepReach };

export { 
  getAgingYears 
} from './cultivation/progression.ts';