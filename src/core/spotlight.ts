/**
 * 「点亮一回合」：把某个单位所在的那一格，临时暴露给敌方。
 *
 * ── 为什么要单独一条 ──────────────────────────────────────────────────
 *
 * 引擎里"被看见"只有一条通路：`visibleTilesOn` 算出一组格号，`playerView`
 * 把不在里面的敌方单位整个裁掉。所以"点亮"在架构上只有一个含义：
 * **把那一格塞进敌方的可见集**——只是画一个特效没用，对面手里根本没有那格的数据。
 *
 * 修真的「异象」是第一个用它的（突破时天象外泄）；现在火箭发射井也用它
 * （立在野外、点火时烟柱老远就看得见）。以后"高威胁单位"都可以调 `markSpotlight`，
 * 不必各写一套。
 *
 * ── 时机（和异象保持同一套，别各写一份）──────────────────────────────
 *
 *   · 你**自己的回合**里标记；
 *   · 只在**敌方的回合**里点亮（`s.current !== 观看者` 就不返回）；
 *   · 那个敌方回合结束时清掉——所以是"亮一整个敌方回合"。
 *
 * 这样"我方建好 → 对手下回合看见 → 对手回合结束就熄"，不需要记回合号，
 * 三四人对局里也自然成立（点亮的是"紧接着行动的那一家"）。
 *
 * ── 记坐标，不跟着单位跑 ──────────────────────────────────────────────
 *
 * 跟着兵走等于给对面一整个回合的真视。记坐标则是"痕迹"：你不动就暴露，
 * 挪走了只剩"刚才这儿有东西"。对发射井这种不能动的建筑没差别，
 * 对以后的高威胁单位是必要的分寸。
 */

import { boardIdOf, boardOf } from './board.ts';
import type { BoardId, GameState, PlayerId, Unit } from './types.ts';

/** 点亮的是"标记时那一格" */
export interface SpotlightSpot {
  x: number;
  y: number;
}

/** 这个单位身上有待生效的点亮吗 */
export function spotlightOf(u: Unit): SpotlightSpot | undefined {
  const raw = u.custom?.spotlight as SpotlightSpot | undefined;
  if (!raw) return undefined;
  if (typeof raw.x !== 'number' || typeof raw.y !== 'number') return undefined;
  return raw;
}

/** 记一次点亮（覆盖旧的：连续标记只亮最新那一格） */
export function markSpotlight(u: Unit): void {
  u.custom = { ...(u.custom ?? {}), spotlight: { x: u.x, y: u.y } satisfies SpotlightSpot };
}

/** 手动熄灯（拆掉/取消时用；正常流程靠回合结束清） */
export function clearSpotlight(u: Unit): void {
  if (!spotlightOf(u)) return;
  const next = { ...(u.custom ?? {}) };
  delete next.spotlight;
  u.custom = next;
}

/**
 * 给 `p` 看的、`board` 这张图上的点亮格（格号）。
 *
 * 两条过滤缺一不可：
 *   · 只给**别人的**单位（自己的东西本来就看得见）；
 *   · 只在 `p` **自己的回合**返回——否则 A 回合标完，B 在自己界面上立刻看到，
 *     但 B 那一刻不在行动，看见了也没法反应。
 */
export function spotlightCellsOn(s: GameState, p: PlayerId, board: BoardId): number[] {
  if (s.current !== p) return [];
  const out: number[] = [];
  for (const u of s.units) {
    if (u.owner === p) continue;
    if (boardIdOf(u) !== board) continue;
    const spot = spotlightOf(u);
    if (!spot) continue;
    out.push(spot.y * boardOf(s, board).w + spot.x);
  }
  return out;
}

/**
 * 某一方回合结束时，把**别人的**点亮清掉。
 *
 * 必须是 `u.owner !== endedPlayer`：标记发生在自己回合，自己回合结束就清的话，
 * 那盏灯还没等到敌方回合就被自己掐了。
 */
export function clearSpotlightsOfOthers(s: GameState, endedPlayer: PlayerId): void {
  for (const u of s.units) {
    if (u.owner === endedPlayer) continue;
    clearSpotlight(u);
  }
}
