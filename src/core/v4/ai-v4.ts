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
import { buildWorld, type World } from './world.ts';
import { decide } from './decide.ts';
import { constrain } from './constrain.ts';
import { actFor, recruitAction, recruitEcon } from './tactics.ts';
import { utype } from '../rules.ts';
import type { Constraints, Decision, V4Memory } from './types.ts';
import type { Action, GameState, PlayerId } from '../types.ts';

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
}

let cache: TurnCache | null = null;

const keyOf = (s: GameState, me: PlayerId): string =>
  `${s.turn}:${s.current}:${s.units.length}:${s.players[me]?.gold ?? 0}:${s.cities.length}`;

/**
 * 拿这一回合的世界与约束（必要时重建）。
 *
 * 导出它是为了让探针能直接看"v4 这一手打算干什么"——出问题时第一眼看日志，
 * 而不是读代码。
 */
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
   */
  const view = playerView(s, me).state;
  const world = buildWorld(view, me);
  /*
   * 记忆从**真状态**读、往**真状态**写。
   *
   * 注意 `view` 是 `playerView` 的副本：往副本上写，下一步 `applyAction` 一换状态就没了。
   * 这也解释 v3 为什么把读写都收在 `focusOf` / `setFocus` 两个函数里——只有一处写，
   * 才不会出现"写到了副本上、看起来生效了其实没有"。
   */
  const mem = memoryOf(s, me);
  const decision = decide(view, world, mem);
  const con = constrain(view, world, decision, mem);
  writeMemory(s, me, {
    decision: { ...decision, since: s.turn },
    squad: squadMemo(con, mem, s.turn),
    econSince: econSinceMemo(s, me, mem),
    econHome: econHomeMemo(s, me, mem, world),
  });
  cache = { key, world, decision, con, tried: new Set(), recruits: 0 };
  logSquads(s, world.me, decision, con);
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

/** 给探针清缓存用（换局时调一次） */
export function resetV4(): void {
  cache = null;
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
    const rec =
      sp.mode === 'save'
        ? null
        : sp.mode === 'econOnly'
          ? recruitEcon(s, world, con)
          : sp.mode === 'econThenArmy'
            ? recruitEcon(s, world, con) ?? recruitAction(s, world, con.need, con.spendCap)
            : recruitAction(s, world, con.need, con.spendCap);
    if (usable(rec)) {
      view.recruits += 1;
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
  for (const u of [...combatOrder, ...econOrder]) {
    const live = s.units.find((x) => x.id === u.id);
    if (!live || live.moved) continue;
    const a = actFor(s, world, con, live);
    if (usable(a)) return a;
  }

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
} {
  const v = currentView(s, me);
  return {
    decision: v.decision,
    squads: v.con.squads.map((q) => ({ id: q.id, order: q.order, n: q.unitIds.length })),
    keepClearList: v.con.keepClear,
  };
}

/** `AI_MAX_STEPS` 在这个文件里只是给探针看的常量，别在这里循环 */
export const V4_MAX_STEPS = AI_MAX_STEPS;

/**
 * 把这一手的编队写进 `s.aiSquads`（复盘用）。
 *
 * 和 v3 一个路子：**只在结论变化时记**，否则 60 手的回放会塞满重复帧。
 * 字段尽量复用 `AiSquadReport` 的语义（count/lead/spread/note），
 * v4 特有的 `want` / `focusId` / `lanes` 顺手带上——复盘面板不认也不会坏。
 * （`tactics.focusId` 是 2026-11-25 之后的写法；没开战术模式的队伍记 null。）
 */
function logSquads(s: GameState, me: PlayerId, decision: Decision, con: Constraints): void {
  const reps = con.squads.map((q) => ({
    id: q.id,
    state: q.order,
    count: q.unitIds.length,
    lead: q.eta ?? 0,
    spread: 0,
    stalled: 0,
    lost: 0,
    note: (q.order === 'assemble' ? 'blocked' : 'advance') as 'advance' | 'blocked',
    want: q.want ?? 0,
    focusId: q.tactics?.focusId ?? null,
    lanes: q.lanes?.length ?? 0,
  }));
  if (reps.length === 0) return;
  const sig = reps.map((x) => `${x.id}:${x.state}:${x.count}`).join('|');
  const log = (s.aiSquads ??= []);
  const last = [...log].reverse().find((x) => x.me === me);
  const lastSig = last ? last.squads.map((x) => `${x.id}:${x.state}:${x.count}`).join('|') : '';
  if (sig === lastSig) return;
  log.push({ turn: s.turn, me, cityId: decision.cityId ?? null, squads: reps, kind: decision.kind } as never);
  if (log.length > 200) log.splice(0, log.length - 200);
}
