/**
 * 把游戏里「导出动作」抄出来的那一段，转成判分器认的 `--answers` 格式。
 *
 * ── 为什么需要这一层 ──────────────────────────────────────────
 *
 * 游戏导出的是一串**按时间排的**动作（AI 的、人的、还有 `END_TURN` 混在一起）；
 * 判分器要的是**按回合分组、只管某一方**的动作。两个形状不一样，
 * 中间必须有一次转换，否则 `--answers` 永远用不上，"人的答案必须绿"也就验不了。
 *
 * 输入（游戏「设置 → 导出动作」复制出来的）：
 * ```json
 * { "kind": "exam-actions", "exam": "level:s-001",
 *   "actions": [ {"type":"MOVE","unitId":"u12","x":4,"y":6,"by":"A"}, …, {"type":"END_TURN","by":"A"} ] }
 * ```
 *
 * 输出（判分器的 `--answers`）：
 * ```json
 * { "me": "A", "turns": [ [ {"type":"MOVE",…} ], [] ] }
 * ```
 * `END_TURN` 会被去掉——判分器在每个回合末尾自己补一个。
 * 空回合保留成 `[]`，否则回合序号会错位（第 3 手会吃到第 2 手的答案）。
 *
 * 用法：
 *   node --experimental-strip-types scripts/actions-to-answers.ts \
 *     --in ~/Downloads/xxx.json --me A --out answers/Y-002.answers.json
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { PlayerId } from '../src/core/types.ts';

const argOf = (name: string, fallback = ''): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
};

const IN = argOf('in');
const ME = (argOf('me', 'A').toUpperCase() === 'B' ? 'B' : 'A') as PlayerId;
const OUT = argOf('out');
if (!IN) {
  console.error('用法：actions-to-answers.ts --in <导出的动作.json> [--me A] [--out answers/x.json]');
  process.exit(1);
}

type Step = Record<string, unknown> & { type?: string; by?: PlayerId };

const raw = JSON.parse(readFileSync(resolve(IN), 'utf8')) as {
  kind?: string;
  exam?: string | null;
  seed?: number;
  actions?: Step[];
};
if (!Array.isArray(raw.actions)) {
  console.error('这个文件里没有 `actions` —— 请用游戏里「设置 → 导出动作」复制出来的那份');
  process.exit(1);
}

const turns: Step[][] = [];
let cur: Step[] = [];
let dropped = 0;
for (const a of raw.actions) {
  if (a.by && a.by !== ME) {
    // 对手的步骤不进答案；但对手的 END_TURN 也不该切我方的回合
    if (a.type === 'END_TURN') continue;
    continue;
  }
  if (!a.by) dropped += 1;
  if (a.type === 'END_TURN') {
    turns.push(cur);
    cur = [];
    continue;
  }
  const { by, ...rest } = a;
  void by;
  cur.push(rest as Step);
}
if (cur.length > 0) turns.push(cur);

const out = {
  me: ME,
  ...(raw.exam ? { exam: raw.exam } : {}),
  ...(raw.seed !== undefined ? { seed: raw.seed } : {}),
  turns,
};
const text = JSON.stringify(out, null, 2);

console.log(`题目：${raw.exam ?? '（没写）'}`);
console.log(`我方回合数：${turns.length} · 动作数：${turns.reduce((n, t) => n + t.length, 0)}`);
console.log(`执行回合：${turns.map((t) => t.length).join(' / ')}`);
if (dropped > 0) console.log(`⚠️ 有 ${dropped} 步没有 \`by\`（旧格式？），按我方算了`);

if (OUT) {
  const p = resolve(OUT);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
  console.log(`已写出：${p}`);
  console.log('下一步：exam-grade.ts --exam <题目目录> --answers ' + OUT);
} else {
  console.log('\n--- 下面是 --answers 能直接吃的内容 ---');
  console.log(text);
}
