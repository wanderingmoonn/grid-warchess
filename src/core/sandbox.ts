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

import { CITY, CONFIG, ERAS, eraDef } from './config.ts';
import { canStandAt, cityAt } from './rules.ts';
import type { City, GameState, PlayerId, Unit } from './types.ts';

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
    const why = def.domain === 'water' ? '船只能停在水上或桥面上' : '这一格站不住（水、山，或者已经有人了）';
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
  const size = CITY.size;
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

  const size = CITY.size;
  const lv = Math.max(1, Math.min(ERAS.length, Math.round(era)));
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

/** 把一方摆上去的兵全部撤走（城留着——城是靶子，不是"部队"） */
export function clearUnits(s: GameState, owner: PlayerId): SandboxResult {
  const next = clone(s);
  const before = next.units.length;
  next.units = next.units.filter((u) => u.owner !== owner);
  if (next.units.length === before) return { ok: false, reason: '这一方本来就没有兵' };
  return { ok: true, state: next };
}
