/**
 * 全局类型定义。
 *
 * 设计原则：GameState 必须是可以 JSON.stringify 的纯数据，
 * 不含函数、DOM 引用、时间戳等不可序列化内容。
 * 这样存档、回放、联机、AI 都能直接复用同一份结构。
 */

export type PlayerId = 'A' | 'B';

/** null 表示仍在进行；draw 是已经结束的平局。 */
export type MatchWinner = PlayerId | 'draw' | null;
export type ResultReason = 'conquest' | 'turn-limit' | 'no-cities' | 'legacy';

/** 全部产兵点共用的本回合成功生产次数，随存档和联机状态保存。 */
export interface TurnProduction {
  turn: number;
  player: PlayerId;
  recruited: number;
  upgraded: number;
  /** v4 缺少可靠生产记录，迁移时封存当前指挥官回合，交接后解除。 */
  legacyLocked?: boolean;
}

export type Terrain = 'plain' | 'forest' | 'hill' | 'water' | 'mountain' | 'bridge' | 'city';

/** 行动域：陆军只能走陆地，水军只能走水面 */
export type UnitDomain = 'land' | 'water';

export interface Tile {
  terrain: Terrain;
  /** 属于哪座城市；非城市格为 null */
  cityId: string | null;
}

export type UnitCategory = 'combat' | 'economy' | 'builder' | 'building';

export interface UnitTypeDef {
  id: string;
  name: string;
  /** 棋盘上显示的单字图标 */
  short: string;
  /** 需要城市达到哪个时代才能生产 */
  era: number;
  /** 战斗单位 / 经济单位 / 建筑 */
  category: UnitCategory;
  cost: number;
  /** 移动力；0 表示不可移动（建筑） */
  move: number;
  atk: number;
  /** 护甲：伤害 = 攻击 - 护甲，直接相减，没有系数 */
  armor: number;
  maxHp: number;
  /** 攻击射程（格，曼哈顿距离） */
  range: number;
  /**
   * 溅射半径：主目标周围的敌人也吃一份伤害。
   * 火药时代的炮就是这么干活的——打的是"一片"，不是"一个"。
   */
  splash?: number;
  /**
   * 多段攻击：一次攻击结算几下，每一下**单独**减一次护甲。
   * 机枪的定位就是靠这个：打轻甲是一串数字，打重甲全被挡回来。
   */
  burst?: number;
  /** 视野半径 */
  vision: number;
  /** 固定每回合收入 */
  income?: number;
  /**
   * 按所在地形给出的每回合收入。
   * 有这张表的经济单位必须"站对地方"才赚钱——农民在平原富、牧民在丘陵富。
   */
  incomeByTerrain?: Partial<Record<Terrain, number>>;
  /** 每回合自动对射程内最近的敌人开火（建筑用） */
  autoAttack?: boolean;
  /**
   * 这个单位能建造哪些建筑（建筑 id 列表）。
   * 建筑不再凭空出现在地图上，必须由建造单位走过去盖。
   */
  builds?: string[];
  /** 特殊能力 id 列表，见 abilities.ts */
  abilities?: string[];
  /**
   * 行动域。缺省是 land。
   * water 单位只能待在水面格上（进不了城、上不了岸），
   * 只能在临水的城市生产。
   */
  domain?: UnitDomain;
  /**
   * 这类建筑是架在水面上的桥：那一格会变成可通行的桥面。
   * 桥是双向的——谁都能从上面过（当然，也谁都能把它打塌）。
   */
  bridges?: boolean;
  /**
   * 这类建筑是军营：能像城市一样出兵，但自己没有科技，
   * 用的是最近己方城市的时代。
   */
  barracks?: boolean;
  /**
   * 地形要求：只能建在这些地形上。缺省表示"任何可通行地形"。
   * 军营要平地或丘陵，桥要水面。
   */
  buildOn?: Terrain[];
  /**
   * 运输单位：能把相邻的陆军装进货舱运过水面。
   * 它自己不打架（atk 0），存在的意义就是"让陆军过河"。
   */
  transport?: boolean;
  /** 货舱容量（transport 用） */
  capacity?: number;
  /**
   * 必须紧邻水域才能建（军营靠水补给）。
   *
   * 单靠 buildOn 表达不了这条：它说的是"脚下这块地是什么"，
   * 而"旁边有没有水"是邻居的事。所以单独开一个布尔开关，
   * 而不是把判断硬塞进 doBuild——数据驱动，才能被 UI 和 AI 复用。
   */
  requiresWater?: boolean;
}

/**
 * 城市是一个独立实体，占 size × size 个格子。
 *
 * 为什么不把城市塞进 Tile：城市有自己的血条和护甲，
 * 是一个可以被攻击、会易主的对象。绑在格子上会导致
 * "4 个格子各自记一份血条"这种荒唐事。
 *
 * era（时代）也是城市自己的属性：每座城独立升级，
 * 升级后这座城能造更高级的兵，自身耐久和护甲也变强。
 */
export interface City {
  id: string;
  /** 左上角格坐标 */
  x: number;
  y: number;
  /** 边长，目前固定 2 */
  size: number;
  owner: PlayerId;
  /** 时代等级，从 1 开始 */
  era: number;
  hp: number;
  maxHp: number;
  armor: number;
  /**
   * 这座城是在第几回合被打下来的。
   *
   * 刚攻陷的城市当回合不能出兵：否则攻方打下一座城，转身就用这座城的产线
   * 补一支兵出来，一座城的陷落等于白送一支部队，攻城反而成了"补员"。
   * 存档里没有这个字段时（旧存档）按"早就归我了"处理。
   */
  capturedTurn?: number;
}

export interface Unit {
  id: string;
  type: string;
  owner: PlayerId;
  x: number;
  y: number;
  hp: number;
  /** 累计击杀数，给"老兵"这类扩展规则用；不开扩展就是纯装饰 */
  kills: number;
  /** 本回合移动力已耗尽 */
  moved: boolean;
  /** 本回合已攻击 */
  acted: boolean;
  /**
   * 货舱：被这条船载着的单位。
   *
   * 上船的单位**从棋盘上的 s.units 里拿掉**，整个对象存在这里。
   * 这样"船上的人不算占格、不吃攻击、不受地形影响"全都是自动的，
   * 不用去改每个遍历 units 的地方（那是几十处，必漏）。
   * 代价是船沉的时候这些人一起没了——沉船本来就该是这个结果。
   */
  cargo?: Unit[];
}

/** AI 的思考深度：初级只求推进，高级会算威胁和交换比 */
export type AiLevel = 'basic' | 'advanced';

/**
 * 一局对战的配置。
 *
 * 只存"选择了什么"，不存"规则怎么算"：
 * 扩展规则是代码模块，配置里只有 id。这样存档能序列化、能回放、
 * 换台机器打开结果也一致。
 */
export interface MatchConfig {
  /** 棋盘边长（正方形） */
  size: number;
  /** 开局城市的时代等级（1-5），用来缩短或拉长一局的节奏 */
  startEra: number;
  /** B 方是否由 AI 接管 */
  aiOpponent: boolean;
  /** A 方是否也由 AI 接管（双 AI 观战，用来观察平衡） */
  aiAlly: boolean;
  /**
   * AI 的思考深度。
   *
   * basic    —— 老版本的打分：只看"往前走多远"，不考虑对面能打到哪。
   * advanced —— 额外带上威胁图、换子价值评估、兵种搭配和更窄的随机带宽。
   *
   * 两者共用同一套地形/架桥/补兵逻辑，区别只在打分那几项：
   * 修正过的"卡死兵种不招""远程不顶脸"之类是缺陷修复，不是难度，
   * 所以两边都有。老存档没有这个字段时按 advanced 处理。
   */
  aiLevel?: AiLevel;
  /**
   * 指挥官模式：玩家不亲自走子，只排"接下来几个回合造什么"，
   * 建造、移动、攻击、升级全部交给 AI。
   *
   * 注意它和 aiOpponent / aiAlly 是两回事：那两个说的是"谁被托管"，
   * 这个说的是"人被托管到什么程度"。指挥官模式下 A 方仍然等人操作，
   * 只是等的是"下达生产序列"而不是"走子"。
   */
  commanderMode?: boolean;
  /** 地貌风格：random 由种子抽；也可以指定横河 / 纵河 / 山岭 / 开阔 */
  mapStyle?: 'random' | 'river-h' | 'river-v' | 'ridge' | 'open';
  /** 地形对称方式：fair = 两侧配额相同分布不同（默认）；mirror = 完全镜像 */
  mapSymmetry?: 'fair' | 'mirror';
  /**
   * 后手（B）开局金币补偿比例的**临时覆盖**，默认 0 = 不覆盖。
   *
   * 正式规则是「先后手补偿」扩展（按棋盘边长给：12×12 补 20%、16×16 补 5%）。
   * 这个旋钮只给跑批用：想在同一个扩展组合下扫不同的补偿量时，给它一个正数，
   * 就会盖掉扩展给的比例。留着它是因为调整比例时得成组配对地跑
   * （见 scripts/bonus-compare.ts 那一套）。
   */
  secondGoldBonus?: number;
  /**
   * 先手（A）第一回合不结算收入，默认 false。
   *
   * 现在的规则是"开局先手先领一次收入再行动"，等于先手白拿一回合的钱
   * （古典约 91 金，够买三个民兵）。把它关掉是一种结构性的先后手配平：
   * 两边都在自己第一个回合开始时才拿钱，先手只剩"先动一步"这一项优势。
   */
  noFirstIncome?: boolean;
  /** 启用的扩展规则 id */
  expansionIds: string[];
  /** 启用的兵种 id */
  enabledUnits: string[];
}

export interface PlayerState {
  id: PlayerId;
  name: string;
  gold: number;
}

/** 玩家记忆中某个敌方单位的最后已知位置 */
export interface KnownUnit {
  id: string;
  type: string;
  x: number;
  y: number;
  /** 在哪一行动序号被看到的 */
  seenAt: number;
}

export interface PlayerMemory {
  /** 见过的敌方单位，含已离开视野的（渲染成半透明幽灵） */
  known: KnownUnit[];
}

export interface LogEntry {
  turn: number;
  player: PlayerId;
  text: string;
}

export interface GameState {
  version: number;
  /** 种子化随机的种子，所有随机都必须从这里派生 */
  seed: number;
  /** 本局的规则与选型 */
  config: MatchConfig;
  /**
   * 本局实际使用的兵种表（内置 + 自定义）。
   * 放在 state 里而不是查全局表，是为了让存档自包含：
   * 你把对局发给同学，对方不需要有同样的代码也能接着玩。
   */
  unitTypes: Record<string, UnitTypeDef>;
  /** 行动序号：每结束一次回合 +1 */
  turn: number;
  current: PlayerId;
  w: number;
  h: number;
  tiles: Tile[];
  cities: City[];
  units: Unit[];
  players: Record<PlayerId, PlayerState>;
  /**
   * 运行时的 AI 托管开关。
   *
   * 为什么不只用 config.aiOpponent：调平衡的时候要边打边切，
   * "这一回合我亲自走，下一回合让它自己走"是常态。
   * 缺省（undefined）时按 config 推导，所以旧存档照样能读。
   */
  aiControl?: Partial<Record<PlayerId, boolean>>;
  /**
   * 指挥官模式的生产序列：每方一份，队首是"这一回合要造的兵种 id"。
   *
   * 为什么放进 GameState 而不是留在界面里：它直接决定规则层的产兵结果，
   * 而且必须随存档一起走——刷新页面丢掉排好的计划，这个模式就没法玩了。
   * 普通对局里是 undefined，AI 照旧自己挑兵。
   */
  orders?: Partial<Record<PlayerId, string[]>>;
  nextUnitSeq: number;
  fog: boolean;
  winner: MatchWinner;
  /** 终局原因；旧已结束对局迁移时标记 legacy，不重新改判。 */
  resultReason?: ResultReason;
  /** v5 必须持久化；可选类型仅为兼容 v4 的读取与迁移。 */
  turnProduction?: TurnProduction;
  log: LogEntry[];
  memory: Record<PlayerId, PlayerMemory>;
}

/** 一次状态迁移的全部可能来源。新增玩法只在这里加分支。 */
export type Action =
  | { type: 'MOVE'; unitId: string; x: number; y: number }
  | { type: 'ATTACK'; unitId: string; targetId: string }
  | { type: 'SIEGE'; unitId: string; cityId: string }
  /**
   * 产兵。source 是城市（cityId）或军营（unitId），两者选其一。
   * 军营是"前线的产兵点"，用的还是最近城市的时代科技。
   */
  | { type: 'RECRUIT'; cityId?: string; unitId?: string; unitType: string }
  /** 由建造单位在野外盖建筑：谁盖、盖什么、盖在哪 */
  | { type: 'BUILD'; unitId: string; unitType: string; x: number; y: number }
  /** 上船：相邻的陆军走进渡船的货舱 */
  | { type: 'LOAD'; unitId: string; cargoId: string }
  /** 下船：把货舱里的单位放到相邻的空地上 */
  | { type: 'UNLOAD'; unitId: string; cargoId: string; x: number; y: number }
  | { type: 'UPGRADE'; cityId: string }
  /**
   * 指挥官模式下排生产序列。
   *
   * 整条序列一次写进去（而不是一次加一个），是因为界面允许随时改动任意一格——
   * 用"设置"而不是"增删"，重发一次就天然幂等，也不用担心两边状态不同步。
   */
  | { type: 'SET_ORDERS'; queue: string[] }
  | { type: 'END_TURN' };

/** 规则引擎的返回结果：要么成功带新状态，要么失败带原因 */
export type ActionResult =
  | { ok: true; state: GameState }
  | { ok: false; reason: string };
