/**
 * 「抢经济」脚本：专门打对方工人的对手。
 *
 * 为什么需要它：AI 自对弈里经济单位只吃 **5.9%** 的伤害，而真实人机对局里是
 * **30%**（见 docs/AI-2026-11-04-composition.md 第九节）。也就是说——**两个 AI 都不打经济**，
 * 于是"经济单位该不该撤"这条改动在自对弈里根本没有对手可以防，胜率当然不动。
 *
 * 这个脚本就是那个人类：它不围城、不抢时代、不算交换比，只做一件事——
 * 谁在挖矿就杀谁。用它当尺子，"护经济"这类改动才有可测的地方。
 *
 * 用法（塞进对决台）：
 *   node --experimental-strip-types scripts/ai-duel.ts --era 3 --games 200 --policy raid
 */
import {
  attackableTargets,
  canAttack,
  citiesOf,
  distance,
  previewAttack,
  reachableTiles,
  recruitPriceOf,
  recruitSpawnCells,
  unitAt,
  unitsOf,
  utype,
} from '../src/core/rules.ts';
import { canUseType, eraWindowOk } from '../src/core/draft.ts';
import type { Action, GameState, PlayerId, Unit } from '../src/core/types.ts';
import type { AiBudget } from '../src/core/ai-meta.ts';

const isEco = (s: GameState, u: Unit): boolean => utype(s, u.type).category === 'economy';

/** 离这个单位最近的敌方经济单位 */
function nearestPreyEco(s: GameState, me: PlayerId, u: { x: number; y: number }): Unit | null {
  const prey = unitsOf(s, otherOf(me)).filter((e) => isEco(s, e));
  if (prey.length === 0) return null;
  return [...prey].sort((a, b) => distance(u, a) - distance(u, b) || a.id.localeCompare(b.id))[0] ?? null;
}

const otherOf = (me: PlayerId): PlayerId => (me === 'A' ? 'B' : 'A');

export function raidNextAction(s: GameState, budget: AiBudget): Action | null {
  const me = s.current;
  const mine = unitsOf(s, me);

  // ── 1. 优先杀经济单位：能一击打死的最先，其次挑离得近的 ──
  let best: { u: Unit; t: Unit; score: number } | null = null;
  for (const u of mine) {
    if (!canAttack(u) || u.acted) continue;
    for (const t of attackableTargets(s, u)) {
      if (!isEco(s, t)) continue;
      const kill = previewAttack(s, u, t).toDefender >= t.hp;
      const score = (kill ? 10_000 : 0) + (utype(s, t.type).maxHp ?? 0) * -0.1 + (utype(s, t.type).cost ?? 0);
      if (!best || score > best.score) best = { u, t, score };
    }
  }
  if (best) return { type: 'ATTACK', unitId: best.u.id, targetId: best.t.id };

  // ── 2. 够不着工人就打手边的东西（别闲着） ──
  let any: { u: Unit; t: Unit; score: number } | null = null;
  for (const u of mine) {
    if (!canAttack(u) || u.acted) continue;
    for (const t of attackableTargets(s, u)) {
      const score = (utype(s, t.type).cost ?? 0) - distance(u, t) * 0.01;
      if (!any || score > any.score) any = { u, t, score };
    }
  }
  if (any) return { type: 'ATTACK', unitId: any.u.id, targetId: any.t.id };

  // ── 3. 造兵：只要跑得快的战斗单位（抢经济靠腿） ──
  if (budget.recruited < budget.maxRecruit) {
    const cities = [...citiesOf(s, me)].filter((c) => !c.ruined && c.capturedTurn !== s.turn);
    for (const city of cities) {
      const pool = Object.values(s.unitTypes).filter(
        (d) =>
          !d.summonedOnly &&
          canUseType(s, me, d.id) &&
          eraWindowOk(s, d, city.era) &&
          d.category === 'combat' &&
          d.domain !== 'water' &&
          d.move >= 3 &&
          recruitPriceOf(s, me, d).gold <= s.players[me].gold,
      );
      const pick = pool.sort((a, b) => (b.move ?? 0) - (a.move ?? 0) || (b.atk ?? 0) - (a.atk ?? 0))[0];
      if (pick && recruitSpawnCells(s, city.id, undefined, pick.id).length > 0) {
        return { type: 'RECRUIT', cityId: city.id, unitType: pick.id };
      }
    }
  }
  // 产兵格被堵：把人挪开（人类也会顺手挪）
  for (const city of citiesOf(s, me)) {
    if (city.ruined) continue;
    for (const u of mine) {
      if (u.moved || utype(s, u.type).move <= 0) continue;
      for (const idx of reachableTiles(s, u).keys()) {
        const x = idx % s.w;
        const y = Math.floor(idx / s.w);
        if (unitAt(s, x, y)) continue;
        if (Math.abs(x - city.x) + Math.abs(y - city.y) > 3) continue;
        return { type: 'MOVE', unitId: u.id, x, y };
      }
    }
  }

  // ── 4. 全员朝最近的敌方工人走 ──
  for (const u of mine) {
    if (u.moved || utype(s, u.type).move <= 0 || utype(s, u.type).category !== 'combat') continue;
    const prey = nearestPreyEco(s, me, u);
    const goal = prey ?? citiesOf(s, otherOf(me))[0];
    if (!goal) continue;
    let bestStep: { x: number; y: number } | null = null;
    let bestD = distance(u, goal);
    for (const idx of reachableTiles(s, u).keys()) {
      const x = idx % s.w;
      const y = Math.floor(idx / s.w);
      if (unitAt(s, x, y)) continue;
      const d = Math.abs(x - goal.x) + Math.abs(y - goal.y);
      if (d < bestD) { bestD = d; bestStep = { x, y }; }
    }
    if (bestStep) return { type: 'MOVE', unitId: u.id, x: bestStep.x, y: bestStep.y };
  }
  return null;
}
