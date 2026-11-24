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
}

/**
 * 约束层交出来的东西。
 *
 * `keepClear` 是这一层的**核心**：v3 折腾三轮"让位"失败，根因是它想用分数表达"必须"。
 * 在 v4 里"这几格必须空"是一个约束，打分层只许照做，不许权衡。
 */
export interface Constraints {
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

/** 结构化日志的一条。出了问题先看它，别看代码 */
export interface DecisionLog {
  turn: number;
  decision: Decision | null;
  /** 每支队的规模和任务 */
  squads: Array<{ id: string; order: SquadOrder; n: number }>;
  /** 这回合为什么停手（null = 还有事可做） */
  idle?: string;
}
