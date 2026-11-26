/**
 * **实战回放导出**：跑一局 v4 的随机图对局，把整局录成能拖进游戏「复盘」的文件。
 *
 * `v4-duel.ts` 只出数字（胜负 / 终局快照），看不到"第几手开始掉城、当时场上几个兵"。
 * 这个脚本补那一半：同一套驱动，额外做三件事——
 *
 *   1. **录动作**（带 `by`），交给 `buildMatchReport` 写成报告；
 *   2. **每手采一行曲线**（双方城血 / 战斗兵 / 金 / 桥），另存 `.curve.txt`；
 *   3. **自己先验一遍**：写完立刻 `buildReplayFromText` 把报告重放一遍，
 *      走不通就当场报错——不然拖进游戏才发现对不上，白看。
 *
 * 用法：
 *
 *   node --experimental-strip-types scripts/v4-duel-replay.ts \
 *     --seed 900 --era 3 --size 12 --cap 160 --style random --out replays/v4/快检-900
 *
 *   --v4-side B       v4 执后手（默认 A 先手）
 *   --foe v3          对手换 v3（默认冻结的旧 AI）
 *   --symmetry mirror 镜像图（自对弈用）
 *   --foe v4          v4 自己打自己
 *
 * 每局一条命：`resetV4()` 必须调，否则跨局会命中上一局的缓存（见 `v4-duel.ts`）。
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { applyAction, utype } from '../src/core/rules.ts';
import { DEFAULT_CONFIG, createMatch } from '../src/core/setup.ts';
import type { Action, GameState, PlayerId } from '../src/core/types.ts';
import { AI_MAX_STEPS, DEFAULT_BUDGET, aiActionKey } from '../src/core/ai.ts';
import { buildMatchReport, type LoggedAction } from '../src/core/report.ts';
import { buildReplayFromText } from '../src/core/replay-file.ts';
import { resetV4, aiNextAction as v4Next } from '../src/core/v4/ai-v4.ts';

const args = process.argv.slice(2);
const argOf = (name: string, dflt: string): string => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? (args[i + 1] as string) : dflt;
};

const SEED = Number(argOf('seed', '900'));
const ERA = Number(argOf('era', '3'));
const SIZE = Number(argOf('size', String(DEFAULT_CONFIG.size)));
const CAP = Number(argOf('cap', '160'));
const STYLE = argOf('style', 'random');
const SYMMETRY = argOf('symmetry', 'fair') as 'fair' | 'mirror';
const V4_SIDE = (argOf('v4-side', 'A') === 'B' ? 'B' : 'A') as PlayerId;
const FOE = argOf('foe', 'old');
const OUT = argOf('out', `replays/v4/era${ERA}-${SIZE}x${SIZE}-${STYLE}-seed${SEED}-v4${V4_SIDE}.json`);

type AiFn = (s: GameState, b: typeof DEFAULT_BUDGET, r: ReadonlySet<string>) => Action | null;
const FOE_FILE = FOE === 'v3' ? '../src/core/ai-v3.ts' : FOE === 'v4' ? '../src/core/v4/ai-v4.ts' : './baseline-ai.ts';
const foeNext = (await import(FOE_FILE)).aiNextAction as unknown as AiFn;

const cityHpOf = (s: GameState, owner: PlayerId): number =>
  s.cities.filter((c) => c.owner === owner).reduce((n, c) => n + (c.ruined ? 0 : c.hp), 0);
const combatOf = (s: GameState, owner: PlayerId): number =>
  s.units.filter((u) => u.owner === owner && utype(s, u.type).category === 'combat').length;
const bridgeOf = (s: GameState, owner: PlayerId): number =>
  s.units.filter((u) => u.owner === owner && (utype(s, u.type).bridges ?? false)).length;

/* ── 开一局 ─────────────────────────────────────────────── */
resetV4();
let s: GameState = createMatch({ ...DEFAULT_CONFIG, startEra: ERA, size: SIZE, mapSymmetry: SYMMETRY, mapStyle: STYLE as never }, SEED);

const foe: PlayerId = V4_SIDE === 'A' ? 'B' : 'A';
const actions: LoggedAction[] = [];
const curve: string[] = [];
const startHp = { mine: cityHpOf(s, V4_SIDE), foe: cityHpOf(s, foe) };
let firstHurt: number | null = null;

const sample = (): void => {
  curve.push(
    `${String(s.turn).padStart(3, ' ')} 城 ${cityHpOf(s, V4_SIDE)}/${cityHpOf(s, foe)}` +
      ` 兵 ${combatOf(s, V4_SIDE)}/${combatOf(s, foe)}` +
      ` 金 ${Math.round(s.players[V4_SIDE]?.gold ?? 0)}/${Math.round(s.players[foe]?.gold ?? 0)}` +
      ` 桥 ${bridgeOf(s, V4_SIDE)}`,
  );
};

sample();
while (!s.winner && s.turn <= CAP) {
  const who = s.current;
  const ai: AiFn = who === V4_SIDE ? (v4Next as unknown as AiFn) : foeNext;
  const budget = { ...DEFAULT_BUDGET };
  const rejected = new Set<string>();
  const moveTries = new Map<string, number>();
  for (let i = 0; i < AI_MAX_STEPS && !s.winner; i++) {
    const a = ai(s, budget, rejected);
    if (!a) break;
    const r = applyAction(s, a);
    if (!r.ok) {
      /* MOVE 被友军占格时下一步可能就合法（同 v4-duel 口径） */
      if (a.type === 'MOVE' && 'unitId' in a) {
        const uid = String((a as { unitId?: string }).unitId ?? '');
        const n = (moveTries.get(uid) ?? 0) + 1;
        moveTries.set(uid, n);
        if (n < 2) continue;
      }
      rejected.add(aiActionKey(a));
      continue;
    }
    rejected.clear();
    if (a.type === 'RECRUIT') budget.recruited += 1;
    if (a.type === 'UPGRADE') budget.upgraded += 1;
    actions.push({ ...a, by: who } as LoggedAction);
    s = r.state;
  }
  if (s.winner) break;
  const r = applyAction(s, { type: 'END_TURN' });
  if (!r.ok) break;
  actions.push({ type: 'END_TURN', by: who } as LoggedAction);
  s = r.state;
  if (firstHurt === null && cityHpOf(s, V4_SIDE) < startHp.mine) firstHurt = s.turn;
  sample();
}

/* 最后一手可能停在半路（城塌了就结束，没走完 END_TURN），补一条终局采样 */
if (curve.length === 0 || !curve[curve.length - 1]!.startsWith(String(s.turn).padStart(3, ' '))) sample();

/* ── 写报告 + 自检 ───────────────────────────────────────── */
const report = buildMatchReport(s, new Date(), null, actions);
mkdirSync(dirname(OUT), { recursive: true });
const text = JSON.stringify(report);
writeFileSync(OUT, text);

/* 曲线另存一份：复盘窗口里看不到"第几手掉的城"，这张表补它 */
writeFileSync(
  OUT.replace(/\.json$/i, '.curve.txt'),
  [
    `seed=${SEED} era=${ERA} ${SIZE}×${SIZE} style=${STYLE} symmetry=${SYMMETRY} v4=${V4_SIDE} foe=${FOE} cap=${CAP}`,
    `终局：${s.winner === null ? '平' : s.winner === V4_SIDE ? 'v4 胜' : 'v4 负'} · ${s.turn} 手`,
    `我方城第一次掉血：${firstHurt === null ? '没有' : `第 ${firstHurt} 手`}`,
    '手  城(我/敌)  兵(我/敌)  金(我/敌)  桥',
    ...curve,
  ].join('\n') + '\n',
);

/* 自检：把刚写出去的报告按回放路径重放一遍，必须一步不差地走到同一终局 */
const built = buildReplayFromText(text);
if (!built.ok) {
  console.error(`✗ 回放自检失败：${built.reason}`);
  process.exit(1);
}
if (built.session.applied !== actions.length) {
  console.error(`✗ 回放自检失败：录了 ${actions.length} 步，只走通 ${built.session.applied} 步`);
  process.exit(1);
}
if (built.session.finalMatches === false) {
  console.error('✗ 回放自检失败：重放出来的终局和报告不一致');
  process.exit(1);
}

console.log(`已写出：${resolve(OUT)}`);
console.log(
  `${SIZE}×${SIZE} era${ERA} ${STYLE}/${SYMMETRY} seed=${SEED} v4=${V4_SIDE} → ` +
    `${s.winner === null ? '平' : s.winner === V4_SIDE ? 'v4 胜' : 'v4 负'} · ${s.turn} 手 · ${actions.length} 步`,
);
console.log(
  `终局：城 ${cityHpOf(s, V4_SIDE)}/${cityHpOf(s, foe)} · 兵 ${combatOf(s, V4_SIDE)}/${combatOf(s, foe)}` +
    ` · 金 ${Math.round(s.players[V4_SIDE]?.gold ?? 0)} · 桥 ${bridgeOf(s, V4_SIDE)}` +
    ` · 城第一次掉血 ${firstHurt === null ? '没有' : `第 ${firstHurt} 手`}`,
);
console.log(`回放自检：${actions.length} 步全走通，终局一致`);
