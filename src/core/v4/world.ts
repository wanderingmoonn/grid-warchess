/**
 * v4 的**服务层**（阶段 1a）。
 *
 * ── 这一层存在的理由 ────────────────────────────────────────
 *
 * v3 的三个翻车点都长在这一层：
 *   · 城的角色有三个口径（谁算"前线"、谁算"受威胁"各算一遍，结果对不上）；
 *   · `canReach` 被三处共享，谁改一处三处一起变；
 *   · 每个模块自己算一张距离图，同一格在两个模块里能算出不同的回合数。
 *
 * 所以 v4 的规矩是：**这些东西只在这里算一次，别处只许读。**
 * 任何人想再写一张 BFS，都是 bug（不是"优化"，是 bug）。
 *
 * ── 为什么它好验收 ──────────────────────────────────────────
 *
 * 它输出的是**数**（几回合、几个兵、哪一格），不是**选择**。数可以和引擎真值对拍，
 * 选择只能看结果。所以它单独成关（`scripts/probe-v4-world.ts`）。
 *
 * ── 不许做的事 ──────────────────────────────────────────────
 *
 * 这里**不许有"该不该打"的判断**。那属于决定层。这里只回答"到那儿要几回合"。
 */
import { passable } from '../config.ts';
import { effectiveStats, recruitSpawnCells, recruitPriceOf, utype } from '../rules.ts';
import type { City, GameState, PlayerId, Unit } from '../types.ts';

/** 一座城在这一局里的角色——**只有这一个口径** */
export type CityRole =
  /** 自家最后一座城：丢了就输 */
  | 'home'
  /** 离敌人近、且敌人有兵能到：要守 */
  | 'threatened'
  /** 离敌人近但我方有兵压着：可以往前推的跳板 */
  | 'front'
  /** 离敌人远：产兵的地方 */
  | 'safe';

export interface CityInfo {
  city: City;
  role: CityRole;
  /** 到最近的敌城 / 敌军，占几回合（走不到 = Infinity） */
  distToFoeCity: number;
  distToFoeArmy: number;
  /** 我的战斗单位里，几回合内能赶到这座城的（守军潜力） */
  defenders: number;
}

export interface World {
  me: PlayerId;
  foe: PlayerId;
  w: number;
  h: number;
  cities: CityInfo[];
  myCities: City[];
  foeCities: City[];
  /** 战斗 / 经济单位，按"离敌人由近到远"排好序（上层不用再排） */
  myCombat: Unit[];
  myEcon: Unit[];
  foeCombat: Unit[];
  /** 这几格必须空出来（产兵格 + 城门口），约束层会读它 */
  keepClear: number[];
  /** 从某格到某格要走几回合；走不到 = Infinity */
  marchTurns(from: { x: number; y: number }, to: { x: number; y: number }): number;
  /** 城的角色（同一份缓存） */
  roleOf(city: City): CityRole;
  /** 这座城现在能造的最便宜的 N 个战斗兵（含价钱） */
  affordableCombat(city: City, gold: number): Array<{ type: string; gold: number }>;
  /**
   * 这一格会不会被敌方战斗单位"够到"。
   *
   * 口径是 **贴脸**：敌人一步就能走到邻格开火（`移动 + 1`）。
   *
   * 这中间试错过两次，都记在这里：
   *   ① 抄 v3 的 `2 × 移动 + 射程-1`（算"两回合内"）→ 大半个图都是危险区，
   *      经济兵全天逃命，S-006 总产 27 → 9；
   *   ② 改成 `移动 + 射程`（这一手能开火）→ 敌人还在 5 格外就开始跑，总产 47 → 29。
   *
   * 教训：**经济兵不做战略判断**。它只躲"贴脸"的，远处的威胁是守军/决定层的事；
   * 让最便宜的一类单位去算全局威胁，代价就是把产出全丢掉。
   */
  harassed(p: { x: number; y: number }): boolean;
}

const idx = (s: GameState, x: number, y: number): number => y * s.w + x;

/**
 * 一张地形图上的"到各格要几回合"。
 *
 * 为什么用**回合**而不是格数：一格森林走两回合、一格平原走一回合，
 * 拿格数当距离会把"贴着一片林子走"算得比"绕开"还近。
 *
 * 代价：每次算都是 O(格子数)，所以只在 `buildWorld` 里对少数几个源点算，
 * 算完缓存在 World 上——上层要问就查表，不许自己再跑。
 */
function flipBfs(s: GameState, src: { x: number; y: number }, move: number): Float64Array {
  const n = s.w * s.h;
  const dist = new Float64Array(n).fill(Infinity);
  const start = idx(s, src.x, src.y);
  if (start < 0 || start >= n) return dist;
  dist[start] = 0;
  const q: number[] = [start];
  for (let head = 0; head < q.length; head++) {
    const cur = q[head]!;
    const cx = cur % s.w;
    const cy = Math.floor(cur / s.w);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= s.w || ny >= s.h) continue;
      const ni = idx(s, nx, ny);
      if (!Number.isFinite(dist[ni])) {
        /* 水和高山走不了。桥面是 passable（它本来就是路）。 */
        const t = s.tiles[ni]?.terrain;
        if (!t || !passable(t)) continue;
        /* 一格 = 一"步"，一步能走 `move` 格。这里按层推进，所以每次 +1 回合。 */
        dist[ni] = dist[cur]! + 1;
        q.push(ni);
      }
    }
  }
  /* BFS 出来的是"格数/步"，除以移动力才是回合（向上取整，因为走不满也算一回合） */
  for (let i = 0; i < n; i++) if (Number.isFinite(dist[i])) dist[i] = Math.ceil(dist[i]! / Math.max(1, move));
  return dist;
}

/** 这一局里最快的兵有多快（用最慢的当基准反而更保守，这里取众数附近的 2） */
function baseMove(s: GameState, me: PlayerId): number {
  const moves = s.units.filter((u) => u.owner === me && utype(s, u.type).category === 'combat')
    .map((u) => effectiveStats(s, u).move);
  if (moves.length === 0) return 2;
  moves.sort((a, b) => a - b);
  return Math.max(1, moves[Math.floor(moves.length / 2)] ?? 2);
}

const near = (a: { x: number; y: number }, b: { x: number; y: number }, r: number): boolean =>
  Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)) <= r;

/**
 * 建一份 World。
 *
 * 一次 `aiNextAction` 建一次就够——它是只读的，别在循环里反复建（那等于把缓存关掉）。
 */
export function buildWorld(s: GameState, me: PlayerId): World {
  const seats = [...new Set(s.units.map((u) => u.owner))];
  const foe = (seats.find((p) => p !== me) ?? (me === 'A' ? 'B' : 'A')) as PlayerId;
  const myCities = s.cities.filter((c) => c.owner === me);
  const foeCities = s.cities.filter((c) => c.owner === foe);
  const myCombat = s.units.filter((u) => u.owner === me && utype(s, u.type).category === 'combat');
  const myEcon = s.units.filter((u) => u.owner === me && utype(s, u.type).category === 'economy');
  const foeCombat = s.units.filter((u) => u.owner === foe && utype(s, u.type).category === 'combat');

  const move = baseMove(s, me);
  const foeMove = (() => {
    const ms = foeCombat.map((u) => effectiveStats(s, u).move).sort((a, b) => a - b);
    return Math.max(1, ms[Math.floor(ms.length / 2)] ?? 2);
  })();

  /* 从每座敌城出发算一张"回合图"，城角色和行军都用它 —— 一场棋里敌城不多，值得算 */
  const flipFromFoeCity = foeCities.map((c) => flipBfs(s, { x: c.x, y: c.y }, foeMove));

  const marchCache = new Map<string, Float64Array>();
  const marchFrom = (p: { x: number; y: number }): Float64Array => {
    const key = `${p.x},${p.y}`;
    const hit = marchCache.get(key);
    if (hit) return hit;
    const t = flipBfs(s, p, move);
    marchCache.set(key, t);
    return t;
  };

  const distToNearestFoeCity = (p: { x: number; y: number }): number => {
    let best = Infinity;
    for (const d of flipFromFoeCity) best = Math.min(best, d[idx(s, p.x, p.y)] ?? Infinity);
    return best;
  };

  const cities: CityInfo[] = myCities.map((city) => {
    const dFoeCity = distToNearestFoeCity({ x: city.x, y: city.y });
    const dFoeArmy = foeCombat.length === 0
      ? Infinity
      : Math.min(...foeCombat.map((u) => Math.max(0, Math.ceil(Math.hypot(u.x - city.x, u.y - city.y)))));
    const defenders = myCombat.filter((u) => near(u, city, 6)).length;
    /* 角色判定：只有这一处口径。别处想问"这座城算前线吗"，一律调 roleOf。 */
    let role: CityRole;
    if (myCities.length === 1) role = 'home';
    else if (dFoeCity <= 6) role = defenders >= 3 ? 'front' : 'threatened';
    else role = 'safe';
    return { city, role, distToFoeCity: dFoeCity, distToFoeArmy: dFoeArmy, defenders };
  });

  const roleMap = new Map(cities.map((c) => [c.city.id, c.role]));

  /*
   * 产兵格 = **城周围那一圈**（几何算），不用 `recruitSpawnCells`。
   *
   * 这里踩过一个死循环：`recruitSpawnCells` 只返回**空着的**落点，
   * 所以"兵把产兵格占满"这个状态它返回空数组——于是一个关键格都找不到，
   * 也就没人被要求让开，永远造不出兵（S-009：守住之后 3 个回合 0 造兵，金 190 花不出去）。
   *
   * 关键格的定义不能依赖"现在有没有空位"，否则它会在最需要工作的时刻失效。
   */
  const keepClear: number[] = [];
  for (const city of myCities) {
    const n = city.size ?? 2;
    for (let dy = -1; dy <= n; dy++) {
      for (let dx = -1; dx <= n; dx++) {
        /*
         * **城格也算**（2026-11-24 修正）。
         *
         * 一开始我把城格排除了，理由是"新兵本来就生在城里"。错：
         * 兵站在城格里，产兵口就被堵住——`recruitSpawnCells` 直接返回 0
         * （S-009：守军退回城下之后金 190 一分都花不出去）。
         * v3 的 `spawn` 类关键格也是把"被占的城格"算进去的。
         *
         * 新兵出生在城格上这件事，靠 ai-v4 里"本回合动过的单位跳过"来兜（不会反复派让开）。
         */
        const x = city.x + dx;
        const y = city.y + dy;
        if (x < 0 || y < 0 || x >= s.w || y >= s.h) continue;
        const t = s.tiles[y * s.w + x]?.terrain;
        if (!t || !passable(t)) continue;
        keepClear.push(y * s.w + x);
      }
    }
  }

  /*
   * 桥头：邻格有 ≥2 片水的桥面格 = 过河的唯一通道，停在那儿就是把全军的门堵死（S-005）。
   */
  for (let y = 0; y < s.h; y++) {
    for (let x = 0; x < s.w; x++) {
      if (s.tiles[y * s.w + x]?.terrain !== 'bridge') continue;
      let water = 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const t = s.tiles[(y + dy) * s.w + (x + dx)]?.terrain;
        if (t === 'water' || t === 'deep') water += 1;
      }
      if (water >= 2) keepClear.push(y * s.w + x);
    }
  }

  /* 每个敌方战斗单位的"威胁半径"，只算一次（贴脸：移动 + 1，见 harassed 的注释） */
  const foeReach = foeCombat.map((u) => Math.max(1, effectiveStats(s, u).move ?? 2) + 1);

  const world: World = {
    me,
    foe,
    w: s.w,
    h: s.h,
    cities,
    myCities,
    foeCities,
    myCombat: [...myCombat].sort(
      (a, b) => (foeCities.length ? distToNearestFoeCity(a) - distToNearestFoeCity(b) : 0),
    ),
    myEcon,
    foeCombat,
    keepClear: [...new Set(keepClear)],
    marchTurns(from, to) {
      if (from.x === to.x && from.y === to.y) return 0;
      return marchFrom(from)[idx(s, to.x, to.y)] ?? Infinity;
    },
    roleOf(city) {
      return roleMap.get(city.id) ?? 'safe';
    },
    harassed(p) {
      return foeCombat.some((u, i) => Math.max(Math.abs(u.x - p.x), Math.abs(u.y - p.y)) <= foeReach[i]!);
    },
    affordableCombat(city, gold) {
      const out: Array<{ type: string; gold: number }> = [];
      for (const def of Object.values(s.unitTypes)) {
        if (def.category !== 'combat') continue;
        if ((def.era ?? 1) > (city.era ?? 1)) continue;
        if (recruitSpawnCells(s, city.id, undefined, def.id).length === 0) continue;
        const price = recruitPriceOf(s, me, def).gold;
        if (price <= gold) out.push({ type: def.id, gold: price });
      }
      return out.sort((a, b) => a.gold - b.gold);
    },
  };
  return world;
}
