/**
 * 金刚不坏：体修的护体神通。
 *
 * ── 语义（2026-11-07 敲定）────────────────────────────────────────
 *
 * · 基础减免 30%；血越少越硬：跌破 75% / 50% / 25% 各上一档，最后四分之一血
 *   跳到 50%——"打不死的小强"要有个明确的翻盘点，而不是一条平滑的斜线。
 * · 只减**物理 + 魔法**那一段。真元不吃：引擎里真伤排在
 *   `DAMAGE_STAGE.damageTakenMul` 之后结算，这是既定的"以真破体"，
 *   所以炼气士和剑修天然是体修的克星，不需要额外写一条克制规则。
 * · 中毒、灼烧、自爆这类固定伤害根本不走伤害公式，自然也吃不到减免：
 *   炼体的硬抗刀枪，但怕毒火。
 *
 * ── 为什么放在伤害阶段而不是"受击后回血"────────────────────────
 *
 * 减伤必须是**纯函数**：`computeDamage` 会被 AI 的威胁圈、攻击预览反复调用，
 * 在这里读写 state 会把推演算脏（表现为 AI 莫名其妙地保守或送死）。
 * 所以它只读 hp / 生命上限，两个数都来自 `c.api`，不碰任何状态。
 */
import type { AbilityDef } from '../../abilities.ts';
import type { AbilityHooks } from '../../ability-hooks.ts';
import { DAMAGE_STAGE } from '../../ability-hooks.ts';

export const BODY_WARD_ID = 'body-ward';
export const BODY_WARD_LABEL = '金刚不坏';

/** 满血时的基础减免 */
export const BODY_WARD_BASE = 0.30;
/** 每跌破一档（剩余血量 75% / 50% / 25%）后的减免 */
export const BODY_WARD_TIERS = [0.30, 0.35, 0.40, 0.50] as const;

/**
 * 当前减免比例（纯函数，面板与结算共用一份）。
 *
 * 分档按**剩余**血量：>75% / >50% / >25% / 其余。
 * 取整交给调用方——面板显示百分比，结算用 `Math.round(dmg * (1 - pct))`。
 */
export function bodyWardPct(hp: number, maxHp: number): number {
  if (maxHp <= 0) return 0;
  const frac = hp / maxHp;
  if (frac > 0.75) return BODY_WARD_TIERS[0];
  if (frac > 0.5) return BODY_WARD_TIERS[1];
  if (frac > 0.25) return BODY_WARD_TIERS[2];
  return BODY_WARD_TIERS[3];
}

export const BODY_WARD: AbilityDef = {
  id: BODY_WARD_ID,
  name: BODY_WARD_LABEL,
  summary: `受到的伤害减免 ${Math.round(BODY_WARD_BASE * 100)}%，血量越低减免越高（剩四分之一血时 ${Math.round(
    BODY_WARD_TIERS[3] * 100,
  )}%）。真元与持续伤害不受影响。`,
  group: 'defense',
  hooks: {
    damage: [
      {
        stage: DAMAGE_STAGE.damageTakenMul,
        apply: (c) => {
          if (c.side !== 'defender') return;
          // 已经被护甲完全挡下的那一下保持 0：那不是"减免"，是根本没打穿
          if (c.damage <= 0) return;
          const maxHp = c.api.maxHpOf(c.state, c.self);
          const pct = bodyWardPct(c.self.hp, maxHp);
          if (pct <= 0) return;
          // 至少留 1 点：能被"完全免掉"的话，玩家会以为攻击没生效
          c.damage = Math.max(1, Math.round(c.damage * (1 - pct)));
        },
      },
    ],
  } satisfies AbilityHooks,
};
