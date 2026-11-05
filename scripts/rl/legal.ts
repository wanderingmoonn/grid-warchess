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
 * ── v2：补齐了六类动作（v1 只枚举 6 类）─────────────────────────────────
 *
 * v1 只列 MOVE / ATTACK / SIEGE / RECRUIT / UPGRADE / END_TURN，后果是
 * **老 AI 有 7.0% 的决策做不出来**（盖建筑、上下船、英雄技能、遣散、放蛋）——
 * 这些步在模仿数据里只能整条丢掉，策略也就永远学不会"造塔"和"过河"。
 * v2 补上了 BUILD / LOAD / UNLOAD / HERO_SKILL / DISBAND / PLACE_EGG。
 *
 * 三类仍然不枚举，理由写在各处：
 *   · 需要**选点**的技能（`targeting: 'point' | 'direction'`）：一个技能乘上全图格子，
 *     动作空间会炸开，而这类技能在现有兵种表里极少；
 *   · 残血清空才划算的 DISBAND：只在"满血、真能回收钱"时列出，
 *     否则每回合凭空多出十几个垃圾候选，把 softmax 的分母摊薄；
 *   · 指挥官模式的 SET_ORDERS / 选卡的 DRAFT_*：它们不是"一步棋"，是另一套入口。
 */
import {
  SKILL_EFFECTS,
  blockedFor,
  buildSiteError,
  canStrike,
  cityById,
  citiesOf,
  coversTile,
  distance,
  distToCity,
  disbandRefundOf,
  effectiveRangeAgainst,
  eggSpots,
  heroBlocked,
  heroSkillsOf,
  reachableTiles,
  rebuildCost,
  recruitPriceOf,
  recruitResCost,
  recruitSpawnCells,
  supplyEraAt,
  tileAt,
  underConstruction,
  unitAt,
  unitById,
  upgradeCostOf,
  utype,
} from '../../src/core/rules.ts';
import { CONFIG } from '../../src/core/config.ts';
import { canHold, holdOf, holdRoom } from '../../src/core/carry.ts';
import { canUseType, eraWindowOk } from '../../src/core/draft.ts';
import { canPay } from '../../src/core/resources.ts';
import {
  canProduce,
  isProducer,
  produceCooldownLeft,
  produceCostScale,
  produceUsableCount,
  scaleCost,
} from '../../src/core/produce.ts';
import type { Action, GameState, PlayerId, Unit, UnitTypeDef } from '../../src/core/types.ts';
import type { ResourceCost } from '../../src/core/resources.ts';

/*
 * 这里本来有一个 `blockedByAlly`，自己扫一遍"格子上有没有友军"。删掉的原因值得记：
 *
 * `reachableTiles` 返回的**已经是**"能停下的格子"——它在内部按 `blockedAnchor` 过滤过，
 * 而那套判据比"有没有友军"细得多：不同飞行层不占位、自家的塔/军营/桥可以站、
 * 墙连自己人也停不上去、敌方建筑要先打掉。
 *
 * 自己再写一遍"有友军就挡"的后果是**过度过滤**：实测老师 4.0% 的 MOVE 落空，
 * 98/99 都落在自家桥上——引擎允许站，枚举把它踢掉了。判据只能有一处。
 */
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

  // ── 建造：工兵在附近盖建筑 ────────────────────────────────────────────
  //
  // 落点用 `buildSiteError` 判——和 doBuild 是同一份判据。以前 AI 那边复制过
  // 一套"扫周围九格"的检查，规则一改它就过期，于是 AI 提了一个必被拒绝的
  // BUILD，整回合中断。这里不重犯：位置合法性只问规则。
  //
  // 范围照 AI 的 `buildSpots`：桥要多往外两格（三格宽的河心，岸上的工兵够不着）。
  for (const u of mine) {
    const def = utype(s, u.type);
    if (!def.builds || def.builds.length === 0) continue;
    if (u.acted) continue;
    const reach = def.bridges ? CONFIG.buildRange + 2 : CONFIG.buildRange;
    for (const buildId of def.builds) {
      const maybe = s.unitTypes[buildId];
      if (!maybe || maybe.category !== 'building') continue;
      if (!canUseType(s, seat, buildId)) continue;
      // 收窄之后存一份带类型的局部量：闭包里的类型收窄不可靠
      const bdef: UnitTypeDef = maybe;
      // doBuild 会先问一句"这个产兵点在当前时代建起来有没有用"，
      // 没用直接拒（提前修七代船坞 = 花 460 金买块石头）。
      // 注意问的是**落点**的时代供货，不是工兵脚下那格——doBuild 用的是
      // `supplyEraAt(s, s.current, { x, y })`，所以这一句必须放进格子循环里。
      const eraOk = (x: number, y: number): boolean =>
        produceUsableCount(bdef, s.unitTypes, supplyEraAt(s, seat, { x, y })) !== 0;
      for (let dy = -reach; dy <= reach; dy++) {
        for (let dx = -reach; dx <= reach; dx++) {
          if (dx === 0 && dy === 0) continue;
          const x = u.x + dx;
          const y = u.y + dy;
          if (!tileAt(s, x, y)) continue;
          if (buildSiteError(s, bdef, u, x, y)) continue;
          // 续建：目标格上是自家的同型工地时 doBuild 不收费（两个工兵叠进度）。
          // 其余情况才要过钱关——漏了这一步会枚举出一堆"点下去说资源不足"。
          const site = s.units.find(
            (o) => o.type === buildId && o.owner === seat && underConstruction(o) && coversTile(s, o, x, y),
          );
          if (!eraOk(x, y)) continue;
          if (!site && !canPay(s.players[seat], recruitResCost(s, seat, bdef))) continue;
          out.push({ type: 'BUILD', unitId: u.id, unitType: buildId, x, y });
        }
      }
    }
  }

  // ── 上船 / 下船 ───────────────────────────────────────────────────────
  for (const ferry of mine) {
    const fdef = utype(s, ferry.type);
    if (!holdOf(fdef)) continue;
    if (ferry.acted) continue; // 一条船一回合只能装卸一次

    // 上船：贴着船的自家单位
    if (holdRoom(fdef, ferry) > 0) {
      for (const cargo of mine) {
        if (cargo.id === ferry.id) continue;
        if (cargo.acted) continue;
        if (distance(ferry, cargo) !== 1) continue;
        if (!canHold(fdef, utype(s, cargo.type)).ok) continue;
        out.push({ type: 'LOAD', unitId: ferry.id, cargoId: cargo.id });
      }
    }

    // 下船：货舱里的人放到相邻空地
    for (const cargo of ferry.cargo ?? []) {
      // 范围要按"船体最大边长 + 1"扫，再用 `distance(ferry, 格)` 判是不是真的贴着：
      // 2×2 的大舰锚点在左上角，周围 3×3 里有一半是斜角、够不着，
      // 只按锚点加减 1 会枚举出一堆"只能在船边一格下船"。
      const spread = 3;
      for (let dy = -spread; dy <= spread; dy++) {
        for (let dx = -spread; dx <= spread; dx++) {
          const x = ferry.x + dx;
          const y = ferry.y + dy;
          if (!tileAt(s, x, y)) continue;
          if (distance(ferry, { x, y }) !== 1) continue;
          if (unitAt(s, x, y)) continue;
          if (blockedFor(s, x, y, cargo)) continue;
          out.push({ type: 'UNLOAD', unitId: ferry.id, cargoId: cargo.id, x, y });
        }
      }
    }
  }

  // ── 英雄技能 ──────────────────────────────────────────────────────────
  //
  // 只列**不需要选点**的（`targeting` 缺省或 'none'）：一个点地技能乘上全图格子，
  // 动作空间会炸开。这条限制写在文件头，评估要跟着说明。
  //
  // 就绪判据走 `heroSkillsOf`：它已经把冷却、充能、以及扩展注册的
  // `SKILL_READY_CHECKS` 都算进去了——界面上的按钮亮不亮也是它决定的，
  // 三处读同一份，才不会出现"点了说没准备好"。
  for (const u of mine) {
    for (const info of heroSkillsOf(s, u)) {
      if (!info.ready) continue;
      const skill = info.def;
      if (skill.targeting === 'point' || skill.targeting === 'direction') continue;
      if (!skill.multiCast && u.skillTurn === s.turn) continue;
      // doHeroSkill 最后一道关：效果没注册就直接拒
      if (!SKILL_EFFECTS[skill.effect]) continue;
      out.push({ type: 'HERO_SKILL', unitId: u.id, skillId: skill.id });
    }
  }

  // ── 遣散 / 拆除 ───────────────────────────────────────────────────────
  //
  // 只在**满血、真能回收钱**时列：残血拆掉一分钱不给，而"每回合凭空多出
  // 十几个垃圾候选"会把 softmax 的分母摊薄，学起来更慢。
  for (const u of mine) {
    if ((u.cargo?.length ?? 0) > 0) continue; // 船里还有人就别拆
    const def = utype(s, u.type);
    // 只给建筑和经济单位：它们的"拆了换钱"是真决策（塔挡路、农民没活干），
    // 而给每个战斗单位都挂一条 DISBAND 会让动作空间平白多出两成垃圾候选
    // （实测：不设限时 DISBAND 占全部枚举动作的 23%，战斗选项被挤出 top-K）。
    if (def.category !== 'building' && def.category !== 'economy') continue;
    if (disbandRefundOf(s, u) <= 0) continue;
    out.push({ type: 'DISBAND', unitId: u.id });
  }

  // ── 放蛋（不死鸟倒下之后那一枚）────────────────────────────────────────
  if (s.pendingEgg && s.pendingEgg.owner === seat) {
    for (const spot of eggSpots(s)) out.push({ type: 'PLACE_EGG', x: spot.x, y: spot.y });
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
