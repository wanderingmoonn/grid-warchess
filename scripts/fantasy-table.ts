/**
 * 奇想扩展全兵种评分表：把 `unit-value.ts` 的公式直接跑一遍，输出一张表。
 *
 * 为什么要有这个脚本：数值讨论里最容易发生的争执是"这个兵到底值不值"，
 * 而双方各自心算的公式不一样。这张表就是**唯一口径的一次性快照**——
 * 谁不同意，改公式、重跑，别在聊天里对数字。
 *
 * 输出：
 *   · docs/FANTASY-SCORES.md   —— 带口径说明的全量 markdown 表 + 排名
 *   · results/fantasy-scores.csv —— 同数据的 CSV（丢进 Excel 就能排序筛选）
 *
 * 用法：npm run fantasy:table
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { createMatch, DEFAULT_CONFIG } from '../src/core/setup.ts';
import { availableExpansions } from '../src/core/expansions.ts';
import {
  abilityValue,
  combatCore,
  unitEfficiency,
  unitPower,
  NEUTRAL_CONTEXT,
  LANCHESTER_EXP,
  PRICE_EXP,
} from '../src/core/unit-value.ts';
import type { UnitTypeDef } from '../src/core/types.ts';

const PUSH = { tempo: 1, visionCoverage: 0.4, fog: true };
const TURTLE = { tempo: -1, visionCoverage: 0.4, fog: true };

const expansions = availableExpansions();
const fantasy = expansions.filter((e) => e.id.startsWith('fantasy'));
if (fantasy.length === 0) throw new Error('没找到奇想扩展');

const s = createMatch({ ...DEFAULT_CONFIG, startEra: 6, expansionIds: expansions.map((e) => e.id) }, 1);

/** id → 所属扩展：兵种表本身不带包名，只能从扩展的 units 反查 */
const packOf = new Map<string, string>();
for (const e of expansions) for (const u of e.units ?? []) packOf.set(u.id, e.id);

interface Row {
  d: UnitTypeDef;
  pack: string;
  power: number;
  push: number;
  turtle: number;
  eff: number;
  ability: number;
  dps: number;
  ehp: number;
  note: string;
}

const rows: Row[] = [];
for (const e of fantasy) {
  for (const u of e.units ?? []) {
    const d = s.unitTypes[u.id];
    if (!d) continue;
    const core = combatCore(d);
    const notes: string[] = [];
    if (d.hero) notes.push('英雄');
    if ((d as { summonedOnly?: boolean }).summonedOnly) notes.push('只能召唤');
    if (d.category !== 'combat') notes.push(d.category === 'economy' ? '经济' : d.category === 'builder' ? '工程' : d.category);
    rows.push({
      d,
      pack: e.id.replace('fantasy-', ''),
      power: unitPower(d, NEUTRAL_CONTEXT),
      push: unitPower(d, PUSH),
      turtle: unitPower(d, TURTLE),
      eff: unitEfficiency(d, d.cost),
      ability: abilityValue(d, NEUTRAL_CONTEXT),
      dps: core.dps,
      ehp: core.ehp,
      note: notes.join('·'),
    });
  }
}
// 同一兵种可能被多个包引用（例如英雄包复用），按 id 去重
const seen = new Set<string>();
const uniq = rows.filter((r) => (seen.has(r.d.id) ? false : (seen.add(r.d.id), true)));

const PACK_ORDER = ['core', 'knights', 'beasts', 'arcane', 'heroes'];
uniq.sort((a, b) => {
  const pa = PACK_ORDER.indexOf(a.pack);
  const pb = PACK_ORDER.indexOf(b.pack);
  if (pa !== pb) return pa - pb;
  if (a.d.era !== b.d.era) return a.d.era - b.d.era;
  return b.d.cost - a.d.cost;
});

const n = (x: number): string => x.toFixed(0);
const f2 = (x: number): string => x.toFixed(2);
const rank = (list: Row[]): Map<string, number> => {
  const sorted = [...list].sort((a, b) => b.eff - a.eff);
  return new Map(sorted.map((r, i) => [r.d.id, i + 1]));
};
const effRank = rank(uniq.filter((r) => r.d.category === 'combat' && !r.note.includes('只能召唤')));

const lines: string[] = [];
lines.push('# 奇想扩展全兵种评分表');
lines.push('');
lines.push(`> 由 \`npm run fantasy:table\` 从 \`src/core/unit-value.ts\` 直接算出，不是手抄。`);
lines.push('>');
lines.push('> 口径：');
lines.push('>');
lines.push(
  [
    '> ```',
    '> 输出 = 物理 max(0, 攻 − 靶子护甲) + 魔法 max(0, 魔攻 − 靶子魔抗)，按三档靶子加权；',
    '>        带破甲的兵，靶子护甲砍半',
    '> 生存 = 血 × Π(名义攻击 / 实受伤害)^w，威胁谱 = 轻 20(0.32) / 中 45(0.26) /',
    '>        重 80+破甲(0.20) / 法师 10 物 + 28 魔(0.22)',
    `> 战力 = (输出 × 生存)^${LANCHESTER_EXP} × 射程 × 移速 × 视野 × (1 + 能力)`,
    `> 性价比 = 战力 / 价格^${PRICE_EXP}`,
    '> ```',
  ].join('\n'),
);
lines.push('>');
lines.push('> · **战力**：均势口径（`tempo = 0`）。**压上/龟缩**：同一兵在 `push` / `turtle` 姿态下的战力，');
lines.push('>   两者之差就是"这个兵多依赖主动进攻"——移速、飞行、冲锋、掠空在压上时更贵，');
lines.push('>   盾墙、回血、护甲光环在龟缩时更贵。');
lines.push('> · **采购分**：AI 采购打分里"性价比"那一段的实数，`min(26, 性价比 × 3)`；');
lines.push('>   带 ★ 的是撞了封顶的——它们之间的性价比差异在 AI 眼里已经**不存在**了。');
lines.push('> · **名次**：只在本表这 64 个奇想战斗兵内部排序，不是全兵种表的名次。');
lines.push('> · 只说"贵不贵"，不说"该不该买"：治疗光环、召唤、破城这些价值按权重近似计入 `能力` 一列，');
lines.push('>   但它们的真正价值取决于阵容，表里看不出来。');
lines.push('');
lines.push(`共 **${uniq.length}** 个兵种（奇想五包：${fantasy.map((e) => e.name).join('、')}）。`);
lines.push('');

const head =
  '| # | 名称 | id | 包 | 代 | 价 | 攻 | 魔攻 | 血 | 甲 | 抗 | 移 | 视 | 射 | 段 | 能力 | 输出 | 生存 | 战力 | 压上 | 龟缩 | 性价比 | 采购分 | 名次 | 备注 |';
const sep =
  '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|';
lines.push(head, sep);

uniq.forEach((r, i) => {
  const d = r.d;
  lines.push(
    `| ${i + 1} | ${d.name} | ${d.id} | ${r.pack} | ${d.era} | ${d.cost} | ${d.atk} | ${d.magicAtk ?? 0} | ${d.maxHp} | ${d.armor} | ${d.magicRes ?? 0} | ${d.move} | ${d.vision} | ${d.range ?? 1} | ${d.burst ?? 1} | ${f2(r.ability)} | ${n(r.dps)} | ${n(r.ehp)} | ${n(r.power)} | ${n(r.push)} | ${n(r.turtle)} | ${f2(r.eff)} | ${n(Math.min(26, r.eff * 3))}${r.eff * 3 >= 26 ? '★' : ''} | ${effRank.get(d.id) ?? '—'} | ${r.note} |`,
  );
});

const combat = uniq.filter((r) => r.d.category === 'combat' && !r.note.includes('只能召唤'));
const byEff = [...combat].sort((a, b) => b.eff - a.eff);
lines.push('');
lines.push(`## 性价比前 10（战斗兵 ${combat.length} 个里比）`);
lines.push('');
lines.push('| 名次 | 兵种 | 价 | 战力 | 性价比 | 压上/龟缩 战力 |');
lines.push('|---|---|---|---|---|---|');
for (const r of byEff.slice(0, 10)) {
  lines.push(`| ${effRank.get(r.d.id)} | ${r.d.name} | ${r.d.cost} | ${n(r.power)} | ${f2(r.eff)} | ${n(r.push)} / ${n(r.turtle)} |`);
}
lines.push('');
lines.push('## 性价比后 10');
lines.push('');
lines.push('| 名次 | 兵种 | 价 | 战力 | 性价比 | 压上/龟缩 战力 |');
lines.push('|---|---|---|---|---|---|');
for (const r of byEff.slice(-10)) {
  lines.push(`| ${effRank.get(r.d.id)} | ${r.d.name} | ${r.d.cost} | ${n(r.power)} | ${f2(r.eff)} | ${n(r.push)} / ${n(r.turtle)} |`);
}
lines.push('');
lines.push('## 最"看局面"的 8 个（压上 / 龟缩 战力之比）');
lines.push('');
lines.push('| 兵种 | 压上 | 龟缩 | 比值 | 为什么 |');
lines.push('|---|---|---|---|---|');
for (const r of [...combat].sort((a, b) => b.push / b.turtle - a.push / a.turtle).slice(0, 8)) {
  const why = (r.d.abilities ?? []).join('、') || (r.d.flight ? '飞行' : '—');
  lines.push(`| ${r.d.name} | ${n(r.push)} | ${n(r.turtle)} | ${f2(r.push / r.turtle)} | ${why} |`);
}

const capped = combat.filter((r) => r.eff * 3 >= 26).sort((a, b) => b.eff - a.eff);
lines.push('');
lines.push(`## 撞封顶的 ${capped.length} 个（性价比 ≥ 8.67，采购分一律 26）`);
lines.push('');
lines.push('| 兵种 | 价 | 性价比 | 超出封顶 |');
lines.push('|---|---|---|---|');
for (const r of capped) lines.push(`| ${r.d.name} | ${r.d.cost} | ${f2(r.eff)} | ${((r.eff / (26 / 3) - 1) * 100).toFixed(0)}% |`);
lines.push('');
lines.push('> 这一档在 AI 眼里是**平的**：邪龙王（10.40）和恶魔（8.78）拿一样的分，');
lines.push('> 它们之间只靠"代差加分、角色模板、攒钱目标"来区分。');

mkdirSync('docs', { recursive: true });
mkdirSync('results', { recursive: true });
writeFileSync('docs/FANTASY-SCORES.md', lines.join('\n') + '\n', 'utf-8');

const csv: string[] = [
  '名称,id,包,代,类别,价,攻,魔攻,血,甲,魔抗,移,视野,射程,段数,能力,输出,生存,战力,压上,龟缩,性价比,名次,备注',
];
for (const r of uniq) {
  const d = r.d;
  csv.push(
    [
      d.name, d.id, r.pack, d.era, d.category, d.cost, d.atk, d.magicAtk ?? 0, d.maxHp, d.armor,
      d.magicRes ?? 0, d.move, d.vision, d.range ?? 1, d.burst ?? 1, f2(r.ability), r.dps.toFixed(1),
      r.ehp.toFixed(1), r.power.toFixed(1), r.push.toFixed(1), r.turtle.toFixed(1), f2(r.eff),
      effRank.get(d.id) ?? '', r.note,
    ].join(','),
  );
}
writeFileSync('results/fantasy-scores.csv', csv.join('\n') + '\n', 'utf-8');

console.log(
  `奇想兵种 ${uniq.length} 个（战斗 ${combat.length}）· 战力中位 ${n(
    [...combat].sort((a, b) => a.power - b.power)[Math.floor(combat.length / 2)]!.power,
  )} · 性价比中位 ${f2([...combat].sort((a, b) => a.eff - b.eff)[Math.floor(combat.length / 2)]!.eff)}`,
);
console.log('→ docs/FANTASY-SCORES.md');
console.log('→ results/fantasy-scores.csv');
