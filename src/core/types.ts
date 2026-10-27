/**
 * 全局类型定义。
 *
 * 设计原则：GameState 必须是可以 JSON.stringify 的纯数据，
 * 不含函数、DOM 引用、时间戳等不可序列化内容。
 * 这样存档、回放、联机、AI 都能直接复用同一份结构。
 */

export type PlayerId = 'A' | 'B';

/**
 * 资源种类。
 *
 * 原版只通行金币，但"钱"从一开始就不该是唯一答案：养兵吃粮、盖楼用材，
 * 这两件事在历史线里比金币更硬。所以资源在类型上是开放的字符串 id，
 * 注册表（名字、颜色）放在 resources.ts，规则层只认 id。
 *
 * 做成 string 而不是 'gold' | 'food' | 'material' 的联合：
 * 扩展和自定义兵种应该能加自己的资源（比如"法力""燃油"），
 * 而每加一种都要改核心类型，等于把扩展性锁死在核心里。
 */
export type ResourceId = string;

export type Terrain = 'plain' | 'forest' | 'hill' | 'water' | 'mountain' | 'bridge' | 'city';

/**
 * 伤害属性。
 *
 * 属性不是"另一套伤害公式"，它只是给这一下贴个标签，让目标的
 * `weak` / `resist` 表能认出"我怕不怕它"。所以不开奇想包时它等于不存在
 * （没有任何内置兵种带 element），开了之后也只影响那几种明确写了弱点的兵。
 *
 * 分八种是为了让"怕火/怕光/怕水"这些说法能落到具体的兵上，
 * 而不是每加一个属性就多一个特判分支。
 */
export type Element = 'fire' | 'water' | 'earth' | 'wind' | 'light' | 'dark' | 'nature' | 'arcane';

export const ELEMENT_NAME: Record<Element, string> = {
  fire: '火',
  water: '水',
  earth: '土',
  wind: '风',
  light: '光',
  dark: '暗',
  nature: '自然',
  arcane: '奥术',
};

/** 行动域：陆军只能走陆地，水军只能走水面 */
export type UnitDomain = 'land' | 'water';

/**
 * 移动层：地面还是空中。
 *
 * 原版（古典到现代）没有一个会飞的兵，但**规则层从一开始就得承认"天上还有一层"**：
 * 这件事没法后补——只要规则里假设了"一格一人"，后来再加飞行就得到处改判定
 * （占位、寻路、攻击距离、反击、渲染叠放），改一处漏一处。
 *
 * 所以层是类型上的第一等概念，不是某个兵种包的私货：
 *   · ground（缺省）—— 站地上，一格一个人
 *   · air           —— 掠空，和地面**互不占格**，可以和地面单位叠在同一格
 *
 * 有了它，之后任何扩展想让"投石机抛射"“热气球侦察”进原版，都不用再改规则。
 */
export type UnitLayer = 'ground' | 'air';

/**
 * 英雄技能的**效果类型**。
 *
 * 为什么是枚举而不是让每个兵在自己的数据里写一段脚本：技能效果必须改规则，
 * 规则层要 switch 得出来。数据表里写的是"用哪种效果"，文案和冷却写在旁边，
 * 这样改数值不用碰规则，加一种新效果才动这里。
 */
export type HeroSkillEffect =
  /** 投斧：本回合射程拉长，但隔远打只有六成伤害 */
  | 'throw-axe'
  /** 再生：立刻回一截血 */
  | 'regenerate'
  /** 俯冲：本回合移动力加长，攻击附带点燃 */
  | 'dive'
  /** 转属性：切到下一种属性，本回合攻击附带该属性的状态 */
  | 'cycle'
  /** 降临：范围内友军回血并清掉全部负面状态 */
  | 'descend'
  /** 隐匿：自己隐去身形，直到下个回合开始（出手/挨打会暴露） */
  | 'vanish'
  /** 裂殖：牢大裂成四只大史莱姆，生命按当前值分摊 */
  | 'mitosis'
  /** 聚合：大史莱姆合体成牢大，生命合计（封顶） */
  | 'fuse';

export interface HeroSkillDef {
  id: string;
  name: string;
  /** 一句话说明，直接印在按钮上——玩家点之前要能看懂会发生什么 */
  summary: string;
  effect: HeroSkillEffect;
  /** 冷却：用完之后要等几个自己的回合。1 表示下回合就能再用 */
  cooldown: number;
  /** 作用半径；不写表示只影响自己 */
  radius?: number;
  /** 数值参数（回复比例、伤害系数、移动加成），含义由 effect 决定 */
  power?: number;
}

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
  /**
   * 金币造价。
   *
   * 原版只花金币，所以这个字段永远是"总价"。开了多资源的扩展之后，
   * 总价会被拆成"一部分金币 + 一部分粮食/建材"（见 costRes），
   * 这里的数字仍然代表**改造之前**的原价——扩展要按原价折算，
   * 而不是拿了折后价再折一次。
   */
  cost: number;
  /**
   * 金币之外的造价（粮食、建材……）。
   *
   * 缺省表示"只要金币"。写成旁边一个表而不是把 cost 改成对象，
   * 是因为全项目有一百多处读 `def.cost`——改成对象等于把每一处都改成
   * "要么是数要么是表"，那种代码没人想在半夜维护。
   */
  costRes?: Partial<Record<ResourceId, number>>;
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
  /**
   * 固定每回合产出（金币之外的资源也走这里）。
   *
   * 和 income 的关系：income 是"金币"的简写，两个字段同时写会相加。
   * 留着 income 不合并，是因为原版两百多个兵种条目全写的是 income，
   * 改字段名除了制造 diff 之外没有任何收益。
   */
  yield?: Partial<Record<ResourceId, number>>;
  /**
   * 按地形产出的资源表——**同一个单位在不同地块上产不同的东西**。
   *
   * 这是多资源玩法的主轴：一个采集者站平原打粮、站森林砍木头（建材）、
   * 站丘陵采石（也是建材）。一种兵，三种产出，位置本身就是选择。
   */
  yieldByTerrain?: Partial<Record<Terrain, Partial<Record<ResourceId, number>>>>;
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
   * 移动层。缺省 ground。
   *
   * air 的单位与地面**互不占格**：它可以停在敌人头顶，敌人也可以从它脚下走过。
   * 这条是核心规则（不是扩展），因为"占不占格"会渗进寻路、产兵位、攻城判定。
   */
  layer?: UnitLayer;
  /**
   * 飞行：可以掠过水面（并且能停在水上），森林丘陵按 1 步算。
   *
   * 和 layer 分开：飞行说的是"怎么走"，layer 说的是"在哪一层"。
   * 一只鹰是"会飞 + 在空中"，一架滑翔机也是；而热气球可能只是"在空中"却不飞得快。
   */
  flight?: boolean;
  /**
   * 生物：这条单位是"活人/活物"还是"东西"。
   *
   * 多资源规则靠它区分"吃粮"还是"耗材"：活人要吃饭，船和投石机要修。
   * 缺省不写，由规则层按三条线索推：建筑、机械、水上单位都算非生物。
   */
  bio?: boolean;
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
   * 建造点数：这座建筑要投进去多少"工"才立得起来。
   *
   * 不写在回合上，是因为"回合"没法体现工兵差异：同样一座箭塔，老劳工要三回合、
   * 建筑队一回合就能交付——差的是**每回合能投多少点**（见 buildPower），
   * 而不是"这座塔规定要几回合"。
   *
   * 缺省不写时按造价派生（见 rules.buildCostOf）：贵的东西自然更难修。
   * 想要"便宜但特别费工"的建筑（比如桥），显式写一个比派生值小的数就行。
   */
  buildCost?: number;
  /**
   * 建造能力：这个单位每回合能往工地上投多少建造点数。
   *
   * 只对带 `builds` 的单位有意义，缺省 8。同一座塔：
   *   建造 16 点 → 劳工（8）两回合、工程师（18）一回合。
   * 所以"换个更强的工兵"在棋盘上是有回报的，而不是只换个图标。
   */
  buildPower?: number;
  /**
   * 占地边长（格）。缺省 1 = 一格。
   *
   * 2 的单位以**左上角为锚点**，占 2×2 四格：四格一起挡路、一起挨打、
   * 一起没有（拆掉只删一条记录）。城市已经是这个模型的特例
   * （City 自带 size），这里把它推广到单位/建筑上：兵营、工厂这类
   * "本来就不该只有一间房"的建筑终于能画成它应有的体量。
   *
   * 只允许 1 或 2：3×3 的单位在 16×16 的盘上会变成地标，
   * 而且"围住它要八个人"这种数值关系没人算得清。
   */
  footprint?: 1 | 2;

  /**
   * 可驻军：友军站在这一格上时额外获得护甲与视野（见 CONFIG.garrisonArmor）。
   *
   * 兵本来就能站自家建筑（见 reachableTiles 的说明），这个字段回答的是
   * "站上去有什么用"——没有它，"进驻"只是一个说法。
   */
  garrison?: boolean;
  /**
   * 障碍：这一格"过不去"，连友军也不能停在上面。
   *
   * 默认**所有建筑都能站人**——塔有梯子、军营有营门、磨坊有屋檐，
   * 一座建筑占掉一格却永远空着，只会让布阵时莫名其妙地缺一个洞。
   * 只有墙、栅栏、拒马、铁丝网这一类是例外：它们的全部作用就是"这一格不存在"，
   *
   * 所以这里是反向标注（标"过不去"而不是标"能站"）：
   * 新加一座建筑时默认是可站的，想让它挡路才要显式写一行。
   */
  obstacle?: boolean;
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

  // ── 奇想兵种包的机制字段 ────────────────────────────────────────────────
  //
  // 这一组全部是可选的：旧数据表一个都不写，读出来就是 undefined，
  // 语义正好等于"没有魔法、没有属性、不是英雄"。所以不用升存档版本号。

  /**
   * 魔法攻击力：一次攻击的**第二段**伤害。
   *
   * 为什么单独一段而不是"另一种护甲"：魔法段的全部意义是绕过护甲——
   * 它对重甲单位和轻甲单位打出来一样多，也不吃地形加成。挡它的只有
   * `magicRes`。这样法师就是重甲的解，而不是又一个数值更高的弓手。
   *
   * 数值刻意压得低（同代物理攻击的 1/3 ~ 1/2）：它不吃护甲，
   * 一个 20 点魔攻的法师打在 10 甲的重骑身上，比 40 点物攻的步枪兵还疼。
   */
  magicAtk?: number;
  /**
   * 魔法抗性：直接平减魔法段。默认 0。
   *
   * 不参与物理伤害，也不是护甲——所以"破甲"对它没作用。
   * 数值同样压得低（0~6），高魔抗兵种一局里只该有几个。
   */
  magicRes?: number;
  /** 攻击属性。缺省表示纯物理，属性倍率表不参与结算。 */
  element?: Element;
  /** 属性弱点：受到该属性伤害时**倍乘**（巨魔怕火就是 fire: 2）。 */
  weak?: Partial<Record<Element, number>>;
  /** 属性抗性：受到该属性伤害时**平减**（水元素抗水就是 water: 4）。 */
  resist?: Partial<Record<Element, number>>;
  /**
   * 英雄：同一方场上只能有一个，而且**第一次招它要额外付解锁费**。
   *
   * 不直接用"贵"来限制，是因为贵只是延后，英雄真正的问题是"有两个就没法打了"。
   * 解锁费则让"第一次掏出英雄"本身成为一个决策点。
   */
  hero?: boolean;
  /** 首次招募的解锁费（只在 hero 上有意义） */
  unlockCost?: number;
  /**
   * 弹药：每局最多能攻击几次。用完还能打，只是魔法段归零、射程掉到 1。
   *
   * 给炼金术士这种"东西有限"的单位准备的——它的强不在于打得狠，
   * 而在于前几发能改变战场形状。
   */
  ammo?: number;
  /**
   * 只能被召唤，不能从产线生产。
   *
   * 召唤物不占编制（它们不是招募来的），也不进 AI 的采购名单。
   */
  summonedOnly?: boolean;
  /**
   * 召唤：每 `every` 个自己的回合，在相邻空格召唤一个单位，最多 `max` 个。
   *
   * `random` 给了就是每次从里面随机抽一个（元素召唤师），
   * 否则固定召 `type`。随机也必须走种子，否则回放会对不上。
   */
  summon?: { type?: string; random?: string[]; every: number; max: number };
  /** 每回合自损多少生命。给土墙、召唤物这类"临时存在"用。 */
  decays?: number;
  /** 回合开始按这个列表轮换自己的攻击属性（已被至尊法师的手动技能取代，保留字段兼容旧存档） */
  cycle?: Element[];
  /**
   * 阵亡时分裂成两只这个兵种（史莱姆）。配「分裂」能力用。
   *
   * 「裂殖」技能也读它，只是裂成四只（牢大 → 大史莱姆）：
   * 两处都是"裂成这个兵种"，差别只在数量和触发方式，所以共用一个字段。
   */
  splitInto?: string;
  /**
   * 主动合体成这个兵种（大史莱姆 → 史莱姆牢大）。配「聚合」技能用。
   *
   * 和 splitInto 是同一对概念的正反两面：一个往下裂、一个往上并。
   * 都写在兵的自己身上，是因为规则层不该知道"史莱姆"这个名字。
   */
  mergeInto?: string;
  /**
   * 英雄技能。每回合开始时冷却 −1，冷却到 0 就能用一次。
   *
   * 做成技能而不是被动，是因为英雄的强度如果全靠"自动发生"，
   * 玩家的操作空间就只剩"把兵放到哪"——英雄和一个数值高一点的兵没区别。
   * 每回合一次的主动选择，才让"什么时候开、开在谁身上"成为一个决策。
   */
  skills?: HeroSkillDef[];
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
  /**
   * 已成废墟：城墙被打塌、守军全灭，但**还没被接管**。
   *
   * 废墟仍然挂在原主名下（所以它不会因为"丢了一座城"直接判负），
   * 但不产出、不产兵、不回血；要派兵走进去并付一笔重建费才真正易主。
   * 这样"破城"和"占领"是两件事：砸开城墙不等于拿到城市。
   */
  ruined?: boolean;
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
   * 工地进度：已经投进去的建造点数。
   *
   * 只在"还没建成"时出现，缺省 undefined = 已经建好了。
   * 判断一律走 rules.ts 的 underConstruction()，别在各处写 `> 0`。
   */
  buildDone?: number;
  /** 工地目标：这个工地总共要多少点（动工那一刻从兵种表抄下来的） */
  buildNeed?: number;
  /**
   * 这个工地每回合自动到账的建造点数（= 参与施工的工兵能力之和）。
   *
   * 记在工地上而不是"每次去扫附近有没有工兵"：工兵建完就走是常态
   * （他还要去下一个工地），把进度绑在人的站位上，会让"走开"变成一种隐形惩罚，
   * 而玩家看不到任何提示。两个工兵一起修，就是两次 BUILD 叠在同一个工地上，
   * rate 相加、立刻各投一次——这是"协作"最直白的表达。
   */
  buildRate?: number;
  /**
   * 旧版的"还差几个回合"。
   *
   * 新存档不再写它（改用 buildDone/buildNeed/buildRate），但旧存档里还有，
   * 读到就按 1 点/回合继续推进，不至于让一局打到一半的存档卡在工地上。
   */
  buildLeft?: number;
  /**
   * 本回合**手动**开过火（只有能自动开火的建筑用得上）。
   *
   * 为什么不复用 acted：新盖好的建筑本来就是 acted=true（当回合不能行动），
   * 拿它当判据，"刚建好的塔"就永远打不出第一炮。两件事得分开记。
   */
  manualFired?: boolean;
  /**
   * 货舱：被这条船载着的单位。
   *
   * 上船的单位**从棋盘上的 s.units 里拿掉**，整个对象存在这里。
   * 这样"船上的人不算占格、不吃攻击、不受地形影响"全都是自动的，
   * 不用去改每个遍历 units 的地方（那是几十处，必漏）。
   * 代价是船沉的时候这些人一起没了——沉船本来就该是这个结果。
   */
  cargo?: Unit[];

  // ── 奇想兵种包的运行时字段（全部可选，旧存档读出来都是 undefined） ──

  /** 本局自己的攻击属性覆盖值（至尊法师每回合轮换就写这里） */
  element?: Element;
  /** 剩余弹药；没写 ammo 的兵种不读这个字段 */
  ammoLeft?: number;
  /**
   * 身上的负面状态。
   *
   * 三个"按比例"的（中毒、减速、诅咒）存的是**还剩几回合**，强度另算
   * （中毒按生命上限 6%，减速 −1 移动，诅咒 −2 护甲）。
   * `burn` 是个例外：它存的是**层数**——每层每回合 4 点固定伤害，
   * 结算完自己掉一层。挨一次火就多一层，所以站着不动会被慢慢烤穿，
   * 而高血量单位也不至于因为体型大就被烧得格外狠。
   */
  status?: { poison?: number; burn?: number; slow?: number; curse?: number };
  /** 已经重生过一次（不死鸟的蛋只会孵一次） */
  reborn?: boolean;
  /**
   * 技能留下的临时状态，回合结束时清空。
   *
   * 放在单位上而不是另开一张表：它只影响这个单位这一回合的射程/伤害/移动，
   * 生命周期和"本回合是否已行动"完全一致。
   */
  heroBuff?: {
    /** 本回合射程覆盖值（投斧把 1 拉成 3） */
    range?: number;
    /** 远程伤害系数（投斧隔远只有六成） */
    rangeMul?: number;
    /** 本回合移动力加成（俯冲 +2） */
    moveBonus?: number;
    /** 本回合攻击额外附带这个属性的状态 */
    elementHit?: Element;
    /** 本回合攻击额外叠几层点燃（俯冲是两层） */
    burnLayers?: number;
    /**
     * 这一下攻击是"技能白送的"。
     *
     * 投斧就是走的这条路：它不占用本回合的攻击次数，打完还能再正常打一次，
     * 所以 doAttack 看到这个标记就不写 acted/moved，只把加成收回去。
     */
    freeShot?: boolean;
    /**
     * 技能带来的隐匿（刺客大师）。
     *
     * 和被动「隐匿」能力不是一回事：被动要求"这回合还没动过"，
     * 而技能是"主动藏起来，等对面回合走完"。所以它挂在 heroBuff 上——
     * 回合开始统一清空，正好等于"藏到你的下个回合开始"。
     * 出手或挨打会立刻删掉它（见 doAttack）。
     */
    hidden?: boolean;
  };
  /** 英雄技能冷却剩余回合数：key 是技能 id */
  skillCd?: Record<string, number>;

  /**
   * 「岁数」：这个单位熬过了多少个**自己的**回合开始。
   *
   * 召唤周期看它，而不是看 s.turn。全局回合数是两边共用的，
   * 直接取模的话先手方永远只碰到奇数回合，周期 2 的召唤就一辈子不触发。
   */
  age?: number;
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
  /**
   * 上帝模式（沙盒）：纯单人，往盘上凭空摆兵、摆城，不要金币也不要产线。
   *
   * 和前几个开关不是一个层次的东西：
   *   · aiOpponent / aiAlly 说"谁被托管"，commanderMode 说"人被托管到什么程度"，
   *     而这个模式说"这一局根本不是对局"——它是一块试兵场。
   *   · 所以它要求两边都归玩家摆（aiOpponent / aiAlly 一律关掉），
   *     摆完之后点「交给 AI」/「接管」，让 AI 同时操控两边打给玩家看。
   *
   * 胜负也不按城判（checkWinner 在这个模式下直接返回 null）：
   * 沙盒要的答案是"这两支部队打起来谁赢"，不是"谁先丢光城"。
   * 一方没兵了由界面判停，见 main.ts 的 runGodFight。
   */
  godMode?: boolean;
  /** 地貌风格：random 由种子抽；也可以指定横河 / 纵河 / 山岭 / 开阔 */
  mapStyle?: 'random' | 'river-h' | 'river-v' | 'ridge' | 'open';
  /** 地形对称方式：fair = 两侧配额相同分布不同（默认）；mirror = 完全镜像 */
  mapSymmetry?: 'fair' | 'mirror';
  /**
   * 城市边长（占 size × size 格），缺省 2。
   *
   * 写在 config 里而不是只从扩展读：地图生成要知道城占多大，
   * 而地图是在"这一局用什么规则"确定之后、开局之前生成的。
   * 扩展通过 `Expansion.citySize` 声明它要多大，setup 把它折算进 config。
   */
  citySize?: number;
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
  /** 金币：主资源，也是唯一一种"原版就在流通"的资源 */
  gold: number;
  /**
   * 其它资源（粮食、建材……）。
   *
   * 不把 gold 也塞进来：gold 会被一百多处直接读写，挪进表里等于给每一处
   * 加一层容错；而且旧存档读出来没有 res 字段，正好等于"只有金币"。
   * 读写其它资源一律走 resources.ts 的 helper，别自己在这张表上加减。
   */
  res?: Partial<Record<ResourceId, number>>;
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
  winner: PlayerId | null;
  log: LogEntry[];
  memory: Record<PlayerId, PlayerMemory>;
  /**
   * 本局**第一座**被攻陷的城原本属于谁——也就是"谁先丢了城"。
   *
   * 只写一次，之后再也不改。为什么不能靠"当前城数"推：城会被抢回来，
   * 抢回来的那一刻当前城数就恢复了，"曾经丢过"这段历史会被抹掉。
   * 「哀兵必胜」这类"谁先吃亏"的规则必须靠这条记录。
   *
   * 旧存档里没有这个字段，读出来是 undefined，语义正好等于"还没有城被攻陷"。
   */
  firstCityLost?: PlayerId;
  /**
   * 已经解锁过的英雄兵种 id（每方一份）。
   *
   * 解锁费只在**第一次**招募时付，所以必须记在状态里而不是兵种表里：
   * 兵种表是全局限定的，同一个英雄 A 方解锁了不该让 B 方也免费。
   * 旧存档没有这个字段，按"什么都没解锁"处理。
   */
  unlocked?: Partial<Record<PlayerId, string[]>>;
  /**
   * 等着落位的"蛋"（不死鸟重生）。
   *
   * 不死鸟死掉的那一刻不会立刻站起来，而是把选择权交给玩家：
   * 在自己回合挑一格把蛋放下，下一回合（或本回合结束时）从那里孵出来。
   * 为什么要多这一步：自动原地重生等于"死在一个更好的位置"，
   * 而重生本身最大的价值恰恰是**换一个位置**——这不该由规则替玩家决定。
   *
   * 旧存档没有这个字段，读出来是 undefined，表示"没有待落位的蛋"。
   */
  pendingEgg?: {
    owner: PlayerId;
    /** 孵出来是什么兵种 */
    type: string;
    /** 蛋原本落下的位置，用来算可选范围 */
    x: number;
    y: number;
    /** 可选半径：只能落在原地附近，不能"复活到对面家里" */
    radius: number;
    /** 孵出来时保留多少比例的生命 */
    hpRatio: number;
  };
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
  /**
   * 遣散/拆除：把自己场上的一个单位或建筑清掉，回收一部分造价。
   *
   * 存在的理由有两个：一是建筑会挡路（修歪了、把自己城门堵了），
   * 二是残局里一堆过时兵占着编制，不如换成钱。
   */
  | { type: 'DISBAND'; unitId: string }
  /** 英雄技能：谁放、放哪个 */
  | { type: 'HERO_SKILL'; unitId: string; skillId: string }
  /** 把待落位的蛋放到这一格（不死鸟） */
  | { type: 'PLACE_EGG'; x: number; y: number }
  /** 认输：直接把胜利判给对方，不用把棋盘走完 */
  | { type: 'SURRENDER' }
  | { type: 'END_TURN' };

/** 规则引擎的返回结果：要么成功带新状态，要么失败带原因 */
export type ActionResult =
  | { ok: true; state: GameState }
  | { ok: false; reason: string };
