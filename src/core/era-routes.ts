/**
 * 时代演进路线（Era Route）——把"升一级去哪儿"从硬编码变成数据。
 *
 * ---------------------------------------------------------------
 * 为什么要这一层
 * ---------------------------------------------------------------
 * 原来每一处都写 `city.era + 1`：规则算价钱用、界面写"升到下一级"用、AI 评估
 * 换代收益用。段位是 1..6 的等差表，于是"第 5 代升到第 6 代"这句话里藏着两个
 * 假设：**只能 +1**、**下一级就是数组里的下一个**。想在中间插一条支线、
 * 让 5→6 指向别的东西、或者让某个时代根本没有下一步，就得改三处代码。
 *
 * 这一层把"路线"变成一个可替换的数据表：
 *
 *   · 一条**边**（`EraUpgradeEdge`）= 从 `from` 升到 `to`，可带费用覆盖、
 *     额外条件、显示名；
 *   · 一张**路线表**（`EraRouteTable`）= 一组边，按 `from` 索引；
 *   · 一局用哪张表由 `config.eraRoute` 指定，缺省是 `linear`（就是原来的 +1 表）。
 *
 * 默认路线是**从 `ERAS` 数组派生**的，不是另写一份 1→2、2→3…：
 * 时代表改一个字（改名、加一级、调费用），路线自动跟着变。两份表迟早对不上，
 * 这个项目已经栽过一次（地形字符表 char 与 TERMS 两份）。
 *
 * ---------------------------------------------------------------
 * 怎么扩展（给后来的人）
 * ---------------------------------------------------------------
 * 1. **新增一条完整路线**（比如"分岔科技线"）：
 *    ```ts
 *    registerEraRoute({
 *      id: 'branching',
 *      name: '分岔科技线',
 *      edges: [
 *        { from: 1, to: 2 },
 *        { from: 2, to: 3, cost: 300 },          // 覆盖费用
 *        { from: 3, to: 4, requires: ({ state }) => 某条件 ? null : '需要先建一座大学' },
 *        { from: 4, to: 6, label: '直接进现代' },  // 跳级：4 直接到 6
 *        { from: 5, to: 3, label: '回退（示例）' },// 目标可以是任意已定义的时代
 *      ],
 *    });
 *    ```
 *    然后在开局把 `config.eraRoute = 'branching'` 传进来（或在扩展的
 *    `onMatchStart` 里调 `setMatchEraRoute(state, 'branching')`）。
 *
 * 2. **只改某一段**：注册一个只含那几条边的表（没写的 `from` 就没有出边 =
 *    这条线到此为止）。想让"5 级之后还能升"又不想重写整张表，用 `withOverrides()`
 *    从 `linear` 复制后再盖。
 *
 * 3. **同名 id 覆盖**：`registerEraRoute` 允许覆盖已注册的 id（后注册的赢），
 *    离线实验想临时换一条线时不用改配置。
 *
 * 扩展同名 id 的覆盖是**全局**的：它影响此后所有读到这张表的对局。所以它适合
 * "整包替换某个扩展的路线"，不适合按局变化——按局变化用 `config.eraRoute`。
 */

import { ERAS, eraDef, nextUpgradeCost, type EraDef } from './config.ts';
import { activeExpansions, eraCeilingOf } from './expansions.ts';
import type { City, GameState, PlayerId } from './types.ts';

/* ===========================================================================
 * 一、接口
 * ======================================================================== */

/**
 * 条件判断的上下文。**只读**：`requires` 不该改局面，它只回答"能不能"。
 *
 * 放进 `next` 是为了省一次查询：绝大多数条件要看目标时代的属性（等级、名字），
 * 让每个钩子自己 `eraDef(edge.to)` 一遍既啰嗦又容易写成 `era + 1` 的老毛病。
 */
export interface EraUpgradeContext {
  state: GameState;
  /** 谁在升级（城市的主人，也是当前行动方） */
  player: PlayerId;
  /** 要升级的那座城 */
  city: City;
  /** 目标时代的完整定义 */
  next: EraDef;
  /** 这一条边的原始定义（要读 `label`/自定义字段时用） */
  edge: EraUpgradeEdge;
}

/**
 * 一条升级边：`from` → `to`。
 *
 * 必填只有两个数字。其余三项都是"可选覆盖"——不写就落回时代表的默认值，
 * 所以一条极简的边就是 `{ from: 1, to: 2 }`。
 */
export interface EraUpgradeEdge {
  /** 从哪一级出发（时代等级，不是数组下标） */
  from: number;
  /** 升到哪一级（可以是任意已定义的时代，允许跳级/回退） */
  to: number;
  /**
   * 覆盖升级费用。不写就用目标时代在 `ERAS` 里的 `upgradeCost`。
   * 写 `0` 是合法的（免费升级），所以判空必须用 `=== undefined`，不能用真值判断。
   */
  cost?: number;
  /**
   * 额外条件。返回 `null` = 可以升；返回字符串 = 不能升，且这句话会原样给玩家看。
   *
   * 为什么让钩子返回"原因"而不是布尔：被拒绝时必须解释清楚，
   * 而只有写这条规则的人知道该怎么说（"需要先建一座大学" vs "条件不满足"）。
   */
  requires?: (ctx: EraUpgradeContext) => string | null;
  /** 界面与战报里的短标签；不写就用目标时代的名字 */
  label?: string;
}

/** 一张路线表：一组边，按 `from` 建索引 */
export interface EraRouteTable {
  /** 稳定 id，要被 `config.eraRoute` 引用，也会进存档 */
  id: string;
  /** 给人看的名字（规则书、调试横幅） */
  name: string;
  /** 全部边。同一个 `from` 只认第一条，重复的忽略（见 `edgesByFrom`） */
  edges: readonly EraUpgradeEdge[];
}

/**
 * "这座城市下一级能升到哪"的解析结果。
 *
 * 这是**唯一**该被界面/规则/AI 读取的东西——三个地方各算一遍，
 * 迟早会出现"面板写着升到 X、点下去变成 Y"。
 */
export interface EraUpgradeTarget {
  /** 命中的那条边 */
  edge: EraUpgradeEdge;
  /** 目标时代定义（已解析） */
  era: EraDef;
  /** 实际费用（已过扩展钩子）；`null` = 这一局升不了 */
  cost: number | null;
  /** 显示名：`edge.label` ?? 目标时代名 */
  label: string;
  /** 条件不满足时的原因；`null` = 可以升 */
  blocked: string | null;
}

/* ===========================================================================
 * 二、注册表与默认路线
 * ======================================================================== */

/**
 * 默认路线：就是原来那张"每级 +1"的等差表，但**从 `ERAS` 派生**。
 *
 * `ERAS` 的顺序即路线的顺序：`ERAS[i] → ERAS[i+1]`。数组里时代的 `level`
 * 允许不连续（比如以后插一个 6.5），边的 `from/to` 用的是 `level` 而不是下标。
 */
export const LINEAR_ERA_ROUTE: EraRouteTable = {
  id: 'linear',
  name: '线性科技线',
  edges: ERAS.slice(0, -1).map((era, i) => ({ from: era.level, to: ERAS[i + 1]!.level })),
};

const ROUTES = new Map<string, EraRouteTable>();

/**
 * 注册（或替换）一条路线。
 *
 * 同名覆盖是刻意的：离线实验想临时换线，不必改配置或存档——
 * 但它也是全局的，所以**不要**用它做"按局变化"，那种用 `config.eraRoute`。
 */
export function registerEraRoute(route: EraRouteTable): void {
  ROUTES.set(route.id, route);
}

/** 按 id 取路线（没有就 undefined） */
export function eraRouteById(id: string): EraRouteTable | undefined {
  return ROUTES.get(id);
}

/** 已注册的全部路线（设置面板/规则书要列给人选时用） */
export function eraRouteList(): EraRouteTable[] {
  return [...ROUTES.values()];
}

// 默认路线先入册：`config.eraRoute` 缺省、或填了一个不认识的 id 时都落回它
registerEraRoute(LINEAR_ERA_ROUTE);

/**
 * 这一局用哪张表。
 *
 * 解析顺序（先命中先用）：
 *   1. `state.config.eraRoute`（开局由面板/扩展/存档带进来）；
 *   2. 已注册的 `linear`。
 *
 * **填错不回退到别的线，只回退到 linear**：一条不存在的路线意味着"这个存档
 * 来自装了某个扩展的客户端"，这时按最保守的线性表走，玩家至少还能玩。
 */
export function eraRouteFor(state: GameState): EraRouteTable {
  const id = state.config.eraRoute;
  if (id) {
    const found = ROUTES.get(id);
    if (found) return found;
  }
  return ROUTES.get('linear') ?? LINEAR_ERA_ROUTE;
}

/**
 * 对局中途换线（扩展的 `onMatchStart` / 调试命令用）。
 *
 * 只改 `config.eraRoute`，不碰已经升过的城：路线是"从现在起往哪走"，
 * 不是"把历史重写一遍"。所以换线之后，城市的 `era` 保持原值，
 * 下一次升级按新表查。
 */
export function setMatchEraRoute(state: GameState, id: string): boolean {
  if (!ROUTES.has(id)) return false;
  state.config.eraRoute = id;
  return true;
}

/* ===========================================================================
 * 三、查询
 * ======================================================================== */

/** 把路线表按 `from` 建索引；同一个 `from` 出现多次时只认第一条 */
function edgesByFrom(route: EraRouteTable): Map<number, EraUpgradeEdge> {
  const map = new Map<number, EraUpgradeEdge>();
  for (const edge of route.edges) {
    if (!map.has(edge.from)) map.set(edge.from, edge);
  }
  return map;
}

/**
 * 这座城市这一级往哪升。没有出边 = 科技线到此为止，返回 `null`。
 *
 * 这里**不看封顶**（`eraCeilingOf`）：封顶是"这一局能不能开到那一层"，
 * 路线是"开到了之后往哪走"。两件事分开，扩展才可能既要封顶又要改道。
 */
export function upgradeEdgeOf(state: GameState, city: City): EraUpgradeEdge | null {
  const route = eraRouteFor(state);
  return edgesByFrom(route).get(city.era) ?? null;
}

/** 下一级的时代等级（没有下一级返回 `null`）。AI 想"按代比较兵"时用它 */
export function nextEraLevelOf(state: GameState, city: City): number | null {
  return upgradeEdgeOf(state, city)?.to ?? null;
}

/** 下一级的时代定义（没有下一级返回 `null`） */
export function nextEraOf(state: GameState, city: City): EraDef | null {
  const to = nextEraLevelOf(state, city);
  return to === null ? null : eraDef(to);
}

/**
 * 这座城升下一级的完整解析：目标时代、费用、条件、显示名。
 *
 * 返回 `null` 的三种情况（调用方要区分时看 `blockedReasonOf`）：
 *   · 路线上没有出边（科技线到此为止）；
 *   · 这一局封顶了（`eraCeilingOf`，取决于开没开对应扩展）；
 *   · 扩展把费用钩成了 `null`（"这回合不卖"）。
 *
 * **封顶判定在费用钩子之前**——这条顺序是 2026-11 的老结论，别调换：
 * 「血战」那种"照旧价目表收钱"的钩子会在封顶之后把 null 又变回一个价格，
 * 玩家就会看见一个点得动、点了却没反应的按钮。
 */
export function upgradeTargetOf(state: GameState, city: City): EraUpgradeTarget | null {
  const edge = upgradeEdgeOf(state, city);
  if (!edge) return null;
  if (city.era >= eraCeilingOf(state)) return null;

  const era = eraDef(edge.to);
  const ctxBase = { state, player: city.owner, city, next: era, edge };

  // 费用：边上的覆盖 → 目标时代的价目 → null（认为不能升）
  let cost: number | null = edge.cost !== undefined ? edge.cost : nextUpgradeCost(city.era);
  if (cost === null) cost = era.upgradeCost > 0 ? era.upgradeCost : null;

  for (const e of activeExpansions(state)) {
    if (!e.hooks.modifyUpgradeCost || cost === null) continue;
    cost = e.hooks.modifyUpgradeCost({
      state,
      player: city.owner,
      city,
      nextEra: edge.to,
      cost,
    });
  }

  const blocked = edge.requires ? edge.requires(ctxBase) : null;
  return {
    edge,
    era,
    cost: cost === null ? null : Math.max(0, cost),
    label: edge.label ?? era.name,
    blocked,
  };
}

/* ===========================================================================
 * 四、数据驱动的构造工具
 * ======================================================================== */

/**
 * 从一条已有路线复制、再覆盖若干 `from` → 新表。
 *
 * 用途：只想改一段（"第 5 代之后不再走信息化，改走蒸汽朋克"）时，不必把六条边
 * 全部重抄一遍——抄漏一条就是"科技线莫名断档"，而且很难看出来。
 *
 * `overrides` 里把 `to` 写成 `null` 表示"这一段到此为止"（删掉这条边）。
 */
export function withOverrides(
  base: EraRouteTable,
  id: string,
  name: string,
  overrides: Record<number, EraUpgradeEdge | null>,
): EraRouteTable {
  const kept = base.edges.filter((e) => overrides[e.from] === undefined);
  const added: EraUpgradeEdge[] = [];
  for (const [from, edge] of Object.entries(overrides)) {
    if (edge) added.push({ ...edge, from: Number(from) });
  }
  return { id, name, edges: [...kept, ...added].sort((a, b) => a.from - b.from) };
}
