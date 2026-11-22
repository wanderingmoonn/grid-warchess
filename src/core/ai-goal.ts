/**
 * 「产业链目标」：AI 跨回合的投资计划。
 *
 * 📖 **动手前先读 `docs/GUIDE-AI-GOAL-2026-11-20.md`**（怎么用、五个坑、八条自检）。
 * 一句话：要给 AI 加"会玩某个内容"，写一个 AiGoal，别去 ai.ts 里加 if。
 *
 * ── 为什么要有这一层 ──────────────────────────────────────────────
 *
 * AI 的每一个动作都是**当场比分数**选出来的：建造、采购、走位全扔进一个池子，
 * 谁分高选谁。这套东西打"买一个兵、走一步、打一下"很好用，但它天生做不了
 * **投资**——因为投资的第一步（建电站、建船坞、建宗门）当下一定不如"再买一个弓兵"。
 *
 * 于是引擎里长出了一堆手写的补丁：海军的 `seaDemand` + 船坞上限、装甲的
 * `armorSupportNudge` + 采购里那条「工程机组 +45」。它们形状完全一样：
 *
 *     目标值不值 → 数前置还差几样 → 差的那一步给高分 → 够了就压回去
 *
 * 这一层就是把那个形状抽出来。核心只做四件事：
 *
 *   1. 问每个目标「现在值多少分」（`value`）；
 *   2. 跳过值为 0 的；
 *   3. 在最有价值的那个目标里，找**第一段没完成的**（`steps`）；
 *   4. 那一段说的建筑给高分（`buildScore`），或者直接生成动作（`actions`）。
 *
 * ── 为什么目标由扩展声明 ─────────────────────────────────────────
 *
 * 核心不该认识「宗门」「藏经阁」「法术」这些词。所以核心只定义接口，
 * **谁家的产业链谁声明**；连核心自己的海军/装甲也走同一个口子（`registerCoreGoal`），
 * 不给扩展开后门，也不让自己留特例。
 *
 * 扩展写坏了（比如目标永远返回 0、或者提了非法动作）是扩展的问题：
 * 这里只保证**不会把整局打死**——抛错按"没这个目标"处理。
 */

import { EXPANSIONS } from './expansions.ts';
import type { Action, AiCommit, GameState, PlayerId, Terrain, Unit, UnitTypeDef } from './types.ts';

/**
 * 目标拿到的局面读数。
 *
 * 只放**通用**查询，不放「这张图有多少水」这种某一家的东西：
 * 每个目标自己算自己的，否则这一层迟早变成"核心认识所有扩展"的那张表。
 */
export interface AiGoalCtx {
  state: GameState;
  me: PlayerId;
  /** 现在打在第几代（AI 对局势的读数，不是某一座城的时代） */
  era: number;
  /** 自己有几座城 */
  cityCount: number;
  /** 自己有几个满足条件的单位（数建筑、数船都用它） */
  count: (pred: (def: UnitTypeDef) => boolean) => number;
  /** 这个建筑现在能盖在哪（已经按规则过滤过：地形、占位、贴邻条件） */
  buildSpots: (
    buildId: string,
    builder: Unit,
  ) => Array<{ x: number; y: number; terrain: Terrain }>;
  /** 这一格现在危不危险（下回合会不会被拆） */
  inDanger: (x: number, y: number) => boolean;
  /** 棋盘距离 */
  dist: (a: { x: number; y: number }, b: { x: number; y: number }) => number;
  /** 离自家最近的城市有多远；没有城时返回 Infinity */
  distToNearestCity: (p: { x: number; y: number }) => number;
  /**
   * 局面吃紧（复用 `plan.urgent` 的口径：兵少于 3 个，或者有敌人摸到城下 3 格）。
   *
   * 吃紧时**不推进产业链**：这时候还在攒"将来的战力"，是拿命换经济。
   * 注意这个口径对"打断承诺"偏敏感（一个侦察兵摸到城边就算），
   * 细化计划见 docs/PLAN-AI-GOAL-2026-11-20.md 的"待办"。
   */
  urgent: boolean;
  /**
   * 威胁值：**能攻城的战力**摸到自己城下有多少（见 ai.ts 的 `threatLevelOf`）。
   *
   * 产业链用它判断"该不该放弃投资"，**不用 `urgent`**：`urgent` 里那条
   * `army < 3` 会让开局（本来就没几个兵）永远处于"吃紧"，承诺每回合被清空。
   */
  threat: number;
  /** 这个势力现在在追哪条链（`AiCommit`），没有就是 null */
  commit: AiCommit | null;
  /**
   * 哪些非金币资源"供不上"（存量比上次回合开始时少了）。
   *
   * 判据是**趋势**不是绝对值：引擎没有"每回合消耗"的流量概念，
   * 见 `GameState.aiResMark` 的说明。
   */
  scarce: ReadonlySet<string>;
}

/** 目标里的一段。核心每回合只推进第一段没完成的。 */
export interface AiGoalStep {
  id: string;
  /** 这一段完成了吗 */
  done: (c: AiGoalCtx) => boolean;
  /**
   * 这一段管的是哪些建筑。
   *
   * 用**判据**而不是 id 列表：核心那两条产业链（海军/装甲）不许写死扩展的兵种 id，
   * 否则就是把"扩展的内容"重新塞回核心。扩展自己声明目标时想写 id 随便写。
   */
  claimsBuild?: (def: UnitTypeDef) => boolean;
  /**
   * 建它的分数。不写就用 `DEFAULT_GOAL_BUILD_SCORE`。
   *
   * 返回 `null` 表示"这个局面下建它没意义"（等价于旧代码里的 `-999`）：
   * 比如离城太远、这一档的船一条都造不了。**必须和以前一样在这里拦住**，
   * 否则 AI 会提一个必被规则拒的动作，而执行方遇到非法动作会中断整回合。
   */
  buildScore?: (
    c: AiGoalCtx,
    buildId: string,
    spot: { x: number; y: number; terrain: Terrain },
    def: UnitTypeDef,
  ) => number | null;
  /**
   * 这一段管的是哪些**兵种**（采购时加分）。
   *
   * 和 `claimsBuild` 对称：产业链不只需要房子，"为了这条链买这个兵"同样常见——
   * 装甲要素体、修真要修士、海军要船。没有这一项，目标就只能管"建什么"，
   * 而链上真正花钱的那一环（买兵）永远排不上。
   */
  claimsUnit?: (def: UnitTypeDef) => boolean;
  /**
   * 买这个兵给多少分（只对 `claimsUnit` 认领的兵种生效）。
   *
   * 不写就用 `DEFAULT_GOAL_UNIT_SCORE`。承诺中的那一段额外 +`COMMIT_BUILD_BONUS`。
   */
  unitScore?: number;
  /**
   * 推进这一步大概要花多少**金**。要给 `cost` 才会进"攒钱"那张表。
   *
   * 不写＝不需要攒：那一步的钱当场掏得出来（比如已经有矿的灵田），
   * 或者压根不花钱（研发只要灵石）。
   */
  cost?: (c: AiGoalCtx) => number;
  /**
   * 为了这一步停手攒钱，值多少（和英雄 / 升时代 / 大件**同一把尺子**）。
   *
   * 不写就用 `DEFAULT_GOAL_SAVE_SCORE`。这个数不是"重要程度"，是"每金战力"——
   * 攒钱那张表里四条老候选（兵/英雄/升时代/收废墟）用的都是这个量纲，
   * 混进一个"很重要所以 1000 分"会把它们全顶掉。
   */
  saveScore?: number;
  /**
   * 不属于建造的推进手段（研发法术、研读、升级建筑……）。
   *
   * 返回的动作会和别的候选一起比分数——**没有插队，也没有后门**。
   */
  actions?: (c: AiGoalCtx) => Array<{ action: Action; score: number }>;
}

export interface AiGoal {
  id: string;
  /** 现在这个目标值多少分。≤ 0 = 不追（每一步重新算，局势变了就该变） */
  value: (c: AiGoalCtx) => number;
  /** 有顺序的几段，核心只推进第一段没完成的 */
  steps: readonly AiGoalStep[];
}

/** 目标没写 `buildScore` 时给的分：够高到能压过一次「挪一格」（四五十） */
export const DEFAULT_GOAL_BUILD_SCORE = 70;

/**
 * 目标没写 `unitScore` 时给的分。
 *
 * 采购的基准是五十分上下、好兵六七十，所以 30 的意思是"为了这条链，
 * 这一档兵值得比同代常规兵优先"——但又不足以让一个明显不合适的兵翻盘。
 */
export const DEFAULT_GOAL_UNIT_SCORE = 30;

/**
 * 目标没写 `saveScore` 时给的分。
 *
 * 参照攒钱表里其它几条的量级（一个兵 2~6、升时代 6~12、英雄十几），
 * 8 的意思是"值得为它停手，但不至于压倒升时代"。
 */
export const DEFAULT_GOAL_SAVE_SCORE = 8;

/**
 * 核心自己的目标（海军、装甲……）。
 *
 * 单独一张表而不是并进 `EXPANSIONS`：这些是核心内容，不该伪装成一个扩展；
 * 但它们走的**是同一个接口**，不给核心留特例——否则这一层又变成"两套规则"。
 */
const CORE_GOALS: AiGoal[] = [];

export function registerCoreGoal(goal: AiGoal): void {
  /*
   * 同一个 id 重复注册 = 跳过，不抛错（2026-11-21 改）。
   *
   * 原因：`ai.ts` 和实验副本 `ai-v3.ts` 都会在模块加载时注册自己那份核心目标。
   * 两份 AI 同时被加载（比如 `ai-duel` 拿老 AI 当基线）时，第二个就会撞上。
   *
   * 现在的语义是"**目标表由核心共享**"：v3 想试验不同的目标，用自己的 id
   * （`v3-xxx`），不要跟核心抢同一个名字。
   */
  if (CORE_GOALS.some((g) => g.id === goal.id)) return;
  CORE_GOALS.push(goal);
}

/** 只警告一次（AI 一回合要问几十次，每步刷屏等于没人看） */
const warned = new Set<string>();
function warnOnce(key: string, text: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(text);
}

/** 全部目标：核心的 + 扩展声明的 */
export function allAiGoals(): AiGoal[] {
  const out = [...CORE_GOALS];
  for (const e of EXPANSIONS) {
    for (const g of e.aiGoals ?? []) out.push(g);
  }
  return out;
}

/** 测试用 */
export function resetAiGoalWarnings(): void {
  warned.clear();
}

/**
 * 现在**在推进中**的所有目标段。
 *
 * 注意这里是"所有"而不是"最值的那一个"，这是刻意的：
 * 旧代码里海军和装甲各算各的，互不压制；如果这里只留最值的目标，
 * 海军值 0.5 的时候装甲就永远拿不到分——那是**行为变化**，不是抽象。
 *
 * 至于"同时追五条会不会每条都推一半"：会的。但那不是这一层该管的事——
 * 段内的顺序保证每条链只推进"下一步"，而要不要限制同时追几条，
 * 是标定问题，等有了两条以上的扩展目标再谈（现在只有核心的两条）。
 */
export function goalStepsInPlay(c: AiGoalCtx): Array<{
  goal: AiGoal;
  step: AiGoalStep;
  value: number;
  /** 这一段就是当前承诺要推进的那一段 */
  committed: boolean;
}> {
  const out: Array<{ goal: AiGoal; step: AiGoalStep; value: number; committed: boolean }> = [];
  for (const goal of allAiGoals()) {
    let v = 0;
    try {
      v = goal.value(c);
    } catch (err) {
      warnOnce(`value:${goal.id}`, `[ai-goal] 目标「${goal.id}」算价值时抛错，当它不存在：${String(err)}`);
      continue;
    }
    if (!Number.isFinite(v) || v <= 0) continue;
    let step: AiGoalStep | undefined;
    try {
      step = goal.steps.find((s) => !s.done(c));
    } catch (err) {
      warnOnce(`done:${goal.id}`, `[ai-goal] 目标「${goal.id}」判断前置时抛错，跳过：${String(err)}`);
      continue;
    }
    if (!step) continue; // 全做完了，这个目标不再出牌
    out.push({
      goal,
      step,
      value: v,
      committed: c.commit?.goalId === goal.id && c.commit?.stepId === step.id,
    });
  }
  return out;
}

/* ══════════════════════════════════════════════════════════════════
 * 承诺：进去容易、出来难
 *
 * 每回合重算价值是必须的（局势会变），但"要不要放弃已经在做的事"不能
 * 和"要不要开始做"用同一个门槛——那样一来，对面派两个骑兵骚扰一下，
 * 攒到一半的东西就被判"不值"了，而实际上再攒两个回合就能成型。
 *
 * 所以：立承诺时记下当时的价值，之后**只有掉到它的六成才放弃**；
 * 中间那四成是死区，小扰动跨不过去。
 * 真要撤也有专门的出口——`urgent`（大军压境）直接打断，不看分数。
 * ══════════════════════════════════════════════════════════════════ */

/** 价值掉到立约时的几成才放弃。0.6 = 中间四成是死区 */
export const COMMIT_KEEP_RATIO = 0.6;

/** 另一个目标值到当前承诺的几倍才改投。小波动不换，免得来回横跳 */
export const COMMIT_SWITCH_RATIO = 1.5;

/**
 * 净威胁到多少就放弃投资。
 *
 * 注意这是**净**值：攻方战力 − 城附近我方战力（见 `threatLevelOf`）。
 * 所以 80 不是"80 攻击力的敌人靠近"，而是"打完守军还剩 80"——
 * 大约是一个班的重火力。
 *
 * 标定（2026-11-20，28×28 / era7 / 装甲包 / 两个种子 / 160 回合），
 * 看的是"素体首次出现回合 · 终局素体数 · 装上炮的台数"：
 *
 *   | THREAT_ATK | 8191            | 8272            |
 *   |------------|-----------------|-----------------|
 *   | 20         | t26 · 0/0 · 0   | t56 · 4/0 · 3   |
 *   | 40         | t26 · 0/0 · 0   | t56 · 4/0 · 3   |
 *   | **80**     | t26 · 4/0 · 3   | t56 · **6/0 · 6** |
 *
 * 80 明显更好：阈值低的时候，一队小兵路过就把投资打断，链永远走不完。
 * **样本只有两个种子，而且没量胜率**——这是已知缺口，动它要重新量。
 */
export const THREAT_ATK = 80;

/**
 * 承诺中的那一段给多少额外分。
 *
 * 15 的量级参考：一次普通建造 40~80，一个兵 20~50。够把"差一点点就排不上"
 * 的那一步顶上去，又不够让明显不划算的东西翻盘。
 */
export const COMMIT_BUILD_BONUS = 15;

/**
 * 算这一回合的承诺。纯函数：只读 `prev` 和局面，返回"下一回合该记什么"。
 *
 * 三种情况返回 null（放弃）：
 *   · 局面吃紧（`urgent`）——大军压境时一切投资让位；
 *   · 那条链已经做完/没价值了（不在 `goalStepsInPlay` 里了）；
 *   · 价值掉到立约时的六成以下。
 */
export function resolveCommit(c: AiGoalCtx, prev: AiCommit | null): AiCommit | null {
  /*
   * 判据是 `threat`，**不是 `urgent`**（2026-11-20 改，待办 T1）。
   *
   * `urgent` 里有一条 `army < 3`，那是给"攒钱"写的：兵只剩一两个还在攒钱是拿命
   * 换经济。拿它管投资就成了死锁——开局兵本来就不够三个，于是永远"吃紧"，
   * 承诺每回合被清空，装甲的 `armor-frame` 在第 20 回合就是这样死的（终局素体 0）。
   *
   * 投资本来就是为了"以后有兵"，用"现在没兵"去否决它，逻辑上是反的。
   * 现在只认"城下真的有一队能拆墙的兵"（`THREAT_ATK`）。
   */
  if (c.threat >= THREAT_ATK) return null;
  const live = goalStepsInPlay({ ...c, commit: prev });
  if (prev) {
    const still = live.find((x) => x.goal.id === prev.goalId && x.step.id === prev.stepId);
    if (!still) return null;
    if (still.value < prev.valueAt * COMMIT_KEEP_RATIO) return null;
    /*
     * **可以改投更好的目标**（2026-11-20 补）。
     *
     * 原来的规则是"只要还成立就不换"。实测后果：24×24 的内陆图上，
     * 开局第 1 代时海军那条（`seaDemand` 0.2~0.5）先立了约，
     * 之后修真这条（值 1）起来了却永远轮不到——承诺一路挂到第 140 回合，
     * 而那张图根本造不出船坞，等于整局空转。
     *
     * 判据用 1.5 倍：小波动不换（免得来回横跳），明显更值才换。
     * 这个数没有实测标定，先按"换一次不亏"的直觉取值，后面拿数据再调。
     */
    const better = live.reduce<(typeof live)[number] | null>(
      (best, x) => (!best || x.value > best.value ? x : best),
      null,
    );
    if (better && better.value > still.value * COMMIT_SWITCH_RATIO) {
      return {
        goalId: better.goal.id,
        stepId: better.step.id,
        since: c.state.turn,
        valueAt: better.value,
      };
    }
    return prev;
  }
  // 没在追任何东西：挑当前最值的那一段立项
  let best: (typeof live)[number] | null = null;
  for (const x of live) if (!best || x.value > best.value) best = x;
  if (!best) return null;
  return { goalId: best.goal.id, stepId: best.step.id, since: c.state.turn, valueAt: best.value };
}
