/**
 * v4 三层的**数据契约**。
 *
 * 这个文件里没有算法，只有"每层准输出什么"。它是 v4 和 v3 最大的区别：
 * v3 的三层都可以往同一张分数表里加一项，所以谁也说不清一个决定是谁做的；
 * v4 的三层各自只能交出下面这几种东西，越界的形状根本编译不过。
 *
 * ```
 *   决定层  decide.ts    ──→  Decision（做什么 + 期限 + 理由）
 *                              ↓
 *   约束层  constrain.ts ──→  Constraints（哪几格必须空、哪几个兵归哪队、去打哪座城）
 *                              ↓
 *   打分层  tactics.ts   ──→  Action（引擎认的那一个动作）
 * ```
 */

/** 决定层能做的三种事。**只有这三种**，想加第四种先证明前三种表达不了它 */
export type DecisionKind = 'expand' | 'press' | 'defend';

export interface Decision {
  kind: DecisionKind;
  /** 这个决定管到第几手为止。到了就重算——**不许"一直有效"**，那样它会悄悄变成常数 */
  untilTurn: number;
  /** 一句话说明为什么（进日志，出问题时第一眼看这个） */
  reason: string;
  /** press / defend 指向哪座城（`expand` 没有目标城） */
  cityId?: string;
}

/** 一支部队在本回合的任务。**任务种类固定**，别用"分数"表达意图 */
export type SquadOrder =
  /** 开到集结点（不接敌） */
  | 'assemble'
  /** 向目标城推进，路上遇敌就打 */
  | 'march'
  /** 贴着目标城打（优先攻城/清守军） */
  | 'siege'
  /** 守在原地/守城（不主动出击） */
  | 'hold';

export interface Squad {
  id: string;
  order: SquadOrder;
  unitIds: string[];
  /** assemble 的集结点 */
  at?: { x: number; y: number };
  /** march / siege 的目标城 */
  cityId?: string;
  /** 目标人数：按目标城守军算，成立时定下，之后不因伤亡而缩（见 V4Memory.squad） */
  want?: number;
  /**
   * 采购的**门槛**（约束）：要造什么样的兵。挂在约束层（不是某支队）——
   * 守城时同样要按对面的构成配兵，而守城时根本没有 `main` 队。
   *
   * 两条不等式，都从"目标城的守军"算出来，不是偏好、不是权重：
   *   · `hp`：能挨住对面一发（`hp > 敌方单发攻击`）——挨不住就等于白送；
   *   · `atk`：能在三发内打穿（`atk × 3 ≥ 敌方血量`）——打不穿等于没来。
   * 满足这两条的里面**先挑射程远的**（先手权），射程一样才看价钱。
   * （这里原来写的是"挑最便宜的"——那是错的，代码从来没这么做过，见 8.15。）
   */
  /** 分路：本队拆成几条走廊（路数由地形宽度决定，见 constrain.planLanes） */
  lanes?: Array<{ x: number; y: number }>;
  /** 每个单位走第几条路 */
  laneOf?: Record<string, number>;
  /** 这一队要不要寻路绕（目标直线走不通，比如隔着河）：整队一个判断，不按单个兵 */
  detour?: boolean;
  /** 全队最慢的人赶到目标还要几回合（Infinity = 到不了）。出发条件读它 */
  eta?: number;
  /**
   * **本回合的主目标**（集火点）：这一手能打它的都打它。
   *
   * 为什么放在约束层而不是打分层：见 PLAN 4.1——约束层管"必须/不许"，打分层只排先后。
   * "全体打 X"的真实含义是"**不许**各打各的"，那是约束。
   * 放打分层的话，每个单位各算"打谁划算"，加总必然分散；要收敛就得让单位互相知道
   * 别人在打谁——打分层就变成有状态的协调器，"一个单位一步、只看自己"这条就废了。
   */
  focusId?: string;
}

/**
 * 约束层交出来的东西。
 *
 * `keepClear` 是这一层的**核心**：v3 折腾三轮"让位"失败，根因是它想用分数表达"必须"。
 * 在 v4 里"这几格必须空"是一个约束，打分层只许照做，不许权衡。
 */
export interface Constraints {
  /**
   * **经济兵的岗位**（约束层）：每个经济兵该站哪一格。
   *
   * 为什么必须在这一层："去森林"原来只是打分层每步重算的结果，
   * 一旦被"让开产兵格"推走，它就没有终点可回——实测伐木工被推到北边平原，
   * 下一手就再也回不到两格外的森林（S-015 卡在 19 的原因）。
   *
   * 有了岗位，两个约束不再打架：**让位是绕路，岗位是终点。**
   */
  econPosts?: Record<string, { x: number; y: number }>;
  /**
   * **下一个该造的经济兵**（约束层）：认领表里还没人认领、且"到这个决定结束前
   * 能赚回的倍数"最高的那一格。造兵只照这个执行，不再自己比价、比产出。
   *
   * 没有它 = 表里没有值得占的格（或者钱/出兵格不够），这回合就别造经济兵。
   */
  econNext?: { type: string; x: number; y: number };
  /**
   * **经济兵这一手的行动顺序**（约束层）：靠自己岗位近的排在前面。
   *
   * 为什么顺序也是约束：人挤人时，"谁先动"决定整列能不能往前挪——
   * 前面的人先走开，后面的人才看得到空格。让每个兵自己判断"我要不要动"
   * 是微观决策，会互相顶死（我的更近是你、你的更近是我）。
   *
   * 链的读法：`岗位（末端） → … → 兵（源头）`。**从末端往源头排**，
   * 所以第一个动的是"已经贴着岗位的那个人"。
   */
  econOrder?: string[];
  /**
   * **战斗单位这一手走哪一格**（约束层一次排定）。
   *
   * 这不是"每格一个建议"，而是**一人一格、互不重复**的落点表：相邻两个人不会
   * 抢同一格，也就不会因为"谁先动"而互相堵死。用的是同一张距离场：
   * 起点是"目标城的可站格"，波穿过自己人（见 `constrain.planMarch`）。
   *
   * 打分层只负责执行；执行时如果这一格已经不可达（前面的人先动了），
   * 退回自己的走位（`stepToward`），不要硬报。
   */
  steps?: Record<string, { x: number; y: number }>;
  /** 采购门槛：要造"挨得住一发、三发能打穿"的兵（从对面构成算，见 constrain） */
  need?: { hp: number; atk: number };
  /** 必须空出来的格子（产兵格、城门口）。打分层发现自家单位站着，第一件事就是把它挪开 */
  keepClear: number[];
  squads: Squad[];
  /**
   * 让位搬迁计划：`unitId → 这一手要挪到哪一格`。
   *
   * 为什么让位要有"计划"而不只是"判断"：关键格后面常常排着一串自己人
   * （产兵格被三个兵堵着、桥头后面跟着一队）。让一个人走开没用，整条链要一起挪一格。
   * 多源 BFS 从所有空格出发，给每个关键格配最近的"洞"，沿链倒推就得到每个单位的落点。
   *
   * 这一条**是约束**（必须做），不是打分——v3 把它和 `yieldPlan` 的分数混在一起，
   * 于是"让开"和"别送死"互相打折，最后谁也不让。
   */
  yieldMoves: Array<{ unitId: string; x: number; y: number }>;
  /** 这一回合不许做的动作类型（比如"这回合不造经济兵"） */
  forbid?: string[];
}

/** 一个单位在本回合的归属：属于哪支队、任务是什么。查不到就是"没任务" */
export interface UnitTask {
  squadId: string;
  order: SquadOrder;
  at?: { x: number; y: number };
  cityId?: string;
}

/** `GameState.aiFocus[p].v4` 的形状（见 core/types.ts 里的同名注释） */
export interface V4Memory {
  /** 承诺：上一次做的决定、哪一手立的、管到第几手 */
  decision?: Decision & { since: number } | null;
  /** 事实：这支队第几手成立、当初定下打几个人（防止 want 每回合被人一死就缩） */
  squad?: { id: string; cityId: string; formedAt: number; want: number } | null;
  /**
   * 事实：每个经济兵是第几手造出来的（`unitId → 手数`）。
   *
   * 为什么需要记：岗位要按"谁先出生谁走远路"配（见 `constrain.planEconPosts`）。
   * 引擎的单位没有出生手数，只能自己记；只记事实，不记判断。
   */
  econSince?: Record<string, number>;
  /**
   * 事实：每个经济兵**出生在哪座城**（`unitId → cityId`）。
   *
   * 为什么不能每回合按"现在离哪座城近"算：人一走动，最近城就会翻，
   * 分组跟着翻 → 目标每回合重排 → 兵来回挪（实测长局里一整列都在原地打转）。
   * 出生城是事实，不会变。
   */
  econHome?: Record<string, string>;
}

/** 结构化日志的一条。出了问题先看它，别看代码 */
export interface DecisionLog {
  turn: number;
  decision: Decision | null;
  /** 每支队的规模和任务 */
  squads: Array<{ id: string; order: SquadOrder; n: number }>;
  /** 这回合为什么停手（null = 还有事可做） */
  idle?: string;
}
