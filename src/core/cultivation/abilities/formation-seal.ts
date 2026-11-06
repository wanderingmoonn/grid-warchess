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
    `半径 ${SEAL_AURA_RADIUS} 内敌军移动力减半（向下取整）；` +
    `原本只有 1 格移动力的单位会被完全封住。`,
  group: 'attack',
  hooks: {
    aura: {
      label: FORMATION_SEAL_LABEL,
      foeMovePct: SEAL_MOVE_PCT,
      radius: SEAL_AURA_RADIUS,
    },
  },
};
