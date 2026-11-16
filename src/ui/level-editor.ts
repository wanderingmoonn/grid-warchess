/**
 * 关卡编辑器（第一版：**改 JSON**，不画图）。
 *
 * 为什么第一版不做画布：先把"数据 → 校验 → 存起来 → 能开打"这条链跑通。
 * 画布（E2）、摆兵（E3）、事件表单（E4）都是往这一版里加面板，
 * 而不是另起一个界面——所以这里的壳要留得能长大：
 *   · 左边是数据，右边是问题列表，中间不塞别的东西；
 *   · 所有"改数据"的动作都写 `text`，再由 `text` 单向解析。**没有第二份状态**，
 *     免得出现"面板显示 A、存下去是 B"。
 *
 * 三件事这一版必须做对：
 *   1. 错要**一次全列出来**，还要能指到格子（`lintLevel` 的 `at`）；
 *   2. 写了一半关掉浏览器不能丢（草稿箱存的是文本，不是对象）；
 *   3. 内置关卡只读——想改就"另存为副本"，永远有一份原版能对照。
 */

import {
  cloneAsUserLevel,
  clearDraft,
  draftOf,
  exportLevelText,
  isUserLevelId,
  newLevelId,
  parseLevelText,
  saveDraft,
  saveUserLevel,
} from '../core/userLevels.ts';
import { lintLevel, type LevelIssue } from '../core/level-lint.ts';
import type { LevelDef } from '../core/level.ts';

export interface LevelEditorResult {
  saved: boolean;
  /** 存下来的那一份（`saved` 为 true 时有） */
  level?: LevelDef;
}

export interface LevelEditorOptions {
  /** 要编辑的关卡。不传 = 新建 */
  level?: LevelDef;
  onClose?: (result: LevelEditorResult) => void;
}

const esc = (t: string) =>
  t.replace(/[&<>"]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;'));

/**
 * 新建关卡的起点。
 *
 * 故意做成"能直接开局"的一张：12×12、两家、各两个兵、没有事件。
 * 新手最怕的是打开一个空编辑器不知道从哪儿下手——给一张能跑的图，
 * 改一个数字就能看出差别，这比任何教程都直接。
 */
function starterLevel(): LevelDef {
  const id = newLevelId();
  return {
    id,
    version: 1,
    name: '我的关卡',
    brief: '改这一句，它会印在选关卡片上。',
    map: {
      id: `levelmap:${id}`,
      name: '我的关卡',
      w: 12,
      h: 10,
      rows: [
        '............',
        '....f.......',
        '............',
        '...h........',
        '............',
        '............',
        '........h...',
        '............',
        '.......f....',
        '............',
      ],
      citiesA: [{ x: 1, y: 1 }],
      citiesB: [{ x: 9, y: 7 }],
      source: 'user',
    },
    seats: { count: 2, ai: ['B'] },
    setup: { startEra: 1 },
    deploy: {
      A: [
        { type: 'militia', x: 3, y: 2 },
        { type: 'archer', x: 3, y: 4 },
      ],
      B: [
        { type: 'militia', x: 8, y: 7 },
        { type: 'archer', x: 8, y: 5 },
      ],
    },
  };
}

export function openLevelEditor(opts: LevelEditorOptions = {}): void {
  const editing = opts.level;
  /** 内置关卡只读；"另存为副本"之后会把它换成 false */
  let readOnly = !!editing && !isUserLevelId(editing.id);
  /** 当前编辑的是哪一份（草稿按它归位） */
  let key = editing?.id ?? 'new';
  let text = editing ? exportLevelText(editing) : exportLevelText(starterLevel());

  // 上次写了一半的，优先拿回来。**只在内容确实不一样时**覆盖，免得把刚打开的模板冲掉
  const draft = draftOf(key);
  const restored = !!draft && draft.trim().length > 0;
  if (restored) text = draft!;

  /** 上次成功存下去的文本：用来判断"关掉会不会丢东西" */
  let savedText = editing ? exportLevelText(editing) : '';
  /** 这一次编辑里最后存成的那一份。关闭时才回传给面板——中途回传会让面板在建局配置里反复重绘 */
  let lastSaved: LevelDef | null = null;

  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  mask.innerHTML = `
    <div class="modal wide">
      <div class="modal-head">
        <h2>关卡编辑器</h2>
        <p>
          这一版改的是<b>数据</b>：地图、兵力、事件、胜负全在一份 JSON 里。
          改完点「保存」，它就会出现在选关页的「我的关卡」里。
          ${restored ? '<br><b>已恢复上次没写完的草稿。</b>' : ''}
        </p>
      </div>
      <div class="modal-body">
        <div class="editor-toolbar">
          <button class="btn btn-primary btn-sm" data-act="save">保存到我的关卡</button>
          <button class="btn btn-sm" data-act="clone">${readOnly ? '复制成我的关卡' : '另存为副本'}</button>
          <button class="btn btn-sm" data-act="copy">复制 JSON</button>
          <button class="btn btn-sm" data-act="reset">恢复成${readOnly ? '原版' : '初始模板'}</button>
        </div>
        <div class="editor-grid level-editor-head">
          <label class="editor-field"><span>名称</span><input data-name maxlength="24"></label>
          <label class="editor-field"><span>一句话简介</span><input data-brief maxlength="120"></label>
        </div>
        <div class="level-editor-grid">
          <textarea class="level-json" spellcheck="false" wrap="off"></textarea>
          <div class="level-side">
            <div class="level-summary"></div>
            <div class="level-issues"></div>
          </div>
        </div>
        <div class="field-hint" data-foot></div>
      </div>
      <div class="modal-foot">
        <button class="btn" data-act="close">关闭</button>
      </div>
    </div>`;

  const q = <T extends Element>(sel: string): T => mask.querySelector(sel) as T;
  const ta = q<HTMLTextAreaElement>('.level-json');
  const nameEl = q<HTMLInputElement>('[data-name]');
  const briefEl = q<HTMLInputElement>('[data-brief]');
  const issuesEl = q<HTMLDivElement>('.level-issues');
  const summaryEl = q<HTMLDivElement>('.level-summary');
  const footEl = q<HTMLDivElement>('[data-foot]');
  const saveBtn = q<HTMLButtonElement>('[data-act="save"]');

  ta.value = text;

  let timer: number | null = null;

  const renderIssues = (errs: string[], issues: LevelIssue[]): void => {
    const rows: string[] = [];
    for (const e of errs) {
      rows.push(`<div class="level-issue is-error"><b>过不了校验</b>${esc(e)}</div>`);
    }
    // 错误在前、警告在后：作者先看到"必须改"，再看"建议看"
    const sorted = [...issues].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1));
    for (const it of sorted) {
      const where = it.at ? `<span class="level-issue-meta">（第 ${it.at.x}, ${it.at.y} 格）</span>` : '';
      rows.push(
        `<div class="level-issue is-${it.severity}"><b>${it.severity === 'error' ? '会出问题' : '提醒'}</b>${esc(
          it.text,
        )}${where}</div>`,
      );
    }
    issuesEl.innerHTML =
      rows.length > 0 ? rows.join('') : '<div class="level-issue is-ok"><b>没问题</b>这份数据能直接开局。</div>';
  };

  const renderSummary = (level: LevelDef | null): void => {
    if (!level) {
      summaryEl.innerHTML = '<div class="level-summary-line">还读不出内容</div>';
      return;
    }
    const n = level.seats?.count ?? 2;
    const ev = level.events?.length ?? 0;
    const dep = Object.keys(level.deploy ?? {}).length;
    summaryEl.innerHTML = `
      <div class="level-summary-line"><b>${esc(level.name)}</b></div>
      <div class="level-summary-line">${level.map.w}×${level.map.h} · ${n} 家 · ${ev} 处事件 · ${
        dep > 0 ? `${dep} 家有开局兵力` : '自动撒兵'
      }</div>
      <div class="level-summary-line level-summary-id">${esc(level.id)}</div>`;
  };

  /** 解析 + 校验 + 上屏。所有改文本的路径最后都走它，**没有第二份状态** */
  const refresh = (): void => {
    text = ta.value;
    const parsed = parseLevelText(text);
    if (!parsed.ok) {
      renderSummary(null);
      renderIssues(parsed.errors, []);
      saveBtn.disabled = readOnly;
      footEl.textContent = readOnly
        ? '这是内置关卡，只读。想改就点「复制成我的关卡」。'
        : '还没到能存的程度：先把上面的问题改掉。';
      return;
    }
    const level = parsed.level;
    if (document.activeElement !== nameEl) nameEl.value = level.name;
    if (document.activeElement !== briefEl) briefEl.value = level.brief ?? '';
    renderSummary(level);
    renderIssues([], lintLevel(level));
    saveBtn.disabled = readOnly;
    footEl.textContent = readOnly
      ? '这是内置关卡，只读。想改就点「复制成我的关卡」。'
      : '存下来之后它会出现在选关页的「我的关卡」里。';
  };

  /**
   * 把名称/简介写回 JSON。
   *
   * 在 **change（失焦）** 时写，不是每敲一个字就写：一是免得和用户正在编辑的
   * 文本互相打断，二是 JSON 重新序列化会把光标位置和注释性的格式全部冲掉。
   */
  const writeBack = (field: 'name' | 'brief', value: string): void => {
    const parsed = parseLevelText(text);
    if (!parsed.ok) return; // JSON 还是坏的，先别动它
    const next: LevelDef = { ...parsed.level, [field]: value.trim() };
    if (field === 'brief' && !value.trim()) delete (next as { brief?: string }).brief;
    try {
      ta.value = exportLevelText(next);
    } catch {
      return;
    }
    refresh();
  };

  mask.addEventListener('input', (ev) => {
    const el = ev.target as HTMLElement;
    if (el === ta) {
      if (timer !== null) clearTimeout(timer);
      timer = window.setTimeout(() => {
        saveDraft(key, ta.value);
        refresh();
      }, 300);
      return;
    }
    if (el === nameEl) return; // 交给 change
  });

  mask.addEventListener('change', (ev) => {
    const el = ev.target as HTMLElement;
    if (el === nameEl) writeBack('name', nameEl.value);
    if (el === briefEl) writeBack('brief', briefEl.value);
  });

  mask.addEventListener('click', (ev) => {
    const btn = (ev.target as HTMLElement).closest<HTMLElement>('[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;

    if (act === 'close') {
      if (timer !== null) clearTimeout(timer);
      // 没存就关：一定要问一句。草稿还在，但要让人知道"下次会接着上次"
      if (ta.value !== savedText && ta.value.trim() !== '') {
        if (!window.confirm('还没保存。放掉的内容会留在草稿里，下次打开这张关会自动接着改。关闭吗？')) return;
        saveDraft(key, ta.value);
      }
      mask.remove();
      opts.onClose?.({ saved: !!lastSaved, level: lastSaved ?? undefined });
      return;
    }

    if (act === 'reset') {
      if (!window.confirm('把编辑器里的内容换成初始版本？现在的改动会丢掉。')) return;
      // 有"原来的那一份"就回到它，没有（新建）才回到模板。别用 starterLevel：
      // 它每次生成新 id，点一下"恢复"就变成另一张关了
      text = editing ? exportLevelText(editing) : exportLevelText(starterLevel());
      ta.value = text;
      clearDraft(key);
      refresh();
      return;
    }

    if (act === 'copy') {
      void navigator.clipboard?.writeText(ta.value);
      footEl.textContent = '已复制到剪贴板。';
      return;
    }

    if (act === 'clone') {
      const parsed = parseLevelText(ta.value);
      if (!parsed.ok) {
        renderIssues(parsed.errors, []);
        footEl.textContent = '先修好上面的问题再复制。';
        return;
      }
      const copy = cloneAsUserLevel(parsed.level);
      const saved = saveUserLevel(copy);
      if (!saved.ok) {
        renderIssues(saved.errors, []);
        return;
      }
      // 换成副本继续编辑：从"只读的内置关"变成"我自己的关"
      readOnly = false;
      key = saved.level.id;
      text = exportLevelText(saved.level);
      savedText = text;
      ta.value = text;
      clearDraft(editing?.id ?? 'new');
      saveDraft(key, text);
      refresh();
      footEl.textContent = saved.persisted
        ? '已复制成你自己的关卡，接着改就行。'
        : '已经复制了，但这台设备存不住（隐私模式），关掉浏览器就没了。';
      return;
    }

    if (act === 'save') {
      const parsed = parseLevelText(ta.value);
      if (!parsed.ok) {
        renderIssues(parsed.errors, []);
        footEl.textContent = '还有问题没改完，先看右边那栏。';
        return;
      }
      const issues = lintLevel(parsed.level);
      const blocking = issues.filter((i) => i.severity === 'error');
      if (blocking.length > 0) {
        // 错误**拦**，警告**不拦**：警告是"你可能没想到"，不是"你不能这么做"
        renderIssues([], issues);
        footEl.textContent = `还有 ${blocking.length} 处会出问题的地方，改完再存。`;
        return;
      }
      const saved = saveUserLevel(parsed.level);
      if (!saved.ok) {
        renderIssues(saved.errors, []);
        footEl.textContent = '存不进去：上面这些字段有问题。';
        return;
      }
      clearDraft(key);
      // 存的是"这份数据"，不是"用户敲的那串字"：重新序列化一次，让下次打开看到规范格式
      text = exportLevelText(saved.level);
      savedText = text;
      ta.value = text;
      key = saved.level.id;
      refresh();
      footEl.textContent = saved.persisted
        ? `已保存「${saved.level.name}」。回选关页就能看见它。`
        : `已放进这一会儿的列表里，但这台设备存不住（隐私模式），关掉浏览器就没了。`;
      // 存完**不关窗**：作者多半还要接着改（加一波援军、调一句播报）。
      // 面板等关闭时再刷新，免得它在这中间反复重排。
      lastSaved = saved.level;
      return;
    }
  });

  refresh();
  document.body.appendChild(mask);
  ta.focus();
}
