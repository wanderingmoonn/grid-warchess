/**
 * 杀伐阵：按**比例**放大范围内友军的攻击力。
 *
 * 两个状态：
 * · 阵里没有修士守着：半径 2，攻击 ×1.1（也就是 +10%）。
 * · 有修士相邻：半径扩到 4，加成变成 1 + (最高境界 + 1) / 10。
 *   0 级修士相邻时正好还是 1.1（和基础值连续，不会出现"贴个人反而变弱"），
 *   9 级修士相邻时是 2.0。
 *
 * 为什么用"最高境界"而不是"人数"：一堆 0 级修士围上来不该比一个大修士更强，
 * 否则最优解就变成"造一地杂鱼围着"。
 *
 * 为什么这个光环必须现算（auraDynamic）而不是写成静态数据：
 * 半径和加成取决于"此刻谁站在旁边"，而旁边的单位会走动、会升级。
 * 静态数据在兵种定义里，一辈子只有一份。
 */
import type { GameState, Unit } from '../../types.ts';
import type { AbilityDef } from '../../abilities.ts';
import { bestAdjacentCultivatorRank } from './formation-guard.ts';

export const FORMATION_KILL_ID = 'formation-kill';
/** 面板上的来源名。两条重叠时按它合并显示。 */
export const FORMATION_KILL_LABEL = '杀伐阵';

/** 没有修士守阵时的半径 */
export const KILL_AURA_RADIUS = 2;
/** 有修士守阵时的半径 */
export const KILL_AURA_RADIUS_EMPOWERED = 4;
/** 没有修士守阵时的加成（0.1 = +10%） */
export const KILL_AURA_BASE_PCT = 0.1;
/**
 * 有修士守阵时的**加成比例**（不是倍率）：0 级 +10%，9 级 +100%。
 *
 * 注意 `allyAtkPct` 要的是"多加多少"（0.1 = +10%），不是"乘多少"。
 * 这里返回倍率的话会变成 +140%——13 点攻击直接打到 31，写错过一次。
 * 对应的倍率是 `1 + killAuraBonusOf(rank)`。
 */
export function killAuraBonusOf(rank: number): number {
  return (rank + 1) / 10;
}

/** 这个阵法此刻的光环参数（光环本身和面板文案共用同一份） */
export function killAuraParams(
  s: GameState,
  self: Unit,
): { radius: number; pct: number; rank: number | null } {
  const rank = bestAdjacentCultivatorRank(s, self);
  if (rank === null) {
    return { radius: KILL_AURA_RADIUS, pct: KILL_AURA_BASE_PCT, rank: null };
  }
  return { radius: KILL_AURA_RADIUS_EMPOWERED, pct: killAuraBonusOf(rank), rank };
}

export const FORMATION_KILL: AbilityDef = {
  id: FORMATION_KILL_ID,
  name: '杀伐',
  summary:
    `半径 ${KILL_AURA_RADIUS} 内友军攻击 ×${(1 + KILL_AURA_BASE_PCT).toFixed(2)}；` +
    `有修士相邻时改为半径 ${KILL_AURA_RADIUS_EMPOWERED}，加成随守阵修士的境界提高。`,
  group: 'support',
  hooks: {
    auraDynamic: ({ state, self }) => {
      const { radius, pct } = killAuraParams(state, self);
      return { label: FORMATION_KILL_LABEL, allyAtkPct: pct, radius };
    },
  },
};
