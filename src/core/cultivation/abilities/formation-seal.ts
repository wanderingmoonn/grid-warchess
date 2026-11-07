/**
 * 封印阵：半径 3 内的敌军移动力减半（向下取整）。
 *
 * 减到 0 就真的动不了——这不是 bug，是设计。引擎里 movePower 的"保底 1"
 * 排在光环之前，所以这里的 0 不会被抬回去（见 rules.movePower 的注释）。
 * 一期只封移动，不封攻击和技能；"完全无法操控"留给二期。
 *
 * 光环是静态的（半径和比例都不变），所以直接用 aura 数据，不用 auraDynamic。
 */
import type { AbilityDef } from '../../abilities.ts';
import { bestAdjacentCultivatorRank } from './formation-guard.ts';

export const FORMATION_SEAL_ID = 'formation-seal';
export const FORMATION_SEAL_LABEL = '封印阵';

/** 作用半径 */
export const SEAL_AURA_RADIUS = 3;
/** 移动力**留存**比例：0.5 = 只剩一半 */
export const SEAL_MOVE_PCT = 0.5;

export const FORMATION_SEAL: AbilityDef = {
  id: FORMATION_SEAL_ID,
  name: '封印',
  summary:
    `半径 ${SEAL_AURA_RADIUS} 内敌军移动力减半（向下取整），再由守阵修士的境界扣掉同样多的格数；` +
    `被压到 0 的单位这一回合完全无法行动。`,
  group: 'attack',
  hooks: {
    /*
     * 基础形态：移动力减半。有修士守阵时**再追加一段固定减速**，数值等于
     * 守阵者的境界——0 级修士守着等于没加成（他就是个凡人），境界越高封得越死。
     *
     * 所以 2 移的单位：没人守 → 1 格还能走；1 级修士守 → 1−1=0，被封住。
     * 想封住更快的单位，就得派更高境界的修士去守——这正是"阵要有人守"的意思。
     */
    auraDynamic: ({ state, self }) => {
      const guard = bestAdjacentCultivatorRank(state, self);
      return {
        label: FORMATION_SEAL_LABEL,
        foeMovePct: SEAL_MOVE_PCT,
        foeMoveFlat: guard ?? 0,
        radius: SEAL_AURA_RADIUS,
      };
    },
  },
};
