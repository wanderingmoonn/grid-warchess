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
 *   2. **发射**：把货舱里那一个单位放到月球图中心附近；
 *   3. **写面板文案**：燃料几格、还差什么才能飞。
 *
 * ── 为什么不引入"燃料"资源 ────────────────────────────────────────────
 *
 * 加注是**计时器**不是资源：它不参与经济、AI 不用学、规则书不用加一节，
 * 但它给了对手一个看得见的窗口——顶栏和面板上写着"2 / 3"，
 * 对面看见你在加注，还有一回合时间来拆井或者堵着陆点。
 * 这是整条链上唯一"能被反制"的环节，比多一种货币重要。
 */

import type { GameState, PlayerId, Unit, UnitTypeDef } from '../types.ts';
import { boardIdOf, boardOf } from '../board.ts';
import { tilesOfUnit } from '../query.ts';
import { passable } from '../config.ts';

/** 建筑 id。写进存档，改它等于让老存档里的发射井变成一块石头 */
export const SILO_ID = 'rocket_silo';

/** 加注满要几回合（每回合 +1） */
export const SILO_FUEL_TURNS = 3;

/** 月球图的 id（`space-age` 在开局建的那一张） */
export const MOON_BOARD = 'moon';

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

/** 这一格能不能落人：地形过得去、也没人占着（按 2×2 的占地算） */
function freeLandingSpot(s: GameState, x: number, y: number): boolean {
  const moon = boardOf(s, MOON_BOARD);
  const tile = moon.tiles[y * moon.w + x];
  if (!tile || !passable(tile.terrain)) return false;
  for (const u of s.units) {
    if (boardIdOf(u) !== MOON_BOARD) continue;
    for (const t of tilesOfUnit(s, u)) {
      if (t.x === x && t.y === y) return false;
    }
  }
  return true;
}

/**
 * 月面着陆点：**离中心最近的空地**。
 *
 * 取中心而不是随机，是因为"落在哪"这件事玩家必须能预判——他要绕着它
 * 排兵、要堵对面的着陆点。随机落点会让每一次发射都变成开盲盒。
 *
 * 环形山也能落（它只是贵一步），只要地形过得去；被占的格让开，
 * 于是第二艘船会自己往外挪一圈。
 */
export function moonLandingTile(s: GameState): { x: number; y: number } | null {
  const moon = s.boards?.[MOON_BOARD];
  if (!moon) return null;
  const cx = (moon.w - 1) / 2;
  const cy = (moon.h - 1) / 2;
  let best: { x: number; y: number; d: number } | null = null;
  for (let y = 0; y < moon.h; y++) {
    for (let x = 0; x < moon.w; x++) {
      if (!freeLandingSpot(s, x, y)) continue;
      const d = Math.abs(x - cx) + Math.abs(y - cy);
      if (!best || d < best.d) best = { x, y, d };
    }
  }
  return best ? { x: best.x, y: best.y } : null;
}

/** 面板上的一格坐标写法（A1） */
function cellName(x: number, y: number): string {
  return `${String.fromCharCode(65 + x)}${y + 1}`;
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
  const left = SILO_FUEL_TURNS - st.fuel;
  log(s, silo.owner, `${s.unitTypes[silo.type]?.name ?? '发射井'}开始加注燃料，还要 ${left} 回合`);
  return null;
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
  if (!s.boards?.[MOON_BOARD]) return '这一局没有月球图';
  if (!moonLandingTile(s)) return '月面上已经没有落脚的地方了';
  return null;
}

/**
 * 点火：把货舱里那一个单位放到月面着陆点。
 *
 * 三个细节：
 *   · 落地的单位**当回合不能再动**（`moved` / `acted` 都置真）——
 *     否则"发射 + 立刻行动"等于白送一个回合，而且它脚下的图才刚出现；
 *   · 燃料清零：想再飞一趟就重新加注，3 回合的窗口再来一次；
 *   · 单位**保留原来的 id 和全部自定义字段**（境界、弹药、装备都在里头），
 *     换的只有 `board` 和坐标。
 */
export function launchToMoon(s: GameState, silo: Unit): string | null {
  const problem = launchProblem(s, silo);
  if (problem) return problem;

  const pax = (silo.cargo ?? [])[0]!;
  const spot = moonLandingTile(s)!;
  const name = s.unitTypes[pax.type]?.name ?? pax.type;

  silo.cargo = [];
  writeSilo(silo, { fuel: 0, fueling: false });
  s.units.push({
    ...pax,
    board: MOON_BOARD,
    x: spot.x,
    y: spot.y,
    moved: true,
    acted: true,
  });
  log(
    s,
    silo.owner,
    `${name} 乘火箭抵达月球（${cellName(spot.x, spot.y)}）`,
    // 火箭升空是瞒不住的，而且对手看着它飞过去才知道该在哪儿堵
    true,
  );
  return null;
}

/**
 * 回合开始：给所有正在加注的发射井 +1。
 *
 * 只推进**这一方自己的**井：加注是"我方后勤"，对手的回合不该替我加油。
 */
export function tickSilos(s: GameState, player: PlayerId): void {
  for (const u of s.units) {
    if (u.owner !== player || !isSilo(s, u)) continue;
    const st = siloStateOf(u);
    if (!st.fueling) continue;
    const fuel = Math.min(SILO_FUEL_TURNS, st.fuel + 1);
    writeSilo(u, { fuel, fueling: fuel < SILO_FUEL_TURNS });
    if (fuel >= SILO_FUEL_TURNS) {
      log(s, player, `${s.unitTypes[u.type]?.name ?? '发射井'}的燃料加满了（${SILO_FUEL_TURNS} / ${SILO_FUEL_TURNS}）`, true);
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
 *   · 着陆点只给自己的玩家看：它一直是月球中心附近，是常识，不该占对手的面板。
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

  const spot = moonLandingTile(s);
  if (!spot) {
    out.push('这一局没有月球图，发射井飞不了');
  } else if (st.fuel >= SILO_FUEL_TURNS && cargo.length > 0) {
    out.push(`月面着陆点：${cellName(spot.x, spot.y)}（离月球中心最近的一块空地）`);
  }
  return out;
}
