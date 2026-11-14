/**
 * 张冠李戴：把"冲着施法者来的一切"转给另一个人。
 *
 * ── 为什么单独一个文件（不放进 skills/）──────────────────────────
 *
 * 这份状态要被**骨架**读：所有挑目标的法术都要经过 `resolveCast`，
 * 伤害要被 `redirectDamage` 拦。骨架不该反过来 import 一个 spells 文件，
 * 所以状态与读取口径放在这一层，法术那一行放 `skills/transfer.ts`。
 *
 * ── "一切"到底覆盖到哪 ─────────────────────────────────────────
 *
 * 这个游戏里"以某人为目标"的入口只有两个（作者 2026-11-14 的原话：
 * "直接改传入的 victim"）：
 *
 *   1. **伤害**：`hurtUnit` 会问 `redirectDamage`——所有攻击、地雷、反伤
 *      最终都从这里落地。这里返回替身，等于伤害整体转走。
 *   2. **法术挑的目标**：单体/范围法术都要过 `resolveCast`，在那儿把
 *      `victims` 换成替身，就覆盖了定身、麻痹、拉拽、转化、处决……
 *      因为它们全是"拿到 victims 之后才动手"。
 *
 * 两个入口都改了之后，剩下唯一不覆盖的是**不经过任何目标的全局效果**
 * （天下皆白、绝地天通这类改规则的法术）——它们本来就没有 victim 可换，
 * 也就谈不上"转到别人身上"。
 *
 * ⚠️ 红线上这条：本文件不许 import `../units.ts`。
 */
import { registerStatus } from '../statuses.ts';
import type { GameState, Unit } from '../types.ts';

export const DAI_STATUS = 'spell-dai';

registerStatus({
  id: DAI_STATUS,
  name: '张冠李戴',
  summary: '冲着施法者来的一切，都落到替身头上',
});

/** 施法者身上记的"替身是谁" */
export interface DaiMark {
  target: string;
  turns: number;
}

/** 给施法者挂上替身。回合数走状态，到期钩子就读不到 → 自动失效 */
export function setDai(u: Unit, target: string, turns: number): void {
  u.status = { ...(u.status ?? {}), [DAI_STATUS]: turns };
  u.custom = { ...(u.custom ?? {}), dai: { target, turns } satisfies DaiMark };
}

/**
 * 这个单位此刻的替身。**只有状态还在、替身还活着**才算数。
 *
 * 返回 undefined 的三种情况都要当作"没有转移"：状态到期、替身被打死、
 * 记录坏了。少判一种就会出现"替身已经没了，伤害还在往空处打"。
 */
export function daiTargetOf(state: GameState, u: Unit): Unit | undefined {
  if (((u.status?.[DAI_STATUS] ?? 0) as number) <= 0) return undefined;
  const mark = u.custom?.['dai'] as DaiMark | undefined;
  if (!mark?.target) return undefined;
  const t = state.units.find((x) => x.id === mark.target && x.hp > 0);
  return t && t.id !== u.id ? t : undefined;
}
