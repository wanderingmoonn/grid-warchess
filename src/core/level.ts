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
// 只取类型，编译后不留 import：types.ts 那边也是用内联 `import('./level.ts')` 的
// 类型位置引用来避开循环依赖，两边都不会在运行期真的互相加载。
import type { MatchConfig, PlayerId } from './types.ts';

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
 * 这一关对扩展的要求。
 *
 * 三档语义（面板上也是这么显示的）：
 *   · `require` 必须开：玩家没勾也强制加上；
 *   · `forbid` 禁用：玩家勾了也强制去掉；
 *   · 没提到的：**保留玩家自己的选择**。
 *
 * 为什么必须有这一条：关卡里的部署和（以后的）事件会点名某个兵种。
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
 * 内建关卡。
 *
 * 前两张是"测试夹具"：不追求好玩，各验证一条机制。
 * 「三岔口」是第一张能给人玩的三家混战；「断后」验证"关卡能定开局兵力 + 扩展规则"。
 */
export const LEVELS: LevelDef[] = [
  {
    id: 'level:probe-flat',
    version: LEVEL_VERSION,
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
  },
  {
    id: 'level:tri-corner',
    version: LEVEL_VERSION,
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
  },
  {
    id: 'level:rear-guard',
    version: LEVEL_VERSION,
    name: '断后',
    brief: '14×14，一座桥。你只有 1 个兵，对面 5 个——演示关卡可以决定开局兵力。',
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
  },
];

export function allLevels(): LevelDef[] {
  return LEVELS;
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
  return {
    ...base,
    level,
    fixedMap: undefined,
    // 选了关卡，尺寸就是关卡地图的尺寸；面板上那个数字跟着走，免得显示和事实相反
    size: level.map.w,
    playerCount: level.seats?.count ?? base.playerCount,
    // 关卡没规定托管就沿用面板（"这一关没意见，你自己挑"）
    ...(level.seats?.ai !== undefined ? { aiSeats: [...level.seats.ai] } : {}),
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
    if (!Array.isArray(list) || list.length === 0) {
      errors.push(`第 ${seat} 家的部署是空的：要么不写这一席，要么至少写一个兵`);
      continue;
    }
    const units: DeployUnit[] = [];
    for (const item of list) {
      const u = item as Partial<DeployUnit>;
      const type = typeof u?.type === 'string' ? u.type.trim() : '';
      const x = Math.round(Number(u?.x));
      const y = Math.round(Number(u?.y));
      if (!type) {
        errors.push(`第 ${seat} 家有一个部署兵没写兵种`);
        continue;
      }
      if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= map.w || y >= map.h) {
        errors.push(`第 ${seat} 家的「${type}」站在 (${String(u?.x)}, ${String(u?.y)})，超出棋盘`);
        continue;
      }
      const key2 = `${x},${y}`;
      if (taken.has(key2)) {
        errors.push(`两处部署叠在 (${x}, ${y}) 上`);
        continue;
      }
      taken.add(key2);
      units.push({ type, x, y });
    }
    if (units.length > 0) out[seat] = units;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** 席位顺序。和 `PLAYER_ORDER` 同一份；本地重复一遍是为了不把运行期依赖引进来 */
const SEAT_ORDER = ['A', 'B', 'C', 'D'] as const;

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

  return { count: count as 2 | 3 | 4, ...(Object.keys(cities).length > 0 ? { cities } : {}), ai };
}
