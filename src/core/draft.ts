/**
 * 选卡模式（BP）：开局先禁、再选，选完才开始下棋。
 *
 * ── 一句话规则 ────────────────────────────────────────────────────────
 *
 * 系统从「战斗单位 + 非生产性建筑」里抽出一池子（默认 20 个），
 * 双方各禁 1 个；剩下的按蛇形顺序轮流选，每人 6 个。
 * 这一局双方**只能造**自己选中的那些，外加骨架（经济单位、建造单位、军营、桥）。
 * 同时取消"产线只带当前时代和上一代"的下限——你选到的青铜投石车，
 * 到了现代照样能造，否则选卡在后期等于白选。
 *
 * ── 为什么池子要按时代分层抽样 ────────────────────────────────────────
 *
 * 纯随机抽 20 个会出现"整池都是第五时代"的局：两个人开局造不起任何一个，
 * 前五回合只能用开局送的兵干瞪眼。所以按时代分桶、各自洗牌，再按配额取。
 *
 * 配额不是"每个时代一样多"（那是 2026-11-04 之前的写法）：一局只有一个起始时代，
 * 起始第 1 代时四、五代的兵要升三、四档城才造得出来，占着名额却一局都用不上。
 * 现在按"离起始时代多远"分配，见 `eraWeight` / `allocatePoolSlots`。
 *
 * ── 为什么要存进 state 而不是留在界面 ──────────────────────────────────
 *
 * 它决定"这一局能造什么"，是规则的一部分（见 rules.doRecruit 与 ui/panel 的产兵表）；
 * 而且必须随存档/联机快照走。挂在界面上，刷新一次就把名单丢了。
 *
 * ── 联机的边界（诚实说明） ──────────────────────────────────────────────
 *
 * 联机房间是"一次提交一整回合状态"的模型，用 turn 号做乐观锁；
 * 而选卡有十几个来回、turn 一直是 1，硬塞进去只会每步都撞锁。
 * 所以选卡在本地热座与对战 AI 下完整可用；进联机房间时由建房方在本地选完，
 * 对方进房后看到的是已经定下来的名单（界面会写明这一点）。
 */

import { isProducer } from './produce.ts';
import { isEcoBuilding } from './city-works.ts';
import { isPseudoUnit } from './config.ts';
import { unitSourceIdOf } from './expansions.ts';
import { nextRandom } from './rng.ts';
import { seatsOf } from './types.ts';
import type { Action, ActionResult, DraftState, GameState, PlayerId, UnitTypeDef } from './types.ts';

/* ===========================================================================
 * 一、规模：池子多大、几个禁位、几个选位
 * ======================================================================== */

/** 原版给多少：20 个候选、各 1 个禁位、各 6 个选位 */
export const DRAFT_POOL_BASE = 20;
export const DRAFT_BAN_BASE = 1;
export const DRAFT_PICK_BASE = 6;

/**
 * 上限。为什么不无限涨：一人选 20 个兵的时候，"选"这件事就没有信息量了——
 * 谁都能凑出一套完整的兵种表，BP 只剩下走流程。
 *
 * 现在的分类加成最多加到「禁 3 / 选 10」（海军+空军+时代军备同时在场），
 * 所以这两个上限是**纯保险**，正常组合碰不到。
 */
export const DRAFT_POOL_CAP = 60;
export const DRAFT_BAN_CAP = 4;
export const DRAFT_PICK_CAP = 12;

/** 禁用期与每一步选人的时限（毫秒）。禁用短一点：反正不看对面 */
export const DRAFT_BAN_MS = 25_000;
export const DRAFT_PICK_MS = 30_000;

/**
 * 这一局实际用的两档时限。
 *
 * 规则层只认"动作里带的 at"，超时判定读的是 `state.draft.deadline`，
 * 所以**写 deadline 的那一刻**就必须用同一份时长——否则改开局设置之后，
 * 界面上显示一个数、规则按另一个数判，超时会早到或永远不到。
 * 两个阶段分开取，是因为它们的节奏本来就不一样（见 `MatchConfig.draftBanMs`）。
 */
export function draftBanMsOf(state: GameState): number {
  const v = state.config.draftBanMs;
  return Number.isFinite(v) && (v as number) > 0 ? (v as number) : DRAFT_BAN_MS;
}

export function draftPickMsOf(state: GameState): number {
  const v = state.config.draftPickMs;
  return Number.isFinite(v) && (v as number) > 0 ? (v as number) : DRAFT_PICK_MS;
}

/** 当前阶段该给多久：禁用 / 选人各一档 */
export function draftMsOf(state: GameState): number {
  return state.draft?.phase === 'pick' ? draftPickMsOf(state) : draftBanMsOf(state);
}

export interface DraftBudget {
  /** 扩展一共新增了多少个"可进池"的兵种 */
  extra: number;
  /** 池子大小 */
  pool: number;
  /** 每人几个禁位 */
  bans: number;
  /** 每人几个选位 */
  picks: number;
}

/**
 * 分类加成：**按扩展的"兵种体系"加**，而不是按兵的数量加。
 *
 * 规则（和玩法需求逐条对应）：
 *   · 只有海军                 → 选位 +1
 *   · 只有空军                 → 选位 +1
 *   · 海军与空军同时在场       → 禁位 +1、选位 +2
 *   · 时代军备（pack-* 那几包）→ 禁位 +1、选位 +2
 *
 * 为什么按体系而不按兵数：一个体系（海/空/时代）带来的是一整套**互相制衡**的
 * 兵种关系（船怕飞机、飞机怕防空、各时代的兵互相压制）。多一个体系才需要更多
 * 名额去"照顾"它；同一个体系里多二十个兵，只是池子更大，不需要更多名额。
 * 这也让规则对玩家可预期：开海军就该多一个选位，而不是"开海军加了多少兵"。
 */
export interface DraftBonus {
  naval: boolean;
  air: boolean;
  era: boolean;
  /** 禁位加成 */
  bans: number;
  /** 选位加成 */
  picks: number;
}

export function draftBonus(expansionIds: readonly string[]): DraftBonus {
  /*
   * 2026-11-04 之后按**包 id 精确判断**，不再用前缀。
   *
   * 以前是 `startsWith('naval-')` / `startsWith('pack-')`：那时海战有 naval-fleet /
   * naval-modern 两个包，时代军备有五个 pack-*。合并之后它们分别叫 naval / air /
   * era-arms，前缀规则一个都匹配不上——表现是"开了海军，选卡名额没涨"。
   *
   * 这里刻意不写成"前缀 + 新 id 都算"：那种写法会在下次改名时再坏一次，
   * 而且旧 id 早已在 config 迁移里被换掉（normalizeExpansionIds），
   * 运行期看不到旧写法。
   */
  const naval = expansionIds.includes('naval');
  const air = expansionIds.includes('air');
  // 时代军备＝「青铜/铁器/火器/蒸汽/机械化」五组 + 第六代那批专精兵。
  // 「信息化」也算：它自己带九个兵、还把科技线推高一格，是同一类"整代军备"。
  const era = expansionIds.includes('era-arms') || expansionIds.includes('pack-contemporary');

  let bans = 0;
  let picks = 0;
  if (naval && air) {
    // 两个体系同时在场：制空与制海互相压制，禁位也要多一个，否则拦不住对面的核心
    bans += 1;
    picks += 2;
  } else if (naval || air) {
    picks += 1;
  }
  if (era) {
    bans += 1;
    picks += 2;
  }
  return { naval, air, era, bans, picks };
}

/**
 * 规模：池子按**兵的数量**长，禁位/选位按**体系**长。
 *
 * 池子保持"每一档都要有货"的比例——扩展多给 2 个可进池的兵，池子就多 1 格；
 * 名额则看上面那套分类规则（`draftBonus`）。
 *
 *   原版                       → 池 20 / 禁 1 / 选 6
 *   单海军（naval-fleet）      → 池 28 / 禁 1 / 选 7
 *   单空军（air-corps）        → 池 25 / 禁 1 / 选 7
 *   海军 + 空军                → 池 32 / 禁 2 / 选 8
 *   时代军备（pack-antiquity） → 池 27 / 禁 2 / 选 8
 *   海军 + 空军 + 时代军备     → 池 39 / 禁 3 / 选 10
 *   全扩展全开                 → 池 60（撞上限）/ 禁 3 / 选 10
 *
 * 要注意的一个组合：「现代海军」要带「信息化」，而「信息化」本身就是时代军备的一包，
 * 所以它会同时点亮海军的 +1 与时代军备的 +2（池 27 / 禁 2 / 选 9）。
 * 规则按**实际生效的体系**算，不按"玩家本来想开哪一类"算。
 */
/**
 * 每代在池子里的硬上限。
 *
 * ---------------------------------------------------------------
 * 为什么"权重"一个人不够
 * ---------------------------------------------------------------
 * 权重只在**池子有富余**时发得出去。而一局的池子有固定额度，起始代±1 的库存
 * 一旦见底，水填法就必须把剩下的格子摊给更远的代——这不是权重算错了，是没地方放。
 *
 * 实测（2026-11-08，默认扩展、起始第 3 代）：池子 20 格里第 2 代占 6 格（30%），
 * 第 5 代只剩 3 格。玩家开第 3 代是想打青铜到铁器，结果签里三成是上一代的兵；
 * 而"升两级就到"的第 5 代反而被挤掉了。病因是"±2 代给 3 张"这顶帽子**不分方向**：
 * 它同时压住了向上的第 5 代和向下的第 1 代，多出来的格子就只能堆在 -1 代身上。
 *
 * ---------------------------------------------------------------
 * 所以帽子要分方向：往上是投资，往下是淘汰
 * ---------------------------------------------------------------
 *   · **向上（+2）尽量给足**：升两级就到手，是这一局的"目标单位"，
 *     让它替 -1 代吃下多余的格子，池子才会越看越像"这一代 + 下一代"。
 *   · **向下（-1）只留一小撮**：最多占池子的 15%（至少 2 张）。
 *     这一代的作用是"便宜的补位"（多一个便宜近战/远程可挑），不是主菜。
 *   · **再往下（≤ -2 代）不进池子**：起始第 3 代还给你发第 1 代民兵，
 *     除了占版面没有别的用。库存撑不起一轮 BP 时才会被 `eraCaps` 放开（见那边）。
 *
 * 这几条都是**相对**的（按池子比例 / 按库存），换扩展、换池子大小都不用重调。
 */
const UP2_CAP = 8;
const UP3_CAP = 3;
const FAR_CAP = 1;
/** -1 代最多占池子的这个比例（至少 2 张，不管池子多小） */
const DOWN1_SHARE = 0.15;

/** 各代有多少"可进池"的候选（库存） */
function stockByEra(state: GameState): Map<number, number> {
  const stock = new Map<number, number>();
  for (const id of draftCandidates(state)) {
    const def = state.unitTypes[id];
    if (!def) continue;
    const era = Math.max(1, Math.round(def.era || 1));
    stock.set(era, (stock.get(era) ?? 0) + 1);
  }
  return stock;
}

/**
 * 这一代在池子里最多占几格。
 *
 * `size` 是池子的目标额度，只用来算 -1 代那顶"按比例"的帽子。
 */
function eraCap(era: number, startEra: number, stock: number, size: number): number {
  const gap = era - startEra;
  if (gap === 0 || gap === 1) return stock;
  if (gap === 2) return Math.min(stock, UP2_CAP);
  if (gap === 3) return Math.min(stock, UP3_CAP);
  if (gap >= 4) return Math.min(stock, FAR_CAP);
  if (gap === -1) {
    const share = Math.max(2, Math.ceil(size * DOWN1_SHARE));
    return Math.min(stock, share);
  }
  return 0;
}

/**
 * 每一代各自的上限（规则层与抽样共用这一份，别在两处各算一遍）。
 *
 * `minTotal` 是"这一轮 BP 至少要几张卡"（双方禁完再选完）。库存撑得住时它不起作用；
 * 撑不住时按**离起始代由近到远**把帽子一层层松开——先放最近的代，因为那是
 * 玩家真正会用的兵；一直放到够用或放到库存见底。
 *
 * 这一条是必须的：起始第 5 代的原版局，第 5 代只有 5 个兵、上面一代都没有，
 * 光靠 ±1 代凑不满"各禁 1 + 各选 6"的 16 张；而起始第 8 代全开也只有 19 张候选，
 * 对 26 张的需求同样不够。宁可让低代占几格，也不能让选卡走到一半没卡可选。
 */
function eraCaps(state: GameState, minTotal: number, size: number): Map<number, number> {
  const startEra = Math.max(1, state.config.startEra ?? 1);
  const stock = stockByEra(state);
  const caps = new Map<number, number>();
  let total = 0;
  for (const [era, n] of stock) {
    const c = eraCap(era, startEra, n, size);
    caps.set(era, c);
    total += c;
  }
  if (total >= minTotal) return caps;
  const order = [...stock.keys()].sort((a, b) => {
    const d = Math.abs(a - startEra) - Math.abs(b - startEra);
    return d !== 0 ? d : a - b;
  });
  for (const era of order) {
    if (total >= minTotal) break;
    const n = stock.get(era) ?? 0;
    const cur = caps.get(era) ?? 0;
    const add = Math.min(n - cur, minTotal - total);
    if (add <= 0) continue;
    caps.set(era, cur + add);
    total += add;
  }
  return caps;
}

/**
 * 一局选卡的规模与每代上限——**唯一的一份推导**。
 *
 * `draftBudget`（界面显示"池子 N 张"、AI 估算）和 `sampleDraftPool`（真去抽卡）
 * 都从这里取。以前两边各算一次，池子一被库存夹小，"预算说 20 张、实际抽了 18 张"
 * 这种不一致就会冒出来。
 */
function poolLimits(state: GameState): {
  base: number;
  need: number;
  size: number;
  caps: Map<number, number>;
  budget: DraftBudget;
} {
  const shape = poolShape(state);
  const need = draftNeed(state, shape);
  const caps = eraCaps(state, need, shape.base);
  let total = 0;
  for (const n of caps.values()) total += n;
  const size = Math.min(shape.base, total);
  return {
    base: shape.base,
    need,
    size,
    caps,
    budget: { extra: shape.extra, pool: size, bans: shape.bans, picks: shape.picks },
  };
}

export function draftBudget(state: GameState): DraftBudget {
  return poolLimits(state).budget;
}

/** 池子的"目标额度"：只看扩展给了多少兵，跟起始时代无关 */
function poolShape(state: GameState): DraftBudget & { base: number } {
  const extra = draftCandidates(state).filter((id) => unitSourceIdOf(id) !== null).length;
  const bonus = draftBonus(state.config.expansionIds ?? []);
  return {
    extra,
    base: Math.min(DRAFT_POOL_CAP, DRAFT_POOL_BASE + Math.ceil(extra / 2)),
    pool: 0,
    bans: Math.min(DRAFT_BAN_CAP, DRAFT_BAN_BASE + bonus.bans),
    picks: Math.min(DRAFT_PICK_CAP, DRAFT_PICK_BASE + bonus.picks),
  };
}

/**
 * 这一轮 BP 至少要几张卡：双方禁完再选完，多留 2 张做余量。
 *
 * 少了这道底线，按库存压小池子会在"兵本来就少"的开局上直接压断：
 * 起始第 5 代的原版局只有 15 个候选、起始第 8 代全开只有 19 个，
 * 而"各禁 3 + 各选 10"要 26 张——走到第 20 手就没卡可选了。
 * `eraCaps` 会在库存不够时把帽子松开（见那边的说明），这里只负责把数算出来。
 */
function draftNeed(state: GameState, shape: DraftBudget): number {
  return (shape.bans + shape.picks) * seatsOf(state).length + 2;
}

/* ===========================================================================
 * 二、谁进池子、谁永远不受限
 * ======================================================================== */

/**
 * 骨架单位：不进池、不参与 BP、永远能造。
 *
 * 这三类不是"选什么打法"的问题，而是"能不能把一局玩起来"的问题：
 * 没有经济单位就没有收入，没有建造单位就盖不了工地，没有军营就没有前线补员。
 * 把它们放进池子，等于允许一方把对手的产线整个 ban 掉——那不是 BP，是处刑。
 */
export function draftAlwaysAllowed(def: UnitTypeDef): boolean {
  // 只能由产兵建筑造的东西（炼器炉的法器）跟着那座建筑走，不是"这一局选什么打法"：
  // 把它放进池子，等于允许对手一 ban 就让你的炉子变成空壳。
  if (def.campOnly) return true;
  if (def.category === 'economy' || def.category === 'builder') return true;
  /*
   * 经济建筑（磨坊/水车/工厂/粮仓/采石场/砖窑/工业园…）不进卡池。
   *
   * 2026-11-07 挪出来的。理由和军营、桥是同一类，只是之前漏了：
   * **"这一局能不能盖磨坊"不该是选卡做的决定**。它不参与战斗，选到它
   * 等于白占一格签位；而漏选它就等于这一局少了一整套经济玩法，
   * 那不是策略深度，是把玩法随机没收掉。
   *
   * 判据用 `isEcoBuilding`（产出写成 income / incomeByTerrain / yield），
   * 和"经济建筑不还手、造价减免、耐久打折"是同一份——不另写一份。
   */
  if (isEcoBuilding(def)) return true;
  // 军营＝生产性建筑；桥是地形设施，选卡不该决定"这条河过不过得去"
  return def.category === 'building' && (isProducer(def) === true || def.bridges === true);
}

/**
 * 城市升到 `era` 这一级之后**新解锁**的东西（面板那句「升级后可解锁」用它）。
 *
 * 和产兵表不是同一个集合，别再合并：
 *   · 产兵表只列"城市产得出来的兵"，建筑不在里面（建筑要建造单位去盖）；
 *   · 这里连建筑一起列——"升到火器时代能造石桥"对玩家是有用的一句话。
 *
 * 但"这一局能不能用"必须和产兵表同一个口径，所以都走 `canUseType`。
 * 原来这里只判 `def.era > city.era`，于是在选卡模式下把**池子里没选到的卡**
 * 全列了出来：玩家看到"升级后可解锁：圣剑勇者、九头蛇……"，升完级发现一个都造不了。
 * 那几句话比不写更糟——它把"没选到"说成了"再等等就有"。
 *
 * 两条例外照旧：
 *   · 经济单位 / 建造单位 / 生产性建筑 / 桥 / **经济建筑**本来就不用选
 *     （`draftAlwaysAllowed`），升级解锁它们是真事，必须留着
 *     （伐木工、民夫、石桥、磨坊、工厂都在这一档）；
 *   · 召唤物不算解锁——它们只能被召唤者带出来，谁也"解锁"不了。
 */
export function upgradeUnlocks(state: GameState, side: PlayerId, era: number): UnitTypeDef[] {
  return Object.values(state.unitTypes).filter(
    (def) => !def.summonedOnly && def.era > era && canUseType(state, side, def.id),
  );
}

/**
 * 能进池子的兵种：战斗单位 + 非生产性建筑。
 *
 * 召唤物（只认召唤者）排除：它没有独立造价，选了也没法造。
 * 伪单位（攻城结算用的「城市」壳）排除：池子里多它一格，玩家就少一个真兵种，
 * 而且那张卡在界面上是空的——见 config.ts 的 PSEUDO_UNIT_IDS。
 */
export function draftCandidates(state: GameState): string[] {
  return Object.values(state.unitTypes)
    .filter((def) => {
      if (isPseudoUnit(def.id)) return false;
      if (draftAlwaysAllowed(def)) return false;
      if (def.summonedOnly) return false;
      // campOnly 不进池子这件事由上面的 draftAlwaysAllowed 覆盖：
      // 它跟着产兵建筑走，不算"选什么打法"。
      // 强行拦截残缺数据 / 测试残留 / 玩家乱改的本地自定义兵种
      // 如果没有写时代，或者时代小于 1，直接踢出池子，免得把排序搞炸
      if (typeof def.era !== 'number' || def.era < 1) return false;
      
      if (def.category === 'combat') return true;
      return def.category === 'building';
    })
    .map((def) => def.id)
    .sort();
}

/* ===========================================================================
 * 三、开局：抽样、排顺序
 * ======================================================================== */

/** 用种子洗一份拷贝（Fisher–Yates），保证同一 seed 出同一池子 */
function shuffle<T>(list: T[], seed: number): { list: T[]; seed: number } {
  const out = list.slice();
  let s = seed;
  for (let i = out.length - 1; i > 0; i--) {
    const r = nextRandom(s);
    s = r.seed;
    const j = Math.floor(r.value * (i + 1));
    const tmp = out[i]!;
    out[i] = out[j]!;
    out[j] = tmp;
  }
  return { list: out, seed: s };
}

/**
 * 这一代在池子里该占几格（相对权重）。
 *
 * ---------------------------------------------------------------
 * 为什么不再"每个时代一样多"（2026-11-04）
 * ---------------------------------------------------------------
 * 原来的抽样是纯轮转：时代 1、2、3、4、5、1、2……各代机会均等。
 * 这在"每个时代都可能开局"的假设下是公平的，但一局只有**一个**起始时代：
 * 起始第 1 代时，池子里的五代兵要升四档城才造得出来，实测它们被选了 100 次、
 * 胜率只有 43%（第 1~3 代都是 50% 上下）——**选到 ≠ 造得出**。
 * 分给它们的那十格，本该是二、三代的格子。
 *
 * 所以池子按"离起始时代多远"分配名额：
 *   · 起始那一代最多（一开局就能造，是真正的第一梯队）；
 *   · +1 代紧随其后（升一级就到，几乎每局都会升）；
 *   · 再往后递减，但仍有"抽得到一张"的额度（够你留一手"决战用的东西"）；
 *   · 低于起始时代衰减得**陡得多**（见下面 2026-11-08 那段）。
 *
 * 保底只剩"起始代 ±1 各 1 格"（见 `allocatePoolSlots`），不是每代都有——
 * 每代都保底的话，八个时代的池子先被保底吃掉十几格，权重就翻不过来了。
 */
function eraWeight(era: number, startEra: number): number {
  const gap = era - startEra;
  // 高于起始代：还是那条慢衰减——"造不出来"但值钱，留个零头有意义
  if (gap >= 0) return Math.max(0.2, 1.15 - 0.28 * gap);
  /*
   * 低于起始代：**陡得多**（2026-11-08 调）。
   *
   * 原来是 1 - 0.18·d（-1 0.82 / -2 0.64 / -3 0.46 / -4 0.35，最低 0.35），
   * 配上"每代保底 2 格"，起始第 3 代时池子里三成是上一代的兵——
   * 玩家开第 3 代是想打青铜到铁器，结果签里堆着民兵长枪。
   * 现在 -1 0.5 / -2 0.18 / -3 0.065 / -4 0.023，最低 0.02。
   *
   * 权重还要配帽子才管用（见 `eraCap`）：-1 代压到池子的 15%、再往下直接 0。
   * 只调权重是不够的——水填法没处可放时，多出来的格子还是会压到最近的下游那一代。
   */
  return Math.max(0.02, 0.5 * 0.36 ** (-gap - 1));
}

/**
 * 把 `size` 个格子按权重分给各代，并夹在"每代上限"之内。
 *
 * 分配用最大余数法（先取整、剩下的按小数部分从大到小补），溢出（某代顶到上限）
 * 则把多出来的格子按权重让给还有余量的代，反复到分完或没处可放。
 * 这些都必须确定性：同一个 seed 必须得到同一个池子。
 *
 * `capOf` 传的是**已经算好的上限**（见 `eraCaps`），这里不再自己推导——
 * "这一代最多几格"只有一处实现，否则预算和抽样会各夹一次、夹出两个数。
 */
function allocatePoolSlots(
  eras: readonly number[],
  size: number,
  startEra: number,
  capOf: (era: number) => number,
): Map<number, number> {
  const quota = new Map<number, number>(eras.map((e) => [e, 0]));
  const weights = new Map(eras.map((e) => [e, eraWeight(e, startEra)]));
  let left = size;
  /*
   * ① 保底只给"起始代 ±1"这一带，每代 1 格。
   *
   * 旧版是**每代 2 格**，于是 8 个时代的池子里先被保底吃掉 16 格——
   * 起始第 7 代时，1~6 代凭保底就占了一半以上，权重再怎么调都翻不过来。
   * 现在保底只保证"你这一代和上下各一代不至于一张都没有"，
   * 再远的代全靠权重决定；低两代以上很可能一格都抽不到，这是有意的。
   */
  const floor = Math.min(1, Math.floor(size / Math.max(1, eras.length)));
  for (const era of eras) {
    if (Math.abs(era - startEra) > 1) continue;
    const give = Math.min(floor, capOf(era), left);
    quota.set(era, give);
    left -= give;
  }
  // ② 余量按权重反复分（水填法）。
  //    一轮分完再看还剩多少：起始那一代的库存常常不够吃下自己那份权重
  //    （本体第 1 代只有 6 个兵），多出来的格子要按比例摊给其它代。
  //
  //    这里曾经是"按圈补位"（0 圈吃饱才轮到 1 圈），为的是防止水填法
  //    把多余的格子摊到低代去。现在低代有硬的帽子（-1 代 ≤15%、更远一律 0），
  //    圈序已经没必要，反而会捣乱：起始第 3 代全扩展开局时，第 4 代库存一多，
  //    1 圈就把 60 格吃干，第 5 代（升两级就到、本该有一份的"目标单位"）整代挂零。
  let guard = 0;
  while (left > 0 && guard++ < 64) {
    const roomy = eras.filter((e) => capOf(e) > (quota.get(e) ?? 0));
    if (roomy.length === 0) break;
    const sumW = roomy.reduce((n, e) => n + (weights.get(e) ?? 0), 0) || 1;
    const share = roomy.map((e) => {
      const room = capOf(e) - (quota.get(e) ?? 0);
      const want = Math.min((left * (weights.get(e) ?? 0)) / sumW, room);
      return { e, n: Math.floor(want), frac: want - Math.floor(want) };
    });
    let moved = 0;
    for (const s of share) {
      if (s.n > 0) {
        quota.set(s.e, (quota.get(s.e) ?? 0) + s.n);
        moved += s.n;
      }
    }
    // 每份都不足 1 格（名额比时代还少）：按小数部分从大到小，一格一格给
    if (moved === 0) {
      for (const s of [...share].sort((a, b) => b.frac - a.frac)) {
        if (moved >= left) break;
        quota.set(s.e, (quota.get(s.e) ?? 0) + 1);
        moved += 1;
      }
      if (moved === 0) break;
    }
    left -= moved;
  }
  return quota;
}

/**
 * 按时代分层抽样（各代配额见 `eraWeight`）。
 *
 * 每代的桶先各自洗一遍，再按配额取；取出来的池子仍然**按轮次交错**排
 * （时代 1、2、3、1、2、3…），而不是"先八个一代再八个二代"：
 * 池子在界面上是铺开给人看的，交错排一眼就能看出"这一池跨了几代"；
 * 顺带也让 AI 的 argmax 在平分时不会系统性地偏向第一代。
 */
export function sampleDraftPool(
  state: GameState,
  seed: number,
): { pool: string[]; seed: number } {
  const buckets = new Map<number, string[]>();
  for (const id of draftCandidates(state)) {
    const def = state.unitTypes[id];
    if (!def) continue;
    const era = Math.max(1, Math.round(def.era || 1));
    const list = buckets.get(era) ?? [];
    list.push(id);
    buckets.set(era, list);
  }

  let s = seed;
  const eras = [...buckets.keys()].sort((a, b) => a - b);
  const washed = new Map<number, string[]>();
  for (const era of eras) {
    const r = shuffle(buckets.get(era)!, s);
    s = r.seed;
    washed.set(era, r.list);
  }

  const startEra = Math.max(1, state.config.startEra ?? 1);
  const lim = poolLimits(state);
  const size = lim.size;
  const quota = allocatePoolSlots(eras, size, startEra, (e) => lim.caps.get(e) ?? 0);

  const pool: string[] = [];
  const cursors = new Map<number, number>(eras.map((e) => [e, 0]));
  // 轮次交错：每轮各代最多取一个，直到所有配额都取完
  while (pool.length < size) {
    let took = 0;
    for (const era of eras) {
      const list = washed.get(era)!;
      const i = cursors.get(era)!;
      const q = quota.get(era) ?? 0;
      if (i >= q || i >= list.length) continue;
      pool.push(list[i]!);
      cursors.set(era, i + 1);
      took += 1;
      if (pool.length >= size) break;
    }
    if (took === 0) break; // 所有配额都取完了
  }
  return { pool, seed: s };
}

/**
 * 选人顺序：蛇形。
 *
 * 每人一次、轮流，但**每一轮的首选权交换**：A,B / B,A / A,B …
 * 摊平就是 A,B,B,A,A,B,B,A…。这样各有 6 次机会、各有 3 次"这一轮我先挑"，
 * 先手优势被摊成"先动一步"，而不是"先挑三个"。
 */
export function draftPickOrderFor(seats: PlayerId[], picks: number): PlayerId[] {
  const total = Math.max(0, picks) * seats.length;
  const out: PlayerId[] = [];
  for (let round = 0; out.length < total; round++) {
    // 蛇形：偶数轮正着走、奇数轮倒着走，名额在两端的人永远连着拿两次
    const order = round % 2 === 0 ? seats : [...seats].reverse();
    for (const p of order) {
      if (out.length >= total) break;
      out.push(p);
    }
  }
  return out;
}

/** 两人局的选卡顺序（老接口，测试和复盘在用） */
export function draftPickOrder(picks: number): PlayerId[] {
  return draftPickOrderFor(['A', 'B'], picks);
}

/**
 * 开局造一份选卡状态（由 setup.createMatch 调用）。
 *
 * 不需要"现在几点"：开局停在 lobby，不计时；开始禁用的那一刻才由 `DRAFT_START`
 * 带上 `at` 把截止时间钉下来（这样联机双方用的是同一台机器的钟，不会各算各的）。
 */
export function createDraft(state: GameState): DraftState {
  const budget = draftBudget(state);
  const sampled = sampleDraftPool(state, state.seed ^ 0x5eed1);
  /*
   * 选卡顺序从**先手方**开始轮转。
   *
   * 原来直接 `seatsOf(state)`（=['A','B']）。两人局可以选谁先动之后，如果先手是 B
   * 而 BP 仍从 A 起，就会出现"后动的人先选卡"——那等于把先后手的定义拆成两套。
   * 先手 = 先动 + 先禁/先选，补偿发给后手，三件事同一个人。
   */
  const seats = seatsOf(state);
  const lead = seats.indexOf(state.current);
  const rotated = lead > 0 ? [...seats.slice(lead), ...seats.slice(0, lead)] : seats;
  const order = draftPickOrderFor(rotated, budget.picks);
  return {
    // 先进"等待开局"：建房、贴邀请链接都发生在这一步（见 DraftPhase 的说明）
    phase: 'lobby',
    pool: sampled.pool,
    banSlots: budget.bans,
    pickSlots: budget.picks,
    // 四个席位都开出来：三人四人局的 BP 也走同一套蛇形
    bans: { A: [], B: [], C: [], D: [] },
    picks: { A: [], B: [], C: [], D: [] },
    order,
    /*
     * 轮流禁用**从后拿第一签的那一方开始**。
     *
     * 顺序制里第二个禁的人看得见第一个禁了什么，等于多一层信息；这份优势
     * 给后选卡的那一方，正好抵掉第一签的一部分（实测第一签约值 ±10pp，
     * 见 docs/DRAFT-STATS-2026-11-07.md）。先禁的人反过来什么都没有，
     * 所以别把这句当"随机挑了一边"——要改就两边一起改。
     */
    banTurn: order[0] === 'A' ? 'B' : 'A',
    step: 0,
    // 联机锁从 1 起：房间那一行建出来时 turn 也是 1，第一笔 BP 提交正好对得上
    seq: 1,
    // lobby 不计时：等人入座可能要好几分钟，给倒计时只会逼人乱点
    deadline: 0,
    history: [],
  };
}

/* ===========================================================================
 * 四、能不能造：规则层与界面共用的唯一判据
 * ======================================================================== */

/**
 * 这个兵种这一局能不能被 `side` 生产/建造。
 *
 * 只有一处实现，三处调用（rules.doRecruit、rules.doBuild、ui/panel 的产兵表）——
 * "判据写两份"是这个仓库里反复踩过的坑（临水判定、迷雾可见性都栽过一次），
 * 所以名单过滤宁可多绕一层函数，也不在界面和规则里各写一遍。
 */
export function canUseType(state: GameState, side: PlayerId, typeId: string): boolean {
  const draft = state.draft;
  if (!draft) return true;
  // 跳过选卡＝这一局按原版打，名单限制整个不生效
  if (draft.skipped) return true;
  const def = state.unitTypes[typeId];
  if (!def) return false;
  if (draftAlwaysAllowed(def)) return true;
  return draft.picks[side].includes(typeId);
}

/**
 * 时代窗口：只拦"未来的兵"，不拦"更早的兵"。
 *
 * 这里曾经有过一条下限（`def.era >= era - 1`，即只带当前时代和上一个时代），
 * 理由是不让产兵面板里堆十个早该淘汰的兵——那个理由在**面板**上成立，
 * 在**规则**上不成立：城市升到第四代就再也造不出民兵，等于"升级把选项变少了"，
 * 而玩家想要的恰恰是"三级城里还能补两个便宜的长枪兵看家"。
 *
 * 面板堆不堆得下是界面问题，已经交给筛选解决（扩展包 / 时代 / 搜索，见
 * ui/packs.ts）。所以这条判断只剩一件事：**不能造还没解锁的兵**。
 * 下限整个去掉，所有模式一个口径——选卡模式当年单独放开下限的那段特例
 * 也就跟着没有必要了。
 *
 * `_state` 留着不删：这个判断以后要接"封冻港口"之类的局面条件（比如某个
 * 扩展把某条产线临时停掉），签名先稳住，四处调用点就不用再改一遍。
 */
export function eraWindowOk(_state: GameState, def: UnitTypeDef, era: number): boolean {
  return def.era <= era;
}

/* ===========================================================================
 * 五、状态机
 * ======================================================================== */

export function remainingUnits(state: GameState): string[] {
  const draft = state.draft;
  if (!draft) return [];
  const taken = new Set<string>([...draft.bans.A, ...draft.bans.B, ...draft.picks.A, ...draft.picks.B]);
  return draft.pool.filter((id) => !isPseudoUnit(id) && !taken.has(id));
}

/**
 * 把老存档池子里**本就不该进池**的卡摘掉（读档时调，见 storage/save.ts）。
 *
 * 为什么需要：池子是**存进存档**的，不是每局重抽。所以 11-07 把经济建筑移出
 * 卡池之后，在那之前存的、正打到一半的对局仍然顶着一个含磨坊/粮仓的旧池子——
 * 玩家看到的是一张"代码里已经不允许存在的卡"，而所有新开局的池子都是干净的。
 * 症状就是这么来的：不是过滤没生效，是那份池子早就落盘了。
 *
 * 两条底线：
 *   1. **只摘没被禁/选的**。已经进了某方手里的卡不能凭空消失，那会让阵容对不上。
 *   2. **摘完还得凑得够签位**。剩的卡少于剩余签数就整个不动——宁可让这张卡
 *      多待一会儿，也不能让对局卡在"没卡可选"上。
 *
 * 返回摘掉了几张（0 = 不用动）。
 */
export function pruneLegacyDraftPool(state: GameState): number {
  const draft = state.draft;
  // lobby 也处理：池子在 DRAFT_START 那一刻就定了，这时候摘是安全的，
  // 而且读档进 lobby 正是"还没开始选"的常见状态
  if (!draft || draft.phase === 'done') return 0;

  const taken = new Set<string>([
    ...draft.bans.A,
    ...draft.bans.B,
    ...draft.picks.A,
    ...draft.picks.B,
  ]);
  const stale = draft.pool.filter((id) => {
    if (taken.has(id)) return false;
    const def = state.unitTypes[id];
    return !!def && draftAlwaysAllowed(def);
  });
  if (stale.length === 0) return 0;

  const picked = draft.picks.A.length + draft.picks.B.length;
  const stepsLeft = Math.max(0, draft.order.length - picked);
  const availableAfter = draft.pool.length - stale.length - taken.size;
  // 摘了会凑不够签位：这次不动，让对局先能打完
  if (availableAfter < stepsLeft) return 0;

  const drop = new Set(stale);
  draft.pool = draft.pool.filter((id) => !drop.has(id));
  return stale.length;
}

/** 当前该谁选（禁用期返回 null：两边同时进行） */
export function draftSideToAct(state: GameState): PlayerId | null {
  const draft = state.draft;
  if (!draft) return null;
  if (draft.phase === 'pick') return draft.order[draft.step] ?? null;
  return null;
}

/** 谁还没交禁用 */
export function pendingBans(state: GameState): PlayerId[] {
  const draft = state.draft;
  if (!draft || draft.phase !== 'ban') return [];
  return seatsOf(state).filter((s) => draft.bans[s].length < draft.banSlots);
}

/** 这一局选卡是否还没打完（界面据此决定要不要盖住棋盘） */
export function draftInProgress(state: GameState): boolean {
  return !!state.draft && state.draft.phase !== 'done';
}

function label(state: GameState, id: string): string {
  return state.unitTypes[id]?.name ?? id;
}

/**
 * 选卡动作的入口（由 rules.applyAction 分流过来，状态已经 clone 过）。
 *
 * 判据顺序刻意是"先看阶段、再看是不是你、再看这个单位还在不在池子里"：
 * 报错文案要能直接告诉玩家下一步该干什么，而不是笼统的一句"非法操作"。
 */
export function applyDraftAction(s: GameState, action: Action, actor: PlayerId): ActionResult {
  const draft = s.draft;
  if (!draft) return { ok: false, reason: '这一局没有开选卡模式' };

  if (action.type === 'DRAFT_START') {
    if (draft.phase !== 'lobby') return { ok: false, reason: '这一局的选卡已经开始了' };
    /*
     * 计时起点必须是真时间戳。
     *
     * 少了它会算出 NaN 的 deadline，而"到点没有"的判断是 `at < deadline`——
     * 和 NaN 比永远是 false，于是**一进禁用就被判超时**，双方各白丢一次禁用
     * （联机里表现成"一进选卡就显示双方禁用已超时"）。
     */
    if (!Number.isFinite(action.at)) {
      return { ok: false, reason: '开始选卡要带计时起点（时间戳）' };
    }
    draft.phase = 'ban';
    draft.deadline = action.at + draftBanMsOf(s);
    draft.seq += 1;
    s.log = [
      ...s.log,
      { turn: s.turn, player: 'A', open: true, text: `选卡开始：轮流禁用（每方 ${draft.banSlots} 个）` },
    ];
    return { ok: true, state: s };
  }

  if (action.type === 'DRAFT_SKIP') {
    if (draft.phase === 'done') return { ok: false, reason: '选卡已经结束了' };
    const stage = draft.phase;
    draft.phase = 'done';
    draft.skipped = true;
    draft.deadline = 0;
    draft.seq += 1;
    s.current = 'A';
    s.log = [
      ...s.log,
      {
        turn: s.turn,
        player: 'A',
        open: true,
        text: stage === 'lobby' ? '跳过选卡：本局用全部兵种' : '中途跳过选卡：本局用全部兵种',
      },
    ];
    return { ok: true, state: s };
  }

  if (action.type === 'DRAFT_BAN') {
    if (draft.phase !== 'ban') return { ok: false, reason: '禁用阶段已经结束了' };
    /*
     * 轮流禁用：不是你的回合就一步都不许下。
     *
     * 兜底 `?? 'A'` 是给老存档用的（那时还没有 banTurn 这个字段，双方同时禁，
     * 谁先提交谁先来）。新局一定带这个字段。
     */
    const turn = draft.banTurn ?? 'A';
    if (actor !== turn) {
      return { ok: false, reason: `轮到${s.players[turn]?.name ?? turn}禁用了` };
    }
    if (draft.bans[actor].length >= draft.banSlots) {
      return { ok: false, reason: `你这一轮已经禁用过 ${draft.banSlots} 个了` };
    }
    const id = action.unitId;
    if (!draft.pool.includes(id)) return { ok: false, reason: '这个兵种不在本局池子里' };
    if (draft.bans[actor].includes(id)) return { ok: false, reason: '你已经禁过它了' };
    /*
     * 对面已经禁掉的不能再禁一次。
     *
     * 盲禁时代这条不可能发生（互相看不见），轮流禁之后它变成真会发生的输入错误：
     * 该禁的那张已经被对面按掉了，再举一次手是白费一个禁位。直接说明白，
     * 好过让玩家以为自己禁成了。
     */
    const foe: PlayerId = actor === 'A' ? 'B' : 'A';
    if (draft.bans[foe].includes(id)) return { ok: false, reason: '对面已经禁过它了' };

    draft.bans[actor] = [...draft.bans[actor], id];
    draft.seq += 1;
    draft.history = [...draft.history, { side: actor, kind: 'ban', unitId: id, auto: false }];
    if (draft.bans[actor].length >= draft.banSlots) {
      if (draft.bans.A.length >= draft.banSlots && draft.bans.B.length >= draft.banSlots) {
        // 两边都禁满了 → 进选人
        draft.phase = 'pick';
        draft.step = 0;
        draft.banTurn = undefined;
        draft.deadline = (action.at ?? draft.deadline) + draftPickMsOf(s);
      } else {
        // 这一方禁满了 → 交棒，并把倒计时重新给满（对面不该继承剩下的秒数）
        draft.banTurn = foe;
        draft.deadline = (action.at ?? draft.deadline) + draftBanMsOf(s);
      }
    }
    s.log = [
      ...s.log,
      { turn: s.turn, player: actor, open: true, text: `禁用「${label(s, id)}」` },
    ];
    return { ok: true, state: s };
  }

  if (action.type === 'DRAFT_PICK') {
    if (draft.phase !== 'pick') return { ok: false, reason: '现在不是选人阶段' };
    const side = draft.order[draft.step];
    if (!side) return { ok: false, reason: '选人已经结束了' };
    if (side !== actor) return { ok: false, reason: '还没轮到你选' };
    const id = action.unitId;
    if (!draft.pool.includes(id)) return { ok: false, reason: '这个兵种不在本局池子里' };
    if (!remainingUnits(s).includes(id)) return { ok: false, reason: '这个兵种已经被禁/被选了' };

    draft.picks[actor] = [...draft.picks[actor], id];
    draft.step += 1;
    draft.seq += 1;
    draft.history = [...draft.history, { side: actor, kind: 'pick', unitId: id, auto: false }];
    s.log = [
      ...s.log,
      { turn: s.turn, player: actor, open: true, text: `选用「${label(s, id)}」` },
    ];

    if (draft.step >= draft.order.length) {
      finishDraft(s);
    } else {
      draft.deadline = (action.at ?? draft.deadline) + draftPickMsOf(s);
    }
    return { ok: true, state: s };
  }

  if (action.type === 'DRAFT_TIMEOUT') {
    if (draft.phase === 'done') return { ok: false, reason: '选卡已经结束了' };
    // lobby 不计时：这一屏是"等人入座"，超时兜底在这里没有意义
    if (draft.phase === 'lobby') return { ok: false, reason: '还没开始选卡' };
    /*
     * deadline 必须是正数，否则一律当作"这一阶段还没开始计时"。
     *
     * 这条是"一进选卡就双方禁用超时"的正面修法：deadline 为 0（或 NaN）时，
     * 下面那句 `action.at < draft.deadline` 永远成立不了，于是任何一次超时
     * 请求都会被放行，两边各白丢一次禁用。缺省值不该被当成"早就到点了"。
     */
    if (!Number.isFinite(draft.deadline) || draft.deadline <= 0) {
      return { ok: false, reason: '这一阶段还没开始计时' };
    }
    if (!Number.isFinite(action.at)) return { ok: false, reason: '超时判定要带当前时间' };
    if (action.at < draft.deadline) return { ok: false, reason: '还没到时限' };

    if (draft.phase === 'ban') {
      /*
       * 超时＝**当前这一方**放弃剩下的禁用，然后把回合交给对面。
       *
       * 轮流制下不能像以前那样"两边一起判放弃"：先禁那一方超时的时候，
       * 后禁那一方根本还没轮到、时间也还没开始算，替他放弃等于白送。
       * 放弃也不替他随机禁——随机禁用可能禁掉自己最想要的兵，那是惩罚不是兜底。
       */
      const side = draft.banTurn ?? pendingBans(s)[0];
      if (side) {
        draft.history = [...draft.history, { side, kind: 'ban', unitId: null, auto: true }];
        // 用空数组占位不行（那等于没交），所以补一个"放弃"标记：长度对齐 banSlots
        while (draft.bans[side].length < draft.banSlots) {
          draft.bans[side] = [...draft.bans[side], ''];
        }
      }
      const foe: PlayerId = side === 'A' ? 'B' : 'A';
      const nameOf = (p: PlayerId): string => s.players[p]?.name ?? p;
      draft.seq += 1;
      if (side && draft.bans[foe].length < draft.banSlots) {
        draft.banTurn = foe;
        draft.deadline = action.at + draftBanMsOf(s);
        s.log = [
          ...s.log,
          {
            turn: s.turn,
            player: side,
            open: true,
            text: `禁用超时：${nameOf(side)}放弃，轮到${nameOf(foe)}禁用`,
          },
        ];
        return { ok: true, state: s };
      }
      draft.phase = 'pick';
      draft.step = 0;
      draft.banTurn = undefined;
      draft.deadline = action.at + draftPickMsOf(s);
      s.log = [...s.log, { turn: s.turn, player: 'A', open: true, text: '禁用超时：未禁用的一方视为放弃' }];
      return { ok: true, state: s };
    }

    // 选人超时：必须补一个，否则开局时某一方凑不满名单，这局直接废掉
    const side = draft.order[draft.step];
    if (!side) return { ok: false, reason: '选人已经结束了' };
    const left = remainingUnits(s);
    if (left.length === 0) return { ok: false, reason: '池子空了' };
    const picked = left[Math.floor(seededUnit(s) * left.length)] ?? left[0]!;
    draft.picks[side] = [...draft.picks[side], picked];
    draft.step += 1;
    draft.seq += 1;
    draft.history = [...draft.history, { side, kind: 'pick', unitId: picked, auto: true }];
    s.log = [
      ...s.log,
      { turn: s.turn, player: side, open: true, text: `超时，系统代选「${label(s, picked)}」` },
    ];
    if (draft.step >= draft.order.length) finishDraft(s);
    else draft.deadline = action.at + draftPickMsOf(s);
    return { ok: true, state: s };
  }

  return { ok: false, reason: '选卡还没结束，先把它打完' };
}

/** 超时代选用的随机数：由 seed + 步数派生，同一局重放得到同一个结果 */
function seededUnit(s: GameState): number {
  const step = s.draft?.step ?? 0;
  return nextRandom(s.seed ^ (step * 0x9e3779b1)).value;
}

/** 选完：交接给正常对局，并把这一局的名单写进日志（结算时能回看） */
function finishDraft(s: GameState): void {
  const draft = s.draft!;
  draft.phase = 'done';
  draft.deadline = 0;
  s.current = 'A';
  const names = (side: PlayerId) => draft.picks[side].map((id) => label(s, id)).join('、');
  s.log = [
    ...s.log,
    { turn: s.turn, player: 'A', open: true, text: `选卡完成。甲方：${names('A')}` },
    { turn: s.turn, player: 'B', open: true, text: `选卡完成。乙方：${names('B')}` },
  ];
}

/* ===========================================================================
 * 六、给界面与 AI 用的读取接口
 * ======================================================================== */

export interface DraftSideView {
  side: PlayerId;
  bans: string[];
  picks: string[];
  /** 还要再选几个 */
  picksLeft: number;
  /** 禁用阶段是否已提交 */
  banDone: boolean;
  /** 现在是不是轮到它 */
  toAct: boolean;
}

export function draftView(state: GameState): {
  phase: DraftState['phase'];
  deadline: number;
  pool: string[];
  remaining: string[];
  a: DraftSideView;
  b: DraftSideView;
  step: number;
  totalSteps: number;
  toAct: PlayerId | null;
  /** 现在轮到谁禁用（只有 phase='ban' 时有意义；其它时候是 null） */
  banTurn: PlayerId | null;
} | null {
  const draft = state.draft;
  if (!draft) return null;
  const side = (s: PlayerId): DraftSideView => ({
    side: s,
    bans: draft.bans[s].filter(Boolean),
    picks: draft.picks[s],
    picksLeft: Math.max(0, draft.pickSlots - draft.picks[s].length),
    banDone: draft.bans[s].length >= draft.banSlots,
    toAct: draft.phase === 'pick' && draft.order[draft.step] === s,
  });
  return {
    phase: draft.phase,
    deadline: draft.deadline,
    pool: draft.pool,
    remaining: remainingUnits(state),
    a: side('A'),
    b: side('B'),
    step: draft.step,
    totalSteps: draft.order.length,
    toAct: draftSideToAct(state),
    banTurn: draft.phase === 'ban' ? (draft.banTurn ?? null) : null,
  };
}

/* ---------------------------------------------------------------
 * AI 的选卡决策
 * ---------------------------------------------------------------
 * 刻意做得"像个会玩的人"而不是最优解。现在是**一套判据两个用法**：
 *
 *   · `draftScoreOf` 回答"这一签有多想要它"（能不能马上用 / 每金多少战力 /
 *     这支队伍缺不缺 / 离这一签的目标时代多远）；
 *   · 选人 = 在自己手里那副牌上取 argmax；
 *   · 禁用 = 拿"空手"再跑一遍同一个函数，看对面会怎么拿，然后按顺位下手。
 *
 * 两半曾经是分开写的：禁用用裸 `draftValueOf`（`targetEra` 默认 1、还带便宜加成），
 * 于是每局都去 ban 民兵和弓手——那不是打法，是走流程。合起来之后才说得清
 * "我禁的这张，正是我要是他就一定会拿的那张"。
 */

/** 这一签的目标时代（时代梯子）：从起始时代起，按已拿张数往上爬 */
function targetEraOf(state: GameState, handSize: number): number {
  const startEra = Math.max(1, state.config.startEra ?? 1);
  const slots = state.draft?.pickSlots ?? 6;
  const climb = Math.round(handSize * DRAFT_ERA_CLIMB * Math.min(1, 8 / Math.max(1, slots)));
  return startEra + Math.min(4, climb);
}

/**
 * 按选人判据把一批卡排成"会怎么拿"的顺序。
 *
 * **这是禁用和选人唯一的共同入口**：禁用不再另起一套价值函数，而是问
 * "如果我是对手，我会按什么顺序拿这池子里的东西"。
 */
function rankByPick(
  state: GameState,
  ids: readonly string[],
  hand: ReadonlySet<string>,
  water: number,
): Array<{ id: string; score: number }> {
  const ctx: DraftScoreCtx = {
    state,
    hand,
    startEra: Math.max(1, state.config.startEra ?? 1),
    targetEra: targetEraOf(state, hand.size),
    water,
  };
  const out: Array<{ id: string; score: number }> = [];
  for (const id of ids) {
    const score = draftScoreOf(id, ctx);
    if (score === null) continue;
    out.push({ id, score });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

/**
 * 把整轮 BP 走一遍，返回每个席位拿到哪些卡。
 *
 * 两边都用同一套选人判据（贪心取当前最高分），已经禁掉的卡直接消失——
 * 这就是"这么禁之后，这盘 BP 会怎么走"的一次预演。确定性，没有随机。
 */
function simulatePicks(
  state: GameState,
  ids: readonly string[],
  banned: ReadonlySet<string>,
  water: number,
): Map<string, Array<{ id: string; score: number }>> {
  const order = state.draft?.order ?? [];
  const alive = new Set(ids.filter((id) => !banned.has(id)));
  const hands = new Map<string, Set<string>>();
  const got = new Map<string, Array<{ id: string; score: number }>>();
  for (const seat of order) {
    if (alive.size === 0) break;
    const hand = hands.get(seat) ?? new Set<string>();
    hands.set(seat, hand);
    const pick = rankByPick(state, [...alive], hand, water)[0];
    if (!pick) break;
    alive.delete(pick.id);
    hand.add(pick.id);
    const list = got.get(seat) ?? [];
    list.push(pick);
    got.set(seat, list);
  }
  return got;
}

/**
 * 禁用：禁掉"最该被禁的那张"。
 *
 * ---------------------------------------------------------------
 * 2026-11-04 之前
 * ---------------------------------------------------------------
 * 它取池内 `draftValueOf` 最大的那个，而那个函数的 `targetEra` 默认是 1、
 * 还带"越便宜分越高"的系数——100 局实测里每局都 ban 民兵、再 ban 弓手，
 * 禁用组合一次没变过。那不是在打 BP，是在走流程：民兵本来就不是任何人会先拿的卡。
 *
 * ---------------------------------------------------------------
 * 现在（2026-11-07，禁用改成轮流之后）
 * ---------------------------------------------------------------
 * 先用**选人的那套判据**（空手跑一遍）排出"对面会按什么顺序拿"，
 * 然后禁掉榜首——对面第一选就会拿走的那张。
 *
 * 盲禁时代那套"先手必须预演对面禁什么"的推理，在轮流制下**不成立了**：
 *
 *   · 后禁的一方**直接看得见**先禁方禁了什么（看不见就没法下嘴，
 *     而且会去禁一个已经被禁掉的兵）；
 *   · 先禁的一方根本没有可预判的对象——对面的禁用还没发生。
 *
 * 所以两种策略合成一种：禁"当前最值钱的那张"。`targeted` 那个"预演对面禁榜首
 * 再掐他阵容"的玩法保留成显式参数（探针脚本还在用它跑对照），但 auto 不再预判
 * ——在轮流制里预判等于把已经发生的事再猜一遍。
 */
export type BanMode = 'auto' | 'targeted' | 'generic';

export function aiDraftBan(state: GameState, side: PlayerId, mode: BanMode = 'auto'): string | null {
  const pool = remainingUnits(state);
  const combat = pool.filter((id) => state.unitTypes[id]?.category === 'combat');
  const ids = combat.length > 0 ? combat : pool;
  if (ids.length === 0) return null;

  const water = waterShareOf(state);
  const ranked = rankByPick(state, ids, new Set<string>(), water);
  if (ranked.length === 0) return ids[0]!;
  if (ranked.length === 1) return ranked[0]!.id;

  // 摇摆：35% 的局里，禁用从"第 1 张"退到第 2~3 张（见 swayOffset 的说明）
  const sway = swayOffset(state, side);

  /*
   * 两种禁用策略：
   *   · generic  —— 禁"当前第一名"（对面第一选会拿走的那张）；
   *   · targeted —— 预演对面禁榜首，再禁掉**对面阵容里**最值钱的那张。
   *
   * auto 现在一律 generic：轮流禁之后，后禁方直接看得见先禁方的成果，
   * 先禁方也没有可预判的对象（见上面那段）。此前那套"A 用 targeted、
   * B 用 generic"的不对称是盲禁时代的遗留，从没经过平衡论证——
   * 它顺带还是 20×20 先手 67% 的嫌疑人之一，这次一并去掉。
   */
  const strategy: 'targeted' | 'generic' = mode === 'auto' ? 'generic' : mode;
  if (strategy === 'generic') return ranked[Math.min(sway, ranked.length - 1)]!.id;

  // targeted：预演"对面禁榜首"，再禁掉对面阵容里最值钱的那张
  const oppBan = ranked[0]!.id;
  const got = simulatePicks(state, ids, new Set([oppBan]), water);
  const oppPicks: Array<{ id: string; score: number }> = [];
  const seenOpp = new Set<string>();
  for (const [seat, list] of got) {
    if (seat === side) continue;
    for (const pick of list) {
      if (pick.id === oppBan || seenOpp.has(pick.id)) continue;
      seenOpp.add(pick.id);
      oppPicks.push(pick);
    }
  }
  oppPicks.sort((a, b) => b.score - a.score);
  if (oppPicks.length === 0) return ranked[Math.min(sway, ranked.length - 1)]!.id;
  // 兜底：万一推演给出的那张是榜首（多人局里可能出现），退回"次席"
  const chosen = oppPicks[Math.min(sway, oppPicks.length - 1)]!;
  return chosen.id === ranked[0]!.id ? ranked[1]!.id : chosen.id;
}

/**
 * 禁用时的"摇摆"偏移：0 = 照旧禁第一张，1/2 = 退到第 2 / 第 3 张。
 *
 * 为什么要这个：时代 1 跑 100 局，双方**每一局**都在禁同两张卡（弓手 + 僵尸），
 * 禁用占掉 BP 一半的来回，却一点信息量都没有——对手不用猜你在想什么，
 * 你也不用判断这一局的图/阵容值不值得换个禁法。禁用变成了走流程。
 *
 * 现在 65% 照旧、35% 退一档（其中 7 成退到第 2、3 成退到第 3），
 * 于是"最该禁的那张"仍然最常被禁，但对面没法照着一个固定答案来配阵容。
 *
 * **必须是种子派生的**，不能 Math.random：联机两边各自算一次禁用、复盘要逐帧
 * 还原，真随机会让同一局在两台机器上走出两个不同的 BP。这里用
 * (seed, 席位, 这个席位已禁了几个) 派生——同一个局面永远同一个结果，
 * 而不同的对局（不同 seed）会看到不同的摇摆。
 */
const SWAY_CHANCE = 0.35;
function swayOffset(s: GameState, side: PlayerId): 0 | 1 | 2 {
  const done = (s.draft?.bans[side] ?? []).filter(Boolean).length;
  const salt = side.charCodeAt(0) * 0x85ebca6b;
  const roll = nextRandom((s.seed ^ salt ^ ((done + 1) * 0xc2b2ae35)) >>> 0).value;
  if (roll >= SWAY_CHANCE) return 0;
  const depth = nextRandom((s.seed ^ salt ^ ((done + 1) * 0x9e3779b1) ^ 0x5bf03635) >>> 0).value;
  return depth < 0.7 ? 1 : 2;
}

/**
 * 选人：按 `draftScoreOf` 取最高分。
 *
 * 判据全在 `draftScoreOf` 里（禁用共用同一个函数），这里只负责把"手里已有的卡"
 * 交给 `rankByPick`——生态位缺口和时代梯子都靠它算。
 */
export function aiDraftPick(state: GameState, side: PlayerId): string | null {
  const left = remainingUnits(state);
  if (left.length === 0) return null;

  const mine = new Set<string>(state.draft?.picks[side] ?? []);
  // 水军只在真有水的地图上才值一个名额。地图在这一步已经生成好了（createMatch
  // 先建图再建选卡），所以直接看水面占比，别让 AI 在旱地图上选两条船。
  const water = waterShareOf(state);

  // 目标时代（"时代梯子"）见 `targetEraOf`：前几签买"现在能打的"，往后逐签抬高，
  // 最后留一两个位置给"决战用的东西"——**一支队伍的时代是阶梯，不是一个点**。
  const ranked = rankByPick(state, left, mine, water);
  return ranked[0]?.id ?? left[0]!;
}

/**
 * 一张卡值多少分。**选人和禁用共用这一个函数**。
 *
 * 分开写过一次（禁用用裸 `draftValueOf`、选人用带阶梯与生态位加成的版本），
 * 结果就是禁用每局都 ban 同一个"最便宜的好身体"——两套判据各自演化，
 * 谁也不知道对方在看什么。现在只有一个入口：禁用 = 用空手跑一遍选人的评分。
 */
interface DraftScoreCtx {
  state: GameState;
  /** 已经拿到手的卡（判定生态位缺口用） */
  hand: ReadonlySet<string>;
  startEra: number;
  /** 这一签想落在哪一代（禁用时 = 起始时代，见 `targetEraOf`） */
  targetEra: number;
  /** 水面占比：旱地图上船该被压下去 */
  water: number;
}

function draftScoreOf(id: string, ctx: DraftScoreCtx): number | null {
  const { state, hand, startEra, targetEra, water } = ctx;
  const def = state.unitTypes[id];
  if (!def) return null;

  const has = (pred: (d: UnitTypeDef) => boolean): boolean => {
    for (const x of hand) {
      const d = state.unitTypes[x];
      if (d && pred(d)) return true;
    }
    return false;
  };

  let score = draftValueOf(def, targetEra);
  if (def.category === 'building') {
    // 建筑只在"还没拿到塔"时值得选，而且不该抢在兵前面。
    // 已经有了就一票否决：线上 AI 的终局建筑里常年摆着两座塔，
    // 而它在同一局里连一支能出门的部队都凑不出来。
    if (has((d) => d.category === 'building')) return null;
    score *= 0.55;
  }
  if (!has((d) => (d.splash ?? 0) > 0) && (def.splash ?? 0) > 0) score += 18;
  if (!has((d) => (d.range ?? 0) >= 3) && (def.range ?? 0) >= 3) score += 14;
  if (!has((d) => (d.maxHp ?? 0) >= 140) && (def.maxHp ?? 0) >= 140) score += 12;
  /*
   * 配合：国王 + 精英骑兵。
   *
   * 「王命」每回合把自己半径 2 内的精英骑兵晋升成皇家骑兵（按血量比例，每人一次），
   * 所以"国王 + 一批 125 金的骑兵"是这包里少有的明确 A+B 组合。
   * 但评分只看单张卡，AI 原来对它完全无感：200 局选卡里国王被选 64 次、
   * 精英骑兵被选 5 次，**一次都没落在同一方**——王命在线上从来没触发过。
   *
   * 判据写作"手里有没有那张配套卡"，而不是解析能力钩子：钩子里没有
   * "我强化谁"这种声明，硬读等于在 AI 里重写一遍规则。
   */
  // 分值 45：比"一张好卡"的量级再高一点，因为这条配合是**可重复的**——
  // 王命每回合都能晋，一匹 125 金的骑兵会变成 235 金的皇家骑兵（攻 16→38、甲 4→8）。
  // 试过 20，实测不够：手里有国王时它仍然优先选皇家骑兵本身（235 金那张），
  // 等于花更多钱买同一个东西，配合反而永远凑不起来。
  if (def.id === 'elite-cavalry' && has((d) => d.id === 'royal-king')) score += 45;
  if (def.id === 'royal-king' && has((d) => d.id === 'elite-cavalry')) score += 45;
  // 旱地图上的船：占一个名额，整局开不出去。门槛和 ai.ts 的 WATER_MIN_SHARE /
  // WATER_GOOD_SHARE 对齐（<8% 旱地 / 8~14% 勉强能开 / ≥14% 水网）。
  if (def.domain === 'water') score *= water >= 0.14 ? 0.9 : water >= 0.08 ? 0.5 : 0.2;
  // 一个便宜的身体。前二十回合总得有东西能出门，任何一个会玩的人都会留这一手。
  if (!has((d) => d.category === 'combat' && (d.cost ?? 999) <= 70) &&
      def.category === 'combat' && (def.cost ?? 999) <= 70) {
    score += 16;
  }
  // 手里一张"现在就造得出"的卡都没有：这一签必须落地，只在这个时代里挑。
  if (!has((d) => (d.era ?? 9) <= startEra) && def.category === 'combat' && def.era <= startEra) {
    score += 26;
  }
  if (hand.size === 0 && def.era <= 2) score += 8;
  return score;
}

/**
 * 这张图上水面占多少（0~1）。
 *
 * 选卡发生在建图之后，所以这一步拿得到真实地形。以前选卡完全不看地图，
 * AI 在一条小河边也会把两个名额花在船和运输船上——那两条船整局都开不出港口。
 */
function waterShareOf(state: GameState): number {
  const tiles = state.tiles;
  if (!tiles || tiles.length === 0) return 0;
  let n = 0;
  // 口径和 ai.ts 的 waterShare 对齐：只数 deep water，浅滩是能蹚过去的，不算航道
  for (const t of tiles) if (t.terrain === 'water') n += 1;
  return n / tiles.length;
}

/**
 * 选卡时给一个兵种打多少分。
 *
 * 三件事，按乘法叠：
 *   1. **离目标时代有多远**：`targetEra` 由名额进度决定（见 `aiDraftPick` 的时代梯子）。
 *      这一条取代了上一版的"时代领先就平方折价"——那种写法只有一个方向，
 *      结果把队伍压成清一色一级兵（平均时代 1.38），等于从一个极端走到另一个极端。
 *      现在是双向的：比目标时代低也扣分，高了也扣分，队伍的时代才是一条阶梯。
 *   2. **每金多少战力**：以 80 金为基准打折。贵而强不如便宜够用，但这一条只是微调，
 *      指数 0.3——太狠的话又会把高时代兵一起压死。
 *   3. **数值本身**（`atk + 0.4×血 + 3×甲 + 3×射程`，和海军扩展那套 V 值同源）。
 */
function draftValueOf(def: UnitTypeDef | undefined, targetEra = 1): number {
  if (!def) return 0;
  const raw = def.atk + 0.4 * def.maxHp + 3 * def.armor + 3 * def.range;
  if (raw <= 0) return 0;
  // 离目标时代每差一级折一半左右：一级之内几乎不罚，差三级基本淘汰
  const eraFit = 1 / (1 + 0.85 * Math.abs((def.era ?? 1) - targetEra));
  const perGold = Math.pow(80 / Math.max(20, def.cost ?? 80), 0.3);
  return raw * eraFit * perGold;
}

/** 每往后一签，目标时代往上爬多少级（8 个名额 ≈ 爬 3 代） */
const DRAFT_ERA_CLIMB = 0.4;

/* ===========================================================================
 * 七、文案
 * ======================================================================== */

export function draftPhaseLabel(state: GameState): string {
  const draft = state.draft;
  if (!draft) return '';
  if (draft.phase === 'lobby') return '等待开局';
  if (draft.phase === 'ban') return '禁用阶段';
  if (draft.phase === 'pick') return `选人 ${draft.step + 1} / ${draft.order.length}`;
  return '选卡完成';
}

/** 秒数（给倒计时用），小于 0 归零 */
export function draftSecondsLeft(state: GameState, now: number): number {
  const draft = state.draft;
  // lobby 不计时（要等人），结束/跳过也不计
  // lobby 也处理：池子在 DRAFT_START 那一刻就定了，这时候摘是安全的，
  // 而且读档进 lobby 正是"还没开始选"的常见状态
  if (!draft || draft.phase === 'done') return 0;
  return Math.max(0, Math.ceil((draft.deadline - now) / 1000));
}
