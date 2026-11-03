// 能力

import type { AbilityDef } from '../abilities.ts';
import { DAMAGE_STAGE } from '../ability-hooks.ts';
import { isCultivatorUnit } from './identity.ts';
import { getRank, isDoomed, REALMS } from './progression.ts';
import { trueDamageOf } from './stats.ts';

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

export const SPIRIT_ASCENSION: AbilityDef = {
  id: 'spirit-ascension',
  name: '灵体道果',
  summary: '境界达到炼气期（≥ 4 级）时，肉身死亡会化作灵体，可主动重生。',
  group: 'defense',
  hooks: {
    onDeath: (c) => {
      const { state, victim, api } = c;
      if (!isCultivatorUnit(state, victim)) return;
      if (victim.type === 'cultivator-spirit') return;// 灵体死了就真死
      if (victim.custom?.spiritForm === true) return;
      if (isDoomed(victim)) return;// 老死 → 真死
      if (getRank(victim) < 4) return;
      const spiritDef = state.unitTypes['cultivator-spirit'];
      if (!spiritDef) return;

      // 落脚点：原地优先，若 air 层同格冲突则找相邻空格
      let x = victim.x, y = victim.y;
      if (!api.canStandAt(state, x, y, 'cultivator-spirit')) {
        const spot = api.freeNeighbor(state, victim, 'cultivator-spirit');
        if (!spot) return;// 无处落脚，真死
        x = spot.x; y = spot.y;
      }

      // 暂存与过滤
      const savedExtraSkills = victim.extraSkills ?? [];
      const savedExtraAbilities = victim.extraAbilities ?? [];
      const soulBound = savedExtraSkills.filter((k) => k.custom?.soulBound === true);
      const otherAbilities = savedExtraAbilities.filter((id) => id !== 'spirit-ascension');

      const originMaxHpBonus = victim.maxHpBonus ?? 0;
      const originType = victim.type;
      const originName = state.unitTypes[originType]?.name ?? originType;
      const rankNow = getRank(victim);

      victim.custom = {
        ...(victim.custom ?? {}),
        spiritForm: true,
        originType,
        savedExtraSkills,
        savedExtraAbilities,
        originMaxHpBonus,
      };
      victim.type = 'cultivator-spirit';
      victim.x = x; victim.y = y;
      victim.maxHpBonus = Math.floor(originMaxHpBonus * 0.3);
      victim.hp = 1 + victim.maxHpBonus;
      victim.moved = true;
      victim.acted = true;
      victim.status = {};
      delete victim.heroBuff;
      delete victim.countersLeft;
      victim.extraSkills = soulBound;
      victim.extraAbilities = otherAbilities;

      state.units.push(victim);
      api.pushLog(state, victim.owner,
        `${originName} 肉身崩碎，化作灵体（境界 ${REALMS[rankNow]} 期）`, true);
    },
  },
};