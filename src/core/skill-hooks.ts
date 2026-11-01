// src/core/skill-hooks.ts
import type { GameState, Unit } from './types.ts';
import type { AbilityApi } from './ability-hooks.ts';

export interface SkillCtx {
  state: GameState;
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