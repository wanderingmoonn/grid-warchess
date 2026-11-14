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
  DamagedCtx,
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
import { canBeHealed, hasAbilityIn, hasFlag, hooksFor, stagedFor } from './ability-registry.ts';
import type { StagedKey } from './ability-registry.ts';
import {
  CITY,
  CONFIG,
  WATER_TERRAINS,
  ERAS,
  ORDER_IDLE,
  ORDER_UPGRADE,
  buildCostOf,
  buildPowerOf,
  eraDef,
  isPseudoUnit,
  navigable,
  passable,
} from './config.ts';
import { LAST_STAND_BONUS, activeExpansions, eraCeilingOf, lockedEraPacks } from './expansions.ts';
import { upgradeTargetOf } from './era-routes.ts';
import {
  doMount,
  doUnmount,
  doRecharge,
  doUseDevice,
  armorRangeBonus,
  energyReport,
  hasGyro,
  hasHoverModule,
  offlineModules,
  weaponsOf,
  noteWeaponFired,
  resolveArmorWeapon,
  shotsLeftThisTurn,
  type WeaponProfile,
} from './armor.ts';
import { canHold, holdOf, holdRoom } from './carry.ts';
import { airwingOps, deckOf } from './naval-carrier.ts';
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
  BoardId,
  City,
  Element,
  FallenRecord,
  GameState,
  NearSpec,
  OrderDirective,
  SkillDef,
  PlayerId,
  ResourceId,
  Terrain,
  Tile,
  Unit,
  UnitLayer,
  UnitTypeDef,
  ProduceSource,
} from './types.ts';
import { seatsOf } from './types.ts';
import { boardIdOf, boardIds, boardOf, boardStateOf, EARTH, idxOn } from './board.ts';
import { clearSpotlightsOfOthers, spotlightCellsOn } from './spotlight.ts';
import { hazardArmorOf, hazardFor, hazardMoveOf } from './hazard.ts';
import { reconCellsOn } from './recon.ts';
import { skillsOf } from './query.ts';
export { seatsOf };
import { SKILL_EFFECTS, registerSkillEffect, SKILL_READY_CHECKS, registerSkillTargetCells } from './skill-hooks.ts';
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
import { 
  auraSourcesOf, 
  auraBonusOf, 
  allyArmorPctOf,
  allyAtkPctOf,
  allyTrueDamagePctOf,
  foeMovePctOf,
  foeMoveFlatOf,
  fearPenaltyOf, 
  hexWeakPctOf, 
  curseAuraPenaltyOf,
  fearSourcesOf, 
  hexSourcesOf, 
  curseSourcesOf
} from './auras.ts';

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
export function adjacentToWater(
  s: GameState,
  x: number,
  y: number,
  /** 哪张图；不传 = 地球（老调用点一个都不用改） */
  board: BoardId = EARTH,
): boolean {
  return DIRS.some(([dx, dy]) => {
    const t = tileAtOn(s, board, x + dx, y + dy);
    if (!t) return false;
    // 临水就是临水，不分深浅：浅流踩得过去、深水只有船能进，
    // 但"挨着水"这件事对贸易、港口、造船位是一回事。
    // 浅流漏判过一次（农民站在渡口边上拿不到河运加成），和桥那次是同一类错。
    return WATER_TERRAINS.includes(t.terrain);
  });
}

/**
 * 把"邻里要求"的两种写法归一。
 *
 * 新写法 `adjacent` 优先；旧存档里的 `requiresWater: true` 翻译成"紧邻水域"。
 * 两者都写时以 adjacent 为准——取并集的话，"我只想临山"会莫名其妙也要求临水。
 */
export function adjacentRequirementOf(
  def: UnitTypeDef,
): NearSpec | null {
  if (def.adjacent) {
    const terrain = def.adjacent.terrain ?? [];
    const unit = def.adjacent.unit ?? [];
    if (terrain.length === 0 && unit.length === 0) return null;
    return { terrain, unit, count: def.adjacent.count };
  }
  if (def.requiresWater) return { terrain: WATER_TERRAINS, unit: [] };
  return null;
}

/**
 * 给界面/规则书用的一句话：`必须紧邻山脉或灵田`。
 *
 * 兵种名从外面传进来，是因为扩展兵种不在核心的 `UNIT_TYPES` 里——
 * 只有开局后的 `state.unitTypes` 才认得它们。
 */
export function adjacentRequirementText(
  def: UnitTypeDef,
  nameOf: (id: string) => string,
): string | null {
  const adj = adjacentRequirementOf(def);
  if (!adj) return null;
  const names = [
    ...(adj.terrain ?? []).map((t) => CONFIG.terrainName[t]),
    ...(adj.unit ?? []).map(nameOf),
  ];
  return `必须紧邻${names.join('或')}`;
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
function canBeHealedOn(s: GameState, u: Unit): boolean {
  return canBeHealed(utype(s, u.type), u.extraAbilities);
}

/**
 * 注入给能力实现的那套工具。
 *
 * 扩展里的能力**不 import rules**：一是会形成运行时循环依赖（rules → 扩展 → rules），
 * 二是扩展一旦能手抓内核，它就会开始依赖内核内部细节，"写在扩展里"就只剩个位置。
 * 所以内核把自己的能力整理成这张小接口递过去，扩展只认这张接口。
 *
 * 导出它只为"让测试和工具直接走同一条路"（比如验证自定义状态贴得上去）。
 * 扩展仍然应该用注入的 `c.api`，不要 import 这张表——那会绕开注入约定，
 * 也把扩展绑死在这个文件上。
 */
export const abilityApi: AbilityApi = {
  utype,
  tileAt,
  distance,
  strikeDistance,
  canStandAt,
  freeNeighbor,
  // 所有"凭空出现"的单位都从这条路走（召唤 / 分裂 / 孵化 / 裂殖 / 聚合）。
  // 在这里统一打标记，比让五个调用点各自记得打要可靠。
  //
  // `board`：出生在哪张图上，不传 = 地球。**在别的图上施法时必须传**，
  // 否则会在同样的坐标上凭空多出一个地球单位（月面幽灵）。
  spawn: (s, owner, type, x, y, board) => {
    const u = makeUnit(s, owner, type, x, y, board);
    u.summoned = true;
    s.units.push(u);
  },
  viewOf: (s, u) => boardStateOf(s, u),
  tileOf: (s, u) => tileUnder(s, u),
  /**
   * 找空地 + 生成，一步做完。
   *
   * 分成 `freeNeighbor` + `spawn` 两步写的时候，落点和出生点各算各的：
   * 前者默认按地球找空地，后者默认生在地球——在月面上就会得到
   * "月球找的空地、地球多的人"。合成一个函数之后，两个坐标由同一个单位决定。
   */
  spawnNear: (s, owner, type, near) => {
    const view = boardStateOf(s, near);
    const spot = freeNeighbor(view, near, type);
    if (!spot) return null;
    const u = makeUnit(s, owner, type, spot.x, spot.y, boardIdOf(near));
    u.summoned = true;
    s.units.push(u);
    return u;
  },
  pushLog,
  citiesOf,
  distToCity,
  cityName,
  hashPick,
  hasAbility: (s, u, id) => hasAbilityOn(s, u, id),
  canBeHealed: (s, u) => canBeHealed(utype(s, u.type), u.extraAbilities), 
  putStatus: (target, key, turns) => {
    /*
     * 只认已经注册过的状态。
     *
     * 这条校验是给扩展用的：`registerStatus` 一直是对外开放的，但这里以前把 key
     * 写死成 5 个字面量，于是扩展注册了新状态、却没有任何办法把它贴到单位身上——
     * 能注册、贴不上，而且 TypeScript 只在调用方报错，运行时什么都不会发生。
     *
     * 选择抛错而不是静默跳过：贴状态几乎都发生在能力/技能的效果里，一个拼错的
     * id 如果只是"什么都没发生"，玩家看到的是"这个技能没效果"，排查成本极高。
     */
    if (!Object.prototype.hasOwnProperty.call(STATUS_REGISTRY, key)) {
      throw new Error(`未注册的状态「${key}」：先用 registerStatus() 注册，再调用 putStatus()`);
    }
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
  hurt: (s, target, amount, opts) => {
    hurtUnit(s, target, amount, opts);
  },
  hurtPhysical: (s, target, amount, opts) => hurtPhysical(s, target, amount, opts),
  convert: (s, unit, owner, logText) => convertUnit(s, unit, owner, logText),
  maxHpOf: (s, u) => maxHpOf(s, u),
  computeDamage: (s, attacker, defender, isCounter) => computeDamage(s, attacker, defender, isCounter),
  splashRadiusOf: (s, u) => splashRadiusOf(s, u),
  attacksPerTurn: (s, u) => attacksPerTurn(s, u),
  killUnit: (s, victim, killer, logText) => killUnit(s, victim, killer, logText),
  destroyCity: (s, city, attackerOwner) => destroyCity(s, city, attackerOwner),
  noteHeat: (s, x, y, board) => {
    // 只记地球：格号在两张图上会撞（见 ability-hooks 的说明）
    if (board && board !== EARTH) return;
    noteHeatCell(s, x, y);
  },
  isAirborne: (s, u) => isAirborne(s, u),
  unitsAt: (s, x, y) => unitsAt(s, x, y),
  movePower: (s, u) => movePower(s, u),
};

/**
 * 这一次伤害要不要换个人接（守御阵）。
 *
 * 只取**一个**答案：第一个返回非空、且合法的接替者就定下来，之后不再追问。
 * 这条约束是防死循环的——A 转给 B、B 又转回 A 的话，这一下永远落不到地上。
 *
 * 三层合法性检查都是给扩展兜底的，扩展自己不用防：
 * 接替者不能是原目标（等于没转）、不能已经倒下、必须在册。
 */
function redirectOf(s: GameState, victim: Unit, amount: number, source: Unit | undefined): Unit | null {
  for (const e of activeExpansions(s)) {
    const taker = e.hooks.redirectDamage?.({ state: s, victim, amount, source });
    if (!taker) continue;
    if (taker.id === victim.id) continue;
    if (taker.hp <= 0) continue;
    if (!s.units.some((u) => u.id === taker.id)) continue;
    return taker;
  }
  return null;
}

/**
 * 全引擎唯一的"扣血"出口。
 *
 * 以前 `hp -= dmg` 散在八处（普攻、溅射、反击、塔自动开火、地雷、技能直伤……），
 * 于是任何"对伤害本身做手脚"的规则——转移、减伤、护盾——都得改八遍，
 * 漏一处就是"普攻挡得住、溅射挡不住"这种半生效的 bug。
 *
 * 顺序是三件事，不能换：
 *   1. 问钩子由谁接（`redirectDamage`）；
 *   2. 扣血，然后跑受伤者的 `onDamaged`（守御阵在这里吸守阵修士的血补自己）；
 *   3. **最后**才判死——所以被打成 −5 但吸回来 9 点的单位能活下来。
 *
 * 返回值是"实际承受者"，调用方要按它写战报（转移之后挨打的不是原来那个人）。
 */
/**
 * 一条伤害流水。只在跑批/体检时记，正常对局里一条都不会产生。
 *
 * 为什么要这个东西：`balance-report` 是按"动作前后血量差"归因的，只有 ATTACK
 * 那一步才算账。反应射击发生在 MOVE / 下船 / 召唤这些动作里，血量差分根本
 * 看不见它——一座塔打出成吨伤害，统计上照样是 0。与其到处改归因逻辑，
 * 不如在**唯一的伤害出口**留一条流水，跑批时把它抽干。
 */
export interface DamageEvent {
  srcId: string;
  srcType: string;
  dstId: string;
  dstType: string;
  /** 真正掉的血（额外生命吸收掉的那部分不算） */
  amount: number;
  /** 出手方式：`attack` / `react` / ……没标的一律算 `attack` */
  kind: string;
  lethal: boolean;
}

let damageLedger: DamageEvent[] | null = null;

/** 开始记伤害流水（跑批脚本在开局前调一次） */
export function startDamageLedger(): void {
  damageLedger = [];
}

/** 取走并清空流水 */
export function drainDamageLedger(): DamageEvent[] {
  const out = damageLedger ?? [];
  damageLedger = [];
  return out;
}

function hurtUnit(
  s: GameState,
  target: Unit,
  amount: number,
  opts: {
    source?: Unit;
    logText?: string | ((dealt: number) => string);
    /** 跑批统计用的伤害标签（缺省 'attack'，反应射击是 'react'） */
    kind?: string;
    /**
     * **损耗**（attrition）：这一下是"血在自己掉"，不是"挨了一下打"
     * （维护费不足、中毒、灼烧、自损）。
     *
     * 它描述的是**伤害的性质**，不是某条能力的开关。现在读它的有两处，
     * 都是"只在真的挨打时才该发生"的规则：
     *   · 伤害转移（守御阵替友军挨刀）——没道理替人交维护费；
     *   · 受伤钩子（挨打反击、受击回血）——交税不该触发反击。
     *
     * 以后再加「护盾先吸收」「荆棘反伤」这类机制，读的是同一个标记，
     * 不必为每条能力各开一个后门。反过来说，如果哪天要让**某一条**防御
     * 只挡物理、不挡法术，那应该把伤害种类传进 `redirectDamage` 让防御方自己判，
     * 而不是在这里加第二个布尔。
     *
     * 另外它**仍然从这里走**：扣血、战报、致死清场只有一处。
     * 以前这几条路各自 `u.hp -=`，代价是战报口径不一、死了不算任何人杀的。
     */
    attrition?: boolean;
  } = {},
): { victim: Unit; amount: number; redirected: boolean } {
  const dmg = Math.max(0, Math.round(amount));
  if (dmg <= 0) return { victim: target, amount: 0, redirected: false };

  const taker = opts.attrition ? null : redirectOf(s, target, dmg, opts.source);
  const victim = taker ?? target;
  const redirected = victim.id !== target.id;

  /*
   * 「装甲时代」的额外生命：先掉这一层，再掉血。
   *
   * 只在挨打的是装甲素体（有 `extraHp`）时生效——普通兵没有这个字段，
   * 这一整段对它们是零成本的。额度由模块给（`extraHpCap`），卸下模块会截断，
   * 所以这里不需要再判上限：`extraHp` 本身就不该超过额度。
   */
  let toHp = dmg;

  /*
   * 护盾层（扩展提供）：在扣血之前把伤害吃掉。
   *
   * 位置放在 `extraHp` 之前：护盾是"法术给的临时外层"，会比装甲模块更先挨打
   * ——玩家看到的是"盾先碎，然后才轮到装甲"。
   *
   * 和转移一样，**损耗不吃盾**（中毒、维护费是"血在自己掉"，盾挡不住）。
   */
  if (!opts.attrition) {
    for (const e of activeExpansions(s)) {
      if (!e.hooks.absorbDamage) continue;
      const absorbed = e.hooks.absorbDamage({ state: s, victim, amount: toHp, source: opts.source });
      if (absorbed > 0) {
        toHp = Math.max(0, toHp - absorbed);
        if (toHp <= 0) break;
      }
    }
  }

  if (victim.extraHp && victim.extraHp > 0) {
    const absorb = Math.min(victim.extraHp, toHp);
    victim.extraHp -= absorb;
    toHp -= absorb;
  }
  victim.hp -= toHp; // hp-exempt: 唯一的扣血出口，全仓库只有这里可以直接改 hp

  /*
   * 转移的战报必须写，而且默认公开。
   *
   * 不写的话，攻击方看到"造成 17 伤害"、防守方看到自己的兵血没掉，
   * 两边都会以为是显示错误。这条也是"阵在替他挡"的唯一提示——
   * 地图上只有一座建筑的血条在变短。
   */
  if (redirected) {
    pushLog(
      s,
      target.owner,
      `${utype(s, victim.type).name} 替 ${utype(s, target.type).name} 承受了 ${dmg} 点伤害`,
      true,
    );
  } else if (opts.logText) {
    // logText 允许写成函数：地雷那种"攻击力"要**先减甲才知道掉了多少血**，
    // 文案里的数字只能是结算之后的。写成字符串就会把 16 点写成 6 点。
    const text = typeof opts.logText === 'function' ? opts.logText(dmg) : opts.logText;
    pushLog(s, victim.owner, text, true);
  }

  const dctx: DamagedCtx = {
    state: s, self: victim, amount: dmg, source: opts.source, api: abilityApi,
  };
  // 内生损耗不算"挨打"：中毒、交税不该触发反击/受击回血
  if (!opts.attrition) for (const h of hooksOfUnit(s, victim)) h.onDamaged?.(dctx);

  /*
   * 扩展层的"真的掉血了"通知（数值已写进 hp）。
   * 给"挨打就作废"这类规则用，见 ExpansionHooks.onUnitDamaged。
   * 传的是 `victim`：伤害被守御阵接走时，掉血的是接替者，不是原目标。
   */
  for (const e of activeExpansions(s)) {
    e.hooks.onUnitDamaged?.({ state: s, unit: victim, amount: toHp, source: opts.source, api: abilityApi });
  }

  /*
   * 转移把接替者打死了，得由这里收场。
   *
   * 不能指望调用方：doAttack 只判 `defender.hp <= 0`，而接替者根本不是 defender，
   * 于是那具「血量为 0 却还站在场上」的阵会挂到下一次 sweepDead 为止，
   * 期间还能继续替人挡刀。非转移的情况仍由原调用方判死（各条路径的战报文案不同）。
   */
  if (redirected && victim.hp <= 0) {
    abilityApi.killUnit(s, victim, opts.source, `${utype(s, victim.type).name} 被击毁`);
  }

  // 流水放在最后：`victim.hp` 已经被钩子们处理过，`lethal` 才是真的结论
  if (damageLedger && opts.source && toHp > 0) {
    damageLedger.push({
      srcId: opts.source.id,
      srcType: opts.source.type,
      dstId: victim.id,
      dstType: victim.type,
      amount: toHp,
      kind: opts.kind ?? 'attack',
      lethal: victim.hp <= 0,
    });
  }

  return { victim, amount: dmg, redirected };
}

/**
 * 物理直伤：**先减护甲**，再把剩下的血扣掉。地雷、陷阱、自爆冲击波走这条。
 *
 * 为什么需要它（2026-11-13 的约定）：
 * `hurtUnit` 收的是"该掉多少血"，它自己是**不减甲**的——因为普攻那条路
 * 已经在 `computeDamage` 里减过一次，再减就是扣两遍。于是"不经过
 * computeDamage 的伤害"全都有了一个隐形的特权：无视护甲。
 * 地雷、水雷、哥布林陷阱、自爆冲击波都是这么漏过去的，
 * 表现是"重甲兵踩雷和民兵踩雷掉一样多"——那等于让重甲白买。
 *
 * 现在的分工写在 `AbilityApi.hurtPhysical` 的注释里，一句话：
 * **数值是攻击力就走这里，数值是算好的伤害就走 hurt。**
 *
 * 护甲只取 `ownArmorOf`（兵种基础 + 圣剑/石化），**既不含地形掩护，
 * 也不含临时护甲**（圣旗、护体丹）。那两样都是"这一仗的准备"，
 * 而地雷是踩上去才炸的埋伏——不给你摆阵的时间。这条是刻意的分界，
 * 不是漏了：想让药力扛雷，得把它并进 `ownArmorOf`，那会连带改掉普攻。
 *
 * `pierce` 是给"反装甲雷"那种名字里就写着破甲的东西准备的（甲减半）。
 * 返回实际扣掉的血——0 表示这一下被甲完全吃掉了，调用方据此决定要不要报"毫发无伤"。
 */
export function hurtPhysical(
  s: GameState,
  target: Unit,
  amount: number,
  opts: { source?: Unit; logText?: string | ((dealt: number) => string); pierce?: boolean } = {},
): number {
  const raw = Math.max(0, Math.round(amount));
  if (raw <= 0) return 0;
  const armor = ownArmorOf(s, target);
  const effective = opts.pierce ? Math.floor(armor / 2) : armor;
  const dealt = Math.max(0, raw - effective);
  if (dealt <= 0) {
    /*
     * 全被甲吃掉了也要留一条账。
     *
     * 不留的话，玩家只会看到"雷没了、人没掉血"，然后怀疑是不是没触发。
     * 这条是**给防守方看的私有战报**（和普攻那条"刀砍不动"同一个口径）。
     */
    pushLog(s, target.owner, `${utype(s, target.type).name} 扛住了这一下（护甲 ${effective}）`, false);
    return 0;
  }
  hurtUnit(s, target, dealt, { source: opts.source, logText: opts.logText });
  return dealt;
}

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

/**
 * 某一格的地形，**按图取**。
 *
 * `tileAt` 读的是 `s.tiles`（地球那张），月球单位拿它查会得到"地球上同一坐标"
 * 的地形——月面上站在环形山里，护甲却按地球那块草地算。战斗链上凡是
 * "拿目标坐标去查地形"的地方，一律走这个。
 *
 * 地球那条路不绕：`boardOf(s, EARTH)` 直接返回 `s` 自己。
 */
export function tileAtOn(s: GameState, board: BoardId, x: number, y: number): Tile | null {
  const g = boardOf(s, board);
  if (x < 0 || y < 0 || x >= g.w || y >= g.h) return null;
  return g.tiles[y * g.w + x] ?? null;
}

/** 某个单位脚下（锚点）的地形，按它所在的那张图算 */
function tileUnder(s: GameState, u: { board?: BoardId; x: number; y: number }): Tile | null {
  return tileAtOn(s, boardIdOf(u), u.x, u.y);
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
  if (opts.waterUnit) return 1;
  /*
   * 飞行：默认一格 1 点，**不看地形**（连高山都过得去，没理由按 99 点收费）。
   *
   * 但"天气"和"地形"是两回事：风把飞机拖慢，和地面起伏无关。所以这里不是
   * 直接 return 1，而是给扩展留一个只问"空中这一步"的钩子（见 airStepCost）。
   * 没开晴天以外的扩展时它恒为 undefined，代价和从前一模一样。
   */
  if (opts.flyer) {
    let cost = 1;
    for (const e of activeExpansions(s)) {
      const over = e.hooks.airStepCost?.({ state: s, unit, fromIdx, toIdx, cost });
      if (over !== undefined) cost = over;
    }
    return cost;
  }
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
 * 这个单位在不在**地球**上。
 *
 * 多图之后，"拿 (x,y) 去 `state.tiles` 里查"的那批位置判定，要么改成按图
 * 投影（走子、建造已经这么做了，见 `boardStateOf`），要么先挡在门外。
 *
 * ── 2026-11-11：开火与攻城**已经按图接上**，这条不再是战斗的闸门 ──────
 *
 * 月面战斗接上时走过的路（留给下一个人照抄）：
 *   · 几何按图取：`tileAtOn` / `tileUnder` 查地形掩护与射程，
 *     `strikeCellsOf` 用**攻击者那张图**的宽高算覆盖格，`splashVictims` 只波及同图单位；
 *   · 闸门换成"同图判定"（`doAttack` / `doSiege` / `canStrike`）——
 *     跨图的两个单位哪怕坐标挨着，中间也隔着一个天空；
 *   · 变更仍然写在真 `state` 上，只有**读**才按图；
 *   · 战况烈度（heat）暂时只记地球：它存的是格号，没带"图"这一维。
 *
 * 还挡着的只剩两处，都是因为对象压根不在别的图上：
 *   · **装卸**（`doLoad` / `doUnload`）：货舱单位（船、发射井）都只在地球，
 *     月面没有任何带 hold 的东西；真要在月面装卸，把里面的 `inBounds` /
 *     `unitAt` / `blockedFor` 换成 `boardStateOf` 的投影即可；
 *   · **地雷/火场**（`marks`）：只在地球生成，`boardState` 投影时也是清空的。
 */
export function offWorld(u: Unit): boolean {
  return boardIdOf(u) !== EARTH;
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
  // 召唤物的上限由召唤者自己的 summon.max 管。
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
 * 某一格（**含它自己的四邻**）是否满足一组邻里要求。
 *
 * 选址（`adjacent`）和产地条件（`produceNear`）共用这一份几何：
 * 两处如果各写一遍，"2×2 的建筑一半压在山脊上"这种边界迟早会算出两个答案
 * ——玩家看到的是"炉子明明靠着山，怎么说没有森林"。
 */
/**
 * 一块占地 n×n 的地，命中了多少**不同**的邻里目标。
 *
 * 数"目标"而不是"格数"：2×2 的炉子四邻会重复看到同一块灵田，
 * 按格数会数成两块，于是玩家遇到"我明明只有一块灵田，怎么就能造了"。
 * 地形按坐标去重、单位按 id 去重，两种命中合在一个计数里
 * （spec 只写一种时，就是那种东西的个数）。
 *
 * 单位按**阵营**过滤：敌方灵田不该给你的炉子供灵。以前这里不判阵营，
 * "挨着敌方军营"这类要求会稀里糊涂地被敌人满足。
 */
function nearSpecCount(
  s: GameState,
  x: number,
  y: number,
  n: number,
  spec: NearSpec,
  owner: PlayerId,
): number {
  const terrain = spec.terrain ?? [];
  const units = spec.unit ?? [];
  if (terrain.length === 0 && units.length === 0) return 0;
  const hits = new Set<string>();
  const look = (tx: number, ty: number): void => {
    if (!inBounds(s, tx, ty)) return;
    const tile = tileAt(s, tx, ty);
    if (tile && terrain.includes(tile.terrain)) hits.add(`t:${tx},${ty}`);
    const u = unitAt(s, tx, ty);
    if (u && u.owner === owner && units.includes(u.type)) hits.add(`u:${u.id}`);
  };
  for (let dy = 0; dy < n; dy++) {
    for (let dx = 0; dx < n; dx++) {
      const tx = x + dx;
      const ty = y + dy;
      look(tx, ty);
      for (const [ox, oy] of DIRS) look(tx + ox, ty + oy);
    }
  }
  return hits.size;
}

/** 一组邻里要求满不满足（`count` 默认 1 = 有其中之一就够了） */
function adjacentSatisfied(
  s: GameState,
  x: number,
  y: number,
  n: number,
  spec: NearSpec,
  owner: PlayerId,
): boolean {
  return nearSpecCount(s, x, y, n, spec, owner) >= (spec.count ?? 1);
}

/**
 * 一条邻里要求怎么说给玩家听：`森林`、`2 个灵田`。
 *
 * 产地条件（produceAt 的拒绝理由）和兵种说明（info.ts）共用一份：
 * 两处各写一遍就会出现"面板说缺 2 块灵田、点下去只说缺灵田"这种对不上的提示。
 */
export function nearSpecText(spec: NearSpec, nameOf: (id: string) => string): string {
  const parts = [
    ...(spec.terrain ?? []).map((t) => CONFIG.terrainName[t]),
    ...(spec.unit ?? []).map(nameOf),
  ];
  const need = spec.count ?? 1;
  return need > 1 ? `${need} 个${parts.join('或')}` : parts.join('或');
}



/**
 * @deprecated 2026-11-08 起「军工供货」已删除，**生产代码不要再调用**。
 *
 * 产兵建筑现在按自己的档位出兵（见 doRecruit 的 camp 分支），这条"离它最近的
 * 己方城市的时代"不再是任何规则的一部分。
 *
 * 留着它只有一个原因：`scripts/baselines/ai-*.ts` 是冻结的 AI 快照，带 sha256
 * 校验、一个字都不能改，而那几份快照仍然 import 这个名字来做 A/B 对照。
 * 新写的任何东西都不要用它——那等于把删掉的供货逻辑又请回来。
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
 * 「飞行」这类能力可以再把它标成空中层（hooks.airLayer；id 叫 fly-over），
 * 那是给自定义兵种和旧数据留的路：老存档、老角色卡照常工作，
 * 新数据则应该直接写 `layer: 'air'`。
 */
export function airLayer(def: UnitTypeDef): boolean {
  /*
   * 三条判据，其实是同一件事的三种写法：
   *   · `layer: 'air'` —— 现在所有飞行单位都写这个；
   *   · `flight: true` —— 早先只有"能过水"这一个字段，没有层这个概念；
   *   · 能力钩子 `airLayer` —— 「飞行」（id `fly-over`）和兵种编辑器捏出来的旧数据。
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
  // 「反重力悬浮」把地面素体改成空中：模块在就现算，断电/拆下自动落地。
  // 这条必须在 `airLayer(utype)` 之前——否则地面素体永远进不了空中层。
  if (u.modules && u.modules.length > 0 && hasHoverModule(s, u)) return true;
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
 *     这是空中单位本来就有的交易：贴脸打会被反击，隔着一格才是安全的。
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

/**
 * 石化（巨魔的被动）：生命**严格低于**一半时成立。
 *
 * 为什么不做成"加一个状态、到点了再删掉"：那样每一处掉血、回血、治疗、复活
 * 之后都得检查一次，漏一处就是"血回来了护甲还翻倍"，或者叠了两层只撤一层。
 * 这里改成**每次读属性时现算**——血量过线，下一次读就是新值，没有可残留的东西，
 * 也就不可能重复叠加。和「狂暴」（低血加攻）走的是同一条路子。
 *
 * 判据是"严格低于"：正好半血不触发（设成 ≤ 半血的话，50% 那一刻会同时满足
 * "恢复到 50% 及以上应当消失"，两条规则会打架）。
 */
export function isPetrified(s: GameState, u: Unit): boolean {
  const def = utype(s, u.type);
  if (!(def.abilities ?? []).includes('stone-skin')) return false;
  return u.hp * 2 < def.maxHp;
}

/**
 * 单位**自身**的护甲：兵种基础 + 圣剑觉醒这类长在身上的加成。
 *
 * 不含地形、光环、驻军、诅咒——石化翻倍翻的是"它自己的甲"，
 * 不是"脚下这块地的甲"。所以翻倍放在这一个取值口上，
 * 面板（effectiveStats）和伤害结算（computeDamage）都走它，
 * 两边才不会出现"面板 ×2、打出来没翻"。
 */
function ownArmorOf(s: GameState, u: Unit): number {
  const def = utype(s, u.type);
  const base = def.armor + (u.armorBonus ?? 0);
  return isPetrified(s, u) ? base * 2 : base;
}

export function magicResOf(s: GameState, u: Unit): number {
  const base = (utype(s, u.type).magicRes ?? 0) + (u.magicResBonus ?? 0);
  // 石化 +4。这里是魔抗**唯一**的取值口（面板、伤害、AI 估算都读它），
  // 加在这一处就同时管住三边，不用各自再写一遍。
  return isPetrified(s, u) ? base + 4 : base;
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
  let atkNow = utype(s, attacker.type).atk + (attacker.atkBonus ?? 0) + auraBonusOf(s, attacker).atk;
  /*
   * 百分比光环（杀伐阵）：加在"基础 + 加法光环"之后、状态之前。
   *
   * 位置要和 effectiveStats 里那段一模一样——面板写 +10%、打出来 +0 是
   * 这套代码里最难查的偏差（护甲那边专门留过一条注释讲同一个坑）。
   * 取整用四舍五入，和另一处百分比（虚咒）一致。
   */
  const atkPct = allyAtkPctOf(s, attacker);
  if (atkPct) atkNow = Math.round(atkNow * (1 + atkPct.value));
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

import { STATUS_REGISTRY, registerStatus } from './statuses.ts';
import type { StatusDef } from './statuses.ts';

/*
 * 状态注册表已经搬到 `statuses.ts`（那一层扩展能 import，不会把 rules 拖进环）。
 * 这里 re-export 只是为了让既有的 `import { STATUS_REGISTRY } from './rules.ts'`
 * 继续能用；新代码请直接从 `./statuses.ts` 取。
 */
export { STATUS_REGISTRY, registerStatus };

/*
 * 核心自己保留的五条状态。
 *
 * 中毒、灼烧已经搬到奇想包（`fantasy-packs.ts`）：它们是那个包的内容，
 * 关掉奇想之后核心不该还留着一份"没人会贴的状态"。注册表本身在
 * `statuses.ts`——那一层扩展也能 import，且不会把 rules 拖进环里。
 */
const CORE_STATUS_DEFS: Record<string, StatusDef> = {
  slow: {
    id: 'slow',
    name: '减速',
    summary: '移动力 −1',
    // 原逻辑：只要 slow > 0，就扣 1 点移动
    modifyMove: (_s, _u, val, move) => (val > 0 ? move - 1 : move),
  },
  /*
   * 迟缓：移动力**减半**，不是定身。
   *
   * 和 slow 并存：一个是"按比例砍"，一个是"减一格"。两个都挂上时先减 1
   * 再减半还是反过来，结果会差 1 点，所以顺序由 STATUS_ORDER 钉死。
   *
   * 保底 1 是设计意图：1 移的单位被减速后仍能走一格，不然它就变成
   * "站着不能动"，那和定身没区别，而这条 debuff 想表达的是"追不上"。
   */
  chill: {
    id: 'chill',
    name: '迟缓',
    summary: '移动力减半（至少留 1 格）',
    modifyMove: (_s, _u, val, move) => (val > 0 ? Math.max(1, Math.floor(move * 0.5)) : move),
  },
  /*
   * 熔甲：护甲**减半**。
   *
   * 取的是"当前护甲"（含光环、地形、已有加成），不是兵种白值——
   * 玩家的直觉是"打上去甲少了一半"，而不是"基础甲少了一半"。
   * 和「诅咒」（−2）不同，那个是固定值，对高甲单位几乎无效。
   */
  sunder: {
    id: 'sunder',
    name: '熔甲',
    summary: '护甲减半',
    modifyArmor: (_s, _u, val, armor) => (val > 0 ? Math.floor(armor / 2) : armor),
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

for (const def of Object.values(CORE_STATUS_DEFS)) registerStatus(def);

/**
 * 状态结算的固定顺序：中毒 → 灼烧 → 减速 → 诅咒。
 *
 * 前两条会写战报，顺序一乱，同一兵同时中两种状态时日志的行序就跟着变；
 * 而战报是玩家复盘时唯一的证据链，"这次到底先掉血还是先被烧"不该由
 * 对象里字段的写入顺序决定。扩展注册的状态排在后面，按注册先后。
 */
const STATUS_ORDER = ['poison', 'burn', 'slow', 'chill', 'curse', 'sunder', 'curse-deep'];

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
// 「每层烧多少」是奇想包的内容（见 fantasy-packs.ts 的 BURN_PER_LAYER）。
// 核心只留「最多几层」：那是命中类能力和回合结算共用的上限，属于机制。
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
function makeUnit(
  s: GameState,
  owner: PlayerId,
  type: string,
  x: number,
  y: number,
  /**
   * 出生在哪张图上。不传 = 地球。
   *
   * 地球单位**不写这个字段**：老存档、老回放、联机快照里都没有它，
   * `boardIdOf` 缺省就是地球，所以一个字节都不用多存。
   * 别的图必须写——漏了就会被当成地球单位，正是 6e3e86f 修过的"月面幽灵"。
   */
  board?: BoardId,
): Unit {
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
    // 出生回合：技能那条路（heroSkillsOf / doHeroSkill）拿它挡"刚上场就放大招"。
    // 走位和攻击靠上面两个 true 就够了，技能不查它们，所以得单独记。
    bornTurn: s.turn,
    ...(typeof def.ammo === 'number' ? { ammoLeft: def.ammo } : {}),
    // 卵一落地就开始倒计时：写在这里而不是"第一次回合开始"，
    // 否则每颗卵都会比自己写的 `turns` 多待一个回合。
    ...(def.hatch ? { hatchLeft: def.hatch.turns } : {}),
    ...(board && board !== EARTH ? { board } : {}),
  };
}

export function maxHpOf(s: GameState, u: Unit): number {
  const base = utype(s, u.type).maxHp;
  return base + (u.maxHpBonus ?? 0);
}

/**
 * 百分比护甲（护体丹）实际加多少。
 *
 * 面板（effectiveStats）和伤害结算（computeDamage）**必须都调用这一个函数**：
 * 两边各写一遍就会漂移，而漂移的表现是"面板说 10 点、打出来按 7 点算"——
 * 圣旗那次已经踩过，这里收成一处。
 *
 * **+1 保底**：修士 0 期护甲就是 0，纯按比例算等于吃了没效果。
 * 固定值那一路（圣旗 `buff.armor`）不加保底：它本来就是写死的一个数。
 *
 * ⚠️ 调用位置很关键：必须在**扩展钩子之后**（修真包的境界护甲在那里加上去），
 * 在那之前护甲还是基础值，百分比等于白乘。
 */
function buffArmorPctGain(armor: number, pct: number): number {
  return Math.max(1, Math.round(Math.max(0, armor) * pct));
}

/**
 * 这个兵种能不能掠水。
 *
 * 读 `flight` 字段（原版预留的机制字段），同时认能力钩子 `crossesWater`：
 * 兵种编辑器里勾「飞行」「跳跃」都落到这个钩子上——不认识它，
 * 玩家自己捏的飞行兵会当场失灵。
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
function tileStandsOk(
  s: GameState,
  x: number,
  y: number,
  def: UnitTypeDef,
  /** 只看地形，不管这一格有没有人（传送落位校验用：人还没挪过去） */
  ignoreUnits = false,
): boolean {
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
  return ignoreUnits ? true : !sameLayerAt(s, x, y, airLayer(def));
}

/**
 * 这个兵种能不能站在这一格（锚点）。占地 2 的兵要四格都成立。
 *
 * 注意"能不能站"和"这一格有没有人"是两件事：前者是地形与层，
 * 后者由 sameLayerAt 逐格判（所以 2×2 的兵贴着一座 2×2 的建筑放不下）。
 */
export function canStandAt(
  s: GameState,
  x: number,
  y: number,
  type: string,
  opts: { ignoreUnits?: boolean } = {},
): boolean {
  const def = utype(s, type);
  const n = footprintOf(s, type);
  for (let dy = 0; dy < n; dy++) {
    for (let dx = 0; dx < n; dx++) {
      if (!tileStandsOk(s, x + dx, y + dy, def, opts.ignoreUnits)) return false;
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
 * 这个单位有没有"武器"：面板攻、法攻、或写在伤害阶段钩子里的伤害，至少有一项。
 *
 * 桥、渡船、土墙、魔龙卵、城墙、补给舰、灵体/阵法以外的支援单位……都是
 * `atk: 0` 且没有 `magicAtk` 的东西（全兵种表里一共 36 个）。以前它们照样能下
 * ATTACK / SIEGE 指令——打不出伤害（`computeDamage` 归零），**但动作本身有副作用**：
 * 吃掉这回合的 `acted`、挨对面一次反击、朝战报里写一条
 * "木桥 攻击 民兵，穿不透护甲，没有造成伤害"。伤害为 0 不等于这个动作是空的，
 * 所以要在"能不能出手"这一层拦，而不是在伤害那一层拦。
 *
 * 判据的顺序和边界：
 *   · 先看兵种表（`atk` / `magicAtk`）——99% 的兵种在这里就返回 true；
 *   · 面板是 0 时，再看**伤害阶段**的钩子：修真包的灵体就是 `atk: 0`，伤害全部
 *     来自「真元」（按境界算，不进兵种表）。只看面板会把这种"真能打"的兵种
 *     一起封掉，所以有 damage 钩子就算有武器；
 *   · **不看**光环和状态（`attackPowerNow` / `effectiveStats`）：那是临时加成，
 *     一座桥挨着指挥光环不该"临时长出武器"。
 *
 * 只约束**出手方**。桥作为**目标**仍然能打——拆桥是正经战术，见 canStrike 的注释。
 */
export function isArmed(s: GameState, u: Unit): boolean {
  const def = utype(s, u.type);
  if ((def.atk ?? 0) > 0 || (def.magicAtk ?? 0) > 0) return true;
  // stagedFor 的结果按"能力 id 串"缓存，热循环里不会反复拼数组
  return stagedFor<HookCtx>(def, 'damage', u.extraAbilities).length > 0;
}

//旧代码残留，现在已经移动到aura.ts，这里只保留薄包装
export function auraBonus(s: GameState, unit: Unit): { atk: number; armor: number } {
  const b = auraBonusOf(s, unit);
  return { atk: b.atk, armor: b.armor };
}
export function fearPenalty(s: GameState, unit: Unit): number {
  return fearPenaltyOf(s, unit);
}
export function hexWeakPct(s: GameState, unit: Unit): number {
  return hexWeakPctOf(s, unit);
}
export function curseAuraPenalty(s: GameState, unit: Unit): number {
  return curseAuraPenaltyOf(s, unit);
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

  // 疾行光环：半径内的友军各 +1，可以叠（吟游诗人多了确实快）
  move += auraBonusOf(s, unit).move;

  // 先保底 1：减速、光环这些加减法算完，最少留一格移动力。
  // 这条要在钩子**之前**——否则"钩子把移动力压到 0"和"减速扣成 0"
  // 会长得一模一样，而前者是规则（封冻），后者是 bug。
  move = Math.max(1, move);

  /*
   * 封印阵这类"按比例压速度"：必须在保底之后。
   *
   * 提在保底前面的话，移动力 1 的单位被砍成 0 又会被抬回 1，永远封不住；
   * 放在这里则 0 是真的 0，和扩展钩子"返回 0 = 这回合动不了"是同一个语义。
   */
  const sealMove = foeMovePctOf(s, unit);
  if (sealMove.value < 1) move = Math.floor(move * sealMove.value);
  // 固定扣减排在比例之后，而且可以扣到 0（封印阵 + 守阵修士就靠这一步）。
  const sealFlat = foeMoveFlatOf(s, unit);
  if (sealFlat.value > 0) move = Math.max(0, move - sealFlat.value);

  for (const e of activeExpansions(s)) {
    if (e.hooks.modifyMove) {
      move = e.hooks.modifyMove({ state: s, unit, move, visionOf: (x) => visionOf(s, x) });
    }
  }
  /*
   * 石化：移动力减半（向下取整，最低 1）。
   *
   * 放在所有加减法**之后**：玩家看到的是"它现在只能走一半的路"，
   * 所以连血战那种全军 +1 也一起折半，而不是"先折半再 +1"。
   * `move > 0` 那道守卫不能省：扩展钩子返回 0 是引擎写明的"这一回合动不了"
   * （封冻、行动点耗尽），减半之后若再套"保底 1"，封冻就被悄悄解开了。
   */
  /*
   * 地图环境（外空、辐射、毒雾）：**先环境、后状态**。
   *
   * 顺序有讲究：环境是"这张图让所有人变慢"，石化是"这个单位自己变慢"。
   * 反过来先折石化再折环境，同一支兵在两张图上会得到不一样的结果，
   * 玩家没法用"我在月球上就是慢一半"来解释。
   */
  move = hazardMoveOf(move, hazardFor(s, unit));
  if (move > 0 && isPetrified(s, unit)) move = Math.max(1, Math.floor(move / 2));
  // 钩子返回 0 = 这一回合动不了（封冻的海军）。
  move -= unit.moveSpent ?? 0; 
  return Math.max(0, move);
}

/**
 * 状态对视野的修正：实际视野（`visionOf`）和面板明细（`effectiveStats`）共用这一段。
 *
 * `StatusDef.modifyVision` 从注册表存在那天起就没人调过——钩子写好了，
 * 但六处派发点（攻击 / 移动 / 攻击面板 / 护甲×2 / 回合结算）没有一处是视野。
 * 丹药的「明目」这类效果要改视野，得先把它接上。
 *
 * 抽成一个函数而不是在两处各写一遍：面板写"视野 +2"、实际却按原值算，
 * 是这套代码里最难查的一类偏差（护甲那边就专门为它留过一条注释）。
 */
function applyStatusVision(
  s: GameState,
  u: Unit,
  base: number,
  items?: StatItem[],
): number {
  // 快路径：绝大多数单位身上没有任何状态。visionOf 会被迷雾每帧为每个单位调一次，
  // 别为了一个空表去建数组。
  if (!u.status) return base;
  let r = base;
  for (const [key, val] of orderedStatuses(u.status)) {
    const def = STATUS_REGISTRY[key];
    if (!def?.modifyVision) continue;
    const before = r;
    r = def.modifyVision(s, u, val, r);
    if (items && r !== before) items.push({ label: def.name, delta: r - before });
  }
  return r;
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
  // 状态修正放在"本来就看"的判据之后：0 视野是真的不看（桥），
  // 不该被一颗「明目丹」凭空点出眼睛来。
  r = applyStatusVision(s, unit, r);
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
  for (const src of auraSourcesOf(s, u, 'allyAtk')) {
    atk += src.value;
    atkItems.push({ label: src.label, delta: src.value });
  }
  // 百分比光环要和 attackPowerNow 算在同一处，否则面板和实际会分家
  const atkPctSrc = allyAtkPctOf(s, u);
  if (atkPctSrc) {
    const before = atk;
    atk = Math.round(atk * (1 + atkPctSrc.value));
    if (atk !== before) {
      atkItems.push({ label: atkPctSrc.label, delta: atk - before });
    }
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
  for (const src of fearSourcesOf(s, u)) {
    atk -= src.value;
    atkItems.push({ label: src.label, delta: -src.value });
  }
  for (const src of hexSourcesOf(s, u)) {
    const before = atk;
    atk = Math.round(atk * (1 - src.value));
    atkItems.push({ label: src.label, delta: atk - before });
  }
  // 面板上的攻击力修正（狂暴，以及以后任何"现在就成立"的攻击加成）。
  // 放在威吓之后、哀兵必胜之前：原来就在这个位置，而乘法必须吃满前面的加减。
  const atkCtx: HookCtx = {
    state: s,
    // 只读视角：`self` 会被 runBound 逐个改绑，所以必须用 getter——
    // 写成固定字段的话，第二条能力拿到的是第一个主人的那张图。
    get view() {
      return boardStateOf(this.state, this.self);
    },
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
  const armorBase = ownArmorOf(s, u);
  const armorItems: StatItem[] = [];
  let armor = armorBase;
  if (u.armorBonus) armorItems.push({ label: '圣剑觉醒', delta: u.armorBonus });
  // 石化翻倍的是"它自己的甲"，所以只在 armorBase 上生效，写一条明细给面板看
  if (isPetrified(s, u)) {
    armorItems.push({ label: '石化 ×2', delta: armorBase - (def.armor + (u.armorBonus ?? 0)) });
  }
  // 地形加成按**这个单位所在的图**取：月球上站在环形山里，面板该写环形山的 +2 甲
  const tile = tileUnder(s, u);
  for (const src of auraSourcesOf(s, u, 'allyArmor')) {
    armor += src.value;
    armorItems.push({ label: src.label, delta: src.value });
  }
  /*
   * 护甲百分比光环（玄石印）。
   *
   * 位置和攻击那侧的 `allyAtkPct` 对齐：**加法光环之后、地形之前**。
   * 放在地形之前是有意的——地形是"掩体 +2"，它不该被百分比放大，
   * 否则同一条光环在山地上比在平原上值钱，玩家没法估算。
   *
   * 保底 +1：`round(3 × 0.1) = 0`，不给保底的话这条光环在前期等于不存在，
   * 而 2 代的玄石印主要就是给低境界修士保命用的。
   */
  const armorPctSrc = allyArmorPctOf(s, u);
  if (armorPctSrc) {
    const before = armor;
    armor += Math.max(1, Math.round(before * armorPctSrc.value));
    armorItems.push({ label: armorPctSrc.label, delta: armor - before });
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
    // 只读视角：`self` 会被 runBound 逐个改绑，所以必须用 getter——
    // 写成固定字段的话，第二条能力拿到的是第一个主人的那张图。
    get view() {
      return boardStateOf(this.state, this.self);
    },
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
  // 圣旗（神圣骑士长）：**固定值**临时护甲。面板和结算必须读同一个字段，
  // 否则会出现"面板写着 10 点、实际按 7 点算"这种只能靠猜的偏差。
  //
  // 注意它和 `armorPct` 是**两个位置**：固定值加在这里（基础护甲那一层），
  // 百分比要等扩展钩子（境界护甲）跑完再加——否则修士 0 期护甲是 0，
  // "+25%" 会变成 "+0"。这条是实测踩出来的，别合并回去。
  //
  // ⚠️ 它**不进 `armorItems`**（药力/技能增益都不进）：属性下面那串修正项是
  // "这个数字为什么是这样"，读起来像地形或永久加成；而 buff 是会到期的，
  // 它真正的家在面板的状态栏里（`statusRow` 会画成「护体丹 2 回合」）。
  // 两处都写一遍，玩家反而会以为有两个不同的东西。
  if (u.buff?.armor) armor += u.buff.armor;
  for (const src of curseSourcesOf(s, u)) {
    armor -= src.value;
    armorItems.push({ label: src.label, delta: -src.value });
  }

  // 扩展改甲（堑壕战等）：一条钩子一行，标签用扩展名
  for (const e of activeExpansions(s)) {
    if (e.hooks.modifyArmor) {
      const before = armor;
      armor = e.hooks.modifyArmor({
        state: s,
        attacker: u,
        defender: u,
        armor,
        isCounter: false,
        // 查自己直接给当前值：否则「按友军护甲加甲」那条钩子会转回来再算一次自己
        armorOf: (x) => (x.id === u.id ? armor : effectiveStats(s, x).armor),
        visionOf: (x) => visionOf(s, x),
      });
      if (armor !== before) armorItems.push({ label: e.name, delta: armor - before });
    }
  }

  // 百分比护甲（护体丹）：必须等扩展钩子（修真包的境界护甲）跑完再乘。
  // 放在那之前，修士的护甲还是 0，+25% 会算成 0——实测踩过一次。
  //
  // 同样不进 `armorItems`，理由见上面那条：buff 由状态栏负责表达。
  if (u.buff?.armorPct) {
    armor += buffArmorPctGain(armor, u.buff.armorPct);
  }

  /*
   * 地图环境：护甲整除数、无保底。
   *
   * 放在**所有加成之后**：穿什么甲都挡不住没有空气这件事，
   * "甲不值钱"是环境决定的，不是某一层加成能抵消的。
   * 面板必须和 `computeDamage` 同一位置，否则会出现"面板 2 甲、实际按 2 甲算"
   * 之外的第三种数——那种偏差最难查。
   */
  const hz = hazardFor(s, u);
  if (hz) {
    const before = armor;
    armor = hazardArmorOf(armor, hz);
    if (armor !== before) armorItems.push({ label: hz.name, delta: armor - before });
  }

  // ── 移动力 (严格按照 movePower 的执行顺序) ──
  const moveBase = def.move;
  const moveItems: StatItem[] = [];
  let moveNow = moveBase;
  if (moveBase > 0) {
    const heroMove = u.heroBuff?.moveBonus ?? 0;
    if (heroMove !== 0) {
      moveNow += heroMove;
      moveItems.push({ label: '技能', delta: heroMove });
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
    for (const src of auraSourcesOf(s, u, 'allyMove')) {
      moveNow += src.value;
      moveItems.push({ label: src.label, delta: src.value });
    }
    const beforeClamp = moveNow;
    moveNow = Math.max(1, moveNow);
    if (moveNow !== beforeClamp) moveItems.push({ label: '保底', delta: moveNow - beforeClamp });

    // 封印阵：和 movePower 同一位置（保底之后）
    const sealSrc = foeMovePctOf(s, u);
    if (sealSrc.value < 1) {
      const before = moveNow;
      moveNow = Math.floor(moveNow * sealSrc.value);
      if (moveNow !== before) moveItems.push({ label: sealSrc.label, delta: moveNow - before });
    }
    const sealFlatSrc = foeMoveFlatOf(s, u);
    if (sealFlatSrc.value > 0) {
      const before = moveNow;
      moveNow = Math.max(0, moveNow - sealFlatSrc.value);
      if (moveNow !== before) moveItems.push({ label: sealFlatSrc.label, delta: moveNow - before });
    }

    for (const e of activeExpansions(s)) {
      if (e.hooks.modifyMove) {
        const before = moveNow;
        moveNow = e.hooks.modifyMove({
        state: s,
        unit: u,
        move: moveNow,
        visionOf: (x) => visionOf(s, x),
      });
        if (moveNow !== before) moveItems.push({ label: e.name, delta: moveNow - before });
      }
    }
    // 地图环境：和 movePower 同一个位置（扩展钩子之后、石化之前）
    if (hz) {
      const before = moveNow;
      moveNow = hazardMoveOf(moveNow, hz);
      if (moveNow !== before) moveItems.push({ label: hz.name, delta: moveNow - before });
    }
    // 石化减半：和 movePower 同一个位置（扩展钩子之后）、同一个算法，
    // 面板和实际走位才对得上
    if (moveNow > 0 && isPetrified(s, u)) {
      const before = moveNow;
      moveNow = Math.max(1, Math.floor(moveNow / 2));
      if (moveNow !== before) moveItems.push({ label: '石化 ×0.5', delta: moveNow - before });
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
  visionNow = applyStatusVision(s, u, visionNow, visionItems);

  // ── 射程 ──
  const rangeBase = def.range;
  const rangeItems: StatItem[] = [];
  let rangeNow = rangeBase;
  if (typeof def.ammo === 'number' && outOfAmmo(s, u)) {
    rangeItems.push({ label: '弹药耗尽', delta: 1 - rangeBase });
    rangeNow = 1;
  } else {
    if (u.heroBuff?.range !== undefined && u.heroBuff.range !== rangeBase) {
      rangeItems.push({ label: '技能', delta: u.heroBuff.range - rangeBase });
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
export function recruitCost(
  s: GameState,
  player: PlayerId,
  def: UnitTypeDef,
  source?: ProduceSource,
): number {
  let cost = def.cost;
  for (const e of activeExpansions(s)) {
    if (e.hooks.modifyCost) cost = e.hooks.modifyCost({ state: s, player, unitType: def, cost, source });
  }
  return Math.max(0, cost);
}

/**
 * 一个兵种的**完整价格**：金币 + 其它资源。
 *
 * 金币那一段走老的 modifyCost（所有既有扩展都在改它），其它资源走
 * modifyResourceCost。两个钩子分开而不是合成一个"价格对象"：
 * 合并等于把所有既有扩展的签名改一遍，而它们关心的事情本来就只有金币。
 *
 * `source` 是"从哪儿造"（城 / 哪座产兵建筑）。不传 = 不分产兵点，
 * 这正是老调用方的行为；传了之后扩展才能做"同一件兵，城里卖金币、
 * 宗门里卖灵石"这种按产地的定价（修真包就是这么用的）。
 */
export function recruitResCost(
  s: GameState,
  player: PlayerId,
  def: UnitTypeDef,
  source?: ProduceSource,
): ResourceCost {
  const gold = recruitCost(s, player, def, source);
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
        source,
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
  source?: ProduceSource,
): { price: ResourceCost; unlockFee: number; total: ResourceCost; gold: number } {
  const price = recruitResCost(s, player, def, source);
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
export function blockedFor(s: GameState, x: number, y: number, unit: { type: string; owner: PlayerId; modules?: string[]; layer?: UnitLayer }): boolean {
  const tile = tileAt(s, x, y);
  if (!tile) return true;

  const def = utype(s, unit.type);
  /*
   * 「反重力悬浮」：地面素体装上之后走的是空中那一套。
   *
   * 为什么要在这一层单独判：`terrainWalkable` 只看**兵种**，而悬浮是**模块**，
   * 不在这里补一刀，装了悬浮的砧照样过不了河——面板写着"空中单位"，
   * 实际一步都走不动。
   * 高山仍然进不去：连飞行兵都进不去（`terrainWalkable` 的既有口径），
   * 悬浮没有理由比飞行更自由。
   */
  const hover =
    !unit.layer && !!unit.modules?.length && hasHoverModule(s, unit as Unit);
  if (hover) {
    if (tile.terrain === 'mountain') return true;
  } else if (!terrainWalkable(def, tile.terrain)) {
    return true;
  }
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

/**
 * 这个兵种有没有"会藏起来"的本事（潜行 / 隐匿 / 潜航 / 隐身 / 刺客大师）。
 *
 * 只回答"它有没有这类能力"，不回答"此刻藏住了没"——后者要按观察者逐个算，
 * 见 `isHiddenFrom`。界面要显示角标，两件事都得问，所以分开两个函数。
 */
export function hidesInFog(s: GameState, unit: Unit): boolean {
  if (unit.heroBuff?.hidden === true) return true;
  return hooksOfUnit(s, unit).some((h) => !!h.hidden);
}

/**
 * 对**每一个**敌人是不是都藏住了。
 *
 * 隐匿是逐观察者判定的（潜行看地形、刺客看这回合动没动、贴脸会破），
 * 所以"我藏住了没"在多人局里没有唯一答案。界面给自家单位挂角标时，
 * 只要还有一家看得见它，就得说"已现形"——那才是它真正面临的风险。
 */
export function hiddenFromAllFoes(s: GameState, unit: Unit): boolean {
  if (!s.fog) return false;
  for (const p of Object.keys(s.players) as PlayerId[]) {
    if (p === unit.owner) continue;
    if (!isHiddenFrom(s, unit, p)) return false;
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
export function reachableTiles(s0: GameState, unit: Unit): Map<number, number> {
  /*
   * 按**单位所在的那张图**算：月球上的兵不能用地球的地形和宽度寻路。
   * 换成的是一份只读投影（`boardStateOf`），地球单位拿到的就是原 state。
   */
  const s = boardStateOf(s0, unit);

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
  // 掠空：可以掠过水面，森林和丘陵也按 1 步算。
  // 这条不是"更强的穿林"——穿林的收益是省一步，掠空的收益是**河防对它不成立**。
  // 「飞行」（fly-over）是掠空的加强版：同样掠水，另外还能和地面单位同格。
  // 注意 id 和名字是反的（2026-11-08 对调过名字）：fly = 掠空，fly-over = 飞行。
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
      // 这正是「飞行」那半句"可以和地面单位重叠"的全部实现。
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
export function threatTiles(state: GameState, unit: Unit): Set<number> {
  /*
   * 纯几何，按**这个单位所在的那张图**算。
   *
   * 返回的是"这张图的格号"：地球的 45 和月球的 45 不是一个位置，
   * 所以调用方画在哪张图上，就得拿哪张图的格号。以前它默认读 `s.tiles`，
   * 月面上的单位会算出一圈"地球上能打到哪"——月面战斗接上之后这就是错的。
   */
  const s = boardStateOf(state, unit);
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
  /*
   * 不同图上的两个单位，哪怕坐标在纸上"挨着"，也是隔着一个天空的。
   *
   * 以前靠 `offWorld` 在 `doAttack` 门口一刀切（月面一律不许开火），
   * 现在月面能打了，这条判据就必须各自成立：**几何只看同一张图**。
   * 放在最前面，后面那些射程/地形计算才不会拿两张图的坐标互相比。
   */
  if (boardIdOf(attacker) !== boardIdOf(target)) return false;
  // 没武器的单位不能出手（桥、渡船、土墙、魔龙卵）。必须放在最前面：
  // 下面的 `range` 判定会把 `range: 0` 兜底成"打到隔壁"（effectiveRange 至少 1），
  // 所以不在这里拦，"0 射程"也能对邻格开火——见 isArmed 的注释。
  if (!isArmed(s, attacker)) return false;
  /*
   * 装甲素体：射程写在**武器**上，素体本身只有撞击（1 格）。
   *
   * 不在这一层按武器判的话，受影响的不是"能不能打"——doAttack 里另有一段
   * 按武器判的闸门，玩家手点没问题——而是**所有"谁够得着我"的推断**：
   * AI 的 `attackableTargets`、界面的可攻击高亮、威胁圈，全都只认 1 格，
   * 装了 7 格炮的砧在它们眼里还是一台贴脸单位。
   */
  if (utype(s, attacker.type).armorFrame) {
    const off = offlineModules(s, attacker);
    const air = isAirborne(s, target);
    let reach = 0;
    for (const x of weaponsOf(attacker)) {
      if (off.has(x.id)) continue;
      const t = x.w.targets ?? 'both';
      if (t !== 'both' && (t === 'air') !== air) continue;
      reach = Math.max(reach, x.w.range + armorRangeBonus(attacker));
    }
    // 一件能用的武器都没有 → 只剩撞击
    return strikeDistance(s, attacker, target) <= (reach > 0 ? reach : 1);
  }
  // 射程要按"这一发从哪打到哪"算：站丘陵上俯射多一格，往高处仰攻少一格，
  // 站在林子里连平射都被树冠吃掉一格（见 rangeModAgainst）。
  const range = effectiveRangeAgainst(s, attacker, tileUnder(s, target));
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
  return s.units.filter(
    (u) =>
      u.owner !== unit.owner &&
      canStrike(s, unit, u) &&
      // 看得见才打得到（开雾时才管）。派生的候选列表和真正的校验共用这一条，
      // 否则 AI 会提一个必被拒的动作，界面也会画一个点不动的红框。
      //
      // 这里也要过隐匿判定：藏在林子里的兵，格子看得见不等于**它**看得见。
      // 以前只查地形，能打到是因为界面压根不画它、AI 又只吃 playerView，
      // 属于"碰巧打不到"；把条件写进候选表，才是真的打不到。
      unitInSightOf(s, unit.owner, u),
  );
}

/** 射程内的敌方城市 */
export function siegeTargets(s: GameState, unit: Unit): City[] {
  // 没武器的单位连攻城列表都不该进（桥、渡船、土墙、魔龙卵），见 isArmed
  if (!canAttack(unit) || !isArmed(s, unit)) return [];
  // 城按"城市"那一层算高度（2 层）：站在台地上砸城比从谷底仰着砸多一格，
  // 和野战用同一条规则，不另开一套。
  return s.cities.filter((c) => {
    if (c.owner === unit.owner) return false;
    // 城只在地球上；月球上的部队没有城可砸。同一条"几何只看同一张图"。
    if (boardIdOf(c) !== boardIdOf(unit)) return false;
    // 废墟不用再砸：它已经没有耐久可打，接下来该做的是派兵进去
    if (c.ruined) return false;
    // 城是被"画在"地图上的（地形公开），但看不见就不能砸——见 tileVisibleTo 的说明
    if (!cityInSightOf(s, unit.owner, c)) return false;
    const d = distToCity(unit, c);
    if (d <= 0) return false;
    return d <= effectiveRangeAgainst(s, unit, tileAtOn(s, boardIdOf(c), c.x, c.y));
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
  /**
   * 装甲武器：这一发用的那件武器。
   *
   * 只在"装甲素体 + 指定了武器"时传进来；不传就是老路径，
   * `attackPowerNow` 照旧读兵种 atk —— 普通兵一行都不用改。
   */
  weapon?: WeaponProfile,
  /**
   * 这一下是溅射余波。默认 false，只有 `splashVictims` 会传 true。
   *
   * 为什么放在签名最后而不是塞进 weapon：判定它的是"怎么打出去的"，
   * 不是"用什么打的"——同一个武器当主目标打和当余波打，规则不一样。
   */
  splash = false,
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
  // 地形掩护按**挨打的那个人所在的那张图**取：月球单位站在环形山里，
  // 该拿环形山的 +2 甲，而不是地球上同一坐标那块地的掩护。
  const tile = isCity ? null : tileUnder(s, defender);
  const terrainBonus = tile && !isAirborne(s, defender) ? CONFIG.terrainDef[tile.terrain] : 0;
  const defenderAura = isCity ? { atk: 0, armor: 0, move: 0 } : auraBonusOf(s, defender);

  // 状态修正攻击力：放在最前面，后面那些乘算（射程折扣、属性倍率）才吃得到。
  // 装甲武器直接用它自己的伤害：素体 atk 只是撞击，不进这条线。
  const atkNow = weapon ? weapon.damage : attackPowerNow(s, attacker);

  // 3. 核心：真实护甲是动态读取城市的，而不是读全局表里的 0
  //    石化翻倍也在这里生效：ownArmorOf 是"自己的甲"的唯一取值口
  const actualArmor = isCity ? city.armor : ownArmorOf(s, defender);

  // 护甲百分比光环：面板（effectiveStats）里有这一段，这里也必须有——
  // 少一处就是"面板写着 12 甲、实际按 9 甲挨打"。
  const armorPctSrc = isCity ? null : allyArmorPctOf(s, defender);
  const armorBaseNow =
    actualArmor + defenderAura.armor + (armorPctSrc
      ? Math.max(1, Math.round((actualArmor + defenderAura.armor) * armorPctSrc.value))
      : 0);

  const ctx: HookCtx = {
    state: s,
    // 只读视角：`self` 会被 runBound 逐个改绑，所以必须用 getter——
    // 写成固定字段的话，第二条能力拿到的是第一个主人的那张图。
    get view() {
      return boardStateOf(this.state, this.self);
    },
    self: defender,
    foe: attacker,
    side: 'defender',
    atk: atkNow,
    armor: armorBaseNow + terrainBonus,
    damage: atkNow,
    items: [],
    isCounter,
    // 真元光环（赤炎珠）由这里注入：能力那一层不能自己查，见 HookCtx 的注释
    trueDamagePct: allyTrueDamagePctOf(s, attacker)?.value ?? 0,
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
  // 圣旗 / 护体丹：临时护甲，和面板走同一个字段
  if (!isCity && defender.buff?.armor) ctx.armor += defender.buff.armor;
  // 咒域光环
  ctx.armor -= curseAuraPenalty(s, defender);

  // 小型扩展
  for (const e of activeExpansions(s)) {
    if (e.hooks.modifyArmor) {
      ctx.armor = e.hooks.modifyArmor({
        state: s,
        attacker,
        defender,
        armor: ctx.armor,
        isCounter,
        armorOf: (x) => (x.id === defender.id ? ctx.armor : effectiveStats(s, x).armor),
        visionOf: (x) => visionOf(s, x),
      });
    }
  }

  // 百分比护甲（护体丹）：和 effectiveStats 一样，必须等扩展钩子跑完再乘。
  // 结算这条还得赶在**破甲之前**——破甲削的是"这个人本来有多少甲"，
  // 药力加成也是那部分甲的一部分。
  if (!isCity && defender.buff?.armorPct) {
    ctx.armor += buffArmorPctGain(ctx.armor, defender.buff.armorPct);
  }

  // 地图环境：护甲整除数（和 effectiveStats 同一个位置：所有加成之后、破甲之前）
  if (!isCity) {
    const hz = hazardFor(s, defender);
    if (hz) ctx.armor = hazardArmorOf(ctx.armor, hz);
  }

  // 小型扩展到破甲之前
  runBound(armorHooks, ctx, { from: ARMOR_STAGE.expanded, to: ARMOR_STAGE.pierce });

  // 武器自带的破甲：和「破甲」能力同一个阶段、同一个算法（向下取整减半）。
  // 写成扩展钩子不行——钩子不知道自己这一发用的是哪件武器。
  if (weapon?.pierce) ctx.armor = Math.floor(ctx.armor / 2);

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
        dmg = e.hooks.modifyDamage({ state: s, attacker, defender, damage: dmg, armor: ctx.armor, splash, isCounter });
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
  // 修改反击判定条件（要和真正结算那处逐条对齐，否则预览会画出一次不存在的反击）
  const counter =
    survives &&
    !hasFlagOn(s, attacker, 'noCounter') &&
    countersLeft > 0 &&
    unitInSightOf(s, defender.owner, attacker) &&
    canStrike(s, defender, attacker);

  const toAttacker = counter ? computeDamage(s, defender, attacker, true) : 0;

  let toSplash = 0;
  for (const v of splashVictims(
    s, attacker,
    { x: defender.x, y: defender.y, n: footprintOf(s, defender) },
    { excludeIds: [defender.id] },
  )) toSplash += v.dmg;

  return { toDefender, toAttacker, counter, hits: 1, toSplash };
}

/**
 * 这个单位现在的溅射半径。
 *
 * 兵种表给基数，扩展的 `modifySplash` 在它上面改（修真按境界撑大）。
 * 结算、预览、侧栏、兵种卡都走这一个函数——四处各算一遍的话，
 * 界面上写着"1 格"而实际波及 2 格，玩家只会觉得规则在骗人。
 */
export function splashRadiusOf(s: GameState, u: Unit, override?: number): number {
  // 装甲武器：溅射写在武器上，由调用方把半径传进来（素体的 splash 是 0）
  let radius = override ?? utype(s, u.type).splash ?? 0;
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
 * 这一下**实际覆盖到**的格索引：爆心 = 点中的那一格，按溅射半径铺开。
 *
 * 战况烈度的红格、出手闪烁、以及"谁挨溅射"必须用同一份格子表。
 * 以前伤害用的是"目标矩形到受害者矩形"的距离、烈度用的是"爆心到格"，
 * 2×2 的单位上两者会差一格——于是出现"红格明明盖住了他，血却一点没掉"。
 * 现在只有一个几何来源：红格盖到哪几格，就按这几格找人。
 *
 * 半径 0（没有溅射）时返回的就是爆心那一格：烈度要记"挨了一下"，
 * 但调用方得自己判"有没有溅射"，别把贴身砍的那一格当成溅射。
 */
function strikeCellsOf(
  s: GameState,
  attacker: Unit,
  rect: { x: number; y: number; n: number },
  hit?: { x?: number; y?: number },
): number[] {
  const center = pickHitCell(attacker, rect, hit);
  const radius = splashRadiusOf(s, attacker);
  const line = utype(s, attacker.type).splashLine === true;
  // 覆盖格是"格号"的集合，而格号只在某一张图里成立：地球 20 宽的一个格号，
  // 在 9 宽的月球上指向完全不同的位置。所以按攻击者那张图的宽高算。
  return strikeCoverCells(boardOf(s, boardIdOf(attacker)), attacker, center, radius, line);
}

/**
 * 溅射范围内的敌人：主目标周围的敌人各吃一份打折的伤害。
 *
 * 只打敌人，不打自己人——"炮火误伤"听起来很真实，但在回合制里
 * 它只会变成"我不敢开炮"，而不是"我要算清楚再开炮"。
 *
 * 判据只有一条：**身体占到被覆盖的任意一格**就算中弹。和棋盘上那片红是
 * 同一份格子表（`strikeCellsOf`），所以玩家看见红格盖住了谁，谁就掉血；
 * 2×2 的单位只要有任意一角在范围内就吃一份，不会因为锚点在圈外被漏掉。
 *
 * `excludeIds` 是已经被结算过的人（普攻的主目标已经吃过全额，不能再吃一份）。
 * 城市也能当爆心：传城市的矩形即可，城里站着的守军距离 0，会一起挨炸。
 */
/**
 * 溅射**波及**之后的钩子：只问开火那一方的 `onSplash`，只传被波及的人。
 *
 * 主目标不经过这里——它吃全额伤害、走 `onHit`。两条钩子分开是有意的：
 * 现有三十多个溅射兵种的毒/火都只对主目标生效，把范围并到 onHit 会一次
 * 改掉它们的平衡；而"冻住一片"这种设计又确实需要"溅射也算命中"。
 */
function runSplashHooks(s: GameState, attacker: Unit, victim: Unit, damage: number): void {
  for (const h of hooksOfUnit(s, attacker)) {
    h.onSplash?.({ state: s, attacker, victim, damage, api: abilityApi });
  }
}

function splashVictims(
  s: GameState,
  attacker: Unit,
  rect: { x: number; y: number; n: number },
  opts: { hit?: { x?: number; y?: number }; excludeIds?: readonly string[] } = {},
): Array<{ unit: Unit; dmg: number }> {
  if (splashRadiusOf(s, attacker) <= 0) return [];

  const covered = new Set(strikeCellsOf(s, attacker, rect, opts.hit));
  if (covered.size === 0) return [];

  const skip = new Set(opts.excludeIds ?? []);
  const ratio = splashRatioOf(attacker);
  const out: Array<{ unit: Unit; dmg: number }> = [];
  /*
   * 只有**同一张图**上的人会被波及。
   *
   * 覆盖格是攻击者那张图的格号；地球和月球的格号在数值上会撞（都是 0..w*h-1），
   * 不判图的话，月面上一炮"溅射"过去的会是地球上某个坐标恰好相同的人——
   * 这是接月面战斗时最容易犯、也最难查的错。
   */
  const board = boardIdOf(attacker);
  for (const v of s.units) {
    if (v.owner === attacker.owner) continue;
    if (boardIdOf(v) !== board) continue;
    if (skip.has(v.id)) continue;
    // 占到任意一格就算被覆盖：多格单位只挨一份（名单按单位去重）
    if (!tilesOfUnit(s, v).some((t) => covered.has(idxOn(s, board, t.x, t.y)))) continue;
    // 阵列：只免疫"被波及"，当主目标时那一下照吃
    if (hasFlagOn(s, v, 'immuneSplash')) continue;
    // 圣旗给的阵列是临时的，所以不能只认兵种表上的那条能力
    if (v.buff?.splashImmune) continue;
    const dmg = Math.floor(computeDamage(s, attacker, v, false, undefined, true) * ratio);
    if (dmg <= 0) continue;
    out.push({ unit: v, dmg });
  }
  return out;
}

/**
 * 这一下溅射**波及**的所有格索引（含空格、含免疫格）。
 *
 * 和 splashVictims 的分工：那个回答"谁挨打"，这个回答"地上哪几片红了"。
 * 但两边的格子表必须是同一份（都走 `strikeCellsOf`）——否则就会出现
 * "红格盖住了他、血没掉"这种各说各话。这里也就是棋盘上那片红的来源。
 */
export function splashTilesOf(s: GameState, attacker: Unit, defender: Unit): number[] {
  return strikeCellsOf(s, attacker, {
    x: defender.x,
    y: defender.y,
    n: footprintOf(s, defender),
  });
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
 * 载体被摧毁，货舱里的单位一起没。
 *
 * 不写这条会出现最糟的一种情形：船被打沉了，但船上那两个兵凭空回到了
 * 棋盘上（因为它们的对象还挂在货舱里），玩家只会觉得"这游戏算错了"。
 * 所以凡是从 s.units 里删单位的地方，载的货一并清掉。
 *
 * 载体不止船：货舱是通用机制（船、渡船、太空的发射井都带 hold）。
 * 所以文案写"载体"而不写"船"，也不必为每种载体各写一句——
 * 谁被摧毁对玩家是明摆着的，战报只需要说清**里面的人也没了**。
 */
function loseCargo(s: GameState, dead: Unit): void {
  if (!dead.cargo || dead.cargo.length === 0) return;
  const names = dead.cargo.map((u) => utype(s, u.type).name).join('、');
  pushLog(s, dead.owner, `所载单位一同损毁：${names}`, true);
}

/**
 * 记一个人头：单位自己的 `kills` + 局级 `killTally`。
 *
 * 两处都要记，因为它们回答的不是同一个问题：
 *   · `unit.kills` 是"这个兵现在有多强"（「老兵不死」每杀一人 +1 攻），
 *     它只对活着的单位有意义，所以随单位走；
 *   · `killTally` 是"这局我哪个兵种最猛"（战报卡的 MVP），
 *     死人也要算进去，所以必须落在局级状态里。
 *
 * 只认 `killer` 明确的击杀：毒死、烧死、桥塌、陷阱这些"没有凶手"的死亡
 * 不记在人头账上——它们没法归到某个兵种，硬塞给对面会让 MVP 变成
 * "谁清小兵清得多"。那些伤害由 timeline 的差分统计去管。
 */
function creditKill(s: GameState, killer: Unit): void {
  killer.kills = (killer.kills ?? 0) + 1;
  const tally = (s.killTally ??= {});
  const side = (tally[killer.owner] ??= {});
  side[killer.type] = (side[killer.type] ?? 0) + 1;
}

/**
 * 一个单位"死了"的**唯一实现**（2026-11-13 合一）。
 *
 * 死一次要做五件事，一件都不能少：
 *   1. 从 `s.units` 移除（幂等——亡语可能连带杀掉别人，同一个人不能被处理两次）；
 *   2. 写一条战报（默认写给它自己，有凶手就写给凶手）；
 *   3. 清掉货舱（船沉了，船上的人跟着没，不能凭空回到棋盘上）；
 *   4. 通知扩展 `onUnitKilled`（击杀奖励、招魂名单）；
 *   5. 跑亡语 `onDeath`（自爆、分裂、灵体化）。
 *
 * 以前这五件事在四个地方各写了一遍（普攻、溅射、反击阵亡、sweepDead），
 * 焦土更是直接 `filter`——结果"被焦土砸死的单位"不会触发它自己的亡语，
 * 连锁反应到第二代就断了，而且没人看得出为什么。
 *
 * 注意：**"死"和"清场"是两件事**。血归零只代表"待清场"，
 * 真正执行的是这里（或 `sweepDead` 批量转进来）。留出这个缝是因为
 * 「油尽灯枯」要让修士在清场前再撑一拍——玩家还有机会救他。
 *
 * ── 边界：什么该走这里，什么不该 ──────────────────────────
 *
 * 走这里 = "这个单位死了"：被打死、被毒死、被烧死、自损而亡、坐化。
 * 跟着它一起生效的有：战报、沉船、`onUnitKilled`（击杀奖励/招魂）、
 * 亡语 `onDeath`（自爆、分裂、灵体化）。
 *
 * 不走这里 = "这个单位被移除了"：遣散、投降、分裂合体、桥塌落水。
 * 这几件事没有凶手，也不该触发亡语（自爆兵掉进河里不该再炸一次）。
 */
function killUnit(s: GameState, victim: Unit, killer: Unit | undefined, logText?: string): void {
  if (!s.units.some((u) => u.id === victim.id)) return; // 幂等
  s.units = s.units.filter((u) => u.id !== victim.id);
  /*
   * 战报给谁看：有凶手就写给凶手那边；没有凶手（毒死、烧死、坐化、
   * 反击同归于尽）就写给它自己——棋盘上血条归零是公开信息，
   * 而且"我的人怎么没的"这条，防守方比谁都该看到。
   */
  pushLog(s, killer?.owner ?? victim.owner, logText ?? `${utype(s, victim.type).name} 被消灭`, true);
  loseCargo(s, victim);
  fireKilled(s, victim, killer);
}

/**
 * 换主：把一个单位交给另一方。
 *
 * ── 为什么要有唯一出口 ──────────────────────────────────────────
 *
 * "改个 `owner` 就完事"看着简单，但漏掉其中任何一条都会出一类难查的 bug：
 *   · **本回合不能再动**（`moved/acted` 置真）。不置的话策反完当场就能打，
 *     等于一个法术白赚一次行动，而且是"抢过来的兵替你出手"；
 *   · **本回合击杀额度清零**：`killExpTurn/killExpThisTurn` 是"这个回合从
 *     击杀拿了多少"的账，跟着人走会让新主人的额度被上一个人的消费卡住；
 *   · **战报写给双方**（`open = true`）：棋盘上换旗是公开信息，
 *     只写给一边会变成"我的兵突然不动了"。
 *
 * 境界、经验、寿元、学过的法术、随身丹药**一律保留**——这是 2026-11-14
 * 作者定下的口径：策反一个高期修士就该是一笔巨大的战利品。
 * 它们本来就存在单位和 `custom` 上，这里不需要搬。
 */
export function convertUnit(
  s: GameState,
  unit: Unit,
  newOwner: PlayerId,
  logText?: string,
): void {
  if (unit.owner === newOwner) return;
  const from = unit.owner;
  unit.owner = newOwner;
  unit.moved = true;
  unit.acted = true;
  if (unit.custom) {
    const rest = { ...unit.custom };
    delete rest['killExpTurn'];
    delete rest['killExpThisTurn'];
    unit.custom = rest;
  }
  pushLog(
    s,
    newOwner,
    logText ?? `${utype(s, unit.type).name} 转投 ${newOwner} 旗下（原属 ${from}）`,
    true,
  );
}

/**
 * 批量清场：把场上所有 hp ≤ 0 的单位交给 `killUnit`。
 *
 * 它是"死亡"的第二入口，不是第二套实现——里面只调 `killUnit`。
 * 谁想让尸体立刻消失，就调这个，别自己 `filter`。
 */
function sweepDead(s: GameState): void {
  // 先取快照：亡语可能在清理过程中再生出新的尸体（自爆连锁）
  for (const u of [...s.units]) {
    if (u.hp > 0) continue;
    killUnit(s, u, undefined, `${utype(s, u.type).name} 倒下了`);
  }
}

function fireKilled(s: GameState, victim: Unit, killer: Unit | undefined): void {
  // 1) 先记账：人头数进两处——单位自己的 `kills`（「老兵不死」的加成来源），
  //    以及局级的 `killTally`（战报卡的 MVP 来源，单位死了也不丢）。
  //
  // 为什么不放在各扩展里各记一遍：以前只有「老兵不死」写 `kills`，
  // 于是没开那个包的对局所有击杀数都是 0，战报卡的 MVP 永远是空的。
  // 击杀是**事实**，不是那个扩展的属性，所以归规则层管。
  if (killer) creditKill(s, killer);
  // 没有凶手（毒死、烧死、桥塌）时，两人局记在对面头上；三人以上没有"对面"
  // 这回事，就记在自己头上——宁可少给一份击杀奖励，也不能凭空发给出局的人。
  const killerOwner = killer
    ? killer.owner
    : seatsOf(s).length === 2
      ? other(victim.owner)
      : victim.owner;

  // 2) 再通知击杀方：此刻 victim 还是死前那一刻的形态。
  //
  // 先告诉世界"谁死了、死时是什么"，再处理"死后变成了什么"。
  // 亡语属于后者——它是死亡之后发生的事，不该污染死亡这件事本身。
  for (const e of activeExpansions(s)) {
    e.hooks.onUnitKilled?.({
      state: s,
      victim,
      killer,
      killerOwner,
      api: abilityApi,
      // 清场入口：扩展在钩子里打死人之后必须调它（见 KillCtx.sweepDead）
      sweepDead: () => sweepDead(s),
    });
  }

  // 3) 再执行亡语/转化（自爆、重生、分裂、灵体化）。
  //
  // 主流程只做两件通用的事：把 result 里的"要不要清场"落实下去，
  // 以及通知扩展"亡语跑完了"。清场放在这里而不是各能力里自己删，
  // 是为了避免两段能力交叉删列表、把刚分裂出来的小史莱姆一起删掉。
  const dctx: DeathCtx = {
    state: s,
    // 死在月面上的，亡语也该在月面上结算（见 ability-hooks 里 view 的契约）
    view: boardStateOf(s, victim),
    victim,
    killer,
    api: abilityApi,
    result: { blasts: 0 },
  };
  for (const h of hooksOfUnit(s, victim)) h.onDeath?.(dctx);
  // 自爆会波及旁人：这一步做完得扫一遍，把 hp 归零的清掉，
  // 否则下面的"解散/分裂"会看到一个已经死了的邻居。
  if (dctx.result.blasts > 0) sweepDead(s);
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
  // 产出看脚下那块地，而"脚下"是**它所在那张图**的那一格。
  // 现在月球上没有经济单位，但少这一层的话，以后往月面放农场就会按地球的地形结算。
  const tile = tileUnder(s, u);
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

  if ((out[GOLD] ?? 0) > 0 && adjacentToWater(s, u.x, u.y, boardIdOf(u))) {
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
 * 经济单位**如果**站在 (x,y)，每回合能收**哪些资源**。
 *
 * `unitIncomeAt` 只取金币，多资源扩展的单位（灵田、灵矿、粮仓……）用它算，
 * 每一个落点都会得出同一个数字，移动预览等于白画。和上面那个一样只临时借坐标，
 * 算完立刻还回去，整个过程同步、无副作用。
 */
export function unitYieldAt(s: GameState, u: Unit, x: number, y: number): ResourceCost {
  const ox = u.x;
  const oy = u.y;
  u.x = x;
  u.y = y;
  const yields = unitYield(s, u);
  u.x = ox;
  u.y = oy;
  return yields;
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
export function grantOpeningIncome(s: GameState, first: PlayerId = 'A'): ResourceCost {
  // 发给**先手方**，不是写死的 A：两人局现在可以选谁先动（见 MatchConfig.firstSide）
  const income = settleIncome(s, first);
  const label = Object.keys(income).length > 0 ? incomeLabel(income) : '没有收入';
  pushLog(s, first, `开局结算：第一回合收入 ${label}`);
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
  /*
   * 判据全搬到 `core/era-routes.ts` 了：路线（升到哪一级）、封顶、费用钩子、
   * 额外条件，一处解析、三处（规则/界面/AI）共用。这里只保留老签名，
   * 免得十几个调用点跟着改。
   *
   * **条件不满足时仍然返回价钱**：界面上那颗按钮要能显示"要 200 金"，
   * 点下去再由 `doUpgrade` 报出 `requires` 给的原因——先报价再解释，
   * 比把按钮变灰、什么都不说清楚要好。
   */
  const target = upgradeTargetOf(s, city);
  return target ? target.cost : null;
}

/**
 * 一座能自动开火的建筑，把**这一回合剩下的攻击次数**打光。
 *
 * 以前那套是"守方在敌人接手回合时白打一轮"，和手动开火各算各的：一座塔
 * 在自己回合点一炮、敌人回合再自动一炮，一回合等于两次火力。现在改成
 * **反应射击**——敌人踏进射程的那一刻就打，打出去的发数从 `attacksLeft`
 * 里扣。于是"自己回合手动开过两发、敌人再进来"只剩其余几发：一回合总共
 * 还是那么几次，变的只是时机，从"挨完打才还手"变成"进门就打"。
 *
 * `focus` 是刚踏进射程的那个单位：先打它，它倒了还有余弹就按老规矩
 * （最近、血最少）转火。这条口径也说得通——塔的价值在"让冲得最快的那一个
 * 先死"，而不是把伤害均匀摊给所有人。
 *
 * 返回打出的总伤害。
 */
function buildingVolley(s: GameState, b: Unit, focus?: Unit): number {
  const def = utype(s, b.type);
  let shots = attacksLeftOf(s, b);
  if (shots <= 0) return 0;

  let hits = 0;
  let totalDmg = 0;
  const hitNames = new Set<string>();
  const splashNames = new Set<string>();
  /**
   * 按"挨打的是谁家"分账：三人四人局里一座塔的射程可能同时覆盖两家，
   * 一条战报发给一边就成了漏报。
   */
  const byVictim = new Map<PlayerId, { names: Set<string>; dmg: number }>();
  const noteVictim = (u: Unit, dmg: number): void => {
    if (u.owner === b.owner) return;
    const box = byVictim.get(u.owner) ?? { names: new Set<string>(), dmg: 0 };
    box.names.add(utype(s, u.type).name);
    box.dmg += dmg;
    byVictim.set(u.owner, box);
  };

  /**
   * 这个目标能不能打：活着、在对面的图上、在射程内，而且**看得见**。
   * "看得见才打得到"那条约束手动攻击和这里共用 `unitInSightOf`——
   * 塔要是能照着自己看不见的人开火，藏在林子里的斥候在塔面前就等于没藏。
   */
  const canHit = (u: Unit): boolean =>
    u.hp > 0 &&
    u.owner !== b.owner &&
    s.units.includes(u) &&
    boardIdOf(u) === boardIdOf(b) &&
    distance(b, u) > 0 &&
    distance(b, u) <= def.range &&
    unitInSightOf(s, b.owner, u);

  const targetOf = (): Unit | null => {
    if (focus && canHit(focus)) return focus;
    let best: Unit | null = null;
    let bestD = 0;
    for (const u of s.units) {
      if (!canHit(u)) continue;
      const d = distance(b, u);
      if (!best || d < bestD || (d === bestD && u.hp < best.hp)) {
        best = u;
        bestD = d;
      }
    }
    return best;
  };

  while (shots > 0) {
    const target = targetOf();
    if (!target) break;

    const dmg = computeDamage(s, b, target);
    // `kind: 'react'`：跑批按这个标签把反应射击的输出单独记一笔
    hurtUnit(s, target, dmg, { source: b, kind: 'react' });
    totalDmg += dmg;
    hits += 1;
    shots -= 1;
    hitNames.add(utype(s, target.type).name);
    noteVictim(target, dmg);

    /*
     * 战况烈度要落到**挨打那一方**的账上、记在当前回合。
     *
     * 反应射击发生在对方的回合里：记到自己名下（`noteHeatCell`）对方看不见
     * 这片红，记到"上一回合"又会飘到一段没人看的时间轴上。
     */
    noteStrikeHeat(
      s, b,
      { x: target.x, y: target.y, n: footprintOf(s, target) },
      undefined,
      { owner: target.owner, turn: s.turn },
    );

    // 炮台/要塞也吃溅射：不然"炮"这种单位反应射击时反而比手动开炮弱
    const splashed = splashVictims(
      s, b,
      { x: target.x, y: target.y, n: footprintOf(s, target) },
      { excludeIds: [target.id] },
    );
    for (const v of splashed) {
      hurtUnit(s, v.unit, v.dmg, { source: b, kind: 'react' });
      splashNames.add(utype(s, v.unit.type).name);
      noteVictim(v.unit, v.dmg);
      if (v.unit.hp > 0) runSplashHooks(s, b, v.unit, v.dmg);
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

  // 打出去的发数留在单位身上，下个自己回合开始时由 resetUnitsFor 清掉
  b.attacksLeft = shots;
  if (hits === 0) return 0;

  const splashText = splashNames.size > 0 ? `，溅射 ${[...splashNames].join('、')}` : '';
  pushLog(
    s,
    b.owner,
    `${def.name} 反应射击${hits > 1 ? ` ${hits} 次` : ''}，对 ${[...hitNames].join('、')} 共造成 ${totalDmg} 点伤害${splashText}`,
  );
  // 挨打的一方也要有一条：不然防守方看到的是"我的兵凭空掉血"
  for (const [who, box] of byVictim) {
    pushLog(s, who, `${def.name} 对 ${[...box.names].join('、')} 开火，共造成 ${box.dmg} 点伤害`);
  }
  return totalDmg;
}

/**
 * 有单位**踏进射程**：射程内的敌方建筑立刻各打一轮。
 *
 * 触发点只有"落位"这一件事，所以走子、下船、空投、召唤、孵化、出生全都算——
 * 谁能绕开落地直接站到塔跟前，谁就白嫖了这座塔。
 *
 * ── 为什么按回合去重 ──────────────────────────────────────────────
 *
 * `reactedTurn` 记"这一回合已经触发过"。一个单位一回合只走一次，去重是为了
 * 让"走子时结算"和"动作后统一补扫"这两条路不会对同一个单位各开一轮火。
 *
 * ── 为什么要有深度上限 ────────────────────────────────────────────
 *
 * 反应射击会打死人，亡语可能又召唤一个，而召唤出来的新兵同样算"落位"。
 * 没有上限的话，一条链能在一步动作里打到底，回放都不好复现。给 6：
 * 正常局面根本到不了，真到了就说明有循环。
 */
let reactionDepth = 0;
const REACTION_MAX_DEPTH = 6;

export function reactionFireOn(s: GameState, unit: Unit): void {
  if (unit.hp <= 0 || !s.units.includes(unit)) return;
  if (unit.reactedTurn === s.turn) return;
  if (reactionDepth >= REACTION_MAX_DEPTH) return;
  unit.reactedTurn = s.turn;

  const board = boardIdOf(unit);
  const foes = s.units.filter(
    (b) =>
      b.owner !== unit.owner &&
      b.hp > 0 &&
      utype(s, b.type).autoAttack &&
      !underConstruction(b) &&
      boardIdOf(b) === board &&
      distance(b, unit) > 0 &&
      distance(b, unit) <= utype(s, b.type).range &&
      unitInSightOf(s, b.owner, unit),
  );
  if (foes.length === 0) return;

  reactionDepth += 1;
  try {
    for (const b of foes) {
      if (!s.units.includes(b) || b.hp <= 0) continue;
      if (attacksLeftOf(s, b) <= 0) continue;
      /*
       * 火力不因为"焦点死了"停下。
       *
       * 打头那一个被第一座塔解决掉之后，后面几座塔没有理由收枪——射程里
       * 还站着别人，而且那才是"集群冲锋"真正吃亏的地方：三座塔全对着
       * 同一个人开火，人一死剩下两座就白站一回合。现在每座塔各自挑
       * 自己射程内"最近、血最少"的目标（`focus` 没了自然退化成那个）。
       */
      buildingVolley(s, b, unit.hp > 0 && s.units.includes(unit) ? unit : undefined);
    }
  } finally {
    reactionDepth -= 1;
  }
  sweepDead(s);
}

/**
 * 回合开始时的"清场射击"：射程里已经站着敌人的建筑，先打一轮。
 *
 * 反应射击只认"落位"，可是敌人走过来挨了一炮之后如果**原地砍塔**，
 * 坐标不变，就再也不会触发——塔会被活活砍死而不还手。这一轮补的正是这个洞。
 *
 * 它不会让建筑多打：这一轮打掉的发数就是本回合的全部份额，剩下的要靠反应
 * 射击，而反应射击扣的是同一份 `attacksLeft`。所以"一回合 N 发"的规矩没变，
 * 变的只是"这 N 发一定会打出去，不会因为没人靠近就烂在手里"。
 */
function reactionVolleyAtTurnStart(s: GameState, owner: PlayerId): void {
  const buildings = s.units.filter(
    (u) => u.owner === owner && u.hp > 0 && utype(s, u.type).autoAttack && !underConstruction(u),
  );
  for (const b of buildings) {
    // 这一轮可能已经把塔自己打没了（连环爆），每座都重新确认一次
    if (!s.units.includes(b) || b.hp <= 0) continue;
    if (attacksLeftOf(s, b) <= 0) continue;
    buildingVolley(s, b);
  }
  sweepDead(s);
}

/**
 * 动作结束后补扫一遍"落位"。
 *
 * 走子那条路在 `doMove` 里按"踩雷 → 反应射击 → 入驻废墟"的顺序单独结算了，
 * 这里负责其余所有会把单位放到新位置的动作：下船、空投、召唤、孵化、击退、
 * 以及各扩展自己搬人的技能。判据是"id 还在、坐标变了"，站着不动的不会误触。
 */
function reactionSweep(before: GameState, after: GameState): void {
  const was = new Map<string, string>();
  for (const u of before.units) was.set(u.id, `${boardIdOf(u)}:${u.x},${u.y}`);
  for (const u of [...after.units]) {
    const now = `${boardIdOf(u)}:${u.x},${u.y}`;
    if (was.get(u.id) === now) continue;
    reactionFireOn(after, u);
  }
}

/**
 * 工地成型的收尾：桥要在这时候才变成桥面。
 *
 * 建到一半的桥如果提前通车，陆军会从一座"还不存在"的桥上走过去，
 * 而画面上的工地看起来随时会塌——先绕路，建完再通，才说得通。
 */
function finishBuild(s: GameState, u: Unit): void {
  deckBridge(s, u);
}

/**
 * 桥建成：把脚下的地形换成桥面。
 *
 * 判据来自数据里的 `buildOn`，**不写死 `water`**。以前写死 water，
 * 往沼泽上架桥会"桥立起来了、路面没变"——陆军照样按沼泽的移动力 2 走，
 * 玩家只会觉得"这桥白造了"。
 *
 * 顺手记下原地形（`custom.deckFrom`）：迷雾里要按原样还回去。
 * 全都还原成水域的话，沼泽上那座桥在看不见的时候会凭空多出一条河。
 */
function deckBridge(s: GameState, bridge: Unit): void {
  const def = utype(s, bridge.type);
  if (!def.bridges) return;
  const tile = tileAt(s, bridge.x, bridge.y);
  if (!tile || tile.terrain === 'bridge') return;
  if (!(def.buildOn ?? []).includes(tile.terrain)) return;
  bridge.custom = { ...(bridge.custom ?? {}), deckFrom: tile.terrain };
  tile.terrain = 'bridge';
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

/**
 * 这条指令是不是被"外力"挡住了（封印、眩晕、冰冻……）。
 *
 * 只问这几类**主动命令**：移动、攻击、攻城、放技能、建造、用设备。像"结束回合"
 * "上船"这种不该被一并封掉——被封印的单位总得还能放弃行动。
 *
 * 统一在动作分发之前挡一次，而不是在 doMove / doAttack 里各写一遍：
 * 漏掉一个入口就是"能走不能打"这种半封印的 bug，而且很难发现。
 */
function commandBlockedBy(s: GameState, action: Action): string | null {
  if (
    action.type !== 'MOVE' &&
    action.type !== 'ATTACK' &&
    action.type !== 'SIEGE' &&
    action.type !== 'HERO_SKILL' &&
    action.type !== 'BUILD' &&
    action.type !== 'USE_DEVICE'
  ) {
    return null;
  }
  const unit = s.units.find((x) => x.id === action.unitId);
  if (!unit) return null;
  for (const e of activeExpansions(s)) {
    const reason = e.hooks.canCommand?.({ state: s, unit });
    if (reason) return reason;
  }
  return null;
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

  const blocked = commandBlockedBy(next, action);
  if (blocked) return { ok: false, reason: blocked };

  const result: ActionResult = (() => {
    switch (action.type) {
      // 选卡动作在上面就被分流走了，类型在这里已经被排除，不用也不该再列分支
      case 'MOVE':
        return doMove(next, action.unitId, action.x, action.y);
      case 'ATTACK':
        return doAttack(next, action.unitId, action.targetId, action.x, action.y, action.weapon);
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
      // 装甲装配 / 拆卸：判定与结算都在 core/armor.ts，这里只做转发。
      // 它们直接改 next，所以成功时要自己把 state 包回来。
      case 'MOUNT': {
        const r = doMount(next, action.unitId, action.moduleId);
        return r.ok ? { ok: true, state: next } : { ok: false, reason: r.reason };
      }
      case 'UNMOUNT': {
        const r = doUnmount(next, action.unitId, action.moduleId);
        return r.ok ? { ok: true, state: next } : { ok: false, reason: r.reason };
      }
      // 设备与整备（P5）。判定与效果都在 core/armor.ts，这里只转发。
      case 'USE_DEVICE': {
        const r = doUseDevice(next, action.unitId, action.deviceId, {
          x: action.x,
          y: action.y,
          targetId: action.targetId,
        });
        return r.ok ? { ok: true, state: next } : { ok: false, reason: r.reason };
      }
      case 'RECHARGE': {
        const r = doRecharge(next, action.unitId);
        return r.ok ? { ok: true, state: next } : { ok: false, reason: r.reason };
      }
      // 航母甲板：起飞与回收。
      // 回收以前是回合开始自动做的，和「自动放飞」撞成死循环（飞机永远出不了
      // 母舰旁边那一格），现在改成玩家动作；判定仍归空军扩展那份实现。
      case 'LAUNCH': {
        const carrier = unitById(next, action.unitId);
        const ops = airwingOps();
        if (!carrier) return { ok: false, reason: '没有这艘船' };
        if (!ops?.launch) return { ok: false, reason: '这一局没有接入舰载航空兵' };
        const plane = deckOf(carrier)[0];
        if (!plane) return { ok: false, reason: '甲板是空的' };
        const r = ops.launch({ state: next, carrier, plane });
        return r.ok ? { ok: true, state: next } : { ok: false, reason: r.reason };
      }
      case 'RECOVER': {
        const carrier = unitById(next, action.unitId);
        const plane = unitById(next, action.planeId);
        const ops = airwingOps();
        if (!carrier || !plane) return { ok: false, reason: '找不到船或飞机' };
        if (!ops?.recover) return { ok: false, reason: '这一局没有接入舰载航空兵' };
        const r = ops.recover({ state: next, carrier, plane });
        return r.ok ? { ok: true, state: next } : { ok: false, reason: r.reason };
      }
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
        return doHeroSkill(next, action.unitId, action.skillId, action.targetX, action.targetY, action.input);
      case 'UNIT_ACTION':
        return doUnitAction(next, action.unitId, action.actionId);
      case 'PLACE_EGG':
        return doPlaceEgg(next, action.x, action.y);
      case 'SURRENDER':
        return doSurrender(next);
      case 'END_TURN':
        return doEndTurn(next);
    }
  })();

  if (result.ok) {
    /*
     * 反应射击补扫：走子那条路已经在 doMove 里按"踩雷 → 反应射击 → 入驻"
     * 结算过了（`reactedTurn` 会把它挡在门外），这里管其余所有"把单位放到
     * 新位置"的动作——下船、空投、召唤、孵化、击退、扩展技能搬人。
     *
     * 必须在 recordDeaths 之前：被打死的要算进这一手的战损，
     * 否则招魂读不到"本回合谁没了"，战报上也会少一截。
     */
    reactionSweep(s, result.state);
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
  /*
   * 这里刻意**不走** `killUnit`：落水不是"被击杀"——没有凶手，
   * 也不该跑亡语（一个自爆兵掉进河里不该再炸一次）。
   * "死亡"与"移除"的分界写在 killUnit 的注释里：有亡语的走前者，纯粹消失的走后者。
   */
  s.units = s.units.filter((u) => !gone.has(u.id));
}

/**
 * 留痕种类能用的那几件东西。
 *
 * 为什么不把 `pushLog` / `utype` 直接传给 kind：marks.ts 只依赖类型，
 * 一旦它 import 规则层就是循环。给一个小接口，扩展拿到的能力和
 * 兵种能力的钩子（`c.api`）是同一套语义，写起来不用换脑子。
 *
 * 雷炸出来的伤害是**物理伤害**：按目标护甲结算、不吃地形、不引发反击。
 * 地雷不跟你讲武德，但"重甲"也不该白买——踩雷和挨刀在这一点上是同一件事，
 * 区别只在于它没有攻方、不触发反击。见 `hurtPhysical`。
 */
function markApi(s: GameState): MarkApi {
  return {
    utype: (typeId) => utype(s, typeId),
    log: (owner, text, open = true) => pushLog(s, owner, text, open),
    hurt: (unit, amount, text) => {
      // 地雷也走唯一出口：它是"敌方影响"，没理由绕过转移。
      // 取整、非正数早退都交给 hurtUnit；原本那条战报作为 logText 传进去。
      hurtUnit(s, unit, amount, { logText: text });
    },
    hurtPhysical: (unit, amount, text, opts) =>
      hurtPhysical(s, unit, amount, { logText: text, pierce: opts?.pierce }),
  };
}

function doMove(s: GameState, unitId: string, x: number, y: number): ActionResult {
  const unit = unitById(s, unitId);
  if (!unit) return { ok: false, reason: '单位不存在' };
  if (unit.owner !== s.current) return { ok: false, reason: '这不是你的单位' };
  /*
   * 走子按**单位所在的那张图**结算：月球上的兵走月球的格子。
   * `st` 是只读投影，变更仍然写在真的 `s` 上（单位对象本来就是同一个）。
   */
  const st = boardStateOf(s, unit);
  if (unit.moved) return { ok: false, reason: '该单位本回合已经移动过' };
  if (!inBounds(st, x, y)) return { ok: false, reason: '目标越界' };

  const reach = reachableTiles(s, unit);
  if (!reach.has(idx(st, x, y))) return { ok: false, reason: '目标格不可达' };

  // 把到达目标格的真实消耗加进 moveSpent
  const cost = reach.get(idx(st, x, y))!;
  unit.moveSpent = (unit.moveSpent ?? 0) + cost;

  // 走进废墟 = 接管。钱要在动之前就查：走到一半发现掏不起重建费，
  // 会留下一个"已经站在城里但城市还是别人的"的中间态，很难收拾。
  const destTile = tileAt(st, x, y);
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
  // 留痕（水雷、火场）只在地球有，别的图上不查
  if (!offWorld(unit) && marksOf(s).length > 0) {
    enterTile(s, unit, markApi(s));
    // 炸死的就地清场：不清的话，下一步"入驻废墟"会由一个 0 血的单位执行
    if (unit.hp <= 0) {
      sweepDead(s);
      return { ok: true, state: s };
    }
  }

  /*
   * 站定之后才轮到炮口：先踩雷、再挨反应射击、最后才入驻废墟。
   *
   * 顺序是玩家定的，也说得出道理——
   *   · 雷是地上的东西，脚一落地就炸，跑不掉；
   *   · 塔打的是"到达"这一件事，人还没站稳就开火才是"阻击"，要是等抢完城
   *     才打，塔就成了马后炮；
   *   · 入驻是走子**成功之后**的结果，人被打死了就不该再抢下一座城。
   *
   * 没开太空包、也没造塔的局这里是一次空转（先筛建筑再判射程，都是一次遍历）。
   */
  reactionFireOn(s, unit);
  if (unit.hp <= 0 || !s.units.includes(unit)) {
    sweepDead(s);
    return { ok: true, state: s };
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
 * 攻击单位 / 攻城 / 塔自动开火共用——"打了哪儿"必须同一套几何，而且要和
 * `splashVictims` 用**同一份格表**：玩家看见红格盖住了谁，谁就该掉血。
 * 以前三处各写各的（doAttack 用了旧签名的 noteHeat、doSiege 压根没写），
 * 症状就是"打到城的这一面，整个城都红"和"溅射覆盖到的城外空地不红"。
 */
function noteStrikeHeat(
  s: GameState,
  attacker: Unit,
  rect: { x: number; y: number; n: number },
  hit?: { x?: number; y?: number },
  /**
   * 记到谁的账上、哪一回合。塔/炮台的自动开火是在**接手方回合开始**时结算的，
   * 要落到 `s.turn - 1` 才看得见，所以这里留个口子；不传就是"当前行动方打到对手"。
   */
  book?: { owner: PlayerId; turn: number },
): void {
  /*
   * 战况烈度目前**只记地球**。
   *
   * 它存的是一串格号（`heat[玩家][回合][格号]`），而格号只在某一张图里成立；
   * 界面的红格层读的也是地球那份可见格。月面往上写只会得到两类问题：
   * 和地球同号的格子互相串味，或者画在没人的地方。
   * 真要月面也显示，得先给 heat 加上"图"这一维——那是独立的一件事。
   */
  if (boardIdOf(attacker) !== EARTH) return;
  for (const i of strikeCellsOf(s, attacker, rect, hit)) {
    const { x, y } = xyOf(s, i);
    if (book) noteHeatAt(s, book.owner, book.turn, x, y);
    else noteHeatCell(s, x, y);
  }
}

function doAttack(
  s: GameState,
  unitId: string,
  targetId: string,
  hitX?: number,
  hitY?: number,
  weaponId?: string,
): ActionResult {
  const attacker = unitById(s, unitId);
  const defender = unitById(s, targetId);
  if (!attacker) return { ok: false, reason: '单位不存在' };
  if (!defender) return { ok: false, reason: '目标不存在' };
  if (attacker.owner !== s.current) return { ok: false, reason: '这不是你的单位' };
  /*
   * 原来这里是 `if (offWorld(attacker) || offWorld(defender)) 这张图还不能开火`。
   *
   * 月面战斗接上之后，那条"一刀切"换成了**同图判定**：几何（射程、溅射、
   * 地形掩护）本来就只在同一张图里有意义，跨图的两个单位哪怕坐标挨着，
   * 中间也隔着一个天空。所有几何函数都改成了按图取（`tileUnder` /
   * `strikeCellsOf` / `splashVictims` 各自认自己那张图），闸门只留这一条。
   */
  if (boardIdOf(attacker) !== boardIdOf(defender)) {
    return { ok: false, reason: '不在同一张图上，打不到' };
  }
  if (defender.owner === attacker.owner) return { ok: false, reason: '不能攻击友军' };
  if (underConstruction(attacker)) {
    return { ok: false, reason: `${utype(s, attacker.type).name} 还在施工，没装好武器` };
  }
  if (attacker.acted) return { ok: false, reason: '该单位本回合已经攻击过' };
  // 单独立一条，别让它落到下面的"目标超出射程"：桥对邻格本来就是"射程够"，
  // 走射程分支会回一句误导的话（见 isArmed）。
  if (!isArmed(s, attacker)) {
    return { ok: false, reason: `${utype(s, attacker.type).name} 没有武器，不能攻击` };
  }
  /*
   * 看得见才打得到。
   *
   * 迷雾只遮单位、不遮地形，所以"那一格是不是亮的"在界面上看得一清二楚；
   * 但规则层以前只看射程，于是可以对着自己视野外的东西开火。
   * 这条放在 `isArmed` 之后：先告诉玩家"这兵没武器"，再谈看不看得见。
   */
  if (!unitInSightOf(s, attacker.owner, defender)) {
    return { ok: false, reason: `看不见 ${utype(s, defender.type).name}（在视野外）` };
  }

  // 反击判定也要按"还手的那个人"来算距离：地面兵够不着头顶的飞行单位，
  // 就不能在被飞行单位贴脸打的时候原地还手。这里必须换成
  // strikeDistance(defender, attacker)——写成攻击方的距离，等于只限制了
  // 进攻、放过了防守，这条规则就形同虚设。
  // 装甲素体走"武器分支"：射程、伤害、溅射全看选中的那一件。
  // 普通兵 `armorFrame` 是 undefined，`wpn` 恒为 null，下面每一处都退回老路径。
  const frameDef = utype(s, attacker.type);
  const picked = frameDef.armorFrame ? resolveArmorWeapon(s, attacker, weaponId, s.turn) : null;
  if (picked && picked.kind === 'reject') return { ok: false, reason: picked.reason };
  // 拆成两个普通变量（profile / 模块 id），后面就不用跟联合类型角力
  const wpn: WeaponProfile | null = picked ? picked.w : null;
  const wpnId: string | null = picked && picked.kind === 'weapon' ? picked.moduleId : null;
  const isRam = picked?.kind === 'ram';

  if (!frameDef.armorFrame && !canStrike(s, attacker, defender)) {
    return {
      ok: false,
      // 桥现在不再是"必须贴到桥头"：这一条只在射程真的不够时才会走到。
      // 隔河能打、但只算半伤，见 computeDamage 收尾的拆桥折扣。
      reason: utype(s, defender.type).bridges
        ? '射程不够，还够不着这座桥'
        : '目标超出射程',
    };
  }

  // 装甲的射程与"能不能打空中"都写在武器上，所以绕开 canStrike 自己判一遍。
  // （canStrike 读的是兵种射程——素体只有撞击，永远 1 格。）
  if (frameDef.armorFrame && wpn) {
    const dist = strikeDistance(s, attacker, defender);
    // 「瞄准阵列」：射程 +1，只对武器生效（撞击本来就是贴脸）
    const effRange = wpn.range + (isRam ? 0 : armorRangeBonus(attacker));
    if (dist > effRange) {
      return { ok: false, reason: `目标超出射程（这${isRam ? '只能撞击' : '件武器'} ${effRange} 格）` };
    }
    const t = wpn.targets ?? 'both';
    const air = isAirborne(s, defender);
    if (t === 'air' && !air) return { ok: false, reason: '这件武器只能打空中目标' };
    if (t === 'ground' && air) return { ok: false, reason: '这件武器只能打地面目标' };
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
  let dmg = computeDamage(s, attacker, defender, false, wpn ?? undefined);
  // 移动后开火：伤害 ×0.7，装了「陀螺稳定器」就免这一条（设计 4.1 / 6.1.2）
  if (frameDef.armorFrame && wpn && attacker.moved && !hasGyro(attacker)) {
    dmg = Math.round(dmg * 0.7);
  }
  // 走唯一出口：守御阵可能把这一下接走。注意 `defender` 仍然是他，
  // 所以反击判定、命中状态、击退都还作用在他身上（只有伤害被转走）。
  hurtUnit(s, defender, dmg, { source: attacker });

  // 武器自带的状态（8 代的电磁脉冲炮 / 缓速弹）：打中了活人才能贴上。
  // 这里把"层数"当"回合数"用——状态表本来就是按剩余回合记的，
  // 多一层和久一回合在这套引擎里是同一件事（见 STATUS_REGISTRY 的 slow）。
  if (wpn?.status && defender.hp > 0) {
    abilityApi.putStatus(defender, wpn.status.id, wpn.status.stacks);
  }

    // 战况烈度：一次攻击覆盖到的所有格，纯几何
  // （主命中格 = 鼠标点的格；溅射 = 以它为圆心扩 radius 格）
  noteStrikeHeat(
    s, attacker,
    { x: defender.x, y: defender.y, n: footprintOf(s, defender) },
    { x: hitX, y: hitY },
  );

  // 溅射和上面那片红用同一份格表：红格盖住了谁，谁就掉一份。
  // 主目标已经吃过全额，按 id 排掉——他脚下那几格当然也在覆盖范围里。
  const splashed = splashVictims(
    s, attacker,
    { x: defender.x, y: defender.y, n: footprintOf(s, defender) },
    { hit: { x: hitX, y: hitY }, excludeIds: [defender.id] },
  );
  for (const v of splashed) {
    // 每个受害者单独判一次：一座守御阵可能同时替好几个人挨溅射
    hurtUnit(s, v.unit, v.dmg, { source: attacker });
    // 波及也算"命中"：寒水镜冻一片、赤炎珠熔一片都靠这里
    if (v.unit.hp > 0) runSplashHooks(s, attacker, v.unit, v.dmg);
  }

  const noCounter = hasFlagOn(s, attacker, 'noCounter');
  let counterDmg = 0;
  // 防守方的反击次数也按"一回合能攻击几次"算，第一次挨打时填满
  if (defender.countersLeft === undefined) {
    defender.countersLeft = Math.max(0, attacksPerTurn(s, defender));
  }

  // 判断是否反击：不仅要活下来、不能先手，还要反击次数 > 0
  /*
   * 工地不还手。
   *
   * `doAttack` 早就拦住了"工地主动开火"，但**挨打时的反击**走的是另一条路
   * （这里），于是半截塔楼照样能把人打一顿——建到一半的墙，凭什么有攻击力。
   * 判据和主动开火共用 `underConstruction`，不另写一套。
   */
  const canCounter =
    !noCounter &&
    defender.hp > 0 &&
    defender.countersLeft > 0 &&
    !underConstruction(defender) &&
    // 看不见的东西没法还手。挨了远程冷枪、连人影都没看见，不该凭空反击；
    // 潜行/潜航/隐身那一发之所以能白打，靠的正是这条。
    unitInSightOf(s, defender.owner, attacker) &&
    canStrike(s, defender, attacker);

  if (canCounter) {
    counterDmg = computeDamage(s, defender, attacker, true);
    // 反击也会被守御阵接走——"替友军挨打"不该挑来源
    hurtUnit(s, attacker, counterDmg, { source: defender });
    
    // 消耗一次反击机会
    defender.countersLeft -= 1; 
  }

  // 出手流程里的补充：吸血在这一步（反击之后、命中状态之前），
  // 击退在后面（命中状态之后）。同一条兵种挂了两条时按 abilities 的顺序跑。
  const sctx: StrikeCtx = {
    state: s,
    // 出手方与目标一定同图（doAttack 的门槛），取出手方那张
    view: boardStateOf(s, attacker),
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
    // 装甲：把这件武器的账记上（每回合次数、要不要冷却）
    if (frameDef.armorFrame && wpnId && wpn) {
      noteWeaponFired(attacker, wpnId, wpn, s.turn);
      // 还有别的武器能打，就把闸门重新打开。
      //
      // 不走 `modifyAttacks` 钩子，是因为那个数同时被拿去当**反击次数**
      // （`countersLeft`）——装甲一装上两门炮，挨打时就能反击两次，
      // 那是白送的战力。这里只在"自己的回合开火收尾"处重开，影响面最小。
      if (shotsLeftThisTurn(s, attacker, s.turn) > 0) {
        attacker.attacksLeft = 1;
      }
    }
    attacker.moved = true;
    
    // 次数扣完了，才算彻底行动结束
    if (attacker.attacksLeft <= 0) {
      attacker.acted = true;
    }
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
    killUnit(s, defender, attacker, `${dfName} 被消灭`);
    // 收割（刺客大师）：亲手斩掉一个，本回合的移动力就还回来。
    //
    // 只还移动、不还攻击。攻击次数由 acted 管着，这里刻意不碰——
    // "杀完再走一步"是脱战，而"杀完再砍一刀"是另一档强度，不在这个技能里。
    // 死在反击里的情况（attacker.hp <= 0）不给：人都倒了，走给谁看。
    if (attacker.hp > 0 && s.units.some((u) => u.id === attacker.id)) {
      const kctx: KillCtx = {
        state: s,
        view: boardStateOf(s, attacker),
        self: attacker,
        victim: defender,
        api: abilityApi,
        result: { moveBack: false },
      };
      for (const h of hooksOfUnit(s, attacker)) h.onKill?.(kctx);
      if (kctx.result.moveBack) {
        attacker.moved = false;
        pushLog(s, attacker.owner, `${atName} 斩杀得手，本回合还能再走一次`);
      }
    }
  }

  // 溅射打死的也走同一个出口（战报 / 沉船 / 亡语 / 击杀钩子都在里面）
  for (const v of splashed) {
    if (v.unit.hp > 0) continue;
    killUnit(s, v.unit, attacker, `${utype(s, v.unit.type).name} 被炮火波及消灭`);
  }
  if (attacker.hp <= 0) {
    killUnit(s, attacker, undefined, `${atName} 在反击中阵亡`);
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
  if (boardIdOf(attacker) !== boardIdOf(city)) return { ok: false, reason: '不在同一张图上，够不着这座城' };
  if (city.owner === attacker.owner) return { ok: false, reason: '不能攻击自己的城市' };
  if (city.ruined) return { ok: false, reason: '这已经是废墟了，派兵入驻才能接管' };
  if (attacker.acted) return { ok: false, reason: '该单位本回合已经攻击过' };
  // 和野战同理：没武器的单位不能攻城。否则桥会对着邻格的城市"攻城"，
  // 打 0 点、白吃一回合，还往战报里写"木桥 攻城，但打不动这座城的城墙"。
  if (!isArmed(s, attacker)) {
    return { ok: false, reason: `${utype(s, attacker.type).name} 没有武器，不能攻城` };
  }

  if (attacker.attacksLeft === undefined) {
    attacker.attacksLeft = Math.max(1, attacksPerTurn(s, attacker));
  }
  if (attacker.attacksLeft <= 0) {
    return { ok: false, reason: '该单位本回合没有剩余攻击次数' };
  }
  
  // 城市永远画在地图上（地形是公开的），但那不等于"你看得见它"。
  // 不判这一条，就会出现"整片雾里凭空砸城墙"。
  if (!cityInSightOf(s, attacker.owner, city)) {
    return { ok: false, reason: '看不见那座城（在视野外）' };
  }
  const dist = distToCity(attacker, city);
  if (dist > effectiveRangeAgainst(s, attacker, tileAtOn(s, boardIdOf(city), city.x, city.y))) {
    return { ok: false, reason: '城市超出射程' };
  }

  const atName = utype(s, attacker.type).name;
  const dmg = damageToCity(attacker, city, s);
  city.hp -= dmg; // hp-exempt: 城市不是 Unit，hurtUnit 收不了它（城墙有自己的护甲公式）

  /*
   * 溅射：炮火砸在城墙上，附近挨得近的敌兵一样吃一份。
   *
   * 以前这里只扣城的耐久，于是玩家看到的是"红格把城外那圈盖住了，
   * 旁边的人一点血没掉"——红格和伤害各算各的。现在两边共用
   * `strikeCellsOf`：爆心就是点中的那一格，红格盖到哪几格就按哪几格找人。
   *
   * 城里站着的守军距离是 0，一起挨；打谁不打谁全交给 `splashVictims`，
   * 攻城这条路不再自己判一遍。
   */
  const splashed = splashVictims(
    s, attacker,
    { x: city.x, y: city.y, n: city.size },
    { hit: { x: hitX, y: hitY } },
  );
  for (const v of splashed) {
    hurtUnit(s, v.unit, v.dmg, { source: attacker });
    if (v.unit.hp > 0) runSplashHooks(s, attacker, v.unit, v.dmg);
  }

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

  const splashText =
    splashed.length > 0
      ? `，溅射 ${splashed.map((v) => utype(s, v.unit.type).name).join('、')}`
      : '';
  pushLog(
    s,
    attacker.owner,
    dmg > 0
      ? `${atName} 攻城，城市损失 ${dmg} 点耐久${loot > 0 ? `，顺手偷走 ${loot} 金` : ''}${splashText}`
      : `${atName} 攻城，但打不动这座城的城墙${splashText}`,
  );

  /*
   * 被波及的一方也要有一条：不然他那边看到的是"城里挨了一下，我营长凭空少了 30 血"。
   * 和 doAttack 同一个口径——只写"被谁打的、掉了多少"，不写袭击者站哪；
   * 隐匿中的袭击者连名字都不给。
   */
  if (splashed.length > 0) {
    const byOwner = new Map<PlayerId, string[]>();
    for (const v of splashed) {
      const list = byOwner.get(v.unit.owner) ?? [];
      list.push(utype(s, v.unit.type).name);
      byOwner.set(v.unit.owner, list);
    }
    for (const [owner, names] of byOwner) {
      const unseen = isHiddenFrom(s, attacker, owner);
      pushLog(s, owner, `${unseen ? '视野外的一击' : atName} 攻城，炮火波及 ${names.join('、')}`);
    }
  }

  // 溅射打死的要走完整善后：删人、战报、沉船、击杀钩子。
  // 少这一段就会留下"血量 0 还站在场上"的兵——收口到 hurtUnit 时踩过这个坑。
  for (const v of splashed) {
    if (v.unit.hp > 0) continue;
    killUnit(s, v.unit, attacker, `${utype(s, v.unit.type).name} 被炮火波及消灭`);
  }

  attacker.attacksLeft = Math.max(0, (attacker.attacksLeft ?? 1) - 1);
  attacker.moved = true;
  if (attacker.attacksLeft <= 0) {
    attacker.acted = true;
  }

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

  /*
   * 不再拦"非地球"。装卸本来就是"两个同图单位贴身"，那张图是什么无所谓：
   * 月面基地补给、空间站对接都要走这条。跨图由下面那条同图判定挡住，
   * 那才是真正要防的错（坐标再近也隔着一个天空）。
   */
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
  if (boardIdOf(cargo) !== boardIdOf(ferry)) return { ok: false, reason: '不在同一张图上，装不上' };
  /*
   * 贴身判据按**占地**算，不是按锚点。
   *
   * 2×2 的载具（航母、发射井）锚点在左上角，站在它右下角旁边时锚点距离是 3：
   * 画面上两个人明明挨着，规则却说"要贴着船"。这和建造距离那次是同一个坑
   * （见 buildSiteError 里"整块地到工匠最近一格"）。
   */
  if (distBetweenUnits(s, ferry, cargo) !== 1) return { ok: false, reason: '要贴着船才能上船' };

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

  /*
   * 落点判定全部按**船所在的那张图**：越界、占地、能不能站，都是那张图的格子。
   * 以前这里读的是地球的格子表，在月球/空间站上下船会拿到"地球上同一坐标"
   * 的地形——一个明明能站的地方被说成上不了岸，反过来也成立。
   */
  const view = boardStateOf(s, ferry);
  if (!inBounds(view, x, y)) return { ok: false, reason: '目标越界' };
  if (distToUnit(view, { x, y }, ferry) !== 1) return { ok: false, reason: '只能在船边一格下船' };
  if (unitAt(view, x, y)) return { ok: false, reason: '那一格已经有人了' };
  if (blockedFor(view, x, y, cargo)) return { ok: false, reason: '那里上不了岸' };

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

  /*
   * 盖房子也要看时代：二代的工匠修不了四代的造船厂。
   *
   * 2026-11-08 删掉"军工供货"之前，这条是被顺手挡住的——早修起来也造不出东西，
   * 于是"落成即废"那一关把它拒了。现在产兵建筑按**自己的时代**产出，
   * 二代修出来的造船厂直接能下四代的船，一步跨两个时代。所以必须显式拦。
   *
   * 判据用**建造者自己的时代**而不是城市的时代：这样整条链只有"时代"一个概念
   * （营按自己的时代出兵，工兵按自己的时代盖房），不重新引入对后方城市的依赖。
   */
  const builderDef = utype(s, builder.type);
  if (def.era > builderDef.era) {
    return `${def.name}要「${eraDef(def.era).name}」的工匠才修得起来`;
  }

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

  // 邻里要求：军营的"必须临水"、炼丹炉的"山边或灵田边"都走这一条。
  //
  // 占地的每一格**连同它自己的四邻**一起看：2×2 的建筑可能一半压在山脊上、
  // 一半落在平地，只扫外圈会把"山就在房子底下"漏掉，而玩家看到的是
  // "我这炉子明明靠着山"。军营不受影响——它的 buildOn 本来就禁止建在水上。
  //
  // 判据必须走 adjacentRequirementOf，**不要**在这里再写一遍 `terrain === 'water'`。
  // 以前就是各写一份：界面上的建造高亮用 `adjacentToWater`（它把桥面也算水面），
  // 这里只认 `water`，于是"在桥头扎营"会被高亮成可建、点下去才回一句"必须扎在水边"。
  const adjacent = adjacentRequirementOf(def);
  if (adjacent && !adjacentSatisfied(s, x, y, n, adjacent, builder.owner)) {
    return `${def.name}${adjacentRequirementText(def, (id) => s.unitTypes[id]?.name ?? id)}`;
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
  //
  // 2×2 的建筑按**整块地到建造者的最近一格**算，不是按左上角锚点：
  // 锚点算法下，贴着它右下角站也会被拒（"离得太远"），玩家没法从画面推出规则。
  // n = 1 时这个式子和 `distance(builder, {x,y})` 完全一样。
  const reach = def.buildRange ?? CONFIG.buildRange;
  const cx = Math.min(Math.max(builder.x, x), x + n - 1);
  const cy = Math.min(Math.max(builder.y, y), y + n - 1);
  const gap = Math.abs(builder.x - cx) + Math.abs(builder.y - cy);
  if (gap > reach && !(overWater && bridgeChainOk(builder, x, y, s))) {
    return overWater
      ? `建造者离得太远（最多 ${reach} 格；桥可以沿已有的桥面再往外接两节）`
      : `建造者离得太远（最多 ${reach} 格）`;
  }

  /*
   * 扩展自己的上限（每颗星球每方一座接驳站这类）。
   *
   * 放最后：通用条件先给出更基础的理由（"离得太远"比"已经有一座了"更该先说）。
   * 传进来的 `s` 已经是**建造者那张图**的投影，所以扩展可以直接数
   * `state.units`——那就是这颗星球上的全部东西。
   */
  for (const e of activeExpansions(s)) {
    const reason = e.hooks.buildProblem?.({
      state: s,
      player: builder.owner,
      typeId: def.id,
      x,
      y,
    });
    if (reason) return reason;
  }

  return null;
}

/**
 * 对一个 n×n 块里的每一格做一次判断，任一成立就返回 true。
 *
 * 选址里"临水""是不是全是陆地"这类条件说的都是整块地，不是锚点那一格。
 */
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
  /*
   * 施工按**建造者所在的那张图**结算：月面上的工程队盖的是月面的格子。
   * `st` 是只读投影，真正的变更（扣钱、落单位）仍然写在 `s` 上。
   */
  const st = boardStateOf(s, builder);

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
   * 产兵建筑按**自己的档位**出兵（见 doRecruit 的 camp 分支），所以"建起来之后
   * 有没有东西可造"完全由它的白名单和自己的时代决定，与后方城市无关。
   * 带白名单的产兵点如果白名单里全是更高代的东西，修好也是一块石头——
   * 玩家花了 460 金买到一块石头，而界面上不会告诉他这一点。
   *
   * 判据放在这里而不是各个包里：包只管数据，规则管"这笔钱花得对不对"。
   * 军营不受影响——它的白名单是空的，什么时代落成都能出那一代的兵。
   */
  const usable = produceUsableCount(def, s.unitTypes, def.era);
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
  const site = st.units.find(
    (u) =>
      u.type === def.id &&
      u.owner === s.current &&
      underConstruction(u) &&
      coversTile(st, u, x, y),
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
      delete site.buildDone;
      delete site.buildNeed;
      delete site.buildRate;
      deckBridge(s, site);
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

  const problem = buildSiteError(st, def, builder, x, y);
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
    ...(unfinished ? { buildDone: done, buildNeed: need, buildRate: power } : {}),
    // 在月球上盖的就留在月球上（地球建筑没有这个字段 = 缺省地球）
    ...(boardIdOf(builder) === EARTH ? {} : { board: boardIdOf(builder) }),
  });

  // 桥建成才把那一格换成桥面：工地桥不许提前通车（船也要先绕）
  if (def.bridges && !unfinished) {
    const built = s.units[s.units.length - 1];
    if (built) deckBridge(s, built);
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

  const target = upgradeTargetOf(s, city);
  const cost = target ? target.cost : null;
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

  // 路线上的额外条件（`requires`）。放在钱之前：钱不够是"再攒攒"，
  // 条件不满足是"这条路现在走不了"，两者的下一步动作不一样。
  if (target!.blocked) return { ok: false, reason: target!.blocked };

  const player = s.players[s.current];
  if (player.gold < cost) return { ok: false, reason: `金币不足（需要 ${cost}）` };

  const from = eraDef(city.era);
  // 目标时代来自路线，不是 `era + 1`：路线允许跳级或指向别的分支
  const to = target!.era;

  player.gold -= cost;
  city.era = target!.edge.to;

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

/**
 * 这个产兵点能不能造这个兵——**唯一**的判据。
 *
 * 以前它散在三处：`doRecruit` 问白名单、面板问白名单、AI 一次都不问。
 * 于是"AI 在船坞里点了一条民兵"这种动作能被提出来，执行时被规则层拒掉，
 * 一整回合就白扔了。加到第三条判据（产地条件）之后，三处各写一遍必然跑偏，
 * 所以收成一条链，谁都只问它：
 *
 *   1. 建筑要用建造单位去盖，召唤物只认召唤者；
 *   2. `campOnly` —— 城市造不了，只能出自产兵建筑；
 *   3. 产兵建筑的白名单（`produce.units`）；
 *   4. 时代：产兵建筑按**自己**的时代，城市按自己的时代；
 *   5. 选卡名单（`canUseType`）；
 *   6. 产地条件：`produceNear`（贴着指定地形/单位）与扩展钩子 `produceBlocked`。
 *
 * 出兵格不在这里判：那是"站在哪儿"的问题（见 recruitSpawnCells），
 * 和"能不能造"分开，否则一座四邻全堵的营会让整条产线显示成"不能造"。
 */
export function produceAt(
  s: GameState,
  source: ProduceSource,
  target: UnitTypeDef,
): { ok: true } | { ok: false; reason: string } {
  if (target.category === 'building') {
    return { ok: false, reason: '建筑要在野外选址修建，不能从产兵点生产' };
  }
  if (target.summonedOnly) {
    return { ok: false, reason: `${target.name} 只能被召唤出来` };
  }

  const owner = source.kind === 'city' ? source.city.owner : source.camp.owner;
  const era = source.kind === 'city' ? source.city.era : utype(s, source.camp.type).era;

  if (source.kind === 'city') {
    // 城市是不设限的产兵点，所以"只能由产兵建筑造"的东西要在这里显式挡掉
    if (target.campOnly) {
      return { ok: false, reason: `${target.name} 只能由产兵建筑造，城市产线不供` };
    }
  } else {
    const campDef = utype(s, source.camp.type);
    const allowed = canProduce(campDef, target);
    if (!allowed.ok) return allowed;

    // 产地条件：贴着某些地形/单位才造得出来（炼器炉挨森林出木器那一类）。
    //
    // 支持**数组**（任一满足）：青木剑要的"相邻森林 或 2 块灵田"就是两条并列。
    // 单条 spec 里的 `count` 是"至少几个"，所以第二块灵田那条写 count: 2。
    const near = target.produceNear;
    if (near) {
      const specs = Array.isArray(near) ? near : [near];
      const n = footprintOf(s, source.camp);
      const ok = specs.some((sp) =>
        adjacentSatisfied(s, source.camp.x, source.camp.y, n, sp, owner),
      );
      if (!ok) {
        const need = specs
          .map((sp) => nearSpecText(sp, (id) => s.unitTypes[id]?.name ?? id))
          .join('，或 ');
        return { ok: false, reason: `${target.name}要在${need}旁边才造得出来` };
      }
    }
  }

  if (!eraWindowOk(s, target, era)) {
    return { ok: false, reason: `${target.name} 需要「${eraDef(target.era).name}」时代` };
  }
  if (!canUseType(s, owner, target.id)) {
    return { ok: false, reason: `${target.name} 不在本局选用的名单里` };
  }

  // 扩展的逃生口：境界、资源、周围要站某个人……数据说不清的都走这里。
  // 返回字符串 = 不能造，字符串本身是给玩家看的理由。
  for (const e of activeExpansions(s)) {
    const reason = e.hooks.produceBlocked?.({ state: s, source, target });
    if (reason) return { ok: false, reason };
  }

  return { ok: true };
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
  // 建筑 / 召唤物 / 名单 / 时代 / 产地这些统一走下面的 produceAt，这里只补它管不到的。
  // 装甲素体：造它之前先看供电余量。
  //
  // 为什么卡在"造"而不是"装"：只在装配时校验的话，"先囤十台光素体、等电站盖好
  // 再一次性装满"就绕开了上限——那正是这个机制唯一想防的事。素体本身也有 draw，
  // 所以"造出来"就该占额度。
  if (def.armorFrame) {
    const rep = energyReport(s, s.current);
    if (rep.headroom < (def.draw ?? 0)) {
      return {
        ok: false,
        reason: `供电不足：${def.name} 要 ${def.draw ?? 0} 点，余量只有 ${Math.max(0, rep.headroom)}`,
      };
    }
  }
  // 英雄：同一方场上只能有一个。这条在这里拦，是因为界面和 AI 两边的
  // 候选人列表都只是"能造什么"，管不了"已经有一个了"。
  // 「一个」也包括还没孵出来的那只（不死鸟的蛋），见 heroBlocked。
  // 其余"能不能造"（建筑/召唤物/campOnly/白名单/时代/选卡/产地）统一走 produceAt。
  const blocked = heroBlocked(s, s.current, def);
  if (blocked) return { ok: false, reason: blocked };

  /** 这个产兵点叫什么、能往哪些格子出兵 */
  let label = '';
  /** 产兵点的造价倍率（produce.costScale）。城市永远是 1 */
  let costScale = 1;
  let slots: Array<{ x: number; y: number }> = [];
  /**
   * 这次"从哪儿造"。往下传给 recruitPriceOf，扩展才能按产地定不同的价
   * （修真包的宗门：同一件修士，城里卖金币，宗门里卖灵石）。
   */
  let priceSource: ProduceSource | undefined;

  if (campId) {
    const camp = unitById(s, campId);
    if (!camp) return { ok: false, reason: '产兵点不存在' };
    const campDef = utype(s, camp.type);
    if (!isProducer(campDef)) return { ok: false, reason: '这不是产兵建筑' };
    if (underConstruction(camp)) return { ok: false, reason: `${campDef.name} 还在施工，营门都没立起来` };
    if (camp.owner !== s.current) return { ok: false, reason: '这不是你的产兵建筑' };

    // 白名单 + 产地条件 + 时代，一处判完（和面板、AI 是同一个函数）
    const allowed = produceAt(s, { kind: 'camp', camp }, def);
    if (!allowed.ok) return allowed;
    const wait = produceCooldownLeft(s, camp, campDef);
    if (wait > 0) {
      return { ok: false, reason: `${campDef.name}刚产出一批，还要 ${wait} 回合才能再产` };
    }
    costScale = produceCostScale(campDef);

    // 产兵建筑按**自己的时代**出兵：想要新时代的兵，就在新地方再扎一座营，
    // 或者直接把旧营拆了重盖。它不再跟随后方城市的时代（那是 2026-10-27 的
    // "军工供货"设计，2026-11-08 删掉了——同一座营的产出能力不该被十几格外
    // 某座城是否升级决定，玩家看不见这条因果）。
    label = campDef.name;
    priceSource = { kind: 'camp', camp };

    slots = recruitSpawnCells(s, undefined, campId, unitTypeId);
  } else {
    const city = cityId ? cityById(s, cityId) : undefined;
    if (!city) return { ok: false, reason: '城市不存在' };
    if (city.owner !== s.current) return { ok: false, reason: '只能在自己的城市产兵' };
    label = cityName(city);
    if (city.ruined) {
      return { ok: false, reason: '这座城市已成废墟，先派兵入驻接管' };
    }
    if (city.capturedTurn === s.turn) {
      return { ok: false, reason: `${label}刚被打下来，本回合还没恢复生产` };
    }

    const allowed = produceAt(s, { kind: 'city', city }, def);
    if (!allowed.ok) return allowed;

    slots = recruitSpawnCells(s, cityId, undefined, unitTypeId);
    priceSource = { kind: 'city', city };
    // 水军没有下水的位置时要说清原因：城不临水，还是水面已经站满了船
    if (def.domain === 'water' && slots.length === 0) {
      return { ok: false, reason: '这座城市不临水（或水面已被占），造不了船' };
    }
  }

  const player = s.players[s.current];

  // 英雄解锁：只在第一次招它时收，之后这个兵种就永久开放。
  // 记在 state 里而不是兵种表里——兵种表是全局限定的，
  // 我解锁了天使不该等于对手也解锁了天使。
  //
  // 这笔钱和兵价一起从 recruitPriceOf 出来：界面上的估价、AI 的采购判断
  // 用的都是同一份口径，否则会出现"面板说够、执行时不够"的空转。
  const quote = recruitPriceOf(s, s.current, def, priceSource);
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
    // 出生回合：技能那条路靠它挡"刚造出来就放大招"
    // （走位和攻击看上面两个 true，技能不查它们，所以得单独记）
    bornTurn: s.turn,
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

    /*
     * 这一回合已经放过技能、而这个技能不能连发 —— 现在按下去只会被
     * `doHeroSkill` 拒掉，按钮就不该还亮着。
     *
     * 判据必须和那边那句 `if (!skill.multiCast && u.skillTurn === s.turn)` 完全一致：
     * `multiCast: false` 和"根本不写这个字段"是同一件事（都是 falsy）。
     * 以前这里漏了这一段，于是不能连发的技能放过一次之后仍然显示"就绪"，
     * 点下去却报"这一回合已经放过技能"——按钮和规则各说各话。
     */
    if (ready && !k.multiCast && u.skillTurn === s.turn) {
      ready = false;
      notReadyReason = '这一回合已经放过技能';
    }

    /*
     * 刚上场的单位这一回合不能放技能。
     *
     * 新单位由 `makeUnit` 写成 `moved: true, acted: true`，所以"不能走、不能打"
     * 本来就是成立的；但技能这条路不查那两个字段，于是刚招出来的英雄
     * 当回合就能放大招——等于一次招募买到"上场 + 一记技能"。
     *
     * 判据用自带的 `bornTurn`（详见 types.ts 那段），文案要和 `doHeroSkill`
     * 里那句一字不差，否则又会出现"按钮亮着、点下去被拒"。
     */
    if (ready && u.bornTurn === s.turn) {
      ready = false;
      notReadyReason = '未就绪';
    }

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
  // 两格以内（2026-10-31 从"相邻一格"放宽）：混战里贴身的四格基本是满的。
  // 落点按**施法者所在的那张图**找：月球上招魂，不该站起来一个地球单位。
  const view = boardStateOf(c.state, c.self);
  const spot = freeSpotWithin(view, c.self, pick.type, 2);
  if (!spot) {
    c.result.ok = false;
    c.result.reason = '两格内没有能站起来的空地';
    return;
  }
  payRes(me, cost);
  c.api.spawn(c.state, owner, pick.type, spot.x, spot.y, boardIdOf(c.self));
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
 * 陨卵能落在哪些格：切比雪夫半径 `reach` 内、棋盘里、那一格放得下蛋。
 *
 * `blast` 给了就再多筛一层"砸得到人"——界面高亮用这个口径。
 * 一处口径给两个消费者（界面高亮 / 效果实现兜底），避免"高亮了点下去说不行"。
 */
export function eggDropCells(
  s: GameState,
  self: Unit,
  reach: number,
  blast?: number,
  eggType = 'dragon-egg',
): Array<{ x: number; y: number }> {
  const foes =
    blast === undefined
      ? []
      : s.units.filter((u) => u.owner !== self.owner && u.hp > 0);
  const out: Array<{ x: number; y: number }> = [];
  for (let dy = -reach; dy <= reach; dy += 1) {
    for (let dx = -reach; dx <= reach; dx += 1) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) > reach) continue;
      const x = self.x + dx;
      const y = self.y + dy;
      if (!canStandAt(s, x, y, eggType)) continue;
      if (blast !== undefined) {
        const hits = foes.some((f) => Math.max(Math.abs(f.x - x), Math.abs(f.y - y)) <= blast);
        if (!hits) continue;
      }
      out.push({ x, y });
    }
  }
  return out;
}

// 界面：把"能落蛋"的格子高亮出来（选点类技能的统一入口）。
// 2026-11-10 起不再筛"砸得到人"——点空地也能放蛋，高亮就得跟着放宽，
// 否则玩家会遇到"这一格能用却没亮"的反向挫败。
registerSkillTargetCells('dragon-egg', ({ view, self, skill }) =>
  // 落点按**施法者那张图**算：月面上放蛋，能点的格子是月球那一片
  eggDropCells(view, self, skill.radius ?? 11, undefined, 'dragon-egg'),
);

/**
 * 陨卵（邪龙王）：在超大范围内落下一枚魔龙卵，落点周围吃一发暗属性魔法。
 *
 * 落点**由玩家选**（技能声明了 `targeting: 'point'`，界面会把合法格子高亮，
 * 点哪格就落哪格）。只有一种情况会退回自动挑：`c.target` 没传——
 * AI 走这条（它不需要"看一眼再决定"的操作节奏），旧复盘也走这条，
 * 所以老录像仍然能一模一样地重放。
 *
 * 自动挑的规则沿用原来的：按"这一发能打出最多伤害"选——先算每个可站格子里
 * 能覆盖到多少敌人、各吃多少，再挑总和最高的那个；并列时取扫描顺序里的第一个
 * （左上到右下），和改动前逐字一致，旧复盘才能重放成一模一样。
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
  // 落点、遮挡、能砸到谁，全都按**施法者那张图**看：月球上放的卵不该去砸地球的人
  const view = boardStateOf(c.state, c.self);
  const foes = view.units.filter((u) => u.owner !== c.self.owner && u.hp > 0);

  /*
   * 玩家能点的格子 = 射程内放得下蛋的格子，**不要求周围有敌人**（2026-11-10）。
   *
   * 以前这里把"砸得到人"当合法性的一部分，于是想往空地上放蛋（等两回合后
   * 孵出一条龙、当筹码用）会被回一句"那一格周围没有敌人"。卵本身是战力，
   * 不是只能当陨石——所以合法性只看"落得下"，伤害交给下面那一段自己算：
   * 一个都没砸到就写"这一下没砸到人"。
   */
  const spots = eggDropCells(view, c.self, reach, undefined, eggType);
  if (spots.length === 0) {
    c.result.ok = false;
    c.result.reason = `陨卵只能落在 ${reach} 格内的空地上`;
    return;
  }

  let best: { x: number; y: number } | null = null;
  if (c.target) {
    const hit = spots.find((p) => p.x === c.target!.x && p.y === c.target!.y);
    if (!hit) {
      c.result.ok = false;
      // 两种失败要分开说：射程外 / 那一格放不下
      const inReach =
        Math.max(Math.abs(c.target.x - c.self.x), Math.abs(c.target.y - c.self.y)) <= reach;
      c.result.reason = !inReach
        ? `陨卵只能落在 ${reach} 格内`
        : '那一格放不下魔龙卵';
      return;
    }
    best = hit;
  } else {
    /*
     * 自动挑（AI / 旧复盘）：口径**故意不跟着放宽**——AI 只有当这一发能伤到人
     * 才算"值得放"，而且老录像要能逐字重放（当年就是在"砸得到人"的格子里挑的）。
     * 玩家手动点空地的自由不影响这条。
     */
    const legal = eggDropCells(view, c.self, reach, blast, eggType);
    let bestScore = -1;
    for (const p of legal) {
      let score = 0;
      for (const f of foes) {
        if (Math.max(Math.abs(f.x - p.x), Math.abs(f.y - p.y)) > blast) continue;
        score += magicDamageOf(c.state, c.self, f);
      }
      if (score > bestScore) {
        bestScore = score;
        best = p;
      }
    }
    // 和旧行为对齐：自动挑的时候，"砸下去一个人都伤不到"不算找到落点。
    // （手动选点不套这一条——玩家点的那一格，地是他自己挑的。）
    if (bestScore <= 0) best = null;
  }
  if (!best) {
    c.result.ok = false;
    c.result.reason = '没有能砸到敌人的落点';
    return;
  }

  c.api.spawn(c.state, c.self.owner, eggType, best.x, best.y, boardIdOf(c.self));
  let hit = 0;
  let dealt = 0;
  for (const f of foes) {
    if (Math.max(Math.abs(f.x - best.x), Math.abs(f.y - best.y)) > blast) continue;
    const fd = utype(c.state, f.type);
    const raw = magicDamageOf(c.state, c.self, f);
    const dmg = Math.max(0, Math.round(applyElementMul(raw, 'dark', fd.weak, fd.resist)));
    if (dmg <= 0) continue;
    // 扩展技能的直伤也算"敌人打过来的伤害"，走唯一出口才能被守御阵接走
    hurtUnit(c.state, f, dmg, { source: c.self });
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

/**
 * 扩展自定义的单位操作（`UNIT_ACTION`）。
 *
 * 核心只做三件事：认人、确认是谁的回合、把 `actionId` 原样交给扩展。
 * "能不能学、学了扣什么、写不写战报"全在扩展的 `onUnitAction` 里——
 * 规则层对它一无所知，所以加一类新操作（遗忘法术、宗门传功）不用回来改这里。
 *
 * 没有扩展声明 `unitActions` 时直接拒绝：否则一个手搓的回放文件能往状态里
 * 塞任意 actionId，虽然什么都不会发生，但也会让"这一步为什么无效"无从查起。
 */
function doUnitAction(s: GameState, unitId: string, actionId: string): ActionResult {
  const u = s.units.find((x) => x.id === unitId);
  if (!u) return { ok: false, reason: '这里已经没有这个单位了' };
  if (u.owner !== s.current) return { ok: false, reason: '只能给自己人下命令' };

  /*
   * **谁列出了这个按钮，就由谁执行**。
   *
   * 以前是"取第一个声明了 unitActions 的扩展"——那时候只有一个修真包，
   * 写成 find 也能跑。现在太空包也挂上了单位动作，而它在扩展表里排在
   * 修真之前：照旧写法，修真的学法术/炼丹药会被太空包一口回绝，
   * 而报错会是"认不出这个操作"——一个跟玩家操作毫无关系的错。
   *
   * 所以判据从"谁先声明"改成"谁认领"：先问每个扩展的 `unitActions`
   * 有没有这个 id，有才把动作交给它。按钮和处理器因此永远成对出现，
   * 也不会因为扩展顺序不同而行为不同（联机时两端顺序必须一致）。
   */
  const impls = activeExpansions(s).filter((e) => e.hooks.onUnitAction && e.hooks.unitActions);
  const impl = impls.find((e) =>
    (e.hooks.unitActions!({ state: s, unit: u, viewer: u.owner }) ?? []).some((o) => o.id === actionId),
  );
  if (!impl) return { ok: false, reason: '当前规则里没有这种操作' };
  const reason = impl.hooks.onUnitAction!({ state: s, unit: u, actionId });
  if (reason) return { ok: false, reason };
  return { ok: true, state: s };
}

function doHeroSkill(
  s: GameState,
  unitId: string,
  skillId: string,
  targetX?: number,
  targetY?: number,
  input?: string,
): ActionResult {
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

  // 刚上场的单位这一回合不能放技能（和 `heroSkillsOf` 里那条逐字对应）。
  // 招募出来的英雄以前当回合就能放大招：一次花钱买到"上场 + 技能"，
  // 而且对手算不出这笔账。
  if (u.bornTurn === s.turn) {
    return { ok: false, reason: '未就绪' };
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

  /*
   * 要输入却没输入：**在动手之前**拒掉。
   *
   * 不在这里挡的话，法术会带着 `undefined` 跑到结算里——钉头七箭书会把
   * `Number('') = 0` 当成"猜年龄 0"，玩家看到的是"我明明没填，它却说我猜错了"。
   */
  if (skill.input && (input === undefined || String(input).trim() === '')) {
    return { ok: false, reason: `${skill.name}要先填「${skill.input.label}」` };
  }

  const handler = SKILL_EFFECTS[skill.effect];
  if (!handler) return { ok: false, reason: `未实现的技能效果：${skill.effect}` };

  const c: SkillCtx = {
    state: s, 
    // 技能里的选点、范围、地形一律按施法者那张图（见 skill-hooks 的 view 契约）
    view: boardStateOf(s, u),
    self: u, 
    skill, 
    api: abilityApi,
    target: (typeof targetX === 'number' && typeof targetY === 'number') ? { x: targetX, y: targetY } : undefined,
    input,
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

  // 走到这里才算"真的放出去了"：灵石不足之类的拒绝在上面就返回了，
  // 不会把撤回封死。界面拿这个字段清空撤回栈。
  return { ok: true, state: s, irreversible: skill.irreversible === true };
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
        /*
         * 状态掉血也走统一出口（`attrition`：内生损耗，不转移、不触发受伤钩子）。
         * 战报仍由状态自己返回——所以 `c.hurt` 刻意不写日志，否则一条战报两遍。
         */
        const logText = def.onTurnStart({
          state: s,
          unit: u,
          val,
          hurt: (amount) => hurtUnit(s, u, amount, { attrition: true }).amount,
          maxHpOf: (x) => maxHpOf(s, x),
          utypeOf: (typeId) => utype(s, typeId),
        });
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
    // 自损也是"扣血"，但它不是受伤（没人打它）：走 attrition，不转移、不触发钩子
    hurtUnit(s, u, d, { attrition: true });
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
      // 遍历全部 key，不写死内置状态清单。
      // 原来只清 ['poison','burn','slow','curse'] 四个，连内置的「咒缚」
      // （curse-deep）都漏在外面，扩展注册的状态更是一个都清不到。
      for (const [k, v] of Object.entries(u.status)) {
        if (typeof v !== 'number' || v <= 0) delete u.status[k];
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
    { state: s, view: boardStateOf(s, u), self: u, owner: p, rested, healable: canBeHealedOn(s, u), api: abilityApi },
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

  /*
   * 「点亮一回合」到这里熄灯：`prevPlayer` 的回合刚结束，站在他对面的
   * 那些单位已经亮了他一整回合（见 spotlight.ts）。
   *
   * 放在切人**之前**清，是因为 `spotlightCellsOn` 只看 `s.current`：
   * 先把 current 换掉再清，中间那一瞬谁都不该看见。
   */
  clearSpotlightsOfOthers(s, prevPlayer);

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
        /*
         * 维护费不足、天气持续伤害走这里：**不吃护甲**（这是有意的——
         * 交不起税跟穿什么甲没关系），也没有攻击方。
         *
         * 但"不吃护甲"不等于"要另开一条扣血的路"。曾经这里直接
         * `u.hp -= amount`，代价是守御阵挡不住它、受伤钩子不触发、
         * 战报口径和别处对不上。现在统一走 `attrition`：
         * 跳过转移和受伤钩子（语义正确），其余照旧。
         */
        hurtUnit(s, u, amount, { attrition: true });
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

  /*
   * 接手方的建筑先清一次场：射程里已经站着人的，就在这一刻打。
   *
   * 位置和以前那句 `fireBuildings(s, prevPlayer)` 一样，主语换了：
   * 以前是"守方在敌人接手时白打一轮"（和手动开火各算各的），
   * 现在是"轮到自己时，把这一回合的火力花在射程里还在的人身上"——
   * 同一份 `attacksLeft`，不会多打一发。
   */
  reactionVolleyAtTurnStart(s, nextPlayer);

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
    e.hooks.onTurnStart?.({ state: s, player: nextPlayer, api: abilityApi });
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
/**
 * 本方所有的"眼睛"：每个自己单位的视野半径，加每座自己城市的城郊视野。
 *
 * 抽出来是因为**可见性有两个消费者**：整张可见格表（`visibleTilesOf`，渲染和记忆用）
 * 和单格判定（`tileVisibleTo`，攻击合法性用）。两边各写一遍来源，
 * 迟早出现"画出来是亮的、却打不着"或者反过来。来源只此一份。
 */
function forEachVisionSource(
  s: GameState,
  p: PlayerId,
  fn: (board: BoardId, x: number, y: number, r: number) => void,
): void {
  for (const u of s.units) {
    if (u.owner !== p) continue;
    fn(boardIdOf(u), u.x, u.y, visionOf(s, u));
  }
  for (const city of s.cities) {
    if (city.owner !== p) continue;
    for (const t of cityTiles(city)) fn(boardIdOf(city), t.x, t.y, CONFIG.cityVision);
  }
}

/**
 * **一张图**的可见格。
 *
 * 多图之后，"谁看得见哪"必须按图分开算：月球上的侦察兵不该点亮地球的格。
 * 视野来源（单位、城市）带着自己的 `board`，这里只收同一张图的那些。
 *
 * `id` 缺省地球：绝大部分调用点（AI 威胁图、寻路、热度）只关心地球，
 * 保持原来的签名，行为一格不变。
 */
export function visibleTilesOn(s: GameState, p: PlayerId, id: BoardId = EARTH): Set<number> {
  const out = new Set<number>();
  const board = boardOf(s, id);

  forEachVisionSource(s, p, (b, cx, cy, r) => {
    if (b !== id) return;
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dy * dy > r * r) continue;
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || y < 0 || x >= board.w || y >= board.h) continue;
        out.add(y * board.w + x);
      }
    }
  });

  /*
   * 扩展的"额外视野"。
   *
   * 放在这里而不是视图层（fog.ts）是有意的：这条规则**连 AI 一起生效**——
   * 修真修士突破时点的"异象"要让对面不但看得见，还能据此派兵去劫杀。
   * 只改画面不改决策的话，单机打 AI 这个机制就等于不存在。
   *
   * 代价是它进了热路径（寻路、威胁圈、记忆刷新都会调这个函数），
   * 所以钩子必须是纯函数且尽早返回；扩展那边先判 `s.current !== player`
   * 再遍历单位，空手而归的时候只花一次比较。
   *
   * **目前只在地球上生效**：钩子返回的是地球的格索引，把它当成别的图的索引
   * 会点亮完全无关的格子。等有扩展真的要给月球加视野时，把钩子的返回值
   * 改成"按图分组"再放开这条限制。
   */
  if (id === EARTH) {
    for (const e of activeExpansions(s)) {
      const extra = e.hooks.extraVision?.({ state: s, player: p });
      if (!extra || extra.length === 0) continue;
      for (const i of extra) out.add(i);
    }
  }

  /*
   * 「点亮一回合」：核心机制，**不经过扩展钩子**，所以任何图都能用
   * （钩子那条还是地球专供，见上面的说明）。
   * 修真的异象、太空的发射井都记在这里，规则层与 AI 一起认。
   */
  for (const i of spotlightCellsOn(s, p, id)) out.add(i);
  // 侦察情报：遥感模块看到的那几格，和"自己视野"同一层
  for (const i of reconCellsOn(s, p, id)) out.add(i);

  return out;
}

/** 地球的可见格。老名字保留：调用点太多，而且它们本来也只看地球。 */
export function visibleTilesOf(s: GameState, p: PlayerId): Set<number> {
  return visibleTilesOn(s, p, EARTH);
}

/**
 * 这一格此刻在不在 `p` 的视野里。
 *
 * 存在的理由：**看得见才打得到**。以前规则层完全不看视野——地图是公开的
 * （基础迷雾只遮单位、不遮地形），于是"城里明明是一片雾，弓手照样能把城墙砸了"。
 * 视图层用 `visibleTilesOf` 画明暗，规则层却用射程判合法，两套口径必然对不上。
 *
 * 用单格判定而不是整张可见格表：这条进了攻击合法性，是热路径
 * （AI 每回合要把每个兵 × 每个目标都问一遍），而建一张全图集合太贵。
 */
export function tileVisibleTo(
  s: GameState,
  p: PlayerId,
  x: number,
  y: number,
  id: BoardId = EARTH,
): boolean {
  if (!s.fog) return true;
  let lit = false;
  forEachVisionSource(s, p, (b, cx, cy, r) => {
    if (lit) return;
    if (b !== id) return;
    const dx = x - cx;
    const dy = y - cy;
    if (dx * dx + dy * dy <= r * r) lit = true;
  });
  if (lit) return true;
  // 额外视野只有地球的索引，别的图直接跳过
  if (id === EARTH) {
    const i = idx(s, x, y);
    for (const e of activeExpansions(s)) {
      const extra = e.hooks.extraVision?.({ state: s, player: p });
      if (extra && extra.includes(i)) return true;
    }
  }
  // 点亮 / 侦察：按这张图的格号比对（任何图都认）
  const spotCell = y * boardOf(s, id).w + x;
  if (spotlightCellsOn(s, p, id).includes(spotCell)) return true;
  if (reconCellsOn(s, p, id).includes(spotCell)) return true;
  return false;
}

/**
 * 这座城此刻在不在 `p` 的视野里：**任意一格**被看见就算。
 *
 * 和 `fog.ts` 的 `cityInSight` 是同一条判据（那边手里已经有整张可见格表，
 * 就地查更省）。一座城的城墙露出一角，就知道那儿有座城——但攻城打的是整座城，
 * 所以只要有一面墙在视野里，它就打得。
 */
export function cityInSightOf(s: GameState, viewer: PlayerId, city: City): boolean {
  if (!s.fog) return true;
  const id = boardIdOf(city);
  for (const t of cityTiles(city)) {
    if (tileVisibleTo(s, viewer, t.x, t.y, id)) return true;
  }
  return false;
}

/**
 * `p` 能不能**指到**这个单位：它站的格子看得见，而且它没有藏起来。
 *
 * 这是"看得见才打得到"的统一判据，攻击候选、塔的自动开火、挨打后的反击
 * 三处共用。分成两个条件是因为它们回答的是不同的问题：
 *
 *   · `tileVisibleTo` —— 那片地你熟不熟（地形是公开的，只要视野够）；
 *   · `isHiddenFrom`  —— 那个**兵**露不露头（潜行/潜航/隐身另算）。
 *
 * 只查地形会漏掉后者：一个蹲在林子里、刚结束回合的斥候，格子看得见，
 * 但它在迷雾里就是不显形。以前靠"界面不画、AI 只吃 playerView"侥幸成立，
 * 换成塔的自动开火（它直接读 `s.units`）就立刻能打到看不见的人了。
 */
export function unitInSightOf(s: GameState, p: PlayerId, u: Unit): boolean {
  if (!s.fog) return true;
  return tileVisibleTo(s, p, u.x, u.y, boardIdOf(u)) && !isHiddenFrom(s, u, p);
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
  const ids = boardIds(s);

  for (const p of seatsOf(s)) {
    /*
     * 可见格按图各算一份。
     *
     * 这一步不能省成"只算地球"：月球上的侦察兵不该刷新地球的记忆，
     * 反过来地球的视野也不该把月球上的敌人记进幽灵表。
     */
    const visByBoard: Record<BoardId, Set<number>> = {};
    for (const id of ids) visByBoard[id] = visibleTilesOn(s, p, id);

    const mem = s.memory[p];
    const aliveIds = new Set(s.units.map((u) => u.id));

    for (const u of s.units) {
      if (u.owner === p) continue;
      const id = boardIdOf(u);
      const vis = visByBoard[id];
      if (!vis || !vis.has(idxOn(s, id, u.x, u.y))) continue;
      // 潜行中的单位不该刷新坐标：它"还在原地"这件事本身也是情报
      if (isHiddenFrom(s, u, p)) continue;

      const known = mem.known.find((k) => k.id === u.id);
      if (known) {
        known.x = u.x;
        known.y = u.y;
        known.type = u.type;
        known.board = id;
        known.seenAt = s.turn;
      } else {
        mem.known.push({ id: u.id, type: u.type, x: u.x, y: u.y, board: id, seenAt: s.turn });
      }
    }

    // 记忆中的单位如果在视野里消失了，说明确实被消灭了，可以忘掉。
    // 如果那格看不见，就继续保留——你不知道它死了还是走了。
    mem.known = mem.known.filter((k) => {
      if (aliveIds.has(k.id)) return true;
      const id = k.board ?? EARTH;
      const vis = visByBoard[id];
      return !vis || !vis.has(idxOn(s, id, k.x, k.y));
    });

    if (!keepMap) continue;

    /*
     * 地形按"此刻亲眼看得到的"刷新，**每张图一份**。
     *
     * 以前看过、现在看不见的格不会被抹掉——那正是这份记忆存在的意义。
     * 地球同时往老的 `mem.tiles` 里写一份：那个字段已经进了老存档，
     * 浓雾扩展也只作用于地球，两边都留着最省事。
     */
    mem.tilesByBoard ??= {};
    for (const id of ids) {
      const vis = visByBoard[id]!;
      const board = boardOf(s, id);
      const store = (mem.tilesByBoard[id] ??= {});
      for (const i of vis) {
        const tile = board.tiles[i];
        if (tile) store[i] = tile.terrain;
      }
      if (id === EARTH) {
        mem.tiles ??= {};
        for (const [key, terrain] of Object.entries(store)) mem.tiles[Number(key)] = terrain;
      }
    }

    // 城目前只在地球：其它图不放城（见 board 的迁移约定）
    mem.cities ??= [];
    const earthVis = visByBoard[EARTH]!;
    for (const city of s.cities) {
      if (boardIdOf(city) !== EARTH) continue;
      // 沾到城的任意一格就算见过：城格是实心的，视野一定先落在它身上
      if (!cityTiles(city).some((t) => earthVis.has(idx(s, t.x, t.y)))) continue;
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
