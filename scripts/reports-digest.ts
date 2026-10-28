/**
 * 把云端收上来的真人对局，汇成一份能看的平衡报告。
 *
 * 和 `scripts/balance-report.ts` 的关系说清楚：那个吃的是**跑批模拟**的输出
 * （每百金杀伤、交换比、终局阵容），因为它拿得到逐次伤害；
 * 这个吃的是**玩家真的打完的局**，数据是公开可上交的那部分——没有伤害流水，
 * 所以算不出"每百金杀伤"。它能回答的是另一类问题：
 *   谁先手赢得多、哪套扩展一开就一边倒、哪个兵种真有人用、
 *   一局通常打多久、赢家金库还剩多少钱（钱花不出去 = 产线卡住）。
 *
 * 输入：从云数据库导出的 JSON。两种形状都收：
 *   1) 行数组 [{seed, turns, winner, expansions, ai, sides, payload}, ...]
 *   2) 带 .rows 的对象（有些导出工具会套一层）
 *
 * 用法：
 *   node --experimental-strip-types scripts/reports-digest.ts reports.json
 *   node --experimental-strip-types scripts/reports-digest.ts reports.json --md out.md
 *
 * 导出方式见 README「对局数据」一节。
 */

import { readFileSync, writeFileSync } from 'node:fs';

import { ACTION_LABEL, type MatchTimeline } from '../src/core/timeline.ts';
import type { MatchReport, ReportSide } from '../src/core/report.ts';

interface Row {
  id?: number;
  created_at?: string;
  version?: number;
  seed: number;
  board_w?: number;
  board_h?: number;
  turns: number;
  winner: string | null;
  expansions?: string[];
  ai?: { level?: string; opponent?: boolean; ally?: boolean; commander?: boolean; godMode?: boolean };
  sides?: ReportSide[];
  payload?: MatchReport;
}

const args = process.argv.slice(2);
const argOf = (name: string, dflt: string): string => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? (args[i + 1] as string) : dflt;
};
const file = args.find((a) => !a.startsWith('--') && a.endsWith('.json'));
if (!file) {
  console.error('用法：node --experimental-strip-types scripts/reports-digest.ts <reports.json> [--md out.md]');
  process.exit(1);
}

function loadRows(path: string): Row[] {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  const list = Array.isArray(raw)
    ? raw
    : ((raw as { rows?: Row[] }).rows ?? (raw as { data?: Row[] }).data ?? []);
  if (!Array.isArray(list)) throw new Error('这个 JSON 里既没有数组，也没有 rows/data 字段');
  return (list as Row[]).filter((r) => typeof r?.seed === 'number' && typeof r?.turns === 'number');
}

const allRows = loadRows(file);

/**
 * 一致性检查：只挑"客户端不可能产出"的自相矛盾，不挑"看起来可疑"。
 *
 * 为什么只挑这一档：这套系统没有服务端权威，一条数据本来就是一份声明。
 * 拿"兵力看着太多"这类主观标准去剔，会把真人打的怪局（热座、指挥官模式、
 * 自定义兵种池）一起误杀；而"赢家 0 城"这种在规则里根本不可能，
 * 出现就只有两个解释——客户端被改过，或者这一行是手写的。
 *
 * 剔除只影响**这份报告**，不改库里任何东西：原始行永远在，等人工复核。
 */
function checkRow(r: Row): string[] {
  const why: string[] = [];
  const sides = r.sides ?? r.payload?.sides ?? [];

  if (!Number.isFinite(r.turns) || r.turns < 1 || r.turns > 5000) why.push('回合数越界');
  if (r.winner !== null && r.winner !== 'A' && r.winner !== 'B') why.push('胜负值非法');
  if (sides.length > 2) why.push('超过两方');
  if (sides.length > 0 && sides.length < 2) why.push('少了一方');

  // 规则层：没有城就算输。赢家 0 城是自相矛盾的
  const winner = sides.find((x) => x.side === r.winner);
  if (r.winner && winner && (winner.cities ?? 0) < 1) why.push('赢家 0 城');

  const tl = r.payload?.timeline;
  if (tl) {
    if (!Array.isArray(tl.samples)) why.push('摘要缺 samples');
    else if (tl.samples.length > 240) why.push('摘要帧数超上限');
    else {
      // 同一批行动，两个口径的出兵数必须对得上（客户端是同一处代码数的）
      for (const p of ['A', 'B'] as const) {
        const acts = tl.acts?.[p]?.RECRUIT ?? 0;
        const made = Object.values(tl.made?.[p] ?? {}).reduce((a, b) => a + b, 0);
        if (acts > 0 && made > 0 && acts !== made) why.push(`${p} 方出兵计数对不上`);
      }
      const ts = tl.samples.map((x) => x.t);
      for (let i = 1; i < ts.length; i++) {
        if ((ts[i] ?? 0) <= (ts[i - 1] ?? 0)) {
          why.push('摘要时间不单调');
          break;
        }
      }
    }
  }
  return why;
}

const bad: Array<{ row: Row; why: string[] }> = [];
const rows = allRows.filter((r) => {
  const why = checkRow(r);
  if (why.length === 0) return true;
  bad.push({ row: r, why });
  return false;
});

/* ---------------- 小工具 ---------------- */

const pct = (a: number, b: number): string => (b > 0 ? `${((a / b) * 100).toFixed(1)}%` : '—');
const avg = (xs: number[]): number => (xs.length > 0 ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const f1 = (n: number): string => (Number.isFinite(n) ? n.toFixed(1) : '—');
const median = (xs: number[]): number => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2 : (s[mid] ?? 0);
};
const side = (r: Row, p: 'A' | 'B'): ReportSide | undefined =>
  r.sides?.find((s) => s.side === p) ?? r.payload?.sides?.find((s) => s.side === p);
const timelineOf = (r: Row): MatchTimeline | undefined => r.payload?.timeline;
const levelName = (lv: string | undefined): string =>
  lv === 'basic' ? '初级' : lv === 'tactic' ? '战术·测试' : lv === 'advanced' ? '高级' : lv ?? '—';

const lines: string[] = [];
const say = (s = ''): void => void lines.push(s);

/* ---------------- 概览 ---------------- */

const decided = rows.filter((r) => r.winner === 'A' || r.winner === 'B');
const draws = rows.length - decided.length;
const times = rows.map((r) => new Date(r.created_at ?? 0).getTime()).filter((t) => t > 0);

say('# 真人对局汇总');
say();
if (bad.length > 0) {
  say(`共收 ${allRows.length} 局，其中 **${bad.length} 局未通过一致性检查**（明细见文末），` +
    `主结论只基于剩下 ${rows.length} 局。`);
  say();
}
say(`样本 ${rows.length} 局（分出胜负 ${decided.length}，未决 ${draws}），` +
  `平均 ${f1(avg(rows.map((r) => r.turns)))} 次行动，中位 ${median(rows.map((r) => r.turns))}。`);
if (times.length > 0) {
  const first = new Date(Math.min(...times)).toISOString().slice(0, 10);
  const last = new Date(Math.max(...times)).toISOString().slice(0, 10);
  say(`时间范围 ${first} ~ ${last}。`);
}
say();
if (rows.length < 30) {
  say(`> ⚠️ 只有 ${rows.length} 局，下面的百分比先当方向看，样本到 30 局以上再下定论。`);
  say();
}

/* ---------------- 先后手 ---------------- */

const aWins = decided.filter((r) => r.winner === 'A').length;
say('## 先后手');
say();
say(`A 座（先手）胜率 **${pct(aWins, decided.length)}**（${aWins}/${decided.length}），` +
  `未决率 ${pct(draws, rows.length)}。`);
say();
say('> 12×12 双 AI 的老基线是 60% 上下；真人局里 AA 制度、开局让子和玩家水平都会影响它，');
say('> 别把这里的数字直接当成"先手优势"——它混了操作水平。');
say();

/* ---------------- 按 AI 档位 ---------------- */

const byLevel = new Map<string, Row[]>();
for (const r of rows) {
  const key = `${levelName(r.ai?.level)}${r.ai?.ally ? '（双 AI）' : r.ai?.opponent ? '（人机）' : '（热座）'}`;
  const arr = byLevel.get(key) ?? [];
  arr.push(r);
  byLevel.set(key, arr);
}
if (byLevel.size > 0) {
  say('## 按对局类型 / AI 档位');
  say();
  say('| 类型 | 局数 | 未决 | A 座胜率（人机局＝玩家） | 平均行动 |');
  say('|---|---|---|---|---|');
  for (const [key, list] of [...byLevel.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const dec = list.filter((r) => r.winner === 'A' || r.winner === 'B');
    const aWin = dec.filter((r) => r.winner === 'A').length;
    say(`| ${key} | ${list.length} | ${pct(list.length - dec.length, list.length)} | ${pct(aWin, dec.length)} | ${f1(avg(list.map((r) => r.turns)))} |`);
  }
  say();
}

/* ---------------- 扩展组合 ---------------- */

const byPack = new Map<string, Row[]>();
for (const r of rows) {
  const key = (r.expansions ?? []).slice().sort().join(' + ') || '（无扩展）';
  const arr = byPack.get(key) ?? [];
  arr.push(r);
  byPack.set(key, arr);
}
if (byPack.size > 0) {
  say('## 扩展组合');
  say();
  say('| 组合 | 局数 | 未决 | 平均行动 |');
  say('|---|---|---|---|');
  for (const [key, list] of [...byPack.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 12)) {
    const dec = list.filter((r) => r.winner === 'A' || r.winner === 'B');
    say(`| ${key} | ${list.length} | ${pct(list.length - dec.length, list.length)} | ${f1(avg(list.map((r) => r.turns)))} |`);
  }
  say();
  say('> 未决率高 ≠ 均衡。两边都推不动也会打成未决，那是最差的一种"平衡"。');
  say();
}

/* ---------------- 兵种 ---------------- */

const madeAll = new Map<string, number>();
/** 兵种 -> 出现在哪几局（按局去重：一场里两方都有，也只算"这一局出现了"） */
const usedIn = new Map<string, Set<number>>();
const winWhen = new Map<string, { win: number; loss: number }>();
const actionLabel = (k: string): string => ACTION_LABEL[k] ?? k;

rows.forEach((r, idx) => {
  const tl = timelineOf(r);
  if (tl) {
    for (const p of ['A', 'B'] as const) {
      for (const [id, n] of Object.entries(tl.made[p] ?? {})) {
        madeAll.set(id, (madeAll.get(id) ?? 0) + n);
      }
    }
  }

  const onA = new Set(Object.keys(side(r, 'A')?.roster ?? {}));
  const onB = new Set(Object.keys(side(r, 'B')?.roster ?? {}));
  for (const id of new Set([...onA, ...onB])) {
    const set = usedIn.get(id) ?? new Set<number>();
    set.add(idx);
    usedIn.set(id, set);
  }

  // 出现时胜率：只在"这兵只出现在一方"的局里统计——两边都有的一局，
  // 它既在赢家也在输家，算进去只会把数字拉回 50%。
  if (r.winner !== 'A' && r.winner !== 'B') return;
  const winner = r.winner === 'A' ? onA : onB;
  const loser = r.winner === 'A' ? onB : onA;
  for (const id of winner) {
    if (loser.has(id)) continue;
    const rec = winWhen.get(id) ?? { win: 0, loss: 0 };
    rec.win += 1;
    winWhen.set(id, rec);
  }
  for (const id of loser) {
    if (winner.has(id)) continue;
    const rec = winWhen.get(id) ?? { win: 0, loss: 0 };
    rec.loss += 1;
    winWhen.set(id, rec);
  }
});

const usedGames = new Map<string, number>();
for (const [id, set] of usedIn) usedGames.set(id, set.size);
if (usedGames.size > 0) {
  say('## 兵种');
  say();
  say('| 兵种 | 出现局数 | 出现率 | 出现时胜率 | 产出总数 | 局均产出 |');
  say('|---|---|---|---|---|---|');
  const ids = [...usedGames.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);
  for (const [id, games] of ids) {
    const w = winWhen.get(id);
    const rate = w ? pct(w.win, w.win + w.loss) : '—';
    const made = madeAll.get(id) ?? 0;
    say(`| ${id} | ${games} | ${pct(games, rows.length)} | ${rate} | ${made || '—'} | ${made ? f1(made / rows.length) : '—'} |`);
  }
  say();
  if (madeAll.size === 0) {
    say('> 这批数据里没有逐回合摘要，所以只有终局阵容能看（造了又打光的兵会统计不到）。');
    say();
  }
}

/* ---------------- 逐回合摘要 ---------------- */

const withTl = rows.filter((r) => (timelineOf(r)?.samples.length ?? 0) > 0);
if (withTl.length > 0) {
  say('## 曲线（有逐回合摘要的局）');
  say();
  say(`这批里有 ${withTl.length} 局带摘要（占 ${pct(withTl.length, rows.length)}）。`);
  say();
  const openVa: number[] = [];
  const endVa: number[] = [];
  const goldSpare: number[] = [];
  const actMix = new Map<string, number>();
  for (const r of withTl) {
    const tl = timelineOf(r);
    if (!tl) continue;
    const first = tl.samples[0];
    const last = tl.samples[tl.samples.length - 1];
    if (first) openVa.push(first.va + first.vb);
    if (last) endVa.push(last.va + last.vb);
    const winnerSide = r.winner === 'A' || r.winner === 'B' ? side(r, r.winner) : undefined;
    if (winnerSide) goldSpare.push(winnerSide.gold);
    for (const p of ['A', 'B'] as const) {
      for (const [k, n] of Object.entries(tl.acts[p] ?? {})) {
        if (k === 'END_TURN') continue;
        actMix.set(k, (actMix.get(k) ?? 0) + n);
      }
    }
  }
  say(`开局双方身价合计中位 ${f1(median(openVa))} 金，终局 ${f1(median(endVa))} 金。`);
  const spareText = goldSpare.length > 0 ? `${f1(median(goldSpare))} 金` : '—（这批没有分出胜负的局）';
  say(`赢家终局金库中位 **${spareText}**` +
    `${median(goldSpare) > 150 ? ' —— 钱花不出去，先查产线/编制上限，别怪兵种贵' : ''}。`);
  say();
  const total = [...actMix.values()].reduce((a, b) => a + b, 0);
  if (total > 0) {
    say('行动构成：' + [...actMix.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([k, n]) => `${actionLabel(k)} ${pct(n, total)}`)
      .join(' · '));
    say();
  }
} else {
  say('## 曲线');
  say();
  say('这批数据里没有逐回合摘要（上传时没勾"记录详细数据"）。');
  say('想要曲线，下次开局时在「数据收集」里勾上——那条才是调 AI 的关键证据。');
  say();
}

/* ---------------- 这套数据算不出什么 ---------------- */

if (bad.length > 0) {
  say('## 未通过一致性检查的局');
  say();
  const reasons = new Map<string, number>();
  for (const b of bad) for (const w of b.why) reasons.set(w, (reasons.get(w) ?? 0) + 1);
  say('| 原因 | 局数 |');
  say('|---|---|');
  for (const [k, n] of [...reasons.entries()].sort((a, b) => b[1] - a[1])) {
    say(`| ${k} | ${n} |`);
  }
  say();
  const sample = bad.slice(0, 8);
  say('前几行明细（种子 / 回合 / 原因）：');
  say();
  for (const b of sample) {
    say(`- seed ${b.row.seed} · ${b.row.turns} 回合 · ${b.why.join('、')}`);
  }
  say();
  say('> 这些行**没有**从库里删掉，只是不参与本次结论。复核后建议标记而不是删除：');
  say('> `update warchess_reports set verdict = \'quarantined\' where id in (...)`。');
  say('> 删了就没法复盘"当初为什么判它可疑"。');
  say();
}

say('## 这套数据算不出什么（别硬算）');
say();
say('- **每百金杀伤 / 交换比**：需要逐次伤害流水，报告里没有。要这个用 `npm run balance` 跑模拟。');
say('- **兵种强弱**：终局阵容只说明"活到最后的有谁"，活下来的往往是赢家，因果是反的。');
say('  真要评强弱，看 `timeline.made`（真实产出）加胜负分组，别单看阵容。');
say('- **玩家水平**：没有账号体系，也没有对局时长与操作速度。');
say();

const out = lines.join('\n');
const mdPath = argOf('md', '');
if (mdPath) {
  writeFileSync(mdPath, out + '\n');
  console.log(`已写入 ${mdPath}（${rows.length} 局）`);
} else {
  console.log(out);
}
