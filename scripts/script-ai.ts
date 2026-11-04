/**
 * 「人类打法脚本」：一条**不算棋**的固定策略。
 *
 * 目的不是做一个强 AI，而是回答一个问题：**一个从不计算交换比、不评估威胁、
 * 不集火、不选战场的玩家，靠几条常识能不能打赢这套 AI？** 如果能，那说明
 * AI 缺的不是"算得更细"，而是没在**执行一条简单的策略**——这跟此前的推断
 * （决策层已饱和：高级→中级 +0 点）是同一个结论的另一个侧面。
 *
 * 五条规则，按优先级执行，全部是"看一眼就决定"的：
 *
 *   1. **能打就打**：能一击打死的先打（挑最贵的那个），否则打最近的。
 *   2. **能破城就破**：贴着敌城的单位直接砸城墙，挑血最少的那座。
 *   3. **钱够就升主城**：主城 = 时代最高的那座。这是人类最稳的一手"抢时代"。
 *   4. **造兵**：先铺到"每座城两个经济单位"，之后就只造**当前买得起的最强战斗单位**，
 *      从离敌方最近的那座城出。
 *   5. **全军朝最近的敌城走**：到目标城曼哈顿距离最小的可达格，不做任何威胁评估。
 *
 * 明确**不做**的事（这些正是 AI 那五条要补的）：不算交换比、不看对面射程、
 * 不集火（各打各的）、不守城、不分兵、不弃城、不换血、不攒大件。
 *
 * 它和 `aiNextAction` 的签名一样，所以能直接塞进 `scripts/ai-duel.ts`：
 *   node --experimental-strip-types scripts/ai-duel.ts --era 3 --games 30 --script
 */

import {
  attackableTargets,
  canAttack,
  citiesOf,
  distance,
  incomeResOf,
  previewAttack,
  reachableTiles,
  recruitPriceOf,
  recruitSpawnCells,
  cityTiles,
  siegeTargets,
  unitAt,
  unitsOf,
  upgradeCostOf,
  utype,
  cityById,
} from '../src/core/rules.ts';
import { canUseType, eraWindowOk } from '../src/core/draft.ts';
import type { Action, GameState, PlayerId, Unit, City } from '../src/core/types.ts';
import type { AiBudget } from '../src/core/ai-meta.ts';

/** 一个兵种"看着有多能打"：攻击×血量的平方根，人类看面板也就是这么估的 */
function punch(a: { atk: number; magicAtk?: number; maxHp: number; range?: number }): number {
  return (a.atk + (a.magicAtk ?? 0) * 1.2) * Math.sqrt(Math.max(1, a.maxHp)) * (1 + ((a.range ?? 1) - 1) * 0.4);
}

function nearestFoeCity(s: GameState, me: PlayerId, u: { x: number; y: number }): City | null {
  const foes = s.cities.filter((c) => c.owner !== me);
  if (foes.length === 0) return null;
  return foes.sort((a, b) => distance(u, a) - distance(u, b) || a.id.localeCompare(b.id))[0] ?? null;
}

function weakestFoeCity(s: GameState, me: PlayerId): City | null {
  const foes = s.cities.filter((c) => c.owner !== me && !c.ruined);
  if (foes.length === 0) return null;
  return [...foes].sort((a, b) => a.hp - b.hp || a.id.localeCompare(b.id))[0] ?? null;
}

/** 这条规则产出的动作；没有就返回 null，让调用方结束回合 */
export function scriptNextAction(s: GameState, budget: AiBudget): Action | null {
  const me = s.current;
  const mine = unitsOf(s, me);

  // ── 1. 能打就打：能打死的优先（挑最贵的），否则打最近的 ──
  let bestHit: { u: Unit; target: Unit; score: number } | null = null;
  for (const u of mine) {
    if (!canAttack(u) || u.acted) continue;
    for (const t of attackableTargets(s, u)) {
      const prey = utype(s, t.type);
      const kill = previewAttack(s, u, t).toDefender >= t.hp;
      // 打死优先，其次按"目标身价"，同分按最近的
      const score = (kill ? 10_000 : 0) + (prey.cost ?? 0) - distance(u, t) * 0.01;
      if (!bestHit || score > bestHit.score) bestHit = { u, target: t, score };
    }
  }
  if (bestHit) return { type: 'ATTACK', unitId: bestHit.u.id, targetId: bestHit.target.id };

  // ── 2. 能破城就破：贴着城墙的单位直接砸 ──
  for (const u of mine) {
    if (!canAttack(u) || u.acted) continue;
    const cities = siegeTargets(s, u);
    if (cities.length === 0) continue;
    const target = [...cities].sort((a, b) => a.hp - b.hp)[0]!;
    return { type: 'SIEGE', unitId: u.id, cityId: target.id };
  }

  // ── 3. 钱够就升主城（时代最高的那座；同代挑最便宜的） ──
  if (budget.upgraded < budget.maxUpgrade) {
    const mineCities = citiesOf(s, me).filter((c) => !c.ruined);
    const top = [...mineCities].sort((a, b) => b.era - a.era)[0];
    if (top) {
      const cost = upgradeCostOf(s, top);
      if (cost !== null && s.players[me].gold >= cost) return { type: 'UPGRADE', cityId: top.id };
    }
  }

  // ── 4. 造兵：先铺经济，再全力出一支"买得起的最强兵" ──
  if (budget.recruited < budget.maxRecruit) {
    const earners = mine.filter((u) => utype(s, u.type).category === 'economy').length;
    const wantEco = earners < citiesOf(s, me).length * 2;
    // 从离敌方最近的那座城出（人类也一样：前线出兵，别从后方搬）。
    // 但**时代要按那座城自己的算**：拿全图最高代去筛兵，选出来的兵在自己城里
    // 造不出来，规则层会直接拒——第一版就栽在这，中段十几个回合一个兵没出。
    const cities = [...citiesOf(s, me)]
      .filter((c) => !c.ruined && c.capturedTurn !== s.turn)
      .sort((a, b) => {
        const fa = nearestFoeCity(s, me, a);
        const fb = nearestFoeCity(s, me, b);
        return distance(a, fa ?? a) - distance(b, fb ?? b) || a.id.localeCompare(b.id);
      });
    for (const city of cities) {
      const pool = Object.values(s.unitTypes).filter(
        (d) =>
          !d.summonedOnly &&
          canUseType(s, me, d.id) &&
          eraWindowOk(s, d, city.era) &&
          (wantEco ? d.category === 'economy' : d.category === 'combat' && d.domain !== 'water') &&
          recruitPriceOf(s, me, d).gold <= s.players[me].gold,
      );
      // "看着最唬人的那个"（人类看面板也就这么挑）
      const pick = pool.sort((a, b) => punch(b) - punch(a) || (a.cost ?? 0) - (b.cost ?? 0))[0];
      if (process.env.SCRIPT_DEBUG) {
        console.error(
          `[recruit] city=${city.id} era=${city.era} gold=${s.players[me].gold} pool=${pool.length}` +
            ` pick=${pick?.id ?? '-'} slots=${pick ? recruitSpawnCells(s, city.id, undefined, pick.id).length : 0}`,
        );
      }
      if (pick && recruitSpawnCells(s, city.id, undefined, pick.id).length > 0) {
        return { type: 'RECRUIT', cityId: city.id, unitType: pick.id };
      }
    }
  }

  /*
   * ── 4b. 产兵格被自己人堵了：把蹲在城格上的非战斗单位挪开 ──
   *
   * 这一条是跑出来才发现非加不可的：第一版脚本只让战斗单位动，农民就一直站在
   * 城格上，而 `recruitSpawnCells` 只认空着的城格——于是中段十几个回合里
   * 金币从 131 涨到 518、兵数一个没涨，对面从 12 个涨到 16 个，然后就输了。
   * 人类不会犯这个错（城里站满了会顺手挪人），所以这也是"人类常识"的一部分。
   */
  for (const city of citiesOf(s, me)) {
    if (city.ruined) continue;
    if (cityTiles(city).some((t) => !unitAt(s, t.x, t.y))) continue;
    // 站在城格里的**任何**自己人都算堵：新兵出来就蹲在城格上（当回合不能动），
    // 下一个新兵就没地方出了。第一版只挪农民，于是战斗单位把产兵格占死。
    const inCity = (x: number, y: number): boolean =>
      x >= city.x && x < city.x + city.size && y >= city.y && y < city.y + city.size;
    const sitters = mine.filter((u) => !u.moved && inCity(u.x, u.y));
    for (const u of sitters) {
      for (const idx of reachableTiles(s, u).keys()) {
        const x = idx % s.w;
        const y = Math.floor(idx / s.w);
        if (unitAt(s, x, y)) continue;
        if (inCity(x, y)) continue; // 挪到城外一格就好
        return { type: 'MOVE', unitId: u.id, x, y };
      }
    }
  }

  // ── 5. 全军朝最近的敌城走：到它曼哈顿距离最小的空格 ──
  for (const u of mine) {
    if (u.moved) continue;
    const d = utype(s, u.type);
    if (d.category !== 'combat') continue;
    if (d.domain === 'water') continue; // 这条脚本不会打海战
    const target = nearestFoeCity(s, me, u);
    if (!target) continue;
    let best: { x: number; y: number; d: number } | null = null;
    for (const idx of reachableTiles(s, u).keys()) {
      const x = idx % s.w;
      const y = Math.floor(idx / s.w);
      if (unitAt(s, x, y)) continue;
      const dd = Math.abs(x - target.x) + Math.abs(y - target.y);
      if (!best || dd < best.d) best = { x, y, d: dd };
    }
    if (!best) continue;
    const here = Math.abs(u.x - target.x) + Math.abs(u.y - target.y);
    if (best.d >= here) continue; // 走不动就别原地打转
    return { type: 'MOVE', unitId: u.id, x: best.x, y: best.y };
  }

  // 没人能动了：把这一方的经济单位也派出去（不然它们永远缩在城里）
  return null;
}

/** 供探针打印用：这套脚本的行为摘要 */
export function scriptSummary(s: GameState, me: PlayerId): string {
  const mine = unitsOf(s, me);
  const inc = incomeResOf(s, me).gold ?? 0;
  const weakest = weakestFoeCity(s, me);
  return `兵 ${mine.length} / 每回合金 ${Math.round(inc)} / 目标城 ${weakest ? cityById(s, weakest.id)?.id : '—'}`;
}
