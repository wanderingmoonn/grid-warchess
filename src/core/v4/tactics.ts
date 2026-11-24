/**
 * **打分层**：给定约束，产出一个引擎认的动作。
 *
 * ── 第一版故意写得笨 ────────────────────────────────────────
 *
 * 只会三件事：**让开、走、打**（造兵在入口里）。计划里明说了：头两周它会比 v1 还蠢，
 * 这是代价，不是 bug。v3 那六千行系数不抄——那些系数正是"改一处不知动到哪"的来源。
 *
 * ── 它不许自己发明目标 ──────────────────────────────────────
 *
 * v3 有一半的翻车是"编队自己挑了目标"（配对 4↑8↓）。这里目标的唯一来源是约束层：
 * 单位查不到任务，就什么都不做。
 */
import { applyAction, attackableTargets, effectiveStats, reachableTiles, siegeTargets, unitYieldAt, utype } from '../rules.ts';
import type { Action, GameState, Unit } from '../types.ts';
import type { Constraints, Squad } from './types.ts';
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

function squadOf(con: Constraints, u: Unit): Squad | undefined {
  for (const sq of con.squads) if (sq.unitIds.includes(u.id)) return sq;
  return undefined;
}

/** 目标格：任务指向哪儿（没有目标的 hold 返回 undefined） */
/**
 * 目标格：任务指向哪儿。
 *
 * 城要取**最近的一格**，不是左上角。城占 2×2（开了城郭是 3×3），
 * 拿左上角当目标会让"贴着城下"的兵被判成还差 2 格——戟兵射程只有 2，
 * 于是就永远够不着（S-000 上实测：推到 3 格、全体干站着）。
 */
function targetOf(s: GameState, sq: Squad): { x: number; y: number } | undefined {
  if (sq.at) return sq.at;
  if (!sq.cityId) return undefined;
  const c = s.cities.find((x) => x.id === sq.cityId);
  return c ? { x: c.x + Math.floor((c.size ?? 2) / 2), y: c.y + Math.floor((c.size ?? 2) / 2) } : undefined;
}



/**
 * 给一个单位挑一步。
 *
 * 优先级是**硬的**，不是分数：
 *   ① 站着挡路的，先让开（约束层的 keepClear）
 *   ② 射程内能打的，就打（不权衡"值不值"）
 *   ③ 有任务的，朝目标走
 *   ④ 没任务的，不动
 */
export function actFor(
  s: GameState,
  world: World,
  con: Constraints,
  u: Unit,
): Action | null {
  /*
   * ① 让开：站在"必须空"的格子上。
   *
   * **只约束没有理由待在那儿的单位**（经济兵、驻守兵）。正在推进的战斗单位要过桥，
   * 让它"让开"就等于不许过河——桥面那一格本来就是临时占用。
   */
  const yieldTo = con.yieldMoves.find((m) => m.unitId === u.id);
  if (yieldTo) {
    /*
     * **不要直接照搬搬迁计划的落点。**
     *
     * 计划是拿"这一手开始时"的局面算的；等轮到第 8 个单位行动，前面的人已经把
     * 它要去的那一格占了，于是引擎回一句"目标格不可达"——实测每回合被拒 20 次，
     * 动作预算全烧在这上面（S-002 的兵就是这么原地不动的）。
     *
     * 改成：把计划落点当**方向**，用当前局面重新挑一个可达格走过去。
     */
    const spot = stepToward(s, u, { x: yieldTo.x, y: yieldTo.y });
    if (spot) return { type: 'MOVE', unitId: u.id, x: spot.x, y: spot.y };
  }

  /*
   * ①.2 经济兵：按**一把尺子**挑格子——每回合净多产多少金（金/回合）。
   *
   * 这是打分层第一次用"钱"当唯一尺度，也是 S-006 那道题的全部内容：
   * 伐木工站森林 12、站平原 3，牧民站丘陵 8、站森林 2。站错就是白丢钱。
   *
   * 取舍：只有当"目标格比脚下多产"时才动，且不踩 keepClear（产兵格要让出来）。
   * 不做安全评估（第一版故意笨）：先证明它能算对这笔账，再谈"值不值得冒险挪"。
   */
  if (utype(s, u.type).category === 'economy') {
    const spot = bestYieldStep(s, world, u, con);
    if (spot) return { type: 'MOVE', unitId: u.id, x: spot.x, y: spot.y };
    return null;
  }

  /*
   * ①.5 召回：`hold` 队离城还远，就先走回去——**这一步排在打人之前**。
   *
   * S-004 上实测：撤退的兵只要射程内出现敌人就会停下来打（v3 同一个病），
   * 结果 12 个兵只有 4 个回到城下、还丢了 12 个。
   * 约束说"回城"，那就先回城；路上能顺手打的，等站好位再说。
   */
  const sqNow = squadOf(con, u);
  if (sqNow?.order === 'hold' && sqNow.cityId) {
    const home = s.cities.find((c) => c.id === sqNow.cityId);
    if (home) {
      /*
       * 守军贴着城还不够——**不许站在产兵格上**。
       *
       * S-009 逼出来的：决定是"守"，5 个兵全退回城下、把产兵圈占满，
       * `recruitSpawnCells` 返回 0，金 190 一分花不出去；
       * 而且"回城"和"让位"会来回拉锯（一回合挪出去、下一回合拽回来）。
       * 所以把站位写进 hold 的条件里，两条指令别打架。
       */
      if (con.keepClear.includes(u.y * s.w + u.x)) {
        const spot = stepOffSpawn(s, u, home, con);
        if (spot) return { type: 'MOVE', unitId: u.id, x: spot.x, y: spot.y };
      } else if (cheb(u, home) > 2) {
        const spot = stepToward(s, u, { x: home.x, y: home.y });
        if (spot) return { type: 'MOVE', unitId: u.id, x: spot.x, y: spot.y };
      }
    }
  }

  /*
   * ② 攻城：**排在打人之前**。
   *
   * 一开始把"能打就打"排在前面，结果 S-000 上 30 手打掉 0 城血：敌人一直站在城格上，
   * 于是永远有目标可打，永远轮不到攻城。
   * 这里的取舍是**约束优先**：约束层说了"去打这座城"，那到了就打城；
   * 打人只是路上的事，不是目的。
   */
  const sq = squadOf(con, u);

  if (sq && (sq.order === 'march' || sq.order === 'siege') && sq.cityId) {
    /* 同样问引擎：`siegeTargets` 已经含射程、高度、有没有武器 */
    const canHit = siegeTargets(s, u).find((c) => c.id === sq.cityId);
    if (canHit) return { type: 'SIEGE', unitId: u.id, cityId: canHit.id };
  }


  /*
   * ②.5 集火：约束层点了名就打它。
   *
   * 排在攻城之后、乱打之前。理由：集火是"全体打同一个"，属于约束；
   * 但如果这一手够得着城，攻城优先级更高（去城下本来就是为了打城）。
   * 这里只做执行——选谁不是这一步的事。
   */
  if (sq?.focusId) {
    const focus = s.units.find((v) => v.id === sq.focusId && v.owner !== world.me);
    if (focus && attackableTargets(s, u).some((v) => v.id === focus.id)) {
      return { type: 'ATTACK', unitId: u.id, targetId: focus.id, x: focus.x, y: focus.y };
    }
  }

  /* ③ 打人：能打谁由**引擎**回答，不自己算距离。
   *
   * 这里踩过一次：我自己按切比雪夫距离判"射程内"，而引擎按 `strikeDistance`（含高度差、
   * 空中 +1）算，于是 v4 每回合都提一个必被拒的攻击（"目标超出射程"），
   * 整整 30 手一次都没打出去。**一份真相：能打谁只问引擎。** */
  const st = effectiveStats(s, u);
  const foes = attackableTargets(s, u).filter((v) => v.owner !== world.me).sort((a, b) => a.hp - b.hp);
  if (foes[0] && (st.atk ?? 0) > 0) {
    return { type: 'ATTACK', unitId: u.id, targetId: foes[0].id, x: foes[0].x, y: foes[0].y };
  }


  /* ④ 走：朝任务目标。`hold` 也不是"钉在原地"——离城还远就先走回去 */
  if (!sq) return null;
  const to = targetOf(s, sq);
  if (sq.order === 'hold' && to && cheb(u, to) <= 2) return null;
  if (!to) return null;
  /*
   * 直线只在**能并排**时才有意义：分了路的队伍（走廊够宽）走直线，
   * 窄道（桥/关隘，没分路）保持排队——硬顶成一横排会把过桥堵死。
   * 这两件事必须一起开：单独开"直线"会让 S-002 回到 0 城伤（实测）。
   */
  /*
   * 直线只在**有纵深的多排队列**里才需要。
   *
   * S-002（25 个兵、8~12 格的长路）实测：开直线 0 → 54 城伤；
   * 但 S-005（10 个兵过桥）、S-011（12 个兵）开了就掉——它们没有多排，
   * "走直线"只是把单排的人挤成一列，反而挡住侧翼。
   *
   * 判据是"有没有纵深"，不是"人数多不多"：人多但单排也没用。
   * 这里先用人数做近似（≥16 = 至少三四排），等有更好的几何量再换。
   */
  const hasDepth = sq.unitIds.length >= 16;
  /*
   * 只有**直线走不通**时才用寻路距离场（有河、有山挡着）。
   *
   * 全是直线可达时用寻路反而更差：绕障碍会选出一条"看着更远"的斜路，
   * S-011 实测全队漂到西北角。所以：`真实回合数 > 直线距离 + 2` 才算"必须绕"。
   */
  /* 临时：始终用按格计步的寻路 */
  const mustDetour = true;
  const spot = stepToward(
    s,
    u,
    to,
    hasDepth && !!sq.lanes && sq.lanes.length > 1,
    mustDetour ? world.stepsFrom(to) : undefined,
  );
  if (spot) return { type: 'MOVE', unitId: u.id, x: spot.x, y: spot.y };
  return null;
}

/**
 * 挑一个可达格：离 `to` 更近、且**不踩 keepClear** 的那一格里最好的。
 *
 * 为什么禁止踩 keepClear：那是约束层说"必须空"的格子。让单位为了走近路踩上去，
 * 等于把约束当参考——v3 就是这么把桥堵住的。
 */
function stepToward(
  s: GameState,
  u: Unit,
  to: { x: number; y: number },
  /** 走廊够宽才走直线；窄道（桥/关隘）要排队，不能硬顶成一横排 */
  straight = false,
  /** 到目标的真实回合数场（引擎 BFS）。给了就用它判远近，直线距离只在没给时兜底 */
  field?: Float64Array,
): { x: number; y: number } | null {
  const dist = (x: number, y: number): number =>
    field ? (field[y * s.w + x] ?? Infinity) : cheb({ x, y }, to);
  const distSafe = (x: number, y: number): number => {
    const d = dist(x, y);
    /* 目标不可达（在障碍里/被围死）时直线距离兜底，否则比较全是 Infinity、兵会打转 */
    return Number.isFinite(d) ? d : cheb({ x, y }, to);
  };
  const cur = distSafe(u.x, u.y);
  const curE = (u.x - to.x) ** 2 + (u.y - to.y) ** 2;
  let best: { x: number; y: number } | null = null;
  let bestD = cur;
  let bestE = curE;
  for (const [key] of reachableTiles(s, u)) {
    const x = key % s.w;
    const y = Math.floor(key / s.w);
    /*
     * **允许踩 keepClear**（2026-11-24 改）。
     *
     * 关键格的语义是"不许停"，不是"不许过"。原来这里把 keepClear 当墙，
     * 结果桥头一进 keepClear，全军就过不了河（S-005 从过河 3 个掉到 0）。
     * "别停"由约束层的搬迁计划负责：停在上面的单位下一手会被挪开。
     */
    if (s.units.some((v) => v.id !== u.id && v.x === x && v.y === y)) continue;
    const d = distSafe(x, y);
    if (d < bestD) {
      bestD = d;
      best = { x, y };
      bestE = (x - to.x) ** 2 + (y - to.y) ** 2;
      continue;
    }
    /*
     * **同距离时选"更正对目标"的那一格**（欧氏距离更小）。
     *
     * 不这么选的话，切比雪夫距离一样的两格（一格直着往前、一格横着往旁边）
     * 谁先被遍历到就用谁——30 个兵各走各的，实际走出来是之字形，
     * 净推进只有 0.6 格/手（移动力是 2）。这是 S-002 量出来的。
     */
    if (d === bestD && straight) {
      const e = (x - to.x) ** 2 + (y - to.y) ** 2;
      if (e < bestE) {
        bestE = e;
        best = { x, y };
      }
    }
  }
  return best;
}

/**
 * 经济兵的"一把尺子"：可达格里净产出最高的那一个。
 *
 * 只用金/回合这一个数，不加"离城远近""会不会被抢"这种第二项——
 * 加了就又变成 v3 那张必须调参的分数表。等它在实际对局里明显犯傻，再考虑加约束层。
 */
function bestYieldStep(
  s: GameState,
  world: World,
  u: Unit,
  con: Constraints,
): { x: number; y: number } | null {
  /*
   * 关键格**连同它四周**都不许去。
   *
   * 只禁关键格本身不够：桥头那一格两边是岸，经济兵站在岸上那一格，
   * 军队照样得绕——S-005 实测过河从 4 掉到 3，原因就是伐木工在桥口晃。
   * 关键格是"过道"，过道边上也是过道。
   */
  const keep = new Set(con.keepClear);
  const nearKeep = new Set<number>();
  for (const k of con.keepClear) {
    const kx = k % s.w;
    const ky = Math.floor(k / s.w);
    /* 八邻域（含斜角）：斜着站在桥口一样挡人 */
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1], [0, 0]] as const) {
      const x = kx + dx;
      const y = ky + dy;
      if (x < 0 || y < 0 || x >= s.w || y >= s.h) continue;
      nearKeep.add(y * s.w + x);
    }
  }
  const cur = unitYieldAt(s, u, u.x, u.y).gold ?? 0;

  /*
   * 已经贴着关键格的经济兵**不再自己找活干**：它要么正被让位计划挪开，
   * 要么就堵在过道上——这两种情况都不该由"多赚两金"来决定它的走位。
   */
  if (nearKeep.has(u.y * s.w + u.x)) return null;

  /* 平时：只有严格更高才动（免得在同一档格子之间横跳） */
  let gain: { x: number; y: number } | null = null;
  let gainGold = cur;
  /* 危险时：安全格里产出最高的那一个，**哪怕比现在低** */
  let safeBest: { x: number; y: number } | null = null;
  let safeGold = -1;

  for (const [key] of reachableTiles(s, u)) {
    const x = key % s.w;
    const y = Math.floor(key / s.w);
    if (keep.has(key) || nearKeep.has(key)) continue;
    if (s.units.some((v) => v.id !== u.id && v.x === x && v.y === y)) continue;

    const gold = unitYieldAt(s, u, x, y).gold ?? 0;
    /*
     * **至少多 2 金才值得挪。**
     * 只多 1 金就动的话，经济兵会为了零头在地图上横穿：既浪费动作预算，
     * 又会穿过桥头/产兵格（S-005 的伐木工就是这么跑到对岸去的）。
     */
    if (gold >= gainGold + 2) {
      gainGold = gold;
      gain = { x, y };
    }
    if (world.harassed({ x, y })) continue;
    if (gold > safeGold) {
      safeGold = gold;
      safeBest = { x, y };
    }
  }

  /*
   * 脚下危险就只认安全格——**但仍然按产出挑**。
   * 早先这里是"挑离敌人最远的"，结果全跑进平原：离敌人最远的地方通常也最没用
   * （S-006 总产 47 → 21）。逃命也要算账，只是把"安全"当选格的前置条件。
   */
  if (world.harassed(u)) return safeBest ?? (cur > 0 ? null : gain);
  return gain;
}

/**
 * 从产兵格上挪开的落点：城附近、不在关键格上、离自己最近。
 *
 * 为什么需要它：守军站在城下就是站在产兵圈里，"回城"和"让位"会来回拉锯
 * （一回合挪出去、下一回合拽回来），而且产兵格占满之后再也造不出兵（S-009）。
 */
function stepOffSpawn(
  s: GameState,
  u: Unit,
  home: { x: number; y: number; size?: number },
  con: Constraints,
): { x: number; y: number } | null {
  const keep = new Set(con.keepClear);
  const n = home.size ?? 2;
  let best: { x: number; y: number } | null = null;
  let bestD = 99;
  for (const [key] of reachableTiles(s, u)) {
    const x = key % s.w;
    const y = Math.floor(key / s.w);
    if (keep.has(key)) continue;
    if (s.units.some((v) => v.id !== u.id && v.x === x && v.y === y)) continue;
    /* 城 3 格以内：守军不跑远 */
    const dx = Math.max(home.x - x, x - (home.x + n - 1), 0);
    const dy = Math.max(home.y - y, y - (home.y + n - 1), 0);
    if (Math.max(dx, dy) > 3) continue;
    const d = cheb(u, { x, y });
    if (d < bestD) {
      bestD = d;
      best = { x, y };
    }
  }
  return best;
}

/** 造兵：钱够就在最近的一座城里造最便宜的兵。**不挑兵种**，先保证有兵 */
export function recruitAction(s: GameState, world: World, need?: { hp: number; atk: number }): Action | null {
  const gold = s.players[world.me]?.gold ?? 0;
  for (const info of world.cities) {
    if (info.role === 'threatened') continue; // 被压着的城造不出来
    const opts = world.affordableCombat(info.city, gold);
    /*
     * 先按**门槛**筛，再按价钱挑——顺序不能反。
     *
     * 反过来的话永远是"买得起的最便宜"（民兵），而民兵在装甲车面前一发都挨不住。
     * 筛完空了就退回"攻击最高的"（打不穿也总比完全不还手强），再空就退回原样。
     */
    const ok = need
      ? opts.filter((o) => {
          const d = utype(s, o.type);
          return (d.maxHp ?? 0) > need.hp && (d.atk ?? 0) * 3 >= need.atk * 3;
        })
      : [];
    /*
     * 满足门槛之后：**先挑射程远的**（先手权），射程一样再挑便宜的。
     *
     * S-012 实测：都满足两条不等式的弩手（射程 3）和火枪（射程 4），
     * 从便宜的挑会选弩手——和装甲车（射程 3）对射，谁先手全看站位。
     * 射程 4 的火枪能站着不动先打一轮，这才是"编制"里该有的那一条。
     */
    const order = (a: { type: string }, b: { type: string }): number => {
      const da = utype(s, a.type);
      const db = utype(s, b.type);
      return ((db.range ?? 1) - (da.range ?? 1)) || 0;
    };
    const pick =
      ok.length > 0
        ? [...ok].sort(order)
        : need
          ? [...opts].sort((a, b) => (utype(s, b.type).atk ?? 0) - (utype(s, a.type).atk ?? 0))
          : opts;
    for (const opt of pick) {
      const a: Action = { type: 'RECRUIT', cityId: info.city.id, unitType: opt.type };
      const r = applyAction(s, a);
      if (r.ok) return a;
    }
  }
  return null;
}

/** 这个单位是不是住在"必须空"的格子上 */
export function isBlocker(s: GameState, con: Constraints, u: Unit): boolean {
  return con.keepClear.includes(u.y * s.w + u.x);
}

/** 一个单位当前的类别（战斗/经济），上层要按这个分队 */
export function categoryOf(s: GameState, u: Unit): string {
  return utype(s, u.type).category ?? 'other';
}
