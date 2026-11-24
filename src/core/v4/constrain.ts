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
import { attackableTargets, effectiveStats, reachableTiles, unitYieldAt } from '../rules.ts';
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
   * ════════════════════════════════════════════════════════════════
   * **【距离场 D】多源、从"所有空格"出发，用来"把人从关键格上搬开"。**
   *
   * 它和 world 里那张 C（`flowFrom`）用的是同一套算法（多源 + 前驱指针），
   * 但**种子的定义完全相反**，这是最容易看错的一处：
   *
   *   · C 的种子 = **洞**（该被占的空岗）→ 人顺着 prev 走，就是在"上岗"；
   *   · D 的种子 = **所有空格**（包括根本不该站人的空地）→ 人顺着 prev 走，是在"让开"。
   *
   * 为什么 D 不能复用 C：D 要回答的是"从这一格往哪个方向最近能腾出位置"，
   * 所以起点必须是"空"；C 要回答的是"往哪个方向最近的岗位"。
   * 两个问题的答案经常方向相反，混用会让人往反方向跑。
   *
   * ── 下面分成五段，按顺序读 ──────────────────────────────────
   *
   *   ① 决定这一手要赶哪些格（不是整圈都赶，见下）
   *   ② 播种：把所有空格当成"洞"
   *   ③ 扩散：算出每格"离最近的空位几步"，并记下"下一步往哪走"
   *   ④ 排除"正在执行任务的兵"（过桥/推进的不算挡路）
   *   ⑤ 沿前驱把链上的人依次挪一格
   * ════════════════════════════════════════════════════════════════
   */

  /*
   * ① **只在"这一手真有人要用这格"时才赶人**（用户 2026-11-24 定）。
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

  /*
   * ② 播种：**所有能站的空格**都是种子（距离 0）。
   *    三条排除：
   *      · 城格不算洞（它是"要空出来的地方"，不是"能塞人的地方"）；
   *      · 有人站着的格不算；
   *      · 水/高山不算。
   */
  const seeds: number[] = [];
  for (let k = 0; k < N; k++) {
    const t = s.tiles[k];
    if (!t || t.terrain === 'city') continue;
    if (s.units.some((u) => u.y * s.w + u.x === k)) continue;
    if (!passable(t.terrain)) continue;
    seeds.push(k);
  }

  /*
   * ③ 扩散：交给**世界层那张唯一的距离场**（多源、自己人可穿、只算 6 步、要前驱）。
   *
   *    以前这里是一段内联的 BFS，和 `world.flowFrom` 一个算法抄两份，
   *    只有种子定义不同（这里种子 = 所有空格；那边 = 空岗）。现在合成一次调用，
   *    区别只在"传哪些种子进来"。
   */
  const { dist, prev } = world.field(seeds, { units: 'friendly', maxDist: 6, prev: true });

  /*
   * ④ 推进/攻城的兵不算挡路：它们有理由待在那儿（正在过桥）。
   * 只让"没事待着"的单位（经济兵、驻守兵）让开——否则过桥的兵会被自己的规则赶回去，
   * 在桥上来回横跳。
   */
  const passing = new Set<string>();
  for (const sq of squads) {
    if (sq.order !== 'march' && sq.order !== 'siege') continue;
    for (const id of sq.unitIds) passing.add(id);
  }

  /*
   * ⑤ 沿前驱把链上的人依次挪一格。
   *
   *    对每一个"要腾出来的格"：从它出发顺着 prev 一直走到某个空格，得到一条链
   *    `关键格 → … → 空格`。然后**从空格那一头开始**，每个人挪到前一个人的位置。
   *    之所以要从那一头开始，是因为每一次移动都必须落在一个"刚刚被腾出来的格"上
   *    （引擎不允许两个人占同一格，也没有"交换位置"这个动作）。
   *
   *    `usedCells` / `usedUnits` 是**链与链之间**的去重：两条链不能用同一格、
   *    也不能重复派同一个人。**链内部不能用它判**——那样每条链只会走一格，
   *    整列纹丝不动（v3 在这里踩过，注释写在下面）。
   */
  const out: Array<{ unitId: string; x: number; y: number }> = [];
  const usedCells = new Set<number>();
  const usedUnits = new Set<string>();

  for (const cell of targets) {
    /* 关键格自己得是被自己人占着的，否则没什么可让 */
    const blocker = s.units.find((u) => u.y * s.w + u.x === cell && u.owner === world.me);
    if (!blocker || usedUnits.has(blocker.id) || passing.has(blocker.id)) continue;

    /*
     * 沿 prev 一路走到"最近的空位"，得到一条链：
     *
     *     关键格（被占） → 中间若干格（也可能被占） → 空位（dist = 0）
     *
     * `guard` 只是防死循环的保险（prev 是一棵树，理论上不会绕圈）。
     * 走不到空位（prev = -1，也就是 6 格内没有洞）就放弃：这一手不硬挪，
     * 因为"没有落点"时挪等于让人凭空消失。
     */
    let k = cell;
    const chain: number[] = [];
    let guard = 0;
    while (dist[k]! > 0 && guard++ < 12) {
      k = prev[k]!;
      if (k < 0) break;
      chain.push(k);
    }
    if (chain.length === 0) continue;

    /*
     * **从空位那一头开始倒着派**（`i` 从链尾往链头走）。
     *
     * 链 = [关键格, c1, c2, …, 空位]（空位在最后）。
     *   i = 最后 → `to` = 空位，`from` = 空位前面那格 → 那个人先挪进空位；
     *   i 往前 → 每个人的目标都是"后一个人刚刚腾出来的格"。
     * 所以每一次移动都落在空出来的格上——引擎没有"两个人交换位置"这个动作，
     * 只能靠这个顺序。
     *
     * 顺序反过来的话（从关键格那端先派），第一个人的目标格还被人占着，必被引擎拒，
     * 整条链就白算了。
     */
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
): {
  posts?: Record<string, { x: number; y: number }>;
  next?: { type: string; x: number; y: number };
  order?: string[];
} {
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
    const home = mem?.econHome?.[u.id];
    if (home) return home; /* 出生城是钉住的，不随走动变 */
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
    /*
     * ════════════════════════════════════════════════════════════════
     * **配岗：按"真实路程"最少来配，不按出生序排位。**
     *
     * 旧写法是"单位按出生序排、岗位按离城远近排、序号对序号"。
     * 那条规则的动机是"老的走远、新的走近"，但它只用了一条排序轴（出生序），
     * 而远近是另一条轴——两条轴排出来的配对会**交叉**，交叉就是互相挡路。
     *
     * 现在改成真正的最小总路程：
     *   代价 = 这个兵走到这个岗的**真实步数**（距离场算的，绕水绕山，不算人），
     *   然后从最便宜的那一对开始配，配过的兵和岗都划掉。
     *
     * 三个好处：
     *   ① 已经在岗上的人代价是 0，天然会被配回原地 → **不会来回挪**；
     *   ② 隔着水的"看着近"的岗，代价是 Infinity/很大 → 不会被选中（这就是用户问的
     *      "不可通行怎么处理"：不用处理，距离场本来就不穿水和山）；
     *   ③ 同代价时按单位 id、格号定序，保证同一个局面每次算出来一样。
     *
     * 出生序没有删掉，只降级成**同代价时的并列判据**（`seniority`）。
     * ════════════════════════════════════════════════════════════════
     */
    /* 候选岗：同城同兵种，取"离城最近"的前 N+2 个（留两个余量给配对挑） */
    const cands = usable
      .filter((p) => p.type === type && p.cityId === cityId)
      .sort((a, b) => a.turns - b.turns || (a.y * s.w + a.x) - (b.y * s.w + b.x))
      .slice(0, units.length);
    if (cands.length === 0) {
      for (const u of units) {
        if (!keepSet.has(u.y * s.w + u.x)) posts[u.id] = { x: u.x, y: u.y };
      }
      continue;
    }

    /* 代价表：每个候选岗一张"从它出发的步数图"，读这个兵脚下那格 */
    const fields = cands.map((p) => world.stepsFrom({ x: p.x, y: p.y }));
    const pairs: Array<{ u: Unit; i: number; d: number }> = [];
    for (const u of units) {
      const here = u.y * s.w + u.x;
      for (let i = 0; i < cands.length; i++) {
        const d = fields[i]![here] ?? Infinity;
        if (Number.isFinite(d)) pairs.push({ u, i, d });
      }
    }
    /* 便宜的先配；同代价时老的先挑，再按格号定序（纯粹为了结果确定） */
    pairs.sort((a, b) => a.d - b.d || seniority(a.u) - seniority(b.u) || a.i - b.i);

    const takenPost = new Set<number>();
    const assigned = new Set<string>();
    for (const pr of pairs) {
      if (assigned.has(pr.u.id) || takenPost.has(pr.i)) continue;
      assigned.add(pr.u.id);
      takenPost.add(pr.i);
      const p = cands[pr.i]!;
      posts[pr.u.id] = { x: p.x, y: p.y };
      claimed.add(p.y * s.w + p.x);
    }
    /* 一个岗都到不了的：原地不动（交给后面的"换空岗"兜底） */
    for (const u of units) {
      if (assigned.has(u.id) || posts[u.id]) continue;
      if (!keepSet.has(u.y * s.w + u.x)) posts[u.id] = { x: u.x, y: u.y };
    }

    /*
     * **分到的岗走不进去时，换一个能走进去的空岗。**
     *
     * 同一地形上的岗产出一样，本来就可以互换——重要的不是"哪一格"，
     * 是"这块地产出有没有被占住"。所以进不去就别硬顶：挑一个这一手真能到的空岗，
     * 原来那个继续空着，留给后面的人。
     *
     * 这正是"最后一个牧民死活进不去"的正解：它分到的岗在队伍深处、前面全站满，
     * 而旁边另一格空岗其实一伸手就到。
     *
     * 引擎不支持两个单位换位（必须先有空格），所以**没有空岗 = 真的满了**，
     * 那就原地等着，不做任何"硬挤"。
     */
    /* 这一组里"现在没人站"的岗（= 距离场 C 眼里的"洞"） */
    const freeCells = cands
      .filter((p) => !s.units.some((v) => v.y * s.w + v.x === p.y * s.w + p.x))
      .map((p) => p.y * s.w + p.x);
    if (freeCells.length > 0) {
      /* 距离场 C：从这些空岗同时出发，得到"每格离最近空岗几步、往哪走" */
      const flow = world.flowFrom(freeCells);
      for (const u of units) {
        const cur = posts[u.id];
        /* 已经站在自己岗上的不用管 */
        if (!cur || (cur.x === u.x && cur.y === u.y)) continue;

        /*
         * 判"这一手到底走不走得动"：拿**自己分到的那个岗**做终点，
         * 用距离场 A/B 那套（`stepsFrom`，不算人）看这一格离它几步；
         * 再把"这一手能踩到的格"逐个比一遍——只要有一个更近的，就说明路是通的。
         *
         * 注意这里问的是"能不能朝我自己的岗挪近"，不是"能不能到空岗"。
         * 两个问题答不上来就是两件不同的事：
         *   · 走不动 → 才是被堵住，才需要下面换岗；
         *   · 走得到、只是慢 → 不该换，换了反而绕远。
         */
        const field = world.stepsFrom({ x: cur.x, y: cur.y });
        const here = field[u.y * s.w + u.x] ?? Infinity;
        let canAdvance = false;
        for (const [k] of reachableTiles(s, u)) {
          const x = k % s.w;
          const y = (k - x) / s.w;
          if (s.units.some((v) => v.id !== u.id && v.x === x && v.y === y)) continue;
          if ((field[k] ?? Infinity) < here) {
            canAdvance = true;
            break;
          }
        }
        if (canAdvance) continue;

        /*
         * 被堵住了 → 改投"这一手就能踩到"的空岗。
         *
         * 挑法用的是距离场 C 的 `dist`：它衡量"这格离最近的空岗群有多近"，
         * 也就是"站上去之后，剩下的空岗是不是还在我旁边"（不至于把自己塞进死角）。
         * 这里**不按离城远近挑**——那会又变回"按城配岗"，人还会被引到远处。
         */
        let pick: number | null = null;
        let pickD = Infinity;
        for (const [k] of reachableTiles(s, u)) {
          const x = k % s.w;
          const y = (k - x) / s.w;
          if (s.units.some((v) => v.id !== u.id && v.x === x && v.y === y)) continue;
          if (!freeCells.includes(k)) continue;
          const d = flow.dist[k] ?? Infinity;
          if (d < pickD) {
            pickD = d;
            pick = k;
          }
        }
        if (pick !== null) {
          const x = pick % s.w;
          const y = (pick - x) / s.w;
          posts[u.id] = { x, y };
          claimed.add(pick);
        }
      }
    }
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
  /*
   * ════════════════════════════════════════════════════════════════
   * **让路：被挡住的人，请挡路的那一位往自己的岗位方向让一格。**
   *
   * 截图里那个局面（S-015 第 8 手之后）是最典型的：
   *
   *     x=8 平原：6 个牧民（产 4）   ← 他们要去 x=10
   *     x=9 丘陵：6 个牧民（产 8）   ← **已到岗，按规矩不该动**
   *     x=10 丘陵：6 格**全空**
   *
   * 从 (8,y) 到 (10,y) 必须穿 (9,y)，而引擎没有"交换两人位置"这个动作。
   * 于是一整列人 8 手不动，右边 6 格好地白白空着（实测总产 4×6 而不是 8×6）。
   *
   * 解法就是让 (9,y) 那位挪到 (10,y)——**两边产出一样（丘陵 8），挪了不亏**。
   * 他一走，(9,y) 空出来，被挡的人下一手就能进来。
   *
   * ── 规矩（都是"算账"，没有拍的数）──────────────────────────
   *
   * · 只在"这个人这一手**一步都走不动**"时才请人让路（走得动就不打扰别人）；
   * · 只请**经济兵**让（战斗兵有自己的任务，不归这里管）；
   * · 让到的那一格必须**对这个让路人自己**不降产（同产出或更肥），否则不挪；
   * · 一人一回合只让一次（`shifted`），免得同一个人被请两次、来回挪。
   * ════════════════════════════════════════════════════════════════
   */
  const shifted = new Set<string>();
  const takenOut = new Set<number>(); /* 这一手已经被用作"让路落点"的格，避免两个人让到同一格 */
  const yieldOf = (u: Unit, x: number, y: number): number => unitYieldAt(s, u, x, y).gold ?? 0;
  /* 沿"到岗位的步数图"往下走一格：四邻里挑步数更小的那个 */
  const stepDown = (field: Float64Array, at: number): number | null => {
    const x = at % s.w;
    const y = (at - x) / s.w;
    let best: number | null = null;
    let bestD = field[at] ?? Infinity;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= s.w || ny >= s.h) continue;
      const k = ny * s.w + nx;
      const d = field[k] ?? Infinity;
      if (d < bestD) {
        bestD = d;
        best = k;
      }
    }
    return best;
  };

  for (const u of econ) {
    const p = posts[u.id];
    if (!p || (p.x === u.x && p.y === u.y)) continue;
    const field = world.stepsFrom(p);
    const here = field[u.y * s.w + u.x] ?? Infinity;
    /* 这一手走得动吗？走得动就别打扰别人 */
    let canAdvance = false;
    for (const [k] of reachableTiles(s, u)) {
      const x = k % s.w;
      const y = (k - x) / s.w;
      if (s.units.some((v) => v.id !== u.id && v.x === x && v.y === y)) continue;
      if ((field[k] ?? Infinity) < here) {
        canAdvance = true;
        break;
      }
    }
    if (canAdvance) continue;

    /* 沿路径找第一个"挡路的自己人" */
    let at = u.y * s.w + u.x;
    for (let guard = 0; guard < 8; guard++) {
      const next = stepDown(field, at);
      if (next === null) break;
      const occ = s.units.find((v) => v.y * s.w + v.x === next && v.owner === world.me);
      if (!occ) {
        at = next;
        continue; /* 这格空的，继续往前找（说明是别人挡的，不是这一格） */
      }
      if (utype(s, occ.type).category !== 'economy') break; /* 战斗兵不动 */
      if (shifted.has(occ.id)) break;
      /*
       * 挑"让到哪一格"：**首选取向朝被挡那个人的岗位方向那一格**（沿步数图更小），
       * 那一格不能用（有人/会降产）时，退一步找**任何一格不降产的相邻空格**——
       * 横着让一格也算。
       *
       * 这一步很关键：只按"被挡者的路线"找，常常正好落在另一个自己人身上
       * （一整列人时就是这样），于是谁都不让、整列不动（实测只解开 2/6）。
       */
      const oy = yieldOf(occ, next % s.w, Math.floor(next / s.w));
      const occCell = occ.y * s.w + occ.x;
      let out: number | null = null;
      let outD = Infinity;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nx = occ.x + dx;
        const ny2 = occ.y + dy;
        if (nx < 0 || ny2 < 0 || nx >= s.w || ny2 >= s.h) continue;
        const k2 = ny2 * s.w + nx;
        if (k2 === u.y * s.w + u.x) continue; /* 别让到被挡那个人身上 */
        if (s.units.some((v) => v.y * s.w + v.x === k2)) continue; /* 得是空格 */
        if (takenOut.has(k2)) continue;
        if (yieldOf(occ, nx, ny2) < oy) continue; /* 让了会降产 → 不考虑 */
        const d = field[k2] ?? Infinity;
        if (d < outD) {
          outD = d;
          out = k2;
        }
      }
      void occCell;
      if (out === null) break;
      takenOut.add(out);
      shifted.add(occ.id);
      posts[occ.id] = { x: out % s.w, y: Math.floor(out / s.w) };
      break;
    }
  }

  /*
   * **行动顺序：靠自己岗位近的排在前面（链条末端先动）。**
   *
   * 这里给的"远近"是**真实步数**（`stepsFrom`，绕水绕山、不算人），不是直线距离。
   * 直线距离会把"看着近、其实要绕一大圈"的人排到前面，他先动反而把路堵住。
   *
   * 只在有岗的人之间排序；没岗的排在最后（它们这一手本来就不该动）。
   */
  const order = [...econ]
    .map((u) => {
      const p = posts[u.id];
      if (!p) return { id: u.id, d: Infinity };
      const d = p.x === u.x && p.y === u.y ? 0 : (world.stepsFrom(p)[u.y * s.w + u.x] ?? Infinity);
      return { id: u.id, d };
    })
    .sort((a, b) => a.d - b.d || (a.id < b.id ? -1 : 1))
    .map((x) => x.id);

  return { posts, next, order };
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
    econOrder: econPlan.order,
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
