/**
 * 意图探针：**同一个局面下换意图，前 20 手会不会不一样**。
 *
 * 这是"它到底听不听话"唯一靠得住的量法。看胜率没用——胜率只说明强不强，
 * 说明不了"给了 rush 就不打骚扰"。所以这里直接把前 20 手拎出来逐手比：
 *
 *   · 前 20 手完全一致 → 意图那 4 格是死输入，等于没接；
 *   · 前几手就分叉，且分叉后动作类型分布明显不同 → 意图真的进了决策。
 *
 * 用法：
 *   node --experimental-strip-types scripts/rl/intent-probe.ts \
 *        --weights .tmp/m2v2/weights-12.json --seeds 8 --turns 18
 */
import fs from 'node:fs';
import { AI_MAX_STEPS, DEFAULT_BUDGET, aiNextAction } from '../../src/core/ai.ts';
import { applyAction } from '../../src/core/rules.ts';
import { DEFAULT_CONFIG, createMatch } from '../../src/core/setup.ts';
import type { Action, GameState, PlayerId } from '../../src/core/types.ts';
import { INTENT_NAMES, type Intent } from './features.ts';
import { legalActions } from './legal.ts';
import { Policy, weightsFromJson } from './policy.ts';
import { mulberry32 } from './rng.ts';
import { TRAIN } from './config.ts';

const args = process.argv.slice(2);
const argOf = (name: string, dflt: string): string => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? (args[i + 1] as string) : dflt;
};

const WEIGHTS = argOf('weights', '.tmp/m2v2/weights-12.json');
const SEEDS = Number(argOf('seeds', '8'));
const TURNS = Number(argOf('turns', '18'));
const SEED0 = Number(argOf('seed0', String(TRAIN.size === 10 ? 1000 : 1000)));
const DEPTH = 20;

const policy = new Policy(weightsFromJson(JSON.parse(fs.readFileSync(WEIGHTS, 'utf8'))));

/** 动作的"可比较指纹"：类型 + 目标，坐标只在与动作有关时带上 */
function key(a: Action): string {
  const x = a as Record<string, unknown>;
  const parts: string[] = [a.type];
  for (const k of ['unitId', 'targetId', 'cityId', 'unitType', 'cargoId', 'skillId']) {
    if (x[k] !== undefined) parts.push(`${k}=${x[k]}`);
  }
  if (x['x'] !== undefined) parts.push(`@${x['x']},${x['y']}`);
  return parts.join('|');
}

/** 跑一局到第 TURNS 回合为止，返回 A 座（策略）的前 DEPTH 个动作 */
function playTo(seed: number, intent: Intent): string[] {
  policy.intent = intent;
  const rand = mulberry32(seed ^ 0x5f5f);
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
      aiLevel: TRAIN.aiLevel,
    },
    seed,
  );
  s.fog = false;
  policy.intent = intent;

  const seq: string[] = [];
  let turnSeat: PlayerId | null = null;
  let inTurn = 0;
  let budget = { ...DEFAULT_BUDGET };
  let rejected = new Set<string>();

  for (let guard = 0; guard < 4000; guard++) {
    if (s.winner || s.turn > TURNS || seq.length >= DEPTH) break;
    const seat = s.current;
    if (seat !== turnSeat) {
      turnSeat = seat;
      inTurn = 0;
      budget = { ...DEFAULT_BUDGET };
      rejected = new Set();
    }
    if (inTurn >= AI_MAX_STEPS) {
      const end = applyAction(s, { type: 'END_TURN' });
      if (!end.ok) break;
      s = end.state;
      inTurn += 1;
      continue;
    }

    let picked: Action | null;
    if (seat === 'A') {
      const acts = legalActions(s, seat);
      if (acts.length === 0) break;
      picked = policy.decide(s, seat, acts, rand).action;
    } else {
      picked = aiNextAction(s, budget, rejected);
    }
    if (!picked) {
      const end = applyAction(s, { type: 'END_TURN' });
      if (!end.ok) break;
      s = end.state;
      inTurn += 1;
      continue;
    }
    if (seat === 'A') seq.push(key(picked));
    if (picked.type === 'RECRUIT') budget.recruited += 1;
    if (picked.type === 'UPGRADE') budget.upgraded += 1;

    const r = applyAction(s, picked);
    if (!r.ok) {
      rejected.add(JSON.stringify(picked));
      const end = applyAction(s, { type: 'END_TURN' });
      if (!end.ok) break;
      s = end.state;
      inTurn += 1;
      continue;
    }
    s = r.state;
    inTurn += 1;
  }
  return seq;
}

/** 两串动作：完全相同的前缀有多长 + 逐位相同的比例 */
function compare(a: string[], b: string[]): { prefix: number; same: number } {
  const n = Math.min(a.length, b.length);
  let prefix = 0;
  while (prefix < n && a[prefix] === b[prefix]) prefix += 1;
  let same = 0;
  for (let i = 0; i < n; i++) if (a[i] === b[i]) same += 1;
  return { prefix, same: n > 0 ? same / n : 0 };
}

const intents: Intent[] = ['auto', 'rush', 'harass', 'boom'];
const pairs: Array<[Intent, Intent]> = [];
for (let i = 0; i < intents.length; i++) {
  for (let j = i + 1; j < intents.length; j++) pairs.push([intents[i]!, intents[j]!]);
}
const acc = new Map<string, { prefix: number; same: number; n: number }>();
const lens = new Map<Intent, number>();

for (let k = 0; k < SEEDS; k++) {
  const seed = SEED0 + k;
  const seqs = new Map<Intent, string[]>();
  for (const it of intents) {
    const seq = playTo(seed, it);
    seqs.set(it, seq);
    lens.set(it, (lens.get(it) ?? 0) + seq.length);
  }
  for (const [a, b] of pairs) {
    const c = compare(seqs.get(a)!, seqs.get(b)!);
    const key2 = `${a} vs ${b}`;
    const cur = acc.get(key2) ?? { prefix: 0, same: 0, n: 0 };
    cur.prefix += c.prefix;
    cur.same += c.same;
    cur.n += 1;
    acc.set(key2, cur);
  }
}

console.log(`权重 ${WEIGHTS} · ${SEEDS} 个种子 · 每局看前 ${DEPTH} 手（打到第 ${TURNS} 回合为止）`);
console.log('每局平均取到的手数：', Object.fromEntries(intents.map((i) => [i, ((lens.get(i) ?? 0) / SEEDS).toFixed(1)])));
console.log('\n两两对照（"前缀一致"= 从头开始一模一样的步数，越大越像）');
for (const [a, b] of pairs) {
  const c = acc.get(`${a} vs ${b}`)!;
  console.log(
    `  ${a.padEnd(6)} vs ${b.padEnd(6)}  前缀一致 ${(c.prefix / c.n).toFixed(1)}/${DEPTH}  逐位相同 ${((c.same / c.n) * 100).toFixed(1)}%`,
  );
}
void INTENT_NAMES;
