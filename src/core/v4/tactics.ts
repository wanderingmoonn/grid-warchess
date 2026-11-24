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
import { applyAction, attackableTargets, effectiveStats, reachableTiles, siegeTargets, utype } from '../rules.ts';
import type { Action, GameState, Unit } from '../types.ts';
import type { Constraints, Squad } from './types.ts';
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
   * ① **经济兵先走**：它的目标只有一个——约束层给的岗位。
   *
   * 为什么排在"让开"前面：让开那套的落点来自多源 BFS 的**最近空格**，方向是随机的
   * （北边先被扫到就往北）。经济兵一旦被推走，就从新位置重新贪心，再也想不起两格外的森林。
   * 实测：伐木工的岗在城西 (4,7)，它站在城圈（也是关键格）上，被让位判成"该让开"，
   * 于是被甩到东边丘陵，整局回不来。
   *
   * 让位仍然要管——但只在"没有岗、又确实堵在关键格上"时才用它兜底（见下）。
   */
  if (utype(s, u.type).category === 'economy') {
    const step = bestYieldStep(s, world, u, con);
    if (step) return { type: 'MOVE', unitId: u.id, x: step.x, y: step.y };
    /* 没岗可走、又站在关键格上 → 按搬迁计划挪开（别堵产兵口） */
    const yieldTo = con.yieldMoves.find((m) => m.unitId === u.id);
    if (!yieldTo) return null;
    const spot = stepToward(s, u, { x: yieldTo.x, y: yieldTo.y });
    if (spot) return { type: 'MOVE', unitId: u.id, x: spot.x, y: spot.y };
    return null;
  }

  /*
   * ①.4 **去接管废墟**（约束层指了人）。
   *
   * 排在走位前面：这是一条明确的差事（走进城格付重建费），
   * 不能被"守住/推进"的走位盖掉。`stepToward` 用的场从废墟格出发，
   * 废墟格本身在 `reachableTiles` 里是可达的（引擎对已废墟的城放行）。
   */
  if (con.captureId === u.id && con.captureTarget) {
    const step = stepToward(s, u, con.captureTarget, false, world.stepsFrom(con.captureTarget));
    if (step) return { type: 'MOVE', unitId: u.id, x: step.x, y: step.y };
  }

  /*
   * ①.5 **约束层已经排好了这一手站哪一格**（多起点 → 多终点，一人一格，见 `planMarch`）。
   *
   * 必须排在"让开"之前：整队 18 个兵都压在城圈（关键格）上时，
   * "让开"会把每一个人都接管成"去最近的空格"，方向是随机的——计划一次都执行不到，
   * 部队就原地互相让位（S-001 实测：平均离城距离 19 手都停在 9 格）。
   *
   * 往目标走本来就是在离开城圈，两件事不冲突；真挡着产兵口的落点，
   * 由下一步的"让开"兜底。
   */
  /*
   * **约束层已经排好了这一手站哪一格**（多起点 → 多终点，一人一格，见 `planMarch`）。
   *
   * 照做即可。执行时只校验"这一格还可达"——前面的人先动过之后，计划里的目标格
   * 可能已经被占了，这时退回自己的走位（`stepToward`），不要硬报一个必被拒的动作。
   * 单位自己不再判断"我该不该先走"：那是宏观决策。
   */
  const planned = con.steps?.[u.id];
  if (planned && !(planned.x === u.x && planned.y === u.y)) {
    const key = planned.y * s.w + planned.x;
    for (const [k] of reachableTiles(s, u)) {
      if (k === key) return { type: 'MOVE', unitId: u.id, x: planned.x, y: planned.y };
    }
  }

  /*
   * ② 让开：站在"必须空"的格子上。
   *
   * **只约束没有理由待在那儿的单位**（驻守兵）。正在推进的战斗单位要过桥，
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
      } else if (manhattan(u, home) > 2) {
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
   * 这里踩过一次：我自己算距离判"射程内"，而引擎按 `strikeDistance`（含高度差、
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
  if (sq.order === 'hold' && to && manhattan(u, to) <= 2) return null;
  if (!to) return null;

  /*
   * 直线只在**能并排**时才有意义：分了路的队伍（走廊够宽）走直线，
   * 窄道（桥/关隘，没分路）保持排队——硬顶成一横排会把过桥堵死。
   * 这两件事必须一起开：单独开"直线"会让 S-002 回到 0 城伤（实测）。
   */
  /*
   * **队形不归这里管。**
   *
   * 以前有一个开关："队里人数 ≥16 就走直线（横向展开）"。
   * 那是为了救 S-002 加的参数，代价是 S-005（过桥）一开就掉——桥面只有一格宽，
   * 横向展开等于把一队人摊成横排卡在桥头。
   *
   * 现在队形由约束层的 `planMarch` 一次排定（谁走哪一格、几点同步推进），
   * 这里只负责"朝自己那一格走一步"。再留一个按人数判断的开关，
   * 就是在用参数补队形——那条判断应该由"链条会不会交叉"来说话，不是人数。
   */
  const spot = stepToward(s, u, to, false, world.stepsFrom(to));
  if (spot) return { type: 'MOVE', unitId: u.id, x: spot.x, y: spot.y };
  return null;
}

/**
 * 挑一个可达格：离 `to` 更近、且**不踩 keepClear** 的那一格里最好的。
 *
 * 为什么禁止踩 keepClear：那是约束层说"必须空"的格子。让单位为了走近路踩上去，
 * 等于把约束当参考——v3 就是这么把桥堵住的。
 */
/**
 * **距离场在这里变成一步棋**——全项目就这一处把"表"翻成"动作"。
 *
 * ── 它在做什么 ──────────────────────────────────────────────
 *
 * 给出"这个单位这一手走到哪一格"：
 *   1. 先圈出**这一手能踩到的所有格**（`reachableTiles`：引擎按移动力和地形算好的，
 *      碰到别人占着的格就过不去）；
 *   2. 在这些格里挑一个**离目标更近**的；同样近时，挑"更正对目标"的（`straight`）。
 *
 * ── 两个参数的意思 ──────────────────────────────────────────
 *
 * · `field`：一张现成的距离表（`world` 里的那张场，越小越近）。
 *   给了就按表比远近；不给就退回 `manhattan`。
 *   后者不绕障碍，会把"必须绕路"的局判死——地图角落的兵要先去更远的一格才能绕出去，
 *   于是它一辈子不动（实测 9 个回合）。所以凡是"路上可能有障碍"的调用，都要把表传进来。
 *
 * · `straight`：只影响"同样近"时怎么选。开着 = 优先直冲目标（30 个兵挤成一列时靠它走直线）；
 *   关着 = 保持原来的遍历顺序（单排队列用，避免硬顶成一横排）。
 *
 * ── 它什么时候返回"空"（= 这一手不动）──────────────────────
 *
 * 可达格里**没有一格比脚下更近**。可能是被自己人堵死、被敌人围住、或者目标本身不可达。
 * 返回空之后，上层还有两个兜底：经济兵会"横移一步"（`stepAside`），
 * 再不行才交给约束层的让位计划。
 */
function stepToward(
  s: GameState,
  u: Unit,
  to: { x: number; y: number },
  /** 走廊够宽才走直线；窄道（桥/关隘）要排队，不能硬顶成一横排 */
  straight = false,
  /** 现成的距离表（越小越近）。给了就按表比，不给就退回 `manhattan` */
  field?: Float64Array,
): { x: number; y: number } | null {
  const dist = (x: number, y: number): number =>
    field ? (field[y * s.w + x] ?? Infinity) : manhattan({ x, y }, to);
  const distSafe = (x: number, y: number): number => {
    const d = dist(x, y);
    /* 目标不可达（在障碍里/被围死）时用 `manhattan` 兜底，否则比较全是 Infinity、兵会打转 */
    return Number.isFinite(d) ? d : manhattan({ x, y }, to);
  };
  const cur = distSafe(u.x, u.y);
  /* 同距离时的第二判据：几何上更贴目标的优先（主判据是距离场步数，两者不同源） */
  const curB = manhattan(u, to);
  let best: { x: number; y: number } | null = null;
  let bestD = cur;
  let bestB = curB;
  /* 逐个看"这一手能踩到的格"（引擎给的，已扣掉别人占着的格） */
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
      bestB = manhattan({ x, y }, to);
      continue;
    }
    /*
     * **同距离时选几何上更贴目标的那一格。**
     *
     * 不这么选的话，距离相同的两格（一格直着往前、一格横着往旁边）
     * 谁先被遍历到就用谁——30 个兵各走各的，实际走出来是之字形，
     * 净推进只有 0.6 格/手（移动力是 2）。这是 S-002 量出来的。
     */
    if (d === bestD && straight) {
      const e = manhattan({ x, y }, to);
      if (e < bestB) {
        bestB = e;
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
   * "关键格四周也不许站"**只对过道成立**（桥），不对城/产兵格成立。
   *
   * 原来是一刀切：keepClear 里既有桥头也有城格，于是城边那一圈全被排除——
   * S-015 那 2 格森林正好贴着城，经济兵永远走不上去（实测三个伐木工站平原产 3）。
   */
  const nearKeep = new Set<number>();
  for (const k of con.keepClear) {
    if (s.tiles[k]?.terrain !== 'bridge') continue;
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
  /*
   * **有岗位就朝岗位走**（约束层的指令，打分层只负责"怎么走过去"）。
   *
   * 原来这里自己算"附近哪格最高"：被让位推走之后就从当前格重新贪心，
   * 于是走上平原就再也不回头（S-015 卡在 19/31 的原因）。
   * 岗位由约束层按"这个兵种在这格能产多少"分配，一步跨不过去就挪近一格。
   */
  const post = con.econPosts?.[u.id];
  if (post) {
    if (u.x === post.x && u.y === post.y) return null; /* 到位了就别动 */
    /*
     * 用**真实路径距离**挑下一步，不用直线距离。
     *
     * 直线距离会锁死：地图角落的兵，去西边的岗位必须先往南绕一格，
     * 而那一步"离目标更远"，规则不许走 → 它 9 个回合一动不动（实测长局 u11 在 (19,0)）。
     * 用一张"从岗位出发的步数图"，绕路的那一步也是"更近"，自然就走出去了。
     */
    const field = world.stepsFrom(post);
    const toward = stepToward(s, u, post, false, field);
    /*
     * **有岗位就只朝岗位走，走不动就等着——不许退回下面那套"本地贪心"。**
     *
     * 这个坑是实测出来的：伐木工的岗在城西森林 (4,7)，这一手路上被自己人挡住，
     * 于是往下掉进"找多 2 金的格"那段，被旁边丘陵（伐木工在那儿 5 金）骗走，
     * 一路往东漂，最后全县城的经济兵都在平原上产 4。
     *
     * 规矩本来就有：**打分层不许自己发明目标**（目标是约束层给的）。
     * 走不到就当这一手不动，下一手再走。
     */
    /*
     * **允许踩着关键格走过去**（8.4 的教训）：关键格是"不许停"，不是"不许过"。
     * 这里原来写的是 `!keep.has(toward)`，结果经济兵从城里出来必须穿过城圈
     * （城圈全是关键格），一步都迈不出去——实测 6 个兵全冻在城墙边上。
     * "别停"由约束层的搬迁计划负责，不归这里管。
     */
    if (toward) return toward;
    /*
     * 走不动（前面全被自己人占着）时，**横着让一步**：挑"距离不变、但更直对岗位"的格。
     *
     * 不这么做的话，两个兵会面对面堵死：实测 2 号伐木工的岗在城西 (4,7)，
     * 它被四个牧民夹在 (7,4)，唯一更近的格被占，于是**整局一动不动**。
     * 和 8.11 破"人墙"是同一个道理：同距离的两格，选更正对目标的那一格。
     */
    return stepAside(s, u, post, field);
  }

  /*
   * **没有岗位就不动。**
   *
   * 原来这里是一大段"本地贪心"：找多 2 金的格、够不到就往最近的好格挪、
   * 被威胁就跑安全格。它和岗位制度互相打架，而且是 S-015 那两个坑的来源：
   *   · 岗位一时没了（比如岗被别人占了）→ 掉进这段 → 被旁边丘陵骗走，一路往东漂；
   *   · 每次重算都从脚下重新贪心，等于"每步都在重新评估"（v3 的病）。
   *
   * 规矩是**打分层不许自己发明目标**（见文件头）。没有岗 = 约束层没给任务，
   * 那就待着，别自己找活干。
   */
  void world;
  return null;
}

/**
 * **兜底一步**：横着挪一格——挑"离岗位的距离不变、但更直对岗位"的可达空格。
 *
 * 什么时候才会走到这里：`stepToward` 找不到"更近的格"（= 被自己人堵住）。
 * 这是唯一允许"距离不减少"的移动。
 *
 * 为什么需要：不这么办会死锁。实测 2 号伐木工的岗在城西森林，它被四个牧民夹在中间，
 * 唯一更近的格被占，整局一步没走，第 8 手还在原地产 3。
 *
 * 注意它**只认"同距离"**：不允许往后退（那会变成绕远、来回打转）。
 * 如果连同距离的格都被占满，就返回空——这说明队伍真的堵死了，只能等前面的人动。
 */
function stepAside(
  s: GameState,
  u: Unit,
  to: { x: number; y: number },
  field?: Float64Array,
): { x: number; y: number } | null {
  const d = (x: number, y: number): number =>
    field ? (field[y * s.w + x] ?? Infinity) : manhattan({ x, y }, to);
  const cur = d(u.x, u.y);
  let best: { x: number; y: number } | null = null;
  let bestB = manhattan(u, to);
  for (const [key] of reachableTiles(s, u)) {
    const x = key % s.w;
    const y = Math.floor(key / s.w);
    if (s.units.some((v) => v.id !== u.id && v.x === x && v.y === y)) continue;
    if (d(x, y) !== cur) continue; /* 只横移，不后退 */
    const e = manhattan({ x, y }, to);
    if (e < bestB) {
      bestB = e;
      best = { x, y };
    }
  }
  return best;
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
    const d = manhattan(u, { x, y });
    if (d < bestD) {
      bestD = d;
      best = { x, y };
    }
  }
  return best;
}

/** 造兵：钱够就在最近的一座城里造最便宜的兵。**不挑兵种**，先保证有兵 */
/**
 * 造战斗兵。
 *
 * `cap` 是**这一手最多能花多少**（接管废墟的攒钱阶段会把它压到"金币 − 重建费"）。
 * 用"可用金币"而不是"买完再检查"：这样上层不用把每件装备的价格抄一遍。
 */
export function recruitAction(
  s: GameState,
  world: World,
  need?: { hp: number; atk: number },
  cap?: number,
): Action | null {
  const gold = Math.min(s.players[world.me]?.gold ?? 0, cap ?? Infinity);
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

/**
 * 造经济兵：**照认领表的下一个空岗造**（`Constraints.econNext`，约束层给的）。
 *
 * 这里不做任何比较——不选兵种、不比价、不比产出。理由：那些比较每做一次就是一份
 * 新口径，而约束层手里才有"这块地已经被谁认领了"这个事实（S-015 那 5 个伐木工
 * 就是打分层自己比出来的）。没有下一个空岗 = 这回合不造，不是"退回造最便宜的"。
 */
export function recruitEcon(s: GameState, world: World, con: Constraints): Action | null {
  const next = con.econNext;
  if (!next) return null;
  for (const info of world.cities) {
    if (info.role === 'threatened') continue;
    const a: Action = { type: 'RECRUIT', cityId: info.city.id, unitType: next.type };
    if (applyAction(s, a).ok) return a;
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
