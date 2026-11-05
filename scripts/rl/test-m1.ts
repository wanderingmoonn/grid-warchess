/**
 * M1 的自检：编码 / 网络 / 跑局 / 评估台四块，每一块都要有"它错了会怎样"的用例。
 *
 * 这个文件里最要紧的两条不是"能跑"，而是：
 *   ① **视角对称**：从 A 看和从 B 看，同一张图的城市归属平面必须正好相反。
 *      不对称的话，自博弈会学出"只有先手才成立"的策略。
 *   ② **采样与评估同源**：`decide` 采到某个动作，`evaluate` 算同一个动作的 logp
 *      必须**一模一样**。这两个数一旦分叉，PPO 的 ratio 就是错的，
 *      而错法很隐蔽——训练照样收敛，只是收敛到别的地方去。
 *
 * 运行：npm run rl:test
 */
import assert from 'node:assert/strict';

import { DEFAULT_CONFIG, createMatch } from '../../src/core/setup.ts';
import type { GameState } from '../../src/core/types.ts';
import { legalActions } from './legal.ts';
import {
  ACTION_DIM,
  BOARD_DIM,
  BOARD_N,
  GLOBAL_DIM,
  STATE_DIM,
  encodeActions,
  encodeBoard,
  encodeState,
} from './features.ts';
import {
  DEFAULT_SPEC,
  Policy,
  paramCount,
  randomWeights,
  WEIGHTS_VERSION,
  weightsFromJson,
  weightsToJson,
} from './policy.ts';
import type { NetSpec } from './policy.ts';
import { playMatch } from './play.ts';
import { wilson } from './stats.ts';
import { mulberry32 } from './rng.ts';

let passed = 0;
function test(name: string, run: () => void): void {
  run();
  passed += 1;
  console.log(`✓ ${name}`);
}

function match(seed = 12345, size = 12, extra: Partial<typeof DEFAULT_CONFIG> = {}): GameState {
  const s = createMatch({ ...DEFAULT_CONFIG, size, startEra: 1, draftMode: false, ...extra }, seed);
  s.fog = false;
  return s;
}

function allFinite(a: Float32Array): boolean {
  for (let i = 0; i < a.length; i++) if (!Number.isFinite(a[i]!)) return false;
  return true;
}

// ── 维度 ────────────────────────────────────────────────────────────────
test('维度常量自洽：状态 = 全局 + 粗化棋盘，联合 = 状态 + 动作', () => {
  assert.equal(BOARD_DIM, BOARD_N * BOARD_N * 3);
  assert.equal(STATE_DIM, GLOBAL_DIM + BOARD_DIM);
  assert.equal(DEFAULT_SPEC.state, STATE_DIM);
  assert.equal(DEFAULT_SPEC.action, ACTION_DIM);
  assert.equal(DEFAULT_SPEC.joint, STATE_DIM + ACTION_DIM);
});

test('编码出来的长度就是声明的长度（改特征忘了改常量会在这里炸）', () => {
  const s = match();
  assert.equal(encodeState(s, 'A').length, STATE_DIM);
  assert.equal(encodeBoard(s, 'A').length, BOARD_DIM);
  const acts = legalActions(s, 'A');
  assert.ok(acts.length > 0, '开局应该至少有一个合法动作');
  assert.equal(encodeActions(s, 'A', acts).length, acts.length * ACTION_DIM);
});

test('编码全是有限值，且不越界（网络吃不下 inf，也不该被极端值带跑）', () => {
  const s = match(777);
  const st = encodeState(s, 'A');
  assert.ok(allFinite(st), '状态特征里出现了 NaN/Infinity');
  for (let i = 0; i < st.length; i++) assert.ok(Math.abs(st[i]!) <= 4.0001, `第 ${i} 维越界：${st[i]}`);
  const feats = encodeActions(s, 'A', legalActions(s, 'A'));
  assert.ok(allFinite(feats), '动作特征里出现了 NaN/Infinity');
});

test('打乱局面之后仍然是有限值：残局、空城、没有单位都不能炸', () => {
  const s = match(999);
  s.units = [];
  const st = encodeState(s, 'B');
  assert.ok(allFinite(st), '没有单位时状态特征出现了 NaN');
  s.cities = [];
  assert.ok(allFinite(encodeState(s, 'A')), '没有城市时状态特征出现了 NaN');
});

// ── 视角 ────────────────────────────────────────────────────────────────
test('视角对称：城市归属平面从两边看正好相反', () => {
  const s = match(4242);
  const a = encodeBoard(s, 'A');
  const b = encodeBoard(s, 'B');
  const plane = BOARD_N * BOARD_N;
  let compared = 0;
  for (let i = 0; i < plane; i++) {
    const av = a[plane * 2 + i]!;
    const bv = b[plane * 2 + i]!;
    if (av === 0 && bv === 0) continue;
    compared += 1;
    assert.ok(Math.abs(av + bv) < 1e-6, `第 ${i} 格城市归属不对称：A=${av} B=${bv}`);
  }
  assert.ok(compared > 0, '这张图上居然没有一格城市，用例没测到东西');
});

test('视角对称：动作特征里"距离我最近城"从两边看不同', () => {
  const s = match(4242);
  const acts = legalActions(s, 'A');
  const move = acts.find((x) => x.type === 'MOVE');
  assert.ok(move, '开局应该有可移动的单位');
  const fa = encodeActions(s, 'A', [move]);
  const fb = encodeActions(s, 'B', [move]);
  let diff = 0;
  for (let i = 0; i < ACTION_DIM; i++) if (Math.abs(fa[i]! - fb[i]!) > 1e-6) diff += 1;
  assert.ok(diff > 0, '换个视角看同一个动作，特征完全没变——视角根本没生效');
});

test('编码是确定性的：同一个状态编两次逐位相同', () => {
  const s = match(31337);
  const a = encodeState(s, 'A');
  const b = encodeState(s, 'A');
  assert.deepEqual(Array.from(a), Array.from(b));
});

// ── 权重 ────────────────────────────────────────────────────────────────
test('权重 JSON 往返逐位不变（float32 的字节串是精确的，这就是不用十进制 JSON 的理由）', () => {
  const w = randomWeights(5);
  const back = weightsFromJson(JSON.parse(JSON.stringify(weightsToJson(w))));
  assert.equal(back.version, WEIGHTS_VERSION);
  assert.deepEqual(Array.from(back.prescreen.w), Array.from(w.prescreen.w));
  assert.deepEqual(Array.from(back.scorer.w1), Array.from(w.scorer.w1));
  assert.deepEqual(Array.from(back.value.w1), Array.from(w.value.w1));
  assert.equal(back.scorer.b2, w.scorer.b2);
});

test('权重版本对不上就报错，不猜着读', () => {
  const w = randomWeights(5);
  const raw = JSON.parse(JSON.stringify(weightsToJson(w))) as { version: number };
  raw.version = 999;
  assert.throws(() => weightsFromJson(raw), /版本/);
});

test('参数总量在 3 万以内（小到 CPU 推理就够了，上 GPU 是浪费）', () => {
  const n = paramCount(randomWeights(1));
  assert.ok(n > 10000 && n < 30000, `参数量 ${n} 不在预期区间`);
});

test('换一套维度也能建网：spec 是参数而不是硬编码', () => {
  const spec: NetSpec = { state: STATE_DIM, action: ACTION_DIM, joint: STATE_DIM + ACTION_DIM, hidden: 16, topK: 4 };
  const w = randomWeights(3, spec);
  const p = new Policy(w);
  const s = match(2468);
  const acts = legalActions(s, 'A');
  const d = p.decide(s, 'A', acts, mulberry32(1));
  assert.equal(d.considered, 4);
  assert.ok(Number.isFinite(d.logp));
});

// ── 策略 ────────────────────────────────────────────────────────────────
test('同一个随机流跑两次，选的是同一个动作（可复现）', () => {
  const p = new Policy(randomWeights(11));
  const s = match(1357);
  const acts = legalActions(s, 'A');
  const d1 = p.decide(s, 'A', acts, mulberry32(99));
  const d2 = p.decide(s, 'A', acts, mulberry32(99));
  assert.equal(d1.index, d2.index);
  assert.equal(d1.logp, d2.logp);
});

test('换一条随机流，采样会分叉（否则它根本没在按概率采）', () => {
  const p = new Policy(randomWeights(11));
  const s = match(1357);
  const acts = legalActions(s, 'A');
  const seen = new Set<number>();
  for (let k = 0; k < 8; k++) seen.add(p.decide(s, 'A', acts, mulberry32(100 + k)).index);
  assert.ok(seen.size > 1, '八条随机流选出了同一个动作——采样退化成 argmax 了');
});

test('采样与评估同源：decide 选的动作，evaluate 算出的 logp 必须一样', () => {
  const p = new Policy(randomWeights(21));
  const s = match(2024);
  const acts = legalActions(s, 'A');
  const d = p.decide(s, 'A', acts, mulberry32(7));
  const e = p.evaluate(s, 'A', acts, d.index);
  assert.ok(e.inTopK, '刚采出来的动作不在 top-K 里，说明两次打分不一致');
  assert.ok(Math.abs(e.logp - d.logp) < 1e-6, `logp 对不上：采样 ${d.logp} vs 评估 ${e.logp}`);
  assert.ok(Math.abs(e.value - d.value) < 1e-6, `价值对不上：${d.value} vs ${e.value}`);
});

test('概率是一个分布：logp ≤ 0，熵 ≥ 0', () => {
  const p = new Policy(randomWeights(31));
  const s = match(606);
  const acts = legalActions(s, 'A');
  const d = p.decide(s, 'A', acts, mulberry32(2));
  const e = p.evaluate(s, 'A', acts, d.index);
  assert.ok(d.logp <= 1e-6, `logp 应该是负的，实际 ${d.logp}`);
  assert.ok(e.entropy >= -1e-9, `熵不能是负的，实际 ${e.entropy}`);
  assert.ok(e.entropy <= Math.log(d.considered) + 1e-6, '熵超过了均匀分布的上界');
});

test('目标已经被挤出 top-K 时，evaluate 会如实说 inTopK=false', () => {
  const p = new Policy(randomWeights(41), { topK: 2 });
  const s = match(808);
  const acts = legalActions(s, 'A');
  // 找一个肯定没进前二的候选：直接问最后一个动作
  const idx = acts.length - 1;
  const e = p.evaluate(s, 'A', acts, idx);
  if (e.inTopK) return; // 恰好在里面也合法，这条用例只要求"能如实回答"
  assert.ok(e.logp < -20, '不在 top-K 里却给了正常的 logp');
});

test('温度压低 = 更集中：同一个状态，低温度的熵必须更小', () => {
  // 不能直接断言"选同一个动作"：随机初始化的打分本来就只有千分之一的差距，
  // 压到 0.05 也只是把差距放大 20 倍，还不足以变成 argmax。
  // 能断言的是方向：温度下去，分布一定更尖。
  const s = match(31031);
  const acts = legalActions(s, 'A');
  const hot = new Policy(randomWeights(51), { temperature: 1 });
  const cold = new Policy(randomWeights(51), { temperature: 0.05 });
  const idx = hot.decide(s, 'A', acts, mulberry32(3)).index;
  const h = hot.evaluate(s, 'A', acts, idx).entropy;
  const c = cold.evaluate(s, 'A', acts, idx).entropy;
  assert.ok(c < h, `低温度的熵 ${c} 不小于原温度 ${h}，温度没生效`);
});

// ── 跑局 ────────────────────────────────────────────────────────────────
test('一局能跑完：策略 vs 手写 AI，8×8，引擎一次都没拒', () => {
  const p = new Policy(randomWeights(61));
  const r = playMatch({
    seed: 90210,
    size: 8,
    drivers: [{ kind: 'policy', policy: p }, { kind: 'ai' }],
  });
  assert.equal(r.rejected, 0, '引擎拒绝了策略给出的动作——枚举和规则漂了');
  assert.ok(r.steps > 20, `只走了 ${r.steps} 步，不像一局正常对局`);
  assert.ok(r.turns <= 120, '回合数超过了上限');
});

test('随机策略也能跑完：说明"动作 → 开局 → 结束"这条链路是通的', () => {
  const r = playMatch({
    seed: 5150,
    size: 8,
    drivers: [{ kind: 'random' }, { kind: 'ai' }],
  });
  assert.equal(r.rejected, 0);
  assert.ok(r.steps > 10);
});

test('手写 AI 那一侧用的是同一套预算：一回合造兵不超过 2 个', () => {
  // 这条防的是"每次出招都新建一份预算"——那等于把上限复位，AI 会一路造到底。
  // 判据：任意一回合里，RECRUIT 动作不超过 DEFAULT_BUDGET.maxRecruit。
  const counts = new Map<string, number>();
  const r = playMatch({
    seed: 6161,
    size: 8,
    drivers: [{ kind: 'ai' }, { kind: 'ai' }],
    onStep: (info) => {
      if (info.action.type !== 'RECRUIT') return;
      const key = `${info.seat}#${info.state.turn}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    },
  });
  assert.equal(r.rejected, 0);
  for (const [key, n] of counts) assert.ok(n <= 2, `${key} 一回合造了 ${n} 个兵`);
});

// ── 评估台 ──────────────────────────────────────────────────────────────
test('Wilson 区间：全胜 / 全负都不会给出 [0,1] 这种没用的区间', () => {
  const lose = wilson(0, 100);
  assert.equal(lose.lo, 0);
  assert.ok(lose.hi < 0.05, `0/100 的上界 ${lose.hi} 太宽`);
  const win = wilson(100, 100);
  assert.ok(win.lo > 0.95, `100/100 的下界 ${win.lo} 太窄`);
  const half = wilson(50, 100);
  assert.ok(half.lo < 0.5 && half.hi > 0.5, '50/100 的区间应该盖住 0.5');
  assert.deepEqual(wilson(0, 0), { lo: 0, hi: 1 });
});

// ── 成本 ────────────────────────────────────────────────────────────────
test('编 + 采一步在 0.6 ms 以内（这是"算力不是障碍"那个结论的支撑）', () => {
  const p = new Policy(randomWeights(71));
  const s = match(112233);
  const acts = legalActions(s, 'A');
  const rand = mulberry32(1);
  // 预热：第一遍要建缓冲、填 JIT
  for (let i = 0; i < 20; i++) p.decide(s, 'A', acts, rand);
  // 取**多批里的最快一批**，不取总平均：这条量的是算法的成本，
  // 而机器上可能同时在跑别的批处理（后台评估、编译），平均会被别人的负载污染。
  const N = 50;
  let best = Infinity;
  for (let batch = 0; batch < 5; batch++) {
    const t0 = performance.now();
    for (let i = 0; i < N; i++) p.decide(s, 'A', acts, rand);
    best = Math.min(best, (performance.now() - t0) / N);
  }
  console.log(`     · ${acts.length} 个动作 / ${best.toFixed(3)} ms 每步（取五批中最快的一批）`);
  assert.ok(best < 0.6, `每步 ${best.toFixed(3)}ms，超出 0.6ms 预算`);
});

console.log(`\n${passed} 项 M1 自检通过`);
