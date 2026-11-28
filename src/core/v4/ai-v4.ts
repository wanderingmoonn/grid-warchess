/**
 * v4 的**入口**：一次 `aiNextAction` 只产出一个动作，和 v3/v1 的签名完全一致，
 * 所以游戏、判分器、跑批脚本都能直接换成它。
 *
 * ── 它是唯一知道"三层怎么接起来"的地方 ──────────────────────
 *
 * ```
 *   buildWorld(s)        ← 服务层：算一次，缓存在这一手内
 *        ↓
 *   decide(s, world)     ← 决定层：做什么、管到第几手
 *        ↓
 *   constrain(...)       ← 约束层：哪几格必须空、谁归哪队
 *        ↓
 *   actFor(...)          ← 打分层：产出一个动作
 * ```
 *
 * ── 为什么每回合重算，而不是每步重算 ────────────────────────
 *
 * `aiNextAction` 是**一个动作**调一次。如果每调一次都建一遍 World、重做一遍决定，
 * 那就是 v3 的老毛病（每步都在重新评估，行为在动作之间抖动）。
 * 所以这里按"回合"缓存：同一回合内的后续动作沿用同一份 World 与约束，
 * 只有局面真变了（单位数、金币）才重建。
 */
import { AI_MAX_STEPS, DEFAULT_BUDGET, aiActionKey } from '../ai.ts';
import { playerView } from '../fog.ts';
import { EARTH } from '../board.ts';
import { buildWorld, unitWorth, type World } from './world.ts';
import { decide } from './decide.ts';
import { constrain } from './constrain.ts';
import { actFor, recruitAction, recruitEcon, takeEnc } from './tactics.ts';
import { canSeeTile, effectiveStats, recruitPriceOf, utype, visionOf } from '../rules.ts';
import type { Band, BandReport, Constraints, Decision, V4Memory } from './types.ts';
import type { Action, GameState, PlayerId, Unit } from '../types.ts';

interface TurnCache {
  /** 缓存键：回合号 + 轮到谁 + 单位数 + 金币。变了就重算 */
  key: string;
  world: World;
  decision: Decision;
  con: Constraints;
  /** 这一回合已经试过、被引擎拒的动作（避免每步重试同一个坏动作） */
  tried: Set<string>;
  /** 这一回合已经造了几个兵。**必须有上限**，否则钱会被换成兵、一个兵都不走 */
  recruits: number;
  /** 这一手造的**战斗兵**几个（采购按编队缺口发单时用它算余量） */
  combatRecruits: number;
}

let cache: TurnCache | null = null;

/**
 * 影子观测的窗口（手）。和 `DECIDE_HORIZON` 同尺度：一个决定期内看一次账，
 * 允许短期小亏，长期大亏才动（用户 2026-11-26 定的口径）。
 */
const LANE_WINDOW = 6;

/**
 * 账本最多留几条。**这不是判断，是内存卫生**：一本只增不减的账会跟着存档/回放一直长。
 * 过期怎么算不在这里拍——读者用 `marchTurns` 判（见 `types.ts` 的 `unitSeen`）。
 */
const SEEN_KEEP = 128;

const keyOf = (s: GameState, me: PlayerId): string =>
  `${s.turn}:${s.current}:${s.units.length}:${s.players[me]?.gold ?? 0}:${s.cities.length}` +
  /*
   * **可见性也要进键**（2026-11-27）：玩家随时可能点开/关掉"看全图"，
   * 那一刻回合号、兵数、金币都没变，不带这一位就会命中上一份视图——
   * AI 会用旧的可见性把整手算完，开关等于没生效。
   */
  `:${seeAllOf(s) ? 'v' : '-'}`;

/**
 * 拿这一回合的世界与约束（必要时重建）。
 *
 * 导出它是为了让探针能直接看"v4 这一手打算干什么"——出问题时第一眼看日志，
 * 而不是读代码。
 */
/**
 * **这道题/这一手，AI 看到的是什么**——给人看的一行标签（2026-11-27）。
 *
 * 为什么要它：可见性现在是隐式的。谁把某道题改成 `fog: true`，v4 会立刻变瞎，
 * 而跑批输出里**没有任何提示**——"这题红了是因为 AI 看不见"这件事要靠人去猜。
 * 所以跑批每题打一行，口径和 `seeAllOf` 是同一处，不会分叉。
 */
export function visibilityLabel(s: GameState): string {
  const fog = s.fog === true;
  if (s.config.seeAll === true) return fog ? '有雾·显式全知' : '无雾·显式全知';
  if (s.seeAllSeen === true) return fog ? '有雾·玩家刚看过(一手)' : '无雾·全知';
  return fog ? '有雾·按视野' : '无雾·全知';
}

/**
 * **这一手 AI 能不能看全图**（2026-11-27，用户定的三档）。
 *
 * 1. `config.seeAll === true` —— 题目 / 调试显式开（"这题不考察侦查"）；
 * 2. `state.showAll === true` —— 玩家**此刻正开着** "看全图"（一直看 → AI 也一直看）；
 * 3. `state.seeAllSeen === true` —— 玩家**刚开过关掉了**（看一眼就关 → AI 看这一回合）。
 *
 * 都不满足 → `false`。此时 `playerView` 按 `state.fog` 走：
 * 有雾就只给视野内的，没雾本来就全见。**这就是"和玩家一样"**，不多也不少。
 *
 * ── 为什么第 2 和第 3 档都要有 ────────────────────────────────
 *
 * 只留 `showAll` 不够：玩家常见的动作是**打开看一眼就关掉**，等轮到 AI 时
 * `showAll` 已经变回 false，AI 就白瞎了——所以点按钮那一刻要记一笔（第 3 档）。
 *
 * 只留"记一笔"也不够：玩家**一直开着**的时候不会再点按钮，那一笔早就用掉了，
 * 于是 AI 从第二手起就瞎——而玩家明明整局都在看全图（第 2 档）。
 *
 * 两档合起来才是完整的意思：**玩家看得见多久，AI 就看得见多久**；
 * 中间"关掉了"也不立刻收回，让它用完下一次自己行动的回合（`aiNextActionV4` 返回 `null` 时清）。
 *
 * ⚠️ 这条只管"看得见什么"，**不放开"打得着什么"**：开火目标永远过
 * `tactics.seenFoes`（引擎的 `canSeeTile`），玩家点了看全图也一样打不了视野外的目标。
 */
function seeAllOf(s: GameState): boolean {
  if (s.config.seeAll === true) return true;
  if (s.showAll === true) return true;
  return s.seeAllSeen === true;
}

export function currentView(s: GameState, me: PlayerId): TurnCache {
  const key = keyOf(s, me);
  if (cache && cache.key === key) return cache;
  /*
   * **视野在这里裁一次，然后一路用它。**
   *
   * v4 原来直接读原始局面（能看见全图）——那是作弊，而且会浪费动作：
   * 引擎按 `strikeDistance` + 视野校验，AI 提一个"打视野外的敌人"会被拒
   * （S-002 实测到过"看不见那个位置（视野外）"），那一手就白丢了。
   *
   * 裁完之后的局面里，看不见的敌人**根本不在**，所以所有"能打谁"的判断
   * 自然只包含看得见的。这是"一份真相"在视野上的那一条。
   *
   * ── **这里不传 `clipByVision`，是故意的**（2026-11-27 踩过一次）──────
   *
   * 试过学 `ai.ts` / `ai-v3.ts` 传 `clipByVision = true`（"AI 永远按视野裁"），
   * 想一次修掉"对着视野外敌人开火"。结果 **7 道题翻红**（`P-1-01~04` 等）。
   * 原因：那一挡只在**开雾**的对局里才对得上玩家——
   *   · `ui/board.ts` 只在 `s.fog` 为真时才隐藏单位；
   *   · 关雾（绝大多数考题和实战）时**玩家看得见全图**，只是打不着视野外的目标
   *     （引擎的 `canSeeTile` 与是否开雾无关，`rules.ts` 里写着"看全图 ≠ 能打全图"）。
   *
   * 所以"和玩家同等信息"要分成两句话，混成一句就会让 v4 比玩家更瞎：
   *   · **能打什么** → 跟引擎走（`tactics.seenFoes`，用引擎自己的 `canSeeTile`）；
   *   · **看见什么** → 跟下面这个 `seeAllOf` 走（三档，见 `types.ts` 的 `seeAll`）。
   *
   * 正常对局是**开雾**的（`CONFIG.fogDefault = true`），所以默认必须按视野走；
   * "看全图"只能由题目/调试显式开，或者玩家自己开了（含"刚开过关掉"那一笔）。
   */
  const view = playerView(s, me, seeAllOf(s)).state;
  const world = buildWorld(view, me);
  /*
   * 记忆从**真状态**读、往**真状态**写。
   *
   * 注意 `view` 是 `playerView` 的副本：往副本上写，下一步 `applyAction` 一换状态就没了。
   * 这也解释 v3 为什么把读写都收在 `focusOf` / `setFocus` 两个函数里——只有一处写，
   * 才不会出现"写到了副本上、看起来生效了其实没有"。
   */
  /*
   * **⚠️ 2026-11-28 查出来的一个坑（别删这段说明）**
   *
   * `world` 是拿 `view` 建的，而 `view` 可能已经把敌人裁掉了（`playerView` 在
   * `s.fog && !reveal` 时按视野裁单位）。于是 `world.foeCombat` 里只有**视野内**的敌人，
   * 任何"拿 `s` 里的单位去和 `world.foeCombat` 比对"的地方都会对不上——
   * `tactics` 的遭遇读数就是这么一次都没数到过（`seenFoes(s,u)` 有 1 个、`world.foeCombat` 是 0）。
   *
   * 规矩：**视线的判断一律问引擎 `canSeeTile(s, u.owner, x, y)` + `attackableTargets(s, u)`，
   * 不要从 `world.foeCombat` 里挑人**。`world` 里那些"看得见的敌人"只适合做估算（预警、账本）。
   */
  const mem = memoryOf(s, me);
  const decision = decide(view, world, mem);
  const con = constrain(view, world, decision, mem);
  const nextMem: V4Memory = {
    decision: { ...decision, since: s.turn },
    squad: squadMemo(con, mem, s.turn),
    econSince: econSinceMemo(s, me, mem),
    econHome: econHomeMemo(s, me, mem, world),
    eraPlan: eraPlanMemo(s, decision, mem, s.turn),
    /*
     * **预警点的承诺**（阶段 5 §2.2b）：只有真的派出去人才记。
     * 记了就是一个决定期不动——`T_def` 会跳（实测 1↔9 手），不锁住的话哨兵会来回走。
     */
    alert:
      decision.alert && con.squads.some((q) => q.order === 'scout')
        ? { ...decision.alert, since: s.turn }
        : mem.alert ?? null,
    /* W1 影子观测：只记，不读 */
    bands: con.bands ?? mem.bands,
    /* 工兵队：只有架桥那一条分支会写；别的决定里是 undefined，等于撤编 */
    buildBand: con.buildBand,
    ...laneMemo(s, world, con, decision, mem, s.turn),
  };
  writeMemory(s, me, nextMem);
  logLane(s, world, con, nextMem);
  cache = { key, world, decision, con, tried: new Set(), recruits: 0, combatRecruits: 0 };
  logSquads(s, world.me, world, decision, con, nextMem);
  return cache;
}

/** 读记忆。形状是 `types.ts` 里的 `V4Memory` */
function memoryOf(s: GameState, me: PlayerId): V4Memory {
  return (s.aiFocus?.[me]?.v4 ?? {}) as V4Memory;
}

/**
 * 写记忆。**唯一写入点**（v3 的 `setFocus` 也是这个角色）。
 *
 * 为什么单一写入点重要：v3 的 `aiFocus` 里塞了 plan / squads / keep 一堆缓存，
 * 好几个模块各写各的，于是"这个字段是谁改的"永远说不清——那就是耦合的来源。
 * v4 只允许这一个函数改，且只写两类东西：承诺与事实。
 */
function writeMemory(s: GameState, me: PlayerId, mem: V4Memory): void {
  const bag = { ...(s.aiFocus ?? {}) } as NonNullable<GameState['aiFocus']>;
  bag[me] = { ...(bag[me] ?? {}), v4: mem };
  s.aiFocus = bag;
}

/** 把这一手的编队身份记成事实（成立手数 + 目标人数），供下回合沿用 */
function squadMemo(con: Constraints, mem: V4Memory, turn: number): V4Memory['squad'] {
  const main = con.squads.find((q) => q.id === 'main');
  if (!main || main.order === 'hold' || !main.cityId) return null;
  const prev = mem.squad;
  /* 同一座城、还在有效期内：沿用原来的成立手数与 want（want 不因伤亡而缩） */
  if (prev && prev.cityId === main.cityId && turn - prev.formedAt <= 12) {
    return { ...prev, want: main.want ?? prev.want };
  }
  return {
    id: `${main.cityId}-${turn}`,
    cityId: main.cityId,
    formedAt: turn,
    want: main.want ?? 6,
  };
}

/**
 * 记"每个经济兵是第几手造的"（`unitId → 手数`）。
 *
 * 岗位要按"谁先出生谁走远路、把近处让给新兵"配（见 `constrain.planEconPosts`），
 * 而引擎的单位没有出生手数。这里只记事实：第一次见到它就写上手数，死了就删掉。
 */
function econSinceMemo(s: GameState, me: PlayerId, mem: V4Memory): Record<string, number> {
  const prev = mem.econSince ?? {};
  const out: Record<string, number> = {};
  for (const u of s.units) {
    if (u.owner !== me) continue;
    if (utype(s, u.type).category !== 'economy') continue;
    out[u.id] = prev[u.id] ?? s.turn;
  }
  return out;
}

/**
 * 记"每个经济兵出生在哪座城"（第一次见到它时，离它最近的那座城）。
 *
 * 出生城必须钉住：按"现在离哪座城近"算的话，人一走动最近城就翻，
 * 分组跟着翻，岗位每回合重排，全场兵来回挪。
 */
function econHomeMemo(s: GameState, me: PlayerId, mem: V4Memory, world: World): Record<string, string> {
  const prev = mem.econHome ?? {};
  const out: Record<string, string> = {};
  for (const u of s.units) {
    if (u.owner !== me) continue;
    if (utype(s, u.type).category !== 'economy') continue;
    const near = [...world.myCities].sort(
      (a, b) => Math.abs(u.x - a.x) + Math.abs(u.y - a.y) - (Math.abs(u.x - b.x) + Math.abs(u.y - b.y)),
    )[0];
    out[u.id] = prev[u.id] ?? near?.id ?? '';
  }
  return out;
}

/**
 * **预警读数（阶段 5 §2.2-0，2026-11-27）**：`V4_ALERT_LOG=1` 时每手打一行，**不参与任何判断**。
 *
 * 打的是"现在提前几手知道"：每座我的城，**看得见的敌人里最近的那个，走到城要几手**。
 * 读法：某座城第一次出现一个有限的数，那个数就是「敌人第一次进视野时它离城还有几手」——
 * 这就是 §2.2 要提升的那个读数，也是 `V-2-01` 判据 `alertTurns` 的口径
 * （`marchTurnsOf`，**敌人自己的移动力**，不是我方的）。
 *
 * 为什么不做成"一进视野只打一次"：那要记状态（就得往记忆里加字段）。
 * 每手打一行，"第一次出现有限值"在日志里一眼看得出，而且一个字节都不碰判断。
 */
function logAlert(s: GameState, world: World, con: Constraints, decision: Decision, turn: number): void {
  /* 派出去的会是"最便宜的那个战斗兵"，它的视野就是预警半径（没有兵就报 0） */
  const cheap = [...world.myCombat].sort((a, b) => unitWorth(s, a) - unitWorth(s, b))[0];
  const vision = cheap ? visionOf(s, cheap) : 0;
  const rows: string[] = [];
  for (const city of world.myCities) {
    let best = Infinity;
    for (const f of world.foeCombat) {
      const t = world.marchTurnsOf(f, city, effectiveStats(s, f).move ?? 2);
      if (t < best) best = t;
    }
    const need = world.alertNeed(city);
    /* 最近的那座敌城就是"重点方向"（多座敌城时，第一版先看最近的那条） */
    const foeCity = [...world.foeCities].sort(
      (a, b) => world.marchTurns(a, city) - world.marchTurns(b, city),
    )[0];
    const spot = foeCity && vision > 0 ? world.watchSpot(city, foeCity, vision) : undefined;
    const alert = !Number.isFinite(need)
      ? '需 ∞'
      : need <= 0
        ? '需 0 手'
        : spot?.feasible
          ? `需 ${need} 手 · 预警点 (${spot.at!.x},${spot.at!.y}) 边 (${spot.edge!.x},${spot.edge!.y}) ${world.alertCover(spot.edge!) ? '已覆盖' : '未覆盖'}`
          : `需 ${need} 手 · 预警不可行（${spot?.why ?? '没有战斗兵可派'}）`;
    rows.push(
      `${city.id} 可见敌 ${world.foeCombat.length} · 最近到城 ${Number.isFinite(best) ? `${best} 手` : '—'} · ${alert} · 血 ${city.hp}`,
    );
  }
  /* 这一手到底派了没有（决定层想派 ≠ 计划层派得出） */
  const scout = con.squads.find((q) => q.order === 'scout');
  const act = decision.alert
    ? scout
      ? `派 ${scout.unitIds.join(',')} → (${decision.alert.at.x},${decision.alert.at.y})`
      : '想派·没人可派'
    : '不需要';
  /* 收缩读数（c 步的影子）：进攻时"这一手会被派出去几个 / 家里还剩几个" */
  console.log(
    `[alert] T=${turn} · 敌速 ${world.raidMove} · 视野 ${vision} · 哨兵 ${act} · ${shrinkNote(world, decision)} · ${rows.join(' · ')}`,
  );
}

/**
 * **收缩读数（阶段 5 §2.2c 的影子，2026-11-28）**：只打日志，**不参与任何判断**。
 *
 * 用户 2026-11-28 08:20 定的顺序：**预警不可行时，人类会先"尽快进攻"**——
 * 与其留兵干等，不如趁现在能打就把仗打完；只有当"凑不出能打的部队"时，才退回去
 * **缩减出征规模**（守住老家，用剩下的兵慢慢磨）。
 *
 * 所以这里量的是那两句话的原料，不是结论：
 *   `攻 N`  = 这一手进攻会派出去的人数（不在守、不在架桥、不在岗上的战斗兵）
 *   `留 M`  = 派完之后家里还剩几个
 *   `需 K`  = 家里要组织守军，还得几手（`alertNeed`）
 * 读法：`需 K` 越小、`留 M` 越接近 0，说明"守不住"的概率越大——
 * 这些手才是将来要收缩的手。**现在一条也不改行为。**
 */
function shrinkNote(world: World, decision: Decision): string {
  const atk = decision.kind === 'press' ? 'press' : decision.kind;
  let send = 0;
  let home = 0;
  for (const u of world.myCombat) {
    /* 用"它离最近的我城几手"粗分：一手能回城的算留守，其余算要被派出去 */
    const back = Math.min(...world.myCities.map((c) => world.marchTurns(u, c)), Infinity);
    if (back <= 1) home += 1;
    else send += 1;
  }
  const need = world.myCities.length
    ? Math.max(...world.myCities.map((c) => world.alertNeed(c)))
    : 0;
  return `收缩[${atk}] 攻 ${send} / 留 ${home} / 需 ${Number.isFinite(need) ? need : '∞'} 手`;
}

/**
 * **影子观测：交换账 + 批次 + 断档**（W1.5，2026-11-26）。
 *
 * 只记、不读——这一版仍然**没有任何判断读它**。
 *
 * ── 交换账 ────────────────────────────────────────────────
 *
 * 引擎不报"击杀事件"，所以只能**逐手差分**：上一次见到的单位这一手没了，就按它的
 * **造价**记一笔（不按残血——残血的兵换掉对方一个贵的，仍然算赚，这是用户定的口径）。
 * 同时把死亡位置记下来，按"离哪条线最近"归到那条线（W1.5 第 2 条：一本总账在两条线时会砍错线）。
 *
 * `DISBAND`（自己拆兵）不会被误算：**v4 根本不拆兵**（`grep DISBAND src/core/v4/` 只有
 * 一处 `forbid`）——用户 2026-11-26 指出。以后如果真加了拆兵，要在这里补一条排除。
 *
 * ── 批次（"一波"= 一批人）──────────────────────────────────
 *
 * 第一版记的是"整支主队的一次行军"（一个槽位、按城市认）：后来补的兵被记成同一波的到货，
 * 于是"一批一批往上送"这件事**根本没被记下来**。现在每个兵记着它属于哪一批（`waveOf`），
 * 新造出来的兵**开新的一批**；一批结束有三种：到齐（活着的人全进前线）/ 打光 / 撤回。
 * 已经进前线的人不再属于任何一批——前线是存量，批次只是投送的单位。
 *
 * ── 断档 ──────────────────────────────────────────────────
 *
 * 一条线"开过、还想着打"的时候，**前线 0 人、路上也 0 人** = 断档（连续几手记一次）。
 * 它和 `stuck` 是两件事：`stuck` 是路上有货过不来，断档是没货可过。
 */
function laneMemo(
  s: GameState,
  world: World,
  con: Constraints,
  decision: Decision,
  mem: V4Memory,
  turn: number,
): Pick<
  V4Memory,
  'unitSeen' | 'exchange' | 'exchangeByCity' | 'waves' | 'waveOf' | 'lineGap' | 'lineFront'
> {
  const seen = mem.unitSeen ?? {};
  const exchange = mem.exchange ?? [];
  /* 深拷贝：这一手会原地改批次，别改到上一手的记忆对象上 */
  const waves = (mem.waves ?? []).map((w) => ({
    ...w,
    alive: [...w.alive],
    arrivedIds: [...w.arrivedIds],
    arrivals: [...w.arrivals],
  }));
  const byCity = Object.fromEntries(
    Object.entries(mem.exchangeByCity ?? {}).map(([k, v]) => [k, [...v]]),
  ) as NonNullable<V4Memory['exchangeByCity']>;
  const waveOf = { ...(mem.waveOf ?? {}) };
  const lineGap = { ...(mem.lineGap ?? {}) };
  /*
   * **这一眼"看到"的东西**（阶段 5 §2.1c，2026-11-27）。
   *
   * 只有两样：**我自己的单位**（我的兵在哪我永远知道）+ **我看得见的敌人**。
   * 原来是 `s.units` 全抄——那是用只有引擎知道的全图去算账，
   * 于是"雾里对面死了一个兵" v4 也知道，账再喂给决定层（判这条线赚不赚）= 开了全图。
   *
   * **"看得见"用的是同一套口径**（不是另发明一个）：
   * 开雾 → 引擎的 `canSeeTile`；没雾 / 玩家开着看全图 → 和玩家一样看得见全图。
   * 这就是阶段 4 定的那一句"**看见什么跟 `s.fog`，能打什么跟 `canSeeTile`**"：
   * 账本记的是"看见什么"，所以照前半句；打谁仍由 `tactics.seenFoes` 管，不在这一层。
   */
  const sees = (x: number, y: number): boolean => seeAllOf(s) || canSeeTile(s, world.me, x, y);
  const now: NonNullable<V4Memory['unitSeen']> = {};
  const visFoe = new Set<string>();
  for (const u of s.units) {
    if (u.owner !== world.me) {
      /* 别人的坐标只在两个前提下有意义：地球上的、我看得见的（`sees` 只认地球格号） */
      if (u.board !== undefined && u.board !== EARTH) continue;
      if (!sees(u.x, u.y)) continue;
      visFoe.add(u.id);
    }
    now[u.id] = { type: u.type, owner: u.owner, x: u.x, y: u.y, turn };
  }

  /*
   * **"死了"和"走开了"怎么分清**（§2.1c 最费劲的一处，2026-11-27）。
   *
   * 引擎不报击杀事件，只能看"上一眼还在、这一眼不见了"。可在雾里这两件事长得一样：
   * 它可能被打死了，也可能正好从视野边上走出去。**这件事没有精确解**
   * （玩家能分是因为他看见棋子一格一格在动，AI 只拿到每手的快照）。
   *
   * 试过的两个极端，都量过：
   *   · **"最后那格还看得见"就算死**（现在这条）：`S-004` 开雾时会有幽灵收益
   *     （走出去的敌人被记成击杀，约 45 金/手）。误差方向是**高估收益**。
   *   · **"它这一步能去的格子全在我视野里"才敢算死**（严格证明版）：
   *     `S-002` 开雾量出 2000 金的真实击杀、账本记 **0 金** —— 太严，
   *     等于雾里永远没有收益，那条线会被判成"一直在亏"，v4 就再也不进攻了。
   *
   * 取前者：**只用它真正看见过的东西**（记录是视野内写的、判断也用视野），
   * 剩下的是一个方向已知的小偏差，写在 `docs/PLAN-V4-PHASE5` §2.1c 里。
   *
   * ⚠️ 这一步**不能关在"一手只差分一次"那道门后面**：一手里最后一下打死的人，
   * 是在这次写账之后才消失的。门一关，这笔记录要拖到下一手才删，
   * 于是每一手都挂着一个 1 手前的幽灵，判据就以为"城门口还有人"、守势无限续期
   * （`R-1-01` 直接翻红）。删记录是**事实更新**，不是记账；记账才需要那道门。
   */
  const kept: NonNullable<V4Memory['unitSeen']> = {};
  /* 算作死亡的那些：只有它们进账本收益（判断只写一次，下面差分直接读） */
  const deadFoe = new Set<string>();
  for (const [id, r] of Object.entries(seen)) {
    if (r.owner === world.me) continue; /* 我的兵：以这一眼为准，别留旧记录 */
    if (visFoe.has(id)) continue; /* 还看得见：以这一眼为准 */
    if (r.x === undefined || r.y === undefined) continue; /* 老格式没位置，判不了 */
    if (sees(r.x, r.y)) deadFoe.add(id); /* 那格看得见、人却没了 → 死了 */
    else kept[id] = { ...r, gone: true }; /* 看不见了 → 挂账（给预警用，账上不结） */
  }
  const nextSeen: NonNullable<V4Memory['unitSeen']> = { ...kept, ...now };
  /*
   * 内存卫生：超了就从"最久没见"的开始删。
   * 挂账的那些本来就不会再刷新 `turn`，所以先被删的是它们——这是有意的：
   * 一支消失了太久的部队，既不该算收益，也不该再让守势续期。
   */
  const seenIds = Object.keys(nextSeen);
  if (seenIds.length > SEEN_KEEP) {
    seenIds.sort(
      (a, b) => (nextSeen[a]!.turn ?? 0) - (nextSeen[b]!.turn ?? 0) || (a < b ? -1 : 1),
    );
    for (const id of seenIds.slice(0, seenIds.length - SEEN_KEEP)) delete nextSeen[id];
  }
  /*
   * **一手只差分一次**：`currentView` 一手内会被多次重建（每花一笔钱一次），
   * 不设这道门就会把同一批死亡记好几遍。
   * 注意"删死记录 / 更新这一眼"在上面已经做完了，这里只挡记账。
   */
  const alreadyDiffed = exchange.length > 0 && exchange[exchange.length - 1]!.turn === turn;
  /* 预警读数：同一道门，一手打一行（阶段 5 §2.2-0，只打日志） */
  if (!alreadyDiffed && process.env.V4_ALERT_LOG) logAlert(s, world, con, decision, turn);
  /*
   * **遭遇读数**（阶段 5 §2.6 第 0 步）：`V4_ENCOUNTER_LOG=1` 时每手一行。
   * `够了` = 偏一步就能打到、却没打的人次；`打了` = 本来就打到的人次。
   * 只打日志、不参与判断。`takeEnc()` 会清零，所以一行就是一手。
   */
  if (process.env.V4_ENCOUNTER_LOG) {
    const tally = takeEnc();
    if (tally.length > 0) {
      /* 人次（一个兵可能被问多次，所以也报"兵数"：用第一手的人头数当分母） */
      const got = Object.fromEntries(tally);
      console.log(
        `[enc] T=${turn} ${decision.kind}${decision.stage ? '/' + decision.stage : ''} · 打了 ${got['打了'] ?? 0} · 够了没打 ${got['够了没打'] ?? 0} · 没够着 ${got['没够着'] ?? 0} · 没看见敌 ${got['没看见敌'] ?? 0}`,
      );
    }
  }
  if (alreadyDiffed) {
    return {
      unitSeen: nextSeen,
      exchange,
      exchangeByCity: byCity,
      waves,
      waveOf,
      lineGap,
      lineFront: mem.lineFront ?? {},
    };
  }

  /* 进行中的线（还没结束的批次所属的城市）——死亡按"离哪条线最近"归属 */
  const openCities = [...new Set(waves.filter((w) => !w.endTurn).map((w) => w.cityId))]
    .map((id) => s.cities.find((c) => c.id === id))
    .filter((c): c is NonNullable<typeof c> => !!c);

  let gain = 0;
  let loss = 0;
  const gainBy: Record<string, number> = {};
  const lossBy: Record<string, number> = {};
  for (const [id, prev] of Object.entries(seen)) {
    if (now[id]) continue; /* 这一眼还看得见 → 没死 */
    const mine = prev.owner === world.me;
    /*
     * **敌人不见了，要先分清是死了还是走了**（§2.1c 的核心）。
     * 这一条判断只在上面的 `kept` 循环里做一次（`deadFoe`），这里只认它的结论——
     * 同一件事不写第二个答案。挂账（`gone`）和"没证住"的，一分钱都不进收益。
     */
    if (!mine && !deadFoe.has(id)) continue;
    const price = recruitPriceOf(s, prev.owner as PlayerId, utype(s, prev.type)).gold;
    if (mine) loss += price;
    else gain += price;
    /* 位置是老记忆可能没有的字段：没有就只进总账，不硬猜 */
    if (prev.x === undefined || prev.y === undefined || openCities.length === 0) continue;
    const near = [...openCities].sort(
      (a, b) =>
        Math.abs(a.x - prev.x!) + Math.abs(a.y - prev.y!) - (Math.abs(b.x - prev.x!) + Math.abs(b.y - prev.y!)),
    )[0]!;
    if (mine) lossBy[near.id] = (lossBy[near.id] ?? 0) + price;
    else gainBy[near.id] = (gainBy[near.id] ?? 0) + price;
  }
  const ex = [...exchange, { turn, gain, loss }].slice(-LANE_WINDOW);
  for (const c of openCities) {
    byCity[c.id] = [
      ...(byCity[c.id] ?? []),
      { turn, gain: gainBy[c.id] ?? 0, loss: lossBy[c.id] ?? 0, hp: c.hp },
    ].slice(-LANE_WINDOW);
  }

  /* ── 批次 ① 编成：还没编过批、或上一批已结束的兵 = 新的一批（同一手同一座城只开一批） */
  /*
   * **只有"打敌城"的队才算一条线。**
   *
   * 守城的队（`hold`，把外面的兵收回城下）也是"一队人有座城"，但它不是投送；
   * 接管废墟也不是（目标是自己的废墟，不是敌城）。不加这两条，S-012 那种
   * "一直在守"的题会被记成开了 7 批——数就全废了。
   */
  const lines = con.squads.filter((q) => {
    if (!q.cityId) return false;
    if (q.order !== 'march' && q.order !== 'siege' && q.order !== 'assemble') return false;
    const c = s.cities.find((x) => x.id === q.cityId);
    return !!c && !!c.owner && c.owner !== world.me && c.ruined !== true;
  });
  /*
   * **批 = 编队**（W3.5）：编队 id 就是批 id，编队名册就是这批人的名册。
   * 编队出发后不改人数，所以一批的人数从出生那一刻就定了，不会每手"滑"。
   */
  for (const line of lines) {
    if (waves.some((w) => w.id === line.id)) continue;
    waves.push({
      id: line.id,
      cityId: line.cityId!,
      bornTurn: turn,
      men: line.unitIds.length,
      alive: [...line.unitIds],
      arrivedIds: [],
      arrivals: [],
    });
    for (const uid of line.unitIds) waveOf[uid] = line.id;
  }

  /* ── 批次 ② 逐批推进：**先记到货，再判这一批还开不开** */
  for (const w of waves) {
    if (w.endTurn) continue;
    const city = s.cities.find((c) => c.id === w.cityId);
    const line = lines.find((q) => q.cityId === w.cityId);
    /*
     * 顺序很重要：**先把这一手的到货记上，再判结束**。
     * 反过来写，"打到最后一手才进城"的兵永远记不上（S-000 T11：城一被拿下，
     * 那手的到货就被 `gone` 吞掉了，读出来的"到人"少一半）。
     */
    const alive = city ? w.alive.filter((id) => !!s.units.find((u) => u.id === id)) : [];
    const contact = city ? new Set(world.contacts(alive, city)) : new Set<string>();
    const arrived = new Set(w.arrivedIds);
    const fresh = [...contact].filter((id) => !arrived.has(id));
    for (const id of fresh) arrived.add(id);
    const road = alive.filter((id) => !arrived.has(id)).length;
    if (line && w.startTurn === undefined && (line.order === 'march' || line.order === 'siege')) {
      w.startTurn = turn;
      /* 出发那一刻的预计：用它判"是不是比预计还晚"，避免正常行军被算成堵 */
      w.eta0 = line.eta;
    }
    w.alive = alive;
    w.arrivedIds = [...arrived];
    if (city && !city.ruined) w.arrivals.push(fresh.length);
    /* 连续几手"有人在路上、却一个人都没到" = 这一段堵住了（没出发前不算） */
    const overdue = w.startTurn !== undefined && s.turn - w.startTurn >= (w.eta0 ?? 0) + 2;
    w.stuck = overdue && fresh.length === 0 && road > 0 ? (w.stuck ?? 0) + 1 : 0;

    /*
     * 城没了 / 已经不是敌城（打下来了 / 丢了）→ 这条线到此为止，但**不算撤退**。
     * 这两种要分开记：`gone` 是结果，`withdrawn` 是放弃。
     */
    if (!city || city.ruined === true || (city.owner && city.owner === world.me)) {
      w.end = 'gone';
      w.endTurn = turn;
      continue;
    }
    /*
     * 这一手没有指向这座城的队 → **先记一手"没队"，不马上判撤回**。
     *
     * 为什么不马上撤：v4 在"打"和"守"之间来回切很常见（敌人贴脸就召回一手，
     * 下一手又推）。按一手就撤，S-000 会被切成 3 批、每批的到货记录都从零开始，
     * 读出来的"到人"凭空少一半。连续两首都这样，才算这条线不要了。
     */
    if (!line) {
      w.miss = (w.miss ?? 0) + 1;
      if (w.miss >= 2) {
        w.end = 'withdrawn';
        w.endTurn = turn;
      }
      continue;
    }
    w.miss = 0;

    /*
     * **只有打光才结束**（W3.5）：编队是"打到死为止"的单位，到了城下不算结束。
     * 这也是它和"一波人"的区别——人到了就并进前线，队伍还在。
     */
    if (alive.length === 0) {
      w.end = 'wiped';
      w.endTurn = turn;
    }
  }

  /* ── 断档：线开过、还想着打，但前线 0 人、路上 0 人 */
  const counts = new Map<string, { front: number; road: number }>();
  for (const line of lines) {
    const city = s.cities.find((c) => c.id === line.cityId);
    if (!city) continue;
    const st = world.laneStats(line.unitIds, city);
    counts.set(line.cityId!, { front: st.front + st.engaged, road: st.road });
  }
  /* 决定还在打这座城、但这一手连队都没了（人打光了）：这条线仍在，照样算断档 */
  if (decision.kind === 'press' && decision.cityId && !counts.has(decision.cityId)) {
    counts.set(decision.cityId, { front: 0, road: 0 });
  }
  const lineFront: Record<string, number> = {};
  for (const [cid, v] of counts) lineFront[cid] = v.front;
  for (const [cid, v] of counts) {
    /* "开过"才算断档：这条线一批都没编过（决定说打、实际没人可派）不算 */
    if (!waves.some((w) => w.cityId === cid)) continue;
    const g = lineGap[cid] ?? { run: 0, total: 0, worst: 0, noFront: 0 };
    if (v.front === 0) g.noFront += 1;
    if (v.front === 0 && v.road === 0) {
      g.run += 1;
      g.total += 1;
      g.worst = Math.max(g.worst, g.run);
    } else g.run = 0;
    lineGap[cid] = g;
  }

  /* ── 只留最后 8 批已结束的（长局里批次数会一直涨；没结束的一律保留） */
  const done = waves.filter((w) => !!w.endTurn);
  if (done.length > 8) {
    const drop = new Set(done.slice(0, done.length - 8).map((w) => w.id));
    for (let i = waves.length - 1; i >= 0; i--) if (drop.has(waves[i]!.id)) waves.splice(i, 1);
    for (const [uid, wid] of Object.entries(waveOf)) if (drop.has(wid)) delete waveOf[uid];
  }

  return { unitSeen: nextSeen, exchange: ex, exchangeByCity: byCity, waves, waveOf, lineGap, lineFront };
}

/**
 * 把影子观测打成一行（`V4_LANE_LOG`）。
 *
 * 读法：
 *   `[lane] T=9 c2 front=3 接火=3 road=12 make=0 · 批 3批(并1光1) · c2@T1 4/10人·到9 路 · 本手+0 堵0 断档0/0 · 交换(6手) 赚180 亏0 | 本线 赚180 亏0`
 *
 * `front/接火/road/make` 是这条线这一手的存量；`批` 是开过几批、其中几批送完几批打光；
 * 再后面是当前在途那一批（`到N` = 累计到过前线几个人）；`断档 run/累计`；
 * `交换` 是全图总账，`本线` 是按位置归到这座城的账。
 */
function waveBrief(w: NonNullable<V4Memory['waves']>[number]): string {
  const tag =
    w.end === 'merged'
      ? '并'
      : w.end === 'wiped'
        ? '光'
        : w.end === 'withdrawn'
          ? '撤'
          : w.end === 'gone'
            ? '失'
            : w.startTurn === undefined
              ? '集'
              : '路';
  return `${w.cityId}@T${w.bornTurn} ${w.alive.length}/${w.men}人·到${w.arrivedIds.length} ${tag}`;
}

/**
 * **这一手"这条路过不过得去"的一句话**（W4-4d-1，2026-11-26）。
 *
 * 完全是观测：`world.bridgeOutlook` 只被这里读，没有任何判断用它。
 * 目标城取"这一手有队伍要去的敌城"，没有队伍时取最近的敌城。
 */
function bridgeText(s: GameState, world: World, con: Constraints): string {
  const target =
    s.cities.find((c) => c.id === con.squads.find((q) => !!q.cityId)?.cityId) ?? world.foeCities[0];
  if (!target) return '';
  const o = world.bridgeOutlook(target);
  /* 只有真的派出工兵了才报"工兵上"；没有建造单位时报"先占岸"（阶段是意图，未必有人） */
  const stage = con.buildBand ? 'build' : con.bridgeStage === 'seize' ? 'seize' : undefined;
  return ` · 桥 ${o.why}${o.cost ? `（${o.cost.gold} 金 / ${o.cost.work} 工时）` : ''}` +
    (stage ? ` · ${stage === 'seize' ? '先占岸' : '工兵上'}` : '');
}

let laneLoggedTurn = -1;

function logLane(s: GameState, world: World, con: Constraints, mem: V4Memory): void {
  if (!process.env.V4_LANE_LOG) return;
  /* 一手只打一行：`currentView` 一手内会被重建多次（每花一笔钱一次） */
  if (laneLoggedTurn === s.turn) return;
  laneLoggedTurn = s.turn;
  const lane = con.lane;
  const cid = con.squads.find((q) => !!q.cityId)?.cityId;
  const ex = mem.exchange ?? [];
  const gain = ex.reduce((n, x) => n + x.gain, 0);
  const loss = ex.reduce((n, x) => n + x.loss, 0);
  const ofLine = (cid ? mem.exchangeByCity?.[cid] : undefined) ?? [];
  const lineGain = ofLine.reduce((n, x) => n + x.gain, 0);
  const lineLoss = ofLine.reduce((n, x) => n + x.loss, 0);
  const waves = (mem.waves ?? []).filter((w) => !cid || w.cityId === cid);
  const open = waves.filter((w) => !w.endTurn);
  const merged = waves.filter((w) => w.end === 'merged').length;
  const wiped = waves.filter((w) => w.end === 'wiped').length;
  const withdrawn = waves.filter((w) => w.end === 'withdrawn').length;
  const gone = waves.filter((w) => w.end === 'gone').length;
  const last = open.at(-1);
  const gap = cid ? mem.lineGap?.[cid] : undefined;
  process.stderr.write(
    `[lane] T=${s.turn} ${cid ?? '-'} front=${lane?.front ?? '-'} 接火=${lane?.engaged ?? '-'} road=${lane?.road ?? '-'} make=${lane?.make ?? '-'}` +
      ` · 批 ${waves.length}批(并${merged}光${wiped}撤${withdrawn}失${gone})` +
      `${open.length > 0 ? ` · ${open.slice(-4).map(waveBrief).join(' ; ')}` : ' · 无在途批'}` +
      ` · 本手+${last?.arrivals.at(-1) ?? 0} 堵${last?.stuck ?? 0} 断档${gap?.run ?? 0}/${gap?.total ?? 0}` +
      ` · 交换(${ex.length}手) 赚${gain} 亏${loss} | 本线 赚${lineGain} 亏${lineLoss}` +
      `${lane?.seats !== undefined ? ` · 站得开 ${lane.seats} 格` : ''}` +
      /* W4-4d-1：这条路过不过得去、过不去要从哪架桥（只观测，没有任何判断读它） */
      `${bridgeText(s, world, con)}` +
      '\n',
  );
  /*
   * **每队一行**（W3.6 第 6 步）：掉的、到的、堵的、还有几手到。
   * 这几个数原来在回放里全是 0 占位，所以"哪一队在卡"只能靠猜。
   */
  /* 工兵这一手的目标（W4-4d-3 观测）：岸点 → 要修的那一格，以及它现在站哪 */
  const bq = con.squads.find((q) => q.order === 'build');
  if (bq) {
    const pos = bq.unitIds
      .map((id) => s.units.find((u) => u.id === id))
      .filter((u): u is Unit => !!u)
      .map((u) => `${u.x},${u.y}`)
      .join(' ');
    process.stderr.write(
      `[build] T=${s.turn} 岸(${bq.at?.x ?? '-'},${bq.at?.y ?? '-'}) 建(${bq.buildAt?.x ?? '-'},${bq.buildAt?.y ?? '-'}) 工兵@${pos}\n`,
    );
  }
  const reps = bandReports(s, world, con, mem);
  if (reps.length > 0) {
    process.stderr.write(
      `[band] T=${s.turn} ` +
        reps
          .map(
            (r) =>
              `${r.id}[${r.state === 'forming' ? '集' : (r.order ?? '?')}] ${r.alive}/${r.men}` +
              `${r.want > r.alive ? `(缺${r.want - r.alive})` : ''}` +
              ` 掉${r.lost} 到${r.arrived}${r.stuck ? ` 堵${r.stuck}` : ''}` +
              `${r.turnsToTarget !== undefined ? ` 距${r.turnsToTarget}手` : ''}` +
              `${r.narrow ? ` 窄${r.narrow.width}格@${r.narrow.at} 排${r.narrow.queue} 要${r.narrow.crossTurns}手` : ''}`,
          )
          .join(' · ') +
        '\n',
    );
  }
}

/**
 * 记"这一局决定升到第几代"（D5）。
 *
 * 它替代的是原来那道 `world.myCombat.length === 0` 的门——那道门治的是**漂移**
 * （升级费是沉没成本，每手重算都像从零开始），副作用是"先造了一个兵再暴富就永远升不了"。
 * 承诺只记这件事本身，和场上有没有兵无关。
 *
 * 只在一件事上更新：决定层这手给出了**新的**经济升级目标。其余情况一律沿用——
 * 包括"目标已经达成"（那时 `upgrade` 是 undefined，承诺必须留着，否则下一手又重新规划，
 * 又会挑一个更贵的代，就是原来的漂移）。
 */
function eraPlanMemo(
  s: GameState,
  decision: Decision,
  mem: V4Memory,
  turn: number,
): V4Memory['eraPlan'] {
  const VALID = 12;
  const prev = mem.eraPlan ?? null;
  const alive = prev && turn - prev.since <= VALID ? prev : null;
  /* 城没了 / 成废墟 → 承诺作废。
   * ⚠️ `ruined` 是**可选**字段：正常城是 `undefined`，不是 `false`。
   * 写成 `?.ruined ?? true` 会把每座正常城都当成废墟（2026-11-26 踩到：承诺刚立就作废）。 */
  if (alive && !isLiveCity(s, alive.cityId)) return null;
  const up = decision.upgrade;
  if (!up || up.kind !== 'econ' || up.candidates.length === 0) return alive;
  const first = up.candidates[0]!;
  if (alive && alive.cityId === first.cityId && alive.targetEra === first.targetEra) return alive;
  return { cityId: first.cityId, targetEra: first.targetEra, since: turn };
}

/** 这座城还在、还没成废墟（`ruined` 是可选字段，不能拿 `?? true` 判） */
function isLiveCity(s: GameState, cityId: string): boolean {
  const c = s.cities.find((x) => x.id === cityId);
  return !!c && c.ruined !== true;
}

/** 给探针清缓存用（换局时调一次） */
export function resetV4(): void {
  cache = null;
  laneLoggedTurn = -1;
}

/**
 * 主入口。和 v1/v3 的 `aiNextAction` 同签名，可直接替换。
 *
 * 顺序是硬的：
 *   ① 有单位挡着"必须空"的格子 → 让开
 *   ② 有单位能打 → 打
 *   ③ 有钱 → 造兵
 *   ④ 有单位的任务没走完 → 走
 *   ⑤ 都没了 → null（收手）
 */
export function aiNextActionV4(
  s: GameState,
  _budget: typeof DEFAULT_BUDGET = DEFAULT_BUDGET,
  rejected: ReadonlySet<string> = new Set(),
): Action | null {
  const me = s.current;
  const view = currentView(s, me);
  const { world, con } = view;
  /*
   * **下面用的是真状态 `s`，不是 `view.state`**（2026-11-27 试出来的）
   *
   * 试过把 `s` 整个换成裁剪后的 `view.state`（想让"看不见的敌人不在"一次生效）。
   * 两个后果都很硬：
   *   ① 它是**这一手开始时**的快照，动作一个一个结算它不跟着变 → 同一个兵被反复派 MOVE
   *      （引擎："该单位本回合已经移动过"，全册 **4054** 次），把真问题全盖住了；
   *   ② `hp` 也永远是满的，于是 `sort((a,b)=>a.hp-b.hp)` 每一手都挑错目标——
   *      `D-1-02` 因此一个敌人都打不死（那题的判据正是"6 手内至少打死一个"）。
   *
   * **hp 和 moved 一样是"动态事实"，不是"视野信息"**：这一手打成什么样，自己当然知道。
   * 所以动作选择留在真状态上；"能不能打"另由 `tactics.seenFoes` 按引擎的 `canSeeTile` 过滤。
   */

  const usable = (a: Action | null): a is Action =>
    !!a && !rejected.has(aiActionKey(a)) && !view.tried.has(aiActionKey(a));

  /* ① 让开：站在 keepClear 上的战斗单位（经济兵也照办，它们同样会堵产兵格） */
  for (const u of s.units.filter((x) => x.owner === me)) {
    /* 本回合已经动过的跳过：新兵出生就在产兵格上，且它的行动已经用掉了。
     * 不跳过的话，这里会一直给它派"让开"，然后被引擎反复拒（实测每回合空烧十几次） */
    if (u.moved || u.acted) continue;
    if (!con.keepClear.includes(u.y * s.w + u.x)) continue;
    /*
     * **有临时调令的挡路兵排在最后走**（2026-11-25，9.18 的收尾）。
     *
     * 它们这一手的任务是"走出去归队"，不是"让给别人用"——没必要抢在开火和走位之前。
     * 实测把它们放在这里（最先动）会让 S-002 的城伤从 45 掉到 30：
     * 十几个人抢在整队之前挪动，把 `planMarch` 排好的落点占了，整队重新贪心一次。
     * 交给 ④（走位，按 `stepOrder` 排在最后）就没有这场抢跑。
     */
    if (con.transit?.[u.id]) continue;
    const a = actFor(s, world, con, u);
    if (usable(a)) return a;
  }

  /*
   * ② 打。**只跳过"本回合已经攻击过"的，不跳"已经走过"的。**
   *
   * 引擎的规则是"一回合打一次"，走过路照样能开火。这里原来把 `moved` 也跳了，
   * 等于每个兵每回合只能走或打二选一——火力直接砍半（S-002 三十个兵挤在城下
   * 四格，每回合只打得出 0~1 次）。
   */
  for (const u of world.myCombat) {
    const live = s.units.find((x) => x.id === u.id);
    if (!live || live.acted) continue;
    const a = actFor(s, world, con, live);
    /*
     * **`SIEGE` 也算"打"。**
     *
     * 这里原来只认 `ATTACK`，于是"砸城"被留到后面的逐单位走位循环里，
     * 而那个循环会先执行走位计划——兵就算贴着城墙也先被派去走一格。
     * S-016 实测：8 个兵围着空城，10 手只砸出 46 血（v1/v3 同局面 81 血打空）。
     * `actFor` 内部本来就是"攻城优先于打人"，所以这一处放开就同时保住了
     * S-000 那条"守军站在城格上时要先砸城"。
     */
    if (usable(a) && a && (a.type === 'ATTACK' || a.type === 'SIEGE')) return a;
  }

  /*
   * ③.0 **应急升级**（2026-11-25，P3 闸 A）：约束层判"城 ≤2 轮会塌、升完能多撑一轮、
   * 且剩下的钱还买得起一个打得穿又活得到的兵"，三条全过才给。
   *
   * 排在造兵**之前**：升级是资本支出，先把墙和能力定下来，再拿剩下的钱造兵——
   * 反过来（先造兵）会把升到下一代的 360 金提前花掉，之后再想升就凑不齐了。
   * "不许把造兵的路堵死"由那条闸自己保证（见 `Constraints.upgrade`）。
   *
   * 排在攻击**之后**：攻击不花钱，免费的伤害没有理由让路。
   */
  if (con.upgrade) {
    const up: Action = { type: 'UPGRADE', cityId: con.upgrade.cityId };
    if (usable(up)) return up;
  }

  /*
   * ③ 造兵：**不设人为上限**。
   *
   * 这里原来写着"每回合最多 2 个"，理由是 S-000 上不设限会把 200 金一口气换成 8 个民兵、
   * 动作预算全花在造兵上。但那是**v1 自戴的帽子**：引擎里真正的约束是**出兵格**
   * （城里空格 + 军营四周的格子），满了就造不出——用户 2026-11-24 指出这一点。
   *
   * 现在改成：能造就一直造，造不出来时引擎会拒（产兵格满），`usable` 会把它挡掉，
   * 循环自然结束。**不再用一个人为数字去代替规则本身。**
   */
  {
    /*
     * ③ 造兵：**照决定层给的"钱怎么花"发**（D1，2026-11-25）。
     *
     * 这里原来有三个局部布尔（`saving` / `preferEcon` / `needArmy`）——它们其实是
     * "在打 / 在守 / 在发展"的推论，却写在动作选择器里。现在它们在 `decide.ts` 的
     * `withSpend` 里，和"打谁、管到第几手"是同一句话。
     *
     * 这一层只剩三件事：**照着模式发动作、`usable` 挡掉被引擎拒的、`recruits` 记账**。
     * 四个模式各自什么意思，见 `types.ts` 的 `SpendMode`；判据一个字没改，
     * 所以这一步 33 道题的读数必须一字不变。
     */
    const sp = view.decision.spend;
    /*
     * **架桥先造人**（W4-5a，2026-11-26）：计划层给了"这城造这个工兵"，这里只发出去。
     *
     * 排在"照模式造兵"**之前**，也不看花钱模式：钱一旦被战斗兵吃掉，工兵就永远造不出来，
     * 桥永远铺不了，决定会一直卡在"先占岸"（`G-16x16-era1` 就是这么输的）。
     * 工兵造出来之后计划层自然不再下单（它只问"手上有几个工兵"）。
     */
    if (con.recruitBuilder) {
      const rb: Action = {
        type: 'RECRUIT',
        cityId: con.recruitBuilder.cityId,
        unitType: con.recruitBuilder.unitType,
      };
      if (usable(rb)) {
        view.recruits += 1;
        return rb;
      }
    }

    /*
     * **采购按编队缺口发单**（W3.6 第 5 步，2026-11-26）。
     *
     * 试过"按编制封顶"（编制之和 + 一支预备队就停），**实测不行**：E-2-03 是一道
     * "把 4000 金变成战力"的题，场上只有两个 1 人小队、编制也是 1，封顶 5 个就停了，
     * 部队战力 897 → 454，直接翻红。
     * 结论：**编制是"最少要几个"，不是"最多造几个"**——采购该按缺口补员、按产兵格刹车，
     * 不该拿编制去封顶。"缺员时优先造兵"那条在决定层的 `withSpend` 里做。
     */
    const army = recruitAction(s, world, con.need, con.spendCap);
    const rec =
      sp.mode === 'save'
        ? null
        : sp.mode === 'econOnly'
          ? recruitEcon(s, world, con)
          : sp.mode === 'econThenArmy'
            ? recruitEcon(s, world, con) ?? army
            : army;
    if (usable(rec)) {
      view.recruits += 1;
      /* 只记战斗兵：经济兵不占编队的编制 */
      if (rec.type === 'RECRUIT' && rec.unitType !== con.econNext?.type) view.combatRecruits += 1;
      return rec;
    }
  }

  /*
   * ④ 走。**经济兵按"离自己岗位多近"排队，近的先走。**
   *
   * 为什么顺序重要：排成一列时，只有前面的人先挪开，后面的人才看得到"更近的格"。
   * 按建立顺序走（老兵先动）听着对，但它排序的是"谁老"，不是"谁在前面"——
   * 前排没动，后排就整手卡死。实测：丘陵上一列牧民，最边上那个 8 手都进不去。
   *
   * 每调一次都按**当下**的位置重排（动作一个一个结算，前面的走完，后面的距离就变了）。
   */
  /*
   * 顺序**由约束层给**（`con.econOrder`：靠自己岗位近的在前，按真实步数排）。
   *
   * 这里原来自己算"直线距离"来排——那是打分层在做微观决策，而且直线距离会把
   * "看着近、其实要绕一大圈"的人排到前面，他先动反而堵路。
   * 现在入口只负责**照着顺序派动作**，不再参与判断。
   */
  const rank = new Map((con.econOrder ?? []).map((id, i) => [id, i]));
  const econOrder = [...world.myEcon].sort(
    (a, b) => (rank.get(a.id) ?? 1e9) - (rank.get(b.id) ?? 1e9),
  );
  /*
   * **战斗兵也按约束给的顺序走**（`stepOrder`：离自己终点近的在前）。
   *
   * 30 个人挤成一团时，只有前排先挪开，后排的落点才空出来。
   * 按单位建立顺序派动作的话，后排常常先执行、把前排要去的格占了，
   * 前排就不动了——整队每手几十个 MOVE，实际原地踏步（S-002 实测）。
   */
  const combatRank = new Map((con.stepOrder ?? []).map((id, i) => [id, i]));
  const combatOrder = [...world.myCombat].sort(
    (a, b) => (combatRank.get(a.id) ?? 1e9) - (combatRank.get(b.id) ?? 1e9),
  );
  /*
   * **建造单位也要派动作**（W4-4d-2，2026-11-26）。
   *
   * 以前这里只有"战斗兵 + 经济兵"，而工兵是第三类（`category === 'builder'`）——
   * 结果架桥分支把工兵编进队伍、给了目标点，它却一步没动（临时验证：第 8 手还在城里）。
   * 排在最后：战斗兵先动，工兵跟在后面。
   */
  /*
   * **工兵排在最前面**（W4-4d-3，2026-11-26）。
   *
   * 排最后时，岸上的战斗兵先把位置占满，工兵最后动、一格都挤不进去
   * （临时验证：第 13 手起工兵在 (7,8) 站了 20 多手，桥停在第一格）。
   * 架桥期间**工兵先占位**，战斗兵再让——这也是"让路"真正的落点：
   * 不是把路清出来等工兵，而是让工兵先站。
   */
  for (const u of [...world.myBuilders, ...combatOrder, ...econOrder]) {
    const live = s.units.find((x) => x.id === u.id);
    if (!live || live.moved) continue;
    const a = actFor(s, world, con, live);
    if (usable(a)) return a;
  }

  /*
   * **这一手到此结束 → 把玩家"刚看过全图"那一笔清掉**（2026-11-27）。
   *
   * 不清的话它会一直挂着：玩家很久以前点过一次看全图，v4 之后每一手都全知。
   * 用户定的生命周期是**到 AI 的下一个回合结束为止**，这里就是那个"结束"。
   */
  if (s.seeAllSeen === true) s.seeAllSeen = false;

  return null;
}

/** 让跑批脚本能像 v1/v3 一样加载它（同签名，可直接替换） */
export const aiNextAction = aiNextActionV4;

/** 导出给探针：这一手的三层输出长什么样 */
export function v4Snapshot(s: GameState, me: PlayerId): {
  decision: Decision;
  squads: Array<{ id: string; order: string; n: number }>;
  /** 必须空的格子（下标）。面板要画它们，所以给原值不是数量 */
  keepClearList: number[];
  /** 批 2：这一手给产兵腾了哪几格、赶走了谁（只观测） */
  spawnQuota?: Constraints['spawnQuota'];
  /** 升级的执行结果（要不要升在 `decision.upgrade` 里，这里是"这一手执不执行"） */
  upgrade?: NonNullable<Constraints['upgrade']>;
  /** 决定层说要升、但计划层否掉了——为什么（D6） */
  upgradeBlocked?: string;
  /** W1 影子观测：前线的 / 在途的 / 这回合能造几个 */
  lane?: { front: number; road: number; make: number; engaged: number };
  /** W1.5 影子观测：开过的每一批（`LaneWave`） */
  waves?: V4Memory['waves'];
  /** W1.5 影子观测：每条线的断档计数 */
  lineGap?: V4Memory['lineGap'];
  /** W1.5 影子观测：每条线各自的交换账 */
  exchangeByCity?: V4Memory['exchangeByCity'];
  /** W1 影子观测：最近 6 手的金币交换（全图） */
  exchange?: V4Memory['exchange'];
  /** W3.6 第 6 步：每支编队的体检（纯观测，没人读它做判断） */
  bands?: BandReport[];
  /** W3.6 第 5 步：采购要造到多少人（编制之和 + 一支预备队） */
  bandNeed?: Constraints['bandNeed'];
} {
  const v = currentView(s, me);
  return {
    decision: v.decision,
    /* `ids` 只给诊断用（看清楚一支队到底装了谁）；判断一律只看 id/order/n */
    squads: v.con.squads.map((q) => ({ id: q.id, order: q.order, n: q.unitIds.length, ids: q.unitIds })),
    keepClearList: v.con.keepClear,
    spawnQuota: v.con.spawnQuota,
    upgrade: v.con.upgrade,
    upgradeBlocked: v.con.upgradeBlocked,
    lane: v.con.lane,
    waves: memoryOf(s, me).waves ?? [],
    lineGap: memoryOf(s, me).lineGap ?? {},
    exchangeByCity: memoryOf(s, me).exchangeByCity ?? {},
    exchange: memoryOf(s, me).exchange ?? [],
    bands: bandReports(s, v.world, v.con, memoryOf(s, me)),
    bandNeed: v.con.bandNeed,
  };
}

/** `AI_MAX_STEPS` 在这个文件里只是给探针看的常量，别在这里循环 */
export const V4_MAX_STEPS = AI_MAX_STEPS;

/**
 * 把这一手的编队写进 `s.aiSquads`（复盘用）。
 *
 * 和 v3 一个路子：**只在结论变化时记**，否则 60 手的回放会塞满重复帧。
 * 字段尽量复用 `AiSquadReport` 的语义（count/lead/spread/note），
 * v4 特有的 `want` / `focusId` / `columns` 顺手带上——复盘面板不认也不会坏。
 * （`tactics.focusId` 是 2026-11-25 之后的写法；没开战术模式的队伍记 null。）
 */
/**
 * **每队报告**（W3.6 第 6 步，2026-11-26）：纯观测，没有任何判断读它。
 *
 * 三个数原来都是 0 占位：`lost`（掉了几个人）、`stalled`（卡了几手）、`lead`（还有几手到）。
 * 它们分别来自批记录（`waves`，按编队 id 对得上）和这一手现算的距离。
 */
function bandReports(
  s: GameState,
  world: World,
  con: Constraints,
  mem: V4Memory,
): BandReport[] {
  const waves = mem.waves ?? [];
  return (mem.bands ?? []).map((b) => {
    const w = waves.find((x) => x.id === b.id);
    const sq = con.squads.find((q) => q.id === b.id);
    const alive = b.unitIds.filter((id) => s.units.some((u) => u.id === id)).length;
    const men = b.men ?? w?.men ?? b.want ?? b.unitIds.length;
    return {
      id: b.id,
      cityId: b.cityId,
      men,
      want: b.want ?? men,
      alive,
      lost: Math.max(0, men - alive),
      state: (b.state ?? 'forming') as BandReport['state'],
      order: sq?.order,
      turnsToTarget: sq?.eta,
      stuck: w?.stuck ?? 0,
      arrived: w?.arrivedIds.length ?? 0,
      formedAt: b.formedAt,
      narrow: bottleneckOf(s, world, b),
    };
  });
}

/**
 * **这条路最窄的一段在哪、几个人卡在那儿、要几手过去**（W4-4a，纯观测）。
 *
 * 走法：从队首顺着"到城的步数"一格一格往回走（`stepsFrom` 的距离场），
 * 每格问一次 `corridorWidth`——它就是"这里能并排几格"，分队形时已经在用。
 * 不在路上量几何，量的是"这批人实际要走的那条路"。
 */
function bottleneckOf(
  s: GameState,
  world: World,
  b: Band,
): BandReport['narrow'] {
  const city = s.cities.find((c) => c.id === b.cityId);
  if (!city) return undefined;
  const units = b.unitIds
    .map((id) => s.units.find((u) => u.id === id))
    .filter((u): u is Unit => !!u);
  if (units.length === 0) return undefined;
  const size = city.size ?? 2;
  const center = { x: city.x + Math.floor(size / 2), y: city.y + Math.floor(size / 2) };
  const field = world.stepsFrom(center);
  const at = (u: { x: number; y: number }): number => field[u.y * s.w + u.x] ?? Infinity;
  const lead = [...units].sort((a, c) => at(a) - at(c))[0]!;
  let cur = { x: lead.x, y: lead.y };
  let best = { x: cur.x, y: cur.y, w: Infinity };
  for (let i = 0; i < 80; i++) {
    const d = at(cur);
    /*
     * 只量"路上"的最窄处：最后两格是城门口，城本身就把它夹窄了，
     * 那不是路况（P-3-01 纯平原上会报出"窄 2 格"的假窄口）。
     */
    if (!Number.isFinite(d) || d <= 2) break;
    let next: { x: number; y: number } | undefined;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = cur.x + dx;
      const ny = cur.y + dy;
      if (field[ny * s.w + nx] === d - 1) {
        next = { x: nx, y: ny };
        break;
      }
    }
    if (!next) break;
    /*
     * **法向按"下一格"取，不按"朝城中心"取。**
     *
     * `corridorWidth` 是按"朝目标的符号"取法向的：斜着走时法向也是斜的，
     * 于是桥面（实际 1 格宽）会量成 5 格（S-005 实测）。改成朝下一格，
     * 法向就和这一段的实际走向垂直了。
     */
    /* 先量再走：`corridorWidth(p, toward)` 要的是"从 p 朝 toward"，顺序反了会得到 (0,0) */
    const w = world.corridorWidth(cur, next);
    cur = next;
    if (w < best.w) best = { ...cur, w };
  }
  if (!Number.isFinite(best.w)) return undefined;
  const queue = units.filter((u) => Math.abs(u.x - best.x) + Math.abs(u.y - best.y) <= 3).length;
  return {
    width: best.w,
    at: `${best.x},${best.y}`,
    queue,
    crossTurns: Math.ceil(Math.max(1, queue) / Math.max(1, best.w)),
  };
}

function logSquads(s: GameState, me: PlayerId, world: World, decision: Decision, con: Constraints, mem: V4Memory): void {
  const reports = new Map(bandReports(s, world, con, mem).map((r) => [r.id, r]));
  const reps = con.squads.map((q) => {
    const r = reports.get(q.id);
    return {
      id: q.id,
      state: q.order,
      count: q.unitIds.length,
      lead: q.eta ?? 0,
      spread: 0,
      /* 卡住几手 / 掉了几个：来自批记录（同一支队的 id 对得上） */
      stalled: r?.stuck ?? 0,
      lost: r?.lost ?? 0,
      note: (q.order === 'assemble' ? 'blocked' : 'advance') as 'advance' | 'blocked',
      want: q.want ?? 0,
      focusId: q.tactics?.focusId ?? null,
      /* 队形分几列（不是战略上的"线"，见 types.ts 的 Squad.columns） */
      columns: q.columns?.length ?? 0,
    };
  });
  if (reps.length === 0) return;
  /*
   * 去重签名要包含**钱和升级**（D6）：这两件事变了而队伍没变时，回放里也该留一条。
   * 否则"这一手为什么没造兵"在回放里永远是同一个画面。
   */
  const up = con.upgrade;
  const sig =
    reps.map((x) => `${x.id}:${x.state}:${x.count}`).join('|') +
    `|sp:${decision.spend.mode}:${decision.spend.cap ?? ''}` +
    `|up:${up ? `${up.cityId}#${up.cost}` : '-'}:${con.upgradeBlocked ?? ''}`;
  const log = (s.aiSquads ??= []);
  const last = [...log].reverse().find((x) => x.me === me);
  /*
   * **一手只记一条**（D6）：
   *
   * 原来靠签名去重，可一手之内每做一个动作金币就变，决定也跟着变
   * （"要救城"→买完兵钱不够→"没这个念头"），于是同一手记下四五条互相矛盾的记录。
   * 一手的第一条才是"这一手开始时它想干什么"，后面的都是花钱的后果。
   */
  if (last && last.turn === s.turn) return;
  const lastSig = last ? last.squads.map((x) => `${x.id}:${x.state}:${x.count}`).join('|') : '';
  if (sig === lastSig) return;
  log.push({
    turn: s.turn,
    me,
    cityId: decision.cityId ?? null,
    squads: reps,
    kind: decision.kind,
    /* ── D6：三句话，让回放不读代码也能回答"为什么" ── */
    reason: decision.reason,
    spend: { mode: decision.spend.mode, cap: decision.spend.cap, why: decision.spend.why },
    upgrade: decision.upgrade
      ? {
          kind: decision.upgrade.kind,
          cityId: decision.upgrade.candidates[0]?.cityId ?? null,
          targetEra: decision.upgrade.candidates[0]?.targetEra ?? null,
          why: decision.upgrade.candidates[0]?.why ?? '',
        }
      : null,
    upgradeBlocked: con.upgradeBlocked ?? null,
  } as never);
  if (log.length > 200) log.splice(0, log.length - 200);
}
