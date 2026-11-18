/**
 * 血系探针。
 *
 * ── 它守什么 ────────────────────────────────────────────────────────
 *
 * 四条机制：化血（伤害攒够长出淤血）、侵染（击杀变血肉）、汲取（按伤害回血）、
 * 增生（血核满血时剥出血肉）。外加三个兵的目标偏好和走位。
 *
 * 这些全是**副作用**，不像技能那样有按钮可点，所以必须在这里逐条验——
 * 实机上"没生效"和"生效了但很慢"看起来一模一样，玩家分不出来。
 *
 * 用法：npm run probe:blood
 */

import { createMatch, DEFAULT_CONFIG } from '../src/core/setup.ts';
import { abilityApi, applyAction } from '../src/core/rules.ts';
import {
  BLOOD_CORE,
  BLOOD_POOL,
  CLOT_DAMAGE,
  FLESH,
  GROW_TURNS,
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
  const s = createMatch(CONFIG, 8811);
  s.fog = false;
  s.units = [];
  s.marks = [];
  s.overlays = {};
  s.players.A.gold = 0;
  s.players.B.gold = 0;
  s.tiles = s.tiles.map(() => ({ terrain: 'plain' as const, cityId: null }));
  s.cities = [
    { id: 'ca', owner: 'A', x: 0, y: 0, size: 2, era: 6, hp: 70, maxHp: 70, armor: 4 },
    { id: 'cb', owner: 'B', x: 18, y: 18, size: 2, era: 6, hp: 70, maxHp: 70, armor: 4 },
  ];
  const mk = (id: string, type: string, owner: PlayerId, x: number, y: number): Unit => {
    const u: Unit = { id, type, owner, x, y, hp: s.unitTypes[type]!.maxHp, kills: 0, moved: false, acted: false };
    s.units.push(u);
    return u;
  };
  // 靶子：甲可以调，用来验"汲取按伤害回血""血肉挑薄甲"
  for (const a of [0, 2, 20, 999]) {
    s.unitTypes[`probe-tank-${a}`] = {
      ...s.unitTypes['militia']!,
      id: `probe-tank-${a}`,
      name: `靶子${a}`,
      category: 'combat',
      atk: 0,
      range: 0,
      move: 0,
      armor: a,
      maxHp: 999,
      skills: [],
      aiAutonomy: 0,
    };
  }
  /*
   * 远处留一个 A 方的活口。
   *
   * 不然后果很实在：场上只有 B 的兵时，交一次棒引擎就判"对面没了"→ 胜者 B，
   * 之后再怎么 applyAction 全是"对局已结束"。凡是"要推进回合"的用例都会被这个坑噎住。
   * 放在角落、血厚、不动，不干扰任何一条断言。
   */
  mk('keep-alive', 'probe-tank-20', 'A', 0, 19);
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

/**
 * 让 `player` 这一方的兵走到"回合开始"。
 *
 * 2026-11-18 能力化之后，化血/增生/化影都挂成**能力的 onTurnStart**，
 * 只有在真的交棒时才会跑——直接调扩展钩子已经调不到它们了。
 * 所以这里必须走一次真的 END_TURN（从对面交过来）。
 */
const startTurnOf = (s: GameState, player: PlayerId): GameState => {
  /*
   * 一律从"对面"交棒过来。
   * 不能写成"已经是它的回合就直接返回"——那样什么都不会发生（能力要的是
   * 一次真正的交棒），第一次踩这个坑时表现为"化血一次都没长"。
   */
  const other: PlayerId = player === 'A' ? 'B' : 'A';
  if (s.current !== other) s.current = other;
  const e = applyAction(s, { type: 'END_TURN' });
  if (!e.ok) throw new Error(`END_TURN 失败：${e.reason}`);
  return e.state;
};

console.log('血系探针\n');

/* ══════════════════════════════════════════════════════════════════
 * 1. 三个兵
 * ══════════════════════════════════════════════════════════════════ */
console.log('[1] 三个兵');
{
  const { s } = arena();
  for (const [id, label, radius] of [
    [BLOOD_POOL, '淤血', 1],
    [FLESH, '血肉', 1],
    [BLOOD_CORE, '血核', 4],
  ] as const) {
    const d = s.unitTypes[id];
    check(`${label}在表里`, !!d);
    check(`${label}不可建造`, d?.summonedOnly === true);
    check(`${label}有暗影半径 ${radius}`, d?.shadowRadius === radius, String(d?.shadowRadius));
    check(`${label}不听指挥（自主分 > 0）`, (d?.aiAutonomy ?? 0) > 0);
    check(`${label}不带属性（属性是奇想包的规则）`, !d?.element && !d?.weak && !d?.resist);
  }
  check('淤血一回合 3 段', s.unitTypes[BLOOD_POOL]?.burst === 3, String(s.unitTypes[BLOOD_POOL]?.burst));
  check('血核有两格溅射', s.unitTypes[BLOOD_CORE]?.splash === 2, String(s.unitTypes[BLOOD_CORE]?.splash));
  /*
   * 血肉和血核**必须挂「暗蚀」这条能力**，不能只靠面板手写一行。
   * 2026-11-18 的实机反馈：规则书里查不到它们的暗蚀——因为能力根本没挂上，
   * 面板上的"暗蚀 5 点"是骗人的（伤害里根本没有这一段）。
   */
  for (const [id, label] of [
    [FLESH, '血肉'],
    [BLOOD_CORE, '血核'],
  ] as const) {
    check(`${label}挂了「暗蚀」能力（不是只写在面板上）`, (s.unitTypes[id]?.abilities ?? []).includes('shadow-erosion'));
  }
}

/* ══════════════════════════════════════════════════════════════════
 * 2. 化血：伤害攒够 → 长出淤血
 * ══════════════════════════════════════════════════════════════════ */
console.log('\n[2] 化血');
{
  const { s, mk } = arena();
  const pool = mk('pool', BLOOD_POOL, 'B', 5, 5);
  const tgt = mk('t', 'probe-tank-0', 'A', 5, 6);
  const r = applyAction(s, { type: 'ATTACK', unitId: pool.id, targetId: tgt.id });
  check('打了一下', r.ok, r.ok ? '' : r.reason);
  if (r.ok) {
    const after = r.state.units.find((u) => u.id === 'pool')!;
    const blood = Number(after.custom?.blood ?? 0);
    check('伤害被记成"血"（14 攻 × 1 段）', blood === 14, String(blood));
    check('还没攒够，不长东西', !r.state.units.some((u) => u.id !== 'pool' && u.type === BLOOD_POOL));
  }

  // 直接把血攒满，走一次回合开始
  const { s: s2, mk: mk2 } = arena();
  const pool2 = mk2('pool', BLOOD_POOL, 'B', 5, 5);
  pool2.custom = { blood: CLOT_DAMAGE };
  const after2 = startTurnOf(s2, 'B');
  const born = after2.units.filter((u) => u.type === BLOOD_POOL);
  check(`攒够 ${CLOT_DAMAGE} 点：长出一滩新的淤血`, born.length === 2, `${born.length} 滩`);
  check('计数清零', Number(after2.units.find((u) => u.id === 'pool')?.custom?.blood ?? 0) === 0);

  // 一回合最多长两滩（防止一次溅射打五个兵就长五滩）
  const { s: s3, mk: mk3 } = arena();
  const pool3 = mk3('pool', BLOOD_POOL, 'B', 5, 5);
  pool3.custom = { blood: CLOT_DAMAGE * 10 };
  const after3 = startTurnOf(s3, 'B');
  check(
    '一回合最多两滩（不然会雪崩）',
    after3.units.filter((u) => u.type === BLOOD_POOL).length === 3,
    `${after3.units.filter((u) => u.type === BLOOD_POOL).length} 滩`,
  );
}

/* ══════════════════════════════════════════════════════════════════
 * 2b. 血肉 / 血核的暗蚀真的打得出去（不是面板上写着好看）
 * ══════════════════════════════════════════════════════════════════ */
console.log('\n[2b] 血肉与血核的暗蚀');
{
  const wall = (attacker: string, expect: number): void => {
    const { s, mk } = arena();
    const a = mk('a', attacker, 'B', 5, 5);
    const t = mk('t', 'probe-tank-999', 'A', 5, 6); // 999 甲：物理被吃光，只剩暗蚀
    t.hp = 999;
    const r = applyAction(s, { type: 'ATTACK', unitId: a.id, targetId: t.id });
    const after = r.ok ? r.state.units.find((u) => u.id === 't')!.hp : 999;
    check(`${attacker} 打 999 甲：只剩暗蚀 ${expect} 点`, r.ok && 999 - after === expect, `${999 - after} 点`);
  };
  wall(FLESH, 5);
  wall(BLOOD_CORE, 12);
}

/* ══════════════════════════════════════════════════════════════════
 * 3. 汲取：按伤害回血
 * ══════════════════════════════════════════════════════════════════ */
console.log('\n[3] 汲取');
{
  const { s, mk } = arena();
  const flesh = mk('flesh', FLESH, 'B', 5, 5);
  flesh.hp = 40;
  const tgt = mk('t', 'probe-tank-0', 'A', 5, 6);
  const r = applyAction(s, { type: 'ATTACK', unitId: flesh.id, targetId: tgt.id });
  check('打得出去', r.ok, r.ok ? '' : r.reason);
  if (r.ok) {
    const after = r.state.units.find((u) => u.id === 'flesh')!;
    const hurt = r.state.units.find((u) => u.id === 't')!;
    const dealt = 999 - hurt.hp;
    check('打出去多少就回多少', after.hp === 40 + dealt, `回了 ${after.hp - 40}，实际伤害 ${dealt}`);
  }

  // 淤血没有汲取
  const { s: s2, mk: mk2 } = arena();
  const pool = mk2('pool', BLOOD_POOL, 'B', 5, 5);
  pool.hp = 20;
  const tgt2 = mk2('t', 'probe-tank-0', 'A', 5, 6);
  const r2 = applyAction(s2, { type: 'ATTACK', unitId: pool.id, targetId: tgt2.id });
  check(
    '淤血不回血（汲取只有血肉和血核有）',
    r2.ok && r2.state.units.find((u) => u.id === 'pool')!.hp === 20,
    r2.ok ? String(r2.state.units.find((u) => u.id === 'pool')!.hp) : r2.reason,
  );
}

/* ══════════════════════════════════════════════════════════════════
 * 4. 侵染：击杀 → 血肉
 * ══════════════════════════════════════════════════════════════════ */
console.log('\n[4] 侵染');
{
  const { s, mk } = arena();
  const flesh = mk('flesh', FLESH, 'B', 5, 5);
  const prey = mk('prey', 'probe-tank-0', 'A', 5, 6);
  prey.hp = 3;
  const r = applyAction(s, { type: 'ATTACK', unitId: flesh.id, targetId: prey.id });
  check('这一刀打得出去', r.ok, r.ok ? '' : r.reason);
  if (r.ok) {
    const born = r.state.units.filter((u) => u.type === FLESH && u.id !== 'flesh');
    check('尸体变成血肉', born.length === 1, `${born.length} 团`);
    check('长在尸体那一格', born[0]?.x === 5 && born[0]?.y === 6, `${born[0]?.x},${born[0]?.y}`);
  }

  /*
   * 谁生蚀影，看的是**有没有「暗影侵蚀」这条词条**，不是"是不是暗影"。
   * 2026-11-18 之后影主也挂了这条，所以影主杀人同样生；蚀影没挂，就不生。
   */
  const { s: s2, mk: mk2 } = arena();
  const lord = mk2('lord', 'shadow-lord', 'B', 5, 5);
  const prey2 = mk2('prey2', 'probe-tank-0', 'A', 5, 6);
  prey2.hp = 3;
  const r2 = applyAction(s2, { type: 'ATTACK', unitId: lord.id, targetId: prey2.id });
  check('影主也带「暗影侵蚀」：它杀人同样生蚀影', r2.ok && r2.state.units.some((u) => u.type === 'shadow-beast'));

  /*
   * 没挂「暗影侵蚀」的兵杀人不生蚀影。
   * 2026-11-18 之后连蚀影都有这条了，所以拿一团血肉当凶手（它挂的是「侵染」）。
   */
  const { s: s3, mk: mk3 } = arena();
  const beast = mk3('beast', FLESH, 'B', 5, 5);
  const prey3 = mk3('prey3', 'probe-tank-0', 'A', 5, 6);
  prey3.hp = 3;
  const r3 = applyAction(s3, { type: 'ATTACK', unitId: beast.id, targetId: prey3.id });
  check(
    '没挂「暗影侵蚀」的兵杀人不生蚀影（血肉只长血肉）',
    r3.ok && !r3.state.units.some((u) => u.type === 'shadow-beast'),
  );
}

/* ══════════════════════════════════════════════════════════════════
 * 5. 增生：血核满血攒回合 → 剥出血肉
 * ══════════════════════════════════════════════════════════════════ */
console.log('\n[5] 增生');
{
  const { s, mk } = arena();
  mk('core', BLOOD_CORE, 'B', 5, 5);
  // 每"自己的回合开始"算一回合：把 current 在两家之间倒一次
  let cur = s;
  const turnOnce = (): void => {
    cur.current = 'A';
    cur = startTurnOf(cur, 'B');
  };
  for (let i = 0; i < GROW_TURNS - 1; i += 1) turnOnce();
  check(
    `满血攒 ${GROW_TURNS - 1} 回合还不长（要 ${GROW_TURNS} 回合）`,
    !cur.units.some((u) => u.type === FLESH),
    String(cur.units.find((u) => u.id === 'core')?.custom?.grow),
  );
  turnOnce();
  check(`第 ${GROW_TURNS} 回合剥出一团血肉`, cur.units.filter((u) => u.type === FLESH).length === 1);
  check('计数归零', Number(cur.units.find((u) => u.id === 'core')?.custom?.grow ?? 0) === 0);

  // 不满血就不攒
  const { s: s2, mk: mk2 } = arena();
  const core2 = mk2('core', BLOOD_CORE, 'B', 5, 5);
  core2.hp = 100;
  let cur2 = s2;
  for (let i = 0; i < GROW_TURNS + 1; i += 1) {
    cur2.current = 'A';
    cur2 = startTurnOf(cur2, 'B');
  }
  const healed = cur2.units.find((u) => u.id === 'core')!.hp;
  check('一直不满血：回血但不剥东西', !cur2.units.some((u) => u.type === FLESH) && healed > 100, `血 ${healed}`);
}

/* ══════════════════════════════════════════════════════════════════
 * 6. 目标偏好
 * ══════════════════════════════════════════════════════════════════ */
console.log('\n[6] 目标偏好');
{
  // 淤血：优先咬经济单位
  {
    const { s, mk } = arena();
    const pool = mk('pool', BLOOD_POOL, 'B', 5, 5);
    mk('soldier', 'probe-tank-0', 'A', 5, 6); // 近的普通兵
    const eco = mk('eco', 'lumberjack', 'A', 6, 5);
    eco.hp = 30;
    const out = unitAiProfileOf('blood-pool-seek')!.handler(ctxOf(s, pool));
    const atk = out.add?.find((x) => x.action.type === 'ATTACK')?.action;
    check('淤血优先打经济单位', atk?.type === 'ATTACK' && (atk as { targetId: string }).targetId === 'eco', JSON.stringify(atk));
  }
  // 血肉：打护甲薄的
  {
    const { s, mk } = arena();
    const flesh = mk('flesh', FLESH, 'B', 5, 5);
    const thick = mk('thick', 'probe-tank-20', 'A', 5, 6);
    const thin = mk('thin', 'probe-tank-0', 'A', 6, 5);
    thick.hp = 999; thin.hp = 999;
    const out = unitAiProfileOf('flesh-away-core')!.handler(ctxOf(s, flesh));
    const atk = out.add?.find((x) => x.action.type === 'ATTACK')?.action;
    check('血肉挑护甲薄的', atk?.type === 'ATTACK' && (atk as { targetId: string }).targetId === 'thin', JSON.stringify(atk));
  }
  // 血核：打威胁最大的
  {
    const { s, mk } = arena();
    const core = mk('core', BLOOD_CORE, 'B', 5, 5);
    s.unitTypes['probe-heavy'] = {
      ...s.unitTypes['militia']!,
      id: 'probe-heavy',
      name: '重炮',
      category: 'combat',
      atk: 200,
      range: 5,
      move: 0,
      armor: 2,
      maxHp: 200,
      skills: [],
    };
    mk('weak', 'probe-tank-0', 'A', 5, 6);
    const strong = mk('strong', 'probe-heavy', 'A', 6, 5);
    strong.hp = 200;
    const out = unitAiProfileOf('blood-core-deep')!.handler(ctxOf(s, core));
    const atk = out.add?.find((x) => x.action.type === 'ATTACK')?.action;
    check('血核打威胁最大的', atk?.type === 'ATTACK' && (atk as { targetId: string }).targetId === 'strong', JSON.stringify(atk));
  }
}

/* ══════════════════════════════════════════════════════════════════
 * 7. 走位
 * ══════════════════════════════════════════════════════════════════ */
console.log('\n[7] 走位');
{
  // 淤血往血肉那边凑
  {
    const { s, mk } = arena();
    const pool = mk('pool', BLOOD_POOL, 'B', 2, 2);
    const flesh = mk('flesh', FLESH, 'B', 12, 2);
    const out = unitAiProfileOf('blood-pool-seek')!.handler(ctxOf(s, pool));
    const move = out.add?.find((x) => x.action.type === 'MOVE')?.action;
    check('淤血朝血肉靠', move?.type === 'MOVE' && dist({ x: move.x, y: move.y }, flesh) < dist(pool, flesh), JSON.stringify(move));
  }
  // 血肉离血核远一点
  {
    const { s, mk } = arena();
    const core = mk('core', BLOOD_CORE, 'B', 10, 10);
    const flesh = mk('flesh', FLESH, 'B', 10, 11);
    const out = unitAiProfileOf('flesh-away-core')!.handler(ctxOf(s, flesh));
    const move = out.add?.find((x) => x.action.type === 'MOVE')?.action;
    check('血肉离血核远一点', move?.type === 'MOVE' && dist({ x: move.x, y: move.y }, core) > dist(flesh, core), JSON.stringify(move));
  }
  /*
   * 散开：两团血肉挤在一起时，走的那一团要**同时**离血核和同伴更远。
   * 2026-11-18 的 bug：只按"离血核最远"选点，对每团血肉都是同一个全局最优，
   * 于是它们全往同一个角上跑——表现是"越散越挤"。
   */
  {
    const { s, mk } = arena();
    const core = mk('core', BLOOD_CORE, 'B', 10, 10);
    const a = mk('flesh-a', FLESH, 'B', 10, 11);
    const b = mk('flesh-b', FLESH, 'B', 11, 11);
    const out = unitAiProfileOf('flesh-away-core')!.handler(ctxOf(s, a));
    const move = out.add?.find((x) => x.action.type === 'MOVE')?.action;
    const next = move && move.type === 'MOVE' ? { x: move.x, y: move.y } : null;
    check(
      '两团血肉挤在一起时，走的那团同离血核和同伴更远',
      !!next && dist(next, core) > dist(a, core) && dist(next, b) > dist(a, b),
      next ? `离核 ${dist(a, core)}→${dist(next, core)}，离同伴 ${dist(a, b)}→${dist(next, b)}` : JSON.stringify(out.add),
    );
  }
  // 血核往暗影深处走
  {
    const { s, mk } = arena();
    const core = mk('core', BLOOD_CORE, 'B', 10, 10);
    refreshShadow(s); // 这片暗影以血核为中心
    core.x = 2;
    core.y = 2;
    const out = unitAiProfileOf('blood-core-deep')!.handler(ctxOf(s, core));
    const move = out.add?.find((x) => x.action.type === 'MOVE')?.action;
    check(
      '血核往暗影深处挪',
      move?.type === 'MOVE' && dist({ x: move.x, y: move.y }, { x: 10, y: 10 }) < dist(core, { x: 10, y: 10 }),
      JSON.stringify(move),
    );
  }
}

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
if (failed > 0) process.exit(1);
