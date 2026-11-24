/**
 * 肉鸽试玩版的数据形状。
 *
 * 这一层刻意做得很薄：只描述"一局里有什么"，不描述"引擎怎么算"。
 * 战斗部分一律翻译成规则的 `GameState`（见 battle.ts），所以这里的类型
 * 不会和规则层耦合，日后正式接进去也比较容易替换。
 */
/** 试玩版只做三层；第四层按设计另做，不在本次范围内 */
export type LayerId = 1 | 2 | 3;
import type { WorldId } from './data.ts';
export type { WorldId };

/** 房间种类。注意 boss 不在 20 个房里，它是层末强制战 */
export type RoomKind = 'battle' | 'elite' | 'siege' | 'special' | 'event' | 'shop' | 'rest' | 'boss';

export interface ArmyEntry {
  type: string;
  count: number;
}

/**
 * 一次赌博：按概率落到两个效果之一。
 *
 * 事件里用它做"押一把"的选项——这是事件和临战决议最明显的区别之一：
 * 决议是**这一仗怎么打**（确定、只影响一场），事件是**这一趟值不值**（有输有赢、影响整局）。
 */
export interface RiskEffect {
  chance: number;
  win: Effect;
  lose?: Effect;
  winText: string;
  loseText: string;
}

/** 事件/休整/奖励的结算效果。全部是加法，没有"持续到战斗结束"以外的复杂状态 */
export interface Effect {
  gold?: number;
  /** 加兵：type + count。type 可以是 layer-low / layer-mid / layer-high */
  add?: ArmyEntry;
  /** 减兵：同上，type 支持 layer-* */
  remove?: ArmyEntry;
  /** 给一件藏品（id） */
  relic?: string;
  /** 下一场战斗我军攻击加成（可叠加，战后清零） */
  nextAtk?: number;
  /** 下一场战斗我军护甲加成 */
  nextArmor?: number;
  /** 下一场战斗我军最大生命加成 */
  nextHp?: number;
  /** 立刻把 n 个最低级兵换成同层的高一档兵 */
  promote?: number;
  /** 按概率分成两岔 */
  risk?: RiskEffect;
}

/** 攒到下一场战斗的一次性加成（休整 / 事件 / 临战决议都往这里投） */
export interface Buffs {
  atk: number;
  armor: number;
  hp: number;
  move: number;
  /** 本场敌人少几个 */
  enemyCut: number;
  /** 敌城初始耐久 −N% */
  cityDamage: number;
  /** 敌方工事初始耐久 −N% */
  defenseDamage: number;
  /** 敌军开场掉 N% 血 */
  enemyHp: number;
  /** 本场临时兵（打完还在就带走） */
  tempUnits: number;
}

export interface EventChoice {
  label: string;
  hint?: string;
  effect: Effect;
}

export interface EventDef {
  id: string;
  title: string;
  body: string;
  choices: EventChoice[];
}

export interface RoomNode {
  kind: RoomKind;
  title: string;
  sub: string;
  /** 事件房指向事件池里的一条 */
  eventId?: string;
  /**
   * 守城战的东家：帮谁守、守完给谁家的兵。
   *
   * 生成房间时就定下来（那时已经知道这一层是哪个世界），战斗本身不需要它，
   * 战利品要用它——所以存在节点上，而不是战后再随机一次。
   */
  special?: { faction: number; name: string; unit: string };
}

export interface LayerPlan {
  /** 10 步，每步 2 扇门 */
  steps: RoomNode[][];
}

export interface RewardOption {
  id: string;
  title: string;
  sub: string;
  effect: Effect;
}

export interface RunOver {
  win: boolean;
  title: string;
  body: string;
}

export interface RunState {
  seed: number;
  strategyId: string;
  /** 这一局走的是哪一支史（第一层末选，决定第二层的四种样子） */
  world: WorldId;
  layer: LayerId;
  /** 已完成的步数；等于 10 时该打层末 boss */
  step: number;
  gold: number;
  army: ArmyEntry[];
  relics: string[];
  plan: LayerPlan;
  /** 时代钟：本层已进的房间数（回头不计，试玩版没有回头） */
  clock: number;
  /** 下一场战斗的加成（战后清零） */
  buffs: Buffs;
  /** 本层的 boss 已经打过 */
  bossDone: boolean;
  log: string[];
  over: RunOver | null;
}

/** 一场战斗的输入：全部由 RunState 翻译过来，战斗层不读 RunState */
export interface BattleInit {
  kind: RoomKind;
  layer: LayerId;
  label: string;
  sub: string;
  size: number;
  /** 敌人的时代（层末用高代） */
  era: number;
  /** 我方的城时代（玩家没有城，这个值只用来决定"我方兵能到几代"） */
  cityEra: number;
  playerArmy: ArmyEntry[];
  playerGold: number;
  /**
   * 敌方有几座城。
   * 0 = 遭遇/精英（双方无城，兵打光算输）；1~2 = 攻坚/层末（要啃城）。
   * 玩家只有守城战（special）才有城，所以这一项仍然是敌方的。
   */
  enemyCityCount: 0 | 1 | 2;
  /** 玩家有没有城（只有守城战有：你要守的就是它） */
  playerCity: boolean;
  /** 敌方的防御工事：摆在城边 / 阵地上的塔与墙（空数组 = 没有） */
  enemyDefense: ArmyEntry[];
  /** 玩家侧的防御工事（守城战给一座塔一段墙） */
  playerDefense: ArmyEntry[];
  /** 守城战：守住这么多轮就算赢（0 = 不是守城战） */
  holdRounds: number;
  /** 守城战的波次：第 N 轮开始时到场（第 1 波就是 enemyTypes，不在这里） */
  waves: Array<{ atRound: number; types: string[] }>;
  /** 敌军开场带伤（0~0.8） */
  enemyDamage: number;
  /** 防御工事开场带伤（0~0.8） */
  defenseDamage: number;
  /** 防御工事的数值缩放（奇想/修真的建筑偏弱，按世界放大） */
  defenseScale?: { atk: number; hp: number };
  enemyTypes: string[];
  enemyGold: number;
  /** 敌方这一场最多补几个兵（有城的关才给） */
  enemyRecruit: number;
  /** 敌方的打法：遭遇/精英抢攻，攻坚/层末守城 */
  enemyDoctrine: 'rush' | 'boom';
  /** 这一局要开的扩展（第 6 代要「信息化」；第二层还要开该世界的包） */
  expansions: string[];
  /** 世界（第二层主题）；第一层是 base */
  world: WorldId;
  /** 修真：这一场修士的境界档位（0 = 不适用） */
  rank: number;
  /** 我军加成（已按藏品/方略/决议合好） */
  bonusAtk: number;
  bonusArmor: number;
  bonusHp: number;
  bonusMove: number;
  /** 敌城初始耐久 −N%（0~0.8） */
  cityDamage: number;
  /** 本场临时兵 */
  tempUnits: ArmyEntry[];
  relics: string[];
  strategyId: string;
  seed: number;
  /** 回合上限（轮）。超时判负——试玩版不让一场仗拖成半小时 */
  roundLimit: number;
}

export interface BattleResult {
  win: boolean;
  /** 幸存的我军（type → count） */
  survivors: ArmyEntry[];
  /** 打完时还剩多少金（战场里造兵花掉的要扣回去） */
  gold: number;
  turns: number;
}
