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
export type RoomKind = 'battle' | 'elite' | 'siege' | 'event' | 'shop' | 'rest' | 'boss';

export interface ArmyEntry {
  type: string;
  count: number;
}

/** 事件/休整/奖励的结算效果。全部是加法，没有"持续到战斗结束"以外的复杂状态 */
export interface Effect {
  gold?: number;
  /** 加兵：type + count。type 可以是 layer-low / layer-mid / layer-high */
  add?: ArmyEntry;
  /** 给一件藏品（id） */
  relic?: string;
  /** 下一场战斗我军攻击加成（可叠加，战后清零） */
  nextAtk?: number;
  /** 下一场战斗我军护甲加成 */
  nextArmor?: number;
  /** 下一场战斗我军最大生命加成 */
  nextHp?: number;
  /** 立刻把 n 个最低级兵换成同层的高一档兵（简化：直接加高级兵、扣低级兵） */
  promote?: number;
}

/** 攒到下一场战斗的一次性加成（休整 / 事件 / 临战决议都往这里投） */
export interface Buffs {
  atk: number;
  armor: number;
  hp: number;
  /** 本场敌人少几个 */
  enemyCut: number;
  /** 敌城初始耐久 −N% */
  cityDamage: number;
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
   * 玩家在 L1–L3 一律 0 座（设计如此），所以没有这个字段。
   */
  enemyCityCount: 0 | 1 | 2;
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
