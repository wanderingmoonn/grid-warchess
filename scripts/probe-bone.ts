/**
 * 骨系探针。
 *
 * ── 它守什么 ────────────────────────────────────────────────────────
 *
 * 骨系是唯一"能造出前两系列"的一支，六条能力全是副作用：
 *   寻躯 / 复苏（回合末吞噬变形）、腾空（打完起飞）、拼装 / 解离（死后掉零件）、
 *   点化（击杀现场拼队伍）。
 *
 * 这些在实机上最难验——"没生效"和"生效了但时机不对"看起来一模一样。
 * 所以这里逐条用手搭局面问，尤其要**跑真的回合结束**（能力钩子挂在 onTurnEnd 上）。
 *
 * 用法：npm run probe:bone
 */

import { createMatch, DEFAULT_CONFIG } from '../src/core/setup.ts';
import { abilityApi, applyAction } from '../src/core/rules.ts';
import {
  BONE_CORPSE,
  BONE_SKELETON,
  BONE_UNNAMED,
  EMPEROR,
  FLESH,
  SHADE,
  BLOOD_POOL,
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
  const s = createMatch(CONFIG, 9911);
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
  for (const a of [0, 999]) {
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
  // 远处留一个活口：不然交棒就判"对面没了"，后面全是对局已结束
  mk('keep-alive', 'probe-tank-999', 'A', 0, 19);
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

/** 让 `side` 这一方**结束**一个回合（能力的 onTurnEnd 会在这里跑） */
const endTurnOf = (s: GameState, side: PlayerId): GameState => {
  if (s.current !== side) s.current = side;
  const e = applyAction(s, { type: 'END_TURN' });
  if (!e.ok) throw new Error(`END_TURN 失败：${e.reason}`);
  return e.state;
};

/**
 * 让 `side` 这一方**开始**一个新的回合（能力的 onTurnStart 会在这里跑）。
 *
 * 和 `endTurnOf` 是两回事，别混：结束 B 的回合只会开启 A 的回合，
 * B 的回合开始钩子要等 A 交棒。第一版拿 `endTurnOf` 当 `beginTurnOf` 用，
 * 表现成"凝结期间没有锁住移动"。
 */
const beginTurnOf = (s: GameState, side: PlayerId): GameState => {
  const other: PlayerId = side === 'A' ? 'B' : 'A';
  if (s.current !== other) s.current = other;
  const e = applyAction(s, { type: 'END_TURN' });
  if (!e.ok) throw new Error(`END_TURN 失败：${e.reason}`);
  return e.state;
};

console.log('骨系探针\n');

/* ══════════════════════════════════════════════════════════════════
 * 1. 三个兵
 * ══════════════════════════════════════════════════════════════════ */
console.log('[1] 三个兵');
{
  const { s } = arena();
  for (const [id, label, radius] of [
    [BONE_SKELETON, '骸骨', 1],
    [BONE_CORPSE, '尸骸', 3],
    [BONE_UNNAMED, '不详', 5],
  ] as const) {
    const d = s.unitTypes[id];
    check(`${label}在表里`, !!d);
    check(`${label}不可建造`, d?.summonedOnly === true);
    check(`${label}暗影半径 ${radius}`, d?.shadowRadius === radius, String(d?.shadowRadius));
    check(`${label}不走通用 AI（自主分 > 0）`, (d?.aiAutonomy ?? 0) > 0);
    check(`${label}不带属性`, !d?.element && !d?.weak && !d?.resist);
  }
  /*
   * 不详**不能**写 `flight: true`——那在引擎里等于"一直在空中层"，
   * 近战永远够不着它。它靠「腾空」在回合末自己改 layer。
   */
  check('不详默认在地面层（靠腾空自己飞）', !s.unitTypes[BONE_UNNAMED]?.flight && !s.unitTypes[BONE_UNNAMED]?.layer);
  check('不详自带暗影跳跃', (s.unitTypes[BONE_UNNAMED]?.skills ?? []).some((k) => k.effect === 'shadow-step'));
}

/* ══════════════════════════════════════════════════════════════════
 * 2. 寻躯 / 复苏：回合末吞掉相邻单位并变形
 * ══════════════════════════════════════════════════════════════════ */
console.log('\n[2] 寻躯 / 复苏（两段式：吞下 → 原地一回合 → 变形）');
{
  const { s, mk } = arena();
  mk('bone', BONE_SKELETON, 'B', 5, 5);
  mk('flesh', FLESH, 'B', 5, 6); // 相邻
  const t1 = endTurnOf(s, 'B');
  const mid = t1.units.find((u) => u.id === 'bone')!;
  check('第一个回合末：吞掉了血肉', !t1.units.some((u) => u.id === 'flesh'));
  check('但还没变形（要等一回合）', mid.type === BONE_SKELETON, mid.type);
  check('记下了要变成什么', mid.custom?.formTo === BONE_CORPSE, String(mid.custom?.formTo));

  // 下一回合它被锁住移动
  const t2 = beginTurnOf(t1, 'B'); // 让它进入自己的回合（回合开始钩子在这里跑）
  const frozen = t2.units.find((u) => u.id === 'bone');
  check('凝结期间动不了（moved 被锁住）', frozen?.moved === true, String(frozen?.moved));

  const t3 = endTurnOf(t2, 'B');
  const done = t3.units.find((u) => u.id === 'bone')!;
  check('第二个回合末：变成尸骸', done.type === BONE_CORPSE, done.type);
  check('变形后血量按比例换算（满血 70 → 满血 150）', done.hp === (t3.unitTypes[BONE_CORPSE]?.maxHp ?? 0), String(done.hp));

  // 半血变形：70 血的骸骨掉到 35，应该变成 75 血的尸骸
  const half = arena();
  const b3 = half.mk('bone3', BONE_SKELETON, 'B', 5, 5);
  b3.hp = 35;
  half.mk('flesh3', FLESH, 'B', 5, 6);
  const h1 = endTurnOf(half.s, 'B');
  const h1b = beginTurnOf(h1, 'B');
  const h2 = endTurnOf(h1b, 'B');
  const hb = h2.units.find((u) => u.id === 'bone3')!;
  check(
    '半血变形：35/70 → 75/150（按比例，不是简单截断）',
    hb.type === BONE_CORPSE && hb.hp === 75,
    `${hb.type} ${hb.hp}`,
  );

  // 隔太远不会吞
  const far = arena();
  far.mk('bone2', BONE_SKELETON, 'B', 5, 5);
  far.mk('flesh2', FLESH, 'B', 9, 5);
  const afterFar = endTurnOf(far.s, 'B');
  check('血肉隔太远就不会被吞', afterFar.units.find((u) => u.id === 'bone2')!.type === BONE_SKELETON);

  // 复苏：尸骸 + 暗影 → 两段之后变不详
  const rev = arena();
  rev.mk('corpse', BONE_CORPSE, 'B', 8, 8);
  rev.mk('shade', SHADE, 'B', 8, 9);
  const r1 = endTurnOf(rev.s, 'B');
  check('第一个回合末：暗影被吞掉', !r1.units.some((u) => u.id === 'shade'));
  check('但还没变成不详', r1.units.find((u) => u.id === 'corpse')!.type === BONE_CORPSE);
  const r2 = beginTurnOf(r1, 'B');
  const r3 = endTurnOf(r2, 'B');
  check('第二个回合末：变成不详', r3.units.find((u) => u.id === 'corpse')!.type === BONE_UNNAMED);
}

/* ══════════════════════════════════════════════════════════════════
 * 3. 腾空
 * ══════════════════════════════════════════════════════════════════ */
console.log('\n[3] 腾空');
{
  // 攻击过 → 起飞
  const { s, mk } = arena();
  const corpse = mk('corpse', BONE_CORPSE, 'B', 5, 5);
  const tgt = mk('t', 'probe-tank-0', 'A', 5, 6);
  tgt.hp = 999;
  const hit = applyAction(s, { type: 'ATTACK', unitId: 'corpse', targetId: 't' });
  check('先打了一下', hit.ok, hit.ok ? '' : hit.reason);
  const afterHit = endTurnOf(hit.ok ? hit.state : s, 'B');
  check('这一回合攻击过 → 升到空中层', afterHit.units.find((u) => u.id === 'corpse')!.layer === 'air');
  void corpse;

  // 没攻击过 → 降落
  const calm = arena();
  calm.mk('corpse2', BONE_CORPSE, 'B', 5, 5);
  calm.s.units.find((u) => u.id === 'corpse2')!.layer = 'air';
  const afterCalm = endTurnOf(calm.s, 'B');
  check('没攻击过 → 落回地面', afterCalm.units.find((u) => u.id === 'corpse2')!.layer !== 'air');

  // 地面被占 → 降落失败，继续飘着
  const blocked = arena();
  const c3 = blocked.mk('corpse3', BONE_CORPSE, 'B', 5, 5);
  c3.layer = 'air';
  blocked.mk('ground', 'probe-tank-0', 'A', 5, 5); // 同一格的地面单位
  const afterBlocked = endTurnOf(blocked.s, 'B');
  check(
    '地面那一格有人 → 落不下去，继续在空中',
    afterBlocked.units.find((u) => u.id === 'corpse3')!.layer === 'air',
  );
}

/* ══════════════════════════════════════════════════════════════════
 * 4. 拼装 / 解离：死后掉零件
 * ══════════════════════════════════════════════════════════════════ */
console.log('\n[4] 死后散架');
{
  /*
   * 用**对面**的兵来杀。同一方不能互打——第一版拿自己人当凶手，
   * 动作直接被拒，表现成"死亡能力一条都没触发"。
   */
  const kill = (s: GameState, id: string): GameState => {
    s.unitTypes['probe-killer'] = {
      ...s.unitTypes['militia']!,
      id: 'probe-killer',
      name: '处刑者',
      category: 'combat',
      atk: 300,
      range: 1,
      move: 2,
      armor: 2,
      maxHp: 200,
      skills: [],
    };
    const victim = s.units.find((u) => u.id === id)!;
    victim.hp = 1;
    const killer: Unit = {
      id: 'killer',
      type: 'probe-killer',
      owner: 'A',
      x: victim.x,
      y: victim.y + 1,
      hp: 200,
      kills: 0,
      moved: false,
      acted: false,
    };
    s.units.push(killer);
    s.current = 'A'; // 凶手是 A 的兵：不在它的回合，动作会被"只能给自己人下命令"拒掉
    const r = applyAction(s, { type: 'ATTACK', unitId: 'killer', targetId: id });
    return r.ok ? r.state : s;
  };

  // 拼装：尸骸死 → 一具半血骸骨 + 两滩淤血
  {
    const { s, mk } = arena();
    mk('corpse', BONE_CORPSE, 'B', 5, 5);
    const after = kill(s, 'corpse');
    const bones = after.units.filter((u) => u.type === BONE_SKELETON);
    const pools = after.units.filter((u) => u.type === BLOOD_POOL);
    check('尸骸死了留下一个骸骨', bones.length === 1, `${bones.length} 个`);
    check(
      '那个骸骨是半血的',
      bones[0] ? bones[0].hp <= Math.ceil((after.unitTypes[BONE_SKELETON]?.maxHp ?? 70) / 2) : false,
      String(bones[0]?.hp),
    );
    check('周围长出两滩淤血', pools.length === 2, `${pools.length} 滩`);
  }

  // 解离：不详死 → 两淤血 + 一骸骨 + 一暗影
  {
    const { s, mk } = arena();
    mk('unnamed', BONE_UNNAMED, 'B', 5, 5);
    const after = kill(s, 'unnamed');
    check('不详死了散成两滩淤血', after.units.filter((u) => u.type === BLOOD_POOL).length === 2);
    check('还留一个骸骨', after.units.filter((u) => u.type === BONE_SKELETON).length === 1);
    check('还有一团暗影', after.units.filter((u) => u.type === SHADE).length === 1);
  }
}

/* ══════════════════════════════════════════════════════════════════
 * 5. 点化：击杀现场拼出一小队
 * ══════════════════════════════════════════════════════════════════ */
console.log('\n[5] 点化');
{
  const { s, mk } = arena();
  const unnamed = mk('unnamed', BONE_UNNAMED, 'B', 5, 5);
  unnamed.hp = 140;
  const prey = mk('prey', 'probe-tank-0', 'A', 5, 6);
  prey.hp = 3;
  const r = applyAction(s, { type: 'ATTACK', unitId: 'unnamed', targetId: 'prey' });
  check('这一刀打得出去', r.ok, r.ok ? '' : r.reason);
  if (r.ok) {
    check('尸体上站起一个骸骨', r.state.units.filter((u) => u.type === BONE_SKELETON).length === 1);
    check('旁边多一滩淤血', r.state.units.filter((u) => u.type === BLOOD_POOL).length === 1);
    check('旁边多一团暗影', r.state.units.filter((u) => u.type === SHADE).length === 1);
  }
}

/* ══════════════════════════════════════════════════════════════════
 * 6. 目标偏好
 * ══════════════════════════════════════════════════════════════════ */
console.log('\n[6] 目标偏好');
{
  // 骸骨：打血最少的
  {
    const { s, mk } = arena();
    const bone = mk('bone', BONE_SKELETON, 'B', 5, 5);
    const fat = mk('fat', 'probe-tank-0', 'A', 5, 6);
    const thin = mk('thin', 'probe-tank-0', 'A', 6, 5);
    fat.hp = 900; thin.hp = 5;
    const out = unitAiProfileOf('bone-seek-flesh')!.handler(ctxOf(s, bone));
    const atk = out.add?.find((x) => x.action.type === 'ATTACK')?.action;
    check('骸骨挑血最少的', atk?.type === 'ATTACK' && (atk as { targetId: string }).targetId === 'thin', JSON.stringify(atk));
  }
  // 尸骸：打攻击力最高的
  {
    const { s, mk } = arena();
    const corpse = mk('corpse', BONE_CORPSE, 'B', 5, 5);
    mk('weak', 'probe-tank-0', 'A', 5, 6);
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
    const strong = mk('strong', 'probe-heavy', 'A', 6, 5);
    strong.hp = 200;
    const out = unitAiProfileOf('corpse-toward-shade')!.handler(ctxOf(s, corpse));
    const atk = out.add?.find((x) => x.action.type === 'ATTACK')?.action;
    check('尸骸打攻击力最高的', atk?.type === 'ATTACK' && (atk as { targetId: string }).targetId === 'strong', JSON.stringify(atk));
  }
  // 不详：打护甲最高的
  {
    const { s, mk } = arena();
    const un = mk('unnamed', BONE_UNNAMED, 'B', 5, 5);
    const thick = mk('thick', 'probe-tank-999', 'A', 5, 6);
    const thin = mk('thin', 'probe-tank-0', 'A', 6, 5);
    thick.hp = 999; thin.hp = 999;
    const out = unitAiProfileOf('unnamed-toward-emperor')!.handler(ctxOf(s, un));
    const atk = out.add?.find((x) => x.action.type === 'ATTACK')?.action;
    check('不详挑护甲最高的', atk?.type === 'ATTACK' && (atk as { targetId: string }).targetId === 'thick', JSON.stringify(atk));
  }
}

/* ══════════════════════════════════════════════════════════════════
 * 7. 走位
 * ══════════════════════════════════════════════════════════════════ */
console.log('\n[7] 走位');
{
  // 骸骨朝血肉走
  {
    const { s, mk } = arena();
    const bone = mk('bone', BONE_SKELETON, 'B', 2, 2);
    const flesh = mk('flesh', FLESH, 'B', 12, 2);
    const out = unitAiProfileOf('bone-seek-flesh')!.handler(ctxOf(s, bone));
    const move = out.add?.find((x) => x.action.type === 'MOVE')?.action;
    check('骸骨朝血肉走', move?.type === 'MOVE' && dist({ x: move.x, y: move.y }, flesh) < dist(bone, flesh), JSON.stringify(move));
  }
  // 尸骸朝暗影走
  {
    const { s, mk } = arena();
    const corpse = mk('corpse', BONE_CORPSE, 'B', 2, 2);
    const shade = mk('shade', SHADE, 'B', 12, 2);
    const out = unitAiProfileOf('corpse-toward-shade')!.handler(ctxOf(s, corpse));
    const move = out.add?.find((x) => x.action.type === 'MOVE')?.action;
    check('尸骸朝暗影走', move?.type === 'MOVE' && dist({ x: move.x, y: move.y }, shade) < dist(corpse, shade), JSON.stringify(move));
  }
  // 不详：看得见仙帝 → 靠近但 4 格内就停
  {
    const { s, mk } = arena();
    const un = mk('unnamed', BONE_UNNAMED, 'B', 2, 10);
    const emperor = mk('emperor', EMPEROR, 'B', 16, 10);
    const out = unitAiProfileOf('unnamed-toward-emperor')!.handler(ctxOf(s, un));
    const move = out.add?.find((x) => x.action.type === 'MOVE')?.action;
    check(
      '不详朝仙帝走',
      move?.type === 'MOVE' && dist({ x: move.x, y: move.y }, emperor) < dist(un, emperor),
      JSON.stringify(move),
    );

    const near = arena();
    const un2 = near.mk('unnamed2', BONE_UNNAMED, 'B', 13, 10);
    near.mk('emperor2', EMPEROR, 'B', 16, 10);
    const quiet = unitAiProfileOf('unnamed-toward-emperor')!.handler(ctxOf(near.s, un2));
    check('已经 3 格内就不再靠近', !quiet.add || quiet.add.every((x) => x.action.type !== 'MOVE'), JSON.stringify(quiet.add));
  }
  // 不详：看不见仙帝 → 沉进暗影深处
  {
    const { s, mk } = arena();
    const un = mk('unnamed', BONE_UNNAMED, 'B', 10, 10);
    refreshShadow(s); // 以它为中心铺一片
    un.x = 1;
    un.y = 1;
    const out = unitAiProfileOf('unnamed-toward-emperor')!.handler(ctxOf(s, un));
    const move = out.add?.find((x) => x.action.type === 'MOVE')?.action;
    check(
      '看不见仙帝时往暗影深处走',
      move?.type === 'MOVE' && dist({ x: move.x, y: move.y }, { x: 10, y: 10 }) < dist(un, { x: 10, y: 10 }),
      JSON.stringify(move),
    );
  }
}

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
if (failed > 0) process.exit(1);
