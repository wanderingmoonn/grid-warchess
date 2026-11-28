/**
 * 开始页面。
 *
 * 为什么要它：以前打开链接的第一眼是**一张已经开局的随机棋盘**——没有标题、
 * 没有"我是谁、我要干什么"，右上角一排小按钮长得像调试面板。新玩家（包括
 * 隔几天回来的人）第一件要判断的事是"这是什么游戏"，而旧流程从来没回答过。
 *
 * 首页提供教程和新对局。有存档时，战场预览也用于继续对局，联机和规则手册放在辅助入口。
 *
 * 故意不做的：
 *   · 不放背景图 / 不做视差——这是一个靠规则吃饭的战棋，花哨的首屏只会
 *     把"加载慢"放大成"怎么还没出来"；
 *   · 不在这一页堆设置——时代、尺寸、扩展全部留到下一步的开局面板，
 *     首页多一个开关，第一个按钮就晚一秒被看见。
 */

import { unitInsignia, type UnitRole } from './unit-insignia.ts';
import { titleMatchPreview, type TitleMatchPreview } from './title-match-preview.ts';
import { createAngledBoard } from './angled-board.ts';
import { createMatch, DEFAULT_CONFIG } from '../core/setup.ts';
import { EARTH } from '../core/board.ts';
import { playerView, viewOnBoard } from '../core/fog.ts';
import { uiIcon } from './icons.ts';
import type { GameState, Terrain } from '../core/types.ts';

export interface TitleOptions {
  /** 本机有没有可以接着打的对局 */
  hasSave: boolean;
  preview?: TitleMatchPreview;
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

/** 八个时代的色带：从青铜到聚变，附悬停特色说明 */
const ERA_STRIP: Array<[string, string, string]> = [
  ['青铜', '#c9a878', '青铜时代 · 民兵、弓手、战车与木栅城池'],
  ['铁器', '#a9b795', '铁器时代 · 重装步兵、骑兵与石砌城防'],
  ['火器', '#c8b98f', '火器时代 · 火枪手、野战炮与棱堡要塞'],
  ['蒸汽', '#9aa3ad', '蒸汽时代 · 铁甲舰、蒸汽装甲与工业重炮'],
  ['机械化', '#7f8c96', '机械化时代 · 坦克集群、空军与钢铁防线'],
  ['信息化', '#4a7fa6', '信息化时代 · 精确制导、隐身战机与现代指挥'],
  ['装甲', '#63718d', '装甲时代 · 模块化机甲素体、电网与高能护盾'],
  ['聚变', '#4aa8c2', '聚变时代 · 聚变核心反应堆、轨道兵器与尖端阵列'],
];

function buildTitleDioramaState(): GameState {
  const s = createMatch({ ...DEFAULT_CONFIG, size: 8, startEra: 1 }, 20261124, {});
  const rows = [
    'pphwppcc',
    'pfwwppcc',
    'ffwppppp',
    'ppwphhpp',
    'ppwwphpp',
    'pppwwfpp',
    'ccppwwfp',
    'ccpppwpp',
  ];
  const mapChar: Record<string, Terrain> = {
    p: 'plain',
    f: 'forest',
    h: 'hill',
    w: 'water',
    c: 'city',
  };
  let i = 0;
  for (const row of rows) {
    for (const ch of row) {
      if (s.tiles[i]) s.tiles[i]!.terrain = mapChar[ch] ?? 'plain';
      i += 1;
    }
  }
  s.fog = false;
  s.cities = [
    { id: 'cA', owner: 'A', x: 0, y: 6, size: 2, hp: 30, maxHp: 30, armor: 1, era: 1 },
    { id: 'cB', owner: 'B', x: 6, y: 0, size: 2, hp: 80, maxHp: 80, armor: 5, era: 6 },
  ];
  const candidates = [
    { id: 'u1', type: 'militia', owner: 'A' as const, x: 2, y: 5, hp: 28, moved: false, acted: false, kills: 0 },
    { id: 'u2', type: 'archer', owner: 'A' as const, x: 1, y: 4, hp: 22, moved: false, acted: false, kills: 0 },
    { id: 'u3', type: 'knight', owner: 'A' as const, x: 3, y: 6, hp: 36, moved: false, acted: false, kills: 0 },
    { id: 'u4', type: 'tank', owner: 'B' as const, x: 5, y: 2, hp: 58, moved: false, acted: false, kills: 0 },
    { id: 'u5', type: 'rifleman', owner: 'B' as const, x: 4, y: 1, hp: 34, moved: false, acted: false, kills: 0 },
    { id: 'u6', type: 'mod_commando', owner: 'B' as const, x: 6, y: 3, hp: 40, moved: false, acted: false, kills: 0 },
  ];
  s.units = candidates.filter((u) => Boolean(s.unitTypes[u.type]));
  return s;
}

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
    <div class="title-visual-head"><span>立体沙盘</span><span>青铜 → 聚变</span></div>
    <div class="title-sandtable">
      ${Array.from(terrain, (kind) => `<i class="hero-tile hero-${kind}"></i>`).join('')}
      <span class="hero-city a" style="--x:0;--y:6">${unitInsignia('building')}</span>
      <span class="hero-city b" style="--x:6;--y:0">${unitInsignia('building')}</span>
      ${pieces.map((piece) => `<span class="hero-piece ${piece.team}" style="--x:${piece.x};--y:${piece.y}"><b>${piece.glyph}</b><i>${unitInsignia(piece.role)}</i></span>`).join('')}
    </div>
    <div class="title-visual-foot"><span>斜俯视实景微缩</span></div>
  </div>`;
}

export function openTitle(host: HTMLElement, opts: TitleOptions): () => void {
  // 用宿主自己的 document，而不是全局的那个：界面用例跑在 jsdom 里，
  // 那里没有全局 document（第一版就是这么红的：document is not defined）。
  const doc = host.ownerDocument;
  const layer = doc.createElement('div');
  layer.className = 'title-screen';
  const preview = opts.hasSave && opts.preview ? titleMatchPreview(opts.preview) : '';
  layer.innerHTML = `
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
          const cont = `<button type="button" class="title-btn title-resume-fallback" ${opts.hasSave ? '' : 'disabled'}>继续上一局</button>`;
          // 第一次来：教程当主按钮、排第一；老玩家：开始对局在主位，教程退第二
          return opts.firstVisit
            ? tut.replace('class="title-btn"', 'class="title-btn primary"') + neu + cont
            : neu.replace('class="title-btn"', 'class="title-btn primary"') + tut + cont;
        })()}
      </div>

      <div class="title-links">
        <button data-title="rogue">${uiIcon('swords')}<span>肉鸽</span></button>
        <button data-title="rogue2" title="if 线：房间图 / 事件 / 商店，与左边那套互相独立">${uiIcon('swords')}<span>肉鸽 2.0</span></button>
        <button data-title="online">${uiIcon('online')}<span>联机对战</span></button>
        <button data-title="manual">${uiIcon('book')}<span>规则手册</span></button>
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

      <ol class="title-era" aria-label="八个时代">
        ${ERA_STRIP.map(([name, color, tip]) => `<li title="${tip}"><i style="background:${color}"></i>${name}</li>`).join('')}
      </ol>
      </div>
      ${preview || titleSandtable()}
      <p class="title-foot">v${opts.version}</p>
    </div>
  `;

  // 用 textContent 写"最近更新"，避免把外部字符串当 HTML 插进来
  const latest = layer.querySelector('.title-latest');
  if (latest) latest.textContent = opts.latest ?? '';

  const win = doc.defaultView ?? window;
  const resumeCard = layer.querySelector<HTMLButtonElement>('.title-resume');
  const resumeFallback = layer.querySelector<HTMLButtonElement>('.title-resume-fallback')!;
  if (resumeCard) {
    resumeCard.hidden = false;
    resumeCard.dataset.title = 'continue';
  }
  resumeFallback.hidden = !opts.hasSave || !!resumeCard;
  if (resumeCard) delete resumeFallback.dataset.title;
  else resumeFallback.dataset.title = 'continue';

  // 真机浏览器下统一使用 3D 斜俯视实时沙盘（有存档则实景呈现当前战局，无存档则展示跨时代微缩沙盘；jsdom 自动回退静态沙盘）
  let dioramaCanvas: HTMLCanvasElement | null = null;
  if (typeof win.CanvasRenderingContext2D === 'function') {
    const table = layer.querySelector<HTMLElement>('.title-sandtable');
    if (table) {
      const wrap = doc.createElement('span');
      wrap.className = 'title-iso-wrap';
      const canvas = doc.createElement('canvas');
      canvas.className = 'title-iso-canvas';
      const badge = doc.createElement('span');
      badge.className = 'title-iso-badge';
      const saveView = opts.preview ? viewOnBoard(opts.preview.view, EARTH) : null;
      const canShowSaveIso = !!saveView && saveView.state.w <= 24 && saveView.state.h <= 24;
      badge.textContent = canShowSaveIso ? '3D 实景战局' : '3D 斜俯视';
      wrap.append(canvas, badge);
      const angled = createAngledBoard(canvas, doc.baseURI || win.location.href);
      if (angled) {
        if (canShowSaveIso && saveView) {
          angled.draw(saveView);
          table.replaceWith(wrap);
          dioramaCanvas = canvas;
        } else if (!preview) {
          const diorama = buildTitleDioramaState();
          angled.draw(playerView(diorama, 'A'));
          table.replaceWith(wrap);
          dioramaCanvas = canvas;
        }
      }
    }
  }

  const close = (): void => {
    if (dioramaCanvas) dioramaCanvas.hidden = true;
    layer.remove();
    win.removeEventListener('keydown', onKey);
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && opts.hasSave) close();
  };
  win.addEventListener('keydown', onKey);

  layer.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-title]');
    if (!btn || (btn as HTMLButtonElement).disabled) return;
    switch (btn.dataset.title) {
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
      /*
       * 肉鸽 2.0（if 线）。
       *
       * 不放进 TitleOptions：那条接口是原版肉鸽的，动了就得改 main.ts。
       * 这里直接懒加载自己那一层（`src/roguelike/mount.ts`），
       * 不进这个模式就一个字节都不加载，也不与原来的肉鸽共用任何状态。
       */
      case 'rogue2':
        close();
        void import('../roguelike/mount.ts').then((m) => m.openRogue2());
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
