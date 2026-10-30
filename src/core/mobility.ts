/**
 * 扩展规则：高机动性。
 *
 * 一句话：**所有单位的移动力、射程、视野一律 ×1.5**。没有新兵种、没有新地形、
 * 不改任何一条判定顺序——只在既有的三个钩子上把数值放大。
 *
 * 为什么值得单独做一个扩展：这三样东西决定的是"一回合能覆盖多大一片战场"。
 * 同一张图，×1.5 之后前线的接敌距离、绕后包抄的回合数、攻城前必须先清掉的
 * 视野盲区全都会变，而兵种之间的强弱对比几乎不动（大家都变快）。它改变的
 * 是**战斗的节奏**，不是某支兵的强度——这正是"扩展"该干的事。
 *
 * 取整的取舍（三处不一样，都是有意的）：
 *   · 移动力向上取整：2 → 3。移动力是"一回合能走几格"，向下取整等于白给。
 *   · 射程向下取整：3 → 4、5 → 7，但**近战（射程 1）保持 1**。
 *     射程 1 是"贴上去打"的定义，×1.5 之后变成 2 会让所有近战变成远程，
 *     那不是提高机动性，那是把兵种分类抹掉——而且会连带把近战专有的
 *     出手折扣、反击逻辑全部搞乱。
 *   · 视野向上取整：2 → 3。视野向下取整会出现"看着没变"的兵。
 *
 * 和「地形高差」的关系：那个扩展往步耗里加爬坡，这个扩展放大总移动力，
 * 两者相乘＝跑得快的兵依然爬得动坡（钳位那个"一格最多吃掉全部移动力"
 * 也照样生效）。不需要额外协调。
 *
 * 关掉这个扩展：三个钩子都不挂，移动/射程/视野与本体逐格相同。
 */

import type { Expansion } from './expansions.ts';

/** 倍率。想调平衡就改这一个数（1.5 = 快一半）。 */
export const MOBILITY_SCALE = 1.5;

/** 移动力：向上取整，至少保留原值（缩放不该让谁变慢） */
export function scaledMove(move: number): number {
  if (move <= 0) return move; // 建筑不动：0 还是 0，别把墙变成会走的
  return Math.max(move, Math.ceil(move * MOBILITY_SCALE));
}

/**
 * 射程：向下取整，**近战保持原样**。
 *
 * 射程 1 是"贴上去打"的定义；把它抬到 2 等于让所有近战变成远程，
 * 那不是提高机动性，是把兵种分类抹掉了。
 */
export function scaledRange(range: number): number {
  if (range <= 1) return range;
  return Math.max(range, Math.floor(range * MOBILITY_SCALE));
}

/** 视野：向上取整；0 保持不变（看不见东西的单位不该被这一条救活） */
export function scaledVision(vision: number): number {
  if (vision <= 0) return vision;
  return Math.max(vision, Math.ceil(vision * MOBILITY_SCALE));
}

export const HIGH_MOBILITY: Expansion = {
  id: 'high-mobility',
  name: '高机动性',
  summary:
    '全场的移动力、射程、视野一律 ×1.5：移动向上取整（2 → 3），视野向上取整（2 → 3），' +
    '射程向下取整（3 → 4、5 → 7），近战仍然是射程 1。' +
    '改的是"一回合能覆盖多大一片战场"，不是某支兵的强弱——大家都变快，强弱对比几乎不动，' +
    '但接敌距离、绕后回合数、攻城前的视野盲区全都会变。',
  scale: 'small',
  hooks: {
    modifyMove: ({ move }) => scaledMove(move),
    modifyRange: ({ range }) => scaledRange(range),
    modifyVision: ({ unit, base }) => (unit ? scaledVision(base) : base),
  },
};
