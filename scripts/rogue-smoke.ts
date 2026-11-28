/**
 * 肉鸽试玩版的无头冒烟测试。
 *
 * 不开浏览器，直接把"房间图生成 → 逐房推进 → 跨层 → 结局"这条链跑一遍，
 * 再用真实的 AI 打一场，确认战斗适配层造出来的局面能被规则层正常推演。
 *
 *   node --experimental-strip-types scripts/rogue-smoke.ts
 *
 * 它不属于 `npm test`（那套是本体自己的回归），也不改任何既有脚本。
 */
import { AI_MAX_STEPS, aiActionKey, aiNextAction } from '../src/core/ai.ts';
import { DEFAULT_BUDGET } from '../src/core/ai-meta.ts';
import {
  afterRoom,
  applyEffect,
  armyCount,
  battleFor,
  bossFor,
  bossRewards,
  finishBattle,
  nextLayer,
  planLayer,
  restOptions,
  rewardOptions,
  shopStock,
  startRun,
  STEPS_PER_LAYER,
} from '../src/roguelike/run.ts';
import { isEliminated, utype } from '../src/core/rules.ts';
import { buildBattle, outcomeOf, resultOf, step, survivorsOf } from '../src/roguelike/battle.ts';
import { makeRng } from '../src/roguelike/rng.ts';
import type { LayerId, RoomKind, RunState } from '../src/roguelike/types.ts';

const at = <T,>(list: readonly T[], i: number): T => list[i] as T;

let failures = 0;
function check(ok: boolean, label: string, extra = ''): void {
  if (ok) {
    console.log(`  ✓ ${label}`);
  } else {
    failures += 1;
    console.log(`  ✗ ${label} ${extra}`);
  }
}

// ---------------------------------------------------------------- 1. 房间图
console.log('\n[1] 房间图生成（200 层）');
{
  const counts = new Map<RoomKind, number>();
  let bad = 0;
  for (let i = 0; i < 200; i += 1) {
    const layer = ((i % 3) + 1) as LayerId;
    const plan = planLayer(layer, makeRng(i * 7919 + layer));
    if (plan.steps.length !== STEPS_PER_LAYER) bad += 1;
    for (const doors of plan.steps) if (doors.length !== 2) bad += 1;
    const kinds = plan.steps.flat().map((r) => r.kind);
    if (kinds.length !== 20) bad += 1;
    if (plan.steps[0]?.some((d) => d.kind !== 'battle')) bad += 1;
    if (!kinds.includes('shop') || !kinds.includes('rest')) bad += 1;
    if (i === 0) for (const k of kinds) counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  check(bad === 0, '每层 10 步 × 2 门、第 1 步必战、至少各有一个商店与营地', `异常 ${bad}`);
  const battle = (counts.get('battle') ?? 0);
  const elite = counts.get('elite') ?? 0;
  const siege = counts.get('siege') ?? 0;
  console.log(
    `    一层比例：战斗 ${battle} / 精英 ${elite} / 攻坚 ${siege} / 事件 ${counts.get('event') ?? 0} / 商店 ${
      counts.get('shop') ?? 0
    } / 营地 ${counts.get('rest') ?? 0}`,
  );
  check(battle + elite + siege === 10, '战斗房共 10 个（6 普通 + 2 精英 + 2 攻坚）');
}

// ---------------------------------------------------------------- 2. 走完三层
console.log('\n[2] 流程推进（60 局，全部走完三层）');
{
  let ended = 0;
  let survived = 0;
  for (let i = 0; i < 60; i += 1) {
    const rng = makeRng(i * 104729 + 7);
    const run: RunState = startRun(i + 1, ['frontier', 'skirmish', 'horse'][i % 3] as string);
    let guard = 0;
    while (!run.over && guard < 200) {
      guard += 1;
      if (run.step >= STEPS_PER_LAYER) {
        // 层末 boss：用"惨胜"代替真打，只验证流程
        const { init } = bossFor(run, run.seed + guard);
        finishBattle(run, {
          win: true,
          survivors: run.army.map((a) => ({ ...a })),
          gold: init.playerGold + 100,
          turns: 20,
        });
        bossRewards(run, rng);
        if (run.layer >= 3) {
          run.over = { win: true, title: '常规结局 · 破钟', body: '' };
        } else {
          nextLayer(run, run.seed);
        }
        continue;
      }
      const doors = run.plan.steps[run.step] as RunState['plan']['steps'][number];
      const node = at(doors, rng.int(doors.length));
      if (node.kind === 'battle' || node.kind === 'elite' || node.kind === 'siege') {
        const init = battleFor(run, node, run.seed + guard);
        // 简化：赢，损失一个兵（兵被扣完就让流程自然结束）
        const survivors = run.army.map((a) => ({ ...a }));
        const first = survivors.find((a) => a.count > 0);
        if (first) first.count -= 1;
        finishBattle(run, {
          win: true,
          survivors: survivors.filter((a) => a.count > 0),
          gold: init.playerGold + 50,
          turns: 15,
        });
        if (armyCount(run.army) === 0) {
          run.over = { win: false, title: '全灭', body: '' };
          break;
        }
        const rewards = rewardOptions(run, node.kind, rng);
        applyEffect(run, at(rewards, 0).effect, rng);
        afterRoom(run);
      } else if (node.kind === 'shop') {
        const stock = shopStock(run, rng);
        const affordable = stock.find((s) => s.price <= run.gold);
        if (affordable) {
          run.gold -= affordable.price;
          applyEffect(run, affordable.effect, rng);
        }
        afterRoom(run);
      } else if (node.kind === 'rest') {
        const opts = restOptions(run, rng);
        applyEffect(run, at(opts, rng.int(opts.length)).effect, rng);
        afterRoom(run);
      } else {
        afterRoom(run);
      }
    }
    if (run.over) {
      ended += 1;
      if (run.over.win) survived += 1;
    }
  }
  check(ended === 60, '60 局都在 200 步内到达结局');
  console.log(`    通关 ${survived} 局（用简化战斗，只验证流程不会卡死）`);
}

// ---------------------------------------------------------------- 3. 真打一场
console.log('\n[3] 真实对局：L1 遭遇战，双方 AI 打到分出胜负');
{
  const run = startRun(4242, 'frontier');
  const node = { kind: 'battle' as const, title: '遭遇战', sub: '冒烟测试' };
  const init = battleFor(run, node, 999);
  const s = buildBattle(init);
  check(s.units.filter((u) => u.owner === 'A').length > 0, '我军已布阵');
  check(s.units.filter((u) => u.owner === 'B').length > 0, '敌军已布阵');
  check(s.cities.length === 0, '遭遇战：双方都没有城', `实际 ${s.cities.length} 座`);
  check(s.w === 8, '遭遇战地图 8×8', `实际 ${s.w}`);
  const water = s.tiles.filter((t) => t.terrain === 'water' || t.terrain === 'deep' || t.terrain === 'mountain').length;
  const plain = s.tiles.filter((t) => t.terrain === 'plain').length;
  check(water === 0, '地图没有水/山（不用绕路）', `实际 ${water} 格`);
  check(plain / s.tiles.length > 0.7, '平原占七成以上', `实际 ${Math.round((plain / s.tiles.length) * 100)}%`);
  check(s.fog === false, '无城关卡关雾（AI 才有方向）');
  check(s.players.A.gold === init.playerGold, '金币按 run 的值带进战斗');

  let state = s;
  const rejected = new Set<string>();
  let actions = 0;
  let guard = 0;
  const overLimit = (): boolean => Math.ceil(state.turn / 2) > init.roundLimit;
  while (!outcomeOf(state) && !overLimit() && guard < 4000) {
    guard += 1;
    const budget = { ...DEFAULT_BUDGET };
    const action = aiNextAction(state, budget, rejected);
    if (!action) {
      const end = step(state, { type: 'END_TURN' });
      if (!end.ok) break;
      state = end.state;
      rejected.clear();
      continue;
    }
    const r = step(state, action);
    if (!r.ok) {
      rejected.add(aiActionKey(action));
      if (rejected.size > AI_MAX_STEPS * 4) break;
      continue;
    }
    rejected.clear();
    state = r.state;
    actions += 1;
  }
  const outcome = outcomeOf(state);
  console.log(
    `    ${actions} 个动作、${Math.ceil(state.turn / 2)} 轮（上限 ${init.roundLimit}）后：${
      outcome ?? (overLimit() ? '超时判负' : '未分出胜负')
    }`,
  );
  check(outcome !== null || overLimit(), '对局在回合上限内结束（不会卡死）');
  check(typeof state.turn === 'number' && state.turn > 1, '回合在推进');
  const surv = survivorsOf(state);
  check(Array.isArray(surv), '幸存者能翻译回军队');
  const res = resultOf(state, outcome === 'win');
  check(res.gold >= 0, '结算里的金币是合法数值');
}

// ---------------------------------------------------------------- 4. 攻坚/层末的城数
console.log('\n[4] 关卡规格');
{
  const run = startRun(777, 'skirmish');
  const siege = buildBattle(battleFor(run, { kind: 'siege', title: '攻坚战', sub: '' }, 5));
  check(siege.cities.filter((c) => c.owner === 'B').length === 1, '攻坚战敌方 1 座城');
  check(siege.cities.filter((c) => c.owner === 'A').length === 0, '攻坚战玩家仍然没有城');
  const { init } = bossFor(run, 6);
  const boss = buildBattle(init);
  check(boss.cities.filter((c) => c.owner === 'B').length === 1, 'L1 层末：敌方 1 座城');
  check(boss.units.filter((u) => u.owner === 'B').length >= 3, '层末会战敌军有编成');
  const run3 = startRun(888, 'frontier');
  run3.layer = 3;
  run3.clock = 8;
  const boss3 = buildBattle(bossFor(run3, 9).init);
  check(boss3.cities.filter((c) => c.owner === 'B').length === 2, 'L3 钟楼：敌方 2 座城');
  /*
   * 无城判负：把我军全撤掉之后，A 席应当立刻算"出局"。
   * 这条是这次改动的核心——上一版是靠"给一座营城"绕过去的。
   */
  const wipe = { ...boss, units: boss.units.filter((u) => u.owner !== 'A') };
  check(isEliminated(wipe, 'A'), '无城席位：兵打光＝出局');
  check(!isEliminated(boss, 'A'), '还有兵时不算出局');
}

// ---------------------------------------------------------------- 5. 阵型
console.log('\n[5] 阵型：射程越远越靠后，快兵在两翼');
{
  const run = startRun(31415, 'skirmish');
  const s = buildBattle(battleFor(run, { kind: 'battle', title: '遭遇战', sub: '' }, 2718));
  const line = (owner: 'A' | 'B') => {
    const us = s.units.filter((u) => u.owner === owner);
    const melee = us.filter((u) => (utype(s, u.type).range ?? 1) <= 1);
    const ranged = us.filter((u) => (utype(s, u.type).range ?? 1) >= 3);
    const avg = (l: typeof us): number => (l.length ? l.reduce((n, u) => n + u.y, 0) / l.length : NaN);
    return { melee: avg(melee), ranged: avg(ranged), meleeN: melee.length, rangedN: ranged.length };
  };
  const a = line('A');
  check(a.meleeN > 0 && a.rangedN > 0, '我军近战与远程都在场');
  check(a.ranged > a.melee, '我军远程站在近战后面', `近战 y=${a.melee.toFixed(1)} 远程 y=${a.ranged.toFixed(1)}`);

  const scout = s.units.find((u) => u.owner === 'A' && utype(s, u.type).id === 'scout');
  const militia = s.units.find((u) => u.owner === 'A' && utype(s, u.type).id === 'militia');
  if (scout && militia) {
    const cx = s.units.filter((u) => u.owner === 'A').reduce((n, u) => n + u.x, 0) / 7;
    check(
      Math.abs(scout.x - cx) >= Math.abs(militia.x - cx),
      '快兵（斥候 move 4）站得比民兵靠边',
      `斥候 ${scout.x} / 民兵 ${militia.x} / 中线 ${cx.toFixed(1)}`,
    );
  }
}

// ---------------------------------------------------------------- 6. 成长与奖励
console.log('\n[6] 成长与奖励');
{
  // 跨层不换装
  const run = startRun(4242, 'frontier');
  const before = run.army.map((a) => a.type).join(',');
  run.step = STEPS_PER_LAYER;
  nextLayer(run, run.seed);
  check(run.army.map((a) => a.type).join(',') === before, '跨层不自动换装（队伍原样带走）');

  // 开局三房用上一代兵池
  const run2 = startRun(515, 'frontier');
  run2.layer = 2;
  run2.clock = 0;
  const init2 = battleFor(run2, { kind: 'battle', title: '', sub: '' }, 6);
  const prev = new Set(['spearman', 'longbow', 'crossbow', 'knight']);
  check(
    init2.enemyTypes.every((t) => prev.has(t)),
    'L2 开局（钟 0）敌人全是上一代（e2）',
    init2.enemyTypes.join(','),
  );
  run2.clock = 4;
  const init2b = battleFor(run2, { kind: 'battle', title: '', sub: '' }, 6);
  check(
    init2b.enemyTypes.some((t) => !prev.has(t)),
    'L2 中段（钟 4）敌人换成本代（e3）',
    init2b.enemyTypes.join(','),
  );

  // 普通战：钱 ≈ 1.15 个兵价
  const rng = makeRng(9);
  const run3 = startRun(99, 'frontier');
  const opts = rewardOptions(run3, 'battle', rng);
  const unitOpt = opts.find((o) => o.id === 'unit');
  const goldOpt = opts.find((o) => o.id === 'gold');
  check(!!unitOpt && !!goldOpt, '普通战奖励里有「兵」和「钱」两项');
  if (unitOpt && goldOpt) {
    check((unitOpt.effect.add?.count ?? 0) === 1, '普通战给 1 个兵');
    const gold = goldOpt.effect.gold ?? 0;
    check(gold > 25 && gold < 260, '普通战的钱在一个兵的价位上', `${gold} 金`);
  }

  // 精英：3 个兵 / 3 兵价的钱 / 1 兵 + 藏品
  const elite = rewardOptions(run3, 'elite', makeRng(11));
  check(elite.length === 3, '精英战给三个选项');
  check(elite.some((o) => (o.effect.add?.count ?? 0) === 3), '精英战有「三个兵」');
  check(elite.some((o) => (o.effect.add?.count ?? 0) === 1 && !!o.effect.relic), '精英战有「一兵 + 一藏品」');

  // 层末：1 藏 + 1 本层高级兵 + 1 下层初级兵 + 高级兵价钱
  const run4 = startRun(1234, 'frontier');
  const relicsBefore = run4.relics.length;
  const goldBefore = run4.gold;
  const armyBefore = armyCount(run4.army);
  const notes = bossRewards(run4, makeRng(21));
  check(run4.relics.length === relicsBefore + 1, '层末必给 1 件藏品');
  check(armyCount(run4.army) === armyBefore + 2, '层末给 2 个兵（本层高级 + 下层初级）');
  check(run4.gold > goldBefore, '层末给一笔钱');
  check(notes.some((n) => n.includes('下一层的兵')), '层末战利品里点明"下一层的兵"', notes.join(' / '));
}

console.log(
  failures === 0 ? '\n全部通过。' : `\n有 ${failures} 项没通过。`,
);
if (failures > 0) process.exitCode = 1;
