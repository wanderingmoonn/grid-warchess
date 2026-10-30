/**
 * 单位与地形的"说明书"。
 *
 * 规则都写在数据里，但玩家看不出"农民站哪赚钱""丘陵到底加多少防"。
 * 这里把这些隐含规则翻成人话，点一下就弹出来。
 */

// 能力表是"核心 + 各扩展贡献"合并出来的，所以从这里查，而不是某个文件里的一张表。
import { abilityById, abilityNames } from './ability-registry.ts';
import { CONFIG, UNIT_TYPES, buildCostOf, buildPowerOf, eraDef } from './config.ts';
import { LAST_STAND_BONUS, activeExpansions, unitSourceOf } from './expansions.ts';
import { heightOfTerrain, splashRadiusOf, splashRatioOf } from './rules.ts';
import { resourceShort } from './resources.ts';
import { climateEffect, type Climate } from './climate.ts';
import { ELEMENT_NAME } from './types.ts';
import type { Element, GameState, PlayerId, Terrain, Unit, UnitTypeDef } from './types.ts';

export interface TerrainInfo {
  name: string;
  /** 进入消耗 */
  cost: string;
  /** 防御加成 */
  defense: string;
  /** 一句话说明它为什么重要 */
  note: string;
}

export const TERRAIN_INFO: Record<Terrain, TerrainInfo> = {
  plain: {
    name: '平原',
    cost: '1 移动力',
    defense: '无加成',
    note: '农民在这里收入最高（+7）。地形开阔，没有掩护，也不挡视线。',
  },
  forest: {
    name: '森林',
    cost: '2 移动力',
    defense: '护甲 +2',
    note: '伐木工在这里收入最高（+12）。守方多 2 点护甲，配合「堑壕战」扩展会更硬。',
  },
  hill: {
    name: '丘陵',
    cost: '2 移动力',
    defense: '护甲 +3',
    note: '牧民在这里收入最高（+8）。全地图最好的防守地形。',
  },
  water: {
    name: '水域',
    cost: '不可通行',
    defense: '—',
    note: `任何单位都进不去。相邻的经济单位或经济建筑会额外产出 ${CONFIG.riverTradeBonus} 金。`,
  },
  deep: {
    name: '深水',
    cost: '船 1 移动力 / 陆军不可通行',
    defense: '无加成',
    note: '离岸两格以上的外海。只有船进得去，陆军连涉水都没这条口子；桥也架不了（桥墩下不去这么深）。',
  },
  bridge: {
    name: '桥',
    cost: '1 移动力',
    defense: '无加成',
    note: '架在水面上的建筑，友军可以从上面走过（不能停留），敌军过不来。有耐久，打掉即变回水面。',
  },
  mountain: {
    name: '高山',
    cost: '不可通行',
    defense: '—',
    note: '连成脉的天险，任何单位都翻不过去，只能绕。地图上的战略缝隙基本都由它和河流决定。',
  },
  city: {
    name: '城市',
    cost: '1 移动力',
    defense: '护甲 +3',
    note: '可产兵、可升级时代。耐久打空才会易主，攻陷时城内守军一起损失。',
  },
  plateau: {
    name: '台地',
    cost: '2 移动力（爬坡另计）',
    defense: '护甲 +3',
    note: '比平原高 2 层、比丘陵高 1 层。站在台地边缘射程 +1，往下打远处的敌人还能再 +1；从下面仰攻它，射程 -1。',
  },
  valley: {
    name: '谷地',
    cost: '1 移动力',
    defense: '护甲 +2',
    note: '比平原低 1 层。射程 -1（视线被两边的坡切掉），但往里走不吃爬坡费——从谷地冲上高地的那一步才贵。',
  },
  marsh: {
    name: '沼泽',
    cost: '2 移动力（走出去 +1）',
    defense: '无加成',
    note: '与平原同高，但烂泥拖脚：进去 2 点，**从沼泽里走出去还要再多 1 点**——进来容易出去难。芦苇高过人头，视野 -1，也没有任何掩护。',
  },
  dune: {
    name: '沙丘',
    cost: '2 移动力',
    defense: '护甲 +1',
    note: '比平原高 1 层。沙脊上射程 +1、视野 +1（看得远、也看得清），但几乎没有掩护——沙地上站谁谁明显。',
  },
  shallow: {
    name: '浅流',
    cost: '2 移动力（陆军可涉水）',
    defense: '护甲 -1',
    note: '水深刚过脚踝的漫水滩，也是全图唯一两边都能走的水：陆军涉水过去，水军也能贴着浅滩滑过去——绕海不如直接穿过一串浅滩。站在水里没处躲，挨打时比平地还吃亏；踩水走一格算两格。',
  },
  lava: {
    name: '熔岩',
    cost: '3 移动力',
    defense: '无加成',
    note: '火山脚下缓慢流动的岩浆。能走，但一步顶三步，而且回合结束时还停在上面会被烧 5 点（真伤，无视护甲）。想抄近路得先算清这支兵值不值。',
  },
  volcano: {
    name: '火山',
    cost: '不可通行',
    defense: '—',
    note: '全图最高的一类地形（6 层）。任何单位都上不去，山脚那一圈是缓慢外流的熔岩。',
  },
};

/**
 * 一个单位的特殊之处，翻成人话。
 * 返回空数组表示它就是个普通单位。
 */
export function describeUnit(
  s: GameState,
  def: UnitTypeDef,
  owner?: PlayerId,
  unit?: Unit,
): string[] {
  const lines: string[] = [];

  // 哀兵必胜：这条加成写在伤害结算里，面板上不写就等于没有——
  // 玩家只看到"我打它 13 点"，永远不知道为什么是 14。
  if (owner && s.firstCityLost === owner) {
    lines.push(
      `哀兵必胜：本方丢过首城，全军伤害 ×${(1 + LAST_STAND_BONUS).toFixed(2)}（+${Math.round(
        LAST_STAND_BONUS * 100,
      )}%，野战、反击、攻城都算）`,
    );
  }

  if (def.domain === 'water') {
    lines.push('只在水上行动：上不了岸，只能在临水的城市下水。能打岸上的目标，也会被岸上打。');
  }
  // ── 移动层与飞行（原版机制，不是某个兵种包的特权） ────────────────────
  if (def.layer === 'air') {
    lines.push(
      '掠空：它在**天上那一层**，和地面单位互不占格——可以停在敌人头顶，敌人也能从它脚下走过。',
    );
    lines.push('天上打地上不算同格；地上打天上距离 +1（要先"够得着头顶"），所以射程 1 的步兵打不到隔壁的飞行单位。');
  }
  if (def.flight === true) {
    lines.push('飞行：能掠过水面（也能停在水上），森林和丘陵按 1 步算。河防对它不成立。');
  }
  // ── 奇想兵种包的机制 ──────────────────────────────────────────────────
  if (def.magicAtk) {
    lines.push(
      `魔法攻击 ${def.magicAtk}：这是**第二段伤害**，不吃护甲、不吃地形、也不吃破甲，只被目标的魔法抗性平减。打重甲特别划算。`,
    );
  }
  if (def.magicRes) lines.push(`魔法抗性 ${def.magicRes}：直接减掉对方魔法段，对物理伤害无效。`);
  if (def.element) {
    lines.push(
      `攻击属性：${ELEMENT_NAME[def.element]}。属性本身不加伤害，但怕它的兵会多吃——看下面的弱点表。`,
    );
  }
  const weakEntries = Object.entries(def.weak ?? {}) as Array<[Element, number]>;
  if (weakEntries.length > 0) {
    lines.push(
      `弱点：${weakEntries.map(([k, v]) => `${ELEMENT_NAME[k]}属性伤害 ×${v}`).join('、')}`,
    );
  }
  const resistEntries = Object.entries(def.resist ?? {}) as Array<[Element, number]>;
  if (resistEntries.length > 0) {
    lines.push(
      `抗性：${resistEntries.map(([k, v]) => `${ELEMENT_NAME[k]}属性伤害 −${v}`).join('、')}`,
    );
  }
  if (def.ammo) lines.push(`弹药 ${def.ammo} 发：打完魔法段归零、射程掉到 1，只能贴身砍。`);
  if (def.summon) {
    const what = def.summon.random
      ? '随机一种元素'
      : (def.summon.type ? '随从' : '随从');
    lines.push(
      `召唤：每 ${def.summon.every} 个自己的回合，在相邻空格召来一个${what}，场上最多 ${def.summon.max} 个。召唤物不占编制。`,
    );
  }
  if (def.cycle && def.cycle.length > 0) {
    lines.push(
      `可切属性：${def.cycle.map((e) => ELEMENT_NAME[e]).join(' → ')}。切换后攻击按当前属性附带效果（火=点燃、水=霜缚、自然=自身回血 10%、暗=魔法段 ×1.5）。`,
    );
  }

  // 英雄技能：写成"每回合一次的选择"，和界面上那块菜单对应
  if (def.skills && def.skills.length > 0) {
    for (const k of def.skills) {
      // 两种模型分开说：充能型不是"多久能用一次"，而是"一共攒几次、多久回一发"
      const cd =
        (k.charges ?? 0) > 0
          ? `最多 ${k.charges} 发，每 ${Math.max(1, k.regen ?? 2)} 回合回一发`
          : (k.cooldown ?? 1) > 1
            ? `冷却 ${k.cooldown} 回合`
            : '每回合可用';
      lines.push(`技能「${k.name}」（${cd}）：${k.summary}`);
    }
    lines.push('技能不占行动，由你主动施放——英雄的强度有一半在"什么时候开"上。');
  }
  if (def.hero) {
    lines.push(
      `英雄：同方场上只能有一个。第一次招募要额外付 ${def.unlockCost ?? 0} 金解锁，解锁后永久开放。`,
    );
  }
  if (def.summonedOnly) lines.push('只能被召唤出来，不能从产线生产。');
  if (def.decays) lines.push(`每回合自损 ${def.decays} 点生命，撑不了几回合。`);
  // 传了具体单位就按它现在的数值说（境界、custom.splashRatio 都会改这两项），
  // 只给兵种定义时退化成兵种表里的基数。修士的溅射完全由扩展给，
  // 兵种表里没有 splash，所以判断条件要看"算出来的半径"，不能只看 def.splash。
  const baseSplash = def.splash ?? 0;
  const radius = unit ? splashRadiusOf(s, unit) : baseSplash;
  if (baseSplash > 0 || radius > 0) {
    lines.push(
      radius > 0
        ? `溅射：主目标 ${radius} 格内的敌人各吃 ${Math.round(
            (unit ? splashRatioOf(unit) : CONFIG.splashRatio) * 100,
          )}% 伤害（不打自己人）`
        : '溅射：这个单位眼下没有溅射范围（扩展按境界/状态给的半径是 0）',
    );
  }
  if (def.burst) {
    lines.push(
      `多动：一回合能攻击 ${def.burst} 次，每次都是完整的一击，可以换目标——` +
        `次数用完才算行动结束。反击同样按次数算，所以它会一轮换一轮地被围攻`,
    );
  }
  if (def.transport) {
    lines.push(`运输船：能把贴身的陆军装进货舱（容量 ${def.capacity ?? 0}），运过水面再放下来。`);
    lines.push('自己不打架。船被打沉，舱里的人一起没——运兵就是拿人命过河。');
  }
  if (def.bridges) {
    lines.push('架在水面上：双向通行，谁都能从桥上走过（不能停留），船还能从桥下过。耐久归零就塌回水面。');
  }
  if (def.barracks) {
    lines.push('前线产兵点：兵从营门四邻的空地出来，时代取离它最近的己方城市。城市丢了就产不出兵。');
    const on = (def.buildOn ?? []).map((t) => TERRAIN_INFO[t].name).join('或');
    if (on) lines.push(`只能扎在${on}上`);
    if (def.requiresWater) lines.push('必须紧邻水域（靠水补给），所以它天然长在水边');
  }
  if (def.category === 'building') {
    const cost = buildCostOf(def);
    const power = buildPowerOf(def);
    lines.push(
      `建造点数 ${cost}：投不够就先落一个工地——看得见、挡得住、能被打，但开不了火也产不了兵。` +
        `施工能力 ${power} 的工兵要 ${Math.max(1, Math.ceil(cost / power))} 个回合；` +
        '两个工兵一起修，就是两次"建造"叠在同一个工地上，进度相加。',
    );
  }
  if ((def.builds ?? []).length > 0) {
    lines.push(
      `施工能力 ${buildPowerOf(def)}：每回合能往工地里投多少点。换个更强的工兵，同一座塔会更快立起来。`,
    );
  }
  if ((def.footprint ?? 1) > 1) {
    lines.push('占地 2×2：四格一起挡路、一起挨打，拆掉才一起消失（锚点在左上角）。');
  }
  if (def.garrison) {
    lines.push(
      `可驻军：友军站上来额外 +${CONFIG.garrisonArmor} 护甲、并借用它的视野。这是"进驻"唯一的意义——站上去得有用。`,
    );
  }

  const names = abilityNames(def);
  if (names.length > 0) {
    lines.push(`特殊能力：${names.join('、')}`);
    for (const id of def.abilities ?? []) {
      const a = abilityById(id);
      if (a) lines.push(`　${a.name} — ${a.summary}`);
    }
  }

  if (def.category === 'economy' || def.category === 'building') {
    // 多资源：同一个单位在不同地形上可以产不同的东西，所以先列"哪块地出什么"
    if (def.yieldByTerrain) {
      const parts = (Object.keys(def.yieldByTerrain) as Terrain[])
        .map((t) => {
          const table = def.yieldByTerrain?.[t] ?? {};
          const items = Object.entries(table)
            .filter(([, v]) => (v ?? 0) > 0)
            .map(([id, v]) => `+${v} ${resourceShort(id)}`)
            .join(' ');
          return items ? `${TERRAIN_INFO[t].name} ${items}` : '';
        })
        .filter(Boolean)
        .join(' · ');
      if (parts) lines.push(`每回合产出（按所站地形）：${parts}`);
    } else if (def.yield) {
      const items = Object.entries(def.yield)
        .filter(([, v]) => (v ?? 0) > 0)
        .map(([id, v]) => `+${v} ${resourceShort(id)}`)
        .join(' ');
      if (items) lines.push(`每回合产出：${items}`);
    }
    if (def.incomeByTerrain) {
      const parts = (Object.keys(def.incomeByTerrain) as Terrain[])
        .map((t) => {
          const v = def.incomeByTerrain?.[t] ?? 0;
          return `${TERRAIN_INFO[t].name} +${v}`;
        })
        .join(' · ');
      lines.push(`每回合产出：${parts}`);
      lines.push(`相邻水域额外 +${CONFIG.riverTradeBonus} 金`);
    } else if (def.income) {
      lines.push(`每回合产出 ${def.income} 金`);
    }
  }

  if (def.costRes) {
    const extra = Object.entries(def.costRes)
      .filter(([, v]) => (v ?? 0) > 0)
      .map(([id, v]) => `${v} ${resourceShort(id)}`)
      .join(' + ');
    if (extra) lines.push(`另外要 ${extra}（金币之外的那份）`);
  }

  if (def.builds && def.builds.length > 0) {
    const names = def.builds.map((id) => s.unitTypes[id]?.name ?? id).join('、');
    lines.push(`可建造：${names}（建造占掉整个回合，范围 ${CONFIG.buildRange} 格）`);
    lines.push('本身不产金，靠盖出来的东西挣钱或防守');
  }

  if (def.autoAttack) {
    lines.push(`每回合自动开火，射程 ${def.range} 格，优先打最近且血最少的敌人`);
  }

  if (def.move === 0) {
    lines.push('无法移动，也不能被推走');
  }

  if (def.range > 1) {
    lines.push(`远程攻击，射程 ${def.range} 格：站在对方射程外输出可以不吃反击`);
  }

  if (def.range === 1) {
    lines.push('近战：攻击后会遭到对方反击（除非一击必杀）');
  }

  lines.push(`来自「${eraDef(def.era).name}」时代，造价 ${def.cost}`);

  // 扩展包兵种要说清出处：不然玩家在列表里看见"九头蛇"，
  // 既不知道它属于哪个包，也不知道为什么下把没了。
  const src = unitSourceOf(def.id);
  if (src) lines.push(`来源：${src}（开局勾上这个扩展才会出现）`);

  return lines;
}

/**
 * 这一局有没有"高度"这回事。
 *
 * 高度是「地形高差」扩展带来的：没勾这个扩展，所有地形一样高，
 * 面板上就不该出现"高 2 层"这种没有对应规则的数字。
 */
function heightRuleOn(s: GameState): boolean {
  return activeExpansions(s).some((e) => typeof e.hooks.terrainHeight === 'function');
}

/**
 * 属性在「属性精研」下的实际效果，一句话版（面板上那行小字）。
 *
 * 数值的真相在 `fantasy-packs.ts` 的 `element-mastery` 里，这里只负责
 * "说得清"：玩家看着「当前属性：暗」得知道这代表什么，否则那个词只是一枚徽标。
 * 改那条能力时这张表要跟着改——它是同一件事的两种写法。
 */
export const ELEMENT_EFFECT: Partial<Record<Element, string>> = {
  fire: '命中再点一层火',
  water: '命中挂霜缚（移动 −1）',
  nature: '攻击时回自己 10% 生命',
  dark: '魔法段 ×1.5',
};

/** 地形说明，直接给面板用。传了 state 才会算高度（高度是扩展给的）。 */
export function describeTerrain(t: Terrain, s?: GameState): string[] {  const info = TERRAIN_INFO[t];
  const lines = [`进入消耗：${info.cost}`, `防御：${info.defense}`, info.note];

  if (s && heightRuleOn(s)) {
    const h = heightOfTerrain(s, t);
    const base = heightOfTerrain(s, 'plain');
    const d = h - base;
    lines.push(
      d === 0
        ? `高度：${h} 层（与平原同高）`
        : `高度：${h} 层（比平原${d > 0 ? '高' : '低'} ${Math.abs(d)} 层）`,
    );
    lines.push('俯射：比目标高 2 层以上，远程兵射程 +1；低 2 层以上 -1');
    lines.push('爬坡：从更低处走进来，每高 1 层多花 1 点移动力（最多算 2 层）；下坡不加价');
  }

  // 这个地形适合谁，从兵种表里现查，改了数值这里自动跟着变
  const fit = Object.values(UNIT_TYPES).filter((d) => {
    const v = d.incomeByTerrain?.[t];
    return typeof v === 'number' && v > 0;
  });
  if (fit.length > 0) {
    const names = fit.map((d) => `${d.name} +${d.incomeByTerrain?.[t] ?? 0}`).join('、');
    lines.push(`适合布置：${names}`);
  }

  return lines;
}

/** 给面板显示"这个单位现在站在什么地形上、赚多少" */
export function currentIncomeText(s: GameState, typeId: string): string {
  const def = s.unitTypes[typeId];
  if (!def) return '';
  const table = def.incomeByTerrain;
  if (!table) return '';
  const best = (Object.keys(table) as Terrain[]).sort(
    (a, b) => (table[b] ?? 0) - (table[a] ?? 0),
  )[0];
  if (!best) return '';
  return `最佳地形：${TERRAIN_INFO[best].name}（+${table[best] ?? 0}）`;
}

/** 单位是不是"经济型"，UI 用来决定显不显示产出说明 */
export function isEarner(def: UnitTypeDef): boolean {
  return !!def.incomeByTerrain || typeof def.income === 'number';
}

/* ------------------------------------------------------------------ */
/* 天气                                                                */
/* ------------------------------------------------------------------ */

/**
 * 每种气候的图标。
 *
 * 用字形而不是图片：不用加载资源、跟着字号缩放、在深色浅色下都不糊。
 * 图标只负责"一眼认出是哪一类"，具体数值永远由下面的文字给出——
 * 图标认错一次没关系，数值写错一次就是另一局游戏了。
 */
export const CLIMATE_ICON: Record<Climate, string> = {
  mild: '☀',
  cold: '❄',
  hardWinter: '☃',
  hot: '☀',
  blazing: '🔥',
  dampCold: '🌧',
  dampHeat: '♨',
  overcast: '☁',
  downpour: '⛈',
  fog: '🌫',
  thunder: '⚡',
  frozen: '🧊',
  driftIce: '❆',
  storm: '🌪',
};

function signedPct(rate: number): string {
  const v = Math.round(rate * 100);
  return `${v > 0 ? '+' : '−'}${Math.abs(v)}%`;
}

/**
 * 这个气候到底改了什么，翻成人话。
 *
 * **从效果表派生**，不另写一份文案：表格改了、说明跟着改，
 * 不会出现"界面上写着 -25%、实际已经调成 -50%"这种最难查的错。
 */
export function climateEffectLines(c: Climate): string[] {
  const e = climateEffect(c);
  const out: string[] = [];

  if (e.moveMul !== undefined && e.moveMul !== 1) out.push(`移动力 ${signedPct(e.moveMul - 1)}`);
  if (e.moveCostAdd) out.push(`每格移动消耗 +${e.moveCostAdd}`);
  if (e.armorPenalty) {
    out.push(
      e.armorPenaltyOnlyField
        ? `不在城里的军队护甲 −${e.armorPenalty}`
        : `全军护甲 −${e.armorPenalty}`,
    );
  }
  if (e.incomeMul !== undefined && e.incomeMul !== 1) {
    out.push(`经济产出 ${signedPct(e.incomeMul - 1)}`);
  }
  if (e.rangeAdd) out.push(`攻击范围 ${e.rangeAdd > 0 ? '+' : '−'}${Math.abs(e.rangeAdd)}`);
  if (e.rangeMax) out.push(`攻击范围不超过 ${e.rangeMax}`);
  if (e.visionMax) out.push(`视野不超过 ${e.visionMax}`);
  if (e.endDamage) {
    const d = e.endDamage;
    const splash = d.splash ? `，周围 ${d.radius ?? 1} 格再吃一半` : '';
    out.push(
      d.hits > 1
        ? `回合末受 ${d.hits} 次 ${d.amount} 点伤害（吃护甲）`
        : `回合末受 ${d.amount} 点伤害${splash}`,
    );
  }
  if (e.upkeepRate) out.push(`回合末交 ${Math.round(e.upkeepRate * 100)}% 维护费`);
  if (e.upkeepHpRatio) out.push(`交不起则掉 ${Math.round(e.upkeepHpRatio * 100)}% 生命上限`);
  if (e.navyMoveZero) out.push('海军移动力归零');
  if (e.navyMoveMul !== undefined && e.navyMoveMul !== 1) {
    out.push(`海军移动力 ${signedPct(e.navyMoveMul - 1)}`);
  }
  if (e.landOnIce) out.push('陆军可以在冰面上行走');

  return out;
}
