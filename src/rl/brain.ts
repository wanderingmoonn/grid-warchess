/**
 * 测试 AI：把训练出来的策略网络接到产品里。
 *
 * ── 它是什么 ─────────────────────────────────────────────────────────────
 *
 * 一个 30 万参数不到的小网络（观测 221 维 + 动作 62 维），在 10×10/12×12 的
 * 血战口径上跟手写 AI 打了三十四轮自博弈，最后在**完全不削弱**的手写 AI 上
 * 拿到 54.4%（160 局 83 胜 69 负 8 平）。
 *
 * ── 它和手写 AI 的两处本质差别（都必须让人知道）──────────────────────────
 *
 * 1. **它不受迷雾限制。**
 *    手写 AI 只吃 `playerView` 的结果，跟玩家一样在雾里摸；
 *    而这个网络的观测是直接从 `GameState` 编的，**没有遮蔽逻辑**——
 *    它在有雾的对局里能看见你的全部。所以界面上它叫「测试 AI（全视野）」，
 *    并且带一句说明。这不是疏忽，是 2026-11-06 定的产品取舍：
 *    做一版"雾里也能打"的策略要重做观测、枚举和重训（约两天，且初版一定更弱），
 *    而这个项目的 AI 是给玩家当对手用的，不是当公平的参赛者。
 *
 * 2. **它只会一种打法节奏。** 手写 AI 有初级/中级/高级三档、有 doctrine；
 *    这个网络没有档位，就是它训练出来的样子。
 *
 * ── 为什么要单独一个模块 ─────────────────────────────────────────────────
 *
 * 训练脚本和产品必须用**同一份**编码器、同一份合法动作枚举、同一份前向。
 * 任何一边单独复制一份，都会换来"训练时这么编码、上线时那么编码"——
 * 那种错不报错，只是棋力莫名下降。所以实现在 `src/rl/`，训练脚本 re-export。
 */
import { legalActions } from './legal.ts';
import { Policy, weightsFromJson, type Weights } from './policy.ts';
import { mulberry32 } from './rng.ts';

/**
 * 把 `mulberry32` 转出去。
 *
 * 主程序那边的随机流是按"一局一家一条"管的（见 main.ts 的 `netRandFor`），
 * 但它不该为了拿这个函数把整份 rng 静态打进首屏包——这是唯一需要它的地方。
 */
export { mulberry32 };
import type { Action, GameState, PlayerId } from '../core/types.ts';

/** 权重文件名：`public/` 下的路径，构建后原样出现在 `dist/ai/` */
const NET_WEIGHTS_PATH = 'ai/net-v2.json';

/**
 * 权重的实际 URL。
 *
 * 用 `document.baseURI` 拼而不是写死 `/ai/...`：这个站点是按相对路径发布的
 * （vite 配置里 `base: './'`），部署到子目录、或者直接双击 `index.html`
 * 打开时，绝对路径都会 404。取不到 document（Node 里跑测试）就退回根路径。
 */
export function netWeightsUrl(): string {
  try {
    return new URL(NET_WEIGHTS_PATH, document.baseURI).href;
  } catch {
    return `/${NET_WEIGHTS_PATH}`;
  }
}

let policy: Policy | null = null;
let inflight: Promise<Policy | null> | null = null;
/** 上一次加载失败的原因，给界面显示（"加载失败"四个字帮不上任何忙） */
let lastError: string | null = null;

export function netPolicyReady(): boolean {
  return policy !== null;
}

export function netLoadError(): string | null {
  return lastError;
}

/**
 * 直接装一份权重（测试和离线工具用）。
 *
 * 单独开这个口子而不是让调用方去摸内部变量：测试要能从磁盘读权重、
 * 跳过网络请求，而浏览器那边走 `loadNetPolicy` 的 fetch。
 */
export function installNetPolicy(w: Weights): Policy {
  policy = new Policy(w);
  lastError = null;
  return policy;
}

/**
 * 拉权重。
 *
 * 并发安全：正在拉的时候再调一次会复用同一个 Promise——AI 连续行动时
 * `ensure` 会被调很多次，不合并的话会同时发出几十个 175KB 的请求。
 */
export async function loadNetPolicy(url: string = netWeightsUrl()): Promise<Policy | null> {
  if (policy) return policy;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const res = await fetch(url, { cache: 'force-cache' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const raw = (await res.json()) as unknown;
      policy = new Policy(weightsFromJson(raw));
      lastError = null;
      return policy;
    } catch (err) {
      lastError = (err as Error).message || '未知错误';
      return null;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/**
 * 这一方下一步走什么。
 *
 * 返回 `null` = 这一回合没得走了（交给调用方结束回合）。
 *
 * `rand` 由调用方持有：同一个种子 → 同一局棋，存档/回放/双 AI 观战才稳得住。
 */
export function netNextAction(
  s: GameState,
  seat: PlayerId,
  rand: () => number,
  p: Policy | null = policy,
  /**
   * 已经下过、被引擎拒掉的动作。
   *
   * 正常情况下这个集合永远是空的（`verify-legal` 全量校过 9.5 万个动作），
   * 但"枚举和规则漂了"这种事如果发生，不排除就会**原地死循环**：
   * 采样每次都落到同一个非法动作上，直到撞满一回合的步数上限。
   */
  avoid?: ReadonlySet<string>,
): Action | null {
  if (!p) return null;
  let actions = legalActions(s, seat);
  if (avoid && avoid.size > 0) {
    const kept = actions.filter((a) => !avoid.has(JSON.stringify(a)));
    if (kept.length > 0) actions = kept;
  }
  if (actions.length === 0) return null;
  return p.decide(s, seat, actions, rand).action;
}

/** 一局棋一个随机流：从种子派生，和手写 AI 的确定性口径一致 */
export function netRandFor(s: GameState, seat: PlayerId): () => number {
  return mulberry32((s.seed * 2654435761 + (seat === 'A' ? 1 : 2)) >>> 0);
}
