/**
 * 出题器（真实局面版）：从一局回放里切出"轮到某一方、还没动手"的那一格。
 *
 * 产出交给 `scripts/lib/exam-kit.ts` 写成一套题（snap / card / answer / author）。
 * 手摆局面走 `scripts/make-scene.ts`，两者共用同一套写文件的逻辑，
 * 所以题卡长相永远一致。
 *
 * ── 为什么 --turn 是"半回合" ──────────────────────────────────
 *
 * 引擎每次 `END_TURN` 都把 `s.turn += 1`，所以这个数是**半回合**：
 * A 的第 12 手之后是 B 的第 13 手。`analyze-replay` 打出来的 T16/T31 也是这个口径。
 *
 * 用法：
 *   node --experimental-strip-types scripts/make-exam.ts \
 *     --replay results/replays/v4src-Q3-49-A.json \
 *     --turn 151 --me A --id Y-003 --out exams/Y-003
 *
 *   --dry 只打印面板，不写文件
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DEFAULT_CONFIG, createMatch } from '../src/core/setup.ts';
import { applyAction } from '../src/core/rules.ts';
import { writeExam } from './lib/exam-kit.ts';
import type { GameState, PlayerId } from '../src/core/types.ts';

const argOf = (name: string, fallback = ''): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
};

const REPLAY = argOf('replay');
const TURN = Number(argOf('turn', '0'));
const ME = (argOf('me', 'A').toUpperCase() === 'B' ? 'B' : 'A') as PlayerId;
const ID = argOf('id', 'Y-000');
const OUT = resolve(argOf('out', `exams/${ID}`));
const NOTE = argOf('note', '');
const ASK = argOf('ask', '这一回合你会怎么做？（最多 3 步，按顺序，每步一句为什么）');
const DRY = process.argv.includes('--dry');

if (!REPLAY || !TURN) {
  console.error('用法：make-exam.ts --replay <回放.json> --turn <半回合> [--me A] [--id Y-001] [--out dir] [--dry]');
  process.exit(1);
}

/* ── 重放 ───────────────────────────────────────────────────────
 * 和 analyze-replay / diag-replay 同一套重建方式：参数少抄一项就不是同一局。
 */
const r = JSON.parse(readFileSync(resolve(REPLAY), 'utf8')) as {
  seed: number;
  config?: Record<string, unknown>;
  actions?: Array<Record<string, unknown>>;
  winner?: PlayerId | null;
  turns?: number;
  fog?: boolean;
};
const cfg = r.config ?? {};
let s: GameState = createMatch(
  {
    ...DEFAULT_CONFIG,
    size: Number(cfg.size ?? 12),
    startEra: Number(cfg.startEra ?? 2),
    mapSymmetry: (cfg.mapSymmetry as 'fair') ?? 'fair',
    citySize: cfg.citySize as number | undefined,
  },
  r.seed,
);

const actions = r.actions ?? [];
let cut: GameState | null = null;
/** 切点之后、该方这一回合里的动作（"v3 干了什么"）。只给出题人看 */
const then: Array<Record<string, unknown>> = [];
let passed = false;

for (const a of actions) {
  if (!cut && s.current === ME && s.turn >= TURN) {
    cut = structuredClone(s);
    passed = true;
  }
  if (passed) {
    // 该方一结束回合就停收，否则会把后面几十回合的动作也算进"这一回合"
    if (a.type === 'END_TURN') passed = false;
    else then.push(a);
  }
  const res = applyAction(s, a as never);
  if (!res.ok) {
    console.error(`第 ${s.turn} 手的这个动作被引擎拒了：${JSON.stringify(a)}（${res.reason ?? ''}）`);
    break;
  }
  s = res.state;
}

if (!cut) {
  console.error(`没找到 ${ME} 方第 ${TURN} 手。这局最后停在 ${s.turn}（终局 ${s.winner ?? '平'}）。`);
  process.exit(1);
}

const { panelFull } = writeExam({
  state: cut,
  me: ME,
  id: ID,
  out: OUT,
  ask: ASK,
  source: `\`${REPLAY}\` · 从第 ${TURN} 手起切，实际落在第 ${cut.turn} 手 · ${ME} 方`,
  note: NOTE || `${ID}（切自回放）：${ASK}`,
  thenActions: then,
  fog: r.fog === true,
  dry: DRY,
});

if (DRY) {
  console.log(panelFull);
  process.exit(0);
}
console.log(panelFull.split('\n').slice(0, 6).join('\n'));
console.log(`\n已写出：${OUT}/{snap.json, card.md, answer.md, author.md}`);
console.log(`自检：重放到终局 = ${s.winner ?? '平'}（第 ${s.turn} 手） · 回放记录 = ${r.winner ?? '平'}（第 ${r.turns}）`);
