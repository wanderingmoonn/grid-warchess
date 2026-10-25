/**
 * 单位与地形的"说明书"。
 *
 * 规则都写在数据里，但玩家看不出"农民站哪赚钱""丘陵到底加多少防"。
 * 这里把这些隐含规则翻成人话，点一下就弹出来。
 */

import { abilityById, abilityNames } from './abilities.ts';
import { CONFIG, UNIT_TYPES, eraDef } from './config.ts';
import type { GameState, Terrain, UnitTypeDef } from './types.ts';

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
};

/**
 * 一个单位的特殊之处，翻成人话。
 * 返回空数组表示它就是个普通单位。
 */
export function describeUnit(s: GameState, def: UnitTypeDef): string[] {
  const lines: string[] = [];

  if (def.domain === 'water') {
    lines.push('只在水上行动：上不了岸，只能在临水的城市下水。能打岸上的目标，也会被岸上打。');
  }
  if (def.splash) {
    lines.push(
      `溅射：主目标 ${def.splash} 格内的敌人各吃 ${Math.round(CONFIG.splashRatio * 100)}% 伤害（不打自己人）`,
    );
  }
  if (def.burst) {
    lines.push(`连击：一次攻击打 ${def.burst} 段，每段单独减护甲——打轻甲赚，打重甲亏`);
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

  const names = abilityNames(def);
  if (names.length > 0) {
    lines.push(`特殊能力：${names.join('、')}`);
    for (const id of def.abilities ?? []) {
      const a = abilityById(id);
      if (a) lines.push(`　${a.name} — ${a.summary}`);
    }
  }

  if (def.category === 'economy' || def.category === 'building') {
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
  return lines;
}

/** 地形说明，直接给面板用 */
export function describeTerrain(t: Terrain): string[] {
  const info = TERRAIN_INFO[t];
  const lines = [`进入消耗：${info.cost}`, `防御：${info.defense}`, info.note];

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
