/**
 * **决定层**：这一段时间做什么、做到什么时候、为什么。
 *
 * ── 它只准交出 `Decision` ────────────────────────────────────
 *
 * 不许输出"进攻意愿 +40"这种东西。加一项分，等于把"要不要打"这个问题
 * 摊进一张谁也读不懂的表里；而"这三回合先发展，第 20 手之前不开战"是
 * 一句能被人反驳的话——错了能改，含糊的分只能调参。
 *
 * ── 决定有期限 ──────────────────────────────────────────────
 *
 * `untilTurn` 是硬要求。没有期限的决定会悄悄变成常数，然后没人记得它是谁写的。
 */
import type { World } from './world.ts';
import type { Decision, V4Memory } from './types.ts';
import { utype } from '../rules.ts';
import type { GameState } from '../types.ts';

/** 兵力对比（按"身价"不按个数：一个四代兵不等于一个民兵） */
function strength(s: GameState, sideUnits: GameState['units']): number {
  let n = 0;
  for (const u of sideUnits) {
    const d = utype(s, u.type);
    n += ((d.atk ?? 0) + (d.maxHp ?? 0) + (d.range ?? 1) * 4) * (u.hp / Math.max(1, d.maxHp));
  }
  return n;
}

/**
 * 做决定。
 *
 * 第一版只有三条规则，都很粗——这是**故意的**：先把"决定有期限、有理由、只有一个"
 * 这件事立住，细则靠题库一题一题长。v3 那六千行系数不抄。
 */
export function decide(s: GameState, world: World, mem?: V4Memory): Decision {
  const horizon = 6;

  const myStr = strength(s, world.myCombat);
  const foeStr = strength(s, world.foeCombat);

  /*
   * ① 先看**有没有还没到期的承诺**（迟滞）。
   *
   * 为什么必须有：判决每回合重算会在阈值附近来回翻。v3 的注释里有一句实测——
   * "4 局翻 128 次"。这里抄它的做法：进入难、退出也难，两头都留余量。
   *
   * 但沿用不是无条件的：每条承诺都写清楚"什么情况下可以提前作废"。
   */
  const prev = mem?.decision;
  if (prev && s.turn <= prev.untilTurn) {
    const ratio = myStr / Math.max(1, foeStr);
    if (prev.kind === 'press') {
      const cityAlive = !!prev.cityId && world.foeCities.some((c) => c.id === prev.cityId);
      /* 打不动了就提前收手：兵力比跌破 1.0（原来是 1.25 才进） */
      if (cityAlive && ratio >= 1.0) {
        return { kind: 'press', untilTurn: prev.untilTurn, cityId: prev.cityId, reason: `${prev.reason}（沿用）` };
      }
    } else if (prev.kind === 'defend') {
      /* 威胁解除就提前转攻：对面掉到我方 0.6 以下 */
      if (foeStr >= myStr * 0.6) {
        return { kind: 'defend', untilTurn: prev.untilTurn, cityId: prev.cityId, reason: `${prev.reason}（沿用）` };
      }
    } else if (ratio < 1.25) {
      return { kind: 'expand', untilTurn: prev.untilTurn, reason: `${prev.reason}（沿用）` };
    }
  }

  /* 1) 自家城被压着，且兵力不占优 → 守 */
  const threatened = world.cities.filter((c) => c.role === 'threatened' || c.role === 'home');
  if (threatened.length > 0 && foeStr > myStr * 0.9) {
    const worst = threatened.sort((a, b) => a.distToFoeArmy - b.distToFoeArmy)[0]!;
    return {
      kind: 'defend',
      untilTurn: s.turn + horizon,
      cityId: worst.city.id,
      reason: `对面身价 ${Math.round(foeStr)} > 我 ${Math.round(myStr)}，${worst.city.id} 离敌军最近，先守`,
    };
  }

  /* 2) 我明显更强、且有敌城 → 推 */
  if (world.foeCities.length > 0 && myStr > foeStr * 1.25) {
    /* 挑最近的敌城打，不挑"血最少"的：跑不动的城打不下来 */
    const target = [...world.foeCities].sort(
      (a, b) => world.marchTurns({ x: a.x, y: a.y }, { x: world.myCombat[0]?.x ?? 0, y: world.myCombat[0]?.y ?? 0 })
        - world.marchTurns({ x: b.x, y: b.y }, { x: world.myCombat[0]?.x ?? 0, y: world.myCombat[0]?.y ?? 0 }),
    )[0]!;
    return {
      kind: 'press',
      untilTurn: s.turn + horizon,
      cityId: target.id,
      reason: `我身价 ${Math.round(myStr)} > 对面 ${Math.round(foeStr)} 的 1.25 倍，推最近的 ${target.id}`,
    };
  }

  /* 3) 其它情况：发展 */
  return {
    kind: 'expand',
    untilTurn: s.turn + horizon,
    reason: `身价 ${Math.round(myStr)} : ${Math.round(foeStr)}，不占优，先攒兵攒钱`,
  };
}
