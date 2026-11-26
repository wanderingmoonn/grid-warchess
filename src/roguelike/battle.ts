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
import { CULTIVATORS, DEFENSE_UNIT_DEFS, growthOf } from './data.ts';
import { makeRng } from './rng.ts';

const VARIANT = 'rg:';

/** 变体兵种的 id 里带着原始兵种 */
export function baseTypeOf(type: string): string {
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
function makeLevel(init: BattleInit): {
  level: LevelDef;
  cellsA: Cell[];
  /** B 席的格子，按"城"分组（守城战是友军一组） */
  cellsB: Cell[][];
  sizesB: number[];
  /** C 席（守城战的攻方）的格子 */
  cellsC: Cell[];
  /** 中立单位站的格子（隐藏席位 C） */
  neutralCells: Cell[];
} {
  const w = init.size;
  const h = init.size;
  const grid = makeRows(w, h, init.seed).map((r) => [...r]);

  // ---- 城 ----
  /*
   * 守城战是三席：**城在友军 B 手里**（下沿），玩家 A 只作为支援入场。
   * 其余房型仍是两席：B 在上沿，有几座城由 `enemyCityCount` 决定。
   */
  const allyCity = init.allyCity === true;
  const citiesB: Cell[] = [];
  const citiesA: Cell[] = [];
  if (allyCity) {
    citiesB.push({ x: Math.max(0, Math.floor(w / 2) - 1), y: Math.max(0, h - 4) });
  } else if (init.enemyCityCount > 0) {
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
  if (init.playerCity) citiesA.push({ x: Math.max(0, Math.floor(w / 2) - 1), y: Math.max(0, h - 4) });
  const blocked = blockedSet([...citiesA, ...citiesB], 2);

  /**
   * 摆工事：先按"设计好的位置"放，占住了再往外找。
   *
   * 位置是相对城/阵地算的，所以两座塔一定在城的两侧、墙一定在正面——
   * 玩家看到的是"门"，不是一堆随机摆的建筑。
   */
  const placeStructures = (
    origin: Cell,
    defs: string[],
    layout: 'fort' | 'field',
    dir: 1 | -1 = 1,
  ): Array<{ type: string; x: number; y: number }> => {
    /*
     * 两种摆法：
     *   fort  —— 有城：塔在城的两翼、墙在正面（你要从正面拆进去）
     *   field —— 没城的精英：塔在正中，墙贴着塔，兵围着这一坨（一个据点）
     */
    const preferred: Cell[] =
      layout === 'fort'
        ? [
            // 两翼贴着城（城占 x..x+1），中间留一道门：塔封两侧，人守门
            { x: origin.x - 1, y: origin.y + 2 * dir },
            { x: origin.x + 2, y: origin.y + 2 * dir },
            { x: origin.x, y: origin.y + 3 * dir },
            { x: origin.x + 1, y: origin.y + 3 * dir },
          ]
        : [
            { x: origin.x, y: 2 },
            { x: origin.x - 2, y: 2 },
            { x: origin.x + 2, y: 2 },
            { x: origin.x, y: 3 },
          ];
    const out: Array<{ type: string; x: number; y: number }> = [];
    const free = (c: Cell): boolean =>
      c.x >= 0 && c.y >= 0 && c.x < w && c.y < h && !blocked.has(`${c.x},${c.y}`);
    const fallback: Cell[] = [];
    for (let r = 0; r <= Math.max(w, h); r += 1) {
      for (let dy = -r; dy <= r; dy += 1) {
        for (let dx = -r; dx <= r; dx += 1) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const c = { x: origin.x + dx, y: origin.y + dy };
          if (free(c)) fallback.push(c);
        }
      }
    }
    let cursor = 0;
    for (const type of defs) {
      let cell: Cell | undefined;
      while (cursor < preferred.length && !cell) {
        const c = preferred[cursor++];
        if (c && free(c)) cell = c;
      }
      cell = cell ?? fallback.shift();
      if (!cell) break;
      blocked.add(`${cell.x},${cell.y}`);
      out.push({ type, x: cell.x, y: cell.y });
    }
    return out;
  };

  /**
   * 工事按城分：两座城就**轮流分**，塔排在前面，所以每座城至少分到一座塔。
   */
  const splitDefense = (entries: ArmyEntry[], groups: number): string[][] => {
    const flat = entries.flatMap((e) => Array<string>(e.count).fill(e.type));
    if (groups <= 1) return [flat];
    const out: string[][] = Array.from({ length: groups }, () => []);
    flat.forEach((type, i) => out[i % groups]!.push(type));
    return out;
  };

  const structuresB: Array<{ type: string; x: number; y: number }> = [];
  if (allyCity) {
    // 友军的城防：塔在两侧、墙在正面，朝**上方**（敌人来的方向）
    if (init.allyDefense.length > 0 && citiesB[0]) {
      structuresB.push(...placeStructures(citiesB[0], flatten(init.allyDefense), 'fort', -1));
    }
  } else {
    const cityGroups = citiesB.length > 1 ? citiesB.length : 1;
    const defenseGroups = splitDefense(init.enemyDefense, cityGroups);
    if (citiesB.length === 0) {
      if (defenseGroups[0]!.length > 0) {
        structuresB.push(...placeStructures({ x: Math.floor(w / 2), y: 0 }, defenseGroups[0]!, 'field'));
      }
    } else {
      citiesB.forEach((city, g) => {
        const defs = defenseGroups[g] ?? [];
        if (defs.length > 0) structuresB.push(...placeStructures(city, defs, 'fort'));
      });
    }
  }
  const structuresA: Array<{ type: string; x: number; y: number }> = init.playerDefense.length
    ? placeStructures(citiesA[0] ?? { x: Math.floor(w / 2), y: h - 3 }, flatten(init.playerDefense), 'fort', -1)
    : [];

  // ---- 阵位 ----
  const playerAnchor: Cell = allyCity
    ? // 支援：站在城前**偏左**，把正面让给友军
      { x: Math.max(1, (citiesB[0] as Cell).x - 2), y: Math.max(1, (citiesB[0] as Cell).y - 2) }
    : citiesA[0]
      ? { x: (citiesA[0] as Cell).x + 1, y: Math.max(1, (citiesA[0] as Cell).y - 2) }
      : { x: Math.floor(w / 2), y: h - 2 };
  const allyAnchor: Cell | null = allyCity
    ? { x: Math.min(w - 2, (citiesB[0] as Cell).x + 3), y: Math.max(1, (citiesB[0] as Cell).y - 2) }
    : null;
  const enemyAnchors: Cell[] = allyCity
    ? [{ x: Math.floor(w / 2), y: 1 }]
    : citiesB.length > 0
      ? citiesB.map((c) => ({ x: c.x + 1, y: c.y + 3 }))
      : [{ x: Math.floor(w / 2), y: init.kind === 'special' ? 1 : 4 }];

  const playerFlat = flatten([...init.playerArmy, ...init.tempUnits]);
  const allyFlat = allyCity ? flatten(init.allyArmy) : [];
  const enemyFlat = init.enemyTypes;
  /*
   * 两座城 → 兵力也对半开（奇偶交替，贵的和便宜的都混在两边）。
   */
  const enemyGroups: string[][] =
    !allyCity && citiesB.length > 1
      ? [enemyFlat.filter((_, i) => i % 2 === 0), enemyFlat.filter((_, i) => i % 2 === 1)]
      : [enemyFlat];
  /*
   * 多要几个格子当"余量"。
   */
  const SLACK = 6;
  /*
   * 中立单位：站在**战场两侧**（左右边缘、半高），不挡中间那条冲线的路。
   *
   * 上一版放在正中：两边都得绕着它走，而且它一被误伤就把仇恨带偏。
   * 挪到两侧之后它才像"路过的人"——你可以专门绕过去搭理它，也可以当没看见。
   * 先占格子再铺地形，和别的单位一个口径。
   */
  const neutralCells: Cell[] = [];
  const neutralCount = init.neutral?.reduce((n, a) => n + a.count, 0) ?? 0;
  if (neutralCount > 0) {
    const mid = Math.floor(h / 2);
    const anchors: Cell[] = [
      { x: 1, y: mid },
      { x: w - 2, y: mid },
      { x: 1, y: mid + 2 },
      { x: w - 2, y: mid - 2 },
    ];
    const free = (c: Cell): boolean =>
      c.x >= 0 && c.y >= 0 && c.x < w && c.y < h && !blocked.has(`${c.x},${c.y}`);
    for (let i = 0; i < neutralCount; i += 1) {
      const a = anchors[i % anchors.length] as Cell;
      let picked: Cell | null = null;
      for (let r = 0; r <= Math.max(w, h) && !picked; r += 1) {
        for (let dy = -r; dy <= r && !picked; dy += 1) {
          for (let dx = -r; dx <= r && !picked; dx += 1) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
            const c = { x: a.x + dx, y: a.y + dy };
            if (!free(c)) continue;
            picked = c;
          }
        }
      }
      if (!picked) break;
      blocked.add(`${picked.x},${picked.y}`);
      neutralCells.push(picked);
    }
  }

  const playerCells = pickCells(w, h, grid, blocked, playerAnchor, playerFlat.length + SLACK, init.seed ^ 0x1234);
  const allyCells = allyAnchor
    ? pickCells(w, h, grid, blocked, allyAnchor, allyFlat.length + SLACK, init.seed ^ 0x2468)
    : [];
  const enemyCellGroups = enemyGroups.map((group, g) =>
    pickCells(
      w,
      h,
      grid,
      blocked,
      enemyAnchors[g] ?? (enemyAnchors[0] as Cell),
      group.length + SLACK,
      (init.seed ^ (0x5678 + g * 0x9e3779b1)) >>> 0,
    ),
  );
  const enemyCells = enemyCellGroups.flat();

  // 站人的格子一律铺平：阵型不该被一丛树卡出个缺口
  for (const c of [...playerCells, ...allyCells, ...enemyCells, ...neutralCells]) grid[c.y]![c.x] = '.';

  const deployA = [
    ...playerFlat.map((type, i) => {
      const cell = playerCells[i] ?? playerAnchor;
      return { type, x: cell.x, y: cell.y };
    }),
    ...structuresA,
  ];
  const deployB: Array<{ type: string; x: number; y: number }> = [];
  if (allyCity) {
    allyFlat.forEach((type, i) => {
      const cell = allyCells[i] ?? allyAnchor ?? playerAnchor;
      deployB.push({ type, x: cell.x, y: cell.y });
    });
  } else {
    enemyGroups.forEach((group, g) => {
      group.forEach((type, i) => {
        const cell = enemyCellGroups[g]?.[i] ?? (enemyAnchors[g] ?? (enemyAnchors[0] as Cell));
        deployB.push({ type, x: cell.x, y: cell.y });
      });
    });
  }
  deployB.push(...structuresB);

  const deployC = allyCity
    ? enemyFlat.map((type, i) => {
        const cell = enemyCells[i] ?? (enemyAnchors[0] as Cell);
        return { type, x: cell.x, y: cell.y };
      })
    : [];

  const noCity: PlayerId[] = [];
  if (!init.playerCity) noCity.push('A');
  if (allyCity) {
    noCity.push('C');
  } else if (init.enemyCityCount === 0) {
    noCity.push('B');
  }
  // 隐藏的中立席位也没有城（校验只认 cityless，不认 hidden）
  if (neutralCells.length > 0) noCity.push('C');
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
      citiesA,
      citiesB,
    },
    seats: allyCity
      ? { count: 3, ai: ['B', 'C'], cityless: noCity, teams: [['A', 'B'], ['C']] }
      : neutralCells.length > 0
        ? /*
           * 中立单位用**隐藏席位 C**：不占回合（引擎跳过 hidden）、不算出局、
           * 也不参与胜负；把它编进 B 的队里，AI 眼里它就是友军，不会去打。
           * 玩家和它不同队，所以可以主动攻击它——它只反击。
           */
          { count: 3, ai: ['B'], hidden: ['C'], cityless: noCity, teams: [['A'], ['B', 'C']] }
        : { count: 2, ai: ['B'], cityless: noCity },
    deploy: allyCity ? { A: deployA, B: deployB, C: deployC } : { A: deployA, B: deployB },
    /*
     * 关卡自带工事兵种：墙在 era-arms 包里，但肉鸽不开那个包（会把 89 个
     * 近现代兵塞进招募池），所以由关卡自己登记这几件。
     */
    units: DEFENSE_UNIT_DEFS,
    setup: { startEra: init.cityEra, firstSide: 'A' },
    /*
     * AI 的进攻性。
     *
     * 守城/遭遇的**攻方**没有城：核心 AI 在没有城时会退化成"守住出生点"，
     * `pressure` 只对无城席位生效，逼它往前压。守城战的守军（B）有城，
     * 这条对它不起作用——它自然会守。
     */
    ai:
      init.enemyCityCount === 0
        ? { riskAversion: 0.4, cohesion: 0, appetite: 2.5, pressure: 2 }
        : { riskAversion: 0.8, cohesion: 0.5, appetite: 1.5 },
  };
  return {
    level,
    cellsA: playerCells,
    cellsB: allyCity ? [allyCells] : enemyCellGroups,
    sizesB: allyCity ? [allyFlat.length] : enemyGroups.map((g) => g.length),
    cellsC: allyCity ? enemyCells : [],
    neutralCells,
  };
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
function arrangeFormation(s: GameState, owner: PlayerId, toward: -1 | 1, slots: Cell[], subset?: Unit[]): void {
  /*
   * 建筑不参加排阵。
   *
   * 塔和墙是"钉在地上"的：它们的位置本身就是这一关的题面（塔在城侧、墙在正面），
   * 被排到别处就全乱了。而且 move 0 的单位本来也没有"前后排"可言。
   */
  const units = (subset ?? s.units).filter(
    (u) => u.owner === owner && u.hp > 0 && (s.unitTypes[u.type]?.category !== 'building') && (s.unitTypes[u.type]?.move ?? 1) > 0,
  );
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
  const { level, cellsA, cellsB: cellsBGroups, sizesB, cellsC, neutralCells } = makeLevel(init);
  /*
   * 进场的兵种：地面战斗兵 + **这一关用到的工事**。
   *
   * 只放战斗兵的话，`deploy` 里的塔查不到兵种，会被引擎当成"不存在的兵"跳过——
   * 场上就只剩兵，塔和墙凭空消失。所以工事必须一起登记进本局兵种表。
   */
  const defenseIds = [...init.enemyDefense, ...init.playerDefense].map((e) => e.type);
  const allUnits = [
    ...Object.values(UNIT_TYPES)
      .filter((d) => d.category === 'combat' && d.domain !== 'water')
      .map((d) => d.id),
    ...new Set(defenseIds.filter((id) => UNIT_TYPES[id])),
  ];

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
      /*
       * 工事兵种能**部署**，但不该进招募池。
       *
       * `LevelDef.units` 会把它们塞进本局兵种表（这是部署能认出来的前提），
       * 而引擎的规则是"关卡自带的兵种默认进场"——不在这里关掉，AI 会拿
       * 一个补员名额去买一道不会走的墙。
       */
      disabledUnits: Object.keys(DEFENSE_UNIT_DEFS),
      level,
      aiDoctrine: init.enemyDoctrine,
      /*
       * 三席守城：B 是友军、C 才是敌人——"抢攻"要下给 C。
       * 两席局仍然是 B。
       */
      aiDoctrineSeat: init.allyCity ? 'C' : 'B',
      /*
       * 守城战自己判胜负（守满 N 轮 / 城破），不走引擎的"一方全灭"——
       * 攻方是分波来的，第一波打光不等于这一仗结束。`holdWinner` 正是
       * 引擎为这种"按目标判"留的闸门。
       */
      holdWinner: init.allyCity,
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
   * 中立单位：主人是隐藏席位 C。
   *
   * `moved/acted: true` 让它连"自己回合"都没有（隐藏席位本来也不轮）；
   * `countersLeft` 给足，是因为它永远等不到"自己回合开始"的重置——
   * 不给的话，反击一次就再也不还手了。
   */
  if (init.neutral && neutralCells.length > 0) {
    const types = init.neutral.flatMap((a) => Array<string>(a.count).fill(a.type));
    types.forEach((type, i) => {
      const cell = neutralCells[i];
      const def = s.unitTypes[type];
      if (!cell || !def) return;
      s.units.push({
        id: `u${s.nextUnitSeq++}`,
        type,
        owner: 'C',
        x: cell.x,
        y: cell.y,
        hp: def.maxHp,
        kills: 0,
        moved: true,
        acted: true,
        bornTurn: s.turn,
        countersLeft: 99,
      });
    });
  }

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
    /*
     * 三席守城：A/B 在下、C 在上，朝向是定死的（不靠两家平均 y 猜）。
     * 两席局仍然按"谁在下面谁朝上"。
     */
    const dirA = init.allyCity ? -1 : aDown ? -1 : 1;
    const dirB = init.allyCity ? -1 : aDown ? 1 : -1;
    arrangeFormation(s, 'A', dirA, cellsA);
    /*
     * B 席按组摆：两座城两组守军，或守城战的一支友军。
     * 不能把所有 B 的格子合在一起排——那会把第二座城的兵排到第一座城去。
     */
    const combatB = bUnits.filter((u) => s.unitTypes[u.type]?.category === 'combat');
    let cursor = 0;
    cellsBGroups.forEach((cells, g) => {
      const size = sizesB[g] ?? 0;
      arrangeFormation(s, 'B', dirB, cells, combatB.slice(cursor, cursor + size));
      cursor += size;
    });
    /*
     * C 席（守城战的攻方）：一组，从地图上沿压下来。
     */
    if (cellsC.length > 0) {
      const combatC = s.units.filter(
        (u) => u.owner === 'C' && u.hp > 0 && s.unitTypes[u.type]?.category === 'combat',
      );
      arrangeFormation(s, 'C', 1, cellsC, combatC);
    }
  }

  // ---- 我方加成（变体兵种）----
  /*
   * 我军加成：攻击 / 护甲 / 生命 / 移动。
   *
   * `unitTypes` 是全图共用的一张表，所以不能直接把 +1 写进去（敌人也会变强）；
   * 给每个兵注册一个带后缀的**变体兵种**，只有我军用变体 id。
   *
   * **只给战斗单位**（2026-11-25 修）。上一版把加成套到了所有 `owner === 'A'`
   * 的单位上，于是"骑军"方略的 +1 移动、急行靴的 +1 移动也给了土墙和塔——
   * 工事在本体里 `move: 0`，到了肉鸽却能走一格。建筑不是"兵"，不吃这套加成。
   */
  const moveUp = init.bonusMove;
  for (const u of s.units) {
    if (u.owner !== 'A') continue;
    if (s.unitTypes[u.type]?.category !== 'combat') continue;
    const def = s.unitTypes[u.type];
    let atk = init.bonusAtk;
    if (init.strategyId === 'skirmish' && def && def.range >= 3) atk += 2;
    /*
     * 移动加成分两种：
     *   · 方略 / 临战决议（`bonusMove`）——所有兵都吃（"骑军"本来就是快）；
     *   · 急行靴（`bonusMoveSlow`）——只给基础移速 ≤3 的兵。
     *
     * 为什么后者要设门槛：+1 移动在 12 格小图上是**节奏**收益，2→3 是 +50%
     * 接敌距离，4→5 只是让本来就快的骑兵再早到一回合——后者才是"移速藏品
     * 一家独大"的来源。现在它变成"让步兵和弓手跟得上"，骑兵不吃这份加成。
     */
    const addMove = (def && def.move <= 3 ? init.bonusMoveSlow : 0) + moveUp;
    /*
     * 成长型单位（试验队 / 英雄）：进场的不是完全体，按层折算。
     *
     * 折算写成"系数 − 1"的**差量**，和攻/甲/血的加成走同一套变体机制——
     * 不需要另注册兵种，也不用改 `unitTypes` 这张全图共用的表。
     * 第 3 层（它自己的时代）系数是 1，差量为 0，等于没这条。
     */
    const grow = growthOf(baseTypeOf(u.type), init.layer);
    const growAtk = grow ? Math.round((def?.atk ?? 0) * (grow.atk - 1)) : 0;
    const growHp = grow ? Math.round((def?.maxHp ?? 0) * (grow.hp - 1)) : 0;
    const growArmor = grow ? Math.round((def?.armor ?? 0) * (grow.armor - 1)) : 0;
    const growMove = grow ? Math.round((def?.move ?? 0) * (grow.move - 1)) : 0;
    u.type = variantOf(
      s,
      u.type,
      atk + growAtk,
      addMove + growMove,
      init.bonusArmor + growArmor,
      init.bonusHp + growHp,
    );
    const v = s.unitTypes[u.type];
    if (v) u.hp = v.maxHp;
  }

  // ---- 火药桶 / 工兵破墙：**敌城**开场就带伤 ----
  /*
   * 三席守城战的城里是**友军 B 的**，不能被"火药桶"误伤；
   * 攻方 C 没有城，所以这一项在守城战里等于没有。
   */
  const foeSeat: PlayerId = init.allyCity ? 'C' : 'B';
  if (init.cityDamage > 0) {
    for (const city of s.cities) {
      if (city.owner !== foeSeat) continue;
      city.hp = Math.max(1, Math.round(city.hp * (1 - Math.min(0.8, init.cityDamage))));
    }
  }

  /*
   * ---- 守城战：把城加固 ----
   *
   * 一座一代城只有 45 点耐久，三波敌人两轮就能啃穿。守城战要守 7–9 轮，
   * 所以给它 +80%——不是让它无敌，是让它值得守。
   */
  if (init.allyCity || init.playerCity) {
    const owner: PlayerId = init.allyCity ? 'B' : 'A';
    for (const city of s.cities) {
      if (city.owner !== owner) continue;
      const add = Math.round(city.maxHp * 0.8);
      city.maxHp += add;
      city.hp += add;
    }
  }

  /*
   * ---- 工事数值缩放（奇想 / 修真的建筑偏弱）----
   *
   * 给它们注册一个带后缀的变体，只改**这一局**的兵种表，不影响别的关。
   */
  if (init.defenseScale) {
    const k = init.defenseScale;
    for (const u of s.units) {
      const def = s.unitTypes[u.type];
      if (!def || def.category !== 'building') continue;
      const dAtk = Math.round(def.atk * (k.atk - 1));
      const dHp = Math.round(def.maxHp * (k.hp - 1));
      if (dAtk === 0 && dHp === 0) continue;
      u.type = variantOf(s, u.type, dAtk, 0, 0, dHp);
      u.hp = s.unitTypes[u.type]?.maxHp ?? u.hp;
    }
  }

  // ---- 临战决议：敌军 / 工事开场带伤 ----
  if (init.enemyDamage > 0) {
    const k = 1 - Math.min(0.8, init.enemyDamage);
    for (const u of s.units) {
      if (u.owner !== foeSeat) continue;
      if (s.unitTypes[u.type]?.category !== 'combat') continue;
      u.hp = Math.max(1, Math.round(u.hp * k));
    }
  }
  if (init.defenseDamage > 0) {
    const k = 1 - Math.min(0.8, init.defenseDamage);
    for (const u of s.units) {
      if (u.owner !== foeSeat) continue;
      if (s.unitTypes[u.type]?.category !== 'building') continue;
      u.hp = Math.max(1, Math.round(u.hp * k));
    }
  }

  s.players.A.gold = init.playerGold;
  // 三席时 B 是友军、C 是攻方：两边都不带钱（不招募，只打编制）
  s.players.B.gold = init.allyCity ? 0 : init.enemyGold;
  if (s.players.C) s.players.C.gold = 0;
  s.log.push({ turn: 1, player: 'A', text: `肉鸽 2.0：${init.label}（${init.sub}）` });
  return s;
}

/**
 * 守城战的波次：在敌方回合开始前，把新一波摆到地图上沿。
 *
 * 为什么由界面层调、而不是关卡事件：引擎的关卡事件里确实有 `deploy`，
 * 但它只能让**未登场的席位**上场（一次性的），做不出"同一席位连着来三波"。
 * 我们只在战斗屏这一侧往 `state.units` 里追加单位，规则层照常推进——
 * 不碰引擎，也不影响别的玩法。
 */
export function spawnWave(s: GameState, types: string[], seed: number, owner: PlayerId = 'B'): Unit[] {
  const blocked = new Set<string>();
  for (const u of s.units) if (u.hp > 0) blocked.add(`${u.x},${u.y}`);
  for (const c of s.cities) {
    for (let dy = 0; dy < c.size; dy += 1) {
      for (let dx = 0; dx < c.size; dx += 1) blocked.add(`${c.x + dx},${c.y + dy}`);
    }
  }
  const rows: string[][] = [];
  for (let y = 0; y < s.h; y += 1) {
    const row: string[] = [];
    for (let x = 0; x < s.w; x += 1) {
      const t = s.tiles[y * s.w + x]?.terrain;
      row.push(t === 'water' || t === 'deep' ? '~' : t === 'mountain' ? '^' : '.');
    }
    rows.push(row);
  }
  const cells = pickCells(s.w, s.h, rows, blocked, { x: Math.floor(s.w / 2), y: 0 }, types.length, seed ^ 0x3c6ef372);
  const out: Unit[] = [];
  for (let i = 0; i < types.length; i += 1) {
    const cell = cells[i];
    const def = s.unitTypes[types[i] as string];
    if (!cell || !def) continue;
    /*
     * id 必须走**引擎的序号**（`nextUnitSeq`），不能自己按"当前最大 id + 1"算。
     *
     * 这是"国王闪现"那条 bug 的根：波次先来了 u10，但 `nextUnitSeq` 还是 10；
     * 下一回合哥布林战营召唤的小兵也拿到 u10——场上两个 u10。渲染层按 id 认节点，
     * 于是两张牌共用一个 DOM，国王的图标被挪到哥布林的位置、随后消失。
     * 按引擎的序号发号，永远不会撞车；顺手也补上出生回合与弹药字段。
     */
    const u: Unit = {
      id: `u${s.nextUnitSeq++}`,
      type: def.id,
      owner,
      x: cell.x,
      y: cell.y,
      hp: def.maxHp,
      kills: 0,
      moved: false,
      acted: false,
      bornTurn: s.turn,
      ...(typeof def.ammo === 'number' ? { ammoLeft: def.ammo } : {}),
      ...(def.hatch ? { hatchLeft: def.hatch.turns } : {}),
    };
    s.units.push(u);
    out.push(u);
  }
  return out;
}

export function outcomeOf(s: GameState, init?: BattleInit): 'win' | 'lose' | null {
  /*
   * 玩家这一侧的"人"打光了就算输——**建筑不算人**。
   *
   * 三席守城战里 A 是支援：支援打光了，这一仗对玩家就是输了（哪怕友军
   * 还在城上撑着）——你是来补位的，补位的人没了就是没守住。
   */
  const people = (p: PlayerId): number =>
    s.units.filter((u) => u.owner === p && u.hp > 0 && s.unitTypes[u.type]?.category === 'combat').length;
  if (people('A') === 0) return 'lose';
  if (s.winner) return s.winner === 'A' ? 'win' : 'lose';

  /*
   * 守城战的目标：**守满 N 轮，而且城还得站着**。
   *
   * 城现在是**友军 B 的**（三席）。攻方 C 分波来，所以不能用引擎的
   * "一方全灭"判——第一波打光不等于结束，`holdWinner` 已经在建局时关掉了。
   */
  if (init && init.holdRounds > 0) {
    const ally = init.allyCity === true;
    const cityOwner: PlayerId = ally ? 'B' : 'A';
    const foe: PlayerId = ally ? 'C' : 'B';
    if (!s.cities.some((c) => c.owner === cityOwner && !c.ruined)) return 'lose';
    const hidden = s.config.level?.seats?.hidden?.length ?? 0;
    const seats = Math.max(1, (s.config.playerCount ?? 2) - hidden);
    const rounds = Math.ceil(s.turn / seats);
    /*
     * 提前赢：**所有波次都到齐了，而且都打光了**。
     *
     * 不给这一条的话，玩家把攻城的兵全歼之后还得空按四五轮"结束回合"
     * 等计时器走完——那不是"守住了"，是罚站。
     */
    const lastWave = init.waves.reduce((n, w) => Math.max(n, w.atRound), 0);
    if (people(foe) === 0 && rounds >= lastWave) return 'win';
    if (Math.floor(s.turn / seats) >= init.holdRounds) return 'win';
  }
  return null;
}

/** 幸存的我军（变体 id 还原成原始兵种，跨层只带兵种和数量） */
export function survivorsOf(s: GameState): ArmyEntry[] {
  const map = new Map<string, number>();
  for (const u of s.units) {
    if (u.owner !== 'A' || u.hp <= 0) continue;
    // 工事不是"兵"，不跟着队伍跨层；下一关要用会重新发
    if (s.unitTypes[u.type]?.category === 'building') continue;
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
