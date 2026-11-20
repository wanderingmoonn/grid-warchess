/**
 * 侧栏「长列表收纳 + 结束行动钉底」的体检。
 *
 * 起因（2026-11-20）：28 个扩展包全开、城市到第 8 时代时，产兵列表实测 **240 种**，
 * 侧栏要滚十几屏；而「结束行动」排在侧栏最末尾，每回合都得先滑到底才能交棒。
 *
 * 这里量的是**渲染结果**，不是观感：
 *   1. 列表长到一定程度要被收起来（只露前 12 行）；
 *   2. 收起来的是"藏起来"，不是"删掉"——露出 + 收起必须等于总数，
 *      标题上的数字必须等于藏起来的条数（这是这个项目「不许藏信息」的底线）；
 *   3. 筛选/搜索把列表变短之后，不该再折一次；
 *   4. 展开状态要能跨重绘记住（面板每帧整块重建）；
 *   5. 早期局（二十几种兵）不受影响；
 *   6. 「结束行动」那一层还在（钉底是纯 CSS，这里只确认容器没被改掉）。
 *
 * 用法：npm run probe:fold
 */
import { JSDOM } from 'jsdom';
import assert from 'node:assert/strict';
import { createMatch } from '../src/core/setup.ts';
import { EXPANSIONS } from '../src/core/expansions.ts';
import { UNIT_TYPES } from '../src/core/config.ts';
import { playerView } from '../src/core/fog.ts';
import { place } from './tests/support.ts';

const dom = new JSDOM('<div id="host"></div>');
(globalThis as any).document = dom.window.document;
(globalThis as any).window = dom.window;

const { renderPanel } = await import('../src/ui/panel.ts');

let pass = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    pass += 1;
    console.log(`  ok   ${name}`);
  } catch (err) {
    console.log(`  FAIL ${name}\n       ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}

const ALL = (EXPANSIONS as any[]).map((e) => e.id).filter((id: string) => id !== 'core');

/** 建一局，把 A 的一座城调到指定时代，返回渲染用的输入 */
function setup(era: number) {
  const s = createMatch(
    {
      size: 16,
      startEra: 8,
      aiOpponent: false,
      aiAlly: false,
      expansionIds: ALL,
      enabledUnits: Object.keys(UNIT_TYPES),
    } as any,
    12345,
  );
  s.current = 'A';
  const city = s.cities.find((c) => c.owner === 'A')!;
  city.era = era;
  return { s, city };
}

function mount(s: any, city: any, extra: Record<string, unknown> = {}) {
  const host = dom.window.document.getElementById('host')! as unknown as HTMLElement;
  renderPanel(host, {
    view: playerView(s, 'A', false),
    me: 'A',
    selectedUnit: null,
    selectedCityId: city.id,
    selectedCampId: null,
    selectedTile: null,
    logSide: 'A',
    ...extra,
  } as any);
  return host;
}

const rowsIn = (el: Element) => el.querySelectorAll('[data-act="recruit"]').length;

/** 渲染"没选中任何东西"那一页（默认页） */
function mountDefault(s: any, extra: Record<string, unknown> = {}) {
  const host = dom.window.document.getElementById('host')! as unknown as HTMLElement;
  renderPanel(host, {
    view: playerView(s, 'A', false),
    me: 'A',
    selectedUnit: null,
    selectedCityId: null,
    selectedCampId: null,
    selectedTile: null,
    logSide: 'A',
    ...extra,
  } as any);
  return host;
}

const skillNames = (host: Element) =>
  Array.from(host.querySelectorAll('[data-act="hero-skill"]')).map((b) => b.textContent ?? '');

console.log('长列表收纳');

const late = setup(8);
const host = mount(late.s, late.city);
const folds = Array.from(host.querySelectorAll('details.list-fold'));

check('晚期城市：列表被收起', () => {
  assert.ok(folds.length > 0, '一条折叠行都没有，列表还是全平铺');
});

/** 一组里"露在外面"的行数（details 之外的那些） */
function shownRows(group: Element): number {
  return Array.from(group.children)
    .filter((c) => c.tagName !== 'DETAILS')
    .reduce((n, c) => n + rowsIn(c), 0);
}

check('收起的是藏起来，不是删掉：标题上的数字 = 真正藏起来的按钮数', () => {
  /*
   * 这条守的是这个项目的老规矩——不许靠"少列几个"来省地方。
   * 真出了 bug 的形态是 `rows.slice(limit)` 和标题里的 `length - limit` 对不上，
   * 于是"还有 111 种"点开只有 108 个。所以拿 DOM 里数到的按钮去对标题。
   */
  for (const f of folds) {
    const hidden = rowsIn(f.querySelector('.recruit-list')!);
    const text = f.querySelector('summary')!.textContent ?? '';
    assert.ok(text.includes(String(hidden)), `标题写的是「${text}」，实际藏了 ${hidden} 条`);
    assert.ok(hidden > 0, '折了一组但里面是空的');
  }
});

check('每组露在外面的不超过 12 行', () => {
  for (const f of folds) {
    const n = shownRows(f.closest('.recruit-list')!);
    assert.ok(n <= 12, `露了 ${n} 行，超过上限`);
  }
});

console.log('短列表不该折');

check('搜索把列表筛短之后，不再折叠', () => {
  const h = mount(late.s, late.city, { recruitQuery: '剑' });
  const n = h.querySelectorAll('details.list-fold').length;
  assert.equal(n, 0, `只剩 ${rowsIn(h)} 条还在折`);
  assert.ok(rowsIn(h) > 0, '搜「剑」一条都没搜到，用例本身失效了');
});

check('早期城市（二十几种兵）一条也不折', () => {
  const early = setup(1);
  const h = mount(early.s, early.city);
  assert.equal(h.querySelectorAll('details.list-fold').length, 0, '早期局被折了，等于让人多点一次');
});

console.log('展开状态');

check('展开之后重绘，仍然是展开的', () => {
  const first = folds[0]! as HTMLDetailsElement;
  const key = first.dataset.fold!;
  const h = mount(late.s, late.city, { openFolds: new Set([key]) });
  const again = Array.from(h.querySelectorAll('details.list-fold')).find(
    (f) => (f as HTMLDetailsElement).dataset.fold === key,
  ) as HTMLDetailsElement | undefined;
  assert.ok(again, '重绘之后这一组不见了');
  assert.equal(again.open, true, '重绘之后被合上了');
});

check('记账键带着城的 id（换一座城就是另一本账，不会串味）', () => {
  for (const f of folds) {
    const key = (f as HTMLDetailsElement).dataset.fold ?? '';
    assert.ok(key.startsWith(`recruit:${late.city.id}:`), `键是「${key}」，没跟着城走`);
  }
});

console.log('单位卡的「说明」');

/**
 * 修真局里摆一个修士和一个普通兵。
 *
 * id 必须自己起一个不撞的（`test-qi`）：开局编制已经占了 u1..u14，
 * 撞号会让 `find(id)` 拿到前面那个民兵，测出来的东西全是错的（踩过一次）。
 */
function setupCultivation() {
  const s: any = createMatch(
    {
      size: 16,
      startEra: 3,
      aiOpponent: false,
      aiAlly: false,
      expansionIds: ['cultivation'],
      enabledUnits: Object.keys(UNIT_TYPES),
    } as any,
    5,
  );
  s.current = 'A';
  const add = (type: string, id: string, x: number) =>
    s.units.push({
      id,
      type,
      owner: 'A',
      x,
      y: 4,
      hp: s.unitTypes[type].maxHp,
      kills: 0,
      moved: false,
      acted: false,
    });
  add('qi-cultivator', 'test-qi', 3);
  add('cultivation-sect', 'test-sect', 6);
  return s;
}

const cult = setupCultivation();
const qi = cult.units.find((u: any) => u.id === 'test-qi');
const sect = cult.units.find((u: any) => u.id === 'test-sect');

check('修士：说明一长就收起来，标题写着几条', () => {
  const h = mountDefault(cult, { selectedUnit: qi });
  const fold = h.querySelector('details[data-fold="unit:notes"]') as HTMLDetailsElement | null;
  assert.ok(fold, '修士十几条说明没有收起来，还是铺了一屏');
  const lines = fold!.querySelectorAll('.unit-notes div').length;
  const text = fold!.querySelector('summary')!.textContent ?? '';
  assert.ok(text.includes(String(lines)), `标题写的是「${text}」，实际 ${lines} 条`);
});

check('普通兵：说明短，原样铺着（给两行字加一次点击是添乱）', () => {
  const h = mountDefault(cult, { selectedUnit: cult.units[0] });
  assert.equal(
    h.querySelectorAll('details[data-fold="unit:notes"]').length,
    0,
    '普通兵被折了',
  );
});

console.log('宗门大殿的法术清单');

const sectHost = mountDefault(cult, { selectedUnit: sect });
const acts = () => sectHost.querySelectorAll('[data-act="unit-action"]').length;

check('法术多到一定程度就出现搜索框', () => {
  assert.ok(sectHost.querySelector('[data-act="action-search"]'), '没有搜索框，78 门只能靠眼睛扫');
});

check('按境界分档：chip 排出来，且带「全部」', () => {
  const chips = [...sectHost.querySelectorAll('[data-act="action-filter"]')];
  assert.ok(chips.length >= 2, `只有 ${chips.length} 颗 chip，分不出档`);
  assert.equal(chips[0]!.getAttribute('data-value'), '', '第一颗应该是「全部」');
});

check('默认只露 12 条，其余收进折叠行', () => {
  const fold = sectHost.querySelector('details.list-fold') as HTMLDetailsElement | null;
  assert.ok(fold, '几十门法术一条都没收');
  const group = fold!.closest('.recruit-list')!;
  const outside = Array.from(group.children)
    .filter((c) => c.tagName !== 'DETAILS')
    .reduce((n, c) => n + c.querySelectorAll('[data-act="unit-action"]').length, 0);
  assert.ok(outside <= 12, `露了 ${outside} 条`);
});

check('按一档筛：只剩这一档，chip 变高亮', () => {
  const chips = [...sectHost.querySelectorAll('[data-act="action-filter"]')];
  const one = chips[1]!;
  const value = one.getAttribute('data-value')!;
  const before = acts();
  const h = mountDefault(cult, { selectedUnit: sect, actionFilter: value });
  const after = h.querySelectorAll('[data-act="unit-action"]').length;
  assert.ok(after > 0 && after < before, `筛「${value}」之后是 ${after} / 筛前 ${before}`);
  const active = h.querySelector(`[data-act="action-filter"][data-value="${value}"].active`);
  assert.ok(active, '选中的那一档没有高亮');
});

check('搜不到时给一颗「清掉筛选」，而不是只剩一句空话', () => {
  const h = mountDefault(cult, { selectedUnit: sect, actionQuery: '绝不可能存在的法术名' });
  assert.equal(h.querySelectorAll('[data-act="unit-action"]').length, 0);
  assert.ok(h.querySelector('[data-act="action-clear"]'), '空结果里没有清筛选的入口');
});

console.log('钉底层');

check('「结束行动」那一层还在侧栏末尾', () => {
  assert.ok(host.innerHTML.includes('class="side-footer"'), 'side-footer 没了，钉底就没有锚点');
  assert.ok(host.innerHTML.includes('data-act="end-turn"'), '找不到结束行动按钮');
});

console.log('待放技能（mustCast）');

/**
 * 摆一队英雄：圣剑勇者（`mustCast`）+ 矮人王（没标）。
 *
 * 直接 `place` 而不走招募：这里量的是界面筛不筛，不是能不能买到。
 */
function setupHeroes(count = 1) {
  const s = createMatch(
    {
      size: 16,
      startEra: 8,
      aiOpponent: false,
      aiAlly: false,
      expansionIds: ALL,
      enabledUnits: Object.keys(UNIT_TYPES),
    } as any,
    999,
  );
  s.current = 'A';
  for (let i = 0; i < count; i += 1) place(s, 'A', 'sword-saint', 2 + i, 2);
  place(s, 'A', 'dwarf-king', 2, 6);
  return s;
}

check('没选中单位时，只列标了 mustCast 的技能', () => {
  const names = skillNames(mountDefault(setupHeroes(1)));
  assert.ok(
    names.some((t) => t.includes('圣剑觉醒')),
    `圣剑觉醒没被顶到待放页，列出来的是：${names.join(' / ') || '（空）'}`,
  );
});

check('没标 mustCast 的技能不在待放页（选中那个兵才看得到）', () => {
  const names = skillNames(mountDefault(setupHeroes(1)));
  assert.ok(
    !names.some((t) => t.includes('投斧')),
    '投斧没标 mustCast，却出现在了待放页',
  );
});

check('选中那个兵之后，没标 mustCast 的技能照样在（只是不占默认页）', () => {
  const s = setupHeroes(1);
  const king = s.units.find((u) => u.type === 'dwarf-king')!;
  const names = skillNames(mountDefault(s, { selectedUnit: king }));
  assert.ok(
    names.some((t) => t.includes('投斧')),
    `选中兵之后投斧也不见了，列出来的是：${names.join(' / ') || '（空）'}`,
  );
});

check('冷却中的技能不占待放页的位置', () => {  const s = setupHeroes(1);
  const hero = s.units.find((u) => u.type === 'sword-saint')!;
  hero.skillCd = { ascend: 3 };
  assert.equal(skillNames(mountDefault(s)).length, 0, '还在冷却，却被列成"该放了"');
});

check('待放超过 5 条时收起，标题上的数字对得上', () => {
  const h = mountDefault(setupHeroes(6));
  const fold = h.querySelector('details.list-fold') as HTMLDetailsElement | null;
  assert.ok(fold, '六条待放没有收起');
  const hidden = fold!.querySelectorAll('[data-act="hero-skill"]').length;
  assert.equal(hidden, 1, `藏起来的是 ${hidden} 条，六个英雄留 5 条应该只藏 1 条`);
  assert.ok((fold!.querySelector('summary')!.textContent ?? '').includes('1'), '标题数字不对');
});

console.log(`\n通过 ${pass} 项${process.exitCode ? '，有失败' : '，全部正常'}`);