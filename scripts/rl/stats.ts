/**
 * 评估用的统计小工具。
 *
 * 单独一个文件是为了让 `eval.ts` 保持"命令行入口"的身份——
 * 谁 import 它都会立刻开始跑一整个评估（带 spawn），测试里根本没法用。
 */

/**
 * Wilson 得分区间（95%）。
 *
 * 为什么不用"胜率 ± 1.96·√(p(1−p)/n)"：小样本和极端比例下它会输出
 * 负数下界和超过 1 的上界，还会把 0/100 说成"区间 [0,0]"——那是把
 * "一次没赢"当成了"绝不会赢"。Wilson 在两个端点上都不会骗人。
 */
export function wilson(wins: number, n: number, z = 1.96): { lo: number; hi: number } {
  if (n === 0) return { lo: 0, hi: 1 };
  const p = wins / n;
  const denom = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return { lo: Math.max(0, centre - half), hi: Math.min(1, centre + half) };
}
