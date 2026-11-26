/**
 * **兵线体检（W1.5 读数）**：把"投送"变成一张能横着看的表。
 *
 * ── 为什么需要它 ──────────────────────────────────────────────
 *
 * W1 只有 `V4_LANE_LOG=1` 一行一行的日志，看一道题还行，看 34 道题就没人读了。
 * 但"v4 投送到底有多差"这个问题必须**横着比**：多少题开过第二波、多少题断过档、
 * 断了几手、交换账是正是负。这个脚本把每次跑完时记忆里的批次 / 断档 /
 * 交换账抽出来，排成一张表。
 *
 * ── 口径（都在 `docs/DESIGN-LANES-WAVES` §3）────────────────
 *
 *   · **批**：一波 = 一批人。开过几批 / 并进前线几批 / 打光几批 / 撤回几批；
 *   · **到人**：这些批累计把几个人送进了前线（按人去重）；
 *   · **断档**：前线 0 人、路上 0 人（连续几手会累加，这里看累计/最长）；
 *   · **交换**：全图 6 手窗口的金币账（赚 / 亏）。
 *
 * 它**不判红绿**——判据还是 `exam-grade` 的事。这里只看"送得怎么样"。
 *
 * 用法：
 *   node --experimental-strip-types scripts/lane-report.ts
 *   ... --turns 40                       # 只看前 40 个玩家手
 *   ... --exams S-000,S-001,P-1-01       # 只看几道
 *
 * ⚠️ 一局换一个进程才干净（v4 入口有模块级缓存），所以这里每局开头 `resetV4()`。
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { applyAction } from '../src/core/rules.ts';
import { AI_MAX_STEPS, DEFAULT_BUDGET, aiActionKey } from '../src/core/ai.ts';
import type { GameState, PlayerId } from '../src/core/types.ts';
import type { V4Memory } from '../src/core/v4/types.ts';
import { ACTIVE } from './lib/exam-list.ts';

type AiFn = (s: GameState, b: typeof DEFAULT_BUDGET, r: ReadonlySet<string>) => ReturnType<
  typeof import('../src/core/ai.ts')['aiNextAction']
>;

const argOf = (name: string, fallback = ''): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
};

const TURNS = Number(argOf('turns', '24')) || 24;
const ONLY = argOf('exams', '')
  .split(',')
  .map((x) => x.trim())
  .filter(Boolean);
const LIST = ONLY.length > 0 ? ONLY : [...ACTIVE];

const v4 = ((await import('../src/core/v4/ai-v4.ts')) as { aiNextAction: AiFn; resetV4: () => void }).aiNextAction;
const resetV4 = ((await import('../src/core/v4/ai-v4.ts')) as { resetV4: () => void }).resetV4;
const auto = ((await import('../src/core/ai.ts')) as { aiNextAction: AiFn }).aiNextAction;

interface Row {
  exam: string;
  turns: number;
  batches: number;
  sent: number;
  merged: number;
  wiped: number;
  withdrawn: number;
  gone: number;
  /** 有一批打光之后、是否还有新的批上路（"死了有没有接上"） */
  refill: boolean;
  /** 编进来的总人数（各批 man 之和） */
  men: number;
  /** 其中"成批"的个数（≥4 人；1~2 人的按滴灌看） */
  groups: number;
  arrived: number;
  gapTotal: number;
  gapWorst: number;
  noFront: number;
  gain: number;
  loss: number;
  meCities: number;
  foeCities: number;
}

/** 一方走一回合，和 `exam-grade` 同一套（AI 或空壳） */
function aiTurn(s: GameState, ai: AiFn | null): GameState {
  const budget = { ...DEFAULT_BUDGET };
  const rejected = new Set<string>();
  const moveTries = new Map<string, number>();
  let cur = s;
  if (ai) {
    for (let i = 0; i < AI_MAX_STEPS && !cur.winner; i++) {
      const a = ai(cur, budget, rejected);
      if (!a) break;
      const r = applyAction(cur, a);
      if (!r.ok) {
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
      cur = r.state;
    }
  }
  if (cur.winner) return cur;
  const r = applyAction(cur, { type: 'END_TURN' });
  return r.ok ? r.state : cur;
}

function run(exam: string): Row | null {
  const dir = resolve('exams', exam);
  if (!existsSync(resolve(dir, 'criteria.json')) || !existsSync(resolve(dir, 'snap.json'))) return null;
  const crit = JSON.parse(readFileSync(resolve(dir, 'criteria.json'), 'utf8')) as { me: PlayerId };
  const ME = crit.me;
  const FOE: PlayerId = ME === 'A' ? 'B' : 'A';
  const raw = JSON.parse(readFileSync(resolve(dir, 'snap.json'), 'utf8')) as { state: GameState };
  const s0 = structuredClone(raw.state);
  s0.aiControl = { [ME]: false, [FOE]: false } as Record<PlayerId, boolean>;

  resetV4();
  let s = structuredClone(s0);
  const START = s0.turn;
  while (!s.winner && s.turn < START + TURNS) {
    const before = s.turn;
    s = aiTurn(s, s.current === ME ? v4 : auto);
    if (s.turn === before) break;
  }

  const mem = (s.aiFocus?.[ME]?.v4 ?? {}) as V4Memory;
  const waves = mem.waves ?? [];
  const gaps = Object.values(mem.lineGap ?? {});
  const ex = mem.exchange ?? [];
  return {
    exam,
    turns: s.turn - START,
    batches: waves.length,
    sent: waves.filter((w) => w.startTurn !== undefined).length,
    merged: waves.filter((w) => w.end === 'merged').length,
    wiped: waves.filter((w) => w.end === 'wiped').length,
    withdrawn: waves.filter((w) => w.end === 'withdrawn').length,
    gone: waves.filter((w) => w.end === 'gone').length,
    refill: waves.some((a) => a.end === 'wiped' && waves.some((b) => b.id !== a.id && b.bornTurn > (a.endTurn ?? 0))),
    men: waves.reduce((n, w) => n + w.men, 0),
    groups: waves.filter((w) => w.men >= 4).length,
    arrived: waves.reduce((n, w) => n + w.arrivedIds.length, 0),
    gapTotal: gaps.reduce((n, g) => n + g.total, 0),
    gapWorst: gaps.reduce((n, g) => Math.max(n, g.worst), 0),
    noFront: gaps.reduce((n, g) => n + g.noFront, 0),
    gain: ex.reduce((n, x) => n + x.gain, 0),
    loss: ex.reduce((n, x) => n + x.loss, 0),
    meCities: s.cities.filter((c) => c.owner === ME && !c.ruined).length,
    foeCities: s.cities.filter((c) => c.owner === FOE && !c.ruined).length,
  };
}

/** 终端宽度对齐（汉字和 emoji 占两格） */
const pad = (s: string, n: number): string => {
  const w = [...s].reduce((a, ch) => a + (ch.codePointAt(0)! > 0xff ? 2 : 1), 0);
  return s + ' '.repeat(Math.max(0, n - w));
};

const rows: Row[] = [];
for (const exam of LIST) {
  const r = run(exam);
  if (r) rows.push(r);
}

/* 先看"差"的：断档多的、一批都没开过的排前面 */
rows.sort((a, b) => b.gapTotal - a.gapTotal || a.arrived - b.arrived);

console.log(
  '\n' +
    pad('题', 8) +
    pad('手', 5) +
    pad('批/发', 7) +
    pad('并/光/撤/失', 14) +
    pad('到人', 6) +
    pad('前0/断档', 12) +
    pad('交换赚/亏', 14) +
    '城 我/敌',
);
for (const r of rows) {
  console.log(
    pad(r.exam, 8) +
      pad(String(r.turns), 5) +
      pad(`${r.batches}/${r.sent}`, 7) +
      pad(`${r.merged}/${r.wiped}/${r.withdrawn}/${r.gone}`, 14) +
      pad(String(r.arrived), 6) +
      pad(`${r.noFront}/${r.gapTotal}`, 12) +
      pad(`${r.gain}/${r.loss}`, 14) +
      `${r.meCities}/${r.foeCities}`,
  );
}

const sum = (f: (r: Row) => number): number => rows.reduce((n, r) => n + f(r), 0);
const hit = (f: (r: Row) => boolean): number => rows.filter(f).length;
console.log(
  `\n${rows.length} 题 · 开过 ≥2 批的 ${hit((r) => r.batches >= 2)} 题 · ` +
    `≤1 批（从没补过人）的 ${hit((r) => r.batches <= 1)} 题 · ` +
    `断过档的 ${hit((r) => r.gapTotal > 0)} 题 · 交换为亏的 ${hit((r) => r.loss > r.gain)} 题 · ` +
    `打光后补过人的 ${hit((r) => r.refill)} 题`,
);
console.log(
  `合计：编入 ${sum((r) => r.men)} 人 / ${sum((r) => r.batches)} 批（≥4 人的成批只 ${sum((r) => r.groups)} 个） · ` +
    `送进前线 ${sum((r) => r.arrived)} 人 · 前线 0 人共 ${sum((r) => r.noFront)} 手 · 断档 ${sum((r) => r.gapTotal)} 手 · ` +
    `交换 赚 ${sum((r) => r.gain)} / 亏 ${sum((r) => r.loss)}`,
);
