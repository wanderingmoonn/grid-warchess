/**
 * 肉鸽试玩版界面冒烟测试（jsdom）。
 *
 * 不开浏览器，验证"点得下去、界面会换"这条链：
 *   开局 → 房间图 → 进房（事件/商店/营地）→ 进战斗 → 认输 → 结算 → 再来一局
 *
 *   node --experimental-strip-types scripts/rogue-ui-smoke.ts
 *
 * jsdom 里没有布局，所以这里只验结构与状态流转；手感和美术要在真浏览器里看。
 */
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost/?rogue=1',
  pretendToBeVisual: true,
});
const { window } = dom;
const g = globalThis as unknown as Record<string, unknown>;
const put = (key: string, value: unknown): void => {
  try {
    Object.defineProperty(g, key, { value, configurable: true, writable: true });
  } catch {
    /* 有的全局属性不可写（node 22 的 navigator），跳过就好 */
  }
};
put('window', window);
put('document', window.document);
put('navigator', window.navigator);
put('HTMLElement', window.HTMLElement);
put('Element', window.Element);
put('Node', window.Node);
put('MouseEvent', window.MouseEvent);
put('localStorage', window.localStorage);
put('requestAnimationFrame', (cb: FrameRequestCallback): number => window.setTimeout(() => cb(Date.now()), 16));
put('cancelAnimationFrame', (id: number): void => window.clearTimeout(id));

let failures = 0;
function check(ok: boolean, label: string, extra = ''): void {
  if (ok) console.log(`  ✓ ${label}`);
  else {
    failures += 1;
    console.log(`  ✗ ${label} ${extra}`);
  }
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const doc = window.document;
const click = (el: Element | null): void => {
  if (!el) return;
  el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
};

const { bootRogue } = await import('../src/roguelike/app.ts');
const root = doc.getElementById('root') as HTMLElement;

console.log('\n[1] 开局');
bootRogue(root);
check(!!root.querySelector('.rg-start'), '显示方略选择');
const cards = root.querySelectorAll('.rg-strategy');
check(cards.length === 3, '三个方略都在');

console.log('\n[2] 房间图');
click(cards[0] as Element);
check(!!root.querySelector('.rg-map'), '进入层地图');
const steps = root.querySelectorAll('.rg-step');
check(steps.length === 10, '10 步都在', `实际 ${steps.length}`);
const nowDoors = root.querySelectorAll('.rg-step.now .rg-door');
check(nowDoors.length === 2, '当前步有两扇门');
check(!root.querySelector('.rg-bossrow'), '没走完 10 步时不显示层末会战');

console.log('\n[3] 进战斗：界面元素齐全，认输能回到结算');
{
  click(root.querySelector('.rg-step.now .rg-door:not([disabled])'));
  await wait(30);
  check(!!root.querySelector('.rg-battle'), '战斗界面已挂载');
  check(!!root.querySelector('#rg-board'), '战斗界面有棋盘容器');
  check(root.querySelectorAll('.rg-unitrow').length > 0, '列出了我军单位');
  check(!!root.querySelector('[data-act="end"]'), '有结束回合按钮');
  check(!!root.querySelector('[data-act="undo"]'), '有撤回按钮');
  check(!root.querySelector('[data-recruit]'), '没有招募面板（玩家没城）');
  check(root.querySelectorAll('#rg-board .tile').length > 0, '棋盘格子已渲染');
  check(root.querySelectorAll('#rg-board .unit').length > 0, '棋子已渲染');
  click(root.querySelector('[data-act="quit"]'));
  await wait(30);
  check(!!root.querySelector('.rg-over'), '认输后直接进结算');
  check(!!root.querySelector('[data-act="again"]'), '结算页有「再来一局」');
}

console.log('\n[4] 内容预览（?rogueAuto=win）：一路走到第三层结局');
{
  // 把地址切成自动判胜，再开一局：这样能一次走完三层，把事件/商店/营地/层间都过一遍
  window.history.replaceState({}, '', '/?rogue=1&rogueAuto=win');
  click(root.querySelector('[data-act="again"]'));
  await wait(20);
  click(root.querySelector('.rg-strategy'));
  await wait(20);

  let modals = 0;
  let portals = 0;
  let battles = 0;
  let shops = 0;
  let decisions = 0;
  let guard = 0;
  let layers = 1;
  while (guard < 400) {
    guard += 1;
    if (root.querySelector('.rg-over')) break;

    const mask = doc.querySelector('.rg-mask');
    if (mask) {
      modals += 1;
      if (mask.querySelector('.rg-shop-row')) shops += 1;
      if ((mask.textContent ?? '').includes('临战决议')) decisions += 1;
      // 商店是三行货架（没有 .rg-choice），点「离开」；其余弹层点第一个选项
      const pick =
        mask.querySelector('.rg-choice') ??
        mask.querySelector('[data-ok]') ??
        mask.querySelector('[data-shop="leave"]');
      click(pick);
      await wait(4);
      continue;
    }
    if (root.querySelector('.rg-inter')) {
      layers += 1;
      portals += 1;
      click(root.querySelector('[data-act="go"]'));
      await wait(4);
      continue;
    }
    const boss = root.querySelector('[data-act="boss"]');
    if (boss) {
      battles += 1;
      click(boss);
      await wait(4);
      continue;
    }
    const door = root.querySelector('.rg-step.now .rg-door:not([disabled])');
    if (door) {
      click(door);
      await wait(4);
      continue;
    }
    break;
  }
  console.log(
    `    经过 ${modals} 个弹层（其中商店 ${shops}、临战决议 ${decisions}）、${battles} 场（自动判胜的）战斗、${portals} 次层间推进`,
  );
  check(shops > 0, '商店是三行货架');
  check(decisions >= 3, '每层层末都有临战决议', `实际 ${decisions}`);
  check(layers === 3, '走到了第三层', `实际 ${layers}`);
  check(modals >= 5, '事件/商店/营地/战利品至少弹了 5 次', `实际 ${modals}`);
  check(!!root.querySelector('.rg-over'), '第三层结束后有结局画面');
  const overText = root.querySelector('.rg-over')?.textContent ?? '';
  check(overText.includes('钟'), '结局文案提到了钟', overText.slice(0, 60));
}

console.log(failures === 0 ? '\n全部通过。' : `\n有 ${failures} 项没通过。`);
if (failures > 0) process.exitCode = 1;
