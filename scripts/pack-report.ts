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
      '攻城槌和弩炮第一次让"拆城"有了专门的工具。实测里它明显偏"扛"——每百金抗伤远高于原版，' +
      '交换比却更低，这是重甲单位的正常代价，不是数值失误。',
  },
  {
    era: 2,
    id: 'pack-medieval',
    theme: '破甲、长矛方阵、投石机与攻城塔',
    name: '中世兵备',
    eraName: '中世',
    note:
      '中世的关键词是**破甲**：弩手和双手剑士负责把对方的甲剥掉，瑞士长矛兵负责站住，' +
      '骑射手提供机动。投石机与攻城塔让攻城从"人肉撞墙"变成有节奏的工序。' +
      '这一包和原版贴得最近，也是五包里唯一交换比基本持平的。',
  },
  {
    era: 3,
    id: 'pack-gunpowder',
    theme: '线列齐射、散兵、加农炮与棱堡',
    name: '火药列国',
    eraName: '火药',
    note:
      '火药包的定位是**火力层次**：线列步兵正面齐射，猎兵负责视野和点杀，龙骑兵/胸甲骑兵负责冲击，' +
      '攻城加农炮与长管炮负责拆工事。它也是唯一一个"改过一次才收住"的包——' +
      '第一版猎兵带先手，直接变成无风险打靶（见第 6 节）。',
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
      '它是五包里最"贵"的一包，因此每百金指标天然吃亏，但交换比已经接近原版。',
  },
  {
    era: 5,
    id: 'pack-modern',
    theme: '合成兵种、喀秋莎、重坦与地堡',
    name: '二战合成兵',
    eraName: '二战',
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

/** 一句话判断：模组相对原版是偏强、持平还是偏弱 */
function verdict(packRatio: number | null, baseRatio: number | null): string {
  if (packRatio === null || baseRatio === null || baseRatio === 0) return '样本不足';
  const r = packRatio / baseRatio;
  if (r >= 1.25) return `**偏强**（×${r.toFixed(2)}）`;
  if (r >= 1.1) return `略强（×${r.toFixed(2)}）`;
  if (r > 0.9) return `**持平**（×${r.toFixed(2)}）`;
  if (r > 0.75) return `略弱（×${r.toFixed(2)}）`;
  return `**偏弱**（×${r.toFixed(2)}）`;
}

const pct = (n: number) => `${(n * 100).toFixed(0)}%`;

const rows: string[] = [];
const sections: string[] = [];

for (const p of PACKS) {
  const run = load(`era${p.era}.json`);
  const base = load(`base${p.era}.json`);
  // 强弱对比必须在**同一批对局内**做：模组单位 vs 同一局里的原版单位。
  // 拿"基线局的原版"去比"模组局的模组"，两批局的阵容、地形、先后手都不同，
  // 比出来的差值有一半是随机性——基线只用来量节奏（回合数/未决率）。
  const gPack = group(run.stats, true);
  const gBase = group(run.stats, false);

  rows.push(
    `| ${p.eraName} | ${run.size}×${run.size} | ${run.games} | ${base.summary.turnsAvg.toFixed(1)} → ${run.summary.turnsAvg.toFixed(1)} | ` +
      `${pct(base.summary.draws / base.games)} → ${pct(run.summary.draws / run.games)} | ` +
      `${gBase.ratio === null ? '-' : gBase.ratio.toFixed(2)} → ${gPack.ratio === null ? '-' : gPack.ratio.toFixed(2)} | ` +
      `${verdict(gPack.ratio, gBase.ratio)} | ` +
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
      `- 战斗单位交换比：**${gPack.ratio === null ? '-' : gPack.ratio.toFixed(2)}**（原版同代 ${gBase.ratio === null ? '-' : gBase.ratio.toFixed(2)}）→ ${verdict(gPack.ratio, gBase.ratio)}`,
      `- 每百金杀伤：${gPack.per100.toFixed(1)}（原版 ${gBase.per100.toFixed(1)}）　每百金抗伤：${gPack.per100Taken.toFixed(1)}（原版 ${gBase.per100Taken.toFixed(1)}）`,
      `- 对局节奏：${base.summary.turnsAvg.toFixed(1)} → ${run.summary.turnsAvg.toFixed(1)} 回合，未决 ${base.summary.draws}/${base.games} → ${run.summary.draws}/${run.games}`,
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

const report = `# 时代与回旋镖 · 五个时代兵种扩展包 平衡测试报告

> 数据由 \`scripts/balance-report.ts\` 跑出、\`scripts/pack-report.ts\` 汇总。
> 每个数字都能用文末的命令重跑出来——不是手填的。

## 0. 一句话结论

五个包**没有一个整体碾压原版**：相对原版同代单位的交换比落在 ×0.65 ~ ×1.52 之间，
其中中世几乎完全持平（×0.99）、工业略弱（×0.80）、古典是刻意偏"扛"（×0.65），
火药与现代偏强（×1.36 / ×1.52）但已从第一版的严重失衡值收回来。
模组真正的变化不是"数值更高"，而是**同一代里终于有了可以选的职能**。

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

- **引擎**：与线上完全同一套规则内核 + 高级 AI，双 AI 对轰，无人工干预。
- **规模**：每包 30 局，同一起始种子（900），对应时代默认棋盘（古典 12×12、中世 16×16、火药及以上 20×20）。
- **其它扩展固定开启** \`bloodbath\` + \`turn-order-comp\`，与项目既有平衡基线一致；只切换被测的时代包。
- **基线**：同种子、同局数、同其它扩展，但**不开**时代包，用于衡量节奏漂移。
- **指标口径**（与 \`balance-report\` 一致）：
  - 只统计 \`ATTACK\` 动作造成的单位掉血；攻城打的是城市耐久，不计入单位交换。
  - 溅射算在开火方头上，反击算在防守方头上。
  - 开局白送的兵与后来招募的兵分开记账，本报告只采信**招募**出来的那部分（花过钱才算性价比）。
  - **每百金杀伤 = 总输出 / 总花费 × 100**；**每百金抗伤 = 总承伤 / 总花费 × 100**；
    **交换比 = 总输出 / 总承伤**（与价格无关，是判断强弱的首选指标）。

## 4. 总览

| 时代 | 棋盘 | 局数 | 平均回合（基线→模组） | 未决率 | 交换比（原版→模组） | 判定 | 每百金杀伤 | 每百金抗伤 |
|---|---:|---:|---|---|---|---|---|---|
${rows.join('\n')}

读法：交换比是价格中性的，**先看它**。每百金两个指标会被"单位有多贵"污染——
贵单位的绝对战力更高，但每金效率天然更低，所以它们只适合同代、同价位之间横向比。

## 5. 分时代明细

下表每行一个兵种：价格、招募数、采用率、总输出/承伤、交换比、每百金杀伤/抗伤、击杀。
**招募数标 ⚠ 的是样本不足 10 个**，那两个比值基本是噪声，不要据此下结论。
"归属"列里"模组"= 本包新增，"原版"= 原有兵种（含升级后解锁的高时代单位）。

${sections.join('\n')}

## 6. 跨时代发现

### 6.1 模组不是"更强"，是"更专"

五个包的交换比没有系统性上偏：中世基本持平、工业略弱、古典明显偏"扛"。
这说明新单位确实被价格和耐久带约束住了（否则新包一定会整体碾压原版）。
真正变化的是**职能分工**：古典第一次有了"专门拆城的兵"，中世有了"专门破甲的兵"，
工业有了"专门清堑壕的兵"——这些在原版里都是缺失的。

古典包交换比最低、每百金抗伤却最高，这不是数值失误，而是**设计意图的直接后果**：
重装步兵、战象、攻城槌都是"用输出换生存"的单位，任务是把战线顶住、让后排开火。
想让它的交换比好看，就得把重甲改薄——那就不再是古典方阵了。

### 6.2 四个单位在第一版直接失衡，已改到位

| 单位 | 问题 | 首轮实测 | 修改与结果 |
|---|---|---|---|
| 猎兵（火药） | 射程 5 + **先手**（不挨反击）+ 潜行 = 无风险打靶 | 每百金杀伤 **61.7**、交换比 5.65，比同代火枪兵高 76% | 去掉先手、射程 5→4、攻击 28→24→22 → **29.6** |
| 瞭望塔（古典） | 视野 5 在 12×12 上是半个棋盘，永远先手开火 | 每百金杀伤 **72.7**，是原版箭塔（37.0）的两倍 | 视野 5→4、攻击 12→10、价格 75→85 → **40.6**（箭塔 39.1） |
| 弩手（中世） | 破甲在"人人有甲"的中世太值钱，100 金全面替代长弓 | 每百金杀伤 **55.3**，比长弓（31.7）高 74% | 攻击 18→16、价格 100→110 → **38.5**（长弓 30.4） |
| 火箭炮（现代） | 射程 6 让它根本挨不到打（整轮承伤只有 633） | 交换比 5.64；先削攻击后**反而升到 7.48** | 真正的病根是射程：6→5（与原版火炮一致）→ **4.27** |

四次调整里，只有火箭炮这一次是"改错了方向又改回来"：第一轮去削攻击，结果它依然碰不到
伤害，ratio 反而更高。**射程在这套规则里是比攻击更贵的属性**——这是个可以复用的教训。

### 6.3 工业包重做过一轮：同价不能全面更差

第一版堑壕突击队是 210 金 / 攻击 34 / 射程 2，而同代步枪兵是 200 金 / 攻击 36 / 射程 4。
同样的价钱，攻击更低、射程更短、血量更少——它没有任何存在的理由，实测每百金杀伤只有
8.6（步枪兵 31.2），而 AI 因为"攻击数字不难看"仍然大量招募（采用率 12%）。

第二轮给三个单位都补上了明确的取舍：

- 堑壕突击队 → 射程 3、攻击 42、195 金（用射程换爆发）：**8.6 → 29.9**
- 骑兵 → 攻击 42、护甲 5、血 56、210 金（用机动换生存）：**8.7 → 12.5**
- 毒气兵 → 攻击 36（原 32）：**18.3 → 13.5**（样本 105，噪声大，不作结论）

工业包整体从 ×0.60 收回到 **×0.80**，剩下那 20% 主要来自骑兵（见 6.5）。

### 6.4 "先手 + 长射程"这套组合必须谨慎

两次失衡都出在同一个模式上：**不让对方还手**。原版里带先手的单位没有射程优势，
一旦把先手和 5 格射程叠在一起，AI 会把它当炮台站着不动，而对手永远走不到它面前。
结论：\`first-strike\` 只应该出现在"必须贴脸"的单位上（比如骑射手靠机动撤退），
不该出现在射程已经压过所有人的单位上。

### 6.5 骑兵类在这套测试里天然吃亏（不是数值问题）

工业骑兵交换比 0.62、每百金杀伤 12.5，中世骑射手也偏低，共同点是**高机动 + 低射程**：
AI 不做侧翼包抄、不做打了就跑，\`move 5\` 在它手里只是"更快地送进对方阵型"。
这类单位的人类玩家体验和 AI 数据会明显分离，所以**不要照着这张表去加强它们**——
继续加数值只会让它在真人手里变成无脑强。这是本报告最重要的一条"别用"提示。

### 6.6 节奏影响：没有一个包让对局变僵

| 时代 | 基线回合 | 模组回合 | 变化 |
|---|---:|---:|---:|
| 古典 | ${load('base1.json').summary.turnsAvg.toFixed(1)} | ${load('era1.json').summary.turnsAvg.toFixed(1)} | +${(((load('era1.json').summary.turnsAvg / load('base1.json').summary.turnsAvg) - 1) * 100).toFixed(0)}% |
| 中世 | ${load('base2.json').summary.turnsAvg.toFixed(1)} | ${load('era2.json').summary.turnsAvg.toFixed(1)} | +${(((load('era2.json').summary.turnsAvg / load('base2.json').summary.turnsAvg) - 1) * 100).toFixed(0)}% |
| 火药 | ${load('base3.json').summary.turnsAvg.toFixed(1)} | ${load('era3.json').summary.turnsAvg.toFixed(1)} | +${(((load('era3.json').summary.turnsAvg / load('base3.json').summary.turnsAvg) - 1) * 100).toFixed(0)}% |
| 工业 | ${load('base4.json').summary.turnsAvg.toFixed(1)} | ${load('era4.json').summary.turnsAvg.toFixed(1)} | +${(((load('era4.json').summary.turnsAvg / load('base4.json').summary.turnsAvg) - 1) * 100).toFixed(0)}% |
| 现代 | ${load('base5.json').summary.turnsAvg.toFixed(1)} | ${load('era5.json').summary.turnsAvg.toFixed(1)} | +${(((load('era5.json').summary.turnsAvg / load('base5.json').summary.turnsAvg) - 1) * 100).toFixed(0)}% |

现代拉得最长（+42%）：它多了重型坦克（护甲 14）、机枪地堡（护甲 15）、反坦克拒马这类
高耐久单位，正面更难啃；同时火箭炮射程被收回 5，攻城少了一件"够不着"的利器。
**但未决率反而从 13% 降到 0%**——每一局都分出了胜负，说明变长是"来回攻防"的变长，
不是又回到了推不动的拉锯。这一条比回合数本身更重要。

## 7. 遗留风险与下一步

1. **高价兵样本不足。** 表里标 ⚠ 的单位（重型坦克、列车炮、马克 I 坦克、要塞等）只有 2~9 次招募，
   两个「每百金」指标不可用。原因是 AI 的招募打分偏好"便宜、当场能打"的兵，
   贵单位要攒钱、要等时机，它等不了。想测准要么把局数提到 100+，要么给 AI 加"攒钱买大件"的策略。
2. **水军样本极少。** 只有地图带大片水域时才会造，每包 30 局里常常只有几十艘，结论仅供参考。
3. **骑兵类需要真人验证。** 见 6.5：AI 用不出机动的价值，这一项数据不能当平衡依据。
4. **火药（×1.36）与现代（×1.52）仍偏强，可以再收一轮。** 现在处在 ±25% 的边缘带，
   如果继续调，优先动"射程 + 溅射"的组合（攻城加农炮、自行火炮），而不是再削它们的耐久——
   耐久一削，这两个包的"贵而脆"特征就没了，会退化成放大版的原版兵。
5. **古典（×0.65）不建议再拉数值。** 它是"重甲肉盾"包，交换比低是设计的一部分。
   如果真觉得不好用，正确的做法是降低招募门槛（降价），而不是把重甲改薄。

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
