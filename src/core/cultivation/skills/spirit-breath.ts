/**
 * 吐纳术：把脚下的环境灵气按比例炼成修为。
 *
 * ── 它要回答的问题（2026-11-13）──────────────────────────
 *
 * 修士的强度全押在境界上，而境界只能靠"每回合 +境界"的打坐慢慢磨。
 * 这条法术给了另一条路：**把地图上的灵气变成修为**。
 * 于是"洞府选在哪"第一次变成了一个真问题——灵田、灵泉、高山，吐纳出来的量差好几倍。
 *
 * ── 三条边界（写在这里，免得以后有人"顺手"改掉）──────────
 *
 * 1. **和灵力抢同一格**。灵气既是灵力的来源，也是修为的来源。吐纳抽掉的
 *    就是修士下一回合要吸的那口——想练级就别想连放法术。这是有意的张力，
 *    不是平衡漏洞。
 * 2. **按比例抽，不是按固定值抽**。抽一半意味着同一格连抽两次是 50 → 25 → 12，
 *    收益自己就衰减完了，不用额外写"每回合一次"的限制。
 *    也正因为这样它才敢开 `multiCast`（见下面 SkillDef 的注释）。
 * 3. **不看敌我**。灵气是天地之气（和「灵气滋养」同一个口径），
 *    所以吐纳天然也是"抽干对方灵力"的手段。这条会带来打法，先留着。
 *
 * ⚠️ 红线：本文件不许 import `../units.ts`（见 sky-step.ts 顶部）。
 */
import type { SkillDef } from '../../types.ts';
import { registerSkillEffect, registerSkillReadyCheck } from '../../skill-hooks.ts';
import { addExp, getRank } from '../progression.ts';
import { canSpendMana, manaOf, spendMana } from '../mana.ts';
import { drainQiAt, qiAt } from '../qi-field.ts';

// ── 数值 ──────────────────────────────────────────
/** 施放一次要多少灵力 */
export const SPIRIT_BREATH_COST = 20;
/** 抽走脚下格子的多少比例（一半） */
export const SPIRIT_BREATH_DRAIN = 0.5;
/** 多少点灵气换 1 点修为 */
export const SPIRIT_BREATH_QI_PER_EXP = 2;
/** 灵气低于这个数就不值得吐纳（蹲在空地上会一直弹"灵气太薄"） */
export const SPIRIT_BREATH_MIN_QI = 20;
/**
 * 单次修为上限 = 境界 × 这个数。
 *
 * 为什么高低境界要不一样：灵气浓度封顶 100，抽一半就是 50，按 2:1 折是 25 点。
 * 如果低境界也照拿 25 点，筑基（打坐 4/回合）一口就顶六回合——吐纳会变成
 * "早期刷级神器"，而高境界反而看不上它。按境界设上限之后，
 * 2 期只能拿 8 点（约两回合打坐），6 期才拿满 24 点，收益跟境界一起长。
 *
 * 附带的好处：低境界抽的灵气也少（只需要 16 点就够 8 点修为），
 * 不会一脚把灵田踩干、把下一回合的灵力也一起断掉。
 */
export const SPIRIT_BREATH_EXP_PER_RANK = 4;
/** 保底上限：万一有人靠秘籍在 0~1 期学到，也不至于一点修为都换不出来 */
export const SPIRIT_BREATH_EXP_FLOOR = 4;

/** 这一口最多能换多少修为（0~1 期 4 点，6 期 24 点，9 期 36 点） */
export function spiritBreathCap(rank: number): number {
  return Math.max(SPIRIT_BREATH_EXP_FLOOR, Math.max(0, rank) * SPIRIT_BREATH_EXP_PER_RANK);
}

/**
 * 这一次吐纳能换到多少修为（纯函数，面板与结算共用）。
 * `qi` = 脚下格子的浓度。
 *
 * 取整用 **floor** 不用 ceil：ceil 会让"50 点灵气"算出 26 点修为，
 * 而 26×2 = 52 > 50——账面上抽的比格子里有的还多，还得再夹一次。
 * floor 天然满足 `修为 × 每点修为的灵气 ≤ 抽走的灵气`，结局是"抽掉 24 而不是 25"，
 * 但玩家拿计算器一按是平的：抽走 24 点，得 12 点修为。
 */
export function spiritBreathExp(qi: number, rank: number): number {
  if (qi < SPIRIT_BREATH_MIN_QI) return 0;
  const take = Math.floor(qi * SPIRIT_BREATH_DRAIN);
  return Math.min(spiritBreathCap(rank), Math.floor(take / SPIRIT_BREATH_QI_PER_EXP));
}

// ── 数据 ──────────────────────────────────────────
export const SPIRIT_BREATH_SKILL: SkillDef = {
  id: 'spirit-breath',
  name: '吐纳术',
  summary:
    `抽走脚下 ${Math.round(SPIRIT_BREATH_DRAIN * 100)}% 的环境灵气，每 ${SPIRIT_BREATH_QI_PER_EXP} 点换 1 点修为` +
    `（单次上限 ${SPIRIT_BREATH_EXP_PER_RANK} × 境界）；耗 ${SPIRIT_BREATH_COST} 灵力。`,
  effect: 'spirit-breath',
  cooldown: 0,
  /*
   * 开连放，但不另外写"每回合一次"：抽一半的写法自带衰减
   * （100 → 50 → 25 → 12），连抽第三下已经换不到 2 点修为。
   *
   * 另一个理由是 `skillTurn` 是**整个单位**共用的（见 rules 的 doHeroSkill）：
   * 写成 `multiCast: false`，这一回合吐纳过就再也放不了别的非连发法术了。
   */
  multiCast: true,
  // 不需要选点：抽的是自己脚下这一格
  targeting: 'none',
};

// ── 实现 ──────────────────────────────────────────
registerSkillReadyCheck('spirit-breath', (s, u) => {
  if (!canSpendMana(u, SPIRIT_BREATH_COST)) {
    return `灵力不足（${manaOf(u)} / ${SPIRIT_BREATH_COST}）`;
  }
  if (spiritBreathExp(qiAt(s, u.x, u.y), getRank(u)) <= 0) {
    return `这里灵气太薄（脚下 ${Math.floor(qiAt(s, u.x, u.y))}，要 ${SPIRIT_BREATH_MIN_QI} 以上）`;
  }
  return true;
});

registerSkillEffect('spirit-breath', (c) => {
  const s = c.state;
  const self = c.self;
  const rank = getRank(self);

  const qi = qiAt(s, self.x, self.y);
  const exp = spiritBreathExp(qi, rank);
  if (exp <= 0) {
    c.result.ok = false;
    c.result.reason = `这里灵气太薄（脚下 ${Math.floor(qi)}，要 ${SPIRIT_BREATH_MIN_QI} 以上）`;
    return;
  }
  if (!spendMana(self, SPIRIT_BREATH_COST)) {
    c.result.ok = false;
    c.result.reason = `灵力不足（需要 ${SPIRIT_BREATH_COST} 点）`;
    return;
  }

  /*
   * 先算出"这一口换多少修为"，再倒推要抽多少灵气。
   *
   * 反过来写（先抽一半、再折算）会有两个坑：上限截断时白抽了一截灵气；
   * 而取整会让"抽掉的灵气"和"得到的修为"对不上账。倒推能保证
   * 「抽掉的灵气 = 修为 × 每点修为的灵气」，玩家拿计算器一按就是平的。
   */
  const need = exp * SPIRIT_BREATH_QI_PER_EXP;
  const drained = drainQiAt(s, self.x, self.y, need / qi);
  addExp(self, s, exp);

  const name = c.api.utype(s, self.type).name;
  c.result.log =
    `${name}吐纳，抽走脚下 ${drained} 点灵气，得修为 ${exp} 点` +
    `（耗 ${SPIRIT_BREATH_COST} 灵力）`;
  c.api.noteHeat(s, self.x, self.y);
});
