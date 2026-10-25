/**
 * 视图过滤层。
 *
 * 这是整个架构里最关键的十个字：**不是自己的东西不下发**。
 *
 * 只要客户端拿到的 state 里含有视野外敌方单位的位置，
 * 玩家按 F12 打开控制台就能全看见，联机就是裸奔。
 * 所以 UI 永远只渲染 playerView() 的产物，不直接碰 fullState。
 *
 * 现在跑在本地，等上服务端时，把这个函数搬到后端即可，
 * 上层规则和界面一行都不用改。
 */

import { CONFIG } from './config.ts';
import { idx, isHiddenFrom, visibleTilesOf } from './rules.ts';
import type { GameState, KnownUnit, PlayerId } from './types.ts';

export interface PlayerView {
  /** 可以直接喂给界面的状态：敌方单位已经被裁掉 */
  state: GameState;
  /** 当前可见格索引，给渲染做明暗用 */
  visible: number[];
  /** 记忆中但当前看不见的敌方单位，渲染成半透明幽灵 */
  ghosts: KnownUnit[];
}

/** 棋盘上所有格子的索引，观战视角用 */
function allTiles(s: GameState): Set<number> {
  const out = new Set<number>();
  for (let i = 0; i < s.w * s.h; i++) out.add(i);
  return out;
}

/**
 * @param reveal 全图视角：双 AI 观战、复盘、调试平衡时用。
 *               它只影响"给谁看"，不影响任何规则计算。
 */
export function playerView(s: GameState, p: PlayerId, reveal = false): PlayerView {
  const visibleSet = reveal ? allTiles(s) : visibleTilesOf(s, p);
  const visible = Array.from(visibleSet);
  const cloned = structuredClone(s);

  if (!s.fog || reveal) {
    return { state: cloned, visible, ghosts: [] };
  }

  cloned.units = cloned.units.filter(
    (u) => u.owner === p || (visibleSet.has(idx(s, u.x, u.y)) && !isHiddenFrom(s, u, p)),
  );

  const seenIds = new Set(cloned.units.map((u) => u.id));
  const ghosts = cloned.memory[p].known.filter((k) => !seenIds.has(k.id));

  return { state: cloned, visible, ghosts };
}

/** 视野外的格子亮度，用于渲染时压暗。返回 0-1 */
export function tileDim(visibleSet: ReadonlySet<number>, s: GameState, x: number, y: number): number {
  if (!s.fog) return 0;
  return visibleSet.has(idx(s, x, y)) ? 0 : CONFIG.fogDim;
}
