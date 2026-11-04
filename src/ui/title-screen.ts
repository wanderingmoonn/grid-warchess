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

export interface TitleOptions {
  /** 本机有没有可以接着打的对局 */
  hasSave: boolean;
  /** 构建版本，底部署名 */
  version: string;
  /** 最近一版的一句话（可省） */
  latest?: string;
  onNew: () => void;
  onContinue: () => void;
  onOnline: () => void;
  onManual: () => void;
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

export function openTitle(host: HTMLElement, opts: TitleOptions): () => void {
  // 用宿主自己的 document，而不是全局的那个：界面用例跑在 jsdom 里，
  // 那里没有全局 document（第一版就是这么红的：document is not defined）。
  const doc = host.ownerDocument;
  const layer = doc.createElement('div');
  layer.className = 'title-screen';
  layer.innerHTML = `
    <div class="title-bg" aria-hidden="true">${Array.from({ length: 48 }, (_, i) => {
      const t = i % 12;
      return `<i style="--d:${(t / 12).toFixed(2)};--r:${(i * 37) % 100}"></i>`;
    }).join('')}</div>
    <div class="title-inner">
      <p class="title-kicker">回合制 · 方格战棋</p>
      <h1 class="title-name">时代与回旋镖</h1>
      <p class="title-sub">从青铜到信息化：六个时代的产兵、经济与攻城</p>

      <div class="title-actions">
        <button class="title-btn primary" data-act="new">开始对局</button>
        <button class="title-btn" data-act="continue" ${opts.hasSave ? '' : 'disabled'}>继续上一局</button>
      </div>

      <div class="title-links">
        <button data-act="online">联机对战</button>
        <span>·</span>
        <button data-act="manual">规则手册</button>
        ${opts.latest ? '<span>·</span><span class="title-latest"></span>' : ''}
      </div>

      <ol class="title-era" aria-label="六个时代">
        ${ERA_STRIP.map(([name, color]) => `<li><i style="background:${color}"></i>${name}</li>`).join('')}
      </ol>

      <p class="title-foot">v${opts.version} · 支持三 / 四人局 · 三十余个扩展包 · AI 可调档</p>
    </div>
  `;

  // 用 textContent 写"最近更新"，避免把外部字符串当 HTML 插进来
  const latest = layer.querySelector('.title-latest');
  if (latest) latest.textContent = opts.latest ?? '';

  const close = (): void => {
    layer.remove();
    win.removeEventListener('keydown', onKey);
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && opts.hasSave) close();
  };
  const win = doc.defaultView ?? window;
  win.addEventListener('keydown', onKey);

  layer.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
    if (!btn || (btn as HTMLButtonElement).disabled) return;
    switch (btn.dataset.act) {
      case 'new':
        close();
        opts.onNew();
        break;
      case 'continue':
        close();
        opts.onContinue();
        break;
      case 'online':
        close();
        opts.onOnline();
        break;
      case 'manual':
        // 规则手册是 public/ 下的静态页，新开一个标签，别把对局页顶掉
        win.open('manual.html', '_blank', 'noopener');
        break;
    }
  });

  host.appendChild(layer);
  // 焦点给主按钮：键盘用户按两下就能开局，不用 Tab 穿越整页
  layer.querySelector<HTMLButtonElement>('.title-btn.primary')?.focus();
  return close;
}
