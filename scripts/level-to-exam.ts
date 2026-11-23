/**
 * 从**关卡**产一道题（快照 + 题卡 + 作者面板）。
 *
 * ── 为什么需要它 ──────────────────────────────────────────────
 *
 * 测试员是在游戏里打开关卡来答题的（`?exam=`），而判分器跑的是快照。
 * 如果两者不是同一次开局，就会出现"人打的那局金 61、判分那局金 0"——
 * 录下来的动作在判分时被引擎拒，谁也不知道为什么。
 *
 * 所以规矩是：**关卡是正本，快照从关卡生成**。`createMatch(level)` 出来什么就是什么，
 * 包括引擎给的开局金、逐席时代、AI 席位。别再用 scene 手算一份。
 *
 * 用法：
 *   node --experimental-strip-types scripts/level-to-exam.ts \
 *     --level levels-out/S-002.level.json --id S-002 [--ask "..."] [--dry]
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DEFAULT_CONFIG, createMatch } from '../src/core/setup.ts';
import { lintLevel } from '../src/core/level-lint.ts';
import type { LevelDef } from '../src/core/level.ts';
import type { PlayerId } from '../src/core/types.ts';
import { writeExam } from './lib/exam-kit.ts';

const argOf = (name: string, fallback = ''): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
};

const LEVEL = argOf('level');
const ID = argOf('id', 'X-000');
const ASK = argOf('ask', '这一回合你会怎么做？（最多 3 步，按顺序，每步一句为什么）');
const ME = (argOf('me', 'A').toUpperCase() === 'B' ? 'B' : 'A') as PlayerId;
const SEED = Number(argOf('seed', '1'));
const DRY = process.argv.includes('--dry');
if (!LEVEL) {
  console.error('用法：level-to-exam.ts --level levels-out/S-001.level.json --id S-001 [--ask "..."] [--dry]');
  process.exit(1);
}

const level = JSON.parse(readFileSync(resolve(LEVEL), 'utf8')) as LevelDef;
const issues = lintLevel(level);
for (const i of issues) console.log(`${i.severity === 'error' ? '✗' : '·'} ${i.text}`);
if (issues.some((i) => i.severity === 'error')) {
  console.error('关卡有错，先修关卡');
  process.exit(1);
}

/* `recordDetail` 打开：测试员那局的动作要能导出，判分器才有 `--answers` 可吃 */
const s = createMatch({ ...DEFAULT_CONFIG, level, recordDetail: true }, SEED);
s.current = ME;
s.aiControl = { A: false, B: false } as Record<PlayerId, boolean>;

const meUnits = s.units.filter((u) => u.owner === ME).length;
const foeUnits = s.units.filter((u) => u.owner !== ME).length;
const { panelFull } = writeExam({
  state: s,
  me: ME,
  id: ID,
  out: resolve(argOf('out', `exams/${ID}`)),
  ask: ASK,
  source: `关卡 \`${level.id}\`（\`${LEVEL}\`）· ${ME} 方 · 我 ${meUnits} 兵 / 敌 ${foeUnits} 兵`,
  note: `${ID}（关卡正本）：${ASK}`,
  fog: s.fog,
  dry: DRY,
});
if (DRY) {
  console.log(panelFull);
  process.exit(0);
}
console.log(`\n已写出：exams/${ID}/{snap.json, card.md, answer.md, author.md}`);
console.log(`局面：${s.w}×${s.h} · 我 ${meUnits} 兵 / 敌 ${foeUnits} 兵 · 金 ${s.players.A!.gold}/${s.players.B!.gold}`);
