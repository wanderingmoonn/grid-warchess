/**
 * 时代表：同代统治力 + 跨代衰减，顺带给硬编码的谱表对账。
 *
 * 为什么要有它：`unit-value.ts` 里的 `ERA_SPECTRUM` 是从全部兵种按代算出的分位数，
 * 手抄进去的。兵种一改，那张表就会悄悄过期——所以要有东西能**重新算一遍并比对**，
 * 而不是等人某天发现"怎么这个数怪怪的"。
 *
 * 同时输出两张关键的表：
 *   · **同代统治力**：每个兵用**自己那一代**的谱算，再在同期兵种里排名。
 *     这才是"这个兵在它那个年代横不横"。
 *   · **跨代衰减**：同一批兵放到 2/4/6 代的谱里，看它还值多少。
 *     这是"低代兵到高代就废了"的直接证据。
 *
 * 用法：npm run era:table
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { createMatch, DEFAULT_CONFIG } from '../src/core/setup.ts';
import { availableExpansions } from '../src/core/expansions.ts';
import {
  eraSpectrum,
  unitEfficiency,
  unitPower,
  NEUTRAL_CONTEXT,
} from '../src/core/unit-value.ts';

const s = createMatch(
  { ...DEFAULT_CONFIG, startEra: 6, expansionIds: availableExpansions().map((e) => e.id) },
  1,
);
const all = Object.values(s.unitTypes).filter(
  (d) => d.category === 'combat' && d.cost > 0 && !d.summonedOnly,
);

const q = (a: number[], p: number): number => {
  const b = [...a].sort((x, y) => x - y);
  return b[Math.min(b.length - 1, Math.floor(p * b.length))]!;
};

const lines: string[] = [];
lines.push('# 时代表：同代统治力与跨代衰减');
lines.push('');
lines.push('> 由 `npm run era:table` 生成，直接读 `src/core/unit-value.ts` 的公式与谱表。');
lines.push('');

/* ── ① 对账：谱表 vs 现算 ── */
lines.push('## 一、谱表对账（硬编码 vs 现算分位数）');
lines.push('');
lines.push('| 代 | 兵种 | 攻 p25/p50/p90 现算 | 表里 | 甲 p25/p50/p75 现算 | 表里 | 判定 |');
lines.push('|---|---|---|---|---|---|---|');
let mismatch = 0;
for (let e = 1; e <= 6; e++) {
  const g = all.filter((d) => d.era === e);
  if (g.length === 0) continue;
  const atk = [q(g.map((d) => d.atk), 0.25), q(g.map((d) => d.atk), 0.5), q(g.map((d) => d.atk), 0.9)];
  const arm = [q(g.map((d) => d.armor), 0.25), q(g.map((d) => d.armor), 0.5), q(g.map((d) => d.armor), 0.75)];
  const spec = eraSpectrum(e);
  const tAtk = spec.threats.filter((t) => t.magic === 0).map((t) => t.atk);
  const tArm = spec.targets.map((t) => t.armor);
  // 轻/中/重三档对应 p25/p50/p90（法师那一档不算进来）
  const ok = tAtk.length === 3 && tAtk.every((v, i) => Math.abs(v - (atk[i] as number)) <= 2)
    && tArm.every((v, i) => Math.abs(v - (arm[i] as number)) <= 1.5);
  if (!ok) mismatch += 1;
  lines.push(
    `| ${e} | ${g.length} | ${atk.join('/')} | ${tAtk.join('/')} | ${arm.join('/')} | ${tArm.join('/')} | ${ok ? '✓' : '**偏差**'} |`,
  );
}
lines.push('');
lines.push(`共 ${mismatch} 代对不上（容差：攻 ±2、甲 ±1.5）。对不上就说明谱表该更新了。`);
lines.push('');

/* ── ② 同代统治力 ── */
lines.push('## 二、同代统治力（每个兵用自己那一代的谱，同期内部排名）');
lines.push('');
for (let e = 1; e <= 6; e++) {
  const g = all.filter((d) => d.era === e);
  if (g.length === 0) continue;
  const ranked = g
    .map((d) => ({ d, eff: unitEfficiency(d, d.cost, { ...NEUTRAL_CONTEXT, era: e }) }))
    .sort((a, b) => b.eff - a.eff);
  lines.push(`### ${e} 代（${g.length} 个战斗兵种）`);
  lines.push('');
  lines.push('| # | 兵种 | 价 | 战力 | 效率 |');
  lines.push('|---|---|---|---|---|');
  for (const [i, r] of ranked.slice(0, 8).entries()) {
    lines.push(
      `| ${i + 1} | ${r.d.name} | ${r.d.cost} | ${unitPower(r.d, { ...NEUTRAL_CONTEXT, era: e }).toFixed(0)} | ${r.eff.toFixed(2)} |`,
    );
  }
  lines.push('');
}

/* ── ③ 跨代衰减 ── */
lines.push('## 三、跨代衰减（同一个兵，放到不同时代的谱里）');
lines.push('');
const picks = [
  'militia',
  'spider-rider',
  'poison-bat',
  'dragoon-rider',
  'griffin-rider',
  'harpy',
  'rifleman',
  'nv_battleship',
].filter((id) => s.unitTypes[id]);
lines.push('| 兵种 | 自己那代 | 2 代 | 3 代 | 4 代 | 5 代 | 6 代 | 6 代 / 自己那代 |');
lines.push('|---|---|---|---|---|---|---|---|');
for (const id of picks) {
  const d = s.unitTypes[id]!;
  const own = unitEfficiency(d, d.cost, { ...NEUTRAL_CONTEXT, era: d.era });
  const cells = [2, 3, 4, 5, 6].map((e) =>
    unitEfficiency(d, d.cost, { ...NEUTRAL_CONTEXT, era: e }).toFixed(2),
  );
  const six = Number(cells[4]);
  lines.push(
    `| ${d.name} | ${d.era} 代 ${own.toFixed(2)} | ${cells.join(' | ')} | ${((six / own - 1) * 100).toFixed(0)}% |`,
  );
}
lines.push('');
lines.push('读法：最后一列是"把它扔进 6 代战场还剩多少价值"。负得越多，说明它越是时代限定品。');

mkdirSync('docs', { recursive: true });
writeFileSync('docs/ERA-SCORES.md', lines.join('\n') + '\n', 'utf-8');
console.log(`谱表对账：${mismatch} 代偏差（共 6 代）`);
console.log('→ docs/ERA-SCORES.md');
