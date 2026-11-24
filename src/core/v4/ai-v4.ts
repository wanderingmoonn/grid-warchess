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
import { actFor, recruitAction } from './tactics.ts';
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
  writeMemory(s, me, { decision: { ...decision, since: s.turn }, squad: squadMemo(con, mem, s.turn) });
  cache = { key, world, decision, con, tried: new Set(), recruits: 0 };
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
    const a = actFor(s, world, con, u);
    if (usable(a)) return a;
  }

  /* ② 打 */
  for (const u of world.myCombat) {
    const live = s.units.find((x) => x.id === u.id);
    if (!live || live.moved || live.acted) continue;
    const a = actFor(s, world, con, live);
    if (usable(a) && a && a.type === 'ATTACK') return a;
  }

  /*
   * ③ 造兵：**每回合最多 2 个**。
   *
   * 这一条是拿 S-000 换来的：不设上限时，200 金会被一口气换成 8 个民兵，
   * 而动作数是有预算的——钱花完了，这一步也走不动了，最后 0 城伤、一兵未动。
   * 上限的语义是"这回合补两个人"，不是"这回合把钱花光"。
   */
  const cap = 2;
  if ((_budget?.recruited ?? 0) + view.recruits < cap) {
    const rec = recruitAction(s, world);
    if (usable(rec)) {
      view.recruits += 1;
      return rec;
    }
  }

  /* ④ 走 */
  for (const u of [...world.myCombat, ...world.myEcon]) {
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
