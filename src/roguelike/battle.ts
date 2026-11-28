/**
 * 肉鸽与规则层之间的唯一适配层。
 *
 * **一关 = 一份「关卡」（`core/level.ts` 的 LevelDef）**，交给 `createMatch` 建局。
 * 这不是我们自己另起的机制，而是引擎本来就有、剧情关在用的一套：
 * 固定地图 + 席位（谁没城、谁托管）+ 开局部署 + 开局时代。
 *
 * 这么做换来三件事（都是踩过的坑）：
 *   1. **无城关卡天然成立**：`seats.cityless` 就是"兵打光即出局"，
 *      不用再去改 `isEliminated`，也不会出现"第 1 回合玩家被判负"。
 *   2. **地形完全可控**：不再靠 `mapStyle` 抽——抽出来的图有一半是水，
 *      陆地策略全得绕路。现在是"平原为主、少量林丘"，格子是我们自己写的。
 *   3. **开局编队精确**：每个兵站哪一格由我们定，不再"围着城撒一圈"。
 *
 * 我们**不碰规则层任何一行**：`createMatch` / `applyAction` / `ai.ts` 都是现成接口。
 */
import { UNIT_TYPES } from '../core/config.ts';
import { applyAction } from '../core/rules.ts';
import { createMatch, DEFAULT_CONFIG } from '../core/setup.ts';
import type { LevelDef } from '../core/level.ts';
import type { Action, GameState, PlayerId, Unit, UnitTypeDef } from '../core/types.ts';
import type { ArmyEntry, BattleInit, BattleResult } from './types.ts';
import { makeRng } from './rng.ts';

const VARIANT = 'rg:';

/** 变体兵种的 id 里带着原始兵种 */
function baseTypeOf(type: string): string {
  if (!type.startsWith(VARIANT)) return type;
  return type.slice(VARIANT.length).split('@')[0] as string;
}

/** 给我军注册"带加成"的兵种变体，返回变体 id */
function variantOf(
  s: GameState,
  type: string,
  atk: number,
  move: number,
  armor: number,
  hp: number,
): string {
  if (atk === 0 && move === 0 && armor === 0 && hp === 0) return type;
  const def = s.unitTypes[type];
  if (!def) return type;
  const id = `${VARIANT}${type}@${atk}@${move}@${armor}@${hp}`;
  if (!s.unitTypes[id]) {
    const clone: UnitTypeDef = {
      ...def,
      id,
      atk: Math.max(0, def.atk + atk),
      move: Math.max(0, def.move + move),
      armor: Math.max(0, def.armor + armor),
      maxHp: Math.max(1, def.maxHp + hp),
    };
    s.unitTypes[id] = clone;
  }
  return id;
}

// ------------------------------------------------------------------ 地图

interface Cell {
  x: number;
  y: number;
}

/**
 * 出一张"平原为主"的小图。
 *
 * 比例是照手感定的：**平原 ≈ 80%，森林 ≈ 14%，丘陵 ≈ 6%，没有水、没有山**。
 * 水只在海军开局才有意义（那时该单独出一张多水的图），而肉鸽 2.0 现在三个方略
 * 都是陆军——为不存在的海军留一条河，代价是所有人都得绕路。
 */
function makeRows(w: number, h: number, seed: number): string[] {
  const rng = makeRng(seed ^ 0x9e3779b1);
  const rows: string[][] = [];
  for (let y = 0; y < h; y += 1) {
    const row: string[] = [];
    for (let x = 0; x < w; x += 1) {
      const r = rng.next();
      // 中间三行强制平原：那是双方接敌的地方，不该被林子卡住
      const mid = Math.abs(y - (h - 1) / 2) <= 1;
      row.push(mid ? '.' : r < 0.8 ? '.' : r < 0.94 ? 'f' : 'h');
    }
    rows.push(row);
  }
  return rows.map((r) => r.join(''));
}

/** 地图上已经占掉的格（城） */
function blockedSet(cities: Cell[], citySize: number): Set<string> {
  const out = new Set<string>();
  for (const c of cities) {
    for (let dy = 0; dy < citySize; dy += 1) {
      for (let dx = 0; dx < citySize; dx += 1) out.add(`${c.x + dx},${c.y + dy}`);
    }
  }
  return out;
}

/**
 * 从锚点往外找 n 个空位（一圈一圈找，圈内按种子打乱）。
 *
 * 锚点是**我们自己定的阵位**，所以同一种编成每局站出来的阵型是稳定的，
 * 玩家能记住"我的弓手在哪一排"。
 */
function pickCells(
  w: number,
  h: number,
  rows: string[][],
  blocked: Set<string>,
  anchor: Cell,
  n: number,
  seed: number,
): Cell[] {
  const rng = makeRng(seed ^ 0x2545f491);
  const out: Cell[] = [];
  for (let r = 0; r <= Math.max(w, h) && out.length < n; r += 1) {
    const ring: Cell[] = [];
    for (let dy = -r; dy <= r; dy += 1) {
      for (let dx = -r; dx <= r; dx += 1) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = anchor.x + dx;
        const y = anchor.y + dy;
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        if (blocked.has(`${x},${y}`)) continue;
        if (rows[y]?.[x] === '~' || rows[y]?.[x] === '^') continue;
        ring.push({ x, y });
      }
    }
    rng.shuffle(ring);
    for (const cell of ring) {
      if (out.length >= n) break;
      blocked.add(`${cell.x},${cell.y}`);
      out.push(cell);
    }
  }
  return out;
}

/** 把一支军队摊成"兵种 ×1"的清单（部署是按个写的） */
function flatten(army: ArmyEntry[]): string[] {
  const out: string[] = [];
  for (const a of army) for (let i = 0; i < a.count; i += 1) out.push(a.type);
  return out;
}

/**
 * 造这一关。
 *
 * 席位与城：
 *   · **A 永远没有城**（前三层玩家没有城，这是设计，不是省事）；
 *   · 遭遇 / 精英：B 也没有城 → 双方都按"兵打光算输"；
 *   · 攻坚 / 层末：B 有 1–2 座城 → 玩家要啃城，B 丢了城才算输。
 */
function makeLevel(init: BattleInit): LevelDef {
  const w = init.size;
  const h = init.size;
  const grid = makeRows(w, h, init.seed).map((r) => [...r]);

  // ---- 敌方的城 ----
  const citiesB: Cell[] = [];
  if (init.enemyCityCount > 0) {
    citiesB.push({ x: Math.max(0, Math.floor(w / 2) - 1), y: 0 });
    if (init.enemyCityCount > 1) citiesB.push({ x: Math.max(0, w - 3), y: Math.max(0, h - 3) });
  }
  const blocked = blockedSet(citiesB, 2);

  // ---- 阵位 ----
  const playerAnchor: Cell = { x: Math.floor(w / 2), y: h - 2 };
  const enemyAnchor: Cell = citiesB[0]
    ? { x: (citiesB[0] as Cell).x + 1, y: (citiesB[0] as Cell).y + 3 }
    : { x: Math.floor(w / 2), y: 1 };

  const playerFlat = flatten([...init.playerArmy, ...init.tempUnits]);
  const enemyFlat = init.enemyTypes;
  const playerCells = pickCells(w, h, grid, blocked, playerAnchor, playerFlat.length, init.seed ^ 0x1234);
  const enemyCells = pickCells(w, h, grid, blocked, enemyAnchor, enemyFlat.length, init.seed ^ 0x5678);

  // 站人的格子一律铺平：阵型不该被一丛树卡出个缺口
  for (const c of [...playerCells, ...enemyCells]) grid[c.y]![c.x] = '.';

  const deployA = playerFlat.map((type, i) => {
    const cell = playerCells[i] ?? playerAnchor;
    return { type, x: cell.x, y: cell.y };
  });
  const deployB = enemyFlat.map((type, i) => {
    const cell = enemyCells[i] ?? enemyAnchor;
    return { type, x: cell.x, y: cell.y };
  });

  const noCity: PlayerId[] = init.enemyCityCount > 0 ? ['A'] : ['A', 'B'];
  const id = `rogue2:${init.layer}:${init.kind}:${init.seed}`;

  return {
    id,
    version: 1,
    name: `${init.label} · ${init.sub}`.slice(0, 24),
    map: {
      id: `${id}:map`,
      name: `肉鸽 2.0 · ${init.size}×${init.size}`,
      w,
      h,
      rows: grid.map((r) => r.join('')),
      citiesA: [],
      citiesB,
    },
    seats: { count: 2, ai: ['B'], cityless: noCity },
    deploy: { A: deployA, B: deployB },
    setup: { startEra: init.cityEra, firstSide: 'A' },
  };
}

/**
 * 摆阵：**射程越远越靠后，跑得快的站两翼**。
 *
 * 只在已经分好的站位之间重新分配"谁站哪"——不重新挑格子。
 * 这样不会踩到城/水/山，也不会把谁挤出地图，改变的只是排布。
 *
 * 为什么需要：`pickCells` 是"从锚点一圈圈往外撒、圈内随机"。随机的结果是远程
 * 常常被摆在最前面、近战缩在最后一排——每次开局第一件事就是把自己人挪一遍。
 * 阵型是玩家一眼要看懂的东西，不该掷骰子决定。
 */
function arrangeFormation(s: GameState, owner: PlayerId, toward: -1 | 1): void {
  const units = s.units.filter((u) => u.owner === owner && u.hp > 0);
  if (units.length < 3) return; // 两三个人怎么站都一样

  const cells = units.map((u) => ({ x: u.x, y: u.y }));
  const cx = cells.reduce((n, c) => n + c.x, 0) / cells.length;
  const cy = cells.reduce((n, c) => n + c.y, 0) / cells.length;
  /** 越大越靠后（远离敌人） */
  const back = (c: { x: number; y: number }): number => (c.y - cy) * -toward;
  /** 越大越靠边 */
  const wing = (c: { x: number; y: number }): number => Math.abs(c.x - cx);

  const want = (u: Unit): { back: number; mobile: boolean } => {
    const def = s.unitTypes[u.type];
    const range = def?.range ?? 1;
    const move = def?.move ?? 3;
    // 0 = 贴敌，1 = 中排，2 = 最后排
    return { back: range >= 3 ? 2 : range >= 2 ? 1 : 0, mobile: range <= 1 && move >= 4 };
  };

  // 前排的格子给近战，后排的给远程；同一排里最外侧的给跑得快的
  const bySlot = [...cells].sort((a, b) => back(a) - back(b) || wing(b) - wing(a));
  const byUnit = [...units].sort((a, b) => {
    const pa = want(a);
    const pb = want(b);
    return pa.back - pb.back || Number(pb.mobile) - Number(pa.mobile);
  });

  byUnit.forEach((u, i) => {
    const c = bySlot[i];
    if (!c) return;
    u.x = c.x;
    u.y = c.y;
  });
}

/**
 * 造一场战斗。
 *
 * 所有"这一关长什么样"的信息都塞进 LevelDef，交给 `createMatch` 去建；
 * 建完之后只做两件它管不了的事：套我方加成（变体兵种）与盖金币。
 */
export function buildBattle(init: BattleInit): GameState {
  const level = makeLevel(init);
  const allUnits = Object.values(UNIT_TYPES)
    .filter((d) => d.category === 'combat' && d.domain !== 'water')
    .map((d) => d.id);

  const s = createMatch(
    {
      ...DEFAULT_CONFIG,
      size: init.size,
      startEra: init.era,
      playerCount: 2,
      aiOpponent: true,
      aiLevel: 'advanced',
      expansionIds: init.expansions,
      enabledUnits: allUnits,
      disabledUnits: [],
      level,
      aiDoctrine: init.enemyDoctrine,
      aiDoctrineSeat: 'B',
    },
    init.seed,
    {},
  );

  /*
   * 关掉迷雾。
   *
   * 无城关卡里 AI 没有"敌方城市"这个方向来源，`setup.ts` 里那条实测注释写得很清楚：
   * 没城又开雾，两排兵能站到第 80 回合谁都不动。我们的小图也就 8~18 格宽，
   * 全亮反而更像"短兵相接"。
   */
  s.fog = false;

  /*
   * ---- 摆阵 ----
   *
   * 两边的锚点都在 `makeLevel` 里定好了（A 在下、B 在上），所以朝向按
   * 双方的 y 均值判：谁在下面谁朝上打。判出来的方向交给 `arrangeFormation`，
   * 它负责"近战在前、远程在后、快兵在两翼"。
   */
  const aUnits = s.units.filter((u) => u.owner === 'A');
  const bUnits = s.units.filter((u) => u.owner === 'B');
  if (aUnits.length > 0 && bUnits.length > 0) {
    const avgY = (list: Unit[]): number => list.reduce((n, u) => n + u.y, 0) / list.length;
    const aDown = avgY(aUnits) > avgY(bUnits);
    arrangeFormation(s, 'A', aDown ? -1 : 1);
    arrangeFormation(s, 'B', aDown ? 1 : -1);
  }

  // ---- 我方加成（变体兵种）----
  /*
   * 我军加成：攻击 / 护甲 / 生命 / 移动。
   *
   * `unitTypes` 是全图共用的一张表，所以不能直接把 +1 写进去（敌人也会变强）；
   * 给每个兵注册一个带后缀的**变体兵种**，只有我军用变体 id。
   */
  const moveUp = init.bonusMove;
  for (const u of s.units) {
    if (u.owner !== 'A') continue;
    const def = s.unitTypes[u.type];
    let atk = init.bonusAtk;
    if (init.strategyId === 'skirmish' && def && def.range >= 3) atk += 2;
    u.type = variantOf(s, u.type, atk, moveUp, init.bonusArmor, init.bonusHp);
    const v = s.unitTypes[u.type];
    if (v) u.hp = v.maxHp;
  }

  // ---- 火药桶 / 工兵破墙：敌城开场就带伤 ----
  if (init.cityDamage > 0) {
    for (const city of s.cities) {
      if (city.owner === 'A') continue;
      city.hp = Math.max(1, Math.round(city.hp * (1 - Math.min(0.8, init.cityDamage))));
    }
  }

  s.players.A.gold = init.playerGold;
  s.players.B.gold = init.enemyGold;
  s.log.push({ turn: 1, player: 'A', text: `肉鸽 2.0：${init.label}（${init.sub}）` });
  return s;
}

export function outcomeOf(s: GameState): 'win' | 'lose' | null {
  if (s.winner) return s.winner === 'A' ? 'win' : 'lose';
  // 同归于尽：checkWinner 判平局（winner 留在 null），这里按"没打赢"处理
  const alive = (p: PlayerId): number => s.units.filter((u) => u.owner === p && u.hp > 0).length;
  if (alive('A') === 0 && alive('B') === 0) return 'lose';
  return null;
}

/** 幸存的我军（变体 id 还原成原始兵种，跨层只带兵种和数量） */
export function survivorsOf(s: GameState): ArmyEntry[] {
  const map = new Map<string, number>();
  for (const u of s.units) {
    if (u.owner !== 'A' || u.hp <= 0) continue;
    const base = baseTypeOf(u.type);
    map.set(base, (map.get(base) ?? 0) + 1);
  }
  return [...map.entries()].map(([type, count]) => ({ type, count }));
}

export function resultOf(s: GameState, win: boolean): BattleResult {
  return { win, survivors: survivorsOf(s), gold: s.players.A.gold, turns: s.turn };
}

/** 应用一个动作；失败时原样返回，调用方决定是提示还是重试 */
export function step(s: GameState, action: Action): { state: GameState; ok: boolean; reason?: string } {
  const r = applyAction(s, action);
  if (!r.ok) return { state: s, ok: false, reason: r.reason };
  return { state: r.state, ok: true };
}
