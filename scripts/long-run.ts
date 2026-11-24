/**
 * 长局：对称开局打满 N 手，盯**四个指标**，不是只看胜负。
 *
 *   node --experimental-strip-types scripts/long-run.ts --size 24 --seed 1401 --turns 120
 *
 * 指标（每 10 手记一行）：
 *   · 经济总产（我 / 敌）—— 滚雪球的前提
 *   · 战斗兵数（我 / 敌）—— 兵力曲线
 *   · 城数（我 / 敌）—— 地盘
 *   · 金 —— 钱有没有花出去
 *
 * 顺带写出回放（`--replay out.json`），能拖进游戏逐手看。
 */
import { writeFileSync } from 'node:fs';
import { applyAction, unitYieldAt, utype } from '../src/core/rules.ts';
import { createMatch, DEFAULT_CONFIG } from '../src/core/setup.ts';
import { buildMatchReport } from '../src/core/report.ts';
import { aiNextActionV4, resetV4 } from '../src/core/v4/ai-v4.ts';
import { DEFAULT_BUDGET, aiActionKey, AI_MAX_STEPS } from '../src/core/ai.ts';
import type { Action, GameState, PlayerId } from '../src/core/types.ts';

const arg = (k: string, d = ''): string => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? (process.argv[i + 1] ?? d) : d;
};
const SIZE = Number(arg('size', '24'));
const SEED = Number(arg('seed', '1401'));
const TURNS = Number(arg('turns', '120'));
const EVERY = Number(arg('every', '10'));
const REPLAY = arg('replay', '');
const ME_AI = arg('me-ai', 'v4');

const foe = (await import('../src/core/ai.ts')).aiNextAction as unknown as (
  s: GameState,
  b: typeof DEFAULT_BUDGET,
  r: Set<string>,
) => Action | null;

const config = { ...DEFAULT_CONFIG, size: SIZE, startEra: 2, mapSymmetry: 'fair' as const, aiOpponent: true, aiSeats: ['B'] as PlayerId[] };
let s: GameState = createMatch(config, SEED);
s = { ...s, current: 'A' };
resetV4();

const actions: Array<Action & { by: 'A' | 'B' }> = [];
const econOf = (st: GameState, p: 'A' | 'B'): number =>
  st.units.filter((u) => u.owner === p && utype(st, u.type).category === 'economy')
    .reduce((n, u) => n + (unitYieldAt(st, u, u.x, u.y).gold ?? 0), 0);
const combatOf = (st: GameState, p: 'A' | 'B'): number =>
  st.units.filter((u) => u.owner === p && utype(st, u.type).category === 'combat').length;
const citiesOf = (st: GameState, p: 'A' | 'B'): number => st.cities.filter((c) => c.owner === p).length;

const head = ['手', '经济 我/敌', '战斗兵 我/敌', '城 我/敌', '金 我/敌'];
console.log(head.join(' | '));
console.log(['---', '--------', '----------', '------', '------'].join(' | '));

for (let i = 0; i < TURNS / 2 && !s.winner; i++) {
  for (const who of ['A', 'B'] as const) {
    const rej = new Set<string>();
    const budget = { ...DEFAULT_BUDGET };
    for (let k = 0; k < AI_MAX_STEPS && !s.winner; k++) {
      const a = who === 'A' ? aiNextActionV4(s, budget, rej) : foe(s, budget, rej);
      if (!a) break;
      const r = applyAction(s, a);
      if (!r.ok) {
        rej.add(aiActionKey(a));
        continue;
      }
      rej.clear();
      if (a.type === 'RECRUIT') budget.recruited += 1;
      actions.push({ ...a, by: who });
      s = r.state;
    }
    if (!s.winner) {
      const r = applyAction(s, { type: 'END_TURN' });
      if (!r.ok) break;
      actions.push({ type: 'END_TURN', by: who });
      s = r.state;
    }
  }
  if ((i + 1) % EVERY === 0 || s.winner) {
    console.log(
      [
        s.turn,
        `${econOf(s, 'A')}/${econOf(s, 'B')}`,
        `${combatOf(s, 'A')}/${combatOf(s, 'B')}`,
        `${citiesOf(s, 'A')}/${citiesOf(s, 'B')}`,
        `${s.players.A.gold}/${s.players.B.gold}`,
      ].join(' | '),
    );
  }
}

console.log(`\n结束：${s.winner ? `${s.winner} 胜` : '未分胜负'}（第 ${s.turn} 手）· ${ME_AI} vs auto`);
if (REPLAY) {
  const report = { ...buildMatchReport(s, new Date(), null, actions), initial: createMatch(config, SEED) };
  writeFileSync(REPLAY, JSON.stringify(report));
  console.log(`回放：${REPLAY}`);
}
