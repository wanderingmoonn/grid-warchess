/**
 * 境界升级自动获得能力。
 *
 * 和 `../skills/unlocks.ts` 是一对：那边给技能（extraSkills），这边给能力
 * （extraAbilities），各自注册自己的 onRankUp。分开放是因为两边的机制层
 * （learnSkill / grantAbility）将来会被不同途径复用（读秘籍 vs 得道果），
 * 混在一个文件里早晚会互相踩到。
 */
import type { GameState, Unit } from '../../types.ts';
import { getRank, onRankUp } from '../progression.ts';
import { SPIRIT_ASCENSION_RANK } from '../identity.ts';

/**
 * 给单位挂上一个能力。已经有的就不动。
 * 返回 true 表示这是一次「新获得」，方便调用方写战报。
 */
export function grantAbility(u: Unit, abilityId: string): boolean {
  u.extraAbilities ??= [];
  if (u.extraAbilities.includes(abilityId)) return false;
  u.extraAbilities.push(abilityId);
  return true;
}

/** 境界达到对应等级时自动获得的能力（导出给规则书用） */
export const CULTIVATOR_ABILITY_UNLOCKS: Array<{ rank: number; abilityId: string; name: string }> = [
  { rank: SPIRIT_ASCENSION_RANK, abilityId: 'spirit-ascension', name: '灵体道果' },
];

/**
 * 检查并挂上所有达标的新能力。
 *
 * 注意：能力可能被 `cleanupAfterRankDrop` 移除（灵体重生跌破门槛），
 * 所以这里用 includes 判断而不是"学过就不动"的标记，以便重新挂上。
 */
function checkAbilityUnlocks(u: Unit, s: GameState): void {
  for (const { rank, abilityId, name } of CULTIVATOR_ABILITY_UNLOCKS) {
    if (getRank(u) < rank) continue;
    if (!grantAbility(u, abilityId)) continue;
    s.log.push({
      turn: s.turn,
      player: u.owner,
      text: `${s.unitTypes[u.type]?.name ?? u.type} 感悟「${name}」`,
      open: true,
    });
  }
}

onRankUp((u, s) => {
  checkAbilityUnlocks(u, s);
});
