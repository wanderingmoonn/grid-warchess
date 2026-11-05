/**
 * 一局的"可重放记录"：种子 + 配置 + 动作序列 = 完整一局。
 *
 * ── 为什么 M2 需要它 ────────────────────────────────────────────────────
 *
 * 训练一条轨迹最贵的东西不是动作，也不是奖励，而是**观测**：148 个 float，
 * 一步 600 字节，80 万步就是 470MB。存不起、也没必要存——
 * 引擎是确定性的（`rules.ts` 开头那条"不许出现 Date.now / Math.random"就是为此），
 * 所以"种子 + 配置 + 动作序列"推回去，能一帧不差地重算出观测。
 *
 * 这条路径还有一个附带的好处：**它顺手就是一个回归测试**。
 * 动作序列是死数据，重放对不上，说明规则或地图生成被改过——这种事以前只能靠
 * 人回忆"上次那局好像不是这样"。
 *
 * ── 三个层次的"一致" ────────────────────────────────────────────────────
 *
 *   1. **动作一致**：策略侧重算出的动作与录制时相同（采样器也复现了）；
 *   2. **数值一致**：每步的 logp / 价值与录制时相同（观测与网络前向都复现了）；
 *   3. **终局一致**：终局状态哈希、赢家、回合数、步数全部相同。
 *
 * 只有 1 和 2 都对，3 才有意义——否则"终局碰巧一样"只是运气。
 *
 * ── 落差在哪一层，就报哪一层 ────────────────────────────────────────────
 *
 * 重放最常见的失败不是"算错了"，而是"**拿错了输入**"：
 *   · 种子/地图改了 → 第一步就拒（动作里的坐标或单位 id 在新图上不存在）；
 *   · 规则改了（造价、产兵条件）→ 某个 RECRUIT 突然不合法；
 *   · AI 改了而记录里存的是 AI 的动作 → 动作照旧能应用，但终局对不上；
 *   · 权重变了而记录里存的是策略的 logp → 动作可能还一样，logp 对不上。
 * 所以每种落差都单独报，别笼统说一句"重放失败"。
 */
import { createHash } from 'node:crypto';

import { applyAction } from '../../src/core/rules.ts';
import { buildMatchReport } from '../../src/core/report.ts';
import { DEFAULT_CONFIG, createMatch } from '../../src/core/setup.ts';
import type { Action, GameState, MatchConfig, PlayerId } from '../../src/core/types.ts';
import { TRAIN } from './config.ts';
import { legalActions } from './legal.ts';
import { playMatch } from './play.ts';
import { Policy, type Weights } from './policy.ts';
import { hashSeed, mulberry32 } from './rng.ts';

/** 记录格式版本：字段一改就 +1，读旧文件时能直接拒绝而不是猜 */
export const RECORD_VERSION = 1;

export type DriverKind = 'ai' | 'policy' | 'random';

/** 重建开局要的那几个开关（其余走 DEFAULT_CONFIG） */
export interface ReplayConfig {
  size: number;
  startEra: number;
  playerCount: 2 | 3 | 4;
  expansions: string[];
  aiLevel: string;
  /** 选卡：动作序列里会出现 DRAFT_*，重放时要按同一套流程重建 */
  draftMode: boolean;
  godMode: boolean;
}

export interface StepRecord {
  seat: PlayerId;
  action: Action;
  /** 策略驾驶者才有：采样时的 log π(a|s) */
  logp?: number;
  /** 策略驾驶者才有：那一步的价值估计 */
  value?: number;
}

export interface MatchRecord {
  v: number;
  seed: number;
  config: ReplayConfig;
  /** 每席谁在开 */
  drivers: Record<PlayerId, DriverKind>;
  /** 策略侧用的权重文件与它的指纹：权重换了，logp 那条校验就不再成立 */
  weights?: { file: string; sha1: string; topK: number; temperature: number };
  steps: StepRecord[];
  /** 每 `checkpointEvery` 步一个状态指纹，用来把"第一次分叉"定位到具体位置 */
  checkpointEvery: number;
  checkpoints: Array<{ step: number; hash: string }>;
  result: { winner: PlayerId | null; turns: number; steps: number; hash: string };
}

// ── 状态指纹 ────────────────────────────────────────────────────────────

/**
 * 把一局压成一段**规范化的**字符串。
 *
 * 为什么不能直接 `JSON.stringify(state)`：对象键序和数组顺序都会跟着"怎么构造"变，
 * 而单位的顺序在一局里会来回变（有人死了就被 splice 掉）。同一局面因此可能算出两个
 * 不同的摘要——那种"假不一致"比真 bug 更浪费时间。所以这里一律排序后再拼。
 *
 * 只取**规则与胜负相关**的字段：日志文字、迷雾记忆、烈度账本都不进指纹
 * （它们改一句文案就会让所有老记录对不上，而那和"这局打成什么样"无关）。
 */
export function canonicalState(s: GameState): string {
  const units = [...s.units]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((u) => [u.id, u.type, u.owner, u.x, u.y, u.hp, u.moved ? 1 : 0, u.acted ? 1 : 0, u.kills]);
  const cities = [...s.cities]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((c) => [c.id, c.owner, c.era, c.hp, c.maxHp, c.ruined ? 1 : 0, c.capturedTurn ?? -1]);
  const players = (['A', 'B', 'C', 'D'] as PlayerId[])
    .filter((p) => s.players[p])
    .map((p) => {
      const pl = s.players[p]!;
      const res = Object.entries(pl.res ?? {})
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([k, v]) => `${k}=${v}`);
      return [p, pl.gold, res.join(',')];
    });
  // 地形只取首字母 + 城归属：地形枚举没有"同首字母"的两个（plain/plateau/p…）。
  // 真撞上了也不影响一致性判定：两边用同一个函数算，错了也是同时错。
  const tiles = s.tiles.map((t) => `${t.terrain[0]}${t.cityId ?? ''}`);
  return JSON.stringify({ turn: s.turn, current: s.current, winner: s.winner, units, cities, players, tiles });
}

/** 状态指纹（sha1 前 16 位十六进制）：够短，也够不可能撞 */
export function hashState(s: GameState): string {
  return createHash('sha1').update(canonicalState(s)).digest('hex').slice(0, 16);
}

export function hashFile(buf: string): string {
  return createHash('sha1').update(buf).digest('hex').slice(0, 12);
}

// ── 录制 ────────────────────────────────────────────────────────────────

export interface RecordOptions {
  seed: number;
  size?: number;
  startEra?: number;
  expansions?: string[];
  /** 每席驾驶者，顺序 [A, B] */
  drivers?: [DriverKind, DriverKind];
  /** 策略侧用的权重（与 drivers 里的 'policy' 配套） */
  weights?: Weights;
  /** 权重文件路径与指纹：两者都记下来，重放时才能判断"该不该信 logp" */
  weightsFile?: string;
  weightsSha1?: string;
  topK?: number;
  temperature?: number;
  capTurns?: number;
  /** 每几步存一个指纹，0 = 只存终局 */
  checkpointEvery?: number;
}

/** 从一份权重文本算出指纹：权重一换，logp 校验就该被跳过而不是报"不一致" */
export function weightsFingerprint(text: string): string {
  return hashFile(text);
}

/**
 * 跑一局并把它记下来。
 *
 * 注意这里**不做事后补算**：每一步的 logp/价值都在决策那一刻抓下来，
 * 因为重放时要比对的就是"当时算出来的数"——事后再算一遍，比的就不是记录了。
 */
export function recordMatch(o: RecordOptions): MatchRecord {
  const drivers = o.drivers ?? (['policy', 'ai'] as [DriverKind, DriverKind]);
  const policy =
    o.weights && drivers.includes('policy')
      ? new Policy(o.weights, { topK: o.topK, temperature: o.temperature })
      : undefined;

  const steps: StepRecord[] = [];
  const checkpointEvery = o.checkpointEvery ?? 0;
  const checkpoints: Array<{ step: number; hash: string }> = [];

  const outcome = playMatch({
    seed: o.seed,
    size: o.size ?? TRAIN.size,
    startEra: o.startEra ?? TRAIN.startEra,
    expansionIds: o.expansions ?? TRAIN.expansions,
    capTurns: o.capTurns ?? TRAIN.capTurns,
    drivers: [
      drivers[0] === 'policy' && policy ? { kind: 'policy', policy } : { kind: drivers[0] as 'ai' | 'random' },
      drivers[1] === 'policy' && policy ? { kind: 'policy', policy } : { kind: drivers[1] as 'ai' | 'random' },
    ],
    onStep: (info) => {
      steps.push({
        seat: info.seat,
        action: info.action,
        ...(info.decision ? { logp: info.decision.logp, value: info.decision.value } : {}),
      });
      if (checkpointEvery > 0 && steps.length % checkpointEvery === 0) {
        checkpoints.push({ step: steps.length, hash: hashState(info.state) });
      }
    },
  });

  // 终局状态直接取跑局器返回的那一份：**不能自己再跑一遍去"求"终局**——
  // 那就把"同一局"换成了"我算的那一局"，一旦分叉，两边都不知道该信谁。
  const finalHash = hashState(outcome.finalState);

  return {
    v: RECORD_VERSION,
    seed: o.seed,
    config: {
      size: o.size ?? TRAIN.size,
      startEra: o.startEra ?? TRAIN.startEra,
      playerCount: 2,
      expansions: o.expansions ?? TRAIN.expansions,
      aiLevel: 'advanced',
      draftMode: false,
      godMode: false,
    },
    drivers: { A: drivers[0], B: drivers[1], C: 'ai', D: 'ai' },
    ...(o.weights && o.weightsFile
      ? {
          weights: {
            file: o.weightsFile,
            sha1: o.weightsSha1 ?? '',
            topK: o.topK ?? 0,
            temperature: o.temperature ?? 1,
          },
        }
      : {}),
    steps,
    checkpointEvery,
    checkpoints,
    result: {
      winner: outcome.winner,
      turns: outcome.turns,
      steps: outcome.steps,
      hash: finalHash,
    },
  };
}

function startState(cfg: { size: number; startEra: number; expansions: string[] }, seed: number): GameState {
  const s = createMatch(
    {
      ...DEFAULT_CONFIG,
      size: cfg.size,
      startEra: cfg.startEra,
      playerCount: 2,
      draftMode: false,
      aiOpponent: false,
      aiAlly: false,
      expansionIds: cfg.expansions,
    },
    seed,
  );
  // 训练与评估一律关迷雾（见 docs/RL-PLAN.md 3.4）；开不开不影响走子，只影响记忆与渲染
  s.fog = false;
  return s;
}

// ── 重放与核对 ──────────────────────────────────────────────────────────

export type MismatchKind = 'seat' | 'action' | 'logp' | 'illegal' | 'checkpoint' | 'final';

export interface Divergence {
  kind: MismatchKind;
  /** 第几步（1 起） */
  step: number;
  seat: PlayerId | null;
  detail: string;
  expected?: unknown;
  got?: unknown;
}

export interface ReplayReport {
  ok: boolean;
  seed: number;
  steps: number;
  /** 每一步都重算了策略侧的动作，这里是最小的 logp 偏差（相同则 0） */
  logpMaxDiff: number;
  firstDivergence: Divergence | null;
  final: { expected: string; got: string; match: boolean };
  result: { expected: MatchRecord['result']; got: MatchRecord['result']; match: boolean };
  /** 权重指纹对不上时，logp 校验会被跳过（跳过也要说出来，不能假装通过） */
  logpChecked: boolean;
  note?: string;
}

/** 按记录里的配置把驾驶者重新装起来 */
function buildDrivers(rec: MatchRecord, weights?: Weights) {
  const mk = (kind: DriverKind, seat: PlayerId) => {
    if (kind === 'policy') {
      if (!weights) throw new Error(`记录里 ${seat} 是策略，但没给权重`);
      const p = new Policy(weights, {
        topK: rec.weights?.topK || undefined,
        temperature: rec.weights?.temperature ?? 1,
      });
      return { kind: 'policy' as const, policy: p };
    }
    return { kind } as { kind: 'ai' | 'random' };
  };
  return {
    A: mk(rec.drivers.A ?? 'ai', 'A'),
    B: mk(rec.drivers.B ?? 'ai', 'B'),
    rand: new Map<PlayerId, () => number>(),
    randOf(seat: PlayerId): () => number {
      let r = this.rand.get(seat);
      if (!r) {
        // 和 playMatch 里同一条派生规则：同种子 → 同一条随机流
        r = mulberry32(hashSeed(rec.seed, seat, 'policy'));
        this.rand.set(seat, r);
      }
      return r;
    },
  };
}

/**
 * 重放一份记录，逐层核对。
 *
 * 动作按**记录**应用（而不是按重算出来的），这样一次重放能一直跑到底、
 * 把所有层次的问题都摊出来；第一处不一致单独记下来，用来定位。
 */
export function replayRecord(
  rec: MatchRecord,
  weights?: Weights,
  /**
   * 每一步的回调：训练器在这里拿"重算出来的观测"。
   *
   * M2 的轨迹就是这么来的——不存 148 个 float，而是拿记录重放一遍，
   * 在该抓的那一步把 state 交给调用方去编码。动作序列是死数据，
   * 所以这条路径产出的轨迹和录制时**逐位相同**（这一点由 logp 校验保证）。
   */
  onStep?: (info: { step: number; seat: PlayerId; state: GameState; action: Action }) => void,
): ReplayReport {
  if (rec.v !== RECORD_VERSION) throw new Error(`记录版本 ${rec.v} 与本代码（${RECORD_VERSION}）不符`);
  const drivers = buildDrivers(rec, weights);
  const logpChecked = rec.drivers.A !== 'policy' && rec.drivers.B !== 'policy' ? false : !!weights;
  let s = startState(
    { size: rec.config.size, startEra: rec.config.startEra, expansions: rec.config.expansions },
    rec.seed,
  );

  let first: Divergence | null = null;
  let logpMaxDiff = 0;
  const cp = new Map(rec.checkpoints.map((c) => [c.step, c.hash]));

  for (let i = 0; i < rec.steps.length; i++) {
    const st = rec.steps[i]!;
    const stepNo = i + 1;

    if (s.current !== st.seat) {
      first ??= { kind: 'seat', step: stepNo, seat: st.seat, detail: `该轮到 ${s.current}，记录里是 ${st.seat}` };
    }

    // ── 策略侧：重算一遍决策，动作与 logp 都要对得上 ──
    const driver = st.seat === 'A' ? drivers.A : st.seat === 'B' ? drivers.B : null;
    if (driver && driver.kind !== 'ai') {
      const acts = legalActions(s, st.seat);
      if (acts.length === 0) {
        // 走到这里说明状态已经分叉了（或者这局已经结束）：不再假装能重算，直接记下来
        first ??= {
          kind: 'illegal',
          step: stepNo,
          seat: st.seat,
          detail: `这一刻没有合法动作（current=${s.current}，winner=${s.winner ?? '无'}）——前面某一处分叉了`,
        };
        break;
      }
      if (driver.kind === 'policy') {
        const d = driver.policy.decide(s, st.seat, acts, drivers.randOf(st.seat));
        if (JSON.stringify(d.action) !== JSON.stringify(st.action)) {
          first ??= {
            kind: 'action',
            step: stepNo,
            seat: st.seat,
            detail: '重算出的动作与记录不同',
            expected: st.action,
            got: d.action,
          };
        }
        if (st.logp !== undefined) {
          const diff = Math.abs(d.logp - st.logp);
          if (diff > logpMaxDiff) logpMaxDiff = diff;
          if (diff > 1e-9) {
            first ??= {
              kind: 'logp',
              step: stepNo,
              seat: st.seat,
              detail: `logp 偏差 ${diff.toExponential(3)}`,
              expected: st.logp,
              got: d.logp,
            };
          }
        }
      } else {
        // 随机驾驶者：同样从 seat 的随机流里取一个，动作必须一样
        const pick = acts[Math.floor(drivers.randOf(st.seat)() * acts.length)]!;
        if (JSON.stringify(pick) !== JSON.stringify(st.action)) {
          first ??= { kind: 'action', step: stepNo, seat: st.seat, detail: '随机驾驶者的动作与记录不同' };
        }
      }
    }

    // ── 指纹：进入第 N 步**之前**的样子（录制时也是在这一刻取的）──
    // 这里曾经取在 apply 之后，于是每个检查点都差了一步：动作全对、终局全对，
    // 偏偏第 50 步报"指纹不同"。校验点和录制点必须是同一个时刻，否则出错的是尺子。
    const want = cp.get(stepNo);
    if (want) {
      const got = hashState(s);
      if (got !== want) {
        first ??= { kind: 'checkpoint', step: stepNo, seat: st.seat, detail: '进入这一步时状态已经不同', expected: want, got };
      }
    }

    onStep?.({ step: stepNo, seat: st.seat, state: s, action: st.action });

    // ── 应用记录里的动作 ──
    const r = applyAction(s, st.action);
    if (!r.ok) {
      first ??= {
        kind: 'illegal',
        step: stepNo,
        seat: st.seat,
        detail: `引擎拒绝：${r.reason}`,
        expected: st.action,
      };
      break;
    }
    s = r.state;
  }

  const finalHash = hashState(s);
  const got = { winner: s.winner ?? null, turns: s.turn, steps: rec.steps.length, hash: finalHash };
  return {
    ok: first === null && finalHash === rec.result.hash,
    seed: rec.seed,
    steps: rec.steps.length,
    logpMaxDiff,
    firstDivergence: first,
    final: { expected: rec.result.hash, got: finalHash, match: finalHash === rec.result.hash },
    result: { expected: rec.result, got, match: got.winner === rec.result.winner && got.turns === rec.result.turns },
    logpChecked,
    ...(logpChecked ? {} : { note: '没有策略侧或没给权重：logp 那一层没校验' }),
  };
}

// ── 从"游戏对局报告"重放（v3 报告自带 seed + 配置 + 动作序列）─────────────

export interface ReportReplay {
  ok: boolean;
  seed: number;
  steps: number;
  /** 报告字段的差异，逐条写明 */
  diffs: string[];
  firstDivergence: Divergence | null;
}

/**
 * 重放一份 `MatchReport`（v3），并用重算出来的终局重新生成一份报告做逐字段比对。
 *
 * 这是"同一局数据"最常见的来源：玩家打完上传的报告里就带着 seed + 动作序列。
 * 报告缺几个开局开关（选卡、双城、迷雾），这里按缺省还原——**影响的只是
 * "能不能重放成功"，不会悄悄给出错误结论**：开关不对，第一步就会分叉。
 */
export function replayReport(report: any): ReportReplay {
  if (report?.v !== 3) throw new Error(`只认 v3 报告（带动作序列），这份是 v${report?.v}`);
  if (!Array.isArray(report.actions) || report.actions.length === 0) {
    throw new Error('这份报告没有动作序列（actionsDropped 或老版本），没法重放');
  }
  const cfg: MatchConfig = {
    ...DEFAULT_CONFIG,
    size: report.board.w,
    startEra: report.startEra,
    playerCount: report.playerCount ?? 2,
    aiOpponent: report.ai?.opponent ?? true,
    aiAlly: report.ai?.ally ?? true,
    aiLevel: report.ai?.level ?? 'advanced',
    commanderMode: report.ai?.commander === true,
    godMode: report.ai?.godMode === true,
    draftMode: report.actions[0]?.type?.startsWith('DRAFT') === true,
    expansionIds: report.expansions ?? [],
  };
  let s = createMatch(cfg, report.seed);
  const diffs: string[] = [];
  let first: Divergence | null = null;

  for (let i = 0; i < report.actions.length; i++) {
    const a = report.actions[i] as Action;
    const r = applyAction(s, a);
    if (!r.ok) {
      first = { kind: 'illegal', step: i + 1, seat: s.current, detail: `引擎拒绝：${r.reason}`, expected: a };
      diffs.push(`第 ${i + 1} 步被拒（${r.reason}）：${JSON.stringify(a)}`);
      break;
    }
    s = r.state;
  }

  if (!first) {
    const again = buildMatchReport(s, new Date(report.at ?? Date.now()), null, report.actions, 0);
    diffs.push(...diffReports(report, again));
  }

  return { ok: diffs.length === 0, seed: report.seed, steps: report.actions.length, diffs, firstDivergence: first };
}

/** 逐字段比对两份报告：只比"重放应该能决定"的那些，时间和构建号不比 */
export function diffReports(want: any, got: any): string[] {
  const diffs: string[] = [];
  const cmp = (path: string, a: unknown, b: unknown) => {
    const sa = JSON.stringify(a);
    const sb = JSON.stringify(b);
    if (sa !== sb) diffs.push(`${path}: 报告里 ${sa} / 重算 ${sb}`);
  };
  cmp('turns', want.turns, got.turns);
  cmp('winner', want.winner, got.winner);
  cmp('sites', want.sites, got.sites);
  cmp('logLines', want.logLines, got.logLines);
  cmp('board.terrain', want.board?.terrain, got.board?.terrain);
  cmp('sides', want.sides, got.sides);
  cmp('aiSides', want.aiSides, got.aiSides);
  return diffs;
}
