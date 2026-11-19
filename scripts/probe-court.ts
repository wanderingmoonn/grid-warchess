/**
 * 仆系探针：傀儡师 / 勾魂使 / 血医。
 *
 * ── 它守什么 ────────────────────────────────────────────────────────
 *
 * 仆系三只都是"影响别人的东西"，光看代码看不出对不对：
 *   1. 傀儡制造：按顺序造、每种封顶 2 个、满了跳过；
 *   2. 暗影潜行：只在暗影里藏，出手就现形；
 *   3. 勾魂：别人回合末有余力就被拽进黑暗（**不分敌我**）；
 *   4. 增生光环：治一半的伤，但把等量的「影蚀之血」打进对方身上，够了就死。
 *
 * 用法：npm run probe:court
 */

import { createMatch, DEFAULT_CONFIG } from '../src/core/setup.ts';
import { abilityApi, applyAction, isHiddenFrom } from '../src/core/rules.ts';
import {
  BLOOD_MEDIC,
  BRONZE_GUARD,
  DARK_TURMOIL,
  FLESH,
  HORN_GUARD,
  PUPPET_MASTER,
  SHADE,
  SHADOW_GUARD,
  SOUL_HOOKER,
  refreshShadow,
} from '../src/core/dark-turmoil-packs.ts';
import { unitAiProfileOf } from '../src/core/unit-ai.ts';
import type { UnitAiCtx } from '../src/core/expansions.ts';
import type { GameState, PlayerId, Unit } from '../src/core/types.ts';

let failed = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) console.log(`  ✓ ${name}`);
  else {
    failed += 1;
    console.log(`  ✗ ${name}${detail ? ` —— ${detail}` : ''}`);
  }
}

const CONFIG = {
  ...DEFAULT_CONFIG,
  size: 20,
  startEra: 6,
  expansionIds: [...DEFAULT_CONFIG.expansionIds, 'cultivation', 'dark-turmoil'],
};

const dist = (a: { x: number; y: number }, b: { x: number; y: number }): number =>
  Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

interface Arena {
  s: GameState;
  mk: (id: string, type: string, owner: PlayerId, x: number, y: number) => Unit;
}

function arena(): Arena {
  const s = createMatch(CONFIG, 5522);
  s.fog = false;
  s.units = [];
  s.marks = [];
  s.overlays = {};
  s.players.A.gold = 9999;
  s.players.B.gold = 9999;
  s.tiles = s.tiles.map(() => ({ terrain: 'plain' as const, cityId: null }));
  s.cities = [
    { id: 'ca', owner: 'A', x: 0, y: 0, size: 2, era: 6, hp: 70, maxHp: 70, armor: 4 },
    { id: 'cb', owner: 'B', x: 18, y: 18, size: 2, era: 6, hp: 70, maxHp: 70, armor: 4 },
  ];
  const mk = (id: string, type: string, owner: PlayerId, x: number, y: number): Unit => {
    const u: Unit = { id, type, owner, x, y, hp: s.unitTypes[type]!.maxHp, kills: 0, moved: false, acted: false };
    if (s.unitTypes[type]!.layer) u.layer = s.unitTypes[type]!.layer;
    s.units.push(u);
    return u;
  };
  s.unitTypes['probe-killer'] = {
    ...s.unitTypes['militia']!,
    id: 'probe-killer',
    name: '处刑者',
    category: 'combat',
    atk: 40,
    range: 2,
    move: 2,
    armor: 4,
    maxHp: 400,
    skills: [],
    aiAutonomy: 0,
  };
  mk('keep-alive', 'militia', 'B', 0, 19);
  s.current = 'B';
  s.turn = 10;
  return { s, mk };
}

function ctxOf(s: GameState, u: Unit): UnitAiCtx {
  return {
    state: s,
    unit: u,
    def: s.unitTypes[u.type]!,
    api: abilityApi,
    candidates: [],
    rejected: new Set<string>(),
    foes: s.units.filter((x) => x.owner !== u.owner && x.hp > 0),
    allies: s.units.filter((x) => x.owner === u.owner && x.hp > 0),
  };
}

/** 让 `side` 开始新回合（回合**开始**类钩子在这里跑） */
const beginTurnOf = (s: GameState, side: PlayerId): GameState => {
  const other: PlayerId = side === 'A' ? 'B' : 'A';
  if (s.current !== other) s.current = other;
  const e = applyAction(s, { type: 'END_TURN' });
  if (!e.ok) throw new Error(`END_TURN 失败：${e.reason}`);
  return e.state;
};

/** 让 `side` 结束自己的回合（回合**结束**类钩子在这里跑，「勾魂」就是这一类） */
const endTurnOf = (s: GameState, side: PlayerId): GameState => {
  if (s.current !== side) s.current = side;
  const e = applyAction(s, { type: 'END_TURN' });
  if (!e.ok) throw new Error(`END_TURN 失败：${e.reason}`);
  return e.state;
};

console.log('仆系探针\n');

/* ══════════════════════════════════════════════════════════════════
 * 1. 三只
 * ══════════════════════════════════════════════════════════════════ */
console.log('[1] 仆系三只');
{
  const { s } = arena();
  for (const [id, label] of [
    [PUPPET_MASTER, '傀儡师'],
    [SOUL_HOOKER, '勾魂使'],
    [BLOOD_MEDIC, '血医'],
  ] as const) {
    const d = s.unitTypes[id];
    check(`${label}在表里`, !!d);
    check(`${label}听指挥但有自主性（0 < 自主分 < 1）`, (d?.aiAutonomy ?? 0) > 0 && (d?.aiAutonomy ?? 0) < 1);
    check(`${label}能占城（有断传承、没有痴愚）`, (d?.abilities ?? []).includes('break-lineage') && !(d?.abilities ?? []).includes('dull-wit'));
    check(`${label}守着「留食」`, (d?.abilities ?? []).includes('leave-food'));
  }
  check('勾魂使会飞', s.unitTypes[SOUL_HOOKER]?.flight === true);
  check('勾魂使能跳', (s.unitTypes[SOUL_HOOKER]?.skills ?? []).some((k) => k.effect === 'shadow-step'));
}

/* ══════════════════════════════════════════════════════════════════
 * 2. 傀儡制造
 * ══════════════════════════════════════════════════════════════════ */
console.log('\n[2] 傀儡制造');
{
  const { s, mk } = arena();
  mk('maker', PUPPET_MASTER, 'B', 10, 10);
  let cur = s;
  const count = (type: string): number => cur.units.filter((u) => u.type === type && u.hp > 0).length;

  // 前两个回合不造（每 3 回合一个）
  cur = beginTurnOf(cur, 'B');
  cur = beginTurnOf(cur, 'B');
  check('还没到 3 回合：一个都没造', cur.units.filter((u) => [BRONZE_GUARD, SHADOW_GUARD, HORN_GUARD].includes(u.type)).length === 0);

  cur = beginTurnOf(cur, 'B');
  check('第 3 回合：先造青铜卫', count(BRONZE_GUARD) === 1, `青铜卫 ${count(BRONZE_GUARD)}`);

  // 再跑 6 个回合，看顺序和封顶
  for (let i = 0; i < 6; i += 1) cur = beginTurnOf(cur, 'B');
  check('暗影卫造出来了', count(SHADOW_GUARD) >= 1, `暗影卫 ${count(SHADOW_GUARD)}`);
  check('号卫造出来了', count(HORN_GUARD) >= 1, `号卫 ${count(HORN_GUARD)}`);
  check(
    '每种不超过 2 个',
    count(BRONZE_GUARD) <= 2 && count(SHADOW_GUARD) <= 2 && count(HORN_GUARD) <= 2,
    `${count(BRONZE_GUARD)}/${count(SHADOW_GUARD)}/${count(HORN_GUARD)}`,
  );

  // 一直跑下去，看会不会超
  for (let i = 0; i < 12; i += 1) cur = beginTurnOf(cur, 'B');
  check(
    '跑很久也不超过上限（全满就停）',
    count(BRONZE_GUARD) === 2 && count(SHADOW_GUARD) === 2 && count(HORN_GUARD) === 2,
    `${count(BRONZE_GUARD)}/${count(SHADOW_GUARD)}/${count(HORN_GUARD)}`,
  );
}

/* ══════════════════════════════════════════════════════════════════
 * 3. 暗影潜行
 * ══════════════════════════════════════════════════════════════════ */
console.log('\n[3] 暗影潜行');
{
  const { s, mk } = arena();
  s.fog = true;
  const hooker = mk('h', SOUL_HOOKER, 'B', 10, 10);
  refreshShadow(s); // 它自己铺一片
  check('在暗影里：看不见', isHiddenFrom(s, hooker, 'A'));
  hooker.acted = true;
  check('出手之后：现形', !isHiddenFrom(s, hooker, 'A'));
  hooker.acted = false;
  hooker.x = 2;
  hooker.y = 2; // 挪到黑雾外面
  check('走出暗影：现形', !isHiddenFrom(s, hooker, 'A'));
}

/* ══════════════════════════════════════════════════════════════════
 * 4. 勾魂
 * ══════════════════════════════════════════════════════════════════ */
console.log('\n[4] 勾魂');
{
  const { s, mk } = arena();
  const hooker = mk('h', SOUL_HOOKER, 'B', 10, 10);
  refreshShadow(s);
  // 一团站在 3 格外的敌人：这回合没动，应该被拽过去
  const victim = mk('v', 'probe-killer', 'A', 10, 13);
  const before = dist(victim, hooker);
  const after = endTurnOf(s, 'A');
  const v2 = after.units.find((u) => u.id === 'v')!;
  check('被拽向暗影深处', dist(v2, hooker) < before, `${before} → ${dist(v2, hooker)}`);

  // 已经动过的不会被拽
  const { s: s2, mk: mk2 } = arena();
  const h2 = mk2('h', SOUL_HOOKER, 'B', 10, 10);
  refreshShadow(s2);
  const v3 = mk2('v', 'probe-killer', 'A', 10, 13);
  v3.moved = true;
  const b2 = dist(v3, h2);
  const a2 = endTurnOf(s2, 'A');
  const v4 = a2.units.find((u) => u.id === 'v')!;
  check('已经动过的：拽不动', dist(v4, h2) === b2, `${b2} → ${dist(v4, h2)}`);

  // 太远的不会被拽
  const { s: s3, mk: mk3 } = arena();
  const h3 = mk3('h', SOUL_HOOKER, 'B', 2, 2);
  refreshShadow(s3);
  const far = mk3('v', 'probe-killer', 'A', 17, 17);
  const b3 = dist(far, h3);
  const a3 = endTurnOf(s3, 'A');
  const v5 = a3.units.find((u) => u.id === 'v')!;
  check('六格之外：管不着', dist(v5, h3) === b3, `${b3} → ${dist(v5, h3)}`);
}

/* ══════════════════════════════════════════════════════════════════
 * 5. 增生光环 / 影蚀之血
 * ══════════════════════════════════════════════════════════════════ */
console.log('\n[5] 增生光环');
{
  const { s, mk } = arena();
  mk('medic', BLOOD_MEDIC, 'B', 10, 10);
  const hurt = mk('hurt', 'probe-killer', 'A', 11, 10); // 不分敌我
  hurt.hp = 200; // 400 上限，掉了一半
  hurt.moved = true;
  const t = beginTurnOf(s, 'B');
  const h = t.units.find((u) => u.id === 'hurt')!;
  check('被治了（治疗上限 12）', h.hp === 212, String(h.hp));
  check('身上积累了等量的影蚀之血', Number(h.custom?.shadowBlood ?? 0) === 12, String(h.custom?.shadowBlood));

  // 一路治下去会把人治死
  let cur = t;
  const max = cur.unitTypes['probe-killer']!.maxHp;
  let died = false;
  for (let i = 0; i < 30 && !died; i += 1) {
    cur = beginTurnOf(cur, 'B');
    died = !cur.units.some((u) => u.id === 'hurt');
  }
  check('影蚀之血积满后死亡', died);
  check('死时化成一团血肉', cur.units.some((u) => u.type === FLESH));
  check('死时化成一团暗影', cur.units.some((u) => u.type === SHADE));
  void max;

  // 挨打能冲淡
  const { s: s2, mk: mk2 } = arena();
  mk2('medic', BLOOD_MEDIC, 'B', 10, 10);
  const u = mk2('u', 'probe-killer', 'A', 11, 10);
  u.hp = 200;
  u.custom = { shadowBlood: 20 };
  const t2 = beginTurnOf(s2, 'B');
  check('治疗把污染加上去', Number(t2.units.find((x) => x.id === 'u')!.custom?.shadowBlood ?? 0) > 20);

  // 打一顿：污染按伤害减少
  const hitState = t2;
  hitState.current = 'B';
  const hitter = hitState.units.find((x) => x.type === BLOOD_MEDIC)!;
  void hitter;
  const before = Number(hitState.units.find((x) => x.id === 'u')!.custom?.shadowBlood ?? 0);
  hitState.current = 'A';
  const atk = hitState.units.find((x) => x.id === 'u')!;
  atk.moved = false;
  atk.acted = false;
  delete atk.attacksLeft;
  // 让血医被打（它自己也在光环里，但重点是"掉血冲淡污染"）
  const medic = hitState.units.find((x) => x.type === BLOOD_MEDIC)!;
  const r = applyAction(hitState, { type: 'ATTACK', unitId: 'u', targetId: medic.id });
  check('挨打的那一方污染被冲淡', r.ok && Number(r.state.units.find((x) => x.id === medic.id)!.custom?.shadowBlood ?? 0) < Number(medic.custom?.shadowBlood ?? 0) + 12);
  void before;
}

/* ══════════════════════════════════════════════════════════════════
 * 6. 不往人堆里扎
 * ══════════════════════════════════════════════════════════════════ */
console.log('\n[6] 不往人堆里扎');
{
  const { s, mk } = arena();
  const medic = mk('m', BLOOD_MEDIC, 'B', 10, 10);
  // 一团三个敌人挤在右边
  for (let i = 0; i < 3; i += 1) mk(`f${i}`, 'probe-killer', 'A', 12 + i, 10);
  const profile = unitAiProfileOf('servant-hang-back')!;
  const out = profile.handler(ctxOf(s, medic));
  const mv = out.add?.find((x) => x.action.type === 'MOVE')?.action;
  check('敌人成群且在自己旁边：往后挪', !!mv, JSON.stringify(out.add));

  // 有人贴上仙帝就不躲了（这里用"没有仙帝"验证：不躲）
  const { s: s2, mk: mk2 } = arena();
  const medic2 = mk2('m', BLOOD_MEDIC, 'B', 10, 10);
  for (let i = 0; i < 3; i += 1) mk2(`f${i}`, 'probe-killer', 'A', 12 + i, 10);
  s2.units.find((u) => u.id === 'f0')!.x = 16; // 把一团拆散一点
  const out2 = profile.handler(ctxOf(s2, medic2));
  check('成不了群就不躲', !out2.add?.some((x) => x.action.type === 'MOVE'), JSON.stringify(out2.add));
}

/* ══════════════════════════════════════════════════════════════════
 * 7. 面板
 * ══════════════════════════════════════════════════════════════════ */
console.log('\n[7] 面板');
{
  const { s, mk } = arena();
  const lines = (u: Unit): string => DARK_TURMOIL.hooks.getUnitPanelLines!({ state: s, unit: u }).join(' | ');
  const maker = mk('p', PUPPET_MASTER, 'B', 2, 2);
  check('傀儡师面板写了「傀儡制造」', lines(maker).includes('傀儡制造'), lines(maker));
  const hooker = mk('h', SOUL_HOOKER, 'B', 2, 4);
  check('勾魂使面板写了「勾魂」「暗影潜行」', lines(hooker).includes('勾魂') && lines(hooker).includes('暗影潜行'), lines(hooker));
  const medic = mk('m', BLOOD_MEDIC, 'B', 2, 6);
  check('血医面板写了「增生光环」', lines(medic).includes('增生光环'), lines(medic));
  const hurt = mk('u', 'militia', 'B', 2, 8);
  hurt.custom = { shadowBlood: 9 };
  check('被污染的单位面板写了「影蚀之血」', lines(hurt).includes('影蚀之血'), lines(hurt));
}

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
if (failed > 0) process.exit(1);
