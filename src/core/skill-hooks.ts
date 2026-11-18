// src/core/skill-hooks.ts
import type { BoardId, GameState, Unit, UnitTypeDef, SkillDef } from './types.ts';
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
  /** 玩家在界面上填的那个值（`SkillDef.input` 声明要填时才可能有） */
  input?: string;
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

/* ══════════════════════════════════════════════════════════════════
 * 「这个技能什么时候值得放」——技能自带的 AI 提示
 *
 * 为什么需要：以前 AI 判断"技能该不该放"是一串写死在 `ai.ts` 里的
 * `case '效果名'`。那意味着**引擎认识具体内容**——每加一个英雄技能就得回
 * 核心改一处；更糟的是扩展的技能（比如修真的法术）AI 根本不认识，
 * 配上去等于没配。
 *
 * 现在换过来：技能效果在哪个包里，就由那个包顺手声明一句"什么条件下该放、
 * 值多少分"。核心只负责问，然后照常比较分数。
 *
 * ── 和 `Expansion.unitAi` 的分工（别搞混） ────────────────────────
 *
 *   · `unitAi`：管**一整个兵这一回合的行为**，能给走位、能提别的动作、
 *     能标"必须做"。要兵种写 `aiAutonomy > 0` 才生效。
 *   · 这里：只管**单个技能放不放**，只能给分数（和可选落点）。
 *     对所有会技能的兵生效，不需要开自主分。
 *
 * 一句话：unitAi 管剧本，这里管常识。普通英雄该走常识这条路——
 * 给它们开自主分等于让每个兵各打各的，协同就散了。
 * ══════════════════════════════════════════════════════════════════ */

export interface SkillAiCtx {
  /**
   * 施法者视角的**雾图**（`playerView` 的结果）。
   *
   * 和全局 AI 看到的完全一样多，不是真局。能看全图的话，
   * 技能就会去打玩家看不见的兵——一眼看出来在作弊，回放也对不上。
   */
  state: GameState;
  unit: Unit;
  def: UnitTypeDef;
  skill: SkillDef;
  /** 查询用的小工具（距离、站位、生命上限……）。**只查不改** */
  api: AbilityApi;
  /**
   * 核心已经筛好的"能打的敌人"：敌人席位里、还活着、且是战斗单位。
   *
   * 由核心给而不是让包自己筛，是为了**两处口径一致**：以前写死的那些 case
   * 用的就是这一份名单，包自己再筛一遍很容易差一点（漏掉"己方同盟"这类）。
   */
  foes: Unit[];
  /** 自己的血量比例（0~1），省得每个技能都算一遍 */
  hpRatio: number;
  /** 自己这边能看到的单位（含自己） */
  allies: Unit[];
}

/**
 * 提示的返回值。三种：
 *   · `null`（或 `false`）＝ 现在不值得放，跳过这个技能；
 *   · `数字` ＝ 值这么多分，落点交给规则层自动挑；
 *   · `{ score, x, y }` ＝ 值这么多分，**并且指定落点**（要选点的技能才用得上）。
 */
export type SkillAiHintResult = number | { score: number; x?: number; y?: number } | null;

export type SkillAiHint = (c: SkillAiCtx) => SkillAiHintResult;

export const SKILL_AI_HINTS: Record<string, SkillAiHint> = {};

/**
 * 注册一个技能的 AI 提示。key 是**效果 id**（`skill.effect`），不是技能 id。
 *
 * 重复注册直接抛错：和技能效果、单兵行为表同一条纪律——不许"开了某个包，
 * 同一个技能换了个脑子"，那种问题玩家永远查不清。
 */
export function registerSkillAi(effect: string, hint: SkillAiHint): void {
  if (Object.prototype.hasOwnProperty.call(SKILL_AI_HINTS, effect)) {
    throw new Error(`技能「${effect}」的 AI 提示已经注册过了`);
  }
  SKILL_AI_HINTS[effect] = hint;
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
}) =>
  | Array<{ x: number; y: number }>
  | {
      /**
       * 选点在哪张图。缺省 = 施法者所在的那张。
       *
       * 遥感模块是第一个用它的：站在轨道上，要选的是**脚下那颗星球表面**的格子。
       * 界面拿到这个字段会先把图切过去，再进瞄准模式——不这么做的话，
       * 玩家点的是地球表面，而 `aimTiles` 算的是空间站，一个都对不上。
       */
      board?: BoardId;
      cells: Array<{ x: number; y: number }>;
    };

export const SKILL_TARGET_CELLS: Record<string, SkillTargetCells> = {};

export function registerSkillTargetCells(effect: string, fn: SkillTargetCells): void {
  SKILL_TARGET_CELLS[effect] = fn;
}