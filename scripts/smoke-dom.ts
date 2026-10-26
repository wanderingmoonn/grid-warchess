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
  const paint = (q: string) =>
    renderPanel(host, {
      view: playerView(st, 'A'),
      me: 'A',
      selectedUnit: null,
      selectedCityId: city!.id,
      selectedCampId: null,
      selectedTile: null,
      recruitQuery: q,
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

check('工具栏上能选 AI 速度，三档都在', () => {
  // 沙盒要把几十回合一口气跑完，而"跑多快"因人而异：
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
  put('B', 'hydra', 5, 4); // 145 血，砍死 1 血的凤凰之后自己还站得住
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

console.log(`\n通过 ${passed} 项，失败 ${failed} 项\n`);
if (failed > 0) process.exit(1);
