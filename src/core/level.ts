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
import { ERAS } from './config.ts';
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
  | { kind: 'terrain'; zone: LevelZone; to: LevelTerrain; only?: LevelTerrain[] };

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
  | { kind: 'escort'; seat: PlayerId; zone: LevelZone; unitType?: string }
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
    const who = goal.unitType ? `「${goal.unitType}」` : '一个兵';
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
  require?: string[];
  forbid?: string[];
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
   * `count` 是 3 就必须给 C；是 4 就必须给 C 和 D。**没城的席位第一回合就被判出局**
   * （出局的定义就是"城全丢光"），所以这不是可选项——校验会拦。
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
 *   · **玩家关**（没有 `dev` 标记）：孤城 / 斩首 / 黄雀。三类各一关，
 *     每类教一件事——用地形换时间、集中兵力打一点、第三方与时机。
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
      // 两座城：产能翻倍，而且必须打两座才算赢。
      // x 从 10 挪到 11 是为了给河岸留出两列缓冲——守方弓箭手（射程 3）
      // 站在自己河岸就该够不到这里，而不是站在岸上就能点掉城边的农民。
      citiesB: [
        { x: 11, y: 3 },
        { x: 11, y: 10 },
      ],
      source: 'builtin',
    },
    seats: { count: 2, ai: ['B'] },
    setup: { startEra: 1, firstSide: 'A' },
    deploy: {
      A: [
        { type: 'militia', x: 4, y: 7 },
        { type: 'archer', x: 3, y: 7 },
        { type: 'militia', x: 4, y: 8 },
      ],
      /*
       * 攻方起手：4 近战 + 4 远程 + 2 高机动 + 2 箭塔 + 2 农民。
       *
       * 四类各有分工，不能互相替代：
       *   · 民兵占桥头、扛线；
       *   · 弓手（射程 3）越过两格宽的河压制西岸——守方站岸边就要挨打；
       *   · 斥候（移动 4）绕后、抢浅滩，水退之后第一批扑过去；
       *   · 箭塔钉在桥头两侧，守方想清掉对岸的目标就得先拆塔，而拆塔要拿命换；
       *   · 农民摆在城后，把两座城的产能真的用起来。
       *
       * 塔刻意放在 (9,6)/(9,9) 而不是桥头 (9,7)/(9,8)：建筑占格且不可通行，
       * 摆在桥头会把自家过河的门口堵死。
       */
      B: [
        { type: 'militia', x: 9, y: 7 },
        { type: 'militia', x: 9, y: 8 },
        { type: 'militia', x: 10, y: 7 },
        { type: 'militia', x: 10, y: 8 },
        { type: 'archer', x: 10, y: 5 },
        { type: 'archer', x: 10, y: 6 },
        { type: 'archer', x: 10, y: 9 },
        { type: 'archer', x: 10, y: 10 },
        { type: 'scout', x: 13, y: 7 },
        { type: 'scout', x: 13, y: 8 },
        { type: 'tower', x: 9, y: 6 },
        { type: 'tower', x: 9, y: 9 },
        // 后方农民：开局就给两座城的产能点火
        { type: 'farmer', x: 13, y: 3 },
        { type: 'farmer', x: 13, y: 9 },
      ],
    },
    goals: [{ kind: 'survive', seat: 'A', untilTurn: 30 }],
    /*
     * 禁掉「先后手补偿」：这一关是 1 城对 2 城的不对称布防，后手再补一笔金币，
     * 等于把设计好的强弱差抹掉一截。（和「断后」同一条理由。）
     */
    expansions: { forbid: ['turn-order-comp','high-mobility'] },
    /*
     * 三段压力：
     *   1~5 次行动：桥还在。这是玩家**唯一能主动出门换兵**的窗口，也是这关的全部乐趣；
     *   第 6 次行动：桥被炸成深水，只能守桥头；
     *   第 11 次行动：整条河退成浅流——防线从 1 格变成 14 格，逼他把人收拢到城下硬撑。
     *
     * 第二段刻意**不写 `only`**：整条河一起变，包括桥墩那一格。
     * 留着桥墩是深坑也没用——那格谁都过不去，等于少一个突破点，压力反而不够。
     */
    events: [
      {
        id: 'blow',
        when: { kind: 'turn', at: 9 },
        do: [
          { kind: 'say', text: '桥被炸断了。' },
          // 四格一起炸。区域少写一行，桥就只塌一半——看着像"炸桥没生效"
          { kind: 'terrain', zone: { x0: 7, y0: 7, x1: 8, y1: 8 }, to: 'deep' },
        ],
      },
      /*
       * 五波援军，从第 5 次行动起就没断过。
       *
       * 这是死守感的来源，不是数值堆料：把兵一次加多，玩家撑过第一波就能反推；
       * **持续来人**才会让他一直处在打退了、又来了、城下又有人的状态里，
       * 也就没有余力把兵抽出去打对面。
       *
       * 实测（AI 对 AI）：**加多少波都撕不开这条河**——电脑不会集结兵力强渡。
       * 所以这五波主要是给真人玩家的压力，不能指望它改变 AI 对局的结果。
       */
      {
        id: 'wave-1',
        when: { kind: 'turn', at: 5 },
        do: [
          { kind: 'say', text: '东边的路上又上来一队人。' },
          { kind: 'spawn', owner: 'B', units: [{ type: 'militia', x: 12, y: 5 }, { type: 'militia', x: 12, y: 6 }] },
        ],
      },
      {
        id: 'wave-2',
        when: { kind: 'turn', at: 10 },
        do: [{ kind: 'spawn', owner: 'B', units: [{ type: 'archer', x: 12, y: 7 }, { type: 'militia', x: 12, y: 8 }] }],
      },
      {
        id: 'wave-3',
        when: { kind: 'turn', at: 16 },
        do: [{ kind: 'spawn', owner: 'B', units: [{ type: 'militia', x: 13, y: 5 }, { type: 'militia', x: 13, y: 6 }] }],
      },
      {
        id: 'wave-4',
        when: { kind: 'turn', at: 22 },
        do: [{ kind: 'spawn', owner: 'B', units: [{ type: 'archer', x: 13, y: 10 }, { type: 'militia', x: 13, y: 11 }] }],
      },
      {
        id: 'wave-5',
        when: { kind: 'turn', at: 27 },
        do: [
          { kind: 'say', text: '最后一批。撑过去就是你的。' },
          { kind: 'spawn', owner: 'B', units: [{ type: 'militia', x: 13, y: 12 }, { type: 'militia', x: 13, y: 13 }] },
        ],
      },
      {
        id: 'ebb',
        when: { kind: 'turn', at: 14 },
        do: [
          { kind: 'say', text: '水位退了。整条河都能淌过去。' },
          { kind: 'terrain', zone: { x0: 7, y0: 0, x1: 8, y1: 13 }, to: 'shallow' },
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
 * 全部关卡（含测试夹具）。探针、自检、内部跳转用它。
 *
 * **玩家菜单不该用它**——那种地方要用 `playableLevels()`，否则"1 个兵打 5 个"
 * 这种专门用来验机制的图会出现在选关列表里，玩家点进去只会觉得是半成品。
 */
export function allLevels(): LevelDef[] {
  return LEVELS;
}

/** 玩家能选到的关卡（去掉 `dev` 那些测试夹具） */
export function playableLevels(): LevelDef[] {
  return LEVELS.filter((l) => l.dev !== true);
}

export function levelById(id: string | null | undefined): LevelDef | null {
  if (!id) return null;
  return LEVELS.find((l) => l.id === id) ?? null;
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

  const checkedMap = validateFixedMap(obj.map);
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
  const both = require.filter((id) => forbid.includes(id));
  if (both.length > 0) {
    errors.push(`「${both.map((id) => expansionById(id)?.name ?? id).join('、')}」被同时要求开启和禁用`);
  }
  if (require.length === 0 && forbid.length === 0) return undefined;
  return { ...(require.length > 0 ? { require } : {}), ...(forbid.length > 0 ? { forbid } : {}) };
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

/**
 * 校验"这一关自带的兵种"。
 *
 * 只查"能不能用"：名字、时代、类别。数值不查——那是作者调平衡的事，
 * 校验拦不住也不该拦。`id` 一律以 map 的 key 为准，免得出现
 * "key 叫 warden、def.id 叫 hero"这种对不上的情况。
 */
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
      out.push({ kind: 'escort', seat, zone, ...(unitType ? { unitType } : {}) });
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

  errors.push(`事件「${id}」里有个不认识的动作「${kind}」（只能是 spawn / say / doctrine / deploy / terrain）`);
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
    ai,
    ...(hidden.length > 0 ? { hidden } : {}),
    ...(Object.keys(cityEra).length > 0 ? { cityEra } : {}),
  };
}
