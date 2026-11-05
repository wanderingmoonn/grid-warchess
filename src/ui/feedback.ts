/**
 * 「反馈」面板：对局打到一半发现不对劲，随手拍一张快照传上来。
 *
 * 为什么这件事要单独做一层面板，而不是塞进结算卡：
 *
 *   · 结算卡只在**打完**出现，而 bug 恰恰发生在"打不下去"的时候——
 *     攻城伤害算错、兵卡在水里、AI 不动了，这时候棋还没结束；
 *   · 找 bug 要的是"当时那一刻的现场"，隔十分钟再复述就只剩一句"它就卡住了"。
 *
 * 所以入口固定在顶栏，任何时候都能点。面板里只做三件事：
 * 写一句话、决定要不要带逐回合摘要、上传（或复制出来自己发）。
 *
 * 隐私口径写在同一屏上，不折叠、不藏在链接后面：这份快照**带名字和坐标**，
 * 和结算时那份匿名数据不是一回事。看得见，才谈得上同意。
 */

import type { GameState } from '../core/types.ts';
import { BUILD_VERSION } from '../core/build-info.ts';
import type { MatchTimeline } from '../core/timeline.ts';
import {
  buildSnapshot,
  snapshotFileName,
  snapshotHeadline,
  snapshotJson,
  type SnapshotEnv,
} from '../core/snapshot.ts';
import { uploadSnapshot } from '../net/snapshots.ts';

function esc(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function readEnv(): SnapshotEnv | undefined {
  try {
    return {
      ua: navigator.userAgent.slice(0, 240),
      lang: navigator.language,
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
      w: window.innerWidth,
      h: window.innerHeight,
      dpr: Math.round((window.devicePixelRatio ?? 1) * 100) / 100,
    };
  } catch {
    return undefined;
  }
}

export interface FeedbackOptions {
  /** 取当前局面。面板开着的时候 AI 可能还在走，所以每次用的时候现取 */
  current: () => GameState;
  /** 逐回合摘要（没勾「记录详细数据」时是 null） */
  timeline: () => MatchTimeline | null;
}

export function openFeedbackPanel(opts: FeedbackOptions): void {
  const mask = document.createElement('div');
  mask.className = 'modal-mask';

  // 逐回合摘要这一局有没有，是打开面板时就定下来的：中途不会有人再去勾它
  const hasTimeline = (opts.timeline()?.samples.length ?? 0) > 0;
  let note = '';
  let withTimeline = hasTimeline;
  let busy = false;
  let result = '';
  let resultBad = false;

  const close = () => mask.remove();

  const paint = () => {
    const s = opts.current();
    mask.innerHTML = `
      <div class="modal feedback-modal">
        <div class="modal-head">
          <h2>报告问题</h2>
          <p>把这一盘棋的现场拍下来。带上完整局面，收到的人用「导入对局」就能还原到同一手。</p>
        </div>

        <div class="modal-body">
          <div class="fb-summary">
            <b>${esc(snapshotHeadline(s))}</b>
            <span>种子 ${s.seed} · 版本 ${esc(BUILD_VERSION)}</span>
          </div>

          <label class="fb-field">
            <span class="fb-label">发生了什么（可选）</span>
            <textarea class="fb-text" data-field="note" rows="3" maxlength="500"
              placeholder="例：攻城时投石车打城墙，伤害算成了 0 / 这个兵卡在水里走不动 / AI 第 3 回合就不动了">${esc(note)}</textarea>
          </label>

          ${
            hasTimeline
              ? `<label class="fb-check">
                   <input type="checkbox" data-field="with-timeline" ${withTimeline ? 'checked' : ''} />
                   <span>连同逐回合摘要与动作序列一起传（兵力曲线、出兵战损，以及每一步动作——可在本地重放这局）</span>
                 </label>`
              : `<div class="fb-hint">这一局没开「记录详细数据」，所以只有当前局面，没有逐回合曲线。下次开新局时在战役页勾上就有。</div>`
          }

          <div class="fb-hint fb-privacy">
            这次上传的内容：<b>完整局面</b>——双方单位的位置、血量、玩家名，以及最近 60 条日志（含格子坐标）、
            当前所有规则开关。用来复现问题。<br />
            它和结算时上传的那份「匿名平衡数据」是两张表：那份不带名字和坐标，这份带。
            不想上传也可以复制成 JSON 直接发给作者。
          </div>

          ${result ? `<div class="fb-result ${resultBad ? 'is-bad' : 'is-ok'}">${esc(result)}</div>` : ''}
        </div>

        <div class="modal-foot">
          <button class="btn" data-act="close">关闭</button>
          <button class="btn" data-act="copy">复制 JSON</button>
          <button class="btn btn-primary" data-act="upload" ${busy ? 'disabled' : ''}>
            ${busy ? '上传中…' : '上传'}
          </button>
        </div>
      </div>
    `;
  };

  const take = () => {
    // 用的时候现拍：面板可能开着，AI 又走了好几步
    const s = opts.current();
    return buildSnapshot(s, {
      note,
      env: readEnv(),
      timeline: withTimeline ? opts.timeline() : null,
    });
  };

  mask.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    if (target === mask) {
      close();
      return;
    }
    const act = target.closest<HTMLElement>('[data-act]')?.dataset.act;
    if (act === 'close') {
      close();
      return;
    }
    if (act === 'copy') {
      const snap = take();
      const text = snapshotJson(snap);
      const done = () => {
        result = `已复制（${Math.round(text.length / 1024)}KB），可以直接发给作者`;
        resultBad = false;
        paint();
      };
      // 剪贴板在非 https / 老浏览器里会直接抛，退回到一个能全选的输入框
      navigator.clipboard?.writeText(text).then(done).catch(() => {
        const name = snapshotFileName(snap);
        const w = window.open('', '_blank');
        if (w) {
          w.document.title = name;
          w.document.body.innerHTML = `<pre style="white-space:pre-wrap;font:12px monospace">${esc(text)}</pre>`;
        } else {
          window.prompt('复制下面的内容：', text);
        }
        done();
      });
      return;
    }
    if (act === 'upload') {
      if (busy) return;
      busy = true;
      result = '';
      paint();
      const snap = take();
      void uploadSnapshot(snap).then((res) => {
        busy = false;
        if (res.ok) {
          result = res.duplicate
            ? '这条刚刚已经传过了，云端只留一份'
            : '已上传。谢谢——带上这一手发生了什么，比截图有用得多。';
          resultBad = false;
          // 传成功了就把描述清空：下一次通常是另一个问题
          note = '';
        } else {
          result = [res.reason, res.howTo].filter(Boolean).join('；');
          resultBad = true;
        }
        paint();
      });
      return;
    }
  });

  mask.addEventListener('input', (e) => {
    const el = e.target as HTMLTextAreaElement;
    if (el.dataset.field === 'note') note = el.value;
  });

  mask.addEventListener('change', (e) => {
    const el = e.target as HTMLInputElement;
    if (el.dataset.field === 'with-timeline') withTimeline = el.checked;
  });

  paint();
  document.body.appendChild(mask);
}
