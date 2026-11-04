/**
 * 强化学习的训练环境：**合法动作枚举**。
 *
 * ── 为什么要有这个文件 ─────────────────────────────────────────────────
 *
 * 训练一个策略，每一步都得有"当前有哪些可选动作"。界面和 AI 里各自算过这件事，
 * 但都不适合批量跑：AI 那套连"要不要打"一起算完（15.7 ms/次），界面那套带着渲染。
 * 这里只做一件事——**把这一刻合法的动作全部列出来**，然后由策略打分、采样。
 *
 * 判据必须和 rules.ts 的 doXxx 完全一致，否则策略会学到一个"看起来合法、真下就报错"
 * 的动作。所以下面每条都照着 doMove / doAttack / doSiege / doRecruit / doUpgrade
 * 的早期返回写，并且不自己发明规则——能用 rules 导出的判据就一律复用
 * （`eraWindowOk` / `recruitPriceOf` / `canPay` / `recruitSpawnCells` / `canStrike`…）。
 *
 * 硬测试在 `scripts/rl/verify-legal.ts`：**枚举出来的每个动作，applyAction 都必须接受**。
 *
 * ── 还没覆盖的 ──────────────────────────────────────────────────────────
 *
 *   · BUILD（野外盖建筑）：落点合法性依赖 supplyEraAt / 地形 / 相邻规则，
 *     而且"盖在哪"本身是二维决策，留给第二版；
 *   · LOAD / UNLOAD（上下船）、HERO_SKILL、DISBAND、PLACE_EGG：低频动作。
 *
 * 这会让策略略弱于手写 AI（它会盖塔、会上下船）。**做基线对比时必须说明这个差异**，
 * 否则"PPO 打不过手写 AI"会被误读成算法不行。
 */
import {
  canStrike,
  cityById,
  citiesOf,
  coversTile,
  distToCity,
  effectiveRangeAgainst,
  heroBlocked,
  reachableTiles,
  rebuildCost,
  recruitPriceOf,
  recruitSpawnCells,
  tileAt,
  underConstruction,
  unitById,
  upgradeCostOf,
  utype,
} from '../../src/core/rules.ts';
import { canUseType, eraWindowOk } from '../../src/core/draft.ts';
import { canPay } from '../../src/core/resources.ts';
import {
  canProduce,
  isProducer,
  produceCooldownLeft,
  produceCostScale,
  scaleCost,
} from '../../src/core/produce.ts';
import type { Action, GameState, PlayerId, Unit, UnitTypeDef } from '../../src/core/types.ts';
import type { ResourceCost } from '../../src/core/resources.ts';

/** 这一格上有没有自己的单位挡着（规则允许穿过友军，但不能停在上面） */
function blockedByAlly(s: GameState, self: Unit, x: number, y: number): boolean {
  for (const u of s.units) {
    if (u.id === self.id || u.owner !== self.owner) continue;
    if (coversTile(s, u, x, y)) return true;
  }
  return false;
}

/** 还能不能攻击（`attacksLeft` 未初始化时按满额算，和 rules 一致） */
function canStillAttack(u: Unit): boolean {
  if (u.acted) return false;
  if (u.attacksLeft === undefined) return true;
  return u.attacksLeft > 0;
}

/**
 * 列出 `seat`（默认当前回合方）这一刻的全部合法动作。
 *
 * 顺序刻意固定（先 MOVE 后 ATTACK 再 SIEGE…），同一个局面两次枚举结果一致——
 * 训练与回放都依赖这一点。
 */
export function legalActions(s: GameState, seat: PlayerId = s.current): Action[] {
  const out: Action[] = [];
  if (seat !== s.current) return out; // 只有轮到的这一方能动作
  if (s.winner) return out;

  const mine = s.units.filter((u) => u.owner === seat);

  for (const u of mine) {
    // ── 移动 ──────────────────────────────────────────────────────────
    if (!u.moved) {
      for (const i of reachableTiles(s, u).keys()) {
        const y = Math.floor(i / s.w);
        const x = i - y * s.w;
        if (x === u.x && y === u.y) continue;
        if (blockedByAlly(s, u, x, y)) continue;
        // 走进废墟 = 接管，得先掏重建费（doMove 的第一道钱关）。
        // 这条是 verify 用例逼出来的：不判的话每局都会枚举出一堆
        // "走进去但付不起"的动作。
        const destCity = tileAt(s, x, y)?.cityId ? cityById(s, tileAt(s, x, y)!.cityId!) : null;
        if (destCity?.ruined && s.players[seat].gold < rebuildCost(destCity)) continue;
        out.push({ type: 'MOVE', unitId: u.id, x, y });
      }
    }

    // ── 攻击 ──────────────────────────────────────────────────────────
    if (canStillAttack(u) && !underConstruction(u)) {
      for (const foe of s.units) {
        if (foe.owner === u.owner) continue;
        if (foe.hp <= 0) continue;
        if (!canStrike(s, u, foe)) continue;
        out.push({ type: 'ATTACK', unitId: u.id, targetId: foe.id });
      }
    }

    // ── 攻城 ──────────────────────────────────────────────────────────
    if (canStillAttack(u) && !underConstruction(u)) {
      for (const city of s.cities) {
        if (city.owner === u.owner) continue;
        if (city.ruined) continue;
        const tile = tileAt(s, city.x, city.y);
        if (distToCity(u, city) > effectiveRangeAgainst(s, u, tile)) continue;
        out.push({ type: 'SIEGE', unitId: u.id, cityId: city.id });
      }
    }
  }
  // ── 产兵 ────────────────────────────────────────────────────────────
  //
  // 这一步是枚举里最贵的一段（占 80% 的时间），所以先做三件事，避免
  // "对每座城 × 每个兵种"重复算一遍：
  //   ① 兵种表只取一次，且先过掉与城市无关的条件（类别、召唤物、名单）；
  //   ② 兵价与城市无关，按兵种算一次；
  //   ③ 出兵落点只跟"城 + 陆军/水军"有关，按这个粒度缓存。
  // 按时代分桶：一座时代 E 的城只可能造 era ≤ E 的兵（时代下限早就取消了，
  // 但上限仍然在）。早期局里这一条把候选从 200 个压到 20 个。
  const byEra = new Map<number, UnitTypeDef[]>();
  for (const def of Object.values(s.unitTypes)) {
    if (def.category === 'building') continue;
    if (def.summonedOnly) continue;
    if (!canUseType(s, seat, def.id)) continue;
    const e = def.era ?? 1;
    const bucket = byEra.get(e);
    if (bucket) bucket.push(def);
    else byEra.set(e, [def]);
  }
  const typesUpTo = (era: number): UnitTypeDef[] => {
    if (era >= ERA_BUCKETS_MAX) return allBaseTypes;
    let out = upToCache.get(era);
    if (!out) {
      out = [];
      for (const [e, list] of byEra) if (e <= era) out.push(...list);
      upToCache.set(era, out);
    }
    return out;
  };
  const allBaseTypes: UnitTypeDef[] = [...byEra.values()].flat();
  const upToCache = new Map<number, UnitTypeDef[]>();
  const ERA_BUCKETS_MAX = 8;
  const costCache = new Map<string, ResourceCost>();
  const costOf = (def: UnitTypeDef, costScale: number): ResourceCost => {
    const key = `${def.id}|${costScale}`;
    let v = costCache.get(key);
    if (!v) {
      v = scaleCost(recruitPriceOf(s, seat, def).total, costScale);
      costCache.set(key, v);
    }
    return v;
  };
  const slotsCache = new Map<string, Array<{ x: number; y: number }>>();
  const slotsFor = (cityId: string | undefined, campId: string | undefined, def: UnitTypeDef) => {
    const key = `${cityId ?? ''}|${campId ?? ''}|${def.domain === 'water' ? 'w' : 'l'}`;
    let v = slotsCache.get(key);
    if (!v) {
      v = recruitSpawnCells(s, cityId, campId, def.id);
      slotsCache.set(key, v);
    }
    return v;
  };

  for (const city of s.cities) {
    if (city.owner !== seat) continue;
    if (city.ruined) continue;
    if (city.capturedTurn === s.turn) continue;
    for (const def of typesUpTo(city.era)) {
      if (!eraWindowOk(s, def, city.era)) continue;
      if (heroBlocked(s, seat, def)) continue;
      if (!canPay(s.players[seat], costOf(def, 1))) continue;
      const slots = slotsFor(city.id, undefined, def);
      if (slots.length === 0) continue;
      out.push({ type: 'RECRUIT', cityId: city.id, unitType: def.id });
    }
  }

  // ── 产兵（军营这类野外产兵点）───────────────────────────────────────
  const ownCities = citiesOf(s, seat);
  if (ownCities.length > 0) {
    for (const u of mine) {
      const campDef = utype(s, u.type);
      if (!isProducer(campDef)) continue;
      if (underConstruction(u)) continue;
      if (produceCooldownLeft(s, u, campDef) > 0) continue;
      const costScale = produceCostScale(campDef);
      for (const def of typesUpTo(u.era ?? 9)) {
        if (!canProduce(campDef, def).ok) continue;
        if (!eraWindowOk(s, def, u.era ?? 0)) continue;
        if (heroBlocked(s, seat, def)) continue;
        if (!canPay(s.players[seat], costOf(def, costScale))) continue;
        if (slotsFor(undefined, u.id, def).length === 0) continue;
        out.push({ type: 'RECRUIT', unitId: u.id, unitType: def.id });
      }
    }
  }

  // ── 升级城市 ────────────────────────────────────────────────────────
  for (const city of s.cities) {
    if (city.owner !== seat) continue;
    const cost = upgradeCostOf(s, city);
    if (cost === null) continue;
    if (s.players[seat].gold < cost) continue;
    out.push({ type: 'UPGRADE', cityId: city.id });
  }

  out.push({ type: 'END_TURN' });
  return out;
}

/** 便于统计与调试：把动作按类型分组计数 */
export function actionHistogram(actions: readonly Action[]): Record<string, number> {
  const h: Record<string, number> = {};
  for (const a of actions) h[a.type] = (h[a.type] ?? 0) + 1;
  return h;
}

/** 单位侧的辅助：这个 id 是不是我方的单位 */
export function ownUnit(s: GameState, seat: PlayerId, id: string): Unit | undefined {
  const u = unitById(s, id);
  return u && u.owner === seat ? u : undefined;
}

/** 城市查找（导出给训练脚本用，避免各处重复写） */
export function cityOf(s: GameState, id: string) {
  return cityById(s, id);
}
