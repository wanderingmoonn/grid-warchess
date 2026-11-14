/**
 * 护盾（不是召唤物）：一层有**自己的护甲和血量**的外壳。
 *
 * ── 作者的原话（2026-11-14）──────────────────────────────────────
 *
 * "一个护盾，不是生成了一个单位，有自己的护甲和血量，打烂之后顺带把那一次
 *  攻击溢出的伤害吃掉。"
 *
 * 所以它和族 8（召唤）不是一回事：场上不会多一个能点、能挡路、能被打死的单位。
 * 它挂在施法者身上，作为一个**先行结算的血条**。
 *
 * ── 三件事怎么实现对 ────────────────────────────────────────────
 *
 *   1. **自己的护甲**：走 `modifyArmor` 钩子往上加。所以物理攻击会按"单位甲 + 盾甲"
 *      算；法术无视护甲，也就无视盾甲——这条和法术本来的口径一致。
 *   2. **自己的血量**：走核心的 `absorbDamage` 钩子。它在 `hurtUnit` 里、
 *      扣真血之前被调用，返回"吸收了多少点"，引擎从伤害里扣掉。
 *   3. **碎盾那一击的溢出被吃掉**：吸收量直接取满 `amount`，盾血清零、盾消失。
 *      这一击不会穿透到本体——这是作者明确要的手感（"打烂之后顺带把溢出吃掉"）。
 *
 * ── 为什么用状态来管时长 ────────────────────────────────────────
 *
 * 盾的数值放 `Unit.custom.shield`，但**是否生效**看状态 `spell-shield`：
 * 状态到期，钩子就读不到盾，等于自动消散。这样不用在回合切换、死亡、驱散
 * 三四处各写一遍清理。
 *
 * ⚠️ 红线：本文件不许 import `../units.ts`（见 sky-step.ts 顶部）。
 */
import { registerStatus } from '../../statuses.ts';
import type { Unit } from '../../types.ts';
import { registerSkillEffect } from '../../skill-hooks.ts';
import { getRank } from '../progression.ts';
import {
  defineSpellSkill,
  paySpellCost,
  registerManaReady,
  registerPreview,
  spellCustom,
  type SpellRow,
} from '../spell-kernel.ts';

// ── 状态 ──────────────────────────────────────────
export const SHIELD_STATUS = 'spell-shield';

registerStatus({
  id: SHIELD_STATUS,
  name: '护体灵光',
  summary: '身上有一层护盾，先替自己挨打',
});

/** 护盾的数值。`hp` 会随着吸收而减少 */
export interface Shield {
  hp: number;
  maxHp: number;
  armor: number;
}

/** 此刻生效的护盾（状态没挂上就是没有——到期自动失效，不需要清理代码） */
export function shieldOf(u: Unit): Shield | undefined {
  if (((u.status?.[SHIELD_STATUS] ?? 0) as number) <= 0) return undefined;
  const sh = u.custom?.['shield'] as Shield | undefined;
  return sh && sh.hp > 0 ? sh : undefined;
}

/** 挂一层盾。回合数走状态（和族 6 的加持同一个口径：不 +1，当场生效） */
export function putShield(u: Unit, sh: Shield, rounds: number): void {
  u.status ??= {};
  u.status[SHIELD_STATUS] = Math.max(u.status[SHIELD_STATUS] ?? 0, rounds);
  u.custom = { ...(u.custom ?? {}), shield: sh };
}

/** 盾碎了：连状态一起摘掉，钩子立刻读不到它 */
export function breakShield(u: Unit): void {
  if (u.status) u.status[SHIELD_STATUS] = 0;
  if (u.custom) {
    const rest = { ...u.custom };
    delete rest['shield'];
    u.custom = rest;
  }
}

// ── 参数与数据行 ──────────────────────────────────
export interface ShieldParams extends Record<string, unknown> {
  /** 基础盾血 */
  hp: number;
  /** 每层境界加多少盾血 */
  hpPerRank: number;
  /** 盾自己的护甲 */
  armor: number;
  /** 每层境界加多少盾甲 */
  armorPerRank: number;
  /** 持续几个自己的回合 */
  rounds: number;
}

export const HU_TI_LING_GUANG_COST = 60;
export const HU_TI_LING_GUANG_MIN_RANK = 2;
export const HU_TI_LING_GUANG_HP = 30;
export const HU_TI_LING_GUANG_HP_PER_RANK = 10;
export const HU_TI_LING_GUANG_ARMOR = 4;
export const HU_TI_LING_GUANG_ROUNDS = 3;

const HU_TI_LING_GUANG: SpellRow = {
  id: 'hu-ti-ling-guang',
  name: '护体灵光',
  summary:
    `在身外罩一层护盾：${HU_TI_LING_GUANG_HP} + 境界×${HU_TI_LING_GUANG_HP_PER_RANK} 点盾血、` +
    `额外 ${HU_TI_LING_GUANG_ARMOR} 点护甲，持续 ${HU_TI_LING_GUANG_ROUNDS} 回合；` +
    '盾碎的那一击溢出的伤害也会被吃掉，不会穿透到本体；耗 60 灵力。',
  effect: 'shield',
  cost: HU_TI_LING_GUANG_COST,
  range: 0,
  preview: 'ring',
  targeting: 'none',
  custom: {
    hp: HU_TI_LING_GUANG_HP,
    hpPerRank: HU_TI_LING_GUANG_HP_PER_RANK,
    armor: HU_TI_LING_GUANG_ARMOR,
    armorPerRank: 0,
    rounds: HU_TI_LING_GUANG_ROUNDS,
  } satisfies ShieldParams,
};

export const SHIELD_ROWS: readonly SpellRow[] = [HU_TI_LING_GUANG];
export const HU_TI_LING_GUANG_SKILL = defineSpellSkill(HU_TI_LING_GUANG);

registerManaReady(SHIELD_ROWS);
registerPreview(SHIELD_ROWS);

// ── 实现 ──────────────────────────────────────────
registerSkillEffect('shield', (c) => {
  const p = spellCustom<ShieldParams>(c);
  const s = c.state;
  const self = c.self;
  const cost = Number(p.spellCost);
  const skillName = (c.skill as { name?: string } | undefined)?.name ?? '法术';
  const name = c.api.utype(s, self.type).name;

  if (!paySpellCost(c, cost)) {
    c.result.ok = false;
    c.result.reason = `灵力不足（需要 ${cost} 点）`;
    return;
  }

  const rank = getRank(self);
  const hp = p.hp + p.hpPerRank * rank;
  const armor = p.armor + p.armorPerRank * rank;
  putShield(self, { hp, maxHp: hp, armor }, Number(p.rounds ?? 1));

  c.result.log =
    `${name}施放${skillName}：护盾 ${hp} 点血 / ${armor} 点甲，持续 ${p.rounds} 回合（耗 ${cost} 灵力）`;
});
