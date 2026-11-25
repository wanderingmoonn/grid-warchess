/**
 * 产出**带思考记录的回放文件**（报告格式，直接拖进游戏的「复盘」就能看）。
 *
 *   node --experimental-strip-types scripts/make-replay.ts --exam S-013 [--out ...] [--window 20] [--me-ai v4]
 *
 * 和 `exam-grade.ts` 用同一套驱动（A 席 = `--me-ai`，B 席 = `auto`），区别只在于
 * **跑完把整局的 state 交给 `buildMatchReport`**——报告里的 `aiTrace.squads`
 * 就是 v4 每一手的编队（见 `ai-v4.ts` 的 `logSquads`）。
 *
 * `--me-ai`：`v4`（默认）/ `v3` / `v1` / `none`。
 * 2026-11-25 加：要看"同一局面下三版各自怎么打"，就得能换 A 席的答题者——
 * 原来只硬编码 v4，出三份回放要改代码。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { applyAction } from '../src/core/rules.ts';
import { buildMatchReport } from '../src/core/report.ts';
import { DEFAULT_BUDGET, aiActionKey, AI_MAX_STEPS } from '../src/core/ai.ts';
import type { Action, GameState } from '../src/core/types.ts';
type LoggedAction = Action & { by: 'A' | 'B' };

const arg = (k: string, d = ''): string => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? (process.argv[i + 1] ?? d) : d;
};
const EXAM = arg('exam', 'S-013');
const ME_AI = arg('me-ai', 'v4');
const OUT = arg('out', `exams/${EXAM}/replay${ME_AI === 'v4' ? '' : `-${ME_AI}`}.json`);
const WINDOW = Number(arg('window', '16'));

type AiFn = (s: GameState, b: typeof DEFAULT_BUDGET, r: ReadonlySet<string>) => Action | null;
const foe = (await import('../src/core/ai.ts')).aiNextAction as unknown as AiFn;

/** 和 `exam-grade.ts` 的 `loadAi` 同一张表（多一处就多一个"跑出来的不是同一局"） */
async function loadAi(kind: string): Promise<AiFn | null> {
  if (kind === 'none') return null;
  if (kind === 'v3') return ((await import('../src/core/ai-v3.ts')) as { aiNextAction: AiFn }).aiNextAction;
  if (kind === 'v1') return ((await import('./baselines/ai-9efb961.ts')) as { aiNextAction: AiFn }).aiNextAction;
  if (kind === 'auto') return foe;
  if (kind === 'v4') return ((await import('../src/core/v4/ai-v4.ts')) as { aiNextAction: AiFn }).aiNextAction;
  throw new Error(`不认识这个答题者：${kind}（只有 v4/v3/v1/auto/none）`);
}
const meAi = await loadAi(ME_AI);
if (ME_AI === 'v4') ((await import('../src/core/v4/ai-v4.ts')) as { resetV4: () => void }).resetV4();

const snap = JSON.parse(readFileSync(`exams/${EXAM}/snap.json`, 'utf8')).state as GameState;
let s: GameState = JSON.parse(JSON.stringify(snap));
s.current = 'A' as never;

const actions: LoggedAction[] = [];
for (let t = 0; t < WINDOW && !s.winner; t++) {
  for (const who of ['A', 'B'] as const) {
    const rej = new Set<string>();
    const budget = { ...DEFAULT_BUDGET };
    for (let i = 0; i < AI_MAX_STEPS && !s.winner; i++) {
      const a = who === 'A' ? meAi?.(s, budget, rej) ?? null : foe(s, budget, rej);
      if (!a) break;
      const r = applyAction(s, a);
      if (!r.ok) {
        rej.add(aiActionKey(a));
        continue;
      }
      rej.clear();
      if (a.type === 'RECRUIT') budget.recruited += 1;
      actions.push({ ...a, by: who } as LoggedAction);
      s = r.state;
    }
    if (!s.winner) {
      const r = applyAction(s, { type: 'END_TURN' });
      if (!r.ok) break;
      actions.push({ type: 'END_TURN', by: who } as LoggedAction);
      s = r.state;
    }
  }
}

/* 手摆局面必须带上开局快照：回放靠 config+seed 重建不出这张图 */
const report = { ...buildMatchReport(s, new Date(), null, actions), initial: snap };
writeFileSync(OUT, JSON.stringify(report));
const squads = report.aiTrace?.squads?.length ?? 0;
console.log(`已写出：${OUT}`);
console.log(`A 席 ${ME_AI} · 回合 ${s.turn} · 动作 ${actions.length} 步 · v4 编队记录 ${squads} 条`);
