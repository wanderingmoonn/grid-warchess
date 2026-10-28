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
 */

import type { Action, GameState, PlayerId } from './types.ts';

export const TIMELINE_VERSION = 1;

/** 样本上限。240 行 ≈ 一局 240 个回合，加密后不到 8KB */
const MAX_SAMPLES = 240;

/** 每方一行里记什么：[兵数, 建筑数, 城数, 金币, 总血量] */
export type SideSample = [units: number, buildings: number, cities: number, gold: number, hp: number];

export interface TurnSample {
  /** 第几回合 */
  t: number;
  A: SideSample;
  B: SideSample;
  /** 双方军队身价（按造价求和，金币）。能看出"谁的兵更值钱"而不只是"谁兵多" */
  va: number;
  vb: number;
  /**
   * 截至本回合，双方**累计损失**的兵力身价（金）与兵数。
   *
   * 只记累计不记单回合增量，是因为增量可以相邻两帧相减得到，反过来不行；
   * 而"哪一回合崩的"恰恰要看增量，所以两种问法都得能从这一对数字里算出来。
   *
   * 口径：只算**兵**（不含建筑、不含被拆除的）。拆自己的建筑是主动回收，
   * 算成战损会把"整理阵型"误读成"被打崩"。
   */
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
  /** 行动次数：A/B -> 动作类型 -> 次数 */
  acts: Record<PlayerId, Record<string, number>>;
  /** 出兵次数：A/B -> 兵种 id -> 个数 */
  made: Record<PlayerId, Record<string, number>>;
  /** 有没有因为超上限被抽稀过 */
  thinned: boolean;
  /**
   * 内部状态：上一次看到的单位（id → [阵营, 身价]，建筑记 0）。
   * 只用来做差分，**不进报告**——sealTimeline() 会把它剥掉。
   */
  seen?: Record<string, [PlayerId, number]>;
  /** 累计损失（seal 之后保留，方便一眼看到总量） */
  lost?: Record<PlayerId, { value: number; count: number }>;
}

const SIDES: PlayerId[] = ['A', 'B'];

function emptyTally(): Record<PlayerId, Record<string, number>> {
  return { A: {}, B: {} };
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
    thinned: false,
    seen: {},
    lost: { A: { value: 0, count: 0 }, B: { value: 0, count: 0 } },
  };
}

/**
 * 每走完一步调一次：比对上一帧的单位集合，**消失的就是损失**。
 *
 * 为什么不数 `u.kills`：那个字段只在开了「老兵不死」扩展时才增长（见 rules 里
 * 的注释），拿它当击杀数在别的扩展组合下永远是 0。差分不依赖任何规则。
 *
 * 拆除（DISBAND）要特殊处理：那是主动回收，不是战损，先从旧集合里摘掉再比。
 */
export function noteDeaths(tl: MatchTimeline, s: GameState, action?: Action): void {
  const seen = tl.seen ?? (tl.seen = {});
  const lost = tl.lost ?? (tl.lost = { A: { value: 0, count: 0 }, B: { value: 0, count: 0 } });

  if (action?.type === 'DISBAND') delete seen[action.unitId];

  const alive: Record<string, [PlayerId, number]> = {};
  for (const u of s.units) {
    const def = s.unitTypes[u.type];
    // 建筑记 0：它消失时不该算成兵力损失（下面的 value===0 判断会跳过）
    alive[u.id] = [u.owner, def?.category === 'building' ? 0 : (def?.cost ?? 0)];
  }

  for (const [id, [side, value]] of Object.entries(seen)) {
    if (alive[id] || value <= 0) continue;
    lost[side].value += value;
    lost[side].count += 1;
  }
  tl.seen = alive;
}

/**
 * 出报告前把内部状态摘掉。
 *
 * `seen` 是"上一次看见的单位 id 表"，几十条、还会随局面变；它留在报告里
 * 既占体积又毫无意义（还让人以为报告里带了单位坐标）。
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

  const a = sideSample(s, 'A');
  const b = sideSample(s, 'B');
  const lost = tl.lost ?? { A: { value: 0, count: 0 }, B: { value: 0, count: 0 } };
  tl.samples.push({
    t: s.turn,
    A: a.line,
    B: b.line,
    va: a.value,
    vb: b.value,
    lostA: lost.A.value,
    lostB: lost.B.value,
    deadA: lost.A.count,
    deadB: lost.B.count,
  });

  if (tl.samples.length > MAX_SAMPLES) {
    // 超了就把所有样本留着、间隔翻倍——只留偶数帧。
    // 直接砍掉最老的会让长局只剩后半段，而"开局怎么崩的"恰恰是最想看的。
    tl.samples = tl.samples.filter((_, i) => i % 2 === 0);
    tl.every = every * 2;
    tl.thinned = true;
  }
}

/** 给报告/界面看的一句话摘要 */
export function timelineSummary(tl: MatchTimeline | null | undefined): string {
  if (!tl || tl.samples.length === 0) return '';
  const first = tl.samples[0];
  const last = tl.samples[tl.samples.length - 1];
  if (!first || !last) return '';
  const kinds = new Set([...Object.keys(tl.made.A), ...Object.keys(tl.made.B)]);
  const bits = [
    `${tl.samples.length} 帧`,
    `第 ${first.t}~${last.t} 回合`,
    `A 方身价 ${first.va}→${last.va}`,
    `B 方身价 ${first.vb}→${last.vb}`,
    `战损 A ${last.lostA} / B ${last.lostB} 金`,
    `${kinds.size} 种兵`,
  ];
  return bits.join(' · ');
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
