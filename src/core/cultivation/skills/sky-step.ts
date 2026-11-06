/**
 * 御空：在低空与地面之间切换。
 *
 * 这个文件同时装着三样东西，且**只能装这三样**：
 *   1. 数值（解锁门槛）—— 规则书和判定共用；
 *   2. 技能定义（SkillDef）—— 兵种表的数据；
 *   3. 实现（就绪检查 + 效果）—— 模块加载时自注册。
 *
 * ⚠️ 红线：本目录下的技能文件**不许 import `../units.ts`**。
 * `units.ts` 要从这里取 SkillDef，反过来 import 就成环——
 * Node 的 ESM 环是运行时才炸（undefined / TDZ），编译期完全看不出来。
 * 需要的数值常量写在文件自己头上，别去 units 里拿。
 */
import type { GameState, Unit, SkillDef } from '../../types.ts';
import type { AbilityApi } from '../../ability-hooks.ts';
import { registerSkillEffect, registerSkillReadyCheck } from '../../skill-hooks.ts';
import { isCultivatorUnit } from '../identity.ts';
import { getRank } from '../progression.ts';

/** 御空需要的最低境界（规则书里那个"几级解锁"就是它） */
export const SKY_STEP_RANK = 2;
/** 每次切换消耗多少移动力 */
export const SKY_STEP_MOVE_COST = 1;

export const SKY_STEP_SKILL: SkillDef = {
  id: 'sky-step',
  name: '御空',
  summary: `在低空与地面之间切换。消耗 ${SKY_STEP_MOVE_COST} 点移动力，每回合一次（需 ${SKY_STEP_RANK} 级）。`,
  effect: 'sky-step',
  cooldown: 0,
  multiCast: true,
};

function canSkyStep(s: GameState, u: Unit, api: AbilityApi): string | null {
  if (!isCultivatorUnit(s, u)) return '只有修士才能御空';
  if (getRank(u) < SKY_STEP_RANK) return `境界不足（需要 ${SKY_STEP_RANK} 级）`;
  if ((u.custom?.skyStepTurn as number) === s.turn) return '御空每回合只能一次';
  if (api.movePower(s, u) <= 0) return '剩余移动力不足';
  return null;
}

// 就绪检查按 **skill.id** 查（见 rules.ts 的 SKILL_READY_CHECKS[k.id]），
// 不是按 effect 名——两者同名时无所谓，不同名时写错就静默失效。
registerSkillReadyCheck('sky-step', (s, u, api) => canSkyStep(s, u, api!) ?? true);

registerSkillEffect('sky-step', (c) => {
  const why = canSkyStep(c.state, c.self, c.api);
  if (why) { c.result.ok = false; c.result.reason = why; return; }

  const targetAir = !c.api.isAirborne(c.state, c.self);
  const blockers = c.api
    .unitsAt(c.state, c.self.x, c.self.y)
    .filter((u) => u.id !== c.self.id && c.api.isAirborne(c.state, u) === targetAir);
  if (blockers.length > 0) {
    c.result.ok = false;
    c.result.reason = targetAir ? '同一格已有其他空中单位' : '同一格已有其他地面单位';
    return;
  }

  if (targetAir) c.self.layer = 'air';
  else delete c.self.layer;

  c.self.moveSpent = (c.self.moveSpent ?? 0) + SKY_STEP_MOVE_COST;
  c.self.custom = { ...(c.self.custom ?? {}), skyStepTurn: c.state.turn };
  c.result.log = `${c.api.utype(c.state, c.self.type).name} ${targetAir ? '升空' : '落地'}`;
});
