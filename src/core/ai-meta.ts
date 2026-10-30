/**
 * AI 的"元信息"：档位、托管判定、行动预算。
 *
 * ── 为什么把这几个小东西单独拆出来 ─────────────────────────────────────
 *
 * `ai.ts` 有三千四百多行、35KB，装的是整套走子与采购的推演（威胁图、换子价值、
 * 三套战术）。**它对首屏毫无贡献**：开局那一帧只用到"这一方是不是 AI"和
 * "难度叫什么名字"这两个判断。
 *
 * 但只要有 `import { anyAiSide } from './core/ai.ts'` 这一行，整个引擎就会
 * 被打进主包——打包器没法把"只用了一个两行函数"这件事拆开。
 * 于是把那几个两行的函数搬到这个文件，主包直接少掉 35KB（brotli 后约 11KB），
 * 而引擎改成在"真的轮到 AI 走"那一刻动态 import（见 main.ts 的 `aiEngine()`）。
 *
 * **这是个单向依赖**：这里只 import 类型，`ai.ts` 反向 import 这个文件。
 * 不要在这里 import 任何会再引回 `ai.ts` 的东西，否则就是循环。
 */

import type { AiLevel, GameState, PlayerId } from './types.ts';

export interface AiBudget {
  maxRecruit: number;
  maxUpgrade: number;
  recruited: number;
  upgraded: number;
  /**
   * 指挥官模式：本回合点名的兵种 id。
   *
   * 有值时 AI 只造这一个兵，造不出来就这回合不产兵（转去做别的事）；
   * 空/未设时照旧自己挑。这一条是"把产兵权交回玩家、其余全托管"的挂钩点。
   */
  order?: string | null;
  /**
   * 指挥官模式：这一格指定的产兵点（城市或军营的 id）。空/未设＝哪座都行。
   *
   * 指定了就只在那一个产兵点造：城市不够高级、军营被拆、兵种下水没位置，
   * 这一格就空转——和"钱不够"一样，是玩家排计划时该自己预见到的后果。
   * 队首是「升级时代」时，它指的是"升这一座城"。
   */
  orderSite?: string | null;
}

export const DEFAULT_BUDGET: AiBudget = {
  maxRecruit: 2,
  maxUpgrade: 1,
  recruited: 0,
  upgraded: 0,
};

/** 这一回合 AI 大致的行动次数上限，防止它无限循环 */
export const AI_MAX_STEPS = 50;

export function aiLevelOf(s: GameState): AiLevel {
  const lv = s.config.aiLevel;
  return lv === 'basic' ? 'basic' : lv === 'tactic' ? 'tactic' : 'advanced';
}

/** 给界面用的一档名字（不带 "AI" 后缀，由调用方自己拼）。 */
export function aiLevelLabel(lv: AiLevel): string {
  return lv === 'basic' ? '初级' : lv === 'tactic' ? '中级' : '高级';
}

/**
 * 这一方现在是 AI 在走吗？
 *
 * 配置（aiOpponent / aiAlly）只决定开局时谁托管，
 * 对局中途要能随时改——调平衡的时候"我这回合自己走、下回合交给它"是常态。
 * 所以运行时的 aiControl 优先，没设置过才回落到配置。
 */
export function isAiSide(s: GameState, p: PlayerId): boolean {
  const override = s.aiControl?.[p];
  if (override !== undefined) return override;
  return p === 'B' ? s.config.aiOpponent : s.config.aiAlly;
}

/** 有一方是 AI 就不需要"把设备交给对方"的遮罩了 */
export function anyAiSide(s: GameState): boolean {
  return isAiSide(s, 'A') || isAiSide(s, 'B');
}
