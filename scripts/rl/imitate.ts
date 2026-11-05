/**
 * 模仿学习的数据采集：让**手写 AI 当老师**，把它的每一步选择录成训练集。
 *
 * ── 为什么要有这一步 ────────────────────────────────────────────────────
 *
 * 直接从随机权重上跑 PPO，采样结果是这样的（10×10 + 血战，对高级档 AI）：
 *
 *     六轮 × 160 局 = 960 局，**一局没赢**。KL 1e-3（PPO 的健康带）、
 *     logp 从 −2.588 慢慢爬到 −2.492、熵从 2.61 掉到 2.56，胜率 0.0% 一动不动。
 *
 * 原因不是 PPO 有 bug，是**没有对比**：每局都输，每一步的终局奖励都是 −1，
 * 优势里就没有"这一步比那一步好"的信息，只剩价值头的拟合残差在冒充梯度。
 * 降到初级档也一样——初级档的 AI 对随机策略仍然是 40:0（实测）。
 * 换句话说：随机策略在这游戏里等于"不会下棋"，而不会下棋是没有东西可学的。
 *
 * 所以先做**行为克隆**（behavior cloning）：学 AI 的选择，把策略先抬到"会下棋"，
 * 再让 PPO 去超过老师。这一步的样本是免费的（自己跟自己下就行），成本只有算力。
 *
 * ── 录什么 ──────────────────────────────────────────────────────────────
 *
 *   state 148 · 候选 17×56（预筛 top-16，老师的动作不在里面就顶掉最后一名）
 *   · 标签下标 · 真正几个候选 · 这一局的终局结果（价值头的目标）· 局号
 *
 * 候选集刻意做成"推理时那 16 个 + 老师那一个"，而不是全部合法动作：
 * 训练和推理必须看同一批候选，否则预筛决定了学生永远学不到"老师为什么选了
 * 一个预筛不喜欢的动作"。
 *
 * ── 学不到的地方（要记住）──────────────────────────────────────────────
 *
 *   `scripts/rl/legal.ts` 不枚举 BUILD / LOAD / UNLOAD / HERO_SKILL / DISBAND / PLACE_EGG。
 *   老师走出这些动作的那一步无法表示成候选，只能跳过——跳过率会打在输出里。
 *
 * 用法：
 *   node --experimental-strip-types scripts/rl/imitate.ts --games 240 --seed0 12000 \
 *        --weights scripts/rl/weights/init.json --out .tmp/bc/data
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
import { Policy, weightsFromJson } from './policy.ts';

const args = process.argv.slice(2);
const argOf = (name: string, dflt: string): string => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? (args[i + 1] as string) : dflt;
};
const flag = (name: string): boolean => args.includes(`--${name}`);

const GAMES = Number(argOf('games', '120'));
const SEED0 = Number(argOf('seed0', '12000'));
const OUT = argOf('out', path.join('.tmp', 'bc', 'data'));
const WEIGHTS = argOf('weights', path.join('scripts', 'rl', 'weights', 'init.json'));
const CAP = Number(argOf('cap', String(TRAIN.capTurns)));
const AI_LEVEL = argOf('ai-level', 'advanced') as AiLevel;
const WORKERS = Number(argOf('workers', String(Math.max(1, Math.round(os.cpus().length / 2)))));
const SERVE = flag('serve');

const weights = weightsFromJson(JSON.parse(fs.readFileSync(WEIGHTS, 'utf8')));
// 这里用 Policy 只为借它的**预筛**：候选集必须和推理时那批一模一样。
// 网络本身在训练里会被完全重写，所以起点是初始权重还是训过的都无所谓。
const policy = new Policy(weights);
const K = policy.topK;
/** 候选槽位 = top-K 再给"老师那个动作"留一个位置 */
const SLOTS = K + 1;
/** label · kUsed · 价值目标 · 局号 */
const META = 4;
const WIDTH = STATE_DIM + SLOTS * ACTION_DIM + META;

/**
 * 两个动作是不是同一个。
 *
 * 不能直接 `JSON.stringify` 比值：字段顺序、可选坐标（`x`/`y` 有时给有时不给）
 * 都会让字面量不同，而语义是同一个动作。这里只比"决定性的那几个字段"，
 * 坐标只在两边都给了的时候才比。
 */
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

interface GameRow {
  seed: number;
  steps: number;
  /** 老师在合法动作列表里找不到的步数（BUILD / 上下船等，见文件头） */
  skipped: number;
  winner: PlayerId | null;
  turns: number;
}

class RowBuf {
  data = new Float32Array(WIDTH * 256);
  n = 0;
  slot(): number {
    if ((this.n + 1) * WIDTH > this.data.length) {
      const next = new Float32Array(this.data.length * 2);
      next.set(this.data);
      this.data = next;
    }
    return this.n++;
  }
}

/** 跑一局 AI 打 AI，两边都录 */
function runMatch(g: number, seed: number): { rows: Float32Array; meta: GameRow } {
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

  const buf = new RowBuf();
  const mine = new Map<PlayerId, number[]>();
  let turnSeat: PlayerId | null = null;
  let inTurn = 0;
  let budget = { ...DEFAULT_BUDGET };
  const rejected = new Set<string>();
  let skipped = 0;

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

    if (label >= 0) {
      const cs = policy.candidateSet(s, seat, acts, label);
      const slot = buf.slot();
      const base = slot * WIDTH;
      buf.data.set(cs.state, base);
      for (let i = 0; i < cs.candidates.length; i++) {
        const src = cs.candidates[i]! * ACTION_DIM;
        buf.data.set(cs.feats.subarray(src, src + ACTION_DIM), base + STATE_DIM + i * ACTION_DIM);
      }
      const tail = base + STATE_DIM + SLOTS * ACTION_DIM;
      buf.data[tail + 0] = cs.index;
      buf.data[tail + 1] = cs.kUsed;
      buf.data[tail + 2] = 0; // 价值目标，终局回填
      buf.data[tail + 3] = g;
      let list = mine.get(seat);
      if (!list) {
        list = [];
        mine.set(seat, list);
      }
      list.push(slot);
    } else {
      skipped += 1;
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

  // 价值目标 = 这一局对**那个座位**的结果。整局所有步都用同一个数：
  // 价值头要学的是"从这个局面出发能赢吗"，不是"这一步拿了多少分"。
  for (const [seat, slots] of mine) {
    const v = s.winner === null ? 0 : s.winner === seat ? 1 : -1;
    for (const slot of slots) buf.data[slot * WIDTH + STATE_DIM + SLOTS * ACTION_DIM + 2] = v;
  }

  return {
    rows: buf.data.subarray(0, buf.n * WIDTH),
    meta: { seed, steps: buf.n, skipped, winner: s.winner ?? null, turns: s.turn },
  };
}

/**
 * 出队侧：按局号顺序写盘（worker 完成顺序是乱的，字节序必须是确定的）。
 * 帧协议与 rollout.ts 同构：`OK <局号> <字节数> <元数据>\n` + 原始 float32。
 */
class Sink {
  readonly fd: number;
  private pending = new Map<number, { rows: Float32Array; meta: GameRow }>();
  private cursor = 0;
  totalRows = 0;
  readonly perGame: GameRow[] = new Array<GameRow>(GAMES);

  constructor(outPath: string) {
    fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
    this.fd = fs.openSync(outPath, 'w');
  }

  push(g: number, rows: Float32Array, meta: GameRow): void {
    this.pending.set(g, { rows, meta });
    while (this.pending.has(this.cursor)) {
      const cur = this.pending.get(this.cursor)!;
      this.pending.delete(this.cursor);
      if (cur.rows.length > 0) {
        fs.writeSync(this.fd, Buffer.from(cur.rows.buffer, cur.rows.byteOffset, cur.rows.byteLength));
      }
      this.totalRows += cur.rows.length / WIDTH;
      this.perGame[this.cursor] = cur.meta;
      this.cursor += 1;
    }
  }

  close(): void {
    fs.closeSync(this.fd);
    if (this.cursor !== GAMES) throw new Error(`只收到 ${this.cursor}/${GAMES} 局`);
  }
}

if (SERVE) {
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    const t = line.trim();
    if (!t) return;
    if (t === 'bye') process.exit(0);
    const [g, seed] = t.split(/\s+/).map(Number);
    const out = runMatch(g ?? 0, seed ?? SEED0);
    const bytes = out.rows.byteLength;
    process.stdout.write(`OK ${g} ${bytes} ${JSON.stringify(out.meta)}\n`);
    if (bytes > 0) process.stdout.write(Buffer.from(out.rows.buffer, out.rows.byteOffset, bytes));
  });
} else {
  void main();
}

async function main(): Promise<void> {
  const t0 = performance.now();
  const sink = new Sink(`${OUT}.bin`);
  if (WORKERS <= 1 || GAMES <= 1) {
    for (let g = 0; g < GAMES; g++) {
      const out = runMatch(g, SEED0 + g);
      sink.push(g, out.rows, out.meta);
    }
  } else {
    await runPool(Math.min(WORKERS, GAMES), sink);
  }
  sink.close();

  const skipped = sink.perGame.reduce((a, b) => a + b.skipped, 0);
  const decisions = sink.totalRows;
  const decisive = sink.perGame.filter((p) => p.winner).length;
  const turns = sink.perGame.map((p) => p.turns).sort((a, b) => a - b);
  fs.writeFileSync(
    `${OUT}.json`,
    JSON.stringify(
      {
        v: 1,
        width: WIDTH,
        state: STATE_DIM,
        action: ACTION_DIM,
        slots: SLOTS,
        k: K,
        rows: decisions,
        games: GAMES,
        seed0: SEED0,
        weights: WEIGHTS,
        aiLevel: AI_LEVEL,
        size: TRAIN.size,
        expansions: TRAIN.expansions,
        skipped,
        decisive,
        medianTurns: turns.length ? turns[turns.length >> 1] : 0,
        perGame: sink.perGame,
      },
      null,
      2,
    ),
  );

  const secs = (performance.now() - t0) / 1000;
  console.log(
    `采样 ${GAMES} 局（AI 打 AI，${AI_LEVEL}）：${decisions} 条决策 · 跳过 ${skipped} 步` +
      `（${((skipped / Math.max(1, skipped + decisions)) * 100).toFixed(1)}%，动作不在合法枚举里）` +
      ` · 分胜负 ${decisive} · ${secs.toFixed(1)}s → ${OUT}.bin`,
  );
}

function runPool(lanes: number, sink: Sink): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const self = fileURLToPath(import.meta.url);
    const childArgs = [
      '--experimental-strip-types',
      self,
      '--serve',
      '--seed0',
      String(SEED0),
      '--cap',
      String(CAP),
      '--weights',
      WEIGHTS,
      '--ai-level',
      AI_LEVEL,
    ];
    const kids = Array.from({ length: lanes }, () =>
      spawn(process.execPath, childArgs, { stdio: ['pipe', 'pipe', 'inherit'] }),
    );
    // worker 崩掉（OOM 最常见）之后，父进程下一次 write 会拿到 EPIPE 并作为
    // 'error' 事件抛出——没人接就整个进程崩，一次崩溃会把整轮采样白扔。
    // 吞掉它：那个 worker 的 `close` 回调会照常触发，缺的局由 Sink 的最后检查报出来。

    let next = 0;
    let issued = 0;
    let got = 0;
    let dead = 0;
    const inflight = new Array<boolean>(lanes).fill(false);

    const finish = () => {
      for (const kid of kids) {
        try {
          kid.stdin.write('bye\n');
          kid.stdin.end();
        } catch {
          /* 已经死了就算了 */
        }
        kid.unref();
      }
      resolve();
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
      const g = next;
      next += 1;
      issued += 1;
      inflight[i] = true;
      kid.stdin.write(`${g} ${SEED0 + g}\n`);
    };

    kids.forEach((kid, i) => {
      let acc: Buffer = Buffer.alloc(0);
      kid.stdin.on('error', () => {
        /* EPIPE：worker 已经死了，交给 close 分支处理 */
      });
      kid.stdout.on('data', (chunk: Buffer) => {
        acc = acc.length === 0 ? chunk : Buffer.concat([acc, chunk]);
        for (;;) {
          const nl = acc.indexOf(10);
          if (nl < 0) return;
          const head = acc.subarray(0, nl).toString('utf8');
          if (!head.startsWith('OK ')) {
            acc = acc.subarray(nl + 1);
            continue;
          }
          const p1 = head.indexOf(' ', 3);
          const p2 = head.indexOf(' ', p1 + 1);
          const g = Number(head.slice(3, p1));
          const bytes = Number(head.slice(p1 + 1, p2));
          if (acc.length < nl + 1 + bytes) return;
          const raw = Buffer.from(acc.subarray(nl + 1, nl + 1 + bytes));
          acc = acc.subarray(nl + 1 + bytes);
          sink.push(g, new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4), JSON.parse(head.slice(p2 + 1)) as GameRow);
          got += 1;
          inflight[i] = false;
          if (got === issued && next >= GAMES) {
            finish();
            return;
          }
          dispatch(i);
        }
      });
      kid.on('close', () => {
        dead += 1;
        if (inflight[i]) {
          inflight[i] = false;
          issued -= 1;
        }
        if (dead === kids.length) {
          if (got < GAMES) reject(new Error(`所有 worker 都退出了，但只收到 ${got}/${GAMES} 局`));
          else finish();
        } else if (got === issued && next >= GAMES) {
          finish();
        }
      });
      dispatch(i);
    });
  });
}
