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
import { playerView } from './fog.ts';
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
  damageToCity,
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
import { canPay, payRes, resOf } from './resources.ts';
import type { ResourceCost } from './resources.ts';
import { economicYield, tacticalMap, unitValue } from './ai-tactics.ts';
import type { TacticalMap } from './ai-tactics.ts';
import type { Action, City, GameState, PlayerId, Terrain, Unit, UnitTypeDef } from './types.ts';
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
    return c === 'economy' || c === 'builder' || economicYield(def(u))>0 || def(u).barracks;
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

function escapeRoutes(
  s: GameState,
  x: number,
  y: number,
  move: number,
  excludeCityId?: string | null,
): number {
  if (move <= 0) return 1;
  let open = 0;
  for (const [dx, dy] of DIRS) {
    const nx = x + dx;
    const ny = y + dy;
    if (!inBounds(s, nx, ny)) continue;
    const tile = s.tiles[ny * s.w + nx];
    if (!tile || !passable(tile.terrain)) continue;
    if (excludeCityId && tile.cityId === excludeCityId) continue;
    // 别的地方可能站着人，但那是暂时的；地形才是永久性的墙。
    // 出城要按"从城里往外走"的真实价算：往高处走还要加爬坡费。
    const from = s.tiles[y * s.w + x]?.terrain ?? null;
    if (stepCostBetween(s, from, tile.terrain) <= move) open += 1;
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
    if (economicYield(targetDef)>0 || targetDef.barracks) score += 22*mood.drive.harass;
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
  mode: 'land' | 'advance' | 'water' = 'land',
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

      if (mode === 'water') {
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
        (mode === 'water'
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
  mode: 'land' | 'advance' | 'water' = 'land',
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
interface Fields {
  tactical: TacticalMap;
  land: Map<string, number[]>;
  wade: Map<string, number[]>;
  water: Map<string, number[]>;
  bridgeSite: { x: number; y: number } | null;
  /**
   * 本回合的主攻方向：血最少的那座敌方城市。
   *
   * 没有这个"聚焦"，AI 的部队会一半扑这座城、一半扑那座城，
   * 每一边都只是把城墙刮花，然后被城市回血修回去——围城永远围不下来。
   */
  focusCityId: string | null;
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
  const fields = def.domain === 'water' ? all.water : all.land;
  const before = advanceDistance(s,unit.owner,unit.x,unit.y,fields,all.focusCityId,all.commit);
  const after = advanceDistance(s,unit.owner,x,y,fields,all.focusCityId,all.commit);
  const progress = Number.isFinite(before) && Number.isFinite(after) ? before-after : 0;
  let score = progress * 6 * traits.appetite * (1 + (all.needBridge ? 0 : w.rush*0.35));
  score += CONFIG.terrainDef[tileAt(s,x,y)!.terrain] * 1.5 - 1;
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
      return economicYield(d)>0 || d.category==='builder' || d.barracks;
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
  const fields = def.domain === 'water' ? all.water : all.land;

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

  // 站高地
  score += CONFIG.terrainDef[tile.terrain] * 2;

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
): number {
  const def = s.unitTypes[buildId];
  if (!def) return -999;
  const w = mood ? mood.drive : { rush: 0, harass: 0, boom: 0 };

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

  // 军营：把产兵点往前推，省下兵从后方跑到前线的那些回合。
  // 位置讲究"不近不远"——贴着敌人下回合就被推平，缩在后方等于没造。
  if (def.barracks) {
    const cities = citiesOf(s, unit.owner);
    // 军营的时代取最近城市，没有城市就产不出兵，那造它也没意义
    if (cities.length === 0) return -999;
    const mine = unitsOf(s, unit.owner).filter((u) => utype(s, u.type).barracks).length;
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
  if (!def.autoAttack && !def.barracks && !def.incomeByTerrain && !def.bridges) {
    const mine = unitsOf(s, unit.owner).filter((u) => {
      const ud = utype(s, u.type);
      return ud.category === 'building' && !ud.autoAttack && !ud.barracks && !ud.incomeByTerrain;
    }).length;
    if (mine >= Math.max(2, citiesOf(s, unit.owner).length * 2)) return -999;
    if (risky) return -999;

    let nearestFoe = Infinity;
    for (const e of unitsOf(s, other(unit.owner))) {
      nearestFoe = Math.min(nearestFoe, distance(spot, e));
    }
    // 敌人还没到门口，砌墙就是浪费一个建造回合
    if (!Number.isFinite(nearestFoe) || nearestFoe > 7) return 4;
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
  const raw = rawBuildScore(s, unit, buildId, spot, all.land, all.mood);
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
    return raw - (s.unitTypes[buildId]?.barracks ? 20 : 45);
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
    if (best) out.push(best);
  }

  return out;
}

/** 一个经济单位大概能赚多少（按最好的地形估） */
function maxIncome(def: UnitTypeDef): number {
  let best = def.income ?? 0;
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
  stance: 'push' | 'turtle' | 'elite';
  savingFor: 'hero' | 'era' | 'rebuild' | null;
  targetCost: number;
  /** 攒钱期可动用的现金：当前余额减去目标费用，最低为零 */
  allowance: number;
  urgent: boolean;
}

/** 攒钱的时间视野：几回合之内够得着才值得停手 */
const SAVE_HORIZON = 6;

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
  const ruinCost = foeRuins.length > 0 ? Math.min(...foeRuins.map((c) => rebuildCost(c))) : null;
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
  const eraCost = eraCosts.length > 0 ? Math.min(...eraCosts) : null;

  let savingFor: AiPlan['savingFor'] = null;
  let targetCost = 0;
  // 弃城期把"兵够不够"的门槛压低：这一档要的就是兵力少的时候也能攒钱，
  // 而不是"兵少于六个就永远别想升级"。urgent 那条线照旧拦着真正的危险。
  const armyGate = mood.weight.boom > 0.45 ? 4 : 6;
  if (!urgent && army >= armyGate) {
    // 6 个回合的收入之内够得着，才值得为它停手。收废墟例外：那是终局，
    // 视野放宽到 14 个回合——攒不够就永远赢不了，慢一点总比平局好。
    if (ruinCost !== null && gold + inc * (winningReclaim ? 14 : SAVE_HORIZON) >= ruinCost) {
      savingFor = 'rebuild';
      targetCost = ruinCost;
    } else if (heroDef && heroCost > 0 && gold + inc * SAVE_HORIZON >= heroCost) {
      savingFor = 'hero';
      targetCost = heroCost;
    } else if (eraCost !== null && gold + inc * SAVE_HORIZON >= eraCost) {
      savingFor = 'era';
      targetCost = eraCost;
    }
  }
  // Capture is the winning action. Reserve its fee before buying another unit.
  const nearbyRuin = foeRuins.filter(c => my.some(u => !u.moved && distToCity(u,c)<=Math.max(2,utype(s,u.type).move+1)))
    .sort((a,b) => rebuildCost(a)-rebuildCost(b))[0];
  if (nearbyRuin && !threaten) {
    savingFor = 'rebuild'; targetCost = rebuildCost(nearbyRuin);
  }
  if (mood.abandonedCityId || developingRear) {
    const retained = myCities.filter(c => !c.ruined && c.id!==mood.abandonedCityId);
    const costs = retained.map(c => upgradeCostOf(s,c)).filter((c): c is number => c!==null);
    const nextEra = costs.length ? Math.min(...costs) : null;
    if (heroDef && gold+inc*4 >= heroCost) { savingFor='hero'; targetCost=heroCost; }
    else if (nextEra!==null && gold+inc*SAVE_HORIZON>=nextEra) { savingFor='era'; targetCost=nextEra; }
  }

  // 只花超过目标费用的现金。未来收入用于判断目标能否实现，不能当作当前预算。
  // 短期回本的有限增产，以及危城以外的紧急防守，另有例外。
  const allowance = savingFor ? Math.max(0,gold - targetCost) : Infinity;

  // 兵力明显不如对面、对面又已经压到门口：收缩固守，把人留在城里。
  //
  // 这里比以前收紧了一档：以前是"只要身价落后就固守"，可 AI 一旦进入攒钱期
  // 身价必然落后，于是它自己把自己锁进固守、再也不出击（第一版就是这个死循环：
  // 越攒越不敢打，越不敢打越攒不出胜势）。固守是**防守姿态**，得真有敌人来攻。
  const weaker = myVal < foeVal * 0.75;
  const atGate = foe.some((u) =>
    myCities.some((c) => c.id !== mood.abandonedCityId && distToCity(u, c) <= 5),
  );
  // 精兵姿态：兵不是"越多越好"，是"每个出生名额都该值回票价"。
  // 每回合只有两个产兵名额（AI 的编制上限也压着），所以只要手头比一个兵宽裕
  // （金 ≥ 1.2 回合收入）或者编制快满，就该往贵的、能打的上面花钱。
  // 攒钱期同理：钱是要攒着买好的，再拿线性单价惩罚去压大件等于自我否定。
  const quality = savingFor !== null || gold >= inc * 1.2 || army >= CONFIG.maxUnits - 6;
  // 弃城期一律按"精兵"花钱：钱要攒着换时代/英雄，不该拆成一堆便宜兵。
  const elite = quality || mood.weight.boom > 0.5;
  const stance: AiPlan['stance'] =
    weaker && army >= 3 && atGate ? 'turtle' : elite ? 'elite' : 'push';

  return { stance, savingFor, targetCost, allowance, urgent: mood.abandonedCityId ? threaten : urgent };
}

function recruitCandidate(
  s: GameState,
  src: RecruitSource,
  traits: AiTraits,
  plan: AiPlan,
  order?: string | null,
  mood?: AiMood,
): Candidate | null {
  // 没传就是"不带战术倾向"（指挥官模式排产草稿、单元测试都会走这条），
  // 权重全零时下面每一条加成都是 0，行为和改动前一模一样。
  const moodw: Record<AiDoctrine, number> = mood
    ? mood.drive
    : { rush: 0, harass: 0, boom: 0 };
  const w = moodw;
  const me = s.current;
  const gold = s.players[me].gold;
  // 和 rules 一样只数作战单位：建筑不占编制，别让几座磨坊把产线堵死
  if (armySize(s, me) >= CONFIG.maxUnits) return null;

  /** 这个产兵点能往哪些格子出兵（跟 rules 里的 doRecruit 保持一致） */
  const slotsFor = (water: boolean): Array<{ x: number; y: number }> => {
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
      if (water ? !navigable(tile.terrain) : !passable(tile.terrain)) continue;
      if (unitAt(s, cell.x, cell.y)) continue;
      out.push(cell);
    }
    return out;
  };

  const landSlots = slotsFor(false);
  const waterSlots = slotsFor(true);
  if (landSlots.length === 0 && waterSlots.length === 0) return null;

  const choices = Object.values(s.unitTypes).filter((d) => {
    if (d.category === 'building') return false;
    // 运输船目前只给玩家用：AI 还没有"装船—渡河—上岸"这套计划能力，
    // 让它买一条自己不会用的船，等于白烧 60 金。
    if (d.transport) return false;
    // 召唤物只认召唤者：AI 花 45 金买一个骷髅，等于给死灵法师的赠品单独付钱。
    if (d.summonedOnly) return false;
    // 英雄场上只能有一个（蛋还没孵也算"有一个"）。这条规则在 doRecruit 里也拦了，
    // 但在这里先拦掉，才能让 AI 把"再多买一个"的钱花到别处，而不是每回合撞一次墙。
    if (heroBlocked(s, me, d)) return false;
    // 时代窗口与选卡名单走 core/draft 的同一套判据：
    // 选卡模式下 AI 也只能造自己选到的兵，且旧时代的兵不再被"过时"挡住
    if (!eraWindowOk(s, d, src.era)) return false;
    if (!canUseType(s, me, d.id)) return false;
    return d.domain === 'water' ? waterSlots.length > 0 : landSlots.length > 0;
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
  // 编队模板要的"这支部队现在长什么样"。每次 candidate 都重算一遍，
  // 所以同一回合里连买三个近战后，第四次会看见"近战已经够了"。
  const rosterBonus = rosterBonuses(rosterOf(s, me));

  let best: Candidate | null = null;
  for (const d of pool) {
    if (!recruitSpawnCells(s,src.kind==='city' ? src.id : undefined,src.kind==='camp' ? src.id : undefined,d.id).length) continue;
    // 英雄第一次要付解锁费：只看造价会让 AI 在"差一点钱"的时候反复选中又放弃。
    // 这笔钱和规则层、界面估价共用 recruitPriceOf 一份口径——三处各算一次，
    // 迟早会出现"AI 以为买得起、规则层说资源不足、这一格生产序列静默空转"。
    const quote = recruitPriceOf(s, me, d);
    const unlockFee = quote.unlockFee;
    const price = recruitCost(s, me, d);
    // 多资源：粮食/建材不够时，光有金币也买不起。
    // 只看金币会让 AI 反复挑一个造不出来的兵，然后整回合卡在那里。
    if (!canPay(s.players[me], quote.total)) continue;

    // 水军看地图：干地上造出来的船只是八十金的靶子。
    // 干湿两张图差得非常多（开阔 2% / 双河 25%），所以这条不能靠"有没有邻水格"判断——
    // 一个池塘边上也能造船，但它开不出去。
    if (d.domain === 'water' && wet < WATER_MIN_SHARE) continue;
    if (gold < quote.gold) continue;

    // ── 攒钱 ──
    // 计划要用的那笔钱是**冻结差额**，不是"停掉产线"：买完这兵之后账上还剩得下
    // 计划要的份额，就该买。第一版写的是硬停采购（差额没凑齐就一个兵不造），
    // 实测胜率掉到 38.8%——钱是攒下来了，可对面在这几个回合里多出四五个兵，
    // 城下再也没站起来过。攒钱的意义是"为了一件大事忍一手"，不是"把自己饿死"。
    if (plan.savingFor && !plan.urgent && !order) {
      // 目标本身就是它（攒英雄）：到店就买，别被自己的冻结额度挡住
      const isTarget = plan.savingFor === 'hero' && d.hero;
      // 回本 ≤8 回合的经济单位不冻结：它是"以后每回合多几金"，停了等于
      // 把攒钱速度砍掉一半。工匠（现在一个都没有时）同理，第一座磨坊/粮仓
      // 的边际收益比任何一个兵都高。
      const ecoInc = maxIncome(d);
      const payback = ecoInc > 0 ? price / ecoInc : 99;
      const fastEco =
        (d.category === 'economy' && earners < Math.min(targetEarners,payback<=4 ? 6 : 4) && payback <= 8) ||
        (d.category === 'builder' && builders === 0);
      if (!isTarget && (!fastEco || plan.savingFor==='rebuild') && price + unlockFee > plan.allowance) continue;
      // 攒的是升时代：钱够了就把这一回合让给 UPGRADE（升完的兵比多一个兵值）。
      // 但要确认升级现在真的买得起——否则那条动作会被别的原因拒掉，这一回合白过。
      if (plan.savingFor === 'era' && !isTarget && gold >= plan.targetCost) {
        const canUpgradeNow = citiesOf(s, me).some((c) => {
          const cost = upgradeCostOf(s, c);
          return cost !== null && gold >= cost;
        });
        if (canUpgradeNow) continue;
      }
    }

    let score = 50;
    if (d.category === 'combat') {
      score += 12 + d.era * 4;
      if (aiLevelOf(s)!=='basic') {
        const efficiency = (d.atk + (d.magicAtk??0)*1.2) * Math.sqrt(d.maxHp)
          * (1+Math.min(4,Math.max(0,d.range-1))*0.45) / Math.max(20,resourceValue(s,me,quote.price)+unlockFee*0.4)**0.8;
        score += Math.min(26,efficiency*3);
        if (plan.urgent) score += 15;
      }
      if (d.domain === 'water') {
        score -= 8;
        // 有点水但不宽裕：船能开，只是绕不开岸，别当主力
        if (wet < WATER_GOOD_SHARE) score -= 10;
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
      const slots = d.domain === 'water' ? waterSlots : landSlots;
      const canLeave = slots.some((c) =>
        escapeRoutes(s, c.x, c.y, d.move, src.kind === 'city' ? src.id : null) > 0,
      );
      if (!canLeave) continue;
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
    const perGold =
      plan.stance === 'elite' ? 0.012 : aiLevelOf(s) !== 'basic' ? 0.035 : 0.05;
    score -= price * (d.era >= 4 ? perGold * 0.6 : perGold);
    // 攒钱姿态下额外给大件一点意愿：既然要停手攒钱，那就攒来买好的
    if (plan.stance === 'elite' && price >= 100) score += 8;

    // 军营是前线补给点：在军营出兵有额外价值（省了从后方跑一趟）
    if (src.kind === 'camp') score += 6;

    if (traits.favorites.includes(d.id)) score += 9;
    // 高级的随机幅度更小：选择更"有主意"，不会因为噪声去造一个明显不合适的兵
    score += (aiNoise(s, d.id.length * 31 + d.id.charCodeAt(0)) - 0.5) * (aiLevelOf(s) !== 'basic' ? 4 : 8);

    // 指挥官点名的兵种优先落地。
    // 产兵是这个模式里玩家唯一的杠杆，必须赶在 AI 把钱花到建筑/升级之前执行，
    // 否则"我排了三个坦克，一个都没出来"——而且玩家看不出是被什么吃掉的。
    if (order && d.id === order) score += 240;

    const action: Action =
      src.kind === 'camp'
        ? { type: 'RECRUIT', unitId: src.id, unitType: d.id }
        : { type: 'RECRUIT', cityId: src.id, unitType: d.id };

    if (!best || score > best.score) best = { action, score };
  }
  return best;
}

function upgradeCandidate(s: GameState, city: City, mood?: AiMood): Candidate | null {
  if (city.id === mood?.abandonedCityId) return null;
  const cost = upgradeCostOf(s, city);
  if (cost === null) return null;
  const gold = s.players[s.current].gold;
  if (gold < cost) return null;

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
  if (city.era >= myEra) score += 6;
  else score -= 4;

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
    if (!utype(s, u.type).barracks) continue;
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
    players: { A: { ...s.players.A }, B: { ...s.players.B } },
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
        { stance: 'push', savingFor: null, targetCost: 0, allowance: Infinity, urgent: true },
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
export function aiNextAction(s: GameState, budget: AiBudget = DEFAULT_BUDGET, rejected: ReadonlySet<string> = new Set()): Action | null {
  if (s.winner) return null;

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

  const fields: Fields = {
    tactical: tacticalMap(view, me),
    land,
    wade,
    water: distanceFields(view, me, 'water'),
    bridgeSite: bestBridgeSite(view, me, wade),
    focusCityId: mood.focusCityId,
    mood,
    needBridge: !canReachEnemyByLand(view, me),
    hold: false,
    commit: false,
    // 弃城期不派人守那座城（传进去，pickGuardCity 会跳过它）
    guardCityId: pickGuardCity(view, me, foeUnits, mood.abandonedCityId),
  };
  // 本回合的计划：攒不攒钱、收不收缩。采购和走位都要看它，
  // 所以在这里算一次，整回合共用（和 traits 一样）。
  const plan = buildPlan(view, me, unitsOf(view, me), foeUnits, mood);
  // 这一回合的升级名额已经用掉了：攒时代的计划对采购就不再生效。
  // 不然钱被冻着、升级又没得升，这一回合等于白过——而且连着几个回合都白过。
  if (!mayUpgrade && plan.savingFor === 'era') plan.savingFor = null;
  fields.hold = plan.stance === 'turtle';
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
      );
      if (c) candidates.push(c);
    }
    // 军营：跟城市一样能出兵，但时代是它自己落成时钉死的那个
    // （后方升了时代，老营不会隔空换代；要新兵就地再扎一座）。
    const own = citiesOf(view, me);
    if (own.length > 0) {
      for (const u of unitsOf(view, me)) {
        if (!utype(view, u.type).barracks) continue;
        if (orderSite && u.id !== orderSite) continue;
        const era = u.era ?? supplyEraAt(view, me, u);
        const c = recruitCandidate(
          view,
          { kind: 'camp', id: u.id, x: u.x, y: u.y, era },
          traits,
          plan,
          order,
          mood,
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
      const c = upgradeCandidate(view, city, mood);
      if (c) candidates.push({ ...c,score:c.score+(commander && head===ORDER_UPGRADE ? 1000 : 0) });
    }
  }

  for (let i=candidates.length-1;i>=0;i--) {
    const action=candidates[i]!.action;
    if (rejected.has(aiActionKey(action))) { candidates.splice(i,1); continue; }
    if (action.type==='BUILD' && plan.savingFor && !plan.urgent) {
      const cost=recruitCost(view,me,utype(view,action.unitType));
      if (cost>plan.allowance && !utype(view,action.unitType).bridges) candidates.splice(i,1);
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

  while (candidates.length && (!moveOkInReal(candidates[0]!.action) || !applyAction(view, candidates[0]!.action).ok)) {
    candidates.shift();
  }

  const best = candidates[0];
  if (!best || best.score <= 0) return null;

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
      ? Math.max(0.2, Math.abs(best.score) * 0.015)
      : Math.max(6, Math.abs(best.score) * 0.25);
  const tied = candidates.filter(
    (c) => c.score > 0 && best.score - c.score <= band && moveOkInReal(c.action) && applyAction(view,c.action).ok,
  );
  if (tied.length > 1) {
    const pick = tied[Math.floor(aiNoise(s) * tied.length)];
    if (pick) return pick.action;
  }
  return best.action;
}

export { AI_MAX_STEPS, DEFAULT_BUDGET, aiLevelOf, aiLevelLabel, isAiSide, anyAiSide } from './ai-meta.ts';
