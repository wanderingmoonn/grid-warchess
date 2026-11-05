/**
 * 规则引擎。整个游戏的唯一真相来源。
 *
 * 铁律：
 *   1. 这个文件里不许出现 document、window、fetch、Date.now、Math.random。
 *   2. 每个函数要么是纯查询，要么返回一份新的 state，绝不原地修改。
 *   3. 任何非法操作都必须返回明确的失败原因，而不是抛异常或静默忽略。
 *
 * 扩展规则通过 expansions.ts 的钩子挂进来，本文件不认识任何具体扩展，
 * 只知道"在这些时机问一下所有启用的扩展"。
 */

/**
 * 能力钩子。
 *
 * 这里只"在正确的时机问一句"，不问"你是哪条能力"——具体怎么算由能力自己回答
 * （见 ability-hooks.ts 的说明）。以前这一层是一长串 `if (hasAbility(def,'xxx'))`，
 * 于是每加一个扩展兵种都要改这个文件，rules.ts 慢慢变成了一张兵种清单。
 */
import {
  ARMOR_STAGE,
  BURN_MAX_LAYERS,
  DAMAGE_STAGE,
  DIRS,
  HIT_STAGE,
  STRIKE_STAGE,
  TURN_START,
  runStaged,
} from './ability-hooks.ts';
import type {
  AbilityHooks,
  AbilityApi,
  DeathCtx,
  HitCtx,
  HookCtx,
  KillCtx,
  SiegeDamageCtx,
  SiegeLootCtx,
  Side,
  Staged,
  StatItem,
  StrikeCtx,
  TurnStartCtx,
} from './ability-hooks.ts';
import { aurasOf, canBeHealed, hasAbilityIn, hasFlag, hooksFor, stagedFor } from './ability-registry.ts';
import type { StagedKey } from './ability-registry.ts';
import {
  CITY,
  CONFIG,
  ERAS,
  ORDER_IDLE,
  ORDER_UPGRADE,
  buildCostOf,
  buildPowerOf,
  eraDef,
  isPseudoUnit,
  navigable,
  nextUpgradeCost,
  passable,
} from './config.ts';
import { LAST_STAND_BONUS, activeExpansions, eraCeilingOf, lockedEraPacks } from './expansions.ts';
import { canHold, holdOf, holdRoom } from './carry.ts';
import {
  noteHeatAt, 
  noteHeatCell, 
  strikeCoverCells 
} from './heat.ts';
// 格子上留下的东西（水雷/地雷/火场……）。注册表要在这里 import 一次：
// 它的副作用就是把各扩展声明的种类登记进全局表，没这两行 marks 一条都查不到。
import { enterTile, marksOf, tickMarks } from './marks.ts';
import type { MarkApi } from './marks.ts';
import './mark-registry.ts';
import {
  canProduce,
  isProducer,
  produceCooldownLeft,
  produceCostScale,
  produceOf,
  producePop,
  produceUsableCount,
  scaleCost,
} from './produce.ts';
import {
  applyDraftAction,
  canUseType,
  draftInProgress,
  eraWindowOk,
} from './draft.ts';
import {
  GOLD,
  addRes,
  canPay,
  cleanCost,
  costLabel,
  missingLabel,
  payRes,
  type ResourceCost,
  incomeLabel
} from './resources.ts';
import type {
  ActionResult,
  Action,
  City,
  Element,
  FallenRecord,
  GameState,
  OrderDirective,
  SkillDef,
  PlayerId,
  ResourceId,
  Terrain,
  Tile,
  Unit,
  UnitTypeDef,
} from './types.ts';
import { seatsOf, skillsOf } from './types.ts';
export { seatsOf };
import { SKILL_EFFECTS, registerSkillEffect, SKILL_READY_CHECKS } from './skill-hooks.ts';
import type { SkillCtx, SkillHandler } from './skill-hooks.ts';
import {
  idx, 
  xyOf, 
  inBounds, 
  distance, 
  underConstruction, 
  footprintOf, 
  coversTile, 
  tilesOfUnit,
  distToUnit, 
  distBetweenUnits,
} from './query.ts';
// 重新导出，保持兼容
export { SKILL_EFFECTS, registerSkillEffect };
export type { SkillCtx, SkillHandler };
export {
  idx, 
  xyOf, 
  inBounds, 
  distance, 
  underConstruction, 
  footprintOf, 
  coversTile, 
  tilesOfUnit,
  distToUnit,
  distBetweenUnits,
} from './query.ts';

// 四方向移动。不用八方向是为了让移动力有真实取舍，斜穿会削弱地形作用。
// （DIRS 现在定义在 ability-hooks.ts：扩展写能力时也要用它遍历四邻，
//   放在接口层两边都能拿到，不用各自抄一份。）

/**
 * 这一格是不是临水。
 *
 * 桥面也算"临水"：桥底下就是河，军营扎在桥头是有水可用的。
 * 做成对外导出的判断，是因为它不只是一条合法性检查——
 * 地图生成、AI 选址、界面高亮都要用同一套口径，各写一份必然走偏。
 */
export function adjacentToWater(s: GameState, x: number, y: number): boolean {
  return DIRS.some(([dx, dy]) => {
    const t = tileAt(s, x + dx, y + dy);
    if (!t) return false;
    // 临水就是临水，不分深浅：浅流踩得过去、深水只有船能进，
    // 但"挨着水"这件事对贸易、港口、造船位是一回事。
    // 浅流漏判过一次（农民站在渡口边上拿不到河运加成），和桥那次是同一类错。
    return t.terrain === 'water' || t.terrain === 'deep' || t.terrain === 'shallow' || t.terrain === 'bridge';
  });
}

// ── 能力查找的"带实例"版本 ────────────────────────────
//
// ability-registry 的 hooksFor/hasFlag/stagedFor/aurasOf/canBeHealed 只吃 def，
// 但实例上可能动态挂了能力（如修士 rank 4 自动获得的「灵体道果」）。这一组
// helper 把"实例的 extraAbilities"合并进去，让规则层各处统一使用。
//
// 只在这些地方调用：手里**已经有 Unit 对象**时。手里只有 def 的场合
// （canStandAt / recruitSpawnCells / eggSpots 等"还没生成单位"的判定）
// 继续走原函数——那些地方的 extra 必然为空，合并也没意义。
function hooksOfUnit(s: GameState, u: Unit): AbilityHooks[] {
  return hooksFor(utype(s, u.type), u.extraAbilities);
}
function stagedOfUnit<C>(s: GameState, u: Unit, key: StagedKey): Staged<C>[] {
  return stagedFor<C>(utype(s, u.type), key, u.extraAbilities);
}
function hasAbilityOn(s: GameState, u: Unit, id: string): boolean {
  return hasAbilityIn(utype(s, u.type), id, u.extraAbilities);
}
function hasFlagOn(s: GameState, u: Unit, flag: 'passThrough' | 'crossesWater' | 'airLayer' | 'immuneSplash' | 'noCounter'): boolean {
  return hasFlag(utype(s, u.type), flag, u.extraAbilities);
}
function aurasOfUnit(s: GameState, u: Unit): NonNullable<AbilityHooks['aura']>[] {
  return aurasOf(utype(s, u.type), u.extraAbilities);
}
function canBeHealedOn(s: GameState, u: Unit): boolean {
  return canBeHealed(utype(s, u.type), u.extraAbilities);
}

/**
 * 注入给能力实现的那套工具。
 *
 * 扩展里的能力**不 import rules**：一是会形成运行时循环依赖（rules → 扩展 → rules），
 * 二是扩展一旦能手抓内核，它就会开始依赖内核内部细节，"写在扩展里"就只剩个位置。
 * 所以内核把自己的能力整理成这张小接口递过去，扩展只认这张接口。
 */
const abilityApi: AbilityApi = {
  utype,
  tileAt,
  distance,
  strikeDistance,
  canStandAt,
  freeNeighbor,
  // 所有"凭空出现"的单位都从这条路走（召唤 / 分裂 / 孵化 / 裂殖 / 聚合）。
  // 在这里统一打标记，比让五个调用点各自记得打要可靠。
  spawn: (s, owner, type, x, y) => {
    const u = makeUnit(s, owner, type, x, y);
    u.summoned = true;
    s.units.push(u);
  },
  pushLog,
  citiesOf,
  distToCity,
  cityName,
  hashPick,
  hasAbility: (s, u, id) => hasAbilityOn(s, u, id),
  canBeHealed: (s, u) => canBeHealed(utype(s, u.type), u.extraAbilities), 
  putStatus: (target, key, turns) => {
    const st = (target.status ??= {});
    if ((st[key] ?? 0) >= turns) return false;
    st[key] = turns;
    return true;
  },
  addBurnLayer: (target) => {
    const st = (target.status ??= {});
    const now = st.burn ?? 0;
    if (now >= BURN_MAX_LAYERS) return 0;
    st.burn = now + 1;
    return st.burn;
  },
  computeDamage: (s, attacker, defender, isCounter) => computeDamage(s, attacker, defender, isCounter),
  splashRadiusOf: (s, u) => splashRadiusOf(s, u),
  attacksPerTurn: (s, u) => attacksPerTurn(s, u),
  killUnit: (s, victim, killer, logText) => {
    if (!s.units.some((u) => u.id === victim.id)) return; // 幂等
    s.units = s.units.filter((u) => u.id !== victim.id);
    pushLog(
      s,
      killer?.owner ?? other(victim.owner),
      logText ?? `${utype(s, victim.type).name} 被消灭`,
      true,
    );
    drownCargo(s, victim);
    fireKilled(s, victim, killer);
  },
  destroyCity: (s, city, attackerOwner) => destroyCity(s, city, attackerOwner),
  noteHeat: (s, x, y) => noteHeatCell(s, x, y),
  isAirborne: (s, u) => isAirborne(s, u),
  unitsAt: (s, x, y) => unitsAt(s, x, y),
  movePower: (s, u) => movePower(s, u),
};

/** 一条钩子 + 它挂在谁身上、站在哪一边 */
interface BoundHook<C> {
  stage: number;
  /** 写这条能力的人 */
  self: Unit;
  /** 它当时面对的对手（护甲/伤害阶段要拿来判属性、判距离） */
  foe: Unit | undefined;
  /** 这一下它是出手的，还是挨打的 */
  side: Side;
  hook: Staged<C>;
}

function bindHooks<C>(
  def: UnitTypeDef,
  self: Unit,
  foe: Unit | undefined,
  side: Side,
  key: 'armorPhase' | 'damage',
  extra?: string[],
): BoundHook<C>[] {
  const out: BoundHook<C>[] = [];
  for (const h of stagedFor<C>(def, key, extra)) out.push({ stage: h.stage, self, foe, side, hook: h });
  return out;
}

/**
 * 跑一组"绑好主人"的钩子。
 *
 * 为什么必须绑：同一个时机上，攻方的能力（冲锋、破甲）和守方的能力（盾墙、
 * 林地之主）改的是同一个 ctx。ctx.self 得临时指向**这条能力的主人**，
 * 否则盾墙会拿攻方的"这回合动没动"去判断，而穿隙会去扣自己的地形加成。
 */
function runBound<C extends { self: Unit; foe?: Unit; side: Side }>(
  list: BoundHook<C>[],
  ctx: C,
  range?: { from?: number; to?: number },
): void {
  const from = range?.from ?? -Infinity;
  const to = range?.to ?? Infinity;
  const picked = list.filter((b) => b.stage >= from && b.stage < to);
  if (picked.length === 0) return;
  picked.sort((a, b) => a.stage - b.stage);
  for (const b of picked) {
    const prevSelf = ctx.self;
    const prevFoe = ctx.foe;
    const prevSide = ctx.side;
    ctx.self = b.self;
    ctx.foe = b.foe;
    ctx.side = b.side;
    b.hook.apply(ctx);
    ctx.self = prevSelf;
    ctx.foe = prevFoe;
    ctx.side = prevSide;
  }
}

/**
 * 两人局专用：取另一个席位。
 *
 * 三人以上不要用它——那时候"敌人"不唯一，问 `others(s, p)` 或 `aliveSeats(s)`。
 * AI 的整套判断（威胁场、推进方向、集火目标）都建立在"只有一个对手"上，
 * 所以它只在 2 人局里出场（见 ai.ts 顶部那段），`other` 也就只服务于它。
 */
export function other(p: PlayerId): PlayerId {
  return p === 'A' ? 'B' : 'A';
}


/** 除自己以外的全部席位（含已出局的：战报、统计要看得见全场） */
export function others(s: GameState, p: PlayerId): PlayerId[] {
  return seatsOf(s).filter((x) => x !== p);
}

/**
 * 这一席是不是已经出局了。
 *
 * 两条：城被打光（胜负判定里的第一条），或者主动退出（认输 / 判弃权）。
 *
 * **上帝模式不算**：沙盒里"没城"是常态——玩家就摆几个兵在空地上试兵种，
 * 按城判出局会让回合推都推不动（这条以前是藏在 checkWinner 里的同一个特例，
 * 现在抽出来给回合轮转也用）。
 */
export function isEliminated(s: GameState, p: PlayerId): boolean {
  if (hasQuit(s, p)) return true;
  if (s.config.godMode === true) return false;
  return citiesOf(s, p).length === 0;
}

/** 还没出局的席位 */
export function aliveSeats(s: GameState): PlayerId[] {
  return seatsOf(s).filter((p) => !isEliminated(s, p));
}

/** 这一席是不是已经退出（认输 / 判弃权）。两人局里通常没人会走到这儿 */
export function hasQuit(s: GameState, p: PlayerId): boolean {
  return (s.out ?? []).includes(p);
}

/**
 * 下一个该行动的席位：按 PLAYER_ORDER 环转，跳过已经出局的。
 *
 * 三个人打，一个人出局之后，剩下两家的回合要接得上，不能空转到出局者身上。
 * 全部出局（或只剩自己）时返回自己——调用方（doEndTurn）在那之前就判完胜负了。
 */
export function nextSeat(s: GameState, from: PlayerId): PlayerId {
  const seats = seatsOf(s);
  const start = Math.max(0, seats.indexOf(from));
  for (let k = 1; k <= seats.length; k += 1) {
    const cand = seats[(start + k) % seats.length]!;
    if (cand === from) break;
    if (isEliminated(s, cand)) continue;
    return cand;
  }
  return from;
}

/** 从本局的兵种表里取定义（不是全局表，因为对局可能只启用了部分兵种） */
export function utype(s: GameState, id: string): UnitTypeDef {
  const def = s.unitTypes[id];
  if (!def) throw new Error(`本局没有兵种: ${id}`);
  return def;
}

export function tileAt(s: GameState, x: number, y: number): Tile | null {
  if (!inBounds(s, x, y)) return null;
  return s.tiles[idx(s, x, y)] ?? null;
}

// ── 地形高度：射程与机动的共同尺度 ────────────────────────────────────
//
// 高度**不是本体规则**，是「地形高差」扩展带来的。本体只提供两个钩子口：
//   · stepCostInto —— 走进一格的真实步耗（扩展在这里加爬坡费）
//   · effectiveRangeAgainst —— 对某个具体目标的射程（扩展在这里加高差修正）
// 没开那个扩展时两个口子都原样放行，步耗与射程与从前一模一样。

/** 某类地形在这一局里的高度：扩展没开就是 0（谁都一样高） */
export function heightOfTerrain(s: GameState, terrain: Terrain): number {
  for (const e of activeExpansions(s)) {
    const h = e.hooks.terrainHeight?.(terrain);
    if (typeof h === 'number') return h;
  }
  return 0;
}

/**
 * "从某类地形走进某类地形"的步耗：不带具体单位的那一版。
 *
 * AI 的地形距离图需要它（那张图是给全军用的静态图，没有"正在走的单位"）。
 * 单位相关的改价（穿林、重甲难行）不在这条路上——它们挂在能力钩子里，
 * 由 budgetMove 在真实移动时叠加。
 */
export function stepCostBetween(
  s: GameState,
  from: Terrain | null,
  to: Terrain,
): number {
  const base = CONFIG.terrainCost[to] ?? 99;
  if (base >= 99) return 99;
  let cost = base;
  for (const e of activeExpansions(s)) {
    if (!e.hooks.modifyStepCost) continue;
    const over = e.hooks.modifyStepCost({ state: s, unit: null, from, to, cost });
    if (over !== undefined) cost = over;
  }
  return cost;
}

/**
 * 从一格走进另一格的移动力消耗。
 *
 * 基础价来自地形表；扩展可以再加（爬坡）。`fromIdx < 0` 表示"没有来处"
 * （部署、凭空出现、只评估落点），这时只算地形价——没有坡可爬。
 * 水军和飞行不走这条：水军航道一格一步，飞行从空中过不看地面起伏。
 */
export function stepCostInto(
  s: GameState,
  unit: Unit,
  fromIdx: number,
  toIdx: number,
  opts: { waterUnit?: boolean; flyer?: boolean } = {},
): number {
  const to = s.tiles[toIdx];
  if (!to) return 99;
  if (opts.waterUnit || opts.flyer) return 1;
  const base = CONFIG.terrainCost[to.terrain] ?? 99;
  if (base >= 99) return 99;
  const from = fromIdx >= 0 ? (s.tiles[fromIdx] ?? null) : null;
  let cost = base;
  for (const e of activeExpansions(s)) {
    if (!e.hooks.modifyStepCost) continue;
    const over = e.hooks.modifyStepCost({
      state: s,
      unit,
      from: from?.terrain ?? null,
      to: to.terrain,
      cost,
    });
    if (over !== undefined) cost = over;
  }
  return cost;
}

/**
 * 对某个目标的实际射程：兵种射程（含天气等全局修正）+ 扩展给的"打它时"修正。
 */
export function effectiveRangeAgainst(
  s: GameState,
  attacker: Unit,
  targetTile: Tile | null,
): number {
  let range = effectiveRange(s, attacker);
  const targetTerrain = targetTile ? targetTile.terrain : null;
  for (const e of activeExpansions(s)) {
    if (!e.hooks.modifyRangeAgainst) continue;
    range = e.hooks.modifyRangeAgainst({ state: s, unit: attacker, targetTerrain, range });
  }
  return Math.max(1, range);
}

/**
 * 这一格上的单位。
 *
 * 同一格可能同时站着"建筑"和"站在建筑上的部队"（驻军、桥面）。
 * 优先返回**不是建筑**的那个：否则站在桥上的兵会被桥自己挡住——
 * 移动判定会说"那格已经有人了"，玩家看到的是一个明明站着自己的兵却动不了的格子。
 */
export function unitAt(s: GameState, x: number, y: number): Unit | undefined {
  let building: Unit | undefined;
  let air: Unit | undefined;
  for (const u of s.units) {
    if (!coversTile(s, u, x, y)) continue;
    const cat = s.unitTypes[u.type]?.category;
    if (cat === 'building') {
      building ??= u;
      continue;
    }
    // 空中层：它不算"占着这一格"。地面单位优先返回，
    // 因为"这一格站着谁"在绝大多数判定里问的是地面那个人（挡路、产兵格、踩地形）。
    if (isAirborne(s, u)) {
      air ??= u;
      continue;
    }
    return u;
  }
  return air ?? building;
}

/** 这一格上压在下面的那个（建筑优先）。强制选中/循环选中靠它。 */
export function lowestAt(s: GameState, x: number, y: number): Unit | undefined {
  let building: Unit | undefined;
  let ground: Unit | undefined;
  for (const u of s.units) {
    if (!coversTile(s, u, x, y)) continue;
    if (s.unitTypes[u.type]?.category === 'building') building ??= u;
    else if (!isAirborne(s, u)) ground ??= u;
  }
  return building ?? ground;
}

/** 这一格上的建筑（桥、塔、墙……）；没有就是 undefined */
export function buildingAt(s: GameState, x: number, y: number): Unit | undefined {
  return s.units.find(
    (u) => coversTile(s, u, x, y) && s.unitTypes[u.type]?.category === 'building',
  );
}



export interface BuildProgress {
  /** 已投入的点数 */
  done: number;
  /** 目标点数 */
  need: number;
  /** 每回合自动到账的点数 */
  rate: number;
  /** 还要几个自己的回合（按当前速率向下取整，至少 1） */
  turnsLeft: number;
  /** 0..1 */
  ratio: number;
}

/**
 * 一个工地的进度条数据。
 *
 * `turnsLeft` 是"按当前速率还要几个回合"的估算，给玩家看的——它不是规则，
 * 实际到账发生在自己回合开始时（advanceConstruction）。
 */
export function buildProgress(s: GameState, u: Unit): BuildProgress {
  const need = u.buildNeed ?? 0;
  const done = Math.min(u.buildDone ?? 0, need);
  const rate = Math.max(1, u.buildRate ?? buildPowerOf(utype(s, u.type)));
  const left = Math.max(0, need - done);
  return {
    done,
    need,
    rate,
    turnsLeft: left === 0 ? 0 : Math.max(1, Math.ceil(left / rate)),
    ratio: need > 0 ? done / need : 1,
  };
}

/**
 * 驻军加成：站在自家「可驻军」建筑上的部队多一层掩护。
 *
 * 为什么给护甲而不是"藏进建筑里"：藏进去要一整套进出动作和"里面的人算不算占格"
 * 的判定，而玩家真正想要的是"这座塔是个可以守的地方"。护甲 + 视野就是这句话。
 */
export function garrisonBonus(s: GameState, unit: Unit): number {
  const here = buildingAt(s, unit.x, unit.y);
  if (!here || here.owner !== unit.owner) return 0;
  if (here.id === unit.id) return 0;
  const d = utype(s, here.type);
  if (!d.garrison) return 0;
  if (underConstruction(here)) return 0;
  return CONFIG.garrisonArmor;
}

export function unitById(s: GameState, id: string): Unit | undefined {
  return s.units.find((u) => u.id === id);
}

export function unitsOf(s: GameState, p: PlayerId): Unit[] {
  return s.units.filter((u) => u.owner === p);
}

/**
 * 战斗单位数。**规则层不再拿它卡人**，只剩 AI 用它给自己设产兵上限。
 *
 * 编制只数战斗单位，建筑不算。以前的写法是"谁在场上都算一个编制"，
 * 于是盖了四座磨坊 + 两座军营，编制就先去掉了六个，产线直接堵死——
 * 模拟里出现过一方 24 个单位里只有 4 个能打仗、金库压着一万二，
 * 然后就再也造不出兵、也打不下城，两边耗到第 200 回合。
 * 建筑本来就不该住人：它是工地，不是部队。
 */
export function armySize(s: GameState, p: PlayerId): number {
  // 召唤物不占编制：它们不是招募来的，用编制去卡它们只会让死灵法师
  // 反过来把自己的产线堵死（招满四个骷髅，城市就再也造不出兵）。
  // 它们的上限由召唤者自己的 summon.max 管。
  let n = 0;
  for (const u of s.units) {
    if (u.owner !== p) continue;
    const d = utype(s, u.type);
    if (d.category === 'building') {
      // 建筑一般不计编制，但产兵点可以按数据吃编制（produce.pop）：
      // 一座能就地补兵的前线基地，本来就该占掉你一格常备名额。
      n += producePop(d);
      continue;
    }
    if (d.summonedOnly || u.summoned) continue;
    n += 1;
  }
  return n;
}

export function cityById(s: GameState, id: string): City | undefined {
  return s.cities.find((c) => c.id === id);
}

/** 某格属于哪座城市 */
export function cityAt(s: GameState, x: number, y: number): City | undefined {
  const tile = tileAt(s, x, y);
  if (!tile?.cityId) return undefined;
  return cityById(s, tile.cityId);
}

/** 某方控制的城市 */
/** 接管一座废墟要花的重建费：按城市的耐久规模算，越高级的城越贵 */
export function rebuildCost(city: City): number {
  return Math.round(city.maxHp * 2.5);
}

export function citiesOf(s: GameState, p: PlayerId): City[] {
  return s.cities.filter((c) => c.owner === p);
}

/** 城市占的全部格子坐标 */
export function cityTiles(city: City): Array<{ x: number; y: number }> {
  const out: Array<{ x: number; y: number }> = [];
  for (let dy = 0; dy < city.size; dy++) {
    for (let dx = 0; dx < city.size; dx++) out.push({ x: city.x + dx, y: city.y + dy });
  }
  return out;
}

/**
 * 这一局的城市边长（缺省 2，扩展可以要求 3）。
 *
 * 读 config 而不是 CITY.size：城市会大到 3×3，而"建一座城要占几格"
 * 在建城、画城、摆城（沙盒）三处都要问，各读各的常量迟早对不上。
 */
export function citySizeOf(s: GameState): number {
  const n = Math.round(s.config.citySize ?? CITY.size);
  if (!Number.isFinite(n) || n < CITY.size) return CITY.size;
  return n;
}

/** 单位到城市方块的最短曼哈顿距离 */
export function distToCity(unit: { x: number; y: number }, city: City): number {
  const cx = Math.min(Math.max(unit.x, city.x), city.x + city.size - 1);
  const cy = Math.min(Math.max(unit.y, city.y), city.y + city.size - 1);
  return Math.abs(unit.x - cx) + Math.abs(unit.y - cy);
}

/**
 * 某方在某个位置「能拿到的最新军工」：离它最近的己方城市的时代。
 *
 * 军营落成时用它钉死自己的时代（见 doRecruit 的注释），界面和 AI 在
 * 旧存档（军营还没写 era）上也用它兜底。三处必须同一口径，所以只有这一份。
 */
export function supplyEraAt(
  s: GameState,
  owner: PlayerId,
  at: { x: number; y: number },
): number {
  const own = citiesOf(s, owner);
  if (own.length === 0) return 1;
  return own.reduce((a, b) => (distToCity(at, a) <= distToCity(at, b) ? a : b)).era;
}



export function cloneState(s: GameState): GameState {
  return structuredClone(s);
}

// ── 奇想兵种包：魔法、属性、状态 ─────────────────────────────────────────
//
// 这一整段只在"兵种自己写了对应字段"时才有非零结果，所以内置兵种
// 和旧扩展一个都不受影响。之所以可以无条件待在 rules.ts 里而不是挂在
// 扩展钩子上：钩子只能改数值，而状态、召唤、复活这些是**副作用**，
// 塞进纯函数钩子会让界面上的伤害预览偷偷改变游戏状态。
//
// 代价是规则层仍然"认识"这些机制；收益是它是纯的、可测的、存档不用记
// "这局有没有开魔法"。选中了「奇想·法则」这个前置包才让这些字段的兵进场，
// 于是前置包本身就成了总开关。

/**
 * 这个兵种在不在空中层。
 *
 * 读的是**类型字段** `layer`，不是扩展能力：飞行层是原版规则的一部分
 * （它决定"占不占格"，这件事渗进寻路、产兵位、攻击距离判断），
 * 不该由某个兵种包是否勾选来决定规则代码长什么样。
 *
 * 「掠空」这类能力可以再把它标成空中层（hooks.airLayer），
 * 那是给自定义兵种和旧数据留的路：老存档、老角色卡照常工作，
 * 新数据则应该直接写 `layer: 'air'`。
 */
export function airLayer(def: UnitTypeDef): boolean {
  /*
   * 三条判据，其实是同一件事的三种写法：
   *   · `layer: 'air'` —— 现在所有飞行单位都写这个；
   *   · `flight: true` —— 早先只有"能过水"这一个字段，没有层这个概念；
   *   · 能力钩子 `airLayer` —— 「掠空」和兵种编辑器捏出来的旧数据。
   *
   * `flight` 这一条是后补的，补它是因为**两个字段各说各话**会长出真 bug：
   * 只写 `flight: true`、忘写 `layer: 'air'` 的单位会变成"能飞过河、
   * 却是地面层"的怪胎——它会占地面格、被地面近战按普通单位打、
   * 面板上还标着"飞行"。数据里目前一个都没有（见 test-rules 的守卫用例），
   * 但只要规则允许这种状态存在，下一个人就会写出来。
   *
   * 所以现在：**会飞就是空中层**。想表达"能过水但仍在地面"（蜘蛛骑士那一跃），
   * 只能用能力（`leap` / `fly` 的 crossesWater 钩子），不能用 `flight` 字段。
   */
  return def.layer === 'air' || def.flight === true || hasFlag(def, 'airLayer');
}

/** 空中层：能飞，并且可以和地面单位同格 */
export function isAirborne(s: GameState, u: Unit): boolean {
  if (u.layer) return u.layer === 'air';
  return airLayer(utype(s, u.type));
}

/** 同一格上的全部单位。空中 + 地面最多各一个，可以叠在一格。 */
export function unitsAt(s: GameState, x: number, y: number): Unit[] {
  return s.units.filter((u) => coversTile(s, u, x, y));
}

/** 这一格上有没有"同一层"的单位（空中和地面互不占位） */
function sameLayerAt(s: GameState, x: number, y: number, air: boolean): Unit | undefined {
  return s.units.find((u) => coversTile(s, u, x, y) && isAirborne(s, u) === air);
}

/** 这个单位这一下的攻击属性（运行时覆盖优先，至尊法师轮换写的就是它） */
export function elementOf(s: GameState, u: Unit): Element | undefined {
  return u.element ?? utype(s, u.type).element;
}

/** 弹药打光了吗：没写 ammo 的兵种永远 false */
export function outOfAmmo(s: GameState, u: Unit): boolean {
  const def = utype(s, u.type);
  if (typeof def.ammo !== 'number') return false;
  return (u.ammoLeft ?? def.ammo) <= 0;
}

/**
 * 实际射程。
 *
 * 只有一种情况会和兵种表不一样：弹药打光。炼金术士扔完六瓶之后不是"废了"，
 * 而是"退回近战"——它还有 atk，只是不再有那一段魔法伤害。
 */
export function effectiveRange(s: GameState, u: Unit): number {
  const def = utype(s, u.type);
  if (typeof def.ammo === 'number' && outOfAmmo(s, u)) return 1;
  // 投斧：这一回合把射程拉长到技能给的值（矮人王 1 → 3）
  let range = u.heroBuff?.range ?? def.range;
  // 扩展可以再改（浓雾封顶、暴雨缩短）。放在技能之后，
  // 因为"天气"是场上条件，该对任何来源的射程一视同仁。
  for (const e of activeExpansions(s)) {
    if (e.hooks.modifyRange) range = e.hooks.modifyRange({ state: s, unit: u, range });
  }
  return Math.max(1, range);
}

/**
 * 攻击距离：**地面打空中时 +1**。
 *
 * 站在地上的兵够不着头顶那一层，要"往上多伸一格"才够得着。所以：
 *   · 射程 1 的步兵打不到**隔壁那格**的飞行单位；
 *   · 射程 2 的弓手只在"零到一格"内打得中，两格开外就够不着了；
 *   · 但飞行单位"压着打"（同一格）时距离算 0+1=1，脚下的兵还是能还手——
 *     这是「掠空」本来就有的交易：贴脸打会被反击，隔着一格才是安全的。
 * 空中打地面、空中打空中、地面打地面都按正常距离算。
 *
 * 攻击判定、反击判定、以及所有"隔几格才打折/才加成"的能力都读它，
 * 免得出现"射程算得到、伤害却按旧距离打折"这种两套账。
 */
export function strikeDistance(s: GameState, attacker: Unit, defender: Unit): number {
  // 多格单位按最近边算：打一座 2×2 兵营的右下角，本该是一格
  const d = distBetweenUnits(s, attacker, defender);
  if (!isAirborne(s, attacker) && isAirborne(s, defender)) return d + 1;
  return d;
}

/**
 * 这个单位现在的魔法攻击 / 魔法抗性。
 *
 * 兵种表上的值是"这一局这类兵的基础值"，而圣剑觉醒那类加成属于**这一个单位**
 * （和 atkBonus / armorBonus 同一个道理，见 types 里的注释）。
 * 魔法段是唯一一条只看魔抗、不看护甲的结算，两处各读各的话就会出现
 * "面板涨了、打出去的伤害没变"——所以取值只能有这两个函数。
 */
export function magicAtkOf(s: GameState, u: Unit): number {
  return (utype(s, u.type).magicAtk ?? 0) + (u.magicAtkBonus ?? 0);
}
export function magicResOf(s: GameState, u: Unit): number {
  return (utype(s, u.type).magicRes ?? 0) + (u.magicResBonus ?? 0);
}

/**
 * 这一下能打出多少魔法伤害。
 * 魔法段本身只被魔抗平减，
 * 不需要目标是个单位；只有「属性精研·暗」那种"按对手放大"的钩子需要它，
 * 没有对手时自然跳过。
 */
export function magicSegment(
  s: GameState,
  attacker: Unit,
  magicRes: number,
  foe: Unit | null,
): number {
  if (outOfAmmo(s, attacker)) return 0;
  const magic = magicAtkOf(s, attacker);
  if (magic <= 0) return 0;
  const out = Math.max(0, magic - magicRes);
  // 魔法段的倍率交给能力自己（现在只有「属性精研·暗」用它）。
  // 先减魔抗再放大——"打穿"和"放大"是两件事，顺序反过来对高魔抗目标会变成白送。
  let dmgMagic = out;
  if (!foe) return dmgMagic;
  for (const h of hooksOfUnit(s, attacker)) {
    if (h.magicMul) {
      dmgMagic = h.magicMul({ state: s, self: attacker, foe, magic: dmgMagic, api: abilityApi });
    }
  }
  return dmgMagic;
}

/** 这一下能打出多少魔法伤害：只被目标的魔法抗性挡，不吃护甲/地形/破甲 */
export function magicDamageOf(s: GameState, attacker: Unit, defender: Unit): number {
  // 攻城时传进来的是一条"伪单位"壳（把 City 包成 Unit 的形状喂给结算）。
  // 它不在这局的兵种表里——也不该在：城市不是一个能造、能选、能上场的兵种。
  // 城市没有魔法抗性可言，按 0 算；绝不能因为"查不到这个 id"把整条结算打断。
  const base = isPseudoUnit(defender.type) ? 0 : magicResOf(s, defender);
  // 圣旗之类"临时加魔抗"的增益在这条线上生效：魔法段是唯一一条
  // 只看魔抗、不看护甲的伤害，把增益挂在别处就等于没加。
  const ward = defender.buff?.magicRes ?? 0;
  return magicSegment(s, attacker, base + Math.max(0, ward), defender);
}

/**
 * 出手方的攻击力：基础 + 光环 + 状态修正（威吓、狂暴……）。
 * 单位和城市共用这一段——攻城时"我的兵被威吓了"照样该少打几下城墙，
 */
export function attackPowerNow(s: GameState, attacker: Unit): number {
  // 圣剑勇者这类"永久变强"的加成记在单位身上，不进兵种表（见 types 的 atkBonus）
  let atkNow = utype(s, attacker.type).atk + (attacker.atkBonus ?? 0) + auraBonus(s, attacker).atk;
  for (const [key, val] of orderedStatuses(attacker.status)) {
    const sdef = STATUS_REGISTRY[key];
    if (sdef?.modifyAtk) atkNow = sdef.modifyAtk(s, attacker, val, atkNow);
  }
  return atkNow;
}

/**
 * 属性倍率：弱点放大、抗性打折。
 *
 * 作用在**整段**伤害上（物理 + 魔法），所以必须放在魔法段之后。
 * 单位和城市共用：城没有 weak/resist 字段时这两行什么都不做。
 */
export function applyElementMul(
  damage: number,
  el: Element | undefined,
  weak?: Partial<Record<Element, number>>,
  resist?: Partial<Record<Element, number>>,
): number {
  if (!el) return damage;
  let out = damage;
  const w = weak?.[el];
  if (w && w > 0) out *= w;
  // 抗性和弱点一样是**倍率**：`weak` 放大（>1），`resist` 打折（0~1）。
  // 所以数据必须写成 0.7 这种形式——写成 4 不是"少挨 4 点"，是"受四倍伤害"。
  // 这条注释是踩过坑留下的：2026-10-28 改结算顺序时，代码换成倍乘、数据没跟着换，
  // 水元素抗性从 4 变成了 ×4，实测水元素互殴从 15 点涨到 60 点。
  const r = resist?.[el];
  if (r) out *= r;
  return out;
}

/**
 * 咒域：贴着几个带「咒域」的敌人，就少几点护甲（每层 2 点，最多两层）。
 *
 * 和威吓对称——威吓削攻击、咒域削护甲，两者都只惩罚"贴脸"，
 * 所以破解办法是同一个：拉开距离。一支只有咒域的部队打不赢，它只是让对面变脆。
 */
export function curseAuraPenalty(s: GameState, unit: Unit): number {
  let hit = 0;
  for (const foe of s.units) {
    if (foe.owner === unit.owner) continue;
    if (distance(foe, unit) !== 1) continue;
    for (const a of aurasOfUnit(s, foe)) {
      if (!a.foeArmor || a.foeArmor >= 0) continue;
      const cap = (a.maxLayers ?? Infinity) * -a.foeArmor;
      hit = Math.min(cap, hit - a.foeArmor);
    }
  }
  return hit;
}

import type { StatusDef } from './ability-hooks.ts';

export const STATUS_REGISTRY: Record<string, StatusDef> = {
  poison: {
    id: 'poison',
    name: '中毒',
    summary: '每回合掉 6% 生命上限',
    onTurnStart: (s, u, _val) => {
      const def = utype(s, u.type);
      const dmg = Math.ceil(maxHpOf(s, u) * 0.06);
      u.hp -= dmg;
      return `${def.name} 因中毒失去 ${dmg} 点生命`;
    },
  },
  burn: {
    id: 'burn',
    name: '灼烧',
    summary: '每层每回合掉 4 点生命（怕火翻倍）',
    onTurnStart: (s, u, val) => {
      const def = utype(s, u.type);
      const mul = Math.max(1, def.weak?.fire ?? 1);
      const dmg = val * BURN_PER_LAYER * mul;
      u.hp -= dmg;
      return `${def.name} 被灼烧（${val} 层）失去 ${dmg} 点生命`;
    },
  },
  slow: {
    id: 'slow',
    name: '减速',
    summary: '移动力 −1',
    // 原逻辑：只要 slow > 0，就扣 1 点移动
    modifyMove: (_s, _u, val, move) => (val > 0 ? move - 1 : move),
  },
  curse: {
    id: 'curse',
    name: '诅咒',
    summary: '护甲 −2',
    /*
     * 只要 curse > 0 就扣 2 点护甲（不看剩余回合——它是"诅咒还在"的二值判断）。
     *
     * 身上同时有「咒缚」时这里让位：两个减甲状态叠着算会变成 −6，
     * 而咒缚本来就是"更强的诅咒"，不是"再叠一层"。取强不取叠，
     * 玩家也不会因为被同一套技能打两下就突然多掉 4 点甲。
     */
    modifyArmor: (_s, u, val, armor) =>
      val > 0 && !(u.status?.['curse-deep'] ? u.status['curse-deep'] > 0 : false) ? armor - 2 : armor,
  },
  /*
   * 咒缚：2026-11-02 从"护甲 −2"上调为"护甲 −4"，单独成一个状态。
   *
   * 为什么不直接把 curse 改成 −4：curse 还被暗属性命中、诅咒师等一堆地方用着，
   * 改它等于给所有暗属性攻击白送一倍。这里只让「咒缚」这条能力变强。
   */
  'curse-deep': {
    id: 'curse-deep',
    name: '咒缚',
    summary: '护甲 −4',
    modifyArmor: (_s, _u, val, armor) => (val > 0 ? armor - 4 : armor),
  },
};

/**
 * 状态结算的固定顺序：中毒 → 灼烧 → 减速 → 诅咒。
 *
 * 前两条会写战报，顺序一乱，同一兵同时中两种状态时日志的行序就跟着变；
 * 而战报是玩家复盘时唯一的证据链，"这次到底先掉血还是先被烧"不该由
 * 对象里字段的写入顺序决定。扩展注册的状态排在后面，按注册先后。
 */
const STATUS_ORDER = ['poison', 'burn', 'slow', 'curse', 'curse-deep'];

/** 把身上的状态按固定顺序摊成 [id, 值]，只留 > 0 的 */
export function orderedStatuses(status: Unit['status']): Array<[string, number]> {
  if (!status) return [];
  const out: Array<[string, number]> = [];
  for (const k of STATUS_ORDER) {
    const v = status[k];
    if (typeof v === 'number' && v > 0) out.push([k, v]);
  }
  for (const [k, v] of Object.entries(status)) {
    if (STATUS_ORDER.includes(k)) continue;
    if (typeof v === 'number' && v > 0) out.push([k, v]);
  }
  return out;
}

/**
 * 注册一个持续状态（给扩展用）。
 *
 * 不提供覆盖：同 id 再注册一次直接抛。悄悄覆盖会让"两个包都想改中毒"
 * 变成按 import 顺序决定规则，这种 bug 最难查。
 */
export function registerStatus(def: StatusDef): void {
  if (Object.prototype.hasOwnProperty.call(STATUS_REGISTRY, def.id)) {
    throw new Error(`状态「${def.id}」已经注册过了`);
  }
  STATUS_REGISTRY[def.id] = def;
}

/**
 * 燃烧：每层每回合多少伤害。
 *
 * 从"按生命上限的百分比"改成固定值，是因为百分比对高血量单位太狠：
 * 九头蛇 115 血，8% 就是 9 点，一个 70 血的恶魔才 5 点——
 * 同一把火在体型大的身上烧得更旺，这件事在直觉上说不通，
 * 而且它让"怕火的巨型单位"直接没法上场。
 *
 * 现在叠层负责强度：挨一次火加一层，最多三层，每层 4 点，
 * 结算完掉一层。站着挨烤会越烧越旺，走出去两回合就熄了。
 */
export const BURN_PER_LAYER = 4;
// 层数上限也定义在 ability-hooks.ts（命中类能力要和这里用同一个上限），从这里转出去。
export { BURN_MAX_LAYERS };

/**
 * 攻击命中后把状态贴上去。返回贴上了哪几种，给战报用。
 *
 * 只在"真打出伤害、目标还活着"时生效：打不穿护甲的一下不该带毒，
 * 否则淬毒就成了"无视护甲的软刀"，那是另一条规则了。
 *
 * 燃烧是唯一**累加**的一条：反复打就反复加层，最多三层。
 * 其余三条都是"贴上时长"，重复命中只是续命——中毒不会因为被打三次就更毒。
 */
function applyOnHitStatus(s: GameState, attacker: Unit, target: Unit, dmg: number): string[] {
  if (dmg <= 0 || target.hp <= 0) return [];
  const touched: string[] = [];
  // 即使一条状态都没贴上，也要把 status 建出来：老实现在这里 `??= {}`，
  // 一旦哪天不建了，"空对象"和"没有字段"的区别会从存档和战报里漏出来。
  target.status ??= {};
  const st = target.status;
  /** 点燃一层；已经满了就不再报"点燃"（否则战报会天天说一件没发生的事） */
  const burn = () => {
    const now = st.burn ?? 0;
    if (now >= BURN_MAX_LAYERS) return;
    st.burn = now + 1;
    touched.push(now === 0 ? '点燃' : `点燃 ${st.burn} 层`);
  };

  const hitCtx: HitCtx = { state: s, self: attacker, target, damage: dmg, api: abilityApi, touched };
  const hitHooks = stagedOfUnit<HitCtx>(s, attacker, 'onHit');

  // 先跑"命中即贴"那批（淬毒/燃焰/霜缚/咒缚）
  runStaged(hitHooks, hitCtx, { to: HIT_STAGE.postStatus });

  // 空槽：普通状态之后，属性精研之前（150 ~ 199）
  runStaged(hitHooks, hitCtx, { from: HIT_STAGE.postStatus, to: HIT_STAGE.element });

  // 技能附带的属性效果（不死鸟俯冲是"这一下多点几层"）
  const layers = attacker.heroBuff?.burnLayers ?? 0;
  for (let i = 0; i < layers; i++) burn();

  // 转属性：这一回合的攻击带上切到的属性状态。
  //
  // 有「属性精研」这种能力的兵种跳过这一支——它按**当前属性**永久生效，
  // 两支都跑会让火属性一次叠两层，等于偷偷加强。判据不用点名能力：
  // 谁在 element 那一档自己挂了命中钩子，谁就是"常驻属性"，这里让位给它。
  if (!hitHooks.some((h) => h.stage >= HIT_STAGE.element)) {
    const el = attacker.heroBuff?.elementHit;
    if (el === 'fire') burn();
    else if (el === 'water') put(st, 'slow', 2, '减速', touched);
    else if (el === 'nature') put(st, 'poison', 3, '中毒', touched);
    else if (el === 'dark') put(st, 'curse', 3, '诅咒', touched);
  } else {
    // 属性精研
    runStaged(hitHooks, hitCtx, { from: HIT_STAGE.element, to: HIT_STAGE.postElement });
    // 属性精研之后
    runStaged(hitHooks, hitCtx, { from: HIT_STAGE.postElement });
  }

  return touched;
}

/** 贴一层持续状态：已经贴够时长就不重复报（战报只报真正发生的事） */
function put(
  st: NonNullable<Unit['status']>,
  key: 'poison' | 'burn' | 'slow' | 'curse',
  turns: number,
  label: string,
  touched: string[],
): void {
  if ((st[key] ?? 0) >= turns) return;
  st[key] = turns;
  touched.push(label);
}

/** 确定性抽样：规则层不许用 Math.random，随机召唤也得从种子派生 */
function hashPick(s: GameState, salt: number, n: number): number {
  const h =
    Math.imul(s.seed ^ 0x9e3779b9, 2654435761) ^
    Math.imul(s.turn + 1, 40503) ^
    Math.imul(salt + 1, 2246822519);
  return Math.abs(h) % Math.max(1, n);
}

/** 造一个单位对象。招募、召唤、分裂三条路都走这里，字段不会走散。 */
function makeUnit(s: GameState, owner: PlayerId, type: string, x: number, y: number): Unit {
  const def = utype(s, type);
  return {
    id: `u${s.nextUnitSeq++}`,
    type,
    owner,
    x,
    y,
    hp: def.maxHp,
    kills: 0,
    // 召唤物/分裂体出场即"这一回合不能动"：否则一个死灵法师每两回合
    // 就凭空多出一次攻击，等于它自己偷偷多打了一刀。
    moved: true,
    acted: true,
    ...(typeof def.ammo === 'number' ? { ammoLeft: def.ammo } : {}),
    // 卵一落地就开始倒计时：写在这里而不是"第一次回合开始"，
    // 否则每颗卵都会比自己写的 `turns` 多待一个回合。
    ...(def.hatch ? { hatchLeft: def.hatch.turns } : {}),
  };
}

export function maxHpOf(s: GameState, u: Unit): number {
  const base = utype(s, u.type).maxHp;
  return base + (u.maxHpBonus ?? 0);
}

/**
 * 这个兵种能不能掠水。
 *
 * 读 `flight` 字段（原版预留的机制字段），同时认三条旧能力 id：
 * 飞行、掠空、跳跃。后两者是「奇想」包早期的写法，也是兵种编辑器里
 * 那三个勾选框——不认识它们，玩家自己捏的飞行兵会当场失灵。
 *
 * 收在一个函数里，是因为漏掉任何一处都会长出那种只在特定局面才炸的 bug
 * （"蜘蛛能过河，但 AI 算不出它能过河"）。
 */
export function crossesWater(def: UnitTypeDef): boolean {
  // 空中层当然过水；其余的看能力（跳跃、旧版「飞行」）。
  // `flight` 字段不再单独出现在这里——它已经是空中层了（见 airLayer）。
  return airLayer(def) || hasFlag(def, 'crossesWater');
}

/**
 * 这个兵种能不能**走进**这一格——只看地形，不看占位与城市归属。
 *
 * 存在的理由：外面（AI 的出城判定、各种"走不走得过去"的估算）到处在写
 * `passable(tile.terrain)`，而 `passable` 说的是"**陆军**能不能走"：
 * 对它来说水永远是墙。于是水军（本来就活在水上）和掠水/飞行的兵
 * 在每个这样写的地方都会被判成"过不去"。
 *
 * 规则层的 `reachableTiles` 早就按兵种判了（`terrainOk`），所以这类 bug
 * 只出现在**旁路判断**上：能走，但 AI 和预览都说不能走。
 */
export function terrainWalkable(def: UnitTypeDef, terrain: Terrain): boolean {
  if (def.domain === 'water') return navigable(terrain);
  if (passable(terrain)) return true;
  // 掠水/飞行：水面、深水都能过（空中层连山都能过，这里只回答"水"这一档）
  return crossesWater(def) && (terrain === 'water' || terrain === 'deep');
}

/**
 * 这个兵种能不能站在这一格：地形可走、同层没单位。
 *
 * 导出是给沙盒（上帝模式）用的：那个模式可以凭空摆兵，但"摆得合不合理"
 * 必须和走子用同一条判断——否则会出现船停在山顶上这种局面，
 * 之后每一次寻路、每一发攻击都在跟它较劲。
 */
/**
 * 单格能不能站（不含占地展开）。
 *
 * 拆出来是因为 2×2 的单位/建筑要**逐格**过同一套判断：
 * 地形、城市归属、同层占位。写两份必然走样。
 */
function tileStandsOk(s: GameState, x: number, y: number, def: UnitTypeDef): boolean {
  const tile = tileAt(s, x, y);
  if (!tile) return false;
  if (def.domain === 'water') {
    if (!navigable(tile.terrain)) return false;
  } else if (!passable(tile.terrain)) {
    // 空中层：地形对它不存在，停哪儿都行（高山顶上也一样）。
    // 和 reachableTiles 的 terrainOk 是同一条判据——那两处一旦不一致，
    // 就会出现"飞得进去、停不下来"或者反过来。
    if (airLayer(def)) {
      // 不拦
    } else if ((tile.terrain === 'water' || tile.terrain === 'deep') && crossesWater(def)) {
      // 掠水（不是空中层）：能停在水面上，但爬不了山。
      // 河防对飞行本来就不成立，如果连落脚都不许，飞行就只是"绕着水走"，
      // 反而比走路更别扭——一只鹰停在桅杆上，没人会觉得这需要一条规则解释。
      // 深水同理：海上空域也是空域，不让飞机停在航母头顶上说不通。
    } else {
      return false;
    }
  }
  if (tile.cityId) {
    const city = cityById(s, tile.cityId);
    if (city && city.ruined) return false;
  }
  return !sameLayerAt(s, x, y, airLayer(def));
}

/**
 * 这个兵种能不能站在这一格（锚点）。占地 2 的兵要四格都成立。
 *
 * 注意"能不能站"和"这一格有没有人"是两件事：前者是地形与层，
 * 后者由 sameLayerAt 逐格判（所以 2×2 的兵贴着一座 2×2 的建筑放不下）。
 */
export function canStandAt(s: GameState, x: number, y: number, type: string): boolean {
  const def = utype(s, type);
  const n = footprintOf(s, type);
  for (let dy = 0; dy < n; dy++) {
    for (let dx = 0; dx < n; dx++) {
      if (!tileStandsOk(s, x + dx, y + dy, def)) return false;
    }
  }
  return true;
}

/**
 * 找一格**半径 r 以内**的空地（先近后远，同一圈里按左上到右下）。
 *
 * 招魂从"只能放在身边"改成"两格以内"之后需要它：相邻四格在混战里几乎永远是满的，
 * 而"复活"失败的理由如果总是"身边没地方站"，这个技能就只在空旷时才成立。
 * 由近及远而不是随机，是为了让落点可预期——玩家能大概猜到人会站在哪。
 */
function freeSpotWithin(
  s: GameState,
  unit: Unit,
  type: string,
  radius: number,
): { x: number; y: number } | null {
  for (let r = 1; r <= radius; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        // 只看这一圈的边，圈内更近的上一轮已经找过了
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = unit.x + dx;
        const y = unit.y + dy;
        if (canStandAt(s, x, y, type)) return { x, y };
      }
    }
  }
  return null;
}

/** 找一格相邻空地放召唤物/分裂体。找不到返回 null。 */
function freeNeighbor(s: GameState, unit: Unit, type: string): { x: number; y: number } | null {
  for (const [dx, dy] of DIRS) {
    const x = unit.x + dx;
    const y = unit.y + dy;
    if (canStandAt(s, x, y, type)) return { x, y };
  }
  return null;
}

export function canMove(u: Unit): boolean {
  return !u.moved;
}

/**
 * 这个单位一回合能攻击几次。
 *
 * 兵种的 burst 是基数，扩展的 modifyAttacks 在它上面改。攻击次数、
 * 反击次数、界面上的显示都走这一个函数——三处各写一遍的话，
 * 以后改 hook 只改到两处，玩家就会看到"面板说 2 次，实际只打 1 次"。
 */
export function attacksPerTurn(s: GameState, u: Unit): number {
  let attacks = Math.max(0, utype(s, u.type).burst ?? 1);
  for (const e of activeExpansions(s)) {
    if (e.hooks.modifyAttacks) attacks = e.hooks.modifyAttacks({ state: s, unit: u, attacks });
  }
  return attacks;
}

/** 这回合还剩几次攻击（没开始打时就是满的）。 */
export function attacksLeftOf(s: GameState, u: Unit): number {
  return u.attacksLeft ?? attacksPerTurn(s, u);
}

export function canAttack(u: Unit): boolean {
  return !u.acted && (u.attacksLeft ?? 1) > 0;
}

/**
 * 友军提供的光环加成。
 *
 * 只加不乘，也不递归——否则两个光环互相加成会失控。
 *
 * 半径写在 aura 自己身上（`radius`，默认 1 = 相邻）：指挥光环这类"站远了也带得动"
 * 的效果要 2 格，而威吓、咒域这类"贴上去才算"的仍然是 1。把半径放在**外面**
 * （先判距离再看能力）的写法，加一个 2 格光环就等于把全兵种的光环都放大到 2 格。
 */
export function auraBonus(s: GameState, unit: Unit): { atk: number; armor: number } {
  let atk = 0;
  let armor = 0;
  for (const ally of s.units) {
    if (ally.id === unit.id || ally.owner !== unit.owner) continue;
    const gap = distance(ally, unit);
    // aurasOfUnit：兵种自带 + 动态挂上的能力（修士随境界解锁的技能）都要算
    for (const a of aurasOfUnit(s, ally)) {
      if (gap > (a.radius ?? 1)) continue;
      if (a.allyAtk) atk += a.allyAtk;
      if (a.allyArmor) armor += a.allyArmor;
    }
  }
  return { atk, armor };
}

/**
 * 威吓：贴着几个会吓人的敌人，就少几分攻击（每层 2 点，最多两层）。
 *
 * 做成"减法"而不是"禁攻"：禁攻会让一支靠威吓撑起来的阵型变成铁板，
 * 而减法只是让贴身换血变亏——破解办法仍然是玩家熟悉的那两条：拉开、或者先射掉它。
 *
 * 这里必须只依赖 state（computeDamage 要给 UI 的伤害预览复用），不能记录"谁被吓过"。
 */
export function fearPenalty(s: GameState, unit: Unit): number {
  let hit = 0;
  for (const foe of s.units) {
    if (foe.owner === unit.owner) continue;
    // aurasOfUnit：动态挂上的威吓（比如修士的技能）也要算；距离在下面按 radius 判
    for (const a of aurasOfUnit(s, foe)) {
      if (!a.foeAtk || a.foeAtk >= 0) continue;
      // 半径默认 1（相邻）：威吓/咒域都是"贴上去才算"，只有显式写了 radius 的才放大
      if (distance(foe, unit) > (a.radius ?? 1)) continue;
      const cap = (a.maxLayers ?? Infinity) * -a.foeAtk;
      hit = Math.min(cap, hit - a.foeAtk);
    }
  }
  return hit;
}

/**
 * 虚咒：范围内敌军攻击力按**比例**降低（`foeAtkPct`），取最强的一条，不叠乘。
 *
 * 和 `fearPenalty` 并存而不是合并：一个是减法、一个是比例，语义不同
 * （见 ability-hooks 的 AuraSpec 注释）。返回值是 0~0.9 的比例，0 表示没人罩着。
 *
 * 上限 0.9：数据里写错一个 1.5 不会让某个兵直接打出负伤害，
 * 也挡住"三个女巫叠到 −75%"这种连锁——光环取强不取叠。
 */
export function hexWeakPct(s: GameState, unit: Unit): number {
  let pct = 0;
  for (const foe of s.units) {
    if (foe.owner === unit.owner) continue;
    // aurasOfUnit：动态挂上的虚咒也要算
    for (const a of aurasOfUnit(s, foe)) {
      if (!a.foeAtkPct || a.foeAtkPct <= 0) continue;
      if (distance(foe, unit) > (a.radius ?? 1)) continue;
      if (a.foeAtkPct > pct) pct = a.foeAtkPct;
    }
  }
  return Math.min(0.9, pct);
}

/** 算上扩展规则后的移动力。建筑（move 0）永远是 0，也不吃加速。 */
export function movePower(s: GameState, unit: Unit): number {
  const base = utype(s, unit.type).move;
  if (base <= 0) return 0;
  let move = base;

  // 英雄技能的位移加成（不死鸟俯冲）：只在放技能的这一回合有效
  move += unit.heroBuff?.moveBonus ?? 0;

  // 状态修正移动力
  for (const [key, val] of Object.entries(unit.status ?? {})) {
    if (typeof val !== 'number' || val <= 0) continue;
    const def = STATUS_REGISTRY[key];
    if (def?.modifyMove) move = def.modifyMove(s, unit, val, move);
  }

  // 疾行光环：相邻友军各 +1，可以叠（吟游诗人多了确实快）
  for (const ally of s.units) {
    if (ally.id === unit.id || ally.owner !== unit.owner) continue;
    if (distance(ally, unit) !== 1) continue;
    for (const a of aurasOfUnit(s, ally)) if (a.allyMove) move += a.allyMove;
  }

  // 先保底 1：减速、光环这些加减法算完，最少留一格移动力。
  // 这条要在钩子**之前**——否则"钩子把移动力压到 0"和"减速扣成 0"
  // 会长得一模一样，而前者是规则（封冻），后者是 bug。
  move = Math.max(1, move);

  for (const e of activeExpansions(s)) {
    if (e.hooks.modifyMove) move = e.hooks.modifyMove({ state: s, unit, move });
  }
  // 钩子返回 0 = 这一回合动不了（封冻的海军）。
  move -= unit.moveSpent ?? 0; 
  return Math.max(0, move);
}

/** 算上扩展规则后的视野半径 */
export function visionOf(s: GameState, unit: Unit): number {
  const selfDef = utype(s, unit.type);
  let r = selfDef.vision;
  // 驻军：塔上的哨位看得比平地远——这是"兵进驻"最直接的收益
  const host = buildingAt(s, unit.x, unit.y);
  if (host && host.id !== unit.id && host.owner === unit.owner) {
    const hostDef = utype(s, host.type);
    if (hostDef.garrison && !underConstruction(host)) r = Math.max(r, hostDef.vision);
  }
  for (const e of activeExpansions(s)) {
    if (e.hooks.modifyVision) r = e.hooks.modifyVision({ state: s, player: unit.owner, unit, base: r });
  }
  /*
   * 本体里视野就是 0 的东西（桥）**一格都不给**。
   *
   * 下面那句 `Math.max(1, …)` 是给"被减益压到 0 的兵"留的下限，但它顺手把
   * "本来就不看"的东西也抬到了 1 格——桥于是永远白送一圈视野，
   * 而扩展那边的 modifyVision 也都自带同样的下限，光改数据表清不掉。
   * 所以判据落在这里：兵种表写 0，就是真的没有视野。
   */
  if (selfDef.vision <= 0) return 0;
  return Math.max(1, r);
}

// 面板上的一条算式现在定义在 ability-hooks.ts：能力的钩子要往里 push，
// 它得是接口层的东西。这里转出去，老的 import 路径不用改。
export type { StatItem };

export interface EffectiveStats {
  /** 当前状态下的有效攻击力（不含"打谁"才决定的项） */
  atk: number;
  atkBase: number;
  atkItems: StatItem[];
  /** 当前格上的有效护甲（含地形、光环、诅咒、扩展改甲） */
  armor: number;
  armorBase: number;
  armorItems: StatItem[];
  /** 算上减速/光环/扩展的移动力 */
  move: number;
  moveBase: number;
  moveItems: StatItem[];
  /** 有效视野 */
  vision: number;
  visionBase: number;
  visionItems: StatItem[];
  /** 有效射程 */
  range: number;
  rangeBase: number;
  rangeItems: StatItem[];
  /** 有效溅射半径 */
  splash: number;
  splashBase: number;
  splashItems: StatItem[];
  /** 有效溅射比例 */
  splashRatio: number;
}

/**
 * 点击单位时面板要显示的"真实数值"：把当前状态下就会生效的修正全算进去。
 *
 * 只收"现在就成立"的项——光环、击杀成长、威吓、狂暴、哀兵必胜、
 * 所在格地形、诅咒、扩展改甲。依赖"打谁"的项（冲锋、群势、追猎、
 * 长短皆可、魔法段、属性弱点）不进来：那些是"这一下打多疼"的问题，
 * 伤害预览给得出带目标的真数，塞进来只会让"我的攻击力"变成一个没人能对上号的数字。
 *
 * modifyArmor 钩子以本单位自己充当攻击者来估——现有钩子都只看防守方；
 * 以后有看攻击者的钩子，这里要跟着改（注释就是防这件事的）。
 */
export function effectiveStats(s: GameState, u: Unit): EffectiveStats {
  const def = utype(s, u.type);

  // ── 攻击 ──
  const atkBase = def.atk + (u.atkBonus ?? 0);
  const atkItems: StatItem[] = [];
  let atk = atkBase;
  if (u.atkBonus) atkItems.push({ label: '圣剑觉醒', delta: u.atkBonus });
  const aura = auraBonus(s, u);
  if (aura.atk !== 0) {
    atk += aura.atk;
    atkItems.push({ label: '指挥光环', delta: aura.atk });
  }
  // 老兵不死：击杀数只在扩展开启时增长，kills > 0 就说明加成真实存在
  // 状态修正攻击力面板：与 computeDamage 同一段逻辑，位置也在光环之后
  for (const [key, val] of orderedStatuses(u.status)) {
    const sdef = STATUS_REGISTRY[key];
    if (!sdef?.modifyAtk) continue;
    const before = atk;
    atk = sdef.modifyAtk(s, u, val, atk);
    if (atk !== before) atkItems.push({ label: sdef.name, delta: atk - before });
  }
  // 扩展修改攻击力面板面板
  for (const e of activeExpansions(s)) {
    if (e.hooks.modifyStatAtk) {
      const before = atk;
      atk = e.hooks.modifyStatAtk({ state: s, unit: u, atk });
      if (atk !== before) {
        atkItems.push({ label: e.name, delta: atk - before });
      }
    }
  }
  const fear = fearPenalty(s, u);
  if (fear !== 0) {
    atk -= fear;
    atkItems.push({ label: '被威吓', delta: -fear });
  }
  // 虚咒：范围内的敌军攻击力按比例降低（取最强的一条，见 hexWeakPct）。
  // 放在威吓之后、乘法类修正之前：它说的是"我这一刀本来该多狠"，减法类先结清。
  const hex = hexWeakPct(s, u);
  if (hex > 0) {
    const before = atk;
    atk = Math.round(atk * (1 - hex));
    atkItems.push({ label: '虚咒', delta: atk - before });
  }
  // 面板上的攻击力修正（狂暴，以及以后任何"现在就成立"的攻击加成）。
  // 放在威吓之后、哀兵必胜之前：原来就在这个位置，而乘法必须吃满前面的加减。
  const atkCtx: HookCtx = {
    state: s,
    self: u,
    // 面板没有对手：算攻击时它当自己是出手的一方，算护甲时当自己挨打。
    // 这样看 side 的能力在面板上也会按玩家预期生效。
    side: 'attacker',
    atk,
    armor: 0,
    damage: 0,
    items: atkItems,
    isCounter: false,
    terrainBonus: 0,
    ignoreCover: false,
    distance: 0,
    api: abilityApi,
  };
  runStaged(stagedOfUnit<HookCtx>(s, u, 'statAttack'), atkCtx);
  atk = atkCtx.atk;
  // 哀兵必胜：先丢过城的一方全军 +10%，取整规则与 lastStandDamage 同源
  if (s.firstCityLost === u.owner) {
    const after = Math.round(atk * (1 + LAST_STAND_BONUS));
    atkItems.push({ label: '哀兵必胜 +10%', delta: after - atk });
    atk = after;
  }

  // ── 护甲（按当前所在格算）──
  const armorBase = def.armor + (u.armorBonus ?? 0);
  const armorItems: StatItem[] = [];
  let armor = armorBase;
  if (u.armorBonus) armorItems.push({ label: '圣剑觉醒', delta: u.armorBonus });
  const tile = tileAt(s, u.x, u.y);
  if (aura.armor !== 0) {
    armor += aura.armor;
    armorItems.push({ label: '守护光环', delta: aura.armor });
  }
  // 地形护甲：**空中层不吃这一条**。飞机不在林子里、不在山脊上，
  // 脚下是什么对它没有任何意义——给它 +2 掩体等于让"贴着树林飞"变成一种战术，
  // 而空中层存在的理由恰恰是"从上面过去，地面的事与它无关"。
  const terrainDef = tile && !isAirborne(s, u) ? CONFIG.terrainDef[tile.terrain] : 0;
  if (terrainDef !== 0) {
    armor += terrainDef;
    armorItems.push({ label: `地形 · ${CONFIG.terrainName[tile!.terrain]}`, delta: terrainDef });
  }
  // 面板上的护甲修正（林地之主）：和地形加成同一种东西，所以紧跟在它后面，
  // 也在驻军、诅咒之前——那两项排在它之后，面板上的算式才和结算顺序一致。
  const armorCtx: HookCtx = {
    state: s,
    self: u,
    side: 'defender',
    atk: 0,
    armor,
    damage: 0,
    items: armorItems,
    isCounter: false,
    terrainBonus: 0,
    ignoreCover: false,
    distance: 0,
    api: abilityApi,
  };
  runStaged(stagedOfUnit<HookCtx>(s, u, 'statArmor'), armorCtx);
  armor = armorCtx.armor;
  const garrison = garrisonBonus(s, u);
  if (garrison !== 0) {
    armor += garrison;
    armorItems.push({ label: '驻军', delta: garrison });
  }
  // 状态修正护甲（面板）
  for (const [key, val] of Object.entries(u.status ?? {})) {
    if (typeof val !== 'number' || val <= 0) continue;
    const def = STATUS_REGISTRY[key];
    if (def?.modifyArmor) {
      const before = armor;
      armor = def.modifyArmor(s, u, val, armor);
      if (armor !== before) armorItems.push({ label: def.name, delta: armor - before });
    }
  }
  // 圣旗（神圣骑士长）：临时护甲。面板和结算必须读同一个字段，
  // 否则会出现"面板写着 10 点、实际按 7 点算"这种只能靠猜的偏差。
  if (u.buff?.armor) {
    armor += u.buff.armor;
    armorItems.push({ label: u.buff.label ?? '技能增益', delta: u.buff.armor });
  }
  const curseAura = curseAuraPenalty(s, u);
  if (curseAura !== 0) {
    armor -= curseAura;
    armorItems.push({ label: '咒域', delta: -curseAura });
  }

  // 扩展改甲（堑壕战等）：一条钩子一行，标签用扩展名
  for (const e of activeExpansions(s)) {
    if (e.hooks.modifyArmor) {
      const before = armor;
      armor = e.hooks.modifyArmor({ state: s, attacker: u, defender: u, armor, isCounter: false });
      if (armor !== before) armorItems.push({ label: e.name, delta: armor - before });
    }
  }
  
  // ── 移动力 (严格按照 movePower 的执行顺序) ──
  const moveBase = def.move;
  const moveItems: StatItem[] = [];
  let moveNow = moveBase;
  if (moveBase > 0) {
    const heroMove = u.heroBuff?.moveBonus ?? 0;
    if (heroMove !== 0) {
      moveNow += heroMove;
      moveItems.push({ label: '英雄技能', delta: heroMove });
    }
    for (const [key, val] of Object.entries(u.status ?? {})) {
      if (typeof val !== 'number' || val <= 0) continue;
      const sdef = STATUS_REGISTRY[key];
      if (sdef?.modifyMove) {
        const before = moveNow;
        moveNow = sdef.modifyMove(s, u, val, moveNow);
        if (moveNow !== before) moveItems.push({ label: sdef.name, delta: moveNow - before });
      }
    }
    for (const ally of s.units) {
      if (ally.id === u.id || ally.owner !== u.owner) continue;
      if (distance(ally, u) !== 1) continue;
      for (const a of aurasOfUnit(s, ally)) {
        if (a.allyMove) {
          moveNow += a.allyMove;
          moveItems.push({ label: '疾行光环', delta: a.allyMove });
        }
      }
    }
    const beforeClamp = moveNow;
    moveNow = Math.max(1, moveNow);
    if (moveNow !== beforeClamp) moveItems.push({ label: '保底', delta: moveNow - beforeClamp });

    for (const e of activeExpansions(s)) {
      if (e.hooks.modifyMove) {
        const before = moveNow;
        moveNow = e.hooks.modifyMove({ state: s, unit: u, move: moveNow });
        if (moveNow !== before) moveItems.push({ label: e.name, delta: moveNow - before });
      }
    }
    const spent = u.moveSpent ?? 0;
    if (spent > 0) {
      moveNow = Math.max(0, moveNow - spent);
      moveItems.push({ label: '已消耗', delta: -spent });
    }
  }

  // ── 视野 (按 visionOf 展开) ──
  const visionBase = def.vision;
  const visionItems: StatItem[] = [];
  let visionNow = visionBase;
  const host = buildingAt(s, u.x, u.y);
  if (host && host.id !== u.id && host.owner === u.owner) {
    const hostDef = utype(s, host.type);
    if (hostDef.garrison && !underConstruction(host) && hostDef.vision > visionNow) {
      visionItems.push({ label: '驻军', delta: hostDef.vision - visionNow });
      visionNow = hostDef.vision;
    }
  }
  for (const e of activeExpansions(s)) {
    if (e.hooks.modifyVision) {
      const before = visionNow;
      visionNow = e.hooks.modifyVision({ state: s, player: u.owner, unit: u, base: visionNow });
      if (visionNow !== before) visionItems.push({ label: e.name, delta: visionNow - before });
    }
  }

  // ── 射程 ──
  const rangeBase = def.range;
  const rangeItems: StatItem[] = [];
  let rangeNow = rangeBase;
  if (typeof def.ammo === 'number' && outOfAmmo(s, u)) {
    rangeItems.push({ label: '弹药耗尽', delta: 1 - rangeBase });
    rangeNow = 1;
  } else {
    if (u.heroBuff?.range !== undefined && u.heroBuff.range !== rangeBase) {
      rangeItems.push({ label: '英雄技能', delta: u.heroBuff.range - rangeBase });
      rangeNow = u.heroBuff.range;
    }
    for (const e of activeExpansions(s)) {
      if (e.hooks.modifyRange) {
        const before = rangeNow;
        rangeNow = e.hooks.modifyRange({ state: s, unit: u, range: rangeNow });
        if (rangeNow !== before) rangeItems.push({ label: e.name, delta: rangeNow - before });
      }
    }
  }

  // ── 溅射 ──
  const splashBase = def.splash ?? 0;
  const splashItems: StatItem[] = [];
  let splashNow = splashBase;
  for (const e of activeExpansions(s)) {
    if (e.hooks.modifySplash) {
      const before = splashNow;
      splashNow = e.hooks.modifySplash({ state: s, attacker: u, splash: splashNow });
      if (splashNow !== before) splashItems.push({ label: e.name, delta: splashNow - before });
    }
  }

  return {
    atk, atkBase, atkItems,
    armor, armorBase, armorItems,
    move: moveNow, moveBase, moveItems,
    vision: visionNow, visionBase, visionItems,
    range: rangeNow, rangeBase, rangeItems,
    splash: splashNow, splashBase, splashItems,
    splashRatio: (u.custom?.splashRatio as number) ?? CONFIG.splashRatio,
  };
}

/** 算上扩展规则后的兵种造价 */
export function recruitCost(s: GameState, player: PlayerId, def: UnitTypeDef): number {
  let cost = def.cost;
  for (const e of activeExpansions(s)) {
    if (e.hooks.modifyCost) cost = e.hooks.modifyCost({ state: s, player, unitType: def, cost });
  }
  return Math.max(0, cost);
}

/**
 * 一个兵种的**完整价格**：金币 + 其它资源。
 *
 * 金币那一段走老的 modifyCost（所有既有扩展都在改它），其它资源走
 * modifyResourceCost。两个钩子分开而不是合成一个"价格对象"：
 * 合并等于把所有既有扩展的签名改一遍，而它们关心的事情本来就只有金币。
 */
export function recruitResCost(s: GameState, player: PlayerId, def: UnitTypeDef): ResourceCost {
  const gold = recruitCost(s, player, def);
  let extra: ResourceCost = { ...(def.costRes ?? {}) };
  for (const e of activeExpansions(s)) {
    if (e.hooks.modifyResourceCost) {
      extra = e.hooks.modifyResourceCost({
        state: s,
        player,
        unitType: def,
        baseCost: def.cost,
        goldCost: gold,
        cost: extra,
      });
    }
  }
  const out: ResourceCost = { ...cleanCost(extra) };
  if (gold > 0) out[GOLD] = gold;
  return out;
}

/**
 * 招这一个兵，这一下**真正要从国库里扣多少**。
 *
 * 和 `recruitResCost` 的差别只有一条：英雄**第一次**招要额外付解锁费。
 * 抽成函数是因为这笔钱有三个地方要算，而它们以前各算各的：
 *   · 规则层（`doRecruit`）——扣钱；
 *   · 指挥官面板（硬币图标旁边那个"≈ 多少金"）——给玩家预估；
 *   · AI 采购（`recruitCandidate` / `planOrders`）——判断买不买得起。
 *
 * 三处只要有一处漏了解锁费，症状都一样：面板说买得起、AI 也以为买得起，
 * 到了规则层被"资源不足"拒掉，那一格生产序列就静默空转——玩家排了英雄，
 * 结果什么都没发生，还找不出原因。所以这个口径只能有一份。
 *
 * `price` 是兵价、`unlockFee` 是这次要额的解锁费、`total` 是两者之和
 * （多资源扩展下 `price` 里可能还有粮食/建材），`gold` 是 `total` 里的金币段——
 * 界面和 AI 平时只关心这一个数，省得各自去查 `GOLD`。
 */
export function recruitPriceOf(
  s: GameState,
  player: PlayerId,
  def: UnitTypeDef,
): { price: ResourceCost; unlockFee: number; total: ResourceCost; gold: number } {
  const price = recruitResCost(s, player, def);
  const needUnlock = def.hero === true && !(s.unlocked?.[player] ?? []).includes(def.id);
  const unlockFee = needUnlock ? Math.max(0, def.unlockCost ?? 0) : 0;
  const total: ResourceCost = { ...price };
  if (unlockFee > 0) total[GOLD] = (total[GOLD] ?? 0) + unlockFee;
  return { price, unlockFee, total, gold: total[GOLD] ?? 0 };
}

/**
 * 这个英雄现在能不能再招一个：场上已经有、或者蛋还等着孵，都不行。
 *
 * 为什么单拎出来：规则层（`doRecruit`）和 AI 采购（`recruitCandidate`）都要判，
 * 两处各写一遍必然漂——以前 `doRecruit` 只看 `units`，于是不死鸟倒下、
 * 蛋还没孵的时候能再买一只，场上最后站起来两只不死鸟。
 */
export function heroBlocked(s: GameState, player: PlayerId, def: UnitTypeDef): string | null {
  if (def.hero !== true) return null;
  if (s.units.some((u) => u.owner === player && u.type === def.id)) {
    return `${def.name} 是英雄，场上只能有一个`;
  }
  const egg = s.pendingEgg;
  if (egg && egg.owner === player && egg.type === def.id) {
    return `${def.name} 的蛋还在原地等着孵，别急着再造一只`;
  }
  return null;
}

/** 这一格能不能站人：水不行，敌方城市也不行（城池得先打下来） */
/**
 * 这一格对某个单位来说能不能进。
 *
 * 地形一律问 `terrainWalkable`（它按兵种回答）：陆军进不了水，水军上不了岸
 * （桥面算岸），掠水/飞行能进水，高山谁都不能进。城市格按归属判定。
 */
function blockedFor(s: GameState, x: number, y: number, unit: { type: string; owner: PlayerId }): boolean {
  const tile = tileAt(s, x, y);
  if (!tile) return true;

  const def = utype(s, unit.type);
  // 地形这一关只有一处判据：`terrainWalkable`。以前这里分了两支——水军看
  // navigable()、其余一律 `passable()`——于是飞行兵在"下船落点"这类地方
  // 会被当成陆军，明明站得住的水面反而进不去。现在两支合并成一句按兵种问。
  if (!terrainWalkable(def, tile.terrain)) return true;
  if (def.domain === 'water') {
    // 吃水：占地 2×2 的大舰进不了浅流，会搁浅。
    // 这是「浅水 vs 深水」这一对地形真正的分工——否则浅流对舰队只是"另一片水"。
    // 判据用 footprint 而不是船名表：以后再加巨舰不用回来改这里。
    if (tile.terrain === 'shallow' && footprintOf(s, unit.type) > 1) return true;
  }

  if (tile.cityId) {
    const city = cityById(s, tile.cityId);
    // 废墟可以进：进城那一下就是"接管"这个动作本身
    if (city && city.owner !== unit.owner && !city.ruined) return true;
  }
  return false;
}

/**
 * 潜行：站在森林/丘陵上的单位，只有贴到相邻格的敌人才发现得了它。
 *
 * 这是"迷雾 + 地形"两条机制的交叉点，不是面板数值：
 * 开阔地上一点用没有，蹲在林子里才成立，而破解办法是走过去或者绕路。
 * 关掉迷雾时也一律无效——没有迷雾就没有"看不见"这回事。
 */
export function isHiddenFrom(s: GameState, unit: Unit, viewer: PlayerId): boolean {
  if (!s.fog) return false;
  if (unit.owner === viewer) return false;
  // 技能带来的隐匿（刺客大师）：不挑地形、也不看"动没动过"——
  // 它是主动藏起来的，藏到自己的下个回合开始（见 turnStartSkills 清 heroBuff）。
  const skillHidden = unit.heroBuff?.hidden === true;
  // 能力带来的隐匿：各自说自己的成立条件（潜行要看地形，隐匿要看这回合动没动）。
  // 一条兵种挂了几条隐匿就都问一遍，任一成立就算藏住了。
  let byAbility = false;
  for (const h of hooksOfUnit(s, unit)) {
    if (!h.hidden) continue;
    if (h.hidden({ state: s, self: unit, viewer, api: abilityApi })) {
      byAbility = true;
      break;
    }
  }
  if (!skillHidden && !byAbility) return false;

  // 贴脸就能看见——这是所有隐匿效果共同的破法。
  // 「反潜」这类能力可以把这一格往外推（`detect` 钩子），推几格由能力自己按
  // 目标类型决定：声纳探的是潜艇，不该顺手把树林里的刺客一起照出来。
  for (const v of unitsOf(s, viewer)) {
    if (distance(v, unit) <= 1 + detectBonus(s, v, unit)) return false;
  }
  return true;
}

/** 这个单位对"目标"的额外发现距离（多条能力取最大的那条，不叠加） */
function detectBonus(s: GameState, viewerUnit: Unit, target: Unit): number {
  const hooks = hooksOfUnit(s, viewerUnit);
  let best = 0;
  for (const h of hooks) {
    if (!h.detect) continue;
    const v = h.detect({ state: s, self: viewerUnit, target, api: abilityApi });
    if (v > best) best = v;
  }
  return best;
}

/**
 * 可达格（Dijkstra，因为地形消耗不同，BFS 会算错）。
 * 返回 格索引 -> 累计消耗。被友军占据的格子会从结果里去掉：
 * 己方单位可以穿过友军，但不能停在友军身上。
 */
export function reachableTiles(s: GameState, unit: Unit): Map<number, number> {
  // 占地 2 的单位也能移动（2026-10-30）。
  //
  // 以前这里是一句"占地 2 一律返回空集"——那时 2×2 只有炮台、兵营这类
  // 移动力 0 的建筑，等于没写。航空母舰要做成 2×2 之后，"不会动"就成了
  // 规则错误，所以这一版把它做成真的：
  //
  //   · 锚点走一步，n×n 四格跟着挪 → 每一步都要求**四格地形全过**；
  //   · 敌军只挡同一层（和单格完全一致），桥仍然可以从下面过；
  //   · 自己的四格要豁免——否则它当前踩着的两格会把自己挡住，一步都动不了；
  //   · 步耗按**锚点落的那一格**算。四格取最大或取和都会让"横向挪一格"
  //     在岸边莫名其妙翻倍，而玩家看的是锚点那个格子，口径跟肉眼一致最要紧。
  const n = footprintOf(s, unit);
  const budget = movePower(s, unit);
  const def = utype(s, unit.type);
  const hooks = hooksOfUnit(s, unit);
  // 飞行：可以掠过水面（但停不下来），森林和丘陵也按 1 步算。
  // 这条不是"更强的穿林"——穿林的收益是省一步，飞行的收益是**河防对它不成立**。
  // 「掠空」（fly-over）是飞行的加强版：同样掠水，另外还能和地面单位同格。
  const flyer = crossesWater(def);
  const air = isAirborne(s, unit);
  // 穿行：可以穿过敌军，只是不能停在上面
  const phasing = hasFlag(def, 'passThrough');
  // 水面地形代价是 99（对陆军而言就是"走不了"），所以水军必须单独给价格：
  // 不然船一步都动不了 —— 这一条曾经真的漏过，测试也没抓住（可达格为空，
  // "所有可达格都是水"这种全称命题反而是成立的）。
  const waterUnit = def.domain === 'water';

  /** 锚点落在 (ax,ay) 时它占的那 n×n 格（n=1 时就是它自己） */
  const cellsAt = (ax: number, ay: number): Array<{ x: number; y: number }> => {
    if (n === 1) return [{ x: ax, y: ay }];
    const out: Array<{ x: number; y: number }> = [];
    for (let dy = 0; dy < n; dy++) for (let dx = 0; dx < n; dx++) out.push({ x: ax + dx, y: ay + dy });
    return out;
  };

  /**
   * 地形与城市：四格全部合规才算过。
   *
   * 两条豁免，粗细不同，别再混成一条：
   *   · **空中层（`layer: 'air'`）没有地形这回事**——河、深水、高山、火山
   *     一律从上面过，唯一还挡得住它的是**敌方城市**（那是防空，不是地形）。
   *   · **掠水（`flight` 但不是空中层）**只放行水面与深水：一只鹰能贴水飞，
   *     但它仍然爬不过高山。
   *
   * 以前这里只写了水面和深水，于是飞机飞得进外海、飞不过山；更早的版本
   * 连深水都没写，表现是"能停在深水，却飞不进去"。这类"两处口径不一致"
   * 的 bug 每次都长得一样：能站的地方进不去，或进得去的地方站不住。
   */
  const terrainOk = (ax: number, ay: number): boolean => {
    for (const c of cellsAt(ax, ay)) {
      if (!blockedFor(s, c.x, c.y, unit)) continue;
      const ft = tileAt(s, c.x, c.y);
      if (!ft) return false;
      if (air) {
        // 敌方（未成废墟的）城市仍然拦：那一段是防空火力，不是地形
        const city = ft.cityId ? cityById(s, ft.cityId) : null;
        if (!city || city.owner === unit.owner || city.ruined) continue;
        return false;
      }
      // 掠水（不是空中层）曾经在这里单独放行水面——那条豁免现在在
      // `blockedFor` 里（它按兵种判地形），所以这里只剩"被挡住就是挡住"。
      return false;
    }
    return true;
  };

  /** 敌军挡路：任一格被同层的非桥敌军占着就不能进（除非会穿行） */
  const enemyBlocks = (ax: number, ay: number): boolean => {
    if (phasing) return false;
    for (const c of cellsAt(ax, ay)) {
      const hit = s.units.some((u) => {
        if (!coversTile(s, u, c.x, c.y)) return false;
        if (u.owner === unit.owner) return false;
        if (isAirborne(s, u) !== air) return false;
        if (utype(s, u.type).bridges) return false;
        return true;
      });
      if (hit) return true;
    }
    return false;
  };

  const best = new Map<number, number>();
  const start = idx(s, unit.x, unit.y);
  best.set(start, 0);

  const queue: Array<{ i: number; cost: number }> = [{ i: start, cost: 0 }];

  while (queue.length > 0) {
    queue.sort((a, b) => a.cost - b.cost);
    const cur = queue.shift();
    if (!cur) break;
    if (cur.cost > (best.get(cur.i) ?? Infinity)) continue;

    const { x, y } = xyOf(s, cur.i);
    for (const [dx, dy] of DIRS) {
      const nx = x + dx;
      const ny = y + dy;
      if (!inBounds(s, nx, ny)) continue;
      // 地形与城市：四格全过（n=1 时就是原来那一格）。
      // 飞行只放行"水面"这一种阻挡：敌方城市、高山、越界照旧拦住。
      // 放行的代价是不能停在水上（见下面的终点过滤），所以它只是过河，不是潜水。
      if (!terrainOk(nx, ny)) continue;

      const tile = s.tiles[idx(s, nx, ny)];
      if (!tile) continue;

      // 敌军挡路：既不能进，也不能穿（除非你会穿行）。
      // **只有同一层会挡**：地面的兵挡地面，天上的挡天上。
      // 不同层可以共格，所以它们彼此既不挡路、也不占位——
      // 这正是「掠空」那半句"可以和地面单位重叠"的全部实现。
      // 桥仍然是双向的：谁都能从桥上过。
      if (enemyBlocks(nx, ny)) continue;

      // 单格步耗。三道：先看这一格的基础价（水军/飞行固定 1，地面单位还要
      // 加上"爬坡附加"——往高处走更贵，见 stepCostInto），
      // 再让"改价"类能力覆盖它（穿林：森林丘陵按 1），最后让"倍率"类能力乘上去
      // （重甲难行 ×2）。三步走而不是一步算出来，是因为穿林和重甲难行都挂在
      // 同一格上时，先减半再翻倍才是玩家预期的那个数。
      //
      // 多格单位按**锚点那一格**付账：四格取最大或取和，都会让"贴着岸横挪一格"
      // 在玩家眼里突然贵一倍，而界面上高亮的正是锚点格。口径跟肉眼一致优先。
      // 空中层一律 1 步：它连高山都过得去（见 terrainOk），没理由在那上面
      // 按地形的 99 点收费。写成 `flyer || air` 而不是只写 flyer，是因为
      // 这两件事本来就该分家：一只鹰能掠水但爬不了山，飞机两样都能。
      let stepCost = stepCostInto(s, unit, cur.i, idx(s, nx, ny), { waterUnit, flyer: flyer || air });
      const moveCtx = { state: s, unit, def, terrain: tile.terrain, cost: stepCost };
      for (const h of hooks) {
        if (!h.moveCost) continue;
        const over = h.moveCost(moveCtx);
        if (over !== undefined) {
          moveCtx.cost = over;
          stepCost = over;
        }
      }
      for (const h of hooks) {
        if (h.moveCostMul) stepCost = Math.round(h.moveCostMul(moveCtx) * stepCost);
      }
      const nextCost = cur.cost + stepCost;
      if (nextCost > budget) continue;

      const ni = idx(s, nx, ny);
      if (nextCost < (best.get(ni) ?? Infinity)) {
        best.set(ni, nextCost);
        queue.push({ i: ni, cost: nextCost });
      }
    }
  }

  // 己方单位所在的格子不能作为终点。
  //
  // 建筑是例外，分两种：
  //   · **能站的建筑**（塔、军营、磨坊、工厂、桥……）：站在自己的建筑上是可以的。
  //     一座塔占掉一格却永远空着，只会让布阵时莫名其妙地缺一个洞；
  //     桥更明显——修好了却只能穿过去、停不下来，守桥和换气都没法做。
  //   · **障碍**（墙、栅栏、拒马、铁丝网）：连友军也停不上去。
  //     它们的全部作用就是"这一格不存在"，能站就等于把它删了。
  //
  // 敌方的建筑（非桥）一律不能站：那一格还被它占着，得先打掉。
  //
  // 多格单位逐格看：**只要有一格停不下，整个锚点就不算落点**。
  const blockedAnchor = (x: number, y: number): boolean =>
    cellsAt(x, y).some(({ x: cx, y: cy }) => {
      const here = s.units.filter((u) => u.id !== unit.id && coversTile(s, u, cx, cy));
      const blockers = here.filter((u) => {
        // 不同层不占位：脚底下站着敌人，头上那格照样能停
        if (isAirborne(s, u) !== air) return false;
        const d = utype(s, u.type);
        if (d.category !== 'building') return true;
        if (d.bridges) return false; // 桥是双向的，谁都能站
        if (d.obstacle) return true; // 墙：自己人也过不去
        return u.owner !== unit.owner; // 自家设施能站，敌方的先打掉
      });
      return blockers.length > 0;
    });

  for (const i of Array.from(best.keys())) {
    const { x, y } = xyOf(s, i);
    if (blockedAnchor(x, y)) best.delete(i);
  }
  // 飞行单位可以停在水面上（见 canStandAt 的同一条说明）。
  // 这里以前有一句"落点必须在岸上"，删掉之后飞行才真正是"水里也能歇脚"，
  // 而不是"过河时不许回头"。
  best.delete(start);

  return best;
}

/**
 * 威胁范围：这个单位这一回合还能打到哪些格。
 *
 * 分两种情况，差别很大：
 *   · 还没动过 → 可达格 + 每个落点的射程，也就是"我能压住哪一片"
 *   · 已经走过了 → 只剩原地开火的那一圈，别再画一大片骗人
 *
 * 建筑（移动力 0）永远按第二种算。
 */
export function threatTiles(s: GameState, unit: Unit): Set<number> {
  const out = new Set<number>();
  const targets = [...new Map(s.tiles.map(t => [t.terrain,t])).values()];
  // 多格单位：距离要量到**整个矩形**，不能量锚点。
  // 量锚点的话，2×2 的船右边和下边会少画一排——玩家看到"打不到"，
  // 实际能打，这种错比不画还糟。
  const n = footprintOf(s, unit);
  const gapTo = (cx: number, cy: number, x: number, y: number) => {
    const gx = Math.max(0, Math.max(cx - x, x - (cx + n - 1)));
    const gy = Math.max(0, Math.max(cy - y, y - (cy + n - 1)));
    return gx + gy;
  };

  const addAround = (cx: number, cy: number) => {
    const projected = { ...unit, x: cx, y: cy, moved: unit.moved || cx !== unit.x || cy !== unit.y };
    const ranges = new Map(targets.map(t => [t.terrain,effectiveRangeAgainst(s,projected,t)]));
    const range = Math.max(...ranges.values());
    const pad = range + n - 1;
    for (let dy = -pad; dy <= pad; dy++) {
      for (let dx = -pad; dx <= pad; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (!inBounds(s, x, y)) continue;
        const gap = gapTo(cx, cy, x, y);
        if (gap === 0) continue; // 自己身体那几格不算威胁
        if (gap <= ranges.get(tileAt(s,x,y)!.terrain)!) out.add(idx(s, x, y));
      }
    }
  };

  // 走过了、或者根本不能动：只剩身前这一圈
  if (unit.moved || movePower(s, unit) === 0) {
    addAround(unit.x, unit.y);
    return out;
  }

  const reach = reachableTiles(s, unit);
  addAround(unit.x, unit.y);
  for (const i of reach.keys()) {
    const { x, y } = xyOf(s, i);
    addAround(x, y);
  }

  // 能走到的格子不用再叠一层红
  for (const i of reach.keys()) out.delete(i);
  out.delete(idx(s, unit.x, unit.y));

  return out;
}

/** 射程内的敌方单位 */
/**
 * 这一下能不能打到：射程够就行。
 *
 * 桥曾经是个例外——"拆桥必须贴到桥头"（隔着河放箭打不塌）。那条规则是为了治
 * 一个真实的毛病：两边各架七八座、隔着河互相对射桥头，打满 200 回合谁也过不去。
 * 但一刀切也治出了新毛病：远程连"顺手拆一座没人守的桥"都做不到，
 * 而近战要贴到桥头才能动手，实际打起来又常常够不着。
 *
 * 现在的做法是**准许打、但打折**（见 computeDamage 的收尾）：射程够就能朝桥开火，
 * 只是一发只算一半；贴着桥头打才是满伤。于是"隔着河拆桥"变成一个又慢又费的
 * 消耗动作——想真的断掉这条路，还是得把部队压到桥边。
 */
export function canStrike(s: GameState, attacker: Unit, target: Unit): boolean {
  // 射程要按"这一发从哪打到哪"算：站丘陵上俯射多一格，往高处仰攻少一格，
  // 站在林子里连平射都被树冠吃掉一格（见 rangeModAgainst）。
  const range = effectiveRangeAgainst(s, attacker, tileAt(s, target.x, target.y));
  // 地面打空中要多算一格（见 strikeDistance）；同格判定仍然看"真实相对位置"，
  // 否则"空中压着地面"这个免费的第一刀会被 +1 顺手吃掉
  const real = distBetweenUnits(s, attacker, target);
  const d = strikeDistance(s, attacker, target);
  if (d > range) return false;
  // 距离 0 只会在"空中压着地面"时出现——那是贴着打，不是"打不到自己"
  if (real === 0) return isAirborne(s, attacker) !== isAirborne(s, target);
  return true;
}

export function attackableTargets(s: GameState, unit: Unit): Unit[] {
  if (!canAttack(unit)) return [];
  return s.units.filter((u) => u.owner !== unit.owner && canStrike(s, unit, u));
}

/** 射程内的敌方城市 */
export function siegeTargets(s: GameState, unit: Unit): City[] {
  if (!canAttack(unit)) return [];
  // 城按"城市"那一层算高度（2 层）：站在台地上砸城比从谷底仰着砸多一格，
  // 和野战用同一条规则，不另开一套。
  return s.cities.filter((c) => {
    if (c.owner === unit.owner) return false;
    // 废墟不用再砸：它已经没有耐久可打，接下来该做的是派兵进去
    if (c.ruined) return false;
    const d = distToCity(unit, c);
    if (d <= 0) return false;
    return d <= effectiveRangeAgainst(s, unit, tileAt(s, c.x, c.y));
  });
}

/**
 * 对单位的伤害：攻击 − （护甲 + 地形加成），最低 0，然后过一遍扩展钩子。
 * 钩子必须是纯函数——这个函数也会在 UI 的伤害预览里被调用。
 */
export function computeDamage(
  s: GameState,
  attacker: Unit,
  defender: any, // 放宽类型，兼容裸 City 和伪 Unit
  isCounter = false,
): number {
  // 1. 识别是否为城市
  const isCity = defender?.__isCity === true || defender?.type === '__city__';
  const city = isCity ? (defender.__city || defender) : null;

  const at = utype(s, attacker.type);
  //拦截：如果是城市，现场伪造一个兵种定义，绝对不去查 s.unitTypes，彻底免疫旧存档报错
  let dt: any;
  if (isCity) {
    dt = {
      id: '__city__',
      name: '城市',
      armor: 0,
      weak: undefined,
      resist: undefined,
      bridges: false,
      abilities: [],
    };
  } else {
    dt = utype(s, defender.type);
  }

  // 2. 城市不吃地形和光环；空中单位同样不吃地形（见 effectiveStats 同一处注释）
  const tile = isCity ? null : tileAt(s, defender.x, defender.y);
  const terrainBonus = tile && !isAirborne(s, defender) ? CONFIG.terrainDef[tile.terrain] : 0;
  const defenderAura = isCity ? { armor: 0 } : auraBonus(s, defender);

  // 状态修正攻击力：放在最前面，后面那些乘算（射程折扣、属性倍率）才吃得到。
  const atkNow = attackPowerNow(s, attacker);

  // 3. 核心：真实护甲是动态读取城市的，而不是读全局表里的 0
  const actualArmor = isCity ? city.armor : dt.armor + (defender.armorBonus ?? 0);

  const ctx: HookCtx = {
    state: s,
    self: defender,
    foe: attacker,
    side: 'defender',
    atk: atkNow,
    armor: actualArmor + defenderAura.armor + terrainBonus,
    damage: atkNow,
    items: [],
    isCounter,
    terrainBonus,
    ignoreCover: false,
    distance: isCity ? 1 : strikeDistance(s, attacker, defender),
    api: abilityApi,
  };

  // 护甲阶段的钩子：攻方和守方的都进同一张表，
  // 按 stage 排；每条跑的时候 ctx.self 临时指向它自己的主人。
  const armorHooks = isCity ? [] : [
    ...bindHooks<HookCtx>(at, attacker, defender, 'attacker', 'armorPhase', attacker.extraAbilities),
    ...bindHooks<HookCtx>(dt, defender, attacker, 'defender', 'armorPhase', defender.extraAbilities),
  ];

  // 地形掩护之前，穿隙
  runBound(armorHooks, ctx, { to: ARMOR_STAGE.postIgnoreCover });

  // 驻军：站在自家可驻军建筑上，多一层掩护（和地形加成同一种东西）
  if (!isCity) ctx.armor += garrisonBonus(s, defender);

  // 林地之主之前
  runBound(armorHooks, ctx, { from: ARMOR_STAGE.postIgnoreCover, to: ARMOR_STAGE.postWoodland });

  // 林地之主，直到小型扩展之前
  runBound(armorHooks, ctx, { from: ARMOR_STAGE.postWoodland, to: ARMOR_STAGE.expanded });

  // 状态修正护甲
  for (const [key, val] of Object.entries(defender.status ?? {})) {
      if (typeof val !== 'number' || val <= 0) continue;
      const def = STATUS_REGISTRY[key];
      if (def?.modifyArmor) ctx.armor = def.modifyArmor(s, defender, val, ctx.armor);
    }
  // 圣旗（神圣骑士长的技能）：临时护甲，和面板走同一个字段
  if (!isCity && defender.buff?.armor) ctx.armor += defender.buff.armor;
  // 咒域光环
  ctx.armor -= curseAuraPenalty(s, defender);

  // 小型扩展
  for (const e of activeExpansions(s)) {
    if (e.hooks.modifyArmor) {
      ctx.armor = e.hooks.modifyArmor({ state: s, attacker, defender, armor: ctx.armor, isCounter });
    }
  }

  // 小型扩展到破甲之前
  runBound(armorHooks, ctx, { from: ARMOR_STAGE.expanded, to: ARMOR_STAGE.pierce });

  // 破甲
  runBound(armorHooks, ctx, { from: ARMOR_STAGE.pierce, to: ARMOR_STAGE.postPierce });
  
  // 破甲之后
  runBound(armorHooks, ctx, { from: ARMOR_STAGE.postPierce });

  // ── 伤害计算 ──
  const damageHooks = isCity ? [] : [
    ...bindHooks<HookCtx>(at, attacker, defender, 'attacker', 'damage', attacker.extraAbilities),
    ...bindHooks<HookCtx>(dt, defender, attacker, 'defender', 'damage', defender.extraAbilities),
  ];

  // ── 物理加成阶段 ──
  // 冲锋、群势、追猎
  runBound(damageHooks, ctx, { to: DAMAGE_STAGE.rangeMul });

  // 威吓
  ctx.damage -= fearPenalty(s, attacker);
  // 虚咒：按比例削这一刀的底子，和面板 effectiveStats 同一处口径
  const hexPct = hexWeakPct(s, attacker);
  if (hexPct > 0) ctx.damage = Math.round(ctx.damage * (1 - hexPct));

  // 长短皆可：隔着一格以上打，只有六成伤害。近身才是本职。
  //
  // 矮人王的「投斧」不走能力，而是走 heroBuff：技能期间射程拉到 3、同样只给六成。
  // 两者共用同一个折扣，是因为它们说的是同一件事——"这一下是扔出去的"。
  runBound(damageHooks, ctx, { from: DAMAGE_STAGE.rangeMul, to: DAMAGE_STAGE.rangeFlat });
  if (!isCity && attacker.heroBuff?.rangeMul !== undefined && ctx.distance >= 2) {
    ctx.damage = Math.round(ctx.damage * attacker.heroBuff.rangeMul);
  }

  // 游骑（半人马）
  runBound(damageHooks, ctx, { from: DAMAGE_STAGE.rangeFlat, to: DAMAGE_STAGE.postRange });

  // 魔法之前
  runBound(damageHooks, ctx, { from: DAMAGE_STAGE.postRange, to: DAMAGE_STAGE.postMagic });
  
  if (!isCity) {
    let dmg = ctx.damage;
    for (const e of activeExpansions(s)) {
      if (e.hooks.modifyDamage) {
        dmg = e.hooks.modifyDamage({ state: s, attacker, defender, damage: dmg, isCounter });
      }
    }
    ctx.damage = dmg;
  }

  // ── 城市：攻城加成（破城×1.5 / 扩展 modifySiegeDamage）──
  if (isCity) {
    const sctx: SiegeDamageCtx = {
      state: s,
      self: attacker,
      city: city!,
      damage: ctx.damage,
      api: abilityApi,
    };
    runStaged(stagedOfUnit<SiegeDamageCtx>(s, attacker, 'siegeDamage'), sctx);
    ctx.damage = sctx.damage;
    for (const e of activeExpansions(s)) {
      if (e.hooks.modifySiegeDamage) {
        ctx.damage = e.hooks.modifySiegeDamage({
          state: s, attacker, city: city!, damage: ctx.damage,
        });
      }
    }
  }

  // 物理伤害减去护甲，并保底为 0
  ctx.damage = Math.max(0, ctx.damage - ctx.armor);

  // ── 魔法段 ──
  // 不吃护甲、不吃地形、不吃破甲，只被目标的魔法抗性平减。
  ctx.damage += magicDamageOf(s, attacker, defender);

  //魔法之后、属性之前
  runBound(damageHooks, ctx, { from: DAMAGE_STAGE.postMagic, to: DAMAGE_STAGE.postElement });

  // ── 属性 ──
  // 作用在整段伤害上
  ctx.damage = applyElementMul(ctx.damage, elementOf(s, attacker), dt.weak, dt.resist);

  // 属性之后、同源护壁之前
  runBound(damageHooks, ctx, { from: DAMAGE_STAGE.postElement, to: DAMAGE_STAGE.elementMul });

  // 同源护壁（至尊法师）：挨的是和自己**当前属性**同一路的伤害，只吃一半。
  // 放在弱点/抗性之后、反击折减之前：它说的是"这一路的伤害对我打对折"。
  runBound(damageHooks, ctx, { from: DAMAGE_STAGE.elementMul, to: DAMAGE_STAGE.trueDamage });

  // 真实伤害阶段
  runBound(damageHooks, ctx, { from: DAMAGE_STAGE.trueDamage });

  if (!isCity && isCounter) {
    ctx.damage = Math.max(0, Math.round(ctx.damage * CONFIG.counterAttackRatio));
  }

  if (!isCity && dt.bridges && ctx.distance > 1) {
    ctx.damage = Math.round(ctx.damage * CONFIG.bridgeRangedDamageRatio);
  }

  return Math.max(0, Math.round(ctx.damage));
}

/**
 * 对城市的伤害。
 * 历史遗留，现在已经瘦身。
 */
export function damageToCity(attacker: Unit, city: City, s: GameState): number {
  // 把城市伪装成一个带 __isCity 标记的伪单位
  const fakeDefender = {
    type: '__city__',
    __isCity: true,
    __city: city,
    x: city.x,
    y: city.y,
    status: {},
  } as any;

  return computeDamage(s, attacker, fakeDefender);
}

/** 预估伤害，给 UI 的攻击预览用，不改变状态 */
export function previewAttack(
  s: GameState,
  attacker: Unit,
  defender: Unit,
): {
  toDefender: number;
  toAttacker: number;
  counter: boolean;
  hits: number; // 保留字段防 UI 报错，但固定为 1
  toSplash: number;
} {
  // 单次伤害
  const toDefender = computeDamage(s, attacker, defender);

  const survives = defender.hp - toDefender > 0;
  // 这次打完还吃不吃得到反击：看防守方剩余的反击次数
  const countersLeft = defender.countersLeft ?? Math.max(0, attacksPerTurn(s, defender));
  // 修改反击判定条件
  const counter = survives && !hasFlagOn(s, attacker, 'noCounter') && countersLeft > 0 && canStrike(s, defender, attacker);
  const toAttacker = counter ? computeDamage(s, defender, attacker, true) : 0;

  let toSplash = 0;
  for (const v of splashVictims(s, attacker, defender)) toSplash += v.dmg;

  return { toDefender, toAttacker, counter, hits: 1, toSplash };
}

/**
 * 这个单位现在的溅射半径。
 *
 * 兵种表给基数，扩展的 `modifySplash` 在它上面改（修真按境界撑大）。
 * 结算、预览、侧栏、兵种卡都走这一个函数——四处各算一遍的话，
 * 界面上写着"1 格"而实际波及 2 格，玩家只会觉得规则在骗人。
 */
export function splashRadiusOf(s: GameState, u: Unit): number {
  let radius = utype(s, u.type).splash ?? 0;
  for (const e of activeExpansions(s)) {
    if (e.hooks.modifySplash) radius = e.hooks.modifySplash({ state: s, attacker: u, splash: radius });
  }
  return Math.max(0, radius);
}

/**
 * 这个单位的溅射比例。
 *
 * 单位自己带了 `custom.splashRatio` 就按它算，没带用全局默认（50%）。
 * 允许正数以外的值没有意义：0 和负数等于"没有溅射"，交给半径去表达，
 * 所以这里只在 0 < r 时才采信，免得一个手滑写成 0 的单位静默变成"没伤害"。
 */
export function splashRatioOf(u: Unit): number {
  const own = u.custom?.splashRatio;
  return typeof own === 'number' && own > 0 ? own : CONFIG.splashRatio;
}

/**
 * 溅射范围内的敌人：主目标周围的敌人各吃一份打折的伤害。
 *
 * 只打敌人，不打自己人——"炮火误伤"听起来很真实，但在回合制里
 * 它只会变成"我不敢开炮"，而不是"我要算清楚再开炮"。
 *
 * 两条关于**大型目标**的约定（2026-10-29）：
 *   1. 距离按"身体最近的边"算（`distBetweenUnits`）。2×2 的大单位紧贴爆心时，
 *      它的四格都在范围内，用锚点算会把它误判成"离得远"。
 *   2. 它只挨**一份**。四格是同一个目标，不是四个目标——名单里用 id 去重，
 *      所以"直接伤害 + 溅射"加起来也只结算一次。
 */
/**
 * 这一格是否落在"从攻击者指向主目标"的那条直线上（含对角线）。
 *
 * 只用来判直线溅射：方向由 `a → d` 决定，`v` 必须同方向、共线。
 * 用锚点算而不是身体最近边——直线是瞄准线，不是覆盖面积，
 * 2×2 单位挡在线上时按它自己那一格算反而更符合直觉。
 */
function onStrikeLine(a: Unit, d: Unit, vx: number, vy: number): boolean {
  const dx = Math.sign(d.x - a.x);
  const dy = Math.sign(d.y - a.y);
  if (dx === 0 && dy === 0) return true;
  const x = vx - a.x;
  const y = vy - a.y;
  if (dx === 0) return x === 0 && Math.sign(y) === dy;
  if (dy === 0) return y === 0 && Math.sign(x) === dx;
  return x * dy === y * dx && Math.sign(x) === dx && Math.sign(y) === dy;
}

/**
 * 这一下溅射**波及**的所有格索引（含空格、含免疫格、含多格目标全部格子）。
 * 和 splashVictims 的分工：那个回答"谁挨打"，这个回答"地上哪几片红了"。
 * 两者判据一致（多格单位按到矩形最近距离算），否则视觉和数值会各说各话。
 */
export function splashTilesOf(s: GameState, attacker: Unit, defender: Unit): number[] {
  const radius = splashRadiusOf(s, attacker);
  if (radius <= 0) return [];
  const line = utype(s, attacker.type).splashLine === true;
  const n = footprintOf(s, defender);
  const out: number[] = [];
  for (let ty = defender.y - radius; ty <= defender.y + n - 1 + radius; ty++) {
    for (let tx = defender.x - radius; tx <= defender.x + n - 1 + radius; tx++) {
      if (!inBounds(s, tx, ty)) continue;
      const cx = Math.min(Math.max(tx, defender.x), defender.x + n - 1);
      const cy = Math.min(Math.max(ty, defender.y), defender.y + n - 1);
      const d = Math.abs(tx - cx) + Math.abs(ty - cy);
      if (d > radius) continue;
      if (line && !onStrikeLine(attacker, defender, tx, ty)) continue;
      out.push(idx(s, tx, ty));
    }
  }
  return out;
}

function splashVictims(
  s: GameState,
  attacker: Unit,
  defender: Unit,
): Array<{ unit: Unit; dmg: number }> {
  const radius = splashRadiusOf(s, attacker);
  if (radius <= 0) return [];
  // 直线溅射（剑气、光束）：只扫那条线上的，不扫"周围一圈"
  const line = utype(s, attacker.type).splashLine === true;

  const ratio = splashRatioOf(attacker);
  const out: Array<{ unit: Unit; dmg: number }> = [];
  const seen = new Set<string>([defender.id]);
  for (const v of s.units) {
    if (v.owner === attacker.owner) continue;
    // 已经结算过的（主目标，或者同一格被扫到两次）不再收
    if (seen.has(v.id)) continue;
    if (distBetweenUnits(s, defender, v) > radius) continue;
    if (line && !onStrikeLine(attacker, defender, v.x, v.y)) continue;
    // 阵列：只免疫"被波及"，当主目标时那一下照吃
    if (hasFlagOn(s, v, 'immuneSplash')) continue;
    // 圣旗给的阵列是临时的，所以不能只认兵种表上的那条能力
    if (v.buff?.splashImmune) continue;
    const dmg = Math.floor(computeDamage(s, attacker, v) * ratio);
    if (dmg <= 0) continue;
    seen.add(v.id);
    out.push({ unit: v, dmg });
  }
  return out;
}

/**
 * 写一条战报。
 *
 * `open=true` 表示"对面也看得见"（战损那类：兵倒下、桥塌、城破）。
 * 默认只给自己的主人看——造了什么、走了哪、攒了多少钱，对面没理由知道。
 */
function pushLog(s: GameState, p: PlayerId, text: string, open = false): void {
  s.log.push({ turn: s.turn, player: p, text, ...(open ? { open: true } : {}) });
  // 80 → 120：每一次交火现在双方各记一条（见 doAttack 里那段说明），
  // 条数翻倍而窗口不变的话，玩家回头查"我这一下是怎么挨的"时已经翻不到了。
  if (s.log.length > 120) s.log.splice(0, s.log.length - 120);
}

/** 通知所有扩展：有单位阵亡了 */
/**
 * 船沉了，货舱里的人一起没。
 *
 * 不写这条会出现最糟的一种情形：船被打沉了，但船上那两个兵凭空回到了
 * 棋盘上（因为它们的对象还挂在货舱里），玩家只会觉得"这游戏算错了"。
 * 所以凡是从 s.units 里删单位的地方，船上的货一并清掉。
 */
function drownCargo(s: GameState, dead: Unit): void {
  if (!dead.cargo || dead.cargo.length === 0) return;
  const names = dead.cargo.map((u) => utype(s, u.type).name).join('、');
  pushLog(s, dead.owner, `随船沉没：${names}`, true);
}

function fireKilled(s: GameState, victim: Unit, killer: Unit | undefined): void {
  // 没有凶手（毒死、烧死、桥塌）时，两人局记在对面头上；三人以上没有"对面"
  // 这回事，就记在自己头上——宁可少给一份击杀奖励，也不能凭空发给出局的人。
  const killerOwner = killer
    ? killer.owner
    : seatsOf(s).length === 2
      ? other(victim.owner)
      : victim.owner;

  // 1) 先通知击杀方：此刻 victim 还是死前那一刻的形态。
  //
  // 先告诉世界"谁死了、死时是什么"，再处理"死后变成了什么"。
  // 亡语属于后者——它是死亡之后发生的事，不该污染死亡这件事本身。
  for (const e of activeExpansions(s)) {
    e.hooks.onUnitKilled?.({ state: s, victim, killer, killerOwner });
  }

  // 2) 再执行亡语/转化（自爆、重生、分裂、灵体化）。
  //
  // 主流程只做两件通用的事：把 result 里的"要不要清场"落实下去，
  // 以及通知扩展"亡语跑完了"。清场放在这里而不是各能力里自己删，
  // 是为了避免两段能力交叉删列表、把刚分裂出来的小史莱姆一起删掉。
  const dctx: DeathCtx = { state: s, victim, killer, api: abilityApi, result: { blasts: 0 } };
  for (const h of hooksOfUnit(s, victim)) h.onDeath?.(dctx);
  // 自爆会波及旁人：这一步做完得扫一遍，把 hp 归零的清掉，
  // 否则下面的"解散/分裂"会看到一个已经死了的邻居。
  if (dctx.result.blasts > 0) s.units = s.units.filter((u) => u.hp > 0);
}

function checkWinner(s: GameState): PlayerId | null {
  // 上帝模式不判负。
  //
  // 沙盒里"城"只是可以摆上来挨打的靶子，不是根：有人就想试"二十个长弓手
  // 能不能啃下一座铁器时代城"，这种局里没城的那一方恰恰是正常状态。
  // 按城判负会让第一回合就弹出"你赢了"，沙盒直接没法用。
  // 真正的停止条件是"一方没兵了"，由界面来判（main.ts 的 runGodFight）。
  if (s.config.godMode === true) return null;

  // 扩展特殊胜利条件
  for (const e of activeExpansions(s)) {
    if (e.hooks.checkWinner) {
      const winner = e.hooks.checkWinner(s);
      if (winner !== undefined) {
        return winner;
      }
    }
  }

  /*
   * 出局判定，只剩一家时结束。
   *
   * 两人局和以前完全一样：一方出局 = 另一方赢。三人四人局里"一方出局"只是
   * 少了一个人，剩下的人接着打——所以这里先算清楚谁还活着，再决定要不要收场。
   * 两条出局条件：城被打光，或者一个兵都没有且连一个都造不起。
   */
  const seats = seatsOf(s);
  const alive = seats.filter((p) => {
    if (isEliminated(s, p)) return false;
    if (unitsOf(s, p).length > 0) return true;
    return Object.values(s.unitTypes).some(
      (d) =>
        d.category !== 'building' &&
        !d.summonedOnly &&
        canPay(s.players[p], recruitResCost(s, p, d)),
    );
  });
  if (alive.length === seats.length) return null;
  if (alive.length === 1) return alive[0]!;
  // 一家都没了（同归于尽）：判给第一个还站着的……没有，那就平局
  if (alive.length === 0) return null;
  return null;
}

/**
 * 一个单位每回合产出些什么（金币 + 其它资源）。
 *
 * 经济单位的收入看它**站在哪儿**：农民在平原富、牧民在丘陵富、伐木工在森林富。
 * 所以"把农民挪到平原上"本身就是一个决策，而不再是"造完就忘"。
 * 相邻有水再加一点金币（灌溉和运输），这就是水利的价值。
 *
 * 多资源版本把"产出"从"一个金币数字"变成了一张表：同一种单位站在不同地形上
 * 可以产不同的东西（平原打粮、森林出木头）。金币仍然走 income / incomeByTerrain
 * 这两个老字段，所以原版两百多个兵种条目一个字都不用改。
 */
export function unitYield(s: GameState, u: Unit): ResourceCost {
  if (underConstruction(u)) return {};
  const def = utype(s, u.type);
  const tile = tileAt(s, u.x, u.y);
  const out: ResourceCost = {};
  const add = (id: ResourceId, n: number | undefined): void => {
    if (!n) return;
    out[id] = (out[id] ?? 0) + n;
  };

  if (tile) {
    const byTerrain = def.yieldByTerrain?.[tile.terrain];
    if (byTerrain) {
      for (const [id, n] of Object.entries(byTerrain)) add(id, n);
    } else if (def.yield) {
      for (const [id, n] of Object.entries(def.yield)) add(id, n);
    }
    // 金币沿用老的两条：写了表就按表（站错地方就是 0），没写表才用固定值
    if (def.incomeByTerrain) add(GOLD, def.incomeByTerrain[tile.terrain] ?? 0);
    else add(GOLD, def.income);
  } else if (def.yield) {
    for (const [id, n] of Object.entries(def.yield)) add(id, n);
  }

  if ((out[GOLD] ?? 0) > 0 && adjacentToWater(s, u.x, u.y)) {
    // 桥面也要算"临水"：桥架在水上，桥下还是水。
    // 只判 water 的话，玩家在河边修一座桥，反而把这一带的贸易加成弄没了——
    // 这是实打实踩过的 bug（建桥之后沿岸农民全少 3 金收入）。
    add(GOLD, CONFIG.riverTradeBonus);
  }

  let yields = out;
  for (const e of activeExpansions(s)) {
    if (e.hooks.modifyYield) yields = e.hooks.modifyYield({ state: s, unit: u, yields });
  }
  return cleanCost(yields);
}

/** 一个单位每回合产出多少**金币**（老接口，等价于 unitYield 的金币那一段） */
export function unitIncome(s: GameState, u: Unit): number {
  return unitYield(s, u)[GOLD] ?? 0;
}

/**
 * 经济单位**如果**站在 (x,y)，每回合能收多少。
 *
 * 给移动预览用：选中农民时，可达的每个格子都要印出"来这儿能收几金"。
 * 不动真身——只临时借用坐标算完就还，整个过程同步、无副作用。
 * (x,y) 必须是 reachableTiles 给出的可达格，落点合法性由调用方保证。
 */
export function unitIncomeAt(s: GameState, u: Unit, x: number, y: number): number {
  const ox = u.x;
  const oy = u.y;
  u.x = x;
  u.y = y;
  const income = unitIncome(s, u);
  u.x = ox;
  u.y = oy;
  return income;
}

/**
 * 这一方现在每回合能收多少（**全部资源**）。纯函数，不写状态。
 *
 * 金币那一段仍然过一遍 modifyIncome 钩子（战争经济之类的老扩展读它），
 * 其它资源暂时没有钩子——它们本来就只在多资源扩展里出现，
 * 而那个扩展自己就是唯一的生产者。
 */
export function incomeResOf(s: GameState, p: PlayerId): ResourceCost {
  const out: ResourceCost = { gold: CONFIG.baseIncome };
  const add = (id: ResourceId, n: number | undefined): void => {
    if (!n) return;
    out[id] = (out[id] ?? 0) + n;
  };
  for (const city of citiesOf(s, p)) {
    if (city.ruined) continue; // 废墟不产出：它现在只是一堆石头
    add(GOLD, eraDef(city.era).cityIncome);
  }
  for (const u of unitsOf(s, p)) {
    const yields = unitYield(s, u);
    for (const [id, n] of Object.entries(yields)) add(id, n);
  }
  let gold = out[GOLD] ?? 0;
  for (const e of activeExpansions(s)) {
    if (e.hooks.modifyIncome) gold = e.hooks.modifyIncome({ state: s, player: p, income: gold });
  }
  out[GOLD] = Math.max(0, gold);
  return cleanCost(out);
}

/**
 * 这一方现在每回合能收多少金。**纯函数，不写状态。**
 *
 * 单独抽出来是因为界面要拿它算"接下来几回合大概还有多少钱可花"。
 * 估算和真实结算必须同源——各写一遍的话，指挥官排计划时看到的数字
 * 早晚会和实际扣钱对不上，而这个模式的全部乐趣就是算这笔账。
 */
export function incomeOf(s: GameState, p: PlayerId): number {
  return incomeResOf(s, p)[GOLD] ?? 0;
}

/** 回合结束时给当前玩家结算收入：基础 + 每座城 + 每个经济单位按其所在地形 */
function settleIncome(s: GameState, p: PlayerId): ResourceCost {
  const income = incomeResOf(s, p);
  const player = s.players[p];
  for (const [id, n] of Object.entries(income)) addRes(player, id, n ?? 0);
  return income;
}

/**
 * 开局给先手补一次回合收入。
 *
 * 收入是在"结束回合、把回合交给对方"那一刻结算的（doEndTurn 里给 nextPlayer 结算）。
 * 所以后手 B 在自己还没动之前就已经拿到了第一回合的钱，而先手 A 要等到
 * 自己第一回合结束才拿——同一个"第一回合"，A 少了一次收入。
 *
 * 两边都拿，等于谁都没占便宜；这比"让 B 也别拿"更好，因为开局就有钱
 * 才能在第一回合做出有意义的选择（造第二个兵、升级、架桥）。
 */
export function grantOpeningIncome(s: GameState): ResourceCost {
  const income = settleIncome(s, 'A');
  const label = Object.keys(income).length > 0 ? incomeLabel(income) : '没有收入';
  pushLog(s, 'A', `开局结算：第一回合收入 ${label}`);
  return income;
}

/**
 * 城市回血：有驻军、且城外没有敌人时，每回合恢复耐久。
 *
 * 为什么需要这条：城市被打到只剩几点耐久、你夺回来之后，它就一直是那几点。
 * 攻方只要留一支小队就能第二轮再摘下它 —— "占领"等于没占。
 * 加上回血之后，守住一座城变成一个需要投入兵力的动作：
 *   · 有驻军才回血 → 光占着不算，得留人
 *   · 城外有敌人就不回血 → 想拆掉对方城，就得先把它围起来
 * 这两条合起来，让"围城"从一个说法变成一个动作。
 */
function recoverCities(s: GameState, p: PlayerId): void {
  for (const city of citiesOf(s, p)) {
    if (city.hp >= city.maxHp) continue;
    const heal = cityRegenOf(s, city);
    if (heal <= 0) continue;
    city.hp = Math.min(city.maxHp, city.hp + heal);
  }
}

/**
 * 这座城市这一回合能回多少耐久。0 表示回不了血。
 *
 * 单独导出来，是因为界面要把它写明白（"驻军 1 · 每回合 +4"），
 * 而这些数字必须和规则完全同源，不能各算一遍。
 */
export function cityRegenOf(s: GameState, city: City): number {
  // 废墟不回血：它连墙都没了
  if (city.ruined) return 0;
  const garrison = s.units.filter(
    (u) => u.owner === city.owner && cityTiles(city).some((t) => t.x === u.x && t.y === u.y),
  ).length;
  if (garrison === 0) return 0;

  // 被围城就不休整：敌方单位（活人，不是幽灵）贴在城墙一圈内
  if (s.units.some((u) => u.owner !== city.owner && distToCity(u, city) <= 1)) return 0;

  const bonus = Math.min(
    CONFIG.cityRegenCap - CONFIG.cityRegen,
    Math.max(0, garrison - 1) * CONFIG.cityRegenPerExtra,
  );
  let regen = CONFIG.cityRegen + bonus;
  for (const e of activeExpansions(s)) {
    if (e.hooks.modifyCityRegen) regen = e.hooks.modifyCityRegen({ state: s, city, regen });
  }
  return Math.max(0, regen);
}

/**
 * 这座城市升下一级要多少钱（算上扩展规则）；已封顶返回 null。
 *
 * 单独导出来，是因为界面、AI、规则三处都要问同一个问题，
 * 而扩展（血战）会让这个价随时间变——各算一遍一定会对不上。
 *
 * **封顶判定在钩子之前**：能不能升是规则（`eraCeilingOf`，取决于开没开
 * 「现代战争」），多少钱是扩展的事。反过来的话，「血战」那种
 * "照旧价目表收钱"的钩子会在封顶之后把 null 又变回一个价格，
 * 玩家就会看见一个点得动、点了却没反应的按钮。
 */
export function upgradeCostOf(s: GameState, city: City): number | null {
  if (city.era >= eraCeilingOf(s)) return null;
  let cost = nextUpgradeCost(city.era);
  for (const e of activeExpansions(s)) {
    if (e.hooks.modifyUpgradeCost) {
      cost = e.hooks.modifyUpgradeCost({
        state: s,
        player: city.owner,
        city,
        nextEra: city.era + 1,
        cost,
      });
    }
  }
  return cost === null ? null : Math.max(0, cost);
}

/**
 * 建筑在敌方回合开始时自动开火。
 *
 * 时机选在"对方刚接手回合"，而不是自己回合结束前，是因为这样守方才算真正
 * 享受到防御工事的好处：敌人一踏进射程就先挨一轮，然后才轮到它行动。
 */
function fireBuildings(s: GameState, owner: PlayerId): void {
  const buildings = s.units.filter(
    (u) => u.owner === owner && utype(s, u.type).autoAttack && !underConstruction(u),
  );
  for (const b of buildings) {
    if (!s.units.includes(b)) continue;
    // 这一回合已经手动开过火的，不再自动开火。
    //
    // 判据用 manualFired 而不是 acted：刚建好的建筑也是 acted=true。
    if (b.manualFired) continue;
    const def = utype(s, b.type);
    // 多动：自动开火也要把这一回合的攻击次数打满。
    // 每一发都重新挑"最近的、血最少的"，所以打死一个会自动转火下一个。
    let shots = attacksPerTurn(s, b);
    if (shots <= 0) continue;
    let hits = 0;
    let totalDmg = 0;
    const hitNames = new Set<string>();
    const splashNames = new Set<string>();
    /**
     * 按"挨打的是谁家"分账。
     *
     * 两人局里挨打的必然只有一家，可以写死 `other(owner)`；三人四人局里
     * 一座塔的射程可能同时覆盖两家的人，一条战报发给一边就成了漏报。
     * 所以先按主人分组，打完之后各自收自己那一条。
     */
    const byVictim = new Map<PlayerId, { names: Set<string>; dmg: number }>();
    const noteVictim = (u: Unit, dmg: number) => {
      if (u.owner === owner) return;
      const box = byVictim.get(u.owner) ?? { names: new Set<string>(), dmg: 0 };
      box.names.add(utype(s, u.type).name);
      box.dmg += dmg;
      byVictim.set(u.owner, box);
    };

    while (shots > 0) {
      const inRange = s.units
        .filter((u) => u.owner !== owner && distance(b, u) > 0 && distance(b, u) <= def.range)
        .sort((x, y) => distance(b, x) - distance(b, y) || x.hp - y.hp);
      const target = inRange[0];
      if (!target) break;

      const dmg = computeDamage(s, b, target);
      target.hp -= dmg;
      totalDmg += dmg;
      hits += 1;
      shots -= 1;
      hitNames.add(utype(s, target.type).name);

      // 塔/炮台的自动开火也算一次攻势——但它在"接手方回合开始"那一刻结算，
      // 所以要显式落到"上一个回合"的账上（s.turn - 1），否则接手方看不到。
      const prevTurn = s.turn - 1;
      const victimSide = other(owner);
      const tn = footprintOf(s, target);
      const center = {
        x: Math.min(Math.max(b.x, target.x), target.x + tn - 1),
        y: Math.min(Math.max(b.y, target.y), target.y + tn - 1),
      };
      for (const i of strikeCoverCells(
        s, b, center, splashRadiusOf(s, b), utype(s, b.type).splashLine === true,
      )) {
        const { x, y } = xyOf(s, i);
        noteHeatAt(s, victimSide, prevTurn, x, y);
      }

      // 炮台/要塞也吃溅射：不然"炮"这种单位自动开火时反而比手动开炮弱
      const splashed = splashVictims(s, b, target);
      for (const v of splashed) {
        v.unit.hp -= v.dmg;
        splashNames.add(utype(s, v.unit.type).name);
        noteVictim(v.unit, v.dmg);
      }

      if (target.hp <= 0) {
        // 走完整死亡流程：删除 + 战报 + 沉船 + onDeath / onUnitKilled
        abilityApi.killUnit(s, target, b, `${utype(s, target.type).name} 被击毁`);
      }

      for (const v of splashed) {
        if (v.unit.hp > 0) continue;
        if (!s.units.some((u) => u.id === v.unit.id)) continue;
        abilityApi.killUnit(s, v.unit, b, `${utype(s, v.unit.type).name} 被炮火波及消灭`);
      }
    }

    if (hits === 0) continue;
    const splashText = splashNames.size > 0 ? `，溅射 ${[...splashNames].join('、')}` : '';
    pushLog(
      s,
      owner,
      `${def.name} 自动开火${hits > 1 ? ` ${hits} 次` : ''}，对 ${[...hitNames].join('、')} 共造成 ${totalDmg} 点伤害${splashText}`,
    );
    // 挨打的一方也要有一条：塔和营是在**对面回合开始时**自己开火的，
    // 不写这一条，防守方看到的就是"我的兵凭空掉血"（理由同 doAttack 里那段）。
    for (const [who, box] of byVictim) {
      pushLog(
        s,
        who,
        `${def.name} 对 ${[...box.names].join('、')} 开火，共造成 ${box.dmg} 点伤害`,
      );
    }
  }
}

/**
 * 工地成型的收尾：桥要在这时候才变成桥面。
 *
 * 建到一半的桥如果提前通车，陆军会从一座"还不存在"的桥上走过去，
 * 而画面上的工地看起来随时会塌——先绕路，建完再通，才说得通。
 */
function finishBuild(s: GameState, u: Unit): void {
  if (!utype(s, u.type).bridges) return;
  const tile = tileAt(s, u.x, u.y);
  if (tile && tile.terrain === 'water') tile.terrain = 'bridge';
}

/**
 * 施工进度：自己回合开始时，工地到账一波建造点数，够了就算建成。
 *
 * 放在"重置行动力"之后、"再生/休整"之前：这一回合刚建成的塔应该能开火。
 *
 * 点数而不是回合：到账量取决于建它的工兵（buildRate），所以"老兵带新兵"
 * 和"换个更强的工兵"在同一座塔上会读出不同的工期——这才是工兵差异的落点。
 */
function advanceConstruction(s: GameState, p: PlayerId): void {
  for (const u of s.units) {
    if (u.owner !== p) continue;
    if (!underConstruction(u)) continue;
    if ((u.buildNeed ?? 0) > 0) {
      const rate = Math.max(1, u.buildRate ?? buildPowerOf(utype(s, u.type)));
      u.buildDone = (u.buildDone ?? 0) + rate;
      if ((u.buildDone ?? 0) >= (u.buildNeed ?? 0)) {
        delete u.buildDone;
        delete u.buildNeed;
        delete u.buildRate;
        finishBuild(s, u);
        pushLog(s, p, `${utype(s, u.type).name} 建成`);
      }
      continue;
    }
    // 旧存档：只有剩余回合数，按 1 点/回合往前推
    u.buildLeft = (u.buildLeft ?? 0) - 1;
    if (u.buildLeft <= 0) {
      delete u.buildLeft;
      pushLog(s, p, `${utype(s, u.type).name} 建成`);
    }
  }
}

function resetUnitsFor(s: GameState, p: PlayerId): void {
  for (const u of s.units) {
    if (u.owner === p) {
      u.moved = false;
      u.acted = false;
      u.manualFired = false;
      delete u.attacksLeft;
      delete u.moveSpent;
    }
  }
}

/**
 * 把一个"干净的回合"交到 `to` 手上：行动力、反击次数都归零重来。
 *
 * 抽出来是因为**交接有两条路**，而它们必须给出同一个结果：
 *   · `doEndTurn` —— 正常打完这一回合，轮到下一家；
 *   · `doSurrender` —— 一家退出，把它剩下的回合让给下一位。
 *
 * 第二条以前没走这一步，只把 `current` 改了个名字。后果是接手的那一家带着
 * **自己上回合用剩的** moved/acted 进场：顶栏写着"轮到你"，可点哪个兵都动不了，
 * 那是它上一轮留下的标记。反击次数同理会少一截（`countersLeft` 是防守时
 * 一个个扣掉的，只有"新回合"才清零）。
 */
function grantTurnTo(s: GameState, to: PlayerId): void {
  // 新回合开始，所有单位的反击次数重置（不分敌我：这是"每回合一次"的额度）
  for (const u of s.units) delete u.countersLeft;
  resetUnitsFor(s, to);
}

/**
 * 记一笔"这一炮是人点的"。
 *
 * 只对能自动开火的建筑有意义——它们一回合只该有一段火力：
 * 你点了就由你打，没点才轮到回合结束时的自动那一下（见 fireBuildings）。
 */
function markManualFire(s: GameState, u: Unit): void {
  if (utype(s, u.type).autoAttack) u.manualFired = true;
}

/**
 * 唯一的状态迁移入口。
 * 所有 UI 操作、AI、未来的联机请求，都必须走这里。
 */
/**
 * 把"我这一手"补到房间里的**最新**状态上（联机选卡的合并规则）。
 *
 * 联机 AB 同时禁用时，两边都会先在本机落一步再提交。后交的那一方一定被
 * 进度号挡回来——这不是冲突，是常态。挡回来之后**不能**直接覆盖房间：
 * 那会把对面刚提的那一步抹掉，两边从此各拿一份对方没有的名单互相等
 * （界面上就是"禁不动、选不动"）。正确做法是把手里这一步补到房间那份上，
 * 再用新的进度号重交。抽成纯函数是为了能有用例盯着这段协议。
 *
 * 补不进去（对面已经禁过、轮到别人选、这一格已经不是你的）就返回失败，
 * 调用方按"房间是权威"处理：退回房间那份，把出手权还给玩家。
 */
export function mergeDraftStep(
  remote: GameState,
  action: Action,
  actor: PlayerId,
): ActionResult {
  return applyAction(remote, action, actor);
}

export function applyAction(s: GameState, action: Action, actor?: PlayerId): ActionResult {
  if (s.winner) return { ok: false, reason: '对局已结束' };

  const by = actor ?? s.current;

  /*
   * 选卡模式：开局这一段走的是另一套状态机。
   *
   * 两个方向都要挡：
   *   1. 选卡动作 → 直接交给 draft.applyDraftAction（它不管 `s.current`，
   *      因为禁用期是双方同时进行的）；
   *   2. 普通动作 → 选卡没打完一律拒掉。不挡的话玩家能在 BP 期间就开始
   *      造兵走子，那这一局的名单就成了装饰。
   */
  if (
    action.type === 'DRAFT_START' ||
    action.type === 'DRAFT_SKIP' ||
    action.type === 'DRAFT_BAN' ||
    action.type === 'DRAFT_PICK' ||
    action.type === 'DRAFT_TIMEOUT'
  ) {
    const staged = cloneState(s);
    return applyDraftAction(staged, action, by);
  }
  if (draftInProgress(s)) {
    return { ok: false, reason: '先完成选卡，然后才轮到走棋' };
  }
  if (by !== s.current) return { ok: false, reason: '还没轮到你行动' };

  const next = cloneState(s);
  // 招魂要读"本回合谁没了"，所以每一个动作前后各数一次人头（见 recordDeaths）
  const rosterBefore = rosterOf(next);

  const result: ActionResult = (() => {
    switch (action.type) {
      // 选卡动作在上面就被分流走了，类型在这里已经被排除，不用也不该再列分支
      case 'MOVE':
        return doMove(next, action.unitId, action.x, action.y);
      case 'ATTACK':
        return doAttack(next, action.unitId, action.targetId, action.x, action.y);
      case 'SIEGE':
        return doSiege(next, action.unitId, action.cityId, action.x, action.y);
      case 'RECRUIT':
        return doRecruit(
          next,
          action.cityId,
          action.unitId,
          action.unitType,
          typeof action.x === 'number' && typeof action.y === 'number'
            ? { x: action.x, y: action.y }
            : undefined,
        );
      case 'BUILD':
        return doBuild(next, action.unitId, action.unitType, action.x, action.y);
      case 'LOAD':
        return doLoad(next, action.unitId, action.cargoId);
      case 'UNLOAD':
        return doUnload(next, action.unitId, action.cargoId, action.x, action.y);
      case 'UPGRADE':
        return doUpgrade(next, action.cityId);
      case 'SET_ORDERS':
        return doSetOrders(next, action.queue, action.sites);
      case 'SET_DIRECTIVE':
        return doSetDirective(next, action.directive);
      case 'PLAN_COMMIT':
        return doPlanCommit(next);
      case 'PLAN_END':
        return doPlanEnd(next);
      case 'DISBAND':
        return doDisband(next, action.unitId);
      case 'HERO_SKILL':
        return doHeroSkill(next, action.unitId, action.skillId, action.targetX, action.targetY);
      case 'PLACE_EGG':
        return doPlaceEgg(next, action.x, action.y);
      case 'SURRENDER':
        return doSurrender(next);
      case 'END_TURN':
        return doEndTurn(next);
    }
  })();

  if (result.ok) {
    syncBridges(result.state);
    // 放在 syncBridges 之后：桥塌落水也算"这一下没的"，早写就漏掉那一批
    recordDeaths(result.state, rosterBefore, action);
    result.state.winner = result.state.winner ?? checkWinner(result.state);
    refreshMemory(result.state);
  }

  return result;
}

/**
 * 桥面与桥的存活状态对齐。
 *
 * 桥就是"站在水格上的建筑 + 把那一格改成桥面"。这样一套数据能同时满足：
 * 谁都能从上面走过（桥面双向通行，不是自家专属的浮桥）、
 * 但谁也停不下来（那一格被桥自己占着，只能穿）——
 * 想断掉这条路，只能把桥打塌，打塌之后地形自动回退成水。
 *
 * 做成每次动作后统一对账，而不是"在七八处删除单位的地方各写一遍"：
 * 阵亡、自爆波及、城破守军损失这些路径都会经过这里，漏不掉。
 */
function syncBridges(s: GameState): void {
  const alive = new Set<number>();
  for (const u of s.units) {
    if (utype(s, u.type).bridges) alive.add(u.y * s.w + u.x);
  }
  const collapsed: number[] = [];
  for (let i = 0; i < s.tiles.length; i++) {
    const tile = s.tiles[i];
    if (tile && tile.terrain === 'bridge' && !alive.has(i)) {
      tile.terrain = 'water';
      collapsed.push(i);
    }
  }
  if (collapsed.length === 0) return;

  // 桥塌的时候站在桥上的陆军一起没：那一格已经变回水面了，
  // 留着会得到一个"漂在水上的步兵"，后续所有寻路和攻击判定都会错乱。
  const drowned = s.units.filter((u) => {
    if (utype(s, u.type).domain === 'water') return false; // 船本来就在水上
    return collapsed.includes(u.y * s.w + u.x);
  });
  if (drowned.length === 0) return;
  for (const u of drowned) {
    pushLog(s, u.owner, `桥被摧毁，${utype(s, u.type).name} 落水`, true);
  }
  const gone = new Set(drowned.map((u) => u.id));
  s.units = s.units.filter((u) => !gone.has(u.id));
}

/**
 * 留痕种类能用的那几件东西。
 *
 * 为什么不把 `pushLog` / `utype` 直接传给 kind：marks.ts 只依赖类型，
 * 一旦它 import 规则层就是循环。给一个小接口，扩展拿到的能力和
 * 兵种能力的钩子（`c.api`）是同一套语义，写起来不用换脑子。
 *
 * 雷炸出来的伤害**不走进攻公式**（无护甲、无地形、无反击）：
 * 地雷不跟你讲武德，扣血就是扣血。这也是它和"一次正常攻击"最清楚的分界。
 */
function markApi(s: GameState): MarkApi {
  return {
    utype: (typeId) => utype(s, typeId),
    log: (owner, text, open = true) => pushLog(s, owner, text, open),
    hurt: (unit, amount, text) => {
      const dmg = Math.max(0, Math.round(amount));
      if (dmg <= 0) return;
      unit.hp -= dmg;
      pushLog(s, unit.owner, text, true);
    },
  };
}

function doMove(s: GameState, unitId: string, x: number, y: number): ActionResult {
  const unit = unitById(s, unitId);
  if (!unit) return { ok: false, reason: '单位不存在' };
  if (unit.owner !== s.current) return { ok: false, reason: '这不是你的单位' };
  if (unit.moved) return { ok: false, reason: '该单位本回合已经移动过' };
  if (!inBounds(s, x, y)) return { ok: false, reason: '目标越界' };

  const reach = reachableTiles(s, unit);
  if (!reach.has(idx(s, x, y))) return { ok: false, reason: '目标格不可达' };

  // 把到达目标格的真实消耗加进 moveSpent
  const cost = reach.get(idx(s, x, y))!;
  unit.moveSpent = (unit.moveSpent ?? 0) + cost;

  // 走进废墟 = 接管。钱要在动之前就查：走到一半发现掏不起重建费，
  // 会留下一个"已经站在城里但城市还是别人的"的中间态，很难收拾。
  const destTile = tileAt(s, x, y);
  const destCity = destTile?.cityId ? cityById(s, destTile.cityId) : null;
  if (destCity?.ruined) {
    const price = rebuildCost(destCity);
    if (s.players[unit.owner].gold < price) {
      return { ok: false, reason: `接管这座废墟要 ${price} 金重建，金币不够` };
    }
  }

  unit.x = x;
  unit.y = y;
  unit.moved = true;

  // 落脚之后再算雷：**先站上去，再挨炸**。
  // 顺序不能反——反过来的话"能不能进这一格"要先去问一遍地上的东西，
  // 于是"踩雷"变成"这一步走不成"，雷就从陷阱变成了空气墙。
  if (marksOf(s).length > 0) {
    enterTile(s, unit, markApi(s));
    // 炸死的就地清场：不清的话，下一步"入驻废墟"会由一个 0 血的单位执行
    if (unit.hp <= 0) {
      sweepDead(s);
      return { ok: true, state: s };
    }
  }

  if (destCity?.ruined) {
    const price = rebuildCost(destCity);
    const prevOwner = destCity.owner;
    s.players[unit.owner].gold -= price;
    destCity.owner = unit.owner;
    destCity.ruined = false;
    destCity.hp = Math.max(1, Math.ceil(destCity.maxHp * CITY.captureHpRatio));
    destCity.capturedTurn = s.turn;
    pushLog(s, unit.owner, `入驻废墟，支付 ${price} 金重建，${cityName(destCity)} 归你`, true);
    s.winner = checkWinner(s);
    // 这是全代码里**唯一**一处城市易手，所以"丢掉最后一座城"也只可能发生在这里
    retireLostSeat(s, prevOwner);
  }

  return { ok: true, state: s };
}

/**
 * 决定"主命中格"：鼠标点了哪一格就用哪一格；没点（AI / 旧存档）就退到
 * "矩形上离攻击者最近的那一格"——那是玩家如果点鼠标一定会点的位置。
 * `hit` 必须落在矩形内，否则当作没点。
 */
function pickHitCell(
  attacker: Unit,
  rect: { x: number; y: number; n: number },
  hit?: { x?: number; y?: number },
): { x: number; y: number } {
  if (typeof hit?.x === 'number' && typeof hit?.y === 'number') {
    const inRect =
      hit.x >= rect.x && hit.x < rect.x + rect.n &&
      hit.y >= rect.y && hit.y < rect.y + rect.n;
    if (inRect) return { x: hit.x, y: hit.y };
  }
  return {
    x: Math.min(Math.max(attacker.x, rect.x), rect.x + rect.n - 1),
    y: Math.min(Math.max(attacker.y, rect.y), rect.y + rect.n - 1),
  };
}

/**
 * 一次攻击的战况烈度记录：几何覆盖的所有格子各记一次。
 *
 * 攻击单位 / 攻城 / 塔自动开火共用——"打了哪儿"必须同一套几何。
 * 以前三处各写各的（doAttack 用了旧签名的 noteHeat、doSiege 压根没写），
 * 症状就是"打到城的这一面，整个城都红"和"溅射覆盖到的城外空地不红"。
 */
function noteStrikeHeat(
  s: GameState,
  attacker: Unit,
  rect: { x: number; y: number; n: number },
  hit?: { x?: number; y?: number },
): void {
  const center = pickHitCell(attacker, rect, hit);
  const radius = splashRadiusOf(s, attacker);
  const line = utype(s, attacker.type).splashLine === true;
  for (const i of strikeCoverCells(s, attacker, center, radius, line)) {
    const { x, y } = xyOf(s, i);
    noteHeatCell(s, x, y);
  }
}

function doAttack(
  s: GameState,
  unitId: string,
  targetId: string,
  hitX?: number,
  hitY?: number,
): ActionResult {
  const attacker = unitById(s, unitId);
  const defender = unitById(s, targetId);
  if (!attacker) return { ok: false, reason: '单位不存在' };
  if (!defender) return { ok: false, reason: '目标不存在' };
  if (attacker.owner !== s.current) return { ok: false, reason: '这不是你的单位' };
  if (defender.owner === attacker.owner) return { ok: false, reason: '不能攻击友军' };
  if (underConstruction(attacker)) {
    return { ok: false, reason: `${utype(s, attacker.type).name} 还在施工，没装好武器` };
  }
  if (attacker.acted) return { ok: false, reason: '该单位本回合已经攻击过' };

  // 反击判定也要按"还手的那个人"来算距离：地面兵够不着头顶的飞行单位，
  // 就不能在被飞行单位贴脸打的时候原地还手。这里必须换成
  // strikeDistance(defender, attacker)——写成攻击方的距离，等于只限制了
  // 进攻、放过了防守，这条规则就形同虚设。
  if (!canStrike(s, attacker, defender)) {
    return {
      ok: false,
      // 桥现在不再是"必须贴到桥头"：这一条只在射程真的不够时才会走到。
      // 隔河能打、但只算半伤，见 computeDamage 收尾的拆桥折扣。
      reason: utype(s, defender.type).bridges
        ? '射程不够，还够不着这座桥'
        : '目标超出射程',
    };
  }

  const atkDef = utype(s, attacker.type);
  const atName = atkDef.name;
  const dfName = utype(s, defender.type).name;

  // 本回合第一次攻击时把剩余次数填满；之后每次攻击各扣一次
  if (attacker.attacksLeft === undefined) {
    attacker.attacksLeft = Math.max(1, attacksPerTurn(s, attacker));
  }
  if (attacker.attacksLeft <= 0) {
    return { ok: false, reason: '该单位本回合没有剩余攻击次数' };
  }
  const dmg = computeDamage(s, attacker, defender);
  defender.hp -= dmg;

    // 战况烈度：一次攻击覆盖到的所有格，纯几何
  // （主命中格 = 鼠标点的格；溅射 = 以它为圆心扩 radius 格）
  noteStrikeHeat(
    s, attacker,
    { x: defender.x, y: defender.y, n: footprintOf(s, defender) },
    { x: hitX, y: hitY },
  );

  const splashed = splashVictims(s, attacker, defender);
  for (const v of splashed) {
    v.unit.hp -= v.dmg;
  }

  const noCounter = hasFlagOn(s, attacker, 'noCounter');
  let counterDmg = 0;
  // 防守方的反击次数也按"一回合能攻击几次"算，第一次挨打时填满
  if (defender.countersLeft === undefined) {
    defender.countersLeft = Math.max(0, attacksPerTurn(s, defender));
  }

  // 判断是否反击：不仅要活下来、不能先手，还要反击次数 > 0
  if (!noCounter && defender.hp > 0 && defender.countersLeft > 0 && canStrike(s, defender, attacker)) {
    counterDmg = computeDamage(s, defender, attacker, true);
    attacker.hp -= counterDmg;
    
    // 消耗一次反击机会
    defender.countersLeft -= 1; 
  }

  // 出手流程里的补充：吸血在这一步（反击之后、命中状态之前），
  // 击退在后面（命中状态之后）。同一条兵种挂了两条时按 abilities 的顺序跑。
  const sctx: StrikeCtx = {
    state: s,
    self: attacker,
    target: defender,
    damage: dmg,
    api: abilityApi,
    result: { healed: 0, pushed: false },
  };
  const strikeHooks = stagedOfUnit<StrikeCtx>(s, attacker, 'onStrike');

  // 吸血：把这一下真打出来的伤害换成血。放在反击之后结算
  runStaged(strikeHooks, sctx, { to: STRIKE_STAGE.postDamage });
  const healed = sctx.result.healed;
  runStaged(strikeHooks, sctx, { from: STRIKE_STAGE.postDamage, to: STRIKE_STAGE.afterStatus });

  const hitText = '';

  // 命中附带的状态 / 击退，都排在"打完之后、结算死亡之前"
  const statusTouched = applyOnHitStatus(s, attacker, defender, dmg);
  // 命中附带的状态，例如击退
  runStaged(strikeHooks, sctx, { from: STRIKE_STAGE.afterStatus, to: STRIKE_STAGE.postStatus });
  // 击退之后
  runStaged(strikeHooks, sctx, { from: STRIKE_STAGE.postStatus });
  const pushed = sctx.result.pushed;
  // 弹药：打一次少一发。打光了还能贴身砍，只是不再有魔法段、射程掉回 1。
  if (typeof atkDef.ammo === 'number') {
    attacker.ammoLeft = Math.max(0, (attacker.ammoLeft ?? atkDef.ammo) - 1);
  }

  const splashText =
    splashed.length > 0
      ? `，溅射 ${splashed.map((v) => utype(s, v.unit.type).name).join('、')}`
      : '';
  const statusText = statusTouched.length > 0 ? `，附带 ${statusTouched.join('、')}` : '';
  const pushText = pushed ? '，被推开 1 格' : '';
  pushLog(
    s,
    attacker.owner,
    dmg > 0
      ? `${atName} 攻击 ${dfName}，${hitText}造成 ${dmg} 伤害${splashText}${statusText}${pushText}${counterDmg > 0 ? `，遭到 ${counterDmg} 反击` : ''}`
      : `${atName} 攻击 ${dfName}，穿不透护甲，没有造成伤害${splashText}${pushText}`,
  );
  /*
   * 挨打的那一方也要有一条战报。
   *
   * 上面那条是按出手方写的（`pushLog` 不传 `open` 就只有他自己看得见）。
   * 于是防守方遇到的是：血量掉了，战报里一个字都没有——远程单位尤其明显，
   * 一门射程 5、溅射 2 的火炮能把「离它 7 格」的人一起打到，
   * 而挨打的人那边连"我被打了"都没记一笔，看起来就像凭空掉血。
   *
   * 写什么：打中谁、掉多少、波及了谁。**不写攻击者站哪**——
   * 那是迷雾该管的事。只有隐匿（潜行 / 刺客大师）中的袭击者才连名字都不给，
   * 否则"是谁打的我"这条信息就把隐匿本身废掉了。
   */
  if (dmg > 0 || splashed.length > 0) {
    const unseen = isHiddenFrom(s, attacker, defender.owner);
    pushLog(
      s,
      defender.owner,
      `${unseen ? '视野外的一击' : atName} 打在 ${dfName} 身上，造成 ${dmg} 伤害${splashText}${statusText}${pushText}`,
    );
  }
  if (healed > 0) pushLog(s, attacker.owner, `${atName} 吸取 ${healed} 点生命`);

  // 投斧那一类是"技能白送的一下"：它不写 acted/moved，扔完还能再正常打一次。
  // 顺手把射程/折扣收回去——斧子扔出去了，手里只剩刀。
  if (attacker.heroBuff?.freeShot) {
    const rest = { ...attacker.heroBuff };
    delete rest.freeShot;
    delete rest.range;
    delete rest.rangeMul;
    attacker.heroBuff = Object.keys(rest).length > 0 ? rest : undefined;
    pushLog(s, attacker.owner, `${atName} 的这一下不占本回合的攻击`);
  } else {
    attacker.attacksLeft = Math.max(0, (attacker.attacksLeft ?? 1) - 1);
    attacker.moved = true;
    
    // 次数扣完了，才算彻底行动结束
    if (attacker.attacksLeft <= 0) {
      attacker.acted = true;
    }
    markManualFire(s, attacker);
  }

  // 一出手就现形：技能隐匿只保到"你先动手为止"，不是永久隐身。
  if (attacker.heroBuff?.hidden) {
    const rest = { ...attacker.heroBuff };
    delete rest.hidden;
    attacker.heroBuff = Object.keys(rest).length > 0 ? rest : undefined;
    pushLog(s, attacker.owner, `${atName} 动手，隐匿失效`);
  }
  // 挨了实伤一样暴露：刀落在身上，隐身衣挡不住
  if (dmg > 0 && defender.heroBuff?.hidden) {
    const rest = { ...defender.heroBuff };
    delete rest.hidden;
    defender.heroBuff = Object.keys(rest).length > 0 ? rest : undefined;
  }

  if (defender.hp <= 0) {
    s.units = s.units.filter((u) => u.id !== defender.id);
    pushLog(s, attacker.owner, `${dfName} 被消灭`, true);
    drownCargo(s, defender);
    fireKilled(s, defender, attacker);
    // 收割（刺客大师）：亲手斩掉一个，本回合的移动力就还回来。
    //
    // 只还移动、不还攻击。攻击次数由 acted 管着，这里刻意不碰——
    // "杀完再走一步"是脱战，而"杀完再砍一刀"是另一档强度，不在这个技能里。
    // 死在反击里的情况（attacker.hp <= 0）不给：人都倒了，走给谁看。
    if (attacker.hp > 0 && s.units.some((u) => u.id === attacker.id)) {
      const kctx: KillCtx = { state: s, self: attacker, victim: defender, api: abilityApi, result: { moveBack: false } };
      for (const h of hooksOfUnit(s, attacker)) h.onKill?.(kctx);
      if (kctx.result.moveBack) {
        attacker.moved = false;
        pushLog(s, attacker.owner, `${atName} 斩杀得手，本回合还能再走一次`);
      }
    }
  }

  // 溅射打死的也要走同一套善后：战报 + 沉船 + 击杀钩子
  for (const v of splashed) {
    if (v.unit.hp > 0) continue;
    if (!s.units.some((u) => u.id === v.unit.id)) continue;
    s.units = s.units.filter((u) => u.id !== v.unit.id);
    pushLog(s, attacker.owner, `${utype(s, v.unit.type).name} 被炮火波及消灭`, true);
    drownCargo(s, v.unit);
    fireKilled(s, v.unit, attacker);
  }
  if (attacker.hp <= 0) {
    s.units = s.units.filter((u) => u.id !== attacker.id);
    pushLog(s, attacker.owner, `${atName} 在反击中阵亡`, true);
    drownCargo(s, attacker);
    fireKilled(s, attacker, undefined);
  }

  s.winner = checkWinner(s);
  return { ok: true, state: s };
}

/**
 * 攻破城市：将城市变为废墟，并挤出城内的守军。
 * 
 * 这个函数是所有攻城行为的唯一真相来源。无论是物理攻城、剑修剑气还是天降陨石，
 * 只要城市耐久归零，都必须走这里。
 * 
 * 注意：这里只负责“破城”，不负责“接管”。接管依然需要派陆军走进废墟。
 */
export function destroyCity(s: GameState, city: City, attackerOwner: PlayerId): void {
  if (city.ruined) return; // 幂等：已经是废墟就不重复结算

  const prevOwner = city.owner;
  if (s.firstCityLost === undefined) s.firstCityLost = prevOwner;

  // 破城 ≠ 易主。城墙打塌，城市变废墟
  city.ruined = true;
  city.hp = 0;
  city.capturedTurn = s.turn;

  // 城破了，守军不该跟着一起没。把他们挤出城外。
  const tiles = cityTiles(city);
  const garrison = s.units.filter(
    (u) => u.owner === prevOwner && tiles.some((t) => t.x === u.x && t.y === u.y),
  );
  
  let spilled = 0;
  let stuck = 0;
  
  for (const g of garrison) {
    // 因为城市已经置为 ruined，canStandAt 会把城内格子排除，
    // 所以 freeNeighbor 只会往城外找位置。
    const spot = freeNeighbor(s, g, g.type);
    if (!spot) {
      stuck += 1;
      continue;
    }
    g.x = spot.x;
    g.y = spot.y;
    spilled += 1;
  }
  
  if (garrison.length > 0) {
    const parts: string[] = [];
    if (spilled > 0) parts.push(`${spilled} 个守军被逐出城外`);
    if (stuck > 0) parts.push(`${stuck} 个被围在废墟里无路可退`);
    pushLog(s, attackerOwner, `破城，${parts.join('，')}`, true);
  }

  pushLog(s, attackerOwner, `${cityName(city)} 被攻破——派兵入驻才能接管`, true);
}

function doSiege(
  s: GameState,
  unitId: string,
  cityId: string,
  hitX?: number,
  hitY?: number,
): ActionResult {
  const attacker = unitById(s, unitId);
  const city = cityById(s, cityId);
  if (!attacker) return { ok: false, reason: '单位不存在' };
  if (!city) return { ok: false, reason: '城市不存在' };
  if (attacker.owner !== s.current) return { ok: false, reason: '这不是你的单位' };
  if (city.owner === attacker.owner) return { ok: false, reason: '不能攻击自己的城市' };
  if (city.ruined) return { ok: false, reason: '这已经是废墟了，派兵入驻才能接管' };
  if (attacker.acted) return { ok: false, reason: '该单位本回合已经攻击过' };

  if (attacker.attacksLeft === undefined) {
    attacker.attacksLeft = Math.max(1, attacksPerTurn(s, attacker));
  }
  if (attacker.attacksLeft <= 0) {
    return { ok: false, reason: '该单位本回合没有剩余攻击次数' };
  }
  
  const dist = distToCity(attacker, city);
  if (dist > effectiveRangeAgainst(s, attacker, tileAt(s, city.x, city.y))) return { ok: false, reason: '城市超出射程' };

  const atName = utype(s, attacker.type).name;
  const dmg = damageToCity(attacker, city, s);
  city.hp -= dmg;

  // 战况烈度：攻城按几何覆盖记，和攻击单位走同一套
  noteStrikeHeat(s, attacker, { x: city.x, y: city.y, n: city.size }, { x: hitX, y: hitY });

  // 窃掠：砸墙还能顺手捞一笔。上限按对方金库算，
  // 不然一个盗贼反复敲同一座城就成了印钞机。
  // 捞多少由能力自己算（它拿到的是乘过攻城加成的 dmg），
  // 但"从谁身上扣、扣多少"必须留在规则里——钱是真的会少的。
  let loot = 0;
  const lctx: SiegeLootCtx = { state: s, self: attacker, city, damage: dmg, api: abilityApi, result: { loot: 0 } };
  for (const h of hooksOfUnit(s, attacker)) h.siegeLoot?.(lctx);
  if (lctx.result.loot > 0) {
    loot = Math.min(s.players[city.owner].gold, lctx.result.loot);
    if (loot > 0) {
      s.players[attacker.owner].gold += loot;
      s.players[city.owner].gold -= loot;
    }
  }

  pushLog(
    s,
    attacker.owner,
    dmg > 0
      ? `${atName} 攻城，城市损失 ${dmg} 点耐久${loot > 0 ? `，顺手偷走 ${loot} 金` : ''}`
      : `${atName} 攻城，但打不动这座城的城墙`,
  );

  attacker.attacksLeft = Math.max(0, (attacker.attacksLeft ?? 1) - 1);
  attacker.moved = true;
  if (attacker.attacksLeft <= 0) {
    attacker.acted = true;
  }
  markManualFire(s, attacker);

  if (city.hp <= 0) {
    destroyCity(s, city, attacker.owner);
  }

  s.winner = checkWinner(s);
  return { ok: true, state: s };
}

/**
 * 桥能不能从建造者这里"接着往前铺"。
 *
 * 桥面那一格是被桥自己占着的——单位过得了、停不下，所以工程队永远站不到
 * 第二段桥旁边。没有这条规则，两格宽的水道就是铺不通：铺好第一段，
 * 第二段的四邻里没有一格站得住人。这里改成按"沿着同一条直线，
 * 中间那几格是不是已经铺好的桥"来量距离，等于工程队站在岸上把桥往外递。
 *
 * 只认横平竖直：桥面是一条直线，斜着接没有物理意义。
 */
export function bridgeChainOk(builder: Unit, x: number, y: number, s: GameState): boolean {
  const dx = x - builder.x;
  const dy = y - builder.y;
  if (Math.abs(dx) + Math.abs(dy) <= CONFIG.buildRange) return true;
  if (dx !== 0 && dy !== 0) return false;
  const steps = Math.abs(dx) + Math.abs(dy);
  // 最多再接两节：再长就不是"过河"，是在水上修路了
  if (steps > CONFIG.buildRange + 2) return false;
  const sx = Math.sign(dx);
  const sy = Math.sign(dy);
  for (let k = 1; k < steps; k++) {
    const t = tileAt(s, builder.x + sx * k, builder.y + sy * k);
    if (!t || t.terrain !== 'bridge') return false;
  }
  return true;
}

/**
 * 由建造单位在野外盖建筑。
 *
 * 建筑不是凭空出现的：得有一个建造者走过去，花钱，把这一回合搭进去。
 * 所以"在哪儿修磨坊"和"派谁去修"都是要算的事。
 */
/**
 * 上船。
 *
 * 上船的单位整条从棋盘上摘掉，存进船的货舱里 —— 这样"船上的人不占格、
 * 不吃攻击、不受地形影响"全部自动成立。上船要花掉那个单位这一回合，
 * 所以"撤退"和"上岸进攻"之间有真实的时间成本。
 */
function doLoad(s: GameState, ferryId: string, cargoId: string): ActionResult {
  const ferry = unitById(s, ferryId);
  if (!ferry) return { ok: false, reason: '船不存在' };
  if (ferry.owner !== s.current) return { ok: false, reason: '这不是你的船' };

  const ferryDef = utype(s, ferry.type);
  // "能不能装、能装谁、装几个"全在兵种数据的 carry.hold 上，这里只读不猜。
  const hold = holdOf(ferryDef);
  if (!hold) return { ok: false, reason: '这个单位没有货舱' };
  if (ferry.acted) return { ok: false, reason: '这条船本回合已经装卸过了' };

  const cargo = unitById(s, cargoId);
  if (!cargo) return { ok: false, reason: '目标单位不存在' };
  if (cargo.owner !== s.current) return { ok: false, reason: '不能载别人的部队' };

  const cargoDef = utype(s, cargo.type);
  // 身份判定（水路/建筑/白名单……）也归数据：拒绝理由由 canHold 给，
  // 这样面板、AI、规则书说的是同一句话。
  const verdict = canHold(ferryDef, cargoDef);
  if (!verdict.ok) return { ok: false, reason: verdict.reason };
  if (cargo.acted) return { ok: false, reason: '这个单位本回合已经行动过了' };
  if (distance(ferry, cargo) !== 1) return { ok: false, reason: '要贴着船才能上船' };

  const load = ferry.cargo ?? [];
  if (holdRoom(ferryDef, ferry) <= 0) {
    return { ok: false, reason: `这条船装满了（${hold.max}）` };
  }

  // 上船：从棋盘上摘下来，整个对象存进货舱。
  //
  // `moved` / `acted` **原样保留**，不强行写成 true：加强渡船要知道
  // "这个兵本回合到底动没动过"——一律抹成 true，那份信息就没了，
  // 下船时只能按"谁也不能再动"处理。
  // （`acted` 在上面的前置里已经确认是 false，真正的差别在 `moved`。）
  s.units = s.units.filter((u) => u.id !== cargo.id);
  ferry.cargo = [...load, { ...cargo, x: ferry.x, y: ferry.y }];
  ferry.acted = true;

  pushLog(s, s.current, `${cargoDef.name} 登上了${ferryDef.name}`);
  return { ok: true, state: s };
}

/**
 * 下船：把人放到相邻的空地上。
 *
 * 落点用 blockedFor 判：不能是水、不能是高山、不能是敌方城市格。
 *
 * ── 加强渡船（2026-10-31）──────────────────────────────────────────────
 * 默认规则是"下船即罚站"：这一回合不能再动也不能再打。否则运输船就成了一条
 * 隔河空投骑兵连的传送门。但罚站也把"过河进攻"整条路堵死了——船靠岸那一回合
 * 什么都做不了，等于白送对方一轮。
 *
 * 现在的口径是：**下船那一刻还没行动过的兵，允许它照常行动一次**。
 * 三条边界把它锁在"一次"上：
 *   1. `cargo.acted !== true`：本回合已经行动过的（打过、或打完又动过）不给；
 *   2. `cargo.ferryBoostTurn !== s.turn`：同一个兵**一回合只吃一次**，
 *      换一条船再卸也不行——否则两艘船能把一次冲锋拆成两段；
 *   3. 只免掉"下船罚站"，不动行动次数：攻击仍受 burst / attacksLeft 约束。
 *
 * 落地时一律 `moved: false, acted: false`。原因是**下船必然发生在下一回合**：
 * 装船占掉船的一次装卸，下船还要再占一次，所以中间一定隔着一个回合边界。
 * 舱里带着的 `moved` 是上一轮的值，拿它当"这个兵这回合走没走过"就是读旧账了。
 */
function doUnload(
  s: GameState,
  ferryId: string,
  cargoId: string,
  x: number,
  y: number,
): ActionResult {
  const ferry = unitById(s, ferryId);
  if (!ferry) return { ok: false, reason: '船不存在' };
  if (ferry.owner !== s.current) return { ok: false, reason: '这不是你的船' };

  const ferryDef = utype(s, ferry.type);
  if (!holdOf(ferryDef)) return { ok: false, reason: '这个单位没有货舱' };
  if (ferry.acted) return { ok: false, reason: '这条船本回合已经装卸过了' };

  const load = ferry.cargo ?? [];
  const cargo = load.find((u) => u.id === cargoId);
  if (!cargo) return { ok: false, reason: '船上没有这个单位' };

  if (!inBounds(s, x, y)) return { ok: false, reason: '目标越界' };
  if (distance(ferry, { x, y }) !== 1) return { ok: false, reason: '只能在船边一格下船' };
  if (unitAt(s, x, y)) return { ok: false, reason: '那一格已经有人了' };
  if (blockedFor(s, x, y, cargo)) return { ok: false, reason: '那里上不了岸' };

  ferry.cargo = load.filter((u) => u.id !== cargoId);

  const cargoDef = utype(s, cargo.type);
  /**
   * 这个兵能不能吃「加强渡船」：本回合没行动过，而且这一回合还没吃过。
   *
   * 注意判的是**它自己**的行动状态，不是船的。船的 `acted` 管的是
   * "这条船本回合还能不能再装卸"（上面已经查过），两件事不能混。
   */
  const boosted = cargo.acted !== true && cargo.ferryBoostTurn !== s.turn;
  s.units.push({
    ...cargo,
    x,
    y,
    // 吃不到加强的照旧罚站（走也不能走、打也不能打）；
    // 吃到的按新回合处理：这一轮它还没动过，移动力和出手都还在。
    moved: !boosted,
    acted: !boosted,
    ...(boosted ? { ferryBoostTurn: s.turn } : {}),
  });
  ferry.acted = true;

  pushLog(
    s,
    s.current,
    boosted
      ? `${cargoDef.name} 在岸边下船（加强渡船：本回合仍可行动一次）`
      : `${cargoDef.name} 在岸边下船`,
  );
  return { ok: true, state: s };
}

/**
 * 建造选址检查：这一格（或这 2×2 块）能不能让这个建造者在这儿盖这个建筑。
 *
 * 规则和 AI 共用这一份。以前 AI 自己复制了一套"扫周围九格"的判据，
 * 结果规则改了它不知道——它会提出一个必被拒绝的 BUILD，而执行方
 * 遇到非法动作就中断整回合。判据只能有一处。
 *
 * 返回 null = 可以建；否则是给人看的理由（AI 直接丢掉这个候选）。
 */
export function buildSiteError(
  s: GameState,
  def: UnitTypeDef,
  builder: Unit,
  x: number,
  y: number,
): string | null {
  const n = footprintOf(s, def.id);
  const overWater = !!def.bridges;

  // 占地逐格过一遍：界内、空着、地形合规。
  // 2×2 的建筑只要有一格落空，整块就不算数——部分落在水里再补半间房，
  // 是没法解释给玩家听的。
  for (let dy = 0; dy < n; dy++) {
    for (let dx = 0; dx < n; dx++) {
      const tx = x + dx;
      const ty = y + dy;
      if (!inBounds(s, tx, ty)) return '目标越界';
      const tile = tileAt(s, tx, ty);
      if (!tile) return '目标越界';
      if (unitAt(s, tx, ty)) return '这里已经有单位或建筑了';

      // 敌方的城里不许动土。
      //
      // 城格是对方的领土：在别人城墙里面砌一座箭塔、或者跨着敌城架一段桥，
      // 等于不费一兵就插了面旗。以前只判「这里是空地」，于是可以趁城刚易手、
      // 出兵位还空着的一瞬间把一块建筑塞进去，等于凭空在敌国境内落一颗钉子。
      // 废墟也不例外——废墟仍挂在原主名下，重建是另一套流程。
      const hostOwner = cityAt(s, tx, ty)?.owner;
      if (hostOwner && hostOwner !== builder.owner) {
        return '这里属于敌方城市，不能在里面建造';
      }

      // 地形要求写在数据里（buildOn）：军营要平地/丘陵，桥要水面
      if (def.buildOn) {
        if (!def.buildOn.includes(tile.terrain)) {
          const names = def.buildOn.map((t) => CONFIG.terrainName[t]).join('、');
          return `${def.name} 只能建在${names}上`;
        }
      } else if (!passable(tile.terrain)) {
        return '水面和高山上不能建造';
      }
      if (tile.terrain === 'bridge' && !overWater) {
        return '桥面上不能再盖东西';
      }
    }
  }

  if (overWater) {
    // 桥只能跨"一窄条水"：要有一侧是陆地，否则是一片汪洋，架不起来
    const touchesLand = DIRS.some(([dx, dy]) => {
      const nb = tileAt(s, x + dx, y + dy);
      return !!nb && passable(nb.terrain);
    });
    if (!touchesLand) return '这里四面都是水，架不了桥';
  }

  // 临水要求（军营）：靠水补给，所以必须挨着水面。
  // 占 2×2 的营按整圈外墙算——只看锚点四邻的话，水明明贴着右下角也会被判"不临水"，
  // 而玩家在画面上看到的是"水就在墙根"。
  //
  // 判据必须走 `adjacentToWater`，**不要**在这里再写一遍 `terrain === 'water'`。
  // 以前就是各写一份：界面上的建造高亮用 `adjacentToWater`（它把桥面也算水面），
  // 这里只认 `water`，于是"在桥头扎营"会被高亮成可建、点下去才回一句"必须扎在水边"。
  // 桥是架在河上的，桥面那一格底下还是水——规则书里写的也是"桥面也算"。
  if (def.requiresWater) {
    const wet = tilesOfFootprint(x, y, n, (tx, ty) => adjacentToWater(s, tx, ty));
    if (!wet) return `${def.name}必须扎在水边（四邻要有一格水面）`;
  }

  // 别把自己堵死：城市格的出兵位是产线的命门。
  //
  // 现实里踩过太多次——在城里仅剩的那格空地上盖一座塔，城市的产兵格就变成 0，
  // 从此一兵不出，而界面上只是"没有可造的兵"这种不痛不痒的提示。
  // 占 2×2 的建筑要一次吃掉四格，更容易把城堵死，所以按"盖完之后还剩几格"算。
  const hostCity = s.cities.find(
    (c) =>
      c.owner === builder.owner &&
      x >= c.x &&
      x < c.x + c.size &&
      y >= c.y &&
      y < c.y + c.size,
  );
  if (hostCity) {
    const covered = (tx: number, ty: number) => tx >= x && tx < x + n && ty >= y && ty < y + n;
    const slotsLeft = cityTiles(hostCity).filter(
      (t) => !covered(t.x, t.y) && !unitAt(s, t.x, t.y),
    );
    if (slotsLeft.length === 0) {
      return '这一格是这座城最后一个出兵位，建在这里会让它再也造不出兵';
    }
  }

  // 距离：绝大多数建筑按 CONFIG.buildRange 算；少数"本来就要盖在远处"的
  // （海上钻井平台）在兵种数据里自己写一个更大的数——放宽的只是距离，
  // 选址条件照旧一条不少。
  const reach = def.buildRange ?? CONFIG.buildRange;
  if (distance(builder, { x, y }) > reach && !(overWater && bridgeChainOk(builder, x, y, s))) {
    return overWater
      ? `建造者离得太远（最多 ${reach} 格；桥可以沿已有的桥面再往外接两节）`
      : `建造者离得太远（最多 ${reach} 格）`;
  }

  return null;
}

/**
 * 对一个 n×n 块里的每一格做一次判断，任一成立就返回 true。
 *
 * 选址里"临水""是不是全是陆地"这类条件说的都是整块地，不是锚点那一格。
 */
function tilesOfFootprint(
  x: number,
  y: number,
  n: number,
  test: (tx: number, ty: number) => boolean,
): boolean {
  for (let dy = 0; dy < n; dy++) {
    for (let dx = 0; dx < n; dx++) {
      if (test(x + dx, y + dy)) return true;
    }
  }
  return false;
}

/** 这一格的坐标写法，日志里到处用 */
function cellName(x: number, y: number): string {
  return `${String.fromCharCode(65 + x)}${y + 1}`;
}

function doBuild(
  s: GameState,
  unitId: string,
  unitTypeId: string,
  x: number,
  y: number,
): ActionResult {
  const builder = unitById(s, unitId);
  if (!builder) return { ok: false, reason: '建造者不存在' };
  if (builder.owner !== s.current) return { ok: false, reason: '这不是你的单位' };
  if (builder.acted) return { ok: false, reason: '该单位本回合已经行动过' };

  const builderDef = utype(s, builder.type);
  if (!builderDef.builds || builderDef.builds.length === 0) {
    return { ok: false, reason: `${builderDef.name} 不是建造单位` };
  }
  if (!builderDef.builds.includes(unitTypeId)) {
    return { ok: false, reason: `${builderDef.name} 不会建造这个` };
  }

  const def = s.unitTypes[unitTypeId];
  if (!def) return { ok: false, reason: '本局没有这个建筑' };
  if (def.category !== 'building') return { ok: false, reason: '只有建筑可以修建' };
  // 选卡模式：建筑也在名单里（塔、堡、城墙都是要选的东西）
  if (!canUseType(s, builder.owner, unitTypeId)) {
    return { ok: false, reason: `${def.name} 不在本局的选用名单里` };
  }

  /*
   * 落成即废的产兵点不许修。
   *
   * 产兵点的时代**落成那一刻就钉死**了（见 doRecruit 的 camp 分支、下面建造结算里
   * 那句 `era: supplyEraAt(...)`），之后不会跟着城市换代。带白名单的产兵点
   * （船坞三代 / 造船厂五代 / 海军船台七代）如果提前修，白名单里的船一条都出不来——
   * 玩家花了 460 金买到一块石头，而界面上不会告诉他这一点。
   *
   * 判据放在这里而不是各个包里：包只管数据，规则管"这笔钱花得对不对"。
   * 军营不受影响——它的白名单是空的，什么时代落成都能出那一代的兵。
   */
  const supplyEra = supplyEraAt(s, s.current, { x, y });
  const usable = produceUsableCount(def, s.unitTypes, supplyEra);
  if (usable === 0) {
    const need = (produceOf(def)?.units ?? [])
      .map((id) => s.unitTypes[id])
      .filter((u): u is UnitTypeDef => !!u)
      .reduce((m, u) => Math.min(m, u.era), 99);
    return {
      ok: false,
      reason: `${def.name}现在建起来一艘都造不出来（要到「${eraDef(need).name}」）。先升时代，或者改修低一档的。`,
    };
  }

  // 续建：目标格上是自家的同型工地。
  //
  // 两个工兵一起修一座塔，就是把两次 BUILD 叠在同一个工地上：rate 相加、
  // 各自当场再投一次。这比"建造者必须一直站在旁边"好——工兵建完就走是常态，
  // 把进度绑在人的站位上，"走开"就成了一个玩家看不见的惩罚。
  const site = s.units.find(
    (u) =>
      u.type === def.id &&
      u.owner === s.current &&
      underConstruction(u) &&
      coversTile(s, u, x, y),
  );
  if (site) {
    const power = buildPowerOf(builderDef);
    site.buildRate = (site.buildRate ?? 0) + power;
    site.buildDone = (site.buildDone ?? 0) + power;
    builder.moved = true;
    builder.acted = true;
    const need = site.buildNeed ?? 0;
    if ((site.buildDone ?? 0) >= need) {
      // 最后一把力：当场成型（桥这时候才真正通车）
      const here = tileAt(s, site.x, site.y);
      delete site.buildDone;
      delete site.buildNeed;
      delete site.buildRate;
      if (utype(s, site.type).bridges && here && here.terrain === 'water') here.terrain = 'bridge';
      pushLog(s, s.current, `${builderDef.name} 接手 ${def.name} 的工地，当场完工`);
    } else {
      pushLog(
        s,
        s.current,
        `${builderDef.name} 加入 ${def.name} 的工地（${site.buildDone}/${need}，此后每回合 +${site.buildRate}）`,
      );
    }
    return { ok: true, state: s };
  }

  const problem = buildSiteError(s, def, builder, x, y);
  if (problem) return { ok: false, reason: problem };

  const price = recruitResCost(s, s.current, def);
  if (!canPay(s.players[s.current], price)) {
    return {
      ok: false,
      reason: `资源不足（需要 ${costLabel(price)}，${missingLabel(s.players[s.current], price)}）`,
    };
  }
  payRes(s.players[s.current], price);

  // 建造点数：动工那一刻把工兵的能力投进去。投够了当回合就成型，
  // 投不够就先落一个工地，之后每回合自动到账 buildRate（= 这个工兵的能力）。
  const need = buildCostOf(def);
  const power = buildPowerOf(builderDef);
  const done = Math.min(power, need);
  const unfinished = done < need;

  s.units.push({
    id: `u${s.nextUnitSeq++}`,
    type: def.id,
    owner: s.current,
    x,
    y,
    hp: def.maxHp,
    kills: 0,
    moved: true,
    acted: true,
    // 军营动工那一刻就把时代钉下来：它靠后方军工供货，供货方是谁当场就定了。
    // 等它盖完之后再取一次，会让"同一座营，施工期间后方刚好升了时代"
    // 这种巧合决定它的档次——玩家看不见这种因果。
    ...(isProducer(def) ? { era: supplyEraAt(s, s.current, { x, y }) } : {}),
    ...(unfinished ? { buildDone: done, buildNeed: need, buildRate: power } : {}),
  });

  // 桥建成才把那一格换成桥面：工地桥不许提前通车（船也要先绕）
  if (def.bridges && !unfinished) {
    const here = tileAt(s, x, y);
    if (here) here.terrain = 'bridge';
  }

  // 建造要占掉这个单位的整回合
  builder.moved = true;
  builder.acted = true;

  pushLog(
    s,
    s.current,
    unfinished
      ? `${builderDef.name} 在 ${cellName(x, y)} 开始修建 ${def.name}（已投 ${done}/${need}，此后每回合 +${power}）`
      : `${builderDef.name} 在 ${cellName(x, y)} 修建了 ${def.name}`,
  );
  return { ok: true, state: s };
}

/**
 * 升级城市时代。
 *
 * 注意这里用的是**增量**而不是直接赋值：扩展规则（比如「要塞」）
 * 会在开局时给所有城市加耐久和护甲，如果升级时直接写成
 * eraDef 的绝对值，那些加成就被抹掉了。
 */
function doUpgrade(s: GameState, cityId: string): ActionResult {
  const city = cityById(s, cityId);
  if (!city) return { ok: false, reason: '城市不存在' };
  if (city.owner !== s.current) return { ok: false, reason: '只能升级自己的城市' };

  const cost = upgradeCostOf(s, city);
  if (cost === null) {
    // 封顶有两种，说法不能一样：真到表底、和"这一局没开那一层"。
    // 后者要指出路（哪个包能打开），不然玩家会以为科技线到此为止。
    const cap = eraCeilingOf(s);
    const locked = lockedEraPacks(s.config.expansionIds);
    if (cap < ERAS.length && locked.length > 0) {
      return {
        ok: false,
        reason: `已经是最高时代（没开${locked.map((n) => `「${n}」`).join('、')}，科技线到${eraDef(cap).name}封顶）`,
      };
    }
    return { ok: false, reason: '已经是最高时代' };
  }

  const player = s.players[s.current];
  if (player.gold < cost) return { ok: false, reason: `金币不足（需要 ${cost}）` };

  const from = eraDef(city.era);
  const to = eraDef(city.era + 1);

  player.gold -= cost;
  city.era += 1;

  const hpGain = to.cityMaxHp - from.cityMaxHp;
  city.maxHp += hpGain;
  city.armor += to.cityArmor - from.cityArmor;
  city.hp = Math.min(city.maxHp, city.hp + hpGain);

  pushLog(
    s,
    s.current,
    `城市 ${cityName(city)} 升级到「${to.name}」时代（耐久 ${city.maxHp}，护甲 ${city.armor}）`,
  );

  return { ok: true, state: s };
}

/**
 * 产兵。
 *
 * 产兵点有两种：城市，或者军营（`barracks`）。
 * 军营自己没有科技线：它落成的时候取**当时离得最近的己方城市的时代**，
 * 把这一个数字钉在自己身上（`Unit.era`），之后一直按它结算。
 *
 * 以前是每次产兵都现算"最近的己方城市"，于是后方升了一个时代，前线那座
 * 早就扎好的旧营隔空跟着换代——一座石板搭的营寨当场能出火枪手。现在
 * 营的时代是个实体属性：想要新时代的兵，就在新地方再扎一座营。
 */
/**
 * 产兵点能往哪些格子出兵。
 *
 * 城市和军营各有一套扫描（城要看四周的水面，营要沿自家所有格子往外一圈），
 * 而界面现在也要用这份结果——"临水的城挨着好几片水域时自己选从哪下水"
 * 得先把可选的格子点亮。所以判据只留这一份，规则和界面都从这里取。
 */
export function recruitSpawnCells(
  s: GameState,
  cityId: string | undefined,
  campId: string | undefined,
  unitTypeId: string,
): Array<{ x: number; y: number }> {
  const def = s.unitTypes[unitTypeId];
  if (!def) return [];

  if (campId) {
    const camp = unitById(s, campId);
    if (!camp) return [];
    // 兵从营地外围出来。占 2×2 的军营门口有十来格，逐个四邻去掉自家的格子，
    // 拿"锚点四邻"算的话，右半边永远出不了一个人。
    const self = new Set(tilesOfUnit(s, camp).map((p) => p.y * s.w + p.x));
    const seen = new Set<number>();
    const out: Array<{ x: number; y: number }> = [];
    for (const cell of tilesOfUnit(s, camp)) {
      for (const [dx, dy] of DIRS) {
        const x = cell.x + dx;
        const y = cell.y + dy;
        const k = y * s.w + x;
        if (self.has(k) || seen.has(k)) continue;
        const t = tileAt(s, x, y);
        if (!t) continue;
        // 判据必须是**这个兵种**的，不是"陆军能不能走"。
        // 这里以前写 `passable()`，于是军营一圈全是水时，飞行兵也算"没地方出兵"——
        // 而它明明能停在水面上（canStandAt 放行）。规则层自己把兵卡在了产线上。
        if (!terrainWalkable(def, t.terrain)) continue;
        if (!canStandAt(s, x, y, unitTypeId)) continue;
        seen.add(k);
        out.push({ x, y });
      }
    }
    return out;
  }

  const city = cityId ? cityById(s, cityId) : undefined;
  if (!city) return [];
  if (def.domain === 'water') {
    // 水军要下到城边那一格空水面上去。浅滩也算水面（船浮得起来），
    // 桥面不算：桥是别人架的东西，新船不该直接刷在桥面上。
    return cityTiles(city)
      .flatMap((t) => DIRS.map(([dx, dy]) => ({ x: t.x + dx, y: t.y + dy })))
      .filter((p) => {
        const nb = tileAt(s, p.x, p.y);
        return !!nb && navigable(nb.terrain) && nb.terrain !== 'bridge' && !unitAt(s, p.x, p.y);
      });
  }
  return cityTiles(city).filter((t) => canStandAt(s, t.x, t.y, unitTypeId));
}

function doRecruit(
  s: GameState,
  cityId: string | undefined,
  campId: string | undefined,
  unitTypeId: string,
  at?: { x: number; y: number },
): ActionResult {
  const def = s.unitTypes[unitTypeId];
  if (!def) return { ok: false, reason: '本局没有这个兵种' };
  if (def.category === 'building') {
    return { ok: false, reason: '建筑要在野外选址修建，不能从产兵点生产' };
  }
  // 召唤物只认召唤者：让它们进产线会变成"花 45 金买一个死灵法师的免费赠品"
  if (def.summonedOnly) return { ok: false, reason: `${def.name} 只能被召唤出来` };
  // 选卡模式：不在本局名单里的东西造不出来。判据只有 core/draft.canUseType 一处，
  // 界面上的产兵表和 AI 的候选列表都问同一句，不会出现"面板能点、点了被拒"。
  if (!canUseType(s, s.current, unitTypeId)) {
    return { ok: false, reason: `${def.name} 不在你本局的选用名单里` };
  }
  // 英雄：同一方场上只能有一个。这条在这里拦，是因为界面和 AI 两边的
  // 候选人列表都只是"能造什么"，管不了"已经有一个了"。
  // 「一个」也包括还没孵出来的那只（不死鸟的蛋），见 heroBlocked。
  const blocked = heroBlocked(s, s.current, def);
  if (blocked) return { ok: false, reason: blocked };

  /** 这个产兵点用哪个时代、叫什么、能往哪些格子出兵 */
  let era = 0;
  /** 产兵点的造价倍率（produce.costScale）。城市永远是 1 */
  let costScale = 1;
  let label = '';
  let slots: Array<{ x: number; y: number }> = [];

  if (campId) {
    const camp = unitById(s, campId);
    if (!camp) return { ok: false, reason: '产兵点不存在' };
    const campDef = utype(s, camp.type);
    if (!isProducer(campDef)) return { ok: false, reason: '这不是军营' };
    if (underConstruction(camp)) return { ok: false, reason: `${campDef.name} 还在施工，营门都没立起来` };
    if (camp.owner !== s.current) return { ok: false, reason: '这不是你的军营' };

    // 三件事全读产兵的兵种数据：这个营认不认这个兵、多久能出一个、造价打几折
    const allowed = canProduce(campDef, def);
    if (!allowed.ok) return { ok: false, reason: allowed.reason };
    const wait = produceCooldownLeft(s, camp, campDef);
    if (wait > 0) {
      return { ok: false, reason: `${campDef.name}刚产出一批，还要 ${wait} 回合才能再产` };
    }
    costScale = produceCostScale(campDef);

    const own = citiesOf(s, s.current);
    if (own.length === 0) return { ok: false, reason: '没有城市，军营补给就断了' };
    era = camp.era ?? supplyEraAt(s, camp.owner, camp);
    label = campDef.name;

    slots = recruitSpawnCells(s, undefined, campId, unitTypeId);
  } else {
    const city = cityId ? cityById(s, cityId) : undefined;
    if (!city) return { ok: false, reason: '城市不存在' };
    if (city.owner !== s.current) return { ok: false, reason: '只能在自己的城市产兵' };
    era = city.era;
    label = cityName(city);
    if (city.ruined) {
      return { ok: false, reason: '这座城市已成废墟，先派兵入驻接管' };
    }
    if (city.capturedTurn === s.turn) {
      return { ok: false, reason: `${label}刚被打下来，本回合还没恢复生产` };
    }

    slots = recruitSpawnCells(s, cityId, undefined, unitTypeId);
    // 水军没有下水的位置时要说清原因：城不临水，还是水面已经站满了船
    if (def.domain === 'water' && slots.length === 0) {
      return { ok: false, reason: '这座城市不临水（或水面已被占），造不了船' };
    }
  }

  // 时代只剩一条：**不能造还没解锁的兵**。
  //
  // 以前这里是三段——"没到那个时代"、"城市不够新（重复写了一遍）"、
  // "过时了，产线不带它"。第三段随着下限的取消一起没了：城市升到第五代
  // 仍然能造民兵，因为"面板里堆满老古董"是界面问题，已经由筛选解决
  // （扩展包 / 时代 / 搜索），不该由规则层拿"升级＝选项变少"来买单。
  if (!eraWindowOk(s, def, era)) {
    return { ok: false, reason: `${def.name} 需要「${eraDef(def.era).name}」时代` };
  }

  const player = s.players[s.current];

  // 英雄解锁：只在第一次招它时收，之后这个兵种就永久开放。
  // 记在 state 里而不是兵种表里——兵种表是全局限定的，
  // 我解锁了天使不该等于对手也解锁了天使。
  //
  // 这笔钱和兵价一起从 recruitPriceOf 出来：界面上的估价、AI 的采购判断
  // 用的都是同一份口径，否则会出现"面板说够、执行时不够"的空转。
  const quote = recruitPriceOf(s, s.current, def);
  // 造价倍率只作用在兵价上，不解锁费（英雄解锁是全局一次的事，不该被营打折）
  const payCost = scaleCost(quote.total, costScale);
  const unlockFee = quote.unlockFee;

  if (!canPay(player, payCost)) {
    const missing = missingLabel(player, payCost);
    return {
      ok: false,
      reason: unlockFee > 0
        ? `资源不足（英雄要 ${costLabel(quote.price)} + 解锁 ${unlockFee} 金，${missing}）`
        : `资源不足（需要 ${costLabel(payCost)}，${missing}）`,
    };
  }
  // 编制上限只在 AI 那边生效（见 ai.ts 的产兵判断），规则层不拦人。
  // 钱、格子、每回合的行动次数本身就是更硬的约束。
  //
  // 玩家指定了出水位置就用它：临水的城常挨着好几片水，不指定的话
  // 永远从列表第一格下水，想让它从另一侧绕过去也做不到。
  let slot = slots[0];
  if (typeof at?.x === 'number' && typeof at?.y === 'number') {
    const want = slots.find((p) => p.x === at.x && p.y === at.y);
    if (!want) {
      return { ok: false, reason: '这一格没法让新兵下水（水面已被占，或者不在产兵点旁边）' };
    }
    slot = want;
  }
  if (!slot) {
    return {
      ok: false,
      reason: campId ? `${label}周围没有空地放下新兵` : '城市里已经站满了，先挪出位置',
    };
  }

  payRes(player, payCost);
  if (unlockFee > 0) {
    const unlocked = (s.unlocked ??= {});
    const mine = (unlocked[s.current] ??= []);
    if (!mine.includes(def.id)) mine.push(def.id);
    pushLog(s, s.current, `解锁英雄「${def.name}」，花费 ${unlockFee} 金`);
  }

  s.units.push({
    id: `u${s.nextUnitSeq++}`,
    type: def.id,
    owner: s.current,
    x: slot.x,
    y: slot.y,
    hp: def.maxHp,
    kills: 0,
    // 新兵当回合不能行动，否则等于凭空多一次攻击
    moved: true,
    acted: true,
    ...(typeof def.ammo === 'number' ? { ammoLeft: def.ammo } : {}),
  });

  // 新兵也可能直接落在雷上：这一格如果被人布过东西，照样触发。
  // 不这么做的后果很具体：把城门口铺满雷，就能让对面永远造不出水军。
  const fresh = s.units[s.units.length - 1];
  if (fresh && fresh.type === def.id && marksOf(s).length > 0) {
    enterTile(s, fresh, markApi(s));
    if (fresh.hp <= 0) sweepDead(s);
  }

  // 记一笔产出回合：produce.everyTurns > 1 的营靠它算冷却
  if (campId) {
    const camp = unitById(s, campId);
    if (camp) camp.custom = { ...(camp.custom ?? {}), lastProduceTurn: s.turn };
  }

  pushLog(s, s.current, `${label}产出了${def.name}`);
  return { ok: true, state: s };
}

/**
 * 指挥官模式下这一方的生产序列（只读副本）。普通对局返回空数组。
 */
/**
 * 指挥官模式下这一方"怎么打"：策略 + 进攻方向。
 *
 * 普通对局、或者玩家没定过，一律返回 `{ strategy: 'auto' }`——也就是"AI 按自己的
 * 判断来"，和这个机制上线之前的行为完全一致。所以老存档、旧回放读出来都不变。
 */
export function orderDirectiveOf(s: GameState, player: PlayerId): OrderDirective {
  if (!s.config.commanderMode) return { strategy: 'auto' };
  return s.orderDirectives?.[player] ?? { strategy: 'auto' };
}

export function ordersOf(s: GameState, player: PlayerId): string[] {
  return [...(s.orders?.[player] ?? [])];
}

/**
 * 每一格指定的产兵点（和 `ordersOf` 逐格对齐，空串＝哪座都行）。
 *
 * 旧存档没有这个字段：长度按序列补齐成空串，语义就是"全部不指定"，
 * 于是老存档读出来还是原来那条"AI 自己挑产兵点"的序列。
 */
export function orderSitesOf(s: GameState, player: PlayerId): string[] {
  const queue = ordersOf(s, player);
  const raw = s.orderSites?.[player] ?? [];
  return queue.map((_, i) => raw[i] ?? '');
}

/**
 * 这一格指定的产兵点还成立吗：返回 null 表示"没指定/指定得上"，否则给一句原因。
 *
 * 为什么单独抽出来：`doSetOrders` 要拦住"指定了一个不存在的城"，
 * 界面要据此把不成立的格子标红——以前只有一处用，现在两处，将来还会有第三处。
 */
export function orderSiteProblem(s: GameState, player: PlayerId, site: string): string | null {
  if (!site) return null;
  const city = s.cities.find((c) => c.id === site);
  if (city) {
    if (city.owner !== player) return '那座城不是你的';
    return null;
  }
  const camp = s.units.find((u) => u.id === site);
  if (!camp) return '这个产兵点不存在了';
  if (camp.owner !== player) return '那座军营不是你的';
  if (!isProducer(utype(s, camp.type))) return '指定的产兵点不是军营';
  return null;
}

/**
 * 指挥官模式下排生产序列。
 *
 * 只校验四件事：是不是指挥官模式、长度有没有超、点名的兵种存不存在、是不是建筑；
 * 外加一条"指定的产兵点得真的存在而且是你的"。
 * **不校验钱够不够、城市够不够高级**——那是 AI 执行时的现实约束，
 * 提前拦下来等于把"排了造不出来"这个后果替玩家抹掉，而它正是这个模式的核心取舍。
 * 同理也不校验"这座城的时代够不够造它"：让那一格空转，是这个模式要的后果。
 *
 * 空字符串是"这一格故意空着"：玩家可能想排"这回合不造、下回合造坦克"。
 * 所以中间的洞要留着（否则后面整条序列会往前挪），只把末尾的空位裁掉。
 *
 * `sites` 与 `queue` 逐格对齐。空位上的 `sites` 一律抹成空串：那一格既然
 * "这回合什么都不造"，留着产兵点只会在界面回显时对不上。
 */
/**
 * 定这一方的作战策略与进攻方向。
 *
 * 三件事要挡住：
 *   ① 普通对局没有这套东西（和 SET_ORDERS 同一道闸，理由一样）；
 *   ② 方向不能朝自己（"专打自己"没有意义，多半是界面传错了）；
 *   ③ 方向与目标只能填一种——两个都填的话，AI 不知道听哪个。
 */
function doSetDirective(s: GameState, directive: OrderDirective): ActionResult {
  if (!s.config.commanderMode) return { ok: false, reason: '普通对局没有作战策略' };

  const strategy = directive?.strategy ?? 'auto';
  if (strategy !== 'auto' && strategy !== 'rush' && strategy !== 'boom' && strategy !== 'hold') {
    return { ok: false, reason: `不认识的策略：${String(strategy)}` };
  }

  let target = directive?.target;
  if (target) {
    if ('seat' in target) {
      if (!seatsOf(s).includes(target.seat)) return { ok: false, reason: '没有这个席位' };
      if (target.seat === s.current) return { ok: false, reason: '进攻方向不能定成自己' };
    } else {
      const dx = Math.sign(target.dx ?? 0);
      const dy = Math.sign(target.dy ?? 0);
      if (!Number.isFinite(dx) || !Number.isFinite(dy) || (dx === 0 && dy === 0)) {
        return { ok: false, reason: '方向得有一个朝向（八个方向之一）' };
      }
      target = { dx, dy };
    }
  }

  s.orderDirectives = {
    ...(s.orderDirectives ?? {}),
    [s.current]: target ? { strategy, target } : { strategy },
  };
  return { ok: true, state: s };
}

function doSetOrders(s: GameState, queue: string[], sites?: string[]): ActionResult {
  if (!s.config.commanderMode) return { ok: false, reason: '普通对局没有生产序列' };

  const cleaned = queue.slice(0, CONFIG.commanderSlots).map((id) => id ?? '');
  const where = cleaned.map((id, i) => (id ? (sites?.[i] ?? '') : ''));
  while (cleaned.length > 0 && cleaned[cleaned.length - 1] === '') {
    cleaned.pop();
    where.pop();
  }

  for (let i = 0; i < cleaned.length; i += 1) {
    const id = cleaned[i] as string;
    if (!id) continue;
    // 哨兵值：这一格是"升级时代"或者"空过"，都不是兵种
    if (id === ORDER_IDLE) continue;
    if (id !== ORDER_UPGRADE) {
      const def = s.unitTypes[id];
      if (!def) return { ok: false, reason: `没有这个兵种：${id}` };
      if (def.category === 'building') {
        return { ok: false, reason: '建筑要由建造单位去盖，不能排进生产序列' };
      }
    }
    const problem = orderSiteProblem(s, s.current, where[i] ?? '');
    if (problem) return { ok: false, reason: `第 ${i + 1} 格：${problem}` };
  }

  s.orders = { ...(s.orders ?? {}), [s.current]: cleaned };
  s.orderSites = { ...(s.orderSites ?? {}), [s.current]: where };
  return { ok: true, state: s };
}

/**
 * 双人热座：把这一批计划交上去，然后把机器让给对面。
 *
 * 三条边界，都是"别把别的模式搅进来"：
 *   · 只在指挥官模式下存在（普通对局没有生产序列，更没有"交计划"这一步）；
 *   · 只在**两边都是人**时存在——人机局对面是 AI，它不需要排、也不需要等；
 *   · 不推进回合：`turn` 不动、序列不前移、不发收入。它只做两件事——
 *     记下"这一方交了"，以及把 `current` 拨到还没交的那一方去排。
 *
 * 两边都交齐之后把 `current` 拨回**这一批开始的那个人**（`planStart`），
 * 界面据此开始按回合交替推进。谁后交谁先动是不能接受的：先后手在这个游戏里
 * 是要用钱和回合去配平的东西，不能让它由"谁手慢"决定。
 */
function doPlanCommit(s: GameState): ActionResult {
  if (!s.config.commanderMode) return { ok: false, reason: '普通对局没有作战计划' };
  if (s.config.aiOpponent === true) {
    return { ok: false, reason: '人机局里对面由 AI 代管，不需要互等提交' };
  }
  if (s.winner) return { ok: false, reason: '对局已结束' };

  const me = s.current;
  const ready = { ...(s.orderReady ?? {}), [me]: true };
  s.orderReady = ready;
  // 第一批：记下"从谁开始"，推进时以此为准
  s.planStart = s.planStart ?? me;

  /*
   * 交完把机器交给"下一个还没交的人"。
   *
   * 这里原来写的是 `other(me)`——只有两个席位。三人四家局里那样写会造出
   * "A、B 都交完了，C 还没排，但 A 已经开推"的死局：C 这一批根本没有序列，
   * AI 只能自己乱造。改成"按席位顺序找下一个没交的"，两边局下行为不变。
   * 已经被淘汰的席位不用等（等它等于永远开不了推）。
   */
  const pending = seatsOf(s).filter((x) => ready[x] !== true && !isEliminated(s, x));
  s.current = pending.length === 0 ? s.planStart : pending[0]!;
  return { ok: true, state: s };
}

/** 一批推完了：清掉提交标记，让两边重新排下一批 */
function doPlanEnd(s: GameState): ActionResult {
  if (!s.config.commanderMode) return { ok: false, reason: '普通对局没有作战计划' };
  s.orderReady = {};
  s.planStart = undefined;
  return { ok: true, state: s };
}

/**
 * 该交的都交了没有（界面据此决定"还差谁"还是"可以开推"）。
 *
 * 不再写死 A/B：三人四家局里每一席都要排自己那份。被淘汰的席位不算
 * （它没有兵、也没有产线，等它等于永远开不了推）。
 */
export function planBothReady(s: GameState): boolean {
  if (s.config.commanderMode !== true) return false;
  const r = s.orderReady ?? {};
  return seatsOf(s).every((x) => r[x] === true || isEliminated(s, x));
}

/**
 * 遣散单位 / 拆除建筑。
 *
 * 三条约束：
 *   · 只能动自己的（"帮对手拆塔"显然不行）；
 *   · 船里还有货就不能拆（否则货舱里的陆军凭空蒸发，玩家会以为是 bug）；
 *   · 回收按**当前造价**的四成（`CONFIG.disbandRefund`），扩展改了价就跟着变。
 *
 * 但只有完整无损的才回收，见 `disbandRefundOf`。
 *
 * 这个动作不消耗行动：拆完还能接着动别的单位，一回合拆几座是自己的事。
 */
function doDisband(s: GameState, unitId: string): ActionResult {
  const u = s.units.find((x) => x.id === unitId);
  if (!u) return { ok: false, reason: '这里已经没有单位了' };
  if (u.owner !== s.current) return { ok: false, reason: '只能拆自己的' };
  if ((u.cargo?.length ?? 0) > 0) return { ok: false, reason: '船里还有单位，先卸货' };

  const def = utype(s, u.type);
  const refund = disbandRefundOf(s, u);
  if (refund > 0) {
    s.players[u.owner].gold += refund;
    pushLog(s, u.owner, `拆除「${def.name}」，回收 ${refund} 金`);
  } else {
    // 说清楚为什么一分钱没有，否则玩家会以为是 bug
    pushLog(s, u.owner, `遣散残破的「${def.name}」，不回收金币`);
  }
  s.units = s.units.filter((x) => x.id !== unitId);
  return { ok: true, state: s };
}

/**
 * 遣散/拆除能回收多少金币。
 *
 * 只有**完整无损**的才回收。残血的部队是"打剩的"，不是"没用的"；
 * 让它按造价折现，等于在战场上开了一个兑现口：这支兵打残了、眼看要死，
 * 退回去还能换回四成钱——那"撤退"就变成了一门理财，而不是一次损失。
 * 所以血量不满一律不给钱，重建/修好才谈回收。
 *
 * 建筑照同一条规矩办：塌了半边的箭塔拆掉也不退。否则"盖塔挡路、
 * 挨两下、趁没塌干净拆了回本"会比老老实实守城划算得多。
 */
export function disbandRefundOf(s: GameState, u: Unit): number {
  const def = utype(s, u.type);
  if (u.hp < maxHpOf(s, u)) return 0;
  /*
   * 召唤物一分钱不退。
   *
   * 这一条是 2026-11-02 查出来的漏洞：四元素、大史莱姆能造也能召，
   * 而"能造"就意味着它们有 cost —— 召唤师每几回合白送一个，满血解散还能拿
   * 40% 的钱（风元素 165 金 → 66 金）。这不叫"整理阵型"，这是印钞机。
   * 只堵解散、不堵召唤：召唤出来的兵照样能打，只是不能变现。
   */
  if (u.summoned) return 0;
  return Math.round(recruitCost(s, u.owner, def) * CONFIG.disbandRefund);
}

/**
 * 这个英雄现在能用哪些技能：冷却好了的列出来，没好的也列出来（带剩余回合）。
 *
 * 界面要同时显示两种状态——只列可用的，玩家会以为"技能没了"；
 * 全列出来才知道"再等一回合就能开"。
 */
/**
 * 这个单位的技能现在能不能放。
 *
 * 两种模型：
 *   · 冷却（`cooldown`）：一次性技能，用完等 N 个自己的回合；
 *   · 充能（`charges`）：一池 N 发，每 `regen` 个自己的回合回一发。
 *
 * 界面和 AI 都读这里，不要各自去翻 `skillCd`——不然会出现"按钮亮着、
 * 点下去说没充能"这种只有玩家会发现的对不上号。
 */
export function heroSkillsOf(
  s: GameState,
  u: Unit,
): Array<{
  def: SkillDef;
  cd: number;
  ready: boolean;
  charge: number;
  chargeMax: number;
  toNext: number;
  notReadyReason?: string; // 返回给 UI 的原因
}> {
  return skillsOf(s, u).map((k) => {
    const cd = u.skillCd?.[k.id] ?? 0;
    const chargeMax = k.charges ?? 0;
    
    let ready = false;
    let charge = 0;
    let toNext = 0;

    // 计算基础就绪状态
    if (chargeMax <= 0) {
      // 冷却
      ready = cd <= 0;
    } else {
      // 充能技能
      const box = u.skillCharge?.[k.id];
      charge = Math.max(0, Math.min(chargeMax, box?.n ?? chargeMax));
      const t = Math.max(0, box?.t ?? 0);
      const regen = Math.max(1, k.regen ?? 2);
      ready = charge > 0;
      toNext = charge >= chargeMax ? 0 : Math.max(1, regen - t);
    }

    let notReadyReason = k.notReadyReason; // 默认用静态配置

    // 核心扩展：如果基础条件是“就绪”，再问一句扩展有没有别的限制
    if (ready && SKILL_READY_CHECKS[k.id]) {
      const checkResult = SKILL_READY_CHECKS[k.id]!(s, u, abilityApi);
      if (checkResult !== true) {
        ready = false;
        // 如果扩展返回了字符串，说明是具体的动态原因（比如“移动力不足”）
        if (typeof checkResult === 'string') {
          notReadyReason = checkResult;
        }
      }
    }

    return {
      def: k,
      cd,
      ready,
      charge,
      chargeMax,
      toNext,
      notReadyReason,
    };
  });
}

//技能
SKILL_EFFECTS['throw-axe'] = (c) => {
  c.self.heroBuff = { ...c.self.heroBuff, range: 3, rangeMul: 0.6, freeShot: true };
};
SKILL_EFFECTS['regenerate'] = (c) => {
  const power = c.skill.power ?? 0;
  const before = c.self.hp;
  c.self.hp = Math.min(maxHpOf(c.state, c.self), c.self.hp + Math.max(1, Math.round(maxHpOf(c.state, c.self) * power)));
  if (c.self.hp === before) {
    c.result.ok = false;
    c.result.reason = '已经是满血了';
  }
};
SKILL_EFFECTS['dive'] = (c) => {
  const power = c.skill.power ?? 0;
  c.self.heroBuff = { 
    ...c.self.heroBuff, 
    moveBonus: power, 
    burnLayers: Math.max(1, Math.round(power)) 
  };
};
SKILL_EFFECTS['cycle'] = (c) => {
  const def = utype(c.state, c.self.type);
  const cyc = def.cycle ?? [];
  if (cyc.length === 0) {
    c.result.ok = false;
    c.result.reason = '这个单位没有可切的属性';
    return;
  }
  const cur = c.self.element ?? cyc[0]!;
  const i = cyc.indexOf(cur);
  const next = cyc[(i + 1) % cyc.length]!;
  c.self.element = next;
  c.self.heroBuff = { ...c.self.heroBuff, elementHit: next };
};
SKILL_EFFECTS['descend'] = (c) => {
  const power = c.skill.power ?? 0;
  const radius = c.skill.radius ?? 1;
  let healed = 0;
  let cleansed = 0;
  for (const t of c.state.units) {
    if (t.owner !== c.self.owner || t.hp <= 0) continue;
    if (distance(t, c.self) > radius) continue;
    const td = utype(c.state, t.type);
    if (t.hp < maxHpOf(c.state, t) && canBeHealed(td)) {
      t.hp = Math.min(maxHpOf(c.state, t), t.hp + Math.max(1, Math.round(maxHpOf(c.state, t) * power)));
      healed += 1;
    }
    if (t.status && Object.keys(t.status).length > 0) {
      t.status = {};
      cleansed += 1;
    }
  }
  if (healed === 0 && cleansed === 0) {
    c.result.ok = false;
    c.result.reason = '附近没有人需要救治';
  }
};
SKILL_EFFECTS['vanish'] = (c) => {
  if (c.self.heroBuff?.hidden === true) {
    c.result.ok = false;
    c.result.reason = '已经藏好了';
    return;
  }
  c.self.heroBuff = { ...c.self.heroBuff, hidden: true };
};
/**
 * 招魂（暗夜死灵法师）：付这个兵的生产价格，把本回合倒下的一名友军拉回来。
 *
 * 三个刻意的选择：
 *   · **自动挑最贵的那个**。技能按钮不带选目标（引擎的 HERO_SKILL 没有目标字段），
 *     而"救便宜的那个"等于替玩家做了一笔亏本买卖——按造价排序，
 *     最贵的那次牺牲先被拉回来，这是唯一不需要额外操作、也不会被骂的判断。
 *   · **出场即"本回合不能动"**。走 makeUnit 的老规矩（moved/acted 都是 true），
 *     否则招魂就成了一次白送的行动，节奏上等于凭空多出一个回合。
 *   · **一条记录只能复活一次**。不标记的话，同一具尸体能被反复招起来，
 *     那就不是"复活"而是"无限兵源"，一条技能就能拖死整局。
 */
SKILL_EFFECTS['raise-dead'] = (c) => {
  const owner = c.self.owner;
  // `turn >= 当前-1`：上一回合（对手刚打完的那一轮）+ 本回合。
  // 只看"当前 turn"不够用——你的兵基本都死在对面回合里。
  // 英雄不进名单：全场唯一，招魂再拉一个出来就变成"两个牢大"，
  // 而"唯一"是英雄这条设计的根。活着的时候不能有两只，死了也不该被造出第二只。
  const pool = (c.state.fallen ?? []).filter(
    (r) =>
      r.owner === owner &&
      r.turn >= c.state.turn - 1 &&
      !r.revived &&
      !!c.state.unitTypes[r.type] &&
      c.state.unitTypes[r.type]!.hero !== true,
  );
  if (pool.length === 0) {
    c.result.ok = false;
    c.result.reason = '本轮没有可招魂的友军（英雄不在其列）';
    return;
  }
  // 造价高的排前面：钱是按生产价格付的，先救回最值钱的那一次牺牲
  const ranked = [...pool].sort(
    (a, b) =>
      recruitCost(c.state, owner, c.state.unitTypes[b.type] as UnitTypeDef) -
      recruitCost(c.state, owner, c.state.unitTypes[a.type] as UnitTypeDef),
  );
  const pick = ranked[0] as FallenRecord;
  const def = c.state.unitTypes[pick.type] as UnitTypeDef;
  const cost = recruitResCost(c.state, owner, def);
  const me = c.state.players[owner];
  if (!canPay(me, cost)) {
    c.result.ok = false;
    c.result.reason = `招魂「${def.name}」还差：${missingLabel(me, cost)}`;
    return;
  }
  // 两格以内（2026-10-31 从"相邻一格"放宽）：混战里贴身的四格基本是满的
  const spot = freeSpotWithin(c.state, c.self, pick.type, 2);
  if (!spot) {
    c.result.ok = false;
    c.result.reason = '两格内没有能站起来的空地';
    return;
  }
  payRes(me, cost);
  c.api.spawn(c.state, owner, pick.type, spot.x, spot.y);
  pick.revived = true;
  c.api.pushLog(
    c.state,
    owner,
    `招魂：${def.name} 重新站起（支付 ${costLabel(cost)}，落位 ${spot.x},${spot.y}）`,
    true,
  );
};
/**
 * 圣旗（神圣骑士长）：半径内的友军（含自己）获得护甲、魔抗与阵列。
 *
 * 三样东西一起给，是因为它们各自单拎出来都不够看：+3 甲挡不住一轮集火、
 * +4 魔抗只对法师有用、阵列只免疫溅射。合起来才是"这一片阵线顶住了这一轮"，
 * 也才对得起一个英雄的一次出手。
 */
SKILL_EFFECTS['holy-banner'] = (c) => {
  const radius = c.skill.radius ?? 2;
  const armorUp = c.skill.armorUp ?? 3;
  const magicUp = c.skill.magicResUp ?? 4;
  let n = 0;
  for (const t of c.state.units) {
    if (t.owner !== c.self.owner || t.hp <= 0) continue;
    if (c.api.distance(t, c.self) > radius) continue;
    t.buff = {
      armor: armorUp,
      magicRes: magicUp,
      splashImmune: true,
      // 撑到自己的下个回合开始：要保护的是**对面**那一个回合
      turns: 1,
      label: '圣旗',
    };
    n += 1;
  }
  if (n === 0) {
    c.result.ok = false;
    c.result.reason = '半径内没有友军';
    return;
  }
  c.api.pushLog(c.state, c.self.owner, `圣旗：${n} 个友军获得护甲 +${armorUp}、魔抗 +${magicUp}、阵列`);
};

/**
 * 圣剑觉醒（圣剑勇者）：永久强化自己，并回一口血。
 *
 * 为什么是**永久**而不是"这一回合"：这个英雄的定位就是"越打越强"，
 * 它没有位移、没有控场，全部价值都压在"给它两三个回合，它就变成另一个兵"。
 * 加成写在单位上（`atkBonus` / `armorBonus` / `maxHpBonus`），不写兵种表——
 * 兵种表是这一局的公共表，动了它等于全场同名单位一起变强。
 */
SKILL_EFFECTS['ascend'] = (c) => {
  const atkUp = c.skill.atkUp ?? 8;
  const armorUp = c.skill.armorUp ?? 2;
  const hpUp = c.skill.hpUp ?? 30;
  const magicAtkUp = c.skill.magicAtkUp ?? 0;
  const magicResUp = c.skill.magicResUp ?? 0;
  const heal = c.skill.power ?? 0.3;
  c.self.atkBonus = (c.self.atkBonus ?? 0) + atkUp;
  c.self.armorBonus = (c.self.armorBonus ?? 0) + armorUp;
  c.self.maxHpBonus = (c.self.maxHpBonus ?? 0) + hpUp;
  // 魔法段的两项：只在这条技能真的配了值时才写，免得老数据平白多出 0 字段
  if (magicAtkUp) c.self.magicAtkBonus = (c.self.magicAtkBonus ?? 0) + magicAtkUp;
  if (magicResUp) c.self.magicResBonus = (c.self.magicResBonus ?? 0) + magicResUp;
  // 上限涨了，回血按**新的**上限算：先加上限再回血，这一口才吃得到自己刚长出来的那截
  const max = maxHpOf(c.state, c.self);
  const healed = Math.max(1, Math.round(max * heal)) + hpUp;
  c.self.hp = Math.min(max, c.self.hp + healed);
  const extra = (magicAtkUp ? `、魔攻 +${magicAtkUp}` : '') + (magicResUp ? `、魔抗 +${magicResUp}` : '');
  c.result.log = `圣剑觉醒：攻 +${atkUp}、甲 +${armorUp}${extra}、生命上限 +${hpUp}，回复 ${healed} 点`;
};

/**
 * 陨卵（邪龙王）：在超大范围内落下一枚魔龙卵，落点周围吃一发暗属性魔法。
 *
 * 落点是**自动挑**的：引擎的 HERO_SKILL 没有"目标格"这个字段（所有技能都不带目标），
 * 所以按"这一发能打出最多伤害"来选——先算每个可站格子里能覆盖到多少敌人、
 * 各吃多少，再挑总和最高的那个；同样多时取离自己近的，让落点看起来"是它抬手砸下去的"。
 *
 * 伤害走魔法段（不吃护甲、只被魔抗挡），再过一遍属性倍率——
 * 光属性的敌人会吃双倍，这正是邪龙王那条属性弱点的另一半。
 */
SKILL_EFFECTS['dragon-egg'] = (c) => {
  const reach = c.skill.radius ?? 6;
  const blast = c.skill.power ?? 1;
  const eggType = 'dragon-egg';
  if (!c.state.unitTypes[eggType]) {
    c.result.ok = false;
    c.result.reason = '这个版本里没有魔龙卵';
    return;
  }
  const foes = c.state.units.filter((u) => u.owner !== c.self.owner && u.hp > 0);
  if (foes.length === 0) {
    c.result.ok = false;
    c.result.reason = '范围内没有敌人';
    return;
  }

  let best: { x: number; y: number } | null = null;
  let bestScore = -1;
  for (let dy = -reach; dy <= reach; dy += 1) {
    for (let dx = -reach; dx <= reach; dx += 1) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) > reach) continue;
      const x = c.self.x + dx;
      const y = c.self.y + dy;
      if (!c.api.canStandAt(c.state, x, y, eggType)) continue;
      let score = 0;
      for (const f of foes) {
        if (Math.max(Math.abs(f.x - x), Math.abs(f.y - y)) > blast) continue;
        score += magicDamageOf(c.state, c.self, f);
      }
      if (score > bestScore) {
        bestScore = score;
        best = { x, y };
      }
    }
  }
  if (!best || bestScore <= 0) {
    c.result.ok = false;
    c.result.reason = '没有能砸到敌人的落点';
    return;
  }

  c.api.spawn(c.state, c.self.owner, eggType, best.x, best.y);
  let hit = 0;
  let dealt = 0;
  for (const f of foes) {
    if (Math.max(Math.abs(f.x - best.x), Math.abs(f.y - best.y)) > blast) continue;
    const fd = utype(c.state, f.type);
    const raw = magicDamageOf(c.state, c.self, f);
    const dmg = Math.max(0, Math.round(applyElementMul(raw, 'dark', fd.weak, fd.resist)));
    if (dmg <= 0) continue;
    f.hp -= dmg;
    hit += 1;
    dealt += dmg;
  }
  sweepDead(c.state);
  c.result.log =
    hit > 0
      ? `陨卵落在 (${best.x},${best.y})：${hit} 个敌人共受 ${dealt} 点暗属性伤害`
      : `陨卵落在 (${best.x},${best.y})，这一下没砸到人`;
};
SKILL_EFFECTS['mitosis'] = (c) => {
  const def = utype(c.state, c.self.type);
  const kid = def.splitInto;
  if (!kid || !c.state.unitTypes[kid]) {
    c.result.ok = false;
    c.result.reason = '这个单位没有可裂出的形态';
    return;
  }
  const spots: Array<{ x: number; y: number }> = [];
  for (const [dx, dy] of DIRS) {
    if (canStandAt(c.state, c.self.x + dx, c.self.y + dy, kid)) {
      spots.push({ x: c.self.x + dx, y: c.self.y + dy });
    }
  }
  if (spots.length < 4) {
    c.result.ok = false;
    c.result.reason = `周围只有 ${spots.length} 格空地，裂成四个需要 4 格`;
    return;
  }
  const share = Math.max(1, Math.floor(c.self.hp / 4));
  let left = c.self.hp;
  // 把自己从棋盘上删掉
  c.state.units = c.state.units.filter((x) => x.id !== c.self.id);
  for (let i = 0; i < 4; i += 1) {
    const spot = spots[i]!;
    const born = makeUnit(c.state, c.self.owner, kid, spot.x, spot.y);
    const hp = i === 3 ? Math.max(1, left) : share;
    born.hp = Math.max(1, Math.min(maxHpOf(c.state, born), hp));
    left -= hp;
    c.state.units.push(born);
  }
};

SKILL_EFFECTS['fuse'] = (c) => {
  const def = utype(c.state, c.self.type);
  const bossId = def.mergeInto;
  if (!bossId || !c.state.unitTypes[bossId]) {
    c.result.ok = false;
    c.result.reason = '这个单位没有可合体的形态';
    return;
  }
  if (c.state.units.some((x) => x.owner === c.self.owner && x.type === bossId && x.hp > 0)) {
    c.result.ok = false;
    c.result.reason = '牢大已经在场上了';
    return;
  }
  const kin = c.state.units.filter((x) => x.owner === c.self.owner && x.type === c.self.type && x.hp > 0);
  if (kin.length < 2) {
    c.result.ok = false;
    c.result.reason = '至少要有两只大史莱姆才能合体';
    return;
  }
  const bossDef = utype(c.state, bossId);
  const total = kin.reduce((n, x) => n + x.hp, 0);
  const at = { x: c.self.x, y: c.self.y };
  c.state.units = c.state.units.filter((n) => !kin.some((k) => k.id === n.id));
  const boss = makeUnit(c.state, c.self.owner, bossId, at.x, at.y);
  boss.hp = Math.max(1, Math.min(maxHpOf(c.state, boss), total));
  c.state.units.push(boss);
  pushLog(c.state, c.self.owner, `${kin.length} 只大史莱姆聚合，${bossDef.name}带着 ${boss.hp} 点生命归位`);
};

function doHeroSkill(s: GameState, unitId: string, skillId: string, targetX?: number, targetY?: number): ActionResult {
  const u = s.units.find((x) => x.id === unitId);
  if (!u) return { ok: false, reason: '这里已经没有这个单位了' };
  if (u.owner !== s.current) return { ok: false, reason: '只能给自己人下命令' };

  const def = utype(s, u.type);
  const skill = skillsOf(s, u).find((k) => k.id === skillId);
  if (!skill) return { ok: false, reason: '这个单位没有这个技能' };

  // 如果技能不允许连发，且这回合已经放过，就拦住
  if (!skill.multiCast && u.skillTurn === s.turn) {
    return { ok: false, reason: '这个单位这一回合已经放过技能了' };
  }

  const cd = u.skillCd?.[skill.id] ?? 0;
  const chargeMax = skill.charges ?? 0;
  const regen = Math.max(1, skill.regen ?? 2);
  const box = u.skillCharge?.[skill.id];
  const charge = chargeMax > 0 ? Math.max(0, Math.min(chargeMax, box?.n ?? chargeMax)) : 0;
  if (chargeMax > 0) {
    if (charge <= 0) {
      const wait = Math.max(1, regen - Math.max(0, box?.t ?? 0));
      return { ok: false, reason: `${skill.name} 已经用光了，${wait} 个回合后回一发` };
    }
  } else if (cd > 0) {
    return { ok: false, reason: `${skill.name} 还要等 ${cd} 回合` };
  }

  const handler = SKILL_EFFECTS[skill.effect];
  if (!handler) return { ok: false, reason: `未实现的技能效果：${skill.effect}` };

  const c: SkillCtx = {
    state: s, 
    self: u, 
    skill, 
    api: abilityApi,
    target: (typeof targetX === 'number' && typeof targetY === 'number') ? { x: targetX, y: targetY } : undefined,
    result: { ok: true, log: `${def.name} 使用「${skill.name}」` }
  };

  handler(c);

  if (!c.result.ok) {
    return { ok: false, reason: c.result.reason ?? '技能无法使用' };
  }

  // 写出战报（如果 c.result.log 被修改或覆盖，则用新的）
  if (c.result.log) pushLog(s, u.owner, c.result.log);

  if (chargeMax > 0) {
    // 充能型：扣一发，不动冷却。t 保留——"用完最后一发之后还要攒两回合"
    // 这件事必须从放的那一回合就开始算，否则连开两发能白赚两回合。
    u.skillCharge = { ...(u.skillCharge ?? {}), [skill.id]: { n: charge - 1, t: Math.max(0, box?.t ?? 0) } };
    pushLog(s, u.owner, `${skill.name} 还剩 ${charge - 1}/${chargeMax} 发`);
  } else {
    // 进冷却
    u.skillCd = { ...(u.skillCd ?? {}), [skill.id]: skill.cooldown ?? 0 };
  }

  u.skillTurn = s.turn;

  sweepDead(s);

  return { ok: true, state: s };
}

/**
 * 蛋能落在哪些格。给界面高亮用，也给 AI 挑位置用。
 *
 * 和 doPlaceEgg 共用一套判断，避免"界面高亮了、点下去说不行"。
 */
export function eggSpots(s: GameState): Array<{ x: number; y: number }> {
  const egg = s.pendingEgg;
  if (!egg) return [];
  const out: Array<{ x: number; y: number }> = [];
  for (let dy = -egg.radius; dy <= egg.radius; dy++) {
    for (let dx = -egg.radius; dx <= egg.radius; dx++) {
      if (Math.abs(dx) + Math.abs(dy) > egg.radius) continue;
      const x = egg.x + dx;
      const y = egg.y + dy;
      if (!inBounds(s, x, y)) continue;
      if (canStandAt(s, x, y, egg.type)) out.push({ x, y });
    }
  }
  return out;
}

/** 把蛋放到指定格并孵出来。范围外、格子上有人，都会被拒。 */
function doPlaceEgg(s: GameState, x: number, y: number): ActionResult {
  const egg = s.pendingEgg;
  if (!egg) return { ok: false, reason: '现在没有等待孵化的蛋' };
  if (egg.owner !== s.current) return { ok: false, reason: '这不是你的蛋' };
  const spots = eggSpots(s);
  if (!spots.some((p) => p.x === x && p.y === y)) {
    return { ok: false, reason: `蛋只能放在原地 ${egg.radius} 格内的空地上` };
  }
  const def = utype(s, egg.type);
  const born = makeUnit(s, egg.owner, egg.type, x, y);
  born.hp = Math.max(1, Math.round(maxHpOf(s, born) * egg.hpRatio));
  born.reborn = true;
  s.units.push(born);
  s.pendingEgg = undefined;
  pushLog(s, egg.owner, `${def.name} 的蛋孵化了（${born.hp} 生命）`);
  return { ok: true, state: s };
}

/**
 * 把没人管的蛋自动安置掉。
 *
 * 只在玩家结束回合时兜底：蛋等着落位，玩家不选就一直卡在这儿，
 * 局面永远轮不下去。挑"离原格最近的空格"，不问玩家。
 */
function autoPlaceEgg(s: GameState): void {
  const egg = s.pendingEgg;
  if (!egg) return;
  const spots = eggSpots(s);
  if (spots.length === 0) {
    // 方圆两格都被堵死：这一局就别重生了，蛋烂在原地
    s.pendingEgg = undefined;
    pushLog(s, egg.owner, `${utype(s, egg.type).name} 的蛋无处安放，熄灭了`);
    return;
  }
  const best = spots.reduce((a, b) => {
    const da = Math.abs(a.x - egg.x) + Math.abs(a.y - egg.y);
    const db = Math.abs(b.x - egg.x) + Math.abs(b.y - egg.y);
    return db < da ? b : a;
  });
  doPlaceEgg(s, best.x, best.y);
}

/**
 * 把某一家的单位从盘上撤干净，返回撤走了几个。
 *
 * 认输和"城被打光"在盘面上必须是同一个样子，所以两条路共用这里。
 * 单位是一棵树（船、运输队里还坐着人），按 owner 过滤等于连货舱一起扔掉；
 * 车里的人算不算"死"？不算——他们既没进战报，也不进阵亡名单，
 * 就是随主人一起离场，和认输时一模一样。
 */
function withdrawUnits(s: GameState, p: PlayerId): number {
  const gone = s.units.filter((u) => u.owner === p).length;
  if (gone > 0) s.units = s.units.filter((u) => u.owner !== p);
  return gone;
}

/**
 * 某一家的最后一座城被人接管之后：撤兵，必要时交棒。
 *
 * `isEliminated` 早就把"没有城"判成出局了，但那只管回合轮转（`nextSeat` 跳过去）——
 * **盘上的兵还留着**。于是出局者的部队变成一群永远不动、打不还手的靶子：
 * 对手的自动开火照样拿它们刷伤害，结算画面照样把它们数进兵力，
 * 界面上还能看见一支"没人指挥的军队"杵在那儿。认输那条路一直是清干净的
 * （见 `doSurrender`），破城判负这条路漏了，这里补上。
 *
 * 几处刻意的边界：
 *   · **两人局不处理**：城破就是终局，胜负已定，留着兵是战报的一部分；
 *   · **上帝模式不处理**：沙盒里"没城"是常态（和 `isEliminated` 同一条理由）；
 *   · **认输的不重复处理**：`doSurrender` 自己撤过了。这也是幂等的关键——
 *     已经撤空的席位再来一次是 0 个，连战报都不会重复写；
 *   · **交棒只在它自己正轮到时做**：正常路径下夺城发生在对手回合，
 *     `current` 不是它，这条只是兜底（比如扩展在它的回合里改了城）。
 */
function retireLostSeat(s: GameState, p: PlayerId): void {
  if (seatsOf(s).length === 2) return;
  if (s.config.godMode === true) return;
  if (hasQuit(s, p)) return;
  if (citiesOf(s, p).length > 0) return;
  const gone = withdrawUnits(s, p);
  if (gone === 0) return;
  pushLog(s, p, `${s.players[p].name} 的城市全部失守，${gone} 个单位撤离战场`, true);
  if (!s.winner && s.current === p) {
    s.current = nextSeat(s, p);
    grantTurnTo(s, s.current);
  }
}

/** 认输：直接判负。磨局里除了城破，总得有个体面的出口 */
function doSurrender(s: GameState): ActionResult {
  const me = s.current;
  if (seatsOf(s).length === 2) {
    // 两人局：认输就是这局结束，对面赢（和以前一模一样）
    s.winner = other(me);
    pushLog(s, me, `${s.players[me].name} 认输`, true);
    return { ok: true, state: s };
  }
  /*
   * 三人四人局：认输只是**我**退出，剩下的人接着打。
   *
   * 两条要落实：把这家的兵从盘上撤走（留着就是一群打不还手的靶子，
   * 还会一直被别人的自动开火当成目标），以及把当前行动权交给下一位——
   * 否则 `current` 停在一个已经退出的席位上，局面就卡住了。
   */
  s.out = [...(s.out ?? []), me];
  withdrawUnits(s, me);
  pushLog(s, me, `${s.players[me].name} 认输，退出这局`, true);
  s.winner = checkWinner(s);
  if (!s.winner) {
    s.current = nextSeat(s, me);
    /*
     * 交接必须走 `grantTurnTo`，不能只改 `current`。
     *
     * 只改名字的话，接手的那一家带着自己上回合用剩的 moved/acted 进场：
     * 顶栏说"轮到你"，但点哪个兵都是"已经行动过"——这就是
     * "一方投降之后，其中一方上回合行动过的单位无法行动"那条报障。
     * 认定它是一段**新的回合**（而不是"接着用完别人剩下的半个回合"），
     * 是因为等待它的人看到的本来就是一次完整的轮到。
     */
    grantTurnTo(s, s.current);
  }
  return { ok: true, state: s };
}

/**
 * 清场：把所有 hp ≤ 0 的单位收掉。
 *
 * 单独抽出来，是因为"回合开始的各种自动效果"（中毒、陷阱、自损、燃焰）
 * 可能一次性打死好几个人，而它们各自删各自的单位会漏掉沉船、击杀钩子、
 * 重生这些善后。统一扫一遍最不容易出错。
 */
function sweepDead(s: GameState): void {
  for (const u of [...s.units]) {
    if (u.hp > 0) continue;
    if (!s.units.some((x) => x.id === u.id)) continue;
    s.units = s.units.filter((x) => x.id !== u.id);
    pushLog(s, u.owner, `${utype(s, u.type).name} 倒下了`, true);
    drownCargo(s, u);
    fireKilled(s, u, undefined);
  }
}

/**
 * 动作开始前的在册名单：id → 兵种/主人/位置。
 *
 * 船里的人也算在册——他们只是换了个地方放，不是死了。漏了这一步，
 * 每次装船都会在"阵亡名单"里留下一条，招魂就能把船上的人凭空再拉出来一个。
 */
function rosterOf(s: GameState): Map<string, FallenRecord> {
  const out = new Map<string, FallenRecord>();
  const add = (u: Unit): void => {
    out.set(u.id, { owner: u.owner, type: u.type, x: u.x, y: u.y, turn: s.turn });
  };
  for (const u of s.units) {
    add(u);
    for (const c of u.cargo ?? []) add(c);
  }
  return out;
}

/**
 * 清算这一下动作里"谁没了"，写进 `s.fallen`。
 *
 * 用前后对照而不是在每处死亡代码里各写一条：阵亡路径有战斗、反击、
 * 自爆波及、桥塌落水、城破守军五处，分散写必然漏一处，而漏的那处
 * 在玩家眼里就是一个说不清的"招魂点了没反应"。
 */
function recordDeaths(s: GameState, before: Map<string, FallenRecord>, action: Action): void {
  // 遣散是自己拆的，不是"倒下"——招魂把它拉回来等于花一次技能退钱
  if (action.type === 'DISBAND') return;
  const alive = new Set<string>();
  for (const u of s.units) {
    alive.add(u.id);
    for (const c of u.cargo ?? []) alive.add(c.id);
  }
  const fresh: FallenRecord[] = [];
  for (const [id, rec] of before) {
    if (!alive.has(id)) fresh.push(rec);
  }
  // 只留"刚过去的这一轮"：死亡大多发生在**对手**回合（你的兵是被人打死的），
  // 严格按"当前 turn"比会变成"轮到你时名单已经清空"，招魂永远扑空。
  // 所以口径是"上一回合 + 本回合"，正好等于玩家说的"这一轮里倒下的人"。
  const kept = (s.fallen ?? []).filter((r) => r.turn >= s.turn - 1);
  if (fresh.length === 0) {
    if (kept.length !== (s.fallen ?? []).length) s.fallen = kept;
    return;
  }
  s.fallen = [...kept, ...fresh];
}

/** 中毒/燃烧每回合结算一次，然后把剩余回合数 −1 */
function tickStatuses(s: GameState, p: PlayerId): void {
  for (const u of s.units) {
    if (u.owner !== p || !u.status) continue;

    // 1. 按固定顺序遍历身上的状态，查表执行效果
    for (const [key, val] of orderedStatuses(u.status)) {
      const def = STATUS_REGISTRY[key];
      if (def?.onTurnStart) {
        const logText = def.onTurnStart(s, u, val);
        /*
         * 掉血这条要标成公开。
         *
         * 中毒、灼烧是在**挨打那一方的回合开始时**结算的，所以战报挂在受害者的
         * 名下——不给 open 的话，自己毒了对面，对面掉血那一条只有对面看得见，
         * 施法者这边从头到尾读不到一笔"毒伤"。而血条就在棋盘上摆着，
         * 这条本来也不是秘密。
         */
        if (logText) pushLog(s, p, logText, true);
      }
    }

    // 2. 状态时长/层数减 1
    for (const k of Object.keys(u.status)) {
      const v = u.status[k];
      if (typeof v !== 'number') continue;
      if (v <= 1) delete u.status[k];
      else u.status[k] = v - 1;
    }
  }
  sweepDead(s);
}

/**
 * 自我消耗：土墙、临时召唤物每回合掉血，掉完自己消失。
 *
 * 以前这里一声不响地扣血：棋盘上血条自己变短，战报一个字没有，
 * 玩家只会觉得"这个兵怎么莫名其妙少了血"。掉多少、为什么掉，得写出来。
 */
function decayUnits(s: GameState, p: PlayerId): void {
  for (const u of s.units) {
    if (u.owner !== p) continue;
    const d = utype(s, u.type).decays ?? 0;
    if (d <= 0) continue;
    u.hp -= d;
    pushLog(s, p, `${utype(s, u.type).name} 自身损耗 ${d} 点生命`, true);
  }
  sweepDead(s);
}

/**
 * 回合开始的一串结算：冷却、临时状态、以及那些"自然发生"的被动。
 *
 * 这里只留被动。**英雄技能不在这里**——它们由玩家点（doHeroSkill），
 * 冷却在这里 −1。把主动效果也塞进来的话，玩家就成了旁观者：
 * 英雄强不强只取决于数值，什么时候开、开在谁身上都没得选。
 */
function turnStartSkills(s: GameState, p: PlayerId): void {
  // 0）新回合：清掉上回合的临时状态，技能冷却 −1，充能型技能攒一发
  for (const u of s.units) {
    if (u.owner !== p) continue;
    delete u.heroBuff;
    // 技能增益（圣旗）比 heroBuff 活得久：它要保护的是**对面**那一个回合。
    // 写在 heroBuff 清理的同一处，是因为两者都是"到自己的回合开始就过期"，
    // 分成两处写早晚会有一天只改了一处。
    if (u.buff) {
      const left = (u.buff.turns ?? 1) - 1;
      if (left > 0) u.buff.turns = left;
      else delete u.buff;
    }

    // 孵化（魔龙卵）：按**自己的回合**数，和充能技能一把尺子。
    // 换型保留血量比例：一颗被打掉半血的卵不该孵出一条满血的龙。
    const hatch = utype(s, u.type).hatch;
    if (hatch) {
      const left = (u.hatchLeft ?? hatch.turns) - 1;
      if (left > 0) {
        u.hatchLeft = left;
      } else {
        const from = utype(s, u.type);
        const to = s.unitTypes[hatch.into];
        if (to) {
          const ratio = from.maxHp > 0 ? Math.min(1, u.hp / from.maxHp) : 1;
          u.type = hatch.into;
          u.hp = Math.max(1, Math.round(to.maxHp * ratio));
          delete u.hatchLeft;
          pushLog(s, p, `${from.name} 孵化成了 ${to.name}`, true);
        }
      }
    }
    if (u.status) {
      for (const k of ['poison', 'burn', 'slow', 'curse'] as const) {
        if ((u.status[k] ?? 0) <= 0) delete u.status[k];
      }
    }
    if (u.skillCd) {
      for (const [id, cd] of Object.entries(u.skillCd)) {
        if (cd <= 1) delete u.skillCd[id];
        else u.skillCd[id] = cd - 1;
      }
    }

    // 充能型技能：满发时计时归零（攒着不浪费），没满就往前走一格，
    // 走够 regen 回合回一发。按"自己的回合"数，不按全局 turn——
    // 全局回合两边共用，先手方永远只碰到奇数回合，周期 2 就成了永不触发。
    for (const k of skillsOf(s, u)) {
      const max = k.charges ?? 0;
      if (max <= 0) continue;
      const regen = Math.max(1, k.regen ?? 2);
      const box = u.skillCharge?.[k.id] ?? { n: max, t: 0 };
      const n = Math.max(0, Math.min(max, box.n));
      if (n >= max) {
        if (box.t !== 0) u.skillCharge = { ...(u.skillCharge ?? {}), [k.id]: { n: max, t: 0 } };
        continue;
      }
      const t = box.t + 1;
      const next = t >= regen ? { n: n + 1, t: 0 } : { n, t };
      u.skillCharge = { ...(u.skillCharge ?? {}), [k.id]: next };
    }
  }

  const mine = () => s.units.filter((u) => u.owner === p && u.hp > 0);

  // 1.5）长一岁。召唤周期按这个数算（见第 4 段），不按全局 turn——
  // 全局回合是两边共用的，先手方永远只碰到奇数回合，周期 2 就永不触发。
  for (const u of s.units) {
    if (u.owner !== p) continue;
    u.age = (u.age ?? 0) + 1;
  }

  // 2）光环类（aura）
  for (const u of mine()) runTurnStart(s, u, p, TURN_START.aura, TURN_START.postAura, false);
  // 2.5）空槽
  for (const u of mine()) runTurnStart(s, u, p, TURN_START.postAura, TURN_START.support, false);

  // 3）动手类（support）
  for (const u of mine()) runTurnStart(s, u, p, TURN_START.support, TURN_START.postSupport, false);
  // 伤害类结算完立刻清场
  sweepDead(s);
  // 3.5）空槽
  for (const u of mine()) runTurnStart(s, u, p, TURN_START.postSupport, TURN_START.summon, false);

  // 4）召唤（summon）
  for (const u of mine()) runTurnStart(s, u, p, TURN_START.summon, TURN_START.postSummon, false);
  // 4.5）空槽
  for (const u of mine()) runTurnStart(s, u, p, TURN_START.postSummon, Infinity, false);
}

/**
 * 一个单位在某个回合开始时机上的全部能力。
 *
 * 四段（自愈 / 光环 / 动手 / 召唤）由 rules 决定什么时候问，能力只声明自己属于哪一段。
 * `rested` 只有"自愈"那一段用得到（休整要看上回合动没动），别的段传什么都无所谓。
 */
function runTurnStart(s: GameState, u: Unit, p: PlayerId, from: number, to: number, rested: boolean): void {
  if (u.owner !== p) return;
  const hooks = stagedOfUnit<TurnStartCtx>(s, u, 'onTurnStart');
  if (hooks.length === 0) return;
  runStaged(
    hooks,
    { state: s, self: u, owner: p, rested, healable: canBeHealedOn(s, u), api: abilityApi },
    { from, to },
  );
}

function doEndTurn(s: GameState): ActionResult {
  // 手里还有没落位的蛋：走之前替玩家放好，否则这一方永远等不到下一回合
  if (s.pendingEgg && s.pendingEgg.owner === s.current) autoPlaceEgg(s);

  s.winner = checkWinner(s);
  if (s.winner) {
    pushLog(s, s.winner, '对局结束');
    return { ok: true, state: s };
  }

  const prevPlayer = s.current;
  // 指挥官模式：这回合过完了，序列前移一格。
  //
  // 不管兵有没有造出来都照样消耗——"排了一格、钱不够、这回合空了"
  // 正是这个模式要玩家学会预判的东西。要是失败就原地保留，
  // 序列会悄悄滑期，玩家反而看不出自己在哪一步就走了岔。
  //
  // 两串必须一起前移：`orderSites` 是按位置对齐的，只挪队列会让
  // 后一格的"造在哪座城"错位到前一格上去——那比不做还要糟。
  const prevQueue = s.orders?.[prevPlayer];
  if (prevQueue && prevQueue.length > 0) prevQueue.shift();
  const prevSites = s.orderSites?.[prevPlayer];
  if (prevSites && prevSites.length > 0) prevSites.shift();

  const nextPlayer = nextSeat(s, s.current);
  s.current = nextPlayer;
  s.turn += 1;

  // 回合末钩子（天气、维护费一类）。钩子只负责把血扣到 0，
  // 清场仍然由下面的 sweepDead 统一做——扩展不该各自造一套死亡逻辑。
  for (const e of activeExpansions(s)) {
    e.hooks.onTurnEnd?.({
      state: s,
      player: prevPlayer,
      hurt: (u, amount) => {
        u.hp -= amount;
      },
      log: (p, text) => pushLog(s, p, text),
    });
  }
  if (activeExpansions(s).some((e) => e.hooks.onTurnEnd)) sweepDead(s);

  // 回合开始的伤害类结算：先中毒/灼烧，再自损。
  // 必须在下面算"休整"之前——被毒死的人不该还在名单里等着回血。
  tickStatuses(s, nextPlayer);
  decayUnits(s, nextPlayer);

  // 休整：只有上回合没移动、也没攻击的单位才算"歇过来了"。
  // 这个判断必须在 resetUnitsFor 之前做——重置会把这两个标记清掉。
  const rested = new Set(
    s.units.filter((u) => u.owner === nextPlayer && !u.moved && !u.acted).map((u) => u.id),
  );

  // 新回合开始，所有单位的反击次数重置 + 行动力满血（见 grantTurnTo）
  grantTurnTo(s, nextPlayer);
  advanceConstruction(s, nextPlayer);

  for (const u of s.units) {
    if (u.owner !== nextPlayer) continue;
    runTurnStart(s, u, nextPlayer, TURN_START.self, TURN_START.postSelf, rested.has(u.id));
  }
  for (const u of s.units) {
    if (u.owner !== nextPlayer) continue;
    runTurnStart(s, u, nextPlayer, TURN_START.postSelf, TURN_START.aura, rested.has(u.id));
  }

  // 光环、净化、修缮、筑墙、布雷、召唤、转属——全部自动触发
  turnStartSkills(s, nextPlayer);

  // 守方的建筑在敌人接手回合的第一时间开火
  fireBuildings(s, prevPlayer);
  s.winner = s.winner ?? checkWinner(s);
  if (s.winner) {
    pushLog(s, s.winner, '对局结束');
    return { ok: true, state: s };
  }

  const income = settleIncome(s, nextPlayer);

  // 回血放在收入之后、扩展钩子之前：先把这一回合的资源算清楚，
  // 再让城市在"自己的回合开始"这一刻修好城墙。
  recoverCities(s, nextPlayer);

  const label = Object.keys(income).length > 0 ? incomeLabel(income) : '没有收入';
  pushLog(s, nextPlayer, `回合开始，获得 ${label}`);

  for (const e of activeExpansions(s)) {
    e.hooks.onTurnStart?.({ state: s, player: nextPlayer });
  }

  // 地上的东西也在"回合开始"这一刻结算（火场、毒雾、自爆引信……）。
  // 放在扩展钩子之后：扩展先把局面改完（比如涨潮把浅滩变成水），
  // 再由留痕按最终地形判断，省得同一步里两种效果各算一次地形。
  if (marksOf(s).length > 0) {
    tickMarks(s, nextPlayer, markApi(s));
    sweepDead(s);
  }

  return { ok: true, state: s };
}

/** 城市名，用左上角坐标表示，比如 C8 */
export function cityName(city: City): string {
  return `${String.fromCharCode(65 + city.x)}${city.y + 1}`;
}

/**
 * 视野计算。
 *
 * 地形是全图已知的（战场地图本来就该是已知信息），迷雾只遮敌方单位。
 * 这是"星际式"迷雾而不是"文明式"地形探索，对回合制战棋更合适：
 * 你不需要为"这片地是什么"消耗决策，只需要为"敌人在哪"消耗决策。
 */
export function visibleTilesOf(s: GameState, p: PlayerId): Set<number> {
  const out = new Set<number>();

  const addRadius = (cx: number, cy: number, r: number) => {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dy * dy > r * r) continue;
        const x = cx + dx;
        const y = cy + dy;
        if (inBounds(s, x, y)) out.add(idx(s, x, y));
      }
    }
  };

  for (const u of s.units) {
    if (u.owner !== p) continue;
    addRadius(u.x, u.y, visionOf(s, u));
  }

  for (const city of s.cities) {
    if (city.owner !== p) continue;
    for (const t of cityTiles(city)) addRadius(t.x, t.y, CONFIG.cityVision);
  }

  return out;
}

/**
 * 把"谁现在看到了什么"写回记忆。
 *
 * 必须每次状态迁移后都跑一次，否则幽灵位置会停在上上个回合。
 * 这段逻辑放在规则内核里而不是 UI 里，就是为了让它不可被忘记。
 */
export function refreshMemory(s: GameState): void {
  if (!s.fog) return;

  // 只有「浓雾蔽野」需要地形与城市的记忆：它把地图也遮了，
  // 走过的地方必须留下个样子，否则第二次经过等于第一次来。
  const keepMap = s.config.expansionIds.includes('blackout');

  for (const p of seatsOf(s)) {
    const vis = visibleTilesOf(s, p);
    const mem = s.memory[p];
    const aliveIds = new Set(s.units.map((u) => u.id));

    for (const u of s.units) {
      if (u.owner === p) continue;
      if (!vis.has(idx(s, u.x, u.y))) continue;
      // 潜行中的单位不该刷新坐标：它"还在原地"这件事本身也是情报
      if (isHiddenFrom(s, u, p)) continue;

      const known = mem.known.find((k) => k.id === u.id);
      if (known) {
        known.x = u.x;
        known.y = u.y;
        known.type = u.type;
        known.seenAt = s.turn;
      } else {
        mem.known.push({ id: u.id, type: u.type, x: u.x, y: u.y, seenAt: s.turn });
      }
    }

    // 记忆中的单位如果在视野里消失了，说明确实被消灭了，可以忘掉。
    // 如果那格看不见，就继续保留——你不知道它死了还是走了。
    mem.known = mem.known.filter((k) => {
      if (aliveIds.has(k.id)) return true;
      return !vis.has(idx(s, k.x, k.y));
    });

    if (!keepMap) continue;

    // 地形按"此刻亲眼看得到的"刷新。以前看过、现在看不见的格不会被抹掉——
    // 那正是这份记忆存在的意义。
    mem.tiles ??= {};
    for (const i of vis) {
      const tile = s.tiles[i];
      if (tile) mem.tiles[i] = tile.terrain;
    }

    mem.cities ??= [];
    for (const city of s.cities) {
      // 沾到城的任意一格就算见过：城格是实心的，视野一定先落在它身上
      if (!cityTiles(city).some((t) => vis.has(idx(s, t.x, t.y)))) continue;
      const snap = { owner: city.owner, era: city.era, ruined: city.ruined === true, seenAt: s.turn };
      const known = mem.cities.find((c) => c.id === city.id);
      if (known) Object.assign(known, snap);
      else mem.cities.push({ id: city.id, ...snap });
    }
  }
}

/** 当前玩家还能做什么，给 UI 判断按钮是否可用 */
export function playerHasActions(s: GameState): boolean {
  return unitsOf(s, s.current).some((u) => canMove(u) || canAttack(u));
}
