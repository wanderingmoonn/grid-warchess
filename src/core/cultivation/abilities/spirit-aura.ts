/**
 * 灵气滋养：灵田类单位的光环能力。
 *
 * 语义（2026-11 敲定）：
 * · 半径 1，允许叠加（每块灵田各算各的），摆阵最大化吸收灵气是策略点。
 * · 不区分阵营——灵气不认人，敌方修士站在灵田旁也吃得到（“资敌”是设计）。
 * · 只在灵田主人回合结算一次，避免一块灵田在双方回合各结算一遍。
 * · 只对修士生效（当前只有修士有等级，非修士加经验会出未知问题）。
 *
 * 本文件 Commit 1 只放数据和纯查询；onTurnStart 结算在 Commit 2 接。
 */
import type { GameState, Unit } from '../../types.ts';
import type { AbilityDef } from '../../abilities.ts';
import type { AbilityHooks } from '../../ability-hooks.ts';
import { distBetweenUnits } from '../../query.ts';
import { isCultivatorUnit } from '../identity.ts';
import { TURN_START } from '../../ability-hooks.ts';
import { addExp } from '../progression.ts';

export const SPIRIT_AURA_ID = 'spirit-aura';
export const SPIRIT_AURA_LABEL = '灵气滋养';
export const SPIRIT_AURA_RADIUS = 1;
export const SPIRIT_AURA_EXP = 1;

/** 这个单位身上有没有「灵气滋养」（天赋或后天挂的都算） */
function hasSpiritAura(s: GameState, u: Unit): boolean {
  const def = s.unitTypes[u.type];
  if (def?.abilities?.includes(SPIRIT_AURA_ID)) return true;
  return u.extraAbilities?.includes(SPIRIT_AURA_ID) ?? false;
}

/**
 * 查询：unit 这一轮能从周围灵气滋养里拿到的经验总和（面板与结算共用）。
 *
 * “一轮”指双方各行动一次：每个源只在自己回合 +1，所以一轮总和 = 源数量 × 1。
 * 不分阵营、只认修士；unit 自己不是修士时返回 0。
 */
export function spiritAuraBonusOf(s: GameState, unit: Unit): number {
  if (!isCultivatorUnit(s, unit)) return 0;
  let total = 0;
  for (const src of s.units) {
    if (src.id === unit.id) continue;
    if (!hasSpiritAura(s, src)) continue;
    if (distBetweenUnits(s, src, unit) > SPIRIT_AURA_RADIUS) continue;
    total += SPIRIT_AURA_EXP;
  }
  return total;
}

export const SPIRIT_AURA: AbilityDef = {
  id: SPIRIT_AURA_ID,
  name: SPIRIT_AURA_LABEL,
  summary: `回合开始时，半径 ${SPIRIT_AURA_RADIUS} 格内的修士获得 ${SPIRIT_AURA_EXP} 点修为经验（不分阵营，可叠加）。`,
  group: 'support',
  hooks: {
    onTurnStart: [
      {
        stage: TURN_START.aura,
        apply: (c) => {
          const def = c.api.utype(c.state, c.self.type);
          let count = 0;
          for (const t of c.state.units) {
            if (t.id === c.self.id) continue;
            if (!isCultivatorUnit(c.state, t)) continue;
            if (distBetweenUnits(c.state, t, c.self) > SPIRIT_AURA_RADIUS) continue;
            addExp(t, c.state, SPIRIT_AURA_EXP);
            count += 1;
          }
          if (count > 0) {
            c.api.pushLog(c.state, c.owner, `${def.name} 滋养了 ${count} 名修士`, false);
          }
        },
      },
    ],
  } satisfies AbilityHooks,
};