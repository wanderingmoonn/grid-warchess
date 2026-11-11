// src/core/skill-hooks.ts
import type { GameState, Unit } from './types.ts';
import type { AbilityApi } from './ability-hooks.ts';

export interface SkillCtx {
  state: GameState;
  /**
   * **施法者所在那张图**的只读视角。查格子一律用它，别用 `state`：
   * `state.tiles` 永远是地球的，在月面上选点会选到"地球上同一坐标"。
   * 改状态（生成、扣血、写战报）仍然用 `state`。
   */
  view: GameState;
  self: Unit;
  skill: any; // 这里建议换成 import type { SkillDef } from './types.ts' 如果 types.ts 定义了的话
  /** 提供给技能引擎工具（比如算伤害、算溅射） */
  api: AbilityApi;
  /** 如果 UI 传了目标坐标 */
  target?: { x: number; y: number };
  result: {
    ok: boolean;
    reason?: string;
    log?: string;
  };
}

export type SkillHandler = (c: SkillCtx) => void;

export const SKILL_EFFECTS: Record<string, SkillHandler> = {};

export function registerSkillEffect(id: string, handler: SkillHandler): void {
  if (Object.prototype.hasOwnProperty.call(SKILL_EFFECTS, id)) {
    throw new Error(`技能效果「${id}」已经注册过了`);
  }
  SKILL_EFFECTS[id] = handler;
}

/** 技能就绪检查的注册表 */
export const SKILL_READY_CHECKS: Record<string, (s: GameState, u: Unit, api?: AbilityApi) => boolean | string> = {};

export function registerSkillReadyCheck(id: string, check: (s: GameState, u: Unit, api?: AbilityApi) => boolean | string): void {
  SKILL_READY_CHECKS[id] = check;
}

export interface SkillPreviewCtx {
  state: GameState;
  /**
   * **施法者所在那张图**的只读视角。查格子一律用它，别用 `state`：
   * `state.tiles` 永远是地球的，在月面上选点会选到"地球上同一坐标"。
   * 改状态（生成、扣血、写战报）仍然用 `state`。
   */
  view: GameState;
  self: Unit;
  /** 玩家瞄准的落点或方向格 */
  target: { x: number; y: number };
}

/** 返回这个技能打向 target 时，会波及的所有格子索引 (y * w + x) */
export type SkillPreviewer = (c: SkillPreviewCtx) => number[];

export const SKILL_PREVIEWERS: Record<string, SkillPreviewer> = {};

export function registerSkillPreview(id: string, previewer: SkillPreviewer): void {
  SKILL_PREVIEWERS[id] = previewer;
}

/**
 * "选点类技能"（`targeting: 'point'`）里，玩家**能点**的格子。
 *
 * key 是**效果 id**（`skill.effect`），不是技能 id：同一个效果可能挂在好几个
 * 单位身上，界面不该认得具体是谁的技能。
 *
 * 为什么由规则层提供而不是界面自己算：
 * 高亮的格子必须和"点下去会不会被判失败"是同一套判断，否则就会出现
 * 最常见的那个 bug——"高亮成能点，点下去回一句'这里不行'"。
 *
 * 返回空数组 = 现在没有任何合法落点（界面照常进瞄准模式，点哪都会失败，
 * 但至少不会高亮出一片假的可选格）。
 */
export type SkillTargetCells = (c: {
  state: GameState;
  /**
   * **施法者所在那张图**的只读视角。查格子一律用它，别用 `state`：
   * `state.tiles` 永远是地球的，在月面上选点会选到"地球上同一坐标"。
   * 改状态（生成、扣血、写战报）仍然用 `state`。
   */
  view: GameState;
  self: Unit;
  skill: any;
}) => Array<{ x: number; y: number }>;

export const SKILL_TARGET_CELLS: Record<string, SkillTargetCells> = {};

export function registerSkillTargetCells(effect: string, fn: SkillTargetCells): void {
  SKILL_TARGET_CELLS[effect] = fn;
}