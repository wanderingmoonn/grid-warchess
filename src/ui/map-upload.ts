/**
 * 上帝模式 →「上传这张图」。
 *
 * 这一屏只干一件事：把沙盒里摆出来的地形和城位**交到云端地图库**，并说清
 * 交上去之后会发生什么。三件事必须摆在明面上，否则作者会对结果产生错误预期：
 *
 *   1. **要审核**。传上去不是立刻可见，先排队，放行之后才出现在「玩家上传地图」里。
 *      这句话不写，作者会以为"传完别人就能选"，然后来回问为什么看不到。
 *   2. **地形原样上传，不改一格**。扩展地形（台地/沼泽/浅流…）也是合法地形，
 *      渲染、移动、视野都支持；只提醒一句"这张图用了扩展地形"，
 *      因为别人的对局里不会自然生成它们。
 *   3. **城位照搬，不替他挪**。贴边、在角上都能传——那是正经的地图设计。
 *      只有"2×2 框不进棋盘"这种数据不成立的情况才拦。
 *
 * 另外要说清地图里**没有兵**：地图只有地形和城，兵是开局后自己造的
 * （能不能造某个兵取决于这一局开了哪些扩展，和地图无关）。
 */

import { mapToText, registerUserMaps, type FixedMap } from '../core/fixed-maps.ts';
import { stateToFixedMap } from '../core/map-export.ts';
import type { GameState } from '../core/types.ts';
import { uploadSharedMap } from '../net/maps.ts';

const AUTHOR_KEY = 'warchess.maps.author';

const esc = (t: string): string =>
  t.replace(/[&<>"]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;'));

export interface MapUploadOptions {
  state: GameState;
  onClose?: () => void;
}

export function openMapUpload(opts: MapUploadOptions): void {
  const { state } = opts;
  const mask = document.createElement('div');
  mask.className = 'modal-mask';

  let name = `我的战场 ${new Date().toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })}`;
  let author = '';
  try {
    author = localStorage.getItem(AUTHOR_KEY) ?? '';
  } catch {
    /* 隐私模式：留空 */
  }
  /** '' | 'busy' | 'done' */
  let phase: '' | 'busy' | 'done' = '';
  let note = '';
  let bad = false;

  const close = (): void => {
    mask.remove();
    opts.onClose?.();
  };

  /**
   * 每次重绘都重新导出一次。
   *
   * 看着像浪费，其实是故意的：名字、地形、城位三者里任何一个变了，结果就会变，
   * 而这条链路是纯函数、几十微秒的事。缓存反而要处理"什么时候失效"。
   */
  const build = () => stateToFixedMap(state, name.trim() || '未命名');

  const statLine = (map: FixedMap): string => {
    const count: Record<string, number> = {};
    for (const row of map.rows) for (const ch of row) count[ch] = (count[ch] ?? 0) + 1;
    const parts = [
      `${map.w}×${map.h}`,
      `红方 ${map.citiesA.length} 城`,
      `蓝方 ${map.citiesB.length} 城`,
      `平原 ${count['.'] ?? 0}`,
      `森林 ${count.f ?? 0}`,
      `丘陵 ${count.h ?? 0}`,
      `水 ${count['~'] ?? 0}`,
      `山 ${count['^'] ?? 0}`,
    ];
    if (count['=']) parts.push(`桥 ${count['=']}`);
    return parts.join(' · ');
  };

  const body = (): string => {
    const built = build();

    if (!built.ok) {
      return `
        <div class="modal-body">
          <div class="map-err">
            <b>这张图还传不了</b>
            <ul>${built.errors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul>
          </div>
          ${built.note ? `<p class="field-hint">${esc(built.note)}</p>` : ''}
          <label class="editor-field">
            <span>地图名</span>
            <input data-field="name" maxlength="24" value="${esc(name)}" placeholder="最多 24 个字" />
          </label>
        </div>
        <div class="modal-foot">
          <button class="btn" data-act="close">关闭</button>
        </div>`;
    }

    const map = built.map!;
    return `
      <div class="modal-body">
        <p class="field-hint">${esc(statLine(map))}</p>
        ${built.note ? `<p class="field-hint">${esc(built.note)}</p>` : ''}
        <label class="editor-field">
          <span>地图名</span>
          <input data-field="name" maxlength="24" value="${esc(name)}" placeholder="最多 24 个字" />
        </label>
        <label class="editor-field">
          <span>作者</span>
          <input data-field="author" maxlength="24" value="${esc(author)}" placeholder="留空就是匿名" />
        </label>
        <p class="field-hint">
          传上去先进审核队列，<b>放行之后</b>才会出现在开局面板的「玩家上传地图」里。
          审核没过的图不会公开，你本机仍然能玩到它。
        </p>
        ${note ? `<div class="${bad ? 'map-err' : 'map-ok'}">${esc(note)}</div>` : ''}
      </div>
      <div class="modal-foot">
        <button class="btn btn-sm" data-act="copy" title="复制成纯文本，粘到记事本里就能存下来">复制文本</button>
        <button class="btn btn-primary" data-act="upload" ${phase === 'busy' ? 'disabled' : ''}>
          ${phase === 'busy' ? '正在上传…' : phase === 'done' ? '再传一次' : '上传（待审核）'}
        </button>
        <button class="btn" data-act="close">关闭</button>
      </div>`;
  };

  const paint = (): void => {
    mask.innerHTML = `
      <div class="modal">
        <div class="modal-head">
          <h2>上传这张地图</h2>
          <p>把现在沙盒里的地形和城位交到云端地图库。地形原样带上去，一格都不改。</p>
          <p>地图里<b>没有兵</b>：兵种是开局后自己造的，能不能造某个兵只取决于那一局开了哪些扩展，和这张图无关。</p>
        </div>
        ${body()}
      </div>`;
    // 输入框重新拿到焦点：重绘会把焦点丢掉，正在打字的人会以为输入被吃了
    const input = mask.querySelector<HTMLInputElement>('[data-field="name"]');
    if (input && document.activeElement !== input) input.focus();
    input?.setSelectionRange(name.length, name.length);
  };

  mask.addEventListener('input', (e) => {
    const el = e.target as HTMLInputElement;
    if (el.dataset.field === 'name') name = el.value;
    if (el.dataset.field === 'author') author = el.value;
  });

  mask.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    if (target === mask) {
      close();
      return;
    }
    const act = target.closest<HTMLElement>('[data-act]')?.dataset.act;
    if (!act) return;

    if (act === 'close') {
      close();
      return;
    }

    if (act === 'copy') {
      const built = build();
      if (!built.ok || !built.map) return;
      const text = mapToText(built.map);
      // 剪贴板可能被拒（非 https / 没授权）：不弹窗，把文本塞进状态行让用户自己选
      void navigator.clipboard?.writeText(text).then(
        () => {
          note = '已复制。粘到记事本存成 .txt，以后用「选文件」也能传上来。';
          bad = false;
          paint();
        },
        () => {
          note = '剪贴板被拒了，换「上传」或者手动导出吧';
          bad = true;
          paint();
        },
      );
      return;
    }

    if (act !== 'upload') return;
    const built = build();
    if (!built.ok || !built.map) return;
    const map = built.map;

    phase = 'busy';
    note = '';
    bad = false;
    paint();
    try {
      localStorage.setItem(AUTHOR_KEY, author);
    } catch {
      /* 存不下不影响这次上传 */
    }

    void uploadSharedMap(map, author.trim() || undefined, { pending: true }).then((res) => {
      if (!res.ok) {
        phase = '';
        note = res.reason ?? '上传失败';
        if (res.howTo) note += ` · ${res.howTo}`;
        bad = true;
        paint();
        return;
      }
      phase = 'done';
      bad = false;
      note = res.pending
        ? `已提交「${map.name}」，等审核放行。你本机已经能用它开局（开局面板的「玩家上传」里）。`
        : `已上传「${map.name}」`;
      // 登记进本机注册表：审核期间作者自己要能玩到这张图
      if (res.map) registerUserMaps([res.map]);
      paint();
    });
  });

  paint();
  document.body.appendChild(mask);
}
