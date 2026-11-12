/**
 * 星图面板要显示的两组行：**相连** 与 **在途**。
 *
 * 只做纯数据，不碰 DOM——`main.ts` 负责拼 HTML。抽出来的理由和
 * `ui/board-scope.ts` 一样：面板是"看一眼就该对"的东西，但它的错
 * （节点名取错、在途显示 -1 回合）只会在实机里被玩家发现。
 *
 * 数据来源是星图本身，不是"图有几个"：
 *   · `lanes` 说明哪些节点相连、各要几回合（太空里没有封锁，见 `StarLane`）；
 *   · `trips` 说明天上现在有什么、还有几回合落地，**双方都看得见**。
 */

import { nodeName, peekStarmap } from '../core/space/starmap.ts';
import { laneTurnsFor } from '../core/space/transit.ts';
import type { GameState, PlayerId } from '../core/types.ts';

export interface StarLaneRow {
  a: string;
  b: string;
  turns: number;
}

export interface StarTripRow {
  owner: string;
  /** 玩家名（默认"红方/蓝方"）；面板上要能分清是谁的火箭 */
  who: string;
  to: string;
  left: number;
}

export function starRows(
  state: GameState,
  /** 谁在看：航程按他的速度算（推进器） */
  viewer: PlayerId = state.current,
): { lanes: StarLaneRow[]; trips: StarTripRow[] } {
  const lanes = (peekStarmap(state)?.lanes ?? []).map((l) => ({
    a: nodeName(state, l.a),
    b: nodeName(state, l.b),
    turns: laneTurnsFor(state, viewer, l),
  }));
  const trips = (state.transit ?? []).map((t) => ({
    owner: t.owner,
    who: state.players[t.owner]?.name ?? t.owner,
    to: nodeName(state, t.to),
    // 到达的那一回合会是 0：显示「0」比显示「-1」诚实
    left: Math.max(0, Math.round(t.left)),
  }));
  return { lanes, trips };
}

/** 这一局有没有值得画的东西（没有就让整块不占位） */
export function hasStarRows(r: { lanes: StarLaneRow[]; trips: StarTripRow[] }): boolean {
  return r.lanes.length > 0 || r.trips.length > 0;
}
