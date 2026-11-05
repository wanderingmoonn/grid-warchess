/**
 * 一步棋里各段各花多少时间。
 *
 * 为什么要有它：16/24/32 进程的采样吞吐实测是 916/904/889 步/秒——加进程没有用，
 * 因为每局棋是单线程的循环，16 个物理核已经被 16 个 worker 占满。既然并行到顶了，
 * "更快"就只能从**单步更便宜**来。这个脚本就是量哪一段值得动。
 *
 * 实测（weights-6，10×10 + 血战，在 16 个 worker 满载的情况下测，绝对值偏高、比例可用）：
 *
 *   第 5 回合   71 个合法动作   3.2 ms/步   legalActions 47%
 *   第 20 回合  58 个           3.2 ms      legalActions 51%
 *   第 40 回合  60 个           5.0 ms      legalActions 50%
 *   第 60 回合 117 个           7.6 ms      legalActions 60%
 *
 * 结论：`legalActions`（把这一刻所有合法动作列出来）是最大的一块，而且随局面变复杂
 * 单调上升。它没法并行，只能从算法上省——那是另一件事。
 * 顺手能省的是"特征算两遍"：采样器原来自己 encode 一遍、decide 内部再算一遍，
 * 现在改成从策略内部取（`Policy.lastState/lastFeats`）。
 *
 * 用法：
 *   node --experimental-strip-types scripts/rl/bench-legal.ts [--weights X] [--turns 5,20,40,60]
 */
import fs from 'node:fs';

import { DEFAULT_BUDGET, aiNextAction } from '../../src/core/ai.ts';
import { applyAction } from '../../src/core/rules.ts';
import { DEFAULT_CONFIG, createMatch } from '../../src/core/setup.ts';
import { TRAIN } from './config.ts';
import { encodeActions, actionContext, ACTION_DIM } from './features.ts';
import { legalActions } from './legal.ts';
import { Policy, weightsFromJson } from './policy.ts';

const w = weightsFromJson(JSON.parse(fs.readFileSync('.tmp/m2k/weights-6.json','utf8')));
const p = new Policy(w);
let s = createMatch({...DEFAULT_CONFIG, size: TRAIN.size, startEra: TRAIN.startEra, playerCount: 2,
  draftMode: false, aiOpponent: false, aiAlly: false, expansionIds: TRAIN.expansions}, 7700);
s.fog = false;
// 在几个不同的回合数上各测一次——开局和残局的动作数差好几倍，只测一个点会误判
const marks = new Set([5, 20, 40, 60]);
const seatNow = () => s.current;
const N = 120;
const t = (label: string, fn: () => void) => {
  fn();
  const t0 = performance.now();
  for (let i = 0; i < N; i++) fn();
  const dt = (performance.now() - t0) / N;
  console.log(`${label.padEnd(22)} ${dt.toFixed(3)} ms/次`);
  return dt;
};
function bench(): void {
  const seat = seatNow();
  const acts = legalActions(s, seat);
  if (acts.length === 0) return;
  const a1 = t(`  legalActions (${acts.length} 个)`, () => { legalActions(s, seat); });
  const feats = new Float32Array(acts.length * ACTION_DIM);
  t('  encodeActions', () => { encodeActions(s, seat, acts, feats, actionContext(s, seat)); });
  const a2 = t('  policy.decide', () => { p.decide(s, seat, acts, Math.random); });
  console.log(`  → 一步 ${(a1 + a2).toFixed(2)} ms，legalActions 占 ${(a1 / (a1 + a2) * 100).toFixed(0)}%`);
}

while (!s.winner && s.turn <= 70) {
  const mark = [...marks].find((m) => m <= s.turn);
  if (mark !== undefined && s.turn === mark) {
    marks.delete(mark);
    console.log(`\n第 ${s.turn} 回合：`);
    bench();
  }
  const a = aiNextAction(s, { ...DEFAULT_BUDGET }, new Set());
  const e = applyAction(s, a ?? { type: 'END_TURN' });
  if (!e.ok) break;
  s = e.state;
}
