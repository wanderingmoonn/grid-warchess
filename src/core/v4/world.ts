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
 * ── 距离场（BFS）一览：全项目只有这四个，别处一律不许再写 ──────────
 *
 * "距离场" = 一张和地图同样大的表，每格存一个数（离某个起点多远）。
 * 它们最容易出错的地方是**同一个名字在四处指的不是一回事**，所以先在这里点名：
 *
 * | 编号 | 名字 | 从哪出发 | 算出来的数 | 谁在用 |
 * |---|---|---|---|---|
 * | A | `flipBfs` | 一个点 | **几回合**（格数 ÷ 移动力，向上取整） | `turnsFrom` / `marchTurns` / 城的角色 |
 * | B | `walkDist` | 一座城 | **走几步**（按兵种的地形代价：森林 2 步，有"穿林"的 1 步） | `econSpots`（认领表） |
 * | C | `flowFrom` | **一组"洞"（多源）** | 离最近那个洞几步 + **"下一步该往哪走"** | 约束层"进不去就换空岗" |
 * | D | `planYield` 里的那张 | **所有空格（多源）** | 同上（几步 + 前驱） | 约束层"让位搬迁"（把人从关键格上挪开） |
 *
 * 注意 A/B 只给"多远"，C/D 还给"往哪走"（前驱指针）。看行为问题时先分清是哪一个：
 * A/B 用错 = 选错了地方；C/D 用错 = 走的方向错、或者整队不动。
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
 * **【距离场 A】单源、按"回合"算的距离场。**
 *
 * ── 它回答什么 ──────────────────────────────────────────────
 *
 * "从这一个点出发，到地图上每一格要花几个回合"。走不到（水、高山）是 Infinity。
 *
 * ── 逐段在做什么 ────────────────────────────────────────────
 *
 * ① 初始化：把全表填成 Infinity（= 还没走到），起点写 0。
 *
 * ② 扩散：**一层一层往外推**（标准 BFS）。队列 `q` 里放的是"已经知道距离、还没往外看"的格。
 *    `head` 是读指针、只往前走（不 `shift`，因为数组头部删除是 O(n)）。
 *    每格只看上下左右四邻（这个游戏是四邻移动，斜走要两步）。
 *
 * ③ 判"这一格要不要更新"：用的是 `!Number.isFinite(dist[ni])`，
 *    也就是"第一次走到它就定了"。这一步之所以成立，是因为**所有边代价都是 1**——
 *    层数越小的先出队，所以第一次到达一定是最短的。这也是为什么它不能直接拿来算
 *    "森林要走两步"（见 ④ 的取舍）。
 *
 * ④ 水/高山直接 `continue`：它们不是"远"，是"根本过不去"，保持 Infinity。
 *    桥面是 `passable`（它本来就是路），所以能过。
 *
 * ⑤ 收尾：BFS 存的是**格数**，这里统一除以移动力、向上取整，换成**回合**。
 *    向上取整是因为"这一手只走 1 格、还剩 1 格没走完"也算用掉了这一回合。
 *
 * ── 已知的取舍（别指望它算准）────────────────────────────────
 *
 * 它把森林的额外消耗**拍平**了（森林和草地在它眼里一样，都是 1 格）。
 * 真要按地形代价算，得用下面的 `walkDist`（距离场 B），或者换成真正的
 * Dijkstra。现在的口径是"够用就行"，等它开始让选点出错再换。
 *
 * 每次调用是 O(格子数)，所以只在 `buildWorld` 里对少数几个源点算，算完缓存在 World 上。
 */
function flipBfs(s: GameState, src: { x: number; y: number }, move: number): Float64Array {
  const n = s.w * s.h;
  const dist = new Float64Array(n).fill(Infinity);
  const start = idx(s, src.x, src.y);
  if (start < 0 || start >= n) return dist;
  /* ① 起点 */
  dist[start] = 0;
  const q: number[] = [start];
  /* ② 逐层扩散 */
  for (let head = 0; head < q.length; head++) {
    const cur = q[head]!;
    const cx = cur % s.w;
    const cy = Math.floor(cur / s.w);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= s.w || ny >= s.h) continue;
      const ni = idx(s, nx, ny);
      /* ③ 第一次走到就定下来（所有边代价都是 1，所以先到即最短） */
      if (!Number.isFinite(dist[ni])) {
        /* ④ 水和高山走不了。桥面是 passable（它本来就是路）。 */
        const t = s.tiles[ni]?.terrain;
        if (!t || !passable(t)) continue;
        dist[ni] = dist[cur]! + 1;
        q.push(ni);
      }
    }
  }
  /* ⑤ 格数 → 回合 */
  for (let i = 0; i < n; i++) if (Number.isFinite(dist[i])) dist[i] = Math.ceil(dist[i]! / Math.max(1, move));
  return dist;
}

/**
 * **【距离场 B】单源、按"这个兵种自己的地形代价"算的距离场（单位是"步"）。**
 *
 * ── 它和距离场 A 的差别 ──────────────────────────────────────
 *
 * A 把地形拍平（森林 = 草地 = 1 格），B 按兵种算：
 *   森林对普通兵是 **2 步**，对带"穿林"的兵（伐木工）是 **1 步**。
 *
 * 为什么非要这个差别：经济兵的价值全在脚下那一格。伐木工进林只花一步、
 * 牧民进林要花两步，用 A 的口径这两个会算成一样远，选岗就会把牧民也往林子里派。
 *
 * ── 为什么用"三个桶"而不是普通队列 ──────────────────────────
 *
 * 普通 BFS 只对"所有边代价相同"成立。这里的边代价是 1 或 2，如果还用普通队列，
 * 会出现"先到的其实是贵的路"这种错。
 * 但代价只有 1 和 2 两种，所以不用上堆：开 3 个桶，按距离 d 一轮一轮扫，
 * 桶编号 = d % 3，`dist[k] !== d` 那一句是"这条记录过期了，丢掉"
 * （同一格可能被更短的路重新写过一次）。
 *
 * ── 输出怎么读 ──────────────────────────────────────────────
 *
 * `dist[格号]` = 从起点走到那格要**几步**（不是回合）。要回合再除以这个兵的移动力。
 * 走不到是 Infinity。`econSpots` 就是拿它算"走过去几回合"的。
 *
 * ── 已知局限 ────────────────────────────────────────────────
 *
 * 只算地形，**不算人**。有兵站在路上时，它照样认为"能过去、就这么远"——
 * 所以它适合拿来"选哪块地"，不适合拿来判断"这一手走不走得动"。
 */
function walkDist(s: GameState, from: { x: number; y: number }, def: { abilities?: string[] }): Float64Array {
  const n = s.w * s.h;
  const dist = new Float64Array(n).fill(Infinity);
  const start = from.y * s.w + from.x;
  if (start < 0 || start >= n) return dist;
  dist[start] = 0;
  /* 代价只有 1 和 2 → 3 个桶就够（桶号 = 距离 % 3） */
  const K = 3;
  const q: number[][] = [[], [], []];
  q[0]!.push(start);
  /* d 就是"当前在处理的距离"，从 0 一路往上扫 */
  for (let d = 0; ; d++) {
    if (q[0]!.length === 0 && q[1]!.length === 0 && q[2]!.length === 0) break;
    const bucket = q[d % K]!;
    while (bucket.length) {
      const k = bucket.pop()!;
      if (dist[k] !== d) continue; /* 过期的记录：这一格已经被更短的路重写过 */
      const x = k % s.w;
      const y = (k - x) / s.w;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= s.w || ny >= s.h) continue;
        const t = s.tiles[ny * s.w + nx]?.terrain;
        if (!t || !passable(t)) continue;
        /* 森林多花一步；有"穿林"的兵种不花 */
        const cost = t === 'forest' && !(def.abilities ?? []).includes('forest-walk') ? 2 : 1;
        const ni = ny * s.w + nx;
        const nd = d + cost;
        if (nd < dist[ni]!) {
          dist[ni] = nd;
          q[nd % K]!.push(ni);
        }
      }
    }
  }
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

  /* 按格计步：和 turnsFrom 同一套 BFS，只是移动力按 1 算 */
  const stepCache = new Map<string, Float64Array>();
  const stepFrom = (p: { x: number; y: number }): Float64Array => {
    const key = `${p.x},${p.y}`;
    const hit = stepCache.get(key);
    if (hit) return hit;
    const t = flipBfs(s, p, 1);
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
        const walk = new Map(defs.map((d) => [d.id, walkDist(s, { x: city.x, y: city.y }, d)]));

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
       * **【距离场 C】多源：从一组"洞"同时出发，带"下一步该往哪走"。**
       *
       * ── "洞"是什么 ────────────────────────────────────────────
       *
       * 洞 = **空出来、但应该被占的格**（现在用在"空岗"上，见约束层）。
       * 注意它不是"所有空格"——空格到处都有，那是距离场 D 的口径。
       * 两者千万别混：用 D 的口径去找岗位，人会被引到地图另一头的空地上。
       *
       * ── 输出的两个数 ──────────────────────────────────────────
       *
       * · `dist[i]`：这一格离**最近那个洞**几步；走不到是 Infinity。
       * · `prev[i]`：站在这一格的人，下一步应该走到哪个格号（朝洞的方向）。
       *   `prev[洞] = -1`（到头了）。**整张表是一棵以洞为根的树**，
       *   所以顺着 prev 走一定到得了洞、不会兜圈子。
       *
       * ── 逐段在做什么 ──────────────────────────────────────────
       *
       * ① 种子：所有洞，距离都写 0，一起进队列（这就是"多源"——
       *    如果是单源，人和洞离得远时会绕一大圈；多源等于"谁都从最近的洞算起"）。
       *
       * ② 扩散：四邻、每格一步。**穿过自己人算一步**（那个人得先让开），
       *    敌人和不可走的地形直接挡死。这条很关键：
       *    如果自己不挡自己，这张表就会给出"人穿着人走"的路线，执行时全被引擎拒。
       *
       * ③ `MAX = 10` 是个上限：离得再远就没必要算了（省时间）。
       *    副作用：超过 10 步的格子是 Infinity，上层会当成"走不到"。
       *
       * ④ 缓存：按"洞的集合"缓存（排序后拼成 key）。同一手会反复问同一条链，
       *    不缓存的话每问一次就是一次全图扫描。
       */
      const key = holes.slice().sort((a, b) => a - b).join(',');
      const hit = flowCache.get(key);
      if (hit) return hit;
      const n = s.w * s.h;
      const dist = new Float64Array(n).fill(Infinity);
      const prev = new Int32Array(n).fill(-1);
      const q: number[] = [];
      /* ① 所有洞同时当种子 */
      for (const h of holes) {
        if (h < 0 || h >= n) continue;
        if (dist[h] === 0) continue;
        dist[h] = 0;
        q.push(h);
      }
      const MAX = 10;
      /* ② 逐层扩散（所有边代价都是 1，所以第一次到达即最短） */
      for (let i = 0; i < q.length; i++) {
        const k = q[i]!;
        if (dist[k]! >= MAX) continue;
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
          /* 穿过自己人算一步（他得先让开）；敌人挡死 */
          const occ = s.units.find((u) => u.y * s.w + u.x === nk);
          if (occ && occ.owner !== me) continue;
          dist[nk] = dist[k]! + 1;
          prev[nk] = k; /* 下一步往 k 走，就是朝洞的方向 */
          q.push(nk);
        }
      }
      /* ④ 缓存 */
      const out = { dist, prev };
      flowCache.set(key, out);
      return out;
    },
  };
  return world;
}
