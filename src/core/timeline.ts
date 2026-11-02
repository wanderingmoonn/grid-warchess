/**
 * 逐回合摘要：一局棋每隔几回合留一行，外加"这局都干了些什么"的计数。
 *
 * 为什么需要它：结算卡上那份报告只有**终局**一个切片——两边最后剩几个兵、
 * 几座城、多少金。拿它调平衡有个致命缺口：看不出"这局是怎么走到这一步的"。
 * 是开局被压死，还是钱一直花不出去、兵堆到编制上限？有没有全程没人造攻城器？
 * AI 的战术档到底切没切过？这些都得看曲线和中途的选择，终局快照里一个字都没有。
 *
 * 三条设计约束：
 *   1. **有上限**。一局能打两百多回合，一次采样几十个数，不封顶就是几兆的字符串，
 *      存档、联机同步、上传全都被拖着走。所以样本数封顶 MAX_SAMPLES，
 *      超了改成等比抽稀（不是简单丢弃——早期局面同样是证据）。
 *   2. **纯函数**。不读时间、不读随机、不改局面，所以规则测试能直接断言
 *      "采了 N 行、第一行等于开局、封顶之后行数不再涨"。
 *   3. **只记数字**。这里不出现玩家名、坐标、操作流水。位置轨迹等于作息表，
 *      而"这局两边各有多少兵"不指向任何人。
 *
 * ── v2（2026-11-02）加了什么、为什么 ──
 *
 * v1 只能回答"谁赢、造了什么、最后剩什么"。拿它调平衡，缺的恰恰是中间那一层：
 * 哪个兵种一上场就被打死、哪个兵种挨的伤害远多于它造成的。所以 v2 补三样，
 * 全都不碰坐标与操作流水：
 *
 *   · **按席位记录**：v1 只写 A/B 两行。三人四人局已经上线了，再只采两席，
 *     那两家的曲线等于白采。
 *   · **逐兵种战损与伤害**：lostByType（死了几个）、takenByType（挨了多少）、
 *     dealtByType（打出去多少）。前者靠"上一步还在、这一步没了"的差分，
 *     后两者靠血量差分——不需要规则层埋点，扩展怎么改都盖得住。
 *   · **活跃单位数**：本回合动过或打过仗的兵有多少个。金币堆着不花、兵站着
 *     不动，是 AI 和人的通病，而"兵多"这个数字看不出这件事。
 */

import type { Action, GameState, PlayerId } from './types.ts';
import { seatsOf } from './types.ts';

/**
 * 摘要格式版本。
 *
 * 1 = 只有 A/B 两行 + 身价/战损（2026-10-28 上线，库里那批就是这么存的）
 * 2 = 按席位记录 + 逐兵种战损与伤害 + 活跃单位数
 *
 * 分析脚本要按版本分开读：v1 的样本里没有 sides 字段。
 */
export const TIMELINE_VERSION = 2;

/** 样本上限。240 行 ≈ 一局 240 个回合，加密后不到 8KB */
const MAX_SAMPLES = 240;

/** 每方一行里记什么：[兵数, 建筑数, 城数, 金币, 总血量] */
export type SideSample = [
  units: number,
  buildings: number,
  cities: number,
  gold: number,
  hp: number,
];

export interface TurnSample {
  /** 第几回合 */
  t: number;
  /** 每席一行。未坐的席位不写（两人局只有 A/B，四人局四个都在） */
  sides: Partial<Record<PlayerId, SideSample>>;
  /**
   * 每席军队身价（按造价求和，金币）。
   * 能看出"谁的兵更值钱"而不只是"谁兵多"。
   */
  value: Partial<Record<PlayerId, number>>;
  /**
   * 截至本回合，每席**累计损失**的兵力身价（金）。
   *
   * 只记累计不记单回合增量，是因为增量可以相邻两帧相减得到，反过来不行；
   * 而"哪一回合崩的"恰恰要看增量，所以两种问法都得能从这串数字里算出来。
   *
   * 口径：只算**兵**（不含建筑、不含被拆除的）。拆自己的建筑是主动回收，
   * 算成战损会把"整理阵型"误读成"被打崩"。
   */
  lost: Partial<Record<PlayerId, number>>;
  /** 截至本回合，每席累计损失掉的兵**个数** */
  dead: Partial<Record<PlayerId, number>>;
  /**
   * 本回合"动过"的兵有几个（移动过或出手过）。
   *
   * 分母取同帧的 `sides[p][0]`（兵数）。这个比值就是"闲置率"：
   * 兵很多但活跃数一直只有三四个，说明要么在排队、要么不会用兵。
   * 建筑不算——塔不开火是"没敌人"，不是"闲置"。
   *
   * **读的时候注意**：帧是在"某一家结束回合"那一刻采的，而标记要到下一家
   * 回合开始才重置。所以同一帧里**只有刚走完的那一家**是真数字，其余席位
   * 一律是 0——那是"还没轮到"，不是"一个兵都没动"。别把两席平均，
   * 那会凭空造出一半的假闲置。
   */
  active: Partial<Record<PlayerId, number>>;
}

/**
 * 老版本（v1）的样本形状。
 *
 * 只给分析脚本用：库里 2026-10-28 ~ 11-01 那批数据是这个形状，
 * 直接按 v2 读会得到一片 undefined。
 */
export interface TurnSampleV1 {
  t: number;
  A: SideSample;
  B: SideSample;
  va: number;
  vb: number;
  lostA: number;
  lostB: number;
  deadA: number;
  deadB: number;
}

export interface MatchTimeline {
  v: number;
  /** 从第几回合开始记的（中途开启就不等于 1） */
  from: number;
  /** 采样间隔：抽稀之后会变大 */
  every: number;
  samples: TurnSample[];
  /** 行动次数：席位 -> 动作类型 -> 次数 */
  acts: Record<PlayerId, Record<string, number>>;
  /** 出兵次数：席位 -> 兵种 id -> 个数 */
  made: Record<PlayerId, Record<string, number>>;
  /**
   * 战损明细：席位 -> 兵种 id -> 死了几个。
   *
   * 和 `made` 是同一件事的两头：造了 8 个狼骑、死了 7 个，终局阵容里只剩 1 个——
   * 只看终局名单会以为"没人用狼骑"，其实是被打光了。
   */
  lostByType: Record<PlayerId, Record<string, number>>;
  /** 承受伤害：席位 -> 兵种 id -> 累计掉的血 */
  takenByType: Record<PlayerId, Record<string, number>>;
  /**
   * 造成伤害：席位 -> 兵种 id -> 累计打出去的血。
   *
   * 只归因**主动出手那一步**（action.type === 'ATTACK'）：这一步里对方掉的血
   * 都算在出手的这个兵种头上，溅射、多目标、连击都盖得住。
   * 反击的伤害不记在这里——那一下"是谁打的"要靠额外推断，而它占比很小；
   * 反过来，反击吃到的伤害照常记在 takenByType 里，所以不会凭空消失。
   */
  dealtByType: Record<PlayerId, Record<string, number>>;
  /** 有没有因为超上限被抽稀过 */
  thinned: boolean;
  /**
   * 内部状态：上一次看到的单位（id → [阵营, 兵种, 身价, 血量]），建筑身价记 0。
   * 只用来做差分，**不进报告**——sealTimeline() 会把它剥掉。
   */
  seen?: Record<string, [PlayerId, string, number, number]>;
  /** 累计损失（seal 之后保留，方便一眼看到总量） */
  lost?: Record<PlayerId, { value: number; count: number }>;
}

// 四个席位都留：三人四人局的复盘要能分家看损失
const SIDES: PlayerId[] = ['A', 'B', 'C', 'D'];

function emptyTally(): Record<PlayerId, Record<string, number>> {
  return { A: {}, B: {}, C: {}, D: {} };
}

function zeroLost(): Record<PlayerId, { value: number; count: number }> {
  return {
    A: { value: 0, count: 0 },
    B: { value: 0, count: 0 },
    C: { value: 0, count: 0 },
    D: { value: 0, count: 0 },
  };
}

/** 往一张"兵种 -> 数字"的表里加一笔，返回加完的值 */
function bump(bag: Record<string, number>, key: string, n: number): number {
  const next = (bag[key] ?? 0) + n;
  bag[key] = next;
  return next;
}

/** 开一个新的记录器 */
export function newTimeline(fromTurn: number): MatchTimeline {
  return {
    v: TIMELINE_VERSION,
    from: Math.max(1, Math.round(fromTurn)),
    every: 1,
    samples: [],
    acts: emptyTally(),
    made: emptyTally(),
    lostByType: emptyTally(),
    takenByType: emptyTally(),
    dealtByType: emptyTally(),
    thinned: false,
    seen: {},
    lost: zeroLost(),
  };
}

/**
 * 每走完一步调一次：比对上一帧的单位集合与血量。
 *
 * 三件事一次做完，因为它们本来就是"同一次差分"的三种读法：
 *   · 单位消失了 → 计入损失（金额、个数、兵种）；
 *   · 单位还在但血少了 → 计入"承受伤害"（按兵种）；
 *   · 这一步是主动出手 → 对方掉的血计入"造成伤害"（按出手的兵种）。
 *
 * 为什么不数 `u.kills`：那个字段只在开了「老兵不死」扩展时才增长（见 rules 里
 * 的注释），拿它当击杀数在别的扩展组合下永远是 0。差分不依赖任何规则，
 * 扩展用技能、毒、地形打掉的血也一样算得出来——这正是选它的理由。
 *
 * 拆除（DISBAND）要特殊处理：那是主动回收，不是战损，先从旧集合里摘掉再比。
 */
export function noteDeaths(tl: MatchTimeline, s: GameState, action?: Action): void {
  const seen = tl.seen ?? (tl.seen = {});
  const lost = tl.lost ?? (tl.lost = zeroLost());

  if (action?.type === 'DISBAND') delete seen[action.unitId];

  /** 这一步之后还活着的单位：[阵营, 兵种, 身价, 血量] */
  const alive: Record<string, [PlayerId, string, number, number]> = {};
  for (const u of s.units) {
    const def = s.unitTypes[u.type];
    // 建筑身价记 0：它消失时不该算成兵力损失（下面的 cost<=0 判断会跳过），
    // 挨打也不记——「这段墙掉了多少血」和"兵有多脆"是两套口径，混在一起没意义
    const cost = def?.category === 'building' ? 0 : (def?.cost ?? 0);
    alive[u.id] = [u.owner, u.type, cost, Math.max(0, u.hp)];
  }

  const hpBefore: Record<PlayerId, number> = { A: 0, B: 0, C: 0, D: 0 };
  const hpAfter: Record<PlayerId, number> = { A: 0, B: 0, C: 0, D: 0 };
  for (const [, info] of Object.entries(seen)) hpBefore[info[0]] += info[3];
  for (const [, info] of Object.entries(alive)) hpAfter[info[0]] += info[3];

  // ① 还在、但掉血了：谁挨的打
  for (const [id, [side, type, cost, hp]] of Object.entries(seen)) {
    const now = alive[id];
    if (!now || cost <= 0) continue; // 建筑不记
    const drop = hp - now[3];
    if (drop > 0) bump(tl.takenByType[side], type, drop);
  }

  // ② 没了：算战损。死前剩下的那点血也挨过打，记在承受里
  for (const [id, [side, type, cost, hp]] of Object.entries(seen)) {
    if (alive[id] || cost <= 0) continue;
    lost[side].value += cost;
    lost[side].count += 1;
    bump(tl.lostByType[side], type, 1);
    if (hp > 0) bump(tl.takenByType[side], type, hp);
  }

  // ③ 这一步是主动出手：对方掉的血算在出手的兵种头上
  if (action?.type === 'ATTACK' && action.unitId) {
    const self = alive[action.unitId] ?? seen[action.unitId];
    if (self) {
      const [mySide, myType] = self;
      for (const p of SIDES) {
        if (p === mySide) continue;
        const dropped = Math.max(0, hpBefore[p] - hpAfter[p]);
        if (dropped > 0) bump(tl.dealtByType[mySide], myType, dropped);
      }
    }
  }

  tl.seen = alive;
}

/**
 * 出报告前把内部状态摘掉。
 *
 * `seen` 是"上一次看见的单位 id 表"，几十条、还会随局面变；它留在报告里
 * 既占体积又毫无意义（还让人以为报告里带了单位坐标）。
 * v2 起它多存了兵种与血量，更该剥掉——那份表等于把场上的每个兵都列了一遍。
 */
export function sealTimeline(tl: MatchTimeline): MatchTimeline {
  const { seen: _seen, ...rest } = tl;
  return { ...rest, samples: rest.samples.map((x) => ({ ...x })) };
}

/**
 * 记一次行动。
 *
 * 只数"做了什么类型"，不记在哪、对谁——那才是隐私边界。
 * RECRUIT 额外按兵种计数：这是**真实产出**，比终局阵容更准
 * （造了五个民兵、死了四个，终局阵容里只剩一个）。
 */
export function noteAction(tl: MatchTimeline, side: PlayerId, action: Action): void {
  const acts = tl.acts[side];
  acts[action.type] = (acts[action.type] ?? 0) + 1;
  if (action.type === 'RECRUIT') {
    const bag = tl.made[side];
    bag[action.unitType] = (bag[action.unitType] ?? 0) + 1;
  }
}

/** 把一方的当前局面压成一行数字 */
function sideSample(s: GameState, p: PlayerId): { line: SideSample; value: number } {
  let units = 0;
  let buildings = 0;
  let hp = 0;
  let value = 0;
  for (const u of s.units) {
    if (u.owner !== p) continue;
    const def = s.unitTypes[u.type];
    if (def?.category === 'building') buildings += 1;
    else {
      units += 1;
      value += def?.cost ?? 0;
    }
    hp += Math.max(0, u.hp);
  }
  const cities = s.cities.filter((c) => c.owner === p).length;
  return { line: [units, buildings, cities, s.players[p].gold, hp], value };
}

/**
 * 这一方本回合动过几个兵。
 *
 * 口径取 `moved || acted`：这两个标记由 rules 在**下一个席位的回合开始**才重置
 * （见 resetUnitsFor 的调用点），所以采样的这一刻，刚走完的那一家身上的标记
 * 还是完整的。反过来，如果哪天真把重置挪到"自己回合结束"，这个数会一律变成 0，
 * 测试里那条"活跃数不能全零"就是为此钉的。
 */
function sideActive(s: GameState, p: PlayerId): number {
  let n = 0;
  for (const u of s.units) {
    if (u.owner !== p) continue;
    if (s.unitTypes[u.type]?.category === 'building') continue;
    if (u.moved || u.acted) n += 1;
  }
  return n;
}

/**
 * 采一帧。
 *
 * every 回合采一次：`s.turn % every === 0` 才记。抽稀之后 every 会变大，
 * 于是自动只在"能被新间隔整除的回合"上采样，不需要回头删数据。
 */
export function sampleTurn(s: GameState, tl: MatchTimeline, force = false): void {
  const every = Math.max(1, tl.every);
  // force：跳过间隔检查。开局基线和"认输/被灭"的最后一帧必须落地，
  // 否则一回合内结束的局会交上一份 0 帧的摘要——什么也说明不了。
  if (!force && s.turn % every !== 0) return;

  const sides: Partial<Record<PlayerId, SideSample>> = {};
  const value: Partial<Record<PlayerId, number>> = {};
  const lost: Partial<Record<PlayerId, number>> = {};
  const dead: Partial<Record<PlayerId, number>> = {};
  const active: Partial<Record<PlayerId, number>> = {};

  const acc = tl.lost ?? zeroLost();
  for (const p of seatsOf(s)) {
    const one = sideSample(s, p);
    sides[p] = one.line;
    value[p] = one.value;
    lost[p] = acc[p]?.value ?? 0;
    dead[p] = acc[p]?.count ?? 0;
    active[p] = sideActive(s, p);
  }

  tl.samples.push({ t: s.turn, sides, value, lost, dead, active });

  if (tl.samples.length > MAX_SAMPLES) {
    // 超了就把所有样本留着、间隔翻倍——只留偶数帧。
    // 直接砍掉最老的会让长局只剩后半段，而"开局怎么崩的"恰恰是最想看的。
    tl.samples = tl.samples.filter((_, i) => i % 2 === 0);
    tl.every = every * 2;
    tl.thinned = true;
  }
}

/**
 * 取某一席的样本，v1 / v2 都能读。
 *
 * 分析脚本要同时吃两批数据：库里 10-28 起那批是 v1（只有 A/B 两行），
 * 新版是 v2。分开写两套读取逻辑，迟早有一边忘了改。
 */
export function sampleOf(
  x: TurnSample | TurnSampleV1,
  side: PlayerId,
): SideSample | undefined {
  const v2 = (x as TurnSample).sides;
  if (v2) return v2[side];
  const v1 = x as TurnSampleV1;
  if (side === 'A') return v1.A;
  if (side === 'B') return v1.B;
  return undefined;
}

/** 给报告/界面看的一句话摘要 */
export function timelineSummary(tl: MatchTimeline | null | undefined): string {
  if (!tl || tl.samples.length === 0) return '';
  const first = tl.samples[0];
  const last = tl.samples[tl.samples.length - 1];
  if (!first || !last) return '';
  const kinds = new Set([
    ...Object.keys(tl.made?.A ?? {}),
    ...Object.keys(tl.made?.B ?? {}),
    ...Object.keys(tl.made?.C ?? {}),
    ...Object.keys(tl.made?.D ?? {}),
  ]);
  // 两人局念 A/B 就够；多席位时把身价并成一串
  const sides = Object.keys(last.sides ?? {}) as PlayerId[];
  const worth = sides.map((p) => `${p} ${first.value?.[p] ?? 0}→${last.value?.[p] ?? 0}`).join(' / ');
  const losses = sides.map((p) => `${p} ${last.lost?.[p] ?? 0}`).join(' / ');
  return [
    `${tl.samples.length} 帧`,
    `第 ${first.t}~${last.t} 回合`,
    `身价 ${worth}`,
    `战损 ${losses} 金`,
    `${kinds.size} 种兵`,
  ].join(' · ');
}

/** 行动类型的中文名（报告里给人看，不给机器看） */
export const ACTION_LABEL: Record<string, string> = {
  MOVE: '行军',
  ATTACK: '交战',
  SIEGE: '攻城',
  RECRUIT: '出兵',
  BUILD: '建造',
  LOAD: '上船',
  UNLOAD: '下船',
  UPGRADE: '升城',
  DISBAND: '拆除',
  HERO_SKILL: '英雄技',
  END_TURN: '结束回合',
  SET_ORDERS: '排产',
  PLACE_EGG: '孵化',
  SURRENDER: '认输',
};

/** sides 的固定顺序，写报告时按它遍历，避免对象键序漂移 */
export const TIMELINE_SIDES = SIDES;
