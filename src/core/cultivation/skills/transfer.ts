/**
 * 张冠李戴（簇 D · 效果转移）。
 *
 * ── 一句话 ──────────────────────────────────────────────────────
 *
 * 找一个替身，之后**冲着施法者来的一切**都落到替身头上。
 * 状态与读取口径在 `../transfer.ts`（骨架要读，不能反过来依赖 skills）。
 *
 * ── "一切"是怎么做到全覆盖的 ────────────────────────────────────
 *
 * 只改了**两个入口**，因为游戏里所有"以某人为目标"的效果都从这两处进：
 *
 *   1. `resolveCast`（单体/范围法术挑完目标之后）——在这里把 victim 换成替身，
 *      于是定身、麻痹、拉拽、转化、处决全部跟着转；
 *   2. `redirectDamage`（伤害落地之前）——攻击、地雷、反伤都走这里。
 *
 * 作者 2026-11-14 的原话就是"直接改传入的 victim"，所以没有另造一套
 * "影响类型"的枚举：那会把"什么算影响"变成一张永远不完整的清单。
 *
 * 不覆盖的只有**本来就没有目标**的全局效果（天下皆白、绝地天通那种改规则的），
 * 它们没有 victim 可换，也就无从转移。
 *
 * ⚠️ 红线：本文件不许 import `../units.ts`。
 */
import { registerSkillEffect } from '../../skill-hooks.ts';
import { setDai } from '../transfer.ts';
import {
  defineSpellSkill,
  registerManaReady,
  registerPreview,
  resolveCast,
  spellCustom,
  type SpellRow,
} from '../spell-kernel.ts';

export const ZHANG_GUAN_LI_DAI_COST = 95;
export const ZHANG_GUAN_LI_DAI_MIN_RANK = 5;
export const ZHANG_GUAN_LI_DAI_ROUNDS = 2;

const ZHANG_GUAN_LI_DAI: SpellRow = {
  id: 'zhang-guan-li-dai',
  name: '张冠李戴',
  summary:
    `射程 6 格：指定一名敌人做替身，接下来 ${ZHANG_GUAN_LI_DAI_ROUNDS} 回合**所有冲你来的效果**（伤害、定身、拉拽、转化……）` +
    `都落到他身上；替身死了自动失效；耗 ${ZHANG_GUAN_LI_DAI_COST} 灵力。`,
  effect: 'transfer',
  cost: ZHANG_GUAN_LI_DAI_COST,
  range: 6,
  preview: 'ring',
  custom: { rounds: ZHANG_GUAN_LI_DAI_ROUNDS } satisfies Record<string, unknown>,
};

export const TRANSFER_ROWS: readonly SpellRow[] = [ZHANG_GUAN_LI_DAI];
export const ZHANG_GUAN_LI_DAI_SKILL = defineSpellSkill(ZHANG_GUAN_LI_DAI);

registerManaReady(TRANSFER_ROWS);
registerPreview(TRANSFER_ROWS);

registerSkillEffect('transfer', (c) => {
  const p = spellCustom<Record<string, unknown>>(c);
  const s = c.state;
  const self = c.self;
  const cost = Number(p.spellCost);
  const range = Number(p.spellRange);
  const skillName = (c.skill as { name?: string } | undefined)?.name ?? '法术';
  const name = c.api.utype(s, self.type).name;

  const cast = resolveCast(c, {
    cost,
    range,
    mode: 'single',
    rangeFrom: 'victim',
    noTargetReason: () => '选一个替身',
    noUnitReason: () => '那一格没有单位',
    allyReason: (ctx, victim) => `要指定敌人做替身（${ctx.api.utype(ctx.state, victim.type).name} 是自己人）`,
    tooFarReason: () => `太远了（${skillName}射程 ${range} 格）`,
  });
  if (!cast.ok) {
    c.result.ok = false;
    c.result.reason = cast.reason;
    return;
  }

  /*
   * 注意：**不要**在这里再付一次灵力。
   * `resolveCast` 已经按传进去的 `cost` 扣过了（它管选目标 + 校验 + 扣费），
   * 再调一次 `paySpellCost` 就是双倍扣费——第一次 95、第二次只剩 15，
   * 报出来的是"灵力不足"，看着像门槛太高，其实是我多扣了一次。
   */

  const victim = cast.victims[0]!;
  setDai(self, victim.id, Number(p.rounds ?? 1));
  c.result.log = `${name}施放${skillName}：${
    c.api.utype(s, victim.type).name
  } 成了替身，此后冲你来的都算他的（耗 ${cost} 灵力）`;
});
