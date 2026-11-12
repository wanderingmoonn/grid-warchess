/**
 * 火箭发射井（时代 5）——地月之间的第一班车。
 *
 * ── 为什么是一个"货舱建筑" ────────────────────────────────────────────
 *
 * 装载/卸载这件事故意**不自己写**：兵种数据上挂 `carry.hold = 1`，
 * 游戏里现成的那套（面板的「装载 / 卸载」按钮、`LOAD` / `UNLOAD` 动作、
 * 货舱随建筑一起被摧毁）立刻就能用。规则层不需要认识"火箭"这个词。
 *
 * 于是发射井做的事情只剩下三件，全部在这个文件里：
 *   1. **加注燃料**：点一下开始，之后每回合 +1，满 3 回合才能点火；
 *   2. **发射**：把货舱里的单位送进**一条航道**（`transit.ts`）。
 *      注意它**不知道目的地在哪**——从哪儿出发就去查星图上这个节点有哪些航道。
 *      基础包只有"地球→月球"一条，以后会有更多条、也会被封锁；
 *   3. **写面板文案**：燃料几格、还差什么才能飞。
 *
 * ── 为什么不引入"燃料"资源 ────────────────────────────────────────────
 *
 * 加注是**计时器**不是资源：它不参与经济、AI 不用学、规则书不用加一节，
 * 但它给了对手一个看得见的窗口——顶栏和面板上写着"2 / 3"，
 * 对面看见你在加注，还有一回合时间来拆井或者堵着陆点。
 * 这是整条链上唯一"能被反制"的环节，比多一种货币重要。
 */

import type { GameState, PlayerId, StarNodeId, Unit, UnitTypeDef } from '../types.ts';
import { underConstruction } from '../query.ts';
import { markSpotlight, clearSpotlight } from '../spotlight.ts';
import { lanesFrom, nodeById, nodeName, nodeOf } from './starmap.ts';
import { cellName, enterLane, landingSpotOn, laneTurnsFor } from './transit.ts';

/** 建筑 id。写进存档，改它等于让老存档里的发射井变成一块石头 */
export const SILO_ID = 'rocket_silo';

/** 加注满要几回合（每回合 +1） */
export const SILO_FUEL_TURNS = 3;

export const ROCKET_SILO: UnitTypeDef = {
  id: SILO_ID,
  name: '火箭发射井',
  short: '井',
  era: 5,
  category: 'building',
  cost: 420,
  buildCost: 72,
  move: 0,
  atk: 0,
  armor: 10,
  maxHp: 120,
  range: 0,
  vision: 4,
  // 2×2：发射井是个场地，不是一个箱子。四格一起挡路、一起挨打。
  footprint: 2,
  // 只能建在平原：要一块平地当发射场，也顺手把"河道里竖一枚火箭"挡掉
  buildOn: ['plain'],
  /*
   * 一个货舱。
   *
   * 不给 `allow`：默认那头（地面、非建筑）正好就是"运一支地面部队"，
   * 而船和飞机本来就该另走海空——火箭不带它们玩。
   */
  carry: { hold: { max: 1 } },
};

/** 井里存的东西。老存档没有 `custom`，一律当 0 / 没在加注 */
interface SiloState {
  fuel: number;
  fueling: boolean;
}

/** 读一下发射井的状态（任何单位都能传，非发射井返回 0/停） */
export function siloStateOf(u: Unit): SiloState {
  const raw = Number(u.custom?.fuel ?? 0);
  const fuel = Number.isFinite(raw) ? Math.max(0, Math.min(SILO_FUEL_TURNS, Math.round(raw))) : 0;
  return { fuel, fueling: u.custom?.fueling === true && fuel < SILO_FUEL_TURNS };
}

function writeSilo(u: Unit, next: SiloState): void {
  u.custom ??= {};
  u.custom.fuel = next.fuel;
  u.custom.fueling = next.fueling;
}

function isSilo(s: GameState, u: Unit): boolean {
  return u.type === SILO_ID && !!s.unitTypes[SILO_ID];
}

function log(s: GameState, p: PlayerId, text: string, open = false): void {
  s.log.push({ turn: s.turn, player: p, text, open });
}

/**
 * 加注：点一下开始，每回合 +1。
 *
 * 返回 null = 成功，否则是给玩家看的理由。文案按"还差什么"说，
 * 不按"你没满足哪个条件"说——玩家关心的是还要等几回合。
 */
export function startFueling(s: GameState, silo: Unit): string | null {
  const st = siloStateOf(silo);
  if (st.fuel >= SILO_FUEL_TURNS) return '燃料已经加满了，直接发射就行';
  if (st.fueling) return `已经在加注了（${st.fuel} / ${SILO_FUEL_TURNS}）`;
  writeSilo(silo, { fuel: st.fuel, fueling: true });
  /*
   * 一点火加注就点亮：烟柱从这一刻开始冒。
   *
   * 只在回合开始刷新是不够的——玩家可能在本回合中途才点「加注」，
   * 那一次 `tickSilos` 已经过去了，对手这一回合就看不见它。
   */
  markSpotlight(s, silo);
  const left = SILO_FUEL_TURNS - st.fuel;
  log(s, silo.owner, `${s.unitTypes[silo.type]?.name ?? '发射井'}开始加注燃料，还要 ${left} 回合`, true);
  return null;
}

/**
 * 从这座井能飞出去哪条航道。
 *
 * 发射井**不知道目的地是月球**——它只知道自己站在星图的哪个节点上，
 * 然后问这个节点有哪些可用航道。基础包只有"地球→月球"一条，取第一条；
 * 等 P1 有多条航道，这里换成"玩家选的那一条"就行，发射井本身不用改。
 */
function outboundLane(
  s: GameState,
  silo: Unit,
): { laneId: string; to: StarNodeId; turns: number } | null {
  const here = nodeOf(s, silo);
  if (!here) return null;
  const out = lanesFrom(s, here.id)[0];
  if (!out) return null;
  // 面板上要写"我这边的火箭要几回合"，所以按自己（发射方）的速度算
  return { laneId: out.lane.id, to: out.to, turns: laneTurnsFor(s, silo.owner, out.lane) };
}

/** 发射前的检查。和发射本身分开：面板要用同一句话告诉玩家"还差什么" */
export function launchProblem(s: GameState, silo: Unit): string | null {
  const st = siloStateOf(silo);
  if (st.fuel < SILO_FUEL_TURNS) {
    return st.fueling
      ? `燃料还在加注（${st.fuel} / ${SILO_FUEL_TURNS}）`
      : `燃料没加满（${st.fuel} / ${SILO_FUEL_TURNS}），先点「加注燃料」`;
  }
  const cargo = silo.cargo ?? [];
  if (cargo.length === 0) return '货舱是空的：先让一个单位登舱（面板上的「装载」）';
  const out = outboundLane(s, silo);
  if (!out) return '这里没有可用的航道';
  // 注意这里是 nodeById（节点 id），不是 nodeOfBoard（棋盘 id）——两者差一层
  const destBoard = nodeById(s, out.to)?.board;
  if (!destBoard) return '航道那一头还没有能落脚的地方';
  if (!landingSpotOn(s, destBoard)) return `${nodeName(s, out.to)}上已经没有落脚的地方了`;
  return null;
}

/**
 * 点火：把货舱里的单位送进航道。
 *
 * 三个细节：
 *   · **单位立刻移出 `s.units`**（进 `transit.cargo`）：留在棋盘上会被回合重置、
 *     被迷雾裁、被战斗误伤，还会在两张图上同时出现；
 *   · 燃料清零：想再飞一趟就重新加注，3 回合的窗口再来一次；
 *   · 单位**保留原来的 id 和全部自定义字段**（境界、弹药、装备都在里头），
 *     换的只有 `board` 和坐标——到达时才写。
 */
export function launchIntoLane(s: GameState, silo: Unit): string | null {
  const problem = launchProblem(s, silo);
  if (problem) return problem;

  const out = outboundLane(s, silo)!;
  const cargo = silo.cargo ?? [];
  const t = enterLane(s, { owner: silo.owner, laneId: out.laneId, to: out.to, cargo });
  if (!t) return '这条航道走不了';

  silo.cargo = [];
  writeSilo(silo, { fuel: 0, fueling: false });
  const names = cargo.map((u) => s.unitTypes[u.type]?.name ?? u.type).join('、');
  log(
    s,
    silo.owner,
    `${names} 乘火箭升空，飞向${nodeName(s, out.to)}（${t.left} 回合后到达）`,
    // 火箭升空是瞒不住的，而且对手看着它飞过去才知道该在哪儿堵
    true,
  );
  // 燃料清了、火箭走了：井不再冒烟，这一盏点亮到此为止
  clearSpotlight(silo);
  return null;
}

/**
 * 回合开始：给所有正在加注的发射井 +1。
 *
 * 只推进**这一方自己的**井：加注是"我方后勤"，对手的回合不该替我加油。
 */
/**
 * 新盖好的井喊一嗓子：**只喊一次**，点亮一整个敌方回合。
 *
 * 两个时机都要调（回合开始 + 回合结束）：井可能在对方回合里被你自己的施工队
 * 补完，也可能在本回合刚立起来；只在回合开始喊，会漏掉"本回合刚建好"的那一座，
 * 于是对手整回合都看不见它。
 *
 * 判"建好"用 `buildNeed` 有没有被删掉（施工完成时核心会删），
 * 再用 `announced` 保证不重复——读存档、重开都不会反复点亮。
 */
export function announceBuiltSilos(s: GameState, player: PlayerId): void {
  for (const u of s.units) {
    if (u.owner !== player || !isSilo(s, u)) continue;
    if (underConstruction(u)) continue;
    if (u.custom?.announced === true) continue;
    u.custom = { ...(u.custom ?? {}), announced: true };
    markSpotlight(s, u);
    log(
      s,
      player,
      `${s.unitTypes[u.type]?.name ?? '发射井'}立起来了——这么大的东西，隔着半个战场也看得见`,
      true,
    );
  }
}

export function tickSilos(s: GameState, player: PlayerId): void {
  announceBuiltSilos(s, player);

  for (const u of s.units) {
    if (u.owner !== player || !isSilo(s, u)) continue;
    const st = siloStateOf(u);

    /*
     * 「加注期间」每回合重新标记一次：清灯发生在对方回合结束时，
     * 不 refresh 的话只有第一回合亮。烟柱一直冒，所以一直看得见。
     * 不加注的旧井**不亮**——"建好先放着"因此是一种真实的欺骗。
     */
    if (!underConstruction(u) && st.fueling) markSpotlight(s, u);

    if (!st.fueling) continue;
    const fuel = Math.min(SILO_FUEL_TURNS, st.fuel + 1);
    writeSilo(u, { fuel, fueling: fuel < SILO_FUEL_TURNS });
    const siloName = s.unitTypes[u.type]?.name ?? '发射井';
    if (fuel >= SILO_FUEL_TURNS) {
      log(s, player, `${siloName}的燃料加满了（${SILO_FUEL_TURNS} / ${SILO_FUEL_TURNS}），随时可以点火`, true);
    } else {
      /*
       * 加注进度**公开**：对手必须能读到"他还差几回合就飞"。
       * 这是火箭奇袭唯一的预警，比在顶栏加一个倒计时更省事：
       * 战报本来就两边都能翻，也不会多占一块界面。
       */
      log(s, player, `${siloName}正在加注燃料（${fuel} / ${SILO_FUEL_TURNS}）`, true);
    }
  }
}

/**
 * 面板上的几行字。
 *
 * 只报"燃料 / 货舱 / 着陆点"三件事——它们正好是玩家做决定需要的全部信息，
 * 多一行就是在挤占属性卡的位置。
 *
 * **对手看到的少一半**，这条是故意的：
 *   · 燃料进度**公开**——那正是"3 回合窗口"存在的意义，对面要能看见你在加注，
 *     才谈得上决定"现在来拆还是先攒兵"；
 *   · 装了谁**不公开**——那是你的底牌（和丹药一个口径：看得到 buff、数不出兜里几颗）。
 *     对面只知道"装了一个人"，不知道是剑修还是建筑队，也就没法提前安排克制。
 *   · 落点只给自己的玩家看：它永远是"目的地中心附近"的规则，对手要堵可以自己算，
 *     不该占它的面板。
 */
export function siloLines(s: GameState, u: Unit, viewer?: PlayerId): string[] {
  if (!isSilo(s, u)) return [];
  const mine = viewer === undefined || viewer === u.owner;
  const out: string[] = [];
  const st = siloStateOf(u);
  if (st.fuel >= SILO_FUEL_TURNS) {
    out.push(`燃料已满（${SILO_FUEL_TURNS} / ${SILO_FUEL_TURNS}）`);
  } else if (st.fueling) {
    out.push(`加注中：${st.fuel} / ${SILO_FUEL_TURNS}（每回合 +1）`);
  } else {
    out.push(`燃料 ${st.fuel} / ${SILO_FUEL_TURNS}（还没开始加注）`);
  }

  const cargo = u.cargo ?? [];
  if (!mine) {
    out.push(cargo.length === 0 ? '货舱：空' : '货舱：已装载（看不出装的是谁）');
    return out;
  }
  out.push(
    cargo.length === 0
      ? '货舱：空（贴着井点「装载」，接一个地面单位上来）'
      : `货舱：${cargo.map((c) => s.unitTypes[c.type]?.name ?? c.type).join('、')}`,
  );

  const dest = outboundLane(s, u);
  if (!dest) {
    out.push('这里没有可用的航道，发射井飞不出去');
  } else {
    const board = nodeById(s, dest.to)?.board;
    const spot = board ? landingSpotOn(s, board) : null;
    if (st.fuel >= SILO_FUEL_TURNS && cargo.length > 0) {
      out.push(`目的地：${nodeName(s, dest.to)}（航程 ${dest.turns} 回合）`);
      if (spot) out.push(`落点：${cellName(spot.x, spot.y)}（离中心最近的一块空地）`);
    } else {
      out.push(`可飞的航道：→ ${nodeName(s, dest.to)}（${dest.turns} 回合）`);
    }
  }
  return out;
}
