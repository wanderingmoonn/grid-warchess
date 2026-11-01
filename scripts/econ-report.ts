/**
 * 读 `results/econ-matrix-*.json`（3 时代 × 3 边长 × 60 局），输出：
 *   · 九宫格总览（局数/分胜负/均回合/A胜率/ROI）
 *   · 按时代汇总、按边长相汇总、核心兵种 × 配置的采用率矩阵、经济建筑专项
 * 结果写进 `results/econ-matrix-tables-YYYY-MM-DD.md`；分析结论另写在 docs 里。
 */

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';

import { UNIT_TYPES, eraDef } from '../src/core/config.ts';
import type { PlayerId } from '../src/core/types.ts';

interface Instance {
  id: string;
  type: string;
  kind: 'unit' | 'building';
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
  config: string;
  era: number;
  size: number;
  seed: number;
  index: number;
  turns: number;
  actions: number;
  winner: PlayerId | null;
  instances: Instance[];
  sides: SideRecord[];
}

const files = readdirSync('results')
  .filter((f) => /^econ-matrix-\d{4}-\d{2}-\d{2}\.json$/.test(f))
  .sort();
if (files.length === 0) throw new Error('没有 results/econ-matrix-*.json，先跑 balance-econ.ts');
const path = `results/${files[files.length - 1]}`;
const data = JSON.parse(readFileSync(path, 'utf8')) as {
  games: GameRecord[];
  gamesPerConfig: number;
};
const games = data.games;

const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;
const num = (x: number, d = 2): string => (Number.isFinite(x) ? x.toFixed(d) : '—');
const labelOf = (era: number, size: number): string => `${eraDef(era).name} · ${size}×${size}`;

interface Row {
  type: string;
  kind: string;
  name: string;
  sidesWith: number;
  sidesTotal: number;
  instances: number;
  perGame: number;
  paybackRate: number;
  progress: number;
  paybackTurn: number;
  survival: number;
  lifeTurns: number;
  winWith: number;
  winWithout: number;
  nWith: number;
  nWithout: number;
}

function analyze(pool: GameRecord[]): Row[] {
  const types = new Set<string>();
  for (const g of pool) for (const i of g.instances) types.add(i.type);
  const allSides = pool.flatMap((g) => g.sides);
  // 胜率只在分胜负的对局里统计：平局两边都算 0 会同时稀释两组
  const decidedSides = pool.filter((g) => g.winner).flatMap((g) => g.sides);

  const rows: Row[] = [];
  for (const type of types) {
    const insts = pool.flatMap((g) => g.instances.filter((i) => i.type === type));
    const withAll = allSides.filter((s) => (s.recruited[type] ?? 0) > 0);
    const withSide = decidedSides.filter((s) => (s.recruited[type] ?? 0) > 0);
    const withoutSide = decidedSides.filter((s) => !(s.recruited[type] ?? 0));
    rows.push({
      type,
      kind: insts[0]?.kind ?? 'unit',
      name: UNIT_TYPES[type]?.name ?? type,
      sidesWith: withAll.length,
      sidesTotal: allSides.length,
      instances: insts.length,
      perGame: insts.length / pool.length,
      paybackRate: insts.length ? insts.filter((i) => i.income >= i.cost).length / insts.length : 0,
      progress: insts.length
        ? insts.reduce((a, i) => a + (i.cost > 0 ? i.income / i.cost : 0), 0) / insts.length
        : 0,
      paybackTurn: insts.length
        ? insts.reduce(
            (a, i) => a + (i.income > 0 ? i.bornTurn + (i.cost * i.lifeTurns) / i.income : 999),
            0,
          ) / insts.length
        : 999,
      survival: insts.length ? insts.filter((i) => i.alive).length / insts.length : 0,
      lifeTurns: insts.length ? insts.reduce((a, i) => a + i.lifeTurns, 0) / insts.length : 0,
      winWith: withSide.length ? withSide.filter((s) => s.won).length / withSide.length : 0,
      winWithout: withoutSide.length
        ? withoutSide.filter((s) => s.won).length / withoutSide.length
        : 0,
      nWith: withSide.length,
      nWithout: withoutSide.length,
    });
  }
  rows.sort((a, b) => b.sidesWith - a.sidesWith || b.instances - a.instances);
  return rows;
}

const table = (rows: Row[], title: string): string => {
  let out = `### ${title}\n\n`;
  out += `| 兵种 | 类型 | 采用率 | 每局 | 个体 | 回本率 | 回本进度 | 均摊回本回合 | 生存率 | 均活回合 | 有它胜率 | 无它胜率 | 差值 | 样本(有/无) |\n`;
  out += `|---|---|---|---|---|---|---|---|---|---|---|---|---|---|\n`;
  for (const r of rows) {
    const delta = r.winWith - r.winWithout;
    out += `| ${r.name} | ${r.kind === 'building' ? '建筑' : '单位'} | ${pct(
      r.sidesWith / r.sidesTotal,
    )} | ${num(r.perGame)} | ${r.instances} | ${pct(r.paybackRate)} | ${num(r.progress)} | ${
      r.paybackTurn >= 999 ? '未回本' : num(r.paybackTurn, 1)
    } | ${pct(r.survival)} | ${num(r.lifeTurns, 1)} | ${pct(r.winWith)} | ${pct(r.winWithout)} | ${
      delta >= 0 ? '+' : ''
    }${pct(delta)} | ${r.nWith}/${r.nWithout} |\n`;
  }
  return `${out}\n`;
};

let md = `# 经济单位 / 经济建筑：3 时代 × 3 边长 × 60 局（共 540 局）\n\n`;
md += `数据：\`${path}\`。种子 = \`20261101 + era×100000 + size×1000 + 序号\`，逐局可复现。\n\n`;
md += `口径：采用率＝造过该兵种的参战方占比；回本率＝累计金币产出 ≥ 造价 的个体占比；\n`;
md += `生存率＝终局仍存活的个体占比；胜率只在分胜负的对局里比"造过 vs 没造过"。\n`;
md += `**经济建筑（磨坊/水车/工厂/兵工厂）也计入**——走 BUILD 动作，造价用 \`cost\`。\n\n`;

const configs = [...new Set(games.map((g) => `${g.era}-${g.size}`))]
  .map((k) => k.split('-').map(Number) as [number, number])
  .sort((a, b) => a[0] - b[0] || a[1] - b[1]);

console.log('\n配置'.padEnd(18), '局数', '分胜负', '均回合', 'A胜率', 'ROI');
md += `## 1. 九宫格总览\n\n| 配置 | 局数 | 分胜负 | 未决 | 均回合 | A 胜率 | 组合 ROI |\n|---|---|---|---|---|---|---|\n`;
for (const [era, size] of configs) {
  const pool = games.filter((g) => g.era === era && g.size === size);
  const dec = pool.filter((g) => g.winner);
  const inst = pool.flatMap((g) => g.instances);
  const spend = inst.reduce((a, i) => a + i.cost, 0);
  const inc = inst.reduce((a, i) => a + i.income, 0);
  const aWins = dec.filter((g) => g.winner === 'A').length;
  const avgTurns = pool.reduce((a, g) => a + g.turns, 0) / pool.length;
  const aRate = dec.length ? aWins / dec.length : 0;
  console.log(
    labelOf(era, size).padEnd(16),
    String(pool.length).padStart(4),
    String(dec.length).padStart(5),
    avgTurns.toFixed(0).padStart(5),
    pct(aRate).padStart(6),
    (inc / spend).toFixed(2),
  );
  md += `| ${labelOf(era, size)} | ${pool.length} | ${dec.length} | ${pool.length - dec.length} | ${avgTurns.toFixed(
    0,
  )} | ${pct(aRate)} | ${(inc / spend).toFixed(2)}× |\n`;
}
md += `\n`;

md += `## 2. 按开局时代汇总（跨 12/16/20 合并，每档 ${data.gamesPerConfig * 3} 局）\n\n`;
for (const era of [1, 2, 3]) {
  const pool = games.filter((g) => g.era === era);
  md += table(analyze(pool), `${eraDef(era).name}开局`);
}

md += `## 3. 按地图边长汇总（跨三个时代合并，每档 ${data.gamesPerConfig * 3} 局）\n\n`;
for (const size of [12, 16, 20]) {
  const pool = games.filter((g) => g.size === size);
  md += table(analyze(pool), `${size}×${size}`);
}

const KEY = ['farmer', 'herder', 'lumberjack', 'planter', 'agribusiness', 'mill', 'factory', 'arsenal'];
md += `## 4. 核心经济兵种 × 配置：采用率矩阵\n\n`;
md += `| 兵种 | ${configs.map(([e, s]) => `${eraDef(e).name}${s}`).join(' | ')} |\n|---|${configs
  .map(() => '---')
  .join('|')}|\n`;
for (const type of KEY) {
  const cells = configs.map(([era, size]) => {
    const pool = games.filter((g) => g.era === era && g.size === size);
    const sides = pool.flatMap((g) => g.sides);
    const withIt = sides.filter((s) => (s.recruited[type] ?? 0) > 0).length;
    return pct(withIt / sides.length);
  });
  md += `| ${UNIT_TYPES[type]?.name ?? type} | ${cells.join(' | ')} |\n`;
}
md += `\n`;

md += `## 5. 经济建筑专项（回答"AI 到底造不造"）\n\n`;
md += `| 建筑 | 造价 | 城市产出 | ${configs.map(([e, s]) => `${eraDef(e).name}${s}`).join(' | ')} |\n|---|---|---|${configs
  .map(() => '---')
  .join('|')}|\n`;
for (const type of ['mill', 'watermill', 'factory', 'arsenal']) {
  const def = UNIT_TYPES[type];
  const cells = configs.map(([era, size]) => {
    const pool = games.filter((g) => g.era === era && g.size === size);
    const sides = pool.flatMap((g) => g.sides);
    const withIt = sides.filter((s) => (s.recruited[type] ?? 0) > 0).length;
    return pct(withIt / sides.length);
  });
  md += `| ${def?.name ?? type} | ${def?.cost ?? '—'} | ${def?.incomeByTerrain?.city ?? '—'} | ${cells.join(
    ' | ',
  )} |\n`;
}
md += `\n`;

writeFileSync('results/econ-matrix-tables-2026-11-01.md', md);
console.log('\n表格 → results/econ-matrix-tables-2026-11-01.md');
