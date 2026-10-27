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

import type { Expansion, RangeCtx, TurnEndCtx, VisionCtx } from './expansions.ts';
import { climateEffect, climateOfUnit, isNaval } from './climate.ts';
import type { GameState, Unit } from './types.ts';

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
  summary:
    '春夏秋冬每 10 回合轮换。每格的气候由地形与海陆距离决定，再改这一格上的移动、护甲、视野、射程与产出。气候不影响城市。',
  scale: 'large',
  hooks: {
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
      // 向下取整：2 点移动力在 -25% 之后是 1，不是 1.5。
      // 少半格移动力没法表示，宁可让玩家吃亏一点也别给出错觉。
      return Math.floor(out);
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

      for (const p of ['A', 'B'] as const) {
        const dmg = hurtTotal[p] ?? 0;
        const fee = feeTotal[p] ?? 0;
        if (dmg > 0) log(p, `天气让 ${hurtCount[p]} 个部队共损失 ${dmg} 点生命`);
        if (fee > 0) log(p, `部队维护费支出 ${fee} 金`);
      }
    },
  },
};
