/**
 * 计划排序层 —— 让 AI 在"这段时间干什么"上做选择，而不是每一步都比分数。
 *
 * ── 它解决什么 ────────────────────────────────────────────────────
 *
 * 老 AI 每个动作都问"现在哪一步分最高"。这做单步很好（走位、集火、采购），
 * 但表达不了"这十个回合先不打、先把桥修过去"——那类决定的收益在若干回合之后，
 * 单步打分里永远输给"再买一个兵"。
 *
 * 目标（`ai-goal.ts`）解决的是"钱往哪投"；这一层解决的是"全军干什么"。
 * 两者不是一回事：一条产业链可以边打边建，但"打"和"不打"是这一层说了算。
 *
 * ── 两类计划（这是地基） ──────────────────────────────────────────
 *
 *   · **权重型**：只给现有打分调系数，不产生新动作。发展、决战、屯兵、防御、
 *     骚扰都属于这一类——加一条只要几十行。
 *   · **行动型**：现有动作集里根本没有的动作（派兵接管废墟、把桥铺过去），
 *     必须自带通道。加一条要几百行，而且历史上每一条都踩过"判断有了、
 *     动作通道没有"的坑（`targetCityId` 只写不读就是这么来的）。
 *
 * 所以：**加新计划先问是不是权重型**。是就别造通道。
 *
 * ── P1 的边界（2026-11-21） ──────────────────────────────────────
 *
 * 现在只有骨架：注册表、排序、权重合成。**没有任何计划注册**，
 * 所以 `ai-v3` 里那一句调用被 `planCount() === 0` 挡在外面，对局一步没变。
 * 计划本身从 P2 开始搬（见 docs/PLAN-AI-V3 第十五节）。
 */
import type { Action, GameState, PlayerId } from './types.ts';
import { armySize, incomeOf } from './rules.ts';

/**
 * 计划能看到的全部信息。
 *
 * 只从**雾图**取数：计划不该知道看不见的东西，否则回放和联机都会露馅。
 * `canReach` 单独列出来，是因为它只影响"能不能执行"，不影响"值不值"——
 * 见 `docs/PLAN-AI-V3` 15.7 的反循环条款。
 */
export interface PlanCtx {
  view: GameState;
  me: PlayerId;
  /** 我方时代（最高的那座好城） */
  era: number;
  /** 对面时代（迷雾里只看得到已知的城） */
  foeEra: number;
  /** 我方战斗单位数 */
  army: number;
  /** 对面战斗单位数（可见的） */
  foeArmy: number;
  /** 每回合金币收入 */
  income: number;
  /** 手上金币 */
  gold: number;
  /** 陆路够不够得着敌城（只影响执行） */
  canReach: boolean;
  /** 折算收益的时间窗（回合） */
  horizon: number;
}

/**
 * 一条计划给各路动作的乘数。**1 = 不变**，0.5 = 打五折，1.5 = 加成。
 *
 * 刻意只有五项：每多一项就多一个要标定的常数，也更容易互相抹平。
 * 真要更细的区分，应该写在计划自己的函数里，而不是往这里加字段。
 */
export interface PlanWeights {
  /** 攻击、攻城、往前压的走位 */
  attack: number;
  /** 盖楼 */
  build: number;
  /** 采购时偏向"买经济单位"（>1）还是"买兵"（<1） */
  econ: number;
  /** 为远期目标存钱的意愿 */
  save: number;
  /** 一支兵都不许越过中线 */
  holdLine: boolean;
}

export interface AiPlan {
  id: string;
  kind: 'weights' | 'action';
  /**
   * 这条计划的话有多算数（0~1）。调参数用：同一套系数，强度 0.8 是"强烈倾向"，
   * 0.3 是"顺带提一句"。数值统一在 `PLAN_TUNING.strength` 里，别写在函数里。
   */
  strength: number;
  /** 现在值多少（金币当量/回合，见 15.7）。0 = 不成立，不参与排序 */
  value(c: PlanCtx): number;
  /** 完成了吗：成立之后不再重立（产业链踩过"无限重建"的坑） */
  done(c: PlanCtx): boolean;
  /** 行动型：这一步要提的动作。权重型不写 */
  next?(c: PlanCtx): Action[];
  /** 权重型：这一步的乘数，只写要动的那几项。行动型不写 */
  weights?(c: PlanCtx): Partial<PlanWeights>;
}

/**
 * 跨回合记忆：只记"现在当值的是谁"。
 *
 * `state` 是计划自己的口袋（收尾记城、过河记渡口），**别的计划不读**。
 * 这样加一条新计划不需要往 `AiFocus` 上加字段——见 15.4。
 */
export interface PlanMemo {
  id: string;
  /** 立约时算出的价值：双阈值都跟它比，不是跟这一回合的值比 */
  valueAt: number;
  since: number;
  state: Record<string, unknown>;
  /** 冷却表：planId → 到期回合。刚放弃的短期内不重立，防抖 */
  cooldown?: Record<string, number>;
}

/**
 * 所有可调项集中在这里。计划函数里**不许出现数字**——
 * 调手感只改这张表，不用翻计划代码。
 */
export const PLAN_TUNING = {
  /** 掉到这个比例才放弃（死区，防小扰动抖出去） */
  keep: 0.6,
  /** 另一条到它的这个倍数才改投 */
  switch: 1.5,
  /** 同一条计划放弃后，几回合内不重复立约（除非价值翻倍） */
  cooldown: 3,
  /** 折算收益的时间窗（回合） */
  horizon: 8,
  /** 每条计划的话有多算数，0~1 */
  strength: {
    reclaim: 1,
    crossing: 0.9,
    develop: 0.6,
    attack: 0.8,
    mass: 0.7,
    defend: 0.85,
  } as Record<string, number>,
} as const;

const REGISTRY = new Map<string, AiPlan>();

/**
 * 注册一条计划。
 *
 * 同 id 幂等（和 `registerCoreGoal` 一致）：`ai.ts` 和 `ai-v3.ts` 同时被加载时，
 * 谁先注册算谁的，不抛错。扩展写坏了是扩展的问题，不该打死整局。
 */
export function registerAiPlan(plan: AiPlan): void {
  if (REGISTRY.has(plan.id)) return;
  REGISTRY.set(plan.id, plan);
}

/** 测试/探针用：清空注册表（正式流程不该调用） */
export function clearAiPlansForTest(): void {
  REGISTRY.clear();
}

export function planCount(): number {
  return REGISTRY.size;
}

export function allAiPlans(): AiPlan[] {
  return [...REGISTRY.values()];
}

export function neutralWeights(): PlanWeights {
  return { attack: 1, build: 1, econ: 1, save: 1, holdLine: false };
}

/** 合成账本的一行：谁给了什么、生效后是多少 */
export interface PlanWeightLine {
  id: string;
  strength: number;
  /** 这条计划要求的原始乘数（没写的项就是 1） */
  asked: Partial<PlanWeights>;
}

export interface ComposedWeights {
  net: PlanWeights;
  ledger: PlanWeightLine[];
}

/**
 * 多条权重型的合成。
 *
 *   `净乘数 = Π 各计划 [ 1 + 强度 × (该计划给的乘数 − 1) ]`
 *
 * 为什么是"按强度插值再相乘"，不是直接相乘：
 *   · 直接相乘，强度就没用了——"顺带提一句"和"强烈倾向"会一样重；
 *   · 按强度插值，`strength = 0` 就是完全没意见，`1` 才是原样生效。
 *
 * 两条相反的计划会合成到接近 1（设计上允许）。**不阻断，但要记账**——
 * 日志里必须能看出"这一项被谁抹平了"，否则以后没人说得清为什么这回合没打。
 */
export function composeWeights(list: Array<{ plan: AiPlan; asked: Partial<PlanWeights> }>): ComposedWeights {
  const net = neutralWeights();
  const ledger: PlanWeightLine[] = [];
  for (const { plan, asked } of list) {
    const s = clamp01(plan.strength);
    ledger.push({ id: plan.id, strength: s, asked });
    // 按强度插值：strength=0 就是完全没意见，1 才是原样生效
    const mix = (want: number): number => 1 + s * (want - 1);
    if (asked.attack !== undefined) net.attack *= mix(asked.attack);
    if (asked.build !== undefined) net.build *= mix(asked.build);
    if (asked.econ !== undefined) net.econ *= mix(asked.econ);
    if (asked.save !== undefined) net.save *= mix(asked.save);
    // 守线是布尔：任一条当值的计划要求就不许越线（要放松它得改强度，不是改这里）
    if (asked.holdLine === true) net.holdLine = true;
  }
  return { net, ledger };
}

export interface PlanResolution {
  /** 当值的行动型计划（最多一条，两条会抢同一支部队） */
  action: AiPlan | null;
  /** 当值的权重型计划（可以多条，同时生效） */
  weights: AiPlan[];
  /** 合成后的净权重（没有权重型当值时就是全 1） */
  net: PlanWeights;
  /** 合成账本，给日志用 */
  ledger: PlanWeightLine[];
  /** 新的记忆（没有当值计划时为 null） */
  memo: PlanMemo | null;
  /** 这一回合为什么是它（写日志、看回放用） */
  reason: string;
  /** 每条的估值，按高到低（含没当值的，值为 0） */
  values: Array<{ id: string; value: number; kind: AiPlan['kind'] }>;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * 解析这一回合的"当值清单"。
 *
 * 规则（和 `docs/PLAN-AI-V3` 15.5 一致）：
 *   1. `done()` 为真的不参与（完成过的计划不该反复重立）；
 *   2. 值 ≤ 0 的不参与；
 *   3. 行动型最多一条，取价值最高的；
 *   4. 权重型**全部当值**（可以同时生效，靠合成而不是靠互斥）；
 *   5. 承诺：旧计划还在、价值没掉到 `keep` 以下 → 继续；
 *      新候选要到 `switch` 倍才改投；
 *   6. 冷却：刚放弃的计划 `cooldown` 回合内不重立，除非价值翻倍；
 *   7. `urgent`（大军压境）时优先"防御"——前提是这条计划已经注册。
 */
export function resolvePlans(
  ctx: PlanCtx,
  prev: PlanMemo | null,
  opts: { urgent?: boolean } = {},
): PlanResolution {
  const turn = ctx.view.turn;
  const values: PlanResolution['values'] = [];
  const live: Array<{ plan: AiPlan; value: number }> = [];

  for (const plan of REGISTRY.values()) {
    let v = 0;
    try {
      if (!plan.done(ctx)) v = Number(plan.value(ctx)) || 0;
    } catch {
      // 一条写坏的计划不该打死整局：按"不成立"处理
      v = 0;
    }
    if (!(v > 0)) v = 0;
    values.push({ id: plan.id, value: v, kind: plan.kind });
    if (v > 0) live.push({ plan, value: v });
  }
  values.sort((a, b) => b.value - a.value);

  /** 冷却中？刚放弃的短期内不重立，除非价值翻倍 */
  const cooling = (id: string): boolean => {
    const until = prev?.cooldown?.[id];
    return until !== undefined && turn < until;
  };

  const eligible = live.filter((x) => !cooling(x.plan.id));
  const actionPlans = eligible.filter((x) => x.plan.kind === 'action').sort((a, b) => b.value - a.value);
  const weightPlans = eligible.filter((x) => x.plan.kind === 'weights');

  /*
   * 承诺：旧计划没死透就继续，别每回合换口味。
   *
   * 比较基准是 `prev.valueAt`（立约那一刻的值），不是这一回合的值——
   * 拿这一回合的值比，等于"只要今天比昨天差就换"，那是抖动不是决策。
   */
  const prevLive = live.find((x) => x.plan.id === prev?.id) ?? null;
  const keepPrev = prev !== null && prevLive !== null && prevLive.value >= prev.valueAt * PLAN_TUNING.keep;

  let action = actionPlans[0]?.plan ?? null;
  let reason = action ? `行动型最高：${action.id}` : '没有当值的行动型计划';

  if (opts.urgent) {
    const defend = REGISTRY.get('defend');
    const defendLive = live.some((x) => x.plan.id === 'defend');
    if (defend && defendLive) {
      action = defend;
      reason = 'urgent：强制切防御';
    }
  } else if (keepPrev && prevLive) {
    const challenger = actionPlans.find((x) => x.plan.id !== prevLive.plan.id) ?? null;
    const shouldSwitch = challenger !== null && challenger.value >= prev.valueAt * PLAN_TUNING.switch;
    if (!shouldSwitch) {
      if (prevLive.plan.kind === 'action') {
        action = prevLive.plan;
        reason = `继续：${prevLive.plan.id}（值 ${Math.round(prevLive.value)} ≥ ${Math.round(prev.valueAt * PLAN_TUNING.keep)}）`;
      } else {
        reason = `继续：${prevLive.plan.id}（权重型，不占行动位）`;
      }
    } else {
      reason = `改投：${challenger.plan.id} 值 ${Math.round(challenger.value)} ≥ 原 ${Math.round(prev.valueAt * PLAN_TUNING.switch)}`;
    }
  }

  const chosen = action;
  const weightList = weightPlans.map((x) => ({
    plan: x.plan,
    asked: safeWeights(x.plan, ctx),
  }));

  const composed = weightList.length > 0 ? composeWeights(weightList) : { net: neutralWeights(), ledger: [] };

  // 记忆记谁：行动型优先（它"占着部队"），没有就记最强的权重型
  const strongestWeight = [...weightPlans].sort((a, b) => b.value - a.value)[0]?.plan ?? null;
  const memoryOf = chosen ?? strongestWeight;
  const memoryValue = memoryOf ? (live.find((x) => x.plan.id === memoryOf.id)?.value ?? 0) : 0;

  /*
   * 冷却表：**不再当值**的计划记一笔到期回合。
   *
   * 注意"不当值"不等于"死了"：一条计划可能还有价值、只是被更高的压下去了。
   * 按"还活着"判会让冷却形同虚设（实测探针就在这里红过）——
   * 它明明被换掉了，下一回合又能立刻抢回来，等于每回合换口味。
   */
  const cooldown: Record<string, number> = { ...(prev?.cooldown ?? {}) };
  if (prev) {
    const prevStillActive =
      prevLive !== null && (prevLive.plan.kind === 'action' ? chosen?.id === prev.id : true);
    if (!prevStillActive) cooldown[prev.id] = turn + PLAN_TUNING.cooldown;
    else delete cooldown[prev.id];
  }
  // 过期条目清掉，别让它无限长
  for (const [id, until] of Object.entries(cooldown)) if (until <= turn) delete cooldown[id];

  const memo: PlanMemo | null =
    memoryOf === null
      ? null
      : {
          id: memoryOf.id,
          valueAt: prev && prev.id === memoryOf.id ? prev.valueAt : memoryValue,
          since: prev && prev.id === memoryOf.id ? prev.since : turn,
          // 计划自己的口袋：换计划就换口袋，同一条计划继续沿用
          state: prev && prev.id === memoryOf.id ? prev.state : {},
          ...(Object.keys(cooldown).length > 0 ? { cooldown } : {}),
        };

  return {
    action: chosen,
    weights: weightPlans.map((x) => x.plan),
    net: composed.net,
    ledger: composed.ledger,
    memo,
    reason,
    values,
  };
}

function safeWeights(plan: AiPlan, ctx: PlanCtx): Partial<PlanWeights> {
  if (!plan.weights) return {};
  try {
    return plan.weights(ctx) ?? {};
  } catch {
    return {};
  }
}

/**
 * 从局面拼一个 `PlanCtx`（P2 接线时用）。
 *
 * `canReach` 默认按"能过去"填：可达性只影响执行、不影响价值（反循环条款）。
 * 真的要不要过河由过河计划自己判断，这里不给它预设答案。
 */
export function planCtxOf(
  view: GameState,
  me: PlayerId,
  patch: Partial<PlanCtx> = {},
): PlanCtx {
  const eraOf = (p: PlayerId): number => {
    let m = 1;
    for (const c of view.cities) if (c.owner === p && !c.ruined && c.era > m) m = c.era;
    return m;
  };
  return {
    view,
    me,
    era: eraOf(me),
    foeEra: Math.max(1, ...view.cities.filter((c) => c.owner !== me).map((c) => c.owner).map(eraOf)),
    army: armySize(view, me),
    foeArmy: Math.max(0, ...view.cities
      .filter((c) => c.owner !== me)
      .map((c) => c.owner)
      .filter((p, i, a) => a.indexOf(p) === i)
      .map((p) => armySize(view, p))),
    income: incomeOf(view, me),
    gold: view.players[me].gold,
    canReach: true,
    horizon: PLAN_TUNING.horizon,
    ...patch,
  };
}

