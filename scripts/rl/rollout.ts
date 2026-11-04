/**
 * M2 的采样器：用当前权重跑若干局，把"训练要用到的那几个数"落成一个二进制文件。
 *
 * ── 为什么不是直接用 replay.ts 的记录 ────────────────────────────────────
 *
 * 那份记录是为了**审计**（种子+动作序列，能一帧不差地重放），体积小但不是给训练用的：
 * PPO 更新时要算 `π_new(a|s)`，需要当时那一批候选动作的**特征**，而记录里没有。
 * 想从记录反推，就得在 TS 里重放一遍再导一遍——多花一倍时间换几十兆磁盘，不划算。
 *
 * 所以采样时顺手把该拿的都拿下来（反正那一刻都在手里），训练侧只做矩阵乘法。
 *
 * ── 一步存什么 ──────────────────────────────────────────────────────────
 *
 *   state   148 维      观测
 *   cand    K×56        预筛选出的候选动作特征（K=16，和推理时同一批）
 *   logp    1           采样时的 log π(a|s)，PPO 的分母
 *   value   1           采样时的价值估计
 *   reward  1           终局才给 ±1（平局 0），其余为 0
 *   idx     1           被选中的动作在候选里的位置（0..K-1）
 *   game    1           第几局（GAE 按局切，不能跨局累计）
 *
 * 一步 1050 个 float32 ≈ 4.2KB。五万步约 200MB —— 一轮一落盘、更新完就删，
 * 不累积。真要压体积可以降到 float16，但那会让"重算的 logp"与"采样的 logp"
 * 差出 1e-3，ratio 一开始就不等于 1，得不偿失。
 *
 * 用法：
 *   node --experimental-strip-types scripts/rl/rollout.ts --games 8 --seed0 8000 --out .tmp/rollout-0
 */
import fs from 'node:fs';
import path from 'node:path';

import { AI_MAX_STEPS, DEFAULT_BUDGET, aiNextAction } from '../../src/core/ai.ts';
import { applyAction } from '../../src/core/rules.ts';
import { DEFAULT_CONFIG, createMatch } from '../../src/core/setup.ts';
import type { GameState, PlayerId } from '../../src/core/types.ts';
import { TRAIN } from './config.ts';
import { ACTION_DIM, STATE_DIM, encodeActions, encodeState } from './features.ts';
import { legalActions } from './legal.ts';
import { Policy, weightsFromJson } from './policy.ts';
import { hashSeed, mulberry32 } from './rng.ts';

const args = process.argv.slice(2);
const argOf = (name: string, dflt: string): string => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? (args[i + 1] as string) : dflt;
};

const GAMES = Number(argOf('games', '8'));
const SEED0 = Number(argOf('seed0', '8000'));
const OUT = argOf('out', path.join('.tmp', 'rollout'));
const WEIGHTS = argOf('weights', path.join('scripts', 'rl', 'weights', 'init.json'));
const CAP = Number(argOf('cap', String(TRAIN.capTurns)));

const weights = weightsFromJson(JSON.parse(fs.readFileSync(WEIGHTS, 'utf8')));
const policy = new Policy(weights);
const K = policy.topK;

// logp, value, reward, idx, game, turn, kUsed。
// kUsed 必须存：合法动作不足 16 个时，候选数组的尾巴是**补零**的，
// 如果不告诉训练侧"真正有几个候选"，那些零向量会被当成真动作参与 softmax，
// 概率质量被摊薄，重算的 logp 和采样时对不上（实测能差到 0.9）。
const META = 7;
const WIDTH = STATE_DIM + K * ACTION_DIM + META;
const chunk = new Float32Array(WIDTH * 512);
let stored = 0;
const outPath = `${OUT}.bin`;
fs.mkdirSync(path.dirname(outPath), { recursive: true });
const fd = fs.openSync(outPath, 'w');

let totalSteps = 0;
const perGame: Array<{ seed: number; steps: number; winner: PlayerId | null; turns: number }> = [];

for (let g = 0; g < GAMES; g++) {
  const seed = SEED0 + g;
  let s: GameState = createMatch(
    {
      ...DEFAULT_CONFIG,
      size: TRAIN.size,
      startEra: TRAIN.startEra,
      playerCount: 2,
      draftMode: false,
      aiOpponent: false,
      aiAlly: false,
      expansionIds: TRAIN.expansions,
    },
    seed,
  );
  s.fog = false;
  const rand = mulberry32(hashSeed(seed, 'A', 'policy'));

  let turnSeat: PlayerId | null = null;
  let inTurn = 0;
  let budget = { ...DEFAULT_BUDGET };
  const rejected = new Set<string>();
  let firstStepOfGame = stored;
  let lastStored = -1;

  while (!s.winner && s.turn <= CAP) {
    const seat = s.current;
    if (seat !== turnSeat) {
      turnSeat = seat;
      inTurn = 0;
      budget = { ...DEFAULT_BUDGET };
      rejected.clear();
    }

    if (seat === 'B') {
      // 对手是手写 AI：它的动作不进训练集（不是我们要学的策略）
      const picked = inTurn < AI_MAX_STEPS ? aiNextAction(s, budget, rejected) : null;
      const action = picked ?? { type: 'END_TURN' as const };
      if (picked) {
        if (action.type === 'RECRUIT') budget.recruited += 1;
        if (action.type === 'UPGRADE') budget.upgraded += 1;
      }
      const r = applyAction(s, action);
      if (!r.ok) {
        if (picked) rejected.add(JSON.stringify(picked));
        const end = applyAction(s, { type: 'END_TURN' });
        if (!end.ok) break;
        s = end.state;
        inTurn += 1;
        continue;
      }
      s = r.state;
      inTurn += 1;
      continue;
    }

    const acts = legalActions(s, 'A');
    if (acts.length === 0) break;
    if (inTurn >= AI_MAX_STEPS) {
      const end = applyAction(s, { type: 'END_TURN' });
      if (!end.ok) break;
      s = end.state;
      inTurn += 1;
      continue;
    }

    const state = encodeState(s, 'A');
    const feats = encodeActions(s, 'A', acts);
    const d = policy.decide(s, 'A', acts, rand);

    // 候选集：直接取 decide 内部那一批（顺序都一样），把它们的特征抄下来
    const picked = d.candidates;
    const cand = new Float32Array(K * ACTION_DIM);
    for (let i = 0; i < Math.min(K, picked.length); i++) {
      const src = picked[i]! * ACTION_DIM;
      cand.set(feats.subarray(src, src + ACTION_DIM), i * ACTION_DIM);
    }
    const pos = picked.indexOf(d.index);

    if (stored * WIDTH + WIDTH > chunk.length) {
      fs.writeSync(fd, Buffer.from(chunk.buffer, 0, stored * WIDTH * 4));
      stored = 0;
    }
    const base = stored * WIDTH;
    chunk.set(state, base);
    chunk.set(cand, base + STATE_DIM);
    chunk[base + STATE_DIM + K * ACTION_DIM] = d.logp;
    chunk[base + STATE_DIM + K * ACTION_DIM + 1] = d.value;
    chunk[base + STATE_DIM + K * ACTION_DIM + 2] = 0; // reward，终局再回填
    chunk[base + STATE_DIM + K * ACTION_DIM + 3] = pos < 0 ? 0 : pos;
    chunk[base + STATE_DIM + K * ACTION_DIM + 4] = g;
    chunk[base + STATE_DIM + K * ACTION_DIM + 5] = inTurn;
    chunk[base + STATE_DIM + K * ACTION_DIM + 6] = picked.length;
    lastStored = stored;
    stored += 1;
    totalSteps += 1;

    const r = applyAction(s, d.action);
    if (!r.ok) throw new Error(`策略给出的动作被拒：${r.reason}`);
    s = r.state;
    inTurn += 1;
  }

  // 终局奖励：赢 +1、输 −1、平 0。只挂在**这一局策略的最后一个决策**上，
  // 因为那一步才是"决定胜负"的最后一次选择（其余步靠 GAE 往回传）。
  const reward = s.winner === 'A' ? 1 : s.winner === null ? 0 : -1;
  if (lastStored >= 0) chunk[lastStored * WIDTH + STATE_DIM + K * ACTION_DIM + 2] = reward;
  perGame.push({ seed, steps: stored - firstStepOfGame, winner: s.winner ?? null, turns: s.turn });
}

if (stored > 0) fs.writeSync(fd, Buffer.from(chunk.buffer, 0, stored * WIDTH * 4));
fs.closeSync(fd);

const manifest = {
  v: 1,
  width: WIDTH,
  state: STATE_DIM,
  action: ACTION_DIM,
  k: K,
  steps: totalSteps,
  games: GAMES,
  seed0: SEED0,
  size: TRAIN.size,
  expansions: TRAIN.expansions,
  weights: WEIGHTS,
  perGame,
};
fs.writeFileSync(`${OUT}.json`, JSON.stringify(manifest, null, 2));

const avg = totalSteps / Math.max(1, GAMES);
console.log(
  `采样 ${GAMES} 局：${totalSteps} 步（${avg.toFixed(0)} 步/局）· ${(totalSteps * WIDTH * 4 / 1024 / 1024).toFixed(1)} MB ` +
    `→ ${outPath}`,
);
console.log(`  赢家：${perGame.map((p) => p.winner ?? '平').join(' ')}`);
