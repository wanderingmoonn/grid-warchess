/**
 * 奇想扩展全兵种总表：把"这个兵是什么、值多少、AI 到底买不买"压在一张表里。
 *
 * 为什么要有这个脚本：数值讨论里最容易发生的争执是"这个兵到底值不值"，
 * 而双方各自心算的公式不一样。这张表就是**唯一口径的一次性快照**——
 * 谁不同意，改公式、重跑，别在聊天里对数字。
 *
 * 2026-11-07 扩过一次，从"评分表"变成"总表"，加了三样东西：
 *   · **性价比旧**：AI 采购真正在用的那把尺子（`攻×√血×射程 / 价^0.8`）。
 *     只放新尺子，会出现"性价比高却零出场"的假象——AI 根本没看那一列。
 *   · **建造 火/信**：400 局双 AI 跑批里被造了多少次，火药批和信息化批分开列。
 *     两批必须分开：皇家骑兵只在火药批出现（62/0），圣剑勇者只在信息化批出现（23/421）。
 *   · **交换比**：累计输出 / 累计承伤。值不值是算的，打不打得动是量的。
 *
 * 输出：
 *   · docs/FANTASY-SCORES.md      —— 带口径说明的全量 markdown 表 + 排名
 *   · results/fantasy-scores.csv  —— 同数据的 CSV（丢进 Excel 就能排序筛选）
 *
 * 用法：npm run fantasy:table
 */
import { mkdirSync, writeFileSync } from 'node:fs';

import { availableExpansions } from '../src/core/expansions.ts';
import { createMatch, DEFAULT_CONFIG } from '../src/core/setup.ts';
import type { UnitTypeDef } from '../src/core/types.ts';
import {
  abilityValue,
  combatCore,
  LANCHESTER_EXP,
  NEUTRAL_CONTEXT,
  PRICE_EXP,
  unitEfficiency,
  unitPower,
} from '../src/core/unit-value.ts';
import {
  EMPTY_OBS,
  GAMES_PER_BATCH,
  observed,
  oldEfficiency,
  packMap,
} from './lib/fantasy-observed.ts';

const PUSH = { tempo: 1, visionCoverage: 0.4, fog: true };
const TURTLE = { tempo: -1, visionCoverage: 0.4, fog: true };

const expansions = availableExpansions();
const fantasy = expansions.filter((e) => e.id.startsWith('fantasy'));
if (fantasy.length === 0) throw new Error('没找到奇想扩展');

const s = createMatch({ ...DEFAULT_CONFIG, startEra: 6, expansionIds: expansions.map((e) => e.id) }, 1);

/** 兵种属于原五个子包里的哪一个（2026-11-04 合并后，扩展本身已经看不出分组） */
const PACKS = packMap();
/** id → 400 局的出场/战斗。没有样本的兵返回全 0，不是"没造过" */
const OBS = observed();
const GAMES = GAMES_PER_BATCH * 4;

type Unit = UnitTypeDef & { unlockCost?: number; summonedOnly?: boolean };

interface Row {
  d: Unit;
  pack: string;
  power: number;
  push: number;
  turtle: number;
  eff: number;
  oldEff: number;
  ability: number;
  dps: number;
  ehp: number;
  note: string;
  built: number;
  b3: number;
  b6: number;
  ratio: number;
}

const rows: Row[] = [];
for (const e of fantasy) {
  for (const u of e.units ?? []) {
    const d = s.unitTypes[u.id] as Unit | undefined;
    if (!d) continue;
    const core = combatCore(d);
    const notes: string[] = [];
    if (d.hero) notes.push('英雄');
    if (d.summonedOnly) notes.push('只能召唤');
    if (d.category !== 'combat') {
      notes.push(d.category === 'economy' ? '经济' : d.category === 'builder' ? '工程' : d.category);
    }
    const o = OBS.get(d.id) ?? EMPTY_OBS;
    rows.push({
      d,
      pack: PACKS.get(d.id) ?? '召唤',
      power: unitPower(d, NEUTRAL_CONTEXT),
      push: unitPower(d, PUSH),
      turtle: unitPower(d, TURTLE),
      eff: unitEfficiency(d, d.cost),
      oldEff: oldEfficiency(d, d.cost),
      ability: abilityValue(d, NEUTRAL_CONTEXT),
      dps: core.dps,
      ehp: core.ehp,
      note: notes.join('·'),
      built: o.built,
      b3: o.b3,
      b6: o.b6,
      ratio: o.ratio,
    });
  }
}
// 同一兵种可能被多个包引用（例如英雄包复用），按 id 去重
const seen = new Set<string>();
const uniq = rows.filter((r) => (seen.has(r.d.id) ? false : (seen.add(r.d.id), true)));

/** 按原来的注册顺序排：骑士团 → 荒兽 → 秘法 → 英雄 → 召唤，方便和兵种面板对照 */
const PACK_ORDER = ['骑士团', '荒兽', '秘法', '英雄', '召唤'];
uniq.sort((a, b) => {
  const pa = PACK_ORDER.indexOf(a.pack);
  const pb = PACK_ORDER.indexOf(b.pack);
  if (pa !== pb) return pa - pb;
  if (a.d.era !== b.d.era) return a.d.era - b.d.era;
  return b.d.cost - a.d.cost;
});

const n = (x: number): string => x.toFixed(0);
const f2 = (x: number): string => x.toFixed(2);
const rank = (list: Row[], key: 'eff' | 'oldEff'): Map<string, number> => {
  const sorted = [...list].sort((a, b) => b[key] - a[key]);
  return new Map(sorted.map((r, i) => [r.d.id, i + 1]));
};
const combat = uniq.filter((r) => r.d.category === 'combat' && !r.d.summonedOnly);
const effRank = rank(combat, 'eff');
const oldRank = rank(combat, 'oldEff');
/** AI 采购打分里"性价比"那一段：min(26, eff × EFF_SCALE)，EFF_SCALE = 3 */
const CAP = 26;
const buyScore = (r: Row): number => Math.min(CAP, r.oldEff * 3);

const packCount = new Map<string, number>();
for (const r of uniq) packCount.set(r.pack, (packCount.get(r.pack) ?? 0) + 1);

const lines: string[] = [];
const push = (x = ''): void => void lines.push(x);

push('# 奇想扩展全兵种总表');
push();
push('> 由 `npm run fantasy:table` 生成，不是手抄。**数值**来自当前代码，**出场/战斗**来自');
push(`> ${GAMES} 局双 AI 跑批（\`results/bf-modern*\`，${GAMES / 2} 局火药开局 + ${GAMES / 2} 局信息化开局，20×20）。`);
push();
push('## 口径');
push();
push('```');
push('输出 = 物理 max(0, 攻 − 靶子护甲) + 魔法 max(0, 魔攻 − 靶子魔抗)，按三档靶子加权；');
push('       带破甲的兵，靶子护甲砍半');
push('生存 = 血 × Π(名义攻击 / 实受伤害)^w，威胁谱 = 轻 20(0.32) / 中 45(0.26) /');
push('       重 80+破甲(0.20) / 法师 10 物 + 28 魔(0.22)');
push(`战力     = (输出 × 生存)^${LANCHESTER_EXP} × 射程 × 移速 × 视野 × (1 + 能力)`);
push(`性价比新 = 战力 / 价格^${PRICE_EXP}              ← 报表 / 审计口径（unit-value.ts）`);
push('性价比旧 = 攻×√血×射程 / 价格^0.8        ← **AI 采购默认用的这一把**（ai.ts 的 oldEfficiency）');
push('采购分   = min(26, 性价比旧 × 3)          ← AI 采购打分里"划不划算"那一段的实数');
push('建造     = 400 局里被招募/建造的次数，`火药批/信息化批` 各 200 局（不含召唤、分裂、孵化）');
push('交换比   = 累计输出伤害 / 累计承受伤害，> 1 表示换血换得赚');
push('```');
push();
push('**两把尺子必须分清**，否则整张表会被读错：');
push('AI 买不买看的是"性价比旧"，它完全不看移速、视野、能力，价格指数还更陡（0.8 对 0.55）。');
push('"性价比新"只在报表和审计里出现。同一行里两个数差得远，本身就是一条信息：');
push('差得越多，说明这个兵的价值越集中在"AI 算不出来的部分"（机动、射程外的东西、光环）。');
push();
push('> · **战力**：均势口径（`tempo = 0`）。**压上/龟缩**：同一兵在 `push` / `turtle` 姿态下的战力，');
push('>   两者之差就是"这个兵多依赖主动进攻"——移速、飞行、冲锋、掠空在压上时更贵，');
push('>   盾墙、回血、护甲光环在龟缩时更贵。');
push(`> · **名次**：按性价比新排，只在本表这 ${combat.length} 个奇想战斗兵内部比，不是全兵种表的名次。`);
push('> · 只说"贵不贵"，不说"该不该买"：治疗光环、召唤、破城这些价值按权重近似计入 `能力` 一列，');
push('>   但它们的真正价值取决于阵容，表里看不出来。');
push('> · **0 建造有两种意思**：真的一次没被造过，或者这一档在两批开局里都摸不到。');
push('>   后者看"只能召唤"那一列——召唤物本来就不进兵营，建造恒为 0。');
push();
push(
  `共 **${uniq.length}** 个兵种（${[...packCount.entries()].map(([k, v]) => `${k} ${v}`).join(' · ')}）。`,
);
push();

push(
  '| # | 名称 | id | 包 | 代 | 价 | 解锁 | 攻 | 魔攻 | 血 | 甲 | 抗 | 移 | 视 | 射 | 段 | 能力 | 输出 | 生存 | 战力 | 压上 | 龟缩 | 性价比新 | 性价比旧 | 采购分 | 建造 火/信 | 交换比 | 名次 | 备注 |',
);
push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');

uniq.forEach((r, i) => {
  const d = r.d;
  const score = buyScore(r);
  push(
    `| ${i + 1} | ${d.name} | ${d.id} | ${r.pack} | ${d.era} | ${d.cost} | ${d.unlockCost ?? '—'} | ` +
      `${d.atk} | ${d.magicAtk ?? 0} | ${d.maxHp} | ${d.armor} | ${d.magicRes ?? 0} | ` +
      `${d.move} | ${d.vision} | ${d.range ?? 1} | ${d.burst ?? 1} | ${f2(r.ability)} | ` +
      `${n(r.dps)} | ${n(r.ehp)} | ${n(r.power)} | ${n(r.push)} | ${n(r.turtle)} | ` +
      `${f2(r.eff)} | ${f2(r.oldEff)} | ${n(score)}${score >= CAP ? '★' : ''} | ` +
      `${r.b3}/${r.b6} | ${r.built > 0 ? f2(r.ratio) : '—'} | ${effRank.get(d.id) ?? '—'} | ${r.note} |`,
  );
});
push();

const byEff = [...combat].sort((a, b) => b.eff - a.eff);
push(`## 性价比前 10（战斗兵 ${combat.length} 个里比，新尺子）`);
push();
push('| 名次 | 兵种 | 价 | 战力 | 性价比新 | 性价比旧 | 建造 火/信 | 交换比 |');
push('|---|---|---|---|---|---|---|---|');
for (const r of byEff.slice(0, 10)) {
  push(
    `| ${effRank.get(r.d.id)} | ${r.d.name} | ${r.d.cost} | ${n(r.power)} | ${f2(r.eff)} | ${f2(r.oldEff)} | ${r.b3}/${r.b6} | ${r.built > 0 ? f2(r.ratio) : '—'} |`,
  );
}
push();
push('## 性价比后 10');
push();
push('| 名次 | 兵种 | 价 | 战力 | 性价比新 | 性价比旧 | 建造 火/信 | 交换比 |');
push('|---|---|---|---|---|---|---|---|');
for (const r of byEff.slice(-10)) {
  push(
    `| ${effRank.get(r.d.id)} | ${r.d.name} | ${r.d.cost} | ${n(r.power)} | ${f2(r.eff)} | ${f2(r.oldEff)} | ${r.b3}/${r.b6} | ${r.built > 0 ? f2(r.ratio) : '—'} |`,
  );
}

push();
push('## AI 眼里最划算 / 最不划算的 10 个（旧尺子，就是它真正在比的那一列）');
push();
push('| 名次 | 兵种 | 价 | 性价比旧 | 采购分 | 建造 火/信 | 备注 |');
push('|---|---|---|---|---|---|---|');
const byOld = [...combat].sort((a, b) => b.oldEff - a.oldEff);
for (const r of [...byOld.slice(0, 10)]) {
  push(
    `| ${oldRank.get(r.d.id)} | ${r.d.name} | ${r.d.cost} | ${f2(r.oldEff)} | ${n(buyScore(r))} | ${r.b3}/${r.b6} | ${r.note} |`,
  );
}
push('| … | | | | | | |');
for (const r of [...byOld.slice(-10)]) {
  push(
    `| ${oldRank.get(r.d.id)} | ${r.d.name} | ${r.d.cost} | ${f2(r.oldEff)} | ${n(buyScore(r))} | ${r.b3}/${r.b6} | ${r.note} |`,
  );
}

push();
push('## 最"看局面"的 8 个（压上 / 龟缩 战力之比）');
push();
push('| 兵种 | 压上 | 龟缩 | 比值 | 为什么 |');
push('|---|---|---|---|---|');
for (const r of [...combat].sort((a, b) => b.push / b.turtle - a.push / a.turtle).slice(0, 8)) {
  const why = (r.d.abilities ?? []).join('、') || (r.d.flight ? '飞行' : '—');
  push(`| ${r.d.name} | ${n(r.push)} | ${n(r.turtle)} | ${f2(r.push / r.turtle)} | ${why} |`);
}

/*
 * 封顶这一节按**旧尺子**算，因为封顶只发生在 AI 的采购分上。
 * 老版本这一节按新尺子算，于是列了七八个"撞顶"的兵，还写着
 * "这一档在 AI 眼里是平的"——可 AI 根本不看新尺子，那句话是错的。
 * 按旧尺子算，奇想包里只有召唤物摸得到 26，正文里说清楚。
 */
const capped = combat.filter((r) => buyScore(r) >= CAP).sort((a, b) => b.oldEff - a.oldEff);
push();
push(`## 撞封顶的 ${capped.length} 个（性价比旧 ≥ ${f2(CAP / 3)}，采购分一律 ${CAP}）`);
push();
if (capped.length === 0) {
  push('没有。也就是说在 AI 真正在用的那把尺子上，奇想包的战斗兵**没有一个是算"封顶"的**——');
  push('采购分全部由各自的性价比决定，不存在"分数被抹平、只靠代差加分区分"的情况。');
} else {
  push('| 兵种 | 价 | 性价比旧 | 超出封顶 | 建造 火/信 |');
  push('|---|---|---|---|---|');
  for (const r of capped) {
    push(
      `| ${r.d.name} | ${r.d.cost} | ${f2(r.oldEff)} | ${((r.oldEff / (CAP / 3) - 1) * 100).toFixed(0)}% | ${r.b3}/${r.b6} |`,
    );
  }
  push();
  if (capped.length >= 2) {
    push('> 这一档在 AI 眼里是**平的**：超出封顶之后再划算也拿一样的分，');
    push('> 它们之间只靠"代差加分、角色模板、攒钱目标"来区分。');
  } else {
    push('> 只有一个兵摸到封顶，谈不上"被抹平"——它的分已经顶住了，');
    push('> 再涨性价比也不会让它更受青睐，想让它更强只能改别的项。');
  }
}

const zero = combat.filter((r) => r.built === 0);
push();
push(`## 400 局里零建造的 ${zero.length} 个`);
push();
if (zero.length === 0) push('没有。');
else {
  push(`| 兵种 | 代 | 价 | 性价比旧 | 采购分 | 交换比 | 备注 |`);
  push('|---|---|---|---|---|---|---|');
  for (const r of [...zero].sort((a, b) => a.d.cost - b.d.cost)) {
    push(
      `| ${r.d.name} | ${r.d.era} | ${r.d.cost}${r.d.unlockCost ? ` +解锁${r.d.unlockCost}` : ''} | ` +
        `${f2(r.oldEff)} | ${n(buyScore(r))} | ${r.built > 0 ? f2(r.ratio) : '—'} | ${r.note} |`,
    );
  }
  push();
  push('零建造分三种，别混：**被同代替身挤掉**（看 `docs/FANTASY-OVERLAP.md` 的坑位表）、');
  push('**贵到 AI 攒不出**（解锁费 + 造价一次掏空的那几个英雄）、**这一档两批都摸不到**。');
}

mkdirSync('docs', { recursive: true });
mkdirSync('results', { recursive: true });
writeFileSync('docs/FANTASY-SCORES.md', `${lines.join('\n')}\n`, 'utf-8');

const csv: string[] = [
  '名称,id,包,代,类别,价,解锁费,攻,魔攻,血,甲,魔抗,移,视野,射程,段数,能力,输出,生存,战力,压上,龟缩,性价比新,性价比旧,采购分,建造火药批,建造信息化批,建造合计,交换比,名次,备注',
];
for (const r of uniq) {
  const d = r.d;
  csv.push(
    [
      d.name, d.id, r.pack, d.era, d.category, d.cost, d.unlockCost ?? '', d.atk, d.magicAtk ?? 0,
      d.maxHp, d.armor, d.magicRes ?? 0, d.move, d.vision, d.range ?? 1, d.burst ?? 1,
      f2(r.ability), r.dps.toFixed(1), r.ehp.toFixed(1), r.power.toFixed(1), r.push.toFixed(1),
      r.turtle.toFixed(1), f2(r.eff), f2(r.oldEff), n(buyScore(r)), r.b3, r.b6, r.built,
      r.built > 0 ? r.ratio.toFixed(2) : '', effRank.get(d.id) ?? '', r.note,
    ].join(','),
  );
}
writeFileSync('results/fantasy-scores.csv', `${csv.join('\n')}\n`, 'utf-8');

const median = (list: number[]): number => [...list].sort((a, b) => a - b)[Math.floor(list.length / 2)]!;
console.log(
  `奇想兵种 ${uniq.length} 个（战斗 ${combat.length}）· 战力中位 ${n(median(combat.map((r) => r.power)))} · ` +
    `性价比新中位 ${f2(median(combat.map((r) => r.eff)))} · 性价比旧中位 ${f2(median(combat.map((r) => r.oldEff)))} · ` +
    `零建造 ${zero.length} 个`,
);
console.log('→ docs/FANTASY-SCORES.md');
console.log('→ results/fantasy-scores.csv');
