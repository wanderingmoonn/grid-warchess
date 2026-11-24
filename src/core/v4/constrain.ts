/**
 * **约束层**：把"要做什么"翻译成"哪几格必须空、哪几个兵归哪队、去打哪座城"。
 *
 * ── 这一层为什么在打分层之前 ────────────────────────────────
 *
 * 直觉是"打分层才是现成资产，先做它"。但 v3 的每一次翻车都在**分数表达不了的约束**上：
 * 桥头要让开、产兵格要让开、城门口要让开——这些"必须"被塞进分数里，于是
 * "让开"和"别送死"互相打折，最后谁也不让。
 *
 * 所以 v4 先把这个工具做对：**必须做的事不参与打分**。
 */
import { passable } from '../config.ts';
import { attackableTargets, effectiveStats } from '../rules.ts';
import { utype } from '../rules.ts';
import type { City } from '../types.ts';
import type { GameState, Unit } from '../types.ts';
import { DECIDE_HORIZON } from './decide.ts';
import type { Constraints, Decision, Squad, V4Memory } from './types.ts';
import type { World } from './world.ts';

/**
 * **曼哈顿**距离——和引擎一致（2026-11-24 修）。
 *
 * 这游戏里移动是四邻 BFS，斜走要**两步**，`distToCity` 也是 `|dx|+|dy|`。
 * v4 原来一直用切比雪夫（斜走算 1 格），等于系统性地高估推进能力：
 * "离城 4 格"在引擎眼里可能是 6 步，`stepToward` 于是选了一堆看着更近、
 * 实际更费步的斜向落点。
 *
 * 唯一用欧氏的是视野（历史遗留的 bug，改成惯例了）——那一条不在这里。
 */
const cheb = (a: { x: number; y: number }, b: { x: number; y: number }): number =>
  Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

/**
 * 本回合的集火点：**一张尺子，只算一次**。
 *
 * 候选 = 全队能打到的敌方单位（引擎的 `attackableTargets`，含射程/高度/视野）。
 * 排序只有一条：**这一手能不能打死它**——
 *   · 能打死的里面挑血最少的（打死了就少一个输出源，而且下回合不用再挨）；
 *   · 都打不死就挑"总伤害 / 血量"最高的（下回合最可能收掉）。
 *
 * 不做"威胁权重""价值系数"那种东西：那正是 v3 那张必须调参的表。
 */
function pickFocus(s: GameState, ids: string[]): string | undefined {
  /* 每个敌人能被我们几个单位够到、我们一共能砸多少伤害 */
  const reach = new Map<string, { n: number; dmg: number; hp: number }>();
  for (const id of ids) {
    const u = s.units.find((x) => x.id === id);
    if (!u) continue;
    const st = effectiveStats(s, u);
    if ((st.atk ?? 0) <= 0) continue;
    for (const foe of attackableTargets(s, u)) {
      const rec = reach.get(foe.id) ?? { n: 0, dmg: 0, hp: foe.hp };
      rec.n += 1;
      rec.dmg += Math.max(1, (st.atk ?? 0) - 0);
      reach.set(foe.id, rec);
    }
  }
  if (reach.size === 0) return undefined;
  const rows = [...reach.entries()];
  const killable = rows.filter(([, r]) => r.dmg >= r.hp);
  if (killable.length > 0) {
    /* 能打死：挑血最少的（最省手） */
    killable.sort((a, b) => a[1].hp - b[1].hp);
    return killable[0]![0];
  }
  /* 打不死：挑"总伤害/血量"最高的，下回合最可能收掉 */
  rows.sort((a, b) => b[1].dmg / b[1].hp - a[1].dmg / a[1].hp);
  return rows[0]![0];
}

/** 一个单位值多少（身价）：atk + hp + 射程×4，按剩余血量打折。和决定层同一个口径 */
function unitWorth(s: GameState, u: Unit): number {
  const d = utype(s, u.type);
  return ((d.atk ?? 0) + (d.maxHp ?? 0) + (d.range ?? 1) * 4) * (u.hp / Math.max(1, d.maxHp ?? 1));
}

/** 集结点：自家城朝敌方向外挪两格，取一个能站人的空点 */
function assemblePoint(s: GameState, world: World, cityId: string): { x: number; y: number } | undefined {
  const city = s.cities.find((c) => c.id === cityId);
  if (!city) return undefined;
  const foe = world.foeCities[0];
  const dx = foe ? Math.sign(foe.x - city.x) : 1;
  const dy = foe ? Math.sign(foe.y - city.y) : 0;
  const cand = [
    { x: city.x + dx * 2, y: city.y + dy * 2 },
    { x: city.x + dx * 3, y: city.y },
    { x: city.x, y: city.y + dy * 3 },
  ];
  for (const p of cand) {
    if (p.x < 0 || p.y < 0 || p.x >= s.w || p.y >= s.h) continue;
    if (s.units.some((u) => u.x === p.x && u.y === p.y)) continue;
    return p;
  }
  return undefined;
}

/**
 * 让位搬迁计划（多源 BFS）——**思路抄 v3 的 `buildYieldPlan`，代码不抄**。
 *
 * 种子是**所有空格**（能站人的、非城格）。从它们向外扩，穿过自己人算一步
 * （那个人得先让开），敌人和不可通行直接挡死。于是每格都知道了"离最近的洞几步"。
 *
 * 然后对每个被占的关键格：沿 `prev` 倒着走到洞，这条链上的人各朝洞挪一格。
 * 好处是**一回合能清多格**——一个人挪开、后面的人依次递补，而不是一回合只挪一个。
 *
 * v3 那份还带着"谁更急"的分数（urgency）；这里不需要：关键格就是必须空，
 * 不存在"先让哪一格"的问题——链式搬迁天然按距离排好了。
 */
function planYield(
  s: GameState,
  world: World,
  keepClear: number[],
  squads: Squad[],
  need: { spawn: boolean; exit: boolean },
): Array<{ unitId: string; x: number; y: number }> {
  /*
   * **只在"这一手真有人要用这格"时才赶人**（用户 2026-11-24 定）。
   *
   * 原来是对 `keepClear` 一刀切：只要站在城圈（城格 + 城墙外一圈）上就赶。
   * 实测两个毛病：
   *   ① 这一手根本不造兵、军队也不出城，赶它纯属白费一步；
   *   ② 被赶的人本来就要往岗位走（方向正好是离开城圈），等于重复下命令，
   *      而且落点是"最近的空格"——大概率在反方向。一步能干两件事，被拆成两步、而且第二步是错的。
   *      实测 S-015：伐木工进森林又被甩出来，再走回去。
   *
   * 判据换成两类需求：
   *   · 产兵口 = **城格**（引擎的产兵落点就是 `cityTiles`，外圈不是）；要造兵时只赶城格上的人。
   *   · 出门通道 = 城圈 + 桥头；有队伍要出去/要过桥时，才赶挡路的。
   */
  const cityCells = new Set<number>();
  for (const c of world.myCities) {
    const n = c.size ?? 2;
    for (let dy = 0; dy < n; dy++) for (let dx = 0; dx < n; dx++) cityCells.add((c.y + dy) * s.w + (c.x + dx));
  }
  const targets = keepClear.filter(
    (k) => (need.spawn && cityCells.has(k)) || (need.exit && !cityCells.has(k)),
  );
  if (targets.length === 0) return [];
  const N = s.w * s.h;
  const dist = new Int32Array(N).fill(-1);
  const prev = new Int32Array(N).fill(-1);
  const q: number[] = [];

  for (let k = 0; k < N; k++) {
    const t = s.tiles[k];
    if (!t || t.terrain === 'city') continue;
    if (s.units.some((u) => u.y * s.w + u.x === k)) continue;
    if (!passable(t.terrain)) continue;
    dist[k] = 0;
    q.push(k);
  }

  /* 只往 6 格内扩：洞太远的话，链上的人这一手也走不完，没必要算 */
  const MAX = 6;
  for (let i = 0; i < q.length; i++) {
    const k = q[i]!;
    if (dist[k]! >= MAX) continue;
    const x = k % s.w;
    const y = Math.floor(k / s.w);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= s.w || ny >= s.h) continue;
      const nk = ny * s.w + nx;
      if (dist[nk]! >= 0) continue;
      const t = s.tiles[nk];
      if (!t || !passable(t.terrain)) continue;
      const occ = s.units.find((u) => u.y * s.w + u.x === nk);
      if (occ && occ.owner !== world.me) continue;
      dist[nk] = dist[k]! + 1;
      prev[nk] = k;
      q.push(nk);
    }
  }

  /*
   * 推进/攻城的兵不算挡路：它们有理由待在那儿（正在过桥）。
   * 只让"没事待着"的单位（经济兵、驻守兵）让开——否则过桥的兵会被自己的规则赶回去，
   * 在桥上来回横跳。
   */
  const passing = new Set<string>();
  for (const sq of squads) {
    if (sq.order !== 'march' && sq.order !== 'siege') continue;
    for (const id of sq.unitIds) passing.add(id);
  }

  const out: Array<{ unitId: string; x: number; y: number }> = [];
  const usedCells = new Set<number>();
  const usedUnits = new Set<string>();

  for (const cell of targets) {
    /* 关键格自己得是被自己人占着的，否则没什么可让 */
    const blocker = s.units.find((u) => u.y * s.w + u.x === cell && u.owner === world.me);
    if (!blocker || usedUnits.has(blocker.id) || passing.has(blocker.id)) continue;
    let k = cell;
    /* 沿 prev 往洞的方向倒着走；到不了洞（-1）就算了，这一手不硬挪 */
    const chain: number[] = [];
    let guard = 0;
    while (dist[k]! > 0 && guard++ < 12) {
      k = prev[k]!;
      if (k < 0) break;
      chain.push(k);
    }
    if (chain.length === 0) continue;
    /* 链上第一个空位就是这一手的目标；链上每个单位挪到它前一个的位置（倒序） */
    for (let i = chain.length - 1; i >= 0; i--) {
      const to = chain[i]!;
      const from = i === 0 ? cell : chain[i - 1]!;
      const u = s.units.find((v) => v.y * s.w + v.x === from && v.owner === world.me);
      if (!u || usedUnits.has(u.id) || usedCells.has(to)) continue;
      usedUnits.add(u.id);
      usedCells.add(to);
      out.push({ unitId: u.id, x: to % s.w, y: Math.floor(to / s.w) });
    }
  }
  return out;
}

/**
 * 把决定翻成约束。
 *
 * 三条铁律：
 *   1. **不把自己人排到 `keepClear` 上**——那是"必须空"的格子，排上去等于自相矛盾；
 *   2. **每个兵最多属于一支队**——v3 的"一兵多队"让两套指令互相覆盖；
 *   3. **守城的兵不出去**——`hold` 是约束，不是"倾向"。
 */
/**
 * 分路：**展开宽度由地形决定**（2026-11-24）。
 *
 * 判据是地形事实：`world.corridorWidth()` 数"横向能并排站几格"。
 * 宽 ≥5 走三路、≥3 走两路、**窄道（桥/关隘）退回单列**——单列就是原来的行为。
 *
 * 上一版不看地形、一律分三路，结果 S-005（桥）过河 4→0、S-000/S-011 一起红。
 * 同一个"展开"，开阔地是对的，窄道是灾难，差别就在宽度。
 *
 * 引导点是**滚动航点**（前沿 + 沿轴 3 格 + 法向偏移），不是城边的固定点——
 * 固定点会让侧翼单位为了"先到点"而绕远（用户原话：绕太远耽误时间）。
 */
function planLanes(
  s: GameState,
  world: World,
  ids: string[],
  city: { x: number; y: number },
): { lanes: Array<{ x: number; y: number }>; laneOf: Record<string, number> } | null {
  const us = ids.map((id) => s.units.find((u) => u.id === id)).filter((u): u is NonNullable<typeof u> => !!u);
  if (us.length < 6) return null;

  const front = [...us].sort((a, b) => cheb(a, city) - cheb(b, city))[0]!;
  const width = world.corridorWidth(front, city);
  const k = width >= 5 ? 3 : width >= 3 ? 2 : 1;
  if (k === 1) return null;

  const dx = city.x - front.x;
  const dy = city.y - front.y;
  const len = Math.hypot(dx, dy) || 1;
  const ax = dx / len;
  const ay = dy / len;
  const nx = -ay;
  const ny = ax;

  const offsets = k === 3 ? [-2, 0, 2] : [-1.5, 1.5];
  /*
   * 引导点必须**落在能站的格子上**。
   *
   * 算出来落在森林/水上时，引擎的 BFS 距离场在那儿是 Infinity，
   * 于是"离目标更近"的比较全失效，兵会绕着障碍打转（S-011 实测：全队漂到西北角）。
   */
  const snap = (p: { x: number; y: number }): { x: number; y: number } => {
    if (passable(s.tiles[p.y * s.w + p.x]?.terrain ?? 'wall')) return p;
    for (let r = 1; r <= 2; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const x = p.x + dx;
          const y = p.y + dy;
          if (x < 0 || y < 0 || x >= s.w || y >= s.h) continue;
          if (passable(s.tiles[y * s.w + x]?.terrain ?? 'wall')) return { x, y };
        }
      }
    }
    return p;
  };
  const lanes = offsets.map((off) =>
    snap({
      x: Math.round(front.x + ax * 3 + nx * off),
      y: Math.round(front.y + ay * 3 + ny * off),
    }),
  );

  const sorted = [...us].sort(
    (a, b) => (a.x - front.x) * nx + (a.y - front.y) * ny - ((b.x - front.x) * nx + (b.y - front.y) * ny),
  );
  const laneOf: Record<string, number> = {};
  sorted.forEach((u, i) => {
    laneOf[u.id] = Math.min(lanes.length - 1, Math.floor((i * lanes.length) / sorted.length));
  });
  return { lanes, laneOf };
}

/**
 * 经济兵的岗位（2026-11-24 重写）：**认领表**，一人一格。
 *
 * ── 它解决的是什么 ──────────────────────────────────────────
 *
 * 原来这里是"给每个经济兵挑一格产出最高的空位"，而服务层另外有一个 `econPost()`
 * 每回合重新问"现在哪格最肥"。两个口径都不记得"这块地已经许给谁了"：
 * S-015 实测，同一格森林被连着承诺给 5 个伐木工（新兵出生在城里、旧兵还在路上，
 * 那格一直是"空闲"）。所以要做的不是"挑得更聪明"，是**一张认领表**。
 *
 * ── 三条规矩（都是"算账"，没有拍的数）──────────────────────────
 *
 * ① **兵种是格子的属性**（`world.econSpots()` 已经算好）：森林→伐木工、丘陵→牧民、
 *    平原→农民。所以"5 个伐木工抢 2 格森林"这种错误根本表达不出来。
 * ② **搬不搬算净收益**：`新岗产出 × 还能产几手 > 现岗产出 × 还能产几手` 才搬。
 *    相等就不动（净收益 0）——这一条天然防抖，不需要"迟滞"那套。
 *    产出是**回合末按脚下地形结算**的（`settleIncome`），所以走路那几手照样产金，
 *    搬家的代价只有"路上落点比现在少产的那点"，这里按 0 保守处理。
 * ③ **期限**用决定层已经必须写的 `untilTurn`：到那之前一手都产不了的岗不参与。
 *    远近不用半径挡——远处的岗"期限内产出"自己会变小。
 */
function planEconPosts(
  s: GameState,
  world: World,
  mem?: V4Memory,
): { posts?: Record<string, { x: number; y: number }>; next?: { type: string; x: number; y: number } } {
  const econ = world.myEcon;
  const spots = world.econSpots();
  if (spots.length === 0) return {};

  /*
   * 盘子有多大：用**决定层的名义期限**，不用"这个决定还剩几手"。
   *
   * 后者在每个周期最后几手会塌到 1 → 岗表全空 → 经济兵集体停手、钱堆着不花
   * （实测 S-015 第 7 手：可用岗从 171 掉到 0）。
   * 战略上"决定快到期"不等于"这块地不值得占"，下个决定大概率还是同一件事。
   */
  const horizon = DECIDE_HORIZON;
  const avail = (p: { turns: number }): number => Math.max(0, horizon - p.turns);
  /* 期限内一手都产不了的岗不算（等它到了，这个决定已经作废了） */
  const usable = spots.filter((p) => avail(p) > 0);
  if (usable.length === 0) return {};

  const posts: Record<string, { x: number; y: number }> = {};
  const claimed = new Set<number>();
  const keepSet = new Set(world.keepClear);
  /*
   * 站在"必须空"的格子上的人，当前产出按 **0** 算。
   *
   * 那几格（城格 + 城墙外一圈）不是能待的地方，是产兵口和出城通道——岗表里根本没有它们。
   * 不算 0 的话会出两个错（都实测到了）：经济兵路过城圈里的森林时"脚下 12 金"，
   * 于是判定"搬走不划算"，钉在过道上不走；同时真正属于它的森林岗一直空着，
   * 上层的造兵又照着那个空岗造了第三个伐木工。
   */

  /*
   * ① 已经站人的格先算被占：**脚下的格就是他的岗**。
   *    不先占的话，两个同产出的人会互相"看见对方的格更肥"（其实同分），来回换。
   */
  for (const u of econ) claimed.add(u.y * s.w + u.x);

  /*
   * ② **按出生顺序配岗：先出生的去远的，后出生的拿近的。**
   *
   * 这是用户 2026-11-24 看回放时纠正的，也是人手答案的走法（action.json 里有据）：
   * u3 是第 1 手造的，它一路往东挪（9,6 → 9,7 → 9,8 → 9,9），
   * 新造的 u5/u7 填它让出来的格。**老的往外顶，新的从近处上来。**
   *
   * ── 为什么不能"谁近谁先挑"（前两版都这么写，结果都错）──
   *
   * 新兵出生在城里，近处的岗一定离它最近 → 近岗永远被新兵拿走，老兵被挤去远岗，
   * 或者新兵自己走远路。看上去总产出没少（同产出的岗互换是等价的），但行为是错的：
   *   ① 新兵走到一半遇到期限/威胁，这一手就白费了；老兵本来就在稳定产出，却被赶走；
   *   ② 老兵剩余回合多，走远路"摊得开"；新兵剩余回合少，走远路就是纯亏。
   * 所以配对的目标不是"当前产出最大"，是**让每个单位的到岗回合尽量一致**。
   *
   * ── 规矩 ──
   *
   * 同兵种的岗产出相同（森林给伐木工、丘陵给牧民、平原给农民），所以同兵种内
   * "远的给老的"不损失任何产出，只是把路程摊平。
   */
  const seniority = (u: Unit): number => mem?.econSince?.[u.id] ?? 0;
  /*
   * 分组键 = **最近的那座城 + 兵种**。
   *
   * 只按兵种分会出事：两座城的经济兵会抢同一批岗，A 城出生的兵被派到 B 城去
   * （实测长局：两个牧民的岗在 30 格外，走一辈子到不了）。
   */
  const nearestCity = (u: Unit): string => {
    let bestId = world.myCities[0]?.id ?? '';
    let bestD = Infinity;
    for (const c of world.myCities) {
      const d = Math.abs(u.x - c.x) + Math.abs(u.y - c.y);
      if (d < bestD) {
        bestD = d;
        bestId = c.id;
      }
    }
    return bestId;
  };
  const byType = new Map<string, Unit[]>();
  for (const u of econ) {
    const key = `${nearestCity(u)}|${u.type}`;
    const arr = byType.get(key) ?? [];
    arr.push(u);
    byType.set(key, arr);
  }
  for (const [key, units] of byType) {
    const [cityId, type] = key.split('|') as [string, string];
    /*
     * 单位：出生早的排前面（同一手出生的按 id 排，保证同一个局面每次算出来一样）。
     * 岗位：走得远到近排（`turns` 是"从城走到那儿"，也就是这个岗要花多少路程）。
     */
    const sortedUnits = [...units].sort((a, b) => seniority(a) - seniority(b) || (a.id < b.id ? -1 : 1));
    /*
     * 岗位先取**最近的 N 个**（N = 这个兵种的人数），再把这 N 个里**最远的给最老的**。
     *
     * 为什么必须先截断：只有一个牧民时，要是不截断，它会拿到全图最远的丘陵
     * （实测：一个人走 6 手，产量等于 0）。同产出的岗之间没有理由走远路——
     * 走远路只在"要给新兵腾近岗"时才有意义，也就是截断之后才有的事。
     */
    const sortedSpots = usable
      .filter((p) => p.type === type && p.cityId === cityId)
      .sort((a, b) => a.turns - b.turns || (a.y * s.w + a.x) - (b.y * s.w + b.x))
      .slice(0, sortedUnits.length)
      .reverse();

    sortedUnits.forEach((u, i) => {
      const p = sortedSpots[i];
      if (p) {
        posts[u.id] = { x: p.x, y: p.y };
        claimed.add(p.y * s.w + p.x);
      } else if (!keepSet.has(u.y * s.w + u.x)) {
        /* 岗不够分（这个兵种的好地已经占满）→ 原地不动 */
        posts[u.id] = { x: u.x, y: u.y };
      }
      /* 站在城圈/城格上又没有岗：不给岗，让搬迁计划把它请出去 */
    });
  }

  /*
   * ③ 下一个该造谁：表里还没人认领的格里，**产出最高的那一个；产出相同取近的**。
   *
   * 为什么不是"赚回几倍造价"（试过，实测 25 → 33 就卡住了）：
   * 那个口径偏爱便宜兵——牧民 8 金 ÷ 45 = 1.07 倍，伐木工 12 金 ÷ 70 = 1.03 倍，
   * 于是永远先买牧民，**两格森林一次都没用上**，总产反而低。
   * `8.15` 那句"别用人为数字代替规则"在这里的版本是：**别用一个比值去替"哪块地肥"**。
   * 钱的问题交给"买不起就跳过"，不掺进排序。
   */
  const gold = s.players[world.me]?.gold ?? 0;
  let next: { type: string; x: number; y: number } | undefined;
  for (const p of usable) {
    const k = p.y * s.w + p.x;
    if (claimed.has(k)) continue;
    if (s.units.some((v) => v.y * s.w + v.x === k)) continue;
    if (p.gold > gold) continue; /* 买不起就跳过，换下一个岗 */
    if (!next) {
      next = { type: p.type, x: p.x, y: p.y };
      continue;
    }
    const cur = spots.find((q) => q.x === next!.x && q.y === next!.y)!;
    if (p.yield > cur.yield || (p.yield === cur.yield && p.turns < cur.turns)) {
      next = { type: p.type, x: p.x, y: p.y };
    }
  }
  return { posts, next };
}

/**
 * 多城分兵（2026-11-24）：**每座受威胁的城一支队**。
 *
 * 为什么必须分：只有一支 `main` 时，所有兵都去最近那座城，另一座直接丢
 * （S-013 实测 v4 = 0/2，分兵脚本 = 2/2）。
 *
 * 分配是两趟纯几何，不打分：
 *   ① 每座城按"守军身价 ÷ 我方均价 × 1.5"算出需要几个人（和单城时同一个口径）；
 *   ② 先按需求从近到远取人（谁离这座城近就归谁），剩下的兵补到最近的那座城。
 *
 * 不做"哪个城更重要"的判断——那是决定层的事，而决定层现在只挑一座城。
 */
function planMains(s: GameState, world: World, cities: City[], ids: string[]): Squad[] {
  const units = ids.map((id) => s.units.find((u) => u.id === id)).filter((u): u is NonNullable<typeof u> => !!u);
  if (units.length === 0 || cities.length === 0) return [];

  const avg = units.reduce((n, u) => n + unitWorth(s, u), 0) / units.length || 1;
  const needs = cities.map((c) => {
    const guard = world.foeCombat.filter((u) => cheb(u, c) <= 6);
    const guardStr = guard.reduce((n, u) => n + unitWorth(s, u), 0);
    return { city: c, want: Math.max(2, Math.min(12, Math.round((guardStr / avg) * 1.5))) };
  });

  /*
   * 需求超过手头兵力时**按比例摊**，不是先到先得。
   *
   * S-013 实测：两城各要 8 个、手上只有 8 个，第一座全拿走、第二座 0 个 →
   * 1/2（另一座直接丢）。按比例摊是 4 : 4，正好是分兵脚本守住两城的配比。
   */
  const totalWant = needs.reduce((n, x) => n + x.want, 0);
  if (totalWant > units.length) {
    const scaled = needs.map((n) => ({
      ...n,
      want: Math.max(2, Math.floor((n.want * units.length) / totalWant)),
    }));
    for (let i = 0; i < needs.length; i++) needs[i] = scaled[i]!;
  }

  /* ① 按需求从大到小，各自从近到远取人 */
  const left = new Set(units.map((u) => u.id));
  const picked = new Map<string, string[]>();
  for (const n of [...needs].sort((a, b) => b.want - a.want)) {
    const cands = [...left]
      .map((id) => s.units.find((u) => u.id === id)!)
      .sort((a, b) => world.marchTurns(a, n.city) - world.marchTurns(b, n.city));
    const take = cands.slice(0, n.want);
    picked.set(n.city.id, take.map((u) => u.id));
    for (const u of take) left.delete(u.id);
  }

  /* ② 剩下的补到最近的那座城 */
  for (const id of left) {
    const u = s.units.find((x) => x.id === id);
    if (!u) continue;
    const near = [...cities].sort((a, b) => world.marchTurns(u, a) - world.marchTurns(u, b))[0]!;
    picked.get(near.id)?.push(id) ?? picked.set(near.id, [id]);
  }

  const out: Squad[] = [];
  for (const n of needs) {
    const squadIds = picked.get(n.city.id) ?? [];
    if (squadIds.length === 0) continue;
    out.push({
      id: `main-${n.city.id}`,
      order: 'march',
      unitIds: squadIds,
      cityId: n.city.id,
      want: n.want,
      focusId: pickFocus(s, squadIds),
      ...(planLanes(s, world, squadIds, n.city) ?? {}),
    });
  }
  return out;
}

export function constrain(s: GameState, world: World, decision: Decision, mem?: V4Memory): Constraints {
  const city = decision.cityId ? s.cities.find((c) => c.id === decision.cityId) : undefined;
  const keepClear = [...world.keepClear];
  const keepSet = new Set(keepClear);

  const squads: Squad[] = [];

  /* 守军：每座受威胁的城留 2 个最近的兵，任务 hold。留谁按"离城近"排，不按分数 */
  const held = new Set<string>();
  for (const info of world.cities) {
    if (info.role !== 'threatened' && info.role !== 'home') continue;
    const guards = world.myCombat
      .filter((u) => !held.has(u.id))
      .sort((a, b) => cheb(a, info.city) - cheb(b, info.city))
      .slice(0, 2);
    for (const g of guards) held.add(g.id);
    if (guards.length > 0) {
      squads.push({
        id: `hold-${info.city.id}`,
        order: 'hold',
        unitIds: guards.map((g) => g.id),
        cityId: info.city.id,
      });
    }
  }

  const rest = world.myCombat.filter((u) => !held.has(u.id) && !keepSet.has(u.y * s.w + u.x));

  /*
   * 两座以上城同时受威胁 → 分兵，每城一支队。
   * 只有一座时走原来的单队路径（行为完全不变）。
   */
  /*
   * 被压的城 = 附近有敌军的城。**不看决定类型**：
   * S-013 第一手 decided=expand（不占优，先攒兵），如果只在 press 时才分兵，
   * 八个人会一起在中间集结，两座城一起丢（实测 0/2）。
   */
  const threatened = world.cities.filter((info) =>
    world.foeCombat.some((u) => cheb(u, info.city) <= 8),
  );
  if (threatened.length >= 2 && rest.length >= threatened.length * 2) {
    squads.push(...planMains(s, world, threatened.map((i) => i.city), rest.map((u) => u.id)));
  } else if (decision.kind === 'press' && city) {
    const ids = rest.map((u) => u.id);
    /*
     * `want`：打这座城要几个人。
     *
     * 口径是"目标城的守军身价 ÷ 我方平均单位身价 × 1.5"，夹在 4~12。
     * 不按固定配额（v3 试过乘数，三次调参把胜局调成平局），也不按"总兵力比"
     * （v3 的注释：敌方一个兵都看不见时比值反而最大，越是空城越要凑满编）。
     */
    const guard = world.foeCombat.filter((u) => cheb(u, city) <= 6);
    /*
     * 采购门槛：从守军身上读出"要造什么样的兵"。
     * 挨不住一发（hp ≤ 敌方单发）的兵是白送；三发打不穿的兵是白来。
     */

    const guardStr = guard.reduce((n, u) => n + unitWorth(s, u), 0);
    const avg = ids.length > 0
      ? ids.reduce((n, id) => {
          const u = s.units.find((x) => x.id === id);
          return n + (u ? unitWorth(s, u) : 0);
        }, 0) / ids.length
      : 1;
    const freshWant = Math.max(4, Math.min(12, Math.round((guardStr / Math.max(1, avg)) * 1.5)));

    /*
     * 成立时定下的 `want` **不因为伤亡而缩**（存进记忆）。
     * 不这样的话，人一死 want 跟着降，队伍就永远"刚好够"，越打越小。
     */
    const memo = mem?.squad;
    const keepWant = memo && memo.cityId === city.id && s.turn - memo.formedAt <= 12 ? memo.want : freshWant;

    /*
     * 出发条件：**两回合内能站到城下的人够不够**，不看"总人数够不够"。
     *
     * 一开始写的是 `人数 >= want`，结果 25 个兵一字长蛇阵也立刻开拔——
     * 人数够不等于队形到齐，先到的几个照样被各个击破（S-002：0 城伤、损失 22）。
     *
     * 现在看 eta80（八成人的行军回合）。这是纯几何判断，不需要记"我等了几回合"。
     */
    const etas = ids
      .map((id) => {
        const u = s.units.find((x) => x.id === id);
        return u ? world.marchTurns(u, city) : Infinity;
      })
      .sort((a, b) => a - b);
    const eta80 = etas[Math.min(etas.length - 1, Math.floor(etas.length * 0.8))] ?? Infinity;
    const eta = etas[etas.length - 1] ?? Infinity;
    /*
     * 够数就走；或者整队已经贴到城下（八成人一步能到）。
     *
     * 试过"两回合内到城下的人 ≥ want"，那样是循环条件：队伍在城外集结，
     * 到不了城下就永远凑不够人出发（S-000 从绿变红、S-005 过河 4→3）。
     */
    const ready = ids.length >= keepWant || eta80 <= 1;

    /*
     * 要不要绕：看**先头那个兵**到城的真实回合数和直线距离差多少。
     * 隔河时 BFS 会明显更远（S-005 的桥），这时才用寻路挑落点；
     * 平地上一律直线（用了反而会选斜路绕远，S-011 全队漂到西北角）。
     */
    const leadUnit = ids
      .map((id) => s.units.find((x) => x.id === id))
      .filter((u): u is NonNullable<typeof u> => !!u)
      .sort((a, b) => world.marchTurns(a, city) - world.marchTurns(b, city))[0];
    const detour = leadUnit ? world.marchTurns(leadUnit, city) > cheb(leadUnit, city) + 2 : false;
    squads.push({
      id: 'main',
      order: ready ? 'march' : 'assemble',
      unitIds: ids,
      cityId: city.id,
      at: ready ? undefined : assemblePoint(s, world, city.id),
      want: keepWant,
      eta: Number.isFinite(eta) ? eta : 99,
      /* 集火点：这一手全队打同一个。出发前（assemble）也照样选，等于"边收拢边集火" */
      focusId: pickFocus(s, ids),
      /* 分路：只给推进中的队分；路数由地形宽度决定（窄道自动退回单列） */
      detour,
      ...(ready ? planLanes(s, world, ids, city) ?? {} : {}),
    });
  } else if (decision.kind === 'defend' && city) {
    /* 守：把外面的兵收回城下（这条和 S-004 那道题是同一件事） */
    squads.push({
      id: 'recall',
      order: 'hold',
      unitIds: rest.map((u) => u.id),
      cityId: city.id,
    });
  } else {
    const at = assemblePoint(s, world, world.myCities[0]?.id ?? '');
    squads.push({ id: 'main', order: 'assemble', unitIds: rest.map((u) => u.id), at });
  }

  /* 造兵：不造经济兵以外的东西时，经济兵不设约束（它们自己站格子产金） */
  const forbid: string[] = [];
  if (decision.kind === 'press') forbid.push('DISBAND');

  /*
   * 采购门槛：从**看得见的敌军**里读（不限于某一座城的守军）。
   *
   * 两条不等式：挨得住一发（hp > 对面最高单发）、三发能打穿（3×atk ≥ 对面最厚血）。
   * 守城时也要用它——而守城时没有 `main` 队，所以这条挂在约束层、不挂在某支队上。
   */
  const foes = world.foeCombat;
  /*
   * 只在**人数不占优**时才讲"质量"。
   *
   * S-002 有 30 个兵打 12 个：数量本身就是答案，硬按"挨得住一发"筛会把
   * 便宜的量产兵全筛掉（实测 S-002 从绿变红）。S-012 是 2~6 个打 3~4 个，
   * 这时候再堆便宜兵就是白送。
   */
  const outnumbered = world.myCombat.length <= foes.length;
  const need =
    foes.length > 0 && outnumbered
      ? {
          hp: foes.reduce((n, u) => Math.max(n, effectiveStats(s, u).atk ?? 0), 0),
          atk: Math.ceil(foes.reduce((n, u) => Math.max(n, u.hp), 0) / 3),
        }
      : undefined;

  const econPlan = planEconPosts(s, world, mem);
  /*
   * 这一手"有没有人真要用关键格"——决定要不要赶人（见 `planYield` 顶部）。
   *
   * · 产兵口：这城现在买得起至少一个兵（战斗或经济），说明接下来可能要造；
   *   被压着的城造不出来，不算。
   * · 出门通道：有队伍**有兵**且任务是出去（收拢/推进/攻城）。空队伍（0 人）不算——
   *   S-015 那种一条人烟的题里，"main 收拢 0 人"会让城圈一直被赶。
   */
  const gold = s.players[world.me]?.gold ?? 0;
  const spawn = world.cities.some(
    (info) =>
      info.role !== 'threatened' &&
      (world.affordableCombat(info.city, gold).length > 0 || !!econPlan.next),
  );
  const exit = squads.some(
    (q) => q.unitIds.length > 0 && (q.order === 'march' || q.order === 'siege' || q.order === 'assemble'),
  );

  return {
    need,
    econPosts: econPlan.posts,
    econNext: econPlan.next,
    keepClear,
    squads,
    yieldMoves: planYield(s, world, keepClear, squads, { spawn, exit }),
    forbid,
  };
}

/** 这个单位属于哪支队（查表；没有任务 = undefined） */
export function taskOf(con: Constraints, unit: Unit): Squad | undefined {
  for (const sq of con.squads) if (sq.unitIds.includes(unit.id)) return sq;
  return undefined;
}

/** 站在 `keepClear` 上的自家单位（打分层要先把它们挪开） */
export function blockers(s: GameState, con: Constraints, world: World): Unit[] {
  const keep = new Set(con.keepClear);
  return s.units.filter(
    (u) => u.owner === world.me && keep.has(u.y * s.w + u.x) && utype(s, u.type).category !== undefined,
  );
}
