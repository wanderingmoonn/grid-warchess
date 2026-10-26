/**
 * 规则引擎。整个游戏的唯一真相来源。
 *
 * 铁律：
 *   1. 这个文件里不许出现 document、window、fetch、Date.now、Math.random。
 *   2. 每个函数要么是纯查询，要么返回一份新的 state，绝不原地修改。
 *   3. 任何非法操作都必须返回明确的失败原因，而不是抛异常或静默忽略。
 *
 * 扩展规则通过 expansions.ts 的钩子挂进来，本文件不认识任何具体扩展，
 * 只知道"在这些时机问一下所有启用的扩展"。
 */

import { hasAbility } from './abilities.ts';
import { CHEAPEST_COST, CITY, CONFIG, ORDER_UPGRADE, eraDef, nextUpgradeCost, passable } from './config.ts';
import { activeExpansions } from './expansions.ts';
import type {
  ActionResult,
  Action,
  City,
  GameState,
  PlayerId,
  Tile,
  Unit,
  UnitTypeDef,
} from './types.ts';

/** 四方向移动。不用八方向是为了让移动力有真实取舍，斜穿会削弱地形作用。 */
const DIRS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

/**
 * 这一格是不是临水。
 *
 * 桥面也算"临水"：桥底下就是河，军营扎在桥头是有水可用的。
 * 做成对外导出的判断，是因为它不只是一条合法性检查——
 * 地图生成、AI 选址、界面高亮都要用同一套口径，各写一份必然走偏。
 */
export function adjacentToWater(s: GameState, x: number, y: number): boolean {
  return DIRS.some(([dx, dy]) => {
    const t = tileAt(s, x + dx, y + dy);
    return !!t && (t.terrain === 'water' || t.terrain === 'bridge');
  });
}

export function other(p: PlayerId): PlayerId {
  return p === 'A' ? 'B' : 'A';
}

/** 从本局的兵种表里取定义（不是全局表，因为对局可能只启用了部分兵种） */
export function utype(s: GameState, id: string): UnitTypeDef {
  const def = s.unitTypes[id];
  if (!def) throw new Error(`本局没有兵种: ${id}`);
  return def;
}

export function idx(s: GameState, x: number, y: number): number {
  return y * s.w + x;
}

export function inBounds(s: GameState, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < s.w && y < s.h;
}

export function xyOf(s: GameState, i: number): { x: number; y: number } {
  return { x: i % s.w, y: Math.floor(i / s.w) };
}

export function tileAt(s: GameState, x: number, y: number): Tile | null {
  if (!inBounds(s, x, y)) return null;
  return s.tiles[idx(s, x, y)] ?? null;
}

/**
 * 这一格上的单位。
 *
 * 同一格可能同时站着"建筑"和"站在建筑上的部队"（目前只有桥面允许这样）。
 * 优先返回**不是建筑**的那个：否则站在桥上的兵会被桥自己挡住——
 * 移动判定会说"那格已经有人了"，玩家看到的是一个明明站着自己的兵却动不了的格子。
 */
export function unitAt(s: GameState, x: number, y: number): Unit | undefined {
  let building: Unit | undefined;
  for (const u of s.units) {
    if (u.x !== x || u.y !== y) continue;
    const cat = s.unitTypes[u.type]?.category;
    if (cat === 'building') {
      building ??= u;
      continue;
    }
    return u;
  }
  return building;
}

/** 这一格上的建筑（桥、塔、墙……）；没有就是 undefined */
export function buildingAt(s: GameState, x: number, y: number): Unit | undefined {
  return s.units.find((u) => u.x === x && u.y === y && s.unitTypes[u.type]?.category === 'building');
}

export function unitById(s: GameState, id: string): Unit | undefined {
  return s.units.find((u) => u.id === id);
}

export function unitsOf(s: GameState, p: PlayerId): Unit[] {
  return s.units.filter((u) => u.owner === p);
}

/**
 * 编制（${CONFIG.maxUnits} 人上限）只数战斗单位，建筑不算。
 *
 * 以前的写法是"谁在场上都算一个编制"，于是盖了四座磨坊 + 两座军营，
 * 编制就先去掉了六个，产线直接堵死——模拟里出现过一方 24 个单位里只有 4 个能打仗、
 * 金库压着一万二，然后就再也造不出兵、也打不下城，两边耗到第 200 回合。
 * 建筑本来就不该住人：它是工地，不是部队。
 */
export function armySize(s: GameState, p: PlayerId): number {
  return s.units.filter((u) => u.owner === p && utype(s, u.type).category !== 'building').length;
}

export function cityById(s: GameState, id: string): City | undefined {
  return s.cities.find((c) => c.id === id);
}

/** 某格属于哪座城市 */
export function cityAt(s: GameState, x: number, y: number): City | undefined {
  const tile = tileAt(s, x, y);
  if (!tile?.cityId) return undefined;
  return cityById(s, tile.cityId);
}

/** 某方控制的城市 */
/** 接管一座废墟要花的重建费：按城市的耐久规模算，越高级的城越贵 */
export function rebuildCost(city: City): number {
  return Math.round(city.maxHp * 2.5);
}

export function citiesOf(s: GameState, p: PlayerId): City[] {
  return s.cities.filter((c) => c.owner === p);
}

/** 城市占的全部格子坐标 */
export function cityTiles(city: City): Array<{ x: number; y: number }> {
  const out: Array<{ x: number; y: number }> = [];
  for (let dy = 0; dy < city.size; dy++) {
    for (let dx = 0; dx < city.size; dx++) out.push({ x: city.x + dx, y: city.y + dy });
  }
  return out;
}

/** 单位到城市方块的最短曼哈顿距离 */
export function distToCity(unit: { x: number; y: number }, city: City): number {
  const cx = Math.min(Math.max(unit.x, city.x), city.x + city.size - 1);
  const cy = Math.min(Math.max(unit.y, city.y), city.y + city.size - 1);
  return Math.abs(unit.x - cx) + Math.abs(unit.y - cy);
}

/** 曼哈顿距离。移动和攻击统一用它，避免"能斜着打但斜着走不过去"的怪事。 */
export function distance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

export function cloneState(s: GameState): GameState {
  return structuredClone(s);
}

export function canMove(u: Unit): boolean {
  return !u.moved;
}

export function canAttack(u: Unit): boolean {
  return !u.acted;
}

/**
 * 相邻友军提供的光环加成。
 *
 * 只加不乘，也不递归——否则两个指挥光环互相加成会失控。
 */
export function auraBonus(s: GameState, unit: Unit): { atk: number; armor: number } {
  let atk = 0;
  let armor = 0;
  for (const ally of s.units) {
    if (ally.id === unit.id || ally.owner !== unit.owner) continue;
    if (distance(ally, unit) !== 1) continue;
    const d = utype(s, ally.type);
    if (hasAbility(d, 'aura-command')) atk += 2;
    if (hasAbility(d, 'aura-armor')) armor += 2;
  }
  return { atk, armor };
}

/**
 * 威吓：贴着几个会吓人的敌人，就少几分攻击（每层 2 点，最多两层）。
 *
 * 做成"减法"而不是"禁攻"：禁攻会让一支靠威吓撑起来的阵型变成铁板，
 * 而减法只是让贴身换血变亏——破解办法仍然是玩家熟悉的那两条：拉开、或者先射掉它。
 *
 * 这里必须只依赖 state（computeDamage 要给 UI 的伤害预览复用），不能记录"谁被吓过"。
 */
export function fearPenalty(s: GameState, unit: Unit): number {
  let layers = 0;
  for (const foe of s.units) {
    if (foe.owner === unit.owner) continue;
    if (distance(foe, unit) !== 1) continue;
    if (hasAbility(utype(s, foe.type), 'fear')) layers += 1;
    if (layers >= 2) break;
  }
  return layers * 2;
}

/** 算上扩展规则后的移动力。建筑（move 0）永远是 0，也不吃加速。 */export function movePower(s: GameState, unit: Unit): number {
  const base = utype(s, unit.type).move;
  if (base <= 0) return 0;
  let move = base;
  for (const e of activeExpansions(s)) {
    if (e.hooks.modifyMove) move = e.hooks.modifyMove({ state: s, unit, move });
  }
  return Math.max(1, move);
}

/** 算上扩展规则后的视野半径 */
export function visionOf(s: GameState, unit: Unit): number {
  const selfDef = utype(s, unit.type);
  let r = selfDef.vision;
  for (const e of activeExpansions(s)) {
    if (e.hooks.modifyVision) r = e.hooks.modifyVision({ state: s, player: unit.owner, base: r });
  }
  return Math.max(1, r);
}

/** 算上扩展规则后的兵种造价 */
export function recruitCost(s: GameState, player: PlayerId, def: UnitTypeDef): number {
  let cost = def.cost;
  for (const e of activeExpansions(s)) {
    if (e.hooks.modifyCost) cost = e.hooks.modifyCost({ state: s, player, unitType: def, cost });
  }
  return Math.max(0, cost);
}

/** 这一格能不能站人：水不行，敌方城市也不行（城池得先打下来） */
/**
 * 这一格对某个单位来说能不能进。
 *
 * 行动域是这里最要紧的分支：陆军进不了水，水军上不了岸（桥面算岸），
 * 高山谁都不能进。城市格按归属判定。
 */
function blockedFor(s: GameState, x: number, y: number, unit: { type: string; owner: PlayerId }): boolean {
  const tile = tileAt(s, x, y);
  if (!tile) return true;

  const water = utype(s, unit.type).domain === 'water';
  if (water) {
    // 桥架在水面上，船从桥下过：能穿过去，但桥自己占着那一格，停不下来。
    if (tile.terrain !== 'water' && tile.terrain !== 'bridge') return true;
  } else if (!passable(tile.terrain)) {
    return true;
  }

  if (tile.cityId) {
    const city = cityById(s, tile.cityId);
    // 废墟可以进：进城那一下就是"接管"这个动作本身
    if (city && city.owner !== unit.owner && !city.ruined) return true;
  }
  return false;
}

/**
 * 潜行：站在森林/丘陵上的单位，只有贴到相邻格的敌人才发现得了它。
 *
 * 这是"迷雾 + 地形"两条机制的交叉点，不是面板数值：
 * 开阔地上一点用没有，蹲在林子里才成立，而破解办法是走过去或者绕路。
 * 关掉迷雾时也一律无效——没有迷雾就没有"看不见"这回事。
 */
export function isHiddenFrom(s: GameState, unit: Unit, viewer: PlayerId): boolean {
  if (!s.fog) return false;
  if (unit.owner === viewer) return false;
  if (!hasAbility(utype(s, unit.type), 'stealth')) return false;

  const tile = tileAt(s, unit.x, unit.y);
  if (!tile || (tile.terrain !== 'forest' && tile.terrain !== 'hill')) return false;

  for (const v of unitsOf(s, viewer)) {
    if (distance(v, unit) <= 1) return false;
  }
  return true;
}

/**
 * 可达格（Dijkstra，因为地形消耗不同，BFS 会算错）。
 * 返回 格索引 -> 累计消耗。被友军占据的格子会从结果里去掉：
 * 己方单位可以穿过友军，但不能停在友军身上。
 */
export function reachableTiles(s: GameState, unit: Unit): Map<number, number> {
  const budget = movePower(s, unit);
  const def = utype(s, unit.type);
  const forestWalk = hasAbility(def, 'forest-walk');
  // 飞行：可以掠过水面（但停不下来），森林和丘陵也按 1 步算。
  // 这条不是"更强的穿林"——穿林的收益是省一步，飞行的收益是**河防对它不成立**。
  const flyer = hasAbility(def, 'fly');
  // 水面地形代价是 99（对陆军而言就是"走不了"），所以水军必须单独给价格：
  // 不然船一步都动不了 —— 这一条曾经真的漏过，测试也没抓住（可达格为空，
  // "所有可达格都是水"这种全称命题反而是成立的）。
  const waterUnit = def.domain === 'water';
  const best = new Map<number, number>();
  const start = idx(s, unit.x, unit.y);
  best.set(start, 0);

  const queue: Array<{ i: number; cost: number }> = [{ i: start, cost: 0 }];

  while (queue.length > 0) {
    queue.sort((a, b) => a.cost - b.cost);
    const cur = queue.shift();
    if (!cur) break;
    if (cur.cost > (best.get(cur.i) ?? Infinity)) continue;

    const { x, y } = xyOf(s, cur.i);
    for (const [dx, dy] of DIRS) {
      const nx = x + dx;
      const ny = y + dy;
      if (!inBounds(s, nx, ny)) continue;
      if (blockedFor(s, nx, ny, unit)) {
        // 飞行只放行"水面"这一种阻挡：敌方城市、高山、越界照旧拦住。
        // 放行的代价是不能停在水上（见下面的终点过滤），所以它只是过河，不是潜水。
        const ft = tileAt(s, nx, ny);
        if (!(flyer && ft && ft.terrain === 'water')) continue;
      }

      const tile = s.tiles[idx(s, nx, ny)];
      if (!tile) continue;

      // 敌军挡路：既不能进，也不能穿。
      // 但**桥是双向的**：谁都能从桥上过（桥面就那么宽，过得了、停不下），
      // 所以桥上的单位不阻挡通行 —— 想堵路就把桥打塌。
      const occupant = s.units.find((u) => u.x === nx && u.y === ny);
      const bridgeOnTile = occupant ? !!utype(s, occupant.type).bridges : false;
      if (occupant && occupant.owner !== unit.owner && !bridgeOnTile) continue;

      const stepCost = waterUnit
        ? 1 // 航道一格一步，桥下也一样
        : flyer
          ? 1 // 从空中过：水面、森林、丘陵都不额外收费（高山在 blockedFor 那关就进不来）
          : forestWalk && (tile.terrain === 'forest' || tile.terrain === 'hill')
            ? 1
            : CONFIG.terrainCost[tile.terrain];
      const nextCost = cur.cost + stepCost;
      if (nextCost > budget) continue;

      const ni = idx(s, nx, ny);
      if (nextCost < (best.get(ni) ?? Infinity)) {
        best.set(ni, nextCost);
        queue.push({ i: ni, cost: nextCost });
      }
    }
  }

  // 己方单位所在的格子不能作为终点。
  //
  // 建筑是例外，分两种：
  //   · **能站的建筑**（塔、军营、磨坊、工厂、桥……）：站在自己的建筑上是可以的。
  //     一座塔占掉一格却永远空着，只会让布阵时莫名其妙地缺一个洞；
  //     桥更明显——修好了却只能穿过去、停不下来，守桥和换气都没法做。
  //   · **障碍**（墙、栅栏、拒马、铁丝网）：连友军也停不上去。
  //     它们的全部作用就是"这一格不存在"，能站就等于把它删了。
  //
  // 敌方的建筑（非桥）一律不能站：那一格还被它占着，得先打掉。
  for (const i of Array.from(best.keys())) {
    const { x, y } = xyOf(s, i);
    const here = s.units.filter((u) => u.x === x && u.y === y && u.id !== unit.id);
    const blockers = here.filter((u) => {
      const d = utype(s, u.type);
      if (d.category !== 'building') return true;
      if (d.bridges) return false; // 桥是双向的，谁都能站
      if (d.obstacle) return true; // 墙：自己人也过不去
      return u.owner !== unit.owner; // 自家设施能站，敌方的先打掉
    });
    if (blockers.length > 0) best.delete(i);
  }
  // 飞行单位能掠过水面，但落点必须在岸上：中途那一格是"飞过去"的，不是"站上去"的。
  if (flyer && !waterUnit) {
    for (const i of Array.from(best.keys())) {
      const { x, y } = xyOf(s, i);
      const t = tileAt(s, x, y);
      if (t && t.terrain === 'water') best.delete(i);
    }
  }
  best.delete(start);

  return best;
}

/**
 * 威胁范围：这个单位这一回合还能打到哪些格。
 *
 * 分两种情况，差别很大：
 *   · 还没动过 → 可达格 + 每个落点的射程，也就是"我能压住哪一片"
 *   · 已经走过了 → 只剩原地开火的那一圈，别再画一大片骗人
 *
 * 建筑（移动力 0）永远按第二种算。
 */
export function threatTiles(s: GameState, unit: Unit): Set<number> {
  const range = utype(s, unit.type).range;
  const out = new Set<number>();

  const addAround = (cx: number, cy: number) => {
    for (let dy = -range; dy <= range; dy++) {
      for (let dx = -range; dx <= range; dx++) {
        if (Math.abs(dx) + Math.abs(dy) > range) continue;
        if (dx === 0 && dy === 0) continue;
        const x = cx + dx;
        const y = cy + dy;
        if (inBounds(s, x, y)) out.add(idx(s, x, y));
      }
    }
  };

  // 走过了、或者根本不能动：只剩身前这一圈
  if (unit.moved || movePower(s, unit) === 0) {
    addAround(unit.x, unit.y);
    return out;
  }

  const reach = reachableTiles(s, unit);
  addAround(unit.x, unit.y);
  for (const i of reach.keys()) {
    const { x, y } = xyOf(s, i);
    addAround(x, y);
  }

  // 能走到的格子不用再叠一层红
  for (const i of reach.keys()) out.delete(i);
  out.delete(idx(s, unit.x, unit.y));

  return out;
}

/** 射程内的敌方单位 */
/**
 * 这一下能不能打到：射程够，而且"拆桥必须贴到桥头"。
 *
 * 桥只是两格水上的一块板，隔着大半条河用弓箭把它点着，听着就不像话。
 * 更要命的是它的后果：谁先架桥谁先挨打，两边各架七八座、桥头来回换，
 * 打满 200 回合谁也过不去（模拟里六成的"地形隔断"磨局都是这么来的）。
 * 改成必须站到桥边拆，桥就成了"抢桥头"的争夺点——守方要靠人挡，不是靠射程。
 */
export function canStrike(s: GameState, attacker: Unit, target: Unit): boolean {
  const range = utype(s, attacker.type).range;
  const d = distance(attacker, target);
  if (d <= 0 || d > range) return false;
  if (utype(s, target.type).bridges && d > 1) return false;
  return true;
}

export function attackableTargets(s: GameState, unit: Unit): Unit[] {
  if (!canAttack(unit)) return [];
  return s.units.filter((u) => u.owner !== unit.owner && canStrike(s, unit, u));
}

/** 射程内的敌方城市 */
export function siegeTargets(s: GameState, unit: Unit): City[] {
  if (!canAttack(unit)) return [];
  const range = utype(s, unit.type).range;
  return s.cities.filter((c) => {
    if (c.owner === unit.owner) return false;
    // 废墟不用再砸：它已经没有耐久可打，接下来该做的是派兵进去
    if (c.ruined) return false;
    const d = distToCity(unit, c);
    return d > 0 && d <= range;
  });
}

/**
 * 对单位的伤害：攻击 − （护甲 + 地形加成），最低 1，然后过一遍扩展钩子。
 * 钩子必须是纯函数——这个函数也会在 UI 的伤害预览里被调用。
 */
export function computeDamage(
  s: GameState,
  attacker: Unit,
  defender: Unit,
  isCounter = false,
): number {
  const at = utype(s, attacker.type);
  const dt = utype(s, defender.type);
  const tile = tileAt(s, defender.x, defender.y);
  const terrainBonus = tile ? CONFIG.terrainDef[tile.terrain] : 0;

  // 允许 0：差四个时代的兵打不动坦克，这是刻意的
  const attackerAura = auraBonus(s, attacker);
  const defenderAura = auraBonus(s, defender);

  let armor = dt.armor + defenderAura.armor + terrainBonus;

  // 扩展改护甲放在破甲之前：这样"额外 N 点护甲"和地形加成是同一种东西，
  // 破甲照样削一半、攻击低于护甲照样是 0 伤害。
  for (const e of activeExpansions(s)) {
    if (e.hooks.modifyArmor) {
      armor = e.hooks.modifyArmor({ state: s, attacker, defender, armor, isCounter });
    }
  }

  if (hasAbility(at, 'armor-pierce')) armor = Math.floor(armor / 2);

  let dmg = Math.max(0, at.atk + attackerAura.atk - armor);

  // 冲锋：本回合动过才有这一下。反击是原地还手，不享受冲锋（否则等于白送一条能力）。
  if (!isCounter && hasAbility(at, 'charge') && attacker.moved) dmg += 5;

  // 盾墙：本回合没挪窝才生效，站着守的人才硬
  if (hasAbility(dt, 'shield-wall') && !defender.moved) dmg -= 2;

  // 威吓：跟会吓人的敌人贴身，手就抖了。放在护甲之后扣，
  // 这样它对"轻甲高攻"的单位更致命，对重甲单位几乎无所谓——和自己的定位一致。
  dmg -= fearPenalty(s, attacker);

  if (isCounter) dmg = Math.max(0, Math.round(dmg * CONFIG.counterAttackRatio));

  for (const e of activeExpansions(s)) {
    if (e.hooks.modifyDamage) {
      dmg = e.hooks.modifyDamage({ state: s, attacker, defender, damage: dmg, isCounter });
    }
  }

  return Math.max(0, Math.round(dmg));
}

/** 对城市的伤害：只用城市自身护甲，地形加成不重复计算 */
export function damageToCity(attacker: Unit, city: City, s: GameState): number {
  const at = utype(s, attacker.type);
  // 同样允许 0：拿民兵去砸现代城，就是砸不动
  let dmg = Math.max(0, at.atk - city.armor);
  if (hasAbility(at, 'siege-master')) dmg = Math.round(dmg * 1.5);

  // 攻城走单独的钩子链：地势护甲、破甲这些野战概念在城墙上不成立，
  // 而"全军攻击 +X%"这种按攻击力算的规则，野战和攻城都该吃到。
  for (const e of activeExpansions(s)) {
    if (e.hooks.modifySiegeDamage) {
      dmg = e.hooks.modifySiegeDamage({ state: s, attacker, city, damage: dmg });
    }
  }
  return Math.max(0, dmg);
}

/** 预估伤害，给 UI 的攻击预览用，不改变状态 */
export function previewAttack(
  s: GameState,
  attacker: Unit,
  defender: Unit,
): {
  toDefender: number;
  toAttacker: number;
  counter: boolean;
  hits: number;
  toSplash: number;
} {
  const def = utype(s, attacker.type);
  const burst = Math.max(1, def.burst ?? 1);

  // 多段：按顺序算，打死了就不再有后续
  let toDefender = 0;
  let hp = defender.hp;
  let hits = 0;
  while (hits < burst && hp > 0) {
    const one = computeDamage(s, attacker, defender);
    hp -= one;
    toDefender += one;
    hits += 1;
  }

  const survives = hp > 0;
  const range = utype(s, defender.type).range;
  const counter = survives && distance(attacker, defender) <= range;
  const toAttacker = counter ? computeDamage(s, defender, attacker, true) : 0;

  let toSplash = 0;
  for (const v of splashVictims(s, attacker, defender)) toSplash += v.dmg;

  return { toDefender, toAttacker, counter, hits, toSplash };
}

/**
 * 溅射范围内的敌人：主目标周围的敌人各吃一份打折的伤害。
 *
 * 只打敌人，不打自己人——"炮火误伤"听起来很真实，但在回合制里
 * 它只会变成"我不敢开炮"，而不是"我要算清楚再开炮"。
 */
function splashVictims(
  s: GameState,
  attacker: Unit,
  defender: Unit,
): Array<{ unit: Unit; dmg: number }> {
  const radius = utype(s, attacker.type).splash ?? 0;
  if (radius <= 0) return [];

  const out: Array<{ unit: Unit; dmg: number }> = [];
  for (const v of s.units) {
    if (v.owner === attacker.owner) continue;
    if (v.id === defender.id) continue;
    if (distance(v, defender) > radius) continue;
    const dmg = Math.floor(computeDamage(s, attacker, v) * CONFIG.splashRatio);
    if (dmg <= 0) continue;
    out.push({ unit: v, dmg });
  }
  return out;
}

function pushLog(s: GameState, p: PlayerId, text: string): void {
  s.log.push({ turn: s.turn, player: p, text });
  if (s.log.length > 80) s.log.splice(0, s.log.length - 80);
}

/** 通知所有扩展：有单位阵亡了 */
/**
 * 船沉了，货舱里的人一起没。
 *
 * 不写这条会出现最糟的一种情形：船被打沉了，但船上那两个兵凭空回到了
 * 棋盘上（因为它们的对象还挂在货舱里），玩家只会觉得"这游戏算错了"。
 * 所以凡是从 s.units 里删单位的地方，船上的货一并清掉。
 */
function drownCargo(s: GameState, dead: Unit): void {
  if (!dead.cargo || dead.cargo.length === 0) return;
  const names = dead.cargo.map((u) => utype(s, u.type).name).join('、');
  pushLog(s, other(dead.owner), `随船沉没：${names}`);
}

function fireKilled(s: GameState, victim: Unit, killer: Unit | undefined): void {
  // 自爆能力：自己带来的效果，不依赖扩展
  const victimDef = utype(s, victim.type);
  if (hasAbility(victimDef, 'kamikaze')) {
    const blast = Math.max(1, Math.round(victimDef.atk / 2));
    let hit = 0;
    for (const [dx, dy] of DIRS) {
      const near = s.units.find((u) => u.x === victim.x + dx && u.y === victim.y + dy);
      if (!near) continue;
      near.hp -= blast;
      hit += 1;
    }
    if (hit > 0) {
      pushLog(s, victim.owner, `${victimDef.name} 自爆，波及 ${hit} 个单位`);
      // 不递归触发，避免连环爆炸
      s.units = s.units.filter((u) => u.hp > 0);
    }
  }

  const killerOwner = killer ? killer.owner : other(victim.owner);
  for (const e of activeExpansions(s)) {
    e.hooks.onUnitKilled?.({ state: s, victim, killer, killerOwner });
  }
}

function checkWinner(s: GameState): PlayerId | null {
  for (const p of ['A', 'B'] as PlayerId[]) {
    // 城就是根：一座城都没有，就算你还有一支满编部队也翻不了身——
    // 没有城市就产不了兵、升不了级、也没有收入来源。
    // 所以这里不看兵力，只看"还剩几座城"。
    if (citiesOf(s, p).length === 0) return other(p);

    // 没兵又没钱，也是彻底打不下去了（城还在也不行，站着等死而已）
    const alive = unitsOf(s, p).length;
    const gold = s.players[p].gold;
    if (alive === 0 && gold < CHEAPEST_COST) return other(p);
  }
  return null;
}

/**
 * 一个单位每回合产出多少金币。
 *
 * 经济单位的收入看它**站在哪儿**：农民在平原富、牧民在丘陵富、伐木工在森林富。
 * 所以"把农民挪到平原上"本身就是一个决策，而不再是"造完就忘"。
 * 相邻有水再加一点（灌溉和运输），这就是水利的价值。
 */
export function unitIncome(s: GameState, u: Unit): number {
  const def = utype(s, u.type);
  const tile = tileAt(s, u.x, u.y);
  let income = 0;

  if (def.incomeByTerrain && tile) {
    income += def.incomeByTerrain[tile.terrain] ?? 0;
  } else if (def.income) {
    income += def.income;
  }

  if (income > 0) {
    // 桥面也要算"临水"：桥架在水上，桥下还是水。
    // 只判 water 的话，玩家在河边修一座桥，反而把这一带的贸易加成弄没了——
    // 这是实打实踩过的 bug（建桥之后沿岸农民全少 3 金收入）。
    const nearWater = DIRS.some(([dx, dy]) => {
      const t2 = tileAt(s, u.x + dx, u.y + dy)?.terrain;
      return t2 === 'water' || t2 === 'bridge';
    });
    if (nearWater) income += CONFIG.riverTradeBonus;
  }

  return income;
}

/**
 * 这一方现在每回合能收多少金。**纯函数，不写状态。**
 *
 * 单独抽出来是因为界面要拿它算"接下来几回合大概还有多少钱可花"。
 * 估算和真实结算必须同源——各写一遍的话，指挥官排计划时看到的数字
 * 早晚会和实际扣钱对不上，而这个模式的全部乐趣就是算这笔账。
 */
export function incomeOf(s: GameState, p: PlayerId): number {
  let income = CONFIG.baseIncome;
  for (const city of citiesOf(s, p)) {
    if (city.ruined) continue; // 废墟不产出：它现在只是一堆石头
    income += eraDef(city.era).cityIncome;
  }
  for (const u of unitsOf(s, p)) {
    income += unitIncome(s, u);
  }
  for (const e of activeExpansions(s)) {
    if (e.hooks.modifyIncome) income = e.hooks.modifyIncome({ state: s, player: p, income });
  }
  return Math.max(0, income);
}

/** 回合结束时给当前玩家结算收入：基础 + 每座城 + 每个经济单位按其所在地形 */
function settleIncome(s: GameState, p: PlayerId): number {
  const income = incomeOf(s, p);
  s.players[p].gold += income;
  return income;
}

/**
 * 开局给先手补一次回合收入。
 *
 * 收入是在"结束回合、把回合交给对方"那一刻结算的（doEndTurn 里给 nextPlayer 结算）。
 * 所以后手 B 在自己还没动之前就已经拿到了第一回合的钱，而先手 A 要等到
 * 自己第一回合结束才拿——同一个"第一回合"，A 少了一次收入。
 *
 * 两边都拿，等于谁都没占便宜；这比"让 B 也别拿"更好，因为开局就有钱
 * 才能在第一回合做出有意义的选择（造第二个兵、升级、架桥）。
 */
export function grantOpeningIncome(s: GameState): number {
  const income = settleIncome(s, 'A');
  pushLog(s, 'A', `开局结算：第一回合收入 ${income} 金币`);
  return income;
}

/**
 * 城市回血：有驻军、且城外没有敌人时，每回合恢复耐久。
 *
 * 为什么需要这条：城市被打到只剩几点耐久、你夺回来之后，它就一直是那几点。
 * 攻方只要留一支小队就能第二轮再摘下它 —— "占领"等于没占。
 * 加上回血之后，守住一座城变成一个需要投入兵力的动作：
 *   · 有驻军才回血 → 光占着不算，得留人
 *   · 城外有敌人就不回血 → 想拆掉对方城，就得先把它围起来
 * 这两条合起来，让"围城"从一个说法变成一个动作。
 */
function recoverCities(s: GameState, p: PlayerId): void {
  for (const city of citiesOf(s, p)) {
    if (city.hp >= city.maxHp) continue;
    const heal = cityRegenOf(s, city);
    if (heal <= 0) continue;
    city.hp = Math.min(city.maxHp, city.hp + heal);
  }
}

/**
 * 这座城市这一回合能回多少耐久。0 表示回不了血。
 *
 * 单独导出来，是因为界面要把它写明白（"驻军 1 · 每回合 +4"），
 * 而这些数字必须和规则完全同源，不能各算一遍。
 */
export function cityRegenOf(s: GameState, city: City): number {
  // 废墟不回血：它连墙都没了
  if (city.ruined) return 0;
  const garrison = s.units.filter(
    (u) => u.owner === city.owner && cityTiles(city).some((t) => t.x === u.x && t.y === u.y),
  ).length;
  if (garrison === 0) return 0;

  // 被围城就不休整：敌方单位（活人，不是幽灵）贴在城墙一圈内
  if (s.units.some((u) => u.owner !== city.owner && distToCity(u, city) <= 1)) return 0;

  const bonus = Math.min(
    CONFIG.cityRegenCap - CONFIG.cityRegen,
    Math.max(0, garrison - 1) * CONFIG.cityRegenPerExtra,
  );
  let regen = CONFIG.cityRegen + bonus;
  for (const e of activeExpansions(s)) {
    if (e.hooks.modifyCityRegen) regen = e.hooks.modifyCityRegen({ state: s, city, regen });
  }
  return Math.max(0, regen);
}

/**
 * 这座城市升下一级要多少钱（算上扩展规则）；已封顶返回 null。
 *
 * 单独导出来，是因为界面、AI、规则三处都要问同一个问题，
 * 而扩展（血战）会让这个价随时间变——各算一遍一定会对不上。
 */
export function upgradeCostOf(s: GameState, city: City): number | null {
  let cost = nextUpgradeCost(city.era);
  for (const e of activeExpansions(s)) {
    if (e.hooks.modifyUpgradeCost) {
      cost = e.hooks.modifyUpgradeCost({
        state: s,
        player: city.owner,
        city,
        nextEra: city.era + 1,
        cost,
      });
    }
  }
  return cost === null ? null : Math.max(0, cost);
}

/**
 * 建筑在敌方回合开始时自动开火。
 *
 * 时机选在"对方刚接手回合"，而不是自己回合结束前，是因为这样守方才算真正
 * 享受到防御工事的好处：敌人一踏进射程就先挨一轮，然后才轮到它行动。
 */
function fireBuildings(s: GameState, owner: PlayerId): void {
  const buildings = s.units.filter((u) => u.owner === owner && utype(s, u.type).autoAttack);
  for (const b of buildings) {
    if (!s.units.includes(b)) continue;
    const def = utype(s, b.type);
    const inRange = s.units
      .filter((u) => u.owner !== owner && distance(b, u) > 0 && distance(b, u) <= def.range)
      .sort((x, y) => distance(b, x) - distance(b, y) || x.hp - y.hp);

    const target = inRange[0];
    if (!target) continue;

    const dmg = computeDamage(s, b, target);
    target.hp -= dmg;

    // 炮台/要塞也吃溅射：不然"炮"这种单位自动开火时反而比手动开炮弱
    const splashed = splashVictims(s, b, target);
    for (const v of splashed) v.unit.hp -= v.dmg;

    const splashText =
      splashed.length > 0
        ? `，溅射 ${splashed.map((v) => utype(s, v.unit.type).name).join('、')}`
        : '';
    pushLog(
      s,
      owner,
      `${def.name} 自动开火，对 ${utype(s, target.type).name} 造成 ${dmg} 伤害${splashText}`,
    );

    if (target.hp <= 0) {
      s.units = s.units.filter((u) => u.id !== target.id);
      pushLog(s, owner, `${utype(s, target.type).name} 被击毁`);
      fireKilled(s, target, b);
    }

    for (const v of splashed) {
      if (v.unit.hp > 0) continue;
      if (!s.units.some((u) => u.id === v.unit.id)) continue;
      s.units = s.units.filter((u) => u.id !== v.unit.id);
      pushLog(s, owner, `${utype(s, v.unit.type).name} 被炮火波及消灭`);
      fireKilled(s, v.unit, b);
    }
  }
}

function resetUnitsFor(s: GameState, p: PlayerId): void {
  for (const u of s.units) {
    if (u.owner === p) {
      u.moved = false;
      u.acted = false;
    }
  }
}

/**
 * 唯一的状态迁移入口。
 * 所有 UI 操作、AI、未来的联机请求，都必须走这里。
 */
export function applyAction(s: GameState, action: Action, actor?: PlayerId): ActionResult {
  if (s.winner) return { ok: false, reason: '对局已结束' };

  const by = actor ?? s.current;
  if (by !== s.current) return { ok: false, reason: '还没轮到你行动' };

  const next = cloneState(s);

  const result: ActionResult = (() => {
    switch (action.type) {
      case 'MOVE':
        return doMove(next, action.unitId, action.x, action.y);
      case 'ATTACK':
        return doAttack(next, action.unitId, action.targetId);
      case 'SIEGE':
        return doSiege(next, action.unitId, action.cityId);
      case 'RECRUIT':
        return doRecruit(next, action.cityId, action.unitId, action.unitType);
      case 'BUILD':
        return doBuild(next, action.unitId, action.unitType, action.x, action.y);
      case 'LOAD':
        return doLoad(next, action.unitId, action.cargoId);
      case 'UNLOAD':
        return doUnload(next, action.unitId, action.cargoId, action.x, action.y);
      case 'UPGRADE':
        return doUpgrade(next, action.cityId);
      case 'SET_ORDERS':
        return doSetOrders(next, action.queue);
      case 'DISBAND':
        return doDisband(next, action.unitId);
      case 'SURRENDER':
        return doSurrender(next);
      case 'END_TURN':
        return doEndTurn(next);
    }
  })();

  if (result.ok) {
    syncBridges(result.state);
    result.state.winner = result.state.winner ?? checkWinner(result.state);
    refreshMemory(result.state);
  }

  return result;
}

/**
 * 桥面与桥的存活状态对齐。
 *
 * 桥就是"站在水格上的建筑 + 把那一格改成桥面"。这样一套数据能同时满足：
 * 谁都能从上面走过（桥面双向通行，不是自家专属的浮桥）、
 * 但谁也停不下来（那一格被桥自己占着，只能穿）——
 * 想断掉这条路，只能把桥打塌，打塌之后地形自动回退成水。
 *
 * 做成每次动作后统一对账，而不是"在七八处删除单位的地方各写一遍"：
 * 阵亡、自爆波及、城破守军损失这些路径都会经过这里，漏不掉。
 */
function syncBridges(s: GameState): void {
  const alive = new Set<number>();
  for (const u of s.units) {
    if (utype(s, u.type).bridges) alive.add(u.y * s.w + u.x);
  }
  const collapsed: number[] = [];
  for (let i = 0; i < s.tiles.length; i++) {
    const tile = s.tiles[i];
    if (tile && tile.terrain === 'bridge' && !alive.has(i)) {
      tile.terrain = 'water';
      collapsed.push(i);
    }
  }
  if (collapsed.length === 0) return;

  // 桥塌的时候站在桥上的陆军一起没：那一格已经变回水面了，
  // 留着会得到一个"漂在水上的步兵"，后续所有寻路和攻击判定都会错乱。
  const drowned = s.units.filter((u) => {
    if (utype(s, u.type).domain === 'water') return false; // 船本来就在水上
    return collapsed.includes(u.y * s.w + u.x);
  });
  if (drowned.length === 0) return;
  for (const u of drowned) {
    pushLog(s, u.owner, `桥被摧毁，${utype(s, u.type).name} 落水`);
  }
  const gone = new Set(drowned.map((u) => u.id));
  s.units = s.units.filter((u) => !gone.has(u.id));
}

function doMove(s: GameState, unitId: string, x: number, y: number): ActionResult {
  const unit = unitById(s, unitId);
  if (!unit) return { ok: false, reason: '单位不存在' };
  if (unit.owner !== s.current) return { ok: false, reason: '这不是你的单位' };
  if (unit.moved) return { ok: false, reason: '该单位本回合已经移动过' };
  if (!inBounds(s, x, y)) return { ok: false, reason: '目标越界' };

  const reach = reachableTiles(s, unit);
  if (!reach.has(idx(s, x, y))) return { ok: false, reason: '目标格不可达' };

  // 走进废墟 = 接管。钱要在动之前就查：走到一半发现掏不起重建费，
  // 会留下一个"已经站在城里但城市还是别人的"的中间态，很难收拾。
  const destTile = tileAt(s, x, y);
  const destCity = destTile?.cityId ? cityById(s, destTile.cityId) : null;
  if (destCity?.ruined) {
    const price = rebuildCost(destCity);
    if (s.players[unit.owner].gold < price) {
      return { ok: false, reason: `接管这座废墟要 ${price} 金重建，金币不够` };
    }
  }

  unit.x = x;
  unit.y = y;
  unit.moved = true;

  if (destCity?.ruined) {
    const price = rebuildCost(destCity);
    s.players[unit.owner].gold -= price;
    destCity.owner = unit.owner;
    destCity.ruined = false;
    destCity.hp = Math.max(1, Math.ceil(destCity.maxHp * CITY.captureHpRatio));
    destCity.capturedTurn = s.turn;
    pushLog(s, unit.owner, `入驻废墟，支付 ${price} 金重建，${cityName(destCity)} 归你`);
    s.winner = checkWinner(s);
  }

  return { ok: true, state: s };
}

function doAttack(s: GameState, unitId: string, targetId: string): ActionResult {
  const attacker = unitById(s, unitId);
  const defender = unitById(s, targetId);
  if (!attacker) return { ok: false, reason: '单位不存在' };
  if (!defender) return { ok: false, reason: '目标不存在' };
  if (attacker.owner !== s.current) return { ok: false, reason: '这不是你的单位' };
  if (defender.owner === attacker.owner) return { ok: false, reason: '不能攻击友军' };
  if (attacker.acted) return { ok: false, reason: '该单位本回合已经攻击过' };

  const dist = distance(attacker, defender);
  if (!canStrike(s, attacker, defender)) {
    return {
      ok: false,
      reason: utype(s, defender.type).bridges
        ? '拆桥要贴到桥头（隔河打不塌一座桥）'
        : '目标超出射程',
    };
  }

  const atkDef = utype(s, attacker.type);
  const atName = atkDef.name;
  const dfName = utype(s, defender.type).name;

  // 多段攻击：一下一下打，每一下都单独减一次护甲。
  // 打死了就停手（省下来的段数不会转到别人身上，那是溅射的活）。
  const burst = Math.max(1, atkDef.burst ?? 1);
  let dmg = 0;
  let hits = 0;
  while (hits < burst && defender.hp > 0) {
    const one = computeDamage(s, attacker, defender);
    defender.hp -= one;
    dmg += one;
    hits += 1;
  }

  // 溅射：主目标周围的人一起挨（按比例打折，只打敌人）
  const splashed = splashVictims(s, attacker, defender);
  for (const v of splashed) v.unit.hp -= v.dmg;

  const noCounter = hasAbility(atkDef, 'first-strike');
  let counterDmg = 0;
  if (!noCounter && defender.hp > 0 && dist <= utype(s, defender.type).range) {
    counterDmg = computeDamage(s, defender, attacker, true);
    attacker.hp -= counterDmg;
  }

  // 吸血：把这一下真打出来的伤害换成血。放在反击之后结算，
  // 所以"残血扑上去被反杀"依然是死——它奖励的是打得疼，不是敢去送。
  let healed = 0;
  if (hasAbility(atkDef, 'lifesteal') && dmg > 0 && attacker.hp > 0) {
    const room = atkDef.maxHp - attacker.hp;
    healed = Math.min(room, Math.round(dmg * 0.4));
    if (healed > 0) attacker.hp += healed;
  }

  const hitText = burst > 1 ? `${hits} 连击 · ` : '';
  const splashText =
    splashed.length > 0
      ? `，溅射 ${splashed.map((v) => utype(s, v.unit.type).name).join('、')}`
      : '';
  pushLog(
    s,
    attacker.owner,
    dmg > 0
      ? `${atName} 攻击 ${dfName}，${hitText}造成 ${dmg} 伤害${splashText}${counterDmg > 0 ? `，遭到 ${counterDmg} 反击` : ''}`
      : `${atName} 攻击 ${dfName}，穿不透护甲，没有造成伤害${splashText}`,
  );
  if (healed > 0) pushLog(s, attacker.owner, `${atName} 吸取 ${healed} 点生命`);

  attacker.acted = true;
  attacker.moved = true;

  if (defender.hp <= 0) {
    s.units = s.units.filter((u) => u.id !== defender.id);
    pushLog(s, attacker.owner, `${dfName} 被消灭`);
    drownCargo(s, defender);
    fireKilled(s, defender, attacker);
  }

  // 溅射打死的也要走同一套善后：战报 + 沉船 + 击杀钩子
  for (const v of splashed) {
    if (v.unit.hp > 0) continue;
    if (!s.units.some((u) => u.id === v.unit.id)) continue;
    s.units = s.units.filter((u) => u.id !== v.unit.id);
    pushLog(s, attacker.owner, `${utype(s, v.unit.type).name} 被炮火波及消灭`);
    drownCargo(s, v.unit);
    fireKilled(s, v.unit, attacker);
  }
  if (attacker.hp <= 0) {
    s.units = s.units.filter((u) => u.id !== attacker.id);
    pushLog(s, other(attacker.owner), `${atName} 在反击中阵亡`);
    drownCargo(s, attacker);
    fireKilled(s, attacker, undefined);
  }

  s.winner = checkWinner(s);
  return { ok: true, state: s };
}

function doSiege(s: GameState, unitId: string, cityId: string): ActionResult {
  const attacker = unitById(s, unitId);
  const city = cityById(s, cityId);
  if (!attacker) return { ok: false, reason: '单位不存在' };
  if (!city) return { ok: false, reason: '城市不存在' };
  if (attacker.owner !== s.current) return { ok: false, reason: '这不是你的单位' };
  if (city.owner === attacker.owner) return { ok: false, reason: '不能攻击自己的城市' };
  if (city.ruined) return { ok: false, reason: '这已经是废墟了，派兵入驻才能接管' };
  if (attacker.acted) return { ok: false, reason: '该单位本回合已经攻击过' };

  const dist = distToCity(attacker, city);
  if (dist > utype(s, attacker.type).range) return { ok: false, reason: '城市超出射程' };

  const atName = utype(s, attacker.type).name;
  const dmg = damageToCity(attacker, city, s);
  city.hp -= dmg;

  pushLog(
    s,
    attacker.owner,
    dmg > 0
      ? `${atName} 攻城，城市损失 ${dmg} 点耐久`
      : `${atName} 攻城，但打不动这座城的城墙`,
  );

  attacker.acted = true;
  attacker.moved = true;

  if (city.hp <= 0) {
    const prevOwner = city.owner;
    // 「谁先丢城」只记第一次：城会被抢回来，但"先吃亏"这件事不该被撤销。
    if (s.firstCityLost === undefined) s.firstCityLost = prevOwner;

    // 破城 ≠ 易主。城墙打塌、守军打光，但城还在原主名下，只是成了废墟：
    // 想真正拿到它，得派兵走进去并掏钱重建（见 doMove 里的接管分支）。
    // 这样"砸开城墙"和"拿到城市"是两件事，攻城方必须留一支部队去占。
    city.ruined = true;
    city.hp = 0;
    // 当回合这条产线是瘫的（废墟本来就不产兵，这里保留是为了兼容旧存档逻辑）
    city.capturedTurn = s.turn;

    // 城里还没来得及撤走的守军随城陷落
    const tiles = cityTiles(city);
    const garrison = s.units.filter(
      (u) => u.owner === prevOwner && tiles.some((t) => t.x === u.x && t.y === u.y),
    );
    if (garrison.length > 0) {
      s.units = s.units.filter((u) => !garrison.includes(u));
      pushLog(s, attacker.owner, `城中 ${garrison.length} 个守军随城陷落`);
      for (const g of garrison) fireKilled(s, g, attacker);
    }

    pushLog(s, attacker.owner, `${cityName(city)} 被攻破，守军全灭——派兵入驻才能接管`);
  }

  s.winner = checkWinner(s);
  return { ok: true, state: s };
}

/**
 * 桥能不能从建造者这里"接着往前铺"。
 *
 * 桥面那一格是被桥自己占着的——单位过得了、停不下，所以工程队永远站不到
 * 第二段桥旁边。没有这条规则，两格宽的水道就是铺不通：铺好第一段，
 * 第二段的四邻里没有一格站得住人。这里改成按"沿着同一条直线，
 * 中间那几格是不是已经铺好的桥"来量距离，等于工程队站在岸上把桥往外递。
 *
 * 只认横平竖直：桥面是一条直线，斜着接没有物理意义。
 */
export function bridgeChainOk(builder: Unit, x: number, y: number, s: GameState): boolean {
  const dx = x - builder.x;
  const dy = y - builder.y;
  if (Math.abs(dx) + Math.abs(dy) <= CONFIG.buildRange) return true;
  if (dx !== 0 && dy !== 0) return false;
  const steps = Math.abs(dx) + Math.abs(dy);
  // 最多再接两节：再长就不是"过河"，是在水上修路了
  if (steps > CONFIG.buildRange + 2) return false;
  const sx = Math.sign(dx);
  const sy = Math.sign(dy);
  for (let k = 1; k < steps; k++) {
    const t = tileAt(s, builder.x + sx * k, builder.y + sy * k);
    if (!t || t.terrain !== 'bridge') return false;
  }
  return true;
}

/**
 * 由建造单位在野外盖建筑。
 *
 * 建筑不是凭空出现的：得有一个建造者走过去，花钱，把这一回合搭进去。
 * 所以"在哪儿修磨坊"和"派谁去修"都是要算的事。
 */
/**
 * 上船。
 *
 * 上船的单位整条从棋盘上摘掉，存进船的货舱里 —— 这样"船上的人不占格、
 * 不吃攻击、不受地形影响"全部自动成立。上船要花掉那个单位这一回合，
 * 所以"撤退"和"上岸进攻"之间有真实的时间成本。
 */
function doLoad(s: GameState, ferryId: string, cargoId: string): ActionResult {
  const ferry = unitById(s, ferryId);
  if (!ferry) return { ok: false, reason: '船不存在' };
  if (ferry.owner !== s.current) return { ok: false, reason: '这不是你的船' };

  const ferryDef = utype(s, ferry.type);
  if (!ferryDef.transport) return { ok: false, reason: '这条船不能载人' };
  if (ferry.acted) return { ok: false, reason: '这条船本回合已经装卸过了' };

  const cargo = unitById(s, cargoId);
  if (!cargo) return { ok: false, reason: '目标单位不存在' };
  if (cargo.owner !== s.current) return { ok: false, reason: '不能载别人的部队' };

  const cargoDef = utype(s, cargo.type);
  if (cargoDef.domain === 'water') return { ok: false, reason: '船上装不了船' };
  if (cargoDef.category === 'building') return { ok: false, reason: '建筑搬不上船' };
  if (cargo.acted) return { ok: false, reason: '这个单位本回合已经行动过了' };
  if (distance(ferry, cargo) !== 1) return { ok: false, reason: '要贴着船才能上船' };

  const load = ferry.cargo ?? [];
  const cap = ferryDef.capacity ?? 0;
  if (load.length >= cap) return { ok: false, reason: `这条船装满了（${cap}）` };

  // 上船：从棋盘上摘下来，整个对象存进货舱
  s.units = s.units.filter((u) => u.id !== cargo.id);
  ferry.cargo = [...load, { ...cargo, x: ferry.x, y: ferry.y, moved: true, acted: true }];
  ferry.acted = true;

  pushLog(s, s.current, `${cargoDef.name} 登上了${ferryDef.name}`);
  return { ok: true, state: s };
}

/**
 * 下船：把人放到相邻的空地上。
 *
 * 落点用 blockedFor 判：不能是水、不能是高山、不能是敌方城市格。
 * 下船的单位这一回合不能再动也不能再打 —— 否则运输船就成了一条
 * "隔河空投骑兵连"的传送门。
 */
function doUnload(
  s: GameState,
  ferryId: string,
  cargoId: string,
  x: number,
  y: number,
): ActionResult {
  const ferry = unitById(s, ferryId);
  if (!ferry) return { ok: false, reason: '船不存在' };
  if (ferry.owner !== s.current) return { ok: false, reason: '这不是你的船' };

  const ferryDef = utype(s, ferry.type);
  if (!ferryDef.transport) return { ok: false, reason: '这条船不能载人' };
  if (ferry.acted) return { ok: false, reason: '这条船本回合已经装卸过了' };

  const load = ferry.cargo ?? [];
  const cargo = load.find((u) => u.id === cargoId);
  if (!cargo) return { ok: false, reason: '船上没有这个单位' };

  if (!inBounds(s, x, y)) return { ok: false, reason: '目标越界' };
  if (distance(ferry, { x, y }) !== 1) return { ok: false, reason: '只能在船边一格下船' };
  if (unitAt(s, x, y)) return { ok: false, reason: '那一格已经有人了' };
  if (blockedFor(s, x, y, cargo)) return { ok: false, reason: '那里上不了岸' };

  ferry.cargo = load.filter((u) => u.id !== cargoId);
  s.units.push({ ...cargo, x, y, moved: true, acted: true });
  ferry.acted = true;

  pushLog(s, s.current, `${utype(s, cargo.type).name} 在岸边下船`);
  return { ok: true, state: s };
}

function doBuild(
  s: GameState,
  unitId: string,
  unitTypeId: string,
  x: number,
  y: number,
): ActionResult {
  const builder = unitById(s, unitId);
  if (!builder) return { ok: false, reason: '建造者不存在' };
  if (builder.owner !== s.current) return { ok: false, reason: '这不是你的单位' };
  if (builder.acted) return { ok: false, reason: '该单位本回合已经行动过' };

  const builderDef = utype(s, builder.type);
  if (!builderDef.builds || builderDef.builds.length === 0) {
    return { ok: false, reason: `${builderDef.name} 不是建造单位` };
  }
  if (!builderDef.builds.includes(unitTypeId)) {
    return { ok: false, reason: `${builderDef.name} 不会建造这个` };
  }

  const def = s.unitTypes[unitTypeId];
  if (!def) return { ok: false, reason: '本局没有这个建筑' };
  if (def.category !== 'building') return { ok: false, reason: '只有建筑可以修建' };

  if (!inBounds(s, x, y)) return { ok: false, reason: '目标越界' };
  const tile = tileAt(s, x, y);
  if (!tile) return { ok: false, reason: '目标越界' };
  if (unitAt(s, x, y)) return { ok: false, reason: '这里已经有单位或建筑了' };

  // 别把自己堵死：城市格的出兵位是产线的命门。
  //
  // 现实里踩过太多次——在城里仅剩的那格空地上盖一座塔，城市的产兵格就变成 0，
  // 从此一兵不出，而界面上只是"没有可造的兵"这种不痛不痒的提示。
  // 这里在落子之前就把这条路掐掉。
  const hostCity = s.cities.find(
    (c) =>
      c.owner === s.current &&
      x >= c.x &&
      x < c.x + c.size &&
      y >= c.y &&
      y < c.y + c.size,
  );
  if (hostCity) {
    const slotsLeft = cityTiles(hostCity).filter(
      (t) => !(t.x === x && t.y === y) && !unitAt(s, t.x, t.y),
    );
    if (slotsLeft.length === 0) {
      return { ok: false, reason: '这一格是这座城最后一个出兵位，建在这里会让它再也造不出兵' };
    }
  }

  const overWater = !!def.bridges;

  // 地形要求写在数据里（buildOn）：军营要平地/丘陵，桥要水面，其他建筑任何可通行地形
  if (def.buildOn) {
    if (!def.buildOn.includes(tile.terrain)) {
      const names = def.buildOn.map((t) => CONFIG.terrainName[t]).join('、');
      return { ok: false, reason: `${def.name} 只能建在${names}上` };
    }
  } else if (!passable(tile.terrain)) {
    return { ok: false, reason: '水面和高山上不能建造' };
  }
  if (tile.terrain === 'bridge' && !overWater) {
    return { ok: false, reason: '桥面上不能再盖东西' };
  }
  if (overWater) {
    // 桥只能跨"一窄条水"：要有一侧是陆地，否则是一片汪洋，架不起来
    const touchesLand = DIRS.some(([dx, dy]) => {
      const nb = tileAt(s, x + dx, y + dy);
      return !!nb && passable(nb.terrain);
    });
    if (!touchesLand) return { ok: false, reason: '这里四面都是水，架不了桥' };
  }

  // 临水要求（军营）：靠水补给，所以必须挨着水面
  if (def.requiresWater && !adjacentToWater(s, x, y)) {
    return { ok: false, reason: `${def.name}必须扎在水边（四邻要有一格水面）` };
  }

  if (distance(builder, { x, y }) > CONFIG.buildRange && !(overWater && bridgeChainOk(builder, x, y, s))) {
    return {
      ok: false,
      reason: overWater
        ? `建造者离得太远（最多 ${CONFIG.buildRange} 格；桥可以沿已有的桥面再往外接两节）`
        : `建造者离得太远（最多 ${CONFIG.buildRange} 格）`,
    };
  }

  const price = recruitCost(s, s.current, def);
  if (s.players[s.current].gold < price) return { ok: false, reason: `金币不足（需要 ${price}）` };
  s.players[s.current].gold -= price;
  s.units.push({
    id: `u${s.nextUnitSeq++}`,
    type: def.id,
    owner: s.current,
    x,
    y,
    hp: def.maxHp,
    kills: 0,
    moved: true,
    acted: true,
  });

  // 桥建好就把那一格换成桥面：友军能走过，敌军得过桥
  if (overWater) tile.terrain = 'bridge';

  // 建造要占掉这个单位的整回合
  builder.moved = true;
  builder.acted = true;

  pushLog(
    s,
    s.current,
    `${builderDef.name} 在 ${String.fromCharCode(65 + x)}${y + 1} 修建了 ${def.name}`,
  );
  return { ok: true, state: s };
}

/**
 * 升级城市时代。
 *
 * 注意这里用的是**增量**而不是直接赋值：扩展规则（比如「要塞」）
 * 会在开局时给所有城市加耐久和护甲，如果升级时直接写成
 * eraDef 的绝对值，那些加成就被抹掉了。
 */
function doUpgrade(s: GameState, cityId: string): ActionResult {
  const city = cityById(s, cityId);
  if (!city) return { ok: false, reason: '城市不存在' };
  if (city.owner !== s.current) return { ok: false, reason: '只能升级自己的城市' };

  const cost = upgradeCostOf(s, city);
  if (cost === null) return { ok: false, reason: '已经是最高时代' };

  const player = s.players[s.current];
  if (player.gold < cost) return { ok: false, reason: `金币不足（需要 ${cost}）` };

  const from = eraDef(city.era);
  const to = eraDef(city.era + 1);

  player.gold -= cost;
  city.era += 1;

  const hpGain = to.cityMaxHp - from.cityMaxHp;
  city.maxHp += hpGain;
  city.armor += to.cityArmor - from.cityArmor;
  city.hp = Math.min(city.maxHp, city.hp + hpGain);

  pushLog(
    s,
    s.current,
    `城市 ${cityName(city)} 升级到「${to.name}」时代（耐久 ${city.maxHp}，护甲 ${city.armor}）`,
  );

  return { ok: true, state: s };
}

/**
 * 产兵。
 *
 * 产兵点有两种：城市，或者军营（`barracks`）。
 * 军营自己没有科技，用的是**最近己方城市的时代** —— 这既符合直觉
 *（前线的兵营靠后方军工撑着），也省掉了"军营也要单独升级"的一套系统。
 */
function doRecruit(
  s: GameState,
  cityId: string | undefined,
  campId: string | undefined,
  unitTypeId: string,
): ActionResult {
  const def = s.unitTypes[unitTypeId];
  if (!def) return { ok: false, reason: '本局没有这个兵种' };
  if (def.category === 'building') {
    return { ok: false, reason: '建筑要在野外选址修建，不能从产兵点生产' };
  }

  /** 这个产兵点用哪个时代、叫什么、能往哪些格子出兵 */
  let era = 0;
  let label = '';
  let slots: Array<{ x: number; y: number }> = [];

  if (campId) {
    const camp = unitById(s, campId);
    if (!camp) return { ok: false, reason: '产兵点不存在' };
    const campDef = utype(s, camp.type);
    if (!campDef.barracks) return { ok: false, reason: '这不是军营' };
    if (camp.owner !== s.current) return { ok: false, reason: '这不是你的军营' };

    const own = citiesOf(s, s.current);
    if (own.length === 0) return { ok: false, reason: '没有城市，军营补给就断了' };
    const nearest = own.reduce((a, b) => (distToCity(camp, a) <= distToCity(camp, b) ? a : b));
    era = nearest.era;
    label = campDef.name;

    // 军营占着自己那一格，兵从四邻的空地出来
    for (const [dx, dy] of DIRS) {
      const x = camp.x + dx;
      const y = camp.y + dy;
      const t = tileAt(s, x, y);
      if (!t) continue;
      if (def.domain === 'water' ? t.terrain !== 'water' : !passable(t.terrain)) continue;
      if (unitAt(s, x, y)) continue;
      slots.push({ x, y });
    }
  } else {
    const city = cityId ? cityById(s, cityId) : undefined;
    if (!city) return { ok: false, reason: '城市不存在' };
    if (city.owner !== s.current) return { ok: false, reason: '只能在自己的城市产兵' };
    era = city.era;
    label = cityName(city);
    if (city.ruined) {
      return { ok: false, reason: '这座城市已成废墟，先派兵入驻接管' };
    }
    if (city.capturedTurn === s.turn) {
      return { ok: false, reason: `${label}刚被打下来，本回合还没恢复生产` };
    }

    if (def.domain === 'water') {
      // 水军要下到城边那一格空水面上去
      slots = cityTiles(city)
        .flatMap((t) => DIRS.map(([dx, dy]) => ({ x: t.x + dx, y: t.y + dy })))
        .filter((p) => {
          const nb = tileAt(s, p.x, p.y);
          return nb?.terrain === 'water' && !unitAt(s, p.x, p.y);
        });
      if (slots.length === 0) return { ok: false, reason: '这座城市不临水（或水面已被占），造不了船' };
    } else {
      slots = cityTiles(city).filter((t) => !unitAt(s, t.x, t.y));
    }
  }

  if (era < def.era) {
    return { ok: false, reason: `${def.name} 需要「${eraDef(def.era).name}」时代` };
  }
  // 只保留当前时代和上一个时代：过老的装备已经淘汰，
  // 否则到了现代还要在产兵面板里翻十个早已没用的兵种
  if (def.era < era - 1) {
    return { ok: false, reason: `${def.name} 已经过时了，${label}的产线不带它` };
  }

  const price = recruitCost(s, s.current, def);
  const player = s.players[s.current];
  if (player.gold < price) return { ok: false, reason: `金币不足（需要 ${price}）` };
  if (armySize(s, s.current) >= CONFIG.maxUnits) {
    return { ok: false, reason: `作战单位数已达上限 ${CONFIG.maxUnits}（建筑不占编制）` };
  }

  const slot = slots[0];
  if (!slot) {
    return {
      ok: false,
      reason: campId ? `${label}周围没有空地放下新兵` : '城市里已经站满了，先挪出位置',
    };
  }

  player.gold -= price;
  s.units.push({
    id: `u${s.nextUnitSeq++}`,
    type: def.id,
    owner: s.current,
    x: slot.x,
    y: slot.y,
    hp: def.maxHp,
    kills: 0,
    // 新兵当回合不能行动，否则等于凭空多一次攻击
    moved: true,
    acted: true,
  });

  pushLog(s, s.current, `${label}产出了${def.name}`);
  return { ok: true, state: s };
}

/**
 * 指挥官模式下这一方的生产序列（只读副本）。普通对局返回空数组。
 */
export function ordersOf(s: GameState, player: PlayerId): string[] {
  return [...(s.orders?.[player] ?? [])];
}

/**
 * 指挥官模式下排生产序列。
 *
 * 只校验四件事：是不是指挥官模式、长度有没有超、点名的兵种存不存在、是不是建筑。
 * **不校验钱够不够、城市够不够高级**——那是 AI 执行时的现实约束，
 * 提前拦下来等于把"排了造不出来"这个后果替玩家抹掉，而它正是这个模式的核心取舍。
 *
 * 空字符串是"这一格故意空着"：玩家可能想排"这回合不造、下回合造坦克"。
 * 所以中间的洞要留着（否则后面整条序列会往前挪），只把末尾的空位裁掉。
 */
function doSetOrders(s: GameState, queue: string[]): ActionResult {
  if (!s.config.commanderMode) return { ok: false, reason: '普通对局没有生产序列' };

  const cleaned = queue.slice(0, CONFIG.commanderSlots).map((id) => id ?? '');
  while (cleaned.length > 0 && cleaned[cleaned.length - 1] === '') cleaned.pop();

  for (const id of cleaned) {
    if (!id) continue;
    // 哨兵值：这一格是"升级时代"，不是兵种
    if (id === ORDER_UPGRADE) continue;
    const def = s.unitTypes[id];
    if (!def) return { ok: false, reason: `没有这个兵种：${id}` };
    if (def.category === 'building') {
      return { ok: false, reason: '建筑要由建造单位去盖，不能排进生产序列' };
    }
  }

  s.orders = { ...(s.orders ?? {}), [s.current]: cleaned };
  return { ok: true, state: s };
}

/**
 * 遣散单位 / 拆除建筑。
 *
 * 三条约束：
 *   · 只能动自己的（"帮对手拆塔"显然不行）；
 *   · 船里还有货就不能拆（否则货舱里的陆军凭空蒸发，玩家会以为是 bug）；
 *   · 回收按**当前造价**的四成（`CONFIG.disbandRefund`），扩展改了价就跟着变。
 *
 * 这个动作不消耗行动：拆完还能接着动别的单位，一回合拆几座是自己的事。
 */
function doDisband(s: GameState, unitId: string): ActionResult {
  const u = s.units.find((x) => x.id === unitId);
  if (!u) return { ok: false, reason: '这里已经没有单位了' };
  if (u.owner !== s.current) return { ok: false, reason: '只能拆自己的' };
  if ((u.cargo?.length ?? 0) > 0) return { ok: false, reason: '船里还有单位，先卸货' };

  const def = utype(s, u.type);
  const refund = Math.round(recruitCost(s, u.owner, def) * CONFIG.disbandRefund);
  s.players[u.owner].gold += refund;
  s.units = s.units.filter((x) => x.id !== unitId);
  pushLog(s, u.owner, `拆除「${def.name}」，回收 ${refund} 金`);
  return { ok: true, state: s };
}

/** 认输：直接判负。磨局里除了城破，总得有个体面的出口 */
function doSurrender(s: GameState): ActionResult {
  const me = s.current;
  s.winner = other(me);
  pushLog(s, me, `${s.players[me].name} 认输`);
  return { ok: true, state: s };
}

function doEndTurn(s: GameState): ActionResult {
  s.winner = checkWinner(s);
  if (s.winner) {
    pushLog(s, s.winner, '对局结束');
    return { ok: true, state: s };
  }

  const prevPlayer = s.current;
  // 指挥官模式：这回合过完了，序列前移一格。
  //
  // 不管兵有没有造出来都照样消耗——"排了一格、钱不够、这回合空了"
  // 正是这个模式要玩家学会预判的东西。要是失败就原地保留，
  // 序列会悄悄滑期，玩家反而看不出自己在哪一步就走了岔。
  const prevQueue = s.orders?.[prevPlayer];
  if (prevQueue && prevQueue.length > 0) prevQueue.shift();

  const nextPlayer = other(s.current);
  s.current = nextPlayer;
  s.turn += 1;

  // 休整：只有上回合没移动、也没攻击的单位才算"歇过来了"。
  // 这个判断必须在 resetUnitsFor 之前做——重置会把这两个标记清掉。
  const rested = new Set(
    s.units.filter((u) => u.owner === nextPlayer && !u.moved && !u.acted).map((u) => u.id),
  );
  resetUnitsFor(s, nextPlayer);

  for (const u of s.units) {
    if (u.owner !== nextPlayer) continue;
    const d = utype(s, u.type);
    // 再生：不挑场合，每回合都回一点点。
    // 和「休整」是两种活法：休整回得多（15%）但要让出一拍，再生回得少（10%）但可以边打边回。
    if (hasAbility(d, 'regenerate') && u.hp < d.maxHp) {
      u.hp = Math.min(d.maxHp, u.hp + Math.ceil(d.maxHp * 0.1));
    }
    if (!rested.has(u.id)) continue;
    if (hasAbility(d, 'heal') && u.hp < d.maxHp) {
      u.hp = Math.min(d.maxHp, u.hp + Math.ceil(d.maxHp * 0.15));
    }
  }

  // 守方的建筑在敌人接手回合的第一时间开火
  fireBuildings(s, prevPlayer);
  s.winner = s.winner ?? checkWinner(s);
  if (s.winner) {
    pushLog(s, s.winner, '对局结束');
    return { ok: true, state: s };
  }

  const income = settleIncome(s, nextPlayer);

  // 回血放在收入之后、扩展钩子之前：先把这一回合的资源算清楚，
  // 再让城市在"自己的回合开始"这一刻修好城墙。
  recoverCities(s, nextPlayer);

  pushLog(s, nextPlayer, `回合开始，获得 ${income} 金币`);

  for (const e of activeExpansions(s)) {
    e.hooks.onTurnStart?.({ state: s, player: nextPlayer });
  }

  return { ok: true, state: s };
}

/** 城市名，用左上角坐标表示，比如 C8 */
export function cityName(city: City): string {
  return `${String.fromCharCode(65 + city.x)}${city.y + 1}`;
}

/**
 * 视野计算。
 *
 * 地形是全图已知的（战场地图本来就该是已知信息），迷雾只遮敌方单位。
 * 这是"星际式"迷雾而不是"文明式"地形探索，对回合制战棋更合适：
 * 你不需要为"这片地是什么"消耗决策，只需要为"敌人在哪"消耗决策。
 */
export function visibleTilesOf(s: GameState, p: PlayerId): Set<number> {
  const out = new Set<number>();

  const addRadius = (cx: number, cy: number, r: number) => {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dy * dy > r * r) continue;
        const x = cx + dx;
        const y = cy + dy;
        if (inBounds(s, x, y)) out.add(idx(s, x, y));
      }
    }
  };

  for (const u of s.units) {
    if (u.owner !== p) continue;
    addRadius(u.x, u.y, visionOf(s, u));
  }

  for (const city of s.cities) {
    if (city.owner !== p) continue;
    for (const t of cityTiles(city)) addRadius(t.x, t.y, CONFIG.cityVision);
  }

  return out;
}

/**
 * 把"谁现在看到了什么"写回记忆。
 *
 * 必须每次状态迁移后都跑一次，否则幽灵位置会停在上上个回合。
 * 这段逻辑放在规则内核里而不是 UI 里，就是为了让它不可被忘记。
 */
export function refreshMemory(s: GameState): void {
  if (!s.fog) return;

  for (const p of ['A', 'B'] as PlayerId[]) {
    const vis = visibleTilesOf(s, p);
    const mem = s.memory[p];
    const aliveIds = new Set(s.units.map((u) => u.id));

    for (const u of s.units) {
      if (u.owner === p) continue;
      if (!vis.has(idx(s, u.x, u.y))) continue;
      // 潜行中的单位不该刷新坐标：它"还在原地"这件事本身也是情报
      if (isHiddenFrom(s, u, p)) continue;

      const known = mem.known.find((k) => k.id === u.id);
      if (known) {
        known.x = u.x;
        known.y = u.y;
        known.type = u.type;
        known.seenAt = s.turn;
      } else {
        mem.known.push({ id: u.id, type: u.type, x: u.x, y: u.y, seenAt: s.turn });
      }
    }

    // 记忆中的单位如果在视野里消失了，说明确实被消灭了，可以忘掉。
    // 如果那格看不见，就继续保留——你不知道它死了还是走了。
    mem.known = mem.known.filter((k) => {
      if (aliveIds.has(k.id)) return true;
      return !vis.has(idx(s, k.x, k.y));
    });
  }
}

/** 当前玩家还能做什么，给 UI 判断按钮是否可用 */
export function playerHasActions(s: GameState): boolean {
  return unitsOf(s, s.current).some((u) => canMove(u) || canAttack(u));
}
