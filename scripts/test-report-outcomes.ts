import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nonWinCount, nonWinRate, summarizeOutcomes } from './report-outcomes.ts';

test('正式平局与提前截断的未决对局分别计数，不丢失结果', () => {
  const summary = summarizeOutcomes([
    { winner: 'A' }, { winner: 'B' }, { winner: 'draw' }, { winner: null },
  ]);
  assert.deepEqual(summary, {
    aWins: 1, bWins: 1, draws: 1, unresolved: 1,
    aRate: 0.25, bRate: 0.25, drawRate: 0.25, unresolvedRate: 0.25,
  });
  assert.equal(summary.aWins + summary.bWins + summary.draws + summary.unresolved, 4);
});

test('旧版未决统计与新版平局/未决合计可以用于历史对比', () => {
  assert.equal(nonWinCount({ draws: 3 }), 3);
  assert.equal(nonWinRate({ drawRate: 0.3 }), 0.3);
  assert.equal(nonWinCount({ draws: 1, unresolved: 2 }), 3);
  assert.ok(Math.abs(nonWinRate({ drawRate: 0.1, unresolvedRate: 0.2 }) - 0.3) < 1e-10);
});

test('空样本不生成 NaN 胜率', () => {
  const summary = summarizeOutcomes([]);
  assert.ok(Object.values(summary).every((value) => value === 0));
});
