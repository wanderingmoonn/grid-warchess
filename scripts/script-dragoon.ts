/**
 * 固定打法脚本 · 龙骑兵闪击（"dragoon"）。
 *
 * 按用户口述的一条打法实现，**不做任何性价比推演**：
 *
 *   ① 全力攒钱：除了龙骑兵，什么都不买（不买经济单位、不买别的兵、不升级城）。
 *      开局白送的经济单位照常干活（它们不花钱，是攒钱的来源）。
 *   ② 攒够 265 金就造一个龙骑兵，能造几个造几个（城市时代窗口卡着）。
 *   ③ 龙骑兵直冲对面的**经济单位**，其次**战斗单位**：打得到就打，
 *      打不到就朝最近的敌方经济单位走；对面经济单位清光了就转打战斗单位，
 *      都没有才去砸城。
 *   ④ 开局白送的战斗单位守在自家城边，不参与进攻——这条是为了让结果
 *      只反映"龙骑兵流"本身，不掺"送的那几个兵顺手打赢了"。
 *
 * 为什么值得单独跑一版：龙骑兵是 3 代 265 金、26 攻 / 58 血 / 6 甲 / **移 5**、
 * 带冲锋（移动过的这一击 +5）。它是"贵、快、能打"的那一档，而 AI 平时几乎不买
 * （上一批 100 局只造了 3 个）。所以这条打法是"人会觉得好用、AI 从来不试"的典型。
 *
 * 用法见 scripts/dragoon-batch.ts。
 */

import {
  attackableTargets,
  canAttack,
  cityById,
  citiesOf,
  cityTiles,
  distance,
  previewAttack,
  reachableTiles,
  rebuildCost,
  recruitPriceOf,
  recruitSpawnCells,
  siegeTargets,
  unitAt,
  unitsOf,
  utype,
  unitYield,
} from '../src/core/rules.ts';
import { playerView } from '../src/core/fog.ts';
import type { Action, City, GameState, PlayerId, Unit } from '../src/core/types.ts';
import type { AiBudget } from '../src/core/ai-meta.ts';

/** 这一版只买它 */
export const DRAGOON = 'dragoon-rider';

function other(p: PlayerId): PlayerId {
  return p === 'A' ? 'B' : 'A';
}

/** 目标优先级：经济单位 > 战斗单位 > 其他（建筑/建造单位） */
function targetWeight(s: GameState, u: Unit): number {
  const d = utype(s, u.type);
  if (d.category === 'economy') return 3;
  if (d.category === 'combat') return 2;
  return 1;
}

/** 城格被自己人站满了：挪一个人出来（否则产兵停摆） */
function unblockCity(s: GameState, me: PlayerId, city: City): Action | null {
  const inCity = (x: number, y: number): boolean =>
    x >= city.x && x < city.x + city.size && y >= city.y && y < city.y + city.size;
  if (cityTiles(city).some((t) => !unitAt(s, t.x, t.y))) return null;
  for (const u of unitsOf(s, me)) {
    if (u.moved || !inCity(u.x, u.y)) continue;
    for (const idx of reachableTiles(s, u).keys()) {
      const x = idx % s.w;
      const y = Math.floor(idx / s.w);
      if (unitAt(s, x, y) || inCity(x, y)) continue;
      return { type: 'MOVE', unitId: u.id, x, y };
    }
  }
  return null;
}

/**
 * 龙骑兵这一下打谁：优先经济单位，其次战斗单位。
 * 同一档里先看"能不能一刀带走"，再看"值多少钱"，最后看距离（越近越先打）。
 */
function dragoonAttack(s: GameState, me: PlayerId): Action | null {
  let best: { u: Unit; t: Unit; score: number } | null = null;
  for (const u of unitsOf(s, me)) {
    if (u.type !== DRAGOON || u.acted || !canAttack(u)) continue;
    for (const t of attackableTargets(s, u)) {
      const kill = previewAttack(s, u, t).toDefender >= t.hp;
      const score =
        targetWeight(s, t) * 10_000 + (kill ? 5_000 : 0) + (utype(s, t.type).cost ?? 0) - distance(u, t) * 0.5;
      if (!best || score > best.score) best = { u, t, score };
    }
  }
  return best ? { type: 'ATTACK', unitId: best.u.id, targetId: best.t.id } : null;
}

/** 朝某个点走：能到的格里离它最近的那一个（走得越远越好） */
function stepToward(s: GameState, u: Unit, tx: number, ty: number): Action | null {
  const here = Math.abs(u.x - tx) + Math.abs(u.y - ty);
  const gold = s.players[u.owner].gold;
  let best: { x: number; y: number; d: number } | null = null;
  for (const idx of reachableTiles(s, u).keys()) {
    const x = idx % s.w;
    const y = Math.floor(idx / s.w);
    if (unitAt(s, x, y)) continue;
    /*
     * 别顺手踩进敌方废墟：走进废墟 = 付费接管，付不起就是**非法动作**。
     * 这条不是理论问题——第一版"朝目标走"选的是"离目标最近的可达格"，
     * 而废墟城的格子恰好就在目标旁边，于是脚本会提议一步走不成的棋。
     */
    const tile = s.tiles[idx];
    const c = tile?.cityId ? cityById(s, tile.cityId) : null;
    if (c && c.ruined && c.owner !== u.owner && gold < rebuildCost(c)) continue;
    const d = Math.abs(x - tx) + Math.abs(y - ty);
    if (!best || d < best.d) best = { x, y, d };
  }
  if (!best || best.d >= here) return null;
  return { type: 'MOVE', unitId: u.id, x: best.x, y: best.y };
}

/** 追击目标：最近的敌方经济单位 → 最近的战斗单位 → 血最少的敌城 */
function chaseTarget(s: GameState, me: PlayerId, from: Unit): { x: number; y: number } | null {
  const foes = unitsOf(s, other(me));
  const byCat = (cat: string): Unit[] => foes.filter((e) => utype(s, e.type).category === cat);
  for (const group of [byCat('economy'), byCat('combat')]) {
    if (group.length === 0) continue;
    const pick = [...group].sort(
      (a, b) => distance(from, a) - distance(from, b) || a.hp - b.hp || a.id.localeCompare(b.id),
    )[0];
    if (pick) return { x: pick.x, y: pick.y };
  }
  const city = [...s.cities]
    .filter((c) => !c.ruined && c.owner !== me)
    .sort((a, b) => a.hp - b.hp || a.id.localeCompare(b.id))[0];
  return city ? { x: city.x, y: city.y } : null;
}

/** 经济单位往最赚钱的格子挪（白送的农民也得干活，不然攒不出龙骑兵） */
function shuffleEarner(s: GameState, u: Unit): Action | null {
  if (utype(s, u.type).category !== 'economy' || u.moved) return null;
  const now = unitYield(s, u).gold ?? 0;
  let best: { x: number; y: number; g: number } | null = null;
  for (const idx of reachableTiles(s, u).keys()) {
    const x = idx % s.w;
    const y = Math.floor(idx / s.w);
    if (unitAt(s, x, y)) continue;
    const g = unitYield(s, { ...u, x, y }).gold ?? 0;
    if (g > now && (!best || g > best.g)) best = { x, y, g };
  }
  return best ? { type: 'MOVE', unitId: u.id, x: best.x, y: best.y } : null;
}

/**
 * 这条打法的下一步。签名与 `aiNextAction` 一致，直接塞进批次跑。
 */
export function dragoonNextAction(full: GameState, budget: AiBudget): Action | null {
  /*
   * 只吃"自己看得见"的那一份。标准 AI 在 `aiNextAction` 里第一件事就是
   * `playerView(s, me)`，脚本如果直接读全图，它就带着透视在追杀农民——
   * 那样测出来的胜率不成立（第一版就是全图，20 局全胜，全胜得可疑）。
   */
  const s = playerView(full, full.current).state;
  const me = s.current;
  const mine = unitsOf(s, me);
  const dragoons = mine.filter((u) => u.type === DRAGOON);
  const cities = citiesOf(s, me).filter((c) => !c.ruined);
  const def = s.unitTypes[DRAGOON];
  const gold = s.players[me].gold;

  /*
   * 敌方剩的是**废墟城**时，得留出重建费：走进去接管是唯一能终结对局的动作。
   *
   * 第一版没有这一条：20 局里有两局打满 200 回合，场上 44 个龙骑兵，
   * 敌人只剩一个奴隶加几座建筑——敌城早就被打成 0 耐久了，但"废墟"不算丢城，
   * 于是谁也赢不了。人会走进去，脚本不会。见文件头的 ⑥。
   */
  const ruinedFoes = s.cities.filter((c) => c.owner !== me && c.ruined);
  const cheapestRebuild = ruinedFoes.length > 0 ? Math.min(...ruinedFoes.map(rebuildCost)) : 0;
  const mustSaveForRebuild = ruinedFoes.length > 0 && gold < cheapestRebuild;

  // ① 攒够就买：只买龙骑兵，别的一概不买（要留重建费的时候先忍一回合）
  if (
    def &&
    !mustSaveForRebuild &&
    budget.recruited < budget.maxRecruit &&
    recruitPriceOf(s, me, def).gold <= gold
  ) {
    for (const city of [...cities].sort((a, b) => b.era - a.era || a.hp - b.hp)) {
      const blocked = unblockCity(s, me, city);
      if (blocked) return blocked;
      if (recruitSpawnCells(s, city.id, undefined, DRAGOON).length === 0) continue;
      return { type: 'RECRUIT', cityId: city.id, unitType: DRAGOON };
    }
  }

  // ② 打得到就打（经济单位优先）
  const hit = dragoonAttack(s, me);
  if (hit) return hit;

  // ③ 打不到就朝目标走
  for (const u of dragoons) {
    if (u.moved) continue;
    const target = chaseTarget(s, me, u);
    if (!target) continue;
    const step = stepToward(s, u, target.x, target.y);
    if (step) return step;
  }

  // ③.5 敌城已成废墟：攒够重建费就走进去接管（不接管永远分不出胜负）
  if (ruinedFoes.length > 0) {
    for (const city of [...ruinedFoes].sort((a, b) => rebuildCost(a) - rebuildCost(b))) {
      if (gold < rebuildCost(city)) continue;
      for (const u of dragoons) {
        if (u.moved) continue;
        const reach = reachableTiles(s, u);
        const spot = cityTiles(city).find((t) => reach.has(t.y * s.w + t.x));
        if (spot) return { type: 'MOVE', unitId: u.id, x: spot.x, y: spot.y };
      }
    }
    // 这一回合走不到：先朝最近的那座废墟挪，别在原地继续追残兵
    const nearest = [...ruinedFoes].sort(
      (a, b) =>
        Math.min(...dragoons.map((u) => distance(u, a))) - Math.min(...dragoons.map((u) => distance(u, b))),
    )[0];
    if (nearest) {
      for (const u of dragoons) {
        if (u.moved) continue;
        const step = stepToward(s, u, nearest.x, nearest.y);
        if (step) return step;
      }
    }
  }

  // ④ 贴着城、又没有活人可打：砸城
  for (const u of dragoons) {
    if (u.acted || !canAttack(u)) continue;
    const targets = siegeTargets(s, u);
    if (targets.length === 0) continue;
    const city = [...targets].sort((a, b) => a.hp - b.hp)[0]!;
    return { type: 'SIEGE', unitId: u.id, cityId: city.id };
  }

  // ⑤ 白送的农民继续赚钱
  for (const u of mine) {
    const mv = shuffleEarner(s, u);
    if (mv) return mv;
  }

  // ⑥ 白送的战斗单位守在自家城边（不参与进攻，见文件头 ④）
  const home = [...cities].sort((a, b) => b.era - a.era)[0];
  if (home) {
    for (const u of mine) {
      if (utype(s, u.type).category !== 'combat' || u.type === DRAGOON || u.moved) continue;
      if (distance(u, home) <= 3) continue;
      const step = stepToward(s, u, home.x, home.y);
      if (step) return step;
    }
  }
  return null;
}
