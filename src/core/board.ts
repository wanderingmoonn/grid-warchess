/**
 * 棋盘（Board）—— 多图玩法的地基。
 *
 * ── 为什么要这一层 ───────────────────────────────────────
 *
 * 这套引擎原本假设"这一局只有一张图"：`s.w / s.h / s.tiles` 是全局的，
 * 所有坐标换算都写成 `y * s.w + x`。太空扩展要同时有地球、月球、
 * 以及若干座由玩家自己长大的空间站，这个假设必须拆掉。
 *
 * 拆法不是把 369 处 `s.w` 一次全改掉（那是一次无法验证的大爆炸），
 * 而是先把"图"变成一个有名字的东西：
 *   · 地球固定叫 `earth`，它的格**仍然**放在 `s.w / s.h / s.tiles` 里；
 *   · 别的图放在 `s.boards[id]`，由扩展在运行时创建（月球、空间站……）；
 *   · 任何"可能不是地球"的坐标计算，都改走本文件的 `boardOf / idxOn / xyOn`。
 *
 * 为什么地球不放进 `boards`：`structuredClone` 会把两份指向同一个数组的
 * 引用克隆成两份独立的副本。`playerView` 每次渲染都要克隆一次 state，
 * 一旦别名分叉，地球的格子就会在两个地方各改各的——这种 bug 极难查。
 * 所以地球保持原样，`boardOf(s, 'earth')` 直接返回 `s` 自己（它天然满足
 * `{ w, h, tiles }`），零拷贝、零别名。
 *
 * ── 迁移契约 ────────────────────────────────────────────
 *
 *   · 只处理地球的代码，可以继续用 `s.w / s.tiles`，不需要改；
 *   · 任何拿到 `Unit`、`City`、`Action` 的代码，先问 `boardIdOf(x)`，
 *     再用 `boardOf(s, id)` 取图——**不要假设它在地球**；
 *   · 默认值只有这里一处（`boardIdOf`），别在业务代码里写 `?? 'earth'`。
 */

import type { BoardId, BoardKind, GameState, Tile } from './types.ts';

/** 地球的 id。所有缺省值都指向它。 */
export const EARTH: BoardId = 'earth';

/** 一张图的最小形状——地球（`GameState`）和 `Board` 都满足它 */
export interface BoardGrid {
  w: number;
  h: number;
  tiles: Tile[];
}

/**
 * 取一张图的格子。
 *
 * 找不到就退回地球：这只可能出现在两种情况下——旧存档（`boards` 是 undefined）
 * 或者扩展写了错的 id。退回地球至少不会崩，而且地球永远存在。
 * 真要严格报错，等有了"删图"的逻辑再说。
 */
export function boardOf(s: GameState, id: BoardId = EARTH): BoardGrid {
  if (id === EARTH) return s;
  return s.boards?.[id] ?? s;
}

/** 这个东西在哪张图上。undefined（旧存档/旧回放/单图玩法）一律算地球。 */
export function boardIdOf(o: { board?: BoardId } | null | undefined): BoardId {
  return o?.board ?? EARTH;
}

/** 这一局一共有哪些图，地球永远排第一（地图列表的顺序也照它） */
export function boardIds(s: GameState): BoardId[] {
  return [EARTH, ...Object.keys(s.boards ?? {})];
}

/** 图的名字：扩展可以给"月球"这种名字，没给就用 id */
export function boardName(s: GameState, id: BoardId): string {
  if (id === EARTH) return '地球';
  return s.boards?.[id]?.name ?? id;
}

/** 图是什么类型：地图列表的图标、"要不要跑气候"都看它 */
export function boardKindOf(s: GameState, id: BoardId): BoardKind {
  if (id === EARTH) return 'planet';
  return s.boards?.[id]?.kind ?? 'planet';
}

/** 这一格里有没有真正的棋盘（用来提前发现"扩展写了不存在的 id"） */
export function hasBoard(s: GameState, id: BoardId): boolean {
  return id === EARTH || !!s.boards?.[id];
}

/*
 * 下面两个是 `query.ts` 的 `idx / xyOf` 的"按图"版本。
 *
 * 保留两套而不是把旧的改签名：地球上的调用点太多，一次全改没法验证。
 * 新代码（尤其是处理非地球单位的路径）一律用这一对。
 */

/** 图内的格坐标 → 这张图里的格索引 */
export function idxOn(s: GameState, id: BoardId, x: number, y: number): number {
  return y * boardOf(s, id).w + x;
}

/** 这张图里的格索引 → 格坐标 */
export function xyOn(s: GameState, id: BoardId, i: number): { x: number; y: number } {
  const w = boardOf(s, id).w;
  return { x: i % w, y: Math.floor(i / w) };
}
