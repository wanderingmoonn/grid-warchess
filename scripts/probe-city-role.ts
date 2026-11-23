/**
 * 探针：v3 到底会不会"看城"？
 *
 * 用户 2026-11-23 的观察（这是要验的假设，不是结论）：
 *   1. 前线的城被威胁时，兵却在后方的城出生，然后慢慢走过去；
 *   2. 平原多的城造牧民，让牧民跋涉到丘陵多的城去干活。
 * 两条都指向同一件事：**选产兵点时，城的位置和城周边的地形没有参与打分**。
 *
 * 这个探针量三个数（都不改代码）：
 *
 *   A. 出兵点的"前线度"：每次 RECRUIT，选中的城离最近敌方战斗单位多少格，
 *      而所有自家城里最近的那座是多少格。差值 = **多跑几格**。
 *   B. 经济单位的"出生地适配度"：出生时，那座城附近最好的地形产出，
 *      与所有城里最好的一档比，差多少；以及它后来实际走了多远（跨城 = 白跑）。
 *   C. 威胁响应：敌方战斗单位已经贴到某座城 X 格内时，这一回合的兵
 *      有多少出在 X（该守的城），多少出在别处。
 *
 * 用法：
 *   node --experimental-strip-types scripts/probe-city-role.ts --queue Q1 --seed 30 --side A
 */
import { DEFAULT_CONFIG, createMatch } from '../src/core/setup.ts';
import { applyAction, unitYieldAt } from '../src/core/rules.ts';
import { AI_MAX_STEPS, DEFAULT_BUDGET, aiActionKey } from '../src/core/ai.ts';
import type { GameState, PlayerId, Unit } from '../src/core/types.ts';

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
const QID = argOf('queue', 'Q1').toUpperCase();
const q = QUEUES[QID];
if (!q) throw new Error(`没有队列 ${QID}`);
const SEED = Number(argOf('seed', '30'));
const SIDE = (argOf('side', 'A').toUpperCase() === 'A' ? 'A' : 'B') as PlayerId;

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

const cheb = (a: { x: number; y: number }, b: { x: number; y: number }): number =>
  Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

/** 敌方战斗单位（只算"能打的"，经济单位不算威胁） */
const foeCombat = (): Unit[] =>
  s.units.filter((u) => u.owner !== SIDE && u.hp > 0 && s.unitTypes[u.type]?.category === 'combat');

/** 离一座城最近的敌方战斗单位多少格；没有敌人就是 Infinity */
const foeGapTo = (c: { x: number; y: number }, foe: Unit[]): number =>
  foe.reduce((m, u) => Math.min(m, cheb(u, c)), Infinity);

/** 产出货币化（和 `resourceValue` 近似：非金资源按库存稀缺加权） */
const econValue = (yields: Record<string, number | undefined>, owner: PlayerId): number => {
  let sum = 0;
  for (const [id, n] of Object.entries(yields)) {
    const held = id === 'gold' ? s.players[owner].gold : (s.players[owner].res?.[id as 'wood'] ?? 0);
    const w = id === 'gold' ? 1 : 1 + 2 * Math.max(0, Math.min(1, 1 - held / 160));
    sum += (n ?? 0) * w;
  }
  return sum;
};

/**
 * 一座城周边 `R` 格内，**某个具体兵种**最好的产出。
 *
 * 口径要按兵种分开：牧民吃丘陵（8）、农民吃平原（7），混在一起算就变成
 * "每座城都一样好"——那正是现在的问题：打分用的是每个兵种的 `max(incomeByTerrain)`，
 * 也就是"假设它总能占到最好的地"。
 */
const ECON_R = 4;
const incomeOf = (t: string, typeId: string | null): number => {
  let best = 0;
  for (const d of Object.values(s.unitTypes)) {
    if (d.category !== 'economy') continue;
    if (typeId && d.id !== typeId) continue;
    if (!typeId && d.era > eraNow) continue; // 没指定兵种时只看当前买得到的
    const v = Number(d.incomeByTerrain?.[t as keyof typeof d.incomeByTerrain] ?? 0);
    if (v > best) best = v;
  }
  return best;
};
/** 当前时代（自家城最高时代），用来过滤"还买不到的经济兵" */
let eraNow = 1;
const bestIncomeNear = (c: { x: number; y: number }, typeId: string | null): number => {
  let best = 0;
  for (let dy = -ECON_R; dy <= ECON_R; dy++) {
    for (let dx = -ECON_R; dx <= ECON_R; dx++) {
      const x = c.x + dx;
      const y = c.y + dy;
      if (x < 0 || y < 0 || x >= s.w || y >= s.h) continue;
      const t = s.tiles[y * s.w + x]!;
      if (t.terrain === 'water' || t.terrain === 'city' || t.terrain === 'void') continue;
      const v = incomeOf(t.terrain, typeId);
      if (v > best) best = v;
    }
  }
  return best;
};

/* ---- 统计累加器 ---- */
let recruits = 0;
let combatRecruits = 0;
let econRecruits = 0;
let extraGapSum = 0; // A：多跑的格数合计
let extraGapMax = 0;
const samplesA: string[] = [];
let rearPicks = 0; // A：明明有更靠前的城，却选了不是最靠前的（且落后 ≥2 格）
let threatTurns = 0; // C：有城被威胁的回合数
let threatRecruits = 0; // C：这些回合里我方出的兵数
let threatAtHot = 0; // C：其中出在"被威胁那座城"的数量

let econSpawnBestSum = 0; // B：出生城附近最好产出（求和）
let econGlobalBestSum = 0; // B：当时全局最好（求和）
let econCrossCity = 0; // B：最终站到别的城 4 格内（跨城干活）
/** 每个经济单位：出生点、出生城、出生城附近最好产出、全局最好、走了多远、首次开始产出的距离 */
const econTrack = new Map<
  string,
  {
    home: { x: number; y: number };
    city: string;
    best: number;
    global: number;
    path: number;
    firstYieldDist: number | null;
    walkTurns: number;
  }
>();
/** 每个城出了多少兵：如果永远压在同一个城，说明"选城"其实是个常量 */
const cityPicks = new Map<string, number>();
/** B2：经济单位"站错地"的损失（产出差 × 单位-回合）与次数 */
let econYieldLoss = 0;
let econYieldTurns = 0;
let econWrongType = 0;
const wrongSamples: string[] = [];
/** B3：经济兵的兵种与出生城周边地形不匹配的次数 */
let econMatchSum = 0;

const noteRecruit = (cityId: string, city: { x: number; y: number }, unitType: string): void => {
  const def = s.unitTypes[unitType];
  if (!def) return;
  const foe = foeCombat();
  const own = s.cities.filter((c) => c.owner === SIDE && !c.ruined);
  const gaps = own.map((c) => ({ id: c.id, gap: foeGapTo(c, foe), c }));
  const mine = gaps.find((g) => g.id === cityId);
  const nearest = Math.min(...gaps.map((g) => g.gap));
  recruits += 1;
  cityPicks.set(cityId, (cityPicks.get(cityId) ?? 0) + 1);
  if (def.category === 'combat') {
    combatRecruits += 1;
    if (mine && Number.isFinite(mine.gap) && Number.isFinite(nearest)) {
      const extra = mine.gap - nearest;
      extraGapSum += extra;
      if (extra > extraGapMax) extraGapMax = extra;
      if (extra >= 2) {
        rearPicks += 1;
        if (samplesA.length < 12) {
          const front = gaps.filter((g) => g.gap === nearest).map((g) => g.id);
          samplesA.push(
            `T${s.turn} ${unitType} 出在 ${cityId}（离敌 ${mine.gap} 格）· 最近的是 ${front.join('/')}（${nearest} 格）· 多跑 ${extra}`,
          );
        }
      }
    }
    // C：这一回合有没有"被贴到 5 格内"的城
    const hot = gaps.filter((g) => g.gap <= 5);
    if (hot.length > 0) {
      threatRecruits += 1;
      if (hot.some((g) => g.id === cityId)) threatAtHot += 1;
    }
  }
  if (def.category === 'economy') {
    econRecruits += 1;
    const here = bestIncomeNear(city, unitType);
    const global = Math.max(...own.map((c) => bestIncomeNear(c, unitType)));
    econSpawnBestSum += here;
    econGlobalBestSum += global;
    /*
     * B3：这个兵种擅长的地形，在出生城周围**占多大比例**。
     * 牧民擅丘陵、农民擅平原——在平原城里出生一个牧民，等于一出生就错了。
     */
    const fav = Number(def.incomeByTerrain?.hill ?? 0) >= Number(def.incomeByTerrain?.plain ?? 0) ? 'hill' : 'plain';
    let same = 0;
    let tot = 0;
    for (let dy = -3; dy <= 3; dy++) {
      for (let dx = -3; dx <= 3; dx++) {
        const x = city.x + dx;
        const y = city.y + dy;
        if (x < 0 || y < 0 || x >= s.w || y >= s.h) continue;
        const t = s.tiles[y * s.w + x]!;
        if (t.terrain === 'water' || t.terrain === 'city' || t.terrain === 'void') continue;
        tot += 1;
        if (t.terrain === fav) same += 1;
      }
    }
    econMatchSum += tot > 0 ? same / tot : 0;
    // 记录出生点，之后看它走到哪去了
    const born = s.units.filter((u) => u.owner === SIDE && u.type === unitType);
    const fresh = born[born.length - 1];
    if (fresh && !econTrack.has(fresh.id)) {
      econTrack.set(fresh.id, {
        home: { x: fresh.x, y: fresh.y },
        city: cityId,
        best: here,
        global,
        path: 0,
        firstYieldDist: null,
        walkTurns: 0,
      });
    }
  }
};

while (!s.winner && s.turn <= q.cap) {
  const foe = foeCombat();
  const own = s.cities.filter((c) => c.owner === SIDE && !c.ruined);
  eraNow = own.length > 0 ? Math.max(...own.map((c) => c.era)) : 1;
  if (own.some((c) => foeGapTo(c, foe) <= 5)) threatTurns += 1;

  const budget = { ...DEFAULT_BUDGET };
  const rejected = new Set<string>();
  const moveTries = new Map<string, number>();
  for (let i = 0; i < AI_MAX_STEPS && !s.winner; i++) {
    const a = aiFor(s.current)(s, budget, rejected);
    if (!a) break;
    // RECRUIT 之前先记账：这一手选的是哪座城
    const rec = a.type === 'RECRUIT' ? a : null;
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
    if (rec && 'cityId' in rec && s.current === SIDE) {
      const city = s.cities.find((c) => c.id === (rec as { cityId?: string }).cityId);
      if (city) noteRecruit(city.id, city, rec.unitType);
    }
    if (a.type === 'RECRUIT') budget.recruited += 1;
    if (a.type === 'UPGRADE') budget.upgraded += 1;
  }
  if (s.winner) break;

  // 经济单位移动里程
  for (const [id, e] of econTrack) {
    const u = s.units.find((z) => z.id === id);
    if (!u) continue;
    const d = cheb(u, e.home);
    e.path = Math.max(e.path, d);
    const y = econValue(unitYieldAt(s, u, u.x, u.y), SIDE);
    if (e.firstYieldDist === null && y >= 2) e.firstYieldDist = d;
  }

/*
   * B2：站错地。拿它现在这一格的**实际产出**和"这一格上最好的经济兵种"比。
   * 牧民站平原（4）而农民能站 7 —— 差的 3 金就是"兵种选错了"。
   *
   * 只统计站在野外格上的：城格产出恒 0，新兵出生那一刻就站在城里，
   * 那是正常的中转，不是"站错地"。
   */
  for (const u of s.units) {
    if (u.owner !== SIDE || s.unitTypes[u.type]?.category !== 'economy') continue;
    const tile = s.tiles[u.y * s.w + u.x];
    if (!tile) continue;
    if (tile.terrain === 'city') continue;
    const actual = incomeOf(tile.terrain, u.type);
    const bestHere = incomeOf(tile.terrain, null);
    econYieldTurns += 1;
    if (bestHere > actual) {
      econYieldLoss += bestHere - actual;
      econWrongType += 1;
      if (wrongSamples.length < 6) {
        wrongSamples.push(
          `T${s.turn} ${u.type}@${tile.terrain} 产出 ${actual} · 该格上最好的经济兵能到 ${bestHere}`,
        );
      }
    }
  }

  const end = applyAction(s, { type: 'END_TURN' });
  if (!end.ok) break;
  s = end.state;
}

for (const [id, e] of econTrack) {
  const u = s.units.find((z) => z.id === id);
  if (!u) continue;
  const own = s.cities.filter((c) => c.owner === SIDE);
  const atHome = own.find((c) => c.id === e.city);
  const elsewhere = own.some((c) => c.id !== e.city && cheb(u, c) <= 4);
  if (elsewhere && !(atHome && cheb(u, atHome) <= 4)) econCrossCity += 1;
}

const avg = (n: number, d: number): string => (d === 0 ? '-' : (n / d).toFixed(2));
console.log(`${QID} seed=${SEED} 新版坐 ${SIDE} · 终局 ${s.winner ?? '平'}（${s.turn} 回合）`);
console.log(`采购 ${recruits} 次 = 战斗 ${combatRecruits} + 经济 ${econRecruits} + 其他 ${recruits - combatRecruits - econRecruits}`);
console.log('— A 出兵点的前线度（战斗单位）—');
console.log(
  `  平均多跑 ${avg(extraGapSum, combatRecruits)} 格 · 最远一次多跑 ${extraGapMax} 格 · ` +
    `「落后 ≥2 格」${rearPicks}/${combatRecruits}（${((rearPicks / Math.max(1, combatRecruits)) * 100).toFixed(0)}%）`,
);
for (const x of samplesA) console.log('    ' + x);
console.log('— B 经济单位的出生地适配 —');
console.log(
  `  出生城附近最好产出 平均 ${avg(econSpawnBestSum, econRecruits)} · 全局最好 平均 ${avg(econGlobalBestSum, econRecruits)}` +
    ` → 差 ${(econGlobalBestSum / Math.max(1, econRecruits) - econSpawnBestSum / Math.max(1, econRecruits)).toFixed(2)}`,
);
const far = [...econTrack.values()].filter((e) => e.path >= 4).length;
const firstD = [...econTrack.values()].filter((e) => e.firstYieldDist !== null);
const firstAvg = firstD.length
  ? firstD.reduce((a, e) => a + (e.firstYieldDist ?? 0), 0) / firstD.length
  : 0;
console.log(
  `  走了 ≥4 格的 ${far}/${econTrack.size} · 最终跑到**别的城** 4 格内的 ${econCrossCity}/${econTrack.size}` +
    ` · 开始产出的平均距离 ${firstAvg.toFixed(1)} 格`,
);
console.log('— D 出兵点分布（每次采购落在哪座城）—');
console.log(
  '  ' + [...cityPicks.entries()].map(([id, n]) => `${id}×${n}`).join(' · ') +
    `  （共 ${[...cityPicks.values()].reduce((a, b) => a + b, 0)} 次）`,
);
console.log('— B2 经济兵站错地（兵种 × 地形不匹配）—');
console.log(
  `  每回合平均少产 ${avg(econYieldLoss, econYieldTurns)} 金 · 站错地的单位-回合 ${econWrongType}/${econYieldTurns}` +
    `（${((econWrongType / Math.max(1, econYieldTurns)) * 100).toFixed(0)}%）`,
);
for (const x of wrongSamples) console.log('    ' + x);
console.log(
  `— B3 经济兵擅长的地形在出生城 7×7 里的占比：平均 ${((econMatchSum / Math.max(1, econRecruits)) * 100).toFixed(0)}%`,
);
console.log('— C 威胁响应 —');
console.log(
  `  有城被贴到 5 格内的回合 ${threatTurns} · 这些回合里出的兵 ${threatRecruits} · ` +
    `其中出在被威胁城 ${threatAtHot}（${((threatAtHot / Math.max(1, threatRecruits)) * 100).toFixed(0)}%）`,
);
