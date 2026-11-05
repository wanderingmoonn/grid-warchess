/**
 * 生成一份**没有训练过**的初始权重，写进 `scripts/rl/weights/init.json`。
 *
 * 为什么需要它：M1 要做到"整条链路能跑通"，而这跟 PyTorch 在不在没关系。
 * 有了这个文件，`eval --mode policy` 立刻可用——跑出来的胜率会是"随机网络 vs 手写 AI"，
 * 那个数字本身没意义，但它证明了编码、前向、采样、跑局、统计五段是通的。
 *
 * 更重要的用途是当**起点**：M2 的 PPO 从这个文件读入，于是"同一份权重"
 * 从头到尾只有一个来源（文件），TS 和 Python 不会各初始化一套。
 *
 * 用法：
 *   node --experimental-strip-types scripts/rl/init-weights.ts
 *   ... --seed 7 --out scripts/rl/weights/init.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_SPEC, paramCount, randomWeights, weightsToJson } from './policy.ts';

const args = process.argv.slice(2);
const argOf = (name: string, dflt: string): string => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? (args[i + 1] as string) : dflt;
};

const seed = Number(argOf('seed', '20261104'));
const out = argOf('out', path.join('scripts', 'rl', 'weights', 'init.json'));
/**
 * 候选数 K。
 *
 * 原来定 16 是拍脑袋的，量出来才知道它有多贵：预筛是**随机权重**且从不训练，
 * 于是"老师的动作落在 top-K 里"的比例基本就是 K/合法动作数（实测 95 个动作）——
 * K=16 只有 14.6%，K=64 有 58.8%，K=96 有 80.7%。
 * 换句话说 K=16 时 85% 的好棋压根不在候选里，后面的网络再准也选不到。
 * 所以默认放到 64：代价是每步多存 4 倍候选特征（约 11KB/步），换来近 60% 的可选性。
 */
const topK = Number(argOf('topk', '64'));

const w = randomWeights(seed, { ...DEFAULT_SPEC, topK });
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(weightsToJson(w), null, 2));

console.log(
  `初始权重已写入 ${out}` +
    `（seed ${seed} · 参数 ${paramCount(w).toLocaleString('en-US')} 个 · ` +
    `state ${w.spec.state} + action ${w.spec.action} → joint ${w.spec.joint} → hidden ${w.spec.hidden}，topK ${w.spec.topK}）`,
);
