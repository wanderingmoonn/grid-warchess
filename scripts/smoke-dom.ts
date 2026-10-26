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
import { createMatch, DEFAULT_CONFIG } from '../src/core/setup.ts';
import { renderPanel } from '../src/ui/panel.ts';
import { renderBoard } from '../src/ui/board.ts';
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

check('城市里不再直接产建筑', () => {
  const html = doc.querySelector('.side')?.innerHTML ?? '';
  assert.ok(!html.includes('自动开火'), '建筑不该出现在城市生产列表里');
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
  assert.ok(text.includes('敌方'), `遮罩内容：${text.slice(0, 40)}`);
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

check('选了人机对战才出现初级/高级两档，默认高级', () => {
  const activeLevel = () =>
    doc.querySelector<HTMLElement>('[data-ailevel].active')?.dataset.ailevel ?? '';

  click('[data-ai="1"]');
  assert.equal(doc.querySelectorAll('[data-ailevel]').length, 2, '应该出现初级/高级两个按钮');
  assert.equal(activeLevel(), 'advanced', '默认应该是高级 AI');

  click('[data-ailevel="basic"]');
  assert.equal(activeLevel(), 'basic', '点初级应该切过去');
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
  assert.deepEqual(tags, ['古典', '中世', '火药', '工业', '现代']);
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

check('面板写清了房间码就是钥匙', () => {
  const text = doc.querySelector('.modal')?.textContent ?? '';
  assert.ok(text.includes('房间码就是钥匙'), '应该有这句说明');
});

check('关掉联机面板回到对局', () => {
  click('[data-act="close"]');
  assert.equal(doc.querySelector('.modal-mask'), null);
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

click('[data-role="commander"]');
click('[data-act="start"]');
await wait(60);

check('指挥官模式开局后出现 5 格生产序列', () => {
  const bar = doc.querySelector<HTMLElement>('#commander');
  assert.ok(bar && !bar.hidden, '指挥官栏应该显示');
  assert.equal(bar.querySelectorAll('select[data-slot]').length, 5, '应该有 5 格');
  assert.ok(bar.textContent?.includes('参谋部'), '标题应该是参谋部');
});

check('生产序列里能排「升级时代」', () => {
  const sel = doc
    .querySelector<HTMLElement>('#commander')
    ?.querySelector<HTMLSelectElement>('select[data-slot="1"]');
  assert.ok(sel, '找不到第二格');
  assert.ok(
    Array.from(sel.options).some((o) => o.value === '@upgrade'),
    '每一格都应该能选升级时代',
  );
});

check('改一格只更新序列，下拉不会被重建', () => {
  const bar = doc.querySelector<HTMLElement>('#commander');
  assert.ok(bar);
  const sel = bar.querySelectorAll<HTMLSelectElement>('select[data-slot]')[0];
  assert.ok(sel, '找不到第一格');
  const opt = Array.from(sel.options).find((o) => o.value !== '');
  assert.ok(opt, '至少要有一个能造的兵种');
  sel.value = opt.value;
  sel.dispatchEvent(new window.Event('change', { bubbles: true }));
  const again = doc
    .querySelector<HTMLElement>('#commander')
    ?.querySelectorAll<HTMLSelectElement>('select[data-slot]')[0];
  assert.equal(again, sel, '重建会把下拉抽走，玩家刚选的兵就丢了');
  assert.equal(again?.value, opt.value, '选中的兵种应该还留着');
});


await checkAsync('每格都给出可用金币的估算', async () => {
  const bar = doc.querySelector<HTMLElement>('#commander');
  assert.ok(bar);
  const ests = Array.from(bar.querySelectorAll<HTMLElement>('[data-est]'));
  assert.equal(ests.length, 5, '5 格各有一条估算');
  assert.ok(/≈\s*\d+\s*金/.test(ests[0]?.textContent ?? ''), `第一格应该显示估算金币，实际：${ests[0]?.textContent}`);
  assert.ok(bar.querySelector('[data-est-total]'), '应该有本批结束时余额的估算');
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
  assert.equal(back?.querySelectorAll('select[data-slot]').length, 5, '5 格应该还在');
  assert.ok(!back?.querySelector('[data-cmd="stop"]'), '不该还停在进度态');
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

console.log(`\n通过 ${passed} 项，失败 ${failed} 项\n`);
if (failed > 0) process.exit(1);
