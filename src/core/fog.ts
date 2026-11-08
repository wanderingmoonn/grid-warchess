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
import { activeExpansions } from './expansions.ts';
import { visibleMarks } from './marks.ts';
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

  /*
   * 隐藏信息：有些"底牌"和视野无关，是设计上就不给对面看的。
   *
   * 修真包的丹药是第一个用户——对手能看见你身上的 buff（药力藏不住），
   * 但数不出你兜里还有几颗（那是底牌）。这一步必须放在"按雾筛单位"之前：
   * 无雾模式下也照裁，因为这不是"看不见"，是"本来就不该给"。
   *
   * 观战（reveal）不裁：复盘和双 AI 观战要看全。
   */
  if (!reveal) {
    const exps = activeExpansions(s);
    for (const u of cloned.units) {
      if (u.owner === p) continue;
      for (const e of exps) e.hooks.redactUnit?.({ state: s, unit: u, viewer: p });
    }
  }

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

  /*
   * 格子上留的东西（水雷、地雷……）同样要按"该不该让他知道"裁一遍。
   *
   * 两条边界，别写反：
   *   · 自己布的永远看得见——不然埋完就忘了，等于给自己也埋了；
   *   · 别人布的默认看不见，只有"自己的单位贴到规定距离以内、且那一格在视野里"
   *     才算发现。视野外一律不给（否则按 F12 就是一整张雷区地图）。
   */
  if (cloned.marks) {
    cloned.marks = visibleMarks(s, p, (i) => visibleSet.has(i));
  }

  /*
   * 桥是"修出来的地形"，跟着视野走。
   *
   * 地形本身是公开的（基础规则的雾只遮单位），但桥不是地形，是人盖的东西：
   * 对面趁夜在下游架了一座桥，第二天这边就多出一条过河的路——这件事没有理由
   * 凭空可见。所以凡是有桥单位站着的桥面、又不在自己视野里，一律按水面画。
   *
   * 两条边界：
   *   · 自己修的桥一直知道自己修了，不遮；
   *   · 地图自带的路桥（固定地图里的 `=`）下面没有桥单位，照常当普通地形显示。
   */
  if (!reveal) {
    for (const u of s.units) {
      if (!s.unitTypes[u.type]?.bridges) continue;
      if (u.owner === p) continue;
      const i = idx(s, u.x, u.y);
      if (visibleSet.has(i)) continue;
      const tile = cloned.tiles[i];
      // 桥只能架在水面上（见 buildSiteError 的 buildOn），看不见就退回水面
      if (tile && tile.terrain === 'bridge') tile.terrain = 'water';
    }
  }

  // 战况烈度账本只留自己的那一份。
  //
  // 对方的账本里记着"他的哪些格子挨了打"——那等于把他部队的位置和交火点
  // 直接送给对手。视图层的老规矩：不是自己的东西不下发。
  if (cloned.heat) {
    for (const key of Object.keys(cloned.heat)) {
      if (key !== p) delete cloned.heat[key];
    }
  }

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
