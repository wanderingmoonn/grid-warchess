/**
 * 单兵 AI 注册表：把各扩展的 `Expansion.unitAi` 合并成一张按 id 查的表。
 *
 * 和 `ability-registry.ts` / `mark-registry.ts` 同一个模式：**这里只做"合并与查询"**，
 * 不放实现。实现跟着扩展走（谁家的兵谁家管），引擎（ai.ts）只认这张表。
 *
 * 为什么不看"这一局勾了哪些扩展"：和兵种能力同一条理由——行为是内容的一部分。
 * 真要按扩展过滤，那是规则层的事；放进注册表的话，存档里一个 boss 在被关掉扩展
 * 之后会变成"血很厚的杂兵"，而且查不出为什么。
 *
 * ── 默认值的纪律 ──────────────────────────────────────────────────
 *
 * `aiAutonomy` 不写 = 0 = **完全不问扩展**。这一条是硬要求：任何兵种默认有自主分，
 * 都会改变现有对局的行为，208 场跑批基线会整批作废，而且没人能一眼看出为什么。
 * 所以 `unitAiOf` 在 autonomy ≤ 0 时**连表都不查**，直接返回 null。
 */

import { EXPANSIONS } from './expansions.ts';
import type { UnitAiProfile } from './expansions.ts';
import type { Action, GameState, Unit } from './types.ts';

const REGISTRY = new Map<string, UnitAiProfile>();

/**
 * 注册一个行为表。
 *
 * 重复 id **直接抛错**，不做"后来者覆盖"：那会变成"开了某个包，boss 换了个脑子"，
 * 玩家永远查不清自己漏了什么（和核心能力表同一条理由）。
 */
export function registerUnitAiProfile(p: UnitAiProfile): void {
  if (REGISTRY.has(p.id)) throw new Error(`单兵 AI profile 重复注册：${p.id}`);
  REGISTRY.set(p.id, p);
}

for (const e of EXPANSIONS) {
  for (const p of e.unitAi ?? []) registerUnitAiProfile(p);
}

export function allUnitAiProfiles(): UnitAiProfile[] {
  return [...REGISTRY.values()];
}

export function unitAiProfileOf(id: string): UnitAiProfile | null {
  return REGISTRY.get(id) ?? null;
}

/**
 * 只警告一次。
 *
 * 这类问题（兵种写了名字、包里没注册）会**每一步**都遇到——AI 一回合要问几十次。
 * 每步刷一屏日志的结果是没人看，所以按 key 去重。
 */
const warned = new Set<string>();
export function unitAiWarn(key: string, text: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(text);
}

/** 测试用：清掉"只警告一次"的记录（正式流程不需要） */
export function resetUnitAiWarnings(): void {
  warned.clear();
}

export interface UnitAiBinding {
  profile: UnitAiProfile;
  /** 0~1，已经夹过 */
  autonomy: number;
}

/**
 * 这个兵现在该不该问扩展。返回 null = 不问，**行为和现在完全一样**。
 *
 * 四种返回 null 的情况：兵种表里没有它、没写 `aiProfile`、自主分 ≤ 0、
 * 写了名字但注册表里查不到（会告警一次）。
 */
export function unitAiOf(s: GameState, unit: Unit): UnitAiBinding | null {
  const def = s.unitTypes[unit.type];
  if (!def) return null;
  const id = def.aiProfile;
  if (!id) return null;
  const autonomy = Math.min(1, Math.max(0, def.aiAutonomy ?? 0));
  if (autonomy <= 0) return null;
  const profile = REGISTRY.get(id);
  if (!profile) {
    unitAiWarn(
      `missing:${id}`,
      `[unit-ai] 兵种「${def.name}」写了 aiProfile='${id}'，但没有扩展注册它` +
        `——按"没有自主行为"处理（这局它和普通兵一样）。`,
    );
    return null;
  }
  return { profile, autonomy };
}

/**
 * 单兵动作白名单。
 *
 * 只放"这个兵自己能做"的事。招募、升级、结束回合、改策略这些**席位级**的东西
 * 一律拒绝——让单兵 AI 能造兵，等于绕过整套招募规划（编制、省钱、换血、时代取舍），
 * 一定会出现"某个兵自作主张把钱花光"。
 */
const ALLOWED_ACTIONS = new Set<string>([
  'MOVE',
  'ATTACK',
  'SIEGE',
  'HERO_SKILL',
  'USE_DEVICE',
  'MOUNT',
  'UNMOUNT',
  'LOAD',
  'UNLOAD',
  'LAUNCH',
  'RECOVER',
  'RECHARGE',
  'BUILD',
]);

/**
 * `must` 的固定分。
 *
 * 沿用代码里已有的量级（英雄技能 +300、指挥官指定升级 +1000），保证它压得住
 * 一次普攻、也压得住"造个兵"。为什么不写成"很高很大的数"：分差太大的话，
 * 多条 must 之间、must 与深推之间会失去可比性，调试时看不出排名。
 */
export const UNIT_AI_MUST_SCORE = 1000;

/**
 * 校验扩展提的动作。返回字符串 = 不许，字符串是给日志的理由。
 *
 * 三条：类型在白名单里、`unitId` 必须是这个兵（不能替别的兵做决定）、`type` 不能缺。
 * **越界/冷却/距离这类合法性不在这里查**——那些交给规则层拒，扩展自己该先查一遍
 * （被拒不会崩，但会白耗一步）。
 */
export function unitAiActionProblem(action: Action, unitId: string): string | null {
  const type = (action as { type?: string }).type;
  if (!type) return '动作没有 type';
  if (!ALLOWED_ACTIONS.has(type)) return `不允许的单兵动作：${type}`;
  const id = (action as { unitId?: string }).unitId;
  if (id !== unitId) return `动作指向的不是这个兵（${String(id)} ≠ ${unitId}）`;
  return null;
}
