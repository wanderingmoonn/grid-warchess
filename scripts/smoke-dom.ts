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

import { UNIT_TYPES } from '../src/core/config.ts';
import { playerView } from '../src/core/fog.ts';
import { EXPANSIONS, unitSourceIdOf } from '../src/core/expansions.ts';
import { draftScreenHtml } from '../src/ui/draft-panel.ts';
import { createMatch, DEFAULT_CONFIG } from '../src/core/setup.ts';
import {
  applyAction,
  effectiveStats,
  reachableTiles,
  refreshMemory,
  unitIncomeAt,
} from '../src/core/rules.ts';
import { renderPanel } from '../src/ui/panel.ts';
import { godShelfHtml } from '../src/ui/god-panel.ts';
import { renderBoard } from '../src/ui/board.ts';
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

function unitsCount(): number {
  return doc.querySelectorAll('.unit').length;
}

console.log('\n首屏渲染');

check('默认棋盘是古典标准尺寸 12×12，铺满 144 格', () => {
  // 时代和棋盘尺寸是配套的：古典 12×12、中世 16×16、火药及以后 20×20
  assert.equal(doc.querySelectorAll('.tile').length, 144);
});

check('首屏只渲染己方棋子，敌方在视野外被裁掉', () => {
  assert.equal(doc.querySelectorAll('.unit.owner-A').length, 7, '5 个战斗单位 + 2 个经济单位');
  // 12×12 的标准图上两军离得近，偶尔能看见一个贴边的敌人——那是正常的。
  // 这条断言要守的是"看不全"，不是"一个都看不见"。
  const foe = doc.querySelectorAll('.unit.owner-B').length;
  assert.ok(foe <= 2, `敌方不该整队出现，实际看见 ${foe} 个`);
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
    renderBoard(host, view, { ...emptyUi, incomeHints: new Map([[i, 7]]) });
    assert.ok(host.querySelector(`.tile${sel} .tile-income`)?.textContent === '+7', '角标要写对数字');
    renderBoard(host, view, { ...emptyUi, incomeHints: new Map([[i, 9]]) });
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

check('多动兵的面板写"还剩几次"，不是"几段"', () => {
  // 多动的次数是这回合的剩余资源，玩家得看得见才能决定"这一发打谁"。
  // 顺带钉住旧说法：面板上不能再出现"每段独立减甲"——那是被否掉的模型。
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
  assert.ok(text.includes('多动'), '多动兵的侧栏要写出这件事');
  assert.ok(text.includes(`还剩 ${burst} / ${burst} 次`), '还没出手时应该显示满次数');
  assert.ok(!text.includes('每段'), '不能再出现"每段"这种旧口径');

  // 打掉一发之后，面板要跟着变——不然玩家会以为还能再打满一轮
  (mine as Unit & { attacksLeft?: number }).attacksLeft = burst - 1;
  paint();
  text = host.textContent ?? '';
  assert.ok(text.includes(`还剩 ${burst - 1} / ${burst} 次`), '出手之后剩余次数要跟着减');
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

console.log('\n单位交互');

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
  assert.ok(html.includes('每回合产出'), '应该显示产出说明');
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
  const hints = new Map<number, number>();
  for (const i of reach) {
    hints.set(i, unitIncomeAt(st, farmer, i % st.w, Math.floor(i / st.w)));
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
    assert.equal(badges.length, reach.length, '每个可达格都该有一个产出数字');
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
      const shown = Number((badge.textContent ?? '+0').slice(1));
      assert.equal(shown, hints.get(idx), `第 ${idx} 格印的是 ${shown}，真相源是 ${hints.get(idx)}`);
      matched += 1;
    }
    assert.ok(matched > 0, '总得对上一格');
  } finally {
    host.remove();
  }
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

check('城市里不再直接产建筑', () => {
  const html = doc.querySelector('.side')?.innerHTML ?? '';
  assert.ok(!html.includes('自动开火'), '建筑不该出现在城市生产列表里');
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
  // 先造一个劳工
  const buttons = Array.from(doc.querySelectorAll<HTMLElement>('.recruit-btn'));
  const laborerBtn = buttons.find((b) => (b.textContent ?? '').includes('劳工'));
  assert.ok(laborerBtn, '城市里应该能造劳工');
  laborerBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

  const units = Array.from(doc.querySelectorAll<HTMLElement>('.unit'));
  const laborer = units.find((u) => (u.textContent ?? '').trim().startsWith('工'));
  assert.ok(laborer, '场上应该出现劳工');
  laborer.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

  const html = doc.querySelector('.side')?.innerHTML ?? '';
  assert.ok(html.includes('可建造'), '应该有可建造列表');
  assert.ok(html.includes('箭塔'), '劳工应该能建箭塔');
  assert.ok(html.includes('磨坊'), '劳工应该能建磨坊');
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

console.log('\n开局设置');

check('点新对局会打开设置面板', () => {
  click('[data-act="new-game"]');
  assert.ok(doc.querySelector('.modal-mask'), '应该弹出设置面板');
  assert.ok(doc.querySelectorAll('.expansion-item').length >= 6, '应该列出全部扩展规则');
  assert.ok(doc.querySelectorAll('[data-size]').length >= 3, '应该能选棋盘大小');
  assert.ok(doc.querySelectorAll('[data-unit]').length >= 4, '应该能选参战兵种');
  assert.ok(doc.querySelector('[data-ai="1"]'), '应该能选人机对战');
  assert.ok(doc.querySelectorAll('[data-era]').length >= 5, '应该能选起始时代');
  // 双人热座的时候选"AI 有多聪明"是没有意义的，这一行不该出现
  assert.equal(doc.querySelector('[data-ailevel]'), null, '热座模式不该有难度选项');
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

check('选起始时代会顺手换成配套的棋盘尺寸', () => {
  // 开局面板这时候已经开着（首屏在没有存档时会自动弹出），不再重复打开
  const activeSize = () =>
    doc.querySelector<HTMLElement>('[data-size].active')?.dataset.size ?? '';

  click('[data-era="1"]');
  assert.equal(activeSize(), '12', '古典应该配 12×12');
  click('[data-era="2"]');
  assert.equal(activeSize(), '16', '中世应该配 16×16');
  click('[data-era="3"]');
  assert.equal(activeSize(), '20', '火药应该配 20×20');
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
  const total = doc.querySelectorAll('[data-unit]').length;
  assert.ok(total >= 4);
  // 兵种 chip 是就地翻转的（不重绘面板），所以还能抓住同一个节点
  for (let i = 0; i < total + 2; i++) {
    const on = doc.querySelector<HTMLElement>('[data-unit].active');
    if (!on) break;
    on.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  }
  assert.equal(doc.querySelectorAll('[data-unit].active').length, 1, '最后应该强制留下一个兵种');
});

check('兵种池按时代分组展示', () => {
  assert.ok(doc.querySelectorAll('.era-group').length >= 3, '三个时代各一组');
  const tags = Array.from(doc.querySelectorAll('.era-tag')).map((n) => n.textContent?.trim());
  // 第五时代叫「二战」（第六时代「现代」的兵全在「现代战争」包里，
  // 而兵种池只列原版 + 自定义兵，所以这里到二战为止）
  assert.deepEqual(tags, ['古典', '中世', '火药', '工业', '二战']);
});

check('起始时代只摆到这一局的上限：勾上「现代」才多出第六格', () => {
  // 第六时代是两个包：'pack-contemporary'「现代」开时代 + 带九个最基本的兵，
  // 'pack-contemporary-war'「现代战争」在它之上加十五个专精兵（requires 前者）。
  // 所以"多出一格"只认底座那个包，加料包自己抬不动上限。
  const erasNow = () =>
    Array.from(doc.querySelectorAll('[data-era]')).map((n) => n.textContent?.trim());
  assert.deepEqual(erasNow(), ['古典', '中世', '火药', '工业', '二战'], '不勾包时五格封顶');

  const warBox = doc.querySelector<HTMLInputElement>('[data-exp="pack-contemporary-war"]');
  assert.ok(warBox, '开局面板里应有「现代战争」这一项');
  warBox.checked = true;
  warBox.dispatchEvent(new window.Event('change', { bubbles: true }));

  // 勾加料包会自动补上它的前置「现代」——所以时代按钮当场多一格。
  // 这一步顺带守住了"勾了兵却造不出来"那个坑。
  assert.deepEqual(
    erasNow(),
    ['古典', '中世', '火药', '工业', '二战', '现代'],
    '加料包会把前置「现代」一起勾上，第六格随之出现',
  );
  const baseBox = doc.querySelector<HTMLInputElement>('[data-exp="pack-contemporary"]');
  assert.ok(baseBox?.checked, '前置「现代」应该被自动勾上');

  // 单独取消加料包：时代还在（底座是独立的一包），第六格不该消失
  const again = doc.querySelector<HTMLInputElement>('[data-exp="pack-contemporary-war"]');
  assert.ok(again);
  again.checked = false;
  again.dispatchEvent(new window.Event('change', { bubbles: true }));
  assert.deepEqual(
    erasNow(),
    ['古典', '中世', '火药', '工业', '二战', '现代'],
    '加料包取消之后，底座还开着——这一代仍然打得完一整局',
  );

  // 把底座也取消：第六格收回去，而且起手时代不能停在一个已经关掉的时代上
  const baseAgain = doc.querySelector<HTMLInputElement>('[data-exp="pack-contemporary"]');
  assert.ok(baseAgain);
  baseAgain.checked = false;
  baseAgain.dispatchEvent(new window.Event('change', { bubbles: true }));
  assert.deepEqual(erasNow(), ['古典', '中世', '火药', '工业', '二战'], '关掉之后第六格要收回去');
});

check('点兵种不重绘面板，不会把页面弹回顶部', () => {
  const body = doc.querySelector<HTMLElement>('.modal-body');
  assert.ok(body, '找不到面板滚动区');
  // 模拟"已经滚到兵种池那一屏"
  body.scrollTop = 240;

  const chip = doc.querySelector<HTMLElement>('[data-unit]:not(.active)');
  assert.ok(chip, '需要一个未选中的兵种');
  chip.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

  // 重建 .modal-body 会把 scrollTop 清零，这就是"弹回顶部"的根因
  assert.equal(doc.querySelector<HTMLElement>('.modal-body'), body, '点兵种不该重建滚动区');
  assert.equal(body.scrollTop, 240, '滚动位置不该被重置');
  assert.ok(chip.classList.contains('active'), 'chip 应该就地点亮');
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
for (let i = 0; i < 20; i++) {
  const off = doc.querySelector<HTMLElement>('[data-unit]:not(.active)');
  if (!off) break;
  off.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
}

click('[data-size="20"]');
click('[data-act="start"]');
await new Promise((resolve) => setTimeout(resolve, 40));

check('新对局按选中的尺寸和扩展生成', () => {
  assert.equal(doc.querySelector('.modal-mask'), null, '面板应该关闭');
  assert.equal(doc.querySelectorAll('.tile').length, 400, '应该变成 20×20');
  const html = doc.querySelector('.side')?.innerHTML ?? '';
  assert.ok(html.includes('老兵'), '侧栏应该显示已启用的扩展');
});

await checkAsync('32×32 大地图也能开局，并带出缩放条', async () => {
  click('[data-act="new-game"]');
  await new Promise((resolve) => setTimeout(resolve, 30));
  click('[data-size="32"]');
  click('[data-act="start"]');
  await new Promise((resolve) => setTimeout(resolve, 60));

  assert.equal(doc.querySelectorAll('.tile').length, 1024, '应该变成 32×32');
  assert.ok(doc.querySelector('[data-act="zoom-in"]'), '大地图要有放大按钮');

  // 后面的用例按 20×20 的布局写的，这里换回来
  click('[data-act="new-game"]');
  await new Promise((resolve) => setTimeout(resolve, 30));
  click('[data-size="20"]');
  click('[data-act="start"]');
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(doc.querySelectorAll('.tile').length, 400, '应该回到 20×20');
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
  assert.ok(html.includes('中世'), '面板应该显示已升到中世时代');
});

check('升级后城市更硬，产兵列表也多出二级兵', () => {
  const html = doc.querySelector('.side')?.innerHTML ?? '';
  // 时代 2 城市护甲应该是 6
  assert.ok(html.includes('护甲</span><b>6</b>'), '护甲应该提升到 6');
  assert.ok(doc.querySelectorAll('.recruit-btn').length >= 8, '时代 II 应该能看到两个时代的兵种');
  assert.ok(!html.includes('升级后可解锁：长枪兵'), '长枪兵应该已经从锁定变成可选');
});

console.log('\n兵种编辑器');

check('顶栏能打开兵种编辑器', () => {
  click('[data-act="unit-editor"]');
  assert.ok(doc.querySelector('.modal-mask'), '应该打开编辑器');
  assert.ok(doc.querySelectorAll('.editor-row').length >= 10, '应该列出内置兵种');
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

check('关掉编辑器回到对局', () => {
  click('[data-act="close"]');
  assert.equal(doc.querySelector('.modal-mask'), null);
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

check('军营面板列出兵种，并写清补给来自哪座城', () => {
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
  assert.ok(html.includes('补给来自'), '应该写清补给来自哪座城市');
  assert.ok(html.includes('中世'), '补给时代应该跟着最近的城走（这里升到了中世）');
  assert.ok(html.includes('自动开火'), '军营会替自己开火');
  assert.ok(host.querySelectorAll('.recruit-btn').length >= 5, '军营应该和城市一样列兵种');
  // 二级兵种也能造：军营的时代取最近那座二级城
  assert.ok(host.querySelector('[data-type="spearman"]'), '二级城供养的军营应该能出二级兵');
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
  assert.ok(host.innerHTML.includes('打掉'), '应该提示这是敌方补给点');
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

click('[data-act="new-game"]');
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

click('[data-act="new-game"]');
await wait(40);

check('开局面板能选角色', () => {
  assert.ok(doc.querySelector('[data-role="commander"]'), '应该有指挥官模式选项');
  assert.ok(doc.querySelector('[data-role="full"]'), '应该有亲自指挥选项');
});

check('开局面板有"数据收集"开关，默认关', () => {
  const box = doc.querySelector<HTMLInputElement>('[data-field="record"]');
  assert.ok(box, '应该有"结束后上传详细数据"的勾选框');
  assert.equal(box.checked, false, '默认必须是关的：不勾就不记，也不多交东西');
  // 勾上之后只翻转卡片样式，不该重绘整个面板（否则 checkbox 会闪、焦点会丢）
  box.checked = true;
  box.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  assert.ok(box.closest('.expansion-item')?.classList.contains('on'), '勾上之后卡片要跟着高亮');
  box.checked = false;
  box.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
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

  click('[data-act="new-game"]');
  await wait(40);
  const again = doc.querySelector<HTMLInputElement>('[data-field="record"]');
  assert.equal(again?.checked, true, '上次勾了，这次开面板就该自动沿用（只勾一次）');

  // 再取消勾选：这个"取消"也要被记住
  again!.checked = false;
  again!.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  click('[data-act="cancel"]');
  await wait(20);
  click('[data-act="new-game"]');
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
  // 旧那套下拉编辑器已经拆掉：两条入口并存只会让人犹豫该用哪个
  assert.equal(bar.querySelectorAll('select').length, 0, '顶端不该再有下拉框');
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
  click('[data-act="new-game"]');
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

check('英雄技能：面板列出技能，冷却中的置灰', () => {
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
  assert.ok(host.innerHTML.includes('英雄技能'), '英雄详情里应该有一块技能菜单');
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
      expansionIds: ['fantasy-core', 'fantasy-beasts', 'fantasy-arcane'],
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
  assert.ok(packChips.length >= 3, `应该有"全部/原版/各奇想包"这几档，实际 ${packChips.length}`);

  paint('', 'core');
  const core = host.querySelectorAll('[data-act="recruit"]');
  assert.ok(core.length > 0, '原版那一档不该是空的');
  assert.equal(host.querySelectorAll('.recruit-src').length, 0, '原版兵种头上不该有包名徽标');

  paint('', 'fantasy-beasts');
  const beasts = host.querySelectorAll('[data-act="recruit"]');
  assert.ok(beasts.length > 0, '奇想·野兽那一档不该是空的');
  assert.equal(
    host.querySelectorAll('.recruit-src').length,
    beasts.length,
    '按包筛出来的应该全是这个包的兵',
  );
  // 切包不该改变"能买什么"，只改变"看到什么"：两档加起来不会超过全部
  assert.ok(core.length + beasts.length <= all, '筛选只是过滤，不该凭空多出兵种');
});

check('产兵双筛选：扩展包 + 时代，两维是"与"，再点一次回全部', () => {
  const st = createMatch(
    {
      size: 14,
      startEra: 4,
      aiOpponent: false,
      aiAlly: false,
      expansionIds: ['fantasy-core', 'fantasy-beasts', 'fantasy-arcane'],
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

  // 时代这一维单独用：切到古典，出来的必须全是古典兵
  const eraChips = Array.from(
    host.querySelectorAll<HTMLElement>('[data-act="recruit-era"]'),
  ).map((el) => Number(el.dataset.era));
  assert.ok(eraChips.includes(0), '「全部时代」那一档要在');
  const levels = eraChips.filter((e) => e > 0).sort((a, b) => a - b);
  assert.ok(levels.length >= 2, `两行 chip 至少要能选两个时代，实际 ${levels.join(',')}`);

  paint('', '', levels[0]!);
  assert.ok(count() > 0, '古典那一档不该是空的');
  assert.ok(
    erasShown().every((e) => e === levels[0]),
    `筛了古典就只该有古典兵，实际混进了 ${[...new Set(erasShown())].join(',')}`,
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
  paint('', 'fantasy-beasts', 0);
  const onlyPack = count();
  paint('', '', oneLevel);
  const onlyEra = count();
  paint('', 'fantasy-beasts', oneLevel);
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
  paint('龙骑', 'fantasy-beasts', oneLevel);
  assert.ok(count() <= both, '再叠一个搜索词只会更少');

  // 回到全部：三个维度全清，兵数是全量
  paint();
  assert.equal(count(), all, '清掉筛选应该回到全量');

  // 没命中时要把**生效的每一维**都写出来，否则玩家不知道该清哪一个
  paint('', 'fantasy-beasts', levels[0]!);
  if (count() === 0) {
    assert.ok(host.innerHTML.includes('这一档没有能造的兵'), '空态要给一句人话');
    assert.ok(host.innerHTML.includes('奇想·荒兽'), '空态要写清生效了包筛选');
    assert.ok(host.innerHTML.includes('古典'), '空态要写清生效了时代筛选');
  }
});

check('旧兵不再被时代下限吃掉：五代城照样列得出民兵', () => {
  // 这条以前是反的：城市 era 5，面板里连一个古典兵都不剩。
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
click('[data-act="new-game"]');
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
      running: false,
      round: 1,
      result: '',
      speed: 1,
      speedNames: ['慢', '快', '极快'],
      log: [],
      play: null,
      myTurn: false,
      passing: false,
      selected: '',
      picked: null,
    });
  const picks = (html: string) => (html.match(/data-act="god-pick"/g) ?? []).length;

  const all = shelf('');
  assert.ok(all.includes('data-act="god-pack"'), '货架上该有一排按包筛选的 chip');
  assert.ok(all.includes('data-act="god-era"'), '货架上该有一排按时代筛选的 chip');
  assert.ok(picks(all) > 10, '全部那一档应该有一屏兵');

  const coreOnly = picks(shelf('core'));
  const packOnly = picks(shelf('fantasy-beasts'));
  assert.ok(coreOnly > 0, '原版那一档不该是空的');
  assert.ok(packOnly > 0, '奇想·野兽那一档不该是空的');
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

  const before = savedGame();
  spots[0]!.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  const after = savedGame();
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

check('上帝模式：切到「我打这一方」后，点棋盘是走子不是落子', () => {
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

  assert.ok(
    d.querySelector('[data-act="god-play"][data-play="none"]')?.classList.contains('active'),
    '默认该停在「只摆放」——老玩家进来不该发现自己莫名其妙能走子了',
  );

  click('[data-act="god-play"][data-play="me"]');
  click('.unit[data-id="p1"]');
  assert.ok(
    d.querySelector('.unit[data-id="p1"]')?.classList.contains('selected'),
    '切到操控档之后，点自己的兵要能选中',
  );
  assert.ok(d.querySelectorAll('.tile.reach').length > 0, '选中之后棋盘上要画出可达格');
  // 沙盒没有属性卡：血量与"还剩不剩行动力"只能靠状态行报
  const status = d.querySelector('.god-status')?.textContent ?? '';
  assert.ok(status.includes('民兵') && status.includes('血'), `状态行该报出选中的是谁，实际是「${status}」`);

  // 点可达格：走过去。不是"在那一格再落一个兵"——那是两件完全不同的事，
  // 而这一档的整个意义就在这个区别上。
  click('.tile[data-x="4"][data-y="3"]');
  const after = saved().units.find((u) => u.id === 'p1')!;
  assert.equal(after.x, 4, '点可达格应该把兵走过去');
  assert.equal(after.y, 3);
  assert.equal(saved().units.length, 1, '这是走子，不该顺手在那一格又落一个兵');
});

check('上帝模式：结束回合交给对面，不弹「把设备交给对方」', () => {
  const st = godArena(424243);
  godPut(st, 'p1', 'A', 'militia', 3, 3);
  // 对面一个兵都不留：它走完一个空回合就会交还，整套交割是同步的，好断言
  const w = bootWith(st);
  const d = w.document;
  const click = (sel: string) =>
    d.querySelector<HTMLElement>(sel)!.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  const saved = () =>
    JSON.parse(w.localStorage.getItem('warchess:match:v1')!) as { current: string; turn: number };

  click('[data-act="god-play"][data-play="me"]');
  click('[data-act="god-end-turn"]');

  assert.equal(d.querySelector('#handoff'), null, '沙盒里不该出现「把设备交给对方」那张遮罩');
  assert.equal(saved().current, 'A', '对面没有兵，空回合走完就该交还给你');
  // 手操那一下 + 对面空回合那一下 = 两次交割
  assert.equal(saved().turn, 3, '两边各结束一次回合，回合数应该走两格');
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

  click('[data-act="god-play"][data-play="me"]');
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

await checkAsync('上帝模式：对面那一方真由 AI 接手，走完一个回合就交还', async () => {
  // 上一条只证明"交割不弹遮罩"，用的还是对面没兵的空回合。
  // 这一条让对面真有兵：AI 得把它走完，棋盘才回得来。
  // 交还失败的样子很难看——停在"轮到蓝方（AI）"、按钮全灰、谁也不动，
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

  click('[data-act="god-play"][data-play="me"]');
  click('[data-act="god-end-turn"]');

  const deadline = Date.now() + 8000;
  while (Date.now() < deadline && saved().turn < 3) await wait(25);

  assert.equal(saved().turn, 3, '回合数要往前走两格：你一下、对面一下');
  assert.equal(saved().current, 'A', 'AI 走完对面那一个回合之后必须把棋盘交还给你');
  assert.equal(d.querySelector('#handoff'), null, '全程不该出现「把设备交给对方」');
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

  click('[data-act="god-play"][data-play="both"]');
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

  // 只摆放的时候没有"手上这支兵"这回事：点棋盘是落子，不是选中
  assert.equal(d.querySelector('[data-act="hero-skill"]'), null, '还没进操控档，不该有技能按钮');

  click('[data-act="god-play"][data-play="me"]');
  click('.unit[data-id="h1"]');

  const btn = d.querySelector<HTMLButtonElement>('[data-act="hero-skill"]');
  assert.ok(btn, '操控档里选中英雄，侧栏就该出现技能按钮');
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

  // 同系列合册：开两个奇想包，出来的仍然只有一本
  const fantasy = manualBooks(['bloodbath', 'fantasy-core', 'fantasy-heroes']);
  assert.deepEqual(fantasy.map((b) => b.file), [
    'manual.html',
    'manual-small.html',
    'manual-pack-fantasy.html',
  ]);
  assert.ok(
    (fantasy[2]!.note ?? '').includes('骑士团') && (fantasy[2]!.note ?? '').includes('法则'),
    '合册的说明要写清这一局开的是哪几个包',
  );

  // 两个系列同时开：各出一本，不重复
  const both = manualBooks(['fantasy-knights', 'pack-medieval', 'pack-modern']);
  assert.deepEqual(both.map((b) => b.file), [
    'manual.html',
    'manual-pack-fantasy.html',
    'manual-pack-eras.html',
  ]);

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

check('天气标识：顶栏的季节条跟着回合走', () => {
  const spring = weatherScene(5);
  const w = bootWith(spring.st);
  const chip = w.document.querySelector('[data-ref="season"]') as HTMLElement | null;
  assert.ok(chip, '顶栏要有季节块');
  assert.equal(chip.hidden, false, '开了天气就该显示');
  assert.ok(chip.textContent?.includes('春'), `第 5 回合是春：${chip.textContent}`);

  const winter = weatherScene(35);
  const w2 = bootWith(winter.st);
  const chip2 = w2.document.querySelector('[data-ref="season"]') as HTMLElement | null;
  assert.ok(chip2?.textContent?.includes('冬'), `第 35 回合是冬：${chip2?.textContent}`);
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

  const chip = d.querySelector('[data-ref="season"]') as HTMLElement | null;
  assert.equal(chip?.hidden, true, '季节块也该藏起来');
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


console.log('\n选卡模式');

const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

await checkAsync('开启选卡后开局：遮罩盖住战场，双方各禁一个才进入选人', async () => {
  click('[data-act="new-game"]');
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
  const eras = order.map((id) => UNIT_TYPES[id]?.era ?? 0);
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
  const tip = doc.querySelector<HTMLElement>('#draft-tip');
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

await checkAsync('选卡可以跳过：这一局用全部兵种，遮罩收起', async () => {
  click('[data-act="new-game"]');
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

await checkAsync('选卡可以退出：退出后回到开局设置面板', async () => {
  click('[data-act="new-game"]');
  click('[data-draft-mode="on"]');
  click('[data-act="start"]');
  await tick(60);
  assert.equal(doc.querySelector<HTMLElement>('#draft')!.hidden, false, '先要有遮罩');

  click('#draft [data-draft-act="exit"]');
  await tick(80);
  assert.ok(doc.querySelector('.modal-mask'), '退出之后应该弹出开局设置面板');
  // 收掉面板，别把后面的用例挡在模态框外面
  doc.querySelector<HTMLElement>('.modal-mask [data-act="cancel"]')?.click();
  await tick(40);
});

await checkAsync('选卡 + 对战 AI：AI 自己把它的禁位与选位走完', async () => {
  click('[data-act="new-game"]');
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

console.log(`\n通过 ${passed} 项，失败 ${failed} 项\n`);
if (failed > 0) process.exit(1);
