/**
 * 战况烈度：上一回合里，这一格挨了多少下。
 *
 * ── 它回答的问题 ───────────────────────────────────────────────────────
 *
 * 轮到你了，但上一回合对面到底打了哪儿？——是试探性地碰了一下左翼，
 * 还是把整条中路犁了一遍？这个问题在战报里翻起来很累，在看棋盘时却应该一眼可见。
 * 所以这里按"格"记账：**每块格子上，我方单位上一次被打了多少次**。
 *
 * ── 为什么不按"谁能打到这一格"算 ──────────────────────────────────────
 *
 * 那算的是"未来的威胁"，是预测：射程覆盖不等于真的开火。而玩家真正需要复盘的是
 * **已经发生过的事**——哪儿被打得最狠，就该往哪儿补人、修工事、或者干脆放弃。
 * 预测会把整条战线都标红（敌人射程本来就很长），反而什么都看不出来。
 *
 * ── 记账口径 ───────────────────────────────────────────────────────────
 *
 *   · 一次伤害 = 一次计数（溅射打到三个人 = 三格各 +1，多动连打三次 = 那格 +3）；
 *   · 记的是**挨打那一刻**的格子，不是现在的格子——兵被打退、被打死后位置会变，
 *     复盘要看的是"当时在哪儿挨的打"；
 *   · 按回合分开存：`heat[玩家][回合][格] = 次数`。界面取 `s.turn - 1` 那一份，
 *     也就是"上一次敌方回合"。自己回合里吃到的反击记在自己这一回合的账上，
 *     不会污染上一回合的复盘；
 *   · 只留最近两回合，多的删掉——存档不该为一份提示无限长大。
 *
 * 不计入的：中毒/灼烧这类回合开始的持续伤害、天气钩子在回合末扣的血。
 * 它们是"环境"，不是"对面打了你"，混进来会让"哪里打得最狠"失真。
 */

import type { GameState, PlayerId, Unit } from './types.ts';

/** 在某一格上给某个玩家记一次挨打 */
export function noteHeat(s: GameState, victim: Unit): void {
  const perPlayer = ((s.heat ??= {})[victim.owner] ??= {});
  const key = String(s.turn);
  const cells = (perPlayer[key] ??= {});
  const i = victim.y * s.w + victim.x;
  cells[i] = (cells[i] ?? 0) + 1;

  // 只留"这一回合"和"上一回合"：界面只会读上一回合那一份，
  // 更早的是死账，留着只会让存档和联机快照慢慢变胖。
  for (const k of Object.keys(perPlayer)) {
    if (Number(k) < s.turn - 1) delete perPlayer[k];
  }
}

/**
 * 上一次敌方回合里，这个玩家的哪些格子挨了打（格索引 → 次数）。
 *
 * `s.turn - 1` 就是"上一次敌方回合"：回合是逐方推进的，轮到你时，
 * 上一个回合必然是敌方那一次。
 */
export function heatCells(s: GameState, player: PlayerId): Map<number, number> {
  const out = new Map<number, number>();
  const cells = s.heat?.[player]?.[String(s.turn - 1)];
  if (!cells) return out;
  for (const [k, v] of Object.entries(cells)) {
    const i = Number(k);
    if (v > 0) out.set(i, v);
  }
  return out;
}

/**
 * 把次数折成闪烁档位（1~5）。
 *
 * 3 次和 4 次的差别玩家看得出来，7 次和 8 次看不出来——五档封顶是为了
 * 让"最激烈的那几格"保持醒目，而不是让整张图一起乱闪。
 */
export function heatStep(count: number): number {
  if (count <= 0) return 0;
  return Math.min(5, Math.max(1, Math.trunc(count)));
}

/** 什么时候该把红格画出来 */
export interface HeatViewOpts {
  /** 此刻看得见的格子（雾）。不传 = 全图可见 */
  visible?: ReadonlySet<number>;
  /** 这一回合已经出过手了：红格只留到第一次行动，之后收起来 */
  dismissed?: boolean;
  /** 现在是不是轮到"自己这一方"看（观战、对方回合都不算） */
  active?: boolean;
}

/**
 * 交给界面的那一份烈度表：没东西可显示时返回 undefined。
 *
 * 三条规则都在这里落地，界面只管画：
 *   · 不是自己的回合 / 观战中 → 不显示；
 *   · 这一回合已经出手 → 收起（红格是"上回合的答卷"，看完就该让位）；
 *   · 视野外的格子 → 不显示，连坐标都不给。
 */
export function visibleHeat(
  s: GameState,
  player: PlayerId,
  opts: HeatViewOpts = {},
): Map<number, number> | undefined {
  if (opts.active === false) return undefined;
  if (opts.dismissed) return undefined;
  const out = new Map<number, number>();
  for (const [i, n] of heatCells(s, player)) {
    if (opts.visible && !opts.visible.has(i)) continue;
    out.set(i, n);
  }
  return out.size > 0 ? out : undefined;
}
