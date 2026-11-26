/**
 * v4 的**服务层**（阶段 1a）。
 *
 * ── 这一层存在的理由 ────────────────────────────────────────
 *
 * v3 的三个翻车点都长在这一层：
 *   · 城的角色有三个口径（谁算"前线"、谁算"受威胁"各算一遍，结果对不上）；
 *   · `canReach` 被三处共享，谁改一处三处一起变；
 *   · 每个模块自己算一张距离图，同一格在两个模块里能算出不同的回合数。
 *
 * 所以 v4 的规矩是：**这些东西只在这里算一次，别处只许读。**
 * 任何人想再写一张 BFS，都是 bug（不是"优化"，是 bug）。
 *
 * ── 为什么它好验收 ──────────────────────────────────────────
 *
 * 它输出的是**数**（几回合、几个兵、哪一格），不是**选择**。数可以和引擎真值对拍，
 * 选择只能看结果。所以它单独成关（`scripts/probe-v4-world.ts`）。
 *
 * ── 不许做的事 ──────────────────────────────────────────────
 *
 * 这里**不许有"该不该打"的判断**。那属于决定层。这里只回答"到那儿要几回合"。
 *
 * ── 距离场（BFS）：全项目只有一张，别处一律不许再写 ──────────────
 *
 * **所有距离用曼哈顿距离**（`|dx| + |dy|`）。这张场是"要走几步"的唯一答案
 * （它绕水、绕山；曼哈顿不绕，只用来粗比远近）。
 *
 * 2026-11-24 把原来的四张合成一张了。原来那四张其实是**同一套算法 + 三个开关**：
 *
 *   · 起点几个（1 个 / 一组）
 *   · 每格进入要几步（全部 1 / 按地形）
 *   · 要不要"下一步往哪走"（前驱）
 *
 * 合成后只有 `distanceField(sources, 开关)` 一个入口（`World.field` 是它的门面）。
 * 不同用途只是传不同参数：
 *
 * | 用途 | 起点 | 代价 | 输出 | 前驱 |
 * |---|---|---|---|---|
 * | 城的角色 / 行军回合 | 1 个 | 全部 1 | 回合 | 不要 |
 * | `stepsFrom`（按格计步） | 1 个 | 全部 1 | 步 | 不要 |
 * | 经济选岗（走几步） | 1 座城 | 按兵种（森林 2 / 穿林 1） | 步 | 不要 |
 * | 换空岗（`flowFrom`） | 一组（空岗） | 全部 1 | 步 | **要** |
 * | 让位搬迁（约束层） | 一组（所有空格） | 全部 1 | 步 | **要** |
 *
 * 后两张（多源的）只差**种子**：一个是"该被占的空岗"，一个是"该腾出来的空格"，
 * 方向正好相反，别看混。
 *
 * 只有带前驱的那两张能用来搬人：前驱让整张表变成一棵以起点为根的树，
 * 于是"从根那一头开始，一个接一个往前走一格"永远落在上一人刚腾出来的格上
 * （引擎没有"交换两个人位置"这个动作）。
 */
import { eraDef, passable } from '../config.ts';
import { upgradeTargetOf } from '../era-routes.ts';
import { EARTH, idxOn, tileOn } from '../board.ts';
import {
  attackableTargets,
  attacksPerTurn,
  cityTiles,
  damageToCity,
  effectiveStats,
  rebuildCost,
  recruitSpawnCells,
  recruitPriceOf,
  unitYieldAt,
  utype,
} from '../rules.ts';
import type { City, GameState, PlayerId, Unit } from '../types.ts';

/**
 * **身价**：一个兵种值多少（决定层的强弱、采购口径、发展投影都读它）。
 *
 * 公式 `攻 + 血 + 射程×4`。射程乘 4 是唯一写死的系数——一格射程约等于
 * 4 点属性的价值（能先手、能不吃反击地站住）。动它要跑全量题库。
 *
 * 为什么放在服务层：它被三层同时读，以前住在投影模块（`project.ts`）里，
 * 结果是"想用身价就得先依赖投影"。它是个事实，不是投影的一部分。
 */
export function unitWorthOfType(s: GameState, typeId: string): number {
  const d = utype(s, typeId);
  return (d.atk ?? 0) + (d.maxHp ?? 0) + (d.range ?? 1) * 4;
}

/** 一个已存在单位的身价：按剩余血量打折 */
export function unitWorth(s: GameState, u: { type: string; hp: number }): number {
  const d = utype(s, u.type);
  return unitWorthOfType(s, u.type) * (u.hp / Math.max(1, d.maxHp ?? 1));
}

/** 一座城在这一局里的角色——**只有这一个口径** */
export type CityRole =
  /** 自家最后一座城：丢了就输 */
  | 'home'
  /** 离敌人近、且敌人有兵能到：要守 */
  | 'threatened'
  /** 离敌人近但我方有兵压着：可以往前推的跳板 */
  | 'front'
  /** 离敌人远：产兵的地方 */
  | 'safe';

export interface CityInfo {
  city: City;
  role: CityRole;
  /** 到最近的敌城，占几回合（走不到 = Infinity） */
  distToFoeCity: number;
  /**
   * **敌人最快几回合能摸到这座城**（敌战斗单位里最快的那一个，按它自己的移动力）。
   * `Infinity` = 场上没有敌人的兵，或者路被水山堵死。
   *
   * 取代了原来的 `distToFoeArmy`（那个是"城到敌军的格数"）。格数没法当判断用：
   * 3 格的近战和 3 格的炮兵完全不是一回事，而且"隔一条河"和"隔一片平原"的
   * 3 格也差得远。回合数是这一局里唯一可比的尺度。
   */
  foeEta: number;
  /** 我的战斗单位里，几回合内能赶到这座城的（守军潜力） */
  defenders: number;
}

/** 认领表里的一条：某块地、派什么兵、能产多少、走过去要几回合、多少钱 */
export interface EconSpot {
  /** 兵种——**是这块地的属性**（森林→伐木工、丘陵→牧民、平原→农民） */
  type: string;
  x: number;
  y: number;
  /** 站上去每回合产多少金 */
  yield: number;
  /** 从城走过去要几回合（按这个兵种自己的地形消耗和移动力） */
  turns: number;
  /** 造价 */
  gold: number;
  /** 这块地离哪座城近（配岗要按城分组，不然会把 A 城的岗派给 B 城出生的兵） */
  cityId: string;
}

/**
 * **这座城还能撑几轮**（D3，2026-11-26）。
 *
 * 全项目唯一一份"守得住吗"的算术。决定层要在计划层之前回答"这座城要不要救"，
 * 而"救不救得了"取决于"还能撑几轮"——所以这个数必须在这里算一次，别处只许读。
 */
export interface CityStand {
  /** 按当前局面还能撑几回合（`Infinity` = 没人能打塌它） */
  rounds: number;
  /** 升一级之后还能撑几回合（`undefined` = 这一局升不了 / 到顶了） */
  roundsAfterUpgrade?: number;
  /**
   * 每一轮砸在城上的伤害，**下标就是回合号 − 1**（前面的 0 = 那几轮还没人够得着）。
   * 留它是为了让"人工手算能对上"——判据错了第一眼就能发现。
   */
  incoming: number[];
  /** 有几个敌人的伤害真的落得到城上（打不动的、走不到的不算） */
  threats: number;
  /** 最快的那一个第几回合第一次开火（`Infinity` = 没人到得了） */
  firstAt: number;
}

/**
 * **这座城守得住吗**（W3.6 第 3b 步，2026-11-26）。
 *
 * 用户定的口径：判据是"**现有守城部队 + 这座城自己的产能，挡不住**"，
 * 不是"全军总身价被压到对手的几成"——后者是全军比较，回答不了"这一座城要不要救"。
 */
export interface DefendOutlook {
  /** 挡得住 = 守军身价 + 窗口内能补出来的身价 ≥ 来犯身价 */
  hold: boolean;
  /** 城还能撑几轮（`Infinity` = 没人打得塌） */
  rounds: number;
  /** 判据用的时间窗（轮）——只数这个窗口内赶得到的人，产能也只在这个窗口内累计 */
  window: number;
  /** 这个窗口内赶得到的我方战斗单位身价 */
  defWorth: number;
  /** 这个窗口内能造出来的兵折成身价 */
  makeWorth: number;
  /** 这个窗口内赶得到的敌方战斗单位身价 */
  foeWorth: number;
  /** 有几个敌人的伤害真的落得到城上 */
  threats: number;
  /** 一句话，进决定理由 */
  why: string;
}

/**
 * **这条路过不过得去、过不去要从哪架桥**（W4-4d-1，2026-11-26；只观测）。
 *
 * 学 v3 的三条口径：
 *   · **判据只有"走不走得通"**（地形连通性），不数"造了几座桥"——
 *     认桥数量时 8 座桥有 0 座真的接通（在湖里填、在河湾抄近路）；
 *   · 渡口取**最窄**的那一段水面，不是"我脚下最近的水面"（后者会在湖心架桥）；
 *   · 铺桥要**接着上次的方向**，所以渡口带方向。
 */
export interface BridgeOutlook {
  /** 走得到吗：我方有单位能走到城下（地形连通性，不看桥的数量） */
  reach: boolean;
  /** 走不到时：最窄的渡口。`dir` = 铺桥方向（从 `x,y` 往对岸） */
  crossing?: { x: number; y: number; dir: [number, number]; cells: number };
  /** 铺完要几格、多少钱、多少工时（木桥；时代高了可换石桥/钢桥，这里先按最便宜算） */
  cost?: { cells: number; gold: number; work: number };
  /** 一句话，进日志/理由 */
  why: string;
}

/**
 * **一个时代的一步**（D4a）。`eraLadder(城)` 的返回值。
 *
 * 它是**枚举**，不是选择：这里只回答"如果升到这一代，累计要花多少、那一代每格能放多强的兵"。
 * 选哪一代是决定层的事（`decide.ts`）——"枚举属于服务层，选择属于决定层"。
 */
export interface EraStep {
  era: number;
  /** 从**上一代**升到这一代要多少金（第 0 步 = 当前代，0） */
  cost: number;
  /** 从当前代升到这一代**累计**要多少金 */
  acc: number;
  /** 这一代"每格战力最强"的那个兵种（已排除水兵） */
  type: string;
  /** 它的单价 */
  gold: number;
  /** 它的每格战力（`unitWorthOfType`） */
  worth: number;
}

export interface World {
  me: PlayerId;
  foe: PlayerId;
  w: number;
  h: number;
  cities: CityInfo[];
  myCities: City[];
  foeCities: City[];
  /**
   * **我方视野里的废墟**（`ruined` 的城）。接管它要付 `ruinCost`。
   *
   * 单独列出来，是因为"敌城"和"敌城的废墟"要办的事完全不同：
   * 前者是打掉，后者是塞钱 + 走进去。混在 `foeCities` 里会让"城血 0"被当成"打完了"——
   * S-001 就是这么卡的：城打空之后还在 press，继续造兵，把 248 金花光，永远接管不了。
   */
  ruins: City[];
  /** 接管一座废墟要多少钱（引擎的 `rebuildCost`，纯函数，不拍数） */
  ruinCost(city: City): number;
  /**
   * **能威胁到这座废墟的敌人**：这一步能走到废墟格边、并且打得到它。
   *
   * 用距离场 + 它自己的移动力/射程算，不是"半径 N 格"。
   * 清场要清的就是这一批——清完它才敢站在那儿掏钱。
   */
  ruinThreats(city: City): Unit[];
  /**
   * **敌人最快几回合能摸到这一格**（按敌战斗单位自己的移动力，绕水绕山）。
   * `Infinity` = 场上没有敌人的兵，或者路被地形堵死。
   *
   * 这是全项目唯一的"威胁口径"。想知道"这座城危不危险""这一手要不要回去守"，
   * 一律读它，别拿曼哈顿距离自己比——格数在"隔一条河"和"隔一片平原"上是一回事，
   * 在"近战三格"和"炮兵三格"上又不是一回事。
   */
  foeEta(p: { x: number; y: number }): number;
  /** 能走进废墟接管的兵：地面、活着、不是建筑 */
  captureCandidates(): Unit[];
  /** 战斗 / 经济单位，按"离敌人由近到远"排好序（上层不用再排） */
  myCombat: Unit[];
  myEcon: Unit[];
  foeCombat: Unit[];
  /** 这几格必须空出来（产兵格 + 城门口），约束层会读它 */
  keepClear: number[];
  /** 从某格到某格要走几回合；走不到 = Infinity */
  marchTurns(from: { x: number; y: number }, to: { x: number; y: number }): number;
  /**
   * 按**指定的移动力**算几回合（`marchTurns` 固定按我方战斗兵的中位速度）。
   *
   * 为什么需要：整队行军的速度**不是中位数，是最慢的那个**——快的必须等慢的，
   * 慢的不会因为队里有骑兵就变快。C1 第一版用 `marchTurns` 给全队算，队里
   * 每个人都得同一个数，`Math.max(最慢)` 就是空转。见 `V4-CODE-MAP` 9.21。
   */
  marchTurnsOf(from: { x: number; y: number }, to: { x: number; y: number }, move: number): number;
  /**
   * 从 `p` 出发的**真实回合数距离场**（引擎的 BFS，带缓存）。
   *
   * 为什么需要它：`stepToward` 原来按直线距离挑落点，遇到河就全错——
   * 直线距离说"往东一格更近"，可东边是水，得绕桥（S-005 过河 4→1 就是这么掉的）。
   * 引擎本来就算得出真实步数，用它挑落点最省事，也不会再和规则脱节。
   */
  turnsFrom(p: { x: number; y: number }): Float64Array;
  /**
   * 从 `p` 出发的**按格计步**距离场（每格 1 步，仍然绕水/山）。
   *
   * 为什么不能用 `turnsFrom`：那是**回合数**（兵一回合走 2 格），一格范围内的
   * 十几格全是同一个值，`stepToward` 的"更近"就分不出大小，选点变成随机
   * （S-011 实测：全队漂到西北角）。
   */
  stepsFrom(p: { x: number; y: number }): Float64Array;
  /** 城的角色（同一份缓存） */
  roleOf(city: City): CityRole;
  /**
   * **这座城还能撑几轮**（D3）：按"每一轮真能开火的人"逐轮推进，
   * 顺带给出"升一级之后还能撑几轮"。见 `CityStand`。
   */
  cityStand(city: City): CityStand;
  /**
   * **守得住吗**：守军 + 产能 vs 来犯，时间窗 = 城还能撑几轮。
   * 一处实现，两个读者：决定层判"要不要守"、计划层判"这支队回不回得去"。
   */
  /**
   * `skip` = **不算守军的人**（已经被编队派去进攻别人的兵）。
   * 不算进来是因为它们人不在、也不会回来——和 v1「换家」那条"着力点"是同一个事实。
   */
  defensible(city: City, skip?: ReadonlySet<string>): DefendOutlook;
  /** **过不过得去、过不去从哪架桥**（W4-4d-1；目前只观测，没有判断读它） */
  bridgeOutlook(city: City): BridgeOutlook;
  /**
   * **能同时打到这座城、又站得下人的格数**（W3 上限，2026-11-26）。
   *
   * 这是"一批最多送几个才有用"的几何上限：第 N 个人站上去也打不到城，那他就是排队。
   * 用"到城的步数 ≤ 我方射程"数出来，不是拍的数；城格本身不算（那是城，不是站位）。
   */
  siegeSeats(city: City): number;
  /**
   * **一条线的三个存量**（W1 影子模式，2026-11-26）：能打到城的人 / 还在路上的人 /
   * 这一回合能造出几个。
   *
   * 只观测，不接任何判断——它存在的意义是先把数打出来，看"来不及"到底有多普遍、
   * 一波到底几手（见 `docs/DESIGN-LANES-WAVES-2026-11-26.md` 的 W1）。
   *
   * 口径：
   *   · `front`：`ids` 里到任意一格城的**步数 ≤ 自己的射程**（这一回合就能攻城）；
   *   · `engaged`：原地就能打到**某个敌兵**的人数。和 `front` 一起回答"这支队算不算进入交战"——
   *     只要一方成立就是。为什么不能只看 `front`：进城前先和守军接火是常态，
   *     那时候按 `front` 会判成"还在路上"（2026-11-26 用户指出）。
   *   · `road`：走得到但两个都不成立（在途）；
   *   · `make`：空产兵格 × 钱够几个（取小）。这是"每回合能造出几个"的上限，
   *     钱和格子任一不够都算。
   */
  laneStats(ids: string[], city: City): { front: number; road: number; make: number; engaged: number };
  /**
   * **已经到"前线"的那批人是谁**（W1，2026-11-26）：能打到城的 + 已接火的。
   *
   * 为什么要有"是谁"而不只是"几个"：**通过量必须按人去重**。
   * 一条线的通过量不是几何量（代码里没有"路"这个对象），它是在**终点边界上**量的到货率：
   * 这一手有多少个**新的**人第一次进入前线。只看"前线人数"会把它和伤亡、补人混在一起。
   */
  contacts(ids: string[], city: City): string[];
  /**
   * **升级阶梯**（D4a）：从当前代往上，每一代"累计升级价 + 每格最强的兵 + 单价"。
   *
   * 只枚举，不选。决定层拿它去比"哪一代的总战力最大"（闸 B 的判据）。
   * 升不动（路线封着 / 到顶）就到此为止——所以数组长度不固定，至少 1 个（当前代）。
   */
  eraLadder(city: City): EraStep[];
  /**
   * **发展期还有几手**（D4a，地图兜底那一路）：双方非废墟城之间的最小步数 ÷ 当代众数移动力。
   *
   * 决定层需要它（闸 B 的"钱花不完"要乘剩余手数），而决定层跑在编队之前，
   * 拿不到 `planHorizon` 的编队结果。**这里给的和 `planHorizon` 的 `map` 来源是同一个数**。
   */
  developLeft(): { left: number; fromCityId: string; cityId: string; move: number; steps: number } | undefined;
  /** 这座城现在能造的最便宜的 N 个战斗兵（含价钱） */
  affordableCombat(city: City, gold: number): Array<{ type: string; gold: number }>;
  /**
   * **所有能派经济兵去的地块**（"认领表"的原料；排哪一块是人/约束层的事）。
   *
   * 一格一条，兵种是**格子的属性**（森林→伐木工、丘陵→牧民、平原→农民），
   * 不再把"造哪种"当自由变量——所以"5 个伐木工抢 2 格森林"这种错误根本表达不出来。
   *
   * 这里只交四个数：产出、走过去要几回合、造价、造价÷产出。**不排序、不筛、不做选择。**
   *
   * ── 为什么不是"每回合挑一个最肥的"（原来 `econPost()` 的写法）──
   *
   * 那样有三个死穴，S-015 全踩了：
   *   ① **在途不算占格**：候选只排除"此刻有人站着"的格，新兵出生在城里、旧兵还在路上，
   *      于是同一格森林连着 4 手都被判成"空闲且最肥"，连续造出 5 个伐木工；
   *   ② **没排除 `keepClear`**：城圈里那 2 格森林永远不许站、也永远不会被占，
   *      伐木工的需求永不饱和（约束层排了 `keep`，服务层没排——两份口径）；
   *   ③ **`≥4 金` 是拍的**：一个魔数代替了"这块地值不值得占"。
   *
   * 认领表把这三件事一起解决：格子只出现一次，谁认领了就算占，口径和约束层同一份。
   *
   * `horizon`：这个决定还剩几手。走过去超过它的格子照样返回（上层可以自己比），
   * 但 `turns` 已经给出，谁要按期限筛都有据可依。
   */
  econSpots(): EconSpot[];
  /**
   * **从一组"洞"出发的距离场**：每格离最近的洞几步，以及"下一步该往哪走"。
   *
   * 洞 = 空出来的岗位（不是所有空格）。穿过自己人算一步（那个人得先让开），
   * 敌人和不可通行挡死。
   *
   * 为什么要它：人挨人的时候，"各自算各自最近的一格"会互相堵死——
   * 两个人的"更近"都指向对方，于是谁也不动。一张共享的场里，洞有明确流向，
   * 整列会像传送带一样依次前挪（这是 v3 `buildYieldPlan` 的思路，代码不抄）。
   */
  /**
   * 那张唯一距离场的通用入口（上面 A/B/C/D 四张现在都走它）。
   * 见文件顶部的表格：起点几个、代价怎么算、要不要前驱、限多远。
   */
  field(sources: number[], opt?: FieldOpt): { dist: Float64Array; prev: Int32Array };
  /**
   * 从 `p` 朝 `toward` 走，**横向能并排站几格**（走廊宽度）。
   *
   * 一侧一格算起，连续可站（可通行、无敌人）才计数；撞到山/水/敌人就停。
   * 桥/窄道上是 1，开阔地能到 5~9。
   *
   * 为什么要有它：同一个"横向展开"，开阔地是对的，窄道是灾难——
   * S-005 在桥上试过展开，过河从 4 掉到 0。宽度是地形的事实，不该由打分层猜。
   */
  corridorWidth(p: { x: number; y: number }, toward: { x: number; y: number }): number;
}

/*
 * 格号一律走 `idxOn(s, EARTH, …)`，不自己乘宽度。
 *
 * 多图之后"按宽度乘"这件事默认指地球，在别的图上会静默错一格。v4 现在只处理地球，
 * 但把这件事写在字面上——以后要接多图，搜 `idxOn` 就能一次找齐。
 */

/**
 * **唯一的那张距离场。**（2026-11-24 把原来的四张合成这一张）
 *
 * ── 它是什么 ────────────────────────────────────────────────
 *
 * 给一组起点，算出"地图上每格离最近的起点多远"。
 * 四个开关决定它长成什么样子（原来四张就是这四个开关的不同组合）：
 *
 * | 开关 | 取值 | 原来哪张表用它 |
 * |---|---|---|
 * | `sources` | 1 个 / 一组 | 单源 = 原来的 A / B；一组 = 原来的 C / D |
 * | `perTurn` | 1（输出"步"）/ 兵的移动力（输出"回合"） | 回合 = A；步 = 其余三张 |
 * | `costOf` | 全部 1 / 按地形给（森林 2，穿林 1） | 按地形 = B（选经济岗）；其余全部 1 |
 * | `units` | `ignore`（当没有单位）/ `friendly`（自己人可穿、敌人挡死） | ignore = A/B；friendly = C/D |
 * | `prev` | 不要 / **要**（"下一步往哪走"） | 要 = C/D（要搬人）；不要 = A/B（只问多远） |
 * | `maxDist` | 不限 / 只算 N 步以内 | 不限 = A/B；N = C/D |
 *
 * ── "前驱"（`prev`）是什么 ──────────────────────────────────
 *
 * 每个格记一个"下一步该走到哪个格号"。整张表因此是一棵**以起点为根的树**：
 * 从任意一格顺着它走，一定到得了起点，也不会有环。
 *
 * 用途是**排队**：人多的时候，"每个人自己挑一个更近的格"会互相顶死
 * （我的更近是你、你的更近是我，谁都不动）。有了前驱就变成"链条"：
 * 从根那一头开始，一个接一个往前走一格，每次落点都是上一个人刚腾出来的格。
 * 所以**要搬人就一定要前驱**，只问"多远"才不需要。
 *
 * ── 输出 ────────────────────────────────────────────────────
 *
 * `dist[格号]`：离最近起点的距离（按 `perTurn` 换算后的"步"或"回合"）；走不到是 Infinity。
 * `prev[格号]`：下一步往哪走（格号）；起点自己是 -1，走不到也是 -1。
 *
 * ── 实现上的两个约束 ────────────────────────────────────────
 *
 * ① 边代价只有 1 和 2 两种，所以用三个桶（桶号 = 距离 % 3）一轮一轮扫，
 *    不上堆。桶内**先进先出**（用读指针），这样"同距离时谁的 prev 先写"是确定的——
 *    顺序一变，链条就会变，行为就跟着变（纯重构时这是最要命的一处）。
 * ② 起点是"多源"时，所有起点同时当种子（距离 0）。这不是"从每个起点各跑一遍"，
 *    是"谁都从离自己最近的那个起点算起"。
 */
interface FieldOpt {
  /** 步 → 回合：除以这个数并向上取整。默认 1（输出"步"） */
  perTurn?: number;
  /** 每格的进入代价。默认全部 1 */
  costOf?: (terrain: string) => number;
  /**
   * **波能不能穿过单位**——这是"正着用/反着用"的开关：
   *
   * · `none`：完全不看单位（只算地形）。行军距离、城的角色用它；
   * · `units`：**穿过自己人**（敌人挡死）。这是"反着用"——洞穿过人群往外扩，
   *   意思是"这一格的人得先让开一步"；
   * · `empty`：只走空格，碰到人就停。这是"正着用"——这些人自己能走到哪。
   */
  through?: 'none' | 'units' | 'empty';
  /** 只算这么远，超出的格保持 Infinity */
  maxDist?: number;
  /** 要不要前驱指针（下一步往哪走）。要搬人时必须开 */
  prev?: boolean;
  /** `units: 'friendly'` 时，"自己人"是谁。不给就用当前行动方 */
  ally?: PlayerId;
}

function distanceField(
  s: GameState,
  sources: number[],
  opt: FieldOpt = {},
): { dist: Float64Array; prev: Int32Array } {
  const n = s.w * s.h;
  const dist = new Float64Array(n).fill(Infinity);
  const prev = new Int32Array(n).fill(-1);
  const perTurn = Math.max(1, opt.perTurn ?? 1);
  const costOf = opt.costOf ?? ((): number => 1);
  const through = opt.through ?? 'none';
  /* 边代价只有 1 / 2 两种 → 三个桶够用；桶内先进先出，保证 prev 的写入顺序稳定 */
  const K = 3;
  const buckets: number[][] = [[], [], []];
  const head = [0, 0, 0];
  const maxDist = opt.maxDist ?? Infinity;

  /* 播种：所有起点同时当种子 */
  for (const src of sources) {
    if (src < 0 || src >= n) continue;
    if (Number.isFinite(dist[src])) continue;
    dist[src] = 0;
    buckets[0]!.push(src);
  }

  /* d 就是"当前在处理的距离"，从 0 一路往上扫 */
  for (let d = 0; ; d++) {
    let any = false;
    for (let i = 0; i < K; i++) if (head[i]! < buckets[i]!.length) any = true;
    if (!any) break;
    const bi = d % K;
    const bucket = buckets[bi]!;
    while (head[bi]! < bucket.length) {
      const k = bucket[head[bi]++]!;
      if (dist[k] !== d) continue; /* 过期记录：这一格已被更短的路重写过 */
      if (d >= maxDist) continue; /* 只算这么远，再往外不扩 */
      const x = k % s.w;
      const y = (k - x) / s.w;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= s.w || ny >= s.h) continue;
        const nk = ny * s.w + nx;
        if (Number.isFinite(dist[nk])) continue;
        const t = s.tiles[nk]?.terrain;
        if (!t || !passable(t)) continue;
        /* 波与单位的关系（见 `through`） */
        if (through !== 'none') {
          const occ = s.units.find((u) => u.y * s.w + u.x === nk);
          if (occ) {
            const ally = opt.ally ?? s.current;
            if (occ.owner !== ally) continue; /* 敌人一律挡死 */
            if (through === 'empty') continue; /* 正着用：只走空格 */
            /* `units`：自己人可以穿，算一步（他得先让开） */
          }
        }
        const nd = d + costOf(t);
        if (nd < dist[nk]!) {
          dist[nk] = nd;
          prev[nk] = k;
          buckets[nd % K]!.push(nk);
        }
      }
    }
  }

  /* 步 → 回合（走不满一回合也算一回合） */
  if (perTurn !== 1) {
    for (let i = 0; i < n; i++) if (Number.isFinite(dist[i])) dist[i] = Math.ceil(dist[i]! / perTurn);
  }
  return { dist, prev };
}

/** 这一局里最快的兵有多快（用最慢的当基准反而更保守，这里取众数附近的 2） */
function baseMove(s: GameState, me: PlayerId): number {
  const moves = s.units.filter((u) => u.owner === me && utype(s, u.type).category === 'combat')
    .map((u) => effectiveStats(s, u).move);
  if (moves.length === 0) return 2;
  moves.sort((a, b) => a - b);
  return Math.max(1, moves[Math.floor(moves.length / 2)] ?? 2);
}

/** 所有距离用曼哈顿距离（`|dx| + |dy|`）：斜着走一步要花两步，所以斜向不算近。 */
const near = (a: { x: number; y: number }, b: { x: number; y: number }, r: number): boolean =>
  Math.abs(a.x - b.x) + Math.abs(a.y - b.y) <= r;

/**
 * 建一份 World。
 *
 * 一次 `aiNextAction` 建一次就够——它是只读的，别在循环里反复建（那等于把缓存关掉）。
 */
/**
 * **这座城升一级之后的样子**（D3）：耐久 / 护甲 / 时代一起变，兵不变。
 *
 * 和引擎 `doUpgrade` 逐条对齐：`maxHp` / `armor` 加两代的差，`hp` 加同样的差值
 * （引擎是 `min(maxHp, hp + gain)`，这里同样取 min）。
 *
 * 这里**只算"变成什么样"**，不管钱够不够、路线通不通——那属于计划层；
 * 更不管"要不要升"——那属于决定层（D4 之后）。
 *
 * ⚠️ `constrain.planUpgrade` 里现在还有一份手抄的同样三行（D4 会删掉，改调这个）。
 * 在那之前两处必须一致：改这里的话，那边要跟着改，否则"能撑几轮"会有两个答案。
 */
export function upgradedCity(s: GameState, city: City): City | undefined {
  const tgt = upgradeTargetOf(s, city);
  if (!tgt || tgt.cost === null || tgt.blocked) return undefined;
  const from = eraDef(city.era);
  const dHp = tgt.era.cityMaxHp - from.cityMaxHp;
  const dArmor = tgt.era.cityArmor - from.cityArmor;
  const maxHp = city.maxHp + dHp;
  return {
    ...city,
    era: tgt.edge.to,
    maxHp,
    hp: Math.min(maxHp, city.hp + dHp),
    armor: city.armor + dArmor,
  };
}

export function buildWorld(s: GameState, me: PlayerId): World {
  const seats = [...new Set(s.units.map((u) => u.owner))];
  const foe = (seats.find((p) => p !== me) ?? (me === 'A' ? 'B' : 'A')) as PlayerId;
  const myCities = s.cities.filter((c) => c.owner === me);
  const foeCities = s.cities.filter((c) => c.owner === foe);
  const myCombat = s.units.filter((u) => u.owner === me && utype(s, u.type).category === 'combat');
  const myEcon = s.units.filter((u) => u.owner === me && utype(s, u.type).category === 'economy');
  const foeCombat = s.units.filter((u) => u.owner === foe && utype(s, u.type).category === 'combat');

  const move = baseMove(s, me);
  const foeMove = (() => {
    const ms = foeCombat.map((u) => effectiveStats(s, u).move).sort((a, b) => a - b);
    return Math.max(1, ms[Math.floor(ms.length / 2)] ?? 2);
  })();

  /* 从每座敌城出发算一张"回合图"，城角色和行军都用它 —— 一场棋里敌城不多，值得算 */
  /* 敌城出发的"回合场"：城的角色、行军远近都读它 */
  const flipFromFoeCity = foeCities.map(
    (c) => distanceField(s, [c.y * s.w + c.x], { perTurn: foeMove }).dist,
  );

  const marchCache = new Map<string, Float64Array>();
  const marchFrom = (p: { x: number; y: number }): Float64Array => {
    const key = `${p.x},${p.y}`;
    const hit = marchCache.get(key);
    if (hit) return hit;
    const t = distanceField(s, [p.y * s.w + p.x], { perTurn: move }).dist;
    marchCache.set(key, t);
    return t;
  };

  /* 按格计步：和 turnsFrom 同一套 BFS，只是移动力按 1 算 */
  const stepCache = new Map<string, Float64Array>();
  const stepFrom = (p: { x: number; y: number }): Float64Array => {
    const key = `${p.x},${p.y}`;
    const hit = stepCache.get(key);
    if (hit) return hit;
    const t = distanceField(s, [p.y * s.w + p.x], { perTurn: 1 }).dist;
    stepCache.set(key, t);
    return t;
  };

  const distToNearestFoeCity = (p: { x: number; y: number }): number => {
    let best = Infinity;
    for (const d of flipFromFoeCity) best = Math.min(best, d[idxOn(s, EARTH, p.x, p.y)] ?? Infinity);
    return best;
  };

  /*
   * ── 威胁场（2026-11-25，修 9.7）─────────────────────────────
   *
   * **每个敌战斗单位到每一格的步数**，按地形绕水绕山、不穿人。
   *
   * 为什么不是"一张场再除以移动力"：一支队伍里的兵移动力不同（步兵 2、骑兵 3、炮 1），
   * 除以谁都是错的。所以每个敌人单独一张"步"场，**读的时候按它自己的移动力折成回合**，
   * 取最小的那个。敌人一般不超过十来个，一张 12×12 的场 144 格，这点开销比"算错"便宜。
   *
   * 两个读者（同一份数，不再各算一张图）：
   *   · `foeEta(city)`：敌人最快几回合能摸到这座城 → 城的角色、守家兵留不留；
   *   · `ruinThreats`：哪个敌人够得着这座废墟 → 接管要不要先清场。
   * 这两件事以前各写了一套 BFS（一个按城、一个按废墟），就是"同一概念多份实现"的老病。
   */
  const foeSteps = foeCombat.map((u) => {
    const st = effectiveStats(s, u);
    return {
      unit: u,
      dist: distanceField(s, [u.y * s.w + u.x], { perTurn: 1 }).dist,
      move: Math.max(1, st.move ?? 2),
      range: Math.max(1, st.range ?? 1),
    };
  });

  /** 敌人最快几回合能摸到这一格。`Infinity` = 没有敌人 / 来不了 */
  const foeEtaAt = (p: { x: number; y: number }): number => {
    const k = idxOn(s, EARTH, p.x, p.y);
    let best = Infinity;
    for (const f of foeSteps) {
      const d = f.dist[k] ?? Infinity;
      if (!Number.isFinite(d)) continue;
      best = Math.min(best, Math.ceil(d / f.move));
    }
    return best;
  };

  /** 敌人最快几回合能摸到这座城的任意一格（城的角色和守家兵都读它） */
  const foeEtaOfCity = (city: City): number => {
    let best = Infinity;
    for (const t of cityTiles(city)) best = Math.min(best, foeEtaAt(t));
    return best;
  };

  const cities: CityInfo[] = myCities.map((city) => {
    const dFoeCity = distToNearestFoeCity({ x: city.x, y: city.y });
    const foeEta = foeEtaOfCity(city);
    const defenders = myCombat.filter((u) => near(u, city, 6)).length;
    /*
     * 角色判定：只有这一处口径。别处想问"这座城算前线吗"，一律调 roleOf。
     *
     * **"被威胁"现在按敌军的回合数判，不再按"离敌城几格"判。**
     * 原来那句写的是"离敌人近、且敌人有兵能到"，但代码只看敌城——
     * 敌军贴脸、敌城却在十格外的局面会被判成"安全"（S-013：两座城都判 safe，
     * 于是一个守军都不派，丢城是"没人守"而不是"打输了"）。
     *
     * 阈值 1 = "敌人下一手就能站到城下"。再早不做反应，是因为早一步的判断只能靠猜；
     * 到了这一步是事实，而且正好还来得及派兵。
     */
    let role: CityRole;
    if (foeEta <= 1) role = 'threatened';
    else if (myCities.length === 1) role = 'home';
    else if (dFoeCity <= 6) role = defenders >= 3 ? 'front' : 'threatened';
    else role = 'safe';
    return { city, role, distToFoeCity: dFoeCity, foeEta, defenders };
  });

  const roleMap = new Map(cities.map((c) => [c.city.id, c.role]));

  /*
   * 产兵格 = **城周围那一圈**（几何算），不用 `recruitSpawnCells`。
   *
   * 这里踩过一个死循环：`recruitSpawnCells` 只返回**空着的**落点，
   * 所以"兵把产兵格占满"这个状态它返回空数组——于是一个关键格都找不到，
   * 也就没人被要求让开，永远造不出兵（S-009：守住之后 3 个回合 0 造兵，金 190 花不出去）。
   *
   * 关键格的定义不能依赖"现在有没有空位"，否则它会在最需要工作的时刻失效。
   */
  const keepClear: number[] = [];
  for (const info of cities) {
    const city = info.city;
    const n = city.size ?? 2;
    /*
     * **挨打的时候，城格是可以站的**（2026-11-25，修 9.12）。
     *
     * 引擎的事实：地形防御表 **city = +3 护甲、plain = 0**，所以守军站进城里
     * 比站在城外多 3 点护甲。而 v4 原来把城格和外圈一律算成"必须空"，
     * 于是守军永远站在平原上挨打（实测 D-1-01：v1 站 2 个进城里、城血 18；
     * v4 一个都不进、城血 11）。
     *
     * 为什么只在 `foeEta <= 1`（敌人下一手就能摸到）时放开：
     * 这是**同一个数**（9.7 的威胁场）的第三个读者，不另起一个"我在防守"的判断。
     * 不在威胁下的城仍然按"产兵口"处理——那时候挡住产兵口是真的会造不出兵。
     *
     * 挨打时会不会堵产兵口：**会，所以要留一格**。
     * v4 原来写了一条"被压着的城不造兵"的假规则挡住这件事（引擎里没有这条，见 9.13），
     * 2026-11-25 清掉之后，冲突就真的存在了：守军站满城格 → `recruitSpawnCells` 返回空 →
     * 引擎拒"城市里已经站满了"。所以 `tactics.cityPostCell` 加了"至少留一格"的判据
     * （`free.length < 2` 就不进城）——护甲和补兵两头都保住。
     */
    /*
     * **城格 + 外一圈都保**（2026-11-24 试过只保城格，回退了）。
     *
     * 试的理由：产兵口就是城格本身，外圈挡住的是城边的好地形（S-015 那 2 格森林正好贴着城）。
     * 回退的理由：**外圈是军队出城的通道**——只保城格之后 S-001（必赢题）从"胜"变成"未分胜负"，
     * 兵挤在城墙外，主力出不来。
     *
     * 结论：城边的高产地在这个口径下吃不到。要吃得改地图（把高产地形挪出外圈），
     * 不是改 keepClear。
     *
     * 城格为什么也算（2026-11-24 修正）：兵站在城里，产兵口就被堵住，
     * `recruitSpawnCells` 直接返回 0（S-009：守军退回城下之后金 190 一分都花不出去）。
     * **例外只有一个**：挨打的时候（上面那条 `foeEta <= 1`），城格是可以站的。
     */
    for (let dy = -1; dy <= n; dy++) {
      for (let dx = -1; dx <= n; dx++) {
        /* 挨打时城格可以站（见上）；外圈照旧不许停——那是出城通道 */
        const inside = dx >= 0 && dy >= 0 && dx < n && dy < n;
        if (inside && info.foeEta <= 1) continue;
        const x = city.x + dx;
        const y = city.y + dy;
        if (x < 0 || y < 0 || x >= s.w || y >= s.h) continue;
        const t = s.tiles[y * s.w + x]?.terrain;
        if (!t || !passable(t)) continue;
        keepClear.push(y * s.w + x);
      }
    }
  }

  /*
   * 桥头：邻格有 ≥2 片水的桥面格 = 过河的唯一通道，停在那儿就是把全军的门堵死（S-005）。
   */
  for (let y = 0; y < s.h; y++) {
    for (let x = 0; x < s.w; x++) {
      if (s.tiles[y * s.w + x]?.terrain !== 'bridge') continue;
      let water = 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const t = s.tiles[(y + dy) * s.w + (x + dx)]?.terrain;
        if (t === 'water' || t === 'deep') water += 1;
      }
      if (water >= 2) keepClear.push(y * s.w + x);
    }
  }

  /* 每个敌方战斗单位的"威胁半径"，只算一次（贴脸：移动 + 1，见 harassed 的注释） */

  /* 认领表的原料算一次就够（一场棋里问很多遍），算完缓存 */
  let spotCache: EconSpot[] | null = null;

  /**
   * 把一批人分成"能打到城 / 已接火 / 还在路上"三份（W1）。
   *
   * 一处实现，两个读者：`laneStats` 数人数，`contacts` 交名字（通过量按人去重要用）。
   * 口径：`engaged` 只算**原地**能打到敌兵，不含"走一步再打"——那会偏乐观。
   */
  const contactSplit = (ids: string[], city: City): { front: string[]; engaged: string[]; road: string[] } => {
    const tiles = cityTiles(city);
    const front: string[] = [];
    const engaged: string[] = [];
    const road: string[] = [];
    for (const id of ids) {
      const u = s.units.find((x) => x.id === id);
      if (!u) continue;
      const range = Math.max(1, effectiveStats(s, u).range ?? 1);
      const field = stepFrom({ x: u.x, y: u.y });
      let steps = Infinity;
      for (const t of tiles) steps = Math.min(steps, field[t.y * s.w + t.x] ?? Infinity);
      const atCity = Number.isFinite(steps) && steps <= range;
      if (atCity) front.push(id);
      if (attackableTargets(s, u).length > 0) engaged.push(id);
      else if (!atCity) road.push(id);
    }
    return { front, engaged, road };
  };

  /*
   * ── 这座城还能撑几轮（D3，2026-11-26）─────────────────────────
   *
   * ── 为什么要它 ──────────────────────────────────────────────
   *
   * 决定层跑在计划层**之前**，却要回答"这座城要不要救"。而"救不救得了"取决于
   * "还能撑几轮"——所以这个算术不能留在计划层，得搬到这里（算一次，全层读）。
   *
   * ── 逐轮推进，不是"一次性齐射" ──────────────────────────────
   *
   * 旧算法（`constrain.planUpgrade`）把"两轮内能摸到城"的敌人**当成现在就在全额开火**：
   * 远处那些还没走到的人也算成这一轮就砸满，于是轮数偏小、更容易判成"马上就塌"。
   * 这里按每一轮**真能开火的人**推进：
   *
   *     第 k 回合第一次开火  ⟺  ceil((到城步数 − 它的射程) ÷ 它的移动力)，最小 1
   *
   * 为什么不是"先走一轮、下一轮才打"：引擎允许**走完再打**（同一回合移动 + 攻击），
   * 所以它这一回合就能补上 `move` 步、当回合开火。P-1-03 就是按这个口径手算的
   * （戟兵离城 3 格、射程 2、移动 2 → 第 1 回合就砸 15）。
   *
   * `burst`（一回合多段）必须乘进去——漏了它，装甲车会被当成一半的伤害（P-1-04 踩过）。
   */
  const cityStand = (city: City): CityStand => {
    const tiles = cityTiles(city);

    /** 一场"齐射表"：每个敌人第几回合第一次开火、每回合砸多少 */
    const volley = (target: City): Array<{ first: number; dmg: number }> =>
      foeSteps.flatMap((f) => {
        /* 到**任意一格**城格的最小步数：从哪一格进城算哪一格 */
        let steps = Infinity;
        for (const t of tiles) steps = Math.min(steps, f.dist[t.y * s.w + t.x] ?? Infinity);
        if (!Number.isFinite(steps)) return []; /* 地形堵死，走不到 */
        const dmg = damageToCity(f.unit, target, s) * attacksPerTurn(s, f.unit);
        if (dmg <= 0) return []; /* 打不动这座城（甲的功劳），不参与 */
        return [{ first: Math.max(1, Math.ceil(Math.max(0, steps - f.range) / f.move)), dmg }];
      });

    const run = (target: City): CityStand => {
      const hits = volley(target);
      if (hits.length === 0) {
        return { rounds: Infinity, incoming: [], threats: 0, firstAt: Infinity };
      }
      const firstAt = Math.min(...hits.map((h) => h.first));
      const last = Math.max(...hits.map((h) => h.first));
      let hp = target.hp;
      const incoming: number[] = [];
      /*
       * 推到"最后一个人赶到"之后再给 `hp` 轮余量——再多也不会变。
       * 极限是 200 轮，纯粹防死循环（正常局面 20 轮内必出结论）。
       */
      for (let r = 1; r <= last + 200; r++) {
        const dmg = hits.reduce((n, h) => n + (h.first <= r ? h.dmg : 0), 0);
        incoming.push(dmg);
        if (dmg <= 0) continue;
        hp -= dmg;
        if (hp <= 0) return { rounds: r, incoming, threats: hits.length, firstAt };
      }
      return { rounds: Infinity, incoming, threats: hits.length, firstAt };
    };

    const now = run(city);
    const up = upgradedCity(s, city);
    return { ...now, roundsAfterUpgrade: up ? run(up).rounds : undefined };
  };

  /** 这座城现在买得起的战斗兵（按价升序）。抽成局部函数：`eraLadder` 要在对象建好之前用它 */
  const affordable = (city: City, gold: number): Array<{ type: string; gold: number }> => {
    const out: Array<{ type: string; gold: number }> = [];
    for (const def of Object.values(s.unitTypes)) {
      if (def.category !== 'combat') continue;
      if ((def.era ?? 1) > (city.era ?? 1)) continue;
      if (recruitSpawnCells(s, city.id, undefined, def.id).length === 0) continue;
      const price = recruitPriceOf(s, me, def).gold;
      if (price <= gold) out.push({ type: def.id, gold: price });
    }
    return out.sort((a, b) => a.gold - b.gold);
  };

  /**
   * **某一代"每格战力最强"的兵**（D4a，从 `constrain.bestPerCell` 搬来，判据一字未改）。
   *
   * 每格战力就是 `unitWorthOfType`——产兵格是一次性的，一格能打出多少才是瓶颈。
   *
   * **排除水兵**（2026-11-25 23:20 实测）：`affordableCombat` 会返回楼船/炮艇
   * （城边有点水就能造），它们 worth 高（楼船 108）但只能在水上走。第一版因此把
   * "2 代 + 24 个楼船"算成 2592 战力，比"3 代 + 34 个戟兵"（2550）还高，
   * 于是 E-2-03 里 v4 升了两代就停手、去造一堆开不上岸的船。
   */
  const bestPerCell = (city: City): { type: string; gold: number; worth: number } | undefined => {
    let best: { type: string; gold: number; worth: number } | undefined;
    for (const o of affordable(city, Number.MAX_SAFE_INTEGER)) {
      if (utype(s, o.type).domain === 'water') continue;
      const w = unitWorthOfType(s, o.type);
      if (!best || w > best.worth) best = { type: o.type, gold: o.gold, worth: w };
    }
    return best;
  };

  /**
   * 当前代战斗兵移动力的**众数**（并列取平均，四舍五入）。
   *
   * 用众数而不是平均数/中位数：一代里可能有侦察兵那种异常快、或者攻城器械那种异常慢的，
   * 平均数会被拉偏。这一代没有兵种数据时退回"≤ 这一代"的全体。
   */
  const eraModeMove = (era: number): number => {
    const pick = (maxEra: number): number[] =>
      Object.values(s.unitTypes)
        .filter((d) => d.category === 'combat' && (d.era ?? 1) <= maxEra)
        .map((d) => d.move ?? 1);
    let moves = pick(era);
    if (moves.length === 0) moves = pick(9);
    if (moves.length === 0) return 2;
    const count = new Map<number, number>();
    for (const m of moves) count.set(m, (count.get(m) ?? 0) + 1);
    let best = 0;
    for (const c of count.values()) best = Math.max(best, c);
    const tied = [...count.entries()].filter(([, c]) => c === best).map(([m]) => m);
    return Math.max(1, Math.round(tied.reduce((a, b) => a + b, 0) / tied.length));
  };

  /**
   * **发展期还有几手（地图兜底那一路）**（D4a，从 `constrain.horizonOfMap` 搬来）。
   *
   * 双方非废墟城之间的最小步数 ÷ 当代战斗兵移动力的众数。没有编队可看时用它——
   * `expand` 的局面正是这个状态（没有进攻编队 → 只看地图）。
   *
   * 注意它是**长度**（从现在起还要几手），不是回合号（D2）。
   */
  const developLeft = (): { left: number; fromCityId: string; cityId: string; move: number; steps: number } | undefined => {
    const mine = myCities.filter((c) => !c.ruined);
    const foes = foeCities.filter((c) => !c.ruined);
    if (mine.length === 0 || foes.length === 0) return undefined;
    const era = Math.max(1, ...mine.map((c) => c.era ?? 1));
    const move = eraModeMove(era);
    let best: { left: number; fromCityId: string; cityId: string; move: number; steps: number } | undefined;
    for (const a of mine) {
      for (const b of foes) {
        for (const p of cityTiles(a)) {
          for (const q of cityTiles(b)) {
            const steps = stepFrom(p)[idxOn(s, EARTH, q.x, q.y)] ?? Infinity;
            if (!Number.isFinite(steps)) continue;
            const left = Math.ceil(steps / move);
            if (!best || left < best.left) best = { left, fromCityId: a.id, cityId: b.id, move, steps };
          }
        }
      }
    }
    return best;
  };

  /**
   * **这座城一手能造几个兵**：空产兵格 × 钱买得起几个。
   * 一处实现，两个读者：`laneStats.make` 与 `defensible` 的产能项。
   */
  const makeAt = (city: City): number => {
    const tiles = cityTiles(city);
    const free = tiles.filter((p) => !s.units.some((x) => x.x === p.x && x.y === p.y)).length;
    const price = bestPerCell(city)?.gold ?? 0;
    const gold = s.players[me]?.gold ?? 0;
    return price > 0 ? Math.min(free, Math.floor(gold / price)) : 0;
  };

  /**
   * **守得住吗**（W3.6 第 3b 步，2026-11-26）。
   *
   * 两件事都用现成的数，**不新拍系数**：
   *   · 时间窗 = `cityStand.rounds`（这座城按现在的火力还能撑几轮）——
   *     只能在这个窗口内赶到的人，才算得上"守军"或"威胁"；
   *   · 产能 = 一手能造几个 × 窗口，但被"钱总共买得起几个"卡住（钱是存量，不是每轮都有）。
   *
   * 判据只有一句：**守军身价 + 产能身价 ≥ 来犯身价 → 挡得住。**
   * 没有"几成""几倍"这种倍数——那是要调参的，而这里两边都是金币。
   */
  const defensible = (city: City, skip?: ReadonlySet<string>): DefendOutlook => {
    const stand = cityStand(city);
    if (stand.threats === 0) {
      return {
        hold: true,
        rounds: Infinity,
        window: 0,
        defWorth: 0,
        makeWorth: 0,
        foeWorth: 0,
        threats: 0,
        why: '没人打得着这座城',
      };
    }
    const window = Math.min(6, Number.isFinite(stand.rounds) ? Math.max(1, stand.rounds) : 6);
    const inWindow = (u: Unit): boolean =>
      !skip?.has(u.id) && world.marchTurns(u, city) <= window;
    const defWorth = myCombat.reduce((n, u) => n + (inWindow(u) ? unitWorth(s, u) : 0), 0);
    const foeWorth = foeCombat.reduce((n, u) => n + (inWindow(u) ? unitWorth(s, u) : 0), 0);
    const cell = bestPerCell(city);
    const price = cell?.gold ?? 0;
    const afford = price > 0 ? Math.floor((s.players[me]?.gold ?? 0) / price) : 0;
    const supply = price > 0 ? Math.min(makeAt(city) * window, afford) : 0;
    const makeWorth = supply * (cell?.worth ?? 0);
    /*
     * **判据：守军自己要占优，才算挡得住。**
     *
     * 产能只回答"守不守得住"（差多少、能不能补上），**不进这个不等式**——
     * 理由有两条，都是实测出来的：
     *   · 产能是"只要你肯花钱就有"的承诺：把它算进来，钱多就永远"挡得住"，
     *     于是既不回头也不放弃（P-1-01：300 金能造 3 个戟兵，判成挡得住 →
     *     去发展造农民 → 两个戟兵把老家拆了）；
     *   · 打平也算挡不住：守方没有任何余量时，正确的动作是收队，不是继续在外面打
     *     （D-1-01：开局 4 对 4，判"挡得住"继续攻城，6 手丢城）。
     */
    const hold = defWorth > foeWorth;
    const money = `守军 ${Math.round(defWorth)} + ${window} 轮补 ${supply} 个（${Math.round(makeWorth)}）`;
    return {
      hold,
      rounds: stand.rounds,
      window,
      defWorth,
      makeWorth,
      foeWorth,
      threats: stand.threats,
      why: `${money} ${hold ? '≥' : '<'} 来犯 ${Math.round(foeWorth)}`,
    };
  };

  /**
   * **能同时打到这座城的格数**（W3 上限）：到任一城格的步数 ≤ 我方射程、能站人、不是城格。
   *
   * 为什么要它：一批送多少人，除了"送得到多少"（到货率 × 期限），还受"站得开几个"限制。
   * 40 步的大图上把 28 个人编成一批，多出来的只是排队——S-002 实测过"送 25 个只有 6 个能展开"。
   */
  const seatCache = new Map<string, number>();
  const siegeSeats = (city: City): number => {
    const hit = seatCache.get(city.id);
    if (hit !== undefined) return hit;
    const tiles = cityTiles(city);
    const inCity = new Set(tiles.map((t) => t.y * s.w + t.x));
    /* 射程按"这座城能造的最强兵"算——它就是将来站上去的那批人 */
    const type = bestPerCell(city)?.type;
    const range = Math.max(1, type ? (utype(s, type).range ?? 1) : 1);
    /* 从每一格城格出发做一次距离场，取最小（城是 2×2，从左上角算会偏 1~2 格） */
    const fields = tiles.map((t) => stepFrom({ x: t.x, y: t.y }));
    /* 按图取格：裸格表永远是地球那张，多图下会静默出错（`lint:boards` 会拦） */
    let seats = 0;
    for (let y = 0; y < s.h; y++) {
      for (let x = 0; x < s.w; x++) {
        const k = y * s.w + x;
        if (inCity.has(k)) continue;
        const terr = tileOn(s, EARTH, x, y)?.terrain;
        if (!terr || !passable(terr)) continue;
        let steps = Infinity;
        for (const f of fields) steps = Math.min(steps, f[k] ?? Infinity);
        if (steps <= range) seats += 1;
      }
    }
    seatCache.set(city.id, seats);
    return seats;
  };

  /**
   * **我方所有单位出发的距离场（按格计步）**——一次算好给三处共用：
   * `canReach`（走不走得通）、`crossingOf`（渡口离我们多远）。
   * 源取"我的战斗兵 + 经济兵"，一个都没有时退回我方城的格子。
   */
  let myFieldCache: Float64Array | undefined;
  const myStepField = (): Float64Array => {
    if (myFieldCache) return myFieldCache;
    const src = [...myCombat, ...myEcon];
    const seeds =
      src.length > 0
        ? src.map((u) => u.y * s.w + u.x)
        : myCities.map((c) => c.y * s.w + c.x);
    myFieldCache = distanceField(s, seeds, { perTurn: 1 }).dist;
    return myFieldCache;
  };

  const reachCache = new Map<string, boolean>();
  /**
   * **走得到这座城吗**：城的 2×2 格 + 外面一圈里，有没有一格在我的距离场里是有限的。
   * 水面走不通（`passable('water')` 为假），所以断河时这里一定是 `false`。
   */
  const canReach = (city: City): boolean => {
    const hit = reachCache.get(city.id);
    if (hit !== undefined) return hit;
    const f = myStepField();
    const size = city.size ?? 2;
    let ok = false;
    for (let y = city.y - 1; y <= city.y + size && !ok; y += 1) {
      for (let x = city.x - 1; x <= city.x + size && !ok; x += 1) {
        if (x < 0 || y < 0 || x >= s.w || y >= s.h) continue;
        if (Number.isFinite(f[y * s.w + x])) ok = true;
      }
    }
    reachCache.set(city.id, ok);
    return ok;
  };

  const DIRS4 = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;
  const crossCache = new Map<string, BridgeOutlook>();

  /**
   * **最窄的渡口在哪**（学 v3 的 `crossingPointOf`）。
   *
   * 遍历每一格水面/沼泽，对四个方向各问一次：
   *   · 身后那一格必须是**能走的地**（岸，或者已经铺好的桥）；
   *   · 朝前数连续的"能架桥的格"（水/沼泽），数到岸为止——数不出来（河太宽）就跳过。
   * 选法：**格数最少优先**，同格数再比"从我方到岸 + 从对岸到敌城"的步数之和。
   * 不这么选就会在湖心架桥、在河湾抄近路（v3 的实测）。
   */
  const bridgeOutlook = (city: City): BridgeOutlook => {
    const hit = crossCache.get(city.id);
    if (hit) return hit;
    if (canReach(city)) {
      const out: BridgeOutlook = { reach: true, why: '走得到，不用架桥' };
      crossCache.set(city.id, out);
      return out;
    }
    const my = myStepField();
    const size = city.size ?? 2;
    const center = { x: city.x + Math.floor(size / 2), y: city.y + Math.floor(size / 2) };
    const toFoe = stepFrom(center);
    let best: { x: number; y: number; dir: [number, number]; cells: number; score: number } | null = null;
    for (let y = 0; y < s.h; y += 1) {
      for (let x = 0; x < s.w; x += 1) {
        const here = tileOn(s, EARTH, x, y)?.terrain;
        if (here !== 'water' && here !== 'marsh') continue;
        for (const [dx, dy] of DIRS4) {
          const bx = x - dx;
          const by = y - dy;
          if (bx < 0 || by < 0 || bx >= s.w || by >= s.h) continue;
          const back = tileOn(s, EARTH, bx, by)?.terrain;
          if (!back || !passable(back) || back === 'city') continue;
          /* 朝前数：连续的"能架桥的格"，到岸为止；超过 4 格说明这条不是窄口 */
          let cells = 0;
          let cx = x;
          let cy = y;
          let far: { x: number; y: number } | null = null;
          for (let k = 0; k < 4; k += 1) {
            if (cx < 0 || cy < 0 || cx >= s.w || cy >= s.h) break;
            const t = tileOn(s, EARTH, cx, cy)?.terrain;
            if (!t) break;
            if (passable(t)) {
              far = { x: cx, y: cy };
              break;
            }
            if (t !== 'water' && t !== 'marsh') break;
            cells += 1;
            cx += dx;
            cy += dy;
          }
          if (!far || cells === 0) continue;
          const fromMe = my[by * s.w + bx] ?? Infinity;
          const onward = toFoe[far.y * s.w + far.x] ?? Infinity;
          if (!Number.isFinite(fromMe) || !Number.isFinite(onward)) continue;
          const score = fromMe + onward;
          if (!best || cells < best.cells || (cells === best.cells && score < best.score)) {
            best = { x, y, dir: [dx, dy], cells, score };
          }
        }
      }
    }
    if (!best) {
      const out: BridgeOutlook = { reach: false, why: '走不到，也找不到能架桥的窄口（河太宽/没有岸）' };
      crossCache.set(city.id, out);
      return out;
    }
    const bridgeDef = utype(s, 'bridge');
    const out: BridgeOutlook = {
      reach: false,
      crossing: { x: best.x, y: best.y, dir: best.dir, cells: best.cells },
      cost: {
        cells: best.cells,
        gold: best.cells * (bridgeDef.cost ?? 45),
        work: best.cells * (bridgeDef.buildCost ?? 8),
      },
      why: `走不到，最窄的渡口在 (${best.x},${best.y}) 朝 ${best.dir[0] > 0 ? '东' : best.dir[0] < 0 ? '西' : best.dir[1] > 0 ? '南' : '北'}，要铺 ${best.cells} 格`,
    };
    crossCache.set(city.id, out);
    return out;
  };

  const world: World = {
    me,
    foe,
    w: s.w,
    h: s.h,
    cities,
    myCities,
    foeCities,
    myCombat: [...myCombat].sort(
      (a, b) => (foeCities.length ? distToNearestFoeCity(a) - distToNearestFoeCity(b) : 0),
    ),
    myEcon,
    foeCombat,
    keepClear: [...new Set(keepClear)],
    turnsFrom(p) {
      return marchFrom(p);
    },
    stepsFrom(p) {
      return stepFrom(p);
    },
    marchTurns(from, to) {
      if (from.x === to.x && from.y === to.y) return 0;
      return marchFrom(from)[idxOn(s, EARTH, to.x, to.y)] ?? Infinity;
    },
    marchTurnsOf(from, to, move) {
      if (from.x === to.x && from.y === to.y) return 0;
      const steps = stepFrom(from)[idxOn(s, EARTH, to.x, to.y)] ?? Infinity;
      if (!Number.isFinite(steps)) return Infinity;
      return Math.ceil(steps / Math.max(1, move));
    },
    foeEta(p) {
      return foeEtaAt(p);
    },
    roleOf(city) {
      return roleMap.get(city.id) ?? 'safe';
    },
    cityStand,
    defensible,
    bridgeOutlook,
    siegeSeats,
    laneStats(ids, city) {
      const split = contactSplit(ids, city);
      return {
        front: split.front.length,
        road: split.road.length,
        make: makeAt(city),
        engaged: split.engaged.length,
      };
    },
    contacts(ids, city) {
      const split = contactSplit(ids, city);
      return [...split.front, ...split.engaged];
    },
    corridorWidth(p, toward) {
      const dx = Math.sign(toward.x - p.x);
      const dy = Math.sign(toward.y - p.y);
      /* 法向：把"朝目标"的向量转 90° */
      const nx = -dy;
      const ny = dx;
      if (nx === 0 && ny === 0) return 1;
      const walkable = (x: number, y: number): boolean => {
        if (x < 0 || y < 0 || x >= s.w || y >= s.h) return false;
        const t = s.tiles[y * s.w + x]?.terrain;
        if (!t || !passable(t)) return false;
        const occ = s.units.find((u) => u.x === x && u.y === y);
        return !occ || occ.owner === me;
      };
      let w = 1;
      for (const sgn of [1, -1] as const) {
        for (let i = 1; i <= 4; i++) {
          if (!walkable(p.x + nx * sgn * i, p.y + ny * sgn * i)) break;
          w += 1;
        }
      }
      return w;
    },
    /*
     * 废墟：只在**看得见**的城里找（`s` 已经是玩家视角裁过的 state）。
     * 单独列出来，是因为"敌城"和"敌城的废墟"要办的事完全不同：
     * 前者是打掉，后者是塞钱 + 走进去。
     */
    ruins: s.cities.filter((c) => c.ruined === true),
    ruinCost: (city) => rebuildCost(city, s.config?.freeRebuild === true),
    /*
     * 谁够得着这座废墟。
     *
     * **不再自己算一张 BFS**（2026-11-25）：它和威胁场问的是同一件事
     * ——"这个敌人离这几格有多远"。现在读的是同一份 `foeSteps`：
     * 对每个敌人看"它到废墟最近一格的步数 ≤ 自己的移动力 + 射程"。
     */
    ruinThreats: (city) => {
      const cells = cityTiles(city).map((t) => t.y * s.w + t.x);
      if (cells.length === 0) return [];
      const nearest = (f: (typeof foeSteps)[number]): number => {
        let best = Infinity;
        for (const k of cells) best = Math.min(best, f.dist[k] ?? Infinity);
        return best;
      };
      return foeSteps.filter((f) => nearest(f) <= f.move + f.range).map((f) => f.unit);
    },
    captureCandidates: () =>
      myCombat.filter((u) => u.hp > 0 && utype(s, u.type).category !== 'building'),
    affordableCombat: (city, gold) => affordable(city, gold),
    eraLadder(city) {
      /*
       * 一直往上爬到"升不动"为止（路线封着 / 到顶 / 4 代以内）。
       * 钱够不够**不在这里判**——那是决定层的事（它才知道金币和剩余手数）。
       */
      const out: EraStep[] = [];
      let cur = city;
      let cost = 0;
      let acc = 0;
      for (let i = 0; i < 8; i++) {
        const pick = bestPerCell(cur);
        if (!pick) break;
        out.push({ era: cur.era ?? 1, cost, acc, type: pick.type, gold: pick.gold, worth: pick.worth });
        const tgt = upgradeTargetOf(s, cur);
        if (!tgt || tgt.cost === null || tgt.blocked) break;
        cost = tgt.cost;
        acc += cost;
        cur = { ...cur, era: tgt.edge.to };
      }
      return out;
    },
    developLeft,

    econSpots() {
      if (spotCache) return spotCache;
      const keep = new Set(keepClear);
      /*
       * 桥口的八邻域也排除（沿用 `bestYieldStep` 的口径）：过道边上也是过道。
       * 只对**桥**成立——城格那一圈不能一起排掉（S-015 那两格可用的森林贴着城墙，
       * 一刀切会把它们也排掉，三个伐木工又只能站平原产 3）。
       */
      const nearBridge = new Set<number>();
      for (const k of keepClear) {
        if (s.tiles[k]?.terrain !== 'bridge') continue;
        const kx = k % s.w;
        const ky = (k - kx) / s.w;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1], [0, 0]] as const) {
          const x = kx + dx;
          const y = ky + dy;
          if (x < 0 || y < 0 || x >= s.w || y >= s.h) continue;
          nearBridge.add(y * s.w + x);
        }
      }

      const out: EconSpot[] = [];
      const seen = new Set<number>();
      for (const city of myCities) {
        const defs = Object.values(s.unitTypes).filter(
          (d) => d.category === 'economy' && (d.era ?? 1) <= (city.era ?? 1),
        );
        if (defs.length === 0) continue;
        /* 每个兵种一张"走过去要几步"的表（穿林 / 移动力都算进去） */
        const walk = new Map<string, Float64Array>();
        for (const d of defs) {
          const forestWalk = (d.abilities ?? []).includes('forest-walk');
          walk.set(
            d.id,
            distanceField(s, [city.y * s.w + city.x], {
              costOf: (t) => (t === 'forest' && !forestWalk ? 2 : 1),
            }).dist,
          );
        }

        for (let k = 0; k < s.w * s.h; k++) {
          if (seen.has(k) || keep.has(k) || nearBridge.has(k)) continue;
          const t = s.tiles[k]?.terrain;
          if (!t || !passable(t)) continue;
          /*
           * **自家经济兵站着的格，仍然算候选。**
           *
           * 全排除会出事：兵一站上自己的岗，那格就从表里消失 → 配对整体错位 →
           * 下一手它被判"没岗"、别人被顶到远处，来回挪（实测 S-015：两个伐木工
           * 在 (4,6)/(4,7) 之间每手互换）。
           * 敌人和平民以外的自家单位（战斗兵）仍然排除——那种格是真的站不上。
           */
          const occ = s.units.find((u) => u.y * s.w + u.x === k);
          if (occ && (occ.owner !== me || utype(s, occ.type).category !== 'economy')) continue;
          const x = k % s.w;
          const y = (k - x) / s.w;

          let best: EconSpot | null = null;
          for (const d of defs) {
            const g = unitYieldAt(s, { type: d.id } as never, x, y).gold ?? 0;
            if (g <= 0) continue;
            const raw = walk.get(d.id)![k]!;
            if (!Number.isFinite(raw)) continue;
            /* 兵种是格子的属性：同一格派几回合产能最高的那个 */
            if (best && g <= best.yield) continue;
            best = {
              type: d.id,
              x,
              y,
              yield: g,
              turns: Math.ceil(raw / Math.max(1, d.move ?? 2)),
              gold: recruitPriceOf(s, me, d).gold,
              cityId: city.id,
            };
          }
          if (best) {
            seen.add(k);
            out.push(best);
          }
        }
      }
      spotCache = out;
      return out;
    },

    field(sources, opt) {
      return distanceField(s, sources, { ally: me, ...opt });
    },
  };
  return world;
}
