/**
 * 复盘控制条。
 *
 * 位置和指挥官栏同一个槽（顶栏下面、棋盘上面），因为它要回答的是同一类问题：
 * "现在这一帧是什么，我能往前挪多少"。放在底栏的话，小屏上会和缩放条打架。
 *
 * ── 四个刻意的决定 ──────────────────────────────────────────────────────
 *
 * 1. **滑块按"步"而不是按"回合"**。复盘要看的是"第 37 步它把三个兵送进了射程"，
 *    按回合滑只能停在"第 12 回合"，中间那七步还得再点七下。
 *
 * 2. **能拖到的上限是"真的走通了的那一步"，不是"报告里写了多少步"**。
 *    两者不一样就说明中途对不上了（版本差异、老报告、日志截断），
 *    这时滑块上限跟着缩短，并在下面明说——让玩家一眼看出"复盘到这里为止"，
 *    而不是拖到头发现后面的帧全是重复的。
 *
 * 3. **提示行常驻**，不做 toast。复盘最要紧的信息是"这份数据准不准"，
 *    toast 三秒就没了，而玩家要边看边判断。
 *
 * 4. **结构只建一次，之后只改数字**（`replayBarHtml` + `syncReplayBar` 两段）。
 *    每帧整段重建 innerHTML 会把滑块节点换掉——玩家正拖着进度条，手指下面那块
 *    DOM 突然消失，拖拽就断了。这不是"优化"，是"拖动要能用"。
 */

export interface ReplayUi {
  /** 文件名，只用来认"我看的是哪一份" */
  name: string;
  /** 当前停在第几步（0 = 开局） */
  index: number;
  /** 真的能走到的最后一步（可能小于报告里声明的步数） */
  total: number;
  /** 当前这一帧是第几回合 */
  turn: number;
  /** 轮到谁（名字） */
  current: string;
  /** 已经分出胜负的话是谁 */
  winner: string | null;
  playing: boolean;
  /** 播放倍速：1 / 2 / 4 */
  speed: number;
  /** 一行环境描述：尺寸 · 人数 · 扩展 · 种子 */
  metaLine: string;
  /** 是不是"按参数原样还原"（false 就是按种子重建，可能不完全一致） */
  exact: boolean;
  warnings: string[];
}

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** 建外壳。只在进入复盘 / 换一份文件时调一次 */
export function replayBarHtml(ui: ReplayUi): string {
  const warn =
    ui.warnings.length === 0
      ? ''
      : `<div class="rp-warn" role="status"><b>注意</b><span>${ui.warnings.map(esc).join(' · ')}</span></div>`;

  return `
    <div class="rp-row">
      <span class="rp-badge">复盘</span>
      <span class="rp-name" title="${esc(ui.name)}">${esc(ui.name)}</span>
      <span class="rp-meta">${esc(ui.metaLine)}${ui.exact ? '' : ' · 按种子重建'}</span>
      <span class="rp-pos" data-ref="rp-pos"></span>
      <span class="rp-spacer"></span>
      <div class="rp-controls">
        <button class="btn btn-sm" data-act="rp-first" title="回到开局（Home）" data-ref="rp-first">⏮</button>
        <button class="btn btn-sm" data-act="rp-prev" title="上一步（←）" data-ref="rp-prev">◀</button>
        <button class="btn btn-sm btn-primary" data-act="rp-toggle" data-ref="rp-toggle" title="播放 / 暂停（空格）">播放</button>
        <button class="btn btn-sm" data-act="rp-next" title="下一步（→）" data-ref="rp-next">▶</button>
        <button class="btn btn-sm" data-act="rp-last" title="跳到终局（End）" data-ref="rp-last">⏭</button>
        ${[1, 2, 4]
          .map(
            (n) =>
              `<button class="rp-chip" data-act="rp-speed" data-speed="${n}" data-ref="rp-speed-${n}" title="${n} 倍速">${n}×</button>`,
          )
          .join('')}
      </div>
      <button class="btn btn-sm" data-act="rp-exit" title="退出复盘，回到你那局（Esc）">退出复盘</button>
    </div>
    <div class="rp-seek">
      <input
        type="range"
        data-act="rp-seek"
        data-ref="rp-seek"
        min="0"
        max="${Math.max(0, ui.total)}"
        step="1"
        value="0"
        aria-label="复盘进度"
      />
    </div>
    ${warn}
  `;
}

/**
 * 只改数字。每次重绘都会调它，所以这里不许重建节点。
 *
 * 滑块单独处理：**正在拖的时候不写 value**。手指按住的时候把 value 改成
 * 和手指不一样的值，会让滑块"跳回去"——那是浏览器在跟你的输入打架。
 */
export function syncReplayBar(root: HTMLElement, ui: ReplayUi, seeking: boolean): void {
  const q = <T extends Element>(sel: string): T | null => root.querySelector<T>(sel);

  const pos = q<HTMLElement>('[data-ref="rp-pos"]');
  if (pos) {
    const who = ui.winner ? `${ui.winner}已获胜` : `轮到${ui.current}`;
    pos.innerHTML = `<b>${ui.index}</b><i>/${ui.total}</i> 步 · 第 ${ui.turn} 回合 · ${esc(who)}`;
  }

  const slider = q<HTMLInputElement>('[data-ref="rp-seek"]');
  if (slider) {
    if (!seeking) slider.value = String(ui.index);
    if (slider.max !== String(ui.total)) slider.max = String(ui.total);
  }

  const atStart = ui.index <= 0;
  const atEnd = ui.index >= ui.total;
  const setDisabled = (ref: string, off: boolean): void => {
    const el = q<HTMLButtonElement>(`[data-ref="${ref}"]`);
    if (el) el.disabled = off;
  };
  setDisabled('rp-first', atStart);
  setDisabled('rp-prev', atStart);
  setDisabled('rp-next', atEnd);
  setDisabled('rp-last', atEnd);

  const toggle = q<HTMLButtonElement>('[data-ref="rp-toggle"]');
  if (toggle) {
    const label = ui.playing ? '暂停' : '播放';
    if (toggle.textContent !== label) toggle.textContent = label;
  }
  for (const n of [1, 2, 4]) {
    const chip = q<HTMLElement>(`[data-ref="rp-speed-${n}"]`);
    if (chip) chip.classList.toggle('active', ui.speed === n);
  }
}
