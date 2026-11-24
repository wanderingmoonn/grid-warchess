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
import { CULTIVATORS } from './data.ts';
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
    /*
     * 圈内排序：**先横后竖**（|dy| 小的优先，同排里 |dx| 大的优先），
     * 再拿种子打散同分。
     *
     * 之前是纯随机，围出来的常常是个 3×3 的团——团里没有"最外侧"，
     * 骑兵就只能被裹在中间。先横后竖会让阵型铺成一条宽线，
     * 两翼才有地方站。
     */
    const jitter = new Map<string, number>();
    for (const c of ring) jitter.set(`${c.x},${c.y}`, rng.next());
    ring.sort(
      (a, b) =>
        Math.abs(a.y - anchor.y) - Math.abs(b.y - anchor.y) ||
        Math.abs(b.x - anchor.x) - Math.abs(a.x - anchor.x) ||
        (jitter.get(`${a.x},${a.y}`) ?? 0) - (jitter.get(`${b.x},${b.y}`) ?? 0),
    );
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
function makeLevel(init: BattleInit): { level: LevelDef; cellsA: Cell[]; cellsB: Cell[] } {
  const w = init.size;
  const h = init.size;
  const grid = makeRows(w, h, init.seed).map((r) => [...r]);

  // ---- 敌方的城 ----
  const citiesB: Cell[] = [];
  if (init.enemyCityCount > 0) {
    citiesB.push({ x: Math.max(0, Math.floor(w / 2) - 1), y: 0 });
    /*
     * 第二座城也放在上边，和第一座并成一道墙。
     *
     * 以前放在右下角，结果它离玩家的出生点只有两三格——玩家一睁眼就站在
     * 敌人一座城旁边，而 AI 眼里只有"第一座城"，会掉头往北走。两座城排成
     * 一条线，才是"你要从下面打上来"的样子。
     */
    if (init.enemyCityCount > 1) citiesB.push({ x: Math.max(0, w - 5), y: 0 });
  }
  const blocked = blockedSet(citiesB, 2);

  // ---- 阵位 ----
  const playerAnchor: Cell = { x: Math.floor(w / 2), y: h - 2 };
  const enemyAnchor: Cell = citiesB[0]
    ? { x: (citiesB[0] as Cell).x + 1, y: (citiesB[0] as Cell).y + 3 }
    : { x: Math.floor(w / 2), y: 1 };

  const playerFlat = flatten([...init.playerArmy, ...init.tempUnits]);
  const enemyFlat = init.enemyTypes;
  /*
   * 多要几个格子当"余量"。
   *
   * `pickCells` 只找够用的格子，围出来的是一个 3×3 的团；团里没有"最外侧"，
   * 骑兵就只能被裹在中间。多要 6 个，阵型才铺得开——摆阵那一步会把用不上的
   * 空着，代价只是多几格平地。
   */
  const SLACK = 6;
  const playerCells = pickCells(w, h, grid, blocked, playerAnchor, playerFlat.length + SLACK, init.seed ^ 0x1234);
  const enemyCells = pickCells(w, h, grid, blocked, enemyAnchor, enemyFlat.length + SLACK, init.seed ^ 0x5678);

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

  const level: LevelDef = {
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
  return { level, cellsA: playerCells, cellsB: enemyCells };
}

/**
 * 摆阵：**射程越远越靠后，跑得快的站两翼**。
 *
 * 只在已经分好的站位之间重新分配"谁站哪"——不重新挑格子。
 * 这样不会踩到城/水/山，也不会把谁挤出地图，改变的只是排布。
 *
 * 做法是给每个兵一个"目标位置"（离敌人多近、离中线多远），再按
 * **远程 → 快兵 → 近战** 的顺序抢格子：远程最挑位置（只有后排那几个），
 * 快兵要最外侧，最后剩下的给普通近战。
 *
 * 上一版只按"近战/远程"分两档、同一档里按 y 排，结果骑兵经常被裹在阵中间
 * ——因为它和民兵一样都是近战，只是排得早一点，而"排得早"不等于"站边上"。
 */
function arrangeFormation(s: GameState, owner: PlayerId, toward: -1 | 1, slots: Cell[]): void {
  const units = s.units.filter((u) => u.owner === owner && u.hp > 0);
  if (units.length < 3) return; // 两三个人怎么站都一样

  // 候选格：部署时多要的那几个也算进来，阵型才铺得开
  const cells = slots.length >= units.length ? slots : units.map((u) => ({ x: u.x, y: u.y }));
  const cx = cells.reduce((n, c) => n + c.x, 0) / cells.length;
  const cy = cells.reduce((n, c) => n + c.y, 0) / cells.length;
  /** 越大越靠后（远离敌人） */
  const backOf = (c: { x: number; y: number }): number => (c.y - cy) * -toward;
  /** 越大越靠边 */
  const wingOf = (c: { x: number; y: number }): number => Math.abs(c.x - cx);

  const minBack = Math.min(...cells.map(backOf));
  const maxBack = Math.max(...cells.map(backOf));
  const maxWing = Math.max(...cells.map(wingOf), 1);
  /** 归一化：0 = 最靠前 / 最靠中路，1 = 最靠后 / 最靠边 */
  const nb = (c: { x: number; y: number }): number => (backOf(c) - minBack) / Math.max(1e-6, maxBack - minBack);
  const nw = (c: { x: number; y: number }): number => wingOf(c) / Math.max(1e-6, maxWing);

  type Role = 'ranged' | 'mobile' | 'melee';
  const roleOf = (u: Unit): Role => {
    const def = s.unitTypes[u.type];
    if ((def?.range ?? 1) >= 3) return 'ranged';
    // 移速 3 就是"能绕侧"的那一档（骑士是 3、骠骑/斥候/装甲车是 4~5），
    // 线列步兵和炮是 2。用 4 当门槛会把骑士漏在阵中间。
    if ((def?.move ?? 3) >= 3) return 'mobile';
    return 'melee';
  };
  /** 目标位置：远程最后排、快兵最外侧、近战最前排；三者都尽量靠中路 */
  const target: Record<Role, { b: number; w: number }> = {
    ranged: { b: 1, w: 0.15 },
    mobile: { b: 0.25, w: 1 },
    melee: { b: 0, w: 0.15 },
  };
  const priority: Record<Role, number> = { ranged: 0, mobile: 1, melee: 2 };

  const taken = new Set<number>();
  const order = [...units].sort((a, b) => priority[roleOf(a)] - priority[roleOf(b)]);
  /** 快兵左右交替：第 1 个去左翼、第 2 个去右翼，不然两个骑兵会挤在同一边 */
  let mobileSeq = 0;
  for (const u of order) {
    const role = roleOf(u);
    const t = target[role];
    const side = role === 'mobile' ? (mobileSeq++ % 2 === 0 ? -1 : 1) : 0;
    let best = -1;
    let bestScore = Infinity;
    cells.forEach((c, i) => {
      if (taken.has(i)) return;
      // 横向（侧翼）权重更高：它是"谁在两翼"这件事的主轴
      const lateral = side === 0 ? nw(c) : ((c.x - cx) * side) / maxWing;
      // 快兵对"前后"最不挑：只要在两翼，站哪一排都行
      const wBack = role === 'mobile' ? 0.35 : 1;
      const score = (nb(c) - t.b) ** 2 * wBack + (lateral - t.w) ** 2 * 1.6;
      if (score < bestScore) {
        bestScore = score;
        best = i;
      }
    });
    if (best < 0) continue;
    taken.add(best);
    const c = cells[best] as { x: number; y: number };
    u.x = c.x;
    u.y = c.y;
  }
}

/**
 * 造一场战斗。
 *
 * 所有"这一关长什么样"的信息都塞进 LevelDef，交给 `createMatch` 去建；
 * 建完之后只做两件它管不了的事：套我方加成（变体兵种）与盖金币。
 */
export function buildBattle(init: BattleInit): GameState {
  const { level, cellsA, cellsB } = makeLevel(init);
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
   * ---- 修真：境界加成（简化口径） ----
   *
   * 完整的修炼要有真元、法术、经验与突破，demo 不跑那一套；这里按时代钟
   * 给修士一个固定的攻/血加成，等价于"开局就已经是筑基/金丹"。
   * 只加人，不加法器（法器不是人，没有境界）。
   *
   * 注意加的是**本局私有的兵种表**（`createMatch` 每局复制一份），
   * 所以两边同享、不会污染别的局。
   */
  if (init.rank > 0) {
    for (const id of Object.keys(s.unitTypes)) {
      if (!CULTIVATORS.has(id)) continue;
      const def = s.unitTypes[id];
      if (!def) continue;
      def.atk += init.rank * 3;
      def.maxHp += init.rank * 8;
    }
    for (const u of s.units) {
      if (!CULTIVATORS.has(u.type)) continue;
      u.hp = s.unitTypes[u.type]?.maxHp ?? u.hp;
    }
  }

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
    arrangeFormation(s, 'A', aDown ? -1 : 1, cellsA);
    arrangeFormation(s, 'B', aDown ? 1 : -1, cellsB);
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
