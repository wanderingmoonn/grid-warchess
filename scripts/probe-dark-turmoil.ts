/**
 * 「黑暗动乱」整包测试（2026-11-20 合并版）。
 *
 * ── 为什么只剩一个文件 ──────────────────────────────────────────────
 *
 * 之前拆成十个探针（shadow / shade / blood / bone / odd / servant / court /
 * heir / relic + 这个），四百多条断言，相当一部分在钉"兵种血量是不是 140"这种
 * **配置复述**：改数值它就红、真改错了反而不一定红——它守的是文档，不是行为。
 *
 * 现在只守**机制**：每条 1~3 句，问的是"这个机制还成立吗"，不是"这个数是几"。
 * 数值、面板文案、词条挂载交给规则书和代码审查，不在这里重复一遍。
 *
 * 用法：npm run probe:dark-turmoil
 */

import { abilityApi, applyAction, isHiddenFrom, visionOf } from '../src/core/rules.ts';
import { createMatch, DEFAULT_CONFIG } from '../src/core/setup.ts';
import { SKILL_AI_HINTS } from '../src/core/skill-hooks.ts';
import type { SkillAiCtx } from '../src/core/skill-hooks.ts';
import { realmArmorBase, realmAtkBase, trueDamageForRank, extraAttacksForRank } from '../src/core/cultivation/stats.ts';
import { totalHpBonusForRank } from '../src/core/cultivation/progression.ts';
import { unitAiProfileOf } from '../src/core/unit-ai.ts';
import type { UnitAiCtx } from '../src/core/expansions.ts';
import {
  BLACK_COCOON,
  BLACK_LOCUST,
  BLOOD_MEDIC,
  BLOOD_POOL,
  BONE_SKELETON,
  BONE_UNNAMED,
  BRONZE_GUARD,
  CLOT_DAMAGE,
  EMPEROR,
  FLESH,
  FUNERARY_URN,
  IMPERIAL_STELE,
  KINDRED,
  MORTAL_IMMORTAL,
  PUPPET_MASTER,
  SHADE,
  SHADOW_LORD,
  SLUMBER,
  SOUL_HOOKER,
  UNNAMABLE,
  refreshShadow,
} from '../src/core/dark-turmoil-packs.ts';
import { LEVELS } from '../src/core/level.ts';
import type { GameState, PlayerId, Unit } from '../src/core/types.ts';

let failed = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) console.log(`  ✓ ${name}`);
  else {
    failed += 1;
    console.log(`  ✗ ${name}${detail ? ` —— ${detail}` : ''}`);
  }
}
const section = (name: string): void => console.log(`\n[${name}]`);

const CONFIG = {
  ...DEFAULT_CONFIG,
  size: 24,
  startEra: 6,
  expansionIds: [...DEFAULT_CONFIG.expansionIds, 'cultivation', 'dark-turmoil'],
};

const dist = (a: { x: number; y: number }, b: { x: number; y: number }): number =>
  Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

interface Arena {
  s: GameState;
  mk: (id: string, type: string, owner: PlayerId, x: number, y: number) => Unit;
}

/** 平地小场：两家各一座城（没城的席位会被判出局），其余全靠 `mk` 摆 */
function arena(): Arena {
  const s = createMatch(CONFIG, 9876);
  s.fog = false;
  s.units = [];
  s.marks = [];
  s.overlays = {};
  s.players.A.gold = 9999;
  s.players.B.gold = 9999;
  s.tiles = s.tiles.map(() => ({ terrain: 'plain' as const, cityId: null }));
  s.cities = [
    { id: 'ca', owner: 'A', x: 0, y: 0, size: 2, era: 6, hp: 70, maxHp: 70, armor: 4 },
    { id: 'cb', owner: 'B', x: 21, y: 21, size: 2, era: 6, hp: 70, maxHp: 70, armor: 4 },
  ];
  // 一把用来"一击必杀"的刀，也当高血木桩用
  s.unitTypes['probe-killer'] = {
    ...s.unitTypes['militia']!,
    id: 'probe-killer',
    name: '处刑者',
    atk: 999,
    range: 2,
    move: 2,
    armor: 0,
    maxHp: 400,
    skills: [],
    aiAutonomy: 0,
  };
  const mk = (id: string, type: string, owner: PlayerId, x: number, y: number): Unit => {
    const u: Unit = { id, type, owner, x, y, hp: s.unitTypes[type]!.maxHp, kills: 0, moved: false, acted: false };
    if (s.unitTypes[type]!.layer) u.layer = s.unitTypes[type]!.layer;
    s.units.push(u);
    return u;
  };
  mk('keep-alive', 'militia', 'A', 0, 20);
  s.current = 'B';
  s.turn = 10;
  return { s, mk };
}

const beginTurnOf = (s: GameState, side: PlayerId): GameState => {
  const other: PlayerId = side === 'A' ? 'B' : 'A';
  if (s.current !== other) s.current = other;
  const e = applyAction(s, { type: 'END_TURN' });
  if (!e.ok) throw new Error(`END_TURN 失败：${e.reason}`);
  return e.state;
};
const endTurnOf = (s: GameState, side: PlayerId): GameState => {
  if (s.current !== side) s.current = side;
  const e = applyAction(s, { type: 'END_TURN' });
  if (!e.ok) throw new Error(`END_TURN 失败：${e.reason}`);
  return e.state;
};
const ctxOf = (s: GameState, u: Unit): UnitAiCtx => ({
  state: s,
  unit: u,
  def: s.unitTypes[u.type]!,
  api: abilityApi,
  candidates: [],
  rejected: new Set<string>(),
  foes: s.units.filter((x) => x.owner !== u.owner && x.hp > 0),
  allies: s.units.filter((x) => x.owner === u.owner && x.hp > 0),
});

console.log('「黑暗动乱」整包测试\n');

/* ── 1. 暗影领域：里面的人视野减半 ─────────────────────────────── */
section('1 暗影领域');
{
  const { s, mk } = arena();
  mk('lord', SHADOW_LORD, 'B', 10, 10);
  const inside = mk('in', 'militia', 'A', 10, 13);
  const outside = mk('out', 'militia', 'A', 10, 21);
  refreshShadow(s);
  check('暗影里的视野比外面小', visionOf(s, inside) < visionOf(s, outside), `${visionOf(s, inside)} / ${visionOf(s, outside)}`);
}

/* ── 2. 血系：伤害攒够就长淤血 ─────────────────────────────────── */
section('2 化血');
{
  const { s, mk } = arena();
  const pool = mk('pool', BLOOD_POOL, 'B', 5, 5);
  pool.custom = { blood: CLOT_DAMAGE };
  check('攒够就长出一滩新淤血', beginTurnOf(s, 'B').units.filter((u) => u.type === BLOOD_POOL).length === 2);

  const capped = arena();
  capped.mk('pool', BLOOD_POOL, 'B', 5, 5).custom = { blood: CLOT_DAMAGE * 10 };
  check('一回合最多两滩（不然一发溅射就雪崩）', beginTurnOf(capped.s, 'B').units.filter((u) => u.type === BLOOD_POOL).length === 3);
}

/* ── 3. 骨系：吞下 → 停一拍 → 变形 ────────────────────────────── */
section('3 寻躯');
{
  const { s, mk } = arena();
  mk('bone', BONE_SKELETON, 'B', 5, 5);
  mk('flesh', FLESH, 'B', 5, 6);
  const t1 = endTurnOf(s, 'B');
  check('第一回合末吞掉血肉', !t1.units.some((u) => u.id === 'flesh'));
  check('但当回合不变形（要停一拍）', t1.units.find((u) => u.id === 'bone')!.type === BONE_SKELETON);
  const t2 = endTurnOf(beginTurnOf(t1, 'B'), 'B');
  check('第二回合末变成尸骸', t2.units.find((u) => u.id === 'bone')!.type === BONE_SKELETON.replace('skeleton', 'corpse'));
}

/* ── 4. 不成系：黑蝗繁殖 / 无形 / 无形凝视 ─────────────────────── */
section('4 黑蝗与诡异');
{
  const { s, mk } = arena();
  mk('cocoon', BLACK_COCOON, 'B', 10, 10); // 提供暗影
  mk('l1', BLACK_LOCUST, 'B', 11, 10);
  mk('l2', BLACK_LOCUST, 'B', 12, 10);
  refreshShadow(s);
  const before = s.units.filter((u) => u.type === BLACK_LOCUST).length;
  check('条件满足就繁殖', endTurnOf(s, 'B').units.filter((u) => u.type === BLACK_LOCUST).length > before);

  const fog = arena();
  fog.s.fog = true;
  const un = fog.mk('un', UNNAMABLE, 'B', 10, 10);
  check('无形：没出手时对面看不见', isHiddenFrom(fog.s, un, 'A'));
  un.acted = true;
  check('出手之后现形', !isHiddenFrom(fog.s, un, 'A'));

  // 诡异在空中层：地面兵要射程 2 才够得着（处刑者正好是 2）
  const gaze = arena();
  const un2 = gaze.mk('un', UNNAMABLE, 'B', 10, 10);
  gaze.mk('hit', 'probe-killer', 'A', 10, 11);
  gaze.s.current = 'A';
  const hp0 = un2.hp;
  const r = applyAction(gaze.s, { type: 'ATTACK', unitId: 'hit', targetId: 'un' });
  check('没被它打过的人打它：这一下打空', r.ok && r.state.units.find((u) => u.id === 'un')!.hp === hp0, r.ok ? '' : r.reason);
}

/* ── 5. 卫系：残躯复活 / 留食 / 断传承 ────────────────────────── */
section('5 卫系');
{
  const { s, mk } = arena();
  const guard = mk('g', BRONZE_GUARD, 'B', 10, 10);
  guard.hp = 1;
  mk('killer', 'probe-killer', 'A', 10, 11);
  s.current = 'A';
  const r = applyAction(s, { type: 'ATTACK', unitId: 'killer', targetId: 'g' });
  check('机关倒下留一具残躯', r.ok && r.state.units.some((u) => u.type === 'puppet-wreck'), r.ok ? '' : r.reason);
  if (r.ok) {
    r.state.units.push({ id: 'sh', type: SHADE, owner: 'B', x: 11, y: 10, hp: 30, kills: 0, moved: false, acted: false } as Unit);
    const t = beginTurnOf(r.state, 'B');
    check('残躯吸到暗影后半血站回来', t.units.some((u) => u.type === BRONZE_GUARD && u.hp > 0));
  }

  const few = arena();
  few.mk('g', BRONZE_GUARD, 'B', 8, 8);
  for (let i = 0; i < 2; i += 1) few.mk(`eco${i}`, 'lumberjack', 'A', 9 + i, 8);
  few.s.current = 'B';
  const r2 = applyAction(few.s, { type: 'ATTACK', unitId: 'g', targetId: 'eco0' });
  check('视野里只剩 2 个经济单位：不肯下口', !r2.ok && r2.reason.includes('留食'), r2.ok ? '居然打了' : r2.reason);

  const raze = arena();
  // 城在 (0,0) 占 2×2；青铜卫射程 1，站在城外这一格才够得着
  raze.mk('g', BRONZE_GUARD, 'B', 2, 0);
  raze.s.cities.find((c) => c.id === 'ca')!.hp = 1;
  raze.s.current = 'B';
  const r3 = applyAction(raze.s, { type: 'SIEGE', unitId: 'g', cityId: 'ca' });
  check('破城时那座城掉一级', r3.ok && r3.state.cities.find((c) => c.id === 'ca')!.era === 5, r3.ok ? String(r3.state.cities.find((c) => c.id === 'ca')!.era) : r3.reason);
}

/* ── 6. 仆系：傀儡制造 / 勾魂 / 增生光环 ──────────────────────── */
section('6 仆系');
{
  const { s, mk } = arena();
  mk('maker', PUPPET_MASTER, 'B', 10, 10);
  let cur = s;
  for (let i = 0; i < 3; i += 1) cur = beginTurnOf(cur, 'B');
  check('傀儡师第 3 回合造出第一具', cur.units.filter((u) => u.type === BRONZE_GUARD).length === 1);

  const pull = arena();
  const hooker = pull.mk('h', SOUL_HOOKER, 'B', 10, 10);
  refreshShadow(pull.s);
  const victim = pull.mk('v', 'militia', 'A', 10, 13);
  const before = dist(victim, hooker);
  check('勾魂：没动过的人被拽过去', dist(endTurnOf(pull.s, 'A').units.find((u) => u.id === 'v')!, hooker) < before);

  const heal = arena();
  heal.mk('medic', BLOOD_MEDIC, 'B', 10, 10);
  heal.mk('tank', 'probe-killer', 'A', 11, 10).hp = 200;
  let h = beginTurnOf(heal.s, 'B');
  const tank = h.units.find((u) => u.id === 'tank')!;
  check('治疗的同时积下影蚀之血', tank.hp > 200 && Number(tank.custom?.shadowBlood ?? 0) > 0, `${tank.hp} / ${String(tank.custom?.shadowBlood)}`);
  let died = false;
  for (let i = 0; i < 30 && !died; i += 1) {
    h = beginTurnOf(h, 'B');
    died = !h.units.some((u) => u.id === 'tank');
  }
  check('污染积满后化成血肉与暗影', died && h.units.some((u) => u.type === FLESH) && h.units.some((u) => u.type === SHADE));
}

/* ── 7. 裔系：避城 / 归附 ─────────────────────────────────────── */
section('7 裔系');
{
  const { s, mk } = arena();
  mk('kid', KINDRED, 'B', 3, 3); // 要站在城的视野内（视野 6），不然它"看不见"
  s.cities.find((c) => c.id === 'ca')!.era = 3;
  const t = beginTurnOf(s, 'B');
  check('看到时代 ≤3 的敌城就进入撤离期', Number(t.units.find((u) => u.id === 'kid')!.custom?.retreatUntil ?? 0) > t.turn);

  const conv = arena();
  conv.mk('kid', KINDRED, 'B', 5, 5);
  let c = beginTurnOf(conv.s, 'B');
  c = beginTurnOf(c, 'B');
  check('场上没有仆系时，眷属两回合归附', c.units.find((u) => u.id === 'kid')!.type !== KINDRED);
}

/* ── 8. 骨灰罐与成帝碑 ───────────────────────────────────────── */
section('8 三件');
{
  const { s, mk } = arena();
  mk('urn', FUNERARY_URN, 'B', 10, 10);
  const em = mk('em', EMPEROR, 'B', 10, 11);
  em.custom = { lifespan: 200, dtInit: 1 };
  em.age = 199;
  abilityApi.killUnit(s, em, undefined, '测试');
  const born = s.units.find((u) => u.type === EMPEROR);
  check('仙帝倒下后从罐子里回来', !!born);
  check('回来时年龄清零、上限减半', (born?.age ?? -1) === 0 && born!.hp < (s.unitTypes[EMPEROR]?.maxHp ?? 0), `${String(born?.age)} 岁 / ${String(born?.hp)} 血`);

  const pol = arena();
  pol.mk('stele', IMPERIAL_STELE, 'B', 10, 10);
  pol.mk('v', 'militia', 'A', 10, 11);
  const t = beginTurnOf(pol.s, 'B');
  check('贴到碑边的兵变成诡异', !t.units.some((u) => u.id === 'v') && t.units.some((u) => u.type === BONE_UNNAMED));

  const immune = arena();
  immune.mk('stele', IMPERIAL_STELE, 'B', 10, 10);
  immune.mk('monk', 'militia', 'A', 10, 11).custom = { rank: 6 };
  check('六级修士免疫', beginTurnOf(immune.s, 'B').units.some((u) => u.id === 'monk'));

  const read = arena();
  read.mk('stele', IMPERIAL_STELE, 'B', 10, 10);
  read.mk('r', 'militia', 'A', 10, 11).custom = { rank: 6 };
  read.s.current = 'A';
  const r = applyAction(read.s, { type: 'UNIT_ACTION', unitId: 'r', actionId: 'read-stele' });
  check('读碑：境界 +1', r.ok && Number(r.state.units.find((u) => u.id === 'r')!.custom?.rank) === 7, r.ok ? '' : r.reason);
  if (r.ok) {
    let cur = r.state;
    for (let i = 0; i < 4; i += 1) cur = beginTurnOf(cur, 'A');
    check('三回合后死，原地站起红尘仙', !cur.units.some((u) => u.id === 'r') && cur.units.some((u) => u.type === MORTAL_IMMORTAL));
  }
}

/* ── 9. 仙帝：对标九级 / 出山返程 / 吞噬黑名单 ────────────────── */
section('9 仙帝');
{
  const { s } = arena();
  const em = s.unitTypes[EMPEROR]!;
  // 九级炼气士的总账：现算，不抄数字（修真包改公式这里会立刻知道）
  const r9 = {
    atk: 10 + realmAtkBase(9),
    armor: realmArmorBase(9),
    hp: 20 + totalHpBonusForRank(9),
    true: trueDamageForRank(9),
    attacks: 1 + extraAttacksForRank(9),
  };
  check(`血 ${em.maxHp} 超过九级修士 ${r9.hp}`, em.maxHp > r9.hp);
  check(`攻 ${em.atk} 超过九级修士 ${r9.atk}`, em.atk > r9.atk);
  check(`甲 ${em.armor} 超过九级修士 ${r9.armor}`, em.armor > r9.armor);
  check(`段数 ${em.burst ?? 1} 不少于九级修士 ${r9.attacks}`, (em.burst ?? 1) >= r9.attacks);

  // 出山：吃够就回家
  const back = arena();
  const e2 = back.mk('e', EMPEROR, 'B', 10, 10);
  e2.custom = { lifespan: 200, dtInit: 1, outTurns: 12, homeX: 20, homeY: 10 };
  e2.age = 135; // 寿元 65 ≥ 60
  back.mk('sl', SLUMBER, 'B', 20, 10);
  const out = unitAiProfileOf('emperor-cycle')!.handler(ctxOf(back.s, e2));
  check('寿元吃回 60 就回家', !!out.add?.some((x) => x.action.type === 'MOVE' || x.action.type === 'HERO_SKILL'), JSON.stringify(out.add));

  // 吞噬：骨灰罐不是食物
  const banned = arena();
  const be = banned.mk('be', EMPEROR, 'B', 10, 10);
  be.custom = { lifespan: 200, dtInit: 1 };
  be.age = 197;
  const urn = banned.mk('u', FUNERARY_URN, 'B', 11, 10);
  const hint = SKILL_AI_HINTS['soul-devour'];
  const ctx = {
    state: banned.s,
    unit: be,
    def: banned.s.unitTypes[EMPEROR]!,
    skill: banned.s.unitTypes[EMPEROR]!.skills!.find((k) => k.effect === 'soul-devour')!,
    api: abilityApi,
    foes: [],
    hpRatio: 1,
    allies: [be, urn],
  } as SkillAiCtx;
  check('饿死也不吞骨灰罐', !!hint && hint(ctx) === null);
}

/* ── 10. 关卡：结构（跑批在 test 的别处） ─────────────────────── */
section('10 关卡');
{
  const lv = LEVELS.find((l) => l.id === 'level:bone-sea');
  check('帝骸渡在关卡表里', !!lv);
  if (lv) {
    const s = createMatch({ ...DEFAULT_CONFIG, level: lv }, 2024);
    check('八座城、两家各四座', s.cities.filter((c) => c.owner === 'A').length === 4 && s.cities.filter((c) => c.owner === 'B').length === 4, String(s.cities.length));
    check('仙帝与沉眠地都在场上', s.units.some((u) => u.type === EMPEROR) && s.units.some((u) => u.type === SLUMBER));
  }
}

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
if (failed > 0) process.exit(1);
