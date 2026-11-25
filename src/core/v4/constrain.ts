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
import { boardOf, boardIdOf } from '../board.ts';
import { passable } from '../config.ts';
import { attackableTargets, effectiveStats, previewAttack, reachableTiles, threatTiles } from '../rules.ts';
import { utype } from '../rules.ts';
import type { City } from '../types.ts';
import type { GameState, Unit } from '../types.ts';
import { DECIDE_HORIZON } from './decide.ts';
import type { Constraints, Decision, Squad, SquadTactics, V4Memory } from './types.ts';
import type { World } from './world.ts';

/**
 * **所有距离用曼哈顿距离**（`|dx| + |dy|`）：游戏里移动是四邻，斜着走一步要花两步，
 * 所以斜向的格子不能算"更近"。
 *
 * 判"要走几步"时不要用这个——那是距离场的事（`world.stepsFrom`，绕水绕山）。
 * 这里只用于"粗比远近"和"半径内有没有人"。
 */
const manhattan = (a: { x: number; y: number }, b: { x: number; y: number }): number =>
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
function planTactics(s: GameState, ids: string[], canMove: boolean): SquadTactics | undefined {
  /*
   * **战术模式**（2026-11-25）：只有"这一手有一个值得全队一起办的目标"才打开。
   *
   * 打开之后打分层才被允许做两件事：全队打同一个（`focusId`）、为它挪一步（`converge`）。
   * 关着 = 行为与没有这个开关时一字不差（照约束执行、打射程内的）。
   * 这就是"不退回 v1/v3 那种任何时候都在打分"的那道闸。
   *
   * `canMove` 决定"走一步再打"算不算进伤害：进攻队算，守队不算（它不许离开城）。
   */
  const mine = ids
    .map((id) => s.units.find((u) => u.id === id))
    .filter((u): u is Unit => !!u && u.owner === s.current && (effectiveStats(s, u).atk ?? 0) > 0);
  if (mine.length < 2) return undefined;

  /** 每个兵这一手的两笔账：能打到的敌人（含走一步）、以及现在就能不能打到人 */
  const perUnit = mine.map((u) => {
    const spots: Unit[] = [u];
    if (canMove) {
      for (const [k] of reachableTiles(s, u)) {
        if (k === u.y * s.w + u.x) continue;
        spots.push({ ...u, x: k % s.w, y: Math.floor(k / s.w), moved: true } as Unit);
      }
    }
    /* 同一个敌人，这个兵最多能打出多少（多格取最大，不累加） */
    const hits = new Map<string, number>();
    for (const from of spots) {
      for (const foe of attackableTargets(s, from)) {
        if (foe.owner === u.owner) continue;
        const dmg = previewAttack(s, from, foe).toDefender;
        if (dmg <= 0) continue;
        hits.set(foe.id, Math.max(hits.get(foe.id) ?? 0, dmg));
      }
    }
    /* 原地能打到谁（不只是能打多少）——"这个兵这一手有没有别的仗打" */
    const nowFoes = new Map<string, number>();
    for (const foe of attackableTargets(s, u)) {
      if (foe.owner === u.owner) continue;
      const dmg = previewAttack(s, u, foe).toDefender;
      if (dmg > 0) nowFoes.set(foe.id, dmg);
    }
    return { id: u.id, hits, nowFoes };
  });

  /*
   * 汇总成"每个敌人"的账：
   *   `n`      —— 有几个兵够得着它（含走一步）
   *   `dmg`    —— 这些人合计能打多少
   *   `dmgNow` —— **原地不动**就能打多少
   *   `dmgIdle`—— 只算"这一手本来就没仗可打"的兵能补多少（见 `converge`）
   */
  const reach = new Map<string, { n: number; dmg: number; dmgNow: number; dmgIdle: number; dmgIdleMax: number; hp: number }>();
  for (const p of perUnit) {
    const idle = p.nowFoes.size === 0;
    for (const [fid, dmg] of p.hits) {
      const foe = s.units.find((x) => x.id === fid);
      if (!foe) continue;
      const rec = reach.get(fid) ?? { n: 0, dmg: 0, dmgNow: 0, dmgIdle: 0, dmgIdleMax: 0, hp: foe.hp };
      rec.n += 1;
      rec.dmg += dmg;
      rec.dmgNow += p.nowFoes.get(fid) ?? 0;
      if (idle) {
        rec.dmgIdle += dmg;
        rec.dmgIdleMax = Math.max(rec.dmgIdleMax, dmg);
      }
      reach.set(fid, rec);
    }
  }

  /* 至少两个兵能打到同一个，才谈得上"合打" */
  const rows = [...reach.entries()].filter(([, r]) => r.n >= 2);
  if (rows.length === 0) return undefined;

  /* ① 这一手能收掉的 → 挑血最少的（省手）；② 否则挑"伤害/血量"最高的 */
  const killable = rows.filter(([, r]) => r.dmg >= r.hp);
  const pick = killable.length > 0
    ? killable.sort((a, b) => a[1].hp - b[1].hp)[0]!
    : [...rows].sort((a, b) => b[1].dmg / b[1].hp - a[1].dmg / a[1].hp)[0]!;

  /*
   * 门槛：打不死、又打不掉一半的，**别为它改变动作**。
   * 没有这一条，只要场上有人就永远"有战术模式"，等于开关常开。
   */
  if (pick[1].dmg < pick[1].hp * 0.5) return undefined;

  /*
   * **要不要为这个目标挪一步**（2026-11-25，第 4 步）。两条同时成立才开：
   *
   * ① **已经在打它了，但原地打不死**（`0 < dmgNow < hp`）；
   * ② **再补一个闲人那一下就收**（`dmgNow + dmgIdleMax ≥ hp`，只算"本来没仗可打"的兵，
   *    而且只算**一个人**的量）。
   *
   * ② 的"一个人"很关键：写成"闲着的都算"会变成"从零开始集火"——
   * S-017 第 1 手就是这样：没人够得着那个目标（`dmgNow = 0`）、七个闲人合计 73 够
   * 24 血，于是全军被拽过去，清场反而慢了一手。
   *
   * ② 是 S-017 逼出来的。只写①的时候它从绿变红（6 手清场 4 → 3）：那一局里"补一刀"的兵
   * 手上明明还有别的守军可打，把它拽过来等于让另一个敌人多活一轮。
   * 清场要的是散开、一人盯一个；只有**闲着的人**去补刀才不亏。
   *
   * 判据放在约束层、和 `focusId` 同一个开关里，打分层只执行不判断——
   * 和"是否集火"一个道理：条件不满足就不开，不在执行层加例外。
   */
  const converge =
    canMove &&
    pick[1].dmgNow > 0 &&
    pick[1].dmgNow < pick[1].hp &&
    pick[1].dmgNow + pick[1].dmgIdleMax >= pick[1].hp;

  return {
    focusId: pick[0],
    converge,
    why: converge
      ? `补一刀就收：原地 ${Math.round(pick[1].dmgNow)} + 一个闲人 ${Math.round(pick[1].dmgIdleMax)} ≥ 它 ${Math.round(pick[1].hp)} 血`
      : `${pick[1].n} 个兵能打到 ${pick[0]}：合计 ${Math.round(pick[1].dmg)} / 它 ${Math.round(pick[1].hp)} 血${canMove ? '' : '（守队不挪位）'}`,
  };
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
  const { dist, prev } = world.field(seeds, { through: 'units', maxDist: 6, prev: true });

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

  const front = [...us].sort((a, b) => manhattan(a, city) - manhattan(b, city))[0]!;
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
     * ════════════════════════════════════════════════════════════════
     * **建链搬运：一张反向场 + 一条链，从洞那一端依次递补。**
     *
     * ── 为什么是"反向" ──────────────────────────────────────────
     *
     * 起点是**洞（空岗）**，波**穿过人群**往外扩。于是每一格的"距离"读作
     * "这格离最近的洞隔着几个人"，"前驱"读作"往洞那边退一格"。
     * 这个方向天然就是"让人群朝洞塌陷"——一次能整列一起挪。
     *
     * 反过来用（起点是人、只走空格）算出来的是"这些人自己能走到哪"，
     * 那是行军用的，搬不动人。
     *
     * ── 链怎么用 ────────────────────────────────────────────────
     *
     * 对一个"这一手走不动"的兵，从它脚下顺着前驱往洞走：
     *
     *     洞 ← c1 ← c2 ← … ← 这个兵
     *
     * 中间每一格都站着人（空的格本来就是洞，不会出现在中间）。然后**从洞那一端开始**
     * 依次递补：c1 进洞、c2 进 c1、……、这个兵进前一格。
     * 每次落点都是上一个人刚腾出来的格——引擎没有"交换两人位置"，只能这样。
     *
     * ── 三条边界 ────────────────────────────────────────────────
     *
     * · 只搬经济兵（战斗兵有自己的任务）；
     * · 链上一格一人（`usedCells`），一个人一回合只被搬一次（`movedUnits`）；
     * · **没有洞就什么都不做**——那不是"再想想办法"，是"真满了"。
     * ════════════════════════════════════════════════════════════════
     */
    const holeCells = cands
      .filter((p) => !s.units.some((v) => v.y * s.w + v.x === p.y * s.w + p.x))
      .map((p) => p.y * s.w + p.x);
    if (holeCells.length > 0) {
      /* 唯一的场：多源（所有洞）、穿过人群、带前驱 */
      const flow = world.field(holeCells, { through: 'units', prev: true });
      const queued = [...units].filter(
        (u) => posts[u.id] && !(posts[u.id]!.x === u.x && posts[u.id]!.y === u.y),
      );

      /*
       * ── 第一步：**先把所有链建出来**，一条都先不执行 ──────────────
       *
       * 以前是"边建边执行"，于是先建的那条把格子占了，后面的链走到一半发现
       * 目标被占，在中途 `break` —— 结果是**半条链**：前面几个人挪了，后面没挪，
       * 空出来的格反而被别的链占了，越搞越乱。
       */
      const chains: Array<{ u: Unit; from: number; cells: number[] }> = [];
      for (const u of queued) {
        const from0 = u.y * s.w + u.x;
        /* 这一手走得动吗？走得动就自己走，不建链 */
        const own = world.stepsFrom(posts[u.id]!);
        const here = own[from0] ?? Infinity;
        let canWalk = false;
        for (const [k] of reachableTiles(s, u)) {
          const x = k % s.w;
          const y = (k - x) / s.w;
          if (s.units.some((v) => v.id !== u.id && v.x === x && v.y === y)) continue;
          if ((own[k] ?? Infinity) < here) {
            canWalk = true;
            break;
          }
        }
        if (canWalk) continue;

        /* 顺着前驱往洞走，走到**第一个空格**为止（不必正好是空岗） */
        const cells: number[] = [];
        let k = from0;
        let sink = false;
        for (let guard = 0; guard < 12; guard++) {
          const p = flow.prev[k]!;
          if (p < 0) break;
          cells.push(p);
          k = p;
          if (!s.units.some((v) => v.y * s.w + v.x === k)) {
            sink = true;
            break;
          }
        }
        if (!sink || cells.length === 0) continue;
        chains.push({ u, from: from0, cells });
      }

      /*
       * ── 第二步：**短的先成立，抢不到就整条放弃** ──────────────────
       *
       * 短链先占位，长链让路——短链通常贴着洞，挪得动；长链横跨人群，
       * 一旦和已成立的链撞格，就说明这一手它过不去。
       * 这时**整条放弃**（而不是中途截断）：截断会留下"半条链"，
       * 前面的人挪了、后面的人没挪，空出来的格又被别人占掉。
       */
      chains.sort((a, b) => a.cells.length - b.cells.length || (a.u.id < b.u.id ? -1 : 1));
      const usedCells = new Set<number>();
      const movedUnits = new Set<string>();
      for (const ch of chains) {
        /* 冲突检查（先看，不动手）：链上每一格是否还能用 */
        let ok = true;
        for (let idx = 0; idx < ch.cells.length; idx++) {
          const cell = ch.cells[idx]!;
          if (usedCells.has(cell)) {
            ok = false;
            break;
          }
          const isSink = idx === ch.cells.length - 1;
          const occ = s.units.find((v) => v.y * s.w + v.x === cell);
          if (isSink) {
            if (occ) {
              ok = false;
              break;
            }
          } else {
            if (!occ || occ.owner !== world.me) {
              ok = false;
              break;
            }
            if (utype(s, occ.type).category !== 'economy') {
              ok = false;
              break;
            }
            if (movedUnits.has(occ.id)) {
              ok = false;
              break;
            }
          }
        }
        if (!ok) continue; /* 整条放弃，这一手它不动 */
        if (usedCells.has(ch.from)) continue;

        /* 执行：从洞那一端往人这一端递补 */
        for (let idx = ch.cells.length - 1; idx >= 1; idx--) {
          const to = ch.cells[idx]!;
          const mover = s.units.find((v) => v.y * s.w + v.x === ch.cells[idx - 1]!);
          if (!mover || mover.owner !== world.me) continue;
          posts[mover.id] = { x: to % s.w, y: Math.floor(to / s.w) };
          movedUnits.add(mover.id);
        }
        /* 最后是这个兵自己走进链头 */
        posts[ch.u.id] = {
          x: ch.cells[0]! % s.w,
          y: Math.floor(ch.cells[0]! / s.w),
        };
        movedUnits.add(ch.u.id);
        for (const cell of ch.cells) usedCells.add(cell);
        usedCells.add(ch.from);
      }
    }
  }

  /*
   * ③ 下一个该造谁：表里还没人认领的格里，**产出最高的那一个；产出相同取近的**。
   *
   * 为什么不是"赚回几倍造价"（试过，卡住过）：那个口径偏爱便宜兵——
   * 牧民 8 金 ÷ 45 比伐木工 12 金 ÷ 70 略好，于是永远先买牧民，
   * 两格森林一次都没用上，总产反而低。
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
    const guard = world.foeCombat.filter((u) => manhattan(u, c) <= 6);
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
      tactics: planTactics(s, squadIds, true),
      ...(planLanes(s, world, squadIds, n.city) ?? {}),
    });
  }
  return out;
}

/**
 * 一支队伍"这一手该站哪些格"——终点集合。
 *
 * 目标是城时，终点是**城外可站的格**（城格站不上）；目标是集结点时，终点是它周围。
 * 半径 2 是"城下那一圈"：射程 1~2 的兵都能从这儿够到城。
 */
/** 一支队伍"该往哪个点聚"：集结点，或目标城的中心。 */
function squadBase(s: GameState, sq: Squad): { x: number; y: number } | undefined {
  if (sq.at) return sq.at;
  const city = sq.cityId ? s.cities.find((c) => c.id === sq.cityId) : undefined;
  return city
    ? { x: city.x + Math.floor((city.size ?? 2) / 2), y: city.y + Math.floor((city.size ?? 2) / 2) }
    : undefined;
}

/**
 * **战斗单位这一手走哪一格：多起点 → 多终点，一次排定。**
 *
 * ── 为什么不是每人自己 `stepToward` ────────────────────────────
 *
 * 每个兵只看自己：我离目标更近的那格站着人 → 我不动；他也这么想 → 谁也不动。
 * 30 个兵挤成一条线时，整条线只会在原地互相等。
 *
 * ── 这一版怎么排 ──────────────────────────────────────────────
 *
 * 1. 终点 = 目标城外**面向我们**的那一圈（见 `targetCells`）；
 * 2. 人和终点都按"到目标城的真实步数"排一遍，**同序配对**：
 *    离城近的兵配离城近的格，离城远的配远处的格。
 *
 *    这一步同时管两件事：
 *      · **不交叉**——两边同一条轴排序后配对，任何两条线交换都会让总路程变大，
 *        所以同序就是最优且不自交的那一组；
 *      · **链长接近**——每人要走的路约等于"两列分布之差"，是一条几乎等长的横队，
 *        整体平移过去，而不是"最近的先冲、远的干等"（那种会一个一个送）。
 *
 * 3. **离城近的先走**（前排先挪开，后排才有位置），落点去重。
 */
function planMarch(
  s: GameState,
  world: World,
  squads: Squad[],
): { steps: Record<string, { x: number; y: number }>; order: string[] } {
  const out: Record<string, { x: number; y: number }> = {};
  const order: string[] = [];
  for (const sq of squads) {
    if (sq.order === 'hold') continue;
    const base = squadBase(s, sq);
    if (!base) continue;
    const units = sq.unitIds
      .map((id) => s.units.find((u) => u.id === id))
      .filter((u): u is Unit => !!u && u.owner === world.me);
    if (units.length === 0) continue;

    /* 这一队所在的图（多图下别拿地球的格表去查月球的兵） */
    const tiles = boardOf(s, boardIdOf(units[0]!)).tiles;
    const toBase = world.stepsFrom(base);
    const axisOf = (u: Unit): number => toBase[u.y * s.w + u.x] ?? Infinity;
    const pending = units.filter((u) => axisOf(u) > 0);
    if (pending.length === 0) continue;

    /*
     * **按"这一排干什么活"分排，不按兵种。**
     *
     * 判据是**射程**：射程 1 的顶上去、射程 2 的跟在中排、射程 3 以上在后排打输出。
     * 同一排里的人移动力天然接近（骑兵 4 / 步兵 2），所以排内不会出现"快的等慢的"。
     *
     * 这样也不会"所有兵聚成一团"：每排有**自己的**紧凑阵位，排与排的阵位互不重叠。
     */
    /*
     * **窄道（桥、关隘）不收拢，排队走。**
     *
     * 收拢的前提是"并排站得下"。桥面只有一格宽，硬排方块等于把人摊在桥头，
     * 整队卡死（S-005 实测：收拢版从绿变红）。宽度用现成的 `corridorWidth`，
     * 不是拍的数字。
     */
    const front = [...pending].sort((a, b) => axisOf(a) - axisOf(b) || (a.id < b.id ? -1 : 1))[0]!;
    /*
     * 路上有没有桥/窄口：从前锋顺着"到城的步数"往下走，遇到桥就是窄道。
     * 只看终点附近的宽度测不到——城门口是开阔的，窄的是半路上的桥。
     */
    let narrow = world.corridorWidth({ x: front.x, y: front.y }, base) <= 2;
    for (let k = front.y * s.w + front.x, guard = 0; !narrow && guard < 40; guard += 1) {
      if (tiles[k]?.terrain === 'bridge') {
        narrow = true;
        break;
      }
      if ((toBase[k] ?? 0) <= 0) break;
      let next = k;
      let bestD = toBase[k] ?? Infinity;
      const x0 = k % s.w;
      const y0 = (k - x0) / s.w;
      for (const [ox, oy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nx = x0 + ox;
        const ny = y0 + oy;
        if (nx < 0 || ny < 0 || nx >= s.w || ny >= s.h) continue;
        const nk = ny * s.w + nx;
        const d = toBase[nk] ?? Infinity;
        if (d < bestD) {
          bestD = d;
          next = nk;
        }
      }
      if (next === k) break;
      k = next;
    }
    if (narrow) {
      /*
       * 窄道**整队交给打分层**（`stepToward`）：桥面一次过一个人，
       * 排队的事它本来就比自己再实现一遍做得好（S-005 的过河数就是这么保住的）。
       */
      continue;
    }

    /*
     * **这一手能打到人，就不排阵型了。**
     *
     * 队形是为了"走路时不被各个击破"；一旦能开火，按阵位走反而会错过攻击位
     * （前排被要求站到方块里，而它本来站的地方就能打到人）。
     * `threatTiles` 给的是"这个兵这一手能打到的所有格"（可达格 + 每个落点的射程），
     * 所以拿它跟敌人位置一比，就是"移动之后能不能打到"。
     */
    const engaged = units.some((u) => {
      const t = threatTiles(s, u);
      return world.foeCombat.some((f) => t.has(f.y * s.w + f.x));
    });
    if (engaged) {
      /* 接敌：各自找最靠近敌人的位置，不排阵型 */
      const usedF = new Set<number>();
      for (const u of [...pending].sort((a, b) => axisOf(a) - axisOf(b) || (a.id < b.id ? -1 : 1))) {
        const here = toBase[u.y * s.w + u.x] ?? Infinity;
        let best: number | null = null;
        let bestD = here;
        for (const [k] of reachableTiles(s, u)) {
          if (s.units.some((v) => v.id !== u.id && v.y * s.w + v.x === k)) continue;
          if (usedF.has(k)) continue;
          const d = toBase[k] ?? Infinity;
          if (d < bestD) {
            bestD = d;
            best = k;
          }
        }
        if (best === null) continue;
        out[u.id] = { x: best % s.w, y: Math.floor(best / s.w) };
        usedF.add(best);
        order.push(u.id);
      }
      continue;
    }

    const rows = new Map<number, Unit[]>();
    for (const u of pending) {
      const r = effectiveStats(s, u).range ?? 1;
      const k = r <= 1 ? 0 : r === 2 ? 1 : 2;
      const arr = rows.get(k) ?? [];
      arr.push(u);
      rows.set(k, arr);
    }

    const used = new Set<number>();
    /* 落点也要去重：两个人算到同一格时，后一个执行会"不可达"，就退回乱走了 */
    const taken = new Set<number>();
    for (const [, row] of [...rows.entries()].sort((a, b) => a[0] - b[0])) {
      const n = row.length;
      const cx = Math.round(row.reduce((a, u) => a + u.x, 0) / n);
      const cy = Math.round(row.reduce((a, u) => a + u.y, 0) / n);
      const moves = row.map((u) => effectiveStats(s, u).move ?? 2);
      const maxMove = Math.max(...moves);
      /* 方块边长：这一排挤成正方形要几格宽（由人数决定，不是拍的） */
      const side = Math.max(1, Math.ceil(Math.sqrt(n)));
      /*
       * 现在是不是已经是一团：谁离排中心超过"方块半径"，就说明还散着。
       * 散着 → 这一手只前移一格（把边缘的人吸回来）；成型了 → 走满推进。
       */
      const spread = Math.max(
        ...row.map((u) => Math.abs(u.x - cx) + Math.abs(u.y - cy)),
      );
      const formed = spread <= side;

      const dx = base.x - cx;
      const dy = base.y - cy;
      const dir =
        Math.abs(dx) >= Math.abs(dy)
          ? { x: Math.sign(dx) || 1, y: 0 }
          : { x: 0, y: Math.sign(dy) || -1 };
      const ahead = formed ? maxMove : 1;
      const aim = { x: cx + dir.x * ahead, y: cy + dir.y * ahead };

      /* 阵位 = 离"新中心"最近的 n 个可站格（这一排的紧凑方块） */
      const slots: number[] = [];
      for (let r = 0; r <= 8 && slots.length < n; r += 1) {
        for (let oy = -r; oy <= r; oy += 1) {
          for (let ox = -r; ox <= r; ox += 1) {
            if (Math.abs(ox) + Math.abs(oy) !== r) continue;
            const x = aim.x + ox;
            const y = aim.y + oy;
            if (x < 0 || y < 0 || x >= s.w || y >= s.h) continue;
            const k = y * s.w + x;
            if (used.has(k)) continue;
            const t = tiles[k];
            if (!t || !passable(t.terrain) || t.terrain === 'city') continue;
            /* 敌人占着的格不能当阵位（那是要打的地方，不是要站的地方） */
            if (s.units.some((v) => v.owner !== world.me && v.y * s.w + v.x === k)) continue;
            slots.push(k);
            if (slots.length >= n) break;
          }
        }
      }
      if (slots.length === 0) continue;

      /*
       * **同序配对**：人按"离城远近"排，阵位也按"离城远近"排，序号对序号。
       * 两边都是同一条轴上单调的，所以路线不会交叉；散开的一排会被吸成方块。
       */
      const rowSorted = [...row].sort(
        (a, b) => axisOf(a) - axisOf(b) || (a.id < b.id ? -1 : 1),
      );
      const slotSorted = [...slots].sort((a, b) => {
        const da = toBase[a] ?? Infinity;
        const db = toBase[b] ?? Infinity;
        return da - db || a - b;
      });

      for (let idx = 0; idx < rowSorted.length && idx < slotSorted.length; idx += 1) {
        const u = rowSorted[idx]!;
        const slot = slotSorted[idx]!;
        used.add(slot);
        const field = world.stepsFrom({ x: slot % s.w, y: Math.floor(slot / s.w) });
        const here = field[u.y * s.w + u.x] ?? Infinity;
        let best: number | null = null;
        let bestD = here;
        for (const [k] of reachableTiles(s, u)) {
          if (s.units.some((v) => v.id !== u.id && v.y * s.w + v.x === k)) continue;
          if (taken.has(k)) continue;
          const d = field[k] ?? Infinity;
          if (d < bestD) {
            bestD = d;
            best = k;
          }
        }
        if (best === null) continue;
        out[u.id] = { x: best % s.w, y: Math.floor(best / s.w) };
        taken.add(best);
        order.push(u.id);
      }
    }
  }
  return { steps: out, order };
}

export function constrain(s: GameState, world: World, decision: Decision, mem?: V4Memory): Constraints {
  const city = decision.cityId ? s.cities.find((c) => c.id === decision.cityId) : undefined;
  const keepClear = [...world.keepClear];
  const keepSet = new Set(keepClear);

  const squads: Squad[] = [];

  /*
   * 守军：每座**真的会被摸到**的城留 2 个最近的兵，任务 hold。留谁按"离城近"排，不按分数。
   *
   * **2026-11-25 改（修 9.7）：先问一句"敌人来不来得及"，再来不及就不留人。**
   *
   * 原来这里是 `role === 'home'` 无条件 `slice(0, 2)`——只要我只有一座城，就永远留 2 个，
   * 不管敌人离城 7 回合还是场上一个敌兵都没有。于是：
   *   · S-016（空城、无敌人）8 个兵被扣 2 个，第 4 手城伤只有 33（v1/v3 是 69）；
   *   · T-1（接管废墟）1 个兵时唯一的兵被扣走，`captureId` 为空，接管根本发不出去。
   *
   * 现在读 `foeEta`（敌人最快几回合摸到城）：**下一手就能摸到**才留。
   * 不留人不是"不设防"——兵本来就在场，该回防的回合 `defend` 会把他们叫回来；
   * 提前两个回合钉住 2 个人，只是让主力少两个人。
   */
  const held = new Set<string>();
  for (const info of world.cities) {
    if (info.role !== 'threatened' && info.role !== 'home') continue;
    if (info.foeEta > 1) continue; /* 敌人一时来不了 → 一个都不留 */
    const guards = world.myCombat
      .filter((u) => !held.has(u.id))
      .sort((a, b) => manhattan(a, info.city) - manhattan(b, info.city))
      .slice(0, 2);
    for (const g of guards) held.add(g.id);
    if (guards.length > 0) {
      squads.push({
        id: `hold-${info.city.id}`,
        order: 'hold',
        unitIds: guards.map((g) => g.id),
        cityId: info.city.id,
        /* 守军也要集火（X-1-01 量出来的）：但**不许挪**——离开城就没护甲、也守不住 */
        tactics: planTactics(s, guards.map((g) => g.id), false),
      });
    }
  }

  /*
   * **站在关键格上的兵：不在主队里，但有一个任务叫"让开"**（2026-11-25，清 9.14）。
   *
   * 它们原来是被**摘出所有队伍**：这一手"没有任何任务"，不报错、不复盘、日志里看不见，
   * 回放里就是"它突然不动了"。现在改成给一个明确的 `yield` 任务（见下面 push 的那支队），
   * 行为不变（它们本来也不跟着主队走），但看得见、说得清。
   *
   * **为什么不让它们直接留在主队里**：试过，S-001（该赢的必须赢）从绿变红——
   * 它们一进主队，就成了 `march` 的一员，`planYield` 的"正在执行的兵不算挡路"会把它们保护起来，
   * 于是谁都不去腾格子；而且主队人数虚高，`ready`（`ids.length >= want`）提前成立，队伍早发。
   * 这两个副作用都比"多一个任务名"贵。
   */
  const blockers = world.myCombat.filter((u) => keepSet.has(u.y * s.w + u.x));
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
    world.foeCombat.some((u) => manhattan(u, info.city) <= 8),
  );
  /*
   * **接管废墟**（`decision.kind === 'takeover'`）：三件事一起定。
   *
   *   · clear：主力照打（走 march，路上遇敌就打），不攒钱——清场要花钱；
   *   · save ：主力守住废墟附近（hold），采购上限压到"金币 − 重建费"；
   *   · enter：从主力里挑**一个**兵走进城格，其余继续守。
   */
  let captureId: string | undefined;
  let captureTarget: { x: number; y: number } | undefined;
  let spendCap: number | undefined;
  if (decision.kind === 'takeover' && city) {
    const center = {
      x: city.x + Math.floor((city.size ?? 2) / 2),
      y: city.y + Math.floor((city.size ?? 2) / 2),
    };
    captureTarget = center;
    const cost = world.ruinCost(city);
    const gold = s.players[world.me]?.gold ?? 0;
    if (decision.stage !== 'clear') spendCap = Math.max(0, gold - cost);
    if (decision.stage === 'enter') {
      /*
       * 派**离废墟最近的那个**去，不派"最强/最贵"的。
       * 走进废墟只看"能不能站进去 + 付不付得起"，谁去都一样；
       * 最近的那个少走两步，被路上的炮打的机会也最少。
       */
      const field = world.stepsFrom(center);
      const pick = [...rest].sort(
        (a, b) =>
          (field[a.y * s.w + a.x] ?? Infinity) - (field[b.y * s.w + b.x] ?? Infinity) ||
          (a.id < b.id ? -1 : 1),
      )[0];
      if (pick) captureId = pick.id;
    }
    squads.push({
      id: 'main',
      order: decision.stage === 'clear' ? 'march' : 'hold',
      unitIds: rest.filter((u) => u.id !== captureId).map((u) => u.id),
      cityId: city.id,
    });
  } else if (threatened.length >= 2 && rest.length >= threatened.length * 2) {
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
    const guard = world.foeCombat.filter((u) => manhattan(u, city) <= 6);
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
    const detour = leadUnit ? world.marchTurns(leadUnit, city) > manhattan(leadUnit, city) + 2 : false;
    squads.push({
      id: 'main',
      /* clear 段打人（march），siege 段砸城；人还没到齐就先收拢 */
      order: ready ? (decision.stage === 'clear' ? 'march' : 'siege') : 'assemble',
      unitIds: ids,
      cityId: city.id,
      at: ready ? undefined : assemblePoint(s, world, city.id),
      want: keepWant,
      eta: Number.isFinite(eta) ? eta : 99,
      /* 集火点：这一手全队打同一个。出发前（assemble）也照样选，等于"边收拢边集火" */
      tactics: planTactics(s, ids, ready && decision.stage === 'clear'),
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
      /* 召回：先回城（S-004 的规矩），所以只给集火、不给挪位 */
      tactics: planTactics(s, rest.map((u) => u.id), false),
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
   * **有敌人就按"够用"筛，不再看人数。**（2026-11-25，P1）
   *
   * 原来这里有一道 `outnumbered = myCombat.length <= foes.length`——只有"人数不占优"
   * 才启用质量门槛。那是个正反馈陷阱：**买便宜兵 → 人数上去了 → 门槛关掉 → 继续买便宜兵**。
   * 实测 S-001 造 21 个 1 代民兵、S-002 造 45 个、S-011 造 8 个（`V4-CODE-MAP` 9.17）。
   *
   * 用户 2026-11-25 的判断："人数明显占优时仍允许堆量"这句话本身有问题——
   * 人类会去**基建出最强的单位来堆**，不会靠"血少攻低的单位"堆：
   * 血少的会被带溅射的一次清掉，攻低的完全打不动高护甲。
   * 所以人数不再参与"要不要讲质量"的判断；"堆不堆量"是**数量够不够**的问题，
   * 由需求（`planMains` 的 want）管，不该混进采购。
   *
   * ⚠️ S-002 当年正是因为这条门槛从绿变红，才写下"数量就是答案"。用户 2026-11-25 澄清：
   * 那道题太综合、他打都不需要造新兵，所以那个结论不成立，**不要为它保留例外**。
   */
  /*
   * **闸 1：打得穿吗**（2026-11-25，P2-2a）
   *
   * 判据：拿这个兵种打**多数决目标**（数量最多的那一类敌人），
   * `previewAttack` 的伤害 ×3 ≥ 目标的血——**三发能打穿它**。
   *
   * 为什么不是"伤害 ≥1"：那太松，民兵对 4 代戟兵一发 8、46 血要 6 发才倒，
   * 实测就是"造了一堆打不动的"（S-001 一度从绿变红）。
   *
   * 为什么沿用 3 而不是 4 或 6：P1 已经用"三发打穿"验证过整套行为（S-012 转绿、
   * S-001 损 13）。2a 只换**算法**（`atk−armor` → `previewAttack`，让破甲算进来），
   * 不动阈值——一次只改一件事，否则读数变了不知道是哪个造成的。
   *
   * 为什么用 `previewAttack` 而不是 `atk − armor`：引擎的能力（破甲 7 个兵有、
   * 盾墙）都在它里面。实测火枪打坦克：23−10=13，但 `previewAttack` 给 16（破甲生效）。
   *
   * 为什么对"多数决"而不是"最硬"：混编里放一个坦克，按最硬判会把所有候选都否掉，
   * 结果是一手不造、被杂兵推平。**打不动硬点不等于没输出**，硬点交给破甲兵或绕开。
   *
   * 伤害与攻方位置无关（实测四个位置结果一致），所以这里用模板单位算，不需要真单位。
   */
  const mainFoe = (() => {
    const byType = new Map<string, { n: number; u: (typeof foes)[number] }>();
    for (const u of foes) {
      const rec = byType.get(u.type) ?? { n: 0, u };
      rec.n += 1;
      /* 同类型里取血最厚的那个当代表（同一兵种血量可能不同） */
      if (u.hp > rec.u.hp) rec.u = u;
      byType.set(u.type, rec);
    }
    return [...byType.values()].sort((a, b) => b.n - a.n || b.u.hp - a.u.hp)[0]?.u;
  })();
  const usable = mainFoe
    ? Object.values(s.unitTypes)
        .filter((d) => d.category === 'combat')
        .filter((d) => {
          const probe = {
            id: '__probe',
            owner: s.current,
            type: d.id,
            x: mainFoe.x,
            y: mainFoe.y,
            hp: d.maxHp,
          } as Unit;
          return previewAttack(s, probe, mainFoe).toDefender * 3 >= mainFoe.hp;
        })
        .map((d) => d.id)
    : [];
  /*
   * **闸 2：活得到吗**（2026-11-25，P2-2b；用户给的口径）
   *
   * 只算**在敌方射程内走的那一段**：
   *   暴露距离 = 敌方射程 − 我的射程        （≥0 才有意义；我的射程更长就不用走进来）
   *   暴露手数 = ceil(暴露距离 / 我的移动力)
   *   挨打     = 暴露手数 × 敌方单发 × burst
   *   活得到   = 挨打 < 我的血
   *
   * 为什么不从"城"算起：从城到战场那段在敌方射程外，**不挨打**，计进去等于把
   * "路远"当成"会死"，会把所有兵都否掉。用户的原话是"从敌方射程外的一格走到敌人位置"。
   *
   * 为什么这个口径能复用到进攻：进攻时同样是"穿过对面的射程去够它"，同一个式子。
   *
   * 移动力在这里才是真的有用：骑手（移动 3）穿过 3 格暴露区只要 1 手，
   * 长枪（移动 2）要 2 手——同样的距离，一个活一个死。这正是"移动快"的价值。
   */
  const survivable = mainFoe
    ? Object.values(s.unitTypes)
        .filter((d) => d.category === 'combat')
        .filter((d) => {
          const mine = {
            id: '__probe2',
            owner: s.current,
            type: d.id,
            x: mainFoe.x,
            y: mainFoe.y,
            hp: d.maxHp,
          } as Unit;
          /* 敌方打我一发多少（注意方向：攻方是敌人，守方是我） */
          const hit = previewAttack(s, mainFoe, mine).toDefender;
          if (hit <= 0) return true;
          const gap = Math.max(0, (utype(s, mainFoe.type).range ?? 1) - (d.range ?? 1));
          const steps = Math.ceil(gap / Math.max(1, d.move ?? 1));
          const burst = utype(s, mainFoe.type).burst ?? 1;
          return steps * hit * burst < d.maxHp;
        })
        .map((d) => d.id)
    : [];
  const need =
    foes.length > 0
      ? {
          /** 对多数决目标"三发能解决"的兵种（闸 1 的唯一口径） */
          usable,
          /** 穿过敌方射程时活不下来的兵种（闸 2：见上面的 `survivable`） */
          survivable,
          /*
           * **能不能"充数"**（2026-11-25，用户原话）：
           * "敌方射程大但无溅射无多段 → 最后才是用许多不符合要求的兵充数、以伤换伤；
           *  但敌方有多段或溅射，连这条也要排除，得尽量散开。"
           *
           * 所以"买一堆打不动的便宜兵"不是无条件的兜底：
           * 敌方有**溅射**（一发清一片）或**多段**（一回合多次）时，充数是负资产。
           * 这条只影响"没有候选时要不要凑数"，不影响正常挑选。
           */
          canPad: !foes.some((u) => {
            /* 溅射/多段是兵种自身属性，`effectiveStats` 不带它们，直接读定义 */
            const d = utype(s, u.type);
            return (d.splash ?? 0) > 0 || (d.burst ?? 1) > 1;
          }),
          /* 对面最大射程：压不过它就没有"先手"，排序要改比血（见 tactics 的 byRange） */
          range: foes.reduce((n, u) => Math.max(n, effectiveStats(s, u).range ?? 1), 0),
        }
      : undefined;

  const econPlan = planEconPosts(s, world, mem);
  /*
   * 这一手"有没有人真要用关键格"——决定要不要赶人（见 `planYield` 顶部）。
   *
   * · 产兵口：这城现在买得起至少一个兵（战斗或经济），说明接下来可能要造。
   *   **挨打的城也算**（2026-11-25 清 9.13）：原来这里写的是 `info.role !== 'threatened'`，
   *   理由是"被压着的城造不出来"——引擎里没有这条，被围的城照样能造兵（见 9.13）。
   * · 出门通道：有队伍**有兵**且任务是出去（收拢/推进/攻城）。空队伍（0 人）不算——
   *   S-015 那种一条人烟的题里，"main 收拢 0 人"会让城圈一直被赶。
   */
  const gold = s.players[world.me]?.gold ?? 0;
  const spawn = world.cities.some(
    (info) => world.affordableCombat(info.city, gold).length > 0 || !!econPlan.next,
  );
  const exit = squads.some(
    (q) => q.unitIds.length > 0 && (q.order === 'march' || q.order === 'siege' || q.order === 'assemble'),
  );

  const marched = planMarch(s, world, squads);
  const yieldMoves = planYield(s, world, keepClear, squads, { spawn, exit });
  /*
   * **把"让开"写成一支队**（9.14 的收尾）：只收那些这一手**真的被派了让位动作**的兵。
   * 没被派活儿的挡路兵不写进来——它们这一手就是"站在原地"，不是任务。
   */
  if (yieldMoves.length > 0) {
    const yieldIds = yieldMoves.map((m) => m.unitId).filter((id) => blockers.some((b) => b.id === id));
    if (yieldIds.length > 0) squads.push({ id: 'yield', order: 'yield', unitIds: yieldIds });
  }
  return {
    need,
    spendCap,
    captureId,
    captureTarget,
    econPosts: econPlan.posts,
    econNext: econPlan.next,
    econOrder: econPlan.order,
    keepClear,
    squads,
    steps: marched.steps,
    stepOrder: marched.order,
    yieldMoves,
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
