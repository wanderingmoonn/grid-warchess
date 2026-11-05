/**
 * 策略网络：**两段式动作打分**（TS 侧推理）。
 *
 * ── 为什么是两段而不是"每个动作过一次 MLP" ──────────────────────────────
 *
 * 一步棋平均 36 个合法动作、多的时候两三百。一次 204→64→1 的 MLP 在 TS 里约 11µs，
 * 300 个动作就是 3.3ms/步——比引擎（0.74ms）慢四倍多，训练直接废掉。
 *
 * 所以拆成：
 *   ① **线性预筛**：score = w·[state ⊕ action]，204 维点积 ≈ 0.15µs/动作，
 *      300 个 ≈ 0.05ms，取前 16 名；
 *   ② **小 MLP 重排**：只对这 16 个过 (204→64→1)，16×13k ≈ 0.2ms。
 * 合计约 0.3ms/步，加编码 0.1ms，仍在 0.6ms 的预算里。
 *
 * 线性预筛会不会"表达力到顶"？真正的非线性在第二段；预筛只负责把明显不行的动作
 * 扔掉（和 AlphaStar 先按类型分头、再在头内比较是同一个思路）。代价是概率质量
 * 只落在 top-K 上——训练时必须用同一套 top-K 算 logp，否则 ratio 对不上。
 *
 * ── 权重为什么是 base64 ────────────────────────────────────────────────
 *
 * TS 推理、Python 训练，两边必须读到**逐位相同**的数。JSON 里的十进制小数
 * 会被打印精度悄悄改掉（第十位不同，几百轮后就是两条曲线）；
 * base64 的 float32 字节串是精确的，Python 那边 `np.frombuffer` 一行就还原。
 */
import { ACTION_DIM, STATE_DIM, actionContext, encodeActions, encodeState } from './features.ts';
import type { ActionContext } from './features.ts';
import { gauss, mulberry32 } from './rng.ts';
import type { Action, GameState, PlayerId } from '../../src/core/types.ts';

/** 权重文件的版本：结构一改就 +1，加载时对不上直接报错，不做兼容 */
export const WEIGHTS_VERSION = 1;

export interface NetSpec {
  state: number;
  action: number;
  joint: number;
  hidden: number;
  topK: number;
}

export interface Weights {
  version: number;
  spec: NetSpec;
  /** 线性预筛：w 长度 = joint，b 标量 */
  prescreen: { w: Float32Array; b: number };
  /** 重排小网络：204→hidden→1 */
  scorer: { w1: Float32Array; b1: Float32Array; w2: Float32Array; b2: number };
  /** 价值头：state→hidden→1，输出过 tanh */
  value: { w1: Float32Array; b1: Float32Array; w2: Float32Array; b2: number };
}

export const DEFAULT_SPEC: NetSpec = {
  state: STATE_DIM,
  action: ACTION_DIM,
  joint: STATE_DIM + ACTION_DIM,
  hidden: 64,
  topK: 16,
};

// ── base64 ⇄ Float32Array ──────────────────────────────────────────────

function toB64(a: Float32Array): string {
  const bytes = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  return Buffer.from(bytes).toString('base64');
}

function fromB64(s: string, expect?: number): Float32Array {
  const buf = Buffer.from(s, 'base64');
  // 拷贝一次：Buffer 的底层 ArrayBuffer 可能比它本身大，直接 subarray 会读出垃圾
  const copy = new Uint8Array(buf.byteLength);
  copy.set(buf);
  const out = new Float32Array(copy.buffer, 0, copy.byteLength / 4);
  if (expect !== undefined && out.length !== expect) {
    throw new Error(`权重长度不对：${out.length}，应为 ${expect}`);
  }
  return out;
}

/** 序列化成可存盘的 JSON（数组全是 base64 字符串） */
export function weightsToJson(w: Weights): unknown {
  return {
    version: w.version,
    spec: w.spec,
    prescreen: { w: toB64(w.prescreen.w), b: w.prescreen.b },
    scorer: { w1: toB64(w.scorer.w1), b1: toB64(w.scorer.b1), w2: toB64(w.scorer.w2), b2: w.scorer.b2 },
    value: { w1: toB64(w.value.w1), b1: toB64(w.value.b1), w2: toB64(w.value.w2), b2: w.value.b2 },
  };
}

export function weightsFromJson(raw: any): Weights {
  if (!raw || raw.version !== WEIGHTS_VERSION) {
    throw new Error(`权重版本不对：${raw?.version}，本代码只认 ${WEIGHTS_VERSION}`);
  }
  const spec = raw.spec as NetSpec;
  if (spec.joint !== spec.state + spec.action) throw new Error('权重里的维度自相矛盾');
  return {
    version: spec && raw.version,
    spec,
    prescreen: { w: fromB64(raw.prescreen.w, spec.joint), b: Number(raw.prescreen.b) },
    scorer: {
      w1: fromB64(raw.scorer.w1, spec.joint * spec.hidden),
      b1: fromB64(raw.scorer.b1, spec.hidden),
      w2: fromB64(raw.scorer.w2, spec.hidden),
      b2: Number(raw.scorer.b2),
    },
    value: {
      w1: fromB64(raw.value.w1, spec.state * spec.hidden),
      b1: fromB64(raw.value.b1, spec.hidden),
      w2: fromB64(raw.value.w2, spec.hidden),
      b2: Number(raw.value.b2),
    },
  };
}

/**
 * 随机初始化（Xavier 均匀）。
 *
 * 为什么 TS 也要能给初始权重：M1 要能在**没有 PyTorch 参与**的情况下把整条链路跑通
 * （编码→打分→采样→对局→评估）。Python 那边训练时是从这个文件接着走的，
 * 所以"谁初始化"不重要，"同一个文件"才重要。
 *
 * 输出层故意压小（0.01 倍）：否则随机权重会给动作打分带来很大的方差，
 * 一开始就采到一堆极端的动作，连一局都走不完。
 */
export function randomWeights(seed = 1, spec: NetSpec = DEFAULT_SPEC): Weights {
  const rand = mulberry32(seed);
  const xavier = (fanIn: number, fanOut: number): Float32Array => {
    const limit = Math.sqrt(6 / (fanIn + fanOut));
    const a = new Float32Array(fanIn * fanOut);
    for (let i = 0; i < a.length; i++) a[i] = gauss(rand) * limit * 0.5;
    return a;
  };
  const small = (n: number): Float32Array => {
    const a = new Float32Array(n);
    for (let i = 0; i < n; i++) a[i] = gauss(rand) * 0.01;
    return a;
  };
  return {
    version: WEIGHTS_VERSION,
    spec,
    prescreen: { w: small(spec.joint), b: 0 },
    scorer: {
      w1: xavier(spec.joint, spec.hidden),
      b1: new Float32Array(spec.hidden),
      w2: small(spec.hidden),
      b2: 0,
    },
    value: {
      w1: xavier(spec.state, spec.hidden),
      b1: new Float32Array(spec.hidden),
      w2: small(spec.hidden),
      b2: 0,
    },
  };
}

/** 参数总量：判断"这个网络值不值得上 GPU"用 */
export function paramCount(w: Weights): number {
  const s = w.spec;
  return (
    s.joint + 1 +
    s.joint * s.hidden + s.hidden + s.hidden + 1 +
    s.state * s.hidden + s.hidden + s.hidden + 1
  );
}

// ── 前向 ────────────────────────────────────────────────────────────────

export interface Decision {
  /** 在传入的 actions 里的下标 */
  index: number;
  action: Action;
  /** log π(a|s)，PPO 的 ratio 要它 */
  logp: number;
  /** 价值估计，[-1,1] */
  value: number;
  /** 实际参与比较的动作数（= min(topK, 动作数)），诊断用 */
  considered: number;
  /**
   * 参与比较的那批候选动作下标（按分数降序）。
   *
   * 训练侧要它：PPO 更新时算 `π_new(a|s)` 必须在**同一批候选**上算，
   * 否则新旧两个分布的分母都不一样，ratio 就没意义了。
   */
  candidates: number[];
}

/**
 * 一个策略实例。
 *
 * 内部持有几块临时缓冲（state / 动作特征 / 候选下标 / 隐藏层），
 * 复用它们是为了避免每步分配几万个 float —— 那会让 GC 成为新的瓶颈。
 */
export class Policy {
  readonly weights: Weights;
  readonly spec: NetSpec;
  readonly topK: number;
  /** 采样温度：1 = 按概率采；<1 更贪心。评估时用 0.3 就能看出"最优解"是什么 */
  temperature: number;

  private stateBuf: Float32Array;
  private actionBuf: Float32Array;
  private scratch: Float32Array;
  private hidden: Float32Array;
  /** topK 候选下标（部分选择的输出） */
  private cand: Int32Array;
  private candN = 0;
  /** 预筛分数 / 重排后的 logits / 重排的隐藏层，都是逐帧复用的缓冲 */
  private scoreBuf: Float64Array;
  private logits: Float64Array;
  private hidden2: Float32Array;
  /** 动作上下文（单位索引、离家距离…）复用一份，避免每步新建五张 Map */
  private ctx: ActionContext | null = null;

  constructor(weights: Weights, opts: { topK?: number; temperature?: number } = {}) {
    this.weights = weights;
    this.spec = weights.spec;
    this.topK = Math.max(1, Math.min(opts.topK ?? this.spec.topK, 4096));
    this.temperature = opts.temperature ?? 1;
    this.stateBuf = new Float32Array(this.spec.state);
    this.actionBuf = new Float32Array(0);
    this.scratch = new Float32Array(this.spec.joint);
    this.hidden = new Float32Array(this.spec.hidden);
    this.cand = new Int32Array(this.topK);
    this.scoreBuf = new Float64Array(this.topK * 4);
    this.logits = new Float64Array(this.topK * 2);
    this.hidden2 = new Float32Array(this.spec.hidden);
  }

  /** 编码状态（可复用缓冲）。调用方要留着做训练样本时必须自己拷一份 */
  encode(s: GameState, seat: PlayerId): Float32Array {
    return encodeState(s, seat, this.stateBuf);
  }

  /** 价值头：state → tanh */
  valueOf(state: Float32Array): number {
    const { value } = this.weights;
    const H = this.spec.hidden;
    const x = state;
    let acc = value.b2;
    const h = this.hidden;
    for (let j = 0; j < H; j++) {
      let s = value.b1[j]!;
      const off = j * this.spec.state;
      for (let i = 0; i < this.spec.state; i++) s += value.w1[off + i]! * x[i]!;
      h[j] = s > 0 ? s : 0;
    }
    for (let j = 0; j < H; j++) acc += value.w2[j]! * h[j]!;
    return Math.tanh(acc);
  }

  /**
   * 线性预筛：挑出分数最高的 topK 个动作，下标写进 `this.cand[0..this.candN)`。
   *
   * 用了一个恒等式：`w·[state ⊕ action] = (w_state·state) + (w_action·action)`。
   * 前半截与动作无关，只算一次——这就是"预筛几乎不要钱"的原因。
   *
   * 只做**部分**选择（找前 K 大），不做整体排序：K=16、N=300 时比 sort 快一个数量级，
   * 而这正是每步都要跑的那一段。
   */
  private prescreen(state: Float32Array, feats: Float32Array, n: number): void {
    if (this.cand.length < n) {
      this.cand = new Int32Array(n * 2);
      this.scoreBuf = new Float64Array(n * 2);
    }
    const { prescreen } = this.weights;
    const S = this.spec.state;
    const A = this.spec.action;
    let base = prescreen.b;
    for (let i = 0; i < S; i++) base += prescreen.w[i]! * state[i]!;
    const wa = prescreen.w;
    const scores = this.scoreBuf;
    for (let j = 0; j < n; j++) {
      let s = 0;
      const off = j * A;
      for (let i = 0; i < A; i++) s += wa[S + i]! * feats[off + i]!;
      scores[j] = s + base;
    }
    const idx = this.cand;
    for (let j = 0; j < n; j++) idx[j] = j;
    const K = Math.min(this.topK, n);
    for (let k = 0; k < K; k++) {
      let best = k;
      for (let j = k + 1; j < n; j++) if (scores[idx[j]!]! > scores[idx[best]!]!) best = j;
      const tmp = idx[k]!;
      idx[k] = idx[best]!;
      idx[best] = tmp;
    }
    this.candN = K;
  }

  /**
   * 对 topK 个候选过一次小 MLP，logits 写进 `this.logits`。
   *
   * 隐藏层缓冲是复用的：「每个候选 new 一个 64 长度数组」看着无害，
   * 但 16 个 × 每步 = 每秒几万次小分配，GC 会替你把省下的时间还回去。
   */
  private rescore(state: Float32Array, feats: Float32Array): void {
    const { scorer } = this.weights;
    const { state: S, action: A, hidden: H } = this.spec;
    if (this.hidden2.length < H) this.hidden2 = new Float32Array(H);
    if (this.logits.length < this.candN) this.logits = new Float64Array(this.candN * 2);
    const x = this.scratch;
    x.set(state.subarray(0, S), 0);
    const h = this.hidden2;
    const joint = S + A;
    for (let c = 0; c < this.candN; c++) {
      const off = this.cand[c]! * A;
      for (let i = 0; i < A; i++) x[S + i] = feats[off + i]!;
      let acc = scorer.b2;
      for (let j = 0; j < H; j++) {
        let s = scorer.b1[j]!;
        const woff = j * joint;
        for (let i = 0; i < joint; i++) s += scorer.w1[woff + i]! * x[i]!;
        const v = s > 0 ? s : 0;
        h[j] = v;
        acc += scorer.w2[j]! * v;
      }
      this.logits[c] = acc;
    }
  }

  /** 温度 + 数值稳定的 softmax（原地改 logits），返回配分函数 */
  private softmax(): number {
    const t = Math.max(1e-3, this.temperature);
    const l = this.logits;
    const n = this.candN;
    let max = -Infinity;
    for (let i = 0; i < n; i++) {
      l[i] = l[i]! / t;
      if (l[i]! > max) max = l[i]!;
    }
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const v = Math.exp(l[i]! - max);
      l[i] = v;
      sum += v;
    }
    return sum;
  }

  /**
   * 做一次决策：编码 → 预筛 → 重排 → softmax → 按概率采样。
   *
   * 采样用调用方给的 `rand`（而不是内部的全局随机），这样同一局重放能复现，
   * 也能让"同种子的两个 worker 跑出同一条轨迹"这件事成立。
   */
  decide(s: GameState, seat: PlayerId, actions: readonly Action[], rand: () => number): Decision {
    if (actions.length === 0) throw new Error('没有合法动作还给策略决策');
    const state = this.encode(s, seat);
    if (this.actionBuf.length < actions.length * this.spec.action) {
      this.actionBuf = new Float32Array(actions.length * this.spec.action);
    }
    this.ctx = actionContext(s, seat, this.ctx ?? undefined);
    const feats = encodeActions(s, seat, actions, this.actionBuf, this.ctx);
    const value = this.valueOf(state);

    this.prescreen(state, feats, actions.length);
    this.rescore(state, feats);
    const sum = this.softmax();

    // 按累积概率采样。从最后一个往前兜底，防浮点误差把 r 留在 sum 之外
    let r = rand() * sum;
    let pick = this.candN - 1;
    for (let i = 0; i < this.candN; i++) {
      r -= this.logits[i]!;
      if (r <= 0) {
        pick = i;
        break;
      }
    }
    const index = this.cand[pick]!;
    return {
      index,
      action: actions[index]!,
      logp: Math.log(this.logits[pick]! / sum),
      value,
      considered: this.candN,
      candidates: Array.from(this.cand.subarray(0, this.candN)),
    };
  }

  /**
   * 当前策略会考虑的候选（预筛 top-K），外加"必须包含"的那一个。
   *
   * 模仿学习要拿"老师选了哪个"当标签，而老师的动作未必在预筛的 top-K 里——
   * 那就把它塞进去（顶掉最后一名）。这样训练用的候选集**就是推理时那批**，
   * 只多了一个标签所在的位置，不会出现"练的和考的不是一张卷子"。
   *
   * 预筛走的是和 `decide` 同一条路径（不是另写一份点积），所以两边不会漂。
   */
  candidateSet(
    s: GameState,
    seat: PlayerId,
    actions: readonly Action[],
    mustInclude = -1,
  ): {
    state: Float32Array;
    feats: Float32Array;
    candidates: number[];
    kUsed: number;
    index: number;
    /**
     * 全部合法动作的预筛分数（长度 = actions.length，顺序同 actions）。
     *
     * 为什么要把内部缓冲拷出来：训练预筛时既要按同一份分布算 softmax 梯度，
     * 又要用同一套并列规则统计召回率。让调用方自己再算一遍分数，
     * 就会在两处 float 累加顺序不同的地方冒出"指标说 60%、实际只有 15%"这种分歧
     * （这已经发生过一次，排查花了很久）。这里多拷 n 个 float64，换掉一整类错误。
     */
    scores: Float64Array;
  } {
    const state = this.encode(s, seat);
    if (this.actionBuf.length < actions.length * this.spec.action) {
      this.actionBuf = new Float32Array(actions.length * this.spec.action);
    }
    this.ctx = actionContext(s, seat, this.ctx ?? undefined);
    const feats = encodeActions(s, seat, actions, this.actionBuf, this.ctx);
    this.prescreen(state, feats, actions.length);
    const candidates: number[] = Array.from(this.cand.subarray(0, this.candN));
    let index = candidates.indexOf(mustInclude);
    if (mustInclude >= 0 && index < 0) {
      if (candidates.length >= this.topK) candidates[candidates.length - 1] = mustInclude;
      else candidates.push(mustInclude);
      index = candidates.length - 1;
    }
    return {
      state,
      feats,
      candidates,
      kUsed: candidates.length,
      index,
      scores: Float64Array.from(this.scoreBuf.subarray(0, actions.length)),
    };
  }

  /**
   * 给定动作下标，重算 logp / value / 熵（PPO 更新与诊断用）。
   *
   * 注意：如果这个下标已经被挤出当前 top-K，`inTopK` 会是 false，logp 给一个
   * 很大的负数，ratio 因此趋近 0 —— 语义是"当前策略已经不考虑这个动作了"。
   */
  evaluate(
    s: GameState,
    seat: PlayerId,
    actions: readonly Action[],
    index: number,
  ): { logp: number; value: number; entropy: number; inTopK: boolean } {
    const state = this.encode(s, seat);
    if (this.actionBuf.length < actions.length * this.spec.action) {
      this.actionBuf = new Float32Array(actions.length * this.spec.action);
    }
    this.ctx = actionContext(s, seat, this.ctx ?? undefined);
    const feats = encodeActions(s, seat, actions, this.actionBuf, this.ctx);
    const value = this.valueOf(state);
    this.prescreen(state, feats, actions.length);
    this.rescore(state, feats);
    const sum = this.softmax();

    let at = -1;
    for (let i = 0; i < this.candN; i++) {
      if (this.cand[i] === index) {
        at = i;
        break;
      }
    }

    let entropy = 0;
    for (let i = 0; i < this.candN; i++) {
      const p = this.logits[i]! / sum;
      if (p > 0) entropy -= p * Math.log(p);
    }
    if (at < 0) return { logp: -30, value, entropy, inTopK: false };
    return { logp: Math.log(this.logits[at]! / sum), value, entropy, inTopK: true };
  }
}
