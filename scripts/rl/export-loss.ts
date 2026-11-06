/**
 * 导出两局**策略输掉的对局**（同一张图上一短一长），格式和"结束后上传"那份一样，
 * 拖回游戏里就能逐帧复盘。
 *
 * ── 为什么要"输的" ──────────────────────────────────────────────────────
 *
 * `export-win.ts` 端出来的是"它怎么赢的"，看多了会以为它只有那一套。
 * 真正需要复盘的是输的那几局：是开局就被压死在城里，还是拖到两百回合被耗死。
 * 所以这里挑**回合数最短**与**最长**各一局——两头分别是"崩得快"和"输得慢"，
 * 中间那种"打得有来有回最后一手失误"反倒最难从一局里看出规律。
 *
 * ── 口径 ────────────────────────────────────────────────────────────────
 *
 * 1. 对手是**手写引擎**（`aiLevel` 默认 advanced），且 `aiHandicap = 0`——不削弱，
 *    这是"真打"，不是训练时的课程。
 * 2. 座位交替（同 `eval.ts`）：同一颗种子打两局、座位互换，避免导出的永远是"先手怎么输"。
 * 3. 平局不算输：`winner === null`（撞回合上限）不进候选——那不是战败，是没打完。
 * 4. 写两份：`docs/replays/` 进版本库留档；`public/replays/` 打进站点，线上可直接下载。
 *
 * 用法：
 *   node --experimental-strip-types scripts/rl/export-loss.ts \
 *        --weights .tmp/mix1/weights-12.json --size 12 --games 120 --seed0 2000
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { TRAIN } from './config.ts';
import { Policy, weightsFromJson } from './policy.ts';
import { playMatch } from './play.ts';
import { buildMatchReport } from '../../src/core/report.ts';
import type { Action, PlayerId } from '../../src/core/types.ts';

const args = process.argv.slice(2);
const argOf = (name: string, dflt: string): string => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? (args[i + 1] as string) : dflt;
};

const WEIGHTS = argOf('weights', path.join('scripts', 'rl', 'weights', 'v2-specialist.json'));
const SIZE = Number(argOf('size', '12'));
const GAMES = Number(argOf('games', '120'));
const SEED0 = Number(argOf('seed0', '2000'));
const CAP = Number(argOf('cap', String(TRAIN.capTurns)));
const OUT_DIR = argOf('out-dir', path.join('docs', 'replays'));
const PUBLIC_DIR = argOf('public-dir', path.join('public', 'replays'));
const TAG = argOf('tag', 'v2');

const rawText = fs.readFileSync(WEIGHTS, 'utf8');
const rawJson = JSON.parse(rawText) as { version?: number };
const policy = new Policy(weightsFromJson(rawJson));
/** 权重指纹：同一份权重换个文件名也认得出来，写进索引里当"V2 版本" */
const weightSha = crypto.createHash('sha256').update(rawText).digest('hex').slice(0, 12);
const weightName = path.basename(WEIGHTS).replace(/\.json$/, '');

/** 和 eval.ts 一样的配对：同一颗种子两局，座位互换 */
const seatOf = (index: number): PlayerId => (index & 1 ? 'B' : 'A');

interface Candidate {
  seed: number;
  seat: PlayerId;
  turns: number;
  steps: number;
  winner: PlayerId;
  report: ReturnType<typeof buildMatchReport>;
}

const losses: Candidate[] = [];
/** 顺手记一下总量：光给两局文件，读者没法判断"这是常态还是个例" */
let wins = 0;
let draws = 0;

for (let i = 0; i < GAMES; i++) {
  const seed = SEED0 + (i >> 1);
  const seat = seatOf(i);
  const actions: Action[] = [];

  const outcome = playMatch({
    seed,
    size: SIZE,
    drivers:
      seat === 'A'
        ? [{ kind: 'policy', policy }, { kind: 'ai' }]
        : [{ kind: 'ai' }, { kind: 'policy', policy }],
    expansionIds: TRAIN.expansions,
    aiLevel: TRAIN.aiLevel,
    aiHandicap: 0,
    capTurns: CAP,
    onStep: (info) => {
      actions.push(info.action);
    },
  });

  // 只收"真的输了"：平局（winner null）不是战败
  if (!outcome.winner || outcome.winner === seat) {
    if (!outcome.winner) draws += 1;
    else wins += 1;
    if (i % 20 === 0) process.stderr.write(`  ${i + 1}/${GAMES} 局…（已收 ${losses.length} 局败局）\n`);
    continue;
  }

  losses.push({
    seed,
    seat,
    turns: outcome.turns,
    steps: actions.length,
    winner: outcome.winner,
    report: buildMatchReport(outcome.finalState, new Date(), null, actions),
  });

  // 不提前收工：一短一长应当是"这批样本里的两端"，攒到一半就停会让这两个数没有参照
  if (i % 10 === 9) process.stderr.write(`  ${i + 1}/${GAMES} 局…（已收 ${losses.length} 局败局）\n`);
}

if (losses.length === 0) {
  console.error(
    `${GAMES} 局里一局没输（种子 ${SEED0} 起、${SIZE}×${SIZE}、对手 advanced 不削弱）。` +
      '这个组合下策略大概太强了，换更大的 --games 或者换一份权重。',
  );
  process.exit(1);
}

const short = losses.reduce((a, b) => (b.turns < a.turns ? b : a));
const long = losses.reduce((a, b) => (b.turns > a.turns ? b : a));

const stamp = new Date().toISOString().slice(0, 10);
const write = (c: Candidate, tag: string): string => {
  const name = `${TAG}-loss-${stamp}-${SIZE}x${SIZE}-${tag}-${c.turns}turn-seed${c.seed}-${c.seat}.json`.replace(
    /[^\w.-]/g,
    '',
  );
  const text = JSON.stringify(c.report, null, 2);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, name), text);
  fs.mkdirSync(PUBLIC_DIR, { recursive: true });
  fs.writeFileSync(path.join(PUBLIC_DIR, name), text);
  return name;
};

const shortFile = write(short, 'short');
const longFile = write(long, 'long');

const line = (c: Candidate, file: string) =>
  `| ${c.seed} · ${c.seat} 座 | ${SIZE}×${SIZE} | ${c.turns} | ${c.steps} | ${c.winner} 座（老 AI）胜 | \`${file}\` |`;

/*
 * 索引写一份在旁边。
 *
 * 报告文件里带 config（尺寸 / 时代 / 扩展 / AI 档位），但**没有**"这是哪个版本的策略"——
 * 权重是一份外部 json，报告里一个字都不会提。而复盘时最要紧的问题恰恰是
 * "这局是哪个 V2 输的"。所以把权重名、版本号、指纹，和复现参数一起落在这份 md 里，
 * 免得三天后只能靠文件名猜。
 */
const indexFile = path.join(OUT_DIR, `${TAG}-loss-${stamp}.md`);
fs.mkdirSync(OUT_DIR, { recursive: true });
/** 本机时间（`toISOString` 是 UTC，落进文档里会差 8 小时，读的人只会以为跑在半夜） */
const nowLocal = new Date();
const pad = (n: number) => String(n).padStart(2, '0');
const localStamp =
  `${nowLocal.getFullYear()}-${pad(nowLocal.getMonth() + 1)}-${pad(nowLocal.getDate())} ` +
  `${pad(nowLocal.getHours())}:${pad(nowLocal.getMinutes())}`;
fs.writeFileSync(
  indexFile,
  [
    `# V2 战败复盘 · ${SIZE}×${SIZE}`,
    '',
    `生成于 ${localStamp}（本机时间），种子 ${SEED0} 起、共 ${GAMES} 局成对样本（同种子两局、座位互换）：` +
      `V2 胜 ${wins} / 平 ${draws} / **负 ${losses.length}**（平局＝撞 ${CAP} 回合上限，不算战败）。`,
    '',
    '| 对局标识（种子 · 座位） | 尺寸 | 总回合 | 步数 | 结果 | 文件 |',
    '|---|---|---|---|---|---|',
    line(short, shortFile),
    line(long, longFile),
    '',
    '## 双方版本',
    '',
    `- **V2（策略网络）**：\`${weightName}.json\` · WEIGHTS_VERSION ${rawJson.version} · ` +
      `sha256 \`${weightSha}\` · 观测 221 维 / 动作 62 维`,
    `- **老 AI（手写引擎）**：\`${TRAIN.aiLevel}\` 档 · **不削弱**（\`aiHandicap = 0\`，每一步都按它自己的判断走）`,
    '',
    '## 复现参数',
    '',
    `尺寸 ${SIZE}×${SIZE} · 起始时代 ${TRAIN.startEra} · 扩展 ${TRAIN.expansions.join(' / ') || '（无）'} · ` +
      `回合上限 ${CAP} · 迷雾关（训练口径 \`fog = false\`）· 每回合最多 50 步`,
    '',
    '## 怎么复盘',
    '',
    '把这个 json 拖进游戏页面（或首页点「复盘」选文件），进度条按步、`←` `→` 步进、空格播放。',
    '',
    `复现命令：\`node --experimental-strip-types scripts/rl/export-loss.ts --weights ${WEIGHTS} ` +
      `--size ${SIZE} --games ${GAMES} --seed0 ${SEED0}\`（同一份权重 → 同样这两局）。`,
    '',
  ].join('\n'),
);

console.log(
  `\n权重：${weightName}（WEIGHTS_VERSION ${rawJson.version}，sha256 ${weightSha}）` +
    ` · 对手：手写引擎 ${TRAIN.aiLevel} · 不削弱 · ${GAMES} 局成对样本：` +
    `V2 胜 ${wins} / 平 ${draws} / 负 ${losses.length}`,
);
console.log('\n| 对局标识（种子 · 座位） | 尺寸 | 回合 | 步数 | 结果 | 文件 |');
console.log('|---|---|---|---|---|---|');
console.log(line(short, shortFile));
console.log(line(long, longFile));
console.log(`\n  短局 → ${path.join(OUT_DIR, shortFile)}`);
console.log(`  长局 → ${path.join(OUT_DIR, longFile)}`);
console.log(`  索引 → ${indexFile}`);
