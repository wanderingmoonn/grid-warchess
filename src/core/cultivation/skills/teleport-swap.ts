/**
 * 传送阵的「挪移」：把阵周围的一切与落点周围的一切整体对调。
 *
 * ── 规则（2026-11-06 敲定）────────────────────────────────
 *
 * 设矢量 v = 落点 − 阵的位置：
 *   · 阵半径 R 内的单位，坐标 +v；
 *   · 落点半径 R 内的单位，坐标 −v；
 *   · 两片区域重叠时**源侧优先**——同时挨着两边的单位只加不减。
 *
 * 常见的直觉是"两片圆盘互换"，这里用矢量平移等价表达：只要两边形状一样，
 * 平移就是互换，而且不用担心"哪个配哪个"。
 *
 * ── 失败即惩罚 ──────────────────────────────────────────
 *
 * 灵石**先扣**。界内不够、地形站不住、落点被大单位占着……一律不细说，
 * 只报"传送失败，传送阵过载"。而且失败的这一次仍然算作本回合已经放过技能
 * （doHeroSkill 成功分支才写 skillTurn，所以这里失败也返回 ok，只是不挪人）。
 *
 * 代价必须**撤不回来**，所以这条技能声明了 `irreversible`：界面用完就把撤回栈
 * 清空。否则撤一下就能把灵石和这一次施放机会全拿回来，"失败也照扣"等于没说。
 * 战报里那句「传送阵撼动了时空结构」就是给这件事留的痕——不管成没成，
 * 时空都被搅过一次。
 *
 * ── 大单位不参与 ────────────────────────────────────────
 *
 * 占地 2×2 的单位坐标是"锚点"，平移之后锚点落在别人的格子里，判定非常绕。
 * 一期直接规定：占地 > 1 的单位不传送；它们挡在落点上就整体失败。
 */
import type { SkillDef, Unit } from '../../types.ts';
import { registerSkillEffect, registerSkillPreview } from '../../skill-hooks.ts';
import { resOf, addRes } from '../../resources.ts';
import { SPIRIT_STONE } from '../resources.ts';
import { distance, inBounds } from '../../query.ts';

/** 对调的半径（格，曼哈顿距离） */
export const TELEPORT_RADIUS = 2;
/** 每次施放消耗的灵石。失败不退，这是"过载"的代价。 */
export const TELEPORT_COST = 10;
/** 失败时的战报。故意不写细节：玩家该学的是"别往水里传"，不是背规则。 */
export const TELEPORT_OVERLOAD_LOG = '传送失败，传送阵过载';
/**
 * 每次施放（成或不成）都留的一句。
 *
 * 它同时是三件事的说明：灵石为什么扣了、这一回合为什么不能再传、
 * 以及为什么这一步撤不回来。
 */
export const TELEPORT_RIFT_LOG = '传送阵撼动了时空结构';

export const TELEPORT_SKILL: SkillDef = {
  id: 'teleport-swap',
  name: '挪移',
  summary:
    `把阵周围 ${TELEPORT_RADIUS} 格内的单位，与落点周围 ${TELEPORT_RADIUS} 格内的单位整体对调。` +
    `全图选点，耗 ${TELEPORT_COST} 灵石，每回合一次；失败也照扣，而且撤不回来。`,
  effect: 'teleport-swap',
  cooldown: 0,
  multiCast: false, // 一回合只能开一次
  targeting: 'point',
  radius: TELEPORT_RADIUS,
  // 灵石已经扣了、这一次施放也已经用掉：撤回去就等于把惩罚退掉
  irreversible: true,
};

registerSkillEffect('teleport-swap', (c) => {
  const s = c.state;
  const self = c.self;
  const target = c.target;

  const p = s.players[self.owner];
  if (resOf(p, SPIRIT_STONE) < TELEPORT_COST) {
    c.result.ok = false;
    c.result.reason = `灵石不足（挪移需要 ${TELEPORT_COST} 灵石）`;
    return;
  }
  // 先扣。后面任何一步失败都不退——这是设计好的惩罚。
  addRes(p, SPIRIT_STONE, -TELEPORT_COST);
  // 钱一扣，时空就算被搅过一次：成败都留痕（战报按时间倒序显示，
  // 这句会落在"过载/挪移"那行下面）
  c.api.pushLog(s, self.owner, TELEPORT_RIFT_LOG);

  const overload = () => {
    c.result.log = TELEPORT_OVERLOAD_LOG;
  };

  if (!target || !inBounds(s, target.x, target.y)) return overload();

  const vx = target.x - self.x;
  const vy = target.y - self.y;
  // 落在自己身上等于没传，照样算一次过载（否则可以拿它当"原地放技能"刷）
  if (vx === 0 && vy === 0) return overload();

  const fpOf = (u: Unit) => c.api.utype(s, u.type).footprint ?? 1;

  // 收集。顺序很重要：先判源侧，命中就不再判落点侧（源侧优先）。
  const plan: Array<{ u: Unit; x: number; y: number }> = [];
  for (const u of s.units) {
    if (fpOf(u) > 1) continue; // 大单位永不参与
    if (distance(u, self) <= TELEPORT_RADIUS) {
      plan.push({ u, x: u.x + vx, y: u.y + vy });
    } else if (distance(u, target) <= TELEPORT_RADIUS) {
      plan.push({ u, x: u.x - vx, y: u.y - vy });
    }
  }

  // 校验一：界内 + 地形站得住。此时谁都没挪，所以必须忽略"格子上有人"。
  for (const m of plan) {
    if (!inBounds(s, m.x, m.y)) return overload();
    if (!c.api.canStandAt(s, m.x, m.y, m.u.type, { ignoreUnits: true })) return overload();
  }

  // 校验二：全部挪完之后，同一格不能有两个单位。
  // 这一条同时管住了"落点被 2×2 大单位占着"——大单位不参与平移，
  // 它会留在原地，于是它占的那格计数变成 2，整体判过载。
  const dest = new Map<string, number>();
  const moved = new Map<string, { x: number; y: number }>();
  for (const m of plan) moved.set(m.u.id, m);
  for (const u of s.units) {
    const m = moved.get(u.id);
    const key = m ? `${m.x},${m.y}` : `${u.x},${u.y}`;
    dest.set(key, (dest.get(key) ?? 0) + 1);
  }
  for (const n of dest.values()) {
    if (n > 1) return overload();
  }

  // 落位：算完之后一次性写入，不存在"腾空到一半"的中间态
  for (const m of plan) {
    m.u.x = m.x;
    m.u.y = m.y;
  }

  c.result.log =
    plan.length > 1
      ? `传送阵挪移了 ${plan.length} 个单位的位置`
      : `传送阵只挪走了自己`;
});

/**
 * 瞄准预览：鼠标停在哪一格，就把"谁会挪到哪"标出来。
 *
 * 返回的是**单位的目的格**，不是"技能作用范围"——传送阵波及的是人不是地，
 * 把两片 2 格圆盘整块染红，反而看不出谁会被挤掉、谁只是站着不动。
 * 大单位不参与（和效果里的规则一致），界外的目的格直接跳过。
 */
registerSkillPreview('teleport-swap', (c) => {
  const { state, self, target } = c;
  const vx = target.x - self.x;
  const vy = target.y - self.y;
  if (vx === 0 && vy === 0) return [];

  const cells = new Set<number>();
  for (const u of state.units) {
    if ((state.unitTypes[u.type]?.footprint ?? 1) > 1) continue;
    const to =
      distance(u, self) <= TELEPORT_RADIUS
        ? { x: u.x + vx, y: u.y + vy }
        : distance(u, target) <= TELEPORT_RADIUS
          ? { x: u.x - vx, y: u.y - vy }
          : null;
    if (!to || !inBounds(state, to.x, to.y)) continue;
    cells.add(to.y * state.w + to.x);
  }
  return Array.from(cells);
});
