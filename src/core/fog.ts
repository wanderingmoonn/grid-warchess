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
import { cityTiles, idx, isHiddenFrom, visibleTilesOf } from './rules.ts';
import type { City, GameState, KnownCity, KnownUnit, PlayerId, Terrain } from './types.ts';

export interface PlayerView {
  /** 可以直接喂给界面的状态：敌方单位已经被裁掉 */
  state: GameState;
  /** 当前可见格索引，给渲染做明暗用 */
  visible: number[];
  /** 记忆中但当前看不见的敌方单位，渲染成半透明幽灵 */
  ghosts: KnownUnit[];
  /**
   * 已探索、此刻却看不见的格，值是记忆里的地形。
   *
   * 只有「浓雾蔽野」会有内容：基础规则的雾不遮地图，这份表永远是空的。
   * 界面要照它画"记忆里的地形"，不能直接读 state.tiles —— 那是活数据，
   * 对面趁夜在河上架了座桥，我们不该立刻知道。
   */
  rememberedTiles: Map<number, Terrain>;
  /** 已探索、此刻却看不见的城，值是记忆里的那一份样子（归属、时代、是否废墟） */
  rememberedCities: Map<string, KnownCity>;
}

/** 这座城此刻有没有任何一格落在视野里 */
function cityInSight(s: GameState, city: City, visibleSet: ReadonlySet<number>): boolean {
  for (const t of cityTiles(city)) {
    if (visibleSet.has(idx(s, t.x, t.y))) return true;
  }
  return false;
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
    return {
      state: cloned,
      visible,
      ghosts: [],
      rememberedTiles: new Map(),
      rememberedCities: new Map(),
    };
  }

  cloned.units = cloned.units.filter(
    (u) => u.owner === p || (visibleSet.has(idx(s, u.x, u.y)) && !isHiddenFrom(s, u, p)),
  );

  const seenIds = new Set(cloned.units.map((u) => u.id));
  const mem = cloned.memory[p];
  const ghosts = mem.known.filter((k) => !seenIds.has(k.id));

  // 浓雾才需要"记忆里的地图"：它连地形和城市一起遮，
  // 走过路过的地方必须留个样子，否则第二次经过等于第一次来。
  const rememberedTiles = new Map<number, Terrain>();
  const rememberedCities = new Map<string, KnownCity>();
  if (s.config.expansionIds.includes('blackout')) {
    for (const [key, terrain] of Object.entries(mem.tiles ?? {})) {
      const i = Number(key);
      if (visibleSet.has(i)) continue; // 眼前看得见，按活的画
      if (!cloned.tiles[i]) continue; // 地图缩小过，老记忆越界了
      rememberedTiles.set(i, terrain);
    }
    for (const snap of mem.cities ?? []) {
      const city = cloned.cities.find((c) => c.id === snap.id);
      if (!city) continue; // 城已经没了，这份记忆作废
      if (cityInSight(s, city, visibleSet)) continue; // 眼前看得见，用活的
      rememberedCities.set(snap.id, snap);
    }
  }

  return { state: cloned, visible, ghosts, rememberedTiles, rememberedCities };
}

/** 视野外的格子亮度，用于渲染时压暗。返回 0-1 */
export function tileDim(visibleSet: ReadonlySet<number>, s: GameState, x: number, y: number): number {
  if (!s.fog) return 0;
  return visibleSet.has(idx(s, x, y)) ? 0 : CONFIG.fogDim;
}
