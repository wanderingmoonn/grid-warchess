/**
 * 配对评估台：量"这个策略有多强"，并且**只**量这一件事。
 *
 * ── 为什么要"配对" ───────────────────────────────────────────────────────
 *
 * 一局棋的胜负噪声极大：同一套 AI，换一张图能差出 20 个百分点，而先后手
 * 在 10×10 上还能再差出 25 个百分点（见 docs/RL-PLAN.md 7.4 的实测）。
 * 所以同一颗种子跑两遍、两边各坐一次先后手，把这个组合当成一个样本——
 * "地图运气"和"先手优势"就被约掉，剩下的差才可能是策略本身的差。
 *
 * 200 局配对的区间约 ±7 个百分点，这就是 M3 判据写"≥55%"而不是"≥50%"的原因。
 *
 * ── 四个模式 ─────────────────────────────────────────────────────────────
 *
 *   · `selfcheck`：双方都是手写 AI，每颗种子只跑一局。它量的是**这张图和这套规则
 *     本身的先手优势**（10×10 上是 62%），用来对齐 `expansions.ts` 里记着的历史数据
 *     （12×12 上 66.7%）。量出来对不上，说明评估台或规则被别人动过了。
 *   · `policy`：候选方坐策略，对手坐手写 AI，每颗种子座位互换跑两局。
 *   · `mirror`：**同一份权重坐两边**。没有训练过的对称权重应该打出 50%；打不出，
 *     说明编码/网络里藏着视角不对称。
 *   · `random`：候选方随机走子。用来确认"这台子分得清菜和强"——
 *     如果随机也能拿 45%，那它量不出任何东西。
 *
 * ── 为什么有这么多进程编排的代码 ─────────────────────────────────────────
 *
 * 一局 10×10 要 3~24 秒，其中 98% 是手写 AI 在想（每步 11~22ms）。200 局就是
 * 半小时的单核算力，必须摊到 32 核上。但一局棋的时长方差有五倍，
 * "等分成 N 份"会让最慢那个 worker 决定总时长（实测只能吃到七成机器），
 * 而"每局起一个进程"又要反复付 2~3 秒的模块加载与 JIT。
 *
 * 所以：**常驻 worker + 一局一块的动态派活**。每个 worker 只启动一次，
 * 谁空谁拿下一块；块小到"一局"，尾巴就只剩一局。
 *
 * 用法：
 *   npm run rl:selfcheck -- --games 200
 *   npm run rl:eval      -- --games 200 --weights scripts/rl/weights/iter-010.json
 *   ... --size 8 --workers 8 --out .tmp/eval.json
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { playMatch, type Driver, type MatchOutcome } from './play.ts';
import type { AiLevel, PlayerId } from '../../src/core/types.ts';
import { EVAL } from './config.ts';
import { wilson } from './stats.ts';
import { Policy, weightsFromJson } from './policy.ts';
import { INTENT_NAMES } from './features.ts';
import type { Intent } from './features.ts';
import { hashSeed, mulberry32 } from './rng.ts';

const args = process.argv.slice(2);
const argOf = (name: string, dflt: string): string => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? (args[i + 1] as string) : dflt;
};
const flag = (name: string): boolean => args.includes(`--${name}`);

type Mode = 'selfcheck' | 'policy' | 'mirror' | 'random';

const MODE = argOf('mode', 'selfcheck') as Mode;
const GAMES = Number(argOf('games', '200'));
const SIZE = Number(argOf('size', String(EVAL.size)));
const SEED0 = Number(argOf('seed0', '1000'));
const CAP = Number(argOf('cap', String(EVAL.capTurns)));
const WEIGHTS = argOf('weights', '');
const TOPK = Number(argOf('topk', '0'));
const TEMP = Number(argOf('temp', '1'));
const OUT = argOf('out', '');
// 默认 = 逻辑核数的一半（本机 7945HX：16 核 32 线程）。
// 为什么不是 32：这些 worker 是纯计算、不 IO，超线程只能填流水线空档，实测 31 个
// 一起跑反而比 16 个慢——一局棋本身就吃满一个核，多出来的进程只是在抢缓存和带宽。
const WORKERS = Number(argOf('workers', String(Math.max(1, Math.round(os.cpus().length / 2)))));
// 训练与评估用同一套规则：扩展包名单从命令行进来（'none' 表示只开基础包）
const EXPANSIONS = argOf('expansions', EVAL.expansions.join(',') || 'none');
/** 手写 AI 坐哪一档。课程学习期间训练用的档位和最终目标档必须分开报 */
const AI_LEVEL = argOf('ai-level', EVAL.aiLevel) as AiLevel;
/** 手写 AI 的削弱概率（0 = 原样）。用来量"胜率从哪一档开始不为 0" */
const AI_HANDICAP = Number(argOf('ai-handicap', '0'));
/**
 * 给策略什么意图。
 *
 * `auto`（默认）就是"不说打法，自己判断"，v1 的口径。
 * `random` 按种子给每一局抽一个，用来验"它是不是真的会按口令换打法"——
 * 以及最重要的那条：**同一批种子、不同意图，前 20 手要有明显差别**。
 */
const INTENT = argOf('intent', 'auto') as Intent | 'random';
const expIds = EXPANSIONS === 'none' || EXPANSIONS === '' ? [] : EXPANSIONS.split(',');
/** 一次派给 worker 几局。1 = 最细的粒度（尾巴最短），再小就得靠 worker 常驻来抵启动成本 */
const CHUNK = Number(argOf('chunk', '1'));
const CHILD = flag('child') || flag('serve');
const SERVE = flag('serve');
const FROM = Number(argOf('from', '0'));
const COUNT = Number(argOf('count', '1'));

export interface GameRecord {
  seed: number;
  /** 候选方坐哪一边 */
  candidateSeat: 'A' | 'B';
  winner: PlayerId | null;
  turns: number;
  steps: number;
  timeout: boolean;
  rejected: number;
}

/**
 * 全局局号 → (种子, 候选方座位)。
 *
 * 为什么要"局号"这一层：worker 之间要能只凭一个数字就知道自己该跑哪一局
 * （传结构体就得序列化，传一个整数最省事）。同一个种子在配对里出现两次，
 * 局号相邻，所以任何一块连续的局号都尽量落在同一张图上——缓存友好，
 * 也方便人肉核对"第 7 局和第 8 局是同一颗种子"。
 */
function gameAt(index: number): { seed: number; seat: 'A' | 'B' } {
  if (MODE === 'selfcheck') return { seed: SEED0 + index, seat: 'A' };
  return { seed: SEED0 + (index >> 1), seat: index & 1 ? 'B' : 'A' };
}

/** 一共有多少局。selfcheck 一颗种子一局，其余一颗种子两局（座位互换） */
function totalGames(): number {
  if (MODE === 'selfcheck') return Math.max(1, GAMES);
  return Math.max(2, GAMES - (GAMES % 2));
}

function loadPolicy(): Policy {
  if (!WEIGHTS) throw new Error(`--mode ${MODE} 必须给 --weights`);
  const raw = JSON.parse(fs.readFileSync(WEIGHTS, 'utf8'));
  return new Policy(weightsFromJson(raw), { topK: TOPK > 0 ? TOPK : undefined, temperature: TEMP });
}

function candidateDriver(): Driver {
  if (MODE === 'random') return { kind: 'random' };
  if (MODE === 'policy' || MODE === 'mirror') {
    const p = loadPolicy();
    if (INTENT !== 'random') p.intent = INTENT;
    return { kind: 'policy', policy: p };
  }
  return { kind: 'ai' };
}

/** 对手那一侧：mirror 模式用同一份权重坐对面（自己跟自己下，看视角对不对称） */
function opponentDriver(candidate: Driver): Driver {
  if (MODE === 'mirror') {
    if (candidate.kind !== 'policy') throw new Error('mirror 模式要策略权重');
    return {
      kind: 'policy',
      policy: new Policy(candidate.policy.weights, { topK: candidate.policy.topK, temperature: TEMP }),
    };
  }
  return { kind: 'ai' };
}

/** 跑一段连续的局号 */
function runGames(from: number, count: number): GameRecord[] {
  const driver = candidateDriver();
  const foe = opponentDriver(driver);
  const out: GameRecord[] = [];
  for (let i = from; i < from + count; i++) {
    const { seed, seat } = gameAt(i);
    // 意图按种子定：同一批种子重跑会得到同一份意图分配
    if (INTENT === 'random' && driver.kind === 'policy') {
      const r = mulberry32(hashSeed(seed, seat, 'intent'))();
      driver.policy.intent = INTENT_NAMES[Math.floor(r * INTENT_NAMES.length)] ?? 'auto';
    }
    const drivers: [Driver, Driver] = seat === 'A' ? [driver, foe] : [foe, driver];
    const r: MatchOutcome = playMatch({
      seed,
      size: SIZE,
      capTurns: CAP,
      drivers,
      expansionIds: expIds,
      aiLevel: AI_LEVEL,
      aiHandicap: AI_HANDICAP,
    });
    out.push({
      seed,
      candidateSeat: seat,
      winner: r.winner,
      turns: r.turns,
      steps: r.steps,
      timeout: r.timeout,
      rejected: r.rejected,
    });
  }
  return out;
}

function summarise(records: GameRecord[]) {
  let wins = 0;
  let losses = 0;
  let draws = 0;
  let timeouts = 0;
  let rejected = 0;
  let turns = 0;
  let steps = 0;
  let seatAWins = 0;
  let seatAGames = 0;
  for (const r of records) {
    if (r.winner === null) draws += 1;
    else if (r.winner === r.candidateSeat) wins += 1;
    else losses += 1;
    if (r.timeout) timeouts += 1;
    rejected += r.rejected;
    turns += r.turns;
    steps += r.steps;
    if (r.winner) {
      seatAGames += 1;
      if (r.winner === 'A') seatAWins += 1;
    }
  }
  const n = records.length;
  // 平局按半分算：既不算赢也不算输，比"直接丢掉"更保守（丢掉会虚高）
  const score = wins + draws * 0.5;
  const ci = wilson(score, n);
  return {
    games: n,
    wins,
    losses,
    draws,
    timeouts,
    rejected,
    winRate: n > 0 ? score / n : 0,
    ci95: [Number(ci.lo.toFixed(4)), Number(ci.hi.toFixed(4))] as [number, number],
    seatAWinRate: seatAGames > 0 ? seatAWins / seatAGames : 0,
    avgTurns: n > 0 ? turns / n : 0,
    avgSteps: n > 0 ? steps / n : 0,
  };
}

// ── worker 侧：常驻，读一行跑一段，写一行结果 ─────────────────────────
if (SERVE) {
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    const s = line.trim();
    if (!s) return;
    if (s === 'bye') {
      process.exit(0);
    }
    const [from, count] = s.split(/\s+/).map(Number);
    const records = runGames(from ?? 0, count ?? 1);
    process.stdout.write('RECORDS ' + JSON.stringify(records) + '\n');
  });
} else if (CHILD) {
  // 一次性子进程（调试用：--child --from N --count M）
  process.stdout.write('RECORDS ' + JSON.stringify(runGames(FROM, COUNT)) + '\n');
} else {
  const total = totalGames();
  const t0 = performance.now();
  let records: GameRecord[] = [];

  if (WORKERS <= 1 || total <= 1) {
    records = runGames(0, total);
  } else {
    const self = fileURLToPath(import.meta.url);
    const lanes = Math.min(WORKERS, Math.ceil(total / CHUNK));
    const childArgs = [
      '--experimental-strip-types',
      self,
      '--serve',
      '--mode',
      MODE,
      '--size',
      String(SIZE),
      '--seed0',
      String(SEED0),
      '--cap',
      String(CAP),
      '--expansions',
      EXPANSIONS,
      '--ai-level',
      AI_LEVEL,
      '--ai-handicap',
      String(AI_HANDICAP),
      '--temp',
      String(TEMP),
      ...(WEIGHTS ? ['--weights', WEIGHTS] : []),
      ...(TOPK > 0 ? ['--topk', String(TOPK)] : []),
    ];

    records = await runPool(total, lanes, CHUNK, childArgs);
  }

  // 排序后再统计：worker 的返回顺序取决于谁先算完
  records.sort((a, b) => a.seed - b.seed || (a.candidateSeat < b.candidateSeat ? -1 : 1));

  const sum = summarise(records);
  const elapsed = (performance.now() - t0) / 1000;
  const cores = Math.min(WORKERS, Math.max(1, Math.ceil(total / CHUNK)));
  const label =
    MODE === 'selfcheck' ? '手写 AI vs 手写 AI（先手优势的量尺）'
    : MODE === 'random' ? '随机策略 vs 手写 AI'
    : MODE === 'mirror' ? '同一份权重自己对自己（视角自检）'
    : '策略 vs 手写 AI';

  console.log(`\n${label} · ${SIZE}×${SIZE} · ${sum.games} 局 · ${cores} worker · 墙钟 ${elapsed.toFixed(1)}s`);
  console.log(
    `  胜 ${sum.wins} / 负 ${sum.losses} / 平 ${sum.draws}（超时 ${sum.timeouts}）→ 得分率 ${(sum.winRate * 100).toFixed(1)}%` +
      `  95% 区间 [${(sum.ci95[0] * 100).toFixed(1)}%, ${(sum.ci95[1] * 100).toFixed(1)}%]`,
  );
  console.log(
    `  先手方胜率 ${(sum.seatAWinRate * 100).toFixed(1)}% · 平均 ${sum.avgTurns.toFixed(0)} 回合 / ${sum.avgSteps.toFixed(0)} 步`,
  );
  if (sum.rejected > 0) console.log(`  ⚠ 引擎拒绝了 ${sum.rejected} 个动作（枚举与规则可能漂了）`);

  if (OUT) {
    fs.writeFileSync(
      OUT,
      JSON.stringify(
        {
          mode: MODE,
          size: SIZE,
          games: sum.games,
          seed0: SEED0,
          cap: CAP,
          expansions: expIds,
          weights: WEIGHTS || null,
          topK: TOPK || null,
          temperature: TEMP,
          summary: sum,
          elapsedSec: Number(elapsed.toFixed(2)),
          records,
        },
        null,
        2,
      ),
    );
    console.log(`  明细已写入 ${OUT}`);
  }
}


/**
 * 常驻 worker 的派活池。
 *
 * 每个 worker 只 spawn 一次（模块加载 + JIT 约 2~3 秒，一局棋才 3~24 秒，
 * 每局重开一次进程等于白烧三成算力），之后靠 stdin 收"局号 数量"、靠 stdout 回一行结果。
 * 谁空谁拿下一块——一局的时长方差有五倍，等分会让最慢那个决定总时长。
 */
function runPool(
  total: number,
  lanes: number,
  chunk: number,
  childArgs: string[],
): Promise<GameRecord[]> {
  const issues: string[] = [];
  return new Promise<GameRecord[]>((resolve) => {
    const out: GameRecord[] = [];
    const kids = Array.from({ length: lanes }, () => spawn(process.execPath, childArgs, { stdio: ['pipe', 'pipe', 'inherit'] }));
    let next = 0;
    let issued = 0;
    let done = 0;
    let closed = 0;
    // 每个 worker 手上有没有一块活：它崩了就把那块的"已派"数退回来，否则永远等不到结果
    const inflight = new Array<boolean>(lanes).fill(false);

    const finish = () => {
      // 收工时要**主动把 worker 都打发走**：它们的 stdin/stdout 还是活着的管道，
      // 不关掉的话父进程的事件循环永远不空——数据算完了却退不出去，
      // 表现就是"跑了十分钟还没打印结果"（这是踩过的坑，别删）。
      for (const kid of kids) {
        try {
          kid.stdin.write('bye\n');
          kid.stdin.end();
        } catch {
          /* 已经死了就算了 */
        }
        kid.unref();
      }
      resolve(out);
    };

    const dispatch = (i: number) => {
      const kid = kids[i]!;
      if (next >= total) {
        kid.stdin.write('bye\n');
        return;
      }
      const from = next;
      const count = Math.min(chunk, total - from);
      next += count;
      issued += 1;
      inflight[i] = true;
      issues.push(`${from}+${count}`);
      kid.stdin.write(`${from} ${count}\n`);
    };

    kids.forEach((kid, i) => {
      const rl = readline.createInterface({ input: kid.stdout });
      rl.on('line', (line) => {
        if (!line.startsWith('RECORDS ')) return;
        out.push(...(JSON.parse(line.slice(8)) as GameRecord[]));
        done += 1;
        inflight[i] = false;
        if (done === issued && next >= total) {
          // 全部分派完且全部回来：让还活着的 worker 退出，结果就够了
          finish();
          return;
        }
        dispatch(i);
      });
      kid.on('close', () => {
        // worker 意外退出（OOM、崩溃）：把它手上那块算作丢失，交给别人重跑太复杂，
        // 直接报出来——统计里少几局会立刻体现在 games 数上，不会悄悄变成"胜率很好看"
        closed += 1;
        if (inflight[i]) { inflight[i] = false; issued -= 1; }
        if (closed === kids.length || (done === issued && next >= total)) finish();
      });
      dispatch(i);
    });
    if (lanes === 0) finish();
  });
}
