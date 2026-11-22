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
    acts.push(a.type);
    if (a.type === 'MOVE') {
      moves += 1;
      const uid = 'unitId' in a ? String((a as { unitId?: string }).unitId ?? '') : '';
      const u = s.units.find((z) => z.id === uid);
      const cat = u ? s.unitTypes[u.type]?.category : undefined;
      if (cat === 'combat') combat += 1;
      else econ += 1;
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
for (let round = 1; round <= ROUNDS; round++) {
  const before = trapper();
  const r = playRound();
  const now = trapper();
  rows.push(
    `回合 ${round}：动作 ${r.acts.length} · MOVE ${r.moves}（战斗 ${r.combat} / 经济 ${r.econ}）· 最远战斗单位 ${before ? `${before.x},${before.y}` : '无'} → ${now ? `${now.x},${now.y}` : '无'} · 离城 ${distToCity()} · 出城邻格空 ${freeAround()} · 产兵格 ${spawnCells()}`,
  );
  if (r.acts.length === 0) idleTurns += 1;
  if (!firstOut && distToCity() >= 3) firstOut = round;
  if (s.winner) {
    rows.push(`  ↑ 对局结束：${s.winner} 胜（探针被提前打断）`);
    break;
  }
}
for (const r of rows) console.log(r);

// ── 结论 ──
const d = distToCity();
console.log('—— 判定 ——');
console.log(`完全停摆的回合数 ${idleTurns}（这一回合我方一个动作都提不出来）`);
console.log(
  firstOut > 0
    ? `首次出城（离城 ≥3）第 ${firstOut} 回合`
    : `**${ROUNDS} 回合内一次都没出城**（最终离城 ${d} 格）`,
);
console.log(`产兵格 ${spawnCells()}（0 = 城格仍被自己人占着）· 我方战斗单位 ${combatCount()} 个（起始 ${traps.length}）`);
if (firstOut > 0) {
  console.log(
    `→ 能自己解开，但要 ${firstOut} 回合：前 ${idleTurns} 个回合完全停摆，之后靠经济单位自己散开让出通路`,
  );
} else {
  console.log('→ **出不来确认**：城格被占满、出城邻格全被占，没有任何机制会主动腾位');
}
