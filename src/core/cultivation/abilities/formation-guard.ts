/**
 * 守阵修士的公共查询。
 *
 * 杀伐阵用它决定"半径要不要扩、加成给多少"，封印阵用它决定"额外减速几点"。
 * 抽出来是因为两座阵对"守阵者"的定义必须完全一致——不然会出现
 * "杀伐阵认这个修士、封印阵不认"这种玩家根本看不出来的分歧。
 */
import type { GameState, Unit } from '../../types.ts';
import { distBetweenUnits } from '../../query.ts';
import { isCultivatorUnit } from '../identity.ts';
import { getRank } from '../progression.ts';

/** 守阵需要的距离：四邻（曼哈顿 1 格） */
export const FORMATION_GUARD_RADIUS = 1;

/**
 * 相邻修士里**最高的境界**。没有修士相邻时返回 null。
 *
 * 返回 null 而不是 0 是有意的：0 级修士相邻和"没人相邻"是两回事——
 * 前者会让杀伐阵扩半径（但加成不变），后者不会。用 null 才分得开。
 */
export function bestAdjacentCultivatorRank(s: GameState, self: Unit): number | null {
  let best: number | null = null;
  for (const u of s.units) {
    if (u.id === self.id) continue;
    if (!isCultivatorUnit(s, u)) continue;
    if (distBetweenUnits(s, u, self) > FORMATION_GUARD_RADIUS) continue;
    const rank = getRank(u);
    if (best === null || rank > best) best = rank;
  }
  return best;
}
