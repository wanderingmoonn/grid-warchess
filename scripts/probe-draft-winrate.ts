/**
 * 选卡模式（BP）的卡牌体检：双 AI 打 N 局，统计每张卡的出现率、被禁率、被选率与胜率。
 *
 * ── 为什么要单独一支脚本 ────────────────────────────────────────────────
 * 平衡报告量的是"兵种造出来之后打得好不好"，而选卡量的是**选之前**那一步：
 * 一张卡可能很强但没人选（比如要五代城才造得出来），也可能被 ban 得根本出不了场。
 * 这两件事只有把 BP 真跑一遍才看得见。
 *
 * ── 指标口径（别混）────────────────────────────────────────────────────
 *   · 进池率  = 出现在牌池里的局数 / 总局数
 *   · 被禁率  = 被禁次数 / 进池次数
 *   · 被选率  = 被选次数 /（进池次数 − 被禁次数）  ← "轮到你时还会不会拿它"
 *   · 胜率    = 选中它的那一方赢的局数 /（选中它的局数 − 未决局数）
 *
 * 胜率的样本口径必须说清：同一张卡可能被 A 选、也可能被 B 选，两边都选时
 * 这一局必有一方赢、卡本身"五五开"——所以这张表只反映趋势，
 * 单卡样本小于 10 时我会在输出里标 `n小`，不合并、不剔除。
 *
 * 用法：
 *   node --experimental-strip-types scripts/probe-draft-winrate.ts --games 100
 *   ... --expansions fantasy --era 1 --size 12 --level advanced --cap 200
 *   ... --shard 3 --shards 12 --out /tmp/draft-shard-3.jsonl   # 分片跑
 *   ... --merge '/tmp/draft-shard-*.jsonl'                     # 汇总
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { AI_MAX_STEPS, DEFAULT_BUDGET, aiNextAction } from '../src/core/ai.ts';
import { aiDraftBan, aiDraftPick, draftView } from '../src/core/draft.ts';
import { applyAction } from '../src/core/rules.ts';
import { createMatch, DEFAULT_CONFIG } from '../src/core/setup.ts';
import type { GameState, PlayerId } from '../src/core/types.ts';

const args = process.argv.slice(2);
const argOf = (name: string, dflt: string): string => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? (args[i + 1] as string) : dflt;
};
const GAMES = Number(argOf('games', '100'));
const ERA = Number(argOf('era', '1'));
const SIZE = Number(argOf('size', '12'));
const LEVEL = argOf('level', 'advanced') as 'basic' | 'tactic' | 'advanced';
const CAP = Number(argOf('cap', '200'));
const BASE_SEED = Number(argOf('seed', '90000'));
const EXPANSIONS = argOf('expansions', 'fantasy')
  .split(',')
  .map((x) => x.trim())
  .filter(Boolean);
const SHARD = Number(argOf('shard', '0'));
const SHARDS = Number(argOf('shards', '1'));
const OUT = argOf('out', '');
const MERGE = argOf('merge', '');

export interface GameRow {
  seed: number;
  winner: PlayerId | null;
  turns: number;
  pool: string[];
  bansA: string[];
  bansB: string[];
  picksA: string[];
  picksB: string[];
}

/** 一局：先跑完 BP（双方都是 AI），再让两个 AI 把棋下完 */
function playOne(seed: number): GameRow {
  let s: GameState = createMatch(
    {
      ...DEFAULT_CONFIG,
      size: SIZE,
      startEra: ERA,
      aiLevel: LEVEL,
      aiOpponent: true,
      aiAlly: true,
      draftMode: true,
      expansionIds: EXPANSIONS,
    },
    seed,
  );

  // ── BP ──────────────────────────────────────────────────────────────
  // 从 lobby 开始：DRAFT_START 带一个计时起点（缺了会被判 NaN 超时，见 draft.ts）
  const started = applyAction(s, { type: 'DRAFT_START', at: 0 });
  if (started.ok) s = started.state;

  for (let guard = 0; guard < 200; guard++) {
    if (!s.draft || s.draft.phase === 'done') break;
    const view = draftView(s);
    if (!view) break;
    if (view.phase === 'ban') {
      const side: PlayerId | undefined = (['A', 'B'] as PlayerId[]).find(
        (sd) => !(sd === 'A' ? view.a : view.b).banDone,
      );
      if (!side) break;
      const id = aiDraftBan(s, side);
      if (!id) break;
      const r = applyAction(s, { type: 'DRAFT_BAN', unitId: id, at: 1 }, side);
      // 失败要**当场炸**，不能 break：break 会让这一局带着空 list 进统计，
      // 表现是"所有卡都被选率 0%"——那是我第一次跑时就踩到的假数据
      if (!r.ok) throw new Error(`种子 ${seed} 禁用失败：${r.reason}`);
      s = r.state;
      continue;
    }
    if (view.phase === 'pick') {
      const side = view.toAct;
      if (!side) break;
      const id = aiDraftPick(s, side);
      if (!id) break;
      const r = applyAction(s, { type: 'DRAFT_PICK', unitId: id, at: 1 }, side);
      if (!r.ok) throw new Error(`种子 ${seed} 选人失败：${r.reason}`);
      s = r.state;
      continue;
    }
    break;
  }

  // ── 下棋：和 ai-duel 同一套循环（每回合一份预算，拿不到动作就结束回合）──
  while (!s.winner && s.turn <= CAP) {
    const budget = { ...DEFAULT_BUDGET };
    for (let i = 0; i < AI_MAX_STEPS && !s.winner; i++) {
      const a = aiNextAction(s, budget);
      if (!a) break;
      const r = applyAction(s, a);
      if (!r.ok) break;
      s = r.state;
      if (a.type === 'RECRUIT') budget.recruited += 1;
      if (a.type === 'UPGRADE') budget.upgraded += 1;
    }
    if (s.winner) break;
    const r = applyAction(s, { type: 'END_TURN' });
    if (!r.ok) break;
    s = r.state;
  }

  return {
    seed,
    winner: s.winner ?? null,
    turns: s.turn,
    pool: s.draft?.pool ?? [],
    bansA: s.draft?.bans.A ?? [],
    bansB: s.draft?.bans.B ?? [],
    picksA: s.draft?.picks.A ?? [],
    picksB: s.draft?.picks.B ?? [],
  };
}

function mergeRows(files: string[]): GameRow[] {
  const rows: GameRow[] = [];
  for (const f of files) {
    for (const line of readFileSync(f, 'utf8').split('\n')) {
      if (line.trim()) rows.push(JSON.parse(line) as GameRow);
    }
  }
  return rows;
}

function report(rows: GameRow[]): void {
  const games = rows.length;
  const aWins = rows.filter((r) => r.winner === 'A').length;
  const bWins = rows.filter((r) => r.winner === 'B').length;
  const draws = games - aWins - bWins;
  const avgTurns = rows.reduce((n, r) => n + r.turns, 0) / Math.max(1, games);

  interface Ledger {
    id: string;
    pool: number;
    banned: number;
    picked: number;
    /** 只有一方拿到它的局数（镜像局不计） */
    solo: number;
    soloWins: number;
  }
  const ledger = new Map<string, Ledger>();
  const touch = (id: string): Ledger => {
    let L = ledger.get(id);
    if (!L) {
      L = { id, pool: 0, banned: 0, picked: 0, solo: 0, soloWins: 0 };
      ledger.set(id, L);
    }
    return L;
  };

  for (const r of rows) {
    for (const id of r.pool) touch(id).pool += 1;
    for (const id of [...r.bansA, ...r.bansB]) touch(id).banned += 1;
    const a = new Set(r.picksA);
    const b = new Set(r.picksB);
    for (const id of [...a, ...b]) touch(id).picked += 1;
    if (!r.winner) continue;
    /*
     * 单卡胜率**必须去掉镜像局**。
     *
     * 双方都抓到同一张卡时，这一局无论谁赢都会给这张卡记一胜一负——
     * 它不是"这张卡很强"，而是"两边阵容一样"。把镜像混进来，
     * 每张热门卡的胜率都会被稀释到 50% 附近，看起来"谁都没差别"。
     * 所以这里只统计"只有一方拿到它"的局，同时把样本量一起打出来。
     */
    for (const [owner, mine, theirs] of [
      ['A', a, b],
      ['B', b, a],
    ] as Array<[PlayerId, Set<string>, Set<string>]>) {
      for (const id of mine) {
        if (theirs.has(id)) continue;
        const L = touch(id);
        L.solo += 1;
        if (r.winner === owner) L.soloWins += 1;
      }
    }
  }

  // 元数据（名字/时代）从一局真实状态里取，不猜
  const meta = createMatch(
    { ...DEFAULT_CONFIG, size: SIZE, startEra: ERA, draftMode: true, expansionIds: EXPANSIONS },
    rows[0]?.seed ?? 1,
  ).unitTypes;
  const nameOf = (id: string): string => meta[id]?.name ?? id;
  const eraOf = (id: string): number => meta[id]?.era ?? 0;

  const pct = (n: number, d: number): string => (d > 0 ? `${((n / d) * 100).toFixed(0)}%` : '—');
  /** 95% 置信区间半宽（正态近似），用来判断"这个胜率是不是只是噪声" */
  const ci = (n: number, d: number): string => {
    if (d <= 0) return '—';
    const p = n / d;
    return `±${(1.96 * Math.sqrt(Math.max(p * (1 - p), 0) / d) * 100).toFixed(0)}%`;
  };
  const list = [...ledger.values()].sort((x, y) => y.solo - x.solo || y.picked - x.picked);

  console.log(`\n选卡体检 · ${games} 局 · 双 AI（${LEVEL}）· 起始第 ${ERA} 代 · ${SIZE}×${SIZE}`);
  console.log(`扩展：${EXPANSIONS.join('+') || '（无）'}`);
  console.log(
    `结果：A 胜 ${aWins} / B 胜 ${bWins} / 未决 ${draws} · 平均 ${avgTurns.toFixed(1)} 回合`,
  );
  console.log(
    `池子：每局 ${[...new Set(rows.map((r) => r.pool.length))].join('/')} 张 · ` +
      `选位 ${[...new Set(rows.map((r) => r.picksA.length + r.picksB.length))].join('/')} 张`,
  );

  const inPool = new Set(list.filter((L) => L.pool > 0).map((L) => L.id));
  const everPicked = list.filter((L) => L.picked > 0).length;
  console.log(
    `覆盖：100 局里出现过 ${inPool.size} 张卡，被选过 ${everPicked} 张，` +
      `**从未被选 ${inPool.size - everPicked} 张**`,
  );

  console.log(
    '\n口径：进池率=出现/总场；被禁率=被禁/进池；被选率=被选/(进池−被禁)；' +
      '胜率只算"只有一方拿到它"的局（镜像局不计），样本见最后一列',
  );
  console.log('\n| 卡 | 代 | 进池率 | 被禁率 | 被选率 | 被选次数 | 胜率 | 样本 |');
  console.log('|---|---|---|---|---|---|---|---|');
  for (const L of list) {
    const denom = L.pool - L.banned;
    const small = L.solo < 10 ? ' `n小`' : '';
    console.log(
      `| ${nameOf(L.id)} | ${eraOf(L.id)} | ${pct(L.pool, games)} | ${pct(L.banned, L.pool)} | ` +
        `${pct(L.picked, denom)} | ${L.picked} | ${
          L.solo > 0 ? pct(L.soloWins, L.solo) : '—'
        } ${ci(L.soloWins, L.solo)} | ${L.solo}${small} |`,
    );
  }

  // 分时代的合计（同样去镜像）
  const byEra = new Map<number, { n: number; w: number; picked: number }>();
  for (const L of list) {
    const e = eraOf(L.id);
    const slot = byEra.get(e) ?? { n: 0, w: 0, picked: 0 };
    slot.n += L.solo;
    slot.w += L.soloWins;
    slot.picked += L.picked;
    byEra.set(e, slot);
  }
  console.log('\n按时代（去镜像）：');
  for (const e of [...byEra.keys()].sort((x, y) => x - y)) {
    const v = byEra.get(e)!;
    console.log(`  第 ${e} 代：被选 ${v.picked} 次 · 胜率 ${pct(v.w, v.n)} ${ci(v.w, v.n)} · n=${v.n}`);
  }

  // 禁用集中度：禁位如果永远给同一两张卡，那 BP 的这一半其实没在工作
  const banSets = new Map<string, number>();
  for (const r of rows) {
    const key = [...r.bansA, ...r.bansB].sort().join('+') || '（无）';
    banSets.set(key, (banSets.get(key) ?? 0) + 1);
  }
  const topBan = [...banSets.entries()].sort((x, y) => y[1] - x[1])[0];
  console.log(
    `\n禁用集中度：${banSets.size} 种禁用组合 / ${games} 局，最常见的是 ${topBan?.[0]}（${topBan?.[1]} 局）`,
  );
  const firstPicks = new Map<string, number>();
  for (const r of rows) {
    const k = r.picksA[0] ?? '—';
    firstPicks.set(k, (firstPicks.get(k) ?? 0) + 1);
  }
  const topFirst = [...firstPicks.entries()].sort((x, y) => y[1] - x[1])[0];
  console.log(
    `第一手：${firstPicks.size} 种 / ${games} 局，最常见 ${nameOf(topFirst?.[0] ?? '')}（${topFirst?.[1]} 局）`,
  );

  const never = list.filter((L) => L.picked === 0 && L.pool > 0);
  if (never.length > 0) {
    console.log(
      `\n从没被选过（${never.length} 张）：${never.map((L) => `${nameOf(L.id)}${eraOf(L.id)}`).join('、')}`,
    );
  }
}

if (MERGE) {
  // 支持两种写法：给目录（读里面所有 *.jsonl）或用逗号列文件
  const files: string[] = MERGE.includes('.jsonl')
    ? MERGE.split(',').map((x) => x.trim())
    : readdirSync(MERGE)
        .filter((f) => f.endsWith('.jsonl'))
        .map((f) => `${MERGE.replace(/\/$/, '')}/${f}`);
  const rows = mergeRows(files);
  console.log(`汇总 ${files.length} 个分片、${rows.length} 局`);
  report(rows);
} else if (OUT) {
  const lines: string[] = [];
  for (let i = 0; i < GAMES; i++) {
    const idx = SHARD + i * SHARDS;
    lines.push(JSON.stringify(playOne(BASE_SEED + idx)));
  }
  writeFileSync(OUT, lines.join('\n'));
  console.log(`${OUT}: ${lines.length} 局`);
} else {
  const rows: GameRow[] = [];
  for (let i = 0; i < GAMES; i++) rows.push(playOne(BASE_SEED + i));
  report(rows);
}
