/**
 * 沙盒：上帝模式的落子操作。
 *
 * 为什么不走 applyAction：那些动作是"规则允许玩家做的事"，每一步都要过
 * 回合、金币、产线、编制四道门。而这里要的恰恰是**绕过门**——凭空摆一个
 * 坦克、凭空立一座城、把碍事的东西擦掉。它不是规则内的一个动作，
 * 它是规则的出入口，所以单独一层纯函数。
 *
 * 但"摆得合不合理"仍然借 rules 的判断（canStandAt 那一条）：
 * 船摆到山顶上、两个单位叠在同一层，之后每一次寻路和每一发攻击
 * 都要跟这个局面较劲。沙盒可以不要钱，不能不要"这是个合法局面"。
 *
 * 一律"克隆再改"：调用方失败时要能整块丢掉，不留半截状态。
 */

import { CONFIG, eraDef } from './config.ts';
import { activeExpansions, eraCeilingOf } from './expansions.ts';
import { canStandAt, cityAt, citySizeOf, coversTile } from './rules.ts';
import { footprintOf, tilesOfUnit } from './query.ts';
import type { City, GameState, PlayerId, Terrain, Unit } from './types.ts';

export type SandboxResult = { ok: true; state: GameState } | { ok: false; reason: string };

const clone = (s: GameState): GameState => structuredClone(s);

/** 摆一个单位。金币、产线、编制、城市等级一概不看，只看"这格站不站得住"。 */
export function placeUnit(
  s: GameState,
  owner: PlayerId,
  type: string,
  x: number,
  y: number,
): SandboxResult {
  const def = s.unitTypes[type];
  if (!def) return { ok: false, reason: '这一局里没有这个兵种' };
  if (x < 0 || y < 0 || x >= s.w || y >= s.h) return { ok: false, reason: '点到棋盘外面了' };

  // 对方的城里不放兵。
  //
  // 不是不允许（canStandAt 根本不管城归谁），而是故意堵住：在敌人的城里
  // 摆一个兵，会产生一个规则层从没设计过的局面——城既没被攻陷也没被包围，
  // 却站着敌方部队，"占城"那套判定永远不会触发。想打城就在城外面摆兵。
  const city = cityAt(s, x, y);
  if (city && city.owner !== owner) {
    return { ok: false, reason: `这是${s.players[city.owner].name}的城，兵摆不进去` };
  }

  const tile = s.tiles[y * s.w + x];
  if (!tile) return { ok: false, reason: '点到棋盘外面了' };

  // 建筑走建造那一套地形规则（buildOn），不是走位那一套。
  //
  // 两者的差别就在桥上：桥的 buildOn 是 ['water']，而 canStandAt 会以
  // "陆军不能站水里"把它挡掉——用 canStandAt 判建筑，结果就是沙盒里
  // 一座桥都架不起来，而桥恰恰是最想摆上来试的东西之一。
  if (def.buildOn) {
    if (!def.buildOn.includes(tile.terrain)) {
      const names = def.buildOn.map((t) => CONFIG.terrainName[t]).join('、');
      return { ok: false, reason: `${def.name} 只能建在${names}上` };
    }
    if (s.units.some((u) => u.x === x && u.y === y)) {
      return { ok: false, reason: '这一格已经站着东西了' };
    }
  } else if (!canStandAt(s, x, y, type)) {
    const why = def.domain === 'water' ? '船只能停在水上、桥面或浅滩上' : '这一格站不住（水、山，或者已经有人了）';
    return { ok: false, reason: `${def.name}：${why}` };
  }

  const next = clone(s);
  const unit: Unit = {
    id: `u${next.nextUnitSeq++}`,
    type,
    owner,
    x,
    y,
    hp: def.maxHp,
    kills: 0,
    // 摆上场就能动、能打：沙盒里没有"刚造出来要等一回合"这回事，
    // 玩家摆完点「交给 AI」就是要立刻看到它参战。
    moved: false,
    acted: false,
    ...(typeof def.ammo === 'number' ? { ammoLeft: def.ammo } : {}),
  };
  next.units.push(unit);
  return { ok: true, state: next };
}

/** 城的 id 是 c1、c2……这里取"下一个没用过的号"，别跟建城时撞上 */
function nextCityId(s: GameState): string {
  let n = 1;
  for (const c of s.cities) {
    const m = /^c(\d+)$/.exec(c.id);
    if (m?.[1]) n = Math.max(n, Number(m[1]) + 1);
  }
  return `c${n}`;
}

/**
 * 这块 2×2 能不能盖城：不能的话返回原因，能就返回 null。
 *
 * 抽出来是因为界面要**先把能放的位置点亮**（2×2 的角在哪儿是有讲究的，
 * 光靠点错再弹提示得试十几次）。点亮和真盖必须共用一份判断，
 * 否则会出现"橙格亮着，点下去说不合法"。
 */
export function sandboxCityProblem(s: GameState, left: number, top: number): string | null {
  const size = citySizeOf(s);
  if (left < 0 || top < 0 || left + size > s.w || top + size > s.h) {
    return `城要占 ${size}×${size} 格，这个角放不下`;
  }

  for (let dy = 0; dy < size; dy++) {
    for (let dx = 0; dx < size; dx++) {
      const tile = s.tiles[(top + dy) * s.w + (left + dx)];
      if (!tile) continue;
      if (tile.cityId) return '这里有城了，城不能叠着盖';
      if (tile.terrain === 'water') return '城不能盖在水上';
      if (tile.terrain === 'mountain') return '城不能盖在高山上';
    }
  }

  const blocked = s.units.find(
    (u) => u.x >= left && u.x < left + size && u.y >= top && u.y < top + size,
  );
  if (blocked) return '城底下还站着一个单位，先把它擦掉';

  return null;
}

/**
 * 盖一座城。left/top 是 2×2 的左上角（和建城时一个意思）。
 *
 * 压在水上、山上、别的城上、还有单位站着的格子上都不行：
 * 城会把这四格地形改成 city，被压在底下的东西既不会被"顶出来"，
 * 也不会被"收进城"，只会变成一个谁都解释不清的局面。
 */
export function placeCity(
  s: GameState,
  owner: PlayerId,
  left: number,
  top: number,
  era: number,
): SandboxResult {
  const problem = sandboxCityProblem(s, left, top);
  if (problem) return { ok: false, reason: problem };

  const size = citySizeOf(s);
  // 上帝模式也不许造出一座"这一局根本升不到"的城：那种城没有兵种可造，
  // 面板上时代是 6、兵表里却一件六代装备都没有——看着像 bug，其实就是。
  const lv = Math.max(1, Math.min(eraCeilingOf(s), Math.round(era)));
  const info = eraDef(lv);
  const next = clone(s);
  const id = nextCityId(next);
  const city: City = {
    id,
    x: left,
    y: top,
    size,
    owner,
    era: lv,
    hp: info.cityMaxHp,
    maxHp: info.cityMaxHp,
    armor: info.cityArmor,
  };
  next.cities.push(city);
  for (let dy = 0; dy < size; dy++) {
    for (let dx = 0; dx < size; dx++) {
      const tile = next.tiles[(top + dy) * next.w + (left + dx)];
      if (!tile) continue;
      tile.terrain = 'city';
      tile.cityId = id;
    }
  }
  return { ok: true, state: next };
}

/**
 * 擦掉一格上的东西：先擦单位，擦空了再擦城。
 *
 * 顺序是有意的：单位能叠（飞行压在地面单位头上），擦的时候永远先擦最上面
 * 那个——手上是橡皮，看到的就该是"最上面那一层先没"。城被擦掉之后那四格
 * 退回平原：沙盒里没有"废墟"这个概念，留一片不能站人的瓦砾只会碍事。
 */
export function removeAt(s: GameState, x: number, y: number): SandboxResult {
  if (x < 0 || y < 0 || x >= s.w || y >= s.h) return { ok: false, reason: '点到棋盘外面了' };
  const next = clone(s);

  const here = next.units.filter((u) => u.x === x && u.y === y);
  if (here.length > 0) {
    const victim = here[here.length - 1]!;
    next.units = next.units.filter((u) => u.id !== victim.id);
    return { ok: true, state: next };
  }

  const tile = next.tiles[y * next.w + x];
  const city = tile?.cityId ? next.cities.find((c) => c.id === tile.cityId) : null;
  if (city) {
    next.cities = next.cities.filter((c) => c.id !== city.id);
    for (const t of next.tiles) {
      if (t.cityId !== city.id) continue;
      t.cityId = null;
      t.terrain = 'plain';
    }
    return { ok: true, state: next };
  }

  return { ok: false, reason: '这一格上没有东西' };
}


/* ── 框选与批量操作（2026-11-10） ────────────────────────────────────────
 *
 * 上帝模式以前只有"一笔一笔地摆/擦"。摆一场三十个单位的歼灭战要点三十下，
 * 想清掉半个棋盘得一个一个擦——这不是"绕过规则"，这就是"手酸"。
 *
 * 这一组是**纯函数**：给一个矩形，返回新状态和"做了几件、跳过几件"。
 * 界面那边只负责"选区怎么来、结果怎么说"，一行规则都不写死在里面。
 *
 * 三个共同的取舍：
 *   · 只认**格坐标**，不认屏幕：矩形在 main.ts 里由两次 pointer 点算出来；
 *   · 一律"克隆再改"，失败整块丢掉，不留半截状态（和上面那些单点操作一致）；
 *   · 批量操作**能跳过的就跳过、并报数**，不因为一格不合格就把整批撤掉——
 *     "刷一片地形"里有座城很正常，为它让整个操作失败是帮倒忙。
 */

/** 矩形选区：含两个端点，字段已归一（x0 ≤ x1） */
export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** 两次点击之间的矩形，顺序随便给（斜着拖是常态） */
export function rectOf(a: { x: number; y: number }, b: { x: number; y: number }, w: number, h: number): Rect {
  const x0 = Math.max(0, Math.min(a.x, b.x));
  const y0 = Math.max(0, Math.min(a.y, b.y));
  const x1 = Math.min(w - 1, Math.max(a.x, b.x));
  const y1 = Math.min(h - 1, Math.max(a.y, b.y));
  return { x0, y0, x1, y1 };
}

export function rectW(r: Rect): number {
  return r.x1 - r.x0 + 1;
}

export function rectH(r: Rect): number {
  return r.y1 - r.y0 + 1;
}

/** 选区里的单位：**按覆盖格算**，2×2 的建筑只要压到一格就算选中 */
export function unitsInRect(s: GameState, r: Rect): Unit[] {
  return s.units.filter((u) => {
    for (let y = r.y0; y <= r.y1; y += 1) {
      for (let x = r.x0; x <= r.x1; x += 1) if (coversTile(s, u, x, y)) return true;
    }
    return false;
  });
}

/** 批量删兵。城留着——"删兵"和"拆城"是两件事，别一个按钮干两件 */
export function deleteUnitsInRect(
  s: GameState,
  r: Rect,
): { ok: true; state: GameState; removed: number } | { ok: false; reason: string } {
  const doomed = unitsInRect(s, r);
  if (doomed.length === 0) return { ok: false, reason: '选区里没有单位' };
  const ids = new Set(doomed.map((u) => u.id));
  const next = clone(s);
  next.units = next.units.filter((u) => !ids.has(u.id));
  return { ok: true, state: next, removed: doomed.length };
}

/** 批量刷地形：城格和有兵站着的格跳过，报数给界面 */
export function paintRect(
  s: GameState,
  r: Rect,
  terrain: Terrain,
): { ok: true; state: GameState; painted: number; skipped: number } | { ok: false; reason: string } {
  if (!paintTerrainsFor(s).includes(terrain)) return { ok: false, reason: '这种地形不能直接刷' };
  const next = clone(s);
  let painted = 0;
  let skipped = 0;
  for (let y = r.y0; y <= r.y1; y += 1) {
    for (let x = r.x0; x <= r.x1; x += 1) {
      const t = next.tiles[y * next.w + x];
      if (!t) {
        skipped += 1;
        continue;
      }
      if (t.cityId || next.units.some((u) => coversTile(next, u, x, y))) {
        skipped += 1;
        continue;
      }
      if (t.terrain === terrain) {
        skipped += 1;
        continue;
      }
      t.terrain = terrain;
      painted += 1;
    }
  }
  if (painted === 0) return { ok: false, reason: '选区里没有能改的格子（城和兵都站在上面？）' };
  return { ok: true, state: next, painted, skipped };
}

/**
 * 批量放兵：**只填空格**，每格一个。
 *
 * `cap` 是安全阀：9×9 的选区一口气放 81 个兵，局就跑不动了（AI 每帧都要遍历）。
 * 到顶就停手并把 `capped` 报给界面，让人知道"没放完"而不是以为选区别名。
 */
export function fillUnitsInRect(
  s: GameState,
  r: Rect,
  owner: PlayerId,
  type: string,
  cap = 120,
): { ok: true; state: GameState; placed: number; skipped: number; capped: boolean } | { ok: false; reason: string } {
  const def = s.unitTypes[type];
  if (!def) return { ok: false, reason: '这一局里没有这个兵种' };
  const next = clone(s);
  let placed = 0;
  let skipped = 0;
  for (let y = r.y0; y <= r.y1; y += 1) {
    for (let x = r.x0; x <= r.x1; x += 1) {
      if (placed >= cap) return { ok: true, state: next, placed, skipped, capped: true };
      if (!canStandAt(next, x, y, type)) {
        skipped += 1;
        continue;
      }
      next.units.push({
        id: `u${next.nextUnitSeq++}`,
        type,
        owner,
        x,
        y,
        hp: def.maxHp,
        kills: 0,
        moved: true,
        acted: true,
        bornTurn: next.turn,
        ...(typeof def.ammo === 'number' ? { ammoLeft: def.ammo } : {}),
      });
      placed += 1;
    }
  }
  if (placed === 0) return { ok: false, reason: '选区里没有能站下它的空格' };
  return { ok: true, state: next, placed, skipped, capped: false };
}

/**
 * 整体平移选区内所有单位（含 2×2 的建筑）。
 *
 * **要么全动、要么全不动**：只要有一个会被推到棋盘外、或者落点站不下，
 * 整笔就拒绝。半截平移比不动糟得多——兵散了一半、队形全乱，而玩家是按
 * "整体挪一格"去想的。
 *
 * 判落点前先把自己这一批从盘上摘掉：否则"整个方阵往前一步"里，
 * 每个人都会撞到前面的自己人。
 */
export function translateUnitsInRect(
  s: GameState,
  r: Rect,
  dx: number,
  dy: number,
): { ok: true; state: GameState; moved: number } | { ok: false; reason: string } {
  const movers = unitsInRect(s, r);
  if (movers.length === 0) return { ok: false, reason: '选区里没有单位' };
  const ids = new Set(movers.map((u) => u.id));
  const next = clone(s);
  next.units = next.units.filter((u) => !ids.has(u.id));

  // 已经占住的格（没在移动的那批人）
  const taken = new Set<number>();
  for (const u of next.units) for (const t of tilesOfUnit(next, u)) taken.add(t.y * next.w + t.x);

  const movedUnits: Unit[] = [];
  for (const u of movers) {
    const nx = u.x + dx;
    const ny = u.y + dy;
    const n = footprintOf(next, u);
    if (nx < 0 || ny < 0 || nx + n > next.w || ny + n > next.h) {
      return { ok: false, reason: '有单位会被推到棋盘外面' };
    }
    for (const t of tilesOfUnit(next, { ...u, x: nx, y: ny })) {
      const i = t.y * next.w + t.x;
      if (taken.has(i)) return { ok: false, reason: `(${t.x},${t.y}) 已经有人站着了` };
      taken.add(i);
    }
    // 地形/层级合法性交给 canStandAt；它看的是"这一格能不能站这个兵"
    if (!canStandAt(next, nx, ny, u.type)) {
      return { ok: false, reason: `(${nx},${ny}) 这个兵站不上去` };
    }
    movedUnits.push({ ...u, x: nx, y: ny });
  }
  next.units.push(...movedUnits);
  return { ok: true, state: next, moved: movedUnits.length };
}

/** 把一方摆上去的兵全部撤走（城留着——城是靶子，不是"部队"） */
export function clearUnits(s: GameState, owner: PlayerId): SandboxResult {
  const next = clone(s);
  const before = next.units.length;
  next.units = next.units.filter((u) => u.owner !== owner);
  if (next.units.length === before) return { ok: false, reason: '这一方本来就没有兵' };
  return { ok: true, state: next };
}

/**
 * 能直接刷的地形（本体部分）。
 *
 * 没有 `city`：城格的地形是城市的附属品，直接刷成别的会让
 * "这座城的四格"里出现一格平原——城市的出兵位、回血判定、攻城判定
 * 全按 cityId 走，地形对不上只会得到一个自相矛盾的局面。
 * 想改那儿的地形，先拿橡皮把城擦掉（擦完那几格会退回平原）。
 *
 * 扩展新引入的地形**不在这里**：它们跟着扩展开关走，见 paintTerrainsFor。
 */
export const PAINT_TERRAINS: readonly Terrain[] = [
  'plain',
  'forest',
  'hill',
  'water',
  'mountain',
  'bridge',
];

/**
 * 这一局上帝模式能刷的地形：本体六种 + 已启用扩展新引入的地形。
 *
 * 为什么要问扩展而不是直接列全：没开「地形高差」的局里刷一块台地，
 * 得到的是一格"规则不认识、也不知道多高"的地形——玩家摆出来的是个空壳。
 * 画笔该跟规则同一份名单。
 */
export function paintTerrainsFor(s: GameState): readonly Terrain[] {
  const out: Terrain[] = [...PAINT_TERRAINS];
  for (const e of activeExpansions(s)) {
    for (const t of e.terrains ?? []) if (!out.includes(t)) out.push(t);
  }
  return out;
}

/**
 * 刷一格地形。
 *
 * 上帝模式最缺的其实是这个：想试"守住这个山口"，得先有个山口。
 * 以前只能摆兵摆城，地形是生成器给的，改不了——于是"渡河""过山"这类
 * 局面根本摆不出来，只能碰运气等一张合适的地图。
 *
 * 两条硬限制：城格不许刷（理由见 PAINT_TERRAINS），站东西的格不许刷。
 * 后者不是懒——一块地形改完，上面那个人可能就站在水里或者山心里了，
 * 那是规则层从没设计过的局面（寻路、攻击判定、迷雾全都要跟它较劲）。
 * 想在那儿挖河，先把人擦掉，刷完再摆回去。
 */
export function paintTerrain(
  s: GameState,
  x: number,
  y: number,
  terrain: Terrain,
): SandboxResult {
  if (!paintTerrainsFor(s).includes(terrain)) {
    return { ok: false, reason: '这种地形不能直接刷' };
  }
  if (x < 0 || y < 0 || x >= s.w || y >= s.h) return { ok: false, reason: '点到棋盘外面了' };

  const tile = s.tiles[y * s.w + x];
  if (!tile) return { ok: false, reason: '点到棋盘外面了' };
  if (tile.cityId) return { ok: false, reason: '城格归城市管，先把这座城擦掉再改地形' };

  const blocker = s.units.find((u) => coversTile(s, u, x, y));
  if (blocker) {
    const def = s.unitTypes[blocker.type];
    return { ok: false, reason: `${def?.name ?? '单位'}站在这一格上，先擦掉再改地形` };
  }

  if (tile.terrain === terrain) {
    return { ok: false, reason: `这一格已经是${CONFIG.terrainName[terrain]}了` };
  }

  const next = clone(s);
  const t = next.tiles[y * next.w + x];
  if (t) t.terrain = terrain;
  return { ok: true, state: next };
}
