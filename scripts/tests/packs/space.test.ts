/**
 * 太空扩展（月球 / 发射井 / 月球基地 / 月面战斗）的规则测试。
 *
 * 独立成一个文件，抄的是修真包的做法：改这一包时只跑
 * `npm run test:space`，几秒钟出结果；提交前再跑全量的 `npm test`。
 * 全量里也会调它（test-rules.ts 末尾 `runSpace()`），所以两边不会漂。
 *
 * 这里的用例**不依赖**别的扩展（除了"两个扩展都挂单位动作"那条刻意用修真
 * 验扩展分发），所以能单独跑。
 */

// @ts-nocheck
import { pathToFileURL } from 'node:url';
import { test, assert, stats, fresh, place2 } from '../support.ts';
import {
  abilityApi,
  applyAction,
  computeDamage,
  idx,
  refreshMemory,
  threatTiles,
  visibleTilesOn,
} from '../../../src/core/rules.ts';
import { boardIdOf, boardIds, boardKindOf, boardName, boardOf, idxOn, EARTH } from '../../../src/core/board.ts';
import { CONFIG } from '../../../src/core/config.ts';
import { activeExpansions } from '../../../src/core/expansions.ts';
import { footprintOf, distBetweenUnits } from '../../../src/core/query.ts';
import { onlyVisibleCells, playerView, viewOnBoard } from '../../../src/core/fog.ts';
import { createMoonBoard, MOON_MIN_SIZE, moonSizeFor } from '../../../src/core/space/moon.ts';
import { SILO_ID, SILO_FUEL_TURNS, siloLines } from '../../../src/core/space/silo.ts';
import { MOON_BASE_ID, SAMPLE_TURNS, samplingOf, samplingsOf } from '../../../src/core/space/moon-base.ts';
import {
  EXPAND_BASE_COST,
  PRODUCER_INCOME,
  STATION_CORE_ID,
  STATION_PRODUCER_ID,
  buildCost,
  buildRate,
  siloWeight,
  tickProducers,
} from '../../../src/core/space/station.ts';
import type { Board, GameState, Terrain, Unit } from '../../../src/core/types.ts';

/** 地球铺平（这些用例只关心规则，不关心地形） */
function flatten(s: GameState, terrain: 'plain' | 'water' = 'plain'): void {
  for (const t of s.tiles) t.terrain = terrain;
}

export function run() {
  console.log('\n太空扩展');

test('太空时代：开局就有一张月球图，尺寸跟着地球', () => {
  /*
   * 第 5 步要跑通的就是这条路：勾了扩展 → 普通对局开局 → 地图列表里有月球。
   * 它走的是 `onMatchStart`，时机在 `refreshMemory` 之前，所以迷雾记忆也会带上。
   */
  const s = fresh({ expansionIds: ['space-age'] });
  const moon = s.boards?.moon;
  assert.ok(moon, '勾了「太空时代」就该有月球');
  assert.equal(moon!.w, moonSizeFor(s.w), '月球尺寸跟着地球走');
  assert.equal(moon!.h, moonSizeFor(s.w));
  assert.equal(moon!.tiles.length, moonSizeFor(s.w) ** 2);

  // 没勾的局一格都不该多出来
  const plain = fresh();
  assert.equal(plain.boards?.moon, undefined, '没开扩展就不该有月球');

  // 大图上的比例也要对
  const big = fresh({ expansionIds: ['space-age'], size: 32 });
  assert.equal(big.boards?.moon?.w, 24);
});

console.log('\n太空时代：火箭发射井');

test('发射井：装一个单位、加注 3 回合、送上月球', () => {
  /*
   * 这是第 6 步的全部：一个 2×2 的建筑、一个货舱、一个 3 回合的计时器，
   * 以及"换一张图"的那一下。规则层不需要认识"火箭"——装载走的是
   * 现成的 hold，发射走的是 UNIT_ACTION。
   */
  const s = fresh({ expansionIds: ['space-age'], startEra: 5 });
  flatten(s, 'plain');
  s.players.A.gold = 5000;
  s.players.A.res = { food: 9999, material: 9999 };

  // 时代 5 的工程队该在开局就学会盖井（扩展的 onMatchStart 教的）
  assert.ok((s.unitTypes.crew?.builds ?? []).includes(SILO_ID), '工程队该会盖发射井');

  let cur = s;
  const run = (a: Parameters<typeof applyAction>[1]) => {
    const r = applyAction(cur, a);
    if (r.ok) cur = r.state;
    return r;
  };
  const siloOf = (st: GameState) => st.units.find((u) => u.type === SILO_ID);

  const crew = place2(s, 'A', 'crew', 4, 4);
  /*
   * 站在 2×2 的**右下角旁边**：锚点距离是 2，占地距离才是 1。
   * 装载判定必须按占地算，否则"看着挨着、规则说太远"。
   */
  const pax = place2(s, 'A', 'militia', 7, 6);

  const built = run({ type: 'BUILD', unitId: crew.id, unitType: SILO_ID, x: 5, y: 5 });
  assert.ok(built.ok, `建井失败：${built.reason}`);
  let silo = siloOf(cur);
  assert.ok(silo, '井要出现在场上');
  assert.equal(footprintOf(cur, silo!), 2, '2×2');
  // 工地进度不是这条用例要验的（那是建造系统的账），直接当它盖完了
  delete silo!.buildNeed;
  delete silo!.buildDone;

  // 刚落成的建筑这一回合不能装卸（和"新招的兵当回合不能动"同一条），先过一轮
  run({ type: 'END_TURN' });
  run({ type: 'END_TURN' });
  silo = siloOf(cur);

  assert.equal(distBetweenUnits(cur, silo!, pax), 1, '右下角旁边就是贴身');
  const load = run({ type: 'LOAD', unitId: silo!.id, cargoId: pax.id });
  assert.ok(load.ok, `装载失败：${load.reason}`);
  silo = siloOf(cur);
  assert.equal(cur.units.some((u) => u.id === pax.id), false, '登舱之后棋盘上就没有它了');
  assert.equal((silo!.cargo ?? []).length, 1, '货舱里有一个人');

  /*
   * 装了谁是**底牌**：燃料进度对面看得见（3 回合窗口就是靠它成立的），
   * 但"里面坐着一个剑修"只有自己知道——和丹药同一个口径。
   */
  assert.ok(
    siloLines(cur, silo!, 'A').some((l) => l.includes('民兵')),
    '自己要看得见装的是谁',
  );
  const foeLines = siloLines(cur, silo!, 'B');
  assert.ok(foeLines.some((l) => l.includes('燃料')), '燃料进度对手也该看得见');
  assert.equal(
    foeLines.some((l) => l.includes('民兵')),
    false,
    '对手不该从面板上读出装的是谁',
  );

  // 没加注就点火：拦住
  const early = run({ type: 'UNIT_ACTION', unitId: silo!.id, actionId: 'silo:launch' });
  assert.equal(early.ok, false, '没燃料不该能飞');

  assert.ok(run({ type: 'UNIT_ACTION', unitId: silo!.id, actionId: 'silo:fuel' }).ok, '该能开始加注');
  // 一来一回算一回合：A 的回合开始才 +1
  run({ type: 'END_TURN' });
  run({ type: 'END_TURN' });
  assert.equal(siloOf(cur)!.custom?.fuel, 1, '一回合加一格');
  run({ type: 'END_TURN' });
  run({ type: 'END_TURN' });
  run({ type: 'END_TURN' });
  run({ type: 'END_TURN' });
  silo = siloOf(cur);
  assert.equal(silo!.custom?.fuel, SILO_FUEL_TURNS, '三回合加满');

  const go = run({ type: 'UNIT_ACTION', unitId: silo!.id, actionId: 'silo:launch' });
  assert.ok(go.ok, `发射失败：${go.reason}`);
  assert.equal(siloOf(cur)!.custom?.fuel, 0, '燃料清零');
  assert.equal((siloOf(cur)!.cargo ?? []).length, 0, '货舱空了');

  /*
   * 发射之后**人不在棋盘上**，在航道上飞——这是这一版最大的行为变化。
   * 以前是"点火即到达"，现在是"点火 + 飞 1 回合"，中间那一段就是
   * 对手唯一能看见、能等的一段路（顶栏会报"火箭 1"）。
   */
  assert.equal(cur.units.some((u) => u.id === pax.id), false, '在途单位不在任何棋盘上');
  assert.equal((cur.transit ?? []).length, 1, '有一枚火箭在天上');
  assert.equal(cur.transit![0]!.to, 'moon', '飞向月球');
  assert.equal(cur.transit![0]!.left, 1, '还有一个回合到');

  // 过一轮回到 A：回合开始的 tickTransit 把它落地
  run({ type: 'END_TURN' });
  run({ type: 'END_TURN' });
  assert.equal((cur.transit ?? []).length, 0, '落地之后天上就没有它了');

  const landed = cur.units.find((u) => u.id === pax.id);
  assert.ok(landed, '人该在场上（同一支兵，不是新造的）');
  assert.equal(boardIdOf(landed), 'moon', '它现在在月球图上');
  const moon = cur.boards!.moon!;
  assert.ok(
    landed!.x >= 0 && landed!.x < moon.w && landed!.y >= 0 && landed!.y < moon.h,
    '落点要在月图范围内',
  );
  assert.equal(landed!.acted, true, '落地当回合不能再动');
  // 发射井自己还在，想再飞一趟就重新加注
  assert.ok(siloOf(cur), '发射井不会被消耗');
});

test('视图裁到某一张图：地球上不画月球上的东西', () => {
  /*
   * 幽灵的第二个来源是**渲染**：`renderBoard` 画的是 `view.state.units`，
   * 而"地球那一份视图"以前是原样返回的——月球上的兵和月球基地就按同一个
   * 坐标画到地球上了（2026-11-10 第二次反馈）。
   *
   * 现在不管是哪张图都走 `viewOnBoard`：单位、城市、幽灵都按图筛。
   */
  const s = fresh({ expansionIds: ['space-age'], startEra: 5 });
  const u = place2(s, 'A', 'militia', 4, 4);
  u.board = 'moon';

  const view = playerView(s, 'A');
  assert.ok(view.state.units.some((x) => x.id === u.id), '整份视图里当然有它（换图要用）');

  const earth = viewOnBoard(view, 'earth');
  assert.equal(earth.state.units.some((x) => x.id === u.id), false, '地球上不该画月球上的兵');
  assert.equal(earth.state.w, s.w, '地球还是地球的宽度');

  const moon = viewOnBoard(view, 'moon');
  assert.ok(moon.state.units.some((x) => x.id === u.id), '月球那一份要有它');
  assert.equal(moon.state.w, s.boards!.moon!.w, '宽度换成月球的');
  assert.equal(moon.state.cities.length, 0, '月球上没有城可画');
});

test('月球上的兵按月球的格子走（幽灵 bug 的规则侧）', () => {
  /*
   * 实机反馈：把民兵发射到月球后，在地球的**同一坐标**上能选中并指挥他，
   * 指令按地球坐标结算——他在月面上走，对面还看不见他。
   *
   * 两处都关了：界面按当前图筛单位（`stackAt`），渲染按图裁视图
   * （`viewOnBoard`）。规则这一侧则是**按单位所在的图**结算：
   * 越界判据、地形、寻路全用月球那一份，借地球坐标指挥不动他。
   */
  const s = fresh({ expansionIds: ['space-age'], startEra: 5 });
  for (const t of s.boards!.moon!.tiles) t.terrain = 'regolith';
  const u = place2(s, 'A', 'militia', 2, 2);
  u.board = 'moon';

  const moonW = s.boards!.moon!.w;
  const far = applyAction(s, { type: 'MOVE', unitId: u.id, x: moonW + 2, y: 2 });
  assert.equal(far.ok, false, '超出月球宽度就是越界');
  assert.ok(far.reason.includes('越界'), `理由该说越界，实际：${far.reason}`);

  const moved = applyAction(s, { type: 'MOVE', unitId: u.id, x: 3, y: 2 });
  assert.ok(moved.ok, `月球上该能走：${moved.reason}`);
  const after = moved.state.units.find((x) => x.id === u.id)!;
  assert.equal(after.x, 3, '走的是月球那一格');
  assert.equal(boardIdOf(after), 'moon', '还留在月球图上');

  /*
   * 占格也算得对：2×2 的基地在地球宽度的表里是四格，在月球这一份里也是四格。
   * 走进去要被挡住——这条顺带守住"按图投影之后 footprint 仍然生效"。
   */
  const blockState = moved.state;
  blockState.units.push({
    id: 'moon-base-test',
    type: MOON_BASE_ID,
    owner: 'A',
    x: 6,
    y: 2,
    hp: 200,
    kills: 0,
    moved: true,
    acted: true,
    board: 'moon',
  });
  const into = applyAction(blockState, { type: 'MOVE', unitId: u.id, x: 6, y: 2 });
  assert.equal(into.ok, false, '基地占着的那一格走不进去');

  /*
   * 开火那一侧（2026-11-11 起）：月面能打了，但**只能打同一张图上的**。
   * 具体判定见下面「月面战斗」那组用例；这里只钉住"不串图"这一条，
   * 因为它是"按图走子"最容易退化的地方。
   */
  const foe = place2(moved.state, 'B', 'militia', 4, 2);
  foe.board = 'moon';
  const hit = applyAction(moved.state, { type: 'ATTACK', unitId: u.id, targetId: foe.id });
  assert.ok(hit.ok, `月面上贴身的敌人该打得到：${hit.reason}`);

  // 反过来：站在地球同一坐标的人，不该被月球上的这一刀碰到
  const ghost = place2(moved.state, 'B', 'militia', 5, 2);
  const hpBefore = ghost.hp;
  const cross = applyAction(moved.state, { type: 'ATTACK', unitId: u.id, targetId: ghost.id });
  assert.equal(cross.ok, false, '跨图打不到：坐标再近也隔着一个天空');
  assert.equal(
    moved.state.units.find((x) => x.id === ghost.id)!.hp,
    hpBefore,
    '地球上的那个人一滴血都不该掉',
  );
});

test('登月胜利：展开基地、采样 3 回合、结果送回就赢', () => {
  const s = fresh({ expansionIds: ['space-age'], startEra: 5 });
  // 月面铺平，保证 2×2 放得下
  for (const t of s.boards!.moon!.tiles) t.terrain = 'regolith';
  const crew = place2(s, 'A', 'crew', 2, 2);
  crew.board = 'moon';

  let cur = s;
  const run = (a: Parameters<typeof applyAction>[1]) => {
    const r = applyAction(cur, a);
    if (r.ok) cur = r.state;
    return r;
  };
  const baseOf = (st: GameState) => st.units.find((u) => u.type === MOON_BASE_ID);

  const dep = run({ type: 'UNIT_ACTION', unitId: crew.id, actionId: 'base:deploy' });
  assert.ok(dep.ok, `展开失败：${dep.reason}`);
  const base = baseOf(cur);
  assert.ok(base, '基地要出现在场上');
  assert.equal(boardIdOf(base), 'moon', '基地在月球图上');
  assert.equal(footprintOf(cur, base!), 2, '2×2');
  // 沿用原 id：不是"工程队阵亡 + 新基地"，而是同一支兵换了兵种
  const sameId = cur.units.find((u) => u.id === crew.id);
  assert.ok(sameId, '工程单位并进了基地（id 不变）');
  assert.equal(sameId!.type, MOON_BASE_ID);

  // 落地当回合不能采样（和"刚上场的单位不能放技能"同一条）
  const early = run({ type: 'HERO_SKILL', unitId: base!.id, skillId: 'lunar-sampling' });
  assert.equal(early.ok, false, '落地当回合不该能采样');

  run({ type: 'END_TURN' });
  run({ type: 'END_TURN' });
  const cast = run({ type: 'HERO_SKILL', unitId: base!.id, skillId: 'lunar-sampling' });
  assert.ok(cast.ok, `采样失败：${cast.reason}`);
  assert.equal(samplingOf(cur)?.left, SAMPLE_TURNS, '倒计时要能读出来（顶栏用它）');
  // 开采样这条战报是**公开**的：对手必须看得见"他还有几回合就赢"
  assert.ok(
    cur.log.some((l) => l.open === true && l.text.includes('月壤采样')),
    '开采样要有公开战报',
  );

  // 整局只能做一次
  const again = run({ type: 'HERO_SKILL', unitId: base!.id, skillId: 'lunar-sampling' });
  assert.equal(again.ok, false, '采样只能做一次');

  // 三个自己的回合：前面两个回合结束时都还没赢
  for (let i = 0; i < 4; i++) run({ type: 'END_TURN' });
  assert.equal(cur.winner ?? null, null, '两个回合之后还不该赢');
  run({ type: 'END_TURN' });
  run({ type: 'END_TURN' });
  assert.equal(cur.winner, 'A', '采样结果送回，本方获胜');
});

console.log('\n太空时代：月面战斗');

/**
 * 把一个单位摆到月球上。
 *
 * 不能借 `place2`：它按 (x,y) 去重，会顺手清掉"同一坐标"的其他单位——
 * 而这几条用例要摆的正是"地球与月球同坐标各站一个人"，用它就把对手删了。
 * 所以这里直接 push，图写到单位身上。
 */
function onMoon(st: GameState, owner: 'A' | 'B', type: string, x: number, y: number): Unit {
  const def = st.unitTypes[type];
  assert.ok(def, `本局没有 ${type} 这个兵种`);
  const u: Unit = {
    id: `m${st.nextUnitSeq++}`,
    type,
    owner,
    x,
    y,
    hp: def.maxHp,
    kills: 0,
    moved: false,
    acted: false,
    board: 'moon',
  };
  st.units.push(u);
  return u;
}

/** 月球铺平，免得随机环形山把落点占了 */
function flattenMoon(st: GameState): void {
  for (const t of st.boards!.moon!.tiles) t.terrain = 'regolith';
}

test('月面战斗：地形掩护按月球算，不是地球上同一坐标那块地', () => {
  /*
   * 这条守的是 `computeDamage` 里那次"查地形"。以前它写死 `tileAt(s, x, y)`，
   * 读的是 `s.tiles`（地球）——月球上站在环形山里的人，护甲会按地球那块草地算。
   * 月面开火一接上，这个错就会立刻变成"月面地形是装饰"。
   */
  const s = fresh({ expansionIds: ['space-age'], startEra: 5 });
  flattenMoon(s);
  const moon = s.boards!.moon!;
  const atk = onMoon(s, 'A', 'militia', 2, 2);
  const prey = onMoon(s, 'B', 'militia', 3, 2);

  const plain = computeDamage(s, atk, prey);
  // 把**月球**那一格改成环形山（护甲 +2），地球同一坐标保持原样
  moon.tiles[2 * moon.w + 3]!.terrain = 'crater';
  const onCrater = computeDamage(s, atk, prey);
  assert.ok(
    onCrater < plain,
    `环形山该减伤：月壤 ${plain} → 环形山 ${onCrater}`,
  );

  // 反过来：地球那一格改成环形山，月球上的这个人不该受影响
  const earthTile = s.tiles[idx(s, 3, 2)];
  const keep = earthTile.terrain;
  earthTile.terrain = 'crater';
  const stillCrater = computeDamage(s, atk, prey);
  assert.equal(stillCrater, onCrater, '地球的地形改动不该影响月球上的结算');
  earthTile.terrain = keep;
});

test('月面战斗：溅射只波及同一张图上的人', () => {
  /*
   * 覆盖格是一串**格号**，地球 20 宽的 `i=45` 和月球 9 宽的 `i=45` 是两个位置。
   * 不判图的话，月面上一炮"溅射"过去的会是地球上某个坐标恰好相同的人——
   * 这是接月面战斗时最容易犯、也最难查的错。
   */
  const s = fresh({ expansionIds: ['space-age'], startEra: 5 });
  flattenMoon(s);
  flatten(s, 'plain');
  // 一门射程 3、溅射 2 的迫击炮（拿民兵改，别依赖某个扩展的具体兵种）
  s.unitTypes['test-mortar'] = {
    ...s.unitTypes.militia,
    id: 'test-mortar',
    name: '试验迫击炮',
    atk: 20,
    range: 3,
    splash: 2,
    maxHp: 200,
  };
  // 先摆地球那两个人：`place2` 按 (x,y) 去重，后摆会删掉同坐标的月球单位。
  // （月球这边走 `onMoon`，它只 push 不清理，所以先后顺序必须是"地球先、月球后"。）
  const ghostA = place2(s, 'B', 'militia', 4, 6);
  const ghostB = place2(s, 'B', 'militia', 5, 6);
  const gun = onMoon(s, 'A', 'test-mortar', 2, 6);
  const direct = onMoon(s, 'B', 'militia', 4, 6);
  const bystander = onMoon(s, 'B', 'militia', 5, 6);
  s.current = 'A';
  refreshMemory(s);

  const r = applyAction(s, { type: 'ATTACK', unitId: gun.id, targetId: direct.id, x: 4, y: 6 });
  assert.ok(r.ok, r.ok ? '' : r.reason);
  const hp = (id: string) => r.state.units.find((u) => u.id === id)?.hp ?? 0;
  assert.ok(hp(direct.id) < direct.hp, '主目标要掉血');
  assert.ok(hp(bystander.id) < bystander.hp, '月球上被覆盖到的人要吃溅射');
  assert.equal(hp(ghostA.id), ghostA.hp, '地球上同坐标的人不该被月面这一炮打到');
  assert.equal(hp(ghostB.id), ghostB.hp, '同上（和站位无关，是图不对）');
});

test('月面战斗：基地能被拆——采样作废，登月胜利不再成立', () => {
  /*
   * 登月胜利原本是**不可逆**的：基地一立、采样一开始，对面只能干看着。
   * 月面能打之后第一条要成立的就是"拆掉基地 = 拆掉胜利"，否则反制链是断的。
   * （`lunarWinner` / `samplingOf` 只认活着的基地，代码早写好了，以前没机会验证。）
   */
  const s = fresh({ expansionIds: ['space-age'], startEra: 5 });
  flattenMoon(s);
  const base = onMoon(s, 'A', MOON_BASE_ID, 3, 3);
  base.custom = { ...(base.custom ?? {}), sample: SAMPLE_TURNS }; // 正在采样
  // 基地是 12 甲，民兵那点攻击打上去是 0——用一支专门够劲的兵来拆，
  // 这条测的是"拆掉之后胜利作废"，不是攻城数值本身。
  s.unitTypes['test-cracker'] = {
    ...s.unitTypes.militia,
    id: 'test-cracker',
    name: '拆台队',
    atk: 60,
    range: 1,
  };
  const raider = onMoon(s, 'B', 'test-cracker', 5, 3); // 贴着基地的右边缘
  base.hp = 5; // 一炮就能拆，测的是"拆掉之后"，不是攻城数值
  assert.ok(samplingOf(s), '前提：这时候确实在采样');

  s.current = 'B';
  refreshMemory(s);
  const r = applyAction(s, { type: 'ATTACK', unitId: raider.id, targetId: base.id });
  assert.ok(r.ok, r.ok ? '' : r.reason);
  assert.equal(r.state.units.some((u) => u.id === base.id), false, '基地该被拆掉');
  assert.equal(samplingOf(r.state) ?? null, null, '采样要作废（顶栏的「登月 n」跟着消失）');
  assert.equal(r.state.winner ?? null, null, '拆掉基地就不该再判 A 赢');
});

test('月面战斗：凭空出现的单位留在月面（spawn 带图）', () => {
  /*
   * 召唤/分裂/孵化全都走 `abilityApi.spawn`。它在别的图上一律要带 `board`，
   * 不带就会在**地球同一坐标**多出一个单位——6e3e86f 修过的"月面幽灵"，
   * 只是这次是从"凭空出现"这条路进来的。
   */
  const s = fresh({ expansionIds: ['space-age'], startEra: 5 });
  flattenMoon(s);
  s.current = 'B';
  abilityApi.spawn(s, 'B', 'militia', 2, 2, 'moon');
  const born = s.units.find((u) => u.board === 'moon');
  assert.ok(born, '应该出现在月球上');
  assert.equal(boardIdOf(born!), 'moon');

  // 不传 board 的老行为不变：默认地球（老存档、老回放都走这条）
  abilityApi.spawn(s, 'B', 'militia', 2, 2);
  const earthling = s.units.filter((u) => boardIdOf(u) === EARTH).pop();
  assert.ok(earthling, '不传 board 就是地球');
});

console.log('\n太空时代：点亮与打断');

test('发射井：建成点亮一整个敌方回合，加注期间每回合重新点亮', () => {
  /*
   * 「点亮一回合」是核心机制（`spotlight.ts`），修真异象和这里共用一套：
   * 你标记 → 敌方的那个回合看得见 → 那个回合结束时熄。
   * 判定方式是"敌方可见格里有没有井那一格"，因为"被看见"在引擎里
   * 就是"那一格进了敌方可见集"——只画特效是没用的。
   */
  const s = fresh({ expansionIds: ['space-age'], startEra: 5 });
  flatten(s, 'plain');
  s.players.A.gold = 5000;
  const crew = place2(s, 'A', 'crew', 4, 4);
  const silo = place2(s, 'A', SILO_ID, 10, 10);
  silo.buildNeed = 1;
  silo.buildDone = 1; // 已经建好（施工完成时核心会删掉这两个字段）
  s.current = 'A';

  const cell = idx(s, 10, 10);
  const seenByB = (st: GameState) => visibleTilesOn(st, 'B', EARTH).has(cell);
  // 2×2 的建筑要亮**四格**：只亮锚点的话，玩家看到的是一块孤零零的亮格
  const siloCells = [idx(s, 10, 10), idx(s, 11, 10), idx(s, 10, 11), idx(s, 11, 11)];

  // A 回合刚开始：B 不该看见（还没标记；而且这条只在"看的人自己的回合"生效）
  assert.equal(seenByB(s), false, '标记之前不该亮');

  // A 结束回合 → 轮到 B：井点亮
  const toB = applyAction(s, { type: 'END_TURN' });
  assert.ok(toB.ok, toB.reason);
  assert.equal(toB.state.current, 'B');
  assert.ok(seenByB(toB.state), '建好的井要在敌方回合点亮');
  assert.deepEqual(
    siloCells.filter((i) => visibleTilesOn(toB.state, 'B', EARTH).has(i)).length,
    4,
    '2×2 的井要整块亮（四格），不能只亮锚点',
  );

  /*
   * 熄灯：B 结束回合之后，A 的井不该还亮着（否则等于永久暴露）。
   * 注意这一回合 A 没有加注，所以不会被重新点亮。
   */
  const toA = applyAction(toB.state, { type: 'END_TURN' });
  assert.ok(toA.ok, toA.reason);
  assert.equal(toA.state.current, 'A');
  assert.equal(seenByB(toA.state), false, '敌方回合结束后必须熄灯');

  // 加注：开始加注之后，每回合重新点亮
  const s2 = toA.state;
  const silo2 = s2.units.find((u) => u.type === SILO_ID)!;
  const fuelled = applyAction(s2, { type: 'UNIT_ACTION', unitId: silo2.id, actionId: 'silo:fuel' });
  assert.ok(fuelled.ok, fuelled.reason);
  const toB2 = applyAction(fuelled.state, { type: 'END_TURN' });
  assert.ok(toB2.ok, toB2.reason);
  assert.ok(
    visibleTilesOn(toB2.state, 'B', EARTH).has(idx(toB2.state, silo2.x, silo2.y)),
    '加注期间要每回合重新点亮（烟柱一直冒）',
  );
});

test('加注进度是公开战报：对手读得到"还差几回合"', () => {
  const s = fresh({ expansionIds: ['space-age'], startEra: 5 });
  flatten(s, 'plain');
  const silo = place2(s, 'A', SILO_ID, 6, 6);
  s.current = 'A';
  const started = applyAction(s, { type: 'UNIT_ACTION', unitId: silo.id, actionId: 'silo:fuel' });
  assert.ok(started.ok, started.reason);

  // 推进一回合：加注到 1/3，并且这条必须是公开的（open = true）
  const toB = applyAction(started.state, { type: 'END_TURN' });
  assert.ok(toB.ok, toB.reason);
  const toA = applyAction(toB.state, { type: 'END_TURN' });
  assert.ok(toA.ok, toA.reason);
  const line = toA.state.log.find((l) => l.open === true && l.text.includes('加注燃料'));
  assert.ok(line, `加注进度要写公开战报，实际日志：${toA.state.log.slice(-3).map((l) => l.text).join(' / ')}`);
});

test('月壤采样：基地挨一下就打回原点，顶栏提示消失、可以重新点', () => {
  /*
   * 这是"登月之后还要守"的那一条。门槛刻意做得很低（1 点也算），
   * 因为反制原本在数学上不成立：民兵 13 攻 − 12 甲 = 每回合 1 点，
   * 而基地 200 血——如果不按"挨打即清零"，一个兵贴上去毫无意义。
   */
  const s = fresh({ expansionIds: ['space-age'], startEra: 5 });
  flattenMoon(s);
  const base = onMoon(s, 'A', MOON_BASE_ID, 3, 3);
  base.custom = { ...(base.custom ?? {}), sample: SAMPLE_TURNS };
  // 一支够劲的兵：民兵打不穿 12 甲（那样测的就不是"打断"而是"打不动"）
  s.unitTypes['test-knocker'] = {
    ...s.unitTypes.militia,
    id: 'test-knocker',
    name: '拆台队',
    atk: 40,
    range: 1,
  };
  const raider = onMoon(s, 'B', 'test-knocker', 5, 3);
  base.hp = 200;
  s.current = 'B';
  refreshMemory(s);

  assert.ok(samplingOf(s), '前提：这时候确实在采样');
  const r = applyAction(s, { type: 'ATTACK', unitId: raider.id, targetId: base.id });
  assert.ok(r.ok, r.ok ? '' : r.reason);
  const after = r.state.units.find((u) => u.id === base.id);
  assert.ok(after, '这一下不该把基地打死（测的是打断，不是拆毁）');
  assert.equal(samplingOf(r.state) ?? null, null, '采样要被打回原点');
  assert.equal(after!.custom?.sample ?? 0, 0, '进度清零');
  assert.equal(after!.custom?.sampled, undefined, '不算完成');
  assert.ok(
    r.state.log.some((l) => l.open === true && l.text.includes('采样被打断')),
    '打断要有公开战报（对手得知道"这一下有用"）',
  );

  // 可以重新点：回到自己的回合，立刻就能重新开始
  const mine = { ...r.state, current: 'A' as const };
  const again = applyAction(mine, { type: 'HERO_SKILL', unitId: base.id, skillId: 'lunar-sampling' });
  assert.ok(again.ok, `清零之后该能重新采样：${again.reason}`);
  assert.equal(samplingOf(again.state)?.left, SAMPLE_TURNS, '倒计时从头算');
});

test('双方同时采样：顶栏给每一方各一条倒计时', () => {
  /*
   * 以前 `samplingOf` 只返回找到的**第一个**，顶栏就只有一个「登月 n」。
   * 两人同时登月时，其中一个人的进度是隐形的——而这条胜利条件本质是
   * "谁先送回谁赢"，看不见对手的进度等于看不见竞赛的另一半。
   */
  const s = fresh({ expansionIds: ['space-age'], startEra: 5 });
  flattenMoon(s);
  const mine = onMoon(s, 'A', MOON_BASE_ID, 2, 2);
  const theirs = onMoon(s, 'B', MOON_BASE_ID, 8, 8);
  mine.custom = { ...(mine.custom ?? {}), sample: 2 };
  theirs.custom = { ...(theirs.custom ?? {}), sample: SAMPLE_TURNS };

  const list = samplingsOf(s);
  assert.equal(list.length, 2, '两座基地都在采样，都要报出来');
  assert.deepEqual(
    list.map((x) => [x.owner, x.left]),
    [['A', 2], ['B', SAMPLE_TURNS]],
    '各报各的剩余回合（顺序按 s.units，稳定）',
  );
  // 单数版仍在：只取第一个，给"只关心有没有人在采"的地方用
  assert.equal(samplingOf(s)?.owner, 'A');

  const badges = activeExpansions(s).flatMap((e) => e.hooks.topbarBadges?.({ state: s }) ?? []);
  assert.equal(badges.length, 2, `顶栏要有两条，实际：${JSON.stringify(badges)}`);
  assert.ok(badges.some((b) => b.id === 'space-lunar-A' && b.text.includes('2')), '我方那条带回合数');
  assert.ok(badges.some((b) => b.id === 'space-lunar-B' && b.text.includes(String(SAMPLE_TURNS))), '对手那条也在');
  // 名字要在：两个「登月 2」并排，谁也分不清是谁的
  assert.ok(badges.every((b) => /红方|蓝方/.test(b.text)), `徽标要带玩家名：${badges.map((b) => b.text).join(' / ')}`);

  // 采完之后不再占用顶栏（人家已经赢了，这条徽标没有意义）
  theirs.custom = { ...(theirs.custom ?? {}), sampled: true };
  const after = activeExpansions(s).flatMap((e) => e.hooks.topbarBadges?.({ state: s }) ?? []);
  assert.equal(after.length, 1, 'done 的那条不再显示');
});

test('展开基地：四格都要是平地，站在环形山上展不开', () => {
  /*
   * 文案一直写着"要一块平地"，但代码只判了 `passable`——环形山（2 步、
   * 护甲 +2）也能展开，等于文案在骗人。现在按文案来。
   *
   * 环形山放在工程单位脚下：`baseAnchorFor` 的四个候选锚点（自己、左、上、左上）
   * 都包含脚下这一格，所以一处是坑，四种摆法全都放不下——正好把"整块平地"
   * 这条钉死，而不是碰巧被某个角挡住。
   */
  const s = fresh({ expansionIds: ['space-age'], startEra: 5 });
  flattenMoon(s);
  const moon = s.boards!.moon!;
  const pit = (3 * moon.w) + 3;
  moon.tiles[pit]!.terrain = 'crater';
  const crew = onMoon(s, 'A', 'crew', 3, 3);

  const bad = applyAction(s, { type: 'UNIT_ACTION', unitId: crew.id, actionId: 'base:deploy' });
  assert.equal(bad.ok, false, '脚下是环形山，不该能展开');
  assert.ok(bad.reason.includes('平地'), `理由该说清是地形问题，实际：${bad.reason}`);
  assert.equal(s.units.filter((u) => u.type === MOON_BASE_ID).length, 0, '失败时不该凭空多出一座基地');

  // 填平就能展开（证明拦的确实只是地形，不是别的）
  moon.tiles[pit]!.terrain = 'regolith';
  const good = applyAction(s, { type: 'UNIT_ACTION', unitId: crew.id, actionId: 'base:deploy' });
  assert.ok(good.ok, `填平之后该能展开：${good.ok ? '' : good.reason}`);
  assert.ok(good.state.units.some((u) => u.type === MOON_BASE_ID), '基地起来了');
});

console.log('\n太空战争：航道投送');

test('航道投送：目的地不是月球也能送到（手搓第二个节点）', () => {
  /*
   * 这条是 P0 的验收：**投送链不认识月球**。
   *
   * 以前 `launchToMoon` 里写死 `MOON_BOARD` 和 `moonLandingTile`，换一张图就废。
   * 现在发射井只做两件事：问"我站在星图哪个节点"、问"这个节点有哪些可用航道"。
   * 所以这里把航道改成"地球 → 一张手搓的 8×8 图"，照样能送过去。
   */
  const s = fresh({ expansionIds: ['space-age'], startEra: 5 });
  flatten(s, 'plain');
  const W = 8;
  s.boards!['test-b'] = {
    id: 'test-b',
    kind: 'planet',
    name: '试验场',
    w: W,
    h: W,
    tiles: Array.from({ length: W * W }, () => ({ terrain: 'plain' as Terrain, cityId: null })),
  };
  s.starmap!.nodes.push({ id: 'tb', kind: 'planet', board: 'test-b', name: '试验场' });
  // 只留这一条：发射井没有"月球优先"这种说法，它拿到的第一条就是路
  s.starmap!.lanes = [{ id: 'earth-tb', a: 'earth', b: 'tb', turns: 2 }];

  const silo = place2(s, 'A', SILO_ID, 5, 5);
  const pax = place2(s, 'A', 'militia', 7, 6);
  // 装好货、加满油（装载与加注本身在别的用例里验）
  s.units = s.units.filter((u) => u.id !== pax.id);
  silo.cargo = [{ ...pax }];
  silo.custom = { fuel: SILO_FUEL_TURNS, fueling: false };
  s.current = 'A';

  let cur = s;
  const run = (a: Parameters<typeof applyAction>[1]) => {
    const r = applyAction(cur, a);
    if (r.ok) cur = r.state;
    return r;
  };

  const go = run({ type: 'UNIT_ACTION', unitId: silo.id, actionId: 'silo:launch' });
  assert.ok(go.ok, `发射失败：${go.reason}`);
  assert.equal((cur.transit ?? []).length, 1, '上路了');
  assert.equal(cur.transit![0]!.to, 'tb', '飞向手搓的那个节点，不是月球');
  assert.equal(cur.transit![0]!.left, 2, '航程 2 回合');

  // 一来一回算一轮：两轮之后到
  run({ type: 'END_TURN' });
  run({ type: 'END_TURN' });
  assert.equal((cur.transit ?? []).length, 1, '才过了一回合，还在天上');
  assert.equal(cur.transit![0]!.left, 1);
  run({ type: 'END_TURN' });
  run({ type: 'END_TURN' });

  assert.equal((cur.transit ?? []).length, 0, '到了');
  const landed = cur.units.find((u) => u.id === pax.id);
  assert.ok(landed, '人落地了');
  assert.equal(boardIdOf(landed), 'test-b', '落在手搓那张图上');
  assert.equal(landed!.acted, true, '落地当回合不能动');
});

test('在途单位：不在任何棋盘上，谁也打不到', () => {
  /*
   * 在途单位**不进 `s.units`**，这是这条链最重要的一条约定：
   * 留着的话会被回合重置（moved/acted 被清）、被迷雾裁、被战斗误伤，
   * 还会在两张图上"同时存在"。
   *
   * 顺带钉住"打不到"：所有攻击目标都从 `units` 里取，不在里面就等于
   * 天上那一段路是安全的——这是已定的设计（航道只计时，不能打）。
   */
  const s = fresh({ expansionIds: ['space-age'], startEra: 5 });
  flatten(s, 'plain');
  const silo = place2(s, 'A', SILO_ID, 5, 5);
  const pax = place2(s, 'A', 'militia', 7, 6);
  s.units = s.units.filter((u) => u.id !== pax.id);
  silo.cargo = [{ ...pax }];
  silo.custom = { fuel: SILO_FUEL_TURNS, fueling: false };
  s.current = 'A';

  const go = applyAction(s, { type: 'UNIT_ACTION', unitId: silo.id, actionId: 'silo:launch' });
  assert.ok(go.ok, go.ok ? '' : go.reason);
  assert.equal(go.state.units.some((u) => u.id === pax.id), false, '在途单位不在棋盘上');
  assert.equal((go.state.transit ?? []).length, 1, '但它在天上');
  // 地球与月球上都找不到它——不存在"同时出现在两张图"这回事
  for (const b of boardIds(go.state)) {
    assert.equal(
      go.state.units.some((u) => u.id === pax.id && boardIdOf(u) === b),
      false,
      `${b} 上不该有它`,
    );
  }
});

test('装卸按图：月球上装得上，跨图装不上', () => {
  /*
   * `LOAD` / `UNLOAD` 以前在门口一刀切 `offWorld`，月面和空间站都装卸不了。
   * 现在只认"同图 + 贴身"：跨图那一条才是真正要防的错（坐标再近也隔着天空）。
   */
  const s = fresh({ expansionIds: ['space-age'], startEra: 5 });
  flattenMoon(s);
  s.unitTypes['test-lander'] = {
    ...s.unitTypes.militia,
    id: 'test-lander',
    name: '登陆艇',
    move: 2,
    carry: { hold: { max: 2 } },
  };
  // 地球同一坐标上先放一个自己人：`place2` 按 (x,y) 去重，后摆会把月球那个人删掉
  const ghost = place2(s, 'A', 'militia', 4, 3);
  const ferry = onMoon(s, 'A', 'test-lander', 3, 3);
  const pax = onMoon(s, 'A', 'militia', 4, 3);
  s.current = 'A';
  refreshMemory(s);

  const cross = applyAction(s, { type: 'LOAD', unitId: ferry.id, cargoId: ghost.id });
  assert.equal(cross.ok, false, '跨图装不上');
  assert.ok(cross.ok === false && cross.reason.includes('同一张图'), `理由要说清是同图问题：${cross.ok ? '' : cross.reason}`);

  const same = applyAction(s, { type: 'LOAD', unitId: ferry.id, cargoId: pax.id });
  assert.ok(same.ok, `月面上该能装载：${same.ok ? '' : same.reason}`);
  assert.equal((same.state.units.find((u) => u.id === ferry.id)!.cargo ?? []).length, 1);
});

test('视图染色：可见集与格号都按图取', () => {
  /*
   * `onlyVisibleCells` 以前用 `idx(s, ...)`（地球的列宽）。地球 20 宽、月球 15 宽，
   * 同一个 (4,3) 在两张图上是不同的格号——按错宽度筛，颜色会整体错行。
   */
  const s = fresh({ expansionIds: ['space-age'], startEra: 5 });
  s.fog = true;
  const moon = s.boards!.moon!;
  const x = 4;
  const y = 3;
  const earthIdx = idx(s, x, y);
  const moonIdx = idxOn(s, 'moon', x, y);

  const cells = [{ x, y }];
  // 只把"月球那一格"放进可见集：按月球筛该命中
  assert.equal(onlyVisibleCells(s, [moonIdx], cells, 'moon').length, 1, '月球上那一格可见');
  if (earthIdx !== moonIdx) {
    // 换成地球的宽去筛，同一个坐标算出来是另一个格号（不命中）
    assert.equal(
      onlyVisibleCells(s, [moonIdx], cells, EARTH).length,
      0,
      '拿地球的宽度去筛月球的格号，不该命中',
    );
  }
  // 不传 board 的老行为不变：按地球算
  assert.equal(onlyVisibleCells(s, [earthIdx], cells).length, 1, '缺省还是地球');
  assert.ok(moon.w < s.w, `前提：月球比地球窄（${moon.w} < ${s.w}）`);
});

test('拆包：只开基础包时没有空间站，也没有「发射核心舱」', () => {
  /*
   * 两个包的分界线：基础包 = 月球 + 发射井 + 登月；太空战争 = 星图 + 空间站。
   * 只勾基础包时，井上不该出现"发射核心舱"，兵种表里也不该有核心舱——
   * 否则"简单登月"的玩家会平白多出一整套他看不懂的建筑。
   */
  const s = fresh({ expansionIds: ['space-age'], startEra: 5 });
  flatten(s, 'plain');
  s.players.A.gold = 9999;
  const silo = place2(s, 'A', SILO_ID, 5, 5);
  s.current = 'A';

  assert.equal(s.unitTypes[STATION_CORE_ID], undefined, '基础包不带核心舱兵种');
  const r = applyAction(s, { type: 'UNIT_ACTION', unitId: silo.id, actionId: 'silo:core:core-outpost' });
  assert.equal(r.ok, false, '基础包里没有这个动作');

  // 反过来：勾上战争包就有了（requires 满足）
  const war = fresh({ expansionIds: ['space-age', 'space-war'], startEra: 5 });
  assert.ok(war.unitTypes[STATION_CORE_ID], '战争包里核心舱要在');

  // 只勾战争包、不勾基础包：`requires` 应该把它整包滤掉
  const orphan = fresh({ expansionIds: ['space-war'], startEra: 5 });
  assert.equal(orphan.unitTypes[STATION_CORE_ID], undefined, '缺前置时战争包不该进场');
});

console.log('\n太空战争：空间站');

test('核心舱：发射后生成一张 5×5 的站，中心甲板、其余虚空', () => {
  /*
   * 核心舱发射**不加注、不装载**：地面上点火就入轨，只花资源。
   * 站棋盘是那一刻才生成的——所以这条也在验"投送可以没有棋盘"这个地基。
   */
  const s = fresh({ expansionIds: ['space-age', 'space-war'], startEra: 5 });
  flatten(s, 'plain');
  s.players.A.gold = 9999;
  const silo = place2(s, 'A', SILO_ID, 5, 5);
  s.current = 'A';

  const r = applyAction(s, { type: 'UNIT_ACTION', unitId: silo.id, actionId: 'silo:core:core-outpost' });
  assert.ok(r.ok, r.ok ? '' : r.reason);

  const rec = r.state.starmap!.stations[0];
  assert.ok(rec, '星图上要记下这座站');
  const b = r.state.boards![rec!.board]!;
  assert.equal(b.kind, 'station', 'kind 要是 station（面板据此不列它）');
  assert.equal(b.w, 5, '哨站核心舱 = 5×5');
  assert.equal(b.h, 5);

  const mid = 2;
  assert.equal(b.tiles[mid * 5 + mid]!.terrain, 'deck', '正中间是甲板');
  assert.equal(
    b.tiles.filter((t) => t.terrain === 'void').length,
    24,
    '其余全是虚空',
  );

  const core = r.state.units.find((u) => u.type === STATION_CORE_ID);
  assert.ok(core, '核心舱要在场上');
  assert.equal(boardIdOf(core!), rec!.board);
  assert.deepEqual([core!.x, core!.y], [mid, mid], '站在正中间');
  assert.equal(core!.acted, true, '刚入轨这一回合不能走动/攻击');
});

test('太空建设折扣：0 座井贵一半，井越多越便宜、但边际递减', () => {
  /*
   * `rate(n) = 0.5 - 0.8^n`：0 井 −50%、1 井 −30%、2 井 −14%……
   * 关键不是这几个数，而是**每多一座井的收益在变小**，且永远不到 +50%。
   */
  const s = fresh({ expansionIds: ['space-age', 'space-war'], startEra: 5 });
  flatten(s, 'plain');
  s.current = 'A';

  assert.equal(siloWeight(s, 'A'), 0);
  assert.ok(Math.abs(buildRate(s, 'A') - -0.5) < 1e-9, '0 座井：贵 50%');
  assert.equal(buildCost(s, 'A', 100), 150, '100 金的额定 → 150 金');

  // 摆两座建好的井（工地不算，见 siloWeight 的注释）
  const a = place2(s, 'A', SILO_ID, 4, 4);
  const b2 = place2(s, 'A', SILO_ID, 8, 8);
  for (const x of [a, b2]) {
    delete x.buildNeed;
    delete x.buildDone;
  }
  const r2 = buildRate(s, 'A');
  assert.ok(Math.abs(r2 - -0.14) < 1e-9, `2 座井该是 −14%，实际 ${(r2 * 100).toFixed(1)}%`);
  assert.equal(buildCost(s, 'A', 100), 114);

  // 边际递减：第 1→2 座的收益 > 第 2→3 座
  const r1 = 0.5 - Math.pow(0.8, 1);
  const r3 = 0.5 - Math.pow(0.8, 3);
  assert.ok(r2 - r1 > r3 - r2, '每多一座井的收益必须递减');
  assert.ok(r3 < 0.5, '3 座井还没到 +50%');
  assert.ok(Math.pow(0.8, 1000) > 0, '0.8^n 永远大于 0，所以折扣永远到不了 +50%（软上限）');
});

test('扩建：选一格相邻虚空铺成甲板，不相邻的铺不了', () => {
  const s = fresh({ expansionIds: ['space-age', 'space-war'], startEra: 5 });
  flatten(s, 'plain');
  s.players.A.gold = 9999;
  const silo = place2(s, 'A', SILO_ID, 5, 5);
  s.current = 'A';
  const made = applyAction(s, { type: 'UNIT_ACTION', unitId: silo.id, actionId: 'silo:core:core-outpost' });
  assert.ok(made.ok, made.ok ? '' : made.reason);

  const rec = made.state.starmap!.stations[0]!;
  const core = made.state.units.find((u) => u.type === STATION_CORE_ID)!;
  const goldBefore = made.state.players.A.gold;

  // 挨着中心的那一格：可以铺
  const ok = applyAction(made.state, {
    type: 'HERO_SKILL',
    unitId: core.id,
    skillId: 'station-expand',
    targetX: 3,
    targetY: 2,
  });
  assert.ok(ok.ok, ok.ok ? '' : ok.reason);
  const board = ok.state.boards![rec.board]!;
  assert.equal(board.tiles[2 * board.w + 3]!.terrain, 'deck', '那一格变成甲板');
  assert.ok(ok.state.players.A.gold < goldBefore, '要扣钱');

  // 角落的虚空不挨着任何甲板：铺不了
  const far = applyAction(ok.state, {
    type: 'HERO_SKILL',
    unitId: core.id,
    skillId: 'station-expand',
    targetX: 0,
    targetY: 0,
  });
  assert.equal(far.ok, false, '不能凭空在角落铺');
});

test('生产舱：造在空甲板上，每回合产金', () => {
  const s = fresh({ expansionIds: ['space-age', 'space-war'], startEra: 5 });
  flatten(s, 'plain');
  s.players.A.gold = 9999;
  const silo = place2(s, 'A', SILO_ID, 5, 5);
  s.current = 'A';
  const made = applyAction(s, { type: 'UNIT_ACTION', unitId: silo.id, actionId: 'silo:core:core-outpost' });
  assert.ok(made.ok, made.ok ? '' : made.reason);
  const core = made.state.units.find((u) => u.type === STATION_CORE_ID)!;

  // 先铺一格空甲板，再造生产舱
  const paved = applyAction(made.state, {
    type: 'HERO_SKILL', unitId: core.id, skillId: 'station-expand', targetX: 3, targetY: 2,
  });
  assert.ok(paved.ok, paved.ok ? '' : paved.reason);
  const built = applyAction(paved.state, {
    type: 'HERO_SKILL', unitId: core.id, skillId: 'station-build', targetX: 3, targetY: 2,
  });
  assert.ok(built.ok, built.ok ? '' : built.reason);

  const maker = built.state.units.find((u) => u.type === STATION_PRODUCER_ID);
  assert.ok(maker, '生产舱要在场上');
  assert.equal(boardIdOf(maker!), boardIdOf(core), '在自己的站上');

  // 产出：直接调 tickProducers，免得被城市的收入混进来
  const before = built.state.players.A.gold;
  tickProducers(built.state, 'A');
  assert.equal(built.state.players.A.gold, before + PRODUCER_INCOME, '每座生产舱 +6 金');
});

test('空间站上的东西按站结算：虚空不可通行、甲板能站', () => {
  /*
   * 虚空是"这里还没有东西"，不是一种地形——所以它必须挡人。
   * 如果它能走，整个"扩建"就没有意义了。
   */
  const s = fresh({ expansionIds: ['space-age', 'space-war'], startEra: 5 });
  flatten(s, 'plain');
  s.players.A.gold = 9999;
  const silo = place2(s, 'A', SILO_ID, 5, 5);
  s.current = 'A';
  const made = applyAction(s, { type: 'UNIT_ACTION', unitId: silo.id, actionId: 'silo:core:core-outpost' });
  assert.ok(made.ok, made.ok ? '' : made.reason);

  const rec = made.state.starmap!.stations[0]!;
  const b = made.state.boards![rec.board]!;
  const mid = (b.w - 1) / 2;
  assert.equal(b.tiles[mid * b.w + mid]!.terrain, 'deck');
  assert.equal(b.tiles[0]!.terrain, 'void');
  // 虚空没有地形消耗（99 = 不可通行），甲板是 1
  assert.ok(CONFIG.terrainCost.void >= 99, '虚空不可通行');
  assert.equal(CONFIG.terrainCost.deck, 1, '甲板正常走');
});

test('两个扩展都挂单位动作时：谁列的按钮谁执行', () => {
  /*
   * 以前 `doUnitAction` 取"第一个声明了 unitActions 的扩展"。太空包在扩展表里
   * 排在修真之前，所以它一挂上单位动作，修真的学法术/炼丹药就会被它一口回绝，
   * 而且报的是"认不出这个操作"——跟玩家的操作毫无关系。
   *
   * 现在的判据是"谁在 unitActions 里列出了这个 id 就由谁执行"，这条守它。
   */
  const s = fresh({ expansionIds: ['space-age', 'cultivation'], startEra: 5 });
  flatten(s, 'plain');
  place2(s, 'A', 'cultivation-sect', 6, 6);
  place2(s, 'A', 'cultivation-scripture-pavilion', 8, 6);
  const cult = place2(s, 'A', 'qi-cultivator', 9, 6);

  const offered = activeExpansions(s).flatMap(
    (e) => e.hooks.unitActions?.({ state: s, unit: cult, viewer: 'A' }) ?? [],
  );
  const learn = offered.find((o) => o.id.startsWith('learn:'));
  assert.ok(learn, '修士站在藏经阁旁该有「学法术」按钮');

  const r = applyAction(s, { type: 'UNIT_ACTION', unitId: cult.id, actionId: learn!.id });
  assert.notEqual(
    r.reason,
    '当前规则里没有这种操作',
    '这个动作该被修真包接手，而不是被太空包挡掉',
  );
});

test('月球图：尺寸跟着地球缩，下限 4×4', () => {
  assert.equal(MOON_MIN_SIZE, 4);
  assert.equal(moonSizeFor(4), 4, '已经是下限，不能再小');
  assert.equal(moonSizeFor(5), 4, '四舍五入到 4');
  assert.equal(moonSizeFor(12), 9);
  assert.equal(moonSizeFor(16), 12);
  assert.equal(moonSizeFor(32), 24);
  assert.equal(moonSizeFor(64), 48);
  // 任何尺寸下都不该比地球还大
  for (const n of [4, 5, 8, 12, 16, 24, 32, 48, 64]) {
    assert.ok(moonSizeFor(n) <= n, `${n} 的月球不该比地球大`);
  }
});

test('月球图：只有月壤与环形山，同种子同结果', () => {
  const b = createMoonBoard(32, 4242);
  assert.equal(b.w, 24);
  assert.equal(b.h, 24);
  assert.equal(b.tiles.length, 24 * 24);
  assert.equal(b.kind, 'planet');

  // 地形只有两种，而且月球上不放城
  assert.ok(
    b.tiles.every((t) => t.terrain === 'regolith' || t.terrain === 'crater'),
    '月球只该有月壤和环形山',
  );
  assert.ok(b.tiles.every((t) => t.cityId === null), '月球上不放城');

  const craters = b.tiles.filter((t) => t.terrain === 'crater').length;
  assert.ok(craters > 0, '至少有一个环形山');
  assert.ok(craters <= Math.floor(24 * 24 * 0.6), '环形山不该吃掉大半张图');

  // 同一个种子必须生成一模一样的地貌（存档 / 回放 / 联机靠这条）
  const sig = (x: Board): string => x.tiles.map((t) => t.terrain[0]).join('');
  assert.equal(sig(createMoonBoard(32, 4242)), sig(b), '同种子同结果');
  assert.notEqual(sig(createMoonBoard(32, 9999)), sig(b), '换种子该换地貌');

  // 最小的月球也要留得下脚
  const tiny = createMoonBoard(4, 7);
  assert.equal(tiny.w, 4);
  assert.ok(tiny.tiles.some((t) => t.terrain === 'regolith'), '4×4 上也要有落脚点');
});
}

// 单独运行时自己收尾（判据走 pathToFileURL：Windows 上拼 file:// 会永远不相等，
// 结果整套用例静默跑 0 项却是绿的——修真那边踩过这个坑）
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run();
  console.log(`\n通过 ${stats.passed} 项，失败 ${stats.failed} 项\n`);
  if (stats.failed > 0) process.exit(1);
}
