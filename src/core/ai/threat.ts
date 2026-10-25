/** 每个不可变决策快照只构建一次威胁图，复用规则内核的地形与移动修正。 */
import { auraBonus, inBounds, other, reachableTiles, unitsOf, utype, xyOf } from '../rules.ts';
import type { GameState, PlayerId } from '../types.ts';

interface ThreatField {
  counts: Uint16Array;
  damage: Float64Array;
}

const fields = new WeakMap<GameState, Map<PlayerId, ThreatField>>();

function fieldFor(state: GameState, owner: PlayerId): ThreatField {
  let byPlayer = fields.get(state);
  if (!byPlayer) {
    byPlayer = new Map();
    fields.set(state, byPlayer);
  }
  const existing = byPlayer.get(owner);
  if (existing) return existing;

  const field: ThreatField = {
    counts: new Uint16Array(state.w * state.h),
    damage: new Float64Array(state.w * state.h),
  };
  for (const enemy of unitsOf(state, other(owner))) {
    const def = utype(state, enemy.type);
    const attack = def.atk + auraBonus(state, enemy).atk;
    // 无武器的运输船、经济单位不应把邻近地区染成危险区。
    // 军事建筑则有真实射程，不能因为 category !== combat 而漏算。
    if (attack <= 0 || def.range <= 0) continue;
    // 自定义兵种允许小数或超长射程；棋盘距离为整数，且覆盖不应越过棋盘大小。
    const radius = Math.min(Math.floor(def.range), state.w + state.h - 2);

    // 预测的是敌方下一回合：不能继承上一回合已行动的标记。
    const nextEnemy = { ...enemy, moved: false, acted: false };
    const origins = [enemy, ...Array.from(reachableTiles(state, nextEnemy).keys(), (i) => xyOf(state, i))];
    const threatened = new Set<number>();
    for (const origin of origins) {
      for (let dy = -radius; dy <= radius; dy++) {
        const width = radius - Math.abs(dy);
        for (let dx = -width; dx <= width; dx++) {
          if (dx === 0 && dy === 0) continue;
          const x = origin.x + dx;
          const y = origin.y + dy;
          if (inBounds(state, x, y)) threatened.add(y * state.w + x);
        }
      }
    }
    // 同一敌人即使有多个开火位置，也只占一份威胁。
    for (const i of threatened) {
      field.counts[i] += 1;
      field.damage[i] += attack * Math.max(1, def.burst ?? 1);
    }
  }
  byPlayer.set(owner, field);
  return field;
}

/** 只接受玩家视图；dmg 为未扣护甲的火力上界，不是精确战斗预测。 */
export function enemyThreatAt(state: GameState, owner: PlayerId, x: number, y: number): { n: number; dmg: number } {
  if (!inBounds(state, x, y)) return { n: 0, dmg: 0 };
  const field = fieldFor(state, owner);
  const i = y * state.w + x;
  return { n: field.counts[i] ?? 0, dmg: field.damage[i] ?? 0 };
}

export function inDanger(state: GameState, owner: PlayerId, x: number, y: number): boolean {
  return enemyThreatAt(state, owner, x, y).n > 0;
}
