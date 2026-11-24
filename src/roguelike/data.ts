/**
 * 肉鸽 2.0 的全部内容数据。
 *
 * 设计原则：**内容可以少，但必须成"池"**——事件、奖励、商店货、敌人编成
 * 都是按池随机抽的，这样才能验证"同一套流程跑出不同局"。
 * 正式版把这些表换成文档里的几十条内容即可，代码不用动。
 *
 * 加东西只需要改这一页：
 *   · 加藏品 → `RELICS` 里加一行，效果字段见 `types.ts` 的 `Effect`；
 *     真正生效的地方在 `battle.ts` 的加成段和 `run.ts` 的层推进。
 *   · 加事件 → `EVENTS` 里加一条，选项效果同样是 `Effect`。
 *   · 加休整选项 → `REST_OPTIONS` 加一行，`run.ts` 的 `restOptions` 认 id。
 */
import type { LayerId, EventDef, ArmyEntry } from './types.ts';

/** 兵种中文名 */
export const UNIT_NAME: Record<string, string> = {
  militia: '民兵',
  archer: '弓手',
  scout: '斥候',
  ge: '戈兵',
  spearman: '长枪兵',
  longbow: '长弓手',
  knight: '骑士',
  crossbow: '弩兵',
  musketeer: '火枪兵',
  mortar: '臼炮',
  halberdier: '戟兵',
  hussar: '骠骑兵',
  rifleman: '步枪兵',
  mg: '机枪队',
  armoredcar: '装甲车',
  hmg: '重机枪组',
  squad: '步兵班',
  tank: '坦克',
  artillery: '榴弹炮',
  ct_infantry: '摩托化步兵',
  ct_tank: '中型坦克',
  ct_howitzer: '自行榴弹炮',
  ct_recon: '装甲侦察车',
};

export function unitName(id: string): string {
  return UNIT_NAME[id] ?? id;
}

/**
 * 时代规划（与设计文档一致）：
 *   L1 = 第 1–2 代　L2 = 第 3–4 代　L3 = 第 5–6 代
 * 城跟着低代走（1 / 3 / 5），层末敌人用高代（2 / 4 / 6）。
 */
export interface LayerTheme {
  id: LayerId;
  name: string;
  subtitle: string;
  /** 本层低代（开局）/ 高代（层末） */
  eraLow: number;
  eraHigh: number;
  /** 开局（时代钟靠前）的敌人兵池 */
  pool: string[];
  /** 时代钟靠后 / 层末的敌人兵池 */
  poolHigh: string[];
  /** 这一层要开哪些扩展（第 6 代要「信息化」解锁，它没有规则钩子） */
  expansions: string[];
  /** 地图边长：遭遇 / 精英 / 攻坚 / boss */
  size: readonly [number, number, number, number];
  /** 层末 boss 的候选 */
  bosses: ReadonlyArray<{ title: string; sub: string }>;
  /** 本层把旧兵换成什么（进层时统一换装，见 run.ts 的 `refitArmy`） */
  refit: Record<string, string>;
}

export const LAYERS: Record<LayerId, LayerTheme> = {
  1: {
    id: 1,
    name: '第一层 · 旧垒',
    subtitle: '墙还站在那儿，人已经换过三茬',
    eraLow: 1,
    eraHigh: 2,
    pool: ['militia', 'archer', 'scout', 'ge'],
    poolHigh: ['spearman', 'longbow', 'crossbow', 'knight'],
    expansions: [],
    size: [8, 10, 12, 14],
    bosses: [
      { title: '守墙人的土垣', sub: '他守的不是城，是"这里归谁"这件事' },
      { title: '持秤者的货栈', sub: '账本比城墙厚，也比特么城墙硬' },
      { title: '守钟人的石龛', sub: '钟还没响，他先站到了门口' },
    ],
    refit: {},
  },
  2: {
    id: 2,
    name: '第二层 · 商道',
    subtitle: '同一条路，昨天运粮，今天运兵',
    eraLow: 3,
    eraHigh: 4,
    pool: ['musketeer', 'halberdier', 'hussar', 'mortar'],
    poolHigh: ['rifleman', 'mg', 'armoredcar'],
    expansions: [],
    size: [10, 12, 14, 16],
    bosses: [
      { title: '守墙人的棱堡', sub: '墙学会了拐弯，人就学会了绕路' },
      { title: '持秤者的商埠', sub: '你打下的每一寸地，他都算过价' },
      { title: '守钟人的修道院', sub: '院里不敲钟了，改抄账' },
    ],
    refit: {
      militia: 'halberdier',
      ge: 'halberdier',
      spearman: 'halberdier',
      archer: 'musketeer',
      longbow: 'musketeer',
      crossbow: 'musketeer',
      scout: 'hussar',
      knight: 'hussar',
    },
  },
  3: {
    id: 3,
    name: '第三层 · 钟楼',
    subtitle: '三家的旗都挂在同一座楼上，谁也不敢先摘',
    eraLow: 5,
    eraHigh: 6,
    pool: ['hmg', 'squad', 'tank', 'artillery'],
    poolHigh: ['ct_infantry', 'ct_tank', 'ct_howitzer', 'ct_recon'],
    expansions: ['pack-contemporary'],
    size: [12, 14, 16, 18],
    bosses: [{ title: '钟楼', sub: '三家共守的地方——谁都不能让你砸这口钟' }],
    refit: {
      militia: 'squad',
      ge: 'squad',
      spearman: 'squad',
      halberdier: 'squad',
      musketeer: 'hmg',
      archer: 'hmg',
      longbow: 'hmg',
      crossbow: 'hmg',
      scout: 'tank',
      knight: 'tank',
      hussar: 'tank',
      mortar: 'artillery',
      rifleman: 'hmg',
      mg: 'hmg',
      armoredcar: 'tank',
    },
  },
};

/** 方略：开局身份 + 一条被动。被动在 battle.ts 里翻译成具体加成 */
export interface Strategy {
  id: string;
  name: string;
  sub: string;
  army: ArmyEntry[];
  passive: string;
}

export const STRATEGIES: Strategy[] = [
  {
    id: 'frontier',
    name: '边军',
    sub: '长年守边的一营，人不多，阵不散',
    army: [
      { type: 'ge', count: 3 },
      { type: 'spearman', count: 1 },
      { type: 'archer', count: 2 },
    ],
    passive: '我军全体护甲 +1',
  },
  {
    id: 'skirmish',
    name: '射手',
    sub: '不与人贴身，只与人比谁的箭先到',
    army: [
      { type: 'archer', count: 3 },
      { type: 'militia', count: 3 },
      { type: 'scout', count: 1 },
    ],
    passive: '我军远程单位（射程 ≥3）攻击 +2',
  },
  {
    id: 'horse',
    name: '骑军',
    sub: '来得快，走得也快，只剩你追不上',
    army: [
      { type: 'scout', count: 2 },
      { type: 'knight', count: 1 },
      { type: 'militia', count: 3 },
    ],
    passive: '我军全体移动 +1',
  },
];

export function strategyById(id: string): Strategy {
  return STRATEGIES.find((s) => s.id === id) ?? (STRATEGIES[0] as Strategy);
}

/**
 * 藏品。
 *
 * 效果字段（都在 `types.ts` 的 `Effect` 里）：
 *   atk / move / armor / hp   我军全体加成（战斗开始时套到兵种变体上）
 *   enemyCut                  本场敌人少几个兵
 *   cityDamage                本场敌城初始耐久 −N%
 *   goldPerLayer              每层开始 +N 金
 *   unitPerLayer              每层开始 +N 个本层基础兵
 *   shopOff                   商店价格折扣（0~1）
 *   revive                    战斗后返还 N 个阵亡单位
 */
export interface Relic {
  id: string;
  name: string;
  desc: string;
  effect: {
    atk?: number;
    move?: number;
    armor?: number;
    hp?: number;
    enemyCut?: number;
    cityDamage?: number;
    goldPerLayer?: number;
    unitPerLayer?: number;
    shopOff?: number;
    revive?: number;
  };
}

export const RELICS: Relic[] = [
  { id: 'forge', name: '铁匠铺', desc: '我军全体攻击 +1', effect: { atk: 1 } },
  { id: 'boots', name: '急行靴', desc: '我军全体移动 +1', effect: { move: 1 } },
  { id: 'armorplate', name: '铁甲', desc: '我军全体护甲 +1', effect: { armor: 1 } },
  { id: 'rampart', name: '壁垒图', desc: '我军全体最大生命 +6', effect: { hp: 6 } },
  { id: 'scoutnet', name: '斥候网', desc: '每场战斗敌人少 1 个兵', effect: { enemyCut: 1 } },
  { id: 'powder', name: '火药桶', desc: '攻坚与层末：敌城初始耐久 −30%', effect: { cityDamage: 0.3 } },
  { id: 'purse', name: '军饷袋', desc: '每层开始 +90 金', effect: { goldPerLayer: 90 } },
  { id: 'ration', name: '军粮袋', desc: '每层开始 +1 个本层基础兵', effect: { unitPerLayer: 1 } },
  { id: 'marchmap', name: '行军图', desc: '商店价格 −20%', effect: { shopOff: 0.2 } },
  { id: 'medic', name: '随军医官', desc: '战斗结束后返还 1 个阵亡单位', effect: { revive: 1 } },
];

export function relicById(id: string): Relic | undefined {
  return RELICS.find((r) => r.id === id);
}

/** 事件池：每次进普通事件房从这里随机抽一条 */
export const EVENTS: EventDef[] = [
  {
    id: 'levy',
    title: '征兵令',
    body: '里正把名册摊在你面前。名字比粮多，粮比人少。他说：抽几个吧，反正明年还得抽。',
    choices: [
      { label: '按册抽丁', hint: '民兵 ×2，−30 金', effect: { add: { type: 'militia', count: 2 }, gold: -30 } },
      { label: '只征粮', hint: '+70 金', effect: { gold: 70 } },
      { label: '把册子还给他', hint: '下一战攻击 +2', effect: { nextAtk: 2 } },
    ],
  },
  {
    id: 'ruins',
    title: '烧过的庄子',
    body: '半个村子没了，另外半个还没决定要不要没。有人在灰里翻东西，有人在门口坐着。',
    choices: [
      { label: '搜能用的', hint: '+90 金', effect: { gold: 90 } },
      { label: '收拢散兵', hint: '弓手 ×1', effect: { add: { type: 'archer', count: 1 } } },
      { label: '帮着埋人', hint: '下一战攻击 +3', effect: { nextAtk: 3 } },
    ],
  },
  {
    id: 'caravan',
    title: '过路的商队',
    body: '车上有布、有盐、还有几箱说不清来路的东西。掌柜的看见你的旗，笑得很客气。',
    choices: [
      { label: '买他的货', hint: '−120 金，得 1 件藏品', effect: { gold: -120, relic: 'random' } },
      { label: '照价收税', hint: '+140 金', effect: { gold: 140 } },
      { label: '让他过去', hint: '+20 金', effect: { gold: 20 } },
    ],
  },
  {
    id: 'oldfield',
    title: '旧战场',
    body: '两年前这里打过一场，现在草长得很好。兵器还插在土里，像谁忘了收。',
    choices: [
      { label: '捡兵器', hint: '得 1 个本层兵', effect: { add: { type: 'layer-mid', count: 1 } } },
      { label: '找那面旗', hint: '下一战攻击 +2', effect: { nextAtk: 2 } },
      { label: '什么都不动', hint: '+40 金', effect: { gold: 40 } },
    ],
  },
  {
    id: 'bell',
    title: '钟楼的影子',
    body: '太阳落下去的时候，远处那座楼的影子刚好盖到你脚边。老兵说：别在那儿站着。',
    choices: [
      { label: '敲一下', hint: '得 1 件藏品', effect: { relic: 'random' } },
      { label: '移开眼', hint: '+60 金', effect: { gold: 60 } },
    ],
  },
  {
    id: 'three',
    title: '三家的账房',
    body: '账房先生把三本账并排放着，说：哪家都行，只要押得准。他连笔都替你备好了。',
    choices: [
      { label: '借兵', hint: '−80 金，得 1 个本层高级兵', effect: { gold: -80, add: { type: 'layer-high', count: 1 } } },
      { label: '卖情报', hint: '+110 金', effect: { gold: 110 } },
      { label: '不欠人情', hint: '下一战攻击 +1', effect: { nextAtk: 1 } },
    ],
  },
  {
    id: 'stragglers',
    title: '溃兵',
    body: '二十来个人蹲在沟里，旗扔了，甲还在。领头的不敢看你，只说：给口饭，跟你走。',
    choices: [
      { label: '收编', hint: '得 2 个本层基础兵', effect: { add: { type: 'layer-low', count: 2 } } },
      { label: '拿走他们的甲', hint: '下一战我军护甲 +2', effect: { nextArmor: 2 } },
      { label: '指条路让他们走', hint: '+60 金', effect: { gold: 60 } },
    ],
  },
  {
    id: 'ferry',
    title: '渡口',
    body: '摆渡的老头一天只跑两趟。他说：兵过河，船就沉。要过，得加钱。',
    choices: [
      { label: '给钱', hint: '−50 金，下一战攻击 +3', effect: { gold: -50, nextAtk: 3 } },
      { label: '抢船', hint: '得 1 个本层兵，+20 金', effect: { add: { type: 'layer-mid', count: 1 }, gold: 20 } },
      { label: '绕路', hint: '下一战我军最大生命 +6', effect: { nextHp: 6 } },
    ],
  },
  {
    id: 'shrine',
    title: '路边的祭坛',
    body: '石头垒的，不知道供的是谁。供品还在，说明这附近已经没人敢来拿了。',
    choices: [
      { label: '上供', hint: '−60 金，得 1 件藏品', effect: { gold: -60, relic: 'random' } },
      { label: '把供品拿走', hint: '+100 金', effect: { gold: 100 } },
      { label: '拜一拜就走', hint: '下一战我军护甲 +1', effect: { nextArmor: 1 } },
    ],
  },
];

export function eventById(id: string): EventDef {
  return EVENTS.find((e) => e.id === id) ?? (EVENTS[0] as EventDef);
}

/** 休整房的选项池（每次随机抽 3 个） */
export interface RestOption {
  id: string;
  label: string;
  hint: string;
}

export const REST_OPTIONS: RestOption[] = [
  { id: 'reinforce', label: '补员', hint: '得 1 个本层基础兵' },
  { id: 'wage', label: '募饷', hint: '+90 金' },
  { id: 'drill', label: '演武', hint: '下一战我军攻击 +2' },
  { id: 'harden', label: '加固', hint: '下一战我军最大生命 +6' },
  { id: 'recruit', label: '征召', hint: '−80 金，得 1 个本层高级兵' },
];

/** 临战决议：层末 boss 前抽 3 个给玩家选 1 个 */
export interface DecisionOption {
  id: string;
  label: string;
  hint: string;
  /** 立刻扣的钱（不够就不能选） */
  cost?: number;
  /** 本场加成 */
  atk?: number;
  hp?: number;
  armor?: number;
  enemyCut?: number;
  cityDamage?: number;
  /** 本场临时兵（本层基础兵） */
  tempUnits?: number;
}

export const DECISIONS: DecisionOption[] = [
  { id: 'night', label: '夜袭', hint: '本场我军攻击 +2', atk: 2 },
  { id: 'press', label: '强攻', hint: '本场我军最大生命 +8', hp: 8 },
  { id: 'bribe', label: '买通', hint: '−120 金，本场敌人少 2 个兵', cost: 120, enemyCut: 2 },
  { id: 'levy', label: '就地征召', hint: '本场多 2 个基础兵（活下来就带走）', tempUnits: 2 },
  { id: 'sappers', label: '工兵破墙', hint: '本场敌城初始耐久 −40%', cityDamage: 0.4 },
];

/** 房间标题里用的地名，纯装饰 */
export const PLACE_NAMES: Record<LayerId, string[]> = {
  1: ['北坡', '干河沟', '旧驿', '断桥', '石堆', '西口'],
  2: ['盐道', '车马店', '税卡', '渡口', '货场', '关隘'],
  3: ['钟楼前街', '铁厂', '轨道站', '电报房', '市政厅', '钟塔下'],
};

/** 敌方编成：按"预算"从池子里抓兵，尽量买贵的（但不超支） */
export function pickEnemyTypes(pool: string[], budget: number, cost: (id: string) => number): string[] {
  const sorted = [...pool].sort((a, b) => cost(b) - cost(a));
  const out: string[] = [];
  let left = budget;
  for (const id of sorted) {
    const c = cost(id);
    if (c <= 0) continue;
    while (left >= c && out.length < 14) {
      out.push(id);
      left -= c;
    }
  }
  if (out.length === 0 && sorted.length > 0) out.push(sorted[sorted.length - 1] as string);
  return out;
}
