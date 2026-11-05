/**
 * 导出一局**策略赢下来的对局**，格式和"结束后上传"那份报告一样——
 * 于是它能直接拖回游戏里逐帧复盘。
 *
 * ── 为什么要专门做个工具 ────────────────────────────────────────────────
 *
 * "它现在下成什么样"这件事，看胜率看不出来。31.3% 只说明赢了几局，
 * 说明不了"它靠什么赢的"——是趁对面发展时压死，还是守到对面撞墙。
 * 这个工具把那一局**原样端出来**，谁都能拖进复盘里看第 37 步发生了什么。
 *
 * ── 三个刻意的口径 ──────────────────────────────────────────────────────
 *
 * 1. **对手不削弱**（`aiHandicap = 0`）。这是"真打"，不是训练时的课程。
 * 2. **座位交替**：和 `eval.ts` 的配对口径一致（同一颗种子打两局、座位互换），
 *    否则导出来的永远是"先手怎么赢"，而先手在这游戏里本来就占便宜。
 * 3. **写两份**：`docs/replays/` 进版本库留档；`public/replays/` 会被打进站点，
 *    于是线上也能直接下载——玩家不用碰仓库就能拿到那份文件。
 *
 * 用法：
 *   node --experimental-strip-types scripts/rl/export-win.ts \
 *        --weights scripts/rl/weights/v2-specialist.json --games 200 --seed0 1000
 *   ... --intent rush          # 也可以指定意图，导一局"按口令打赢的"
 */
import fs from 'node:fs';
import path from 'node:path';

import { TRAIN } from './config.ts';
import { Policy, weightsFromJson } from './policy.ts';
import { playMatch } from './play.ts';
import { buildMatchReport, reportFileName } from '../../src/core/report.ts';
import { INTENT_NAMES, type Intent } from './features.ts';
import type { Action, PlayerId } from '../../src/core/types.ts';

const args = process.argv.slice(2);
const argOf = (name: string, dflt: string): string => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? (args[i + 1] as string) : dflt;
};

const WEIGHTS = argOf('weights', path.join('scripts', 'rl', 'weights', 'v2-specialist.json'));
const GAMES = Number(argOf('games', '200'));
const SEED0 = Number(argOf('seed0', '1000'));
const OUT_DIR = argOf('out-dir', path.join('docs', 'replays'));
const PUBLIC_DIR = argOf('public-dir', path.join('public', 'replays'));
const INTENT = argOf('intent', 'auto') as Intent;
const CAP = Number(argOf('cap', String(TRAIN.capTurns)));
/**
 * 攒够几局胜局再挑一局导出。
 *
 * 为什么不"赢一局就交差"：一百多个回合的拉锯虽然也是赢，但拿来回看太累——
 * 玩家拖两百下进度条才看见一次交手。攒几局之后挑**步数最少**的那一局，
 * 通常就是"趁对面还没成型就压死"的那种，复盘价值最高。
 */
const WANT = Math.max(1, Number(argOf('wins', '3')));

if (!(INTENT_NAMES as string[]).includes(INTENT)) {
  throw new Error(`--intent 只能是 ${INTENT_NAMES.join(' / ')}`);
}

const policy = new Policy(weightsFromJson(JSON.parse(fs.readFileSync(WEIGHTS, 'utf8'))));
policy.intent = INTENT;

/** 和 eval.ts 一样的配对：同一颗种子两局，座位互换 */
function seatOf(index: number): PlayerId {
  return index & 1 ? 'B' : 'A';
}

let wins = 0;
let played = 0;
/** 候选：攒几局胜局，最后挑步数最少的那一局 */
let best: { report: ReturnType<typeof buildMatchReport>; steps: number; seed: number; seat: PlayerId; turns: number } | null =
  null;

for (let i = 0; i < GAMES; i++) {
  const seed = SEED0 + (i >> 1);
  const seat = seatOf(i);
  const actions: Action[] = [];

  const outcome = playMatch({
    seed,
    drivers:
      seat === 'A'
        ? [{ kind: 'policy', policy }, { kind: 'ai' }]
        : [{ kind: 'ai' }, { kind: 'policy', policy }],
    expansionIds: TRAIN.expansions,
    aiLevel: TRAIN.aiLevel,
    aiHandicap: 0, // 不削弱：这是"真打"
    capTurns: CAP,
    onStep: (info) => {
      actions.push(info.action);
    },
  });
  played += 1;

  if (outcome.winner !== seat) {
    if (i % 20 === 0) process.stderr.write(`  ${i + 1}/${GAMES} 局…\n`);
    continue;
  }
  wins += 1;
  const report = buildMatchReport(outcome.finalState, new Date(), null, actions);
  const kb = Buffer.byteLength(JSON.stringify(report), 'utf8') / 1024;
  console.log(
    `  第 ${wins} 局胜局：种子 ${seed} · 座位 ${seat} · ${outcome.turns} 回合 · ${actions.length} 步 · ${kb.toFixed(1)} KB`,
  );
  if (!best || actions.length < best.steps) best = { report, steps: actions.length, seed, seat, turns: outcome.turns };
  if (wins >= WANT) break;
}

if (!best) {
  console.error(`${played} 局里一局没赢（种子 ${SEED0} 起）。要么权重还不够，要么把 --games 加大。`);
  process.exit(1);
}

// 攒够了：写步数最少的那一局
const name = reportFileName(best.report).replace(/^warchess-/, 'v2-win-');
const text = JSON.stringify(best.report, null, 2);
fs.mkdirSync(OUT_DIR, { recursive: true });
const outFile = path.join(OUT_DIR, name);
fs.writeFileSync(outFile, text);
// 打进站点的副本：线上直接下载，不用碰仓库
fs.mkdirSync(PUBLIC_DIR, { recursive: true });
fs.writeFileSync(path.join(PUBLIC_DIR, name), text);

console.log(
  `\n选中：种子 ${best.seed} · 座位 ${best.seat} · ${best.turns} 回合 · ${best.steps} 步` +
    `（${played} 局里赢了 ${wins} 局，胜率 ${((wins / played) * 100).toFixed(1)}%）`,
);
console.log(`  报告 → ${outFile}`);
console.log(`  线上 → /replays/${name}`);
