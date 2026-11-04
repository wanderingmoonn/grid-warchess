/**
 * 合法动作枚举的硬测试：**枚举出来的每个动作，applyAction 都必须接受**。
 *
 * 这条是训练环境的地基。枚举比规则多列一个动作，策略就会学到"下出去会报错"的选择；
 * 少列一个，策略就永远做不到那件事（而且很难发现）。所以两边都要盯，这里先盯第一种。
 *
 * 用法：
 *   node --experimental-strip-types scripts/rl/verify-legal.ts
 *   ... --size 8 --seeds 2 --cap 60 --full        # 每一步都全量校验（慢，但最严）
 *   ... --size 12 --seeds 1 --cap 40              # 12×12 抽查
 */
import { applyAction } from '../../src/core/rules.ts';
import { createMatch, DEFAULT_CONFIG } from '../../src/core/setup.ts';
import type { Action, GameState } from '../../src/core/types.ts';
import { actionHistogram, legalActions } from './legal.ts';

const args = process.argv.slice(2);
const argOf = (name: string, dflt: string): string => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? (args[i + 1] as string) : dflt;
};
const SIZE = Number(argOf('size', '8'));
const SEEDS = Number(argOf('seeds', '2'));
const CAP = Number(argOf('cap', '60'));
const FULL = args.includes('--full');
const SAMPLE = Number(argOf('sample', '40'));

function rng(seed: number): () => number {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    return x / 4294967296;
  };
}

interface Fail {
  seed: number;
  turn: number;
  action: Action;
  reason: string;
}

const fails: Fail[] = [];
const reasons = new Map<string, number>();
let steps = 0;
let enumerated = 0;
let verified = 0;
const hist = new Map<string, number>();

for (let k = 0; k < SEEDS; k++) {
  const seed = 70001 + k * 97;
  let s: GameState = createMatch(
    { ...DEFAULT_CONFIG, size: SIZE, startEra: 1, draftMode: false },
    seed,
  );
  s.fog = false; // 训练场：全信息
  const rand = rng(seed);

  while (!s.winner && s.turn <= CAP) {
    const actions = legalActions(s);
    if (actions.length === 0) break;
    steps += 1;
    enumerated += actions.length;
    for (const [t, n] of Object.entries(actionHistogram(actions))) {
      hist.set(t, (hist.get(t) ?? 0) + n);
    }

    // 校验：故意"挑最可疑的"——非 END_TURN 的动作优先，长度大的类型优先
    const pool = FULL
      ? actions
      : (() => {
          const nonEnd = actions.filter((a) => a.type !== 'END_TURN');
          if (nonEnd.length <= SAMPLE) return actions;
          const picked: Action[] = [];
          for (let i = 0; i < SAMPLE; i++) {
            picked.push(nonEnd[Math.floor(rand() * nonEnd.length)]!);
          }
          // 每个类型至少挑一个，避免小类型永远抽不到
          const seen = new Set(picked.map((a) => a.type));
          for (const a of nonEnd) {
            if (!seen.has(a.type)) {
              picked.push(a);
              seen.add(a.type);
            }
          }
          return picked;
        })();

    for (const a of pool) {
      verified += 1;
      const r = applyAction(s, a);
      if (!r.ok) {
        const reason = r.reason ?? '(无理由)';
        fails.push({ seed, turn: s.turn, action: a, reason });
        reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
      }
    }

    // 用随机合法动作推进（确定性：同一颗种子同一条轨迹）
    const pick = actions[Math.floor(rand() * actions.length)]!;
    const r = applyAction(s, pick);
    if (!r.ok) {
      fails.push({ seed, turn: s.turn, action: pick, reason: `推进时被拒：${r.reason}` });
      break;
    }
    s = r.state;
  }
}

console.log(`${SEEDS} 局 · ${SIZE}×${SIZE} · 走 ${steps} 步 · 共枚举 ${enumerated} 个动作（均 ${(enumerated / Math.max(1, steps)).toFixed(0)}/步）`);
console.log(`校验 ${verified} 个（${FULL ? '全量' : `每步抽样 ${SAMPLE}+各类型至少一例`}）· 失败 ${fails.length} 个`);

if (fails.length > 0) {
  const byReason = [...reasons.entries()].sort((a, b) => b[1] - a[1]);
  console.log('\n失败原因（去重后按次数）：');
  for (const [r, n] of byReason.slice(0, 12)) console.log(`  ${n} 次 · ${r}`);
  console.log('\n前 8 个例子：');
  for (const f of fails.slice(0, 8)) {
    console.log(`  种子 ${f.seed} 第 ${f.turn} 回合 · ${JSON.stringify(f.action)} → ${f.reason}`);
  }
  process.exitCode = 1;
} else {
  console.log('\n全部通过：枚举出来的动作都下得下去。');
}

const top = [...hist.entries()].sort((a, b) => b[1] - a[1]);
console.log('动作构成：' + top.map(([t, n]) => `${t} ${(n / Math.max(1, enumerated) * 100).toFixed(0)}%`).join(' · '));
