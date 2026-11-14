/**
 * 掌心雷：法术池里的第一条样板法术，现在也是族 1（直伤）里的第一行数据。
 *
 * ── 它要验证的四件事 ────────────────────────────────────
 *
 * 1. **法术 ≠ 技能**：它不在兵种表上、不随境界领悟，只能去藏经阁学；
 *    学来之后躺在 `extraSkills` 里，和天赋技能共用同一套按钮与释放流程。
 * 2. **吃灵力**：每一发都从自己的灵力池里扣（见 mana.ts），扣不起按钮就是灰的。
 * 3. **无视护甲**：走 `api.hurt`（唯一扣血出口），不经过 `computeDamage` 的护甲段。
 *    所以它对重甲兵特别狠——这正是法术和普攻最干净的分界。
 * 4. **不限每回合一次**：节拍交给灵力池（见下面 `multiCast` 那段）。
 *
 * ── 数值是占位，别当成定稿 ────────────────────────────
 *
 * 伤害 `6 + 3 × 境界`：2 期 12 点、6 期 24 点。同代民兵 13 攻打 2 甲还剩 11，
 * 所以它在低境界是"一发换掉半个兵"，高境界反而被普攻追上——这是有意的：
 * 法术的价值在"无视护甲 + 不还手"，不在数值膨胀。
 *
 * ── 它的实现已经搬走了 ────────────────────────────────
 *
 * P0 把校验/扣灵力/高亮搬进了 `spell-kernel.ts`；P1 把"打中了发生什么"
 * 搬进了 `skills/bolt.ts`（和灭神枪、元磁神光、五雷正法共用一份）。
 * 这个文件现在只剩**数值 + 一行数据**——这正是这套结构的验收标准：
 * 一门法术的"个性"缩到一行，共性全在族里。
 *
 * ⚠️ 红线：本文件不许 import `../units.ts`（见 sky-step.ts 顶部）。
 */
import { defineSpellSkill, registerManaReady, registerPreview, type SpellRow } from '../spell-kernel.ts';
import type { BoltParams } from './bolt.ts';

// ── 数值 ──────────────────────────────────────────
/** 施放一次要多少灵力（设计上全部乘 10，见 mana.ts） */
export const PALM_THUNDER_COST = 50;
/** 基础伤害 */
export const PALM_THUNDER_BASE = 6;
/** 每层境界加多少伤害 */
export const PALM_THUNDER_PER_RANK = 3;
/** 射程（格） */
export const PALM_THUNDER_RANGE = 3;

/** 这一发打多少（面板和规则共用同一份算式；和族里的算法是同一个） */
export function palmThunderDamage(rank: number): number {
  return PALM_THUNDER_BASE + PALM_THUNDER_PER_RANK * Math.max(0, rank);
}

// ── 数据 ──────────────────────────────────────────
const ROW: SpellRow = {
  id: 'palm-thunder',
  name: '掌心雷',
  summary:
    `射程 ${PALM_THUNDER_RANGE} 格，对一名敌人造成 ${PALM_THUNDER_BASE} + 境界×${PALM_THUNDER_PER_RANK} 点伤害（无视护甲）；` +
    `耗 ${PALM_THUNDER_COST} 灵力。`,
  // 走族 1 的实现：它和灭神枪、元磁神光、五雷正法共用同一份代码
  effect: 'bolt',
  cost: PALM_THUNDER_COST,
  range: PALM_THUNDER_RANGE,
  // 单体法术亮"我够得着哪一圈"；不按落点算，否则鼠标一动高亮就碎
  preview: 'ring',
  /*
   * **不限每回合一次**：节拍交给灵力池来管。
   * 一个 9 期修士一回合能连放两发（130 点上限、每发 50），0 期连一发都攒不齐——
   * "什么时候烧掉这池子"本身就是一个决定，比"一回合只能放一次"有意思得多。
   */
  multiCast: true,
  custom: {
    base: PALM_THUNDER_BASE,
    perRank: PALM_THUNDER_PER_RANK,
  } satisfies BoltParams,
};

export const PALM_THUNDER_SKILL = defineSpellSkill(ROW);

registerManaReady([ROW]);
registerPreview([ROW]);
