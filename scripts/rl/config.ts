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
import { TURN_CAP } from '../../src/rl/features.ts';
import type { AiLevel } from '../../src/core/types.ts';

export interface TrainConfig {
  /** 主口径边长：评估默认、play.ts 默认、报告里写"这是多大图"都用它 */
  size: number;
  /**
   * 混合训练用哪几种边长。第一个就是 `size`。
   *
   * 为什么要混合：一份只在 10×10 上训过的权重，换到 12×12 上得分率从 54.4%
   * 掉到 **19.1%**——那不是"弱一点"，是没学会"棋盘有多大"这件事。
   * 而 12×12 是产品默认尺寸，分开训两套权重就是两倍成本，
   * 所以一份权重得同时覆盖两种，靠观测里的尺寸格（`describeEnv` 的第 23 格）
   * 和这里按局轮换尺寸来学会条件化。
   */
  sizes: number[];
  expansions: string[];
  startEra: number;
  /**
   * 回合上限。血战口径下一局约 84 回合，150 是"够长但不会白跑"的位置。
   *
   * 数本身定在 `src/rl/features.ts` 的 `TURN_CAP`：编码器要拿它当 f[0] 的分母，
   * 而编码器现在要打进产品包、不能反过来依赖训练脚本。所以两边读同一个常量。
   */
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
  /*
   * 尺寸配比：12×12 拿三分之二。
   *
   * 以前是 `[10, 12]` 各一半。量下来 12×12 是瓶颈，而且**瓶颈在样本，不在容量**：
   * 最近一轮 64 局里 12×12 占 32 局，其中 34% 撞回合上限被整局丢弃（10×10 只有 3%）；
   * 剩下 21 局里六成是自博弈，非自博弈只剩 12 局，而这 12 局里还有 5 局是平局（同样丢弃）
   * —— **每轮真正有胜负可以学的 12×12 对局只有 7 局**。拿 7 局推策略、
   * 再用 40 局（±14 点）的评估去看变化，本来就看不出方向。
   *
   * 直接写成重复值而不是加一个权重字段：`trainSizeFor` 取的是
   * `sizes[game % sizes.length]`，重复值天然就是权重，不用新增概念。
   */
  sizes: [12, 12, 10],
  // 12×12 一局 2600 步、10×10 1300 步，所以"局数"不等于"步数"——
  // 12:10 = 2:1 时算力大约 4:1 偏给大图，这正是这一轮想要的。
  expansions: ['bloodbath'],
  startEra: 1,
  capTurns: TURN_CAP,
  aiLevel: 'advanced',
};

/**
 * 这一局用多大图。
 *
 * 按**局号交替**，不按种子哈希：一轮 64 局正好各一半，采样成本可预测。
 * 用哈希的话小样本下会偏（某一轮 60/40），而"这一轮的样本偏小图"会直接
 * 污染温度计——它读的是胜率，胜率又强烈依赖图的大小。
 */
export function trainSizeFor(game: number): number {
  const sizes = TRAIN.sizes.length > 0 ? TRAIN.sizes : [TRAIN.size];
  return sizes[game % sizes.length] ?? TRAIN.size;
}

/** 课程学习的阶梯：从弱到强，和 `aiLevelOf` 的三档一一对应 */
export const AI_LEVELS: readonly AiLevel[] = ['basic', 'tactic', 'advanced'];

/** 评估默认沿用训练口径；要对照别的配置时在命令行显式覆盖 */
export const EVAL = TRAIN;
