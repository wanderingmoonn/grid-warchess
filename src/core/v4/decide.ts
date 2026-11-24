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
import type { City } from '../types.ts';
import type { Decision, TakeoverStage, V4Memory } from './types.ts';
import { effectiveStats, utype } from '../rules.ts';
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
 * 一个决定**名义上管几手**。
 *
 * 导出来给经济岗表用：它需要一个"还剩几手"的尺度来判断"这个岗值不值得占"
 * （走 5 手才到的岗，在 6 手的盘子里就只剩 1 手产出）。
 *
 * 为什么不用 `untilTurn - s.turn`：那个数在每个周期的最后几手会塌到 1，
 * 于是岗表突然全空、经济兵集体停手、钱堆着不花（实测 S-015 第 7 手）。
 * 战略上"决定快到期了"不等于"这块地不值得占"——下个决定大概率还是同一件事。
 */
export const DECIDE_HORIZON = 6;

/**
 * 做决定。
 *
 * 第一版只有三条规则，都很粗——这是**故意的**：先把"决定有期限、有理由、只有一个"
 * 这件事立住，细则靠题库一题一题长。v3 那六千行系数不抄。
 */
/**
 * **接管一座废墟**：先清场、再攒钱、最后入驻（见 `TakeoverStage`）。
 *
 * 为什么这件事要一个独立的决定：它的成功条件不是"把城打空"（那是 `press`），
 * 而是"钱够了、并且有一个兵站进去"。挤进 `press` 会让"城血 0"被当成"打完了"——
 * S-001 就是这么卡的：城打空后还在 press，继续造兵，把 248 金 rebuilding 费花光，
 * 40 手都接管不了。
 *
 * 阶段是**每回合重算**的（不沿用）：它只依赖两件每回合都在变的事（敌人还在不在、
 * 钱够不够），而且只会往一个方向走（clear → save → enter），不会抖。
 */
function takeoverDecision(s: GameState, world: World, ruin: City): Decision {
  const threats = world.ruinThreats(ruin);
  const cost = world.ruinCost(ruin);
  const gold = s.players[world.me]?.gold ?? 0;
  const stage: TakeoverStage = threats.length > 0 ? 'clear' : gold < cost ? 'save' : 'enter';
  const why =
    stage === 'clear'
      ? `废墟还有 ${threats.length} 个单位能打到它，先清场`
      : stage === 'save'
        ? `城下清干净了，攒 ${cost} 金重建（现有 ${gold}）`
        : `钱够了（${gold} ≥ ${cost}），派兵入驻`;
  return { kind: 'takeover', stage, untilTurn: s.turn + DECIDE_HORIZON, cityId: ruin.id, reason: why };
}

export function decide(s: GameState, world: World, mem?: V4Memory): Decision {
  const horizon = DECIDE_HORIZON;

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
      /*
       * **目标城已经成废墟 → 这不是"还在打"，是"该去接管了"。**
       * 不转的话会一直按 press 造兵，把钱花光（S-001：城血 0 之后 40 手都没钱重建）。
       */
      const ruin = prev.cityId ? s.cities.find((c) => c.id === prev.cityId && c.ruined) : undefined;
      if (ruin) return takeoverDecision(s, world, ruin);
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

  /* 1.5) **有打空的城 → 接管它**（在"再打下一座"之前） */
  if (world.ruins.length > 0) {
    /*
     * 只接管"手上这座"：要么是上一段 press 的目标，要么是身边最近的那座
     * （部队已经推到城下，下一手就能进去）。远处的废墟先不碰——跑过去再被抢，
     * 不如先把眼前的事办完。
     */
    const near = [...world.ruins].sort((a, b) => {
      const da = Math.min(
        ...world.myCombat.map((u) => world.marchTurns({ x: a.x, y: a.y }, { x: u.x, y: u.y })),
        Infinity,
      );
      const db = Math.min(
        ...world.myCombat.map((u) => world.marchTurns({ x: b.x, y: b.y }, { x: u.x, y: u.y })),
        Infinity,
      );
      return da - db;
    })[0];
    if (near) return takeoverDecision(s, world, near);
  }

  /* 2) 我明显更强、且有敌城 → 推 */
  if (world.foeCities.length > 0 && myStr > foeStr * 1.25) {
    /* 挑最近的敌城打，不挑"血最少"的：跑不动的城打不下来 */
    const target = [...world.foeCities].sort(
      (a, b) => world.marchTurns({ x: a.x, y: a.y }, { x: world.myCombat[0]?.x ?? 0, y: world.myCombat[0]?.y ?? 0 })
        - world.marchTurns({ x: b.x, y: b.y }, { x: world.myCombat[0]?.x ?? 0, y: world.myCombat[0]?.y ?? 0 }),
    )[0]!;
    /*
     * **先清场、再砸城。**
     *
     * 判据：目标城周围还有没有"够得着这座城"的守军（它自己的移动力 + 射程）。
     * 有 → `clear`（全队打人，不砸城）；清干净 → `siege`（全队攻城）。
     *
     * 这是从 S-002 的人手答案量出来的：人类前四波（3/5/7/9 手）25 次攻击全是打人、
     * 0 次攻城，第 11 手才开始砸。v4 原来没有这个分段，"能打谁打谁"，
     * 结果既没清完场也没砸城（15 手 SIEGE 0 次）。
     */
    const guards = world.foeCombat.filter((f) => {
      const st = effectiveStats(s, f);
      return (
        Math.abs(f.x - target.x) + Math.abs(f.y - target.y) <=
        (st.range ?? 1) + (st.move ?? 2)
      );
    });
    return {
      kind: 'press',
      stage: guards.length > 0 ? 'clear' : 'siege',
      untilTurn: s.turn + horizon,
      cityId: target.id,
      reason:
        guards.length > 0
          ? `我身价 ${Math.round(myStr)} > 对面 ${Math.round(foeStr)} 的 1.25 倍；${target.id} 周围还有 ${guards.length} 个守军，先清场`
          : `我身价 ${Math.round(myStr)} > 对面 ${Math.round(foeStr)} 的 1.25 倍；${target.id} 城下已清空，开始攻城`,
    };
  }

  /* 3) 其它情况：发展 */
  return {
    kind: 'expand',
    untilTurn: s.turn + horizon,
    reason: `身价 ${Math.round(myStr)} : ${Math.round(foeStr)}，不占优，先攒兵攒钱`,
  };
}
