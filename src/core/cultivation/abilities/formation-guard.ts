/**
 * 守阵修士的公共查询。
 *
 * 杀伐阵用它决定"半径要不要扩、加成给多少"，封印阵用它决定"额外减速几点"，
 * 守御阵用它决定"吸谁的血"。抽出来是因为三座阵对"守阵者"的定义必须完全一致——
 * 不然会出现"杀伐阵认这个修士、封印阵不认"这种玩家根本看不出来的分歧。
 */
import type { GameState, Unit } from '../../types.ts';
import { distBetweenUnits } from '../../query.ts';
import { isCultivatorUnit } from '../identity.ts';
import { getRank } from '../progression.ts';

/** 守阵需要的距离：四邻（曼哈顿 1 格） */
export const FORMATION_GUARD_RADIUS = 1;

/**
 * 相邻修士里**境界最高的那个**。没有修士相邻时返回 null。
 *
 * 返回 null 而不是一个"0 级修士"，是因为这两件事不同：0 级修士相邻会让杀伐阵
 * 扩半径（但加成不变），而"没人相邻"不会。
 *
 * 只认**自家**修士：阵是自己人摆的，敌方修士路过不该替你守阵，
 * 更不该被守御阵抽血。三座阵共用这一条判据，所以只需写一次。
 *
 * 同境界时按 **血量多者优先、再看 id 字典序** 取一个。这不是随便定的：
 * 守御阵拿它当血包，血多的更经得起吸；而 id 兜底是为了让结果**确定**——
 * 联机对局里两家各自遍历 `s.units`，如果顺序不同，同一帧算出来的守阵者不一样，
 * 就会当场不同步。
 */
export function bestAdjacentCultivator(s: GameState, self: Unit): Unit | null {
  let best: Unit | null = null;
  let bestRank = -1;
  for (const u of s.units) {
    if (u.id === self.id || u.owner !== self.owner) continue;
    if (!isCultivatorUnit(s, u)) continue;
    if (distBetweenUnits(s, u, self) > FORMATION_GUARD_RADIUS) continue;
    const rank = getRank(u);
    if (
      !best ||
      rank > bestRank ||
      (rank === bestRank && (u.hp > best.hp || (u.hp === best.hp && u.id < best.id)))
    ) {
      best = u;
      bestRank = rank;
    }
  }
  return best;
}

/**
 * 相邻修士里**最高的境界**。没有修士相邻时返回 null。
 *
 * 杀伐阵和封印阵只需要那个数字，用这个就够了；它们不关心具体是谁。
 */
export function bestAdjacentCultivatorRank(s: GameState, self: Unit): number | null {
  const who = bestAdjacentCultivator(s, self);
  return who ? getRank(who) : null;
}
