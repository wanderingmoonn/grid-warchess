/**
 * 「侦察情报」：某方从远处看到的一小片格子。
 *
 * ── 和 spotlight 的区别 ──────────────────────────────
 *
 * `spotlight` 是**让别人看见我**（发射井冒烟、异象现身），
 * 这里是**我看见别人**（遥感模块从轨道上拍一张地表照片）。
 * 两个方向相反，所以不能共用一张表：共用的话，"点亮"到底是谁看得见
 * 会变成一个只有实现者知道的问题。
 *
 * 情报是**读时算**的：`visibleTilesOn` 每次把情报格并进可见集。
 * 存成格号而不是"区域 + 半径"，是因为它一辈子不会变——
 * 卫星拍下来的就是那 5 格，后面地形变了也不该跟着扩。
 */

import type { BoardId, GameState, PlayerId } from './types.ts';

export interface ReconMark {
  owner: PlayerId;
  board: BoardId;
  /** 谁观测的（同一座遥感模块再观测一次，覆盖上一次，而不是越攒越多） */
  by: string;
  /** 这张图的格号 */
  cells: number[];
  turn: number;
}

export function reconOf(s: GameState): ReconMark[] {
  return s.recon ?? [];
}

/** 记一次观测。同一个 `by` 的旧记录会被替换——站是"重新拍一张"，不是"多拍几张" */
export function setRecon(
  s: GameState,
  owner: PlayerId,
  board: BoardId,
  by: string,
  cells: number[],
): void {
  s.recon = reconOf(s).filter((r) => !(r.owner === owner && r.by === by));
  if (cells.length === 0) return;
  s.recon.push({ owner, board, by, cells: [...new Set(cells)], turn: s.turn });
}

/** 这一方在某张图上靠情报看到的格号 */
export function reconCellsOn(s: GameState, owner: PlayerId, board: BoardId): number[] {
  const out: number[] = [];
  for (const r of reconOf(s)) {
    if (r.owner !== owner || r.board !== board) continue;
    for (const i of r.cells) out.push(i);
  }
  return out;
}
