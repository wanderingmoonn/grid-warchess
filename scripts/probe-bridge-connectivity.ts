/**
 * 探针：地图到底有没有被水**分割**，桥到底有没有起**联通**作用。
 *
 * 用户 2026-11-23 指出的两个坑：
 *   1. **桥的数量不代表联通**——桥可能只是在填家门口碍事的湖、或者在河湾抄近路；
 *   2. **浅流（shallow）和沼泽（marsh）在 `passable` 里是可通行的**（只挡
 *      water/deep/mountain），有浅流横穿时"地图被河分割"根本不成立，
 *      而靠"桥数 / 水面格数"看会误判。
 *
 * 所以这里不看桥数，看**连通块**：
 *   · `无桥连通` = 把桥面当水面重算，我方城和敌方城还在同一块吗？
 *   · `关键桥` = 哪几座桥拆掉就会让两边断开（其余都是抄近路/填湖）。
 *
 * 用法：
 *   node --experimental-strip-types scripts/probe-bridge-connectivity.ts --queue Q3 --seed 30 --side A
 */
import { DEFAULT_CONFIG, createMatch } from '../src/core/setup.ts';
import { applyAction } from '../src/core/rules.ts';
import { AI_MAX_STEPS, DEFAULT_BUDGET, aiActionKey } from '../src/core/ai.ts';
import { passable } from '../src/core/config.ts';
import type { GameState, PlayerId, Terrain } from '../src/core/types.ts';

const argOf = (name: string, fallback = ''): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
};
const QUEUES: Record<string, { size: number; era: number; cap: number }> = {
  Q1: { size: 12, era: 2, cap: 200 },
  Q2: { size: 16, era: 3, cap: 220 },
  Q3: { size: 24, era: 2, cap: 260 },
  Q4: { size: 24, era: 4, cap: 260 },
};
const QID = argOf('queue', 'Q3').toUpperCase();
const q = QUEUES[QID];
if (!q) throw new Error(`没有队列 ${QID}`);
const SEED = Number(argOf('seed', '30'));
const SIDE = (argOf('side', 'A').toUpperCase() === 'A' ? 'A' : 'B') as PlayerId;
const EVERY = Number(argOf('every', '20'));

type Ai = (
  s: GameState,
  budget: typeof DEFAULT_BUDGET,
  rejected: ReadonlySet<string>,
) => ReturnType<typeof import('../src/core/ai.ts')['aiNextAction']>;
const modNew = (await import('../src/core/ai-v3.ts')) as { aiNextAction: Ai };
const modOld = (await import('./baselines/ai-9efb961.ts')) as { aiNextAction: Ai };
const aiFor = (p: PlayerId): Ai => (p === SIDE ? modNew.aiNextAction : modOld.aiNextAction);

let s: GameState = createMatch(
  { ...DEFAULT_CONFIG, startEra: q.era, aiLevel: 'tactic', size: q.size, mapSymmetry: 'fair' },
  SEED,
);

/**
 * 连通块。`bridgeAsWall = true` 时把桥面当墙——用来回答"没有桥会怎样"。
 * 陆军能走的判据就是 `passable`：只挡 water/deep/mountain，**shallow/marsh 能走**。
 */
function components(bridgeAsWall: boolean): { comp: Int16Array; count: number } {
  const comp = new Int16Array(s.w * s.h).fill(-1);
  /*
   * 地图自带的桥（`s.mapBridges`）**不能**当墙。
   *
   * 第一版只判 `terrain === 'bridge'`，把地图桥也拆了，于是"无桥时断开"全线报假——
   * 这局地图上本来就有 `3,3 / 4,4 / 5,4 / 6,5` 一条栈道。工兵桥才是"要拆掉看看"的那个。
   */
  const statics = new Set(s.mapBridges ?? []);
  const isWall = (k: number, t: Terrain): boolean => bridgeAsWall && t === 'bridge' && !statics.has(k);
  let count = 0;
  for (let start = 0; start < s.w * s.h; start++) {
    if (comp[start] !== -1) continue;
    const t = s.tiles[start]!.terrain;
    if (!passable(t)) continue;
    if (isWall(start, t)) continue;
    const id = count++;
    const queue = [start];
    comp[start] = id;
    for (let i = 0; i < queue.length; i++) {
      const k = queue[i]!;
      const x = k % s.w;
      const y = Math.floor(k / s.w);
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as Array<[number, number]>) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= s.w || ny >= s.h) continue;
        const nk = ny * s.w + nx;
        if (comp[nk] !== -1) continue;
        const nt = s.tiles[nk]!.terrain;
        if (!passable(nt)) continue;
        if (isWall(nk, nt)) continue;
        comp[nk] = id;
        queue.push(nk);
      }
    }
  }
  return { comp, count };
}

/** 城格号（按城的真实 `size`，不是硬编码 2×2——大城是 3×3） */
function cityCells(c: (typeof s.cities)[number]): number[] {
  const out: number[] = [];
  for (let dy = 0; dy < c.size; dy++) {
    for (let dx = 0; dx < c.size; dx++) {
      const k = (c.y + dy) * s.w + (c.x + dx);
      if (k >= 0 && k < s.w * s.h) out.push(k);
    }
  }
  return out;
}

/** 这座城落在哪个连通块（取城格里第一个可通行的） */
function compOfCity(comp: Int16Array, c: (typeof s.cities)[number]): number {
  for (const k of cityCells(c)) {
    const id = comp[k]!;
    if (id >= 0) return id;
  }
  return -1;
}

/**
 * 我方城 ↔ 敌方城（任一座）是否连通。
 *
 * `noMine` = 我方已经没城了（输掉的那种局）——这时"断不断开"没有意义，
 * 不能报成"需要桥"。第一版就把它当成了 `compA = -1 → 断开`。
 */
function linked(bridgeAsWall: boolean): {
  linked: boolean;
  noMine: boolean;
  noFoe: boolean;
  count: number;
} {
  const { comp, count } = components(bridgeAsWall);
  const my = s.cities.filter((c) => c.owner === SIDE && !c.ruined);
  const foe = s.cities.filter((c) => c.owner !== SIDE && !c.ruined);
  if (my.length === 0) return { linked: false, noMine: true, noFoe: foe.length === 0, count };
  const compA = compOfCity(comp, my[0]!);
  const compB = foe.map((c) => compOfCity(comp, c)).filter((b) => b >= 0);
  return {
    linked: compA >= 0 && compB.some((b) => b === compA),
    noMine: false,
    noFoe: foe.length === 0,
    count,
  };
}

/**
 * 拆掉这一座桥，我方和敌方还连通吗？不连通 = 关键桥。
 *
 * **其它桥要保留**（用 `linked(false)`）：第一版写成 `linked(true)`（所有桥面当墙），
 * 于是拆任何一格都"断开"，8 座全报关键——那不是测量，是恒等式。
 */
function isCriticalBridge(x: number, y: number): boolean {
  const k = y * s.w + x;
  const saved = s.tiles[k]!.terrain;
  s.tiles[k]!.terrain = 'water';
  const r = linked(false);
  s.tiles[k]!.terrain = saved;
  return !r.linked;
}

/**
 * 每个陆地连通块里有几座城。
 *
 * 用来区分两种"断开"：
 *   · **关键分割**——我方城和敌方城分在两边，必须过河；
 *   · **无关分割**——某一块压根没有城，打不打它都不影响胜负。
 * 如果是后者，`noLink` 长期为正也不该催着修桥。
 */
function blockCities(): { counts: number[]; emptyBlocks: number } {
  const { comp, count } = components(false);
  const counts = new Array<number>(count).fill(0);
  for (const c of s.cities) {
    if (c.ruined) continue;
    const k = c.y * s.w + c.x;
    const id = comp[k]!;
    if (id >= 0) counts[id] = (counts[id] ?? 0) + 1;
  }
  return { counts, emptyBlocks: counts.filter((n) => n === 0).length };
}

const terrainCount = (): string => {
  const m = new Map<Terrain, number>();
  for (const t of s.tiles) m.set(t.terrain, (m.get(t.terrain) ?? 0) + 1);
  const order: Terrain[] = ['water', 'deep', 'shallow', 'marsh', 'bridge', 'mountain'];
  return order
    .filter((t) => (m.get(t) ?? 0) > 0)
    .map((t) => `${t} ${m.get(t)}`)
    .join(' · ');
};

console.log(
  `${QID} ${q.size}×${q.size}/era${q.era} seed=${SEED} · 新版坐 ${SIDE}\n地形：${terrainCount()}`,
);

while (!s.winner && s.turn <= q.cap) {
  const turn = s.turn;
  const budget = { ...DEFAULT_BUDGET };
  const rejected = new Set<string>();
  const moveTries = new Map<string, number>();
  for (let i = 0; i < AI_MAX_STEPS && !s.winner; i++) {
    const a = aiFor(s.current)(s, budget, rejected);
    if (!a) break;
    const r = applyAction(s, a);
    if (!r.ok) {
      if (a.type === 'MOVE' && 'unitId' in a) {
        const uid = String((a as { unitId?: string }).unitId ?? '');
        const n = (moveTries.get(uid) ?? 0) + 1;
        moveTries.set(uid, n);
        if (n < 2) continue;
      }
      rejected.add(aiActionKey(a));
      continue;
    }
    rejected.clear();
    s = r.state;
    if (a.type === 'RECRUIT') budget.recruited += 1;
    if (a.type === 'UPGRADE') budget.upgraded += 1;
  }
  if (s.winner) break;

  if (turn % EVERY === 0) {
    const keep = ((s.aiFocus as Record<string, { plan?: { keep?: Record<string, unknown> } }> | undefined)?.[SIDE]?.plan?.keep ?? {}) as Record<string, unknown>;
    const noBridge = linked(true);
    const withBridge = linked(false);
    const bridges = s.units.filter((u) => u.owner === SIDE && u.type.startsWith('bridge'));
    /*
     * 只有**当前真的连通**时才谈"关键桥"。
     * 原本就不通的话，拆任何一格都"还是不通"，全被判成关键——那不是测量，是恒等式
     * （Q3|30|A 第一版就报出"8 座全关键"，实际一座都没连上）。
     */
    const critical = withBridge.linked ? bridges.filter((b) => isCriticalBridge(b.x, b.y)).length : 0;
    /* 桥单位 vs 桥面地形：差集就是"造了桥但没铺成路"的格 */
    const deck = new Set<number>();
    for (let i = 0; i < s.tiles.length; i++) if (s.tiles[i]!.terrain === 'bridge') deck.add(i);
    const unitCells = new Set(bridges.map((b) => b.y * s.w + b.x));
    const noDeck = [...unitCells].filter((k) => !deck.has(k));
    const noUnit = [...deck].filter((k) => !unitCells.has(k));
    const fmt = (ks: number[]): string => ks.map((k) => `${k % s.w},${Math.floor(k / s.w)}`).join(' ');
    console.log(
      `T${String(turn).padStart(3)} 陆地连通块 ${withBridge.count}（无桥 ${noBridge.count}）` +
        ` · 无桥时两边 ${noBridge.linked ? '**仍然连通**' : '断开'}` +
        ` · 我方桥 ${bridges.length}（关键 ${critical}）[${bridges.map((b) => `${b.x},${b.y}`).join(' ')}]` +
        ` · 兵 ${s.units.filter((u) => u.owner === SIDE && s.unitTypes[u.type]?.category === 'combat').length}` +
        ` · 断路 ${keep.noLink ?? '-'}`,
    );
    if (noDeck.length > 0) console.log(`       ⚠ 有桥单位但没铺桥面：${fmt(noDeck)}`);
    if (noUnit.length > 0) console.log(`       ⚠ 有桥面但没桥单位：${fmt(noUnit)}`);
  }

  const e = applyAction(s, { type: 'END_TURN' });
  if (!e.ok) break;
  s = e.state;
}

const fin = linked(true);
const finBridges = s.units.filter((u) => u.owner === SIDE && u.type.startsWith('bridge'));
const finConnected = linked(false).linked;
const finCritical = finConnected ? finBridges.filter((b) => isCriticalBridge(b.x, b.y)).length : 0;
const finOk = !fin.linked ? '无桥断开→需要桥' : '无桥也连通→不需要桥';
const finKeep = ((s.aiFocus as Record<string, { plan?: { keep?: Record<string, unknown> } }> | undefined)?.[SIDE]?.plan?.keep ?? {}) as Record<string, unknown>;
const bc = blockCities();
console.log(
  `终局 ${s.winner ?? '平'}（${s.turn} 回合）· ${finOk} · 实际连通 ${finConnected ? '是' : '否'}` +
    ` · 桥 ${finBridges.length}（关键 ${finCritical}）` +
    ` · 块城数 [${bc.counts.join(',')}]${bc.emptyBlocks > 0 ? `（无城块 ${bc.emptyBlocks}）` : ''}` +
    ` · 断路 ${finKeep.noLink ?? '-'}`,
);
