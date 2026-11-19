/**
 * 仆从探针：卫系三只 + 四条跟城市/战斗纪律有关的词条。
 *
 * ── 它守什么 ────────────────────────────────────────────────────────
 *
 * 1. 「断传承」挂在**破城**（不是占领）上：砸开一座城 → 那座城掉一级；
 * 2. 「留食」：视野内敌方经济单位 ≤ 2 时不许打经济单位（纪律，不是偏好）；
 * 3. 「暗影驱动」+「重启」：机关倒下留残躯，残躯三格内吸到暗影就半血复活；
 * 4. 「衰鸣」：被打中的敌人陷入「虚弱」（移动与攻击各降 30%）；
 * 5. 仆从**不是**诡异：它们没有「痴愚」，能占城。
 *
 * 用法：npm run probe:servant
 */

import { createMatch, DEFAULT_CONFIG } from '../src/core/setup.ts';
import { applyAction } from '../src/core/rules.ts';
import {
  BRONZE_GUARD,
  DARK_TURMOIL,
  HORN_GUARD,
  PUPPET_WRECK,
  SHADE,
  SHADOW_GUARD,
} from '../src/core/dark-turmoil-packs.ts';
import type { City, GameState, PlayerId, Unit } from '../src/core/types.ts';

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
  size: 16,
  startEra: 6,
  expansionIds: [...DEFAULT_CONFIG.expansionIds, 'cultivation', 'dark-turmoil'],
};

interface Arena {
  s: GameState;
  mk: (id: string, type: string, owner: PlayerId, x: number, y: number) => Unit;
}

function arena(opts: { era?: number; ruined?: boolean } = {}): Arena & { city: City } {
  const s = createMatch(CONFIG, 7788);
  s.fog = false;
  s.units = [];
  s.marks = [];
  s.overlays = {};
  s.players.A.gold = 9999;
  s.players.B.gold = 9999;
  s.tiles = s.tiles.map(() => ({ terrain: 'plain' as const, cityId: null }));
  const city: City = {
    id: 'target',
    owner: 'B',
    x: 6,
    y: 6,
    size: 2,
    era: opts.era ?? 4,
    hp: opts.ruined ? 0 : 70,
    maxHp: 70,
    armor: 4,
    ruined: opts.ruined ?? false,
  };
  s.cities = [
    { id: 'ca', owner: 'A', x: 0, y: 0, size: 2, era: 6, hp: 70, maxHp: 70, armor: 4 },
    city,
  ];
  for (let dy = 0; dy < 2; dy += 1) {
    for (let dx = 0; dx < 2; dx += 1) {
      const t = s.tiles[(6 + dy) * s.w + (6 + dx)];
      if (t) t.cityId = 'target';
    }
  }
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
    atk: 300,
    range: 2,
    move: 2,
    armor: 4,
    maxHp: 400,
    skills: [],
    aiAutonomy: 0,
  };
  mk('keep-alive', 'militia', 'B', 0, 15);
  s.current = 'A';
  s.turn = 10;
  return { s, mk, city };
}

const beginTurnOf = (s: GameState, side: PlayerId): GameState => {
  const other: PlayerId = side === 'A' ? 'B' : 'A';
  if (s.current !== other) s.current = other;
  const e = applyAction(s, { type: 'END_TURN' });
  if (!e.ok) throw new Error(`END_TURN 失败：${e.reason}`);
  return e.state;
};

console.log('仆从探针\n');

/* ══════════════════════════════════════════════════════════════════
 * 1. 卫系三只
 * ══════════════════════════════════════════════════════════════════ */
console.log('[1] 卫系三只');
{
  const { s } = arena();
  const want = [
    [BRONZE_GUARD, '青铜卫', 140, 12],
    [SHADOW_GUARD, '暗影卫', 70, 14],
    [HORN_GUARD, '号卫', 110, 8],
  ] as const;
  for (const [id, label, hp, armor] of want) {
    const d = s.unitTypes[id];
    check(`${label}在表里`, !!d);
    check(`${label}血 ${hp} / 甲 ${armor}`, d?.maxHp === hp && d?.armor === armor, `${d?.maxHp}/${d?.armor}`);
    check(`${label}不可建造`, d?.summonedOnly === true);
    check(`${label}有自主性（0 < 自主分 < 1）`, (d?.aiAutonomy ?? 0) > 0 && (d?.aiAutonomy ?? 0) < 1);
    for (const ab of ['break-lineage', 'leave-food', 'shadow-drive']) {
      check(`${label}挂了「${ab}」`, (d?.abilities ?? []).includes(ab));
    }
    check(`${label}没有「痴愚」（它认城市）`, !(d?.abilities ?? []).includes('dull-wit'));
  }
  check(
    '暗影卫会飞、有暗影领域',
    s.unitTypes[SHADOW_GUARD]?.flight === true && (s.unitTypes[SHADOW_GUARD]?.shadowRadius ?? 0) > 0,
  );
  check('暗影卫能跳（自带暗影跳跃）', (s.unitTypes[SHADOW_GUARD]?.skills ?? []).some((k) => k.effect === 'shadow-step'));
  check('号卫射程 6、溅射 2', s.unitTypes[HORN_GUARD]?.range === 6 && s.unitTypes[HORN_GUARD]?.splash === 2);
  check('青铜卫视野 9（很广）', s.unitTypes[BRONZE_GUARD]?.vision === 9);
}

/* ══════════════════════════════════════════════════════════════════
 * 2. 断传承：砸开城（不是占领）
 * ══════════════════════════════════════════════════════════════════ */
console.log('\n[2] 断传承（破城时）');
{
  const { s, mk } = arena({ era: 4 });
  mk('guard', BRONZE_GUARD, 'A', 5, 6);
  const targetCity = s.cities.find((c) => c.id === 'target')!;
  targetCity.hp = 1; // 一炮就塌
  const r = applyAction(s, { type: 'SIEGE', unitId: 'guard', cityId: 'target' });
  check('这一炮打得出去', r.ok, r.ok ? '' : r.reason);
  if (r.ok) {
    const city = r.state.cities.find((c) => c.id === 'target')!;
    check('城变成了废墟', city.ruined === true);
    check('时代从 4 掉到 3', city.era === 3, String(city.era));
  }

  // 1 级的城不会再掉
  const low = arena({ era: 1 });
  low.mk('guard2', BRONZE_GUARD, 'A', 5, 6);
  low.s.cities.find((c) => c.id === 'target')!.hp = 1;
  const r2 = applyAction(low.s, { type: 'SIEGE', unitId: 'guard2', cityId: 'target' });
  const c2 = r2.ok ? r2.state.cities.find((c) => c.id === 'target')! : low.city;
  check('1 级的城不会再掉', r2.ok && c2.era === 1, String(c2.era));
}

/* ══════════════════════════════════════════════════════════════════
 * 3. 留食
 * ══════════════════════════════════════════════════════════════════ */
console.log('\n[3] 留食');
{
  // 视野内 3 个经济单位：可以打
  const many = arena();
  many.mk('guard', BRONZE_GUARD, 'A', 8, 8);
  for (let i = 0; i < 3; i += 1) many.mk(`eco${i}`, 'lumberjack', 'B', 9 + i, 8);
  many.s.current = 'A';
  const r1 = applyAction(many.s, { type: 'ATTACK', unitId: 'guard', targetId: 'eco0' });
  check('视野里有 3 个经济单位：照打', r1.ok, r1.ok ? '' : r1.reason);

  // 只剩 2 个：不许打
  const few = arena();
  few.mk('guard', BRONZE_GUARD, 'A', 8, 8);
  for (let i = 0; i < 2; i += 1) few.mk(`eco${i}`, 'lumberjack', 'B', 9 + i, 8);
  few.s.current = 'A';
  const r2 = applyAction(few.s, { type: 'ATTACK', unitId: 'guard', targetId: 'eco0' });
  check('只剩 2 个：不肯下口', !r2.ok, r2.ok ? '居然打了' : '');
  check('理由是「留食」', !r2.ok && r2.reason.includes('留食'), r2.ok ? '' : r2.reason);
  check('那只经济单位一点血都没掉', few.s.units.find((u) => u.id === 'eco0')!.hp === few.s.unitTypes['lumberjack']!.maxHp);

  // 打非经济单位仍然可以
  const other = arena();
  other.mk('guard', BRONZE_GUARD, 'A', 8, 8);
  other.mk('soldier', 'militia', 'B', 9, 8);
  other.s.current = 'A';
  const r3 = applyAction(other.s, { type: 'ATTACK', unitId: 'guard', targetId: 'soldier' });
  check('打普通兵不受影响', r3.ok, r3.ok ? '' : r3.reason);
}

/* ══════════════════════════════════════════════════════════════════
 * 4. 暗影驱动 / 重启
 * ══════════════════════════════════════════════════════════════════ */
console.log('\n[4] 暗影驱动');
{
  const { s, mk } = arena();
  const guard = mk('guard', BRONZE_GUARD, 'A', 5, 5);
  guard.hp = 1;
  mk('killer', 'probe-killer', 'B', 5, 6);
  s.current = 'B';
  const r = applyAction(s, { type: 'ATTACK', unitId: 'killer', targetId: 'guard' });
  check('机关被打倒', r.ok, r.ok ? '' : r.reason);
  if (r.ok) {
    const wrecks = r.state.units.filter((u) => u.type === PUPPET_WRECK);
    check('倒下后留下一具傀儡残躯', wrecks.length === 1, `${wrecks.length} 具`);
    check('残躯记得自己原来是青铜卫', wrecks[0]?.custom?.origin === BRONZE_GUARD, String(wrecks[0]?.custom?.origin));
    check('机关本体确实没了', !r.state.units.some((u) => u.id === 'guard'));

    // 三格内有暗影 → 吸干它、半血复活
    r.state.units.push({
      id: 'shade',
      type: SHADE,
      owner: 'A',
      x: 7,
      y: 5,
      hp: 30,
      kills: 0,
      moved: false,
      acted: false,
    } as Unit);
    const t = beginTurnOf(r.state, 'A');
    const back = t.units.filter((u) => u.type === BRONZE_GUARD);
    check('吸到暗影后重新站起来', back.length === 1, `${back.length} 个`);
    check(
      '半血复活',
      back[0] ? back[0].hp === Math.ceil((t.unitTypes[BRONZE_GUARD]?.maxHp ?? 1) / 2) : false,
      String(back[0]?.hp),
    );
    check('那团暗影被吸干了', !t.units.some((u) => u.id === 'shade'));
    check('残躯同时消失', !t.units.some((u) => u.type === PUPPET_WRECK));
  }

  // 没有暗影 → 残躯躺着不动
  const lonely = arena();
  const g2 = lonely.mk('guard', BRONZE_GUARD, 'A', 5, 5);
  g2.hp = 1;
  lonely.mk('killer', 'probe-killer', 'B', 5, 6);
  lonely.s.current = 'B';
  const r2 = applyAction(lonely.s, { type: 'ATTACK', unitId: 'killer', targetId: 'guard' });
  check('没有暗影时：残躯留着', r2.ok && r2.state.units.filter((u) => u.type === PUPPET_WRECK).length === 1);
  if (r2.ok) {
    const t2 = beginTurnOf(r2.state, 'A');
    check('残躯不会自己复活', t2.units.filter((u) => u.type === BRONZE_GUARD).length === 0);
  }
}

/* ══════════════════════════════════════════════════════════════════
 * 5. 衰鸣 / 虚弱
 * ══════════════════════════════════════════════════════════════════ */
console.log('\n[5] 衰鸣');
{
  const { s, mk } = arena();
  mk('horn', HORN_GUARD, 'A', 5, 5);
  const prey = mk('prey', 'militia', 'B', 5, 9);
  prey.hp = 999; // 别让它被一炮打死：这里要验的是"虚弱"，不是伤害
  s.current = 'A';
  const r = applyAction(s, { type: 'ATTACK', unitId: 'horn', targetId: 'prey' });
  check('号卫隔 4 格打得到（射程 6）', r.ok, r.ok ? '' : r.reason);
  if (r.ok) {
    const p = r.state.units.find((u) => u.id === 'prey')!;
    check('被打的人获得「虚弱」', (p.status?.weakness ?? 0) > 0, JSON.stringify(p.status));
  }
}

/* ══════════════════════════════════════════════════════════════════
 * 6. 面板
 * ══════════════════════════════════════════════════════════════════ */
console.log('\n[6] 面板');
{
  const { s, mk } = arena();
  const lines = (u: Unit): string => DARK_TURMOIL.hooks.getUnitPanelLines!({ state: s, unit: u }).join(' | ');
  const guard = mk('g', BRONZE_GUARD, 'A', 2, 2);
  check('青铜卫面板写了「断传承」「留食」「暗影驱动」', ['断传承', '留食', '暗影驱动'].every((k) => lines(guard).includes(k)), lines(guard));
  const horn = mk('h', HORN_GUARD, 'A', 2, 4);
  check('号卫面板写了「衰鸣」', lines(horn).includes('衰鸣'), lines(horn));
}

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
if (failed > 0) process.exit(1);
