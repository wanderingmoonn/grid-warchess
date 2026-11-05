/**
 * 训练**预筛**（两段式里那个线性头）。
 *
 * ── 为什么必须有这一步 ──────────────────────────────────────────────────
 *
 * M1 的设计是两段式：线性预筛把几百个合法动作砍到 16 个，再让 MLP 在这 16 个里排序。
 * 当时的假设是"预筛会跟着学"。但 PPO 侧的实现刻意**冻结**了预筛（理由见 ppo.py：
 * 候选集会漂移，ratio 就失去意义），于是它一直是 `init.json` 里的随机数。
 *
 * 后果是用数据量出来的：让手写 AI 当老师，看它的动作是否落在预筛的 top-16 里——
 * **只有 14.6%**（786/5396）。也就是说 85% 的好棋压根不在候选里，
 * 打分网络再准也只能在剩下 15 个随机候选里挑。这不是"策略不够强"，是"选择被剪掉了"。
 *
 * 所以把预筛单独拿出来，用**老师的动作**做一次监督学习：
 * 对每个局面，把全部合法动作过一遍 softmax，用交叉熵把老师的动作顶上去。
 * 学完再冻结——预筛本来就是"候选生成器"，它擅长的事是召回，不是精细排序。
 *
 * ── 为什么要模型平均 ────────────────────────────────────────────────────
 *
 * 瓶颈在引擎和手写 AI（一次决策 ~15ms），只能多进程。但并行 SGD 需要一个合并办法：
 * 每个 worker 从**同一份初始权重**出发各跑一段，最后把"权重增量"平均起来。
 * 线性模型 + 每轮重开，这个近似足够好（就是 Hogwild 的同步版本）。
 *
 * 用法：
 *   node --experimental-strip-types scripts/rl/train-prescreen.ts --games 60 --passes 3 \
 *        --weights scripts/rl/weights/init.json --out .tmp/bc/weights-pre.json
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { AI_MAX_STEPS, DEFAULT_BUDGET, aiNextAction } from '../../src/core/ai.ts';
import { applyAction } from '../../src/core/rules.ts';
import { DEFAULT_CONFIG, createMatch } from '../../src/core/setup.ts';
import type { Action, AiLevel, GameState, PlayerId } from '../../src/core/types.ts';
import { TRAIN } from './config.ts';
import { ACTION_DIM, STATE_DIM } from './features.ts';
import { legalActions } from './legal.ts';
import { Policy, weightsFromJson, weightsToJson, type Weights } from './policy.ts';

const args = process.argv.slice(2);
const argOf = (name: string, dflt: string): string => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? (args[i + 1] as string) : dflt;
};
const flag = (name: string): boolean => args.includes(`--${name}`);

const GAMES = Number(argOf('games', '40'));
const SEED0 = Number(argOf('seed0', '12000'));
const WEIGHTS = argOf('weights', path.join('scripts', 'rl', 'weights', 'init.json'));
const OUT = argOf('out', path.join('.tmp', 'bc', 'weights-pre.json'));
const CAP = Number(argOf('cap', String(TRAIN.capTurns)));
const AI_LEVEL = argOf('ai-level', 'advanced') as AiLevel;
const WORKERS = Number(argOf('workers', String(Math.max(1, Math.round(os.cpus().length / 2)))));
const SERVE = flag('serve');
/** 每多少个决策做一次梯度步（太小噪声大，太大会把 lr 的有效值改掉） */
const BATCH = Number(argOf('batch', '32'));
const LR = Number(argOf('lr', '0.05'));
const L2 = Number(argOf('l2', '1e-6'));
/**
 * 只**测**不训：给出若干个候选数 K，分别统计"老师的动作在不在前 K 里"。
 *
 * 这个数是整个两段式设计的地基：预筛把几十上百个合法动作砍到 K 个，
 * 被砍掉的动作无论后面的网络多准都选不到。所以"K 要多大"必须是量出来的，
 * 不能拍脑袋定成 16。
 */
const KS = argOf('ks', '')
  .split(',')
  .map((x) => Number(x.trim()))
  .filter((x) => Number.isFinite(x) && x > 0);

const template = weightsFromJson(JSON.parse(fs.readFileSync(WEIGHTS, 'utf8')));
const JOINT = STATE_DIM + ACTION_DIM;
const TOPK = template.spec.topK;

function sameAction(a: Action, b: Action): boolean {
  if (a.type !== b.type) return false;
  const x = a as Record<string, unknown>;
  const y = b as Record<string, unknown>;
  for (const k of ['unitId', 'targetId', 'cityId', 'unitType', 'cargoId', 'skillId', 'directive']) {
    if (x[k] === undefined && y[k] === undefined) continue;
    if (x[k] !== y[k]) return false;
  }
  if (x['x'] !== undefined && y['x'] !== undefined) {
    if (x['x'] !== y['x'] || x['y'] !== y['y']) return false;
  }
  return true;
}

interface Delta {
  /** 学完之后的权重增量和截距增量 */
  dw: number[];
  db: number;
  steps: number;
  /** 顺手统计召回：老师的动作在 top-K / top-1 里的比例 */
  hitK: number;
  hit1: number;
  /** 和 `--ks` 一一对应的命中数 */
  hits: number[];
  /** 平均每一步有多少合法动作 */
  sumN: number;
}

/** 一个 worker 从同一份初始权重出发，在自己那批局上跑在线 SGD，回一个增量 */
function trainChunk(games: number[], w0: Float64Array, b0: number): Delta {
  const w = Float64Array.from(w0);
  let b = b0;
  const grad = new Float64Array(JOINT);
  let gradB = 0;
  let pending = 0;
  let steps = 0;
  let hitK = 0;
  let hit1 = 0;
  const hits = KS.map(() => 0);
  let sumN = 0;
  const scoreBuf = new Float64Array(4096);
  const policy = new Policy(template);

  const flush = () => {
    if (pending === 0) return;
    for (let i = 0; i < JOINT; i++) {
      w[i] = w[i]! - (LR * grad[i]!) / pending - LR * L2 * w[i]!;
      grad[i] = 0;
    }
    // 截距的梯度是 p−onehot 的和，恒为 0（softmax 输出和为 1）。
    // 留这一行是因为以后要加 bias 正则或样本权重时，这里是最容易忘的地方。
    b -= (LR * gradB) / pending;
    gradB = 0;
    pending = 0;
  };

  for (const g of games) {
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
        aiLevel: AI_LEVEL,
      },
      seed,
    );
    s.fog = false;
    let turnSeat: PlayerId | null = null;
    let inTurn = 0;
    let budget = { ...DEFAULT_BUDGET };
    const rejected = new Set<string>();

    while (!s.winner && s.turn <= CAP) {
      const seat = s.current;
      if (seat !== turnSeat) {
        turnSeat = seat;
        inTurn = 0;
        budget = { ...DEFAULT_BUDGET };
        rejected.clear();
      }
      if (inTurn >= AI_MAX_STEPS) {
        const end = applyAction(s, { type: 'END_TURN' });
        if (!end.ok) break;
        s = end.state;
        inTurn += 1;
        continue;
      }
      const picked = aiNextAction(s, budget, rejected);
      if (!picked) {
        const end = applyAction(s, { type: 'END_TURN' });
        if (!end.ok) break;
        s = end.state;
        inTurn += 1;
        continue;
      }
      if (picked.type === 'RECRUIT') budget.recruited += 1;
      if (picked.type === 'UPGRADE') budget.upgraded += 1;

      const acts = legalActions(s, seat);
      let label = -1;
      for (let i = 0; i < acts.length; i++) {
        if (sameAction(acts[i]!, picked)) {
          label = i;
          break;
        }
      }
      if (label >= 0 && acts.length > 1) {
        // 分数直接问 Policy 要（`candidateSet` 返回的就是它自己预筛用的那份）
        const cs = policy.candidateSet(s, seat, acts, label);
        const state = cs.state;
        const feats = cs.feats;
        const n = acts.length;
        sumN += n;
        const raw = cs.scores;
        for (let j = 0; j < n; j++) scoreBuf[j] = raw[j]!;

        // 召回统计必须和**选择排序的定性一致**：同分时下标小的排前面。
        //
        // 这里踩过一次坑：随机初始化的预筛给 87 个候选打分几乎一样（权重只有 0.02 量级），
        // float32 下大量候选**严格相等**。只数"严格大于"的话这些并列全被算成"没超过老师"，
        // rank 假性地接近 0，于是报出 60% 的召回——按真实选择排序其实只有 15%。
        // 所以同分的时候还要比下标，和 `Policy.prescreen` 的 `scores[idx[j]] > scores[idx[best]]` 一致。
        const ref = scoreBuf[label]!;
        let rank = 0;
        for (let j = 0; j < n; j++) {
          if (j === label) continue;
          const sj = scoreBuf[j]!;
          if (sj > ref || (sj === ref && j < label)) rank += 1;
        }
        if (rank < TOPK) hitK += 1;
        if (rank === 0) hit1 += 1;
        for (let q = 0; q < KS.length; q++) if (rank < KS[q]!) hits[q]! += 1;

        // softmax（数值稳定版，原地覆盖 scoreBuf）
        let mx = -Infinity;
        for (let j = 0; j < n; j++) if (scoreBuf[j]! > mx) mx = scoreBuf[j]!;
        let sum = 0;
        for (let j = 0; j < n; j++) {
          const e = Math.exp(scoreBuf[j]! - mx);
          scoreBuf[j] = e;
          sum += e;
        }
        for (let j = 0; j < n; j++) scoreBuf[j] = scoreBuf[j]! / sum;

        // 交叉熵的梯度：p − onehot
        scoreBuf[label] = scoreBuf[label]! - 1;
        for (let j = 0; j < n; j++) {
          const gk = scoreBuf[j]!;
          if (gk === 0) continue;
          const off = j * ACTION_DIM;
          for (let i = 0; i < STATE_DIM; i++) grad[i]! += gk * state[i]!;
          for (let i = 0; i < ACTION_DIM; i++) grad[STATE_DIM + i]! += gk * feats[off + i]!;
          gradB += gk;
        }
        steps += 1;
        pending += 1;
        if (pending >= BATCH) flush();
      }

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
  }
  flush();

  const dw = new Array<number>(JOINT);
  for (let i = 0; i < JOINT; i++) dw[i] = w[i]! - w0[i]!;
  return { dw, db: b - b0, steps, hitK, hit1, hits, sumN };
}

/** 从权重里抽出预筛那一半，摊成 [w(JOINT); b] 方便整体更新 */
function flatOf(wt: Weights): Float64Array {
  const v = new Float64Array(JOINT + 1);
  for (let i = 0; i < JOINT; i++) v[i] = wt.prescreen.w[i]!;
  v[JOINT] = wt.prescreen.b;
  return v;
}

if (SERVE) {
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    const t = line.trim();
    if (!t) return;
    if (t === 'bye') process.exit(0);
    const [from, count, seed0] = t.split(/\s+/).map(Number);
    void seed0;
    const games: number[] = [];
    for (let i = 0; i < (count ?? 1); i++) games.push(from! + i);
    const flat = flatOf(template);
    const d = trainChunk(games, flat.subarray(0, JOINT), flat[JOINT]!);
    process.stdout.write('DELTA ' + JSON.stringify(d) + '\n');
  });
} else {
  void main();
}

async function main(): Promise<void> {
  let flat = flatOf(template);
  // 基线召回：用**随机初始化的预筛**先量一次，否则后面那个数没有参照
  let baseHit = -1;
  let baseSteps = 0;

  const PASSES = Number(argOf('passes', '3'));
  for (let pass = 0; pass < PASSES; pass++) {
    const seedBase = SEED0 + pass * 10007;
    const deltas = await gather(seedBase);
    const steps = deltas.reduce((a, d) => a + d.steps, 0);
    const hitK = deltas.reduce((a, d) => a + d.hitK, 0);
    const hit1 = deltas.reduce((a, d) => a + d.hit1, 0);
    const sumN = deltas.reduce((a, d) => a + d.sumN, 0);
    if (baseHit < 0) {
      baseHit = hitK;
      baseSteps = steps;
    }
    // 模型平均：每个 worker 的增量除以 worker 数（它们都从同一份权重出发）
    for (let i = 0; i <= JOINT; i++) {
      let acc = 0;
      for (const d of deltas) acc += i < JOINT ? d.dw[i]! : d.db;
      flat[i]! += acc / deltas.length;
    }
    console.log(
      `第 ${pass + 1} 遍：${deltas.length} 进程 · ${steps} 步（平均每步 ${(sumN / Math.max(1, steps)).toFixed(0)} 个合法动作）` +
        ` · 老师动作的排名 top-${TOPK} 命中 ${((hitK / Math.max(1, steps)) * 100).toFixed(1)}%` +
        ` · top-1 ${((hit1 / Math.max(1, steps)) * 100).toFixed(1)}%`,
    );
    if (pass === 0) {
      console.log(
        `  基线（随机预筛）：top-${TOPK} 命中 ${((baseHit / Math.max(1, baseSteps)) * 100).toFixed(1)}%`,
      );
      if (KS.length > 0) {
        const hits = KS.map((_, q) => deltas.reduce((a, d) => a + (d.hits[q] ?? 0), 0));
        console.log(
          '  换个 K 会怎样：' +
            KS.map((k, q) => `K=${k} ${((hits[q]! / Math.max(1, steps)) * 100).toFixed(1)}%`).join(' · '),
        );
      }
    }
  }

  const out: Weights = {
    ...template,
    prescreen: {
      w: Float32Array.from({ length: JOINT }, (_, i) => Math.fround(flat[i]!)),
      b: Math.fround(flat[JOINT]!),
    },
  };
  fs.mkdirSync(path.dirname(path.resolve(OUT)), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(weightsToJson(out)));
  console.log(`权重 → ${OUT}（预筛已训练，打分头与价值头原样沿用 ${WEIGHTS}）`);
}

/** 把这一遍的局分给若干 worker，收回增量 */
function gather(seedBase: number): Promise<Delta[]> {
  const lanes = Math.min(WORKERS, GAMES);
  return new Promise<Delta[]>((resolve, reject) => {
    const self = fileURLToPath(import.meta.url);
    const childArgs = [
      '--experimental-strip-types',
      self,
      '--serve',
      '--seed0',
      String(seedBase),
      '--cap',
      String(CAP),
      '--weights',
      WEIGHTS,
      '--ai-level',
      AI_LEVEL,
      '--batch',
      String(BATCH),
      '--lr',
      String(LR),
      '--l2',
      String(L2),
      '--ks',
      KS.join(','),
    ];
    const kids = Array.from({ length: lanes }, () =>
      spawn(process.execPath, childArgs, { stdio: ['pipe', 'pipe', 'inherit'] }),
    );
    const out: Delta[] = [];
    let next = 0;
    let issued = 0;
    let dead = 0;

    const finish = () => {
      for (const kid of kids) {
        try {
          kid.stdin.write('bye\n');
          kid.stdin.end();
        } catch {
          /* 已经死了 */
        }
        kid.unref();
      }
      resolve(out);
    };

    const dispatch = (i: number) => {
      const kid = kids[i]!;
      if (next >= GAMES) {
        try {
          kid.stdin.write('bye\n');
        } catch {
          /* ignore */
        }
        return;
      }
      // 每块至少 4 局：批太小的话"模型平均"会把每个 worker 的不同噪声也平均掉
      const from = next;
      const count = Math.max(1, Math.min(Math.ceil(GAMES / (lanes * 2)), GAMES - from));
      next += count;
      issued += 1;
      kid.stdin.write(`${from} ${count} ${seedBase}\n`);
    };

    kids.forEach((kid, i) => {
      const rl = readline.createInterface({ input: kid.stdout });
      rl.on('line', (line) => {
        if (!line.startsWith('DELTA ')) return;
        out.push(JSON.parse(line.slice(6)) as Delta);
        if (out.length === issued && next >= GAMES) {
          finish();
          return;
        }
        dispatch(i);
      });
      kid.on('close', () => {
        dead += 1;
        if (dead === kids.length) {
          if (out.length === 0) reject(new Error('所有 worker 都没交回结果'));
          else finish();
        } else if (out.length === issued && next >= GAMES) {
          finish();
        }
      });
      dispatch(i);
    });
  });
}
