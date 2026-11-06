/**
 * 境界升级自动领悟技能。
 *
 * 机制层（`learnSkill`）将来可被"读秘籍""拜师"等途径复用；
 * 触发源层（`onRankUp` 注册）是"升级"这一种途径的实现。
 *
 * 能力解锁在 `../abilities/unlocks.ts`，两边对称、各自注册自己的 onRankUp——
 * 塞进同一个文件就会回到"一个文件两套触发表、改一处忘一处"。
 */
import type { GameState, Unit, SkillDef } from '../../types.ts';
import { getRank, onRankUp } from '../progression.ts';
import { SKY_STEP_SKILL, SKY_STEP_RANK } from './sky-step.ts';

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

/**
 * 境界达到对应等级时自动领悟的技能。
 *
 * 导出是为了让规则书那张"各境界对照表"的「特殊能力」一列直接从这张表生成——
 * 以前手册里的"2 级解锁御空"是手打的，改了门槛就两边不一致。
 */
export const CULTIVATOR_SKILL_UNLOCKS: Array<{ rank: number; skill: SkillDef }> = [
  { rank: SKY_STEP_RANK, skill: SKY_STEP_SKILL },
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

onRankUp((u, s) => {
  checkSkillUnlocks(u, s);
});
