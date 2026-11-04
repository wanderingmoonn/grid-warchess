// 境界升级自动解锁技能 / 能力。
// 机制层（learnSkill）将来可被"读秘籍""拜师"等途径复用；
// 触发源层（onRankUp 注册）是"升级"这一种途径的实现。

import type { GameState, Unit, SkillDef } from '../types.ts';
import { getRank, onRankUp } from './progression.ts';
import { SKY_STEP_SKILL } from './skills.ts';

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
 * 注意：能力可能被 cleanupAfterRankDrop 移除（灵体重生降级），
 * 所以这里用 includes 判断而不是"学过就不动"标记，以便重新挂上。
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