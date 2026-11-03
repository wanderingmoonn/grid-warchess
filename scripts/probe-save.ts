/**
 * 攒钱机制的体检：把"AI 为什么没出兵"从猜测变成几个可数的指标。
 *
 * 为什么要有这个：改 allowance（攒钱期可动用现金）时，胜负只有一个数字，
 * 而"钱攒住了但产线也停住了"和"钱没攒住但一直在出兵"在胜负上看不出区别——
 * 它们只是两种输法。真正要数的是每回合的这几件事：
 *
 *   · save   这一方处在攒钱期的回合数（按目标分：unit / hero / era / rebuild）
 *   · frozen 攒钱期里**一分钱都不能花**的回合数 —— 老 allowance 的典型形状
 *   · stall  账上的钱够买最便宜的兵、这一回合却什么都没造（兵也没造、建筑也没造）
 *   · rec    采购次数（÷回合 = 产线速度）
 *   · hero   英雄购买数、upg 升城次数、era 终局最高时代
 *
 * 老 allowance 的病症是 frozen 高、rec 低、stall 高；目标是 frozen→0、
 * rec 不掉、stall 掉，同时 hero / upg / era 不能跟着一起掉（那说明 AI 变成
 * 只顾眼前了，赢了指标输了棋）。
 *
 * 用法：
 *   node --experimental-strip-types scripts/probe-save.ts --games 6 --ai new
 *   node --experimental-strip-types scripts/probe-save.ts --games 6 --ai baseline
 * 两个跑同样的种子，输出可以直接对着看。
 */

import { AI_MAX_STEPS, aiDebugPlan, aiNextAction as newAi } from '../src/core/ai.ts';
import { applyAction, citiesOf, recruitCost } from '../src/core/rules.ts';
import { DEFAULT_CONFIG, createMatch } from '../src/core/setup.ts';
import type { GameState, PlayerId, UnitTypeDef } from '../src/core/types.ts';
// 冻结的旧版 AI：变量做 specifier，别让 tsc 把它拉进类型检查（同 ai-duel）
const BASE_FILE = './baseline-ai.ts';
const baseMod = (await import(BASE_FILE)) as {
  aiNextAction: typeof newAi;
  aiDebugPlan: typeof aiDebugPlan;
};

const args = process.argv.slice(2);
const argOf = (name: string, dflt: string): string => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? (args[i + 1] as string) : dflt;
};
const GAMES = Number(argOf('games', '6'));
const SEED = Number(argOf('seed', '900'));
const ERA = Number(argOf('era', '3'));
const SIZE = Number(argOf('size', '20'));
const CAP = Number(argOf('cap', '200'));
const WHICH = argOf('ai', 'new') === 'baseline' ? 'baseline' : 'new';
const PACKS = argOf(
  'exp',
  [
    'bloodbath',
    'turn-order-comp',
    'pack-contemporary',
    'pack-contemporary-war',
    'fantasy-core',
    'fantasy-knights',
    'fantasy-beasts',
    'fantasy-arcane',
    'fantasy-heroes',
  ].join(','),
)
  .split(',')
  .filter(Boolean);

const ai = WHICH === 'new' ? newAi : baseMod.aiNextAction;
const debugPlan = WHICH === 'new' ? aiDebugPlan : baseMod.aiDebugPlan;

interface Stat {
  sideTurns: number;
  save: number;
  frozen: number;
  stall: number;
  rec: number;
  build: number;
  upg: number;
  hero: number;
  goldSum: number;
  saveTurns: Record<string, number>;
  notes: Map<string, number>;
}
const empty = (): Stat => ({
  sideTurns: 0,
  save: 0,
  frozen: 0,
  stall: 0,
  rec: 0,
  build: 0,
  upg: 0,
  hero: 0,
  goldSum: 0,
  saveTurns: {},
  notes: new Map(),
});
const tot: Record<PlayerId, Stat> = { A: empty(), B: empty(), C: empty(), D: empty() };

/** 这一方现在买得起的最便宜战斗兵（拿来判"钱够却没造东西"） */
function cheapestCombat(s: GameState, p: PlayerId): number {
  const era = Math.max(...citiesOf(s, p).map((c) => c.era), 1);
  let best = Infinity;
  for (const d of Object.values(s.unitTypes) as UnitTypeDef[]) {
    if (d.category !== 'combat' || d.summonedOnly) continue;
    if (d.era > era) continue;
    const c = recruitCost(s, p, d);
    if (c > 0 && c < best) best = c;
  }
  return best;
}

let turnsSum = 0;
const wins: Record<string, number> = {};

for (let g = 0; g < GAMES; g++) {
  let s: GameState = createMatch(
    { ...DEFAULT_CONFIG, startEra: ERA, size: SIZE, aiLevel: 'advanced', expansionIds: PACKS },
    SEED + g,
  );

  while (!s.winner && s.turn <= CAP) {
    const me = s.current;
    const st = tot[me];
    const goldBefore = s.players[me].gold;
    const plan = debugPlan(s, me);
    const cheap = cheapestCombat(s, me);
    let rec = 0;
    let built = 0;

    st.sideTurns += 1;
    st.goldSum += goldBefore;
    if (plan.savingFor) {
      st.save += 1;
      st.saveTurns[plan.savingFor] = (st.saveTurns[plan.savingFor] ?? 0) + 1;
      if (plan.allowance === 0) st.frozen += 1;
      const note = (plan as { goalNote?: string }).goalNote ?? '';
      if (note) st.notes.set(note, (st.notes.get(note) ?? 0) + 1);
    }

    const budget = { maxRecruit: 2, maxUpgrade: 1, recruited: 0, upgraded: 0 };
    for (let i = 0; i < AI_MAX_STEPS && !s.winner; i++) {
      const a = ai(s, budget);
      if (!a) break;
      if (a.type === 'RECRUIT') {
        budget.recruited += 1;
        rec += 1;
        if ((s.unitTypes[a.unitType] as UnitTypeDef | undefined)?.hero === true) st.hero += 1;
      }
      if (a.type === 'BUILD') built += 1;
      if (a.type === 'UPGRADE') {
        budget.upgraded += 1;
        st.upg += 1;
      }
      const r = applyAction(s, a);
      if (!r.ok) break;
      s = r.state;
    }
    st.rec += rec;
    st.build += built;
    // 钱够买最便宜的兵、这一回合却既没造兵也没造东西：产线空转
    if (rec === 0 && built === 0 && goldBefore >= cheap && goldBefore > 0) st.stall += 1;

    if (s.winner) break;
    const end = applyAction(s, { type: 'END_TURN' });
    if (!end.ok) break;
    s = end.state;
  }

  turnsSum += s.turn;
  const key = s.winner ?? 'draw';
  wins[key] = (wins[key] ?? 0) + 1;
  // 终局最高时代：这一局两边各自到哪一代了
  for (const p of ['A', 'B'] as PlayerId[]) {
    const era = citiesOf(s, p).reduce((m, c) => Math.max(m, c.era), 0);
    const st = tot[p];
    (st as unknown as { endEra?: number }).endEra = era;
  }
}

const pct = (n: number, d: number): string => `${((n / Math.max(1, d)) * 100).toFixed(0)}%`;
const sides = (['A', 'B'] as PlayerId[]).filter((p) => tot[p].sideTurns > 0);
const agg = empty();
const eraSum = (p: PlayerId): number =>
  ((tot[p] as unknown as { endEra?: number }).endEra ?? 0) || 0;
let eras = 0;
for (const p of sides) {
  const st = tot[p];
  for (const [k, v] of Object.entries(st.saveTurns)) agg.saveTurns[k] = (agg.saveTurns[k] ?? 0) + v;
  agg.sideTurns += st.sideTurns;
  agg.save += st.save;
  agg.frozen += st.frozen;
  agg.stall += st.stall;
  agg.rec += st.rec;
  agg.build += st.build;
  agg.upg += st.upg;
  agg.hero += st.hero;
  agg.goldSum += st.goldSum;
  eras += eraSum(p);
  for (const [k, v] of st.notes) agg.notes.set(k, (agg.notes.get(k) ?? 0) + v);
}

console.log(
  `${WHICH} · ${GAMES} 局 · era${ERA} · ${SIZE}×${SIZE} · 均 ${(turnsSum / Math.max(1, GAMES)).toFixed(0)} 回合` +
    ` · 结果 ${Object.entries(wins).map(([k, v]) => `${k}:${v}`).join(' ')}`,
);
console.log(
  `侧回合 ${agg.sideTurns} ｜ 攒钱期 ${agg.save} (${pct(agg.save, agg.sideTurns)})` +
    ` ｜ 其中一分不能花 ${agg.frozen} (${pct(agg.frozen, agg.sideTurns)})` +
    ` ｜ 产线空转 ${agg.stall} (${pct(agg.stall, agg.sideTurns)})`,
);
console.log(
  `采购 ${agg.rec} (${(agg.rec / Math.max(1, agg.sideTurns)).toFixed(2)}/回合)` +
    ` ｜ 建造 ${agg.build} ｜ 升城 ${agg.upg}` +
    ` ｜ 英雄 ${agg.hero} ｜ 平均余额 ${(agg.goldSum / Math.max(1, agg.sideTurns)).toFixed(0)}` +
    ` ｜ 终局时代均 ${(eras / Math.max(1, sides.length)).toFixed(1)}`,
);
console.log(
  `攒钱目标构成：${Object.entries(agg.saveTurns)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k} ${v}`)
    .join(' / ') || '-'}`,
);
const topNotes = [...agg.notes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
if (topNotes.length > 0) {
  console.log('最常出现的目标：');
  for (const [n, v] of topNotes) console.log(`  ${String(v).padStart(4)}× ${n}`);
}
// 分边对账：两边口径必须对称，一边多一边少说明统计写错了
for (const p of sides) {
  const st = tot[p];
  console.log(
    `  ${p}: 侧回合 ${st.sideTurns} 攒钱期 ${st.save} 冻结 ${st.frozen} 空转 ${st.stall}` +
      ` 采购 ${st.rec} 升城 ${st.upg} 英雄 ${st.hero} 均余额 ${(st.goldSum / Math.max(1, st.sideTurns)).toFixed(0)}`,
  );
}
