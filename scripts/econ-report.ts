/**
 * 读 `results/econ-*.json`，按开局类型汇总经济单位的采用 / 回本 / 生存 / 对胜率的影响，
 * 输出控制台表格 + `docs/ANALYSIS-ECON-YYYY-MM-DD.md`。
 *
 * 口径与 `balance-econ.ts` 文件头一致；这里只做聚合，不再改任何规则。
 */

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';

import { UNIT_TYPES } from '../src/core/config.ts';
import type { PlayerId } from '../src/core/types.ts';

interface Instance {
  id: string;
  type: string;
  owner: PlayerId;
  bornTurn: number;
  cost: number;
  income: number;
  alive: boolean;
  lifeTurns: number;
}
interface SideRecord {
  owner: PlayerId;
  recruited: Record<string, number>;
  won: boolean;
}
interface GameRecord {
  group: string;
  startEra: number;
  seed: number;
  index: number;
  turns: number;
  actions: number;
  winner: PlayerId | null;
  instances: Instance[];
  sides: SideRecord[];
}

const GROUPS: Record<string, string> = {
  classical: '古典开局',
  gunpowder: '火药开局',
  modern: '现代开局',
};

const files = readdirSync('results')
  .filter((f) => /^econ-\d{4}-\d{2}-\d{2}\.json$/.test(f))
  .sort();
if (files.length === 0) throw new Error('没有 results/econ-*.json，先跑 balance-econ.ts');
const path = `results/${files[files.length - 1]}`;
const data = JSON.parse(readFileSync(path, 'utf8')) as { games: GameRecord[] };
const games = data.games;

const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;
const num = (x: number): string => (Number.isFinite(x) ? x.toFixed(2) : '—');

interface Row {
  type: string;
  name: string;
  sidesWith: number;
  sidesTotal: number;
  instances: number;
  paybackRate: number;
  paybackProgress: number;
  survival: number;
  lifeTurns: number;
  winWith: number;
  winWithout: number;
  nWith: number;
  nWithout: number;
  /** 均摊"第几回合回本"：出生回合 + 造价 / 单位回合产出（右删失的按 999 记） */
  paybackTurn: number;
  /** 每局平均造几个 */
  perGame: number;
}

function analyze(group: string): Row[] {
  const pool = games.filter((g) => g.group === group);
  const rows: Row[] = [];
  const types = new Set<string>();
  for (const g of pool) for (const i of g.instances) types.add(i.type);
  /**
   * 胜率只在**分胜负**的局里统计。
   *
   * 撞到回合上限的平局里两边 `won` 都是 false，把它们算进去等于给"有它/无它"
   * 两组同时灌水，差值和绝对值都会失真（古典那一档 60 局里有 27 局是这样）。
   */
  const decidedSides = pool.filter((g) => g.winner).flatMap((g) => g.sides);

  for (const type of types) {
    const insts = pool.flatMap((g) => g.instances.filter((i) => i.type === type));
    const sides = pool.flatMap((g) => g.sides);
    // 采用率看**全部参战方**（含未决局：造没造过与最后分不分胜负无关）；
    // 胜率只看分胜负的那些，两套分母不能混。
    const withAll = sides.filter((s) => (s.recruited[type] ?? 0) > 0);
    const withSide = decidedSides.filter((s) => (s.recruited[type] ?? 0) > 0);
    const withoutSide = decidedSides.filter((s) => !(s.recruited[type] ?? 0));
    rows.push({
      type,
      name: UNIT_TYPES[type]?.name ?? type,
      sidesWith: withAll.length,
      sidesTotal: sides.length,
      instances: insts.length,
      paybackRate: insts.length ? insts.filter((i) => i.income >= i.cost).length / insts.length : 0,
      paybackProgress: insts.length
        ? insts.reduce((a, i) => a + (i.cost > 0 ? i.income / i.cost : 0), 0) / insts.length
        : 0,
      survival: insts.length ? insts.filter((i) => i.alive).length / insts.length : 0,
      lifeTurns: insts.length ? insts.reduce((a, i) => a + i.lifeTurns, 0) / insts.length : 0,
      winWith: withSide.length ? withSide.filter((s) => s.won).length / withSide.length : 0,
      winWithout: withoutSide.length
        ? withoutSide.filter((s) => s.won).length / withoutSide.length
        : 0,
      nWith: withSide.length,
      nWithout: withoutSide.length,
      paybackTurn:
        insts.length && insts.reduce((a, i) => a + i.cost, 0) > 0
          ? insts.reduce(
              (a, i) => a + (i.income > 0 ? i.bornTurn + (i.cost * i.lifeTurns) / i.income : 999),
              0,
            ) / insts.length
          : 999,
      perGame: insts.length / pool.length,
    });
  }
  rows.sort((a, b) => b.sidesWith - a.sidesWith);
  return rows;
}

/* ---------- 控制台 ---------- */

let md = `# 经济单位统计：180 局双 AI 对局（古典 / 火药 / 现代各 60 局）\n\n`;
md += `数据：\`${path}\`（种子固定为 \`20261101 + 开局档 × 100000 + 序号\`，逐局可复现）。\n`;
md += `口径：采用率＝造过该兵种的参战方占比；回本率＝累计金币产出 ≥ 造价 的个体占比；\n`;
md += `生存率＝终局仍存活的个体占比；胜率影响＝造过 vs 没造过两组的胜率差。\n\n`;

for (const group of Object.keys(GROUPS)) {
  const pool = games.filter((g) => g.group === group);
  const decisive = pool.filter((g) => g.winner).length;
  const aWins = pool.filter((g) => g.winner === 'A').length;
  const avgTurns = pool.reduce((a, g) => a + g.turns, 0) / pool.length;
  const rows = analyze(group);

  console.log(`\n=== ${GROUPS[group]}（${pool.length} 局，分胜负 ${decisive}，均 ${avgTurns.toFixed(0)} 回合）===`);
  console.log('兵种'.padEnd(8), '采用', '每局', '回本率', '进度', '回本回合', '生存', '均活', '有他胜', '无他胜', 'n');
  for (const r of rows) {
    console.log(
      r.name.padEnd(8),
      pct(r.sidesWith / r.sidesTotal).padStart(5),
      num(r.perGame).padStart(4),
      pct(r.paybackRate).padStart(6),
      num(r.paybackProgress).padStart(5),
      num(r.paybackTurn).padStart(6),
      pct(r.survival).padStart(5),
      num(r.lifeTurns).padStart(4),
      pct(r.winWith).padStart(5),
      pct(r.winWithout).padStart(5),
      `${r.nWith}/${r.nWithout}`,
    );
  }

  md += `## ${GROUPS[group]}（${pool.length} 局，分胜负 ${decisive} 局，A 胜 ${aWins}，均 ${avgTurns.toFixed(0)} 回合）\n\n`;
  md += `| 经济单位 | 采用率 | 每局个数 | 个体数 | 回本率 | 平均回本进度 | 均摊回本回合 | 生存率 | 均存活回合 | 有它胜率 | 无它胜率 | 差值 | 样本(有/无) |\n`;
  md += `|---|---|---|---|---|---|---|---|---|---|---|---|---|\n`;
  for (const r of rows) {
    const delta = r.winWith - r.winWithout;
    md += `| ${r.name} | ${pct(r.sidesWith / r.sidesTotal)} | ${num(r.perGame)} | ${r.instances} | ${pct(
      r.paybackRate,
    )} | ${num(r.paybackProgress)} | ${r.paybackTurn >= 999 ? '未回本' : num(r.paybackTurn)} | ${pct(
      r.survival,
    )} | ${num(r.lifeTurns)} | ${pct(r.winWith)} | ${pct(r.winWithout)} | ${delta >= 0 ? '+' : ''}${pct(
      delta,
    )} | ${r.nWith}/${r.nWithout} |\n`;
  }
  const decided = pool.filter((g) => g.winner);
  md += `\n> 胜率样本：以上"有它/无它"只在 ${decided.length} 局分胜负的对局里统计（共 ${
    decided.length * 2
  } 个参战方）；采用率的分母是全部 ${pool.length * 2} 个参战方。\n\n`;

  // 经济投入强度：把每一方的经济单位造价加起来，按分位切三档看胜率
  const spends = pool
    .filter((g) => g.winner)
    .flatMap((g) =>
      g.sides.map((side) => ({
        won: side.won,
        spend: g.instances.filter((i) => i.owner === side.owner).reduce((a, i) => a + i.cost, 0),
      })),
    )
    .sort((a, b) => a.spend - b.spend);
  if (spends.length >= 9) {
    const third = Math.floor(spends.length / 3);
    const bands = [
      { label: '低投入', rows: spends.slice(0, third) },
      { label: '中投入', rows: spends.slice(third, spends.length - third) },
      { label: '高投入', rows: spends.slice(spends.length - third) },
    ];
    md += `**经济投入强度 vs 胜率**（按经济单位总造价三分位）\n\n`;
    md += `| 档位 | 样本 | 均投入(金) | 胜率 |\n|---|---|---|---|\n`;
    for (const b of bands) {
      const win = b.rows.filter((r) => r.won).length / b.rows.length;
      const avg = b.rows.reduce((a, r) => a + r.spend, 0) / b.rows.length;
      md += `| ${b.label} | ${b.rows.length} | ${avg.toFixed(0)} | ${pct(win)} |\n`;
    }
    const winners = spends.filter((r) => r.won);
    const losers = spends.filter((r) => !r.won);
    const avgOf = (xs: typeof spends) => (xs.length ? xs.reduce((a, r) => a + r.spend, 0) / xs.length : 0);
    md += `\n胜方平均经济投入 **${avgOf(winners).toFixed(0)}** 金，负方 **${avgOf(losers).toFixed(0)}** 金。\n\n`;
    console.log(
      `${GROUPS[group]} 经济投入：低/中/高 = ${bands
        .map((b) => pct(b.rows.filter((r) => r.won).length / b.rows.length))
        .join(' / ')}，胜方均投入 ${avgOf(winners).toFixed(0)} vs 负方 ${avgOf(losers).toFixed(0)}`,
    );
  }
}

// 只写"表格部分"：分析结论是手写的，脚本重跑不该把结论冲掉
writeFileSync('results/econ-tables-2026-11-01.md', md);
console.log('\n表格 → results/econ-tables-2026-11-01.md');
