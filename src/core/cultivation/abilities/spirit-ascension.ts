import type { AbilityDef } from '../../abilities.ts';
import {
  isCultivatorUnit,
  isSoulMasterType,
  isSpirit,
  SPIRIT_ASCENSION_RANK,
  UNIT_IDS,
} from '../identity.ts';
import { getRank, isDoomed, REALMS } from '../progression.ts';

/** 化灵时保留原境界生命加成的比例 */
export const SPIRIT_HP_BONUS_KEEP = 0.3;

export const SPIRIT_ASCENSION: AbilityDef = {
  id: 'spirit-ascension',
  name: '灵体道果',
  summary: `境界达到 ${REALMS[SPIRIT_ASCENSION_RANK]}期（${SPIRIT_ASCENSION_RANK} 级）时，肉身死亡会化作灵体，可主动重生。`,
  group: 'defense',
  hooks: {
    onDeath: (c) => {
      const { state, victim, api } = c;
      if (!isCultivatorUnit(state, victim)) return;
      if (isSpirit(victim)) return;// 灵体死了就真死
      if (victim.custom?.spiritForm === true) return;
      if (isDoomed(victim)) return;// 老死 → 真死
      if (getRank(victim) < SPIRIT_ASCENSION_RANK) return;
      const spiritDef = state.unitTypes[UNIT_IDS.SPIRIT];
      if (!spiritDef) return;

      // 落脚点：原地优先，若 air 层同格冲突则找相邻空格
      let x = victim.x, y = victim.y;
      if (!api.canStandAt(state, x, y, UNIT_IDS.SPIRIT)) {
        const spot = api.freeNeighbor(state, victim, UNIT_IDS.SPIRIT);
        if (!spot) return;// 无处落脚，真死
        x = spot.x; y = spot.y;
      }

      const originMaxHpBonus = victim.maxHpBonus ?? 0;
      const originType = victim.type;
      const originName = state.unitTypes[originType]?.name ?? originType;
      const rankNow = getRank(victim);

      /*
       * 魂修是这条规则里唯一的例外，而且只有两处：
       *
       *   1. **生命加成不折减**。普通修士的肉身没了，境界堆出来的血跟着散掉
       *      七成；魂修本来就是"以魂证道"，肉身只是壳——壳碎了，修为还在。
       *   2. **学过的技能全带过去**。普通修士只留标了「魂法」的（`soulBound`），
       *      其余随肉身一起散了；魂修的全部留在魂里。
       *
       * 这两处**不是**另写一套加成，只是不走那条削弱分支——真正的"战斗力
       * 不下降"在 `stats.ts` 的 `isWeakenedSpirit` 里，那里查的是同一张
       * `SOUL_MASTER_IDS`。三处必须保持同一个判据，所以都走 `isSoulMasterType`。
       */
      const soulMaster = isSoulMasterType(originType);

      // 暂存与过滤
      const savedExtraSkills = victim.extraSkills ?? [];
      const savedExtraAbilities = victim.extraAbilities ?? [];
      const soulBound = savedExtraSkills.filter((k) => k.custom?.soulBound === true);
      const otherAbilities = savedExtraAbilities.filter((id) => id !== 'spirit-ascension');

      victim.custom = {
        ...(victim.custom ?? {}),
        spiritForm: true,
        originType,
        savedExtraSkills,
        savedExtraAbilities,
        originMaxHpBonus,
      };
      victim.type = UNIT_IDS.SPIRIT;
      victim.x = x; victim.y = y;
      victim.maxHpBonus = soulMaster
        ? originMaxHpBonus
        : Math.floor(originMaxHpBonus * SPIRIT_HP_BONUS_KEEP);
      victim.hp = 1 + victim.maxHpBonus;
      victim.moved = true;
      victim.acted = true;
      victim.status = {};
      delete victim.heroBuff;
      delete victim.countersLeft;
      victim.extraSkills = soulMaster ? savedExtraSkills : soulBound;
      victim.extraAbilities = otherAbilities;

      state.units.push(victim);
      api.pushLog(state, victim.owner,
        soulMaster
          ? `${originName} 肉身崩碎，元神凝而不散（境界 ${REALMS[rankNow]} 期，技能与修为俱在）`
          : `${originName} 肉身崩碎，化作灵体（境界 ${REALMS[rankNow]} 期）`, true);
    },
  },
};