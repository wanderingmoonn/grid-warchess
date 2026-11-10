/**
 * 「季节与气候」扩展本体。
 *
 * 表本身在 climate.ts，这里只负责把那张表**接进规则**：
 * 移动、护甲、视野、射程、产出各挂一条钩子；回合结束的伤害与维护费
 * 走不过钩子（那需要记账、写战报、正确地记击杀），所以放在 rules.ts
 * 的回合结算里，靠 `hasSeasons(state)` 判断这个扩展开没开。
 *
 * 一条设计上的取舍：**气候只改"这一格"**，不做全局乘数。
 * 所以每条钩子都先问"这个单位站在哪儿"，再查那张表。
 */

import type { Expansion, RangeCtx, TurnEndCtx, VisionCtx } from '../expansions.ts';
import { climateEffect, isNaval, SEASON_TURNS } from './climate.ts';
import { climateAt, climateOfUnit, latitudeOf, stepClimateField, windAt } from './field.ts';
import { climateOverlayCells, seasonLabel, weatherBlock, windGlyphCells } from './view.ts';
import { seatsOf } from '../types.ts';
import type { GameState, Unit } from '../types.ts';

/** 这个扩展在这个局面里生效吗（被前置/开关过滤掉时不算） */
export function hasSeasons(s: GameState): boolean {
  return s.config.expansionIds.includes('seasons');
}

/** 单位类型（不走 rules.utype，避免规则层与扩展层互相引用） */
function defOf(s: GameState, u: Unit) {
  return s.unitTypes[u.type];
}

export const SEASONS: Expansion = {
  id: 'seasons',
  name: '季节与气候',
  blurb: '四季轮换。气温、湿度、风都是算出来的，每图另有气候带。',
  summary:
    '春夏秋冬每 10 回合轮换，但<b>换季不是跳变</b>：气温沿着一条连续的年曲线走，'
    + '从仲春 15°C 匀速升到仲夏 34°C、再落到仲冬 −6.5°C，一回合只走两度多；'
    + '水比热大，所以海水的升降永远比陆地慢半拍。'
    + '<b>每张图有自己的气候带</b>：地图种子决定整年偏冷还是偏暖（±5.5°C），顶栏写着"偏北/偏南"，'
    + '偏北的图冬天连平原都会进严冬。'
    + '每格有气温、湿度与风：气温由季节基准、海陆年温差与地形海拔决定；湿度靠蒸发注入、'
    + '随风吹、过饱和就下雨——<b>雨带会跟着风挪</b>，一场雨能从海上飘到内陆。'
    + '风是气压差吹出来的：冷处压高、暖处压低，所以山脚海边天生有风；再叠一层四季各不相同的'
    + '<b>主导风</b>（春西、夏南、秋东、冬北，四季两两相对），以及每两回合换一档的阵风。'
    + '风还会被<b>地转偏向力</b>拧一个角度：偏北的图逆时针、偏南的顺时针、正中间不偏'
    + '（同一个种子既决定这张图冷不冷，也决定它的气旋往哪边转）。'
    + '<b>风暴要雨大风也大</b>：外海的大雨配上够强的风才算风暴，所以它总在阵风那几天出现，'
    + '平时海面只是阴天。'
    + '三者一起判出这一格的天气（严冬 / 寒冷 / 凉爽 / 温和 / 大风 / 温暖 / 炎热 / 酷暑八档，'
    + '外加雨雾雷暴与冰面），再改移动、护甲、视野、射程与产出。'
    + '<b>日常的冷暖阴雨只动经济与护甲，不拖慢部队</b>——只有严冬、酷暑与暴雨才真的走不动；'
    + '而<b>大风只打空军</b>：逆风飞进那一格，每格多花 1 点移动力，地面部队一格都不受影响。'
    + '气候不影响城市。',
  scale: 'large',
  hooks: {
    /**
     * 回合开始：温湿度场走一步。
     *
     * 和灵气同一个节奏（每方回合一步，物理上"时间在流动"）。
     * 一年 40 回合 = 80 步：陆地热容 260‰ 走完 99%，水面 40‰ 只走 56%——
     * **夏天到了海水还是凉的**，这就是相位延迟。
     *
     * 它不产出任何规则效果，只更新状态。所以放在钩子的最前面，
     * 让后面那些 modifyMove / modifyArmor 读到的都是这一回合的天气。
     */
    onTurnStart: ({ state }) => {
      stepClimateField(state);
    },

    /**
     * 移动力。
     *
     * 寒冷 -25%、炎热 -25%、严冬 / 酷暑 -50%；封冻把海军按在原地，
     * 浮冰让海军慢四分之一。返回 0 表示"这一回合动不了"——
     * `movePower` 会把这个 0 原样放出去（见那边的注释）。
     */
    modifyMove: ({ state, unit, move }) => {
      const eff = climateEffect(climateOfUnit(state, unit));
      const def = defOf(state, unit);
      let out = move;
      if (def && isNaval(def)) {
        if (eff.navyMoveZero) return 0;
        if (eff.navyMoveMul) out *= eff.navyMoveMul;
      }
      if (eff.moveMul) out *= eff.moveMul;
      // **加法放在乘法之后**：凉爽的 +1 不该被某天的 -50% 先吃掉再说。
      // 实际只有严冬 / 酷暑会走到乘法那一步，两者不会同时出现，
      // 但顺序写死在这儿，以后加新天气时不用再想一遍。
      if (eff.moveAdd) out += eff.moveAdd;
      // 向下取整：2 点移动力在 -50% 之后是 1，不是 1.0 和 1.5 之间的某个数。
      // 少半格移动力没法表示，宁可让玩家吃亏一点也别给出错觉。
      return Math.max(0, Math.floor(out));
    },

    /**
     * 空中的步耗：**逆风每格 +1**。
     *
     * 问的是"飞进这一格"的价：拿目标格的风和这一步的方向比，
     * 逆风才收钱，顺风原价（也不打折——见 ClimateEffect.airUpwindCostAdd 的注释）。
     *
     * 只在**这一格是大风**时收：不这样的话，全图常年有风，
     * 等于给所有空军加了一条永久减速，玩家还会觉得"凭什么"。
     * 大风是看得见的标签——面板上写着，棋盘上染着，收钱才有理有据。
     */
    airStepCost: ({ state, fromIdx, toIdx, cost }) => {
      // 没有来处（部署、AI 只评估落点）：没有方向，也就谈不上逆风
      if (fromIdx < 0 || toIdx < 0) return undefined;
      const tx = toIdx % state.w;
      const ty = Math.floor(toIdx / state.w);
      const eff = climateEffect(climateAt(state, tx, ty));
      if (!eff.airUpwindCostAdd) return undefined;
      const w = windAt(state, tx, ty);
      const fx = fromIdx % state.w;
      const fy = Math.floor(fromIdx / state.w);
      const dot = (tx - fx) * w.x + (ty - fy) * w.y;
      if (dot >= 0) return undefined; // 顺风或侧风：不加价
      return cost + eff.airUpwindCostAdd;
    },

    /**
     * 视野。浓雾把视野压到 2。
     *
     * 只在有 unit 的调用里生效：那才是"这一格的雾有多大"；
     * 没有 unit 的是"这一方的整体视野"，雾属于格子不属于阵营。
     */
    modifyVision: ({ state, unit, base }: VisionCtx) => {
      if (!unit) return base;
      const eff = climateEffect(climateOfUnit(state, unit));
      return eff.visionMax ? Math.min(base, eff.visionMax) : base;
    },

    /** 攻击范围：阴雨 -1、暴雨 -2；浓雾封顶 4。最少留 1 格。 */
    modifyRange: ({ state, unit, range }: RangeCtx) => {
      const eff = climateEffect(climateOfUnit(state, unit));
      let out = range;
      if (eff.rangeAdd) out += eff.rangeAdd;
      if (eff.rangeMax) out = Math.min(out, eff.rangeMax);
      return Math.max(1, out);
    },

    /**
     * 护甲：酷暑 -2（所有军队），严冬 -3（只算没驻在城里的）。
     *
     * 严冬那条要排除城里：城市自带供暖，而且"躲进城"本来就是它该有的用处，
     * 否则冬天一到，守城反而成了劣势。
     */
    modifyArmor: ({ state, defender, armor }) => {
      const eff = climateEffect(climateOfUnit(state, defender));
      if (!eff.armorPenalty) return armor;
      if (eff.armorPenaltyOnlyField) {
        const tile = state.tiles[defender.y * state.w + defender.x];
        if (tile?.cityId) return armor;
      }
      return armor - eff.armorPenalty;
    },

    /**
     * 经济产出：按**脚下那一格**的气候结算。
     *
     * 湿润气候（湿冷 / 湿热）给的是翻倍甚至 2.5 倍，代价是回合末的维护费；
     * 寒冷砍半，炎热加成，雷暴三倍。倍率作用在整张产出表上，
     * 所以"沿海平原的春天"和"内陆平原的夏天"收入会真的不一样。
     */
    modifyYield: ({ state, unit, yields }) => {
      const eff = climateEffect(climateOfUnit(state, unit));
      if (!eff.incomeMul || eff.incomeMul === 1) return yields;
      const out: typeof yields = {};
      for (const [k, v] of Object.entries(yields)) {
        if (typeof v !== 'number') continue;
        out[k as keyof typeof out] = Math.round(v * eff.incomeMul);
      }
      return out;
    },

    /**
     * 回合末：雷暴 / 风暴的伤害，湿冷 / 湿热的维护费。
     *
     * 战报按"每方一条"汇总，不逐兵写。天气一次性打到全场十几个单位，
     * 逐个写会把战报刷屏，玩家反而看不见真正重要的那几条。
     */
    onTurnEnd: ({ state, hurt, log }: TurnEndCtx) => {
      const hurtTotal: Record<string, number> = { A: 0, B: 0 };
      const hurtCount: Record<string, number> = { A: 0, B: 0 };
      const feeTotal: Record<string, number> = { A: 0, B: 0 };

      for (const u of [...state.units]) {
        const def = state.unitTypes[u.type];
        if (!def) continue;
        const eff = climateEffect(climateOfUnit(state, u));

        // ── 固定伤害 ──
        // 雷暴是雷劈：50 点真伤、不看护甲，周围 1 格再吃一半。
        // 风暴是风刮：5 次 10 点**普通伤害**，每一下都吃护甲。
        const ed = eff.endDamage;
        if (ed) {
          let dmg = 0;
          for (let i = 0; i < ed.hits; i++) {
            // 雷暴（50 点）是真伤，不看护甲；风暴（5 点）吃护甲。
            //
            // **不设保底**：10×5 的意图就是"5 甲以下重伤、5 甲以上免伤"——
            // 护甲在风暴里是一条硬门槛，不是可以慢慢磨穿的减伤。
            dmg += ed.amount >= 50 ? ed.amount : Math.max(0, ed.amount - (def.armor ?? 0));
          }
          if (dmg > 0) {
            hurt(u, dmg);
            hurtTotal[u.owner] = (hurtTotal[u.owner] ?? 0) + dmg;
            hurtCount[u.owner] = (hurtCount[u.owner] ?? 0) + 1;
          }
          const splash = ed.splash ?? 0;
          if (splash > 0) {
            const r = ed.radius ?? 1;
            const extra = Math.max(1, Math.round(ed.amount * splash));
            for (const v of state.units) {
              if (v.id === u.id) continue;
              if (Math.abs(v.x - u.x) + Math.abs(v.y - u.y) > r) continue;
              hurt(v, extra);
            }
          }
        }

        // ── 维护费 ──
        if (eff.upkeepRate) {
          const fee = Math.round((def.cost ?? 0) * eff.upkeepRate);
          if (fee <= 0) continue;
          const p = state.players[u.owner];
          if (p.gold >= fee) {
            p.gold -= fee;
            feeTotal[u.owner] = (feeTotal[u.owner] ?? 0) + fee;
          } else if (eff.upkeepHpRatio) {
            const d = Math.max(1, Math.round((def.maxHp ?? 1) * eff.upkeepHpRatio));
            hurt(u, d);
            hurtTotal[u.owner] = (hurtTotal[u.owner] ?? 0) + d;
            hurtCount[u.owner] = (hurtCount[u.owner] ?? 0) + 1;
          }
        }
      }

      for (const p of seatsOf(state)) {
        const dmg = hurtTotal[p] ?? 0;
        const fee = feeTotal[p] ?? 0;
        if (dmg > 0) log(p, `天气让 ${hurtCount[p]} 个部队共损失 ${dmg} 点生命`);
        if (fee > 0) log(p, `部队维护费支出 ${fee} 金`);
      }
    },

    // ── 展示：侧栏天气块 / 顶栏季节 / 天气视图 ──────────
    //
    // 这三条以前是核心里的具名口子：`TopbarState.season` 一个字段、
    // `ui/panel.ts` 直接 import 气候表拼天气块。现在核心只认
    // 「一段 HTML」「一枚徽章」「一层染色」，不认识"季节""天气"。
    getTilePanelHtml: ({ state, x, y, unit }) => {
      const c = climateAt(state, x, y);
      // 标题分两种：点空格子看到的是"这里的天气"，点单位看到的是"脚下的天气"。
      // 文案差别很小，但玩家会因此知道"这是按格算的，不是我身上的状态"。
      const title = unit ? '脚下的天气' : '这里的天气';
      return `<div class="card-title" style="margin-top:12px">${title}</div>${weatherBlock(state, x, y, c)}`;
    },
    topbarBadges: ({ state }) => {
      const out = [
        {
          id: 'seasons-season',
          text: seasonLabel(state.turn),
          hint: `季节：每 ${SEASON_TURNS} 回合换一季`,
        },
      ];
      /*
       * 气候带：地图种子决定这张图整年偏冷还是偏暖（±5.5°C）。
       *
       * 不写出来的话，玩家只会觉得"这局怎么这么冷"，猜不到是地图本身如此。
       * 只在不冷不热的中段图才不显示——那才是"标准气候"，没什么好说的。
       */
      const lat = latitudeOf(state.seed);
      if (Math.abs(lat) >= 30) {
        const c = (Math.abs(lat) / 10).toFixed(1);
        out.push({
          id: 'seasons-latitude',
          text: lat > 0 ? '偏南' : '偏北',
          hint: `这张图的基准温度 ${lat > 0 ? '+' : '−'}${c}°C：由地图种子决定，整年一起平移`,
        });
      }
      return out;
    },
    boardViews: () => [
      {
        id: 'seasons-weather',
        label: '天气',
        hint: '看视野内的天气分布；点一下钉住，再点取消',
        cells: ({ state }) => climateOverlayCells(state),
        // 箭头只画大风区（见 windGlyphCells）：平时一格都没有，刮风季也不会糊成一片
        glyph: ({ state }) => windGlyphCells(state),
      },
    ],
  },
};
