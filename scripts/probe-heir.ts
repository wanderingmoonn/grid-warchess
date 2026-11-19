/**
 * 裔系探针：眷属 / 后裔 / 子嗣。
 *
 * ── 它守什么 ────────────────────────────────────────────────────────
 *
 * 裔系的性格是**"看到弱的城就撤"**——这不是 AI 偏好，是会写进状态的 10 回合撤离期。
 * 另外三条都是"变成别人"：眷属变仆从、后裔生孩子、子嗣生后裔。
 * 这类"自己会变"的东西最容易写错成"一直在变"或"永远不变"，所以逐条验。
 *
 * 用法：npm run probe:heir
 */

import { createMatch, DEFAULT_CONFIG } from '../src/core/setup.ts';
import { applyAction } from '../src/core/rules.ts';
import {
  BLOOD_MEDIC,
  BRONZE_GUARD,
  DARK_TURMOIL,
  DESCENDANT,
  KINDRED,
  OFFSPRING,
  PUPPET_MASTER,
  SLUMBER,
  SOUL_HOOKER,
} from '../src/core/dark-turmoil-packs.ts';
import { unitAiProfileOf } from '../src/core/unit-ai.ts';
import { abilityApi } from '../src/core/rules.ts';
import type { UnitAiCtx } from '../src/core/expansions.ts';
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
  size: 20,
  startEra: 6,
  expansionIds: [...DEFAULT_CONFIG.expansionIds, 'cultivation', 'dark-turmoil'],
};

interface Arena {
  s: GameState;
  mk: (id: string, type: string, owner: PlayerId, x: number, y: number) => Unit;
  city: City;
}

function arena(opts: { cityEra?: number; ruined?: boolean } = {}): Arena {
  const s = createMatch(CONFIG, 3311);
  s.fog = false;
  s.units = [];
  s.marks = [];
  s.overlays = {};
  s.players.A.gold = 9999;
  s.players.B.gold = 9999;
  s.tiles = s.tiles.map(() => ({ terrain: 'plain' as const, cityId: null }));
  const city: City = {
    id: 'weak',
    owner: 'A',
    x: 6,
    y: 6,
    size: 2,
    era: opts.cityEra ?? 3,
    hp: opts.ruined ? 0 : 70,
    maxHp: 70,
    armor: 4,
    ruined: opts.ruined ?? false,
  };
  s.cities = [
    { id: 'ca', owner: 'A', x: 0, y: 0, size: 2, era: 6, hp: 70, maxHp: 70, armor: 4 },
    // B 也要有城：没有城的席位会被判出局，测试跑到第二回合就"对局已结束"
    { id: 'cb', owner: 'B', x: 17, y: 17, size: 2, era: 6, hp: 70, maxHp: 70, armor: 4 },
    city,
  ];
  // 城占 2×2 格，每格都要挂 cityId（不然走过去不会触发"入驻废墟"）
  for (let dy = 0; dy < 2; dy += 1) {
    for (let dx = 0; dx < 2; dx += 1) {
      const t = s.tiles[(6 + dy) * s.w + (6 + dx)];
      if (t) t.cityId = 'weak';
    }
  }
  const mk = (id: string, type: string, owner: PlayerId, x: number, y: number): Unit => {
    const u: Unit = { id, type, owner, x, y, hp: s.unitTypes[type]!.maxHp, kills: 0, moved: false, acted: false };
    if (s.unitTypes[type]!.layer) u.layer = s.unitTypes[type]!.layer;
    s.units.push(u);
    return u;
  };
  mk('keep-alive', 'militia', 'A', 0, 19);
  s.current = 'B';
  s.turn = 10;
  return { s, mk, city };
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

const beginTurnOf = (s: GameState, side: PlayerId): GameState => {
  const other: PlayerId = side === 'A' ? 'B' : 'A';
  if (s.current !== other) s.current = other;
  const e = applyAction(s, { type: 'END_TURN' });
  if (!e.ok) throw new Error(`END_TURN 失败：${e.reason}`);
  return e.state;
};

console.log('裔系探针\n');

/* ══════════════════════════════════════════════════════════════════
 * 1. 三只
 * ══════════════════════════════════════════════════════════════════ */
console.log('[1] 裔系三只');
{
  const { s } = arena();
  for (const [id, label, hp] of [
    [KINDRED, '眷属', 100],
    [DESCENDANT, '后裔', 130],
    [OFFSPRING, '子嗣', 180],
  ] as const) {
    const d = s.unitTypes[id];
    check(`${label}在表里`, !!d);
    check(`${label}血 ${hp}`, d?.maxHp === hp, String(d?.maxHp));
    check(`${label}暗影半径 1`, d?.shadowRadius === 1, String(d?.shadowRadius));
    check(`${label}会暗影跳跃`, (d?.skills ?? []).some((k) => k.effect === 'shadow-step'));
    for (const ab of ['heir-withdraw', 'scorn-city', 'leave-food']) {
      check(`${label}挂了「${ab}」`, (d?.abilities ?? []).includes(ab));
    }
  }
  check('子嗣会飞', s.unitTypes[OFFSPRING]?.flight === true);
  // 真元做不了、魔法段也不该借（那是奇想包的污染核心）→ 并进暗蚀
  check('子嗣不再有魔法段', !(s.unitTypes[OFFSPRING]?.magicAtk ?? 0));
  check('子嗣挂了「暗蚀」', (s.unitTypes[OFFSPRING]?.abilities ?? []).includes('shadow-erosion'));
  const erosionLine = (id: string): number => {
    const u = { id: 'x', type: id, owner: 'B', x: 1, y: 1, hp: 1, kills: 0, moved: false, acted: false } as Unit;
    const line = DARK_TURMOIL.hooks.getUnitPanelLines!({ state: s, unit: u }).find((t) => t.startsWith('暗蚀'));
    return Number(/(\d+)/.exec(line ?? '')?.[1] ?? 0);
  };
  check(
    `子嗣的暗蚀很重（${erosionLine(OFFSPRING)} 点）`,
    erosionLine(OFFSPRING) >= 20 && erosionLine(KINDRED) === 0 && erosionLine(DESCENDANT) === 0,
  );
  check('裔系最弱的一只也比仆系基础强一点', (s.unitTypes[KINDRED]?.maxHp ?? 0) >= (s.unitTypes[BRONZE_GUARD]?.maxHp ?? 0) - 40);
}

/* ══════════════════════════════════════════════════════════════════
 * 2. 避城：看到弱城就撤
 * ══════════════════════════════════════════════════════════════════ */
console.log('\n[2] 避城');
{
  const { s, mk } = arena({ cityEra: 3 });
  const kid = mk('kid', KINDRED, 'B', 8, 8); // 城就在眼前
  const t = beginTurnOf(s, 'B');
  const after = t.units.find((u) => u.id === 'kid')!;
  check('进入撤离期', Number(after.custom?.retreatUntil ?? 0) > t.turn, String(after.custom?.retreatUntil));

  // 撤离期里只往后退，不打人
  const foe = mk('foe', 'militia', 'A', 8, 9, );
  void foe;
  const withFoe = t.units;
  withFoe.push({ id: 'prey', type: 'militia', owner: 'A', x: 8, y: 9, hp: 40, kills: 0, moved: false, acted: false } as Unit);
  const out = unitAiProfileOf('heir-order')!.handler(ctxOf(t, after));
  const atk = out.add?.find((x) => x.action.type === 'ATTACK');
  check('撤离期不攻击（哪怕敌人在射程里）', !atk, JSON.stringify(out.add));
  check('撤离期在走位', !!out.add?.some((x) => x.action.type === 'MOVE'), JSON.stringify(out.add));

  // 高阶城不触发
  const strong = arena({ cityEra: 5 });
  strong.mk('kid2', KINDRED, 'B', 8, 8);
  const t2 = beginTurnOf(strong.s, 'B');
  check('5 代的城不触发撤离', Number(t2.units.find((u) => u.id === 'kid2')!.custom?.retreatUntil ?? 0) === 0);
  void kid;
}

/* ══════════════════════════════════════════════════════════════════
 * 3. 不据城
 * ══════════════════════════════════════════════════════════════════ */
console.log('\n[3] 不据城');
{
  const { s, mk } = arena({ ruined: true });
  s.current = 'B';
  mk('kid', KINDRED, 'B', 5, 6);
  const r = applyAction(s, { type: 'MOVE', unitId: 'kid', x: 6, y: 6 });
  check('走不进废墟', !r.ok, r.ok ? '居然进去了' : '');
  check('理由写的是「不据城」', !r.ok && r.reason.includes('不据城'), r.ok ? '' : r.reason);
}

/* ══════════════════════════════════════════════════════════════════
 * 4. 归附：眷属变仆从
 * ══════════════════════════════════════════════════════════════════ */
console.log('\n[4] 归附');
{
  // 场上没有仆从：2 回合就变
  const { s, mk } = arena({ cityEra: 6 });
  mk('kid', KINDRED, 'B', 2, 2);
  let cur = s;
  cur = beginTurnOf(cur, 'B');
  check('第 1 回合还是眷属', cur.units.find((u) => u.id === 'kid')!.type === KINDRED);
  cur = beginTurnOf(cur, 'B');
  const changed = cur.units.find((u) => u.id === 'kid')!;
  check('第 2 回合变成仆从', changed.type !== KINDRED, changed.type);
  check('变的是傀儡师（场上没有仆系时按名单第一个）', changed.type === PUPPET_MASTER, changed.type);

  // 场上仆系多：要等更久
  const many = arena({ cityEra: 6 });
  many.mk('kid', KINDRED, 'B', 2, 2);
  many.mk('s1', PUPPET_MASTER, 'B', 4, 2);
  many.mk('s2', SOUL_HOOKER, 'B', 4, 4);
  many.mk('s3', BLOOD_MEDIC, 'B', 6, 2);
  let cur2 = many.s;
  for (let i = 0; i < 2; i += 1) cur2 = beginTurnOf(cur2, 'B');
  check('场上 3 个仆系时：2 回合还不够（要 5 回合）', cur2.units.find((u) => u.id === 'kid')!.type === KINDRED);
  for (let i = 0; i < 3; i += 1) cur2 = beginTurnOf(cur2, 'B');
  const late = cur2.units.find((u) => u.id === 'kid')!;
  check('第 5 回合才变', late.type !== KINDRED, late.type);
  check('变的只能是仆系三种之一', [PUPPET_MASTER, SOUL_HOOKER, BLOOD_MEDIC].includes(late.type), late.type);

  // 卫系**不**计入：场上摆一堆卫系，等待时间不变
  const guards = arena({ cityEra: 6 });
  guards.mk('kid', KINDRED, 'B', 2, 2);
  for (let i = 0; i < 4; i += 1) guards.mk(`g${i}`, BRONZE_GUARD, 'B', 4 + i, 6);
  let cur3 = guards.s;
  cur3 = beginTurnOf(cur3, 'B');
  cur3 = beginTurnOf(cur3, 'B');
  check(
    '卫系不算"仆从"：两回合照样变',
    cur3.units.find((u) => u.id === 'kid')!.type !== KINDRED,
    cur3.units.find((u) => u.id === 'kid')!.type,
  );
}

/* ══════════════════════════════════════════════════════════════════
 * 5. 传裔 / 衍嗣
 * ══════════════════════════════════════════════════════════════════ */
console.log('\n[5] 传裔 / 衍嗣');
{
  // 后裔：每 3 回合一个眷属，上限 2
  const { s, mk } = arena({ cityEra: 6 });
  mk('d', DESCENDANT, 'B', 10, 10);
  let cur = s;
  for (let i = 0; i < 2; i += 1) cur = beginTurnOf(cur, 'B');
  check('后裔前两回合不生', cur.units.filter((u) => u.type === KINDRED).length === 0);
  cur = beginTurnOf(cur, 'B');
  check('第 3 回合生一个眷属', cur.units.filter((u) => u.type === KINDRED).length === 1);
  for (let i = 0; i < 9; i += 1) cur = beginTurnOf(cur, 'B');
  check('跑很久也不超过 2 个', cur.units.filter((u) => u.type === KINDRED).length === 2, String(cur.units.filter((u) => u.type === KINDRED).length));

  // 子嗣：每 2 回合一个后裔，上限 2
  const { s: s2, mk: mk2 } = arena({ cityEra: 6 });
  mk2('o', OFFSPRING, 'B', 10, 10);
  let cur2 = s2;
  for (let i = 0; i < 2; i += 1) cur2 = beginTurnOf(cur2, 'B');
  check('子嗣第 2 回合生一个后裔', cur2.units.filter((u) => u.type === DESCENDANT).length === 1);
  for (let i = 0; i < 8; i += 1) cur2 = beginTurnOf(cur2, 'B');
  check('后裔不超过 2 个', cur2.units.filter((u) => u.type === DESCENDANT).length === 2, String(cur2.units.filter((u) => u.type === DESCENDANT).length));
}

/* ══════════════════════════════════════════════════════════════════
 * 6. 撤离期结束后回来
 * ══════════════════════════════════════════════════════════════════ */
console.log('\n[6] 撤离期结束');
{
  const { s, mk } = arena({ cityEra: 6 });
  const kid = mk('kid', KINDRED, 'B', 2, 2);
  // 有沉眠地时，撤离就是"回仙帝身边"——这条也顺便验了撤退目标的优先级
  mk('slumber', SLUMBER, 'B', 8, 2);
  kid.custom = { retreatUntil: s.turn + 2 };
  const out1 = unitAiProfileOf('heir-order')!.handler(ctxOf(s, kid));
  check('撤离期内有走位候选', !!out1.add?.length, JSON.stringify(out1.add));

  let cur = s;
  for (let i = 0; i < 4; i += 1) cur = beginTurnOf(cur, 'B');
  const back = cur.units.find((u) => u.id === 'kid')!;
  const out2 = unitAiProfileOf('heir-order')!.handler(ctxOf(cur, back));
  check('到期后回到"听指挥"（不再自己走位）', !out2.add || out2.add.length === 0, JSON.stringify(out2.add));
}

/* ══════════════════════════════════════════════════════════════════
 * 7. 面板
 * ══════════════════════════════════════════════════════════════════ */
console.log('\n[7] 面板');
{
  const { s, mk } = arena({ cityEra: 6 });
  const lines = (u: Unit): string => DARK_TURMOIL.hooks.getUnitPanelLines!({ state: s, unit: u }).join(' | ');
  const kid = mk('k', KINDRED, 'B', 2, 2);
  check('眷属面板写了「避城」「不据城」「归附」', ['避城', '不据城', '归附'].every((k) => lines(kid).includes(k)), lines(kid));
  const off = mk('o', OFFSPRING, 'B', 2, 4);
  check('子嗣面板写了「衍嗣」', lines(off).includes('衍嗣'), lines(off));
  void SLUMBER;
}

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
if (failed > 0) process.exit(1);
