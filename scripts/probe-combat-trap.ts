/**
 * 探针：经济单位把城围满，军队出不出得去？
 *
 * 为什么要有它（`docs/PLAN-YIELD-2026-11-22.md` 第 0 步）：
 * 现在两套机制处理"城格被占"，方向还相反——
 *   · `chokedCities`（产兵格 = 0）给**战斗单位**一个"出城 +150"，让它自己挤出去；
 *   · `buildYieldChain` 让**经济单位**腾位，但触发条件是"城格上有经济/建造单位"。
 * 所以"军队被经济围在城里、城外一圈也全占满"这个局面，两边都不管：
 * 出城的 8 邻格全被占 → MOVE 候选全部非法 → 一步也走不了。
 *
 * 构造：
 *   1. A 城摆在地图中间，城格上站 1 个战斗单位（产兵格直接归 0）；
 *   2. 城周围**两圈**全部塞满经济单位（farmer）；城格上**不放**经济单位——
 *      放了就会命中 `buildYieldChain`，测的就不是"军队被围"了；
 *   3. 双方各留一个兵/一座城，钱清零，避免采购与出局判定干扰。
 *
 * 判据：战斗单位这一边**动了几次**、最终走了多远。0 次 = 死锁。
 *
 * 跑法：`npm run probe:combat-trap`
 */
import { DEFAULT_CONFIG, createMatch } from '../src/core/setup.ts';
import { applyAction, recruitSpawnCells } from '../src/core/rules.ts';
import { placeUnit } from '../src/core/sandbox.ts';
import { DEFAULT_BUDGET } from '../src/core/ai.ts';
import { aiNextAction } from '../src/core/ai-v3.ts';
import type { GameState, PlayerId } from '../src/core/types.ts';

const me: PlayerId = 'A';
const W = 12;
const ROUNDS = 8;
const STEPS_PER_TURN = 60;
const CITY_X = 4;
const CITY_Y = 4;

let s: GameState = createMatch(
  { ...DEFAULT_CONFIG, size: W, startEra: 2, mapSymmetry: 'fair' },
  30,
);
s = structuredClone(s);
s.units = [];

const mine = s.cities.filter((c) => c.owner === me);
const foes = s.cities.filter((c) => c.owner !== me);
if (mine.length === 0 || foes.length === 0) throw new Error('这张图没有双方城市，换种子');
const foeSeat = foes[0]!.owner;

function repaintCity(c: (typeof s.cities)[number], x: number, y: number, owner: PlayerId): void {
  c.x = x;
  c.y = y;
  c.owner = owner;
  for (let dy = 0; dy < 2; dy++) {
    for (let dx = 0; dx < 2; dx++) {
      const t = s.tiles[(y + dy) * W + (x + dx)];
      if (!t) continue;
      t.terrain = 'city';
      (t as { cityId?: string }).cityId = c.id;
    }
  }
}

for (let y = 0; y < W; y++) {
  for (let x = 0; x < W; x++) {
    const t = s.tiles[y * W + x]!;
    t.terrain = 'plain';
    (t as { cityId?: string }).cityId = undefined;
  }
}

/*
 * 双方各留一座城，其余删掉（连同城格地形）。
 * 多留几座敌城会各自产钱、自己造兵造工人，干扰观察——见 `probe:bridge-block` 的同一处坑。
 */
const keepMine = mine[0]!;
const keepFoe = foes[0]!;
for (const c of [...mine.slice(1), ...foes.slice(1)]) {
  for (let dy = 0; dy < 2; dy++) {
    for (let dx = 0; dx < 2; dx++) {
      const t = s.tiles[(c.y + dy) * W + (c.x + dx)];
      if (t && (t as { cityId?: string }).cityId === c.id) {
        t.terrain = 'plain';
        (t as { cityId?: string }).cityId = undefined;
      }
    }
  }
}
s.cities = s.cities.filter((c) => c.id === keepMine.id || c.id === keepFoe.id);
repaintCity(keepMine, CITY_X, CITY_Y, me);
repaintCity(keepFoe, 9, 9, foeSeat);

const put = (owner: PlayerId, type: string, x: number, y: number): boolean => {
  const r = placeUnit(s, owner, type, x, y);
  if (r.ok) s = r.state;
  return r.ok;
};

/*
 * 城格 2×2 **四格全站战斗单位**。
 *
 * 只站一格（产兵格 3）测出来是假象：经济单位会自己溜进城格，于是
 * `buildYieldChain` 被触发、主动腾位，第 6 回合军队就出来了——那测的是
 * "经济腾位生效"，不是"军队被围死"。
 * 四格全占之后产兵格 = 0、城格上没有经济单位，两条机制都不管这一段。
 */
const trapCells: Array<[number, number]> = [
  [CITY_X, CITY_Y],
  [CITY_X + 1, CITY_Y],
  [CITY_X, CITY_Y + 1],
  [CITY_X + 1, CITY_Y + 1],
];
const traps: string[] = [];
for (const [x, y] of trapCells) {
  const r = placeUnit(s, me, 'militia', x, y);
  if (r.ok) {
    s = r.state;
    traps.push(`${x},${y}`);
  }
}
if (traps.length === 0) throw new Error('战斗单位放不下城格');


/**
 * 城周围两圈塞满经济单位。
 *
 * 第一圈（2×2 城格之外那一环）是"出城的第一步"，必须占住——只堵第二圈的话，
 * 战斗单位能走出城、只是走不远，那测的是"推进受阻"，不是"出不来"。
 */
let farmers = 0;
for (let dy = -2; dy <= 3; dy++) {
  for (let dx = -2; dx <= 3; dx++) {
    const x = CITY_X + dx;
    const y = CITY_Y + dy;
    if (x < 0 || y < 0 || x >= W || y >= W) continue;
    if (x >= CITY_X && x <= CITY_X + 1 && y >= CITY_Y && y <= CITY_Y + 1) continue; // 城格留空
    if (s.units.some((u) => u.x === x && u.y === y)) continue;
    if (put(me, 'farmer', x, y)) farmers += 1;
  }
}

s.players[me].gold = 0;
for (const p of Object.keys(s.players) as PlayerId[]) if (p !== me) s.players[p].gold = 0;
// 对手留一个兵：钱清零后"没兵 + 造不起"就判出局，对局第 1 回合就结束了
const foeUnit = placeUnit(s, foeSeat, 'militia', 11, 11);
if (foeUnit.ok) s = foeUnit.state;
/*
 * 把这只兵**围死**（东南角，堵住 (10,11)/(11,10) 两格）。
 *
 * 不围住会测出假象：对手的兵会自己走过来，而 `tacticalMoveScore` 里经济单位
 * 有一条"躲威胁"（`(currentThreat - futureThreat) * 2`），农民一被吓就往
 * 远离敌人的方向跑，看起来像"经济单位自己让开了路"。
 * 实测就是这么坑的：第 5 回合出现 22.5 分的 farmer 逃跑动作，
 * 而我一度把它当成"让位机制开始工作"。
 */
for (const [x, y] of [
  [10, 11],
  [11, 10],
] as Array<[number, number]>) {
  const t = s.tiles[y * W + x];
  if (t && !s.units.some((u) => u.x === x && u.y === y)) t.terrain = 'mountain';
}
/*
 * 每回合把**双方**的钱清空。
 *
 * 对手是为了不让它自己架桥/造兵；我方是为了不让它在城内攒钱造新兵——
 * 一开始只清了对手，结果第 8 回合我方多出 2 个兵（收入攒够 25 金就造），
 * 产兵格跟着变，看不出到底是"让位"还是"新兵占位"。
 */
const drainBoth = (): void => {
  for (const p of Object.values(s.players)) {
    p.gold = 0;
    if (p.res) for (const k of Object.keys(p.res) as Array<keyof typeof p.res>) p.res[k] = 0;
  }
};

const city = s.cities.find((c) => c.id === keepMine.id)!;
const spawnCells = (): number => recruitSpawnCells(s, city.id, undefined, 'militia').length;
/** 所有战斗单位里"离家最远"的那个：只要有一个出去了，就说明路开了 */
const trapper = (): { x: number; y: number } | null => {
  const us = s.units.filter((z) => z.owner === me && s.unitTypes[z.type]?.category === 'combat');
  if (us.length === 0) return null;
  return us
    .map((u) => ({ x: u.x, y: u.y, d: Math.max(Math.abs(u.x - city.x), Math.abs(u.y - city.y)) }))
    .sort((a, b) => b.d - a.d)[0]!;
};
const distToCity = (): number => {
  const t = trapper();
  if (!t) return -1;
  let best = 99;
  for (let dy = 0; dy < 2; dy++) {
    for (let dx = 0; dx < 2; dx++) {
      best = Math.min(best, Math.max(Math.abs(t.x - (city.x + dx)), Math.abs(t.y - (city.y + dy))));
    }
  }
  return best;
};
/** 战斗单位总数（有人出城就算赢，不用管是哪一只） */
const combatCount = (): number =>
  s.units.filter((z) => z.owner === me && s.unitTypes[z.type]?.category === 'combat').length;
/** 战斗单位 8 邻格里能站的空格 */
const freeAround = (): number => {
  const t = trapper();
  if (!t) return 0;
  let n = 0;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      const x = t.x + dx;
      const y = t.y + dy;
      if (x < 0 || y < 0 || x >= W || y >= W) continue;
      const tile = s.tiles[y * W + x]!;
      if (tile.terrain === 'water' || tile.terrain === 'mountain') continue;
      if (s.units.some((u) => u.x === x && u.y === y)) continue;
      n += 1;
    }
  }
  return n;
};

console.log(`地图 ${W}×${W} · 城 (${CITY_X},${CITY_Y}) · 战斗单位 ${traps.length} 个占满城格（${traps.join(' ')}）`);
{
  // 按 buildSlotPlan 的规则复算一遍，确认关键格到底有没有生成
  const cityTiles2: Array<{ x: number; y: number }> = [];
  for (let dy = 0; dy < city.size; dy++) for (let dx = 0; dx < city.size; dx++) cityTiles2.push({ x: city.x + dx, y: city.y + dy });
  const insideCat = cityTiles2.map((t) => {
    const u = s.units.find((z) => z.x === t.x && z.y === t.y);
    return u ? s.unitTypes[u.type]?.category ?? '?' : '空';
  });
  const combatInside = insideCat.includes('combat');
  const exits: string[] = [];
  if (combatInside) {
    for (const t of cityTiles2) {
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as Array<[number, number]>) {
        const x = t.x + dx;
        const y = t.y + dy;
        const tile = s.tiles[y * W + x];
        if (!tile || tile.terrain === 'city') continue;
        if (!s.units.some((u) => u.x === x && u.y === y && u.owner === me)) continue;
        exits.push(`${x},${y}`);
      }
    }
  }
  console.log(`  [构造] 城格类别 ${insideCat.join('/')} · 出城关键格 ${exits.length} 个：${exits.join(' ') || '无'}`);
}
console.log(
  `塞入经济单位 ${farmers} 个（城周围两圈，城格除外）· 产兵格 ${spawnCells()} · 出城邻格空 ${freeAround()}`,
);

function playRound(): { moves: number; combat: number; econ: number; acts: string[] } {
  let moves = 0;
  let combat = 0;
  let econ = 0;
  const acts: string[] = [];
  let guard = 0;
  while (!s.winner && s.current !== me && guard++ < 6) {
    /*
     * 清账要放在**对手回合开始之前**。放在 END_TURN 之前没用：它在自己回合里
     * 拿到收入就当场花了（实测第 9 回合还是把桥铺到了桥点上）。
     */
    drainBoth();
    for (let i = 0; i < STEPS_PER_TURN; i++) {
      const a = aiNextAction(s, { ...DEFAULT_BUDGET }, new Set());
      if (!a) break;
      const r = applyAction(s, a);
      if (!r.ok) break;
      s = r.state;
    }
    drainBoth();
    const e = applyAction(s, { type: 'END_TURN' });
    if (!e.ok) break;
    s = e.state;
  }
  if (s.winner || s.current !== me) return { moves, combat, econ, acts };
  // 我方回合开头也清一次：它在自己回合拿到收入就造兵，产兵格跟着变，
  // 就分不清"让位"和"新兵占位"了（实测多出 2 个兵）。
  drainBoth();
  for (let i = 0; i < STEPS_PER_TURN && !s.winner; i++) {
    const a = aiNextAction(s, { ...DEFAULT_BUDGET }, new Set());
    if (!a) break;
    const r = applyAction(s, a);
    if (!r.ok) break;
    s = r.state;
    /*
     * 只统计**我方**动作。以前没筛 owner，把对手在右下角调度农民也算成
     * "经济单位开始让位"了——实测第 5 回合那两次 MOVE 是 B 的 farmer
     * 在 (9,7)/(8,6)，离城六格远，跟让位一点关系没有。
     */
    {
      const uid = 'unitId' in a ? String((a as { unitId?: string }).unitId ?? '') : '';
      const u = s.units.find((z) => z.id === uid);
      if (!u || u.owner !== me) continue;
      acts.push(
        `${a.type}:${u.owner}:${u.type}@${u.x},${u.y}${'x' in a ? `→${(a as { x: number }).x},${(a as { y: number }).y}` : ''}`,
      );
    }
    if (a.type === 'MOVE') {
      const uid = 'unitId' in a ? String((a as { unitId?: string }).unitId ?? '') : '';
      const u = s.units.find((z) => z.id === uid);
      // 只算我方：对手在右下角调度自己的农民，跟"让位"没关系
      if (u && u.owner === me) {
        moves += 1;
        if (s.unitTypes[u.type]?.category === 'combat') combat += 1;
        else econ += 1;
      }
    }
  }
  if (!s.winner) {
    drainBoth();
    const e = applyAction(s, { type: 'END_TURN' });
    if (e.ok) s = e.state;
  }
  return { moves, combat, econ, acts };
}

const rows: string[] = [];
let firstOut = 0;
let idleTurns = 0;
/** 每回合"最远的那个人离城几格"。判"稳定在外"要看它，不能只看某回合到过 2 */
const dists: number[] = [];
for (let round = 1; round <= ROUNDS; round++) {
  const before = trapper();
  const r = playRound();
  const now = trapper();
  rows.push(
    `回合 ${round}：动作 ${r.acts.length} · MOVE ${r.moves}（战斗 ${r.combat} / 经济 ${r.econ}）· 最远战斗单位 ${before ? `${before.x},${before.y}` : '无'} → ${now ? `${now.x},${now.y}` : '无'} · 离城 ${distToCity()} · 出城邻格空 ${freeAround()} · 产兵格 ${spawnCells()}`,
  );
  if (r.acts.length === 0) idleTurns += 1;
  // 离城格 ≥2 = 已经离开城格和它的 8 邻格，不再堵产兵、也不再挡出城邻格
  dists.push(distToCity());
  if (!firstOut && distToCity() >= 2) firstOut = round;
  if (s.winner) {
    rows.push(`  ↑ 对局结束：${s.winner} 胜（探针被提前打断）`);
    break;
  }
}
for (const r of rows) console.log(r);

// ── 结论 ──
/*
 * "稳定在外"必须是**连续**的，不能只看某一回合到过 2 格。
 * 探针第一版只看 firstOut，于是"出去一步又回来"也判成解开——实测正是这样：
 * 5,4 ↔ 2,4 来回，firstOut=1 但根本没脱身。
 */
const last3 = dists.slice(-3);
const stable = last3.length === 3 && last3.every((v) => v >= 2);
console.log('—— 判定 ——');
console.log(`完全停摆的回合数 ${idleTurns}（这一回合我方一个动作都提不出来）`);
console.log(`离城距离序列 ${dists.join(' → ')}`);
console.log(
  stable
    ? `→ **能自己解开**：第 ${firstOut} 回合离开城格，最后 3 回合都稳定在外`
    : firstOut > 0
      ? `→ **震荡**：第 ${firstOut} 回合到过城格以外，但最后 3 回合是 ${last3.join('/')}——出去了又被拽回来`
      : '→ **出不来确认**：城格被占满、出城邻格全被占，没有任何机制会主动腾位',
);
console.log(`产兵格 ${spawnCells()}（0 = 城格仍被自己人占着）· 我方战斗单位 ${combatCount()} 个（起始 ${traps.length}）`);
