/**
 * 敌情预警：哪些格子正落在敌人的火线上。
 *
 * ── 这个模块存在的理由 ─────────────────────────────────────────────────
 *
 * 战棋里最贵的不是血，是"我以为那里是安全的"。敌人射程 3 的投石机摆在河对岸，
 * 玩家只有把兵挪过去挨了一发才知道它够得着——这类账应该在**动手之前**就能算。
 * 所以这里把"每个敌人能打到哪"算成一张格子表，交给界面去闪。
 *
 * ── 算的是"可能挨打"，不是"一定挨打" ─────────────────────────────────
 *
 * 敌人这一回合可能移动后再打，也可能打别人；这里只回答"以它现在的位置，
 * 这一格在不在它的火力覆盖里"。宁可多亮几格，也不要漏亮——漏了就是骗人。
 *
 * ── 和视野的关系 ───────────────────────────────────────────────────────
 *
 * 传进来的 `visible` 是"我方此刻看得见的格子"。看不见的格子一律不算：
 * 雾里的敌人不该被这份提示出卖位置，也不该让玩家从红格反推出阴影里有埋伏。
 * 注意这不只是"少画几格"——如果只按敌人位置算范围再交给界面裁剪，
 * 界面照样会拿到那些格的坐标；所以**在算出结果之前就裁掉**。
 */

import { splashRadiusOf } from './rules.ts';
import type { GameState, PlayerId } from './types.ts';

/**
 * 每个格子可能被几个敌人打到（格索引 → 次数）。
 *
 * 次数就是"闪烁频率"的依据：三个敌人同时够得着的路口，应该比只有一个弓手
 * 盯着的空地更急。没人能打到的格子不会出现在表里。
 *
 * 口径：
 *   · 只看**敌人**（`owner !== viewer`），自己人和盟友不算；
 *   · 只认可开火的单位（范围 ≥ 1 且攻击 > 0）——运输船、经济单位不吓人；
 *   · 射程吃扩展钩子（`splashRadiusOf` 已经是钩子感知的），
 *     所以溅射加大的扩展会如实反映在红格上；
 *   · 落点 = 以敌人为中心、半径 `射程 + 溅射` 的曼哈顿菱形。
 *     多算的那一圈是"溅射到我"的可能，不是"它直接瞄我"。
 *
 * 已知不计入的东西：空中层（飞机的高度差不在这张表里表达）、
 * 敌人的移动能力（它走过来还能打，这里只按它**现在站的位置**算）。
 */
export function incomingThreat(
  s: GameState,
  viewer: PlayerId,
  visible?: ReadonlySet<number>,
): Map<number, number> {
  const out = new Map<number, number>();
  for (const enemy of s.units) {
    if (enemy.owner === viewer) continue;
    const def = s.unitTypes[enemy.type];
    if (!def) continue;
    if ((def.atk ?? 0) <= 0) continue;
    const range = Math.max(0, def.range ?? 0);
    if (range <= 0) continue;

    const reach = range + splashRadiusOf(s, enemy);
    const x0 = Math.max(0, enemy.x - reach);
    const x1 = Math.min(s.w - 1, enemy.x + reach);
    const y0 = Math.max(0, enemy.y - reach);
    const y1 = Math.min(s.h - 1, enemy.y + reach);
    for (let y = y0; y <= y1; y += 1) {
      for (let x = x0; x <= x1; x += 1) {
        if (Math.abs(x - enemy.x) + Math.abs(y - enemy.y) > reach) continue;
        const i = y * s.w + x;
        if (visible && !visible.has(i)) continue;
        out.set(i, (out.get(i) ?? 0) + 1);
      }
    }
  }
  return out;
}

/**
 * 把"能被几个敌人打到"折成闪烁档位（1~5）。
 *
 * 界面不该为 1 和 2 写两套动画曲线——差一拍就够了。五档之后一律按最快档走，
 * 因为再快人眼也分不出来，只会变成一片乱闪。
 */
export function threatStep(count: number): number {
  if (count <= 0) return 0;
  return Math.min(5, Math.max(1, Math.trunc(count)));
}
