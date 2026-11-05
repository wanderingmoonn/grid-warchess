//对 GameState / Unit / 坐标的纯查询：不改变状态、不调用扩展钩子、不依赖 rules.ts 的其他函数，只依赖 types.ts 和基础数据。

// query.ts
import type { GameState, Unit } from './types.ts';

// ── 几何 ──
export function idx(s: GameState, x: number, y: number): number {
  return y * s.w + x;
}

export function xyOf(s: GameState, i: number): { x: number; y: number } {
  return { x: i % s.w, y: Math.floor(i / s.w) };
}

export function inBounds(s: GameState, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < s.w && y < s.h;
}

/** 曼哈顿距离。移动和攻击统一用它，避免"能斜着打但斜着走不过去"的怪事。 */
export function distance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

// ── 单位状态 ──
/**
 * 这个单位还在施工吗（有建造点数的建筑）。
 *
 * 工地不是"半个建筑"：它挡路、能被打、看得见，但不能开火、不能产兵、不能动手。
 * 这样"塔要两回合才立起来"才是一个真实的窗口——对手看得见你在修，
 * 也有机会在它成型之前拆掉它。
 */
export function underConstruction(u: Unit): boolean {
  if ((u.buildNeed ?? 0) > 0) return (u.buildDone ?? 0) < (u.buildNeed ?? 0);
  // 旧存档的写法：只剩回合数
  return (u.buildLeft ?? 0) > 0;
}

// ── 占地：一格与多格 ──────────────────────────────────────────────────
//
// 单位/建筑以**左上角为锚点**占 n×n 格（n = 1 或 2）。为什么不做成
// "中心点 + 半径"：锚点语义下 `u.x/u.y` 只需要读一次，所有既有的
// 存档、AI 打分、渲染定位都不用改形状；而 2×2 的"中心"其实是 2.5 格，
// 半格坐标会污染每一个距离计算。
//
// 三件事必须一致，否则会出现"看着在这儿、规则说在那儿"：
//   1. 判定（unitAt / unitsAt / sameLayerAt / blockedFor）
//   2. 距离（distToUnit / distToUnitRect）
//   3. 落子（canStandAt / buildSiteError / 产兵位）

/** 占地边长：1（缺省）或 2。传单位或兵种 id 都行。 */
export function footprintOf(s: GameState, u: Unit | string): number {
  const type = typeof u === 'string' ? u : u.type;
  return s.unitTypes[type]?.footprint === 2 ? 2 : 1;
}

/** 这一格是不是被它占着。锚点左上，占 n×n。 */
export function coversTile(s: GameState, u: Unit, x: number, y: number): boolean {
  const n = footprintOf(s, u);
  return x >= u.x && x < u.x + n && y >= u.y && y < u.y + n;
}

/** 它占的那几格（渲染、存档校验、AI 打分都用得上） */
export function tilesOfUnit(s: GameState, u: Unit): Array<{ x: number; y: number }> {
  const n = footprintOf(s, u);
  const out: Array<{ x: number; y: number }> = [];
  for (let dy = 0; dy < n; dy++) {
    for (let dx = 0; dx < n; dx++) out.push({ x: u.x + dx, y: u.y + dy });
  }
  return out;
}

/**
 * 一个坐标到某个单位的距离：到它**覆盖范围**的最近一格。
 *
 * 打一座 2×2 的兵营，站在它右下角旁边就该是一格，而不是"到左上角三格"。
 * 距离只认锚点的话，大建筑会显得比它看起来更难打——玩家没法从画面推出射程。
 */
export function distToUnit(s: GameState, from: { x: number; y: number }, u: Unit): number {
  const n = footprintOf(s, u);
  const cx = Math.min(Math.max(from.x, u.x), u.x + n - 1);
  const cy = Math.min(Math.max(from.y, u.y), u.y + n - 1);
  return Math.abs(from.x - cx) + Math.abs(from.y - cy);
}

/** 两个单位之间的距离：两个矩形的最近距离（锚点对小单位等价于曼哈顿距离） */
export function distBetweenUnits(s: GameState, a: Unit, b: Unit): number {
  const na = footprintOf(s, a);
  const nb = footprintOf(s, b);
  const ax2 = a.x + na - 1;
  const ay2 = a.y + na - 1;
  const bx2 = b.x + nb - 1;
  const by2 = b.y + nb - 1;
  const dx = Math.max(0, Math.max(b.x - ax2, a.x - bx2));
  const dy = Math.max(0, Math.max(b.y - ay2, a.y - by2));
  return dx + dy;
}