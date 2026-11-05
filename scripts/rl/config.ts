/**
 * 训练与评估共用的**口径**。
 *
 * 为什么单拎一个文件：棋盘尺寸、扩展包、回合上限这三样只要有一处不一致，
 * "训练时明明赢了、评估时输了"就会被误读成算法问题。让它只有一处定义，
 * 训练脚本、评估台、以后的 PPO 采样器全部 import 这里。
 *
 * 这份口径是 M1 用 8 组对照量出来的（见 docs/RL-PLAN.md 7.4）：
 *   · **10×10 + 血战**：先手胜率 61%、超时判平 10%、一局约 84 回合；
 *   · 8×8 先手 94.7% —— 策略在那儿只能学"怎么当先手"，不能用来训练；
 *   · 12×12 默认规则 60% 打不完，开了血战还有 40% 打不完，一局还要多花一倍时间。
 */
import type { AiLevel } from '../../src/core/types.ts';

export interface TrainConfig {
  size: number;
  expansions: string[];
  startEra: number;
  /** 回合上限。血战口径下一局约 84 回合，150 是"够长但不会白跑"的位置 */
  capTurns: number;
  /**
   * 手写 AI 的难度档（`src/core/ai-meta.ts` 的 `aiLevelOf`）。
   *
   * 这是整条训练链上唯一一个"让对手变弱"的合法开关。为什么必须有它：
   * 高级档的 AI 对一个随机初始化的策略是 160:0——每局都输、每一步的终局奖励
   * 全是 −1，PPO 拿到的优势里没有"好动作 vs 坏动作"的对比，KL 再健康也学不出东西。
   * 课程学习就是先把对手降到初级档，等胜率上来了再抬回去。
   */
  aiLevel: AiLevel;
}

export const TRAIN: TrainConfig = {
  size: 10,
  expansions: ['bloodbath'],
  startEra: 1,
  capTurns: 150,
  aiLevel: 'advanced',
};

/** 课程学习的阶梯：从弱到强，和 `aiLevelOf` 的三档一一对应 */
export const AI_LEVELS: readonly AiLevel[] = ['basic', 'tactic', 'advanced'];

/** 评估默认沿用训练口径；要对照别的配置时在命令行显式覆盖 */
export const EVAL = TRAIN;
