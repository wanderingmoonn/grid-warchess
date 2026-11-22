/**
 * ⚠️ **实验 AI（v3，目标状态机）—— 老 AI 的完整副本，2026-11-21 fork。**
 *
 * ── 为什么复制而不是在 `ai.ts` 里开口子 ──────────────────────────
 *
 * 老 AI 是这几年攒下来的启发式，任何改动都可能悄悄改变它的行为。实验想法
 * （远期规划、目标状态机、决战时代、经济配比）要能**随便大改**，前提是
 * "改坏了也只坏这一份"。
 *
 * 所以这里是一份**独立文件**：`ai.ts` 冻结为参考实现与对照基线，
 * 新东西全在这份里长。两边不共享代码，也就不会互相影响。
 *
 * ── 代价（要认）──
 *
 * 同一处战术 bug 可能在两边各存在一次。约定：
 *   · **`ai.ts` 只修"影响对局正确性"的 bug**（会崩、会产生非法动作、会改存档语义），
 *     修完不往 v3 同步；
 *   · 玩法/策略上的改动**只进 v3**；
 *   · `ai-duel --old ./baselines/...` 用冻结的老版做对照，别用 `ai.ts`，
 *     否则"基线"会跟着漂。
 *
 * ── 现在和老的有什么不同 ──
 *
 * 暂时没有——这是**逐字复制**，用来先证明"换成另一份文件后行为一致"。
 * 真正的新算法从这里往下长。
 */
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
import { enterMemoScope, exitMemoScope, memoByState, memoTable } from './memo.ts';
import { CONFIG, ERAS, ORDER_IDLE, ORDER_UPGRADE, navigable, passable } from './config.ts';
import { hasHold, holdOf, holdRoom } from './carry.ts';
import { isProducer, produceUsableCount } from './produce.ts';
import { cityGap } from './geo.ts';
import { playerView } from './fog.ts';
import type { PlayerView } from './fog.ts';
import { EFF_SCALE, unitEfficiency, unitPower } from './unit-value.ts';
import { nextEraLevelOf } from './era-routes.ts';
import { eraCeilingOf } from './expansions.ts';
import type { ValueContext } from './unit-value.ts';
import {
  abilityApi,
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
  previewAttack,
  reachableTiles,
  rebuildCost,
  recruitCost,
  recruitPriceOf,
  recruitSpawnCells,
  recruitResCost,
  siegeTargets,
  stepCostBetween,
  produceAt,
  tileAt,
  underConstruction,
  unitAt,
  unitYield,
  unitsOf,
  upgradeCostOf,
  utype,
  xyOf,
  isAirborne,
  strikeDistance,
  sameTeam,
} from './rules.ts';
import { MODULES, canMount, energyReport, offlineModules, weaponsOf } from './armor.ts';
import { canUseType, eraWindowOk } from './draft.ts';
import { isArmed, orderDirectiveOf } from './rules.ts';
import { GOLD, canPay, payRes, resOf } from './resources.ts';
import type { ResourceCost } from './resources.ts';
import { economicYield, tacticalMap, unitValue } from './ai-tactics.ts';
import { terrainArmorOf } from './ability-registry.ts';
import type { TacticalMap } from './ai-tactics.ts';
import { seatsOf } from './types.ts';
import type { Action, AiFocus, AiIntent, City, GameState, KnownUnit, PlayerId, ProduceSource, Terrain, Unit, UnitTypeDef } from './types.ts';
// 档位 / 托管判定 / 预算这几个"元信息"住在 ai-meta.ts：它们要给界面用，
// 不该为了两行判断把整个引擎拉进首屏。这里只是转手引用（并继续对外导出）。
import type { AiBudget } from './ai-meta.ts';
import { NULL_STRATEGIST } from './ai-strategist.ts';
import type { Strategist } from './ai-strategist.ts';
import { DEFAULT_BUDGET, aiLevelOf, isAiSide } from './ai-meta.ts';
import { UNIT_AI_MUST_SCORE, unitAiActionProblem, unitAiOf, unitAiWarn } from './unit-ai.ts';
import type { UnitAiBinding } from './unit-ai.ts';
import type { UnitAiResult } from './expansions.ts';
import { SKILL_AI_HINTS } from './skill-hooks.ts';
import {
  COMMIT_BUILD_BONUS,
  allAiGoals,
  DEFAULT_GOAL_BUILD_SCORE,
  DEFAULT_GOAL_UNIT_SCORE,
  DEFAULT_GOAL_SAVE_SCORE,
  goalStepsInPlay,
  registerCoreGoal,
  resolveCommit,
} from './ai-goal.ts';
import type { AiGoalCtx, AiGoal } from './ai-goal.ts';
import type { AiCommit, AiSquad, AiSquadReport } from './types.ts';
import {
  PLAN_TUNING,
  neutralWeights,
  notePlanTrace,
  planActions,
  planCtxOf,
  registerAiPlan,
  resolvePlans,
} from './ai-plan.ts';
import type { PlanCtx, PlanWeights } from './ai-plan.ts';
// 注意：本文件里 `AiPlan` 已经指"这一回合的打法"（stance/savingFor），
// 那是老东西。排序层的计划是另一个概念，这里改名避开歧义。
import type { AiPlan as RankedPlan } from './ai-plan.ts';
import { armyStrength, econCapacity, powerInputOf, powerPerTurn, powerRace, productionCapacity } from './ai-strength.ts';
import { solvePower } from './power-solver.ts';

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
  /**
   * 跳过"推演削分"（下面 lookahead 那一段）。
   *
   * 只有两种候选会带它：扩展用 `must` 提出的"剧本动作"，和它自己标了
   * `ignoreRisk` 的演出招式。理由是这两类不是"求最优的一手"——
   * 一个是剧本要求，一个是设计上就该以伤换伤。普通走位和普攻标了它，
   * 等于让这个兵站着送。
   */
  ignoreRisk?: boolean;
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
  /**
   * 未加增益的 drive（0~1）。**阈值与比例判断读这个**，加法打分读 drive。
   *
   * 2026-11-06 拆开的原因：要给战术层"补量级"，最省事的做法是把 drive 整体乘个
   * 系数；但 `pushing = drive.boom < 0.5`、`if (w.harass > 0.12)`、`score *= 1-0.45*w.boom`
   * 这类地方读的是**门槛和比例**，跟着一起放大会悄悄改语义（门槛变得形同虚设、
   * 比例项失衡）。所以增益只作用于"加分/扣分"，判断仍看原始值。
   */
  driveRaw: Record<AiDoctrine, number>;
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
 * 战术层增益：drive 在**加法打分**里的乘数。
 *
 * 为什么要有这个数：drive 减掉 1/3 再放大三倍，典型值只有 0~0.35；乘以 22~26 分的
 * 系数之后，一次"主导战术"能搬动的分差是 5~9 分。而场上真正的判决量级是
 * 击杀 120、威胁紧迫 25~100。于是战术层在 98.5% 的决策点上搬不动任何东西
 * （2026-11-06 实测：同局面动作一致率 98.5%，n=20775）。
 *
 * 1 = 原样（当前值）。改动这个数只用 `probe:agreement` 看动作变化率，不看胜率——
 * 量级不够时胜率必然中性，跑胜率是浪费。
 *
 * 响应曲线（12 局，同局面动作一致率）：1 → 98.6%，2 → 95.3%，4 → 90.6%，8 → 83.4%。
 * **2026-11-06 试过把默认设成 4**（动作变化 9.4%，是原样的 6.7 倍），
 * 400 局对增益=1 的基线是 46.5%（z=-1.40，偏负未达显著）。也就是说：
 * 战术层不是"量级不够所以搬不动"，是"搬到了也不管用"。已退回 1。
 * 这个旋钮留着，是为了以后要量"战术层到底能影响多少决策"时有个干净的入口。
 */
let DOCTRINE_GAIN = 1;

/** 只给探针/用例用：设定增益后跑同一批种子，看动作变化率 */
export function setDoctrineGain(x: number): void {
  DOCTRINE_GAIN = Math.max(0, x);
}

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

/* ===========================================================================
 * 多席位：谁是"对面"
 * ======================================================================== */
/**
 * 玩家 p 的所有敌人。
 *
 * 这套 AI 原本只服务双人局，满篇都是 `other(me)`。三人四人局要开起来（指挥官模式
 * 需要在多人局里替某一方操作），就把"对面"从**一个人**放宽成**一群人**：
 * 打架、算威胁、看对面经济，全部按"所有人"来；只有"往哪个方向推"这种
 * 必须挑一家的事，才用 `primaryFoe` 挑最强的那家。
 *
 * 双人局下这几个函数和 `other` 完全等价，所以既有对局的行为一点没变。
 */
function enemySeats(s: GameState, p: PlayerId): PlayerId[] {
  // 同盟局里队友不是敌人（不然 AI 会一直"想打又打不了"，把回合耗在队友身上）
  return seatsOf(s).filter((x) => !sameTeam(s, x, p));
}

function enemyUnitsOf(s: GameState, p: PlayerId): Unit[] {
  const out: Unit[] = [];
  for (const x of enemySeats(s, p)) out.push(...unitsOf(s, x));
  return out;
}

function enemyCitiesOf(s: GameState, p: PlayerId): City[] {
  const out: City[] = [];
  for (const x of enemySeats(s, p)) out.push(...citiesOf(s, x));
  return out;
}

/**
 * 主攻方向：挑兵力值最高的那个敌人。
 *
 * 多人局里"打谁"是要选的，但整套推进/威胁场只支持一个方向。这里不假装能同时
 * 规划两个方向——挑最强的那家当主攻，其余照打不误（战斗目标走 `enemyUnitsOf`）。
 */
function primaryFoe(s: GameState, p: PlayerId): PlayerId {
  const list = enemySeats(s, p);
  if (list.length <= 1) return list[0] ?? p;
  let best = list[0]!;
  let bestVal = -1;
  for (const x of list) {
    let v = 0;
    for (const u of unitsOf(s, x)) v += unitValue(s, u);
    for (const c of citiesOf(s, x)) v += c.hp * 0.15;
    if (v > bestVal) {
      bestVal = v;
      best = x;
    }
  }
  return best;
}

export function aiMood(s: GameState, traits: AiTraits = aiTraits(s)): AiMood {
  const me = s.current;
  /*
   * 指挥官模式里人类定的策略与进攻方向。普通对局恒为 `{ strategy: 'auto' }`，
   * 下面所有覆盖分支都不会走，行为与这个机制上线前完全一致。
   */
  const directive = orderDirectiveOf(s, me);
  const my = unitsOf(s, me);
  // 多人局里"对面"是一群人，mood 关心的是"我打不打得过他们加起来"，所以求和
  const foe = enemyUnitsOf(s, me);
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
  const foeCities = enemyCitiesOf(s, me).filter((c) => !c.ruined);
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
  // 多人局：对面几家的收入加起来，才是他们一共能出多少兵
  const foeIncome = enemySeats(s, me).reduce(
    (n, x) => n + Math.max(0, incomeResOf(s, x).gold ?? 0),
    0,
  );
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
  /*
   * 进攻方向：玩家点了"打某一家"或"朝某个方向推"时，先把目标城收窄成那一批，
   * 再走原来的"血最少、最近"规则。收窄之后一座都不剩就退回全量——
   * 宁可打偏，也不能让"方向猜错了"把整支军队钉在原地不动。
   */
  const focusPool = (() => {
    const t = directive.target;
    if (!t) return foeCities;
    if ('seat' in t) {
      const mine = foeCities.filter((c) => c.owner === t.seat);
      return mine.length > 0 ? mine : foeCities;
    }
    // 以我方各城的重心为原点，只留下落在该方向 ±60° 内的敌城
    const origin = myCities.length > 0
      ? {
          x: myCities.reduce((n, c) => n + c.x, 0) / myCities.length,
          y: myCities.reduce((n, c) => n + c.y, 0) / myCities.length,
        }
      : my.length > 0
        ? { x: my[0]!.x, y: my[0]!.y }
        : null;
    if (!origin) return foeCities;
    const dlen = Math.hypot(t.dx, t.dy) || 1;
    const along = foeCities.filter((c) => {
      const vx = c.x - origin.x;
      const vy = c.y - origin.y;
      const len = Math.hypot(vx, vy) || 1;
      return (vx * t.dx + vy * t.dy) / (len * dlen) >= 0.5;
    });
    return along.length > 0 ? along : foeCities;
  })();
  const focusCity = focusPool.reduce<City | null>((best, c) => {
    if (!best) return c;
    if (c.hp !== best.hp) return c.hp < best.hp ? c : best;
    return nearestOwn(c) < nearestOwn(best) ? c : best;
  }, null);

  let focusDist = Infinity;
  if (foeCities.length === 0) {
    // 无城局（F1）：目标不是城，是敌人本身。不给这个数，`focusDist` 会一路
    // 变成 99，打法选择会以为"哪儿都不值得去"。
    for (const u of myCombat) {
      for (const e of enemyUnitsOf(s, me)) focusDist = Math.min(focusDist, distance(u, e));
    }
    // 连敌人都没看见（迷雾里）：按"到战场中央的距离"算，至少不是无穷远
    if (!Number.isFinite(focusDist)) {
      const c = { x: Math.floor((s.w - 1) / 2), y: Math.floor((s.h - 1) / 2) };
      for (const u of myCombat) focusDist = Math.min(focusDist, distance(u, c));
    }
  } else {
    for (const c of foeCities) {
      for (const u of myCombat) focusDist = Math.min(focusDist, distToCity(u, c));
    }
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
  //
  // 2026-11-06 收紧。窄决策采集（720 局、tactic 档）给的三分：
  //   rush 49.6% / harass 34.8% / boom 54.0%——harass 显著最差，比均分低 15 点。
  // 问题不在打分公式，在**它被选中的场合**：原来四个信号全是斜坡，光"对面有几个
  // 农民"就够把 harassEv 顶到 0.6，于是手里只有步兵的 AI 也会宣布自己在骚扰，
  // 然后拿一把切不进去的兵去白换正面。
  //
  // 所以加的是两道**准备度**（0~1 的系数，不是新的打分项）：
  //   ① 手里真有一支能出去跑的队伍（骑兵 + 远程）——否则"骚扰"只是把步兵送过去；
  //   ② 对面真有值得切的软目标。
  // 用连续系数而不是布尔闸门，是因为兵是一个一个造出来的：硬切会让战术在一回合
  // 内翻脸，"切换是渐变的"那条用例盯的就是这个。
  // 两道都不满足时 harassEv 落到 -0.55（evidence 0.22），保留底色，但不再主导。
  //
  // 另外乘了个 0.88 的全局折扣：三套战术里它实测最弱，而"最弱"不等于"禁用"——
  // 折扣把它从"经常主导"降到"在真合适的局面里才主导"。
  const strike = raiders + ranged * 0.6;
  const harassReady = clamp01((strike - 1) / 2) * clamp01((foeEco - 1) / 1.5);
  const harassRaw = blend([
    [1.0, bipolar(mobilityEdge, -2, 2)],
    [0.9, bipolar(foeEco, 0, 4)],
    [1.0, -powerEdge],
    [0.6, bipolar(foeIncome - myIncome, -4, 4)],
  ]);
  const harassEv = harassRaw * 0.88 * harassReady - 0.55 * (1 - harassReady);

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
  let weight: Record<AiDoctrine, number> = {
    rush: sum > 0 ? sharp.rush / sum : 1 / 3,
    harass: sum > 0 ? sharp.harass / sum : 1 / 3,
    boom: sum > 0 ? sharp.boom / sum : 1 / 3,
  };
  /*
   * 人类点名的策略**压过** AI 自己的判断。
   *
   * 这就是这个机制存在的意义：AI 的判断是概率性的权重，玩家要的是"我说打就打"。
   * 所以不叠加、不折中——直接换成硬权重，剩下的一点余量留给 harass，
   * 免得"猛攻"变成"一根筋冲正面"。
   *
   * hold（屯兵不动）落在 boom 上：生产、升级、攒钱照常，只是不出击；
   * 出击与否由 `aiNextAction` 的过滤层管，两支笔分开写，各自都能读。
   */
  if (directive.strategy === 'rush') weight = { rush: 0.85, harass: 0.1, boom: 0.05 };
  else if (directive.strategy === 'boom') weight = { rush: 0.05, harass: 0.05, boom: 0.9 };
  else if (directive.strategy === 'hold') weight = { rush: 0, harass: 0, boom: 1 };

  /*
   * 脚本强制的战术（`config.aiDoctrine`）：和"人类点名"同一条路，直接换硬权重。
   *
   * 为什么压在最外层：窄决策那一层要量"这个局面用哪种打法更值"，
   * 量的前提是**打法真的按指定执行**。让它和局势证据混合，量出来的就是
   * "AI 想打的"而不是"我指定的"。
   *
   * 每种留一点余量给次优项，理由同上面那条注释：硬到 100% 会让"猛攻"
   * 变成一根筋冲正面，连侧翼包抄都不做。
   */
  const forced = s.config.aiDoctrine;
  const forcedSeat = s.config.aiDoctrineSeat;
  if (forced && (!forcedSeat || forcedSeat === s.current)) {
    if (forced === 'rush') weight = { rush: 0.85, harass: 0.1, boom: 0.05 };
    else if (forced === 'harass') weight = { rush: 0.05, harass: 0.9, boom: 0.05 };
    else if (forced === 'boom') weight = { rush: 0.05, harass: 0.05, boom: 0.9 };
  }
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
    // 屯兵不动 = 死守，不弃城：这条是玩家亲口定的，优先于 AI 的弃城判断
    directive.strategy === 'hold'
      ? null
      : weight.boom >= 0.42 && doom && !doom.core && canCashIn && trulyLost
      && doomKeptSafe
      ? doom.id
      : gambitArmed
        ? sacrifice!.city.id
        : null;

  const driveRaw: Record<AiDoctrine, number> = {
    rush: clamp01((weight.rush - 1 / 3) * 3),
    harass: clamp01((weight.harass - 1 / 3) * 3),
    // 保留连续的发展权重：前城失守后，安全后方仍需完成增产和科技兑现。
    // 非战术档由 aiActiveMood 统一屏蔽，现金预算与安全条件另行约束投资。
    boom: clamp01((weight.boom - 1 / 3) * 3),
  };
  const drive: Record<AiDoctrine, number> = {
    rush: driveRaw.rush * DOCTRINE_GAIN,
    harass: driveRaw.harass * DOCTRINE_GAIN,
    boom: driveRaw.boom * DOCTRINE_GAIN,
  };

  return {
    lead,
    weight,
    drive,
    driveRaw,
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
  for (const e of enemyUnitsOf(s, owner)) {
    const def = utype(s, e.type);
    if (distance(e, target) <= def.range) return true;
    for (const i of reachableTiles(s, e).keys()) {
      if (distance(xyOf(s, i), target) <= def.range) return true;
    }
  }
  return false;
}

/**
 * 这座城还剩几个能出兵的空格（用最便宜的陆军战斗兵种探）。
 *
 * 0 = 城被自己人占满，**再也造不出兵**。这个数不是"产能估计"，
 * 是规则层 `recruitSpawnCells` 的原话——它返回空，造兵动作就会被拒。
 */
function spawnCellCountOf(s: GameState, city: City): number {
  const probe = Object.values(s.unitTypes)
    .filter((d) => d.category === 'combat' && d.domain !== 'water')
    .sort((a, b) => (a.cost ?? 0) - (b.cost ?? 0))[0];
  if (!probe) return 0;
  return recruitSpawnCells(s, city.id, undefined, probe.id).length;
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
  // 一次决策里它要被问两遍（`fields.sea` 和采购那一段各一次），
  // 而每次都要跑一趟全图连通性搜索。结果只取决于地形与城的归属，记一份即可。
  const cache = memoTable<Map<string, number>>('sea-demand');
  if (cache) {
    const byPlayer = memoByState(cache, s, () => new Map<string, number>());
    const hit = byPlayer.get(me);
    if (hit !== undefined) return hit;
    const v = seaDemandNow(s, me);
    byPlayer.set(me, v);
    return v;
  }
  return seaDemandNow(s, me);
}

function seaDemandNow(s: GameState, me: PlayerId): number {
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
  for (const e of enemyUnitsOf(s, owner)) {
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
  const foe = nearestCityGap(s, primaryFoe(s, me), at, null);
  if (mine === null) return 0;

  // 一、死守
  const holding = all.pullHome > 0.3 || all.guardCityId !== null;
  if (mine <= 3 && (foe === null || mine < foe)) {
    return 30 - mine * 4 + (holding ? 14 : 0);
  }

  // 二、进攻：桥已经在我推进的方向上（离对面的城更近），而且我没在收着打
  const pushing = all.pullHome < 0.3 && all.mood.abandonedCityId === null && all.mood.driveRaw.boom < 0.5;
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
  if (mood.driveRaw.boom > 0.2 && mood.metrics.gate > 6) score -= 12 * w.boom;

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
  foeEcon = 1,
): number {
  const dmg = damageToCity(attacker, city, s);
  if (dmg <= 0) return -10;
  const capture = dmg >= city.hp;
  const attackerDef = utype(s, attacker.type);

  // 攻城直接通向胜利，权重给得比野战高；能打就打，别在城墙下晃。
  // 这一档整体抬过一次：以前破城的收益常常比"打掉一个杂兵"高不了多少，
  // AI 于是宁可在野战里刷人头，也不肯把兵力压到城下——而人头是赢不了棋的。
  let score = (capture ? 260 : (dmg / city.maxHp) * 62) + 26;

  /*
   * A（2026-11-15）：对面**一个经济单位都没有**时，攻城再加一档。
   *
   * 纯爆兵的对手没有产能可打，唯一的胜负手就是把城砸开——他不会靠经济追上来，
   * 只会用兵换我们的兵。这时候还去跟满血战斗单位换血，等于拿阵容填他的兑换率
   * （实测表现：站在射程外沿来回挪，一百回合不动手）。
   */
  if (foeEcon === 0) score += 30;

  // 战术倾向：速攻把攻城当唯一出路（破城是这套规则里唯一通向胜利的动作）；
  // 弃城期根本不往对面走。
  //
  // 骚扰这一档**不压攻城**。以前压过 0.25，理由是"围城要站桩、要挨打，那不是消耗"，
  // 听着有道理，实测是净亏：这游戏的胜利条件只有破城，一个不肯围城的 AI 只会
  // 把对局拖长，然后输在对方的第一次破城上。骚扰该做的是"少跟主力换命"，
  // 那一条在上面的野战评分里，不该跑到这儿来否定唯一的胜利路径。
  score *= 1 - 0.45 * mood.driveRaw.boom;

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
  return fieldFromSeeds(s, cityTiles(city), mode);
}

/**
 * 从一堆**任意格子**出发算距离图。
 *
 * 抽出来的原因：无城对局（F1）里没有敌城可当目标，得从"敌方单位所在格"出发。
 * 否则 `distanceFields` 交出一张空表，AI 的"推进"永远算不出值——
 * 实测双方无城时它六百步只动了一次：**不是发呆，是返回了"无动作"**。
 */
export function fieldFromSeeds(
  s: GameState,
  seeds: Array<{ x: number; y: number }>,
  mode: 'land' | 'advance' | 'water' | 'air' = 'land',
): number[] {
  const size = s.w * s.h;
  const dist: number[] = new Array(size).fill(Infinity);
  const queue: Array<{ i: number; cost: number }> = [];

  for (const t of seeds) {
    if (!inBounds(s, t.x, t.y)) continue;
    const i = idx(s, t.x, t.y);
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
  /*
   * 一张敌城都没有（无城对战）时，目标是**敌方部队**。
   *
   * 键用一个不可能和城市 id 撞的字符串；`advanceDistance` 认这个键。
   * 没有这一步，本回合的"该往哪走"整张表是空的，走位候选只剩一条、分数还是负的。
   */
  if (out.size === 0) {
    const foes = enemyUnitsOf(s, me).map((u) => ({ x: u.x, y: u.y }));
    if (foes.length > 0) {
      out.set(VIRTUAL_FOE_FIELD, fieldFromSeeds(s, foes, mode));
    } else {
      /*
       * 连一个敌人都看不见（迷雾 + 双方无城：没有城就没有城提供的视野）。
       *
       * 这时候正确的行为是**去搜**，不是原地不动。目标取"战场中央 + 四个角"：
       * 不需要知道敌人藏在哪（AI 不偷看），只是把部队铺开去找。
       * 少了这一步，实测六百步只动一次——两支军队在雾里互相看不见，就那么站着。
       */
      /*
       * 目标取**战场中央一个点**，不要一次给四五个点。
       *
       * 试过"中央 + 四个角"：每支部队各奔最近的那个点，于是各自在角上站定、
       * 永远碰不到面（实测两边各守一个角，五百多步没动）。
       * 只给中央，双方才会往同一处靠，也就在那里撞上。
       */
      const seeds = [{ x: Math.floor((s.w - 1) / 2), y: Math.floor((s.h - 1) / 2) }];
      out.set(VIRTUAL_FOE_FIELD, fieldFromSeeds(s, seeds, mode));
    }
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
function pickFocusTarget(s: GameState, me: PlayerId, focusCityId: string | null = null): string | null {
  /*
   * 集火目标不只是"战斗单位"。
   *
   * 2026-11-21 用户点出来的：僵持之所以僵，通常是因为**防御建筑或远程单位
   * 看住了那个关口**。只盯着战斗单位，就会一边挨炮一边和步兵对砍。
   * 所以把两类也纳入候选：
   *   · 防御建筑（有攻击、射程 ≥2）：塔/要塞/炮台/地堡，它们才是"看住通道"的东西；
   *   · 会建造的工人：他能补塔、能修桥，是守方把僵持维持下去的手。
   * 但权重按"能打掉多少价值"算：建筑不动、好集火，价值打 0.6 折；
   * 工人本身不值钱，只在贴城时才算数（见下面的贴城加成）。
   */
  const isGuard = (u: { type: string }): boolean => {
    const d = utype(s, u.type);
    if (d.category === 'combat') return true;
    if (d.category === 'building' && (d.atk ?? 0) > 0 && (d.range ?? 0) >= 2) return true;
    if (d.category === 'economy' && (d.builds ?? []).length > 0) return true;
    return false;
  };
  const foes = enemyUnitsOf(s, me).filter(isGuard);
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
    // 建筑不动、好集火；工人本身不值钱，只有"贴着主攻城"时才值得先拔掉
    const discount = def.category === 'building' ? 0.6 : def.category === 'economy' ? 0.35 : 1;
    let worth = (def.cost ?? 50) * discount * (1 + Math.max(0, 1 - f.hp / Math.max(1, def.maxHp)) * 1.5);
    const city = focusCityId ? s.cities.find((c) => c.id === focusCityId) : null;
    if (city && distToCity(f, city) <= 3) worth *= 1.5;
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
   * 过河计划选的渡口（排序层的 `focus`）。null = 这条计划没当值。
   *
   * 和 `bridgeSite` 的区别：`bridgeSite` 是"逐回合重挑的最近水面"，
   * 这个点是**计划钉住的**那一格，建造评分和工程队走位都认它。
   */
  crossingSite: { x: number; y: number } | null;
  /** 排序层合成的净权重（见 ai-plan 的 composeWeights）。默认全 1 */
  weights: PlanWeights;
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
  /** 回撤强度（0~1）：defend 计划给的，不是布尔 */
  pullHome: number;
  /** 不许开火（压 ATTACK/SIEGE）：决战时机判"发展且明显落后"时给 */
  holdFire: boolean;
  /**
   * 本回合的侦查任务：派谁、去哪、看哪座城（`SCOUT_PLAN` 的 `orders`）。
   *
   * null = 这回合不侦查。读它的只有两处：走位（往点上带）与开火（不给候选，
   * 因为潜行一出手就现形）。
   */
  scout: { unitId: string; cityId: string; x: number; y: number } | null;
  /** 顺路观察：只改这个单位的走位目标，不禁攻、不建编队 */
  peek: { unitId: string; x: number; y: number } | null;
  /** 过河分流：某个编队改走第二个渡口（主渡口拥堵时） */
  crossingAlt: { x: number; y: number; unitIds: Set<string> } | null;
  /** 建造编队的走位引导（成员 + 目标点），由 `squadTick` 写回后填入 */
  buildGuide: { x: number; y: number; unitIds: Set<string> } | null;
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
  /**
   * 已经被自己人堵死产兵格的城市（`recruitSpawnCells` 为 0）。
   *
   * 2026-11-21 实测（seed 32，16×16 era3）：第 81 回合起两座城的产兵格都是 0、
   * 城里蹲着 8 个人，之后 140 回合攒到 18900 金，**一个兵都没造出来**。
   * 城格那点回血/护甲换不来"整支军队停摆"，所以这些城里的兵必须让位。
   */
  chokedCities: string[];
  /** 产兵格**少**（< 城格数）的城：让位要一直推到恢复，不是 1 格就停 */
  spawnStarved: string[];
  /** 疏散预订：unitId → 目标空位（每回合算一次，避免各抢各的） */
  yieldPlan: Map<string, { x: number; y: number }>;
  /** 编队成员 → 目标城：编队认编队目标，散兵认全局目标（见 `SQUAD` 那一段） */
  squadTarget: Map<string, string>;
  /** 编队缺口：还在收拢的战斗编队缺几个人。>0 时采购给战斗单位加分（"反馈请求生产端"） */
  squadNeed: number;
  /** 建造编队缺口：有计划要修桥、却没有（或不够）建造编队。>0 时采购给工人加分 */
  builderNeed: number;
  /**
   * 威胁强度（0~1）：敌方 2 回合能摸到城 / 近 6 回合城被打过 / 敌城离我城 ≤6 格。
   * 采购按它压经济、提兵（`aiThreatScale` 开时）。
   */
  threatScale: number;
  /**
   * 发展意愿 y（0~1，来自战略层 `postureBudgetOf`）。
   *
   * 2026-11-21 之前它**算出来没人用**：战略层说"该发展"，采购照样把 97% 的钱
   * 砸进军队（实测一局 4312 : 115）。现在接进采购：经济单位的分数和目标数量
   * 都按它放大（见 `recruitCandidate` 的 `econWeight`）。
   */
  developBias: number;
  /** 最近的自家城：编队打仗时，没编队的散兵回这里守（见走位的 objective） */
  homeCityId: string | null;
  /**
   * 造桥点周围 2 格（**只在真的过不去时**才有内容）。
   *
   * 用户 2026-11-21 的观察：平局局里大批军队堆在桥头，工程队靠不近那一格，
   * 在原地徘徊。规则层不许同格，兵站着工程队就永远进不去。
   *
   * 上一版试过"战斗单位站桥点扣分"，但忘了加 `needBridge` 条件——
   * `bridgeSite` 是"最近的水面"，**任何图上都有值**，于是所有兵在所有图都在躲水面，
   * 全量从 58% 掉到 38%。这次只在真的需要过河时才清场。
   */
  bridgeClear: Set<number>;
  /**
   * 编队成员 → 队形信息（目标城、自己到目标、全队最前/最后、允许的密集度）。
   *
   * 用它替代老的"协同前进"（`aheadOfLine` 比全局战线）：队形该多紧由**编队**定，
   * 不再由一条全图共用的"战线"定。队形在密集度以内就全员推进；超了最前面的停。
   * 这样"跑得快的等跑得慢的"是密集度约束的副产品，不用另写一条。
   */
  squadInfo: Map<string, { cityId: string; lead: number; leadMin: number; leadMax: number; spread: number }>;
  /** 视野里有多少敌方单位带溅射：决定"挨着站"该罚多重 */
  foeSplash: number;
  /** 对面还剩几个经济单位。零 = 纯战斗阵容（见 scoreSiege 的加分与僵持破局） */
  foeEcon: number;
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
   * 局面吃紧（和 `plan.urgent` 同一个口径：兵少于 3 个，或者敌人摸到城下 3 格）。
   *
   * 产业链目标在吃紧时不推进——那时候还在攒"将来的战力"，是拿命换经济。
   */
  urgent: boolean;
  /** 威胁值（`threatLevelOf`）：产业链靠它判断要不要放弃投资 */
  threat: number;
  /** 哪些非金币资源供不上（`scarceResources`）：资源缺口目标靠它决定要不要补产出 */
  scarce: ReadonlySet<string>;
  /**
   * 这一回合在追哪条产业链（`AiCommit`），没有就是 null。
   *
   * 整回合算一次：承诺要写回真状态，而候选生成一回合要跑几百次，
   * 每次现算会变成"同一步里反复改主意"。
   */
  goalCommit: AiCommit | null;
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
function canReachEnemyByLand(s: GameState, owner: PlayerId, onlyCityId?: string): boolean {
  /*
   * `onlyCityId`：只问"能不能走到**这一座**城"。
   *
   * 绕路要用它：换到另一座城之后，那条路可能要过河。按"任意敌城可达"判，
   * 只要最近那座能走到就不架桥，于是换了目标也过不去。
   */
  const foe = s.cities.filter((c) => c.owner !== owner && (!onlyCityId || c.id === onlyCityId));
  if (foe.length === 0) return true;

  /*
   * 判据问的是"**能不能**走过去"，不是"有没有人已经在那儿"。
   *
   * 按现状判有两个毛病（2026-11-21 用户点出来的）：
   *   · 开局还没出兵时队列是空的 → 判"过不去" → 计划立刻想架桥；
   *   · 侦察兵过去又被打死 → 判据来回翻，计划跟着闪烁。
   * 所以从**领地**出发（城市是稳定的锚点，加上在场的陆军），
   * 问"从我的城能不能一路走到敌城边上"。
   *
   * 但纯粹的连通性太宽松：绕过整片湖走 49 步也算"能到"，
   * 而战术层那条走位根本不会去绕（实测 seed 24 因此 0 座桥、261 回合平）。
   * 所以加一道距离上限：**绕一整张图那么远，就等于过不去**。
   * 上限取地图边长——24×24 上 24 步、12×12 上 12 步，随图缩放。
   */
  const limit = Math.min(s.w, s.h);
  const dist = new Map<number, number>();
  const queue: number[] = [];
  const seed = (x: number, y: number): void => {
    if (!inBounds(s, x, y)) return;
    const i = y * s.w + x;
    if (dist.has(i)) return;
    dist.set(i, 0);
    queue.push(i);
  };
  /*
   * 种子**只放城市**，不放"在场的陆军"。
   *
   * 2026-11-21：放陆军当种子会让这条判据随"侦察兵跑到对岸又被打死"来回翻——
   * 一翻 `done` 就真、过河计划退场、口袋丢掉、'桥被拆几次'的计数从头开始
   * （实测 seed 34 一局桥被拆 11 次还在修）。城市是稳定的锚点，够用了。
   */
  for (const c of citiesOf(s, owner)) for (const t of cityTiles(c)) seed(t.x, t.y);
  if (queue.length === 0) return false;

  for (let i = 0; i < queue.length; i++) {
    const k = queue[i]!;
    const d = dist.get(k)!;
    if (d > limit) return false; // 剩下的一定更远，没必要再走
    const x = k % s.w;
    const y = Math.floor(k / s.w);
    if (foe.some((c) => distToCity({ x, y }, c) <= 1)) return true;

    for (const [dx, dy] of DIRS) {
      const nx = x + dx;
      const ny = y + dy;
      if (!inBounds(s, nx, ny)) continue;
      const j = ny * s.w + nx;
      if (dist.has(j)) continue;
      const t = s.tiles[j];
      if (!t || !passable(t.terrain)) continue;
      // 敌城格不可通行，但"摸到它旁边"上面已经判过了
      if (t.cityId) {
        const c = cityById(s, t.cityId);
        if (c && c.owner !== owner) continue;
      }
      dist.set(j, d + 1);
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

/* ---------------- 决战时机：投影对比（2026-11-21） ---------------- */

/**
 * 一次"现在该打还是该等"的判断结果。
 *
 * 判据用**投影**而不是现状（S4 的校准：现状战力比在中局只有 50% 命中，
 * 产能投影是 88%）：两边各算"到第 T 回合我会有多强"，再看比值怎么变。
 */
export interface DecisiveCall {
  /** 主力走到最近敌城要几回合（按路程代价 ÷ 移动力） */
  marchTurns: number;
  cityId: string | null;
  myPower: number;
  foePower: number;
  myPerTurn: number;
  foePerTurn: number;
  /**
   * 投影比：**主力抵达那一刻**我方 ÷ 对面（含各自的产能投资）。
   *
   * 这是判决唯一的输入。语义 2026-11-21 从"远景"改成"抵达"——远景比值会把
   * "趁对面还没补兵"算成优势，于是没兵的时候也说打得动。
   */
  ratio: number;
  /** 抵达后 12 回合内能否够打：0 = 抵达即够；12 = 再攒 12 回合；-1 = 都够不上 */
  readyTurns: number;
  /** 抵达与"抵达 + 12"里较高的那个比值，以及它出现在第几回合——"等下去会不会更好" */
  peakRatio: number;
  peakTurns: number;
  /**
   * 记忆里"看不见但记得"的敌方战力（`0.85^age`，8 回合清零）。
   *
   * 阶段 1a：先只算出来写进日志，**不进任何判决**——这样能先验证"接入是否正确、
   * 一个 AI 回合里记忆有多厚"，而行为一个字不变（跑批逐局一致）。
   */
  rememberedPower: number;
  rememberedCount: number;
  /** 对主攻目标守军的情报置信度（0~1），见 `intelConfOf` */
  intelConf: number;
  why: string;
}

/** @tune 记忆衰减系数（每回合）：用户 2026-11-22 拍 0.85，未标定 */
const MEMORY_DECAY = 0.85;
/** @tune 记忆有效期（回合）：超过就当忘了，同样是拍的 */
const MEMORY_MAX_AGE = 8;

/**
 * 把记忆里"此刻看不见"的敌方单位折算成战力。
 *
 * 为什么要有它：`armyStrength(view, p)` 只算**当前可见**的单位，看不见的一律当 0。
 * 阶段 0 实测（第四十六节之后）迷雾视角的投影比中位高估 0.67，就是这么来的。
 * 而 `playerView` 其实一直给了 `ghosts`（认得的敌方单位，带 `seenAt`），AI 从没读过。
 *
 * 三条口径：
 *   · 按 `0.85^age` 衰减——"十分钟前看到六个兵"不能和"刚才看到六个"等价；
 *   · `age > 8` 归零——再久就是猜，不如承认不知道；
 *   · 只算战斗单位、不含水军——和 `armyStrength` 的口径**保持一致**，
 *     否则"记得的"和"看见的"不是同一把尺子。
 *
 * 血量未知（`KnownUnit` 没有 hp），按满血算——这是乐观的一侧，衰减负责抵消一部分。
 */
export function rememberedPowerOf(
  ghosts: readonly KnownUnit[],
  turn: number,
  unitTypes: Record<string, UnitTypeDef>,
): { power: number; count: number } {
  let power = 0;
  let count = 0;
  for (const g of ghosts) {
    const age = Math.max(0, turn - g.seenAt);
    if (age > MEMORY_MAX_AGE) continue;
    const def = unitTypes[g.type];
    if (!def || def.category !== 'combat' || def.domain === 'water') continue;
    power += unitPower(def) * Math.pow(MEMORY_DECAY, age);
    count += 1;
  }
  return { power, count };
}

/** @tune 目标城周围多大一圈算"守军区域"（切比雪夫距离）：5 是拍的 */
const INTEL_RADIUS = 5;

/**
 * 对主攻目标"守军"的情报置信度（0~1）。
 *
 * 只回答一件事：**我对这座城周围有多少敌人，是看见的、还是猜的？**
 *   · 此刻看得见那片有敌方单位 → 1；
 *   · 只有记忆（`ghosts`）→ 按最近一次看到的时间折：`1 − age/8`；
 *   · 什么都没有 → 0。
 *
 * 为什么用"城周围 5 格"而不是"城格"：守军经常站在城边或城墙外，
 * 只数城格会把"看得见守军"误判成 0。
 *
 * 为什么不做成"区域最后一次可见"：现在的记忆只存**单位**和**城市快照**，
 * 没有"这块地多久没看了"。用单位代理是当下唯一不需要新存档字段的做法。
 */
function intelConfOf(
  view: GameState,
  me: PlayerId,
  city: City | null,
  ghosts: readonly KnownUnit[],
): number {
  if (!city) return 0;
  const near = (u: { x: number; y: number }): boolean =>
    Math.max(Math.abs(u.x - city.x), Math.abs(u.y - city.y)) <= INTEL_RADIUS;
  if (view.units.some((u) => u.owner !== me && near(u))) return 1;
  let bestAge = Infinity;
  for (const g of ghosts) {
    if (!near(g)) continue;
    bestAge = Math.min(bestAge, Math.max(0, view.turn - g.seenAt));
  }
  if (!Number.isFinite(bestAge)) return 0;
  return Math.max(0, Math.min(1, 1 - bestAge / MEMORY_MAX_AGE));
}

/** 投影比到这个数就算"打得动" */
const DECISIVE_AT = 1.15;
/** 从"等"转"打"的门槛：比首次判决更高，防止在阈值边上反复横跳 */
const DECISIVE_SWITCH = 1.3;

/** 往后看多少回合（只用来回答"再等等会不会更好"） */
const DECISIVE_LATE = 12;

/**
 * 扫描结果缓存：**按局面对象**记，不按"回合+数字指纹"记。
 *
 * `aiNextActionCoreInner` 每出一个动作就会走到这里（一回合十几次），
 * 而扫描是上百次求解器调用。同一份 `GameState` 对象内的重复调用结论必然一样。
 *
 * 为什么不用指纹（2026-11-21 踩过）：`simSteps` 的递归推演会拿**同一回合、
 * 同一席位、战力金钱也相近**的另一个局面走到这里，指纹会撞上——
 * 真实局面读到推演局面的判决，行为随即分叉（实测同一牌局从 29 回合变成 34 回合）。
 * 用 `WeakMap<GameState, ...>` 按对象身份分桶，推演局面天然不共享。
 */
const decisiveMemo = new WeakMap<
  GameState,
  Map<PlayerId, { ratio: number; readyTurns: number; peakRatio: number; peakTurns: number }>
>();

/**
 * 决战时机：现在打，还是等产能把自己堆起来。
 *
 * 人的思路是三条比大小：
 *   1. **现在打得动吗**：抵达时刻的投影比 ≥ 1.15 且行军回合不太远 → 打；
 *   2. **等下去会更有利吗**：我的每回合产能比对面厚 → 等（投资会复利）；
 *   3. 都不成立 → 守（不主动推，但也别自杀）。
 *
 * ── 为什么是"扫 T"而不是拍一个 horizon（2026-11-21）──────────────
 *
 * 旧版取 `horizon = clamp(marchTurns × 2, 12, 40)`，一个数同时决定了两件事：
 * 判决用的比值、以及"我在替哪个时刻做打算"。取早了看不见投资复利（判成打不动），
 * 取晚了把二十回合后的事当成现在（判成打得动）——两种错都实测出现过：
 * 38 回合的负局是前者，261 回合的平局是后者。
 *
 * 现在把起点钉在**主力抵达那一刻**（t0 = 行军回合），并往后看一个点
 * （`t0 + 12`）回答"再等等会不会更好"：
 *   · `ratio`（t0 处）：抵达时够不够——这是"现在打不打"的唯一依据；
 *   · `readyTurns` / `peak`：还差几回合、等下去最好能到多少——给日志和人看，
 *     也是以后"等到第几回合再打"（而不是二选一）的接口。
 *
 * 为什么不细扫（2026-11-21）：实测峰值几乎总落在起点，13 点的细扫只把完整测试
 * 从几分钟拖到 20 分钟以上，判决一个字都没变。
 */
function decisiveOf(
  view: GameState,
  me: PlayerId,
  land: Map<string, number[]>,
  ghosts: readonly KnownUnit[] = [],
): DecisiveCall | null {
  const foes = view.cities.filter((c) => c.owner !== me && !c.ruined);
  if (foes.length === 0) return null;

  // 行军回合：从我的战斗单位到每一座敌城的最小路程，取最近的那座
  let bestCost = Infinity;
  let cityId: string | null = null;
  const move = Math.max(
    1,
    ...unitsOf(view, me)
      .filter((u) => utype(view, u.type).category === 'combat')
      .map((u) => utype(view, u.type).move ?? 1),
  );
  const myCombat = unitsOf(view, me).filter((u) => utype(view, u.type).category === 'combat');
  for (const [cid, field] of land) {
    if (!foes.some((c) => c.id === cid)) continue;
    let minCost = Infinity;
    for (const u of myCombat) minCost = Math.min(minCost, field[u.y * view.w + u.x] ?? Infinity);
    if (minCost < bestCost) {
      bestCost = minCost;
      cityId = cid;
    }
  }
  const marchTurns = Number.isFinite(bestCost) ? Math.ceil(bestCost / move) : 99;

  const myPower = armyStrength(view, me);
  const remembered = rememberedPowerOf(ghosts, view.turn, view.unitTypes);
  let foePower = 0;
  for (const p of new Set(view.cities.filter((c) => c.owner !== me).map((c) => c.owner))) {
    foePower += armyStrength(view, p);
  }
  /*
   * 记忆计入分母（阶段 1b）。
   *
   * 口径：`可见部队 + 记得的部队 × 0.85^age`。这是"我现在对敌方兵力的最好估计"，
   * 而不是"我看见了多少"——后者会把整片雾里的部队当成 0（阶段 0 实测中位高估 0.67）。
   *
   * 多人局的不精确要知道：`ghosts` 不区分席位（`KnownUnit` 没有 owner），
   * 所以记忆战力全算在主对手头上。双人局（当前所有基准对局）下完全等价。
   */
  foePower += remembered.power;
  const myPerTurn = powerPerTurn(view, me);
  const foePerTurn = Math.max(
    1,
    ...[...new Set(view.cities.filter((c) => c.owner !== me).map((c) => c.owner))].map((p) =>
      powerPerTurn(view, p),
    ),
  );

  /*
   * 投影用**战力求解器**，不再拿"每回合产能"线性外推。
   *
   * 外推假设"一直在造兵"，而人会先投经济再暴兵——两者在 10 回合以上的
   * 尺度上差得很多（求解器会自己挑"投到第几回合停止投资"）。
   * 对面的输入用可见信息拼：看不见的钱/格子会低估它，这是刻意的保守。
   */
  const foeSeat = [...new Set(view.cities.filter((c) => c.owner !== me).map((c) => c.owner))][0];
  /*
   * 扫描起点＝**主力抵达那一刻**（`marchTurns`），不再是旧版的 `marchTurns × 2`。
   *
   * 旧公式取的是"路上再走一倍时间"的远景比值：它把"趁对面还没补兵"算成优势，
   * 却看不见"我到了城下时还剩多少兵"。改成抵达之后（2026-11-21，对手固定为
   * `ai-9efb961`）：Q2 4-2 → 6-0，全量 16-5-3 → 17-5-2，配对 2 改善 / 2 变差 / 20 相同。
   *
   * 为什么不再加"下限 12"：试过，Q1 从 4-2 掉到 3-3——小图上 2~3 回合就到城下，
   * 非说"12 回合后"等于又把窗口拉回远景。
   */
  const t0 = Math.max(1, Math.min(40, marchTurns));

  let bucket = decisiveMemo.get(view);
  if (!bucket) {
    bucket = new Map();
    decisiveMemo.set(view, bucket);
  }
  let scan = bucket.get(me);
  if (!scan) {
    /*
     * **按需扫两点**，不是固定扫一串。
     *
     * 判决只看抵达那一刻；再往后的点只回答"等到 `DECISIVE_LATE` 回合会不会更好"。
     * 所以：已经够打就不必往后看（多算一分钱不值）；不够打才看第二点。
     *
     * 为什么不做 13 点的细扫：实测（第四十六节）峰值几乎总在起点，细扫只增加
     * 求解器调用——完整测试从几分钟涨到 20 分钟以上，收益是零。
     */
    const atArrival = powerRace(view, me, foeSeat ?? null, [t0], remembered.power)[0];
    let peak = atArrival;
    let readyTurns = atArrival.ratio >= DECISIVE_AT ? 0 : -1;
    if (readyTurns !== 0) {
      const late = powerRace(view, me, foeSeat ?? null, [t0 + DECISIVE_LATE], remembered.power)[0];
      if (late.ratio > peak.ratio) peak = late;
      if (late.ratio >= DECISIVE_AT) readyTurns = DECISIVE_LATE;
    }
    scan = {
      ratio: atArrival.ratio,
      readyTurns,
      peakRatio: peak.ratio,
      peakTurns: peak.turns,
    };
    bucket.set(me, scan);
  }

  const ratioNow = scan.ratio;
  const intelConf = intelConfOf(view, me, view.cities.find((c) => c.id === cityId) ?? null, ghosts);
  const wait =
    scan.readyTurns === 0
      ? '抵达即够打'
      : scan.readyTurns > 0
        ? `还要攒 ${scan.readyTurns} 回合`
        : `再等 ${DECISIVE_LATE} 回合也够不上`;

  return {
    marchTurns,
    cityId,
    myPower,
    foePower,
    myPerTurn,
    foePerTurn,
    ratio: ratioNow,
    readyTurns: scan.readyTurns,
    peakRatio: scan.peakRatio,
    peakTurns: scan.peakTurns,
    rememberedPower: remembered.power,
    rememberedCount: remembered.count,
    intelConf,
    why:
      `投影比 ${scan.peakRatio.toFixed(2)}@${scan.peakTurns}（抵达 ${t0} 回合后 ${ratioNow.toFixed(2)}）、` +
      `行军 ${marchTurns} 回合、${wait}、记得 ${remembered.count} 个(${Math.round(remembered.power)})、` +
      `情报 ${intelConf.toFixed(2)}`,
  };
}

/* ---------------- 只读探针：迷雾 vs 全图的决战比值差（阶段 0） ---------------- */

/**
 * 同一局面、两种视角下决战判据差多少。
 *
 * **只给 `probe:intel` 用，不参与任何决策。** 它回答的是一个先后顺序问题：
 * "看不见"到底把决战判断歪曲了多少？如果这个差很小，做侦查就是白工——
 * 该去查采购/编队，而不是加一条侦察计划。
 *
 * 为什么把全图视角叫"作弊视角"：`playerView(s, me, true)` 会把所有单位、城市、
 * 建筑都下发。它不代表任何合法玩家能看到的东西，只是"如果 AI 什么都知道"的上界。
 * 真实可达到的上界是"侦查把该看的都看了"，但那已经接近这个数。
 */
export function decisiveViewGap(
  s: GameState,
  me: PlayerId,
): { fogged: DecisiveCall; full: DecisiveCall } | null {
  const build = (pv: PlayerView): DecisiveCall | null => {
    const view = pv.state;
    const wade = distanceFields(view, me, 'advance');
    const land = new Map<string, number[]>();
    for (const [id, field] of distanceFields(view, me, 'land')) {
      land.set(id, mergeAdvanceField(field, wade.get(id) ?? []));
    }
    return decisiveOf(view, me, land, pv.ghosts);
  };
  const fogged = build(playerView(s, me));
  const full = build(playerView(s, me, true));
  return fogged && full ? { fogged, full } : null;
}

/**
 * 选渡口：**从两岸的陆地场往回找**，取"我这边 + 对面"总步数最小的那块水面。
 *
 * 为什么不用现成的 `bestBridgeSite`：它是逐格打分（窄、离我近、对岸离敌城近），
 * 分数里没有"这块水到底连不连得通"。实测它会挑湖心的一格，铺几段之后
 * 连不上了就返回 null，计划当场丢掉（2026-11-21，seed 11 / 24×24）。
 *
 * 这里的判据是可验的：两个洪泛（我方陆地 / 敌方陆地）都够得到的水面，
 * 才是"一条能走通的渡口"。找不到就是这张图真的过不去，返回 null。
 */
function crossingPointOf(
  view: GameState,
  me: PlayerId,
  avoid?: { x: number; y: number },
): { x: number; y: number } | null {
  const flood = (
    seeds: Array<{ x: number; y: number }>,
    throughWater: boolean,
  ): Map<number, number> => {
    const dist = new Map<number, number>();
    const queue: number[] = [];
    for (const p of seeds) {
      if (!inBounds(view, p.x, p.y)) continue;
      const k = p.y * view.w + p.x;
      if (dist.has(k)) continue;
      dist.set(k, 0);
      queue.push(k);
    }
    for (let i = 0; i < queue.length; i++) {
      const k = queue[i]!;
      const d = dist.get(k)!;
      const x = k % view.w;
      const y = Math.floor(k / view.w);
      for (const [dx, dy] of DIRS) {
        const nx = x + dx;
        const ny = y + dy;
        if (!inBounds(view, nx, ny)) continue;
        const nk = ny * view.w + nx;
        if (dist.has(nk)) continue;
        const tile = view.tiles[nk];
        if (!tile || tile.terrain === 'bridge') continue;
        const wet = tile.terrain === 'water' || tile.terrain === 'deep';
        // 陆地洪泛只走旱地（浅滩按"能涉水"算可走）；对岸洪泛要能穿过水面，
        // 否则六格宽的湖永远没有一格"两侧都是陆地"，渡口被判成不存在。
        if (wet && !throughWater) continue;
        if (!wet && !passable(tile.terrain)) continue;
        dist.set(nk, d + 1);
        queue.push(nk);
      }
    }
    return dist;
  };

  const myLand = flood(
    unitsOf(view, me).filter((u) => utype(view, u.type).domain !== 'water').map((u) => ({ x: u.x, y: u.y })),
    false,
  );
  const fromFoe = flood(
    view.cities.filter((c) => c.owner !== me && !c.ruined).flatMap((c) => cityTiles(c).map((t) => ({ x: t.x, y: t.y }))),
    true,
  );
  if (myLand.size === 0 || fromFoe.size === 0) return null;

  /*
   * 渡口取"我方岸上那一格水面里，离对岸最近的那一块"。
   *
   * 为什么不是取两岸中间那一格：工程队是从自己岸边往外铺的，
   * 目标必须落在它能开始的那一头；中间的格子只对"这条线有多长"有意义。
   */
  let best: { x: number; y: number } | null = null;
  let bestScore = Infinity;
  for (let y = 0; y < view.h; y++) {
    for (let x = 0; x < view.w; x++) {
      const k = y * view.w + x;
      const tile = view.tiles[k];
      if (!tile || (tile.terrain !== 'water' && tile.terrain !== 'deep')) continue;
      const dFoe = fromFoe.get(k);
      if (dFoe === undefined) continue;
      let onMyBank = false;
      for (const [dx, dy] of DIRS) {
        const nx = x + dx;
        const ny = y + dy;
        if (!inBounds(view, nx, ny)) continue;
        if (myLand.has(ny * view.w + nx)) {
          onMyBank = true;
          break;
        }
      }
      if (!onMyBank) continue;
      // 分流用：离已用的渡口太近就不算"另一个渡口"（两座桥挨着等于一座）
      if (avoid && Math.max(Math.abs(x - avoid.x), Math.abs(y - avoid.y)) < 6) continue;
      if (dFoe < bestScore) {
        bestScore = dFoe;
        best = { x, y };
      }
    }
  }
  return best;
}

/**
 * 过河投送计划（P3 起由排序层管）。
 *
 * 它是**权重型**：不产生动作，只做两件事——
 *   1. 把渡口钉住（`focus`，存进自己的口袋，下一回合优先沿用）；
 *   2. 让建造评分和工程队走位都围着这一格转（靠 `fields.crossingSite` 传下去）。
 *
 * 三个"给桥让路"的老补丁（两道数量上限、工程队 mine<6 闸）现在都读这个点，
 * 而不是各读各的 `focusOf().crossing`。
 */
/**
 * 战略姿态：把"打不打"和"钱花在哪"压成两个连续的维度。
 *
 * 这是 2026-11-21 用户提的模型：战略上其实只有两件事要定——
 *   · x = 派不派兵进攻（0 完全不推，1 全力压上）
 *   · y = 钱花在发展上还是军费上（0 全买兵，1 全投经济）
 * 四个角：x高y高=散兵骚扰后方发展、x低y高=全力发展、
 * x高y低=全力进攻、x低y低=全力防守。
 *
 * 它只做一件事：把 (x,y) 换算成权重。**不在别处再判一次"该不该打"**——
 * 两处都判就会互相打脸（走位往东、采购往西）。
 *
 * 为什么不做成"发展/进攻/防守"三条独立计划：那等于用两条通路表达同一个决定，
 * 排序层会同时让它们当值、权重互相抵消。姿态是**一个连续的控制器**，
 * 不是一个要投票的表决项。
 */
function postureOf(c: PlanCtx): { x: number; y: number; why: string } {
  const t = PLAN_TUNING.posture;
  // x：兵力比。0.8 以下不敢打，1.6 以上敢打
  const ratio = c.army / Math.max(1, c.foeArmy);
  const x = clamp01((ratio - t.xAtLow) / Math.max(0.01, t.xAtHigh - t.xAtLow));
  // y：时代落后、收入低、局面吃紧，都往"发展"那边推
  const eraGap = c.foeEra - c.era;
  let y = 0.45 + 0.22 * eraGap + (c.income < 22 ? 0.15 : 0) - Math.min(0.45, c.threat / 260);
  y = clamp01(y);
  return { x, y, why: `x=${x.toFixed(2)}(兵力比 ${ratio.toFixed(2)}) y=${y.toFixed(2)}(差 ${eraGap} 代)` };
}

const POSTURE_PLAN: RankedPlan = {
  id: 'posture',
  kind: 'weights',
  strength: 1,
  // 默认关：见 types.ts 的 `aiPosture`（三档区间都把胜局变成平局）
  value: (c) => (c.view.config.aiPosture === true ? 1 : 0),
  done: () => false,
  weights: (c) => {
    const t = PLAN_TUNING.posture;
    const { x, y } = postureOf(c);
    return {
      attack: t.attackBase + t.attackSlope * x,
      econ: t.econBase + t.econSlope * y,
      build: 1,
      save: y > 0.6 ? 1.1 : 0.9,
    };
  },
};
registerAiPlan(POSTURE_PLAN);

/* ---------------- 僵持 → 屯兵（2026-11-21） ---------------- */

/**
 * 僵持指数：我方战斗单位到最近敌城的"中位距离"连续几回合没缩小。
 *
 * 为什么用中位数而不是"最靠前那个兵"：一个侦察兵冲进去又被打死，
 * 最小值会来回跳；中位数代表**整支部队**有没有整体压上去。
 *
 * 每回合只更新一次（`keep.stallTurn` 去重）——`value` 每步决策都会被调，
 * 不去重会把同一回合算十几次，计数直接失真。
 */
/* ---------------- 编队：组建 / 出发 / 解散 + 上报（2026-11-21） ---------------- */

/** 伤亡超过这个比例就解散：人快打光了还不散，等于把残兵拖死 */
const SQUAD_DISBAND_RATIO = 0.4;
/** 收拢最多等几回合：凑不够也走，否则钱一紧就永远不出兵 */
const SQUAD_FORM_TIMEOUT = 10;

/**
 * 战略层的最小版：把"进攻 / 发展"两个意愿换成**配额**（不是乘数）。
 *
 * P4 试过做成 `attack` 乘数，三次调参都把胜局调成平局——乘数太钝，
 * 只能让"已经在打的更凶"，改变不了"打不打"。
 *
 * 配额是硬的，而且编队直接吃它：
 *   · x 高 → 编队大（4~12 人）、可以两支并行、队形更密；
 *   · x 低 → 编队小、只准一支、队形更散（守/牵制的形态）。
 *
 * 仍然只有两个维度（用户的原模型）：x = 打不打，y = 钱花在发展还是军费。
 * y 目前只用来定"经济单位的相对偏好"，还没做成预算硬上限。
 */
/**
 * 威胁强度（0~1）。三个信号，越齐越高（用户 2026-11-22 的方案）：
 *
 *   a. 视野内敌方战斗单位 **2 回合**能摸到我家城（`2×move + range-1`）；
 *   b. 最近 6 回合我家城被打过（`keep.cityHitTurn`，见下面的 hp 比较）；
 *   c. 敌城离我家城 ≤6 格（地图刷新就可能"贴着开"）。
 *
 * 只读我方可见信息，不看全图。
 */
function threatScaleOf(
  view: GameState,
  me: PlayerId,
  keep: Record<string, unknown>,
): number {
  const myCities = citiesOf(view, me).filter((c) => !c.ruined);
  if (myCities.length === 0) return 1;
  let reachable = false;
  for (const u of enemyUnitsOf(view, me)) {
    const d = utype(view, u.type);
    if (d.category !== 'combat') continue;
    const reach = 2 * Math.max(1, d.move ?? 1) + Math.max(0, (d.range ?? 1) - 1);
    if (myCities.some((c) => distToCity(u, c) <= reach)) {
      reachable = true;
      break;
    }
  }
  const hitRecent = view.turn - Number(keep.cityHitTurn ?? -99) <= 6;
  let close = false;
  for (const fc of view.cities) {
    if (fc.owner === me || fc.ruined) continue;
    if (myCities.some((mc) => distToCity(fc, mc) <= 6)) {
      close = true;
      break;
    }
  }
  return Math.min(1, (reachable ? 0.4 : 0) + (hitRecent ? 0.3 : 0) + (close ? 0.3 : 0));
}

function buildYieldChain(
  view: GameState,
  me: PlayerId,
): Array<{ id: string; x: number; y: number }> {
  const city = citiesOf(view, me).find((c) => {
    if (c.ruined) return false;
    if (spawnCellCountOf(view, c) >= c.size * c.size) return false;
    return cityTiles(c).some((t) => {
      const u = unitAt(view, t.x, t.y);
      if (!u || u.owner !== me) return false;
      const d = utype(view, u.type);
      return d.category === 'economy' || d.category === 'builder';
    });
  });
  if (!city) return [];
  /*
   * 找**最远**空地，不是最近。
   *
   * 找最近时链很短（城格 → 2 格外的农 → 空地），外圈的人不参与，
   * 里层的人挪一步又撞上外圈——一次只能清一列、还要好几回合。
   * 找最远（半径 8 内）会把整列人都串进链，一次把这一列整体外移。
   */
  const starts = cityTiles(city).map((t) => t.y * view.w + t.x);
  const prev = new Map<number, number>();
  const dist = new Map<number, number>();
  const seen = new Set<number>(starts);
  const q: number[] = [...starts];
  for (const k of starts) dist.set(k, 0);
  let end = -1;
  let endD = -1;
  for (let i = 0; i < q.length; i++) {
    const k = q[i]!;
    const d = dist.get(k)!;
    if (d > 8) continue;
    const x = k % view.w;
    const y = Math.floor(k / view.w);
    for (const [dx, dy] of DIRS) {
      const nx = x + dx;
      const ny = y + dy;
      if (!inBounds(view, nx, ny)) continue;
      const nk = ny * view.w + nx;
      if (seen.has(nk)) continue;
      const t = view.tiles[nk];
      if (!t || t.terrain === 'city') continue;
      const u = unitAt(view, nx, ny);
      if (u && u.owner !== me) continue;
      seen.add(nk);
      prev.set(nk, k);
      dist.set(nk, d + 1);
      if (!u) {
        if (d + 1 > endD) {
          endD = d + 1;
          end = nk;
        }
      } else {
        q.push(nk);
      }
    }
  }
  if (end < 0) return [];
  // 回溯：path[0] = 空地，path[last] = 城格
  const path: number[] = [end];
  let k = end;
  while (prev.has(k)) {
    k = prev.get(k)!;
    path.push(k);
  }
  const chain: Array<{ id: string; x: number; y: number }> = [];
  for (let i = 1; i < path.length; i++) {
    const kk = path[i]!;
    const u = unitAt(view, kk % view.w, Math.floor(kk / view.w));
    if (!u || u.owner !== me) continue;
    const tk = path[i - 1]!;
    chain.push({ id: u.id, x: tk % view.w, y: Math.floor(tk / view.w) });
  }
  // chain 已按"离空地近 → 远"排列（path 从 end 往回），即执行顺序
  return chain;
}

function postureBudgetOf(
  s: GameState,
  me: PlayerId,
): { x: number; y: number; squadCap: number; spread: number } {
  const mine = unitsOf(s, me).filter((u) => utype(s, u.type).category === 'combat').length;
  let foe = 0;
  for (const u of s.units) {
    if (u.owner !== me && utype(s, u.type).category === 'combat') foe += 1;
  }
  const eraOf = (p: PlayerId): number =>
    Math.max(1, ...s.cities.filter((c) => c.owner === p && !c.ruined).map((c) => c.era));
  const foeEra = Math.max(1, ...[...new Set(s.cities.filter((c) => c.owner !== me).map((c) => c.owner))].map(eraOf));
  const ratio = mine / Math.max(1, foe);
  /*
   * 距离曾在这里参与过（"敌人就在旁边 → 该打"）：实测全量 58% → 50%（配对 −2），
   * 所以撤掉了。**不是方向错，是时机错**——它让 AI 更早决战，而那时候兵力还不够。
   * 要让它生效，得先有"兵力够不够打"的判断（战力求解器的投影），否则只是提前送。
   */
  // 0.7 以下不敢打，1.6 以上敢打
  const x = Math.min(1, Math.max(0, (ratio - 0.7) / 0.9));
  // 落后越多越想发展
  const y = Math.min(1, Math.max(0, 0.45 - 0.2 * (foeEra - eraOf(me))));
  return {
    x,
    y,
    /*
     * 6~14 人：这是**总配额（上限）**，不是每支编队的规模。
     *
     * 每支编队要几个人由计划层申报（`orders.needSquad`）：突破 12、屯兵 8、
     * 过河 6、守城 5。战略层只决定"这一波总共准你投多少人"。
     *
     * 下限 6 是实测出来的：4 人的编队打不动一座有守军的城（Q4 从 5-1-0 掉到 2-3-1）。
     */
    squadCap: Math.round(6 + 8 * x),
    // 越激进越密集（主力互相掩护）；不想打时散开（少挨溅射、便于牵制）
    spread: Math.round(6 - 3 * x),
  };
}

/**
 * 每回合维护编队：清理 → 组建 → 出发。
 *
 * 2026-11-21 用户重新定义了编队（否掉了"按到主攻城的死距离分段"那一版）：
 *
 * > 计划层会尝试组建一个进攻编队，收拢符合条件的现存无编队单位；不够就反馈
 * > 请求生产端生产合适的单位；组建好就出发；后方可以继续组建下一个，
 * > 但这个组建好的编队就出发，直到全部阵亡 / 收到撤退 / 死伤过重就取消。
 *
 * 关键差别：
 *   · **成员固定**（编成时锁定），不再每回合按距离重新分段——
 *     分段那套在 32×32 上所有人都是"后队"，高时代射程远时"后队"和前队一样能打；
 *   · **队形用相对数**（最前和最后差几格），不用"离城的绝对距离"；
 *   · **可以有缺口**：人不够就先攒着，缺口报给生产端。
 */
/** @tune 建造编队：桥通了之后待机几回合再解散（防拆了又修、修了又拆） */
const BUILD_IDLE_TURNS = 3;

function squadTick(
  s: GameState,
  me: PlayerId,
  planCityId: string | null,
  /** 计划层申报的编队规模（见 `PlanOrders.needSquad`）。不写就用战略默认 */
  planNeed?: number,
  /** 建造编队的目标点（见 `PlanOrders.buildPoint`）。null = 这回合不修桥 */
  buildPoint?: { x: number; y: number } | null,
): { reports: AiSquadReport[]; squadNeed: number; builderNeed: number } {
  const budget = postureBudgetOf(s, me);
  const focus = focusOf(s, me);
  /*
   * 正在执行侦查任务的那个兵不参加编队。
   *
   * 不排除的话，`SCOUT_PLAN` 前脚把它派出去、`squadTick` 后脚把它编进主攻队，
   * 于是编队永远少一人、斥候被"编队目标"带着往城下冲（而且它还不许开火）。
   */
  const scoutId =
    (focus.plan?.keep as { scout?: { unitId?: string | null } } | undefined)?.scout?.unitId ?? null;
  const combat = unitsOf(s, me).filter(
    (u) =>
      utype(s, u.type).category === 'combat' &&
      utype(s, u.type).domain !== 'water' &&
      u.id !== scoutId,
  );
  const byId = new Map(combat.map((u) => [u.id, u]));
  const foes = s.cities.filter((c) => c.owner !== me && !c.ruined);

  // 1) 清理：成员死了、伤亡过重、或者已经没有敌城可打
  const kept: AiSquad[] = [];
  /*
   * 建造编队单独一支池子（2026-11-22）：它们不参加"收拢 → 凑够 want → 出发"，
   * 目标是**一个点**（渡口），人数固定 2，1 个人也出发。
   * 不分开的话，`want` 那套会把 2 人编队当成"永远没凑够"，永远不开拔。
   */
  const buildIn = (focus.squads ?? []).filter((sq) => sq.role === 'build');
  const combatIn = (focus.squads ?? []).filter((sq) => sq.role !== 'build');
  for (const sq of combatIn) {
    // 先 `Set` 去重：同一回合若 `squadTick` 被重复调用（`keep` 丢失时会发生），
    // 成员 id 会被重复 push，报告里就出现"20 人"的编队（实际 12 人）。
    // 去重 + **硬截断到 want**：实测长局里出现 31 人的编队（`squadTick` 在
    // keep 丢失时会被同一回合重复调用），挤成一团还拖慢行军。
    const alive = [...new Set(sq.memberIds)].filter((id) => byId.has(id)).slice(0, Math.max(1, sq.want));
    const ratio = alive.length / Math.max(1, sq.want);
    if (alive.length === 0 || ratio < SQUAD_DISBAND_RATIO || foes.length === 0) continue;
    kept.push({ ...sq, memberIds: alive });
  }

  // 2) 组建：把"没编队"的单位拢成一支。已有正在收拢的那支就不再开新的
  const assigned = new Set(kept.flatMap((sq) => sq.memberIds));
  const free = combat.filter((u) => !assigned.has(u.id));
  const forming = kept.find((sq) => sq.role === 'attack' && sq.state === 'forming') ?? null;
  if (s.config.aiSquad !== false && forming && free.length > 0) {
    /*
     * 正在收拢的编队**持续吸收新造出来的单位**，直到凑够 `want` 才出发。
     *
     * 不吸收的话就会出现实测那种"走 2 人"：编成时手头只有 3 个兵，
     * 之后就再也补不进来，队伍一直是残的。
     */
    // 只补到 want：不封顶的话会吸收成 20 人的巨型编队（实测 Q2 seed32 出现过）
    const room = Math.max(0, forming.want - forming.memberIds.length);
    forming.memberIds.push(...free.slice(0, room).map((u) => u.id));
  } else if (
    s.config.aiSquad !== false &&
    !forming &&
    /*
     * 不限制支数（2026-11-22 用户决定，实测 18-3-3 优于基线的 17-3-4）。
     *
     * 以前固定 `maxSquads = 2`，55 个兵时只有 2 支编队、其余 40 多个散兵——
     * "限制支数防散兵线"的结果是散兵更多。现在靠"每支 want（5~9）+
     * 建队要 3 个散兵"约束，每回合最多新建一支（`forming` 互斥）。
     */
    free.length >= 3 &&
    foes.length > 0
  ) {
    kept.push({
      id: `atk-${(s.aiFocus?.[me]?.squads ?? []).length + 1}-${s.turn}`,
      role: 'attack',
      state: 'forming',
      memberIds: free.map((u) => u.id),
      targetCityId: null,
      since: s.turn,
      /*
       * 规模：**看要打的那座城有多少守军**，而不是固定配额。
       *
       * 用户 2026-11-21 观察："敌方其实没兵了，人类就不用集结这么多才推进。"
       * 以前只看"我方/敌方总兵力比"——敌方一个兵都看不见时 ratio 反而最大，
       * 于是越是空城越要凑满编，白白等十几回合。
       *
       * guard 是 `softestCityOf` 算的守军价值（战斗单位 + 建筑×0.6 + 工人×0.3）：
       * 空城 0 → 6 人；满防 1200+ → 顶到配额。
       */
      want: Math.min(budget.squadCap, planNeed ?? Math.round(budget.squadCap * 0.75)),
      spread: budget.spread,
      requested: [],
    });
  }

  // 3) 目标 + 出发：目标用"守军最少的那座"（换城就是绕路，见 softestCityOf）
  const reports: AiSquadReport[] = [];
  const prevAll = (focus.plan?.keep?.squadPrev ?? {}) as Record<
    string,
    { count: number; lead: number; stalled: number }
  >;
  const nextPrev: Record<string, { count: number; lead: number; stalled: number }> = {};

  for (const sq of kept) {
    /*
     * 目标**跟计划层走**，编队不自己挑。
     *
     * 第一版让编队自己挑"守军最少的城"，实测掉得厉害（配对改善 4 / 变差 8）：
     * 编队和全局主攻方向打架——部队被拉去远处那座，正面反而空了。
     * 编队是执行者，选哪座城是计划的活。
     */
    if (!sq.targetCityId || !foes.some((c) => c.id === sq.targetCityId)) {
      sq.targetCityId =
        (planCityId && foes.some((c) => c.id === planCityId) ? planCityId : null) ??
        softestCityOf(s, me)?.id ??
        foes[0]?.id ??
        null;
    }
    /*
     * 出发：凑够 `want` 就走；凑不够等 10 回合也走（有多少走多少）。
     * 只等"凑够"的话，钱不够时会永远不出兵——那和"没有编队"一样。
     */
    if (
      sq.state === 'forming' &&
      (sq.memberIds.length >= sq.want || s.turn - sq.since >= SQUAD_FORM_TIMEOUT)
    ) {
      sq.state = 'marching';
    }
    const city = sq.targetCityId ? s.cities.find((c) => c.id === sq.targetCityId) ?? null : null;
    const dists = sq.memberIds
      .map((id) => byId.get(id))
      .filter((u): u is Unit => u !== undefined)
      .map((u) => (city ? distToCity(u, city) : 0))
      .sort((a, b) => a - b);
    const count = dists.length;
    const lead = dists[0] ?? 0;
    const spread = count > 1 ? (dists[count - 1] as number) - lead : 0;
    const p = prevAll[sq.id];
    const stalled = !p ? 0 : count > 0 && lead >= p.lead - 1 ? Math.min(99, p.stalled + 1) : 0;
    const lost = p ? Math.max(0, p.count - count) : 0;
    const note: AiSquadReport['note'] =
      count < 3 ? 'thin' : stalled >= 4 ? 'blocked' : lost >= 2 ? 'attrition' : 'advance';
    reports.push({
      id: sq.id,
      state: sq.state,
      count,
      lead: Math.round(lead * 10) / 10,
      spread: Math.round(spread * 10) / 10,
      stalled,
      lost,
      note,
    });
    nextPrev[sq.id] = { count, lead, stalled };
  }

  /*
   * 建造编队：清理 → 跟目标点 → 桥通了待机 → 解散。
   *
   * 目标点由计划层给（`buildPoint`）：桥没通时是主渡口；拥堵分流时是新渡口。
   * 计划不给点 = 这一回合不需要修桥 → 开始待机，`BUILD_IDLE_TURNS` 回合后解散
   * （用户 2026-11-22：待机几回合，确保桥不会被拉锯反复拆，之后再解散）。
   */
  const builders = unitsOf(s, me).filter((u) => utype(s, u.type).category === 'builder');
  const idlePrev = (focus.plan?.keep?.buildIdle ?? {}) as Record<string, number>;
  const idleNext: Record<string, number> = {};
  const buildKept: AiSquad[] = [];
  for (const sq of buildIn) {
    const alive = [...new Set(sq.memberIds)].filter((id) => builders.some((b) => b.id === id));
    if (alive.length === 0) continue;
    if (buildPoint) {
      buildKept.push({ ...sq, memberIds: alive, targetPoint: buildPoint, state: 'marching' });
      idleNext[sq.id] = 0;
      continue;
    }
    const n = Number(idlePrev[sq.id] ?? 0) + 1;
    if (n < BUILD_IDLE_TURNS) {
      buildKept.push({ ...sq, memberIds: alive, targetPoint: null });
      idleNext[sq.id] = n;
    }
  }
  if (buildPoint && buildKept.length === 0) {
    const busy = new Set(kept.flatMap((sq) => sq.memberIds));
    const free = builders.filter((b) => !busy.has(b.id));
    if (free.length >= 1) {
      const id = `build-${s.turn}`;
      buildKept.push({
        id,
        role: 'build',
        state: 'marching',
        memberIds: free.slice(0, 2).map((b) => b.id),
        targetCityId: null,
        targetPoint: buildPoint,
        since: s.turn,
        want: 2,
        spread: 0,
        requested: [],
      });
      idleNext[id] = 0;
    }
  }
  /*
   * 建造编队也要上报，否则"AI 想法"面板里只看得到 atk 编队（用户 2026-11-22）。
   * `lead` 用成员到目标点的最小距离，和战斗编队同口径。
   */
  for (const sq of buildKept) {
    const tp = sq.targetPoint ?? null;
    let lead = 0;
    if (tp) {
      lead = Math.min(
        ...sq.memberIds.map((id) => {
          const b = builders.find((x) => x.id === id);
          return b ? Math.max(Math.abs(b.x - tp.x), Math.abs(b.y - tp.y)) : 999;
        }),
      );
    }
    reports.push({
      id: sq.id,
      role: 'build',
      state: 'marching',
      count: sq.memberIds.length,
      lead,
      spread: 0,
      stalled: 0,
      lost: 0,
      note: 'advance',
    });
  }
  kept.push(...buildKept);
  /*
   * 缺口 → 生产端（2026-11-22 补上这条断掉的通道）。
   *
   * `Fields.squadNeed` 从 2026-11-21 就声明了"编队缺口 >0 时采购给战斗单位加分"，
   * 但**从来没有赋值**——采购不知道编队缺人，只按自己的节奏造。
   * 建造编队的缺口同理：有计划要修桥、却没有建造编队（或人不够）时，
   * 报一个 `builderNeed`，让采购把工人排上来。
   *
   * 防抖靠"有没有正在进行的建造编队"：有编队就不再报缺口（用户 2026-11-22）。
   */
  let squadNeed = 0;
  for (const sq of kept) {
    if (sq.role !== 'attack') continue;
    squadNeed += Math.max(0, sq.want - sq.memberIds.length);
  }
  const builderNeed = buildPoint
    ? Math.max(0, 2 - (buildKept[0]?.memberIds.length ?? 0))
    : 0;
  if (focus.plan) {
    focus.plan.keep = {
      ...(focus.plan.keep ?? {}),
      buildIdle: idleNext,
      squadNeed,
      builderNeed,
    };
  }

  if ((focus.squads ?? null) !== null || kept.length > 0) {
    setFocus(s, me, { ...focus, squads: kept });
  }
  const f2 = focusOf(s, me);
  if (f2.plan) {
    f2.plan.keep = { ...(f2.plan.keep ?? {}), squadPrev: nextPrev };
  }
  return { reports, squadNeed, builderNeed };
}

/** 编队成员 → 目标城（走位用：编队成员认编队目标，散兵认全局目标） */
function squadTargetsOf(s: GameState, me: PlayerId): Map<string, string> {
  const out = new Map<string, string>();
  for (const sq of focusOf(s, me).squads ?? []) {
    if (!sq.targetCityId) continue;
    for (const id of sq.memberIds) out.set(id, sq.targetCityId);
  }
  return out;
}

/** 编队成员 → 队形信息（见 Fields.squadInfo 的说明） */
function squadInfoOf(
  s: GameState,
  me: PlayerId,
): Map<string, { cityId: string; lead: number; leadMin: number; leadMax: number; spread: number }> {
  const out = new Map<string, { cityId: string; lead: number; leadMin: number; leadMax: number; spread: number }>();
  for (const sq of focusOf(s, me).squads ?? []) {
    if (!sq.targetCityId) continue;
    const city = s.cities.find((c) => c.id === sq.targetCityId);
    if (!city) continue;
    const members = sq.memberIds
      .map((id) => s.units.find((u) => u.id === id))
      .filter((u): u is Unit => u !== undefined);
    if (members.length === 0) continue;
    const leads = members.map((u) => distToCity(u, city));
    const leadMin = Math.min(...leads);
    const leadMax = Math.max(...leads);
    for (const u of members) {
      out.set(u.id, { cityId: city.id, lead: distToCity(u, city), leadMin, leadMax, spread: sq.spread });
    }
  }
  return out;
}

/** 编队缺几个人（反馈给生产端：不够就赶紧造兵） */
function squadShortfallOf(s: GameState, me: PlayerId): number {
  let need = 0;
  for (const sq of focusOf(s, me).squads ?? []) {
    if (sq.state !== 'forming') continue;
    need += Math.max(0, sq.want - sq.memberIds.length);
  }
  return need;
}

/**
 * 僵持指数：我方战斗单位到最近敌城的"中位距离"连续几回合没缩小。
 *
 * 为什么用中位数而不是"最靠前那个兵"：一个侦察兵冲进去又被打死，
 * 最小值会来回跳；中位数代表**整支部队**有没有整体压上去。
 *
 * 每回合只更新一次（`keep.stallTurn` 去重）——`value` 每步决策都会被调，
 * 不去重会把同一回合算十几次，计数直接失真。
 */
/* ---------------- 编队：编制 + 上报（2026-11-21） ---------------- */

function stallOf(c: PlanCtx): { turns: number; median: number } {
  const turn = c.view.turn;
  const cached = c.keep.stallMedian;
  if (c.keep.stallTurn === turn && typeof cached === 'number') {
    return { turns: Number(c.keep.stallTurns ?? 0), median: cached };
  }
  const foes = c.view.cities.filter((x) => x.owner !== c.me && !x.ruined);
  const mine = unitsOf(c.view, c.me).filter((u) => utype(c.view, u.type).category === 'combat');
  let median = 0;
  let turns = Number(c.keep.stallTurns ?? 0);
  if (foes.length > 0 && mine.length > 0) {
    const dists = mine
      .map((u) =>
        Math.min(
          ...foes.map((x) =>
            Math.max(
              0,
              Math.max(x.x - u.x, u.x - (x.x + 1), 0) + Math.max(x.y - u.y, u.y - (x.y + 1), 0),
            ),
          ),
        ),
      )
      .sort((a, b) => a - b);
    median = dists[Math.floor(dists.length / 2)] ?? 0;
    const prev = Number(c.keep.stallMedian ?? median);
    /*
     * 前进 2 格以上才算"有进展"：一格的空间不算，那可能只是换了个站位。
     *
     * 僵持计数是**周期**的（0~29）：0~5 正常推进、6~25 屯兵、26~29 放开冲一次，
     * 然后归零重来。不这么做的话，一个永远过不去的局面会让 turns 一直涨，
     * 屯兵条件（turns >= 6）之后永远成立——变成"永久不推进"。
     */
    turns = median <= prev - 2 ? 0 : turns >= 29 ? 0 : turns + 1;
  }
  c.keep.stallTurn = turn;
  c.keep.stallMedian = median;
  c.keep.stallTurns = turns;
  return { turns, median };
}

/* ---------------- 集中突破 / 绕路（2026-11-21） ---------------- */

/**
 * 哪座敌城"最软"：按**守军价值**排序（守军包括战斗单位、防御建筑、会建造的工人）。
 *
 * 这是"绕路"的判据：僵持点打不动，就换一座守军更少的城。
 * 同时也是"集中突破"的判据：如果最软的就是当前那座，那就把全军压上去打穿它。
 * 两条路共用同一个选择——**永远打最软的那座**，是绕路还是突破由结果决定。
 *
 * 迷雾下的守军看不见，会估成 0 → 挑它。这是必然的（现在没有侦察），
 * 但方向不算错：看不见的地方通常就是没被重点守的地方。
 */
function softestCityOf(
  view: GameState,
  me: PlayerId,
  /** 排除这一座（"打了很久还没下"的那座）。只剩一座时排除无效 */
  excludeId?: string | null,
): { id: string; guard: number } | null {
  let foes = view.cities.filter((c) => c.owner !== me && !c.ruined);
  if (excludeId && foes.length > 1) foes = foes.filter((c) => c.id !== excludeId);
  if (foes.length === 0) return null;
  const guards = enemyUnitsOf(view, me);
  let best: { id: string; guard: number } | null = null;
  for (const city of foes) {
    let guard = 0;
    for (const u of guards) {
      if (distToCity(u, city) > 4) continue;
      const d = utype(view, u.type);
      const w = d.category === 'building' ? 0.6 : d.category === 'economy' ? 0.3 : 1;
      guard += (d.cost ?? 50) * w;
    }
    if (!best || guard < best.guard) best = { id: city.id, guard };
  }
  return best;
}

/**
 * 集中突破 / 绕路：僵持久了自己换打法，而不是继续往同一个点磨。
 *
 * 用户 2026-11-21 的原话：僵持通常是被**防御建筑或远程单位**看住了，
 * 所以集中突破就是集中摧毁这些（工人也算目标）；要绕就绕远一点、换另一座城，
 * 那条路可能要过河——**过河计划自然会跟着立起来**（因为 `crossing` 现在按
 * 主攻城市判可达，见它的 value）。
 *
 * 它只下三条指令，不产生动作：
 *   · `commit`：全军压向主攻城市，不追路过的敌军（引擎里本来就有这个开关）；
 *   · `focusCityId`：换成"最软的那座城"——**这一项就是绕路**；
 *   · `focusUnitId`：集火那座城附近的守军/防御建筑（见 pickFocusTarget）。
 */
const BREAKTHROUGH_PLAN: RankedPlan = {
  id: 'breakthrough',
  kind: 'weights',
  strength: PLAN_TUNING.strength.breakthrough ?? 1,
  value: (c) => {
    if (c.view.config.aiBreakthrough === false) return 0;
    const st = stallOf(c);
    if (st.turns < PLAN_TUNING.breakStallTurns) return 0;
    if (c.army < 5) return 0;
    return 1 + st.turns / 12;
  },
  done: () => false,
  orders: (c) => {
    /*
     * 目标要**粘住**：选定了就打到底，别每回合重算。
     *
     * 第一版每回合都挑"最软的城"，实测换手 17 次——部队在两座城之间来回跑，
     * 一座也没打下来（Q3 seed 32）。粘 24 回合之后再重选：那时如果还是打不动，
     * 说明真的该换（这就是"绕路"的触发点）。
     */
    const prev = c.keep.breakCity as string | undefined;
    const prevAt = Number(c.keep.breakAt ?? 0);
    const prevAlive =
      prev !== undefined &&
      c.view.cities.some((x) => x.id === prev && x.owner !== c.me && !x.ruined) &&
      c.view.turn - prevAt < PLAN_TUNING.breakStickTurns;
    /*
     * 绕路的**触发点**：目标城粘满 `breakStickTurns` 还没打下来，就把它排除掉重选。
     *
     * 不加这一条，"守军相当时永远挑第一座"会让换城永不发生——绕路等于没实现
     * （2026-11-21 用户在回放里确认过：Q2/Q3 两局从头到尾打同一座城）。
     */
    const stuck = prevAlive && c.view.turn - prevAt >= PLAN_TUNING.breakStickTurns;
    const soft = softestCityOf(c.view, c.me, stuck ? prev : null);
    if (!soft) return {};
    const target = prevAlive && !stuck ? prev! : soft.id;
    if (!prevAlive) {
      c.keep.breakCity = target;
      c.keep.breakAt = c.view.turn;
    }
    return {
      // 人不够就别"全军压城"：那只是让全军排队去送
      commit: c.army >= 8,
      focusCityId: target,
      focusUnitId: pickFocusTarget(c.view, c.me, target),
      // 集中突破要的是"一次压上去"，所以申报满编
      needSquad: PLAN_TUNING.needSquad.breakthrough,
    };
  },
};

/**
 * 屯兵：僵持太久就别再往里添油，把产能攒成一次打击。
 *
 * 用户 2026-11-21 的原话："如果一个地方一直僵持，就会选择把剩余产能转向屯兵，
 * 而不是添油；之后屯的兵不论是再次突破同一点，还是绕路包抄。"
 *
 * 老 AI（以及逐字继承它的 v3）的问题是**每个兵单独决策**：谁离得近谁上，
 * 于是永远在"一个兵走一格、被打死、再来一个"。启发式短视算法自己解决不了
 * 这件事——它必须**立约、跨回合**：这段时间不推进，只攒人。
 *
 * 出口只有两个：
 *   · `advance` 压到 0.15 —— 兵不再往前顶（但还手照旧）；
 *   · `holdFire`（只在敌人没贴脸时）—— 别隔着河/隔着射程对射换血。
 *
 * 解除条件是可观测的：**兵攒够了**（≥ 对面 × 1.5，且至少 6 个）或者
 * **僵持解除**（中位距离前进 2 格）。解除之后 `advance` 回 1，
 * 全军的推进分同时恢复——这就是"集中突破同一点"。
 */
const MASS_PLAN: RankedPlan = {
  id: 'mass',
  kind: 'weights',
  strength: PLAN_TUNING.strength.mass ?? 0.9,
  value: (c) => {
    if (c.view.config.aiMass === false) return 0;
    /*
     * 上报的第一个消费者（2026-11-21）：**兵根本没到前线就别屯**。
     *
     * 实测拿到上报之后才看清：屯兵期把 `advance` 压到 0.15，兵不是"停在战线
     * 后方等"，而是**一路退回离敌城 20 格的地方**（front/mid 都是 0、rear 五十几个）。
     * 因为"离城远"在这套评分里等于"安全"。于是屯兵变成了撤退，越屯越打不着。
     *
     * 这条上报把那个死循环掐断：前队空 + 后队连续二十回合没前进 → 不是僵持，
     * 是根本没过河/没出门，这时候该做的是"往前压"，不是"继续屯"。
     */
    /*
     * 上报的消费：**所有编队都连续 20 回合没推进 → 不是僵持，是根本没动**。
     * 这时候该往前压，不是继续攒（第一版按"前队空/后队多"判，已被否掉：
     * 那是按死距离分段的产物，32×32 上人人都是"后队"）。
     */
    const reps = c.keep.squads as AiSquadReport[] | undefined;
    if (reps && reps.length > 0 && reps.every((r) => r.stalled >= 20)) return 0;
    const st = stallOf(c);
    if (st.turns < PLAN_TUNING.massStallTurns) return 0;
    // 周期后段放开冲一次：屯久了必须试一把，否则就成了"永久不推进"
    if (st.turns >= PLAN_TUNING.massGiveUpTurns) return 0;
    // 兵已经明显多于对面，屯的意义就没了——打不动不是人不够
    if (c.army >= Math.max(PLAN_TUNING.massMinArmy, c.foeArmy * PLAN_TUNING.massRatio) && st.turns < 20)
      return 0;
    return 1 + st.turns / 10;
  },
  done: () => false,
  /*
   * 只压推进，**不关火**。
   *
   * 第一版同时给了 `holdFire`，实测反而更弱（seed 32 从 221 回合平变成 158 回合输）：
   * 停火是全局的，敌人走到 4 格开外就能白打——"不主动送"和"不还手"是两件事。
   * 添油的根源是"往前挪一格换 6 分"，压这一项就够了。
   */
  weights: () => ({ advance: PLAN_TUNING.massAdvance }),
  // 只申报规模，不动目标城（合并规则保证 breakthrough 的字段不会被顶掉）
  orders: () => ({ needSquad: PLAN_TUNING.needSquad.mass }),
};

/**
 * 防守计划：敌人已经打到城下、而我还不如对面能打，就收回来守。
 *
 * 它只干一件事——**提高回撤强度**（`pullHome`）。不压"打不打"：
 * 贴到脸上的敌人照打，只是不再主动往前顶。压攻击权重的教训在 P4：
 * 双方一起龟缩，平局率翻倍。
 *
 * 以前的写法是 `stance === 'turtle'` 直接设 `fields.hold`，现在改成
 * 走排序层的权重，这样它和其他计划一样有立约、价值、日志。
 */
registerAiPlan(MASS_PLAN);
registerAiPlan(BREAKTHROUGH_PLAN);

const DEFEND_PLAN: RankedPlan = {
  id: 'defend',
  kind: 'weights',
  strength: PLAN_TUNING.strength.defend ?? 0.85,
  /*
   * 回滞：威胁消失后再撑 3 回合才放。
   *
   * 不加这个，敌人进/出"3 格线"就会让计划每两回合翻一次（实测 seed 24 终局
   * `defend@254 → 无@256 → defend@256`），部队在城门口来回走。
   * 计数存在计划自己的口袋里（`save`），不需要往 AiFocus 加字段。
   */
  value: (c) => {
    const fresh = c.enemyAtGate && c.weaker && c.army >= 3;
    if (fresh) return 1;
    const held = Number(c.state.held ?? 0);
    return c.state.on === true && held < 3 && c.army >= 2 ? 1 : 0;
  },
  done: () => false,
  save: (c) => {
    const fresh = c.enemyAtGate && c.weaker && c.army >= 3;
    if (fresh) return { on: true, held: 0 };
    const held = Number(c.state.held ?? 0) + 1;
    return { on: c.state.on === true && held < 3 && c.army >= 2, held };
  },
  weights: () => ({ pullHome: 1 }),
};
registerAiPlan(DEFEND_PLAN);

/**
 * 决战时机的**判决**（从"旁路闸门"升成计划，2026-11-21）。
 *
 * 它只做一件事：在"打不动"的时候把开火闸门关上（`holdFire`）。
 * 不压进攻乘数——P4 的教训是压低乘数会让双方一起龟缩，而"先别送"只需要关火。
 *
 * 回滞和驻留都存在它自己的口袋里（`save`），所以换计划、重开一局都不会丢。
 * 将来有侦察了，要换的只是 **上游的估计器**（`projRatio` 从"按可见单位估"
 * 换成"实测值"），判决这一层一行都不用动——`PlanCtx.intelKnown` 就是那个口子。
 */
function decideCallOf(c: PlanCtx): 'attack' | 'develop' {
  const prev = (c.state.call as 'attack' | 'develop' | undefined) ?? null;
  const since = Number(c.state.since ?? 0);
  const ratio = c.projRatio;
  /*
   * ⚠️ 2026-11-22 撤掉了"按情报置信度收缩比值"的那一版（`intelTrust`）。
   *
   * 它算得对、开关也生效（trust=1 与阶段 1b 逐局一致），但**没有任何行为出口**：
   * `call` 唯一的消费者是 `weights` 里的
   *   `holdFire: call === 'develop' && c.projRatio < 0.85`
   * —— 第二个条件用原始比值。分三段看：
   *   · ratio < 0.85：收缩后 judged 只会更接近 1，但首次/转打阈值仍够不到，
   *     结论还是 develop，holdFire 照旧为真；
   *   · ratio ≥ 0.85：不论 call 是 attack 还是 develop，holdFire 都被第二条件卡成 false。
   * 于是 24 局（Q3/Q4）把 `intelTrust` 从 0.4 调到 0（完全收缩）都逐局不变。
   *
   * 结论：**这个量要接，得先有一个真的会动行为的消费者**（攻击乘数或开火闸门），
   * 而不是让它去改一个没有差异的布尔。`intelConf` 字段留着，阶段 3/4 用来
   * 决定"要不要派人去看"。
   */
  const canAttack = c.marchTurns > 0 && c.marchTurns <= 14;
  let call: 'attack' | 'develop';
  if (prev === 'attack') call = ratio >= 0.9 && canAttack ? 'attack' : 'develop';
  else if (prev === 'develop') call = ratio >= DECISIVE_SWITCH && canAttack ? 'attack' : 'develop';
  else call = ratio >= DECISIVE_AT && canAttack ? 'attack' : 'develop';
  const ratioAt = Number(c.state.ratioAt ?? ratio);
  // 驻留：3 回合内、比值没怎么变，就别翻案（防抖）
  const dwell = prev !== null && c.view.turn - since < 3 && Math.abs(ratio - ratioAt) < 0.5;
  return dwell && prev ? prev : call;
}

const DECISIVE_PLAN: RankedPlan = {
  id: 'decisive',
  kind: 'weights',
  strength: 1,
  // 价值就是投影比：不是 0/1，日志里能直接看出"差多少"
  value: (c) => c.projRatio,
  done: () => false,
  save: (c) => {
    const call = decideCallOf(c);
    const prev = c.state.call as 'attack' | 'develop' | undefined;
    return { call, since: prev === call ? Number(c.state.since ?? c.view.turn) : c.view.turn, ratioAt: c.projRatio };
  },
  weights: (c) => ({ holdFire: decideCallOf(c) === 'develop' && c.projRatio < 0.85 }),
};
registerAiPlan(DECISIVE_PLAN);

const CROSSING_PLAN: RankedPlan = {
  id: 'crossing',
  kind: 'weights',
  strength: PLAN_TUNING.strength.crossing ?? 0.9,
  value: (c) => {
    if (c.view.config.aiCrossing === false) return 0;
    if (!c.view.cities.some((x) => x.owner !== c.me && !x.ruined)) return 0;
    /*
     * **不要**因为 `canReach` 归零。归零 = 计划退场 = 口袋丢掉，
     * 于是"桥被拆几次"的计数每翻一次就归零，放弃条件永远不成立
     * （实测 seed 34 一局拆 11 次还在造）。陆路通了由 `done` 收场，
     * 那时候任务已经结束，丢口袋是对的。
     */
    // 兵都没凑够就先别修桥：那会变成"为了过河把家底掏空"
    if (c.army < 3) return 0;
    return 1;
  },
  done: (c) => c.canReach || !c.view.cities.some((x) => x.owner !== c.me && !x.ruined),
  /*
   * 桥被反复拆：这条路走不通，就别再把钱填进去。
   *
   * 2026-11-21 实测（seed 34，16×16 era3）：那一局桥被拆了 **7 次**——造一座、
   * 对面拆一座、再造一座，后方一直不发展，钱全耗在河上。人不会这么打：
   * 试两三次不行就换渡口、换船运，或者干脆先不打。
   *
   * 计数按"我方桥单位数下降"算（不看是谁拆的，也管不了，只看结果）。
   * 每 15 回合没再被拆就忘掉一次——对面可能撤了，值得再试。
   */
  save: (c) => {
    const mine = unitsOf(c.view, c.me).filter((u) => utype(c.view, u.type).bridges).length;
    const prev = c.keep.bridges;
    // 计数写进 `keep`（不随计划退场丢失），不写口袋——见 types 里 `keep` 的说明
    if (typeof prev === 'number' && mine < prev) c.keep.lost = Number(c.keep.lost ?? 0) + 1;
    c.keep.bridges = mine;
    /*
     * 渡口拥堵（2026-11-22）：判据只用**我方单位的位置**，不需要敌人信息。
     *
     *   · 距渡口 ≤3 格的战斗单位数（`near`）；
     *   · 这些单位属于几支编队（`sqNear`）——9 支挤一座桥时，这个数先涨。
     *
     * `jam` 成立就累加连续回合数，不成立清零。分流要的是"持续拥堵"，
     * 单帧人多可能只是刚好路过。
     */
    const site =
      (c.state.focus as { x: number; y: number } | undefined) ??
      (c.keep.crossingSite as { x: number; y: number } | undefined);
    if (site) {
      c.keep.crossingSite = site;
      const near = unitsOf(c.view, c.me).filter(
        (u) =>
          utype(c.view, u.type).category === 'combat' &&
          Math.max(Math.abs(u.x - site.x), Math.abs(u.y - site.y)) <= 3,
      );
      const squads = c.view.aiFocus?.[c.me]?.squads ?? [];
      const sqNear = squads.filter((sq) =>
        sq.memberIds.some((id) => near.some((u) => u.id === id)),
      ).length;
      c.keep.bridgeUnits = near.length;
      c.keep.bridgeSquads = sqNear;
      const jam = near.length >= 10 || sqNear >= 2;
      c.keep.bridgeJam = jam ? Number(c.keep.bridgeJam ?? 0) + 1 : 0;
    }
    return {};
  },
  /*
   * 分流（2026-11-22）：主渡口持续拥堵时，把**一支**编队引到第二个渡口。
   *
   * 三个 @tune 值都是拍的，理由写在数值旁边：
   *   · 连续拥堵 3 回合才分流（1~2 回合可能只是路过/刚好一波人）；
   *   · 新渡口离旧渡口 ≥6 格（挨着等于一座，见 `crossingPointOf` 的 avoid）；
   *   · 分流后锁定 10 回合（否则今天分、明天回，来回抖）。
   */
  orders: (c) => {
    const site = c.keep.crossingSite as { x: number; y: number } | undefined;
    if (!site) return {};
    /** @tune 连续拥堵几回合才分流 */
    const JAM_TURNS = 3;
    /** @tune 分流后锁定几回合不重算 */
    const SPLIT_LOCK = 10;
    const out: {
      buildPoint?: { x: number; y: number } | null;
      altCrossing?: { x: number; y: number; unitIds: string[] } | null;
    } = {};
    /*
     * 修桥点：陆路不通时就是主渡口。桥通了就不再给点——建造编队会进待机，
     * 待机 3 回合后解散（见 `BUILD_IDLE_TURNS`），免得桥被拉锯时来回修。
     */
    if (!c.canReach) out.buildPoint = { x: site.x, y: site.y };
    if (c.view.config.aiCrossSplit === false) return out;
    /*
     * 锁定期内**先**看旧的 alt，再看拥堵。
     *
     * 顺序反了会这样：拥堵一消失（分流刚把人引走）→ `jam < 3` → 立刻退回主渡口，
     * 工人也跟着回去，新渡口永远修不成。实测 T30 指向 16,10、T36 就退回 3,11。
     */
    const until = Number(c.keep.splitUntil ?? 0);
    const prev = c.keep.splitAlt as { x: number; y: number; unitIds: string[] } | undefined;
    if (c.view.turn < until && prev) {
      out.altCrossing = prev;
      out.buildPoint = { x: prev.x, y: prev.y };
      return out;
    }
    if (Number(c.keep.bridgeJam ?? 0) < JAM_TURNS) return out;
    const alt = crossingPointOf(c.view, c.me, site);
    if (!alt) return out;
    const squads = (c.view.aiFocus?.[c.me]?.squads ?? []).filter(
      (sq) => sq.role === 'attack' && sq.memberIds.length >= 3,
    );
    if (squads.length === 0) return out;
    // 挑离新渡口最近的那支：它绕路最少，也最可能先到
    const pick = squads
      .map((sq) => ({
        sq,
        d: Math.min(
          ...sq.memberIds.map((id) => {
            const u = c.view.units.find((x) => x.id === id);
            return u ? Math.max(Math.abs(u.x - alt.x), Math.abs(u.y - alt.y)) : 999;
          }),
        ),
      }))
      .sort((a, b) => a.d - b.d)[0]!.sq;
    const split = { x: alt.x, y: alt.y, unitIds: [...pick.memberIds] };
    c.keep.splitAlt = split;
    c.keep.splitUntil = c.view.turn + SPLIT_LOCK;
    out.altCrossing = split;
    out.buildPoint = { x: alt.x, y: alt.y };
    return out;
  },
  focus: (c) => {
    // 已经有陆路：不用修（这里给 null，不是让计划退场，见 value 的说明）
    if (c.canReach) return null;
    // 拆够两次就别修了：实测一局桥被拆 10 次、造了 12 座，钱全填河
    if (Number(c.keep.lost ?? 0) >= 2) return null;
    // 选定不换：旧渡口还是水面/自己铺的桥面，就接着用
    const prev = c.state.focus as { x: number; y: number } | undefined;
    if (prev) {
      const tile = c.view.tiles[prev.y * c.view.w + prev.x];
      if (tile && (tile.terrain === 'water' || tile.terrain === 'bridge')) return prev;
    }
    return crossingPointOf(c.view, c.me);
  },
};
registerAiPlan(CROSSING_PLAN);

/* ---------------- 侦查：选人、蹲点、放弃（阶段 3） ---------------- */

/*
 * 选人判据的权重（每一项都要能说出理由，别拍）：
 *
 *   · 视野 8/格：4 格能罩住一整座城（城 2×2），2 格只能看到城墙一角；
 *   · 潜行 +30：森林/丘陵上不出手，敌人要贴到相邻才发现——**这是能长期蹲住的前提**；
 *   · 移动 2/点：4 速的斥候两回合到点，2 速的民兵要五回合，路上就被打死了；
 *   · 造价 −0.05/金：死得起。50 金的斥候 = −2.5 分，400 金的坦克 = −20 分；
 *   · 残血直接排除：半血出门等于送人头。
 *
 * 这套分的实际效果：斥候（视 4 + 潜行 + 移 4 + 50 金）≈ 67 分；
 * 民兵（视 2 + 移 2 + 25 金）≈ 19 分；弓手（视 3 + 移 2 + 35 金）≈ 24 分。
 * 没有斥候的局就用"视野最高的散兵"，不会去找坦克。
 */
/** @tune 侦查选人：视野每格值几分 */
const SCOUT_VISION = 8;
/** @tune 侦查选人：潜行加多少分 */
const SCOUT_STEALTH = 30;
/** @tune 侦查选人：移动每点值几分 */
const SCOUT_MOVE = 2;
/** @tune 侦查选人：造价每金扣几分 */
const SCOUT_COST = 0.05;
/**
 * @tune 侦查选人门槛：15 = 弓手也能去
 *
 * 低于这个分不如不派。
 *
 * 15 是"弓手（视 3）也能去"的线：视野 4 的斥候 67 分、弓手 24 分、民兵 19 分。
 * 第一版定 25，结果没买斥候的局**永远不侦查**（早期只有民兵/弓手）——
 * 而"看不见"最严重的恰恰是那些局。
 */
const SCOUT_MIN_FIT = 15;
/** @tune 情报到什么程度算"看清了"（计划退场、不再派人） */
const SCOUT_CONF_ENOUGH = 0.7;

/**
 * 一个兵适不适合去侦查（越高越合适；负数 = 不合格）。
 *
 * 为什么不是"兵种 id 白名单"：扩展包里每个时代都可能有潜行兵，
 * 写死 `scout` 会在没有斥候的图/时代直接失效。判据只看**能力**：
 * 战斗单位、非水军、血够、视野高、能潜行、跑得快、死得起。
 */
export function scoutFitOf(view: GameState, u: Unit): number {
  const d = utype(view, u.type);
  if (d.category !== 'combat') return -1;
  if (d.domain === 'water') return -1;
  if (u.hp / Math.max(1, d.maxHp) < 0.5) return -1;
  const stealth = d.abilities?.includes('stealth') ? SCOUT_STEALTH : 0;
  return (
    (d.vision ?? 1) * SCOUT_VISION +
    stealth +
    (d.move ?? 1) * SCOUT_MOVE -
    (d.cost ?? 0) * SCOUT_COST
  );
}

/** 这次要去看哪座城：主攻城优先，没有就挑离我最近的敌城 */
function scoutTargetCityOf(c: PlanCtx): City | null {
  const foes = c.view.cities.filter((x) => x.owner !== c.me && !x.ruined);
  if (foes.length === 0) return null;
  const wanted = c.focusCityId ? foes.find((x) => x.id === c.focusCityId) : null;
  if (wanted) return wanted;
  let best = foes[0]!;
  let bestD = Infinity;
  for (const city of foes) {
    for (const u of unitsOf(c.view, c.me)) {
      const d = Math.max(Math.abs(u.x - city.x), Math.abs(u.y - city.y));
      if (d < bestD) {
        bestD = d;
        best = city;
      }
    }
  }
  return best;
}

/**
 * 蹲在哪一格：城周围 3~4 格的一圈，森林/丘陵优先（潜行 + 掩体）。
 *
 * 为什么是 3~4 而不是贴身：视野 4 的斥候站 3~4 格刚好罩住城中心，
 * 而贴身会被城墙上的塔和守军直接打掉——潜行只在"不出手"时成立，
 * 距离太近就没有第二次机会。
 */
function scoutSpotOf(
  view: GameState,
  me: PlayerId,
  city: City,
): { x: number; y: number } | null {
  let best: { x: number; y: number } | null = null;
  let bestScore = -Infinity;
  const mine = unitsOf(view, me);
  for (let dy = -4; dy <= 4; dy += 1) {
    for (let dx = -4; dx <= 4; dx += 1) {
      const ring = Math.max(Math.abs(dx), Math.abs(dy));
      if (ring < 3 || ring > 4) continue;
      const x = city.x + dx;
      const y = city.y + dy;
      const t = tileAt(view, x, y);
      if (!t || !passable(t.terrain)) continue;
      if (unitAt(view, x, y)) continue;
      if (cityAt(view, x, y)) continue;
      let score = 0;
      if (t.terrain === 'forest' || t.terrain === 'hill') score += 40;
      // 离自己人近一点：路上更安全，也方便被打残时撤回去
      let near = Infinity;
      for (const u of mine) near = Math.min(near, Math.max(Math.abs(u.x - x), Math.abs(u.y - y)));
      if (Number.isFinite(near)) score -= near * 0.5;
      if (score > bestScore) {
        bestScore = score;
        best = { x, y };
      }
    }
  }
  return best;
}

/** 这一回合派谁：适格分最高的那个；没有就 null（宁可不派，也别让民兵去送） */
function scoutUnitOf(c: PlanCtx): Unit | null {
  let best: Unit | null = null;
  let bestFit = SCOUT_MIN_FIT - 1;
  for (const u of unitsOf(c.view, c.me)) {
    const fit = scoutFitOf(c.view, u);
    if (fit > bestFit) {
      bestFit = fit;
      best = u;
    }
  }
  return best;
}

const SCOUT_PLAN: RankedPlan = {
  id: 'scout',
  kind: 'weights',
  strength: PLAN_TUNING.strength.scout ?? 1,
  value: (c) => {
    // 默认关：阶段 3 首验净负（见 docs 与 types 的注释）。`aiScout: true` 才派
    if (c.view.config.aiScout !== true) return 0;
    if (c.view.turn < Number(c.keep.scoutCooldown ?? 0)) return 0;
    const city = scoutTargetCityOf(c);
    if (!city) return 0;
    /*
     * 目标还远就先别派。
     *
     * 第一版没有这条：开局主攻城在 39 回合外、conf=0 → value 拉满 → 派一个兵
     * 横穿地图，路上被打死或白走（Q2 两局由胜转负/平）。侦查是"决战前的准备"，
     * 不是"开局就出去探险"。12 回合大约是两个编队集结周期。
     */
    if (c.marchTurns > 12) return 0;
    /*
     * 兵力不富余就不派。
     *
     * 实测（2026-11-22，Q1/Q2 12 局）：抽走一个战斗单位，在兵力紧的局里是直接亏损——
     * 赢的局变负、快的局变慢。侦查是"有余力才做的准备"，不是刚需；
     * 8 是"至少有一支编队之外的人"的量级。
     */
    if (c.army < 8) return 0;
    // 已经看清（或守军就在眼前）就不必再派人
    if (Number(c.intelConf ?? 0) >= SCOUT_CONF_ENOUGH) return 0;
    if (!scoutUnitOf(c)) return 0;
    /*
     * 价值尺度：3~9。比"收尾"（1e9）低两个数量级，不会抢它的活；
     * 但比默认的竞争线高，能在没别的大事时当值。
     * 越看不清越想去——这就是"侦查请求"的最简形式（自己发现自己需要）。
     */
    return 3 + (1 - Math.max(0, Math.min(1, Number(c.intelConf ?? 0)))) * 6;
  },
  done: () => false,
  orders: (c) => {
    const city = scoutTargetCityOf(c);
    const u = scoutUnitOf(c);
    if (!city || !u) return {};
    const spot = scoutSpotOf(c.view, c.me, city);
    if (!spot) return {};
    return { scout: { unitId: u.id, cityId: city.id, ...spot } };
  },
  save: (c) => {
    /*
     * 死亡与冷却。
     *
     * `keep.scout` 记"上次派的是谁"；这一回合它不在场 → 记一次损失。
     * 冷却：死一次 12 回合，连续两次 25 回合（用户：能牺牲，但别一直送）。
     * `deadTurn` 防同一回合重复计数（`save` 可能被多次调用）。
     */
    const prev = c.keep.scout as
      | { unitId?: string | null; lost?: number; deadTurn?: number }
      | undefined;
    const alive = new Set(unitsOf(c.view, c.me).map((u) => u.id));
    let lost = Number(prev?.lost ?? 0);
    let deadTurn = Number(prev?.deadTurn ?? -1);
    if (prev?.unitId && !alive.has(prev.unitId) && deadTurn !== c.view.turn) {
      lost += 1;
      deadTurn = c.view.turn;
      c.keep.scoutCooldown = c.view.turn + (lost >= 2 ? 25 : 12);
    }
    const next = scoutUnitOf(c);
    c.keep.scout = { unitId: next?.id ?? null, lost, deadTurn };
    return {};
  },
  // 不改权重：侦查只动"派谁去哪"，不压全军
  weights: () => ({}),
};
registerAiPlan(SCOUT_PLAN);

/* ---------------- 顺路观察：不抽人，只偏一点（阶段 3b 的 B 方案） ---------------- */

/**
 * 顺路观察的任务：谁、去哪看。
 *
 * 和 `SCOUT_PLAN` 的根本区别是**不新增成本**：
 *   · 只挑"已经在往目标城方向走"的战斗单位（距城 5~14 格）；
 *   · 不建编队、不禁攻、不设死亡冷却——它本来就在前线，死了是打输了；
 *   · 看见了（conf ≥ 0.7）或没有合适的人，任务直接消失。
 *
 * 为什么值得先试这个：阶段 3 的完整侦查净负，但那是"抽走一个兵 + 六条执行规则"
 * 混在一起的结果。这里只改走位偏好，用来回答一个更基本的问题——
 * **提前几回合知道对面有多少兵，到底值不值钱？** 不值的话后面六条都不用做。
 */
/** @tune 顺路观察最多几回合（防"站着不走"） */
const PEEK_MAX_TURNS = 6;
/** @tune 顺路观察冷却回合 */
const PEEK_COOLDOWN = 8;

function peekTaskOf(c: PlanCtx): { unitId: string; x: number; y: number } | null {
  // 默认关：B 方案首验净负（见 docs）。`aiPeek: true` 才开
  if (c.view.config.aiPeek !== true) return null;
  if (c.view.turn < Number(c.keep.peekCooldown ?? 0)) return null;
  const since = Number(c.keep.peekSince ?? 0);
  if (since > 0 && c.view.turn - since >= PEEK_MAX_TURNS) return null;
  const city = scoutTargetCityOf(c);
  if (!city) return null;
  if (Number(c.intelConf ?? 0) >= SCOUT_CONF_ENOUGH) return null;
  const own = citiesOf(c.view, c.me);
  let best: Unit | null = null;
  let bestScore = -Infinity;
  for (const u of unitsOf(c.view, c.me)) {
    const def = utype(c.view, u.type);
    if (def.category !== 'combat' || def.domain === 'water') continue;
    if (u.hp / Math.max(1, def.maxHp) < 0.6) continue;
    const d = Math.max(Math.abs(u.x - city.x), Math.abs(u.y - city.y));
    if (d < 5 || d > 14) continue;
    // 守家的不走：家里没人比"看清对面"重要
    if (own.some((x) => Math.max(Math.abs(u.x - x.x), Math.abs(u.y - x.y)) <= 2)) continue;
    // 视野高的优先（看得远），离得近的优先（省路）
    const score = (def.vision ?? 1) * 10 - d * 0.5;
    if (score > bestScore) {
      bestScore = score;
      best = u;
    }
  }
  if (!best) return null;
  const spot = peekSpotFor(c.view, city, best);
  if (!spot) return null;
  return { unitId: best.id, ...spot };
}

/**
 * 观察点：距城 `vision` 格的一圈（正好能看见城），森林/丘陵优先。
 *
 * 为什么不用"距城 vision+1"：那要多走一步还看不见，等于白跑。
 * 为什么留一圈而不是固定一个点：城的大小、地形、自己来向都不同，固定点经常不可站。
 */
function peekSpotFor(
  view: GameState,
  city: City,
  u: Unit,
): { x: number; y: number } | null {
  const v = Math.max(2, utype(view, u.type).vision ?? 2);
  let best: { x: number; y: number } | null = null;
  let bestScore = -Infinity;
  for (let dy = -v; dy <= v; dy += 1) {
    for (let dx = -v; dx <= v; dx += 1) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== v) continue;
      const x = city.x + dx;
      const y = city.y + dy;
      const t = tileAt(view, x, y);
      if (!t || !passable(t.terrain)) continue;
      if (unitAt(view, x, y)) continue;
      if (cityAt(view, x, y)) continue;
      let score = 0;
      if (t.terrain === 'forest' || t.terrain === 'hill') score += 12;
      // 离单位近一点：少走两格就少两格风险
      score -= Math.max(Math.abs(u.x - x), Math.abs(u.y - y)) * 0.6;
      if (score > bestScore) {
        bestScore = score;
        best = { x, y };
      }
    }
  }
  return best;
}

const PEEK_PLAN: RankedPlan = {
  id: 'peek',
  kind: 'weights',
  // 权重给得很低：它是"顺手做的事"，不该和突破/收尾抢
  strength: 0.8,
  value: (c) => (peekTaskOf(c) ? 1.5 : 0),
  done: () => false,
  orders: (c) => {
    const t = peekTaskOf(c);
    return t ? { peek: t } : {};
  },
  /*
   * 计时与冷却：第一次有任务时记开始回合，任务结束时设冷却。
   *
   * 没有这两个数的话，被选中的单位会一直在观察点站到 conf 升上去为止
   * （Q2 均回合 70→97 就是这么来的）——那是"蹲着不推进"，不是"顺路看一眼"。
   */
  save: (c) => {
    const since = Number(c.keep.peekSince ?? 0);
    const t = peekTaskOf(c);
    if (t) {
      if (since === 0) c.keep.peekSince = c.view.turn;
      return {};
    }
    if (since > 0) {
      c.keep.peekSince = null;
      c.keep.peekCooldown = c.view.turn + PEEK_COOLDOWN;
    }
    return {};
  },
  weights: () => ({}),
};
registerAiPlan(PEEK_PLAN);

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
  /*
   * **没有敌城时，目标退化成"最近的敌人"。**
   *
   * 2026-11-16 加这一条，原因是无城对战（F1）：双方都没有城时，
   * 下面那个循环一次都不进，`best` 留在 Infinity，于是"推进"这一项永远是 0 分或负分，
   * 所有走法都不划算——实测 AI 六百步只动了一次（**直接返回"无动作"**，不是发呆）。
   *
   * 这是结构问题，不是权重问题：没有目标的时候，怎么调参数都没用。
   * 注意这里**先判有没有敌城**，而不是复用下面的 `ignoreFoes`——
   * 那个开关的语义是"优势期不必绕开敌人"，和"压根没有目标"是两件事。
   */
  const hasFoeCity = s.cities.some((c) => c.owner !== owner);
  if (!hasFoeCity) {
    const field = fields.get(VIRTUAL_FOE_FIELD);
    const d = field?.[y * s.w + x];
    if (d !== undefined && Number.isFinite(d)) return d * 0.32;
    // 连敌人都没有（理论上只剩自己）：退回曼哈顿距离，好歹给个方向
    let near = Infinity;
    for (const e of enemyUnitsOf(s, owner)) near = Math.min(near, distance({ x, y }, e));
    return near;
  }

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
  for (const e of enemyUnitsOf(s, owner)) {
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
  const foe = enemyUnitsOf(s, unit.owner);
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
  // 编队成员朝**编队的目标城**走（整队一个方向，所以不会散）；
  // 散兵（守家、经济护卫、新造出来还没编队的）仍按全局目标
  /*
   * 目标三档（2026-11-21 用户定的分工）：
   *   1. 编队成员 → 编队的目标城（整队一个方向）；
   *   2. 散兵（没编队的、新造的、掉队的）→ **回自家城守**；
   *   3. 一支部队都没编成（编队被全歼）→ 退回全局目标，否则全军缩在家里等死。
   *
   * 为什么散兵不能跟着冲：实测两股人挤同一个窄口——编队在后面排队，
   * 散兵在前面挨炮，路被塞满，谁也没过去。
   */
  const squadObjective = all.squadTarget.get(unit.id) ?? null;
  const objective =
    squadObjective ??
    (all.squadTarget.size > 0 && all.homeCityId
      ? all.homeCityId
      : all.flank.has(unit.id) && all.flankCityId
        ? all.flankCityId
        : all.focusCityId);
  const before = advanceDistance(s,unit.owner,unit.x,unit.y,fields,objective,all.commit);
  const after = advanceDistance(s,unit.owner,x,y,fields,objective,all.commit);
  const progress = Number.isFinite(before) && Number.isFinite(after) ? before-after : 0;
  if ((globalThis as { __AI_DBG__?: boolean }).__AI_DBG__ === true && unit.owner === 'C') {
    console.log(
      `[dbg] ${unit.id} ${unit.x},${unit.y}→${x},${y} b=${String(before)} a=${String(after)} prog=${progress.toFixed(2)} obj=${String(objective)} air=${airLayer(def)}`,
    );
  }

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
  /*
   * 编队成员用**队形密集度**代替全局战线（2026-11-21 用户提的）。
   *
   * 判据：队形被拉开超过 `spread` 时，最前面那一批停下等；否则全员推进。
   * 老逻辑（`aheadOfLine` 比全图 `lineRef`）对编队不再生效——
   * 它的问题是"所有人都在战线前面"时全都不动，而河/桥会把战线切成两段。
   */
  const sqInfo = all.squadInfo.get(unit.id) ?? null;
  const squadTooSpread = sqInfo !== null && sqInfo.leadMax - sqInfo.leadMin > sqInfo.spread;
  const aheadOfSquad = squadTooSpread && sqInfo !== null && sqInfo.lead <= sqInfo.leadMin + 1;
  const aheadOfLine =
    !all.commit &&
    !sqInfo && // 编队成员不吃全局战线逻辑（上面那条更准）
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
  /*
   * 关卡的 AI 参数（`config.level.ai`）只在这里和战意那一项生效。
   *
   * `cohesion`：0 = 谁快谁先上，1 = 默认（前面的人等后面）。攻坚图要 0 附近的值——
   * 河会把战线切成两段，先过去的永远算"在战线前面"，然后永远停着等。
   */
  const tuning = s.config.level?.ai;
  const cohesion = Math.min(2, Math.max(0, tuning?.cohesion ?? 1));
  // 1 → 0.15（默认惩罚），0 → 1（不惩罚），2 → 更狠（夹到 0.05）
  const lineHold = cohesion <= 1 ? 1 - (1 - 0.15) * cohesion : Math.max(0.05, 0.15 - (cohesion - 1) * 0.1);
  /*
   * 战略层的"推进权重"：屯兵时把它压下去，兵就不再一个个往前顶（添油）。
   *
   * 这一项乘的是**推进分**，不是开火——兵该还手还是还手，只是不再
   * "往前挪一格换 6 分"（那正是把部队一格一格填进绞肉机的原因）。
   */
  const advanceWeight =
    (aheadOfLine || aheadOfSquad ? lineHold : 1) * all.weights.advance;
  /*
   * 僵局压力（关卡级 `pressure`，默认 0 = 不启用）。
   *
   * 有些关打久了会停在一个"谁都不动"的稳定态：攻方压在火力圈外，守方缩在城里，
   * 双方每回合的最优解都是"别动"。光调 `riskAversion` 治不了——它关掉的是
   * "怕死"，关不掉"往前也没赚头"。这里换个方向：**让往前这件事越拖越值钱**。
   *
   * `s.turn / 25` 让压力随回合线性加码，`Math.min(3, …)` 封顶在 4 倍原始值
   * （pressure = 3 时封顶 ×4）。没有关卡的普通对局是 0，一个字都不变。
   */
  /*
   * 只对**没有城**的席位生效。
   *
   * 僵局压力想解决的是"攻方压不上去"，而"没有城"正是攻方最典型的形态
   * （邪龙军团那种：没有产线，不压上就只能等死）。有城的 AI 是防守方，
   * 给它加码只会让它丢下城墙去送——那不是这一项要的。
   */
  const pressure =
    citiesOf(s, unit.owner).length === 0 ? Math.max(0, Math.min(3, tuning?.pressure ?? 0)) : 0;
  const pressureMul = pressure > 0 ? 1 + pressure * Math.min(3, s.turn / 25) : 1;
  let score =
    progress * 6 * traits.appetite * (1 + (all.needBridge ? 0 : all.mood.driveRaw.rush * 0.35)) *
    advanceWeight *
    (tuning?.appetite ?? 1) *
    pressureMul;
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
    for (const city of siegeTargets(s,unit)) nowAttack = Math.max(nowAttack,scoreSiege(s,unit,city,all.focusCityId,all.mood,all.foeEcon));
    for (const city of siegeTargets(s,moved)) {
      const value=scoreSiege(s,moved,city,all.focusCityId,all.mood,all.foeEcon);
      if (value>nextAttack) { nextAttack=value; killed=undefined; }
    }
    score += nextAttack * 0.82 - nowAttack * 0.65;
  }
  const risk = all.tactical.exposure(moved,killed);
  const cost = unitValue(s,unit);
  const loss = risk.damage / Math.max(1,def.maxHp);
  /*
   * `riskAversion` 是关卡级的"愿意用多少伤亡换推进"。
   * 默认 1 就是原来的算法；攻坚图写 0.4，它就肯顶着火力往前走。
   */
  /*
   * 下限放到 **0**（2026-11-16）：0 = 完全不计伤亡。
   *
   * 原来卡在 0.2，本意是"别让 AI 蠢到站火里送死"。但落到「邪龙」这种关就很怪：
   * 飞龙在城火力圈外停住不动，只靠邪龙王隔空下蛋——因为"逼近一格"只值五六分，
   * 而"这一步会挨打/可能会死"即使乘 0.2 也有十几分。作者要的是"它们就是不怕死"，
   * 那就得留一个真能关掉这笔账的档位。默认仍是 1，普通对局一个字不变。
   */
  const riskMul = Math.min(2, Math.max(0, s.config.level?.ai?.riskAversion ?? 1));
  score -= loss * (25 + Math.min(60,cost*0.18)) * (1 + all.mood.driveRaw.harass*0.4) * riskMul;
  if (risk.lethal) score -= (30 + Math.min(75,cost*0.2)) * riskMul;
  score += Math.max(0,currentThreat.damage-risk.damage) / Math.max(1,def.maxHp) * 25;

  /*
   * 两回合威胁（`TacticalMap.soon`）：下回合还够不着、下下回合就够得着的人，
   * 按半价计入。上面那两项罚的都是"眼前这一刀"，而人判断一个落点靠的是
   * "这波人要扑上来了"——六格外磨刀的重骑兵在旧算法里等于不存在，
   * 于是 AI 会站在开阔地中间，等它走到跟前才发现被围了。
   * 罚得比眼前那一刀轻（同样的伤害在这里只算 12~42 分），够用它躲开空地就行。
   */
  const soonRisk = all.tactical.soon(moved, killed);
  // 这一项也要跟着 `riskAversion` 走：只管"眼前这一刀"的话，0 档仍然会被
  // "下下回合够得着"劝退，冲不进去。
  score -=
    (Math.max(0, soonRisk.damage - risk.damage) / Math.max(1, def.maxHp)) *
    (12 + Math.min(30, cost * 0.1)) *
    riskMul;

  if (all.needBridge && all.bridgeSite) score += (distance(unit,all.bridgeSite)-distance(moved,all.bridgeSite))*4;
  /*
   * 分流的编队朝**自己的渡口**走（+8/格，比主渡口的 4 更强）。
   *
   * 主渡口那条只在 `needBridge` 时生效；分流发生在"已经能过河、只是挤"的时候，
   * 所以必须单独给一条，否则被分出去的那支会被推进评分拽回主桥头。
   */
  if (all.crossingAlt?.unitIds.has(unit.id)) {
    const alt = all.crossingAlt;
    score += (distance(unit, alt) - distance(moved, alt)) * 8;
  }
  /*
   * 建造编队朝**计划给的点**走（+20/格，强引导）。
   *
   * 为什么比战斗编队的 8 更强：工人的普通评分里"往桥头挪一格"只有 4~6 分，
   * 而"再干点别的建造"很容易更高——不压过去的话，计划指了渡口，工人还在
   * 半路修采石场。这也是用户 2026-11-22 说的"不要让它按分数乱走"。
   */
  if (all.buildGuide?.unitIds.has(unit.id)) {
    const g = all.buildGuide;
    score += (distance(unit, g) - distance(moved, g)) * 20;
  }
  /*
   * 给造桥点让路（只在真的过不去时）：非工程单位停在桥点周围 2 格里，
   * 工程队就永远进不去。已经在里面的不罚——那是"离开"，不是"靠近"。
   */
  if (all.bridgeClear.size > 0 && def.category !== 'builder') {
    const here = all.bridgeClear.has(unit.y * s.w + unit.x);
    const there = all.bridgeClear.has(y * s.w + x);
    if (there && !here) score -= 32;
  }
  for (const city of s.cities) {
    if (!city.ruined || city.id === all.mood.abandonedCityId) continue;
    const affordable = s.players[unit.owner].gold >= rebuildCost(city);
    const a = distToCity(unit,city), b = distToCity(moved,city);
    score += (a-b)*(affordable ? 35 : 4);
    if (b===0) score += affordable ? (city.owner===unit.owner ? 150 : 220) : -200;
  }
  if (w.harass > 0 && def.category === 'combat') {
    const prey = enemyUnitsOf(s, unit.owner).filter(e => {
      const d = utype(s,e.type);
      return economicYield(d)>0 || d.category==='builder' || isProducer(d);
    }).sort((a,b) => distance(unit,a)-distance(unit,b))[0];
    if (prey && distance(unit,prey)<=12) score += (distance(unit,prey)-distance(moved,prey))*4*w.harass;
  }
  const keep = citiesOf(s,unit.owner).filter(c => !c.ruined && c.id!==all.mood.abandonedCityId);
  if (keep.length && (all.mood.abandonedCityId || all.pullHome > 0.3)) {
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

/**
 * 走位总分 = 底层分 − "入界费"。
 *
 * 底层那套（`scoreMoveInner`）里，`exposure` 算的是"站在这儿每回合挨多少"；
 * 2026-11-11 起建筑改成"敌人踏进射程就立刻开火"，于是"走进射程"多了一笔
 * **当场结算**的支出。两个口径补上，AI 才会像人一样：能绕就绕一格，
 * 绕不开（或者已经决定强攻）就硬吃。
 *
 * 收费只收一次（`entryToll` 只算新进入的射程），所以站在塔边上不会每格都扣，
 * 也就不会把 AI 压成不敢挪窝的乌龟；`all.commit`（全军压城）时一律免单——
 * 那时候队形比省一发子弹重要。
 */
function scoreMove(
  s: GameState,
  unit: Unit,
  x: number,
  y: number,
  all: Fields,
  traits: AiTraits,
): number {
  const base = scoreMoveInner(s, unit, x, y, all, traits);
  if (base <= -900) return base; // 已经判死（进不去/必被拒绝），不用再算钱
  const def = utype(s, unit.type);
  if (def.category === 'building') return base; // 建筑不动，这条是给走子用的
  if (all.commit) return base;
  const toll = all.tactical.entryToll(unit, x, y);
  return toll > 0 ? base - Math.min(8, toll * 0.6) : base;
}

function scoreMoveInner(
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
      /*
       * 工程队往渡口走。原来这里有一道 `mine < 6` 的闸（"桥够多了就别修了"），
       * 它和造桥那两条上限是同一个病：靠数桥数代替"过没过去"。
       * 现在桥只由过河计划修，工程队只认那个渡口，闸没有对象了。
       */
      const site = all.bridgeSite;
      if (site) {
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

    const foes = enemyUnitsOf(s, unit.owner);
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
  score *= 1 + 0.45 * aggr - 0.3 * all.mood.driveRaw.boom;

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
    score += 30 * (1 + 0.5 * all.mood.driveRaw.rush);
  }

  // 挪过去就能攻城 → 更值（攻城是唯一通向胜利的路，比多打掉一个兵重要）
  // 速攻对这条的溢价最高：它整局的胜负就压在一次成功的围城上。
  if (canAttack(unit) && !engagedNow && siegeTargets(s, moved).length > 0) {
    score += 44 * (1 + 0.7 * all.mood.driveRaw.rush);
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
  // （实测蒸汽骑兵交换比 0.45、每百金杀伤 10.1，连步枪兵的三分之一都不到）。
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
      const brawlers = enemyUnitsOf(s, unit.owner).filter(
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
  if (all.mood.driveRaw.harass > 0.12 && def.category === 'combat' && def.domain !== 'water') {
    let prey: Unit | null = null;
    let pd = Infinity;
    for (const e of enemyUnitsOf(s, unit.owner)) {
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
  if (all.mood.driveRaw.boom > 0.12 && def.category === 'combat' && def.domain !== 'water') {
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
  if (all.pullHome > 0) {
    const mine = citiesOf(s, unit.owner);
    if (mine.length > 0) {
      const before = Math.min(...mine.map((c) => distToCity(unit, c)));
      const after = Math.min(...mine.map((c) => distToCity({ x, y }, c)));
      // 强度由排序层的 `defend` 计划给（0~1），乘在每格 6 分上
      if (after > before) score -= (after - before) * 6 * all.pullHome;
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

/**
 * 「国王 + 精英骑兵」的采购配合：王命每回合把身边的精英骑兵晋成皇家骑兵。
 *
 * 这是这个包里少有的明确 A+B 组合，但采购评分一直是"单卡 argmax"：
 * 它不知道买了骑兵会白得一次换装，也不知道买了国王得有人给他晋。
 * 实测 200 局选卡里这两张从没落在同一方，所以这条配合在线上**从未被用过**。
 *
 * 为什么判据写死兵种 id、而不是去读「王命」的钩子：钩子里没有"我强化谁"这种
 * 声明（它拿到全场的单位自己筛），在 AI 里重读一遍等于把规则抄第二份。
 * 代价是改 id 要回来改这里——所以开头先用 s.unitTypes 的存在性做闸门：
 * 没开这个包 / 这局没有这两个兵种时，整条一分不加。
 *
 * 分值怎么定的：
 *   · 有国王之后的精英骑兵 +24（一匹 125 金的骑兵白换一匹皇家骑兵，
 *     比同价位的任何加成都大，但还没大到能压过"缺前排"这类结构性缺口）；
 *   · 国王自己 +20/+12（按已有骑兵数），因为它的价值有一半在王命上；
 *   · 两边都没到位时给 6~8 分的"起手费"，否则会卡在互相等待的死锁里：
 *     没国王就不买骑兵、没骑兵就不买国王。
 */
function royalComboBonus(
  s: GameState,
  me: PlayerId,
  d: UnitTypeDef,
  mine: readonly Unit[],
  src: { x: number; y: number },
): number {
  const KING = 'royal-king';
  const CAV = 'elite-cavalry';
  if (d.id !== KING && d.id !== CAV) return 0;
  if (!s.unitTypes[KING] || !s.unitTypes[CAV]) return 0;

  let kings = 0;
  let cavs = 0;
  // 国王得在产兵点附近才值得买骑兵：王命只管自己半径 2 内的骑兵。
  // 从地图另一头的城买出来的骑兵，走不到国王身边就不会晋升——
  // 那不是"配合"，那是花 125 金买一匹没人管的轻骑。
  let kingNear = false;
  for (const u of mine) {
    if (u.type === KING) {
      kings += 1;
      if (Math.max(Math.abs(u.x - src.x), Math.abs(u.y - src.y)) <= 4) kingNear = true;
    } else if (u.type === CAV) cavs += 1;
  }
  if (d.id === CAV) {
        // 80 这个数是量出来的，不是拍的：36 的时候它一次都没买过（同期它在买火枪兵、
    // 臼炮、凤凰），80 之后 20 回合买了 2 匹，而且这两匹在两个回合内都被王命
    // 晋成了皇家骑兵——正好是"量产、但不到刷屏"的那个量级。
    if (kings > 0 && kingNear) return 80;
    if (kings === 0 && canUseType(s, me, KING)) return 8;
    return 0;
  }
  if (cavs >= 2) return 20;
  if (cavs === 1) return 12;
  return canUseType(s, me, CAV) ? 6 : 0;
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
  const foes = enemyCitiesOf(s, owner);
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
  for (const e of enemyUnitsOf(s, unit.owner)) {
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


/* ══════════════════════════════════════════════════════════════════
 * 产业链目标（见 core/ai-goal.ts）
 *
 * 核心自己的两条链（海军、装甲）也走这张表，不给核心留特例。
 * 这里只放"怎么把局面读成目标要的样子"，不放任何具体产业链的规则。
 * ══════════════════════════════════════════════════════════════════ */

/** 水上产兵点的判据：写在数据里（`buildOn` 有水），不写死兵种 id */
function onWaterDef(def: UnitTypeDef): boolean {
  return (def.buildOn ?? []).some((t) => t === 'water' || t === 'shallow' || t === 'deep');
}

/** 把局面读成目标要的样子。每次决策算一次，别让每个目标各算一遍 */
function goalCtxOf(
  s: GameState,
  me: PlayerId,
  era: number,
  urgent: boolean,
  threat: number,
  commit: AiCommit | null,
  scarce: ReadonlySet<string> = new Set(),
): AiGoalCtx {
  const mine = unitsOf(s, me);
  const cities = citiesOf(s, me);
  return {
    state: s,
    me,
    era,
    urgent,
    threat,
    commit,
    scarce,
    cityCount: cities.length,
    count: (pred) => mine.filter((u) => pred(utype(s, u.type))).length,
    buildSpots: (buildId, builder) => buildSpots(s, builder, s.unitTypes[buildId]),
    inDanger: (x, y) => inDanger(s, me, x, y),
    dist: (a, b) => distance(a, b),
    distToNearestCity: (p) => {
      let best = Infinity;
      for (const c of cities) best = Math.min(best, distance(p, c));
      return best;
    },
  };
}

/**
 * AI 的跨回合记忆：读写都走这两个函数。
 *
 * 2026-11-20 把 `aiIntent`（攒钱目标）和 `aiCommit`（产业链承诺）合到一个
 * `aiFocus` 里——它们本来就是同一个问题的两半，分开存的时候两处各搬一次
 * （雾图副本 → 真状态），漏一处就是"攒到一半忘了"。
 *
 * 老存档里只有 `aiIntent` / `aiCommit`：读的时候回落，写的时候只写 `aiFocus`。
 */
function focusOf(s: GameState, me: PlayerId): AiFocus {
  const f = s.aiFocus?.[me];
  if (f) return f;
  return {
    save: s.aiIntent?.[me] ?? null,
    chain: s.aiCommit?.[me] ?? null,
  };
}

function setFocus(s: GameState, me: PlayerId, f: AiFocus | null): void {
  /*
   * 不比较"有没有变就跳过写"：`cost` / `since` / `seen` 每回合都会刷新，
   * 漏写它们会让 `INTENT_TURNS` 的新鲜度判断走偏（实测指纹会变）。
   * 一次对象分配换"行为和搬迁前逐字一致"，值。
   */
  const bag = { ...(s.aiFocus ?? {}), [me]: f ?? {} };
  s.aiFocus = bag;
  // 旧字段随之清掉，免得"新的写了、旧的还在"两套记忆打架
  if (s.aiIntent?.[me]) {
    const b = { ...s.aiIntent };
    delete b[me];
    s.aiIntent = b;
  }
  if (s.aiCommit?.[me]) {
    const b = { ...s.aiCommit };
    delete b[me];
    s.aiCommit = b;
  }
}

/**
 * 这个建筑是不是某个**正在推进中**的产业链目标当前要建的东西。
 *
 * 和 `goalBuildScore` 分开是因为它有两个用处：算分（那个）和判断"能不能让路"
 * （`scoreBuild` 里过河压制要不要减半）。合成一个函数会让后者为了一个布尔
 * 去算一遍分数，读起来莫名其妙。
 */
function goalClaimsBuild(
  s: GameState,
  unit: Unit,
  buildId: string,
  era: number,
  urgent: boolean,
  threat: number,
  commit: AiCommit | null,
  scarce: ReadonlySet<string>,
): boolean {
  return goalClaimsBuildOf(s, unit.owner, buildId, era, urgent, threat, commit, scarce);
}

/** 同上的 owner 版本：攒钱那一层只有 PlayerId，没有具体建造者 */
function goalClaimsBuildOf(
  s: GameState,
  me: PlayerId,
  buildId: string,
  era: number,
  urgent: boolean,
  threat: number,
  commit: AiCommit | null,
  scarce: ReadonlySet<string>,
): boolean {
  const def = s.unitTypes[buildId];
  if (!def) return false;
  const ctx = goalCtxOf(s, me, era, urgent, threat, commit, scarce);
  for (const { step } of goalStepsInPlay(ctx)) {
    if (step.claimsBuild?.(def)) return true;
  }
  return false;
}

/**
 * 这个建筑归不归某个产业链管：归就返回分数，不归返回 null。
 *
 * 返回 `-999` 表示"归某个目标管，但它现在不该建"（前置没完成、离城太远、
 * 这一档的产物一条都造不了）。这个返回值必须和以前一样**在这里就拦住**：
 * 让 AI 提一个必被规则拒的动作，执行方会中断整回合。
 */
function goalBuildScore(
  s: GameState,
  unit: Unit,
  buildId: string,
  spot: { x: number; y: number; terrain: Terrain },
  era: number,
  urgent: boolean,
  threat: number,
  commit: AiCommit | null,
  scarce: ReadonlySet<string>,
): number | null {
  const def = s.unitTypes[buildId];
  if (!def) return null;
  const ctx = goalCtxOf(s, unit.owner, era, urgent, threat, commit, scarce);
  /*
   * "归不归目标管"和"现在轮不轮到它"是两件事，必须分开判（2026-11-20 修）。
   *
   * 原来只遍历**在推进中**的段，于是"某条链还卡在前一步"时，后面那一步管的
   * 建筑会**漏回通用评分**——修真链实测：宗门抢在灵田前面建起来了，
   * 因为它掉进了"军营/产兵点"那条通用线。
   *
   * 现在的语义：只要某个目标的**任何一段**认领了这个建筑，它就归目标管；
   * 只有当前在推进的那一段才能给出分数，其余一律 -999（现在别建）。
   */
  const claimsIt = allAiGoals().some((g) => g.steps.some((st) => st.claimsBuild?.(def)));
  let claimed = false;
  let best: number | null = null;
  for (const { step, committed } of goalStepsInPlay(ctx)) {
    if (!step.claimsBuild?.(def)) continue;
    claimed = true;
    let v: number | null = null;
    try {
      v = step.buildScore ? step.buildScore(ctx, buildId, spot, def) : DEFAULT_GOAL_BUILD_SCORE;
    } catch (err) {
      unitAiWarn(`goal-build:${buildId}`, `[ai-goal] 目标算「${buildId}」的分数时抛错，按不建处理：${String(err)}`);
      v = null;
    }
    if (v === null) continue;
    // 已经在追的那一段再加一把：让它不至于"每回合重新竞争"被挤掉
    const scored = committed ? v + COMMIT_BUILD_BONUS : v;
    best = best === null ? scored : Math.max(best, scored);
  }
  if (!claimed) return claimsIt ? -999 : null;
  return best === null ? -999 : best;
}

/**
 * 买这个兵，产业链给多少分。
 *
 * 和 `goalBuildScore` 同一个形状，只是管的是兵种：目标说"为了这条链，
 * 这个兵值得优先买"，采购那边把它加到自己的分上，剩下照旧参与比较。
 * **没有插队**——加了分也可能输给更该买的东西。
 */
function goalUnitBonus(c: AiGoalCtx, def: UnitTypeDef): number {
  let best = 0;
  for (const { step, committed } of goalStepsInPlay(c)) {
    if (!step.claimsUnit?.(def)) continue;
    const v = step.unitScore ?? DEFAULT_GOAL_UNIT_SCORE;
    const scored = committed ? v + COMMIT_BUILD_BONUS : v;
    if (scored > best) best = scored;
  }
  return best;
}

/* ══════════════════════════════════════════════════════════════════
 * 节奏判断：现在该打，还是该发展？（2026-11-20）
 *
 * 人类的算法（用户原话，2026-11-20）：
 *
 *   「当自己的单位走到敌方城市的时间 > 自己提升一个时代需要的耗时时，
 *     就默认进攻部队到达时会面临高一个时代的反击，就不进攻，
 *     专注造经济单位提升经济产出。」
 *
 * 三处必须做对，不然这条规则会误判：
 *
 *   1. **距离用距离场**（`distanceFields`），不是直线除以移动力——
 *      绕山绕水走的路比直线长得多，直线会把"该发展"算成"该打"。
 *   2. **"我方部队"取最近的那一批能形成战斗力的**（`PACE_STRIKE_GROUP` 个），
 *      不是全体中位数：先到的那两三个就是去送死的。
 *   3. **升级耗时要带上"造经济单位的加速度"**，不能拿 `(费用 − 现金) ÷ 收入`
 *      一除了事——投进经济的钱会抬高收入，剩下的时间比这个数短。
 *      `projectedTurnsToEra` 就是干这个的。
 * ══════════════════════════════════════════════════════════════════ */

/** 算"我军多久能到"时取最近几个战斗单位（凑成一支能打的） */
const PACE_STRIKE_GROUP = 3;
/**
 * 每 1 金投进经济，每回合能多回多少（一阶估计）。
 *
 * 参考值：农民/工人 50~60 金、好地形上 5~7 金/回合 → 0.10 上下。
 * 这个数只影响"加速度有多陡"，不影响方向；`--verbose` 会把两种算法并排打出来。
 */
const ECON_YIELD_PER_GOLD = 0.1;
/** 投影最多看多少回合（超过这个数就当"够不着"） */
const PACE_HORIZON = 30;

export interface AiPace {
  /** 最近那批战斗单位走到敌城要几回合（距离场口径） */
  walk: number;
  /** 攒到升一代要几回合（老口径，一除到底） */
  eraFlat: number;
  /** 同上，但算上"把钱投进经济 → 收入变高"的加速度 */
  eraProjected: number;
  /** 结论：该打还是该发展 */
  verdict: 'fight' | 'develop';
}

/** 我方战斗单位里"最近的那一批"到敌城还剩几回合（距离场） */
function strikeWalkTurns(view: GameState, me: PlayerId, fields: Map<string, number[]>): number {
  const mine = unitsOf(view, me).filter((u) => utype(view, u.type).category === 'combat');
  if (mine.length === 0 || fields.size === 0) return Infinity;
  const per: number[] = [];
  for (const u of mine) {
    const idx = u.y * view.w + u.x;
    let best = Infinity;
    for (const f of fields.values()) {
      const d = f[idx];
      if (typeof d === 'number' && d >= 0 && d < best) best = d;
    }
    if (Number.isFinite(best)) per.push(best / Math.max(1, utype(view, u.type).move ?? 1));
  }
  if (per.length === 0) return Infinity;
  per.sort((a, b) => a - b);
  // 最近的那一批取平均：单个最快不代表部队能到，全取又会被后方部队拖平
  const group = per.slice(0, Math.min(PACE_STRIKE_GROUP, per.length));
  return group.reduce((n, x) => n + x, 0) / group.length;
}

/**
 * 攒到下一代的回合数，**带加速度**。
 *
 * 老口径 `(费用 − 现金) ÷ 收入` 假设收入不变；实际上钱投进经济会抬高收入，
 * 所以真实时间更短。这里按"每回合把一份收入投进经济"往前滚：
 * 收入每回合涨 `投入 × ECON_YIELD_PER_GOLD`。
 */
function projectedTurnsToEra(s: GameState, me: PlayerId, cost: number, inc: number): number {
  const inc0 = Math.max(1, inc);
  if (s.players[me].gold >= cost) return 0;
  let gold = s.players[me].gold;
  let income = inc0;
  for (let t = 1; t <= PACE_HORIZON; t += 1) {
    gold += income;
    if (gold >= cost) return t;
    // 攒的同时留一份收入继续投经济（这才是"加速"的来源）
    const invest = Math.min(gold, income);
    gold -= invest;
    income += invest * ECON_YIELD_PER_GOLD;
  }
  return Infinity;
}

/**
 * 现在该打还是该发展。
 *
 * 没得升级（封顶）或升不起（费用拿不到）时按 `Infinity` 处理 → 判"该打"，
 * 因为这时候没有"发展"这条路可走。
 */
export function paceOf(s: GameState, me: PlayerId): AiPace {
  const fields = distanceFields(s, me, 'advance');
  const walk = strikeWalkTurns(s, me, fields);
  const city = citiesOf(s, me).find((c) => !c.ruined) ?? null;
  const cost = city ? upgradeCostOf(s, city) : null;
  const inc = Math.max(1, incomeResOf(s, me).gold ?? 0);
  if (cost === null) {
    return { walk, eraFlat: Infinity, eraProjected: Infinity, verdict: 'fight' };
  }
  const eraFlat = Math.max(0, cost - s.players[me].gold) / inc;
  const eraProjected = projectedTurnsToEra(s, me, cost, inc);
  return { walk, eraFlat, eraProjected, verdict: walk > eraProjected ? 'develop' : 'fight' };
}

/**
 * 「海军」：这张图有水、陆路又绕不过去，就攒一支舰队。
 *
 * 分数与判据**逐字照搬**自 `rawBuildScore` 里原来那段（2026-11-20 迁移），
 * 包括那条标定历史——44 分排不上、244 分过头、70 分每局一座。
 * 迁移的唯一目的是让"加一条新产业链"不用再回 `ai.ts` 改分支。
 */
const NAVY_GOAL: AiGoal = {
  id: 'navy',
  value: (c) => seaDemand(c.state, c.me),
  steps: [
    {
      id: 'shipyard',
      // 上限按城市数给、最多两座：一座够一支舰队出门，两座是"两线同时下水"
      done: (c) => {
        const cap = Math.min(2, Math.max(1, Math.floor(c.cityCount / 2)));
        return c.count((d) => isProducer(d) && onWaterDef(d)) >= cap;
      },
      claimsBuild: (d) => isProducer(d) && onWaterDef(d),
      buildScore: (c, _buildId, spot, def) => {
        // 船是奢侈品的时候造船坞，等于把钱埋进水里
        const sea = seaDemand(c.state, c.me);
        if (sea <= 0) return null;
        // 落成即废的那几档：白名单里全是更高代的船，现在修好也下不了水
        const usable = produceUsableCount(def, c.state.unitTypes, c.era || def.era);
        if (usable !== null && usable <= 0) return null;
        if (c.cityCount === 0) return null;
        // 离自家城市太远就没有意义：只是多一个被顺手拆掉的目标
        const nearOwn = c.distToNearestCity(spot);
        if (nearOwn > 10) return null;
        const docks = c.count((d) => isProducer(d) && onWaterDef(d));
        // 海上工地会挨舰炮，但没有陆上工地那么致命（水面上摸过来的兵少）
        const risky = c.inDanger(spot.x, spot.y);
        /*
         * 基准 70 → 95（2026-11-20，迁进目标表时重标的）。
         *
         * 70 是当年定的，那时它的对手是"工程兵朝桥头挪一格"（四十几分）。
         * 现在桥拿的是 `needBridge` +24 和"接上自己那截" +26，分数到了八十几，
         * 70 分连一次都排不上。实测 4 局 20×20 纵河（海军包）：
         *   · 70 分 + 过河压制 −20 → 船坞 0 座
         *   · 95 分 + 过河压制 −10 → 船坞 2 座，桥和营的数量没变
         * 这仍然是"每局半座"的量级，不够多；但这是**真实需要**的问题
         * （城里本来就能造一部分 nv_ 船，船坞只是高阶船的门槛），
         * 不是靠继续加分数能解决的——再往上是拿桥换船坞。
         */
        return 95 + sea * 30 - nearOwn * 0.6 - docks * 45 - def.cost * 0.03 - (risky ? 12 : 0);
      },
    },
  ],
};

registerCoreGoal(NAVY_GOAL);
/**
 * 「装甲」：两段前置——先有电，再有坞。
 *
 * 分数与判据逐字照搬自 `armorSupportNudge`（2026-11-20 迁移）。原来那一段
 * 写在 `rawBuildScore` 的一个特判分支里，注释记着它为什么必须早于所有 −999：
 * 电站/坞不产兵、不产钱、不是桥，会掉进"工事/塔"那条线，而那条线要求
 * 离敌人 7 格内——老家后院的电站永远拿不到分，于是"没电 → 素体断电 →
 * 采购被挡 → 更不会盖电站"是一个死结。
 *
 * 迁移之后这个死结由**段内顺序**表达：第一段没完成时，电站就是当前那一步，
 * 排在所有 −999 之前；建好电站才轮到坞。
 */
const ARMOR_VALUE = (c: AiGoalCtx): number => {
  // 一台素体都没有、也还没到第 7 代：别把钱砸在基建上
  const frames = c.count((d) => d.armorFrame === true);
  return frames > 0 || c.era >= 7 ? 1 : 0;
};

/**
 * 电：没有任何电站时最急（70），已经有了但余电不足 40 时还值 40，其余不建。
 *
 * 注意电站和坞是**两条并行支线**，不是先后置。第一版把它们写成同一个目标的
 * 两段（先电后坞），实测坞从 4 座掉到 1 座——因为"余电不足"会让第一段长期
 * 不算完成，第二段永远排不上。而旧代码里两者各查各的条件，本来就是并行的。
 * 顺序链留给修真（宗门→藏经阁→研发，那是真的硬前置）。
 */
const ARMOR_POWER_GOAL: AiGoal = {
  id: 'armor-power',
  value: ARMOR_VALUE,
  steps: [
    {
      id: 'plant',
      done: (c) =>
        c.count((d) => (d.armorPower ?? 0) > 0) > 0 &&
        energyReport(c.state, c.me).headroom >= 40,
      claimsBuild: (d) => (d.armorPower ?? 0) > 0,
      // 最便宜的那一档电站要多少钱：钱不够时进"攒钱"那张表
      cost: (c) => {
        const plants = Object.values(c.state.unitTypes).filter((d) => (d.armorPower ?? 0) > 0);
        return plants.length > 0 ? Math.min(...plants.map((d) => d.cost ?? 0)) : 0;
      },
      saveScore: 10,
      buildScore: (c, _buildId, spot, def) => {
        const plants = c.count((d) => (d.armorPower ?? 0) > 0);
        const need = plants === 0 ? 70 : energyReport(c.state, c.me).headroom < 40 ? 40 : -25;
        if (need <= 0) return null;
        return 40 + need - (c.inDanger(spot.x, spot.y) ? 30 : 0) - def.cost * 0.01;
      },
    },
  ],
};

/** 坞：一座起步；素体多起来（每三台一座）再要第二座 */
const ARMOR_DOCK_GOAL: AiGoal = {
  id: 'armor-dock',
  value: ARMOR_VALUE,
  steps: [
    {
      id: 'dock',
      done: (c) => {
        const frames = c.count((d) => d.armorFrame === true);
        return c.count(isArmorDockDef) >= Math.max(1, Math.floor(frames / 3));
      },
      claimsBuild: isArmorDockDef,
      buildScore: (c, _buildId, spot, def) => {
        const frames = c.count((d) => d.armorFrame === true);
        const docks = c.count(isArmorDockDef);
        const need = docks === 0 ? (frames > 0 ? 65 : 35) : 10;
        if (need <= 0) return null;
        return 40 + need - (c.inDanger(spot.x, spot.y) ? 30 : 0) - def.cost * 0.01;
      },
    },
  ],
};


/**
 * 素体：这条链真正花钱、也真正打仗的一环。
 *
 * 原来是断的——电站盖了、坞盖了，**素体一台都不买**，于是整条链没有任何产出。
 * 原因很实在：素体面板 atk 只有 12~34（那只是撞击），按常规估值永远排不过
 * 同代步兵；而它的价值在"装上一门炮之后"，那件事采购评分看不见。
 *
 * 这里不做定价，只表达一句话："这条链需要它"。加 30 分是采购基准（50~70）
 * 的半档——够把素体从"排第五"抬到"排第一"，不够让更该买的东西翻盘。
 */
const ARMOR_FRAME_GOAL: AiGoal = {
  id: 'armor-frame',
  /*
   * **有电有坞才要素体**（2026-11-20 实测）：和采购里那两道门（没电 / 没坞可装）
   * 同一个判据。不加这一条会死锁——目标是按注册顺序抢并列的，素体排在电/坞
   * 前面就会一直"攒一台装不了炮的素体"，而电和坞永远排不上（实测 40 回合
   * 一台电站都没建，坞建了又被拆，素体 0）。
   *
   * 这条也让"顺序"回到了它该在的地方：素体是这条链的产出，不是起点。
   */
  value: (c) => {
    if (c.era < 7) return 0;
    const hasPower = c.count((d) => (d.armorPower ?? 0) > 0) > 0;
    const hasDock = c.count(isArmorDockDef) > 0;
    return hasPower && hasDock ? 1 : 0;
  },
  steps: [
    {
      id: 'frames',
      // 两台起：一台装不了"多兵种配合"，两台才谈得上编成
      done: (c) => c.count((d) => d.armorFrame === true) >= 2,
      claimsUnit: (d) => d.armorFrame === true,
      unitScore: 30,
      // 最便宜的那台素体要多少钱
      cost: (c) => {
        const frames = Object.values(c.state.unitTypes).filter((d) => d.armorFrame === true);
        return frames.length > 0 ? Math.min(...frames.map((d) => d.cost ?? 0)) : 0;
      },
      saveScore: 12,
    },
  ],
};

registerCoreGoal(ARMOR_FRAME_GOAL);

/* ══════════════════════════════════════════════════════════════════
 * 资源缺口：缺粮/缺材/缺灵石时，去建**产出那种资源**的建筑（2026-11-20）
 *
 * ── 为什么需要它 ──────────────────────────────────────────────
 *
 * 实测（城郭与物料，24×24 三局）：AI 会建粮仓和采石场，但**建得太多**——
 * 某一局粮食存量 666、建材 1543，还在继续修采石场。因为通用经济评分只问
 * "这一格能产多少值多少分"，从来不问"我还缺吗"，堆到"每城两座"的上限为止。
 *
 * ── 它怎么做到不认识扩展 ─────────────────────────────────────
 *
 * 三样全是数据：
 *   · **缺什么**：把这一局所有非金币资源（从兵种表的 `costRes` 里扫出来）
 *     逐个比对"存量 vs 每回合收入"；
 *   · **谁能产**：建筑的 `yield` / `yieldByTerrain` 里有没有那种资源；
 *   · **这格值多少**：`unitYield` 探针（和通用经济评分同一把尺子）。
 *
 * 核心不认识"粮食""灵石"这些词，只认识"资源 id"和"产出表"。
 * ══════════════════════════════════════════════════════════════════ */


/** 这一局所有**非金币**资源（从兵种成本表里扫，不写死名字） */
function resourcesInPlay(s: GameState): string[] {
  const out = new Set<string>();
  for (const def of Object.values(s.unitTypes)) {
    for (const id of Object.keys(def.costRes ?? {})) if (id !== 'gold') out.add(id);
  }
  return [...out];
}

/**
 * 现在哪些资源"供不上"：**比上次回合开始时少了**。
 *
 * 判据是趋势而不是绝对值，理由见 `GameState.aiResMark`：
 * 引擎没有"每回合消耗多少"的流量概念，只能看库存怎么变。
 * 试过的另外两版都失败（留档 T18）：按"存量 < 收入×3"会形成反馈环
 * （建了产出 → 收入变高 → 门槛变高 → 永远缺），按"产出为 0"又太保守
 * （经济单位本来就产一点，永远不等于 0）。
 */
function scarceResources(
  s: GameState,
  me: PlayerId,
  mark: { turn: number; stock: Record<string, number> } | undefined,
): Set<string> {
  const out = new Set<string>();
  if (!mark) return out; // 第一回合没有可比的对象
  const stock = (s.players[me].res ?? {}) as Record<string, number | undefined>;
  for (const id of resourcesInPlay(s)) {
    const now = stock[id] ?? 0;
    const before = mark.stock[id] ?? 0;
    // 掉了一点就算"供不上"：上限压一压，免得国库几千时波动也触发
    if (now < before - 1 && now < 320) out.add(id);
  }
  return out;
}

/** 这个建筑产出哪种非金币资源（取产出表里最大的那一项） */
function producedResourceOf(def: UnitTypeDef): string | null {
  const best = (bag: Record<string, number> | undefined): string | null => {
    if (!bag) return null;
    let id: string | null = null;
    let n = 0;
    for (const [k, v] of Object.entries(bag)) {
      if (k === 'gold' || v <= n) continue;
      id = k;
      n = v;
    }
    return id;
  };
  return best(def.yield as Record<string, number> | undefined);
}

const RESOURCE_GAP_GOAL: AiGoal = {
  id: 'resource-gap',
  value: (c) => (c.scarce.size > 0 ? 1 : 0),
  steps: [
    {
      id: 'producers',
      done: (c) => c.scarce.size === 0,
      // 认领所有"产非金币资源"的建筑：只有缺的时候才放行
      claimsBuild: (d) => producedResourceOf(d) !== null,
      buildScore: (c, _buildId, spot, def) => {
        const scarce = c.scarce;
        const res = producedResourceOf(def);
        if (!res) return null;
        // 不缺这一种（哪怕缺别的）就别建它
        if (!scarce.has(res)) return null;
        const probe: Unit = {
          id: 'ai-res-probe',
          type: def.id,
          owner: c.me,
          x: spot.x,
          y: spot.y,
          hp: def.maxHp,
          kills: 0,
          moved: true,
          acted: true,
        };
        const inc = resourceValue(c.state, c.me, unitYield(c.state, probe));
        // 这一格产不出东西就别提（和通用经济评分同一条口径）
        if (inc <= 0) return null;
        return inc * 4 + 8;
      },
    },
  ],
};

registerCoreGoal(RESOURCE_GAP_GOAL);
registerCoreGoal(ARMOR_POWER_GOAL);
registerCoreGoal(ARMOR_DOCK_GOAL);


/**
 * 建造评分。
 *
 * ⚠️ **要给某套内容加"AI 会建它"，不要在这里加 if。**
 * 写一个 `AiGoal`（见 `docs/GUIDE-AI-GOAL-2026-11-20.md`），
 * 这个函数只负责把目标给的分接进来。
 */
function rawBuildScore(
  s: GameState,
  unit: Unit,
  buildId: string,
  spot: { x: number; y: number; terrain: Terrain },
  land: Map<string, number[]>,
  mood?: AiMood,
  /**
   * 这张图值不值得养海军（`Fields.sea`）。
   *
   * 2026-11-20 之后**这个函数自己不用它了**：水上产兵点归 `NAVY_GOAL` 管，
   * 那边会自己问一次 `seaDemand`（有 memo，同一回合问几次都只算一遍）。
   * 参数留着是因为调用方按位置传，删掉要改三处，收益为零。
   */
  _sea = 0,
  /** 局势现在打在第几代（Fields.era），只有带白名单的产兵点读它 */
  era = 0,
  /** 局面吃紧（Fields.urgent）：攒钱这时候不该继续 */
  urgent = false,
  /** 威胁值（Fields.threat）：产业链靠它决定要不要放弃投资 */
  threat = 0,
  /** 哪些非金币资源供不上（Fields.scarce） */
  scarce: ReadonlySet<string> = new Set(),
  /** 这一势力正在追的产业链（Fields.goalCommit） */
  goalCommit: AiCommit | null = null,
  /** 过河计划钉住的渡口（Fields.crossingSite）：走廊上的桥不吃数量上限 */
  crossingSite: { x: number; y: number } | null = null,
): number {
  const def = s.unitTypes[buildId];
  if (!def) return -999;

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

  /*
   * 装甲基建（电站 / 装配坞）**必须在这里就分出去**。
   *
   * 它们不 autoAttack、不产兵、不产钱、不是桥，于是会掉进下面"工事/塔"那条线，
   * 而那条线要求"离敌人 7 格内"——老家后院的电站永远拿不到分，直接 -999。
   * 结果是：AI 一台素体都造不出来的死结（没电 → 素体全断电 → 采购被挡 →
   * 更不会盖电站）。这一条是打这个死结的唯一位置：早于所有 -999。
   *
   * 2026-11-20：分数搬进 `ARMOR_GOAL`（两段前置：先电、后坞）。
   * 这里只留"归目标管"的那一句。
   */
  if (ARMOR_SUPPORT_BUILDINGS.has(buildId)) {
    const goalScore2 = goalBuildScore(s, unit, buildId, spot, era, urgent, threat, goalCommit, scarce);
    return goalScore2 ?? -999;
  }

  /*
   * 桥：**只给过河计划修**。
   *
   * 2026-11-21：以前这里是"逐回合打分 + 两道数量上限 + 一条工程队闸"，
   * 三个补丁各管一头，合起来的结果是"铺到河心就不铺了"，而没计划的时候
   * 又会在后院水塘上乱铺。现在反过来：**没有过河计划就不造桥**，
   * 有计划就由计划自己管到走通为止（`done` = 陆路可达）。
   *
   * 这就是那三个补丁退休的方式——不是删掉它们的数字，是删掉它们存在的理由。
   */
  if (def.bridges) {
    if (crossingSite === null) return -999;
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
    /*
     * 计划里的这条走廊不吃"铺够了"的上限。
     *
     * 上限是为了"别在河上摆家具"，但它不知道还有一条必须铺通的路：
     * 实测工程队铺到第 5 座就停，河心差最后一格，二十四个兵在岸边来回走。
     */
    // 渡口由排序层的过河计划给（见 `CROSSING_PLAN.focus`），不在这里自己算
    const onPlan = crossingSite !== null && distance(spot, crossingSite) <= 3;
    /*
     * 这里原来有一条硬上限："7 格内已有 5 座桥且不是接着自己桥面 → -999"。
     * 现在桥只在过河计划里修，走廊由计划管，这条上限没有对象了，删。
     * `near` 仍作为**软惩罚**留在分数里（-7/座）：一条河段上铺太多不划算，
     * 但那是算出来的，不是一刀切禁掉。
     */

    /*
     * 全局桥数上限：每城 3 座，最多 10 座。
     *
     * 这里本来是"这座桥到底缩不短路"的距离判据，第一版写错了，删掉换成了这一条。
     * 错在哪：它拿 `advance` 图（水量按"很贵但有限"计价）比较"站在我这儿"和
     * "过桥之后"——那张图**本来就能涉水过去**，所以对岸永远比脚下远一点，
     * 判据几乎恒真，等于"除非完全走不通，否则不许架桥"。实测铁器时代档因此
     * 从 7 胜 5 负掉到 4 胜 8 负（同一批种子，`results/ab-mi-*.json`）。
     *
     * 现在退回"按数量管"：不判断某座桥值不值，只限制总量。一座城市的设施区
     * 撑得住三座桥，再多就是在河上摆家具了。
     */
    /*
     * 全图总量上限（每城 3 座、最多 10 座）同样退休：理由和上一条一样，
     * 它防的是"没计划时乱铺"，而那种情况现在根本不会发生。
     */
    // 少铺几座优先；对岸越靠近敌方城市越值。
    // 档位加成：钢桥 120 耐久 / 6 护甲，被打塌要磨很久——同样一个建造回合，
    // 产出的是"不会下回合就被拆掉的路"，这才是打破"你拆我建"死循环的东西。
    return (
      58 -
      gap.steps * 9 -
      near * 7 +
      chain * 26 +
      (onPlan && !chain ? 14 : 0) +
      Math.max(0, 24 - gap.farDist) * 0.5 +
      (def.era - 1) * 5 -
      def.cost * 0.04 -
      /*
       * 架在对面枪口下：造一座、被拆一座，钱全填河。
       * 8 → 60（2026-11-21）：桥的基准分是 58，扣 8 等于没拦；
       * 实测 seed 34 一局造 12 座、被打掉 10 座。扣 60 让它只在本图
       * 别无他法（整条河都在射程内）时才冒险架桥。
       */
      (risky ? 60 : 0)
    );
  }

  /*
   * 水上产兵点（船坞 / 造船厂 / 海军船台）：**不跟军营共用一条线**。
   *
   * 这里只留一句"归产业链目标管"，具体分数搬到了下面的 `NAVY_GOAL`（2026-11-20）。
   * 判据仍然是数据（`buildOn` 里有水），核心不认识 `nv-dock` 这种 id。
   */
  const goalScore = goalBuildScore(s, unit, buildId, spot, era, urgent, threat, goalCommit, scarce);
  if (goalScore !== null) return goalScore;

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
    for (const e of enemyUnitsOf(s, unit.owner)) {
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
    const tooClose = Math.max(2, 4 - 1.6 * style + 1.2 * (mood?.driveRaw.boom ?? 0));
    if (nearFoe < tooClose) return -999;
    const peak = 7 - 2.2 * style + 2.4 * (mood?.driveRaw.boom ?? 0);
    const front = nearFoe <= 12 ? 34 - Math.abs(nearFoe - peak) * 3 : 6;
    // 高级营更贵，但要让它"贵得值"：耐久和火力都上一个台阶，
    // 在前线顶着的时候比多造一座廉价营有用
    const tier = (def.era - 1) * 5;
    return 52 + front + tier - nearOwn * 0.7 - mine * 16 - def.cost * 0.045
      + 10 * style - 14 * (mood?.driveRaw.boom ?? 0);
  }

  if (def.incomeByTerrain || def.income || def.yield || def.yieldByTerrain) {
    // 经济建筑：建在赚钱的地上才有意义。但被敌人威胁的位置是纯送钱——
    // 经济建筑 2 点护甲，对面一个民兵两下就拆了，还顺手带走建造者。
    if (risky) return -999;
    // 每座城两座经济建筑封顶。
    // 以前"建筑不占编制"之后，钱一多就变成满地的磨坊：模拟里青铜局 60 场盖了 682 座，
    // 场面像集市不像战场。经济建筑本身也会继续生钱，越盖越多，最后全在滚利息。
    const sameKind = unitsOf(s, unit.owner).filter((u) => u.type === def.id).length;
    if (sameKind >= Math.max(2, citiesOf(s, unit.owner).length * 2)) return -999;
    const probe: Unit={id:'ai-production-site',type:def.id,owner:unit.owner,x:spot.x,y:spot.y,hp:def.maxHp,kills:0,moved:true,acted:true};
    const inc=resourceValue(s,unit.owner,unitYield(s,probe));
    // 一格产出都没有的地盖上磨坊，产的是 0：这一回合纯亏
    if (inc <= 0) return -999;
    return inc * 4 - resourceValue(s,unit.owner,recruitResCost(s,unit.owner,def)) * 0.03;
  }

  /*
   * 载具建筑（火箭发射井）：AI 不会装人、不会加注、也不会发射。
   *
   * 它没有 autoAttack、不产兵、不生钱，落到下面"纯防御工事"那条线会被当成
   * 一堵墙——敌人压过来时花 420 金买一块永远飞不起来的场地。这是**护栏**，
   * 不是 AI 玩法：等 AI 那条线（别人负责）真的会登月了再放开。
   */
  if (def.carry?.hold && !def.autoAttack && !isProducer(def)) return -999;

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
    for (const e of enemyUnitsOf(s, unit.owner)) {
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
    for (const e of enemyUnitsOf(s, unit.owner)) {
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
/* ---------------------------------------------------------------------------
 * 装甲（时代 7 / 8）：AI 至少要会三件事——盖电站、买素体、给素体装炮
 *
 * 在这之前 AI 对这套东西一无所知，后果是"装甲时代"的包里它一台素体都不造：
 * 素体面板 atk 只有 12~34（那只是撞击），在采购评分里永远排在火枪兵后面。
 * 而且"造了也没用"：没电站 → 模块全断电；没坞 → 一件都装不上。
 * 三段一起补，缺一段这套内容在 AI 手里就是空的。
 * ------------------------------------------------------------------------ */

/** 装甲基建。它们既不产兵也不产钱，普通建造评分永远排不上 */
const ARMOR_SUPPORT_BUILDINGS = new Set(['armor_coal', 'armor_fusion', 'armor_dock', 'armor_yard']);

/** 装配坞（含升级档）：装甲基建里"不是电站"的那一半 */
function isArmorDockDef(d: UnitTypeDef): boolean {
  return ARMOR_SUPPORT_BUILDINGS.has(d.id) && (d.armorPower ?? 0) <= 0;
}


/**
 * 一台素体"装完之后"值多少分。
 *
 * 用老尺子的形状（每回合伤害 × √耐久）去和坦克比：坦克是 `78 × √260`。
 * 直接拿素体的 atk 去比是没意义的——那只是撞击，真正打的在武器里。
 */
function armorFrameScore(s: GameState, me: PlayerId, d: UnitTypeDef): number {
  const gold = s.players[me].gold;
  let best = 0;
  for (const m of Object.values(MODULES)) {
    if (!m.weapon) continue;
    if (m.frames && !m.frames.includes(d.id)) continue;
    if (m.excludeFrames?.includes(d.id)) continue;
    // 买不起的武器不算：否则 AI 会按"装着轨道炮的塔"去估值，然后买回来一台空壳
    if (m.cost > gold) continue;
    const perTurn = (m.weapon.damage * (m.weapon.shots ?? 1)) / (1 + (m.weapon.reload ?? 0));
    const power = perTurn * Math.sqrt(d.maxHp + (d.armor ?? 0) * 4);
    if (power > best) best = power;
  }
  const tank = 78 * Math.sqrt(260);
  return Math.min(34, (best / tank) * 46);
}

/** 最近的己方装配坞（含总厂） */
function nearestOwnDock(s: GameState, me: PlayerId, from: { x: number; y: number }): Unit | null {
  let best: Unit | null = null;
  let bestD = Infinity;
  for (const u of s.units) {
    if (u.owner !== me || u.hp <= 0) continue;
    if (u.type !== 'armor_dock' && u.type !== 'armor_yard') continue;
    const d = Math.max(Math.abs(u.x - from.x), Math.abs(u.y - from.y));
    if (d < bestD) {
      bestD = d;
      best = u;
    }
  }
  return best;
}

/** 这台素体现在最该装哪一件（null = 先不装） */
function bestModuleToMount(s: GameState, u: Unit): string | null {
  const def = utype(s, u.type);
  if (!def.armorFrame) return null;
  const armed = weaponsOf(u).length > 0;
  // 已经能打了：只有手头很宽裕才继续往上堆，别把回合都花在装配上
  if (armed && s.players[u.owner].gold < 700) return null;
  let best: { id: string; v: number } | null = null;
  for (const m of Object.values(MODULES)) {
    if (!canMount(s, u, m.id).ok) continue;
    const v = moduleValueForArmor(m);
    if (v <= 0) continue;
    if (!best || v > best.v) best = { id: m.id, v };
  }
  return best ? best.id : null;
}

/** 一件模块大致值多少：只用来排序，不进任何公式 */
function moduleValueForArmor(m: (typeof MODULES)[string]): number {
  if (m.weapon) {
    const perTurn = (m.weapon.damage * (m.weapon.shots ?? 1)) / (1 + (m.weapon.reload ?? 0));
    return (
      perTurn +
      (m.weapon.pierce ? 12 : 0) +
      (m.weapon.range >= 6 ? 8 : 0) +
      (m.weapon.splash ? 6 : 0)
    );
  }
  if (m.extraHp) return m.extraHp * 0.35 + (m.armor ?? 0) * 2;
  if (m.armor) return m.armor * 3;
  if (m.summon) return 16;
  if (m.aura) return 14;
  if (m.rangeBonus) return 12;
  if (m.power) return 10;
  if (m.charges) return 6 + m.charges * 2;
  if (m.move || m.moveIdle) return 7;
  if (m.steady) return 6;
  return 0;
}

/**
 * 这一发该用哪件武器：按"扣完甲之后每回合能打多少"挑。
 *
 * 不挑的话 `resolveArmorWeapon` 会退到"第一件能开火的"，于是装了防空炮
 * 又装加农的装甲会拿防空炮去打地面目标——动作被规则层拒掉，
 * 而 AI 的调度器遇到非法动作会中断整回合。
 */
function bestWeaponFor(s: GameState, u: Unit, target: Unit): string | null {
  const off = offlineModules(s, u);
  const air = isAirborne(s, target);
  const armor = utype(s, target.type).armor;
  const dist = strikeDistance(s, u, target);
  let best: { id: string; v: number } | null = null;
  for (const x of weaponsOf(u)) {
    if (off.has(x.id)) continue;
    const t = x.w.targets ?? 'both';
    if (t !== 'both' && (t === 'air') !== air) continue;
    if (dist > x.w.range) continue;
    const eff = x.w.pierce ? Math.floor(armor / 2) : armor;
    const per = Math.max(0, x.w.damage - eff) * (x.w.shots ?? 1);
    if (!best || per > best.v) best = { id: x.id, v: per };
  }
  return best ? best.id : null;
}

function scoreBuild(
  s: GameState,
  unit: Unit,
  buildId: string,
  spot: { x: number; y: number; terrain: Terrain },
  all: Fields,
): number {
  const rawBuildScoreValue = rawBuildScore(
    s, unit, buildId, spot, all.land, all.mood, all.sea, all.era,
    all.urgent, all.threat, all.scarce, all.goalCommit, all.crossingSite,
  );
  if (rawBuildScoreValue <= -900) return rawBuildScoreValue;
  // 战略姿态的"建造权重"：先在原始分上乘，再走下面那几条过河/产业的加减
  const raw = rawBuildScoreValue * all.weights.build;


  const canBridge = (utype(s, unit.type).builds ?? []).includes('bridge');

  // 过河阶段，"架桥"这个动作本身必须比"再往桥头挪一格"更值。
  //
  // 移动那边有个 42 分的常量（needBridge 时给），而桥的原始分只有三十几，
  // 于是工程队走到桥头就开始原地打转：每回合都能挪一格"离桥头一样近"的地方，
  // 分数比真的把桥架上去高。实测里两只工程队在河岸上转了八十回合，一座桥没架。
  if (all.needBridge && s.unitTypes[buildId]?.bridges) return raw + 24;

  if (all.needBridge && canBridge && !s.unitTypes[buildId]?.bridges) {
    /*
     * 过河阶段压别的建造，但不能一刀切：军营是"过了河立刻用得上"的东西，
     * 压满 45 分等于整条河岸一个产兵点都没有，兵只能从老家一趟趟往前线跑。
     *
     * 2026-11-20：**产业链目标当前要建的东西再让一档**。
     *
     * 实测（`diag-build --exp naval --map river-v`）：两局 20×20，49 次建造里
     * 40 次是桥，船坞一次都没有。船坞拿的是产兵点那档 −20，而桥在 `needBridge`
     * 时额外 +24、接上自己那截再 +26——两边分差只有个位数，工兵又全被桥占着，
     * 于是"过河"这个**临时战术需求**把一条**战略投资**永久压死了。
     *
     * 两者不是一回事：桥是这一回合的通行证，产业链是这一局的路线。所以目标
     * 认领的建筑只吃一半压制（−10），让它还有机会排上来，但绝不取消压制——
     * 真到了必须架桥的时候，桥仍然是第一位的。
     */
    const strategic = goalClaimsBuild(s, unit, buildId, all.era, all.urgent, all.threat, all.goalCommit, all.scarce);
    if (strategic) return raw - 10;
    return raw - (isProducer(s.unitTypes[buildId]) ? 20 : 45);
  }
  return raw;
}

/**
 * 把扩展的回答接进候选表。
 *
 * 三件事：调 handler、校验它提的动作、把分换算成"自主分 × 局部分"。
 * 注意这里**不排序、不插队**——加进去之后就交给后面那四道门（推演削分、
 * 分数≤0、随机带宽）统一处理。单兵 AI 不该有"后门"。
 *
 * 三层防御：
 *   · handler 抛错 → 记一次，按"没意见"处理（一个写坏的扩展不能把整局打死）；
 *   · 提了不该提的动作（替别的兵做主 / 招募 / 结束回合）→ 丢掉并告警；
 *   · 提了被规则拒过的动作 → 直接跳过（`rejected` 已经告诉我们了）。
 */
function unitAiCandidates(
  view: GameState,
  unit: Unit,
  own: Candidate[],
  rejected: ReadonlySet<string>,
  ai: UnitAiBinding,
  foes: Unit[],
  allies: Unit[],
): Candidate[] {
  const def = utype(view, unit.type);
  let out: UnitAiResult;
  try {
    out = ai.profile.handler({
      state: view,
      unit,
      def,
      api: abilityApi,
      candidates: own.map((c) => ({ action: c.action, score: c.score })),
      rejected,
      foes,
      allies,
    });
  } catch (err) {
    unitAiWarn(
      `crash:${ai.profile.id}`,
      `[unit-ai] profile「${ai.profile.id}」抛错了，这一步按"没意见"处理：${String(err)}`,
    );
    return [];
  }
  const list: Candidate[] = [];
  const take = (action: Action, score: number, ignoreRisk?: boolean): void => {
    const problem = unitAiActionProblem(action, unit.id);
    if (problem) {
      unitAiWarn(
        `bad:${ai.profile.id}:${problem}`,
        `[unit-ai] profile「${ai.profile.id}」提了不能执行的动作，已丢弃：${problem}`,
      );
      return;
    }
    if (!Number.isFinite(score)) {
      unitAiWarn(
        `nan:${ai.profile.id}`,
        `[unit-ai] profile「${ai.profile.id}」给了一个非数字的分（${String(score)}），已丢弃。`,
      );
      return;
    }
    if (rejected.has(aiActionKey(action))) return;
    list.push({ action, score, ignoreRisk });
  };
  for (const c of out.add ?? []) take(c.action, c.score * ai.autonomy, c.ignoreRisk);
  /*
   * `must` 不打折、也不吃推演那一刀。
   *
   * 不打折是因为它表达的不是"我偏好"，而是"剧本要求"；不吃刀是因为
   * "对面下一回合能打多疼"不该否决一段剧情——那会让作者写的流程时灵时不灵。
   */
  if (out.must) take(out.must.action, UNIT_AI_MUST_SCORE, true);
  return list;
}

/**
 * "走到能盖这个建筑的位置"——产业链目标的选址推手（T11）。
 *
 * ── 为什么要它 ──────────────────────────────────────────────
 *
 * 建造候选只看**当前站位周围**（`buildSpots`）。需要"紧贴某个建筑"的东西
 * （修真的藏经阁贴着宗门）就永远卡住：条件全齐、人也在，就差一格空地，
 * 而工人不会为了那一格走下去。实测执事在宗门旁边转了整局，藏经阁 0 座。
 *
 * ── 怎么做到不认识扩展 ─────────────────────────────────────
 *
 * 核心**不判断哪里好**，只做三件通用的事：
 *
 *   1. 扫一片格子（自己城市/建筑周围，不是全图）；
 *   2. 逐格问目标："在这儿盖这个建筑，值多少？"——`buildScore`，
 *      返回 `null` 的格子直接跳过，所以"贴宗门""建在水上"这些规则
 *      全由扩展自己表达，核心一个字都不知道；
 *   3. 挑最值的那一格，从可达格子里找一个能站着盖的位置，发一条 MOVE。
 *
 * 分数取"那一格的分 × 0.7"：**比真盖上低一档**——已经站在能盖的位置时，
 * BUILD 候选自然赢；走过去的收益只是"离那一步更近"。
 */
function goalApproachCandidate(
  s: GameState,
  unit: Unit,
  buildId: string,
  buildDef: UnitTypeDef,
  all: Fields,
): Candidate | null {
  const ctx = goalCtxOf(s, unit.owner, all.era, all.urgent, all.threat, all.goalCommit);
  const steps = goalStepsInPlay(ctx).filter((x) => x.step.claimsBuild?.(buildDef));
  if (steps.length === 0) return null;

  /*
   * 扫描范围：自己城市 + 自己建筑周围 10 格。
   * 不扫全图有两个原因：代价（每格一次 buildScore），以及"在敌人鼻子底下
   * 盖东西"本来就不该被鼓励——那类风险由 `buildScore` 里的 `inDanger` 扣。
   */
  const anchors = [...citiesOf(s, unit.owner), ...unitsOf(s, unit.owner).filter(
    (u) => utype(s, u.type).category === 'building',
  )];
  if (anchors.length === 0) return null;
  const R = 10;
  const seen = new Set<number>();
  let best: { x: number; y: number; score: number } | null = null;
  for (const a of anchors) {
    for (let dy = -R; dy <= R; dy += 1) {
      for (let dx = -R; dx <= R; dx += 1) {
        const x = a.x + dx;
        const y = a.y + dy;
        if (!inBounds(s, x, y)) continue;
        const key = y * s.w + x;
        if (seen.has(key)) continue;
        seen.add(key);
        const tile = s.tiles[key];
        if (!tile) continue;
        /*
         * **先问规则层这一格能不能建**。
         *
         * `buildScore` 只回答"值不值"，不回答"行不行"——它平时只被
         * `buildSpots`（已经过规则筛）的格子调用，所以返回 null 的是
         * "这个局面下建它没意义"，不是"这里不许建"。
         * 扫全图时必须补这一问，否则会朝一个盖不了的格子走过去。
         * 判据用 `buildSiteError`（和 doBuild 同一个函数），核心不需要
         * 知道"藏经阁要贴宗门"这种规则。
         */
        if (buildSiteError(s, buildDef, { ...unit, x, y }, x, y) !== null) continue;
        const spot = { x, y, terrain: tile.terrain };
        for (const { step } of steps) {
          let v: number | null = null;
          try {
            v = step.buildScore ? step.buildScore(ctx, buildId, spot, buildDef) : DEFAULT_GOAL_BUILD_SCORE;
          } catch {
            v = null;
          }
          if (v === null || v <= 0) continue;
          if (!best || v > best.score) best = { x, y, score: v };
        }
      }
    }
  }
  if (!best) return null;

  // 已经能盖了（有合法位置）就别再走——交给 BUILD 候选
  if (buildSpots(s, unit, buildDef).length > 0) return null;

  /*
   * 找一个"站上去就能盖"的可达格：目标格周围 buildRange 以内、且从那儿
   * `buildSpots` 非空。找不到就退而求其次——走到离目标最近的可达格。
   */
  const reach = reachableTiles(s, unit);
  let stand: { x: number; y: number } | null = null;
  let standDist = Infinity;
  let nearest: { x: number; y: number } | null = null;
  let nearestDist = Infinity;
  const target = { x: best.x, y: best.y };
  for (const [k] of reach) {
    const x = k % s.w;
    const y = Math.floor(k / s.w);
    const d = distance({ x, y }, target);
    if (d < nearestDist) {
      nearestDist = d;
      nearest = { x, y };
    }
    if (d > CONFIG.buildRange) continue;
    if (d >= standDist) continue;
    if (buildSpots(s, { ...unit, x, y } as Unit, buildDef).length > 0) {
      standDist = d;
      stand = { x, y };
    }
  }
  const goTo = stand ?? nearest;
  if (!goTo) return null;
  return {
    action: { type: 'MOVE', unitId: unit.id, x: goTo.x, y: goTo.y },
    score: Math.max(18, Math.min(64, best.score * 0.7)),
  };
}

/* ---------------- 收尾计划：派兵接管废墟 ---------------- */

/** 踩进废墟（接管）的分：比常规走位高一个量级，"再走一步就赢"不该输给站位调整 */
const RECLAIM_ENTER_SCORE = 1000;
/** 朝废墟靠近一步的分：高于常规走位，但不至于压过开火 */
const RECLAIM_APPROACH_SCORE = 260;

/**
 * 收尾计划的目标：对面**已经没有完好的城**，只剩废墟。
 *
 * 为什么只收这一种局面：
 *   · 这是规则里唯一"打完了还结束不了"的死角——废墟不能再攻城，只有派兵
 *     走进去掏重建费才算接管（见 `doMove` 的入驻段与 `blockedFor` 的注释）；
 *   · 只在"对面一座好城都不剩"时触发，所以它抽不走正面战场的兵，也不会
 *     改变常规对局的一步棋（`probe:ai-goal` 的四条指纹就是这样验的）。
 *
 * 以后可以放宽到"任何敌废墟都值得收"（多一座城多一份收入），但那会改变
 * 中局走位，得单独验一批，别顺手开口子。
 */
function reclaimTargetOf(view: GameState, me: PlayerId): City | null {
  const foes = view.cities.filter((c) => c.owner !== me);
  if (foes.length === 0) return null;
  // 还有一座好城就不算收尾：那时候该做的是打城，不是捡废墟
  if (foes.some((c) => !c.ruined)) return null;
  const ruins = foes.filter((c) => c.ruined);
  if (ruins.length === 0) return null;
  // 多座废墟时先收便宜的：重建费按城血上限算，贵的可能一辈子攒不出来
  return [...ruins].sort((a, b) => rebuildCost(a) - rebuildCost(b) || a.id.localeCompare(b.id))[0] ?? null;
}

/**
 * 从城的四格往外做一次 BFS：每一格离"能踩进去的那一格"还有几步。
 *
 * 用格子步数而不是直线距离：隔一条河的两格直线 1 步、实际要绕十步，
 * 按直线走会把全军带到岸边排队。BFS 只看地形可走、**不看单位**——
 * 单位会动，把它算进去等于每回合重算一张图，而且拥堵时会把兵卡在原地。
 */
function stepsToCityTiles(view: GameState, city: City): Map<number, number> {
  const dist = new Map<number, number>();
  const queue: number[] = [];
  for (const t of cityTiles(city)) {
    if (!inBounds(view, t.x, t.y)) continue;
    const k = t.y * view.w + t.x;
    if (dist.has(k)) continue;
    dist.set(k, 0);
    queue.push(k);
  }
  for (let i = 0; i < queue.length; i++) {
    const k = queue[i]!;
    const d = dist.get(k)!;
    const x = k % view.w;
    const y = Math.floor(k / view.w);
    for (const [dx, dy] of DIRS) {
      const nx = x + dx;
      const ny = y + dy;
      if (!inBounds(view, nx, ny)) continue;
      const nk = ny * view.w + nx;
      if (dist.has(nk)) continue;
      const tile = view.tiles[nk];
      if (!tile || !passable(tile.terrain)) continue;
      dist.set(nk, d + 1);
      queue.push(nk);
    }
  }
  return dist;
}

/**
 * 收尾计划的出口：给每个还能动的兵一条 MOVE。
 *
 * 两种走法：
 *   · 这一回合就能踩进废墟、而且掏得出重建费 → 直接走进去（`doMove` 会接管）；
 *   · 够不着或钱不够 → 朝"离废墟最近的可达格"挪一步。
 *
 * 钱不够时**不许踩进去**：规则会在动之前就拒（"接管要 N 金"），
 * 提出来只会白费一步。先靠近，钱什么时候够什么时候进。
 */
function reclaimCandidates(
  view: GameState,
  me: PlayerId,
  target: City,
  rejected: ReadonlySet<string>,
): Candidate[] {
  const dist = stepsToCityTiles(view, target);
  const cost = rebuildCost(target);
  const gold = view.players[me].gold;
  const targets = new Set(cityTiles(target).map((t) => t.y * view.w + t.x));
  const out: Candidate[] = [];
  for (const u of unitsOf(view, me)) {
    if (u.moved || u.acted) continue;
    if (utype(view, u.type).category === 'building') continue;
    const reach = reachableTiles(view, u);
    if (reach.size === 0) continue;
    let enterKey = -1;
    let stepKey = -1;
    let stepD = Infinity;
    const hereD = dist.get(u.y * view.w + u.x) ?? Infinity;
    for (const [k] of reach) {
      if (targets.has(k)) {
        enterKey = k;
        continue;
      }
      const d = dist.get(k);
      if (d === undefined) continue;
      // 只往**更近**的格子走：不更近就不动，免得原地来回蹭
      if (d < stepD && d < hereD) {
        stepD = d;
        stepKey = k;
      }
    }
    const into = enterKey >= 0 && gold >= cost;
    const key = into ? enterKey : stepKey;
    if (key < 0) continue;
    const action: Action = { type: 'MOVE', unitId: u.id, x: key % view.w, y: Math.floor(key / view.w) };
    if (rejected.has(aiActionKey(action))) continue;
    out.push({ action, score: into ? RECLAIM_ENTER_SCORE : RECLAIM_APPROACH_SCORE });
  }
  return out;
}

/**
 * 收尾计划（P2 起由排序层管，不再是一段 if）。
 *
 * `value` 给 `1e9` 是"这局赢定了"的约定值，不是金币当量——排序用比值比，
 * 差九个数量级不影响谁当值，只影响日志好看不好看（见 15.12）。
 *
 * `done` 写"目标不在了就算完成"：对面重建出一座好城、或者废墟被我接管，
 * 这条计划就该退场。注意"目标暂时不在"也会让 done 为真——冷却表负责
 * 别让它下一回合立刻又立起来。
 */
const RECLAIM_PLAN: RankedPlan = {
  id: 'reclaim',
  kind: 'action',
  strength: PLAN_TUNING.strength.reclaim ?? 1,
  value: (c) => (reclaimTargetOf(c.view, c.me) ? 1e9 : 0),
  done: (c) => reclaimTargetOf(c.view, c.me) === null,
  next: (c) => {
    const target = reclaimTargetOf(c.view, c.me);
    // 分档不变：踩进去 1000，靠近 260（见 reclaimCandidates 的说明）
    return target ? reclaimCandidates(c.view, c.me, target, new Set()) : [];
  },
};
registerAiPlan(RECLAIM_PLAN);

function unitCandidates(
  s: GameState,
  unit: Unit,
  all: Fields,
  traits: AiTraits,
  rejected: ReadonlySet<string>,
): Candidate[] {  const out: Candidate[] = [];
  const def = utype(s, unit.type);
  /*
   * 让位（2026-11-22 第二层：递归链）。
   *
   * 从"被堵死的城"出发 BFS 找最近空地，**允许穿过己方单位**；
   * 回溯路径，只把**最靠近空地的那一个**己方单位移到空地（score 75）。
   * 它挪开后，下一个单位成为"最靠近空地"的，自然接上——不需要显式建链。
   *
   * 为什么从城出发：城是固定锚点，一次 BFS 就能看出"谁在挡、谁该先走"；
   * 从单位出发则会各算各的，链上中间的人收不到候选。
   *
   * 只对经济/工程单位生效：战斗单位不进产兵格让位（那是走位的事）。
   */
  /*
   * 让位（2026-11-22 定稿）：读**疏散预订表**，不自己找空位。
   *
   * 预订在 `yieldPlanOf` 里做（每回合一次、按离城距离降序、链式腾位）。
   * 这里只负责把"我的目标格"变成候选；目标格被占时 `applyAction` 会拒，
   * 下一步别人走完它就能走——argmax 的串行执行就是递补。
   */
  if (def.category === 'economy' || def.category === 'builder') {
    const target = all.yieldPlan.get(unit.id);
    /*
     * 目标格**当前有人就不给候选**：等那个人走开，下一步 `yieldPlan` 会重新算，
     * 它自然能走。不这样判的话会提交非法动作，`aiNextAction` 每次返回同一条，
     * 浪费整回合（实测 56 次失败只成功 4 次）。
     */
    if (target && !unitAt(s, target.x, target.y)) {
      out.push({
        action: { type: 'MOVE', unitId: unit.id, x: target.x, y: target.y },
        score: 75,
      });
    }
  }
  /*
   * 侦查单位这一回合**不许出手**。
   *
   * 潜行的成立条件是"站在森林/丘陵且这回合没出过手"（见 abilities 的 stealth），
   * 所以给它生成 ATTACK/SIEGE 候选，就等于把"蹲住开视野"这件事自己废掉。
   * 这不是"不敢打"，是任务要求：一出手就现形，而且之后整个敌方回合都露在外面。
   */
  const isScout = all.scout?.unitId === unit.id;
  /*
   * 走位引导点：侦查任务（`scout`）或顺路观察（`peek`）。
   *
   * 两者的差别只在**攻击**：`scout` 禁攻（潜行要求），`peek` 照常打——
   * 它只是"往那边走的时候偏一点"，被打了该还手还手。
   */
  const guide = isScout ? all.scout : all.peek?.unitId === unit.id ? all.peek : null;

  // 施工中的工地不能开火、不能围城、不能造东西（规则层会拒），
  // 所以这里根本不为它生成候选——否则 AI 会提一个必被拒绝的动作，
  // 而执行方遇到非法动作就中断整回合，整局直接卡死。
  if (!isScout && !unit.acted && !underConstruction(unit)) {
    for (const t of attackableTargets(s, unit)) {
      // 装甲要指定武器：不指定就退到"第一件能开火的"，装了防空炮又装加农的
      // 装甲会拿防空炮去打地面目标 → 被规则层拒 → 调度器中断整回合。
      const wpn = def.armorFrame ? bestWeaponFor(s, unit, t) : null;
      if (def.armorFrame && !wpn) continue; // 没有一件打得动这个目标
      out.push({
        action: { type: 'ATTACK', unitId: unit.id, targetId: t.id, ...(wpn ? { weapon: wpn } : {}) },
        // 战略姿态的"进攻权重"：不压 0 就是允许开火，大于 1 是更愿意换血
        score: scoreAttack(s, unit, t, all) * all.weights.attack,
      });
    }
    for (const c of siegeTargets(s, unit)) {
      out.push({
        action: { type: 'SIEGE', unitId: unit.id, cityId: c.id },
        score: scoreSiege(s, unit, c, all.focusCityId, all.mood, all.foeEcon) * all.weights.attack,
      });
    }
    /*
     * 装甲装配：贴着坞、有空槽、有钱有电，就装最值的那一件。
     *
     * 评分故意压得比"开火"低一点，但**空壳素体**（一件武器都没有）例外：
     * 它现在只会撞击，装炮就是它这一回合唯一有意义的动作。
     */
    if (def.armorFrame) {
      const mod = bestModuleToMount(s, unit);
      if (mod) {
        out.push({
          action: { type: 'MOUNT', unitId: unit.id, moduleId: mod },
          score: weaponsOf(unit).length === 0 ? 150 : 62,
        });
      }
    }
    if (def.builds && def.builds.length > 0) {
      for (const buildId of def.builds) {
        const buildDef = s.unitTypes[buildId];
        if (!buildDef) continue;
        // 钱要够：以前没查，AI 会一直提"金币不足"的建造，
        // 而执行方遇到非法动作就中断整回合。
        if (!canPay(s.players[s.current], recruitResCost(s, s.current, buildDef))) continue;
        const spots = buildSpots(s, unit, buildDef);
        for (const spot of spots) {
          out.push({
            action: { type: 'BUILD', unitId: unit.id, unitType: buildId, x: spot.x, y: spot.y },
            score: scoreBuild(s, unit, buildId, spot, all),
          });
        }
        /*
         * 脚下没有位置 → **走向能盖的地方**（2026-11-20，T11）。
         *
         * 现场：修真的藏经阁要求"紧贴宗门"，执事站在宗门旁边转了半天，
         * 周围全被占满，于是永远不建。条件是全齐的（时代、钱、人）。
         *
         * 判据仍然全在扩展那边：核心只做三件事——扫格子、问目标"这个位置
         * 值多少"（`buildScore`）、把"走过去"发成一条普通的 MOVE 候选。
         * 核心不知道"藏经阁要贴着宗门"，也没必要知道：`buildScore` 返回
         * `null` 的格子自动被跳过，能给出高分的格子自然就是规则允许的。
         */
        if (spots.length === 0) {
          const go = goalApproachCandidate(s, unit, buildId, buildDef, all);
          if (go) out.push(go);
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
      let score: number;
      if (guide) {
        /*
         * 侦查走位：只认"离蹲点更近"，不理推进/换血那一套。
         *
         * 已经在点上（d0 = 0）时**不推移动**：下面 `holdScore` 会让它站着。
         * 不这么写的话，到了林子还会被基础走位分拽走——一挪窝就前功尽弃。
         */
        const sp = guide;
        const d0 = Math.max(Math.abs(unit.x - sp.x), Math.abs(unit.y - sp.y));
        if (d0 === 0) continue;
        const d1 = Math.max(Math.abs(x - sp.x), Math.abs(y - sp.y));
        score = 120 + (d0 - d1) * 60 + (d1 === 0 ? 40 : 0);
        if (!best || score > best.score) {
          best = { action: { type: 'MOVE', unitId: unit.id, x, y }, score };
        }
        continue;
      }
      score = scoreMove(s, unit, x, y, all, traits);
      /*
       * 空壳素体走向装配坞。
       *
       * 装配要求"贴着坞"，而 AI 的走位评分只知道"往前线压、别贴着敌人"，
       * 没有任何一条会把它往自家坞带。结果是：素体造出来了、模块买得起、
       * 坞就在后方——三件事齐了，就是永远装不上，一台平台到死只会撞击。
       */
      /*
       * 产兵格告急：自己人把城格占满 → 这座城再也造不出兵（规则层直接拒）。
       *
       * 2026-11-21 实测（seed 32，16×16 era3）：第 81 回合起两座城的产兵格都是 0、
       * 城里 8 个人，之后 140 回合攒到 18900 金，一个兵都没造出来——整支军队停摆。
       *
       * 分要按**定额**给：僵持局面里走位评分常常是 -100 上下的推进负分
       * （"出去也打不过"），加几十点压不住。量级照抄下面素体走向装配坞那段（120/80）。
       */
      if (def.category === 'combat' && all.chokedCities.length > 0) {
        const home = citiesOf(s, me).find(
          (c) =>
            all.chokedCities.includes(c.id) &&
            cityTiles(c).some((t) => t.x === unit.x && t.y === unit.y),
        );
        if (home && !cityTiles(home).some((t) => t.x === x && t.y === y)) {
          score += 150;
        }
      }
      if (def.armorFrame && weaponsOf(unit).length === 0) {
        const dock = nearestOwnDock(s, me, unit);
        if (dock) {
          const before = Math.max(Math.abs(unit.x - dock.x), Math.abs(unit.y - dock.y));
          const after = Math.max(Math.abs(x - dock.x), Math.abs(y - dock.y));
          // 每靠近一格给 120：退回去通常要吃走位评分的大额扣分（-200 上下），
          // 定额加成压不住，按步数给才追得平。
          if (after < before) score += (before - after) * 120;
          if (after <= 1) score += 80;
        }
      }
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
/**
 * 主动技能的候选。
 *
 * ⚠️ "AI 不会放某个技能"不要在这里加 case——用 `registerSkillAi`
 * （见 `src/core/skill-hooks.ts` 的说明）。这里的 switch 是历史遗留。
 */
function heroSkillCandidate(view: GameState, u: Unit): Candidate | null {
  const def = utype(view, u.type);
  const skills = def.skills ?? [];
  if (skills.length === 0) return null;

  const foes = enemyUnitsOf(view, u.owner).filter(
    (f) => utype(view, f.type).category === 'combat',
  );
  const hpRatio = u.hp / def.maxHp;

  for (const k of skills) {
    // 能不能开读 heroSkillsOf，别自己翻 skillCd：隐匿这类技能改成充能之后，
    // 只认冷却会让 AI 以为它永远"不能用"（skillCd 一直是空的），
    // 于是整局一次都不藏。
    const state = heroSkillsOf(view, u).find((x) => x.def.id === k.id);
    if (!state?.ready) continue;

    /*
     * ── 技能自带的 AI 提示优先 ──────────────────────────────────
     *
     * 技能效果在哪个包里，就由那个包声明"什么条件下值得放、值多少分"。
     * 查到了就走它，没查到继续走下面那串写死的 case（渐进迁移：搬一个少一个）。
     *
     * 返回值三种：null = 现在不放；数字 = 值几分；`{score,x,y}` = 值几分并指定落点。
     * 一个提示抛错不该把整局打死——记一次，按"不放"处理。
     */
    const hint = SKILL_AI_HINTS[k.effect];
    if (hint) {
      let r: ReturnType<typeof hint> = null;
      try {
        r = hint({
          state: view,
          unit: u,
          def,
          skill: k,
          api: abilityApi,
          foes,
          hpRatio,
          allies: unitsOf(view, u.owner),
        });
      } catch (err) {
        unitAiWarn(
          `skillai:${k.effect}`,
          `[skill-ai] 技能「${k.effect}」的 AI 提示抛错了，这一步按"不放"处理：${String(err)}`,
        );
        r = null;
      }
      const hinted = r === null ? 0 : typeof r === 'number' ? r : r.score;
      if (hinted > 0) {
        const at = r !== null && typeof r !== 'number' ? r : null;
        return {
          action: {
            type: 'HERO_SKILL',
            unitId: u.id,
            skillId: k.id,
            ...(at && typeof at.x === 'number' && typeof at.y === 'number'
              ? { targetX: at.x, targetY: at.y }
              : {}),
          },
          score: hinted,
        };
      }
      continue;
    }

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
      // 陨卵（dragon-egg）的判定已经搬回奇想包了，见 fantasy-packs.ts 的
      // 「技能自带的 AI 提示」一节。以后新技能一律走那边，不要再往这里加 case。
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
  const foes = enemyUnitsOf(view, me).filter((f) => utype(view, f.type).category === 'combat');
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
  stance: 'push' | 'elite' | 'trade';
  /**
   * 正在为什么攒钱。
   *
   * 2026-11-02 新增 `'unit'`：人类会"停手攒钱买一个大件"，而原来的三种目标
   * 只有英雄 / 升时代 / 收废墟，普通兵种永远吃不到这套预留机制。
   */
  savingFor: 'hero' | 'era' | 'rebuild' | 'unit' | 'goal' | null;
  /** savingFor === 'unit' 时，攒的是哪一个兵种 */
  targetUnitId: string | null;
  /** savingFor === 'goal' 时，攒的是哪条产业链的哪一段 */
  targetGoalId: string | null;
  targetStepId: string | null;
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
  /** 威胁值（`threatLevelOf`）：产业链靠它判断要不要放弃投资 */
  threat: number;
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
 * 就得先估"以后还有多少回合可打"。20×20、火器开局、200 回合上限的实测里，
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
  kind: 'hero' | 'era' | 'rebuild' | 'unit' | 'goal';
  /** `kind === 'goal'` 时：哪条产业链的哪一段 */
  goalId?: string;
  stepId?: string;
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
    const nextLevel = nextEraLevelOf(s, city);
    return {
      cost,
      cityId: city.id,
      note: nextLevel === null ? '继续攒钱' : `升到第 ${nextLevel} 代（接着攒）`,
    };
  }
  if (it.goal === 'rebuild') {
    const ruin = it.cityId ? cityById(s, it.cityId) : null;
    if (!ruin || !ruin.ruined || ruin.owner === me) return null;
    const cost = rebuildCost(ruin);
    if (ctx.gold >= cost) return null;
    return { cost, cityId: ruin.id, note: '重建这座废墟（接着攒）' };
  }
  if (it.goal === 'goal' && it.goalId && it.stepId) {
    // 那一段还在推进吗？还要钱吗？两问都得答"是"才接着攒
    const live = goalStepsInPlay(goalCtxOf(s, me, eraNowOf(s), false, 0, null));
    const cur = live.find((x) => x.goal.id === it.goalId && x.step.id === it.stepId);
    if (!cur?.step.cost) return null;
    const want = cur.step.cost(goalCtxOf(s, me, eraNowOf(s), false, 0, null));
    if (!(want > ctx.gold)) return null; // 钱够了就该去花，而不是继续举牌子
    return { cost: want, note: `${it.goalId} · ${it.stepId}（接着攒）` };
  }
  const def = it.unitId ? s.unitTypes[it.unitId] : null;
  if (!def || def.category !== 'combat') return null;
  const price = Math.max(1, recruitPriceOf(s, me, def).gold);
  if (ctx.gold >= price) return null;
  return { cost: price, unitId: def.id, note: `${def.name}（接着攒）` };
}

/**
 * 局面吃紧吗——`plan.urgent` 和产业链目标共用这一份判据。
 *
 * 以前这两句写在 `buildPlan` 里，只有"攒钱"读它。产业链目标也要读同一件事
 * （吃紧时不推进投资），所以抽出来。**判据只能有一处**：两处各写一遍，
 * 迟早出现"攒钱知道要收手、产业链还在往前拱"。
 */
/**
 * 威胁值：这座城**守不住多少**。
 *
 * 三件事，缺一个就会误判（2026-11-20 第二版）：
 *
 *   1. **谁在打**：`isArmed` 判据（规则层同一个函数），不是 `atk > 0`。
 *      只看法术攻击的单位（`magicAtk > 0` 但 `atk = 0`）以前完全不算威胁——
 *      修真接进来之后这是个真漏洞：一堆修士站在城下，AI 觉得没事。
 *   2. **守不守得住**：拿**攻方战力减守方战力**，不是"有人靠近就算"。
 *      城自己有攻击力，城内 5 格内的武装单位也算守军。守得住就不该打断投资。
 *   3. **哪座城**：逐城算，取差值最大的那一座。不是把所有城的敌人加在一起。
 *
 * 返回"净威胁"：> `THREAT_ATK` 才算真的要吃城。
 */
function threatLevelOf(s: GameState, me: PlayerId, foe: Unit[], mood: AiMood): number {
  const cities = citiesOf(s, me).filter((c) => !c.ruined && c.id !== mood.abandonedCityId);
  if (cities.length === 0) return 0;
  const mine = unitsOf(s, me);
  /** 一支队伍每回合能砸出多少伤害（法术攻击也算，取高的那一项） */
  const powerOf = (us: readonly Unit[]): number =>
    us.reduce((n, u) => {
      const d = utype(s, u.type);
      return n + Math.max(d.atk ?? 0, d.magicAtk ?? 0) * (d.burst ?? 1);
    }, 0);
  let worst = 0;
  for (const c of cities) {
    const attackers = foe.filter((u) => {
      const d = utype(s, u.type);
      if (d.category !== 'combat' || !isArmed(s, u)) return false;
      // 下回合就能摸到城墙：移动 + 射程，再多给一格余量
      return distToCity(u, c) <= (d.move ?? 0) + (d.range ?? 1) + 1;
    });
    if (attackers.length === 0) continue;
    const defenders = mine.filter((u) => distToCity(u, c) <= 5 && isArmed(s, u));
    // 城自己也会还手，但 City 上没有 atk 字段（城墙的伤害在 rules 里），
    // 这里不硬编，只算守军——保守一点，宁可多算一次威胁
    const gap = powerOf(attackers) - powerOf(defenders);
    if (gap > worst) worst = gap;
  }
  return worst;
}

function isUrgentNow(
  s: GameState,
  me: PlayerId,
  my: Unit[],
  foe: Unit[],
  mood: AiMood,
): boolean {
  const myCities = citiesOf(s, me).filter((c) => !c.ruined);
  const army = my.filter((u) => utype(s, u.type).category === 'combat').length;
  // 城下有人：半径 3 是"下回合就能摸到城墙"的量级。放弃掉的那座城不算。
  const threaten = foe.some((u) =>
    myCities.some((c) => c.id !== mood.abandonedCityId && distToCity(u, c) <= 3),
  );
  // 只剩一座城、经营权重够高、经济单位够多，且没有敌人打得着它：安全后方
  const developingRear =
    myCities.length === 1 &&
    mood.weight.boom >= ABANDON_AT &&
    mood.metrics.earners >= 2 &&
    foe.every(
      (u) =>
        utype(s, u.type).category !== 'combat' ||
        distToCity(u, myCities[0]!) >
          effectiveRangeAgainst(s, u, tileAt(s, myCities[0]!.x, myCities[0]!.y)) + 2,
    );
  return (army < 3 && !developingRear && !mood.abandonedCityId) || threaten;
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
  const urgent = isUrgentNow(s, me, my, foe, mood);
  const threatNow = threatLevelOf(s, me, foe, mood);

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
  let targetGoalId: string | null = null;
  let targetStepId: string | null = null;
  let targetCityId: string | null = null;
  let goalScore = 0;
  let goalNote = '';
  let goalOptions: AiPlan['goalOptions'] = [];
  /** 上一次立下的意向（跨回合记忆，见 types.ts 的 aiIntent） */
  const prev = focusOf(s, me).save ?? null;
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
        !d.legacy &&
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
     * 名额追不平——每座城每回合只能出一个兵，这才是真正的稀缺资源。
     * 真正的稀缺资源是名额，所以升时代的价值是"以后每一个名额多产多少战力"。
     *
     * 两个折扣都要打明白：
     *   · 未来才到手的战力要折半（兵是现在就能用的，升级是十五个回合里慢慢兑现的）；
     *   · 视野内造不了几个兵（名额 + 钱谁先卡住算谁），最多按 5 个算。
     * 不打这两个折扣，升时代会永远碾压一切，AI 就又回到"整局只顾升城"。
     */
    /*
     * 下一级是哪一代，问路线，不写 `era + 1`：路线可以跳级，也可以指向别的分支。
     * 拿不到下一级（科技线到头/这一局封顶）时，这段评估整段跳过——
     * 原来用 `era + 1` 会去数一张永远造不出来的兵表，凭空给出一个"换代很值"的结论。
     */
    const nextLevel = eraCity ? nextEraLevelOf(s, eraCity) : null;
    if (eraCity && eraTarget !== null && nextLevel !== null && reach(eraTarget, SAVE_HORIZON)) {
      const nextPool = Object.values(s.unitTypes).filter(
        (d) =>
          d.category === 'combat' &&
          !d.summonedOnly &&
          canUseType(s, me, d.id) &&
          d.era === nextLevel,
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
            `升到第 ${nextLevel} 代：每个名额 +${Math.round(delta)} 战力` +
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

    /*
     * 产业链：正在追的那一段如果要的钱还差着，就把它排进同一张表。
     *
     * 和上面四条**共用一把尺子**（`score` 是"每金战力"量级），所以
     * "攒英雄"和"攒宗门"能直接比大小，不需要再写一段"谁优先"的 if。
     * 分怎么来由扩展给（`saveScore`），核心不替它定价。
     */
    const commit = s.aiCommit?.[me] ?? null;
    if (commit) {
      const live = goalStepsInPlay(goalCtxOf(s, me, eraNowOf(s), urgent, threatNow, commit));
      const cur = live.find(
        (x) => x.goal.id === commit.goalId && x.step.id === commit.stepId,
      );
      const want = cur?.step.cost?.(goalCtxOf(s, me, eraNowOf(s), urgent, threatNow, commit)) ?? 0;
      if (want > gold && reach(want, SAVE_HORIZON)) {
        goals.push({
          kind: 'goal',
          goalId: commit.goalId,
          stepId: commit.stepId,
          targetUnitId: null,
          cost: want,
          score: cur?.step.saveScore ?? DEFAULT_GOAL_SAVE_SCORE,
          note: `${cur?.goal.id ?? commit.goalId} · ${commit.stepId}（${want} 金，差 ${want - gold}）`,
        });
      }
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
      const held = goals.find((g) => {
        if (g.kind !== prev.goal) return false;
        if (prev.goal === 'unit') return g.targetUnitId === (prev.unitId ?? null);
        if (prev.goal === 'goal') return g.goalId === prev.goalId && g.stepId === prev.stepId;
        return true;
      });
      const fresh = s.turn - prev.since <= INTENT_TURNS;
      if (held && held !== pick && fresh && pick.score < held.score * INTENT_MARGIN) pick = held;
    }
    if (pick) {
      savingFor = pick.kind;
      targetCost = pick.cost;
      targetUnitId = pick.targetUnitId;
      targetCityId = pick.cityId ?? null;
      targetGoalId = pick.goalId ?? null;
      targetStepId = pick.stepId ?? null;
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



  /*
   * 收缩（原来这里的 `turtle`）已经搬进计划层（`DEFEND_PLAN`）。
   *
   * 搬走的原因不是"姿态层错了"，而是它必须**有立约、有价值、有日志**：
   * 原来那个判断每回合重算，进来一个敌人就收缩、敌人一走就放，
   * 部队在城门口来回走——和决战时机那 128 次抖动是同一个病。
   */
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
  /*
   * 精兵姿态：**留着，但砍掉那条"编制快满就精兵"的触发**（2026-11-21）。
   *
   * 先试过整条删掉，对 v1 的胜率从 75% 掉到 33%——说明"手头宽裕时买好的"
   * 这件事和帽子无关：同样一袋钱，买 5 个民兵和 1 个坦克的战斗力不一样，
   * 便宜兵再多也顶不住质量。帽子只该背它自己的那一份：
   * （v3 没有编制上限，那条"编制快满就精兵"的触发早就删了。）
   *
   * 所以 `quality` 现在只剩三条与帽子无关的来源：在攒钱、手头比一个兵宽裕、
   * 或者这一局性格偏发展。
   */
  const quality = savingFor !== null || gold >= inc * 1.2 || mood.weight.boom > 0.5;
  const elite = quality || trade;
  const stance: AiPlan['stance'] = trade ? 'trade' : elite ? 'elite' : 'push';

  /*
   * 把这一回合的意向写回状态。
   *
   * 写在 buildPlan 里是有意的：目标就是在这里选出来的，写到别处必然出现
   * "计划是英雄、记忆是时代"的分叉。`s` 在 aiNextAction 里是**雾图副本**，
   * 所以那边还要把它搬回真状态（见 aiNextAction 里的搬运用那几行）。
   */
  if (savingFor) {
    const same =
      prev !== null &&
      prev.goal === savingFor &&
      (prev.unitId ?? null) === (targetUnitId ?? null) &&
      (savingFor !== 'goal' || (prev.goalId === targetGoalId && prev.stepId === targetStepId));
    setFocus(s, me, {
      ...focusOf(s, me),
      save: {
        goal: savingFor,
        goalId: targetGoalId ?? undefined,
        stepId: targetStepId ?? undefined,
        unitId: targetUnitId ?? undefined,
        cityId: targetCityId ?? undefined,
        cost: targetCost,
        since: same ? prev.since : s.turn,
        seen: s.turn,
      },
    });
  } else if (prev) {
    setFocus(s, me, { ...focusOf(s, me), save: null });
  }

  return {
    stance,
    savingFor,
    targetCost,
    targetUnitId,
    allowance,
    buildAllowance,
    targetGoalId,
    targetStepId,
    threat: threatNow,
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
  return buildPlan(s, me, unitsOf(s, me), enemyUnitsOf(s, me), mood);
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
/** 没有敌城时，`distanceFields` 里那张"往敌方部队去"的虚拟距离图的键 */
const VIRTUAL_FOE_FIELD = '__foe_units__';

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
  /** 三回合计划把启发式第一名换掉了几次 */
  planFlip: 0,
  /** 三回合计划实际跑了几次（够不够用、有没有被门控挡住） */
  planRuns: 0,
  /** 僵持破局触发了几次（C，2026-11-15） */
  staleCalls: 0,
  swapWhy: new Map<string, number>(),
  reset(): void {
    this.swapWhy.clear();
    this.swap = 0;
    this.tradeCalls = 0;
    this.revive = 0;
    this.flankUnits = 0;
    this.lookaheadFlip = 0;
    this.planFlip = 0;
    this.planRuns = 0;
    this.staleCalls = 0;
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

/* ---------------- 决战时代（S2a：先只算不用） ---------------- */

/**
 * L0 的常数：固定奔第 5 代。
 *
 * 它不产出策略，只用来把"判决 → 日志 → 闸门"这条管线打通。
 * 没有它，L2 一上线就分不清"是估算错了"还是"闸门根本没接上"。
 * 分层方法见 docs/PLAN-AI-V3 第十二节。
 */
const ERA_L0_CONST = 5;

/** 这一席最高的那座好城的时代（全被打成废墟就是 1） */
function highestEraOf(s: GameState, owner: PlayerId): number {
  let m = 1;
  for (const c of s.cities) if (c.owner === owner && !c.ruined && c.era > m) m = c.era;
  return m;
}

/**
 * 这一席的"决战时代"。
 *
 * S2a 只有两档，且**两档都只算不用**——没有任何消费方，所以开不开都是同一盘棋。
 * 这是故意的：先让数能被看见、被对照，再让数去影响动作。
 *
 *   · `const`（L0）：固定 `ERA_L0_CONST`，用来验管线；
 *   · `foe`  （L1）：对面时代 + 1。典型错误形态是"高时代局互相拖着升"，
 *     所以它只能作为对照，不会被当成正解。
 *
 * 后面两档（L2 距离场 / L3 对面节奏）加进来时，**接口不变**，
 * 只是在这个函数里多一个分支。
 */
function desiredEraOf(
  s: GameState,
  me: PlayerId,
  model: 'const' | 'foe',
): { era: number; foeEra: number; desired: number; why: string } {
  const era = highestEraOf(s, me);
  const foeEra = Math.max(1, ...enemySeats(s, me).map((p) => highestEraOf(s, p)));
  /*
   * 封顶要问**规则层**，不能用 `ERAS.length`。
   *
   * 科技线能开到第几代取决于开了哪些包（`eraCeilingOf`）：没开装甲时代，
   * 机械化就是终点。用 8 去钳制，模型会一直喊"奔第 6 代"，而那个动作
   * 在这个局里根本不存在——2026-11-21 第一次跑 S2a 就是这么错的：
   * 一个 era5 开局的局全程 desiredEra=6，看着像"AI 不肯升"，其实是没得升。
   */
  const maxEra = Math.max(1, Math.min(ERAS.length, eraCeilingOf(s)));
  const capNote = maxEra < ERAS.length ? `（科技线封顶第 ${maxEra} 代）` : '';
  /*
   * 目标**不能低于当前时代**：已经升上去的城不会退回来。
   *
   * L1 不钳的话会出现"我 5 代、对面 1 代 → 我要奔 2 代"这种自降目标
   * （2026-11-21 实测日志里真出现过，turn 87）。L0 同样钳一下，
   * 免得以后科技线上限调高之后常数反而变成倒退。
   */
  const floor = era;
  if (model === 'const') {
    const want = Math.max(floor, Math.min(ERA_L0_CONST, maxEra));
    return { era, foeEra, desired: want, why: `L0 常数：奔第 ${want} 代${capNote}` };
  }
  const want = Math.max(floor, Math.min(foeEra + 1, maxEra));
  return { era, foeEra, desired: want, why: `L1 跟对面：对面 ${foeEra} 代，所以奔 ${want} 代${capNote}` };
}

/**
 * 把这次判决记进局面（每席每回合至多一条）。
 *
 * 为什么记在 state 里：AI 必须是纯的（不碰 IO、不碰随机），否则回放会分叉。
 * 跑批脚本导出回放时把它写成 sidecar，看回放时对照着读——
 * 回放只能看"它做了什么"，这一列补"它为什么"。
 */
function noteEraDecision(s: GameState, view: GameState, me: PlayerId, model: 'const' | 'foe'): void {
  const list = (s.aiDecisions ??= []);
  const last = list[list.length - 1];
  // 一回合里 AI 会被问很多次（每个兵一次），判决只该记一次
  if (last && last.turn === s.turn && last.me === me) return;
  const d = desiredEraOf(view, me, model);
  list.push({
    turn: s.turn,
    me,
    model,
    era: d.era,
    foeEra: d.foeEra,
    desiredEra: d.desired,
    why: d.why,
  });
  // 别让日志无限长：一局几千步也不该存几万行，留最近 400 条够复盘
  if (list.length > 400) list.splice(0, list.length - 400);
}

/**
 * 这一刻"值多少钱"要看局面：移速在防守时打折、压上时加价；
 * 己方视野已经很开阔时，再买一双眼睛的边际价值下降。
 * 具体权重在 `core/unit-value.ts`，这里只负责把局面翻译成 `ValueContext`。
 */
function valueContextOf(s: GameState, me: PlayerId, plan: AiPlan): ValueContext {
  const tempo = plan.stance === 'push' || plan.stance === 'trade' ? 1 : 0;
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

/**
 * 采购评分。
 *
 * ⚠️ **"AI 不会买某个兵"不要在这里加特判。**
 * 写一个 `AiGoal` 的 `claimsUnit` + `unitScore`（见文档第 4 节）。
 * 这里的 `royalComboBonus` 是历史遗留，新内容一律走目标。
 */
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
   * 战略姿态的"经济权重"：只管经济单位，兵一分不动。
   *
   * 为什么只乘经济那一侧：兵价和经济单位价不是一个量级，两边同时乘
   * 等于把"相对偏好"放大成平方，越调越偏。
   */
  econWeight = 1,
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
   * 编队缺口（2026-11-22）：由 `squadTick` 写进计划口袋。
   * 采购不知道"编队缺人"这件事的话，只会按自己的节奏造兵/造工人，
   * 编队就一直是残的（见 `squadTick` 里那段注释）。
   */
  const keepNow = (focusOf(s, me).plan?.keep ?? {}) as Record<string, unknown>;
  const squadNeed = Number(keepNow.squadNeed ?? 0);
  const builderNeed = Number(keepNow.builderNeed ?? 0);
  const threatScale = Number(keepNow.threatScale ?? 0);
  /*
   * 产业链目标的读数：整次采购算一遍，别跟着每个兵种重算
   * （`goalStepsInPlay` 会问每个目标的价值，海军那条还要查水域）。
   */
  const goalCtx = goalCtxOf(s, me, eraNowOf(s), plan.urgent, plan.threat, s.aiCommit?.[me] ?? null);
  /*
   * 这个产兵点的"规则层身份"。
   *
   * 取价必须带上它：修真的宗门招弟子**不收金币、收灵石**（`modifyCost` /
   * `modifyResourceCost` 两个钩子按 `source` 生效），城市那条线照旧收金币。
   * 以前这里不传，于是宗门招人被按**城市价**估——明明更便宜、而且花的是灵石，
   * AI 却以为要掏一大笔金币，要么放弃要么排不上。和面板/规则层共用一个口径。
   */
  const produceSource: ProduceSource | undefined =
    src.kind === 'camp'
      ? (() => {
          const camp = s.units.find((u) => u.id === src.id && u.hp > 0) ?? null;
          return camp ? ({ kind: 'camp', camp } as const) : undefined;
        })()
      : (() => {
          const city = s.cities.find((c) => c.id === src.id) ?? null;
          return city ? ({ kind: 'city', city } as const) : undefined;
        })();
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
    // 退役兵种（types.ts 的 legacy）：定义留着只为老存档能显示，AI 别去买
    if (d.legacy) return reject('退役兵种');
    // 英雄场上只能有一个（蛋还没孵也算"有一个"）。这条规则在 doRecruit 里也拦了，
    // 但在这里先拦掉，才能让 AI 把"再多买一个"的钱花到别处，而不是每回合撞一次墙。
    if (heroBlocked(s, me, d)) return reject('英雄已在场');
    // 时代窗口与选卡名单走 core/draft 的同一套判据：
    // 选卡模式下 AI 也只能造自己选到的兵；时代只剩上界，旧兵对人对 AI 都造得出来
    if (!eraWindowOk(s, d, src.era)) return reject('时代未解锁');
    if (!canUseType(s, me, d.id)) return reject('选卡未收录');
    // 产兵建筑的白名单与产地条件：以前这里一条都不查，AI 会在船坞里点民兵，
    // 规则层拒掉之后整回合就白扔了。和面板、规则层共用 produceAt。
    if (src.kind === 'camp') {
      const camp = s.units.find((u) => u.id === src.id);
      if (!camp || !produceAt(s, { kind: 'camp', camp }, d).ok) return reject('这座营造不了');
    }
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
  // 弃城期把经济线的目标抬高：这一档赢在"三个回合之后我比你富一代"，
  // 所以它要的不是"够用的农民"，而是能把整座城的产线滚起来的人手。
  /*
   * 经济单位的目标数量：**地块容量 × 发展意愿**（2026-11-22 重做）。
   *
   * 以前是 `min(12, 城数×2×…)`——两道玩家没有的约束：
   *   · "每城 2 个"是拍出来的惯例（注释自己写的）；
   *   · `min(12)` 连 git 都追不到理由。
   * 结果 5 城时目标正好 12，24×24 上也只造 10~11 个，与地图大小无关。
   *
   * 现在只受地皮约束：`econCapacity` 数"我方城 6 格内、值得种、且不是产兵格的格子"。
   * 发展意愿（boom 证据）决定用掉容量的几成，`econWeight` 只做 ±20% 的微调。
   */
  const econCap = econCapacity(s, me);
  const boomWant = Math.max(0, Math.min(1, mood?.driveRaw.boom ?? 0.5));
  /*
   * 投资窗口（@tune 20 回合）：开局铺经济，过了窗口就不再往上加。
   *
   * 为什么必须有一条时间线：把"每城 2 个"拿掉之后，AI 会一路把容量铺满
   * （Q4 实测 40 个经济单位、收入 401/回合），可兵只有 15 个，
   * 四局由胜转平（87/106/111/118 → 全是 261）。钱变不成兵——产兵格每回合
   * 就那么几个——所以"投到什么时候停"必须有个端点。
   *
   * 20 是"双方各十来个回合"的量级，之后再补经济只按维护性替换（目标不再涨）。
   * 真正的解法是接 `solvePower` 的 `econUntil`（它按回本算"投到第几回合"），
   * 这一版先给一个能跑的窗口，等第三步再换。
   */
  const ECON_WINDOW = 20;
  const inWindow = s.turn <= ECON_WINDOW;
  const econShare = inWindow
    ? Math.max(0.3, Math.min(0.95, 0.3 + 0.5 * boomWant)) *
      Math.max(0.8, Math.min(1.2, econWeight))
    : 0;
  /*
   * 默认仍是旧的目标公式（`aiEconCap` 关）；打开后按地块容量铺。
   * 旧的留着不是"舍不得"：这是默认行为的基线，A/B 时两边都得能跑。
   */
  /*
   * 经济投入交给求解器（第五节第 3 步，`aiEconPlan` 默认开）。
   *
   * 窗口 = `focusDist ÷ 3`：主力到敌城要几回合（3 = 平均移动力），
   * 也就是"离决战还剩多久"。求解器在这个窗口里扫"投经济到第几回合"最划算：
   *   · `econUntil > 0` → 按它报的个数投（`现有 + plan.econ`）；
   *   · `econUntil = 0` → 来不及回本，保底每城一个、其余全买兵。
   *
   * 为什么不是"每城 2 个"：那个数在同一张图上对所有局面都给同一个答案，
   * 而"该不该投"取决于还剩几回合——小图上决战 2 回合后就到，经济不可能回本。
   */
  const econPlan = (() => {
    if (s.config.aiEconPlan !== true) return null;
    /*
     * 窗口 = **决战判决算出来的行军回合**（`aiCalls.marchTurns`）：
     * 那是距离场里的路径回合（含绕河/过桥），不是直线距离。
     *
     * 为什么不用 `distToCity ÷ 3`：实测同一条 24×24 上，直线算法给 2~6 回合、
     * 路径算法给 47 回合——差十倍。用直线时 `econUntil` 恒为 0，经济一个都投不进去。
     * 判决不是每回合都写日志，所以取最近 6 回合内、本席的最后一条。
     */
    /*
     * 窗口 = **城到城**的路径回合，不是"当前部队到城"。
     *
     * 用部队到城会随推进变小（T4 窗口 4、T8 窗口 3），经济刚起步就被判
     * "来不及回本"，结果几乎不投（Q2 4-1-1）。城到城不会随部队变。
     *
     * 路径用直线 × 1.6 近似（绕河/绕山），再按 3 格/回合换算，clamp 4~12：
     *   12×12 → 4；16×16 → 6~7；24×24 → 8~10。
     */
    const own = citiesOf(s, me);
    const foe = s.cities.filter((c) => c.owner !== me && !c.ruined);
    let best = Infinity;
    for (const a of own) for (const b of foe) best = Math.min(best, distToCity(a, b));
    const horizon = Number.isFinite(best)
      ? Math.max(4, Math.min(12, Math.round((best * 1.6) / 3)))
      : 8;
    return solvePower(powerInputOf(s, me), horizon);
  })();
  const targetEarners = econPlan
    ? econPlan.econUntil > 0
      ? Math.max(1, earners + econPlan.econ)
      : Math.max(1, citiesOf(s, me).length)
    : s.config.aiEconCap === true
      ? inWindow
        ? Math.max(2, Math.round(econCap * Math.min(1, econShare)))
        : Math.max(2, Math.min(econCap, earners))
      : Math.min(
          12,
          Math.round(Math.max(1, citiesOf(s, me).length) * 2 * Math.max(1, econWeight)) +
            Math.round(3 * boomWant) +
            (mood?.abandonedCityId ? 2 : 0),
        );

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
  // 既拿远程奖励、又把远程占比撑虚，AI 于是不买火枪兵了（火器局火枪兵采用率 6.8%）。
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
  const foeCombatCount = enemyUnitsOf(s, me).filter(
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
    const quote = recruitPriceOf(s, me, d, produceSource);
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

    /*
     * 装甲素体：没电就是一堆废铁。
     *
     * 素体本身永不停机，但**模块全断电**——一台装不了任何东西的素体
     * 只剩撞击，花 420~820 金买回来是纯亏。所以采购这一关先查余量：
     * 连它自己的基础耗能都供不上，就别买了。
     */
    if (d.armorFrame) {
      if (energyReport(s, me).headroom < (d.draw ?? 0)) {
        deny('没电', d.id);
        continue;
      }
      // 没有坞 = 没有任何办法把它装上炮：一台 420~820 金的平台只剩撞击，
      // 比同等造价的步兵差一档。所以坞先到、素体后买。
      const docked = s.units.some(
        (u) =>
          u.owner === me && u.hp > 0 && (u.type === 'armor_dock' || u.type === 'armor_yard'),
      );
      if (!docked) {
        deny('没坞可装', d.id);
        continue;
      }
    }

    let score = 50;
    if (d.category === 'combat') {
      score += 12 + d.era * 4;
      // 威胁越大，兵越优先（0~40 分，和"编队缺口"叠加）
      if (threatScale > 0) score += 40 * threatScale;
      // 编队缺口：还在收拢的编队缺人 → 采购优先补（每条缺口 4 分，封顶 24）
      score += Math.min(24, squadNeed * 4);
      // 素体的 atk 只是撞击：真正的输出在要装上去的武器里，按"装完之后"估值
      if (d.armorFrame) score += armorFrameScore(s, me, d);
      if (aiLevelOf(s)!=='basic') {
        /*
         * 质量项：**放大，让它压过噪声**（2026-11-21）。
         *
         * 量过一遍所有兵种的评分构成：性价比项（封顶 26）和单价惩罚相抵之后，
         * 坦克只比民兵多 5 分左右，而"偏爱兵种"和随机噪声是 ±4~8 分——
         * 也就是说质量差异被噪声吃掉了，买谁会接近随机，于是经常出现一堆便宜兵。
         *
         * 原来那个 26 的封顶只卡住了 1 个兵种（坦克 30.1），**不是主因**；
         * 主因是信号太小。所以：放大到 ×2.5（坦克 ≈75、民兵 ≈33），
         * 封顶抬到 70。这样"贵而强"能稳稳压过"便宜但弱"。
         *
         * 注意不能改 `EFF_SCALE` 本身——v1 也在用它，改了就动到冻结的老 AI。
         */
        score += Math.min(
          70,
          combatEfficiency(d, resourceValue(s, me, quote.price) + unlockFee * 0.4, valueContextOf(s, me, plan)) *
            EFF_SCALE *
            (s.config.aiQualityScale ?? 2.5),
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
          const foeCities = enemyCitiesOf(s, me);
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
      if (w.harass / Math.max(1e-9, DOCTRINE_GAIN) > 0.1) {
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
      // 威胁越大，经济越该让位给兵（`aiThreatScale` 开时；scale 已含开关）
      if (threatScale > 0) score *= 1 - 0.5 * threatScale;
      const inc = maxIncome(d);
      const payback = inc > 0 ? price / inc : 99;
      /*
       * 目标缺口直接换成分数（2026-11-22 修）。
       *
       * 以前目标内只给 `+34 − 回本×1.5`（约 +28），而兵在速攻/紧迫加成下轻松 40+，
       * 于是 `targetEarners` 定成 49 也只造出 2 个——目标数是个"软加成"，
       * 根本没有名额保证。实测（24×24/era2，301 回合平）：v3 47 战 + **2 工**。
       *
       * 现在按缺口给：缺口越大分越高（最多 +80），补到接近目标就回落。
       * 这不是"更爱经济"，而是让目标数真的能约束采购——和兵在同一把尺子上竞争。
       */
      const gap = targetEarners - earners;
      score +=
        s.config.aiEconCap === true || s.config.aiEconPlan === true
          ? gap > 0
            ? 40 + Math.min(40, gap * 3) - Math.min(18, payback * 1.5)
            : -14
          : gap > 0
            ? 34 - Math.min(18, payback * 1.5)
            : -14;
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
      /*
       * 第二个工人的分从 +4 提到 +18（2026-11-22）：建造编队要 2 人，
       * +4 抢不过兵，实测编队长期只有 1 个工人，桥修得慢、分流渡口修不出来。
       * 第三个开始仍然扣分（−12），不要让工人挤掉主攻编队的人。
       */
      score += builders < 1 ? 24 : builders < 2 ? 18 : -12;
      /*
       * 建造编队缺口（2026-11-22）：**第一个工人优先，第二个不硬挤**。
       *
       * 实测（24×24/era2）：每人 +60 能把编队补到 2 人，但 Q2 有一局胜→负——
       * 工人把兵的名额挤掉了。加成的语义应该是"没有工人就造不出来桥"，
       * 不是"永远优先于兵"：所以只有 `builders === 0` 时给足（压过兵），
       * 第二个工人只给"略高"的 20 分，抢不过就等下次。
       */
      if (s.config.aiEconCap === true) {
        /*
         * 只在"经济铺满"（`aiEconCap`）时启用：那是唯一会让工人被经济挤到 0 的场景
         * （经济缺口 +80，工人 24 永远排不上）。默认配置下工人本来就造得出来，
         * 全局加成反而会在 12×12 上挤掉一个兵（实测 Q1 一局胜→负）。
         */
        score += builders === 0 ? 80 : Math.min(40, builderNeed * 20);
      }
      /*
       * 装甲基建只有「工程机组」盖得了（它的 `builds` 里才有电站/坞）。
       * 不单独给这一条，AI 会一直用前六代那个工兵：它的 builds 里没有这些东西，
       * 于是"想盖电站"这件事**连候选都不会出现**——采购、建造两边都看着正常，
       * 就是电站永远不出现。
       */
      if ((d.builds ?? []).some((b) => ARMOR_SUPPORT_BUILDINGS.has(b))) {
        const hasArmorBuilder = myUnits.some((u) => u.type === d.id);
        if (eraNowOf(s) >= 7 && !hasArmorBuilder) score += 45;
      }
      // 弃城期要靠工事把留守的那座城撑住，工程队值钱
      score += 8 * w.boom;
      if (plan.urgent) score -= 22;
    }
    // 高级对单价更敏感一点：便宜的兵能多铺几个方向。
    // 高时代单位单独放宽——它们贵是设计如此，不该永远排在火枪兵后面。
    // 精兵姿态下单价惩罚只剩三分之一：这时候钱是**攒着买贵的**。
    // 换家姿态按精兵算：每一分钱都要换成能打穿城墙的东西。
    const concentrated = plan.stance === 'elite' || plan.stance === 'trade';
    const perGold =
      concentrated ? 0.012 : aiLevelOf(s) !== 'basic' ? 0.035 : 0.05;
    score -= price * (d.era >= 4 ? perGold * 0.6 : perGold);
    if (concentrated && price >= 100) score += 8;

    // 军营是前线补给点：在军营出兵有额外价值（省了从后方跑一趟）
    if (src.kind === 'camp') score += 6;

    // 配合：国王 + 精英骑兵（见 royalComboBonus）
    if (d.category === 'combat') score += royalComboBonus(s, me, d, myUnits, src);

    /*
     * 产业链目标认领的兵种：为了这条链，这个兵值得优先买。
     *
     * 装甲素体是第一个用它的：素体面板 atk 只有 12~34（那只是撞击），
     * 按常规估值永远排在同代步兵后面——而它整条链的价值在"装上炮之后"。
     * 目标说一句"我需要它"，比在采购里再写一条特判干净。
     */
    score += goalUnitBonus(goalCtx, d);

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

    if (d.category === 'economy') score *= econWeight;
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
  const foe = enemyCitiesOf(s, city.owner);
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
        { stance: 'push', savingFor: null, targetCost: 0, targetUnitId: null, targetGoalId: null, targetStepId: null, allowance: Infinity, buildAllowance: Infinity, goalScore: 0, goalNote: '', goalOptions: [], urgent: true, threat: 0 },
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
 * 战术层的档位门：只有中级档吃完整战术层。
 *
 * 2026-11-06 试过让高级档也吃（理由：最高档不该"永远只会一种打法"）。
 * 高级档 800 局 A/B 打下来 **43.3%（z=-3.82）**——显著更差；同一批改动放在
 * 中级档（战术层本来就在）是 49.1%（z=-0.49），说明伤害来自"把战术叠到
 * 更完整的评估函数上"，而不是那一次的 harass 收紧。
 *
 * 结论：战术层是补丁，补的是中级档评估函数不够用的地方；高级档自己已经算得
 * 出经济、威胁、换血，再叠一层 drive 就是双重计数，把好棋掰歪。
 * 想给高级档加变化，得改评估函数本身，而不是把驱动层打开。
 *
 * 初级档同样屏蔽——那一档的意义是"简单、可预测、给新手练手"。
 */
function moodFor(s: GameState, mood: AiMood): AiMood {
  if (aiLevelOf(s) === 'tactic') return mood;
  return {
    ...mood,
    weight: { rush: 1 / 3, harass: 1 / 3, boom: 1 / 3 },
    drive: { rush: 0, harass: 0, boom: 0 },
    driveRaw: { rush: 0, harass: 0, boom: 0 },
    abandonedCityId: null,
  };
}

/**
 * 这一回合真正生效的战术倾向（已按 AI 档位过滤）。
 *
 * 对外暴露是为了给规则用例留一个"档位隔离"的断言口：
 * 中级档原样输出 aiMood，初级/高级档权重均分、drive 清零、不弃城。
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
/**
 * 局面的静态估值（站在 me 的角度，越大越好）。
 *
 * 深推要一个"三回合之后这盘棋怎么样"的读数，而这个读数不能是"我已经很熟的那套
 * 采购评分"——那套是给单个动作打分的，拿它评局面会把"便宜"当成"好"。
 *
 * 四项，权重是照着"什么真的会决定胜负"给的：
 *
 *   · **城**：120 分一座。这是这套规则里唯一通向胜利的东西（城全丢才输），
 *     所以它必须压过其他所有项——三回合里多拿一座城，比多存两百金重要得多。
 *   · **军队**：按 `unitValue` 计价（和采购、换血用的是同一把尺子，不另造一套）。
 *   · **金**：0.35 系数。金是"还没变成兵"的兵，但它打折——因为三回合内花不出去的钱
 *     就是数字，而 AI 的常见死法恰恰是"钱在账上、人在坟里"。
 *   · **时代**：每级 40 分。时代差是复利：同样的钱，晚一代的兵就是更强。
 *
 * 再减一项**威胁**：贴在我城下的敌军价值越大，这个局面越糟。不减去它，
 * 深推会得出"我多造了一个兵所以变好了"这种结论，而那个兵正站在敌人嘴边。
 */
/**
 * ── 三回合计划：把候选落到局面上再打分 ──
 *
 * 为什么必须"落子"而不是"打分"：现在的评分是给**单个动作**打的分，它看不见
 * "这一步之后对面会怎么还手、我还接不接得上"。文档里量过：决策层早就饱和了
 * （高级 vs 中级 +0 点、五条结构性改动 46%），原因就在这里——一层贪心打分
 * 再往上加权重也不会变成"会下棋"。
 *
 * 架构上只有两件事要交代清楚：
 *
 *   1. **克隆开销**。`applyAction` 自带深拷贝，16×16、30 个兵的中局**0.55 ms** 一次
 *      （`scripts/bench-clone.ts` 实测）。真正贵的是模拟里的**打分**：一次
 *      `aiNextAction` 6.6 ms。所以宽度不能按"克隆几次"定，得按"模拟几次打分"定：
 *      `PLAN_K=2` 组候选 × 2 段模拟 × `PLAN_STEPS=3` 步 ≈ 12 次打分 ≈ 80 ms。
 *      这个数只在**战略动作**上付（见 `planWorthy`），一次走位不值得。
 *   2. **确定性**。全程不碰 `Math.random`：模拟用的还是这套 AI 自己（`depth=1`
 *      关掉深推，不会递归），随机性只有 `aiNoise(seed, …)` 这一条既有通路，
 *      所以"同一局面永远同样应对"仍然成立——存档、复盘、联机都还站得住。
 *
 * 还差一层诚实的说明：模拟对手用的是**我们自己**的决策函数（"假设对面也这么打"）。
 * 这不是对手模型，是自模型；真实的人类会犯错也会出怪招，这一层看不见。
 * 它买到的是"我三步之后接不接得上"，不是"我能不能赢人"。
 */
/**
 * 总开关。**默认关**——不是因为它有害，是因为三次实测都没量出收益。
 *
 * | 配置 | 局数 | 计分胜率（对手＝动手前那一版） |
 * |---|---:|---:|
 * | K=2 / 1 轮 / 3 步 | 400 | 49.5%（z=-0.20） |
 * | K=3 / 1 轮 / 6 步 | 240 | 49.6%（z=-0.13） |
 * | 上一行 + 节奏项（位置估值） | 200 | 49.8%（z=-0.07） |
 *
 * 三臂合计 840 局、49.6%。**深度翻倍、判据换掉，都没赢。**
 * 唯一的确定性事实是成本：一条决策从 ~7 ms 涨到 80~250 ms，自对弈慢 5~20 倍。
 *
 * 所以：**留着当搜索的地基，默认关着**。估值、克隆预算、确定性、门控、
 * 探针都在这里做完了，将来接 MCTS / 对手模型从这里往下走。
 * 打开它：把下面这行改成 true（或按 docs/AI-2026-11-04-plan.md 调参）。
 */
const PLAN_ON = false;
/**
 * 候选几个、推多深。
 *
 * 2026-11-04 第一版是 K=2 / 1 轮 / 3 步，400 局中性（49.5%）。当时的判断是"太浅"，
 * 因为一个回合真打起来十几步，3 步常常停在"部队还在路上"。
 * 这一版加到 K=3 / 2 轮 / 6 步，同时把模拟里的 lookahead 关掉（那是重复付钱），
 * 用省下来的时间换深度。
 */
const PLAN_K = 3;
/** 每一轮里两侧各走几步 */
const PLAN_STEPS = 6;
/**
 * 推几个"我→对面→我"的来回。
 *
 * 这里有个实测出来的天花板：**每多一轮，成本翻倍**，而成本的大头不在克隆
 * （0.52 ms）也不在 lookahead（模拟里已经关掉），而在"每个模拟步都要把候选
 * 全枚举一遍"——30 个单位、每单位十几种走法，一次就是几毫秒。
 *
 * 所以深度只能这么换：2 轮 × 6 步 = 单局 2.5 分钟（不可接受），
 * 1 轮 × 6 步 = 单局约 1 分钟。先用后者把"深度到底有没有用"量出来，
 * 再决定要不要为更深的搜索重写模拟策略（见文档第七节）。
 */
const PLAN_ROUNDS = 1;
/**
 * 哪些动作值得付深推的钱。
 *
 * 走位（MOVE）不进去：一步走位三回合后几乎看不出差别，却要把 80 ms 花在
 * 每一格里——一回合几十步，直接就卡了。真要看走位的后果，靠的是 ATTACK/SIEGE
 * 这两个"落子即分胜负"的动作。
 */
const PLAN_WORTHY: ReadonlySet<string> = new Set(['RECRUIT', 'UPGRADE', 'ATTACK', 'SIEGE']);

/** 当前行动方走 steps 步（不结束回合） */
function simSteps(s: GameState, steps: number, depth: number): GameState {
  let cur = s;
  for (let i = 0; i < steps; i += 1) {
    if (cur.winner) break;
    const a = aiNextActionCore(cur, { ...DEFAULT_BUDGET, maxRecruit: 1, maxUpgrade: 0 }, new Set(), depth);
    if (!a) break;
    const r = applyAction(cur, a);
    if (!r.ok) break;
    cur = r.state;
  }
  return cur;
}

/** 结束当前行动方的回合、让对面走完一回合、再结束它的回合 —— 回到"我"的时刻 */
function simRound(s: GameState, steps: number, depth: number): GameState {
  let cur = s;
  const end = applyAction(cur, { type: 'END_TURN' });
  if (!end.ok) return cur;
  cur = end.state;
  if (cur.winner) return cur;
  cur = simSteps(cur, steps, depth);
  if (cur.winner) return cur;
  const back = applyAction(cur, { type: 'END_TURN' });
  return back.ok ? back.state : cur;
}

export function positionValue(s: GameState, me: PlayerId): number {
  const hpFactor = (u: Unit): number => u.hp / Math.max(1, utype(s, u.type).maxHp);
  const cities = citiesOf(s, me);
  const army = unitsOf(s, me).reduce((n, u) => n + unitValue(s, u) * hpFactor(u), 0);
  const era = cities.reduce((m, c) => Math.max(m, c.era), 0);
  let foe = 0;
  for (const e of enemyUnitsOf(s, me)) {
    if (underConstruction(e)) continue;
    foe += unitValue(s, e) * hpFactor(e);
  }
  /*
   * 对面那项的系数必须**单独给**，不能和"我的兵"一样。
   *
   * 第一版只算了"我的兵值多少"，于是"打他一刀、自己挨一下"在估值上是净亏——
   * 深推立刻学会了一件事：**谁都别打，绕着走**。测试「贴脸的矮人王照样扔斧头」
   * 就是这么红的（第二手从 ATTACK 翻成了 MOVE）。战棋里打掉对面一个兵和
   * 保住自己一个兵，价值本来就该同权；0.9 是给"攻方略占便宜"留的一点余量。
   */
  const FOE_W = 0.9;
  /*
   * ── 节奏项：谁会先被打死 ──
   *
   * 上面四项都是"我现在有多少"，可这套规则里输赢是"谁的城先全丢"。
   * 真实对局数据指得很清楚：AI 输的局里 打出的伤害 ÷ 承受的伤害 ≈ 0.25
   * （三局明细：89/534、242/890、286/1119，见 docs/AI-2026-11-04-composition.md 第九节）。
   * 它不是"兵不够"，是**站位让它一直在挨打而打不到人**。
   *
   * 而"我囤了多少"这个口径看不见这件事：一支站在对面刀口上的部队，
   * 材料价值和一支安全的一样高。所以加一项：**对面下一回合能打掉我多少**，
   * 减去**我下一回合能打掉它多少**。`foeOutput` 本来就有（采购那条线在用），
   * 这里直接复用，不新造一套。
   *
   * 系数 0.25：一次完整对拼的价值量级是几十到一百多，0.25 让它足以压过
   * "多囤一个便宜兵"（约 30~50），又不至于把整盘棋变成只看这一项。
   */
  const TEMPO_W = 0.25;
  const threatOnMe = outputFrom(s, enemyUnitsOf(s, me), unitsOf(s, me));
  const threatOnFoe = outputFrom(s, unitsOf(s, me), enemyUnitsOf(s, me));
  return (
    cities.length * 120 +
    army -
    foe * FOE_W +
    s.players[me].gold * 0.35 +
    era * 40 +
    (threatOnFoe - threatOnMe) * TEMPO_W
  );
}

export function foeOutput(s: GameState, me: PlayerId): number {
  return outputFrom(s, enemyUnitsOf(s, me), unitsOf(s, me));
}

/**
 * `shooters` 一轮能对 `targets` 打出多少"价值"。
 *
 * 抽出来是为了多人局：既要算"对面能打我多少"，也要算"我能打对面多少"，
 * 而后者没法用 `foeOutput(s, 对面某一家)` 表达（那个函数算的是"那一家挨多少打"，
 * 在三人局里会把另一家的输出也算进去）。所以把两端都摆到参数上。
 */
function outputFrom(s: GameState, shooters: Unit[], targets: Unit[]): number {
  const mine = targets;
  if (mine.length === 0) return 0;
  let total = 0;
  for (const e of shooters) {
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

/**
 * 决策作用域的开关：作用域内的重复查询（光环、视野）走缓存，出门即失效。
 * 见 `memo.ts`——那里写了为什么必须是显式作用域而不是永久缓存。
 */
function aiNextActionCore(
  s: GameState,
  budget: AiBudget = DEFAULT_BUDGET,
  rejected: ReadonlySet<string> = new Set(),
  depth = 0,
  strategist: Strategist = NULL_STRATEGIST,
): Action | null {
  const owner = enterMemoScope();
  try {
    return aiNextActionCoreInner(s, budget, rejected, depth, strategist);
  } finally {
    if (owner) exitMemoScope();
  }
}

function aiNextActionCoreInner(
  s: GameState,
  budget: AiBudget = DEFAULT_BUDGET,
  rejected: ReadonlySet<string> = new Set(),
  /** 深推层号：>0 表示这是模拟里的一次决策，**不再往下推**，防止递归 */
  depth = 0,
  /** 战略层（见 `ai-strategist.ts`），默认为"不干预" */
  strategist: Strategist = NULL_STRATEGIST,
): Action | null {
  if (s.winner) return null;
  /*
   * 三人四人局：能打，但不是"多人专用 AI"。
   *
   * 2026-11-04 之前这里直接 return null——理由是这套 AI 的每个判断都建立在
   * "只有一个对手"上。现在为了指挥官模式能进多人局，把"对面"从一家放宽成一群：
   *   · 打架、算威胁、看对面经济：按**所有敌人**（`enemyUnitsOf` / `enemyCitiesOf`）；
   *   · 推进方向、桥头距离这类必须挑一家的：按**最强的那家**（`primaryFoe`）。
   * 双人局下这两条和原来的 `other(me)` 完全等价，所以既有对局行为不变。
   *
   * 已知的短板（诚实说明）：它**不会**同时规划两条战线，也不会"远交近攻"——
   * 谁是最大的那个就当主要对手，跟第二家打是顺手的事。多人局里它比双人局弱。
   */

  const me = s.current;
  // 关键：只看自己看得见的东西，跟玩家同等信息
  const playerViewNow = playerView(s, me);
  const view = playerViewNow.state;

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
  /*
   * 产兵名额：默认沿用调用方给的预算（2），可以按"空格子数"放开。
   *
   * 规则层不限每回合造几个——限制只有钱和格子。那个 2 是历史遗留
   * （`DEFAULT_BUDGET.maxRecruit`，最初提交里没写理由），
   * 它让 AI 明明算得出"每回合能有 128 战力"，却只准自己出两个兵。
   */
  const recruitCap =
    typeof s.config.aiRecruitCap === 'number'
      ? Math.max(0, s.config.aiRecruitCap)
      : // 默认（未写 / 'auto'）按空格子数放开：规则层本来就不限每回合造几个，
        // 限制只有钱和格子。帽子留成"低难度开关"（`--recruit-cap 2`）
        Math.max(budget.maxRecruit, productionCapacity(view, me));
  const mayRecruit = commander
    ? !idleHead && head !== '' && head !== ORDER_UPGRADE && budget.recruited < 1
    : budget.recruited < recruitCap;
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
  const foeUnits = enemyUnitsOf(view, me);
  /** 两翼分工：主攻方向定了才能分第二路 */
  const flank = flankSplit(view, me, land, mood.focusCityId);

  /*
   * 资源趋势：拿**上一回合开始时**的存量比现在。
   *
   * 只在 `depth === 0` 时往后写（推演分支不该改我方的账本），
   * 而且只在一局的新回合第一次决策时写一次——一回合里有很多次决策，
   * 每次都写就等于拿"上一步"比"这一步"，支出会被误判成"供不上"。
   */
  const prevMark = s.aiResMark?.[me];
  const pendingScarce = scarceResources(view, me, prevMark);
  if (depth === 0 && (!prevMark || prevMark.turn !== s.turn)) {
    s.aiResMark = {
      ...(s.aiResMark ?? {}),
      [me]: {
        turn: s.turn,
        stock: { ...((s.players[me].res ?? {}) as Record<string, number>) },
      },
    };
  }

  /*
   * 决战时代：S2a 只在开了 `config.aiEraModel` 时算一遍并记进局面。
   *
   * **目前没有任何消费方**——它不影响采购、不影响走位、不影响开火。
   * 先让数能被看见（回放 sidecar + 自动对照），再决定拿它去压什么。
   * `depth > 0` 不记：推演分支不该往账本里塞东西。
   */
  if (depth === 0 && s.config.aiEraModel) {
    noteEraDecision(s, view, me, s.config.aiEraModel);
  }

  // 先算一次：下面 `bridgeSite` / `bridgeClear` 都要用它，不能在字面量里互相引用

  const needBridgeNow = !canReachEnemyByLand(view, me);


  /*
   * 威胁强度：先读上回合的 `keep.cityHitTurn`，再更新本回合的城血。
   * 只在 `depth === 0` 写账本，推演分支不该改它。
   */
  const keepPrev = (focusOf(s, me).plan?.keep ?? {}) as Record<string, unknown>;
  const threatScale =
    s.config.aiThreatScale === true ? threatScaleOf(view, me, keepPrev) : 0;

  /*
   * 疏散链：回合级维护。每回合建一次；每步把"已经到了目标"的链头弹出，
   * 只把当前链头交给 `unitCandidates`（它只给这一条候选）。
   */
  const keepYield = (focusOf(s, me).plan?.keep ?? {}) as Record<string, unknown>;
  let yieldChain = keepYield.yieldChain as Array<{ id: string; x: number; y: number }> | undefined;
  if (!Array.isArray(yieldChain) || yieldChain.length === 0 || Number(keepYield.yieldTurn ?? -1) !== view.turn) {
    yieldChain = buildYieldChain(view, me);
  }
  while (yieldChain.length > 0) {
    const head = yieldChain[0]!;
    const u = view.units.find((x) => x.id === head.id);
    if (!u || (u.x === head.x && u.y === head.y)) yieldChain.shift();
    else break;
  }
  if (depth === 0 && focusOf(s, me).plan) {
    focusOf(s, me).plan!.keep = {
      ...(focusOf(s, me).plan!.keep ?? {}),
      yieldChain,
      yieldTurn: view.turn,
    };
  }
  const yieldChainHead = new Map<string, { x: number; y: number }>();
  if (yieldChain.length > 0) {
    const head = yieldChain[0]!;
    yieldChainHead.set(head.id, { x: head.x, y: head.y });
  }

  const fields: Fields = {
    tactical: tacticalMap(view, me),
    land,
    wade,
    water: distanceFields(view, me, 'water'),
    air: distanceFields(view, me, 'air'),
    bridgeSite: bestBridgeSite(view, me, wade),
    crossingSite: null,
    holdFire: false,
    scout: null,
    peek: null,
    crossingAlt: null,
    buildGuide: null,
    builderNeed: 0,
    threatScale,
    pullHome: 0,
    weights: neutralWeights(),
    focusCityId: mood.focusCityId,
    flankCityId: flank.flankCityId,
    flank: flank.flank,
    mood,
    needBridge: needBridgeNow,
    commit: false,
    // 弃城期不派人守那座城（传进去，pickGuardCity 会跳过它）
    guardCityId: pickGuardCity(view, me, foeUnits, mood.abandonedCityId),
    // 集火目标：整回合算一次，所有单位的攻击候选都看它
    focusTargetId: pickFocusTarget(view, me, mood.focusCityId),
    // 海军需求 / 局势时代：同样整回合算一次，建造评分每个候选格都要读
    sea: seaDemand(view, me),
    era: eraNowOf(view),
    urgent: isUrgentNow(view, me, unitsOf(view, me), foeUnits, mood),
    scarce: pendingScarce,
    threat: threatLevelOf(view, me, foeUnits, mood),
    // 承诺在下面算完再填（它要读 fields.era，而 fields 正在构造中）
    goalCommit: null,
    // 战线 / 站位密度：集结的两个半边，见 Fields 里的说明
    lineRef: frontLineRef(view, me, land, mood.focusCityId),
    crowd: crowdField(view, me),
    chokedCities: citiesOf(view, me)
      .filter((c) => !c.ruined && spawnCellCountOf(view, c) === 0)
      .map((c) => c.id),
    spawnStarved: citiesOf(view, me)
      .filter((c) => !c.ruined && spawnCellCountOf(view, c) < c.size * c.size)
      .map((c) => c.id),
    yieldPlan: yieldChainHead,
    squadTarget: squadTargetsOf(view, me),
    squadNeed: squadShortfallOf(view, me),
    squadInfo: squadInfoOf(view, me),
    developBias: postureBudgetOf(view, me).y,
    homeCityId:
      citiesOf(view, me)
        .filter((c) => !c.ruined)
        .sort((a, b) => b.hp - a.hp)[0]?.id ?? null,
    bridgeClear: (() => {
      const out = new Set<number>();
      const site = needBridgeNow ? bestBridgeSite(view, me, wade) : null;
      if (!site) return out;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const x = site.x + dx;
          const y = site.y + dy;
          if (!inBounds(view, x, y)) continue;
          out.add(y * view.w + x);
        }
      }
      return out;
    })(),
    foeSplash: enemyUnitsOf(view, me).filter((u) => (utype(view, u.type).splash ?? 0) > 0).length,
    // 对方手里有几个经济单位：攻城加分与僵持破局都要读它（整回合算一次）
    foeEcon: enemyUnitsOf(view, me).filter((u) => utype(view, u.type).category === 'economy').length,
  };
  /*
   * 产业链承诺：每回合算一次，写回**真状态**。
   *
   * 和 `aiIntent` 走同一条路（见下面那段注释）：判断在雾图副本上做，
   * 记忆必须落在真状态上，否则下次再从真状态切一份新副本，记忆就丢了。
   *
   * `depth > 0` 时只读不写：那是"推演对手下一步"的分支，不该顺手改我方的账本。
   */
  {
    const prevCommit = focusOf(s, me).chain ?? null;
    const baseCtx = goalCtxOf(view, me, fields.era, fields.urgent, fields.threat, prevCommit);
    const nextCommit = resolveCommit(baseCtx, prevCommit);
    fields.goalCommit = nextCommit;
    if (depth === 0) {
      if (nextCommit) {
        if (nextCommit !== prevCommit) {
          setFocus(s, me, { ...focusOf(s, me), chain: nextCommit });
        }
      } else if (prevCommit) {
        setFocus(s, me, { ...focusOf(s, me), chain: null });
      }
    }
  }

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
  {
    const vf = view.aiFocus?.[me] ?? null;
    if (vf) setFocus(s, me, vf);
    else if (s.aiFocus?.[me]) setFocus(s, me, null);
  }
  // 这一回合的升级名额已经用掉了：攒时代的计划对采购就不再生效。
  // 不然钱被冻着、升级又没得升，这一回合等于白过——而且连着几个回合都白过。
  if (!mayUpgrade && plan.savingFor === 'era') plan.savingFor = null;

  /*
   * 收尾计划：对面只剩废墟时，派人去接管。
   *
   * 这一条是"计划 → 动作"的第一个出口，和攒钱/选目标那些分开：
   *   · 判据每回合重算（局面会变），记忆只记"我盯的是哪座城"；
   *   · 立约/改投的双阈值现在用不上——只有一条计划，没有第二家可投。
   *     等计划清单长到两三条，这里换成 `{ id, valueAt }` + `COMMIT_KEEP_RATIO`
   *     那一套（见 docs/PLAN-AI-V3 的 S2 与第八节）；现在多写一个阈值只是
   *     多一处没人验的常数。
   *   · 只在 `depth === 0` 写记忆：推演分支不该改我方的账本。
   */
  {
    /*
     * 计划排序层（P2）：先只把"收尾"接进来。
     *
     * 判据、动作、分档全部沿用搬之前那份实现，所以这一步应当**零变化**——
     * 验收看 seed 906 仍是 76 回合、以及动作指纹逐条相同。
     *
     * `canReach` 填 `!fields.needBridge`：可达性只影响执行、不影响价值，
     * 现在只给收尾用（它不看这个字段），等"决战"接进来才会读到。
     */
    const myValNow = unitsOf(view, me)
      .filter((u) => utype(view, u.type).category === 'combat')
      .reduce((n, u) => n + (utype(view, u.type).cost ?? 0), 0);
    const foeValNow = foeUnits
      .filter((u) => utype(view, u.type).category === 'combat')
      .reduce((n, u) => n + (utype(view, u.type).cost ?? 0), 0);
    /*
     * 决战时机的**估计**先算（投影比、行军回合），判决本身由 `DECISIVE_PLAN`
     * 拥有（回滞 + 驻留记在它自己的口袋里）。估计和判决分开，是为了以后
     * 有情报时只换估计器，不动判决——见 `PlanCtx.intelKnown` 那个口子。
     */
    const decisive =
      s.config.aiDecisive === false
        ? null
        : decisiveOf(view, me, fields.land, playerViewNow.ghosts);
    /*
     * 计划层的主攻城市：上一回合 `breakthrough` 定的那一座（存在 keep 里）优先，
     * 否则用 mood 算的。**必须是上一回合的**——`resolvePlans` 还没跑，
     * 这一回合的指令要等它算完才知道；一回合的延迟换"过河计划能跟着换目标"。
     */
    const plannedCity =
      ((focusOf(s, me).plan?.keep?.breakCity as string | undefined) ?? mood.focusCityId) || null;
    const planCtx = planCtxOf(view, me, {
      focusCityId: plannedCity,
      canReach: canReachEnemyByLand(view, me, plannedCity ?? undefined),
      threat: fields.threat,
      weaker: myValNow < foeValNow * 0.75,
      enemyAtGate: foeUnits.some((u) => citiesOf(view, me).some((c) => distToCity(u, c) <= 3)),
      ...(decisive
        ? { marchTurns: decisive.marchTurns, projRatio: decisive.ratio, intelConf: decisive.intelConf }
        : {}),
    });
    const prevPlan = focusOf(s, me).plan ?? null;
    const resolved = resolvePlans(planCtx, prevPlan, { urgent: fields.urgent });
    /*
     * 落点：过河计划钉住的渡口。走位、建房评分、工程队那道闸都认它，
     * **不要各读各的状态**——两处各挑一个点，就会出现"人往东走、桥往西修"。
     */
    /*
     * 指令：集中突破 / 绕路。三条都是"改目标"，不是乘数。
     *
     * 改了主攻城市之后要**重算集火目标**——不重算的话，
     * 部队会朝着新城市走，火力还锁在旧城那边。
     */
    if (resolved.orders.focusCityId) {
      fields.focusCityId = resolved.orders.focusCityId;
      fields.focusTargetId =
        resolved.orders.focusUnitId ?? pickFocusTarget(view, me, resolved.orders.focusCityId);
    }
    if (resolved.orders.commit) fields.commit = true;
    // 侦查指令：派谁/去哪。为 null 时不写，保持"这回合不侦查"
    if (resolved.orders.scout) fields.scout = resolved.orders.scout;
    if (resolved.orders.peek) fields.peek = resolved.orders.peek;
    if (resolved.orders.altCrossing) {
      fields.crossingAlt = {
        x: resolved.orders.altCrossing.x,
        y: resolved.orders.altCrossing.y,
        unitIds: new Set(resolved.orders.altCrossing.unitIds),
      };
    }
    fields.crossingSite = resolved.focus;
    fields.weights = resolved.net;
    fields.pullHome = resolved.net.pullHome;
    fields.holdFire = resolved.net.holdFire;
    if (resolved.focus) fields.bridgeSite = resolved.focus;
    for (const item of planActions(resolved.action, planCtx)) {
      candidates.push({ action: item.action, score: item.score ?? PLAN_TUNING.actionScore });
    }
    if (depth === 0) {
      if (resolved.memo !== prevPlan) setFocus(s, me, { ...focusOf(s, me), plan: resolved.memo });
      notePlanTrace(s, me, resolved);
      /*
       * 城血比较放在这里：`plan` 是 `resolvePlans` 之后才有的，
       * 放在它之前写 `keep` 会一直读到 `plan == null`，`cityHp` 永远为空
       * （实测 threat 一直是 0.00、城血 {}）。
       */
      if (focusOf(s, me).plan) {
        const k = { ...(focusOf(s, me).plan!.keep ?? {}) };
        const hp = { ...((k.cityHp as Record<string, number> | undefined) ?? {}) };
        for (const c of citiesOf(view, me)) {
          if (typeof hp[c.id] === 'number' && c.hp < (hp[c.id] ?? 0) - 0.5) {
            k.cityHitTurn = view.turn;
          }
          hp[c.id] = c.hp;
        }
        k.cityHp = hp;
        k.threatScale = threatScale;
        focusOf(s, me).plan!.keep = k;
      }
      /*
       * 编队上报：这是"下面往回说话"的第一条通道。
       *
       * 写两处：
       *   · `keep.squads` —— 下回合拿它比"有没有前进、掉了几个"，所以要留着；
       *   · `aiSquads` —— 给人看的历史，**只在结论变化时记**，否则 260 回合
       *     × 两席 × 三段会把 state 撑爆。
       */
      /*
       * `depth === 0` 只表示"不是递归推演"，**每次出动作都会进来**（一回合十几次）。
       * 编队维护每回合只做一次：不去重的话"成员死了要清理"会被重复执行，
       * 而"连续几回合没推进"会被算成"连续十几次"（实测溢出到 554）。
       */
      const focusNow = focusOf(s, me);
      const sameTurn = Number(focusNow.plan?.keep?.squadTurn ?? -1) === s.turn;
      if (!sameTurn) {
        const tick = squadTick(
          s,
          me,
          fields.focusCityId,
          // 默认关：申报的规模实测会把编队撑大、出发更慢（见 types 的 aiNeedSquad）
          s.config.aiNeedSquad === true ? resolved.orders.needSquad : undefined,
          resolved.orders.buildPoint ?? null,
        );
        const reps = tick.reports;
        fields.squadNeed = tick.squadNeed;
        fields.builderNeed = tick.builderNeed;
        const f2 = focusOf(s, me);
        if (f2.plan) {
          f2.plan.keep = { ...(f2.plan.keep ?? {}), squads: reps, squadTurn: s.turn };
        }
        /*
         * 建造编队的走位引导：由 `squadTick` 刚写回的编队决定。
         * 这里读一次、存进 `fields`，走位层就不再自己找"该去哪个渡口"。
         */
        const buildSq = (f2.squads ?? []).find((sq) => sq.role === 'build' && sq.targetPoint);
        if (buildSq?.targetPoint) {
          fields.buildGuide = {
            x: buildSq.targetPoint.x,
            y: buildSq.targetPoint.y,
            unitIds: new Set(buildSq.memberIds),
          };
        }
        if (reps.length > 0) {
          const sig = reps.map((x) => `${x.id}:${x.note}:${x.count}`).join('|');
          const log = (s.aiSquads ??= []);
          const last = [...log].reverse().find((x) => x.me === me);
          const lastSig = last ? last.squads.map((x) => `${x.id}:${x.note}:${x.count}`).join('|') : '';
          if (sig !== lastSig) {
            log.push({
              turn: s.turn,
              me,
              cityId: focusOf(s, me).squads?.[0]?.targetCityId ?? null,
              squads: reps,
            });
            if (log.length > 200) log.splice(0, log.length - 200);
          }
        }
      }
      // 判决由 `DECISIVE_PLAN` 拥有（回滞记在它口袋里），这里只记日志
      if (decisive) {
      const call = (resolved.memo?.pockets['decisive']?.call ?? null) as 'attack' | 'develop' | null;
    if (call) {
      const list = (s.aiCalls ??= []);
      const last = [...list].reverse().find((x) => x.me === me);
      if (!last || last.call !== call) {
        list.push({
          turn: s.turn,
          me,
          marchTurns: decisive.marchTurns,
          knownPower: Math.round(decisive.rememberedPower),
          knownUnits: decisive.rememberedCount,
          intelConf: Number(decisive.intelConf.toFixed(2)),
          myPower: Math.round(decisive.myPower),
          foePower: Math.round(decisive.foePower),
          myPerTurn: Math.round(decisive.myPerTurn),
          foePerTurn: Math.round(decisive.foePerTurn),
          call,
          why: decisive.why,
        });
        if (list.length > 300) list.splice(0, list.length - 300);
      }
    }
  }
    }
  }

  /*
   * 决战时机：现在打还是等产能堆起来。
   *
   * `aiDecisive === false` 时不算（做 A/B 用）。结论只用来**压住明显送死**的进攻，
   * 不用来"催"它去打——催的教训在 P4：任何把进攻权重压到 1 以下的改动，
   * 都会让双方一起龟缩。
   */
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
  const foeVal = enemyUnitsOf(view, me)
    .filter((u) => utype(view, u.type).category === 'combat')
    .reduce((n, u) => n + (utype(view, u.type).cost ?? 0), 0);
  // 压城门槛：速攻更早认定"我现在打得穿"（它整局的胜负压在这一次围城上），
  // 弃城期更晚——这时候全军压上去只是把攒的钱换成对面的击杀数。
  const commitAt =
    1.3 - 0.18 * mood.driveRaw.rush + 0.15 * mood.driveRaw.boom;
  /*
   * **没有敌城就不该进入"全军压城"。**
   *
   * 这个判据是"我比对面强三成 → 不追野战，直接压城"。但迷雾里看不见敌人时
   * `foeVal` 是 0，条件恒真：无城对局（双方都没有城）里 AI 一开局就进了压城模式，
   * 而压的对象根本不存在——走位候选因此只剩一两条、分数还是负的，
   * 实测两支军队在雾里站了五百多步。压城的前提是**有城可压**。
   */
  const foeCityCount = view.cities.filter((c) => c.owner !== me && !c.ruined).length;
  fields.commit = foeCityCount > 0 && myVal > 0 && myVal >= foeVal * commitAt;

  /*
   * C（2026-11-15）：**僵持破局**。
   *
   * 症状：两边都在集兵，谁都不肯先踏进对方射程，于是一路拖到回合上限。
   * 这不是某一处评分的 bug——只要双向都怕"进射程挨一轮"，就会锁死在这种平衡里。
   * 所以这里不看单步分数，看**局面是不是在动**：两边战斗单位的总血量连着
   * 若干个动作没变过，就说明没有任何一方在交换。
   *
   * 触发后只做一件事：`commit = true`。它的作用是关掉"追着路过的敌军打"
   * 那一路（见 Fields.commit 的说明），部队才会真的朝城下压。
   * 另外三道闸，免得开局集兵期就被误触发：
   *   · `s.turn >= 20`——前十个回合双方本来就没接触，那不是僵持；
   *   · `myEcon > foeEcon`——经济落后还去压城是送死，那种局面该继续攒；
   *   · `myVal >= foeVal * 0.9`——兵力明显不如对面时，压城只是换个地方挨打。
   */
  const combatHp = (list: Unit[]): number =>
    list.reduce(
      (n, u) => (utype(view, u.type).category === 'combat' ? n + Math.max(0, u.hp) : n),
      0,
    );
  const hpNow = combatHp(unitsOf(view, me)) + combatHp(foeUnits);
  const prevStale = s.aiStale;
  const staleN = prevStale && prevStale.hp === hpNow ? prevStale.n + 1 : 0;
  s.aiStale = { hp: hpNow, n: staleN };
  const myEcon = unitsOf(view, me).filter((u) => utype(view, u.type).category === 'economy').length;
  if (staleN >= 6 && s.turn >= 20 && myEcon > fields.foeEcon && myVal >= foeVal * 0.9) {
    fields.commit = true;
    if (aiTrace.on) aiTrace.staleCalls += 1;
  }

  const myUnitsNow = unitsOf(view, me);
  for (const u of myUnitsNow) {
    const own = unitCandidates(view, u, fields, traits, rejected);
    candidates.push(...own);
    const skill = heroSkillCandidate(view, u);
    if (skill) candidates.push({ ...skill, score:skill.score+300 });
    /*
     * 单兵 AI：问一句"这个兵自己打算干什么"。
     *
     * 只有兵种写了 `aiProfile` 且自主分 > 0 才会走到这里（`unitAiOf` 连表都不查），
     * 所以现有对局的行为**一个字节都不变**——这是这一层能合进主线的唯一前提。
     */
    const unitAi = unitAiOf(view, u);
    if (unitAi) candidates.push(...unitAiCandidates(view, u, own, rejected, unitAi, foeUnits, myUnitsNow));
  }

  /*
   * 产业链目标的"非建造"动作（研发法术、研读、升级建筑……）。
   *
   * 一场只问一次：这些是**席位级**的决定，跟着每个兵问一遍只会得到重复候选。
   * 扩展写的 handler 抛错只警告一次、跳过——一个写坏的目标不该把整局打死。
   */
  {
    const goalCtx = goalCtxOf(view, me, fields.era, fields.urgent, fields.threat, fields.goalCommit);
    for (const { step } of goalStepsInPlay(goalCtx)) {
      if (!step.actions) continue;
      try {
        for (const c of step.actions(goalCtx)) candidates.push(c);
      } catch (err) {
        unitAiWarn(`goal-actions:${step.id}`, `[ai-goal] 目标段「${step.id}」的动作抛错，跳过：${String(err)}`);
      }
    }
  }

  // 这一回合"要不要养海军"：整回合只算一次（里面有一次全图 flood fill），
  // 别让它跟着每个产兵点、每个候选兵种重算。
  const seaDemandNow = seaDemand(view, me);

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
        /*
         * 经济权重 = 排序层给的 × 战略层的发展意愿。
         *
         * 1+3y 是量出来的：农民 payback ≈ 6.4 回合、基础分只有 24，
         * 而战斗单位带质量项能到 100 上下——不放大到 2~3 倍，经济永远排不上。
         */
        fields.weights.econ * (1 + 3 * fields.developBias),
      );
      if (c) candidates.push(c);
    }
    // 产兵建筑：按自己的档位出兵（2026-11-08 删掉"军工供货"）。
    // 城市没了也照样能补兵——它不再靠后方供货，这条曾经是绕后骚扰的命门。
    {
      for (const u of unitsOf(view, me)) {
        if (!isProducer(utype(view, u.type))) continue;
        if (orderSite && u.id !== orderSite) continue;
        const era = utype(view, u.type).era;
        const c = recruitCandidate(
          view,
          { kind: 'camp', id: u.id, x: u.x, y: u.y, era },
          traits,
          plan,
          order,
          mood,
          seaDemandNow,
          fields.weights.econ,
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

  /*
   * 战略层第一刀：现在能不能主动进攻。
   *
   * 默认策略恒 true（见 `NULL_STRATEGIST`），所以挂不挂它行为一样——
   * 必须先证明"口子本身不改变行为"，才敢往里面塞真策略。
   * 这里的"进攻"只算 ATTACK / SIEGE 两类显式开火动作；
   * "朝敌城推进"的走位留在战术层，等这一步验证完再决定要不要一起压。
   */
  /*
   * 决战时机接到"能不能打"上：**只在明显打不过时收手**。
   *
   * 判据是"越等越强、而且现在兵力还不到对面八成半"。不满足就不拦——
   * 拦得太宽会让双方一起龟缩（P4 的教训），所以这条闸故意开得很窄。
   */
  // 开火闸门由 `DECISIVE_PLAN` 给（`holdFire`），不再是这里临时算的一个布尔
  const mayAttack = strategist.mayAttack(s, me) && !fields.holdFire;
  for (let i=candidates.length-1;i>=0;i--) {
    const action=candidates[i]!.action;
    if (!mayAttack && (action.type === 'ATTACK' || action.type === 'SIEGE')) {
      candidates.splice(i, 1);
      continue;
    }
    if (rejected.has(aiActionKey(action))) { candidates.splice(i,1); continue; }
    /*
     * **建造落点用真局再核一次**（2026-11-20，T3）。
     *
     * 候选是在**雾图**上算的：AI 看不见的敌人正好站在它想盖的那一格，
     * 提出来到真局就非法。实测 4 局 22 次（`probe:ai-goal` 早期统计），
     * 每次白扔一步——实机会顺延，跑批脚本会中断整回合。
     *
     * 修法和当年"走位落点"那条一样（见 docs/UPDATE-2026-10-28-height-terrain.md）：
     * **只核合法性、不核内容**。这里只问"真局这一格有没有人"，不问是谁，
     * 所以不算开图——AI 从中学不到任何关于敌人的信息，只是少提一个必被拒的动作。
     */
    if (action.type === 'BUILD') {
      const occ = s.units.some((u) => u.hp > 0 && u.x === action.x && u.y === action.y);
      const built = s.cities.some((c) => c.x === action.x && c.y === action.y);
      if (occ || built) { candidates.splice(i, 1); continue; }
    }
    if (action.type==='BUILD' && plan.savingFor && !plan.urgent) {
      const cost=recruitCost(view,me,utype(view,action.unitType));
      /*
       * 2026-11-20：产业链**自己那一步**的建筑不吃冻结。
       *
       * 建筑额度 `buildAllowance = 余额 − 目标价` 是二值的（见 AiPlan 里的注释：
       * 放开过、结果 AI 把钱全铺成磨坊）。但这条对产业链是死结——"攒钱建宗门"
       * 里，宗门既是攒钱的目标又是建筑，冻结它就等于永远建不了。
       * 所以只放目标认领的那一种，磨坊照样冻结。
       */
      const forGoal = plan.savingFor === 'goal' && goalClaimsBuildOf(
        view, me, action.unitType, fields.era, fields.urgent, fields.threat, fields.goalCommit, fields.scarce,
      );
      if (cost>plan.buildAllowance && !utype(view,action.unitType).bridges && !forGoal) candidates.splice(i,1);
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
  /*
   * 模拟里不做这一步（`depth > 0`）：lookahead 是"这一步之后对面最狠的一刀"，
   * 它的价值在于**单步决策**时补上对手反应；而在模拟里，外层的深推已经把
   * 对面整回合走了一遍，这一层就是重复付钱——而且是最贵的那一笔
   * （每个候选要 applyAction + foeOutput 各一次）。
   */
  const lookahead = depth === 0 && aiLevelOf(s) !== 'basic' && candidates.length > 1;
  const reply0 = lookahead ? foeOutput(view, me) : 0;
  const K = lookahead ? LOOKAHEAD_K : LOOKAHEAD_K * 2;
  const shortlist: Array<{ c: Candidate; v: number }> = [];
  for (const c of candidates) {
    if (shortlist.length >= K) break;
    if (!moveOkInReal(c.action)) continue;
    const applied = applyAction(view, c.action);
    if (!applied.ok) continue;
    let v = c.score;
    // 剧本动作 / 演出招式不吃这一刀（见 Candidate.ignoreRisk 的说明）
    if (lookahead && !c.ignoreRisk) v -= LOOKAHEAD_W * Math.max(0, foeOutput(applied.state, me) - reply0);
    shortlist.push({ c, v });
  }
  if (shortlist.length === 0) return null;
  shortlist.sort((a, b) => b.v - a.v);

  /*
   * 三回合计划：对前 PLAN_K 名各落一次子，把"我这一步 → 对面一回合 → 我下一步"
   * 真的走一遍，再用 `positionValue` 比这盘棋变成什么样。
   *
   * 三个刻意的限制：
   *   · 只在 `depth === 0` 跑——模拟里的决策不再深推，否则就是指数爆炸；
   *   · 只对战略动作跑（`PLAN_WORTHY`），走位不值这 80 ms；
   *   · 换掉启发式第一名要**过线**（`PLAN_MARGIN`），差一点就不翻——
   *     深推的结果本身有噪声（模拟只走 3 步），贴着边翻来翻去只会让 AI 抽风。
   */
  let best = shortlist[0]!;
  let planned = false;
  const shape = best.c.action.type;
  /*
   * 指挥官模式 / 玩家点名的那一格**不深推**：那一格是玩家的决定，不是 AI 的。
   * 深推在这里只会做一件事——把"升这座城"换成"它觉得更划算的那个"，
   * 而玩家明明已经指定了。用例「「升级时代」那一格也能指定升哪座城」就是被这个打红的。
   */
  const planAllowed =
    PLAN_ON &&
    depth === 0 &&
    !commander &&
    !order &&
    !orderSite &&
    // 沙盒里没有城，"多一座城 120 分"那套估值不成立；而且那里是拿来试单个兵的地方
    s.config.godMode !== true &&
    shortlist.length > 1 &&
    PLAN_WORTHY.has(shape);
  if (planAllowed) {
    aiTrace.planRuns += 1;
    const base = positionValue(view, me);
    const probe = shortlist.slice(0, PLAN_K);
    const vals = probe.map((e) => {
      const a1 = applyAction(view, e.c.action);
      if (!a1.ok) return -Infinity;
      let st = a1.state;
      // 我这一步 → （对面一整回合 → 我下一回合）× PLAN_ROUNDS
      for (let r = 0; r < PLAN_ROUNDS; r += 1) {
        st = simRound(st, PLAN_STEPS, depth + 1);
        if (st.winner) return st.winner === me ? 1e6 : -1e6;
        st = simSteps(st, PLAN_STEPS, depth + 1);
        if (st.winner) return st.winner === me ? 1e6 : -1e6;
      }
      return positionValue(st, me) - base;
    });
    let bi = 0;
    for (let i = 1; i < vals.length; i += 1) if ((vals[i] ?? -Infinity) > (vals[bi] ?? -Infinity)) bi = i;
    const margin = Math.max(40, Math.abs(vals[0] ?? 0) * 0.05);
    if (bi > 0 && (vals[bi] ?? -Infinity) > (vals[0] ?? -Infinity) + margin) {
      best = probe[bi]!;
      planned = true;
      if (aiTrace.on) aiTrace.planFlip += 1;
    }
  }
  /*
   * 分数 ≤0 就不要这一步——但**计划翻上来的候选除外**：它的启发式分本来就低
   * （正因为低才需要深推来翻案），拿那个分来否决它等于白推一遍。
   */
  if (!planned && best.v <= 0) return null;
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

/**
 * 屯兵不动的"守家半径"：单位离自家城超过这么远就算出击。
 *
 * 4 格是这么定的：远程兵（射程 3）站在城下能覆盖到 4~5 格，再往外走就是
 * 拿肉身去换视野了。屯兵不动要的是"不送"，不是"缩在城里一兵不出"——
 * 敌人贴着城墙打，该还手还是要还手。
 */
const HOLD_RADIUS = 4;

/** 这个动作算不算"出击"（屯兵不动模式下要否掉的那些） */
function isOffensive(s: GameState, me: PlayerId, a: Action): boolean {
  const myCities = citiesOf(s, me).filter((c) => !c.ruined);
  if (myCities.length === 0) return false;
  const nearHome = (x: number, y: number): boolean =>
    myCities.some((c) => Math.hypot(c.x - x, c.y - y) <= HOLD_RADIUS);
  if (a.type === 'MOVE') return !nearHome(a.x, a.y);
  if (a.type === 'ATTACK') {
    const t = s.units.find((u) => u.id === a.targetId);
    return !!t && !nearHome(t.x, t.y);
  }
  if (a.type === 'SIEGE') {
    const c = s.cities.find((x) => x.id === a.cityId);
    return !!c && !nearHome(c.x, c.y);
  }
  // 建造/产兵/升级/结束回合都不算出击
  return false;
}

/**
 * AI 的对外入口：先让 core 决定这一手，再按玩家点的策略过一道闸。
 *
 * 目前只有 `hold` 需要这道闸——它是**否定式**的规则（"别干这个"），
 * 塞进评分里要在每个评分点上写一遍，而否定式天然适合放在出口处。
 * 做法是借 core 已有的 `rejected` 机制：否掉一个、再问一次，直到它给出一个守家的动作。
 */
/**
 * 督战：核心 AI 认为"这一回合没值得做的事"时，替它挑一个"往敌城挪一步"的单位。
 *
 * 为什么需要这一层（2026-11-16，观战「邪龙」时发现的"三方都不动"）：
 *
 * 评分链上"值得做"的门槛是 `best.v > 0`。一批单位站在离城十几格的开阔地上时，
 * 往前一步的推进分（0.3~1）× 各种系数之后仍然可能是负的——推进那点分抵不过
 * 地形分和拥挤分。于是它们每回合都拿到 null，二十多个单位里只有三四个在动，
 * 大军就那么停在半路上。核心评分本身没错（它只做"这一步值不值"），错的是
 * **没有任何机制去兜住"整支军队都不想动"这个局面**。
 *
 * 只在关卡写了 `pressure` 时启用，而且只在核心已经放弃之后才走这一步，
 * 所以普通对局一个字都不变。挑的是"能走、且离最近的敌城更近"的格子——
 * 不评估威胁、不看队形，就是要它们压过去。
 */
function pressureAdvance(s: GameState): Action | null {
  const me = s.current;
  const foeCities = enemyCitiesOf(s, me).filter((c) => !c.ruined);
  if (foeCities.length === 0) return null;
  const nearest = (x: number, y: number): number =>
    Math.min(...foeCities.map((c) => distToCity({ x, y } as Unit, c)));

  /** 找"还能动、且这一步真的更接近敌城"的单位里最靠前的那一个 */
  let picked: { action: Action; gain: number } | null = null;
  for (const u of unitsOf(s, me)) {
    if (u.moved || u.acted) continue;
    const cat = utype(s, u.type).category;
    if (cat === 'economy' || cat === 'builder') continue;
    const now = nearest(u.x, u.y);
    const reach = reachableTiles(s, u);
    for (const i of reach.keys()) {
      const x = i % s.w;
      const y = Math.floor(i / s.w);
      const d = nearest(x, y);
      if (d >= now) continue;
      const gain = now - d;
      if (!picked || gain > picked.gain) picked = { action: { type: 'MOVE', unitId: u.id, x, y }, gain };
    }
  }
  return picked?.action ?? null;
}

export function aiNextAction(
  s: GameState,
  budget: AiBudget = DEFAULT_BUDGET,
  rejected: ReadonlySet<string> = new Set(),
  depth = 0,
  /**
   * 战略层（见 `ai-strategist.ts`）。不传 = 老行为。
   *
   * 传进来之后，它只影响三处：能不能打、名额怎么分、想要几代。
   * **战术层（走位/集火/采购排序）一行不改**——这是这次改造能安全实验的前提。
   */
  strategist: Strategist = NULL_STRATEGIST,
): Action | null {
  const me = s.current;
  if (orderDirectiveOf(s, me).strategy !== 'hold') {
    const a = aiNextActionCore(s, budget, rejected, depth, strategist);
    if (a) return a;
    // 深度推演里不做督战：那是"试走"，不该把对手的推演也拖进这一步
    if (
      depth === 0 &&
      (s.config.level?.ai?.pressure ?? 0) > 0 &&
      citiesOf(s, me).length === 0
    ) {
      return pressureAdvance(s);
    }
    return a;
  }
  const blocked = new Set(rejected);
  for (let i = 0; i < 24; i++) {
    const a = aiNextActionCore(s, budget, blocked, depth);
    if (!a) return null;
    if (a.type === 'END_TURN' || !isOffensive(s, me, a)) return a;
    blocked.add(aiActionKey(a));
  }
  // 全都算出击动作：这一回合不打了，直接交棒（屯兵不动宁可空过也不送）
  return { type: 'END_TURN' };
}

export {
  AI_MAX_STEPS,
  DEFAULT_BUDGET,
  aiLevelOf,
  aiLevelLabel,
  isAiSide,
  anyAiSide,
  aiStepCap,
  aiStallGuard,
  aiProgressFingerprint,
} from './ai-meta.ts';
