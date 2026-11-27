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
check(cards.length >= 3, '方略卡片都在', `${cards.length} 个`);
check(root.querySelectorAll('.rg-strat-tag').length >= 2, '试验型方略有角标');

console.log('\n[2] 房间图');
click(cards[0] as Element);
check(!!root.querySelector('.rg-map'), '进入层地图');
const steps = root.querySelectorAll('.rg-step');
check(steps.length === 10, '10 步都在', `实际 ${steps.length}`);
const nowDoors = root.querySelectorAll('.rg-step.now .rg-door');
check(nowDoors.length === 2, '当前步有两扇门');
check(!root.querySelector('.rg-bossrow'), '没走完 10 步时不显示层末会战');

// 局外检视栏：军队 / 藏品 / 待生效 / 行记（2026-11-26 从一行文字扩成四块）
const inspect = root.querySelector('.rg-inspect');
check(!!inspect, '局外有检视栏');
check(
  ['军队', '藏品', '待生效', '行记'].every((t) => inspect?.textContent?.includes(t)),
  '检视栏列出军队/藏品/待生效/行记',
);
check((inspect?.querySelectorAll('.rg-armyrow').length ?? 0) > 0, '军队逐条列出兵种属性');

console.log('\n[3] 进战斗：界面元素齐全，认输能回到结算');
{
  click(root.querySelector('.rg-step.now .rg-door:not([disabled])'));
  await wait(30);
  check(!!root.querySelector('.rg-battle'), '战斗界面已挂载');
  check(!!root.querySelector('#rg-board'), '战斗界面有棋盘容器');
  check(root.querySelectorAll('.rg-unitrow').length > 0, '列出了我军单位');
  check(!!root.querySelector('[data-act="end"]'), '有结束回合按钮');
  check(!!root.querySelector('[data-act="undo"]'), '有撤回按钮');
  /*
   * 「玩家没城 → 没有招募面板」。只查招募面板本身，别拿「外人」卡的
   * data-parley 当探针：常规战斗有 34% 概率刷出中立单位，那是随机的，
   * 放这儿会让断言偶发失败（外人卡由 [6] 单独测）。
   */
  check(!root.querySelector('[data-recruit], .rg-recruit, #rg-recruit'), '没有招募面板（玩家没城）');
  // 强制模式：空地叠同格要靠强制移动 / 强制攻击，照抄本体的两个按钮
  const forceMove = root.querySelector('[data-act="force-move"]');
  const forceAttack = root.querySelector('[data-act="force-attack"]');
  check(!!forceMove && !!forceAttack, '有强制移动/强制攻击按钮');
  click(forceMove);
  check(forceMove?.classList.contains('armed') === true, '点强制移动后按钮亮起');
  click(forceMove);
  check(forceMove?.classList.contains('armed') === false, '再点一次退出强制模式');
  click(forceAttack);
  check(forceAttack?.classList.contains('armed') === true, '强制攻击也能亮起');
  click(forceAttack);
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

  /*
   * 第一层：路还没定，但"史线"这件事要写在顶栏；第 2 步左门是特殊试炼。
   * 这两条是「四选一挪进过程」的可见证据——玩家在开局就知道有一场仗能改路。
   */
  check(
    (root.querySelector('.rg-world-tag')?.textContent ?? '').includes('史线：未定'),
    '一层顶栏显示「史线：未定」',
    root.querySelector('.rg-world-tag')?.textContent ?? '',
  );
  check(
    (root.querySelector('.rg-door.k-trial b')?.textContent ?? '').startsWith('特殊 ·'),
    '试炼门标着「特殊」',
    root.querySelector('.rg-door.k-trial b')?.textContent ?? '',
  );

  let modals = 0;
  let portals = 0;
  let battles = 0;
  let shops = 0;
  let decisions = 0;
  let worlds = 0;
  const interludes: string[] = [];
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
      // 四选一已经删掉；如果它又冒出来，记一笔并随便点一个（避免卡死）
      if (mask.querySelector('.rg-world')) {
        worlds += 1;
        click(mask.querySelector('.rg-world'));
        await wait(4);
        continue;
      }
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
      const title = root.querySelector('.rg-inter h2')?.textContent?.trim() ?? '';
      if (title) interludes.push(title);
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
  check(worlds === 0, '第一层末不再弹「四种历史」四选一', `实际 ${worlds}`);
  check(
    interludes.some((t) => t.includes('异境') || t.includes('山门')),
    '打赢试炼后，第二层进入那支史',
    interludes.join(' / '),
  );
  check(shops > 0, '商店是三行货架');
  check(decisions >= 3, '每层层末都有临战决议', `实际 ${decisions}`);
  check(layers === 3, '走到了第三层', `实际 ${layers}`);
  check(modals >= 5, '事件/商店/营地/战利品至少弹了 5 次', `实际 ${modals}`);
  check(!!root.querySelector('.rg-over'), '第三层结束后有结局画面');
  const overText = root.querySelector('.rg-over')?.textContent ?? '';
  check(overText.includes('钟'), '结局文案提到了钟', overText.slice(0, 60));
}

console.log('\n[5] 战斗屏的技能栏');
{
  /*
   * 英雄技能：以前战斗屏只接了"走 / 打 / 攻城 / 结束回合"，英雄带进来
   * 却放不出技能。这一节直接挂一场带英雄的战斗，点一下技能按钮，
   * 确认它真的被规则层接住了（按钮从"可用"变"不可用"）。
   */
  const { startRun, battleFor } = await import('../src/roguelike/run.ts');
  const { mountBattle } = await import('../src/roguelike/battle-screen.ts');
  const run = startRun(31, 'frontier');
  run.layer = 2;
  run.world = 'fantasy';
  run.army = [{ type: 'elf-queen', count: 1 }, { type: 'berserker', count: 3 }];
  const node = { kind: 'battle' as const, title: '遭遇战', sub: '' };
  const host = doc.createElement('div');
  doc.body.appendChild(host);
  let done = false;
  const stop = mountBattle(host, battleFor(run, node, 606), { onDone: () => { done = true; } });
  const skillCard = host.querySelector('#rg-skills');
  check(!!skillCard, '战斗屏有"技能"栏');
  const heroRow = [...host.querySelectorAll<HTMLElement>('.rg-unitrow')].find((el) =>
    (el.textContent ?? '').includes('精灵女王'),
  );
  check(!!heroRow, '我军列表里有英雄');
  click(heroRow ?? null);
  await wait(4);
  const btns = [...host.querySelectorAll<HTMLButtonElement>('[data-skill]')];
  check(btns.length > 0, '选中英雄后列出技能', `${btns.length} 个`);
  check(btns.some((b) => !b.disabled), '刚开局至少有一个技能可用');
  const before = btns.find((b) => !b.disabled);
  if (before) click(before);
  await wait(10);
  const after = [...host.querySelectorAll<HTMLButtonElement>('[data-skill]')];
  check(
    after.length > 0 && after.every((b) => b.disabled),
    '放过技能之后按钮变灰（这一回合不能连放）',
    after.map((b) => `${b.textContent?.slice(0, 6)}:${b.disabled}`).join(','),
  );
  check(!done, '放技能不会直接结束战斗');
  stop();
  host.remove();
}

console.log('\n[6] 战场两侧的"外人"：场外交涉');
{
  /*
   * 中立单位挪到两侧之后，战斗屏右侧多一张「外人」卡：可以直接花钱把人
   * 招进来（战后留在队里），也可以请它走开。这一节验的是那条链路：
   * 卡片出现 → 点招募 → 我方多一个人、金币扣掉、卡片少一行。
   */
  const { startRun, battleFor } = await import('../src/roguelike/run.ts');
  const { mountBattle } = await import('../src/roguelike/battle-screen.ts');
  const run = startRun(20, 'frontier');
  run.layer = 1;
  run.world = 'base';
  run.gold = 600;
  run.army = [{ type: 'ge', count: 4 }, { type: 'archer', count: 2 }];
  const host = doc.createElement('div');
  doc.body.appendChild(host);
  const stop = mountBattle(host, battleFor(run, { kind: 'battle', title: '遭遇战', sub: '' }, 20), {
    onDone: () => {},
  });
  const card = host.querySelector<HTMLElement>('#rg-neutral-card');
  check(!!card && !card.hidden, '有中立单位时出现「外人」卡');
  const rows = [...host.querySelectorAll<HTMLElement>('.rg-neutral-row')];
  check(rows.length === 2, '两个外人各一行', String(rows.length));
  const mineBefore = host.querySelectorAll('.rg-unitrow').length;
  const goldOf = (): number => {
    const m = /金\s*(\d+)/.exec(host.querySelector('#rg-hud')?.textContent?.replace(/\s+/g, ' ') ?? '');
    return m ? Number(m[1]) : -1;
  };
  const goldBefore = goldOf();
  const rec = rows[0]?.querySelector<HTMLButtonElement>('[data-parley]');
  const recId = rec?.dataset.parley;
  check(!!rec && !rec.disabled, '钱够的时候招募按钮可点');
  click(rec ?? null);
  await wait(10);
  check(host.querySelectorAll('.rg-unitrow').length === mineBefore + 1, '招募之后我方多一个人');
  check(
    !!recId && !!host.querySelector(`.rg-unitrow[data-unit="${recId}"]`),
    '招进来的人出现在我军列表里（不再是"外人"）',
  );
  check(host.querySelectorAll('.rg-neutral-row').length === rows.length - 1, '「外人」少一行');
  check(goldBefore - goldOf() === 170, '招募扣的是标价（170 金）', `${goldBefore} → ${goldOf()}`);
  const hud = host.querySelector('#rg-hud')?.textContent ?? '';
  check(/金\s*\d+/.test(hud), '顶栏能看到金币', hud.replace(/\s+/g, ' ').slice(0, 80));
  // 撤回：钱和人都要退回去（交涉是唯一"改 state 不经过规则层"的操作，得单独验）
  host.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
  await wait(10);
  check(goldOf() === goldBefore, 'Ctrl+Z 把招募的钱退回来', `${goldOf()} vs ${goldBefore}`);
  check(
    host.querySelectorAll('.rg-neutral-row').length === rows.length,
    'Ctrl+Z 把人也退回去（又变回"外人"）',
    String(host.querySelectorAll('.rg-neutral-row').length),
  );
  for (let i = 0; i < rows.length; i += 1) {
    const dis = host.querySelector<HTMLButtonElement>('[data-dismiss]');
    if (dis) click(dis);
    await wait(6);
  }
  check(host.querySelectorAll('.rg-neutral-row').length === 0, '请走之后卡片空掉');
  stop();
  host.remove();
}

console.log('\n[7] 成长型英雄：角标、属性卡、第 2 层长满');
{
  const { startRun, battleFor } = await import('../src/roguelike/run.ts');
  const { mountBattle } = await import('../src/roguelike/battle-screen.ts');
  const mount = (layer: 1 | 2 | 3) => {
    const run = startRun(20, 'champion');
    run.layer = layer;
    run.world = 'fantasy';
    const host = doc.createElement('div');
    doc.body.appendChild(host);
    const stop = mountBattle(host, battleFor(run, { kind: 'battle', title: 't', sub: '' }, 20), {
      onDone: () => {},
    });
    return { host, stop };
  };
  const a = mount(1);
  const badge = a.host.querySelector('.rg-grow');
  check(!!badge && badge.textContent?.includes('1/2'), '第一层：我军列表里有「成长 1/2」', badge?.textContent ?? '无');
  const one = a.host.querySelector('.rg-unitrow');
  check(a.host.querySelectorAll('.rg-unitrow').length === 1, '英雄开局我军只有一行');
  check((one?.textContent ?? '').includes('神圣骑士长'), '那一行就是英雄');
  // 属性卡里也要说明它在成长期
  const piece = a.host.querySelector('.unit');
  piece?.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }));
  await wait(4);
  const card = a.host.querySelector('#rg-hovercard')?.textContent ?? '';
  check(card.includes('成长期'), '属性卡写明"成长期 1/2"', card.slice(0, 40));
  a.stop();
  a.host.remove();

  const b = mount(2);
  check(!b.host.querySelector('.rg-grow'), '第二层：长满了，角标消失');
  b.stop();
  b.host.remove();
}

console.log(failures === 0 ? '\n全部通过。' : `\n有 ${failures} 项没通过。`);
if (failures > 0) process.exitCode = 1;
