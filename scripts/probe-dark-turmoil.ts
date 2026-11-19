/**
 * 「黑暗动乱」最小循环探针。
 *
 * ── 它守的是哪条循环 ────────────────────────────────────────────────
 *
 *   衰老（平时 +2 / 沉眠地 +1）→ 寿元见底 → 吞同伴续命 → 还是老死
 *
 * 这条循环是这个包唯一别人没有的东西。仆从、诡异、攻城、关卡都还没做，
 * 所以现在能验的就是它：**别说它强不强，先确认它真的会老、真的会吃、真的会死。**
 *
 * 用法：npm run probe:dark-turmoil
 */

import { DEFAULT_BUDGET, aiNextAction } from '../src/core/ai.ts';
import { abilityApi, applyAction, produceAt } from '../src/core/rules.ts';
import { createMatch, DEFAULT_CONFIG } from '../src/core/setup.ts';
import { SKILL_AI_HINTS } from '../src/core/skill-hooks.ts';
import type { SkillAiCtx } from '../src/core/skill-hooks.ts';
import { DARK_TURMOIL, EMPEROR, SLUMBER } from '../src/core/dark-turmoil-packs.ts';
import { LEVELS } from '../src/core/level.ts';
import type { GameState, Unit } from '../src/core/types.ts';

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
  size: 14,
  startEra: 6,
  expansionIds: [...DEFAULT_CONFIG.expansionIds, 'cultivation', 'dark-turmoil'],
};

interface Arena {
  s: GameState;
  boss: Unit;
  slumber: Unit;
  foods: Unit[];
}

/**
 * 平地小场：B 方一条仙帝 + 一座沉眠地 + 两个"应急食品"（1 级修士），A 方留一个兵。
 *
 * 为什么给 A 留兵：没有敌人的话 `checkWinner` 会在某些路径上判"对面出局"，
 * 而且"周围敌人不够吃"这条判断也需要一个真实的敌人列表。
 */
function arena(opts: { slumberAt?: { x: number; y: number } } = {}): Arena {
  const s = createMatch(CONFIG, 9876);
  s.fog = false;
  s.units = [];
  s.marks = [];
  s.players.A.gold = 0;
  s.players.B.gold = 0;
  s.tiles = s.tiles.map(() => ({ terrain: 'plain' as const, cityId: null }));
  s.cities = [
    { id: 'ca', owner: 'A', x: 1, y: 1, size: 2, era: 6, hp: 70, maxHp: 70, armor: 4 },
    { id: 'cb', owner: 'B', x: 11, y: 11, size: 2, era: 6, hp: 70, maxHp: 70, armor: 4 },
  ];
  for (const c of s.cities) {
    for (let dy = 0; dy < c.size; dy += 1) {
      for (let dx = 0; dx < c.size; dx += 1) {
        s.tiles[(c.y + dy) * s.w + (c.x + dx)] = { terrain: 'city', cityId: c.id };
      }
    }
  }
  const mk = (id: string, type: string, owner: 'A' | 'B', x: number, y: number): Unit => {
    const u: Unit = {
      id,
      type,
      owner,
      x,
      y,
      hp: s.unitTypes[type]!.maxHp,
      kills: 0,
      moved: false,
      acted: false,
    };
    s.units.push(u);
    return u;
  };
  const boss = mk('boss', EMPEROR, 'B', 8, 8);
  const at = opts.slumberAt ?? { x: 8, y: 10 }; // 默认贴着沉眠地
  const slumber = mk('slumber', SLUMBER, 'B', at.x, at.y);
  // 两个"应急食品"：一个 2 级、一个 1 级（应该先吃 1 级那个）
  const food2 = mk('food2', 'qi-cultivator', 'B', 8, 7);
  food2.custom = { rank: 2 };
  const food1 = mk('food1', 'qi-cultivator', 'B', 7, 8);
  food1.custom = { rank: 1 };
  mk('foe', 'militia', 'A', 4, 4);
  s.current = 'A';
  s.turn = 10;
  // 寿元和年龄直接写死，免得被"初始化"分支影响
  boss.custom = { lifespan: 200, dtInit: 1 };
  boss.age = 178;
  return { s, boss, slumber, foods: [food1, food2] };
}

/** 推进到"B 的回合开始"（A 结束回合），返回期间的年龄变化 */
function advanceToBTurn(s: GameState): GameState {
  const end = applyAction(s, { type: 'END_TURN' });
  if (!end.ok) throw new Error(`END_TURN 失败：${end.reason}`);
  return end.state;
}

console.log('「黑暗动乱」最小循环探针\n');

/* ══════════════════════════════════════════════════════════════════
 * 1. 兵种：只能从关卡来，造不出来
 * ══════════════════════════════════════════════════════════════════ */
console.log('[1] 兵种');
{
  const s = createMatch(CONFIG, 1);
  check('尸骸仙帝进了本局兵种表', !!s.unitTypes[EMPEROR]);
  check('沉眠地进了本局兵种表', !!s.unitTypes[SLUMBER]);
  check('尸骸仙帝标了 summonedOnly（不进产线）', s.unitTypes[EMPEROR]?.summonedOnly === true);
  const city = s.cities.find((c) => c.owner === 'A')!;
  const r = produceAt(s, { kind: 'city', city }, s.unitTypes[EMPEROR]!);
  check('玩家从城里造不出它（不是"AI 不买"，是产线硬拦）', !r.ok, r.ok ? '居然造出来了' : r.reason);
  check('扩展依赖修真包', (DARK_TURMOIL.requires ?? []).includes('cultivation'));
}

/* ══════════════════════════════════════════════════════════════════
 * 2. 衰老：平时 +2，沉眠地 +1
 * ══════════════════════════════════════════════════════════════════ */
console.log('\n[2] 衰老');
{
  // 贴着沉眠地（距离 2）
  const near = arena({ slumberAt: { x: 8, y: 10 } });
  const a0 = near.boss.age ?? 0;
  const s1 = advanceToBTurn(near.s);
  const afterNear = s1.units.find((u) => u.id === 'boss')!.age ?? 0;
  check(
    '在沉眠地：一个回合只长 1 岁（核心那 1 岁之外不再加）',
    afterNear - a0 === 1,
    `${a0} → ${afterNear}`,
  );

  // 沉眠地在很远的地方（距离 12）
  const far = arena({ slumberAt: { x: 1, y: 1 } });
  const b0 = far.boss.age ?? 0;
  const s2 = advanceToBTurn(far.s);
  const afterFar = s2.units.find((u) => u.id === 'boss')!.age ?? 0;
  check(
    '在外行走：一个回合长 2 岁（核心 1 + 本包 1）',
    afterFar - b0 === 2,
    `${b0} → ${afterFar}`,
  );
}

/* ══════════════════════════════════════════════════════════════════
 * 3. 吞噬：什么时候想吃、吃谁
 * ══════════════════════════════════════════════════════════════════ */
console.log('\n[3] 吞噬（AI 提示）');
const hint = SKILL_AI_HINTS['soul-devour'];
check('吞噬已经注册 AI 提示', !!hint);
if (hint) {
  const build = (left: number, foes: number): SkillAiCtx => {
    const { s, boss, foods } = arena();
    boss.custom = { lifespan: 200, dtInit: 1 };
    boss.age = 200 - left;
    const enemy = s.units.find((u) => u.owner === 'A')!;
    return {
      state: s,
      unit: boss,
      def: s.unitTypes[EMPEROR]!,
      skill: s.unitTypes[EMPEROR]!.skills!.find((k) => k.effect === 'soul-devour')!,
      api: abilityApi,
      foes: foes > 0 ? [enemy] : [],
      hpRatio: 1,
      allies: [boss, ...foods],
    };
  };

  check('寿元充裕（还剩 50 年）时不会去吃自己人', hint(build(50, 0)) === null);
  const hungry = hint(build(3, 0));
  check(
    '寿元将尽 + 没敌人：会去吃',
    hungry !== null && typeof hungry === 'object',
    JSON.stringify(hungry),
  );
  if (hungry && typeof hungry === 'object') {
    const { s } = arena();
    const target = s.units.find((u) => u.x === hungry.x && u.y === hungry.y);
    check(
      '吃的是**境界最低**的那个（1 级优先，不是 2 级）',
      target?.id === 'food1',
      `目标 ${target?.id ?? '空'}`,
    );
  }

  /*
   * 黑名单：骨灰罐 / 成帝碑 / 沉眠地不是食物。
   *
   * 这三样是仙帝自己的来历（罐子是他爬出来的地方、碑是他成道的地方、
   * 沉眠地是他歇脚的地方），吃它们既不合剧情，也会让"超脱"这类机制自毁。
   */
  const banned = arena();
  banned.boss.custom = { lifespan: 200, dtInit: 1 };
  banned.boss.age = 197;
  const steleLike = [
    { id: 'b1', type: 'funerary-urn', owner: 'B', x: banned.boss.x + 1, y: banned.boss.y, hp: 20000, kills: 0, moved: false, acted: false },
    { id: 'b2', type: 'imperial-stele', owner: 'B', x: banned.boss.x - 1, y: banned.boss.y, hp: 5000, kills: 0, moved: false, acted: false },
    { id: 'b3', type: 'slumber-site', owner: 'B', x: banned.boss.x, y: banned.boss.y + 1, hp: 300, kills: 0, moved: false, acted: false },
  ] as Unit[];
  banned.s.units.push(...steleLike);
  const onlyBanned: SkillAiCtx = {
    state: banned.s,
    unit: banned.boss,
    def: banned.s.unitTypes[EMPEROR]!,
    skill: banned.s.unitTypes[EMPEROR]!.skills!.find((k) => k.effect === 'soul-devour')!,
    api: abilityApi,
    foes: [],
    hpRatio: 1,
    allies: [banned.boss, ...steleLike],
  };
  check('饿死也不吃罐子/碑/沉眠地', hint(onlyBanned) === null, JSON.stringify(hint(onlyBanned)));

  // 敌人在附近时不该吃——那是"不够吃"，不是"饿死了"
  const ctx2 = build(3, 1);
  const twoFoes: SkillAiCtx = { ...ctx2, foes: [ctx2.state.units.find((u) => u.owner === 'A')!, ctx2.state.units.find((u) => u.owner === 'A')!] };
  check('敌人够吃（附近 ≥ 2 个）时不吃自己人', hint(twoFoes) === null);
}

/* ══════════════════════════════════════════════════════════════════
 * 4. 真的吞一次：同伴没了、寿元变长
 * ══════════════════════════════════════════════════════════════════ */
console.log('\n[4] 吞一次的结算');
{
  const { s, boss, foods } = arena();
  s.current = 'B';
  s.turn = 20;
  const before = Number(boss.custom?.lifespan ?? 0);
  const target = foods.find((f) => f.id === 'food1')!;
  const r = applyAction(s, {
    type: 'HERO_SKILL',
    unitId: boss.id,
    skillId: 'devour',
    targetX: target.x,
    targetY: target.y,
  });
  check('放得出来', r.ok, r.ok ? '' : r.reason);
  if (r.ok) {
    const after = r.state.units.find((u) => u.id === boss.id)!;
    check('同伴消失了（走完整死亡流程，不是从数组里抹掉）', !r.state.units.some((u) => u.id === 'food1'));
    check(
      '寿元变长（+10 年）',
      Number(after.custom?.lifespan ?? 0) - before === 10,
      `${before} → ${after.custom?.lifespan}`,
    );
    check('年龄没有被"变年轻"（只是续命，不是返老还童）', (after.age ?? 0) === 178, String(after.age));
  }

  // 不能吞敌人
  const { s: s2, boss: b2 } = arena();
  s2.current = 'B';
  s2.turn = 20;
  const foe = s2.units.find((u) => u.owner === 'A')!;
  const r2 = applyAction(s2, {
    type: 'HERO_SKILL',
    unitId: b2.id,
    skillId: 'devour',
    targetX: foe.x,
    targetY: foe.y,
  });
  check('吞不了敌人（是应急口粮，不是攻击技能）', !r2.ok, r2.ok ? '居然吞了敌人' : r2.reason);
}

/* ══════════════════════════════════════════════════════════════════
 * 5. 老死
 * ══════════════════════════════════════════════════════════════════ */
console.log('\n[5] 寿元耗尽');
{
  const { s, boss } = arena();
  boss.age = 200; // 寿元 200，年龄 200 → 下一回合就过头
  boss.custom = { lifespan: 200, dtInit: 1 };
  DARK_TURMOIL.hooks.onTurnStart!({ state: s, player: 'B', api: abilityApi });
  check('年龄刚到寿元不死（要"超过"才算耗尽）', s.units.some((u) => u.id === 'boss'));

  const s2 = arena();
  s2.boss.age = 201;
  s2.boss.custom = { lifespan: 200, dtInit: 1 };
  DARK_TURMOIL.hooks.onTurnStart!({ state: s2.s, player: 'B', api: abilityApi });
  check('年龄超过寿元：原地坐化', !s2.s.units.some((u) => u.id === 'boss'));
  check('战报里说清楚了死因（不是"被消灭"）', s2.s.log.some((l) => l.text.includes('寿元耗尽')));
}

/* ══════════════════════════════════════════════════════════════════
 * 6. 关体能跑起来（真跑 40 个行动）
 *
 * 前面五段验的是零件；这一段验的是"装到关里还能不能用"：
 * 部署坐标合不合法、cityless 席位会不会一帧出局、仙帝会不会自己续命。
 * ══════════════════════════════════════════════════════════════════ */
console.log('\n[6] 关体');
{
  const lv = LEVELS.find((l) => l.id === 'level:dark-turmoil');
  check('关卡注册进表了', !!lv);
  if (lv) {
    let s = createMatch({ ...CONFIG, level: lv }, 2026);
    check('开局就有尸骸仙帝', s.units.some((u) => u.type === EMPEROR));
    check('开局有沉眠地', s.units.some((u) => u.type === SLUMBER));

    const ages: number[] = [];
    let ateSomething = false;
    let ateCount = 0;
    const t0 = s.units.find((u) => u.type === EMPEROR)?.age ?? 0;

    for (let turn = 0; turn < 40 && !s.winner; turn += 1) {
      const side = s.current;
      const budget = { ...DEFAULT_BUDGET };
      const rejected = new Set<string>();
      const cap = 8 + 6 * s.units.filter((u) => u.owner === side).length + 6 * s.cities.filter((c) => c.owner === side).length;
      for (let i = 0; i < cap; i += 1) {
        const a = aiNextAction(s, budget, rejected);
        if (!a) break;
        const r = applyAction(s, a);
        if (!r.ok) { rejected.add(JSON.stringify(a)); continue; }
        rejected.clear();
        if (a.type === 'HERO_SKILL') { ateSomething = true; ateCount += 1; }
        s = r.state;
        if (s.winner) break;
      }
      const boss = s.units.find((u) => u.type === EMPEROR);
      if (boss) ages.push(boss.age ?? 0);
      if (s.winner) break;
      const e = applyAction(s, { type: 'END_TURN' });
      if (!e.ok) break;
      s = e.state;
    }

    const bossNow = s.units.find((u) => u.type === EMPEROR);
    console.log(
      `  · 实况：仙帝${bossNow ? `年龄 ${bossNow.age} / 寿元 ${bossNow.custom?.lifespan}` : '已坐化'}` +
        ` · 吞噬 ${ateCount} 次 · 场上同伴 ${s.units.filter((u) => u.owner === 'B').length} 个 · 胜者 ${s.winner ?? '未决'}`,
    );
    check('40 个行动跑完没崩', true);
    check(
      '仙帝确实在变老（不是站着不动）',
      ages.length >= 5 && Math.max(...ages) > t0,
      `年龄 ${t0} → ${Math.max(...ages)}`,
    );
    check(
      '它给自己续过命（吃过同伴，或者已经老死）',
      ateSomething || !bossNow,
      ateSomething ? '吃过' : bossNow ? '既没吃也还活着' : '已老死',
    );
  }
}

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
if (failed > 0) process.exit(1);
