/**
 * 产出**带 v4 思考**的回放文件（报告格式，直接拖进游戏的「复盘」就能看）。
 *
 *   node --experimental-strip-types scripts/make-replay.ts --exam S-013 [--out exams/S-013/replay.json]
 *
 * 和 `exam-grade.ts` 用同一套驱动（v4 执 A、`auto` 执 B），区别只在于
 * **跑完把整局的 state 交给 `buildMatchReport`**——报告里的 `aiTrace.squads`
 * 就是 v4 每一手的编队（见 `ai-v4.ts` 的 `logSquads`）。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { applyAction } from '../src/core/rules.ts';
import { buildMatchReport } from '../src/core/report.ts';
import { aiNextActionV4, resetV4 } from '../src/core/v4/ai-v4.ts';
import { DEFAULT_BUDGET, aiActionKey, AI_MAX_STEPS } from '../src/core/ai.ts';
import type { Action, GameState } from '../src/core/types.ts';
type LoggedAction = Action & { by: 'A' | 'B' };

const arg = (k: string, d = ''): string => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? (process.argv[i + 1] ?? d) : d;
};
const EXAM = arg('exam', 'S-013');
const OUT = arg('out', `exams/${EXAM}/replay.json`);
const WINDOW = Number(arg('window', '16'));

const foe = (await import('../src/core/ai.ts')).aiNextAction as unknown as (
  s: GameState,
  b: typeof DEFAULT_BUDGET,
  r: Set<string>,
) => Action | null;

const snap = JSON.parse(readFileSync(`exams/${EXAM}/snap.json`, 'utf8')).state as GameState;
let s: GameState = JSON.parse(JSON.stringify(snap));
s.current = 'A' as never;
resetV4();

const actions: LoggedAction[] = [];
for (let t = 0; t < WINDOW && !s.winner; t++) {
  for (const who of ['A', 'B'] as const) {
    const rej = new Set<string>();
    const budget = { ...DEFAULT_BUDGET };
    for (let i = 0; i < AI_MAX_STEPS && !s.winner; i++) {
      const a = who === 'A' ? aiNextActionV4(s, budget, rej) : foe(s, budget, rej);
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
console.log(`回合 ${s.turn} · 动作 ${actions.length} 步 · v4 编队记录 ${squads} 条`);
