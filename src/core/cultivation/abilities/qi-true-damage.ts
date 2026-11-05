import type { AbilityDef } from '../../abilities';
import { isCultivatorUnit } from '../identity.ts';
import { DAMAGE_STAGE } from '../../ability-hooks.ts';
import { trueDamageOf } from '../stats.ts';

// 真元：真实伤害
export const QI_TRUE_DAMAGE: AbilityDef = {
  id: 'qi-true-damage',
  name: '真元',
  summary: '每次攻击附带随境界提升的、无视护甲的真实伤害。',
  group: 'attack',
  hooks: {
    damage: [
      {
        stage: DAMAGE_STAGE.trueDamage,
        apply: (c) => {
          if (c.side !== 'attacker') return;
          if (!isCultivatorUnit(c.state, c.self)) return;
          const trueDmg = trueDamageOf(c.self);
          if (trueDmg > 0) c.damage += trueDmg;
        },
      },
    ],
  },
};