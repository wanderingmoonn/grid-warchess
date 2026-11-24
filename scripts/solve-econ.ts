/**
 * 经济题的标准答案：**枚举造兵顺序，用真实引擎模拟，取 8 手后经济最大者**。
 *
 *   node --experimental-strip-types scripts/solve-econ.ts --exam S-015 --turns 8
 *
 * 为什么用枚举而不是公式：回本回合数只回答"值不值"，回答不了
 * "出兵格只够一回合造两个、走过去要两回合、钱还不够"这些**时序**问题。
 * 空间很小（金 250 最多 5 个经济兵、4 种型号），穷举比建模更可靠。
 */
import { readFileSync } from 'node:fs';
import { applyAction, reachableTiles, unitYieldAt } from '../src/core/rules.ts';
import type { Action, GameState } from '../src/core/types.ts';

const arg = (k: string, d = ''): string => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? (process.argv[i + 1] ?? d) : d;
};
const EXAM = arg('exam', 'S-015');
const TURNS = Number(arg('turns', '8'));
const A_TURNS = Math.floor(TURNS / 2); /* 8 手 = A 走 4 次 */
const TYPES = ['farmer', 'herder', 'lumberjack', 'planter'];

const snap = JSON.parse(readFileSync(`exams/${EXAM}/snap.json`, 'utf8')).state as GameState;
const econTotal = (s: GameState): number =>
  s.units.filter((u) => u.owner === 'A' && s.unitTypes[u.type]?.category === 'economy')
    .reduce((n, u) => n + (unitYieldAt(s, u, u.x, u.y).gold ?? 0), 0);

/** A 的半手：招一个（可空），然后所有经济兵去"能到的最高产格"，再结束回合 */
function playTurn(s: GameState, want: string | null): { s: GameState; built: boolean } {
  let built = false;
  if (want) {
    const city = s.cities.find((c) => c.owner === 'A');
    if (city) {
      const a: Action = { type: 'RECRUIT', cityId: city.id, unitType: want };
      const before = s.players.A.gold;
      const r = applyAction(s, a);
      /* 对账：只有真的扣了钱才算造出来（之前把"尝试"当成了"成功"） */
      if (r.ok && r.state.players.A.gold === before - (s.unitTypes[want]?.cost ?? 0)) {
        s = r.state;
        built = true;
      }
    }
  }
  for (;;) {
    const u = s.units.find((x) => x.owner === 'A' && s.unitTypes[x.type]?.category === 'economy' && !x.moved);
    if (!u) break;
    let best: { x: number; y: number } | null = null;
    let bestG = unitYieldAt(s, u, u.x, u.y).gold ?? 0;
    for (const [k] of reachableTiles(s, u)) {
      const x = k % s.w;
      const y = Math.floor(k / s.w);
      /* 被占的格不能去（原来没排掉自己人，一被拒就整轮卡住） */
      if (s.units.some((v) => v.id !== u.id && v.x === x && v.y === y)) continue;
      const g = unitYieldAt(s, u, x, y).gold ?? 0;
      if (g > bestG) {
        bestG = g;
        best = { x, y };
      }
    }
    const mv: Action | null = best ? { type: 'MOVE', unitId: u.id, x: best.x, y: best.y } : null;
    if (mv) {
      const r = applyAction(s, mv);
      if (r.ok) {
        s = r.state;
        continue;
      }
    }
    /* 走不动就标记掉，免得死循环 */
    const skip = applyAction(s, { type: 'MOVE', unitId: u.id, x: u.x, y: u.y });
    if (!skip.ok) break;
    s = skip.state;
  }
  const r = applyAction(s, { type: 'END_TURN' });
  /* B 什么都不做，直接过 */
  const b = applyAction(r.ok ? r.state : s, { type: 'END_TURN' });
  return { s: b.ok ? b.state : r.ok ? r.state : s, built };
}

type Plan = string[];
const combos: Plan[] = [];
const build = (cur: Plan): void => {
  if (cur.length === A_TURNS) {
    combos.push(cur);
    return;
  }
  for (const ty of [null, ...TYPES] as Array<string | null>) build(ty ? [...cur, ty] : [...cur, '']);
};

function run(plan: Plan): { econ: number; built: number; gold: number } {
  let s = { ...(JSON.parse(JSON.stringify(snap)) as GameState), current: 'A' } as GameState;
  let built = 0;
  for (let i = 0; i < A_TURNS; i++) {
    const r = playTurn(s, plan[i] || null);
    s = r.s;
    if (r.built) built += 1;
  }
  return { econ: econTotal(s), built, gold: s.players.A.gold };
}

build([]);
const scored = combos.map((plan) => ({ plan, ...run(plan) })).sort((a, b) => b.econ - a.econ);
const best = scored[0]!;
/* 钱多钱少各跑一遍：看"最后一个买什么"有没有变成分岔 */
for (const g of [250]) {
  snap.players.A.gold = g;
  const sc = combos.map((plan) => ({ plan, ...run(plan) })).sort((a, b) => b.econ - a.econ);
  console.log(`[金 ${g}] 最优 ${sc[0]!.econ}（${sc[0]!.plan.filter(Boolean).join('+') || '不造'}）· 次优 ${sc[1]!.econ}（${sc[1]!.plan.filter(Boolean).join('+') || '不造'}）`);
}
console.log(`\n最优：${best.plan.filter(Boolean).join(' → ') || '（不造）'} → ${TURNS} 手后经济 ${best.econ}（造了 ${best.built} 个，剩 ${best.gold} 金）`);
console.log('分布：');
const groups = new Map<string, number>();
for (const x of scored) {
  const key = x.plan.filter(Boolean).join('+') || '不造';
  if (!groups.has(key)) groups.set(key, x.econ);
}
const uniq = [...groups].sort((a, b) => b[1] - a[1]);
console.log(`  共 ${uniq.length} 种组合；最高 ${uniq[0]![1]}，最低 ${uniq[uniq.length-1]![1]}`);
for (const [k, v] of uniq.slice(0, 6)) console.log(`  ${k.padEnd(30)} ${v}`);
console.log('  …');
for (const [k, v] of uniq.slice(-4)) console.log(`  ${k.padEnd(30)} ${v}`);
console.log('\n前十：');
for (const x of scored.slice(0, 10)) {
  console.log(`  ${(x.plan.filter(Boolean).join('+') || '不造').padEnd(34)} 经济 ${String(x.econ).padStart(3)} · 造 ${x.built} · 剩 ${x.gold}`);
}
