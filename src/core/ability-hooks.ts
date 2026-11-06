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
import { distBetweenUnits } from './query.ts';

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
  /**
   * 这一格能不能站。
   *
   * `ignoreUnits: true` 只判地形与层，不管这一格有没有人——
   * 传送这类"一群人同时换位置"的效果必须在**所有人都还没挪过去**的时候校验，
   * 否则先校验的人会被后校验的人挡住。
   */
  canStandAt(
    s: GameState,
    x: number,
    y: number,
    type: string,
    opts?: { ignoreUnits?: boolean },
  ): boolean;
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
  /**
   * 贴一层持续状态。
   *
   * `key` 是**任意已注册的状态 id**：内置的（中毒/灼烧/减速/诅咒/咒缚）和扩展用
   * `registerStatus` 注册的都算。以前这里写死了 5 个字面量，导致扩展能注册状态
   * 却贴不上去——注册表对外开着，入口却是关的。
   *
   * 没注册过的 id 会当场抛错，而不是静默什么都不发生：贴错一个名字查起来
   * 比崩一次难得多。
   *
   * 返回是否真的贴上了（已有同等或更多的回合数时返回 false，战报就不要报了）。
   */
  putStatus(target: Unit, key: string, turns: number): boolean;
  /** 点燃一层；返回当前层数，到顶就返回 0 */
  addBurnLayer(target: Unit): number;
  /** 算一下这个单位打那个单位能造成多少伤害 */
  computeDamage(s: GameState, attacker: Unit, defender: any, isCounter?: boolean): number;
  /** 算一下这个单位现在的溅射半径 */
  splashRadiusOf(s: GameState, u: Unit): number;
  attacksPerTurn(s: GameState, u: Unit): number;
  /**
   * 走完整的死亡流程：从棋盘删除、写战报、沉船、触发 onDeath 和 onUnitKilled。
   *
   * `logText` 是可选的战报文字（不同死法说不同的话，比如"被剑气斩杀" vs
   * "被炮火波及消灭"）。不填就用通用文案 `${name} 被消灭`。
   *
   * 如果 target 已经在 s.units 里不存在了（被别的死亡链波及删掉），
   * 这个调用是幂等的空操作，不会抛错。
   */
  killUnit(s: GameState, victim: Unit, killer: Unit | undefined, logText?: string): void;
  /** 摧毁一座城市：变废墟、挤出守军、写战报。幂等（已废墟的再打不生效）。 */
  destroyCity(s: GameState, city: City, attackerOwner: PlayerId): void;
  /** 把这一格记进战斗烈度（供被攻击方下回合闪红） */
  noteHeat(s: GameState, x: number, y: number): void;
  isAirborne(s: GameState, u: Unit): boolean;
  unitsAt(s: GameState, x: number, y: number): Unit[];
  /** 算上扩展规则后的剩余移动力（已扣除 moveSpent） */
  movePower(s: GameState, u: Unit): number;
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
 */
export const ARMOR_STAGE = {
  /** 穿隙：不吃地形那一层 */
  ignoreCover: 100,
  postIgnoreCover: 150,

  /** 林地之主：站在林丘上 +3 */
  woodland: 200,
  postWoodland: 250,

  /** 小型扩展，modifyarmor就在这里发生 */
  expanded: 500,
  postExpanded: 550,

  /** 破甲：把前面累出来的护甲砍一半 */
  pierce: 900,
  postPierce: 950,

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
  
  // 把 600~700 之间切成几段，给未来留空槽 ──
  postRange: 610,     // 游骑之后、魔法之前
  postMagic: 650,     // 魔法之后、属性之前
  postElement: 680,   // 属性之后、同源护壁之前

  /** 同源护壁：同一属性的伤害减半（在属性弱点之后） */
  elementMul: 700,

  /** 真实伤害阶段：不吃护甲、不吃减伤，直接扣血（留空槽） */
  trueDamage: 1000,
} as const;

/** 命中附带的时机 */
export const HIT_STAGE = {
  /** 淬毒、燃焰、霜缚、咒缚：命中即贴 */
  status: 100,
  postStatus: 150,

  /** 属性精研：按自身属性贴，排在普通命中之后 */
  element: 200,
  postElement: 250,
} as const;

/** 出手流程里的时机 */
export const STRIKE_STAGE = {
  /** 反击结算之后：吸血 */
  afterDamage: 100,
  postDamage: 150, 

  /** 命中状态结算之后：击退 */
  afterStatus: 200,
  postStatus: 250,
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
  postSelf: 150, 

  /** 光环类：治疗光环、净化、大净化 */
  aura: 200,
  postAura: 250, 

  /** 动手类：修缮、筑墙、布雷（这段之后要清场sweepDead） */
  support: 300,
  postSupport: 350,

  /** 召唤 */
  summon: 400,
  postSummon: 450, 
} as const;

/**
 * 持续状态的定义。
 * 扩展可以通过注册表注册自己的状态，从而影响单位。
 */
export interface StatusDef {
  id: string;
  name: string;
  summary: string;

  /** 
   * 回合开始时的结算（比如掉血、回血）。
   * 返回字符串则写入战报，返回 null 表示不写。
   */
  onTurnStart?: (s: GameState, u: Unit, val: number) => string | null;

  /** 修正移动力 */
  modifyMove?: (s: GameState, u: Unit, val: number, move: number) => number;

  /** 修正护甲 */
  modifyArmor?: (s: GameState, u: Unit, val: number, armor: number) => number;

  /** 修正攻击力（可以留给未来的面板和使用，目前先挂着） */
  modifyAtk?: (s: GameState, u: Unit, val: number, atk: number) => number;
  
  /** 修正视野 */
  modifyVision?: (s: GameState, u: Unit, val: number, vision: number) => number;
}

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
 * "我能不能发现它"：反潜声纳那类能力用的上下文。
 *
 * `self` 是**搜索方**的单位，`target` 是要被发现的那个（潜航的潜艇、藏起来的刺客）。
 * 默认的发现距离是贴脸一格（见 rules.isHiddenFrom），这里返回的值是**额外加几格**。
 *
 * 为什么要让它按 `target` 来判断，而不是给一个固定的"视野 +2"：
 * 声纳探的是潜艇，不是藏在树林里的刺客。写死成"全类型 +1"的话，
 * 一条扫雷舰会顺手把对面的刺客也照出来——那不是反潜，是开图。
 */
export interface DetectCtx {
  state: GameState;
  self: Unit;
  target: Unit;
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
  /** 面板显示用的名字。不写就按属性派生一个兜底名。 */
  label?: string;
  /** 给相邻友军 */
  allyAtk?: number;
  allyArmor?: number;
  allyMove?: number;
  /** 给相邻敌军 */
  foeAtk?: number;
  foeArmor?: number;
  /**
   * 给范围内敌军的**攻击力百分比**降低（0.25 = −25%）。
   *
   * 为什么单独开一个字段而不复用 `foeAtk`：`foeAtk` 是**减法**（威吓那种
   * "贴上去少 2 点"），对高攻单位几乎无效；而「虚咒」要的是**比例**，
   * 对谁都是 25%。两者语义不同，混在一个字段里会让"−2 点"和"−25%"打架。
   *
   * 多条虚咒不叠乘：取最强的一条。两个女巫贴身不该变成 −50%，
   * 那会让"多带一个女巫"变成乘法收益，而光环类效果一律按取强处理。
   */
  foeAtkPct?: number;
  /**
   * 友军攻击力**百分比**加成（0.1 = +10%）。
   *
   * 和 allyAtk 的分工：那个是加法（+2 点）——对杂兵是翻倍，对高攻单位是零头；
   * 这个是比例，对谁都是同一个百分比。"按比例统御"才像阵法，所以单独开一个字段，
   * 而不是把 allyAtk 改成能写小数（那会让现存二十多个光环的含义全变）。
   *
   * 多条不叠乘，**取最强**：两个杀伐阵重叠不该变成 ×1.21。
   */
  allyAtkPct?: number;

  /**
   * 敌军**移动力留存比例**（0.5 = 只剩一半，向下取整）。
   *
   * 减到 0 就真的走不动了：movePower 里"保底 1"在光环之前，
   * 所以这里的 0 不会被抬回 1（见 rules.movePower 的注释）。
   * 多条同样取最强，也就是取**最小**的留存率。
   */
  foeMovePct?: number;

  /**
   * 敌军**移动力的固定扣减**（0/1/2…）。和 foeMovePct 是两回事：
   * 那个是按比例砍，这个是减固定值，而且**在比例之后**结算。
   *
   * 封印阵用它：基础只减半，有修士守阵时再减"守阵者的境界"点，
   * 所以 0 级修士守阵等于没加成，1 级修士就能把 2 移的单位压到 0。
   */
  foeMoveFlat?: number;

  /**
   * 上面那几条"给敌军"的作用半径（格）。默认 1 = 相邻。
   *
   * 威吓、咒域都是 1（贴上去才算），「虚咒」是 3。
   */
  radius?: number;
  /** 最多叠几层（默认不限） */
  maxLayers?: number;
}

/** 一条能力能挂的全部钩子。没实现的部分留空即可。 */
export interface AbilityHooks {
  /**
   * 面板显示用的名字。不写就按属性派生一个兜底名。
   * 数据里写了就用数据的——"将军光环"和"指挥光环"可以各自显示。
   */
  label?: string;
  /** 面板上的攻击力修正（狂暴那种"现在就成立"的） */
  statAttack?: Staged<HookCtx>[];
  /** 面板上的护甲修正（林地之主） */
  statArmor?: Staged<HookCtx>[];
  /**
   * 脚下这块地的护甲加成，**声明式**写在这里。
   *
   * 为什么不能只在 statArmor 里写：那是"结算时算一遍"，AI 读不到。
   * 2026-11-02 之前 AI 对地形的估值是一个与兵种无关的常数，
   * 于是"树人站丘陵 +3 甲"这件事只存在于伤害公式里，决策层完全不知道——
   * 它会为了 0.5 分的推进把树人从丘陵上挪到平地。
   *
   * 同一份数据现在有两个消费者（statArmor 用它对账面板、ai.ts 用它估地形），
   * 所以必须写在数据里，不能两边各写一个 3。
   */
  terrainArmor?: Array<{ terrains: Terrain[]; bonus: number }>;
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
  /**
   * 额外的发现距离（反潜声纳）。
   *
   * 返回值是"几格之外我也能看见它"，0 表示不比别人强。
   * 只影响**隐匿/潜航单位**在视野里现不现形，不改普通视野——
   * 后者是 `vision` 字段的事，两者别混。
   */
  detect?: (c: DetectCtx) => number;
  /** 免疫溅射 */
  immuneSplash?: boolean;
  /** false = 不能被治疗（机械） */
  healable?: boolean;
  /** 不引发反击（先手） */
  noCounter?: boolean;
    /**
   * 光环。可以写一条，也可以写一组——一组里每条自带 radius，
   * 于是"攻 +2 只覆盖相邻、移动 +1 覆盖两格"这种兵种可以写成两条。
   *
   * 数组顺序不重要：数值型光环由 auras.ts 合并，效果型光环
   * （治愈、灼烧……）根本不走这个字段。
   */
  aura?: AuraSpec | AuraSpec[];

  /**
   * 动态光环：数值和半径要按"此刻场上有谁"来算的，用这个。
   *
   * 静态 `aura` 是兵种数据里写死的一项，查询时原样返回；而「杀伐阵」要
   * "相邻有几个修士 / 最高几级"决定半径和加成，只能每次现算。
   *
   * 只在 `aurasOfUnit(s, u)` 里合并，所以面板、AI、伤害结算拿到的都是同一份。
   * 代价是它进了每次光环查询的热路径（移动力、攻击力、护甲都要扫一遍），
   * 里面别做 O(n²) 的事。
   */
  auraDynamic?: (c: { state: GameState; self: Unit }) => AuraSpec | AuraSpec[] | null;
  /** 这个能力涉及范围时的默认半径（供效果型光环等使用） */
  radius?: number;
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
      (u) => u.owner === self.owner && u.id !== self.id && distBetweenUnits(c.state, u, self) <= radius,
    ),
  ];
}
