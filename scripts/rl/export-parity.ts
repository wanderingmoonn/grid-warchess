/**
 * 导一批"真实决策"给 Python 对账用。
 *
 * 每一条记的是**那一刻 TS 亲眼看到的输入和算出来的数**：
 *   状态 148 维、这一步全部合法动作的 56 维特征、被选中的那个动作下标、
 *   以及当时算出的 logp / 价值。Python 拿它重算一遍，对不上就说明两边前向不一致。
 *
 * 为什么不用随机数造假数据：随机向量喂进两层 ReLU 常常落在"全零激活"的平坦区，
 * 两边都输出 0，误差永远是 0，测了等于没测。必须用真实局面的真实分布。
 *
 * 用法：
 *   node --experimental-strip-types scripts/rl/export-parity.ts --steps 40 --out .tmp/parity.json
 */
import fs from 'node:fs';

import { AI_MAX_STEPS, DEFAULT_BUDGET, aiNextAction } from '../../src/core/ai.ts';
import { applyAction } from '../../src/core/rules.ts';
import { DEFAULT_CONFIG, createMatch } from '../../src/core/setup.ts';
import type { GameState } from '../../src/core/types.ts';
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

const SEED = Number(argOf('seed', '5150'));
const STEPS = Number(argOf('steps', '40'));
const OUT = argOf('out', '.tmp/parity.json');
const WEIGHTS = argOf('weights', 'scripts/rl/weights/init.json');
const TOPK = Number(argOf('topk', '0'));
const TEMP = Number(argOf('temp', '1'));

const raw = fs.readFileSync(WEIGHTS, 'utf8');
const weights = weightsFromJson(JSON.parse(raw));
const policy = new Policy(weights, { topK: TOPK > 0 ? TOPK : undefined, temperature: TEMP });

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
  SEED,
);
s.fog = false;

const rand = mulberry32(hashSeed(SEED, 'A', 'policy'));
const samples: Array<{
  state: number[];
  actions: number[];
  n: number;
  index: number;
  logp: number;
  value: number;
  temperature: number;
}> = [];

let turnSeat: string | null = null;
let inTurn = 0;
let budget = { ...DEFAULT_BUDGET };
const rejected = new Set<string>();

while (!s.winner && samples.length < STEPS && s.turn <= TRAIN.capTurns) {
  const seat = s.current;
  if (seat !== turnSeat) {
    turnSeat = seat;
    inTurn = 0;
    budget = { ...DEFAULT_BUDGET };
    rejected.clear();
  }
  const acts = legalActions(s, seat);
  if (acts.length === 0) break;

  // A 座走策略（要采样、要记账），B 座走手写 AI（只为把局面推下去）
  let action = acts[0]!;
  if (seat === 'A') {
    const state = encodeState(s, seat);
    const feats = encodeActions(s, seat, acts);
    const d = policy.decide(s, seat, acts, rand);
    samples.push({
      state: Array.from(state),
      actions: Array.from(feats),
      n: acts.length,
      index: d.index,
      logp: d.logp,
      value: d.value,
      temperature: TEMP,
    });
    action = d.action;
  } else if (inTurn < AI_MAX_STEPS) {
    const picked = aiNextAction(s, budget, rejected);
    if (!picked) {
      // AI 说"我这一回合不动了"：得真的把回合交出去，否则这个循环原地打转
      const end = applyAction(s, { type: 'END_TURN' });
      if (!end.ok) break;
      s = end.state;
      continue;
    }
    action = picked;
    if (action.type === 'RECRUIT') budget.recruited += 1;
    if (action.type === 'UPGRADE') budget.upgraded += 1;
  } else {
    action = { type: 'END_TURN' };
  }

  const r = applyAction(s, action);
  if (!r.ok) {
    if (seat === 'B') {
      rejected.add(JSON.stringify(action));
      // 同一步反复被拒不能无限重试：一次不成，交回回合
      const end = applyAction(s, { type: 'END_TURN' });
      if (!end.ok) break;
      s = end.state;
      inTurn = 0;
      continue;
    }
    throw new Error(`策略给出的动作被拒：${r.reason}`);
  }
  s = r.state;
  inTurn += 1;
}

fs.writeFileSync(
  OUT,
  JSON.stringify({
    dim: { state: STATE_DIM, action: ACTION_DIM, topK: policy.topK },
    weights: WEIGHTS,
    seed: SEED,
    samples,
  }),
);

const avg = samples.reduce((n, x) => n + x.n, 0) / Math.max(1, samples.length);
console.log(`导出 ${samples.length} 条真实决策（平均 ${avg.toFixed(0)} 个合法动作/步）→ ${OUT}`);
