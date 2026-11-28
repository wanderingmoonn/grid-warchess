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
export type RoomKind =
  | 'battle'
  | 'elite'
  | 'siege'
  | 'special'
  /** 史线试炼：一场小仗，打赢就把第二层拽到某一支史上 */
  | 'trial'
  | 'event'
  | 'shop'
  | 'rest'
  | 'boss';

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
  /**
   * **解锁一个可选扩展**（道中事件用）。
   *
   * 只接受 `PACK_PLANS` 里 `choosable` 的规则包/联动包；剧情包、系统包与
   * 「无作用」包会被拒绝（`unlockPack` 返回失败原因），不会静默塞进本局。
   * 事件本身还没做，但结算路径已经通了：事件选项写 `effect: { pack: 'trench' }`
   * 就能在事件房里打开「堑壕战」。
   */
  pack?: string;
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
  /** 对"第二层走哪支史"动手：锁定一支，或从此排斥一支 */
  world?: WorldMark;
  /**
   * 按**时代钟**给一个目标世界的兵：钟越靠后，越可能给高代。
   *
   * 写死的"给一个 e3 兵"在钟 8 遇到时太亏；写死 e4 又太赚。这里用
   * `钟 / 10` 当概率抽高代，让同一件事在层内前后位置价值不同。
   */
  addByClock?: { world: WorldId; count: number };
}

/** 事件对史线的标记（见 `Effect.world`） */
export interface WorldMark {
  /** 锁定：第二层必定进入这一支（等价于同时排斥另外三支） */
  lock?: WorldId;
  /** 排斥：第二层不再可以进入这一支 */
  ban?: WorldId;
}

/**
 * 史线试炼：一层里的一场"小仗"，敌人是写死的少量当代兵。
 *
 * 它不是普通战斗——赢了不是拿三选一，而是**把整条历史拽过来**：
 * 第二层锁定 `world`，投降的人直接进队。绕开它，就什么都没发生。
 */
export interface TrialDef {
  id: string;
  world: WorldId;
  title: string;
  sub: string;
  /** 敌方编成（写死、不走预算：试炼要的是"少量但强"的压迫感） */
  enemy: string[];
  /**
   * 敌方修士的境界档位（修真试炼用；1 = 炼气，2 = 筑基）。
   *
   * 修士的属性大头在境界上，光换兵种不换境界，四个人也打不过五个一代兵。
   */
  rank?: number;
  /**
   * 「师兄」的境界：试炼里挑**一个**弟子比其他人高一级。
   *
   * 为什么要这个：DLC 的护甲是 `−1 + r² + 1.5^r`，炼气 +2、筑基 +6——
   * 对 L1 的 e1 兵（攻 10–14）来说，+4 甲就是"每下 8 点"和"每下 4 点"的断崖。
   * 全员炼气太送、全员筑基打不动；一个筑基师兄 + 两个炼气弟子正好有层次。
   */
  seniorRank?: number;
  /** 指定谁当师兄（缺省 = 敌人里最贵的修士；并列时取先列出的） */
  seniorType?: string;
  /** 打赢后投降/缴获的兵（每个 1 个） */
  reward: string[];
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
  /**
   * 史线事件：它提出的不是"拿点什么"，而是"第二层走哪支史"。
   *
   * 已经锁定／排斥了这一支之后，这条事件不再出现（进入时退回普通事件池），
   * 免得玩家在路已经定了之后又被问一次"要不要支持"。
   */
  story?: WorldId;
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
  /** 史线试炼：打谁、赢了谁跟你走（生成房间时就定下来） */
  trial?: TrialDef;
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
  /**
   * 玩家开局勾的**可选扩展**（规则包 + 联动兵种包）。
   *
   * 和战役模式的 `config.expansionIds` 同一个位置：每一关的 `LevelDef.expansions`
   * 会把它作为 `require` 带进去，`createMatch` 按它注册钩子与兵种。
   * 剧情兵种包不在这里——它由第一层的选择决定（见 `world`）。
   */
  packs: string[];
  /** 这一局走的是哪一支史（决定第二层的四种样子） */
  world: WorldId;
  /**
   * **第一层的事件/试炼把这一局钉到哪支史上**；null = 什么都没做 → 正史。
   *
   * 这就是取代「第一层末四选一」的东西：路不是通关时挑的，是一路上
   * "帮了谁、打了谁、没管谁"积出来的。一旦有值，其它史线的钩子全部失效。
   */
  worldLock: WorldId | null;
  /** 已经明确排斥的史线（事件里选"不再可以进入 X"） */
  worldBan: WorldId[];
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
  /**
   * **跨战斗保留的修为**：兵种 id → 经验值（只对修士有意义）。
   *
   * 本体里修士打坐/厮杀都会涨修为，境界（炼气→筑基→金丹……）跟着涨；
   * 但肉鸽每场战斗都是新建一局，那份经验一出战斗就没了。这里把它存下来，
   * 下一场重建修士时再灌回去——「跨战斗保留」就是这一存一灌。
   * 存的是**同类里最高的那个**：队伍里有几个修士时，跟着老兵走。
   */
  cultivation: Record<string, number>;
  /**
   * **上一战留下的伤**：兵种 id → 下一场开局的 hp 比例（0~1）。
   *
   * 以前每场都是满血开打，所以"打得惨"只体现在死人上。现在活下来的人
   * 带着伤进下一场，战后只按比例回一点（`HEAL_PER_BATTLE`），换层才回满。
   */
  wounds: Record<string, number>;
  /**
   * 本层还能救回几个阵亡单位（随军医官）。
   *
   * 每层重置为 2：这场藏品如果按"每战返 1 人"算，一局二十多场就是二十多个人，
   * 等于把"兵力只减不增"这条压力整个抵消掉。给它一个每层的额度，
   * 它才是"这支队伍有人收尸"，而不是"无限补员"。
   */
  reviveLeft: number;
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
  /**
   * 玩家（A 席）有没有城。
   *
   * 2026-11-26 起守城战改成三席：城在**友军 B 席**手里，玩家只作为支援入场，
   * 所以这个字段在守城战里是 false。留着它是给"玩家自己守城"的老关卡。
   */
  playerCity: boolean;
  /** 守城战：友军（B 席）有没有城（有城才有城防、才有"守满 N 轮"的目标） */
  allyCity: boolean;
  /** 守城战：友军自带的守军 */
  allyArmy: ArmyEntry[];
  /** 守城战：友军城边的工事（塔/墙） */
  allyDefense: ArmyEntry[];
  /** 敌方的防御工事：摆在城边 / 阵地上的塔与墙（空数组 = 没有） */
  enemyDefense: ArmyEntry[];
  /** 玩家侧的防御工事（老关卡用；守城战现在归友军） */
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
  /** 全军移动加成（方略 / 临战决议）：所有兵都吃 */
  bonusMove: number;
  /** **只给基础移速 ≤3 的兵**的移动加成（急行靴）：骑兵不吃 */
  bonusMoveSlow: number;
  /** 敌城初始耐久 −N%（0~0.8） */
  cityDamage: number;
  /** 本场临时兵 */
  tempUnits: ArmyEntry[];
  /**
   * 玩家修士的境界（由 `RunState.cultivation` 换算）。
   *
   * 敌人的境界一直用 `rank`（时代钟给的），玩家这一侧现在改成"自己修到几级
   * 就是几级"——修出来的境界可以超过同层的钟。不填就退回 `rank`。
   */
  playerRank?: number;
  /** 跨战斗保留的修为：type → exp（见 `RunState.cultivation`） */
  cultivation?: Record<string, number>;
  /** 上一战留下的伤：type → 开局的 hp 比例（见 `RunState.wounds`） */
  wounds?: Record<string, number>;
  /**
   * 敌方"长老"的兵种 id（`enemyTypes` 里那一个）。
   *
   * 修真世界的合理编成是"一个强的带几个弱的"，而不是一排同境界的修士。
   * 这个兵会被额外加体格与境界，其余修士往下压——见 `buildBattle`。
   */
  elderType?: string;
  /** 史线试炼：普通弟子的境界（未设 = 按 `rank`） */
  trialRank?: number;
  /** 史线试炼：「师兄」的境界与他那一类兵（比普通弟子高一级） */
  trialSeniorRank?: number;
  trialSeniorType?: string;
  /**
   * **中立单位**（不主动攻击、AI 也不打它，但被打会反击）。
   *
   * 实现方式：占一个隐藏席位 C，并把它编进 B 的队里——AI 眼里它是友军，
   * 不会去碰；玩家和它不同队，可以打；它自己永远不行动。
   */
  neutral?: ArmyEntry[];
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
  /** 战后每类兵的平均血量比例（下一场照这个开打） */
  wounds?: Record<string, number>;
  /** 战后每类修士的最高修为（跨战斗保留） */
  cultivation?: Record<string, number>;
}
