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
  /** 默认棋盘视角是否为斜俯视 */
  angledBoard?: boolean;
  /** 当前局面是否支持斜俯视切换 */
  canAngle?: boolean;
  /** 是否减少动效 */
  reducedMotion: boolean;
  /**
   * 美术贴图（地形材质 + 棋子贴图）。
   *
   * 2026-11-11 一度拆成两个开关，结果用户点了「棋子贴图」发现地面没变——
   * "切换贴图"在心智上是一个动作，拆成两个就得先知道哪个管地面。
   * 现在合并成一个按钮，两个状态仍然分开存（URL 上 `?terrain=on` / `?art=on`
   * 还能各自压控制，做 A/B 时用得上）。
   */
  unitArt?: boolean;
  terrainArt?: boolean;
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
  /**
   * 窄屏专用：把顶栏那两颗「联机」「迷雾」也收进来。
   *
   * 360px 宽的顶栏放不下整套按钮（回合胶囊 + 交给 AI + 联机 + 迷雾 + 设置），
   * 只能横向滚——而这两颗恰恰是"一局点不到一次"的。按频率分层之后，
   * 手机顶栏只剩「回合胶囊 · 交给 AI · 设置」，一个滚动条都不用出现。
   */
  compact?: boolean;
  /** 迷雾开着吗（compact 时设置里要显示状态） */
  fog?: boolean;
  /** 看全图（纯显示，不影响 AI 与规则） */
  showAll?: boolean;
  /** 浓雾蔽野：迷雾锁定，开关只做说明 */
  blackout?: boolean;
  /** 联机房间码；null = 本机对局 */
  roomCode?: string | null;
}

const chip = (on: boolean, act: string, label: string, extra = ''): string =>
  `<button class="chip${on ? ' active' : ''}" data-act="${act}" ${extra}>${label}</button>`;

export function settingsHtml(o: SettingsOptions): string {
  return `
  <div class="modal modal-narrow" role="dialog" aria-label="设置">
    <div class="modal-head">
      <h2>设置</h2>
    </div>

    <div class="modal-body">
      <section class="set-group">
        <div class="set-title">外观 <span class="set-hint">仅此设备</span></div>
        <div class="set-row">
          <div class="set-label">主题
          </div>
          <div class="chip-row">
            ${chip(o.theme === 'legacy', 'set-theme', '浅色', 'data-theme="legacy"')}
            ${chip(o.theme === 'modern', 'set-theme', '深色', 'data-theme="modern"')}
          </div>
        </div>
        ${
          o.canAngle !== false
            ? `<div class="set-row">
          <div class="set-label">默认视角
            <span class="set-hint">斜俯视下按住中键拖转</span>
          </div>
          <div class="chip-row">
            ${chip(o.angledBoard !== false, 'set-board-angle', '斜俯视', 'data-angle="angled"')}
            ${chip(o.angledBoard === false, 'set-board-angle', '正俯视', 'data-angle="flat"')}
          </div>
        </div>`
            : ''
        }
        <div class="set-row">
          <div class="set-label">减少动态效果
          </div>
          <div class="chip-row">
            ${chip(!o.reducedMotion, 'set-motion', '正常', 'data-motion="full"')}
            ${chip(o.reducedMotion, 'set-motion', '减少', 'data-motion="reduced"')}
          </div>
        </div>
        <div class="set-row">
          <div class="set-label">美术贴图
            <span class="set-hint">地形与棋子</span>
          </div>
          <div class="chip-row">
            ${chip(!(o.terrainArt || o.unitArt), 'set-fx', '原版', 'data-fx="off"')}
            ${chip(!!(o.terrainArt || o.unitArt), 'set-fx', '材质', 'data-fx="on"')}
          </div>
        </div>
      </section>

      <section class="set-group">
        <div class="set-title">声音</div>
        <div class="set-row">
          <div class="set-label">铃声
            <span class="set-hint">回合开始时提醒</span>
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
              ? '<span class="set-hint">退出复盘后可导出对局。</span>'
              : '<button class="btn btn-sm" data-act="export">导出对局</button>'
          }
          <button class="btn btn-sm" data-act="new-match">新对局</button>
          <button class="btn btn-sm" data-act="new-game">回首页</button>
        </div>
        <div class="set-row">
          <div class="set-label">新对局快捷键
          </div>
          <div class="set-control">
            <kbd class="set-key">Alt</kbd><span class="set-key-plus">+</span><kbd class="set-key">N</kbd>
          </div>
        </div>
      </section>

      ${
        /*
         * 「对局中」这一组只在窄屏出现。
         *
         * 桌面顶栏本来就有「联机」「迷雾」两颗按钮，这里再放一份就是两处状态、
         * 两条路径；手机上顶栏放不下，它们才搬进来。
         */
        o.compact
          ? `<section class="set-group">
        <div class="set-title">对局中</div>
        <div class="set-row">
          <div class="set-label">迷雾
            <span class="set-hint">${
              o.blackout
                ? '「浓雾蔽野」已锁定开启。'
                : '关闭会改变双方迷雾规则。'
            }</span>
          </div>
          <div class="chip-row">
            <button class="chip${o.fog ? ' active' : ''}" data-act="toggle-fog" ${
              o.blackout ? 'disabled' : ''
            }>${o.fog ? '开' : '关'}</button>
          </div>
        </div>
        <div class="set-row">
          <div class="set-label">看全图
            <span class="set-hint">仅改变显示，不影响 AI 视野。</span>
          </div>
          <div class="chip-row">
            <button class="chip${o.showAll ? ' active' : ''}" data-act="toggle-show-all">${
              o.showAll ? '开' : '关'
            }</button>
          </div>
        </div>
        <div class="set-row">
          <div class="set-label">联机
            <span class="set-hint">${
              o.roomCode ? `当前房间 ${o.roomCode}` : '创建或加入房间'
            }</span>
          </div>
          <button class="btn btn-sm" data-act="online">${o.roomCode ? '房间' : '联机'}</button>
        </div>
      </section>`
          : ''
      }

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
