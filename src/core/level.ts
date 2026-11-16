/**
 * 关卡：一张地图 + 一组"这一局怎么打"的设定。
 *
 * ── 它和"固定地图"是什么关系 ─────────────────────────────────────────
 *
 * 固定地图只回答"在哪打"：地形 + 城位，一个兵都不带，也没有任何规则。
 * 关卡在它上面多问几件事：开局谁有什么兵、每一家是真人还是电脑、中途会发生什么、
 * 怎么算赢。所以**关卡里包含一份地图**，而不是"引用"一张地图。
 *
 * ── 为什么整包进局面，而不是只存一个 id ───────────────────────────────
 *
 * 和 `config.fixedMap` 同一条理由：一份配置会跟着存档、联机房间、分享链接一路传下去。
 * 只存 id 的话，对方那边查不到这张关卡（或者查到的是改过之后的版本），
 * 结果就是"两边各打一局不一样的棋，而且不报错"。
 *
 * 所以进局面的永远是**那一刻的快照**（`validateLevel` 返回的就是一份深拷贝）。
 * 我们以后改关卡——调平衡、改错字、把刷兵点挪一格——老存档里的那一份不会跟着变。
 *
 * ── 现在的状态（2026-11-14，批次 0~2）───────────────────────────────
 *
 * 已经有内容的是四项：地图、几家与谁托管、开局部署、扩展规则。
 * 事件表、胜负条件在后面的批次加，加的时候直接往 `LevelDef` 上加字段，
 * 别在别处另起一份。
 *
 * 注册表里的关卡**不允许玩家修改**。等引擎稳了、编辑器开了，再谈玩家自定义；
 * 到那时候"来源"会多一种（玩家上传），但"进局面的是一份快照"这条不变。
 */

import { validateFixedMap, type FixedMap, type MapPoint } from './fixed-maps.ts';
import { expansionById } from './expansions.ts';
import { ERAS, UNIT_TYPES } from './config.ts';
// 只取类型，编译后不留 import：types.ts 那边也是用内联 `import('./level.ts')` 的
// 类型位置引用来避开循环依赖，两边都不会在运行期真的互相加载。
import type { MatchConfig, PlayerId, Terrain, UnitTypeDef } from './types.ts';

/**
 * 关卡规定的一个开局兵。
 *
 * 只写"什么兵、站哪"。血量、护甲、攻击全走兵种表——关卡不该另存一份数值，
 * 否则兵种一调平衡，关卡里那份就成了过期的影子。
 */
export interface DeployUnit {
  type: string;
  x: number;
  y: number;
}

/**
 * 一块矩形区域（含四边）。关卡里的"走进某片地方"就用它描述。
 *
 * 为什么先只做矩形：作者是拿坐标写的，矩形是唯一一种**看一眼就知道覆盖哪几格**
 * 的形状。以后要圆形、多边形、按地形选区域，都往 `LevelWhen.enter` 里加变体，
 * 不要另起一套。
 */
export interface LevelZone {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * 事件什么时候触发。
 *
 * 三条都是"只读局面"的判断——不读时间、不读随机、不读玩家本地的任何东西。
 * 这条不是为了好看：电脑在决定怎么走之前会把几种走法各试一遍（试的时候跑的是
 * 同一套结算），事件也会跟着被"演练"。只读局面的话，演练的结果和真走完全一致，
 * 试完扔掉就行；一旦读了外面的东西，试走和真走就会算出两套答案。
 */
export type LevelWhen =
  /** 行动序号到第几（1 起）。注意这是"第几次行动"，不是"第几轮" */
  | { kind: 'turn'; at: number }
  /** 某个单位死了。只写 owner 就是"这一家的任何一个兵死" */
  | { kind: 'unitDied'; owner?: PlayerId; type?: string }
  /** 某个单位从区域外走进区域内 */
  | { kind: 'enter'; zone: LevelZone; owner?: PlayerId };

/** 事件触发后做什么。一批动作按数组顺序执行。 */
export type LevelDo =
  /** 刷兵：不看钱、不看产线，只看"这一格站不站得住"*/
  | { kind: 'spawn'; owner: PlayerId; units: DeployUnit[] }
  /** 播报一句。写进战报，双方都能看到（`open`） */
  | { kind: 'say'; text: string }
  /** 改这一席电脑的打法（守/攻/经营/停手），AI 下一手就按它来 */
  | { kind: 'doctrine'; seat: PlayerId; strategy: 'auto' | 'rush' | 'boom' | 'hold'; targetSeat?: PlayerId }
  /**
   * 让一个"未登场"的席位上场：放它的城、摆 `level.deploy` 里给它写好的兵。
   *
   * 只做一次（调用后把它从 `hidden` 里去掉）。重复调用不会放两座城。
   * 兵源固定用关卡自己的 `deploy`——事件里再写一遍坐标，作者会有两处要同步。
   */
  | { kind: 'deploy'; seat: PlayerId }
  /**
   * 改地形：把 `zone` 里符合条件的地形改成 `to`。
   *
   * 三条兜底由引擎做，作者不用管：城格跳过；格上站着兵就挤到最近能站的空地
   * （挤不到就没了，会在战报里说一声）；桥塌了连着桥本身一起没。
   *
   * **不自动拦截"把地图切成两块"**——"断了桥才能守住"本身就是一种设计，
   * 引擎去拦反而是拦创意。这一关能不能打完，是批量自检该管的事。
   */
  | { kind: 'terrain'; zone: LevelZone; to: LevelTerrain; only?: LevelTerrain[] }
  /**
   * 点亮一片区域：这些格子此后**一直可见**（地形和上面的单位都不再被迷雾遮住）。
   *
   * 用在不希望玩家瞎猜的地方：护送关的终点（不然开着雾根本不知道往哪走）、
   * 伏兵刷出来的位置（让"那儿有人"这件事立刻成立）。
   *
   * **这就是开关**：想点亮就加这条动作，不想让玩家看见的隐秘事件就别加。
   * 它是"信息"不是"效果"——不改地形、不刷兵、不造成任何规则变化，
   * 只是把这片从迷雾里揭出来。没开迷雾的对局里它无害（本来就全可见）。
   *
   * `turns`：亮几次行动（默认 1）。1 已经覆盖"当下 + 下一手"两个行动序号
   * （事件常在对方回合触发，只亮当下一手等于玩家没看见）。
   * **写负数 = 一直亮**（比如 `turns: -1`），给"地图上永久该知道的位置"用。
   */
  | { kind: 'reveal'; zone: LevelZone; turns?: number };

/**
 * 一件事：什么时候、做什么。
 *
 * `id` 是它在这一关里的名字，**也是"已经发生过没有"的钥匙**——这个记录写在局面里
 * （`state.levelState.fired`），不放程序里。理由见上面 `LevelWhen` 那段：
 * 放程序里会被试走改乱，表现是"有时候事件不触发"，而且完全查不出来。
 */
export interface LevelEvent {
  id: string;
  when: LevelWhen;
  do: LevelDo[];
  /** 默认只触发一次。写 `true` 才是每次都触发（同一条回合数没有意义，只对 enter 有用） */
  repeat?: boolean;
}

/**
 * 这一关**写死的开局设定**。
 *
 * 为什么需要它：面板上那几个开关（时代、尺寸、先手）会直接改变这一局的强度——
 * 最要命的是**时代决定开局金币**（青铜 120，每升一级 +240）。同一张"3 打 6 死守"，
 * 玩家把时代调到信息化，守方就能靠开局那笔钱直接堆出防线，难度全没了。
 * 所以关卡必须能把这些也钉住，而不是只钉住兵力和扩展。
 *
 * 规矩和扩展规则一样：**写了就锁，没写就归玩家**。
 */
/**
 * 这一关专属的 AI 参数。
 *
 * 同一套 AI 要在"渡过一条窄河的攻坚"和"守着一个人别送死"里都表现正常，靠全局参数是做不到的：
 * 前者需要它**不管战线、各打各的**，后者需要它**极度惜命**。所以让关卡自己带一份。
 *
 * 只影响这一局（`config.level.ai` 是快照），别的对局照旧。
 */
export interface LevelAiTuning {
  /**
   * 战线收拢强度，0~2，默认 1。
   *
   * AI 有一条"跑得太靠前的停下来等队友"的规则：超过战线的人，推进分砍到 15%。
   * 这在开阔地是对的（整条线一起压），但**河会把战线切成两段**——先过去的几个
   * 永远算"在战线前面"，于是永远停着等，而后面的大部队被窄桥堵着过不来，
   * 整支部队就僵在桥头。
   *
   * 0  = 完全不管战线，谁快谁先上（攻坚图要的）；
   * 1  = 默认；
   * 2  = 收得更紧（守将这类"不能死"的场面）。
   */
  cohesion?: number;
  /**
   * 战意：放大/缩小"朝目标推进"的分数，0.2~3，默认 1。
   *
   * 和 `cohesion` 分工：那个管"要不要等队友"，这个管"值不值得往前走"。
   */
  appetite?: number;
  /**
   * 风险厌恶，0.2~2，默认 1。**这是"进攻性"的主旋钮。**
   *
   * AI 每走一格都要算"这个落点会被几个人打到、会掉多少血"，再拿这个惩罚去抵消
   * "朝目标推进"的收益。推进一格只值几分，而站进对方射程要扣二十分往上——
   * 所以守方只要摆出几个兵，它就宁可待在桥头不动。这是"AI 太胆小"的真正来源，
   * 和战术档（rush/hold）无关，那些只改倾向，改不动这笔账。
   *
   * 0.4 左右 = 愿意用伤亡换推进（攻坚图）；1 = 默认；1.5 以上 = 极度惜命（护主）。
   */
  riskAversion?: number;
  /**
   * **僵局压力**，0~3，默认 0（不启用）。
   *
   * 有些关会停在一个"谁都不动"的稳定态：攻方压在火力圈外、守方缩在城里，
   * 双方每回合的最优解都是"别动"。这个值让"朝目标推进"的分**随回合数加码**
   * （`1 + pressure × turn/25`，封顶 4 倍），越拖越往对面压。
   *
   * 和 `riskAversion` 分工不同：那个管"怕不怕死"，这个管"拖下去值不值得动"。
   * 0.5~1 是"慢慢加压"，2 以上是"这一关不允许僵持"。
   *
   * **只对没有城的席位生效**：有城的 AI 是防守方，给它加码只会让它丢下城墙去送。
   * 另外它还会打开一层"督战"：核心 AI 认为这一回合没事可做时，替它挑一个
   * 还能动、且这一步真的更接近敌城的单位走一步（否则二十多个单位里只有三四个在动）。
   */
  pressure?: number;
}
export interface LevelSetup {
  /** 开局时代（1 起）。锁了它，开局金币、可造兵种也就一起锁了 */
  startEra?: number;
  /** 谁先手。多人局本来就不能选先手（席位顺序牵着城位），所以只收 A / B */
  firstSide?: 'A' | 'B';
  /** 每家两座城 */
  twoCities?: boolean;
}

/**
 * 事件能把格子改成哪些地形。
 *
 * 排除三种：
 *   · `city` —— 城压在格子上，格子指向城，把城格改成水会得到一座悬空的城；
 *   · `void` —— "这里还没有东西"，只有空间站棋盘才有；
 *   · `bridge` —— 桥面是**由桥这个单位维持的**（`syncBridges` 每次动作后对账，
 *     没有桥单位的桥面会被打回水面）。事件直接写 `bridge` 会在下一手被悄悄改回去，
 *     作者会以为"改了没生效"。要修桥就让工兵去修。
 */
export type LevelTerrain = Exclude<Terrain, 'city' | 'void' | 'bridge'>;

/** 运行时白名单，和上面的类型一一对应（类型在运行期查不了，所以留一份） */
export const LEVEL_TERRAINS: readonly LevelTerrain[] = [
  'plain',
  'forest',
  'hill',
  'water',
  'shallow',
  'deep',
  'mountain',
  'plateau',
  'valley',
  'marsh',
  'dune',
  'regolith',
  'crater',
];

/**
 * 这一关怎么算赢。
 *
 * 只表达"谁赢"，**不表达"怎么输"**。这不是偷懒，是刻意的：原引擎的失败判定
 * （城丢光、没兵又造不起）本来就在跑，关卡不需要另写一套。于是：
 *   · 守城关：守满时限 → 提前判守方赢；城丢了 → 照普通规则判攻方赢。
 *   · 护送关：有人到达 → 判赢；护送方被灭 → 照普通规则判输。
 *
 * 好处是 `checkWinner` 只多一个"提前宣布赢"的分支，**原有判定一个字不动**，
 * 普通对局完全不受影响。这是批次 4 敢动这块地基的前提。
 */
export type LevelGoal =
  /** 守到第 `untilTurn` 次行动时（守方还活着）算赢 */
  | { kind: 'survive'; seat: PlayerId; untilTurn: number }
  /** 这一席的任意一个兵（或指定兵种）走进区域算赢 */
  /**
   * 这一席的任意一个兵（或指定兵种）走进区域算赢。
   *
   * `label` 是显示给人看的名字（"信使"）。不写就用 `unitType` 去全局兵种表查；
   * 关卡独有兵种查不到，那就只能显示 id —— 顶栏会写成"把「messenger」送到…"。
   */
  | { kind: 'escort'; seat: PlayerId; zone: LevelZone; unitType?: string; label?: string }
  /**
   * 斩首：`loser` 场上再没有该兵种的兵时，`winner` 赢。
   *
   * **限制**：这个兵种必须是"造不出来、这一关独有"的（关卡部署摆上去的那个）。
   * 否则对方一边死一边补同型兵，这个条件永远不会成立。P4 里没有关卡用它，
   * 留待以后给单位加"标记"之后再用它做真正的首领。
   */
  | { kind: 'assassinate'; winner: PlayerId; loser: PlayerId; unitType?: string; label?: string };

/** 胜利条件的人话版本。顶栏、选关页、开局战报都用它，免得三处各写一遍措辞 */
export function goalText(goal: LevelGoal): string {
  if (goal.kind === 'survive') return `守住 ${goal.untilTurn} 次行动`;
  if (goal.kind === 'escort') {
    const { x0, y0, x1, y1 } = goal.zone;
    const at = x0 === x1 && y0 === y1 ? `(${x0}, ${y0})` : `(${x0}, ${y0})–(${x1}, ${y1})`;
    const who = goal.label
      ? `「${goal.label}」`
      : goal.unitType
        ? `「${UNIT_TYPES[goal.unitType]?.name ?? goal.unitType}」`
        : '一个兵';
    return `把${who}送到 ${at}`;
  }
  const what = goal.label ?? (goal.unitType ? `「${goal.unitType}」` : '主力');
  return `消灭对方全部${what}`;
}

/**
 * 这一关对扩展的要求。
 *
 * 三档语义（面板上也是这么显示的）：
 *   · `require` 必须开：玩家没勾也强制加上；
 *   · `forbid` 禁用：玩家勾了也强制去掉；
 *   · 没提到的：**保留玩家自己的选择**。
 *
 * 为什么必须有这一条：关卡里的部署和事件会点名某个兵种。
 * 作者写了"刷两个剑修"，玩家把修真包关了，那不是"少个兵"，是开局就查不到兵种。
 * `require` 管的就是这件事。
 */
export interface LevelExpansionRules {
  /** 这一关必须开 */
  require?: string[];
  /** 这一关必须禁 */
  forbid?: string[];
  /**
   * 能开，但会让这一关明显变难——只是**提示**，不锁。
   *
   * 和 require/forbid 是三件不同的事：那两个是关卡对规则的硬要求（会改这一局怎么打），
   * 这个是作者对玩家的提醒（"加了这个，这一关会从难变成难玩"）。所以它不参与锁定，
   * 只出现在简报页和扩展列表上。
   *
   * 典型例子：孤城只有 3 个守兵，开了「闪电战」或「高机动性」之后，攻方的机动优势
   * 会被放大到无法应对。这种不该禁——玩家想挑战就该让他试——但得先说一声。
   */
  warn?: string[];
}

/**
 * 关卡里"这一局几家、谁在操作、多出来的两席城在哪"。
 *
 * 单独一层是因为它和地图格式无关：`FixedMap` 是**公开**的地图格式（玩家上传的那套），
 * 只有 A/B 两组城位；第三四席属于关卡自己知道的事，不该混进公开格式里。
 */
export interface LevelSeats {
  /** 这一关几家 */
  count: 2 | 3 | 4;
  /**
   * 第三、第四席的城（左上角）。A/B 用地图自带的那两组，这里只写多出来的。
   *
   * `count` 是 3 就必须给 C；是 4 就必须给 C 和 D。
   * **例外**：在 `cityless` 里点名的席位不需要城，见下面那个字段。
   */
  cities?: Partial<Record<'C' | 'D', MapPoint[]>>;
  /** 哪些席位由电脑操作。不写＝全是真人；写了 B 就是 B 交给电脑 */
  ai?: PlayerId[];
  /**
   * 逐席的开局时代。没写的席位用全局 `setup.startEra`。
   *
   * 只对"晚到的第三方"有意思：两家打了半局，第三家带着铁器时代的城和兵进场。
   * 注意城的 `era` 本来就逐城独立（收入、可造兵种、升级都读它），
   * 这里只是让建局时给某一席的城写一个别的数字，不是新机制。
   *
   * **时代的领先是暂时的**：玩家花钱升两三次城就追平。所以想让第三方真的强，
   * 要落在"入场那一刻的兵力和兵种"上，别指望科技差一直压着。
   */
  cityEra?: Partial<Record<PlayerId, number>>;  /**
   * **没有城的席位**（2026-11-16 新增）。
   *
   * 语义：这一席开局就没有城、没有产线、没有收入，靠 `deploy` 摆的兵打一场。
   * 出局条件跟着变：**兵打光即出局**（不是"城全丢光"——它从来没有城）。
   *
   * 用来表达"孤军""决斗图"这类玩法。三件事要注意：
   *   · 必须写 `deploy`，否则开局零兵＝第一帧就出局（校验会拦）；
   *   · 不能同时有城（`map.citiesA/B` 或 `seats.cities` 里给它城是自相矛盾的）；
   *   · **兵打光就输，引擎不看你后面还有没有援军**。带波次的关卡要自己保证前期不被打光。
   */
  cityless?: PlayerId[];
  /**
   * **同盟**（2026-11-16）：同一组里的席位互为友军。
   *
   * 不写＝每家各自为战（既有对局一个字都不变）。写了之后：
   *   · **不能互相攻击**（打兵、打城都拦）；
   *   · **可以穿过友军的单位**，但不能停在上面；
   *   · 胜负按**队**算：只剩一队活着才算结束（否则"打光敌人之后队友之间打不了，
   *     对局永远收不了场"）；
   *   · AI 不会把队友当目标。
   *
   * **视野不共享**：两人还是各看各的雾。共享了"两个人配合"就退化成"一个人操作两条线"，
   * 那不如直接让一个人玩两家。
   *
   * 每个坐人的席位必须**恰好**出现在一个队里；不写就是各家独立。
   */
  teams?: PlayerId[][];
  /**
   * 开局**不在场上**的席位。
   *
   * 和"出局"是两件事：出局是打没了，未登场是还没来。所以它不占回合、不算出局、
   * 不参与"还剩几家"的统计；地图上没有它的城，也没有它的兵。
   * 要靠一个 `deploy` 事件把它叫上场（那时才放城、摆兵）。
   *
   * 这一条是整套里最省事的表达方式：不用发明"中立阵营"，只是让某一席**晚一点上班**。
   */
  hidden?: PlayerId[];
}

/**
 * 关卡内容版本。
 *
 * 每一关自己带 `version`，改了内容就 +1。它的用处只有一个：
 * 读一份老存档时，能判断"这一局用的是这一关的哪一版"。
 * 不靠这个数字做迁移，只靠它说清"你打的那一局和现在这关不一样"。
 */
export const LEVEL_VERSION = 1;

export interface LevelDef {
  /** 唯一键，形如 `level:probe-flat`。以后玩家做的用 `user:<行号>` */
  id: string;
  /** 内容版本，改了就 +1（见上面） */
  version: number;
  name: string;
  /** 选关时显示的一句话。写"这一关要你干什么"，不要写剧情 */
  brief?: string;
  /**
   * 这一关的地图。建局时**优先于** `config.fixedMap`：
   * 关卡自带地图，就不该再让面板上那张随机图插一脚。
   */
  map: FixedMap;
  /**
   * 这一局几家、谁在操作、第三四席的城在哪。不写＝按面板上的选择走。
   *
   * 关卡一旦写了它，**就是这一关的硬设定**，玩家在面板上改不动
   * （改得动的只有"没被关节点掉的那些"，见批次 2 的扩展规则）。
   */
  seats?: LevelSeats;
  /** 写死的开局设定（时代 / 先手 / 双城）。没写的仍然归玩家 */
  setup?: LevelSetup;
  /**
   * 测试夹具：**不进玩家菜单**，只留给探针和自检。
   *
   * 这些图的存在意义是各验一条机制（部署、改地形、晚到的一家……），
   * 不追求好玩。放在选关列表里，玩家点进去只会觉得是半成品。
   * 关掉标记也不会删掉它们——探针二十多段全靠它们，删了等于把回归覆盖一起删。
   */
  dev?: boolean;
  /**
   * 这一关自带、别的对局里没有的兵种。
   *
   * 为什么不用全局兵种表加：`守将`这种是关卡概念，不该出现在别的对局的规则书、
   * 兵种池、AI 采购表里。放在这里，只在建局时合并进本局的 `unitTypes`。
   *
   * 想做"只此一个、谁也造不出"的单位，用 `summonedOnly: true`——那条标记
   * 的语义正好是"不进产线、AI 不采购"，引擎里已经跑通（AI 三处都跳过它）。
   */
  units?: Record<string, UnitTypeDef>;
  /**
   * **这一关禁用的兵种**（id 列表）：两边都不能招募、不能被建造单位盖出来。
   *
   * 和上面的 `units` 是两件相反的事：那个是"只在这一关存在的兵"，
   * 这个是"本来存在、但这一关不许造"的兵。
   *
   * 用处是**别让玩家用敌人的招牌兵反打敌人**——比如「邪龙」关，玩家自己
   * 各造一条邪龙王就能把对面碾了，剧情上也不成立（那是黑暗势力那边的东西）。
   *
   * 事件里的 `spawn` **不受影响**：禁的是"产线"，不是"兵种表"。
   * 这一关要禁玩家造邪龙王，但敌人那边照样得靠事件把它刷出来。
   * 已经在场上的兵也不会被删（读档、或者禁用是后来才加的）。
   */
  banUnits?: string[];
  /** 这一关专属的 AI 参数（见 `LevelAiTuning`）。不写＝用默认 AI */
  ai?: LevelAiTuning;
  /**
   * 每席开局的兵。**没写的席位照旧按规则自动撒**（这是"加字段不改变老行为"的写法：
   * 关卡没提这件事，就等于这件事不存在）。
   *
   * 写了就必须写全——写了两个兵就只有两个兵，不会再自动补开局部队，也不会送经济单位。
   * 作者要的是"这一关就这么几个人"，补两个农民上去会让数字对不上。
   *
   * 只校验结构（在界内、不重叠、兵种非空）；**这个兵种在这一局存不存在**
   * 要等 `createMatch` 拿到兵种表才知道，那边再查一次，查不到就跳过并在战报里说一声。
   */
  deploy?: Partial<Record<PlayerId, DeployUnit[]>>;
  /** 这一关要求 / 禁止的扩展（见 `LevelExpansionRules`）*/
  expansions?: LevelExpansionRules;
  /**
   * 这一关会发生什么。
   *
   * 按数组顺序检查；一次动作里若有多条同时成立，就按顺序全执行。
   * 不做"事件 A 触发事件 B"这种链式依赖——那需要一个"上一件事发生过"的条件，
   * 留给以后；现在多件事写在同一个 `do` 里就能表达同样的效果。
   */
  events?: LevelEvent[];
  /**
   * 怎么算赢。不写＝按普通规则（把对手打光）。
   *
   * 写了就是"**提前**宣布赢"：目标达成立刻结束，不必等对手出局。
   */
  goals?: LevelGoal[];
}

/**
 * 按"点几个格子"的方式拼地形行。
 *
 * 为什么不用手抄：`docs/MAPS-2026-11-01-fixed-and-upload.md` 里记着一次事故——
 * 32 行的地图手抄错了一个字符，肉眼完全看不出来，最后是靠 md5 对不上才发现的。
 * 地图是数据里最经不起手抖的一种，能生成就别抄。
 */
function rowsOf(w: number, h: number, paint: Array<[number, number, string]>): string[] {
  const grid = Array.from({ length: h }, () => Array.from({ length: w }, () => '.'));
  for (const [x, y, ch] of paint) {
    const row = grid[y];
    if (row && row[x] !== undefined) row[x] = ch;
  }
  return grid.map((r) => r.join(''));
}

/**
 * 「三岔口」的地形：一条竖河把左边那家和另外两家隔开，中间留三个格子的渡口。
 *
 * 为什么这么画：三方混战最怕"两家先隔着打、第三家看戏"。所以三家要**离得差不多**——
 * 红方在左中，蓝方在右上，绿方在右下，到中间渡口的步数接近。河只隔开红方，
 * 渡口在正中间，谁想偷袭谁都得从那片开阔地过。
 */
const TRI_PAINT: Array<[number, number, string]> = (() => {
  const out: Array<[number, number, string]> = [];
  // 竖河：x=7 一列，只有正中间三格能过
  for (let y = 0; y < 16; y += 1) {
    if (y < 6 || y > 8) out.push([7, y, '~']);
  }
  // 几片林子当掩体、几块丘陵当高地。不要多：多了 AI 会绕路绕到超时
  out.push([3, 3, 'f'], [4, 3, 'f'], [3, 4, 'f']);
  out.push([10, 6, 'f'], [11, 6, 'f'], [10, 7, 'f']);
  out.push([2, 9, 'h'], [3, 9, 'h'], [2, 10, 'h']);
  out.push([5, 12, 'f'], [6, 12, 'f'], [5, 13, 'f']);
  return out;
})();

/**
 * 「断后」的地形：一条竖河横在中间，只有一座桥。
 *
 * 这张图的全部意义在那座桥上——守方一个兵卡住桥面，攻方人多也得一个一个上。
 * 河其他地方一律不通（`~` 深水，陆军过不去），所以"走别处绕过去"不成立。
 */
const REAR_PAINT: Array<[number, number, string]> = (() => {
  const out: Array<[number, number, string]> = [];
  for (let y = 0; y < 14; y += 1) out.push([6, y, '~']);
  // 唯一的一座桥。写在河之后，把那一格的水盖成桥面
  out.push([6, 7, '=']);
  out.push([3, 3, 'f'], [4, 3, 'f'], [3, 4, 'f']);
  out.push([10, 10, 'f'], [10, 11, 'f'], [11, 10, 'f']);
  return out;
})();

/**
 * 「死守」的地形：两片林子当掩体，一块高地给守方架弓。
 *
 * 没有河也没有桥——这是 P4 的样本关，要验的是"守到某时"，不是地形。
 * 地形只负责让"守"这件事有一点讲究：弓手站高地，民兵堵缺口。
 */
const HOLD_PAINT: Array<[number, number, string]> = [
  [5, 5, 'f'], [6, 5, 'f'], [5, 6, 'f'], [6, 6, 'f'],
  [2, 3, 'f'], [3, 3, 'f'],
  [7, 8, 'h'], [8, 8, 'h'], [7, 9, 'h'], [8, 9, 'h'],
];

/**
 * 「断桥」的地形：一条竖河、一座桥。
 *
 * 这张图只为一件事而存在——**桥会在你眼前消失**。所以河要够宽（陆军过不去），
 * 桥要唯一，两边的兵都要看得见对方。
 */
const CUT_PAINT: Array<[number, number, string]> = (() => {
  const out: Array<[number, number, string]> = [];
  for (let y = 0; y < 14; y += 1) out.push([7, y, '~']);
  out.push([7, 7, '=']);
  out.push([4, 4, 'f'], [5, 4, 'f'], [4, 5, 'f']);
  out.push([9, 10, 'f'], [10, 10, 'f'], [9, 11, 'f']);
  out.push([3, 10, 'h'], [4, 11, 'h']);
  return out;
})();

/**
 * 内建关卡。
 *
 * 分两层，别混：
 *   · **玩家关**（没有 `dev` 标记）：孤城 / 斩首 / 黄雀 / 护送 / 邪龙。五张各教一件事——
 *     用地形换时间、集中兵力打一点、第三方与时机、无城护送穿越、两人合作守大图。
 *   · **测试夹具**（`dev: true`）：平地探针、断后、断桥、三岔口、死守。
 *     各验一条机制，不进玩家菜单，探针二十多段靠它们跑。
 */
/**
 * 「孤城」的地形：一条竖河、一座桥。和「断桥」同一副骨架，但这是一张**给人玩**的图：
 * 城只有一座，河对面有两座城，压力从第一轮就在。
 */
/**
 * 「孤城」的地形：**两列宽的河**、**2×2 的桥面**。
 *
 * 「桥宽」说的是**过河方向的通行格数**，不是桥跨了几列河。
 * 河是竖的、过河走横向，所以通行口宽不宽只看桥面在 **y 方向**占了几个格子：
 * 只画 (7,7)(8,7) 是"跨过两列河、但只开一个口子"，还是一个兵堵得死；
 * 要真的两格宽，桥面得是 (7,7)(8,7)(7,8)(8,8) 这四格。
 *
 * 为什么非要两个宽：
 *   · 一个格子的桥＝一个兵封死全场，守方派一个人堵在那儿就赢了一半；
 *   · 一列宽的河＝"弓箭手站在西岸白打东岸"（弓手射程 3，距离 2 就够）。
 *
 * 代价是图更挤，所以把对岸的城往后挪了两格（11 起），给前排留出缓冲。
 */
const SOLO_PAINT: Array<[number, number, string]> = (() => {
  const out: Array<[number, number, string]> = [];
  for (let y = 0; y < 14; y += 1) {
    out.push([7, y, '~']);
    out.push([8, y, '~']);
  }
  // 桥面 2×2：通行口两格宽，四个格子一起塌，守方没法"先堵一格再看情况"
  out.push([7, 7, '='], [8, 7, '='], [7, 8, '='], [8, 8, '=']);
  out.push([4, 4, 'f'], [5, 4, 'f'], [4, 5, 'f']);
  out.push([10, 6, 'h'], [10, 5, 'h']);
  return out;
})();

/**
 * 「护送」的地形：一条横长 18×8 的走廊。
 *
 * 没有河——这一关的主题是"快"不是"堵"。地形只做三件事：
 *   1. 中段几片林子和丘陵，是**天然的伏击点**（经过那里会刷追兵）；
 *   2. 上下两排丘陵把走廊压窄，逼护送队走中间、没法贴边绕；
 *   3. 右端 B 的城压住出口，玩家必须从城旁冲过去，而不是绕过去。
 */
const ESCORT_PAINT: Array<[number, number, string]> = (() => {
  const out: Array<[number, number, string]> = [];
  // 上下两排丘陵：把地图压成一条 3 格高的走廊（y=2..5 是主路）
  for (let x = 4; x < 15; x += 1) {
    out.push([x, 0, 'h'], [x, 1, 'h']);
    out.push([x, 6, 'h'], [x, 7, 'h']);
  }
  // 中段伏击点：一片林子 + 一块高地
  out.push([7, 3, 'f'], [8, 3, 'f'], [7, 4, 'f']);
  out.push([11, 4, 'h'], [11, 5, 'h']);
  return out;
})();

/**
 * 「邪龙」的地形：28×18 的大图，北面一道山脊，中央开一道裂隙。
 *
 * 为什么这么大：这关要的是"发育时间"。两座城摆在南边两角，敌人的空军从北面
 * 裂隙进来，光飞过来就要三四个回合——这段时间正是玩家造兵、升时代、把火枪
 * 架到高地上的窗口。小图会把这段窗口压没。
 *
 * 地形只做三件事：
 *   1. **山脊 + 裂隙**：视觉上告诉你"威胁从哪儿来"，也顺带给地面部队一点遮挡；
 *   2. **焦土**：裂隙正下方那片沙丘，是邪龙落过的地方（`full` 事件还会把它扩大）；
 *   3. **城前丘陵**：给火枪手一点射程优势——这是全图唯一"该站人"的地方。
 *
 * 注意：敌人全是**飞行单位**，山、河、林都拦不住它们。地形在这里是给玩家用的，
 * 不是给敌人用的。别指望靠地形把它们挡住。
 */
const DRAGON_PAINT: Array<[number, number, string]> = (() => {
  const W = 28;
  const out: Array<[number, number, string]> = [];
  // 北面山脊：y=0 整行，中央 x=12..15 是裂隙（邪龙进来的口子）
  for (let x = 0; x < W; x += 1) if (x < 12 || x > 15) out.push([x, 0, '^']);
  // 山脊向两侧延伸两行，把北面压成"只有中间能过"的样子
  for (let y = 1; y <= 2; y += 1) {
    for (let x = 0; x < 7; x += 1) out.push([x, y, '^']);
    for (let x = 21; x < W; x += 1) out.push([x, y, '^']);
  }
  // 裂隙下方的焦土（沙丘）
  for (let y = 1; y <= 6; y += 1) {
    for (let x = 11; x <= 16; x += 1) {
      if (y <= 2 && (x < 12 || x > 15)) continue; // 别盖住山脊
      out.push([x, y, 'd']);
    }
  }
  // 中段掩体：两片林子
  out.push([6, 7, 'f'], [7, 7, 'f'], [6, 8, 'f'], [7, 8, 'f'], [8, 8, 'f']);
  out.push([20, 7, 'f'], [21, 7, 'f'], [20, 8, 'f'], [21, 8, 'f'], [19, 8, 'f']);
  // 正中的一块高地：谁占了谁视野好，但离两座城都不近
  out.push([13, 10, 'h'], [14, 10, 'h'], [13, 11, 'h'], [14, 11, 'h']);
  // 两座城前的阵地（丘陵：火枪站上去多一格射程）
  out.push([9, 12, 'h'], [11, 12, 'h'], [10, 13, 'h']);
  out.push([15, 12, 'h'], [17, 12, 'h'], [16, 13, 'h']);
  // 两城之间的连接线上放两棵树，别让中间一片空
  out.push([13, 14, 'f'], [14, 14, 'f']);
  return out;
})();

export const LEVELS: LevelDef[] = [
  /* ── 玩家关 1：孤城（防守）────────────────────────────────── */
  {
    id: 'level:lone-city',
    version: LEVEL_VERSION,
    name: '孤城',
    brief: '14×14。你只有一座城，河对岸有两座。桥会被炸，水会退——撑到第 30 次行动。',
    map: {
      id: 'levelmap:lone-city',
      name: '孤城',
      w: 14,
      h: 14,
      rows: rowsOf(14, 14, SOLO_PAINT),
      citiesA: [{ x: 1, y: 6 }],
      citiesB: [
        { x: 11, y: 3 },
        { x: 11, y: 10 },
      ],
      source: 'builtin',
    },
    seats: { count: 2, ai: ['B'] },
    setup: { startEra: 1, firstSide: 'A' },
    ai: { riskAversion: 0.2, cohesion: 0, appetite: 3 },
    deploy: {
      A: [
        { type: 'lumberjack', x: 4, y: 4 },
        { type: 'militia', x: 4, y: 7 },
        { type: 'archer', x: 3, y: 7 },
        { type: 'militia', x: 4, y: 8 },
      ],
      B: [
        { type: 'militia', x: 9, y: 7 },
        { type: 'militia', x: 9, y: 8 },
        { type: 'militia', x: 10, y: 7 },
        { type: 'militia', x: 10, y: 8 },
        { type: 'archer', x: 10, y: 5 },
        { type: 'archer', x: 10, y: 6 },
        { type: 'archer', x: 10, y: 9 },
        { type: 'archer', x: 10, y: 10 },
        { type: 'tower', x: 9, y: 6 },
        { type: 'tower', x: 9, y: 9 },
      ],
    },
    goals: [{ kind: 'survive', seat: 'A', untilTurn: 30 }],
    expansions: { require:['era-arms'] , forbid: ['turn-order-comp', 'blackout', 'bloodbath'], warn: ['blitz', 'high-mobility'] },
    /*
     * 三段压力：
     *   1~5 次行动：
     *   第 11 次行动：整条河退成浅流——防线从 1 格变成 14 格，逼他把人收拢到城下硬撑。
     *
     * 第二段刻意**不写 `only`**：整条河一起变，包括桥墩那一格。
     * 留着桥墩是深坑也没用——那格谁都过不去，等于少一个突破点，压力反而不够。
     */
    events: [
      {
        id: 'flank-1',
        when: { kind: 'turn', at: 6 },
        do: [
          { kind: 'say', text: '北边冒出斥候，小心之后更多的援兵。' },
          { kind: 'spawn', owner: 'B', units: [{ type: 'scout', x: 2, y: 0 }] },
        ],
      },
      {
        id: 'wave-1',
        when: { kind: 'turn', at: 8 },
        do: [
          { kind: 'say', text: '对岸有人在动。' },
          { kind: 'spawn', owner: 'B', units: [{ type: 'knight', x: 12, y: 7 }] },
        ],
      },
      {
        id: 'blow',
        when: { kind: 'turn', at: 10 },
        do: [
          { kind: 'say', text: '桥被洪水冲垮了。' },
          { kind: 'terrain', zone: { x0: 7, y0: 0, x1: 8, y1: 13 }, to: 'deep' },
        ],
      },
      {
        id: 'wave-2',
        when: { kind: 'turn', at: 12 },
        do: [
          { kind: 'say', text: '东岸又有人在集结。' },
          { kind: 'spawn', owner: 'B', units: [{ type: 'knight', x: 12, y: 7 }, { type: 'knight', x: 12, y: 8 }] },
        ],
      },
      {
        id: 'flank-2',
        when: { kind: 'turn', at: 15 },
        do: [
          { kind: 'say', text: '北边骑兵绕行来了，南边也有先遣部队。' },
          { kind: 'spawn', owner: 'B', units: [{ type: 'knight', x: 2, y: 0 }, { type: 'scout', x: 3, y: 13 }] },
        ],
      },
      {
        id: 'wave-3',
        when: { kind: 'turn', at: 15 },
        do: [
          { kind: 'say', text: '又上来一队人，这次带着长弓手。' },
          { kind: 'spawn', owner: 'B', units: [{ type: 'knight', x: 12, y: 7 }, { type: 'knight', x: 12, y: 8 }, { type: 'longbow', x: 13, y: 7 }, { type: 'longbow', x: 13, y: 8 }] },
        ],
      },
      {
        id: 'ebb',
        when: { kind: 'turn', at: 18 },
        do: [
          { kind: 'say', text: '水位退了。整条河都能淌过去。' },
          { kind: 'terrain', zone: { x0: 7, y0: 0, x1: 8, y1: 13 }, to: 'shallow' },
        ],
      },
      {
        id: 'wave-4',
        when: { kind: 'turn', at: 18 },
        do: [
          { kind: 'say', text: '又上来一队长弓手。' },
          { kind: 'spawn', owner: 'B', units: [{ type: 'longbow', x: 13, y: 7 }, { type: 'longbow', x: 13, y: 8 }] },
        ],
      },
      {
        id: 'end',
        when: { kind: 'turn', at: 22 },
        do: [
          { kind: 'say', text: '河断流了。' },
          { kind: 'terrain', zone: { x0: 7, y0: 0, x1: 8, y1: 13 }, to: 'plain' },
        ],
      },
      {
        id: 'wave-5',
        when: { kind: 'turn', at: 22 },
        do: [
          { kind: 'say', text: '东岸又有人在集结。' },
          { kind: 'spawn', owner: 'B', units: [{ type: 'knight', x: 12, y: 7 }, { type: 'knight', x: 12, y: 8 }, { type: 'knight', x: 13, y: 7 }, { type: 'knight', x: 13, y: 8 }] },
        ],
      },
      {
        id: 'flank-3',
        when: { kind: 'turn', at: 24 },
        do: [
          { kind: 'say', text: '这次是南北夹击。' },
          { kind: 'spawn', owner: 'B', units: [{ type: 'knight', x: 2, y: 0 }, { type: 'knight', x: 3, y: 0 }, { type: 'knight', x: 2, y: 13 }, { type: 'knight', x: 3, y: 13 }] },
        ],
      },
    ],
  },

  /* ── 玩家关 2：斩首（进攻）────────────────────────────────── */
  {
    id: 'level:behead',
    version: LEVEL_VERSION,
    name: '斩首',
    brief: '12×12。敌方主帅缩在城下的箭塔后面。第 18 次行动之前杀掉他，否则他撑住了。',
    map: {
      id: 'levelmap:behead',
      name: '斩首',
      w: 12,
      h: 12,
      rows: rowsOf(12, 12, [
        [4, 3, 'f'], [5, 3, 'f'], [4, 4, 'f'],
        [7, 8, 'h'], [8, 8, 'h'], [7, 9, 'h'],
      ]),
      citiesA: [{ x: 1, y: 8 }],
      citiesB: [{ x: 9, y: 1 }],
      source: 'builtin',
    },
    seats: { count: 2, ai: ['B'] },
    setup: { startEra: 1, firstSide: 'A' },
    /*
     * 守将是一条 `summonedOnly` 的兵种：不进产线、AI 不采购，全图只有部署上来的这一个。
     * 这样"斩杀某个单位"才有确定的判定对象——用普通兵种的话，对面会一直补同型的兵。
     */
    units: {
      warden: {
        id: 'warden',
        name: '守将',
        short: '将',
        era: 1,
        category: 'combat',
        // 不可建造：钱数只是占位，产线根本不列它
        cost: 60,
        move: 2,
        atk: 18,
        armor: 9,
        maxHp: 70,
        range: 1,
        vision: 3,
        summonedOnly: true,
      },
    },
    deploy: {
      A: [
        { type: 'militia', x: 2, y: 7 },
        { type: 'archer', x: 3, y: 8 },
        { type: 'militia', x: 2, y: 9 },
        { type: 'militia', x: 4, y: 6 },
        { type: 'archer', x: 3, y: 10 },
      ],
      B: [
        { type: 'warden', x: 9, y: 3 },
        // 箭塔：强杀守将要先吃它的火力，除非先花两三个兵把塔拆了
        { type: 'tower', x: 8, y: 3 },
        { type: 'militia', x: 8, y: 4 },
        { type: 'archer', x: 8, y: 2 },
        { type: 'militia', x: 10, y: 4 },
        { type: 'archer', x: 7, y: 3 },
        { type: 'militia', x: 9, y: 4 },
      ],
    },
    /*
     * 两条目标同时挂着，按顺序判：
     *   1. 杀掉守将 → 玩家赢（写在前面，同一手同时成立时玩家优先）；
     *   2. 敌方撑满 15 次行动 → 敌方赢。
     *
     * 这样就得到了"限时击杀"，**不需要给胜负判定加任何新东西**——
     * 用的是已有的 assassinate + survive。
     */
    goals: [
      { kind: 'assassinate', winner: 'A', loser: 'B', unitType: 'warden', label: '守将' },
      { kind: 'survive', seat: 'B', untilTurn: 18 },
    ],
    events: [
      {
        /*
         * 让守将待在城里别乱跑。
         *
         * 电脑不会保护特定单位——不给它这条，它会自己把守将推上前线送掉，
         * 玩家三个回合就赢了，这关等于没有难度。
         */
        id: 'hold',
        when: { kind: 'turn', at: 1 },
        do: [{ kind: 'doctrine', seat: 'B', strategy: 'hold' }],
      },
    ],
  },

  /* ── 玩家关 3：黄雀（混战）────────────────────────────────── */
  {
    id: 'level:latecomer',
    version: LEVEL_VERSION,
    name: '黄雀',
    brief: '16×16。先和对面打。第 8 次行动，第三家带着铁器时代的兵从东南角进场。',
    map: {
      id: 'levelmap:latecomer',
      name: '黄雀',
      w: 16,
      h: 16,
      // 和「三岔口」同一副地形（一条竖河、中间一个渡口），换的是规则不是图
      rows: rowsOf(16, 16, TRI_PAINT),
      citiesA: [{ x: 1, y: 6 }],
      citiesB: [{ x: 12, y: 1 }],
      source: 'builtin',
    },
    seats: {
      count: 3,
      cities: { C: [{ x: 12, y: 12 }] },
      ai: ['B', 'C'],
      /*
       * 绿方开局**不在场上**：没有城、没有兵、不占回合。
       * 前 8 次行动就是红蓝两家的事。
       */
      hidden: ['C'],
      /*
       * 它一进城就是**铁器时代**的城：能直接造长枪兵、长弓手，
       * 不用像玩家那样先攒钱升城。这是它"后发而强"的全部来源。
       */
      cityEra: { C: 2 },
    },
    setup: { startEra: 1, firstSide: 'A' },
    deploy: {
      A: [
        { type: 'militia', x: 2, y: 6 },
        { type: 'archer', x: 3, y: 7 },
        { type: 'militia', x: 2, y: 8 },
        { type: 'militia', x: 3, y: 5 },
      ],
      B: [
        { type: 'militia', x: 11, y: 2 },
        { type: 'archer', x: 10, y: 3 },
        { type: 'militia', x: 11, y: 4 },
        { type: 'archer', x: 10, y: 5 },
      ],
      /*
       * 绿方入场时的兵：五个铁器兵。对它来说这是"开局"，对打了 8 次行动的
       * 两家来说这是**压过来的一堵墙**——所以数量不再给多，强在兵种和那座城。
       */
      C: [
        { type: 'spearman', x: 10, y: 11 },
        { type: 'spearman', x: 11, y: 11 },
        { type: 'longbow', x: 10, y: 13 },
        { type: 'longbow', x: 11, y: 13 },
        { type: 'knight', x: 9, y: 12 },
      ],
    },
    events: [
      {
        id: 'arrive',
        when: { kind: 'turn', at: 8 },
        do: [
          { kind: 'say', text: '东南角立起一座城——旌旗是铁器时代的。第三家来了。' },
          { kind: 'deploy', seat: 'C' },
          /*
           * 直接扑向人数最多的那一家。
           *
           * 光靠"时代高"不足以让 AI 把它当威胁（它算的是当下的兵力和威胁，
           * 不是科技），所以用一句指令把压力做实，而不是指望数值。
           */
          { kind: 'doctrine', seat: 'C', strategy: 'rush' },
        ],
      },
    ],
  },

  /* ── 玩家关 4：护送（无城 + 护送目标）────────────────────── */
  {
    id: 'level:escort',
    version: LEVEL_VERSION,
    name: '护送',
    brief: '18×8。你没有城，带着信使穿过走廊。东边城下一片箭塔，路上还有追兵。',
    map: {
      id: 'levelmap:escort',
      name: '护送',
      w: 18,
      h: 8,
      rows: rowsOf(18, 8, ESCORT_PAINT),
      citiesA: [],
      citiesB: [{ x: 15, y: 3 }],
      source: 'builtin',
    },
    seats: {
      count: 2,
      ai: ['B'],
      /*
       * 玩家**没有城**：没有产线、没有收入，开局这几个兵就是全部家底。
       *
       * 这正是这一关想展示的"孤军"玩法——护送一个目标穿越敌境，打不起也守不起，
       * 只能靠移动和走位。兵打光就输（cityless 的出局条件），所以护卫队不能乱送。
       */
      cityless: ['A'],
      /*
       * 敌方的城**压回青铜**：这一关的"玩家兵种领先"就落在这里。
       *
       * `setup.startEra` 是双方共用的开局时代——写成 2 的话 B 的城也是铁器城，
       * 一样能造长枪兵，领先就没了。所以单独把 B 的城按到时代 1：它只能造
       * 民兵/弓手/斥候，而玩家的护卫队是铁器兵（骑士/长弓/弩兵）。
       *
       * "城防高"不靠时代，靠**开局摆在城前的一片箭塔**（见下面的部署）：
       * 塔是静态建筑，只压路线、不滚雪球。之前试过把城时代抬到机械化来表示
       * "城硬"，结果城时代决定造兵时代，AI 直接刷坦克把护送队碾碎（实测踩过）。
       */
      cityEra: { B: 1 },
    },
    setup: { startEra: 3, firstSide: 'A' },
    /*
     * 开局兵力：一支**火器时代**的护卫队 + 一个信使。
     *
     * 玩家兵种领先（时代 2 铁器，对面青铜），但**没有城**——领先只体现在这
     * 几个兵身上，打完就没了。信使是护送目标，弱、跑不快，得有人护着。
     */
    deploy: {
      A: [
        // 信使单独在前，东边留出通道；护卫队散在两侧和后头，别把路堵死
        { type: 'messenger', x: 2, y: 3 },
        /*
         * 护卫队是**火器（第 3 代）**，敌城压在青铜：这是这一关的"科技优势"。
         *
         * 以前给的是铁器（骑士/长弓/弩兵），只领先一代——实机里 AI 开局就把城
         * 升上去，优势当场没了。两把火枪（射程 4、破甲）配戟兵顶线、骠骑兵收尾，
         * 对青铜的民兵/弓手是压着打；但只要 AI 把钱花在升级上，这个差距还是会被抹平
         * （见 `cityEra` 那段注释）。
         */
        { type: 'musketeer', x: 1, y: 2 },
        { type: 'musketeer', x: 1, y: 5 },
        { type: 'halberdier', x: 0, y: 4 },
        { type: 'hussar', x: 0, y: 2 },
      ],
      /*
       * 城防 = 五座箭塔围住城（射程 3，覆盖两条绕城通道）。
       *
       * 玩家要么先花回合清塔（塔 30 血、还会还手），要么拿护卫队顶火力硬冲。
       * 塔不会像"城造兵"那样滚雪球，压在路线上就是一道固定的墙——这正是
       * "城防高"该有的手感：你打不动它，只能想办法过去。
       */
      B: [
        { type: 'tower', x: 13, y: 2 }, // 北通道前哨
        { type: 'tower', x: 13, y: 5 }, // 南通道前哨
        { type: 'tower', x: 14, y: 3 }, // 城前正面
        { type: 'militia', x: 14, y: 4 },
        { type: 'archer', x: 14, y: 5 },
        { type: 'militia', x: 15, y: 2 },
      ],
    },
    /*
     * 关卡独有兵种：信使。
     *
     * 护送目标必须是一个**造不出来**的兵种（summonedOnly），否则 escort 的
     * unitType 指向一个普通兵种时，AI 也能造出来、场面就乱了。
     * 它没攻击力，但**跑得比谁都快**（move 4，轻骑快马）：塔阵从 x=10 就开始覆盖，
     * move 2 会在射程里多待两回合、直接被磨死。move 4 是"全速冲才活得下来"的那个数——
     * 实测：连挨两轮塔（14 + 21）刚好 35，36 血剩 1 点进终点。慢一步就死。
     */
    units: {
      messenger: {
        id: 'messenger',
        name: '信使',
        short: '信',
        era: 2,
        category: 'combat',
        cost: 1,
        move: 4,
        atk: 1,
        armor: 3,
        maxHp: 36,
        range: 1,
        vision: 2,
        summonedOnly: true,
      },
    },
    events: [
      {
        id: 'first-gate',
        when: { kind: 'turn', at: 1 },
        do: [
          { kind: 'say', text: '护送信使穿过走廊，到东边去。别让追兵追上。' },
          /*
           * 开局把**终点区域**点亮，亮 10 次行动（约 5 轮）。
           *
           * 区域必须和 `goals[].zone` **一模一样**（15..17 × 2..5）。以前这里写成
           * 14..17 × 1..6，比真正的终点大一圈——玩家看着"信使已经在亮着的区域里了"，
           * 其实还差一列（x=14 不算），于是"到了却没赢"。亮区就是判定区，
           * 别让它俩有任何差别。
           */
          { kind: 'reveal', zone: { x0: 15, y0: 2, x1: 17, y1: 5 }, turns: 10 },
        ],
      },
      /*
       * 经过中段伏击点（x=7 那片林子）时，追兵从北边冒出来。
       *
       * 用 `enter` + 指定 owner：只有当**你的兵**踩进那片区域才触发，
       * 追兵不会因为自己的兵路过就自己刷自己。
       */
      {
        id: 'ambush-1',
        when: { kind: 'enter', zone: { x0: 7, y0: 3, x1: 8, y1: 4 }, owner: 'A' },
        do: [
          { kind: 'say', text: '北边的林子后头窜出一队追兵！' },
          { kind: 'spawn', owner: 'B', units: [{ type: 'militia', x: 8, y: 2 }, { type: 'archer', x: 9, y: 2 }] },
          // 伏兵的位置亮一下就走（默认 1 次）：玩家看清"那儿有人"，下一手重新没入迷雾
          { kind: 'reveal', zone: { x0: 7, y0: 1, x1: 10, y1: 3 } },
        ],
      },
      /*
       * 再往前走，接近出口时又来一拨——这一拨从**身后**追，堵住退路。
       */
      {
        id: 'ambush-2',
        when: { kind: 'enter', zone: { x0: 11, y0: 3, x1: 12, y1: 5 }, owner: 'A' },
        do: [
          { kind: 'say', text: '身后又追上来一队——退路被断了。' },
          /*
           * 追兵用**青铜兵**（民兵），比玩家的铁器兵弱：玩家单挑打得过，
           * 但它们是**从身后堵退路**的，逼玩家往前、不能回头磨。
           */
          { kind: 'spawn', owner: 'B', units: [{ type: 'militia', x: 6, y: 4 }, { type: 'militia', x: 6, y: 5 }] },
          { kind: 'reveal', zone: { x0: 5, y0: 3, x1: 7, y1: 6 } },
        ],
      },
      /*
       * 信使一旦倒下，这一关就输了（escort 目标永远不成立）。
       * 兵死触发一句播报，让玩家立刻知道"护送目标没了"。
       */
      {
        id: 'messenger-down',
        when: { kind: 'unitDied', type: 'messenger' },
        do: [{ kind: 'say', text: '信使倒下了——护送失败了。' }],
      },
    ],
    /*
     * 胜利：信使走进东边终点区（x≥15）。
     *
     * escort 的 unitType 指向信使，所以只有它到达才算赢，护卫队到没用。
     * 失败不用另写：cityless 的"兵打光即输"自动兜住。
     */
    goals: [
      {
        kind: 'escort',
        seat: 'A',
        zone: { x0: 15, y0: 2, x1: 17, y1: 5 },
        unitType: 'messenger',
        label: '信使',
      },
    ],
  },

  /* ── 玩家关 5：邪龙（两人合作）────────────────────────────── */
  {
    id: 'level:evil-dragon',
    version: LEVEL_VERSION,
    name: '邪龙',
    brief: '28×18，两人各守一座城。北面裂隙里会不断飞出龙——先攒兵，再谈反击。',
    map: {
      id: 'levelmap:evil-dragon',
      name: '邪龙',
      w: 28,
      h: 18,
      rows: rowsOf(28, 18, DRAGON_PAINT),
      citiesA: [{ x: 9, y: 14 }],
      citiesB: [{ x: 16, y: 14 }],
      source: 'builtin',
    },
    seats: {
      count: 3,
      /*
       * A、B 是两个真人（热座或联机），C 是电脑控制的邪龙军团。
       * `teams` 一写，A/B 就不能互打、可以穿过对方的兵，胜负也按队算——
       * 打光邪龙那一队就一起赢。
       */
      ai: ['C'],
      cityless: ['C'],
      teams: [['A', 'B'], ['C']],
    },
    /*
     * 开局时代定在 6（信息化）：玩家一上来就有打得动重甲、够得着空中的兵，
     * 收入也够连着造——这就是"发育准备"的起点。
     *
     * 不是白送：敌人是第五、六代的飞行单位（恶魔 78 血 42 攻、骷髅飞龙 92 血、
     * 邪龙王 190 血）。从青铜/铁器起手的话，第一批龙飞到时玩家还在攒弓箭手。
     */
    setup: { startEra: 6, firstSide: 'A' },
    /*
     * 固定三个包：
     *   · **fantasy**：邪龙王、恶魔、骷髅飞龙、龙骑兵全在奇想里，这是这一关的主角；
     *   · **air**：玩家的"眼睛"。开局送的两只侦察气球（9 格视野）负责看见北面
     *     裂隙里什么时候出来东西——没有它，开雾的图上玩家只能干等；
     *   · **pack-contemporary**：玩家开局第六代（信息化）要靠它，邪龙王自己也是
     *     兵种级 requiresPack（不写这个包，`s.unitTypes['evil-dragon-king']` 不存在，
     *     事件刷兵只会留一句系统日志）。
     */
    expansions: { require: ['fantasy', 'air', 'pack-contemporary'] },
    /*
     * 禁用兵种：**黑暗势力那一套玩家不该有**。
     *
     * 不禁的话，两个玩家各造一条邪龙王就能把对面碾了（190 血、range 4），
     * 而且从情境上说不通——那是对面军团的招牌。
     *
     * 禁的是**产线**：事件里的 `spawn` 不受影响，敌人照样按波次把这几样放出来。
     * 5 代以上的奇想英雄（至尊法师、天使、圣剑勇者）一起禁，理由同上：
     * 这一关的神话战力只该出现在邪龙那一边。
     */
    banUnits: [
      'evil-dragon-king',
      'demon',
      'bone-dragon',
      'dragoon-rider',
      'archmage',
      'angel',
      'sword-saint',
    ],
    /*
     * 三个旋钮 + 一个僵局压力：
     *   · riskAversion 0.3：愿意用伤亡换推进，但不至于站着送；
     *   · cohesion 0：不等队友，谁快谁先上；
     *   · appetite 3：推进分放大三倍；
     *   · pressure 2：**越拖越压**。观战里出现过"三方都不动"的稳定态——
     *     攻方压在圈外、守方缩在城里，每回合的最优解都是"别动"。
     *     光把前面三项拉满治不了这个（它们改的是"怕不怕死"，不是"拖下去值不值得动"），
     *     所以再加一条随回合加码的推进分：turn 25 时 ×2、turn 50 时 ×3、封顶 ×4；
     *     核心 AI 认为"没事可做"时还会督战推进一步（见 ai.ts 的 `pressureAdvance`）。
     */
    ai: { riskAversion: 0.3, cohesion: 0, appetite: 3, pressure: 1 },
    /*
     * 开局兵力：每城一辆坦克、两个步兵班、两个重机枪组、一个建筑队，
     * 外加两只侦察气球。
     *
     * **一个近战都不给**：敌人全是飞行单位，射程 1 的兵（戟兵、骠骑兵）
     * 按 canStrike 的"地面打空中要够得着"根本打不到，给了只会让玩家以为
     * "我有一队兵"然后看着它们站着不动。
     * 坦克（88 血 10 甲）顶在前面，步兵班/重机枪是输出，建筑队拉经济。
     */
    deploy: {
      A: [
        { type: 'tank', x: 10, y: 12 },
        { type: 'squad', x: 9, y: 13 },
        { type: 'squad', x: 9, y: 11 },
        { type: 'hmg', x: 11, y: 13 },
        { type: 'hmg', x: 10, y: 11 },
        { type: 'crew', x: 8, y: 14 },
        /*
         * 两只侦察气球：不能打、一碰就掉，但视野 9——全游戏最便宜的"看见"。
         *
         * 这一关开雾，敌人的空军从北面十几格外飞过来。没有气球的话，玩家只能
         * 盯着雾等第一波砸到脸上；有了它，至少能提前两三个回合知道"来了几条、
         * 从哪个方向绕"。气球迷失不影响胜负，掉了再造（空军包已经强制开）。
         */
        { type: 'af_balloon', x: 10, y: 10 },
        { type: 'af_balloon', x: 12, y: 13 },
      ],
      B: [
        { type: 'tank', x: 16, y: 12 },
        { type: 'squad', x: 17, y: 13 },
        { type: 'squad', x: 17, y: 11 },
        { type: 'hmg', x: 15, y: 13 },
        { type: 'hmg', x: 16, y: 11 },
        { type: 'crew', x: 18, y: 14 },
        { type: 'af_balloon', x: 16, y: 10 },
        { type: 'af_balloon', x: 14, y: 13 },
      ],
      /*
       * 邪龙开局就有一个先遣：一条龙骑兵在北面裂隙外。
       *
       * 它不是为了立刻打人——它离两座城 13 格，飞过来要三个回合。
       * 它是**这一席的存在证明**：cityless 席位的出局条件是"兵打光"，
       * 开局一个兵都没有的话，第一帧就判 C 出局、玩家什么都没干就赢了。
       */
      C: [{ type: 'dragoon-rider', x: 13, y: 1 }, { type: 'dragoon-rider', x: 14, y: 1 }],
    },
    events: [
      /*
       * 开场：告诉玩家"威胁从北面来"，并把裂隙点亮一段（12 次行动≈6 轮）。
       *
       * 开雾的局里，玩家看不见北面那一片，也就不知道敌人在哪、还有多远。
       * 点亮不是永久信息，看够就熄——后面的侦察仍然要自己做。
       */
      {
        id: 'omen',
        when: { kind: 'turn', at: 1 },
        do: [
          { kind: 'say', text: '北面的山裂开了一道缝。有东西要下来了——趁现在把兵攒起来。' },
          { kind: 'reveal', zone: { x0: 11, y0: 0, x1: 16, y1: 6 }, turns: 12 },
        ],
      },

      /*
       * 第一波：再补一条龙骑兵。
       *
       * 从第 5 次行动开始——玩家已经有两次自己的回合可以造兵/挪人。
       * 之后每 4 次行动一波，一波比一波重，直到邪龙王本体下场。
       * 节奏是"给你喘气的时间，但不给太多"。
       */
      {
        id: 'wave-1',
        when: { kind: 'turn', at: 7 },
        do: [
          { kind: 'say', text: '又一队龙骑兵从裂隙里钻出来，贴着山脊往南飞。' },
          {
            kind: 'spawn',
            owner: 'C',
            units: [
              { type: 'dragoon-rider', x: 14, y: 1 },
              { type: 'dragoon-rider', x: 14, y: 2 },
              { type: 'dragoon-rider', x: 12, y: 1 },
              { type: 'dragoon-rider', x: 12, y: 2 },
            ],
          },
          { kind: 'reveal', zone: { x0: 11, y0: 0, x1: 16, y1: 6 }, turns: 3 },
        ],
      },
      {
        id: 'wave-2',
        when: { kind: 'turn', at: 12 },
        do: [
          { kind: 'say', text: '一些恶魔跟着下来了。' },
          {
            kind: 'spawn',
            owner: 'C',
            units: [
              { type: 'demon', x: 12, y: 1 },
              { type: 'demon', x: 14, y: 1 },
              { type: 'dragoon-rider', x: 12, y: 2 },
              { type: 'dragoon-rider', x: 14, y: 2 },
            ],
          },
          // 让 AI 从这一波开始主动扑：前两波它会先打最近的兵，这一波之后盯着城
          { kind: 'doctrine', seat: 'C', strategy: 'rush' },
          { kind: 'reveal', zone: { x0: 11, y0: 0, x1: 16, y1: 7 }, turns: 3 },
        ],
      },

      /*
       * 第三波：骷髅飞龙。它带 `siege-master`，是专门拆城的那个——
       * 播报要点明，否则玩家看着城血掉得莫名其妙。
       */
      {
        id: 'wave-3',
        when: { kind: 'turn', at: 17 },
        do: [
          { kind: 'say', text: '骷髅飞龙从云里钻出来了——它专门拆城，别让它靠近。' },
          { kind: 'spawn', owner: 'C', units: [
            { type: 'bone-dragon', x: 13, y: 1 },
            { type: 'bone-dragon', x: 13, y: 2 },
            { type: 'demon', x: 12, y: 1 },
            { type: 'demon', x: 14, y: 1 },
            { type: 'dragoon-rider', x: 12, y: 2 },
            { type: 'dragoon-rider', x: 14, y: 2 },
          ] },
          { kind: 'reveal', zone: { x0: 10, y0: 0, x1: 17, y1: 8 }, turns: 3 },
        ],
      },

      /*
       * 完全体：邪龙王 + 一整队随从。
       *
       * 这一刻是这一关的"下半场"。之前所有波次都是在逼玩家别停下来发育；
       * 这一波之后就没得发育了，只能硬接。
       * 顺带把中央那片烧成焦土——纯气氛，但对玩家是个信号："它真的来了"。
       */
      {
        id: 'full',
        when: { kind: 'turn', at: 26 },
        do: [
          { kind: 'say', text: '天黑了。邪龙王亲自下来了——它身后还跟着一整队。' },
          {
            kind: 'spawn',
            owner: 'C',
            units: [
              { type: 'evil-dragon-king', x: 13, y: 1 },
              { type: 'bone-dragon', x: 11, y: 1 },
              { type: 'bone-dragon', x: 11, y: 2 },
              { type: 'demon', x: 14, y: 1 },
              { type: 'demon', x: 14, y: 2 },
              { type: 'dragoon-rider', x: 12, y: 1 },
              { type: 'dragoon-rider', x: 12, y: 2 },
            ],
          },
          { kind: 'terrain', zone: { x0: 10, y0: 7, x1: 17, y1: 12 }, to: 'dune' },
          { kind: 'doctrine', seat: 'C', strategy: 'rush' },
          { kind: 'reveal', zone: { x0: 8, y0: 0, x1: 19, y1: 10 }, turns: 4 },
        ],
      },

      /*
       * 邪龙王倒下：这一关的"心理终点"。
       *
       * 它一死，剩下那些飞龙虽然还在，但玩家已经知道赢定了。
       * 不刷兵、不改规则——只给一句话，别让胜利在沉默里发生。
       */
      {
        id: 'dragon-down',
        when: { kind: 'unitDied', type: 'evil-dragon-king' },
        do: [{ kind: 'say', text: '邪龙王栽下去了。剩下的不过是一群没了主人的野兽——清干净。' }],
      },
    ],
  },

  {
    id: 'level:probe-flat',
    version: LEVEL_VERSION,
    dev: true,
    name: '平地探针',
    brief: '12×12 全平地，两座城。不是给人玩的关卡，用来验证链路。',
    map: {
      id: 'levelmap:probe-flat',
      name: '平地探针',
      w: 12,
      h: 12,
      // 用生成而不是手抄：历史上手抄 32 行地形抄错过一个字符，
      // 肉眼完全看不出来，最后是靠 md5 对不上才发现的。
      rows: Array.from({ length: 12 }, () => '.'.repeat(12)),
      citiesA: [{ x: 1, y: 10 }],
      citiesB: [{ x: 8, y: 1 }],
      source: 'builtin',
    },
    seats: { count: 2, ai: [] },
    setup: { startEra: 1, firstSide: 'A' },
  },
  {
    id: 'level:tri-corner',
    version: LEVEL_VERSION,
    dev: true,
    name: '三岔口',
    brief: '16×16，三家分立：红蓝两家由真人操作，绿方是电脑，见谁都打。',
    map: {
      id: 'levelmap:tri-corner',
      name: '三岔口',
      w: 16,
      h: 16,
      rows: rowsOf(16, 16, TRI_PAINT),
      // 红方左中、蓝方右上、绿方右下
      citiesA: [{ x: 1, y: 6 }],
      citiesB: [{ x: 12, y: 1 }],
      source: 'builtin',
    },
    seats: {
      count: 3,
      // 第三家的城不在地图格式里（FixedMap 只有 A/B 两组），由关卡自己带
      cities: { C: [{ x: 12, y: 12 }] },
      // 绿方交给电脑。红蓝留给玩家——这就是"两个玩家对打 + 电脑骚扰"。
      ai: ['C'],
    },
    // 三家分立全靠地形，跟科技没关系；锁青铜，免得玩家带坦克进来
    setup: { startEra: 1 },
  },
  {
    id: 'level:rear-guard',
    version: LEVEL_VERSION,
    dev: true,
    name: '断后',
    brief: '14×14，一座桥。你只有 1 个兵，对面 5 个，守住 24 次行动等援军。',
    map: {
      id: 'levelmap:rear-guard',
      name: '断后',
      w: 14,
      h: 14,
      rows: rowsOf(14, 14, REAR_PAINT),
      citiesA: [{ x: 2, y: 7 }],
      citiesB: [{ x: 11, y: 7 }],
      source: 'builtin',
    },
    seats: { count: 2, ai: ['B'] },
    /*
     * 锁青铜 + 守方先手。
     *
     * 时代一放开，玩家就能把开局金币从 120 抬到上千金——这张图的全部设计
     * （一个兵能扛多久）立刻失效。先手也锁：让攻方先动等于白送一回合。
     */
    setup: { startEra: 1, firstSide: 'A' },
    /*
     * 开局兵力由关卡写死：守方一个民兵卡在桥面，攻方五个兵在河东岸。
     *
     * 写了部署就**不再自动撒开局部队、也不送经济单位**——否则"你只有 1 个兵"
     * 这句话当场变成三个兵，作者要的数字对不上。
     */
    deploy: {
      A: [{ type: 'militia', x: 6, y: 7 }],
      B: [
        { type: 'militia', x: 10, y: 5 },
        { type: 'archer', x: 10, y: 6 },
        { type: 'archer', x: 9, y: 7 },
        { type: 'militia', x: 9, y: 8 },
        { type: 'militia', x: 10, y: 9 },
      ],
    },
    /*
     * 扩展规则的两个真实理由，不是凑数：
     *   · **必须开「哀兵必胜」**：这张图的主题就是"城丢了反而更能打"，不开这一包，
     *     守方没有任何翻盘手段，五个兵碾过来就完了；
     *   · **禁用「先后手补偿」**：这张图是不对称布阵（1 打 5），后手再补一笔金币，
     *     等于把作者好不容易调出来的强弱差悄悄抹掉一截。
     */
    expansions: {
      require: ['last-stand'],
      forbid: ['turn-order-comp'],
    },
    /*
     * 三个事件，把 P3 的三种条件、三种动作都跑一遍：
     *   · 第 3 次行动时，攻方来了一队援兵（turn + spawn + say）；
     *   · 攻方有人踩上西岸，提醒玩家"过桥了"（enter + say）；
     *   · 守桥那个兵倒下，攻方转成猛攻（unitDied + say + doctrine）。
     *
     * 回合数用的是**行动序号**（`turn`），不是"第几轮"。两家局里一轮 = 两次行动，
     * 所以写 3 显得很早——这是故意的：这一关本来就只有几个回合的缓冲。
     */
    events: [
      {
        id: 'reinforce',
        when: { kind: 'turn', at: 3 },        do: [
          { kind: 'say', text: '对岸的旌旗又多了两面——他们加了人。' },
          {
            kind: 'spawn',
            owner: 'B',
            units: [
              { type: 'militia', x: 11, y: 5 },
              { type: 'archer', x: 11, y: 9 },
            ],
          },
        ],
      },
      {
        id: 'crossed',
        /*
         * 走"推到桥头"而不是"踩上桥面"。
         *
         * 一开始写的是"攻方踏上桥面"（甚至更早写的是"过到西岸"），结果实战里几乎不成立：
         * 守方会不断补兵堵桥头，攻方的兵可能几十个回合都踩不到那一格。**一个永远不触发
         * 的事件比没有还糟**——作者会以为是自己写错了。改成东岸紧贴桥那一格（7,7）：
         * 攻方推进的第一步就会经过它。
         */
        when: { kind: 'enter', zone: { x0: 7, y0: 7, x1: 7, y1: 7 }, owner: 'B' },
        do: [{ kind: 'say', text: '他们推到桥头了，桥随时会丢。' }],
      },
      {
        id: 'bridge-lost',
        when: { kind: 'unitDied', owner: 'A' },
        do: [
          { kind: 'say', text: '桥头那个兵倒下了。' },
          { kind: 'doctrine', seat: 'B', strategy: 'rush' },
        ],
      },
    ],
    /*
     * 守到第 24 次行动算赢。
     *
     * 没有这条，这一关会**永远打不完**：一个兵卡在唯一的桥面上，攻方再多也过不来，
     * 而"打光对方"这个默认条件永远不成立。（2026-11-15 修好"地图桥不该自己塌"
     * 之后才暴露出来——在那之前守桥兵第一手就淹死了，所以看着"能打完"。）
     */
    goals: [{ kind: 'survive', seat: 'A', untilTurn: 24 }],
  },
  {
    id: 'level:hold-out',
    version: LEVEL_VERSION,
    dev: true,
    name: '死守',
    brief: '12×12，守住 20 次行动。城破了就输——这是第一张能赢也能输的关卡。',
    map: {
      id: 'levelmap:hold-out',
      name: '死守',
      w: 12,
      h: 12,
      rows: rowsOf(12, 12, HOLD_PAINT),
      citiesA: [{ x: 1, y: 8 }],
      citiesB: [{ x: 8, y: 1 }],
      source: 'builtin',
    },
    seats: { count: 2, ai: ['B'] },
    /*
     * 锁青铜 + 守方先手。
     *
     * 时代一放开，玩家就能把开局金币从 120 抬到上千金——这张图的全部设计
     * （3 个兵能扛多久）立刻失效。先手也锁：让攻方先动等于白送一回合。
     */
    setup: { startEra: 1, firstSide: 'A' },
    /*
     * 3 打 6。守方靠城、林子和高地撑着，攻方人多但要走过来。
     * 这个比例是估的，没实测——P7 打磨内容时要按实机胜率再调。
     */
    deploy: {
      A: [
        { type: 'militia', x: 2, y: 7 },
        { type: 'archer', x: 3, y: 8 },
        { type: 'militia', x: 3, y: 9 },
      ],
      B: [
        { type: 'militia', x: 8, y: 4 },
        { type: 'archer', x: 9, y: 4 },
        { type: 'militia', x: 10, y: 3 },
        { type: 'archer', x: 7, y: 5 },
        { type: 'militia', x: 8, y: 6 },
        { type: 'militia', x: 9, y: 6 },
      ],
    },
    /** 撑到第 20 次行动就算赢；城破了照普通规则判输 */
    goals: [{ kind: 'survive', seat: 'A', untilTurn: 20 }],
    events: [
      {
        id: 'relief',
        when: { kind: 'turn', at: 10 },
        do: [
          { kind: 'say', text: '后面来人了——援军到了，堵上去。' },
          {
            kind: 'spawn',
            owner: 'A',
            units: [
              { type: 'militia', x: 3, y: 10 },
              { type: 'militia', x: 4, y: 10 },
            ],
          },
        ],
      },
    ],
  },
  {
    id: 'level:cut-bridge',
    version: LEVEL_VERSION,
    dev: true,
    name: '断桥',
    brief: '14×14，一座桥。第 4 次行动桥被炸掉，第 8 次行动水退了——守住 10 次行动。',
    map: {
      id: 'levelmap:cut-bridge',
      name: '断桥',
      w: 14,
      h: 14,
      rows: rowsOf(14, 14, CUT_PAINT),
      citiesA: [{ x: 2, y: 6 }],
      citiesB: [{ x: 10, y: 6 }],
      source: 'builtin',
    },
    seats: { count: 2, ai: ['B'] },
    setup: { startEra: 1, firstSide: 'A' },
    deploy: {
      A: [
        { type: 'militia', x: 5, y: 6 },
        { type: 'archer', x: 5, y: 7 },
        { type: 'militia', x: 4, y: 8 },
      ],
      B: [
        { type: 'militia', x: 8, y: 5 },
        { type: 'archer', x: 8, y: 6 },
        { type: 'militia', x: 8, y: 7 },
        { type: 'militia', x: 8, y: 8 },
        { type: 'archer', x: 9, y: 9 },
      ],
    },
    goals: [{ kind: 'survive', seat: 'A', untilTurn: 10 }],
    /*
     * 两次改地形，一次比一次"不合理"，但都是设计：
     *   · 第 4 次行动：桥没了。攻方五个人全堵在东岸，只能隔河干瞪眼；
     *   · 第 8 次行动：水退了，河变成浅流，陆军能涉水过来——最后一搏。
     * 第二件事专门用了 `only: ['water']`：桥墩那一格现在是深水，
     * 不该跟着一起变浅，正好把"只改指定地形"这条也走一遍。
     */
    events: [
      {
        id: 'blow-bridge',
        when: { kind: 'turn', at: 4 },
        do: [
          { kind: 'say', text: '轰的一声——桥没了。' },
          { kind: 'terrain', zone: { x0: 7, y0: 7, x1: 8, y1: 7 }, to: 'deep' },
        ],
      },
      {
        id: 'ebb',
        when: { kind: 'turn', at: 8 },
        do: [
          { kind: 'say', text: '水位落下去了一截，河床露了出来——他们能淌过来了。' },
          { kind: 'terrain', zone: { x0: 7, y0: 0, x1: 7, y1: 13 }, to: 'shallow', only: ['water'] },
        ],
      },
    ],
  },
];

/**
 * 内置关卡之外的来源（玩家在本机做的那些）。
 *
 * 用"注册回调"而不是直接 import `userLevels.ts`，是为了**避免循环依赖**：
 * 那个文件要 import `validateLevel`，这里再反过来 import 它，启动时就会炸。
 * 回调是惰性的，`allLevels()` 每次现取——玩家刚存的一张关，下一次问就在了。
 *
 * 一个来源抛错不该让整个注册表消失（表现会是"所有关卡都不见了"），所以逐个 try。
 */
const extraSources: Array<() => LevelDef[]> = [];

export function registerLevelSource(fn: () => LevelDef[]): void {
  if (!extraSources.includes(fn)) extraSources.push(fn);
}

function extraLevels(): LevelDef[] {
  if (extraSources.length === 0) return [];
  const out: LevelDef[] = [];
  for (const fn of extraSources) {
    try {
      out.push(...fn());
    } catch {
      // 一个来源坏了就当它没贡献，别连累内置关卡
    }
  }
  return out;
}

/**
 * 全部关卡（含测试夹具、含玩家做的）。探针、自检、内部跳转用它。
 *
 * **玩家菜单不该用它**——那种地方要用 `playableLevels()`，否则"1 个兵打 5 个"
 * 这种专门用来验机制的图会出现在选关列表里，玩家点进去只会觉得是半成品。
 */
export function allLevels(): LevelDef[] {
  const extra = extraLevels();
  // 没有外部来源时返回同一个数组引用：老代码（和探针）里 `=== LEVELS` 用得着
  return extra.length > 0 ? [...LEVELS, ...extra] : LEVELS;
}

/** 玩家能选到的关卡（去掉 `dev` 那些测试夹具） */
export function playableLevels(): LevelDef[] {
  return allLevels().filter((l) => l.dev !== true);
}

/**
 * 按 id 找关卡。**先内置、后玩家**：同 id 时内置优先，
 * 这样玩家不可能用一个自制关卡顶掉"孤城"（表现会非常难查）。
 */
export function levelById(id: string | null | undefined): LevelDef | null {
  if (!id) return null;
  return LEVELS.find((l) => l.id === id) ?? extraLevels().find((l) => l.id === id) ?? null;
}

/**
 * "选了哪一关" → 一份开局配置。
 *
 * **只在这里翻译一次。** 面板和脚本都走这条，谁也不许自己去读
 * `level.seats.count` / `level.seats.ai` —— 两处各读一份，迟早有一处漏掉，
 * 表现就是"面板上写着三家、建出来是两家"，而且不报错。
 *
 * 传 `null` 就是"不玩关卡"：把 `level` 清掉，其余设置原样留着
 * （地图、人数、对手都还是玩家上一次选的，不用重选）。
 *
 * 关卡自带地图，所以顺手把 `fixedMap` 清空：两份地图同时躺在 config 里，
 * 谁也说不清最后用的是哪一份。
 */
export function applyLevelToConfig(base: MatchConfig, level: LevelDef | null): MatchConfig {
  if (!level) return { ...base, level: undefined };
  const s = level.setup;
  return {
    ...base,
    level,
    fixedMap: undefined,
    /*
     * 关卡是"照着打的一局"，不是沙盒也不是观战：
     * 上帝模式、指挥官模式、选卡都在这一层关掉。
     *
     * 光在界面上把它们灰掉是不够的——配置会跟着存档、房间、分享链接传，
     * 而且"上一个关卡"留下的模式会被带进下一关（`applyLevelToConfig` 是拷贝 base 的）。
     */
    godMode: false,
    commanderMode: false,
    draftMode: false,
    // 选了关卡，尺寸就是关卡地图的尺寸；面板上那个数字跟着走，免得显示和事实相反
    size: level.map.w,
    playerCount: level.seats?.count ?? base.playerCount,
    // 关卡没规定托管就沿用面板（"这一关没意见，你自己挑"）
    ...(level.seats?.ai !== undefined ? { aiSeats: [...level.seats.ai] } : {}),
    // 开局设定：写死的就覆盖，没写的（＝这一关不在乎）保留玩家原来的选择
    ...(s?.startEra !== undefined ? { startEra: s.startEra } : {}),
    ...(s?.firstSide !== undefined ? { firstSide: s.firstSide } : {}),
    ...(s?.twoCities !== undefined ? { twoCities: s.twoCities } : {}),
  };
}

/**
 * 校验一份"来路不明"的关卡数据，顺便返回一份**深拷贝**。
 *
 * 两件事合成一件是有意的：进局面的那份必须是拷贝，否则界面上改一下关卡注册表，
 * 正在打的那一局会跟着变（那正是我们要防的"存档跟着关卡漂移"）。
 * 调用方（`createMatch`）本来也要校验，所以拷贝不额外收钱。
 *
 * 判据只有三条：身份（id / name）、地图（复用 `validateFixedMap`）、几家与谁托管。
 * 后面的批次每加一个字段，就在这里加一条检查——**这里必须是唯一入口**，
 * 否则"坏关卡能建局"只是时间问题。
 */
export function validateLevel(raw: unknown): { ok: true; level: LevelDef } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const obj = (raw ?? {}) as Partial<LevelDef> & Record<string, unknown>;

  const id = typeof obj.id === 'string' ? obj.id.trim() : '';
  if (!id) errors.push('缺少关卡 id');
  const name = typeof obj.name === 'string' ? obj.name.trim() : '';
  if (!name) errors.push('缺少关卡名');
  if (name.length > 24) errors.push('关卡名太长（最多 24 个字）');

  /*
   * 先看 `seats.cityless`，再校验地图。
   *
   * 顺序不能反：地图校验会拦"某一方没有城"，而"没有城"正是无城席位该有的样子。
   * 这里只做**最宽松的预读**（能认出席位就行），真正的合法性由 `normalizeSeats` 判。
   */
  const rawSeats = (obj.seats ?? {}) as Partial<LevelSeats> & Record<string, unknown>;
  const rawCityless = (Array.isArray(rawSeats.cityless) ? rawSeats.cityless : [])
    .map((p) => String(p).toUpperCase())
    .filter((p) => SEAT_ORDER.includes(p as 'A' | 'B' | 'C' | 'D'));
  const checkedMap = validateFixedMap(obj.map, { allowEmpty: rawCityless });
  if (!checkedMap.ok) {
    // 地图的错因原样带出来：作者在关卡里写错一格，和在地图文件里写错一格，
    // 要看到的是同一句话。
    errors.push(...checkedMap.errors.map((e) => `关卡地图：${e}`));
  }
  if (!checkedMap.ok) return { ok: false, errors };

  const map = (checkedMap as { ok: true; map: FixedMap }).map;
  const seats = normalizeSeats(obj.seats, map, errors);
  const expansions = normalizeExpansions(obj.expansions, errors);
  const deploy = normalizeDeploy(obj.deploy, map, seats, errors);
  const events = normalizeEvents(obj.events, map, seats, errors);
  const goals = normalizeGoals(obj.goals, map, seats, errors);
  const setup = normalizeSetup(obj.setup, seats, errors);
  const units = normalizeLevelUnits(obj.units, errors);
  const banUnits = normalizeBanUnits(obj.banUnits, errors);
  const aiTuning = normalizeAiTuning(obj.ai, errors);
  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    level: {
      id,
      version: Number.isFinite(Number(obj.version)) ? Math.max(1, Math.round(Number(obj.version))) : LEVEL_VERSION,
      name,
      brief: typeof obj.brief === 'string' ? obj.brief.slice(0, 120) : undefined,
      // structuredClone 而不是 JSON 往返：地图里没有函数，但 JSON 往返会把
      // undefined 字段悄悄删掉，"这个字段有没有"就变得分不清了。
      map: structuredClone(map),
      ...(seats ? { seats: structuredClone(seats) } : {}),
      ...(deploy ? { deploy: structuredClone(deploy) } : {}),
      ...(expansions ? { expansions: structuredClone(expansions) } : {}),
      ...(events ? { events: structuredClone(events) } : {}),
      ...(goals ? { goals: structuredClone(goals) } : {}),
      ...(setup ? { setup: structuredClone(setup) } : {}),
      ...(units ? { units: structuredClone(units) } : {}),
      ...(banUnits ? { banUnits: [...banUnits] } : {}),
      ...(aiTuning ? { ai: aiTuning } : {}),
    },
  };
}

/**
 * 校验"这一关要求 / 禁止哪些扩展"。
 *
 * 只查两件事：id 认不认识、有没有自相矛盾（同一个包既要求开又要求禁用）。
 * **不查"这个包和那个包冲突"**——那是面板在勾选时做的判断（`conflictsWith`），
 * 而关卡是我们自己写的，写之前就该知道；真写上去了，`createMatch` 里
 * `enabledExpansionIds` 也会把前置不满足的整条剔掉，不会造出坏局面。
 */
function normalizeExpansions(raw: unknown, errors: string[]): LevelExpansionRules | undefined {
  if (raw === undefined || raw === null) return undefined;
  const obj = raw as Partial<LevelExpansionRules>;

  const clean = (list: unknown, label: string): string[] => {
    const out: string[] = [];
    for (const item of Array.isArray(list) ? list : []) {
      const id = String(item);
      if (!expansionById(id)) {
        errors.push(`${label}里的「${id}」不是一个已知的扩展`);
        continue;
      }
      if (!out.includes(id)) out.push(id);
    }
    return out;
  };
  const require = clean(obj.require, '必须开的扩展');
  const forbid = clean(obj.forbid, '禁用的扩展');
  /*
   * 警告档：只留"既不必须开、也没被禁"的那些。
   *
   * 同时出现在 require/forbid 里的警告没有意义——玩家要么非开不可、要么根本开不了，
   * 再提醒一句"会变难"只会让人困惑。静默剔掉，不报错：作者多半是在三个数组之间复制时
   * 忘了删，报错反而打断他。
   */
  const warn = clean(obj.warn, '会变难的扩展').filter(
    (id) => !require.includes(id) && !forbid.includes(id),
  );
  const both = require.filter((id) => forbid.includes(id));
  if (both.length > 0) {
    errors.push(`「${both.map((id) => expansionById(id)?.name ?? id).join('、')}」被同时要求开启和禁用`);
  }
  if (require.length === 0 && forbid.length === 0 && warn.length === 0) return undefined;
  return {
    ...(require.length > 0 ? { require } : {}),
    ...(forbid.length > 0 ? { forbid } : {}),
    ...(warn.length > 0 ? { warn } : {}),
  };
}

/**
 * 校验"每席开局的兵"。
 *
 * 这一层只查结构：席位坐不坐人、坐标在不在界内、有没有两处叠在同一格。
 * **兵种在不在这一局**要到 `createMatch` 才查得了（那时才有兵种表），见那边的说明。
 */
function normalizeDeploy(
  raw: unknown,
  map: FixedMap,
  seats: LevelSeats | undefined,
  errors: string[],
): Partial<Record<PlayerId, DeployUnit[]>> | undefined {
  if (raw === undefined || raw === null) return undefined;
  const obj = raw as Partial<Record<PlayerId, unknown>>;
  // 关卡没写几家就按两家算：A/B 是永远存在的两席
  const seated = (seats ? SEAT_ORDER.slice(0, seats.count) : ['A', 'B']) as readonly PlayerId[];

  const out: Partial<Record<PlayerId, DeployUnit[]>> = {};
  /** 已经被占掉的格：跨席位也算，两家不能把兵摆在同一个格子上 */
  const taken = new Set<string>();
  for (const key of Object.keys(obj)) {
    const seat = String(key).toUpperCase() as PlayerId;
    if (!SEAT_ORDER.includes(seat as 'A' | 'B' | 'C' | 'D')) {
      errors.push(`部署里的席位「${key}」不是 A/B/C/D`);
      continue;
    }
    if (!seated.includes(seat)) {
      errors.push(`部署里有第 ${seat} 家，但这一关只坐 ${seated.join(' / ')}`);
      continue;
    }
    const list = obj[seat];
    const units = normUnits(list, `第 ${seat} 家的部署`, map, taken, errors);
    if (units.length > 0) out[seat] = units;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * 一串"兵种 + 坐标"。部署和事件刷兵共用这一份判据。
 *
 * `taken` 由调用方传：部署要把**整关所有席位**摆过的格都算进去（两家不能叠），
 * 而事件刷兵是"打到一半突然出现"，只跟同一次刷出来的兵比——那时候开局部署的兵
 * 早就走开了。两者不能共用同一个集合，所以集合从外面进来。
 */
function normUnits(
  raw: unknown,
  label: string,
  map: FixedMap,
  taken: Set<string>,
  errors: string[],
): DeployUnit[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    errors.push(`${label}是空的：要么不写，要么至少写一个兵`);
    return [];
  }
  const units: DeployUnit[] = [];
  for (const item of raw) {
    const u = item as Partial<DeployUnit>;
    const type = typeof u?.type === 'string' ? u.type.trim() : '';
    const x = Math.round(Number(u?.x));
    const y = Math.round(Number(u?.y));
    if (!type) {
      errors.push(`${label}里有一个兵没写兵种`);
      continue;
    }
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= map.w || y >= map.h) {
      errors.push(`${label}里的「${type}」站在 (${String(u?.x)}, ${String(u?.y)})，超出棋盘`);
      continue;
    }
    const key = `${x},${y}`;
    if (taken.has(key)) {
      errors.push(`${label}里有两处叠在 (${x}, ${y}) 上`);
      continue;
    }
    taken.add(key);
    units.push({ type, x, y });
  }
  return units;
}

/** 席位顺序。和 `PLAYER_ORDER` 同一份；本地重复一遍是为了不把运行期依赖引进来 */
const SEAT_ORDER = ['A', 'B', 'C', 'D'] as const;

/**
 * 校验事件表。
 *
 * 判据的原则是"**能让这一关卡住的都拦掉**"：
 *   · id 重复 → 触发记录分不清是哪一件（`fired` 是按 id 记的）；
 *   · 归属席位没坐人 → 给一个不存在的敌人刷兵；
 *   · 区域越界 → 条件永远不成立，作者会以为"事件没生效"；
 *   · 动作为空 → 触发了什么都不做，等于写错。
 *
 * 反过来，**兵种存不存在**这里查不了（要等建局时的兵种表），那一条在 `createMatch`
 * 里处理：查不到就跳过那个兵并在战报里说一声，不炸整局。
 */
function normalizeEvents(
  raw: unknown,
  map: FixedMap,
  seats: LevelSeats | undefined,
  errors: string[],
): LevelEvent[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) {
    errors.push('events 应该是一串事件');
    return undefined;
  }
  const seated = (seats ? SEAT_ORDER.slice(0, seats.count) : ['A', 'B']) as readonly PlayerId[];
  const seen = new Set<string>();
  const out: LevelEvent[] = [];

  for (const item of raw) {
    const e = (item ?? {}) as Partial<LevelEvent>;
    const id = typeof e.id === 'string' ? e.id.trim() : '';
    if (!id) {
      errors.push('有一个事件没写 id');
      continue;
    }
    if (seen.has(id)) {
      errors.push(`事件 id「${id}」重复了：触发记录是按 id 存的，重名会分不清`);
      continue;
    }
    seen.add(id);

    const when = normalizeWhen(e.when, id, map, seated, errors);
    const rawDo = Array.isArray(e.do) ? e.do : [];
    if (rawDo.length === 0) {
      errors.push(`事件「${id}」没有任何动作`);
      continue;
    }
    const acts: LevelDo[] = [];
    for (const a of rawDo) {
      const act = normalizeDo(a, id, map, seated, errors);
      if (act) acts.push(act);
    }
    if (when && acts.length > 0) {
      out.push({ id, when, do: acts, ...(e.repeat === true ? { repeat: true } : {}) });
    }
  }
  return out.length > 0 ? out : undefined;
}

function normalizeWhen(
  raw: unknown,
  id: string,
  map: FixedMap,
  seated: readonly PlayerId[],
  errors: string[],
): LevelWhen | undefined {
  const w = (raw ?? {}) as Partial<LevelWhen> & Record<string, unknown>;
  const kind = String(w.kind ?? '');
  /* 归属席位：可写可不写，写了就必须是这一局坐人的 */
  const ownerOf = (value: unknown): PlayerId | undefined | null => {
    if (value === undefined || value === null || value === '') return undefined;
    const seat = String(value).toUpperCase() as PlayerId;
    if (!seated.includes(seat)) {
      errors.push(`事件「${id}」的条件指了第 ${String(value)} 家，但这一关只坐 ${seated.join(' / ')}`);
      return null;
    }
    return seat;
  };

  if (kind === 'turn') {
    const at = Math.round(Number(w.at));
    if (!Number.isFinite(at) || at < 1 || at > 999) {
      errors.push(`事件「${id}」的回合数要在 1~999（现在 ${String(w.at)}）`);
      return undefined;
    }
    return { kind: 'turn', at };
  }

  if (kind === 'unitDied') {
    const owner = ownerOf(w.owner);
    if (owner === null) return undefined;
    const type = typeof w.type === 'string' && w.type.trim() ? w.type.trim() : undefined;
    return { kind: 'unitDied', ...(owner ? { owner } : {}), ...(type ? { type } : {}) };
  }

  if (kind === 'enter') {
    const zone = normZone(w.zone, `事件「${id}」的触发区域`, map, errors);
    if (!zone) return undefined;
    const owner = ownerOf(w.owner);
    if (owner === null) return undefined;
    return { kind: 'enter', zone, ...(owner ? { owner } : {}) };
  }

  errors.push(`事件「${id}」的触发条件「${kind}」不认识（只能是 turn / unitDied / enter）`);
  return undefined;
}

/** 关卡的 AI 参数：两个数都夹在合理区间，写错了退回默认而不是拒整张图 */
function normalizeAiTuning(raw: unknown, errors: string[]): LevelAiTuning | undefined {
  if (raw === undefined || raw === null) return undefined;
  const obj = raw as Partial<LevelAiTuning> & Record<string, unknown>;
  const out: LevelAiTuning = {};
  const num = (v: unknown, min: number, max: number, label: string): number | undefined => {
    if (v === undefined) return undefined;
    const n = Number(v);
    if (!Number.isFinite(n)) {
      errors.push(`关卡的 AI 参数「${label}」不是数字（现在 ${String(v)}）`);
      return undefined;
    }
    return Math.min(max, Math.max(min, n));
  };
  const cohesion = num(obj.cohesion, 0, 2, 'cohesion');
  const appetite = num(obj.appetite, 0.2, 3, 'appetite');
  /*
   * 区间必须和 `LevelAiTuning` 的注释、编辑器的滑杆**同一份**。
   *
   * 这里曾经卡在 0.2，而文档和界面上早就写着"0 = 完全不计伤亡"——于是关卡里
   * 写 `riskAversion: 0`，被这一行悄悄夹回 0.2，作者看到的和实际生效的不是一回事。
   * 同一个坑还让 `pressure` 整个丢掉（normalize 不认识它）。
   */
  const riskAversion = num(obj.riskAversion, 0, 2, 'riskAversion');
  const pressure = num(obj.pressure, 0, 3, 'pressure');
  if (cohesion !== undefined) out.cohesion = cohesion;
  if (appetite !== undefined) out.appetite = appetite;
  if (riskAversion !== undefined) out.riskAversion = riskAversion;
  if (pressure !== undefined) out.pressure = pressure;
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * 校验"这一关自带的兵种"。
 *
 * 只查"能不能用"：名字、时代、类别。数值不查——那是作者调平衡的事，
 * 校验拦不住也不该拦。`id` 一律以 map 的 key 为准，免得出现
 * "key 叫 warden、def.id 叫 hero"这种对不上的情况。
 */
/**
 * 校验"这一关禁用哪些兵种"。
 *
 * 只查**结构**（数组、每项是字符串、不重复），不查"这个兵种存不存在"——
 * 那要等 `createMatch` 拿到本局扩展池才知道（同一个 id 在没开对应扩展的局里
 * 根本不存在）。写错 id 不会造出坏局面：`canUseType` 只做字符串比较，
 * 不存在的 id 永远匹配不上，等于没写。lint 那边另有一条"认不出来"的提醒。
 */
function normalizeBanUnits(raw: unknown, errors: string[]): string[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) {
    errors.push('"banUnits" 要写成兵种 id 的数组，比如 ["evil-dragon-king"]');
    return undefined;
  }
  const out: string[] = [];
  for (const x of raw) {
    const id = typeof x === 'string' ? x.trim() : '';
    if (!id) {
      errors.push('"banUnits" 里有空项：每一项都要是兵种 id');
      continue;
    }
    if (!out.includes(id)) out.push(id);
  }
  if (out.length > 300) errors.push(`"banUnits" 写了 ${out.length} 个兵种，最多 300 个`);
  return out.length > 0 ? out : undefined;
}

function normalizeLevelUnits(
  raw: unknown,
  errors: string[],
): Record<string, UnitTypeDef> | undefined {
  if (raw === undefined || raw === null) return undefined;
  const out: Record<string, UnitTypeDef> = {};
  for (const [key, val] of Object.entries(raw as Record<string, UnitTypeDef>)) {
    const def = val;
    if (!def || typeof def !== 'object') {
      errors.push(`关卡兵种「${key}」不是一份定义`);
      continue;
    }
    if (typeof def.name !== 'string' || !def.name.trim()) {
      errors.push(`关卡兵种「${key}」没写名字`);
      continue;
    }
    const era = Math.round(Number(def.era));
    if (!Number.isFinite(era) || era < 1 || era > ERAS.length) {
      errors.push(`关卡兵种「${key}」的时代要落在 1~${ERAS.length}（现在 ${String(def.era)}）`);
      continue;
    }
    if (!def.category) {
      errors.push(`关卡兵种「${key}」没写类别（combat / economy / builder / building）`);
      continue;
    }
    out[key] = { ...def, id: key, era };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** 一块矩形区域。事件和胜利条件共用同一份判据 */
function normZone(raw: unknown, label: string, map: FixedMap, errors: string[]): LevelZone | undefined {  const z = (raw ?? {}) as Partial<LevelZone>;
  const nums = [z.x0, z.y0, z.x1, z.y1].map((v) => Math.round(Number(v)));
  if (nums.some((v) => !Number.isFinite(v))) {
    errors.push(`${label}要写 x0/y0/x1/y1 四个数`);
    return undefined;
  }
  const [x0, y0, x1, y1] = nums as [number, number, number, number];
  if (x0 > x1 || y0 > y1) {
    errors.push(`${label}的左上角应该在右下角左边/上边（现在是 (${x0},${y0}) 到 (${x1},${y1})）`);
    return undefined;
  }
  if (x0 < 0 || y0 < 0 || x1 >= map.w || y1 >= map.h) {
    errors.push(`${label}超出棋盘（棋盘是 ${map.w}×${map.h}）`);
    return undefined;
  }
  return { x0, y0, x1, y1 };
}

/**
 * 校验"写死的开局设定"。
 *
 * 只查两件事：时代在不在这一版的范围内、先手是不是这一局坐人的席位。
 * **不查"这一关的时代配不配它的兵"**——那是内容设计的问题，得靠实测，
 * 校验拦不住也不该拦。
 */
function normalizeSetup(
  raw: unknown,
  seats: LevelSeats | undefined,
  errors: string[],
): LevelSetup | undefined {
  if (raw === undefined || raw === null) return undefined;
  const o = raw as Partial<LevelSetup>;
  const out: LevelSetup = {};

  if (o.startEra !== undefined) {
    const era = Math.round(Number(o.startEra));
    if (!Number.isFinite(era) || era < 1 || era > ERAS.length) {
      errors.push(`开局时代要落在 1~${ERAS.length} 之间（现在 ${String(o.startEra)}）`);
    } else {
      out.startEra = era;
    }
  }

  if (o.firstSide !== undefined) {
    const seated = (seats ? SEAT_ORDER.slice(0, seats.count) : ['A', 'B']) as readonly PlayerId[];
    const seat = String(o.firstSide).toUpperCase();
    if (seat !== 'A' && seat !== 'B') {
      // 多人局的先手是抽的（席位顺序牵着城位），关卡不该也不能指定 C/D 先动
      errors.push(`先手只能是 A 或 B（现在 ${String(o.firstSide)}）：多人局的先手随种子抽`);
    } else if (!seated.includes(seat as PlayerId)) {
      errors.push(`先手写的是第 ${seat} 家，但这一关只坐 ${seated.join(' / ')}`);
    } else {
      out.firstSide = seat;
    }
  }

  if (o.twoCities !== undefined) out.twoCities = o.twoCities === true;

  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * 校验胜利条件。
 *
 * 和事件一样，只查"写错了会造出怪局面/永远不成立"的：席位认不认识、
 * 时限在不在范围内、两块地是不是同一个席位（赢了又输）。
 */
function normalizeGoals(
  raw: unknown,
  map: FixedMap,
  seats: LevelSeats | undefined,
  errors: string[],
): LevelGoal[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) {
    errors.push('goals 应该是一串胜利条件');
    return undefined;
  }
  const seated = (seats ? SEAT_ORDER.slice(0, seats.count) : ['A', 'B']) as readonly PlayerId[];
  const seatOf = (value: unknown, label: string): PlayerId | undefined => {
    const seat = String(value ?? '').toUpperCase() as PlayerId;
    if (!seated.includes(seat)) {
      errors.push(`${label}写的是第 ${String(value)} 家，但这一关只坐 ${seated.join(' / ')}`);
      return undefined;
    }
    return seat;
  };

  const out: LevelGoal[] = [];
  for (const item of raw) {
    const g = (item ?? {}) as Record<string, unknown>;
    const kind = String(g.kind ?? '');

    if (kind === 'survive') {
      const seat = seatOf(g.seat, `胜利条件「守到第 N 次行动」的守方`);
      if (!seat) continue;
      const untilTurn = Math.round(Number(g.untilTurn));
      if (!Number.isFinite(untilTurn) || untilTurn < 1 || untilTurn > 999) {
        errors.push(`胜利条件「守到第 N 次行动」的时限要在 1~999（现在 ${String(g.untilTurn)}）`);
        continue;
      }
      out.push({ kind: 'survive', seat, untilTurn });
      continue;
    }

    if (kind === 'escort') {
      const seat = seatOf(g.seat, '胜利条件「护送」的那一方');
      if (!seat) continue;
      const zone = normZone(g.zone, '胜利条件「护送」的终点区域', map, errors);
      if (!zone) continue;
      const unitType = typeof g.unitType === 'string' && g.unitType.trim() ? g.unitType.trim() : undefined;
      const label = typeof g.label === 'string' && g.label.trim() ? g.label.trim().slice(0, 12) : undefined;
      out.push({
        kind: 'escort',
        seat,
        zone,
        ...(unitType ? { unitType } : {}),
        ...(label ? { label } : {}),
      });
      continue;
    }

    if (kind === 'assassinate') {
      const winner = seatOf(g.winner, '胜利条件「斩首」的获胜方');
      const loser = seatOf(g.loser, '胜利条件「斩首」的被斩方');
      if (!winner || !loser) continue;
      if (winner === loser) {
        errors.push('胜利条件「斩首」的获胜方和被斩方是同一家');
        continue;
      }
      const unitType = typeof g.unitType === 'string' && g.unitType.trim() ? g.unitType.trim() : undefined;
      const label = typeof g.label === 'string' && g.label.trim() ? g.label.trim() : undefined;
      out.push({ kind: 'assassinate', winner, loser, ...(unitType ? { unitType } : {}), ...(label ? { label } : {}) });
      continue;
    }

    errors.push(`胜利条件「${kind}」不认识（只能是 survive / escort / assassinate）`);
  }
  return out.length > 0 ? out : undefined;
}

function normalizeDo(
  raw: unknown,
  id: string,
  map: FixedMap,
  seated: readonly PlayerId[],
  errors: string[],
): LevelDo | undefined {
  const a = (raw ?? {}) as Record<string, unknown>;
  const kind = String(a.kind ?? '');

  if (kind === 'spawn') {
    const owner = String(a.owner ?? '').toUpperCase() as PlayerId;
    if (!seated.includes(owner)) {
      errors.push(`事件「${id}」刷的兵归「${String(a.owner)}」所有，但这一关只坐 ${seated.join(' / ')}`);
      return undefined;
    }
    const units = normUnits(a.units, `事件「${id}」刷的兵`, map, new Set(), errors);
    if (units.length === 0) return undefined;
    return { kind: 'spawn', owner, units };
  }

  if (kind === 'say') {
    const text = typeof a.text === 'string' ? a.text.trim() : '';
    if (!text) {
      errors.push(`事件「${id}」的播报是空的`);
      return undefined;
    }
    if (text.length > 120) {
      errors.push(`事件「${id}」的播报太长（最多 120 字）`);
      return undefined;
    }
    return { kind: 'say', text };
  }

  if (kind === 'doctrine') {
    const seat = String(a.seat ?? '').toUpperCase() as PlayerId;
    if (!seated.includes(seat)) {
      errors.push(`事件「${id}」要改第 ${String(a.seat)} 家的打法，但这一关只坐 ${seated.join(' / ')}`);
      return undefined;
    }
    const strategy = String(a.strategy ?? '');
    if (strategy !== 'auto' && strategy !== 'rush' && strategy !== 'boom' && strategy !== 'hold') {
      errors.push(`事件「${id}」的打法「${strategy}」不认识（只能是 auto / rush / boom / hold）`);
      return undefined;
    }
    let targetSeat: PlayerId | undefined;
    if (a.targetSeat !== undefined && a.targetSeat !== '') {
      const t = String(a.targetSeat).toUpperCase() as PlayerId;
      if (!seated.includes(t)) {
        errors.push(`事件「${id}」指定了主攻第 ${String(a.targetSeat)} 家，但这一关没这一家`);
        return undefined;
      }
      targetSeat = t;
    }
    return { kind: 'doctrine', seat, strategy, ...(targetSeat ? { targetSeat } : {}) };
  }

  if (kind === 'deploy') {
    const seat = String(a.seat ?? '').toUpperCase() as PlayerId;
    if (!seated.includes(seat)) {
      errors.push(`事件「${id}」要让第 ${String(a.seat)} 家登场，但这一关只坐 ${seated.join(' / ')}`);
      return undefined;
    }
    return { kind: 'deploy', seat };
  }

  if (kind === 'terrain') {
    const zone = normZone(a.zone, `事件「${id}」改地形的范围`, map, errors);
    if (!zone) return undefined;
    const to = String(a.to ?? '');
    if (!LEVEL_TERRAINS.includes(to as LevelTerrain)) {
      errors.push(
        `事件「${id}」要把地形改成「${to}」，这个改不了（能改的是：${LEVEL_TERRAINS.join(' / ')}）`,
      );
      return undefined;
    }
    let only: LevelTerrain[] | undefined;
    if (a.only !== undefined) {
      only = [];
      for (const raw of Array.isArray(a.only) ? a.only : []) {
        const t = String(raw);
        if (!LEVEL_TERRAINS.includes(t as LevelTerrain)) {
          errors.push(`事件「${id}」的 only 里有「${t}」，不是能改的地形`);
          continue;
        }
        only.push(t as LevelTerrain);
      }
    }
    return { kind: 'terrain', zone, to: to as LevelTerrain, ...(only && only.length > 0 ? { only } : {}) };
  }

  if (kind === 'reveal') {
    const zone = normZone(a.zone, `事件「${id}」点亮区域的范围`, map, errors);
    if (!zone) return undefined;
    let turns: number | undefined;
    if (a.turns !== undefined && a.turns !== '') {
      const n = Math.round(Number(a.turns));
      // 负数统一成 -1（一直亮）；正数 1~99
      if (!Number.isFinite(n) || n === 0 || n < -1 || n > 99) {
        errors.push(`事件「${id}」点亮要持续「${String(a.turns)}」次行动：1~99，或者写负数表示一直亮`);
      } else {
        turns = n < 0 ? -1 : n;
      }
    }
    // 1 是默认值，不写进 JSON
    return { kind: 'reveal', zone, ...(turns !== undefined && turns !== 1 ? { turns } : {}) };
  }

  errors.push(
    `事件「${id}」里有个不认识的动作「${kind}」（只能是 spawn / say / doctrine / deploy / terrain / reveal）`,
  );
  return undefined;
}

/**
 * 校验"几家、谁托管、多出来的城在哪"。
 *
 * 三条都是**会造出坏局面**的：
 *   · 第三席没有城 → 它第一回合就被判出局，玩家看到的是"三家局里只有两家在打"；
 *   · AI 席位写成没坐人的席位（三家局里写 D）→ 电脑控制一个不存在的敌人；
 *   · 城叠在一起或者伸出棋盘 → 建局时那一格有两个城，规则层从没设计过这种局面。
 */
function normalizeSeats(
  raw: unknown,
  map: FixedMap,
  errors: string[],
): LevelSeats | undefined {
  if (raw === undefined || raw === null) return undefined;
  const obj = raw as Partial<LevelSeats> & Record<string, unknown>;

  const count = Math.round(Number(obj.count));
  if (!(count === 2 || count === 3 || count === 4)) {
    errors.push(`关卡有几家（seats.count）只能是 2 / 3 / 4，现在是 ${String(obj.count)}`);
    return undefined;
  }
  const seated = SEAT_ORDER.slice(0, count) as readonly PlayerId[];

  /*
   * 无城席位（`cityless`）。
   *
   * 两道判断：① 只能是这一局坐人的席位；② 不能和城位同时存在——
   * 两边都写是自相矛盾的配置，静默取一个会让作者查半天。
   */
  const cityless: PlayerId[] = [];
  for (const p of Array.isArray(obj.cityless) ? obj.cityless : []) {
    const seat = String(p).toUpperCase() as PlayerId;
    if (!SEAT_ORDER.includes(seat as 'A' | 'B' | 'C' | 'D')) {
      errors.push(`「没有城」的席位「${String(p)}」不是有效席位（只能是 A/B/C/D）`);
      continue;
    }
    if (!seated.includes(seat)) {
      errors.push(`「没有城」的席位「${seat}」这一局没坐人（这一关只有 ${seated.join(' / ')} 家）`);
      continue;
    }
    if (!cityless.includes(seat)) cityless.push(seat);
  }
  for (const seat of cityless) {
    const own = [
      ...(seat === 'A' ? map.citiesA : seat === 'B' ? map.citiesB : []),
      ...(((obj.cities ?? {}) as Partial<Record<'C' | 'D', MapPoint[]>>)[seat as 'C' | 'D'] ?? []),
    ];
    if (own.length > 0) {
      errors.push(
        `第 ${seat} 家同时被标成「没有城」又有 ${own.length} 座城位：这两件事只能选一个（想让它没城就把城位删掉）`,
      );
    }
  }

  /*
   * 同盟。三条都是"写错就会造出坏局面"的：
   *   · 某个坐人的席位**没进任何队**：它默认和所有人敌对，作者以为它在队里；
   *   · 同一席位出现在两个队：敌我关系直接自相矛盾；
   *   · 只有一个队：那就没有敌人了，第一帧就"全队胜利"。
   */
  let teams: PlayerId[][] | undefined;
  if (Array.isArray(obj.teams) && obj.teams.length > 0) {
    const out: PlayerId[][] = [];
    const seen = new Map<PlayerId, number>();
    for (const [gi, raw] of obj.teams.entries()) {
      const group: PlayerId[] = [];
      for (const p of Array.isArray(raw) ? raw : []) {
        const seat = String(p).toUpperCase() as PlayerId;
        if (!SEAT_ORDER.includes(seat as 'A' | 'B' | 'C' | 'D')) {
          errors.push(`同盟第 ${gi + 1} 队里有「${String(p)}」，不是有效席位（只能是 A/B/C/D）`);
          continue;
        }
        if (!seated.includes(seat)) {
          errors.push(`同盟第 ${gi + 1} 队里有「${seat}」，但这一局没坐这一家`);
          continue;
        }
        if (seen.has(seat)) {
          errors.push(`第 ${seat} 家同时出现在同盟第 ${seen.get(seat)! + 1} 队和第 ${gi + 1} 队：一家只能在一个队里`);
          continue;
        }
        seen.set(seat, gi);
        if (!group.includes(seat)) group.push(seat);
      }
      if (group.length > 0) out.push(group);
    }
    const missing = seated.filter((p) => !seen.has(p));
    if (missing.length > 0) {
      errors.push(`同盟里漏了 ${missing.join(' / ')}：写了 teams 就要把每个坐人的席位都放进某一队`);
    }
    if (out.length < 2) {
      errors.push('同盟至少要两个队（只有一个队就没有敌人了）');
    }
    if (out.length >= 2) teams = out;
  }

  const aiRaw = Array.isArray(obj.ai) ? obj.ai : [];
  const ai: PlayerId[] = [];
  for (const p of aiRaw) {
    const seat = String(p).toUpperCase() as PlayerId;
    if (!SEAT_ORDER.includes(seat as 'A' | 'B' | 'C' | 'D')) {
      errors.push(`AI 席位「${String(p)}」不是有效席位（只能是 A/B/C/D）`);
      continue;
    }
    if (!seated.includes(seat)) {
      errors.push(`AI 席位「${seat}」这一局没坐人（这一关只有 ${seated.join(' / ')} 三家）`);
      continue;
    }
    if (!ai.includes(seat)) ai.push(seat);
  }

  const cities: Partial<Record<'C' | 'D', MapPoint[]>> = {};
  const extraSeats = seated.slice(2) as Array<'C' | 'D'>;
  const rawCities = (obj.cities ?? {}) as Partial<Record<'C' | 'D', unknown>>;
  /** 已经占掉的城位：地图自带的 A/B 也进来，防止第三家的城压在别人的城上 */
  const taken: MapPoint[] = [...map.citiesA, ...map.citiesB];
  const overlaps = (p: MapPoint): boolean =>
    // 城的边长可能被「城郭」抬到 3，但校验只保证 2×2 放得下（和 validateFixedMap 同一口径）
    taken.some((q) => Math.abs(q.x - p.x) < 2 && Math.abs(q.y - p.y) < 2);

  for (const p of extraSeats) {
    const list = rawCities[p];
    const pts: MapPoint[] = Array.isArray(list)
      ? list
          .map((c) => ({ x: Math.round(Number((c as MapPoint)?.x)), y: Math.round(Number((c as MapPoint)?.y)) }))
          .filter((c) => Number.isFinite(c.x) && Number.isFinite(c.y))
      : [];
    /*
     * 「没有城」的席位（合作关里靠事件刷兵的邪龙军团）**故意**没有城。
     * 以前这里一刀切要求第三/第四家必须有城，于是 cityless 只能用在两家局
     * （护送关的 A 走的是 citiesA 为空那条路）——三家局的"无城敌人"根本写不出来。
     */
    if (cityless.includes(p)) {
      if (pts.length > 0) {
        errors.push(`第 ${p} 家既标了「没有城」，又在 seats.cities.${p} 里写了城位：二选一`);
      }
      continue;
    }
    if (pts.length === 0) {
      errors.push(`第 ${p} 家没有城：这一关是 ${count} 家局，必须在 seats.cities.${p} 里给它一座城`);
      continue;
    }
    if (pts.length > 8) errors.push(`第 ${p} 家的城太多（最多 8 座）`);
    for (const c of pts) {
      if (c.x < 0 || c.y < 0 || c.x + 2 > map.w || c.y + 2 > map.h) {
        errors.push(`第 ${p} 家的城 (${c.x}, ${c.y}) 超出棋盘：2×2 的城左上角最多到 ${map.w - 2}, ${map.h - 2}`);
        break;
      }
      if (overlaps(c)) {
        errors.push(`第 ${p} 家的城 (${c.x}, ${c.y}) 和别的城叠在一起了`);
        break;
      }
      taken.push(c);
    }
    cities[p] = pts;
  }

  /*
   * 逐席的开局时代（只有"晚到的一家"会用）。
   *
   * 必须在这里过一遍再带出去：`validateLevel` 返回的是一份**重新拼的对象**，
   * 不在这里收，`cityEra` 就在校验那一步丢了——表现是"第三方进城还是青铜"，
   * 而关卡里明明写的是铁器，查半天查不出原因。
   */
  const rawCityEra = (obj.cityEra ?? {}) as Partial<Record<PlayerId, unknown>>;
  const cityEra: Partial<Record<PlayerId, number>> = {};
  for (const [rawSeat, rawEra] of Object.entries(rawCityEra)) {
    const seat = String(rawSeat).toUpperCase() as PlayerId;
    if (!seated.includes(seat)) {
      errors.push(`第 ${seat} 家的开局时代写了，但这一关没这一家`);
      continue;
    }
    const era = Math.round(Number(rawEra));
    if (!Number.isFinite(era) || era < 1 || era > ERAS.length) {
      errors.push(`第 ${seat} 家的开局时代要落在 1~${ERAS.length}（现在 ${String(rawEra)}）`);
      continue;
    }
    cityEra[seat] = era;
  }

  /*
   * 未登场的席位：必须是这一局坐人的。
   * 它有没有城由下面的 extraSeats 那段管（C/D 必须有 seats.cities，A/B 用地图的）。
   */
  const hidden: PlayerId[] = [];
  for (const raw of Array.isArray(obj.hidden) ? obj.hidden : []) {
    const seat = String(raw).toUpperCase() as PlayerId;
    if (!SEAT_ORDER.includes(seat as 'A' | 'B' | 'C' | 'D')) {
      errors.push(`未登场的席位「${String(raw)}」不是 A/B/C/D`);
      continue;
    }
    if (!seated.includes(seat)) {
      errors.push(`第 ${seat} 家被写成未登场，但这一关只坐 ${seated.join(' / ')}`);
      continue;
    }
    if (!hidden.includes(seat)) hidden.push(seat);
  }

  return {
    count: count as 2 | 3 | 4,
    ...(Object.keys(cities).length > 0 ? { cities } : {}),
    ...(cityless.length > 0 ? { cityless } : {}),
    ...(teams ? { teams } : {}),
    ai,
    ...(hidden.length > 0 ? { hidden } : {}),
    ...(Object.keys(cityEra).length > 0 ? { cityEra } : {}),
  };
}
