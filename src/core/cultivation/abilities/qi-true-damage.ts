import type { AbilityDef } from '../../abilities';
import { isCultivatorUnit } from '../identity.ts';
import { DAMAGE_STAGE } from '../../ability-hooks.ts';
import { trueDamageOf, trueDamageWithMods } from '../stats.ts';

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
          // 光环比例由规则层注入（`c.trueDamagePct`）：这个文件在初始化链上游，
          // 自己 import auras 会把 ability-registry 提前拉起来、遍历未初始化的 EXPANSIONS。
          const trueDmg = trueDamageWithMods(trueDamageOf(c.self), (c.trueDamagePct ?? 0));
          if (trueDmg > 0) c.damage += trueDmg;
        },
      },
    ],
  },
};