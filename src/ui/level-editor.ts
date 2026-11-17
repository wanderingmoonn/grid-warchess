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
import { toast } from './toast.ts';
import { openLevelCanvas } from './level-canvas.ts';
import { openLevelArmy } from './level-army.ts';
import { openLevelSeats } from './level-seats.ts';
import { openLevelEvents } from './level-events.ts';
import { openLevelGoals } from './level-goals.ts';
import { openLevelUnits } from './level-units.ts';
import { openLevelRules } from './level-rules.ts';
import type { LevelDef } from '../core/level.ts';
import { aiNextAction } from '../core/ai.ts';
import { applyAction } from '../core/rules.ts';
import { DEFAULT_CONFIG, createMatch } from '../core/setup.ts';
import { loadCustomUnits } from '../core/customUnits.ts';

export interface LevelEditorResult {
  saved: boolean;
  /** 存下来的那一份（`saved` 为 true 时有） */
  level?: LevelDef;
}

export interface LevelEditorOptions {
  /** 要编辑的关卡。不传 = 新建 */
  level?: LevelDef;
  onClose?: (result: LevelEditorResult) => void;
  /**
   * 试玩：把这一份关卡交给外面去开局（开局面板会直接关掉、开始对局）。
   * 不传就不显示「试玩」——探针和别处调用不需要它。
   */
  onTryPlay?: (level: LevelDef) => void;
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

  /*
   * 草稿只在**编辑已有的关**时自动恢复。
   *
   * 「新建」不自动恢复：否则第二次点「新建关卡」拿到的是上次那张半成品，
   * 而不是一张干净模板——玩家会以为"新建"坏了（这个坑是测试先撞上的）。
   * 新建时如果确实有草稿，底栏给一行「恢复 / 丢弃」，让人自己选。
   */
  const draft = draftOf(key);
  const restored = key !== 'new' && !!draft && draft.trim().length > 0;
  if (restored) text = draft!;
  const pendingDraft = key === 'new' && !!draft && draft.trim().length > 0 ? draft : null;

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
          地图、兵力、事件、胜负都在这里改。点「保存」后出现在选关页「我的关卡」。
          ${restored ? '<br><b>已恢复上次没写完的草稿。</b>' : ''}
        </p>
      </div>
      <div class="modal-body">
        <div class="editor-toolbar">
          <button class="btn btn-sm" data-act="canvas">画地图</button>
          <button class="btn btn-sm" data-act="army">摆兵</button>
          <button class="btn btn-sm" data-act="seats">席位</button>
          <button class="btn btn-sm" data-act="events">事件</button>
          <button class="btn btn-sm" data-act="goals">胜负</button>
          <button class="btn btn-sm" data-act="units">兵种</button>
          <button class="btn btn-sm" data-act="rules">扩展与 AI</button>
        </div>
        <div class="editor-grid level-editor-head">
          <label class="editor-field"><span>名称</span><input data-name maxlength="24"></label>
          <label class="editor-field"><span>一句话简介</span><input data-brief maxlength="120"></label>
        </div>
        <label class="editor-check level-story-check">
          <input type="checkbox" data-story />
          这一关是剧情关（存下来会出现在「关卡」栏，而不只是「我的关卡」）
        </label>
        <div class="level-editor-grid">
          <textarea class="level-json" spellcheck="false" wrap="off"></textarea>
          <div class="level-side">
            <div class="level-summary"></div>
            <div class="level-issues"></div>
          </div>
        </div>
        <div class="level-tryout" data-tryout hidden></div>
        <div class="level-draft-bar" data-draft-bar hidden>
          <span>这儿有一份上次没写完的草稿。</span>
          <button class="btn btn-sm" data-act="draft-restore">接着改那份</button>
          <button class="btn btn-sm" data-act="draft-discard">丢掉</button>
        </div>
        <div class="field-hint" data-foot></div>
      </div>
      <div class="modal-foot">
        <button class="btn btn-sm" data-act="clone">${readOnly ? '复制成我的关卡' : '另存为副本'}</button>
        <button class="btn btn-sm" data-act="reset">重置</button>
        <button class="btn btn-sm" data-act="tryout">试玩</button>
        <button class="btn btn-sm" data-act="selfplay">跑 3 局</button>
        <button class="btn btn-sm" data-act="copy">复制 JSON</button>
        <span class="modal-foot-gap"></span>
        <button class="btn btn-primary" data-act="save">保存</button>
        <button class="btn" data-act="close">关闭</button>
      </div>
    </div>`;

  const q = <T extends Element>(sel: string): T => mask.querySelector(sel) as T;
  const ta = q<HTMLTextAreaElement>('.level-json');
  const nameEl = q<HTMLInputElement>('[data-name]');
  const briefEl = q<HTMLInputElement>('[data-brief]');
  const storyEl = q<HTMLInputElement>('[data-story]');
  const issuesEl = q<HTMLDivElement>('.level-issues');
  const summaryEl = q<HTMLDivElement>('.level-summary');
  const footEl = q<HTMLDivElement>('[data-foot]');
  const saveBtn = q<HTMLButtonElement>('[data-act="save"]');
  const draftBar = q<HTMLDivElement>('[data-draft-bar]');
  const tryoutEl = q<HTMLDivElement>('[data-tryout]');
  if (pendingDraft) draftBar.hidden = false;

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
    if (document.activeElement !== storyEl) storyEl.checked = level.story === true;
    renderSummary(level);
    renderIssues([], lintLevel(level));
    saveBtn.disabled = readOnly;
    footEl.textContent = readOnly
      ? '这是内置关卡，只读。想改就点「复制成我的关卡」。'
      : '存下来之后它会出现在选关页的「我的关卡」里。';
  };

  /**
   * 直接关掉，不弹确认。
   *
   * 保存成功走这里：**存完就关**是玩家一眼能看懂的"这事儿结束了"。
   * 之前留着不关、只把提示写在窗口底部，结果就是玩家看不见、反复点保存——
   * 每一次都真的存了一遍（版本号一路涨），而他以为界面卡住了。
   */
  const closeNow = (level: LevelDef | null = lastSaved): void => {
    if (timer !== null) clearTimeout(timer);
    mask.remove();
    opts.onClose?.({ saved: !!level, level: level ?? undefined });
  };

  /**
   * 当前文本 → 一份"能拿去开局"的关卡。
   *
   * 保存、试玩、自打三条路都先过它。分开写的话迟早出现"保存拦住了、试玩没拦"，
   * 而那意味着玩家会拿一张坏图去开局。
   */
  const readyToPlay = (): LevelDef | null => {
    const parsed = parseLevelText(ta.value);
    if (!parsed.ok) {
      renderIssues(parsed.errors, []);
      footEl.textContent = '还有问题没改完，先看右边那栏。';
      return null;
    }
    const issues = lintLevel(parsed.level);
    const blocking = issues.filter((i) => i.severity === 'error');
    if (blocking.length > 0) {
      // 错误**拦**，警告**不拦**：警告是"你可能没想到"，不是"你不能这么做"
      renderIssues([], issues);
      footEl.textContent = `还有 ${blocking.length} 处会出问题的地方，改完再试。`;
      return null;
    }
    return parsed.level;
  };

  const commit = (): { level: LevelDef; persisted: boolean } | null => {
    const level = readyToPlay();
    if (!level) return null;
    // 文本没动过就别再存一遍：试玩一下涨一个版本号，作者会看不懂这个数字
    if (key === level.id && ta.value === savedText) return { level, persisted: true };
    const saved = saveUserLevel(level);
    if (!saved.ok) {
      renderIssues(saved.errors, []);
      footEl.textContent = '存不进去：上面这些字段有问题。';
      return null;
    }
    clearDraft(key);
    lastSaved = saved.level;
    key = saved.level.id;
    savedText = ta.value;
    return { level: saved.level, persisted: saved.persisted };
  };

  /** 试玩前要准备的那一份：自己的关卡顺便存一下，内置关卡直接用（只读不存） */
  const prepareForPlay = (): LevelDef | null => (readOnly ? readyToPlay() : (commit()?.level ?? null));

  /**
   * 自打几局：同一套 AI 对打，回答"这关能不能跑完、大概多长"。
   *
   * **它不能回答"好不好玩"**：电脑不会集结兵力撕口子、不会保护关键单位、
   * 地形一变也不会重新选路。所以结果旁边必须写清这一点，否则下次一定有人
   * 拿"AI 打了 3 局都赢"当成难度结论。
   *
   * 分帧跑：一局上千步，同步跑会把界面冻住（玩家会以为崩了）。
   */
  const runSelfPlay = async (level: LevelDef): Promise<void> => {
    tryoutEl.hidden = false;
    const seeds = [11, 22, 33];
    const MAX_TURN = 1200;
    const lines: string[] = [];

    const paint = (cur?: string): void => {
      tryoutEl.innerHTML = `${lines
        .map((t) => `<div class="level-tryout-line">${esc(t)}</div>`)
        .join('')}${cur ? `<div class="level-tryout-line is-running">${esc(cur)}</div>` : ''}`;
    };

    for (const seed of seeds) {
      let s = createMatch({ ...DEFAULT_CONFIG, level }, seed, loadCustomUnits());
      let guard = 0;
      try {
        while (!s.winner && s.turn < MAX_TURN && guard < MAX_TURN * 2) {
          const r = applyAction(s, aiNextAction(s) ?? { type: 'END_TURN' });
          if (r.ok) s = r.state;
          else {
            const fallback = applyAction(s, { type: 'END_TURN' });
            if (!fallback.ok) break;
            s = fallback.state;
          }
          guard += 1;
          // 每 40 步让一次主线程：既能让进度条动，也不至于慢到看不出来
          if (guard % 40 === 0) {
            paint(`种子 ${seed}：已走到第 ${s.turn} 次行动…`);
            await new Promise((r2) => window.setTimeout(r2, 0));
          }
        }
      } catch (err) {
        lines.push(`种子 ${seed}：跑崩了（${err instanceof Error ? err.message : String(err)}）`);
        paint();
        continue;
      }
      if (s.winner) {
        const who = s.players[s.winner]?.name ?? s.winner;
        lines.push(`种子 ${seed}：${who}赢，第 ${s.turn} 次行动结束`);
      } else {
        lines.push(`种子 ${seed}：跑到 ${MAX_TURN} 次行动还没分出胜负（可能卡住了）`);
      }
      paint();
      await new Promise((r2) => window.setTimeout(r2, 0));
    }
    lines.push('这只是"能不能跑完"，不是"好不好玩"——电脑不会集结、不会护人，也看不懂地形。');
    paint();
    footEl.textContent = '自打完了。要判断难不难，还得自己打一局。';
  };

  /**
   * 把名称/简介写回 JSON。
   *
   * 在 **change（失焦）** 时写，不是每敲一个字就写：一是免得和用户正在编辑的
   * 文本互相打断，二是 JSON 重新序列化会把光标位置和注释性的格式全部冲掉。
   */
  const writeBack = (field: 'name' | 'brief' | 'story', value: string | boolean): void => {
    const parsed = parseLevelText(text);
    if (!parsed.ok) return; // JSON 还是坏的，先别动它
    const next: LevelDef = { ...parsed.level };
    if (field === 'story') {
      // 只有"是"才写字段：写 `story: false` 会让 JSON 里多一句要解释的废话
      if (value === true) next.story = true;
      else delete (next as { story?: boolean }).story;
    } else {
      next[field] = String(value).trim();
      if (field === 'brief' && !String(value).trim()) delete (next as { brief?: string }).brief;
    }
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
    if (el === storyEl) writeBack('story', storyEl.checked);
  });

  mask.addEventListener('click', (ev) => {
    const btn = (ev.target as HTMLElement).closest<HTMLElement>('[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;

    if (act === 'close') {
      // 没存就关：一定要问一句。草稿还在，但要让人知道"下次会接着上次"
      if (ta.value !== savedText && ta.value.trim() !== '') {
        if (!window.confirm('还没保存。放掉的内容会留在草稿里，下次打开这张关会自动接着改。关闭吗？')) return;
        saveDraft(key, ta.value);
      }
      closeNow();
      return;
    }

    if (act === 'draft-restore') {
      if (pendingDraft) {
        ta.value = pendingDraft;
        draftBar.hidden = true;
        refresh();
        footEl.textContent = '已经把草稿载进来了。';
      }
      return;
    }

    if (act === 'draft-discard') {
      clearDraft(key);
      draftBar.hidden = true;
      footEl.textContent = '草稿丢掉了，现在是一张干净的模板。';
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

    /*
     * 画布和摆兵面板都只产出"一份新的关卡数据"，写回文本这条路由编辑器统一管。
     * 代码改 textarea.value 不会触发 input 事件，所以草稿要手动补一次——
     * 少了这一句，画完地图直接关窗，改动就没了（草稿里还是上一次的文本）。
     */
    const applyFromPanel = (next: LevelDef, what: string): void => {
      ta.value = exportLevelText(next);
      refresh();
      saveDraft(key, ta.value);
      footEl.textContent = `${what}换了。点「保存到我的关卡」才会真的存下来。`;
    };

    /** 画布 / 摆兵共用的一段前置：只读拦截 + JSON 先得能解析 */
    const openPanel = (open: (level: LevelDef) => void, verb: string): void => {
      if (readOnly) {
        // 内置关卡不给改：改完也存不下来（保存是禁用的），只会白忙一场。
        // 说清"先复制"比灰掉按钮好——灰掉的话玩家会以为是坏了。
        footEl.textContent = `内置关卡只读。先点「复制成我的关卡」，再${verb}。`;
        return;
      }
      const parsed = parseLevelText(ta.value);
      if (!parsed.ok) {
        renderIssues(parsed.errors, []);
        footEl.textContent = `先把 JSON 修好再${verb}。`;
        return;
      }
      open(parsed.level);
    };

    if (act === 'canvas') {
      openPanel(
        (level) => openLevelCanvas({ level, onApply: (next) => applyFromPanel(next, '地图') }),
        '画地图',
      );
      return;
    }

    if (act === 'rules') {
      openPanel(
        (level) => openLevelRules({ level, onApply: (next) => applyFromPanel(next, '规则') }),
        '改扩展和 AI',
      );
      return;
    }

    if (act === 'goals') {
      openPanel(
        (level) => openLevelGoals({ level, onApply: (next) => applyFromPanel(next, '胜负条件') }),
        '改胜负',
      );
      return;
    }

    if (act === 'units') {
      openPanel(
        (level) => openLevelUnits({ level, onApply: (next) => applyFromPanel(next, '兵种') }),
        '改兵种',
      );
      return;
    }

    if (act === 'events') {
      openPanel(
        (level) => openLevelEvents({ level, onApply: (next) => applyFromPanel(next, '事件') }),
        '编辑事件',
      );
      return;
    }

    if (act === 'seats') {
      openPanel(
        (level) => openLevelSeats({ level, onApply: (next) => applyFromPanel(next, '席位') }),
        '改席位',
      );
      return;
    }

    if (act === 'army') {
      openPanel(
        (level) => openLevelArmy({ level, onApply: (next) => applyFromPanel(next, '兵力') }),
        '摆兵',
      );
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
      toast(`已复制成「${saved.level.name}」，接着改就行`);
      return;
    }

    if (act === 'save') {
      const saved = commit();
      if (!saved) return;
      /*
       * 存完**立刻关窗**，并给一句提示。
       *
       * 反过来的做法（留在原地、只在底部写一行"已保存"）实机被玩家骂了：
       * 那行字在窗口最底部、很容易没看见，玩家的判断是"没反应"，
       * 于是一路点下去——每点一次都真的存一遍，版本号涨到十几。
       * 关窗是最强的反馈，提示只是补一句"存到哪儿了"。
       */
      closeNow(saved.level);
      toast(
        saved.persisted
          ? `已保存「${saved.level.name}」，在选关页的「我的关卡」里`
          : `「${saved.level.name}」只在这次打开期间有效（这台设备存不住）`,
      );
      return;
    }

    if (act === 'tryout') {
      if (!opts.onTryPlay) {
        footEl.textContent = '这个入口没法直接开局（只有从选关页打开时才行）。';
        return;
      }
      try {
        const ready = prepareForPlay();
        if (!ready) return;
        mask.remove();
        opts.onTryPlay(ready);
      } catch (err) {
        // 走到这儿说明"关窗之前就出错了"。窗口这会儿已经没了，只能靠 toast 说话
        toast(`试玩起不来：${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }

    if (act === 'selfplay') {
      const ready = readyToPlay();
      if (!ready) return;
      void runSelfPlay(ready);
      return;
    }
  });

  refresh();
  document.body.appendChild(mask);
  ta.focus();
}
