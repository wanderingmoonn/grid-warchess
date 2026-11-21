/**
 * 开始页面。
 *
 * 为什么要它：以前打开链接的第一眼是**一张已经开局的随机棋盘**——没有标题、
 * 没有"我是谁、我要干什么"，右上角一排小按钮长得像调试面板。新玩家（包括
 * 隔几天回来的人）第一件要判断的事是"这是什么游戏"，而旧流程从来没回答过。
 *
 * 这一页只干三件事：认出门面（标题 + 一句话）、给出唯一的下一步（开始对局）、
 * 把其余入口（继续 / 联机 / 规则 / 公告）降级成一行小链接。
 *
 * 故意不做的：
 *   · 不放背景图 / 不做视差——这是一个靠规则吃饭的战棋，花哨的首屏只会
 *     把"加载慢"放大成"怎么还没出来"；
 *   · 不在这一页堆设置——时代、尺寸、扩展全部留到下一步的开局面板，
 *     首页多一个开关，第一个按钮就晚一秒被看见。
 */

import { unitInsignia, type UnitRole } from './unit-insignia.ts';
import { currentUiLayout, setUiLayout, UI_LAYOUT_EVENT } from './layout.ts';

export interface TitleOptions {
  /** 本机有没有可以接着打的对局 */
  hasSave: boolean;
  /** 构建版本，底部署名 */
  version: string;
  /** 最近一版的一句话（可省） */
  latest?: string;
  onNew: () => void;
  /** 肉鸽模式（切片）：一路打三关，打完回结算 */
  onRogue: () => void;
  /** 新手教程：一条三分钟的固定局面，教选兵/移动/攻击/结束回合/攻城 */
  onTutorial: () => void;
  /**
   * 第一次来（没打过一局、也没看过教程）。
   *
   * 这一档下把「新手教程」摆成主按钮：新手第一眼该看见的是"先学三分钟"，
   * 而不是"开始对局"——后者会把他直接扔进两页开局面板。老玩家（打过一局）
   * 仍然是「开始对局」主按钮，教程退成普通入口（想进去复习随时能点）。
   */
  firstVisit?: boolean;
  onContinue: () => void;
  onOnline: () => void;
  onManual: () => void;
  /** 兵种编辑器：原来在顶栏，现在只留在这里 */
  onEditor: () => void;
  /** 导入对局：同上 */
  onImport: () => void;
  /** 复盘：把一份对局数据（结束上传的那个 json）拖/选进来逐帧回看 */
  onReplay: () => void;
}

/** 六个时代的色带：和棋盘里的地形色同一套语言，不用另造一套配色 */
const ERA_STRIP: Array<[string, string]> = [
  ['青铜', '#c9a878'],
  ['铁器', '#a9b795'],
  ['火器', '#c8b98f'],
  ['蒸汽', '#9aa3ad'],
  ['机械化', '#7f8c96'],
  ['信息化', '#4a7fa6'],
];

function titleSandtable(): string {
  const terrain = ['pppppwpp', 'ppppwwhh', 'pffpwphh', 'pffwwppp', 'pppwpppp', 'pppwwppp', 'phppwppp', 'ppppwwpp'].join('');
  const pieces: Array<{ x: number; y: number; team: string; glyph: string; role: UnitRole }> = [
    { x: 1, y: 5, team: 'a', glyph: '戈', role: 'melee' },
    { x: 2, y: 4, team: 'a', glyph: '弓', role: 'ranged' },
    { x: 2, y: 6, team: 'a', glyph: '炮', role: 'ranged' },
    { x: 5, y: 2, team: 'b', glyph: '骑', role: 'melee' },
    { x: 6, y: 3, team: 'b', glyph: '坦', role: 'ranged' },
    { x: 6, y: 1, team: 'b', glyph: '机', role: 'air' },
  ];
  return `<div class="title-visual" role="img" aria-label="跨时代沙盘示意：青铜军队与现代军队隔河对峙，不代表实际对局">
    <div class="title-visual-head"><span>推演沙盘</span><span>青铜 → 信息化</span></div>
    <div class="title-sandtable">
      ${Array.from(terrain, (kind) => `<i class="hero-tile hero-${kind}"></i>`).join('')}
      <span class="hero-city a" style="--x:0;--y:6">${unitInsignia('building')}</span>
      <span class="hero-city b" style="--x:6;--y:0">${unitInsignia('building')}</span>
      ${pieces.map((piece) => `<span class="hero-piece ${piece.team}" style="--x:${piece.x};--y:${piece.y}"><b>${piece.glyph}</b><i>${unitInsignia(piece.role)}</i></span>`).join('')}
    </div>
    <div class="title-visual-foot"><span>沙盘示意</span></div>
  </div>`;
}

export function openTitle(host: HTMLElement, opts: TitleOptions): () => void {
  // 用宿主自己的 document，而不是全局的那个：界面用例跑在 jsdom 里，
  // 那里没有全局 document（第一版就是这么红的：document is not defined）。
  const doc = host.ownerDocument;
  const layer = doc.createElement('div');
  layer.className = 'title-screen';
  layer.innerHTML = `
    <button class="title-ui-toggle btn btn-sm" data-title="ui-layout"></button>
    <div class="title-bg" aria-hidden="true">${Array.from({ length: 48 }, (_, i) => {
      const t = i % 12;
      return `<i style="--d:${(t / 12).toFixed(2)};--r:${(i * 37) % 100}"></i>`;
    }).join('')}</div>
    <div class="title-inner">
      <div class="title-copy">
      <p class="title-kicker">回合制 · 跨时代战棋</p>
      <h1 class="title-name"><span>时代与</span><span>回旋镖</span></h1>
      <p class="title-sub">经营城市，调度军队，推进时代。</p>

      <div class="title-actions">
        ${(() => {
          const tut = '<button class="title-btn" data-title="tutorial">新手教程</button>';
          const neu = '<button class="title-btn" data-title="new">开始对局</button>';
          const cont = `<button class="title-btn" data-title="continue" ${opts.hasSave ? '' : 'disabled'}>继续上一局</button>`;
          // 第一次来：教程当主按钮、排第一；老玩家：开始对局在主位，教程退第二
          return opts.firstVisit
            ? tut.replace('class="title-btn"', 'class="title-btn primary"') + neu + cont
            : neu.replace('class="title-btn"', 'class="title-btn primary"') + tut + cont;
        })()}
      </div>

      <div class="title-links">
        <button data-title="rogue">肉鸽</button>
        <button data-title="online">联机对战</button>
        <button data-title="manual">规则手册</button>
        <details class="title-tools">
        <summary>更多</summary>
        <div class="title-tools-menu">
        <button data-title="editor">兵种编辑器</button>
        <button data-title="import">导入对局</button>
        <button data-title="replay" title="选一份对局数据（.json）逐帧回看">复盘</button>
        </div>
        </details>
      </div>
      ${opts.latest ? '<p class="title-latest"></p>' : ''}

      <ol class="title-era" aria-label="六个时代">
        ${ERA_STRIP.map(([name, color]) => `<li><i style="background:${color}"></i>${name}</li>`).join('')}
      </ol>
      </div>
      ${titleSandtable()}
      <p class="title-foot">v${opts.version}</p>
    </div>
  `;

  // 用 textContent 写"最近更新"，避免把外部字符串当 HTML 插进来
  const latest = layer.querySelector('.title-latest');
  if (latest) latest.textContent = opts.latest ?? '';

  const close = (): void => {
    layer.remove();
    win.removeEventListener('keydown', onKey);
    win.removeEventListener(UI_LAYOUT_EVENT, syncLayout);
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && opts.hasSave) close();
  };
  const win = doc.defaultView ?? window;
  const syncLayout = (): void => {
    const classic = currentUiLayout(doc.documentElement) === 'classic';
    const button = layer.querySelector<HTMLButtonElement>('[data-title="ui-layout"]')!;
    button.textContent = classic ? '恢复新版 UI' : '回滚到经典 UI';
    button.setAttribute('aria-pressed', String(classic));
  };
  syncLayout();
  win.addEventListener(UI_LAYOUT_EVENT, syncLayout);
  win.addEventListener('keydown', onKey);

  layer.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-title]');
    if (!btn || (btn as HTMLButtonElement).disabled) return;
    switch (btn.dataset.title) {
      case 'ui-layout':
        setUiLayout(currentUiLayout(doc.documentElement) === 'classic' ? 'refined' : 'classic', doc.documentElement);
        break;
      case 'new':
        close();
        opts.onNew();
        break;
      case 'tutorial':
        close();
        opts.onTutorial();
        break;
      case 'continue':
        close();
        opts.onContinue();
        break;
      case 'rogue':
        close();
        opts.onRogue();
        break;
      case 'online':
        close();
        opts.onOnline();
        break;
      case 'manual':
        // 不撤层：规则手册在新标签页里打开，看完回来还应该站在原地
        opts.onManual();
        break;
      case 'editor':
        /*
         * 同样不撤层，而且是有意的：兵种编辑器是**模态框**（z-index 100），
         * 盖在首页之上；关掉编辑器会回到首页，玩家可以接着改、也可以直接开局。
         * 第一版是先撤层再开编辑器——改完兵种落在一张已经开局的棋盘上，
         * 想再改一个数值就得从头摸回入口。
         */
        opts.onEditor();
        break;
      case 'import':
        // 导入是"进入某一局"，和开始/继续同级：先撤层
        close();
        opts.onImport();
        break;
      case 'replay':
        // 复盘也是"进入某一局"（只读的那种），同样先撤层：
        // 选完文件要看见棋盘，不能让首页盖在上面
        close();
        opts.onReplay();
        break;
    }
  });

  host.appendChild(layer);
  // 焦点给主按钮：键盘用户按两下就能开局，不用 Tab 穿越整页
  layer.querySelector<HTMLButtonElement>('.title-btn.primary')?.focus();
  return close;
}
