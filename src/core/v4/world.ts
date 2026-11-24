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
 *
 * ── 距离场（BFS）：全项目只有一张，别处一律不许再写 ──────────────
 *
 * 2026-11-24 把原来的四张合成一张了。原来那四张其实是**同一套算法 + 三个开关**：
 *
 *   · 起点几个（1 个 / 一组）
 *   · 每格进入要几步（全部 1 / 按地形）
 *   · 要不要"下一步往哪走"（前驱）
 *
 * 合成后只有 `distanceField(sources, 开关)` 一个入口（`World.field` 是它的门面）。
 * 不同用途只是传不同参数：
 *
 * | 用途 | 起点 | 代价 | 输出 | 前驱 |
 * |---|---|---|---|---|
 * | 城的角色 / 行军回合 | 1 个 | 全部 1 | 回合 | 不要 |
 * | `stepsFrom`（按格计步） | 1 个 | 全部 1 | 步 | 不要 |
 * | 经济选岗（走几步） | 1 座城 | 按兵种（森林 2 / 穿林 1） | 步 | 不要 |
 * | 换空岗（`flowFrom`） | 一组（空岗） | 全部 1 | 步 | **要** |
 * | 让位搬迁（约束层） | 一组（所有空格） | 全部 1 | 步 | **要** |
 *
 * 后两张（多源的）只差**种子**：一个是"该被占的空岗"，一个是"该腾出来的空格"，
 * 方向正好相反，别看混。
 *
 * 只有带前驱的那两张能用来搬人：前驱让整张表变成一棵以起点为根的树，
 * 于是"从根那一头开始，一个接一个往前走一格"永远落在上一人刚腾出来的格上
 * （引擎没有"交换两个人位置"这个动作）。
 */
import { passable } from '../config.ts';
import { effectiveStats, recruitSpawnCells, recruitPriceOf, unitYieldAt, utype } from '../rules.ts';
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

/** 认领表里的一条：某块地、派什么兵、能产多少、走过去要几回合、多少钱 */
export interface EconSpot {
  /** 兵种——**是这块地的属性**（森林→伐木工、丘陵→牧民、平原→农民） */
  type: string;
  x: number;
  y: number;
  /** 站上去每回合产多少金 */
  yield: number;
  /** 从城走过去要几回合（按这个兵种自己的地形消耗和移动力） */
  turns: number;
  /** 造价 */
  gold: number;
  /** 这块地离哪座城近（配岗要按城分组，不然会把 A 城的岗派给 B 城出生的兵） */
  cityId: string;
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
  /**
   * 从 `p` 出发的**真实回合数距离场**（引擎的 BFS，带缓存）。
   *
   * 为什么需要它：`stepToward` 原来按直线距离挑落点，遇到河就全错——
   * 直线距离说"往东一格更近"，可东边是水，得绕桥（S-005 过河 4→1 就是这么掉的）。
   * 引擎本来就算得出真实步数，用它挑落点最省事，也不会再和规则脱节。
   */
  turnsFrom(p: { x: number; y: number }): Float64Array;
  /**
   * 从 `p` 出发的**按格计步**距离场（每格 1 步，仍然绕水/山）。
   *
   * 为什么不能用 `turnsFrom`：那是**回合数**（兵一回合走 2 格），一格范围内的
   * 十几格全是同一个值，`stepToward` 的"更近"就分不出大小，选点变成随机
   * （S-011 实测：全队漂到西北角）。
   */
  stepsFrom(p: { x: number; y: number }): Float64Array;
  /** 城的角色（同一份缓存） */
  roleOf(city: City): CityRole;
  /** 这座城现在能造的最便宜的 N 个战斗兵（含价钱） */
  affordableCombat(city: City, gold: number): Array<{ type: string; gold: number }>;
  /**
   * **所有能派经济兵去的地块**（"认领表"的原料；排哪一块是人/约束层的事）。
   *
   * 一格一条，兵种是**格子的属性**（森林→伐木工、丘陵→牧民、平原→农民），
   * 不再把"造哪种"当自由变量——所以"5 个伐木工抢 2 格森林"这种错误根本表达不出来。
   *
   * 这里只交四个数：产出、走过去要几回合、造价、造价÷产出。**不排序、不筛、不做选择。**
   *
   * ── 为什么不是"每回合挑一个最肥的"（原来 `econPost()` 的写法）──
   *
   * 那样有三个死穴，S-015 全踩了：
   *   ① **在途不算占格**：候选只排除"此刻有人站着"的格，新兵出生在城里、旧兵还在路上，
   *      于是同一格森林连着 4 手都被判成"空闲且最肥"，连续造出 5 个伐木工；
   *   ② **没排除 `keepClear`**：城圈里那 2 格森林永远不许站、也永远不会被占，
   *      伐木工的需求永不饱和（约束层排了 `keep`，服务层没排——两份口径）；
   *   ③ **`≥4 金` 是拍的**：一个魔数代替了"这块地值不值得占"。
   *
   * 认领表把这三件事一起解决：格子只出现一次，谁认领了就算占，口径和约束层同一份。
   *
   * `horizon`：这个决定还剩几手。走过去超过它的格子照样返回（上层可以自己比），
   * 但 `turns` 已经给出，谁要按期限筛都有据可依。
   */
  econSpots(): EconSpot[];
  /**
   * **从一组"洞"出发的距离场**：每格离最近的洞几步，以及"下一步该往哪走"。
   *
   * 洞 = 空出来的岗位（不是所有空格）。穿过自己人算一步（那个人得先让开），
   * 敌人和不可通行挡死。
   *
   * 为什么要它：人挨人的时候，"各自算各自最近的一格"会互相堵死——
   * 两个人的"更近"都指向对方，于是谁也不动。一张共享的场里，洞有明确流向，
   * 整列会像传送带一样依次前挪（这是 v3 `buildYieldPlan` 的思路，代码不抄）。
   */
  flowFrom(holes: number[]): { dist: Float64Array; prev: Int32Array };
  /**
   * 那张唯一距离场的通用入口（上面 A/B/C/D 四张现在都走它）。
   * 见文件顶部的表格：起点几个、代价怎么算、要不要前驱、限多远。
   */
  field(sources: number[], opt?: FieldOpt): { dist: Float64Array; prev: Int32Array };
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
  /**
   * 从 `p` 朝 `toward` 走，**横向能并排站几格**（走廊宽度）。
   *
   * 一侧一格算起，连续可站（可通行、无敌人）才计数；撞到山/水/敌人就停。
   * 桥/窄道上是 1，开阔地能到 5~9。
   *
   * 为什么要有它：同一个"横向展开"，开阔地是对的，窄道是灾难——
   * S-005 在桥上试过展开，过河从 4 掉到 0。宽度是地形的事实，不该由打分层猜。
   */
  corridorWidth(p: { x: number; y: number }, toward: { x: number; y: number }): number;
}

const idx = (s: GameState, x: number, y: number): number => y * s.w + x;

/**
 * **唯一的那张距离场。**（2026-11-24 把原来的四张合成这一张）
 *
 * ── 它是什么 ────────────────────────────────────────────────
 *
 * 给一组起点，算出"地图上每格离最近的起点多远"。
 * 四个开关决定它长成什么样子（原来四张就是这四个开关的不同组合）：
 *
 * | 开关 | 取值 | 原来哪张表用它 |
 * |---|---|---|
 * | `sources` | 1 个 / 一组 | 单源 = 原来的 A / B；一组 = 原来的 C / D |
 * | `perTurn` | 1（输出"步"）/ 兵的移动力（输出"回合"） | 回合 = A；步 = 其余三张 |
 * | `costOf` | 全部 1 / 按地形给（森林 2，穿林 1） | 按地形 = B（选经济岗）；其余全部 1 |
 * | `units` | `ignore`（当没有单位）/ `friendly`（自己人可穿、敌人挡死） | ignore = A/B；friendly = C/D |
 * | `prev` | 不要 / **要**（"下一步往哪走"） | 要 = C/D（要搬人）；不要 = A/B（只问多远） |
 * | `maxDist` | 不限 / 只算 N 步以内 | 不限 = A/B；N = C/D |
 *
 * ── "前驱"（`prev`）是什么 ──────────────────────────────────
 *
 * 每个格记一个"下一步该走到哪个格号"。整张表因此是一棵**以起点为根的树**：
 * 从任意一格顺着它走，一定到得了起点，也不会有环。
 *
 * 用途是**排队**：人多的时候，"每个人自己挑一个更近的格"会互相顶死
 * （我的更近是你、你的更近是我，谁都不动）。有了前驱就变成"链条"：
 * 从根那一头开始，一个接一个往前走一格，每次落点都是上一个人刚腾出来的格。
 * 所以**要搬人就一定要前驱**，只问"多远"才不需要。
 *
 * ── 输出 ────────────────────────────────────────────────────
 *
 * `dist[格号]`：离最近起点的距离（按 `perTurn` 换算后的"步"或"回合"）；走不到是 Infinity。
 * `prev[格号]`：下一步往哪走（格号）；起点自己是 -1，走不到也是 -1。
 *
 * ── 实现上的两个约束 ────────────────────────────────────────
 *
 * ① 边代价只有 1 和 2 两种，所以用三个桶（桶号 = 距离 % 3）一轮一轮扫，
 *    不上堆。桶内**先进先出**（用读指针），这样"同距离时谁的 prev 先写"是确定的——
 *    顺序一变，链条就会变，行为就跟着变（纯重构时这是最要命的一处）。
 * ② 起点是"多源"时，所有起点同时当种子（距离 0）。这不是"从每个起点各跑一遍"，
 *    是"谁都从离自己最近的那个起点算起"。
 */
interface FieldOpt {
  /** 步 → 回合：除以这个数并向上取整。默认 1（输出"步"） */
  perTurn?: number;
  /** 每格的进入代价。默认全部 1 */
  costOf?: (terrain: string) => number;
  /** 单位怎么处理：`ignore` = 当没有（只算地形）；`friendly` = 自己人可穿、敌人挡死 */
  units?: 'ignore' | 'friendly';
  /** 只算这么远，超出的格保持 Infinity */
  maxDist?: number;
  /** 要不要前驱指针（下一步往哪走）。要搬人时必须开 */
  prev?: boolean;
  /** `units: 'friendly'` 时，"自己人"是谁。不给就用当前行动方 */
  ally?: PlayerId;
}

function distanceField(
  s: GameState,
  sources: number[],
  opt: FieldOpt = {},
): { dist: Float64Array; prev: Int32Array } {
  const n = s.w * s.h;
  const dist = new Float64Array(n).fill(Infinity);
  const prev = new Int32Array(n).fill(-1);
  const perTurn = Math.max(1, opt.perTurn ?? 1);
  const costOf = opt.costOf ?? ((): number => 1);
  const units = opt.units ?? 'ignore';
  /* 边代价只有 1 / 2 两种 → 三个桶够用；桶内先进先出，保证 prev 的写入顺序稳定 */
  const K = 3;
  const buckets: number[][] = [[], [], []];
  const head = [0, 0, 0];
  const maxDist = opt.maxDist ?? Infinity;

  /* 播种：所有起点同时当种子 */
  for (const src of sources) {
    if (src < 0 || src >= n) continue;
    if (Number.isFinite(dist[src])) continue;
    dist[src] = 0;
    buckets[0]!.push(src);
  }

  /* d 就是"当前在处理的距离"，从 0 一路往上扫 */
  for (let d = 0; ; d++) {
    let any = false;
    for (let i = 0; i < K; i++) if (head[i]! < buckets[i]!.length) any = true;
    if (!any) break;
    const bi = d % K;
    const bucket = buckets[bi]!;
    while (head[bi]! < bucket.length) {
      const k = bucket[head[bi]++]!;
      if (dist[k] !== d) continue; /* 过期记录：这一格已被更短的路重写过 */
      if (d >= maxDist) continue; /* 只算这么远，再往外不扩 */
      const x = k % s.w;
      const y = (k - x) / s.w;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= s.w || ny >= s.h) continue;
        const nk = ny * s.w + nx;
        if (Number.isFinite(dist[nk])) continue;
        const t = s.tiles[nk]?.terrain;
        if (!t || !passable(t)) continue;
        /* 单位要不要挡路 */
        if (units === 'friendly') {
          const occ = s.units.find((u) => u.y * s.w + u.x === nk);
          const ally = opt.ally ?? s.current;
          if (occ && occ.owner !== ally) continue; /* 敌人挡死；自己人可穿（算一步，他得先让开） */
        }
        const nd = d + costOf(t);
        if (nd < dist[nk]!) {
          dist[nk] = nd;
          prev[nk] = k;
          buckets[nd % K]!.push(nk);
        }
      }
    }
  }

  /* 步 → 回合（走不满一回合也算一回合） */
  if (perTurn !== 1) {
    for (let i = 0; i < n; i++) if (Number.isFinite(dist[i])) dist[i] = Math.ceil(dist[i]! / perTurn);
  }
  return { dist, prev };
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
  /* 敌城出发的"回合场"：城的角色、行军远近都读它 */
  const flipFromFoeCity = foeCities.map(
    (c) => distanceField(s, [c.y * s.w + c.x], { perTurn: foeMove }).dist,
  );

  const marchCache = new Map<string, Float64Array>();
  const marchFrom = (p: { x: number; y: number }): Float64Array => {
    const key = `${p.x},${p.y}`;
    const hit = marchCache.get(key);
    if (hit) return hit;
    const t = distanceField(s, [p.y * s.w + p.x], { perTurn: move }).dist;
    marchCache.set(key, t);
    return t;
  };

  /* 按格计步：和 turnsFrom 同一套 BFS，只是移动力按 1 算 */
  const stepCache = new Map<string, Float64Array>();
  const stepFrom = (p: { x: number; y: number }): Float64Array => {
    const key = `${p.x},${p.y}`;
    const hit = stepCache.get(key);
    if (hit) return hit;
    const t = distanceField(s, [p.y * s.w + p.x], { perTurn: 1 }).dist;
    stepCache.set(key, t);
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
    /*
     * **城格 + 外一圈都保**（2026-11-24 试过只保城格，回退了）。
     *
     * 试的理由：产兵口就是城格本身，外圈挡住的是城边的好地形（S-015 那 2 格森林正好贴着城）。
     * 回退的理由：**外圈是军队出城的通道**——只保城格之后 S-001（必赢题）从"胜"变成"未分胜负"，
     * 兵挤在城墙外，主力出不来。
     *
     * 结论：城边的高产地在这个口径下吃不到。要吃得改地图（把高产地形挪出外圈），
     * 不是改 keepClear。
     */
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

  /* 认领表的原料算一次就够（一场棋里问很多遍），算完缓存 */
  let spotCache: EconSpot[] | null = null;
  /* 距离场按"洞的集合"缓存：同一手会同一条链问很多遍 */
  const flowCache = new Map<string, { dist: Float64Array; prev: Int32Array }>();

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
    turnsFrom(p) {
      return marchFrom(p);
    },
    stepsFrom(p) {
      return stepFrom(p);
    },
    marchTurns(from, to) {
      if (from.x === to.x && from.y === to.y) return 0;
      return marchFrom(from)[idx(s, to.x, to.y)] ?? Infinity;
    },
    roleOf(city) {
      return roleMap.get(city.id) ?? 'safe';
    },
    corridorWidth(p, toward) {
      const dx = Math.sign(toward.x - p.x);
      const dy = Math.sign(toward.y - p.y);
      /* 法向：把"朝目标"的向量转 90° */
      const nx = -dy;
      const ny = dx;
      if (nx === 0 && ny === 0) return 1;
      const walkable = (x: number, y: number): boolean => {
        if (x < 0 || y < 0 || x >= s.w || y >= s.h) return false;
        const t = s.tiles[y * s.w + x]?.terrain;
        if (!t || !passable(t)) return false;
        const occ = s.units.find((u) => u.x === x && u.y === y);
        return !occ || occ.owner === me;
      };
      let w = 1;
      for (const sgn of [1, -1] as const) {
        for (let i = 1; i <= 4; i++) {
          if (!walkable(p.x + nx * sgn * i, p.y + ny * sgn * i)) break;
          w += 1;
        }
      }
      return w;
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

    econSpots() {
      if (spotCache) return spotCache;
      const keep = new Set(keepClear);
      /*
       * 桥口的八邻域也排除（沿用 `bestYieldStep` 的口径）：过道边上也是过道。
       * 只对**桥**成立——城格那一圈不能一起排掉（S-015 那两格可用的森林贴着城墙，
       * 一刀切会把它们也排掉，三个伐木工又只能站平原产 3）。
       */
      const nearBridge = new Set<number>();
      for (const k of keepClear) {
        if (s.tiles[k]?.terrain !== 'bridge') continue;
        const kx = k % s.w;
        const ky = (k - kx) / s.w;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1], [0, 0]] as const) {
          const x = kx + dx;
          const y = ky + dy;
          if (x < 0 || y < 0 || x >= s.w || y >= s.h) continue;
          nearBridge.add(y * s.w + x);
        }
      }

      const out: EconSpot[] = [];
      const seen = new Set<number>();
      for (const city of myCities) {
        const defs = Object.values(s.unitTypes).filter(
          (d) => d.category === 'economy' && (d.era ?? 1) <= (city.era ?? 1),
        );
        if (defs.length === 0) continue;
        /* 每个兵种一张"走过去要几步"的表（穿林 / 移动力都算进去） */
        const walk = new Map<string, Float64Array>();
        for (const d of defs) {
          const forestWalk = (d.abilities ?? []).includes('forest-walk');
          walk.set(
            d.id,
            distanceField(s, [city.y * s.w + city.x], {
              costOf: (t) => (t === 'forest' && !forestWalk ? 2 : 1),
            }).dist,
          );
        }

        for (let k = 0; k < s.w * s.h; k++) {
          if (seen.has(k) || keep.has(k) || nearBridge.has(k)) continue;
          const t = s.tiles[k]?.terrain;
          if (!t || !passable(t)) continue;
          /*
           * **自家经济兵站着的格，仍然算候选。**
           *
           * 全排除会出事：兵一站上自己的岗，那格就从表里消失 → 配对整体错位 →
           * 下一手它被判"没岗"、别人被顶到远处，来回挪（实测 S-015：两个伐木工
           * 在 (4,6)/(4,7) 之间每手互换）。
           * 敌人和平民以外的自家单位（战斗兵）仍然排除——那种格是真的站不上。
           */
          const occ = s.units.find((u) => u.y * s.w + u.x === k);
          if (occ && (occ.owner !== me || utype(s, occ.type).category !== 'economy')) continue;
          const x = k % s.w;
          const y = (k - x) / s.w;

          let best: EconSpot | null = null;
          for (const d of defs) {
            const g = unitYieldAt(s, { type: d.id } as never, x, y).gold ?? 0;
            if (g <= 0) continue;
            const raw = walk.get(d.id)![k]!;
            if (!Number.isFinite(raw)) continue;
            /* 兵种是格子的属性：同一格派几回合产能最高的那个 */
            if (best && g <= best.yield) continue;
            best = {
              type: d.id,
              x,
              y,
              yield: g,
              turns: Math.ceil(raw / Math.max(1, d.move ?? 2)),
              gold: recruitPriceOf(s, me, d).gold,
              cityId: city.id,
            };
          }
          if (best) {
            seen.add(k);
            out.push(best);
          }
        }
      }
      spotCache = out;
      return out;
    },

    flowFrom(holes) {
      /*
       * **从"洞"出发（多源）+ 带前驱** = 原来那张单独的表。
       * 现在只是统一距离场的一种调用：起点一组、自己人可穿、只算 10 步、要前驱。
       *
       * 洞 = **空出来、但应该被占的格**（现在用在"空岗"上）。
       * 注意它不是"所有空格"——那是 `planYield` 的口径，两者种子相反、方向也相反。
       */
      const key = holes.slice().sort((a, b) => a - b).join(',');
      const hit = flowCache.get(key);
      if (hit) return hit;
      const out = world.field(holes, { units: 'friendly', maxDist: 10, prev: true });
      flowCache.set(key, out);
      return out;
    },

    field(sources, opt) {
      return distanceField(s, sources, { ally: me, ...opt });
    },
  };
  return world;
}
