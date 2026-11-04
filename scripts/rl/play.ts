/**
 * 一局对局的"自动驾驶"：把座位交给 AI / 策略 / 随机三种驾驶者，跑完一整局。
 *
 * 为什么要有这个文件：训练与评估需要**同一个**跑局函数。评估台量的是"策略有多强"，
 * 如果它和训练用的跑局逻辑不是同一份，"训练时能赢、评估时输了"就分不清是策略变差
 * 还是裁判换了尺子。所以这里只写一份，训练脚本和评估脚本都调它。
 *
 * 手写 AI 那一侧刻意照抄界面里的驱动方式（`main.ts` 的 `runAiTurn`）：
 * 同样的 `DEFAULT_BUDGET`、同样的"被拒绝的动作记下来重试"、同样的
 * `AI_MAX_STEPS` 上限。少一样，基线就不是用户实际面对的那个 AI 了。
 */
import { AI_MAX_STEPS, DEFAULT_BUDGET, aiActionKey, aiNextAction } from '../../src/core/ai.ts';
import type { AiBudget } from '../../src/core/ai-meta.ts';
import { applyAction } from '../../src/core/rules.ts';
import { DEFAULT_CONFIG, createMatch } from '../../src/core/setup.ts';
import type { Action, GameState, PlayerId } from '../../src/core/types.ts';
import { TRAIN } from './config.ts';
import { legalActions } from './legal.ts';
import type { Decision, Policy } from './policy.ts';
import { hashSeed, mulberry32 } from './rng.ts';

/** 谁在开这一方 */
export type Driver =
  | { kind: 'ai' }
  | { kind: 'random' }
  | { kind: 'policy'; policy: Policy };

export interface StepInfo {
  state: GameState;
  seat: PlayerId;
  action: Action;
  /** 策略驾驶者才有：采样下标、logp、价值 */
  decision?: Decision;
  /** 轮次内第几步 */
  step: number;
}

export interface MatchOptions {
  seed: number;
  /** 边长为 N 的正方形图，默认走 config.ts 的训练口径 */
  size?: number;
  startEra?: number;
  /** 回合上限，超了算平局（默认 120，和训练口径一致） */
  capTurns?: number;
  /** 两家各自的驾驶者，[A, B] */
  drivers: [Driver, Driver];
  /** 每一方的扩展包（默认空：用全兵种开放的基础规则） */
  expansionIds?: string[];
  /** 每步回调。训练时在这里写轨迹 */
  onStep?: (info: StepInfo) => void;
  /** 单回合最多几步（防死循环），默认跟界面一致 */
  maxStepsPerTurn?: number;
}

export interface MatchOutcome {
  winner: PlayerId | null;
  /** 结束时打到第几回合 */
  turns: number;
  /** 总步数（动作数） */
  steps: number;
  /** 每方走了多少步 */
  stepsBySeat: Record<PlayerId, number>;
  /** 引擎拒绝了几个动作（正常情况下应该恒为 0，非 0 说明枚举和规则漂了） */
  rejected: number;
  /** 超时判平 */
  timeout: boolean;
  /**
   * 终局状态。
   *
   * 加它是因为"重放要拿终局对账"：录制方手里必须有**那一局**的终局，
   * 而不是自己再跑一遍（再跑一遍等于把"同一局"换成"我算的那一局"，
   * 一旦有分叉，两边都不知道该信谁）。
   */
  finalState: GameState;
}

/**
 * 跑一局。
 *
 * 座位顺序与规则层一致：A 先手，然后按 `PLAYER_ORDER` 轮转。
 * 策略驾驶者各自带一颗 **由 (seed, 座位) 派生的**随机流——
 * 这样同一颗种子重跑是同一局，而两个座位的采样又互不相关。
 */
export function playMatch(o: MatchOptions): MatchOutcome {
  const size = o.size ?? TRAIN.size;
  let s = createMatch(
    {
      ...DEFAULT_CONFIG,
      size,
      startEra: o.startEra ?? TRAIN.startEra,
      playerCount: 2,
      draftMode: false,
      aiOpponent: false,
      aiAlly: false,
      expansionIds: o.expansionIds ?? TRAIN.expansions,
    },
    o.seed,
  );
  // 训练关迷雾：全信息，价值估计的方差小得多（见 docs/RL-PLAN.md 3.4）
  s.fog = false;

  const cap = o.capTurns ?? TRAIN.capTurns;
  const maxSteps = o.maxStepsPerTurn ?? AI_MAX_STEPS;
  const rands = new Map<PlayerId, () => number>();
  const outcome: MatchOutcome = {
    winner: null,
    turns: 0,
    steps: 0,
    stepsBySeat: { A: 0, B: 0, C: 0, D: 0 },
    rejected: 0,
    timeout: false,
    // 下面循环结束时会被替换成真正的终局；这里的占位不会被任何人读到
    finalState: s,
  };

  let turnSeat: PlayerId | null = null;
  let inTurn = 0;
  const rejectedAi = new Set<string>();
  // 预算必须**一整个回合共用一份**：maxRecruit/maxUpgrade 是"这一回合还能造几个"，
  // 每次出招都新建一份等于把上限重置，AI 会一路造到步数上限（界面里是每回合新建一份）
  let budget: AiBudget = { ...DEFAULT_BUDGET };

  /**
   * 应用一个动作并**记账**。
   *
   * 为什么要包一层：这个循环里有三种"替玩家收手"的地方（步数到顶、AI 交白卷、
   * 没有合法动作），它们都会补一个 END_TURN。以前那几处直接 `applyAction`，
   * 不经 `onStep`——于是录下来的动作序列**缺了这些回合切换**，
   * 重放时走到第 23 步就发现"该轮到 B 了，可记录里还是 A"。
   * 录制器的第一条规矩：凡是改了状态的，都得留下痕迹。
   */
  const applyAndNote = (
    seat: PlayerId,
    action: Action,
    decision: Decision | undefined,
    step: number,
  ): boolean => {
    o.onStep?.({ state: s, seat, action, decision, step });
    const r = applyAction(s, action);
    if (!r.ok) {
      outcome.rejected += 1;
      return false;
    }
    s = r.state;
    outcome.steps += 1;
    outcome.stepsBySeat[seat] = (outcome.stepsBySeat[seat] ?? 0) + 1;
    return true;
  };

  while (!s.winner && s.turn <= cap) {
    const seat = s.current;
    if (seat !== turnSeat) {
      turnSeat = seat;
      inTurn = 0;
      rejectedAi.clear();
      budget = { ...DEFAULT_BUDGET };
    }
    if (inTurn >= maxSteps) {
      // 手写 AI 有"这一回合不再动了"的判断；策略没有，所以只能在这里兜底。
      // 这个 END_TURN 也要记账——它是这一回合的收尾，漏了它重放就接不上。
      if (!applyAndNote(seat, { type: 'END_TURN' }, undefined, inTurn)) break;
      continue;
    }

    const driver = o.drivers[seat === 'A' ? 0 : 1];
    let action: Action | null = null;
    let decision: Decision | undefined;

    if (driver.kind === 'ai') {
      action = aiNextAction(s, budget, rejectedAi);
      if (!action) {
        if (!applyAndNote(seat, { type: 'END_TURN' }, undefined, inTurn)) break;
        continue;
      }
    } else if (driver.kind === 'random') {
      const acts = legalActions(s, seat);
      if (acts.length === 0) break;
      let rand = rands.get(seat);
      if (!rand) {
        rand = mulberry32(hashSeed(o.seed, seat, 'random'));
        rands.set(seat, rand);
      }
      action = acts[Math.floor(rand() * acts.length)]!;
    } else {
      const acts = legalActions(s, seat);
      if (acts.length === 0) break;
      let rand = rands.get(seat);
      if (!rand) {
        rand = mulberry32(hashSeed(o.seed, seat, 'policy'));
        rands.set(seat, rand);
      }
      const d = driver.policy.decide(s, seat, acts, rand);
      action = d.action;
      decision = d;
    }

    const applied = applyAndNote(seat, action, decision, inTurn);
    if (!applied) {
      // 手写 AI 偶尔会给出被规则否掉的动作（界面里也是这样处理的：记下来重试）
      if (driver.kind === 'ai') {
        rejectedAi.add(aiActionKey(action));
        continue;
      }
      // 策略给出非法动作 = 枚举与规则漂了，直接掐掉这局，别让它污染统计
      break;
    }
    inTurn += 1;
    // 和界面一致：动作被接受了，之前那些"被否掉"的记录就没用了
    rejectedAi.clear();
    if (action.type === 'RECRUIT') budget.recruited += 1;
    if (action.type === 'UPGRADE') budget.upgraded += 1;
  }

  outcome.winner = s.winner ?? null;
  outcome.turns = s.turn;
  outcome.timeout = !s.winner && s.turn > cap;
  outcome.finalState = s;
  return outcome;
}
