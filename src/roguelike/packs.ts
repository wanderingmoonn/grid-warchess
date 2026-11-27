/**
 * 肉鸽 2.0 的**扩展接入层**（2026-11-28）。
 *
 * 这一页要解决的问题只有一个：**肉鸽不能再手抄 DLC 的兵池**。
 *
 * 上一版 `data.ts` 给每一层/每一支史写死了一串兵种 id。那串 id 是 2026-11 的
 * 快照：加一个新包、改一个兵的时代、把一个兵标成 `requiresPack`，肉鸽都不会
 * 跟着变——最坏的情况是池子里出现一个"查不到"的 id，静默少一个敌人。
 * 而原版战役模式从来不需要改代码：开局面板勾包 → `createMatch` 按
 * `EXPANSIONS` 现算兵种表 → 兵池就是"这个包里这个时代的兵"。
 *
 * 所以这里照战役模式的口径重建三件事：
 *   1. **包的角色**：这个包是兵种包（决定某一层的兵池）、规则包（只改规则，
 *      可选作本局规则）、还是需要一整套系统（海图/星图/等高线/城市经济），
 *      本版跑不了——每条都给理由，漏一个包会在控制台点名。
 *   2. **兵池**：按 `era` / `category` / `domain` / `summonedOnly` / `requiresPack`
 *      从 `EXPANSIONS[].units` 现算。**不再出现任何手写的单位名单**。
 *   3. **开局的可选项**：原版的开局面板能勾包，肉鸽也给一份——规则包与联动
 *      兵种包可选，剧情兵种包跟着史线走（不抢第一层的选择权）。
 *
 * 一条硬规矩：**本文件不 import `data.ts` 的运行时值**，只 import 类型。
 * 因为 `data.ts` 要 import 这里的 `poolOf`，运行时互相引用会成环。
 */
import { UNIT_TYPES } from '../core/config.ts';
import { EXPANSIONS, enabledExpansionIds, expansionById } from '../core/expansions.ts';
import type { UnitTypeDef } from '../core/types.ts';
import type { LayerId } from './types.ts';
import type { WorldId } from './data.ts';

/** 原版兵种不属于任何扩展，用一个伪包 id 参与兵池计算 */
export const CORE_PACK = 'core';

/**
 * 一个包在肉鸽里的角色。
 *
 *   story   —— 剧情兵种包：由第一层的事件/试炼决定第二层走哪支史，跟着史线开。
 *              玩家不能在开局勾它（那会绕过"路是打出来的"这条设计）。
 *   rule    —— 纯规则包：没有兵种，只改伤害/移动/视野/城市……可选作本局规则。
 *   support —— 联动兵种包：有兵种，但不是任何一支史的主体（空军）；
 *              勾了之后它的兵按时代进入对应层的兵池。
 *   system  —— 需要一整套本版没有的系统（海图、星图、等高线、城市经济、
 *              行动点重写回合结构、强制迷雾）。**不是"以后再说"的垃圾桶**：
 *              每条都写清缺哪一块，接的时候照着补。
 *   locked  —— 能跑但在这个模式里**没有作用**（起始金/后手补偿被出征金覆盖、
 *              单位全是 summonedOnly）。列出来是为了让玩家知道"不是漏了"。
 */
export type PackKind = 'story' | 'rule' | 'support' | 'system' | 'locked';

/** 兵池窗口：缺省 = 本层自己的低代/高代/上一代 */
export interface EraWindow {
  low?: [number, number];
  high?: [number, number];
  prev?: [number, number];
}

export interface PackPlan {
  kind: PackKind;
  /** story 包：它代表哪一支史 */
  world?: WorldId;
  /** 它的兵可以出现在哪几层 */
  layers?: LayerId[];
  /**
   * 按层覆盖兵池窗口。
   *
   * 只有修真需要：它的战斗单位在 e1–e4 一共 9 个，按"每层只取当代"算，
   * 第二层低代只有 3 个、高代只有 1 个，池子会退化成两三个兵。
   * 修真的设定本来就是"不换代，按境界涨"，所以第二层放开成 e1–e3 / e3–e4。
   */
  windows?: Partial<Record<LayerId, EraWindow>>;
  /** 开局能不能勾（story / system / locked 一律 false） */
  choosable?: boolean;
  /** 开局默认勾上 */
  defaultOn?: boolean;
  /** system / locked 的理由；也用作界面上的说明 */
  reason?: string;
}

/**
 * 28 个包的逐条审计。
 *
 * 改动这里之前先读 `docs/ROGUELIKE-DLC.md` 的对照表——那里的"为什么"更长，
 * 这里只留能指导代码的短句。
 */
export const PACK_PLANS: Record<string, PackPlan> = {
  /* ---------------- 剧情兵种包（跟史线） ---------------- */
  'era-arms': {
    kind: 'story',
    world: 'arms',
    layers: [2, 3],
    reason: '时代军备：第二层「军械库」的主体兵池；第三层作为本世界溢出',
  },
  fantasy: {
    kind: 'story',
    world: 'fantasy',
    layers: [2, 3],
    reason: '奇想：第二层「异境」的主体兵池；第三层作为本世界溢出',
  },
  cultivation: {
    kind: 'story',
    world: 'cultivation',
    layers: [2, 3],
    windows: {
      // 第二层：炼气到金丹的兵都算"当代"；第三层是末法之世，按 e5/e6 取不到人
      2: { low: [1, 3], high: [3, 4] },
    },
    reason: '修真：第二层「山门」；第三层末法之世（没有修士，只有机器）',
  },

  /* ---------------- 联动兵种包（可勾） ---------------- */
  'pack-contemporary': {
    kind: 'support',
    layers: [3],
    choosable: false,
    reason: '信息化：第三层的高代底座（e6），由层结构固定开启',
  },
  air: {
    kind: 'support',
    layers: [2, 3],
    choosable: true,
    defaultOn: false,
    reason: '空军 e4–e6：勾了之后按时代进入第二层高代 / 第三层兵池',
  },

  /* ---------------- 纯规则包（可勾） ---------------- */
  'war-economy': {
    kind: 'rule',
    choosable: true,
    defaultOn: true,
    reason: '击杀赏金当场进账，战后随金币带走',
  },
  veterans: {
    kind: 'rule',
    choosable: true,
    defaultOn: false,
    reason: '击杀成长 + 城下回血；肉鸽的击杀数每场重置，且只有"有城的那一方"能回血',
  },
  trench: {
    kind: 'rule',
    choosable: true,
    defaultOn: false,
    reason: '林丘 +2 甲；对低代互殴影响很大，默认关',
  },
  blitz: {
    kind: 'rule',
    choosable: true,
    defaultOn: false,
    reason: '快速单位 +2 移；会明显缩短接敌回合',
  },
  'night-raid': {
    kind: 'rule',
    choosable: true,
    defaultOn: false,
    reason: '视野 −1；肉鸽战斗屏不开雾，收益主要在 AI 视野',
  },
  'scorched-earth': {
    kind: 'rule',
    choosable: true,
    defaultOn: true,
    reason: '阵亡波及相邻；小图上会放大"挤一团"的代价',
  },
  fortress: {
    kind: 'rule',
    choosable: true,
    defaultOn: false,
    reason: '所有城 +20 耐久 +1 甲；攻坚/层末明显变难',
  },
  bloodbath: {
    kind: 'rule',
    choosable: true,
    defaultOn: false,
    reason: '城不回血/移动视野 +1；肉鸽战斗短，主要在长局生效',
  },
  'last-stand': {
    kind: 'rule',
    choosable: true,
    defaultOn: false,
    reason: '哀兵：残部伤害提高；对"以少打多"的守城战影响最大',
  },
  'high-mobility': {
    kind: 'rule',
    choosable: true,
    defaultOn: false,
    reason: '全军移动/射程/视野 +1；节奏变化很大',
  },
  seasons: {
    kind: 'rule',
    choosable: true,
    defaultOn: false,
    reason: '四季轮换改移动/视野/射程/护甲；顶栏有天气徽章',
  },

  /* ---------------- 需要整套系统（不可用） ---------------- */
  naval: {
    kind: 'system',
    reason: '需要海图与临水城；三层地图是平原（无水）',
  },
  'space-age': {
    kind: 'system',
    reason: '需要月球图与发射井；肉鸽是地面战场',
  },
  'space-war': {
    kind: 'system',
    reason: '需要星图/空间站；依赖太空时代',
  },
  'city-works': {
    kind: 'system',
    reason: '城市经济、施工与多资源；肉鸽前三层玩家没有城',
  },
  'height-terrain': {
    kind: 'system',
    reason: '需要等高线地图；肉鸽地图是平原创成，没有高度',
  },
  'action-points': {
    kind: 'system',
    reason: '行动点会重写移动/攻击的回合结构，战斗屏与 AI 预算未适配',
  },
  blackout: {
    kind: 'system',
    reason: '强制锁定迷雾；肉鸽战斗屏为了"小图短兵相接"主动关雾',
  },

  /* ---------------- 能跑但本模式无作用 ---------------- */
  conscription: {
    kind: 'locked',
    reason: '起始金减半会被出征金覆盖；造价修正只影响城内在产线，肉鸽没有产线',
  },
  'turn-order-comp': {
    kind: 'locked',
    reason: '后手起始金补偿：肉鸽没有"后手开局金"，双方编成是关卡写死的',
  },
  'dark-turmoil': {
    kind: 'locked',
    reason: '27 个单位全部 summonedOnly（只能由事件召唤），不进常规兵池；留给 L4',
  },
  'armor-era7': {
    kind: 'system',
    reason: '第 7 时代；前三层最高到 e6（装甲时代留给 L4）',
  },
  'armor-era8': {
    kind: 'system',
    reason: '第 8 时代；前三层最高到 e6（聚变时代留给 L4）',
  },
};

/** 开发期护栏：加了一个新扩展却忘了在这里定性 → 控制台点名 */
{
  const missing = EXPANSIONS.filter((e) => !PACK_PLANS[e.id]).map((e) => e.id);
  if (missing.length > 0) {
    console.warn('[肉鸽] 这些扩展没有在 PACK_PLANS 里定性（不会进入肉鸽）：', missing);
  }
}

/** 这一层自己的时代：低代 / 高代 / 上一代 */
export const LAYER_ERAS: Record<LayerId, { low: number; high: number; prev: number }> = {
  1: { low: 1, high: 2, prev: 0 },
  2: { low: 3, high: 4, prev: 2 },
  3: { low: 5, high: 6, prev: 4 },
};

/**
 * 一个兵种进不进常规兵池。
 *
 * 这几条不是"口味"，是**肉鸽的编制前提**：
 *   · `combat`：工事/经济/建造单位不参与抽兵（工事由关卡单独发）；
 *   · 非水：三层地图没有水，船开不出来；
 *   · 非 `summonedOnly`：那些是"只能由事件召唤"的东西（黑暗动乱全包都是）；
 *   · `cost > 0`：造价 0 的多是剧情/不可造单位，放进池子会让预算算法除以 0；
 *   · `requiresPack` 满足：圣剑勇者要信息化，单开奇想拿不到它。
 *
 * **不排除 `campOnly`**：那个字段的意思是"城市产线造不出来、只能由特定建筑产"，
 * 修真的法器就是这一类。肉鸽本来就没有城、没有产线，兵只从战利品/商店/事件来，
 * 所以法器是完全可以上场的战斗单位（上一版手写池里一直有它们）。
 */
export function unitInPool(u: UnitTypeDef, live: ReadonlySet<string>): boolean {
  if (u.category !== 'combat') return false;
  if (u.domain === 'water') return false;
  if (u.summonedOnly) return false;
  if (u.legacy) return false;
  if (!(u.cost > 0)) return false;
  if (u.requiresPack && !live.has(u.requiresPack)) return false;
  return true;
}

/**
 * 一组包里的某个时代的兵。
 *
 * `packs` 里可以出现 `core`（原版兵种）。返回值**去重、按造价升序**：
 * 抽兵、奖励、商店都靠价格档位，顺序稳定才可复现。
 */
export function poolOf(packs: readonly string[], layer: LayerId, band: 'low' | 'high' | 'prev'): string[] {
  // 依赖闭包：调用方只写子包时，前置包也要跟着进池（否则整包被 enabledExpansionIds 丢掉）
  const expanded = [...new Set([...packs, ...withPackDeps(packs)])];
  const live = enabledExpansionIds(expanded.filter((p) => p !== CORE_PACK));
  const eras = LAYER_ERAS[layer];
  const out: string[] = [];
  const seen = new Set<string>();

  const push = (u: UnitTypeDef): void => {
    if (seen.has(u.id)) return;
    if (!unitInPool(u, live)) return;
    seen.add(u.id);
    out.push(u.id);
  };

  for (const pack of expanded) {
    const win = PACK_PLANS[pack]?.windows?.[layer];
    let range: [number, number] | null;
    if (band === 'prev') {
      range = win?.prev ?? (eras.prev > 0 ? [eras.prev, eras.prev] : null);
    } else {
      const fallback: [number, number] = [eras[band], eras[band]];
      range = (band === 'low' ? win?.low : win?.high) ?? fallback;
    }
    if (!range) continue;
    const [lo, hi] = range;

    if (pack === CORE_PACK) {
      for (const u of Object.values(UNIT_TYPES)) {
        if (u.era >= lo && u.era <= hi) push(u);
      }
      continue;
    }
    const def = expansionById(pack);
    if (!def) continue;
    // 包本身没启用（前置没满足/冲突）时，它的兵一个都不该进池
    if (!live.has(pack)) continue;
    for (const u of def.units ?? []) {
      if (u.era !== undefined && u.era >= lo && u.era <= hi) push(u);
    }
  }
  return out.sort((a, b) => {
    const ca = catalogCost(a);
    const cb = catalogCost(b);
    return ca - cb || a.localeCompare(b);
  });
}

/** 造价查询：池子里只可能是已启用包的兵，直接用 `expansionById` 反查太慢，走一张懒表 */
const COST_CACHE = new Map<string, number>();
function catalogCost(id: string): number {
  const hit = COST_CACHE.get(id);
  if (hit !== undefined) return hit;
  let cost = UNIT_TYPES[id]?.cost ?? 0;
  if (cost === 0) {
    for (const e of EXPANSIONS) {
      const u = e.units?.find((x) => x.id === id);
      if (u) {
        cost = u.cost ?? 0;
        break;
      }
    }
  }
  COST_CACHE.set(id, cost);
  return cost;
}

/** 某支史的剧情兵种包 */
export function storyPacksFor(world: WorldId): string[] {
  return Object.entries(PACK_PLANS)
    .filter(([, p]) => p.kind === 'story' && p.world === world)
    .map(([id]) => id);
}

/**
 * 某个兵种"上场需要开哪些包"。
 *
 * 比上一版多走两步：
 *   · **包级 `requires` 的闭包**（armor-era8 → armor-era7；
 *     dark-turmoil → cultivation）；
 *   · **兵种级 `requiresPack`**（圣剑勇者 → pack-contemporary）。
 * 少一步的表现都是"部署时查不到兵种，那个人静默消失"。
 */
const PACK_DEPS: Record<string, string[]> = (() => {
  const out: Record<string, string[]> = {};
  const visit = (id: string, seen: Set<string>): string[] => {
    if (seen.has(id)) return [];
    seen.add(id);
    const def = expansionById(id);
    if (!def) return [id];
    return [id, ...(def.requires ?? []).flatMap((r) => visit(r, seen))];
  };
  for (const e of EXPANSIONS) {
    const ids = new Set<string>();
    const list = visit(e.id, ids);
    out[e.id] = [...new Set(list)];
  }
  return out;
})();

export function packsForUnit(type: string): string[] {
  // 原版兵种
  if (UNIT_TYPES[type]) return [];
  for (const e of EXPANSIONS) {
    const u = e.units?.find((x) => x.id === type);
    if (!u) continue;
    const packs = PACK_DEPS[e.id] ?? [e.id];
    return [...new Set([...packs, ...(u.requiresPack ? PACK_DEPS[u.requiresPack] ?? [u.requiresPack] : [])])];
  }
  return [];
}

/**
 * 把一组包补成**依赖闭包**（包级 `requires` 逐层展开）。
 *
 * 为什么每一条进场路径都要过它：`enabledExpansionIds` 会把"前置没满足"的包
 * 整包丢掉——钩子和兵种都不进场。如果调用方只传了子包，表现就是
 * "明明勾了、兵一个都没有"，而且不报错。
 */
export function withPackDeps(ids: readonly string[]): string[] {
  const out: string[] = [];
  for (const id of ids) {
    if (id === CORE_PACK) continue;
    for (const dep of PACK_DEPS[id] ?? [id]) if (!out.includes(dep)) out.push(dep);
  }
  return out;
}

/** 一个可选包在开局面板上的样子 */
export interface PackChoice {
  id: string;
  name: string;
  blurb: string;
  kind: PackKind;
  defaultOn: boolean;
  reason: string;
}

export function ruleChoices(): PackChoice[] {
  return EXPANSIONS.filter((e) => PACK_PLANS[e.id]?.kind === 'rule' && PACK_PLANS[e.id]?.choosable)
    .map((e) => ({
      id: e.id,
      name: e.name,
      blurb: e.blurb ?? '',
      kind: 'rule' as const,
      defaultOn: PACK_PLANS[e.id]?.defaultOn === true,
      reason: PACK_PLANS[e.id]?.reason ?? e.summary,
    }))
    .sort((a, b) => Number(b.defaultOn) - Number(a.defaultOn) || a.name.localeCompare(b.name));
}

export function supportChoices(): PackChoice[] {
  return EXPANSIONS.filter((e) => PACK_PLANS[e.id]?.kind === 'support' && PACK_PLANS[e.id]?.choosable)
    .map((e) => ({
      id: e.id,
      name: e.name,
      blurb: e.blurb ?? '',
      kind: 'support' as const,
      defaultOn: PACK_PLANS[e.id]?.defaultOn === true,
      reason: PACK_PLANS[e.id]?.reason ?? e.summary,
    }));
}

/** 开局默认勾选的可选包 */
export function defaultExtraPacks(): string[] {
  return [...ruleChoices(), ...supportChoices()].filter((c) => c.defaultOn).map((c) => c.id);
}

/**
 * 开局勾选结果 → 真正会进场的包。
 *
 * 走 `enabledExpansionIds`（前置/冲突/归一化都由它管），再剔掉
 * 不是 rule/support 的东西——存档或链接里塞一个 `naval` 进来也不该生效。
 */
export function normalizeExtraPacks(ids: readonly string[]): string[] {
  const allowed = new Set(
    Object.entries(PACK_PLANS)
      .filter(([, p]) => (p.kind === 'rule' || p.kind === 'support') && p.choosable)
      .map(([id]) => id),
  );
  const want = withPackDeps(ids.filter((id) => allowed.has(id)));
  return [...enabledExpansionIds(want)];
}

/**
 * 一场战斗要开的扩展：剧情包 + 联动包 + 规则包 + 队伍里那些兵所属的包。
 *
 * **不按 `PACK_PLANS.kind` 过滤**：`system/locked` 说的是"它不能决定兵池"，
 * 不是"它永远不能进场"。如果某一天队伍里真的带了一个来自这些包的兵
 * （事件给的、L4 继承的），把包滤掉会让那个兵在部署时静默消失——
 * 那比多开一个钩子难查得多。未知 id 交给 `enabledExpansionIds` 处理。
 */
export function mergeBattlePacks(...lists: ReadonlyArray<readonly string[]>): string[] {
  const all = withPackDeps(lists.flat().filter((id) => id !== CORE_PACK));
  return [...enabledExpansionIds(all)];
}

/**
 * 界面上「这些扩展本版不可用」那一段。
 *
 * 不是装饰：接到一半的包最容易被误认为"代码漏了"，把理由摆在眼前，
 * 下次接手的人才知道该补海图还是星图。
 */
export function unavailablePacks(): Array<{ id: string; name: string; reason: string; kind: PackKind }> {
  return EXPANSIONS.filter((e) => {
    const p = PACK_PLANS[e.id];
    return p && (p.kind === 'system' || p.kind === 'locked');
  }).map((e) => ({
    id: e.id,
    name: e.name,
    reason: PACK_PLANS[e.id]?.reason ?? '',
    kind: PACK_PLANS[e.id]?.kind ?? 'system',
  }));
}
