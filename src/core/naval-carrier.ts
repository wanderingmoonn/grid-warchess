/**
 * 航母甲板：留给"未来的空军扩展"的那道接口。
 *
 * ── 为什么这道接口要单独一个文件 ──────────────────────────────────────
 *
 * 航空母舰是唯一一个"自己不打仗、靠别的东西打仗"的兵种。它天然跨两条线：
 * 船是海军包的东西，飞机是空军包的东西。如果把"起飞"写死在海军包里，
 * 空军包要么改海军包（扩展之间互相改，最后没人说得清谁依赖谁），
 * 要么根本接不进来。所以这里只留一层**契约**：海军包交出甲板，
 * 空军包交出一个实现，两边只认下面这几个类型。
 *
 * ── 职责边界（这一段是这道接口存在的全部理由）──────────────────────────
 *
 * 海军包（`naval-packs.ts`）负责：
 *   · 船本身：数值、造价、`capacity` 个机位、起飞半径；
 *   · **容器**：把飞机从棋盘上摘下来存进 `carrier.custom.airwing`，
 *     以及反过来放回棋盘（见 `stowPlane` / `popPlane`）；
 *   · 回合开始时把"轮到你整备了"这个时机转告给空军扩展；
 *   · 界面上的那一行「甲板 2/4」。
 *
 * 空军扩展负责：
 *   · 飞机是**它**的兵种：属性、造价、燃油、整备、损失；
 *   · `canBoard`：什么飞机能上什么船（垂直起降能上驱逐舰，重型轰炸机不能）；
 *   · `launch`：起飞后落在哪一格、这一回合还能不能动、要不要扣油；
 *   · `recover`：能不能回收（弹尽、受损、船正在沉）。
 *
 * **互不越界**的两条硬线：
 *   1. 海军包永远不创建、不定义飞机。没有空军扩展时，航母就是一艘
 *      视野很远的指挥舰（见 `nv-fleet-command`），照常能打完一整局。
 *   2. 空军扩展永远不直接改船的数值。要改只能走 `ExpansionHooks.modify*`
 *      （比如"有预警机的航母视野 +2"），那些是纯函数，不会把船写成半成品。
 *
 * ── 为什么容器放在海军包这边 ─────────────────────────────────────────
 *
 * 飞机停在船上时不该占棋盘格（否则一艘航母四架飞机，周边八格全被堵死，
 * 而这在真实规则里毫无道理）。要做到"不占格"，就只能把它从 `state.units`
 * 里摘出去。**只有一处**代码该知道"摘下来的飞机存在哪里"——就是这里。
 * 空军扩展只管调 `stowPlane` / `popPlane`，不需要知道结构长什么样，
 * 也就不可能在两个包里各写一套互不兼容的存储。
 */

import type { GameState, Unit } from './types.ts';

/** 停在甲板上的飞机。存字段而不是存整个 Unit：卸船时要重新编号、重摆位 */
export interface StowedPlane {
  /** 兵种 id（空军扩展自己的兵种表里必须查得到） */
  type: string;
  /** 进库时的血量。小于上限就是"带伤返航" */
  hp: number;
  /** 累计击杀，跟着飞机走（老兵不死那类规则靠它） */
  kills?: number;
}

/** 一类船的甲板规格 */
export interface DeckSpec {
  /** 机位数量 */
  capacity: number;
  /**
   * 起飞/回收时允许落脚的半径（格）。
   *
   * 航母大、两栖舰小；直升机可以垂直起降，固定翼要跑道——
   * 这条只给"最远能放到几个格之外"，具体能不能起，由空军的 `canBoard` 说了算。
   */
  launchRange: number;
}

/**
 * 哪些船有甲板。
 *
 * 只登记"确实能带飞机"的船，没登记的船 `deckSpecOf` 返回 null，
 * 空军扩展据此拒绝上舰——比在空军包里抄一份船名表更不容易走散。
 */
export const DECK_SPECS: Readonly<Record<string, DeckSpec>> = {
  // 航空母舰：四个机位，起飞半径 2（够到相邻格之外）
  nv_carrier: { capacity: 4, launchRange: 2 },
  // 两栖攻击舰：两个机位，主要带直升机
  nv_amphib: { capacity: 2, launchRange: 1 },
};

export function deckSpecOf(typeId: string): DeckSpec | null {
  return DECK_SPECS[typeId] ?? null;
}

/**
 * 甲板上现在停着谁。
 *
 * 直接读 `custom.airwing`，不另建一张全局表：`custom` 会跟着存档/联机快照
 * 一起走，不存在"两边各记一份、其中一份过期"的情况。
 */
export function deckOf(carrier: Unit): StowedPlane[] {
  const raw = carrier.custom?.airwing;
  return Array.isArray(raw) ? (raw as StowedPlane[]) : [];
}

export function deckUsed(carrier: Unit): number {
  return deckOf(carrier).length;
}

export function deckFree(carrier: Unit): number {
  const spec = deckSpecOf(carrier.type);
  return spec ? Math.max(0, spec.capacity - deckUsed(carrier)) : 0;
}

/**
 * 把一架飞机收进甲板。
 *
 * 调用方（空军扩展）负责先从 `state.units` 里把它删掉——这里只管存。
 * 为什么不在这一层替它删：删单位要连带动 `state.units` 的编号与引用，
 * 那是规则层的活；扩展里对 `state.units` 做过滤是既有惯例（焦土就这么干），
 * 但**删谁**只有空军扩展知道（它可能还要处理飞行员、载具残骸之类）。
 */
export function stowPlane(carrier: Unit, plane: Unit): boolean {
  if (deckFree(carrier) <= 0) return false;
  const list = deckOf(carrier).slice();
  list.push({ type: plane.type, hp: plane.hp, ...(plane.kills > 0 ? { kills: plane.kills } : {}) });
  carrier.custom = { ...(carrier.custom ?? {}), airwing: list };
  return true;
}

/**
 * 从甲板上取下一架（按索引）。
 *
 * 返回的是"躺着的记录"，不是 `Unit`——真正落回棋盘要新建单位、重新编号，
 * 那一步归空军扩展（它可能还要检查落点、给燃油、贴状态）。
 */
export function popPlane(carrier: Unit, index = 0): StowedPlane | null {
  const list = deckOf(carrier).slice();
  if (index < 0 || index >= list.length) return null;
  const [taken] = list.splice(index, 1);
  carrier.custom = { ...(carrier.custom ?? {}), airwing: list };
  return taken ?? null;
}

/* ---------------------------------------------------------------------------
 * 空军扩展接进来的那个口子
 * ------------------------------------------------------------------------- */

export interface LaunchCtx {
  state: GameState;
  carrier: Unit;
  /** 要起飞的是哪种飞机（甲板上的记录里有） */
  plane: StowedPlane;
}

export interface RecoverCtx {
  state: GameState;
  carrier: Unit;
  /** 已经落在/贴在母舰旁边的那个飞机单位 */
  plane: Unit;
}

export type AirOpResult = { ok: true } | { ok: false; reason: string };

/**
 * 空军扩展要实现的东西。
 *
 * 没注册实现时，航母照常是一条船：数值、指挥光环、视野都在，
 * 只是甲板是空的、面板上写着"空军扩展未接入"。**不做任何"假装有飞机"的兜底**——
 * 那会让玩家以为起了飞，实际棋盘上什么都没有。
 */
export interface AirwingOps {
  /** 谁实现的（'air-core'、别的扩展名……），只用于面板显示与排错 */
  id: string;
  /** 面板上显示的名字，比如「舰载航空兵」 */
  name: string;

  /** 这架飞机能不能上这条船。判据完全归空军扩展（重量、跑道、垂直起降） */
  canBoard(c: { state: GameState; carrier: Unit; planeTypeId: string }): boolean;

  /**
   * 起飞。空军扩展在这一步创建单位、决定落点、扣燃油。
   *
   * 返回 ok:false 时**不要把飞机从甲板上取走**——调用方会原样留着，
   * 玩家下回合可以再试。这是"起飞失败不该损失一架飞机"的保证。
   */
  launch(c: LaunchCtx): AirOpResult;

  /** 回收：把一个已经贴着母舰的飞机收进甲板 */
  recover(c: RecoverCtx): AirOpResult;

  /** 甲板整备：每回合开始时，海军包替空军扩展叫一次 */
  onDeckTurnStart?(c: { state: GameState; carrier: Unit }): void;
}

let registered: AirwingOps | null = null;

/**
 * 注册/注销空军实现。
 *
 * 只有一份：航母的甲板是**同一条**规则，两个空军包同时注册会出现
 * "同一个机位两种算法"，界面上也说不清这架飞机归谁管。想并存就让
 * 空军包内部自己分派（它们的 `canBoard` 可以各自返回 false）。
 */
export function registerAirwingOps(next: AirwingOps | null): void {
  registered = next;
}

export function airwingOps(): AirwingOps | null {
  return registered;
}

/** 面板那一行：「甲板 2/4」或者「甲板空置（空军扩展未接入）」 */
export function deckLine(carrier: Unit): string | null {
  const spec = deckSpecOf(carrier.type);
  if (!spec) return null;
  const used = deckUsed(carrier);
  const ops = airwingOps();
  return ops
    ? `甲板 ${used} / ${spec.capacity} · ${ops.name}`
    : `甲板 ${used} / ${spec.capacity} · 空军扩展未接入（航母暂时只当指挥舰）`;
}
