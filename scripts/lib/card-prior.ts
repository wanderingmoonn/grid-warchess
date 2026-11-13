/**
 * 卡牌先验：实测残差的离线产物。**已停用，不接入手写 AI**（2026-11-08）。
 *
 * ---------------------------------------------------------------
 * 为什么停用
 * ---------------------------------------------------------------
 * 曾经把它乘进 `draftScoreOf`（选卡估值），并量过：默认档 ±5%、每局改 3.6 签、
 * 明确偏好点只动 16%，方向也对（女巫/火枪兵被推高、弩兵/皇家卫队被推低）。
 * 但它是**静态快照**：残差记的是"当时那张卡赢多少"，不是"为什么赢"。
 * 数值一调（弩兵 16→19 这种），旧残差就被乘到新卡上——两套信号互相矛盾，
 * 比没有先验更糟。加过数值指纹闸门兜底，但本质仍是"用过期体检报告指挥下棋"。
 * 用户明确要求回撤，于是摘掉接线，数据留在这里做离线分析。
 *
 * **现在唯一还碰它的地方**：`scripts/draft-metrics.py`（出表）、
 * `scripts/test-rules.ts`（防回潮断言：选人与开关无关）。
 * `src/` 里没有任何引用——它不进游戏包。
 *
 * ---------------------------------------------------------------
 * 数字本身怎么来的（改表前必读）
 * ---------------------------------------------------------------
 * 数据：`.tmp/draft/{e1,e3,e3-turnban}` 共 400 局选卡对局。
 *   · 残差 = (实胜 − 席位加权期望) / 局数。**不是裸胜率**，裸胜率是席位的倒影。
 *   · 收缩 = 残差 × n/(n+40)：n=20 的卡只拿三分之一。
 *   · 乘数 = 1 + (cap/span) × clamp(收缩后, ±span)，span=15pp、cap=15%。
 * 已知偏差：胜率来自 AI 自对弈，AI 不会用的卡会显得弱 → 更不会被选 →
 * 永远学不会（自证循环）。真人 43 局才是分布外的信号，这张表不是。
 */


import { CARD_PRIOR, CARD_PRIOR_META } from './card-prior.table.ts';
import { unitDigest } from './unit-digest.ts';

const env = typeof process === 'undefined' ? '' : (process.env.WB_CARD_PRIOR ?? '');
const envScale = typeof process === 'undefined' ? '' : (process.env.WB_CARD_PRIOR_SCALE ?? '');

/**
 * 这张表还认不认现在这套数值。
 *
 * 先验表记的是"当时那张卡赢多少"，不是"为什么赢"。数值一动（弩兵 16→19、
 * 炼金术士 165→240 这种），残差就是旧世界的结论，却会被乘到新世界的卡上——
 * 两套信号互相矛盾，比没有先验更糟。所以这里对一次指纹：改了任何一个参与
 * 指纹的数字，先验**自动关掉**，而不是悄悄给错的分。
 *
 * 要重开：`npm run draft:prior` 重生成表（生成时会把新指纹写进表头）。
 * 想强行带病运行：`WB_CARD_PRIOR=force`。
 */
function digestMatches(): boolean {
  try {
    return unitDigest(Object.keys(CARD_PRIOR)) === CARD_PRIOR_META.unitsDigest;
  } catch {
    // 算不出来（老浏览器没有某些语法之类）就当过期：宁可不用，不可用错
    return false;
  }
}

/**
 * 表是否对得上当前数值。
 *
 * **必须懒算，不能放在模块顶层**：`unitDigest` 要枚举全扩展单位表，而那张表
 * （setup.ts → expansions.ts）在 import 阶段可能还没装配完。顶层算过一次的后果
 * 是"在某些入口被误判成过期、先验整体失效"——测试里就是这么炸的：
 * 同一份代码，`node -e` 里 fresh=true，跑 test-rules 里 fresh=false。
 * 延迟到第一次真正用到先验时再算，就不会被 import 顺序影响。
 */
let freshCache: boolean | null = null;
export function cardPriorIsFresh(): boolean {
  if (freshCache === null) freshCache = digestMatches();
  return freshCache;
}

/** 诊断/探针用：强制重算一次（改了数值又想在进程内验证时可以调） */
export function cardPriorRecheck(): boolean {
  freshCache = digestMatches();
  return freshCache;
}

/**
 * 默认强度 0.35，**不是 1**。这是量出来的，不是拍的。
 *
 * `scripts/probe-card-prior.ts`（时代 3 / 20×20 / 30 个种子，同一批种子开/关对照）：
 *
 * | scale | 先验上限 | 每局改动 | 分差>10% 的点被改 |
 * |---|---|---|---|
 * | 0.1  | ±2%  | 1.80 签 | 7%  |
 * | 0.35 | ±5%  | ~4 签   | 20% |
 * | 1    | ±15% | 7.47 签 | 34% |
 *
 * 关键背景：**AI 自己的选人分差中位只有 5%**（p10 0.7% / p90 16.5%）。
 * 也就是说它在多数决策点上本来就没有明确偏好，±15% 的先验不是"微调"，
 * 是把"能分清的地方"也一起打散（34% 的明确偏好点被推翻）。
 * 0.35 档保住了 80% 的明确偏好，同时把并列点（<3%）改了近一半——
 * 那正是先验该干的活：替并列做决断，而不是替 AI 下棋。
 *
 * 想验证"更强"必须另跑胜率 A/B，这个数只保证"改得动、且没有压过 AI 的判断"。
 */
const DEFAULT_SCALE = 0.35;

/**
 * 运行时开关。**可变**，因为探针要在同一个进程里跑"开/关"两次对照
 * （起两个 worker 跑两次会引入种子之外的其他差异）。
 */
export const cardPrior = {
  /**
   * 总开关。**默认关**，`WB_CARD_PRIOR=on` 才打开（离线对照用）。
   * 现在没有任何运行时读它——留着是为了将来重新评估时不至于一 import 就生效。
   * **表过期（数值改过）时即使这里写着开，`cardPriorFactor` 也返回 1**——
   * 唯一例外是 `WB_CARD_PRIOR=force`（带病运行，只给对照实验用）。
   */
  on: env === 'on' || env === '1' || env === 'true',
  /**
   * 整张表的放大倍数（1 = 表里的原值，即 ±15%）。
   * 默认 0.35：见 `DEFAULT_SCALE` 那段实测表——1 档会推翻 AI 34% 的明确偏好。
   * 探针用它量"要多大力气才推得动动作"，线上用环境变量覆盖。
   */
  scale: envScale ? Number(envScale) : DEFAULT_SCALE,
};

/** 这张卡的选卡分该乘多少（没有样本 = 1，即不干预） */
export function cardPriorFactor(id: string): number {
  if (!cardPrior.on) return 1;
  if (!cardPriorIsFresh() && env !== 'force') return 1;
  const row = CARD_PRIOR[id];
  if (!row) return 1;
  const f = 1 + (row.factor - 1) * cardPrior.scale;
  // 双保险：即使 scale 被调大，也不许把乘数推出这张表的量级
  return Math.max(1 - CARD_PRIOR_META.cap * 2, Math.min(1 + CARD_PRIOR_META.cap * 2, f));
}

/** 诊断用：这张卡为什么被加减分（探针和调试横幅读它） */
export function cardPriorInfo(id: string): {
  n: number;
  resid: number;
  shrunk: number;
  factor: number;
} | null {
  const row = CARD_PRIOR[id];
  if (!row) return null;
  return { n: row.n, resid: row.resid, shrunk: row.shrunk, factor: cardPriorFactor(id) };
}

/** 表里一共有多少张卡（含 n<10 被排除的） */
export function cardPriorSize(): number {
  return Object.keys(CARD_PRIOR).length;
}

export { CARD_PRIOR, CARD_PRIOR_META };
