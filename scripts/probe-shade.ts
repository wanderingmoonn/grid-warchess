/**
 * 影系探针（诡异的行为逻辑第一次跑通）。
 *
 * ── 它守什么 ────────────────────────────────────────────────────────
 *
 * 1. **暗蚀真的无视护甲**（这是"诡异伤害"和普通物理的分界）；
 * 2. 三个兵各自的本能：蚀影往影子边上站、暗影跟同类散开、影主不贴身；
 * 3. 影主的召唤计时器：攻击过就更快；
 * 4. 暗影杀人后**原地长出一个蚀影**；
 * 5. 暗影跳跃只能跳进暗影里，跳完这一回合就不能走了。
 *
 * 用法：npm run probe:shade
 */

import { createMatch, DEFAULT_CONFIG } from '../src/core/setup.ts';
import { abilityApi, applyAction } from '../src/core/rules.ts';
import {
  DARK_TURMOIL,
  EMPEROR,
  SHADE,
  SHADOW_BEAST,
  SHADOW_LORD,
  SLUMBER,
  refreshShadow,
  SHADOW_KEY,
} from '../src/core/dark-turmoil-packs.ts';
import { unitAiProfileOf } from '../src/core/unit-ai.ts';
import type { UnitAiCtx } from '../src/core/expansions.ts';
import type { GameState, PlayerId, Unit, UnitTypeDef } from '../src/core/types.ts';

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

/** 20×20 全平地。只有两家各一座城（免得被判出局），没有别的单位。 */
function arena(): Arena {
  const s = createMatch(CONFIG, 7711);
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
  // 靶子：血厚、不还手，专供"暗蚀无视护甲"对照
  const tank = (armor: number): UnitTypeDef => ({
    ...s.unitTypes['militia']!,
    id: `probe-tank-${armor}`,
    name: `靶子${armor}`,
    category: 'combat',
    atk: 0,
    range: 0,
    move: 0,
    armor,
    maxHp: 999,
    skills: [],
    aiAutonomy: 0,
  });
  for (const a of [0, 10, 999]) s.unitTypes[`probe-tank-${a}`] = tank(a);
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

console.log('影系探针\n');

/* ══════════════════════════════════════════════════════════════════
 * 1. 三个兵
 * ══════════════════════════════════════════════════════════════════ */
console.log('[1] 三个兵');
{
  const { s } = arena();
  for (const [id, label] of [
    [SHADOW_BEAST, '蚀影'],
    [SHADE, '暗影'],
    [SHADOW_LORD, '影主'],
  ] as const) {
    const d = s.unitTypes[id];
    check(`${label}在兵种表里`, !!d);
    check(`${label}不可建造`, d?.summonedOnly === true);
    check(`${label}投下暗影`, (d?.shadowRadius ?? 0) > 0, String(d?.shadowRadius));
    check(`${label}开了自主分（不听指挥）`, (d?.aiAutonomy ?? 0) > 0, String(d?.aiAutonomy));
  }
  check('暗影会飞', s.unitTypes[SHADE]?.flight === true && s.unitTypes[SHADE]?.layer === 'air');
  check('暗影一次攻击 3 段', s.unitTypes[SHADE]?.burst === 3, String(s.unitTypes[SHADE]?.burst));
}

/* ══════════════════════════════════════════════════════════════════
 * 2. 暗蚀无视护甲
 * ══════════════════════════════════════════════════════════════════ */
console.log('\n[2] 暗蚀');
{
  const hit = (armor: number): number => {
    const { s, mk } = arena();
    const atk = mk('beast', SHADOW_BEAST, 'B', 5, 5);
    const tgt = mk(`tank-${armor}`, `probe-tank-${armor}`, 'A', 5, 6);
    const before = tgt.hp;
    const r = applyAction(s, { type: 'ATTACK', unitId: atk.id, targetId: tgt.id });
    if (!r.ok) return -1;
    const after = r.state.units.find((u) => u.id === tgt.id)!;
    return before - after.hp;
  };
  const plain = hit(0);
  const armored = hit(10);
  const wall = hit(999);
  check('打 0 甲：物理 22 + 暗蚀 8 = 30', plain === 30, String(plain));
  check('打 10 甲：物理少 10，暗蚀一分不少', plain - armored === 10, `${plain} vs ${armored}`);
  check(
    '打 999 甲：物理被全吃，暗蚀照进 8 点',
    wall === 8,
    `${wall}（如果这里变 0，说明暗蚀挂错了阶段）`,
  );
}

/* ══════════════════════════════════════════════════════════════════
 * 3. 蚀影往影子边上站
 * ══════════════════════════════════════════════════════════════════ */
console.log('\n[3] 蚀影的本能：贴边');
{
  const { s, mk } = arena();
  // 一个影主在远处铺出大片暗影；蚀影站在圈外、敌人也在圈外
  mk('lord', SHADOW_LORD, 'B', 8, 8);
  const beast = mk('beast', SHADOW_BEAST, 'B', 17, 17);
  // 这一段不摆敌人：有敌人它会先去伏击（那条在 [11] 里验）
  refreshShadow(s);
  const cells = new Set(s.overlays?.[SHADOW_KEY] ?? []);
  const edge = (x: number, y: number): boolean =>
    cells.has(y * s.w + x) &&
    (!cells.has((y) * s.w + x + 1) || !cells.has(y * s.w + x - 1) ||
      !cells.has((y + 1) * s.w + x) || !cells.has((y - 1) * s.w + x));

  const handler = unitAiProfileOf('shadow-beast-edge')!.handler;
  const out = handler(ctxOf(s, beast));
  const move = out.add?.[0]?.action;
  check('提出了走位', move?.type === 'MOVE', JSON.stringify(move));
  if (move && move.type === 'MOVE') {
    check('落点在暗影里', cells.has(move.y * s.w + move.x), `${move.x},${move.y}`);
    check('落点贴着暗影边界', edge(move.x, move.y), `${move.x},${move.y}`);
  }
}

/* ══════════════════════════════════════════════════════════════════
 * 4. 暗影跟同类散开
 * ══════════════════════════════════════════════════════════════════ */
console.log('\n[4] 暗影的本能：散开');
{
  const { s, mk } = arena();
  const a = mk('shade-a', SHADE, 'B', 8, 8);
  const b = mk('shade-b', SHADE, 'B', 9, 8); // 贴在一起
  mk('foe', 'militia', 'A', 8, 14);
  const handler = unitAiProfileOf('shade-spread')!.handler;
  const out = handler(ctxOf(s, a));
  const move = out.add?.[0]?.action;
  check('提出了走位', move?.type === 'MOVE', JSON.stringify(move));
  if (move && move.type === 'MOVE') {
    check(
      '往离同类更远的地方走',
      dist({ x: move.x, y: move.y }, b) > dist(a, b),
      `原 ${dist(a, b)} → 新 ${dist({ x: move.x, y: move.y }, b)}`,
    );
  }
  // 已经散开时不该再提意见（否则它们会一直互相躲）
  const far = arena();
  const c = far.mk('shade-c', SHADE, 'B', 3, 3);
  far.mk('shade-d', SHADE, 'B', 15, 15);
  const quiet = handler(ctxOf(far.s, c));
  check('已经隔开很远时不再提意见（交给全局 AI 去打人）', !quiet.add || quiet.add.length === 0);
}

/* ══════════════════════════════════════════════════════════════════
 * 5. 影主的召唤计时器
 * ══════════════════════════════════════════════════════════════════ */
console.log('\n[5] 影主的召唤');
{
  /** 跑 n 个"自己的回合开始"，返回召唤出的暗影数 */
  const summon = (n: number, attackEachTurn: boolean): number => {
    const { s, mk } = arena();
    mk('lord', SHADOW_LORD, 'B', 10, 10);
    for (let i = 0; i < n; i += 1) {
      const lord = s.units.find((u) => u.id === 'lord')!;
      lord.acted = attackEachTurn; // 模拟"这回合攻击过"
      DARK_TURMOIL.hooks.onTurnEnd!({
        state: s,
        player: 'B',
        hurt: () => {},
        log: () => {},
      } as never);
      DARK_TURMOIL.hooks.onTurnStart!({ state: s, player: 'B', api: abilityApi });
    }
    return s.units.filter((u) => u.type === SHADE).length;
  };
  check('不攻击：第 4 个回合才召唤出第一只', summon(3, false) === 0 && summon(4, false) === 1);
  check(
    '每回合都攻击：第 2 个回合就召唤出来（计时器走得更快）',
    summon(2, true) === 1,
    `${summon(2, true)} 只`,
  );
}

/* ══════════════════════════════════════════════════════════════════
 * 6. 暗影杀人 → 原地长出蚀影
 * ══════════════════════════════════════════════════════════════════ */
console.log('\n[6] 暗影的击杀后果');
{
  const { s, mk } = arena();
  const shade = mk('shade', SHADE, 'B', 5, 5);
  const prey = mk('prey', 'probe-tank-0', 'A', 5, 6);
  prey.hp = 5; // 一刀就死
  s.current = 'B';
  const r = applyAction(s, { type: 'ATTACK', unitId: shade.id, targetId: prey.id });
  check('这一刀打得出去', r.ok, r.ok ? '' : r.reason);
  if (r.ok) {
    const born = r.state.units.filter((u) => u.type === SHADOW_BEAST);
    check('原地长出一个蚀影', born.length === 1, `${born.length} 个`);
    check(
      '长在尸体那一格',
      born[0]?.x === 5 && born[0]?.y === 6,
      `${born[0]?.x},${born[0]?.y}`,
    );
  }
  // 非暗影击杀 → 不长
  const other = arena();
  const beast = other.mk('beast', SHADOW_BEAST, 'B', 5, 5);
  const prey2 = other.mk('prey2', 'probe-tank-0', 'A', 5, 6);
  prey2.hp = 5;
  const r2 = applyAction(other.s, { type: 'ATTACK', unitId: beast.id, targetId: prey2.id });
  // 注意排除凶手自己：凶手就是一只蚀影，直接数兵种会把它算进去
  check(
    '别的兵种击杀不会长蚀影（这是暗影的专属后果）',
    r2.ok && !r2.state.units.some((u) => u.type === SHADOW_BEAST && u.id !== beast.id),
  );
}

/* ══════════════════════════════════════════════════════════════════
 * 7. 暗影跳跃
 * ══════════════════════════════════════════════════════════════════ */
console.log('\n[7] 暗影跳跃');
{
  const { s, mk } = arena();
  mk('lord', SHADOW_LORD, 'B', 8, 8); // 铺出暗影
  refreshShadow(s);
  const shade = mk('shade', SHADE, 'B', 2, 2); // 站在暗影外
  s.current = 'B';
  s.turn = 12;

  const outside = applyAction(s, {
    type: 'HERO_SKILL',
    unitId: shade.id,
    skillId: 'shadow-step',
    targetX: 2,
    targetY: 3,
  });
  check('跳不进没有暗影的格子', !outside.ok, outside.ok ? '居然跳成了' : outside.reason);

  const inside = applyAction(s, {
    type: 'HERO_SKILL',
    unitId: shade.id,
    skillId: 'shadow-step',
    targetX: 9,
    targetY: 9,
  });
  check('能跳进暗影格', inside.ok, inside.ok ? '' : inside.reason);
  if (inside.ok) {
    const after = inside.state.units.find((u) => u.id === 'shade')!;
    check('瞬移到位', after.x === 9 && after.y === 9, `${after.x},${after.y}`);
    check('跳完**不**占移动额度（还能走）', after.moved === false, String(after.moved));
  }
}

/* ══════════════════════════════════════════════════════════════════
 * 8. 目标偏好
 * ══════════════════════════════════════════════════════════════════ */
console.log('\n[8] 目标偏好');
{
  // 蚀影：扑落单的那个
  {
    const { s, mk } = arena();
    /*
     * 近战（射程 1）的场摆不出"落单 vs 有护卫"：贴脸的两个敌人彼此一定只差 2 格，
     * 按"两格内有同伴"的判据，它们永远互为护卫。所以这里用一个**射程 2 的探针变体**
     * （同一套 profile），把四个目标同时放进射程内。
     */
    s.unitTypes['probe-beast-r2'] = { ...s.unitTypes[SHADOW_BEAST]!, id: 'probe-beast-r2', range: 2 };
    const beast = mk('beast', 'probe-beast-r2', 'B', 5, 5);
    // 落单的要离其他敌人 ≥3 格，否则按"两格内有同伴"它就又有护卫了
    const lone = mk('lone', 'probe-tank-0', 'A', 5, 7);
    const buddy1 = mk('b1', 'probe-tank-0', 'A', 4, 5);       // 和 b2 挤在一起
    const buddy2 = mk('b2', 'probe-tank-0', 'A', 3, 5);
    lone.hp = 999; buddy1.hp = 50; buddy2.hp = 50;            // 故意让"血少的"是人堆里的
    const out = unitAiProfileOf('shadow-beast-edge')!.handler(ctxOf(s, beast));
    const atk = out.add?.find((x) => x.action.type === 'ATTACK')?.action;
    check(
      '蚀影扑落单的，而不是扑血最少但有人护着的',
      atk?.type === 'ATTACK' && (atk as { targetId: string }).targetId === 'lone',
      JSON.stringify(atk),
    );
  }
  // 暗影：补刀（血最少）
  {
    const { s, mk } = arena();
    const shade = mk('shade', SHADE, 'B', 5, 5);
    const healthy = mk('h', 'probe-tank-0', 'A', 5, 6);
    const hurt = mk('hurt', 'probe-tank-0', 'A', 6, 5);
    healthy.hp = 999; hurt.hp = 7;
    const out = unitAiProfileOf('shade-spread')!.handler(ctxOf(s, shade));
    const atk = out.add?.find((x) => x.action.type === 'ATTACK')?.action;
    check('暗影补刀（挑血最少的）', atk?.type === 'ATTACK' && (atk as { targetId: string }).targetId === 'hurt', JSON.stringify(atk));
  }
  // 影主：打威胁大的
  {
    const { s, mk } = arena();
    const lord = mk('lord', SHADOW_LORD, 'B', 5, 5);
    const weak = mk('w', 'probe-tank-0', 'A', 5, 6);   // 打 0
    mk('strong', 'probe-tank-0', 'A', 6, 5);
    // 给"strong"换个高攻兵种
    s.unitTypes['probe-heavy'] = { ...s.unitTypes['militia']!, id: 'probe-heavy', name: '重炮', atk: 200, range: 5, move: 0, armor: 2, maxHp: 200, skills: [] };
    const strong = s.units.find((u) => u.id === 'strong')!;
    strong.type = 'probe-heavy';
    strong.hp = 200;
    weak.hp = 200;
    const out = unitAiProfileOf('shadow-lord-kite')!.handler(ctxOf(s, lord));
    const atk = out.add?.find((x) => x.action.type === 'ATTACK')?.action;
    check('影主打威胁大的（不是随便挑一个）', atk?.type === 'ATTACK' && (atk as { targetId: string }).targetId === 'strong', JSON.stringify(atk));
  }
}

/* ══════════════════════════════════════════════════════════════════
 * 9. 影主没事的时候往暗影深处躲
 * ══════════════════════════════════════════════════════════════════ */
console.log('\n[9] 影主藏身');
{
  const { s, mk } = arena();
  const lord = mk('lord', SHADOW_LORD, 'B', 10, 10);
  refreshShadow(s);            // 暗影以 (10,10) 为中心铺开
  lord.x = 3;                  // 然后把它挪到圈外（暗影不会跟着走）
  lord.y = 3;
  const out = unitAiProfileOf('shadow-lord-kite')!.handler(ctxOf(s, lord));
  const act = out.add?.[0]?.action;
  check('没有敌人时提出了动作', !!act, JSON.stringify(out.add));
  if (act && (act.type === 'MOVE' || act.type === 'HERO_SKILL')) {
    const tx = act.type === 'MOVE' ? act.x : act.targetX!;
    const ty = act.type === 'MOVE' ? act.y : act.targetY!;
    check(
      '往暗影深处走（离中心更近）',
      dist({ x: tx, y: ty }, { x: 10, y: 10 }) < dist(lord, { x: 10, y: 10 }),
      `走到 ${tx},${ty}`,
    );
  }
  // 已经是最深处就别再动
  const { s: s2, mk: mk2 } = arena();
  const lord2 = mk2('lord', SHADOW_LORD, 'B', 10, 10);
  refreshShadow(s2);
  const quiet = unitAiProfileOf('shadow-lord-kite')!.handler(ctxOf(s2, lord2));
  check('已经躲在最深处时不再乱动', !quiet.add || quiet.add.length === 0, JSON.stringify(quiet.add));
}

/* ══════════════════════════════════════════════════════════════════
 * 10. 跳跃的时机限制
 * ══════════════════════════════════════════════════════════════════ */
console.log('\n[10] 跳跃的时机');
{
  const jump = (mut: (u: Unit) => void): ReturnType<typeof applyAction> => {
    const { s, mk } = arena();
    mk('lord', SHADOW_LORD, 'B', 10, 10);
    mk('keep-alive', 'probe-tank-999', 'A', 18, 1); // 留个活口，否则 B 立刻获胜、后面的动作全被拒
    refreshShadow(s);
    const u = mk('unit', SHADE, 'B', 10, 10);
    s.current = 'B';
    s.turn = 20;
    mut(u);
    return applyAction(s, { type: 'HERO_SKILL', unitId: u.id, skillId: 'shadow-step', targetX: 12, targetY: 12 });
  };
  check('攻击过就不能跳', !jump((u) => { u.acted = true; }).ok);
  check('走完还能跳', jump((u) => { u.moved = true; }).ok);
  check('什么都没做当然能跳', jump(() => {}).ok);

  // 跳完还能走
  {
    const { s, mk } = arena();
    mk('lord', SHADOW_LORD, 'B', 10, 10);
    mk('keep-alive', 'probe-tank-999', 'A', 18, 1);
    refreshShadow(s);
    const u = mk('unit', SHADE, 'B', 10, 10);
    s.current = 'B';
    s.turn = 20;
    const r1 = applyAction(s, { type: 'HERO_SKILL', unitId: u.id, skillId: 'shadow-step', targetX: 12, targetY: 12 });
    check('先跳成功', r1.ok, r1.ok ? '' : r1.reason);
    if (r1.ok) {
      const afterJump = r1.state.units.find((x) => x.id === 'unit')!;
      check('跳完 moved 还是 false', afterJump.moved === false);
      const r2 = applyAction(r1.state, { type: 'MOVE', unitId: 'unit', x: 13, y: 12 });
      check('跳完还能走一步', r2.ok, r2.ok ? '' : r2.reason);
    }
  }

  // 冷却 1：同一回合不能连跳两次，下一回合可以
  {
    const { s, mk } = arena();
    mk('lord', SHADOW_LORD, 'B', 10, 10);
    mk('keep-alive', 'probe-tank-999', 'A', 18, 1);
    refreshShadow(s);
    const u = mk('unit', SHADE, 'B', 10, 10);
    s.current = 'B';
    s.turn = 20;
    const r1 = applyAction(s, { type: 'HERO_SKILL', unitId: u.id, skillId: 'shadow-step', targetX: 11, targetY: 11 });
    const r2 = r1.ok
      ? applyAction(r1.state, { type: 'HERO_SKILL', unitId: 'unit', skillId: 'shadow-step', targetX: 12, targetY: 12 })
      : r1;
    check('同一回合不能连跳两次', !r2.ok, r2.ok ? '居然连跳了' : r2.reason);
    if (r1.ok) {
      // 过一回合：冷却回到 0
      const u2 = r1.state.units.find((x) => x.id === 'unit')!;
      u2.skillCd = { ...(u2.skillCd ?? {}), 'shadow-step': 0 };
      u2.skillTurn = 0;
      const r3 = applyAction(r1.state, { type: 'HERO_SKILL', unitId: 'unit', skillId: 'shadow-step', targetX: 12, targetY: 12 });
      check('下一回合能再跳（冷却 1 = 隔一回合）', r3.ok, r3.ok ? '' : r3.reason);
    }
  }
}

/* ══════════════════════════════════════════════════════════════════
 * 11. 它们自己会用跳跃
 * ══════════════════════════════════════════════════════════════════ */
console.log('\n[11] 自己会用跳跃');
{
  // 影主远离暗影深处，且走不到 → 应该提跳跃
  const { s, mk } = arena();
  const lord = mk('lord', SHADOW_LORD, 'B', 10, 10);
  refreshShadow(s);
  lord.x = 1;
  lord.y = 1; // 远处，走 2 步到不了中心
  const out = unitAiProfileOf('shadow-lord-kite')!.handler(ctxOf(s, lord));
  const skill = out.add?.find((x) => x.action.type === 'HERO_SKILL')?.action;
  check('影主离深处太远就直接跳进去（化进影子里）', skill?.type === 'HERO_SKILL', JSON.stringify(out.add));

  // 蚀影：落单的敌人够不着 → 从影子里跳到他旁边
  {
    const { s: s3, mk: mk3 } = arena();
    const beast = mk3('beast', SHADOW_BEAST, 'B', 4, 4);
    mk3('lord', SHADOW_LORD, 'B', 14, 14);      // 远处铺出一片暗影
    const prey = mk3('prey', 'probe-tank-0', 'A', 15, 15); // 落单，挨着暗影中心
    refreshShadow(s3);
    const out3 = unitAiProfileOf('shadow-beast-edge')!.handler(ctxOf(s3, beast));
    const jump3 = out3.add?.find((x) => x.action.type === 'HERO_SKILL')?.action;
    check('蚀影够不着落单目标时，从影子里扑过去', jump3?.type === 'HERO_SKILL', JSON.stringify(out3.add));
    if (jump3 && jump3.type === 'HERO_SKILL') {
      check(
        '落点贴着那个目标（下一回合就能打）',
        Math.abs(jump3.targetX! - prey.x) + Math.abs(jump3.targetY! - prey.y) === 1,
        `${jump3.targetX},${jump3.targetY}`,
      );
    }
  }
}

/* ══════════════════════════════════════════════════════════════════
 * 12. 玩家看不看得见这些机制
 *
 * 实机反馈：只写了"有暗蚀这个能力"，看不到数值；影主的召唤、暗影的击杀转换
 * 也完全没写。玩家算不出伤害、也不知道它为什么越打越多。
 * ══════════════════════════════════════════════════════════════════ */
console.log('\n[12] 面板上写清楚');
{
  const lines = (type: string): string[] => {
    const { s, mk } = arena();
    const u = mk('u', type, 'B', 5, 5);
    return DARK_TURMOIL.hooks.getUnitPanelLines!({ state: s, unit: u });
  };
  const beast = lines(SHADOW_BEAST).join(' | ');
  check('蚀影：写了暗蚀的具体数值', /暗蚀\s*8\s*点/.test(beast), beast);
  check('蚀影：写了暗影半径', /半径\s*3\s*格/.test(beast), beast);

  const shade = lines(SHADE).join(' | ');
  check('暗影：写了"击杀后原地生出蚀影"', shade.includes('击杀') && shade.includes('蚀影'), shade);
  check('暗影：写了暗蚀数值', /暗蚀\s*4\s*点/.test(shade), shade);

  const lord = lines(SHADOW_LORD).join(' | ');
  check('影主：写了召唤节奏', lord.includes('分裂出一个暗影'), lord);
  check('影主：写了暗蚀数值', /暗蚀\s*15\s*点/.test(lord), lord);

  const emperor = lines(EMPEROR).join(' | ');
  check('尸骸仙帝：仍然只写模糊寿元', emperor.includes('寿元：') && !/\d+\s*年/.test(emperor), emperor);
}

/* ══════════════════════════════════════════════════════════════════
 * 13. 这几个兵不带属性（属性是奇想包的规则，本包不借）
 * ══════════════════════════════════════════════════════════════════ */
console.log('\n[13] 不带属性');
{
  const { s } = arena();
  const withElement = [EMPEROR, SLUMBER, SHADOW_BEAST, SHADE, SHADOW_LORD].filter(
    (id) => !!s.unitTypes[id]?.element,
  );
  check('本包的兵种都不写 element（属性是奇想包的规则，不该出现在这里）', withElement.length === 0, withElement.join(','));
  const withResist = [EMPEROR, SLUMBER, SHADOW_BEAST, SHADE, SHADOW_LORD].filter(
    (id) => !!s.unitTypes[id]?.weak || !!s.unitTypes[id]?.resist,
  );
  check('也不写 weak / resist', withResist.length === 0, withResist.join(','));
}

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
if (failed > 0) process.exit(1);
