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
import type { Action, AiPlanTrace, GameState, PlayerId } from './types.ts';
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
  /** 威胁值（净攻城战力，见 ai-v3 的 threatLevelOf）：越大越该收着打 */
  threat: number;
  /** 敌人已经贴到我城 3 格内（"打到门口了"） */
  enemyAtGate: boolean;
  /** 我方身价明显不如对面（< 0.75） */
  weaker: boolean;
  /** 本回合的主攻城市（排序层可能改它——绕路就是换这一项） */
  focusCityId: string | null;
  /** 主力走到最近敌城要几回合 */
  marchTurns: number;
  /**
   * 投影比：**主力抵达那一刻**我方战力 ÷ 对面战力（对面按**可见信息**估）。
   *
   * 语义在 2026-11-21 变过一次：以前是"某个拍出来的远景时刻"，现在是扫 T 的起点。
   * 远景比值会让 AI 在没兵的时候说"打得动"（261 回合的平局就是这么来的）。
   */
  projRatio: number;
  /**
   * 对面这些数是不是"真的知道"。
   *
   * 现在恒为 false：AI 不会刺探，只能拿可见单位估。留着这个口子，
   * 以后真做了侦察，把 `projRatio` 换成实测值、把这个置 true，
   * 决战时机的判断就能随情报变化——现在它只随"看得见什么"变。
   */
  intelKnown: boolean;
  /**
   * 对主攻目标"守军"的情报置信度（0~1）。
   *
   * 0 = 完全没看过、只能猜；1 = 目标城周围此刻有可见的敌方单位。
   *
   * **当前没有决策消费者**：2026-11-22 试过"按它收缩决战比值"，实测没有行为出口
   * （`call` 只喂 `holdFire`，而 holdFire 的第二个条件用原始比值），已撤。
   * 留着是给阶段 3/4 用——由它决定"值不值得派斥候去看"。
   */
  intelConf: number;
  /** 折算收益的时间窗（回合） */
  horizon: number;
  /**
   * 这条计划自己的口袋（上一回合留给这一回合的）。**每条计划各一份**，
   * 互不干扰——两条计划同时当值时，共用一份状态必然打架。
   */
  state: Record<string, unknown>;
  /**
   * 跨计划存活的计数器（引用，直接改）。
   *
   * 和 `state` 的分工：`state` 是"这条计划当值期间"的记忆，退场即丢；
   * `keep` 活得比计划久，用来记"试过几次、被拆过几回"这种**放弃条件**。
   */
  keep: Record<string, unknown>;
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
  /**
   * 回撤强度（0~1）：离家越远越不想往前挪。
   *
   * 这是"收缩防守"需要的那个杠杆。它不是乘数——乘数压的是"打不打"，
   * 而收缩压的是"往不往外走"：贴到脸上的敌人照打，但不主动往前顶。
   * 地图随机、城市可能交错，所以**不能用"中线"**表达（那是伪命题），
   * 只能用"离家距离"。
   */
  pullHome: number;
  /**
   * 推进权重（0~1）：乘在"往敌城方向前进"的那一项上。
   *
   * 和 `attack` 乘数的分工：`attack` 管"打不打"，它管"往不往前挪"。
   * 屯兵需要的是后者——兵不是不敢打，是**不该一个个往前送**（添油）。
   * 0.15 时推进分几乎不值钱，兵会停在前线附近等，产能继续攒人。
   */
  advance: number;
  /**
   * 不许开火（压掉 ATTACK / SIEGE）。
   *
   * 和 `attack` 乘数的区别：乘数是"有多想打"，这个是"现在别打"的硬开关。
   * 为什么需要它：把 attack 压到 1 以下会让双方一起龟缩（P4 实测），
   * 而"兵还不够、先别送"只需要关掉开火这一件事。
   */
  holdFire: boolean;
}

/**
 * 计划对战术层下的"指令"：比权重更硬，一回合只认一条。
 *
 * 为什么单独一组：权重表达不了"换一座城打"和"全军压上去、别管路过的敌人"——
 * 那两件事不是乘数，是**改目标**。集中突破和绕路都要它。
 */
export interface PlanOrders {
  /** 全军压向主攻城市，不追路过的敌军 */
  commit: boolean;
  /** 主攻城市（覆盖 mood 算出来的那一座） */
  focusCityId: string | null;
  /** 集火目标（覆盖 pickFocusTarget 算出来的那一个）：可以是防御建筑或工人 */
  focusUnitId: string | null;
  /**
   * 这条计划要几个人组成编队（2026-11-21 用户提的）。
   *
   * 战略层给的是**总配额**，具体要多大由任务定：
   *   集中突破 12 人、屯兵 8 人、过河 6 人、守城 5 人；
   *   "侦查"报 1 人（`SCOUT_PLAN` 自己选人，不走编队）。
   * 不写就用战略层的默认规模。
   */
  needSquad: number;
  /**
   * 侦查指令：派 `unitId` 去 `(x,y)` 蹲着看 `cityId` 这座城。
   *
   * 为什么走 `orders` 而不是计划的 `focus`：`focus` 已经被"过河渡口"独占
   * （核心把它写进 `fields.crossingSite/bridgeSite`）。两个语义共用一处出口，
   * 最后一定是"人往东走、桥往西修"。
   */
  scout: { unitId: string; cityId: string; x: number; y: number } | null;
  /**
   * 过河分流：把某个编队引到第二个渡口。
   *
   * 只在"主渡口拥堵"时出现——9 支编队挤一座 1 格宽的桥，不如分一支去别处。
   * `unitIds` 是那支编队的成员，走位层据此改道；其他单位仍走主渡口。
   */
  altCrossing: { x: number; y: number; unitIds: string[] } | null;
  /**
   * 建造编队的目标点（渡口/桥点）。null = 这回合不需要修桥。
   *
   * 和 `altCrossing` 的分工：`altCrossing` 是"哪支战斗编队改道哪个渡口"，
   * 这个点是"工人编队去哪修"。拥堵分流时两者指向同一个新渡口。
   */
  buildPoint: { x: number; y: number } | null;
  /**
   * 顺路观察（阶段 3b 的 B 方案）：把 `unitId` 的**走位目标**从城改成观察点。
   *
   * 和 `scout` 的区别：不建编队、不抽人、**不禁止攻击**。它只是"往那边走的时候
   * 稍微偏一点，先看一眼"，看见了就恢复正常推进。
   */
  peek: { unitId: string; x: number; y: number } | null;
}

/** 行动型计划吐出的一个动作（可带分） */
export interface PlanAction {
  action: Action;
  score?: number;
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
  /**
   * 行动型：这一步要提的动作。
   *
   * 带可选的分：同一条计划里也可能有"这一步就赢"和"再靠近一点"两档
   * （收尾就是这样）。不写就用 `PLAN_TUNING.actionScore`。
   */
  next?(c: PlanCtx): PlanAction[];
  /** 权重型：这一步的乘数，只写要动的那几项。行动型不写 */
  weights?(c: PlanCtx): Partial<PlanWeights>;
  /**
   * 给战术层下的指令（改主攻城市、改是否全军压上、指定集火目标）。
   *
   * 权重表达不了"换一座城打"——那不是乘数，是**改目标**。
   * 多条计划都给时，取价值最高的那一条（和 `focus` 同一套规则）。
   */
  orders?(c: PlanCtx): Partial<PlanOrders>;
  /**
   * 想让战术层去哪儿（渡口、集结点）。
   *
   * 有些计划不改分数，只改"往哪儿使劲"——过河就是这样：它不产生动作，
   * 只把渡口钉住，让工程队和建造评分都围着那一格转。
   * 返回值会存进这条计划的口袋（`state.focus`），下一回合可以读出来做粘性。
   */
  focus?(c: PlanCtx): { x: number; y: number } | null;
  /**
   * 这条计划想记住什么（写进它自己的口袋，下一回合从 `c.state` 读回来）。
   *
   * 有它，计划才能表达"再撑两回合"这种带时间的行为——否则所有状态都得
   * 挤进 `focus` 那一个出口。回滞、驻留、连击计数这类都靠它。
   */
  save?(c: PlanCtx): Record<string, unknown>;
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
  /**
   * 每条计划自己的口袋：planId → 任意状态。**按计划分开**，
   * 否则"收尾记城、过河记渡口"会互相覆盖。
   */
  pockets: Record<string, Record<string, unknown>>;
  /** 跨计划存活的计数器（见 types 的 `PlanMemoLike.keep`） */
  keep?: Record<string, unknown>;
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
  /** 行动型计划吐出的动作，没写分时的默认分 */
  actionScore: 900,
  /*
   * 屯兵（见 ai-v3 的 `MASS_PLAN`）：僵持多少回合开始屯、屯到多少解除。
   *
   * 6 回合是"试探够了"的长度：更短会被一次换血误判成僵持，
   * 更长则前线的兵已经白死了。
   */
  massStallTurns: 6,
  /** 屯兵期间的推进权重（0.15：推进分几乎不值钱，但兵仍然会走位躲火力） */
  massAdvance: 0.15,
  /** 攒到多少解除：至少这么多人，且是对面的多少倍 */
  massMinArmy: 6,
  massRatio: 1.5,
  /**
   * 屯兵到第几回合交棒给"突破"（周期 30：0~5 正常、6~11 屯、12~29 冲）。
   *
   * **必须和 `breakStallTurns` 对齐**：两个计划同时当值时，一个要"别动"、
   * 一个要"全军压上"，会互相抵消（第一版 6~26 都屯、8 起又突破，实测
   * Q2/Q3 平局率反而上升）。
   */
  massGiveUpTurns: 12,
  /**
   * 僵持多少回合开始"换打法"（集中突破 / 绕路）。
   *
   * 和屯兵**错开而不重叠**（屯兵 6~11，突破 12 起）：两者同时当值会互相抵消。
   */
  breakStallTurns: 12,
  /** 选定突破目标后粘多少回合再重选（换得太勤，部队会在两座城之间来回跑） */
  breakStickTurns: 24,
  /**
   * 各计划申报的编队规模。
   *
   * 这些数不是拍脑袋的：突破 12 是"一次能打穿一座有守军的城"的量级，
   * 守城 5 是"够吃城格加成、又不把产兵格占满"，过河 6 是"够铺桥又够守桥头"。
   */
  needSquad: {
    /*
     * 突破 12 → **9**（2026-11-21 实测）：12 人意味着"攒满才出发"，
     * Q4 从 4-1-1 掉到 2-2-2（配对 -3）——等得太久，对面先把城防堆起来了。
     * 9 是"能打穿一座有守军的城"的下限，也不至于等太久。
     */
    breakthrough: 9,
    mass: 8,
    crossing: 6,
    defend: 5,
  },
  /** 计划日志最多留几条（每席每次换计划记一条） */
  traceCap: 200,
  /**
   * 战略姿态的两个维度（见 docs 第十九节）：
   *   x = 派不派兵进攻（0 = 完全不推，1 = 全力压上）
   *   y = 钱花在发展上还是军费上（0 = 全买兵，1 = 全投经济）
   * 姿态计划只把这两个数换算成权重，不在别处再判断一次。
   */
  posture: {
    /** 兵力比到 xAtLow 算不敢打，到 xAtHigh 算敢打 */
    xAtLow: 0.8,
    xAtHigh: 1.6,
    /** 权重 = base + slope × 维度 */
    /*
     * 第一版给的区间是 0.4~1.6 / 0.7~2.0，跑出来 seed 20 从 74 回合的胜局
     * 变成 261 回合平——进攻权重压到 1 以下，双方都不肯攻城，双向龟缩。
     * 所以**下界不许低于 1 太多**：姿态只能"更愿意打"，不能"不肯打"；
     * 真要收手应该由行动型计划（屯兵/防御）明说，而不是靠压低一个乘数。
     */
    /*
     * 第二版：**只加不减**。实测任何小于 1 的进攻乘数都会让双方更不肯攻城，
     * 而 baseline 本来就在"刚好打得动"的边上，压一点就变成 261 回合平。
     * 所以区间定在 1.0~1.3（进攻）和 0.95~1.15（经济）。
     */
    attackBase: 1,
    attackSlope: 0.3,
    econBase: 0.95,
    econSlope: 0.2,
    /** x 低于这个就守线（不越过中线）。先设 0 = 不启用：龟缩风险太大 */
    holdLineBelow: 0,
  },
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
  return { attack: 1, build: 1, econ: 1, save: 1, advance: 1, pullHome: 0, holdFire: false };
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
    // 回撤是"谁要求谁生效"的强度：两条都要收缩时取并集，不是相乘
    if (asked.advance !== undefined) net.advance *= mix(asked.advance);
    if (asked.holdFire === true) net.holdFire = true;
    if (asked.pullHome !== undefined) {
      net.pullHome = 1 - (1 - net.pullHome) * (1 - s * clamp01(asked.pullHome));
    }
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
  /** 当值计划下的指令（合并后的）；没有就是空对象 */
  orders: Partial<PlanOrders>;
  /** 当值计划想让战术层去的那个点（目前只有过河用）；没有就是 null */
  focus: { x: number; y: number } | null;
  /** 上面那个点是哪条计划给的 */
  focusPlanId: string | null;
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
  const pocketsIn = prev?.pockets ?? {};
  /**
   * 每条计划拿到的是**它自己的** ctx：`state` 换成它自己的口袋。
   * 两条计划同时当值时共用一份状态必然打架（一个记城、一个记渡口）。
   */
  const keep = prev?.keep ?? {};
  const ctxFor = (plan: AiPlan): PlanCtx => ({
    ...ctx,
    state: pocketsIn[plan.id] ?? {},
    keep,
  });

  const values: PlanResolution['values'] = [];
  const live: Array<{ plan: AiPlan; value: number }> = [];

  for (const plan of REGISTRY.values()) {
    let v = 0;
    try {
      const c = ctxFor(plan);
      if (!plan.done(c)) v = Number(plan.value(c)) || 0;
    } catch {
      // 一条写坏的计划不该打死整局：按"不成立"处理
      v = 0;
    }
    if (!(v > 0)) v = 0;
    values.push({ id: plan.id, value: v, kind: plan.kind });
    if (v > 0) live.push({ plan, value: v });
  }
  values.sort((a, b) => b.value - a.value);

  /** 冷却中？刚放弃的短期内不重立 */
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
    /*
     * 只有**行动型**的防御计划才配占"行动位"。
     *
     * 权重型的防御（现在这条就是）靠 `pullHome` 起作用，它没有动作可出；
     * 把它塞进行动位等于**把收尾这类真行动挤掉、却什么也不产出**
     * ——2026-11-21 自查时发现的：urgent 一触发，收尾计划就静默失效。
     */
    if (defend && defend.kind === 'action' && defendLive) {
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
    asked: safeWeights(x.plan, ctxFor(x.plan)),
  }));

  const composed = weightList.length > 0 ? composeWeights(weightList) : { net: neutralWeights(), ledger: [] };

  // 记忆记谁：行动型优先（它"占着部队"），没有就记最强的权重型
  const strongestWeight = [...weightPlans].sort((a, b) => b.value - a.value)[0]?.plan ?? null;
  const memoryOf = chosen ?? strongestWeight;
  const memoryValue = memoryOf ? (live.find((x) => x.plan.id === memoryOf.id)?.value ?? 0) : 0;

  /*
   * 落点：当值的计划里，谁给了"往哪儿使劲"就记下来。
   * 现在只有一条会给（过河），多条给了就取价值最高的那条——两条指不同方向
   * 本来就是设计错误，日志里能看见是哪条赢的。
   */
  /*
   * 指令：和落点一样，取"价值最高的那条计划"给的。
   * 两条计划同时改主攻城市是没有意义的（会互相覆盖），日志里能看出是谁赢的。
   */
  let orders: Partial<PlanOrders> = {};
  const orderCandidates = [chosen, ...weightPlans.map((x) => x.plan)].filter(Boolean) as AiPlan[];
  orderCandidates.sort(
    (a, b) =>
      (live.find((x) => x.plan.id === b.id)?.value ?? 0) -
      (live.find((x) => x.plan.id === a.id)?.value ?? 0),
  );
  /*
   * 按价值从高到低**合并**，先到的字段优先。
   *
   * 不能"取第一条就停"：屯兵只想申报"我要 8 个人"，不该顺手把
   * 突破计划的目标城/集火目标一起顶掉。谁先占住某个字段，后面的就不覆盖。
   */
  for (const plan of orderCandidates) {
    if (!plan.orders) continue;
    try {
      const o = plan.orders(ctxFor(plan));
      if (o && Object.keys(o).length > 0) {
        const filled: Partial<PlanOrders> = {};
        for (const [k, v] of Object.entries(o)) {
          if ((orders as Record<string, unknown>)[k] === undefined) (filled as Record<string, unknown>)[k] = v;
        }
        orders = { ...orders, ...filled };
      }
    } catch {
      // 写坏的计划不该打死整局
    }
  }

  let focus: { x: number; y: number } | null = null;
  let focusPlanId: string | null = null;
  const focusCandidates = [chosen, ...weightPlans.map((x) => x.plan)].filter(Boolean) as AiPlan[];
  focusCandidates.sort((a, b) => (live.find((x) => x.plan.id === b.id)?.value ?? 0) - (live.find((x) => x.plan.id === a.id)?.value ?? 0));
  for (const plan of focusCandidates) {
    const f = safeFocus(plan, ctxFor(plan));
    if (f) {
      focus = f;
      focusPlanId = plan.id;
      break;
    }
  }

  /*
   * 冷却表：**不再当值**的计划记一笔到期回合。
   *
   * 注意"不当值"不等于"死了"：一条计划可能还有价值、只是被更高的压下去了。
   * 按"还活着"判会让冷却形同虚设（实测探针就在这里红过）。
   */
  const cooldown: Record<string, number> = { ...(prev?.cooldown ?? {}) };
  if (prev && prev.id !== '') {
    const prevStillActive =
      prevLive !== null && (prevLive.plan.kind === 'action' ? chosen?.id === prev.id : true);
    /*
     * **完成 ≠ 放弃**：一条计划干完自己的活（`done` 为真）不该进冷却。
     *
     * 过河就是这样：过去了 → 计划完成；被赶回来 → 应该立刻能重新立。
     * 冷却的本意是"别在两条计划之间来回改投"，不是"干完也不许再干"。
     * 这一条是 P3 对比时抓出来的：不加它，seed 11 会晚 4 回合结束。
     */
    const prevPlanDef = REGISTRY.get(prev.id) ?? null;
    const prevDone = prevPlanDef !== null && safeDone(prevPlanDef, ctxFor(prevPlanDef));
    if (!prevStillActive && !prevDone) cooldown[prev.id] = turn + PLAN_TUNING.cooldown;
    else if (prevStillActive) delete cooldown[prev.id];
  }
  // 过期条目清掉，别让它无限长
  for (const [id, until] of Object.entries(cooldown)) if (until <= turn) delete cooldown[id];

  /*
   * 口袋：只保留这一刻当值的那些计划。不当值的丢掉口袋是**有意的**——
   * 重新立约应该从零开始，而不是沿用几回合前的半截状态。
   */
  const pockets: Record<string, Record<string, unknown>> = {};
  const activeIds = [chosen?.id, ...weightPlans.map((x) => x.plan.id)].filter((x): x is string => !!x);
  for (const id of activeIds) {
    const pocket = { ...(pocketsIn[id] ?? {}) };
    if (focusPlanId === id && focus) pocket.focus = focus;
    // 每条当值的计划都写自己的记忆（回滞、计数）——不是只有"记忆持有者"写。
    // 行动型占着记忆位时，权重型的状态也得留着，否则它们的回滞每回合归零。
    const def = REGISTRY.get(id);
    if (def?.save) {
      try {
        Object.assign(pocket, def.save(ctxFor(def)) ?? {});
      } catch {
        // 写坏的计划不该打死整局
      }
    }
    pockets[id] = pocket;
  }

  const memo: PlanMemo | null =
    memoryOf !== null
      ? {
          id: memoryOf.id,
          valueAt: prev && prev.id === memoryOf.id ? prev.valueAt : memoryValue,
          since: prev && prev.id === memoryOf.id ? prev.since : turn,
          pockets,
          keep,
          ...(Object.keys(cooldown).length > 0 ? { cooldown } : {}),
        }
      : // 一条计划都不当值时，只要冷却还没过就得留一条空记录——
        // 否则 `prev` 变成 null，冷却表跟着丢掉，冷却等于没写
        Object.keys(cooldown).length > 0 || Object.keys(keep).length > 0
        ? { id: '', valueAt: 0, since: turn, pockets, keep, cooldown }
        : null;

  return {
    action: chosen,
    weights: weightPlans.map((x) => x.plan),
    net: composed.net,
    ledger: composed.ledger,
    orders,
    focus,
    focusPlanId,
    memo,
    reason,
    values,
  };
}

function safeDone(plan: AiPlan, ctx: PlanCtx): boolean {
  try {
    return plan.done(ctx);
  } catch {
    return false;
  }
}

function safeFocus(plan: AiPlan, ctx: PlanCtx): { x: number; y: number } | null {
  if (!plan.focus) return null;
  try {
    return plan.focus(ctx) ?? null;
  } catch {
    return null;
  }
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
    threat: 0,
    enemyAtGate: false,
    weaker: false,
    focusCityId: null,
    marchTurns: 0,
    projRatio: 1,
    intelKnown: false,
    intelConf: 0,
    horizon: PLAN_TUNING.horizon,
    state: {},
    keep: {},
    ...patch,
  };
}


/**
 * 把"这一回合当值的是哪条计划"记进局面（只记变化，不每回合记）。
 *
 * 为什么记在 state 里而不是直接打印：AI 要保持纯函数（不碰 IO），
 * 而"计划有没有被用上"这件事必须能从跑批结果里看出来——
 * 否则一个计划写错了 value，表现就是"AI 完全没反应"，和"没装"一模一样。
 * 跑批脚本负责把它打成 sidecar（`<回放>.plans.jsonl`）。
 */
export function notePlanTrace(
  s: GameState,
  me: PlayerId,
  res: PlanResolution,
): void {
  const list = (s.aiPlanTrace ??= []);
  const planId = res.action?.id ?? res.weights.map((p) => p.id).sort().join('+') ?? null;
  const key = planId === '' ? null : planId;
  let last: AiPlanTrace | undefined;
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i]!.me === me) {
      last = list[i];
      break;
    }
  }
  if (last && last.plan === key) return;
  list.push({
    turn: s.turn,
    me,
    plan: key,
    reason: res.reason,
    values: res.values.map((v) => ({ id: v.id, value: Math.round(v.value) })),
    net: { ...res.net },
  });
  if (list.length > PLAN_TUNING.traceCap) list.splice(0, list.length - PLAN_TUNING.traceCap);
}

/** 安全地取一条计划的动作：写坏的 next 按"没动作"处理，不打死整局 */
export function planActions(plan: AiPlan | null, ctx: PlanCtx): PlanAction[] {
  if (!plan?.next) return [];
  try {
    return plan.next(ctx) ?? [];
  } catch {
    return [];
  }
}
