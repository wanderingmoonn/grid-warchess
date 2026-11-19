/**
 * 「不好分类」的三件探针：骨灰罐 / 成帝碑 / 红尘仙。
 *
 * ── 它守什么 ────────────────────────────────────────────────────────
 *
 * 这三件是仙帝这条线的前因后果，规则都比普通兵复杂一层：
 *   1. 骨灰罐「超脱」——仙帝**可以反复复活**，但一次比一次弱（有底线）；
 *   2. 成帝碑「知识污染」——靠近的直接变成诡异，只有 6 级以上的修士免疫；
 *      而修士可以**主动去读**它，换来境界 +1 和三回合后的死；
 *   3. 红尘仙——读过碑的人死后站起来的那位，八级水准、和仙帝一样会老。
 *
 * 用法：npm run probe:relic
 */

import { createMatch, DEFAULT_CONFIG } from '../src/core/setup.ts';
import { abilityApi, applyAction } from '../src/core/rules.ts';
import {
  BONE_UNNAMED,
  BLACK_LOCUST,
  DARK_TURMOIL,
  EMPEROR,
  FUNERARY_URN,
  IMPERIAL_STELE,
  MORTAL_IMMORTAL,
} from '../src/core/dark-turmoil-packs.ts';
import { realmArmorBase, realmAtkBase, trueDamageForRank, extraAttacksForRank } from '../src/core/cultivation/stats.ts';
import { totalHpBonusForRank } from '../src/core/cultivation/progression.ts';
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

interface Arena {
  s: GameState;
  mk: (id: string, type: string, owner: PlayerId, x: number, y: number) => Unit;
}

function arena(): Arena {
  const s = createMatch(CONFIG, 6699);
  s.fog = false;
  s.units = [];
  s.marks = [];
  s.overlays = {};
  s.players.A.gold = 9999;
  s.players.B.gold = 9999;
  s.tiles = s.tiles.map(() => ({ terrain: 'plain' as const, cityId: null }));
  s.cities = [
    { id: 'ca', owner: 'A', x: 0, y: 0, size: 2, era: 6, hp: 70, maxHp: 70, armor: 4 },
    { id: 'cb', owner: 'B', x: 17, y: 17, size: 2, era: 6, hp: 70, maxHp: 70, armor: 4 },
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
    atk: 5000,
    range: 2,
    move: 2,
    armor: 4,
    maxHp: 400,
    skills: [],
    aiAutonomy: 0,
  };
  mk('keep-alive', 'militia', 'A', 0, 19);
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

const beginTurnOf = (s: GameState, side: PlayerId): GameState => {
  const other: PlayerId = side === 'A' ? 'B' : 'A';
  if (s.current !== other) s.current = other;
  const e = applyAction(s, { type: 'END_TURN' });
  if (!e.ok) throw new Error(`END_TURN 失败：${e.reason}`);
  return e.state;
};

console.log('「不好分类」三件探针\n');

/**
 * 九级 / 八级修士的"总账"——**现算的，不抄数字**。
 *
 * 基准兵种是炼气士（攻 10 / 甲 0 / 血 20 / 射 1 / 移 2 / 1 段）。
 * 修真包改公式时，这里的期望值会跟着走——这正是要的：
 * "对标某级修士"这件事不能靠一次手工抄写，否则修真包一调就失真。
 */
const cultivatorTotals = (rank: number) => ({
  atk: 10 + realmAtkBase(rank),
  armor: 0 + realmArmorBase(rank),
  hp: 20 + totalHpBonusForRank(rank),
  true: trueDamageForRank(rank),
  attacks: 1 + extraAttacksForRank(rank),
});

/* ══════════════════════════════════════════════════════════════════
 * 1. 三件本体
 * ══════════════════════════════════════════════════════════════════ */
console.log('[1] 三件本体');
{
  const { s } = arena();
  const urn = s.unitTypes[FUNERARY_URN]!;
  check('骨灰罐：血 20000 / 甲 2000', urn.maxHp === 20000 && urn.armor === 2000, `${urn.maxHp}/${urn.armor}`);
  check('骨灰罐是建筑、不会动不会打', urn.category === 'building' && urn.move === 0 && urn.atk === 0);
  check('骨灰罐暗影范围很大（10 格）', (urn.shadowRadius ?? 0) >= 8);

  const stele = s.unitTypes[IMPERIAL_STELE]!;
  check('成帝碑是建筑', stele.category === 'building');
  check('成帝碑挂着「知识污染」', (stele.abilities ?? []).includes('knowledge-pollution'));

  const mi = s.unitTypes[MORTAL_IMMORTAL]!;
  check('红尘仙是战斗单位', mi.category === 'combat');
  check('红尘仙带暗蚀', (mi.abilities ?? []).includes('shadow-erosion'));
  check('红尘仙比子嗣更强', mi.maxHp > (s.unitTypes['offspring']?.maxHp ?? 0) && mi.atk > (s.unitTypes['offspring']?.atk ?? 0));
}

/* ══════════════════════════════════════════════════════════════════
 * 1b. 对标：仙帝 > 九级修士，红尘仙 ≈ 八级修士
 * ══════════════════════════════════════════════════════════════════ */
console.log('\n[1b] 对标修士');
{
  const { s } = arena();
  const r9 = cultivatorTotals(9);
  const r8 = cultivatorTotals(8);
  const em = s.unitTypes[EMPEROR]!;
  const mi = s.unitTypes[MORTAL_IMMORTAL]!;
  const erosionOf = (id: string): number => {
    const u = { id: 'x', type: id, owner: 'B', x: 1, y: 1, hp: 1, kills: 0, moved: false, acted: false } as Unit;
    const line = DARK_TURMOIL.hooks.getUnitPanelLines!({ state: s, unit: u }).find((t) => t.startsWith('暗蚀'));
    return Number(/(\d+)/.exec(line ?? '')?.[1] ?? 0);
  };

  console.log(`    九级修士：攻 ${r9.atk} · 甲 ${r9.armor} · 血 ${r9.hp} · 真伤 ${r9.true} · ${r9.attacks} 段`);
  console.log(`    仙帝：    攻 ${em.atk} · 甲 ${em.armor} · 血 ${em.maxHp} · 暗蚀 ${erosionOf(EMPEROR)} · ${em.burst ?? 1} 段`);
  console.log(`    八级修士：攻 ${r8.atk} · 甲 ${r8.armor} · 血 ${r8.hp} · 真伤 ${r8.true} · ${r8.attacks} 段`);
  console.log(`    红尘仙：  攻 ${mi.atk} · 甲 ${mi.armor} · 血 ${mi.maxHp} · 暗蚀 ${erosionOf(MORTAL_IMMORTAL)} · ${mi.burst ?? 1} 段`);

  check(`仙帝血 ${em.maxHp} > 九级修士 ${r9.hp}`, em.maxHp > r9.hp);
  check(`仙帝攻 ${em.atk} > 九级修士 ${r9.atk}`, em.atk > r9.atk);
  check(`仙帝甲 ${em.armor} > 九级修士 ${r9.armor}`, em.armor > r9.armor);
  check(`仙帝暗蚀 ${erosionOf(EMPEROR)} > 九级真伤 ${r9.true}`, erosionOf(EMPEROR) > r9.true);
  check(`仙帝段数 ${em.burst ?? 1} ≥ 九级 ${r9.attacks}`, (em.burst ?? 1) >= r9.attacks);

  check(`红尘仙血 ${mi.maxHp} 对齐八级 ${r8.hp}`, mi.maxHp === r8.hp, String(mi.maxHp));
  check(`红尘仙攻 ${mi.atk} 对齐八级 ${r8.atk}`, mi.atk === r8.atk, String(mi.atk));
  check(`红尘仙甲 ${mi.armor} 对齐八级 ${r8.armor}`, mi.armor === r8.armor, String(mi.armor));
  check(`红尘仙暗蚀 ${erosionOf(MORTAL_IMMORTAL)} 对齐八级真伤 ${r8.true}`, erosionOf(MORTAL_IMMORTAL) === r8.true);
  check(`红尘仙段数 ${mi.burst ?? 1} 对齐八级 ${r8.attacks}`, (mi.burst ?? 1) === r8.attacks);

  // 魔法段是奇想包的东西，这两个都不该有
  check('仙帝没有魔法段', !(em.magicAtk ?? 0));
  check('红尘仙没有魔法段', !(mi.magicAtk ?? 0));
}

/* ══════════════════════════════════════════════════════════════════
 * 1c. 黑暗的源头：仙帝与红尘仙的词条
 * ══════════════════════════════════════════════════════════════════ */
console.log('\n[1c] 黑暗的源头');
{
  const { s } = arena();
  const em = s.unitTypes[EMPEROR]!;
  const mi = s.unitTypes[MORTAL_IMMORTAL]!;
  check('仙帝暗影领域 8 格', em.shadowRadius === 8, String(em.shadowRadius));
  check('仙帝会飞', em.flight === true && em.layer === 'air');
  check('仙帝会暗影跳跃', (em.skills ?? []).some((k) => k.effect === 'shadow-step'));

  const wantEmperor = [
    'blood-clot', // 化血
    'soul-hook', // 勾魂
    'shadow-spawn', // 化影
    'blood-infect', // 侵染
    'shadow-possess', // 暗影侵蚀
    'break-lineage', // 断传承
    'blood-siphon', // 汲取
    'dull-wit', // 痴愚
    'blood-grow', // 增生
    'bone-transmute', // 点化
    'dark-source', // 黑暗之源
    'lineage-well', // 衍脉（生 子嗣）
  ];
  const missing = wantEmperor.filter((a) => !(em.abilities ?? []).includes(a));
  check(`仙帝十二条词条一个不少（缺：${missing.join(',') || '无'}）`, missing.length === 0);

  check('红尘仙会飞', mi.flight === true && mi.layer === 'air');
  check('红尘仙会暗影跳跃', (mi.skills ?? []).some((k) => k.effect === 'shadow-step'));
  const wantMi = ['blood-clot', 'shadow-possess', 'break-lineage', 'dull-wit'];
  const missMi = wantMi.filter((a) => !(mi.abilities ?? []).includes(a));
  check(`红尘仙词条齐全（缺：${missMi.join(',') || '无'}）`, missMi.length === 0);

  const urn = s.unitTypes[FUNERARY_URN]!;
  check('骨灰罐也会吐东西（黑暗之源 + 衍脉）', ['dark-source', 'lineage-well'].every((a) => (urn.abilities ?? []).includes(a)));
  const un = s.unitTypes['unnamable']!;
  check('诡异自己带「黑暗之源」（它原来没有来源）', (un.abilities ?? []).includes('dark-source'));
}

/* ══════════════════════════════════════════════════════════════════
 * 1d. 两条召唤：黑暗之源 / 衍脉
 * ══════════════════════════════════════════════════════════════════ */
console.log('\n[1d] 黑暗之源 / 衍脉');
{
  const { s, mk } = arena();
  const em0 = mk('em', EMPEROR, 'B', 10, 10);
  // 把寿元拉长：否则跑到第 12 个回合仙帝自己老死了，测的就变成"老死"而不是"召唤"
  em0.custom = { lifespan: 9999, dtInit: 1 };
  let cur = s;
  const count = (t: string): number => cur.units.filter((u) => u.type === t && u.hp > 0).length;

  // 衍脉：每回合一个子嗣
  cur = beginTurnOf(cur, 'B');
  check('第 1 回合就生出一个子嗣', count('offspring') === 1, String(count('offspring')));
  // 黑暗之源：每 3 回合一只黑蝗 + 一个诡异
  check('第 1 回合还没有黑蝗', count(BLACK_LOCUST) === 0, String(count(BLACK_LOCUST)));

  for (let i = 0; i < 2; i += 1) cur = beginTurnOf(cur, 'B');
  check('第 3 回合爬出一只黑蝗', count(BLACK_LOCUST) === 1, String(count(BLACK_LOCUST)));
  check('同一次也爬出一个诡异', count('unnamable') === 1, String(count('unnamable')));
  check('子嗣封顶 2 个', count('offspring') === 2, String(count('offspring')));

  for (let i = 0; i < 9; i += 1) cur = beginTurnOf(cur, 'B');
  check('黑蝗封顶 3 只', count(BLACK_LOCUST) === 3, String(count(BLACK_LOCUST)));
  check('诡异封顶 3 个', count('unnamable') === 3, String(count('unnamable')));
  check('子嗣仍然是 2 个', count('offspring') === 2, String(count('offspring')));

  // 两条召唤共用 custom 时不会互相偷计时器（各自 key 不同）
  const em = cur.units.find((u) => u.id === 'em')!;
  check('两条召唤各有各的计时器', 'locustIn' in (em.custom ?? {}) && 'heirIn' in (em.custom ?? {}), JSON.stringify(em.custom));

  // 骨灰罐也验一次（它不会动，但会生）
  const { s: s2, mk: mk2 } = arena();
  mk2('urn', FUNERARY_URN, 'B', 10, 10);
  const t2 = beginTurnOf(s2, 'B');
  check('骨灰罐第一回合就生出子嗣', t2.units.filter((u) => u.type === 'offspring').length === 1);
}

/* ══════════════════════════════════════════════════════════════════
 * 2. 超脱：仙帝可以反复复活，但一次比一次弱
 * ══════════════════════════════════════════════════════════════════ */
console.log('\n[2] 超脱');
{
  const { s, mk } = arena();
  mk('urn', FUNERARY_URN, 'B', 10, 10);
  const emperor = mk('emperor', EMPEROR, 'B', 10, 11);
  emperor.custom = { lifespan: 200, dtInit: 1 };
  emperor.age = 178;
  emperor.hp = 1;
  mk('killer', 'probe-killer', 'A', 10, 12);
  s.current = 'A';

  const baseMax = s.unitTypes[EMPEROR]!.maxHp;
  const r1 = applyAction(s, { type: 'ATTACK', unitId: 'killer', targetId: 'emperor' });
  check('仙帝倒下', r1.ok && !r1.state.units.some((u) => u.id === 'emperor'), r1.ok ? '' : r1.reason);
  if (!r1.ok) throw new Error('前置失败：' + r1.reason);
  const born = r1.state.units.filter((u) => u.type === EMPEROR);
  check('罐子把他拉回来了', born.length === 1, `${born.length} 个`);
  if (born[0]) {
    check('年龄清零', (born[0].age ?? 0) === 0, String(born[0].age));
    check('寿元减半（200 → 100）', Number(born[0].custom?.lifespan) === 100, String(born[0].custom?.lifespan));
    check(
      `生命上限减半（${baseMax} → ${Math.floor(baseMax / 2)}）`,
      born[0].hp === Math.floor(baseMax / 2),
      String(born[0].hp),
    );
    check('记了一次复活', Number(r1.state.units.find((u) => u.id === 'urn')!.custom?.revives) === 1);
  }

  /*
   * 再死一次：直接走死亡出口（`killUnit`）。
   *
   * 不用"再打一刀"：复活的仙帝站哪儿由 spawnNear 挑，可能离凶手两格外——
   * 那样会卡在"目标超出射程"上，测的就变成走位而不是超脱了。
   */
  const st = r1.state;
  const again = st.units.find((u) => u.type === EMPEROR)!;
  again.hp = 1;
  abilityApi.killUnit(st, again, undefined, '测试：再死一次');
  const born2 = st.units.filter((u) => u.type === EMPEROR);
  check(
    `第二次复活只有四分之一血上限（${Math.floor(baseMax / 4)}）`,
    born2[0]?.hp === Math.floor(baseMax / 4),
    String(born2[0]?.hp),
  );

  // 上限跌破底线：不再复活
  const low = arena();
  const urn2 = low.mk('urn', FUNERARY_URN, 'B', 10, 10);
  urn2.custom = { revives: 20 }; // 已经复活太多次
  const emp2 = low.mk('emperor', EMPEROR, 'B', 10, 11);
  emp2.hp = 1;
  low.mk('killer', 'probe-killer', 'A', 10, 12);
  low.s.current = 'A';
  const r3 = applyAction(low.s, { type: 'ATTACK', unitId: 'killer', targetId: 'emperor' });
  check('上限太低就不复活了', r3.ok && !r3.state.units.some((u) => u.type === EMPEROR));
}

/* ══════════════════════════════════════════════════════════════════
 * 3. 知识污染
 * ══════════════════════════════════════════════════════════════════
 */
console.log('\n[3] 知识污染');
{
  const { s, mk } = arena();
  mk('stele', IMPERIAL_STELE, 'B', 10, 10);
  /*
   * 半径按"看的那个人"的视野算：普通民兵视野只有 2 → 半径 1，
   * 得贴到相邻才中招；视野 8 的东西（子嗣/仙帝）4 格外就完了。
   */
  mk('v', 'militia', 'A', 10, 11);
  const t = beginTurnOf(s, 'B');
  check('靠近的敌人没了', !t.units.some((u) => u.id === 'v'));
  check('原地站起一个不详', t.units.some((u) => u.type === BONE_UNNAMED));
  check('还多出两只黑蝗', t.units.filter((u) => u.type === BLACK_LOCUST).length >= 2, String(t.units.filter((u) => u.type === BLACK_LOCUST).length));

  // 六级修士免疫
  const prot = arena();
  prot.mk('stele', IMPERIAL_STELE, 'B', 10, 10);
  const monk = prot.mk('monk', 'militia', 'A', 10, 12);
  monk.custom = { rank: 6 };
  const t2 = beginTurnOf(prot.s, 'B');
  check('六级修士免疫', t2.units.some((u) => u.id === 'monk'));
}

/* ══════════════════════════════════════════════════════════════════
 * 4. 阅读碑文
 * ══════════════════════════════════════════════════════════════════ */
console.log('\n[4] 阅读碑文');
{
  const { s, mk } = arena();
  mk('stele', IMPERIAL_STELE, 'B', 10, 10);
  const monk = mk('monk', 'militia', 'A', 10, 11); // 贴着碑
  monk.custom = { rank: 6 };
  s.current = 'A';

  const offers = DARK_TURMOIL.hooks.unitActions?.({ state: s, unit: monk, viewer: 'A' }) ?? [];
  check('六级修士看得到「阅读碑文」', offers.some((o) => o.id === 'read-stele'), JSON.stringify(offers));

  const lowOffers = DARK_TURMOIL.hooks.unitActions?.({ state: s, unit: { ...monk, custom: { rank: 5 } }, viewer: 'A' }) ?? [];
  check('五级修士看不到这个按钮', lowOffers.length === 0);

  const r = applyAction(s, { type: 'UNIT_ACTION', unitId: 'monk', actionId: 'read-stele' });
  check('能读', r.ok, r.ok ? '' : r.reason);
  if (r.ok) {
    const after = r.state.units.find((u) => u.id === 'monk')!;
    check('境界 +1（6 → 7）', Number(after.custom?.rank) === 7, String(after.custom?.rank));
    check('拿到「仙帝凝视」', (after.status?.['imperial-gaze'] ?? 0) > 0, JSON.stringify(after.status));
    check('记下了三回合后死', Number(after.custom?.doomAt) === r.state.turn + 3, String(after.custom?.doomAt));

    // 三回合后死，并在原地站起一名红尘仙（属于仙帝那一方）
    let cur = r.state;
    for (let i = 0; i < 4; i += 1) cur = beginTurnOf(cur, 'A');
    check('到期后人没了', !cur.units.some((u) => u.id === 'monk'));
    const mi = cur.units.find((u) => u.type === MORTAL_IMMORTAL);
    check('原地站起一名红尘仙', !!mi);
    check('它属于仙帝那一方（B）', mi?.owner === 'B', mi?.owner);
    check('它是八级', Number(mi?.custom?.rank) === 8, String(mi?.custom?.rank));
  }
}

/* ══════════════════════════════════════════════════════════════════
 * 5. 红尘仙的老死与出山
 * ══════════════════════════════════════════════════════════════════ */
console.log('\n[5] 红尘仙');
{
  const { s, mk } = arena();
  mk('mi', MORTAL_IMMORTAL, 'B', 10, 10);
  const t = beginTurnOf(s, 'B');
  const after = t.units.find((u) => u.id === 'mi')!;
  check('一上场就记了寿元', typeof after.custom?.lifespan === 'number', JSON.stringify(after.custom));
  check('它已经在老了', (after.age ?? 0) >= 120, String(after.age));

  // 「加速衰老」在面板上看得见（以前只写在回合钩子里，玩家完全不知道它在老）
  {
    const lines = DARK_TURMOIL.hooks.getUnitPanelLines!({ state: s, unit: after }).join(' | ');
    check('面板印出了寿元', lines.includes('寿元：'), lines);
    check('面板说明"沉眠地外衰老加倍"', lines.includes('+2'), lines);
  }

  // 在沉眠地里 +1 / 回合，离开 +2
  {
    const inside = arena();
    const e1 = inside.mk('e1', MORTAL_IMMORTAL, 'B', 10, 10);
    e1.custom = { lifespan: 160, dtInit: 1 };
    e1.age = 120;
    inside.mk('sl', 'slumber-site', 'B', 11, 10);
    const t1 = beginTurnOf(inside.s, 'B');
    check('沉眠地旁边一回合老 1 岁', (t1.units.find((u) => u.id === 'e1')!.age ?? 0) === 121, String(t1.units.find((u) => u.id === 'e1')!.age));

    const outside = arena();
    const e2 = outside.mk('e2', MORTAL_IMMORTAL, 'B', 10, 10);
    e2.custom = { lifespan: 160, dtInit: 1 };
    e2.age = 120;
    const t2 = beginTurnOf(outside.s, 'B');
    check('离开沉眠地一回合老 2 岁', (t2.units.find((u) => u.id === 'e2')!.age ?? 0) === 122, String(t2.units.find((u) => u.id === 'e2')!.age));
  }

  // 寿元耗尽会死
  const old = arena();
  const mi2 = old.mk('mi2', MORTAL_IMMORTAL, 'B', 10, 10);
  mi2.custom = { lifespan: 100, dtInit: 1 };
  mi2.age = 101;
  const t2 = beginTurnOf(old.s, 'B');
  check('寿元耗尽就没了', !t2.units.some((u) => u.id === 'mi2'));

  // 出山：寿元将尽时扑向敌人
  const hunt = arena();
  const hunter = hunt.mk('h', MORTAL_IMMORTAL, 'B', 10, 10);
  hunter.custom = { lifespan: 160, dtInit: 1 };
  hunter.age = 155; // 剩余 5 ≤ STARVE_LEFT(8) → 出山
  const prey = hunt.mk('p', 'militia', 'A', 10, 13);
  void prey;
  const out = unitAiProfileOf('mortal-immortal-harvest')!.handler(ctxOf(hunt.s, hunter));
  check('寿元将尽时出山收割', !!out.add?.some((x) => x.action.type === 'ATTACK' || x.action.type === 'MOVE'), JSON.stringify(out.add));
}

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
if (failed > 0) process.exit(1);
