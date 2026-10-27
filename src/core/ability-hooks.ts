/**
 * 能力钩子：兵种"特殊能力"的计算位置。
 *
 * 这份文件只定义**接口**，不实现任何一条能力——实现归能力的主人：
 *   · 原版兵种的能力写在 abilities.ts（本体机制）；
 *   · 扩展兵种的能力写在扩展自己的文件里（见 fantasy-packs.ts 的 abilities 字段）。
 *
 * 为什么要这么分：能力是"某个兵种怎么打"，不是"引擎怎么算"。
 * 以前所有能力的实现都长在 rules.ts 里的一串 `if (hasAbility(def, 'xxx'))`，
 * 于是加一个扩展兵种要动核心文件，删一个扩展要回来找哪几行是谁的，
 * 而 rules.ts 越写越长、越写越像一张兵种清单。现在 rules 只负责
 * "在什么时机问谁"，至于"问了之后怎么算"，由能力自己回答。
 *
 * 三条纪律：
 *   1. `modify*` 语义的钩子必须是纯函数（面板预览也会调用它们）；
 *   2. 钩子里不许 Math.random——要随机就用 api.hashPick，从种子派生；
 *   3. 钩子不认识内核符号，只能通过 ctx.api 要东西。扩展 import rules
 *      会形成运行时循环依赖，也会让"写在扩展里"退化成"写在扩展文件里的内核代码"。
 *
 * 钩子的**时机**靠 stage 编号排定，不靠调用顺序。stage 的值刻意留出间隔，
 * 是为了以后能在两条老能力之间插一条新的，而不用重排整张表。
 * 顺序不是随便定的：它逐个复刻了原来 rules.ts 里那段 if 链的先后，
 * 因为那些先后有实际意义（狂暴要在加减之后乘、盾墙要在冲锋之后减）。
 */

import type { City, GameState, PlayerId, Terrain, Unit, UnitTypeDef } from './types.ts';

/** 四邻方向。规则层到处都要用，放这里省得扩展自己再抄一份 */
export const DIRS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

/** 燃烧最多叠几层。命中类能力与回合结算共用同一个上限 */
export const BURN_MAX_LAYERS = 3;

/** 面板上一条算式："指挥光环 +2" */
export interface StatItem {
  label: string;
  delta: number;
}

/**
 * 能力实现能用的工具。
 *
 * 由 rules.ts 注入，而不是让扩展文件去 `import { canStandAt } from './rules.ts'`——
 * rules 引扩展、扩展引 rules，就成了运行时循环依赖。
 */
export interface AbilityApi {
  utype(s: GameState, id: string): UnitTypeDef;
  tileAt(s: GameState, x: number, y: number): { terrain: Terrain } | null;
  distance(a: { x: number; y: number }, b: { x: number; y: number }): number;
  strikeDistance(s: GameState, a: Unit, b: Unit): number;
  canStandAt(s: GameState, x: number, y: number, type: string): boolean;
  freeNeighbor(s: GameState, u: Unit, type: string): { x: number; y: number } | null;
  /** 造一个单位并放到盘上（召唤、分裂、筑墙都走它） */
  spawn(s: GameState, owner: PlayerId, type: string, x: number, y: number): void;
  pushLog(s: GameState, player: PlayerId, text: string, open?: boolean): void;
  citiesOf(s: GameState, p: PlayerId): City[];
  distToCity(u: { x: number; y: number }, city: City): number;
  cityName(city: City): string;
  /** 确定性抽样：规则层不许用 Math.random */
  hashPick(s: GameState, salt: number, n: number): number;
  /** 这个兵种有没有某条能力（少数能力之间确实有依赖，比如强再生之于再生） */
  hasAbility(s: GameState, u: Unit, id: string): boolean;
  /** 能不能被治疗（机械单位不行） */
  canBeHealed(s: GameState, u: Unit): boolean;
  /** 贴一层持续状态；返回是否新贴上（战报只报真正发生的事） */
  putStatus(target: Unit, key: 'poison' | 'burn' | 'slow' | 'curse', turns: number): boolean;
  /** 点燃一层；返回当前层数，到顶就返回 0 */
  addBurnLayer(target: Unit): number;
}

/**
 * 这条钩子站在哪一边。
 *
 * 为什么必须有：护甲和伤害这两个阶段，攻守双方的能力改的是**同一坨数字**。
 * 「破甲」削的是对手的护甲，所以它只在自家人出手时成立；
 * 「盾墙」减的是自己挨的那一下，所以它只在自家人挨打时成立。
 * 如果只按"谁的兵种有这条能力"去跑，守方的破甲就会把守方自己的护甲砍一半——
 * 一个拿着破甲刀的兵会因此变脆，这在玩家眼里只能是"算错了"。
 */
export type Side = 'attacker' | 'defender';

/**
 * 通用计算上下文。
 *
 * 一个对象走到底：`self` 是"这条能力挂在谁身上"，`foe` 是那一侧的对手。
 * 这样同一段实现既能当攻方用、也能当守方用（盾墙和冲锋共用一套字段），
 * 不必为"我是攻还是守"各写一份。
 */
export interface HookCtx {
  state: GameState;
  /** 能力的主人 */
  self: Unit;
  /** 对面那个；没有对手的场合（面板数值）为 undefined */
  foe?: Unit;
  /** 能力的主人在这一下里是出手的，还是挨打的（见 Side 的说明） */
  side: Side;
  /** 攻击力（statAttack 阶段会改它） */
  atk: number;
  /** 护甲（armorPhase / statArmor 阶段会改它） */
  armor: number;
  /** 伤害（damage 阶段会改它） */
  damage: number;
  /** 面板要显示的算式 */
  items: StatItem[];
  isCounter: boolean;
  /** 对手脚下地形带来的护甲加成，供「穿隙」扣掉 */
  terrainBonus: number;
  /** 已被标记"无视地形掩护"（穿隙），林地之主据此不强加护甲 */
  ignoreCover: boolean;
  /** 两者之间的攻击距离（含空中 +1） */
  distance: number;
  api: AbilityApi;
}

/**
 * 带时机的修正。stage 小的先跑，同 stage 按兵种 abilities 数组的顺序。
 *
 * 所有 `apply` 都是**纯函数**：只改传进去的 ctx，不碰 state。
 * 这一条让面板预览和 AI 试算可以随便调用它们。
 */
export interface Staged<C> {
  stage: number;
  apply: (c: C) => void;
}

/** 面板数值的时机 */
export const STAT_STAGE = {
  base: 100,
} as const;

/**
 * 计算护甲时的时机。
 *
 * 全部在"扩展 modifyArmor"之前，只有破甲在之后——因为破甲削的是**累出来的**
 * 那一坨护甲，包括扩展加的那几点。
 */
export const ARMOR_STAGE = {
  /** 穿隙：不吃地形那一层 */
  ignoreCover: 100,
  /** 林地之主：站在林丘上 +3 */
  woodland: 200,
  /**
   * 分界线，不是钩子：`< expanded` 的在扩展 modifyArmor **之前**跑
   * （穿隙、林地之主），`>= expanded` 的在**之后**跑（破甲）。
   *
   * 之所以要这条线：扩展加的护甲必须和地形加成是同一种东西——
   * 破甲照样削它一半、攻低照样打不动它。穿隙和林地之主则是"掩护"，
   * 得在扩展改甲之前就定下来。
   */
  expanded: 500,
  /** 破甲：把前面累出来的护甲砍一半 */
  pierce: 900,
} as const;

/**
 * 伤害公式里的时机。
 *
 * 每个数字都对应原来 rules.ts 里 `if` 的一句位置。为什么分成这么多段：
 * 因为乘法与加法**不能互换**——把狂暴挪到盾墙前面，结果会差一点，
 * 而这种"差一点"在几百局里都看不出来，只在某一次对局里突然觉得"这兵怎么不疼了"。
 */
export const DAMAGE_STAGE = {
  /** 冲锋、群势、追猎：这一下多几点 */
  attackFlat: 100,
  /** 狂暴：乘法，作用在前面所有加减之后 */
  attackMul: 200,
  /** 盾墙：守方少挨 2 点 */
  defenderFlat: 300,
  /** 威吓：被贴身的攻方手抖 */
  fear: 400,
  /** 长短皆可：扔出去的只有六成 */
  rangeMul: 500,
  /** 游骑：拉开 +3，被贴 −3 */
  rangeFlat: 600,
  /** 同源护壁：同一属性的伤害减半（在属性弱点之后） */
  elementMul: 700,
} as const;

/** 命中附带的时机 */
export const HIT_STAGE = {
  /** 淬毒、燃焰、霜缚、咒缚：命中即贴 */
  status: 100,
  /** 属性精研：按自身属性贴，排在普通命中之后 */
  element: 200,
} as const;

/** 出手流程里的时机 */
export const STRIKE_STAGE = {
  /** 反击结算之后：吸血 */
  afterDamage: 100,
  /** 命中状态结算之后：击退 */
  afterStatus: 200,
} as const;

/**
 * 回合开始的时机。
 *
 * 分四段是因为 rules 那边**中间要清一次场**：布雷能把人打死，
 * 而"召唤数量上限"数的是活人。合成一段就会让刚被炸死的单位还算一个编制。
 */
export const TURN_START = {
  /** 自身恢复：休整、再生、嗜血（在 doEndTurn 的自愈循环里） */
  self: 100,
  /** 光环类：治疗光环、净化、大净化 */
  aura: 200,
  /** 动手类：修缮、筑墙、布雷（这段之后要 sweepDead） */
  support: 300,
  /** 召唤（最后一段：先结算完伤害和状态，再决定谁还能召） */
  summon: 400,
} as const;

export interface HitCtx {
  state: GameState;
  self: Unit;
  target: Unit;
  damage: number;
  api: AbilityApi;
  /** 已经贴上去的效果名，战报要念出来 */
  touched: string[];
}

export interface DeathCtx {
  state: GameState;
  /** 倒下的那个 */
  victim: Unit;
  killer: Unit | undefined;
  api: AbilityApi;
  /** 死亡效果留下的结果，主流程据此决定要不要清场 */
  result: { blasts: number };
}

export interface KillCtx {
  state: GameState;
  /** 击杀者（攻方） */
  self: Unit;
  victim: Unit;
  api: AbilityApi;
  result: { moveBack: boolean };
}

export interface StrikeCtx {
  state: GameState;
  self: Unit;
  target: Unit;
  /** 这一下真打出来的伤害 */
  damage: number;
  api: AbilityApi;
  /** 能力往里写结果，主流程负责念战报 */
  result: {
    /** 吸血回了几点 */
    healed: number;
    /** 目标被推开了 */
    pushed: boolean;
  };
}

/** 攻城伤害（在扩展 modifySiegeDamage 之前） */
export interface SiegeDamageCtx {
  state: GameState;
  self: Unit;
  city: City;
  damage: number;
  api: AbilityApi;
}

/** 攻城战利品（伤害已经落到城上了，这里只捞钱） */
export interface SiegeLootCtx {
  state: GameState;
  self: Unit;
  city: City;
  damage: number;
  api: AbilityApi;
  result: { loot: number };
}

export interface MagicCtx {
  state: GameState;
  self: Unit;
  foe: Unit;
  /** 已经减过魔抗的魔法伤害 */
  magic: number;
  api: AbilityApi;
}

export interface TurnStartCtx {
  state: GameState;
  self: Unit;
  /** 自己的那一方 */
  owner: PlayerId;
  /** 这一回合开始前"没动也没打"，休整要靠它 */
  rested: boolean;
  /** 这个单位能不能被治疗（机械不行） */
  healable: boolean;
  api: AbilityApi;
}

export interface MoveCostCtx {
  state: GameState;
  unit: Unit;
  def: UnitTypeDef;
  terrain: Terrain;
  /** 当前累计出的单格步耗 */
  cost: number;
}

export interface HiddenCtx {
  state: GameState;
  self: Unit;
  viewer: PlayerId;
  api: AbilityApi;
}

/**
 * 光环：只写数据，不写代码。
 *
 * 光环的效果就是"贴着我的友军/敌军加减几点"，没有第二种形态，
 * 所以它值得一张声明式的小表——rules 那边遍历邻居、读表、累加，
 * 完全不需要知道"哪条能力叫威吓"。
 */
export interface AuraSpec {
  /** 给相邻友军 */
  allyAtk?: number;
  allyArmor?: number;
  allyMove?: number;
  /** 给相邻敌军 */
  foeAtk?: number;
  foeArmor?: number;
  /** 最多叠几层（默认不限） */
  maxLayers?: number;
}

/** 一条能力能挂的全部钩子。没实现的部分留空即可。 */
export interface AbilityHooks {
  /** 面板上的攻击力修正（狂暴那种"现在就成立"的） */
  statAttack?: Staged<HookCtx>[];
  /** 面板上的护甲修正（林地之主） */
  statArmor?: Staged<HookCtx>[];
  /** 伤害公式里的护甲阶段（穿隙、林地之主、破甲） */
  armorPhase?: Staged<HookCtx>[];
  /** 伤害公式里的伤害阶段（见 DAMAGE_STAGE） */
  damage?: Staged<HookCtx>[];
  /** 命中之后贴状态（见 HIT_STAGE） */
  onHit?: Staged<HitCtx>[];
  /** 阵亡时（自爆、重生、分裂） */
  onDeath?: (c: DeathCtx) => void;
  /** 亲手打死目标之后（收割） */
  onKill?: (c: KillCtx) => void;
  /** 攻击流程里的补充（见 STRIKE_STAGE：吸血、击退） */
  onStrike?: Staged<StrikeCtx>[];
  /** 攻城伤害修正（破城） */
  siegeDamage?: Staged<SiegeDamageCtx>[];
  /** 攻城时顺手捞一笔（窃掠），拿到的 dmg 已经乘过攻城加成了 */
  siegeLoot?: (c: SiegeLootCtx) => void;
  /** 魔法段倍率（属性精研·暗） */
  magicMul?: (c: MagicCtx) => number;
  /** 自己回合开始（见 TURN_START） */
  onTurnStart?: Staged<TurnStartCtx>[];
  /** 覆盖进入某格的步耗（穿林：森林丘陵按 1） */
  moveCost?: (c: MoveCostCtx) => number | undefined;
  /** 步耗倍率（重甲难行 ×2） */
  moveCostMul?: (c: MoveCostCtx) => number;
  /** 能不能穿过敌军 */
  passThrough?: boolean;
  /** 能不能掠水（飞行、掠空、跳跃） */
  crossesWater?: boolean;
  /** 在不在空中层（能和地面单位同格）。目前只有「掠空」 */
  airLayer?: boolean;
  /** 藏不藏得住（潜行、隐匿） */
  hidden?: (c: HiddenCtx) => boolean;
  /** 免疫溅射 */
  immuneSplash?: boolean;
  /** false = 不能被治疗（机械） */
  healable?: boolean;
  /** 不引发反击（先手） */
  noCounter?: boolean;
  aura?: AuraSpec;
}

/**
 * 按 stage 升序跑一组修正。
 *
 * `from` / `to` 用来把同一批钩子劈成几段跑：护甲那段必须夹在
 * "扩展 modifyArmor" 前后各跑一次（穿隙和林地之主在扩展之前、破甲在之后），
 * 伤害那段要夹着魔法段和属性段，回合开始那段中间要清场。
 * 而它们的先后又是规则的一部分，不能合起来算。
 */
export function runStaged<C>(
  list: Staged<C>[] | undefined,
  ctx: C,
  range?: { from?: number; to?: number },
): void {
  if (!list || list.length === 0) return;
  const from = range?.from ?? -Infinity;
  const to = range?.to ?? Infinity;
  const picked = list.filter((h) => h.stage >= from && h.stage < to);
  if (picked.length === 0) return;
  if (picked.length === 1) {
    picked[0]!.apply(ctx);
    return;
  }
  picked.sort((a, b) => a.stage - b.stage);
  for (const h of picked) h.apply(ctx);
}

/**
 * 光环的目标：自己 + 半径内的友军。
 *
 * 治疗光环、大小净化都要这一份名单，而且顺序有意义（先自己，后按棋盘顺序），
 * 所以别让每个扩展各写一遍——写反了战报里的"治愈了 N 个"就会时对时错。
 */
export function auraTargets(c: TurnStartCtx, radius = 1): Unit[] {
  const self = c.self;
  return [
    self,
    ...c.state.units.filter(
      (u) => u.owner === self.owner && u.id !== self.id && c.api.distance(u, self) <= radius,
    ),
  ];
}
