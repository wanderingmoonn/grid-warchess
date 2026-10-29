/**
 * 规则书生成器。
 *
 * 手写规则书最大的问题是会和代码脱节：改了数值忘了改文档，
 * 一两个月后你自己都不知道哪份是对的。
 *
 * 所以这里只手写"规则怎么运作"的说明文字，所有数值和表格全部从
 * config.ts / abilities.ts / expansions.ts 读出来。改完数值重跑一次即可：
 *
 *   npm run manual
 */

import { mkdirSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { ABILITY_GROUP_NAME } from '../src/core/abilities.ts';
// 能力表是"核心 + 各扩展贡献"合并出来的：规则书要印全，不能只印本体的那几条。
import { abilityById, allAbilities } from '../src/core/ability-registry.ts';
import { BASE_MAX_ERA, CATEGORY_NAME, CITY, CONFIG, ERAS, UNIT_TYPES } from '../src/core/config.ts';
import { BLOOD_TURN, EXPANSIONS, availableExpansions } from '../src/core/expansions.ts';
import { AP_COST, AP_HOLD_ARMOR, AP_MAX } from '../src/core/action-points.ts';
import { FANTASY_PACKS } from '../src/core/fantasy-packs.ts';
import { DEFAULT_CONFIG } from '../src/core/setup.ts';
import { ELEMENT_NAME } from '../src/core/types.ts';
import { resourceShort } from '../src/core/resources.ts';
import type { Element, UnitCategory, UnitTypeDef } from '../src/core/types.ts';

const ERA1_HP = ERAS[0]?.cityMaxHp ?? 30;

const TERRAIN_TABLE: Array<{ id: string; name: string; cost: string; def: string; note: string }> = [
  { id: 'plain', name: '平原', cost: '1', def: '—', note: '农民收益最高（+7）。开阔地，无掩护。' },
  { id: 'forest', name: '森林', cost: '2', def: '+2', note: '伐木工收益最高（+12）。守方多 2 点护甲。' },
  { id: 'hill', name: '丘陵', cost: '2', def: '+3', note: '牧民收益最高（+8）。全图最好的防守地形。' },
  { id: 'water', name: '水域', cost: '陆军不可通行', def: '—', note: '只有水军能走，一格一步。相邻经济单位额外 +3 金。' },
  { id: 'mountain', name: '高山', cost: '不可通行', def: '—', note: '连成脉的天险，只能绕或走隘口。' },
  { id: 'bridge', name: '桥', cost: '1', def: '—', note: '架在水面上的建筑，双向通行（双方都能穿过），船从桥下过，打掉变回水面。' },
  { id: 'city', name: '城市', cost: '1', def: '+3', note: '可产兵、可升级。耐久打空变废墟，派兵入驻并付费才易主。' },
];

function esc(t: string): string {
  return t
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 能力说明里有 `**加粗**` 这种手写标记，转成标签；其余照常转义 */
function rich(t: string): string {
  return esc(t).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
}

/* ---------------------------------------------------------------------------
 * 机制词条。
 *
 * 拆册之后最刺眼的问题不是册数，是**同一句话印了很多遍**：
 * 「魔法攻击不吃护甲」在五个奇想分册的兵种表里各出现十几次，
 * 「溅射 30%」在每一支带溅射的兵后面都跟着一段括号。读者要在几十行表格里
 * 反复读同一句解释，真正需要对比的数值反而被挤到视线之外。
 *
 * 所以表格里只留"能扫的东西"（名字、数值），解释统一收进词条：
 * 鼠标停在上面出浮层，点一下跳到本册末尾的词条表。正文提到机制时也走同一条路。
 *
 * 两条硬约束：
 *   · 词条表只收**本册兵种真的用到**的那几条。全量词条表会变成第二本规则书，
 *     和"减少冗长"正好相反；核心册是例外——它那 51 条能力就是全量索引。
 *   · 锚点必须在本册内可解析。跨册锚点在打印版和单册分发时会断，
 *     所以每册带自己的词条表，宁可多印几行也不留死链。
 * ------------------------------------------------------------------------- */

interface Term {
  /** 锚点后缀，也是 ref() 的键。能力统一用 `ab-<abilityId>` */
  key: string;
  name: string;
  /** 一句话——悬停浮层显示的就是它，所以不能有换行、不能超过一屏宽 */
  brief: string;
  /** 可选：词条表里追加的一行，比 brief 更细，但不必出现在浮层里 */
  more?: string;
}

/** 通用机制的词条。能力和地形各有自己的来源，不重复写在这里 */
const GENERIC_TERMS: Term[] = [
  {
    key: 'splash',
    name: '溅射',
    brief: '打中目标时，周围若干格内的敌人各吃一份按比例折算的伤害。',
    more: `比例固定为 ${Math.round(
      CONFIG.splashRatio * 100,
    )}%，不分敌我——友军站在炸点上一样掉血。`,
  },
  {
    key: 'burst',
    name: '多动',
    brief: '一回合能发起 N 次独立攻击，每次都是完整的一击，可以换目标。',
    more: '次数用完才算行动结束；它挨打时的反击次数也等于这个 N，所以围攻比单挑划算。',
  },
  {
    key: 'income',
    name: '产出',
    brief: '回合结束时结算金币；写「地形+数」的，站对地形拿全额，站错只拿保底。',
    more: '地形不对不是"打零折"，是拿该兵种的保底收入——所以经济单位也值得带出门。',
  },
  {
    key: 'builds',
    name: '建造',
    brief: '能盖哪几类建筑；建造会占掉这个单位整个回合。',
    more: `建造距离 ${CONFIG.buildRange} 格；沿已铺好的桥面可以再往外递两节。`,
  },
  {
    key: 'auto',
    name: '自动开火',
    brief: '每回合不消耗行动，自动向射程内最合适的目标开一次火。',
    more: '建筑专用。玩家点它开火仍然算"手动"，两者不叠加（同一回合只打一次）。',
  },
  {
    key: 'immobile',
    name: '不可移动',
    brief: '移动力 0：能开火、能产出，但永远不换位置。',
  },
  {
    key: 'carry',
    name: '装载',
    brief: '能把贴身的己方陆军装进货舱运过水面；船沉了，舱里的人一起没。',
    more: '装卸各花掉一次行动，所以每回合只能装卸一次；装完仍然可以开走。下船的单位当回合不能再动、不能再打。',
  },
  {
    key: 'air',
    name: '空中层',
    brief: '与地面互不占格；地面单位打它时距离 +1，它能掠水、走森林丘陵只花 1 步。',
    more: '掠水三兄弟（飞行 / 掠空 / 跳跃）机制同一套，差别只在名字对不对得上画面。掠空还能和地面单位同格：地面那格站着人，天上那格照样能停，天上那格的人也只能打天上的。两层叠在同一格时，点这一格会先问"有没有我能打的目标"——有就直接开火，不再只弹上面那个的属性卡。',
  },
  {
    key: 'overhead',
    name: '地面打空中',
    brief: '站在地上的兵够不着头顶那一层：射程 1 打不到隔壁那格飞着的单位，射程 2 才刚好够得着。',
    more: '反过来飞行单位打地面照常算。反击也按"还手的那个人"算距离——所以飞行单位贴脸打完地面单位，除非对面射程 ≥ 2，否则不会挨反击。例外是压着打：飞行单位停在正上方（同一格）时距离算 0+1=1，脚下的兵仍然能还手。',
  },
  {
    key: 'magic',
    name: '魔法攻击',
    brief: '独立结算的第二段伤害：不吃护甲、地形和破甲，只被魔抗平减。',
    more: '和普通攻击同时结算，所以法师打重甲划算、打在魔抗单位身上像挠痒。数值都压在 20 以内——它是"另一条路"，不是"更大的数字"。',
  },
  {
    key: 'mres',
    name: '魔法抗性',
    brief: '从魔法伤害里直接扣掉的固定值，对普通攻击无效。',
  },
  {
    key: 'elem',
    name: '属性',
    brief: '这段攻击带什么属性，决定目标怕不怕、抗不抗。',
    more: '火 / 水 / 土 / 风 / 光 / 暗 / 自然 / 奥术。属性本身不加伤害，只用来查怕与抗。',
  },
  {
    key: 'weak',
    name: '怕',
    brief: '受到该属性伤害时倍乘。作用在整段伤害上，不限于魔法段。',
    more: '「怕火×2」被火把砸一下也疼——那一下的普通伤害同样翻倍。',
  },
  {
    key: 'resist',
    name: '抗',
    brief: '从该属性伤害里平减固定值。',
  },
  {
    key: 'cycle',
    name: '轮换属性',
    brief: '每回合自动换一种属性，按括号里的顺序循环。',
  },
  {
    key: 'summon',
    name: '召唤',
    brief: '每隔 N 回合在自己身边生成一个召唤物，同源同时最多若干个。',
    more: '召唤物不占编制上限，所以不会把产线堵死；召唤师被杀，已经召出来的还留在场上。',
  },
  {
    key: 'ammo',
    name: '弹药',
    brief: '远程攻击有次数上限，打光之后只能贴身肉搏。',
  },
  {
    key: 'hero',
    name: '英雄',
    brief: '全场同名只能有一个；首次招募要在造价之外另付一笔解锁费。',
    more: '付过一次之后这一局里随便造。英雄倒下不返还解锁费。',
  },
  {
    key: 'skill',
    name: '英雄技能',
    brief: '每回合一次的主动技，不占移动与攻击——开完还能照常行动。',
  },
  {
    key: 'summoned-only',
    name: '只能被召唤',
    brief: '不进生产面板，也不占编制上限。',
  },
  {
    key: 'decay',
    name: '自损',
    brief: '每回合开始时自己掉血，掉到 0 就消失。',
    more: '和中毒一样按上限血计算，所以体型大的单位不会"更耐腐蚀"。',
  },
  {
    key: 'split',
    name: '分裂',
    brief: '死亡时在原地生成一个更小的同类。',
  },
  {
    key: 'status',
    name: '状态',
    brief: '中毒 / 点燃 / 减速 / 诅咒，都按兵种血量百分比结算。',
    more: '中毒每回合 6% 上限血、点燃 8%（怕火的翻倍）、减速移动 −1（最低 1）、诅咒护甲 −2（最多两层）。按百分比算，是为了让巨魔中同样的毒掉的血和它的体型相称。',
  },
  {
    key: 'mastery',
    name: '属性精研',
    brief: '至尊法师的四种形态：火再叠一层、水挂霜缚、自然攻击时回血、暗把魔法段 ×1.5。',
    more: '所以「转属性」是在"控场"和"爆发"之间选，而不是在四种颜色里挑好看的那个。',
  },
];

const TERM_BY_KEY = new Map<string, Term>(GENERIC_TERMS.map((t) => [t.key, t]));

/**
 * 当前这一册"用到了哪些词条"。
 *
 * 用累加器而不是让每个表格函数返回 `{ html, keys }`：表格函数是层层嵌套的
 * （eraSection → unitTable → traitsOf），一路回传键数组要把三层的签名全改一遍，
 * 而且调用点每加一处就得记得接上一次。渲染时顺手记一笔最省事，
 * 代价是"必须先渲染表格、再渲染词条表"这个顺序——两处都写在同一个函数里，跑不了。
 */
let termSink: string[] = [];

function noteTerm(key: string): string {
  termSink.push(key);
  return key;
}

/** 取走并清空累加器。每册开头调一次，免得上一册的词条串到下一册 */
function takeTerms(): string[] {
  const out = termSink;
  termSink = [];
  return out;
}

/** 开新一册：把上一册残留的键丢掉（正常流程里 takeTerms 已经清过了，这里是兜底） */
function resetTerms(): void {
  termSink = [];
}

/** 运行时才知道的词条（英雄技能这类：每条都是兵种自己带的，没有全局表） */
function dynamicTerm(key: string, name: string, brief: string, more?: string): string {
  if (!TERM_BY_KEY.has(key)) TERM_BY_KEY.set(key, { key, name, brief, more });
  return noteTerm(key);
}

/**
 * 把任意文字压成锚点能用的形状。
 *
 * 技能名里出现空格或引号时，`href="#t-..."` 会被浏览器编码成 %20 之类，
 * 而 `id` 不会——两边从此对不上，表现为"点了没反应、悬停也不弹"。
 * 现在技能名都是纯中文，但下一个人加的那个未必。
 */
function slug(s: string): string {
  return s.replace(/[^\p{L}\p{N}-]+/gu, '-').replace(/^-+|-+$/g, '');
}

/** 能力也进词条库：键是 `ab-<id>`，文字直接取能力定义里那句 summary */
function abilityTerm(id: string): Term | undefined {
  const a = abilityById(id);
  if (!a) return undefined;
  return { key: `ab-${id}`, name: a.name, brief: a.summary };
}

function termOf(key: string): Term | undefined {
  return key.startsWith('ab-') ? abilityTerm(key.slice(3)) : TERM_BY_KEY.get(key);
}

/**
 * 正文或表格里提到一个机制时用这个。
 *
 * 输出的是一颗链接：浮层由 page() 里那段脚本驱动，脚本没跑（禁用 JS、打印、
 * 另存为纯 HTML）时它退化成普通锚点，点一下照样能跳到词条表——
 * 两种情形都不会丢信息。
 *
 * **说明文字不写进这里**。早先的写法是给每颗链接带一份 `data-tip="整句说明"`，
 * 结果"盾墙"在三十个兵后面各存了一份同样的句子——正文看着是短了，
 * 文件里的重复反而更多了。现在浮层按 href 去词条表取，事实只有一份。
 */
function ref(key: string, label?: string): string {
  const t = termOf(key);
  if (!t) throw new Error(`规则书引用了不存在的词条：${key}`);
  noteTerm(key);
  return `<a class="ref" href="#t-${esc(key)}">${esc(label ?? t.name)}</a>`;
}

/**
 * 本册的词条表。
 *
 * 只收传进来的那几条，顺序也按传入顺序——调用方按"表格里出现的先后"收集，
 * 读者往下翻时遇到的新词，基本都是表里下一行。
 *
 * `abilities: false` 给核心册用：那本书第 13 章已经是一张带锚点的能力总表，
 * 再印一遍等于承认"解释可以重复"，这一册就没资格说别人啰嗦。
 */
function termTable(keys: readonly string[], opts: { abilities?: boolean } = {}): string {
  const withAbilities = opts.abilities !== false;
  const seen = new Set<string>();
  const rows: string[] = [];
  for (const k of keys) {
    if (seen.has(k)) continue;
    seen.add(k);
    if (!withAbilities && k.startsWith('ab-')) continue;
    const t = termOf(k);
    if (!t) continue;
    rows.push(
      `<dt id="t-${esc(k)}">${esc(t.name)}</dt><dd>${rich(t.brief)}${
        t.more ? ` <span class="more">${rich(t.more)}</span>` : ''
      }</dd>`,
    );
  }
  if (rows.length === 0) return '<p class="era-meta">这一册没有需要单独解释的机制。</p>';
  return `<dl class="terms">${rows.join('')}</dl>`;
}

/**
 * 一个兵种的"特性"列。
 *
 * 这一列过去是整份规则书最密的地方：能力名后面跟一句解释、溅射后面跟一句
 * 折算比例、产出后面跟一句"站错地形只拿保底"。同一句解释在一张表里重复十几次，
 * 想对比两个兵反而要先跳过它们的注释。
 *
 * 现在只留"扫一眼能比"的东西——能力名、数值——解释交给悬停和词条表。
 * 信息没删：每个数的含义仍然能查到，只是不再一次性铺在正文里。
 */
function traitsOf(u: UnitTypeDef): string {
  const parts: string[] = [];
  for (const id of u.abilities ?? []) {
    const a = abilityById(id);
    parts.push(a ? ref(`ab-${id}`) : `<b>${esc(id)}</b>`);
  }
  if (u.incomeByTerrain) {
    const best = Object.entries(u.incomeByTerrain).sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))[0];
    if (best) parts.push(ref('income', `产出 ${terrainName(best[0])} +${best[1]}`));
  } else if (u.income) {
    parts.push(ref('income', `+${u.income} 金/回合`));
  }
  // 只写 yield 的建筑（粮仓、采石场、砖窑这一串）不产金币，特性列得自己说出来源，
  // 否则它们在表里看着像"什么都没干"的石头墩子。
  if (u.yield) {
    const table = Object.entries(u.yield)
      .filter(([, n]) => (n ?? 0) > 0)
      .map(([id, n]) => `+${n} ${resourceShort(id)}`);
    if (table.length > 0) parts.push(ref('income', `产出 ${table.join(' ')}`));
  }
  if (u.splash) parts.push(ref('splash', `溅射 ${u.splash}`));
  if (u.burst) parts.push(ref('burst', `多动 ${u.burst} 次`));
  if (u.builds) parts.push(ref('builds', `可建 ${u.builds.length} 种建筑`));
  if (u.autoAttack) parts.push(ref('auto'));
  if (u.move === 0) parts.push(ref('immobile'));
  return parts.length > 0 ? parts.join(' · ') : '—';
}

function terrainName(id: string): string {
  return TERRAIN_TABLE.find((t) => t.id === id)?.name ?? id;
}

const COLUMNS = ['名称', '图标', '造价', '攻', '甲', '血', '移', '射', '视', '特性'];

function unitTable(category: UnitCategory, eraLevel: number): string {
  const rows = Object.values(UNIT_TYPES).filter(
    (u) => u.era === eraLevel && u.category === category,
  );
  if (rows.length === 0) return '';

  const body = rows
    .map(
      (u) => `
      <tr data-unit="${esc(u.id)}">
        <td class="name">${esc(u.name)}</td>
        <td class="glyph">${esc(u.short)}</td>
        <td class="num">${u.cost}</td>
        <td class="num">${u.atk}${u.burst ? `×${u.burst}` : ''}</td>
        <td class="num">${u.armor}</td>
        <td class="num">${u.maxHp}</td>
        <td class="num">${u.move === 0 ? '—' : u.move}</td>
        <td class="num">${u.range}</td>
        <td class="num">${u.vision}</td>
        <td class="traits">${traitsOf(u)}</td>
      </tr>`,
    )
    .join('');

  return `
    <h4>${CATEGORY_NAME[category]}</h4>
    <table>
      <thead><tr>${COLUMNS.map((c) => `<th>${c}</th>`).join('')}</tr></thead>
      <tbody>${body}</tbody>
    </table>`;
}

/**
 * 时代序号用的罗马数字。
 *
 * 单独一张表而不是 `['I','II',...][level-1]` 现取：现取那种写法在表长到六之后
 * 会安静地返回 undefined（"时代 undefined · 现代"），而且报错的位置离原因很远。
 * 表短了会当场抛错，比印出一行乱码强。
 */
const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI'] as const;

function romanOf(level: number): string {
  return ROMAN[level - 1] ?? `(${level})`;
}

function eraSection(): string {
  // 只印基础规则的五个时代。第六时代「现代」的数值在 ERAS 里，但它的兵
  // 全在「现代战争」包里——这里把它印出来，只会得到一节没有兵种表、
  // 却写着"升级费 1080"的空条目。那一节在扩展合册里。
  return ERAS.filter((era) => era.level <= BASE_MAX_ERA).map((era) => {
    const groups: UnitCategory[] = ['combat', 'economy', 'builder', 'building'];
    const tables = groups.map((g) => unitTable(g, era.level)).join('');
    return `
      <div class="era-block">
        <h3 id="era-${era.level}">时代 ${romanOf(era.level)} · ${esc(era.name)}</h3>
        <p class="era-meta">
          ${esc(era.hint)} ·
          升级费 ${era.upgradeCost === 0 ? '—' : `${era.upgradeCost} 金`} ·
          城市耐久 ${era.cityMaxHp} · 护甲 ${era.cityArmor} · 收入 ${era.cityIncome}
        </p>
        ${tables}
      </div>`;
  }).join('');
}

/** 全部奇想兵的 id → 名字，用来把"召唤出 skeleton"写成"召唤出 骷髅" */
const FANTASY_NAMES = new Map<string, string>();
for (const p of FANTASY_PACKS) {
  for (const u of p.units ?? []) FANTASY_NAMES.set(u.id, u.name);
}

function elementLabel(u: UnitTypeDef): string {
  if (u.cycle && u.cycle.length > 0) {
    return `轮换（${u.cycle.map((e) => ELEMENT_NAME[e]).join(' → ')}）`;
  }
  if (u.element) return ELEMENT_NAME[u.element];
  return '—';
}

/** 属性那一格：攻击属性之外，还要写清"怕什么、抗什么" */
function elementCell(u: UnitTypeDef): string {
  const parts: string[] = [];
  const atkEl = elementLabel(u);
  if (atkEl !== '—') {
    noteTerm(u.cycle && u.cycle.length > 0 ? 'cycle' : 'elem');
    parts.push(atkEl);
  }
  for (const [k, v] of Object.entries(u.weak ?? {})) {
    if ((v ?? 0) > 1) {
      noteTerm('weak');
      parts.push(`怕${ELEMENT_NAME[k as Element]}×${v}`);
    }
  }
  for (const [k, v] of Object.entries(u.resist ?? {})) {
    if ((v ?? 0) > 0) {
      noteTerm('resist');
      parts.push(`抗${ELEMENT_NAME[k as Element]} ${v}`);
    }
  }
  return parts.length > 0 ? parts.join(' · ') : '—';
}

/**
 * 奇想兵的特性列：在通用特性之外补上魔法 / 召唤 / 弹药 / 英雄这些新字段。
 *
 * 和 traitsOf 一样，这里只留数值，把"不吃护甲""同时最多几个""打完只能贴脸"
 * 这些解释挪进悬停——它们在每个法师、每个召唤师身上都是同一句。
 */
function fantasyTraits(u: UnitTypeDef): string {
  const parts: string[] = [];
  const base = traitsOf(u);
  if (base !== '—') parts.push(base);
  if (u.magicAtk) parts.push(ref('magic', `魔攻 ${u.magicAtk}`));
  if (u.magicRes) parts.push(ref('mres', `魔抗 ${u.magicRes}`));
  if (u.summon) {
    const what = u.summon.type
      ? (FANTASY_NAMES.get(u.summon.type) ?? u.summon.type)
      : `随机（${(u.summon.random ?? []).map((id) => FANTASY_NAMES.get(id) ?? id).join('/')}）`;
    parts.push(ref('summon', `召唤 ${what} ${u.summon.every}回合×${u.summon.max}`));
  }
  if (u.ammo) parts.push(ref('ammo', `弹药 ${u.ammo}`));
  if (u.hero) parts.push(ref('hero', `英雄${u.unlockCost ? ` 解锁 ${u.unlockCost}` : ''}`));
  for (const k of u.skills ?? []) {
    // 技能是兵种自带的，没有全局表：现登记一条，键用"兵种 + 技能名"，稳定可复现
    const key = dynamicTerm(
      `sk-${slug(u.id)}-${slug(k.name)}`,
      k.name,
      k.summary,
      `冷却 ${k.cooldown} 回合；不占移动与攻击。`,
    );
    parts.push(ref(key, `${k.name} CD${k.cooldown}`));
  }
  if (u.summonedOnly) parts.push(ref('summoned-only'));
  if (u.decays) parts.push(ref('decay', `自损 ${u.decays}/回合`));
  if (u.splitInto) parts.push(ref('split', `死后分裂 ${FANTASY_NAMES.get(u.splitInto) ?? u.splitInto}`));
  return parts.length > 0 ? parts.join(' · ') : '—';
}


/**
 * 特殊能力总表。
 *
 * 这一张表就是核心册的"能力词条库"：每条带 `id="t-ab-<能力id>"`，
 * 兵种表与正文里的 ref() 都指到这里。所以核心册不另印一份能力词条，
 * 否则同一段说明会在这本书里出现两遍——那正是这次要清掉的东西。
 *
 * 「谁有」只数本体兵种：扩展兵在各册里，全列进来会让这一格变成一长串人名，
 * 而每个扩展兵种的特性列本来就已经点了它的能力。
 */
function abilityTable(): string {
  const groups = ['attack', 'defense', 'move', 'support'] as const;
  return groups
    .map((g) => {
      const items = allAbilities().filter((a) => a.group === g);
      if (items.length === 0) return '';
      return `
        <h4>${ABILITY_GROUP_NAME[g]}</h4>
        <table>
          <thead><tr><th>能力</th><th>效果</th><th>本体里谁有</th></tr></thead>
          <tbody>
            ${items
              .map((a) => {
                const owners = Object.values(UNIT_TYPES)
                  .filter((u) => u.abilities?.includes(a.id))
                  .map((u) => u.name)
                  .join('、');
                return `<tr id="t-ab-${esc(a.id)}"><td class="name">${esc(a.name)}</td><td>${rich(
                  a.summary,
                )}</td><td class="traits">${owners ? esc(owners) : '—'}</td></tr>`;
              })
              .join('')}
          </tbody>
        </table>`;
    })
    .join('');
}

/** 只列小型扩展的汇总表。大型（带兵种的）各有各的分册，这里一行都不放 */
function expansionTable(): string {
  // 隐藏的扩展不印：玩家在开局面板里看不到它，手册里也就不该出现
  const small = availableExpansions().filter((e) => e.scale !== 'large');
  return `
    <table>
      <thead><tr><th>扩展</th><th>效果</th><th>附带兵种</th></tr></thead>
      <tbody>
        ${small
          .map((e) => {
            // 依赖关系要写出来：只勾子包不勾前置，子包根本不进场
            const req = (e.requires ?? []).length
              ? ` <span class="c">（需先开 ${(e.requires ?? [])
                  .map((id) => EXPANSIONS.find((x) => x.id === id)?.name ?? id)
                  .join('、')}）</span>`
              : '';
            // 默认开着的那条要标出来：新对局不特别选就是它
            const tag = DEFAULT_CONFIG.expansionIds.includes(e.id) ? '<span class="c">（默认开）</span>' : '';
            return `<tr><td class="name">${esc(e.name)}${tag}${req}</td><td>${esc(e.summary)}</td><td class="traits">—</td></tr>`;
          })
          .join('')}
      </tbody>
    </table>`;
}

function terrainTable(): string {
  return `
    <table>
      <thead><tr><th>地形</th><th>进入消耗</th><th>防御加成</th><th>说明</th></tr></thead>
      <tbody>
        ${TERRAIN_TABLE.map(
          (t) =>
            `<tr><td class="name">${esc(t.name)}</td><td class="num">${esc(t.cost)}</td><td class="num">${esc(t.def)}</td><td>${esc(t.note)}</td></tr>`,
        ).join('')}
      </tbody>
    </table>`;
}

/* ---------------------------------------------------------------------------
 * 分册骨架。
 *
 * 规则书原来只有一本，扩展规则挤在第 14 章——开了五个扩展包的人要在
 * 一份两百屏的文档里翻来翻去，没开的人则要跳过一堆和自己无关的表。
 * 现在拆成：
 *   · manual.html          核心规则（与扩展无关的那部分）
 *   · manual-small.html    小型扩展合订本（只改规则的那些开关）
 *   · manual-pack-<id>.html 大型扩展各一册（带兵种表的那些包）
 * 游戏里点「规则书」时按本局开了什么列书单（见 src/ui/books.ts）。
 * ------------------------------------------------------------------------- */

/** 每一册共用的样式。拆册之后所有书长得一样，改这一处就够 */
const MANUAL_CSS = `
  :root {
    --bg: #f5f2ea;
    --panel: #ffffff;
    --panel-2: #faf8f4;
    --text: #2b2823;
    --muted: #6b6459;
    --faint: #9a9287;
    --line: #e2ddd3;
    --a: #2f6ea8;
    --b: #b8433a;
    --accent: #b08442;
  }
  * { box-sizing: border-box; }
  html { scroll-behavior: smooth; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--text);
    font: 15px/1.75 system-ui, -apple-system, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  .layout {
    display: grid;
    grid-template-columns: 216px minmax(0, 1fr);
    gap: 44px;
    max-width: 1080px;
    margin: 0 auto;
    padding: 48px 28px 100px;
  }
  nav {
    position: sticky;
    top: 40px;
    align-self: start;
    font-size: 13px;
    max-height: calc(100vh - 80px);
    overflow-y: auto;
  }
  nav .nav-title {
    font-size: 11px;
    letter-spacing: 0.1em;
    color: var(--faint);
    margin-bottom: 10px;
  }
  nav a {
    display: block;
    padding: 4px 0 4px 10px;
    color: var(--muted);
    text-decoration: none;
    border-left: 2px solid transparent;
  }
  nav a:hover { color: var(--text); border-left-color: var(--line); }
  nav a.sub { padding-left: 22px; font-size: 12.5px; }

  main { min-width: 0; }
  header.page-head { margin-bottom: 44px; }
  header.page-head h1 {
    font-size: 28px;
    font-weight: 600;
    margin: 0 0 8px;
    letter-spacing: -0.01em;
  }
  header.page-head p {
    margin: 0;
    color: var(--muted);
    font-size: 13.5px;
  }

  section { margin-bottom: 48px; scroll-margin-top: 24px; }
  h2 {
    font-size: 19px;
    font-weight: 600;
    margin: 0 0 14px;
    padding-bottom: 8px;
    border-bottom: 1px solid var(--line);
  }
  h2 .sec-num { color: var(--faint); font-weight: 400; margin-right: 8px; }
  h3 {
    font-size: 15.5px;
    font-weight: 600;
    margin: 26px 0 8px;
  }
  h4 {
    font-size: 13px;
    font-weight: 500;
    color: var(--muted);
    margin: 18px 0 7px;
    letter-spacing: 0.02em;
  }
  p { margin: 0 0 12px; }
  ul, ol { margin: 0 0 12px; padding-left: 22px; }
  li { margin-bottom: 5px; }
  code {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.9em;
    background: var(--panel-2);
    border: 1px solid var(--line);
    border-radius: 4px;
    padding: 1px 5px;
  }
  b { font-weight: 600; }

  .formula {
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 10px;
    padding: 14px 16px;
    margin: 12px 0 16px;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 13.5px;
    line-height: 1.9;
    color: var(--text);
  }
  .formula .c { color: var(--faint); }

  .callout {
    background: #fbf7ea;
    border: 1px solid #e7dcc0;
    border-radius: 10px;
    padding: 12px 15px;
    margin: 14px 0 18px;
    font-size: 13.5px;
    color: #5d4c28;
  }
  .callout b { color: #4a3b1c; }

  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 13px;
    margin: 8px 0 18px;
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 8px;
    overflow: hidden;
  }
  th {
    text-align: left;
    font-weight: 500;
    font-size: 11.5px;
    color: var(--muted);
    background: var(--panel-2);
    padding: 7px 9px;
    border-bottom: 1px solid var(--line);
    white-space: nowrap;
  }
  td {
    padding: 6px 9px;
    border-bottom: 1px solid #efece4;
    vertical-align: top;
  }
  tbody tr:last-child td { border-bottom: none; }
  tbody tr:nth-child(even) { background: #fcfbf8; }
  td.name { font-weight: 500; white-space: nowrap; }
  td.num { font-variant-numeric: tabular-nums; text-align: right; white-space: nowrap; }
  td.nowrap { white-space: nowrap; }
  /* 合册开头那张总览：列宽固化，否则"它解决什么"会把前面几列挤成一字一行 */
  table.overview { table-layout: fixed; }
  table.overview th:nth-child(1), table.overview td:nth-child(1) { width: 17%; }
  table.overview th:nth-child(2), table.overview td:nth-child(2) { width: 7%; }
  table.overview th:nth-child(3), table.overview td:nth-child(3) { width: 11%; }
  table.overview th:nth-child(4), table.overview td:nth-child(4) { width: 11%; }
  td.glyph {
    text-align: center;
    font-weight: 600;
    color: var(--muted);
  }
  td.traits { color: var(--muted); font-size: 12.5px; }
  td.traits b { color: var(--a); font-weight: 500; }

  /* 合册的总表列多，窄屏上让它自己滚。阈值取 700：正文区在 1080 宽下是 764px，
     所以桌面上不滚；手机上滚，但那种屏幕本来也读不了十五列 */
  .scroll-x { overflow-x: auto; margin: 8px 0 18px; }
  .scroll-x table { margin: 0; min-width: 700px; }
  table.wide { font-size: 12.5px; }
  table.wide th, table.wide td { padding: 6px 8px; }
  td.src { color: var(--faint); font-size: 12px; white-space: nowrap; }
  /* 分组行：包与包的边界。写了 !important 是因为 :nth-child(even) 的斑马纹
     会把它盖掉，而这条边界比斑马纹重要得多 */
  tr.grp td {
    background: var(--panel-2) !important;
    font-size: 12px;
    font-weight: 600;
    color: var(--muted);
    letter-spacing: 0.03em;
    padding-top: 14px;
    border-top: 1px solid var(--line);
  }

  /* 机制引用：正文里只留名字，解释在悬停浮层与词条表里 */
  a.ref {
    color: inherit;
    text-decoration: none;
    border-bottom: 1px dashed #bfb6a4;
    cursor: help;
  }
  a.ref:hover, a.ref:focus { color: var(--a); border-bottom-color: var(--a); outline: none; }
  td.traits a.ref { color: var(--a); }

  .tip {
    position: fixed;
    z-index: 90;
    max-width: 320px;
    padding: 8px 11px;
    border-radius: 8px;
    background: #2b2823;
    color: #f3efe6;
    font-size: 12.5px;
    line-height: 1.65;
    box-shadow: 0 8px 26px rgba(30, 24, 12, 0.22);
    pointer-events: none;
    opacity: 0;
    transition: opacity 0.12s ease;
  }
  .tip.on { opacity: 1; }

  .terms {
    display: grid;
    grid-template-columns: 132px 1fr;
    gap: 7px 18px;
    margin: 6px 0 18px;
    font-size: 13px;
  }
  .terms dt {
    color: var(--text);
    font-weight: 500;
    padding-top: 1px;
    scroll-margin-top: 24px;
  }
  .terms dd { margin: 0; color: var(--muted); }
  .terms dd .more { color: var(--faint); }
  .terms dt:target { color: var(--a); }

  .era-block {
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 12px;
    padding: 18px 20px 6px;
    margin-bottom: 20px;
  }
  .era-block h3 { margin-top: 0; }
  .era-meta {
    font-size: 12.5px;
    color: var(--faint);
    margin: 0 0 4px;
  }
  .era-block table { border: none; background: transparent; }
  .era-block th { background: transparent; border-bottom: 1px solid var(--line); }
  .era-block tbody tr:nth-child(even) { background: transparent; }

  .kv { display: grid; grid-template-columns: 130px 1fr; gap: 6px 16px; font-size: 13.5px; margin-bottom: 16px; }
  .kv dt { color: var(--muted); }
  .kv dd { margin: 0; }

  footer {
    margin-top: 60px;
    padding-top: 18px;
    border-top: 1px solid var(--line);
    font-size: 12px;
    color: var(--faint);
  }

  @media (max-width: 860px) {
    .layout { grid-template-columns: 1fr; gap: 24px; padding: 28px 18px 70px; }
    nav { position: static; max-height: none; border-bottom: 1px solid var(--line); padding-bottom: 14px; }
  }
  @media print {
    body { background: #fff; font-size: 11pt; }
    .layout { display: block; max-width: none; padding: 0; }
    nav { display: none; }
    .tip { display: none; }
    a.ref { border-bottom: none; }
    section { page-break-inside: avoid; margin-bottom: 26px; }
    .era-block, table, .callout, .formula { page-break-inside: avoid; }
    a { color: inherit; text-decoration: none; }
  }
`;

interface Book {
  file: string;
  title: string;
  subtitle: string;
  nav: string;
  body: string;
}

/**
 * 悬停浮层。
 *
 * 为什么不用 title 属性：title 的延迟由浏览器定（通常 1 秒以上）、样式不可控、
 * 触摸屏根本不显示。读者在表格里扫一行也就一两秒，等它弹出来还不如没有。
 *
 * 为什么自己算位置而不是纯 CSS ::after：浮层贴在表格最后一行时会顶出视口，
 * 纯 CSS 没有"翻到上面去"的可能。这三十行里最重要的是那段 y 轴翻转。
 *
 * 说明文字**从词条表现取**，不写在链接上：同一个能力在几十个兵后面出现，
 * 内嵌一份就等于把同一句话存几十遍。落点有两种形态——
 * 词条表里是 `<dt id>下一格 <dd>`，能力总表里是 `<tr id>` 的第二格。
 *
 * 脚本挂了不影响阅读：a.ref 本身就是锚点，点击照常跳到词条表。
 */
const TIP_SCRIPT = `
<div class="tip" id="tip" role="tooltip"></div>
<script>
(function () {
  var tip = document.getElementById('tip');
  if (!tip) return;
  var cur = null;

  /** 从词条落点读一句话。取不到就返回空串，浮层不弹（而不是弹一个空框） */
  function textOf(href) {
    var key = (href || '').slice(1);
    if (!key) return '';
    var el = document.getElementById(key);
    if (!el) return '';
    // 能力总表：一行一个能力，效果在第二格
    if (el.tagName === 'TR') {
      var cell = el.cells && el.cells[1];
      return cell ? cell.textContent : '';
    }
    // 词条表：<dt> 名字，下一格 <dd> 是说明。more 太长，浮层只要第一段
    var dd = el.nextElementSibling;
    if (!dd) return '';
    var brief = dd.firstChild ? dd.firstChild.textContent : dd.textContent;
    return (brief || '').replace(/\\s+/g, ' ').trim();
  }

  function show(a) {
    var text = textOf(a.getAttribute('href'));
    if (!text) return;
    tip.textContent = text;
    tip.classList.add('on');
    var r = a.getBoundingClientRect();
    var w = tip.offsetWidth;
    var h = tip.offsetHeight;
    var x = r.left + r.width / 2 - w / 2;
    var y = r.top - h - 9;
    if (y < 8) y = r.bottom + 9;
    if (x < 8) x = 8;
    if (x + w > window.innerWidth - 8) x = window.innerWidth - w - 8;
    tip.style.left = x + 'px';
    tip.style.top = y + 'px';
    cur = a;
  }

  function hide() {
    tip.classList.remove('on');
    cur = null;
  }

  document.addEventListener('mouseover', function (e) {
    var t = e.target;
    var a = t && t.closest ? t.closest('a.ref') : null;
    if (a) { if (a !== cur) show(a); } else hide();
  });
  document.addEventListener('mouseout', function (e) {
    var t = e.target;
    var a = t && t.closest ? t.closest('a.ref') : null;
    if (a && a === cur && !a.contains(e.relatedTarget)) hide();
  });
  document.addEventListener('focusin', function (e) {
    var t = e.target;
    var a = t && t.closest ? t.closest('a.ref') : null;
    if (a) show(a);
  });
  document.addEventListener('focusout', hide);
  window.addEventListener('scroll', hide, true);
})();
</script>`;

/** 一册书的完整 HTML。页脚带文件名，翻到打印版也知道自己在看哪本 */
function page(b: Book): string {
  // 没有一颗机制引用的册子（季节与气候、小型合订本）不必背这 2.5KB 脚本
  const needTip = b.body.includes('class="ref"');
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>${b.title}</title>
<style>${MANUAL_CSS}</style>
</head>
<body>
<div class="layout">
  <nav>
    <div class="nav-title">目录</div>
    ${b.nav}
  </nav>

  <main>
    <header class="page-head">
      <h1>${b.title}</h1>
      <p>${b.subtitle}</p>
    </header>

${b.body}
    <footer>
      ${b.title} · 由 build-manual.ts 生成，数值直接取自配置，改完请重跑 <code>npm run manual</code>。
    </footer>
  </main>
</div>${needTip ? TIP_SCRIPT : ''}
</body>
</html>
`;
}

/* ---------------------------------------------------------------------------
 * 第一册：核心规则。
 * --------------------------------------------------------------------------- */

const CORE_NAV = `
    <a href="#goal">1. 目标</a>
    <a href="#flow">2. 回合流程</a>
    <a href="#terrain">3. 地形</a>
    <a href="#units">4. 单位总览</a>
    <a href="#move">5. 移动</a>
    <a href="#combat">6. 战斗</a>
    <a href="#siege">7. 攻城</a>
    <a href="#economy">8. 经济</a>
    <a href="#produce">9. 生产</a>
    <a href="#build">10. 建造</a>
    <a href="#era">11. 时代</a>
    <a href="#fog">12. 战争迷雾</a>
    <a href="#ability">13. 特殊能力</a>
    <a href="#roster">14. 兵种全表</a>
    <a href="#engine">15. 引擎与兼容</a>
    <a href="#ai">16. AI 托管与观战</a>
    <a href="#commander">17. 指挥官模式</a>
    <a href="#online">18. 联机与云存档</a>
    <a href="#ops">19. 认输 · 撤回 · 拆除 · 提示音</a>
    <a href="#god">20. 上帝模式（沙盒）</a>
    <a href="#terms">21. 机制词条</a>
  `;

const CORE_BODY_MAIN = `    <section id="goal">
      <h2><span class="sec-num">01</span>目标</h2>
      <p>干掉对方的抵抗能力。判定条件是两条，满足任意一条就输：</p>
      <div class="formula">
        ① <b>城市全部易主</b> → 立刻判负<br />
        ② 单位全灭 <span class="c">且</span> 金币不够造最便宜的兵 → 判负
      </div>
      <p><b>城就是根。</b>没有城市，你就产不了兵、升不了级、也断了一切收入来源——手上有多少兵都只是拖延，
        所以"丢光所有城市"直接判负，不再看你还剩几个兵。反过来，兵打光了但城还在、钱还够，你就还能再造。</p>
      <p>这一条让"绕过去偷家"变成了真正的战术：只要把对方两座城都端掉，他前线那支满编部队立刻作废。</p>
      <div class="callout">
        <b>注意时代差距。</b>伤害允许为 0，所以低两个以上时代的部队打高级装甲就是打不动。落后方唯一的翻盘路径是赶紧升级自己的城市，而不是堆兵。
      </div>
    </section>

    <section id="flow">
      <h2><span class="sec-num">02</span>回合流程</h2>
      <ol>
        <li><b>对方回合结束时</b>，你的建筑自动开火一次（打射程内最近、血最少的敌人）。<b>这一炮和你自己点的是同一炮</b>——
          本回合手动开过火的塔不再补射。早先两段都算，结果是"手动开火"变成纯白送：点它反而比等它自己打更亏。</li>
        <li><b>你的回合开始</b>，结算收入：基础 ${CONFIG.baseIncome} + 每座城按自己的时代贡献 + 每个经济单位按所在地形产出。</li>
        <li>你的单位恢复行动力（移动一次、攻击一次）。</li>
        <li>你行动：移动、攻击、攻城、建造、在城市生产、升级城市。</li>
        <li>点「结束行动」，把回合交给对方。</li>
      </ol>
      <p>热座模式下会弹出交接遮罩；人机模式下 B 由 AI 自动接管，每步停留约 0.16 秒让你看清它在干什么。</p>
    </section>

    <section id="terrain">
      <h2><span class="sec-num">03</span>地形</h2>
      <p>地形全图可见，不受迷雾影响——战场地图本来就该是已知信息。迷雾只遮对方单位。</p>
      ${terrainTable()}
      <p>点击棋盘上任何一块空地，右侧面板会显示这块地的消耗、防御加成，以及"适合布置哪些单位"（从兵种表里现查）。</p>

      <h3>水、桥与船</h3>
      <p>水和桥不是装饰，它们决定"能不能过去"：</p>
      <ul>
        <li><b>水域</b>陆军进不去，但<b>能养活一支舰队</b>。水军在水上一格一步，机动性其实比陆军好；它的短板是上不了岸、也进不了城。</li>
        <li><b>桥</b>是修在水面上的建筑：建好之后那一格变成桥面，<b>双向通行</b>——你的兵能过，对方的兵也能过。桥不是"自家专属的浮桥"，它是一条路。</li>
        <li>桥上<b>能穿过，也能停</b>：桥在那一格上，人站在桥面。守桥、堵口、走到一半换气都靠这条——一格宽的桥不是"只能穿过去的门"，而是"只站得下一个人"的窄路。</li>
        <li>桥<b>不挡水路</b>：船从桥底下过，和走在河上一样。想把一条河彻底封死，得靠岸上的兵，不能靠桥。</li>
        <li>桥有耐久（${UNIT_TYPES.bridge.maxHp}），被打掉之后地形立刻退回水面。想断掉这条路，只能把桥打塌——这是真实的防守手段，也是真实的进攻目标。<b>远程也能拆桥，但一发只算半伤</b>；贴着桥头（相邻一格）打才是满伤（详见下一节）。</li>
        <li>桥只能架在<b>至少一侧是陆地</b>的水面上——一片汪洋上架不了桥。</li>
      </ul>
      <h3>渡船：让人过水</h3>
      <ul>
        <li>渡船是水军里的运输船：<b>攻击力 0</b>，唯一的用处是把陆军运过水面。</li>
        <li>装载：选中渡船 → 点「装载」→ 点一个<b>贴着船</b>的己方陆军。上船的单位从棋盘上消失，占掉它这一回合。</li>
        <li>卸载：选中渡船 → 点「卸载」→ 点船边一格空地。下船的单位这一回合<b>不能再动也不能再打</b>——不然运输船就成了隔河空投。</li>
        <li>一次装卸会花掉渡船的 <code>acted</code>，所以<b>每回合只能装卸一次</b>；但它装完仍然可以开走。</li>
        <li><b>船沉了，舱里的人一起没。</b>载着人往炮口上冲是最贵的失误。</li>
        <li>和桥的分工：桥是永久的、双向的、便宜的；渡船是机动的、一次只送两三个，而且会被击沉。桥断了以后，渡船就是唯一的办法。</li>
      </ul>
      <div class="callout">
        桥之所以是"谁都能过"，是因为它站在一条公开的规则上：<b>地形可通行 = 谁都能走</b>。
        上一版把桥做成"只有本方部队能过"，本质上是给一方开了一条专属通道——战场上没有这种东西。
        现在桥只是一块能走的地：谁造的都不重要，你的兵能站上去，对面的兵也能站上去。
      </div>

      <h3>地貌与地图生成</h3>
      <p>每局地图由种子生成，开局时可以选地貌风格和对称方式：</p>
      <table>
        <thead><tr><th>地貌</th><th>长什么样</th><th>打起来是什么感觉</th></tr></thead>
        <tbody>
          <tr><td class="name">横河</td><td>东西向的河横在两军之间，2~3 格宽，2~3 处渡口，还会鼓出几片"汪洋"</td><td>要选在哪个渡口发力；分兵容易被各个击破，也可以造桥自己开一条口子</td></tr>
          <tr><td class="name">纵河</td><td>南北向贯通全图，同样有汪洋和渡口</td><td>沿河岸拉扯，渡口就是战场</td></tr>
          <tr><td class="name">山岭</td><td>连片高山 + 山脚丘陵，只有隘口能过</td><td>隘口是唯一的绞肉机，丘陵是攻方的掩护</td></tr>
          <tr><td class="name">开阔</td><td>没有天险，只有零散的林子和丘陵</td><td>纯拼兵力与走位，没有可以赖的地形</td></tr>
        </tbody>
      </table>
      <p>城市的摆法<b>单独抽签</b>，和河的走向无关：</p>
      <ul>
        <li><b>对峙</b>：双方各占同一条边的两角——隔着河对峙，正面冲突。</li>
        <li><b>对角</b>：双方各占一对对角——<b>河的两岸都有敌我</b>。你的北城和对方的北城可能在同侧，河不再是"敌我分界线"，而是穿过双方领土的水系。</li>
      </ul>
      <div class="callout">
        上一版是"横河就南北分家、纵河就东西分家"，于是纵河不过是把横河转了 90 度，四张图其实是两张图。
        现在布局和河各抽各的，四种组合都会出现——同样是纵河，也可能打着打着从"抢渡口"变成"守自己的河岸"。
      </div>
      <p>水域已经不再零散：河道 2~3 格宽起步并带拐弯，中段会鼓成 2~7 格宽的湖面；每座城边还有较高概率自带一小片水（那是港口，水军要靠它下水）。代价是有的图水占了近四成——那种图上，桥和船的价值会立刻凸显。</p>
      <p><b>城市间距也是随机的。</b>横向和纵向的"中间地带"各自抽签：小图上可能抽出两军隔 4 格贴脸的快棋，大图上可能抽出隔 14 格的长征局。间距直接决定第几回合接火——这比任何数值都更能改变一局的手感。</p>

      <h3>无渡口的河：必须架桥才能过</h3>
      <p>约四成的横河/纵河图会是<b>一处渡口都没有</b>的河：从地图这头连着那头，中间没有任何浅滩。</p>
      <ul>
        <li>这种河<b>只在"对峙"布局里出现</b>——也就是双方各占同一条边的两角、河真的横在两军中间。如果河只是穿过双方的领土（对角布局），它逼不出桥，也就没有意义。</li>
        <li>为了让桥铺得起，这种图的河宽被固定在 <b>2 格</b>，也不会有"汪洋"：一条 7 格宽的河要铺七座桥，那就不是障碍，是笑话。</li>
        <li>开局的战报会直接告诉你"这一局的河没有渡口"。这件事必须提前知道——你要为它准备的是十个回合的工程队和金币。</li>
        <li>一座桥 ${UNIT_TYPES.bridge.cost} 金，一次建一座，占掉工程队一整个回合。横渡 = 两座桥 = ${UNIT_TYPES.bridge.cost * 2} 金 + 两个回合；桥被打断就得重来。</li>
        <li><b>桥能接着往外递</b>：建造距离是 ${CONFIG.buildRange} 格，但沿着同一条直线上已经铺好的桥面，可以再往外接两节。工程队站在岸上就能把桥修到河心——不然三格以上的水面永远铺不通，人站不到第二段桥旁边。</li>
        <li>桥是双向的，所以你先架好的桥对方也能用。架桥之前先想清楚：这个桥头堡守不守得住。</li>
        <li><b>拆桥：远程能放箭，但一发放一半</b>。射程够就能朝桥开火（${CONFIG.bridgeRangedDamageRatio * 100}% 伤害），
          贴着桥头（相邻一格）打才是满伤——所以"隔着河拆桥"是个又慢又费的消耗动作，想把一座桥真的拆干净，还得把部队压到桥边。</li>
        <li>点桥面是<b>走过去</b>，不是选中它；想打这座桥就按住 <b>Shift</b> 点。桥没有自己的操作面板，"选中"从来不是你要的动作。</li>
      </ul>
      <div class="callout">
        这才是"桥"真正变成主角的地方：在有渡口的图上桥是捷径，在无渡口的图上<b>桥是唯一的通路</b>，
        而破坏一座桥就等于断掉对方整条补给线。反过来，桥头也是最容易被守方集火的位置——
        桥一格宽，你在桥头挤不下第二个人。
      </div>
      <p>对称方式决定两侧地形是否一样：</p>
      <ul>
        <li><b>地势各异（默认）</b>：两侧的森林、丘陵、高山<b>数量相同</b>，但<b>位置不同</b>。你熟悉的地形在对面可能是另一副样子。</li>
        <li><b>完全镜像</b>：严格点对称，最公平，也最可预测。适合认真分胜负。</li>
      </ul>
      <div class="callout">
        生成器有一条硬保证：<b>四座城之间一定连得通</b>。算法会从一座城出发算代价最高的路径，遇到绕不过去的河就架渡口、遇到山就开隘口——所以不会出现"打不起来"的废图。
      </div>
      <p>想自己看一眼生成结果：<code>npm run map</code> 会把若干张图打成 ASCII。</p>
    </section>

    <section id="units">
      <h2><span class="sec-num">04</span>单位总览</h2>
      <p>全表分四类。完整数值见 <a href="#roster">第 14 节</a>。</p>
      <dl class="kv">
        <dt>战斗单位</dt><dd>打仗的。每回合能移动一次、攻击一次。</dd>
        <dt>经济单位</dt><dd>站在合适地形上产出金币（农民在平原、伐木工在森林）。很脆，需要保护。</dd>
        <dt>建造单位</dt><dd>自己不产金，但能盖建筑。建造会占掉整个回合。</dd>
        <dt>建筑</dt><dd>移动力 0，不可移动。军事建筑每回合自动开火，经济建筑按地形产金，桥把水面变成可通行的桥面，军营则是能推到前线的产兵点。</dd>
        <dt>水军</dt><dd>只能在水面上行动（一格一步），从<b>临水城市</b>或<b>临水军营</b>边上的空水面下水。上不了岸，也进不了城；桥底下能过。</dd>
        <dt>运输船</dt><dd>渡船不打架，但它能把贴身的陆军装进货舱（容量 ${UNIT_TYPES.ferry?.capacity ?? 2}）运过水面。这是没有桥的时候唯一的过河方式，也是所有运输单位的通例：船沉了，舱里的人一起没。</dd>
      </dl>
      <div class="callout">
        <b>开局部队只给时代 1 的战斗单位</b>，外加两个经济单位（摆在城外）。高级兵、建造者、建筑都要自己想办法弄出来。
      </div>
    </section>

    <section id="move">
      <h2><span class="sec-num">05</span>移动</h2>
      <ul>
        <li>只能走<b>上下左右四方向</b>，斜向不行。这样地形和走位才有意义。</li>
        <li>每格消耗由地形决定（见第 3 节），累计不能超过单位的移动力。</li>
        <li><b>敌军挡路</b>：既不能进入，也不能穿过。</li>
        <li><b>友军可以穿过，但不能停在上面。</b></li>
        <li><b>建筑例外：站在上面是允许的。</b>桥、箭塔、军营、磨坊这类设施占着一格却永远空着，
          只会让布阵时莫名其妙地缺一个洞——所以它们可以站人：塔上有梯子、军营有营门、桥面本来就是路。
          <b>墙、栅栏、拒马、铁丝网不行</b>：它们的全部作用就是让这一格不存在，能站等于把它删了。</li>
        <li><b>对方的设施不能站</b>（桥除外，桥是双向的）：那一格还被它占着，得先打掉。</li>
        <li><b>两层：地面与空中。</b>规则从原版起就承认"天上还有一层"，只是原版兵种全在地面。
          空中单位（兵种表里写 <code>layer: air</code>）和地面<b>互不占格</b>——它能停在敌人头顶，
          敌人也能从它脚下走过；<b>地面打空中时距离 +1</b>（得先够得着头顶），
          所以射程 1 的步兵打不到隔壁那格飞着的单位。飞行单位还能掠水、在森林丘陵只花 1 步。</li>
        <li><b>对方城市格不可通行</b>，必须先把耐久打空。</li>
        <li>己方城市格可以进驻，驻军享受城市的 +3 护甲。</li>
      </ul>
      <p>选中单位后，棋盘上有四层提示：</p>
      <ul>
        <li><b>蓝色</b>：可移动范围</li>
        <li><b>淡红斜纹</b>：移动之后能打到的范围（还没移动时才显示）</li>
        <li><b>实红框</b>：现在就能打的目标</li>
        <li><b>橙色</b>：建造选址（建造模式下）</li>
      </ul>
      <div class="callout">
        移动过的单位只剩原地开火那一圈，不会再画一大片。<b>威胁范围会随状态变化</b>，看红区之前先看这个单位还有没有移动力。
      </div>
      <h3>机动与视野的整体下调</h3>
      <p>所有单位的<b>移动力和视野各削了一档</b>（视野最低 2 格）：</p>
      <ul>
        <li>移动力 <b>5 → 4</b>（斥候、骠骑兵、装甲车、炮艇），<b>4 → 3</b>（骑士、坦克、牧民、舢板），<b>3 → 2</b>（民兵、弓手、农民、劳工……）。</li>
        <li>移动力 <b>2 的单位不再下调</b>。这不是手软：森林和丘陵的进入消耗是 2，再削一档就是"永远进不了林子"，整套地形系统会当场失效。</li>
        <li>视野全部 <b>−1</b>，下限 2。斥候仍是眼睛最好的单位，但"一眼看穿对面半场"结束了。</li>
        <li><b>射程没有跟着削</b>，反而要盯住"射程 − 移速"这个差值：移速降了，远程本来就该占更多便宜。
          现在的刻度分两档：移速 1~2 的单位，射程必须 ≥ 移速 + 1（弓手 2 移 3 射、长弓 2 移 4 射、机枪 1 移 3 射）；
          移速 3 以上的重甲单位，射程至少 3 格才算远程（坦克 3 移 3 射、装甲车 4 移 3 射）。
          另外还有一档射程 2 的"长兵器"（戟兵、长枪兵那一路）：比近战多一格，但不要求压过移速。
          这两条线都有测试盯着，防止以后调数值时又把它缩回去。</li>
      </ul>
      <p>后果是全图<b>有效宽度变大</b>：以前三个回合能从家门口顶到对面城下，现在要走五六个回合，而且中间大概率隔着一道非过不可的水。</p>
    </section>

    <section id="combat">
      <h2><span class="sec-num">06</span>战斗</h2>
      <div class="formula">
        伤害 = 攻击 + 攻击方光环 − （护甲 + 防守方光环 + 地形加成）<br />
        <span class="c">然后过一遍扩展钩子，最低 0，取整</span>
      </div>
      <p>纯减法，没有随机、没有暴击。玩家能当场心算出来。</p>
      <h3>修正项</h3>
      <ul>
        <li><b>破甲</b>：防守方护甲（含地形和光环）先砍半再参与计算。</li>
        <li><b>盾墙</b>：防守方本回合没移动过时，最终伤害 −2。</li>
        <li><b>光环</b>：相邻友军提供 +2 攻击（指挥）或 +2 护甲（守护）。只加不乘，不递归。</li>
      </ul>
      <h3>反击</h3>
      <div class="formula">
        反击伤害 = 伤害 × ${CONFIG.counterAttackRatio}<br />
        <span class="c">条件：目标存活 且 攻击者在其射程内 且 攻击方没有${ref('ab-first-strike', '先手')}能力</span>
      </div>
      <p>所以远程站在射程外输出可以完全不吃反击；近战互殴时双方都掉血。</p>
      <h3>溅射与多动</h3>
      <p>两种"打得不只一下"的机制，一个是横着铺开，一个是竖着连打：</p>
      <ul>
        <li><b>溅射（splash）</b>：主目标周围 <b>N 格内</b>（曼哈顿距离，不含斜角）的敌人各吃 ${Math.round(CONFIG.splashRatio * 100)}% 伤害。
          半径按兵种不同：臼炮 / 炮台是 1 格（主目标上下左右四格），火炮是 2 格。战报里会写"溅射了谁"。
          <b>只打敌人，不打自己人</b>——打的是阵型，不是一个人。</li>
        <li><b>多动（burst）</b>：一回合能发起 <b>N 次独立攻击</b>。次数不是固定的：
          装甲车 2 次、机枪队 3 次、重机枪组 4 次。每次都是完整的一击（护甲各减一次），
          <b>可以打不同的人</b>，攻击之间也能看到新的局面再决定下一发打谁。
          次数没用完之前，这个单位<b>不算行动结束</b>。</li>
        <li><b>多动也影响反击</b>：反击次数等于攻方的攻击次数。三个单位围攻一个三动兵，
          它能还手三次；但同一个单位连打它三次，它也只还手三次——围攻比单挑更有效，
          这是这一版刻意的改动。</li>
        <li>表格里攻击列写成 <code>18×3</code> 表示"一击 18 点，一回合能打 3 次"。特性列会另外标出「溅射 N 格」「多动 N 次」。</li>
        <li>${ref('ab-siege-master', '破城')}（攻城伤害 ×1.5）现在给到了整条炮线：臼炮、火炮、坦克、铁甲舰。高时代的城又厚又能回血，
          没有破城的攻城单位在城墙下只是刮痧。</li>
        <li>反击永远是一次正常攻击：不打折、不溅射、也不因为对方多动而变弱。</li>
      </ul>
      <div class="callout">
        多动和溅射的软肋正好相反：多动兵一次只打一个人，<b>堆护甲</b>能减掉每一发；溅射是一次打一片，<b>散开阵型</b>才划算。
        多动兵还有个自己的麻烦——第一次攻击之后它就<b>走不动了</b>（攻击会把移动一并作废），
        所以剩下的几次只能站在原地打完，位置没选好就等于站着挨围攻。
      </div>

      <h3>为什么允许 0 伤害</h3>
      <p>攻击力低于护甲时就是 0。这是刻意的：差四个时代的民兵打坦克，本来就该打不动。战报会写「穿不透护甲」。</p>
      <div class="callout">
        <b>调数值时的铁律：</b>护甲每 +1 不是"+1 防御"，而是直接砍掉一点伤害。基数是 8~14 的伤害，护甲 +3 就减了 30%。所以跨时代成长主要放在攻击和血量上，护甲要克制地涨。
      </div>
    </section>

    <section id="siege">
      <h2><span class="sec-num">07</span>攻城</h2>
      <div class="formula">
        攻城伤害 = 攻击 − 城市护甲 <span class="c">（有${ref('ab-siege-master', '破城')}能力则 ×1.5）</span><br />
        <span class="c">城市不会反击。最低 0。</span>
      </div>
      <ul>
        <li>城市初始耐久 ${ERA1_HP}，随时代提升（见第 11 节）。</li>
        <li>耐久归零 → 城市变成<b>废墟</b>：不再产出、不产兵、不回血，<b>但还不算易主</b>——它仍挂在原主名下，所以不会因为"丢了一座城"立刻判负。</li>
        <li><b>派兵走进去才接管</b>：入驻时支付一笔重建费（= 城市耐久上限 × 2.5），付不起就进不去。接管后耐久恢复到上限的 ${Math.round(CITY.captureHpRatio * 100)}%，时代等级一起接收。</li>
        <li>这条把"砸开城墙"和"拿到城市"拆成了两件事：攻方必须留一支部队去占，否则只是把对面打残，没拿到产能。</li>
        <li><b>刚接管的城当回合产不了兵</b>，要等下一回合恢复。否则打下一座城就等于顺手补了一支部队，攻城反而成了补员。</li>
        <li><b>城破不等于守军死</b>：城里的守军会被逐出城外（能站哪站哪），四邻全被围死时原地留在废墟里，<b>但不会随城陷落</b>。建筑则一起损失。</li>
        <li>攻陷后<b>时代等级会一起接收</b>——抢下一座时代 III 的城，你立刻就有它的产能。</li>
      </ul>
      <p>城市 2×2 共四格，所以"驻军还是修工事"是个真实的取舍：城里站满就放不下建筑。</p>
      <h3>驻军休整：守城是有回报的</h3>
      <div class="formula">
        回血 = ${CONFIG.cityRegen} + (驻军数 − 1) × ${CONFIG.cityRegenPerExtra}，上限 ${CONFIG.cityRegenCap} / 回合<br />
        <span class="c">条件：城内有驻军，而且城墙外一圈没有对方单位</span>
      </div>
      <ul>
        <li>回血在<b>自己回合开始时</b>结算，和收入一起。</li>
        <li><b>没有驻军就不回血。</b>刚打下来的城如果一个人都不留，它就一直是残血——这才是"占领"该有的样子。</li>
        <li><b>被围城就不回血。</b>对方单位贴在城墙外一圈（含斜角），城就没法休整。想拆掉一座城，先把它围起来；反过来，想守住一座城，就得把贴脸的散兵清掉。</li>
        <li>上限 ${CONFIG.cityRegenCap}：城可以守住，但不会变成打不动的铁王八。</li>
      </ul>
      <div class="callout">
        这条规则是冲着"刚被攻陷的城太脆"去的：攻陷时耐久只恢复到上限的 ${Math.round(CITY.captureHpRatio * 100)}%，
        如果不再回血，对面留一个小队就能第二轮摘回去，等于白打。
        现在只要派驻军、清掉贴脸的敌人，它每回合自己往回爬。
      </div>
    </section>

    <section id="economy">
      <h2><span class="sec-num">08</span>经济</h2>
      <div class="formula">
        每回合收入 = ${CONFIG.baseIncome}（基础）<br />
        &nbsp;&nbsp;+ Σ 每座城市按自己的时代贡献<br />
        &nbsp;&nbsp;+ Σ 每个经济单位 / 经济建筑按所在地形产出<br />
        &nbsp;&nbsp;+ 相邻水域的额外 ${CONFIG.riverTradeBonus} 金<br />
        <span class="c">再过一个扩展钩子，最后取整</span>
      </div>
      <p>经济单位的产出看它<b>站在哪儿</b>：农民在平原最赚、牧民在丘陵最赚、伐木工在森林最赚、厂长在城里最赚。城里对农民几乎是零产出，所以人必须撒到野外去。</p>
      <p>「临水 +${CONFIG.riverTradeBonus}」是一条通用规则，适用于所有经济单位和经济建筑——这是水利、灌溉、运输的抽象。所以河边的平原是整个地图上最值钱的地。</p>
      <div class="callout">
        经济单位很脆（护甲 1~4，血 16~30）。它创造了一个新玩法：<b>你的后方开始有必须保护的东西</b>，推进时得留人看家。
      </div>

      <h3>时代升级为什么这么贵</h3>
      <div class="formula">
        升级费用：${ERAS.filter((e) => e.level <= BASE_MAX_ERA)
          .slice(1)
          .map((e) => `${esc(e.name)} ${e.upgradeCost}`)
          .join(' · ')}<br />
        <span class="c">开局 ${CONFIG.startGold} 金起步，先结一次收入后手上有两百出头</span>
      </div>
      <p>升级一次性给你三样东西：<b>更好的兵、更硬的城市、更高的城市收入</b>。三样叠在一起就是滚雪球——
        先手方只要能在第一回合升级，第二回合就能用长弓和骑士去打民兵，经济差还会自己越滚越大。</p>
      <ul>
        <li>所以第一道闸是<b>开局差一点买不起</b>：开局先结一次第一回合收入，手上有两百出头，
          离 ${ERAS[1]?.upgradeCost ?? 0} 金刚好差一点——逼你先走一两个回合的积累，而不是第一回合就把科技点上去。</li>
        <li>第二道闸是<b>升级会掏空你的兵</b>：升级那一回合你几乎造不出任何东西，等于把一整个回合押在"以后"。</li>
        <li>第三道闸是<b>收益不再指数增长</b>：城市收入从 30 → ${ERAS[4]?.cityIncome ?? 56}，涨得比造价慢得多。所以越到后面，升级越像"解锁更强的兵"，而不是"印钞"。</li>
      </ul>
      <div class="callout">
        想调整节奏就看两个数：<code>ERAS[].upgradeCost</code>（越贵越慢）和 <code>ERAS[].cityIncome</code>（越低越穷）。
        改这个表之后记得同步 <code>CONFIG.startGold</code>——"开局买不起"是刻意的设计，不是巧合。
      </div>
    </section>

    <section id="produce">
      <h2><span class="sec-num">09</span>生产</h2>
      <ul>
        <li>只能在<b>自己的城市格</b>里产兵，而且那一格必须是空的。</li>
        <li>城市只能造<b>当前时代和上一个时代</b>的兵种。换句话说：<b>比城市低两个时代（含更老）的战斗单位一律不能生产</b>——已经淘汰的装备不会再开产线，否则到了现代还要在面板里翻十个早就没用的兵。</li>
        <li>这条对所有兵种一视同仁：原版兵和扩展包带来的兵都按同一把尺子卡（<code>def.era &lt; 城市时代 − 1</code> 直接拒绝，面板里也不会列出来）。军营按"最近一座己方城市"的时代算。</li>
        <li>建筑不在城市生产列表里，得由建造单位去盖（见第 10 节）。</li>
        <li>新兵<b>当回合不能行动</b>，否则等于凭空多一次攻击。</li>
        <li><b>水军要临水</b>：城市旁边必须有一格空水面，船就下在那儿。内陆城市造不了船。</li>
        <li><b>军营</b>是第二个产兵点：兵从营门四邻的空地出来，规则和城市完全一样，唯一的区别是<b>它自己没有时代</b>——时代取离它最近的己方城市。军营不用升级，所以前线的兵种水平跟着后方那座城走。</li>
        <li><b>军营必须扎在水边</b>：脚下要是平地或丘陵，四邻还要有一格水面（桥面也算，桥下就是河）。粮秣、饮水、船运都得靠水，这条同时给了水军存在的理由——补给点必然在水上，也就必然会被船盯上。</li>
        <li>军营分五档，跟着建造单位的时代解锁：<b>军营（古典）→ 寨垒（中世）→ 堡寨（火药）→ 兵站（工业）→ 前进基地（二战）</b>。越高档耐久越高、哨兵火力越强，产兵规则完全一样（时代取最近的城市）。所以"把补给点往前推"这件事，是可以跟着时代一起升级的。第六档<b>联合作战中心</b>在扩展「现代」里，和这一代的其他建筑一样是那个包带进来的。</li>
        <li><b>兵种多了有搜索框</b>：一屏超过 6 种兵时，生产列表顶上会出现一个输入框，敲名字、代号、职能（战斗 / 经济 / 建造）、
          时代或<b>扩展包名</b>都能过滤，多个词按"且"算（"奇想 弓"）。它只过滤列表，不改变能买什么。</li>
        <li><b>带徽标的就是扩展兵</b>：名字旁边那个小圆标写着它来自哪个包。原版兵不挂——
          不然一屏四十行，一半带标就成了噪音。</li>
        <li><b>没有产兵上限</b>。钱、格子、每回合那几次行动本身就是约束，堆兵的自然代价比一条全局上限更有说服力。<b>建筑也不占编制</b>——它是工地不是部队。（只有 AI 给自己设了 ${CONFIG.maxUnits} 的上限，免得它把钱全换成兵、后方一座城都不修。）</li>
      </ul>
    </section>

    <section id="build">
      <h2><span class="sec-num">10</span>建造</h2>
      <p>建筑不是凭空出现的：得有一个<b>建造单位</b>走过去，花钱，把这一回合搭进去。</p>
      <ol>
        <li>选中建造单位，面板底部会出现「可建造」列表。</li>
        <li>点其中一项，棋盘上高亮出它周围 <b>${CONFIG.buildRange} 格</b>内的空地。</li>
        <li>点一块地，开工。</li>
      </ol>
      <ul>
        <li>建造消耗该单位<b>整个回合</b>（移动和攻击都没了）。</li>
        <li>建造者本身攻击力只有 4~5、血 20~30，派到前线修工事是真的有风险。</li>
        <li>军事建筑在<b>对方回合开始时</b>自动开火，打射程内最近且血最少的敌人。有攻击力也有射程，所以被单位攻击时会正常反击。军营同样有哨兵，贴到营门口会被敲一下。</li>
        <li>建筑的火力<b>一轮只有一段</b>：你自己点过（手动画出攻击范围再点目标），回合交给对方时它就不再补射；
          没点过，才轮到自动那一下。刚建好的建筑当回合不能动，所以第一炮总是自动打的。</li>
        <li><b>军营只能扎在平原或丘陵上</b>（地形要求写在兵种数据里，不写死在代码里）。它是最便宜的"把补给点往前推"的办法：省掉新兵从后方跑到前线的那几个回合。</li>
        <li><b>建在自家城里要留出兵位</b>：如果这一格是这座城最后一个空位，界面会拒绝开工并说明原因。
          这一条是踩出来的——在只剩一格空地的城里盖座塔，城市的产兵格就变成 0，从此一兵不出，
          而界面上只有一句"没有可造的兵"。宁可不让建，也不让人莫名其妙地卡死自己。</li>
        <li><b>拆除</b>：选中自己的建筑或单位，面板底部有「拆除」。
          只有<b>完整无损</b>的才回收造价的 ${Math.round(
            CONFIG.disbandRefund * 100,
          )}%；<b>残血的一律不回收金币</b>——打剩的兵退回去还能换钱的话，
          撤退就变成理财了。建筑同理：塌了半边的塔拆掉也不退。
          本来也不给全额退：全额退款等于"造一个侦察兵看一眼、原地拆掉回本"，一条零成本的开图路线。</li>
      </ul>
    </section>

    <section id="era">
      <h2><span class="sec-num">11</span>时代</h2>
      <p>时代是<b>城市自己的属性</b>，不是全局科技。后方憋一座三级城、前线全是一级城，是完全合法的打法。</p>
      <table>
        <thead>
          <tr><th>时代</th><th>升级费</th><th>城市耐久</th><th>城市护甲</th><th>城市收入</th></tr>
        </thead>
        <tbody>
          ${ERAS.filter((e) => e.level <= BASE_MAX_ERA)
            .map(
              (e) =>
                `<tr><td class="name">${esc(e.name)}</td><td class="num">${e.upgradeCost === 0 ? '—' : e.upgradeCost}</td><td class="num">${e.cityMaxHp}</td><td class="num">${e.cityArmor}</td><td class="num">${e.cityIncome}</td></tr>`,
            )
            .join('')}
        </tbody>
      </table>
      <p>升级会同时提升耐久、护甲、收入，并解锁新兵种。升级用<b>增量</b>而非覆盖，所以扩展规则（比如「要塞」）给城市加的属性不会被升级抹掉。</p>
      <p><b>表里还有第六时代「现代」（升级费 ${ERAS[5]?.upgradeCost ?? 1080}，城市耐久 ${ERAS[5]?.cityMaxHp ?? 96}，城市护甲 ${ERAS[5]?.cityArmor ?? 14}），但基础规则升不上去</b>：
        它的开关是扩展「现代」——和原版每一代一样，那个包既开这一级科技，也带<b>这一代最基本的九个兵</b>
        （步兵班、坦克、榴弹炮、装甲侦察车、物流中心、工程兵、混凝土碉堡、产业园、联合作战中心），
        只勾它就能打完一整局。想再要这一代的专精兵（直升机、无人机、反坦克导弹、火箭炮、防空导弹……），
        另勾「现代战争」（它 <code>requires</code> 「现代」，单独勾会整包不进场）。
        没开「现代」时，升级按钮到第五时代就停了，提示会明确写出"没开「现代」，科技线到二战封顶"。</p>
      <h3>标准对局：时代和棋盘是配套的</h3>
      <table>
        <thead><tr><th>起始时代</th><th>棋盘</th><th>为什么这么配</th></tr></thead>
        <tbody>
          <tr><td class="name">古典（默认）</td><td>12×12</td><td>兵走得慢、打得近，小图才能在十几回合里接上火</td></tr>
          <tr><td class="name">中世</td><td>16×16</td><td>长弓和骑兵把战线拉开了一档</td></tr>
          <tr><td class="name">火药 / 工业 / 二战</td><td>20×20</td><td>射程 3~4 格、火炮能隔山打牛，图小了根本摆不开</td></tr>
          <tr><td class="name">现代（需「现代」）</td><td>20×20</td><td>远程火箭炮与自行榴弹炮封顶 5 格、防空导弹要够得着直升机——再小就变成一开局就被隔河点名</td></tr>
          <tr><td class="name">长期局（手动选）</td><td>32×32</td><td>五级链条全开也不嫌挤；一格只有二十来像素，配合缩放看</td></tr>
          <tr><td class="name">自定义</td><td>4×4 ~ 64×64</td><td>任意边长，面板里直接填数字</td></tr>
        </tbody>
      </table>
      <p>边长<b>下限 4、上限 64</b>：4×4 是一边一座城的"街角斗殴"图（不画河也不画山脊，
        16 格里有 8 格是城），64×64 是 4096 格、必须配合缩放。越界的输入会被夹到边界上。</p>
      <p>在开局面板里点起始时代，棋盘尺寸会<b>自动</b>切到配套的那一档（当然你也可以手动改）。</p>
      <p><b>城市最小间距 = 棋盘最短边的 1/4</b>（12→3、16→4、20→5、32→8，格数为曼哈顿距离）：
        四座城随机撒点，但任意两座都不会比这更近。这条以前只是"尽力而为"，
        镜像图上经常撒出两城贴脸甚至重叠的图，现在改成硬约束——撒不出来就换一次重来，
        实在不行退回四个角的规整布局。</p>
      <h3>缩放</h3>
      <p>棋盘右下角有 <b>−／适应／＋</b> 三档：1× 是"整张图塞进屏幕"，最多能放到 3×。
        放大之后<b>按住地图直接拖</b>就能平移（鼠标和手指都行），也保留滚动条；拖动本身不算点击，
        松手不会顺带走一步棋。
        放大是<b>把每个格子真的画大</b>（不是把整块画布拉糊），所以字和血条一起变清楚；
        超出的部分用滚动看，缩放时会自动把视口挪到地图中间。</p>
      <p>为什么要它：32×32 的图"适应屏幕"之后一格约 20 像素，认得出棋子、看不清位置。
        这也正是大地图不能只靠"图更大"来做多线的原因——看得见全图和在某一处看得清，是两件事。</p>
      <p>开局时可以选起始时代（1~5；勾了「现代」还能选第 6 时代）。越高，一局越短：</p>
      <ul>
        <li>古典开局：完整五级链条，适合打整晚</li>
        <li>火药开局：跳过冷兵器，直接进入排队枪毙</li>
        <li>二战开局：纯装甲对抗，二十分钟一局</li>
        <li>现代开局（勾「现代」）：榴弹炮与装甲侦察车，打的是视野和正面厚度，十来分钟一局</li>
        <li>现代 + 「现代战争」：再上一层专精兵，导弹、直升机、无人机，打的是射程差和克制</li>
      </ul>
    </section>

    <section id="fog">
      <h2><span class="sec-num">12</span>战争迷雾</h2>
      <ul>
        <li>地形始终可见，<b>只有对方单位受迷雾影响</b>。</li>
        <li>视野来源：己方单位的视野半径、己方城市周围 ${CONFIG.cityVision} 格。</li>
        <li>离开视野的敌人会留下<b>半透明幽灵</b>，标在最后已知位置。移动过或已阵亡你都无从确认——这正是它的乐趣。</li>
        <li>玩家视角恒等于当前行动方。人机对战时 AI 也只吃同一份过滤后的视图，不作弊。</li>
      </ul>
      <div class="callout">
        幽灵标记是「迷雾」和「长回合异步」交叉出来的刚需：你隔一天回到游戏，战场上你只记得"上次他在河边"，这个记忆必须被画出来。
      </div>
    </section>

    <section id="ability">
      <h2><span class="sec-num">13</span>特殊能力</h2>
      <p>数值决定"多强"，能力决定"怎么打"。每个能力都是纯标记 + 规则里的一段分支。</p>
      ${abilityTable()}
      <p>可以在兵种编辑器里给自定义兵种勾选任意组合。加一个新能力只需要两步：在能力的主人那里加一条定义（本体兵种写在 <code>abilities.ts</code>，扩展兵种写在扩展自己的文件里），再让兵种写上它的 id。<code>rules.ts</code> 不用改——它只负责在正确的时机问一句。</p>
    </section>


    <section id="roster">
      <h2><span class="sec-num">14</span>兵种全表</h2>
      <p>原版 ${Object.keys(UNIT_TYPES).length} 个兵种，按时代分组。「特性」列里的能力和产出都是由数据自动生成的，改了配置这里会跟着变。
        扩展包带来的兵在<b>扩展合册</b>里：奇想五包一本、时代兵备七包一本（点顶栏「规则书」会按这一局开了什么列出来）。
        第六时代「现代」在基础规则里是空的，所以它和原版每一代一样拆成"底座 + 加料"两个包：
        「现代」带这一代最基本的九个兵，「现代战争」再往上加十五个专精兵。不勾「现代」，这里只有五节。</p>
      ${eraSection()}
    </section>

    <section id="engine">
      <h2><span class="sec-num">15</span>引擎与兼容</h2>
      <h3>确定性</h3>
      <p>规则内核是纯函数 <code>(state, action) → state</code>，不碰 DOM、不发网络、不读系统时间、不用 <code>Math.random</code>。所有随机都从 <code>state.seed</code> 派生。所以：</p>
      <ul>
        <li>存档就是一个 JSON，每步自动落盘</li>
        <li>回放 = 把 action 列表重放一遍</li>
        <li>同一个种子永远生成同一张地图</li>
      </ul>
      <h3>存档自包含</h3>
      <p>对局的兵种表（<code>state.unitTypes</code>）完整存在存档里，所以你把对局发给别人，对方不需要装你的自定义兵种也能接着玩。</p>
      <h3>自定义兵种</h3>
      <p>内置兵种只读（那是平衡基准）。想改手感就复制一份，自定义的带 <code>c_</code> 前缀存在本机，不会污染内置表。可以导出 JSON 发给别人。</p>
      <h3>文件结构</h3>
      <table>
        <thead><tr><th>文件</th><th>职责</th></tr></thead>
        <tbody>
          <tr><td class="name">core/types.ts</td><td>全部类型；GameState 必须可 JSON 序列化</td></tr>
          <tr><td class="name">core/config.ts</td><td>时代、兵种、地形、经济数值</td></tr>
          <tr><td class="name">core/ability-hooks.ts</td><td>能力的钩子接口与时机（只定接口，不写实现）</td></tr>
          <tr><td class="name">core/abilities.ts</td><td>本体兵种的公共能力表</td></tr>
          <tr><td class="name">core/ability-registry.ts</td><td>核心表 + 各扩展贡献的能力，合并成一张查询表</td></tr>
          <tr><td class="name">core/expansions.ts</td><td>扩展规则与扩展兵种</td></tr>
          <tr><td class="name">core/rules.ts</td><td>唯一的状态迁移入口</td></tr>
          <tr><td class="name">core/mapgen.ts</td><td>分区地图生成器（地貌 / 对称 / 连通性）</td></tr>
          <tr><td class="name">core/fog.ts</td><td>视图过滤（迷雾）</td></tr>
          <tr><td class="name">core/ai.ts</td><td>启发式 AI</td></tr>
          <tr><td class="name">core/customUnits.ts</td><td>自定义兵种存储</td></tr>
          <tr><td class="name">net/room.ts</td><td>联机房间读写（云数据库）</td></tr>
          <tr><td class="name">storage/save.ts</td><td>本机草稿存档；按房间分槽</td></tr>
        </tbody>
      </table>
      <h3>验证</h3>
      <p><code>npm test</code> 检查规则内核、AI 战术与高差场景、评估统计方法，以及界面冒烟（jsdom 跑整页）。任何一项失败，CI 都会红。</p>
    </section>

    <section id="ai">
      <h2><span class="sec-num">16</span>AI 托管与观战</h2>
      <p>AI 和玩家吃同一份迷雾视图（不作弊），决策不碰 <code>Math.random</code>，随机性从种子派生。几条它自己会算的事：</p>
      <ul>
        <li><b>手长单位不往前顶</b>：射程里已经有人时，弓手会停在射程边缘开火，而不是往前挪到近战怀里。只有"挪过去能多打几个目标"才会继续前进。</li>
        <li><b>过不了河就架桥</b>：算得出"纯走旱路摸不到对方城市"时，全军往最窄的渡口集结，工程队优先去铺桥。
          已经铺出去的桥会<b>接着往外递</b>，而不是下回合换个地方重来——同一条河段上桥铺到四座就算够了。</li>
        <li><b>拆桥看态势</b>：桥不是"战果"，拆掉它不减对面的兵。所以 AI 只在这两种情况下拿攻击去拆桥—
          <b>桥顶着它自己的城门</b>（死守，拆了你就得绕路或重新架），或者<b>桥在你那一侧、它正往前推</b>（掐你的增援线）。
          在攒钱、在收缩、已经放弃进攻的时候，它不会为了拆一座谁都不过的桥花掉一次攻击。</li>
        <li><b>会往前线扎军营</b>：军营是唯一能把钱直接变成"前线产兵点"的东西。选位讲究"不近不远"——
          离敌人 6~9 格最值，贴着敌人在下回合就被推平，缩在后方等于没造。每城一座、最多四座。</li>
        <li><b>不砌塔</b>：军事建筑每座城最多一座，否则钱会全变成城墙。</li>
        <li><b>集中打一座城</b>：主攻方向的权重压得比其它敌城低一截（0.32 : 0.85），
          全军朝同一座城收，而不是四路各挠一下。这条是专门为大地图加的：
          32×32 上原来两军在中场互相绕圈，40 个回合一座城都推不动；
          现在同样 40 回合，攻城次数翻倍、城市掉血从 97 涨到 249。
          主攻方向取"血最少的那座，同血取最近的"。</li>
        <li><b>水军看地图造</b>：水域占比不到 8%（开阔、山岭图）就干脆不造船——
          一个池塘里转圈的舢板只是四十五金的靶子；河图上才正经下水。</li>
        <li><b>高时代会换装</b>：工业/现代单位在打分里有额外权重，造价惩罚也放宽——
          否则它算下来永远觉得"三个火枪兵比一辆坦克划算"，一辈子不换代。</li>
        <li><b>按编队模板配兵</b>：招兵不是每次都挑"分最高的那个"，而是先看这支部队缺哪一档职能——
          <b>前排 / 近战输出 / 远程 / 支援</b>，目标配比 30 : 25 : 30 : 15。缺得越多，那一档加的分越多（最多 +12），
          所以一屋子近战之后它会去找弓手和牧师，而不是再买一个近战。攻城器不占常备编制，只在压到城下时才加分；
          同一个兵种买多了也会递减（第三个之后开始掉分），所以不会五个兵位全是一种兵。</li>
        <li><b>会收废墟</b>：城被打空之后只是废墟（不产兵、不产出、不回血），
          得派兵走进去、付重建费才易主。AI 现在会朝最近的、付得起重建费的废墟开拔，
          站上去完成接管；钱不够就不去（规则会拒绝这一步，白走一趟只会卡住它自己）。
          自己的城被砸成废墟时更急——那是产线断了。</li>
        <li><b>会围攻</b>：每回合挑血最少的那座对方城市作为<b>主攻方向</b>，全军往那边收；
          已经贴着城的友军越多，继续往上压的分越高（一座城每回合回血 3~6，一个人打是永远打不下来的）；
          城一旦掉过半血，补刀优先级再抬一档。因为"丢光所有城市就输"，收敛攻城 = 直接赢。</li>
      </ul>
      <p>AI 是一个"一步前瞻 + 启发式打分"的贪心对手：把所有能做的动作列出来各打一个分，挑最高的做，然后重新评估。它<b>只吃迷雾过滤后的视图</b>，跟你看到的东西一样多，所以它不会作弊——你用 AI 测出来的平衡是可信的。</p>
      <h3>两档难度</h3>
      <p>
        新对局面板里选完「人机对战」或「双 AI 观战」之后，会多出一行 <b>初级 AI / 高级 AI</b>。
        两档跑的是同一套代码、同一套地形与架桥逻辑，差别只在「打分算得多细」。
      </p>
      <table>
        <thead><tr><th>行为</th><th>初级 AI</th><th>高级 AI</th></tr></thead>
        <tbody>
          <tr><td class="name">威胁图</td><td>只看「有没有人能打到我」，一个和五个一样怕</td><td>数得清有几只：周围每多一个敌人就多扣分，越贵的单位、越残的单位扣得越狠</td></tr>
          <tr><td class="name">换子判断</td><td>按掉血比例算划不划算</td><td>按身价算：拿坦克换民兵这种亏本买卖会主动避开</td></tr>
          <tr><td class="name">兵种搭配</td><td>纯按单价估</td><td>按编队模板补：前排 / 近战 / 远程 / 支援缺哪档补哪档，同一种兵买多了还会递减</td></tr>
          <tr><td class="name">经济兵走位</td><td>哪块地赚得多就站哪</td><td>先看这块地会不会被抢，被围了宁可不种也要撤</td></tr>
          <tr><td class="name">随机幅度</td><td>大：同等分数里挑得比较随便</td><td>小：出手更集中，不会因为噪声造一个明显不合适的兵</td></tr>
        </tbody>
      </table>
      <p>
        注意：<b>「不会把自己憋死」这类修正两档都有</b>。地形困死的兵种不招、远程不往近战怀里挪、建造者会躲、攻城有主攻方向——
        这些是补漏洞，不是难度；把漏洞留在初级里只会让人误以为这游戏的 AI 就是傻的。
      </p>

      <h3>三种用法</h3>
      <table>
        <thead><tr><th>用法</th><th>怎么开</th><th>适合干什么</th></tr></thead>
        <tbody>
          <tr><td class="name">人机对战</td><td>新对局面板选「人机对战」</td><td>自己练手，或验证某个兵种好不好用</td></tr>
          <tr><td class="name">双 AI 观战</td><td>新对局面板选「双 AI 观战」</td><td>把两边都交出去，看它自己打完整局——调平衡最快的手段</td></tr>
          <tr><td class="name">中途托管</td><td>顶栏「交给 AI」／「收回操作权」</td><td>这一回合懒得走，或者想看看"换成它会怎么打"</td></tr>
        </tbody>
      </table>
      <ul>
        <li>托管是<b>按当前行动方</b>切换的，随时可以收回来接着自己走。</li>
        <li>观战时顶栏出现「暂停」「速度」：慢 / 快 / 极快（极快是一帧算完一个回合，中间不重绘）。</li>
        <li>双 AI 观战给的是<b>全图视角</b>——这时候没有"自己这一边"，迷雾没有意义。</li>
        <li>AI 不碰 <code>Math.random</code>：它的随机性是从 <code>(seed, 回合, 已走步数)</code> 派生的，所以同一局面永远同一个决策，"它为什么走这一步"仍然可复现。</li>
        <li>但每回合的值都不一样：评分咬得很紧的几个动作里它会随机挑一个，所以同一种局面它会左翼一次、右翼一次。</li>
        <li>每局还有自己的<b>性格</b>（从种子长出来）：推进欲望 0.85~1.2 决定它多敢往前顶，另有两个偏爱兵种，所以每局的部队组成都不一样。</li>
      </ul>
      <div class="callout">
        托管开关记在对局里（<code>state.aiControl</code>），不是只记在界面状态里。所以存档带上它，刷新之后这一方仍然是托管的。
      </div>

      <h3>让人旁观：观战位</h3>
      <p>
        想看别人打，不用抢座位。联机面板里输房间码点 <b>「只看」</b>，或者直接把邀请链接发过去——
        如果两个座位都有人了，链接会自动以观战身份打开，而不是弹一句"席位满了"。
      </p>
      <ul>
        <li><b>观战不占座</b>：座位是互斥的（两个人不能同时执 A），观战不是。几个人同时看同一局都行，也不会互相挤掉。</li>
        <li><b>观战是全图视角</b>：双方的伏兵、金币、正在造的兵全都看得见。适合看完局、复盘、开黑时说"你这步不对"。</li>
        <li>也正因如此，别在两个人还在打的时候开着麦念棋盘——那是替对面开图。</li>
        <li>观战只能看：走子、产兵、提交、认输全部锁住，点单位只会弹出属性卡。</li>
        <li><b>范围只画一边</b>：点一个单位，只显示它自己那一方的移动 / 攻击范围，而且只在"轮到它这一方、它还没动"的时候画。
          两边一起画是一堆叠在一起的高亮，看不出这一步到底谁有威胁；按归属画又会在轮到对面时全盘空白。</li>
        <li><b>走子会走给你看</b>：棋子沿着路线一格一格挪过去，而不是原地闪到终点。路线只用于演出，
          不看移动力、也不看单位阻挡——它是"这一步大概怎么走的"，不是合法性证明。</li>
        <li>观战同样是"每次提交才同步"：对方点完「结束回合」，你这边下一次轮询就会看到新局面。</li>
      </ul>
      <div class="callout">
        观战位刻意<b>没有</b>在数据库里加一列。加列意味着给已经在跑的房间做迁移，
        而观战本来就不需要互斥——它只是本机的一个视角标记：不 claimSeat、提交被 myTurn 挡住、渲染给全图。
        代价写在上面那条：看得见一切。
      </div>
    </section>

    <section id="commander">
      <h2><span class="sec-num">17</span>指挥官模式</h2>
      <p>
        只当指挥官，不当连长：你决定<b>接下来几回合各造什么兵</b>，
        其余的——建造建筑、升级城市、走位、攻击、上下船——全部交给 AI。
      </p>
      <p>开局时在「你的角色」里选「指挥官模式」。之后<b>一批只做一次决定</b>：</p>
      <ol>
        <li>顶栏下面那条「参谋部」横带里有 <b>5 格生产序列</b>，第一格标着「本回合」。</li>
        <li><b>每格有两个下拉</b>：左边选兵种（或者「升级时代」「不指定」），
            右边选<b>由谁产</b>——某座城（写作「城名 · 几代」，比如「铁炉堡 · 3 代」）或者某座军营。
            右边留「哪座都行」就是老规矩：AI 自己挑一座造得出来的。</li>
        <li>点了名字就<b>只认那一座</b>。那座城的时代不够造这个兵、或者它旁边一圈出兵格都站满了人，
          这一格就空转——AI 不会「体贴地」换一座城偷偷把兵造出来。真要赶时间，把右边改回「哪座都行」。</li>
        <li>兵种能<b>按包筛</b>：参谋部横带里那排 chip 是这一局开着的扩展（「原版」是本体那批货），
            后面跟着的数字是它在名单里占几个。点一个就只剩这个包的兵。</li>
        <li>也能<b>按时代筛</b>：「全时代 / 5 代 · 现代 / 4 代 · 工业 …」。名字取自规则书里那套时代表，
            不另起一套叫法。</li>
        <li>两个维度可以<b>只用其中一个，也可以叠起来用</b>（先点包、再点代，两个条件是"并且"）。
            再点一次已经选中的那颗＝取消它，和别处的 chip 一个手感。</li>
        <li>筛出来的数目写在右边（「12 / 30 个兵种（已筛选）」）。筛了<b>不影响已经排好的格子</b>——
            格子里那个即使被筛掉了也照旧显示、照旧生效，筛的只是下拉里给你挑的东西。
            一个都没命中时下拉里会写明「这个筛选组合下没有兵种」，不是列表坏了。</li>
        <li>名单里只有一个包或者只有一个时代时，那一排 chip 直接不出现：按下去筛不掉任何东西的按钮，
            比没有这颗按钮更让人困惑。</li>
        <li>每格下面写着「≈ N 金」——那是<b>那一回合手上大概有多少钱</b>：
            现有金币 ＋ 中间几次收入 − 前面几格的花费。预算不够时数字变红。</li>
        <li>点一次「执行 5 回合」，AI 把这 5 个回合（连同对手的 5 个回合）一起打完；中途可以按「中断」。</li>
        <li><b>联机时只走一回合。</b>对面坐的是人，替他把棋下了等于替他做决定，所以按钮变成「执行本回合并提交」——
            走完自己这一回合就推上去等他，等云端把回合交回来再走下一格。</li>
        <li>单机打完之后序列<b>原样留着</b>：不改就直接再点一次执行，排一次能用很多批。
            联机则是每提交一次前移一格——那 5 格就是接下来的 5 个回合。</li>
      </ol>
      <p>
        手机上这条横带默认折成一行（只留「参谋部 + 排计划」），点开才铺出 5 格。
        顶栏本来就吃掉一截屏幕，再让 5 个下拉常驻，棋盘就只剩一条缝了。
      </p>
      <h3>几条硬规则</h3>
      <ul>
        <li><b>每回合最多产 1 个兵</b>。序列就是「一回合一个」——允许多造，计划里的顺序就失去意义了。</li>
        <li><b>造不出来也照样消耗那一格</b>。钱不够、城市时代不够，这一格就是空的。
          这是这个模式的核心取舍：得算着钱排计划，不是把想要的写上去等它实现。</li>
        <li><b>点名的兵不会被顶替</b>。排了坦克但造不起，AI 不会「体贴地」换个民兵顶上，它这回合就不产兵。</li>
        <li><b>点名的城也不换人</b>。这是同一件事的另一半：造兵点和兵种一样是计划的一部分。
          排「坦克 · 铁炉堡」是为了让那座城正好攒够钱、正好在关键路口出兵；
          AI 换个城造出来，兵种对了、位置和家底全错了。</li>
        <li><b>英雄第一次要连解锁费一起付</b>。下拉里直接写成「矮人王 · 360 ＋ 解锁 150 金」，
          下面那行「≈ N 金」也按含解锁费算——第一次买英雄按原价算，你会在执行到那一格时发现钱不够。</li>
        <li><b>场上已经有一个的英雄，排不进去</b>：选它的那一格选项被标成「已在场」并灰掉
          （同一份计划里前面几格已经排了它，后面几格同样灰掉）。不死鸟那枚蛋还没孵出来时也一样
          ——蛋里的那只已经在路上了，再买一只就是两只。</li>

        <li><b>中间可以留空</b>：排「弓手 → 空 → 民兵」就是第二回合故意不造、第三回合造民兵。</li>
        <li><b>走位归 AI，但看得见</b>。移动和攻击都不响应；点单位、点城市、点空地照样弹卡片——
            序列里排了「长弓手 · 40 金」，想知道它射程几格，点一下就知道了。</li>
        <li><b>遣散留着</b>。这是棋盘上唯一还能按的按钮：兵造多了占着路口、想腾出钱去升时代，
            拆掉一个满血兵回收四成。「这个兵还留不留」是经济决定，不该由 AI 替你拍板
            ——它只会按当下最优摆兵，不会替你攒下一波的钱。</li>
        <li><b>升级时代也归你</b>。排了「升级时代」，这一回合就专注升级、不产兵；没排，AI 就不会自作主张升。
          什么时候换代和造什么兵是同一层的决定，交出去一半就没得算了。
          这一格右边那个下拉指的就是<b>升哪一座城</b>——攒了很久钱的那座、或者马上要接战的那座。</li>
        <li>建筑不能进序列——建筑是建造单位走过去盖的，序列里只能排会被「造出来」的单位。</li>
      </ul>
      <p>
        序列存在对局状态里、跟着存档走，刷新页面不会丢；它同样是<b>可复现</b>的：
        同一个种子、同一条序列、同样的对手，跑出来是同一局。
        产兵点和序列<b>一格对一格</b>存着（存在同一个对象的另一个字段里），回合末跟着序列一起前移；
        老存档里没有这一栏，读出来就是「全部不指定」，不需要迁移。
      </p>
      <h3>拿它当尺子</h3>
      <p>
        指挥官模式<b>对 AI 同样生效</b>：在它下面选「双 AI 观战」，两边都只剩「一回合一个兵」的产能。
        这正是量「这套限制下 AI 还能打成什么样」的场景——如果限制下 AI 依旧能推得动，
        说明每回合两个兵本来就是过剩产能；如果立刻打成一团浆糊，说明节奏是靠堆兵撑起来的。
      </p>
      <p>
        <b>AI 也排序列。</b>它不是一回合一个兵地临时决定造什么——那样它只会做局部最优
        （谁便宜造谁），永远不会为下一级兵攒三个回合的钱，这个模式对它就等于只剩下"少造"。
        它每次排满 5 格，并且排的时候会把前面几格的产出算进去（先排了两个农民，
        第三格就不会再排农民），所以它也会做"先铺经济、后转兵"这种跨回合的取舍。
        一格升级最多排一次：占掉一格就是五个回合少一个兵。
      </p>
      <p>
        它排计划时<b>不点产兵点</b>——等价于「哪座都行」，挑城市这一步留给执行时的走位去决定。
        点产兵点是人手上的杠杆：你比 AI 多知道一件事，下一波要从哪个方向打过来。
      </p>
      <p>
        也就是说，人机对局里双方受同一套约束、也都在算同一笔账——观战看到的不是
        "这条限制的下界"，而是两个都会排计划的指挥官在互相博弈。
      </p>
    </section>

    <section id="online">
      <h2><span class="sec-num">18</span>联机与云存档</h2>
      <p>这是给"一回合半小时、各走一段再交接"准备的。点顶栏「联机」把当前这局挂到云上，拿到一个 6 位房间码；对方在任意设备上输入代码，或者直接点邀请链接，就坐进这一局。</p>
      <h3>规则</h3>
      <ul>
        <li><b>结束回合＝提交。</b>你不点「结束回合」，云端的存档不会变——所以对方永远看不到你正在怎么摆兵。</li>
        <li>提交之前关页面、断网、换设备都不影响：草稿存在本机浏览器里，回来接着走。</li>
        <li>云端记着"第几回合、轮到谁"，所以对面一看就知道<b>你是不是已经走完了</b>。</li>
        <li>你回到这个页面、或者切回这个标签时，会主动问一次云端：轮到我了吗。</li>
        <li>两边同时提交会撞车：后提交的那次会被挡下来（提交时不覆盖别人的回合），提示你先同步。</li>
      </ul>
      <h3>席位</h3>
      <p>一局两个席位：<b>A 座叫红方，B 座叫蓝方</b>——不再用"我方/敌方"，因为联机里两边的屏幕都写着同样的名字，
        谁是谁得靠颜色分，而不是靠"哪个是敌方"这种只有站在自己角度才成立的称呼。
        打开邀请链接时优先回到你原来的席位（本机存着席位令牌），没有记录就坐空着的那个。
        两个席位都有人时自动转成<b>观战视角</b>（见第 17 节）：不占座、只看、全图。</p>
      <h3>边界</h3>
      <div class="callout">
        迷雾在联机里是<b>界面层面</b>的约定，不是加密：整局状态是存在云上的，服务端不参与规则计算。也就是说，会开控制台的人理论上能读到对方的位置。真要防作弊，得把视图过滤（<code>playerView</code>）挪到服务端去算——架构上已经准备好了，但目前没做。
      </div>
      <h3>存哪儿</h3>
      <p>房间表在云数据库 <code>warchess_rooms</code>：一行一局，<code>state</code> 是整局 JSON 快照，<code>turn</code> / <code>current</code> 冗余出来给轮询用，两个 <code>seat_*</code> 列存席位令牌。房间码就是通行证，谁拿到谁能进这一局。</p>
    </section>

    <section id="ops">
      <h2><span class="sec-num">19</span>认输 · 撤回 · 拆除 · 提示音</h2>

      <h3>认输</h3>
      <p>侧栏底部「认输」，点一下问一句，确认就直接判负、整局结束。</p>
      <ul>
        <li>为什么要这个按钮：这游戏的判定是"城全丢才输"，残局里两边都没了进攻能力、
          靠回合上限耗完，剩下的几十分钟谁也不享受。认输是给这种局面的一条出路。</li>
        <li>不可撤销，所以要确认一次。联机里认输同样会被提交上去。</li>
      </ul>

      <h3>撤回一步</h3>
      <p>侧栏「撤回一步」，回到上一步操作之前。范围是刻意收窄的：</p>
      <ul>
        <li>只在<b>这一回合还能改的时候</b>有效。联机局同样能撤：本方这一回合还没提交，撤的就是自己手上的草稿；
          一旦点了「提交」，历史就交出去了，收不回来（那等于改历史，两边会直接对不上）；</li>
        <li>只在本回合内有效（点过「结束回合」，这一回合的账就结了）；</li>
        <li>最多留 30 步；指挥官模式（走位归 AI）和 AI 托管时不给撤。</li>
      </ul>
      <p>存的是旧状态的<b>引用</b>而不是克隆：<code>applyAction</code> 内部本来就深拷贝过，旧对象不会再被改，留着引用是安全的，也省掉每步一次深拷贝。</p>

      <h3>拆除</h3>
      <p>选中自己的任意建筑或单位，面板底部有「拆除」，<b>完整无损</b>的回收造价的 ${Math.round(
        CONFIG.disbandRefund * 100,
      )}%。</p>
      <ul>
        <li><b>残血的一律不回收金币</b>。打剩的兵退回去还能换钱的话，撤退就成了一门理财；
          建筑同理，塌了半边的塔拆掉也不退。</li>
        <li>典型用途是"这堵墙把自家出兵位堵了""这条船搁在浅滩上没用了"。</li>
        <li>本来也不给全额退：全额退款等于"造个侦察兵看一眼、原地拆掉回本"，一条零成本开图路线。</li>
        <li>拆除不消耗回合——它是"收拾自己留下的残局"，不是一次行动。</li>
      </ul>

      <h3>页面打不开的时候</h3>
      <p>如果打开是一片空白，或者横幅提示"页面没能启动"，多半是本机那份存档读不动了
        （换过版本、换过扩展都可能）。这时在地址后面加一个参数重开就行：</p>
      <p><code>?fresh=1</code> —— 丢掉本机存档，直接开一局新的。
        旧存档不会被删掉，会另存成 <code>warchess:match:v1.broken</code>；
        页面上的横幅里也有一个「清空本机存档并重开」的按钮，效果一样。</p>

      <h3>回合提示音</h3>
      <p>侧栏「铃声」按钮循环切换音量：<b>静音 / 25% / 50% / 75% / 100%</b>，存在本机，点一下当场试听。</p>
      <ul>
        <li>响的时机是"行动方换人了"——对面点完「结束回合」，你这边屏幕上"叮"一声，人就能从桌边走回来。</li>
        <li>AI 对 AI 不响（会变成每秒一声），观战不响，分出胜负之后也不响。</li>
        <li>声音是 <b>WebAudio 现场合成的</b>（两个正弦音，660 → 880 Hz，间隔 0.14 秒），不带音频文件：
          一声提示音不值得为它多一个几 KB 的下载和一条加载失败的分支。</li>
      </ul>
    </section>

    <section id="god">
      <h2><span class="sec-num">20</span>上帝模式（沙盒）</h2>
      <p>
        不要钱、不看回合，随手往盘上摆兵摆城，然后让 AI 同时操控两边打给你看；
        想亲手试两下，也可以把一边（或者两边）拿回来自己走。
        开局时在「你的角色」里选<b>上帝模式</b>（它是纯单人：选了之后「对手」那一栏会收起来，
        两边都归你摆）。
      </p>
      <p>
        它和指挥官模式解决的不是同一件事：指挥官模式是<b>降低操作负担</b>，棋盘仍然是一盘正常对局；
        上帝模式是<b>想试一件事</b>——十个长弓手守不守得住一座桥、一辆坦克能不能捅穿一队枪兵、
        这个兵种到底值不值那个价。这类问题拿正常对局去验证，要先攒十分钟钱，打完还得重开。
      </p>

      <h3>怎么摆</h3>
      <ol>
        <li>右上那条横带选<b>摆给谁</b>（红方 / 蓝方）。</li>
        <li>侧栏「兵种货架」按时代分组，点一个兵种当笔刷，再点棋盘落子；
            <b>可以连着摆</b>，不用每摆一个再点一次。点同一个兵种是放下笔刷。</li>
        <li>「城市」笔刷会先把能放的 2×2 角点亮（橙格），点哪儿就从哪儿起一座城；
            城的时代在上面的小按钮里选，决定耐久和护甲。</li>
        <li>「橡皮」点单位擦单位、点空城擦城。城被擦掉之后那四格退回平原，
            不留废墟——沙盒里没有"瓦砾"这回事，留一片不能站人的地只会碍事。</li>
        <li>「查看」笔刷下点一格，会告诉你那儿站着谁、多少血，或者是什么地形。</li>
        <li>侧栏底部可以「撤走部队」，只清那一方的兵，城留着。</li>
      </ol>

      <h3>两个按钮</h3>
      <ul>
        <li><b>交给 AI · 一回合</b>：AI 操控两边<b>各走一个回合</b>（合起来就是完整的一回合），
          然后把棋盘还给你。看完不满意就接着摆，或者再点一次。</li>
        <li><b>接管 · 打到全灭</b>：一直打到<b>一方没有能打的部队</b>为止。
          中途随时可以按「停止」，停下的那一格就是当时的局面。</li>
        <li>如果只是想看"这两支部队对撞会怎样"，两边都交给 AI 最省事——
          自己走一边，结果里就掺进了你的水平，试数值这件事就不干净了。
          想自己试一手，用下面那一档。</li>
      </ul>

      <h3>自己下场走两步（操控档）</h3>
      <p>工具栏中段有一组<b>操控</b>，三档：</p>
      <ul>
        <li><b>只摆放</b>（默认）：点棋盘就是落子，两边都要按「交给 AI」才动。这是这个模式原来的样子。</li>
        <li><b>我打这一方</b>：你操控「摆给」那一方。点自己的兵选中，蓝格走过去、红格开火；
          <b>走完按「结束回合」</b>，对面交给 AI 走完它那一个回合，然后把棋盘交还给你。</li>
        <li><b>两边我都打</b>：两边都由你走，摆完自己演一遍，不劳烦 AI。</li>
      </ul>
      <p>
        只要手上<b>还捏着笔刷</b>（兵种、城市、橡皮、地形），点棋盘就仍然是摆放——
        "我想在这儿加一个人"永远比"我想走一步"急；摆完再点一次同一个兵种把笔刷放下，
        就能直接打。
      </p>

      <h3>手上这支兵</h3>
      <p>
        点中一支部队，侧栏<b>顶上会多出一块「手上这支兵」</b>：血量、攻击 / 护甲 / 射程、
        这一回合还能不能走、还能不能打，下面是它的<b>主动技能按钮</b>。
      </p>
      <ul>
        <li>能放的时候按钮是亮的，点一下就放——扔斧头、喷火、开盾，走的是和正常对局里同一套逻辑，
          战报里同样会记一笔。</li>
        <li>放不了的时候<b>按钮灰掉，并且在旁边写清为什么</b>：「冷却 2 回合」「不是这一方」「等它走完」。
          灰按钮不写原因，等于让人猜。</li>
        <li>这一块在沙盒里是必须的：侧栏平时整块是兵种货架，没有属性卡、也没有技能栏。
          以前在沙盒里选中一个英雄，除了能走能打，它的技能<b>没有任何入口</b>——
          单位能选中、技能表也算得出来，但界面上没有那个按钮。</li>
        <li>还在「只摆放」档时，这块照旧出来（好让你先看看它有什么技能），
          但按钮全灰、底下写一句「现在只是摆子，技能开不了」。</li>
        <li>技能<b>不占行动</b>：放完技能这支兵还能走、还能打，一个英雄每回合最多放一次。</li>
      </ul>
      <p>
        工具栏最右边那行也还留着<b>手上这支兵还剩什么</b>（血量、攻击、还能不能走、还能不能打），
        那是摆兵时不用移开视线看的版本；技能要按按钮，所以在侧栏里。
      </p>
      <p>
        AI 接管对面是<b>一步一交</b>，不是"托管"：它走完那一个回合就停住等你。
        顶栏那个托管开关是"这一方永久交给 AI"，在沙盒里会自己一路跑下去、跑到你摆不下子，
        所以这个模式一直不让用。
      </p>

      <h3>跑多快、AI 干了什么</h3>
      <ul>
        <li>工具栏上有<b>速度</b>三档：慢 / 快 / 极快。默认「快」——沙盒看的是几十回合的走势，
          用正常对局那个最慢档放一场歼灭战要等一分多钟。跑到一半也能改，下一回合就换档。</li>
        <li>侧栏那张<b>战报</b>记着 AI 每一步：谁给谁放了技能、谁的斧头扔出去了、
          不死鸟留下了蛋、蛋什么时候孵的。<b>两边都托管之后，这张卡是唯一能看到过程的地方</b>——
          棋盘上只剩结果。</li>
        <li>AI 在打的时候货架会收起来（那会儿也摆不了东西），把战报顶上来。</li>
      </ul>

      <h3>AI 会用英雄的技能，也会去孵蛋</h3>
      <p>
        英雄的主动技能和 AI 的其他选择一样是打分的，所以它<b>会</b>开：矮人王够得着就扔斧头
        （贴脸也扔——那一下不占本回合的攻击，是白送的）、九头蛇掉到六成血以下就再生、
        不死鸟身边四格有敌人就俯冲、至尊法师看对面弱点切属性、天使看到两个人受伤
        或者一个人伤得很重就降临。
      </p>
      <p>
        不死鸟倒下后留下的蛋，轮到主人时 AI 的第一件事就是把它孵出来（挑离敌人最远、
        又离家不太远的那一格）。所以在这个模式里，"一方打光了"的判断要连蛋一起算——
        否则凤凰一倒下，"打到全灭"就当场收工，复活永远等不到下一回合。
        如果停下来的结论是"某某还有一枚蛋没孵"，再点一次「打到全灭」，它会先孵出来接着打。
      </p>

      <h3>几条和正常对局不一样的规则</h3>
      <ul>
        <li><b>摆什么都不花钱</b>，也不占回合：金币不动，行动序号不动。</li>
        <li><b>两边都不会自己产兵</b>。沙盒里掐掉产线和升级——两座城一开产线，五回合之后
          场上就变成两支新军，你摆的那几个兵反而成了配角。场上这些就是全部家当。</li>
        <li><b>建筑不算"还有兵"</b>。军营、塔、磨坊既不会走也不会主动冲，
          所以盘上只剩建筑时，"打到全灭"就判定为打完了。反过来，<b>一枚等着孵的蛋算</b>——
          它是"这一方还没被清完"的证据，不是空地。</li>
        <li><b>不按城判负</b>。没有城只是"没有靶子"，不是"输了"——
          不然第一回合就会弹出"你赢了"，这个模式没法用。胜负只看还有没有能打的部队。</li>
        <li><b>固定全图、不能开雾</b>。不只是给你看：AI 找方向靠"敌方的城 + 视野里的敌军"，
          沙盒里常常一座城都不摆，雾一开两边就互相看不见，谁都不动——那样点了等于没反应。</li>
        <li><b>摆兵仍然认地形</b>：船只能下水，陆军站不进水和高山，同层的格子不能叠。
          沙盒可以不要钱，但不能要一个"船停在山上"的局面——之后每次寻路都要跟它较劲。</li>
      </ul>
      <p>
        这个模式的每一局都照常存档，刷新页面会接着摆。想回到正常对局就点顶栏「新对局」，
        在「你的角色」里选回「亲自指挥」。
      </p>
    </section>

`;

/**
 * 核心册末尾补一节机制词条。
 *
 * 为什么不并进第 13 章：那一章是"能力"，这一节是"能力之外的东西"——
 * 溅射比例、产出规则、装载、空中层、状态。读者查"盾墙是什么意思"和查
 * "溅射到底打不打友军"是两个问题，混在一张表里反而更难找。
 *
 * 也不放在第 3 章（地形）之后：正文从第 3 章往下就开始用这些词了，
 * 词条表只有放在最后才符合"先遇到、后查"的顺序；悬停让他在原地就能看到，
 * 只有想细读时才需要翻到这里。
 */
const CORE_BODY =
  CORE_BODY_MAIN +
  `    <section id="terms">
      <h2><span class="sec-num">21</span>机制词条</h2>
      <p>正文与兵种表里带<b>虚线下划线</b>的词，鼠标停上去会浮一句说明，点一下跳到这里。
        只收能力之外的机制；能力在第 13 章那张表里，每条都是一个可跳转的锚点。</p>
      ${termTable(takeTerms(), { abilities: false })}
    </section>

`;

/* ---------------------------------------------------------------------------
 * 第二册：小型扩展合订本。
 *
 * 「小型」的判定看扩展自己的 scale 字段（见 expansions.ts 的 Expansion）：
 * 没标 large 的都进这一册。新加一条纯规则扩展，不用改这里。
 * --------------------------------------------------------------------------- */

type Exp = (typeof EXPANSIONS)[number];

/** 有些扩展一句 summary 说不清，在这里补。key 是扩展 id */
const SMALL_NOTES: Record<string, string> = {
  bloodbath: `<p><b>「血战」默认开着。</b>不特别说明的话，新对局就是"血战 + 你另外勾选的那些"。
        它是给后半场踩刹车的：第 ${BLOOD_TURN} 回合起城市不再回血、升级恢复原价、全军移动与视野各 +1。
        实测（各 120 局、同种子配对）开与不开：古典未决率 5.8% → 0.8%、平均少打 19 回合；中世 17.5% → 10.0%、少打 15 回合；
        先后手胜率没有可分辨的变化。想体验老节奏就在面板里把它取消勾选。</p>`,
  blackout: `<p>原来那套雾只遮<b>单位</b>：地形、河流、敌城的位置永远是公开的，等于一张免费的地图。
        开「浓雾蔽野」之后这一层也没了：</p>
      <ul>
        <li>视野外的格子连地形都不画，只剩一片暗面；</li>
        <li>对方城市要侦察到（四格里有任意一格可见）才会出现在图上；</li>
        <li>顶栏的迷雾开关<b>锁定为开</b>，不能关——能一键关掉的话，这个扩展就只是个大号的显示选项。</li>
        <li><b>对面的钱袋也看不见了</b>：HUD 上对方金币只显示成一个「?」。这一条和"地形要侦察"是一回事——
          知道对面还剩多少钱，等于知道他还能不能再买一队兵，那是免费的战略情报。</li>
      </ul>`,
  'last-stand': `<p><b>凡是改伤害的扩展，都会写在单位详情的第一行。</b>「哀兵必胜」（丢过首城的一方全军伤害 ×1.1）
        会直接标在面板顶上——不写出来，玩家只会看到"我这一下打了 16"，永远不知道为什么不是 15。</p>`,
  'action-points': `<p>五种行动一张价目表。所有数字都在 <code>src/core/action-points.ts</code> 顶上那张表里
        （<code>AP_MAX</code> / <code>AP_COST</code> / <code>AP_CLASS_MOD</code>）——改价不用碰规则引擎，
        规则引擎也一行都不认识"行动点"这三个字。</p>
      <ul>
        <li><b>池子</b>：每个单位每回合 ${AP_MAX} E，轮到自己时回满（先扣掉上回合的透支）。</li>
        <li><b>移动 / 上下船</b> ${AP_COST.move}E：站位和开账时不一样就算走过。
          上下船在下船那一刻同样是"换了个位置"，所以记的是同一档。</li>
        <li><b>攻击</b> ${AP_COST.attack}E，多段攻击每段各算一次；E 买得起几次就只给几次。</li>
        <li><b>驻扎</b> ${AP_COST.hold}E（与机动同价）：这一回合什么都没干。
          就地架着换 +${AP_HOLD_ARMOR} 护甲，一直到下次轮到自己。</li>
        <li><b>技能</b> ${AP_COST.skill}E，一个英雄一回合最多一次（这一条引擎本来就管着）。</li>
      </ul>
      <p><b>减免</b>：骑兵与车机动 −5E、近战出手 −10E，两类可以叠加（斥候两样都占）。
        「近战」按"射程 1 的战斗单位"算，所以自动覆盖整张兵种表；「骑兵 / 车」写的是 id 名单，
        漏写的兵按标准价付——多花 5 点，不会白占便宜。</p>
      <p><b>这套规则唯一的边界</b>：引擎在第一次攻击时会把次数兜底成 1，技能也不看行动点，
        这两处扩展没有否决位。所以 E 见底时仍然打得出一击、放得出技能，代价是<b>透支</b>——
        超出的部分下回合先从池里扣（只滚一回合，不滚雪球）。移动和"还能打几下"是真拦住的：
        E 不够就走不动，够打一次就不给第二次。</p>`,
};

function smallSection(e: Exp, num: number): string {
  return `
    <section id="exp-${esc(e.id)}">
      <h2><span class="sec-num">${String(num).padStart(2, '0')}</span>${esc(e.name)}</h2>
      <p>${esc(e.summary)}</p>
${SMALL_NOTES[e.id] ? '      ' + SMALL_NOTES[e.id] : ''}
    </section>`;
}

const SMALL_EXPANSIONS = availableExpansions().filter((e) => e.scale !== 'large');

const SMALL_BODY = `
    <section id="small-intro">
      <h2><span class="sec-num">01</span>扩展怎么用</h2>
      <p>开局时在设置面板里勾选，效果叠加。规则以 <b>id</b> 的形式记进对局存档（不存代码），
        所以存档可以序列化、可以回放，换台机器打开结果也一致。</p>
      ${expansionTable()}
      <div class="callout">
        <b>可组合性的代价：</b>三个扩展一起开时，一场战斗的伤害要过三层修正，没人能心算平衡。建议每次只加一两个，单独验证手感之后再考虑叠加。
      </div>
      <p>带兵种的扩展（时代兵备、奇想系列）不在这本册子里——它们按系列合成两本合册，规则书入口会按你这局开了什么列出来。</p>
    </section>
    ${SMALL_EXPANSIONS.map((e, i) => smallSection(e, i + 2)).join('')}
`;

/* ---------------------------------------------------------------------------
 * 第三册起：大型扩展各一本。
 *
 * 「大型」= 扩展自己标了 scale: 'large'。时代兵备包、奇想系列都在这里；
 * 以后新加一个大包，在它的定义里写一行 scale，书就自动有了。
 * --------------------------------------------------------------------------- */

/**
 * 奇想系列共用的那套新规则。
 *
 * 原来这段在**每一本**奇想分册里各印一遍——五个包，五份同样的四十行。
 * 合并成一册之后它只出现一次，而且每条的细节都搬进了词条（悬停可见），
 * 正文只留"为什么这么设计"：那是查不到、也不该从数值里推出来的部分。
 */
function fantasyRules(): string {
  return `
      <h3>奇想系列带来的新规则</h3>
      <p><b>奇想·法则</b>只带机制、一个兵都不带，另外四包都<b>依赖</b>它。
        只勾子包不勾前置，子包根本不会进场（配置里那条记录也会被剔掉，不留一句谎话）。</p>
      <ul>
        <li>${ref('magic')}与${ref('mres')}是这套系的骨架：法师打重甲划算、打在魔抗单位身上像挠痒。
          数值都压在 20 以内——它是"另一条路"，不是"更大的数字"。</li>
        <li>${ref('elem')}决定这一下带什么，${ref('weak')}与${ref('resist')}决定目标怎么接。
          注意「怕」作用在<b>整段</b>伤害上：怕火的被火把砸一下也疼，不只是怕魔法火。</li>
        <li>${ref('air')}：飞行、掠空、跳跃是同一套机制，区别只在名字对不对得上画面——
          鹰和石像鬼飞行，蜘蛛骑士是跳跃，谁都不该"扑棱翅膀"。${ref('overhead')}</li>
        <li>${ref('status')}——中毒、点燃、减速、诅咒。都按血量百分比算，
          这样一支巨魔中同样的毒，掉的血和它的体型相称。</li>
        <li>${ref('mastery')}：属性不只是"这一下带什么状态"，而是四种形态。所以「转属性」
          其实是在"控场"和"爆发"之间选，而不是在四种颜色里挑好看的那个。</li>
        <li>${ref('skill')}。矮人王的投斧更进一步：那一斧<b>不占本回合的攻击次数</b>，
          扔完还能贴身再劈一刀——三格外的目标也照打，代价是只有六成伤害。</li>
      </ul>
      <div class="callout">
        机制都写成"有前提、有解法"的形式：飞行怕射程、魔法怕魔抗、狂暴怕风筝、召唤怕清场。
        纯加成的兵最后只会变成"贵一点的那个步兵"——这条在写这个包的时候被反复验证过。
      </div>`;
}

/** 大包各自的补充说明：这包和别的包玩法上差在哪儿。key 是扩展 id */
const PACK_NOTES: Record<string, string> = {
  'fantasy-core': `<p>这本册子讲的是<b>机制</b>：它自己不带兵，是另外四包的前置。下面的"新规则"
        在你开任何一个奇想子包时都会生效。</p>`,
  'fantasy-heroes': `<p>英雄是<b>全场唯一</b>的：同一方在盘上只能有一个同名英雄。第一次招募要在造价之外
        另付一笔解锁费，付过之后这一局里随便造。每人每回合一个主动技能，<b>不占行动</b>——
        开完技能还能照常移动和攻击。AI 也会用：够得着就扔斧头、掉血就再生、
        身边有人伤得重就降临；不死鸟倒下后留下的蛋，轮到它时 AI 会自己挑地方孵。</p>`,
  'fantasy-arcane': `<p>召唤物（骷髅、僵尸犬、土元素这类）和土墙<b>不占编制</b>：它们不算进
        "最多多少个单位"那道门槛，所以不会把你自己的产线堵死。召唤师被杀，已经召出来的还在场上。</p>`,
  'city-works': `<p>这个包动的是<b>骨架</b>，六条要记住：</p>
        <ul class="bullets">
          <li><b>主城 3×3</b>：城市占九格，耐久 +50%。城墙更厚，攻城就成了苦差事。</li>
          <li><b>两种新资源</b>：活人（战斗、经济、建造单位）的造价里有七成是<b>粮食</b>，
              机械与建筑的造价里有七成是<b>建材</b>；金币只占三成。
              <b>粮和材才是主要成本，金币是零头</b>——所以缺钱通常不是问题，
              缺粮缺材才是。开局就把经济铺开，别把钱攒成一座金山。
              开局按时代给一笔起步粮材，之后就要靠经济单位挣。</li>
          <li><b>一种兵，多种产出</b>：经济单位看脚下——平地打粮、森林丘陵出建材，
              另一部分换回少量金币。</li>
          <li><b>经济建筑只做经济</b>：攻击归零、收益 +20%，而造价只有同类单位的
              <b>两成金币 + 五成半资源</b>（时代 1-2 连金币都不要），四五个回合就能回本；
              代价是耐久只加一成、护甲还少一点——它是个好投资，<b>不是一堵墙</b>。
              它们产什么就吃什么呢：粮仓花粮、采石场花材。</li>
          <li><b>建材产线一路排到现代</b>：伐木工（2）→ 采石工（3）→ 矿队（4）→ 建材公司（5），
              配套采石场（2）→ 砖窑（3）→ 水泥厂（4）→ 建材基地（5）。
              建筑<b>不挑地形</b>，产出 13 → 24 → 40 → 58 材/回合；
              想要更多建材，要么换人，要么换建筑，不必抢那块丘陵。</li>
          <li><b>塔要施工</b>：箭塔/石堡/炮台/要塞/碉堡先落一个<b>工地</b>（两回合），
              工地开不了火、产不了兵，但看得见也拆得掉；成型后视野 +2，并<b>允许驻军</b>——
              友军站上去多 3 点护甲、还能借用它的视野。相应地，塔自己的攻击被削了三成。</li>
        </ul>
        <p>时代 3 起的经济与工程兵种（工程师、厂长、建筑队，以及采石工、矿队、建材公司这类采集兵）
          攻击 +3、生命 +6，现代那一档再 +1 护甲——它们不该一上前线就是送人头。</p>
        <p class="era-meta">上面总表印的是兵种表里的<b>原始数值</b>。这个包在开局时会再叠一层：
          经济建筑护甲 −1、耐久 ×1.1；时代 3 起的经济与工程兵 +3 攻 +6 血（现代再 +1 甲）。
          所以游戏里看到的攻击和生命会比表里高一点，经济建筑的护甲低一点。</p>`,
};

/** 包名去掉系列前缀：表格里"来源"那一列要塞五个字就会把数值列挤扁 */
function shortPackName(p: Exp): string {
  return p.name.replace(/^奇想·/, '');
}

/**
 * 合册的兵种总表。
 *
 * 一张表，不按包拆成五张。读者要回答的问题是"同一个时代、差不多的价钱，
 * 这五个包里哪个更划算"——那需要能上下扫。拆成五张之后每张都要重新建立
 * 一次坐标系，还得记住上一张的头。
 *
 * 包与包之间用一条分组行隔开：边界还在，视线不用跳。
 * 每行带 `data-unit`，落盘前有一道覆盖自检靠它点数——合并最怕的是漏掉几个兵，
 * 而漏掉的那几个恰恰不会自己喊。
 *
 * `magic` 一档多出魔攻 / 魔抗 / 属性三列。时代兵备包没有魔法字段，
 * 硬塞三列会让四十多行全是"—"，那是纯粹的噪声。
 */
function mergedTable(
  packs: readonly Exp[],
  kind: 'fantasy' | 'era',
  withSource = true,
): string {
  const magic = kind === 'fantasy';
  const cols = magic
    ? ['名称', '图标', '来源', '时代', '造价', '攻', '魔攻', '甲', '魔抗', '血', '移', '射', '视', '属性', '特性']
    : ['名称', '图标', '来源', '时代', '造价', '攻', '甲', '血', '移', '射', '视', '特性'];
  // 单册只有一个包时"来源"恒等于包名，多这一列只是把数值挤窄
  const useCols = withSource ? cols : cols.filter((c) => c !== '来源');

  const rows: string[] = [];
  for (const p of packs) {
    const units = [...(p.units ?? [])].sort(
      (a, b) => a.era - b.era || a.cost - b.cost || a.name.localeCompare(b.name, 'zh-CN'),
    );
    if (units.length === 0) continue;
    rows.push(
      `<tr class="grp" id="p-${esc(p.id)}"><td colspan="${useCols.length}">${esc(p.name)} · ${units.length} 个</td></tr>`,
    );
    for (const u of units) {
      const cells = [
        `<td class="name">${esc(u.name)}</td>`,
        `<td class="glyph">${esc(u.short)}</td>`,
        ...(withSource ? [`<td class="src">${esc(shortPackName(p))}</td>`] : []),
        `<td class="num">${u.era}</td>`,
        `<td class="num">${u.cost}</td>`,
        `<td class="num">${u.atk}${u.burst ? `×${u.burst}` : ''}</td>`,
      ];
      if (magic) {
        cells.push(`<td class="num">${u.magicAtk ?? '—'}</td>`);
        cells.push(`<td class="num">${u.armor}</td>`);
        cells.push(`<td class="num">${u.magicRes ?? 0}</td>`);
      } else {
        cells.push(`<td class="num">${u.armor}</td>`);
      }
      cells.push(`<td class="num">${u.maxHp}</td>`);
      cells.push(`<td class="num">${u.move === 0 ? '—' : u.move}</td>`);
      cells.push(`<td class="num">${u.range}</td>`);
      cells.push(`<td class="num">${u.vision}</td>`);
      if (magic) cells.push(`<td class="traits">${elementCell(u)}</td>`);
      cells.push(`<td class="traits">${magic ? fantasyTraits(u) : traitsOf(u)}</td>`);
      rows.push(`<tr data-unit="${esc(u.id)}">${cells.join('')}</tr>`);
    }
  }
  if (rows.length === 0) return '<p class="era-meta">这一册不带兵种，只改规则。</p>';

  return `
    <div class="scroll-x">
      <table class="wide">
        <thead><tr>${useCols.map((c) => `<th>${c}</th>`).join('')}</tr></thead>
        <tbody>${rows.join('')}</tbody>
      </table>
    </div>`;
}

/**
 * 把一串时代压成一行能看的短写法。
 *
 * "2 · 3 · 4 · 5" 在窄列里会被折成两行——不是信息多，是写法笨。
 * 连续区间写 `2–4`，跳档的另起一段 `2、5`。
 */
function eraRange(eras: readonly number[]): string {
  const s = [...eras].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < s.length; ) {
    let j = i;
    while (j + 1 < s.length && s[j + 1] === (s[j] ?? 0) + 1) j += 1;
    parts.push(i === j ? String(s[i]) : `${s[i]}–${s[j]}`);
    i = j + 1;
  }
  return parts.join('、');
}

/** 合册开头那张"里面有什么"：五个包各自解决什么问题，一屏看完 */
function packsOverview(packs: readonly Exp[]): string {
  return `
    <table class="overview">
      <thead><tr><th>包</th><th>兵种</th><th>时代</th><th>前置</th><th>它解决什么</th></tr></thead>
      <tbody>
        ${packs
          .map((p) => {
            const us = p.units ?? [];
            const eras = [...new Set(us.map((u) => u.era))].sort((a, b) => a - b);
            // 前置只写简称（"法则"而不是"奇想·法则"）：这一列本来就只有一指宽
            const req = (p.requires ?? [])
              .map((id) => {
                const r = EXPANSIONS.find((x) => x.id === id);
                return r ? shortPackName(r) : id;
              })
              .join('、');
            return `<tr><td class="name">${esc(p.name)}</td><td class="num">${
              us.length || '—'
            }</td><td class="num">${eras.length ? eraRange(eras) : '—'}</td><td class="nowrap">${
              req ? esc(req) : '—'
            }</td><td>${esc(p.summary)}</td></tr>`;
          })
          .join('')}
      </tbody>
    </table>`;
}

/** 单个大包一本（城市工坊、季节这类不归组的） */
function packBook(e: Exp): Book {
  resetTerms();
  const units = e.units ?? [];
  const eras = [...new Set(units.map((u) => u.era))].sort((a, b) => a - b);
  const reqNames = (e.requires ?? [])
    .map((id) => EXPANSIONS.find((x) => x.id === id)?.name ?? id)
    .join('、');

  const nav = `
    <a href="#pack-intro">1. 这个包是什么</a>
    <a href="#pack-units">2. 兵种表</a>
    <a href="#pack-terms">3. 机制词条</a>
  `;

  const body = `
    <section id="pack-intro">
      <h2><span class="sec-num">01</span>这个包是什么</h2>
      <p>${esc(e.summary)}</p>
      <dl class="kv">
        <dt>兵种数量</dt><dd>${units.length} 个</dd>
        <dt>覆盖时代</dt><dd>${eras.length ? eras.map((n) => `${n}（${esc(ERAS[n - 1]?.name ?? '')}）`).join('、') : '—（不带兵种）'}</dd>
        ${reqNames ? `<dt>前置</dt><dd>需要先开「${esc(reqNames)}」</dd>` : ''}
        <dt>怎么启用</dt><dd>新对局面板里勾选；规则以 id 记进存档，换机器打开不变</dd>
      </dl>
      <p>这个包的兵在<b>生产面板里带徽标</b>（名字旁的小圆标写着它来自哪个包），
        搜索框里敲包名也能过滤。产兵照旧卡时代：<code>兵种时代 &lt; 城市时代 − 1</code> 的不出列，
        和原版兵是同一把尺子。</p>
      ${PACK_NOTES[e.id] ?? ''}
    </section>

    <section id="pack-units">
      <h2><span class="sec-num">02</span>兵种表</h2>
      ${units.length ? mergedTable([e], 'era', false) : '<p class="era-meta">这个包不带兵种，只改规则——表就不用列了。</p>'}
    </section>

    <section id="pack-terms">
      <h2><span class="sec-num">03</span>机制词条</h2>
      <p>表里带虚线下划线的词，鼠标停上去会浮一句说明；点一下停在这里。</p>
      ${termTable(takeTerms())}
    </section>
  `;

  return {
    file: `public/manual-pack-${e.id}.html`,
    title: `方格战棋 · ${e.name}`,
    subtitle: `扩展分册 · ${units.length ? `${units.length} 个兵种` : '只改规则'} · 本文件由 npm run manual 从配置自动生成`,
    nav,
    body,
  };
}

/* ---------------------------------------------------------------------------
 * 合册：把"同一套玩法的几个包"并成一本。
 *
 * 拆册的初衷是"没开的包别占版面"，但拆过头会走向反面：五个奇想包各成一本，
 * 同一段"魔法怎么算"要印五遍，玩家想在骑士和荒兽之间挑一个兵，
 * 得开五个标签页对着看。所以现在按**玩法系列**归册，而不是按包：
 *
 *   · 奇幻系列（法则 + 骑士团 + 荒兽 + 秘法 + 英雄）→ 一本
 *   · 时代兵备（古典 + 中世 + 火药 + 工业 + 二战 + 现代） → 一本
 *   · 其余大包（城郭与物料、季节与气候）               → 各自一本
 *
 * 判据仍是扩展自己的 id 前缀，写在下面这张表里——加一个新包不用改书单逻辑。
 * ------------------------------------------------------------------------- */

interface BookGroup {
  file: string;
  title: string;
  subtitle: string;
  /** 归属判据：扩展 id 以它开头，并且 scale 是 large */
  prefix: string;
  kind: 'fantasy' | 'era';
  /** 开篇导读：这一册为什么这样编 */
  intro: string;
}

const BOOK_GROUPS: BookGroup[] = [
  {
    file: 'public/manual-pack-fantasy.html',
    title: '方格战棋 · 奇幻扩展',
    subtitle:
      '奇想五包的合册 · 本文件由 npm run manual 从配置自动生成，数值与代码一致。行内虚线词可悬停看说明。',
    prefix: 'fantasy-',
    kind: 'fantasy',
    intro: `<p>这一册收了<b>五个包</b>，但它们不是五选一，而是"一套底座 + 四队兵"：
        「奇想·法则」只带机制（魔法、属性、状态、空中层），一个兵都不带；
        另外四包各补一队兵，全部<b>依赖</b>它。所以想玩奇幻，最少要勾两个包——
        只勾兵种包，配置里那条记录会被剔掉，什么都不发生。</p>
      <p>四队兵的分工不是"越来越强"，而是四种打法：骑士团是<b>阵型与冲锋</b>，
        荒兽是<b>机动与毒</b>，秘法是<b>远程与召唤</b>，英雄是<b>单体质量</b>。
        它们可以同时开，但那是给"我想看大乱斗"的人准备的——四个包一起开，
        一场战斗要过四层修正，没人能心算平衡。</p>`,
  },
  {
    file: 'public/manual-pack-eras.html',
    title: '方格战棋 · 时代兵备',
    subtitle:
      '七个包的兵种扩充合册 · 本文件由 npm run manual 从配置自动生成，数值与代码一致。行内虚线词可悬停看说明。',
    prefix: 'pack-',
    kind: 'era',
    intro: `<p>这一册收了<b>七个包</b>。前五个是"一个时代一队兵"：古典、中世、火药、工业、二战，
        各补 12~17 个兵；第六时代在基础规则里是空的，所以它按原版的样子拆成<b>底座 + 加料</b>两包——
        「现代」带这一代最基本的九个兵（步兵班、坦克、榴弹炮、装甲侦察车、物流中心、工程兵、
        混凝土碉堡、产业园、联合作战中心），顺便把科技线开到第六级；
        「现代战争」在它之上再加十五个专精兵。除「现代战争」依赖「现代」之外，其余各包互不依赖，
        可以全勾，也可以只勾你现在这个时代那一本——勾了以后生产面板里会多出这批兵，原版兵一个不少。</p>
      <p>这些包放在一册，是为了回答一个原来查不了的问题：<b>同一档价钱，这几个时代各给了什么解法</b>。
        总表按时代排序，一眼能看出"古典用方阵顶、工业用射程压、二战用装甲推、现代用射程差清"这条路子。</p>
      <p>为什么第六代要两个包：原版每一代都是"<b>基础规则给几个最基本的兵，时代兵种包再加一队专精兵</b>"
        （原版二战那七个 + 「二战合成兵」那十四个）。第六代在基础规则里是空的，照同样的形状补出来，
        玩家就不用记两套规矩：只勾「现代」，它是一个能自己打完一整局的完整代际；再勾「现代战争」，
        这一代才多出直升机、无人机、反坦克导弹、防空导弹这些"专精解法"。
        「现代战争」写了 <code>requires: ['pack-contemporary']</code>——单独勾它不会生效，
        开局面板会把「现代」一起补上（一个"勾了却造不出来"的兵种包，在玩家眼里就是坏了）。</p>`,
  },
];

/** 这一册该收哪些包 */
function groupMembers(g: BookGroup): Exp[] {
  return EXPANSIONS.filter((e) => e.scale === 'large' && e.id.startsWith(g.prefix));
}

function groupBook(g: BookGroup, packs: readonly Exp[]): Book {
  resetTerms();
  const total = packs.reduce((n, p) => n + (p.units?.length ?? 0), 0);
  const eras = [...new Set(packs.flatMap((p) => (p.units ?? []).map((u) => u.era)))].sort(
    (a, b) => a - b,
  );
  const withUnits = packs.filter((p) => (p.units ?? []).length > 0);
  /**
   * 各包要点。写成函数而不是先算好：这段里将来可能引用机制词条（现在还没有），
   * 一旦引用了，它必须在"表格已经渲染完"之后求值——模板里的插值顺序就是求值顺序，
   * 提前拿出来算会漏掉这几个键。
   */
  const notesHtml = (): string =>
    withUnits
      .filter((p) => PACK_NOTES[p.id])
      .map((p) => `<h3 id="n-${esc(p.id)}">${esc(p.name)}</h3>${PACK_NOTES[p.id]}`)
      .join('');

  const nav = `
    <a href="#g-intro">1. 这一册怎么读</a>
    <a href="#g-units">2. 兵种总表</a>
    ${packs
      .filter((p) => (p.units ?? []).length > 0)
      .map((p) => `<a class="sub" href="#p-${esc(p.id)}">${esc(shortPackName(p))}</a>`)
      .join('\n    ')}
    <a href="#g-notes">3. 各包要点</a>${g.kind === 'fantasy' ? '\n    <a href="#g-rules">4. 新规则</a>' : ''}
    <a href="#g-terms">${g.kind === 'fantasy' ? '5' : '4'}. 机制词条</a>
  `;

  const body = `
    <section id="g-intro">
      <h2><span class="sec-num">01</span>这一册怎么读</h2>
      ${g.intro}
      ${packsOverview(packs)}
      <dl class="kv">
        <dt>兵种总数</dt><dd>${total} 个（${withUnits.length} 个包），覆盖时代 ${eras.join('、')}</dd>
        <dt>怎么启用</dt><dd>新对局面板里勾选，效果叠加；规则以 id 记进存档，换机器打开不变</dd>
        <dt>兵种在哪</dt><dd>生产面板里带包徽标（名字旁的小圆标写着它来自哪个包），搜索框敲包名能过滤；
          产兵照旧卡时代：<code>兵种时代 &lt; 城市时代 − 1</code> 的不出列，和原版兵同一把尺子</dd>
        <dt>怎么查</dt><dd>总表里带<b>虚线下划线</b>的词都能悬停看一句说明，点一下跳到本册末尾的词条</dd>
      </dl>
    </section>

    <section id="g-units">
      <h2><span class="sec-num">02</span>兵种总表</h2>
      <p>按包分段（灰色的那一行），段内按时代、造价排序。同段之内价钱越往下越贵；
        跨段比较时请对照"来源"那一列。</p>
      ${mergedTable(packs, g.kind)}
    </section>

    <section id="g-notes">
      <h2><span class="sec-num">03</span>各包要点</h2>
      <p>表格给的是数值，这一节给的是"这一包和别的包差在玩法上"。</p>
      ${notesHtml() || '<p class="era-meta">这几个包没有额外的玩法说明，看总表即可。</p>'}
    </section>
    ${
      g.kind === 'fantasy'
        ? `<section id="g-rules">
      <h2><span class="sec-num">04</span>新规则</h2>
      ${fantasyRules()}
    </section>`
        : ''
    }

    <section id="g-terms">
      <h2><span class="sec-num">${g.kind === 'fantasy' ? '05' : '04'}</span>机制词条</h2>
      <p>只收<b>这一册兵种真的用到</b>的那几条。想查全部能力，见核心规则书第 13 章。</p>
      ${termTable(takeTerms())}
    </section>
  `;

  return { file: g.file, title: g.title, subtitle: g.subtitle, nav, body };
}

/* ---------------------------------------------------------------------------
 * 落盘。
 * --------------------------------------------------------------------------- */

const largeExps = EXPANSIONS.filter((e) => e.scale === 'large');

/**
 * 书单：核心 + 小型合订本 + 按系列合册 + 剩下的单个大包。
 *
 * 顺序是刻意的：读者最常翻的排前面，越靠后越"这一局才相关"。
 */
const grouped = new Set<string>();
const groupBooks: Book[] = [];
for (const g of BOOK_GROUPS) {
  const members = groupMembers(g);
  // 一个成员都没有就不出空册——以后删包或改名时不会留下一本只有封面的书
  if (members.length === 0) continue;
  for (const m of members) grouped.add(m.id);
  groupBooks.push(groupBook(g, members));
}

const books: Book[] = [
  {
    file: 'public/manual.html',
    title: '方格战棋 · 规则书',
    subtitle: '回合制 · 1v1 · 五个时代 · 本文件由 npm run manual 从配置自动生成，数值与代码一致。扩展的规则在各自分册里。',
    nav: CORE_NAV,
    body: CORE_BODY,
  },
  {
    file: 'public/manual-small.html',
    title: '方格战棋 · 扩展规则（小型）',
    subtitle: '只改规则、不带兵种的那批扩展，合成一册。本文件由 npm run manual 从配置自动生成。',
    nav: `
    <a href="#small-intro">1. 扩展怎么用</a>
    ${SMALL_EXPANSIONS.map((e, i) => `<a href="#exp-${esc(e.id)}">${i + 2}. ${esc(e.name)}</a>`).join('\n    ')}
  `,
    body: SMALL_BODY,
  },
  ...groupBooks,
  ...largeExps.filter((e) => !grouped.has(e.id)).map(packBook),
];

mkdirSync('public', { recursive: true });

// 先渲染再写：page() 只拼字符串，渲染一次就够，后面覆盖自检直接用这份结果
const rendered = books.map((b) => ({ b, html: page(b) }));
for (const { b, html } of rendered) {
  writeFileSync(b.file, html, 'utf-8');
  const kb = Math.round(html.length / 1024);
  console.log(`  ${b.file.replace('public/', '')} ← ${b.title.replace('方格战棋 · ', '')}（${kb}KB）`);
}

/* ---------------------------------------------------------------------------
 * 清掉上一版留下的分册。
 *
 * 合并之后 manual-pack-fantasy-core.html 这类文件不会再生成，但 public/ 里
 * 还躺着——它们会跟着 build 一起进 dist，玩家按旧书签打开还能看到一份
 * "少了四个包"的过时规则书，比 404 更糟：他不知道自己看的是旧版。
 *
 * 只删 manual-pack-*.html 且不在本次书单里的，别的文件一概不碰。
 * --------------------------------------------------------------------------- */
const keep = new Set(books.map((b) => b.file.replace('public/', '')));
for (const f of readdirSync('public')) {
  if (!/^manual-pack-.+\.html$/.test(f) || keep.has(f)) continue;
  unlinkSync(join('public', f));
  console.log(`  - 删除过期分册 ${f}`);
}

/* ---------------------------------------------------------------------------
 * 覆盖自检：合并最容易犯的错是"漏了几个兵"，而漏掉的那几个不会自己喊。
 *
 * 每一行兵种都带 data-unit="<兵种 id>"，这里把所有册子的 id 收一遍，
 * 和配置里的扩展兵种对照。少一个就当场抛错——宁可让 npm run manual 失败，
 * 也不留一本"看起来齐全"的规则书。
 * --------------------------------------------------------------------------- */
const seenUnits = new Set<string>();
for (const { html } of rendered) {
  for (const m of html.matchAll(/data-unit="([^"]+)"/g)) seenUnits.add(m[1] ?? '');
}
const missing = largeExps.flatMap((e) =>
  (e.units ?? []).filter((u) => !seenUnits.has(u.id)).map((u) => `${e.name} · ${u.name}（${u.id}）`),
);
if (missing.length > 0) {
  throw new Error(`有 ${missing.length} 个扩展兵种没有进任何一册：\n  ${missing.join('\n  ')}`);
}

/* ---------------------------------------------------------------------------
 * 链接自检：每个 chip 都要有落点。
 *
 * 词条是"正文里指一下、表里查得到"，中间任何一环断了，读者点下去就是原地不动，
 * 悬停更是一句话都不弹——比没有链接更让人恼火（他以为自己在看规则，
 * 其实点下去没反应）。落点只认两种形态：词条表的 `<dt id="t-x">下一格 <dd>`，
 * 能力总表的 `<tr id="t-ab-x">` 第二格；两种都由生成器固定产出，所以这里只查 id 在不在。
 * --------------------------------------------------------------------------- */
for (const { b, html } of rendered) {
  const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1] ?? ''));
  const dead = [...new Set([...html.matchAll(/href="#(t-[^"]+)"/g)].map((m) => m[1] ?? ''))].filter(
    (k) => !ids.has(k),
  );
  if (dead.length > 0) {
    throw new Error(`${b.file} 有 ${dead.length} 个指向不存在词条的链接：${dead.join('、')}`);
  }
}

// 根目录留一份核心册，方便不开 dev server 直接看（不入库，见 CI 的仓库卫生检查）
writeFileSync('manual.html', rendered[0]!.html, 'utf-8');
console.log(
  `共 ${books.length} 册（原 ${1 + 1 + largeExps.length} 册）· 兵种 ${Object.keys(UNIT_TYPES).length} 个 · ` +
    `扩展兵种 ${largeExps.reduce((n, e) => n + (e.units?.length ?? 0), 0)} 个已全部入册 · ` +
    `能力 ${allAbilities().length} 条 · 扩展 ${EXPANSIONS.length} 个`,
);
