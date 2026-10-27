/**
 * 「城郭与物料」：一座更大的城，和两种比金币更硬的东西。
 *
 * 这个扩展改的是**骨架**而不是数值：主城从 2×2 长到 3×3、建筑要分回合施工、
 * 兵要吃粮、楼要耗材、箭塔退成"看得远、守得住、但打不疼"。
 * 因为动的是骨架，它单独成文件——塞进 expansions.ts 会把那张钩子表淹掉。
 *
 * 三条设计上的取舍，写在这儿免得以后自己被自己坑：
 *
 *   1. **金币仍然是硬通货**，只是不再是唯一的。建筑升级、城市升级照旧花金币；
 *      兵种造价被拆成"六成金币 + 四成粮/材"，于是"养兵"第一次真的需要经营。
 *   2. **一种兵，多种产出**。经济单位不再各认一种地形，而是按**脚下那块地**出货：
 *      平地出粮、林丘出材。这就是"缩减经济单位种类"的落点——不是删兵，
 *      而是让"造哪种经济兵"这个问题不再有标准答案。
 *   3. **工地是真实存在的**。塔要两回合，第一回合它就是一个能被拆的工地：
 *      看得见、挡路、开不了火。于是"修塔"从瞬间动作变成需要掩护的过程。
 */

import type { Expansion } from './expansions.ts';
import type { UnitTypeDef } from './types.ts';
import { isBioUnit } from './resources.ts';

/** 生物兵吃粮、机械与建筑耗材：造价里非金币的那一份占原价的比例 */
const RES_SHARE = 0.4;
/** 金币那一份：剩下的六成 */
const GOLD_SHARE = 0.6;

/** 经济建筑（产金币的那种）——它们的"反击"最该被削 */
function isEcoBuilding(def: UnitTypeDef): boolean {
  return def.category === 'building' && (!!def.incomeByTerrain || !!def.income);
}

/** 前期经济建筑：只用粮食就能盖，不碰建材 */
function isEarlyEcoBuilding(def: UnitTypeDef): boolean {
  return isEcoBuilding(def) && def.era <= 2;
}

/** 防御塔一类的工事：要施工、能驻军 */
const FORTS = ['tower', 'keep', 'battery', 'fortress', 'bunker'];

/** 本扩展新建的两个资源建筑 */
const NEW_BUILDINGS: UnitTypeDef[] = [
  {
    id: 'granary',
    name: '粮仓',
    short: '仓',
    era: 1,
    category: 'building',
    // 造价写的是"原价"，实际收多少由下面的钩子按资源规则折算
    cost: 55,
    costRes: { food: 45 },
    move: 0,
    atk: 0,
    armor: 4,
    maxHp: 40,
    range: 0,
    vision: 2,
    // 产粮：收上来的谷子在这里变成能吃的军粮
    yield: { food: 8 },
  },
  {
    id: 'quarry',
    name: '采石场',
    short: '石',
    era: 2,
    category: 'building',
    cost: 90,
    costRes: { material: 55 },
    move: 0,
    atk: 0,
    armor: 5,
    maxHp: 46,
    range: 0,
    vision: 2,
    yield: { material: 10 },
  },
];

/**
 * 每个建造单位该多会盖什么。
 *
 * 为什么要在这里打补丁而不是直接改 config.ts：`builds` 挂在**建造兵自己**身上，
 * 而本扩展不该改变"没开这个扩展时的工程师会什么"。开局时改本局的兵种表副本，
 * 效果只作用于这一局，原版数据一个字没动。
 */
const EXTRA_BUILDS: Record<string, string[]> = {
  laborer: ['granary'],
  miller: ['quarry', 'granary'],
  engineer: ['quarry', 'granary'],
  foreman: ['quarry', 'granary'],
  crew: ['quarry', 'granary'],
};

export const CITY_WORKS: Expansion = {
  id: 'city-works',
  name: '城郭与物料',
  summary:
    '主城扩成 3×3；兵要吃粮、楼要耗材（金币只占六成）；经济单位按脚下地形出粮或出材，经济建筑出另一种；' +
    '箭塔改成两回合施工、可驻军、视野更远但打不疼；高山画得更扎眼。',
  scale: 'large',
  // 主城 3×3：地图生成时就要知道，所以写在扩展上而不是开局钩子里
  citySize: 3,
  units: NEW_BUILDINGS,
  hooks: {
    // ── 造价：金币六成、资源四成 ──
    modifyCost: ({ unitType, cost }) => {
      // 前期经济建筑只吃粮食，一分金币都不要——这是"起步靠粮"的那一段
      if (isEarlyEcoBuilding(unitType)) return 0;
      return Math.max(5, Math.round(cost * GOLD_SHARE));
    },
    modifyResourceCost: ({ unitType, baseCost }) => {
      // 前期经济建筑：全用粮食，不碰建材（否则开局就卡死在建材上）
      if (isEarlyEcoBuilding(unitType)) return { food: Math.max(20, Math.round(baseCost * 0.8)) };
      const share = Math.max(1, Math.round(baseCost * RES_SHARE));
      return isBioUnit(unitType) ? { food: share } : { material: share };
    },

    // ── 产出：金币拆一半出来，按地形落到粮或材上 ──
    modifyYield: ({ state, unit, yields }) => {
      const def = state.unitTypes[unit.type];
      if (!def) return yields;
      const gold = yields.gold ?? 0;
      if (gold <= 0) return yields;

      const ecoUnit = def.category === 'economy';
      const ecoBuilding = isEcoBuilding(def);
      if (!ecoUnit && !ecoBuilding) return yields;

      const tile = state.tiles[unit.y * state.w + unit.x];
      const terrain = tile?.terrain ?? 'plain';
      // 经济单位看脚下：林子丘陵出建材，平地城头出粮食。
      // 经济建筑看它自己是"磨坊"还是"工厂"：前期的磨坊磨的是粮，
      // 后期的工厂/兵工厂出的是建材——这样两样资源都有自己的产线，
      // 而不是所有建筑都往粮仓一个方向挤（那会让建材只能靠林子里的农民）。
      const res = ecoBuilding
        ? def.era >= 3
          ? 'material'
          : 'food'
        : terrain === 'forest' || terrain === 'hill'
          ? 'material'
          : 'food';
      const converted = Math.max(1, Math.round(gold * 0.6));
      const out = { ...yields };
      out.gold = Math.max(0, gold - converted);
      out[res] = (out[res] ?? 0) + converted;
      return out;
    },

    // ── 开局：改本局的兵种表与城市 ──
    onMatchStart: ({ state }) => {
      // 1) 建造单位多会盖两样东西
      for (const [id, extra] of Object.entries(EXTRA_BUILDS)) {
        const def = state.unitTypes[id];
        if (!def) continue;
        const builds = new Set([...(def.builds ?? []), ...extra]);
        def.builds = Array.from(builds);
      }

      // 2) 建筑数值：更耐打、更会挣、更不还手；防御塔退成"看得远、守得住"
      for (const def of Object.values(state.unitTypes)) {
        if (def.category !== 'building') continue;

        if (FORTS.includes(def.id)) {
          // 削弱进攻、加强防御：射程不动（用户的第二种方案），视野 +2、可驻军、要施工
          def.atk = Math.max(1, Math.round(def.atk * 0.7));
          def.maxHp = Math.round(def.maxHp * 1.4);
          def.armor += 2;
          def.vision += 2;
          def.garrison = true;
          // 城郭包把墙修得更厚，塔也就更难立：点数 ×1.4（本代工兵仍是两回合，
          // 差一点的工兵会明显拖到三回合）。这是"点数"比"回合数"好用的地方——
          // 换工兵有用，而不用给每种塔各写一个回合数。
          def.buildCost = Math.round((def.buildCost ?? Math.max(6, (def.cost ?? 0) / 6)) * 1.4);
          continue;
        }

        // 兵营类：营地画成 2×2 的营垒——原版的营只有一间房，一顶帐篷。
        // 占地是原版接口（UnitTypeDef.footprint），这里只是把它用起来。
        if (def.barracks) {
          def.footprint = 2;
          continue;
        }

        // 普通建筑（含经济建筑）：血更厚一档
        def.maxHp = Math.round(def.maxHp * 1.35);
        if (isEcoBuilding(def)) {
          // 经济建筑不还手：它的工作是产出，不是打架
          def.atk = 0;
          // 收益 +20%
          if (def.income) def.income = Math.round(def.income * 1.2);
          if (def.incomeByTerrain) {
            const next: Record<string, number> = {};
            for (const [k, v] of Object.entries(def.incomeByTerrain)) {
              next[k] = Math.round((v ?? 0) * 1.2);
            }
            def.incomeByTerrain = next as typeof def.incomeByTerrain;
          }
        }
      }

      // 3) 后期经济/工程兵种：略微加强战斗力。
      //    它们本来是"花钱买的产能"，到了后期却连自保都做不到——
      //    给一点攻击和血量，让"带两把工兵铲上前线"这件事不再等于送人头。
      for (const def of Object.values(state.unitTypes)) {
        if (def.era < 3) continue;
        if (def.category !== 'economy' && def.category !== 'builder') continue;
        def.atk += 3;
        def.maxHp += 6;
        if (def.era >= 4) def.armor += 1;
      }

      // 4) 主城：血更厚（城市是这一局的核心，3×3 的城不该比 2×2 的还脆）
      for (const city of state.cities) {
        city.maxHp = Math.round(city.maxHp * 1.5);
        city.hp = city.maxHp;
      }

      // 5) 场上已有的建筑按新上限补血（开局就有城郊设施的场景、读档后的沙盒）
      for (const u of state.units) {
        const def = state.unitTypes[u.type];
        if (!def) continue;
        if (def.category === 'building' && u.hp > def.maxHp) u.hp = def.maxHp;
      }

      // 6) 起步的一点粮和材：不然第一个兵都造不出来（造价已经不是纯金币了）。
      //    按时代给，是因为高时代开局的兵更贵、吃粮更多：
      //    固定 60 粮在古典够用五六个民兵，在工业连一个步枪兵都不够。
      for (const p of ['A', 'B'] as const) {
        const player = state.players[p];
        player.res = { ...(player.res ?? {}) };
        player.res.food = (player.res.food ?? 0) + 80 + state.config.startEra * 60;
        player.res.material = (player.res.material ?? 0) + 50 + state.config.startEra * 40;
      }
      state.log.push({
        turn: state.turn,
        player: 'A',
        text: '城郭与物料：主城扩为 3×3，兵吃粮、楼耗材，箭塔改为两回合施工且可驻军',
      });
    },
  },
};
