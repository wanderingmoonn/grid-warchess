/**
 * 状态注册表：**扩展包也能用的那一层**。
 *
 * ── 为什么单独一个文件（2026-11-13）──────────────────────────
 *
 * 以前 `STATUS_REGISTRY` 和 `registerStatus` 都长在 `rules.ts` 里。可扩展包
 * **不能** import rules（rules → expansions → 扩展 → rules 是运行时环，
 * 见 ability-hooks.ts 顶部那三条纪律）。于是"状态"这条机制名义上对外开放、
 * 实际只有核心自己能注册：中毒、灼烧、诅咒这些实质上是奇想包的内容，
 * 只能写死在核心，关掉奇想之后它们还在，成为一批"没人用的核心代码"。
 *
 * 现在把注册表下沉到这一层：rules 从这里取，各个扩展也从这里取。
 *
 * 依赖方向是死的：`statuses.ts → types.ts`。
 * **本文件不许 import rules.ts，也不许 import 任何 -packs.ts。**
 *
 * ── 状态是什么、不是什么 ──────────────────────────────────
 *
 * 状态是"挂在单位身上的一个计数器 + 几条修正"：
 *   · `onTurnStart` 每回合结算一次（掉血、回血、写战报）；
 *   · `modifyMove/Armor/Atk/Vision` 在算属性时插一脚。
 *
 * 它**不负责**伤害公式，也不该自己改 `unit.hp`——扣血一律调
 * `StatusTickCtx.hurt`，那条路会走统一出口（转移、受伤钩子、清场）。
 */
import type { GameState, Unit } from './types.ts';

/**
 * 状态结算时的上下文。
 *
 * 为什么给一个 `hurt` 而不是让状态自己 `u.hp -= n`：状态掉血也是"扣血"，
 * 得走统一出口（伤害转移、受伤钩子、致死清场都挂在那一处）。但它同时是
 * **内生损耗**——中毒不该被守御阵挡下来，也不该触发"挨打反击"。
 * 这条语义只有一处定义（`hurtUnit` 的 `attrition`），状态这边只管调用。
 *
 * 换句话说：谁写状态、谁都不用再想"要不要减甲、要不要转移"。
 */
export interface StatusTickCtx {
  state: GameState;
  unit: Unit;
  /** 这个状态现在的层数 / 剩余回合 */
  val: number;
  /**
   * 扣血（内生损耗：不吃护甲、不转移、不触发受伤钩子）。
   *
   * **不写战报**：`onTurnStart` 返回的那行字符串才是战报。
   * 这里也写一遍的话，一条「中毒掉 6 点」会在日志里出现两次。
   * 返回实际扣掉的血（可能为 0）。
   */
  hurt(amount: number): number;
  /** 这个单位此刻的生命上限（含境界加成、衰老等修正） */
  maxHpOf(unit: Unit): number;
  /** 兵种定义（状态要写"谁中毒了"，就得拿得到名字） */
  utypeOf(typeId: string): { name: string; armor?: number; weak?: Partial<Record<string, number>> };
}

export interface StatusDef {
  id: string;
  name: string;
  summary: string;

  /**
   * 回合开始时的结算（比如掉血、回血）。
   * 返回字符串则写入战报，返回 null 表示不写。
   * 要扣血就调 `c.hurt(...)`，别自己改 `unit.hp`。
   */
  onTurnStart?: (c: StatusTickCtx) => string | null;

  /** 修正移动力 */
  modifyMove?: (s: GameState, u: Unit, val: number, move: number) => number;

  /** 修正护甲 */
  modifyArmor?: (s: GameState, u: Unit, val: number, armor: number) => number;

  /** 修正攻击力（可以留给未来的面板和使用，目前先挂着） */
  modifyAtk?: (s: GameState, u: Unit, val: number, atk: number) => number;

  /** 修正视野 */
  modifyVision?: (s: GameState, u: Unit, val: number, vision: number) => number;
}

/** 全部已注册状态。键就是 `unit.status` 里的那个键 */
export const STATUS_REGISTRY: Record<string, StatusDef> = {};

/**
 * 注册一个状态。模加载时调用（和技能/能力同一套副作用约定）。
 *
 * 重复注册会当场抛错，而不是覆盖：两个包都想注册「中毒」时，
 * 静默覆盖会让先注册的那个包的行为凭空气消失，查起来比崩一次难得多。
 */
export function registerStatus(def: StatusDef): void {
  if (Object.prototype.hasOwnProperty.call(STATUS_REGISTRY, def.id)) {
    throw new Error(`状态「${def.id}」已经注册过了`);
  }
  STATUS_REGISTRY[def.id] = def;
}
