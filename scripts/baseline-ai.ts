/**
 * AI 对手。
 *
 * 战棋的状态空间大到别想全搜索：16×16、二十几个单位、每个单位十几种走法，
 * 一层的分支就是天文数字。所以这里用的是"一步前瞻 + 启发式打分"：
 * 把当前所有能做的动作列出来，各打一个分，挑最高的做，然后重新评估。
 *
 * 三条约束：
 *   1. 不看全图。AI 只吃 playerView 的结果，跟玩家一样受迷雾限制，
 *      否则它就是在作弊，你测出来的平衡也是假的。
 *   2. 确定性。整个决策过程不碰 Math.random：随机性由 (seed, 回合, 步数) 派生，
 *      所以同一局面永远同样应对，存档/回放/双 AI 观战都稳定；
 *      但每回合的值都不同，它不会永远只有一种打法。
 *   3. 有自己的偏好。推进欲望、兵种口味都从开局种子长出来，
 *      同一局里稳定，不同局之间不一样。
 *   4. 不做伤害玩家的特殊照顾。它就是一个贪心的、会算账的对手。
 */

import { hasAbility } from '../src/core/abilities.ts';
import { CONFIG, ORDER_UPGRADE, passable } from '../src/core/config.ts';
import { playerView } from '../src/core/fog.ts';
import {
  armySize,
  attackableTargets,
  buildSiteError,
  canAttack,
  cityAt,
  cityById,
  cityTiles,
  citiesOf,
  damageToCity,
  distance,
  distToCity,
  eggSpots,
  idx,
  inBounds,
  incomeOf,
  ordersOf,
  other,
  previewAttack,
  reachableTiles,
  rebuildCost,
  recruitCost,
  recruitResCost,
  siegeTargets,
  tileAt,
  underConstruction,
  unitAt,
  unitsOf,
  upgradeCostOf,
  utype,
  xyOf,
} from '../src/core/rules.ts';
import { canPay, payRes } from '../src/core/resources.ts';
import type { Action, AiLevel, City, GameState, PlayerId, Terrain, Unit, UnitTypeDef } from '../src/core/types.ts';

export interface AiBudget {
  maxRecruit: number;
  maxUpgrade: number;
  recruited: number;
  upgraded: number;
  /**
   * 指挥官模式：本回合点名的兵种 id。
   *
   * 有值时 AI 只造这一个兵，造不出来就这回合不产兵（转去做别的事）；
   * 空/未设时照旧自己挑。这一条是"把产兵权交回玩家、其余全托管"的挂钩点。
   */
  order?: string | null;
}

export const DEFAULT_BUDGET: AiBudget = {
  maxRecruit: 2,
  maxUpgrade: 1,
  recruited: 0,
  upgraded: 0,
};

const DIRS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

/**
 * 陆军距离图里"涉一格水"的估价。
 *
 * 不是合法走法，纯粹是给 AI 一个方向感：桥还没架起来的时候，
 * 它得知道"往那个方向走才有对面"，而不是站在河边算无穷远。
 * 定得比普通地面贵一个数量级，所以它永远优先走旱路、只在真的绕不过去时涉水。
 */
const WADE_COST = 14;

interface Candidate {
  action: Action;
  score: number;
}

/* ---------------- 随机性：从状态派生，不碰 Math.random ---------------- */

/** 32 位混合，用来把 (seed, turn, step) 搅成一个稳定的数 */
function mix32(n: number): number {
  let h = n >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

/**
 * 本步的随机值（0~1）。
 *
 * 关键点：它不是"每次调用随机一次"，而是 (种子, 回合, 已推进步数) 的纯函数。
 * 同一局面调用两次结果相同 —— 这是存档、回放、双 AI 观战能对上的前提。
 * `s.log.length` 正好是"这回合已经走了几步"的天然计数：每个动作都会写日志。
 */
export function aiNoise(s: GameState, salt = 0): number {
  const h = mix32(mix32(s.seed ^ 0x9e3779b9) ^ (s.turn * 2654435761) ^ ((s.log.length + salt) * 40503));
  return h / 4294967296;
}

/**
 * 这局 AI 的性格：同一局里固定，不同种子不同。
 *
 * appetite 是"推进欲望"——0.85 保守、1.2 好战；
 * 兵种口味决定它偏爱的两个兵种，让它这局的部队组成和别人不一样。
 */
export interface AiTraits {
  appetite: number;
  /** 这局偏爱的兵种 id（会得到额外权重） */
  favorites: string[];
}

export function aiTraits(s: GameState): AiTraits {
  const h = mix32(s.seed ^ 0xc2b2ae35);
  const appetite = 0.85 + ((h % 1000) / 1000) * 0.35;

  const ids = Object.keys(s.unitTypes).sort();
  const favorites: string[] = [];
  if (ids.length > 0) {
    favorites.push(ids[h % ids.length] as string);
    favorites.push(ids[(h >>> 11) % ids.length] as string);
  }
  return { appetite, favorites };
}

/** 经济单位站在 (x,y) 能赚多少 */
function incomeAt(s: GameState, def: UnitTypeDef, x: number, y: number): number {
  const tile = s.tiles[y * s.w + x];
  if (!tile) return 0;

  let income = def.incomeByTerrain?.[tile.terrain] ?? def.income ?? 0;
  if (income > 0) {
    const nearWater = DIRS.some(([dx, dy]) => {
      const nx = x + dx;
      const ny = y + dy;
      if (!inBounds(s, nx, ny)) return false;
      return s.tiles[ny * s.w + nx]?.terrain === 'water';
    });
    if (nearWater) income += CONFIG.riverTradeBonus;
  }
  return income;
}

/** (x,y) 会不会被敌方下回合打到（AI 只看得到的敌人） */
function inDanger(s: GameState, owner: PlayerId, x: number, y: number): boolean {
  const target = { x, y };
  for (const e of unitsOf(s, other(owner))) {
    const def = utype(s, e.type);
    if (distance(e, target) <= def.range) return true;
    for (const i of reachableTiles(s, e).keys()) {
      if (distance(xyOf(s, i), target) <= def.range) return true;
    }
  }
  return false;
}

/**
 * 地图有多"糙"：森林 + 丘陵占的比例。
 *
 * 这两种地形进门要 2 点移动力，所以 move 1 的单位一步都进不去。
 * 这不是"慢一点"，是"彻底出不了出生点"——它会一直占着产兵格，
 * 而产兵格被占着，城里就再也造不出兵。整支军队就此停摆。
 */
function roughShare(s: GameState): number {
  let rough = 0;
  for (const t of s.tiles) {
    if (t.terrain === 'forest' || t.terrain === 'hill') rough += 1;
  }
  return s.tiles.length > 0 ? rough / s.tiles.length : 0;
}

/**
 * 一个移动力为 move 的单位站在 (x,y)，能不能"走出这片地方"。
 *
 * excludeCityId：站在城里的时候要排除同城的格子——2×2 的城市内部本来就能互相走，
 * 但那不叫走得动。出不了城门，就是一辈子出不了城门。
 *
 * 返回能出去的相邻格数：0 表示四面都是森林/丘陵/水，这单位一出场就是块石头。
 */
/**
 * 这张图有多少水。
 *
 * 水军只在有水的地方有用，但"有水"和"能打"是两件事：
 * 实测水域占比从 1.8%（开阔）到 31%（双河）都有，而一张 20×20 里 3% 的水
 * 就是十几格的池塘——船在里面绕一圈就到底了，连过河都用不上。
 * 所以拿这个数当闸：太干的地图干脆不造船。
 */
function waterShare(s: GameState): number {
  let wet = 0;
  for (const t of s.tiles) if (t.terrain === 'water') wet += 1;
  return s.tiles.length > 0 ? wet / s.tiles.length : 0;
}

/** 水域低于这个比例就别造水军了（实测开阔/山岭图都在 2~7%，河图在 15~31%） */
const WATER_MIN_SHARE = 0.08;

/** 水域只是"将将够"的时候，水军只当补充，不当主力 */
const WATER_GOOD_SHARE = 0.14;

function escapeRoutes(
  s: GameState,
  x: number,
  y: number,
  move: number,
  excludeCityId?: string | null,
): number {
  if (move <= 0) return 1;
  let open = 0;
  for (const [dx, dy] of DIRS) {
    const nx = x + dx;
    const ny = y + dy;
    if (!inBounds(s, nx, ny)) continue;
    const tile = s.tiles[ny * s.w + nx];
    if (!tile || !passable(tile.terrain)) continue;
    if (excludeCityId && tile.cityId === excludeCityId) continue;
    // 别的地方可能站着人，但那是暂时的；地形才是永久性的墙
    if ((CONFIG.terrainCost[tile.terrain] ?? 99) <= move) open += 1;
  }
  return open;
}

/** 这个单位现在是不是动不了 */
function isStuck(s: GameState, unit: Unit): boolean {
  const def = utype(s, unit.type);
  if (def.move <= 0) return false;
  return reachableTiles(s, unit).size === 0;
}

/* ---------------- 难度分档 ---------------- */

/**
 * 这局用哪一档 AI。
 *
 * 只影响"打分算得多细"，不影响"哪些动作是合法的"：
 * 地形、架桥、补兵、避坑这些是缺陷修复，两档共用。
 * 老存档没有这个字段，按高级处理——它才是修完的那一版。
 */
export function aiLevelOf(s: GameState): AiLevel {
  return s.config.aiLevel === 'basic' ? 'basic' : 'advanced';
}

/** 威胁图里"一只敌人占多少分"的系数：一只普通兵大约扣 3.4 分 */
const THREAT_K = 3.4;

/** 经济兵专用的系数：农民死了就是纯亏钱，怕得比战斗单位厉害得多 */
const ECON_THREAT_K = 13;

/**
 * (x, y) 下回合会被几只敌人打到。
 *
 * 和 inDanger 的区别：inDanger 只回答"有没有危险"，这里回答"有多危险"。
 * 战棋里贴着一个人和贴着五个人是两回事——前者叫接敌，后者叫送死。
 * 判据用 move + range 的一次移动射程：进能打到、退能拉开，都算在威胁圈里。
 */
function enemyThreatAt(
  s: GameState,
  owner: PlayerId,
  x: number,
  y: number,
): { n: number; dmg: number } {
  let n = 0;
  let dmg = 0;
  for (const e of unitsOf(s, other(owner))) {
    const def = utype(s, e.type);
    if (def.category !== 'combat') continue;
    const reach = def.move + Math.max(0, def.range);
    if (Math.abs(e.x - x) + Math.abs(e.y - y) > reach) continue;
    n += 1;
    // 威胁要连魔法段一起算。
    //
    // 只按 atk 估的话，法师在 AI 眼里是个"7 攻的废物"——它会心安理得地
    // 把兵停在法师脸上，然后被那 18 点魔攻（还不吃护甲）一炮带走。
    // 魔法段不吃护甲，所以这里不减那 2 点：它对重甲单位也照打。
    dmg += Math.max(0, def.atk - 2) + (def.magicAtk ?? 0);
  }
  return { n, dmg };
}

function scoreAttack(s: GameState, attacker: Unit, target: Unit): number {
  const preview = previewAttack(s, attacker, target);
  const targetDef = utype(s, target.type);
  const selfDef = utype(s, attacker.type);

  const kill = preview.toDefender >= target.hp;
  let score = kill ? 120 + targetDef.cost * 0.12 : (preview.toDefender / targetDef.maxHp) * 60;
  score -= (preview.toAttacker / selfDef.maxHp) * 45;

  // 溅射：一发打到一片，就按"额外伤害"折算成分数，否则 AI 只会盯着血最少的那一个，
  // 永远看不出"这一炮落在人堆里"的价值
  score += preview.toSplash * 1.6;

  // 交手本身就有价值。不加这一条，一次"打掉对方四成血、自己也挨四成"的互换只有几分，
  // 还不如往城里多走一格（9 分）——AI 就会绕着敌人走，永远不打仗。
  score += 14;

  // 残血不硬拼
  if (attacker.hp / selfDef.maxHp < 0.4) score -= 15;

  // 高级：按"谁更贵"算这笔交换划不划算。
  //
  // 初级只看掉血比例，于是它会拿一个 380 金的坦克去换一个 25 金的民兵，
  // 因为两边都掉四成血，账面上打平——实际这一局已经输了。
  // 这里只有三个扣分项，都是在"我可能会死"的前提下才生效：
  // 平时该怎么打还怎么打，不死的仗不该因为贵就不打。
  if (aiLevelOf(s) === 'advanced') {
    const myValue = selfDef.cost;
    const theirValue = targetDef.cost;
    const iDie = preview.toAttacker >= attacker.hp;
    // 打不死对面、自己却要交代进去：最亏的一种，按价值比往死里罚
    if (iDie && !kill) score -= 55 * Math.min(3, myValue / Math.max(20, theirValue));
    // 换掉了，但换亏了：差价越大越不值
    if (iDie && kill) score -= Math.max(0, myValue - theirValue) * 0.18;
    // 已经残血还去打一个打不死的：这是在给对方送击杀
    if (attacker.hp / selfDef.maxHp < 0.3 && !kill) score -= 12 * Math.min(3, myValue / 80);

    // 高机动突击队偏爱后排：摸得到火力单位就优先打，能白打（对方够不着）更值。
    // 和移动那边是一套逻辑的两半——移动负责"绕到能打后排的位置"，
    // 这里负责"真到了别又去打最前面那个肉盾"。
    if (isRaider(selfDef)) {
      if (targetDef.range >= 3) score += 16;
      if (preview.toAttacker === 0) score += 8;
    }
  }

  return score;
}

function scoreSiege(
  s: GameState,
  attacker: Unit,
  city: City,
  focusCityId: string | null,
): number {
  const dmg = damageToCity(attacker, city, s);
  if (dmg <= 0) return -10;
  const capture = dmg >= city.hp;
  const attackerDef = utype(s, attacker.type);

  // 攻城直接通向胜利，权重给得比野战高；能打就打，别在城墙下晃。
  // 这一档整体抬过一次：以前破城的收益常常比"打掉一个杂兵"高不了多少，
  // AI 于是宁可在野战里刷人头，也不肯把兵力压到城下——而人头是赢不了棋的。
  let score = (capture ? 260 : (dmg / city.maxHp) * 62) + 26;

  // 破城专精（siege-master）本来就是为攻城而生的，不打城等于白拿这个能力
  if (hasAbility(attackerDef, 'siege-master')) score += 12;

  // 集中兵力：已经有几个友军贴着这座城，就越值得一起压上去。
  // 一座城的回血是每回合 3~6，一个人打是永远打不下来的。
  const mates = unitsOf(s, attacker.owner).filter(
    (u) => u.id !== attacker.id && distToCity(u, city) <= 1,
  ).length;
  score += mates * 10;

  // 残血收尾：城已经掉过半，优先补刀，别让它回血
  if (city.hp / city.maxHp < 0.5) score += 18;

  // 本回合的主攻方向
  if (city.id === focusCityId) score += 16;

  return score;
}

/**
 * 从一座敌方城市向外做地形代价的 Dijkstra，得到"走到那座城还要多少代价"。
 *
 * 为什么不能用曼哈顿距离：地图上有横贯的河，渡口只有几处。
 * 按直线距离算，"沿着河岸往渡口走"的那一步距离完全没有变近 —— 分数是 0，
 * 于是 AI 会永远停在河这边。一百回合打不了一次，根子就在这儿。
 * 按代价算，往渡口走的每一步都在减少剩余代价，它才会真的过河。
 *
 * 单位不参与这张图（它们每回合都在动，算进去只会让 AI 原地抖），
 * 所以它只是一张"地形怎么绕"的静态图。
 */
function cityDistanceField(s: GameState, city: City, water = false): number[] {
  const size = s.w * s.h;
  const dist: number[] = new Array(size).fill(Infinity);
  const queue: Array<{ i: number; cost: number }> = [];

  for (const t of cityTiles(city)) {
    const i = idx(s, t.x, t.y);
    if (!inBounds(s, t.x, t.y)) continue;
    dist[i] = 0;
    queue.push({ i, cost: 0 });
  }

  while (queue.length > 0) {
    // 棋盘才两三百格，线性挑最小比写堆更省事，也不会慢到哪去
    let pick = 0;
    for (let k = 1; k < queue.length; k++) {
      if ((queue[k]?.cost ?? 0) < (queue[pick]?.cost ?? 0)) pick = k;
    }
    const cur = queue.splice(pick, 1)[0];
    if (!cur || cur.cost > (dist[cur.i] ?? Infinity)) continue;

    const { x, y } = xyOf(s, cur.i);
    for (const [dx, dy] of DIRS) {
      const nx = x + dx;
      const ny = y + dy;
      if (!inBounds(s, nx, ny)) continue;
      const tile = s.tiles[ny * s.w + nx];
      if (!tile) continue;
      if (water) {
        // 水军的图只走水（桥面也算，船从桥底下过）
        if (tile.terrain !== 'water' && tile.terrain !== 'bridge') continue;
      } else if (tile.terrain === 'mountain') {
        continue;
      }

      // 水上按一格一步算：CONFIG.terrainCost.water 是给陆军的"禁止通行"
      //
      // 陆军的图对水面收一个"很贵但有限"的价（WADE_COST），这是故意的：
      // 无渡口的图上，河把两边彻底隔开，如果水面直接当不可通行，
      // 自家这一侧到敌方城市的距离全是无穷远，AI 就彻底失去方向感，
      // 表现是全员原地站桩。给它一个"涉水很贵"的梯度，它才会朝着
      // 最窄的渡口走，然后在那儿架桥。
      const cost =
        cur.cost + (water ? 1 : tile.terrain === 'water' ? WADE_COST : CONFIG.terrainCost[tile.terrain]);

      const ni = ny * s.w + nx;
      if (cost < (dist[ni] ?? Infinity)) {
        dist[ni] = cost;
        queue.push({ i: ni, cost });
      }
    }
  }
  return dist;
}

/** 一次性把所有敌方城市的距离图算出来，供本回合所有兵种共用 */
function distanceFields(s: GameState, me: PlayerId, water = false): Map<string, number[]> {
  const out = new Map<string, number[]>();
  for (const c of s.cities) {
    if (c.owner === me) continue;
    out.set(c.id, cityDistanceField(s, c, water));
  }
  return out;
}

/** 两套图：陆军用 land，水军的 water；外加"该在哪架桥"和"现在到底过不过得去" */
interface Fields {
  land: Map<string, number[]>;
  water: Map<string, number[]>;
  bridgeSite: { x: number; y: number } | null;
  /**
   * 本回合的主攻方向：血最少的那座敌方城市。
   *
   * 没有这个"聚焦"，AI 的部队会一半扑这座城、一半扑那座城，
   * 每一边都只是把城墙刮花，然后被城市回血修回去——围城永远围不下来。
   */
  focusCityId: string | null;
  /**
   * 我方现在纯走旱路摸不到敌方城市（河把两家隔开了）。
   *
   * 这种情况下的"推进"没有意义：距离图里隔着水，怎么走都只是沿着河岸平移。
   * 真正该做的是往桥头集结、把桥铺过去。
   */
  needBridge: boolean;
}

/**
 * 我方能不能纯走旱路摸到敌方城市（贴到城墙一圈就算摸到）。
 *
 * 这是"该不该造桥"的总开关：能走过去，桥就只是捷径；
 * 走不过去，桥就是唯一的通路，全军的行动目标都得换。
 */
function canReachEnemyByLand(s: GameState, owner: PlayerId): boolean {
  const foe = s.cities.filter((c) => c.owner !== owner);
  if (foe.length === 0) return true;

  const seen = new Set<number>();
  const queue: number[] = [];
  for (const u of unitsOf(s, owner)) {
    if (utype(s, u.type).domain === 'water') continue;
    const i = u.y * s.w + u.x;
    if (seen.has(i)) continue;
    seen.add(i);
    queue.push(i);
  }

  while (queue.length > 0) {
    const i = queue.pop() as number;
    const x = i % s.w;
    const y = Math.floor(i / s.w);
    if (foe.some((c) => distToCity({ x, y }, c) <= 1)) return true;

    for (const [dx, dy] of DIRS) {
      const nx = x + dx;
      const ny = y + dy;
      if (!inBounds(s, nx, ny)) continue;
      const j = ny * s.w + nx;
      if (seen.has(j)) continue;
      const t = s.tiles[j];
      if (!t || !passable(t.terrain)) continue;
      // 敌城格不可通行，但"摸到它旁边"上面已经判过了
      if (t.cityId) {
        const c = cityById(s, t.cityId);
        if (c && c.owner !== owner) continue;
      }
      seen.add(j);
      queue.push(j);
    }
  }
  return false;
}

/**
 * 找一处最值得架桥的水面。
 *
 * 判据三条：两边的陆地都通得到（说明这是条真正的河/沟，不是海）、
 * 两边到敌方城市的代价差不多（说明是横向的河，不是绕远的海湾）、
 * 离自己人越近越优先（工程队不想跑半个地图）。
 */
function bestBridgeSite(s: GameState, owner: PlayerId, land: Map<string, number[]>): { x: number; y: number } | null {
  const mine = unitsOf(s, owner).filter((u) => utype(s, u.type).domain !== 'water');

  let best: { x: number; y: number } | null = null;
  let bestScore = -Infinity;

  for (let y = 0; y < s.h; y++) {
    for (let x = 0; x < s.w; x++) {
      if (s.tiles[y * s.w + x]?.terrain !== 'water') continue;
      if (unitAt(s, x, y)) continue;

      const gap = bridgeGap(s, x, y, land);
      if (!gap) continue;

      let near = Infinity;
      for (const u of mine) near = Math.min(near, distance(u, { x, y }));
      if (!Number.isFinite(near)) near = 20;

      // 已经铺出去一段的桥要接着铺。
      //
      // 上一版没有这一条，工程队每回合都重新挑"看起来最近"的水面：这回合在
      // 河中间架一格、下回合挪到隔壁十格再架一格，两格宽的水道永远只有一格桥，
      // 铺到第 200 回合还是过不去。以场地为准而不是以"哪近"为准。
      //
      // chain 只认"顺着同一条直线往外接"：挨着自己桥面还不够，那一座必须正好
      // 挡在近岸和自己的中间。否则一排横着铺也是"相邻"，AI 会把一条路修成
      // 三格宽的广场（实测里真干过：先横着铺三格，再往上铺两格，河心就停住了）。
      const back = unitAt(s, x - gap.dir[0], y - gap.dir[1]);
      const chain = back && back.owner === owner && utype(s, back.type).bridges ? 1 : 0;

      // 窄优先（少铺几座桥）、离自己人近优先、对岸离敌方城市近优先
      const score = gap.steps * -9 - near * 1.1 - gap.farDist * 0.5 + chain * 30;
      if (score > bestScore) {
        bestScore = score;
        best = { x, y };
      }
    }
  }

  return best;
}

/**
 * 这块水面值不值得架桥：从它出发，往哪个方向、跨几格水能上岸。
 *
 * 以前用"四邻有两片陆地"当判据，只能识别一格宽的水沟。一条 3 格宽的河，
 * 岸边那一格水面只有一侧是陆地，按老判据永远判不出"该在这儿架桥"——
 * 于是无渡口的地图上，AI 的工程队一步都不会动。所以改成按方向量"水有多长"。
 *
 * @returns steps 需要的桥面数；farDist 上岸那一格到敌方城市的代价；
 *          dir 这一跨的走向（从近岸指向对岸），用来判断下一格是不是"顺着接"
 */
function bridgeGap(
  s: GameState,
  x: number,
  y: number,
  land: Map<string, number[]>,
): { steps: number; farDist: number; dir: [number, number] } | null {
  let best: { steps: number; farDist: number; dir: [number, number] } | null = null;

  for (const [dx, dy] of DIRS) {
    // 身后得是陆地或已经架好的桥，否则这桥不通向任何地方
    if (!inBounds(s, x - dx, y - dy)) continue;
    const back = s.tiles[(y - dy) * s.w + (x - dx)];
    if (!back || !passable(back.terrain)) continue;

    let steps = 0;
    let cx = x;
    let cy = y;
    let far: { x: number; y: number } | null = null;
    for (let k = 0; k < 4; k++) {
      if (!inBounds(s, cx, cy)) break;
      const t = s.tiles[cy * s.w + cx];
      if (!t) break;
      if (passable(t.terrain)) {
        far = { x: cx, y: cy };
        break;
      }
      if (t.terrain !== 'water') break; // 山挡着，别想
      steps += 1;
      cx += dx;
      cy += dy;
    }
    // 最多铺 4 座：再宽就不值得（也没有那么多回合给工程队挥霍）
    if (!far || steps === 0 || steps > 4) continue;

    let farDist = Infinity;
    for (const field of land.values()) {
      const d = field[far.y * s.w + far.x];
      if (d !== undefined && d < farDist) farDist = d;
    }
    if (!Number.isFinite(farDist)) continue;

    const cand = { steps, farDist, dir: [dx, dy] as [number, number] };
    if (!best || cand.steps < best.steps || (cand.steps === best.steps && cand.farDist < best.farDist)) {
      best = cand;
    }
  }

  return best;
}

/**
 * 站在 (x, y) 上，离"该去的地方"还有多远——数字越小越靠前。
 *
 * 之前这里直接把绝对距离当分数（`-goal * 4`），而候选动作有个"分数必须大于 0"的门槛，
 * 于是只要离敌人超过十来格，所有移动都是负分，全被丢掉：AI 招完兵就站着不动。
 * 移动的分数必须是**相对"原地不动"的增量**，才谈得上"推进"这件事。
 *
 * 分数取"到各敌方城市代价图距离 × 权重"和"到最近敌军距离"里的最小值：
 *   · 城市用代价图（会绕河找渡口），主攻方向（focus）权重压到 0.32 —— 比别处低一大截，
 *     等于让全军朝着一座城收，而不是四个方向各派一路人各挠一下；
 *   · 可见敌军用曼哈顿距离，权重 1.15。它比城市"贵"一点，是为了在野战里先解决挡路的，
 *     而不是从敌军阵列中间穿过去。
 *
 * 两个坑都试过，别再踩回去：
 *   1. 把敌军那一路直接删掉（"目标只能是城"）——实测更差：32×32 上从 63 次攻城
 *      掉到 40 次、城市掉血从 249 掉到 199。原因是没人清屏，部队一路撞在对方的
 *      前排上，反而推不到城下。
 *   2. 把 focus 权重压得更极端（0.2）——也变差（37 次 / 168 血）。0.32 是量出来的甜点：
 *      太松就各打各的，太紧就全挤在一条路上被一起打。
 *
 * 主攻方向和"同血取最近"这条一起看：focus 选谁，全军就往谁那儿收。
 */
function advanceDistance(
  s: GameState,
  owner: PlayerId,
  x: number,
  y: number,
  fields: Map<string, number[]>,
  focusCityId: string | null = null,
): number {
  let best = Infinity;
  for (const c of s.cities) {
    if (c.owner === owner) continue;
    const field = fields.get(c.id);
    const d = field?.[y * s.w + x];
    if (d === undefined || !Number.isFinite(d)) continue;
    // 主攻方向权重压得很低：同一个位置，往那座城走"近得多"。
    // 0.32 是量出来的（见上面的注释）：0.5 太松、全军各扑一座城，
    // 0.2 太紧、全挤在一条路上被一起打。20×20 和 32×32 的城市掉血都翻了一倍多。
    const weight = c.id === focusCityId ? 0.32 : 0.85;
    best = Math.min(best, d * weight);
  }
  for (const e of unitsOf(s, other(owner))) {
    best = Math.min(best, distance({ x, y }, e) * 1.15);
  }
  return best;
}

function scoreMove(
  s: GameState,
  unit: Unit,
  x: number,
  y: number,
  all: Fields,
  traits: AiTraits,
): number {
  const def = utype(s, unit.type);
  const tile = s.tiles[y * s.w + x];
  if (!tile) return -999;

  // 水军要按"水路的距离"算，否则它的起点在图上是无穷远，永远算不出方向
  const fields = def.domain === 'water' ? all.water : all.land;

  // 经济单位：哪儿赚得多去哪儿
  if (def.incomeByTerrain || typeof def.income === 'number') {
    const gain = incomeAt(s, def, x, y) - incomeAt(s, def, unit.x, unit.y);
    const base = gain * 4 - 1.5;
    if (aiLevelOf(s) !== 'advanced') return base;

    // 高级：农民也是钱。一块多赚 2 金的地，不值得站在两个敌人的射程里种——
    // 被摸掉一只，等于那块地白种十几回合。
    // 后半截 (nowTh.n - th.n) * 5 是"脱险奖励"：已经被人围着的时候，
    // 哪怕新位置一分钱不赚，只要离威胁圈更远就值得挪。
    const th = enemyThreatAt(s, unit.owner, x, y);
    const nowTh = enemyThreatAt(s, unit.owner, unit.x, unit.y);
    return base - th.n * ECON_THREAT_K + (nowTh.n - th.n) * 5;
  }

  // 建造者：能架桥就先往值得架桥的水边去，否则回城待命
  //
  // 这里以前返回的是"-距离"这样的绝对负分，而候选动作有"分数必须大于 0"
  // 的门槛 —— 于是工程队除了站在原地，哪也去不了，桥全靠碰运气。
  // 移动的分数必须是"比原地好多少"。
  if (def.category === 'builder') {
    let score: number;
    if ((def.builds ?? []).some((id) => s.unitTypes[id]?.bridges)) {
      const site = all.bridgeSite;
      const mine = unitsOf(s, unit.owner).filter((u) => utype(s, u.type).bridges).length;
      if (site && mine < 6) {
        const step = distance(unit, site) - distance({ x, y }, site);
        // 过河阶段：往桥头走就是当前最重要的任务，给一个压过"顺手盖个磨坊"的底分
        score = (all.needBridge ? 42 : 0) + step * 6;
      } else {
        score = 0;
      }
    } else {
      score = 0;
    }

    if (score === 0) {
      const own = citiesOf(s, unit.owner);
      if (own.length === 0) return -999;
      const before = Math.min(...own.map((c) => distToCity(unit, c)));
      const after = Math.min(...own.map((c) => distToCity({ x, y }, c)));
      score = (before - after) * 3;
    }

    // 建造者是最贵的"一次性消耗品"：造价不比一线兵便宜，却几乎没有还手之力。
    // 所以它的走位要额外避让：往敌人射程里挪是拿 130 金换一座磨坊。
    //
    // 但过河阶段要放宽：对岸一排远程隔着河盯着，工程队按"安全第一"就永远走不到
    // 桥头，整局都过不去。这时架桥是唯一的战略目标，值得冒这个险。
    if (inDanger(s, unit.owner, x, y)) score -= all.needBridge ? 10 : 34;
    // 挨过打就先撤，别硬撑着把工事修完
    if (unit.hp / def.maxHp < 0.6 && inDanger(s, unit.owner, x, y)) score -= 26;
    // 待在自己城边上比较安全，偏远角落只有被人摸上来这一种结局
    const ownCities = citiesOf(s, unit.owner);
    if (ownCities.length > 0) {
      const near = Math.min(...ownCities.map((c) => distance({ x, y }, c)));
      if (near > 10) score -= 12;
    }
    return score;
  }

  // 手长的单位不往前顶。
  //
  // "推进"这套评分是给近战写的：距离变近就是好事。但弓手往前挪的收益是 0
  // （它在该距离上本来就能打），代价却是把自己送进对方近战的怀里、还丢掉地形。
  // 所以这里加两条硬约束，而不是一刀切"不许动"：
  //   ① 挪过去还得打得到人（不能为了推进放弃输出）
  //   ② 不许把自己挪到跟敌人贴脸的位置（除非本来就被贴着，那是突围）
  // 有了这两条，弓手会自己停在射程边缘：再往前一步就是白送。
  //
  // engagedNow = "我现在就够得着人"。够得着的时候不该为了再近一格而挪窝。
  const engagedNow =
    attackableTargets(s, unit).length + siegeTargets(s, unit).length > 0;

  if (def.range >= 2 && canAttack(unit) && engagedNow) {
    const moved = { ...unit, x, y };
    const afterTargets =
      attackableTargets(s, moved).length + siegeTargets(s, moved).length;
    if (afterTargets === 0) return -999;

    const foes = unitsOf(s, other(unit.owner));
    const nowAdjacent = foes.some((e) => distance(unit, e) <= 1);
    const nextAdjacent = foes.some((e) => distance({ x, y }, e) <= 1);
    if (nextAdjacent && !nowAdjacent) return -999;
  }

  // 战斗单位：按"往前推进了多少"给分，原地不动就是 0 分
  const before = advanceDistance(s, unit.owner, unit.x, unit.y, fields, all.focusCityId);
  const after = advanceDistance(s, unit.owner, x, y, fields, all.focusCityId);
  const progress = Number.isFinite(before) && Number.isFinite(after) ? before - after : 0;

  // 已经在输出的人（射程内有人、贴着城）不再为了"前进一格"而挪窝：
  // 换来的那点推进分，抵不过离开掩体、离开射程边缘的代价。
  // 侧移和后撤仍然允许——挨打时该撤还是要撤。
  if (def.range >= 2 && engagedNow && progress > 0) return -999;

  // 一格 ≈ 9 分。这个量级要和"招兵 50 分"错开：
  // 招募预算用完之前它先补兵，用完就该往前压，而不是站着发呆。
  // 乘上这局的性格：好战的 AI 更愿意往前顶，保守的更爱站地形。
  let score = progress * 9 * traits.appetite;

  // 河把两家隔开的时候，"往前推"这件事在距离图上是平的：
  // 沿着河岸走，离敌方城市的涉水距离一点没变（进度 0 分），
  // 于是全军会停在岸边发呆。这时候真正的"往前"是往桥头靠。
  if (all.needBridge && all.bridgeSite) {
    const before = distance(unit, all.bridgeSite);
    const after = distance({ x, y }, all.bridgeSite);
    score += (before - after) * 3.5;
  }

  // 站高地
  score += CONFIG.terrainDef[tile.terrain] * 2;

  // 挪过去就能打到人 → 很值（这就是"接敌"的全部意义）。
  // 已经接上火的就不再给这份奖励，否则"往敌人方向平移一格"永远比开火划算。
  const moved = { ...unit, x, y };
  if (canAttack(unit) && !engagedNow && attackableTargets(s, moved).length > 0) score += 30;

  // 挪过去就能攻城 → 更值（攻城是唯一通向胜利的路，比多打掉一个兵重要）
  if (canAttack(unit) && !engagedNow && siegeTargets(s, moved).length > 0) score += 44;

  // 附近有待收的废墟时，朝它走这件事本身就值钱。
  //
  // 只给"踏进去"那一步加分是不够的：士兵在五格外的时候，那一步还没出现在候选里，
  // 它就照旧往别的城走；等走到城下，对面也把城修好了或者干脆没人去。
  // 所以这里给一条朝向废墟的坡度——每近一格值 35 分，比普通推进（9 分）高得多。
  const ruinsNear = s.cities.filter(
    (c) => c.ruined && s.players[unit.owner].gold >= rebuildCost(c),
  );
  for (const rc of ruinsNear) {
    const before = distToCity(unit, rc);
    const after = distToCity({ x, y }, rc);
    if (before > 0) score += (before - after) * 35;
  }

  // 走进废墟 = 接管城市。这是"破城"之后的唯一收尾动作，而且要给重建费。
  //
  // 这条是补规则的：城市耐久归零之后不再易主，只是变成废墟（不产兵、不产出、不回血），
  // 必须派兵走进去、付重建费才算拿下。AI 以前不知道这回事——它照旧在城墙外面转，
  // 一座已经打空的城就那么摊在那儿，双方都不去收，最后靠回合上限判个平局。
  //
  // 给的分比"破城"（260）略低：破城是打赢，接管是收尾；但比任何野战都高得多，
  // 因为废墟不收，前面那几十回合全是白打。自己的废墟同理——那是产线断了，得赶紧修。
  const destCity = cityAt(s, x, y);
  if (destCity?.ruined) {
    const price = rebuildCost(destCity);
    if (s.players[unit.owner].gold >= price) score += destCity.owner === unit.owner ? 150 : 220;
    // 钱不够就**别走进去**：doMove 会拒绝，AI 这一回合就卡死在这一步上
    else score -= 90;
  }

  // 残血别往枪口上撞
  if (unit.hp / def.maxHp < 0.5 && inDanger(s, unit.owner, x, y)) score -= 25;

  // 高级：威胁图。
  //
  // 上面那条 inDanger 是开关式的：有人能打到就扣 25，一个和五个一样多。
  // 真正决定胜负的是"几个"——所以这里按敌人数量、自己的身价、自己的残血程度
  // 三条一起加权：
  //   · 越贵的单位越怕死（坦克不该去换路口）；
  //   · 越残的越怕死（已经掉了一半血还往人堆里钻，等于白送）；
  //   · 已经被围住的时候，往外挪一步本身就是收益。
  //
  // 这一条是高级和初级差别最大的地方：初级会为了一格推进把炮送到刀口下，
  // 高级宁可原地蹲着等下一回合——这就是"走位刁"的来源。
  if (aiLevelOf(s) === 'advanced') {
    const hpFrac = unit.hp / def.maxHp;
    const th = enemyThreatAt(s, unit.owner, x, y);
    const nowTh = enemyThreatAt(s, unit.owner, unit.x, unit.y);
    // 身价归一化到 0~3.2：民兵 0.45、坦克 3.2 封顶
    const myValue = Math.min(3.2, def.cost / 55);
    score -= th.n * THREAT_K * myValue * (1 + (1 - hpFrac) * 1.5);
    if (hpFrac < 0.5) score += (nowTh.n - th.n) * 10;
  }

  // 高机动突击单位：目标不是"往前推"，而是"绕到后面去"。
  //
  // 这条是后来补的。以前 AI 对骑兵和步兵一视同仁——都按"离敌方城市近了多少"给分，
  // 于是骠骑兵、胸甲骑兵、突击队全都冲在最前面挨集火，机动性只剩下"更快地送死"
  // （实测工业骑兵交换比 0.45、每百金杀伤 10.1，连步枪兵的三分之一都不到）。
  // 现在高级 AI 会做三件事：
  //   ① 找后排猎物（射程 ≥3 的火力单位，或比自己更贵的东西），往它身上靠；
  //   ② 躲开敌方近战主力的贴身范围——贴上去等于白挨一轮，这不是"冲锋"；
  //   ③ 残血时按威胁数量反向外撤，而不是继续往人堆里钻。
  // 这三条加起来才是"机动"的价值：不是走得远，是能选一个对方打不到你的角度。
  if (aiLevelOf(s) === 'advanced' && isRaider(def)) {
    const prey = nearestPrey(s, unit, def);
    if (prey) {
      const step = distance(unit, prey) - distance({ x, y }, prey);
      score += step * 7;
    }
    if (def.range <= 1) {
      const brawlers = unitsOf(s, other(unit.owner)).filter(
        (e) => (utype(s, e.type).range ?? 1) <= 1 && (utype(s, e.type).atk ?? 0) >= 15,
      );
      if (brawlers.some((e) => distance({ x, y }, e) <= 1)) score -= 14;
    }
    if (unit.hp / def.maxHp < 0.45) {
      const th = enemyThreatAt(s, unit.owner, x, y);
      score -= th.n * 8;
    }
  }

  return score;
}

/**
 * 高机动突击单位：跑得快、射程又不足以"白嫖"，价值全在位置上。
 *
 * 射程 3 是分界线：再远就已经是火力单位了，它们本来就该待在后排，
 * 不需要"绕后"这套逻辑。
 */
function isRaider(def: UnitTypeDef): boolean {
  return def.category === 'combat' && def.domain !== 'water' && def.move >= 4 && def.range <= 3;
}

/* ---------------- 编队模板 ---------------- */

/**
 * 支援型能力：这些兵的战场价值不在自己打得多狠，而在整条线更耐打/更能走。
 * 白名单扩过一次——原来只有三条（指挥、护甲光环、威吓），
 * 于是奇想包里所有新支援兵（治疗光环、净化、修缮、召唤、疾行、咒域、布雷）
 * 在 AI 眼里都只是"数值很低的战斗单位"，一局也不会造。
 */
const SUPPORT_ABILITIES = [
  'aura-command',
  'aura-armor',
  'aura-speed',
  'fear',
  'curse-aura',
  'heal-aura',
  'purge',
  'purge-greater',
  'repair',
  'summoner',
  'trap',
  'build-wall',
];

/**
 * 军队的五种职能。配比按**职能**算，不按兵种 id 算——
 * "三个前排"由剑士、长枪兵、树人怎么凑都行，重要的是一支部队里有肉盾、
 * 有输出、有火力、有支撑，而不是"前十名兵种各来两个"。
 */
export type RosterRole = 'tank' | 'melee' | 'ranged' | 'support' | 'siege';

/**
 * 目标配比：前排 30% / 近战输出 25% / 远程 30% / 支援 15%。
 *
 * 这几个数字是照着"能推进、能顶住、能持久"三条给的，不是理论最优解：
 * 前排不够，远程一被贴脸就散；远程不够，压到城下只能拿人命填；
 * 支援为 0，一条线打完就没有第二条线。
 * 攻城器不占常备编制——它是"到了墙下才买"的一次性工具。
 */
const ROLE_TARGET: Record<RosterRole, number> = {
  tank: 0.3,
  melee: 0.25,
  ranged: 0.3,
  support: 0.15,
  siege: 0,
};

/**
 * 模板管四档常备职能。攻城器不在里面——它归"到墙下才加分"那条老规则，
 * 常备配比里给攻城器留份额，等于让 AI 在野战里养一堆拆墙的。
 */
const TEMPLATE_ROLES: RosterRole[] = ['tank', 'melee', 'ranged', 'support'];

/** 这个兵在编制里顶哪一档 */
export function rosterRoleOf(def: UnitTypeDef): RosterRole {
  const ab = def.abilities ?? [];
  // 英雄不算攻城器：九头蛇带 siege-master 是因为它砸墙也疼，
  // 但它进编制是去当主力的，编制里不给它记"攻城"这一档。
  if (!def.hero && ab.includes('siege-master')) return 'siege';
  // 能打的支援兵（天使 42 攻、矮人王 34 攻）算前排：它们本职是站在线上，
  // 光环只是顺带。自己打不动的（牧师、巫医、召唤师）才算支援。
  const brawler = (def.atk ?? 0) >= 20 || (def.magicAtk ?? 0) >= 16;
  if (!brawler && ab.some((a) => SUPPORT_ABILITIES.includes(a))) return 'support';
  if (def.range >= 3) return 'ranged';
  if ((def.armor ?? 0) >= 5 || (def.maxHp ?? 0) >= 65 || ab.includes('shield-wall')) return 'tank';
  return 'melee';
}

export interface RosterShare {
  /** 参与配比统计的陆军战斗单位数（不含召唤物、不含水军） */
  total: number;
  counts: Record<RosterRole, number>;
  /** 已有单位顶到对面城下——攻城器只在此时才算"缺" */
  siegeAtWall: boolean;
}

/**
 * 数一遍现在这支部队。召唤物不算：它们是消耗品，把总数撑大了会让
 * "我缺前排"的判断失真——死灵法师每回合造两个骷髅，不等于前排够了。
 */
export function rosterOf(s: GameState, owner: PlayerId): RosterShare {
  const counts: Record<RosterRole, number> = { tank: 0, melee: 0, ranged: 0, support: 0, siege: 0 };
  let total = 0;
  for (const u of unitsOf(s, owner)) {
    const def = s.unitTypes[u.type];
    if (!def || def.category !== 'combat' || def.domain === 'water') continue;
    if (def.summonedOnly) continue;
    counts[rosterRoleOf(def)] += 1;
    total += 1;
  }
  const foes = citiesOf(s, other(owner));
  const siegeAtWall = unitsOf(s, owner).some((u) => foes.some((c) => distance(u, c) <= 4));
  return { counts, total, siegeAtWall };
}

/**
 * 模板给每个职能加分：缺得越多的那一档，分加得越多。
 *
 * 为什么只加不减：
 *
 * 一开始写的是"缺的加分、超编的扣分"，结果高时代那条测试直接红了——
 * 候选池里五个远程兵、一个前排，扣分全落在远程身上，整支军队的采购分
 * 被压到种田以下，AI 转头买了四间种植园。扣分是"整支部队"的判断，
 * 却挂在"单个兵"身上，只要候选池构成偏一头，就变成了对一个兵种的惩罚。
 *
 * 所以这里只负责把预算往缺的地方推；打压同类刷屏是另一条
 * （同兵种边际递减），那条挂在兵种上，口径才对得上。
 *
 * 系数 70 是照着"整支部队 8 个单位"调的：缺一整档（0.3）≈ +21，封顶 +12。
 * 够把某个职能从"排第五"抬到"排第一"，又不足以让明显不合适的兵
 * （缺前排时去买一个 5 级法师）顶掉对口的选择。
 *
 * total 为 0 时全部记 0：开局该按"先凑出能打的一小撮"走，
 * 让模板去指挥第一支兵没有意义。
 */
export function rosterBonuses(share: RosterShare): Record<RosterRole, number> {
  const out: Record<RosterRole, number> = { tank: 0, melee: 0, ranged: 0, support: 0, siege: 0 };
  if (share.total === 0) return out;
  for (const r of TEMPLATE_ROLES) {
    const gap = ROLE_TARGET[r] - share.counts[r] / share.total;
    out[r] = Math.max(0, Math.min(12, gap * 70));
  }
  return out;
}

/** 突击单位眼里的"猎物"：后排火力（射程 ≥3），或比自己更贵的目标 */
function nearestPrey(s: GameState, unit: Unit, def: UnitTypeDef): Unit | null {
  let best: Unit | null = null;
  let bestD = Infinity;
  for (const e of unitsOf(s, other(unit.owner))) {
    const ed = s.unitTypes[e.type];
    if (!ed) continue;
    if (!(ed.range >= 3 || ed.cost >= def.cost * 1.2)) continue;
    const d = distance(unit, e);
    if (d < bestD) {
      bestD = d;
      best = e;
    }
  }
  return best;
}

/**
 * 这个建造者眼下能开工的格子。
 *
 * 判据一律走 rules.buildSiteError —— 和 doBuild 是同一份。
 * 以前这里复制了一套"扫周围九格"的检查，规则一改它就过期：
 * AI 会提一个必被拒绝的 BUILD，而执行方遇到非法动作会中断整回合，
 * 整局就死在一个"它以为能盖"的位置上。
 */
function buildSpots(
  s: GameState,
  unit: Unit,
  def: UnitTypeDef | undefined,
): Array<{ x: number; y: number; terrain: Terrain }> {
  const out: Array<{ x: number; y: number; terrain: Terrain }> = [];
  if (!def) return out;
  // 桥要多往外找两格：工程队站在岸上够不到三格宽的河心，
  // 只能顺着已经铺好的桥面把下一段递出去（规则里的 bridgeChainOk 允许 +2）。
  const reach = def.bridges ? CONFIG.buildRange + 2 : CONFIG.buildRange;
  for (let dy = -reach; dy <= reach; dy++) {
    for (let dx = -reach; dx <= reach; dx++) {
      if (dx === 0 && dy === 0) continue;
      const x = unit.x + dx;
      const y = unit.y + dy;
      if (!inBounds(s, x, y)) continue;
      const tile = s.tiles[y * s.w + x];
      if (!tile) continue;
      if (buildSiteError(s, def, unit, x, y)) continue;
      out.push({ x, y, terrain: tile.terrain });
    }
  }
  return out;
}

function rawBuildScore(
  s: GameState,
  unit: Unit,
  buildId: string,
  spot: { x: number; y: number; terrain: Terrain },
  land: Map<string, number[]>,
): number {
  const def = s.unitTypes[buildId];
  if (!def) return -999;

  // 工地会不会被下回合拆掉。建造者死在这里的概率远高于野战单位：
  // 他站在空地上、没护甲加成、还刚把整回合花掉。
  const risky = inDanger(s, unit.owner, spot.x, spot.y);

  // 桥：跨得过去、对岸通向敌方城市才值得架
  if (def.bridges) {
    const gap = bridgeGap(s, spot.x, spot.y, land);
    if (!gap) return -999;

    // "接上一段已经铺好的桥"要显著更值。
    //
    // 以前这里只数全局桥数，等于用一个总预算把整条河的量一起管：
    // 自家后院池塘上那几座、加上斜着头铺歪的一两座，很容易就把预算吃光，
    // 于是主线上的桥停在一半——实测里两只工程队铺到河心就不动了，
    // 剩下的回合全花在岸边来回走。所以改成"就近数"：同一条河段上
    // 桥堆到 4 座才算铺够，而紧挨着自己桥面的那一格额外加 26 分，
    // 保证这三格是一条线铺过去的，不是沿河一排戳出来的。
    let near = 0;
    let chain = 0;
    for (const b of unitsOf(s, unit.owner)) {
      if (!utype(s, b.type).bridges) continue;
      if (distance(b, spot) > 7) continue;
      near += 1;
    }
    // 顺着同一条直线往外接的那一格不算"铺够了"：那是在把这条通道做完，
    // 不是在沿河刷桥。上一条硬上限如果不放这一格，三格宽的河永远差最后一块。
    const back = unitAt(s, spot.x - gap.dir[0], spot.y - gap.dir[1]);
    if (back && back.owner === unit.owner && utype(s, back.type).bridges) chain = 1;
    if (near >= 5 && !chain) return -999;

    // 少铺几座优先；对岸越靠近敌方城市越值。
    // 档位加成：钢桥 120 耐久 / 6 护甲，被打塌要磨很久——同样一个建造回合，
    // 产出的是"不会下回合就被拆掉的路"，这才是打破"你拆我建"死循环的东西。
    return (
      58 -
      gap.steps * 9 -
      near * 7 +
      chain * 26 +
      Math.max(0, 24 - gap.farDist) * 0.5 +
      (def.era - 1) * 5 -
      def.cost * 0.04 -
      (risky ? 8 : 0)
    );
  }

  // 军营：把产兵点往前推，省下兵从后方跑到前线的那些回合。
  // 位置讲究"不近不远"——贴着敌人下回合就被推平，缩在后方等于没造。
  if (def.barracks) {
    const cities = citiesOf(s, unit.owner);
    // 军营的时代取最近城市，没有城市就产不出兵，那造它也没意义
    if (cities.length === 0) return -999;
    const mine = unitsOf(s, unit.owner).filter((u) => utype(s, u.type).barracks).length;
    // 上限从"最多三座"放宽到"每城一座、最多四座"。
    // 磨局统计里最刺眼的一条是"顶满 24 个单位、金库还压着几千金"——
    // 钱花不出去就等于没有压力，而军营是唯一能把钱直接变成"前线产兵点"的东西。
    if (mine >= Math.min(4, cities.length + 1)) return -999;

    let nearOwn = Infinity;
    for (const c of cities) nearOwn = Math.min(nearOwn, distance(spot, c));
    if (nearOwn > 12) return -999;

    let nearFoe = Infinity;
    for (const e of unitsOf(s, other(unit.owner))) {
      nearFoe = Math.min(nearFoe, distance(spot, e));
    }
    // 看不见敌人在哪，就先别把补给点压上去
    if (!Number.isFinite(nearFoe)) return -999;
    if (nearFoe < 4) return -999;

    // 前线 6~9 格外最值：再近下回合就被推平，再远等于没往前推
    const front = nearFoe <= 12 ? 34 - Math.abs(nearFoe - 7) * 3 : 6;
    // 高级营更贵，但要让它"贵得值"：耐久和火力都上一个台阶，
    // 在前线顶着的时候比多造一座廉价营有用
    const tier = (def.era - 1) * 5;
    return 52 + front + tier - nearOwn * 0.7 - mine * 16 - def.cost * 0.045;
  }

  if (def.incomeByTerrain) {
    // 经济建筑：建在赚钱的地上才有意义。但被敌人威胁的位置是纯送钱——
    // 经济建筑 2 点护甲，对面一个民兵两下就拆了，还顺手带走建造者。
    if (risky) return -999;
    // 每座城两座经济建筑封顶。
    // 以前"建筑不占编制"之后，钱一多就变成满地的磨坊：模拟里古典局 60 场盖了 682 座，
    // 场面像集市不像战场。经济建筑本身也会继续生钱，越盖越多，最后全在滚利息。
    const sameKind = unitsOf(s, unit.owner).filter((u) => u.type === def.id).length;
    if (sameKind >= Math.max(2, citiesOf(s, unit.owner).length * 2)) return -999;
    const inc = def.incomeByTerrain[spot.terrain] ?? 0;
    return inc * 3 - def.cost * 0.03;
  }

  if (def.autoAttack) {
    // 军事建筑：离敌人越近越有用，但不能贴在敌方主力脸上
    //
    // 数量要设上限：塔是钉在地上的防御，AI 很容易把钱全拿去砌塔，
    // 结果两边各砌一圈塔，谁也推不动——模拟里出现过一局 28 座箭塔、
    // 一百三十回合分不出胜负。每座城配一座就够了。
    const sameKind = unitsOf(s, unit.owner).filter((u) => u.type === def.id).length;
    const cityCount = Math.max(1, citiesOf(s, unit.owner).length);
    if (sameKind >= cityCount + 1) return -999;

    let nearest = Infinity;
    for (const e of unitsOf(s, other(unit.owner))) {
      nearest = Math.min(nearest, distance(spot, e));
    }
    const near = Number.isFinite(nearest) ? Math.max(0, 20 - nearest * 2) : 10;
    return 35 + near - def.cost * 0.04 - sameKind * 8;
  }

  // 纯防御工事：城墙、栅栏、拒马这类。它们不输出、不生钱、不产兵，
  // 值钱的地方只有一处——敌人已经压过来时，把通路堵窄。
  //
  // 以前这类单位落到最后的 return 10，等于"永远排最后"：五个时代的城墙
  // 招募数全是 0，加了跟没加一样。现在的规则是"挨打才砌墙"，而且总量有上限，
  // 免得两边对着垒墙、把对局拖回那个谁也推不动的拉锯。
  if (!def.autoAttack && !def.barracks && !def.incomeByTerrain && !def.bridges) {
    const mine = unitsOf(s, unit.owner).filter((u) => {
      const ud = utype(s, u.type);
      return ud.category === 'building' && !ud.autoAttack && !ud.barracks && !ud.incomeByTerrain;
    }).length;
    if (mine >= Math.max(2, citiesOf(s, unit.owner).length * 2)) return -999;
    if (risky) return -999;

    let nearestFoe = Infinity;
    for (const e of unitsOf(s, other(unit.owner))) {
      nearestFoe = Math.min(nearestFoe, distance(spot, e));
    }
    // 敌人还没到门口，砌墙就是浪费一个建造回合
    if (!Number.isFinite(nearestFoe) || nearestFoe > 7) return 4;
    return 26 + (7 - nearestFoe) * 4 - def.cost * 0.03 - mine * 6;
  }

  return 10;
}

/**
 * 建造评分的门面：在原始评分上叠一层"眼下该干什么"的权重。
 *
 * 过河阶段（河把两家隔开、桥还没铺通）时，能架桥的工程队要先去架桥——
 * 否则它会在家门口盖磨坊盖到天荒地老，而对岸一兵一卒都过不去。
 */
function scoreBuild(
  s: GameState,
  unit: Unit,
  buildId: string,
  spot: { x: number; y: number; terrain: Terrain },
  all: Fields,
): number {
  const raw = rawBuildScore(s, unit, buildId, spot, all.land);
  if (raw <= -900) return raw;

  const canBridge = (utype(s, unit.type).builds ?? []).includes('bridge');

  // 过河阶段，"架桥"这个动作本身必须比"再往桥头挪一格"更值。
  //
  // 移动那边有个 42 分的常量（needBridge 时给），而桥的原始分只有三十几，
  // 于是工程队走到桥头就开始原地打转：每回合都能挪一格"离桥头一样近"的地方，
  // 分数比真的把桥架上去高。实测里两只工程队在河岸上转了八十回合，一座桥没架。
  if (all.needBridge && s.unitTypes[buildId]?.bridges) return raw + 24;

  if (all.needBridge && canBridge && !s.unitTypes[buildId]?.bridges) {
    // 过河阶段压别的建造，但不能一刀切：军营是"过了河立刻用得上"的东西，
    // 压满 45 分等于整条河岸一个产兵点都没有，兵只能从老家一趟趟往前线跑。
    return raw - (s.unitTypes[buildId]?.barracks ? 20 : 45);
  }
  return raw;
}

function unitCandidates(
  s: GameState,
  unit: Unit,
  all: Fields,
  traits: AiTraits,
  truth: GameState,
): Candidate[] {
  const out: Candidate[] = [];
  const def = utype(s, unit.type);

  // 施工中的工地不能开火、不能围城、不能造东西（规则层会拒），
  // 所以这里根本不为它生成候选——否则 AI 会提一个必被拒绝的动作，
  // 而执行方遇到非法动作就中断整回合，整局直接卡死。
  if (!unit.acted && !underConstruction(unit)) {
    for (const t of attackableTargets(s, unit)) {
      out.push({
        action: { type: 'ATTACK', unitId: unit.id, targetId: t.id },
        score: scoreAttack(s, unit, t),
      });
    }
    for (const c of siegeTargets(s, unit)) {
      out.push({
        action: { type: 'SIEGE', unitId: unit.id, cityId: c.id },
        score: scoreSiege(s, unit, c, all.focusCityId),
      });
    }
    if (def.builds && def.builds.length > 0) {
      for (const buildId of def.builds) {
        const buildDef = s.unitTypes[buildId];
        if (!buildDef) continue;
        // 钱和编制都要够：以前没查，AI 会一直提"金币不足"的建造，
        // 而执行方遇到非法动作就中断整回合。
        if (!canPay(s.players[s.current], recruitResCost(s, s.current, buildDef))) continue;
        for (const spot of buildSpots(s, unit, buildDef)) {
          // 同上：视图里空着的地方，真实局面里可能有个看不见的敌人
          if (unitAt(truth, spot.x, spot.y)) continue;
          out.push({
            action: { type: 'BUILD', unitId: unit.id, unitType: buildId, x: spot.x, y: spot.y },
            score: scoreBuild(s, unit, buildId, spot, all),
          });
        }
      }
    }
  }

  if (!unit.moved && def.move > 0) {
    // 迷雾里看不见的敌人也会挡路：视图上算通达的落点，到了真实局面上
    // 可能被一条"看不见的封锁线"截断。只看落点有没有人是不够的——
    // 路径中间站一个它也照样过不去。所以在这里再和真实可达集合求一次交，
    // 提出的落点才一定执行得下去。
    const real = truth.units.find((u) => u.id === unit.id);
    const realReach = real ? reachableTiles(truth, real) : null;
    const me = s.current;
    let best: Candidate | null = null;
    for (const i of reachableTiles(s, unit).keys()) {
      if (realReach && !realReach.has(i)) continue;
      const { x, y } = xyOf(s, i);
      // 视图中那格是空的，真实局面里可能站着一个它看不见的敌人（潜行 / 视野外）。
      // 这种落点直接跳过，否则会提出一个"目标格不可达"的非法动作，
      // 而执行方遇到非法动作会中断整个回合。
      if (unitAt(truth, x, y)) continue;
      // 空地废墟走进去要付重建费。掏不起就换个落点——
      // rules 的 doMove 会拒绝，AI 提出来又是一次整回合中断。
      const destCity = cityAt(s, x, y);
      if (destCity?.ruined && s.players[me].gold < rebuildCost(destCity)) continue;
      const score = scoreMove(s, unit, x, y, all, traits);
      if (!best || score > best.score) {
        best = { action: { type: 'MOVE', unitId: unit.id, x, y }, score };
      }
    }
    if (best) out.push(best);
  }

  return out;
}

/** 一个经济单位大概能赚多少（按最好的地形估） */
function maxIncome(def: UnitTypeDef): number {
  let best = def.income ?? 0;
  for (const v of Object.values(def.incomeByTerrain ?? {})) {
    if (typeof v === 'number' && v > best) best = v;
  }
  return best;
}

/** 一个产兵点：城市或军营 */
interface RecruitSource {
  kind: 'city' | 'camp';
  id: string;
  x: number;
  y: number;
  /** 能产到哪个时代的兵（军营取最近城市） */
  era: number;
}

/**
 * 在某个产兵点能招的兵里挑一个。
 *
 * 城市和军营共用这段逻辑，区别只在"兵从哪几格出来"和 action 的字段。
 */
/**
 * 英雄技能要不要开。
 *
 * 每条技能只有"该开"和"不该开"两种判断，不做多回合规划——技能 CD 都不长，
 * 早开一轮和晚开一轮的差别远小于"根本不开"。
 * 分数给得比普通动作高一点（20~40），因为技能不占行动：开了还能接着打。
 */
function heroSkillCandidate(view: GameState, u: Unit): Candidate | null {
  const def = utype(view, u.type);
  const skills = def.skills ?? [];
  if (skills.length === 0) return null;

  const foes = unitsOf(view, other(u.owner)).filter(
    (f) => utype(view, f.type).category === 'combat',
  );
  const hpRatio = u.hp / def.maxHp;

  for (const k of skills) {
    if ((u.skillCd?.[k.id] ?? 0) > 0) continue;
    let score = 0;
    switch (k.effect) {
      case 'throw-axe': {
        /*
         * 投斧是**白送的一下**：规则里给它挂了 freeShot，这一击不写 acted，
         * 扔完还能贴身再劈一刀（见 rules 的 doAttack 尾部）。
         *
         * 所以只要有敌人进了三格就该扔——包括贴脸的时候。
         * 老写法是"贴身的敌人就在眼前，劈比扔疼，所以不扔"，把"白送的
         * 六成伤害"当成了"用六成伤害换一次满伤"，白白丢掉一份输出，
         * 表现出来就是矮人王整局一次斧头都没扔过。
         *
         * 贴脸时给的分低一点，只是为了让"够不着"的那种情况优先被看见，
         * 不是不扔。
         */
        const inReach = foes.some((f) => distance(f, u) <= 3);
        if (!inReach) break;
        const adjacent = foes.some((f) => distance(f, u) === 1);
        score = adjacent ? 28 : 36;
        break;
      }
      case 'regenerate': {
        if (hpRatio < 0.65) score = 30 + (0.65 - hpRatio) * 90;
        break;
      }
      case 'dive': {
        if (foes.some((f) => distance(f, u) <= 4)) score = 26;
        break;
      }
      case 'cycle': {
        const cyc = def.cycle ?? [];
        if (cyc.length === 0) break;
        const cur = u.element ?? cyc[0]!;
        const next = cyc[(cyc.indexOf(cur) + 1) % cyc.length]!;
        const near = foes.filter((f) => distance(f, u) <= def.range + 1);
        if (near.length === 0) break;
        // 切到的属性正好克对面的弱点，这一轮就更值得
        const weak = near.some((f) => (utype(view, f.type).weak?.[next] ?? 1) > 1);
        score = weak ? 40 : 22;
        break;
      }
      case 'descend': {
        const radius = k.radius ?? 1;
        const near = unitsOf(view, u.owner).filter((a) => distance(a, u) <= radius);
        const hurt = near.filter((a) => {
          const ad = utype(view, a.type);
          if (a.hp < ad.maxHp * 0.75) return true;
          return !!a.status && Object.keys(a.status).length > 0;
        });
        /*
         * 门槛："两个人受伤"或者"一个人伤得很重"。
         *
         * 原来只认前一条，于是残局里只剩一个残血老兵站在天使旁边时，
         * 「降临」一次都不开——而那种局面恰恰是最该开的：20% 血加上
         * 清空负面状态，能把这个兵从"下一刀就死"拉回来。
         */
        const bad = near.filter((a) => {
          const ad = utype(view, a.type);
          return a.hp < ad.maxHp * 0.4;
        });
        if (hurt.length >= 2 || bad.length >= 1) score = 22 + hurt.length * 5 + bad.length * 4;
        break;
      }
      case 'vanish': {
        /*
         * 隐匿是"脱战"用的，不是"开打前先加个 buff"用的。
         * 所以只在身边有威胁时才值：贴脸且血不满 → 该藏；三格内有人 → 顺手藏。
         * 满血又没人时开它，等于白扔两回合冷却。
         */
        const threat = foes.filter((f) => distance(f, u) <= 3);
        if (threat.length === 0) break;
        const adjacent = threat.some((f) => distance(f, u) <= 1);
        if (adjacent) score = hpRatio < 0.7 ? 34 : 24;
        else score = 18;
        break;
      }
      case 'mitosis': {
        /*
         * 裂殖：血越少越划算（四团 1/4 血比一个残血牢大难缠），
         * 但前提是四邻真有四个空位——裂不出来就别点，规则会拒。
         */
        let free = 0;
        for (const [dx, dy] of DIRS) {
          const nx = u.x + dx;
          const ny = u.y + dy;
          const t = view.tiles[ny * view.w + nx];
          if (!t) continue;
          if (view.units.some((v) => v.x === nx && v.y === ny)) continue;
          if (t.terrain === 'water' || t.terrain === 'mountain') continue;
          free += 1;
        }
        if (free < 4) break;
        if (hpRatio < 0.6) score = 26 + (0.6 - hpRatio) * 40;
        else if (foes.some((f) => distance(f, u) <= 3)) score = 16;
        break;
      }
      case 'fuse': {
        /*
         * 聚合：碎片在场上凑够两只就该合回去，血越少越急——
         * 一只大史莱姆单挑谁都打不过，合体才是它真正的形态。
         */
        const kin = unitsOf(view, u.owner).filter((a) => a.type === u.type && a.hp > 0);
        if (kin.length < 2) break;
        const bossAlive = unitsOf(view, u.owner).some((a) => a.type === (def.mergeInto ?? ''));
        if (bossAlive) break;
        score = hpRatio < 0.5 ? 38 : 24 + kin.length * 3;
        break;
      }
    }
    if (score > 0) {
      return { action: { type: 'HERO_SKILL', unitId: u.id, skillId: k.id }, score };
    }
  }
  return null;
}

/**
 * 蛋放哪：离敌人越远越好，但别离家太远。
 *
 * 两个条件会打架——躲到地图另一头最安全，可这个英雄要重跑十回合才回得来。
 * 所以用"威胁距离封顶 6 格"折算，再拿离自家城市的距离去扣。
 */
function eggPlacement(view: GameState, me: PlayerId): { x: number; y: number } | null {
  const spots = eggSpots(view);
  if (spots.length === 0) return null;
  const foes = unitsOf(view, other(me)).filter((f) => utype(view, f.type).category === 'combat');
  const own = citiesOf(view, me);

  let best: { x: number; y: number } | null = null;
  let bestScore = -Infinity;
  for (const p of spots) {
    let threat = 6;
    for (const f of foes) threat = Math.min(threat, distance(f, p));
    const home =
      own.length > 0
        ? own.reduce((m, c) => Math.min(m, Math.abs(c.x - p.x) + Math.abs(c.y - p.y)), Infinity)
        : 0;
    const score = threat * 10 - home * 1.5;
    if (score > bestScore) {
      bestScore = score;
      best = p;
    }
  }
  return best;
}

function recruitCandidate(
  s: GameState,
  src: RecruitSource,
  traits: AiTraits,
  order?: string | null,
): Candidate | null {
  const me = s.current;
  const gold = s.players[me].gold;
  // 和 rules 一样只数作战单位：建筑不占编制，别让几座磨坊把产线堵死
  if (armySize(s, me) >= CONFIG.maxUnits) return null;

  /** 这个产兵点能往哪些格子出兵（跟 rules 里的 doRecruit 保持一致） */
  const slotsFor = (water: boolean): Array<{ x: number; y: number }> => {
    let cells: Array<{ x: number; y: number }> = [];
    if (src.kind === 'city') {
      const city = cityById(s, src.id);
      if (!city) return [];
      cells = water
        ? cityTiles(city).flatMap((t) => DIRS.map(([dx, dy]) => ({ x: t.x + dx, y: t.y + dy })))
        : cityTiles(city);
    } else {
      // 军营占着自己那一格，兵从四邻出来
      cells = DIRS.map(([dx, dy]) => ({ x: src.x + dx, y: src.y + dy }));
    }

    const out: Array<{ x: number; y: number }> = [];
    for (const cell of cells) {
      const tile = tileAt(s, cell.x, cell.y);
      if (!tile) continue;
      if (water ? tile.terrain !== 'water' : !passable(tile.terrain)) continue;
      if (unitAt(s, cell.x, cell.y)) continue;
      out.push(cell);
    }
    return out;
  };

  const landSlots = slotsFor(false);
  const waterSlots = slotsFor(true);
  if (landSlots.length === 0 && waterSlots.length === 0) return null;

  const choices = Object.values(s.unitTypes).filter((d) => {
    if (d.category === 'building') return false;
    // 运输船目前只给玩家用：AI 还没有"装船—渡河—上岸"这套计划能力，
    // 让它买一条自己不会用的船，等于白烧 60 金。
    if (d.transport) return false;
    // 召唤物只认召唤者：AI 花 45 金买一个骷髅，等于给死灵法师的赠品单独付钱。
    if (d.summonedOnly) return false;
    // 英雄场上只能有一个。这条规则在 doRecruit 里也拦了，但在这里先拦掉，
    // 才能让 AI 把"再多买一个"的钱花到别处，而不是每回合撞一次墙。
    if (d.hero && s.units.some((u) => u.owner === me && u.type === d.id)) return false;
    if (d.era > src.era || d.era < src.era - 1) return false;
    return d.domain === 'water' ? waterSlots.length > 0 : landSlots.length > 0;
  });

  // 指挥官模式：玩家点名了兵种，就只在这个兵种里挑产兵点。
  // 造不出来（时代不够 / 没水 / 钱不够）时返回 null，让 AI 本回合去干别的事——
  // 而不是"退而求其次随便造一个"。指挥官要的是可预期，不是被体贴。
  const pool = order ? choices.filter((d) => d.id === order) : choices;
  if (pool.length === 0) return null;

  const myUnits = unitsOf(s, me);
  const earners = myUnits.filter((u) => utype(s, u.type).category === 'economy').length;  const builders = myUnits.filter((u) => utype(s, u.type).category === 'builder').length;
  // 被地形困住的单位不算"有效兵力"：它们既上不了前线，还占着产兵格。
  // 算拥挤度时必须扣掉，否则 AI 会以为自己兵很多、不再补兵，其实全是站桩的。
  const combatCount = myUnits.filter(
    (u) => utype(s, u.type).category === 'combat' && !isStuck(s, u),
  ).length;
  const rough = roughShare(s);
  const cityCount = Math.max(1, citiesOf(s, me).length);
  const targetEarners = Math.min(8, cityCount * 2);

  // 高级：看现在这支部队的"远程占比"，缺什么补什么。
  //
  // 初级是纯按单价估值的，结果一局打下来常常清一色近战，压到城下被人射成筛子。
  // 但也不能全远程——远程没有肉盾顶着，被贴脸一样崩。所以两头都留阈值：
  // 远程不到七成就优先补远程，超过七成就反过来补近战。
  const landCombat = myUnits.filter(
    (u) => utype(s, u.type).category === 'combat' && utype(s, u.type).domain !== 'water',
  );
  // 这里数的是"真远程"：射程 3 以上。射程 2 是长兵器（戟兵、长枪兵那一档），
  // 它能隔一格戳人，但顶不住远程对射——上一版按 range>=2 算，戟兵改了射程之后
  // 既拿远程奖励、又把远程占比撑虚，AI 于是不买火枪兵了（火药局火枪兵采用率 6.8%）。
  const rangedShare =
    landCombat.length > 0
      ? landCombat.filter((u) => utype(s, u.type).range >= 3).length / landCombat.length
      : 0.5;

  const wet = waterShare(s);
  // 编队模板要的"这支部队现在长什么样"。每次 candidate 都重算一遍，
  // 所以同一回合里连买三个近战后，第四次会看见"近战已经够了"。
  const rosterBonus = rosterBonuses(rosterOf(s, me));

  let best: Candidate | null = null;
  for (const d of pool) {
    // 英雄第一次要付解锁费：只看造价会让 AI 在"差一点钱"的时候反复选中又放弃
    const unlockFee =
      d.hero && !(s.unlocked?.[me] ?? []).includes(d.id) ? (d.unlockCost ?? 0) : 0;
    const price = recruitCost(s, me, d);
    // 多资源：粮食/建材不够时，光有金币也买不起。
    // 只看金币会让 AI 反复挑一个造不出来的兵，然后整回合卡在那里。
    const fullPrice = recruitResCost(s, me, d);
    if (!canPay(s.players[me], fullPrice)) continue;

    // 水军看地图：干地上造出来的船只是八十金的靶子。
    // 干湿两张图差得非常多（开阔 2% / 双河 25%），所以这条不能靠"有没有邻水格"判断——
    // 一个池塘边上也能造船，但它开不出去。
    if (d.domain === 'water' && wet < WATER_MIN_SHARE) continue;
    if (gold < price + unlockFee) continue;

    let score = 50;
    if (d.category === 'combat') {
      score += 12 + d.era * 4;
      if (d.domain === 'water') {
        score -= 8;
        // 有点水但不宽裕：船能开，只是绕不开岸，别当主力
        if (wet < WATER_GOOD_SHARE) score -= 10;
      }

      // 高时代单位要主动去用，否则 AI 会一辈子造火枪兵。
      // 实测：60 局里坦克只造了 1 辆、火炮 10 门 —— 不是它们弱（交换比 3+），
      // 是"贵"在打分里被折了两次：单价惩罚一次，anti-mass 一次。
      // 这里补一点意愿，同时把它们的单价惩罚调轻，让贵的兵真的有机会上场。
      if (d.era >= 4) {
        score += 6 + (d.era - 4) * 6;
        // 手头宽裕（能买两个）时再加一点：说明现在不是"勒紧裤腰带"的时刻
        if (gold >= price * 2) score += 6;
        // 贵而专的兵（坦克 380 / 火炮 320）不该永远排在步兵班后面。
        // 上面的单价惩罚是线性的，对大件不公平：一辆坦克的战场价值不是三倍步兵班，是它的护甲和破城。
        // 这里按"超出常规单价的溢价"补一点分，8 分封顶，不至于让它压过一切。
        score += Math.min(8, Math.max(0, price - 180) * 0.03);
      }

      // 高级：兵种搭配（见上面 rangedShare 的说明）
      if (aiLevelOf(s) === 'advanced' && d.domain !== 'water') {
        // 以前这里是"远程 / 长兵器 / 近战"三档手调（远程不到七成 +9，
        // 长兵器 +1~3，近战 -4~7）。它解决过一个问题——射程改 2 之后戟兵
        // 既拿远程奖励又把远程占比撑虚，火枪兵采用率掉到 6.8%——但阈值是
        // 按单一维度折出来的，只管"远程 vs 近战"这一条轴，前排和支援没人管。
        // 现在配比统一由下面的编队模板给分，三档手调撤掉，别再叠第二遍。
        // 高机动突击单位：绕后切炮是现在这套 AI 真会用的一招，所以值一点分。
        // 但别给多——骑兵不是万能牌，远程占比已经够高时它就没那么必要。
        if (isRaider(d) && rangedShare < 0.85) score += 7;
        // 攻城器：野战几乎打不动人，只有"已经压到城下"时才值得买。
        // 以前它们一律排最后，五个时代的攻城器械招募数全是 0——
        // 破城 1.5 倍这件事，AI 从来没有为它付过钱。
        if ((d.abilities ?? []).includes('siege-master')) {
          const foeCities = citiesOf(s, other(me));
          const atWall = myUnits.some((u) => foeCities.some((c) => distance(u, c) <= 4));
          if (atWall) score += 16;
        }
        // 支援型能力：价值不在自己打得多狠，而在整条线更耐打。
        // 有治疗/净化/召唤的兵再额外给一点——它们改变的是"这支军队能熬多久"。
        if ((d.abilities ?? []).some((a) => SUPPORT_ABILITIES.includes(a))) score += 5;
        if ((d.abilities ?? []).some((a) => ['heal-aura', 'purge', 'summoner'].includes(a))) {
          score += 4;
        }
        // 编队模板：前排 / 近战输出 / 远程 / 支援，缺哪一档就把预算往哪推。
        // 上面那些是"这个兵本身值多少"，这一条是"这支部队缺什么"——
        // 少了它，采购就是纯 argmax：分最高的那个兵种吃满预算，
        // 一局下来清一色三四种兵，法师和支援连门都进不去。
        score += rosterBonus[rosterRoleOf(d)];
      }

      // 魔法段要算进"这个兵能打多少"。
      //
      // 打分一直只认 d.atk，于是法师在 52 个候选里排第 42 名：它把一半的伤害
      // 搬进了 magicAtk，而那笔钱 AI 不认。结果是"法师在表里、在规则里、
      // 就是不在战场上"。真把攻击力调到 20 才能进前十——那它就不是法师了。
      const magic = d.magicAtk ?? 0;
      if (magic > 0) score += Math.min(9, magic * 0.5);

      // 英雄：军中有一定规模、且买完还剩点余钱时才买。
      // 原来是"钱够就 +14"，等于第一座城一升级就把钱砸在英雄上，
      // 后面没钱出兵，英雄一个人守空城。英雄是"带兵打"的，不是"替兵打"的。
      if (d.hero && landCombat.length >= 6 && gold >= price + unlockFee + Math.round(price * 0.6)) {
        score += 14;
      }

      // 边际递减：同一兵种越多，下一个越不值。
      //
      // 没有这一条时，采购是纯粹的 argmax——前十个兵种吃掉九成预算，
      // 剩下十几个"也能用"的兵一局都见不到。递减不是让 AI 变弱，
      // 是让它在第三个狼骑士之后开始想"我是不是该有个法师了"。
      //
      // 编队模板管的是"职能别偏科"，这一条管的是"同一种兵别刷满"：
      // 只靠模板的话，一个占据优势职能的强者（5 级恶魔、装甲车）照样能
      // 连买四五个，因为职能占比还没超。所以系数从 2.4 提到 3.0、封顶到 20。
      const sameType = myUnits.filter((u) => u.type === d.id).length;
      if (sameType > 0) score -= Math.min(20, sameType * 3);

      // 开局一只兵都没有的时候，先凑出一小撮能打的，别急着攒钱升科技
      if (aiLevelOf(s) === 'advanced' && landCombat.length < 4 && price <= 80) score += 8;

      // ① 造出来就出不了城门的兵，一律不造。
      //    move 1 进不了丘陵和森林（进门 2 点），出生点四邻要是全这种地形，
      //    它这辈子走不到前线，还占着产兵格 —— 产兵格被占，城里就再也造不出兵，
      //    整支军队当场停摆。高时代最容易踩这个坑：重机枪组正好 move 1。
      const slots = d.domain === 'water' ? waterSlots : landSlots;
      const canLeave = slots.some((c) =>
        escapeRoutes(s, c.x, c.y, d.move, src.kind === 'city' ? src.id : null) > 0,
      );
      if (!canLeave) continue;
      //    地图越糙，慢兵的处境越糟：不是"慢一点"，是"只能待在平原上"
      if (d.move <= 1) score -= 10 + rough * 130;

      // ② 别爆兵：多一个战斗单位的边际价值随兵力下降。
      //    高时代尤其明显 —— 堆一屋子低时代步兵只是给对面送人头和击杀数。
      score -= Math.min(38, combatCount * 1.6);

      // ③ 有当代兵就不堆上一代的
      score -= (src.era - d.era) * 11;
    }
    if (d.category === 'economy') {
      const inc = maxIncome(d);
      const payback = inc > 0 ? price / inc : 99;
      score += earners < targetEarners ? 34 - Math.min(18, payback * 1.5) : -14;
    }
    if (d.category === 'builder') {
      score += builders < 1 ? 24 : builders < 2 ? 4 : -12;
    }
    // 高级对单价更敏感一点：便宜的兵能多铺几个方向。
    // 但高时代单位要单独放宽——它们贵是设计如此，不该因此永远排在火枪兵后面。
    const perGold = aiLevelOf(s) === 'advanced' ? 0.035 : 0.05;
    score -= price * (d.era >= 4 ? perGold * 0.6 : perGold);

    // 军营是前线补给点：在军营出兵有额外价值（省了从后方跑一趟）
    if (src.kind === 'camp') score += 6;

    if (traits.favorites.includes(d.id)) score += 9;
    // 高级的随机幅度更小：选择更"有主意"，不会因为噪声去造一个明显不合适的兵
    score += (aiNoise(s, d.id.length * 31 + d.id.charCodeAt(0)) - 0.5) * (aiLevelOf(s) === 'advanced' ? 4 : 8);

    // 指挥官点名的兵种优先落地。
    // 产兵是这个模式里玩家唯一的杠杆，必须赶在 AI 把钱花到建筑/升级之前执行，
    // 否则"我排了三个坦克，一个都没出来"——而且玩家看不出是被什么吃掉的。
    if (order && d.id === order) score += 240;

    const action: Action =
      src.kind === 'camp'
        ? { type: 'RECRUIT', unitId: src.id, unitType: d.id }
        : { type: 'RECRUIT', cityId: src.id, unitType: d.id };

    if (!best || score > best.score) best = { action, score };
  }
  return best;
}

function upgradeCandidate(s: GameState, city: City): Candidate | null {
  const cost = upgradeCostOf(s, city);
  if (cost === null) return null;
  const gold = s.players[s.current].gold;
  if (gold < cost) return null;

  // 留足造兵的钱再考虑升级，否则会变成裸城升级
  const spare = gold - cost;

  // 阈值按"造价的相对比例"算，别写死绝对值——时代费用调过一轮之后，
  // 写死 100/40 等于让 AI 永远觉得"余钱很充裕"。
  const rich = cost * 0.35;
  const okay = cost * 0.15;
  let score = (spare > rich ? 88 : spare > okay ? 52 : 14) + (aiNoise(s, 9001) - 0.5) * 20;

  // 落后就要补课：对面时代比我高的时候，升级的紧迫感是加倍的。
  // 没有这一条，AI 会一直"先造兵、兵造不完"，永远追不上对面的科技。
  const foe = citiesOf(s, other(city.owner));
  const myEra = Math.max(...citiesOf(s, city.owner).map((c) => c.era));
  const foeEra = foe.length > 0 ? Math.max(...foe.map((c) => c.era)) : myEra;
  if (foeEra > myEra) score += 26;

  return { action: { type: 'UPGRADE', cityId: city.id }, score };
}

/**
 * 给"计划里的兵"找一格空位。
 *
 * 排序列时需要把已经排进去的兵当成"已经在场"来算下一步（否则五格会全是同一种兵：
 * 每一格看到的都是"我还没有它"）。但我们不能真的改局面，所以在投影状态里塞幽灵单位。
 *
 * 幽灵必须放在**能站人的空地**上，而且不能占住城市的产兵格、也不能挨着军营
 * （那两处正是 recruitCandidate 数可用格子的地方）——不然排到第三格就会被自己堵死。
 * 找不到就退回 (0,0)，最坏情况只是这几格的打分少了"拥挤度"这一项。
 */
function ghostSpot(s: GameState): { x: number; y: number } {
  const blocked = new Set<string>();
  for (const c of s.cities) {
    for (const t of cityTiles(c)) blocked.add(`${t.x},${t.y}`);
  }
  for (const u of s.units) {
    if (!utype(s, u.type).barracks) continue;
    for (const [dx, dy] of DIRS) blocked.add(`${u.x + dx},${u.y + dy}`);
  }
  for (let y = 0; y < s.h; y++) {
    for (let x = 0; x < s.w; x++) {
      const t = tileAt(s, x, y);
      if (!t || !passable(t.terrain)) continue;
      if (blocked.has(`${x},${y}`)) continue;
      if (unitAt(s, x, y)) continue;
      return { x, y };
    }
  }
  return { x: 0, y: 0 };
}

/**
 * 指挥官模式下 AI 自己排生产序列。
 *
 * 为什么 AI 也得排：这个模式里"造什么"是唯一的策略表达。让 AI 一回合一个兵地临时决定，
 * 它只会做局部最优（谁划算造谁），既不会为"下一级兵"攒三个回合的钱，也不会提前铺经济——
 * 那不算"没有序列"，那等于这个模式对 AI 根本不存在，人机对局也就没什么可博弈的。
 *
 * 排 5 格真正的含义是**把代价摆出来**：每一格都是"这一回合不造别的"。
 * 所以下面每一格的打分都必须看得见前面几格的产出（用一个投影状态累加），
 * 否则它会把五个格全排成同一种兵。
 *
 * 只看得到的东西（调用方传 playerView 的结果），不看全图。
 */
export function planOrders(s: GameState, player: PlayerId = s.current): string[] {
  const slots: string[] = [];
  if (citiesOf(s, player).length === 0) return slots;

  // 投影：序列是"未来几回合"的事，所以每排一格都要把这一格的产出记进去
  const proj: GameState = {
    ...s,
    current: player,
    cities: s.cities.map((c) => ({ ...c })),
    units: [...s.units],
    players: { A: { ...s.players.A }, B: { ...s.players.B } },
  };
  const traits = aiTraits(proj);
  // 每格大约能收到这么多钱（打九折：收入会随城市被打、单位被杀而掉）
  const perTurn = Math.max(1, Math.round(incomeOf(s, player) * 0.9));
  // 一格拿来升级 = 五个回合里少一个兵，排两次基本等于自杀
  let upgradesLeft = 1;

  for (let i = 0; i < CONFIG.commanderSlots; i++) {
    // 这一格是"下一回合"的产线，那时候还会进一笔收入
    if (i > 0) proj.players[player].gold += perTurn;

    let bestRecruit: Candidate | null = null;
    for (const city of citiesOf(proj, player)) {
      if (city.capturedTurn === proj.turn) continue;
      const c = recruitCandidate(
        proj,
        { kind: 'city', id: city.id, x: city.x, y: city.y, era: city.era },
        traits,
        null,
      );
      if (c && (!bestRecruit || c.score > bestRecruit.score)) bestRecruit = c;
    }

    let bestUpgrade: { c: Candidate; city: City } | null = null;
    if (upgradesLeft > 0) {
      for (const city of citiesOf(proj, player)) {
        const c = upgradeCandidate(proj, city);
        if (c && (!bestUpgrade || c.score > bestUpgrade.c.score)) bestUpgrade = { c, city };
      }
    }

    // 升级要多让 6 分才划算：它占掉的是"这回合一个兵"的名额，
    // 只有真的宽裕、或者科技落后到必须补，才值得插进序列。
    if (bestUpgrade && (!bestRecruit || bestUpgrade.c.score > bestRecruit.score + 6)) {
      slots.push(ORDER_UPGRADE);
      upgradesLeft -= 1;
      const cost = upgradeCostOf(proj, bestUpgrade.city);
      if (cost !== null) {
        proj.players[player].gold = Math.max(0, proj.players[player].gold - cost);
        bestUpgrade.city.era += 1;
      }
      continue;
    }

    if (!bestRecruit) break;
    const recruit = bestRecruit.action;
    if (recruit.type !== 'RECRUIT') break;
    const type = recruit.unitType;
    const def = proj.unitTypes[type];
    slots.push(type);
    if (!def) break;
    // 记进投影：这个兵"已经在场"，下一格看到的是补完之后的composition
    const spot = ghostSpot(proj);
    proj.units.push({
      id: `plan-${i}`,
      type,
      owner: player,
      x: spot.x,
      y: spot.y,
      hp: def.maxHp,
      kills: 0,
      moved: true,
      acted: true,
    });
    payRes(proj.players[player], recruitResCost(proj, player, def));
  }

  return slots;
}

/**
 * AI 的下一步。返回 null 表示它认为这一回合没有值得做的事了。
 *
 * 调用方负责真正执行 action 并循环调用，直到拿到 null 再结束回合。
 */
export function aiNextAction(s: GameState, budget: AiBudget = DEFAULT_BUDGET): Action | null {
  if (s.winner) return null;

  const me = s.current;
  // 关键：只看自己看得见的东西，跟玩家同等信息
  const view = playerView(s, me).state;

  /**
   * 指挥官模式：产线和升级都由序列决定，所以调用方给的 maxRecruit / maxUpgrade
   * 让位给"队首是什么"——这样不管谁在调 AI（界面层、bench、跑批），
   * 这个模式的规则都只有一份。
   */
  const commander = s.config.commanderMode === true;
  const head = commander ? (ordersOf(s, me)[0] ?? '') : '';
  // 没序列就先自己排一条。注意两点：
  //   1. 不是"没序列就自由产兵"——那等于这个模式对 AI 不存在，人机对局也就没有排产这层博弈。
  //   2. 只在**这一方真的由 AI 托管**时才代排。玩家自己打这个模式时，空序列是他"这回合不造"
  //      的选择，AI 替他把序列填满就等于替他做决定。
  if (commander && head === '' && isAiSide(s, me)) {
    const plan = planOrders(view, me);
    if (plan.length > 0) return { type: 'SET_ORDERS', queue: plan };
  }
  /** 这一回合点名的兵种（不在指挥官模式下就是调用方给的临时指令） */
  const order = commander ? (head === '' || head === ORDER_UPGRADE ? null : head) : (budget.order ?? null);
  // 指挥官模式的产能是「每回合 1 个」：队首是兵种**并且**这回合还没造过。
  // 只砍到"看队首"是不够的——一回合里 AI 会反复问下一步，队首没变就会连着造好几个。
  const mayRecruit = commander
    ? head !== '' && head !== ORDER_UPGRADE && budget.recruited < 1
    : budget.recruited < budget.maxRecruit;
  const mayUpgrade = commander ? head === ORDER_UPGRADE && budget.upgraded < 1 : budget.upgraded < budget.maxUpgrade;

  // 蛋还等着落位：先处理掉。不处理的话这一方会一直卡在"等你选蛋"上，
  // 而 rules 层虽然会在结束回合时兜底，但那是"最后手段"，位置是随机凑合的。
  if (s.pendingEgg && s.pendingEgg.owner === me) {
    const spot = eggPlacement(view, me);
    if (spot) return { type: 'PLACE_EGG', x: spot.x, y: spot.y };
  }

  const candidates: Candidate[] = [];
  // 两套地形代价图（陆军 / 水军）算一次，本回合所有单位共用
  const land = distanceFields(view, me);
  // 主攻方向：血最少的那座敌方城市（同血时取离我军最近的）
  //
  // 注释一直写着"同血时取最近的"，但代码其实没做这件事：四座城都是满血时，
  // 它会锁死列表里的第一座——大地图上那座很可能在图的对角，
  // 全军就朝着那个方向开拔，近处那座永远没人管。
  const nearestOwn = (c: City): number =>
    view.units
      .filter((u) => u.owner === me)
      .reduce((m, u) => Math.min(m, distToCity(u, c)), Infinity);
  const foeCities = view.cities.filter((c) => c.owner !== me);
  const focus = foeCities.reduce<City | null>((best, c) => {
    if (!best) return c;
    if (c.hp !== best.hp) return c.hp < best.hp ? c : best;
    return nearestOwn(c) < nearestOwn(best) ? c : best;
  }, null);

  const fields: Fields = {
    land,
    water: distanceFields(view, me, true),
    bridgeSite: bestBridgeSite(view, me, land),
    focusCityId: focus?.id ?? null,
    needBridge: !canReachEnemyByLand(view, me),
  };
  const traits = aiTraits(view);

  for (const u of unitsOf(view, me)) {
    candidates.push(...unitCandidates(view, u, fields, traits, s));
    const skill = heroSkillCandidate(view, u);
    if (skill) candidates.push(skill);
  }

  if (mayRecruit) {
    for (const city of citiesOf(view, me)) {
      // 刚打下来的城当回合不产兵（rules 里同一条），提出来只会得到非法动作
      if (city.capturedTurn === s.turn) continue;
      // 废墟也造不出兵（规则里同样会拒）。不跳过的话 AI 会一直提这个动作，
      // 而它一旦被选中就必然失败——那一回合剩下的动作全被吞掉。
      if (city.ruined) continue;
      const c = recruitCandidate(
        view,
        { kind: 'city', id: city.id, x: city.x, y: city.y, era: city.era },
        traits,
        order,
      );
      if (c) candidates.push(c);
    }
    // 军营：跟城市一样能出兵，时代取最近的己方城市
    const own = citiesOf(view, me);
    if (own.length > 0) {
      for (const u of unitsOf(view, me)) {
        if (!utype(view, u.type).barracks) continue;
        const era = own.reduce((a, b) => (distToCity(u, a) <= distToCity(u, b) ? a : b)).era;
        const c = recruitCandidate(view, { kind: 'camp', id: u.id, x: u.x, y: u.y, era }, traits, order);
        if (c) candidates.push(c);
      }
    }
  }

  if (mayUpgrade) {
    for (const city of citiesOf(view, me)) {
      if (city.ruined) continue; // 废墟升不了级，同上
      const c = upgradeCandidate(view, city);
      if (c) candidates.push(c);
    }
  }

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.score - a.score);

  const best = candidates[0];
  if (!best || best.score <= 0) return null;

  // 在"和最优咬得很紧"的候选里随机挑一个：
  // 战棋里很多选择的评分本来就在伯仲之间（左翼还是右翼、先打哪个），
  // 永远挑第一个会让每一局都变成同一盘棋。
  //
  // 高级的带宽更窄：同分候选少挑几个，出手更集中在最优解上。
  // 但也不能压到 0——完全没有随机的话，每局都会变成同一盘棋。
  const band =
    aiLevelOf(s) === 'advanced'
      ? Math.max(4, Math.abs(best.score) * 0.12)
      : Math.max(6, Math.abs(best.score) * 0.25);
  const tied = candidates.filter((c) => c.score > 0 && best.score - c.score <= band);
  if (tied.length > 1) {
    const pick = tied[Math.floor(aiNoise(s) * tied.length)];
    if (pick) return pick.action;
  }
  return best.action;
}

/** 这一回合 AI 大致的行动次数上限，防止它无限循环 */
export const AI_MAX_STEPS = 50;

/**
 * 这一方现在是 AI 在走吗？
 *
 * 配置（aiOpponent / aiAlly）只决定开局时谁托管，
 * 对局中途要能随时改——调平衡的时候"我这回合自己走、下回合交给它"是常态。
 * 所以运行时的 aiControl 优先，没设置过才回落到配置。
 */
export function isAiSide(s: GameState, p: PlayerId): boolean {
  const override = s.aiControl?.[p];
  if (override !== undefined) return override;
  return p === 'B' ? s.config.aiOpponent : s.config.aiAlly;
}

/** 有一方是 AI 就不需要"把设备交给对方"的遮罩了 */
export function anyAiSide(s: GameState): boolean {
  return isAiSide(s, 'A') || isAiSide(s, 'B');
}
