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
import {
  applyAction,
  attackableTargets,
  buildSiteError,
  canSeeTile,
  effectiveStats,
  occupantAt,
  reachableTiles,
  siegeTargets,
  utype,
} from '../rules.ts';
import type { Action, City, GameState, Unit } from '../types.ts';
import type { Constraints, Squad } from './types.ts';
import type { World } from './world.ts';
import { unitWorthOfType } from './world.ts';

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
/**
 * **遭遇读数的计数**（阶段 5 §2.6 第 0 步）。
 *
 * 一手之内 `actFor` 会被调很多次（每个单位一次，每次 `aiNextAction` 还会重建），
 * 所以只能按"回合号 + 情况"累加，由入口在"一手只打一次"的地方统一输出并清零。
 */
const encTally = new Map<string, number>();
export function tallyEnc(kind: string): void {
  encTally.set(kind, (encTally.get(kind) ?? 0) + 1);
}
/** 取出并清零（入口每手调一次） */
export function takeEnc(): Array<[string, number]> {
  const out = [...encTally.entries()];
  encTally.clear();
  return out;
}

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
    const step = stepToward(s, u, con.captureTarget, false, world.stepsFrom(con.captureTarget), true);
    if (step) return { type: 'MOVE', unitId: u.id, x: step.x, y: step.y };
  }

  /*
   * ①.42 **架桥：站到建造距离内就 `BUILD`**（W4-4d-3，2026-11-26）。
   *
   * 判据全部交给引擎的 `buildSiteError`（地形、类型、链式规则、时代都在里面），
   * 这里只做一件事：**能不能建那一格**。能就建，建不了就继续朝岸边走（下面的 ④）。
   *
   * 一条门槛先自己查：**钱**。`buildSiteError` 不查金币，提一个必然被拒的动作
   * 会白白烧掉这一手的动作预算（v3 就踩过：AI 一直提"金币不足"的建造）。
   */
  {
    const sqB = squadOf(con, u);
    const target = sqB?.stance === 'build' ? sqB.buildAt : undefined;
    if (target && (utype(s, u.type).builds ?? []).includes('bridge')) {
      const def = s.unitTypes['bridge'];
      const gold = s.players[world.me]?.gold ?? 0;
      const price = def?.cost ?? 45;
      if (def && gold >= price && !buildSiteError(s, def, u, target.x, target.y)) {
        return { type: 'BUILD', unitId: u.id, unitType: 'bridge', x: target.x, y: target.y };
      }
    }
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
   * ①.45 **能砸到目标城就先砸，别照着计划走开。**
   *
   * 走位计划给每个还在路上的人都排了下一步，于是"这一手明明够得着城"的兵
   * 也被派去走一格。8 个兵围住一座空城，一回合只砸得出 1~2 次
   * （S-016 实测：10 手 46 血，而 v1/v3 同局面把 81 血打空）。
   *
   * 能打到的东西比"往前挪一格"值钱，所以攻城排在走位之前。
   * 判据用引擎的 `siegeTargets`（已含射程、高度差、有没有武器），不自己算。
   */
  {
    const sqS = squadOf(con, u);
    if (sqS && (sqS.stance === 'march' || sqS.stance === 'siege') && sqS.cityId) {
      const canHitEarly = siegeTargets(s, u).find((c) => c.id === sqS.cityId);
      if (canHitEarly) return { type: 'SIEGE', unitId: u.id, cityId: canHitEarly.id };
    }
  }

  /*
   * ①.48 **战术模式：为集火目标靠一步**（2026-11-25，第 4 步的前半）。
   *
   * 只在约束层挂了 `tactics.converge` 时走这里（现在只有"进攻中、目标是城下守军"才挂）。
   * 判据是**二值**的，不是打分：
   *   "这一手有没有一格，站上去就能打到 focus？有 → 去；没有 → 照计划走。"
   *
   * 为什么不给走位加分数项：项目里证伪过一串（靠近队友、回城惩罚、经济距离场……），
   * 加项的落点永远在意料之外。这里连"哪一格更好"都不比——只问"能不能打到"。
   */
  {
    const sqC = squadOf(con, u);
    const t = sqC?.tactics;
    if (t?.converge && sqC!.stance === 'march') {
      const foe = s.units.find((v) => v.id === t.focusId && v.owner !== world.me);
      if (foe && !seenFoes(s, u).some((v) => v.id === foe.id)) {
        const spot = approachStep(s, u, foe);
        if (spot) return { type: 'MOVE', unitId: u.id, x: spot.x, y: spot.y };
      }
    }
  }

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
   * ①.9 **临时调令**的位置见下面（排在开火之后）。
   */

  /*
   * **①.6 遭遇（阶段 5 §2.6，2026-11-28）**：这一手按计划走之前，先看眼前有没有敌人。
   *
   * 这件事必须排在**让开之前**：`V-1-01` 实测，三个兵还没离开城圈就都挂着"让开"，
   * 排在让开之后的话，这里一次都数不到（也永远打不到人）。
   *
   * 现状（第 0 步）：**只数不改**。三种情况按"每一个兵每一手"记一次：
   *   · `打了`      —— 现在就能打到（射程内有人），那是"没放过"；
   *   · `够了没打`  —— 偏一步就能打到某个看得见的敌人，但现在按计划走；
   *   · `没够着`    —— 视野里有人、但这一步够不着（离得还远）。
   *
   * 只数进军队（`march` / `siege`）。`hold`（撤退/守城）按 `S-004` 的规矩本来就该不停，
   * `scout` 按 §2.2 的规矩本来就该退，`yield`/`build` 是差事——这些都不算缺口。
   *
   * `V4_ENCOUNTER_LOG=1` 时每手汇总成一行（由入口打）。**它不改变任何一手动作。**
   */
  const sqE = squadOf(con, u);
  if (sqE && (sqE.stance === 'march' || sqE.stance === 'siege')) {
    const foesNow = seenFoes(s, u);
    if (foesNow.length > 0) tallyEnc('打了');
    else {
      const near = world.foeCombat
        .filter((v) => canSeeTile(s, u.owner, v.x, v.y))
        .sort((a, b) => manhattan(u, a) - manhattan(u, b) || (a.id < b.id ? -1 : 1))[0];
      if (!near) tallyEnc('没看见敌');
      else if (approachStep(s, u, near)) tallyEnc('够了没打');
      else tallyEnc('没够着');
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
  if (sqNow?.stance === 'hold' && sqNow.cityId) {
    const home = s.cities.find((c) => c.id === sqNow.cityId);
    if (home) {
      /*
       * **挨打的城：守军站进城里**（2026-11-25，修 9.12）。
       *
       * 城是地形，`terrainDef.city = 3`，站在城里比站在平原上多 3 点护甲。
       * 只要这一格还有敌兵够得着（`foeEta <= 1`，同一个威胁场的数），
       * 守军就该在城里挨这一轮，而不是站在城墙外的平原上。
       *
       * 顺序（和下面那段"回城优先于打人"是同一个理由，只是分了两段）：
       *   · 离城还远 → 先回城（S-004 那条：回城的路上不要停下打）；
       *   · 已经在城下 → **这一手打得到人就先打**，打不到才进城里站好。
       *     不先打的话，D-1-02 那四个人会花两回合往回走进城，期间城里一拳不出。
       */
      const underFire =
        (world.cities.find((c) => c.city.id === sqNow.cityId)?.foeEta ?? Infinity) <= 1;
      if (underFire) {
        if (manhattan(u, home) > 2) {
          const spot = stepToward(s, u, { x: home.x, y: home.y });
          if (spot) return { type: 'MOVE', unitId: u.id, x: spot.x, y: spot.y };
        } else if (seenFoes(s, u).length === 0) {
          /*
           * **能打就打，打不到才进城**——这是二选一，不是两件事。
           *
           * 引擎里**攻击会同时置 `moved`**（`doAttack` 的 `attacker.moved = true`），
           * 所以"先打一拳再走进城里"是**非法操作**，同一回合只能选一件。
           * 选打：城里那 3 点护甲要拿一整拳去换，而拳是守城的全部产出。
           */
          const post = cityPostCell(s, world, con, u, home);
          if (post && (post.x !== u.x || post.y !== u.y)) {
            const spot = stepToward(s, u, post, false, world.stepsFrom(post));
            if (spot) return { type: 'MOVE', unitId: u.id, x: spot.x, y: spot.y };
          }
        }
      } else if (con.keepClear.includes(u.y * s.w + u.x)) {
        /*
         * 守军贴着城还不够——**不许站在产兵格上**。
         *
         * S-009 逼出来的：决定是"守"，5 个兵全退回城下、把产兵圈占满，
         * `recruitSpawnCells` 返回 0，金 190 一分花不出去；
         * 而且"回城"和"让位"会来回拉锯（一回合挪出去、下一回合拽回来）。
         * 所以把站位写进 hold 的条件里，两条指令别打架。
         */
        const spot = stepOffSpawn(s, u, home, con);
        if (spot) return { type: 'MOVE', unitId: u.id, x: spot.x, y: spot.y };
      } else if (manhattan(u, home) > 2) {
        const spot = stepToward(s, u, { x: home.x, y: home.y });
        if (spot) return { type: 'MOVE', unitId: u.id, x: spot.x, y: spot.y };
      }
    }
  }

  const sq = squadOf(con, u);

  /*
   * ② **哨兵：看着，不接战**（阶段 5 §2.2b，2026-11-28）。
   *
   * 排在集火和"打人"**之前**——它的任务是眼睛，不是拳头：
   * 有人进它的视野就朝自己的城退一步（还在来路上、还看得见），
   * 站在那儿跟人对拼等于用 50 金换对方一个动作，这笔账永远亏。
   */
  if (sq?.stance === 'scout') {
    const reach = Math.max(1, effectiveStats(s, u).vision ?? 2);
    const spotted = seenFoes(s, u).some((f) => manhattan(u, f) <= reach);
    if (spotted) {
      const home = world.myCities.find((c) => c.id === sq.cityId) ?? world.myCities[0];
      if (home) {
        const back = stepToward(s, u, { x: home.x, y: home.y });
        if (back) return { type: 'MOVE', unitId: u.id, x: back.x, y: back.y };
      }
      return null;
    }
    const spot = targetOf(s, sq);
    if (!spot) return null;
    if (manhattan(u, spot) <= 1) return null; /* 到点就站住，不追、不乱走 */
    const step = stepToward(s, u, spot, false, world.stepsFrom(spot));
    if (step) return { type: 'MOVE', unitId: u.id, x: step.x, y: step.y };
    return null;
  }

  /*
   * ②.5 集火：约束层点了名就打它。
   *
   * 排在攻城之后、乱打之前。理由：集火是"全体打同一个"，属于约束；
   * 但如果这一手够得着城，攻城优先级更高（去城下本来就是为了打城）。
   * 这里只做执行——选谁不是这一步的事。
   */
  const focus = sq?.tactics
    ? s.units.find((v) => v.id === sq.tactics!.focusId && v.owner !== world.me)
    : undefined;
  if (focus && seenFoes(s, u).some((v) => v.id === focus.id)) {
    return { type: 'ATTACK', unitId: u.id, targetId: focus.id, x: focus.x, y: focus.y };
  }

  /* ③ 打人：能打谁由**引擎**回答，不自己算距离。
   *
   * 这里踩过一次：我自己算距离判"射程内"，而引擎按 `strikeDistance`（含高度差、
   * 空中 +1）算，于是 v4 每回合都提一个必被拒的攻击（"目标超出射程"），
   * 整整 30 手一次都没打出去。**一份真相：能打谁只问引擎。** */
  const st = effectiveStats(s, u);
  const foes = seenFoes(s, u).sort((a, b) => a.hp - b.hp);
  if (foes[0] && (st.atk ?? 0) > 0) {
    return { type: 'ATTACK', unitId: u.id, targetId: foes[0].id, x: foes[0].x, y: foes[0].y };
  }


  /*
   * ③.5 **临时调令**（2026-11-25，清 9.18）：站在城格上、但本来有任务的兵，这一手往外走。
   *
   * 排在开火**之后**——实测定下来的顺序（S-002 城伤 45→30 就是排错了位置）：
   * 一个能开火的兵先去走路，等于拿一拳去换一格位移。所以先打，打不到才走。
   *
   * 这一条和"让开"（②）方向经常相反：
   *   · 让开 = 朝**最近的空格**（为产兵口/出城通道服务，方向可能朝后）；
   *   · 调令 = 朝**它本来该去的目标**（主队的目标 / 集结点 / 废墟）。
   * 只对**城格**生效（见 `planTransit`）：窄道交给搬迁链，过桥的排队是 P4 的事。
   */
  const transitTo = con.transit?.[u.id];
  if (transitTo && (transitTo.x !== u.x || transitTo.y !== u.y)) {
    const spot = stepToward(s, u, transitTo, false, world.stepsFrom(transitTo));
    if (spot) return { type: 'MOVE', unitId: u.id, x: spot.x, y: spot.y };
  }

  /* ④ 走：朝任务目标。`hold` 也不是"钉在原地"——离城还远就先走回去 */
  if (!sq) return null;
  const to = targetOf(s, sq);
  if (sq.stance === 'hold' && to && manhattan(u, to) <= 2) return null;
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
  /*
   * 工兵（`build`）用 `straight`：同距离的两格优先"更正对目标"的那一格。
   * 不开的时候它会在桥头来回抖（4d-3 实测：工兵在 (7,8)/(7,9) 交替了 10 多手，桥停在第三格）。
   */
  const spot = stepToward(s, u, to, sq.stance === 'build', world.stepsFrom(to));
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
 * **靠拢一步**：找一个"站上去就够得着 `foe`"的可达格（2026-11-25）。
 *
 * 只回答一个问题：这一手能不能把 `foe` 纳入射程。能就给一格，不能就 `null`。
 * 多格可选时取**离它最近**的那格（同距取格号小的，保证每手选同一格，不会抖）——
 * 不再比"地形防御/威胁/队友距离"，那些都是分数项，落点会跑偏（见项目里的证伪清单）。
 */
/**
 * **打谁**：引擎说打得到 + 我自己看得见（2026-11-27）。
 *
 * 这是"不做弊"的落点。原来 `attackableTargets` 的判据只看射程，而 AI 拿到的是**真状态**
 * （全图），于是它会对着视野外的敌人提 `ATTACK`——引擎回"看不见那个位置（视野外）"，
 * 全册实测 **205 次**白烧。那不只是浪费，**那是玩家做不到的事**（用户的话）。
 *
 * 现在两道判据一起用，而且都是引擎自己的：
 *   · `attackableTargets` → 射程 / 视线 / 高度差，一条不自己算；
 *   · `canSeeTile` → 视野（和引擎拒动作时用的是同一个函数）。
 *
 * 判据相同，所以"AI 认为能打"和"引擎允许打"不会再分岔。
 */
function seenFoes(s: GameState, u: Unit): Unit[] {
  return attackableTargets(s, u).filter(
    (v) => v.owner !== u.owner && canSeeTile(s, u.owner, v.x, v.y),
  );
}

/**
 * **这一格是不是被别人站着**（桥不算，见 `rules.occupantAt`）。
 *
 * 桥和兵可以同格，所以"这格有人"不能直接数 `s.units`：
 * 把 AI 自己造的桥当成一个人，队伍就永远走不上自己修的桥（`P-2-03` 实测）。
 */
function takenByOther(s: GameState, u: Unit, x: number, y: number): boolean {
  return occupantAt(s, x, y, u.id) !== undefined;
}

function approachStep(
  s: GameState,
  u: Unit,
  foe: Unit,
): { x: number; y: number } | null {
  let best: { x: number; y: number } | null = null;
  let bestD = Infinity;
  let bestK = Infinity;
  for (const [k] of reachableTiles(s, u)) {
    const x = k % s.w;
    const y = Math.floor(k / s.w);
    if (x === u.x && y === u.y) continue;
    if (takenByOther(s, u, x, y)) continue;
    const moved = { ...u, x, y, moved: true } as Unit;
    if (!seenFoes(s, moved).some((v) => v.id === foe.id)) continue;
    const d = manhattan({ x, y }, foe);
    if (d < bestD || (d === bestD && k < bestK)) {
      bestD = d;
      bestK = k;
      best = { x, y };
    }
  }
  return best;
}

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
  /**
   * 允许踩进**废墟格**（默认不许）。
   *
   * 走进废墟 = 接管，引擎在那一步要收重建费；付不起就整步作废（白烧一个动作）。
   * 所以默认绕开——只有"这一手就是去接管"的那一次调用（`captureTarget`）才传 true。
   * 实测（`probe-yield4 --reject`）：不绕开时全册 713 次被拒里 84% 是这一条。
   */
  allowRuin = false,
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
    if (takenByOther(s, u, x, y)) continue;
    /* **别踩废墟格**（见 `allowRuin` 的注释）——按 `cityId` 判，废墟的地形不再是 `city` */
    if (!allowRuin) {
      const cid = s.tiles[key]?.cityId;
      if (cid) {
        const c = s.cities.find((x2) => x2.id === cid);
        if (c?.ruined) continue;
      }
    }
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
    if (takenByOther(s, u, x, y)) continue;
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
 * **守城占位**：挨打的时候，守军该站进城里的哪一格。
 *
 * 城格每一格都是同样的 +3 护甲，所以"站哪一格"只影响**往哪个方向进去**：
 * 挑离敌人最近的那一格，冲锋方向最短。同距按格号排（每回合选同一格，不会抖）。
 *
 * 一格一个人：同一支队的守军按 id 排先后、依次挑剩下的格。
 * 不这么分的话两个兵会抢同一格，第二个被堵在城墙外——那等于白站。
 *
 * 还没做的是"按兵种排前排后排"（守卫站哪面墙、远程站哪格），
 * 那是 9.11 的另一半（守军站位），比这道题大。
 */
function cityPostCell(
  s: GameState,
  world: World,
  con: Constraints,
  u: Unit,
  home: City,
): { x: number; y: number } | null {
  /* 已经在城里 → 不动（每格护甲一样，换格只是白费一步） */
  const n = home.size ?? 2;
  if (u.x >= home.x && u.x < home.x + n && u.y >= home.y && u.y < home.y + n) return null;
  const foes = world.foeCombat;
  if (foes.length === 0) return null;

  const free: Array<{ x: number; y: number; d: number; k: number }> = [];
  for (let dy = 0; dy < n; dy += 1) {
    for (let dx = 0; dx < n; dx += 1) {
      const x = home.x + dx;
      const y = home.y + dy;
      if (takenByOther(s, u, x, y)) continue;
      /*
       * **不许站进"这一手要留给产兵"的格**（批 2，2026-11-27）。
       *
       * 名额把挨打时的城格分成两份：产兵要 N 格（`con.spawnQuota`）、守军留 `CITY_POST` 格。
       * 这里原来只数"有没有人站"，于是守军会走进被保留的那几格 → 下一手被搬迁链赶出来 →
       * 再走回去，一来一回**每回合都在抖**（实测 seed 900：被引擎拒 274 → 780 次，整局形状变差）。
       *
       * 读 `con.keepClear` 而不是 `spawnQuota`：城格在"没挨打"时本来就在 `keepClear` 里，
       * 用同一个集合，"这一格这一手能不能站"就只有一处答案。
       */
      if (con.keepClear.includes(y * s.w + x)) continue;
      const d = Math.min(...foes.map((f) => Math.abs(f.x - x) + Math.abs(f.y - y)));
      free.push({ x, y, d, k: y * s.w + x });
    }
  }
  if (free.length === 0) return null;
  free.sort((a, b) => a.d - b.d || a.k - b.k);

  /*
   * **"进城要留一格"这条补丁删了**（批 2，2026-11-27）。
   *
   * 原话是"要求进城的这一格不会把最后一格占掉（`free.length >= 2` 才进）"——
   * 那是产兵名额还写死成 1 时的替代品。现在名额由 `applySpawnQuota` 按
   * "这一手买得起几个"算出来，并把那几格**提前**放进 `keepClear`，
   * 所以"别把补兵路堵死"已经由上面那行 `continue` 保证，不需要再数第二遍。
   */

  /* 同一支队里我排第几（按 id，稳定），就挑第几个候选格 */
  const sq = squadOf(con, u);
  const ids = sq ? [...sq.unitIds].sort((a, b) => (a < b ? -1 : 1)) : [u.id];
  const rank = Math.max(0, ids.indexOf(u.id));
  return free[Math.min(free.length - 1, rank)]!;
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
    if (takenByOther(s, u, x, y)) continue;
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
  need?: NonNullable<Constraints['need']>,
  cap?: number,
): Action | null {
  const gold = Math.min(s.players[world.me]?.gold ?? 0, cap ?? Infinity);
  for (const info of world.cities) {
    /*
     * **挨打的城也造兵**（2026-11-25，清 9.13）。
     *
     * 这里原来有一句 `if (info.role === 'threatened') continue;`，注释写"被压着的城造不出来"。
     * 那是假的：引擎的 `doRecruit` 只拒 非我城 / 废墟 / 本回合刚打下 / 时代白名单 / 钱不够 /
     * **产兵格被占满**，跟"有没有敌人围着"无关（实测被 4 个敌人贴脸的城照样造得出兵）。
     * 而"城里造兵反击"本来就是人在被围时最常做的事。
     *
     * 唯一要保的是"留一格空位"，那条不在这里——由 `cityPostCell` 保证守军不把城格站满。
     */
    const opts = world.affordableCombat(info.city, gold);
    /*
     * **闸 1：打得穿吗**（2026-11-25，P2-2a）。
     *
     * 约束层已经算好"对多数决目标打得穿的兵种"（`need.usable`），这里只做交集，
     * 不自己判断伤害——两处算同一件事必然跑偏。
     *
     * 从前这里是"血 > 对面最高单发 且 三发打穿"，而"血"那一半其实属于闸 2
     * （抵近途中会不会死），P2-2b 才做。现在先把"0 伤害"的整类排除。
     */
    /*
     * 两道闸一起过：**打得穿**（闸 1）**且活得到**（闸 2，穿过敌方射程时不被打死）。
     * 两条都在约束层算好，这里只做交集——打分层不做判断。
     */
    const ok = need
      ? opts.filter((o) => need.usable.includes(o.type) && need.survivable.includes(o.type))
      : [];
    /*
     * 满足门槛之后：**先挑射程远的**（先手权），同射程挑**血厚的**，再看攻，价格只做最后一档。
     *
     * 2026-11-25（P1）改的三件事：
     *
     * ① **价格从前排挪到最后排**。原来是 `射程 → 便宜`，所以射程一样就买最便宜的——
     *    这是"有钱就买 1 代民兵"的最后一环（实测 S-001 造 21 个、S-002 造 45 个，见 9.17）。
     *    用户的判断："会算性价比，但不可能直接买最便宜的。"
     *    血厚的先，因为**血少的单位堆再多，会被带溅射的一次清掉**。
     * ② **没有敌人时也要排**（`need` 为空）。原来那里 `pick = opts`，而 `opts` 是按价升序的，
     *    等于"没敌人就买最便宜的"。空城也是一样：打空城不需要射程，但也不该买 1 代。
     *    没敌人时按**血 → 攻 → 价格**（通用强度），有敌人时按**射程 → 血 → 攻 → 价格**。
     * ③ 兜底保留"攻击最高的"不变。理由没变：打不穿也总比完全不还手强。
     */
    /*
     * **`ok` 为空有两种原因，处理完全不同**（2026-11-25，P2-2b 踩出来的）：
     *
     * ① **根本没有能用的兵种**（打得穿又活得到的一个都没有）→ 按 `canPad` 决定要不要充数：
     *    敌方无溅射/多段 → 可以买便宜的凑数、以伤换伤；有溅射/多段 → 充数是负资产，攒钱。
     * ② **有能用的兵种，但这一手买不起** → **攒钱**，不要拿打不动的顶替。
     *    这是人类的行为："差 20 金买戟兵"时不会先去买个民兵。
     *
     * 从前把两种混在一起（`ok` 空就充数），结果闸 2 被完全掩盖：
     * S-002 里能用的兵（弩手 82 / 骑士 95）买不起，于是又回去买斥候和长枪——
     * 而它们正是"活不到"的那批。**判据算出来了却没生效，等于没做。**
     */
    /*
     * **首批建军 vs 补充损耗，判据不同**（2026-11-25，P2-2b 踩出来的）。
     *
     * - **首批**（场上一个战斗兵都没有）：要的是"这支军队能不能打"，所以严格——
     *   只造打得穿又活得到的；买不起就攒钱，别拿打不动的顶替（P-1-01 就是这么出题的）。
     * - **补充**（已经有兵）：要的是"把损耗填上、维持战线"，这时候便宜兵是有用的——
     *   它们填的是"少一个人挨打"，不是"主力输出"。S-001（20 个兵）和 S-009（4 个兵）
     *   都是这个形状：改成"买不起就攒"之后，它们反而因为兵太少而输了。
     *
     * 所以充数不是无条件的，也不是完全禁止的，看**这是不是第一支军队**。
     */
    /*
     * `anyGood` 必须按**这一座城现在买得起的兵**算，不是按全局兵种表。
     *
     * 2026-11-25 22:45 实测（E-2-03，纯转换题）：1 代城、金 4000、对面 2 个 2 代长枪兵。
     * `need.usable` 里有弩兵/火枪兵/骠骑兵…… 全是高代兵，**这座城一个都造不出来**；
     * 而 `affordableCombat` 只有 6 个 1 代兵，全部打不穿 40 血的长枪兵。
     * 于是 `ok` 为空、`anyGood` 又是 true（它看的是全局表）→ 兜底被关掉 → **一个兵都不造**，
     * 10 手里金从 4000 涨到 4250、部队 0、战力 0。
     *
     * 这就是 2b 踩过的那个坑的翻版：**"买不起"和"过不了闸"是两件事**，
     * 判断"有没有好兵"必须落在"买得起的"这个集合上。
     */
    const anyGood = need
      ? opts.some((o) => need.usable.includes(o.type) && need.survivable.includes(o.type))
      : true;
    const firstArmy = world.myCombat.length === 0;
    const allowedToPad = need ? need.canPad && (!firstArmy || !anyGood) : false;
    /*
     * **池内只剩一个数：相对战力 ÷ 分母**（S2，2026-11-27）。
     *
     * 原来两条排序：守城按"每格输出"（`need.perCell`），其余按 P1 的字典序（射程→血→攻→价）。
     * 两条各算一遍强弱，同一手采购里出现两种"更强"，谁对说不清。
     * 现在只有一个数：**相对战力**（`unitWorthOfType`），分母由瓶颈决定（格子紧不除、钱紧除单价）。
     */
    const pickScore = (o: { type: string; gold: number }): number => {
      const worth = unitWorthOfType(s, o.type);
      const divisor = need?.bottleneck === 'cell' ? 1 : Math.max(1, o.gold);
      return worth / divisor;
    };
    const byScore = (a: { type: string; gold: number }, b: { type: string; gold: number }): number =>
      pickScore(b) - pickScore(a) || a.gold - b.gold || (a.type < b.type ? -1 : a.type > b.type ? 1 : 0);
    const pick =
      ok.length > 0
        ? [...ok].sort(byScore)
        : need
          ? allowedToPad
            ? [...opts].sort(byScore)
            : []
          : [...opts].sort(byScore);
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
    /* 挨打的城也能造经济兵（同上，清 9.13）。产不产得出来由引擎和空位说了算 */
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
