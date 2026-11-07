/**
 * 奇想兵种「同代同位互相挤占」对照表。
 *
 * 要回答的问题：奇想包里哪些兵其实是**同一个坑位**的不同填法，谁把谁挤没了。
 * 和 `fantasy-table.ts` 的分工：
 *   · 那张表回答"这个兵值不值这个价"（纯公式，一场都不用跑）；
 *   · 这张表回答"这个兵到底有没有人买，被谁顶掉了"（要真的对局数据）。
 * 一个兵性价比高但 400 局没人造，是**更严重**的问题——那说明尺子和需求脱节，
 * 或者同代有个更划算的替身。只看公式看不出来。
 *
 * 数据来源（都是现成的，本脚本不跑对局）：
 *   · 数值：直接读 `UNIT_TYPES`，和游戏里一模一样；战力/性价比用 `unit-value.ts`。
 *   · 出场：`results/bf-modern*` 四批双 AI 跑批，共 400 局。
 *       200 局火药开局（era3）+ 200 局信息化开局（era6），20×20，扩展含现代 + 奇想。
 *       分两批不是为了对照，是**必须**：era3 开局造不出 4~6 代兵，
 *       只看那一批会把所有高代兵误判成"没人买"。
 *   · 战斗：同上四批的 dealt / taken（每百金吸伤那张表的口径）。
 *
 * 一个坑位怎么划：**同代 + 同职能 + 价格相差不到一档（≤1.6×）**。
 * 不用更细的规则（比如按能力集合聚类）是因为兵种之间的替代关系本来就不是
 * 严格的等价类——狼骑士和精英骑兵都"贵一点更能打"，玩家的选择就是在这两者
 * 之间做，不需要它们的技能一样。
 *
 * 用法：node --experimental-strip-types scripts/fantasy-overlap.ts
 * 产出：docs/FANTASY-OVERLAP.md
 */
import { readFileSync, writeFileSync } from 'node:fs';

import { abilityById } from '../src/core/ability-registry.ts';
import { availableExpansions } from '../src/core/expansions.ts';
import { createMatch, DEFAULT_CONFIG } from '../src/core/setup.ts';
import type { UnitTypeDef } from '../src/core/types.ts';
import { NEUTRAL_CONTEXT, unitEfficiency, unitPower } from '../src/core/unit-value.ts';

const OUT = 'docs/FANTASY-OVERLAP.md';

/** 四批跑批。前两批 era3 开局，后两批 era6 开局 */
const BATCH_ERA3 = ['results/bf-modern/merged-era3.json', 'results/bf-era3b/merged-era3.json'];
const BATCH_ERA6 = ['results/bf-modern6/merged-era6.json', 'results/bf-modern6b/merged-era6.json'];

const expansions = availableExpansions();
const fantasy = expansions.filter((e) => e.id.startsWith('fantasy'));
if (fantasy.length === 0) throw new Error('没找到奇想扩展');
const s = createMatch(
  { ...DEFAULT_CONFIG, startEra: 6, expansionIds: expansions.map((e) => e.id) },
  1,
);

/**
 * 兵种属于原五个子包里的哪一个。
 *
 * 2026-11-04 五个包并成了一个「奇想」，`expansion.units` 里已经看不出分组，
 * 但分组本身仍然有信息量（荒兽偏"厚"，秘法偏"法术"，骑士团偏"人"）。
 * 所以从源文件的分段里读回来——比在别处再维护一份 id 清单可靠。
 */
function packMap(): Map<string, string> {
  const src = readFileSync('src/core/fantasy-packs.ts', 'utf8').split(/\r?\n/);
  const at = (re: RegExp): number => src.findIndex((l) => re.test(l));
  const spans: [string, number, number][] = [
    ['骑士团', at(/^const KNIGHTS: Expansion/), at(/^const BEASTS: Expansion/)],
    ['荒兽', at(/^const BEASTS: Expansion/), at(/^const ARCANE: Expansion/)],
    ['秘法', at(/^const ARCANE: Expansion/), at(/^const HERO_UNITS/)],
    ['英雄', at(/^const HERO_UNITS/), at(/^export const FANTASY: Expansion/)],
  ];
  const out = new Map<string, string>();
  for (const [name, a, b] of spans) {
    for (let i = a; i < b; i++) {
      const m = /^\s+id: '([a-z0-9-]+)',$/.exec(src[i] ?? '');
      // 下一行必须是 name/cost/era，才认这是兵种定义（能力表里也有 id）
      if (m && /^\s+(name|cost|era):/.test(src[i + 1] ?? '')) out.set(m[1]!, name);
    }
  }
  return out;
}

interface Acc {
  built: number;
  seen: number;
  dealt: number;
  taken: number;
  kills: number;
}
const EMPTY: Acc = { built: 0, seen: 0, dealt: 0, taken: 0, kills: 0 };

function readBatches(files: string[]): Map<string, Acc> {
  const m = new Map<string, Acc>();
  for (const p of files) {
    let j: { stats: { type: string; built?: number; seen?: number; dealt?: number; taken?: number; kills?: number }[] };
    try {
      j = JSON.parse(readFileSync(p, 'utf8'));
    } catch {
      continue; // 某批没跑过就跳过，下面按"样本 0"如实标注
    }
    for (const st of j.stats) {
      const c = m.get(st.type) ?? { ...EMPTY };
      c.built += st.built ?? 0;
      c.seen += st.seen ?? 0;
      c.dealt += st.dealt ?? 0;
      c.taken += st.taken ?? 0;
      c.kills += st.kills ?? 0;
      m.set(st.type, c);
    }
  }
  return m;
}

const G3 = readBatches(BATCH_ERA3);
const G6 = readBatches(BATCH_ERA6);
const GAMES_ERA3 = 200;
const GAMES_ERA6 = 200;
const GAMES = GAMES_ERA3 + GAMES_ERA6;

type Unit = UnitTypeDef & { unlockCost?: number; summonedOnly?: boolean };

/**
 * 旧尺子（`攻×√血×射程`）——**AI 采购默认用的就是这一把**，不是 `unit-value.ts`。
 *
 * 公式抄自 `ai.ts` 的 `oldPower` / `oldEfficiency`（那里没导出，只能复写一份）。
 * 抄它的理由：这张表要回答"为什么没人买"，而 AI 买不买看的是这一把尺子；
 * 表里只写新尺子，就会出现"性价比高却零出场"这种看着像 bug 的假象——
 * 其实是两把尺子不同源。改那把尺子时**这里要跟着改**，否则表会说谎。
 *
 * 它的三个特征决定了整张表的形状：
 *   · 只读 攻 / 魔攻 / 血 / 射程——**移速、视野、能力一概不算钱**；
 *   · 价格指数 0.8（新尺子是 0.55），贵一点就掉得更多；
 *   · 射程每格 +45%（封顶 4 格），所以远程兵天然占便宜。
 */
const oldPower = (d: UnitTypeDef): number =>
  (d.atk + (d.magicAtk ?? 0) * 1.2) *
  Math.sqrt(d.maxHp) *
  (1 + Math.min(4, Math.max(0, (d.range ?? 1) - 1)) * 0.45);
const oldEfficiency = (d: UnitTypeDef, price: number): number =>
  oldPower(d) / Math.max(20, price) ** 0.8;

interface Row {
  d: Unit;
  pack: string;
  eff: number;
  oldEff: number;
  power: number;
  b3: number;
  b6: number;
  built: number;
  dealt: number;
  taken: number;
  ratio: number;
}

const packs = packMap();
const rows = new Map<string, Row>();
{
  const seen = new Set<string>();
  for (const e of fantasy) {
    for (const u of e.units ?? []) {
      if (seen.has(u.id)) continue;
      seen.add(u.id);
      const d = s.unitTypes[u.id] as Unit | undefined;
      if (!d || d.category !== 'combat') continue;
      const a3 = G3.get(d.id) ?? EMPTY;
      const a6 = G6.get(d.id) ?? EMPTY;
      const dealt = a3.dealt + a6.dealt;
      const taken = a3.taken + a6.taken;
      rows.set(d.id, {
        d,
        pack: packs.get(d.id) ?? '召唤',
        eff: unitEfficiency(d, d.cost),
        oldEff: oldEfficiency(d, d.cost),
        power: unitPower(d, NEUTRAL_CONTEXT),
        b3: a3.built,
        b6: a6.built,
        built: a3.built + a6.built,
        dealt,
        taken,
        ratio: taken > 0 ? dealt / taken : 0,
      });
    }
  }
}

/**
 * 坑位（组）。
 *
 * 手写而不是自动聚类：自动聚类会在"该不该把鹰身女妖算进法系远程"这种地方
 * 给出一个看起来客观、其实没人认可的分组。分组本身是判断，写出来挨得住质疑；
 * 数字则全部由代码算，不手抄。
 */
interface Group {
  /** 组标题 */
  title: string;
  ids: string[];
  /** 这一组在争什么 */
  note: string;
}
const GROUPS: Group[] = [
  {
    title: 'G1 · 一代步兵',
    ids: ['zombie', 'serpent-man'],
    note: '一代只有这两个奇想兵。都卖不动——不是互相挤，是这一代整体不在 AI 的采购路径上（开局钱少、城少，优先买原版最便宜的兵）。',
  },
  {
    title: 'G2 · 二代步兵',
    ids: ['slime', 'swordsman', 'thief'],
    note: '三个都是移 2~3、射 1 的地面兵。史莱姆靠 50 血、剑士靠 4 甲 + 盾墙；盗贼面板最薄，卖点是潜行和攻城顺手捞钱——那两样都不进 AI 的采购公式。',
  },
  {
    title: 'G3 · 二代机动',
    ids: ['wolf-rider', 'spider-rider', 'poison-bat', 'elite-cavalry'],
    note: '整张表最刺眼的一组：狼骑士 55 金卖 838 次，精英骑兵 125 金卖 0 次。四者都是"高移动 + 贴身"，价格却跨了 2.3 倍。',
  },
  {
    title: 'G4 · 二代远程',
    ids: ['ranger', 'centaur'],
    note: '同价位的两个射 3。游侠进林子变强，半人马带游骑（打了就跑）。半人马 99 次对游侠 13 次。',
  },
  {
    title: 'G5 · 二代光环位',
    ids: ['priest', 'bard'],
    note: '都是"买来不打人"的位置。牧师能回血能洗状态，吟游诗人只给光环。',
  },
  {
    title: 'G6 · 三代重步',
    ids: ['minotaur', 'troll', 'treant', 'ogre', 'earth-elemental'],
    note: '165~190 金、移 2~3、射 1，五个"顶线肉"。全组最惨：加起来只有 11 次出场，四个是 0。',
  },
  {
    title: 'G7 · 三代近战爆发',
    ids: ['berserker', 'water-elemental', 'fire-elemental'],
    note: '比 G6 便宜、比 G6 脆，卖点是"一次打疼"。狂战士两段、火元素燃焰、水元素霜缚。',
  },
  {
    title: 'G8 · 三代轻骑游走',
    ids: ['ghost', 'assassin', 'gargoyle', 'hellhound', 'air-elemental'],
    note: '130~165 金的"绕后 / 切软目标"。刺客是纯爆发，其余各有花招。',
  },
  {
    title: 'G9 · 三代重骑',
    ids: ['griffin-rider', 'cursed-knight', 'cataphract', 'royal-cavalry', 'dragoon-rider'],
    note: '190~265 金、全部带冲锋或飞行。皇家骑兵（235）把这一档吃干了，龙骑兵（265）一次都没出场——这一对是被讨论过最多次的。',
  },
  {
    title: 'G10 · 三代远程',
    ids: [
      'harpy',
      'curser',
      'mage',
      'druid',
      'witch',
      'illusionist',
      'alchemist',
      'necromancer',
      'elf-archer',
    ],
    note: '九个射 2~5 的远程挤在 120~175 金。这是全表最大的一堆，也是"买个远程"这一个决定里最没有区分度的一段。鹰身女妖是唯一的物理远程（靠飞），其余八个都是法术/状态。',
  },
  {
    title: 'G11 · 三代支援',
    ids: ['rune-guardian', 'witch-doctor', 'paladin'],
    note: '三个人形支援：修缮、治疗光环、守护光环 + 治疗。圣骑士自己也能打，所以它和巫医不完全可替代。',
  },
  {
    title: 'G12 · 三代英雄',
    ids: ['night-necromancer', 'dwarf-king', 'slime-boss'],
    note: '三个三代英雄，价差大（320~520）但同属"这一局买得起哪个英雄"。英雄要另付解锁费，而且全场唯一——所以它们不是"买几个"的问题，是"先给谁解锁"。',
  },
  {
    title: 'G13 · 四代顶线',
    ids: ['clockwork-golem', 'royal-guard', 'two-head-giant'],
    note: '245~300 金的厚甲。皇家守卫 10 甲 + 阵列，机关傀儡 9 甲 + 盾墙，双头巨人靠两段远程。',
  },
  {
    title: 'G14 · 四代 235 金同价',
    ids: ['werewolf', 'vampire'],
    note: '同一代、同一个价（235），一个移 3 一个移 5，一个回血一个吸血。这是最干净的一组对照：除了定位，什么都一样。',
  },
  {
    title: 'G15 · 四代终局大件',
    ids: ['assassin-master', 'holy-knight-lord', 'phoenix', 'hydra'],
    note: '430~490 金 + 英雄解锁费。买之前要攒三四个回合，所以它们之间是"这一局我只买得起一个"的关系。',
  },
  {
    title: 'G16 · 五代终局大件',
    ids: ['demon', 'bone-dragon', 'angel', 'archmage'],
    note: '400~640 金。恶魔是唯一"没解锁费"的那个（它不 unique，可以重复买），其余三个是英雄。',
  },
  {
    title: 'G17 · 六代终局英雄',
    ids: ['sword-saint', 'evil-dragon-king'],
    note: '620 / 640，都需要「信息化」扩展，都是全场唯一。到这一代钱已经不是约束，"先解锁哪个"才是。',
  },
];

/**
 * 组内判定：谁在出、谁被挤掉。
 *
 * 门槛写成"组内最高值的 10%"而不是绝对值，是因为各代的规模差一个量级：
 * 二代狼骑士 838 次、三代重步全组加起来 11 次。用绝对阈值会把小组整组判成"被挤掉"。
 * 组内最高都不到 10 次的，一律只写"样本不足"——1 : 0 这种比不值得编一个结论。
 */
function verdict(r: Row, groupMax: number): string {
  if (groupMax < 10) return '样本不足';
  if (r.built === 0) return '**零出场**';
  if (r.built === groupMax) return '主选';
  if (r.built <= groupMax * 0.1) return '被挤掉';
  return '有份额';
}

const abText = (d: Unit): string => {
  const list = (d.abilities ?? []).map((a) => abilityById(a)?.name ?? a);
  return list.length > 0 ? list.join('、') : '—';
};

const per = (n: number): string => (n / GAMES).toFixed(2);

const lines: string[] = [];
const push = (x = ''): void => void lines.push(x);

push('# 奇想兵种：同代同位挤占对照表');
push();
push('> 由 `npm run fantasy:overlap` 生成（`scripts/fantasy-overlap.ts`），数字不手抄。');
push('> 表里有两类数：**数值**来自当前代码（`unit-value.ts` 现算）；**出场 / 战斗**来自');
push(`> 400 局双 AI 跑批（\`results/bf-modern*\`，200 局火药开局 + 200 局信息化开局，20×20）。`);
push();
push('## 口径');
push();
push('```');
push('战力    = (输出 × 生存)^0.55 × 射程 × 移速 × 视野 × (1 + 能力)，均势姿态（tempo = 0）');
push('性价比新 = 战力 / 价格^0.55          ← 报表 / 审计口径（unit-value.ts）');
push('性价比旧 = 攻×√血×射程 / 价格^0.8     ← **AI 采购默认用的这一把**（ai.ts 的 oldEfficiency）');
push('建造    = 这一兵种在 400 局里被招募/建造的总次数（不含召唤、分裂、孵化）');
push('交换比  = 累计输出伤害 / 累计承受伤害。> 1 说明它换血换得赚');
push('```');
push();
push('**两把尺子要分清**：AI 买不买看的是"性价比旧"，它完全不看移速、视野、能力；');
push('"性价比新"只在报表里出现。表里两列都给，就是为了不让读者拿错那一列去解释出场数。');
push();
push('一个**坑位**的划法：同代 + 同职能 + 价格相差不到一档（≤1.6×）。');
push('同代不同价、或者同价不同职能，都不算互相挤占——那些是"有钱了升级"，不是"二选一"。');
push();
push(`## 一、总览：${GROUPS.length} 个坑位，谁把谁挤没了`);
push();
push('| 组 | 价位 | 卖得动的（建造数） | 被挤掉的 | 差距 |');
push('|---|---|---|---|---|');
for (const g of GROUPS) {
  const list = g.ids.map((id) => rows.get(id)).filter((r): r is Row => !!r);
  if (list.length === 0) continue;
  const sorted = [...list].sort((a, b) => b.built - a.built);
  const top = sorted[0]!;
  const dead = sorted.filter((r) => r.built === 0 || (top.built >= 20 && r.built <= top.built * 0.1));
  const lo = Math.min(...list.map((r) => r.d.cost));
  const hi = Math.max(...list.map((r) => r.d.cost));
  // 全组都卖不动（最高才个位数）时不谈"差距"：1 : 0 的比值没有任何信息
  const gap = top.built < 10
    ? '样本不足'
    : dead.length === 0
      ? '—'
      : `${(top.built / Math.max(1, dead[dead.length - 1]!.built)).toFixed(0)}×`;
  push(
    `| ${g.title} | ${lo === hi ? `${lo}` : `${lo}~${hi}`} | ${top.d.name}（${top.built}） | ${
      dead.length > 0 ? dead.map((r) => `${r.d.name}（${r.built}）`).join('、') : '—'
    } | ${gap} |`,
  );
}
push();
push('## 二、逐组明细');
push();
push('列说明：攻/魔 = 物理攻击 / 魔法攻击；甲/抗 = 护甲 / 魔法抗性；移/射/视 = 移动力 / 射程 / 视野；');
push('建造 = `火药批/信息化批` 的建造次数（两批各 200 局，合计 400），括号里是每局几个；');
push('解锁 = 英雄首次招募的额外解锁费（一次性）。**两批的数字要分开看**：');
push('像皇家骑兵只在火药批出现（62/0，信息化开局直接跳过二代兵），');
push('圣剑勇者只在信息化批出现（23/421，火药开局的局大多打不到信息化）。');
push();

for (const g of GROUPS) {
  const list = g.ids.map((id) => rows.get(id)).filter((r): r is Row => !!r);
  if (list.length === 0) continue;
  const sorted = [...list].sort((a, b) => a.d.cost - b.d.cost);
  const groupMax = Math.max(...list.map((r) => r.built));
  push(`### ${g.title}`);
  push();
  push(g.note);
  push();
  push(
    '| 兵种 | 包 | 代 | 价 | 攻/魔 | 血 | 甲/抗 | 移/射/视 | 段 | 能力 | 战力 | 性价比 新/旧 | 建造 火/信（每局） | 交换比 | 判定 |',
  );
  push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const r of sorted) {
    const d = r.d;
    const unlock = d.unlockCost ? ` +解锁${d.unlockCost}` : '';
    push(
      `| ${d.name} | ${r.pack} | ${d.era} | ${d.cost}${unlock} | ${d.atk}/${d.magicAtk ?? 0} | ${d.maxHp} | ` +
        `${d.armor}/${d.magicRes ?? 0} | ${d.move}/${d.range}/${d.vision} | ${d.burst ?? 1} | ${abText(d)} | ` +
        `${r.power.toFixed(0)} | ${r.eff.toFixed(2)} | ${r.oldEff.toFixed(2)} | ${r.b3}/${r.b6}（${per(r.built)}） | ` +
        `${r.built > 0 ? r.ratio.toFixed(2) : '—'} | ${verdict(r, groupMax)} |`,
    );
  }
  push();
}

// ── 统计：全表零出场的战斗兵 ───────────────────────────────────────────
const buyable = [...rows.values()].filter((r) => !r.d.summonedOnly);
const zero = buyable.filter((r) => r.built === 0).sort((a, b) => a.d.cost - b.d.cost);
const nonzero = buyable.filter((r) => r.built > 0);
const share = (n: number): string => `${((n / nonzero.reduce((x, r) => x + r.built, 0)) * 100).toFixed(1)}%`;

push('## 三、全表统计');
push();
push(`- 奇想战斗兵共 **${buyable.length}** 个（另有 ${rows.size - buyable.length} 个只能召唤，见第四节）。`);
push(`- 400 局里**一次都没被建造**的有 **${zero.length}** 个：${zero.map((r) => `${r.d.name}（${r.d.cost}）`).join('、')}。`);
push(`- 建造数前五：${[...nonzero]
  .sort((a, b) => b.built - a.built)
  .slice(0, 5)
  .map((r) => `${r.d.name} ${r.built}（占全体 ${share(r.built)}）`)
  .join('、')}。`);
push();
push('零出场里要分两种，别混为一谈：');
push();
push('1. **被同代替身挤掉**——同代有更便宜或更划算的同类，列在第二节各组的"判定"列里。');
push('2. **本身就贵到 AI 摸不着**——史莱姆牢大（520）、至尊法师（640+350 解锁）：');
push('   这一档要么解锁费 + 造价一次掏空，要么整局都攒不到，属于"终局奖励"而不是"选项"。');
push();
const summoned = [...rows.values()].filter((r) => r.d.summonedOnly);
push('## 四、不在本表里的');
push();
push('| 兵种 | 为什么不在 |');
push('|---|---|');
push(
  `| ${summoned.map((r) => r.d.name).join('、')} | 只能召唤，没有采购这回事，\`built\` 恒为 0。` +
    `它们的 \`seen\`（出场人次）不低，说明召唤路线是活的——只是不经过兵营 |`,
);
push('| 土墙 | 类别是 building（不是战斗兵），不进这张表 |');
push('| 精灵弓手（2 次） | 数据太少，判不出是"被挤"还是"AI 的远程模板根本不含它"，只能说**没进入采购路径** |');
push('| 龙骑兵（0 次） | 同上：0 次是结论，但"为什么"要另算——它的能力分（0.32）几乎全来自冲锋 + 移 5 + 视 6，AI 的采购尺子量不出"能选在哪开战"这部分价值 |');
push();
push('## 五、这张表能指认坑位，不能指认病因');
push();
push('先把两把尺子分清，否则下面的数会被读错：');
push();
push('- **性价比（新）** = `unit-value.ts`，管线是兰彻斯特 + 移速/视野/能力。报表、审计用它。');
push('- **性价比（旧）** = `攻×√血×射程 / 价^0.8`，**AI 采购默认用的就是这一把**（`WB_RULER` 未设成 `new`）。');
push('  它完全不看移速、视野、能力，价格指数还更陡（0.8 对 0.55）。');
push();
push('所以"新尺子说它值、它却零出场"不是矛盾——AI 根本没看那一列。');
push();
push('### 旧尺子能解释的');
push();
push('**1. 同价之内，排序就是结论。** G14 是最干净的样本：狼人和吸血鬼都 235 金，');
push('旧尺子 2.33 对 2.66，出场 8 对 648。同价、同代、同职能，比的只剩这一项。');
push();
push('**2. 又贵、旧尺子又低 → 0 次。** G3 的精英骑兵（2.13，全组最低）、');
push('G9 的龙骑兵（2.28，全组最低）都是"最贵 + 分数垫底"，两条同时踩中。');
push('这两个是整张表里最没有疑问的零出场。');
push();
push('### 旧尺子解释不了的（三个反例，别硬套）');
push();
push('| 反例 | 数据 | 为什么解释不了 |');
push('|---|---|---|');
push('| 精灵弓手 | 旧尺子 5.42，**全组最高**；射 5、视 7；400 局只出场 2 次 | 无论哪把尺子它都该被抢，实际几乎没人买。这一条单纯用"值不值"讲不通 |');
push('| 狼骑士 vs 剑士 | 2.44 对 2.96，剑士更高；出场 838 对 89 | 同代、同职能、剑士又更便宜又更高分，却少一个量级 |');
push('| 蜘蛛骑士 vs 剑士 | 2.59 对 2.96，剑士更高也更便宜；出场 167 对 89 | 同上，方向反了 |');
push();
push('三条反例指向同一个缺口：**采购分不是唯一的决定项**。`ai.ts` 里还有兵种搭配、');
push('远程占比、经济节奏、换血（`swapOut`）这些项会改写排序，而它们不在任何一张表里。');
push();
push('**所以：这张表用来找"哪些兵在同一个坑里互相顶"，够用；用来给某次改价找依据，不够。**');
push('真要定位某个兵为什么 0 次，得在"买得起的那一刻"把全候选的分数和 deny 原因打出来，');
push('看它到底输给了谁。在那之前改价，只是把受害者换一个。');
push();
push('### 一件不用等的事');
push();
push('G10 那九个三代远程，互相之间的差异小到没有意义（旧尺子 2.31~5.42 主要差在射程，');
push('而射程在这一档全是 3）。这一档缺的不是第九个射 3，是"射 5 以上"的差异位——');
push('精灵弓手本来是那个位，但它 0~2 次出场，说明这个位现在等于不存在。');
push();
push('---');
push();
push('复现：');
push();
push('```bash');
push('# 四批跑批（若 results/ 已被清掉，需要重跑才能复现出场数）');
push('node --experimental-strip-types scripts/fantasy-overlap.ts');
push('```');

writeFileSync(OUT, `${lines.join('\n')}\n`, 'utf-8');
console.log(`→ ${OUT}`);
console.log(
  `奇想战斗兵 ${buyable.length} 个 · 零出场 ${zero.length} 个 · ${GROUPS.length} 个坑位 · 样本 ${GAMES} 局`,
);
