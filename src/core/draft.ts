/**
 * 选卡模式（BP）：开局先禁、再选，选完才开始下棋。
 *
 * ── 一句话规则 ────────────────────────────────────────────────────────
 *
 * 系统从「战斗单位 + 非生产性建筑」里抽出一池子（默认 20 个），
 * 双方各禁 1 个；剩下的按蛇形顺序轮流选，每人 6 个。
 * 这一局双方**只能造**自己选中的那些，外加骨架（经济单位、建造单位、军营、桥）。
 * 同时取消"产线只带当前时代和上一代"的下限——你选到的古典投石车，
 * 到了现代照样能造，否则选卡在后期等于白选。
 *
 * ── 为什么池子要按时代分层抽样 ────────────────────────────────────────
 *
 * 纯随机抽 20 个会出现"整池都是第五时代"的局：两个人开局造不起任何一个，
 * 前五回合只能用开局送的兵干瞪眼。所以按时代分桶、轮转取，
 * 保证每个时代都抽到货，池子天然是"从古典到当代的一条线"。
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

import { isPseudoUnit } from './config.ts';
import { unitSourceIdOf } from './expansions.ts';
import { nextRandom } from './rng.ts';
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
  const naval = expansionIds.some((id) => id.startsWith('naval-'));
  const air = expansionIds.some((id) => id.startsWith('air-'));
  // 时代军备＝「古典/中世/火药/工业/二战/现代」那一组，id 都是 pack- 开头
  const era = expansionIds.some((id) => id.startsWith('pack-'));

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
 * 要注意的一个组合：「现代海军」要带「现代」，而「现代」本身就是时代军备的一包，
 * 所以它会同时点亮海军的 +1 与时代军备的 +2（池 27 / 禁 2 / 选 9）。
 * 规则按**实际生效的体系**算，不按"玩家本来想开哪一类"算。
 */
export function draftBudget(state: GameState): DraftBudget {
  const extra = draftCandidates(state).filter((id) => unitSourceIdOf(id) !== null).length;
  const pool = Math.min(DRAFT_POOL_CAP, DRAFT_POOL_BASE + Math.ceil(extra / 2));
  const bonus = draftBonus(state.config.expansionIds ?? []);
  return {
    extra,
    pool,
    bans: Math.min(DRAFT_BAN_CAP, DRAFT_BAN_BASE + bonus.bans),
    picks: Math.min(DRAFT_PICK_CAP, DRAFT_PICK_BASE + bonus.picks),
  };
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
  if (def.category === 'economy' || def.category === 'builder') return true;
  // 军营＝生产性建筑；桥是地形设施，选卡不该决定"这条河过不过得去"
  return def.category === 'building' && (def.barracks === true || def.bridges === true);
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
 * 按时代分层抽样。
 *
 * 每个时代的桶先各自洗一遍，然后按"时代 1、2、3、4、5、1、2…"轮转取，
 * 直到取满。桶空了就跳过——所以小池子里不会出现"某个时代占了一半"。
 */
export function sampleDraftPool(
  state: GameState,
  size: number,
  seed: number,
): { pool: string[]; seed: number } {
  const buckets = new Map<number, string[]>();
  for (const id of draftCandidates(state)) {
    const def = state.unitTypes[id];
    if (!def) continue;
    const era = Math.max(1, Math.round(def.era));
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

  const pool: string[] = [];
  const cursors = new Map<number, number>(eras.map((e) => [e, 0]));
  // 轮转：一轮里每个时代最多取一个，取不到就跳过
  while (pool.length < size) {
    let took = 0;
    for (const era of eras) {
      const list = washed.get(era)!;
      const i = cursors.get(era)!;
      if (i >= list.length) continue;
      pool.push(list[i]!);
      cursors.set(era, i + 1);
      took += 1;
      if (pool.length >= size) break;
    }
    if (took === 0) break; // 全取空了
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
export function draftPickOrder(picks: number): PlayerId[] {
  const total = Math.max(0, picks) * 2;
  const out: PlayerId[] = [];
  for (let round = 0; out.length < total; round++) {
    const first: PlayerId = round % 2 === 0 ? 'A' : 'B';
    out.push(first);
    if (out.length < total) out.push(first === 'A' ? 'B' : 'A');
  }
  return out;
}

/**
 * 开局造一份选卡状态（由 setup.createMatch 调用）。
 *
 * 不需要"现在几点"：开局停在 lobby，不计时；开始禁用的那一刻才由 `DRAFT_START`
 * 带上 `at` 把截止时间钉下来（这样联机双方用的是同一台机器的钟，不会各算各的）。
 */
export function createDraft(state: GameState): DraftState {
  const budget = draftBudget(state);
  const sampled = sampleDraftPool(state, budget.pool, state.seed ^ 0x5eed1);
  return {
    // 先进"等待开局"：建房、贴邀请链接都发生在这一步（见 DraftPhase 的说明）
    phase: 'lobby',
    pool: sampled.pool,
    banSlots: budget.bans,
    pickSlots: budget.picks,
    bans: { A: [], B: [] },
    picks: { A: [], B: [] },
    order: draftPickOrder(budget.picks),
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
  return (['A', 'B'] as PlayerId[]).filter((s) => draft.bans[s].length < draft.banSlots);
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
      { turn: s.turn, player: 'A', open: true, text: '选卡开始：双方同时禁用' },
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
    if (draft.bans[actor].length >= draft.banSlots) {
      return { ok: false, reason: `你这一轮已经禁用过 ${draft.banSlots} 个了` };
    }
    const id = action.unitId;
    if (!draft.pool.includes(id)) return { ok: false, reason: '这个兵种不在本局池子里' };
    if (draft.bans[actor].includes(id)) return { ok: false, reason: '你已经禁过它了' };

    draft.bans[actor] = [...draft.bans[actor], id];
    draft.seq += 1;
    draft.history = [...draft.history, { side: actor, kind: 'ban', unitId: id, auto: false }];
    // 双方都交完才揭晓，同时进入选人阶段
    if (draft.bans.A.length >= draft.banSlots && draft.bans.B.length >= draft.banSlots) {
      draft.phase = 'pick';
      draft.step = 0;
      draft.deadline = (action.at ?? draft.deadline) + draftPickMsOf(s);
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
      // 没交禁用的那一方＝放弃这次禁用。放弃是允许的，而且不该替它随机禁一个：
      // 随机禁用有可能禁掉自己最想要的兵，那是惩罚而不是兜底。
      for (const side of pendingBans(s)) {
        draft.history = [
          ...draft.history,
          { side, kind: 'ban', unitId: null, auto: true },
        ];
        // 用空数组占位不行（那等于没交），所以补一个"放弃"标记：长度对齐 banSlots
        while (draft.bans[side].length < draft.banSlots) {
          draft.bans[side] = [...draft.bans[side], ''];
        }
      }
      draft.phase = 'pick';
      draft.step = 0;
      draft.seq += 1;
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
  };
}

/**
 * AI 的选卡决策。
 *
 * 刻意做得"像个会玩的人"而不是最优解：
 *   · 禁用：优先 ban 掉池子里**同代最贵**的战斗单位（贵的就是对面的核心）；
 *   · 选人：优先补自己还缺的生态位（经济/攻城/远程/坦克），同生态位里挑评分最高的。
 *
 * 评分用 `攻 + 0.4×血 + 3×甲 + 3×射程`——和海军扩展那套 V 值同源，
 * 但丢掉移动/视野：选卡选的是"这兵值不值得占一个名额"，不是走位。
 */
export function aiDraftBan(state: GameState, side: PlayerId): string | null {
  const left = remainingUnits(state).filter((id) => {
    const def = state.unitTypes[id];
    return def?.category === 'combat';
  });
  if (left.length === 0) return remainingUnits(state)[0] ?? null;
  const best = left
    .map((id) => ({ id, v: draftValueOf(state.unitTypes[id]) }))
    .sort((x, y) => y.v - x.v)[0];
  void side;
  return best?.id ?? null;
}

export function aiDraftPick(state: GameState, side: PlayerId): string | null {
  const left = remainingUnits(state);
  if (left.length === 0) return null;
  const mine = new Set(state.draft?.picks[side] ?? []);

  // 生态位：手里没有的那一类加权重
  const has = {
    siege: [...mine].some((id) => (state.unitTypes[id]?.splash ?? 0) > 0),
    ranged: [...mine].some((id) => (state.unitTypes[id]?.range ?? 0) >= 3),
    tank: [...mine].some((id) => (state.unitTypes[id]?.maxHp ?? 0) >= 140),
    any: mine.size > 0,
  };

  let best: { id: string; score: number } | null = null;
  for (const id of left) {
    const def = state.unitTypes[id];
    if (!def) continue;
    let score = draftValueOf(def);
    if (def.category === 'building') {
      // 建筑只在"还没拿到塔"时值得选，而且不该抢在兵前面
      score *= 0.55;
    }
    if (!has.siege && (def.splash ?? 0) > 0) score += 18;
    if (!has.ranged && (def.range ?? 0) >= 3) score += 14;
    if (!has.tank && (def.maxHp ?? 0) >= 140) score += 12;
    if (!has.any && def.era <= 2) score += 8;
    if (!best || score > best.score) best = { id, score };
  }
  return best?.id ?? left[0]!;
}

function draftValueOf(def: UnitTypeDef | undefined): number {
  if (!def) return 0;
  return def.atk + 0.4 * def.maxHp + 3 * def.armor + 3 * def.range;
}

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
  if (!draft || draft.phase === 'done' || draft.phase === 'lobby') return 0;
  return Math.max(0, Math.ceil((draft.deadline - now) / 1000));
}
