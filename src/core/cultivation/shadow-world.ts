/**
 * 世界阴面（`shadow-world`）—— 照太空包"空间站建图"那套做的第二张图。
 *
 * ── 为什么直接借用多图机制，而不是"把单位藏起来" ────────────────
 *
 * 作者 2026-11-14 的原话：太空包里发射空间站就是**新建一张地图**，
 * 阴面照做即可。这一点很关键，因为"藏起来"和"不在场"是两件事：
 *   · `hideUnit` 只是不给看，单位**仍然挡寻路**，别人会绕过去；
 *   · 阴面是**真的在别处**——阳面那一格空出来了，可以走过去。
 *
 * 所以这里不做任何"隐藏"的花活：单位换一张图、坐标换一组，
 * 阳面就真的少了个人。所有跨图判定（视野、寻路、命中）本来就走
 * `boardIdOf` / `boardOf`，不用另写一套。
 *
 * ── 地形与伤害 ──────────────────────────────────────────────────
 *
 * 整张图只有一种地形：**阴影乱流**。它挡不住也藏不住（防御 0、视野修正 0），
 * 但每回合对格子上的单位造成真伤——阴面不是能久待的地方。
 *
 * ── 懒创建 ──────────────────────────────────────────────────────
 *
 * 这一局没人碰阴面之前**不建这张图**：多一张图就多一份渲染、存档和视野计算。
 * 任何涉及阴面的法术都先调 `ensureShadowWorld`，第一发把它建出来。
 *
 * ⚠️ 红线：本文件不许 import `../units.ts`。
 */
import type { BoardId, GameState, Tile, Unit } from '../types.ts';
import { coversTile } from '../query.ts';

export const SHADOW_BOARD: BoardId = 'shadow-world';
export const SHADOW_TERRAIN = 'shadow' as const;
/** 每回合被乱流撕掉多少（真伤，不吃护甲） */
export const SHADOW_DAMAGE = 6;

/** 这张图建过没有 */
export function hasShadowWorld(s: GameState): boolean {
  return !!s.boards?.[SHADOW_BOARD];
}

/**
 * 没有就建一张。返回阴面的 id。
 *
 * 尺寸跟**地球**一模一样（`s.w × s.h`）：作者要的就是"阳面多大它多大"。
 * 全图铺 `shadow`，没有城市、没有资源点——阴面本来就不产东西。
 */
export function ensureShadowWorld(s: GameState): BoardId {
  if (s.boards?.[SHADOW_BOARD]) return SHADOW_BOARD;
  const tiles: Tile[] = [];
  for (let i = 0; i < s.w * s.h; i++) {
    tiles.push({ terrain: SHADOW_TERRAIN, cityId: null });
  }
  s.boards = {
    ...(s.boards ?? {}),
    [SHADOW_BOARD]: {
      id: SHADOW_BOARD,
      kind: 'shadow',
      name: '世界阴面',
      w: s.w,
      h: s.h,
      tiles,
    },
  };
  return SHADOW_BOARD;
}

/** 在阴面上找一格空地（从左上往右下扫，够用就行） */
export function freeShadowSpot(s: GameState): { x: number; y: number } | null {
  ensureShadowWorld(s);
  const b = s.boards![SHADOW_BOARD]!;
  for (let y = 0; y < b.h; y++) {
    for (let x = 0; x < b.w; x++) {
      const occupied = s.units.some(
        (u) => u.hp > 0 && (u.board ?? 'earth') === SHADOW_BOARD && coversTile(s, u, x, y),
      );
      if (!occupied) return { x, y };
    }
  }
  return null;
}

/** 这个单位是不是在阴面上 */
export function isInShadow(u: Unit): boolean {
  return (u.board ?? 'earth') === SHADOW_BOARD;
}

/** 被放逐的记录：怎么回去、什么时候回去 */
export interface BanishMark {
  turns: number;
  /** 原来在哪（回去时优先回原位，被占了就找空地） */
  board: BoardId;
  x: number;
  y: number;
}

export const BANISH_KEY = 'banished';
