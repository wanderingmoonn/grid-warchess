/**
 * 设置弹窗。
 *
 * 为什么要有它：顶栏本来有一排"低频但重要"的入口（规则书 / 反馈 / 导出 / 回首页），
 * 再加上 2026-11-11 做的主题开关——它们共同的问题是**没有家**。挤在顶栏会被
 * 每回合都要看的「迷雾」「交给 AI」淹没，塞进控制台又只有开发者找得到。
 *
 * 所以给一个正经的设置面板，按"改什么"分组：
 *   · 外观：主题（旧版 / 新版）、减少动效
 *   · 声音：铃声音量
 *   · 对局：导出对局、回首页
 *   · 其它：规则书、反馈问题
 *
 * 只负责**渲染**，开合与落盘都在 main（这个文件是纯函数，方便测）。
 */

export interface SettingsOptions {
  /** 当前主题（legacy / modern） */
  theme: 'legacy' | 'modern';
  /** 是否减少动效 */
  reducedMotion: boolean;
  /** 铃声音量 0~1 */
  chime: number;
  /** 铃声那一行右边显示的文字（"铃声 60%"，来自 sound.ts） */
  chimeText: string;
  /**
   * 正在复盘别人的棋。
   *
   * 复盘时 `state` 是别人那一局的某一帧，`export` 导出去的就是别人那局——
   * 原来顶栏那颗按钮在复盘里是藏起来的，搬进设置之后这条规矩得跟着搬过来，
   * 否则"藏了入口"变成"换了个地方露出来"。
   */
  replay?: boolean;
}

const chip = (on: boolean, act: string, label: string, extra = ''): string =>
  `<button class="chip${on ? ' active' : ''}" data-act="${act}" ${extra}>${label}</button>`;

export function settingsHtml(o: SettingsOptions): string {
  return `
  <div class="modal modal-narrow" role="dialog" aria-label="设置">
    <div class="modal-head">
      <h2>设置</h2>
      <p>这些选项只影响这台设备上的这个浏览器，不进存档、不影响对局公平。</p>
    </div>

    <div class="modal-body">
      <section class="set-group">
        <div class="set-title">外观</div>
        <div class="set-row">
          <div class="set-label">主题
            <span class="set-hint">新版是深色界面。棋盘和地形色不变——认得出地形比"整体统一"重要。</span>
          </div>
          <div class="chip-row">
            ${chip(o.theme === 'legacy', 'set-theme', '旧版', 'data-theme="legacy"')}
            ${chip(o.theme === 'modern', 'set-theme', '新版', 'data-theme="modern"')}
          </div>
        </div>
        <div class="set-row">
          <div class="set-label">减少动态效果
            <span class="set-hint">关掉面板与按钮的过渡动画。前庭敏感的人需要的是"不动"，不是"动得快"。</span>
          </div>
          <div class="chip-row">
            ${chip(!o.reducedMotion, 'set-motion', '正常', 'data-motion="full"')}
            ${chip(o.reducedMotion, 'set-motion', '减少', 'data-motion="reduced"')}
          </div>
        </div>
      </section>

      <section class="set-group">
        <div class="set-title">声音</div>
        <div class="set-row">
          <div class="set-label">铃声
            <span class="set-hint">轮到你了才响一声。放在桌上等对手的人靠它回神。</span>
          </div>
          <div class="set-control">
            <input class="set-range" type="range" min="0" max="100" step="5"
              value="${Math.round(o.chime * 100)}" data-act="chime-range" aria-label="铃声音量" />
            <span class="set-value">${o.chimeText}</span>
            <button class="btn btn-sm" data-act="chime-test">试听</button>
          </div>
        </div>
      </section>

      <section class="set-group">
        <div class="set-title">对局</div>
        <div class="set-actions">
          ${
            o.replay
              ? '<span class="set-hint">复盘里不给导出：先点复盘条上的「退出」，回到你那局再导。</span>'
              : '<button class="btn btn-sm" data-act="export">导出对局</button>'
          }
          <button class="btn btn-sm" data-act="new-game">回首页</button>
        </div>
      </section>

      <section class="set-group">
        <div class="set-title">其它</div>
        <div class="set-actions">
          <button class="btn btn-sm" data-act="manual">规则书</button>
          <button class="btn btn-sm" data-act="feedback">反馈问题</button>
        </div>
      </section>
    </div>

    <div class="modal-foot">
      <button class="btn btn-sm btn-primary" data-act="settings-close">完成</button>
    </div>
  </div>`;
}
