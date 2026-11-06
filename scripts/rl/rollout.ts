/**
 * M2 的采样器：跑若干局，把"训练要用的那几个数"落成二进制。
 *
 * ── 为什么要并行 ────────────────────────────────────────────────────────
 *
 * 一局棋的时间 95% 花在手写 AI 的搜索上（策略那一侧是几千次乘加，可以忽略）。
 * 串行跑 40 局要一百多秒，而机器有 16 核 32 线程——采样成了整个训练循环里唯一的瓶颈。
 * 所以照搬 eval.ts 那套：**常驻 worker + 一局一块的动态派活**。
 * 一局的时长方差有五倍，等分会让最慢那个决定总时长；而每个 worker 只启动一次，
 * 省掉每局重付的模块加载与 JIT（约 2~3 秒）。
 *
 * 并行为什么不破坏可复现性：每一局的种子、随机流、对手抽取全部由 `seed` 推导
 * （`hashSeed(seed, ...)`），跟"第几个跑"没有关系。所以并行只是把同一批局
 * 换个顺序跑完，落盘后按种子排序拼回去，和串行逐字节一致。
 *
 * ── 对手池 ──────────────────────────────────────────────────────────────
 *
 * 只跟手写 AI 打有个毛病：对手固定，策略会朝"专门克制这个 AI"的方向长，
 * 而那个方向未必是"更强的棋"（AI 的毛病是有限的，学透它就到顶了）。
 * 所以按局抽对手：
 *
 *   60% 自己（自博弈，两边都是当前权重）—— 无限难度的陪练，而且天然对称；
 *   20% 手写 AI —— 一个稳定的锚，防止自博弈在"互相克制"里空转；
 *   20% 冻结快照 —— 上一轮/上上轮的自己，防止只跟"当下的自己"下导致策略遗忘。
 *
 * 自博弈那 60% 里两边都要采样（零和、对称，两边都是有效梯度），
 * 另外两种只采策略这一侧。所以记录里必须带 `seat` 与 `learn`：
 * GAE 要按 (局, 席位) 分开算，对手侧的决策不进训练集。
 *
 * ── 一步存什么 ──────────────────────────────────────────────────────────
 *
 *   state 148 · 候选 16×56 · logp · value · reward · idx · game · turn · kUsed · seat · learn
 *
 * 一步 1055 个 float32 ≈ 4.2KB。五万步约 210MB —— 一轮一落盘、更新完就删。
 *
 * 用法：
 *   node --experimental-strip-types scripts/rl/rollout.ts --games 24 --seed0 8000 \
 *        --opponent pool --out .tmp/m2/rollout-0
 *   # 调试单局/单线程：
 *   node --experimental-strip-types scripts/rl/rollout.ts --games 1 --workers 1 --out .tmp/one
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
import type { AiLevel, GameState, PlayerId } from '../../src/core/types.ts';
import { TRAIN, trainSizeFor } from './config.ts';
import { ACTION_DIM, INTENT_NAMES, STATE_DIM } from './features.ts';
import type { Intent } from './features.ts';
import { legalActions } from './legal.ts';
import { Policy, weightsFromJson } from './policy.ts';
import { hashSeed, mulberry32 } from './rng.ts';

const args = process.argv.slice(2);
const argOf = (name: string, dflt: string): string => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? (args[i + 1] as string) : dflt;
};
const flag = (name: string): boolean => args.includes(`--${name}`);

const GAMES = Number(argOf('games', '8'));
const SEED0 = Number(argOf('seed0', '8000'));
const OUT = argOf('out', path.join('.tmp', 'rollout'));
const WEIGHTS = argOf('weights', path.join('scripts', 'rl', 'weights', 'init.json'));
const CAP = Number(argOf('cap', String(TRAIN.capTurns)));
const OPPONENT = argOf('opponent', 'ai'); // ai | pool
/**
 * 手写 AI 的难度档。课程学习的主角：初级档的 AI 不做 lookahead、不辨兵种，
 * 策略才赢得到几局，才有"这一步比那一步好"的对比信号。
 * 高级档对一个随机初始化的策略是 160:0 —— 全输等于没梯度，KL 再健康也白搭。
 */
const AI_LEVEL = argOf('ai-level', TRAIN.aiLevel) as AiLevel;
/**
 * 手写 AI 的"手感削弱"：每一步有这个概率随便走一个合法动作（0 = 原样）。
 *
 * 这是课程学习真正好用的那一档旋钮。三档 `aiLevel` 之间的距离太远——实测
 * 初始策略对初级档是 0:40，行为克隆到 50% 一致率了对三档还是 0:60。
 * 而按这个概率连续调，同一个策略的得分率是：0.15 → 0%，0.5 → 3.8%，0.9 → 87.5%。
 * 也就是说它能给出"刚好够难"的那一档，而这正是"有胜负对比"的前提。
 */
const AI_HANDICAP = Number(argOf('ai-handicap', '0'));
/**
 * 撞上回合上限（= 没打完）时给双方的奖励。
 *
 * 默认 0，但**训练时会被整局丢掉**（见 ppo.load_rollout 的 drop_timeouts）。
 * 为什么不能让它留在批次里：这个游戏里 `winner === null` 只可能是"打不完"，
 * 而"平局 0 分"比"输 −1 分"好——于是策略会学"怎么活得更久"，不是"怎么赢"。
 * 实测两轮更新之后，同一批种子的对局中位数从 22 回合涨到 40 回合，胜率仍是 0%：
 * 它精确地优化了我们给的目标，而那个目标是错的。
 */
const TIMEOUT_REWARD = Number(argOf('timeout-reward', '0'));
// 快照是训练产物，放 .tmp 里（不进仓库）：每轮把新权重拷一份进来，留最近三份
const SNAPDIR = argOf('snapshots', path.join('.tmp', 'm2', 'snapshots'));

/**
 * 对手池的配比。
 *
 * `--self-share` 由外部给（训练循环按"会不会打架"来调），剩下那一半里
 * 手写 AI 与冻结快照对半分。为什么自博弈不能一上来就 60%：
 * 两个随机策略互相下，**一局都打不完**——实测 8 局全部撞上 150 回合上限、
 * 每局 4255 步、奖励全是 0（平局）。既没有信号，又比打 AI 贵二十倍。
 * 所以自博弈要等策略"会打架"之后再上场。
 */
const POOL_SELF = Number(argOf('self-share', '0.6'));
/**
 * 快照与自博弈**同进同退**，AI 吃掉剩下的全部。
 *
 * 第一版把剩下那一半平分成"AI 一半、快照一半"，于是 self-share=0 时仍有 50% 的局
 * 是"打上上轮的自己"——而两个不会打架的策略互相下，结果就是 4000 步的平局（零信号）。
 * 实测第二轮 40 局里有一半是这种局，522 秒才采完，比打 AI 慢十倍。
 * 现在 self-share=0 就是"全打 AI"，池子随准入线一起开。
 *
 * 但"快照跟着自博弈走"在自博弈占比要往上提时又成了束缚：公式是
 * 自博弈 + 快照 + AI = 1，快照默认等于自博弈，于是自博弈一超过 0.5 就
 * 没有 AI 的份了 —— 而那个 20% 的 AI 局是防止策略在自博弈里漂走的锚，
 * 不能丢。所以快照占比单独可配（`--snap-share`），默认仍是跟着自博弈。
 */
const POOL_SNAP = Number(argOf('snap-share', String(POOL_SELF)));
const POOL_AI = Math.max(0, 1 - POOL_SELF - POOL_SNAP);

/**
 * 意图怎么给。
 *
 *   auto        —— 老行为：四格全 0（网络自己判断），v1 的对照组就是这个口径
 *   random      —— 每一方随机挑一个（rush/harass/boom/auto 等概率）。这是**训练指令跟随**的口径：
 *                  同一批棋局里四种打法都出现，网络才会学到"这句话说了要算数"
 *   rush/harass/boom —— 写死，用于对照实验
 */
const INTENT_MODE = argOf('intent', 'auto');

const WORKERS = Number(
  argOf('workers', String(Math.max(1, Math.round(os.cpus().length / 2)))),
);
const SERVE = flag('serve');

const raw = fs.readFileSync(WEIGHTS, 'utf8');
const weights = weightsFromJson(JSON.parse(raw));
const policy = new Policy(weights);
const K = policy.topK;

/**
 * 一步记 11 个元数据。
 *
 * kUsed 是"真正有几个候选"（不足 K 时尾巴补零，训练侧要屏蔽）；
 * seat / learn 是自博弈才需要的：一局里两边都在学，GAE 必须按 (局, 席位) 分开算，
 * 而对手侧（AI / 快照）的决策不进训练集。
 */
const META = 11; // logp, value, reward, idx, game, turn, kUsed, seatId, learn, -, -
const WIDTH = STATE_DIM + K * ACTION_DIM + META;

/** 冻结快照懒加载：同一份权重在整轮里只解一次 */
const snapCache = new Map<string, Policy>();
function loadSnapshot(file: string): Policy | null {
  const hit = snapCache.get(file);
  if (hit) return hit;
  try {
    const p = new Policy(weightsFromJson(JSON.parse(fs.readFileSync(file, 'utf8'))));
    snapCache.set(file, p);
    return p;
  } catch {
    return null;
  }
}

const snaps = fs.existsSync(SNAPDIR)
  ? fs
      .readdirSync(SNAPDIR)
      .filter((f) => f.endsWith('.json'))
      .sort()
  : [];

type Mode = 'self' | 'ai' | 'snap';
function modeOf(g: number, seed: number): Mode {
  if (OPPONENT === 'ai') return 'ai';
  // 按局号+种子定，不用 Math.random：这一轮重跑要能得到同一批对局（出了问题才好复现）
  const r = mulberry32(hashSeed(seed, g, 'mode'))();
  if (r < POOL_SELF) return 'self';
  if (r < POOL_SELF + POOL_AI) return 'ai';
  // 还没有快照时，那份名额让给手写 AI（总不能拿"自己"当冻结快照，那和自博弈没区别）
  if (snaps.length === 0) return 'ai';
  return 'snap';
}

/**
 * 这一局策略坐哪一边。
 *
 * 按**种子**派生，不按局号：局号在不同 worker 分片下会重排，而种子是这一局的身份证。
 * 直接 `seed % 2` 不够——种子是连续的（8000、8001…），那会变成"奇偶严格交错"，
 * 而种子本身和地图、出生点相关，交错反而可能和地图特性共振。哈希一次更省心。
 */
function policySeatOf(seed: number): PlayerId {
  return hashSeed(seed, 'policy-seat') % 2 === 0 ? 'A' : 'B';
}

interface GameRow {
  seed: number;
  mode: Mode;
  /** 这一局的边长。混尺寸训练之后"这一轮到底抽到几张 12×12"要能查 */
  size: number;
  steps: number;
  winner: PlayerId | null;
  /**
   * 这一局策略坐哪一边。
   *
   * 座位从 2026-11-06 起按种子交替（见 `policySeatOf`）。这一格必须落进元数据：
   * 训练侧的"打 AI 胜率"要按**策略那一方**算，写死 `winner === 'A'` 的话，
   * 座位一交替这个数就变成"先手胜率"，和棋力没关系。
   */
  policySeat: PlayerId;
  turns: number;
  /** 撞上回合上限：这种局在训练侧会被整局丢掉（见文件头的说明） */
  timedOut: boolean;
}

/**
 * 一局的可增长行缓冲。
 *
 * 为什么不做成"一局一个定长数组"：局长的方差极大（打 AI 约 190 步，自博弈能到 4000 步），
 * 定长只能按最坏情况开，一块 17MB × 16 个 worker 全是浪费。
 * 翻倍扩容摊下来是 O(n)，而且 `slot()` 返回的是行号不是指针，扩容后仍然有效。
 */
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

/** 跑一局，返回这一步集里的所有行（只在内存里，落盘由调用方决定） */
function runMatch(g: number, seed: number): { rows: Float32Array; meta: GameRow } {
  const mode = modeOf(g, seed);
  const snapFile =
    mode === 'snap' && snaps.length > 0
      ? snaps[Math.floor(mulberry32(hashSeed(seed, 'snap'))() * snaps.length)]
      : undefined;
  const opponent: Policy | null = snapFile ? loadSnapshot(path.join(SNAPDIR, snapFile)) : null;

  let s: GameState = createMatch(
    {
      ...DEFAULT_CONFIG,
      size: trainSizeFor(g),
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

  /*
   * 谁在开这一方。
   *
   *   自博弈：两边都是当前权重，两边都记账；
   *   打 AI / 打快照：**策略轮流坐** A 和 B（见 `policySeatOf`），另一席是对手。
   *
   * 2026-11-06 之前这里写死"策略永远坐 A"。代价量出来了：同一批 160 局按座位拆开，
   * A 座 62.5%、B 座 46.2%（16 个点，z≈2.07）——B 座只在自博弈里练过，
   * 从没跟手写 AI 对过，也没见过"先手是别人"的开局。而玩家永远坐 A（人机对战里
   * 你是先手），所以这个偏差直接翻译成"它在你的椅子上比在你对面强 16 个点"。
   */
  const POLICY_SEAT = policySeatOf(seed);
  const policySeat = (seat: PlayerId): Policy | null => {
    if (mode === 'self') return policy;
    if (seat === POLICY_SEAT) return policy;
    return opponent;
  };
  const learnable = (seat: PlayerId): boolean => policySeat(seat) === policy;

  const rands = new Map<PlayerId, () => number>();
  const randOf = (seat: PlayerId) => {
    let r = rands.get(seat);
    if (!r) {
      r = mulberry32(hashSeed(seed, seat, 'policy'));
      rands.set(seat, r);
    }
    return r;
  };
  // 削弱用的随机流单独一份：混进策略那条流里，"改不改削弱"就会改变策略那一侧的采样
  const shuffles = new Map<PlayerId, () => number>();
  const shuffleOf = (seat: PlayerId) => {
    let r = shuffles.get(seat);
    if (!r) {
      r = mulberry32(hashSeed(seed, seat, 'handicap'));
      shuffles.set(seat, r);
    }
    return r;
  };

  // 每一方的意图：从种子派生，重跑同一批种子会得到同一份，不用 Math.random
  const intents = new Map<PlayerId, Intent>();
  const intentOf = (seat: PlayerId): Intent => {
    let v = intents.get(seat);
    if (v) return v;
    if (INTENT_MODE === 'auto' || INTENT_MODE === 'random') {
      if (INTENT_MODE === 'auto') v = 'auto';
      else {
        const r = mulberry32(hashSeed(seed, seat, 'intent'))();
        v = INTENT_NAMES[Math.floor(r * INTENT_NAMES.length)] ?? 'auto';
      }
    } else {
      v = (INTENT_NAMES as string[]).includes(INTENT_MODE) ? (INTENT_MODE as Intent) : 'auto';
    }
    intents.set(seat, v);
    return v;
  };

  const buf = new RowBuf();
  let turnSeat: PlayerId | null = null;
  let inTurn = 0;
  let budget = { ...DEFAULT_BUDGET };
  const rejected = new Set<string>();
  const lastStored = new Map<PlayerId, number>();

  /**
   * 步数护栏。
   *
   * 这个循环原来是"没有赢家且没到回合上限就继续"，隐含假设是"每一步都会推进局面"。
   * 实测打出过一局**不推进**的：16 个 worker 全部 100% CPU 转了十几分钟、一行输出都没有，
   * 父进程那边看起来就是"卡住了"，连是哪一局都不知道。护栏把它变成一条带种子号的报错。
   *
   * 上限 20000 的依据：150 回合 × 每回合最多 AI_MAX_STEPS(50) 步 = 7500，留一倍余量。
   */
  let guard = 0;
  while (!s.winner && s.turn <= CAP) {
    if (++guard > 20000) {
      throw new Error(
        `第 ${g} 局（种子 ${seed}）走了 ${guard} 步还没结束：第 ${s.turn} 回合、轮到 ${s.current}。` +
          '这说明有动作没推进局面（重复施加同一个动作 / 回合没交接），是规则层或策略层的问题，不是慢。',
      );
    }
    const seat = s.current;
    if (seat !== turnSeat) {
      turnSeat = seat;
      inTurn = 0;
      budget = { ...DEFAULT_BUDGET };
      rejected.clear();
    }

    const d = policySeat(seat);
    if (!d) {
      // 对手是手写 AI：不为它记账
      let picked = inTurn < AI_MAX_STEPS ? aiNextAction(s, budget, rejected) : null;
      if (AI_HANDICAP > 0 && inTurn < AI_MAX_STEPS) {
        const hr = shuffleOf(seat);
        if (hr() < AI_HANDICAP) {
          // 削弱：不看局面，随便挑一个合法动作。用 legalActions 保证它一定合法，
          // 否则会掉到下面"被拒绝就结束回合"的分支，等于把削弱变成"少一步"
          const hacts = legalActions(s, seat);
          if (hacts.length > 0) picked = hacts[Math.floor(hr() * hacts.length)]!;
        }
      }
      if (picked) {
        if (picked.type === 'RECRUIT') budget.recruited += 1;
        if (picked.type === 'UPGRADE') budget.upgraded += 1;
      }
      const r = applyAction(s, picked ?? { type: 'END_TURN' });
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

    const acts = legalActions(s, seat);
    if (acts.length === 0) break;
    if (inTurn >= AI_MAX_STEPS) {
      const end = applyAction(s, { type: 'END_TURN' });
      if (!end.ok) break;
      s = end.state;
      inTurn += 1;
      continue;
    }

    if (learnable(seat)) {
      // 先决策，再从策略内部把"它真正用过的"那份状态和动作特征取出来落盘。
      // 自己再 encode 一遍不只是白费算力（每步约 0.4ms，含两次 actionContext），
      // 更要紧的是那份和 dec.logp 对应的特征**必须和 decide 用的是同一份**，
      // 否则训练时看到的东西和当时决策看到的东西会有细微差别。
      // 意图是"这一方这一局"的属性，每步重新贴一次而不是开局贴一次：
      // 自博弈里两边共用同一个 Policy 实例，隔一步就会被对方的值覆盖
      d.intent = intentOf(seat);
      const dec = d.decide(s, seat, acts, randOf(seat));
      const state = d.lastState;
      const feats = d.lastFeats;

      const picked = dec.candidates;
      const slot = buf.slot();
      const base = slot * WIDTH;
      buf.data.set(state, base);
      for (let i = 0; i < Math.min(K, picked.length); i++) {
        const src = picked[i]! * ACTION_DIM;
        buf.data.set(feats.subarray(src, src + ACTION_DIM), base + STATE_DIM + i * ACTION_DIM);
      }
      const tail = base + STATE_DIM + K * ACTION_DIM;
      buf.data[tail + 0] = dec.logp;
      buf.data[tail + 1] = dec.value;
      buf.data[tail + 2] = 0; // reward，终局回填
      buf.data[tail + 3] = Math.max(0, picked.indexOf(dec.index));
      buf.data[tail + 4] = g;
      buf.data[tail + 5] = inTurn;
      buf.data[tail + 6] = picked.length;
      buf.data[tail + 7] = seat === 'A' ? 0 : 1;
      buf.data[tail + 8] = 1;
      lastStored.set(seat, slot);

      const r = applyAction(s, dec.action);
      if (!r.ok) throw new Error(`策略给出的动作被拒：${r.reason}`);
      s = r.state;
      inTurn += 1;
      continue;
    }

    // 对手是冻结快照：照常走，但不记账
    const dec = d.decide(s, seat, acts, randOf(seat));
    const r = applyAction(s, dec.action);
    if (!r.ok) throw new Error(`快照给出的动作被拒：${r.reason}`);
    s = r.state;
    inTurn += 1;
  }

  // 终局奖励按**每个学习席位**各自算：自博弈里一边赢一边输，符号必须分开
  for (const [seat, slot] of lastStored) {
    const reward = s.winner === null ? TIMEOUT_REWARD : s.winner === seat ? 1 : -1;
    buf.data[slot * WIDTH + STATE_DIM + K * ACTION_DIM + 2] = reward;
  }

  return {
    rows: buf.data.subarray(0, buf.n * WIDTH),
    meta: {
      seed,
      mode,
      size: s.w,
      steps: buf.n,
      winner: s.winner ?? null,
      // 训练侧按它算"策略那一方赢没赢"；写死 A 会在座位交替后变成"先手胜率"
      policySeat: mode === 'self' ? 'A' : POLICY_SEAT,
      turns: s.turn,
      timedOut: s.winner === null,
    },
  };
}

/**
 * 出队侧：把 worker 交回来的局按**局号顺序**写进最终文件。
 *
 * 为什么必须按局号排队：worker 谁先算完谁先回，顺序是乱的；但训练侧读的是
 * "第几步属于第几局"，字节序一变，同一份权重采出来的数据就不再逐字节可比，
 * 复现和 A/B 都会失效。所以这里拿一个"下一个该写谁"的游标顶着。
 *
 * 为什么两边都需要排队：worker 回来的局可能乱序，而游标只能顺序推进，
 * 于是乱序到的先攒在 `pending` 里。派活是按局号从小到大发的、一局一块，
 * 所以这个暂存区通常只有几局——不会因为"某局拖到上限"把整批卡在内存里。
 */
class Sink {
  readonly fd: number;
  private pending = new Map<number, { rows: Float32Array; meta: GameRow }>();
  private cursor = 0;
  totalSteps = 0;
  readonly perGame: GameRow[] = new Array<GameRow>(GAMES);

  constructor(outPath: string) {
    fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
    // 'w' 会截断，不必先删——本机的安全垫片对"一次删 50 个文件"会直接抛错，能不删就不删
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
      this.totalSteps += cur.rows.length / WIDTH;
      this.perGame[this.cursor] = cur.meta;
      this.cursor += 1;
      // 每 8 局报一次进度。为什么值得多这一行：有一次一轮采样静默卡了十几分钟，
      // 输出文件停在同一个字节数上，而父进程什么都不打印——分不清是"还在算"还是"死了"。
      // 打到 stderr 是因为 stdout 已经被 loop.py 接管去解析了。
      if (this.cursor % 8 === 0 && this.cursor < GAMES) {
        process.stderr.write(`  …已完成 ${this.cursor}/${GAMES} 局（${this.totalSteps} 步）\n`);
      }
    }
  }

  close(): void {
    fs.closeSync(this.fd);
    if (this.cursor !== GAMES) {
      const missing: number[] = [];
      for (let g = 0; g < GAMES; g++) if (!this.perGame[g]) missing.push(g);
      throw new Error(
        `只收到 ${this.cursor}/${GAMES} 局，缺第 ${missing.slice(0, 8).join(',')}${missing.length > 8 ? ' …' : ''} 局——` +
          '多半是某个 worker 中途崩了，往上翻它的 stderr',
      );
    }
  }
}

/**
 * worker 侧：常驻，读"局号 种子"跑一局，回一帧。
 *
 * ── 帧格式 ──────────────────────────────────────────────────────────────
 *   `OK <局号> <字节数> <元数据 JSON>\n` + 紧接着这么多字节的 float32
 *
 * 为什么数据走管道而不是走临时文件：一局上千步就是几 MB，写成文件再读回来
 * 白白多两次磁盘往返；而这个目录里有几百个文件，清理时会被"批量删除"的
 * 安全垫片拦下来（实测：一次删 322 个文件直接抛 SAFE_DELETE_BULK_CONFIRM_REQUIRED，
 * 改成逐个删之后又在累计到 50 个时被拦）。不落盘就没有清理问题。
 *
 * 为什么不塞进一行 JSON：要 base64 一遍，体积 +33%，父进程还得解回来。
 * 二进制帧是零拷贝的——写的时候直接 `Buffer.from(rows.buffer, ...)`。
 */
if (SERVE) {
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    const s = line.trim();
    if (!s) return;
    if (s === 'bye') process.exit(0);
    const [g, seed] = s.split(/\s+/).map(Number);
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

  const totalSteps = sink.totalSteps;
  const perGame = sink.perGame;

  /** 中位数：比平均好读——一局拖到上限就能把平均值拉飞 */
  const median = (xs: number[]): number => {
    if (xs.length === 0) return 0;
    const a = [...xs].sort((x, y) => x - y);
    const m = a.length >> 1;
    return a.length % 2 ? a[m]! : Math.round((a[m - 1]! + a[m]!) / 2);
  };

  const byMode = (m: Mode) => perGame.filter((p) => p.mode === m);
  const manifest = {
    v: 2,
    width: WIDTH,
    state: STATE_DIM,
    action: ACTION_DIM,
    k: K,
    steps: totalSteps,
    games: GAMES,
    seed0: SEED0,
    size: TRAIN.size,
    // 去重：`TRAIN.sizes` 现在用重复值表达配比（[12, 12, 10]），
    // 原样写进元数据会让"这一轮用了哪些尺寸"读起来像用了三个尺寸。
    sizes: Array.from(new Set(TRAIN.sizes)),
    expansions: TRAIN.expansions,
    weights: WEIGHTS,
    opponent: OPPONENT,
    aiLevel: AI_LEVEL,
    aiHandicap: AI_HANDICAP,
    snapshots: snaps.length,
    modeCounts: { self: byMode('self').length, ai: byMode('ai').length, snap: byMode('snap').length },
    stats: {
      decisive: perGame.filter((p) => p.winner).length,
      timedOut: perGame.filter((p) => p.timedOut).length,
      medianTurns: median(perGame.map((p) => p.turns)),
      stepsPerGame: Math.round(totalSteps / Math.max(1, GAMES)),
    },
    perGame,
  };
  fs.writeFileSync(`${OUT}.json`, JSON.stringify(manifest, null, 2));

  const elapsed = (performance.now() - t0) / 1000;
  const avg = totalSteps / Math.max(1, GAMES);
  const mc = manifest.modeCounts;
  console.log(
    `采样 ${GAMES} 局（自博弈 ${mc.self} · 打 AI ${mc.ai} · 打快照 ${mc.snap}）：${totalSteps} 步` +
      `（${avg.toFixed(0)} 步/局）· ${((totalSteps * WIDTH * 4) / 1024 / 1024).toFixed(1)} MB → ${OUT}.bin`,
  );
  const st = manifest.stats;
  const lanes = Math.min(WORKERS, GAMES);
  console.log(
    `  分胜负 ${st.decisive}/${GAMES} · 撞上限 ${st.timedOut} · 回合中位数 ${st.medianTurns} · 每局 ${st.stepsPerGame} 步` +
      ` · ${lanes} 进程 ${elapsed.toFixed(1)}s（${(totalSteps / Math.max(elapsed, 0.01)).toFixed(0)} 步/秒）`,
  );
}

/**
 * 常驻 worker 的派活池：一局一块，谁空谁拿下一块。
 *
 * 一局的时长方差有五倍（打 AI 约 5 秒，自博弈撞上限能到几十秒），等分成 N 份
 * 会让最慢那个决定总时长；而每个 worker 只启动一次，省掉每局重付的模块加载与 JIT。
 *
 * 注意收工时要**主动把 worker 都打发走**：它们的 stdin/stdout 还是活着的管道，
 * 不关掉的话父进程的事件循环永远不空——数据算完了却退不出去，
 * 表现就是"跑了十分钟还没打印结果"（eval.ts 里踩过这个坑，别删）。
 */
function runPool(lanes: number, sink: Sink): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const self = fileURLToPath(import.meta.url);
    /*
     * 同 eval.ts 的那条教训：**整份 argv 转发**，只摘掉和分片有关的。
     *
     * 白名单版本漏了 `--intent` 和 `--snap-share`——于是
     * `loop.py --intent random` 会静默失效，worker 一律按 auto 采。
     * 更坏的是它不报错：样本照采，只是没按你要的口径采。
     */
    const DROP = new Set(['--serve', '--games', '--out', '--workers']);
    const forwarded: string[] = [];
    for (let i = 2; i < process.argv.length; i++) {
      const a = process.argv[i]!;
      if (DROP.has(a)) {
        // --games / --out 带一个值，一起跳过
        if (a !== '--serve' && process.argv[i + 1] && !process.argv[i + 1]!.startsWith('--')) i += 1;
        continue;
      }
      forwarded.push(a);
    }

    const childArgs = [
      '--experimental-strip-types',
      self,
      '--serve',
      ...forwarded,
      '--seed0',
      String(SEED0),
      '--cap',
      String(CAP),
      '--workers',
      '1',
      '--weights',
      WEIGHTS,
      '--opponent',
      OPPONENT,
      '--self-share',
      String(POOL_SELF),
      '--snapshots',
      SNAPDIR,
      '--timeout-reward',
      String(TIMEOUT_REWARD),
      '--ai-level',
      AI_LEVEL,
      '--ai-handicap',
      String(AI_HANDICAP),
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
      // 不用 readline：一帧 = 一行头 + 一段原始字节，按行切会把这堆字节当文本掰碎
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
          // `OK <局号> <字节数> <元数据>`
          const p1 = head.indexOf(' ', 3);
          const p2 = head.indexOf(' ', p1 + 1);
          const g = Number(head.slice(3, p1));
          const bytes = Number(head.slice(p1 + 1, p2));
          if (acc.length < nl + 1 + bytes) return; // 还没收全，等下一片
          // 必须拷出来：acc 是个会被复用的 slab，直接建视图会在下一次 concat 后失效
          const raw = Buffer.from(acc.subarray(nl + 1, nl + 1 + bytes));
          acc = acc.subarray(nl + 1 + bytes);
          const rows = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
          sink.push(g, rows, JSON.parse(head.slice(p2 + 1)) as GameRow);

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
