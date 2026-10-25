/**
 * 时代兵种包 · 平衡报告生成器。
 *
 * 把 balance-report 跑出来的 eraN.json / baseN.json 聚合成一份人看的报告。
 * 所有数字都从 JSON 重算，不手抄——手抄的报表三天后就和数据对不上了。
 *
 * 用法：
 *   node --experimental-strip-types scripts/pack-report.ts
 * 输出：
 *   results/packs/report.md
 *
 * 前提：先跑过五个模组 + 五个基线的 balance-report（见 README / 报告末尾的命令表）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { UNIT_TYPES } from '../src/core/config.ts';
import { ERA_PACKS } from '../src/core/era-packs.ts';
import { nonWinCount } from './report-outcomes.ts';
import { describeOutcomes, describePackOverview, exchangeVerdict, percentageChange } from './pack-report-summary.ts';
import type { PackOverviewEntry } from './pack-report-summary.ts';

const DIR = 'results/packs';
const OUT = path.join(DIR, 'report.md');

interface TypeStat {
  type: string;
  name: string;
  era: number;
  category: string;
  cost: number;
  built: number;
  spend: number;
  share: number;
  dealt: number;
  taken: number;
  ratio: number | null;
  per100: number;
  per100Taken: number;
  kills: number;
}

interface Payload {
  era: number;
  size: number;
  games: number;
  baseSeed: number;
  summary: {
    aWins: number;
    bWins: number;
    draws: number;
    unresolved?: number;
    aRate: number;
    turnsAvg: number;
    recruitsPerGame: number;
  };
  stats: TypeStat[];
}

interface GroupMetric {
  n: number;
  built: number;
  spend: number;
  dealt: number;
  taken: number;
  per100: number;
  per100Taken: number;
  ratio: number | null;
}

const PACKS = [
  {
    era: 1,
    id: 'pack-antiquity',
    theme: '方阵、战车战象、攻城槌与弩炮',
    name: '古典会战',
    eraName: '古典',
    note:
      '这一包的重心是**重甲与攻城**：重装步兵/军团兵把正面顶住，投石兵和标枪兵把便宜的远程补上，' +
      '攻城槌和弩炮提供专门的攻城职能。交换数据不能单独判断肉盾与攻城单位的价值。',
  },
  {
    era: 2,
    id: 'pack-medieval',
    theme: '破甲、长矛方阵、投石机与攻城塔',
    name: '中世兵备',
    eraName: '中世',
    note:
      '中世的关键词是**破甲**：弩手和双手剑士负责把对方的甲剥掉，瑞士长矛兵负责站住，' +
      '骑射手提供机动，投石机与攻城塔负责攻城。当前样本结果见下面动态生成的指标。',
  },
  {
    era: 3,
    id: 'pack-gunpowder',
    theme: '线列齐射、散兵、加农炮与棱堡',
    name: '火药列国',
    eraName: '火药',
    note:
      '火药包的定位是**火力层次**：线列步兵正面齐射，猎兵负责视野和点杀，龙骑兵/胸甲骑兵负责冲击，' +
      '攻城加农炮与长管炮负责拆工事。单位输出需要结合射程、反击和样本规模解读。',
  },
  {
    era: 4,
    id: 'pack-industry',
    theme: '堑壕、毒气、列车炮与初代坦克',
    name: '工业绞肉机',
    eraName: '工业',
    note:
      '工业包是**阵地战**：毒气兵与火焰喷射器负责清堑壕，榴弹炮/列车炮负责曲射，' +
      '马克 I 坦克第一次把"装甲"变成独立的战术变量，机枪碉堡和铁丝网把地图切成小块。' +
      '伴随火力与高耐久工事需要同时观察野战交换、推进速度和城市争夺。',
  },
  {
    era: 5,
    id: 'pack-modern',
    theme: '合成兵种、喀秋莎、重坦与地堡',
    name: '现代合成兵',
    eraName: '现代',
    note:
      '现代包讲的是**合成**：伞兵/突击队找后排，反坦克炮专治重装甲，喀秋莎与自行火炮负责面杀伤，' +
      '重型坦克正面顶线，机枪地堡和反坦克拒马把防线做厚。它的单位最贵，也最容易出现样本不足。',
  },
];

function load(name: string): Payload {
  const p = path.join(DIR, name);
  if (!fs.existsSync(p)) throw new Error(`缺数据文件：${p}`);
  return JSON.parse(fs.readFileSync(p, 'utf8')) as Payload;
}

/** 只统计战斗单位：建筑/经济/建造本来就该 0 输出，混进来会把每百金拉平 */
function group(stats: TypeStat[], isPack: boolean): GroupMetric {
  const pick = stats.filter(
    (s) => (isPack ? !UNIT_TYPES[s.type] : !!UNIT_TYPES[s.type]) && s.category === 'combat' && s.built > 0,
  );
  const spend = pick.reduce((n, s) => n + s.spend, 0);
  const dealt = pick.reduce((n, s) => n + s.dealt, 0);
  const taken = pick.reduce((n, s) => n + s.taken, 0);
  return {
    n: pick.length,
    built: pick.reduce((n, s) => n + s.built, 0),
    spend,
    dealt,
    taken,
    per100: spend > 0 ? (dealt / spend) * 100 : 0,
    per100Taken: spend > 0 ? (taken / spend) * 100 : 0,
    ratio: taken > 0 ? dealt / taken : null,
  };
}

const pct = (n: number) => `${(n * 100).toFixed(0)}%`;

const rows: string[] = [];
const sections: string[] = [];
const overview: PackOverviewEntry[] = [];
const paceRows: string[] = [];

for (const p of PACKS) {
  const run = load(`era${p.era}.json`);
  const base = load(`base${p.era}.json`);
  // 强弱对比必须在**同一批对局内**做：模组单位 vs 同一局里的原版单位。
  // 拿"基线局的原版"去比"模组局的模组"，两批局的阵容、地形、先后手都不同，
  // 比出来的差值有一半是随机性——基线只用来量节奏（回合数/未决率）。
  const gPack = group(run.stats, true);
  const gBase = group(run.stats, false);
  overview.push({ name: p.eraName, games: run.games, packRatio: gPack.ratio, vanillaRatio: gBase.ratio });
  paceRows.push(`| ${p.eraName} | ${base.summary.turnsAvg.toFixed(1)} | ${run.summary.turnsAvg.toFixed(1)} | ${percentageChange(base.summary.turnsAvg, run.summary.turnsAvg)} |`);

  rows.push(
    `| ${p.eraName} | ${run.size}×${run.size} | ${run.games} | ${base.summary.turnsAvg.toFixed(1)} → ${run.summary.turnsAvg.toFixed(1)} | ` +
      `${pct(nonWinCount(base.summary) / base.games)} → ${pct(nonWinCount(run.summary) / run.games)} | ` +
      `${gBase.ratio === null ? '-' : gBase.ratio.toFixed(2)} → ${gPack.ratio === null ? '-' : gPack.ratio.toFixed(2)} | ` +
      `${exchangeVerdict(gPack.ratio, gBase.ratio)} | ` +
      `${gBase.per100.toFixed(1)} → ${gPack.per100.toFixed(1)} | ${gBase.per100Taken.toFixed(1)} → ${gPack.per100Taken.toFixed(1)} |`,
  );

  const detail = fs.existsSync(path.join(DIR, `era${p.era}.md`))
    ? // 明细文件自带一行 `#### 古典（pack-xxx）`，本报告的标题已经有了，去掉免得重复
      fs.readFileSync(path.join(DIR, `era${p.era}.md`), 'utf8').replace(/^#{2,4}[^\n]*\n/, '')
    : '（缺明细表）';

  sections.push(
    [
      `### ${p.eraName} · ${p.name}（\`${p.id}\`）`,
      '',
      `${p.note}`,
      '',
      `- 战斗单位交换比：**${gPack.ratio === null ? '-' : gPack.ratio.toFixed(2)}**（原版同代 ${gBase.ratio === null ? '-' : gBase.ratio.toFixed(2)}）→ ${exchangeVerdict(gPack.ratio, gBase.ratio)}`,
      `- 每百金杀伤：${gPack.per100.toFixed(1)}（原版 ${gBase.per100.toFixed(1)}）　每百金抗伤：${gPack.per100Taken.toFixed(1)}（原版 ${gBase.per100Taken.toFixed(1)}）`,
      `- 历史回合数：${base.summary.turnsAvg.toFixed(1)} → ${run.summary.turnsAvg.toFixed(1)}；基线：${describeOutcomes(base.summary, base.games)}；模组：${describeOutcomes(run.summary, run.games)}`,
      '',
      detail.trim(),
      '',
    ].join('\n'),
  );
}

// 第 1 节的单位数是**算出来的**，不是手写的：之前手写过一次，漏了工业包的装甲列车，
// 表格写 13、实际 12，报告和代码对不上还是靠导出数据才发现的。
const packTable = PACKS.map((p) => {
  const n = ERA_PACKS.find((e) => e.id === p.id)?.units?.length ?? 0;
  const vanilla = Object.values(UNIT_TYPES).filter((d) => d.era === p.era).length;
  return `| ${p.eraName} | \`${p.id}\` | ${n} | ${vanilla} | ${n + vanilla} | ${p.theme} |`;
}).join('\n');

const report = `# 方格战棋 · 五个时代兵种扩展包 平衡测试报告

> 数据由 \`scripts/balance-report.ts\` 跑出、\`scripts/pack-report.ts\` 汇总。
> 摘要与总览指标由同一份 JSON 计算；文末命令可生成新样本，不能保证复现旧版本的数值。
> **历史报告**：现有 JSON 缺少代码提交与规则版本记录，基线和模组不保证由同一版本 AI 生成，不能当作当前 v5 合并版本的验证。

## 0. 一句话结论

${describePackOverview(overview)}

## 1. 包含什么

| 时代 | 包 id | 新增单位 | 原版同期 | 合计 | 主题 |
|---|---|---:|---:|---:|---|
${packTable}

每个包都是独立的扩展项，在开局面板里单独勾选；不勾选时对原版零影响
（不进场、不进 AI 候选、不进存档）。

## 2. 数值是怎么定的

先给每个单位算两个粗指标，再对照原版同代校准：

- **有效耐久 EHP = maxHp + 2 × armor**。伤害模型是"攻击 − 护甲"直接相减，所以 1 点护甲约等于 2 点血。
- **有效输出 = atk × 段数系数**，其中 \`burst\` 取段数、\`splash\` 取 \`1 + 0.5 × 溅射半径\`（溅射只吃一半伤害）。

原版同代的「每金耐久」带：古典 0.60~1.28、中世 0.29~0.71、火药 0.17~0.44、工业 0.22~0.38、现代 0.16~0.32。
新单位全部落在带内或**偏低**（不是偏高）：重甲的每金输出低、远程的每金耐久低、攻城器离开城墙近乎废铁。

一条硬约束：**古典包的战斗单位价格一律压在 60 金以内**。原因是开局白送的部队只从
\`era === 1 && category === 'combat'\` 的池子里按顺序取，且不看价钱——池子里有 110 金的战象，
开局就白送战象，整局基准会直接漂掉。所以宁可牺牲一点"贵气"。

## 3. 测试方法

- **引擎**：历史规则内核 + 高级 AI，双 AI 对轰，无人工干预。现有文件未记录提交和规则版本，无法确认与当前线上或本地引擎一致。
- **规模**：当前存档每包 30 局，起始种子 900，对应时代默认棋盘（古典 12×12、中世 16×16、火药及以上 20×20）；摘要的局数直接读取各 JSON。30 局仅是探索性样本，稀有兵种的招募数可能更少。
- **其它扩展固定开启** \`bloodbath\` + \`turn-order-comp\`，与项目既有平衡基线一致；只切换被测的时代包。
- **基线**：设计上应同代码、同种子、同局数、同其它扩展，仅切换时代包。现有 base1..5 与 era1..5 不能确认 AI 版本一致，回合数对照只作历史展示，不用于归因。
- **指标口径**（与 \`balance-report\` 一致）：
  - 只统计 \`ATTACK\` 动作造成的单位掉血；攻城打的是城市耐久，不计入单位交换。
  - 溅射算在开火方头上，反击算在防守方头上。
  - 开局白送的兵与后来招募的兵分开记账，本报告只采信**招募**出来的那部分（花过钱才算性价比）。
  - **每百金杀伤 = 总输出 / 总花费 × 100**；**每百金抗伤 = 总承伤 / 总花费 × 100**；
    **交换比 = 总输出 / 总承伤**（不含价格，也不覆盖攻城、经济、占路和获胜贡献，不能单独判定整体强弱）。
  - 旧 JSON 的 \`draws\` 可能包含达到模拟上限的未决局；只有显式提供 \`unresolved\` 的新数据才分别展示正式平局与未决。

## 4. 总览

| 时代 | 棋盘 | 局数 | 历史平均回合（基线→模组） | 平局/未决合计率 | 交换比（原版→模组） | 判定 | 每百金杀伤 | 每百金抗伤 |
|---|---:|---:|---|---|---|---|---|---|
${rows.join('\n')}

读法：交换比只比较模组对局内招募出来的两类单位；回合数使用另存的基线，其版本一致性未知。
每百金指标结合交换比、兵种职能、招募样本与先后手胜率一起查看。低输出的城墙不能用野战交换比衡量价值。

## 5. 分时代明细

下表每行一个兵种：价格、招募数、采用率、总输出/承伤、交换比、每百金杀伤/抗伤、击杀。
**招募数标 ⚠ 的是样本不足 10 个**，那两个比值基本是噪声，不要据此下结论。
"归属"列里"模组"= 本包新增，"原版"= 原有兵种（含升级后解锁的高时代单位）。

${sections.join('\n')}

## 6. 历史节奏对照（版本未配对）

| 时代 | 基线回合 | 模组回合 | 表面变化 |
|---|---:|---:|---:|
${paceRows.join('\n')}

这些变化同时可能受到 AI 版本、规则、单位定义和阵容选择影响，不能归因为时代包。
现有单位数据还不包含“堵住了几回合通路”“保护了多少城市”等指标，因此也不能从零输出断言城墙无效。

## 7. 遗留风险与重新验证

1. **同版本配对基准待重跑。** 用同一提交、同一规则、同一随机种子与其它扩展，分别开启/关闭兵种包，再比较胜率、正式平局、未决、回合数及攻城贡献。当前 v5 合并版尚未完成这组平衡验证。
2. **样本与先手效应。** 当前每包 30 局，需增加种子并做先后手/出生位配对。高价兵、水军及招募数不足 10 的单位，不能用单个比值下强弱结论。
3. **战术改变会改变数值表现。** 骑兵绕后、真实地形威胁和城墙策略会影响采用率与交换比；不能把旧 AI 下的短板直接解释为兵种缺陷。
4. **保留历史原始数据。** 本次仅重新汇总已有 JSON，没有重跑或补造对局。旧 \`draws\` 不自动改写为正式平局；新输出应分别保留 \`draws\` 和 \`unresolved\`。
5. **完整版本来源。** 后续样本应记录代码提交、规则版本、AI/预算配置、扩展列表与模拟上限，避免再次混用不可比的基线。

## 附：怎么重跑这份报告

\`\`\`bash
# 五个模组（每个 30 局）
for e in 1 2 3 4 5; do
  node --experimental-strip-types scripts/balance-report.ts --era $e --games 30 --seed 900 \\
    --expansions bloodbath,turn-order-comp,pack-<对应包> \\
    --md results/packs/era$e.md --out results/packs/era$e.json
done

# 五个基线（同样的种子和局数，只是不开时代包）
for e in 1 2 3 4 5; do
  node --experimental-strip-types scripts/balance-report.ts --era $e --games 30 --seed 900 \\
    --expansions bloodbath,turn-order-comp \\
    --md results/packs/base$e.md --out results/packs/base$e.json
done

# 汇总
node --experimental-strip-types scripts/pack-report.ts
\`\`\`
`;

fs.mkdirSync(DIR, { recursive: true });
fs.writeFileSync(OUT, report);
console.log(`写出 ${OUT}（${report.length} 字符）`);
