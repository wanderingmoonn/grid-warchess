/**
 * 重放一份带动作序列的报告（v3 起）。
 *
 * 这是"数据能不能用来优化 AI"的分水岭：没有动作序列，只能算比例；
 * 有了它，一局真实对局可以在本地逐帧重建，输掉的那一手能定位到具体步数。
 *
 * 用法：
 *   node --experimental-strip-types scripts/replay-report.ts reports/x.json
 *   node --experimental-strip-types scripts/replay-report.ts reports/x.json --until 320
 *
 * `--until N`：只放前 N 步就停（定位"从第几步开始不对劲"时用）。
 *
 * 校验口径：重放结束时的胜者与行动数必须和报告一致；不一致时打出**第一个**
 * 被拒或对不上的步号，并说明它是什么动作。
 */
import { readFileSync } from 'node:fs';
import { applyAction } from '../src/core/rules.ts';
import { createMatch, DEFAULT_CONFIG } from '../src/core/setup.ts';
import type { Action, MatchConfig } from '../src/core/types.ts';
import type { MatchReport } from '../src/core/report.ts';

const file = process.argv[2];
if (!file) {
  console.error('用法：replay-report.ts <report.json> [--until N]');
  process.exit(1);
}
const between = (flag: string): number | null => {
  const i = process.argv.indexOf(flag);
  return i > 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : null;
};
const until = between('--until');

const rep = JSON.parse(readFileSync(file, 'utf8')) as MatchReport;
if (!rep.actions || rep.actions.length === 0) {
  console.error('这份报告没有动作序列（v' + rep.v + '，或开局没勾"上传详细数据"）。');
  process.exit(1);
}
if (rep.actionsDropped) {
  console.warn(`注意：报告里有 ${rep.actionsDropped} 步因为超过上限被丢弃，重放只能到被截断的位置。`);
}

const cfg: MatchConfig = {
  ...DEFAULT_CONFIG,
  size: rep.board.w,
  startEra: rep.startEra,
  expansionIds: [...rep.expansions],
  playerCount: (rep.playerCount === 3 || rep.playerCount === 4 ? rep.playerCount : 2) as MatchConfig['playerCount'],
  aiLevel: (rep.ai?.level ?? 'advanced') as MatchConfig['aiLevel'],
  aiOpponent: rep.ai?.opponent === true,
  aiAlly: rep.ai?.ally === true,
  commanderMode: rep.ai?.commander === true,
  godMode: rep.ai?.godMode === true,
  // 详细记录开关本身不影响规则，但 createMatch 会据它决定要不要挂记录器
  recordDetail: false,
};

let s = createMatch(cfg, rep.seed);
const limit = until ?? rep.actions.length;
let applied = 0;
for (let i = 0; i < Math.min(limit, rep.actions.length); i += 1) {
  const a = rep.actions[i] as Action;
  const r = applyAction(s, a);
  if (!r.ok) {
    console.error(`第 ${i + 1} 步被拒：${JSON.stringify(a)}\n  原因：${r.reason}\n  重放到此为止（局面：第 ${s.turn} 步，轮到 ${s.current}）`);
    process.exit(2);
  }
  s = r.state;
  applied += 1;
}

console.log(`重放 ${applied}/${rep.actions.length} 步 · 局面到第 ${s.turn} 步 · 轮到 ${s.current}`);
console.log(`  胜者：重放 ${s.winner ?? '平'} / 报告 ${rep.winner ?? '平'} ${s.winner === rep.winner ? '✓' : '✗ 对不上'}`);
console.log(`  行动数：重放 ${s.turn} / 报告 ${rep.turns} ${s.turn === rep.turns ? '✓' : '✗ 对不上'}`);
const sides = rep.sides.map((x) => {
  const mine = s.cities.filter((c) => c.owner === x.side);
  const units = s.units.filter((u) => u.owner === x.side && s.unitTypes[u.type]?.category !== 'building');
  return `  ${x.side} 席：城 ${mine.length}/${x.cities} · 兵 ${units.length}/${x.units}`;
});
console.log(sides.join('\n'));
if (s.winner !== rep.winner || s.turn !== rep.turns) process.exit(2);
