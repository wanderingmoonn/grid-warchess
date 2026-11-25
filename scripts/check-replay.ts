/**
 * 回放文件自检：把"拖进复盘报错了"这件事说清楚。
 *
 * ── 为什么需要它 ─────────────────────────────────────────────
 *
 * 复盘那条路上只有两句话会弹给人看（"不是 JSON / 没有动作序列"、"只能走到第 N 步"），
 * 其余情况是**静默**的：文件能进、但走到第 5 步就对不上，或者终局和报告不一致。
 * 这两类问题在浏览器里看不出来，只会在拖动进度条时觉得"这局怎么不对劲"。
 *
 * 这个脚本用**和界面完全同一份代码**（`parseReplayFile` + `buildReplay`）把文件走一遍，
 * 把"为什么进不去 / 进得去但会停在哪儿"一次说清。它不改任何东西，只读。
 *
 * 用法：
 *   node --experimental-strip-types scripts/check-replay.ts exams/T-2-02/replay.json
 *   node --experimental-strip-types scripts/check-replay.ts --exam T-2-02   # 用题号简写
 */
import { readFileSync } from 'node:fs';
import { buildReplayFromText } from '../src/core/replay-file.ts';

const arg = (k: string, d = ''): string => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? (process.argv[i + 1] ?? d) : d;
};

const exam = arg('exam');
const path = exam ? `exams/${exam}/replay.json` : process.argv[2] ?? '';

if (!path) {
  console.error('用法：check-replay.ts <文件.json> 或 --exam <题号>');
  process.exit(2);
}

let text = '';
try {
  text = readFileSync(path, 'utf8');
} catch {
  console.error(`读不到文件：${path}`);
  process.exit(2);
}

console.log(`文件：${path}（${(text.length / 1024).toFixed(1)} KB）`);

const built = buildReplayFromText(text);
if (!built.ok) {
  console.log(`\n❌ 进不了复盘：${built.reason}`);
  process.exit(1);
}

const s = built.session;
const m = s.meta;
console.log('');
console.log(`✅ 能进复盘`);
console.log(`   局面      ${m.size}×${m.size} · ${m.players} 人 · 起始时代 ${m.startEra}`);
console.log(`   扩展      ${m.expansionsText}`);
console.log(`   种子      ${m.seed}`);
console.log(`   动作      ${s.actions.length} 步（报告声明 ${m.actionCount} 步 / ${m.declaredTurns} 回合）`);
console.log(`   真走通    ${s.applied} 步${s.applied < s.actions.length ? '  ← 没走完' : ''}`);
console.log(`   声明终局  ${m.declaredWinner ?? '未分胜负'}`);
console.log(`   实际终局  ${s.finalState.winner ?? '未分胜负'}`);
console.log(`   开局参数  ${m.exact ? '完整还原（文件里带 config）' : '按种子重建（缺 config，可能不准）'}`);

if (s.stopReason) console.log(`\n⚠️ 停在半路：${s.stopReason}`);
if (s.warnings.length > 0) {
  console.log(`\n⚠️ 提醒 ${s.warnings.length} 条：`);
  for (const w of s.warnings) console.log(`   · ${w}`);
}
if (s.finalMatches === false) console.log('\n⚠️ 走完了，但终局和报告对不上——这份回放到后面已经不是当时那一局了。');

const bad = !s.stopReason && s.warnings.length === 0 && s.finalMatches !== false;
console.log(bad ? '\n结论：这份回放是干净的。' : '\n结论：能放，但有上面那些问题。');
