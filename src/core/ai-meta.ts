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

import { seatsOf } from './types.ts';
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

/**
 * 这一回合 AI 大致走几步——**历史值，不要再用它当新代码的上限**。
 *
 * @deprecated 用 `aiStepCap(s)`。这个数按"24 个兵各走一步"估的，
 * 但一个兵一回合能既走又打，24 个兵就是 48 步，再加招募/升级/建造，
 * 后期满编局必然被截断（被砍掉的是分最低的那几步，等于 AI 后期悄悄少打几下）。
 * 留着它只是因为 `scripts/baselines/*` 和四十多个脚本 import 它，
 * 删了会把冻结基线和历史对比一起打断。
 */
export const AI_MAX_STEPS = 50;

/**
 * 这一回合的自然步数上限（替代写死的 50）。
 *
 * 为什么按规模算而不是给个常数：一回合的动作数**本来就是规模的函数**——
 * 10 个兵和 24 个兵不该用同一个名额。常数在小局里浪费、在满编局里截断。
 *
 * 式子怎么来的（每一项都是"最多能做几次"）：
 *   · 每个兵 6 步：走一步（1）+ 多次攻击（`burst` 最高 4）+ 技能（1）；
 *   · 每座城 6 步：招募（默认最多 2）+ 升级（1）+ 建造/换血/修城等余量；
 *   · 底数 8：开局一两个兵时也要够走完"招募 → 升级 → 布阵"。
 * 24 兵 + 3 城 = 170，满编局绝对够；3 兵 1 城 = 32，也比原来宽。
 *
 * **实测（2026-11-17，18 局）**：AI 实际每回合只走 8 步左右、最多 23 步——
 * 它在"没有值得做的事"时就自己收手（`best.v <= 0`）。所以这个式子现在
 * 基本不会生效，改它等于给将来留余量（单兵 AI 上线后扩展会主动提动作）。
 *
 * **这不是保险丝**。真正防死循环的是调用方的"无进展检测"（见 main.ts）：
 * 一个"成功但局面没变"的动作（形如"切换形态"）会让这个式子形同虚设——
 * 它会一直被选、一直成功。这个数只保证"再怎么也不该超过这么多"。
 */
export function aiStepCap(s: GameState): number {
  let units = 0;
  for (const u of s.units) if (u.owner === s.current) units += 1;
  let cities = 0;
  for (const c of s.cities) if (c.owner === s.current) cities += 1;
  return 8 + 6 * units + 6 * cities;
}

/**
 * 局面指纹：判断"这一步到底有没有改变什么"。
 *
 * 为什么不用 `s.version` 那种每步都加一的计数器：它**永远在变**，问不出
 * "变了多少"。这里要的是"变化了没有"，而且只认**玩家看得见的变化**——
 * 站位、血量、本回合还能不能动、金币、城、地上的留痕。
 *
 * 刻意**不包含** `unit.custom`：那里是扩展的自留地（形态、姿态、层数）。
 * 把它算进来的话，"切换形态"这种动作会一直显示"有变化"，卡死检测就永远
 * 抓不到它——而它恰好是最典型的空转。同理，`custom` 变了不算进展。
 */
export function aiProgressFingerprint(s: GameState): string {
  let h = 2166136261 >>> 0;
  const mix = (n: number) => {
    h = Math.imul(h ^ (n | 0), 16777619) >>> 0;
  };
  mix(s.units.length);
  for (const u of s.units) {
    mix(u.x * 131 + u.y * 17);
    mix(u.hp * 7);
    mix((u.moved ? 1 : 0) | ((u.acted ? 1 : 0) << 1));
    mix(u.owner.charCodeAt(0));
  }
  mix(s.cities.length);
  for (const c of s.cities) {
    mix(c.x * 31 + c.y * 7 + (c.ruined ? 1 : 0) + c.owner.charCodeAt(0));
  }
  for (const p of Object.values(s.players)) mix(p.gold);
  mix(s.marks?.length ?? 0);
  mix(s.winner ? 1 : 0);
  return (h >>> 0).toString(36);
}

/**
 * 卡死检测：同一个动作连续成功、局面却一动不动，就判定它在空转。
 *
 * 为什么必须有它（而不是靠名额）：`aiStepCap` 只是"再怎么样也不该超过这么多"。
 * 真正的死循环是"成功但没进展"——形态切换、开关姿态、把单位塞进船又拿出来。
 * 这类动作每一步都返回 ok，`rejected` 记不住它们（那个表只记被规则拒掉的），
 * 于是 AI 会一直选、一直成功，直到名额烧光。**名额能兜住"不卡死电脑"，
 * 但兜不住"这一回合剩下的人全都不动"**。
 *
 * 判据故意写得保守：**同一个动作 key 重复**才算，不是"连续三步都没变化"。
 * 后者会误伤一类正常打法——三个兵依次进入某种只改 `custom` 的架势。
 * 那不是死循环，是三个人各做了一次不同的事。
 *
 * `limit` 是"重复几次才判死"：默认 2，也就是同一个动作第 **3** 次成功
 * 且局面还是没变的时候收手。
 */
export interface AiStallGuard {
  /**
   * 喂一条**已经成功执行**的动作。返回 true = 判定空转，调用方该交棒。
   *
   * 注意只能喂成功的动作：被规则拒掉的那些由 `rejected` 表管，
   * 喂进来会把"AI 在换方案"误判成"AI 卡住了"。
   */
  note(actionKey: string, fingerprint: string): boolean;
  /** 当前已重复的次数（0 = 上一步换了动作或局面变了）。给告警文案用 */
  readonly repeats: number;
}

export function aiStallGuard(limit = 2): AiStallGuard {
  let lastKey = '';
  let lastFp = '';
  let repeats = 0;
  return {
    note(actionKey: string, fingerprint: string): boolean {
      if (lastKey !== '' && actionKey === lastKey && fingerprint === lastFp) repeats += 1;
      else repeats = 0;
      lastKey = actionKey;
      lastFp = fingerprint;
      return repeats >= limit;
    },
    get repeats(): number {
      return repeats;
    },
  };
}

export function aiLevelOf(s: GameState): AiLevel {
  const lv = s.config.aiLevel;
  return lv === 'basic' ? 'basic' : lv === 'tactic' ? 'tactic' : 'advanced';
}

/** 给界面用的一档名字（不带 "AI" 后缀，由调用方自己拼）。 */
export function aiLevelLabel(lv: AiLevel): string {
  return lv === 'basic' ? '初级' : lv === 'tactic' ? '中级' : '高级';
}

/** 这一局的 AI 用的是哪个内核（缺省＝手写那套） */
export function aiBrainOf(s: GameState): 'script' | 'net' | 'goal' {
  const b = s.config.aiBrain;
  return b === 'net' || b === 'goal' ? b : 'script';
}

/**
 * 界面上该把这个 AI 叫什么。
 *
 * 网络那一档必须**单独一个名字**，不能写成"高级 AI"之类——玩家有权知道
 * 对面换了个东西，尤其因为它不受迷雾限制（见 rl/brain.ts 的说明）。
 */
export function aiNameOf(s: GameState): string {
  const brain = aiBrainOf(s);
  if (brain === 'net') return '测试 AI';
  if (brain === 'goal') return '实验 AI';
  return `${aiLevelLabel(aiLevelOf(s))} AI`;
}

/**
 * 这一席现在是电脑在走吗？
 *
 * 三层，**顺序不能换**：
 *   1. 对局中途手动托管的（`aiControl`）——优先，因为玩家刚点过，
 *      下一回合就该听他的，而不是被开局配置顶回去；
 *   2. `config.aiSeats`——开局时定下的。注意 `[]` 是"全是真人"，不是"没设置"，
 *      所以判的是 `!== undefined`；
 *   3. 老存档：config 里没有 `aiSeats`，回落到 `aiOpponent` / `aiAlly`。
 *      那两个是两家局的语义（B 看前者、其余看后者），老存档、老房间、
 *      老复盘全靠这一条才对得上。
 */
export function isAiSide(s: GameState, p: PlayerId): boolean {
  const override = s.aiControl?.[p];
  if (override !== undefined) return override;
  const seats = s.config.aiSeats;
  if (seats !== undefined) return seats.includes(p);
  return p === 'B' ? s.config.aiOpponent : s.config.aiAlly;
}

/** 有电脑在场上就不需要"把设备交给下一位"的遮罩了 */
export function anyAiSide(s: GameState): boolean {
  // 按席位全查一遍，而不是只问 A/B：三家四家局里丙丁也可以交给电脑。
  return seatsOf(s).some((p) => isAiSide(s, p));
}
