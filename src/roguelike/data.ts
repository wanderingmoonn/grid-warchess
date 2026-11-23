/**
 * 肉鸽试玩版的全部内容数据。
 *
 * 设计原则：**内容可以少，但必须成"池"**——事件、奖励、商店货、敌人编成
 * 都是按池随机抽的，这样才能验证"同一套流程跑出不同局"。
 * 正式版把这些表换成文档里的几十条内容即可，代码不用动。
 */
import type { LayerId, EventDef, ArmyEntry } from './types.ts';

/** 兵种中文名（试玩版只用到原版 e1–e4 的地面兵，不引入任何扩展包） */
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
};

export function unitName(id: string): string {
  return UNIT_NAME[id] ?? id;
}

/** 每层的主题、可用兵池、敌方主力的时代 */
export interface LayerTheme {
  id: LayerId;
  name: string;
  subtitle: string;
  /** 本层低代（开局）/ 高代（层末） */
  eraLow: number;
  eraHigh: number;
  /** 本层敌人与奖励可能出现的兵种 */
  pool: string[];
  /** 地图边长：遭遇 / 精英 / 攻坚 / boss（时代越高略大一点） */
  size: readonly [number, number, number, number];
  /** 层末 boss 的候选（名字 + 一句话） */
  bosses: ReadonlyArray<{ title: string; sub: string }>;
}

export const LAYERS: Record<LayerId, LayerTheme> = {
  1: {
    id: 1,
    name: '第一层 · 旧垒',
    subtitle: '墙还站在那儿，人已经换过三茬',
    eraLow: 1,
    eraHigh: 2,
    // 第一层只用第一代：玩家的方略里带着一两个第二代兵，那点代差就是开局的甜头
    pool: ['militia', 'archer', 'scout', 'ge'],
    // 遭遇 / 精英 / 攻坚 / 层末。遭遇战是短兵相接，8×8 足够
    size: [8, 10, 12, 14],
    bosses: [
      { title: '守墙人的土垣', sub: '他守的不是城，是"这里归谁"这件事' },
      { title: '持秤者的货栈', sub: '账本比城墙厚，也比特么城墙硬' },
      { title: '守钟人的石龛', sub: '钟还没响，他先站到了门口' },
    ],
  },
  2: {
    id: 2,
    name: '第二层 · 商道',
    subtitle: '同一条路，昨天运粮，今天运兵',
    eraLow: 2,
    eraHigh: 3,
    // 第二层只放第二代：玩家到这一层手上大半还是第一代，敌人不该直接上第三代
    pool: ['spearman', 'longbow', 'crossbow', 'knight'],
    size: [10, 12, 14, 16],
    bosses: [
      { title: '守墙人的棱堡', sub: '墙学会了拐弯，人就学会了绕路' },
      { title: '持秤者的商埠', sub: '你打下的每一寸地，他都算过价' },
      { title: '守钟人的修道院', sub: '院里不敲钟了，改抄账' },
    ],
  },
  3: {
    id: 3,
    name: '第三层 · 钟楼',
    subtitle: '三家的旗都挂在同一座楼上，谁也不敢先摘',
    eraLow: 3,
    eraHigh: 4,
    pool: ['musketeer', 'halberdier', 'hussar', 'mortar'],
    size: [12, 14, 16, 18],
    bosses: [{ title: '钟楼', sub: '三家共守的地方——谁都不能让你砸这口钟' }],
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
    passive: '我军城的耐久 +20',
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

/** 藏品 */
export interface Relic {
  id: string;
  name: string;
  desc: string;
}

export const RELICS: Relic[] = [
  { id: 'forge', name: '铁匠铺', desc: '我军全体攻击 +1' },
  { id: 'boots', name: '急行靴', desc: '我军全体移动 +1' },
  { id: 'purse', name: '军饷袋', desc: '每层开始 +90 金' },
  { id: 'rampart', name: '城防图', desc: '我军城的耐久 +25' },
  { id: 'medic', name: '随军医官', desc: '战斗结束后返还 1 个阵亡单位' },
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
];

export function eventById(id: string): EventDef {
  return EVENTS.find((e) => e.id === id) ?? (EVENTS[0] as EventDef);
}

/** 休整房的选项池（每次随机抽 3 个） */
export interface RestOption {
  id: string;
  label: string;
  hint: string;
  effect: 'reinforce' | 'wage' | 'drill';
}

export const REST_OPTIONS: RestOption[] = [
  { id: 'reinforce', label: '补员', hint: '得 1 个本层基础兵', effect: 'reinforce' },
  { id: 'wage', label: '募饷', hint: '+90 金', effect: 'wage' },
  { id: 'drill', label: '演武', hint: '下一战我军攻击 +2', effect: 'drill' },
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
  // 预算花不尽（最便宜的都买不起）时至少给一个，别让敌人空场
  if (out.length === 0 && sorted.length > 0) out.push(sorted[sorted.length - 1] as string);
  return out;
}
