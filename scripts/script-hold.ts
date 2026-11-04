/**
 * 固定打法脚本 · 弃城发育流（"hold"）。
 *
 * 这一份按**给定的五条规则**实现，不是"更聪明的 AI"：所有判断都是阈值和排序，
 * 没有一处逐格评分，也没有任何"这一步划不划算"的推演。目的就是拿一条**人类口述
 * 得出来**的打法去和 AI 对局，看它值多少胜率。
 *
 * 规则与实现对照：
 *
 *   ① 开局放弃一座城（"放弃城"），其余为"保留城"。放弃城永不升级；
 *      只有敌军压到它附近时才在那里放几个便宜小兵，用来拖慢对面攻城。
 *      → `abandonedIdOf()`：挑**离敌方城市最近**的那座（最守不住的那座）。
 *        选一次就固定在这个 seed 上，不随后续局面漂移——这是"开局决定"。
 *   ② 前期只造经济单位，一个战斗单位都不造（除非触发规则 ④）。
 *      → 经济单位还会自己走到当前能走到的"最赚钱的格子"上（这算"最大化攒钱"，
 *        不算计算：人也是看一眼地皮就把农民挪过去）。
 *   ③ 每回合算一次：`现有金 + 3 回合收入 ≥ 保留城升级费` 就**立刻停止造农民**，
 *      转入攒钱；攒够就升那座城。→ 集中升**时代最高**的那座保留城（抢时代）。
 *   ④ 任一保留城的 4 格内出现敌军：造**低移速、高战力**的当前时代单位兑子防守，
 *      并让已有部队缩到城边。
 *   ⑤ 进入第 4 代（蒸汽）后：只造**买得起的最贵**当前时代陆军，全军转向进攻。
 *
 * 明确不做：算交换比、看对面射程/威胁圈、集火挑目标、分兵、弃城换家、换血、
 * 攒英雄、评估"这一仗该不该打"。打起来就是"见谁打谁、贴城砸城"。
 *
 * 用法（`npm run duel` 已接好）：
 *   node --experimental-strip-types scripts/ai-duel.ts --era 3 --games 30 \
 *        --policy hold --level advanced --old ./baselines/ai-current.ts
 */

import {
  attackableTargets,
  canAttack,
  citiesOf,
  cityTiles,
  distance,
  incomeResOf,
  previewAttack,
  reachableTiles,
  recruitPriceOf,
  recruitSpawnCells,
  siegeTargets,
  unitAt,
  unitsOf,
  upgradeCostOf,
  utype,
  unitYield,
} from '../src/core/rules.ts';
import { canUseType, eraWindowOk } from '../src/core/draft.ts';
import type { Action, City, GameState, PlayerId, Unit, UnitTypeDef } from '../src/core/types.ts';
import type { AiBudget } from '../src/core/ai-meta.ts';

/** 保留城"看见"敌军的半径（格）。雾图里大约是这么远，这里取一个保守值 */
const VISION = 4;
/** 规则 ③ 的判定窗口：三回合内买得起就算"该攒了" */
const SAVE_WINDOW = 3;
/** 放弃城最多放几个小兵去拖时间 */
const ABANDON_SQUAD = 3;
/** 规则 ⑤ 从第几代开始总攻 */
const PUSH_ERA = 4;

/** "看着最能打"：攻击 × 血量的平方根 × 射程系数（人看面板也就这么估） */
function punch(d: UnitTypeDef): number {
  return (d.atk + (d.magicAtk ?? 0) * 1.2) * Math.sqrt(Math.max(1, d.maxHp)) * (1 + ((d.range ?? 1) - 1) * 0.4);
}

/** 一片地上这个兵每回合能产多少金币 */
function goldAt(s: GameState, u: Unit, x: number, y: number): number {
  return unitYield(s, { ...u, x, y }).gold ?? 0;
}

/**
 * 放弃城：离敌方城市最近的那座。
 *
 * 用 `seed:座位` 记住，不再重算——规则 ① 说的是"**开局**放弃一座城"，
 * 而重算会随着战线下移不断改主意，那就成了另一个策略（见文档里"AI 的毛病
 * 就是每回合重新决定"）。同一 seed 的同一方永远得到同一座城，可复现。
 */
const abandonedMemo = new Map<string, string | null>();
function abandonedIdOf(s: GameState, me: PlayerId): string | null {
  const key = `${s.seed}:${me}`;
  if (abandonedMemo.has(key)) return abandonedMemo.get(key) ?? null;
  const mine = citiesOf(s, me).filter((c) => !c.ruined);
  if (mine.length < 2) {
    abandonedMemo.set(key, null);
    return null;
  }
  const foes = s.cities.filter((c) => c.owner !== me);
  const pick = [...mine].sort((a, b) => {
    const da = Math.min(...foes.map((f) => distance(a, f)));
    const db = Math.min(...foes.map((f) => distance(b, f)));
    return da - db || a.id.localeCompare(b.id);
  })[0];
  const id = pick?.id ?? null;
  abandonedMemo.set(key, id);
  return id;
}

/** 能造的兵池（按某座城的时代筛） */
function poolAt(s: GameState, me: PlayerId, city: City): UnitTypeDef[] {
  return Object.values(s.unitTypes).filter(
    (d) => !d.summonedOnly && canUseType(s, me, d.id) && eraWindowOk(s, d, city.era),
  );
}

/** 买得起 + 出得来 */
function affordable(s: GameState, me: PlayerId, city: City, d: UnitTypeDef): boolean {
  if (recruitPriceOf(s, me, d).gold > s.players[me].gold) return false;
  return recruitSpawnCells(s, city.id, undefined, d.id).length > 0;
}

/** 按规则在指定城市造一个兵（找不到就 null） */
function recruitAt(
  s: GameState,
  me: PlayerId,
  city: City,
  filter: (d: UnitTypeDef) => boolean,
  rank: (a: UnitTypeDef, b: UnitTypeDef) => number,
): Action | null {
  const pick = poolAt(s, me, city).filter(filter).filter((d) => affordable(s, me, city, d)).sort(rank)[0];
  if (!pick) return null;
  return { type: 'RECRUIT', cityId: city.id, unitType: pick.id };
}

/** 城格被自己人站满了：挪一个人出来（否则产兵停摆——上一版脚本栽在这） */
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

/** 打得到就打：能一击打死优先，否则打最近的 */
function attackAction(s: GameState, me: PlayerId): Action | null {
  let best: { u: Unit; t: Unit; score: number } | null = null;
  for (const u of unitsOf(s, me)) {
    if (!canAttack(u) || u.acted) continue;
    for (const t of attackableTargets(s, u)) {
      const kill = previewAttack(s, u, t).toDefender >= t.hp;
      const score = (kill ? 10_000 : 0) + (utype(s, t.type).cost ?? 0) - distance(u, t) * 0.01;
      if (!best || score > best.score) best = { u, t, score };
    }
  }
  if (!best) return null;
  return { type: 'ATTACK', unitId: best.u.id, targetId: best.t.id };
}

/** 贴着敌城就砸，挑血最少的 */
function siegeAction(s: GameState, me: PlayerId): Action | null {
  for (const u of unitsOf(s, me)) {
    if (!canAttack(u) || u.acted) continue;
    const cities = siegeTargets(s, u);
    if (cities.length === 0) continue;
    const target = [...cities].sort((a, b) => a.hp - b.hp)[0]!;
    return { type: 'SIEGE', unitId: u.id, cityId: target.id };
  }
  return null;
}

/** 经济单位往最赚钱的格子上挪（不超过一步能到的地方） */
function shuffleEarner(s: GameState, u: Unit): Action | null {
  const def = utype(s, u.type);
  if (def.category !== 'economy' || u.moved) return null;
  const now = goldAt(s, u, u.x, u.y);
  let best: { x: number; y: number; g: number } | null = null;
  for (const idx of reachableTiles(s, u).keys()) {
    const x = idx % s.w;
    const y = Math.floor(idx / s.w);
    if (unitAt(s, x, y)) continue;
    const g = goldAt(s, u, x, y);
    if (g > now && (!best || g > best.g)) best = { x, y, g };
  }
  if (!best) return null;
  return { type: 'MOVE', unitId: u.id, x: best.x, y: best.y };
}

/** 朝某个点走：能到的格里离它最近的那一个 */
function stepToward(s: GameState, u: Unit, tx: number, ty: number): Action | null {
  const here = Math.abs(u.x - tx) + Math.abs(u.y - ty);
  let best: { x: number; y: number; d: number } | null = null;
  for (const idx of reachableTiles(s, u).keys()) {
    const x = idx % s.w;
    const y = Math.floor(idx / s.w);
    if (unitAt(s, x, y)) continue;
    const d = Math.abs(x - tx) + Math.abs(y - ty);
    if (!best || d < best.d) best = { x, y, d };
  }
  if (!best || best.d >= here) return null;
  return { type: 'MOVE', unitId: u.id, x: best.x, y: best.y };
}

/**
 * 这条打法的下一步。签名与 `aiNextAction` 一致，好直接塞进对战台。
 */
export function holdNextAction(s: GameState, budget: AiBudget): Action | null {
  const me = s.current;
  const mine = unitsOf(s, me);
  const foes = unitsOf(s, other(me));
  const allCities = citiesOf(s, me).filter((c) => !c.ruined);
  const abandonedId = abandonedIdOf(s, me);
  const keep = allCities.filter((c) => c.id !== abandonedId);
  const keepCities = keep.length > 0 ? keep : allCities;
  const era = Math.max(0, ...allCities.map((c) => c.era));
  const gold = s.players[me].gold;
  const inc = incomeResOf(s, me).gold ?? 0;

  /** 敌军是否出现在某座城的视野里 */
  const threatAt = (city: City): boolean =>
    foes.some((e) => utype(s, e.type).category === 'combat' && distance(e, city) <= VISION);

  // ── 打得到就打、贴城就砸（任何阶段都先做，反正不花名额） ──
  const hit = attackAction(s, me);
  if (hit) return hit;
  const siege = siegeAction(s, me);
  if (siege) return siege;

  // ── 规则 ④ 先于生产：保留城被贴脸，先补防守兵 ──
  const threatened = keepCities.filter(threatAt);
  if (budget.recruited < budget.maxRecruit) {
    for (const city of threatened.sort((a, b) => a.hp - b.hp || a.id.localeCompare(b.id))) {
      const blocked = unblockCity(s, me, city);
      if (blocked) return blocked;
      // "低移速、高战力"：移速 ≤2 的重步兵档，用来兑子
      const c = recruitAt(
        s,
        me,
        city,
        (d) => d.category === 'combat' && d.domain !== 'water' && (d.move ?? 1) <= 2,
        (a, b) => punch(b) - punch(a) || (a.cost ?? 0) - (b.cost ?? 0),
      );
      if (c) return c;
      // 这条城造不出合格的重步兵（时代太早），退一步：造买得起的最强陆军
      const fallback = recruitAt(
        s,
        me,
        city,
        (d) => d.category === 'combat' && d.domain !== 'water',
        (a, b) => punch(b) - punch(a) || (a.cost ?? 0) - (b.cost ?? 0),
      );
      if (fallback) return fallback;
    }
  }

  // ── 规则 ⑤：第 4 代以后总攻 ──
  if (era >= PUSH_ERA) {
    if (budget.recruited < budget.maxRecruit) {
      for (const city of [...keepCities].sort((a, b) => b.era - a.era || a.id.localeCompare(b.id))) {
        const blocked = unblockCity(s, me, city);
        if (blocked) return blocked;
        // "当前时代、高价格"：买得起的最贵陆军（贵的通常就是这一代的主力）
        const c = recruitAt(
          s,
          me,
          city,
          (d) => d.category === 'combat' && d.domain !== 'water' && d.era === city.era,
          (a, b) => (b.cost ?? 0) - (a.cost ?? 0) || punch(b) - punch(a),
        );
        if (c) return c;
      }
      /*
       * 买不起当代主力（蒸汽/机械化的重装备动辄三五百金）时，**退一步买买得起的最强陆军**，
       * 而不是把钱变成农民。第一版没有这一条：总攻期撞上"当代兵太贵"，就掉到
       * 铺经济的分支里去了，追出 12 个农民、只有 3 个兵，被人一路推回来。
       * 规则 ⑤ 说的是"集中生产高价格单位"，不是"在没钱的时候改回种田"。
       */
      for (const city of [...keepCities].sort((a, b) => a.hp - b.hp || a.id.localeCompare(b.id))) {
        const c = recruitAt(
          s,
          me,
          city,
          (d) => d.category === 'combat' && d.domain !== 'water',
          (a, b) => punch(b) - punch(a) || (a.cost ?? 0) - (b.cost ?? 0),
        );
        if (c) return c;
      }
    }
    // 全军朝最近的敌城压
    const foeCities = s.cities.filter((c) => !c.ruined && c.owner !== me);
    const target = [...foeCities].sort((a, b) => a.hp - b.hp || a.id.localeCompare(b.id))[0] ?? null;
    if (target) {
      for (const u of mine) {
        if (utype(s, u.type).category !== 'combat' || u.moved) continue;
        const step = stepToward(s, u, target.x, target.y);
        if (step) return step;
      }
    }
  } else {
    // ── 还没到总攻时代：部队缩在保留城边上（规则 ④ 的"兑子防守"） ──
    const anchor = [...keepCities].sort((a, b) => b.era - a.era || a.hp - b.hp)[0] ?? null;
    if (anchor) {
      for (const u of mine) {
        if (utype(s, u.type).category !== 'combat' || u.moved) continue;
        if (distance(u, anchor) <= 3) continue; // 已经在家门口，不来回晃
        const step = stepToward(s, u, anchor.x, anchor.y);
        if (step) return step;
      }
    }
  }

  // ── 规则 ①：放弃城被围，放几个便宜小兵拖时间（最多 ABANDON_SQUAD 个） ──
  if (budget.recruited < budget.maxRecruit && abandonedId) {
    const city = allCities.find((c) => c.id === abandonedId);
    if (city && threatAt(city)) {
      const nearby = mine.filter(
        (u) => utype(s, u.type).category === 'combat' && Math.abs(u.x - city.x) <= 2 && Math.abs(u.y - city.y) <= 2,
      ).length;
      if (nearby < ABANDON_SQUAD) {
        const blocked = unblockCity(s, me, city);
        if (blocked) return blocked;
        const c = recruitAt(
          s,
          me,
          city,
          (d) => d.category === 'combat' && d.domain !== 'water' && (d.cost ?? 0) <= 120,
          (a, b) => (a.cost ?? 0) - (b.cost ?? 0),
        );
        if (c) return c;
      }
    }
  }

  // ── 规则 ③：三回合内买得起升级费 → 停止造农民，转入攒钱，够了就升 ──
  const upgradeTarget = [...keepCities].sort((a, b) => b.era - a.era || a.id.localeCompare(b.id))[0] ?? null;
  if (upgradeTarget) {
    const cost = upgradeCostOf(s, upgradeTarget);
    if (cost !== null) {
      if (gold >= cost && budget.upgraded < budget.maxUpgrade) {
        return { type: 'UPGRADE', cityId: upgradeTarget.id };
      }
      /*
       * "三回合内买得起"才转入攒钱。注意这里是 `gold + 3×收入 ≥ 费用`，
       * 不是"够不够买一个兵"——规则 ③ 的原话是"3 回合内能升级"。
       * 攒钱期只做一件事：忍住不造经济单位（但不禁止规则 ④ 的防守兵，
       * 那条在上面已经先跑过了）。
       */
      if (gold + inc * SAVE_WINDOW >= cost) {
        // 攒钱期：经济单位该挪就挪，其余什么都不造
        for (const u of mine) {
          if (utype(s, u.type).category !== 'economy') continue;
          const mv = shuffleEarner(s, u);
          if (mv) return mv;
        }
        return null;
      }
    }
  }

  // ── 规则 ②：前期全力铺经济（进了总攻时代就不再铺了） ──
  if (era < PUSH_ERA && budget.recruited < budget.maxRecruit) {
    for (const city of [...keepCities].sort((a, b) => b.era - a.era || a.id.localeCompare(b.id))) {
      const blocked = unblockCity(s, me, city);
      if (blocked) return blocked;
      const c = recruitAt(
        s,
        me,
        city,
        (d) => d.category === 'economy',
        (a, b) => (b.income ?? 0) - (a.income ?? 0) || (a.cost ?? 0) - (b.cost ?? 0),
      );
      if (c) return c;
    }
  }

  // ── 经济单位往最赚钱的格子上挪 ──
  for (const u of mine) {
    const mv = shuffleEarner(s, u);
    if (mv) return mv;
  }
  return null;
}

function other(p: PlayerId): PlayerId {
  return p === 'A' ? 'B' : 'A';
}

/** 给探针/诊断用：这条打法现在处于哪个阶段 */
export function holdPhaseOf(s: GameState): string {
  const me = s.current;
  const all = citiesOf(s, me).filter((c) => !c.ruined);
  const era = Math.max(0, ...all.map((c) => c.era));
  if (era >= PUSH_ERA) return '总攻';
  const keep = all.filter((c) => c.id !== abandonedIdOf(s, me));
  const gold = s.players[me].gold;
  const inc = incomeResOf(s, me).gold ?? 0;
  const t = [...keep].sort((a, b) => b.era - a.era)[0];
  const cost = t ? upgradeCostOf(s, t) : null;
  if (cost !== null && gold + inc * SAVE_WINDOW >= cost) return '攒钱升城';
  return '铺经济';
}
