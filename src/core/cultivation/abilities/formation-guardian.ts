/**
 * 守御阵：替半径内的友军挨打，靠吸守阵修士的血硬撑。
 *
 * 两条腿：
 *
 * 1. **转移**（`ExpansionHooks.redirectDamage`，在 hooks.ts 里接）：友军挨打时
 *    这一下改由阵来承受。只转伤害——中毒、减速、击退仍然留在原来那个人身上，
 *    因为阵是建筑，那些东西对它要么无意义、要么会崩。
 *
 * 2. **吸血**（下面的 `onDamaged`）：阵掉血之后，立刻从相邻修士身上抽血补自己。
 *    这是"硬撑 vs 弃守"这个决策的全部来源——修士的血是有限的公共资源，
 *    阵不是无敌的，它只是在烧别人的命换时间。
 *
 * 没有主动技能，是有意的：主动技能要求玩家在自己回合按一下，而挨打发生在
 * 对面回合。等轮到你回血，阵早就被打没了。
 *
 * 红线：本文件不许 import `rules.ts`。生命上限、战报都从注入的 `c.api` 拿，
 * 否则 rules → 扩展 → rules 会成运行时环。
 */
import type { GameState, Unit } from '../../types.ts';
import type { AbilityDef } from '../../abilities.ts';
import { distBetweenUnits } from '../../query.ts';
import { UNIT_IDS } from '../identity.ts';
import { getRank } from '../progression.ts';
import { bestAdjacentCultivator } from './formation-guard.ts';

/** 转移的半径：阵周围 2 格内的友军挨打，由它接 */
export const GUARDIAN_RADIUS = 2;

/** 修士每掉 1 点生命，阵回多少点——乘守阵修士的境界，所以这里是"每级"的系数 */
export const GUARDIAN_HEAL_PER_HP = 1;

/** 每回合最多吸多少点修士生命——每级一点，0 级无额度（凡人当不了血包） */
export const GUARDIAN_DRAIN_CAP_PER_RANK = 1;

export const FORMATION_GUARDIAN_ID = 'formation-guardian';
export const GUARDIAN_LABEL = '守御';

export const FORMATION_GUARDIAN: AbilityDef = {
  id: FORMATION_GUARDIAN_ID,
  name: '守御',
  summary:
    `半径 ${GUARDIAN_RADIUS} 内的友军（含建筑）受到伤害时，改由本阵承受；` +
    `阵受损后自动吸取相邻修士的生命：每 1 点修士生命回 ${GUARDIAN_HEAL_PER_HP} × 境界 点，` +
    `每回合最多吸「境界」点，且不会把修士吸死。移走修士即可弃守。`,
  group: 'defense',
  hooks: {
    onDamaged: ({ state, self, amount, api }) => {
      if (amount <= 0) return;

      // 满血（或已经被奶回来）就别抽了：补给只在真的破了口子时发生
      const max = api.maxHpOf(state, self);
      const gap = max - self.hp;
      if (gap <= 0) return;

      const guard = bestAdjacentCultivator(state, self);
      if (!guard) return;
      const rank = getRank(guard);
      if (rank <= 0) return; // 0 级修士换不出血来，别把他白抽干

      /*
       * 每回合额度。
       *
       * 不设上限的话，阵只要身边有修士就永远补得满——那它就不是"肉盾"而是
       * "无敌"。现在一轮最多换 `境界` 点修士生命，所以持续挨打会**慢慢磨损**，
       * 逼玩家轮换守阵的人。
       *
       * 记在 `custom` 里（随存档走），按 `s.turn` 判断是不是同一回合——
       * 和击杀历练额度用的是同一套写法。
       */
      const prev = self.custom ?? {};
      const used =
        prev.guardDrainTurn === state.turn
          ? ((prev.guardDrainUsed as number | undefined) ?? 0)
          : 0;
      const quota = rank * GUARDIAN_DRAIN_CAP_PER_RANK - used;
      if (quota <= 0) return;

      const perHp = rank * GUARDIAN_HEAL_PER_HP;
      // 补满缺口需要多少点修士血：向上取整，因为血按整点扣
      const need = Math.ceil(gap / perHp);
      // 修士至少留 1 点血。吸死自己人这种事不能靠玩家"小心一点"来避免
      const canPay = Math.max(0, Math.floor(guard.hp) - 1);
      const take = Math.min(need, quota, canPay);
      if (take <= 0) return;

      const healed = Math.min(gap, take * perHp);
      guard.hp -= take;
      self.hp = Math.min(max, self.hp + healed);
      self.custom = {
        ...prev,
        guardDrainTurn: state.turn,
        guardDrainUsed: used + take,
      };

      // 写明白"谁的血被抽了"：修士血条在掉，玩家得知道是谁干的，不然会当成 bug
      api.pushLog(
        state,
        self.owner,
        `${api.utype(state, self.type).name} 吸取 ${api.utype(state, guard.type).name} ` +
          `${take} 点生命，恢复 ${healed} 点`,
        true,
      );
    },
  },
};

/**
 * 这个单位挨打时，该由哪座守御阵接。没有就返回 null。
 *
 * 只接**自家**友军（含建筑），取**最近**的那座。同距离按 id 字典序——联机对局里
 * 两家各自遍历 `s.units`，顺序不同就会算出不同的接替者，当场不同步。
 *
 * 注意这里不排除"阵自己"：victim 就是阵时下面第一条 `u.id === victim.id`
 * 已经把它跳过，所以阵自己挨打不会被自己接住；但另一座更近的阵可以接。
 */
export function guardianFor(state: GameState, victim: Unit): Unit | null {
  let best: Unit | null = null;
  let bestDist = Infinity;
  for (const u of state.units) {
    if (u.owner !== victim.owner) continue;
    if (u.id === victim.id) continue;
    if (u.type !== UNIT_IDS.GUARD_FORMATION) continue;
    if (u.hp <= 0) continue;
    const d = distBetweenUnits(state, u, victim);
    if (d > GUARDIAN_RADIUS) continue;
    if (best === null || d < bestDist || (d === bestDist && u.id < best.id)) {
      best = u;
      bestDist = d;
    }
  }
  return best;
}
