/**
 * AI 对手。
 *
 * 战棋的状态空间大到别想全搜索：16×16、二十几个单位、每个单位十几种走法，
 * 一层的分支就是天文数字。所以这里用的是"一步前瞻 + 启发式打分"：
 * 把当前所有能做的动作列出来，各打一个分，挑最高的做，然后重新评估。
 *
 * 四条约束：
 *   1. 不看全图。AI 只吃 playerView 的结果，跟玩家一样受迷雾限制，
 *      否则它就是在作弊，你测出来的平衡也是假的。
 *   2. 确定性。整个决策过程不碰 Math.random：随机性由 (seed, 回合, 步数) 派生，
 *      所以同一局面永远同样应对，存档/回放/双 AI 观战都稳定；
 *      但每回合的值都不同，它不会永远只有一种打法。
 *   3. 有自己的偏好。推进欲望、兵种口味都从开局种子长出来，
 *      同一局里稳定，不同局之间不一样。
 *   4. 不做伤害玩家的特殊照顾。它就是一个贪心的、会算账的对手。
 */

import { hasAbility } from './abilities.ts';
import { CONFIG, ORDER_IDLE, ORDER_UPGRADE, navigable, passable } from './config.ts';
import { hasHold, holdOf, holdRoom } from './carry.ts';
import { isProducer, produceUsableCount } from './produce.ts';
import { cityGap } from './geo.ts';
import { playerView } from './fog.ts';
import { EFF_SCALE, unitEfficiency, unitPower } from './unit-value.ts';
import type { ValueContext } from './unit-value.ts';
import {
  armySize,
  applyAction,
  attackableTargets,
  buildSiteError,
  canAttack,
  cityAt,
  cityById,
  cityTiles,
  citiesOf,
  canStrike,
  computeDamage,
  crossesWater,
  terrainWalkable,
  damageToCity,
  disbandRefundOf,
  distance,
  distToCity,
  eggSpots,
  effectiveRangeAgainst,
  heroBlocked,
  heroSkillsOf,
  idx,
  inBounds,
  incomeOf,
  incomeResOf,
  ordersOf,
  orderSitesOf,
  airLayer,
  other,
  previewAttack,
  reachableTiles,
  rebuildCost,
  recruitCost,
  recruitPriceOf,
  recruitSpawnCells,
  recruitResCost,
  siegeTargets,
  stepCostBetween,
  supplyEraAt,
  tileAt,
  underConstruction,
  unitAt,
  unitYield,
  unitsOf,
  upgradeCostOf,
  utype,
  xyOf,
} from './rules.ts';
import { canUseType, eraWindowOk } from './draft.ts';
import { GOLD, canPay, payRes, resOf } from './resources.ts';
import type { ResourceCost } from './resources.ts';
import { economicYield, tacticalMap, unitValue } from './ai-tactics.ts';
import { terrainArmorOf } from './ability-registry.ts';
import type { TacticalMap } from './ai-tactics.ts';
import { seatsOf } from './types.ts';
import type { Action, AiIntent, City, GameState, PlayerId, Terrain, Unit, UnitTypeDef } from './types.ts';
// 档位 / 托管判定 / 预算这几个"元信息"住在 ai-meta.ts：它们要给界面用，
// 不该为了两行判断把整个引擎拉进首屏。这里只是转手引用（并继续对外导出）。
import type { AiBudget } from './ai-meta.ts';
import { DEFAULT_BUDGET, aiLevelOf, isAiSide } from './ai-meta.ts';

export type { AiBudget } from './ai-meta.ts';

const DIRS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

/**
 * 陆军距离图里"涉一格水"的估价。
 *
 * 不是合法走法，纯粹是给 AI 一个方向感：桥还没架起来的时候，
 * 它得知道"往那个方向走才有对面"，而不是站在河边算无穷远。
 * 定得比普通地面贵一个数量级，所以它永远优先走旱路、只在真的绕不过去时涉水。
 */
const WADE_COST = 14;

interface Candidate {
  action: Action;
  score: number;
}

export function aiActionKey(action: Action): string { return JSON.stringify(action); }

/* ---------------- 随机性：从状态派生，不碰 Math.random ---------------- */

/** 32 位混合，用来把 (seed, turn, step) 搅成一个稳定的数 */
function mix32(n: number): number {
  let h = n >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

/**
 * 本步的随机值（0~1）。
 *
 * 关键点：它不是"每次调用随机一次"，而是 (种子, 回合, 已推进步数) 的纯函数。
 * 同一局面调用两次结果相同 —— 这是存档、回放、双 AI 观战能对上的前提。
 * `s.log.length` 正好是"这回合已经走了几步"的天然计数：每个动作都会写日志。
 */
export function aiNoise(s: GameState, salt = 0): number {
  const h = mix32(mix32(s.seed ^ 0x9e3779b9) ^ (s.turn * 2654435761) ^ ((s.log.length + salt) * 40503));
  return h / 4294967296;
}

/**
 * 三种战术。
 *
 * 原来的 AI 只有一种性格：能打就打、能推就推，能量化的差别只有一个 appetite。
 * 于是整局看下来，它的开局、出兵、推进节奏几乎一模一样。战棋有意思的地方是
 * "对手这一局想干什么"，所以这里给它三种**真正不同**的打法：
 *
 *   · rush（速攻压制）：趁身价不落下风、对面还没成型，把兵力压到最近的那座城，
 *     用攻城把优势换成一座城。它几乎不为经济留预算。
 *   · harass（骚扰消耗）：正面打不穿时不硬碰，用机动单位和远程去切经济、切落单、
 *     切没人守的城。不换命、少围城，靠"对面越来越穷"赢。
 *   · boom（弃城爆发）：正面明显不如人、又有一座真的守不住的城时，主动放掉它——
 *     不在那儿填兵，把兵力和钱换成经济单位、时代升级和英雄。三种里唯一
 *     "主动亏一步"的打法，赚的是三四个回合后的代差。
 */
export type AiDoctrine = 'rush' | 'harass' | 'boom';


/**
 * 这局 AI 的性格：同一局里固定，不同种子不同。
 *
 * appetite 是"推进欲望"——0.85 保守、1.2 好战；
 * 兵种口味决定它偏爱的两个兵种，让它这局的部队组成和别人不一样；
 * instinct 是战术底色：局势没有明确信号时它天然偏向哪一种，以及这种偏向有多强。
 *
 * 底色不是为了"每局固定一种打法"——它是**迟滞**的替代品。AI 的决策必须是
 * 局面的纯函数（不能偷偷记"我上回合是什么战术"，否则存档一读就前后对不上），
 * 所以"不会来回横跳"这件事只能靠两样东西：一是这个从种子长出来的底色，
 * 二是下面那些宽阔的斜坡（ramp）——局势得明显偏向另一边，权重才会翻过去。
 */
export interface AiTraits {
  appetite: number;
  /** 这局偏爱的兵种 id（会得到额外权重） */
  favorites: string[];
  /** 战术底色 */
  instinct: AiDoctrine;
  /** 底色强度（0.10~0.22）：越强，越需要更强的局势证据才拨得动 */
  instinctStrength: number;
}

export function aiTraits(s: GameState): AiTraits {
  const h = mix32(s.seed ^ 0xc2b2ae35);
  const appetite = 0.85 + ((h % 1000) / 1000) * 0.35;

  const ids = Object.keys(s.unitTypes).sort();
  const favorites: string[] = [];
  if (ids.length > 0) {
    favorites.push(ids[h % ids.length] as string);
    favorites.push(ids[(h >>> 11) % ids.length] as string);
  }
  const instincts: AiDoctrine[] = ['rush', 'harass', 'boom'];
  const d = h >>> 5;
  const instinct = instincts[d % instincts.length] as AiDoctrine;
  // 底色只是压舱石，不能当方向盘：0.30 的底色叠在 1.7 次方锐化上，
  // 会把任何局势信号都压成噪声，AI 就变成"不管你怎么打，它都按性格来"。
  const instinctStrength = 0.10 + (((d >>> 7) % 100) / 100) * 0.12;
  return { appetite, favorites, instinct, instinctStrength };
}

/* ---------------- 战术倾向：这一回合该打哪一种 ---------------- */

/** 0~1 夹紧 */
function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * 线性斜坡：x ≤ a 得 0，x ≥ b 得 1，中间线性。
 *
 * 三种战术的所有判据都用它，而不是 `if (x > 阈值)`。理由是"切换自然"这件事
 * 只能靠渐变实现：硬阈值会让同一支部队在两个相邻回合里做出完全相反的决定
 * （第 11 回合全军压上、第 12 回合全军回撤），看起来像精神分裂。
 */
function ramp(x: number, a: number, b: number): number {
  if (b === a) return x >= b ? 1 : 0;
  return clamp01((x - a) / (b - a));
}

/**
 * 把 x 映射到 [-1, 1]：a 以下是 -1，b 以上是 +1，中间线性。
 *
 * 和 ramp 的区别是**中点**。ramp 的 0 落在 a 上，说的是"这个量从无到有"；
 * bipolar 的 0 落在 a、b 中间，说的是"这个量比中位高还是低"。
 * 战术证据要的是后者——见 aiMood 里那段注释。
 */
function bipolar(x: number, a: number, b: number): number {
  if (b === a) return x >= b ? 1 : -1;
  return clamp01((x - a) / (b - a)) * 2 - 1;
}

/** 一组 [权重, 信号] 的加权平均，结果留在 [-1, 1]。没有信号就是 0（中立）。 */
function blend(pairs: Array<[number, number]>): number {
  let num = 0;
  let den = 0;
  for (const [w, v] of pairs) {
    num += w * v;
    den += w;
  }
  return den > 0 ? num / den : 0;
}

/** 局势指标：全部来自视野内的局面，不带任何隐藏状态 */
export interface AiMoodMetrics {
  myVal: number;
  foeVal: number;
  /** 身价比：我 / 对面（对面为空时按 60 金折算，避免开局除零放大） */
  power: number;
  myIncome: number;
  foeIncome: number;
  army: number;
  /** 高机动突击单位数（骑兵、突击队这一档） */
  raiders: number;
  /** 真远程数（射程 ≥ 3） */
  ranged: number;
  /** 对面的机动/远程数：骚扰看的是"我比他灵活多少"，不是"我有多少" */
  foeRaiders: number;
  foeRanged: number;
  earners: number;
  /** 看得见的敌方经济/工程单位数：骚扰的目标就在这儿 */
  foeEco: number;
  era: number;
  foeEra: number;
  cities: number;
  /** 我军到最近敌城的距离（没有敌城 = 99） */
  focusDist: number;
  /** 敌方战斗单位压到我家城下的最近距离（没有 = 99） */
  gate: number;
  /** 最近一座守不住的城的危险度（0~1，没有 = 0） */
  doomed: number;
  /** 时代升级/英雄"够不够得着"（0~1）：boom 的兑现目标 */
  payoff: number;
}

export interface AiMood {
  lead: AiDoctrine;
  weight: Record<AiDoctrine, number>;
  /**
   * 加成强度：把"略微占优"当 0，只让"明确主导"出手。
   *
   * 三种权重平均就是三分之一。某一项刚到 0.38 的时候它只是略微领先，这时候
   * 就去改所有评分，会把局面里本来咬得很紧的选择（差几分的那种）整片压平——
   * 实测直接把"十二个回合里有三种选择"压成了两种，AI 反而更单调了。
   * 所以先减掉三分之一再放大三倍：≤0.33 全是 0，≥0.66 封顶 1，中间连续过渡。
   * 两项可以同时提供正向权重，因此过渡期间可以混合两种打法。
   */
  drive: Record<AiDoctrine, number>;
  /** 原始证据（未锐化、未加底色）：测试与复盘只看这一层 */
  evidence: Record<AiDoctrine, number>;
  /** 本回合的主攻方向（三种战术共用） */
  focusCityId: string | null;
  /** boom 主导时才非空：这一回合准备放掉的城 */
  abandonedCityId: string | null;
  metrics: AiMoodMetrics;
}

const DOCTRINES: AiDoctrine[] = ['rush', 'harass', 'boom'];
const ABANDON_AT = 0.42;

/**
 * 最危险的一座自家城：墙不满、敌人在门口。
 *
 * 它有两个用处：一是 boom 的"值得弃吗"判据，二是真的选出要放掉的那一座。
 * 只认**已经打到门口**(≤4 格)的城——离得远的不叫"守不住"，叫"还没打过来"。
 */
function doomedCity(
  myCities: City[],
  foeCombat: Unit[],
): { id: string; danger: number; core: boolean } | null {
  if (myCities.length === 0 || foeCombat.length === 0) return null;
  const maxEra = Math.max(...myCities.map((c) => c.era));
  // 唯一能产当代兵的那座城是"核心"，放了就等于把未来也一起放掉
  const cores = myCities.filter((c) => c.era >= maxEra).length;
  let best: { id: string; danger: number; core: boolean } | null = null;
  for (const c of myCities) {
    const nearest = foeCombat.reduce((m, u) => Math.min(m, distToCity(u, c)), Infinity);
    if (!Number.isFinite(nearest) || nearest > 4) continue;
    const danger =
      0.6 * ramp(7 - nearest, 1, 6) + 0.4 * (1 - c.hp / Math.max(1, c.maxHp));
    const core = c.era >= maxEra && cores <= 1;
    if (!best || danger > best.danger) best = { id: c.id, danger, core };
  }
  return best;
}

/**
 * 这一回合的战术倾向。
 *
 * 纯函数：只吃局面（调用方给的是 playerView 的结果），不碰 Math.random，
 * 也不记"上回合我是谁"。同一局面永远同一个答案——存档、回放、双 AI 观战都靠这条。
 *
 * 输出不是一个标签，而是一组连续权重。所有下游评分都按权重**加成分数**，
 * 而不是 `if (lead === 'rush')` 地分叉：这样两种战术交接的那一两个回合，
 * 部队会同时带着两边的心思（比如一边收拢一边还在摸经济），过渡才不突兀。
 */
export function aiMood(s: GameState, traits: AiTraits = aiTraits(s)): AiMood {
  const me = s.current;
  const foeId = other(me);
  const my = unitsOf(s, me);
  const foe = unitsOf(s, foeId);
  const def = (u: Unit) => utype(s, u.type);
  const value = (us: Unit[]): number =>
    us.reduce((n, u) => {
      const d = def(u);
      return d.category === 'combat' ? n + unitValue(s,u) * Math.max(0,u.hp) / Math.max(1,d.maxHp) : n;
    }, 0);

  const myVal = value(my);
  const foeVal = value(foe);
  // 对面清空时不能拿 0 做分母：开局两边都只有两个兵，比值会剧烈抖动
  const power = myVal / Math.max(60, foeVal);

  const myCombat = my.filter((u) => def(u).category === 'combat');
  const foeCombat = foe.filter((u) => def(u).category === 'combat');
  const myCities = citiesOf(s, me).filter((c) => !c.ruined);
  const foeCities = citiesOf(s, foeId).filter((c) => !c.ruined);
  const army = myCombat.length;
  const raiders = myCombat.filter((u) => isRaider(def(u))).length;
  const ranged = myCombat.filter((u) => (def(u).range ?? 1) >= 3).length;
  const foeRaiders = foeCombat.filter((u) => isRaider(def(u))).length;
  const foeRanged = foeCombat.filter((u) => (def(u).range ?? 1) >= 3).length;
  const earners = my.filter((u) => def(u).category === 'economy').length;
  const foeEco = foe.filter((u) => {
    const c = def(u).category;
    return c === 'economy' || c === 'builder' || economicYield(def(u))>0 || isProducer(def(u));
  }).length;

  const myIncome = Math.max(0, incomeResOf(s, me).gold ?? 0);
  const foeIncome = Math.max(0, incomeResOf(s, foeId).gold ?? 0);
  const era = myCities.length > 0 ? Math.max(...myCities.map((c) => c.era)) : 1;
  const foeEra = foeCities.length > 0 ? Math.max(...foeCities.map((c) => c.era)) : era;

  // 主攻方向：血最少的敌城，同血取离我军最近的。
  //
  // 试过把它改成"最划算的那座"（走过去几步 + 城墙剩多少 + 城里几个守军 一起算），
  // 想法是别追着地图另一头的残城跑。实测是**倒退**：同一批种子上胜率从 58.8%
  // 掉到 43.8%。原因是血最少的那座通常就是"已经在挨打的那座"，换个目标等于
  // 把围攻到一半的城丢下——残城会回血，回满就白打了。所以这条保持原样。
  //
  // （这段原来在 aiNextAction 里，移到 aiMood 是为了让"攻城价值"和"战术倾向"
  //  看同一个目标——两边各算一次的话，boom 收兵回防了、打分还在往老方向推。）
  const nearestOwn = (c: City): number =>
    my.reduce((m, u) => Math.min(m, distToCity(u, c)), Infinity);
  const focusCity = foeCities.reduce<City | null>((best, c) => {
    if (!best) return c;
    if (c.hp !== best.hp) return c.hp < best.hp ? c : best;
    return nearestOwn(c) < nearestOwn(best) ? c : best;
  }, null);

  let focusDist = Infinity;
  for (const c of foeCities) {
    for (const u of myCombat) focusDist = Math.min(focusDist, distToCity(u, c));
  }
  let gate = Infinity;
  for (const u of foeCombat) {
    for (const c of myCities) gate = Math.min(gate, distToCity(u, c));
  }
  const doom = doomedCity(myCities, foeCombat);
  const doomedEv = doom ? doom.danger : 0;

  // 下饵的候选：手里有两座城时，把**离敌人最近的那座非核心城**空出来。
  // 挑最近的是故意的——它最先挨打，能把对面的主力从留守的那座城上拉走；
  // 挑非核心是因为饵的最大价值就是被吃掉，核心城被吃掉叫崩盘。
  const sacrifice = (() => {
    if (myCities.length < 2) return null;
    const maxEra = Math.max(...myCities.map((c) => c.era));
    const cores = myCities.filter((c) => c.era >= maxEra).length;
    const candidates = myCities
      .map((c) => ({
        city: c,
        core: c.era >= maxEra && cores <= 1,
        near: foeCombat.length
          ? Math.min(...foeCombat.map((u) => distToCity(u, c)))
          : Infinity,
      }))
      .filter((x) => !x.core && Number.isFinite(x.near));
    if (candidates.length === 0) return null;
    return candidates.reduce((a, b) => (b.near < a.near ? b : a));
  })();
  // 留守的那座城必须真的安全：饵才能成立——对面一回头就能端了老窝，那不叫下饵。
  // 摘成函数是因为 doom 弃城也要过同一道闸：被打到门口的城可以放，
  // 但**剩下的城必须暂时安全**——否则就是敌人指哪弃哪，连环弃到全灭。
  const keptMinDist = (excludeId: string): number => {
    if (foeCombat.length === 0) return Infinity;
    const kept = myCities.filter((c) => c.id !== excludeId);
    if (kept.length === 0) return -Infinity;
    return Math.min(
      ...kept.map((c) => Math.min(...foeCombat.map((u) => distToCity(u, c)))),
    );
  };
  const keptSafe =
    myCities.length >= 2 && foeCombat.length > 0
      ? sacrifice !== null && keptMinDist(sacrifice.city.id) >= 6
      : false;

  // 兑现目标够不够得着：一次时代升级，或者一个英雄。
  // 攒不到头的"大计划"不是计划，是把钱冻住的借口——所以这里要打折看。
  const gold = s.players[me].gold;
  const inc = Math.max(1, myIncome);
  const eraCosts = myCities
    .map((c) => upgradeCostOf(s, c))
    .filter((x): x is number => x !== null);
  const eraReach =
    eraCosts.length > 0
      ? clamp01((gold + inc * 5) / Math.max(1, Math.min(...eraCosts)))
      : 0;
  const heroOwned = my.some((u) => def(u).hero);
  const heroCost = heroOwned
    ? null
    : (Object.values(s.unitTypes)
        .filter((d) => d.hero && d.category === 'combat' && d.era <= era)
        .sort((a, b) => (a.cost ?? 0) - (b.cost ?? 0))[0] ?? null);
  const heroReach = heroCost
    ? clamp01((gold + inc * 6) / Math.max(1, (heroCost.cost ?? 0) + (heroCost.unlockCost ?? 0)))
    : 0;
  const payoff = Math.max(eraReach, heroReach);

  // ── 证据 ──
  //
  // 每条证据都是"对中位局面的偏离"，不是"绝对水平"。
  //
  // 第一版写的是"若干条斜坡加权平均"（权重和 1、取值恒在 0~1）。看着干净，
  // 但三条证据的**基线**根本不一样：开局人人都有远程兵、人人都有两个农民，
  // 骚扰的机动项和软目标项一上来就给满，于是 24 个种子里 17 个被判成骚扰——
  // "三种战术"退化成了"一种战术"。教训是：**两方处境一样的常数项必须去掉**，
  // 对称的东西不构成任何一方的理由。
  //
  // 现在每个信号过一遍 bipolar()：中位局面返回 0，真偏了才给正负。三条证据
  // 在中位局面上都落在 0.5 附近，谁抬头只能靠局势，不能靠"这一项天生容易满格"。
  //
  // 每个区间的**中点**都摆在"常态值"上：两边各两个兵就是常态、两座城就是常态、
  // 射程 3+ 的兵各两个就是常态。这样中位局面严格给 0，不会因为"某项天生容易满格"
  // 就把三种战术里的一种顶起来——第一版栽的就是这个（见上面）。
  const powerEdge = bipolar(power, 0.85, 1.15);
  const eraEdge = era > foeEra ? 1 : era === foeEra ? 0 : -1;
  const mobilityEdge = raiders + ranged - (foeRaiders + foeRanged);

  // 速攻：身价压过对面、兵够多、敌城够得着、时代不落后。
  // 没有"回合还早"这一项——早期双方都没兵，那不是速攻的条件，是没法速攻。
  const rushEv = blend([
    [1.0, powerEdge],
    [0.8, bipolar(army, 3, 7)],
    [0.9, bipolar(14 - focusDist, 0, 4)],
    [0.6, eraEdge],
  ]);

  // 骚扰：正面打不穿（powerEdge 为负才算），但机动性压过对面，对面还有软目标。
  const harassEv = blend([
    [1.0, bipolar(mobilityEdge, -2, 2)],
    [0.9, bipolar(foeEco, 0, 4)],
    [1.0, -powerEdge],
    [0.6, bipolar(foeIncome - myIncome, -4, 4)],
  ]);

  // 弃城：身价落后、门口真有一座守不住的城、手里有能滚雪球的经济底子，
  // 而且兑现目标（升时代 / 解锁英雄）确实够得着。够不着就不算计划，叫许愿。
  // 下饵成立（两座城、留守的够安全、升级钱看得见）时，给 boom 一记强推——
  // 这是唯一一种"主动弃城"：不是被打得守不住才弃，是提前把一座城空出来当饵。
  const gambitOk =
    !!sacrifice && keptSafe && !doom
      && sacrifice.near <= 6 && power < 0.85 && earners >= 2 && payoff >= 1;
  const boomEv = blend([
    [1.0, -powerEdge],
    [0.9, bipolar(doomedEv, 0, 0.6)],
    [0.7, bipolar(earners, 0, 4)],
    [0.5, bipolar(myCities.length, 1, 3)],
    [0.9, bipolar(payoff, 0, 0.7)],
    ...(gambitOk ? [[1.1, 1.0] as [number, number]] : []),
  ]);

  const toEvidence = (v: number): number => clamp01(0.5 + 0.5 * v);
  const rush = toEvidence(rushEv);
  const harass = toEvidence(harassEv);
  const boom = toEvidence(boomEv);

  const evidence: Record<AiDoctrine, number> = { rush, harass, boom };

  // 底色：seed 决定这局"天生偏好哪一种"，强度 0.10~0.22。
  // 它同时是"不会横跳"的压舱石——局势证据要压过它，才拨得动战术。
  //
  // 上限从 0.30 收到 0.22：0.30 的底色叠在 1.7 次方锐化上，会把任何局势信号都
  // 压成噪声，AI 就变成"不管你怎么打，它都按性格来"。底色该是倾向，不是方向盘。
  const prior: Record<AiDoctrine, number> = { rush: 0, harass: 0, boom: 0 };
  prior[traits.instinct] = traits.instinctStrength;
  const raw: Record<AiDoctrine, number> = {
    rush: rush + prior.rush,
    harass: harass + prior.harass,
    boom: boom + prior.boom,
  };
  // 锐化：三种战术各占三分之一的话，行为会糊成一锅，谁也看不出它在打什么。
  // 1.7 次方把"略微领先"放大成"明确主导"，但仍是连续函数——不会一跳到底。
  const sharp: Record<AiDoctrine, number> = {
    rush: raw.rush ** 1.7,
    harass: raw.harass ** 1.7,
    boom: raw.boom ** 1.7,
  };
  const sum = sharp.rush + sharp.harass + sharp.boom;
  const weight: Record<AiDoctrine, number> = {
    rush: sum > 0 ? sharp.rush / sum : 1 / 3,
    harass: sum > 0 ? sharp.harass / sum : 1 / 3,
    boom: sum > 0 ? sharp.boom / sum : 1 / 3,
  };
  // 平手时按底色断：这就是"没有信号时按性格来"
  const lead = DOCTRINES.reduce<AiDoctrine>(
    (best, d) => (weight[d] > weight[best] ? d : best),
    traits.instinct,
  );

  // 弃城只在三个条件同时成立时才发生，缺一条都不行：
  //   1. boom 真的主导（不是"略微领先"）——它是最贵的一张牌，不能随手打；
  //   2. 那座城是真的守不住（威胁已经贴到城下、墙也掉了一半以上）；
  //   3. 换来的东西真的兑现得来（升时代/英雄的钱看得见）——看不见的叫许愿。
  //
  // 第 3 条是踩出来的：第一版只看权重，实测时代 3 的对局里弃城触发率超过一成，
  // 而那时账上根本攒不出升级钱，等于白白送掉一座产兵点——同一批种子下
  // 新 AI 的胜率从 52% 掉到 39%。弃城如果不能立刻换成代差，就只是丢了座城。
  //
  // 核心城（唯一能产当代兵的）永远不弃——那是把"以后"也一起弃了。
  // 后方必须安全，而且失去危城后的真实收入仍能在四回合内支持一次发展。
  // 留出一个回合给新生产者离开产兵格，避免一次正常采购就反向增援危城。
  const withdrawal = doom ? myCities.find(c => c.id===doom.id) : sacrifice?.city;
  const fallback = myCities.filter(c => c.id!==withdrawal?.id).find(c =>
    foeCombat.every(u => distToCity(u,c)>effectiveRangeAgainst(s,u,tileAt(s,c.x,c.y))+2));
  const localPower = (us: Unit[], city: City) => us.filter(u => distToCity(u,city)<=5)
    .reduce((n,u) => n+unitValue(s,u)*u.hp/Math.max(1,def(u).maxHp),0);
  const doomedObject = myCities.find(c => c.id===doom?.id);
  const hopeless = doomedObject ? localPower(foeCombat,doomedObject) > localPower(myCombat,doomedObject)*1.35+60 : false;
  const fallbackCost = fallback ? upgradeCostOf(s,fallback) : null;
  const retainedState = withdrawal ? {
    ...s,
    cities: s.cities.map(c => c.id === withdrawal.id ? { ...c, ruined: true } : c),
    // 已暴露在敌军附近的生产者不计入可保障收入。
    units: s.units.filter(u => u.owner !== me || economicYield(def(u)) === 0 ||
      foeCombat.every(e => distance(u,e) > effectiveRangeAgainst(s,e,tileAt(s,u.x,u.y))+2)),
  } : s;
  const retainedIncome = incomeResOf(retainedState,me);
  const canFund = (cost: ResourceCost) => Object.entries(cost).every(([id,n]) =>
    resOf(s.players[me],id) + Math.max(0,retainedIncome[id] ?? 0)*4 >= (n ?? 0));
  const canCashIn = !!fallback && (
    fallbackCost !== null && canFund({ gold: fallbackCost }) ||
    !heroOwned && Object.values(s.unitTypes).some(d => {
      if (!d.hero || d.category !== 'combat' || d.era > fallback.era || d.era < fallback.era-1) return false;
      const price = recruitResCost(s,me,d);
      const unlock = (s.unlocked?.[me] ?? []).includes(d.id) ? 0 : (d.unlockCost ?? 0);
      return canFund({ ...price, gold: (price.gold ?? 0) + unlock });
    })
  );
  const trulyLost = doom ? doom.danger >= 0.55 && hopeless : false;
  const doomKeptSafe = !doom || keptMinDist(doom.id)>=4;
  const gambitArmed = gambitOk && canCashIn && !doom && weight.boom>=0.5 && !!sacrifice && !sacrifice.core;
  const abandonedCityId =
    weight.boom >= 0.42 && doom && !doom.core && canCashIn && trulyLost
      && doomKeptSafe
      ? doom.id
      : gambitArmed
        ? sacrifice!.city.id
        : null;

  const drive: Record<AiDoctrine, number> = {
    rush: clamp01((weight.rush - 1 / 3) * 3),
    harass: clamp01((weight.harass - 1 / 3) * 3),
    // 保留连续的发展权重：前城失守后，安全后方仍需完成增产和科技兑现。
    // 非战术档由 aiActiveMood 统一屏蔽，现金预算与安全条件另行约束投资。
    boom: clamp01((weight.boom - 1 / 3) * 3),
  };

  return {
    lead,
    weight,
    drive,
    evidence,
    focusCityId: focusCity?.id ?? null,
    abandonedCityId,
    metrics: {
      myVal,
      foeVal,
      power,
      myIncome,
      foeIncome,
      army,
      raiders,
      ranged,
      foeRaiders,
      foeRanged,
      earners,
      foeEco,
      era,
      foeEra,
      cities: myCities.length,
      focusDist: Number.isFinite(focusDist) ? focusDist : 99,
      gate: Number.isFinite(gate) ? gate : 99,
      doomed: doomedEv,
      payoff,
    },
  };
}

/** 经济单位站在 (x,y) 能赚多少 */
function incomeAt(s: GameState, def: UnitTypeDef, x: number, y: number): number {
  const tile = s.tiles[y * s.w + x];
  if (!tile) return 0;

  let income = def.incomeByTerrain?.[tile.terrain] ?? def.income ?? 0;
  if (income > 0) {
    const nearWater = DIRS.some(([dx, dy]) => {
      const nx = x + dx;
      const ny = y + dy;
      if (!inBounds(s, nx, ny)) return false;
      return s.tiles[ny * s.w + nx]?.terrain === 'water';
    });
    if (nearWater) income += CONFIG.riverTradeBonus;
  }
  return income;
}

function resourceValue(s: GameState, owner: PlayerId, resources: Record<string,number | undefined>): number {
  const stock=s.players[owner];
  return Object.entries(resources).reduce((sum,[id,n]) => {
    const held=id==='gold' ? stock.gold : stock.res?.[id]??0;
    const weight=id==='gold' ? 1 : 1+2*clamp01(1-held/160);
    return sum+(n??0)*weight;
  },0);
}

/** (x,y) 会不会被敌方下回合打到（AI 只看得到的敌人） */
function inDanger(s: GameState, owner: PlayerId, x: number, y: number): boolean {
  const target = { x, y };
  for (const e of unitsOf(s, other(owner))) {
    const def = utype(s, e.type);
    if (distance(e, target) <= def.range) return true;
    for (const i of reachableTiles(s, e).keys()) {
      if (distance(xyOf(s, i), target) <= def.range) return true;
    }
  }
  return false;
}

/**
 * 地图有多"糙"：森林 + 丘陵占的比例。
 *
 * 这两种地形进门要 2 点移动力，所以 move 1 的单位一步都进不去。
 * 这不是"慢一点"，是"彻底出不了出生点"——它会一直占着产兵格，
 * 而产兵格被占着，城里就再也造不出兵。整支军队就此停摆。
 */
function roughShare(s: GameState): number {
  let rough = 0;
  for (const t of s.tiles) {
    if (t.terrain === 'forest' || t.terrain === 'hill') rough += 1;
  }
  return s.tiles.length > 0 ? rough / s.tiles.length : 0;
}

/**
 * 一个移动力为 move 的单位站在 (x,y)，能不能"走出这片地方"。
 *
 * excludeCityId：站在城里的时候要排除同城的格子——2×2 的城市内部本来就能互相走，
 * 但那不叫走得动。出不了城门，就是一辈子出不了城门。
 *
 * 返回能出去的相邻格数：0 表示四面都是森林/丘陵/水，这单位一出场就是块石头。
 */
/**
 * 这张图有多少水。
 *
 * 水军只在有水的地方有用，但"有水"和"能打"是两件事：
 * 实测水域占比从 1.8%（开阔）到 31%（双河）都有，而一张 20×20 里 3% 的水
 * 就是十几格的池塘——船在里面绕一圈就到底了，连过河都用不上。
 * 所以拿这个数当闸：太干的地图干脆不造船。
 */
function waterShare(s: GameState): number {
  let wet = 0;
  for (const t of s.tiles) if (t.terrain === 'water') wet += 1;
  return s.tiles.length > 0 ? wet / s.tiles.length : 0;
}

/** 水域低于这个比例就别造水军了（实测开阔/山岭图都在 2~7%，河图在 15~31%） */
const WATER_MIN_SHARE = 0.08;

/** 水域只是"将将够"的时候，水军只当补充，不当主力 */
const WATER_GOOD_SHARE = 0.14;

/**
 * 这片水值不值得养海军：0 = 船是奢侈品，1 = 船就是路。
 *
 * 以前采购里对水军只有两行固定减分（-8，水少时再 -10），等于默认"船没用"。
 * 但"没用"和"是唯一的路"是两件事：陆路走不到敌方城时，没有船这一局根本推不过去。
 * 判据分三档，宁可粗也不能漏掉第一档：
 *   · 陆路不通 → 1（真正的刚需）
 *   · 水域宽 → 0.5（船有回旋余地，能绕后、能抢浅滩）
 *   · 有水但窄 → 0.2（点缀，不改打法）
 */
function seaDemand(s: GameState, me: PlayerId): number {
  const wet = waterShare(s);
  if (wet < WATER_MIN_SHARE) return 0;
  if (!canReachEnemyByLand(s, me)) return 1;
  if (wet >= WATER_GOOD_SHARE) return 0.5;
  return 0.2;
}

function escapeRoutes(
  s: GameState,
  x: number,
  y: number,
  move: number,
  excludeCityId?: string | null,
  /** 要出门的是哪个兵种：水军活在水上、飞行兵能掠水，判据不一样 */
  typeId?: string,
): number {
  if (move <= 0) return 1;
  const def = typeId ? utype(s, typeId) : null;
  const waterUnit = def?.domain === 'water';
  const walker = def ? crossesWater(def) : false;
  let open = 0;
  for (const [dx, dy] of DIRS) {
    const nx = x + dx;
    const ny = y + dy;
    if (!inBounds(s, nx, ny)) continue;
    const tile = s.tiles[ny * s.w + nx];
    if (!tile) continue;
    /*
     * 判据不能再写 `passable()`：那是"陆军能不能走"。
     *
     * 这一句以前是 `!passable(tile.terrain) → 跳过`，于是水军的四邻全是水时
     * 它被判成"出不了城门"——一条船在开阔水面上没有一格"出口"，
     * 而这整段判断跟它能不能动毫无关系。飞行兵同理。
     */
    if (def && !terrainWalkable(def, tile.terrain)) continue;
    if (!def && !passable(tile.terrain)) continue;
    if (excludeCityId && tile.cityId === excludeCityId) continue;
    // 别的地方可能站着人，但那是暂时的；地形才是永久性的墙。
    // 出城要按"从城里往外走"的真实价算：往高处走还要加爬坡费。
    const from = s.tiles[y * s.w + x]?.terrain ?? null;
    const step = waterUnit || walker ? 1 : stepCostBetween(s, from, tile.terrain);
    if (step <= move) open += 1;
  }
  return open;
}

/** 这个单位现在是不是动不了 */
function isStuck(s: GameState, unit: Unit): boolean {
  const def = utype(s, unit.type);
  if (def.move <= 0) return false;
  return reachableTiles(s, unit).size === 0;
}

/* ---------------- 难度分档 ---------------- */

/**
 * 这局用哪一档 AI。
 *
 * 只影响"打分算得多细"，不影响"哪些动作是合法的"：
 * 地形、架桥、补兵、避坑这些是缺陷修复，三档共用。
 * 老存档没有这个字段，按高级处理——它才是修完的那一版。
 *
 * 注意别写成 `=== 'advanced'` 判断"高级以上"：那会把战术档漏掉。
 * 需要"至少高级"的地方一律用 `!== 'basic'`。
 */
/** 威胁图里"一只敌人占多少分"的系数：一只普通兵大约扣 3.4 分 */
const THREAT_K = 3.4;

/** 经济兵专用的系数：农民死了就是纯亏钱，怕得比战斗单位厉害得多 */
const ECON_THREAT_K = 13;

/**
 * (x, y) 下回合会被几只敌人打到。
 *
 * 和 inDanger 的区别：inDanger 只回答"有没有危险"，这里回答"有多危险"。
 * 战棋里贴着一个人和贴着五个人是两回事——前者叫接敌，后者叫送死。
 * 判据用 move + range 的一次移动射程：进能打到、退能拉开，都算在威胁圈里。
 */
function enemyThreatAt(
  s: GameState,
  owner: PlayerId,
  x: number,
  y: number,
): { n: number; dmg: number } {
  let n = 0;
  let dmg = 0;
  for (const e of unitsOf(s, other(owner))) {
    const def = utype(s, e.type);
    if (def.category !== 'combat') continue;
    const reach = def.move + Math.max(0, def.range);
    if (Math.abs(e.x - x) + Math.abs(e.y - y) > reach) continue;
    n += 1;
    // 威胁要连魔法段一起算。
    //
    // 只按 atk 估的话，法师在 AI 眼里是个"7 攻的废物"——它会心安理得地
    // 把兵停在法师脸上，然后被那 18 点魔攻（还不吃护甲）一炮带走。
    // 魔法段不吃护甲，所以这里不减那 2 点：它对重甲单位也照打。
    dmg += Math.max(0, def.atk - 2) + (def.magicAtk ?? 0);
  }
  return { n, dmg };
}

/** 某一方到某格最近的自家城（不算废墟、不算本回合准备放弃的那座）；没有城就 null */
function nearestCityGap(
  s: GameState,
  owner: PlayerId,
  at: { x: number; y: number },
  skipId: string | null,
): number | null {
  let best: number | null = null;
  for (const c of s.cities) {
    if (c.owner !== owner || c.ruined) continue;
    if (skipId && c.id === skipId) continue;
    const d = distToCity(at, c);
    if (best === null || d < best) best = d;
  }
  return best;
}

/**
 * 打一座桥值多少分；0 = 这一手不值得占一次攻击，干脆别想。
 *
 * 桥不是"战果"。拆掉它不减对面的兵、不涨我的兵，只是把一格地形改回水面——
 * 而"击杀"那一套账（120 + 造价）在桥身上特别容易成立：木桥只有几十点耐久，
 * 一发两发就塌，于是一次拆桥能拿到跟"打死一支骑士"一样的分数。
 * 表现出来就是 AI 见桥就打：部队走到河边先拿一轮齐射把桥拆了，
 * 然后自己过河还得重新架——纯粹是把自己这一回合扔进水里。
 *
 * 所以桥单独算，按"这座桥对谁有用"来：
 *
 *  一、死守：桥顶着自家城门（三格之内，且离我的城比离对面的城近）。
 *      拆掉它，对面的下一波就得绕路或者重新架桥，这是在替自己拆掉一条
 *      进攻路线。城越近越急，正在收缩固守的时候再加一点。
 *  二、进攻：桥在对面那一侧、我又在往前推。拆掉它掐的是对面的增援线，
 *      值一点分，但不值得为它放弃一次正经交换。
 *  三、其余（在攒钱、在收缩、已经放弃进攻、桥就在我过河的路上）：
 *      一分不给。"不需要死守、也不打算进攻"的时候还去拆桥，
 *      等于替对面把路修好了——反正桥是双向的，我打下来的桥我也要过。
 */
function scoreBridgeAttack(s: GameState, attacker: Unit, bridge: Unit, all: Fields): number {
  const at = { x: bridge.x, y: bridge.y };
  const me = attacker.owner;
  const mine = nearestCityGap(s, me, at, all.mood.abandonedCityId);
  const foe = nearestCityGap(s, other(me), at, null);
  if (mine === null) return 0;

  // 一、死守
  const holding = all.hold || all.guardCityId !== null;
  if (mine <= 3 && (foe === null || mine < foe)) {
    return 30 - mine * 4 + (holding ? 14 : 0);
  }

  // 二、进攻：桥已经在我推进的方向上（离对面的城更近），而且我没在收着打
  const pushing = !all.hold && all.mood.abandonedCityId === null && all.mood.drive.boom < 0.5;
  if (pushing && foe !== null && foe < mine) return 20;

  return 0;
}

function scoreAttack(s: GameState, attacker: Unit, target: Unit, all: Fields): number {
  const mood = all.mood;
  const preview = previewAttack(s, attacker, target);
  const targetDef = utype(s, target.type);
  const selfDef = utype(s, attacker.type);

  // 桥走自己那本账：它既不算击杀，也不吃"击杀 = 120"那一套（见 scoreBridgeAttack）
  if (targetDef.bridges) return scoreBridgeAttack(s, attacker, target, all);

  const kill = preview.toDefender >= target.hp;
  let score = kill ? 120 + targetDef.cost * 0.12 : (preview.toDefender / targetDef.maxHp) * 60;
  score -= (preview.toAttacker / selfDef.maxHp) * 45;

  // 溅射：一发打到一片，就按"额外伤害"折算成分数，否则 AI 只会盯着血最少的那一个，
  // 永远看不出"这一炮落在人堆里"的价值
  score += preview.toSplash * 1.6;

  // 交手本身就有价值。不加这一条，一次"打掉对方四成血、自己也挨四成"的互换只有几分，
  // 还不如往城里多走一格（9 分）——AI 就会绕着敌人走，永远不打仗。
  score += 14;
  if (aiLevelOf(s) !== 'basic') {
    const danger = cityThreatUrgency(s,target,attacker.owner);
    score += danger * (25 + 75 * Math.min(1,preview.toDefender / Math.max(1,target.hp)));
    score += Math.min(target.hp,preview.toDefender)/targetDef.maxHp * unitValue(s,target)*0.12;
    if (economicYield(targetDef)>0 || isProducer(targetDef)) score += 22*mood.drive.harass;
  }

  // 残血不硬拼
  if (attacker.hp / selfDef.maxHp < 0.4) score -= 15;

  // 高级：按"谁更贵"算这笔交换划不划算。
  //
  // 初级只看掉血比例，于是它会拿一个 380 金的坦克去换一个 25 金的民兵，
  // 因为两边都掉四成血，账面上打平——实际这一局已经输了。
  // 这里只有三个扣分项，都是在"我可能会死"的前提下才生效：
  // 平时该怎么打还怎么打，不死的仗不该因为贵就不打。
  if (aiLevelOf(s) !== 'basic') {
    const myValue = selfDef.cost;
    const theirValue = targetDef.cost;
    const iDie = preview.toAttacker >= attacker.hp;
    // 打不死对面、自己却要交代进去：最亏的一种，按价值比往死里罚
    if (iDie && !kill) score -= 55 * Math.min(3, myValue / Math.max(20, theirValue));
    // 换掉了，但换亏了：差价越大越不值
    if (iDie && kill) score -= Math.max(0, myValue - theirValue) * 0.18;
    // 已经残血还去打一个打不死的：这是在给对方送击杀
    if (attacker.hp / selfDef.maxHp < 0.3 && !kill) score -= 12 * Math.min(3, myValue / 80);


    // 高机动突击队偏爱后排：摸得到火力单位就优先打，能白打（对方够不着）更值。
    // 和移动那边是一套逻辑的两半——移动负责"绕到能打后排的位置"，
    // 这里负责"真到了别又去打最前面那个肉盾"。
    if (isRaider(selfDef)) {
      if (targetDef.range >= 3) score += 16;
      if (preview.toAttacker === 0) score += 8;
    }
  }

  /*
   * 集火：打的是这一回合全军约好的那个目标，就加分。
   *
   * 这一条不改"该不该打"，只改"先打谁"。分数取 26：高于"能打死一个单位"的
   * 120 那档之下、明显高于普通的掉血收益，但**不会**把"打不死"的仗变成"值得打"——
   * 一个本来就该被拒掉的糟糕交换，加 26 之后照样是负分。
   * 目标由 `pickFocusTarget` 每回合选一次，全军共用，这就是"成建制"的全部含义。
   */
  if (all.focusTargetId && target.id === all.focusTargetId) score += 26;

  // ── 战术倾向 ──
  // 一条攻击值多少分，取决于这一局想怎么赢：速攻要的是"城下这条路清干净"，
  // 骚扰要的是"对面养不起兵"，弃城期要的是"现在别开战"。
  const w = mood.drive;
  const targetCat = targetDef.category;
  if (targetCat === 'economy' || targetCat === 'builder') {
    // 骚扰的正业：对面那些不还手、却撑着整条产线的东西
    score += 24 * w.harass;
  }
  const dies = preview.toAttacker >= attacker.hp;
  if (dies && !kill) {
    // 换命的仗不划算——骚扰的全部资本就是"人还在"
    score -= 26 * w.harass;
  }
  if (preview.toAttacker === 0) score += 7 * w.harass;

  // 弃城期的胜利条件在四五个回合之后，不在这一个兵身上
  if (w.boom > 0.2 && mood.metrics.gate > 6) score -= 12 * w.boom;

  // 集中兵力：旁边每站一个能打的友军，这一拳就更值。
  //
  // 速攻第一版是"整体更凶"（位移分放大、压城门槛降低、攻城分上调），
  // 实测时代 3 从 50% 掉到 37.5%——旧 AI 本来就凶，再往上叠只是过度扩张。
  // 真正的"压制"不是更猛，是抱团：单送的兵是白送，抱团的交换比才立得住。
  if (w.rush > 0) {
    const support = unitsOf(s, attacker.owner).filter(
      (f) => f.id !== attacker.id
        && utype(s, f.type).category === 'combat'
        && utype(s, f.type).domain !== 'water'
        && distance({ x: target.x, y: target.y }, f) <= 2,
    ).length;
    score += Math.min(3, support) * 7 * w.rush;
  }

  return score;
}

function scoreSiege(
  s: GameState,
  attacker: Unit,
  city: City,
  focusCityId: string | null,
  mood: AiMood,
): number {
  const dmg = damageToCity(attacker, city, s);
  if (dmg <= 0) return -10;
  const capture = dmg >= city.hp;
  const attackerDef = utype(s, attacker.type);

  // 攻城直接通向胜利，权重给得比野战高；能打就打，别在城墙下晃。
  // 这一档整体抬过一次：以前破城的收益常常比"打掉一个杂兵"高不了多少，
  // AI 于是宁可在野战里刷人头，也不肯把兵力压到城下——而人头是赢不了棋的。
  let score = (capture ? 260 : (dmg / city.maxHp) * 62) + 26;

  // 战术倾向：速攻把攻城当唯一出路（破城是这套规则里唯一通向胜利的动作）；
  // 弃城期根本不往对面走。
  //
  // 骚扰这一档**不压攻城**。以前压过 0.25，理由是"围城要站桩、要挨打，那不是消耗"，
  // 听着有道理，实测是净亏：这游戏的胜利条件只有破城，一个不肯围城的 AI 只会
  // 把对局拖长，然后输在对方的第一次破城上。骚扰该做的是"少跟主力换命"，
  // 那一条在上面的野战评分里，不该跑到这儿来否定唯一的胜利路径。
  const w = mood.drive;
  score *= 1 - 0.45 * w.boom;

  // 破城专精（siege-master）本来就是为攻城而生的，不打城等于白拿这个能力
  if (hasAbility(attackerDef, 'siege-master')) score += 12;

  // 集中兵力：已经有几个友军贴着这座城，就越值得一起压上去。
  // 一座城的回血是每回合 3~6，一个人打是永远打不下来的。
  const mates = unitsOf(s, attacker.owner).filter(
    (u) => u.id !== attacker.id && distToCity(u, city) <= 1,
  ).length;
  score += mates * 10;

  // 残血收尾：城已经掉过半，优先补刀，别让它回血
  if (city.hp / city.maxHp < 0.5) score += 18;

  // 本回合的主攻方向
  if (city.id === focusCityId) score += 16;

  return score;
}

/**
 * 从一座敌方城市向外做地形代价的 Dijkstra，得到"走到那座城还要多少代价"。
 *
 * 为什么不能用曼哈顿距离：地图上有横贯的河，渡口只有几处。
 * 按直线距离算，"沿着河岸往渡口走"的那一步距离完全没有变近 —— 分数是 0，
 * 于是 AI 会永远停在河这边。一百回合打不了一次，根子就在这儿。
 * 按代价算，往渡口走的每一步都在减少剩余代价，它才会真的过河。
 *
 * 单位不参与这张图（它们每回合都在动，算进去只会让 AI 原地抖），
 * 所以它只是一张"地形怎么绕"的静态图。
 *
 * 三种口径，别混用：
 *   · `land`    —— 严格旱路。水面、高山都当墙，走不通就是 Infinity。
 *   · `advance` —— 涉水估算。山仍然是墙，但水面按 WADE_COST 计一个很贵的价。
 *   · `water`   —— 水军专用，只走水面和桥。
 *
 * 为什么会同时要 `land` 和 `advance`：只看 `advance` 的话，"渡河"在图上
 * 永远是最便宜的一步（14 点，比绕半个地图的地形代价还小），于是 AI 全军的
 * 最优解变成"走到最近的河边停住"——它不会穿墙，但也不会绕路，就贴着河岸
 * 站到天荒地老。严格旱路把墙算成真墙，它才会真的去走能走的道；而涉水图
 * 保留下来，只用来兜底"对岸根本走不过去"的那种局（整片海把两家隔开，
 * 旱路上处处是 Infinity，AI 会彻底失去方向感）。
 */
export function cityDistanceField(
  s: GameState,
  city: City,
  mode: 'land' | 'advance' | 'water' | 'air' = 'land',
): number[] {
  const size = s.w * s.h;
  const dist: number[] = new Array(size).fill(Infinity);
  const queue: Array<{ i: number; cost: number }> = [];

  for (const t of cityTiles(city)) {
    const i = idx(s, t.x, t.y);
    if (!inBounds(s, t.x, t.y)) continue;
    dist[i] = 0;
    queue.push({ i, cost: 0 });
  }

  while (queue.length > 0) {
    // 棋盘才两三百格，线性挑最小比写堆更省事，也不会慢到哪去
    let pick = 0;
    for (let k = 1; k < queue.length; k++) {
      if ((queue[k]?.cost ?? 0) < (queue[pick]?.cost ?? 0)) pick = k;
    }
    const cur = queue.splice(pick, 1)[0];
    if (!cur || cur.cost > (dist[cur.i] ?? Infinity)) continue;

    const { x, y } = xyOf(s, cur.i);
    for (const [dx, dy] of DIRS) {
      const nx = x + dx;
      const ny = y + dy;
      if (!inBounds(s, nx, ny)) continue;
      const tile = s.tiles[ny * s.w + nx];
      if (!tile) continue;

      if (mode === 'air') {
        /*
         * 空中的图：**没有地形**，每一格都是一步。
         *
         * 这一张图是"飞机为什么不出门"的答案。以前飞行单位借的是陆军的
         * 旱路图（山是墙、水是墙），于是在海岸线上 `advanceDistance` 前后都是
         * 无穷远，走一格"推进分"永远是 0——可达格明明白白列着 68 格深水，
         * 它就是一格都不去，看着像"飞机不能飞过深水"，其实是它算不出该往哪飞。
         *
         * 敌方城市仍然是目标本身，照旧进图（不然所有距离都是无穷远）。
         */
      } else if (mode === 'water') {
        // 水军的图只走水面：深水、桥面、浅滩都算
        // （浅滩是水军抄近路的地方，不是只有陆军能过）
        if (!navigable(tile.terrain)) continue;
      } else if (mode === 'land') {
        // 严格旱路：水面和高山一样是墙
        if (!passable(tile.terrain)) continue;
      } else if (!passable(tile.terrain) && tile.terrain !== 'water') {
        // 涉水估算：过不去的地形（山、火山）仍然是墙，水给"很贵但有限"的价
        continue;
      }

      // 反向搜索必须使用“邻格走向当前格”的价；平均上下坡费用会低估爬坡。
      const fromT = s.tiles[cur.i]?.terrain ?? 'plain';
      const backCost = stepCostBetween(s, tile.terrain, fromT);
      const cost =
        cur.cost +
        (mode === 'water' || mode === 'air'
          ? 1
          : tile.terrain === 'water'
            ? WADE_COST
            : backCost);

      const ni = ny * s.w + nx;
      if (cost < (dist[ni] ?? Infinity)) {
        dist[ni] = cost;
        queue.push({ i: ni, cost });
      }
    }
  }
  return dist;
}

/**
 * 把严格旱路和涉水估算拼成一张"该往哪走"的图：旱路走得通就按旱路，
 * 旱路走不通的地方，用涉水梯度垫底。
 *
 * 垫底值必须比这张图上**任何**一条真实旱路都大：否则"站到河边"会以
 * 98 分打败"绕远路"的 60 分，AI 又回到贴着河岸发呆的老样子。
 * 所以先量出旱路图上最远的那个值（span），再拿 span + 余量当底座。
 */
export function mergeAdvanceField(land: number[], wade: number[]): number[] {
  let span = 0;
  for (const v of land) if (Number.isFinite(v) && v > span) span = v;
  const base = span + 8;

  const out: number[] = new Array(land.length);
  for (let i = 0; i < land.length; i++) {
    const l = land[i] ?? Infinity;
    if (Number.isFinite(l)) {
      out[i] = l;
      continue;
    }
    const w = wade[i] ?? Infinity;
    out[i] = Number.isFinite(w) ? base + w : Infinity;
  }
  return out;
}

/** 一次性把所有敌方城市的距离图算出来，供本回合所有兵种共用 */
function distanceFields(
  s: GameState,
  me: PlayerId,
  mode: 'land' | 'advance' | 'water' | 'air' = 'land',
): Map<string, number[]> {
  const out = new Map<string, number[]>();
  for (const c of s.cities) {
    if (c.owner === me) continue;
    out.set(c.id, cityDistanceField(s, c, mode));
  }
  return out;
}

/**
 * 两套图：fighter 用"推进图"（旱路优先、涉水兜底），水军用 water；
 * `wade` 单独留着量"桥的另一头离敌方城市多远"——架桥选址必须跨过水面看，
 * 用严格旱路图的话对岸永远是 Infinity，AI 就永远找不到该架桥的地方。
 */
/**
 * 战线在哪：我方最靠前的那四分之一战斗单位推到哪了。
 *
 * 只算陆军（水军的推进是另一套：目标是临水敌城，见 `nearestEnemyPort`）。
 * 取 25% 分位而不是最小值，是为了"让**部分**军队停下来"——只拦最冒尖的那几个，
 * 后面的人还照常往前压，整条线才会收拢，而不是全体原地立正。
 *
 * 少于 3 个兵时返回 -Infinity（谁都不拦）：两三个兵还互相等，这一局就不用打了。
 */
function frontLineRef(
  s: GameState,
  owner: PlayerId,
  fields: Map<string, number[]>,
  focusCityId: string | null,
): number {
  const ds: number[] = [];
  for (const u of unitsOf(s, owner)) {
    const def = utype(s, u.type);
    if (def.category !== 'combat' || def.domain === 'water') continue;
    const d = advanceDistance(s, owner, u.x, u.y, fields, focusCityId);
    if (Number.isFinite(d)) ds.push(d);
  }
  if (ds.length < 3) return -Infinity;
  ds.sort((a, b) => a - b);
  const i = Math.min(ds.length - 1, Math.max(0, Math.floor(ds.length * 0.25)));
  return ds[i] ?? -Infinity;
}

/**
 * 站位密度图：每格相邻 8 格里有几个我方战斗单位。
 *
 * 不把自己算进去（否则一个兵站在哪儿哪儿就"挤"），所以每次只在 8 邻格上记一笔。
 */
function crowdField(s: GameState, owner: PlayerId): Uint8Array {
  const out = new Uint8Array(s.w * s.h);
  for (const u of unitsOf(s, owner)) {
    if (utype(s, u.type).category !== 'combat') continue;
    for (let dy = -1; dy <= 1; dy += 1) {
      const y = u.y + dy;
      if (y < 0 || y >= s.h) continue;
      for (let dx = -1; dx <= 1; dx += 1) {
        if (dx === 0 && dy === 0) continue;
        const x = u.x + dx;
        if (x < 0 || x >= s.w) continue;
        out[y * s.w + x] += 1;
      }
    }
  }
  return out;
}

/**
 * 这一回合全军该集火的那一个敌人。
 *
 * 判据只有一条朴素的原则：**算"几刀能砍死"，再乘"有几个人够得着"**。
 *   · 越容易死（残血）越该先集火——打死一个就少一份输出；
 *   · 越值钱越该先集火——打掉一个法师等于打掉对面一半伤害；
 *   · 够得着的人越多越该集火——"四个人一起上"和"一个人上去换"是两种结局。
 *
 * 只在**看得见的**敌人里挑（`s` 是迷雾视图），不偷看。
 * 一个够得着的都没有就返回 null，攻击评分退回原来的"各自挑最优"。
 */
function pickFocusTarget(s: GameState, me: PlayerId): string | null {
  const foes = unitsOf(s, other(me)).filter((u) => utype(s, u.type).category === 'combat');
  if (foes.length === 0) return null;
  const mine = unitsOf(s, me).filter(
    (u) => utype(s, u.type).category === 'combat' && !u.acted,
  );
  if (mine.length === 0) return null;

  let best: { id: string; score: number } | null = null;
  for (const f of foes) {
    const def = utype(s, f.type);
    let reach = 0;
    for (const u of mine) {
      const ud = utype(s, u.type);
      // 这一步能不能扑上去打：移动力 + 射程 +1 的余量
      if (distance(u, f) <= Math.max(1, ud.move) + (ud.range ?? 1) + 1) reach += 1;
    }
    if (reach === 0) continue;
    const worth = (def.cost ?? 50) * (1 + Math.max(0, 1 - f.hp / Math.max(1, def.maxHp)) * 1.5);
    const score = (worth * reach) / Math.max(1, f.hp);
    if (!best || score > best.score) best = { id: f.id, score };
  }
  return best?.id ?? null;
}

interface Fields {
  tactical: TacticalMap;
  land: Map<string, number[]>;
  wade: Map<string, number[]>;
  water: Map<string, number[]>;
  /**
   * 空中的距离图：地形不存在，每格一步。
   *
   * 飞行单位必须用它量推进——借陆军的图会得到"对岸永远无穷远"，
   * 于是飞机宁可原地待命也不出海（可达格其实是有的）。见 cityDistanceField。
   */
  air: Map<string, number[]>;
  bridgeSite: { x: number; y: number } | null;
  /**
   * 本回合的主攻方向：血最少的那座敌方城市。
   *
   * 没有这个"聚焦"，AI 的部队会一半扑这座城、一半扑那座城，
   * 每一边都只是把城墙刮花，然后被城市回血修回去——围城永远围不下来。
   */
  focusCityId: string | null;
  /**
   * 佯攻方向（第二翼）：离主攻方向最远的那座敌城，没有就是 null。
   *
   * 只靠 `focusCityId` 一个目标时，全军会挤成一条线压同一座城：对面把主力
   * 摆在那一座前面就够了，剩下几座城等于不存在。人在这种局面下会分一路去牵制，
   * 逼对面分兵。判据与分派见 `flankSplit`。
   */
  flankCityId: string | null;
  /**
   * 这一回合被分到佯攻那一翼的单位 id。
   *
   * 用 id 集合而不是"按距离现算"，是因为分派要考虑"整支部队怎么分"
   * （不能让佯攻那一路比主攻还厚），每个单位单独按距离判断做不到这件事。
   */
  flank: Set<string>;
  /**
   * 这一回合的战术倾向（见 aiMood）。
   *
   * 放在 Fields 里，是因为它和距离图一样属于"整回合共用"的东西：每个候选
   * 动作都要读它，一个单位十来种走法、十个单位就是上百次——重算就是白烧时间。
   */
  mood: AiMood;
  /**
   * 收缩固守：这一回合不往外推。
   *
   * 不是"不打仗"，是"不为了一格推进把阵型拉散"。判断依据见 buildPlan：
   * 兵力明显不如对面、又没人压到城下时，最好的选择往往是把人留在城里、
   * 把钱攒起来升时代——而不是用更少的兵去换对面的换血。
   */
  hold: boolean;
  /**
   * 优势期：兵力和身价都压过对面一截，这时候该做的是**破城**，不是清野。
   *
   * 战棋里"赢"只有一个方向——把对面的城全变成自己的。可推进评分里除了城市
   * 还有一路"最近的敌军"，权重 1.15 比城市那一路还高，于是哪怕己方兵力是
   * 对面的两倍，全军也还是会被路过的敌军牵着走：追着人打、城墙永远没人碰，
   * 一百多回合打成平局。优势的时候把这一路关掉，部队才会真的朝城下压。
   */
  commit: boolean;
  /**
   * 这一回合该守哪座城（没有就 null）。
   *
   * 城市回血有两道硬条件（rules.cityRegenOf）：**城里得有人**、**城外一圈没敌人**。
   * 满足就是每回合 +3 耐久，站在城格上的部队还多 3 点护甲。
   * 以前 AI 的走位里根本没有"驻军"这个概念：全军永远朝敌方城市走，自家城墙
   * 从 30 掉到 9 也一直空着——等于白送对面一条回血规则。实测一局里同一座城
   * 在 9/30 上挂了三十个回合，谁路过都能拆，翻来覆去易主。
   */
  guardCityId: string | null;
  /**
   * 我方现在纯走旱路摸不到敌方城市（河把两家隔开了）。
   *
   * 这种情况下的"推进"没有意义：距离图里隔着水，怎么走都只是沿着河岸平移。
   * 真正该做的是往桥头集结、把桥铺过去。
   */
  needBridge: boolean;
  /**
   * 战线：我方**最前面那一批**战斗单位推到哪了（推进距离，越小越靠前）。
   *
   * "集结"不是让所有人挤成一团——挤在一起正好被溅射一锅端。真正的集结是
   * **队形**：最前面那几个人停下来等，后面的人往上补，整条线一起压过去。
   * 所以需要的不是"距离队友多近"，而是"我比战线还靠前多少"。
   * 没有战线（少于 3 个兵、或算不出来）时取 -Infinity，也就是"谁都不许停"。
   */
  lineRef: number;
  /**
   * 站位密度：每格相邻 8 格里站了几个我方战斗单位（不含自己）。
   *
   * 溅射是这片战场上最贵的伤害形式，而"两个人挨着站"等于主动把一份伤害变成两份。
   * 这个图就是用来让部队保持间隔的——**集成度靠战线，间隔靠它**，两件事分开管。
   */
  crowd: Uint8Array;
  /** 视野里有多少敌方单位带溅射：决定"挨着站"该罚多重 */
  foeSplash: number;
  /**
   * 这一回合全军该集火的那一个敌人（见 `pickFocusTarget`）。
   *
   * 成建制不是"站在一起"，是**打在一个点上**。AI 缺的正是这一步：
   * 每个兵各自挑一个"自己这一刀最划算"的目标，于是五个人打五个目标，
   * 每个都打到半血，对面回一轮血、换一个目标，全程没人被击杀。
   * 线上 15 局人机局里 AI 造 432 个兵死了 375 个（87%），人类同期只死 114 个——
   * 交换比难看成这样，很大一部分不是伤害不够，是伤害散了。
   */
  focusTargetId: string | null;
  /**
   * 这张图值不值得养海军（0~1，见 `seaDemand`）。
   *
   * 建造评分要用它：船坞造不造，取决于"船是不是唯一的路"，而不是"离敌人多近"。
   * 放进 Fields 是因为 `seaDemand` 里有一趟全图连通性搜索——每个候选格子
   * 各算一次，等于拿几百次洪泛去换一个每回合都不变的数。
   */
  sea: number;
  /**
   * 局势现在打在第几代（见 `eraNowOf`）。
   *
   * 建造也要问这一句：带白名单的产兵点（船坞三代 / 造船厂五代 / 海军船台七代）
   * 落成时会把时代钉死，提前修就是一块石头。AI 不该提一个注定白费的建造。
   */
  era: number;
}


/**
 * 我方能不能纯走旱路摸到敌方城市（贴到城墙一圈就算摸到）。
 *
 * 这是"该不该造桥"的总开关：能走过去，桥就只是捷径；
 * 走不过去，桥就是唯一的通路，全军的行动目标都得换。
 */
function canReachEnemyByLand(s: GameState, owner: PlayerId): boolean {
  const foe = s.cities.filter((c) => c.owner !== owner);
  if (foe.length === 0) return true;

  const seen = new Set<number>();
  const queue: number[] = [];
  for (const u of unitsOf(s, owner)) {
    if (utype(s, u.type).domain === 'water') continue;
    const i = u.y * s.w + u.x;
    if (seen.has(i)) continue;
    seen.add(i);
    queue.push(i);
  }

  while (queue.length > 0) {
    const i = queue.pop() as number;
    const x = i % s.w;
    const y = Math.floor(i / s.w);
    if (foe.some((c) => distToCity({ x, y }, c) <= 1)) return true;

    for (const [dx, dy] of DIRS) {
      const nx = x + dx;
      const ny = y + dy;
      if (!inBounds(s, nx, ny)) continue;
      const j = ny * s.w + nx;
      if (seen.has(j)) continue;
      const t = s.tiles[j];
      if (!t || !passable(t.terrain)) continue;
      // 敌城格不可通行，但"摸到它旁边"上面已经判过了
      if (t.cityId) {
        const c = cityById(s, t.cityId);
        if (c && c.owner !== owner) continue;
      }
      seen.add(j);
      queue.push(j);
    }
  }
  return false;
}

/**
 * 找一处最值得架桥的水面。
 *
 * 判据三条：两边的陆地都通得到（说明这是条真正的河/沟，不是海）、
 * 两边到敌方城市的代价差不多（说明是横向的河，不是绕远的海湾）、
 * 离自己人越近越优先（工程队不想跑半个地图）。
 */
function bestBridgeSite(s: GameState, owner: PlayerId, wade: Map<string, number[]>): { x: number; y: number } | null {
  const mine = unitsOf(s, owner).filter((u) => utype(s, u.type).domain !== 'water');

  let best: { x: number; y: number } | null = null;
  let bestScore = -Infinity;

  for (let y = 0; y < s.h; y++) {
    for (let x = 0; x < s.w; x++) {
      if (s.tiles[y * s.w + x]?.terrain !== 'water') continue;
      if (unitAt(s, x, y)) continue;

      const gap = bridgeGap(s, x, y, wade);
      if (!gap) continue;

      let near = Infinity;
      for (const u of mine) near = Math.min(near, distance(u, { x, y }));
      if (!Number.isFinite(near)) near = 20;

      // 已经铺出去一段的桥要接着铺。
      //
      // 上一版没有这一条，工程队每回合都重新挑"看起来最近"的水面：这回合在
      // 河中间架一格、下回合挪到隔壁十格再架一格，两格宽的水道永远只有一格桥，
      // 铺到第 200 回合还是过不去。以场地为准而不是以"哪近"为准。
      //
      // chain 只认"顺着同一条直线往外接"：挨着自己桥面还不够，那一座必须正好
      // 挡在近岸和自己的中间。否则一排横着铺也是"相邻"，AI 会把一条路修成
      // 三格宽的广场（实测里真干过：先横着铺三格，再往上铺两格，河心就停住了）。
      const back = unitAt(s, x - gap.dir[0], y - gap.dir[1]);
      const chain = back && back.owner === owner && utype(s, back.type).bridges ? 1 : 0;

      // 窄优先（少铺几座桥）、离自己人近优先、对岸离敌方城市近优先
      const score = gap.steps * -9 - near * 1.1 - gap.farDist * 0.5 + chain * 30;
      if (score > bestScore) {
        bestScore = score;
        best = { x, y };
      }
    }
  }

  return best;
}

/**
 * 这块水面值不值得架桥：从它出发，往哪个方向、跨几格水能上岸。
 *
 * 以前用"四邻有两片陆地"当判据，只能识别一格宽的水沟。一条 3 格宽的河，
 * 岸边那一格水面只有一侧是陆地，按老判据永远判不出"该在这儿架桥"——
 * 于是无渡口的地图上，AI 的工程队一步都不会动。所以改成按方向量"水有多长"。
 *
 * @returns steps 需要的桥面数；farDist 上岸那一格到敌方城市的代价；
 *          dir 这一跨的走向（从近岸指向对岸），用来判断下一格是不是"顺着接"
 */
function bridgeGap(
  s: GameState,
  x: number,
  y: number,
  wade: Map<string, number[]>,
): { steps: number; farDist: number; dir: [number, number] } | null {
  let best: { steps: number; farDist: number; dir: [number, number] } | null = null;

  for (const [dx, dy] of DIRS) {
    // 身后得是陆地或已经架好的桥，否则这桥不通向任何地方
    if (!inBounds(s, x - dx, y - dy)) continue;
    const back = s.tiles[(y - dy) * s.w + (x - dx)];
    if (!back || !passable(back.terrain)) continue;

    let steps = 0;
    let cx = x;
    let cy = y;
    let far: { x: number; y: number } | null = null;
    for (let k = 0; k < 4; k++) {
      if (!inBounds(s, cx, cy)) break;
      const t = s.tiles[cy * s.w + cx];
      if (!t) break;
      if (passable(t.terrain)) {
        far = { x: cx, y: cy };
        break;
      }
      if (t.terrain !== 'water') break; // 山挡着，别想
      steps += 1;
      cx += dx;
      cy += dy;
    }
    // 最多铺 4 座：再宽就不值得（也没有那么多回合给工程队挥霍）
    if (!far || steps === 0 || steps > 4) continue;

    let farDist = Infinity;
    for (const field of wade.values()) {
      const d = field[far.y * s.w + far.x];
      if (d !== undefined && d < farDist) farDist = d;
    }
    if (!Number.isFinite(farDist)) continue;

    const cand = { steps, farDist, dir: [dx, dy] as [number, number] };
    if (!best || cand.steps < best.steps || (cand.steps === best.steps && cand.farDist < best.farDist)) {
      best = cand;
    }
  }

  return best;
}

/**
 * 站在 (x, y) 上，离"该去的地方"还有多远——数字越小越靠前。
 *
 * 之前这里直接把绝对距离当分数（`-goal * 4`），而候选动作有个"分数必须大于 0"的门槛，
 * 于是只要离敌人超过十来格，所有移动都是负分，全被丢掉：AI 招完兵就站着不动。
 * 移动的分数必须是**相对"原地不动"的增量**，才谈得上"推进"这件事。
 *
 * 分数取"到各敌方城市代价图距离 × 权重"和"到最近敌军距离"里的最小值：
 *   · 城市用代价图（会绕河找渡口），主攻方向（focus）权重压到 0.32 —— 比别处低一大截，
 *     等于让全军朝着一座城收，而不是四个方向各派一路人各挠一下；
 *   · 可见敌军用曼哈顿距离，权重 1.15。它比城市"贵"一点，是为了在野战里先解决挡路的，
 *     而不是从敌军阵列中间穿过去。
 *
 * 两个坑都试过，别再踩回去：
 *   1. 把敌军那一路直接删掉（"目标只能是城"）——实测更差：32×32 上从 63 次攻城
 *      掉到 40 次、城市掉血从 249 掉到 199。原因是没人清屏，部队一路撞在对方的
 *      前排上，反而推不到城下。
 *   2. 把 focus 权重压得更极端（0.2）——也变差（37 次 / 168 血）。0.32 是量出来的甜点：
 *      太松就各打各的，太紧就全挤在一条路上被一起打。
 *
 * 主攻方向和"同血取最近"这条一起看：focus 选谁，全军就往谁那儿收。
 *
 * `ignoreFoes` 是优势期的开关（见 Fields.commit）：只在"我明显比对面强"时打开，
 * 让部队直接压城。劣势或均势时照旧算敌军那一路——不然谁挡路都不管，会被合围吃掉。
 */
function advanceDistance(
  s: GameState,
  owner: PlayerId,
  x: number,
  y: number,
  fields: Map<string, number[]>,
  focusCityId: string | null = null,
  ignoreFoes = false,
): number {
  let best = Infinity;
  for (const c of s.cities) {
    if (c.owner === owner) continue;
    const field = fields.get(c.id);
    const d = field?.[y * s.w + x];
    if (d === undefined || !Number.isFinite(d)) continue;
    // 主攻方向权重压得很低：同一个位置，往那座城走"近得多"。
    // 0.32 是量出来的（见上面的注释）：0.5 太松、全军各扑一座城，
    // 0.2 太紧、全挤在一条路上被一起打。20×20 和 32×32 的城市掉血都翻了一倍多。
    const weight = c.id === focusCityId ? 0.32 : 0.85;
    best = Math.min(best, d * weight);
  }
  if (ignoreFoes) return best;
  for (const e of unitsOf(s, other(owner))) {
    best = Math.min(best, distance({ x, y }, e) * 1.15);
  }
  return best;
}

/**
 * 这回合该守哪座城：城墙不满、或者敌人已经摸到附近的那一座。
 *
 * 都"没事"就返回 null——满血又没人来的城不需要留人，守城是有机会成本的。
 */
function pickGuardCity(
  s: GameState,
  me: PlayerId,
  foe: Unit[],
  abandoned: string | null = null,
): string | null {
  let best: { id: string; danger: number } | null = null;
  for (const c of citiesOf(s, me)) {
    if (c.ruined) continue;
    // 已经决定放弃的城不派人守：往一个"注定要丢"的地方填兵，
    // 等于把弃城换成"城没了、兵也没了"——那是最差的一种结局。
    if (c.id === abandoned) continue;
    const hpFrac = c.hp / c.maxHp;
    let nearest = Infinity;
    for (const u of foe) {
      if (utype(s, u.type).category !== 'combat') continue;
      nearest = Math.min(nearest, distToCity(u, c));
    }
    const threat = Number.isFinite(nearest) ? Math.max(0, 9 - nearest) : 0;
    const danger = threat + (1 - hpFrac) * 12;
    if (danger < 3) continue;
    if (!best || danger > best.danger) best = { id: c.id, danger };
  }
  return best?.id ?? null;
}

/** Rescue value is tied to real siege damage, including an exposed last city. */
export function cityThreatUrgency(s: GameState, enemy: Unit, owner: PlayerId): number {
  const cities = citiesOf(s,owner).filter(c => !c.ruined);
  let urgency = 0;
  for (const city of cities) {
    const range = effectiveRangeAgainst(s,enemy,tileAt(s,city.x,city.y));
    const d = distToCity(enemy,city);
    if (d>range+2) continue;
    const damage = damageToCity(enemy,city,s);
    if (damage<=0) continue;
    urgency = Math.max(urgency, Math.min(1.5,damage/Math.max(1,city.hp))
      * (d<=range ? 1 : 0.4) * (cities.length===1 ? 1.4 : 1));
  }
  return urgency;
}

/**
 * 最近的一座"有出海口的敌城"，距离按"贴到它旁边还要几步"算。
 *
 * 没有临水格的敌城对水军没有意义——船开过去也只能隔着陆地干瞪眼。
 * 港口判定用的是 `cityGap <= 1`，所以这里是 `cityGap - 1`（贴上去记 0）。
 */
function nearestEnemyPort(
  s: GameState,
  at: { x: number; y: number },
  owner: PlayerId,
): number {
  let best = Infinity;
  for (const c of s.cities) {
    if (c.owner === owner || c.ruined) continue;
    // 这座城市有没有临水格：有才值得把船开过去
    let hasPort = false;
    for (let dy = -1; dy <= c.size && !hasPort; dy += 1) {
      for (let dx = -1; dx <= c.size && !hasPort; dx += 1) {
        const inside = dx >= 0 && dx < c.size && dy >= 0 && dy < c.size;
        if (inside) continue;
        const t = s.tiles[(c.y + dy) * s.w + (c.x + dx)];
        if (t && navigable(t.terrain)) hasPort = true;
      }
    }
    if (!hasPort) continue;
    best = Math.min(best, Math.max(0, cityGap(c, at) - 1));
  }
  return best;
}

/**
 * 这条船此刻封住了几座敌城（上限 3）。
 *
 * 规则在海军扩展里：船贴着敌城外港，那座城每回合少收 8 金，最多三座。
 * 以前 AI 对这条一无所知——船只会去追敌人的船，海岸线空着也不去堵，
 * 实测 20×20 群岛 8 局：1354 个"城-回合"里一次封锁都没有。
 */
function blockadeCount(s: GameState, at: { x: number; y: number }, owner: PlayerId): number {
  let n = 0;
  for (const c of s.cities) {
    if (c.owner === owner || c.ruined) continue;
    if (cityGap(c, at) <= 1) n += 1;
  }
  return Math.min(3, n);
}

/**
 * 这块地**对这个兵**值多少护甲。
 *
 * 和以前那句 `CONFIG.terrainDef[terrain] * k` 的区别是主语：
 * 老写法问的是"丘陵值多少"，新写法问的是"树人站丘陵值多少"。
 * 后者 = 地形本身的掩体 + 这个兵种自己的地形加成（林地之主 +3）。
 *
 * 空中单位一律 0：它不吃地形掩体（rules 的 effectiveStats 同一条规则），
 * 让 AI 为"站高地"去挪一架飞机是纯浪费。
 */
function tileDefenseValue(def: UnitTypeDef, terrain: Terrain): number {
  if (airLayer(def)) return 0;
  return (CONFIG.terrainDef[terrain] ?? 0) + (terrainArmorOf(def).get(terrain) ?? 0);
}

/**
 * 「守点」分值：这一格现在值不值得站着不动。
 *
 * 为什么需要它：走位候选里只有"去哪"，**从来没有"不动"**。只要还能走一步，
 * AI 就一定会挪——于是树人从丘陵挪到平地，白丢 3 点甲（6→9 甲变 6 甲），
 * 而它换来的往往只是 0.5 分的地图推进。这就是"树人不会一夫当关"的根因。
 *
 * 判据三条，缺一不可：
 *   1. 脚下这格对这个兵**确实有防御价值**（≥2 甲）。平地一律不守，否则全军躺平。
 *   2. 它是守得住的兵：慢（移动 ≤2）、近战（射程 1）、甲厚（≥5）。
 *      骑兵和远程该去拉扯，钉在点上反而浪费机动。
 *   3. 附近（4 格内）真有敌人要来，而且现在站得住（不是必死）。
 *
 * 另外压两条：全军压城（commit）时不守——那时候要的是破城不是对峙；
 * 隘口（能站人的邻格 ≤2）额外加权，这才是"一夫当关"的形状。
 */
function holdScore(s: GameState, unit: Unit, all: Fields, traits: AiTraits): number {
  const def = utype(s, unit.type);
  if (def.category !== 'combat' || def.domain === 'water') return -Infinity;
  if (all.commit) return -Infinity;
  const tile = tileAt(s, unit.x, unit.y);
  if (!tile) return -Infinity;
  const guard = tileDefenseValue(def, tile.terrain);
  if (guard < 2) return -Infinity;
  if (def.move > 2 || def.range > 1 || def.armor < 5) return -Infinity;
  const exposure = all.tactical.exposure(unit);
  if (exposure.lethal) return -Infinity;
  const foe = unitsOf(s, other(unit.owner));
  if (!foe.some((e) => distance(e, unit) <= 4)) return -Infinity;
  let open = 0;
  for (const [dx, dy] of DIRS) {
    const t = tileAt(s, unit.x + dx, unit.y + dy);
    if (t && passable(t.terrain)) open += 1;
  }
  const choke = open <= 2 ? 1.7 : open <= 3 ? 1.25 : 0.7;
  const adjacent = foe.some((e) => distance(e, unit) <= 1);
  return guard * 3.4 * choke * traits.appetite * (adjacent ? 1.3 : 1) + (exposure.damage === 0 ? 5 : 0);
}

function tacticalMoveScore(s: GameState, unit: Unit, x: number, y: number, all: Fields, traits: AiTraits): number {
  const def = utype(s, unit.type);
  const moved = { ...unit, x, y, moved: true };
  const currentThreat = all.tactical.exposure(unit);
  const futureThreat = all.tactical.exposure(moved);
  if (def.category === 'economy') {
    const gain = resourceValue(s,unit.owner,unitYield(s,moved)) - resourceValue(s,unit.owner,unitYield(s,unit));
    return gain * 5 - 1.5 + (currentThreat.damage-futureThreat.damage) * 2
      - futureThreat.damage * 1.5 - (futureThreat.lethal ? 100 : 0);
  }
  const w = all.mood.drive;
  const fields = airLayer(def) ? all.air : def.domain === 'water' ? all.water : all.land;
  /*
   * 这一路该朝哪座城走：主攻方向，还是自己那一翼的佯攻方向。
   *
   * 两翼是这一版补的"阵型意图"（见 `flankSplit`）。以前全军只有 `focusCityId`
   * 一个目标，于是所有人挤一条线压同一座城——对面只要把主力摆在那一座前面，
   * 剩下几座城就等于不存在。人不会这么打：一路压正面，另一路去牵制/绕后。
   */
  const objective = all.flank.has(unit.id) && all.flankCityId ? all.flankCityId : all.focusCityId;
  const before = advanceDistance(s,unit.owner,unit.x,unit.y,fields,objective,all.commit);
  const after = advanceDistance(s,unit.owner,x,y,fields,objective,all.commit);
  const progress = Number.isFinite(before) && Number.isFinite(after) ? before-after : 0;

  /*
   * ── 集结：让跑得最前的那几个停下来等 ──
   *
   * 这一段替代了我上一版写错的东西。上一版做的是"往队友身边靠"，也就是奖励
   * `距离队友变近`——那是把部队揉成一团，正好送给对方一发溅射。而且实测是负收益
   * （48 局子集 60.4%，不如不加）。
   *
   * 真正的集结是**队形**：整条线一起压过去，不是谁跑得快谁先死。所以判据换成
   * "我比战线还靠前多少"——已经在战线前面的那几个，这一回合不再拿推进分，
   * 于是它们会停下来找掩护、拉间隔、等能打的目标；后面的人照常推进，线自然收拢。
   *
   * 只在**没有压城**（`!commit`）时生效：全军已经决定强攻的时候还互相等，
   * 等于把优势让回去。水域单位不参与（它们的战线是另一套）。
   */
  const aheadOfLine =
    !all.commit &&
    def.category === 'combat' &&
    def.domain !== 'water' &&
    // 空中的距离是"每格一步"，和地面的战线长度不是一个量纲：
    // 拿它去比 lineRef，飞机几乎永远算"在战线前面"，推进分反而被砍到 15%。
    !airLayer(def) &&
    // 英雄和攻城器不吃这条：它们本来就是"单点突破"的工具，跟着队形走反而不会打仗。
    // 实测英雄档从 15 胜 1 负掉到 11 胜 5 负，就是被这条拦住的原因。
    def.hero !== true &&
    !(def.abilities ?? []).includes('siege-master') &&
    Number.isFinite(all.lineRef) &&
    before < all.lineRef;
  const advanceWeight = aheadOfLine ? 0.15 : 1;
  let score = progress * 6 * traits.appetite * (1 + (all.needBridge ? 0 : w.rush*0.35)) * advanceWeight;
  /*
   * 地形分：**这一格对这个兵**值多少护甲，而不是"这一格值多少"。
   *
   * 老写法是全兵种共用一个数，于是"树人站丘陵（6 甲 +3 林地之主 +2 丘陵 = 9 甲）"
   * 和"民兵站丘陵（2+2）"在决策层是同一个分数——AI 自然学不会把树人放进林子里。
   */
  score += tileDefenseValue(def, tileAt(s, x, y)!.terrain) * 1.5 - 1;

  /*
   * ── 间隔：别挨着站 ──
   *
   * 和"集结"是两件事，分开管：上面管"别跑太快"，这里管"别贴太紧"。
   * 对面有溅射单位时罚得重（一发下去两份伤害），没有时也留一点——
   * 挤在一起还会互相挡路：能打到人的格子被自己人占了。
   */
  if (def.category === 'combat' && all.foeSplash > 0) {
    const crowd = all.crowd[y * s.w + x] ?? 0;
    if (crowd > 0) score -= crowd * 3;
  }
  let nextAttack = 0, nowAttack = 0;
  let killed: string | undefined;
  if (canAttack(unit)) {
    for (const enemy of attackableTargets(s,unit)) nowAttack = Math.max(nowAttack,scoreAttack(s,unit,enemy,all));
    for (const enemy of attackableTargets(s,moved)) {
      const value = scoreAttack(s,moved,enemy,all);
      if (value > nextAttack) {
        nextAttack = value;
        killed = previewAttack(s,moved,enemy).toDefender >= enemy.hp ? enemy.id : undefined;
      }
    }
    for (const city of siegeTargets(s,unit)) nowAttack = Math.max(nowAttack,scoreSiege(s,unit,city,all.focusCityId,all.mood));
    for (const city of siegeTargets(s,moved)) {
      const value=scoreSiege(s,moved,city,all.focusCityId,all.mood);
      if (value>nextAttack) { nextAttack=value; killed=undefined; }
    }
    score += nextAttack * 0.82 - nowAttack * 0.65;
  }
  const risk = all.tactical.exposure(moved,killed);
  const cost = unitValue(s,unit);
  const loss = risk.damage / Math.max(1,def.maxHp);
  score -= loss * (25 + Math.min(60,cost*0.18)) * (1 + w.harass*0.4);
  if (risk.lethal) score -= 30 + Math.min(75,cost*0.2);
  score += Math.max(0,currentThreat.damage-risk.damage) / Math.max(1,def.maxHp) * 25;

  /*
   * 两回合威胁（`TacticalMap.soon`）：下回合还够不着、下下回合就够得着的人，
   * 按半价计入。上面那两项罚的都是"眼前这一刀"，而人判断一个落点靠的是
   * "这波人要扑上来了"——六格外磨刀的重骑兵在旧算法里等于不存在，
   * 于是 AI 会站在开阔地中间，等它走到跟前才发现被围了。
   * 罚得比眼前那一刀轻（同样的伤害在这里只算 12~42 分），够用它躲开空地就行。
   */
  const soonRisk = all.tactical.soon(moved, killed);
  score -= Math.max(0, soonRisk.damage - risk.damage) / Math.max(1,def.maxHp) * (12 + Math.min(30,cost*0.1));

  if (all.needBridge && all.bridgeSite) score += (distance(unit,all.bridgeSite)-distance(moved,all.bridgeSite))*4;
  for (const city of s.cities) {
    if (!city.ruined || city.id === all.mood.abandonedCityId) continue;
    const affordable = s.players[unit.owner].gold >= rebuildCost(city);
    const a = distToCity(unit,city), b = distToCity(moved,city);
    score += (a-b)*(affordable ? 35 : 4);
    if (b===0) score += affordable ? (city.owner===unit.owner ? 150 : 220) : -200;
  }
  if (w.harass > 0 && def.category === 'combat') {
    const prey = unitsOf(s,other(unit.owner)).filter(e => {
      const d = utype(s,e.type);
      return economicYield(d)>0 || d.category==='builder' || isProducer(d);
    }).sort((a,b) => distance(unit,a)-distance(unit,b))[0];
    if (prey && distance(unit,prey)<=12) score += (distance(unit,prey)-distance(moved,prey))*4*w.harass;
  }
  const keep = citiesOf(s,unit.owner).filter(c => !c.ruined && c.id!==all.mood.abandonedCityId);
  if (keep.length && (all.mood.abandonedCityId || all.hold)) {
    const a = Math.min(...keep.map(c => distToCity(unit,c))), b = Math.min(...keep.map(c => distToCity(moved,c)));
    score += (a-b)*(all.mood.abandonedCityId ? 7 : 3)*Math.max(0.4,w.boom);
  }
  if (all.guardCityId) {
    const city = cityById(s,all.guardCityId);
    if (city && !unitsOf(s,unit.owner).some(u => u.id!==unit.id && distToCity(u,city)===0)) {
      score += (distToCity(unit,city)-distToCity(moved,city))*4;
      if (distToCity(moved,city)===0 && distToCity(unit,city)>0) score += 16;
    }
  }
  // 海军的推进目标：**最近的临水敌城**，不是焦点城。
  //
  // 焦点城常常在内陆，水路距离算不出来（Infinity），于是船的 progress 恒为 0——
  // 实测 4 局里 9 条船只走了 33 步，基本在自家港口附近晃。换成"临水敌城"之后
  // 船才有方向感，封港也才可能发生（之前 34,854 次走位评估里只有 15 次能封到）。
  if (def.domain === 'water' && def.category === 'combat') {
    const portNow = nearestEnemyPort(s, unit, unit.owner);
    const portNext = nearestEnemyPort(s, moved, unit.owner);
    if (Number.isFinite(portNow) && Number.isFinite(portNext)) {
      score += (portNow - portNext) * 5;
    }

    // 封港：多封住一座城 +16（一座城每回合少收 8 金，三座封顶）。
    score += (blockadeCount(s, moved, unit.owner) - blockadeCount(s, unit, unit.owner)) * 16;

    // 护航：队里有载着人的运输船时，别让它一个人过海。
    // 只看"载了货"的船——空船在港口等着，护航舰不该陪着一起发呆。
    const convoy = unitsOf(s, unit.owner).find(
      (u) => u.id !== unit.id && hasHold(utype(s, u.type)) && (u.cargo?.length ?? 0) > 0,
    );
    if (convoy) {
      score += (distance(unit, convoy) - distance(moved, convoy)) * 3;
    }
  }
  return score;
}

function scoreMove(
  s: GameState,
  unit: Unit,
  x: number,
  y: number,
  all: Fields,
  traits: AiTraits,
): number {
  const def = utype(s, unit.type);
  const tile = s.tiles[y * s.w + x];
  if (!tile) return -999;
  if (aiLevelOf(s) !== 'basic' && def.category !== 'builder' && !s.config.godMode) {
    return tacticalMoveScore(s, unit, x, y, all, traits);
  }

  // 水军要按"水路的距离"算，否则它的起点在图上是无穷远，永远算不出方向
  // 飞机按空中的图算（地形不存在），水军按水路，其余按旱路
  const fields = airLayer(def) ? all.air : def.domain === 'water' ? all.water : all.land;

  // 经济单位：哪儿赚得多去哪儿
  if (def.incomeByTerrain || typeof def.income === 'number') {
    const gain = incomeAt(s, def, x, y) - incomeAt(s, def, unit.x, unit.y);
    const base = gain * 4 - 1.5;
    if (aiLevelOf(s) === 'basic') return base;

    // 高级：农民也是钱。一块多赚 2 金的地，不值得站在两个敌人的射程里种——
    // 被摸掉一只，等于那块地白种十几回合。
    // 后半截 (nowTh.n - th.n) * 5 是"脱险奖励"：已经被人围着的时候，
    // 哪怕新位置一分钱不赚，只要离威胁圈更远就值得挪。
    const th = enemyThreatAt(s, unit.owner, x, y);
    const nowTh = enemyThreatAt(s, unit.owner, unit.x, unit.y);
    return base - th.n * ECON_THREAT_K + (nowTh.n - th.n) * 5;
  }

  // 建造者：能架桥就先往值得架桥的水边去，否则回城待命
  //
  // 这里以前返回的是"-距离"这样的绝对负分，而候选动作有"分数必须大于 0"
  // 的门槛 —— 于是工程队除了站在原地，哪也去不了，桥全靠碰运气。
  // 移动的分数必须是"比原地好多少"。
  if (def.category === 'builder') {
    let score: number;
    if ((def.builds ?? []).some((id) => s.unitTypes[id]?.bridges)) {
      const site = all.bridgeSite;
      const mine = unitsOf(s, unit.owner).filter((u) => utype(s, u.type).bridges).length;
      if (site && mine < 6) {
        const step = distance(unit, site) - distance({ x, y }, site);
        // 过河阶段：往桥头走就是当前最重要的任务，给一个压过"顺手盖个磨坊"的底分
        score = (all.needBridge ? 42 : 0) + step * 6;
      } else {
        score = 0;
      }
    } else {
      score = 0;
    }

    if (score === 0) {
      const own = citiesOf(s, unit.owner);
      if (own.length === 0) return -999;
      const before = Math.min(...own.map((c) => distToCity(unit, c)));
      const after = Math.min(...own.map((c) => distToCity({ x, y }, c)));
      score = (before - after) * 3;
    }

    // 建造者是最贵的"一次性消耗品"：造价不比一线兵便宜，却几乎没有还手之力。
    // 所以它的走位要额外避让：往敌人射程里挪是拿 130 金换一座磨坊。
    //
    // 但过河阶段要放宽：对岸一排远程隔着河盯着，工程队按"安全第一"就永远走不到
    // 桥头，整局都过不去。这时架桥是唯一的战略目标，值得冒这个险。
    if (inDanger(s, unit.owner, x, y)) score -= all.needBridge ? 10 : 34;
    // 挨过打就先撤，别硬撑着把工事修完
    if (unit.hp / def.maxHp < 0.6 && inDanger(s, unit.owner, x, y)) score -= 26;
    // 待在自己城边上比较安全，偏远角落只有被人摸上来这一种结局
    const ownCities = citiesOf(s, unit.owner);
    if (ownCities.length > 0) {
      const near = Math.min(...ownCities.map((c) => distance({ x, y }, c)));
      if (near > 10) score -= 12;
    }
    return score;
  }

  // 手长的单位不往前顶。
  //
  // "推进"这套评分是给近战写的：距离变近就是好事。但弓手往前挪的收益是 0
  // （它在该距离上本来就能打），代价却是把自己送进对方近战的怀里、还丢掉地形。
  // 所以这里加两条硬约束，而不是一刀切"不许动"：
  //   ① 挪过去还得打得到人（不能为了推进放弃输出）
  //   ② 不许把自己挪到跟敌人贴脸的位置（除非本来就被贴着，那是突围）
  // 有了这两条，弓手会自己停在射程边缘：再往前一步就是白送。
  //
  // engagedNow = "我现在就够得着人"。够得着的时候不该为了再近一格而挪窝。
  const engagedNow =
    attackableTargets(s, unit).length + siegeTargets(s, unit).length > 0;

  if (def.range >= 2 && canAttack(unit) && engagedNow) {
    const moved = { ...unit, x, y };
    const afterTargets =
      attackableTargets(s, moved).length + siegeTargets(s, moved).length;
    if (afterTargets === 0) return -999;

    const foes = unitsOf(s, other(unit.owner));
    const nowAdjacent = foes.some((e) => distance(unit, e) <= 1);
    const nextAdjacent = foes.some((e) => distance({ x, y }, e) <= 1);
    if (nextAdjacent && !nowAdjacent) return -999;
  }

  // 战斗单位：按"往前推进了多少"给分，原地不动就是 0 分
  const before = advanceDistance(s, unit.owner, unit.x, unit.y, fields, all.focusCityId, all.commit);
  const after = advanceDistance(s, unit.owner, x, y, fields, all.focusCityId, all.commit);
  const progress = Number.isFinite(before) && Number.isFinite(after) ? before - after : 0;

  // 已经在输出的人（射程内有人、贴着城）不再为了"前进一格"而挪窝：
  // 换来的那点推进分，抵不过离开掩体、离开射程边缘的代价。
  // 侧移和后撤仍然允许——挨打时该撤还是要撤。
  if (def.range >= 2 && engagedNow && progress > 0) return -999;

  // 一格 ≈ 9 分。这个量级要和"招兵 50 分"错开：
  // 招募预算用完之前它先补兵，用完就该往前压，而不是站着发呆。
  // 乘上这局的性格：好战的 AI 更愿意往前顶，保守的更爱站地形。
  let score = progress * 9 * traits.appetite;

  // 战术倾向对"往前推"的态度（见 aiMood）：
  //   · 速攻：推进就是目的本身，位置分整体抬高；
  //   · 弃城：这一回合的任务是收人、攒钱，往前一格反而是把兵送到没用的地方；
  //   · 骚扰：不加不减——它的方向由下面那条"软目标坡度"决定，不是城墙。
  const w = all.mood.drive;
  // 过河阶段把速攻系数摘掉：兵还没过河，"更快压上去"是句空话。留着它只会
  // 让工程队被"往桥头挪一格"抢走整回合——桥的原始分本来只比挪一格高十几分，
  // 位移分再乘 1.45 就反超了，实测直接退化成"两座桥铺到河心就不动了"。
  const aggr = all.needBridge ? 0 : w.rush;
  score *= 1 + 0.45 * aggr - 0.3 * w.boom;

  // 河把两家隔开的时候，"往前推"这件事在距离图上是平的：
  // 沿着河岸走，离敌方城市的涉水距离一点没变（进度 0 分），
  // 于是全军会停在岸边发呆。这时候真正的"往前"是往桥头靠。
  if (all.needBridge && all.bridgeSite) {
    const before = distance(unit, all.bridgeSite);
    const after = distance({ x, y }, all.bridgeSite);
    score += (before - after) * 3.5;
  }

  // 站高地：按"这个兵站上去能多多少甲"算（空中单位在 tileDefenseValue 里已是 0）
  score += tileDefenseValue(utype(s, unit.type), tile.terrain) * 2;

  // 挪过去就能打到人 → 很值（这就是"接敌"的全部意义）。
  // 已经接上火的就不再给这份奖励，否则"往敌人方向平移一格"永远比开火划算。
  const moved = { ...unit, x, y };
  if (canAttack(unit) && !engagedNow && attackableTargets(s, moved).length > 0) {
    score += 30 * (1 + 0.5 * w.rush);
  }

  // 挪过去就能攻城 → 更值（攻城是唯一通向胜利的路，比多打掉一个兵重要）
  // 速攻对这条的溢价最高：它整局的胜负就压在一次成功的围城上。
  if (canAttack(unit) && !engagedNow && siegeTargets(s, moved).length > 0) {
    score += 44 * (1 + 0.7 * w.rush);
  }

  // 附近有待收的废墟时，朝它走这件事本身就值钱。
  //
  // 只给"踏进去"那一步加分是不够的：士兵在五格外的时候，那一步还没出现在候选里，
  // 它就照旧往别的城走；等走到城下，对面也把城修好了或者干脆没人去。
  // 所以这里给一条朝向废墟的坡度——每近一格值 35 分，比普通推进（9 分）高得多。
  //
  // 掏不起重建费的时候也要给一条**细**坡度（10 分）：这时候全军会往废墟边上
  // 集结等钱，而不是散到地图另一头。这条是配合 buildPlan 的 'rebuild' 计划用的——
  // 钱在攒、人却走了，等于白攒。
  for (const rc of s.cities) {
    if (!rc.ruined) continue;
    // 已经决定放弃的城不往回搬：弃城的全部意义就是"别在这儿花钱、别在这儿死人"，
    // 重建它等于把这几个回合攒的东西又埋回去。
    if (rc.id === all.mood.abandonedCityId) continue;
    const affordable = s.players[unit.owner].gold >= rebuildCost(rc);
    const perTile = affordable ? 35 : rc.owner === unit.owner ? 8 : 10;
    const before = distToCity(unit, rc);
    const after = distToCity({ x, y }, rc);
    if (before > 0) score += (before - after) * perTile;
  }

  // 走进废墟 = 接管城市。这是"破城"之后的唯一收尾动作，而且要给重建费。
  //
  // 这条是补规则的：城市耐久归零之后不再易主，只是变成废墟（不产兵、不产出、不回血），
  // 必须派兵走进去、付重建费才算拿下。AI 以前不知道这回事——它照旧在城墙外面转，
  // 一座已经打空的城就那么摊在那儿，双方都不去收，最后靠回合上限判个平局。
  //
  // 给的分比"破城"（260）略低：破城是打赢，接管是收尾；但比任何野战都高得多，
  // 因为废墟不收，前面那几十回合全是白打。自己的废墟同理——那是产线断了，得赶紧修。
  const destCity = cityAt(s, x, y);
  if (destCity?.ruined) {
    const price = rebuildCost(destCity);
    if (s.players[unit.owner].gold >= price) score += destCity.owner === unit.owner ? 150 : 220;
    // 钱不够就**别走进去**：doMove 会拒绝，AI 这一回合就卡死在这一步上
    else score -= 90;
  }

  // 残血别往枪口上撞
  if (unit.hp / def.maxHp < 0.5 && inDanger(s, unit.owner, x, y)) score -= 25;

  // 高级：威胁图。
  //
  // 上面那条 inDanger 是开关式的：有人能打到就扣 25，一个和五个一样多。
  // 真正决定胜负的是"几个"——所以这里按敌人数量、自己的身价、自己的残血程度
  // 三条一起加权：
  //   · 越贵的单位越怕死（坦克不该去换路口）；
  //   · 越残的越怕死（已经掉了一半血还往人堆里钻，等于白送）；
  //   · 已经被围住的时候，往外挪一步本身就是收益。
  //
  // 这一条是高级和初级差别最大的地方：初级会为了一格推进把炮送到刀口下，
  // 高级宁可原地蹲着等下一回合——这就是"走位刁"的来源。
  if (aiLevelOf(s) !== 'basic') {
    const hpFrac = unit.hp / def.maxHp;
    const th = enemyThreatAt(s, unit.owner, x, y);
    const nowTh = enemyThreatAt(s, unit.owner, unit.x, unit.y);
    // 身价归一化到 0~3.2：民兵 0.45、坦克 3.2 封顶
    const myValue = Math.min(3.2, def.cost / 55);
    score -= th.n * THREAT_K * myValue * (1 + (1 - hpFrac) * 1.5);
    if (hpFrac < 0.5) score += (nowTh.n - th.n) * 10;
  }

  // 高机动突击单位：目标不是"往前推"，而是"绕到后面去"。
  //
  // 这条是后来补的。以前 AI 对骑兵和步兵一视同仁——都按"离敌方城市近了多少"给分，
  // 于是骠骑兵、胸甲骑兵、突击队全都冲在最前面挨集火，机动性只剩下"更快地送死"
  // （实测工业骑兵交换比 0.45、每百金杀伤 10.1，连步枪兵的三分之一都不到）。
  // 现在高级 AI 会做三件事：
  //   ① 找后排猎物（射程 ≥3 的火力单位，或比自己更贵的东西），往它身上靠；
  //   ② 躲开敌方近战主力的贴身范围——贴上去等于白挨一轮，这不是"冲锋"；
  //   ③ 残血时按威胁数量反向外撤，而不是继续往人堆里钻。
  // 这三条加起来才是"机动"的价值：不是走得远，是能选一个对方打不到你的角度。
  if (aiLevelOf(s) !== 'basic' && isRaider(def)) {
    const prey = nearestPrey(s, unit, def);
    if (prey) {
      const step = distance(unit, prey) - distance({ x, y }, prey);
      score += step * 7;
    }
    if (def.range <= 1) {
      const brawlers = unitsOf(s, other(unit.owner)).filter(
        (e) => (utype(s, e.type).range ?? 1) <= 1 && (utype(s, e.type).atk ?? 0) >= 15,
      );
      if (brawlers.some((e) => distance({ x, y }, e) <= 1)) score -= 14;
    }
    if (unit.hp / def.maxHp < 0.45) {
      const th = enemyThreatAt(s, unit.owner, x, y);
      score -= th.n * 8;
    }
  }

  // 骚扰：目标是"让对面养不起兵"，不是"我占到更多地"。
  //
  // 两条坡度：往最近的敌方经济/工程单位靠（那是它整局的现金流），
  // 以及打完能站到对方够不着的地方——换血不划算，白打才划算。
  // 只给"方向"，不给"必须打"：能不能打由 scoreAttack 那一条决定。
  if (w.harass > 0.12 && def.category === 'combat' && def.domain !== 'water') {
    let prey: Unit | null = null;
    let pd = Infinity;
    for (const e of unitsOf(s, other(unit.owner))) {
      const ed = utype(s, e.type);
      if (ed.category !== 'economy' && ed.category !== 'builder') continue;
      const d0 = distance(unit, e);
      if (d0 < pd) {
        pd = d0;
        prey = e;
      }
    }
    if (prey) score += (pd - distance({ x, y }, prey)) * 5.5 * w.harass;

    const th = enemyThreatAt(s, unit.owner, x, y);
    const hpFrac = unit.hp / def.maxHp;
    // 站到没人够得着的地方：骚扰的全部本钱就是"人还在"
    if (th.n === 0 && hpFrac < 0.85) score += 7 * w.harass;
    // 残血还站在人堆里：这一条比通用威胁分更狠，因为骚扰单位的价值全在活着
    if (th.n > 0 && hpFrac < 0.55) score -= th.n * 6 * w.harass;
  }

  // 弃城：这一回合唯一要保住的是"还留着的那座城"。
  //
  // 放弃的那座不往里填人（守城的加分在下面也把它排除了），已经在附近的人
  // 往回走——兵可以丢，但不能丢在一个已经决定不要的地方。
  if (w.boom > 0.12 && def.category === 'combat' && def.domain !== 'water') {
    const keep = citiesOf(s, unit.owner).filter(
      (c) => !c.ruined && c.id !== all.mood.abandonedCityId,
    );
    if (keep.length > 0) {
      const before = Math.min(...keep.map((c) => distToCity(unit, c)));
      const after = Math.min(...keep.map((c) => distToCity({ x, y }, c)));
      score += (before - after) * 5 * w.boom;
    }
  }

  // 固守姿态：离家越远扣得越多。
  //
  // 这条只影响"要不要往外推"，不影响"要不要打"——贴到脸上的敌人照打不误
  // （攻击分在别的分支里，这里扣的是位置分）。1 格 6 分，走三格就是 18 分，
  // 足以让"再往前顶一格"让位给"回城补位"。
  if (all.hold) {
    const mine = citiesOf(s, unit.owner);
    if (mine.length > 0) {
      const before = Math.min(...mine.map((c) => distToCity(unit, c)));
      const after = Math.min(...mine.map((c) => distToCity({ x, y }, c)));
      if (after > before) score -= (after - before) * 6;
    }
  }

  // 守城：城里有人，城市才回血（rules.cityRegenOf），站在城格上还多 3 点护甲。
  //
  // 这一条不是"更保守"，是这套规则里唯一能**保住城市**的动作。城市满血只有三十点，
  // 被围一次就是"城外有敌人→不回血→下回合再被打"，攻方两三个兵就能把它磨到零。
  // 留两个人进去就不一样了：+6 耐久/回合，加上每人 3 点驻军护甲，同等人力拆不动。
  //
  // 只守"正在出事"的那一座（见 pickGuardCity），而且守军有上限：城里蹲四个人
  // 等于把野战兵力锁死，攻方换到别处去打就赢了。城墙掉过血守两个，满血只守一个。
  if (all.guardCityId && def.category === 'combat' && def.domain !== 'water') {
    const gc = cityById(s, all.guardCityId);
    if (gc) {
      const tiles = cityTiles(gc);
      const onTile = tiles.some((t) => t.x === x && t.y === y);
      const sitting = tiles.some((t) => t.x === unit.x && t.y === unit.y);
      const mates = unitsOf(s, unit.owner).filter(
        (a) => a.id !== unit.id && tiles.some((t) => t.x === a.x && t.y === a.y),
      ).length;
      const want = gc.hp < gc.maxHp * 0.9 ? 2 : 1;
      if (mates < want) {
        const before = distToCity(unit, gc);
        const after = distToCity({ x, y }, gc);
        score += (before - after) * 7;
        // 已经站进去了就别再挪：这一格既回血又加护甲，比往前顶一格值钱
        if (onTile && !sitting) score += 30;
        if (onTile && sitting) score += 12;
      }
    }
  }

  return score;
}

/**
 * 高机动突击单位：跑得快、射程又不足以"白嫖"，价值全在位置上。
 *
 * 射程 3 是分界线：再远就已经是火力单位了，它们本来就该待在后排，
 * 不需要"绕后"这套逻辑。
 */
function isRaider(def: UnitTypeDef): boolean {
  return def.category === 'combat' && def.domain !== 'water' && def.move >= 4 && def.range <= 3;
}

/* ---------------- 编队模板 ---------------- */

/**
 * 支援型能力：这些兵的战场价值不在自己打得多狠，而在整条线更耐打/更能走。
 * 白名单扩过一次——原来只有三条（指挥、护甲光环、威吓），
 * 于是奇想包里所有新支援兵（治疗光环、净化、修缮、召唤、疾行、咒域、布雷）
 * 在 AI 眼里都只是"数值很低的战斗单位"，一局也不会造。
 */
const SUPPORT_ABILITIES = [
  'aura-command',
  'aura-armor',
  'aura-speed',
  'fear',
  'curse-aura',
  'heal-aura',
  'purge',
  'purge-greater',
  'repair',
  'summoner',
  'trap',
  'build-wall',
];

/**
 * 军队的五种职能。配比按**职能**算，不按兵种 id 算——
 * "三个前排"由剑士、长枪兵、树人怎么凑都行，重要的是一支部队里有肉盾、
 * 有输出、有火力、有支撑，而不是"前十名兵种各来两个"。
 */
export type RosterRole = 'tank' | 'melee' | 'ranged' | 'support' | 'siege';

/**
 * 目标配比：前排 30% / 近战输出 25% / 远程 30% / 支援 15%。
 *
 * 这几个数字是照着"能推进、能顶住、能持久"三条给的，不是理论最优解：
 * 前排不够，远程一被贴脸就散；远程不够，压到城下只能拿人命填；
 * 支援为 0，一条线打完就没有第二条线。
 * 攻城器不占常备编制——它是"到了墙下才买"的一次性工具。
 */
const ROLE_TARGET: Record<RosterRole, number> = {
  tank: 0.3,
  melee: 0.25,
  ranged: 0.3,
  support: 0.15,
  siege: 0,
};

/**
 * 模板管四档常备职能。攻城器不在里面——它归"到墙下才加分"那条老规则，
 * 常备配比里给攻城器留份额，等于让 AI 在野战里养一堆拆墙的。
 */
const TEMPLATE_ROLES: RosterRole[] = ['tank', 'melee', 'ranged', 'support'];

/** 这个兵在编制里顶哪一档 */
export function rosterRoleOf(def: UnitTypeDef): RosterRole {
  const ab = def.abilities ?? [];
  // 英雄不算攻城器：九头蛇带 siege-master 是因为它砸墙也疼，
  // 但它进编制是去当主力的，编制里不给它记"攻城"这一档。
  if (!def.hero && ab.includes('siege-master')) return 'siege';
  // 能打的支援兵（天使 42 攻、矮人王 34 攻）算前排：它们本职是站在线上，
  // 光环只是顺带。自己打不动的（牧师、巫医、召唤师）才算支援。
  const brawler = (def.atk ?? 0) >= 20 || (def.magicAtk ?? 0) >= 16;
  if (!brawler && ab.some((a) => SUPPORT_ABILITIES.includes(a))) return 'support';
  if (def.range >= 3) return 'ranged';
  if ((def.armor ?? 0) >= 5 || (def.maxHp ?? 0) >= 65 || ab.includes('shield-wall')) return 'tank';
  return 'melee';
}

export interface RosterShare {
  /** 参与配比统计的陆军战斗单位数（不含召唤物、不含水军） */
  total: number;
  counts: Record<RosterRole, number>;
  /** 已有单位顶到对面城下——攻城器只在此时才算"缺" */
  siegeAtWall: boolean;
}

/**
 * 数一遍现在这支部队。召唤物不算：它们是消耗品，把总数撑大了会让
 * "我缺前排"的判断失真——死灵法师每回合造两个骷髅，不等于前排够了。
 */
export function rosterOf(s: GameState, owner: PlayerId): RosterShare {
  const counts: Record<RosterRole, number> = { tank: 0, melee: 0, ranged: 0, support: 0, siege: 0 };
  let total = 0;
  for (const u of unitsOf(s, owner)) {
    const def = s.unitTypes[u.type];
    if (!def || def.category !== 'combat' || def.domain === 'water') continue;
    if (def.summonedOnly) continue;
    counts[rosterRoleOf(def)] += 1;
    total += 1;
  }
  const foes = citiesOf(s, other(owner));
  const siegeAtWall = unitsOf(s, owner).some((u) => foes.some((c) => distance(u, c) <= 4));
  return { counts, total, siegeAtWall };
}

/**
 * 模板给每个职能加分：缺得越多的那一档，分加得越多。
 *
 * 为什么只加不减：
 *
 * 一开始写的是"缺的加分、超编的扣分"，结果高时代那条测试直接红了——
 * 候选池里五个远程兵、一个前排，扣分全落在远程身上，整支军队的采购分
 * 被压到种田以下，AI 转头买了四间种植园。扣分是"整支部队"的判断，
 * 却挂在"单个兵"身上，只要候选池构成偏一头，就变成了对一个兵种的惩罚。
 *
 * 所以这里只负责把预算往缺的地方推；打压同类刷屏是另一条
 * （同兵种边际递减），那条挂在兵种上，口径才对得上。
 *
 * 系数 70 是照着"整支部队 8 个单位"调的：缺一整档（0.3）≈ +21，封顶 +12。
 * 够把某个职能从"排第五"抬到"排第一"，又不足以让明显不合适的兵
 * （缺前排时去买一个 5 级法师）顶掉对口的选择。
 *
 * total 为 0 时全部记 0：开局该按"先凑出能打的一小撮"走，
 * 让模板去指挥第一支兵没有意义。
 */
export function rosterBonuses(share: RosterShare): Record<RosterRole, number> {
  const out: Record<RosterRole, number> = { tank: 0, melee: 0, ranged: 0, support: 0, siege: 0 };
  if (share.total === 0) return out;
  for (const r of TEMPLATE_ROLES) {
    const gap = ROLE_TARGET[r] - share.counts[r] / share.total;
    out[r] = Math.max(0, Math.min(12, gap * 70));
  }
  return out;
}

/** 突击单位眼里的"猎物"：后排火力（射程 ≥3），或比自己更贵的目标 */
function nearestPrey(s: GameState, unit: Unit, def: UnitTypeDef): Unit | null {
  let best: Unit | null = null;
  let bestD = Infinity;
  for (const e of unitsOf(s, other(unit.owner))) {
    const ed = s.unitTypes[e.type];
    if (!ed) continue;
    if (!(ed.range >= 3 || ed.cost >= def.cost * 1.2)) continue;
    const d = distance(unit, e);
    if (d < bestD) {
      bestD = d;
      best = e;
    }
  }
  return best;
}

/**
 * 这个建造者眼下能开工的格子。
 *
 * 判据一律走 rules.buildSiteError —— 和 doBuild 是同一份。
 * 以前这里复制了一套"扫周围九格"的检查，规则一改它就过期：
 * AI 会提一个必被拒绝的 BUILD，而执行方遇到非法动作会中断整回合，
 * 整局就死在一个"它以为能盖"的位置上。
 */
function buildSpots(
  s: GameState,
  unit: Unit,
  def: UnitTypeDef | undefined,
): Array<{ x: number; y: number; terrain: Terrain }> {
  const out: Array<{ x: number; y: number; terrain: Terrain }> = [];
  if (!def) return out;
  // 桥要多往外找两格：工程队站在岸上够不到三格宽的河心，
  // 只能顺着已经铺好的桥面把下一段递出去（规则里的 bridgeChainOk 允许 +2）。
  const reach = def.bridges ? CONFIG.buildRange + 2 : CONFIG.buildRange;
  for (let dy = -reach; dy <= reach; dy++) {
    for (let dx = -reach; dx <= reach; dx++) {
      if (dx === 0 && dy === 0) continue;
      const x = unit.x + dx;
      const y = unit.y + dy;
      if (!inBounds(s, x, y)) continue;
      const tile = s.tiles[y * s.w + x];
      if (!tile) continue;
      if (buildSiteError(s, def, unit, x, y)) continue;
      out.push({ x, y, terrain: tile.terrain });
    }
  }
  return out;
}

function rawBuildScore(
  s: GameState,
  unit: Unit,
  buildId: string,
  spot: { x: number; y: number; terrain: Terrain },
  land: Map<string, number[]>,
  mood?: AiMood,
  /** 这张图值不值得养海军（Fields.sea），只有水上产兵点读它 */
  sea = 0,
  /** 局势现在打在第几代（Fields.era），只有带白名单的产兵点读它 */
  era = 0,
): number {
  const def = s.unitTypes[buildId];
  if (!def) return -999;
  const w = mood ? mood.drive : { rush: 0, harass: 0, boom: 0 };

  /*
   * 建筑总量上限：每城 4 座，最多 16 座（桥不算——桥是路，不是设施）。
   *
   * 各兵种自己已经有上限（经济每城 2、塔每城 1+1、军营 4、工事每城 2），
   * 那些上限加起来能把一座城的"设施区"撑到十几座：线上对局里出现过
   * 31 座建筑的局（id=54），产能全在盖房子，前线一个兵没有。
   * 这一层是**总闸**，不是替代上面那些细分上限。
   */
  if (!def.bridges) {
    const cities = Math.max(1, citiesOf(s, unit.owner).length);
    const built = unitsOf(s, unit.owner).filter(
      (u) => utype(s, u.type).category === 'building',
    ).length;
    if (built >= Math.min(16, cities * 4)) return -999;
  }

  // 工地会不会被下回合拆掉。建造者死在这里的概率远高于野战单位：
  // 他站在空地上、没护甲加成、还刚把整回合花掉。
  const risky = inDanger(s, unit.owner, spot.x, spot.y);

  // 桥：跨得过去、对岸通向敌方城市才值得架
  if (def.bridges) {
    const gap = bridgeGap(s, spot.x, spot.y, land);
    if (!gap) return -999;

    // "接上一段已经铺好的桥"要显著更值。
    //
    // 以前这里只数全局桥数，等于用一个总预算把整条河的量一起管：
    // 自家后院池塘上那几座、加上斜着头铺歪的一两座，很容易就把预算吃光，
    // 于是主线上的桥停在一半——实测里两只工程队铺到河心就不动了，
    // 剩下的回合全花在岸边来回走。所以改成"就近数"：同一条河段上
    // 桥堆到 4 座才算铺够，而紧挨着自己桥面的那一格额外加 26 分，
    // 保证这三格是一条线铺过去的，不是沿河一排戳出来的。
    let near = 0;
    let chain = 0;
    for (const b of unitsOf(s, unit.owner)) {
      if (!utype(s, b.type).bridges) continue;
      if (distance(b, spot) > 7) continue;
      near += 1;
    }
    // 顺着同一条直线往外接的那一格不算"铺够了"：那是在把这条通道做完，
    // 不是在沿河刷桥。上一条硬上限如果不放这一格，三格宽的河永远差最后一块。
    const back = unitAt(s, spot.x - gap.dir[0], spot.y - gap.dir[1]);
    if (back && back.owner === unit.owner && utype(s, back.type).bridges) chain = 1;
    if (near >= 5 && !chain) return -999;

    /*
     * 全局桥数上限：每城 3 座，最多 10 座。
     *
     * 这里本来是"这座桥到底缩不短路"的距离判据，第一版写错了，删掉换成了这一条。
     * 错在哪：它拿 `advance` 图（水量按"很贵但有限"计价）比较"站在我这儿"和
     * "过桥之后"——那张图**本来就能涉水过去**，所以对岸永远比脚下远一点，
     * 判据几乎恒真，等于"除非完全走不通，否则不许架桥"。实测中世纪档因此
     * 从 7 胜 5 负掉到 4 胜 8 负（同一批种子，`results/ab-mi-*.json`）。
     *
     * 现在退回"按数量管"：不判断某座桥值不值，只限制总量。一座城市的设施区
     * 撑得住三座桥，再多就是在河上摆家具了。
     */
    {
      const cities = Math.max(1, citiesOf(s, unit.owner).length);
      const total = unitsOf(s, unit.owner).filter((u) => utype(s, u.type).bridges).length;
      if (total >= Math.min(10, cities * 3)) return -999;
    }
    // 少铺几座优先；对岸越靠近敌方城市越值。
    // 档位加成：钢桥 120 耐久 / 6 护甲，被打塌要磨很久——同样一个建造回合，
    // 产出的是"不会下回合就被拆掉的路"，这才是打破"你拆我建"死循环的东西。
    return (
      58 -
      gap.steps * 9 -
      near * 7 +
      chain * 26 +
      Math.max(0, 24 - gap.farDist) * 0.5 +
      (def.era - 1) * 5 -
      def.cost * 0.04 -
      (risky ? 8 : 0)
    );
  }

  /*
   * 水上产兵点（船坞 / 造船厂 / 海军船台）：**不跟军营共用一条线**。
   *
   * 这两件事的价值来源不一样，混在一起会有两个后果，每一个都足以让它永远造不出来：
   *
   *   · **抢额度**。军营是"每城一座、最多四座"，河道图上 AI 的营早就顶满了。
   *     船坞一进来就是 -999：玩家能用、AI 一次不造。实测 4 局 20×20 海军包，
   *     造船厂出现 0 次（`scripts/diag-build.ts`）。
   *   · **量错了尺子**。军营的分数按"离敌人多近"给，可船坞跟敌人远近几乎无关，
   *     它只跟"这张图有多少水、我能不能靠陆路摸到对面"有关（`seaDemand`）。
   *
   * 判据写在数据里（buildOn 里有水），不写死 id：以后再加一档船坞不用回来改这里。
   */
  const onWater = (def.buildOn ?? []).some((t) => t === 'water' || t === 'shallow' || t === 'deep');
  if (isProducer(def) && onWater) {
    // 船是奢侈品的时候造船坞，等于把钱埋进水里
    if (sea <= 0) return -999;
    // 落成即废的那几档：白名单里全是更高代的船，现在修好也下不了水。
    // 规则层（doBuild）也会拒，这里先拦是不让 AI 提一个必被拒的动作——
    // 执行方遇到非法动作会中断整回合。
    const usable = produceUsableCount(def, s.unitTypes, era || def.era);
    if (usable !== null && usable <= 0) return -999;

    const cities = citiesOf(s, unit.owner);
    if (cities.length === 0) return -999;

    // 自己的水上产兵点单独计数，不占军营的额度。
    // 上限按城市数给、最多两座：一座船坞够一支舰队出门，两座是"两线同时下水"。
    const docks = unitsOf(s, unit.owner).filter((u) => {
      const ud = utype(s, u.type);
      return isProducer(ud) && (ud.buildOn ?? []).some((t) => t === 'water' || t === 'shallow' || t === 'deep');
    }).length;
    if (docks >= Math.min(2, Math.max(1, Math.floor(cities.length / 2)))) return -999;

    // 离自家城市太远就没有意义：船是要拿来保交通线、抢滩头的，
    // 在没人去的水塘里修一座船坞，只是多一个被顺手拆掉的目标。
    let nearOwn = Infinity;
    for (const c of cities) nearOwn = Math.min(nearOwn, distance(spot, c));
    if (nearOwn > 10) return -999;

    // 海上工地会挨舰炮，但没有陆上工地那么致命（水面上摸过来的兵少）
    /*
     * 基准分给到 70：这一档必须**一次就建起来**。
     *
     * 标定过程（4 局 20×20 纵河图，水域 12.8%，脚本 `diag-build.ts --map river-v`）：
     *   · 44 分（沿用军营的量级）→ 0 次。它不是被规则拒掉的，是永远当不上最优动作：
     *     建造候选和走位候选在同一个池子里比大小，工程兵一步"朝桥头挪一格"就有四五十分，
     *     而船坞只值四十几——于是那座船坞连一次都没被选中过（候选生成进了 1819 次）。
     *   · 244 分 → 2 局建 5 座，机制确认无误，但显然过头了。
     *   · 70 分 → 每局一座左右，抢在桥和营前面动手，之后被 `docks × 45` 迅速压下去。
     *
     * 为什么敢让它压过桥的 58 分基准：真需要过河时 `scoreBuild` 会给非桥建造扣 20 分，
     * 桥那条路有自己的护栏（见 needBridge 分支），不会被一座船坞挡死。
     */
    return 70 + sea * 30 - nearOwn * 0.6 - docks * 45 - def.cost * 0.03 - (risky ? 12 : 0);
  }

  // 军营：把产兵点往前推，省下兵从后方跑到前线的那些回合。
  // 位置讲究"不近不远"——贴着敌人下回合就被推平，缩在后方等于没造。
  if (isProducer(def)) {
    const cities = citiesOf(s, unit.owner);
    // 军营的时代取最近城市，没有城市就产不出兵，那造它也没意义
    if (cities.length === 0) return -999;
    const mine = unitsOf(s, unit.owner).filter((u) => isProducer(utype(s, u.type))).length;
    // 上限从"最多三座"放宽到"每城一座、最多四座"。
    // 磨局统计里最刺眼的一条是"顶满 24 个单位、金库还压着几千金"——
    // 钱花不出去就等于没有压力，而军营是唯一能把钱直接变成"前线产兵点"的东西。
    if (mine >= Math.min(4, cities.length + 1)) return -999;

    let nearOwn = Infinity;
    for (const c of cities) nearOwn = Math.min(nearOwn, distance(spot, c));
    if (nearOwn > 12) return -999;

    let nearFoe = Infinity;
    for (const e of unitsOf(s, other(unit.owner))) {
      nearFoe = Math.min(nearFoe, distance(spot, e));
    }
    // 视野里一个敌人都没有：换敌方城市当"纵深参照物"。
    //
    // 以前这里直接 return -999（"看不见敌人就先别压补给点"），单独看很稳，
    // 实际是个陷阱——**把对面主力歼灭干净之后，AI 反而再也不往前线扎营**，
    // 兵只能从老家一趟趟往前线跑，赢下来的地盘没有产兵点。
    // 城市的位置是已知的（迷雾只藏单位和地形），拿它估纵深足够用。
    if (!Number.isFinite(nearFoe)) {
      for (const c of s.cities) {
        if (c.owner === unit.owner || c.ruined) continue;
        nearFoe = Math.min(nearFoe, distance(spot, c));
      }
    }
    if (!Number.isFinite(nearFoe)) return -999;

    // "不近不远"的档位随战术移动：弃城时往后缩
    // （兵都收回来守家了，营地在前面就是白送）。速攻不再前压——
    // "更凶"的那一版实测是净亏，营地的选择只按弃城姿态后撤。
    const style = 0;
    const tooClose = Math.max(2, 4 - 1.6 * style + 1.2 * w.boom);
    if (nearFoe < tooClose) return -999;
    const peak = 7 - 2.2 * style + 2.4 * w.boom;
    const front = nearFoe <= 12 ? 34 - Math.abs(nearFoe - peak) * 3 : 6;
    // 高级营更贵，但要让它"贵得值"：耐久和火力都上一个台阶，
    // 在前线顶着的时候比多造一座廉价营有用
    const tier = (def.era - 1) * 5;
    return 52 + front + tier - nearOwn * 0.7 - mine * 16 - def.cost * 0.045
      + 10 * style - 14 * w.boom;
  }

  if (def.incomeByTerrain || def.income || def.yield || def.yieldByTerrain) {
    // 经济建筑：建在赚钱的地上才有意义。但被敌人威胁的位置是纯送钱——
    // 经济建筑 2 点护甲，对面一个民兵两下就拆了，还顺手带走建造者。
    if (risky) return -999;
    // 每座城两座经济建筑封顶。
    // 以前"建筑不占编制"之后，钱一多就变成满地的磨坊：模拟里古典局 60 场盖了 682 座，
    // 场面像集市不像战场。经济建筑本身也会继续生钱，越盖越多，最后全在滚利息。
    const sameKind = unitsOf(s, unit.owner).filter((u) => u.type === def.id).length;
    if (sameKind >= Math.max(2, citiesOf(s, unit.owner).length * 2)) return -999;
    const probe: Unit={id:'ai-production-site',type:def.id,owner:unit.owner,x:spot.x,y:spot.y,hp:def.maxHp,kills:0,moved:true,acted:true};
    const inc=resourceValue(s,unit.owner,unitYield(s,probe));
    // 一格产出都没有的地盖上磨坊，产的是 0：这一回合纯亏
    if (inc <= 0) return -999;
    return inc * 4 - resourceValue(s,unit.owner,recruitResCost(s,unit.owner,def)) * 0.03;
  }

  if (def.autoAttack) {
    // 军事建筑：离敌人越近越有用，但不能贴在敌方主力脸上
    //
    // 数量要设上限：塔是钉在地上的防御，AI 很容易把钱全拿去砌塔，
    // 结果两边各砌一圈塔，谁也推不动——模拟里出现过一局 28 座箭塔、
    // 一百三十回合分不出胜负。每座城配一座就够了。
    const sameKind = unitsOf(s, unit.owner).filter((u) => u.type === def.id).length;
    const cityCount = Math.max(1, citiesOf(s, unit.owner).length);
    if (sameKind >= cityCount + 1) return -999;

    let nearest = Infinity;
    for (const e of unitsOf(s, other(unit.owner))) {
      nearest = Math.min(nearest, distance(spot, e));
    }
    const near = Number.isFinite(nearest) ? Math.max(0, 20 - nearest * 2) : 10;
    return 35 + near - def.cost * 0.04 - sameKind * 8;
  }

  // 纯防御工事：城墙、栅栏、拒马这类。它们不输出、不生钱、不产兵，
  // 值钱的地方只有一处——敌人已经压过来时，把通路堵窄。
  //
  // 以前这类单位落到最后的 return 10，等于"永远排最后"：五个时代的城墙
  // 招募数全是 0，加了跟没加一样。现在的规则是"挨打才砌墙"，而且总量有上限，
  // 免得两边对着垒墙、把对局拖回那个谁也推不动的拉锯。
  if (!def.autoAttack && !isProducer(def) && !def.incomeByTerrain && !def.bridges) {
    const mine = unitsOf(s, unit.owner).filter((u) => {
      const ud = utype(s, u.type);
      return ud.category === 'building' && !ud.autoAttack && !isProducer(ud) && !ud.incomeByTerrain;
    }).length;
    if (mine >= Math.max(2, citiesOf(s, unit.owner).length * 2)) return -999;
    if (risky) return -999;

    let nearestFoe = Infinity;
    for (const e of unitsOf(s, other(unit.owner))) {
      nearestFoe = Math.min(nearestFoe, distance(spot, e));
    }
    // 敌人还没到门口，砌墙就是浪费一个建造回合。
    //
    // 这里以前返回 4——不是"不建"，是"分数很低"。可建筑候选和走位候选是在
    // 同一个池子里比大小的：一步普通行军往往只有几分，于是 4 分常常真的能赢，
    // AI 于是会在平静的后方一块一块地砌墙。要表达"别建"就得给 -999。
    if (!Number.isFinite(nearestFoe) || nearestFoe > 7) return -999;
    return 26 + (7 - nearestFoe) * 4 - def.cost * 0.03 - mine * 6;
  }

  return 10;
}

/**
 * 建造评分的门面：在原始评分上叠一层"眼下该干什么"的权重。
 *
 * 过河阶段（河把两家隔开、桥还没铺通）时，能架桥的工程队要先去架桥——
 * 否则它会在家门口盖磨坊盖到天荒地老，而对岸一兵一卒都过不去。
 */
function scoreBuild(
  s: GameState,
  unit: Unit,
  buildId: string,
  spot: { x: number; y: number; terrain: Terrain },
  all: Fields,
): number {
  const raw = rawBuildScore(s, unit, buildId, spot, all.land, all.mood, all.sea, all.era);
  if (raw <= -900) return raw;

  const canBridge = (utype(s, unit.type).builds ?? []).includes('bridge');

  // 过河阶段，"架桥"这个动作本身必须比"再往桥头挪一格"更值。
  //
  // 移动那边有个 42 分的常量（needBridge 时给），而桥的原始分只有三十几，
  // 于是工程队走到桥头就开始原地打转：每回合都能挪一格"离桥头一样近"的地方，
  // 分数比真的把桥架上去高。实测里两只工程队在河岸上转了八十回合，一座桥没架。
  if (all.needBridge && s.unitTypes[buildId]?.bridges) return raw + 24;

  if (all.needBridge && canBridge && !s.unitTypes[buildId]?.bridges) {
    // 过河阶段压别的建造，但不能一刀切：军营是"过了河立刻用得上"的东西，
    // 压满 45 分等于整条河岸一个产兵点都没有，兵只能从老家一趟趟往前线跑。
    return raw - (isProducer(s.unitTypes[buildId]) ? 20 : 45);
  }
  return raw;
}

function unitCandidates(
  s: GameState,
  unit: Unit,
  all: Fields,
  traits: AiTraits,
  rejected: ReadonlySet<string>,
): Candidate[] {
  const out: Candidate[] = [];
  const def = utype(s, unit.type);

  // 施工中的工地不能开火、不能围城、不能造东西（规则层会拒），
  // 所以这里根本不为它生成候选——否则 AI 会提一个必被拒绝的动作，
  // 而执行方遇到非法动作就中断整回合，整局直接卡死。
  if (!unit.acted && !underConstruction(unit)) {
    for (const t of attackableTargets(s, unit)) {
      out.push({
        action: { type: 'ATTACK', unitId: unit.id, targetId: t.id },
        score: scoreAttack(s, unit, t, all),
      });
    }
    for (const c of siegeTargets(s, unit)) {
      out.push({
        action: { type: 'SIEGE', unitId: unit.id, cityId: c.id },
        score: scoreSiege(s, unit, c, all.focusCityId, all.mood),
      });
    }
    if (def.builds && def.builds.length > 0) {
      for (const buildId of def.builds) {
        const buildDef = s.unitTypes[buildId];
        if (!buildDef) continue;
        // 钱和编制都要够：以前没查，AI 会一直提"金币不足"的建造，
        // 而执行方遇到非法动作就中断整回合。
        if (!canPay(s.players[s.current], recruitResCost(s, s.current, buildDef))) continue;
        for (const spot of buildSpots(s, unit, buildDef)) {
          out.push({
            action: { type: 'BUILD', unitId: unit.id, unitType: buildId, x: spot.x, y: spot.y },
            score: scoreBuild(s, unit, buildId, spot, all),
          });
        }
      }
    }
  }

  if (!unit.moved && def.move > 0) {
    // A failed hidden path is excluded by the runner; try another observed route.
    const me = s.current;
    let best: Candidate | null = null;
    for (const i of reachableTiles(s, unit).keys()) {
      const { x, y } = xyOf(s, i);
      if (rejected.has(aiActionKey({ type:'MOVE',unitId:unit.id,x,y }))) continue;
      // 空地废墟走进去要付重建费。掏不起就换个落点——
      // rules 的 doMove 会拒绝，AI 提出来又是一次整回合中断。
      const destCity = cityAt(s, x, y);
      if (destCity?.ruined && s.players[me].gold < rebuildCost(destCity)) continue;
      const score = scoreMove(s, unit, x, y, all, traits);
      if (!best || score > best.score) {
        best = { action: { type: 'MOVE', unitId: unit.id, x, y }, score };
      }
    }
    /*
     * 「不动」也是一个候选。
     *
     * 2026-11-02 补：在这之前走位候选里只有"去哪"，没有任何一条代表"留在原地"。
     * 后果是哪怕脚下这格是丘陵+树林（树人 9 甲），只要还有一个能走的格子、
     * 那个格子的推进分比 0 高一点点，它就一定会挪走——把 3 点甲换成 0.5 分推进。
     *
     * 守点分够高的时候，这里什么都不推，这一回合它就站着。开火是另一组候选，
     * 所以"站着"不等于"不还手"。
     */
    const stay = holdScore(s, unit, all, traits);
    if (best && best.score >= stay) out.push(best);
  }

  // ── 海军：装卸 ──
  // 只对运输船生成；别的船走上面的开火/走位就够了
  if (def.domain === 'water' && hasHold(def)) {
    out.push(...navalTransferCandidates(s, unit, all));
  }

  return out;
}

/**
 * 这一格在"谁的半场"上：正数＝离敌方城市更近，负数＝离自家城市更近。
 *
 * 装卸判据全用它，是因为**"我这一侧 / 对面那一侧"是这张图最稳的地理事实**。
 * 换别的写法都得算两套距离（水路、陆路），而水陆两套场在岸边本来就不连续，
 * 比出来的方向会在海岸线上来回抖——船就会把自己人一船船运回头。
 */
function enemySideScore(s: GameState, me: PlayerId, x: number, y: number): number {
  let own = Infinity;
  let foe = Infinity;
  for (const c of s.cities) {
    const d = distToCity({ x, y }, c);
    if (c.owner === me) own = Math.min(own, d);
    else foe = Math.min(foe, d);
  }
  if (!Number.isFinite(own) && !Number.isFinite(foe)) return 0;
  if (!Number.isFinite(own)) return 99;
  if (!Number.isFinite(foe)) return -99;
  return own - foe;
}

/**
 * 运输船的装卸候选。
 *
 * 这一段以前**根本不存在**：AI 会造船、会让船开炮，但从来不会把兵装上船。
 * 于是在群岛图上（整片海隔开两军）两军各自挤在自己那侧的岸边，
 * 船只是漂着的炮台——50 局跑下来水军只占 1.1% 的建造数、2.0% 的输出，
 * 而地图的整个设计意图就是"你没有船就过不去"。
 *
 * 三条判据，都是为了让船别空转：
 *   · 上船只在地陆路走不通时发生（`all.needBridge`）。路通的时候把兵装船
 *     再放下来，等于花两回合把人挪了两格，纯亏。
 *   · 已经在对面那一侧的人不上船——否则船会把自己人一船船运回头。
 *   · 下船要求落点在对面那一侧，且那一格真的能站人（`passable` + 没人占）。
 *     rules 的 doUnload 会拒掉"那里上不了岸"，AI 提一次非法动作就整回合中断。
 */
function navalTransferCandidates(s: GameState, unit: Unit, all: Fields): Candidate[] {
  const out: Candidate[] = [];
  const def = utype(s, unit.type);
  if (unit.acted) return out;
  const me = s.current;
  const cargo = unit.cargo ?? [];

  // ① 下船：旁边有能上岸的格，而且那一格已经在对面那侧
  if (cargo.length > 0) {
    for (const [dx, dy] of DIRS) {
      const x = unit.x + dx;
      const y = unit.y + dy;
      if (!inBounds(s, x, y)) continue;
      if (unitAt(s, x, y)) continue;
      const tile = s.tiles[y * s.w + x];
      if (!tile || !passable(tile.terrain)) continue;
      const side = enemySideScore(s, me, x, y);
      if (side <= 0) continue;
      for (const c of cargo) {
        // 加强渡船：下船就能接着打的落点，值一次"抢滩"。
        // 不加这一条，AI 会挑一个安全的空滩上岸，然后那个兵整回合罚站——
        // 规则允许它动，AI 却不知道，等于白改。
        const canHit = c.acted !== true && attackableTargets(s, { ...c, x, y }).length > 0;
        out.push({
          action: { type: 'UNLOAD', unitId: unit.id, cargoId: c.id, x, y },
          // 越靠近对面越该上岸：把"离敌方城有多近"直接折成分数
          score: 58 + Math.min(18, side * 1.2) + (canHit ? 26 : 0),
        });
      }
    }
  }

  // ② 上船：这一段以前只在"陆路完全不通"时才发生，而群岛图的地图生成器
  // 总会留几串浅滩把两岸连起来（50 局里 50 局都能走过去），于是条件永远不成立，
  // 船一次都没运过人。改成比**两种到场**：船走水路几步、那个兵走陆路几步，
  // 水路明显更快才装船——这才是"运输"的意义，也对得上没有浅滩的地图。
  if (holdRoom(def, unit) > 0) {
    // 两家到场都只看城市、不看敌人：混进"到最近敌兵的距离"会把两个数算成不同的东西
    const seaAdv = advanceDistance(s, me, unit.x, unit.y, all.water, all.focusCityId, true);
    for (const u of unitsOf(s, me)) {
      if (u.id === unit.id || u.acted) continue;
      const d = utype(s, u.type);
      if (d.domain === 'water' || d.category === 'building') continue;
      if (distance(unit, u) !== 1) continue;
      if (enemySideScore(s, me, u.x, u.y) > 0) continue;
      const landAdv = advanceDistance(s, me, u.x, u.y, all.land, all.focusCityId, true);
      // 走不到（Infinity）当然运；走得到但绕远（浅滩带绕一大圈）也运。
      // 2 格余量是"上下船各要一回合"的成本，短途接送不如自己走。
      const worth =
        !Number.isFinite(landAdv) || (Number.isFinite(seaAdv) && seaAdv + 4 < landAdv);
      if (!worth) continue;
      out.push({
        action: { type: 'LOAD', unitId: unit.id, cargoId: u.id },
        // 比"往岸边挪一格"（通常十几分）高一档：装船是这一段路里唯一有意义的动作
        score: 56 + Math.min(10, (holdOf(def)?.max ?? 0) * 2),
      });
    }
  }

  return out;
}

/** 一个经济单位大概能赚多少（按最好的地形估） */
function maxIncome(def: UnitTypeDef): number {  let best = def.income ?? 0;
  for (const v of Object.values(def.incomeByTerrain ?? {})) {
    if (typeof v === 'number' && v > best) best = v;
  }
  return best;
}

/** 一个产兵点：城市或军营 */
interface RecruitSource {
  kind: 'city' | 'camp';
  id: string;
  x: number;
  y: number;
  /** 能产到哪个时代的兵（军营取最近城市） */
  era: number;
}

/**
 * 在某个产兵点能招的兵里挑一个。
 *
 * 城市和军营共用这段逻辑，区别只在"兵从哪几格出来"和 action 的字段。
 */
/**
 * 英雄技能要不要开。
 *
 * 每条技能只有"该开"和"不该开"两种判断，不做多回合规划——技能 CD 都不长，
 * 早开一轮和晚开一轮的差别远小于"根本不开"。
 * 分数给得比普通动作高一点（20~40），因为技能不占行动：开了还能接着打。
 */
function heroSkillCandidate(view: GameState, u: Unit): Candidate | null {
  const def = utype(view, u.type);
  const skills = def.skills ?? [];
  if (skills.length === 0) return null;

  const foes = unitsOf(view, other(u.owner)).filter(
    (f) => utype(view, f.type).category === 'combat',
  );
  const hpRatio = u.hp / def.maxHp;

  for (const k of skills) {
    // 能不能开读 heroSkillsOf，别自己翻 skillCd：隐匿这类技能改成充能之后，
    // 只认冷却会让 AI 以为它永远"不能用"（skillCd 一直是空的），
    // 于是整局一次都不藏。
    const state = heroSkillsOf(view, u).find((x) => x.def.id === k.id);
    if (!state?.ready) continue;
    let score = 0;
    switch (k.effect) {
      case 'throw-axe': {
        /*
         * 投斧是**白送的一下**：规则里给它挂了 freeShot，这一击不写 acted，
         * 扔完还能贴身再劈一刀（见 rules 的 doAttack 尾部）。
         *
         * 所以只要有敌人进了三格就该扔——包括贴脸的时候。
         * 老写法是"贴身的敌人就在眼前，劈比扔疼，所以不扔"，把"白送的
         * 六成伤害"当成了"用六成伤害换一次满伤"，白白丢掉一份输出，
         * 表现出来就是矮人王整局一次斧头都没扔过。
         *
         * 贴脸时给的分低一点，只是为了让"够不着"的那种情况优先被看见，
         * 不是不扔。
         */
        const inReach = foes.some((f) => distance(f, u) <= 3);
        if (!inReach) break;
        const adjacent = foes.some((f) => distance(f, u) === 1);
        score = adjacent ? 28 : 36;
        break;
      }
      case 'regenerate': {
        if (hpRatio < 0.65) score = 30 + (0.65 - hpRatio) * 90;
        break;
      }
      case 'dive': {
        if (foes.some((f) => distance(f, u) <= 4)) score = 26;
        break;
      }
      case 'cycle': {
        const cyc = def.cycle ?? [];
        if (cyc.length === 0) break;
        const cur = u.element ?? cyc[0]!;
        const next = cyc[(cyc.indexOf(cur) + 1) % cyc.length]!;
        const near = foes.filter((f) => distance(f, u) <= def.range + 1);
        if (near.length === 0) break;
        // 切到的属性正好克对面的弱点，这一轮就更值得
        const weak = near.some((f) => (utype(view, f.type).weak?.[next] ?? 1) > 1);
        score = weak ? 40 : 22;
        break;
      }
      case 'descend': {
        const radius = k.radius ?? 1;
        const near = unitsOf(view, u.owner).filter((a) => distance(a, u) <= radius);
        const hurt = near.filter((a) => {
          const ad = utype(view, a.type);
          if (a.hp < ad.maxHp * 0.75) return true;
          return !!a.status && Object.keys(a.status).length > 0;
        });
        /*
         * 门槛："两个人受伤"或者"一个人伤得很重"。
         *
         * 原来只认前一条，于是残局里只剩一个残血老兵站在天使旁边时，
         * 「降临」一次都不开——而那种局面恰恰是最该开的：20% 血加上
         * 清空负面状态，能把这个兵从"下一刀就死"拉回来。
         */
        const bad = near.filter((a) => {
          const ad = utype(view, a.type);
          return a.hp < ad.maxHp * 0.4;
        });
        if (hurt.length >= 2 || bad.length >= 1) score = 22 + hurt.length * 5 + bad.length * 4;
        break;
      }
      case 'vanish': {
        /*
         * 隐匿是"脱战"用的，不是"开打前先加个 buff"用的。
         * 所以只在身边有威胁时才值：贴脸且血不满 → 该藏；三格内有人 → 顺手藏。
         * 满血又没人时开它，等于白扔两回合冷却。
         */
        const threat = foes.filter((f) => distance(f, u) <= 3);
        if (threat.length === 0) break;
        const adjacent = threat.some((f) => distance(f, u) <= 1);
        if (adjacent) score = hpRatio < 0.7 ? 34 : 24;
        else score = 18;
        break;
      }
      case 'mitosis': {
        /*
         * 裂殖：血越少越划算（四团 1/4 血比一个残血牢大难缠），
         * 但前提是四邻真有四个空位——裂不出来就别点，规则会拒。
         *
         * 再加一条"看得见敌人才裂"：裂殖是战术后手（把一刀砍死换成分摊伤害），
         * 空场上裂开只是把一只牢大拆成四块靶子，随后又被「聚合」合回去。
         * 玩家在沙盒里看到的就是"周围一个敌人都没有，它自己在那儿裂了又合"。
         */
        if (!foes.some((f) => distance(f, u) <= 8)) break;
        let free = 0;
        for (const [dx, dy] of DIRS) {
          const nx = u.x + dx;
          const ny = u.y + dy;
          const t = view.tiles[ny * view.w + nx];
          if (!t) continue;
          if (view.units.some((v) => v.x === nx && v.y === ny)) continue;
          if (t.terrain === 'water' || t.terrain === 'mountain') continue;
          free += 1;
        }
        if (free < 4) break;
        if (hpRatio < 0.6) score = 26 + (0.6 - hpRatio) * 40;
        else if (foes.some((f) => distance(f, u) <= 3)) score = 16;
        break;
      }
      case 'raise-dead': {
        /*
         * 招魂：只在本回合真有人倒下、而且付得起的时候才点。
         *
         * 分数按"救回来的造价"给——它占的是冷却，不是行动，
         * 所以只要这次复活值钱，这一回合开就是赚的。
         * 太便宜的目标（几十金的杂兵）不值得为它烧掉两回合冷却。
         */
        const mine = (view.fallen ?? []).filter(
          (r) =>
            r.owner === u.owner &&
            r.turn >= view.turn - 1 &&
            !r.revived &&
            !!view.unitTypes[r.type] &&
            // 英雄不能被招魂：别让 AI 反复点一个注定被规则拒掉的技能
            view.unitTypes[r.type]!.hero !== true,
        );
        if (mine.length === 0) break;
        let best = 0;
        for (const r of mine) {
          const rd = view.unitTypes[r.type] as UnitTypeDef;
          best = Math.max(best, recruitCost(view, u.owner, rd));
        }
        if (best < 90) break;
        if (view.players[u.owner].gold < best) break;
        // 复活落在死灵法师旁边的空地上：四邻占满时规则会拒，AI 也别白点一次
        const open = DIRS.some(([dx, dy]) => {
          const nx = u.x + dx;
          const ny = u.y + dy;
          const t = view.tiles[ny * view.w + nx];
          if (!t) return false;
          if (view.units.some((v) => v.x === nx && v.y === ny)) return false;
          return t.terrain !== 'water' && t.terrain !== 'mountain';
        });
        if (!open) break;
        score = 24 + Math.min(20, best / 25);
        break;
      }
      case 'holy-banner': {
        /*
         * 圣旗：身边有三个人（含自己）就值。
         *
         * 和「降临」不同，它不看血线——护甲和魔抗是**预支**的减伤，
         * 等队友都残了再开，等于已经挨完了才加装甲。
         */
        const radius = k.radius ?? 2;
        const near = unitsOf(view, u.owner).filter((a) => distance(a, u) <= radius);
        if (near.length < 3) break;
        if (!foes.some((f) => distance(f, u) <= 6)) break;
        score = 26 + Math.min(12, near.length * 2);
        break;
      }
      case 'ascend': {
        /*
         * 圣剑觉醒是**越早开越值**：它加的是永久面板，开得早等于多吃了几个回合的加成。
         * 但空场上升级没有意义（对面还没来，先把冷却烧掉不划算），
         * 所以只要求"六格内有人"，不要求贴脸。
         */
        if (!foes.some((f) => distance(f, u) <= 6)) break;
        score = hpRatio < 0.6 ? 38 : 30;
        break;
      }
      case 'dragon-egg': {
        /*
         * 陨卵：一枚卵既是伤害也是两回合后的一条龙，所以只要**有一个敌人**
         * 能吃下这一发就该放——它不是终结技，是"往对面阵线里插一根钉子"。
         * 真正没得放的情况（周围六格全是自己人/走不进去）交给规则层拒绝，
         * 这里只做粗判，免得 AI 每次都去试一个必然失败的技能。
         */
        const reach = k.radius ?? 6;
        if (!foes.some((f) => distance(f, u) <= reach)) break;
        score = 30;
        break;
      }
      case 'fuse': {
        /*
         * 聚合：碎片在场上凑够两只就该合回去，血越少越急——
         * 一只大史莱姆单挑谁都打不过，合体才是它真正的形态。
         *
         * 同「裂殖」：附近没有敌军时不合。空场合体没有收益，只会和裂殖
         * 凑成一对"裂开—合回"的空转。
         */
        if (!foes.some((f) => distance(f, u) <= 8)) break;
        const kin = unitsOf(view, u.owner).filter((a) => a.type === u.type && a.hp > 0);
        if (kin.length < 2) break;
        const bossAlive = unitsOf(view, u.owner).some((a) => a.type === (def.mergeInto ?? ''));
        if (bossAlive) break;
        score = hpRatio < 0.5 ? 38 : 24 + kin.length * 3;
        break;
      }
    }
    if (score > 0) {
      return { action: { type: 'HERO_SKILL', unitId: u.id, skillId: k.id }, score };
    }
  }
  return null;
}

/**
 * 蛋放哪：离敌人越远越好，但别离家太远。
 *
 * 两个条件会打架——躲到地图另一头最安全，可这个英雄要重跑十回合才回得来。
 * 所以用"威胁距离封顶 6 格"折算，再拿离自家城市的距离去扣。
 */
function eggPlacement(view: GameState, me: PlayerId): { x: number; y: number } | null {
  const spots = eggSpots(view);
  if (spots.length === 0) return null;
  const foes = unitsOf(view, other(me)).filter((f) => utype(view, f.type).category === 'combat');
  const own = citiesOf(view, me);

  let best: { x: number; y: number } | null = null;
  let bestScore = -Infinity;
  for (const p of spots) {
    let threat = 6;
    for (const f of foes) threat = Math.min(threat, distance(f, p));
    const home =
      own.length > 0
        ? own.reduce((m, c) => Math.min(m, Math.abs(c.x - p.x) + Math.abs(c.y - p.y)), Infinity)
        : 0;
    const score = threat * 10 - home * 1.5;
    if (score > bestScore) {
      bestScore = score;
      best = p;
    }
  }
  return best;
}

/**
 * 本回合的计划：钱要攒着干什么，队形要不要收缩。
 *
 * 加这一层的原因很直接：原来的采购是**每回合独立的最优解**——
 * 手里有 120 金就买 120 金能买到的最好的兵，从不考虑"再攒两回合能升时代"。
 * 于是 AI 永远停在上一代，英雄和时代升级在实数据里几乎不存在
 * （见 results-bf：180 局里英雄只被买了 29 个）。
 *
 * 计划的优先级：
 *   1. 场上缺人、或者敌人已经压到城下（urgent）→ 什么都别攒，先活下来。
 *   2. 对面有城成了废墟 → 攒重建费，把它收回来（这是唯一直接通向胜利的一步）。
 *   3. 没英雄、兵也够 → 攒英雄（它是唯一"买了就永久强一档"的东西）。
 *   4. 时代能升 → 攒时代升级。
 * 只有目标在"大约 6 个回合的收入之内"才进入攒钱模式，否则一直攒不到头，
 * AI 会整局不造兵——那是另一种死法。
 *
 * 攒钱不是"这回合不花钱"，而是"账上留够计划要用的那笔"。差额冻结，多出来的
 * 部分照样可以买兵（见 allowance）——第一版是硬停采购，实测直接掉了两成胜率：
 * 钱是攒下来了，可对面在这六个回合里多出四个兵，城下就再也没站起来过。
 */
export interface AiPlan {
  /**
   * `trade` = 换家：这一带守不住了，不守着城打，全军去过对面的经济与空城。
   * 见 buildPlan 里"换家"那一段的触发条件。
   */
  stance: 'push' | 'turtle' | 'elite' | 'trade';
  /**
   * 正在为什么攒钱。
   *
   * 2026-11-02 新增 `'unit'`：人类会"停手攒钱买一个大件"，而原来的三种目标
   * 只有英雄 / 升时代 / 收废墟，普通兵种永远吃不到这套预留机制。
   */
  savingFor: 'hero' | 'era' | 'rebuild' | 'unit' | null;
  /** savingFor === 'unit' 时，攒的是哪一个兵种 */
  targetUnitId: string | null;
  targetCost: number;
  /**
   * 攒钱期可动用的现金（每回合）。
   *
   * 2026-11-02 改：原来是 `余额 − 目标费用`，也就是**二值**——差一截就一点都不能花，
   * 产线整条停住。现在按收入折算，见 `savingAllowance`。
   */
  allowance: number;
  /**
   * 建造（建筑）能用的额度：仍然是老口径 `余额 − 目标价`。
   *
   * 为什么要和 allowance 分开：囤建筑是"慢慢回本"的钱，攒钱期里它抢的是
   * 升级费/重建费这种一次性的关键支出，回本速度根本追不上。实测把建筑物的冻结
   * 一起放开之后，AI 把钱全铺成磨坊，重建费和升时代反而攒不出来了。
   * 可以边打边补兵，但不能边攒边铺摊子。
   */
  buildAllowance: number;
  /** 选中这个目标的性价比评分（每金战力），诊断用；不攒钱时为 0 */
  goalScore: number;
  /** 攒钱目标的一句话说明，诊断用；不攒钱时为空串 */
  goalNote: string;
  /**
   * 这一回合参与比较的**全部**攒钱候选，按分数从高到低，诊断用。
   *
   * 为什么要把它留在计划里：`savingFor` 只告诉你结果，看不出"为什么不是那一个"。
   * 排查"AI 为什么一直不升时代"时，需要的正是另外几个候选的分数——
   * 是英雄压过了它，还是根本够不着。`scripts/diag-plan.ts --goals` 会把它打出来。
   */
  goalOptions: Array<{ kind: string; cost: number; score: number; note: string }>;
  urgent: boolean;
}

/** 攒钱的时间视野：几回合之内够得着才值得停手 */
const SAVE_HORIZON = 6;

/**
 * 还差几个回合的收入以内就"咬住"目标、一分不花。
 *
 * 短停是划算的：四五个回合的停手换一整代兵，实测比"边打边攒"赢得多。
 * 长停才是要修的病——那种"再攒十个回合也够不着"的远目标（重建费、远处的升级），
 * 一直冻着的话整局产线就废了。所以只有超过这个窗口的目标才允许边打边攒。
 *
 * 4 这个数是量出来的：同一个新目标选择下，贴身阈值 2 → 对战 46.9%（160 局，
 * 对手是上一版冻结的 AI），4 → 50.0%（160 局）。阈值越小越接近"老硬停"，
 * 而那恰恰是打得更赢的那一侧——所以放宽到 4，只在够不着的远目标上才放开产线。
 */
const SAVE_TIGHT_TURNS = 4;

/**
 * 投资视野（回合）：AI 估"这笔钱以后还能滚出多少"。
 *
 * 升时代和收废墟的收益都不是一次性的：前者让**以后每一个产兵名额**更值钱，
 * 后者多出一份**每回合的收入**。要把这两种收益和一个兵的价格排在同一张表上，
 * 就得先估"以后还有多少回合可打"。20×20、火药开局、200 回合上限的实测里，
 * 分出胜负的中位数在 25~35 回合，取一半偏保守：宁可低估长期收益，
 * 也不要把 AI 推成"整局只顾攒升级、一个兵不造"。
 */
const INVEST_HORIZON = 15;

/**
 * 英雄溢价：同样一笔钱，英雄除了数值还带技能和"场上只能有一个"的独占性。
 * 不给这一档，纯按性价比算，英雄会永远排在便宜的戟兵后面——
 * 而实际对局里"有没有英雄"是整支部队的档位差别。
 */
const HERO_PREMIUM = 1.6;

/**
 * 升时代的战力折扣：升级换回来的战力是在十几个回合里慢慢兑现的，
 * 而一个兵是**现在**就能顶到城门口的。折半是个粗估，方向比精度重要——
 * 不打这个折扣，升时代会永远碾压一切，AI 又回到"整局只顾升城、一个兵不造"。
 */
const ERA_TIME_DISCOUNT = 0.5;

/**
 * 换血的门槛：新兵的性价比至少是老兵的多少倍，才值得为它 disband 一个。
 *
 * 编制是"一个萝卜一个坑"，换一次的净收益是**差价**，而代价是当回合少一个人、
 * 外加一笔钱（解散只退满血单位的部分造价）。1.35 倍大致等于"跨一代"：
 * 火药的火枪兵 → 工业的步枪兵、或工业的线列步兵 → 二战的摩托化步兵。
 * 定低了会在同一代里来回倒手，定高了"编制被旧兵占死"这个病又治不回来。
 */
const SWAP_GAIN = 1.35;

/**
 * 攒升级时的咬住窗口（默认 `SAVE_TIGHT_TURNS = 4`）。
 *
 * 为什么升级要单给一个更长的窗口：升级费是本局最大的一笔固定支出（4 代以上 540~780），
 * 而 AI 的现金流是"每回合花到只剩一两百"。4 回合的窗口意味着**它必须在
 * 差距还很大时就开始停手**，否则永远差一口气——实测一局真人对抗里，
 * 人类升了 8 次城、AI 只升了 2 次，差价是整局输赢的主因（见 REVIEW-2026-11-02-report-88.md）。
 * 8 回合是量出来的：60 局对上一版 +8.6 点（58.6%，z=1.31）。
 */
const ERA_TIGHT_TURNS = 8;

/**
 * 攒钱意向的记忆时长（回合）与"换目标的门槛"。
 *
 * 时长：一个攒钱目标从立下到兑现，实测中位数在 3~6 回合（升时代 4 个回合左右、
 * 英雄 5~7 个）。给到 8 是留一次"算错了、但还没离谱"的余量——超过 8 个回合
 * 还在攒同一个目标，多半是够不着了，那时候该重新算，而不是继续抱着。
 *
 * 门槛：旧目标还在候选里时，新目标必须比它高 30% 才许换。两个分数咬得很紧的
 * 目标（英雄 4.72 vs 升时代 4.41）每回合互换一次的下场是**两边都攒不够**——
 * 钱在两座城之间来回跑，一个目标也没兑现。
 */
const INTENT_TURNS = 8;
const INTENT_MARGIN = 1.3;

/**
 * 一层推演的权重与宽度。
 *
 * `LOOKAHEAD_W`：把"走完这一步之后，对手下一回合最狠的一刀"折成分数时打几折。
 * 0.35 是保守值——这一项和第 5 条（多回合威胁）是同一个方向的判断，
 * 两边都拿满权重会把 AI 压成"不敢过河"的乌龟。要的只是"别把兵送到刀口上"。
 *
 * `LOOKAHEAD_K`：只推演前几名。全部候选各克隆一份状态去算，一回合要克隆几十次，
 * 换来的只是"第 7 名和第 6 名之间的细节"。前几名足够抓到"这步会不会白送"。
 */
const LOOKAHEAD_W = 0.35;
const LOOKAHEAD_K = 6;

/**
 * 换家的门槛：对面身价要到我的多少倍，才算"打不过、该换个地方打"。
 *
 * 1.6 是量出来的分寸——1.3 太松（只是略处下风就弃城），2.0 太紧（等它压到城下
 * 才想明白，那时候人已经挪不动了）。这一条只解决"整支军队打不过"，不解决
 * "这一座城守不守得住"，后者归 mood 的 boom/弃城那一档管。
 */
const TRADE_AT = 1.6;

/**
 * 攒钱期"这一回合能动用多少现金"。
 *
 * 老公式是 `余额 − 目标费用`：手里留够目标价，多出来的才能花。它的问题不在保守，
 * 而在**二值**——只要还差一截，额度就是 0，整回合一个兵都造不出来。目标越大
 * （升时代、重建费）停得越久，而对面在这几个回合里照常出兵。第一版硬停采购
 * 实测胜率掉到 38.8%（见 buildPlan 顶部那段注释），掉的就是这个。
 *
 * 想修就得先看清一个约束：**这个棋里一个兵的价格本来就接近一回合的收入**。
 * 于是"每回合都买得起"和"攒得下钱"是互斥的——收入全变成兵，余额永远上不去；
 * 而任何按比例（比如收入的 40%）给的额度都小于一个兵的价格，等于还是 0。
 * 人类的做法很清楚：**隔一个回合补一个兵**，剩下的收入攒着。
 *
 * 所以这里按回合轮流出兵：
 *   · 相位 0 的回合：放出"一个回合的收入"这一档额度，够买一个正常的兵；
 *   · 相位 1 的回合：一分不动，纯攒。
 * 相位按**轮**算，不按 `s.turn` 的奇偶——两人局里 s.turn 是一人一格轮着走的，
 * 直接取奇偶会变成"主队永远出兵、客队永远不动"，一边倒的不是 AI 是发牌。
 * 净存款每回合还有约一半收入，目标照样到期兑现；产线速率掉一半，但不断。
 * 用回合奇偶而不是"记住上回合买没买"，是因为 AI 没有跨回合状态
 * （refreshMemory 只管战争迷雾）——同样的局面必须推出同样的结论。
 *
 * 两个例外：
 *   · 目标已经够得着 → 不冻结（目标本身由 isTarget 的加分保证会被买走）；
 *   · 弃城期 → 额度为 0。那一档的战术定义就是"停手换档"：用一座城换一代科技，
 *     中间还在补便宜兵等于两头都不占，它要的是纯粹的预留（和老口径一致）。
 */
export function savingAllowance(
  gold: number,
  inc: number,
  targetCost: number,
  /** 同时能产兵的产兵点数量：额度是"一回合的产出预算"，几家分 */
  sites: number,
  /** 是否保留产线（弃城期关掉，见上面最后一句） */
  keepLine: boolean,
  /** 轮流出手的相位：0 出兵、1 纯攒（按"轮"算，见上） */
  phase: number,
  /**
   * 咬住窗口：离目标还有几个回合的收入时开始一分不花。
   *
   * 默认 `SAVE_TIGHT_TURNS`。攒**升级**时用更长的 `ERA_TIGHT_TURNS`——
   * 实测（`docs/UPDATE-2026-11-02-patches.md`）把升级的窗口从 4 放到 8，
   * 升级次数从 2.3 次/局升到 2.7，对上一版胜率 +8.6 点（60 局）。
   */
  tight = SAVE_TIGHT_TURNS,
): number {
  if (targetCost <= 0 || gold >= targetCost) return Infinity;
  if (!keepLine) return 0;
  /*
   * 就差一两个回合的收入了：这时候还去补兵，等于把马上到手的目标又推远。
   * 短暂停手（一两回合）是划算的，长停（五个回合以上）才是要修的病——
   * 这一条把它限制在前者。
   */
  if ((targetCost - gold) / Math.max(1, inc) <= tight) return 0;
  if (phase !== 0) return 0;
  /*
   * 额度是"这一回合的产出预算"，不是"每个兵都能花这么多"：
   * 采购是逐候选比的，两座城就能在同一个回合各买一个——不除产兵点数量，
   * 一个回合能花掉两回合的收入，攒的钱永远追不上目标。
   */
  return Math.max(1, Math.floor(inc / Math.max(1, sites)));
}

/**
 * 一个攒钱目标：攒什么、多少钱、值不值。
 *
 * `score` 和采购评分共用一把尺子（`combatEfficiency`：战力 ÷ 价格^PRICE_EXP），
 * 只是"战力"的口径按目标换算——一个兵是它自己的战力，升时代是"以后每个名额
 * 多产多少战力"折算出来的增量，收废墟是"多一份每回合收入"折算出来的增量。
 * 这样四个目标可以直接排大小，"为什么攒这个"就有据可查，而不是四条 if 的先后。
 */
interface SaveGoal {
  kind: 'hero' | 'era' | 'rebuild' | 'unit';
  targetUnitId: string | null;
  /** 升时代 / 收废墟时对准的那座城（跨回合记忆要记它，不然复活时会认错目标） */
  cityId?: string | null;
  cost: number;
  score: number;
  note: string;
}

/**
 * 上一次的攒钱意向现在还成不成立？（`buildPlan` 的"复活"用它）
 *
 * 四条目标各自问一句：**还在卖吗、还升得动吗、废墟还在吗、还买不起吗**。
 * 最后那一问是关键——钱已经够了就该把这笔钱花出去（采购环节会买），
 * 而不是继续举着"我在攒它"的牌子把产线冻住。
 */
function reviveIntent(
  s: GameState,
  me: PlayerId,
  it: AiIntent,
  ctx: {
    gold: number;
    heroOwned: boolean;
    heroDef: UnitTypeDef | null;
    heroCost: number;
    eraCity: City | null;
  },
): { cost: number; unitId?: string | null; cityId?: string | null; note: string } | null {
  if (it.goal === 'hero') {
    if (ctx.heroOwned || !ctx.heroDef || ctx.heroCost <= 0) return null;
    if (ctx.gold >= ctx.heroCost) return null;
    return { cost: ctx.heroCost, note: `${ctx.heroDef.name}（英雄，接着攒）` };
  }
  if (it.goal === 'era') {
    const city = it.cityId ? cityById(s, it.cityId) : null;
    if (!city || city.owner !== me || city.ruined) return null;
    const cost = upgradeCostOf(s, city);
    if (cost === null || ctx.gold >= cost) return null;
    return { cost, cityId: city.id, note: `升到第 ${city.era + 1} 代（接着攒）` };
  }
  if (it.goal === 'rebuild') {
    const ruin = it.cityId ? cityById(s, it.cityId) : null;
    if (!ruin || !ruin.ruined || ruin.owner === me) return null;
    const cost = rebuildCost(ruin);
    if (ctx.gold >= cost) return null;
    return { cost, cityId: ruin.id, note: '重建这座废墟（接着攒）' };
  }
  const def = it.unitId ? s.unitTypes[it.unitId] : null;
  if (!def || def.category !== 'combat') return null;
  const price = Math.max(1, recruitPriceOf(s, me, def).gold);
  if (ctx.gold >= price) return null;
  return { cost: price, unitId: def.id, note: `${def.name}（接着攒）` };
}

function buildPlan(
  s: GameState,
  me: PlayerId,
  my: Unit[],
  foe: Unit[],
  mood: AiMood,
): AiPlan {
  const gold = s.players[me].gold;
  const inc = Math.max(1, incomeResOf(s, me).gold ?? 0);
  const myCities = citiesOf(s, me).filter(c => !c.ruined);
  const combat = my.filter((u) => utype(s, u.type).category === 'combat');
  const army = combat.length;
  const valueOf = (us: Unit[]): number =>
    us.filter((u) => utype(s, u.type).category === 'combat').reduce(
      (n, u) => n + (utype(s, u.type).cost ?? 0),
      0,
    );
  const myVal = valueOf(my);
  const foeVal = valueOf(foe);

  // 城下有人：这时候攒钱是自杀。半径 3 是"下回合就能摸到城墙"的量级。
  //
  // 但**放弃掉的那座城不算**：弃城这一档的全部前提就是"门口那座城我已经不要了"，
  // 要是它一被围就把紧急开关按下去，攒钱计划当回合就作废——弃城变成了空话。
  const threaten = foe.some((u) =>
    myCities.some((c) => c.id !== mood.abandonedCityId && distToCity(u, c) <= 3),
  );
  // 前线已经丢掉后，安全后方继续兑现发展；不能把废墟附近的敌人当作救城警报。
  // 后方受威胁、经济基础不足或局势不再适合发展时，自然恢复常规防守/进攻。
  const developingRear = myCities.length === 1 && mood.weight.boom >= ABANDON_AT &&
    mood.metrics.earners >= 2 && foe.every(u =>
      utype(s,u.type).category !== 'combat' || distToCity(u,myCities[0]!) > effectiveRangeAgainst(s,u,tileAt(s,myCities[0]!.x,myCities[0]!.y))+2);
  const urgent = (army < 3 && !developingRear && !mood.abandonedCityId) || threaten;

  // 没被打塌的敌城，和已经塌了等接管的废墟。
  //
  // 废墟是这套规则里最别扭、也最关键的一环：城打空了**不会易主**，只是变成废墟，
  // 想真正拿到它得派兵走进去、掏 maxHp×2.5 的重建费。也就是说"破城"和"赢"
  // 之间还隔着一笔巨款——而这笔钱如果每回合都被拿去补兵，就永远攒不出来。
  // 实测 80 局里三成打到回合上限，一半以上是"城都砸烂了，两边谁都掏不起重建费"。
  // 所以这一条不是"更聪明的经济"，是把平局变成胜局的那一步。
  const foeCities = s.cities.filter((c) => !c.ruined && c.owner !== me);
  const foeRuins = s.cities.filter((c) => c.ruined && c.owner !== me);
  // 对面只剩这一座（还成了废墟）：收回来就直接结束对局，这时候攒多久都值得
  const winningReclaim = foeRuins.length > 0 && foeCities.length <= 1;

  // 没有英雄时，把"最便宜的那个能用的英雄"当成攒钱目标。
  // 注意 unlockCost 要一起算进去——只算造价会让 AI 到店门口发现差一笔解锁费。
  const heroOwned = my.some((u) => utype(s, u.type).hero);
  const maxEra = myCities.reduce((m, c) => Math.max(m, c.era), 1);
  const heroDef = heroOwned
    ? null
    : Object.values(s.unitTypes)
        .filter((d) => d.hero && d.category === 'combat' && d.era <= maxEra && myCities.some(c =>
          !c.ruined && c.id!==mood.abandonedCityId && c.era>=d.era && c.era<=d.era+1))
        .sort((a, b) => (a.cost ?? 0) - (b.cost ?? 0))[0];
  const heroCost = heroDef
    ? recruitCost(s, me, heroDef) +
      ((s.unlocked?.[me] ?? []).includes(heroDef.id) ? 0 : (heroDef.unlockCost ?? 0))
    : 0;

  const eraCosts = myCities
    .map((c) => upgradeCostOf(s, c))
    .filter((x): x is number => x !== null);
  /*
   * 攒时代要攒**主城**的升级费，不是最便宜的那座。
   *
   * 2026-11-02 修：原来这里是 `Math.min(...eraCosts)` —— 也就是最低代那座城的价。
   * 于是"攒钱升时代"这个机制本身在推着 AI 往副城上花钱：副城便宜、先够得着、
   * 先升上去，主城永远差一口气。人集中升一座城是有道理的（只有到顶那座能造新兵，
   * 见 rules 的 eraWindowOk），而这个 min 恰好把 AI 推向了反面。
   */
  const mainCity = myCities
    .filter((c) => !c.ruined && c.id !== mood.abandonedCityId)
    .sort((a, b) => b.era - a.era || (upgradeCostOf(s, b) ?? 0) - (upgradeCostOf(s, a) ?? 0))[0];
  const mainEraCost = mainCity ? upgradeCostOf(s, mainCity) : null;
  const eraCost = mainEraCost ?? (eraCosts.length > 0 ? Math.min(...eraCosts) : null);

  let savingFor: AiPlan['savingFor'] = null;
  let targetCost = 0;
  let targetUnitId: string | null = null;
  let targetCityId: string | null = null;
  let goalScore = 0;
  let goalNote = '';
  let goalOptions: AiPlan['goalOptions'] = [];
  /** 上一次立下的意向（跨回合记忆，见 types.ts 的 aiIntent） */
  const prev = s.aiIntent?.[me] ?? null;
  // 弃城期把"兵够不够"的门槛压低：这一档要的就是兵力少的时候也能攒钱，
  // 而不是"兵少于六个就永远别想升级"。urgent 那条线照旧拦着真正的危险。
  const armyGate = mood.weight.boom > 0.45 ? 4 : 6;

  // 收废墟的可执行性：隔壁没兵走过去，攒的是别人的战利品。
  const nearbyRuin = foeRuins
    .filter((c) =>
      my.some((u) => !u.moved && distToCity(u, c) <= Math.max(2, utype(s, u.type).move + 1)),
    )
    .sort((a, b) => rebuildCost(a) - rebuildCost(b))[0];

  /*
   * ── 攒什么：交给 AI 自己那把尺子来排 ──
   *
   * 原来的顺序是写死的四条 if：收废墟 > 英雄 > 升时代 > 大件。顺序本身有道理
   * （越靠前越接近"质变"），但它不是**算**出来的，所以永远回答不了
   * "这个 700 金的英雄，和把主城升到下一代，哪个更值"。
   *
   * 现在四个目标排在一张表上比，尺子和采购评分共用同一条公式
   * （`combatEfficiency`：战力 ÷ 价格^PRICE_EXP），"战力"的口径按目标换算：
   *   · 一个兵   → 它自己的战力
   *   · 英雄     → 自己的战力 × HERO_PREMIUM（独占性）
   *   · 升时代   → 每个出生名额更值钱 → 战力增量 × 视野内还能造几个兵 × 时间折扣
   *   · 收废墟   → 多一份每回合收入 → 视野内收入 × 当前每金战力
   * 于是"攒钱"是一次 argmax，而不是四条 if 的先后，理由可以逐条摊开看。
   *
   * 唯一保留的硬规则是收废墟的终局判断：对面只剩最后一座（还是废墟）时，
   * 那不是性价比问题，是胜负问题，直接给到最高分。
   *
   * 挑选必须是**确定性的**：同样的局面永远挑出同一个目标。AI 没有跨回合状态
   * （refreshMemory 只管战争迷雾），想让它"连攒三个回合"，只能靠
   * "同样的输入推出同样的目标"。
   */
  /*
   * 攒钱的门槛：兵太少时不攒（urgent 那条线同理），但**弃城期例外**。
   *
   * 弃城期的整条路线就是"兵少、放弃前线、把钱全押在换代上"，这时候还要求
   * "手上至少四个兵才准攒钱"，等于这一档永远开不起来——它本来就是兵力劣势时的选择。
   * 原来那段代码写在门槛外面，所以能跑；搬进统一的目标比较之后，这个例外得明写出来。
   */
  const abandonMode = Boolean(mood.abandonedCityId) || developingRear;
  /*
   * 兵池只在这个分支里枚举：buildPlan 是**每个动作**都要跑一次的，
   * 全兵种扫一遍（一百多个兵 × 每个算一次报价）放在外面，一局下来是白烧的时间。
   */
  let allowance = Infinity;
  let buildAllowance = Infinity;
  if (!urgent && (abandonMode || army >= armyGate)) {
    const makeablePool = Object.values(s.unitTypes).filter(
      (d) =>
        d.category === 'combat' &&
        !d.summonedOnly &&
        canUseType(s, me, d.id) &&
        eraWindowOk(s, d, maxEra),
    );
    const goldOf = (d: UnitTypeDef): number => recruitPriceOf(s, me, d).gold;
    const effOf = (d: UnitTypeDef): number => combatEfficiency(d, goldOf(d));
    const perGoldOf = (d: UnitTypeDef): number => combatPower(d) / Math.max(1, goldOf(d));

    // 弃城期算的是"留在手里的那几座城"：那座已经放弃的城，升级费不该再进计划
    const eraCity: City | null = abandonMode
      ? (myCities
          .filter((c) => !c.ruined && c.id !== mood.abandonedCityId)
          .map((c) => ({ c, cost: upgradeCostOf(s, c) }))
          .filter((x): x is { c: City; cost: number } => x.cost !== null)
          .sort((a, b) => a.cost - b.cost)[0]?.c ?? null)
      : (mainCity ?? null);
    const eraTarget = eraCity ? upgradeCostOf(s, eraCity) : eraCost;
    const heroHorizon = abandonMode ? 4 : SAVE_HORIZON;
    /** 视野之内够得着才值得停手：攒不到头的目标只会让 AI 整局不出兵 */
    const reach = (cost: number, horizon: number): boolean => gold + inc * horizon >= cost;

    // "现在就买得到的最好那个"：攒钱得和它比，才谈得上"值不值得等"
    const bestNow = makeablePool
      .filter((d) => goldOf(d) > 0 && goldOf(d) <= gold)
      .sort((a, b) => effOf(b) - effOf(a))[0];
    const nowEff = bestNow ? effOf(bestNow) : 0;
    // 每金战力：把"以后每一笔军费"折成战力时的汇率（用最强的那一档，不用平均值——
    // 攒钱本来就是为了以后买得起那一档，拿平均去折会把长期收益算低）
    const bestPerGold = makeablePool.reduce((m, d) => Math.max(m, perGoldOf(d)), 0);
    const foeEra = Math.max(
      0,
      ...s.cities.filter((c) => !c.ruined && c.owner !== me).map((c) => c.era),
    );

    const goals: SaveGoal[] = [];

    // 收废墟：多一座城 = 多一份每回合收入。
    //
    // 弃城期不排它：那条路线的定义就是"用前线换科技"，收一座废墟等于把钱又押回前线，
    // 和"放弃这座城"是两件事。（以前这也是硬写死的，现在只是把理由说明白。）
    const ruinTarget = winningReclaim
      ? [...foeRuins].sort((a, b) => rebuildCost(a) - rebuildCost(b))[0]
      : abandonMode
        ? undefined
        : nearbyRuin;
    if (ruinTarget && reach(rebuildCost(ruinTarget), winningReclaim ? 14 : 8)) {
      const cost = rebuildCost(ruinTarget);
      const perCityInc = inc / Math.max(1, myCities.length);
      const gain = perCityInc * INVEST_HORIZON * bestPerGold;
      goals.push({
        kind: 'rebuild',
        targetUnitId: null,
        cityId: ruinTarget.id,
        cost,
        score: winningReclaim ? 1e9 : gain / Math.max(20, cost) ** 0.8,
        note: winningReclaim
          ? '收回对面最后一座城 = 赢'
          : `多一座城，${INVEST_HORIZON} 回合多约 ${Math.round(perCityInc * INVEST_HORIZON)} 金`,
      });
    }

    // 英雄：数值之外的独占性按 HERO_PREMIUM 折进来
    if (heroDef && heroCost > 0 && reach(heroCost, heroHorizon)) {
      goals.push({
        kind: 'hero',
        targetUnitId: null,
        cost: heroCost,
        score: effOf(heroDef) * HERO_PREMIUM,
        note: `${heroDef.name}（英雄，场上仅此一只）`,
      });
    }

    /*
     * 升时代：换回来的不是"多一个兵"，是**每个出生名额更值钱**。
     *
     * 为什么按名额算、不按金币算：金币会被收入追平（每回合都在进），
     * 名额追不平——每座城每回合只能出一个兵，AI 的编制上限还压着 24 个。
     * 真正的稀缺资源是名额，所以升时代的价值是"以后每一个名额多产多少战力"。
     *
     * 两个折扣都要打明白：
     *   · 未来才到手的战力要折半（兵是现在就能用的，升级是十五个回合里慢慢兑现的）；
     *   · 视野内造不了几个兵（名额 + 钱谁先卡住算谁），最多按 5 个算。
     * 不打这两个折扣，升时代会永远碾压一切，AI 就又回到"整局只顾升城"。
     */
    if (eraCity && eraTarget !== null && reach(eraTarget, SAVE_HORIZON)) {
      const nextPool = Object.values(s.unitTypes).filter(
        (d) =>
          d.category === 'combat' &&
          !d.summonedOnly &&
          canUseType(s, me, d.id) &&
          d.era === eraCity.era + 1,
      );
      const curPower = makeablePool.reduce((m, d) => Math.max(m, combatPower(d)), 0);
      const nextPower = nextPool.reduce((m, d) => Math.max(m, combatPower(d)), 0);
      const delta = Math.max(0, nextPower - curPower);
      const priceNow = bestNow ? goldOf(bestNow) : eraTarget;
      const futureUnits = Math.max(
        1,
        Math.min(5, Math.round((inc * INVEST_HORIZON) / Math.max(1, priceNow))),
      );
      const gain = delta * futureUnits * ERA_TIME_DISCOUNT;
      if (gain > 0) {
        goals.push({
          kind: 'era',
          targetUnitId: null,
          cityId: eraCity.id,
          cost: eraTarget,
          score: gain / Math.max(20, eraTarget) ** 0.8,
          note:
            `升到第 ${eraCity.era + 1} 代：每个名额 +${Math.round(delta)} 战力` +
            ` ×${futureUnits} 个名额${foeEra > maxEra ? '（对面已领先）' : ''}`,
        });
      }
    }

    // 大件：只有"明显比现在能买的更值"才值得为它停手。
    // 1.2 倍是门槛——只强一点点的大件不值得牺牲一个回合的产线。
    // 弃城期不排大件：这一档要的是换代，不是再补一个兵。
    const big = abandonMode
      ? undefined
      : makeablePool
          .filter((d) => goldOf(d) > gold && reach(goldOf(d), SAVE_HORIZON))
          .sort((a, b) => effOf(b) - effOf(a))[0];
    if (big && (nowEff <= 0 || effOf(big) > nowEff * 1.2)) {
      goals.push({
        kind: 'unit',
        targetUnitId: big.id,
        cost: goldOf(big),
        score: effOf(big),
        note: `${big.name}（${goldOf(big)} 金，现在买不起）`,
      });
    }

    goals.sort((a, b) => b.score - a.score);
    goalOptions = goals.map((g) => ({ kind: g.kind, cost: g.cost, score: g.score, note: g.note }));
    /*
     * ── 粘性：上一次的目标还在候选里，就不许被"只强一点点"的新目标顶掉 ──
     *
     * 这是跨回合记忆的第二半（第一半是下面那段"复活"，管的是"整段攒钱被跳过"）。
     * 这里管的是更常见的一种抖：目标 A 4.72、目标 B 4.41，两边轮流当第一名，
     * 钱就在两条线之间来回跑，哪个都攒不够。人的做法是"我定了 A 就先攒 A"。
     */
    let pick = goals[0];
    if (pick && prev) {
      const held = goals.find(
        (g) => g.kind === prev.goal && (prev.goal !== 'unit' || g.targetUnitId === (prev.unitId ?? null)),
      );
      const fresh = s.turn - prev.since <= INTENT_TURNS;
      if (held && held !== pick && fresh && pick.score < held.score * INTENT_MARGIN) pick = held;
    }
    if (pick) {
      savingFor = pick.kind;
      targetCost = pick.cost;
      targetUnitId = pick.targetUnitId;
      targetCityId = pick.cityId ?? null;
      goalScore = pick.score;
      goalNote = pick.note;
      /*
       * 攒钱期每回合能动用多少现金（见 savingAllowance）。
       *
       * 相位按"轮"算，不按 s.turn 的奇偶：两人局里 s.turn 是一人一格轮着走的，
       * 直接取奇偶会变成"先手方永远出兵、后手方永远不动"——那不是 AI 的差别，是发牌。
       */
      const phase = Math.floor(s.turn / Math.max(1, seatsOf(s).length)) % 2;
      // 建筑照旧只吃"留够目标价之后的那部分"：囤摊子比补兵慢得多
      buildAllowance = Math.max(0, gold - targetCost);
      allowance = savingAllowance(
        gold, inc, targetCost, myCities.length, !abandonMode, phase,
        pick.kind === 'era' ? ERA_TIGHT_TURNS : SAVE_TIGHT_TURNS,
      );
    }
  }

  /*
   * ── 复活：整段攒钱被跳过时，把上一次的目标接上 ──
   *
   * 这一段才是"攒到一半就忘"那个 bug 的正解。原来的现场是：
   * 第 15 回合它决定攒英雄、把采购全冻住；第 17 回合那座"已放弃"的城被对面拆了
   * → `abandonMode` 变 false、兵力又不够 `armyGate` → 整个攒钱分支被跳过
   * → `savingFor` 变 null → 攒的钱当场散回产线，前面两个回合白攒。
   *
   * 人的反应是"我这一路就是要攒英雄"，不是"城没了那算了"。
   * 所以只要目标还站得住（还在卖、那座城还升得动、废墟还在），就接着攒，
   * 价格按现在重问。急事照旧例外——城下有人还在攒钱，那是拿命省钱。
   */
  if (!savingFor && !urgent && prev && s.turn - prev.since <= INTENT_TURNS) {
    const revive = reviveIntent(s, me, prev, { gold, heroOwned, heroDef, heroCost, eraCity: mainCity });
    // 够不着也就不叫"接着攒"了——那只是拿产线换一个永远到不了的数
    // （这正是上一版放开额度时掉到 38.8% 的那个坑）。视野之内够得着才接上。
    if (revive && gold + inc * SAVE_HORIZON >= revive.cost) {
      if (aiTrace.on) aiTrace.revive += 1;
      savingFor = prev.goal;
      targetCost = revive.cost;
      targetUnitId = revive.unitId ?? null;
      targetCityId = revive.cityId ?? null;
      goalScore = 0;
      goalNote = revive.note;
      const phase = Math.floor(s.turn / Math.max(1, seatsOf(s).length)) % 2;
      buildAllowance = Math.max(0, gold - targetCost);
      allowance = savingAllowance(
        gold, inc, targetCost, myCities.length, !abandonMode, phase,
        prev.goal === 'era' ? ERA_TIGHT_TURNS : SAVE_TIGHT_TURNS,
      );
    }
  }



  // 兵力明显不如对面、对面又已经压到门口：收缩固守，把人留在城里。
  //
  // 这里比以前收紧了一档：以前是"只要身价落后就固守"，可 AI 一旦进入攒钱期
  // 身价必然落后，于是它自己把自己锁进固守、再也不出击（第一版就是这个死循环：
  // 越攒越不敢打，越不敢打越攒不出胜势）。固守是**防守姿态**，得真有敌人来攻。
  const weaker = myVal < foeVal * 0.75;
  const atGate = foe.some((u) =>
    myCities.some((c) => c.id !== mood.abandonedCityId && distToCity(u, c) <= 5),
  );
  /*
   * ── 换家：正面打不过，就别在正面耗 ──
   *
   * 这是这套 AI 一直缺的那一档战略判断：`stance` 只有 push / turtle / elite，
   * 也就是"往前推 / 缩回城里 / 花大钱"。三条都在回答"怎么打这一仗"，
   * 没有一条回答"**这一仗还该不该在自家城下打**"。
   * 于是两线被攻时它只会来回折返：哪边报急就往哪边挪，两头都守不住，
   * 还把兵一个个送在城下。人会做的判断是：这波守不住，把城让给他，
   * 我带人去过他那边的经济——他回防就解围，不回防就换家。
   *
   * 触发条件必须同时成立，缺一条就变成"动不动就放弃"：
   *   · 家门口已经有一座城快塌了（≤ 半血，且敌人贴到 3 格内）；
   *   · 身价被压到六成以下（1.6 倍差距）——不是"略处下风"，是打不过；
   *   · 手上还有 4 个以上战斗单位（够打一波，不是残兵）；
   *   · 我的人已经摸到对面某座城 8 格以内（换家要有着力点，不能是空喊）。
   */
  const doomedNow = myCities.some(
    (c) => c.hp <= c.maxHp * 0.5 && foe.some((u) => distToCity(u, c) <= 3),
  );
  const reachFoe = my.some(
    (u) =>
      utype(s, u.type).category === 'combat' &&
      foeCities.some((c) => distance(u, c) <= 8),
  );
  const trade = doomedNow && myVal > 0 && foeVal > myVal * TRADE_AT && army >= 4 && reachFoe;
  // 精兵姿态：兵不是"越多越好"，是"每个出生名额都该值回票价"。
  // 每回合只有两个产兵名额（AI 的编制上限也压着），所以只要手头比一个兵宽裕
  // （金 ≥ 1.2 回合收入）或者编制快满，就该往贵的、能打的上面花钱。
  // 攒钱期同理：钱是要攒着买好的，再拿线性单价惩罚去压大件等于自我否定。
  const quality = savingFor !== null || gold >= inc * 1.2 || army >= CONFIG.maxUnits - 6;
  // 弃城期一律按"精兵"花钱：钱要攒着换时代/英雄，不该拆成一堆便宜兵。
  // 换家也一样：这时候每一分钱都要换成能打穿城墙的东西，不是铺散兵线。
  const elite = quality || mood.weight.boom > 0.5 || trade;
  const stance: AiPlan['stance'] = trade
    ? 'trade'
    : weaker && army >= 3 && atGate
      ? 'turtle'
      : elite
        ? 'elite'
        : 'push';

  /*
   * 把这一回合的意向写回状态。
   *
   * 写在 buildPlan 里是有意的：目标就是在这里选出来的，写到别处必然出现
   * "计划是英雄、记忆是时代"的分叉。`s` 在 aiNextAction 里是**雾图副本**，
   * 所以那边还要把它搬回真状态（见 aiNextAction 里的搬运用那几行）。
   */
  if (savingFor) {
    const same = prev !== null && prev.goal === savingFor && (prev.unitId ?? null) === (targetUnitId ?? null);
    s.aiIntent = {
      ...(s.aiIntent ?? {}),
      [me]: {
        goal: savingFor,
        unitId: targetUnitId ?? undefined,
        cityId: targetCityId ?? undefined,
        cost: targetCost,
        since: same ? prev.since : s.turn,
        seen: s.turn,
      },
    };
  } else if (prev) {
    const bag = { ...(s.aiIntent ?? {}) };
    delete bag[me];
    s.aiIntent = bag;
  }

  return {
    stance,
    savingFor,
    targetCost,
    targetUnitId,
    allowance,
    buildAllowance,
    goalScore,
    goalNote,
    goalOptions,
    urgent: mood.abandonedCityId ? threaten : urgent,
  };
}

/**
 * 诊断用：把"这一方此刻的计划"摊开，和 `aiNextAction` 走同一套口径。
 *
 * 线上对局库里那十几局被打崩的人机局，AI 造了 43 个单位却一个战斗单位都没有。
 * 光看终局快照推不出原因——真正要看的是**每一回合 `savingFor` 是什么**：
 * 一旦它非空，采购就被"超出目标费用的那部分"冻住，而经济单位有
 * 「回本 ≤8 回合不冻结」的例外，战斗单位没有。于是钱能变成农民，却永远变不成兵。
 *
 * 这个函数只读不写，给 `scripts/diag-plan.ts` 和人工排查用。
 */
export function aiDebugPlan(s: GameState, me: PlayerId): AiPlan {
  const traits = aiTraits(s);
  const mood = aiActiveMood(s, traits);
  return buildPlan(s, me, unitsOf(s, me), unitsOf(s, other(me)), mood);
}

/**
 * 诊断出口：`recruitCandidate` 每次"挑不出兵"时，往这里写一句原因。
 *
 * 线上那十几局被打崩的人机局，AI 账上还有几百金、产兵名额也没用完，却一整个回合
 * 不造兵。这种"沉默的拒绝"在黑盒模拟里看不出来——胜负只有一个数字，
 * 而钱花不出去的原因藏在七八个 `continue` 里。把原因写出来，排查就从"猜"变成"看"。
 *
 * 游戏运行时没人读它，默认 `last` 为空；只有 `scripts/diag-plan.ts` 会打开。
 */
export const aiRecruitTrace: {
  on: boolean;
  last: string | null;
  /**
   * 按兵种记的拒绝原因：type → reason → 次数。
   *
   * `last` 只给汇总（"这一回合为什么一个都没买"），定位不到**具体哪个兵被谁挡住的**。
   * 2026-11-02 查"数据好却没人造"时才发现缺这一层：汇总里写着"钱不够×3"，
   * 但看不出是天使被钱挡住还是炼金术士被时代挡住。
   */
  detail: Map<string, Map<string, number>> | null;
} = { on: false, last: null, detail: null };

/**
 * 五个结构性缺口的**行为计数器**（诊断用，默认全关）。
 *
 * 为什么需要它：胜负只告诉你"整批改动有没有用"，看不出"某一个机制到底有没有
 * 真正跑起来"。而"没跑起来"和"跑起来但没效果"是两件完全不同的事——
 * 前者是 bug（条件写错了、永远不触发），后者才是"这一条不重要"。
 *
 * 只在 `on` 时累加，所以线上跑的时候一行额外的味道都没有。
 * 用法见 `scripts/probe-ai-five.ts`。
 */
export const aiTrace = {
  on: false,
  /** 换血：解散旧兵腾位置触发了几次 */
  swap: 0,
  /** 换家：整回合处于 trade 姿态的次数（按"动作"计，同一回合会多次） */
  tradeCalls: 0,
  /** 攒钱意向被"复活"接上的次数（原来这里会变 null，钱散回产线） */
  revive: 0,
  /** 分到佯攻那一翼的"单位·回合"数 */
  flankUnits: 0,
  /** 一层推演把首选动作换掉了的次数 */
  lookaheadFlip: 0,
  swapWhy: new Map<string, number>(),
  reset(): void {
    this.swapWhy.clear();
    this.swap = 0;
    this.tradeCalls = 0;
    this.revive = 0;
    this.flankUnits = 0;
    this.lookaheadFlip = 0;
  },
};

/**
 * 兵种战力 / 性价比：**实现在 core/unit-value.ts**，这里只做转发。
 *
 * 为什么搬走：这两把尺子原来只读 `攻 / √血 / 射程`，于是
 * **移速、视野、多段、能力全都不算钱**——龙骑兵（移 5、冲锋）在 AI 眼里
 * 只值 2.28 的性价比，排在所有同代兵种的最后，100 局只被造 3 个；
 * 而它在人手里是 95% 胜率打法的核心。公式和审计脚本现在是同一份实现，
 * 不会再出现"审计说它便宜、AI 说它贵"的自相矛盾。
 */
/*
 * 两把尺子并存：**决策**用哪一把，是可以用开关切的。
 *
 * 起因是"镜子对局"的读数：新尺子（兰彻斯特 + 时代谱 + 复利）在 3 代打不过旧尺子
 * 那套 `攻×√血×射程`。而旧尺子并不"更对"——它只是偏向便宜、量大、带射程，
 * 恰好和这套 AI 目前**只会打的那种仗**合拍：堆人、平推、不撤不集火。
 *
 * 所以把选择权留成开关，而不是把结论写死：
 *   WB_OLD_RULER=1 时采购用旧尺子（新模型照旧供报表/审计用）。
 * 这样"报表说 A 好、AI 买 B"的矛盾是显式的，而不是藏在代码里。
 */
/*
 * 默认走旧尺子（2026-11-03 定）：新尺子的估价更讲道理，但采购换过去之后
 * 镜子对局从 50% 掉到 35%——因为贵兵需要一套 AI 还没有的战术。
 * 想用新尺子跑实验：`WB_RULER=new`。
 */
const OLD_RULER =
  (typeof process === 'undefined' ? '' : process.env.WB_RULER) !== 'new';
const oldPower = (d: UnitTypeDef): number =>
  (d.atk + (d.magicAtk ?? 0) * 1.2) *
  Math.sqrt(d.maxHp) *
  (1 + Math.min(4, Math.max(0, (d.range ?? 1) - 1)) * 0.45);
const oldEfficiency = (d: UnitTypeDef, price: number): number =>
  oldPower(d) / Math.max(20, price) ** 0.8;

const combatPower: typeof unitPower = OLD_RULER ? oldPower : unitPower;
const combatEfficiency: typeof unitEfficiency = OLD_RULER ? oldEfficiency : unitEfficiency;

/**
 * 局势现在打在第几代：取**场上已经出现的最高城代**（下限是开局时代）。
 *
 * 单拎出来是因为有两个地方要问它，而它们必须得到同一个答案：
 * 估价（valueContextOf 的时代谱）和建造（判断一座产兵点落成之后造不造得出东西）。
 * 两处各写一遍，就会在某天只改了一处。
 */
function eraNowOf(s: GameState): number {
  return Math.max(s.config.startEra, ...s.cities.filter((c) => !c.ruined).map((c) => c.era));
}

/**
 * 这一刻"值多少钱"要看局面：移速在防守时打折、压上时加价；
 * 己方视野已经很开阔时，再买一双眼睛的边际价值下降。
 * 具体权重在 `core/unit-value.ts`，这里只负责把局面翻译成 `ValueContext`。
 */
function valueContextOf(s: GameState, me: PlayerId, plan: AiPlan): ValueContext {
  const tempo = plan.stance === 'push' || plan.stance === 'trade' ? 1 : plan.stance === 'turtle' ? -1 : 0;
  const mine = unitsOf(s, me);
  // 视野冗余度：全军平均视野 / 6（6 格算"够开阔"）
  const coverage =
    mine.length === 0
      ? 0
      : Math.min(1, mine.reduce((n, u) => n + utype(s, u.type).vision, 0) / (6 * Math.max(1, mine.length)));
  /*
   * 打在"第几代"：取**场上已经出现的最高城代**。
   *
   * 这一项以前没有，于是 6 代的对局里 AI 还在拿 3 代的威胁谱估价——
   * 厚甲被高估、低代兵不显废。局势在哪一代，就该用哪一代的谱，
   * "低代兵在高代无力"这件事才会体现在采购里（而不是靠额外的惩罚项）。
   */
  const eraNow = eraNowOf(s);
  // 水的占比决定"船能不能到场"：模型按可作战面积给水军打折（见 unit-value 的 domainFactor）
  return { tempo, visionCoverage: coverage, fog: s.fog !== false, waterShare: waterShare(s), era: eraNow };
}

function recruitCandidate(
  s: GameState,
  src: RecruitSource,
  traits: AiTraits,
  plan: AiPlan,
  order?: string | null,
  mood?: AiMood,
  /** 海军的需求度（0~1）：采购时按它给水军加减分，见 `seaDemand` */
  seaDemand = 0,
  /**
   * 只问"如果有一个空位，它会买什么"，不真的占位。
   *
   * 换血（见 `swapOutCandidate`）要用一次采购判断来定"买谁来替代"，
   * 而那时候编制正好是满的、`armySize` 这一关必然把它挡回去。
   * 与其在换血那段再抄一遍采购评分，不如把上限这一条做成开关。
   */
  ignoreCap = false,
): Candidate | null {
  // 没传就是"不带战术倾向"（指挥官模式排产草稿、单元测试都会走这条），
  // 权重全零时下面每一条加成都是 0，行为和改动前一模一样。
  const moodw: Record<AiDoctrine, number> = mood
    ? mood.drive
    : { rush: 0, harass: 0, boom: 0 };
  const w = moodw;
  const me = s.current;
  const gold = s.players[me].gold;
  /*
   * 追踪设施放在过滤器**之前**：这些"候选池级"的拒绝（时代不够、英雄已有一个、
   * 没出兵格）以前根本没进统计，于是"某个兵没人造"永远查不到原因——
   * 汇总里只会看到"池为空"或者一个都不 deny。
   */
  const tracing = aiRecruitTrace.on;
  if (tracing) {
    aiRecruitTrace.last = null;
    aiRecruitTrace.detail ??= new Map();
  }
  const why: Record<string, number> = {};
  const deny = (k: string, type?: string): void => {
    if (!tracing) return;
    why[k] = (why[k] ?? 0) + 1;
    if (!type) return;
    const bag = aiRecruitTrace.detail!.get(type) ?? new Map<string, number>();
    bag.set(k, (bag.get(k) ?? 0) + 1);
    aiRecruitTrace.detail!.set(type, bag);
  };

  // 和 rules 一样只数作战单位：建筑不占编制，别让几座磨坊把产线堵死
  if (!ignoreCap && armySize(s, me) >= CONFIG.maxUnits) {
    deny('编制已满', '*');
    return null;
  }

  /**
   * 这个产兵点能往哪些格子出兵（跟 rules 里的 doRecruit 保持一致）。
   *
   * 判据按**兵种**问（`terrainWalkable`），不按"陆军能不能走"。
   * 以前这里只有 water / 非 water 两档，非 water 一律 `passable()`：
   * 一圈是水的军营里，飞行兵被算成"无出兵格"，AI 于是压根不会考虑它。
   */
  const slotCache = new Map<string, Array<{ x: number; y: number }>>();
  const slotsFor = (def: UnitTypeDef): Array<{ x: number; y: number }> => {
    const hit = slotCache.get(def.id);
    if (hit) return hit;
    const water = def.domain === 'water';
    let cells: Array<{ x: number; y: number }> = [];
    if (src.kind === 'city') {
      const city = cityById(s, src.id);
      if (!city) return [];
      cells = water
        ? cityTiles(city).flatMap((t) => DIRS.map(([dx, dy]) => ({ x: t.x + dx, y: t.y + dy })))
        : cityTiles(city);
    } else {
      // 军营占着自己那一格，兵从四邻出来
      cells = DIRS.map(([dx, dy]) => ({ x: src.x + dx, y: src.y + dy }));
    }

    const out: Array<{ x: number; y: number }> = [];
    for (const cell of cells) {
      const tile = tileAt(s, cell.x, cell.y);
      if (!tile) continue;
      if (!terrainWalkable(def, tile.terrain)) continue;
      if (unitAt(s, cell.x, cell.y)) continue;
      out.push(cell);
    }
    slotCache.set(def.id, out);
    return out;
  };

  // 没有"这座城一格都出不了兵"的快速判定了：判据现在是按兵种的，
  // 只有问过具体兵种才知道它出不出来。候选表里的每一项各自问（结果缓存），
  // 全都被拒时下面的 `pool.length === 0` 照旧把这一回合让给别的事。

  const choices = Object.values(s.unitTypes).filter((d) => {
    const reject = (reason: string): false => {
      deny(reason, d.id);
      return false;
    };
    if (d.category === 'building') return reject('建筑不归采购管');
    // 运输船目前只给玩家用：AI 还没有"装船—渡河—上岸"这套计划能力，
    // 让它买一条自己不会用的船，等于白烧 60 金。
    if (hasHold(d)) return reject('AI 不会用运输船');
    // 召唤物只认召唤者：AI 花 45 金买一个骷髅，等于给死灵法师的赠品单独付钱。
    if (d.summonedOnly) return reject('召唤物不采购');
    // 英雄场上只能有一个（蛋还没孵也算"有一个"）。这条规则在 doRecruit 里也拦了，
    // 但在这里先拦掉，才能让 AI 把"再多买一个"的钱花到别处，而不是每回合撞一次墙。
    if (heroBlocked(s, me, d)) return reject('英雄已在场');
    // 时代窗口与选卡名单走 core/draft 的同一套判据：
    // 选卡模式下 AI 也只能造自己选到的兵；时代只剩上界，旧兵对人对 AI 都造得出来
    if (!eraWindowOk(s, d, src.era)) return reject('时代未解锁');
    if (!canUseType(s, me, d.id)) return reject('选卡未收录');
    return slotsFor(d).length > 0;
  });

  // 指挥官模式：玩家点名了兵种，就只在这个兵种里挑产兵点。
  // 造不出来（时代不够 / 没水 / 钱不够）时返回 null，让 AI 本回合去干别的事——
  // 而不是"退而求其次随便造一个"。指挥官要的是可预期，不是被体贴。
  const pool = order ? choices.filter((d) => d.id === order) : choices;
  if (pool.length === 0) return null;

  // ── 攒钱 ──
  // 目标（英雄 / 升时代）就在几个回合的收入之内时，这一回合先不买便宜兵。
  // 这是"被动防守、攒钱升时代"能被 AI 选中的地方：以前采购是每回合独立最优，
  // 手里有多少花多少，永远攒不出一笔大钱。
  //
  // 真正的门槛在候选循环里（见下面的"攒钱"），因为要不要买得看**这个兵多少钱**。
  // 这一层只保留两条边界：urgent（兵太少或敌人已到城下）时不攒——那是拿命省钱；
  // 差得远时照常花钱（见 buildPlan 的 6 回合门槛）。

  const myUnits = unitsOf(s, me);
  const earners = myUnits.filter((u) => utype(s, u.type).category === 'economy').length;
  const builders = myUnits.filter((u) => utype(s, u.type).category === 'builder').length;
  // 被地形困住的单位不算"有效兵力"：它们既上不了前线，还占着产兵格。
  // 算拥挤度时必须扣掉，否则 AI 会以为自己兵很多、不再补兵，其实全是站桩的。
  const combatCount = myUnits.filter(
    (u) => utype(s, u.type).category === 'combat' && !isStuck(s, u),
  ).length;
  const rough = roughShare(s);
  const cityCount = Math.max(1, citiesOf(s, me).length);
  // 弃城期把经济线的目标抬高：这一档赢在"三个回合之后我比你富一代"，
  // 所以它要的不是"够用的农民"，而是能把整座城的产线滚起来的人手。
  const targetEarners = Math.min(10, cityCount * 2 + Math.round(3 * w.boom) + (mood?.abandonedCityId ? 2 : 0));

  // 高级：看现在这支部队的"远程占比"，缺什么补什么。
  //
  // 初级是纯按单价估值的，结果一局打下来常常清一色近战，压到城下被人射成筛子。
  // 但也不能全远程——远程没有肉盾顶着，被贴脸一样崩。所以两头都留阈值：
  // 远程不到七成就优先补远程，超过七成就反过来补近战。
  const landCombat = myUnits.filter(
    (u) => utype(s, u.type).category === 'combat' && utype(s, u.type).domain !== 'water',
  );
  // 这里数的是"真远程"：射程 3 以上。射程 2 是长兵器（戟兵、长枪兵那一档），
  // 它能隔一格戳人，但顶不住远程对射——上一版按 range>=2 算，戟兵改了射程之后
  // 既拿远程奖励、又把远程占比撑虚，AI 于是不买火枪兵了（火药局火枪兵采用率 6.8%）。
  const rangedShare =
    landCombat.length > 0
      ? landCombat.filter((u) => utype(s, u.type).range >= 3).length / landCombat.length
      : 0.5;

  const wet = waterShare(s);
  /** 现在手上有几条运输船：0 条时最该造，够用了就不再叠 */
  const myTransports = unitsOf(s, me).filter((u) => hasHold(utype(s, u.type))).length;
  // 编队模板要的"这支部队现在长什么样"。每次 candidate 都重算一遍，
  // 所以同一回合里连买三个近战后，第四次会看见"近战已经够了"。
  const rosterBonus = rosterBonuses(rosterOf(s, me));
  /**
   * 已经被打到门口、而且兵力明显不如对面：这一回合只买战斗单位。
   *
   * 依据是线上对局库（warchess_reports）里被打崩的 13 局人机局：
   * AI 累计阵亡 43 个单位，造过的是 16 个工程师、17 个劳工、9 个牧民、1 个农民——
   * **一个战斗单位都没有**。它们出门就被杀，而每死一个农民就等于少买半个兵。
   * 所以在这种局面下，先把钱全部投进战斗单位；等兵力追平再谈经济。
   */
  const foeCombatCount = unitsOf(s, other(me)).filter(
    (u) => utype(s, u.type).category === 'combat',
  ).length;
  const desperate =
    plan.urgent && combatCount * 2 < foeCombatCount && combatCount < 8;

  let best: Candidate | null = null;
  const scored: string[] = [];
  for (const d of pool) {
    // 打到门口还缺兵：经济/建造单位这一回合一个都不买（见上面 desperate 的说明）
    if (desperate && d.category !== 'combat') {
      deny('desperate', d.id);
      continue;
    }
    if (!recruitSpawnCells(s,src.kind==='city' ? src.id : undefined,src.kind==='camp' ? src.id : undefined,d.id).length) {
      deny('无出兵格');
      continue;
    }
    // 英雄第一次要付解锁费：只看造价会让 AI 在"差一点钱"的时候反复选中又放弃。
    // 这笔钱和规则层、界面估价共用 recruitPriceOf 一份口径——三处各算一次，
    // 迟早会出现"AI 以为买得起、规则层说资源不足、这一格生产序列静默空转"。
    const quote = recruitPriceOf(s, me, d);
    const unlockFee = quote.unlockFee;
    const price = recruitCost(s, me, d);
    /*
     * 多资源：粮食/建材不够时，光有金币也买不起。
     *
     * 2026-11-02 修：这里原本判的是 `quote.total`，而 total **包含金币**，
     * 于是"差 30 金"也被记成「粮食/建材不够」。查"好兵没人造"时，
     * 90% 的拒绝理由都是这四个字——顺着它去找粮材产出，方向完全是错的。
     * 金币有自己的闸门（下面那句 `gold < quote.gold`），这里只该管非金币资源。
     */
    const nonGold: ResourceCost = { ...quote.total };
    delete nonGold[GOLD];
    if (!canPay(s.players[me], nonGold)) {
      deny('粮食/建材不够', d.id);
      continue;
    }

    // 水军看地图：干地上造出来的船只是八十金的靶子。
    // 干湿两张图差得非常多（开阔 2% / 双河 25%），所以这条不能靠"有没有邻水格"判断——
    // 一个池塘边上也能造船，但它开不出去。
    if (d.domain === 'water' && wet < WATER_MIN_SHARE) {
      deny('水域太少', d.id);
      continue;
    }
    if (gold < quote.gold) {
      deny('钱不够', d.id);
      continue;
    }

    // ── 攒钱 ──
    // 计划要用的那笔钱是**冻结差额**，不是"停掉产线"：买完这兵之后账上还剩得下
    // 计划要的份额，就该买。第一版写的是硬停采购（差额没凑齐就一个兵不造），
    // 实测胜率掉到 38.8%——钱是攒下来了，可对面在这几个回合里多出四五个兵，
    // 城下再也没站起来过。攒钱的意义是"为了一件大事忍一手"，不是"把自己饿死"。
    if (plan.savingFor && !plan.urgent && !order) {
      // 目标本身就是它（攒英雄）：到店就买，别被自己的冻结额度挡住
      const isTarget =
        (plan.savingFor === 'hero' && d.hero) ||
        (plan.savingFor === 'unit' && plan.targetUnitId === d.id);
      // 回本 ≤8 回合的经济单位不冻结：它是"以后每回合多几金"，停了等于
      // 把攒钱速度砍掉一半。工匠（现在一个都没有时）同理，第一座磨坊/粮仓
      // 的边际收益比任何一个兵都高。
      const ecoInc = maxIncome(d);
      const payback = ecoInc > 0 ? price / ecoInc : 99;
      const fastEco =
        (d.category === 'economy' && earners < Math.min(targetEarners,payback<=4 ? 6 : 4) && payback <= 8) ||
        (d.category === 'builder' && builders === 0);
      if (!isTarget && (!fastEco || plan.savingFor==='rebuild') && price + unlockFee > plan.allowance) {
        deny(plan.savingFor === 'rebuild' ? '攒重建费' : '攒钱冻结');
        continue;
      }
      // 攒的是升时代：钱够了就把这一回合让给 UPGRADE（升完的兵比多一个兵值）。
      // 但要确认升级现在真的买得起——否则那条动作会被别的原因拒掉，这一回合白过。
      if (plan.savingFor === 'era' && !isTarget && gold >= plan.targetCost) {
        const canUpgradeNow = citiesOf(s, me).some((c) => {
          const cost = upgradeCostOf(s, c);
          return cost !== null && gold >= cost;
        });
        if (canUpgradeNow) {
          deny('让位升级', d.id);
          continue;
        }
      }
    }

    let score = 50;
    if (d.category === 'combat') {
      score += 12 + d.era * 4;
      if (aiLevelOf(s)!=='basic') {
        score += Math.min(
          26,
          combatEfficiency(d, resourceValue(s, me, quote.price) + unlockFee * 0.4, valueContextOf(s, me, plan)) * EFF_SCALE,
        );
        if (plan.urgent) score += 15;
      }
      if (d.domain === 'water') {
        /*
         * 减分按"这片水有多需要海军"缩放，不再是一刀切的 -8 / -18。
         *
         * 老写法对开阔图是对的（船确实换不过陆军的性价比），但群岛图上它把
         * 唯一能过海的手段也一起压死了：50 局基线里水军只占 1.1% 的建造数。
         */
        score -= 8 * (1 - seaDemand);
        // 有点水但不宽裕：船能开，只是绕不开岸，别当主力
        if (wet < WATER_GOOD_SHARE) score -= 10 * (1 - seaDemand);
        if (seaDemand >= 0.99) score += 10;
        // 运输船按 atk 算效率永远是 0（它不开炮），只能单独按"有没有船"给分
        if (hasHold(d)) {
          score += (myTransports === 0 ? 40 : myTransports < 3 ? 22 : 0) * seaDemand;
          // 没有船的时候先把船凑齐，再谈护航
          if (myTransports >= 3) score -= 6;
        } else if (myTransports > 0) {
          score += 6 * seaDemand;
        }
      }

      // 高时代单位要主动去用，否则 AI 会一辈子造火枪兵。
      // 实测：60 局里坦克只造了 1 辆、火炮 10 门 —— 不是它们弱（交换比 3+），
      // 是"贵"在打分里被折了两次：单价惩罚一次，anti-mass 一次。
      // 这里补一点意愿，同时把它们的单价惩罚调轻，让贵的兵真的有机会上场。
      if (d.era >= 4) {
        score += 6 + (d.era - 4) * 6;
        // 手头宽裕（能买两个）时再加一点：说明现在不是"勒紧裤腰带"的时刻
        if (gold >= price * 2) score += 6;
        // 贵而专的兵（坦克 380 / 火炮 320）不该永远排在步兵班后面。
        // 上面的单价惩罚是线性的，对大件不公平：一辆坦克的战场价值不是三倍步兵班，是它的护甲和破城。
        // 这里按"超出常规单价的溢价"补一点分，8 分封顶，不至于让它压过一切。
        score += Math.min(8, Math.max(0, price - 180) * 0.03);
      }

      /*
       * ── 地形契合：这张图上它吃不吃得开 ──
       *
       * 只对"自己有地形加成"的兵生效（现在就是林地之主这一类）。
       * 权重按图上森林+丘陵的占比缩放：一片平原的图上，+3 甲的地形能力
       * 等于不存在，不该因为面板上写着 +3 就多给它分。
       *
       * 3 甲 × 三成糙地 ≈ +9 分；实测这一个量级能把树人从"几乎不造"拉到
       * 会零星出现的程度，又不至于让它盖过同价位的通用兵。
       */
      if (d.category === 'combat') {
        const affinity = terrainArmorOf(d);
        const perTile = Math.max(affinity.get('forest') ?? 0, affinity.get('hill') ?? 0);
        const rough = roughShare(s);
        if (perTile > 0 && rough > 0.2) score += Math.min(12, perTile * rough * 10);
      }

      // 高级：兵种搭配（见上面 rangedShare 的说明）
      if (aiLevelOf(s) !== 'basic' && d.domain !== 'water') {
        // 以前这里是"远程 / 长兵器 / 近战"三档手调（远程不到七成 +9，
        // 长兵器 +1~3，近战 -4~7）。它解决过一个问题——射程改 2 之后戟兵
        // 既拿远程奖励又把远程占比撑虚，火枪兵采用率掉到 6.8%——但阈值是
        // 按单一维度折出来的，只管"远程 vs 近战"这一条轴，前排和支援没人管。
        // 现在配比统一由下面的编队模板给分，三档手调撤掉，别再叠第二遍。
        // 高机动突击单位：绕后切炮是现在这套 AI 真会用的一招，所以值一点分。
        // 但别给多——骑兵不是万能牌，远程占比已经够高时它就没那么必要。
        if (isRaider(d) && rangedShare < 0.85) score += 7;
        // 攻城器：野战几乎打不动人，只有"已经压到城下"时才值得买。
        // 以前它们一律排最后，五个时代的攻城器械招募数全是 0——
        // 破城 1.5 倍这件事，AI 从来没有为它付过钱。
        if ((d.abilities ?? []).includes('siege-master')) {
          const foeCities = citiesOf(s, other(me));
          const atWall = myUnits.some((u) => foeCities.some((c) => distance(u, c) <= 4));
          if (atWall) score += 16;
        }
        // 支援型能力：价值不在自己打得多狠，而在整条线更耐打。
        // 有治疗/净化/召唤的兵再额外给一点——它们改变的是"这支军队能熬多久"。
        if ((d.abilities ?? []).some((a) => SUPPORT_ABILITIES.includes(a))) score += 5;
        if ((d.abilities ?? []).some((a) => ['heal-aura', 'purge', 'summoner'].includes(a))) {
          score += 4;
        }
        // 编队模板：前排 / 近战输出 / 远程 / 支援，缺哪一档就把预算往哪推。
        // 上面那些是"这个兵本身值多少"，这一条是"这支部队缺什么"——
        // 少了它，采购就是纯 argmax：分最高的那个兵种吃满预算，
        // 一局下来清一色三四种兵，法师和支援连门都进不去。
        score += rosterBonus[rosterRoleOf(d)];
      }

      // 魔法段要算进"这个兵能打多少"。
      //
      // 打分一直只认 d.atk，于是法师在 52 个候选里排第 42 名：它把一半的伤害
      // 搬进了 magicAtk，而那笔钱 AI 不认。结果是"法师在表里、在规则里、
      // 就是不在战场上"。真把攻击力调到 20 才能进前十——那它就不是法师了。
      const magic = d.magicAtk ?? 0;
      if (magic > 0) score += Math.min(9, magic * 0.5);

      // 英雄：军中有一定规模、且买完还剩点余钱时才买。
      // 原来是"钱够就 +14"，等于第一座城一升级就把钱砸在英雄上，
      // 后面没钱出兵，英雄一个人守空城。英雄是"带兵打"的，不是"替兵打"的。
      if (d.hero) {
        if (plan.savingFor === 'hero' && gold >= price + unlockFee) {
          // 计划已经为它攒了好几回合，到店就买。120 分足以压过任何兵种，
          // 但不至于让它在"钱还不够"的时候被选中（上面已经 continue 掉了）。
          score += 120;
        } else if (landCombat.length >= 6 && gold >= price + unlockFee + Math.round(price * 0.6)) {
          score += 14;
        }
        // 弃城期英雄是"兑现目标"之一：用一座守不住的城换一个永久战力，是划算的
        score += 30 * w.boom;
      }

      // 边际递减：同一兵种越多，下一个越不值。
      //
      // 没有这一条时，采购是纯粹的 argmax——前十个兵种吃掉九成预算，
      // 剩下十几个"也能用"的兵一局都见不到。递减不是让 AI 变弱，
      // 是让它在第三个狼骑士之后开始想"我是不是该有个法师了"。
      //
      // 编队模板管的是"职能别偏科"，这一条管的是"同一种兵别刷满"：
      // 只靠模板的话，一个占据优势职能的强者（5 级恶魔、装甲车）照样能
      // 连买四五个，因为职能占比还没超。所以系数从 2.4 提到 3.0、封顶到 20。
      const sameType = myUnits.filter((u) => u.type === d.id).length;
      if (sameType > 0) score -= Math.min(20, sameType * 3);

      // 开局一只兵都没有的时候，先凑出一小撮能打的，别急着攒钱升科技
      if (aiLevelOf(s) !== 'basic' && landCombat.length < 4 && price <= 80) score += 8;

      // ① 造出来就出不了城门的兵，一律不造。
      //    move 1 进不了丘陵和森林（进门 2 点），出生点四邻要是全这种地形，
      //    它这辈子走不到前线，还占着产兵格 —— 产兵格被占，城里就再也造不出兵，
      //    整支军队当场停摆。高时代最容易踩这个坑：重机枪组正好 move 1。
      const slots = slotsFor(d);
      const canLeave = slots.some((c) =>
        escapeRoutes(s, c.x, c.y, d.move, src.kind === 'city' ? src.id : null, d.id) > 0,
      );
      if (!canLeave) {
        deny('出不了城门', d.id);
        continue;
      }
      //    地图越糙，慢兵的处境越糟：不是"慢一点"，是"只能待在平原上"
      if (d.move <= 1) score -= 10 + rough * 130;

      // ② 别爆兵：多一个战斗单位的边际价值随兵力下降。
      //    高时代尤其明显 —— 堆一屋子低时代步兵只是给对面送人头和击杀数。
      score -= Math.min(38, combatCount * 1.6);

      // ③ 有当代兵就不堆上一代的
      score -= (src.era - d.era) * 11;

      // ── 战术倾向：这一局到底要什么样的兵 ──
      // 骚扰要"跑得快、够得远"：它不指望打赢会战，只指望对面抓不到它。
      if (w.harass > 0.1) {
        if (isRaider(d)) score += 14 * w.harass;
        if ((d.range ?? 1) >= 3 && d.move >= 3) score += 10 * w.harass;
        if (d.move <= 2) score -= 10 * w.harass;
      }
      // 弃城期不补兵：这时候买的每一个兵，都会被"少一座城的产线"吃掉。
      // plan.urgent 的时候不拦——真到城下还是要打的。
      // 这里用 drive（受"真弃城"门控）而不是 weight：只看 weight 的话，
      // AI 半局处于"少产兵、只买经济"的假爆发，金永远攒不到升级价——
      // 升级候选在 gold < cost 时根本不存在，弃城就成了空话。
      if (!plan.urgent) score -= 14 * w.boom;
    }
    if (d.category === 'economy') {
      const inc = maxIncome(d);
      const payback = inc > 0 ? price / inc : 99;
      score += earners < targetEarners ? 34 - Math.min(18, payback * 1.5) : -14;
      // 弃城期：经济单位就是这一档的本钱，宁可晚一个兵也要先把水龙头拧大
      // （用 drive 门控，见上面"假爆发"注释）
      score += 26 * w.boom;
      // 速攻期：除了最开始那一只，经济线一律让位给兵——
      // 速攻输就输在"钱还没变成兵，对面的墙已经修好了"
      if (earners >= 1) score -= 14 * w.rush;
      if (plan.urgent) score -= 35;
      if (mood?.abandonedCityId && earners<targetEarners) score += 35;
      if (s.config.expansionIds.includes('city-works') && earners<targetEarners &&
          ((s.players[me].res?.food??0)<120 || (s.players[me].res?.material??0)<100)) score+=30;
    }
    if (d.category === 'builder') {
      score += builders < 1 ? 24 : builders < 2 ? 4 : -12;
      // 弃城期要靠工事把留守的那座城撑住，工程队值钱
      score += 8 * w.boom;
      if (plan.urgent) score -= 22;
    }
    // 高级对单价更敏感一点：便宜的兵能多铺几个方向。
    // 但高时代单位要单独放宽——它们贵是设计如此，不该因此永远排在火枪兵后面。
    // 精兵姿态下，单价惩罚只剩三分之一：这时候钱是**攒着买贵的**，
    // 再用线性价格惩罚去压大件，等于自我否定。
    // 换家姿态按"精兵"算：这时候每一分钱都要换成能打穿城墙的东西。
    const concentrated = plan.stance === 'elite' || plan.stance === 'trade';
    const perGold =
      concentrated ? 0.012 : aiLevelOf(s) !== 'basic' ? 0.035 : 0.05;
    score -= price * (d.era >= 4 ? perGold * 0.6 : perGold);
    // 攒钱姿态下额外给大件一点意愿：既然要停手攒钱，那就攒来买好的
    if (concentrated && price >= 100) score += 8;

    // 军营是前线补给点：在军营出兵有额外价值（省了从后方跑一趟）
    if (src.kind === 'camp') score += 6;

    if (traits.favorites.includes(d.id)) score += 9;
    // 高级的随机幅度更小：选择更"有主意"，不会因为噪声去造一个明显不合适的兵
    score += (aiNoise(s, d.id.length * 31 + d.id.charCodeAt(0)) - 0.5) * (aiLevelOf(s) !== 'basic' ? 4 : 8);

    /*
     * 攒钱的目标到店了就该买它，而不是又拿去买便宜的。
     *
     * 这一条是"预留"能成立的关键：光冻结额度（allowance）不够——
     * 钱攒够那一回合，大件仍然要和其他候选比分数，而线性单价惩罚会让它输。
     * 之前那版实验就是这么白攒的：钱攒到了，兵没买成。
     */
    if (plan.savingFor === 'unit' && plan.targetUnitId === d.id && gold >= price + unlockFee) {
      score += 40;
    }

    // 指挥官点名的兵种优先落地。
    // 产兵是这个模式里玩家唯一的杠杆，必须赶在 AI 把钱花到建筑/升级之前执行，
    // 否则"我排了三个坦克，一个都没出来"——而且玩家看不出是被什么吃掉的。
    if (order && d.id === order) score += 240;

    const action: Action =
      src.kind === 'camp'
        ? { type: 'RECRUIT', unitId: src.id, unitType: d.id }
        : { type: 'RECRUIT', cityId: src.id, unitType: d.id };

    if (tracing) scored.push(d.id);
    if (!best || score > best.score) best = { action, score };
  }

  if (tracing) {
    // 走到了评分这一步、但没被选中的，记成"分数偏低"——它和"被过滤器挡住"是两回事，
    // 混在一起看就会把"时代没解锁"和"够强但打不过同价位的选择"搞混。
    const winner = best?.action.type === 'RECRUIT' ? best.action.unitType : null;
    for (const id of scored) if (id !== winner) deny('分数偏低', id);
  }
  if (tracing && !best) {
    aiRecruitTrace.last = Object.entries(why).map(([k, n]) => `${k}×${n}`).join(' / ') || '池为空';
  }
  return best;
}

/**
 * 两翼分工：谁能去佯攻、去几成。
 *
 * 判据只有一条——**离那座城比离主攻城近两格以上**。这样分派是自洽的：
 * 从左边出发的那一路自然去打左边的城，不需要"整体旋转阵型"这种复杂指令。
 *
 * 上限取全军的三分之一（至少一个）：佯攻的目的是牵制，不是分兵。
 * 分到跟主攻一样厚，两路都打不动，那正是"逐单位评分、没有阵型意图"
 * 这个毛病换个方式发作。
 *
 * 只在"有两座以上敌城 + 陆军至少六个"时成立：只有一座城时没有第二翼可言，
 * 兵太少的时候分兵等于送。
 */
export function flankSplit(
  s: GameState,
  me: PlayerId,
  land: Map<string, number[]>,
  focusCityId: string | null,
): { flankCityId: string | null; flank: Set<string> } {
  const none = { flankCityId: null, flank: new Set<string>() };
  if (!focusCityId) return none;
  const main = cityById(s, focusCityId);
  if (!main) return none;
  const army = unitsOf(s, me).filter((u) => utype(s, u.type).category === 'combat');
  if (army.length < 6) return none;

  const others = s.cities.filter((c) => !c.ruined && c.owner !== me && c.id !== focusCityId);
  if (others.length === 0) return none;
  // 佯攻目标：离主攻方向最远的那座（两翼要真的分开，隔壁那座不算另一翼）
  const far = others.sort(
    (a, b) => distance(b, main) - distance(a, main) || a.id.localeCompare(b.id),
  )[0];
  if (!far) return none;
  const farField = land.get(far.id);
  const mainField = land.get(focusCityId);
  if (!farField || !mainField) return none;

  const cap = Math.max(1, Math.floor(army.length / 3));
  const picks = army
    .filter((u) => {
      const d = utype(s, u.type);
      // 水军和空军有自己那套目标（临水港 / 直线过海），别混进陆军的翼
      return d.domain !== 'water' && !airLayer(d);
    })
    .map((u) => {
      const i = u.y * s.w + u.x;
      const toFar = farField[i] ?? Infinity;
      const toMain = mainField[i] ?? Infinity;
      return { id: u.id, gap: toMain - toFar, ok: Number.isFinite(toMain) && Number.isFinite(toFar) };
    })
    .filter((x) => x.ok && x.gap >= 2)
    .sort((a, b) => b.gap - a.gap || a.id.localeCompare(b.id))
    .slice(0, cap);
  if (picks.length === 0) return none;
  return { flankCityId: far.id, flank: new Set(picks.map((p) => p.id)) };
}

/**
 * 换血：编制满了，解散一个最不值钱的，给更好的兵腾位置
 *
 * 到 2026-11-02 为止，这套 AI 从来不发 `DISBAND`（`grep DISBAND src/core/ai.ts`
 * 是空的），而编制上限 `CONFIG.maxUnits = 24` 是硬的。于是后期出现一个死局：
 * 手里 24 个火药时代的兵，工厂造得出坦克、账上也有钱，**新兵进不来**——
 * 招募在 `armySize >= maxUnits` 那一行直接返回 null，而且回来的是 null 不是
 * "换一个"，所以这一回合的钱只能拿去升城或者躺着。
 * 人类不会这样：他会解散两个长枪兵换一辆坦克，眼睛都不眨。
 *
 * 三条界线，缺一条这条机制就会变成"每回合烧一笔差价"：
 *   1. **只换明显更好的**（`SWAP_GAIN`）：性价比不到 1.35 倍就不折腾。
 *      编制是一个萝卜一个坑，来回换只赚个差价，钱却真的花掉了。
 *   2. **只换后方的**：离敌人 5 格以内的不换——那是正在顶线的人，
 *      把他解散掉，当回合城墙就少一个人守，这个洞比升级的收益大得多。
 *      顺带挡住"刚造出来就解散"的抖动：新兵一般出在城里，城里离前线通常更远，
 *      但真正挡住抖动的是第 1 条（新兵不会比它自己好 1.35 倍）。
 *   3. **只在没有急事时换**（`plan.urgent` / 家门口有敌兵都不换）：
 *      这一手是"有余力时整理编成"，不该和救城抢那个动作位。
 *
 * 为什么用"如果有一个空位它会买什么"来定替代目标：采购那一套评分（编队配比、
 * 时代窗口、粮食建材、水域需求）已经写了六百行，换血不该另起一套理解。
 * 把上限那一关关掉问一次，拿到的就是"这一回合它真正想买的那个兵"。
 */
function swapOutCandidate(
  s: GameState,
  me: PlayerId,
  traits: AiTraits,
  plan: AiPlan,
  mood: AiMood,
  seaDemandNow: number,
): Candidate | null {
  const bail = (why: string): null => {
    if (aiTrace.on) aiTrace.swapWhy.set(why, (aiTrace.swapWhy.get(why) ?? 0) + 1);
    return null;
  };
  // 初级不会换血：这一档连"谁更贵"都不算，让它拆自己的兵只会拆错。
  if (aiLevelOf(s) === 'basic') return bail('初级档');
  if (armySize(s, me) < CONFIG.maxUnits) return bail('编制没满');
  // 攒钱期不动编制：那笔钱是留给英雄/时代的，换一个兵等于把目标拆了。
  // 例外正是"攒的就是兵"——那时候目标被编制卡着，不换血就永远买不到。
  if (plan.savingFor && plan.savingFor !== 'unit') return bail('正在攒别的目标');

  // 有急事就不换：救城、补兵、门口有敌人都比整理编成重要
  const foe = unitsOf(s, other(me));
  if (plan.urgent) return bail('局面吃紧');
  const myCities = citiesOf(s, me).filter((c) => !c.ruined);
  if (foe.some((u) => myCities.some((c) => distToCity(u, c) <= 6))) return bail('敌人压到城下');

  // ① 问采购：如果有一个空位，这一回合它会买谁
  let want: Candidate | null = null;
  for (const city of citiesOf(s, me)) {
    if (city.ruined || city.capturedTurn === s.turn) continue;
    const c = recruitCandidate(
      s,
      { kind: 'city', id: city.id, x: city.x, y: city.y, era: city.era },
      traits,
      plan,
      null,
      mood,
      seaDemandNow,
      true,
    );
    if (c && (!want || c.score > want.score)) want = c;
  }
  if (!want || want.action.type !== 'RECRUIT') return bail('没有想买的兵');
  const targetDef = utype(s, want.action.unitType);
  // 运输船、召唤物这类不是"战斗力"，换掉一个战斗单位去换它是净亏
  if (targetDef.category !== 'combat' || hasHold(targetDef)) return bail('想买的不是战斗力');

  // ② 找最该被换掉的那个：身价最低、还站在后面
  const pool = unitsOf(s, me).filter((u) => {
    const d = utype(s, u.type);
    if (d.category !== 'combat') return false;
    if (d.hero === true) return false;
    if (u.summoned) return false;
    if (hasHold(d)) return false;
    if ((u.cargo?.length ?? 0) > 0) return false;
    // 交火中的不换（见上面第 2 条界线）
    return !foe.some((e) => distance(e, u) <= 5);
  });
  if (pool.length === 0) return bail('没有可换的后方兵');
  const worth = (u: Unit): number => {
    const d = utype(s, u.type);
    return combatPower(d) * Math.max(0.2, u.hp / Math.max(1, d.maxHp));
  };
  pool.sort((a, b) => worth(a) - worth(b));
  const worst = pool[0]!;
  const worstDef = utype(s, worst.type);

  /*
   * ③ 值不值：**比"名额能装多少战力"，不比"每金币的性价比"**。
   *
   * 原来比的是性价比（power / price^0.8），于是"25 金的民兵换 300 金的步兵班"
   * 这个明显该换的动作会被判成"提升不够大"——因为按金币摊，步兵班的性价比
   * 只比民兵高 1.35 倍，刚好卡在门槛上。可名额才是稀缺资源（见上面第 3600 行
   * 的说明）：满编时你换的不是钱，是**一个位置**。所以拿两个兵的战力直接比。
   */
  const ctx = valueContextOf(s, me, plan);
  const targetPower = combatPower(targetDef, ctx);
  const worstPower = combatPower(worstDef, ctx) * Math.max(0.2, worst.hp / Math.max(1, worstDef.maxHp));
  if (targetPower < worstPower * SWAP_GAIN) return bail('提升不够大');

  // ④ 钱够不够：解散能退回一部分（满血才退，见 rules.disbandRefundOf）
  const refund = disbandRefundOf(s, worst);
  if (s.players[me].gold + refund < recruitPriceOf(s, me, targetDef).gold) return bail('钱不够');

  return { action: { type: 'DISBAND', unitId: worst.id }, score: 1 };
}

function upgradeCandidate(s: GameState, city: City, mood?: AiMood, plan?: AiPlan): Candidate | null {
  if (city.id === mood?.abandonedCityId) return null;
  const cost = upgradeCostOf(s, city);
  if (cost === null) return null;
  const gold = s.players[s.current].gold;
  if (gold < cost) return null;
  /*
   * 攒钱升时代的那几个回合，只许升主城。
   *
   * 少了这一条，预留就是漏的：钱攒到一半，副城的升级（便宜）在同一轮 argmax 里
   * 赢过采购，把这笔钱花掉——主城又回到"差一口气"。人类的"集中升一座"能成立，
   * 一半靠的是"这笔钱我不动"，而 AI 以前连"这笔钱是留给谁的"都没记。
   */
  if (plan?.savingFor === 'era' && gold < (plan.targetCost ?? 0)) {
    const top = [...citiesOf(s, city.owner)]
      .filter((c) => !c.ruined)
      .sort((a, b) => b.era - a.era)[0];
    if (top && top.id !== city.id) return null;
  }

  // 留足造兵的钱再考虑升级，否则会变成裸城升级
  const spare = gold - cost;

  // 阈值按"造价的相对比例"算，别写死绝对值——时代费用调过一轮之后，
  // 写死 100/40 等于让 AI 永远觉得"余钱很充裕"。
  const rich = cost * 0.35;
  const okay = cost * 0.15;
  let score = (spare > rich ? 88 : spare > okay ? 52 : 14) + (aiNoise(s, 9001) - 0.5) * 20;

  // 落后就要补课：对面时代比我高的时候，升级的紧迫感是加倍的。
  // 没有这一条，AI 会一直"先造兵、兵造不完"，永远追不上对面的科技。
  const foe = citiesOf(s, other(city.owner));
  const myEra = Math.max(...citiesOf(s, city.owner).map((c) => c.era));
  const foeEra = foe.length > 0 ? Math.max(...foe.map((c) => c.era)) : myEra;
  if (foeEra > myEra) score += 26;

  // 集中升一座城，而不是把两座城都升到半高。
  //
  // 升级的收益是"这座城能产下一代兵"，两座各升一级 ≠ 一座升两级：
  // 后者能立刻换代，前者只是让两边都能产"次一代"的兵。而且升级本身要钱，
  // 摊开升等于永远在攒钱、永远差一点。所以已经在最前面的那座城再加一档分，
  // 落后的那座扣一档——序列自然收敛成"主城 + 陪跑城"。
  //
  // 幅度只有 6/4：升级的底分本来就比招兵高（见上面 88/52/14），再叠一个大数
  // 会把"产线"整条挤掉——实测 900 金的局面里 AI 连着十二回合只顾升城、一个兵不造。
  if (city.era >= myEra) score += 18;
  else score -= 10;

  // 战术倾向：弃城期升级是**兑现**（攒那几个回合就是为了这一下），
  // 速攻期升级是"顺便"，骚扰期同样的钱更愿意换成两三个能到处跑的兵。
  // 幅度必须小。上面 6/4 那段注释记的就是这个坑：升级底分本来就比招兵高一档，
  // 再叠一个大数，AI 会连着十几回合只顾升城、一个兵不造。第一版这里写了 34，
  // 实测直接让"十二个回合只有两种选择"，战术多样性反而没了。
  if (mood) {
    score += 25 * mood.drive.boom + 2 * mood.drive.rush - 8 * mood.drive.harass;
  }

  return { action: { type: 'UPGRADE', cityId: city.id }, score };
}

/**
 * 给"计划里的兵"找一格空位。
 *
 * 排序列时需要把已经排进去的兵当成"已经在场"来算下一步（否则五格会全是同一种兵：
 * 每一格看到的都是"我还没有它"）。但我们不能真的改局面，所以在投影状态里塞幽灵单位。
 *
 * 幽灵必须放在**能站人的空地**上，而且不能占住城市的产兵格、也不能挨着军营
 * （那两处正是 recruitCandidate 数可用格子的地方）——不然排到第三格就会被自己堵死。
 * 找不到就退回 (0,0)，最坏情况只是这几格的打分少了"拥挤度"这一项。
 */
function ghostSpot(s: GameState): { x: number; y: number } {
  const blocked = new Set<string>();
  for (const c of s.cities) {
    for (const t of cityTiles(c)) blocked.add(`${t.x},${t.y}`);
  }
  for (const u of s.units) {
    if (!isProducer(utype(s, u.type))) continue;
    for (const [dx, dy] of DIRS) blocked.add(`${u.x + dx},${u.y + dy}`);
  }
  for (let y = 0; y < s.h; y++) {
    for (let x = 0; x < s.w; x++) {
      const t = tileAt(s, x, y);
      if (!t || !passable(t.terrain)) continue;
      if (blocked.has(`${x},${y}`)) continue;
      if (unitAt(s, x, y)) continue;
      return { x, y };
    }
  }
  return { x: 0, y: 0 };
}

/**
 * 指挥官模式下 AI 自己排生产序列。
 *
 * 为什么 AI 也得排：这个模式里"造什么"是唯一的策略表达。让 AI 一回合一个兵地临时决定，
 * 它只会做局部最优（谁划算造谁），既不会为"下一级兵"攒三个回合的钱，也不会提前铺经济——
 * 那不算"没有序列"，那等于这个模式对 AI 根本不存在，人机对局也就没什么可博弈的。
 *
 * 排 5 格真正的含义是**把代价摆出来**：每一格都是"这一回合不造别的"。
 * 所以下面每一格的打分都必须看得见前面几格的产出（用一个投影状态累加），
 * 否则它会把五个格全排成同一种兵。
 *
 * 只看得到的东西（调用方传 playerView 的结果），不看全图。
 */
export function planOrders(s: GameState, player: PlayerId = s.current): string[] {
  const slots: string[] = [];
  if (citiesOf(s, player).length === 0) return slots;

  // 投影：序列是"未来几回合"的事，所以每排一格都要把这一格的产出记进去
  //
  // `unlocked` 也要拷一份：排到英雄那一格时得把"解锁过了"记进投影，
  // 否则同一份序列里再排到同一个英雄会重复算一次解锁费（钱白扣，
  // 后面几格的余额被压得偏低，排出来的序列比实际能力短一截）。
  // 直接改 `s.unlocked` 是不行的——`s` 是调用方那份真局面（或者它的雾视图）。
  const unlockedCopy: Partial<Record<PlayerId, string[]>> = {};
  for (const [k, v] of Object.entries(s.unlocked ?? {})) {
    unlockedCopy[k as PlayerId] = [...(v ?? [])];
  }
  const proj: GameState = {
    ...s,
    current: player,
    cities: s.cities.map((c) => ({ ...c })),
    units: [...s.units],
    // 四个席位都拷一份：AI 只在两人局出场，但 GameState 的字段是四键的
    players: {
      A: { ...s.players.A },
      B: { ...s.players.B },
      C: { ...s.players.C },
      D: { ...s.players.D },
    },
    unlocked: unlockedCopy,
  };
  const traits = aiTraits(proj);
  // 排产看的是"这一局想怎么赢"，所以战术倾向要一起进打分——
  // 否则玩家看到的是"AI 排了一条和自己场上打法不搭的队"。
  const mood = aiActiveMood(proj, traits);
  // 每格大约能收到这么多钱（打九折：收入会随城市被打、单位被杀而掉）
  const perTurn = Math.max(1, Math.round(incomeOf(s, player) * 0.9));
  // 一格拿来升级 = 五个回合里少一个兵，排两次基本等于自杀
  let upgradesLeft = 1;

  for (let i = 0; i < CONFIG.commanderSlots; i++) {
    // 这一格是"下一回合"的产线，那时候还会进一笔收入
    if (i > 0) proj.players[player].gold += perTurn;

    let bestRecruit: Candidate | null = null;
    for (const city of citiesOf(proj, player)) {
      if (city.capturedTurn === proj.turn) continue;
      const c = recruitCandidate(
        proj,
        { kind: 'city', id: city.id, x: city.x, y: city.y, era: city.era },
        traits,
        // 排产（指挥官模式）只是一份"想要什么"的草案，不该在这里攒钱：
        // urgent=true 让采购保持原来的纯 argmax 口径
        { stance: 'push', savingFor: null, targetCost: 0, targetUnitId: null, allowance: Infinity, buildAllowance: Infinity, goalScore: 0, goalNote: '', goalOptions: [], urgent: true },
        null,
        mood,
      );
      if (c && (!bestRecruit || c.score > bestRecruit.score)) bestRecruit = c;
    }

    let bestUpgrade: { c: Candidate; city: City } | null = null;
    if (upgradesLeft > 0) {
      for (const city of citiesOf(proj, player)) {
        const c = upgradeCandidate(proj, city, mood);
        if (c && (!bestUpgrade || c.score > bestUpgrade.c.score)) bestUpgrade = { c, city };
      }
    }

    // 升级要多让 6 分才划算：它占掉的是"这回合一个兵"的名额，
    // 只有真的宽裕、或者科技落后到必须补，才值得插进序列。
    if (bestUpgrade && (!bestRecruit || bestUpgrade.c.score > bestRecruit.score + 6)) {
      slots.push(ORDER_UPGRADE);
      upgradesLeft -= 1;
      const cost = upgradeCostOf(proj, bestUpgrade.city);
      if (cost !== null) {
        proj.players[player].gold = Math.max(0, proj.players[player].gold - cost);
        bestUpgrade.city.era += 1;
      }
      continue;
    }

    if (!bestRecruit) break;
    const recruit = bestRecruit.action;
    if (recruit.type !== 'RECRUIT') break;
    const type = recruit.unitType;
    const def = proj.unitTypes[type];
    slots.push(type);
    if (!def) break;
    // 记进投影：这个兵"已经在场"，下一格看到的是补完之后的composition
    const spot = ghostSpot(proj);
    proj.units.push({
      id: `plan-${i}`,
      type,
      owner: player,
      x: spot.x,
      y: spot.y,
      hp: def.maxHp,
      kills: 0,
      moved: true,
      acted: true,
    });
    // 付钱：英雄第一次要连解锁费一起扣，和 doRecruit 同一份口径。
    // 只扣兵价的话，投影里的余额会比真局面多出那笔解锁费，
    // 后面几格排进去的兵到执行时其实买不起。
    payRes(proj.players[player], recruitPriceOf(proj, player, def).total);
    if (def.hero === true) {
      const paid = (proj.unlocked ??= {});
      const mine = (paid[player] ??= []);
      if (!mine.includes(def.id)) mine.push(def.id);
    }
  }

  return slots;
}

/**
 * 战术层只挂在"中级 AI"这一档上。
 *
 * 高级 AI 是留给玩家对局的稳版本：主攻方向照算（focusCityId 属于走位，
 * 不是战术），但三套战术不打——权重压成均分、drive 清零、也不弃城。
 * 这样同一局里能同时选到"稳"和"会换打法"两档，用真实对局做对照。
 */
function moodFor(s: GameState, mood: AiMood): AiMood {
  if (aiLevelOf(s) === 'tactic') return mood;
  return {
    ...mood,
    weight: { rush: 1 / 3, harass: 1 / 3, boom: 1 / 3 },
    drive: { rush: 0, harass: 0, boom: 0 },
    abandonedCityId: null,
  };
}

/**
 * 这一回合真正生效的战术倾向（已按 AI 档位过滤）。
 *
 * 对外暴露是为了给规则用例留一个"档位隔离"的断言口：高级档必须是
 * 三战术全关，战术档才是原样的 aiMood。
 */
export function aiActiveMood(s: GameState, traits?: AiTraits): AiMood {
  return moodFor(s, traits ? aiMood(s, traits) : aiMood(s));
}

/**
 * AI 的下一步。返回 null 表示它认为这一回合没有值得做的事了。
 *
 * 调用方负责真正执行 action 并循环调用，直到拿到 null 再结束回合。
 */
/**
 * 对手下一回合**全军的输出**值多少钱（金币口径）。
 *
 * 存在的理由：这套 AI 一直是一回合贪心——给每个动作打分、取最高，没有"我走完
 * 这一步，对面会怎么还手"。它对风险的唯一感知是 `tactical.exposure(unit)`，
 * 也就是"**我要走的那个兵**下回合能吃多少伤害"。这漏掉了三件事：
 *
 *   1. 对面会挑**最贵**的那个打，不是挑最近的那个打。掉同样的血，
 *      掉在坦克上和掉在民兵上不是一个价钱。
 *   2. 我这一步会把**别的兵**也一起卖进去（拆掉自己的肉盾、让炮露出来）。
 *   3. 反过来，我这一步如果打瞎了对面的射手，它下一回合就少一刀——
 *      这份"省下来的伤害"以前一分都不算。
 *
 * 为什么是"逐敌求和"而不是"取最强的那一刀"：取最大值时，**杀掉三个射手里的
 * 一个**几乎不改变结果（另两个还在，最大值不变），于是"打瞎对面"这个动作
 * 在评分上等于没做。求和才能表达"对面总输出少了一份"。
 *
 * 只看"站着能打到谁"，不看对面的移动：移动的可能性已经在 exposure 里算过
 * 一遍了，这里再来一遍是重复计算，而且会让"逼近"这个动作被罚两次。
 */
export function foeOutput(s: GameState, me: PlayerId): number {
  const mine = unitsOf(s, me);
  if (mine.length === 0) return 0;
  let total = 0;
  for (const e of unitsOf(s, other(me))) {
    if (underConstruction(e)) continue;
    const ed = utype(s, e.type);
    if ((ed.atk + (ed.magicAtk ?? 0)) <= 0) continue;
    const shooter = { ...e, moved: false, acted: false };
    let hit = 0;
    for (const t of mine) {
      if (!canStrike(s, shooter, t)) continue;
      const td = utype(s, t.type);
      const dmg = Math.min(t.hp, computeDamage(s, shooter, t) * Math.max(1, ed.burst ?? 1));
      const worth = (dmg / Math.max(1, td.maxHp)) * unitValue(s, t);
      hit = Math.max(hit, worth);
    }
    total += hit;
  }
  return total;
}

export function aiNextAction(s: GameState, budget: AiBudget = DEFAULT_BUDGET, rejected: ReadonlySet<string> = new Set()): Action | null {
  if (s.winner) return null;
  /*
   * 三人四人局没有 AI。
   *
   * 这套 AI 的每一个判断都建立在"只有一个对手"上：威胁场只算一家、推进方向
   * 只朝一家、集火只认一个目标。让它打多方不是加个循环的事，而是把目标选择
   * 整个重写（先打谁？谁在领先？两家夹击怎么办？）。
   * 所以 3/4 人局一律全真人：这里直接返回 null，界面那边也会禁掉 AI 选项。
   */
  if ((s.config.playerCount ?? 2) > 2) return null;

  const me = s.current;
  // 关键：只看自己看得见的东西，跟玩家同等信息
  const view = playerView(s, me).state;

  /**
   * 指挥官模式：产线和升级都由序列决定，所以调用方给的 maxRecruit / maxUpgrade
   * 让位给"队首是什么"——这样不管谁在调 AI（界面层、bench、跑批），
   * 这个模式的规则都只有一份。
   */
  const commander = s.config.commanderMode === true;
  const head = commander ? (ordersOf(s, me)[0] ?? '') : '';
  // 没序列就先自己排一条。注意两点：
  //   1. 不是"没序列就自由产兵"——那等于这个模式对 AI 不存在，人机对局也就没有排产这层博弈。
  //   2. 只在**这一方真的由 AI 托管**时才代排。玩家自己打这个模式时，空序列是他"这回合不造"
  //      的选择，AI 替他把序列填满就等于替他做决定。
  if (commander && head === '' && isAiSide(s, me)) {
    const plan = planOrders(view, me);
    if (plan.length > 0) return { type: 'SET_ORDERS', queue: plan };
  }
  /** 这一回合点名的兵种（不在指挥官模式下就是调用方给的临时指令） */
  /**
   * 队首是「空过」：这一回合确定什么都不做。
   *
   * 必须和空串分开——空串是"队列没排到这一格"，只有 `@idle` 才是玩家亲口说的
   * "这一回合我什么都不造"。混在一起的话，想攒钱的那一格会被 AI 当成没计划、
   * 自作主张花出一笔兵钱。
   */
  const idleHead = head === ORDER_IDLE;
  const order = commander ? (head === '' || head === ORDER_UPGRADE || idleHead ? null : head) : (budget.order ?? null);
  /**
   * 这一回合点名的产兵点。指挥官模式从序列里读（和队首对齐），
   * 其它场合用调用方给的（跑批/用例可以借此固定"从哪座城出"）。
   */
  const orderSite = commander ? (orderSitesOf(s, me)[0] || null) : (budget.orderSite ?? null);
  // 指挥官模式的产能是「每回合 1 个」：队首是兵种**并且**这回合还没造过。
  // 只砍到"看队首"是不够的——一回合里 AI 会反复问下一步，队首没变就会连着造好几个。
  const mayRecruit = commander
    ? !idleHead && head !== '' && head !== ORDER_UPGRADE && budget.recruited < 1
    : budget.recruited < budget.maxRecruit;
  const mayUpgrade = commander ? head === ORDER_UPGRADE && budget.upgraded < 1 : budget.upgraded < budget.maxUpgrade;

  // 蛋还等着落位：先处理掉。不处理的话这一方会一直卡在"等你选蛋"上，
  // 而 rules 层虽然会在结束回合时兜底，但那是"最后手段"，位置是随机凑合的。
  if (s.pendingEgg && s.pendingEgg.owner === me) {
    const spot = eggPlacement(view, me);
    if (spot) return { type: 'PLACE_EGG', x: spot.x, y: spot.y };
  }

  const candidates: Candidate[] = [];
  // 三套地形图（旱路 / 涉水 / 水路）算一次，本回合所有单位共用
  const wade = distanceFields(view, me, 'advance');
  const land = new Map<string, number[]>();
  for (const [id, field] of distanceFields(view, me, 'land')) {
    land.set(id, mergeAdvanceField(field, wade.get(id) ?? []));
  }
  // 战术倾向 + 主攻方向。
  //
  // 两件事一起算：主攻方向本来就是"往哪儿使劲"，而这正是三种战术分歧最大的地方
  // （速攻往最近那座压、骚扰往最没人守的那座摸、弃城期根本不往对面走）。
  // 所以 focusCityId 也归 aiMood 管，别在两处各算一次——那会出现"打分还在往
  // 老方向推、走位已经收回来了"的撕裂。
  const traits = aiTraits(view);
  const mood = aiActiveMood(view, traits);
  const foeUnits = unitsOf(view, other(me));
  /** 两翼分工：主攻方向定了才能分第二路 */
  const flank = flankSplit(view, me, land, mood.focusCityId);

  const fields: Fields = {
    tactical: tacticalMap(view, me),
    land,
    wade,
    water: distanceFields(view, me, 'water'),
    air: distanceFields(view, me, 'air'),
    bridgeSite: bestBridgeSite(view, me, wade),
    focusCityId: mood.focusCityId,
    flankCityId: flank.flankCityId,
    flank: flank.flank,
    mood,
    needBridge: !canReachEnemyByLand(view, me),
    hold: false,
    commit: false,
    // 弃城期不派人守那座城（传进去，pickGuardCity 会跳过它）
    guardCityId: pickGuardCity(view, me, foeUnits, mood.abandonedCityId),
    // 集火目标：整回合算一次，所有单位的攻击候选都看它
    focusTargetId: pickFocusTarget(view, me),
    // 海军需求 / 局势时代：同样整回合算一次，建造评分每个候选格都要读
    sea: seaDemand(view, me),
    era: eraNowOf(view),
    // 战线 / 站位密度：集结的两个半边，见 Fields 里的说明
    lineRef: frontLineRef(view, me, land, mood.focusCityId),
    crowd: crowdField(view, me),
    foeSplash: unitsOf(view, other(me)).filter((u) => (utype(view, u.type).splash ?? 0) > 0).length,
  };
  // 本回合的计划：攒不攒钱、收不收缩。采购和走位都要看它，
  // 所以在这里算一次，整回合共用（和 traits 一样）。
  const plan = buildPlan(view, me, unitsOf(view, me), foeUnits, mood);
  if (aiTrace.on && fields.flank.size > 0) aiTrace.flankUnits += fields.flank.size;
  /*
   * 把"在攒什么"搬回真状态。
   *
   * `buildPlan` 是在雾图副本上跑的（它和别的判断一样只能看得见的东西），
   * 但记忆必须落在真状态上，否则下次调用再从真状态切一份新副本，记忆就丢了。
   * 这是 aiNextAction 里唯一一处写状态的地方——它不改变任何合法动作，
   * 只影响"这一回合要不要停手攒钱"，所以不会让回放/联机出现分歧。
   */
  if (view.aiIntent?.[me]) s.aiIntent = { ...(s.aiIntent ?? {}), [me]: view.aiIntent[me]! };
  else if (s.aiIntent?.[me]) {
    const bag = { ...s.aiIntent };
    delete bag[me];
    s.aiIntent = bag;
  }
  // 这一回合的升级名额已经用掉了：攒时代的计划对采购就不再生效。
  // 不然钱被冻着、升级又没得升，这一回合等于白过——而且连着几个回合都白过。
  if (!mayUpgrade && plan.savingFor === 'era') plan.savingFor = null;
  fields.hold = plan.stance === 'turtle';
  /*
   * 换家：不守了，全军去啃最软的那座城。
   *
   * 三件事一起改，少一件都不成：
   *   · `commit = true`：关掉"追着路过的敌军打"那一路，全军才真的朝城下压；
   *   · `guardCityId = null`：不再派人回城驻守——`cityRegenOf` 那点回血救不了
   *     一座半血城，把人分回去只是把兵一个个送在城下；
   *   · 主攻方向换成**血最少**的那座敌城：换家换的是"谁先塌"，不是"谁最值钱"。
   */
  if (plan.stance === 'trade') {
    if (aiTrace.on) aiTrace.tradeCalls += 1;
    fields.hold = false;
    fields.commit = true;
    fields.guardCityId = null;
    const soft = view.cities
      .filter((c) => !c.ruined && c.owner !== me)
      .sort((a, b) => a.hp - b.hp || a.id.localeCompare(b.id))[0];
    if (soft) fields.focusCityId = soft.id;
  }
  // 优势期（身价压过对面三成）就不追着野战打了，全军压城——见 Fields.commit
  const myVal = unitsOf(view, me)
    .filter((u) => utype(view, u.type).category === 'combat')
    .reduce((n, u) => n + (utype(view, u.type).cost ?? 0), 0);
  const foeVal = unitsOf(view, other(me))
    .filter((u) => utype(view, u.type).category === 'combat')
    .reduce((n, u) => n + (utype(view, u.type).cost ?? 0), 0);
  // 压城门槛：速攻更早认定"我现在打得穿"（它整局的胜负压在这一次围城上），
  // 弃城期更晚——这时候全军压上去只是把攒的钱换成对面的击杀数。
  const commitAt =
    1.3 - 0.18 * mood.drive.rush + 0.15 * mood.drive.boom;
  fields.commit = myVal > 0 && myVal >= foeVal * commitAt;

  for (const u of unitsOf(view, me)) {
    candidates.push(...unitCandidates(view, u, fields, traits, rejected));
    const skill = heroSkillCandidate(view, u);
    if (skill) candidates.push({ ...skill, score:skill.score+300 });
  }

  // 这一回合"要不要养海军"：整回合只算一次（里面有一次全图 flood fill），
  // 别让它跟着每个产兵点、每个候选兵种重算。
  const seaDemandNow = seaDemand(view, me);

  /*
   * 换血排在这里，**不进候选表**。
   *
   * 它不是"和别的动作比一比"的一手：编制满的时候"造不出更好的兵"是硬状态，
   * 换血是解开这个状态的唯一办法。放进候选表反而会被一批四十分的走位压住
   * （满编后期每回合都有二三十个兵能动），这个机制就永远不触发。
   *
   * "一回合最多换一次"是**自限的**：解散之后 armySize 掉到 23，
   * 下一次进来第一条就不成立了。
   */
  const swapOut = swapOutCandidate(view, me, traits, plan, mood, seaDemandNow);
  if (swapOut) {
    if (aiTrace.on) aiTrace.swap += 1;
    return swapOut.action;
  }

  if (mayRecruit) {
    for (const city of citiesOf(view, me)) {
      // 指定了产兵点就只看那一个：别的地方再合适也不许造，
      // 否则"这座城出兵"就成了摆设（玩家指定它是为了布阵，不是为了择优）
      if (orderSite && city.id !== orderSite) continue;
      // 刚打下来的城当回合不产兵（rules 里同一条），提出来只会得到非法动作
      if (city.capturedTurn === s.turn) continue;
      // 废墟也造不出兵（规则里同样会拒）。不跳过的话 AI 会一直提这个动作，
      // 而它一旦被选中就必然失败——那一回合剩下的动作全被吞掉。
      if (city.ruined) continue;
      // 已经决定放弃的城不再往里面出兵：兵出在门口就是给对面送的，
      // 而且这一档的钱要留着换时代/英雄。（只剩它一座时就照常造，别把自己憋死。）
      if (city.id === mood.abandonedCityId && citiesOf(view, me).length > 1) continue;
      const c = recruitCandidate(
        view,
        { kind: 'city', id: city.id, x: city.x, y: city.y, era: city.era },
        traits,
        plan,
        order,
        mood,
        seaDemandNow,
      );
      if (c) candidates.push(c);
    }
    // 军营：跟城市一样能出兵，但时代是它自己落成时钉死的那个
    // （后方升了时代，老营不会隔空换代；要新兵就地再扎一座）。
    const own = citiesOf(view, me);
    if (own.length > 0) {
      for (const u of unitsOf(view, me)) {
        if (!isProducer(utype(view, u.type))) continue;
        if (orderSite && u.id !== orderSite) continue;
        const era = u.era ?? supplyEraAt(view, me, u);
        const c = recruitCandidate(
          view,
          { kind: 'camp', id: u.id, x: u.x, y: u.y, era },
          traits,
          plan,
          order,
          mood,
          seaDemandNow,
        );
        if (c) candidates.push(c);
      }
    }
  }

  if (mayUpgrade) {
    for (const city of citiesOf(view, me)) {
      if (city.ruined) continue; // 废墟升不了级，同上
      // 「升级时代」那一格也能指定城市：玩家常想"先升那座靠前的主城"。
      // 指定的是军营时不匹配任何城市，这一格就空转（营不会升级）。
      if (orderSite && city.id !== orderSite) continue;
      const c = upgradeCandidate(view, city, mood, plan);
      if (c) candidates.push({ ...c,score:c.score+(commander && head===ORDER_UPGRADE ? 1000 : 0) });
    }
  }

  for (let i=candidates.length-1;i>=0;i--) {
    const action=candidates[i]!.action;
    if (rejected.has(aiActionKey(action))) { candidates.splice(i,1); continue; }
    if (action.type==='BUILD' && plan.savingFor && !plan.urgent) {
      const cost=recruitCost(view,me,utype(view,action.unitType));
      if (cost>plan.buildAllowance && !utype(view,action.unitType).bridges) candidates.splice(i,1);
    }
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.score - a.score);

  /**
   * 雾图上看不见的敌人会挡在落点上。
   *
   * AI 是在 `view`（自己那份雾图）上算"这一格走得到"的，而真局里那格可能
   * 正好站着一支它没看见的兵——提出来就是非法动作，而执行方遇到非法动作
   * 会**中断整回合**，等于这个 AI 白白让掉一回合。
   * 所以落点要用真局再核一次。不核内容、只核合法性：这不叫开图，
   * 只是"别提一个必然被拒的动作"。
   */
  const moveOkInReal = (a: Action): boolean => {
    if (a.type !== 'MOVE') return true;
    const u = s.units.find((x) => x.id === a.unitId);
    if (!u) return false;
    return reachableTiles(s, u).has(a.y * s.w + a.x);
  };

  /*
   * ── 一层对手应对推演 ──
   *
   * 到这里为止，所有候选的分都只算了自己的收益；`tactical.exposure` 那个惩罚
   * 只管"这个兵自己下回合会掉多少血"。这一段把"**我走完这一步，对面下一回合
   * 会怎么还手**"补上：把动作真的落一次（`applyAction` 返回的是新状态，
   * 不会污染原局面），再问一次 `foeBestStrike`。
   *
   * 差分而不是绝对值：`reply0` 是"我什么都不做"时的威胁。
   * 于是加分的动作是"这一步让对面少打我一点"（打瞎射手、撤回肉盾、拆掉对面的
   * 打击位），扣分的是"这一步把贵的东西递过去"。
   *
   * 只推演前几名（见 LOOKAHEAD_K）：分数本身已经把绝大多数候选筛掉了，
   * 剩下的差别只在前几名之间。初级档不推演——它连"谁更贵"都不算，
   * 给它这一层等于把两档的差距抹平。
   */
  const lookahead = aiLevelOf(s) !== 'basic' && candidates.length > 1;
  const reply0 = lookahead ? foeOutput(view, me) : 0;
  const K = lookahead ? LOOKAHEAD_K : LOOKAHEAD_K * 2;
  const shortlist: Array<{ c: Candidate; v: number }> = [];
  for (const c of candidates) {
    if (shortlist.length >= K) break;
    if (!moveOkInReal(c.action)) continue;
    const applied = applyAction(view, c.action);
    if (!applied.ok) continue;
    let v = c.score;
    if (lookahead) v -= LOOKAHEAD_W * Math.max(0, foeOutput(applied.state, me) - reply0);
    shortlist.push({ c, v });
  }
  if (shortlist.length === 0) return null;
  shortlist.sort((a, b) => b.v - a.v);

  const best = shortlist[0]!;
  if (best.v <= 0) return null;
  // 推演把纯评分的第一名换掉了：这一条用来量"这一层到底有没有在起作用"
  if (aiTrace.on && lookahead && candidates[0] && best.c !== candidates[0]) aiTrace.lookaheadFlip += 1;

  // 在"和最优咬得很紧"的候选里随机挑一个：
  // 战棋里很多选择的评分本来就在伯仲之间（左翼还是右翼、先打哪个），
  // 永远挑第一个会让每一局都变成同一盘棋。
  //
  // 高级的带宽更窄：同分候选少挑几个，出手更集中在最优解上。
  // 但也不能压到 0——完全没有随机的话，每局都会变成同一盘棋。
  // 高级只在 1.5% 内选择近似等价动作，避免随机跳过救城或高收益击杀。
  // 战术差异由局势权重与种子偏好提供。
  const band =
    aiLevelOf(s) !== 'basic'
      ? Math.max(0.2, Math.abs(best.v) * 0.015)
      : Math.max(6, Math.abs(best.v) * 0.25);
  const tied = shortlist.filter((e) => e.v > 0 && best.v - e.v <= band);
  if (tied.length > 1) {
    const pick = tied[Math.floor(aiNoise(s) * tied.length)];
    if (pick) return pick.c.action;
  }
  return best.c.action;
}

export { AI_MAX_STEPS, DEFAULT_BUDGET, aiLevelOf, aiLevelLabel, isAiSide, anyAiSide } from './ai-meta.ts';
