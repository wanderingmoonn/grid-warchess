/**
 * 界面冒烟测试。
 *
 * 规则内核有单元测试兜底，但渲染层没人管。
 * 这里用 jsdom 把整页跑一遍，确认：
 *   1. 首屏能渲染出完整棋盘、城市方块、双方棋子，不白屏
 *   2. 点棋子能算出移动范围，点可达格能真的走
 *   3. 点城市能打开产兵面板，能真的出兵
 *   4. 点结束回合会弹出交接遮罩
 *   5. 迷雾确实把敌方单位挡在视图外
 *
 * jsdom 里没有布局，所以这里验证的是"结构和状态流转"，不是"好不好看"。
 *
 * 运行：npm run test:ui
 */

import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { UNIT_TYPES } from '../src/core/config.ts';
import { playerView } from '../src/core/fog.ts';
import { addMark } from '../src/core/marks.ts';
import { EXPANSIONS, unitSourceIdOf } from '../src/core/expansions.ts';
import { draftScreenHtml } from '../src/ui/draft-panel.ts';
import { draftAlwaysAllowed, remainingUnits, upgradeUnlocks } from '../src/core/draft.ts';
import { abilityById } from '../src/core/ability-registry.ts';
import { createMatch, DEFAULT_CONFIG } from '../src/core/setup.ts';
import { buildMatchReport } from '../src/core/report.ts';
import {
  applyAction,
  cityTiles,
  effectiveStats,
  reachableTiles,
  refreshMemory,
  unitsOf,
  unitYieldAt,
} from '../src/core/rules.ts';
import { renderPanel, topbarShell } from '../src/ui/panel.ts';
import { applyUiTheme, resolveUiMode, setUiMode } from '../src/ui/theme.ts';
import { settingsHtml } from '../src/ui/settings.ts';
import { skillTargetPicked } from '../src/ui/skill-aim.ts';
import { TERRAIN_INFO } from '../src/core/info.ts';
import { CONFIG } from '../src/core/config.ts';
import { openTitle } from '../src/ui/title-screen.ts';
import {
  tutorialAllowsMove,
  tutorialBlocking,
  tutorialGoto,
  tutorialExit,
  tutorialOn,
  tutorialSnapshot,
  tutorialStart,
  tutorialStep,
  tutorialTick,
} from '../src/ui/tutorial.ts';
import { createTutorialMatch } from '../src/core/tutorial.ts';
import { buildBattleCard, battleCardText } from '../src/core/battle-card.ts';
import { drawBattleCard, openBattleCard } from '../src/ui/battle-card.ts';
import { godBarHtml, godShelfHtml } from '../src/ui/god-panel.ts';
import { coordsFromEvent, renderBoard } from '../src/ui/board.ts';
import { __setArtIndexForTest, setUiArt, uiArtOn } from '../src/ui/unit-art.ts';
import { scopeBoardUi } from '../src/ui/board-scope.ts';
import { hasStarRows, starRows } from '../src/ui/star-panel.ts';
import { starLayout } from '../src/ui/star-layout.ts';
import { renderStarMap } from '../src/ui/star-map.ts';
import { EARTH } from '../src/core/board.ts';
import type { BoardUi } from '../src/ui/board.ts';
import { bindChatComposer } from '../src/ui/chat-input.ts';
import { manualBooks } from '../src/ui/books.ts';
import type { Unit } from '../src/core/types.ts';

const result = await build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  format: 'iife',
  write: false,
  loader: { '.css': 'text' },
  target: 'es2022',
  logLevel: 'silent',
});

const code = result.outputFiles[0]?.text;
assert.ok(code, '打包失败');

const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
  runScripts: 'outside-only',
});

const { window } = dom;
if (!window.structuredClone) {
  (window as unknown as { structuredClone: typeof structuredClone }).structuredClone = structuredClone;
}

// 首局用的是 Math.random() 派生的种子。不钉死的话，换个种子就可能多看见一个
// 敌人、多一座山，测试随机变红——这个套件已经这样飘过两次了。
let seedPick = 0;
const SEED_PICKS = [0.137, 0.421, 0.639, 0.911, 0.283, 0.774, 0.058, 0.365];
(window.Math as Math).random = () => SEED_PICKS[seedPick++ % SEED_PICKS.length]!;

/**
 * jsdom 没有 ResizeObserver，而 main.ts 拿它决定"这一帧要不要重新量棋盘"：
 * 没有它就走"每帧都量"的老路——那条路上，档位和 DOM 永远不会脱钩，
 * 于是"放大之后缩不回去""换局也缩不回去"在测试里根本复现不出来，
 * 用例不管怎么改都是绿的。这里补一个只记账、不自己触发的假观察者，
 * 让代码走真实浏览器那条分支（改了尺寸得有人标脏，否则不重量）。
 */
class FakeResizeObserver {
  private readonly cb: () => void;
  constructor(cb: () => void) {
    this.cb = cb;
  }
  observe(): void {
    // 真浏览器 observe 之后会立刻回一次；这里不必，首帧本来就是脏的
    void this.cb;
  }
  unobserve(): void {}
  disconnect(): void {}
}
(window as unknown as { ResizeObserver: unknown }).ResizeObserver = FakeResizeObserver;

window.eval(code);

const doc = window.document;
let passed = 0;
let failed = 0;

function check(name: string, fn: () => void): void {
  try {
    fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  FAIL ${name}\n       ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * 异步用例。
 *
 * 和 check 分开是刻意的：如果把 check 改成 async，所有同步用例的
 * "ok" 会挤到微任务里打印，输出顺序全乱，出问题根本对不上是哪一条。
 */
async function checkAsync(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  FAIL ${name}\n       ${err instanceof Error ? err.message : String(err)}`);
  }
}

function click(sel: string): void {
  const el = doc.querySelector<HTMLElement>(sel);
  assert.ok(el, `找不到元素 ${sel}`);
  el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
}

/**
 * 回首页。
 *
 * 2026-11-11 起「回首页」不再单独挂在顶栏上，而是收进「设置」弹窗
 * （规则书/反馈/导出/回首页 都是"想起来才点一次"的东西）。用例里要回门面，
 * 统一走这一个 helper，别每处各写一遍开弹窗的三步。
 */
function goHome(): void {
  click('[data-act="settings"]');
  // 弹窗里的那一条（刚才全局替换把它也换成了 goHome，自己调自己——栈直接爆）
  const btn = doc.querySelector<HTMLElement>('[data-act="new-game"]');
  assert.ok(btn, '设置弹窗里应该有「回首页」');
  btn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
}

function unitsCount(): number {
  return doc.querySelectorAll('.unit').length;
}

console.log('\n首屏渲染');

check('默认棋盘是青铜标准尺寸 12×12，铺满 144 格', () => {
  // 时代和棋盘尺寸是配套的：青铜 12×12、铁器 16×16、火器及以后 20×20
  assert.equal(doc.querySelectorAll('.tile').length, 144);
});

check('首屏只渲染己方棋子，敌方在视野外被裁掉', () => {
  assert.equal(doc.querySelectorAll('.unit.owner-A').length, 7, '5 个战斗单位 + 2 个经济单位');
  // 12×12 的标准图上两军离得近，偶尔能看见一个贴边的敌人——那是正常的。
  // 这条断言要守的是"看不全"，不是"一个都看不见"。
  const foe = doc.querySelectorAll('.unit.owner-B').length;
  assert.ok(foe <= 2, `敌方不该整队出现，实际看见 ${foe} 个`);
});

check('月面选中单位时，可攻击目标不能整组清空', () => {
  /*
   * 实机反馈：「拉到月球上之后点自己的兵，没有可攻击格，敌人也点不动」。
   *
   * 根因不在规则层（`attackableTargets` 早就按图算了），而是渲染前的那一步
   * `scopeBoardUi` 对**非地球图**无条件把 `targets` 清空——数据被界面扔了。
   * 这条守的就是"选中的单位在哪张图上，那张图的高亮就照用"。
   */
  const ui = {
    selectedId: 'm1',
    reach: [1, 2, 3],
    targets: ['e1'],
    siegeTargets: [],
    aimTiles: [],
    skillThreatTiles: [],
    selectedCityId: null,
    placeable: [],
    threat: [5],
    heat: new Map([[7, 2]]),
    incomeHints: new Map(),
  } as unknown as BoardUi;
  const moonUnit = { id: 'm1', type: 'militia', owner: 'A' as const, x: 2, y: 2, hp: 10, kills: 0, moved: false, acted: false, board: 'moon' };
  // 地球单位**没有** board 字段（缺省即地球），别从月球那个对象里 spread 出 board
  const earthUnit = { id: 'm2', type: 'militia', owner: 'A' as const, x: 2, y: 2, hp: 10, kills: 0, moved: false, acted: false };

  // 选中的兵在月球：高亮留着
  const onMoon = scopeBoardUi(ui, 'moon', [moonUnit as never, earthUnit as never]);
  assert.deepEqual(onMoon.targets, ['e1'], '月面上的可攻击目标要留着，否则点不动');
  assert.deepEqual(onMoon.reach, [1, 2, 3], '可达格同理');
  assert.deepEqual(onMoon.threat, [5], '威胁圈同理');
  assert.equal(onMoon.heat, undefined, '战况烈度只认地球格号，别画到月球上');

  // 选中的兵在地球、正在看月球：一律清空（不能把地球的格号画过去）
  const earthSel = scopeBoardUi({ ...ui, selectedId: 'm2' } as BoardUi, 'moon', [moonUnit as never, earthUnit as never]);
  assert.deepEqual(earthSel.targets, [], '不是这张图上的人，高亮必须清空');
  assert.equal(earthSel.selectedId, null);

  // 地球那张图不做任何换算（老路径原样返回）
  const onEarth = scopeBoardUi(ui, EARTH, [earthUnit as never]);
  assert.equal(onEarth, ui, '地球直接返回原对象，零开销');
});

check('只有一张地图时，左上角的星图面板整个收起来', () => {
  /*
   * 玩家反馈两次：没开太空扩展也能看见那个"选择星球"的按钮。
   * 它本来是给"地球 / 月球切换 + 看在途"用的，只有地球时就是一个永远只有一个
   * 选项的按钮，占着角落还挡地图。
   *
   * 判据是"这一局有几张图"（`boardIds().length`），不是"有没有开某个扩展"。
   *
   * 这次不再只靠 `.board-list.single` 那个类：类样式会被 `display:flex`
   * 或别处覆盖层吃掉（上一版就是这么"看起来改了却没生效"的），
   * 所以直接写内联 `display:none`，测试断言的就是这个。
   */
  const el = doc.querySelector<HTMLElement>('#board-list');
  assert.ok(el, '容器本身还在（只是不显示）');
  assert.equal(el!.style.display, 'none', '单图时要直接内联隐藏（不依赖 CSS 类）');
  assert.ok(el!.classList.contains('single'), 'single 类留作 CSS 兜底');
  assert.equal(el!.children.length, 0, '单图时一个按钮都不该建出来');
});

check('星图面板的取数：相连与在途（纯函数，不需要 DOM）', () => {
  /*
   * 面板本身在 jsdom 里不好复现（要开太空扩展、还要造一张月球），
   * 所以把"该显示什么"抽成 `starRows`。它错了的表现是"节点名写成 id"、
   * "在途显示 -1 回合"——都是只会在实机被玩家发现的那种。
   */
  const st = {
    players: { A: { name: '红方' }, B: { name: '蓝方' } },
    starmap: {
      nodes: [
        { id: 'earth', kind: 'planet', board: 'earth', name: '地球' },
        { id: 'moon', kind: 'moon', board: 'moon', name: '月球' },
      ],
      lanes: [{ id: 'earth-moon', a: 'earth', b: 'moon', turns: 1 }],
      stations: [],
      seq: 0,
    },
    transit: [{ id: 't1', owner: 'B', lane: 'earth-moon', from: 'earth', to: 'moon', left: 1, cargo: [] }],
  } as never;

  const r = starRows(st);
  assert.deepEqual(r.lanes, [{ a: '地球', b: '月球', turns: 1 }], '航道要写名字，不是 id');
  assert.deepEqual(r.trips, [{ owner: 'B', who: '蓝方', to: '月球', left: 1 }], '在途要带玩家名');

  // 没有星图也没有在途：整块不占位（单图局就是这个状态）
  assert.equal(hasStarRows(starRows({ players: { A: { name: '红方' } } } as never)), false);
});

check('星图布局：地球居中、其余节点在外圈，坐标是算出来的', () => {
  /*
   * 布局不进存档（见 ui/star-layout.ts 开头）：同一组节点必须永远算出同一个位置，
   * 否则加一张图就会让老局面错位。
   */
  const base = {
    players: { A: { name: '红方' } },
    boards: {
      moon: { id: 'moon', kind: 'moon', name: '月球', w: 5, h: 5, tiles: [] },
      s1: { id: 's1', kind: 'station', name: '前哨站', w: 5, h: 5, tiles: [] },
    },
    starmap: {
      nodes: [
        { id: 'earth', kind: 'planet', board: 'earth', name: '地球' },
        { id: 'moon', kind: 'moon', board: 'moon', name: '月球' },
        { id: 'o1', kind: 'orbit', name: '轨道一' },
      ],
      lanes: [
        { id: 'earth-moon', a: 'earth', b: 'moon', turns: 1 },
        { id: 'moon-o1', a: 'moon', b: 'o1', turns: 2 },
      ],
      stations: [{ board: 's1', at: 'moon', owner: 'A', core: 'core-1' }],
      seq: 1,
    },
  } as never;

  const lay = starLayout(base)!;
  assert.equal(lay.size, 5, '三个节点用 5×5 就够');
  const earth = lay.nodes.find((n) => n.id === 'earth')!;
  assert.deepEqual([earth.x, earth.y], [2, 2], '地球在正中');
  const moon = lay.nodes.find((n) => n.id === 'moon')!;
  assert.deepEqual([moon.x, moon.y], [4, 2], '第一个外圈节点在右侧');
  assert.equal(moon.stations.length, 1, '停泊的站挂在节点上');
  assert.equal(lay.lanes.length, 2, '两条航线都连上了');
  // 再算一次：同一组节点必须得到同一个布局
  assert.deepEqual(starLayout(base), lay, '布局必须是确定的');

  // 只有地球：没有星图可言
  assert.equal(
    starLayout({
      players: {},
      boards: {},
      starmap: { nodes: [{ id: 'earth', kind: 'planet', board: 'earth', name: '地球' }], lanes: [], stations: [], seq: 0 },
    } as never),
    null,
    '只有一张图时不画星图',
  );
});

check('星图渲染：每条航线都带一根可点的命中条', () => {
  /*
   * 上一版把点击挂在 SVG 的 `<line>` 上，实机点不到（父级 pointer-events:none
   * 想让子元素覆盖，依赖太多细节）。现在改成普通 DOM 的透明长条——这条用例
   * 钉住"渲染时确实生成了它"，不然又退回只能看、不能点。
   */
  const st = {
    players: { A: { name: '红方' } },
    units: [],
    transit: [],
    boards: { moon: { id: 'moon', kind: 'moon', name: '月球', w: 5, h: 5, tiles: [] } },
    starmap: {
      nodes: [
        { id: 'earth', kind: 'planet', board: 'earth', name: '地球' },
        { id: 'moon', kind: 'moon', board: 'moon', name: '月球' },
      ],
      lanes: [{ id: 'earth-moon', a: 'earth', b: 'moon', turns: 1 }],
      stations: [],
      seq: 0,
    },
  } as never;
  const view = { state: st, visible: [], visibleByBoard: {}, ghosts: [] } as never;

  const host = doc.createElement('div');
  renderStarMap(host, view, 'A', null);
  const taps = host.querySelectorAll('[data-act="star-lane"]');
  assert.equal(taps.length, 1, `每条航线都要有命中条，实际 ${taps.length}`);
  assert.equal(host.querySelectorAll('.sm-sail').length, 0, '没有船在走就不该有三角');
  assert.equal((taps[0] as HTMLElement).dataset.id, 'earth-moon');
  assert.equal(host.querySelectorAll('.sm-lane-line').length, 1, '线本身还在（只负责好看）');
  assert.equal(host.querySelectorAll('[data-act="star-node"]').length, 2, '两个节点都可点');

  // 同一份数据重画一次：签名挡住，DOM 不重建（点击不会被打断）
  const before = taps[0];
  renderStarMap(host, view, 'A', null);
  assert.equal(host.querySelectorAll('[data-act="star-lane"]')[0], before, '内容没变就不该重建');
});

check('虚空与甲板：地形表齐了，选点型技能不依赖高亮', () => {
  /*
   * 空间站的两格必须在地形表里有名字与说明——否则点开它们只会看到
   * "undefined"，或者干脆什么都不显示。
   *
   * 后半段钉的是"选点型技能不看 aimTiles"：在非地球图上高亮列表以前是空的，
   * 但点下去仍然应该算选定（真正的合法性由规则层判）。这个区分很重要——
   * 上一轮把"点不中"归咎于格号算错，方向就偏了。
   */
  assert.equal(TERRAIN_INFO.void.name, '虚空');
  assert.equal(TERRAIN_INFO.deck.name, '甲板');
  assert.ok(CONFIG.terrainCost.void >= 99, '虚空不可通行');
  assert.equal(CONFIG.terrainCost.deck, 1, '甲板正常走');

  assert.equal(
    skillTargetPicked({ targeting: 'point', onSelf: false, aimTiles: [], cell: 7 }),
    true,
    '选点型没有高亮也该算选中',
  );
  assert.equal(
    skillTargetPicked({ targeting: 'point', onSelf: true, aimTiles: [], cell: 7 }),
    false,
    '点自己脚下 = 取消',
  );
});

check('星图：航行中的站还挂在出发地，并带上目标节点', () => {
  /*
   * 站的"位置转移"只改 `at`，到港才改。所以飞行期间它在星图上**还在原地**，
   * 但带一个"正在驶向"的标记——不标的话玩家会以为它凭空消失了。
   */
  const st = {
    players: { A: { name: '红方' } },
    boards: {
      moon: { id: 'moon', kind: 'moon', name: '月球', w: 5, h: 5, tiles: [] },
      s1: { id: 's1', kind: 'station', name: '前哨站', w: 5, h: 5, tiles: [] },
    },
    starmap: {
      nodes: [
        { id: 'earth', kind: 'planet', board: 'earth', name: '地球' },
        { id: 'moon', kind: 'moon', board: 'moon', name: '月球' },
      ],
      lanes: [{ id: 'earth-moon', a: 'earth', b: 'moon', turns: 1, distance: 6 }],
      stations: [
        { board: 's1', at: 'earth', owner: 'A', core: 'core-outpost', travel: { lane: 'earth-moon', from: 'earth', to: 'moon', left: 2 } },
      ],
      seq: 1,
    },
  } as never;

  const lay = starLayout(st)!;
  const earth = lay.nodes.find((n) => n.id === 'earth')!;
  const moon = lay.nodes.find((n) => n.id === 'moon')!;
  assert.equal(earth.stations.length, 1, '飞行期间还挂在出发地');
  assert.equal(earth.stations[0]!.travelTo, 'moon', '要写明正驶向哪儿');
  assert.equal(moon.stations.length, 0, '还没到，不算停在月球');
  assert.equal(earth.stations[0]!.name, '前哨站');
});

check('星图：航道上真的画出航行中的站（小三角）', () => {
  /*
   * 用户反馈："空间站飞行过程中，星图的航线里找不到它，描述还是空置描述"。
   * 所以这条钉两件事：航线上有那枚三角，且卡片文字不再说"路上没有东西"。
   * （卡片那段是 `main.ts::starPanelInfo`，这里只验渲染产物。）
   */
  const st = {
    players: { A: { name: '红方' } },
    units: [],
    transit: [],
    boards: {
      moon: { id: 'moon', kind: 'moon', name: '月球', w: 5, h: 5, tiles: [] },
      s1: { id: 's1', kind: 'station', name: '前哨站', w: 5, h: 5, tiles: [] },
    },
    starmap: {
      nodes: [
        { id: 'earth', kind: 'planet', board: 'earth', name: '地球' },
        { id: 'moon', kind: 'moon', board: 'moon', name: '月球' },
      ],
      lanes: [{ id: 'earth-moon', a: 'earth', b: 'moon', turns: 1, distance: 6 }],
      stations: [
        {
          board: 's1',
          at: 'earth',
          owner: 'A',
          core: 'core-outpost',
          travel: { lane: 'earth-moon', from: 'earth', to: 'moon', left: 1, total: 2 },
        },
      ],
      seq: 1,
    },
  } as never;

  const host = doc.createElement('div');
  renderStarMap(host, { state: st, visible: [], visibleByBoard: {}, ghosts: [] } as never, 'A', null);
  const sails = host.querySelectorAll('.sm-sail');
  assert.equal(sails.length, 1, `航道上要画一枚三角，实际 ${sails.length}`);
  const tip = sails[0]!.querySelector('title')?.textContent ?? '';
  assert.ok(tip.includes('前哨站'), `三角的提示要写清是哪座站：${tip}`);
  assert.ok(tip.includes('50%'), `走了一半要写 50%：${tip}`);
  /*
   * 尖头指向**目的地**：三角要跟着航线旋转。
   * 这条航线是水平的（earth → moon 在右边），所以角度是 0，
   * 只验"有 rotate"，方向由 `points` 的尖头在 +x 保证。
   */
  const tf = sails[0]!.getAttribute('transform') ?? '';
  assert.ok(tf.includes('translate'), `位置要按进度插值：${tf}`);
  assert.ok(tf.includes('rotate('), `三角要跟着航线指向终点：${tf}`);
  const poly = sails[0]!.querySelector('polygon')!.getAttribute('points') ?? '';
  assert.ok(poly.trim().startsWith('0.12,0'), `尖头要在 +x（朝终点）：${poly}`);
});

check('地形类正确分布', () => {
  // 地图现在是随机的，具体几格水/几座山每局都不同，
  // 所以只验证"确实有地形变化"和"城市格数固定"。
  const total = doc.querySelectorAll('.tile').length;
  const special =
    doc.querySelectorAll('.tile.t-water').length +
    doc.querySelectorAll('.tile.t-mountain').length +
    doc.querySelectorAll('.tile.t-forest').length +
    doc.querySelectorAll('.tile.t-hill').length +
    doc.querySelectorAll('.tile.t-city').length;
  assert.ok(special <= total, '特殊地形不该超过总格数');
  assert.equal(doc.querySelectorAll('.tile.t-city').length, 16, '4 座城市各占 4 格');
  assert.ok(special > 16, `除了城市之外应该有地形变化，实际只有 ${special - 16} 格`);
});

check('四个城市方块都渲染出来了', () => {
  assert.equal(doc.querySelectorAll('.city-block').length, 4);
  assert.equal(doc.querySelectorAll('.city-block.owner-A').length, 2);
  assert.equal(doc.querySelectorAll('.city-block.owner-B').length, 2);
});

check('城市带着血条、护甲和时代标记', () => {
  assert.equal(doc.querySelectorAll('.city-hp').length, 4);
  const armor = doc.querySelector('.city-armor')?.textContent ?? '';
  assert.ok(armor.includes('甲'), `护甲标记内容：${armor}`);
  const era = doc.querySelector('.city-era')?.textContent ?? '';
  assert.equal(era, 'I', '开局城市应该是时代 I');
});

check('侧栏渲染出卡片和结束按钮', () => {
  assert.ok(doc.querySelectorAll('.side .card').length >= 3);
  assert.ok(doc.querySelector('[data-act="end-turn"]'));
});

check('迷雾开启时视野外格子被标记', () => {
  assert.ok(doc.querySelectorAll('.tile.out').length > 0, '应该有视野外的格子');
});

/**
 * 布局契约：开局面板在窄屏 / 矮屏里必须"滚得动"。
 *
 * jsdom 不做布局，这里能验证的只有**样式表里的那几条关键声明还在**。
 * 但这就够了——2026-11-02 那次"手机上点新对局拉不下去"的根因正是这三条：
 *
 *   1. `.modal-mask` 只有一个隐式 grid 列（auto）→ 被内容撑到 980px，
 *      面板比屏幕还宽，右边直接切出屏幕；
 *   2. `.start-col` 没写 `min-height: 0`（纵向排列时它是 flex 子项，
 *      默认 min-height:auto 会撑到内容那么高，里面的滚动区就没有可缩小的余地）；
 *   3. 手机档把高度写成 `min(760px, 94dvh)`，矮窗口里仍然顶出去。
 *
 * 三条任意一条被删掉，这个 bug 就会回来，所以在样式表上钉住。
 */
check('布局契约：窄屏/矮屏的开局面板能滚（样式表里那三条关键声明）', () => {
  const css = readFileSync('src/style.css', 'utf8');
  /** 取某条选择器的声明块（够用：这些选择器在文件里只出现一次） */
  const block = (sel: string): string => {
    const i = css.indexOf(sel);
    if (i < 0) return '';
    const open = css.indexOf('{', i);
    const close = css.indexOf('}', open);
    return open < 0 || close < 0 ? '' : css.slice(open + 1, close);
  };

  assert.ok(
    /grid-template-columns:\s*minmax\(0,\s*1fr\)/.test(block('.modal-mask')),
    '遮罩必须把网格列钉成 minmax(0,1fr)，否则面板会被内容撑得比屏幕宽',
  );
  assert.ok(
    /min-height:\s*0/.test(block('.start-col')),
    '.start-col 少了 min-height:0，窄屏下面板就滚不动',
  );

  // 同一个选择器在文件里出现两次（基础 + 窄屏档），取"声明块里写了 100%"的那一条
  const panelBlocks: string[] = [];
  for (let i = css.indexOf('.modal.start-panel'); i >= 0; i = css.indexOf('.modal.start-panel', i + 1)) {
    const open = css.indexOf('{', i);
    const close = css.indexOf('}', open);
    if (open > 0 && close > open) panelBlocks.push(css.slice(open + 1, close));
  }
  assert.ok(
    panelBlocks.some((b) => /height:\s*100%/.test(b)),
    '窄屏档的面板高度要用 100%（跟着遮罩走），别再写死 dvh',
  );
  assert.ok(
    css.includes('@media (max-height: 560px)'),
    '矮窗口（横屏手机 / 被压扁的预览区）要有单独一档',
  );

  // 兵种池是盖在面板上的一层：它得照着 .modal 定位，而且里面那块要能自己滚，
  // 否则两百多个 chip 会把弹层顶穿、底下两颗批量按钮跑出屏幕。
  assert.ok(
    /position:\s*absolute/.test(block('.pool-layer')) && /inset:\s*0/.test(block('.pool-layer')),
    '兵种池弹层要 position:absolute + inset:0 才盖得住面板',
  );
  assert.ok(
    /min-height:\s*0/.test(block('.pool-body')) && /overflow-y:\s*auto/.test(block('.pool-body')),
    '.pool-body 少了 min-height:0 / overflow-y:auto，兵种池就滚不动',
  );
});

check('浓雾扩展：视野外的地形和敌城都不渲染', () => {
  // 两档雾的区别要守住：
  //   基础规则 —— 雾只遮单位，地形永远画出来，视野外只是压暗（.tile.out）；
  //   浓雾扩展 —— 连地形和城市一起遮掉，视野外只剩 .tile.unknown。
  const mkBoard = (expansionIds: string[]) => {
    const host = doc.createElement('div');
    host.className = 'board';
    doc.body.appendChild(host);
    // 用 16×16：12×12 上双方靠得太近，己方视野就能覆盖到敌城边缘，
    // 那样根本测不出"城市被雾遮住"这件事
    const s2 = createMatch({ ...DEFAULT_CONFIG, size: 16, startEra: 2, expansionIds }, 777);
    renderBoard(host, playerView(s2, 'A'), {
      selectedId: null,
      reach: [],
      targets: [],
      siegeTargets: [],
      selectedCityId: null,
      placeable: [],
      threat: [],
    });
    return host;
  };

  const base = mkBoard(['bloodbath']);
  const dark = mkBoard(['bloodbath', 'blackout']);
  try {
    assert.equal(base.querySelectorAll('.tile.unknown').length, 0, '基础规则下地形始终可见');
    assert.ok(dark.querySelectorAll('.tile.unknown').length > 0, '浓雾下应该有看不见的格子');
    assert.equal(base.querySelectorAll('.city-block').length, 4, '基础规则下四座城都画出来');
    assert.equal(dark.querySelectorAll('.city-block').length, 2, '浓雾下只该看见自己的两座城');
  } finally {
    // 临时棋盘必须摘掉：后面的用例靠 doc.querySelectorAll('.tile.out') 数全局节点，
    // 多留两块板会让它们一起变红（第一次跑就是这么崩的）
    base.remove();
    dark.remove();
  }
});

check('大地图（>1024 格）才进轻量渲染：64×64 带 big，12×12 不带', () => {
  /*
   * 这条守的是"玩家开雾跑 64×64 闪退"那起事故的**规模判据**。
   * 4096 格上，逐格的过渡/滤镜会把合成器压垮；小图上这些东西便宜得很。
   * 所以判据只能挂在"格子数"上，不能挂"有没有雾"——关雾的 64×64
   * 一样是 4096 个节点，只是少了压暗那层。
   */
  const mk = (size: number) => {
    const host = doc.createElement('div');
    host.className = 'board';
    doc.body.appendChild(host);
    const s2 = createMatch({ ...DEFAULT_CONFIG, size }, 20261104);
    renderBoard(host, playerView(s2, 'A'), {
      selectedId: null,
      reach: [],
      targets: [],
      siegeTargets: [],
      selectedCityId: null,
      placeable: [],
      threat: [],
    });
    return host;
  };

  const small = mk(12);
  const big = mk(64);
  try {
    assert.equal(small.classList.contains('big'), false, '12×12 不该进大地图模式');
    assert.equal(big.classList.contains('big'), true, '64×64 要进大地图模式');
    assert.equal(big.querySelectorAll('.tile').length, 4096, '64×64 是 4096 格');
    assert.ok(
      big.querySelectorAll('.tile.out').length > 3000,
      '开雾时绝大多数格子是视野外——正是这一格数把渲染压垮的',
    );
  } finally {
    small.remove();
    big.remove();
  }
});

check('迷雾压暗改成盖层，不再逐格挂 CSS filter', () => {
  /*
   * 事故根因：`filter: brightness() saturate()` 挂在一格一个元素上，
   * 4096 格 = 4096 个离屏合成层，显存顶穿 → 标签页直接崩。
   * 换成 `::after` 纯色盖层（只走绘制）。这条用例把"别改回去"钉死：
   * 谁要是图省事把 filter 写回逐格规则上，这里立刻红。
   */
  const css = readFileSync('src/style.css', 'utf8');
  assert.ok(css.includes('.board.fog .tile.out::after'), '视野外压暗应该走 ::after 盖层');
  assert.ok(
    css.includes('.board.blackout .tile.remembered::after'),
    '浓雾的"记得但看不见"也应该走 ::after 盖层',
  );
  assert.ok(
    !/\.board\.fog \.tile\.out\s*\{[^}]*filter\s*:/.test(css),
    '逐格的 .board.fog .tile.out 上不能再出现 filter',
  );
  assert.ok(
    !/\.board\.blackout \.tile\.remembered\s*\{[^}]*filter\s*:/.test(css),
    '逐格的 .board.blackout .tile.remembered 上不能再出现 filter',
  );
});

check('迷雾里的格子边框不许发亮：盖层之外的 1px 边线也要一起压暗', () => {
  /*
   * 症状：开雾之后，视野外那片区域看起来像"一张亮线织的网格"，格子越小越刺眼。
   *
   * 根因是**盖层盖不到边框**：`.out::after` 是绝对定位的子元素，`inset: 0` 对齐的是
   * 父元素的 padding box，而 `border-right/bottom` 在它外面。于是格心被灰盖暗了、
   * 那 1px 边线还留着地形原色（只叠了 4.5% 黑）——一暗一亮挨着，边线就成了亮线。
   *
   * 修法：把 `.out` / `.remembered` 的边框也刷成同一个半透明灰。边框画在地形色之上，
   * 混出来的值和格心一致，网格自然消失。这条用例把"别只压 background"钉住。
   */
  const css = readFileSync('src/style.css', 'utf8');
  const ruleOf = (sel: string): string => {
    const i = css.indexOf(sel);
    return i < 0 ? '' : css.slice(css.indexOf('{', i) + 1, css.indexOf('}', i));
  };

  const outTile = ruleOf('.board.fog .tile.out {');
  assert.ok(outTile.length > 0, '视野外的格子要有一条自己的边框规则');
  /** 把声明块压成一行，再按字面量判断——正则里全是反斜杠，难读也难改 */
  const flat = (block: string): string =>
    block
      .split('\n')
      .map((l) => l.trim())
      .join(' ')
      .replace(/ +/g, ' ');
  assert.ok(
    flat(outTile).includes('border-color: rgba(74, 70, 62, 0.52)'),
    '边框色必须和盖层同一个灰，否则边框会亮成一张网格',
  );

  const outAfter = ruleOf('.board.fog .tile.out::after');
  assert.ok(
    flat(outAfter).includes('background: rgba(74, 70, 62, 0.52)'),
    '盖层底色被改掉了',
  );
  assert.ok(
    flat(outAfter).includes('animation: none'),
    '视野外的格子要按掉 placeable 的呼吸动画——动画的优先级会盖过迷雾灰',
  );

  const memTile = ruleOf('.board.blackout .tile.remembered {');
  assert.ok(/border-color:/.test(memTile), '记忆里的格子同样要压边框，否则记忆区也是一张亮线网格');

  // 老规矩：修法不能退回逐格 filter（那条路会把 64×64 的标签页压垮）
  assert.ok(
    !/\.board\.fog \.tile\.out\s*\{[^}]*filter\s*:/.test(css),
    '不能为了压边框把 filter 写回来',
  );
});

check('地形不许决定鼠标光标：水/深水/山/火山上不该再有禁止符号', () => {
  /*
   * 缺陷：鼠标移到任何一片水（含深水）上都是"禁止"光标。
   *
   * 原因不是逻辑写错，是**样式表里一句过期的断言**：`.tile.t-water` /
   * `.tile.t-deep` / `.tile.t-mountain` / `.tile.t-volcano` 各写了一句
   * `cursor: not-allowed`，那是"水 = 走不过去"的年代留下的。后来船能下水、
   * 飞行能掠水过山，这句话就变成了纯粹的谎话——哪怕此刻选中的是一架飞机、
   * 那一格正在可达高亮里，光标还是禁止。
   *
   * 现在的分工：地形只管颜色，光标只由交互状态决定（.reach / .attackable / .aim）。
   * 这条用例盯的就是"别再把 cursor 写回地形规则里"。
   */
  const css = readFileSync('src/style.css', 'utf8');
  for (const t of ['water', 'deep', 'mountain', 'volcano', 'shallow', 'plateau', 'valley', 'marsh', 'dune']) {
    const i = css.indexOf(`.tile.t-${t} {`);
    if (i < 0) continue;
    const block = css.slice(css.indexOf('{', i) + 1, css.indexOf('}', i));
    assert.ok(
      !/cursor\s*:/.test(block),
      `.tile.t-${t} 里又写了 cursor——地形不该决定光标，能不能去由可达高亮表达`,
    );
  }
  // 基线还在：格子本身是可点的（点一下看信息、选中单位）
  const base = css.slice(css.indexOf('.tile {'), css.indexOf('}', css.indexOf('.tile {')));
  assert.ok(/cursor:\s*pointer/.test(base), '格子基线光标应该是 pointer');
});

check('地上的东西：自己的雷画实心，敌方已发现的画空心', () => {
  const host = doc.createElement('div');
  host.className = 'board';
  doc.body.appendChild(host);
  const st = createMatch({ ...DEFAULT_CONFIG, size: 16, startEra: 4, expansionIds: ['naval-fleet'] }, 909);
  // 一格自己的、一格敌人的（都摆在视野里，否则按迷雾规则根本不该画）
  const mine = addMark(st, { kind: 'nv-mine', owner: 'A', x: 2, y: 2, charges: 1, hidden: true });
  const foe = addMark(st, { kind: 'nv-mine', owner: 'B', x: 3, y: 2, charges: 1, hidden: false });
  const allSeen = Array.from({ length: st.w * st.h }, (_, i) => i);
  renderBoard(
    host,
    {
      state: st,
      visible: allSeen,
      visibleByBoard: { earth: allSeen },
      ghosts: [],
      rememberedTiles: new Map(),
      rememberedByBoard: {},
      rememberedCities: new Map(),
      terrainHidden: false,
    },
    {
      selectedId: null,
      reach: [],
      targets: [],
      siegeTargets: [],
      selectedCityId: null,
      placeable: [],
      threat: [],
      me: 'A',
    },
  );
check('深水 ↔ 浅水：朝对方那一侧要标出过渡方向，同档之间不标', () => {
  /*
   * 深水 #4a7fa6 / 浅水 #a8cadf 硬拼是一条刀切边，所以 board.ts 会给"挨着
   * 另一档"的那几侧写 `data-wt/wr/wb/wl`，CSS 在那一侧铺一道半透明的对方色，
   * 两侧各铺一半、边界线上的颜色正好是两档的中点。
   *
   * 这条钉两件事：
   *   1. 方向要对（`d` = 我在浅水这侧、叠深色；`l` = 我在深水这侧、叠浅色）；
   *   2. **同档之间不标**——标了就会在浅水和浅水之间平白多一道坡。
   *      "水域"和"浅流"算同一档（色差本来就小）。
   */
  const host = doc.createElement('div');
  const st = createMatch({ ...DEFAULT_CONFIG, size: 12, expansionIds: ['naval-fleet'] }, 313);

  const put = (x: number, y: number, t: string) => {
    st.tiles[y * st.w + x]!.terrain = t as never;
  };
  // 第 0 行：深 深 水 水
  put(0, 0, 'deep');
  put(1, 0, 'deep');
  put(2, 0, 'water');
  put(3, 0, 'water');
  // 第 1 行：深 浅（竖直方向）
  put(1, 1, 'shallow');

  const allSeen = Array.from({ length: st.w * st.h }, (_, i) => i);
  renderBoard(
    host,
    {
      state: st,
      visible: allSeen,
      visibleByBoard: { earth: allSeen },
      ghosts: [],
      rememberedTiles: new Map(),
      rememberedByBoard: {},
      rememberedCities: new Map(),
      terrainHidden: false,
    },
    {
      selectedId: null,
      reach: [],
      targets: [],
      siegeTargets: [],
      selectedCityId: null,
      placeable: [],
      me: 'A',
    },
  );

  const tile = (x: number, y: number) => host.querySelector(`.tile[data-x="${x}"][data-y="${y}"]`)!;

  // (1,0) 深水：右边是水域 → 该朝右铺浅色；左边是深水 → 不铺
  assert.equal(tile(1, 0).getAttribute('data-wr'), 'l', '深水挨浅水，右边该叠浅色');
  assert.equal(tile(1, 0).getAttribute('data-wl'), '0', '左边还是深水，不该铺');
  // (2,0) 水域：左边是深水 → 朝左叠深色
  assert.equal(tile(2, 0).getAttribute('data-wl'), 'd', '浅水挨深水，左边该叠深色');
  // (0,0) 深水：右边也是深水 → 一个方向都不该标
  assert.equal(tile(0, 0).getAttribute('data-wr'), '0', '同档之间不铺');
  // (3,0) 水域：左边是水域（同档），下边也按同档算 → 不铺
  assert.equal(tile(3, 0).getAttribute('data-wl'), '0', '水域之间不铺');
  // (1,0) 下面是浅流：浅流和深水不同档，要铺（竖直方向也要连上）
  assert.equal(tile(1, 0).getAttribute('data-wb'), 'l', '深水挨浅流，下边也该叠浅色');
  // (3,0) 下面是水域：水域和浅流算同档，不铺
  assert.equal(tile(3, 0).getAttribute('data-wb'), '0', '水域和浅流算同一档，不铺');
  host.remove();
});

  try {
    const marks = host.querySelectorAll('.fx-mark');
    assert.equal(marks.length, 2, `两条留痕都该画出来，实际 ${marks.length}`);
    assert.ok(host.querySelector('.fx-mark.mine'), '自己布的应该是实心（.mine）');
    assert.ok(host.querySelector('.fx-mark.seen'), '敌方已发现的应该是空心（.seen）');
    assert.equal(host.querySelector(`.fx-mark[title="水雷"]`) !== null, true, '要有名字，悬停能看出来是什么');
    // 它不该混进棋子层：雷不是单位
    assert.equal(host.querySelectorAll('.unit').length, st.units.length);
    assert.ok(mine.id !== foe.id, '两枚雷的 id 不能撞');
  } finally {
    host.remove();
  }
});

check('棋子贴图：默认关，有图也仍然显示汉字', () => {
  /*
   * 这是 2026-11-11 那个兵种美术试验的开关。默认必须是关的：
   * 现在只有 4 个兵种有图，默认打开会让棋盘变成"一半图一半字"，比全字更乱。
   * 关着的时候**一个 img 都不该出现**，也不该去拉清单。
   */
  const was = uiArtOn();
  setUiArt(false);
  __setArtIndexForTest(['militia']);

  const host = doc.createElement('div');
  host.className = 'board';
  doc.body.appendChild(host);
  const st = createMatch({ ...DEFAULT_CONFIG, size: 12, startEra: 1 }, 4242);
  const allSeen = Array.from({ length: st.w * st.h }, (_, i) => i);
  renderBoard(
    host,
    {
      state: st,
      visible: allSeen,
      visibleByBoard: { earth: allSeen },
      ghosts: [],
      rememberedTiles: new Map(),
      rememberedByBoard: {},
      rememberedCities: new Map(),
      terrainHidden: false,
    },
    {
      selectedId: null,
      reach: [],
      targets: [],
      siegeTargets: [],
      selectedCityId: null,
      placeable: [],
      threat: [],
      me: 'A',
    },
  );
  try {
    assert.equal(host.querySelectorAll('.unit-art').length, 0, '关着就不该有贴图');
    const inner = host.querySelector('.unit-inner');
    assert.ok((inner?.textContent ?? '').trim().length > 0, '应该还是汉字');
  } finally {
    host.remove();
  }

  setUiArt(was);
  __setArtIndexForTest(null);
});

check('棋子贴图：打开后只有清单里的兵种换成图，没图的回退汉字', () => {
  /*
   * 这条守的是"绝不出现空格子"：清单里没有的、或者图加载失败的，
   * 都必须退回汉字。棋盘上出现一个没有任何标识的方块，玩家没法判断那是什么。
   */
  const was = uiArtOn();
  setUiArt(true);
  __setArtIndexForTest(['militia']);

  const host = doc.createElement('div');
  host.className = 'board';
  doc.body.appendChild(host);
  const st = createMatch({ ...DEFAULT_CONFIG, size: 12, startEra: 1 }, 4243);
  const allSeen = Array.from({ length: st.w * st.h }, (_, i) => i);
  renderBoard(
    host,
    {
      state: st,
      visible: allSeen,
      visibleByBoard: { earth: allSeen },
      ghosts: [],
      rememberedTiles: new Map(),
      rememberedByBoard: {},
      rememberedCities: new Map(),
      terrainHidden: false,
    },
    {
      selectedId: null,
      reach: [],
      targets: [],
      siegeTargets: [],
      selectedCityId: null,
      placeable: [],
      threat: [],
      me: 'A',
    },
  );
  try {
    const militiaCount = st.units.filter((u) => u.type === 'militia').length;
    const imgs = [...host.querySelectorAll('img.unit-art')];
    assert.equal(imgs.length, militiaCount, '只有清单里的民兵该换成图');
    for (const img of imgs) {
      assert.ok(
        (img.getAttribute('src') ?? '').includes('art/units/militia.png'),
        '路径要按兵种 id 约定，加新图不用改代码',
      );
    }
    // 其余兵种仍然是字
    const glyphs = [...host.querySelectorAll('.unit-inner')].filter((el) => !el.querySelector('img'));
    assert.ok(glyphs.length > 0, '没图的兵种应该还有汉字');
    for (const el of glyphs) {
      assert.ok((el.textContent ?? '').trim().length > 0, '没图也不能变空');
    }
  } finally {
    host.remove();
  }

  setUiArt(was);
  __setArtIndexForTest(null);
});

check('顶栏：给扩展的棋盘视图留了容器', () => {
  // 容器是空的，没有扩展提供视图时靠 CSS 的 :empty 收起来（style.css 的 .topbar-ext）。
  // 钉这一条是因为"顶栏骨架只插一次"，删了容器就得改 main 的挂载方式。
  const shell = topbarShell();
  assert.ok(shell.includes('data-ref="board-views"'), '顶栏要有视图容器');
  assert.ok(shell.includes('class="topbar-ext"'), '容器要带自己的 class');
});

check('棋盘视图：扩展给颜色，核心只负责画，而且不挡棋子', () => {
  const host = doc.createElement('div');
  host.className = 'board';
  doc.body.appendChild(host);
  const st = createMatch({ ...DEFAULT_CONFIG, size: 16, startEra: 1 }, 77);
  const base = {
    selectedId: null,
    reach: [],
    targets: [],
    siegeTargets: [],
    selectedCityId: null,
    placeable: [],
    threat: [],
    me: 'A' as const,
  };
  try {
    // 视图没打开：这一层一个节点都不该有
    renderBoard(host, playerView(st, 'A'), { ...base });
    assert.equal(host.querySelectorAll('.fx-qi').length, 0, '没打开就不该染色');

    // 打开：只画"给了颜色"的格子
    const cells = new Map<number, string>([
      [0, 'rgba(64, 160, 120, 0.28)'],
      [5, 'rgba(40, 140, 100, 0.58)'],
    ]);
    renderBoard(host, playerView(st, 'A'), { ...base, boardView: cells });
    const nodes = host.querySelectorAll<HTMLElement>('.fx-qi');
    assert.equal(nodes.length, 2, `只画给了颜色的格，实际 ${nodes.length}`);
    const style = nodes[0]!.getAttribute('style') ?? '';
    assert.ok(style.includes('rgba'), '颜色必须来自参数，不能写死');
    assert.ok(style.includes('grid-column:1'), '按格定位');

    // 层序：盖住地面、但不盖住棋子
    const layers = Array.from(host.children).map((e) => e.className);
    assert.ok(layers.indexOf('board-view') > layers.indexOf('tiles'), '要在格子之上');
    assert.ok(layers.indexOf('board-view') < layers.indexOf('units'), '不该盖住棋子');
  } finally {
    host.remove();
  }
});

check('浓雾扩展：走过的地形和城会留在记忆里', () => {
  // 三档雾的分界要经得起考验：
  //   看得见 → 照实画；去过 → 画记忆里的样子（.tile.remembered / .city-block.stale）；
  //   没去过 → 还是一片黑（.tile.unknown）。
  const host = doc.createElement('div');
  host.className = 'board';
  doc.body.appendChild(host);
  const st = createMatch({ ...DEFAULT_CONFIG, size: 16, startEra: 2, expansionIds: ['blackout'] }, 4242);
  st.fog = true;
  refreshMemory(st);

  const foeCity = st.cities.find((c) => c.owner === 'B');
  assert.ok(foeCity, '应该有敌方城市');
  const scout = st.units.find((u) => u.owner === 'A');
  assert.ok(scout, '应该有 A 方的兵');

  // 去敌城边上"侦察"一次，再撤回原位——那片重新落回雾里
  const home = { x: scout!.x, y: scout!.y };
  scout!.x = foeCity!.x;
  scout!.y = Math.min(st.h - 1, foeCity!.y + foeCity!.size);
  refreshMemory(st);
  scout!.x = home.x;
  scout!.y = home.y;
  refreshMemory(st);

  try {
    renderBoard(host, playerView(st, 'A'), {
      selectedId: null,
      reach: [],
      targets: [],
      siegeTargets: [],
      selectedCityId: null,
      placeable: [],
      threat: [],
    });

    const stale = host.querySelector('.city-block.stale');
    assert.ok(stale, '去过的敌城该按旧情报画出来');
    assert.ok(stale!.textContent?.includes('旧情报'), '旧情报得写在牌子上，不能让人以为是实时情报');
    assert.equal(stale!.querySelector('.city-hp'), null, '旧情报不该画血条——那是过期数字');

    const remembered = host.querySelectorAll('.tile.remembered');
    assert.ok(remembered.length > 0, '走过的地形不该还是一片黑');
    for (const node of Array.from(remembered)) {
      assert.equal(node.classList.contains('unknown'), false, '记得的格不能同时又画成未知');
    }
    assert.ok(host.querySelectorAll('.tile.unknown').length > 0, '从没去过的格还是全黑');
  } finally {
    host.remove();
  }
});

console.log('\n增量重绘');

/**
 * 增量重绘的护栏。
 *
 * 棋盘改成"节点留着复用"之后，最容易出的是两类 bug：
 *   1. 该变的没变（缓存说一样，其实是判据漏了字段）—— 玩家看到的是"卡住的棋子"；
 *   2. 该没变的变了（每帧重建，缓存白做）—— 不报错，只是慢慢变卡。
 * 这类问题在手动点几下时几乎看不出来，所以必须在这里钉住。
 */
const emptyUi = {
  selectedId: null,
  reach: [] as number[],
  targets: [] as string[],
  siegeTargets: [] as string[],
  selectedCityId: null,
  placeable: [] as number[],
  threat: [] as number[],
};

check('棋盘视图的字符层：只画给了字的格，没字时一节点不多', () => {
  const host = doc.createElement('div');
  host.className = 'board';
  doc.body.appendChild(host);
  const st = createMatch({ ...DEFAULT_CONFIG, size: 12, startEra: 2, expansionIds: [] }, 9191);
  const view = playerView(st, 'A');
  const a = 3 * st.w + 2;
  const b = 4 * st.w + 5;
  try {
    // 只有颜色：和从前一样，一个字都没有
    renderBoard(host, view, {
      ...emptyUi,
      boardView: new Map([[a, 'rgba(0,0,0,0.2)']]),
    });
    assert.equal(host.querySelectorAll('.fx-qi').length, 1, '一格染色就是一个节点');
    assert.equal(host.querySelector('.fx-qi.wind'), null, '没给字就不该有字符类');

    // 给了字：同一个节点，字在格中央
    renderBoard(host, view, {
      ...emptyUi,
      boardView: new Map([
        [a, 'rgba(0,0,0,0.2)'],
        [b, 'rgba(0,0,0,0.2)'],
      ]),
      boardGlyph: new Map([[a, '→']]),
    });
    const wind = host.querySelector('.fx-qi.wind');
    assert.ok(wind, '有字的格要挂上 wind 类');
    assert.equal(wind.textContent, '→', '字要落在染色层里');
    assert.equal((wind as HTMLElement).style.gridColumn, '3', '位置还是那一格');
    assert.equal(host.querySelectorAll('.fx-qi.wind').length, 1, '没给字的格不许跟着长字');
  } finally {
    host.remove();
  }
});

check('同一局面重画：格子、棋子、城市的节点身份不变', () => {
  const host = doc.createElement('div');
  host.className = 'board';
  doc.body.appendChild(host);
  const st = createMatch({ ...DEFAULT_CONFIG, size: 16, startEra: 2, expansionIds: [] }, 31337);
  const view = playerView(st, 'A');
  try {
    renderBoard(host, view, emptyUi);
    const tile = host.querySelector('.tile[data-x="3"][data-y="4"]');
    const unit = host.querySelector('.unit[data-id]');
    const city = host.querySelector('.city-block');
    assert.ok(tile && unit && city, '第一帧就该画出格子、棋子、城市');

    renderBoard(host, view, emptyUi);
    assert.equal(host.querySelector('.tile[data-x="3"][data-y="4"]'), tile, '格子节点该留着复用');
    assert.equal(host.querySelector('.unit[data-id]'), unit, '棋子节点该留着复用');
    assert.equal(host.querySelector('.city-block'), city, '城市节点该留着复用');
    assert.equal(host.querySelectorAll('.tile').length, 256, '复用不该改变格子总数');
  } finally {
    host.remove();
  }
});

check('受击：只有这一次真掉血的那个兵演残留，老伤号不许跟着演', () => {
  const host = doc.createElement('div');
  host.className = 'board';
  doc.body.appendChild(host);
  const st = createMatch({ ...DEFAULT_CONFIG, size: 16, startEra: 2, expansionIds: [] }, 9091);
  try {
    // 先让两个兵都带伤（模拟"上一轮被打过"），并且先画一帧
    const hurt = st.units.filter((u) => u.owner === 'A').slice(0, 2);
    assert.ok(hurt.length >= 2, '开局至少要有两个 A 方单位');
    for (const u of hurt) u.hp = Math.max(1, Math.floor(st.unitTypes[u.type]!.maxHp / 2));
    renderBoard(host, playerView(st, 'A'), emptyUi);
    const chippedNow = () =>
      Array.from(host.querySelectorAll('.unit .hp-lag.chipped'))
        .map((n) => n.closest<HTMLElement>('.unit')?.dataset.id)
        .filter((v): v is string => !!v);
    assert.deepEqual(chippedNow(), [], '两个兵是"上一轮"受的伤：这一帧不该有人演残留');

    // 只打其中一个：只有它该演，另一个必须一动不动
    const [target, bystander] = hurt as [typeof hurt[0], typeof hurt[0]];
    const beforeRatio = target.hp / st.unitTypes[target.type]!.maxHp;
    target.hp = Math.max(1, Math.floor(target.hp * 0.6));
    renderBoard(host, playerView(st, 'A'), {
      ...emptyUi,
      hpDrops: new Map([[target.id, beforeRatio]]),
      impacts: new Map([[target.id, 1]]),
    });
    assert.deepEqual(
      chippedNow(),
      [target.id],
      `只该有被打的那个演残留（实际 ${JSON.stringify(chippedNow())}）`,
    );
    assert.ok(
      !chippedNow().includes(bystander.id),
      '旁边那个老伤号不许跟着演一次——这就是这次要修的 bug',
    );
    // 残留的起点是"掉之前的比例"，终点是当前比例
    const lag = host.querySelector<HTMLElement>(`.unit[data-id="${target.id}"] .hp-lag`)!;
    assert.equal(lag.style.getPropertyValue('--chip-from'), `${beforeRatio * 100}%`);
    assert.ok(Number(lag.style.getPropertyValue('--chip-to').replace('%', '')) < beforeRatio * 100);

    // 没有新动作的重绘不该再演第二次：换一次选中（这会让节点内容重建），
    // 重建出来的残留条上不该再挂 chipped
    renderBoard(host, playerView(st, 'A'), { ...emptyUi, selectedId: target.id });
    assert.deepEqual(chippedNow(), [], '同一份状态重绘不该重播残留');

    // 回血同样不演：那不是挨打
    target.hp = st.unitTypes[target.type]!.maxHp;
    renderBoard(host, playerView(st, 'A'), { ...emptyUi, hpDrops: new Map() });
    assert.deepEqual(chippedNow(), [], '回血不该出现残留条');

    // 打击记账照旧：给了 impacts 就要在节点上记一笔（jsdom 没有 animate，记账那一步仍在）
    const stampBefore = host.querySelector<HTMLElement>(`.unit[data-id="${target.id}"]`)!.dataset.impactAt;
    renderBoard(host, playerView(st, 'A'), { ...emptyUi, impacts: new Map([[target.id, 1]]) });
    const node = host.querySelector<HTMLElement>(`.unit[data-id="${target.id}"]`)!;
    assert.ok(node.dataset.impactAt, '挨打要在这个单位上记一笔');
    assert.notEqual(node.dataset.impactAt, stampBefore, '新的一次绘制要重新记');
  } finally {
    host.remove();
  }
});

check('地形底色：深水有自己的样式，不再被兜底成平原', () => {
  const host = doc.createElement('div');
  host.className = 'board';
  doc.body.appendChild(host);
  const st = createMatch({ ...DEFAULT_CONFIG, size: 16, startEra: 2, expansionIds: [] }, 4242);
  try {
    const wi = st.tiles.findIndex((t) => t.terrain === 'water');
    assert.ok(wi >= 0, '这张图上应该有水');
    st.tiles[wi]!.terrain = 'deep';
    const dx = wi % st.w;
    const dy = (wi - dx) / st.w;
    const pi = st.tiles.findIndex((t) => t.terrain === 'plain' && !t.cityId);
    assert.ok(pi >= 0, '这张图上应该有平原');

    renderBoard(host, playerView(st, 'A'), emptyUi);
    const deepNode = host.querySelector<HTMLElement>(`.tile[data-x="${dx}"][data-y="${dy}"]`)!;
    assert.ok(deepNode.classList.contains('t-deep'), '深水要有自己的 class');
    assert.ok(!deepNode.classList.contains('t-plain'), '深水不许再被兜底成平原色');

    const px = pi % st.w;
    const py = (pi - px) / st.w;
    const plainNode = host.querySelector<HTMLElement>(`.tile[data-x="${px}"][data-y="${py}"]`)!;
    assert.ok(plainNode.classList.contains('t-plain'), '平原照旧是平原（对照）');
  } finally {
    host.remove();
  }
});

check('高亮变了要真的变，节点还是同一个', () => {
  const host = doc.createElement('div');
  host.className = 'board';
  doc.body.appendChild(host);
  const st = createMatch({ ...DEFAULT_CONFIG, size: 16, startEra: 2, expansionIds: [] }, 5150);
  const view = playerView(st, 'A');
  try {
    const i = st.tiles.findIndex((t) => t.terrain === 'plain' && !t.cityId);
    const x = i % st.w;
    const y = (i - x) / st.w;
    const sel = `[data-x="${x}"][data-y="${y}"]`;

    renderBoard(host, view, { ...emptyUi, reach: [i], threat: [i] });
    const tile = host.querySelector<HTMLElement>(`.tile${sel}`);
    assert.ok(tile?.classList.contains('reach'), '可达格要挂上 reach');
    assert.equal(tile?.classList.contains('threat'), false, '同一个格不该同时是可达和威胁');

    // 取消选中：上一帧的 reach 必须摘干净（整体赋 className 就是为了这件事）
    renderBoard(host, view, emptyUi);
    assert.equal(host.querySelector<HTMLElement>(`.tile${sel}`), tile, '节点还是同一个');
    assert.equal(tile?.classList.contains('reach'), false, '取消选中后高亮要摘掉');

    // 产出角标：出现、换数字、消失，都以格子上的 span 为准
    renderBoard(host, view, { ...emptyUi, incomeHints: new Map([[i, { gold: 7 }]]) });
    assert.ok(host.querySelector(`.tile${sel} .tile-income`)?.textContent === '+7', '角标要写对数字');
    renderBoard(host, view, { ...emptyUi, incomeHints: new Map([[i, { gold: 9 }]]) });
    assert.ok(host.querySelector(`.tile${sel} .tile-income`)?.textContent === '+9', '角标数字变了要跟着变');
    renderBoard(host, view, emptyUi);
    assert.equal(host.querySelector(`.tile${sel} .tile-income`), null, '角标该消失');
  } finally {
    host.remove();
  }
});

check('换地图：格子与棋子都按新局面重建，旧节点一个不留', () => {
  const host = doc.createElement('div');
  host.className = 'board';
  doc.body.appendChild(host);
  try {
    const small = createMatch({ ...DEFAULT_CONFIG, size: 12, startEra: 2, expansionIds: [] }, 111);
    renderBoard(host, playerView(small, 'A'), emptyUi);
    const oldTile = host.querySelector('.tile');
    assert.equal(host.querySelectorAll('.tile').length, 144);

    const big = createMatch({ ...DEFAULT_CONFIG, size: 20, startEra: 2, expansionIds: [] }, 222);
    const viewBig = playerView(big, 'A');
    renderBoard(host, viewBig, emptyUi);
    assert.equal(host.querySelectorAll('.tile').length, 400, '换地图后格子数要对');
    assert.notEqual(host.querySelector('.tile'), oldTile, '格子数变了必须整层重建');
    // 棋子是按 id 复用的，而两局的兵 id 会撞车（都是 A-1、B-3 这种），
    // 所以不能数"剩了几个旧 id"，要比"盘上的兵和新局面是不是同一批"
    const shown = Array.from(host.querySelectorAll<HTMLElement>('.unit[data-id]'))
      .map((n) => n.dataset.id ?? '')
      .sort();
    const want = viewBig.state.units.map((u) => u.id).sort();
    assert.deepEqual(shown, want, '盘上应该正好是新局面的那些兵');
  } finally {
    host.remove();
  }
});

check('单位被打掉之后，它的节点要从盘上摘掉', () => {
  const host = doc.createElement('div');
  host.className = 'board';
  doc.body.appendChild(host);
  const st = createMatch({ ...DEFAULT_CONFIG, size: 16, startEra: 2, expansionIds: [] }, 6161);
  try {
    renderBoard(host, playerView(st, 'A'), emptyUi);
    const victim = st.units.find((u) => u.owner === 'A');
    assert.ok(victim, '应该有己方单位');
    assert.ok(host.querySelector(`.unit[data-id="${victim!.id}"]`), '它该在盘上');

    st.units = st.units.filter((u) => u.id !== victim!.id);
    renderBoard(host, playerView(st, 'A'), emptyUi);
    assert.equal(host.querySelector(`.unit[data-id="${victim!.id}"]`), null, '打掉之后节点要跟着没');
  } finally {
    host.remove();
  }
});

check('侧栏：内容没变就不重写，变了必须重写', () => {
  const host = doc.createElement('div');
  const st = createMatch({ ...DEFAULT_CONFIG, size: 12, startEra: 1, expansionIds: [] }, 808);
  const paint = () =>
    renderPanel(host, {
      view: playerView(st, 'A'),
      me: 'A',
      selectedUnit: null,
      selectedCityId: null,
      selectedCampId: null,
      selectedTile: null,
    });

  paint();
  const card = host.querySelector('.card');
  assert.ok(card, '侧栏该有顶卡');
  paint();
  assert.equal(host.querySelector('.card'), card, '内容一样时不该重建节点');

  // 金币变了就是内容真的变了——漏掉这一条，玩家会看到"钱不动"
  const before = st.players.A.gold;
  st.players.A.gold = before + 7;
  paint();
  assert.notEqual(host.querySelector('.card'), card, '金币变了必须重写');
  assert.ok((host.textContent ?? '').includes(`金币 ${before + 7}`), '新金币要显示出来');
});

check('装配坞：每件装备写着数据与耗电，插槽与电力收支都看得见', () => {
  /*
   * 用户 2026-11-10 的诉求：装配坞以前每件只写"耗能 N"，装甲板/系统槽装了
   * 什么效果全靠猜；插槽数量和电力收支也没有地方看。
   *
   * 这条钉的是"信息有没有出现在界面上"，不是"好不好看"：
   *   · 每件候选装备的第二行 = 耗电 + 具体数据（护甲/移速/视野…）
   *   · 属性卡与装配坞都写插槽用量（几/几）
   *   · 电力块给出产能、已用、余量，以及"几座电站"
   */
  const host = doc.createElement('div');
  const st = createMatch({ ...DEFAULT_CONFIG, size: 12, startEra: 7, expansionIds: ['armor-era7'] }, 707);

  // 找两块空地：一台素体 + 一座电站
  const free = st.tiles
    .map((t, i) => ({ t, i }))
    .filter(({ t }) => t.terrain === 'plain' && !t.cityId)
    .map(({ i }) => ({ x: i % st.w, y: Math.floor(i / st.w) }))
    .filter((p) => !st.units.some((u) => u.x === p.x && u.y === p.y));
  assert.ok(free.length >= 2, '棋盘上得有两块空地');

  st.units.push({
    id: 'frame1', type: 'armor_anvil', owner: 'A',
    x: free[0]!.x, y: free[0]!.y, hp: 175, kills: 0, moved: false, acted: false,
  });
  st.units.push({
    id: 'plant1', type: 'armor_coal', owner: 'A',
    x: free[1]!.x, y: free[1]!.y, hp: 70, kills: 0, moved: false, acted: false,
  });
  const frame = st.units.find((u) => u.id === 'frame1')!;

  renderPanel(host, {
    view: playerView(st, 'A'),
    me: 'A',
    selectedUnit: frame,
    selectedCityId: null,
    selectedCampId: null,
    selectedTile: null,
  });
  const text = (host.textContent ?? '').replace(/\s+/g, ' ');

  // 1) 插槽：素体 5 格（主1 副1 甲2 统0 设1）
  assert.ok(text.includes('插槽'), `属性卡/装配坞该有插槽一行：${text.slice(0, 200)}`);
  assert.ok(text.includes('0/5'), '还没装东西时应该是 0/5');

  // 2) 电力：产能 120（一座燃煤电站）、已用 20（素体自身耗电）、余量 100
  //    2026-11-12 起电力条挪到侧栏顶部：**不选装甲也要看得见**，
  //    这里选中的是素体，属于"顺带也在"的那一档。
  assert.ok(text.includes('产能'), '要写产能');
  assert.ok(/产能\s*120/.test(text), `产能该是 120：${text.match(/产能[^已]*/)?.[0] ?? ''}`);
  assert.ok(/已用\s*20/.test(text), '已用该是 20（素体自身）');
  assert.ok(/余量\s*100/.test(text), '余量该是 100');
  assert.ok(text.includes('1 座电站'), '要写几座电站在发电');

  // 3) 每件候选装备都要带"耗电 + 具体数据"
  const rows = [...host.querySelectorAll('[data-act="mount"]')];
  assert.ok(rows.length > 0, '该有可装的候选装备');
  for (const row of rows) {
    const t = (row.textContent ?? '').replace(/\s+/g, ' ');
    assert.ok(t.includes('耗电'), `候选装备没写耗电：${t}`);
    assert.ok(/耗电\s*\d+/.test(t), `耗电后面要跟数字：${t}`);
  }
  // 纯加法修正的模块（装甲板）必须把效果写出来，不能只有"耗能 6"
  const plate = rows.find((r) => (r.textContent ?? '').includes('复合装甲'));
  if (plate) {
    const t = (plate.textContent ?? '').replace(/\s+/g, ' ');
    assert.ok(/护甲\s*\+\d+|生命上限\s*\+\d+/.test(t), `装甲板要写出加多少：${t}`);
  }
  /*
   * 4) 装上一件之后：**槽位角标保持"主/副/甲/统/设"，拆卸单独成组**。
   *
   * 旧版把已装模块整行做成了"拆"按钮，于是五件模块排下来全是"拆"，
   * 主武器和装甲板分不出来。现在已装是只读行（角标是槽位），
   * 拆卸是另一组按钮（角标才是"拆"，文字写"槽位 · 名称"）。
   */
  frame.modules = ['autocannon'];
  const host4 = doc.createElement('div');
  renderPanel(host4, {
    view: playerView(st, 'A'),
    me: 'A',
    selectedUnit: frame,
    selectedCityId: null,
    selectedCampId: null,
    selectedTile: null,
  });
  const staticRow = host4.querySelector('.recruit-btn.is-static');
  assert.ok(staticRow, '已装模块要有一条只读行');
  const st1 = (staticRow!.textContent ?? '').replace(/\s+/g, ' ');
  assert.ok(st1.includes('主'), `只读行的角标要保留槽位：${st1}`);
  assert.ok(st1.includes('速射炮'), '只读行要写明装的是什么');
  assert.ok(!st1.includes('拆'), '只读行不该出现"拆"');
  const un = host4.querySelector('[data-act="unmount"]');
  assert.ok(un, '拆卸要单独一颗按钮');
  const ut = (un!.textContent ?? '').replace(/\s+/g, ' ');
  assert.ok(ut.includes('拆'), `拆卸按钮写"拆"：${ut}`);
  assert.ok(ut.includes('主 · 速射炮'), `拆卸按钮要写明"槽位 · 名称"：${ut}`);
  const mountRow = host4.querySelector('[data-act="mount"]');
  assert.ok(mountRow, '还要有可装模块');
  assert.notStrictEqual(
    un!.closest('.recruit-list'),
    mountRow!.closest('.recruit-list'),
    '拆卸与装配必须分成两组，不能混在一条列表里',
  );
  host4.remove();
  frame.modules = [];

  host.remove();

  /*
   * 选中的不是装甲，电力条照样在（2026-11-12 用户的要求：
   * "建出发电站后应默认显示电量，无需点击装甲"）。
   */
  const host2 = doc.createElement('div');
  renderPanel(host2, {
    view: playerView(st, 'A'),
    me: 'A',
    selectedUnit: null,
    selectedCityId: null,
    selectedCampId: null,
    selectedTile: null,
  });
  const t2 = (host2.textContent ?? '').replace(/\s+/g, ' ');
  assert.ok(/产能\s*120/.test(t2), `没选装甲时也该看到电力：${t2.slice(0, 120)}`);
  host2.remove();

  /*
   * 一座电站都没有的时候，电量信息一个字都不该出现——
   * "产能 0 / 过载 20"只会让人以为哪里坏了。
   */
  const bare = createMatch({ ...DEFAULT_CONFIG, size: 12, startEra: 7, expansionIds: ['armor-era7'] }, 708);
  bare.units.push({
    id: 'frame2', type: 'armor_anvil', owner: 'A',
    x: free[0]!.x, y: free[0]!.y, hp: 175, kills: 0, moved: false, acted: false,
  });
  const host3 = doc.createElement('div');
  renderPanel(host3, {
    view: playerView(bare, 'A'),
    me: 'A',
    selectedUnit: bare.units.find((u) => u.id === 'frame2') ?? null,
    selectedCityId: null,
    selectedCampId: null,
    selectedTile: null,
  });
  const t3 = (host3.textContent ?? '').replace(/\s+/g, ' ');
  assert.ok(!t3.includes('产能'), '没电站时不该画电力块');
  assert.ok(!t3.includes('余量'), '没电站时不该出现"余量"');
  host3.remove();
});

check('浓雾蔽野：对面的钱袋是打探不到的情报', () => {
  // 雾里连地形都要走一遍才记得住，隔壁还剩多少钱更不该摆在 HUD 上——
  // 那等于免费告诉玩家"他还能不能再买一队兵"，照着想就是上帝视角。
  const host = doc.createElement('div');
  const st = createMatch({ ...DEFAULT_CONFIG, size: 12, startEra: 1, expansionIds: ['blackout'] }, 909);
  st.players.A.gold = 123;
  st.players.B.gold = 456;
  const paint = (extra: Record<string, unknown> = {}) =>
    renderPanel(host, {
      view: playerView(st, 'A'),
      me: 'A',
      selectedUnit: null,
      selectedCityId: null,
      selectedCampId: null,
      selectedTile: null,
      ...extra,
    });

  paint();
  const text = host.textContent ?? '';
  assert.ok(text.includes('金币 123'), '自己的钱必须看得见');
  assert.ok(!text.includes('金币 456'), '对面的钱不该出现在 HUD 里');
  // 整行消失会让人以为是渲染坏了：留一个占位，说明"有这个东西，但你不知道"
  assert.ok(text.includes('金币 ?'), '该给一个占位，而不是把这一项抹掉');

  // 观战位本来就是全图视角（顶栏自己写着"全图视角"），遮一半反而自相矛盾
  paint({ spectator: true });
  assert.ok((host.textContent ?? '').includes('金币 456'), '观战位两边都该看得见');
});

/**
 * 雾里点一格：不能顺手把地形和敌情一起点出来。
 *
 * 棋盘上画着雾、侧栏却把雾里的地形念出来（浓雾局里尤其荒谬），
 * 或者把那一格的灵气来源写出来（"灵田 +15" 等于替你点出了对面建筑），
 * 那这层雾就只是个视觉效果。两条边界：
 *   · 连地形都遮的局（浓雾蔽野）→ 雾外只翻记忆，没记忆就写「未探明」；
 *   · 地形公开的局 → 地形照写，但格子上的**活数据**（灵气、天气）只在视野内问。
 */
check('雾里点格子：地形和敌情都不该被点出来', () => {
  const host = doc.createElement('div');
  const paint = (st: ReturnType<typeof createMatch>, x: number, y: number) =>
    renderPanel(host, {
      view: playerView(st, 'A'),
      me: 'A',
      selectedUnit: null,
      selectedCityId: null,
      selectedCampId: null,
      selectedTile: { x, y },
    });
  const xyOf = (st: ReturnType<typeof createMatch>, i: number) => ({
    x: i % st.w,
    y: Math.floor(i / st.w),
  });

  // ── 连地形都遮的局 ──
  const dark = createMatch({ ...DEFAULT_CONFIG, size: 12, startEra: 1, expansionIds: ['blackout'] }, 4242);
  const darkView = playerView(dark, 'A');
  const seenDark = new Set(darkView.visible);
  let cold = -1;
  for (let i = 0; i < dark.w * dark.h; i++) {
    if (!seenDark.has(i) && !darkView.rememberedTiles.has(i)) {
      cold = i;
      break;
    }
  }
  assert.ok(cold >= 0, '总该有一格是没探索过的');
  const coldPt = xyOf(dark, cold);
  paint(dark, coldPt.x, coldPt.y);
  const coldText = host.textContent ?? '';
  assert.ok(coldText.includes('未探明'), `雾外没记忆的格该写「未探明」，实际：${coldText.slice(0, 80)}`);
  assert.ok(!coldText.includes('进入消耗'), '「未探明」的格不许报进入消耗——那就等于报了地形');

  // 记忆里的那一格：写记忆中的地形，并且明说是记的（可能已经变了）。
  // 开局那一眼看到的格子此刻都还看得见，翻不到"记忆"，所以直接往账本上记一笔——
  // 等价于"早先我从这一格走过"（浓雾局里这份账本就是 `refreshMemory` 写的）。
  dark.memory.A.tiles = dark.memory.A.tiles ?? {};
  dark.memory.A.tiles[cold] = 'forest';
  assert.equal(
    playerView(dark, 'A').rememberedTiles.get(cold),
    'forest',
    '前提：雾外那一格已经在记忆里',
  );
  paint(dark, coldPt.x, coldPt.y);
  const memText = host.textContent ?? '';
  assert.ok(memText.includes('森林'), `该按记忆报出地形，实际：${memText.slice(0, 80)}`);
  assert.ok(memText.includes('记忆里的地形'), `翻记忆时要标出来，实际：${memText.slice(0, 80)}`);

  // ── 地形公开的局：地形照写，但灵气这种活数据只在视野内 ──
  const lit = createMatch({ ...DEFAULT_CONFIG, size: 12, startEra: 2, expansionIds: ['cultivation'] }, 515);
  const litView = playerView(lit, 'A');
  const seenLit = new Set(litView.visible);
  const far = [...Array(lit.w * lit.h).keys()].find((i) => !seenLit.has(i));
  assert.ok(far !== undefined, '雾里总该有看不见的格');
  const farPt = xyOf(lit, far!);
  paint(lit, farPt.x, farPt.y);
  assert.ok(
    !(host.textContent ?? '').includes('灵气浓度'),
    '雾外的格不该报灵气浓度——那行还带着"灵田 +15"的来源',
  );

  const near = litView.visible[0];
  assert.ok(near !== undefined, '自己脚边总看得见');
  const nearPt = xyOf(lit, near!);
  paint(lit, nearPt.x, nearPt.y);
  assert.ok(
    (host.textContent ?? '').includes('灵气浓度'),
    '看得见的格该照常写出灵气浓度',
  );
});

/**
 * 产兵建筑点开走的是 `renderCamp` 这条支路，**不会**走到单位详情卡。
 * 扩展给单位挂的操作（宗门大殿的「研发 / 遗弃」）以前只画在详情卡上，
 * 于是实战里点开宗门大殿只剩"招募弟子"，研发按钮根本不存在。
 * 这条用例按"点开一座产兵建筑"的方式渲染，把那条支路钉住。
 */
check('产兵建筑上的扩展按钮：宗门大殿点开也要有「研发」', () => {
  const host = doc.createElement('div');
  const st = createMatch({ ...DEFAULT_CONFIG, size: 12, startEra: 1, expansionIds: ['cultivation'] }, 515);
  st.current = 'A';
  st.units = [];
  st.players.A.res = { 'spirit-stone': 200 };
  for (let y = 2; y <= 8; y++) {
    for (let x = 2; x <= 8; x++) st.tiles[y * st.w + x] = { terrain: 'plain', cityId: null };
  }
  const def = st.unitTypes['cultivation-sect'];
  assert.ok(def, '修真包要带进宗门大殿');
  const sect = {
    id: 'sec1',
    type: 'cultivation-sect',
    owner: 'A' as const,
    x: 4,
    y: 4,
    hp: def.maxHp,
    kills: 0,
    moved: false,
    acted: false,
  };
  st.units.push(sect);

  renderPanel(host, {
    view: playerView(st, 'A'),
    me: 'A',
    selectedUnit: sect,
    selectedCityId: null,
    // 关键：产兵建筑被点开时就是这个字段被设上
    selectedCampId: sect.id,
    selectedTile: null,
  });

  const html = host.innerHTML;
  const text = host.textContent ?? '';
  assert.ok(text.includes('招募') || text.includes('生产'), '产兵那一块还应该在');
  assert.ok(html.includes('data-action="research:palm-thunder"'), '宗门大殿的产兵面板里要能点「研发」');
  assert.ok(text.includes('研发'), '面板上要有「研发」这一组');
  // 不还手的产兵建筑不该印"1 格内每回合 0 点"
  assert.ok(!text.includes('自动开火'), 'atk 0 的建筑不该有自动开火那一行');
});

check('多次攻击兵的面板写"还剩几次"，不是"几段"', () => {
  // 攻击次数是这回合的剩余资源，玩家得看得见才能决定"这一发打谁"。
  // 顺带钉住旧说法：面板上不能再出现"每段独立减甲"——那是被否掉的模型。
  // 口径统一成「攻击次数」："多动"这个词已经不印在界面上了。
  const host = doc.createElement('div');
  const st = createMatch({ ...DEFAULT_CONFIG, size: 12, startEra: 4, expansionIds: [] }, 917);
  st.current = 'A';
  const burst = UNIT_TYPES.mg?.burst ?? 0;
  assert.ok(burst >= 2, '这条用例需要一个多动兵（mg）');
  const mine = st.units.find((u) => u.owner === 'A' && st.unitTypes[u.type]?.category === 'combat');
  assert.ok(mine, '开局该有战斗单位');
  mine!.type = 'mg';

  const paint = () =>
    renderPanel(host, {
      view: playerView(st, 'A'),
      me: 'A',
      selectedUnit: mine!,
      selectedCityId: null,
      selectedCampId: null,
      selectedTile: null,
    });

  paint();
  let text = host.textContent ?? '';
  assert.ok(text.includes('攻击次数'), '多次攻击的兵，侧栏要写出这件事');
  assert.ok(!text.includes('多动'), '"多动"这个旧词不该再出现在界面上');
  assert.ok(text.includes(`还剩 ${burst} / ${burst} 次`), '还没出手时应该显示满次数');
  assert.ok(!text.includes('每段'), '不能再出现"每段"这种旧口径');

  // 打掉一发之后，面板要跟着变——不然玩家会以为还能再打满一轮
  (mine as Unit & { attacksLeft?: number }).attacksLeft = burst - 1;
  paint();
  text = host.textContent ?? '';
  assert.ok(text.includes(`还剩 ${burst - 1} / ${burst} 次`), '出手之后剩余次数要跟着减');
});

check('潜行兵的面板写着"隐蔽中 / 已现形"', () => {
  // 潜行/潜航/隐身 2026-11-09 起都是"出手即现形"，可这条约束在界面上原本一个字都没有：
  // 玩家开完一枪，不知道自己的兵自此整个敌方回合都露在外面。
  const host = doc.createElement('div');
  const st = createMatch({ ...DEFAULT_CONFIG, size: 12, startEra: 1, expansionIds: [] }, 919);
  st.fog = true;
  st.current = 'A';
  const scout = st.units.find((u) => u.owner === 'A' && u.type === 'scout');
  assert.ok(scout, '开局该有斥候（自带潜行）');

  // 挪到一块没人的森林上——潜行只在森林/丘陵成立。
  // 还必须离敌人两格以上：贴到相邻格就现形，那测的就不是"藏住了"。
  const spot = st.tiles.findIndex((t, k) => {
    if (t.terrain !== 'forest' || t.cityId) return false;
    const x = k % st.w;
    const y = Math.floor(k / st.w);
    return !st.units.some(
      (u) => u.y * st.w + u.x === k || (u.owner !== 'A' && Math.abs(u.x - x) + Math.abs(u.y - y) <= 1),
    );
  });
  assert.ok(spot >= 0, '这张图上该有离敌人两格以上、没人的森林');
  scout!.x = spot % st.w;
  scout!.y = Math.floor(spot / st.w);

  const paint = () =>
    renderPanel(host, {
      view: playerView(st, 'A'),
      me: 'A',
      selectedUnit: scout!,
      selectedCityId: null,
      selectedCampId: null,
      selectedTile: null,
    });

  paint();
  let text = host.textContent ?? '';
  assert.ok(text.includes('隐蔽中'), '蹲在林子里该显示"隐蔽中"');
  assert.ok(!text.includes('已现形'), '没出手就不该说已现形');

  (scout as Unit & { acted?: boolean }).acted = true;
  paint();
  text = host.textContent ?? '';
  assert.ok(text.includes('已现形'), '出过手就该说已现形');
  assert.ok(!text.includes('隐蔽中'), '出过手就不该还说隐蔽中');
});

check('溅射兵的面板写的是"现在这一发"的半径和比例', () => {
  // 半径会被扩展改（修士按境界），比例会被单位自己的 custom.splashRatio 改。
  // 侧栏要是照兵种表写死，玩家看到的就是一句谎话。
  const host = doc.createElement('div');
  const st = createMatch({ ...DEFAULT_CONFIG, size: 12, startEra: 3, expansionIds: [] }, 918);
  st.current = 'A';
  const splash = UNIT_TYPES.mortar?.splash ?? 0;
  assert.ok(splash > 0, '这条用例需要一个溅射兵（mortar）');
  const mine = st.units.find((u) => u.owner === 'A' && st.unitTypes[u.type]?.category === 'combat');
  assert.ok(mine, '开局该有战斗单位');
  mine!.type = 'mortar';

  const paint = () =>
    renderPanel(host, {
      view: playerView(st, 'A'),
      me: 'A',
      selectedUnit: mine!,
      selectedCityId: null,
      selectedCampId: null,
      selectedTile: null,
    });

  paint();
  let text = host.textContent ?? '';
  assert.ok(text.includes(`主目标 ${splash} 格内`), '溅射行要写出半径');
  assert.ok(text.includes('50%'), '没设比例时按全局默认 50% 显示');

  // 单位自带比例：面板要跟着变
  mine!.custom = { ...(mine!.custom ?? {}), splashRatio: 0.3 };
  paint();
  text = host.textContent ?? '';
  assert.ok(text.includes('30%'), '单位自带 30% 时，面板不能还写 50%');
});

check('没有浓雾的对局里，对面的金币照旧显示', () => {
  const host = doc.createElement('div');
  const st = createMatch({ ...DEFAULT_CONFIG, size: 12, startEra: 1, expansionIds: [] }, 910);
  st.players.B.gold = 321;
  renderPanel(host, {
    view: playerView(st, 'A'),
    me: 'A',
    selectedUnit: null,
    selectedCityId: null,
    selectedCampId: null,
    selectedTile: null,
  });
  assert.ok((host.textContent ?? '').includes('金币 321'), '普通对局不遮');
});

console.log('\n战况烈度');

check('挨过打的格子挂烈度层：档位、数量、收起都对', () => {
  const st = createMatch({ ...DEFAULT_CONFIG, size: 12 }, 4242);
  const view = playerView(st, 'A');
  const vis = new Set(view.visible);
  const shown = view.visible.slice(0, 2);
  let hidden = -1;
  for (let i = 0; i < st.w * st.h; i += 1) if (!vis.has(i)) { hidden = i; break; }
  assert.ok(shown.length === 2 && hidden >= 0, '这条用例要有两格可见、一格不可见');

  const host = doc.createElement('div');
  const empty = {
    selectedId: null,
    reach: [],
    targets: [],
    siegeTargets: [],
    selectedCityId: null,
    placeable: [],
    threat: [],
  };
  const cell = (i: number) => ({ x: i % st.w, y: Math.floor(i / st.w) });
  const [a, b] = shown as [number, number];

  renderBoard(host, view, { ...empty, heat: new Map([[a, 1], [b, 3]]) });

  const at = (i: number) =>
    host.querySelector<HTMLElement>(
      `.heat .fx-heat[data-x="${cell(i).x}"][data-y="${cell(i).y}"]`,
    );
  assert.ok(host.querySelector('.heat'), '棋盘里应该有一条独立的烈度层');
  assert.equal(host.querySelectorAll('.heat .fx-heat').length, 2, '只该画两个格子');
  assert.ok(at(a), '挨了一下的那格要有红罩');
  assert.ok(at(a)!.classList.contains('d1'), '档位应该是 d1');
  assert.ok(at(b)!.classList.contains('d3'), '挨了三下的档位更高');
  // 不写数字：烈度靠"闪多快 + 描边多粗 + 底色多深"表达，血条已经说明伤得多重
  assert.equal(at(a)!.querySelector('b'), null, '红罩上不该有数字');
  assert.equal(at(b)!.textContent?.trim(), '', '红罩里不该有文字');

  // 这一层必须排在棋子之后：否则兵站上去就把红盖掉了
  const order = Array.from(host.children).map((n) => n.className);
  assert.ok(
    order.indexOf('heat') > order.indexOf('units'),
    `烈度层要压在棋子上面（实际顺序 ${order.join(' → ')}）`,
  );

  // 档位封顶：挨了九下也还是 d5
  renderBoard(host, view, { ...empty, heat: new Map([[a, 9]]) });
  assert.ok(at(a)!.classList.contains('d5'), '次数再多也只到第五档');

  // 雾里的格子不画：调用方漏过滤，这一层也要兜住
  renderBoard(host, view, { ...empty, heat: new Map([[hidden, 2]]) });
  assert.equal(host.querySelectorAll('.heat .fx-heat').length, 0, '雾外的格子不该画红罩');

  // 换回合 / 没挨打：整层清空
  renderBoard(host, view, empty);
  assert.equal(host.querySelectorAll('.heat .fx-heat').length, 0, '不给 heat 就该清干净');
});

check('出手闪烁层：打到哪就闪哪，用完即散', () => {
  const st = createMatch({ ...DEFAULT_CONFIG, size: 12 }, 4243);
  const view = playerView(st, 'A');
  const vis = new Set(view.visible);
  const shown = view.visible.slice(0, 2);
  let hidden = -1;
  for (let i = 0; i < st.w * st.h; i += 1) if (!vis.has(i)) { hidden = i; break; }
  assert.ok(shown.length === 2 && hidden >= 0, '这条用例要有两格可见、一格不可见');

  const host = doc.createElement('div');
  const empty = {
    selectedId: null,
    reach: [],
    targets: [],
    siegeTargets: [],
    selectedCityId: null,
    placeable: [],
    threat: [],
  };
  const cell = (i: number) => ({ x: i % st.w, y: Math.floor(i / st.w) });
  const [a, b] = shown as [number, number];
  const at = (i: number) =>
    host.querySelector<HTMLElement>(
      `.heat-flash .fx-heat[data-x="${cell(i).x}"][data-y="${cell(i).y}"]`,
    );

  renderBoard(host, view, { ...empty, heatFlash: new Map([[a, 2], [b, 1]]), flashSeq: 1 });
  assert.ok(host.querySelector('.heat-flash'), '棋盘里应该有一条独立的闪烁层');
  assert.equal(host.querySelectorAll('.heat-flash .fx-heat').length, 2, '打到两格就闪两格');
  assert.ok(at(a)!.classList.contains('flash'), '闪烁格要挂一次性动画的类');
  assert.ok(at(a)!.classList.contains('d2'), '沿用烈度的分档：挨两下是 d2');
  assert.equal(at(a)!.getAttribute('data-flash'), '1', '批次号要写到节点上');

  // 闪烁层压在常驻烈度层之上：同一块地方同时出现时，是"刚刚这一下"更该被看见
  const order = Array.from(host.children).map((n) => n.className);
  assert.ok(
    order.indexOf('heat-flash') > order.indexOf('heat'),
    `闪烁层要排在烈度层之后（实际顺序 ${order.join(' → ')}）`,
  );

  // 同一批格子再挨一下：批次号变了就必须重写节点，否则动画不会重播
  const before = at(a);
  renderBoard(host, view, { ...empty, heatFlash: new Map([[a, 2], [b, 1]]), flashSeq: 2 });
  assert.equal(at(a)!.getAttribute('data-flash'), '2', '批次号要跟着更新');
  assert.ok(before !== at(a), '同内容不同批次也要重建节点，动画才会从头播');

  // 雾外不画：调用方漏过滤，这一层也要兜住
  renderBoard(host, view, { ...empty, heatFlash: new Map([[hidden, 1]]), flashSeq: 3 });
  assert.equal(host.querySelectorAll('.heat-flash .fx-heat').length, 0, '雾外的格子不该闪');

  // 时间到了调用方清空数据：这一层跟着空掉，不留一块红在地上
  renderBoard(host, view, empty);
  assert.equal(host.querySelectorAll('.heat-flash .fx-heat').length, 0, '不给数据就该清干净');
});

check('点自己的单位会高亮可移动范围', () => {
  const unit = doc.querySelector<HTMLElement>('.unit.owner-A');
  assert.ok(unit, '找不到 A 方棋子');
  unit.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert.ok(doc.querySelectorAll('.tile.reach').length > 0, '没有出现可移动格');
  assert.ok(doc.querySelector('.unit.selected'), '被点的单位应该有选中态');
});

check('面板显示护甲而不是旧的防御属性', () => {
  const html = doc.querySelector('.side')?.innerHTML ?? '';
  assert.ok(html.includes('护甲'), '面板里应该出现护甲');
});

check('点可达格会真的移动', () => {
  const before = doc.querySelectorAll('.unit.owner-A')[0]?.getAttribute('style');
  click('.tile.reach');
  const after = doc.querySelectorAll('.unit.owner-A')[0]?.getAttribute('style');
  assert.notEqual(before, after, '棋子位置样式应该变了');
});

check('移动后可移动范围消失（本回合已用掉移动力）', () => {
  assert.equal(doc.querySelectorAll('.tile.reach').length, 0);
});

check('点空地会弹出地形说明', () => {
  const plain = doc.querySelector<HTMLElement>('.tile.t-plain');
  assert.ok(plain, '应该有平原格');
  plain.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  const html = doc.querySelector('.side')?.innerHTML ?? '';
  assert.ok(html.includes('进入消耗'), '应该显示进入消耗');
  assert.ok(html.includes('防御'), '应该显示防御加成');
});

check('选中农民会显示产出与临水加成', () => {
  const units = Array.from(doc.querySelectorAll<HTMLElement>('.unit'));
  const farmer = units.find((u) => (u.textContent ?? '').trim().startsWith('农'));
  assert.ok(farmer, '开局应该有农民');
  farmer.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  const html = doc.querySelector('.side')?.innerHTML ?? '';
  assert.ok(html.includes('基础产出'), '应该显示产出说明（基础值）');
  assert.ok(html.includes('每回合收入'), '当前实测产出要走属性卡那行');
  assert.ok(html.includes('相邻水域'), '应该显示临水加成');
});

check('经济单位选中后，可达格上印出每格产出数字', () => {
  const st = createMatch(
    {
      size: 12,
      startEra: 1,
      aiOpponent: false,
      aiAlly: false,
      expansionIds: [],
      enabledUnits: Object.keys(UNIT_TYPES),
    },
    4242,
  );
  st.current = 'A';
  // 城边找两块空地：一块放农民，其余当可达格
  let spot: { x: number; y: number } | null = null;
  for (let y = 1; y < st.h - 1 && !spot; y++) {
    for (let x = 1; x < st.w - 1 && !spot; x++) {
      const t = st.tiles[y * st.w + x];
      if (!t || (t.terrain !== 'plain' && t.terrain !== 'hill') || t.cityId) continue;
      if (st.units.some((u) => u.x === x && u.y === y)) continue;
      spot = { x, y };
    }
  }
  assert.ok(spot, '应该有能站农民的空地');

  const farmer: Unit = {
    id: 'farmer-hint',
    type: 'farmer',
    owner: 'A',
    x: spot.x,
    y: spot.y,
    hp: st.unitTypes.farmer?.maxHp ?? 16,
    kills: 0,
    moved: false,
    acted: false,
  };
  st.units.push(farmer);

  const reach = Array.from(reachableTiles(st, farmer).keys());
  assert.ok(reach.length > 0, '农民应该有可达格');
  const hints = new Map<number, Record<string, number>>();
  for (const i of reach) {
    const y = unitYieldAt(st, farmer, i % st.w, Math.floor(i / st.w));
    if (Object.keys(y).length > 0) hints.set(i, y as Record<string, number>);
  }

  const host = doc.createElement('div');
  host.className = 'board';
  renderBoard(host, playerView(st, 'A'), {
    selectedId: farmer.id,
    reach,
    targets: [],
    siegeTargets: [],
    selectedCityId: null,
    placeable: [],
    threat: [],
    incomeHints: hints,
  });
  try {
    const badges = host.querySelectorAll('.tile-income');
    // 不再要求"每个可达格都有"：算出来是空表的格子（站上去什么都不产）
    // 以前会印一个 +0，现在直接不印。有产出的格子一个都不能少。
    assert.ok(hints.size > 0, '这个场景应该至少有一格有产出');
    assert.equal(badges.length, hints.size, '有产出的可达格都该有一个产出数字');
    const text = badges[0]?.textContent ?? '';
    assert.ok(/^\+\d+$/, `${text} 应该是 +N`);

    // 数字必须和真相源一致。**按格子对账，不按数组下标**：
    // badge 的 DOM 顺序是"棋盘的格子顺序"（逐行），而 reach 是可达搜索的顺序
    // （从脚下往外扩），两者本来就不是一回事——以前正好撞上了，地图一改就露馅。
    const tiles = [...host.querySelectorAll<HTMLElement>('.tile')];
    let matched = 0;
    for (const badge of badges) {
      const tile = badge.parentElement;
      const idx = tile ? tiles.indexOf(tile) : -1;
      assert.ok(idx >= 0, '产出数字应该挂在格子里');
      const truth = hints.get(idx);
      assert.ok(truth, `第 ${idx} 格没有真相源`);
      const gold = truth!.gold ?? 0;
      // 徽标只印金币；纯非金币的单位印的是第一项资源，这里不按金币对账
      if (gold <= 0) continue;
      const shown = Number(/^\+(\d+)/.exec(badge.textContent ?? '')?.[1] ?? -1);
      assert.equal(shown, gold, `第 ${idx} 格印的是 ${shown}，真相源是 ${gold}`);
      matched += 1;
    }
    assert.ok(matched > 0, '总得对上一格');
  } finally {
    host.remove();
  }
});

check('技能选点：方向型只认四邻，选点型全图都算（自己脚下除外）', () => {
  // 方向型：四邻热区之外一律不算，点了就是"取消施法"
  assert.equal(
    skillTargetPicked({ targeting: 'direction', onSelf: false, aimTiles: [11, 12], cell: 11 }),
    true,
    '方向型点四邻之一 = 选定',
  );
  assert.equal(
    skillTargetPicked({ targeting: 'direction', onSelf: false, aimTiles: [11, 12], cell: 47 }),
    false,
    '方向型点远处 = 不算（以前传送阵就是被这一条卡住了）',
  );
  // 选点型：任何格都算落点，唯独自己脚下当作取消（技能会判过载并照扣灵石）
  assert.equal(
    skillTargetPicked({ targeting: 'point', onSelf: false, aimTiles: [], cell: 899 }),
    true,
    '选点型要能点全图，不能被 aimTiles 拦住',
  );
  assert.equal(
    skillTargetPicked({ targeting: 'point', onSelf: true, aimTiles: [], cell: 0 }),
    false,
    '点自己脚下 = 取消，不能白扣灵石',
  );
});

check('修真灵田的面板写全多资源收入，不只金币', () => {
  const st = createMatch(
    {
      size: 12,
      startEra: 3,
      aiOpponent: false,
      aiAlly: false,
      expansionIds: ['cultivation'],
      enabledUnits: [...Object.keys(UNIT_TYPES), 'cultivation-spirit-field'],
    },
    4242,
  );
  st.current = 'A';
  const i = st.tiles.findIndex((t) => t.terrain === 'plain' && !t.cityId);
  assert.ok(i >= 0, '应该有能站灵田的平原');
  const field: Unit = {
    id: 'field1',
    type: 'cultivation-spirit-field',
    owner: 'A',
    x: i % st.w,
    y: Math.floor(i / st.w),
    hp: st.unitTypes['cultivation-spirit-field']?.maxHp ?? 30,
    kills: 0,
    moved: false,
    acted: false,
  };
  st.units.push(field);

  const host = doc.createElement('div');
  renderPanel(host, {
    view: playerView(st, 'A'),
    me: 'A',
    selectedUnit: field,
    selectedCityId: null,
    selectedCampId: null,
    selectedTile: null,
  });
  const row = [...host.querySelectorAll<HTMLElement>('.info-row')].find((el) =>
    (el.textContent ?? '').includes('每回合收入'),
  );
  assert.ok(row, '经济单位要有"每回合收入"这一行');
  const text = row!.textContent ?? '';
  assert.ok(/\d+ 金/.test(text), `要写金币：${text}`);
  assert.ok(/\d+ 灵/.test(text), `也要写灵石，不能只剩金币：${text}`);
});

check('炼器炉面板：条件不满足的法器灰着列出来，并写清缺什么', () => {
  const st = createMatch(
    {
      size: 12,
      startEra: 2,
      aiOpponent: false,
      aiAlly: false,
      expansionIds: ['cultivation'],
      enabledUnits: [
        ...Object.keys(UNIT_TYPES),
        'cultivation-forge-1',
        'cultivation-artifact-wood',
        'cultivation-artifact-stone',
      ],
    },
    4242,
  );
  st.current = 'A';
  st.players.A.gold = 900;
  // 法器要灵石：不补这一笔，按钮会因"资源不足"变灰，测不出产地条件
  st.players.A.res = { 'spirit-stone': 100 };

  // 把一片地摊平，保证炉子四周既没有森林也没有山
  const at = (x: number, y: number) => y * st.w + x;
  for (let y = 2; y <= 9; y++) {
    for (let x = 2; x <= 9; x++) st.tiles[at(x, y)] = { terrain: 'plain', cityId: null };
  }
  const forge: Unit = {
    id: 'forge1',
    type: 'cultivation-forge-1',
    owner: 'A',
    x: 5,
    y: 5,
    hp: st.unitTypes['cultivation-forge-1']?.maxHp ?? 90,
    kills: 0,
    moved: false,
    acted: false,
  };
  st.units.push(forge);

  const host = doc.createElement('div');
  const paint = () => {
    host.innerHTML = '';
    renderPanel(host, {
      view: playerView(st, 'A'),
      me: 'A',
      selectedUnit: forge,
      selectedCityId: null,
      selectedCampId: forge.id,
      selectedTile: null,
    });
  };

  paint();
  let html = host.innerHTML;
  assert.ok(html.includes('还造不出来'), '白名单里有、条件不满足的法器要单独列一组');
  const wood = host.querySelector<HTMLButtonElement>('[data-type="cultivation-artifact-wood"]');
  assert.ok(wood, '青木剑应该列出来（不能因为缺森林就消失）');
  assert.equal(wood!.disabled, true, '缺材料时该是灰的');
  assert.ok(html.includes('森林'), '按钮上要写清缺森林');

  // 把炉子北边那格改成森林：同一座炉子应该立刻能造青木剑
  st.tiles[at(5, 4)] = { terrain: 'forest', cityId: null };
  paint();
  html = host.innerHTML;
  const wood2 = host.querySelector<HTMLButtonElement>('[data-type="cultivation-artifact-wood"]');
  assert.ok(wood2, '青木剑还在列表里');
  assert.equal(wood2!.disabled, false, '挨着森林之后就点得动了');
  // 玄石印仍然缺山：它继续灰着，所以"还造不出来"这一组还在
  const stone = host.querySelector<HTMLButtonElement>('[data-type="cultivation-artifact-stone"]');
  assert.ok(stone, '玄石印也该列出来');
  assert.equal(stone!.disabled, true, '没有山就还是灰的');
  assert.ok(html.includes('山'), '玄石印的原因要写清缺山');
  void html;
});

check('军营面板不列法器：campOnly 的东西不该出现在普通产兵点', () => {
  const st = createMatch(
    {
      size: 12,
      startEra: 3,
      aiOpponent: false,
      aiAlly: false,
      expansionIds: ['cultivation'],
      enabledUnits: [...Object.keys(UNIT_TYPES), 'cultivation-artifact-wood'],
    },
    4242,
  );
  st.current = 'A';
  st.players.A.gold = 900;
  st.players.A.res = { 'spirit-stone': 100 };
  const at = (x: number, y: number) => y * st.w + x;
  for (let y = 2; y <= 9; y++) {
    for (let x = 2; x <= 9; x++) st.tiles[at(x, y)] = { terrain: 'plain', cityId: null };
  }
  // 故意让军营挨着森林：条件满足也不该冒出法器——它根本不在军营的产品线上
  st.tiles[at(5, 4)] = { terrain: 'forest', cityId: null };
  const camp = {
    id: 'camp1',
    type: 'camp',
    owner: 'A' as const,
    x: 5,
    y: 5,
    hp: st.unitTypes.camp?.maxHp ?? 34,
    kills: 0,
    moved: false,
    acted: false,
  };
  st.units.push(camp);

  const host = doc.createElement('div');
  renderPanel(host, {
    view: playerView(st, 'A'),
    me: 'A',
    selectedUnit: camp,
    selectedCityId: null,
    selectedCampId: camp.id,
    selectedTile: null,
  });
  assert.equal(
    host.querySelector('[data-type="cultivation-artifact-wood"]'),
    null,
    '军营里连灰色的法器都不该出现',
  );
  assert.ok(!host.innerHTML.includes('还造不出来'), '军营不该有"还造不出来"这一组');
});

check('建造列表按档位过滤：高过工兵时代的建筑不列出来', () => {
  const st = createMatch(
    {
      size: 12,
      startEra: 2,
      aiOpponent: false,
      aiAlly: false,
      expansionIds: [],
      enabledUnits: Object.keys(UNIT_TYPES),
    },
    4242,
  );
  st.current = 'A';
  st.players.A.gold = 900;
  // 造一个"二代的工匠，白名单里混进一座三代的堡寨"——
  // 扩展就是这么往白名单里追加条目的（能架桥的人就能修船坞），
  // 所以高代建筑完全可能出现二代的名单里。
  st.unitTypes['test-builder-x'] = {
    ...st.unitTypes.laborer,
    id: 'test-builder-x',
    name: '测试工匠',
    era: 2,
    builds: ['camp', 'camp3'],
  };
  const i = st.tiles.findIndex((t) => t.terrain === 'plain' && !t.cityId);
  const builder: Unit = {
    id: 'b1',
    type: 'test-builder-x',
    owner: 'A',
    x: i % st.w,
    y: Math.floor(i / st.w),
    hp: 20,
    kills: 0,
    moved: false,
    acted: false,
  };
  st.units.push(builder);
  const host = doc.createElement('div');
  renderPanel(host, {
    view: playerView(st, 'A'),
    me: 'A',
    selectedUnit: builder,
    selectedCityId: null,
    selectedCampId: null,
    selectedTile: null,
  });
  assert.ok(host.querySelector('[data-act="build"][data-type="camp"]'), '一代军营该列出来');
  assert.equal(
    host.querySelector('[data-act="build"][data-type="camp3"]'),
    null,
    '三代的堡寨不该挂在二代工匠的建造列表里',
  );
});

check('详情面板显示的是算上修正的真实数值', () => {
  const st = createMatch(
    {
      size: 12,
      startEra: 1,
      aiOpponent: false,
      aiAlly: false,
      expansionIds: ['veterans'],
      enabledUnits: Object.keys(UNIT_TYPES),
    },
    4242,
  );
  st.current = 'A';
  const spot = { x: 5, y: 5 };
  const vet: Unit = {
    id: 'vet1',
    type: 'militia',
    owner: 'A',
    x: spot.x,
    y: spot.y,
    hp: st.unitTypes.militia?.maxHp ?? 28,
    kills: 2,
    moved: false,
    acted: false,
  };
  st.units.push(vet);

  const host = doc.createElement('div');
  renderPanel(host, {
    view: playerView(st, 'A'),
    me: 'A',
    selectedUnit: vet,
    selectedCityId: null,
    selectedCampId: null,
    selectedTile: null,
  });
  const html = host.innerHTML;
  const base = st.unitTypes.militia?.atk ?? 0;
  assert.ok(html.includes('老兵不死'), '修正明细里要写出老兵不死');
  assert.ok(html.includes(`（攻基础 ${base}）`), `攻击力后面应该点名标出基础值 ${base}`);
  assert.ok(
    host.querySelector('.stat-mods .stat-mod b.up'),
    '有加成时应该出现带 up 样式的修正行',
  );
  const eff = effectiveStats(st, vet);
  assert.ok(html.includes(`<b>${eff.atk}`) || html.includes(`${eff.atk}（基础`), '面板数字要等于 effectiveStats');
  // 2026-11-11：攻击那一格在"有修正"时会跨两列，明细紧贴在自己那格下面。
  // 不这么放的话，明细会被挤到半格宽里，一条"老兵不死 +2"折成三行。
  assert.ok(
    host.querySelector('.stat-span .stat-mods'),
    '修正明细要在跨列的那一格里面（.stat-span .stat-mods）',
  );
});

check('属性卡：数值排成两列，标签在上、数值在下', () => {
  /*
   * 一行一条的时候，每行右边半截全空着：13px 的字，一行只用掉十二三个字符宽，
   * 一个普通兵光属性就要 140px 竖向空间。改成两列之后玩家不用先滚一屏才看得见
   * 「拆除」。这条守的是"排法"本身——数字对不对由上面那条管。
   */
  const st = createMatch(
    {
      size: 12,
      startEra: 1,
      aiOpponent: false,
      aiAlly: false,
      expansionIds: [],
      enabledUnits: Object.keys(UNIT_TYPES),
    },
    5150,
  );
  const unit = st.units.find((u) => u.owner === 'A')!;
  assert.ok(unit, '开局 A 方应该有兵');

  const host = doc.createElement('div');
  renderPanel(host, {
    view: playerView(st, 'A'),
    me: 'A',
    selectedUnit: unit,
    selectedCityId: null,
    selectedCampId: null,
    selectedTile: null,
  });

  const grid = host.querySelector<HTMLElement>('.stat-grid');
  assert.ok(grid, '属性要收进 .stat-grid（两列容器）');
  const cells = [...grid!.children].filter((el) => el.classList.contains('info-row'));
  assert.ok(cells.length >= 4, `普通兵至少四格：生命 / 移动力 / 攻击护甲 / 射程视野，实际 ${cells.length}`);
  // 竖排靠的是 DOM 顺序（span 在前、b 在后）——顺序反了 CSS 也不会换回来
  for (const cell of cells) {
    assert.ok(cell.querySelector('span') && cell.querySelector('b'), '每格都要有标签和数值');
    assert.equal(
      cell.firstElementChild?.tagName,
      'SPAN',
      '标签必须排在数值前面：竖排时先读到的就是它',
    );
  }
  assert.ok(
    (grid!.textContent ?? '').includes('生命') && (grid!.textContent ?? '').includes('移动力'),
    '生命和移动力都要在网格里',
  );
  // 没有修正时不许出现跨列块——那会空出右边一整格，看着像数字没加载出来
  assert.equal(host.querySelector('.stat-span'), null, '没有修正明细时不该有跨列块');
});

check('建造面板按用途分组：防御 / 营地 / 经济 / 桥', () => {
  /*
   * 2026-11-11 整合建造单位之后，奴隶能盖 7 样、建筑队能盖 33 样
   * （高代继承低代，还把时代军备包的工事都收了进来）。平铺一列的话
   * 玩家在一屏里找不到"我要的那座塔"，所以按用途分了四组。
   *
   * 这条守的是**分组真的出现了**，而不是只有数据改了：
   * 默认局里奴隶的 4 样正好各归一组，四组标题都该在。
   */
  const st = createMatch(
    {
      size: 12,
      startEra: 1,
      aiOpponent: false,
      aiAlly: false,
      expansionIds: [],
      enabledUnits: Object.keys(UNIT_TYPES),
    },
    5151,
  );
  st.current = 'A';
  const laborer = {
    id: 'builder-probe',
    type: 'laborer',
    owner: 'A' as const,
    x: 6,
    y: 6,
    hp: 20,
    kills: 0,
    moved: false,
    acted: false,
  };
  st.units.push(laborer);

  const host = doc.createElement('div');
  renderPanel(host, {
    view: playerView(st, 'A'),
    me: 'A',
    selectedUnit: laborer,
    selectedCityId: null,
    selectedCampId: null,
    selectedTile: null,
  });

  const titles = [...host.querySelectorAll('.recruit-group-title')].map((el) => el.textContent ?? '');
  for (const label of ['防御工事', '营地', '经济建筑', '桥']) {
    assert.ok(
      titles.some((t) => t.startsWith(label)),
      `建造面板缺了「${label}」这一组，实际分组：${titles.join(' / ')}`,
    );
  }
  // 每组标题带数量，且加起来等于按钮总数——不然"共 N 种"和实际摆出来的对不上
  const countOf = (t: string) => Number(/·\s*(\d+)$/.exec(t)?.[1] ?? 0);
  const sum = titles.reduce((n, t) => n + countOf(t), 0);
  assert.equal(
    sum,
    host.querySelectorAll('[data-act="build"]').length,
    '各组数量之和必须等于建造按钮总数',
  );
});

console.log('\n城市与产兵');

check('点自己空城会打开产兵面板', () => {
  click('.tile[data-x="0"][data-y="0"]'); // 先取消选中
  click('.tile.t-city.own-A');
  assert.ok(doc.querySelectorAll('.recruit-btn').length >= 5, '时代 I 有战斗/经济/建筑三类可造');
  const html = doc.querySelector('.side')?.innerHTML ?? '';
  assert.ok(html.includes('生产'), '面板标题应该出现生产');
  assert.ok(html.includes('升级'), '面板里应该有升级时代的入口');
  assert.ok(html.includes('驻军休整'), '面板里要写清这座城会不会回血');
});

check('产兵面板会标出升级后能解锁的兵种', () => {
  const html = doc.querySelector('.side')?.innerHTML ?? '';
  assert.ok(html.includes('升级后可解锁'), '应该提示升级能解锁什么');
  assert.ok(html.includes('长枪兵'), '二级兵种应该在提示里出现');
});

check('产兵面板按战斗 / 经济 / 建造分组', () => {
  const html = doc.querySelector('.side')?.innerHTML ?? '';
  assert.ok(html.includes('战斗单位'), '应该有战斗单位分组');
  assert.ok(html.includes('经济单位'), '应该有经济单位分组');
  assert.ok(html.includes('建造单位'), '应该有建造单位分组');
  assert.ok(html.includes('平原 +') || html.includes('丘陵 +'), '经济单位应该标注地形产出');
});

check('产兵按钮上写着血量', () => {
  // 攻甲移射都在按钮上，唯独血量缺席——新兵能顶几刀，是按下生产前的关键信息
  const btns = Array.from(doc.querySelectorAll<HTMLElement>('.recruit-btn'));
  assert.ok(btns.length > 0, '产兵面板应该开着');
  const withHp = btns.filter((b) => /血 \d+/.test(b.textContent ?? ''));
  assert.equal(withHp.length, btns.length, '每个产兵按钮都该带血量');
});

check('造兵之前悬停就能看到这个工兵能盖什么', () => {
  const wraps = Array.from(doc.querySelectorAll<HTMLElement>('.recruit-wrap[data-hover-tip]'));
  assert.ok(wraps.length > 0, '产兵按钮要挂上浮层宿主（宿主不能是 disabled 按钮）');
  const withBuilds = wraps.filter((w) =>
    (w.querySelector('.hover-tip')?.textContent ?? '').includes('可建造：'),
  );
  assert.ok(withBuilds.length > 0, '建造单位的隐藏详情里要写全可建造名单');

  // 真悬停一次：浮层节点要出现在 body 上，而且要列具体建筑名而不是"共 N 种"
  const target = withBuilds[0]!;
  target.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }));
  const tip = doc.querySelector<HTMLElement>('#hover-tip');
  assert.ok(tip && !tip.hidden, '悬停要浮出详情');
  const text = tip!.textContent ?? '';
  assert.ok(text.includes('可建造：'), '浮层里要有名单');
  assert.ok(text.includes('箭塔') || text.includes('磨坊'), '名单要是具体建筑名');
  target.dispatchEvent(new window.MouseEvent('mouseout', { bubbles: true }));
  assert.equal(tip!.hidden, true, '移开就收起');
});

check('城市里不再直接产建筑', () => {
  const html = doc.querySelector('.side')?.innerHTML ?? '';
  assert.ok(!html.includes('自动开火'), '建筑不该出现在城市生产列表里');
});

check('城内地面位站满时，空军按钮还能点（人口满了不等于造不出飞机）', () => {
  const st = createMatch(
    { ...DEFAULT_CONFIG, size: 14, startEra: 6, expansionIds: ['pack-contemporary', 'air-corps'] },
    6120,
  );
  st.fog = false;
  st.units = [];
  const city = st.cities.find((c) => c.owner === 'A')!;
  // 城内每一格都站一个地面单位：也就是面板上说的"城内已站满"
  for (const t of cityTiles(city)) {
    st.units.push({
      id: `occ-${t.x}-${t.y}`,
      type: 'militia',
      owner: 'A',
      x: t.x,
      y: t.y,
      hp: 10,
      kills: 0,
      moved: false,
      acted: false,
    });
  }
  const host = doc.createElement('div');
  renderPanel(host, {
    view: playerView(st, 'A'),
    me: 'A',
    selectedUnit: null,
    selectedCityId: city.id,
    selectedCampId: null,
    selectedTile: null,
  });

  const btns = Array.from(host.querySelectorAll<HTMLElement>('.recruit-btn'));
  const air = btns.find((b) => (b.textContent ?? '').includes('气球'));
  assert.ok(air, '这一档应该能造侦察气球');
  assert.ok(!air!.hasAttribute('disabled'), '地面位满了，空军照样该能起飞');
  const land = btns.find((b) => (b.textContent ?? '').includes('民兵'));
  assert.ok(land?.hasAttribute('disabled'), '陆军确实造不出来了，按钮该是灰的');
  assert.ok(
    (host.textContent ?? '').includes('空军还能起飞'),
    '提示要告诉玩家"占满的只是地面位"',
  );
});

check('输入法组字期间不重建搜索框（"chuan船"不会被敲两遍）', () => {
  // 事件监听挂在 #app 上做委托，所以往侧栏里塞一个同名的 input 就能测到那条路径。
  // 这条用例守的是一件很容易被"顺手优化"掉的事：组字期间那个 input 节点
  // 必须原封不动——换掉它，浏览器会把缓冲的按键重新投递进新节点，
  // 于是 "chuan" 上屏两次，最后成了 "chuanchuan船"。
  click('.tile.t-city.own-A');
  const side = doc.querySelector('.side');
  assert.ok(side, '侧栏应该在');
  const probe = doc.createElement('input');
  probe.dataset.act = 'recruit-search';
  side!.appendChild(probe);

  probe.dispatchEvent(new window.Event('compositionstart', { bubbles: true }));
  probe.value = 'chuan';
  probe.dispatchEvent(new window.Event('input', { bubbles: true }));
  assert.ok(side!.contains(probe), '组字期间不许重绘掉搜索框');

  probe.value = 'chuan船';
  probe.dispatchEvent(new window.Event('compositionend', { bubbles: true }));
  // 组字结束才重画——重画的证据就是那个探测节点被换走了
  assert.ok(!side!.contains(probe), '组字结束应该重画一次');

  // 收尾：刚才是拿真面板在测，搜索词被写进去了，后面的用例还要用这个面板
  click('.tile[data-x="0"][data-y="0"]');
  click('.tile.t-city.own-A');
});

check('点产兵按钮会真的出兵并扣钱', () => {
  const before = unitsCount();
  click('.recruit-btn');
  assert.equal(unitsCount(), before + 1, '应该多出一个单位');
});

check('选中建造单位后能看到它可建造什么', () => {
  // 先造一个奴隶
  const buttons = Array.from(doc.querySelectorAll<HTMLElement>('.recruit-btn'));
  const laborerBtn = buttons.find((b) => (b.textContent ?? '').includes('奴隶'));
  assert.ok(laborerBtn, '城市里应该能造奴隶');
  laborerBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

  const units = Array.from(doc.querySelectorAll<HTMLElement>('.unit'));
  const laborer = units.find((u) => (u.textContent ?? '').trim().startsWith('奴'));
  assert.ok(laborer, '场上应该出现奴隶');
  laborer.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

  const html = doc.querySelector('.side')?.innerHTML ?? '';
  assert.ok(html.includes('可建造'), '应该有可建造列表');
  assert.ok(html.includes('箭塔'), '奴隶应该能建箭塔');
  assert.ok(html.includes('磨坊'), '奴隶应该能建磨坊');
});

check('选卡：建造单位的按钮和悬停都不列没选到的建筑', () => {
  /*
   * 线上反馈：选卡模式下，工兵的建造按钮写着"能造箭塔"、悬停提示也列着箭塔，
   * 点下去才弹"名单外的建筑造不出来"——玩家把工兵走到位、搭上半个回合，
   * 最后一步被拒。这里守三件事：
   *   ① 建造按钮只列名单内的 + 骨架（军营、桥）；
   *   ② 悬停提示里那句"可建造：…"同样只列名单内的；
   *   ③ 骨架建筑不受名单影响。
   */
  const st = createMatch({ ...DEFAULT_CONFIG, size: 12, draftMode: true }, 6210);
  st.current = 'A';
  assert.ok(st.draft, '这一局应该有选卡');
  // 一份"什么都没选到"的名单：箭塔、磨坊都不在
  st.draft!.picks.A = [];
  st.draft!.picks.B = [];
  st.draft!.phase = 'done';
  const city = st.cities.find((c) => c.owner === 'A');
  assert.ok(city, '应该有己方城市');
  const builder: Unit = {
    id: 'draft-builder',
    type: 'laborer',
    owner: 'A',
    x: city!.x + (st.config.citySize ?? 2),
    y: city!.y,
    hp: 20,
    kills: 0,
    moved: false,
    acted: false,
  };
  st.units.push(builder);

  // ① 建造按钮
  const usHost = doc.createElement('div');
  renderPanel(usHost, {
    view: playerView(st, 'A'),
    me: 'A',
    selectedUnit: builder,
    selectedCityId: null,
    selectedCampId: null,
    selectedTile: null,
  });
  assert.equal(
    usHost.querySelector('[data-act="build"][data-type="tower"]'),
    null,
    '没选到箭塔，就不该有箭塔按钮',
  );
  assert.ok(
    usHost.querySelector('[data-act="build"][data-type="bridge"]'),
    '桥是骨架建筑，永远能造',
  );
  const listText = usHost.innerHTML;
  assert.ok(!listText.includes('箭塔'), '建造区里不该出现"箭塔"三个字');

  // ② 悬停提示（在城市产兵面板里，奴隶那张卡的 hover-tip）
  const cityHost = doc.createElement('div');
  renderPanel(cityHost, {
    view: playerView(st, 'A'),
    me: 'A',
    selectedUnit: null,
    selectedCityId: city!.id,
    selectedCampId: null,
    selectedTile: null,
  });
  const tips = Array.from(cityHost.querySelectorAll('.hover-tip')).map((t) => t.textContent ?? '');
  const buildTip = tips.find((t) => t.includes('可建造：'));
  assert.ok(buildTip, '奴隶的悬停提示里应该有"可建造："那一行');
  assert.ok(!buildTip!.includes('箭塔'), `悬停提示不该列没选到的箭塔：${buildTip}`);
  assert.ok(buildTip!.includes('木桥'), '骨架建筑（桥）要在提示里');
});

check('数值行到处都带「视野」：产兵按钮 / 建造清单 / 棋子悬停', () => {
  /*
   * 2026-11-09 的统一：数值行只有一处实现（`core/info.unitStatLine`），
   * 里面含视野。这条盯的是"界面上真的出现了"，不是"函数返回值里有"。
   */
  const recruit = doc.querySelector<HTMLElement>('.recruit-btn');
  assert.ok(recruit, '应该有产兵按钮');
  const rText = recruit.textContent ?? '';
  assert.ok(/视野 \d+/.test(rText), `产兵按钮的数值行里要有视野：${rText}`);
  assert.ok(/射 \d+/.test(rText), '射程也要还在（别为了加视野把它挤掉）');

  // 棋子本身的悬停提示（title）
  const unitEl = doc.querySelector<HTMLElement>('.unit');
  assert.ok(unitEl, '场上应该有棋子');
  const title = unitEl.getAttribute('title') ?? '';
  assert.ok(/视野 \d+/.test(title), `棋子悬停里要有视野：${title}`);
});

check('点敌方城市显示攻城提示', () => {
  const enemyTile = doc.querySelector<HTMLElement>('.tile.t-city.own-B');
  assert.ok(enemyTile, '找不到敌方城市格');
  enemyTile.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  const html = doc.querySelector('.side')?.innerHTML ?? '';
  assert.ok(html.includes('打空才能易主'), '应该提示必须打空耐久');
});

console.log('\n回合与交接');

check('点结束回合会弹出交接遮罩', () => {
  click('[data-act="end-turn"]');
  assert.ok(doc.querySelector('.handoff'), '应该出现交接遮罩');
});

check('遮罩上写的是下一位玩家', () => {
  const text = doc.querySelector('.handoff')?.textContent ?? '';
  // 双方现在按颜色叫：A 是红方，B 是蓝方
  assert.ok(text.includes('蓝方'), `遮罩内容：${text.slice(0, 40)}`);
});

check('点开始后遮罩消失，轮到对方操作', () => {
  click('[data-act="handoff-start"]');
  assert.equal(doc.querySelector('.handoff'), null);
  const badge = doc.querySelector('.turn-badge')?.textContent ?? '';
  assert.ok(badge.includes('轮到你'), `徽章内容：${badge.trim()}`);
});

console.log('\n迷雾过滤');

check('B 的界面上看不到 A 后场的单位', () => {
  // 地图是随机生成的：A 的出发阵位有时整好落在 B 的视野边上，
  // 写死"少于 6 个"会随地图抽查跑出假报警。这里只断言迷雾确实挡掉了一部分，
  // 严格程度交给下一条——关掉迷雾必须能看见更多单位。
  const total = 7; // 开局每方 5 个战斗单位 + 2 个经济单位
  const visibleEnemies = doc.querySelectorAll('.unit.owner-A').length;
  assert.ok(visibleEnemies < total, `B 视野内 ${visibleEnemies} 个 A 方单位，跟全图一样多`);
  assert.ok(doc.querySelectorAll('.tile.out').length > 0, '盘面上应该有还没探到的格子');
});

check('关掉迷雾后双方单位全部出现', () => {
  const before = unitsCount();
  click('[data-act="toggle-fog"]');
  assert.ok(unitsCount() > before, '关掉迷雾应该看到更多单位');
  assert.equal(doc.querySelectorAll('.tile.out').length, 0, '关掉迷雾后不该再有暗格');
});

check('第一次来：首页的「继续上一局」是灰的（开机自动存档不算"打过"）', () => {
  /*
   * 启动流程末尾会无条件 saveMatch() 一次——新建的这局当场落盘。
   * 如果「继续」直接看 loadMatch()，第一次来的人会看到一个亮着的按钮，
   * 点下去接着打的是一张谁都没动过的随机棋盘。这条钉住那个判据。
   */
  const home = doc.querySelector('.title-screen');
  assert.ok(home, '启动就应该出首页');
  const cont = home!.querySelector<HTMLButtonElement>('[data-title="continue"]');
  assert.ok(cont, '首页要有「继续上一局」');
  assert.equal(cont!.disabled, true, '第一次来没有可接着打的一局');
});

console.log('\n开局设置');

/**
 * 打开开局面板。
 *
 * 2026-11-04 起「开局」只剩首页一个门口：顶栏那颗按钮（现在叫「首页」）
 * 只负责回到门面，真正的配置面板由首页的「开始对局」打开。
 * 用例里凡是"要开一局"的地方都走这里，别各自拼两步点击——
 * 将来入口再挪一次，只需要改这一个函数。
 */
function openSetup(): void {
  goHome();
  assert.ok(doc.querySelector('.title-screen'), '顶栏那颗按钮应该先把人送回首页');
  click('[data-title="new"]');
}

check('顶栏「设置」→「回首页」回到门面，再点「开始对局」才打开设置面板', () => {
  // 2026-11-11：顶栏不再直接放「首页」，它随规则书/反馈/导出一起进了设置弹窗
  click('[data-act="settings"]');
  assert.ok(doc.querySelector('.modal-mask'), '顶栏的「设置」要打开弹窗');
  click('[data-act="new-game"]');
  const home = doc.querySelector('.title-screen');
  assert.ok(home, '顶栏那颗按钮应该打开首页');
  assert.ok(!doc.querySelector('.modal-mask'), '回首页这一步不该顺手弹出设置面板');

  click('[data-title="new"]');
  assert.ok(doc.querySelector('.modal-mask'), '应该弹出设置面板');
  assert.ok(doc.querySelectorAll('.expansion-item').length >= 6, '应该列出全部扩展规则');
  assert.ok(doc.querySelectorAll('[data-size]').length >= 3, '应该能选棋盘大小');
  // 兵种池不再直接铺在页面上：战役页只有一行摘要 + 一颗「调整兵种池」
  assert.ok(doc.querySelector('[data-act="unit-pool"]'), '应该有兵种池入口');
  assert.equal(doc.querySelectorAll('[data-unit]').length, 0, '收起来了：没点开之前不该有 chip');
  assert.ok(doc.querySelector('[data-ai="1"]'), '应该能选人机对战');
  assert.ok(doc.querySelectorAll('[data-era]').length >= 5, '应该能选起始时代');
  // 双人热座的时候选"AI 有多聪明"是没有意义的，这一行不该出现
  assert.equal(doc.querySelector('[data-ailevel]'), null, '热座模式不该有难度选项');
});

check('先手可以选红方 / 蓝方 / 随机，随机要说明按种子抽', () => {
  const active = () =>
    doc.querySelector<HTMLElement>('[data-first].active')?.dataset.first ?? '';
  assert.equal(doc.querySelectorAll('[data-first]').length, 3, '应该有红方/蓝方/随机三档');
  assert.equal(active(), 'A', '默认是红方先手');

  click('[data-first="B"]');
  assert.equal(active(), 'B', '点蓝方先手应该切过去');

  click('[data-first="random"]');
  assert.equal(active(), 'random', '点随机应该切过去');
  const hints = [...doc.querySelectorAll<HTMLElement>('.field-hint')]
    .map((el) => el.textContent ?? '')
    .join(' ');
  assert.ok(hints.includes('种子'), '选了随机要说明"按种子抽、抽完存成什么"');

  // 切回默认，别把后面的用例带偏
  click('[data-first="A"]');
  assert.equal(active(), 'A');
});

check('扩展条目只印一句话，规则细则留给规则书', () => {
  /*
   * 2026-11-04：面板原来直接印 `summary`。一条扩展动辄一百多字，
   * 有的干脆把十几个兵种名一口气列完（"桨帆船、德罗蒙、卡拉克、盖伦……"），
   * 二十几条挤在一屏里，玩家读完才知道自己该不该勾。
   * 现在面板只印 `blurb`（一句话），summary 留在规则书的合册总表里。
   *
   * 2026-11-12：卡片里多了「关系」标签（前置/冲突/联动），所以字数只量
   * **说明那一行**——把标签一起数进去，"海军"就会因为"联动：信息化"而超标。
   */
  const item = doc.querySelector<HTMLElement>('[data-exp="naval"]')?.closest('.expansion-item');
  assert.ok(item, '面板里应该有「海军」这一条');
  const desc = item!.querySelector<HTMLElement>('.expansion-body > span:not(.expansion-tags)');
  assert.ok(desc, '卡片里该有说明那一行');
  const text = desc!.textContent ?? '';
  assert.ok(text.includes('从桨帆船到航母'), `面板该印那句 blurb，实际是：${text.trim()}`);
  assert.ok(!text.includes('德罗蒙'), '整串船名不该搬进面板——那些在规则书里');
  assert.ok(text.trim().length <= 40, `一条扩展的说明在面板上不该超过一行，实际 ${text.trim().length} 字`);
});

check('扩展卡片标出三种关系：前置（蓝）· 冲突（红）· 联动（绿）', () => {
  /*
   * 玩家在这里要回答的是同一个问题——"这个包和别的包什么关系"。
   * 三种关系的形状一样、只有底色不同，所以这里只查"哪一类标签出现在谁身上"。
   *
   * 冲突尤其要**两侧都标**：只写在被冲突的那一侧，另一张卡上什么都没写，
   * 玩家勾下去才被拒，那种体验比没有提示更差。
   */
  const chipsOf = (id: string): HTMLElement[] => {
    const card = doc.querySelector<HTMLElement>(`[data-exp="${id}"]`)?.closest('.expansion-item');
    assert.ok(card, `面板里应该有「${id}」这一条`);
    return [...card!.querySelectorAll<HTMLElement>('.expansion-req')];
  };

  const city = chipsOf('city-works');
  const clash = city.find((c) => c.classList.contains('is-clash'));
  assert.ok(clash, '城郭要标出冲突');
  assert.ok(clash!.textContent?.includes('修真'), `冲突标签该指名道姓，实际：${clash!.textContent}`);

  const cult = chipsOf('cultivation');
  assert.ok(
    cult.some((c) => c.classList.contains('is-clash') && c.textContent?.includes('城郭')),
    '修真那一侧也要标出来（关系只写在城郭的数据里，显示要对称）',
  );

  const fan = chipsOf('fantasy');
  const link = fan.find((c) => c.classList.contains('is-link'));
  assert.ok(link, '奇想要标出联动');
  assert.ok(link!.textContent?.includes('信息化'), `联动标签该写出目标，实际：${link!.textContent}`);

  // 前置那一类还是原来的写法（太空战争依赖太空时代）
  const sw = chipsOf('space-war');
  assert.ok(
    sw.some((c) => !c.classList.contains('is-clash') && !c.classList.contains('is-link') && c.textContent?.includes('太空时代')),
    '前置还是蓝色的那一种',
  );
});

check('勾选冲突的包会被拒绝，并说清是谁挡着', () => {
  /*
   * 规则层会把冲突的那一包剔掉（`enabledExpansionIds`），但那对玩家是**静默**的：
   * 他勾了、开局了，才发现少了一整包。所以面板要在勾选这一刻就拒绝，
   * 并写出挡路的那一个——玩家自己决定撤哪个。
   */
  const box = (id: string): HTMLInputElement => {
    const el = doc.querySelector<HTMLInputElement>(`[data-exp="${id}"]`);
    assert.ok(el, `找不到 ${id} 的勾选框`);
    return el!;
  };

  if (!box('city-works').checked) box('city-works').click();
  assert.equal(box('city-works').checked, true, '前提：城郭已经勾上');

  // 勾修真：应当被拒（paint 之后要重新查节点）
  box('cultivation').click();
  assert.equal(box('cultivation').checked, false, '冲突的包不该被勾上');
  const note = doc.querySelector<HTMLElement>('.map-note.is-bad');
  assert.ok(note, '该给一行提示');
  assert.ok(note!.textContent?.includes('修真'), `提示要指名道姓，实际：${note!.textContent}`);

  // 收尾：把城郭取消，别把这一局的配置留给后面的用例
  box('city-works').click();
  assert.equal(box('city-works').checked, false, '取消之后能正常关掉');
});

check('状态徽章：自己人和敌人都看得见（含自己的产兵建筑）', () => {
  /*
   * 2026-11-12 实机反馈："看不到自己中了什么状态，只能看见敌方的"。
   *
   * 根因不是数据、也不是 CSS：**自己的产兵建筑走的是 `renderCamp` 这条支路**，
   * 不是通用单位卡。同一座军营，敌方点开有「中毒 2 回合」，自己点开只有血条——
   * 而军营正是最容易被毒/烧的建筑，掉血却看不到来源最难查。
   *
   * 这条用例把四条路都钉住：自己的兵、敌方的兵、自己的营、敌方的营。
   */
  const host = doc.createElement('div');
  const st = createMatch({ ...DEFAULT_CONFIG, size: 12, startEra: 3, expansionIds: [] }, 4477);
  st.current = 'A';
  const paint = (input: Partial<Parameters<typeof renderPanel>[1]>) =>
    renderPanel(host, {
      view: playerView(st, 'A'),
      me: 'A',
      selectedUnit: null,
      selectedCityId: null,
      selectedCampId: null,
      selectedTile: null,
      ...input,
    });

  const mine = st.units.find((u) => u.owner === 'A' && st.unitTypes[u.type]?.category === 'combat')!;
  const foe = st.units.find((u) => u.owner === 'B' && st.unitTypes[u.type]?.category === 'combat')!;
  assert.ok(mine && foe, '开局该有两边的战斗单位');
  mine.status = { poison: 2 };
  foe.status = { burn: 2 };

  paint({ selectedUnit: mine });
  assert.ok(host.querySelector('.status-chip'), '自己的兵要显示状态徽章');
  paint({ selectedUnit: foe });
  assert.ok(host.querySelector('.status-chip'), '敌方的兵也要显示');

  // 产兵建筑：自己走 renderCamp，敌方走通用卡——两条都要有
  const campDef = UNIT_TYPES.camp ?? Object.values(st.unitTypes).find((d) => d.id.startsWith('camp'));
  assert.ok(campDef, '应该能找到一个产兵建筑定义');
  const put = (owner: 'A' | 'B', x: number, y: number) => {
    const u: Unit = {
      id: `camp-${owner}`,
      type: campDef!.id,
      owner,
      x,
      y,
      hp: campDef!.maxHp,
      kills: 0,
      moved: false,
      acted: false,
      status: { poison: 2 },
    };
    st.units.push(u);
    st.tiles[y * st.w + x] = { terrain: 'plain', cityId: null };
    return u;
  };
  const mineCamp = put('A', 5, 5);
  paint({ selectedUnit: mineCamp, selectedCampId: mineCamp.id });
  assert.ok(host.textContent?.includes('中毒'), '自己的军营也要写中毒');
  assert.equal(host.querySelectorAll('.status-chip').length >= 1, true, '自己的军营要有状态徽章');

  const foeCamp = put('B', 7, 5);
  paint({ selectedUnit: foeCamp });
  assert.ok(host.textContent?.includes('中毒'), '敌方的军营照旧');
});
/** 兵种池弹层：开着就别再点一次（第二次点会把上一层盖回去） */
function openPool(): void {
  if (!doc.querySelector('.pool-layer')) click('[data-act="unit-pool"]');
}

function closePool(): void {
  if (doc.querySelector('.pool-layer')) click('[data-act="unit-pool-close"]');
}

check('兵种池收进一层弹层：点开才出现全表，按时代分组', () => {
  openPool();
  assert.ok(doc.querySelector('.pool-layer'), '应该盖出一层兵种池');
  assert.ok(doc.querySelectorAll('[data-unit]').length >= 4, '应该能选参战兵种');
  assert.ok(doc.querySelectorAll('.pool-body .era-group').length >= 3, '按时代分组');
  // 点外面（遮罩）只关这一层，不把整个开局设置一起关掉
  doc.querySelector<HTMLElement>('.modal-mask')!.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert.equal(doc.querySelector('.pool-layer'), null, '点遮罩应该只收起兵种池');
  assert.ok(doc.querySelector('.start-panel'), '开局设置还在');
});

/** 勾/取消一个扩展。**每次都要重新取一次节点**：勾选会整块重绘面板，
 *  上一次抓到的那个 checkbox 已经是野节点了，事件根本冒不到遮罩上。 */
function setExpansion(id: string, on: boolean): void {
  const box = doc.querySelector<HTMLInputElement>(`[data-exp="${id}"]`);
  assert.ok(box, `开局面板里应有「${id}」这一项`);
  box!.checked = on;
  box!.dispatchEvent(new window.Event('change', { bubbles: true }));
}

check('扩展兵种也在兵种池里，而且真的关得掉', () => {
  // 这一条是这次改动的正题：以前扩展带的兵是"无条件并入池子"的，
  // 面板上根本看不到它们，更别说关掉。
  setExpansion('naval', true);

  openPool();
  const chips = [...doc.querySelectorAll<HTMLElement>('[data-unit]')];
  const galley = chips.find((el) => el.dataset.unit === 'nv_galley');
  assert.ok(galley, '「海军」勾上之后，桨帆船应该出现在兵种池里');
  assert.ok(galley!.classList.contains('is-extra'), '扩展兵种要能和本体兵种区分开');
  assert.ok(galley!.classList.contains('active'), '扩展兵种默认是开着的');

  // 关掉它：chip 就地翻转，数字要跟着变
  const before = Number(doc.querySelector('[data-pool-count]')?.textContent ?? '0');
  galley!.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert.ok(!galley!.classList.contains('active'), '点一下应该关掉');
  const after = Number(doc.querySelector('[data-pool-count]')?.textContent ?? '0');
  assert.equal(after, before - 1, '「已选」要跟着少一个');

  // 收起来之后，摘要里的数字也是关着的那个
  closePool();
  assert.equal(
    Number(doc.querySelector('[data-pool-count]')?.textContent ?? '0'),
    after,
    '收起弹层后摘要要接着显示关掉之后的数',
  );

  // 换一回：把「海军」关掉，这一包的兵不该留着"关掉"的记录
  setExpansion('naval', false);
  openPool();
  assert.equal(
    doc.querySelector('[data-unit="nv_galley"]'),
    null,
    '扩展关掉之后，它带的兵种要整批离开名单',
  );
  closePool();
});

check('选了人机对战才出现三档 AI：初级 / 中级 / 高级，默认高级', () => {
  const activeLevel = () =>
    doc.querySelector<HTMLElement>('[data-ailevel].active')?.dataset.ailevel ?? '';
  const labels = () =>
    [...doc.querySelectorAll<HTMLElement>('[data-ailevel]')].map((el) => (el.textContent ?? '').trim());

  click('[data-ai="1"]');
  assert.equal(doc.querySelectorAll('[data-ailevel]').length, 3, '应该出现三档按钮');
  // 顺序是低到高：中级原来叫"战术 AI · 测试"，高级档现在跑的是合并上游之后的引擎
  assert.deepEqual(labels(), ['初级 AI', '中级 AI', '高级 AI'], '三档的文案与顺序');
  assert.equal(activeLevel(), 'advanced', '默认应该是高级 AI');

  click('[data-ailevel="basic"]');
  assert.equal(activeLevel(), 'basic', '点初级应该切过去');
  click('[data-ailevel="tactic"]');
  assert.equal(activeLevel(), 'tactic', '点中级 AI 应该切过去');
  click('[data-ailevel="advanced"]');
  assert.equal(activeLevel(), 'advanced', '点高级应该切回来');

  // 切回热座，别把后面的"人对人"用例带成 AI 局
  click('[data-ai="0"]');
  assert.equal(doc.querySelector('[data-ailevel]'), null, '切回热座应该收起来');
});

check('测试 AI 和三个档位排在同一行，并且写明自带全视野', () => {
  /*
   * 2026-11-06 上线：自博弈练出来的策略网络进了「AI」这一栏。
   *
   * 三条要在界面上钉住：
   *   1. 它在同一行（玩家是在"给对面挑个对手"的时候看见它的）；
   *   2. 它和三个档位互斥——选了它就等于换内核，不该同时亮着「高级 AI」；
   *   3. 它的说明必须写清"自带全视野"。这不是文案洁癖：手写 AI 只吃
   *      迷雾过滤后的视图，而它直接读盘面，开雾也看得见你——不写出来
   *      就是拿一个不公平的对手当公平的用。
   */
  click('[data-ai="1"]');
  const net = () => doc.querySelector<HTMLElement>('[data-aibrain="net"]');
  assert.ok(net(), '人机对战时应该能选到测试 AI');
  assert.ok((net()!.textContent ?? '').includes('全视野'), '按钮上要直接写着全视野');
  assert.equal(net()!.closest('.ai-level-row'), doc.querySelector('.ai-level-row'), '它和三个档位是同一行');

  click('[data-aibrain="net"]');
  assert.ok(net()!.classList.contains('active'), '点它应该亮起来');
  assert.equal(doc.querySelector('[data-ailevel].active'), null, '选了测试 AI 就不该同时亮着档位');

  // 说明文案要写明全视野，否则玩家只会以为它是"第四档"
  const section = net()!.closest('section')!;
  assert.ok((section.textContent ?? '').includes('自带全视野'), '这一栏要有一句"自带全视野"的说明');

  click('[data-ailevel="advanced"]');
  assert.equal(net()!.classList.contains('active'), false, '点档位应该切回手写引擎');
  assert.equal(
    doc.querySelector<HTMLElement>('[data-ailevel].active')?.dataset.ailevel,
    'advanced',
    '切回来应该落在高级 AI',
  );

  // 指挥官模式的 AI 只执行玩家排的队列，网络内核不认队列——这一档不提供
  click('[data-role="commander"]');
  assert.equal(net(), null, '指挥官模式下不该出现测试 AI');
  click('[data-role="full"]');

  click('[data-ai="0"]');
  assert.equal(net(), null, '切回热座应该收起来');
});

check('选起始时代会顺手换成配套的棋盘尺寸', () => {
  // 开局面板这时候已经开着（首屏在没有存档时会自动弹出），不再重复打开
  const activeSize = () =>
    doc.querySelector<HTMLElement>('[data-size].active')?.dataset.size ?? '';

  click('[data-era="1"]');
  assert.equal(activeSize(), '12', '青铜应该配 12×12');
  click('[data-era="2"]');
  assert.equal(activeSize(), '16', '铁器应该配 16×16');
  click('[data-era="3"]');
  assert.equal(activeSize(), '20', '火器应该配 20×20');
  click('[data-era="1"]');
});

check('棋盘边长可以自己填，范围 4~64，越界会被夹住', () => {
  const input = doc.querySelector<HTMLInputElement>('[data-field="size"]');
  assert.ok(input, '开局面板里应该有自定义边长输入框');
  assert.equal(input.min, '4', '下限 4');
  assert.equal(input.max, '64', '上限 64');

  // 输入 30：不是预设值，所以不该有 chip 高亮
  input.value = '30';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  assert.equal(
    doc.querySelectorAll('[data-size].active').length,
    0,
    '30 不是预设尺寸，不该有 chip 亮着',
  );

  // 输入越界：失焦时夹回上限并写回框里
  input.value = '999';
  input.dispatchEvent(new window.Event('change', { bubbles: true }));
  assert.equal(input.value, '64', '越界要夹到上限并写回去');

  // 回到预设 20，后面的用例按 20×20 的布局走
  input.value = '20';
  input.dispatchEvent(new window.Event('change', { bubbles: true }));
  assert.ok(
    doc.querySelector('[data-size="20"]')?.classList.contains('active'),
    '20 是预设值，要重新亮起来',
  );
});

check('能选地貌与地形对称方式', () => {
  assert.ok(doc.querySelectorAll('[data-mapstyle]').length >= 4, '应该有地貌选项');
  assert.ok(doc.querySelectorAll('[data-symmetry]').length >= 2, '应该有对称方式选项');
  const style = doc.querySelector<HTMLElement>('[data-mapstyle="ridge"]');
  assert.ok(style, '应该有山岭选项');
  style.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert.ok(
    doc.querySelector<HTMLElement>('[data-mapstyle="ridge"]')?.classList.contains('active'),
    '点了之后应该高亮',
  );
});

check('地貌按钮只在勾了「地形高差」之后才出现', () => {
  // 地貌是扩展的菜单项，不是本体的常量表：高原/峡谷/沼泽/群岛/大川
  // 这五颗 chip 完全由"勾没勾那个扩展"决定（火山群已随熔岩/火山一起删掉）。
  const extra = ['highland', 'canyon', 'marsh', 'isles', 'river'];

  // 默认没勾：一颗都不该有，否则玩家会选到一张"规则里没有高度"的图
  for (const id of extra) {
    assert.equal(doc.querySelector(`[data-mapstyle="${id}"]`), null, `没勾扩展不该有 ${id}`);
  }
  // 但那五种之外的基础地貌要在（别为了藏而把整行都藏了）
  for (const id of ['random', 'river-h', 'ridge', 'open']) {
    assert.ok(doc.querySelector(`[data-mapstyle="${id}"]`), `基础地貌 ${id} 该一直在`);
  }

  // 勾上扩展：五颗当场出现（面板会整块重绘，所以要重新查节点）
  const box = doc.querySelector<HTMLInputElement>('[data-exp="height-terrain"]');
  assert.ok(box, '「地形高差」应该出现在扩展列表里（它已经对玩家开放）');
  box.checked = true;
  box.dispatchEvent(new window.Event('change', { bubbles: true }));
  for (const id of extra) {
    assert.ok(doc.querySelector(`[data-mapstyle="${id}"]`), `勾了扩展应该出现 ${id}`);
  }

  // 取消勾选：又消失（选了高原地貌的还要退回随机，见下一条）
  const off = doc.querySelector<HTMLInputElement>('[data-exp="height-terrain"]');
  assert.ok(off, '取消勾选时节点还在');
  off.checked = false;
  off.dispatchEvent(new window.Event('change', { bubbles: true }));
  for (const id of extra) {
    assert.equal(doc.querySelector(`[data-mapstyle="${id}"]`), null, `取消勾选后 ${id} 该收起来`);
  }
});

check('关掉扩展时，选中的高原地貌退回随机', () => {
  // 否则存档里会留着"上次选了群岛"，下次开局画出一张规则里没有浅流的图。
  const box = doc.querySelector<HTMLInputElement>('[data-exp="height-terrain"]');
  assert.ok(box);
  box.checked = true;
  box.dispatchEvent(new window.Event('change', { bubbles: true }));
  const chip = doc.querySelector<HTMLElement>('[data-mapstyle="isles"]');
  assert.ok(chip, '勾了扩展应该有群岛');
  chip.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert.ok(
    doc.querySelector<HTMLElement>('[data-mapstyle="isles"]')?.classList.contains('active'),
    '点了群岛应该高亮',
  );

  const off = doc.querySelector<HTMLInputElement>('[data-exp="height-terrain"]');
  assert.ok(off);
  off.checked = false;
  off.dispatchEvent(new window.Event('change', { bubbles: true }));
  assert.ok(
    doc.querySelector<HTMLElement>('[data-mapstyle="random"]')?.classList.contains('active'),
    '扩展关掉之后地貌该退回随机',
  );
});

check('扩展规则可以勾选并高亮', () => {
  const box = doc.querySelector<HTMLInputElement>('[data-exp="veterans"]');
  assert.ok(box, '找不到老兵扩展');
  box.checked = true;
  box.dispatchEvent(new window.Event('change', { bubbles: true }));
  assert.ok(doc.querySelector('.expansion-item.on'), '勾选后卡片应该高亮');
});

check('兵种至少保留一个，不能全取消', () => {
  openPool();
  const total = doc.querySelectorAll('[data-unit]').length;
  assert.ok(total >= 4);
  // 兵种 chip 是就地翻转的（不重绘弹层），所以还能抓住同一个节点
  for (let i = 0; i < total + 2; i++) {
    const on = doc.querySelector<HTMLElement>('[data-unit].active');
    if (!on) break;
    on.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  }
  assert.equal(doc.querySelectorAll('[data-unit].active').length, 1, '最后应该强制留下一个兵种');
});

check('兵种池的两颗批量按钮：全选 / 只留本体', () => {
  click('[data-act="unit-pool-all"]');
  const total = doc.querySelectorAll('[data-unit]').length;
  assert.equal(doc.querySelectorAll('[data-unit].active').length, total, '全选＝一格不落');
  click('[data-act="unit-pool-base"]');
  assert.equal(
    doc.querySelectorAll('[data-unit].is-extra.active').length,
    0,
    '只留本体＝扩展 / 自定义兵全部关掉',
  );
  assert.ok(doc.querySelectorAll('[data-unit].active').length >= 4, '本体兵种一个不少');
  click('[data-act="unit-pool-all"]');
  closePool();
});

check('开始页面：没有存档时「继续」是灰的，点「开始对局」会交回控制权', () => {
  /*
   * 首页是玩家看见的第一屏。以前第一屏是**一张已经开局的随机棋盘**，
   * 没有标题、没有下一步提示——这条守的是"它至少把门面这件事做对了"。
   *
   * 三个断言：主按钮存在且在焦点上、没有存档时「继续」不可点、
   * 点「开始对局」会关掉这一层并把控制权交回去。
   */
  const host = doc.createElement('div');
  doc.body.appendChild(host);
  let started = false;
  let imported = false;
  let edited = false;
  let replayed = false;
  const close = openTitle(host, {
    hasSave: false,
    version: '0.0.0-test',
    onNew: () => { started = true; },
    onTutorial: () => {},
    onContinue: () => {},
    onOnline: () => {},
    onManual: () => {},
    onEditor: () => { edited = true; },
    onImport: () => { imported = true; },
    onReplay: () => { replayed = true; },
  });

  const box = host.querySelector('.title-screen');
  assert.ok(box, '首页应该挂上来');
  assert.ok((host.textContent ?? '').includes('时代与回旋镖'), '要有游戏名');
  const cont = host.querySelector<HTMLButtonElement>('[data-title="continue"]')!;
  assert.equal(cont.disabled, true, '没有存档时「继续上一局」不该能点');

  const start = host.querySelector<HTMLButtonElement>('[data-title="new"]')!;
  assert.equal(doc.activeElement, start, '焦点应在主按钮上（键盘两下开局）');

  // 「兵种编辑器」和「导入对局」搬到了这一行（2026-11-04）。编辑兵种不撤层：
  // 改完还要接着改，或者直接开局；导入则和开始/继续同级，等于进入某一局。
  host.querySelector<HTMLElement>('[data-title="editor"]')!.click();
  assert.equal(edited, true, '首页的「兵种编辑器」要交回控制权');
  assert.ok(host.querySelector('.title-screen'), '开编辑器不该把首页撤掉');

  start.click();
  assert.equal(started, true, '点「开始对局」要交回控制权');
  assert.ok(!host.querySelector('.title-screen'), '点完要把这一层撤掉');

  // 重新挂一层来试导入：它是会撤层的
  const close2 = openTitle(host, {
    hasSave: true,
    version: '0.0.0-test',
    onNew: () => {},
    onTutorial: () => {},
    onContinue: () => {},
    onOnline: () => {},
    onManual: () => {},
    onEditor: () => {},
    onImport: () => { imported = true; },
    onReplay: () => { replayed = true; },
  });
  host.querySelector<HTMLElement>('[data-title="import"]')!.click();
  assert.equal(imported, true, '首页的「导入对局」要交回控制权');
  assert.ok(!host.querySelector('.title-screen'), '导入是进入某一局，这层要撤掉');

  // 复盘：同级的第三个入口，也是会撤层的那种（选完文件要看见棋盘）
  openTitle(host, {
    hasSave: true,
    version: '0.0.0-test',
    onNew: () => {},
    onTutorial: () => {},
    onContinue: () => {},
    onOnline: () => {},
    onManual: () => {},
    onEditor: () => {},
    onImport: () => {},
    onReplay: () => { replayed = true; },
  });
  host.querySelector<HTMLElement>('[data-title="replay"]')!.click();
  assert.equal(replayed, true, '首页的「复盘」要交回控制权');
  assert.ok(!host.querySelector('.title-screen'), '复盘要看见棋盘，这层要撤掉');

  close();
  close2();
  host.remove();
});

check('起始时代只摆到这一局的上限：勾上「信息化」才多出第六格', () => {
  /*
   * 2026-11-04 之后第六代只剩一道门：「信息化」的 unlockEra。
   * 「现代战争」不再是独立的一个勾（它并进了「时代军备」），
   * 所以这条用例从"加料包自动补前置"改成"分清谁是开关、谁只是带兵"。
   */
  const erasNow = () =>
    Array.from(doc.querySelectorAll('[data-era]')).map((n) => n.textContent?.trim());
  assert.deepEqual(erasNow(), ['青铜', '铁器', '火器', '蒸汽', '机械化'], '不勾包时五格封顶');

  const arms = doc.querySelector<HTMLInputElement>('[data-exp="era-arms"]');
  assert.ok(arms, '开局面板里应有「时代军备」这一项');
  arms.checked = true;
  arms.dispatchEvent(new window.Event('change', { bubbles: true }));
  assert.deepEqual(
    erasNow(),
    ['青铜', '铁器', '火器', '蒸汽', '机械化'],
    '时代军备带来的是兵，不是时代——第六格不该因为勾了它出现',
  );

  const base = doc.querySelector<HTMLInputElement>('[data-exp="pack-contemporary"]');
  assert.ok(base, '开局面板里应有「信息化」这一项');
  base.checked = true;
  base.dispatchEvent(new window.Event('change', { bubbles: true }));
  assert.deepEqual(
    erasNow(),
    ['青铜', '铁器', '火器', '蒸汽', '机械化', '信息化'],
    '「信息化」才是第六时代的开关',
  );

  // 把开关关掉：第六格收回去，军备包还在（它不依赖信息化）。
  // 注意要**重新查一次**节点：勾上信息化会让面板整块重绘，
  // 上面抓的 base 已经是一个摘下来的旧节点，对它的修改不会进配置。
  const baseAgain = doc.querySelector<HTMLInputElement>('[data-exp="pack-contemporary"]')!;
  baseAgain.checked = false;
  baseAgain.dispatchEvent(new window.Event('change', { bubbles: true }));
  assert.deepEqual(erasNow(), ['青铜', '铁器', '火器', '蒸汽', '机械化'], '关掉之后第六格要收回去');
  assert.ok(
    doc.querySelector<HTMLInputElement>('[data-exp="era-arms"]')?.checked,
    '信息化关掉不该连带关掉时代军备',
  );
  const armsAgain = doc.querySelector<HTMLInputElement>('[data-exp="era-arms"]');
  armsAgain!.checked = false;
  armsAgain!.dispatchEvent(new window.Event('change', { bubbles: true }));
});

check('点兵种不重绘弹层，不会把列表弹回顶部', () => {
  openPool();
  const body = doc.querySelector<HTMLElement>('.pool-body');
  assert.ok(body, '找不到兵种池滚动区');
  // 模拟"已经滚到第五时代那一屏"
  body.scrollTop = 240;

  const chip = doc.querySelector<HTMLElement>('[data-unit].active');
  assert.ok(chip, '需要一个选中的兵种');
  chip.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

  // 重建 .pool-body 会把 scrollTop 清零，这就是"弹回顶部"的根因
  assert.equal(doc.querySelector<HTMLElement>('.pool-body'), body, '点兵种不该重建滚动区');
  assert.equal(body.scrollTop, 240, '滚动位置不该被重置');
  assert.ok(!chip.classList.contains('active'), 'chip 应该就地熄灭');

  // 点回来，后面的对局还需要完整兵种池
  chip.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert.ok(chip.classList.contains('active'), '再点一下应该亮回来');
  closePool();
});

check('确实要重绘的按钮，滚动位置也会被搬回来', () => {
  const body = doc.querySelector<HTMLElement>('.modal-body');
  assert.ok(body);
  body.scrollTop = 300;
  // 棋盘大小这类按钮会整块重绘面板（因为要联动别的选项）
  const btn = doc.querySelector<HTMLElement>('[data-size]');
  assert.ok(btn);
  btn.focus();
  btn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

  const after = doc.querySelector<HTMLElement>('.modal-body');
  assert.ok(after, '面板应该还在');
  assert.equal(after.scrollTop, 300, '重绘后滚动位置应该被搬回来');
  assert.ok(
    (doc.activeElement as HTMLElement | null)?.hasAttribute('data-size'),
    '焦点也该还回同一类按钮上，否则键盘操作会断',
  );
});

// 把兵种全部勾回来，后面的对局才有完整兵种可造
openPool();
click('[data-act="unit-pool-all"]');
closePool();

click('[data-size="20"]');
click('[data-act="start"]');
await new Promise((resolve) => setTimeout(resolve, 40));

check('新对局按选中的尺寸和扩展生成', () => {
  assert.equal(doc.querySelector('.modal-mask'), null, '面板应该关闭');
  assert.equal(doc.querySelectorAll('.tile').length, 400, '应该变成 20×20');
  const html = doc.querySelector('.side')?.innerHTML ?? '';
  assert.ok(html.includes('老兵'), '侧栏应该显示已启用的扩展');
});

await checkAsync('固定地图：开局界面有画廊，选中/取消都能实时生效', async () => {
  openSetup();
  await new Promise((resolve) => setTimeout(resolve, 60));

  // 选图在「地图」页：和战役设置分开，一条长卷里不再既讲规则又挑地图
  const mapsTab = doc.querySelector<HTMLElement>('[data-tab="maps"]');
  assert.ok(mapsTab, '开始界面左侧要有「地图」这一页');
  mapsTab!.click();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.ok(
    doc.querySelector<HTMLElement>('[data-tab="maps"]')!.classList.contains('active'),
    '点过之后「地图」要是选中态',
  );

  const cards = [...doc.querySelectorAll<HTMLElement>('[data-map]')];
  assert.ok(cards.length >= 5, `内置四张 + 随机，实际 ${cards.length}`);
  // 默认必须停在"随机地形"：默认值等于"不选"，否则每局都被一张别人的图顶掉
  const randomCard = doc.querySelector<HTMLElement>('[data-map=""]');
  assert.ok(randomCard, '应该有"随机地形"这一张');
  assert.ok(randomCard!.classList.contains('active'), '默认选中随机地形');

  const builtin = cards.find((c) => (c.dataset.map ?? '').startsWith('builtin:'))!;
  const id = builtin.dataset.map!;
  assert.ok(builtin.querySelector('svg.map-thumb'), '固定地图要有缩略图（地形同源）');
  builtin.click();
  await new Promise((resolve) => setTimeout(resolve, 30));

  const picked = doc.querySelector<HTMLElement>(`[data-map="${id}"]`)!;
  assert.ok(picked.classList.contains('active'), '点了之后要变成选中态');
  assert.ok(!doc.querySelector<HTMLElement>('[data-map=""]')!.classList.contains('active'), '随机那张要取消选中');

  // 点回"随机"＝取消固定地图：必须能退回去
  doc.querySelector<HTMLElement>('[data-map=""]')!.click();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.ok(doc.querySelector<HTMLElement>('[data-map=""]')!.classList.contains('active'), '能退回到随机');

  // 真正开一局：地图必须是那张图（不是随机生成的）
  const target = doc.querySelector<HTMLElement>(`[data-map="${id}"]`)!;
  target.click();
  await new Promise((resolve) => setTimeout(resolve, 30));
  const before = doc.querySelectorAll('.tile').length;
  click('[data-act="start"]');
  await new Promise((resolve) => setTimeout(resolve, 80));
  const after = doc.querySelectorAll('.tile').length;
  assert.equal(after, 256, `内置图是 16×16，应该铺出 256 格（之前 ${before}）`);
  // 双河渡口第一行是 ..ff..hhhh..ff..，看棋盘前几格是不是森林
  const firstForest = doc.querySelector<HTMLElement>('.tile[data-x="2"][data-y="0"]');
  assert.ok(firstForest, '应该有 (2,0) 这一格');
  assert.ok(
    firstForest!.className.includes('t-forest') || firstForest!.dataset.terrain === 'forest',
    '固定地图的地形要逐格照搬',
  );
});

await checkAsync('地图页：选图和传图在同一页，没解析前只有"选文件"', async () => {
  openSetup();
  await new Promise((resolve) => setTimeout(resolve, 60));
  doc.querySelector<HTMLElement>('[data-tab="maps"]')!.click();
  await new Promise((resolve) => setTimeout(resolve, 30));

  const body = doc.querySelector('.modal-body')!;
  assert.ok(body.textContent!.includes('上传地图'), '地图页要有「上传地图」这一块');
  assert.ok(body.querySelector('[data-act="map-file"]'), '要有「选择地图文件…」');
  assert.ok(body.querySelector('input[data-field="map-file"]'), '要有一个隐藏的文件选择框');
  assert.ok(
    body.querySelector('a[href*="example-map"]'),
    '要给一个能下载的模板，否则没人知道该画成什么样',
  );
  assert.ok(!body.querySelector('[data-act="map-upload"]'), '还没解析出地图，不该有「上传到地图库」');

  // 上传入口只有这一处：上帝模式侧栏里那个已经撤掉，免得同一件事两个门
  const st = createMatch({ ...DEFAULT_CONFIG, godMode: true }, 7, {});
  const shelf = godShelfHtml({
    state: st,
    side: 'A',
    brush: { kind: 'none' },
    pack: '',
    era: 0,
    cityEra: 1,
    selection: null,
    running: false,
    round: 1,
    result: '',
    speed: 0,
    speedNames: ['慢'],
    log: [],
    play: null,
    myTurn: true,
    passing: false,
    detail: '',
    query: '',
    quick: false,
  } as never);
  assert.ok(!shelf.includes('地图工坊'), '上帝模式侧栏里不该再有地图工坊');

  doc.querySelector<HTMLElement>('.modal-mask [data-act="cancel"]')?.click();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(doc.querySelector('.modal-mask'), null, '取消之后面板应该收起');
});

await checkAsync('32×32 大地图也能开局，并带出缩放条', async () => {
  openSetup();
  await new Promise((resolve) => setTimeout(resolve, 30));
  click('[data-size="32"]');
  click('[data-act="start"]');
  await new Promise((resolve) => setTimeout(resolve, 60));

  assert.equal(doc.querySelectorAll('.tile').length, 1024, '应该变成 32×32');
  assert.ok(doc.querySelector('[data-act="zoom-in"]'), '大地图要有放大按钮');

  // 后面的用例按 20×20 的布局写的，这里换回来
  openSetup();
  await new Promise((resolve) => setTimeout(resolve, 30));
  click('[data-size="20"]');
  click('[data-act="start"]');
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(doc.querySelectorAll('.tile').length, 400, '应该回到 20×20');
});

console.log('\n三/四人对局');

await checkAsync('开始界面选三人：对手区换成说明，开局后顶栏三条席位、每家一座城', async () => {
  openSetup();
  await new Promise((resolve) => setTimeout(resolve, 60));

  const players = [...doc.querySelectorAll<HTMLElement>('[data-players]')];
  assert.ok(players.length === 3, `人数要有 2/3/4 三个选择，实际 ${players.length}`);
  const three = doc.querySelector<HTMLElement>('[data-players="3"]');
  assert.ok(three, '要有「三人」这一档');
  three!.click();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.ok(
    doc.querySelector<HTMLElement>('[data-players="3"]')!.classList.contains('active'),
    '点过之后「三人」要是选中态',
  );
  // 多方局里 AI 的两个开关不成立，那一块要换成一句说明，而不是留一串点了没反应的按钮
  const body = doc.querySelector('.modal-body')!;
  assert.equal(body.querySelectorAll('[data-ai]').length, 0, '三人局不该还摆着「人机对战」这类开关');
  assert.equal(body.querySelectorAll('[data-role="god"]').length, 0, '三人局不摆上帝模式（沙盒是按两边写的）');
  // 人数换了，说明也得跟着换：不许还写着两人局那套
  assert.ok(
    (body.textContent ?? '').includes('每家一座城'),
    '选三人之后要写清"每家一座城"这条规则',
  );

  /*
   * 先手：多人局不给"手选某方"（席位顺序牵着城位），只给「按席位顺序 / 随机」。
   * 两家局那三档（红方/蓝方/随机）在这里不该出现。
   */
  const firstChips = [...body.querySelectorAll<HTMLElement>('[data-first]')];
  assert.deepEqual(
    firstChips.map((el) => (el.textContent ?? '').trim()),
    ['按席位顺序', '随机'],
    '三人局先手只该有「按席位顺序 / 随机」两档',
  );
  click('[data-first="random"]');
  assert.ok(
    doc.querySelector<HTMLElement>('[data-first="random"]')!.classList.contains('active'),
    '点随机要能选中',
  );
  assert.ok(
    (doc.querySelector('.modal-body')!.textContent ?? '').includes('抽到谁谁先动'),
    '选了随机要说明"在参赛席位上抽"',
  );
  // 切回按席位，别影响后面这局的断言
  click('[data-first="A"]');

  click('[data-act="start"]');
  await new Promise((resolve) => setTimeout(resolve, 80));

  assert.equal(doc.querySelector('.seat-row')?.parentElement?.children.length, 3, '顶栏应该有三条席位');
  const seatRows = [...doc.querySelectorAll<HTMLElement>('.seat-row')];
  assert.deepEqual(
    seatRows.map((r) => (r.textContent ?? '').trim().slice(0, 2)),
    ['红方', '蓝方', '绿方'],
    `席位条按红/蓝/绿排，实际 ${seatRows.map((r) => r.textContent).join('|')}`,
  );
  // 每家只有一座城（这是这个模式的定义）
  assert.equal(doc.querySelectorAll('.tile.t-city.own-A').length, 4, 'A 的城是 2×2，一处城块');
  assert.equal(doc.querySelectorAll('.tile.t-city.own-C').length, 4, '绿方也要有一座自己的城');
  assert.equal(doc.querySelectorAll('.tile.t-city.own-D').length, 0, '三人局没有黄方');

  // 换回两人局 20×20，后面的用例都按那个布局写的
  openSetup();
  await new Promise((resolve) => setTimeout(resolve, 60));
  const two = doc.querySelector<HTMLElement>('[data-players="2"]');
  assert.ok(two, '人数里要能选回两人');
  two!.click();
  await new Promise((resolve) => setTimeout(resolve, 30));
  click('[data-size="20"]');
  click('[data-act="start"]');
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(doc.querySelectorAll('.tile').length, 400, '应该回到 20×20');
  assert.equal(doc.querySelectorAll('.seat-row').length, 2, '两人局回到两条席位');
});

console.log('\n升级时代');

check('二级时代造价远高于开局金币（防先手滚雪球）', () => {
  click('.tile[data-x="0"][data-y="0"]');
  click('.tile.t-city.own-A');
  const btn = doc.querySelector<HTMLButtonElement>('[data-act="upgrade"]');
  assert.ok(btn, '面板里应该有升级入口');
  const price = Number(btn.querySelector('.price')?.textContent ?? 0);
  assert.ok(price >= 200, `二级时代造价应该显著高于开局金币，实际 ${price}`);
});

// 时代升级很贵，前面几段测试又花掉了不少钱：一轮轮空转，攒到买得起为止。
for (let i = 0; i < 8; i++) {
  click('.tile.t-city.own-A');
  const btn = doc.querySelector<HTMLButtonElement>('[data-act="upgrade"]');
  if (btn && !btn.disabled) break;
  click('[data-act="end-turn"]');
  click('[data-act="handoff-start"]');
}

check('攒够钱之后，可以升级城市时代', () => {
  click('.tile.t-city.own-A');

  // 注意：城市时代标记在地图的城块上，一张图上有四个城块，
  // 所以必须认准"当前选中的那一座"——querySelector('.city-era') 拿到的是
  // DOM 里的第一个城块，布局一变就可能是另一座城（城市的摆放不再是固定的了）。
  const eraOf = (): string | undefined =>
    doc.querySelector('.city-block.selected .city-era')?.textContent ?? undefined;

  assert.ok(doc.querySelector('.city-block.selected'), '点了城市格之后地图上应该高亮这座城');
  const before = eraOf();
  assert.equal(before, 'I', '开局应该是时代 I');

  click('[data-act="upgrade"]');

  const after = eraOf();
  assert.notEqual(after, before, '时代标记应该变了');
  assert.equal(after, 'II', '应该升到时代 II');
  const html = doc.querySelector('.side')?.innerHTML ?? '';
  assert.ok(html.includes('铁器'), '面板应该显示已升到铁器时代');
});

check('升级后城市更硬，产兵列表也多出二级兵', () => {
  const html = doc.querySelector('.side')?.innerHTML ?? '';
  // 时代 2 城市护甲应该是 6
  assert.ok(html.includes('护甲</span><b>6</b>'), '护甲应该提升到 6');
  assert.ok(doc.querySelectorAll('.recruit-btn').length >= 8, '时代 II 应该能看到两个时代的兵种');
  // 2026-11-11：解锁名单收进折叠块，判据从"整段 HTML 里有没有某个词"改成"名单里有没有"
  const unlockList = doc.querySelector('.unlock-list')?.textContent ?? '';
  assert.ok(!unlockList.includes('长枪兵'), '长枪兵应该已经从锁定名单里消失');
});

check('打过一局之后回首页，「继续上一局」就亮了', () => {
  // 上面已经开过好几局，所以这里应该能接着打——与"第一次来"那条正好成对
  goHome();
  const home = doc.querySelector('.title-screen');
  assert.ok(home, '先回首页');
  const cont = home!.querySelector<HTMLButtonElement>('[data-title="continue"]');
  assert.equal(cont!.disabled, false, '打过一局之后应该能接着打');

  // 点「继续」= 原地撤层回到棋盘，不该弹面板、也不该换局
  const tiles = doc.querySelectorAll('.tile').length;
  cont!.click();
  assert.equal(doc.querySelector('.title-screen'), null, '继续之后首页应该收起');
  assert.equal(doc.querySelector('.modal-mask'), null, '继续不该弹开局面板');
  assert.equal(doc.querySelectorAll('.tile').length, tiles, '继续应该回到原来那一局，而不是新开一张图');
});

console.log('\n兵种编辑器');

check('兵种编辑器在首页，顶栏不再有这颗按钮', () => {
  assert.equal(doc.querySelector('[data-act="unit-editor"]'), null, '顶栏不该还留着兵种编辑器');
  assert.equal(doc.querySelector('[data-act="import"]'), null, '顶栏也不该留着导入对局');

  goHome();
  assert.ok(doc.querySelector('.title-screen'), '先回首页');
  assert.ok(doc.querySelector('[data-title="editor"]'), '首页应该有兵种编辑器入口');
  assert.ok(doc.querySelector('[data-title="import"]'), '首页应该有导入对局入口');

  click('[data-title="editor"]');
  assert.ok(doc.querySelector('.modal-mask'), '应该打开编辑器');
  assert.ok(doc.querySelectorAll('.editor-row').length >= 10, '应该列出内置兵种');
  assert.ok(doc.querySelector('.title-screen'), '编辑器是模态框，首页该在它下面等着');
});

check('复制内置兵种会进入编辑表单', () => {
  const copy = doc.querySelector<HTMLElement>('[data-act="copy"]');
  assert.ok(copy, '应该有可复制的兵种');
  copy.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert.ok(doc.querySelector('.editor-grid'), '应该出现表单');
  assert.ok(doc.querySelector('[data-field="name"]'), '应该有名称输入框');
  assert.ok(doc.querySelector('[data-field="atk"]'), '应该有攻击输入框');
  assert.ok(doc.querySelectorAll('[data-ability]').length >= 8, '应该能勾选特殊能力');
});

check('改完保存会出现在自定义列表', () => {
  const input = doc.querySelector<HTMLInputElement>('[data-field="name"]');
  assert.ok(input);
  input.value = '测试兵';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  click('[data-act="save"]');
  const html = doc.querySelector('.modal')?.innerHTML ?? '';
  assert.ok(html.includes('测试兵'), '自定义列表应该出现新兵种');
});

check('关掉编辑器会回到首页（首页还站在原地）', () => {
  click('[data-act="close"]');
  assert.equal(doc.querySelector('.modal-mask'), null);
  assert.ok(doc.querySelector('.title-screen'), '编辑器是从首页开的，关掉之后首页还在');

  // 把首页撤掉，让后面的用例回到"在对局里"的状态。用 Esc（首页自带的出口），
  // 不点「继续」——后者会顺手把 AI 点起来，后面的托管用例就不再从人类回合开始。
  window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }));
  assert.equal(doc.querySelector('.title-screen'), null, 'Esc 应该能撤掉首页');
});

console.log('\nAI 托管');

check('顶栏有把当前方交给 AI 的按钮', () => {
  const btn = doc.querySelector('[data-act="toggle-ai"]');
  assert.ok(btn, '应该有 AI 托管按钮');
  assert.ok((btn.textContent ?? '').includes('交给 AI'), '默认应该是"交给 AI"');
});

check('点一下就交给 AI，按钮变成收回操作权', () => {
  click('[data-act="toggle-ai"]');
  const btn = doc.querySelector('[data-act="toggle-ai"]');
  assert.ok((btn?.textContent ?? '').includes('收回'), '按钮文案应该变成收回操作权');
  const chip = doc.querySelector('.turn-chip')?.textContent ?? '';
  assert.ok(chip.includes('AI'), `回合状态应该标出 AI：${chip.trim()}`);
  const pause = doc.querySelector<HTMLElement>('[data-act="ai-pause"]');
  assert.ok(pause && !pause.hidden, '托管之后暂停按钮应该露出来');

  // 立刻收回：不然后台循环会继续改状态，影响后面的断言
  click('[data-act="toggle-ai"]');
  assert.ok(
    (doc.querySelector('[data-act="toggle-ai"]')?.textContent ?? '').includes('交给 AI'),
    '收回之后应该能自己操作',
  );
});

check('AI 连续行动时顶栏按钮不会被重建', () => {
  // 这条是回归测试：顶栏如果每步 innerHTML 重写，
  // mousedown 和 mouseup 之间按钮就换了节点，click 永远不触发——
  // 表现就是"AI 一跑，什么按钮都点不动"。
  const before = doc.querySelector('[data-act="toggle-ai"]');
  assert.ok(before, '应该有托管按钮');

  click('[data-act="toggle-ai"]'); // 交给 AI，它会同步跑到第一次 await

  const after = doc.querySelector('[data-act="toggle-ai"]');
  assert.equal(after, before, '顶栏按钮必须还是同一个节点');

  click('[data-act="toggle-ai"]'); // 收回
});

console.log('\n军营面板');

check('军营面板列出兵种，并写清自己是哪一档', () => {
  const st = createMatch(
    {
      size: 12,
      startEra: 1,
      aiOpponent: false,
      aiAlly: false,
      expansionIds: [],
      enabledUnits: Object.keys(UNIT_TYPES),
    },
    4242,
  );
  st.current = 'A';
  st.players.A.gold = 200;
  const city = st.cities.find((c) => c.owner === 'A');
  assert.ok(city, '应该有 A 方城市');
  city.era = 2;

  // 在城墙边找一块空地扎营
  let spot: { x: number; y: number } | null = null;
  for (let dy = -2; dy <= 3 && !spot; dy++) {
    for (let dx = -2; dx <= 3 && !spot; dx++) {
      const x = city.x + dx;
      const y = city.y + dy;
      if (x < 0 || y < 0 || x >= st.w || y >= st.h) continue;
      const t = st.tiles[y * st.w + x];
      if (!t || (t.terrain !== 'plain' && t.terrain !== 'hill') || t.cityId) continue;
      if (st.units.some((u) => u.x === x && u.y === y)) continue;
      spot = { x, y };
    }
  }
  assert.ok(spot, '城边应该有能扎营的空地');

  const camp: Unit = {
    id: 'camp1',
    type: 'camp',
    owner: 'A',
    x: spot.x,
    y: spot.y,
    hp: st.unitTypes.camp?.maxHp ?? 30,
    kills: 0,
    moved: false,
    acted: false,
  };
  st.units.push(camp);

  const host = doc.createElement('div');
  renderPanel(host, {
    view: playerView(st, 'A'),
    me: 'A',
    selectedUnit: camp,
    selectedCityId: null,
    selectedCampId: camp.id,
    selectedTile: null,
  });

  const html = host.innerHTML;
  assert.ok(html.includes('前线产兵点'), '面板应该标明这是产兵点');
  // 2026-11-08：营按自己的档位出兵，不再"补给来自某座城"。
  // 这里是城升到了二级、营还是一级，所以面板必须写一级，而不是跟着城写铁器。
  assert.ok(html.includes('时代'), '应该写清这座营自己的时代');
  assert.ok(html.includes('青铜'), '一级营就是青铜时代——不随后方城市变化');
  assert.ok(!html.includes('铁器'), '不能把后方城市的时代写成营的时代');
  assert.ok(html.includes('反应射击'), '军营会替自己开火（敌人踏进射程就打）');
  assert.ok(host.querySelectorAll('.recruit-btn').length >= 5, '军营应该和城市一样列兵种');
  // 一级营出不了二级兵：既不列在可造里，也不该灰着挂在"还造不出来"
  assert.equal(host.querySelector('[data-type="spearman"]'), null, '一级营根本不该列二级兵');
});

check('敌军军营不给你产兵，并提示打掉它', () => {
  const st = createMatch(
    {
      size: 12,
      startEra: 1,
      aiOpponent: false,
      aiAlly: false,
      expansionIds: [],
      enabledUnits: Object.keys(UNIT_TYPES),
    },
    777,
  );
  st.current = 'A';
  // 放在"A 自己城边"——敌方军营得在视野里才看得到，
  // 随便丢到对面半场的话 playerView 直接把它滤掉了（面板当然是空的）。
  const city = st.cities.find((c) => c.owner === 'A');
  assert.ok(city);
  const camp: Unit = {
    id: 'camp2',
    type: 'camp',
    owner: 'B',
    x: city.x + 2,
    y: city.y,
    hp: 30,
    kills: 0,
    moved: false,
    acted: false,
  };
  st.units.push(camp);

  const host = doc.createElement('div');
  renderPanel(host, {
    view: playerView(st, 'A'),
    me: 'A',
    selectedUnit: camp,
    selectedCityId: null,
    selectedCampId: camp.id,
    selectedTile: null,
  });

  assert.equal(host.querySelectorAll('.recruit-btn').length, 0, '敌方军营不该给产兵按钮');
  assert.ok(host.innerHTML.includes('产兵建筑'), '应该提示这是敌方的产兵点');
});

console.log('\n渡船面板');

check('渡船面板有货舱、装载和卸载', () => {
  const st = createMatch(
    {
      size: 12,
      startEra: 1,
      aiOpponent: false,
      aiAlly: false,
      expansionIds: [],
      enabledUnits: Object.keys(UNIT_TYPES),
    },
    909,
  );
  st.current = 'A';
  st.players.A.gold = 300;
  // 挖一格水给船，旁边留陆地
  let water: { x: number; y: number } | null = null;
  for (let y = 5; y < 8 && !water; y++) {
    for (let x = 5; x < 8 && !water; x++) {
      const t = st.tiles[y * st.w + x];
      if (t && !t.cityId && t.terrain !== 'mountain') water = { x, y };
    }
  }
  assert.ok(water);
  st.tiles[water.y * st.w + water.x] = { terrain: 'water', cityId: null };
  st.units = st.units.filter((u) => !(u.x === water!.x && u.y === water!.y));

  const ferry: Unit = {
    id: 'ferry-1',
    type: 'ferry',
    owner: 'A',
    x: water.x,
    y: water.y,
    hp: st.unitTypes.ferry?.maxHp ?? 26,
    kills: 0,
    moved: false,
    acted: false,
  };
  const crew: Unit = {
    id: 'crew-1',
    type: 'militia',
    owner: 'A',
    x: water.x + 1,
    y: water.y,
    hp: 28,
    kills: 0,
    moved: false,
    acted: false,
  };
  st.units = st.units.filter((u) => !(u.x === crew.x && u.y === crew.y));
  st.units.push(ferry, crew);
  ferry.cargo = [{ ...crew, moved: true, acted: true }];
  st.units = st.units.filter((u) => u.id !== 'crew-1');

  const host = doc.createElement('div');
  renderPanel(host, {
    view: playerView(st, 'A'),
    me: 'A',
    selectedUnit: ferry,
    selectedCityId: null,
    selectedCampId: null,
    selectedTile: null,
  });

  const html = host.innerHTML;
  assert.ok(html.includes('货舱 1 / 2'), '应该显示载员数与容量');
  assert.ok(html.includes('民兵'), '应该列出舱里的单位');
  assert.ok(host.querySelector('[data-act="load"]'), '应该有装载按钮');
  assert.ok(host.querySelector('[data-act="unload"]'), '有货时应该能卸载');
});

console.log('\n双 AI 观战');

openSetup();
click('[data-ai="2"]');
// 顺手把这一局走成初级档：验证难度真的从面板传进了对局状态，
// 而不只是面板上高亮了一个按钮
click('[data-ailevel="basic"]');
click('[data-act="start"]');
await new Promise((resolve) => setTimeout(resolve, 60));

check('开局两边都交给 AI', () => {
  assert.equal(doc.querySelector('.modal-mask'), null, '面板应该关闭');
  const chip = doc.querySelector('.turn-chip')?.textContent ?? '';
  assert.ok(chip.includes('AI'), `回合状态：${chip.trim()}`);
  // 顶栏直接写出档位：至少不会出现"我以为在打初级，其实被高级虐"
  assert.ok(chip.includes('初级 AI'), `顶栏应该标出初级 AI：${chip.trim()}`);
});

check('观战给的是全图视角，没有迷雾暗格', () => {
  assert.equal(doc.querySelectorAll('.tile.out').length, 0, '观战不该有暗格');
});

check('观战有暂停和速度控制', () => {
  const pause = doc.querySelector<HTMLElement>('[data-act="ai-pause"]');
  const speed = doc.querySelector<HTMLElement>('[data-act="ai-speed"]');
  assert.ok(pause && !pause.hidden, '暂停按钮应该露出来');
  assert.ok(speed && !speed.hidden, '速度按钮应该露出来');
});

check('可以暂停观战', () => {
  click('[data-act="ai-pause"]');
  const btn = doc.querySelector('[data-act="ai-pause"]');
  assert.ok((btn?.textContent ?? '').includes('继续'), '暂停后应该显示继续');
});

check('可以继续观战', () => {
  click('[data-act="ai-pause"]');
  const btn = doc.querySelector('[data-act="ai-pause"]');
  assert.ok((btn?.textContent ?? '').includes('暂停'), '继续之后应该显示暂停');
});

// 收尾：停在暂停状态，否则 AI 循环的定时器会让测试进程一直挂着
click('[data-act="ai-pause"]');

console.log('\n联机面板');

check('顶栏能打开联机面板', () => {
  click('[data-act="online"]');
  assert.ok(doc.querySelector('.modal-mask'), '应该弹出联机面板');
  assert.ok(doc.querySelector('[data-act="create"]'), '应该有创建房间按钮');
  assert.ok(doc.querySelector('[data-field="code"]'), '应该有房间码输入框');
});

check('面板一打开就在查云端连通性', () => {
  const chip = doc.querySelector('.cloud-probe');
  assert.ok(chip, '面板顶部应该有一条云端自检');
  assert.ok((chip.textContent ?? '').trim().length > 0, '自检那一条不该是空的');
});

await checkAsync('自检结论要么"通"，要么说清楚断在哪（不能只甩一句网络不通）', async () => {
  await new Promise((resolve) => setTimeout(resolve, 120));
  const chip = doc.querySelector('.cloud-probe');
  assert.ok(chip, '自检那一条不该消失');
  const text = (chip.textContent ?? '').trim();
  if (chip.classList.contains('ok')) {
    assert.ok(text.includes('正常'), `通过时应该说清楚：${text}`);
    return;
  }
  assert.ok(chip.classList.contains('bad'), `自检应当落到"通"或"不通"两态之一：${text}`);
  // 关键：失败要落到"具体原因"，而不是那句把人往网络问题上带的兜底文案
  assert.ok(
    /云端|连不上|域名|密钥|房间表/.test(text),
    `失败原因要具体（云端/域名/密钥/房间表），实际是：${text}`,
  );
});

check('面板写清了房间码就是钥匙', () => {
  const text = doc.querySelector('.modal')?.textContent ?? '';
  assert.ok(text.includes('房间码就是钥匙'), '应该有这句说明');
});

check('关掉联机面板回到对局', () => {
  click('[data-act="close"]');
  assert.equal(doc.querySelector('.modal-mask'), null);
});

check('本机对局没有聊天入口：聊天只开在房间里', () => {
  // 热座是对着人、AI 局是对着电脑，这两种局里放一个永远没回应的输入框
  // 比没有更让人困惑。所以没有房间时那颗按钮是隐藏的（元素在、但不出现）。
  const fab = doc.querySelector<HTMLElement>('.chat-fab');
  if (fab) {
    assert.equal(fab.hidden, true, '不在房间里时聊天入口应该收起来');
    return;
  }
  assert.ok(!doc.querySelector('.chat-panel'), '没有房间就不该有聊天面板');
});

check('聊天面板能按住标题栏拖动，拖不出视口，点 × 不算拖', () => {
  // 面板平时是 hidden 的（不在房间里），jsdom 又没有布局，矩形一律是 0——
  // 所以这里塞一个假矩形进去，验的是"位移怎么算、边界怎么夹"这套逻辑，
  // 不是像素好不好看。
  const panel = doc.querySelector<HTMLElement>('.chat-panel');
  const head = panel?.querySelector<HTMLElement>('.chat-head');
  assert.ok(panel && head, '聊天面板应该已经建好（只是隐藏）');
  panel.hidden = false;
  const box = { left: 600, top: 300, width: 280, height: 200, right: 880, bottom: 500, x: 600, y: 300 };
  // 真浏览器里 transform 会把矩形一起挪走，这里照着做——不然第二次拖动
  // 拿到的是"没挪过的位置"，测出来的位移会多出一截
  panel.getBoundingClientRect = () => {
    const m = /translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)/.exec(panel.style.transform);
    const dx = m ? Number(m[1]) : 0;
    const dy = m ? Number(m[2]) : 0;
    return {
      ...box,
      left: box.left + dx,
      top: box.top + dy,
      right: box.right + dx,
      bottom: box.bottom + dy,
      x: box.x + dx,
      y: box.y + dy,
      toJSON: () => box,
    } as DOMRect;
  };

  const at = (el: Element, type: string, x: number, y: number): void => {
    el.dispatchEvent(new window.MouseEvent(type, { bubbles: true, clientX: x, clientY: y }));
  };

  // 按住标题栏往左上拖 40 / 30
  at(head, 'pointerdown', 620, 320);
  at(head, 'pointermove', 660, 290);
  at(head, 'pointerup', 660, 290);
  assert.equal(panel.style.transform, 'translate(40px, -30px)', '位移应该正好等于手指走的量');
  assert.ok(!panel.classList.contains('dragging'), '松手之后要摘掉 dragging');

  // 一直往右拖：右边的极限是 innerWidth − 宽 − 8（1024 − 280 − 8 = 736）
  at(head, 'pointerdown', 660, 290);
  at(head, 'pointermove', 2000, 290);
  at(head, 'pointerup', 2000, 290);
  assert.equal(panel.style.transform, 'translate(136px, -30px)', '拖出右边要被夹住');

  // 点在 × 上不是拖：那一下既不移动面板，也不该吞掉关闭
  at(head.querySelector('.chat-x')!, 'pointerdown', 860, 310);
  at(head.querySelector('.chat-x')!, 'pointermove', 900, 340);
  assert.equal(panel.style.transform, 'translate(136px, -30px)', '点 × 不该把面板拖走');

  panel.hidden = true;
  panel.style.transform = '';
});

check('输入法组字中按 Enter 只选词，不发送（否则对方只收到半句）', () => {
  // 中文一句话要打几个字才组成词，按 Enter 是选词。那一刻输入框里只有
  // 已经上屏的部分，剩下的还在输入法里——这时候按"发送"发出去的就是半句，
  // 而发的人以为自己发的是整句。
  const form = doc.createElement('form');
  const input = doc.createElement('input');
  form.append(input);
  doc.body.append(form);

  let sent = 0;
  bindChatComposer(input, () => {
    sent += 1;
  });
  const pressEnter = () =>
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));

  input.dispatchEvent(new window.Event('compositionstart'));
  pressEnter();
  assert.equal(sent, 0, '组字中不该发送');

  input.dispatchEvent(new window.Event('compositionend'));
  pressEnter();
  assert.equal(sent, 1, '上屏之后再按 Enter 才发');

  // 兜底：某个环境不发 compositionend，下一次"不在组字中的按键"要能把状态解开，
  // 否则这个人从此再也发不出消息
  input.dispatchEvent(new window.Event('compositionstart'));
  input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'a', isComposing: false }));
  pressEnter();
  assert.equal(sent, 2, '卡住的组字状态要能被下一次普通按键解开');

  // 反过来：组字中的按键（isComposing = true）不该把状态解开
  input.dispatchEvent(new window.Event('compositionstart'));
  input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', isComposing: true }));
  pressEnter();
  assert.equal(sent, 2, '组字中的按键不能算"已经上屏"');

  form.remove();
});


console.log('\n指挥官模式');

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

check('普通对局不显示指挥官栏', () => {
  const bar = doc.querySelector<HTMLElement>('#commander');
  assert.ok(bar, '页面骨架里应该有指挥官栏容器');
  assert.equal(bar.hidden, true, '非指挥官模式不该出现');
});

openSetup();
await wait(40);

check('开局面板能选角色', () => {
  assert.ok(doc.querySelector('[data-role="commander"]'), '应该有指挥官模式选项');
  assert.ok(doc.querySelector('[data-role="full"]'), '应该有亲自指挥选项');
});

check('开局面板有"数据收集"开关，默认开', () => {
  /*
   * 2026-11-11 用户拍板：默认从"关"改成"开"。
   *
   * 原来那条断言写的是「默认必须是关的：不勾就不记，也不多交东西」。
   * 立场没错，代价是数据——65 局里只有 19 局带动作序列，剩下的事后想复盘
   * 连素材都没有。改开之后的边界：**记录**默认开（只发生在本机），
   * **发送**仍然要玩家在结算卡上点一下，取消勾选也会被记住。
   */
  const box = doc.querySelector<HTMLInputElement>('[data-field="record"]');
  assert.ok(box, '应该有"记录详细数据"的勾选框');
  assert.equal(box.checked, true, '默认勾上：否则半数对局事后想复盘都没有素材');

  // 取消勾选只翻转卡片样式，不该重绘整个面板（否则 checkbox 会闪、焦点会丢）
  box.checked = false;
  box.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  assert.ok(
    !box.closest('.expansion-item')?.classList.contains('on'),
    '取消之后卡片不该还亮着',
  );
  box.checked = true;
  box.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  assert.ok(box.closest('.expansion-item')?.classList.contains('on'), '勾上之后卡片要跟着高亮');
});

await checkAsync('数据收集排在最前面，而且会记住上次的选择', async () => {
  // 排位：它必须是 .modal-body 里的第一块，在所有对局选项之前
  const first = doc.querySelector('.modal-body > section');
  assert.ok(
    first?.querySelector('[data-field="record"]'),
    '数据收集应当是面板里的第一块，实际第一块是：' + (first?.textContent ?? '').trim().slice(0, 20),
  );

  // 勾上 → 取消 → 重新打开，应当还是勾着的
  const box = doc.querySelector<HTMLInputElement>('[data-field="record"]');
  assert.ok(box);
  box.checked = true;
  box.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  click('[data-act="cancel"]');
  await wait(20);

  openSetup();
  await wait(40);
  const again = doc.querySelector<HTMLInputElement>('[data-field="record"]');
  assert.equal(again?.checked, true, '上次勾了，这次开面板就该自动沿用（只勾一次）');

  // 再取消勾选：这个"取消"也要被记住
  again!.checked = false;
  again!.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  click('[data-act="cancel"]');
  await wait(20);
  openSetup();
  await wait(40);
  const third = doc.querySelector<HTMLInputElement>('[data-field="record"]');
  assert.equal(third?.checked, false, '取消勾选也要记住，不能只记"开"');
});

click('[data-role="commander"]');
click('[data-act="start"]');
await wait(60);

check('指挥官模式开局后，顶端是一条生产队列（初始 5 个空位）', () => {
  const bar = doc.querySelector<HTMLElement>('#commander');
  assert.ok(bar && !bar.hidden, '指挥官栏应该显示');
  assert.ok((bar.textContent ?? '').includes('参谋部'), '标题应该是参谋部');
  assert.equal(bar.querySelectorAll('.cmd-chip.is-empty').length, 5, '应该有 5 个空位');
  assert.ok(bar.querySelector('[data-cmd="run"]'), '应该有执行按钮');
  // 旧那套 5×2 的下拉编辑器已经拆掉：两条入口并存只会让人犹豫该用哪个。
  // 只留「进攻方向」这一个下拉——它是给 AI 下命令，不是排产。
  assert.equal(
    bar.querySelectorAll('select:not([data-cmd="dir"])').length,
    0,
    '除了进攻方向，顶端不该再有下拉框',
  );
  assert.equal(bar.querySelectorAll('[data-act="cmd-pack"]').length, 0, '顶端也不该再有包筛选');
});

check('指挥官模式下点自己的部队能看属性，遣散按钮也在', () => {
  const st = createMatch({ ...DEFAULT_CONFIG, commanderMode: true }, 20261028, {});
  st.fog = false;
  st.current = 'A';
  // 挑一个真兵（不是建筑），属性卡上才有射程护甲这些数字
  const mine = st.units.find(
    (u) => u.owner === 'A' && UNIT_TYPES[u.type]?.category !== 'building',
  );
  assert.ok(mine, 'A 方应该有兵');
  const name = UNIT_TYPES[mine.type]!.name;

  const w = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', {
    url: 'http://localhost/',
    pretendToBeVisual: true,
    runScripts: 'outside-only',
  }).window;
  if (!w.structuredClone) {
    (w as unknown as { structuredClone: typeof structuredClone }).structuredClone = structuredClone;
  }
  w.localStorage.setItem('warchess:match:v1', JSON.stringify(st));
  w.eval(code);

  const d = w.document;
  const el = d.querySelector<HTMLElement>(`.unit[data-id="${mine.id}"]`);
  assert.ok(el, '自己的兵没渲染出来');
  el.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));

  const side = d.querySelector('#side');
  assert.ok(side, '应该有侧栏');
  const text = side!.textContent ?? '';
  // 这一条守的是 onBoardClick 里那句"指挥官模式直接 return"：
  // 参谋部的下拉框写着兵种名，玩家却点不出它的射程和护甲。
  assert.ok(text.includes(name), `点自己的部队应该弹属性卡，实际面板：${text.slice(0, 60)}`);
  assert.ok(text.includes('可遣散'), '应该标明走位归 AI、但可以遣散');

  // 遣散是经济决定，不该被"只看"一刀切掉
  const btn = side!.querySelector<HTMLElement>('[data-act="disband"]');
  assert.ok(btn, '指挥官模式下应该有遣散按钮');

  // 点下去要真拆掉：确认框直接放行
  (w as unknown as { confirm: () => boolean }).confirm = () => true;
  btn!.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  const after = JSON.parse(w.localStorage.getItem('warchess:match:v1') ?? '{}') as {
    units: { id: string }[];
  };
  assert.equal(
    after.units.some((u) => u.id === mine.id),
    false,
    '点了拆除，兵应该从盘上消失',
  );
});

/**
 * 点城市＝点城市脚下那一格 tile。
 *
 * 城牌（`.city-block`）在 CSS 里是 pointer-events:none，真实浏览器里手点下去
 * 命中的是城底下的 tile，所以合成事件也必须打在 tile 上，否则 coordsFromEvent
 * 找不到 [data-x] 祖先，点击会被当成"点空白"。
 */
function clickOwnCity(side: string): void {
  const saved = JSON.parse(window.localStorage.getItem('warchess:match:v1') ?? '{}') as {
    cities?: { id: string; owner: string; x: number; y: number; size: number }[];
    units?: { x: number; y: number }[];
  };
  const city = (saved.cities ?? []).find((c) => c.owner === side);
  assert.ok(city, `${side} 方应该有城`);
  const taken = new Set((saved.units ?? []).map((u) => `${u.x},${u.y}`));
  // 城是 2×2：挑一格没站着兵的，免得点下去先命中那支兵
  const spot = [city!.x, city!.y];
  outer: for (let dy = 0; dy < (city!.size ?? 2); dy++) {
    for (let dx = 0; dx < (city!.size ?? 2); dx++) {
      if (!taken.has(`${city!.x + dx},${city!.y + dy}`)) {
        spot[0] = city!.x + dx;
        spot[1] = city!.y + dy;
        break outer;
      }
    }
  }
  const tile = doc.querySelector<HTMLElement>(`.tile[data-x="${spot[0]}"][data-y="${spot[1]}"]`);
  assert.ok(tile, `城脚下那格 tile 应该渲染出来（${spot[0]},${spot[1]}）`);
  tile!.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
}

check('点自己的城 → 右侧点兵种 → 排进顶端队列（和常规模式同一套操作）', () => {
  clickOwnCity('A');
  assert.ok(
    doc.querySelector('.city-block.owner-A.selected'),
    '点城脚那一格，城本身要亮起来（选中态）',
  );

  const btn = doc.querySelector<HTMLElement>('#side .recruit-list [data-act="order-add"]');
  assert.ok(btn, '指挥官模式下自己的城也该出产兵列表（按钮是"加入队列"）');
  assert.ok((btn!.textContent ?? '').includes('＋队列'), '按钮上要写清这一下是"排进队列"');
  const type = btn!.dataset.type ?? '';

  btn!.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

  const bar = doc.querySelector<HTMLElement>('#commander')!;
  const chips = bar.querySelectorAll('.cmd-chip:not(.is-empty)');
  assert.equal(chips.length, 1, '队列里应该出现一格');
  assert.ok(
    (chips[0]!.textContent ?? '').includes(UNIT_TYPES[type]?.name ?? type),
    `队列要显示兵种名，实际：${chips[0]!.textContent}`,
  );

  const saved = JSON.parse(window.localStorage.getItem('warchess:match:v1') ?? '{}') as {
    orders?: { A?: string[] };
    orderSites?: { A?: string[] };
  };
  assert.equal(saved.orders?.A?.[0], type, '队列要落到 state 里（AI 执行时读的就是它）');
  assert.ok(saved.orderSites?.A?.[0], '产兵点也要落到 state 里：就是刚点的这座城市');
});

check('队列里的 × 只删那一格，清空一次清完', () => {
  const bar = () => doc.querySelector<HTMLElement>('#commander')!;
  const filled = () => bar().querySelectorAll('.cmd-chip:not(.is-empty)').length;

  // 再排一格，凑成两格
  const btn = doc.querySelector<HTMLElement>('#side .recruit-list [data-act="order-add"]');
  assert.ok(btn, '产兵列表应该还在（城市面板没被关掉）');
  btn!.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert.equal(filled(), 2, '现在应该有两格');

  // 删第一格：按位置删，不是按兵种删
  bar().querySelector<HTMLElement>('.cmd-x')!.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert.equal(filled(), 1, '只该少一格');

  bar().querySelector<HTMLElement>('[data-cmd="clear"]')!.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert.equal(filled(), 0, '清空之后应该一格都不剩');
  const saved = JSON.parse(window.localStorage.getItem('warchess:match:v1') ?? '{}') as {
    orders?: { A?: string[] };
  };
  assert.equal((saved.orders?.A ?? []).length, 0, '清空也要落到 state 里');
});

check('「升级时代」也能排进队列；队列满了按钮就禁用', () => {
  const bar = () => doc.querySelector<HTMLElement>('#commander')!;
  const filled = () => bar().querySelectorAll('.cmd-chip:not(.is-empty)').length;

  // 升级按钮在城市面板里，指挥官模式下它也是"排进队列"
  const up = doc.querySelector<HTMLElement>('#side .upgrade-btn');
  assert.ok(up, '城面板应该有升级按钮');
  assert.equal(up!.dataset.act, 'order-add', '指挥官模式下升级也是排进队列');
  up!.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert.equal(filled(), 1);
  assert.ok(
    (bar().querySelector('.cmd-chip:not(.is-empty)')?.textContent ?? '').includes('升级时代'),
    '队列里应该写着「升级时代」',
  );
  /*
   * 这一条守的是 slotProblem 的判断顺序。
   *
   * 「升级时代」这一格存的是哨兵 `@upgrade`，它当然不在兵种表里；以前的实现
   * 先查兵种表、查不到就报「没有这个兵种」，于是每点一次升级都在估价后面
   * 挂一句红字。哨兵必须先判、再查兵种表。
   */
  const est = bar().querySelector<HTMLElement>('[data-est="0"]')?.textContent ?? '';
  assert.ok(est.includes('≈'), `这一格应该写着估价，实际是「${est}」`);
  assert.ok(!est.includes('没有这个兵种'), `升级那一格不该报"没有这个兵种"，实际是「${est}」`);

  // 排满 5 格：按钮置灰，再点也排不进去
  for (let i = 0; i < 6; i++) {
    const btn = doc.querySelector<HTMLElement>(
      '#side .recruit-list [data-act="order-add"]:not([disabled])',
    );
    if (!btn) break;
    btn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  }
  assert.equal(filled(), 5, '队列最多 5 格');
  assert.equal(
    doc.querySelectorAll('#side .recruit-list [data-act="order-add"]:not([disabled])').length,
    0,
    '排满之后产兵按钮要禁用，否则点了也只是弹一句"满了"',
  );
  assert.ok(
    doc.querySelector<HTMLButtonElement>('#side .upgrade-btn')?.disabled,
    '升级按钮也要一起禁掉：它排的也是同一批格子',
  );
});

check('指挥官栏能定「策略」与「进攻方向」，并且落到 state 里', () => {
  const bar = () => doc.querySelector<HTMLElement>('#commander')!;
  const chip = (key: string) =>
    bar().querySelector<HTMLElement>(`[data-cmd="strategy"][data-strategy="${key}"]`);
  const read = () =>
    JSON.parse(window.localStorage.getItem('warchess:match:v1') ?? '{}') as {
      orderDirectives?: Record<string, { strategy?: string; target?: unknown }>;
    };

  for (const key of ['auto', 'rush', 'boom', 'hold']) {
    assert.ok(chip(key), `应该有「${key}」这颗策略按钮`);
  }

  // 点「屯兵不动」：状态要落盘，界面要跟上选中态
  chip('hold')!.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert.equal(read().orderDirectives?.A?.strategy, 'hold', '策略要写进 state（AI 执行时读的就是它）');
  assert.ok(chip('hold')!.classList.contains('active'), '选中态要跟着切过去');

  // 改进攻方向：下拉走 change 事件
  const sel = bar().querySelector<HTMLSelectElement>('select[data-cmd="dir"]');
  assert.ok(sel, '应该有进攻方向下拉');
  sel!.value = 'seat:B';
  sel!.dispatchEvent(new window.Event('change', { bubbles: true }));
  assert.deepEqual(
    read().orderDirectives?.A?.target,
    { seat: 'B' },
    '方向要写进 state；两家局里这一项就是"盯着对面推"',
  );
  assert.equal(
    read().orderDirectives?.A?.strategy,
    'hold',
    '改方向不该把已经选好的策略清掉——两件事分开定',
  );

  // 换一个八向，确认枚举值也是同一条路
  const sel2 = bar().querySelector<HTMLSelectElement>('select[data-cmd="dir"]')!;
  sel2.value = 'dir:-1,0';
  sel2.dispatchEvent(new window.Event('change', { bubbles: true }));
  assert.deepEqual(read().orderDirectives?.A?.target, { dx: -1, dy: 0 }, '八向也要能存');

  // 收尾：改回自动，免得影响后面几条用例
  chip('auto')!.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  const sel3 = bar().querySelector<HTMLSelectElement>('select[data-cmd="dir"]')!;
  sel3.value = 'auto';
  sel3.dispatchEvent(new window.Event('change', { bubbles: true }));
  assert.equal(read().orderDirectives?.A?.strategy, 'auto');
  assert.equal(read().orderDirectives?.A?.target, undefined, '自动＝不带方向');
});

await checkAsync('点「执行 5 回合」先进进度态，可以中断', async () => {
  click('[data-cmd="run"]');
  await wait(150);

  const running = doc.querySelector<HTMLElement>('#commander');
  assert.ok(running?.querySelector('[data-cmd="stop"]'), '执行中应该有中断按钮');
  assert.ok(running?.querySelector('.cmd-progress'), '应该有进度条');
  assert.ok((running?.textContent ?? '').includes('/ 5'), `应该显示第几回合，实际：${running?.textContent}`);

  click('[data-cmd="stop"]');
  await wait(250);

  const back = doc.querySelector<HTMLElement>('#commander');
  assert.ok(back?.querySelector('[data-cmd="run"]'), '中断后应该回到可排计划的状态');
  assert.ok(!back?.querySelector('[data-cmd="stop"]'), '不该还停在进度态');
});

await checkAsync('每格都给出可用金币的估算', async () => {
  const bar = doc.querySelector<HTMLElement>('#commander');
  assert.ok(bar);
  // 中断之后队列还在（单机会把计划装回去），所以估算该有内容
  const ests = Array.from(bar.querySelectorAll<HTMLElement>('.cmd-chip-est'));
  assert.ok(ests.length > 0, '排过格子的队列应该有估算');
  assert.ok(
    /≈\s*\d+\s*金/.test(ests[0]?.textContent ?? ''),
    `第一格应该显示估算金币，实际：${ests[0]?.textContent}`,
  );
  assert.ok(bar.querySelector('[data-est-total]'), '应该有本批结束时余额的估算');
});

check('「空过一回合」能排进队列，且和"还没排"是两种长相', () => {
  const bar = () => doc.querySelector<HTMLElement>('#commander')!;
  // 先把上一批留下的队列清掉
  const clear = bar().querySelector<HTMLElement>('[data-cmd="clear"]');
  if (clear && !(clear as HTMLButtonElement).disabled) {
    clear.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  }
  assert.equal(bar().querySelectorAll('.cmd-chip:not(.is-empty)').length, 0, '先清空');

  const idle = bar().querySelector<HTMLElement>('[data-cmd="idle"]');
  assert.ok(idle, '参谋部要有一颗「空过一回合」');
  idle!.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

  const filled = bar().querySelectorAll('.cmd-chip.is-idle');
  assert.equal(filled.length, 1, '队列里应该出现一格"空过"');
  assert.ok((filled[0]!.textContent ?? '').includes('空过'), '那一格要写「空过」');

  // 关键：它和"还没排到"的虚线空格必须分得开——
  // 混在一起的话，玩家看不出"我明确要求这回合不造兵"和"我这格还没想好"
  const empty = bar().querySelectorAll('.cmd-chip.is-empty');
  assert.equal(empty.length, 4, '后面 4 格仍然是空的');

  const saved = JSON.parse(window.localStorage.getItem('warchess:match:v1') ?? '{}') as {
    orders?: { A?: string[] };
  };
  assert.deepEqual(saved.orders?.A, ['@idle'], '空过要落成哨兵值，不是空串');
});

check('指挥官模式：推进游戏只剩「执行一批」这一条路', () => {
  // 「结束行动」只推进一个回合，而参谋部按 5 回合一批走。两个入口各推各的，
  // 玩家顺手点一下就变成"走了半批"，对面看到的回合数也对不上。
  assert.equal(
    doc.querySelector('[data-act="end-turn"]'),
    null,
    '指挥官模式里不该再有「结束行动，交给对方」',
  );
  const run = doc.querySelector<HTMLElement>('#side [data-act="commander-run"]');
  assert.ok(run, '底栏那颗按钮要换成"执行一批再交还"');
  assert.ok((run!.textContent ?? '').includes('回合'), `按钮要写清打几个回合，实际：${run!.textContent}`);

  // 顶栏那颗也改成同一件事的另一条入口，而不是"把某一方托管给 AI"
  const toggle = doc.querySelector<HTMLElement>('#topbar [data-act="toggle-ai"]');
  assert.ok(toggle, '顶栏按钮还在');
  assert.equal(toggle!.textContent?.trim(), '交给参谋部', '指挥官模式下它叫「交给参谋部」');
});

check('棋盘尺寸按"容器宽"和"视口高减工具栏"取小，并且是方形的', () => {
  // jsdom 没有布局引擎，量什么都是 0，所以这里手工喂一组尺寸进去，
  // 验的是那段算术本身：size = min(容器宽, 视口高 − 顶栏 − 参谋部栏 − 内边距)
  const wrap = doc.querySelector<HTMLElement>('.board-wrap');
  const board = doc.querySelector<HTMLElement>('.board');
  const topbar = doc.querySelector<HTMLElement>('#topbar');
  const app = doc.querySelector<HTMLElement>('#app');
  assert.ok(wrap && board && topbar && app, '找不到尺寸计算需要的元素');

  Object.defineProperty(wrap, 'clientWidth', { configurable: true, value: 900 });
  // fitBoard 量的是 offsetWidth（含滚动条）：放大之后 clientWidth 会被滚动条吃掉一截，
  // 用它当基准会出现"放大 → 基准变小 → 格子变小"的抖动
  Object.defineProperty(wrap, 'offsetWidth', { configurable: true, value: 900 });
  Object.defineProperty(topbar, 'offsetHeight', { configurable: true, value: 54 });
  Object.defineProperty(app, 'clientHeight', { configurable: true, value: 700 });

  // 换个 AI 速度会触发一次完整 render，也就走了 fitBoard
  click('[data-act="ai-speed"]');

  const w = Number.parseFloat(board.style.width);
  const h = Number.parseFloat(board.style.height);
  assert.ok(w > 0, `棋盘宽度应该被算出来，实际「${board.style.width}」`);
  assert.equal(w, h, '必须还是正方形，否则格子会被拉成长方形');
  // 视口 700 是瓶颈（容器宽 900）：700 − 54 顶栏 − 0 内边距(jsdom 读不到) = 646
  assert.equal(w, 646, `应该被视口高度卡住，实际 ${w}`);
});

check('放大只撑大棋盘元素，不改基准尺寸；「适应」能回到 1×', () => {
  const wrap = doc.querySelector<HTMLElement>('.board-wrap');
  const scroll = doc.querySelector<HTMLElement>('.board-scroll');
  const board = doc.querySelector<HTMLElement>('.board');
  assert.ok(wrap && scroll && board, '找不到 board-wrap / board-scroll / board');

  click('[data-act="zoom-in"]');
  const zoomed = Number.parseFloat(board.style.width);
  // 646 是上面那一步算出来的基准，1.5× 一档
  assert.equal(zoomed, 969, `放大一档应该是 646 × 1.5，实际 ${zoomed}`);
  assert.ok(board.classList.contains('zoomed'), '棋盘要挂上 zoomed，才会取消 max-width');
  assert.ok(scroll.classList.contains('zoomed'), '滚动要挂在内层 board-scroll 上');
  // 外层绝不能滚动：一旦它自己滚，里面的缩放条就会跟着地图跑掉
  assert.ok(!wrap.classList.contains('zoomed'), 'board-wrap 不该承担滚动');

  click('[data-act="zoom-in"]');
  assert.equal(Number.parseFloat(board.style.width), 1292, '第二档 2×');

  click('[data-act="zoom-fit"]');
  assert.equal(Number.parseFloat(board.style.width), 646, '「适应」应该回到基准尺寸');
  assert.ok(!board.classList.contains('zoomed'), '回到 1× 就该摘掉 zoomed');
  assert.ok(!scroll.classList.contains('zoomed'), '内层也要摘掉');
});

check('缩放条不在滚动容器里面，所以不跟着地图平移', () => {
  const scroll = doc.querySelector<HTMLElement>('.board-scroll');
  const bar = doc.querySelector<HTMLElement>('.zoom-bar');
  assert.ok(scroll && bar, '找不到 board-scroll 或 zoom-bar');
  assert.equal(bar.parentElement?.classList.contains('board-wrap'), true, '缩放条应该挂在 board-wrap 上');
  assert.equal(scroll.contains(bar), false, '缩放条不能是滚动容器的内容');
});

check('拖过地图之后，缩放按钮还得点得动', () => {
  // 拖动过地图要吞掉"拖动的尾巴"那一下点击，否则松开的地方压着格子就会走一步棋。
  // 但吞的时候只该吞棋盘上的：缩放条是 board-wrap 的子元素、不在 .board 里，
  // 以前这里一并吞掉，玩家拖着地图松手正好压在「−」上，看起来就是"缩小键失灵"。
  const board = doc.querySelector<HTMLElement>('.board');
  assert.ok(board, '找不到 .board');
  // 拖动只在放大之后才成立（1× 时整张图都在屏幕里，没有可拖的）
  click('[data-act="zoom-in"]');
  const before = Number.parseFloat(board.style.width);
  assert.ok(before > 646, '这条要 1× 以上才有意义');

  const scroll = doc.querySelector<HTMLElement>('.board-scroll');
  assert.ok(scroll, '找不到 board-scroll');
  const pointer = (type: string, x: number): void => {
    scroll.dispatchEvent(new window.MouseEvent(type, { bubbles: true, clientX: x, clientY: 300 }));
  };
  pointer('pointerdown', 300);
  pointer('pointermove', 250); // 超过 6px 才算真的拖，不够就是一次点击
  pointer('pointerup', 250);

  click('[data-act="zoom-out"]');
  const after = Number.parseFloat(board.style.width);
  assert.ok(after < before, `拖过地图之后「缩小」应该照常生效：${before} → ${after}`);
});

await checkAsync('换一局之后缩放必须回到「适应」，而且还能再放大缩小', async () => {
  // 玩家报的 bug：放大之后缩不回去，开新局也还是缩不回去。
  // 根因是换局只写了 `boardZoom = 1`，没把 boardDirty 打上——fitBoard() 不跑，
  // 棋盘尺寸/zoomed 类/档位标签全停在上一局的放大状态，而变量已经是 1，
  // 再点「缩小」就被 setZoom 的"数字没变"挡掉了。
  const board = doc.querySelector<HTMLElement>('.board');
  assert.ok(board, '找不到 .board');

  // 先真的放大到 2×
  click('[data-act="zoom-fit"]');
  click('[data-act="zoom-in"]');
  click('[data-act="zoom-in"]');
  assert.equal(Number.parseFloat(board.style.width), 1292, '先放到 2×');
  assert.ok(board.classList.contains('zoomed'), '2× 时棋盘该带着 zoomed');

  // 开一局新的（面板里什么都不改，直接开始）
  openSetup();
  await new Promise((resolve) => setTimeout(resolve, 30));
  click('[data-act="start"]');
  await new Promise((resolve) => setTimeout(resolve, 60));

  assert.equal(Number.parseFloat(board.style.width), 646, '换局之后应该回到基准尺寸');
  assert.ok(!board.classList.contains('zoomed'), '换局之后不该还带着 zoomed');
  const scroll = doc.querySelector<HTMLElement>('.board-scroll');
  assert.ok(scroll && !scroll.classList.contains('zoomed'), '滚动容器也要摘掉 zoomed');

  // 而且档位还得能正常往回走
  click('[data-act="zoom-in"]');
  assert.equal(Number.parseFloat(board.style.width), 969, '换局之后放大一档照样是 1.5×');
  click('[data-act="zoom-out"]');
  assert.equal(Number.parseFloat(board.style.width), 646, '再缩回去');
});

check('技能：面板列出技能，冷却中的置灰', () => {
  const st = createMatch(
    {
      size: 12,
      startEra: 3,
      aiOpponent: false,
      aiAlly: false,
      expansionIds: ['fantasy-core', 'fantasy-heroes'],
      enabledUnits: Object.keys(UNIT_TYPES),
    },
    909,
  );
  st.current = 'A';
  const hero: Unit = {
    id: 'hero1',
    type: 'dwarf-king',
    owner: 'A',
    x: 5,
    y: 5,
    hp: st.unitTypes['dwarf-king']?.maxHp ?? 80,
    kills: 0,
    moved: false,
    acted: false,
  };
  st.units.push(hero);

  const host = doc.createElement('div');
  const paint = () =>
    renderPanel(host, {
      view: playerView(st, 'A'),
      me: 'A',
      selectedUnit: hero,
      selectedCityId: null,
      selectedCampId: null,
      selectedTile: null,
    });

  paint();
  // 标题从「英雄技能」改成「技能」：这套框架是奇想的英雄技能演化来的，
  // 但修士、散灵台也用同一套 UI，给它们挂个「英雄」是错的。
  assert.ok(!host.innerHTML.includes('英雄技能'), '不该再出现「英雄技能」');
  assert.ok(host.innerHTML.includes('>技能</div>'), '单位详情里应该有一块技能菜单');
  const btn = host.querySelector<HTMLElement>('[data-act="hero-skill"]');
  assert.ok(btn, '应该有技能按钮');
  assert.equal(btn!.dataset.skill, 'throw-axe', '矮人王的技能是投斧');
  assert.equal(btn!.hasAttribute('disabled'), false, '没冷却时能点');
  assert.ok(host.innerHTML.includes('就绪'), '就绪状态要写出来');

  // 冷却中：按钮置灰并显示还要等几回合
  hero.skillCd = { 'throw-axe': 1 };
  paint();
  const cold = host.querySelector<HTMLElement>('[data-act="hero-skill"]')!;
  assert.equal(cold.hasAttribute('disabled'), true, '冷却中不能点');
  assert.ok(host.innerHTML.includes('1 回合'), '要显示还差几回合');

  // 没选中任何东西时，默认页也要列出自己英雄的技能
  hero.skillCd = {};
  renderPanel(host, {
    view: playerView(st, 'A'),
    me: 'A',
    selectedUnit: null,
    selectedCityId: null,
    selectedCampId: null,
    selectedTile: null,
  });
  assert.ok(host.querySelector('[data-act="hero-skill"]'), '默认页也要能看到今天能开什么');
});

check('英雄面板：隐匿显示剩余发数，至尊法师显示当前属性', () => {
  const st = createMatch(
    {
      size: 12,
      startEra: 4,
      aiOpponent: false,
      aiAlly: false,
      expansionIds: ['fantasy-core', 'fantasy-heroes'],
      enabledUnits: Object.keys(UNIT_TYPES),
    },
    910,
    {},
  );
  st.current = 'A';
  const mk = (type: string, id: string): Unit => ({
    id,
    type,
    owner: 'A',
    x: 5,
    y: 5,
    hp: st.unitTypes[type]!.maxHp,
    kills: 0,
    moved: false,
    acted: false,
  });
  const assassin = mk('assassin-master', 'a1');
  const mage = mk('archmage', 'm1');
  st.units.push(assassin, mage);

  const host = doc.createElement('div');
  const paint = (u: Unit | null): void =>
    renderPanel(host, {
      view: playerView(st, 'A'),
      me: 'A',
      selectedUnit: u,
      selectedCityId: null,
      selectedCampId: null,
      selectedTile: null,
    });

  // ① 隐匿：3 发，用掉一发要少一发，打空之后按钮灰掉并写清多久回一发
  paint(assassin);
  assert.ok((host.textContent ?? '').includes('3/3 发'), '隐匿要写明还剩几发');
  assassin.skillCharge = { vanish: { n: 2, t: 0 } };
  paint(assassin);
  assert.ok((host.textContent ?? '').includes('2/3 发'), '扣了一发要跟着变');
  assassin.skillCharge = { vanish: { n: 0, t: 0 } };
  paint(assassin);
  const btn = host.querySelector<HTMLElement>('[data-act="hero-skill"]')!;
  assert.equal(btn.hasAttribute('disabled'), true, '没发数时按钮要灰');
  assert.ok((host.textContent ?? '').includes('回合回一发'), '要写清多久回一发');

  // ② 至尊法师：当前属性跟着运行时值走，攻 0 的兵必须把魔法段单独写出来
  mage.element = 'dark';
  paint(mage);
  const dark = host.textContent ?? '';
  assert.ok(dark.includes('当前属性'), '要有一行「当前属性」');
  assert.ok(dark.includes('暗'), '显示的是运行时属性（切过之后是暗）');
  assert.ok(dark.includes('魔法段 ×1.5'), '暗形态要说明它干了什么');
  assert.ok(dark.includes('魔法攻击'), '攻 0 的兵不写魔法段，看着就像不会打人');
  mage.element = 'fire';
  paint(mage);
  assert.ok((host.textContent ?? '').includes('火'), '切回火属性要跟着变');
});

check('行动点面板：还剩多少 E、这一回合花在哪、单价为什么便宜', () => {
  const st = createMatch(
    {
      size: 12,
      startEra: 1,
      aiOpponent: false,
      aiAlly: false,
      expansionIds: ['action-points'],
      enabledUnits: Object.keys(UNIT_TYPES),
    },
    912,
    {},
  );
  st.current = 'A';
  const mk = (type: string, id: string, x: number): Unit => ({
    id,
    type,
    owner: 'A',
    x,
    y: 5,
    hp: st.unitTypes[type]!.maxHp,
    kills: 0,
    moved: false,
    acted: false,
  });
  const foot = mk('militia', 'ap-foot', 5);
  const horse = mk('scout', 'ap-horse', 7);
  st.units.push(foot, horse);
  // 开账：站位对齐＝这一回合还没动过
  foot.custom = { ap: { turn: st.turn, x: 5, y: 5, debt: 0, over: 0 } };
  horse.custom = { ap: { turn: st.turn, x: 7, y: 5, debt: 0, over: 0 } };

  const host = doc.createElement('div');
  const paint = (u: Unit): void =>
    renderPanel(host, {
      view: playerView(st, 'A'),
      me: 'A',
      selectedUnit: u,
      selectedCityId: null,
      selectedCampId: null,
      selectedTile: null,
    });
  const text = (): string => host.textContent ?? '';

  // ① 民兵站着不动：什么都不扣（驻扎已取消），池子原样
  paint(foot);
  assert.ok(text().includes('行动点 100 / 100 E'), `要写清还剩多少：${text().slice(0, 200)}`);
  assert.ok(text().includes('本回合：什么都没做'), '什么都没干要说清楚，而不是留一行空白');

  // ② 走过一格：记成移动
  foot.custom = { ap: { turn: st.turn, x: 4, y: 5, debt: 0, over: 0 } };
  paint(foot);
  assert.ok(text().includes('本回合：移动 −20'), '走过就写移动');
  assert.ok(text().includes('行动点 80 / 100 E'), '走一步扣 20');

  // ③ 斥候：骑兵 −5、近战 −10，两行单价要说得出"为什么便宜"
  paint(horse);
  assert.ok(text().includes('行动点 120 / 120 E'), '斥候是骑兵：池子 120（这一格还没走）');
  assert.ok(text().includes('机动 15E（骑兵）'), '骑兵的机动便宜要写出来');
  assert.ok(text().includes('出手 30E（近战）'), '近战的出手便宜要写出来');

  // ④ 池子见底：要明说走不动 / 打不出第二下，而不是让玩家点下去才发现
  horse.custom = { ap: { turn: st.turn, x: 7, y: 5, debt: 110, over: 0 } };
  paint(horse);
  assert.ok(text().includes('走不动了'), 'E 见底要写在面板上');
  assert.ok(text().includes('上回合透支 110'), '透支了多少要交代');
});

check('新英雄的技能按钮挂上了对应技能', () => {
  const st = createMatch(
    {
      size: 12,
      startEra: 3,
      aiOpponent: false,
      aiAlly: false,
      expansionIds: ['fantasy-core', 'fantasy-heroes'],
      enabledUnits: Object.keys(UNIT_TYPES),    },
    911,
  );
  st.current = 'A';

  // 三个新兵：刺客大师（隐匿）、史莱姆牢大（裂殖）、大史莱姆（聚合）
  const cases: Array<{ type: string; skill: string; label: string }> = [
    { type: 'assassin-master', skill: 'vanish', label: '隐匿' },
    { type: 'slime-boss', skill: 'mitosis', label: '裂殖' },
    { type: 'slime-giant', skill: 'fuse', label: '聚合' },
  ];

  for (const c of cases) {
    const unit: Unit = {
      id: `new-${c.type}`,
      type: c.type,
      owner: 'A',
      x: 5,
      y: 5,
      hp: st.unitTypes[c.type]?.maxHp ?? 50,
      kills: 0,
      moved: false,
      acted: false,
    };
    st.units = st.units.filter((u) => u.id !== unit.id);
    st.units.push(unit);

    const host = doc.createElement('div');
    renderPanel(host, {
      view: playerView(st, 'A'),
      me: 'A',
      selectedUnit: unit,
      selectedCityId: null,
      selectedCampId: null,
      selectedTile: null,
    });
    const btn = host.querySelector<HTMLElement>('[data-act="hero-skill"]');
    assert.ok(btn, `${c.type} 应该有技能按钮`);
    assert.equal(btn!.dataset.skill, c.skill, `${c.type} 的技能应该是 ${c.label}`);
    assert.ok(host.innerHTML.includes(c.label), `${c.label} 的名字要印在按钮上`);
  }
});

check('大史莱姆不进产线：召唤物只能从裂殖里出来', () => {
  const st = createMatch(
    {
      size: 12,
      startEra: 5,
      aiOpponent: false,
      aiAlly: false,
      expansionIds: ['fantasy-core', 'fantasy-heroes'],
      enabledUnits: Object.keys(UNIT_TYPES),
    },
    912,
  );
  st.current = 'A';
  st.players.A.gold = 3000;
  const city = st.cities.find((c) => c.owner === 'A');
  assert.ok(city, '应该有 A 方城市');
  // 产线只列"当前时代和上一档"，牢大是 3 级兵，城就压到 3 级
  city.era = 3;

  const host = doc.createElement('div');
  renderPanel(host, {
    view: playerView(st, 'A'),
    me: 'A',
    selectedUnit: null,
    selectedCityId: city.id,
    selectedCampId: null,
    selectedTile: null,
  });
  assert.ok(host.querySelector('[data-type="slime-boss"]'), '牢大是英雄，可以在城市里招');
  assert.ok(!host.querySelector('[data-type="slime-giant"]'), '大史莱姆不该出现在产线上');
});

check('产兵搜索框：按名字/包名过滤，兵种带扩展包徽标', () => {
  const st = createMatch(
    {
      size: 14,
      startEra: 4,
      aiOpponent: false,
      aiAlly: false,
      expansionIds: ['fantasy-core', 'fantasy-beasts', 'fantasy-arcane', 'fantasy-knights'],
      enabledUnits: Object.keys(UNIT_TYPES),
    },
    505,
  );
  st.current = 'A';
  const city = st.cities.find((c) => c.owner === 'A');
  assert.ok(city, '找不到 A 的城市');

  const host = doc.createElement('div');
  const paint = (q: string, pack = '') =>
    renderPanel(host, {
      view: playerView(st, 'A'),
      me: 'A',
      selectedUnit: null,
      selectedCityId: city!.id,
      selectedCampId: null,
      selectedTile: null,
      recruitQuery: q,
      recruitPack: pack,
    });

  paint('');
  assert.ok(host.querySelector('[data-act="recruit-search"]'), '高时代城市应该有搜索框');
  const all = host.querySelectorAll('[data-act="recruit"]').length;
  assert.ok(all >= 6, `这一屏应该有一堆兵种，实际 ${all}`);

  const badges = host.querySelectorAll('.recruit-src').length;
  assert.ok(badges > 0, '奇想兵种要标出包名');
  assert.ok(badges < all, '原版兵种不该挂徽标');
  assert.ok(
    Array.from(host.querySelectorAll('.recruit-src')).every((b) => (b.textContent ?? '').includes('奇想')),
    '徽标内容应该是包名',
  );

  // 按名字搜：只剩龙骑兵
  paint('龙骑');
  assert.equal(host.querySelectorAll('[data-act="recruit"]').length, 1, '按名字搜应该只剩一个');
  assert.ok(host.querySelector('[data-type="dragoon-rider"]'), '搜"龙骑"应该命中龙骑兵');

  // 按包名搜：命中的全是这个包的，且每个都带徽标
  paint('奇想');
  const packHits = host.querySelectorAll('[data-act="recruit"]');
  assert.ok(packHits.length > 1, '按包名应该能搜出一批');
  assert.equal(
    host.querySelectorAll('[data-act="recruit"] .recruit-src').length,
    packHits.length,
    '按包名搜出来的应该全是带徽标的兵种',
  );

  // 搜不到时给一句人话，而不是一片空白
  paint('zzz');
  assert.equal(host.querySelectorAll('[data-act="recruit"]').length, 0);
  assert.ok(host.innerHTML.includes('没有匹配'), '搜不到要说清楚');

  // 框里是什么，显示的就是什么：中英混排一个字符都不能多
  paint('chuan船');
  assert.equal(
    host.querySelector<HTMLInputElement>('[data-act="recruit-search"]')?.value,
    'chuan船',
    '输入内容要原样回填',
  );

  // 按扩展包切一刀：原版那一档全是没徽标的，奇想那一档全是带徽标的
  paint('');
  const packChips = host.querySelectorAll('[data-act="recruit-pack"]');
  assert.ok(packChips.length >= 3, `应该有"全部/原版/各扩展包"这几档，实际 ${packChips.length}`);

  paint('', 'core');
  const core = host.querySelectorAll('[data-act="recruit"]');
  assert.ok(core.length > 0, '原版那一档不该是空的');
  assert.equal(host.querySelectorAll('.recruit-src').length, 0, '原版兵种头上不该有包名徽标');

  paint('', 'fantasy');
  const beasts = host.querySelectorAll('[data-act="recruit"]');
  assert.ok(beasts.length > 0, '奇想那一档不该是空的');
  assert.equal(
    host.querySelectorAll('.recruit-src').length,
    beasts.length,
    '按包筛出来的应该全是这个包的兵',
  );
  // 切包不该改变"能买什么"，只改变"看到什么"：两档加起来不会超过全部
  assert.ok(core.length + beasts.length <= all, '筛选只是过滤，不该凭空多出兵种');
});

check('筛选把整页清空时，筛选栏与「清掉筛选」都必须还在（换城不再锁死）', () => {
  const st = createMatch(
    {
      size: 14,
      startEra: 4,
      aiOpponent: false,
      aiAlly: false,
      expansionIds: ['fantasy-core', 'fantasy-knights'],
      enabledUnits: Object.keys(UNIT_TYPES),
    },
    619,
  );
  st.current = 'A';
  const city = st.cities.find((c) => c.owner === 'A');
  assert.ok(city, '找不到 A 的城市');

  const host = doc.createElement('div');
  const paint = (pack = '', era = 0) =>
    renderPanel(host, {
      view: playerView(st, 'A'),
      me: 'A',
      selectedUnit: null,
      selectedCityId: city!.id,
      selectedCampId: null,
      selectedTile: null,
      recruitPack: pack,
      recruitEra: era,
    });
  const count = () => host.querySelectorAll('[data-act="recruit"]').length;

  // 把城压到青铜：骑士团一个能造的都没有（它的兵都在 2 代以上）
  city!.era = 1;
  paint();
  const before = count();
  assert.ok(before > 0, '青铜城市本来是有兵可造的');

  // 复现：筛一个这座城市造不了的包 → 空列表
  paint('fantasy-knights');
  assert.equal(count(), 0, '前提：这个筛选确实把这页清空了');

  // 关键：那颗"生效中"的 chip 必须还在，否则玩家没有出口
  const chip = host.querySelector<HTMLElement>(
    '[data-act="recruit-pack"][data-pack="fantasy-knights"]',
  );
  assert.ok(chip, '生效中的包筛选必须留在筛选栏里');
  assert.equal(chip!.className.includes('active'), true, '它还要是亮着的');
  const clear = host.querySelector<HTMLElement>('[data-act="recruit-clear"]');
  assert.ok(clear, '空结果里要给一颗"清掉筛选"');
  assert.ok((host.textContent ?? '').includes('清掉筛选'), '提示句里也要提到它');

  // 时代那一维同理：筛一个城造不出的时代，也要留按钮
  paint('', 6);
  assert.equal(count(), 0, '前提：六代兵在这座青铜城里造不出来');
  assert.ok(
    host.querySelector('[data-act="recruit-era"][data-era="6"]'),
    '生效中的时代筛选必须留在筛选栏里',
  );

  // 清掉之后回到全部
  paint();
  assert.equal(count(), before, '回到全部时兵种数应该和一开始一致');
});

check('产兵双筛选：扩展包 + 时代，两维是"与"，再点一次回全部', () => {
  const st = createMatch(
    {
      size: 14,
      startEra: 4,
      aiOpponent: false,
      aiAlly: false,
      expansionIds: ['fantasy'],
      enabledUnits: Object.keys(UNIT_TYPES),
    },
    506,
  );
  st.current = 'A';
  const city = st.cities.find((c) => c.owner === 'A');
  assert.ok(city, '找不到 A 的城市');
  city!.era = 4;

  const host = doc.createElement('div');
  const paint = (q = '', pack = '', era = 0) =>
    renderPanel(host, {
      view: playerView(st, 'A'),
      me: 'A',
      selectedUnit: null,
      selectedCityId: city!.id,
      selectedCampId: null,
      selectedTile: null,
      recruitQuery: q,
      recruitPack: pack,
      recruitEra: era,
    });
  /** 这一屏上每个按钮背后那个兵的时代 */
  const erasShown = () =>
    Array.from(host.querySelectorAll<HTMLElement>('[data-act="recruit"]'))
      .map((el) => UNIT_TYPES[el.dataset.type ?? '']?.era ?? -1)
      .filter((e) => e > 0);
  const count = () => host.querySelectorAll('[data-act="recruit"]').length;

  paint();
  assert.ok(host.querySelector('[data-act="recruit-pack"]'), '第一维：扩展包 chip');
  assert.ok(host.querySelector('[data-act="recruit-era"]'), '第二维：时代 chip');
  const all = count();

  // 时代这一维单独用：切到青铜，出来的必须全是青铜兵
  const eraChips = Array.from(
    host.querySelectorAll<HTMLElement>('[data-act="recruit-era"]'),
  ).map((el) => Number(el.dataset.era));
  assert.ok(eraChips.includes(0), '「全部时代」那一档要在');
  const levels = eraChips.filter((e) => e > 0).sort((a, b) => a - b);
  assert.ok(levels.length >= 2, `两行 chip 至少要能选两个时代，实际 ${levels.join(',')}`);

  paint('', '', levels[0]!);
  assert.ok(count() > 0, '青铜那一档不该是空的');
  assert.ok(
    erasShown().every((e) => e === levels[0]),
    `筛了青铜就只该有青铜兵，实际混进了 ${[...new Set(erasShown())].join(',')}`,
  );
  assert.equal(
    host.querySelector<HTMLElement>(`[data-act="recruit-era"][data-era="${levels[0]}"]`)?.className.includes('active'),
    true,
    '当前那一档要亮着',
  );

  // 各时代加起来 = 全部：一个兵只属于一个时代，不能重也不能漏
  const sum = levels.reduce((n, l) => {
    paint('', '', l);
    return n + count();
  }, 0);
  assert.equal(sum, all, `各时代加起来应该正好等于全部（${sum} vs ${all}）`);

  // 叠两个维度：包 + 时代，结果只会更少，而且仍然是"且"
  const oneLevel = levels[levels.length - 1]!;
  paint('', 'fantasy', 0);
  const onlyPack = count();
  paint('', '', oneLevel);
  const onlyEra = count();
  paint('', 'fantasy', oneLevel);
  const both = count();
  assert.ok(both <= onlyPack && both <= onlyEra, '两个条件是"与"：叠起来不该比任何一边多');
  assert.ok(
    erasShown().every((e) => e === oneLevel),
    '叠了时代之后仍然只能有那个时代的兵',
  );
  assert.ok(
    Array.from(host.querySelectorAll('[data-act="recruit"] .recruit-src')).length === count(),
    '叠了包之后仍然只能有那个包的兵',
  );
  // 再叠搜索：三个条件一起收窄
  paint('龙骑', 'fantasy', oneLevel);
  assert.ok(count() <= both, '再叠一个搜索词只会更少');

  // 回到全部：三个维度全清，兵数是全量
  paint();
  assert.equal(count(), all, '清掉筛选应该回到全量');

  // 没命中时要把**生效的每一维**都写出来，否则玩家不知道该清哪一个
  paint('', 'fantasy', levels[0]!);
  if (count() === 0) {
    assert.ok(host.innerHTML.includes('这一档没有能造的兵'), '空态要给一句人话');
    assert.ok(host.innerHTML.includes('奇想'), '空态要写清生效了包筛选');
    assert.ok(host.innerHTML.includes('青铜'), '空态要写清生效了时代筛选');
  }
});

check('热座指挥官：底栏是「提交作战计划」，交完就变「已提交，等对方」', () => {
  // 热座 = 一台机器两个人、对面不是 AI。这时底栏那颗按钮不能是「执行 5 回合」——
  // 第一个人一按，第二个人就只剩看的分。
  const st = createMatch(
    {
      size: 12,
      startEra: 3,
      aiOpponent: false,
      aiAlly: false,
      commanderMode: true,
      expansionIds: [],
      enabledUnits: Object.keys(UNIT_TYPES),
    },
    611,
  );
  st.current = 'A';
  const host = doc.createElement('div');
  const paint = (planHotseat: boolean, planReady: boolean) =>
    renderPanel(host, {
      view: playerView(st, 'A'),
      me: 'A',
      selectedUnit: null,
      selectedCityId: null,
      selectedCampId: null,
      selectedTile: null,
      commander: true,
      planHotseat,
      planReady,
    });

  paint(true, false);
  const commit = host.querySelector<HTMLButtonElement>('[data-act="plan-commit"]');
  assert.ok(commit, '热座里底栏应该是"提交作战计划"');
  assert.equal(commit!.textContent?.trim(), '提交作战计划');
  assert.equal(commit!.disabled, false, '轮到你就该能交');
  assert.equal(host.querySelector('[data-act="commander-run"]'), null, '热座不该再有"执行 N 回合"');

  paint(true, true);
  const again = host.querySelector<HTMLButtonElement>('[data-act="plan-commit"]');
  assert.ok((again!.textContent ?? '').includes('已提交'), `交完要写「已提交」，实际：${again!.textContent}`);
  assert.equal(again!.disabled, true, '交过了就别让他再交一次');

  // 人机指挥官维持原样：一次打完一批再交还
  paint(false, false);
  const batch = host.querySelector<HTMLButtonElement>('[data-act="commander-run"]');
  assert.ok(batch, '人机局照旧是"执行 N 回合"');
  assert.ok((batch!.textContent ?? '').includes('回合'));
  assert.equal(host.querySelector('[data-act="plan-commit"]'), null);
});

check('旧兵不再被时代下限吃掉：五代城照样列得出民兵', () => {
  // 这条以前是反的：城市 era 5，面板里连一个青铜兵都不剩。
  const st = createMatch(
    { size: 14, startEra: 5, aiOpponent: false, aiAlly: false, expansionIds: [], enabledUnits: Object.keys(UNIT_TYPES) },
    507,
  );
  st.current = 'A';
  const city = st.cities.find((c) => c.owner === 'A');
  assert.ok(city);
  city!.era = 5;
  st.players.A.gold = 9999;

  const host = doc.createElement('div');
  renderPanel(host, {
    view: playerView(st, 'A'),
    me: 'A',
    selectedUnit: null,
    selectedCityId: city!.id,
    selectedCampId: null,
    selectedTile: null,
  });

  assert.ok(host.querySelector('[data-type="militia"]'), '民兵要在列表里（显示）');
  const btn = host.querySelector<HTMLButtonElement>('[data-type="militia"]');
  assert.equal(btn?.disabled, false, '而且真的能点（不是画一个假按钮）');

  // 规则层同一个结论：五代城造得出一代兵
  const r = applyAction(st, { type: 'RECRUIT', cityId: city!.id, unitType: 'militia' });
  assert.ok(r.ok, r.ok ? '' : `五代城应该造得出民兵：${r.reason}`);

  // 上界还在：五代的城不该列出六代兵
  const future = Array.from(host.querySelectorAll<HTMLElement>('[data-act="recruit"]')).filter(
    (el) => (UNIT_TYPES[el.dataset.type ?? '']?.era ?? 0) > 5,
  );
  assert.equal(future.length, 0, '还没解锁的时代不该出现在产兵面板里');
});

console.log('\n上帝模式');
openSetup();
await wait(40);

check('开局面板多了"上帝模式"这一档', () => {
  assert.ok(doc.querySelector('[data-role="god"]'), '应该有上帝模式选项');
});

click('[data-role="god"]');

check('选了上帝模式，对手那栏就收起来了', () => {
  // 热座/人机/双 AI 三个选项在这里没有意义：两边都由玩家摆
  const body = doc.querySelector('.modal-body')?.textContent ?? '';
  assert.ok(body.includes('纯单人沙盒'), `应该说明这是纯单人，实际：${body.slice(0, 80)}`);
  assert.equal(doc.querySelector('[data-ai="1"]'), null, '对手选项应该收掉');
});

click('[data-act="start"]');
await wait(80);

/** 读当前这一局的存档（界面重绘过，捏着旧 state 没用） */
function savedGame(): {
  w: number;
  h: number;
  tiles: { terrain: string; cityId: string | null }[];
  units: { id: string; type: string; owner: string; x: number; y: number }[];
  cities: { id: string; owner: string; x: number; y: number }[];
  players: Record<string, { gold: number }>;
  unitTypes: Record<string, { id: string; domain?: string; category: string }>;
} {
  return JSON.parse(window.localStorage.getItem('warchess:match:v1') ?? '{}');
}

check('上帝模式开局：工具栏、兵种货架、全图视角一次到位', () => {
  const bar = doc.querySelector<HTMLElement>('#commander');
  assert.ok(bar && !bar.hidden, '工具栏应该显示出来');
  assert.ok((bar!.textContent ?? '').includes('上帝模式'));
  assert.ok(doc.querySelector('[data-act="god-run-round"]'), '要有「交给 AI · 一回合」');
  assert.ok(doc.querySelector('[data-act="god-run-dead"]'), '要有「接管 · 打到全灭」');
  assert.ok(doc.querySelector('.god-shelf'), '侧栏应该换成兵种货架');
  // 全图：沙盒里藏信息没有意义，摆完 B 方的兵下一帧就看不见的沙盒没法用
  assert.equal(doc.querySelectorAll('.tile.out').length, 0, '不该有视野外的格子');
  assert.ok((doc.querySelector('[data-ref="who"]')?.textContent ?? '').includes('上帝模式'));
});

/*
 * 拖动绘制。
 *
 * jsdom 没有 Pointer Events，所以这里手工派发 pointerdown/pointermove/pointerup，
 * 坐标靠给 `.tiles` 钉一个 400×400 的矩形来换算（和上面"点地图"那条同一套办法）。
 * 要守的三件事：
 *   1. 快速拖动只发起点和终点，中间那几格也必须被补上；
 *   2. 整根拖动在撤销栈里只占一步；
 *   3. 单格点击的老行为不变。
 */
let lastDragCell: { x: number; y: number } | null = null;

check('上帝模式：笔刷按住拖过去，沿途每一格都刷到，撤销只退一步', () => {
  // 挑一个地形笔刷：不依赖货架里有没有某个兵，也不会被"这格站着东西"挡住
  click('[data-act="god-terrain"][data-terrain="forest"]');

  const board = doc.querySelector<HTMLElement>('#board')!;
  const tiles = board.querySelector<HTMLElement>('.tiles')!;
  const cols = Number(board.style.getPropertyValue('--cols'));
  const rows = Number(board.style.getPropertyValue('--rows'));
  assert.ok(cols > 0 && rows > 0, '棋盘应该已经写好了行列数');

  const box = 400;
  Object.defineProperty(tiles, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({
      left: 100, top: 50, width: box, height: box, right: 100 + box, bottom: 50 + box, x: 100, y: 50,
    }),
  });
  const cw = box / cols;
  const ch = box / rows;
  const at = (x: number, y: number) => ({
    clientX: 100 + (x + 0.5) * cw,
    clientY: 50 + (y + 0.5) * ch,
  });
  const fire = (type: string, p: { clientX: number; clientY: number }) => {
    board.dispatchEvent(new window.MouseEvent(type, { ...p, bubbles: true }));
  };

  const before = savedGame();
  // 城格改不了地形、已经是森林的格看不出变化——所以自己找一段"干净"的横线
  const clean = (x: number, y: number): boolean => {
    const t = before.tiles[y * cols + x];
    return !!t && !t.cityId && t.terrain !== 'forest';
  };
  let sx = -1;
  let sy = -1;
  for (let y = 0; y < rows && sx < 0; y += 1) {
    for (let x = 0; x + 4 < cols; x += 1) {
      if (clean(x, y) && clean(x + 1, y) && clean(x + 2, y) && clean(x + 3, y) && clean(x + 4, y)) {
        sx = x;
        sy = y;
        break;
      }
    }
  }
  assert.ok(sx >= 0, '这张图上应该有一段能连着刷五格的干净横线');

  // 只发起点和终点，中间一格都不发——这就是"很快地划过去"
  fire('pointerdown', at(sx, sy));
  fire('pointermove', at(sx + 4, sy));
  fire('pointerup', at(sx + 4, sy));
  lastDragCell = { x: sx + 4, y: sy };

  const after = savedGame();
  for (let k = 0; k <= 4; k += 1) {
    assert.equal(
      after.tiles[sy * cols + sx + k]!.terrain,
      'forest',
      `(${sx + k},${sy}) 漏了：快速拖动必须把中间格子补齐`,
    );
  }
  // 线外面的格子一格都不许动
  if (sy + 1 < rows && clean(sx, sy + 1)) {
    assert.equal(
      after.tiles[(sy + 1) * cols + sx]!.terrain,
      before.tiles[(sy + 1) * cols + sx]!.terrain,
      '拖出界了：下面那一行不该被刷到',
    );
  }

  // 一次「撤回」把整根拖动全退掉 → 这根拖动在撤销栈里只占一步
  click('[data-act="undo"]');
  const undone = savedGame();
  for (let k = 0; k <= 4; k += 1) {
    assert.equal(
      undone.tiles[sy * cols + sx + k]!.terrain,
      before.tiles[sy * cols + sx + k]!.terrain,
      `撤回一次就该把 (${sx + k},${sy}) 一起退回去，说明整根拖动只压了一步`,
    );
  }
});

check('上帝模式：单格点击照旧，拖动尾巴不会把这一下吞掉或画两遍', () => {
  const board = doc.querySelector<HTMLElement>('#board')!;
  const cols = Number(board.style.getPropertyValue('--cols'));
  const rows = Number(board.style.getPropertyValue('--rows'));
  const box = 400;
  const cw = box / cols;
  const ch = box / rows;
  const at = (x: number, y: number) => ({
    clientX: 100 + (x + 0.5) * cw,
    clientY: 50 + (y + 0.5) * ch,
  });

  const before = savedGame();
  // 找一个既不是城、还不是森林、也不在上一条用例那次拖动的落点上
  let cell: { x: number; y: number } | null = null;
  for (let y = 0; y < rows && !cell; y += 1) {
    for (let x = 0; x < cols; x += 1) {
      const t = before.tiles[y * cols + x];
      if (!t || t.cityId || t.terrain === 'forest') continue;
      if (lastDragCell && lastDragCell.x === x && lastDragCell.y === y) continue;
      cell = { x, y };
      break;
    }
  }
  assert.ok(cell, '图上应该有没被画过的空格');
  const index = cell!.y * cols + cell!.x;

  // 1) 纯点击（没有 pointerdown/up，只有 click）：老路径必须还在
  board
    .querySelector<HTMLElement>(`.tile[data-x="${cell!.x}"][data-y="${cell!.y}"]`)!
    .dispatchEvent(new window.MouseEvent('click', { ...at(cell!.x, cell!.y), bubbles: true }));
  assert.equal(savedGame().tiles[index]!.terrain, 'forest', '单格点击还应该照旧刷上');

  // 2) 按下-松开但没动（手指点一下）：落笔走 click，不能被拖动吃掉，也不能刷两遍
  const second = (() => {
    for (let y = 0; y < rows; y += 1) {
      for (let x = 0; x < cols; x += 1) {
        const t = before.tiles[y * cols + x];
        if (!t || t.cityId || t.terrain === 'forest') continue;
        if (x === cell!.x && y === cell!.y) continue;
        return { x, y };
      }
    }
    return null;
  })();
  assert.ok(second, '还需要第二个空格');
  board.dispatchEvent(new window.MouseEvent('pointerdown', { ...at(second!.x, second!.y), bubbles: true }));
  board.dispatchEvent(new window.MouseEvent('pointerup', { ...at(second!.x, second!.y), bubbles: true }));
  // 松手后浏览器会补一个 click
  board
    .querySelector<HTMLElement>(`.tile[data-x="${second!.x}"][data-y="${second!.y}"]`)!
    .dispatchEvent(new window.MouseEvent('click', { ...at(second!.x, second!.y), bubbles: true }));
  assert.equal(
    savedGame().tiles[second!.y * cols + second!.x]!.terrain,
    'forest',
    '点一下也要刷上',
  );
});

check('上帝模式：工具栏有「上传这张图」，弹窗先把尺寸、城数和审核流程说清楚', () => {
  const btn = doc.querySelector<HTMLElement>('[data-act="god-map-upload"]');
  assert.ok(btn, '上帝模式工具栏要能上传地图');

  btn!.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  const mask = doc.querySelector<HTMLElement>('.modal-mask');
  assert.ok(mask, '点了应该弹出上传面板');

  const text = mask!.textContent ?? '';
  assert.ok(text.includes('上传这张地图'), '弹窗要有标题');
  assert.ok(text.includes('云端地图库'), '要说清传到哪儿去');
  // 审核这句话必须在场：不写清楚，作者会以为传完别人立刻就能选
  assert.ok(
    text.includes('审核放行') || text.includes('等审核') || text.includes('先进审核队列'),
    `要说明这是要走审核的：${text.slice(0, 120)}`,
  );
  assert.ok(mask!.querySelector('[data-field="name"]'), '要有地图名输入框');

  // 能导出的图会显示尺寸统计；导不出（城贴边等）会显示原因——两种都得有内容
  const hasStat = /\d+×\d+/.test(text);
  const errBox = mask!.querySelector('.map-err');
  assert.ok(hasStat || errBox, `弹窗该显示尺寸统计，或者说明为什么传不了：${text.slice(0, 160)}`);

  const close = mask!.querySelector<HTMLElement>('[data-act="close"]');
  assert.ok(close, '要能关掉');
  close!.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert.equal(doc.querySelector('.modal-mask'), null, '关掉之后遮罩要收起来');
});

check('己方战报只给自己的条目和战损，观战才看全部', () => {
  const st = createMatch(
    {
      size: 12,
      startEra: 1,
      aiOpponent: true,
      aiAlly: false,
      expansionIds: [],
      enabledUnits: Object.keys(UNIT_TYPES),
    },
    606,
  );
  st.log = [
    { turn: 1, player: 'A', text: '我造了一座箭塔' },
    { turn: 1, player: 'B', text: '他在攒钱升时代' },
    { turn: 1, player: 'B', text: '民兵倒下了', open: true },
  ];

  const host = doc.createElement('div');
  const paint = (logSide: 'A' | null) =>
    renderPanel(host, {
      view: playerView(st, 'A'),
      me: 'A',
      selectedUnit: null,
      selectedCityId: null,
      selectedCampId: null,
      selectedTile: null,
      logSide,
    });

  paint('A');
  const mine = host.querySelector('.log')?.textContent ?? '';
  assert.ok(mine.includes('我造了一座箭塔'), '自己的条目要留着');
  assert.ok(!mine.includes('他在攒钱'), '对面的私报不该出现在己方战报里（那是免费视野）');
  assert.ok(mine.includes('民兵倒下了'), '战损是公开信息，棋盘上看得见');
  assert.ok(host.querySelector('.log-item.open'), '公开的战损条目要标出来');

  paint(null);
  const all = host.querySelector('.log')?.textContent ?? '';
  assert.ok(all.includes('他在攒钱'), '观战/热座要看全部');
});

check('设置弹窗：主题、动效、铃声、低频入口都在里面', () => {
  /*
   * 2026-11-11：顶栏那排"想起来才改"的按钮改成一颗「设置」。
   * 这条钉住"搬进去的东西一件都不少"——搬家最容易掉的正是最后那件。
   *
   * 顺带把主题开关也放进来：之前只能用 `?ui=modern` 或控制台，用户问过
   * "modern 开关在哪"，答起来都不像正常产品。
   */
  const html = settingsHtml({
    theme: 'modern',
    reducedMotion: true,
    chime: 0.35,
    chimeText: '铃声 35%',
  });
  const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

  for (const act of [
    'set-theme',
    'set-motion',
    'chime-range',
    'chime-test',
    'export',
    'new-game',
    'manual',
    'feedback',
    'settings-close',
  ]) {
    assert.ok(html.includes(`data-act="${act}"`), `设置里缺了 ${act}`);
  }

  // 当前值要如实反映：深色主题选中的是「新版」，动效选中的是「减少」
  assert.ok(/data-theme="modern"[^>]*>新版/.test(html), '当前主题要标在「新版」上');
  assert.ok(/data-motion="reduced"[^>]*>减少/.test(html), '减少动效要标在「减少」上');
  assert.ok(text.includes('铃声 35%'), `音量文字要写出来：${text.slice(0, 80)}`);
  // 滑块的值跟 chime 走，别写死 60
  assert.ok(/value="35"/.test(html), '滑块初值要等于当前音量');

  // 副标题要说清"这是本机设置"——不然玩家会以为它会跟着存档走
  assert.ok(text.includes('只影响这台设备'), '要说清这些设置不进存档');
});

check('手机设置里多出「对局中」：迷雾开关和联机入口', () => {
  /*
   * 2026-11-11：360px 宽的顶栏放不下「联机」「迷雾」两颗按钮，
   * 结果是「设置」被挤出屏幕。按频率分层后，这两颗只在手机上搬进设置——
   * 桌面顶栏本来就有，所以 compact 不传时**不能**重复出现（两处状态两条路径）。
   */
  const phone = settingsHtml({
    theme: 'legacy',
    reducedMotion: false,
    chime: 0.6,
    chimeText: '铃声 60%',
    compact: true,
    fog: true,
    roomCode: null,
  });
  assert.ok(phone.includes('data-act="toggle-fog"'), '手机设置里要有迷雾开关');
  assert.ok(phone.includes('data-act="online"'), '手机设置里要有联机入口');
  assert.ok(/class="chip active" data-act="toggle-fog"/.test(phone), '迷雾开着时开关要高亮');
  assert.ok(phone.includes('联机'), '要有「联机」这两个字，不能只有一个图标');

  // 桌面版：不传 compact 就不该出现这一组
  const desktop = settingsHtml({
    theme: 'legacy',
    reducedMotion: false,
    chime: 0.6,
    chimeText: '铃声 60%',
  });
  assert.equal(
    desktop.includes('data-act="toggle-fog"'),
    false,
    '桌面顶栏本来就有迷雾按钮，设置里不该再放一份',
  );

  // 房间码：在房间里要写出来，不然玩家不知道该点「房间」还是「联机」
  const inRoom = settingsHtml({
    theme: 'legacy',
    reducedMotion: false,
    chime: 0.6,
    chimeText: '铃声 60%',
    compact: true,
    fog: false,
    roomCode: 'AB12CD',
  });
  assert.ok(inRoom.includes('AB12CD'), '房间里要显示房间码');
  assert.ok(inRoom.includes('当前房间'), '要说清这是当前房间');
});

check('主题开关：只改 html 上的两个属性，回退就是删掉它们', () => {
  /*
   * 2026-11-10 UI 重构的第一层。这条守的是**机制**而不是长相：
   *   · legacy / modern 由 `<html data-ui>` 决定，CSS 里只有一个变量块；
   *   · 回退 = 删属性（或 `__ui('legacy')`），不需要重新加载、不碰任何规则；
   *   · 动效是第二根正交的轴（reduced 与主题可任意组合）。
   *
   * 长相在 jsdom 里验不了（没有布局、不算样式），所以这条只钉"属性写对了"。
   */
  const el = doc.createElement('html');

  const modern = applyUiTheme({ root: el, mode: 'modern', motion: 'reduced' });
  assert.deepEqual(modern, { mode: 'modern', motion: 'reduced' });
  assert.equal(el.dataset.ui, 'modern', '要落到 data-ui 上');
  assert.equal(el.dataset.motion, 'reduced', '动效是独立的一根轴');

  const back = applyUiTheme({ root: el, mode: 'legacy', motion: 'full' });
  assert.deepEqual(back, { mode: 'legacy', motion: 'full' });
  assert.equal(el.dataset.ui, 'legacy', '切回去只改这一个属性');
  assert.equal(el.dataset.motion, 'full');

  // 没传 mode 时按"URL > localStorage > legacy"解析；jsdom 的地址里没有 ?ui
  assert.equal(resolveUiMode(), 'legacy', '默认必须是旧版，不能把 modern 当默认');

  // 切换要**立刻**生效（记住偏好那一步写 localStorage，jsdom 默认源没有存储权限，
  // 所以这里只断言"当场生效"，持久化由 `applyUiTheme` 的 URL 分支兜着）
  setUiMode('modern', el);
  assert.equal(el.dataset.ui, 'modern', '切换后当场生效');
  setUiMode('legacy', el);
  assert.equal(el.dataset.ui, 'legacy', '切回来也当场生效');
});

check('上帝模式框选：矩形染色 + 工具栏报数 + 批量按钮都在', () => {
  /*
   * 2026-11-10 加的框选。这条守两件事：
   *   1. 棋盘认得选区（`.tile.god-sel`）——不然框完没有任何反馈；
   *   2. 工具栏把"框了多大、里面有几个人"写出来，并把批量按钮摆出来。
   *
   * 拖动本身（pointerdown/move/up）走的是 main.ts 的事件，jsdom 里没有布局、
   * `cellAtPoint` 算不出格子，所以那一段只能在真浏览器里验；
   * 这里守的是"数据 → 界面"这一半，规则那一半在 test:rules「框选批量」。
   */
  const host = doc.createElement('div');
  host.className = 'board';
  doc.body.appendChild(host);
  const st = createMatch({ ...DEFAULT_CONFIG, size: 12, startEra: 1, expansionIds: [] }, 606);
  const marked = [0, 1, 12, 13];
  renderBoard(host, playerView(st, 'A'), {
    selectedId: null,
    reach: [],
    targets: [],
    siegeTargets: [],
    selectedCityId: null,
    placeable: [],
    threat: [],
    marqueeTiles: marked,
  });
  try {
    assert.equal(
      host.querySelectorAll('.tile.god-sel').length,
      marked.length,
      '选区里的四格要打上 god-sel（一行的两格 + 下一行的两格）',
    );
  } finally {
    host.remove();
  }

  const bar = godBarHtml({
    state: st,
    side: 'A',
    brush: { kind: 'none' },
    pack: '',
    era: 0,
    cityEra: 1,
    selection: { w: 3, h: 2, cells: 6, units: 4 },
    running: false,
    round: 1,
    result: '',
    speed: 0,
    speedNames: ['慢', '快'],
    log: [],
    play: null,
    myTurn: true,
    passing: false,
    detail: '',
    query: '',
    quick: false,
  });
  const text = bar.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  assert.ok(text.includes('3×2'), `要写选区尺寸：${text.slice(0, 120)}`);
  assert.ok(text.includes('6 格'), '要写格数');
  assert.ok(text.includes('4 个单位'), '要写单位数');
  for (const act of ['god-batch-del', 'god-batch-terrain', 'god-batch-fill', 'god-shift', 'god-sel-clear']) {
    assert.ok(bar.includes(`data-act="${act}"`), `批量按钮缺了 ${act}`);
  }
  assert.ok(text.includes('删兵（4）'), '删兵按钮上要带数量——点之前就知道会动到几个');

  // 没有选区时这一块不该出现（工具栏保持原来的样子）
  const bare = godBarHtml({
    state: st,
    side: 'A',
    brush: { kind: 'none' },
    pack: '',
    era: 0,
    cityEra: 1,
    selection: null,
    running: false,
    round: 1,
    result: '',
    speed: 0,
    speedNames: ['慢', '快'],
    log: [],
    play: null,
    myTurn: true,
    passing: false,
    detail: '',
    query: '',
    quick: false,
  });
  assert.equal(bare.includes('god-batch-del'), false, '没选区就不该有批量按钮');
});

check('沙盒货架也能按扩展包切一刀', () => {
  // 直接渲染货架，不经过整局：验的是"分组口径"这一件事
  const st = createMatch(
    {
      size: 12,
      startEra: 4,
      aiOpponent: false,
      aiAlly: false,
      expansionIds: ['fantasy-core', 'fantasy-beasts'],
      enabledUnits: Object.keys(UNIT_TYPES),
      godMode: true,
    },
    77,
  );
  const shelf = (pack: string, era = 0) =>
    godShelfHtml({
      state: st,
      side: 'A',
      brush: { kind: 'none' },
      pack,
      era,
      cityEra: 1,
      selection: null,
      running: false,
      round: 1,
      result: '',
      speed: 1,
      speedNames: ['慢', '快', '极快'],
      log: [],
      play: null,
      myTurn: false,
      passing: false,
      detail: '',
      query: '',
      quick: false,
    });
  const picks = (html: string) => (html.match(/data-act="god-pick"/g) ?? []).length;

  const all = shelf('');
  assert.ok(all.includes('data-act="god-pack"'), '货架上该有一排按包筛选的 chip');
  assert.ok(all.includes('data-act="god-era"'), '货架上该有一排按时代筛选的 chip');
  assert.ok(picks(all) > 10, '全部那一档应该有一屏兵');

  const coreOnly = picks(shelf('core'));
  const packOnly = picks(shelf('fantasy'));
  assert.ok(coreOnly > 0, '原版那一档不该是空的');
  assert.ok(packOnly > 0, '奇想那一档不该是空的');
  assert.equal(coreOnly + packOnly, picks(all), '两档加起来应该正好等于全部（互斥且不重不漏）');

  // 时代这一维：单独用、和包叠用，结果都必须是"且"
  const eraLevels = Array.from(all.matchAll(/data-act="god-era" data-era="(\d+)"/g)).map((m) => Number(m[1]));
  const onlyEra = eraLevels.filter((l) => l > 0);
  assert.ok(onlyEra.length >= 2, `货架该列出这一屏真的出现的时代，实际 ${onlyEra.join(',')}`);
  const eraCounts = onlyEra.map((l) => picks(shelf('', l)));
  assert.equal(
    eraCounts.reduce((a, b) => a + b, 0),
    picks(all),
    '各时代加起来应该正好等于全部（一个兵只属于一个时代）',
  );
  // 叠用：包 + 时代，两个条件同时生效，不会比任何一边单独用更多
  const stack = picks(shelf('fantasy-beasts', onlyEra[onlyEra.length - 1]!));
  assert.ok(stack <= picks(shelf('fantasy-beasts')), '叠两个条件只会更少，不会更多');
  assert.ok(stack <= picks(shelf('', onlyEra[onlyEra.length - 1]!)), '叠两个条件只会更少，不会更多');
  // 「奇想·法则」是纯规则包，一个兵都不带：它不该占一个按下去筛掉 0 个按钮的 chip
  assert.ok(!all.includes('data-pack="fantasy-core"'), '不带兵的规则包不该出现在筛选栏');
});

check('沙盒里重绘不该把侧栏的滚动甩回顶端', () => {
  // 一场几十回合的仗打完，玩家正顺着战报往下读；收尾那一帧如果把
  // scrollTop 清零，他就得重新往下滚一遍才找得到刚才看到哪。
  const side = doc.querySelector<HTMLElement>('.side');
  assert.ok(side, '侧栏应该在');
  const click = (sel: string) =>
    doc.querySelector<HTMLElement>(sel)!.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

  side!.scrollTop = 180;
  click('[data-act="god-side"][data-side="B"]'); // 换一边摆＝一次整块重绘
  assert.equal(side!.scrollTop, 180, '重绘之后滚轮位置要留着');

  const log = doc.querySelector<HTMLElement>('.log');
  if (log) {
    log.scrollTop = 40;
    click('[data-act="god-side"][data-side="A"]');
    assert.equal(
      doc.querySelector<HTMLElement>('.log')?.scrollTop,
      40,
      '战报内层的滚动位置也要留着',
    );
  }
  click('[data-act="god-side"][data-side="A"]');
});

check('工具栏上能选 AI 速度，三档都在', () => {  // 沙盒要把几十回合一口气跑完，而"跑多快"因人而异：
  // 想看清每一步的人和只想看结果的人，不该被写死同一个档位
  const chips = Array.from(doc.querySelectorAll<HTMLElement>('[data-act="god-speed"]'));
  assert.equal(chips.length, 3, `应该是慢/快/极快三档，实际 ${chips.length} 档`);
  assert.deepEqual(
    chips.map((c) => c.textContent?.trim()),
    ['慢', '快', '极快'],
  );

  const fastest = doc.querySelector<HTMLElement>('[data-act="god-speed"][data-speed="2"]');
  assert.ok(fastest, '找不到极快那一档');
  fastest!.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  const after = doc.querySelector<HTMLElement>('[data-act="god-speed"][data-speed="2"]');
  assert.ok(after?.classList.contains('active'), '点了没选中');

  // 换回来，别把后面的用例拖进"极快"档
  doc
    .querySelector<HTMLElement>('[data-act="god-speed"][data-speed="1"]')!
    .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
});

check('侧栏多了「战报」，AI 刚才做了什么能读到', () => {
  // 两边都交给 AI 之后，棋盘上只剩结果：谁先动的手、技能开没开、蛋有没有留下，
  // 不给它说话的地方就只能靠猜。这张卡是沙盒唯一能读到过程的地方。
  const titles = Array.from(doc.querySelectorAll('.card-title')).map((e) => e.textContent ?? '');
  assert.ok(titles.includes('战报'), `侧栏应该有战报卡，实际有：${titles.join(' / ')}`);
  assert.ok(doc.querySelector('.log, .log-empty'), '战报区要么有记录，要么有占位提示');
});

check('选兵种→点棋盘就落子，不扣金币不推进回合', () => {
  const before = savedGame();
  // 挑一个陆地战斗单位：货架按造价排，第一个可能是船或农民
  const land = Object.values(before.unitTypes).find(
    (d) => d.domain !== 'water' && d.category === 'combat',
  );
  assert.ok(land, '本局应该有陆地战斗单位');

  const chip = doc.querySelector<HTMLElement>(`[data-act="god-pick"][data-unit="${land!.id}"]`);
  assert.ok(chip, '货架上找不到这个兵种');
  chip!.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

  // 找一格能站的空地：非水非山、没有城、没有单位
  let spot: { x: number; y: number } | null = null;
  for (let y = 0; y < before.h && !spot; y++) {
    for (let x = 0; x < before.w && !spot; x++) {
      const t = before.tiles[y * before.w + x];
      if (!t || t.terrain === 'water' || t.terrain === 'mountain' || t.cityId) continue;
      if (before.units.some((u) => u.x === x && u.y === y)) continue;
      spot = { x, y };
    }
  }
  assert.ok(spot, '棋盘上找不到空地');
  const cell = doc.querySelector<HTMLElement>(`.tile[data-x="${spot!.x}"][data-y="${spot!.y}"]`);
  assert.ok(cell, '找不到那一格');
  cell!.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

  const after = savedGame();
  const dropped = after.units.find((u) => u.x === spot!.x && u.y === spot!.y);
  assert.ok(dropped, '点了棋盘却没落子');
  assert.equal(dropped!.type, land!.id);
  assert.equal(dropped!.owner, 'A', '默认摆给红方');
  assert.equal(after.players.A!.gold, before.players.A!.gold, '沙盒里摆兵不该花钱');
});

check('换「城市」笔刷会把能放的 2×2 角点亮，点一格就盖起来', () => {
  click('[data-act="god-brush"][data-brush="city"]');
  const spots = doc.querySelectorAll('.tile.placeable');
  assert.ok(spots.length > 0, '应该有橙格提示哪里能放城');

  /*
   * 高亮 = "点下去一定建得成"，所以这里逐个试前几个橙格，**至少有一个能盖起来**。
   * 不钉死"第一个"：第一格取决于地图，换一版地形就会换位置，
   * 那不是在守契约，是在守某一张图。
   */
  const before = savedGame();
  let built = 0;
  for (const spot of Array.from(spots).slice(0, 6)) {
    const b = savedGame();
    (spot as HTMLElement).dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    if (savedGame().cities.length === b.cities.length + 1) {
      built += 1;
      break;
    }
  }
  const after = savedGame();
  assert.equal(built, 1, '点橙格应该真能盖出城来');
  assert.equal(after.cities.length, before.cities.length + 1, '城没盖起来');
});

check('点「交给 AI」立刻换成一整条"正在打"，按停止能收回', () => {
  click('[data-act="god-run-round"]');
  // runGodFight 在第一个 await 之前就 render 过了，所以这里是同步的
  assert.ok(doc.querySelector('[data-act="god-stop"]'), '点下去应该立刻进入"正在打"');
  click('[data-act="god-stop"]');
  assert.ok(doc.querySelector('[data-act="god-run-round"]'), '停止之后按钮要换回来');
  assert.ok((doc.querySelector('#commander')?.textContent ?? '').includes('已停止'));
});

/**
 * 不死鸟在沙盒里必须真的能复活一次。
 *
 * 守的是一条很容易漏掉的分支：`runGodFight` 的停止条件是"一方没有战斗单位"，
 * 而"打到全灭"下的那一方往往就是只剩一个不死鸟的情况。不死鸟倒下时不会立刻
 * 站起来——按规则它先在盘上消失，留下一枚蛋，等**下一回合轮到主人**才孵。
 * 中间这段时间盘上一个战斗单位都没有，只看 `units` 的话循环在蛋出现的那一瞬间
 * 就收工了，于是"复活"在这模式里永远等不到下一次轮到它。
 *
 * 用战报当证据而不是盯着棋盘：蛋孵化会写一条"蛋孵化了"，落在存档里，
 * 不用去赌"哪一帧能拍到刚站起来的凤凰"。
 *
 * 另开一页是因为这条要的是一盘只有一只 1 血凤凰的残局，
 * 而上面那些用例在同一个页面上已经摆了一堆东西。
 */
await checkAsync('不死鸟倒下不会让「打到全灭」提前收工：它还会孵出来', async () => {
  const st = createMatch(
    {
      ...DEFAULT_CONFIG,
      size: 12,
      godMode: true,
      expansionIds: ['fantasy-core', 'fantasy-heroes'],
    },
    20261026,
    {},
  );
  for (const t of st.tiles) {
    t.terrain = 'plain';
    t.cityId = null;
  }
  st.units = [];
  st.cities = [];

  const put = (owner: 'A' | 'B', type: string, x: number, y: number) => {
    const def = st.unitTypes[type];
    assert.ok(def, `本局没有 ${type}`);
    const u = {
      id: `g${st.units.length}`,
      type,
      owner,
      x,
      y,
      hp: def!.maxHp,
      kills: 0,
      moved: false,
      acted: false,
    };
    st.units.push(u);
    return u;
  };

  const phoenix = put('A', 'phoenix', 5, 5);
  phoenix.hp = 1; // 一刀就倒，省掉十几回合的对砍
  // 得用**带射程的地面兵**：地面打空中按距离 +1（见 rules 的 strikeDistance），
  // 九头蛇那种射程 1 的近战现在根本够不着凤凰，这个局面就永远开不了打。
  put('B', 'archer', 5, 4);
  st.current = 'B'; // 让 B 先动手：这样蛋是在 B 的回合里留下的

  const w = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', {
    url: 'http://localhost/',
    pretendToBeVisual: true,
    runScripts: 'outside-only',
  }).window;
  if (!w.structuredClone) {
    (w as unknown as { structuredClone: typeof structuredClone }).structuredClone = structuredClone;
  }
  w.localStorage.setItem('warchess:match:v1', JSON.stringify(st));
  w.eval(code);

  const d = w.document;
  const btn = d.querySelector<HTMLElement>('[data-act="god-run-dead"]');
  assert.ok(btn, '没有「打到全灭」按钮——工具栏没进上帝模式？');
  btn!.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));

  const texts = (): string[] => {
    const saved = JSON.parse(w.localStorage.getItem('warchess:match:v1') ?? '{}') as {
      log?: { text: string }[];
    };
    return (saved.log ?? []).map((e) => e.text);
  };

  const deadline = Date.now() + 10000;
  let hatched = false;
  while (Date.now() < deadline) {
    if (texts().some((t) => t.includes('蛋孵化了'))) {
      hatched = true;
      break;
    }
    await wait(50);
  }
  assert.ok(
    hatched,
    `10 秒内没等到蛋孵化，说明循环在蛋刚留下时就收了工。战报：${texts().slice(-6).join(' / ')}`,
  );
  assert.ok(
    texts().some((t) => t.includes('留下一枚蛋')),
    '战报里应该先有一条"留下一枚蛋"',
  );
});

console.log('\n沙盒：自己下场走两步');

/**
 * 上帝模式原本只有一条路：摆完，交给 AI。
 *
 * 想亲自试一手——"这个长弓手该不该退一格"、"这一枪要不要先手"——就只能把两边
 * 都交出去，试出来的是 AI 的水平，不是你的。所以加了「操控」这一档。
 *
 * 下面三条守的不是"能不能走"，而是两个更易碎的东西：
 * 摆放不能被操控抢走（手上捏着笔刷时点下去还是落子），
 * 以及回合交接不能被联机那套"把设备交给对方"接走。
 */
function godArena(seed: number) {
  const st = createMatch({ ...DEFAULT_CONFIG, size: 12, godMode: true, expansionIds: [] }, seed, {});
  for (const t of st.tiles) {
    t.terrain = 'plain';
    t.cityId = null;
  }
  st.units = [];
  st.cities = [];
  st.current = 'A';
  st.turn = 1;
  return st;
}

function godPut(
  st: ReturnType<typeof createMatch>,
  id: string,
  owner: 'A' | 'B',
  type: string,
  x: number,
  y: number,
) {
  const def = st.unitTypes[type];
  assert.ok(def, `本局没有 ${type}`);
  const u = { id, type, owner, x, y, hp: def!.maxHp, kills: 0, moved: false, acted: false };
  st.units.push(u);
  return u;
}

check('上帝模式：默认两边我都打，点棋盘是走子不是落子', () => {
  const st = godArena(424242);
  godPut(st, 'p1', 'A', 'militia', 3, 3);
  const w = bootWith(st);
  const d = w.document;
  const click = (sel: string) =>
    d.querySelector<HTMLElement>(sel)!.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  const saved = () =>
    JSON.parse(w.localStorage.getItem('warchess:match:v1')!) as {
      units: { id: string; x: number; y: number }[];
    };

  // 操控档的三颗 chip 已经撤掉：默认就是「两边我都打」，进来点棋盘就是走子。
  // 想歇手只有「交给 AI · 一回合」和「接管 · 打到全灭」两颗按钮。
  assert.equal(d.querySelector('[data-act="god-play"]'), null, '操控档 chip 已经撤掉');

  click('.unit[data-id="p1"]');
  assert.ok(
    d.querySelector('.unit[data-id="p1"]')?.classList.contains('selected'),
    '切到操控档之后，点自己的兵要能选中',
  );
  assert.ok(d.querySelectorAll('.tile.reach').length > 0, '选中之后棋盘上要画出可达格');
  // 沙盒现在有完整属性卡了（和亲自指挥同一份），侧栏上能读到名字与血量
  const side = d.querySelector('#side')?.textContent ?? '';
  assert.ok(side.includes('民兵'), `侧栏该报出选中的是谁，实际是「${side.slice(0, 80)}」`);
  // 属性卡里血量那一行的标题就是「生命」（和亲自指挥同一份），不是「血」
  assert.ok(side.includes('生命'), '属性卡里该有生命那一行');

  // 点可达格：走过去。不是"在那一格再落一个兵"——那是两件完全不同的事，
  // 而这一档的整个意义就在这个区别上。
  click('.tile[data-x="4"][data-y="3"]');
  const after = saved().units.find((u) => u.id === 'p1')!;
  assert.equal(after.x, 4, '点可达格应该把兵走过去');
  assert.equal(after.y, 3);
  assert.equal(saved().units.length, 1, '这是走子，不该顺手在那一格又落一个兵');
});

check('上帝模式：结束回合只把行动方翻过去，不叫 AI、不弹交接遮罩', () => {
  const st = godArena(424243);
  godPut(st, 'p1', 'A', 'militia', 3, 3);
  // 对面一个兵都不留：它走完一个空回合就会交还，整套交割是同步的，好断言
  const w = bootWith(st);
  const d = w.document;
  const click = (sel: string) =>
    d.querySelector<HTMLElement>(sel)!.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  const saved = () =>
    JSON.parse(w.localStorage.getItem('warchess:match:v1')!) as { current: string; turn: number };

  click('[data-act="god-end-turn"]');

  assert.equal(d.querySelector('#handoff'), null, '沙盒里不该出现「把设备交给对方」那张遮罩');
  assert.equal(saved().current, 'B', '两边都归你时，结束回合只是把行动方翻过去');
  assert.equal(saved().turn, 2, '只交割了一次：这一下不叫 AI');
});

check('上帝模式：手上捏着笔刷时，点棋盘仍然是落子', () => {
  const st = godArena(424244);
  godPut(st, 'p1', 'A', 'militia', 3, 3);
  const w = bootWith(st);
  const d = w.document;
  const click = (sel: string) =>
    d.querySelector<HTMLElement>(sel)!.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  const saved = () =>
    JSON.parse(w.localStorage.getItem('warchess:match:v1')!) as {
      units: { id: string; x: number; y: number }[];
    };

  // 从货架上挑一个兵种：笔刷一上手，"点棋盘"就该回到"再摆一个"
  click('[data-act="god-pick"][data-unit="militia"]');
  click('.tile[data-x="7"][data-y="7"]');

  const units = saved().units;
  assert.equal(units.length, 2, '笔刷在手时点棋盘还是落子，不能被操控档抢走');
  assert.ok(
    units.some((u) => u.x === 7 && u.y === 7),
    '新兵要落在点的那一格上',
  );
  assert.equal(units.find((u) => u.id === 'p1')!.x, 3, '原来那个兵不该被顺手挪走');
});

await checkAsync('上帝模式：「交给 AI · 一回合」只推一个回合，不是两个', async () => {
  // 这颗按钮的账必须和顶栏那个「第 N 回合」对得上：写着一回合，就走一回合。
  // 早先它推两方各一回合（`maxTurns = 2`），按一下回合数跳 2——按钮在撒谎。
  // 「我打一边、对面补一手」那一档现在没有界面入口了，但它和这里走的是同一条
  // 交割路径（godAfterTurn），所以用例从按钮走：用户真正会按的是这颗。
  // 交还失败的样子很难看：停在"轮到蓝方（AI）"、按钮全灰、谁也不动，
  // 而界面上没有任何东西会说"卡住了"。
  const st = godArena(424245);
  godPut(st, 'p1', 'A', 'militia', 2, 2);
  godPut(st, 'e1', 'B', 'militia', 5, 2);
  const w = bootWith(st);
  const d = w.document;
  const click = (sel: string) =>
    d.querySelector<HTMLElement>(sel)!.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  const saved = () =>
    JSON.parse(w.localStorage.getItem('warchess:match:v1')!) as { current: string; turn: number };

  const startTurn = saved().turn;
  // 「正在打」那条会把按钮换成"停止"，所以要等到它回来才算是真交还了
  const waitIdle = async () => {
    const until = Date.now() + 8000;
    while (Date.now() < until && !d.querySelector('[data-act="god-run-round"]')) await wait(25);
  };
  click('[data-act="god-run-round"]');

  const deadline = Date.now() + 8000;
  while (Date.now() < deadline && saved().turn <= startTurn) await wait(25);
  await waitIdle();

  assert.equal(saved().turn, startTurn + 1, `一次「一回合」只该加 1，实际 ${saved().turn - startTurn}`);
  assert.equal(saved().current, 'B', 'A 方走完就翻到 B，棋盘立刻交还');
  assert.equal(d.querySelector('#handoff'), null, '全程不该出现「把设备交给对方」');

  // 再按一次 = 另一方的这一回合。两下才是一整轮，这正是按钮名称的意思
  click('[data-act="god-run-round"]');
  const deadline2 = Date.now() + 8000;
  while (Date.now() < deadline2 && saved().turn <= startTurn + 1) await wait(25);
  await waitIdle();
  assert.equal(saved().turn, startTurn + 2, '第二次也只有 +1');
  assert.equal(saved().current, 'A', '两边各走一次之后轮回 A');
});

check('上帝模式：货架的按字搜索能筛兵，且框里的字不会被重绘吃掉', () => {
  const st = godArena(424247);
  godPut(st, 'p1', 'A', 'militia', 3, 3);
  const w = bootWith(st);
  const d = w.document;
  const picks = () => d.querySelectorAll('[data-act="god-pick"]').length;
  const input = () => d.querySelector<HTMLInputElement>('[data-act="god-search"]')!;

  const before = picks();
  assert.ok(before > 20, `货架上该有一屏兵，实际 ${before}`);

  // 直接往框里塞字再抛 input：这就是"敲字"在 jsdom 里等价的那一下
  const box = input();
  box.value = '民兵';
  box.dispatchEvent(new w.Event('input', { bubbles: true }));

  const after = picks();
  assert.ok(after < before, `搜"民兵"之后货架该变少，${before} → ${after}`);
  assert.ok(after >= 1, '搜"民兵"至少该剩下它自己');
  // 关键：重绘换掉了整个 input 元素，字必须被回填回来——这就是"输入变成空白/乱码"那个 bug
  assert.equal(input().value, '民兵', '重绘之后搜索框里的字必须还在');

  // 清空就回到全部
  const box2 = input();
  box2.value = '';
  box2.dispatchEvent(new w.Event('input', { bubbles: true }));
  assert.equal(picks(), before, '清掉搜索词之后该回到完整货架');
});

check('上帝模式：快捷模式打开后，空格结束回合；焦点在搜索框里时不抢空格', () => {
  const st = godArena(424248);
  godPut(st, 'p1', 'A', 'militia', 3, 3);
  godPut(st, 'e1', 'B', 'militia', 8, 8);
  const w = bootWith(st);
  const d = w.document;
  const saved = () =>
    JSON.parse(w.localStorage.getItem('warchess:match:v1')!) as { current: string; turn: number };
  const click = (sel: string) =>
    d.querySelector<HTMLElement>(sel)!.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  const space = (target: EventTarget) =>
    target.dispatchEvent(new w.KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true }));

  const t0 = saved().turn;

  // 默认是关的：按空格什么都不该发生（否则会在你打字时把回合交出去）
  space(d.body);
  assert.equal(saved().turn, t0, '快捷模式关着时，空格不该结束回合');

  click('[data-act="god-quick"]');
  assert.ok(
    d.querySelector('[data-act="god-quick"]')?.classList.contains('active'),
    '点一下之后开关该亮起来',
  );

  // 焦点在搜索框里：空格是"打一个空格"，绝不能结束回合
  const box = d.querySelector<HTMLInputElement>('[data-act="god-search"]')!;
  space(box);
  assert.equal(saved().turn, t0, '搜索框里按空格不该结束回合');

  // 焦点在棋盘/页面上：空格 = 结束回合
  space(d.body);
  assert.equal(saved().turn, t0 + 1, '打开快捷模式之后，空格该结束这一回合');
  assert.equal(saved().current, 'B', '结束之后行动方翻到对面');
});

check('上帝模式：两边我都打——结束回合不叫 AI，另一边自己接着走', () => {
  const st = godArena(424246);
  godPut(st, 'p1', 'A', 'militia', 2, 2);
  godPut(st, 'e1', 'B', 'militia', 8, 8);
  const w = bootWith(st);
  const d = w.document;
  const click = (sel: string) =>
    d.querySelector<HTMLElement>(sel)!.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  const saved = () =>
    JSON.parse(w.localStorage.getItem('warchess:match:v1')!) as {
      current: string;
      turn: number;
      units: { id: string; x: number; y: number }[];
    };

  click('[data-act="god-end-turn"]');

  // 关键：这一档不许把对面交给 AI。回合交割完就停在那儿，等你自己接着走。
  assert.equal(saved().current, 'B', '两边都归你时，结束回合只是把行动方翻过去');
  assert.equal(saved().turn, 2, '只交割了一次：这一下不叫 AI');

  // 对面那一方现在也归你：点它的兵要能选中、能走
  click('.unit[data-id="e1"]');
  assert.ok(
    d.querySelector('.unit[data-id="e1"]')?.classList.contains('selected'),
    '两边我都打时，另一边的兵也该能选中',
  );
  click('.tile[data-x="9"][data-y="8"]');
  const foe = saved().units.find((u) => u.id === 'e1')!;
  assert.equal(foe.x, 9, '另一边的兵也该走得动');
  assert.equal(foe.y, 8);
});

/**
 * 上帝模式下的技能。
 *
 * 这个模式的侧栏整块让给了货架，正常对局那张属性卡（含技能菜单）根本不存在。
 * 于是"选中英雄 → 按技能"这条路是断的：棋盘上连一个按钮都没有。
 * 这一条守着"补回来的那块卡"：切到操控档、点英雄、按技能，技能真进冷却。
 */
check('上帝模式：操控档里选中英雄，侧栏能开技能', () => {
  const st = createMatch(
    {
      ...DEFAULT_CONFIG,
      size: 12,
      startEra: 3,
      godMode: true,
      expansionIds: ['fantasy-core', 'fantasy-heroes'],
      enabledUnits: Object.keys(UNIT_TYPES),
    },
    424251,
    {},
  );
  for (const t of st.tiles) {
    t.terrain = 'plain';
    t.cityId = null;
  }
  st.units = [];
  st.cities = [];
  st.current = 'A';
  st.turn = 1;
  // 矮人王 + 一个三格内的敌人：投斧要有目标才值得开
  godPut(st, 'h1', 'A', 'dwarf-king', 3, 3);
  godPut(st, 'e1', 'B', 'militia', 5, 3);

  const w = bootWith(st);
  const d = w.document;
  const click = (sel: string) =>
    d.querySelector<HTMLElement>(sel)!.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  const saved = () =>
    JSON.parse(w.localStorage.getItem('warchess:match:v1')!) as {
      units: { id: string; skillCd?: Record<string, number>; heroBuff?: Record<string, unknown> }[];
    };

  // 还没选中任何东西时不该有技能按钮（属性卡整块都还没出现）
  assert.equal(d.querySelector('[data-act="hero-skill"]'), null, '没选中时不该有技能按钮');

  click('.unit[data-id="h1"]');

  const btn = d.querySelector<HTMLButtonElement>('[data-act="hero-skill"]');
  assert.ok(btn, '选中英雄，侧栏就该出现技能按钮');
  assert.equal(btn!.disabled, false, '冷却好了、轮到自己，就该能按');
  assert.ok(
    (d.querySelector('#side')?.textContent ?? '').includes('投斧'),
    '按钮上要写清是哪个技能',
  );

  btn!.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));

  const hero = saved().units.find((u) => u.id === 'h1')!;
  assert.equal(hero.skillCd?.['throw-axe'], 1, '按下去技能要真的进冷却');
  assert.ok(hero.heroBuff?.rangeMul === 0.6, '投斧的效果也得落到这个兵身上');

  // 开完之后按钮该灰掉并说明还要等几回合——不然玩家会以为没点中
  const after = d.querySelector<HTMLButtonElement>('[data-act="hero-skill"]');
  assert.ok(after, '按钮不该消失');
  assert.equal(after!.disabled, true, '冷却中就该是灰的');
  assert.ok((after!.textContent ?? '').includes('回合'), '要写清还要等几回合');
});

console.log('\n点敌人就是开火');

/**
 * 单开一页，把存档换成"两军贴脸"的局面，再照玩家的手速点两下。
 *
 * 守的是 onBoardClick 里的分支顺序。「点敌方单位出属性卡」那段一度排在
 * 攻击判断前面、而且无条件 return，于是选中部队后点敌人只弹一张属性卡，
 * 攻击这个核心动作在界面上等于消失了——规则内核好好的，界面自己把动作吞了。
 *
 * 属性卡不能被攻击抢走，反过来也不行：打不到的目标仍然只弹卡，
 * 所以这里同时验"能打到就开火"和"打不到就只看"。
 */
check('手操选中部队后点相邻敌人，真开火（不是弹属性卡）', () => {
  const st = createMatch({ ...DEFAULT_CONFIG }, 20261026, {});
  st.fog = false;
  st.current = 'A';

  // 挑一个真能打的兵：经济单位 atk 是 0，选中它不会有任何目标
  const mine = st.units.find((u) => u.owner === 'A' && (UNIT_TYPES[u.type]?.atk ?? 0) > 0);
  const foe = st.units.find((u) => u.owner === 'B');
  assert.ok(mine, 'A 方应该有能打的兵');
  assert.ok(foe, 'B 方应该有兵');

  // 把敌人挪到我身边一格：界内、没别的兵占着
  const free = (x: number, y: number): boolean =>
    x >= 0 && y >= 0 && x < st.w && y < st.h && !st.units.some((u) => u.x === x && u.y === y);
  const spot = [
    { x: mine.x + 1, y: mine.y },
    { x: mine.x - 1, y: mine.y },
    { x: mine.x, y: mine.y + 1 },
    { x: mine.x, y: mine.y - 1 },
  ].find((p) => free(p.x, p.y));
  assert.ok(spot, '找不到可以贴脸的邻格');
  foe.x = spot.x;
  foe.y = spot.y;
  // 有些地形不放人，抹平，别让"站不上去"混进这次判断
  st.tiles[foe.y * st.w + foe.x]!.terrain = 'plain';
  const hpBefore = foe.hp;

  const w = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', {
    url: 'http://localhost/',
    pretendToBeVisual: true,
    runScripts: 'outside-only',
  }).window;
  if (!w.structuredClone) {
    (w as unknown as { structuredClone: typeof structuredClone }).structuredClone = structuredClone;
  }
  w.localStorage.setItem('warchess:match:v1', JSON.stringify(st));
  w.eval(code);

  const d = w.document;
  const mineEl = d.querySelector<HTMLElement>(`.unit[data-id="${mine.id}"]`);
  assert.ok(mineEl, '我的兵没渲染出来');
  mineEl.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));

  const foeEl = d.querySelector<HTMLElement>(`.unit[data-id="${foe.id}"]`);
  assert.ok(foeEl, '敌人的兵没渲染出来——迷雾没关干净？');
  foeEl.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));

  // 以落盘的存档为准：图被重绘过，捏着旧节点看不出有没有真打
  const after = JSON.parse(w.localStorage.getItem('warchess:match:v1') ?? '{}') as {
    units: { id: string; hp: number }[];
  };
  const afterFoe = after.units.find((u) => u.id === foe.id);
  assert.ok(afterFoe, '敌人从盘上消失了');
  assert.ok(
    afterFoe.hp < hpBefore,
    `点了相邻敌人却没掉血：${hpBefore} → ${afterFoe.hp}，说明攻击被属性卡抢了`,
  );
});

check('打不到的敌人还是只弹属性卡，不会凭空开火', () => {
  // 同一条分支的另一半：距离之外点敌人应当出信息面板。
  // 只断言"没变成攻击"——面板文案由面板自己的测试守。
  const st = createMatch({ ...DEFAULT_CONFIG }, 20261026, {});
  st.fog = false;
  st.current = 'A';

  const mine = st.units.find((u) => u.owner === 'A' && (UNIT_TYPES[u.type]?.atk ?? 0) > 0);
  const foe = st.units.find((u) => u.owner === 'B');
  assert.ok(mine && foe);

  // 挪到一个明确打不到的位置：扫盘面找离我至少 4 格的空位，
  // 别用"镜像到对角"这种写法——小图上偶尔就只剩两格，反而贴了脸
  const free = (x: number, y: number): boolean =>
    !st.units.some((u) => u.x === x && u.y === y) && Math.abs(x - mine.x) + Math.abs(y - mine.y) >= 4;
  let far: { x: number; y: number } | null = null;
  for (let y = 0; y < st.h && !far; y++) {
    for (let x = 0; x < st.w && !far; x++) {
      if (free(x, y)) far = { x, y };
    }
  }
  assert.ok(far, '地图上找不到离我 4 格以上的空位');
  foe.x = far.x;
  foe.y = far.y;
  st.tiles[foe.y * st.w + foe.x]!.terrain = 'plain';
  const hpBefore = foe.hp;

  const w = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', {
    url: 'http://localhost/',
    pretendToBeVisual: true,
    runScripts: 'outside-only',
  }).window;
  if (!w.structuredClone) {
    (w as unknown as { structuredClone: typeof structuredClone }).structuredClone = structuredClone;
  }
  w.localStorage.setItem('warchess:match:v1', JSON.stringify(st));
  w.eval(code);

  const d = w.document;
  d.querySelector<HTMLElement>(`.unit[data-id="${mine.id}"]`)?.dispatchEvent(
    new w.MouseEvent('click', { bubbles: true }),
  );
  d.querySelector<HTMLElement>(`.unit[data-id="${foe.id}"]`)?.dispatchEvent(
    new w.MouseEvent('click', { bubbles: true }),
  );

  const after = JSON.parse(w.localStorage.getItem('warchess:match:v1') ?? '{}') as {
    units: { id: string; hp: number }[];
  };
  const afterFoe = after.units.find((u) => u.id === foe.id);
  assert.equal(afterFoe?.hp, hpBefore, '隔那么远不该开火');
});

console.log('\n规则书分册');

check('书单跟着已开的扩展走，核心规则书永远在', () => {
  assert.deepEqual(manualBooks([]).map((b) => b.file), ['manual.html'], '什么都没开就只有核心册');

  // 血战是默认开的：光这一条就够凑出一本小型扩展合订本
  const withBlood = manualBooks(DEFAULT_CONFIG.expansionIds);
  assert.deepEqual(withBlood.map((b) => b.file), ['manual.html', 'manual-small.html']);

  // 奇想已经是一个包：勾它就只多一本合册（旧 id 走别名，结果一样）
  const fantasy = manualBooks(['bloodbath', 'fantasy']);
  assert.deepEqual(fantasy.map((b) => b.file), [
    'manual.html',
    'manual-small.html',
    'manual-pack-fantasy.html',
  ]);
  assert.ok(
    (fantasy[2]!.note ?? '').includes('奇想'),
    '合册的说明要写清这一册收的是什么',
  );
  assert.deepEqual(
    manualBooks(['bloodbath', 'fantasy-core', 'fantasy-heroes']).map((b) => b.file),
    fantasy.map((b) => b.file),
    '旧的两个奇想 id 迁成一个之后，书单不该多出一本',
  );

  // 两个系列同时开：各出一本，不重复
  const both = manualBooks(['fantasy', 'era-arms']);
  assert.deepEqual(both.map((b) => b.file), [
    'manual.html',
    'manual-pack-fantasy.html',
    'manual-pack-eras.html',
  ]);
  assert.deepEqual(
    manualBooks(['fantasy-knights', 'pack-medieval', 'pack-modern']).map((b) => b.file),
    both.map((b) => b.file),
    '旧 id 组合也要落在同样的两本上',
  );

  // 不属于任何系列的包仍然各自一本
  const solo = manualBooks(['city-works', 'seasons']);
  assert.deepEqual(solo.map((b) => b.file), [
    'manual.html',
    'manual-pack-city-works.html',
    'manual-pack-seasons.html',
  ]);
});

check('点「规则书」：一本就直开，多本先问看哪本', () => {
  // 顶栏那个按钮原来是个写死 manual.html 的 <a>。拆册之后"开哪本"取决于
  // 本局开了什么扩展，所以它必须是动作而不是死链接。
  const opener = window.open;
  const opened: string[] = [];
  (window as unknown as { open: (u: string) => unknown }).open = (u: string) => {
    opened.push(u);
    return null;
  };
  try {
    // 当前对局是默认配置：核心册 + 小型合订本 = 两本，应该弹书单
    // 2026-11-11 起这条入口收在「设置」里，先开门再点书
    click('[data-act="settings"]');
    click('[data-act="manual"]');
    const rows = Array.from(doc.querySelectorAll<HTMLElement>('.book-row'));
    assert.equal(rows.length, 2, `默认配置应该有两本书可选，实际 ${rows.length}`);
    assert.ok((rows[0]!.textContent ?? '').includes('核心规则书'));
    assert.ok((rows[1]!.textContent ?? '').includes('小型'), '第二本应该是小型扩展合订本');

    rows[1]!.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    assert.deepEqual(opened, ['./manual-small.html'], '点书名应该打开对应分册');
    assert.equal(doc.querySelector('.book-row'), null, '选完书单要收起来');
  } finally {
    window.open = opener;
  }
});

console.log('\n启动兜底');

/**
 * 存档坏了，页面也不许白屏。
 *
 * 线上出过一次：有人带着一份对不上的存档进来，`render()` 给棋子查兵种时
 * `utype` 直接 throw，启动整段中断——页面上一个字都没有。玩家看到的是纯白，
 * 既没有错误也没有按钮，只能反复刷新，刷多少次都一样。
 *
 * 现在规定：抛错就换一局新的把人放进去，并且把错误显示在页面上。
 */
check('存档里有一条对不上的兵种，页面仍然能起来（不白屏）', () => {
  const st = createMatch({ ...DEFAULT_CONFIG }, 20261026, {});
  // 塞一个兵种表里根本不存在的棋子——这就是"脏存档"最典型的形态
  st.units.push({
    ...structuredClone(st.units[0]!),
    id: 'ghost-unit',
    type: 'no-such-unit-type',
    owner: 'A',
  });

  const w = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', {
    url: 'http://localhost/',
    pretendToBeVisual: true,
    runScripts: 'outside-only',
  }).window;
  if (!w.structuredClone) {
    (w as unknown as { structuredClone: typeof structuredClone }).structuredClone = structuredClone;
  }
  w.localStorage.setItem('warchess:match:v1', JSON.stringify(st));

  let thrown: unknown = null;
  try {
    w.eval(code);
  } catch (err) {
    thrown = err;
  }

  assert.equal(thrown, null, `启动不该把异常抛到顶层：${thrown instanceof Error ? thrown.message : ''}`);
  const tiles = w.document.querySelectorAll('.tile').length;
  assert.ok(tiles > 0, '棋盘必须画出来——白屏就是这次要修的东西');

  // 能修的就不该整个丢掉：脏棋子摘掉，剩下的照常打
  const saved = JSON.parse(w.localStorage.getItem('warchess:match:v1') ?? '{}') as {
    units: { id: string; type: string }[];
  };
  assert.equal(
    saved.units.some((u) => u.id === 'ghost-unit' || u.type === 'no-such-unit-type'),
    false,
    '不该把不认识的棋子写回存档',
  );
  assert.ok(
    saved.units.length > 0,
    '除了那条脏数据，别的棋子都要留着——为一条坏记录丢掉整局代价太大',
  );
});

check('地址栏带 ?fresh=1 能清掉本机存档重开', () => {
  const w = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', {
    url: 'http://localhost/?fresh=1',
    pretendToBeVisual: true,
    runScripts: 'outside-only',
  }).window;
  if (!w.structuredClone) {
    (w as unknown as { structuredClone: typeof structuredClone }).structuredClone = structuredClone;
  }
  const st = createMatch({ ...DEFAULT_CONFIG }, 20261026, {});
  // 20×20 的存档，重开之后应该回到默认的 12×12
  st.w = 20;
  st.h = 20;
  w.localStorage.setItem('warchess:match:v1', JSON.stringify(st));
  w.eval(code);
  assert.equal(
    w.document.querySelectorAll('.tile').length,
    DEFAULT_CONFIG.size * DEFAULT_CONFIG.size,
    '带 fresh=1 时不该沿用旧存档',
  );
});

check('城郭与物料：HUD 显示粮和材，建造清单写明施工回合与驻军', () => {
  const st = createMatch(
    {
      size: 12,
      startEra: 2,
      aiOpponent: false,
      aiAlly: false,
      expansionIds: ['city-works'],
      enabledUnits: Object.keys(UNIT_TYPES),
    },
    5150,
  );
  st.current = 'A';
  const city = st.cities.find((c) => c.owner === 'A');
  assert.ok(city, '应该有己方城市');
  const cs = st.config.citySize ?? 2;
  assert.equal(cs, 3, '这个扩展把主城扩成 3×3');

  const builder: Unit = {
    id: 'cw-builder',
    type: 'laborer',
    owner: 'A',
    x: (city as { x: number }).x + cs,
    y: (city as { y: number }).y,
    hp: 20,
    kills: 0,
    moved: false,
    acted: false,
  };
  st.units.push(builder);

  const host = doc.createElement('div');
  renderPanel(host, {
    view: playerView(st, 'A'),
    me: 'A',
    selectedUnit: builder,
    selectedCityId: null,
    selectedCampId: null,
    selectedTile: null,
  });
  const html = host.innerHTML;

  // 资源行：金币之外还有粮和材，而且写的是余额
  // 余额取真实值，别写死：起步资源是按时代给的
  const food = st.players.A.res?.food ?? 0;
  const material = st.players.A.res?.material ?? 0;
  assert.ok(food > 0 && html.includes(`粮 ${food}`), `HUD 要显示粮食余额 ${food}`);
  assert.ok(material > 0 && html.includes(`材 ${material}`), 'HUD 要显示建材余额');

  // 建造清单：塔要两回合、能驻军——这两条不写在按钮上，玩家第一回合就会以为它坏了
  assert.ok(html.includes('施工 2 回合'), '建造按钮要写明施工回合');
  assert.ok(html.includes('可驻军'), '塔要写明可以驻军');
  // 造价必须是"金币 + 建材"，只写一个数字等于骗人
  const towerBtn = host.querySelector('[data-act="build"][data-type="tower"]');
  assert.ok(towerBtn, '建造清单里应该有箭塔');
  const priceText = towerBtn.querySelector('.price')?.textContent ?? '';
  assert.ok(priceText.includes('金') && priceText.includes('材'), `箭塔造价要拆成金+材：${priceText}`);
});

console.log('\n强制键');

/** 用一份现成存档起一个新页面：这类用例需要精确摆位，不能靠随机开局 */
function bootWith(st: unknown) {
  const w = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', {
    url: 'http://localhost/',
    pretendToBeVisual: true,
    runScripts: 'outside-only',
  }).window;
  if (!w.structuredClone) {
    (w as unknown as { structuredClone: typeof structuredClone }).structuredClone = structuredClone;
  }
  w.localStorage.setItem('warchess:match:v1', JSON.stringify(st));
  w.eval(code);
  return w;
}

check('强制移动：Alt 点自家建筑那一格是"走上去"，不是"选中它"', () => {
  // 这是"走不上桥"的同一个问题：桥/塔都是一枚建筑棋子，画在格子上面，
  // 直接点永远是选中它。强制移动键把"我要走"这件事明确说出来。
  const st = createMatch({ ...DEFAULT_CONFIG }, 20261026, {});
  st.fog = false;
  st.current = 'A';
  const me = st.units.find((u) => u.owner === 'A' && (UNIT_TYPES[u.type]?.atk ?? 0) > 0)!;

  const spot = [
    { x: me.x + 1, y: me.y },
    { x: me.x - 1, y: me.y },
    { x: me.x, y: me.y + 1 },
    { x: me.x, y: me.y - 1 },
  ].find(
    (p) =>
      p.x >= 0 && p.y >= 0 && p.x < st.w && p.y < st.h &&
      !st.units.some((u) => u.x === p.x && u.y === p.y),
  )!;
  st.tiles[spot.y * st.w + spot.x]!.terrain = 'plain';
  st.units.push({
    id: 'tower-x', type: 'tower', owner: 'A',
    x: spot.x, y: spot.y, hp: st.unitTypes.tower!.maxHp, kills: 0, moved: true, acted: true,
  });

  const w = bootWith(st);
  const d = w.document;
  const clickUnit = () =>
    d.querySelector<HTMLElement>(`.unit[data-id="${me.id}"]`)!.dispatchEvent(
      new w.MouseEvent('click', { bubbles: true }),
    );
  const clickTower = (opts: MouseEventInit) =>
    d.querySelector<HTMLElement>('.unit[data-id="tower-x"]')!.dispatchEvent(
      new w.MouseEvent('click', { bubbles: true, ...opts }),
    );
  const posOf = (id: string) => {
    const st2 = JSON.parse(w.localStorage.getItem('warchess:match:v1')!) as {
      units: { id: string; x: number; y: number }[];
    };
    return st2.units.find((u) => u.id === id)!;
  };

  // 对照组：不按修饰键，点塔就是"选中塔"，人不动——这正是要解决的问题
  clickUnit();
  clickTower({});
  const still = posOf(me.id);
  assert.notEqual(still.x === spot.x && still.y === spot.y, true, '不按 Alt 时不该走过去');

  // 实验组：按住 Alt，同一格变成"走上去"
  clickUnit();
  clickTower({ altKey: true });
  const moved = posOf(me.id);
  assert.equal(moved.x, spot.x, '按 Alt 点塔那一格应该走上去');
  assert.equal(moved.y, spot.y);
});

check('强制攻击：Shift 点敌人照样是开火，没有把攻击路径弄坏', () => {
  const st = createMatch({ ...DEFAULT_CONFIG }, 20261026, {});
  st.fog = false;
  st.current = 'A';
  const me = st.units.find((u) => u.owner === 'A' && (UNIT_TYPES[u.type]?.atk ?? 0) > 0)!;
  const foe = st.units.find((u) => u.owner === 'B')!;

  const spot = [
    { x: me.x + 1, y: me.y },
    { x: me.x - 1, y: me.y },
    { x: me.x, y: me.y + 1 },
    { x: me.x, y: me.y - 1 },
  ].find(
    (p) =>
      p.x >= 0 && p.y >= 0 && p.x < st.w && p.y < st.h &&
      !st.units.some((u) => u.x === p.x && u.y === p.y),
  )!;
  st.tiles[spot.y * st.w + spot.x]!.terrain = 'plain';
  foe.x = spot.x;
  foe.y = spot.y;
  const hpBefore = foe.hp;

  const w = bootWith(st);
  const d = w.document;
  d.querySelector<HTMLElement>(`.unit[data-id="${me.id}"]`)!.dispatchEvent(
    new w.MouseEvent('click', { bubbles: true }),
  );
  d.querySelector<HTMLElement>(`.unit[data-id="${foe.id}"]`)!.dispatchEvent(
    new w.MouseEvent('click', { bubbles: true, shiftKey: true }),
  );

  const after = JSON.parse(w.localStorage.getItem('warchess:match:v1')!) as {
    units: { id: string; hp: number }[];
  };
  const hurt = after.units.find((u) => u.id === foe.id)!;
  assert.ok(hurt.hp < hpBefore, `Shift 点敌人应该开火：${hpBefore} → ${hurt.hp}`);
});

/**
 * 找一块 n×m 的干净空地（无城、无单位），顺手抹成平原。
 *
 * 强制模式这一类用例问的是"点这儿会发生什么"，随机开局里的河、山、城
 * 会悄悄改掉答案——那样挂掉的时候没人分得清是功能坏了还是地图不合适。
 */
function freeBlock(st: ReturnType<typeof createMatch>, n: number, m: number) {
  for (let y = 1; y + m < st.h - 1; y++) {
    for (let x = 1; x + n < st.w - 1; x++) {
      let ok = true;
      for (let dy = 0; dy < m && ok; dy++) {
        for (let dx = 0; dx < n && ok; dx++) {
          const t = st.tiles[(y + dy) * st.w + (x + dx)];
          if (!t || t.cityId) ok = false;
          else if (st.units.some((u) => u.x === x + dx && u.y === y + dy)) ok = false;
        }
      }
      if (!ok) continue;
      for (let dy = 0; dy < m; dy++) {
        for (let dx = 0; dx < n; dx++) {
          const t = st.tiles[(y + dy) * st.w + (x + dx)]!;
          t.terrain = 'plain';
          t.cityId = null;
        }
      }
      return { x, y };
    }
  }
  throw new Error('找不到一块干净的空地');
}

/** 校验用的"盘上坐标"：直接读存档，等同于读 state */
function posIn(w: ReturnType<typeof bootWith>, id: string) {
  const saved = JSON.parse(w.localStorage.getItem('warchess:match:v1')!) as {
    units: { id: string; x: number; y: number }[];
  };
  return saved.units.find((u) => u.id === id)!;
}

check('强制移动按钮：点一下就一直扣着，期间点别的兵抢不走选中', () => {
  // 旧语义是"给下一次点击上膛，点完就卸下"：第二下点击已经回到普通语义，
  // 点到的若是另一个兵，手上的兵就被换掉了——强制移动还没做完就被自己打断。
  const st = createMatch({ ...DEFAULT_CONFIG }, 20261026, {});
  st.fog = false;
  st.current = 'A';
  const spot = freeBlock(st, 2, 2);

  const movable = st.units.filter(
    (u) =>
      u.owner === 'A' &&
      UNIT_TYPES[u.type]?.category !== 'building' &&
      UNIT_TYPES[u.type]?.domain !== 'water',
  );
  const me = movable[0]!;
  const ally = movable[1] ?? movable[0]!;
  me.x = spot.x;
  me.y = spot.y;
  me.moved = false;
  me.acted = false;
  // 友军站在隔壁那一格：它既是"诱惑"（点它会被选中），也挡住直线
  ally.x = spot.x + 1;
  ally.y = spot.y;
  ally.moved = true;
  ally.acted = true;

  const w = bootWith(st);
  const d = w.document;
  const clickUnit = (id: string) =>
    d.querySelector<HTMLElement>(`.unit[data-id="${id}"]`)!.dispatchEvent(
      new w.MouseEvent('click', { bubbles: true }),
    );
  const clickTile = (x: number, y: number) =>
    d.querySelector<HTMLElement>(`.tile[data-x="${x}"][data-y="${y}"]`)!.dispatchEvent(
      new w.MouseEvent('click', { bubbles: true }),
    );
  const pressForce = () =>
    d.querySelector<HTMLElement>('[data-act="force-move"]')!.dispatchEvent(
      new w.MouseEvent('click', { bubbles: true }),
    );
  const armed = () => Boolean(d.querySelector('.force-btn.armed[data-act="force-move"]'));
  const heading = () => d.querySelector<HTMLElement>('#force-flag')!;

  clickUnit(me.id);
  pressForce();
  assert.ok(armed(), '点一下按钮就该扣住');
  assert.equal(heading().hidden, false, '模式开着的时候棋盘上要一直挂着横幅');

  // 反例：模式扣住时点隔壁的友军——既不能被选中，也不能把手上这个兵换掉
  clickUnit(ally.id);
  assert.equal(
    d.querySelector<HTMLElement>(`.unit[data-id="${ally.id}"]`)!.classList.contains('selected'),
    false,
    '模式扣住时点别的兵不该选中它',
  );
  assert.ok(
    d.querySelector<HTMLElement>(`.unit[data-id="${me.id}"]`)!.classList.contains('selected'),
    '选中还应该留在原来那个兵身上',
  );
  assert.equal(posIn(w, me.id).x, spot.x, '点友军那一下不该把人挪走');

  // 再点可达格：按"走上去"解释，而且模式不卸下
  const target = { x: spot.x, y: spot.y + 1 };
  assert.equal(st.tiles[target.y * st.w + target.x]!.terrain, 'plain');
  clickTile(target.x, target.y);
  const after = posIn(w, me.id);
  assert.equal(after.x, target.x, '强制移动下点可达格要直接走过去');
  assert.equal(after.y, target.y);
  assert.ok(armed(), '走完一步模式仍然扣着，要再点一次按钮才退出');

  // 再点同一个按钮 → 退出
  d.querySelector<HTMLElement>('[data-act="force-move"]')!.dispatchEvent(
    new w.MouseEvent('click', { bubbles: true }),
  );
  assert.equal(armed(), false, '再点一次按钮要退出强制模式');
  assert.equal(heading().hidden, true, '退出之后横幅要收起来');
});

check('强制移动：飞行单位点敌人那格是"飞过去"，不是选中也不是开火', () => {
  // 飞行单位停在敌人头顶是常态（分层允许共格），所以它脚下那格永远压着人。
  // 模式扣住时这一下必须按"飞过去"解释——既不能被"选中敌人"截走，
  // 也不能被"这里有敌人所以先开火"截走。这就是"严格遵循强制移动"。
  const st = createMatch(
    { ...DEFAULT_CONFIG, expansionIds: ['fantasy-core', 'fantasy-beasts'] } as never,
    20261026,
    {},
  );
  st.fog = false;
  st.current = 'A';
  const spot = freeBlock(st, 2, 2);

  const flyerDef = Object.values(st.unitTypes).find(
    (def) => def.category !== 'building' && (def.layer === 'air' || def.flight === true),
  );
  assert.ok(flyerDef, '扩展里应该有飞行兵种');

  const me = st.units.find((u) => u.owner === 'A')!;
  me.type = flyerDef!.id;
  me.hp = flyerDef!.maxHp;
  me.x = spot.x;
  me.y = spot.y;
  me.moved = false;
  me.acted = false;

  const foe = st.units.find((u) => u.owner === 'B')!;
  foe.x = spot.x + 1;
  foe.y = spot.y;
  foe.hp = st.unitTypes[foe.type]!.maxHp;
  const foeHp = foe.hp;

  const w = bootWith(st);
  const d = w.document;
  const clickUnit = (id: string) =>
    d.querySelector<HTMLElement>(`.unit[data-id="${id}"]`)!.dispatchEvent(
      new w.MouseEvent('click', { bubbles: true }),
    );

  clickUnit(me.id);
  d.querySelector<HTMLElement>('[data-act="force-move"]')!.dispatchEvent(
    new w.MouseEvent('click', { bubbles: true }),
  );

  // 点贴在旁边的敌人：按"飞过去"解释（空中层可以和地面共格）
  clickUnit(foe.id);
  const after = posIn(w, me.id);
  assert.equal(after.x, spot.x + 1, '强制移动下点敌人那格，飞行单位要飞过去');
  assert.equal(after.y, spot.y);
  assert.equal(
    d.querySelector<HTMLElement>(`.unit[data-id="${foe.id}"]`)!.classList.contains('selected'),
    false,
    '这一下不该顺手把敌人选中',
  );
  assert.ok(
    d.querySelector<HTMLElement>(`.unit[data-id="${me.id}"]`)!.classList.contains('selected'),
    '飞行单位仍然被选中，模式没被打断',
  );

  const hurt = (JSON.parse(w.localStorage.getItem('warchess:match:v1')!) as {
    units: { id: string; hp: number }[];
  }).units.find((u) => u.id === foe.id)!;
  assert.equal(hurt.hp, foeHp, '强制移动期间点敌人是"飞过去"，不是开火');
  assert.ok(
    d.querySelector<HTMLElement>('.force-btn.armed[data-act="force-move"]'),
    '走完之后模式仍然扣着',
  );
});

check('点桥面是"走上桥"，不是"选中这座桥"', () => {
  // 桥在数据上是一枚建筑棋子，所以直接点永远是选中桥——修好了却只能穿过去，
  // 守桥、堵口、在桥中间换气全都点不出来。这一格既然可达，"走上去"要赢。
  const st = createMatch({ ...DEFAULT_CONFIG }, 20261026, {});
  st.fog = false;
  st.current = 'A';
  const spot = freeBlock(st, 2, 1);
  assert.ok(st.unitTypes.bridge, '应该有桥这个兵种');

  const me = st.units.find(
    (u) =>
      u.owner === 'A' &&
      UNIT_TYPES[u.type]?.category !== 'building' &&
      UNIT_TYPES[u.type]?.domain !== 'water',
  )!;
  me.x = spot.x;
  me.y = spot.y;
  me.moved = false;
  me.acted = false;

  const bx = spot.x + 1;
  const by = spot.y;
  const tile = st.tiles[by * st.w + bx]!;
  tile.terrain = 'bridge';
  tile.cityId = null;
  st.units.push({
    id: 'bridge-x',
    type: 'bridge',
    owner: 'A',
    x: bx,
    y: by,
    hp: st.unitTypes.bridge!.maxHp,
    kills: 0,
    moved: true,
    acted: true,
  });

  const w = bootWith(st);
  const d = w.document;
  const clickUnit = (id: string) =>
    d.querySelector<HTMLElement>(`.unit[data-id="${id}"]`)!.dispatchEvent(
      new w.MouseEvent('click', { bubbles: true }),
    );

  clickUnit(me.id);
  clickUnit('bridge-x');

  const after = posIn(w, me.id);
  assert.equal(after.x, bx, '点桥面应该走上桥');
  assert.equal(after.y, by);
  assert.equal(
    d.querySelector<HTMLElement>('.unit[data-id="bridge-x"]')!.classList.contains('selected'),
    false,
    '走上桥这一下不该顺带把桥选中',
  );
});

console.log('\n天气标识');

/** 造一局开了天气的棋，把某个单位摆到一块确定的平原上 */
function weatherScene(turn: number, withSeasons = true) {
  const st = createMatch(
    { ...DEFAULT_CONFIG, ...(withSeasons ? { expansionIds: ['seasons'] } : {}) } as never,
    20261026,
    {},
  );
  st.fog = false;
  st.current = 'A';
  st.turn = turn;
  for (const t of st.tiles) t.terrain = 'plain';
  for (const c of st.cities) {
    // 城市所在格保持城市地形（城市不吃天气，正好用来做反例）
    for (let dy = 0; dy < c.size; dy++) {
      for (let dx = 0; dx < c.size; dx++) {
        st.tiles[(c.y + dy) * st.w + (c.x + dx)]!.terrain = 'city';
      }
    }
  }
  const me = st.units.find((u) => u.owner === 'A' && (UNIT_TYPES[u.type]?.atk ?? 0) > 0)!;
  // 挪到一块干净的平原
  me.x = 2;
  me.y = 2;
  me.moved = false;
  me.acted = false;
  st.tiles[2 * st.w + 2]!.terrain = 'plain';
  st.tiles[2 * st.w + 2]!.cityId = null;
  return { st, me };
}

check('天气标识：选中单位时显示脚下天气和逐条效果', () => {
  const { st, me } = weatherScene(15); // 夏天
  const w = bootWith(st);
  const d = w.document;
  d.querySelector<HTMLElement>(`.unit[data-id="${me.id}"]`)!.dispatchEvent(
    new w.MouseEvent('click', { bubbles: true }),
  );
  const side = d.querySelector('.side')!.innerHTML;

  assert.ok(side.includes('weather-badge'), '侧栏要有天气徽标');
  assert.ok(side.includes('酷暑'), '平原·内陆·夏 = 酷暑，徽标要写出来');
  // 效果是逐条列出来的，不是一句"有影响"
  assert.ok(side.includes('移动力 −50%'), `要写清移动力怎么变：${side.slice(0, 0)}`);
  assert.ok(side.includes('护甲 −2'), '也要写清护甲');
});

check('天气标识：换季之后徽标和效果一起更新', () => {
  const summer = weatherScene(15);
  const w1 = bootWith(summer.st);
  w1.document
    .querySelector<HTMLElement>(`.unit[data-id="${summer.me.id}"]`)!
    .dispatchEvent(new w1.MouseEvent('click', { bubbles: true }));
  const summerHtml = w1.document.querySelector('.side')!.innerHTML;
  assert.ok(summerHtml.includes('酷暑'), '夏天该是酷暑');

  const winter = weatherScene(35); // 同一格、同一单位，只换季节
  const w2 = bootWith(winter.st);
  w2.document
    .querySelector<HTMLElement>(`.unit[data-id="${winter.me.id}"]`)!
    .dispatchEvent(new w2.MouseEvent('click', { bubbles: true }));
  const winterHtml = w2.document.querySelector('.side')!.innerHTML;
  assert.ok(winterHtml.includes('寒冷'), '冬天该是寒冷');
  assert.ok(!winterHtml.includes('酷暑'), '换季之后不该还留着上一个季节的天气');
});

check('天气标识：顶栏的季节徽章跟着回合走', () => {
  // 季节以前是核心写死的 `TopbarState.season` + `data-ref="season"`；
  // 现在它是扩展的一枚常驻徽章（`topbarBadges` 钩子），核心只认"一段文字"。
  const spring = weatherScene(5);
  const w = bootWith(spring.st);
  const badge = w.document.querySelector('.topbar-badge') as HTMLElement | null;
  assert.ok(badge, '顶栏要有季节徽章（由扩展提供）');
  assert.ok(badge.textContent?.includes('春'), `第 5 回合是春：${badge.textContent}`);

  const winter = weatherScene(35);
  const w2 = bootWith(winter.st);
  const badge2 = w2.document.querySelector('.topbar-badge');
  assert.ok(badge2?.textContent?.includes('冬'), `第 35 回合是冬：${badge2?.textContent}`);
});

check('天气块：点单位时由扩展注入（核心不认识天气）', () => {
  // 天气块是 HTML（带按气候分色的徽标），走 `getTilePanelHtml` 钩子原样插入。
  // 这条钉住"钩子真的接上了"——以前它是 panel.ts 里直接 import 气候表拼出来的。
  const { st, me } = weatherScene(15);
  const w = bootWith(st);
  const d = w.document;
  d.querySelector<HTMLElement>(`.unit[data-id="${me.id}"]`)!.dispatchEvent(
    new w.MouseEvent('click', { bubbles: true }),
  );
  const side = d.querySelector('.side')!.innerHTML;
  assert.ok(side.includes('weather-badge'), '要有天气徽标');
  assert.ok(side.includes('脚下的天气'), '单位卡上的标题：按格算，不是我身上的状态');
  // class 选择器只能精确匹配，所以这里用正则找 `weather-badge w-xxx`
  assert.ok(/weather-badge w-[a-zA-Z]+/.test(side), '徽标要带气候 class，才能按天气上色');
});

check('没开「季节与气候」时，界面一点天气都不出现', () => {
  const { st, me } = weatherScene(15, false);
  const w = bootWith(st);
  const d = w.document;
  d.querySelector<HTMLElement>(`.unit[data-id="${me.id}"]`)!.dispatchEvent(
    new w.MouseEvent('click', { bubbles: true }),
  );
  const side = d.querySelector('.side')!.innerHTML;
  assert.ok(!side.includes('weather-badge'), '没开扩展就不该有天气徽标');
  assert.ok(!side.includes('这里的天气') && !side.includes('脚下的天气'), '连标题也不该留');

  // 常驻徽章那块整个是空的（CSS 的 :empty 会把它收起来）
  const box = d.querySelector('[data-ref="topbar-badges"]') as HTMLElement | null;
  assert.ok(!box || box.childElementCount === 0, '没开扩展就不该有常驻徽章');
});

console.log('\n对局数据上传');

check('结算卡：对局数据默认不上传，勾上才给传', () => {
  const st = createMatch({ ...DEFAULT_CONFIG }, 20261028, {});
  st.winner = 'A';
  st.players.A.name = '阿甲';
  st.players.B.name = '阿乙';

  const w = bootWith(st);
  const d = w.document;
  const card = d.querySelector('.report-card');
  assert.ok(card, '打完了就该出现「这局的数据要不要捐出来」');
  assert.ok(card!.textContent?.includes('要不要捐出来'), '标题要说人话，不要写成"遥测"');

  const box = card!.querySelector('input[data-act="report-opt"]') as HTMLInputElement | null;
  assert.ok(box, '该有一个"允许上传"的勾选框');
  assert.equal(box!.checked, false, '默认必须是关的——这件事不能替玩家决定');

  const upload = card!.querySelector('[data-act="report-upload"]') as HTMLButtonElement | null;
  assert.ok(upload, '该有一个上传按钮');
  assert.equal(upload!.disabled, true, '没勾之前上传按钮是灰的');

  const html = card!.innerHTML;
  assert.ok(html.includes('不含玩家名'), '要先把"不交什么"写在脸上');
  assert.ok(!html.includes('阿甲') && !html.includes('阿乙'), '上传卡里不能出现玩家名');
  assert.ok(html.includes('次行动'), '要写清这局打了多久，玩家才知道自己在捐什么');
  assert.ok(card!.querySelector('[data-act="report-copy"]'), '复制报告必须一直可用：传不上去也不能白打');
  assert.ok(card!.querySelector('[data-act="report-download"]'), '下载也一样');

  // 勾上：这个意愿要记住，按钮跟着活
  box!.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  assert.equal(w.localStorage.getItem('warchess.report.optin'), '1', '勾选状态应该存到本机，别每局都问一遍');
  const after = d.querySelector('[data-act="report-upload"]') as HTMLButtonElement | null;
  assert.equal(after?.disabled, false, '勾了就该能点上传');
});

check('结算卡：上传失败要说清是哪一步不对，并给下一步', () => {
  const host = doc.createElement('div');
  host.className = 'side';
  doc.body.appendChild(host);
  const st = createMatch({ ...DEFAULT_CONFIG, size: 12 }, 4711);
  st.winner = 'B';
  st.players.A.name = '阿甲';

  const base = {
    view: playerView(st, 'A'),
    me: 'A' as const,
    selectedUnit: null,
    selectedCityId: null,
    selectedCampId: null,
    selectedTile: null,
  };

  try {
    renderPanel(host, {
      ...base,
      report: {
        optedIn: true,
        status: 'failed',
        note: '收集端还没开通（云数据库里没有 warchess_reports 这张表）',
        howTo: '在云数据库里执行一次 sql/warchess_reports.sql 就能开始收',
      },
    });
    const why = host.querySelector('.report-status.failed');
    assert.ok(why, '失败要落到界面上，不能只在控制台里');
    assert.ok(why!.textContent?.includes('收集端还没开通'), `失败原因要原样说出来：${why!.textContent}`);
    const how = host.querySelector('.report-howto');
    assert.ok(how, '还得告诉玩家下一步做什么');
    assert.ok(how!.textContent?.includes('warchess_reports.sql'), '下一步要具体到文件');

    // 成功之后按钮变"已上传"，不能让人反复点
    renderPanel(host, { ...base, report: { optedIn: true, status: 'done' } });
    const done = host.querySelector('[data-act="report-upload"]') as HTMLButtonElement | null;
    assert.equal(done?.disabled, true, '传完了就别再让点');
    assert.ok(host.querySelector('.report-status.done'), '成功也要有一句回话');

    // 隐私说明必须说准三件事：会上传浏览器代号、不能单独撤回、可能用于训练模型
    renderPanel(host, { ...base, report: { optedIn: false, status: 'idle' } });
    const privacy = host.querySelector('.report-privacy')?.textContent ?? '';
    for (const must of ['随机浏览器代号', '无法单独撤回', '不关联任何账号']) {
      assert.ok(privacy.includes(must), `隐私说明必须写明「${must}」，实际是：${privacy.trim()}`);
    }
    const intro = host.querySelector('.report-card .hint')?.textContent ?? '';
    assert.ok(intro.includes('训练模型'), '用途里要写明可能用于训练模型，不能含糊带过');

    // 没打完就没有这一块
    renderPanel(host, base);
    assert.equal(host.querySelector('.report-card'), null, '对局还没打完不该冒出上传卡');
  } finally {
    host.remove();
  }
});

check('反馈：对局打到一半也能拍下现场（不必等打完）', () => {
  // 结算卡只在打完时出现，而 bug 恰恰出在"打不下去"的时候。
  // 这条守的是"入口一直在"和"隐私口径写在脸上"这两件事。
  const st = createMatch({ ...DEFAULT_CONFIG, size: 12 }, 20261102, {});
  st.players.A.name = '阿甲';
  st.players.B.name = '阿乙';
  st.turn = 9;

  const w = bootWith(st);
  const d = w.document;

  // 入口已经收进「设置」：打到一半也要两步点到（顶栏设置 → 反馈）
  const gear = d.querySelector<HTMLElement>('[data-act="settings"]');
  assert.ok(gear, '顶栏要一直有个「设置」入口');
  gear!.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));

  const btn = d.querySelector<HTMLElement>('[data-act="feedback"]');
  assert.ok(btn, '设置里要一直有个「反馈」入口');
  btn!.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));

  const modal = d.querySelector<HTMLElement>('.feedback-modal');
  assert.ok(modal, '点了就该弹出面板');
  assert.ok(modal!.querySelector<HTMLTextAreaElement>('[data-field="note"]'), '要能写一句"发生了什么"');
  assert.ok(modal!.querySelector('[data-act="upload"]'), '要有上传按钮');
  assert.ok(modal!.querySelector('[data-act="copy"]'), '传不上去时得能复制出来自己发');

  const text = modal!.textContent ?? '';
  assert.ok(text.includes('第 9 回合'), `面板上要显示拍的是哪一刻，实际：${text.slice(0, 80)}`);
  // 这一份带名字带坐标，和结算那份匿名数据是两张表：必须当面说清
  for (const must of ['完整局面', '位置', '玩家名', '坐标']) {
    assert.ok(text.includes(must), `隐私说明要写明「${must}」`);
  }
  assert.ok(!modal!.querySelector('.fb-privacy[hidden]'), '隐私说明不能折叠或藏起来');

  // 这一局没开「记录详细数据」：勾选框不该出现，而要说明为什么没有
  assert.equal(modal!.querySelector('[data-field="with-timeline"]'), null, '没有摘要就别给一个勾不动的框');
  assert.ok(text.includes('记录详细数据'), '要告诉玩家下次怎么才能带上曲线');

  modal!.querySelector<HTMLElement>('[data-act="close"]')!.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  assert.equal(d.querySelector('.feedback-modal'), null, '关闭要把面板收干净');
});


console.log('\n选卡模式');

const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

await checkAsync('开启选卡后开局：遮罩盖住战场，双方各禁一个才进入选人', async () => {
  openSetup();
  click('[data-draft-mode="on"]');
  const on = doc.querySelector<HTMLElement>('[data-draft-mode="on"]');
  assert.ok(on?.classList.contains('active'), '"开启选卡模式"要能选中');

  click('[data-act="start"]');
  await tick(60);

  const mask = doc.querySelector<HTMLElement>('#draft');
  assert.ok(mask, '应该有选卡遮罩节点');
  assert.equal(mask!.hidden, false, '选卡期间遮罩必须盖住棋盘');

  // 开局先停在"等待开局"：这一屏是建房/邀请的地方，不能直接进禁用
  assert.ok(
    (doc.querySelector('#draft .draft-step')?.textContent ?? '').includes('等待开局'),
    '开局应该先进等待开局，而不是直接开始禁用',
  );
  assert.ok(doc.querySelector('#draft [data-act="online"]'), '等待开局里要有"联机 · 建房 / 加入"的入口');
  assert.ok(doc.querySelector('#draft [data-draft-act="start"]'), '要有"开始选卡"按钮');
  assert.equal(doc.querySelector('#draft [data-draft]'), null, '等待开局里不该铺出兵种池');

  click('#draft [data-draft-act="start"]');
  await tick(60);
  assert.ok(
    (doc.querySelector('#draft .draft-step')?.textContent ?? '').includes('禁用'),
    '点了开始之后才进入禁用阶段',
  );

  const cards = () => [...doc.querySelectorAll<HTMLElement>('#draft [data-draft]')];
  // 一张卡对应池子里的一个真兵种：伪单位（攻城结算用的「城市」壳）一旦混进来，
  // 这里就会少一张——而少的那张在界面上是空白，玩家只会觉得"池子抽少了"。
  assert.equal(cards().length, 20, `原版池子应该铺满 20 张卡，实际 ${cards().length}`);
  assert.equal(
    cards().filter((c) => (c.querySelector('.dc-name')?.textContent ?? '').trim() === '').length,
    0,
    '每张卡都得有兵种名，空卡片说明池子里混了伪单位',
  );
  assert.equal(doc.querySelector('#draft [data-draft="__city__"]'), null, '池子里不该有伪单位');
  assert.ok(doc.querySelector('#draft .draft-side.is-a'), '要显示甲方那一栏');
  assert.ok(doc.querySelector('#draft .draft-side.is-b'), '要显示乙方那一栏');
  assert.ok(doc.querySelector('#draft [data-ref="draft-timer"]'), '要有倒计时');

  /*
   * 地图预览：选卡时**双方看到的是同一张图**。
   *
   * 以前只有 AI 能看：`aiDraftBan` / `aiDraftPick` 拿 `waterShareOf(state)` 给
   * 水军加权（"这张图水多，选两条船"），而真人手上只有兵种表，图被遮罩挡着。
   * 同一件决定一边有情报一边没有，所以补了这块预览。
   *
   * 断言三件事：一格不落、水域占比和 state 算出来的一致、城的归属能看出来。
   */
  const saved = JSON.parse(window.localStorage.getItem('warchess:match:v1') ?? '{}') as {
    w?: number;
    h?: number;
    tiles?: Array<{ terrain: string; cityId: string | null }>;
    cities?: Array<{ owner: string }>;
  };
  const mp = [...doc.querySelectorAll<HTMLElement>('#draft .draft-map-grid .mp')];
  assert.equal(mp.length, (saved.w ?? 0) * (saved.h ?? 0), '预览要一格不落地铺完整张图');
  const tiles = saved.tiles ?? [];
  const wet = tiles.filter((t) => t.terrain === 'water' || t.terrain === 'deep').length;
  const share = Math.round((wet / Math.max(1, tiles.length)) * 100);
  const facts = doc.querySelector('#draft .draft-map-facts')?.textContent ?? '';
  assert.ok(facts.includes(`水域 ${share}%`), `水域占比要和 state 一致（该是 ${share}%）：${facts}`);
  assert.ok(facts.includes(`${saved.w}×${saved.h}`), `要写出地图尺寸：${facts}`);
  assert.ok(
    doc.querySelectorAll('#draft .draft-map-grid .mp.own-A, #draft .draft-map-grid .mp.own-B').length > 0,
    '城的归属要在缩略图上标出来，否则"选船还是选马"还是没法判断',
  );

  /*
   * 一进禁用就该是满格倒计时，而且**不该**有任何"超时"记录。
   *
   * 这一条守的是"联机里一进选卡就显示双方禁用已超时"：deadline 早过期或者
   * 干脆是 0 的时候，界面会把别人的时间当成自己的，倒计时一进来就是 0s，
   * 紧接着替双方各判一次超时（两边白丢一次禁用）。现在倒计时取"本机看到这一轮
   * 之后的剩余"和房间那份的小者，锚点一立就是满的。
   */
  const timerText = doc.querySelector('#draft [data-ref="draft-timer"]')?.textContent ?? '';
  const timerSecs = Number.parseInt(timerText, 10);
  assert.ok(timerSecs > 0, `刚进禁用，倒计时必须是正数，实际「${timerText}」`);
  assert.equal(
    doc.querySelectorAll('#draft .draft-log li').length,
    0,
    '刚进禁用不该有任何流水，更不能有"超时"',
  );

  // 卡片排序：时代为主、扩展为辅（同一代里再来比包）
  const order = cards().map((c) => c.dataset.draft ?? '');
  const eras = order.map((id) => UNIT_TYPES[id]?.era ?? 1);
  for (let i = 1; i < eras.length; i++) {
    assert.ok(
      eras[i]! >= eras[i - 1]!,
      `卡片要按时代从低到高排：第 ${i} 张（${order[i]}）是 ${eras[i]} 代，` +
        `前面是 ${eras[i - 1]} 代`,
    );
  }

  // 悬停看详情：被挡住的卡也要能看（这时候正是最想研究池子的时候）
  const probe = cards()[0]!;
  probe.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }));
  const tip = doc.querySelector<HTMLElement>('#hover-tip');
  assert.ok(tip, '悬停应该浮出一块详情');
  assert.equal(tip!.hidden, false, '详情要显示出来');
  const tipText = tip!.textContent ?? '';
  assert.ok(tipText.includes('攻'), `详情要有数值，实际：${tipText}`);
  assert.ok(tipText.includes('造价') || tipText.includes('金'), '详情要写造价');
  probe.dispatchEvent(new window.MouseEvent('mouseout', { bubbles: true }));
  assert.equal(tip!.hidden, true, '移开就收起');

  // 甲方禁一个：遮罩上要出现一条"已禁用"，但还没进入选人
  cards()[0]!.click();
  await tick(40);

  assert.ok(
    doc.querySelector('#draft .draft-slot.is-ban.is-filled'),
    '禁完之后要看到禁用位被填上',
  );
  assert.ok(
    (doc.querySelector('#draft .draft-step')?.textContent ?? '').includes('禁用'),
    '只有一方交完，仍应停在禁用阶段',
  );

  // 乙方也禁一个 → 进入选人
  cards()[0]!.click();
  await tick(40);
  const step = doc.querySelector('#draft .draft-step')?.textContent ?? '';
  assert.ok(step.includes('选人'), `两边都禁完该进入选人，实际是「${step}」`);
});

await checkAsync('选人：按蛇形顺序点满，遮罩收起、棋盘可用', async () => {
  // 一路点第一张卡，直到遮罩消失（选满 12 步）
  for (let i = 0; i < 20; i++) {
    const mask = doc.querySelector<HTMLElement>('#draft');
    if (!mask || mask.hidden) break;
    const card = doc.querySelector<HTMLElement>('#draft [data-draft]');
    if (!card) break;
    card.click();
    await tick(25);
  }
  const mask = doc.querySelector<HTMLElement>('#draft')!;
  assert.equal(mask.hidden, true, '选满之后遮罩要收起');
  // 收起之后棋盘要恢复可点：棋盘上应该还有双方的单位
  assert.ok(doc.querySelectorAll('#board .unit').length > 0, '战场上应该有单位');
});


check('选卡模式下，城市的「升级后可解锁」只列这一局真能造的兵', () => {
  /*
   * 2026-11-06：这句提示原来只判 `def.era > city.era`（`ui/panel.ts` 的 `locked`），
   * 于是在选卡模式下把**池子里没选到的卡**整批列了出来——玩家看到
   * "升级后可解锁：圣剑勇者、九头蛇……"，真升完级一个也造不了。
   * 那句话比不写更糟：它把"没选到"说成了"再等等就有"。
   *
   * 现在判据在 `core/draft.ts` 的 `upgradeUnlocks`，和产兵表共用 `canUseType`。
   * 两边都要钉住：
   *   ① 没选到的高时代卡**不出现**；
   *   ② 经济 / 建造单位、生产性建筑、桥**照旧出现**——它们本来就不用选，
   *      而"升级解锁伐木工 / 民夫 / 石桥"是真事（用户特别点了这一条）。
   */
  const host = doc.createElement('div');
  doc.body.appendChild(host);
  try {
    let st = createMatch(
      { ...DEFAULT_CONFIG, size: 12, startEra: 1, draftMode: true, expansionIds: [] },
      777,
      {},
    );
    const started = applyAction(st, { type: 'DRAFT_START', at: Date.now() }, 'A');
    assert.ok(started.ok, started.ok ? '' : `进禁用失败：${started.reason}`);
    st = started.state;

    // 交完禁用
    for (let guard = 0; guard < 8 && st.draft!.phase === 'ban'; guard += 1) {
      for (const side of ['A', 'B'] as const) {
        if (st.draft!.bans[side].length >= st.draft!.banSlots) continue;
        const id = remainingUnits(st)[0]!;
        st.current = side;
        const r = applyAction(st, { type: 'DRAFT_BAN', unitId: id, at: Date.now() }, side);
        if (r.ok) st = r.state;
      }
    }
    assert.equal(st.draft!.phase, 'pick', '交完禁用应该进入选人');

    // 一路选满（AI 那边不需要好用，这里只要走到"选卡结束"）
    for (let guard = 0; guard < 40; guard += 1) {
      const side = st.draft!.order[st.draft!.step];
      if (!side) break;
      const id = remainingUnits(st)[0];
      if (!id) break;
      st.current = side;
      const r = applyAction(st, { type: 'DRAFT_PICK', unitId: id, at: Date.now() }, side);
      if (!r.ok) break;
      st = r.state;
    }
    assert.equal(st.draft!.phase, 'done', '选满之后这一局应该已经开始');

    const city = st.cities.find((c) => c.owner === 'A')!;
    assert.ok(city, 'A 方应该有一座城');
    renderPanel(host, {
      view: playerView(st, 'A'),
      me: 'A',
      selectedUnit: null,
      selectedCityId: city.id,
      selectedCampId: null,
      selectedTile: null,
    });

    // 2026-11-11：名单收进 <details> 里了，抓的话直接从名单节点取——
    // 别再用正则去啃那句提示的文案（改个字就红，而且红得没意义）
    assert.ok(host.querySelector('.unlock-fold'), '产兵面板还是该给出"升级后可解锁"这句提示');
    const names = (host.querySelector('.unlock-list')?.textContent ?? '')
      .split('、')
      .map((t) => t.trim())
      .filter(Boolean);
    assert.ok(names.length > 0, '青铜开局升到二级肯定有东西解锁，不该是空的');

    // ① 名单里的每一个，都必须是"这一局真能用"的
    for (const name of names) {
      const def = Object.values(st.unitTypes).find((d) => d.name === name);
      assert.ok(def, `提示里出现了不认识的兵种名：${name}`);
      assert.ok(
        draftAlwaysAllowed(def!) || st.draft!.picks.A.includes(def!.id),
        `「${name}」既没选到、也不是本来就能用的，不该出现在升级预览里`,
      );
    }

    // ② 池子里确实存在"没选到的高时代卡"——不然这条用例测不出东西
    const leakedPool = Object.values(st.unitTypes).filter(
      (d) =>
        d.era > city.era &&
        !d.summonedOnly &&
        !draftAlwaysAllowed(d) &&
        !st.draft!.picks.A.includes(d.id),
    );
    assert.ok(leakedPool.length > 0, '这局该存在"没选到的高时代兵"，否则测不出漏卡');
    const leaked = leakedPool.filter((d) => names.includes(d.name));
    assert.equal(
      leaked.length,
      0,
      `没选到的卡混进了升级预览：${leaked.map((d) => d.name).join('、')}`,
    );

    // ③ 反面：本来就不用选的那几类必须还在（用户点名的经济 / 建造单位）
    assert.ok(names.includes('伐木工'), `二级的经济单位「伐木工」要还在，实际：${names.join('、')}`);
    assert.ok(names.includes('民夫'), `二级的建造单位「民夫」要还在，实际：${names.join('、')}`);
    assert.ok(names.includes('石桥'), `三级的桥「石桥」要还在（桥也不进池子），实际：${names.join('、')}`);

    // ④ 函数本身和面板同源：面板里列的就是 upgradeUnlocks 的结果
    assert.deepEqual(
      names,
      upgradeUnlocks(st, 'A', city.era).map((d) => d.name),
      '面板该直接用 upgradeUnlocks 的结果，别再自己写一份判据',
    );
  } finally {
    host.remove();
  }
});

check('选卡池排序：同一代里，原版在扩展前面，扩展之间按声明顺序', () => {
  // 这条补的是"次要排序依据"：只按时代排的话，同一代里原版兵和扩展兵会混着排，
  // 扫池子时看不出"这批是哪个包带来的"。
  const host = doc.createElement('div');
  doc.body.appendChild(host);
  try {
    const st = createMatch(
      { ...DEFAULT_CONFIG, draftMode: true, expansionIds: ['fantasy-knights', 'pack-antiquity'] },
      4242,
      {},
    );
    // 池子只在禁用/选人阶段铺出来（等待开局那一屏是建房的地方）
    const started = applyAction(st, { type: 'DRAFT_START', at: Date.now() }, 'A');
    assert.ok(started.ok, started.ok ? '' : `进禁用失败：${started.reason}`);
    host.innerHTML = draftScreenHtml(started.state, {
      seat: 'A',
      now: Date.now(),
      isAi: () => false,
    });
    const ids = [...host.querySelectorAll<HTMLElement>('[data-draft]')].map((c) => c.dataset.draft!);
    assert.ok(ids.length >= 10, `应该铺出池子，实际 ${ids.length}`);

    const packRank = new Map(EXPANSIONS.map((e, i) => [e.id, i + 1]));
    // 时代要问**这一局**的兵种表：扩展兵种不在 UNIT_TYPES 里
    const key = (id: string) => {
      const src = unitSourceIdOf(id);
      return {
        era: started.state.unitTypes[id]?.era ?? 99,
        pack: src ? (packRank.get(src) ?? 98) : 0, // 原版＝0，排最前
      };
    };
    for (let i = 1; i < ids.length; i++) {
      const a = key(ids[i - 1]!);
      const b = key(ids[i]!);
      assert.ok(b.era >= a.era, `第 ${i} 张跨回了低时代：${ids[i - 1]}(${a.era}) → ${ids[i]}(${b.era})`);
      if (b.era === a.era) {
        assert.ok(
          b.pack >= a.pack,
          `同一代里扩展包顺序乱了：${ids[i - 1]}(包${a.pack}) → ${ids[i]}(包${b.pack})`,
        );
      }
    }
  } finally {
    host.remove();
  }
});

check('选卡：底部「我已选」区把每张卡的完整面板都摊开，不截断', () => {
  const host = doc.createElement('div');
  doc.body.appendChild(host);
  try {
    let st = createMatch(
      { ...DEFAULT_CONFIG, draftMode: true, expansionIds: ['fantasy-knights', 'pack-antiquity'] },
      4242,
      {},
    );
    const started = applyAction(st, { type: 'DRAFT_START', at: Date.now() }, 'A');
    assert.ok(started.ok, started.ok ? '' : `进禁用失败：${started.reason}`);
    st = started.state;

    // 两边把禁用交完，进入选人
    for (let guard = 0; guard < 8 && st.draft!.phase === 'ban'; guard += 1) {
      for (const side of ['A', 'B'] as const) {
        if (st.draft!.bans[side].length >= st.draft!.banSlots) continue;
        // 每一手要禁"还没被禁掉"的：池子里第一个可能已经在自己手上
        const id = remainingUnits(st)[0]!;
        // 席位从 s.current 读（和界面一致）：热座换人时它才是"谁在操作"
        st.current = side;
        const r = applyAction(st, { type: 'DRAFT_BAN', unitId: id, at: Date.now() }, side);
        if (r.ok) st = r.state;
      }
    }
    assert.equal(st.draft!.phase, 'pick', '两边交完禁用应该进入选人');

    // 甲方连选三个（乙方那个坑用同样的动作跳过，只为推进 step）
    const mine: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      const side = st.draft!.order[st.draft!.step];
      if (!side) break;
      const pickId = remainingUnits(st).find((id) => st.unitTypes[id]?.category === 'combat');
      assert.ok(pickId, '应该还有一个能选的战斗单位');
      st.current = side;
      const r = applyAction(st, { type: 'DRAFT_PICK', unitId: pickId!, at: Date.now() }, side);
      assert.ok(r.ok, r.ok ? '' : `选人失败：${r.reason}`);
      st = r.state;
      if (side === 'A') mine.push(pickId!);
    }
    assert.ok(mine.length >= 2, `甲方至少该选到 2 个，实际 ${mine.length}`);

    host.innerHTML = draftScreenHtml(st, { seat: 'A', now: Date.now(), isAi: () => false });

    // ① 位置：必须在 .draft-body **之后**（选卡界面下方），不是塞进侧栏
    const body = host.querySelector('.draft-body');
    const panel = host.querySelector('.draft-picked');
    assert.ok(panel, '应该有底部"我已选"区');
    // 4 = DOCUMENT_POSITION_FOLLOWING（jsdom 里没有全局 Node 常量）
    assert.ok(
      (body!.compareDocumentPosition(panel!) & 4) !== 0,
      '"我已选"区要排在主体区域之后（界面下方）',
    );

    // ② 数量：一个已选一张卡，不多不少
    const cards = [...host.querySelectorAll<HTMLElement>('.draft-pick')];
    assert.equal(cards.length, mine.length, '每张已选卡都要有一块完整信息卡');
    assert.ok(
      panel!.querySelector('.draft-picked-count')!.textContent!.includes(`/ ${st.draft!.pickSlots}`),
      '计分板要写成"已选 / 名额"',
    );

    // ③ 内容：数值一个不落、特性整段可读（不靠悬停、不做省略）
    for (let i = 0; i < mine.length; i += 1) {
      const def = st.unitTypes[mine[i]!]!;
      const text = cards[i]!.textContent ?? '';
      for (const need of [`攻`, `甲`, `血`, `射`, `视`, `${def.atk}`, `${def.armor}`, `${def.maxHp}`]) {
        assert.ok(text.includes(need), `${def.name} 的面板缺了「${need}」`);
      }
      for (const abilityId of def.abilities ?? []) {
        const ab = abilityById(abilityId);
        if (!ab) continue;
        assert.ok(text.includes(ab.name), `${def.name} 的能力「${ab.name}」没写出来`);
        assert.ok(
          text.includes(ab.summary),
          `${def.name} 的能力说明被截断或省略了：「${ab.summary}」`,
        );
      }
      // 页面里不许出现省略号式的截断容器
      for (const el of cards[i]!.querySelectorAll<HTMLElement>('*')) {
        const style = el.getAttribute('style') ?? '';
        assert.ok(!style.includes('ellipsis'), '已选卡里不允许用 text-overflow 截断');
      }
    }

    // ④ 禁用阶段还没有选人：这一块要给出说明而不是凭空消失
    const early = applyAction(
      createMatch({ ...DEFAULT_CONFIG, draftMode: true }, 99, {}),
      { type: 'DRAFT_START', at: Date.now() },
      'A',
    );
    assert.ok(early.ok);
    host.innerHTML = draftScreenHtml(early.state, { seat: 'A', now: Date.now(), isAi: () => false });
    const emptyPanel = host.querySelector('.draft-picked');
    assert.ok(emptyPanel, '禁用阶段"我已选"区也应该在，只是空的');
    assert.equal(host.querySelectorAll('.draft-pick').length, 0, '禁用阶段没有已选卡');
    assert.ok(
      (emptyPanel!.textContent ?? '').includes('还没有人选卡'),
      '空状态要说清楚现在是禁用阶段',
    );
  } finally {
    host.remove();
  }
});

check('选卡：轮流禁用——不是自己回合时池子是灰的，提示写明轮到谁', () => {
  const host = doc.createElement('div');
  doc.body.appendChild(host);
  try {
    let st = createMatch({ ...DEFAULT_CONFIG, draftMode: true }, 4243, {});
    const r = applyAction(st, { type: 'DRAFT_START', at: Date.now() }, 'A');
    assert.ok(r.ok, r.ok ? '' : `进禁用失败：${r.reason}`);
    st = r.state;

    // 先禁的那一方 = 后拿第一签的那一方
    const first = st.draft!.banTurn!;
    const second = first === 'A' ? 'B' : 'A';

    // 站在"没轮到"的那一方看：池子必须是灰的，并说清在等谁
    host.innerHTML = draftScreenHtml(st, { seat: second, now: Date.now(), isAi: () => false });
    const blocked = host.querySelectorAll('.draft-card.is-blocked');
    assert.ok(blocked.length > 0, '没轮到的这一方，池子里的卡应该都是灰的');
    const hint = host.querySelector('.draft-hint')?.textContent ?? '';
    assert.ok(hint.includes('正在禁用'), `提示要写明对面在禁：${hint}`);

    // 站在"轮到"的那一方看：卡是可点的，提示说的是"轮到你"
    host.innerHTML = draftScreenHtml(st, { seat: first, now: Date.now(), isAi: () => false });
    assert.equal(host.querySelectorAll('.draft-card.is-blocked').length, 0, '轮到的一方，卡不该是灰的');
    const mineHint = host.querySelector('.draft-hint')?.textContent ?? '';
    assert.ok(mineHint.includes('轮到你禁用'), `提示要写"轮到你禁用"：${mineHint}`);

    // 禁完之后交棒：轮次真的换人了
    const id = remainingUnits(st).find((x) => st.unitTypes[x]?.category === 'combat')!;
    st.current = first;
    const done = applyAction(st, { type: 'DRAFT_BAN', unitId: id, at: Date.now() }, first);
    assert.ok(done.ok, done.ok ? '' : `禁用失败：${done.reason}`);
    st = done.state;
    assert.equal(st.draft!.banTurn, second, '禁完一格就该交棒');
    host.innerHTML = draftScreenHtml(st, { seat: first, now: Date.now(), isAi: () => false });
    assert.ok(
      (host.querySelector('.draft-hint')?.textContent ?? '').includes('正在禁用'),
      '交棒之后，原来看得到池子的那一方也该变成"等对面"',
    );
  } finally {
    host.remove();
  }
});

check('选卡：对面已经选中的兵，鼠标挪上去也要给完整面板', () => {
  /*
   * 选卡时最想研究的一件事就是"对面拿走了什么"——它是不是我打算禁的那张、
   * 几甲几射程、带什么能力。以前槽位上只有一个名字，等于让人凭记忆打。
   */
  const host = doc.createElement('div');
  doc.body.appendChild(host);
  try {
    let st = createMatch({ ...DEFAULT_CONFIG, draftMode: true }, 4242, {});
    let r = applyAction(st, { type: 'DRAFT_START', at: Date.now() }, 'A');
    assert.ok(r.ok, r.ok ? '' : `进禁用失败：${r.reason}`);
    st = r.state;

    // 两边把禁用交完
    for (let guard = 0; guard < 8 && st.draft!.phase === 'ban'; guard += 1) {
      for (const side of ['A', 'B'] as const) {
        if (st.draft!.bans[side].length >= st.draft!.banSlots) continue;
        const id = remainingUnits(st)[0]!;
        st.current = side;
        const rr = applyAction(st, { type: 'DRAFT_BAN', unitId: id, at: Date.now() }, side);
        if (rr.ok) st = rr.state;
      }
    }
    // 走四手：蛇形是 A,B,B,A，所以两边各有一张
    for (let i = 0; i < 4; i += 1) {
      const side = st.draft!.order[st.draft!.step];
      if (!side) break;
      const pickId = remainingUnits(st).find((id) => st.unitTypes[id]?.category === 'combat');
      if (!pickId) break;
      st.current = side;
      const rr = applyAction(st, { type: 'DRAFT_PICK', unitId: pickId, at: Date.now() }, side);
      if (!rr.ok) break;
      st = rr.state;
    }

    host.innerHTML = draftScreenHtml(st, { seat: 'A', now: Date.now(), isAi: () => false });

    const bSlot = host.querySelector<HTMLElement>('.draft-side.is-b .draft-slot.is-pick.is-filled');
    assert.ok(bSlot, 'B 那边应该已经有一张选好的兵');
    assert.ok(bSlot!.hasAttribute('data-hover-tip'), '已选槽位要能被悬停');
    const tip = bSlot!.querySelector('.hover-tip');
    assert.ok(tip, '槽位里要带完整详情');
    const text = tip!.textContent ?? '';
    for (const need of ['攻', '甲', '血', '射', '视']) {
      assert.ok(text.includes(need), `对面那张的详情缺了「${need}」`);
    }
    // 详情里的数值要和这个兵对得上（不是拿池子里第一张糊弄）
    const id = st.draft!.picks.B[0]!;
    const def = st.unitTypes[id]!;
    assert.ok(text.includes(def.name), '详情要是这一张');
    assert.ok(text.includes(`血 ${def.maxHp}`), '血量要对得上');

    // 自己那一侧同样有详情：没道理只有对面能看
    const aSlot = host.querySelector<HTMLElement>('.draft-side.is-a .draft-slot.is-pick.is-filled');
    assert.ok(aSlot?.querySelector('.hover-tip'), '自己已选的也要有详情');
  } finally {
    host.remove();
  }
});

await checkAsync('选卡可以跳过：这一局用全部兵种，遮罩收起', async () => {
  openSetup();
  click('[data-draft-mode="on"]');
  click('[data-act="start"]');
  await tick(60);
  assert.equal(doc.querySelector<HTMLElement>('#draft')!.hidden, false);

  click('#draft [data-draft-act="skip"]');
  await tick(60);
  assert.equal(doc.querySelector<HTMLElement>('#draft')!.hidden, true, '跳过后遮罩要收起');
  // 跳过＝按原版打：结束回合应该能点
  const endTurn = doc.querySelector<HTMLElement>('[data-act="end-turn"]');
  assert.ok(endTurn, '应该有结束回合按钮');
  endTurn!.click();
  await tick(40);
});

await checkAsync('选卡可以退出：退出后回到首页，想重开再走一遍「开始对局」', async () => {
  openSetup();
  click('[data-draft-mode="on"]');
  click('[data-act="start"]');
  await tick(60);
  assert.equal(doc.querySelector<HTMLElement>('#draft')!.hidden, false, '先要有遮罩');

  // 退出选卡走的是和顶栏「首页」同一条路（2026-11-04 起它不再直接弹面板）
  click('#draft [data-draft-act="exit"]');
  await tick(80);
  assert.ok(doc.querySelector('.title-screen'), '退出之后应该回到首页');
  assert.equal(doc.querySelector('.modal-mask'), null, '不该顺手弹出设置面板');

  // 门口还在：从首页重新开一局，面板照样弹得出来
  click('[data-title="new"]');
  assert.ok(doc.querySelector('.modal-mask'), '从首页应该能打开设置面板');
  doc.querySelector<HTMLElement>('.modal-mask [data-act="cancel"]')?.click();
  await tick(40);
  // 收掉首页，别把后面的用例留在"站在门口"的状态
  window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }));
  await tick(20);
});

await checkAsync('选卡 + 对战 AI：AI 自己把它的禁位与选位走完', async () => {
  openSetup();
  click('[data-ai="1"]');
  click('[data-draft-mode="on"]');
  click('[data-act="start"]');
  await tick(80);
  assert.equal(doc.querySelector<HTMLElement>('#draft')!.hidden, false, '遮罩应该出现');
  click('#draft [data-draft-act="start"]');
  await tick(80);

  // 只替甲方点；轮到 AI 时卡片会全部禁用，这里等它自己动（每步 600ms）
  for (let i = 0; i < 40; i++) {
    const mask = doc.querySelector<HTMLElement>('#draft');
    if (!mask || mask.hidden) break;
    const card = doc.querySelector<HTMLElement>(
      '#draft [data-draft]:not([aria-disabled="true"])',
    );
    if (card) {
      card.click();
      await tick(80);
      continue;
    }
    await tick(200);
  }

  assert.equal(
    doc.querySelector<HTMLElement>('#draft')!.hidden,
    true,
    'AI 那一半也要能自己走完，遮罩最终要收起',
  );
  // 收起之后轮到人类开局，棋盘上双方都该有单位
  assert.ok(doc.querySelectorAll('#board .unit').length > 0, '战场上应该有单位');
});


check('状态栏：中毒/灼烧/减速挂在兵身上时要看得见', () => {
  /*
   * 这些状态以前只活在结算里：血条自己变短、护甲自己变小，面板一个字不提。
   * 状态栏就是那笔账——挂的是什么、还剩几回合。
   */
  const host = doc.createElement('div');
  const st = createMatch({ ...DEFAULT_CONFIG, size: 12, startEra: 1, expansionIds: [] }, 4242);
  const u = st.units.find((x) => x.owner === 'A')!;
  const paint = () =>
    renderPanel(host, {
      view: playerView(st, 'A'),
      me: 'A',
      selectedUnit: u,
      selectedCityId: null,
      selectedCampId: null,
      selectedTile: null,
    });

  paint();
  assert.equal(host.querySelector('.status-row'), null, '身上没状态时不该留一排空壳');

  u.status = { poison: 3, burn: 2, slow: 1 };
  paint();
  const row = host.querySelector('.status-row');
  assert.ok(row, '挂上状态就要有状态栏');
  const chips = [...row!.querySelectorAll('.status-chip')];
  assert.equal(chips.length, 3, `三个状态应该三个徽标，实际 ${chips.length}`);
  const text = row!.textContent ?? '';
  assert.ok(text.includes('中毒'), '要写名字');
  assert.ok(text.includes('3 回合'), `中毒报剩余回合，实际：${text}`);
  assert.ok(text.includes('2 层'), `灼烧报层数（不是回合），实际：${text}`);
  assert.ok(row!.querySelector('.st-poison'), '中毒要有自己的样式钩子');
  assert.ok(row!.querySelector('.st-burn'), '灼烧要有自己的样式钩子');
  // 顺序固定：中毒先于灼烧——战报和面板对同一件事得用同一个顺序
  assert.ok(
    text.indexOf('中毒') < text.indexOf('灼烧'),
    `状态顺序该是中毒→灼烧，实际：${text}`,
  );
});


check('三人局认输之后：顶栏要说"你已认输"，按钮不再假装还能走', () => {
  /*
   * 认输在三人四人局里只退出自己（剩下的人接着打），所以界面必须换一种说法。
   * 以前它继续写"等待 XXX"、结束回合按钮写着"等待对方行动中"——
   * 认输的人看着像在等一个永远不会轮到的回合。
   */
  const host = doc.createElement('div');
  const st = createMatch({ ...DEFAULT_CONFIG, size: 12, startEra: 1, playerCount: 3 }, 5150);
  st.out = ['A'];
  renderPanel(host, {
    view: playerView(st, 'A'),
    me: 'A',
    selectedUnit: null,
    selectedCityId: null,
    selectedCampId: null,
    selectedTile: null,
  });
  const text = host.textContent ?? '';
  assert.ok(text.includes('你已认输'), `顶栏要说清已经退出，实际：${text.slice(0, 120)}`);
  const endTurn = host.querySelector('[data-act="end-turn"]') as HTMLButtonElement | null;
  assert.ok(endTurn, '侧栏还是要有那颗按钮（用来显示状态）');
  assert.equal(endTurn!.disabled, true, '已退出就不能再结束回合');
  const surrender = host.querySelector('[data-act="surrender"]') as HTMLButtonElement | null;
  assert.equal(surrender!.disabled, true, '认输过一次就不该还能再点');
});

check('三人局城被打光：顶栏说"你的城全丢了"，席位栏把这一家划掉', () => {
  /*
   * 出局有两种：自己认输，和最后一座城被人接管。规则层对两者的处理已经一样了
   * （兵都会撤场，见 rules 的 retireLostSeat），但界面以前只认"认输"——
   * 城全丢的那家，顶栏还在写"等待 XXX"，席位栏也照样亮着、显示"城 0"，
   * 玩家看不出自己已经出局，只觉得自己点什么都不响应。
   */
  const host = doc.createElement('div');
  const st = createMatch({ ...DEFAULT_CONFIG, size: 12, startEra: 1, playerCount: 3 }, 5151);
  st.cities = st.cities.filter((c) => c.owner !== 'A');
  st.current = 'B';
  renderPanel(host, {
    view: playerView(st, 'A'),
    me: 'A',
    selectedUnit: null,
    selectedCityId: null,
    selectedCampId: null,
    selectedTile: null,
  });
  const text = host.textContent ?? '';
  assert.ok(text.includes('你的城全丢了'), `顶栏要说清已经出局，实际：${text.slice(0, 120)}`);

  const endTurn = host.querySelector('[data-act="end-turn"]') as HTMLButtonElement | null;
  assert.equal(endTurn?.disabled, true, '城全丢了就不能再结束回合');

  const rows = [...host.querySelectorAll('.seat-row')];
  assert.equal(rows.length, 3, '三家人三行');
  const out = rows.filter((r) => r.classList.contains('quit'));
  assert.equal(out.length, 1, `只有出局的那一家该被划掉，实际划掉 ${out.length} 行`);
  assert.ok((out[0]!.textContent ?? '').includes('城 0'), '划掉的应该是没城的那一家');
});


check('掉血动画：一笔扣血只演一次，DOM 重排（有人倒下）也不重播', () => {
  /*
   * 病根不在我们自己的调用次数，而在浏览器：`paintUnits` 为了对齐顺序会
   * `insertBefore`，节点被摘下再插回时**正在跑的 CSS 动画会从头再来**。
   * 而顺序变化最常发生在"这一下有单位死了"的那一帧——正好和掉血同帧。
   * 所以上一版"按动作对账"只能堵住渲染重放，堵不住浏览器自己的重播。
   *
   * 现在残留条走 Web Animations（挂在元素上，重插入不重播），
   * 再加一个绘制序号防止同一次绘制里演两遍。这条用例数 `animate` 的调用次数。
   */
  const host = doc.createElement('div');
  host.className = 'board';
  doc.body.appendChild(host);
  const st = createMatch({ ...DEFAULT_CONFIG, size: 12, startEra: 1, expansionIds: [] }, 771);
  const ui = {
    selectedId: null,
    reach: [] as number[],
    targets: [] as string[],
    siegeTargets: [] as string[],
    selectedCityId: null,
    placeable: [] as number[],
    threat: [] as number[],
    me: 'A' as const,
  };
  const allSeen = Array.from({ length: st.w * st.h }, (_, i) => i);
  const allVisible = {
    state: st,
    visible: allSeen,
    visibleByBoard: { earth: allSeen },
    ghosts: [] as never[],
    rememberedTiles: new Map(),
    rememberedByBoard: {},
    rememberedCities: new Map(),
    terrainHidden: false,
  };

  const calls: string[] = [];
  const proto = (dom.window as unknown as { HTMLElement: { prototype: Record<string, unknown> } })
    .HTMLElement.prototype;
  const orig = proto.animate;
  proto.animate = function (this: HTMLElement, frames: Keyframe[]) {
    calls.push(String((frames[0] as { width?: string }).width ?? ''));
    return { cancel() {}, finished: Promise.resolve() } as unknown as Animation;
  };

  try {
    const victim = st.units.find((u) => u.owner === 'B')!;
    const maxHp = st.unitTypes[victim.type]!.maxHp;
    const before = victim.hp / maxHp;
    victim.hp = Math.max(1, Math.floor(maxHp / 2));
    const after = victim.hp / maxHp;

    renderBoard(host, allVisible, { ...ui, hpDrops: new Map([[victim.id, before]]) });
    assert.equal(calls.length, 1, `一次掉血只该演一遍，实际 ${calls.length} 次`);
    // 起点是"掉血前"的比例：没有这句，橙条会从新血线开始，等于没演
    assert.equal(calls[0], `${Math.max(2, before * 100)}%`, '橙条要从掉血前的宽度起跑');

    // 走的是 Web Animations，不是 CSS 类：类动画会被 DOM 重排从头再播
    assert.equal(
      host.querySelector('.hp-lag.chipped'),
      null,
      '有 animate 时不该再退回会被重排打断的 CSS 类动画',
    );

    // 同一笔掉血再画一遍（顶栏 / 缩放 / 轮询都会触发）：不该再演
    renderBoard(host, allVisible, { ...ui });
    assert.equal(calls.length, 1, '重复渲染不该重播');
    void after;

    // 有人倒下 → 后面的节点要前移（insertBefore）。以前 CSS 动画会因此从头再来
    const dead = st.units.find((u) => u.owner === 'A' && u.id !== victim.id)!;
    st.units = st.units.filter((u) => u.id !== dead.id);
    renderBoard(host, allVisible, { ...ui });
    assert.equal(calls.length, 1, 'DOM 重排不该让已经播过的掉血动画重播');

    // 老环境（没有 animate）：退回 CSS 类，至少还能看见——这条路径不能被删掉
    delete (proto as { animate?: unknown }).animate;
    victim.hp = Math.max(1, victim.hp - 3);
    renderBoard(host, allVisible, { ...ui, hpDrops: new Map([[victim.id, after]]) });
    assert.ok(host.querySelector('.hp-lag.chipped'), '没有 animate 时要用类动画兜底');
  } finally {
    proto.animate = orig;
    host.remove();
  }
});

/*
 * 点地图这件事的命中检测。
 *
 * 线上报过两个现象："放大地图之后点格子没反应"、"地图右下角一块怎么点都没用"。
 * 前者是 `pointerdown` 里无条件 `setPointerCapture`，把随后派生的 click
 * 整个改到了 `.board-scroll` 上；后者是缩放条/聊天停靠区压在棋盘上吃掉了点击。
 * 前者的后果正好落在 `coordsFromEvent` 这一层——拿到的事件目标根本不是格子。
 * 所以这里守两件事：目标不是格子时能不能算出来，以及别把键盘触发的点击算成假命中。
 */
check('点地图：落点不在格子上，也要能算出是哪一格', () => {
  const host = doc.createElement('div');
  host.className = 'board';
  doc.body.appendChild(host);
  const s2 = createMatch({ ...DEFAULT_CONFIG, size: 16 }, 606);
  renderBoard(host, playerView(s2, 'A'), {
    selectedId: null, reach: [], targets: [], siegeTargets: [],
    selectedCityId: null, placeable: [], threat: [],
  });
  const tiles = host.querySelector<HTMLElement>('.tiles')!;
  assert.ok(tiles, '棋盘里应该有 .tiles 这一层');
  // jsdom 没有布局：把格栅层的矩形钉死成 400×400，左上角在 (100, 50)
  Object.defineProperty(tiles, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({ left: 100, top: 50, width: 400, height: 400, right: 500, bottom: 450, x: 100, y: 50 }),
  });
  const view = doc.defaultView!;
  const clickAt = (target: Element, x: number, y: number): Event => {
    const ev = new view.MouseEvent('click', { clientX: x, clientY: y, bubbles: true });
    target.dispatchEvent(ev);
    return ev;
  };

  try {
    // 1) 老路径：事件目标就是格子本身，照旧按 data-x 走
    const one = host.querySelector<HTMLElement>('.tile[data-x="5"][data-y="7"]');
    assert.ok(one, '应该有 5,7 这一格');
    assert.deepEqual(coordsFromEvent(clickAt(one, 0, 0)), { x: 5, y: 7 }, '点在格子上还是按格子算');

    // 2) 兜底：目标不是格子，但落在格栅范围内 → 按几何换算
    //    16 格 / 400px = 每格 25px。取第 3 列、第 2 行的中心
    assert.deepEqual(
      coordsFromEvent(clickAt(host, 100 + 25 * 3.5, 50 + 25 * 2.5)),
      { x: 3, y: 2 },
      '点在棋盘内边距（没有 data-x）上，也要换算到对应格子',
    );

    // 3) 兜底：点在棋盘左边缘的留白里（格栅外）→ 夹到 0，不返回 null
    assert.deepEqual(
      coordsFromEvent(clickAt(host, 98, 60)),
      { x: 0, y: 0 },
      '点在内边距最外侧，夹到边界格，而不是整下作废',
    );

    // 4) 键盘触发的 click 坐标是 0,0：不能算成"点了左上角"
    assert.equal(coordsFromEvent(clickAt(host, 0, 0)), null, '0,0 是键盘点击的默认坐标，不算命中');

    // 5) 棋盘之外一律 null
    assert.equal(coordsFromEvent(clickAt(doc.body, 10, 10)), null, '棋盘外面点不到格子');
  } finally {
    host.remove();
  }
});


await checkAsync('复盘：把一份对局数据拖进页面就能逐帧回看，退出后本机那局原样还在', async () => {
  /*
   * 这条守的是整条链路，而不是某个函数：拖放 → 读文件 → 重建开局 → 走动作 →
   * 换成复盘视角 → 退出还原。中间任何一环断了，玩家看到的是"拖进去没反应"。
   *
   * 还有一个必须验的副作用：**复盘不能动本机存档**。
   * main.ts 里二十多个地方会顺手 saveMatch(state)，而复盘期间 state 是别人的棋——
   * 漏拦一处，玩家看一次复盘就把自己没打完那局覆盖了。
   */
  const seed = 909090;
  const base = createMatch({ ...DEFAULT_CONFIG, size: 8 }, seed);
  base.fog = false;
  const w = bootWith(base);
  const d = w.document;
  const turnText = (): string => d.querySelector('[data-ref="turn"]')?.textContent ?? '';

  // 造一份"真报告"：同一个配置和种子，走三步结束回合
  let s2 = createMatch(base.config, seed);
  const acts = [{ type: 'END_TURN' as const }, { type: 'END_TURN' as const }, { type: 'END_TURN' as const }];
  for (const a of acts) {
    const r = applyAction(s2, a);
    assert.ok(r.ok, '造数据时这一步就没走通');
    s2 = r.state;
  }
  const report = buildMatchReport(s2, new Date('2026-11-05T00:00:00Z'), null, acts);

  assert.equal(turnText().includes('第 1 回合'), true, `开局应当是第 1 回合，实际「${turnText()}」`);

  // 拖进来
  const file = new w.File([JSON.stringify(report)], 'warchess-2026-11-05-909090-a.json', {
    type: 'application/json',
  });
  const drop = new w.Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(drop, 'dataTransfer', { value: { files: [file], types: ['Files'] } });
  w.dispatchEvent(drop);

  const bar = () => d.querySelector<HTMLElement>('#replay');
  const until = Date.now() + 4000;
  while (Date.now() < until && (!bar() || bar()!.hidden)) await wait(20);
  assert.ok(bar() && !bar()!.hidden, '拖进来之后复盘条应该出现');
  assert.ok((bar()!.textContent ?? '').includes('复盘'), '复盘条上要写清楚这是复盘');
  assert.ok((bar()!.textContent ?? '').includes('/3 步'), `要显示总步数，实际「${bar()!.textContent}」`);
  assert.ok(turnText().includes('第 1 回合'), '进来时停在开局那一帧');

  const click = (sel: string): void => {
    const el = d.querySelector<HTMLElement>(sel);
    assert.ok(el, `找不到 ${sel}`);
    el!.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  };

  // 下一步
  click('[data-act="rp-next"]');
  assert.ok(turnText().includes('第 2 回合'), `走一步应当到第 2 回合，实际「${turnText()}」`);

  // 跳终局
  click('[data-act="rp-last"]');
  assert.ok(turnText().includes('第 4 回合'), `跳终局应当到第 4 回合，实际「${turnText()}」`);

  // 拖进度条（input 事件就是拖动过程本身）
  const slider = d.querySelector<HTMLInputElement>('[data-act="rp-seek"]')!;
  assert.equal(slider.max, '3', '滑块上限应当是"真的走通的步数"');
  slider.value = '1';
  slider.dispatchEvent(new w.Event('input', { bubbles: true }));
  assert.ok(turnText().includes('第 2 回合'), `拖回第 1 步应当是第 2 回合，实际「${turnText()}」`);

  // 复盘里点棋盘不能走子（只能选中看属性）
  const tiles = d.querySelectorAll<HTMLElement>('.tile');
  const before = JSON.parse(w.localStorage.getItem('warchess:match:v1')!);
  tiles[0]!.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  assert.equal(
    JSON.parse(w.localStorage.getItem('warchess:match:v1')!).turn,
    before.turn,
    '复盘里点棋盘不许改动任何东西',
  );

  // 退出：回到原来那局，而且存档里还是原来那局
  click('[data-act="rp-exit"]');
  assert.ok(bar()!.hidden, '退出之后复盘条要收起来');
  assert.ok(turnText().includes('第 1 回合'), `退出要回到本机那局（第 1 回合），实际「${turnText()}」`);
  const saved = JSON.parse(w.localStorage.getItem('warchess:match:v1')!);
  assert.equal(saved.turn, 1, '复盘期间不许把别人的棋写进本机存档');
  assert.equal(saved.seed, seed, '本机存档的种子不该被换掉');
});

await checkAsync('复盘：界面按"别人的棋"渲染——能改局的东西全部收起来', async () => {
  /*
   * 复盘把 `state` 换成了别人的那一帧，但界面原来还以为这是"我的局"：
   * 侧栏顶着「轮到你行动」、城里有「生产」按钮、选中单位有强制移动/拆除/结束回合，
   * 顶栏还摆着「暂停 AI」「交给 AI」「导出对局」。点下去都被 dispatch 的闸门挡住，
   * 于是玩家看到的是一屏"能点但没反应"的按钮——这就是"棋局和 UI 打架"。
   *
   * 这一条从**界面成品**倒着验：复盘里不该有任何一颗可用的改局按钮。
   */
  const seed = 707070;
  const base = createMatch({ ...DEFAULT_CONFIG, size: 8 }, seed);
  base.fog = false;
  const w = bootWith(base);
  const d = w.document;

  let s2 = createMatch(base.config, seed);
  s2.fog = false;
  const acts = [{ type: 'END_TURN' as const }, { type: 'END_TURN' as const }, { type: 'END_TURN' as const }];
  for (const a of acts) {
    const r = applyAction(s2, a);
    assert.ok(r.ok, '造数据时这一步就没走通');
    s2 = r.state;
  }
  // 终局帧：报告里有 winner，最容易把"结算卡"带出来
  const report = buildMatchReport({ ...s2, winner: 'A' }, new Date('2026-11-06T00:00:00Z'), null, acts);

  const file = new w.File([JSON.stringify(report)], 'w.json', { type: 'application/json' });
  const ev = new w.Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(ev, 'dataTransfer', { value: { files: [file], types: ['Files'] } });
  w.dispatchEvent(ev);
  const until = Date.now() + 4000;
  while (Date.now() < until && d.querySelector<HTMLElement>('#replay')?.hidden !== false) await wait(20);
  assert.equal(d.querySelector<HTMLElement>('#replay')!.hidden, false, '应该进入复盘');

  const side = (): HTMLElement => d.querySelector<HTMLElement>('#side')!;
  /*
   * 打开一座城。
   *
   * 挑"城里没站兵"的那一格：兵压在城上时点下去选中的是兵（连点轮换那套只在
   * 正常对局里跑），而复盘里最想看的恰恰是城——耐久多少、还剩几回合能被拆。
   */
  const cityTile = [...d.querySelectorAll<HTMLElement>('.tile.t-city.own-A')].find(
    (t) => !t.querySelector('.unit'),
  );
  assert.ok(cityTile, 'A 方城里应该有一格是空的');
  cityTile!.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await wait(80);
  assert.ok(
    (side().textContent ?? '').includes('城市'),
    `复盘里点城要看得到城市卡（城不是单位，得单独认一下）：${(side().textContent ?? '').slice(0, 60)}`,
  );
  const afterCity = (side().textContent ?? '').replace(/\s+/g, ' ');
  assert.ok(!afterCity.includes('生产'), '复盘里不该出现生产区——那是别人那局的城');

  /** 侧栏里"能改局"的按钮：一个都不许是可用状态 */
  const liveActs = ['end-turn', 'undo', 'surrender', 'force-move', 'force-attack', 'disband', 'upgrade', 'commander-run', 'plan-commit'];
  const enabled = [...side().querySelectorAll<HTMLButtonElement>('button')].filter(
    (b) => !b.hidden && !b.disabled && (liveActs.includes(b.dataset.act ?? '') || b.classList.contains('recruit-btn')),
  );
  assert.deepEqual(
    enabled.map((b) => `${b.dataset.act ?? 'recruit'}:${(b.textContent ?? '').trim().slice(0, 8)}`),
    [],
    '复盘里不该有一颗可用的改局按钮',
  );

  // 抬头必须说"这是复盘"，不能假装轮到你
  const sideText = (side().textContent ?? '').replace(/\s+/g, ' ');
  assert.ok(sideText.includes('复盘'), `侧栏要说清这是复盘：${sideText.slice(0, 60)}`);
  assert.ok(!sideText.includes('轮到你行动'), '复盘里没有"你"的回合');
  assert.ok(!sideText.includes('（你）'), '席位栏不该把某一方标成"你"——复盘里两边都是别人');

  /*
   * 顶栏：会改局的那几个收起来，纯看的留下。
   *
   * 2026-11-11 起低频入口都进了「设置」，所以这里多一层：设置按钮本身要在，
   * 打开之后「导出对局」得消失——复盘导的是别人那局，原来顶栏那颗就是藏起来的，
   * 搬进弹窗不能把这条规矩丢了。
   */
  const topBtn = (act: string) => d.querySelector<HTMLElement>(`#topbar [data-act="${act}"]`);
  for (const act of ['toggle-ai', 'toggle-fog', 'ai-pause', 'ai-speed', 'online']) {
    assert.equal(topBtn(act)?.hidden, true, `复盘里顶栏不该出现 ${act}`);
  }
  assert.ok(topBtn('settings'), '顶栏该留着「设置」');
  assert.notEqual(topBtn('settings')!.hidden, true, '「设置」不该被藏起来');

  topBtn('settings')!.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  const gear = d.querySelector<HTMLElement>('.modal-mask')!;
  assert.equal(gear.querySelector('[data-act="export"]'), null, '复盘里设置弹窗不给导出');
  for (const act of ['manual', 'feedback', 'new-game']) {
    assert.ok(gear.querySelector(`[data-act="${act}"]`), `设置里该留着 ${act}`);
  }
  gear.querySelector<HTMLElement>('[data-act="settings-close"]')!.dispatchEvent(
    new w.MouseEvent('click', { bubbles: true }),
  );
  assert.equal(d.querySelector('.modal-mask'), null, '关掉设置别留一层遮罩');

  // 结算卡：别人那局打完了，不该问"要不要捐出这局的数据"
  assert.equal(d.querySelector('.report-card'), null, '复盘里不该冒出结算卡——上传的是别人那局');

  // 退出之后一切复原
  d.querySelector<HTMLElement>('[data-act="rp-exit"]')!.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await wait(100);
  assert.equal(topBtn('toggle-ai')?.hidden, false, '退出后顶栏要复原');
  topBtn('settings')!.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  assert.ok(
    d.querySelector('.modal-mask [data-act="export"]'),
    '退出复盘后设置里的「导出对局」要回来',
  );
  d.querySelector<HTMLElement>('[data-act="settings-close"]')!.dispatchEvent(
    new w.MouseEvent('click', { bubbles: true }),
  );
  assert.equal(d.querySelector('.tile.t-city.own-A') !== null, true, '退出后还是本机那局');
});

await checkAsync('复盘：AI 正在走的时候把文件拖进来，回放不会自己往前跑', async () => {
  /*
   * `enterReplay` 换的是全局 `state`，而 AI 走子那两条循环（runAiTurn / runCommanderBatch）
   * 只认自己的 `token`。不按停的话，它们会接着在**回放**上下子：
   * 拖到自己想看的那一帧，过一会儿棋又变了，回合数还和进度条对不上。
   */
  const seed = 606060;
  const base = createMatch(
    { ...DEFAULT_CONFIG, size: 8, aiOpponent: true, aiAlly: true },
    seed,
  );
  base.fog = false;
  const w = bootWith(base); // 开机就会自己开打（kickAiIfNeeded）
  const d = w.document;
  await wait(400); // 让它走到一半

  let s2 = createMatch(base.config, seed);
  s2.fog = false;
  const acts = [{ type: 'END_TURN' as const }, { type: 'END_TURN' as const }];
  for (const a of acts) {
    const r = applyAction(s2, a);
    if (r.ok) s2 = r.state;
  }
  const report = buildMatchReport(s2, new Date('2026-11-06T00:00:00Z'), null, acts);
  const file = new w.File([JSON.stringify(report)], 'w.json', { type: 'application/json' });
  const ev = new w.Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(ev, 'dataTransfer', { value: { files: [file], types: ['Files'] } });
  w.dispatchEvent(ev);
  const until = Date.now() + 4000;
  while (Date.now() < until && d.querySelector<HTMLElement>('#replay')?.hidden !== false) await wait(20);
  assert.equal(d.querySelector<HTMLElement>('#replay')!.hidden, false, '应该进入复盘');

  // 跳到最后一步，然后盯一会儿：回放是死的，画面不该变
  d.querySelector<HTMLElement>('[data-act="rp-last"]')!.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  const turnBefore = d.querySelector('[data-ref="turn"]')?.textContent ?? '';
  const slider = d.querySelector<HTMLInputElement>('[data-act="rp-seek"]')!;
  const posBefore = slider.value;
  await wait(500);
  assert.equal(d.querySelector('[data-ref="turn"]')?.textContent ?? '', turnBefore, '回放里的回合数不该自己往前走');
  assert.equal(d.querySelector<HTMLInputElement>('[data-act="rp-seek"]')!.value, posBefore, '进度条位置不该自己动');

  d.querySelector<HTMLElement>('[data-act="rp-exit"]')!.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await wait(300);
  assert.ok(d.querySelector<HTMLElement>('#replay')!.hidden, '退出复盘');
});

await checkAsync('复盘：拖进来的不是对局数据时，要说清是什么问题', async () => {
  const st = createMatch({ ...DEFAULT_CONFIG, size: 8 }, 919191);
  const w = bootWith(st);
  const d = w.document;
  const drop = (body: string): void => {
    const file = new w.File([body], 'x.json', { type: 'application/json' });
    const ev = new w.Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'dataTransfer', { value: { files: [file], types: ['Files'] } });
    w.dispatchEvent(ev);
  };

  // 不是 JSON：不该进复盘模式，只弹一句提示
  drop('这不是 json');
  await wait(150);
  const bar = d.querySelector<HTMLElement>('#replay');
  assert.ok(!bar || bar.hidden, '读不了的文件不该进复盘模式');
  const toastText = (d.querySelector('#toast')?.textContent ?? '') + (d.body.textContent ?? '');
  assert.ok(toastText.includes('JSON') || toastText.includes('json'), '提示里要说清不是 JSON');

  // 是 JSON 但没有动作序列（老报告）：提示要指出缺的是"动作序列"
  drop(JSON.stringify({ seed: 1, board: { w: 8, h: 8 } }));
  await wait(150);
  assert.ok(!bar || bar.hidden, '没有动作序列也不该进复盘模式');
  assert.ok(
    (d.body.textContent ?? '').includes('动作序列'),
    '缺动作序列时要说清缺的是这个，而不是笼统说"文件不对"',
  );
});

check('首页：第一次来把教程摆主位，老玩家仍是开始对局，教程入口一直在', () => {
  /*
   * 新手第一眼该看见「先学三分钟」，而不是「开始对局」——后者会把他直接扔进
   * 两页开局面板。但教程入口不能对老玩家消失：那是"想进去复习"的唯一入口，
   * 也是作者自己进去看的入口。
   */
  const base = {
    hasSave: false,
    version: '0.0.0-test',
    onNew: () => {},
    onTutorial: () => {},
    onContinue: () => {},
    onOnline: () => {},
    onManual: () => {},
    onEditor: () => {},
    onImport: () => {},
    onReplay: () => {},
  };

  // 第一次来
  const h1 = doc.createElement('div');
  doc.body.appendChild(h1);
  const c1 = openTitle(h1, { ...base, firstVisit: true });
  const acts1 = Array.from(h1.querySelectorAll<HTMLElement>('.title-actions .title-btn'));
  assert.equal(acts1[0]?.dataset.title, 'tutorial', '第一次来：教程排第一');
  assert.ok(acts1[0]?.classList.contains('primary'), '第一次来：教程是主按钮');
  assert.equal(doc.activeElement, acts1[0], '焦点要落在主按钮上');
  assert.equal(acts1[1]?.dataset.title, 'new', '「开始对局」退第二');
  c1();

  // 老玩家
  const h2 = doc.createElement('div');
  doc.body.appendChild(h2);
  const c2 = openTitle(h2, { ...base, hasSave: true });
  const acts2 = Array.from(h2.querySelectorAll<HTMLElement>('.title-actions .title-btn'));
  assert.equal(acts2[0]?.dataset.title, 'new', '老玩家：开始对局在主位');
  assert.ok(acts2[0]?.classList.contains('primary'));
  assert.ok(
    acts2.some((b) => b.dataset.title === 'tutorial'),
    '老玩家也要留教程入口（复习、作者自己进去看都靠它）',
  );
  c2();
});

check('新手教程：从首页点进去，棋盘换成 12×12 教学局，卡片跟着出现', () => {
  /*
   * 这条测的是**接线**：入口在首屏、点了会换局、换出来的确实是教学局。
   * 上面那条只测卡片自己，测不到"main.ts 有没有把教程接上"——
   * 而接线断了正是这种功能最容易出的问题（卡片能写，入口没人点得到）。
   */
  const w = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', {
    url: 'http://localhost/',
    pretendToBeVisual: true,
    runScripts: 'outside-only',
  }).window;
  if (!w.structuredClone) {
    (w as unknown as { structuredClone: typeof structuredClone }).structuredClone = structuredClone;
  }
  w.eval(code);
  const d = w.document;

  const entry = d.querySelector<HTMLElement>('[data-title="tutorial"]');
  assert.ok(entry, '首页要有「新手教程」入口');
  entry!.click();

  assert.ok(d.querySelector('.tut-card'), '点了教程之后教练卡片要出现');
  assert.ok((d.body.textContent ?? '').includes('赢的条件'), '第一句要讲清胜利条件是破城');
  assert.equal(d.querySelectorAll('#board .tile').length, 144, '教学局应该是 12×12（144 格）');
  assert.ok(!d.querySelector('.title-screen'), '进教程要撤掉首页');

  // 敌城要"一个整块的红框"，不是四个格子各描一圈（那样交界处有线、中间有个十字）
  const ringed = Array.from(d.querySelectorAll<HTMLElement>('#board .city-block.tut-city-ring'));
  assert.equal(ringed.length, 1, '只有敌城挂红框');
  assert.ok(ringed[0]!.className.includes('owner-B'), '挂红框的必须是对面那座城');
  assert.equal(
    d.querySelectorAll('#board .tile.tut-ring').length,
    0,
    '第一步不该给任何格子描边（城市靠整块红框指出来）',
  );
});

check('新手教程：第三步只放行「走完能贴着对手」的格子', () => {
  /*
   * 教程第三步是"走过去"，第四步是"打他"。如果允许朝任意方向走，玩家走反了就
   * 永远够不着——教程不倒退，只能卡在那一步。所以这一步只放行贴着农民的落点。
   */
  const host = doc.createElement('div');
  doc.body.appendChild(host);
  const state = createTutorialMatch();
  tutorialStart({ apply: () => {}, exit: () => tutorialExit() }, host);
  tutorialSnapshot(state);
  tutorialTick(state, null);
  doc.querySelector<HTMLElement>('[data-tut="next"]')!.click(); // 讲解步 → 选中
  tutorialTick(state, 'tut-mine');                              // 选中 → 走过去
  assert.equal(tutorialStep(), 'move');

  assert.equal(tutorialAllowsMove(state, 4, 6), true, '走到农民旁边要放行');
  assert.equal(tutorialAllowsMove(state, 2, 8), false, '往回走要拦住（走完够不着农民）');
  tutorialExit();
});

check('新手教程：看地形 / 升级城市 / 造兵 都按「真的做到了」判定', () => {
  /*
   * 这三步的共同点是"动作发生在面板里"，教程看不见点击，只能看结果：
   *   · 看地形 → selectedTile 变了；
   *   · 升级   → 自家城的时代 +1；
   *   · 造兵   → 我方单位数 +1。
   * 用 tutorialGoto 直接落到那一步，免得布景代码盖住断言。
   */
  const host = doc.createElement('div');
  doc.body.appendChild(host);
  let s = createTutorialMatch();
  tutorialStart({ apply: () => {}, exit: () => tutorialExit() }, host);
  tutorialSnapshot(s);
  const tick = (sel: string | null = null, tile: { x: number; y: number } | null = null): string => {
    tutorialTick(s, sel, tile);
    return tutorialStep();
  };

  // 看地形：点一格空地才过
  tutorialGoto('terrain');
  tutorialSnapshot(s);
  assert.equal(tick(null, null), 'terrain', '没点格子不该过');
  assert.equal(tick(null, { x: 9, y: 9 }), 'attack', '点了一格就该过');

  // 升级城市：时代真的变了才过
  tutorialGoto('upgrade');
  tutorialSnapshot(s);
  const home = s.cities.find((c) => c.owner === 'A')!;
  const era0 = home.era;
  assert.equal(tick(), 'upgrade', '还没升级不该过');
  const up = applyAction(s, { type: 'UPGRADE', cityId: home.id });
  assert.ok(up.ok, '教程局的钱应该够升一次级');
  s = up.state;
  assert.equal(s.cities.find((c) => c.id === home.id)!.era, era0 + 1);
  assert.equal(tick(), 'recruit', '升完级就进造兵');

  // 造兵：我方单位数 +1 才过
  tutorialSnapshot(s);
  const n0 = unitsOf(s, 'A').length;
  assert.equal(tick(), 'recruit', '还没造兵不该过');
  const rec = applyAction(s, { type: 'RECRUIT', cityId: home.id, unitType: 'militia' });
  assert.ok(rec.ok, '教程局应该造得出民兵');
  s = rec.state;
  assert.equal(unitsOf(s, 'A').length, n0 + 1);
  assert.equal(tick(), 'siege', '造完兵就进攻城');

  tutorialExit();
});

check('新手教程：卡片一步步推进，做到才换下一步，跳过就收起来', () => {
  /*
   * 教程的全部价值在"它知道你做到了没有"。这条守三件事：
   *   1. 讲解步（没有判定条件）可以手动「继续」；
   *   2. 操作步必须**真的做到**才前进——这里用 selectedId 模拟"选中了兵"；
   *   3. 「跳过教程」能把卡片收干净，并把控制权交回 main。
   */
  const host = doc.createElement('div');
  doc.body.appendChild(host);
  let exited = 0;
  const state = createTutorialMatch();
  tutorialStart({ apply: () => {}, exit: () => { exited += 1; tutorialExit(); } }, host);
  tutorialSnapshot(state);
  tutorialTick(state, null);

  const card = doc.querySelector<HTMLElement>('.tut-card');
  assert.ok(card, '卡片要挂上');
  assert.ok((card.textContent ?? '').includes('赢的条件'), '第一步先讲胜利条件（破城，不是杀光）');
  assert.equal(tutorialStep(), 'goal');
  // 讲解页棋盘不许动：没点「继续」就能走棋的话，兵先走偏，后面几步全对不上
  assert.equal(tutorialBlocking(), true, '讲解页要拦住所有动作');

  // 讲解步：点「继续」进下一步
  card.querySelector<HTMLElement>('[data-tut="next"]')!.click();
  assert.equal(tutorialStep(), 'select', '点「继续」要进到「选中你的兵」');
  assert.equal(tutorialBlocking(), false, '操作页要放行动作');
  assert.ok(!doc.querySelector<HTMLElement>('[data-tut="next"]')!.hidden === false, '操作步的「继续」要收起来');

  // 没选中之前不动
  tutorialTick(state, null);
  assert.equal(tutorialStep(), 'select', '没选中兵不该前进');

  // 选中之后自动进到「走过去」
  tutorialTick(state, 'tut-mine');
  assert.equal(tutorialStep(), 'move', '选中之后应该自动进到「走过去」');

  // 跳过：卡片撤掉、控制权交回
  doc.querySelector<HTMLElement>('[data-tut="skip"]')!.click();
  assert.equal(exited, 1, '跳过要交回控制权');
  assert.equal(tutorialOn(), false);
  assert.ok(!doc.querySelector('.tut-card'), '卡片要撤干净');
});

check('新手教程：照卡片走能赢——移动/攻击/结束回合/攻城/入驻接管', () => {
  /*
   * 教程局必须**真的能打通**，而且只用教程里教过的动作。
   * 这条同时是场景的回归测试：城市耐久、坐标、废墟接管这几样任何一项改坏，
   * 新手就会卡在最后一步——那是比红用例更糟的事故（红了没人看得见）。
   */
  let s = createTutorialMatch();
  const act = (a: Parameters<typeof applyAction>[1], tag: string): void => {
    const r = applyAction(s, a);
    assert.ok(r.ok, `${tag} 应该合法：${r.ok ? '' : (r as { reason: string }).reason}`);
    s = r.state;
  };
  const mine = (): { id: string; x: number; y: number } => unitsOf(s, 'A')[0] as never;
  const foeCity = (): { id: string; hp: number; ruined?: boolean; x: number; y: number } =>
    s.cities.find((c) => c.owner === 'B') as never;

  act({ type: 'MOVE', unitId: mine().id, x: 4, y: 6 }, '走到诱饵旁边');
  act({ type: 'ATTACK', unitId: mine().id, targetId: unitsOf(s, 'B')[0]!.id }, '攻击诱饵');
  act({ type: 'END_TURN' }, '结束回合');
  act({ type: 'END_TURN' }, '对面结束回合（教程代按）');
  act({ type: 'MOVE', unitId: mine().id, x: 5, y: 5 }, '走到城下');

  for (let i = 0; i < 4 && !s.winner; i++) {
    if (!foeCity().ruined) act({ type: 'SIEGE', unitId: mine().id, cityId: foeCity().id }, `第 ${i + 1} 次攻城`);
    if (s.winner) break;
    act({ type: 'END_TURN' }, '结束回合');
    act({ type: 'END_TURN' }, '对面结束回合');
  }
  assert.equal(foeCity().ruined, true, '两次攻城之后城应该塌成废墟');

  // 废墟要派兵入驻才算接管
  act({ type: 'MOVE', unitId: mine().id, x: 5, y: 4 }, '走进废墟接管');
  assert.equal(s.winner, 'A', '入驻之后这局就该结束了');
});

check('战报卡：破城回合 / MVP / 关键三步都从局面上算得出来', () => {
  /*
   * 用教程局走到底（它本身就是一局"破城获胜"的完整局），然后出卡。
   * 三个数各自有明确的来源，不能靠文案：
   *   破城回合 → city.capturedTurn；MVP → killTally（规则层记的按兵种人头账）；
   *   关键三步 → 局面事实。
   *
   * MVP 这条以前是**只写在标题里、没人验**的：它读 `unit.kills`，而那个字段
   * 只有「老兵不死」扩展在写，于是普通对局里恒为 0，卡面永远是"没有击杀"。
   * 现在人头由 rules 的 creditKill 统一记，这条用例正好把它钉住。
   */
  let s = createTutorialMatch();
  const act = (a: Parameters<typeof applyAction>[1]): void => {
    const r = applyAction(s, a);
    assert.ok(r.ok, `动作应该合法：${(r as { reason?: string }).reason ?? ''}`);
    s = r.state;
  };
  const mine = (): { id: string } => unitsOf(s, 'A')[0] as never;
  const foeCity = (): { id: string; ruined?: boolean } => s.cities.find((c) => c.owner === 'B') as never;

  act({ type: 'MOVE', unitId: mine().id, x: 4, y: 6 });
  act({ type: 'ATTACK', unitId: mine().id, targetId: unitsOf(s, 'B')[0]!.id });
  act({ type: 'END_TURN' });
  act({ type: 'END_TURN' });
  act({ type: 'MOVE', unitId: mine().id, x: 5, y: 5 });
  for (let i = 0; i < 4 && !s.winner; i++) {
    if (!foeCity().ruined) act({ type: 'SIEGE', unitId: mine().id, cityId: foeCity().id });
    if (s.winner) break;
    act({ type: 'END_TURN' });
    act({ type: 'END_TURN' });
  }
  act({ type: 'MOVE', unitId: mine().id, x: 5, y: 4 });
  assert.equal(s.winner, 'A');

  const card = buildBattleCard(s, 'A', 'test');
  assert.equal(card.iWon, true);
  assert.equal(card.winner, 'A');
  assert.ok(card.winTurn !== null && card.winTurn! > 0, `破城回合应该是个正数，实际 ${card.winTurn}`);
  assert.equal(card.steps.length, 3, '关键三步就是三条');
  assert.ok(card.steps[1]!.includes('拿下第一座城'), '第二条讲破城');
  assert.equal(card.sides.length, 2, '两人局两张席位');
  // 教程局那一刀没打死人（诱饵农民还剩 4 血），所以这里**该**是空 MVP。
  // 反过来钉住"没击杀就别编一个 MVP 出来"——卡面会印成"没有击杀"。
  assert.equal(card.mvp, null, '一局没打死过人就该是空 MVP，不能拿存活最多的兵充数');
  assert.ok(battleCardText(card).includes('MVP：这一局没有击杀'), '文案要如实说没击杀');
  assert.ok(battleCardText(card).includes('战报'), '复制出去的文案要有抬头');
  assert.ok(
    battleCardText(card).startsWith('【战报】胜利'),
    `抬头要用「胜利」而不是「我赢了」，实际：${battleCardText(card).split('\n')[0]}`,
  );
  assert.ok(!battleCardText(card).includes('我赢'), '复制出去的文案也不许用第一人称');
});

check('战报卡：MVP 来自规则层的人头账，不开「老兵不死」也有', () => {
  /*
   * 这条钉的就是这个字段最初坏掉的地方：MVP 原来只读 `unit.kills`，
   * 而那个字段只有「老兵不死」扩展在维护——于是没开那个包的对局里，
   * 卡面永远写"没有击杀"，而且连"杀了五个人之后自己倒下"的老兵也一起不算。
   *
   * 现在人头由 rules 的 creditKill 统一记（单位身上一份 + 局级 killTally 一份），
   * 这里验三件事：记上了、按兵种合并、击杀者自己阵亡也不丢。
   */
  let s = createMatch({ ...DEFAULT_CONFIG, size: 12, startEra: 1, expansionIds: [] }, 4321);
  s.units = [];
  const put = (owner: 'A' | 'B', type: string, x: number, y: number, hp?: number) => {
    const def = s.unitTypes[type]!;
    const u = {
      id: `t-${owner}-${type}-${x}-${y}`,
      type,
      owner,
      x,
      y,
      hp: hp ?? def.maxHp,
      kills: 0,
      atkBonus: 0,
      moved: false,
      acted: false,
    };
    s.units.push(u as never);
    return u;
  };

  const hero = put('A', 'militia', 5, 5);
  hero.atkBonus = 99; // 一刀一个，省得摆一串靶子
  const prey = put('B', 'militia', 6, 5, 1);
  s.current = 'A';
  let r = applyAction(s, { type: 'ATTACK', unitId: hero.id, targetId: prey.id });
  assert.ok(r.ok, r.ok ? '' : (r as { reason: string }).reason);
  s = r.state;

  let card = buildBattleCard(s, 'A', 'test');
  assert.ok(card.mvp, '打死了人就必须有 MVP——以前这里恒为 null');
  assert.equal(card.mvp!.type, 'militia');
  assert.equal(card.mvp!.kills, 1, `MVP 该记 1 个人头，实际 ${card.mvp!.kills}`);
  assert.ok(battleCardText(card).includes('MVP：民兵'), '文案和卡面读同一份数据');

  // 击杀者自己倒下之后：单位身上那份跟着没了，局级账不能丢
  const avenger = put('B', 'militia', 5, 6);
  avenger.atkBonus = 99;
  s.current = 'B';
  r = applyAction(s, { type: 'ATTACK', unitId: avenger.id, targetId: hero.id });
  assert.ok(r.ok, r.ok ? '' : (r as { reason: string }).reason);
  s = r.state;
  assert.equal(s.units.some((u) => u.id === hero.id), false, 'MVP 本人应该已经阵亡');
  card = buildBattleCard(s, 'A', 'test');
  assert.ok(card.mvp, '杀的兵死了，人头还得留在账上');
  assert.equal(card.mvp!.kills, 1);
  assert.equal(card.mvp!.alive, 0, '终局存活 0 也要如实写进卡面');
});

check('战报卡：卡片能打开、能关掉，画不出图时退回纯文字', () => {
  /*
   * jsdom 没有 2D 画布，所以这条同时验"降级路径"：没有图也要有文字，
   * 不能给玩家一个空壳弹窗。
   */
  const host = doc.createElement('div');
  doc.body.appendChild(host);
  const s = createTutorialMatch();
  const card = buildBattleCard(s, 'A', 'test');
  const close = openBattleCard(card, host);
  const mask = host.querySelector('.bc-mask');
  assert.ok(mask, '卡片要盖上来');
  assert.ok((mask!.textContent ?? '').includes('战报卡'), '要有抬头');
  assert.ok(host.querySelector('.bc-fallback'), '画不出图时要退回纯文字');
  assert.ok((host.querySelector('.bc-fallback')!.textContent ?? '').includes('战报'), '降级文本要真有内容');
  host.querySelector<HTMLElement>('[data-bc="close"]')!.click();
  assert.ok(!host.querySelector('.bc-mask'), '点关闭要撤掉');
  close();
});

check('战报卡：入口只看「打没打完」，不看结算卡那套条件', () => {
  /*
   * 这条挡的是一个很贵的错：战报卡原来挂在结算卡（`report`）上，而结算卡
   * 在上帝模式里是**不给**的——上帝模式又恰好是自家玩得最多的地方。
   * 于是"越常用的模式越看不到产出"。两个区块的可见条件本来就不该是同一个。
   */
  const host = doc.createElement('div');
  doc.body.appendChild(host);
  const st = createMatch({ ...DEFAULT_CONFIG, size: 12, startEra: 1, expansionIds: [] }, 4321);
  const paint = (extra: Record<string, unknown> = {}) =>
    renderPanel(host, {
      view: playerView(st, 'A'),
      me: 'A',
      selectedUnit: null,
      selectedCityId: null,
      selectedCampId: null,
      selectedTile: null,
      ...extra,
    });

  try {
    // 还在打：没有入口
    paint();
    assert.equal(host.querySelector('[data-act="battle-card"]'), null, '没打完就不该有入口');
    // 打完了，但结算卡因为"沙盒"被挡掉（report 不传）——入口仍然要在
    paint({ battleCard: true });
    assert.ok(host.querySelector('[data-act="battle-card"]'), '打完了就要有入口，哪怕结算卡不给');
    assert.equal(host.querySelector('.report-card'), null, '这一条同时确认结算卡确实没渲染');
  } finally {
    host.remove();
  }
});

check('战报卡：卡面每一笔都画在卡片里，没顶出边', () => {
  /*
   * 为什么不用截图比：jsdom 没有 2D 画布，而卡面排版的错（右边那串数字叠在
   * 兵种名尾巴上、玩家名太长把页脚顶出卡片）恰恰只在**真的有字宽**时才出现。
   *
   * 办法是给一个有量宽能力的假 ctx：CJK 按 1em 算、半角按 0.55em 算。
   * 不追求像素级正确（那要真字体），只求"每一笔的右边界有没有越线"能判出来。
   * 这比人工肉眼看一遍更稳——将来改字号、加字段，这条会自动报警。
   */
  const draws: { text: string; x: number; y: number; w: number; size: number }[] = [];
  let fontPx = 16;
  const ctx = {
    fillStyle: '', strokeStyle: '', lineWidth: 1, font: '16px sans-serif', textBaseline: 'top',
    beginPath() {}, moveTo() {}, arcTo() {}, closePath() {}, fill() {}, stroke() {},
    fillRect() {},
    fillText(text: string, x: number, y: number) {
      draws.push({ text, x, y, w: measure(text, fontPx), size: fontPx });
    },
    measureText(text: string) { return { width: measure(text, fontPx) }; },
  };
  const measure = (text: string, px: number): number => {
    let n = 0;
    for (const ch of text) {
      const c = ch.codePointAt(0) ?? 0;
      n += c >= 0x2e80 ? px : px * 0.55;
    }
    return n;
  };
  // font 字符串里的 px 要跟着每次赋值走：画卡的人写的是 '800 64px ...'
  const fakeCtx = new Proxy(ctx, {
    set(t, k, v) {
      if (k === 'font' && typeof v === 'string') {
        const m = /(\d+(?:\.\d+)?)px/.exec(v);
        if (m) fontPx = Number(m[1]);
      }
      return Reflect.set(t, k, v);
    },
  });
  const canvas = { width: 0, height: 0, getContext: () => fakeCtx };
  const fakeDoc = { createElement: () => canvas } as unknown as Document;

  const st = createTutorialMatch();
  const W0 = drawBattleCard(buildBattleCard(st, 'A', '9.9.9'), fakeDoc);
  assert.ok(W0, '有 2D 上下文就要能画出画布');
  assert.ok(draws.length >= 8, `卡面该有十来个字块，实际画了 ${draws.length}`);

  const canvasW = canvas.width;
  const canvasH = canvas.height;
  const scan = (label: string): void => {
    const over = draws.filter(
      (x) => x.x < 20 || x.x + x.w > canvasW - 20 || x.y < 20 || x.y + x.size > canvasH - 16,
    );
    assert.equal(
      over.length,
      0,
      `${label}：这些字块越界了：${over
        .map((x) => `"${x.text}"@${Math.round(x.x)},${Math.round(x.y)}`)
        .join(' / ')}`,
    );
    assert.ok(draws.some((x) => x.text.includes('战报')), `${label}：抬头要有「战报」两个字`);
  };
  scan('平局那张');
  assert.ok(draws.some((x) => x.text === '平局'), '平局那一档的标题就是「平局」');

  /*
   * 再画一张赢局：这一档才是最常见的样子（大号破城回合 + 右侧击杀数）。
   * 回合数故意给三位数，破城数字是卡面上最宽的一笔，位数一变最容易顶出去。
   */
  draws.length = 0;
  drawBattleCard(
    {
      winner: 'A',
      me: 'A',
      iWon: true,
      board: '32×32',
      turns: 140,
      winTurn: 137,
      mvp: { type: 'knight', name: '星界龙骑士', kills: 12, alive: 3 },
      steps: [
        '开局：32×32，第 1 代起手，7 个扩展',
        '第 137 回合你拿下第一座城：北境的铁堡（旧名：灰石哨站）',
        '第 140 回合定局：9 兵对 3 兵，血量 214 对 66',
      ],
      sides: [
        { side: 'A', name: '我', units: 9, cities: 4, hp: 214, era: 5 },
        { side: 'B', name: '电脑·高级', units: 3, cities: 1, hp: 66, era: 4 },
      ],
      seed: 2091374821,
      build: '0.3.47',
    } as Parameters<typeof drawBattleCard>[0],
    fakeDoc,
  );
  scan('赢局那张');
  // 卡面是拿来转发的：标题用「胜利 / 失败」，不能写「我赢了 / 我输了」——
  // 第一人称到了别人手里会被读成他自己赢了。
  assert.ok(draws.some((x) => x.text === '胜利'), '赢局标题要用「胜利」');
  assert.ok(!draws.some((x) => x.text.includes('我赢') || x.text.includes('我输')), '卡面不许出现第一人称的胜负');
});

console.log('\n选卡预览与撤回位置');

check('对局中选卡模式下，点自己/对面的城会显示对应的名单预览', () => {
  const st = createMatch({ ...DEFAULT_CONFIG, size: 12, startEra: 1, draftMode: true }, 4321);
  assert.ok(st.draft, '选卡模式应该有 draft');
  st.draft!.skipped = false;
  st.draft!.picks = { ...st.draft!.picks, A: ['militia', 'archer'], B: ['spearman', 'militia'] };

  const own = st.cities.find((c) => c.owner === 'A')!;
  const foe = st.cities.find((c) => c.owner === 'B')!;

  const paint = (cityId: string) => {
    const host = doc.createElement('div');
    renderPanel(host, {
      view: playerView(st, 'A'),
      me: 'A',
      selectedUnit: null,
      selectedCityId: cityId,
      selectedCampId: null,
      selectedTile: null,
    });
    return host;
  };

  // 自己的城：显示自己那一方（is-a）
  const mineHost = paint(own.id);
  assert.ok(mineHost.querySelector('.draft-picked.is-a'), '点自己的城该出自己那一方的清单');
  assert.ok(!mineHost.querySelector('.draft-picked.is-b'), '点自己的城不该冒出对面的清单');
  assert.ok((mineHost.textContent ?? '').includes('选到的卡'), '标题要说明这是选到的卡');
  assert.ok((mineHost.textContent ?? '').includes(`2 / ${st.draft!.pickSlots}`), '要写出选了几张');

  // 对面的城：显示对面那一方（is-b），而且和选卡界面用同一套卡片样式
  const foeHost = paint(foe.id);
  const block = foeHost.querySelector('.draft-picked.is-b');
  assert.ok(block, '点对面的城该出对面那一方的清单');
  assert.ok(!foeHost.querySelector('.draft-picked.is-a'), '点对面的城不该显示自己的清单');
  assert.ok(block!.querySelector('.draft-pick'), '卡片要复用选卡界面那套 .draft-pick 结构');
});

check('「撤回一步」离开「结束回合」那一块，两处点击区域不重叠', () => {
  const st = createMatch({ ...DEFAULT_CONFIG, size: 12 }, 4321);
  const host = doc.createElement('div');
  renderPanel(host, {
    view: playerView(st, 'A'),
    me: 'A',
    selectedUnit: null,
    selectedCityId: null,
    selectedCampId: null,
    selectedTile: null,
    canUndo: true,
  });

  const undo = host.querySelector('[data-act="undo"]');
  const endTurn = host.querySelector('[data-act="end-turn"]');
  assert.ok(undo, '撤回按钮还得在');
  assert.ok(endTurn, '结束回合按钮还得在');
  assert.ok(undo!.closest('.undo-row'), '撤回要在顶部那一行里');
  assert.ok(!undo!.closest('.side-footer'), '撤回不许留在结束回合所在的那一块');
  assert.ok(!undo!.closest('.side-actions'), '撤回不许和认输挤同一排');
  // 两颗按钮不在同一个父节点下，就不可能叠在一起
  assert.notEqual(undo!.parentElement?.parentElement, endTurn!.parentElement, '两颗按钮不该共用一个容器');
});

check('月球基地：卡上有采样技能和倒计时，月面的工程队有「展开」按钮', () => {
  /*
   * 登月胜利只有两个交互：月面上「展开月球基地」、基地上「月壤采样」。
   * 它们分别是单位动作和主动技能——两条不同的渲染路径，都在这条里钉住。
   */
  const st = createMatch({ ...DEFAULT_CONFIG, size: 16, startEra: 5, expansionIds: ['space-age'] }, 7793);
  for (const t of st.tiles) if (t.terrain !== 'water' && t.terrain !== 'deep') t.terrain = 'plain';
  st.units = st.units.filter((u) => u.x !== 4 || u.y !== 4);
  const base = {
    id: 'base-test',
    type: 'moon-base',
    owner: 'A',
    x: 4,
    y: 4,
    hp: 200,
    kills: 0,
    moved: false,
    acted: false,
    board: 'moon',
    custom: { sample: 2 },
  };
  st.units.push(base as never);

  const host = doc.createElement('div');
  doc.body.appendChild(host);
  try {
    renderPanel(host, {
      view: playerView(st, 'A'),
      me: 'A',
      selectedUnit: base as never,
      selectedCityId: null,
      selectedCampId: null,
      selectedTile: null,
    });
    const text = host.textContent ?? '';
    assert.ok(text.includes('还剩 2 个回合'), `倒计时要在卡上，实际：${text.slice(0, 120)}`);
    const btn = host.querySelector('[data-act="hero-skill"][data-skill="lunar-sampling"]');
    assert.ok(btn, '「月壤采样」按钮不见了');

    // 换成月面上的工程队：该出现「展开月球基地」
    st.units = st.units.filter((u) => u.id !== 'base-test');
    const crew = {
      id: 'crew-moon',
      type: 'crew',
      owner: 'A',
      x: 6,
      y: 6,
      hp: 30,
      kills: 0,
      moved: false,
      acted: false,
      board: 'moon',
    };
    st.units.push(crew as never);
    renderPanel(host, {
      view: playerView(st, 'A'),
      me: 'A',
      selectedUnit: crew as never,
      selectedCityId: null,
      selectedCampId: null,
      selectedTile: null,
    });
    assert.ok(
      host.querySelector('[data-action="base:deploy"]'),
      '月面工程队该有「展开月球基地」按钮',
    );
  } finally {
    host.remove();
  }
});

check('切图：同一块画布换成另一张图的尺寸与格子', () => {
  const host = doc.createElement('div');
  host.className = 'board';
  doc.body.appendChild(host);
  const st = createMatch({ ...DEFAULT_CONFIG, size: 12, startEra: 2, expansionIds: [] }, 9192);
  const earth = playerView(st, 'A');
  try {
    renderBoard(host, earth, { ...emptyUi });
    assert.equal(host.querySelectorAll('.tile').length, 144, '地球 12×12');
    assert.equal(host.style.getPropertyValue('--cols'), '12');

    // 一张 3×3 的小图：格子层必须按它自己的尺寸重建，不能残留地球的 144 格
    const tiles = Array.from({ length: 9 }, (_, i) => ({
      terrain: i === 4 ? 'forest' : 'plain',
      cityId: null,
    }));
    const moon = {
      ...earth,
      state: { ...earth.state, w: 3, h: 3, tiles, units: [], cities: [], marks: [] },
      visible: Array.from({ length: 9 }, (_, i) => i),
      visibleByBoard: { earth: earth.visible, moon: Array.from({ length: 9 }, (_, i) => i) },
      rememberedTiles: new Map(),
      rememberedByBoard: {},
      ghosts: [],
    };
    renderBoard(host, moon as never, { ...emptyUi });
    assert.equal(host.querySelectorAll('.tile').length, 9, '切到 3×3 要重建格子层');
    assert.equal(host.style.getPropertyValue('--cols'), '3');

    // 切回地球：还是 144，不是 9
    renderBoard(host, earth, { ...emptyUi });
    assert.equal(host.querySelectorAll('.tile').length, 144, '切回来要回到 12×12');
  } finally {
    host.remove();
  }
});

check('火箭发射井：属性卡写着燃料与货舱，加注/发射按钮都在', () => {
  /*
   * 发射井的全部交互都在侧栏：货舱是现成的那套（装载/卸载），
   * 加注和发射是扩展给的两个按钮。这条钉"它们真的画出来了"——
   * 规则层的用例只能验状态，验不了这对按钮有没有长在卡上。
   */
  const st = createMatch({ ...DEFAULT_CONFIG, size: 16, startEra: 5, expansionIds: ['space-age'] }, 7781);
  for (const t of st.tiles) if (t.terrain !== 'water' && t.terrain !== 'deep') t.terrain = 'plain';
  const silo = {
    id: 'silo-test',
    type: 'rocket_silo',
    owner: 'A',
    x: 6,
    y: 6,
    hp: 120,
    kills: 0,
    moved: false,
    acted: false,
  };
  st.units = st.units.filter((u) => !(u.x === 6 && u.y === 6));
  st.units.push(silo as never);

  const host = doc.createElement('div');
  doc.body.appendChild(host);
  try {
    renderPanel(host, {
      view: playerView(st, 'A'),
      me: 'A',
      selectedUnit: silo as never,
      selectedCityId: null,
      selectedCampId: null,
      selectedTile: null,
    });
    const text = host.textContent ?? '';
    assert.ok(text.includes('燃料 0 / 3'), `燃料进度要写在卡上，实际：${text.slice(0, 120)}`);
    assert.ok(text.includes('货舱：空'), '货舱状态要写在卡上');
    assert.ok(host.querySelector('[data-action="silo:fuel"]'), '加注按钮不见了');
    assert.ok(host.querySelector('[data-action="silo:launch"]'), '发射按钮不见了');
    // 没燃料、没货：发射必须是禁用的，而不是点了才说不行
    assert.equal(
      host.querySelector('[data-action="silo:launch"]')!.hasAttribute('disabled'),
      true,
      '条件不齐时发射按钮该是灰的',
    );
  } finally {
    host.remove();
  }
});

console.log(`\n通过 ${passed} 项，失败 ${failed} 项\n`);
if (failed > 0) process.exit(1);
