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
import { boardIdOf, boardIds, boardKindOf, boardOf, EARTH, idxOn } from './board.ts';
import { visibleMarks } from './marks.ts';
import { cityTiles, idx, isHiddenFrom, visibleTilesOn } from './rules.ts';
import type { BoardId, City, GameState, KnownCity, KnownUnit, PlayerId, Terrain } from './types.ts';

export interface PlayerView {
  /** 可以直接喂给界面的状态：敌方单位已经被裁掉 */
  state: GameState;
  /**
   * **地球**的可见格索引。
   *
   * 历史字段：界面现在只画地球，所以它等于 `visibleByBoard.earth`。
   * 新代码（尤其是"当前显示哪张图"的渲染）应当读 `visibleByBoard`，
   * 不要假设 `visible` 覆盖了所有图。
   */
  visible: number[];
  /** 每张图各自的可见格；地图列表、切图渲染都读它 */
  visibleByBoard: Record<BoardId, number[]>;
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
  /**
   * 每张图各自的"记忆里的地形"。
   *
   * `rememberedTiles` 是它在地球那一份的别名（浓雾扩展目前只作用于地球）。
   */
  rememberedByBoard: Record<BoardId, Map<number, Terrain>>;
  /** 已探索、此刻却看不见的城，值是记忆里的那一份样子（归属、时代、是否废墟） */
  rememberedCities: Map<string, KnownCity>;
  /**
   * 这一局连地形都藏吗？
   *
   * 只有「浓雾蔽野」是 true：基础规则的雾只遮单位，地形全图可见。
   * 界面靠它决定"雾外那一格"该怎么写——是照记忆画地形，还是干脆什么都不说。
   * 别在下游自己摸 `config.expansionIds`：那等于把某个扩展的 id 抄到第三处。
   */
  terrainHidden: boolean;
}

/** 这座城此刻有没有任何一格落在**它自己那张图**的视野里 */
function cityInSight(
  s: GameState,
  city: City,
  visibleSet: ReadonlySet<number>,
  id: BoardId,
): boolean {
  for (const t of cityTiles(city)) {
    if (visibleSet.has(idxOn(s, id, t.x, t.y))) return true;
  }
  return false;
}

/** 一张图上所有格子的索引，观战视角用 */
function allTilesOn(s: GameState, id: BoardId): Set<number> {
  const { w, h } = boardOf(s, id);
  const out = new Set<number>();
  for (let i = 0; i < w * h; i++) out.add(i);
  return out;
}

/**
 * @param reveal 全图视角：双 AI 观战、复盘、调试平衡时用。
 *               它只影响"给谁看"，不影响任何规则计算。
 */
export function playerView(s: GameState, p: PlayerId, reveal = false): PlayerView {
  /*
   * 每张图各算一份可见格。
   *
   * 多图之后这一步不能再只算地球：月球上的侦察兵不该点亮地球，
   * 地球的视野也不该把月球上的敌人漏下来。`visible` 是历史字段，
   * 保留成地球那一份——界面现在只画地球。
   */
  const ids = boardIds(s);
  const visibleByBoard: Record<BoardId, number[]> = {};
  const visibleSets: Record<BoardId, Set<number>> = {};
  for (const id of ids) {
    /*
     * 空间站全可见：站是自己的，虚空只是"还没铺"，不该像未探明地形那样黑着。
     * 而且站就几格大，核心舱视野 4 基本也全罩住了——这条只是把"基本"变成"一定"。
     */
    const set =
      reveal || boardKindOf(s, id) === 'station'
        ? allTilesOn(s, id)
        : visibleTilesOn(s, p, id);
    visibleSets[id] = set;
    visibleByBoard[id] = Array.from(set);
  }
  const visible = visibleByBoard[EARTH] ?? [];
  const earthSet = visibleSets[EARTH] ?? new Set<number>();

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

  // 「浓雾蔽野」连地形一起遮。判断只做这一次，下游（面板、棋子）都读这个字段。
  const terrainHidden = s.fog && !reveal && s.config.expansionIds.includes('blackout');

  /*
   * "设计上不给看"的单位（敌方空间站里的舱段）。
   *
   * 和视野是两回事：外形（甲板铺到哪）是公开的，装了什么只能靠打出来。
   * 所以这条判据要在**两处**同时生效——
   *   · 活单位：一下发就全露了；
   *   · `memory.known` 里的幽灵：不筛的话"曾经看过"会留下一份完整布局，
   *     按 F12 就能读出对面哪一格有炮。
   * 无雾模式也照裁（同理 `redactUnit` 的注释）：这不是"看不见"，是"本来就不该给"。
   */
  const exps = activeExpansions(s);
  const concealed = (u: { type: string; x: number; y: number; board?: BoardId }): boolean => {
    for (const e of exps) {
      if (e.hooks.hideUnit?.({ state: s, unit: u, viewer: p })) return true;
    }
    return false;
  };

  if (!s.fog || reveal) {
    cloned.units = cloned.units.filter((u) => u.owner === p || !concealed(u));
    // 无雾时幽灵表用不上，但 `memory` 是随 state 一起下发的：
    // 留着一份"对面哪一格有炮"的记忆，等于把这条规则废掉
    const own = cloned.memory?.[p];
    if (own) own.known = own.known.filter((k) => !concealed(k));
    return {
      state: cloned,
      visible,
      visibleByBoard,
      ghosts: [],
      rememberedTiles: new Map(),
      rememberedByBoard: {},
      rememberedCities: new Map(),
      terrainHidden: false,
    };
  }

  /*
   * 按**单位所在的那张图**筛。
   *
   * 不能再用一个全局 `visibleSet`：地球的索引 5 和月球图的索引 5 是两回事，
   * 拿错表会把月球上的敌人当成"在地球视野里"直接下发。
   */
  cloned.units = cloned.units.filter((u) => {
    if (u.owner === p) return true;
    if (concealed(u)) return false;
    const id = boardIdOf(u);
    const set = visibleSets[id];
    return !!set && set.has(idxOn(s, id, u.x, u.y)) && !isHiddenFrom(s, u, p);
  });

  /*
   * 格子上留的东西（水雷、地雷……）同样要按"该不该让他知道"裁一遍。
   *
   * 两条边界，别写反：
   *   · 自己布的永远看得见——不然埋完就忘了，等于给自己也埋了；
   *   · 别人布的默认看不见，只有"自己的单位贴到规定距离以内、且那一格在视野里"
   *     才算发现。视野外一律不给（否则按 F12 就是一整张雷区地图）。
   *
   * 目前留痕只在地球，所以这里用地球的可见集；等月球也能布雷再按图分组。
   */
  if (cloned.marks) {
    cloned.marks = visibleMarks(s, p, (i) => earthSet.has(i));
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
      const id = boardIdOf(u);
      const set = visibleSets[id];
      if (!set) continue;
      const i = idxOn(s, id, u.x, u.y);
      if (set.has(i)) continue;
      const tile = boardOf(cloned, id).tiles[i];
      /*
       * 看不见的桥要还原成**原来的地形**，不是一律还原成水。
       *
       * 桥现在也能架在沼泽上（`buildOn: ['water', 'marsh']`），
       * 一律还原成水的话，沼泽上那座桥在迷雾里会凭空变成一条河——
       * 河过不去、沼泽能过（移动力 2），玩家按错的地形做判断。
       * 原地形建桥那一刻记在 `custom.deckFrom` 里；老存档没有这个字段，退回水面。
       */
      if (tile && tile.terrain === 'bridge') {
        const from = u.custom?.deckFrom;
        tile.terrain = from === 'marsh' ? 'marsh' : 'water';
      }
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
  /*
   * 记忆里也要过一遍「整块不给看」。
   *
   * 不筛的话，敌方空间站的舱段会被记成幽灵：它们**永远**不在 `cloned.units`
   * 里，于是每一次刷新都"失踪"，每一帧都画成半透明的影子——既泄露布局，
   * 又让那座站永远在闪烁。直接把它从下发的记忆里删掉，等于"从没看见过"。
   */
  mem.known = mem.known.filter((k) => !concealed(k));
  const ghosts = mem.known.filter((k) => !seenIds.has(k.id));

  /*
   * 浓雾才需要"记忆里的地图"：它连地形和城市一起遮，
   * 走过路过的地方必须留个样子，否则第二次经过等于第一次来。
   *
   * 每张图一份。地球同时回填老的 `rememberedTiles`：那个字段界面还在读，
   * 而且浓雾目前只作用于地球。
   */
  const rememberedByBoard: Record<BoardId, Map<number, Terrain>> = {};
  const rememberedTiles = new Map<number, Terrain>();
  const rememberedCities = new Map<string, KnownCity>();
  if (terrainHidden) {
    for (const id of ids) {
      const map = new Map<number, Terrain>();
      /*
       * 地球这一份要把老的 `mem.tiles` 合并进来：
       * 它已经写进老存档，而且有些测试/工具只往那一份里记。
       * 两份同源时值相同，合并只是让"只有其中一份"的数据都不丢。
       */
      const memTiles =
        id === EARTH
          ? { ...(mem.tilesByBoard?.[EARTH] ?? {}), ...(mem.tiles ?? {}) }
          : (mem.tilesByBoard?.[id] ?? {});
      const set = visibleSets[id] ?? new Set<number>();
      const board = boardOf(cloned, id);
      for (const [key, terrain] of Object.entries(memTiles)) {
        const i = Number(key);
        if (set.has(i)) continue; // 眼前看得见，按活的画
        if (!board.tiles[i]) continue; // 地图缩小过，老记忆越界了
        map.set(i, terrain);
      }
      rememberedByBoard[id] = map;
      if (id === EARTH) for (const [i, terrain] of map) rememberedTiles.set(i, terrain);
    }
    for (const snap of mem.cities ?? []) {
      const city = cloned.cities.find((c) => c.id === snap.id);
      if (!city) continue; // 城已经没了，这份记忆作废
      if (cityInSight(s, city, earthSet, EARTH)) continue; // 眼前看得见，用活的
      rememberedCities.set(snap.id, snap);
    }
  }

  return {
    state: cloned,
    visible,
    visibleByBoard,
    ghosts,
    rememberedTiles,
    rememberedByBoard,
    rememberedCities,
    terrainHidden,
  };
}

/**
 * 把一份视图裁成"只看某一张图"。
 *
 * 渲染层（`ui/board.ts`）是按"一个 state 一张图"写的，一千多行，不值得为了
 * 多图去改它。所以切图时给它一份**替身视图**：宽高、格子、单位、城市都换成
 * 目标图的那一份，其余字段（config / unitTypes / players）原样保留。
 *
 * ⚠️ 地球也一样要裁。以前地球走的是"原样返回"的快路径，于是月球上的兵
 * 跟着 `state.units` 一起被画到地球上（同一个坐标）——实机上看到的就是
 * "月球的兵和月球基地出现在地球"（2026-11-10 第二次反馈）。
 * 只有当所有单位、城市、幽灵本来就在地球上时，这份视图才真的只是地球那一份。
 */
export function viewOnBoard(view: PlayerView, id: BoardId): PlayerView {
  const units = view.state.units.filter((u) => boardIdOf(u) === id);
  const cities = view.state.cities.filter((c) => boardIdOf(c) === id);
  const ghosts = view.ghosts.filter((g) => boardIdOf(g) === id);

  if (
    id === EARTH &&
    units.length === view.state.units.length &&
    cities.length === view.state.cities.length &&
    ghosts.length === view.ghosts.length
  ) {
    return view;
  }

  const b = boardOf(view.state, id);
  return {
    ...view,
    state: {
      ...view.state,
      w: b.w,
      h: b.h,
      tiles: b.tiles,
      units,
      cities,
      // 留痕（水雷、火场）只在地球上，别的图先不给
      marks: id === EARTH ? view.state.marks : [],
    },
    visible: view.visibleByBoard[id] ?? [],
    rememberedTiles: view.rememberedByBoard[id] ?? new Map(),
    ghosts,
  };
}

/**
 * 棋盘视图染色的可见性过滤：有雾就只留看得见的格子。
 *
 * 闸门收在这里而不是各个扩展的 `cells` 里，因为**所有**棋盘视图都走同一条路
 * （天气、灵气、热度……），逐个扩展去记得"我该不该过滤"迟早漏一个。
 *
 * 为什么连"只遮单位"的基础雾也要裁：扩展算的是**全图**的场——温度湿度由地形
 * 推出来，灵气浓度里还掺着对面灵田、灵泉的贡献。整张铺开就等于白送一张敌方
 * 建筑与地形分布图：一座灵田就是一团深绿，"这一片在下雨"就等于说那边不是沙漠。
 * 地形本身在基础雾里是公开的（棋盘上一直画着），但**由地形推出来的场**不是。
 *
 * `visible` 传这一帧 `playerView` 已经算好的那一份：观战 / 复盘拿到的是全图，
 * 所以这里不必再判断"是不是在观战"。
 *
 * 被裁掉的格**不画成灰色**：灰度本身也在说"这里有东西"，留白才是真的一无所知。
 */
export function onlyVisibleCells<T extends { x: number; y: number }>(
  s: GameState,
  visible: readonly number[],
  cells: readonly T[],
  /** `visible` 是哪张图的格号。不传 = 地球（老调用点一个都不用改） */
  board: BoardId = EARTH,
): readonly T[] {
  if (!s.fog) return cells;
  const vis = new Set(visible);
  return cells.filter((c) => vis.has(idxOn(s, board, c.x, c.y)));
}

/** 视野外的格子亮度，用于渲染时压暗。返回 0-1 */
export function tileDim(visibleSet: ReadonlySet<number>, s: GameState, x: number, y: number): number {
  if (!s.fog) return 0;
  return visibleSet.has(idx(s, x, y)) ? 0 : CONFIG.fogDim;
}
