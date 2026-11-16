/**
 * 关卡管理：列表 / 改名 / 复制 / 删除 / 导出导入 / 云端分享。
 *
 * 这里不做"编辑器"，只做"整理"：
 *   · 关卡多了会乱（分不清哪张是哪张）→ 列表 + 元信息 + 改名；
 *   · 会丢（清了缓存就没了）→ 导出成文件；
 *   · 想给别人 → 文件互传（先） / 云端（后，要审核）。
 *
 * 一条纪律：**改名不改 id**。存档、事件引用、云端回读都靠 id 对账，
 * id 一变就等于"另一张关"。所以这里的"复制"是新建一张，"改名"只换 name。
 */

import { cloneAsUserLevel, deleteUserLevel, isUserLevelId, newLevelId, saveUserLevel, userLevelList } from '../core/userLevels.ts';
import {
  downloadLevelFile,
  downloadLevelsFile,
  looksLikeJsonFile,
  parseLevelFileText,
  readLevelFile,
} from '../core/level-io.ts';
import { listSharedLevels, uploadSharedLevel } from '../net/levels.ts';
import type { LevelDef } from '../core/level.ts';
import { openLevelEditor } from './level-editor.ts';

const AUTHOR_KEY = 'warchess.level.author';

export interface LevelManagerOptions {
  onClose?: (changed: boolean) => void;
}

const esc = (t: string) =>
  t.replace(/[&<>"]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : ''));

function ago(ts: number): string {
  if (!ts) return '时间不明';
  const d = Date.now() - ts;
  if (d < 60_000) return '刚刚改过';
  if (d < 3_600_000) return `${Math.floor(d / 60_000)} 分钟前`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)} 小时前`;
  return `${Math.floor(d / 86_400_000)} 天前`;
}

export function openLevelManager(opts: LevelManagerOptions = {}): void {
  let changed = false;
  /** 正在改名的关卡 id */
  let renaming: string | null = null;
  let message = '';

  /** 云端列表：没点过就是 null（不主动发请求，省得每次开面板都等网络） */
  let cloud: { loading: boolean; levels: LevelDef[]; reason?: string } | null = null;

  let author = '';
  try {
    author = localStorage.getItem(AUTHOR_KEY) ?? '';
  } catch {
    author = '';
  }

  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  mask.innerHTML = `<div class="modal wide"></div>`;
  const shell = mask.querySelector<HTMLDivElement>('.modal')!;
  const q = <T extends Element>(sel: string): T => mask.querySelector(sel) as T;

  const saveAuthor = (): void => {
    try {
      const el = q<HTMLInputElement>('[data-author]');
      localStorage.setItem(AUTHOR_KEY, el.value.slice(0, 24));
      author = el.value.slice(0, 24);
    } catch {
      // 存不住就算了，这一次仍然有效
    }
  };

  const render = (): void => {
    const list = userLevelList();
    shell.innerHTML = `
      <div class="modal-head">
        <h2>我的关卡</h2>
        <p>
          改名只换名字，<b>不改 id</b>——存档和事件引用都靠 id 认人。
          「复制」是新做一张，改坏了也不影响原件。清缓存会丢，重要的请「导出」成文件。
        </p>
      </div>
      <div class="modal-body">
        <div class="editor-toolbar">
          <button class="btn btn-primary btn-sm" data-act="new">新建关卡</button>
          <button class="btn btn-sm" data-act="import">从文件导入…</button>
          <button class="btn btn-sm" data-act="export-all" ${list.length === 0 ? 'disabled' : ''}>全部导出</button>
          <input type="file" accept=".json,application/json" multiple hidden data-file>
          <span class="field-hint" data-msg>${esc(message)}</span>
        </div>
        <div class="level-mgr-list">
          ${
            list.length === 0
              ? '<div class="editor-empty">还没有自己的关卡。点「新建关卡」开始，或者从文件导入。</div>'
              : list
                  .map(({ level, updatedAt }) => {
                    const n = level.seats?.count ?? 2;
                    const ev = level.events?.length ?? 0;
                    if (renaming === level.id) {
                      return `<div class="level-mgr-row is-editing">
                          <input class="level-say-input" data-rename-input value="${esc(level.name)}" maxlength="24">
                          <span class="level-mgr-actions">
                            <button class="btn btn-sm btn-primary" data-rename-save="${esc(level.id)}">存</button>
                            <button class="btn btn-sm" data-rename-cancel="1">取消</button>
                          </span>
                        </div>`;
                    }
                    return `<div class="level-mgr-row">
                        <span class="level-mgr-name">${esc(level.name)}
                          <i>${level.map.w}×${level.map.h} · ${n} 家 · ${ev} 处事件 · ${ago(updatedAt)}</i>
                        </span>
                        <span class="level-mgr-actions">
                          <button class="btn btn-sm" data-edit="${esc(level.id)}">编辑</button>
                          <button class="btn btn-sm" data-rename="${esc(level.id)}">改名</button>
                          <button class="btn btn-sm" data-copy="${esc(level.id)}">复制</button>
                          <button class="btn btn-sm" data-export="${esc(level.id)}">导出</button>
                          <button class="btn btn-sm" data-upload="${esc(level.id)}">上传</button>
                          <button class="btn btn-sm" data-del="${esc(level.id)}">删除</button>
                        </span>
                      </div>`;
                  })
                  .join('')
          }
        </div>

        <div class="level-mgr-cloud">
          <div class="editor-toolbar">
            <span class="field-hint">别人的关卡（云端，需要审核放行后才会出现）</span>
            <input class="level-mini-select" data-author placeholder="署名" maxlength="24" value="${esc(author)}">
            <button class="btn btn-sm" data-act="cloud-load">${cloud ? '刷新' : '看看别人的'}</button>
          </div>
          <div data-cloud>
            ${
              cloud === null
                ? ''
                : cloud.loading
                  ? '<div class="editor-empty">正在拉取…</div>'
                  : cloud.levels.length === 0
                    ? `<div class="editor-empty">${esc(cloud.reason ?? '还没有人分享关卡。')}</div>`
                    : cloud.levels
                        .map(
                          (lv) => `<div class="level-mgr-row">
                            <span class="level-mgr-name">${esc(lv.name)}
                              <i>${lv.map.w}×${lv.map.h} · ${lv.seats?.count ?? 2} 家 · ${(lv.events ?? []).length} 处事件</i>
                            </span>
                            <span class="level-mgr-actions">
                              <button class="btn btn-sm" data-download="${esc(lv.id)}">下载到我的关卡</button>
                            </span>
                          </div>`,
                        )
                        .join('')
            }
          </div>
        </div>
        <div class="field-hint" data-foot>云端那一步是可选的：没开通也不影响本机的关卡和文件进出。</div>
      </div>
      <div class="modal-foot">
        <button class="btn" data-act="close">关闭</button>
      </div>`;
  };

  const setMsg = (text: string): void => {
    message = text;
    const el = mask.querySelector<HTMLElement>('[data-msg]');
    if (el) el.textContent = text;
  };

  const find = (id: string): LevelDef | null => userLevelList().find((it) => it.level.id === id)?.level ?? null;

  /** 导入一份关卡：**总是换新 id**，免得把本机同名的那张顶掉 */
  const adopt = (level: LevelDef): LevelDef => {
    const base = structuredClone(level);
    const id = newLevelId();
    const copy: LevelDef = {
      ...base,
      id,
      map: { ...base.map, id: `levelmap:${id}`, name: base.name },
    };
    const saved = saveUserLevel(copy);
    if (!saved.ok) throw new Error(saved.errors.join('；'));
    return saved.level;
  };

  mask.addEventListener('click', (ev) => {
    const t = ev.target as HTMLElement;

    const editBtn = t.closest<HTMLElement>('[data-edit]');
    if (editBtn) {
      const level = find(editBtn.dataset.edit ?? '');
      if (!level) return;
      openLevelEditor({
        level,
        onClose: (r) => {
          if (r.saved) changed = true;
          render();
        },
      });
      return;
    }

    const renameBtn = t.closest<HTMLElement>('[data-rename]');
    if (renameBtn) {
      renaming = renameBtn.dataset.rename ?? null;
      render();
      mask.querySelector<HTMLInputElement>('[data-rename-input]')?.focus();
      return;
    }
    const renameSave = t.closest<HTMLElement>('[data-rename-save]');
    if (renameSave) {
      const id = renameSave.dataset.renameSave ?? '';
      const level = find(id);
      const input = mask.querySelector<HTMLInputElement>('[data-rename-input]');
      const name = (input?.value ?? '').trim().slice(0, 24);
      if (level && name) {
        const saved = saveUserLevel({ ...level, name, map: { ...level.map, name } });
        if (saved.ok) {
          changed = true;
          setMsg(`已改名：「${name}」`);
        } else setMsg(saved.errors.join('；'));
      }
      renaming = null;
      render();
      return;
    }
    if (t.closest('[data-rename-cancel]')) {
      renaming = null;
      render();
      return;
    }

    const copyBtn = t.closest<HTMLElement>('[data-copy]');
    if (copyBtn) {
      const level = find(copyBtn.dataset.copy ?? '');
      if (!level) return;
      const saved = saveUserLevel(cloneAsUserLevel(level));
      if (saved.ok) {
        changed = true;
        setMsg(`复制成「${saved.level.name}」`);
        render();
      } else setMsg(saved.errors.join('；'));
      return;
    }

    const exportBtn = t.closest<HTMLElement>('[data-export]');
    if (exportBtn) {
      const level = find(exportBtn.dataset.export ?? '');
      if (level) {
        downloadLevelFile(level);
        setMsg(`已导出「${level.name}」，在下载目录里找 .json`);
      }
      return;
    }

    const delBtn = t.closest<HTMLElement>('[data-del]');
    if (delBtn) {
      const id = delBtn.dataset.del ?? '';
      const level = find(id);
      if (!level) return;
      if (window.confirm(`删掉「${level.name}」？已经存下来的对局不受影响（那一局跑的是快照），但这张关本身没了。`)) {
        deleteUserLevel(id);
        changed = true;
        setMsg(`删掉了「${level.name}」`);
        render();
      }
      return;
    }

    const uploadBtn = t.closest<HTMLElement>('[data-upload]');
    if (uploadBtn) {
      const level = find(uploadBtn.dataset.upload ?? '');
      if (!level) return;
      saveAuthor();
      setMsg('正在上传…');
      void uploadSharedLevel(level, author).then((r) => {
        if (r.ok) {
          setMsg(
            r.pending
              ? `已提交「${level.name}」，等审核放行后别人才能看到。`
              : `已上传「${level.name}」。`,
          );
        } else {
          setMsg(`${r.reason ?? '上传失败'}${r.howTo ? `（${r.howTo}）` : ''}`);
        }
      });
      return;
    }

    const dlBtn = t.closest<HTMLElement>('[data-download]');
    if (dlBtn) {
      const id = dlBtn.dataset.download ?? '';
      const level = cloud?.levels.find((l) => l.id === id);
      if (!level) return;
      try {
        const saved = adopt(level);
        changed = true;
        setMsg(`已收下「${saved.name}」，在「我的关卡」里`);
        render();
      } catch (err) {
        setMsg(err instanceof Error ? err.message : String(err));
      }
      return;
    }

    const act = t.closest<HTMLElement>('[data-act]')?.dataset.act;
    if (act === 'new') {
      openLevelEditor({
        onClose: (r) => {
          if (r.saved) changed = true;
          render();
        },
      });
      return;
    }
    if (act === 'import') {
      q<HTMLInputElement>('[data-file]').click();
      return;
    }
    if (act === 'export-all') {
      const all = userLevelList().map((it) => it.level);
      if (all.length === 0) return;
      downloadLevelsFile(all);
      setMsg(`已导出 ${all.length} 张关卡，一个文件里`);
      return;
    }
    if (act === 'cloud-load') {
      saveAuthor();
      cloud = { loading: true, levels: [] };
      render();
      void listSharedLevels().then((r) => {
        cloud = { loading: false, levels: r.levels, reason: r.ok ? undefined : r.reason };
        render();
      });
      return;
    }
    if (act === 'close') {
      mask.remove();
      opts.onClose?.(changed);
    }
  });

  mask.addEventListener('change', (ev) => {
    const input = ev.target as HTMLInputElement;
    if (!input.hasAttribute('data-file')) return;
    const files = [...(input.files ?? [])].filter(looksLikeJsonFile);
    if (files.length === 0) {
      setMsg('没选到 .json 文件。');
      return;
    }
    void (async () => {
      const notes: string[] = [];
      for (const file of files) {
        try {
          const text = await readLevelFile(file);
          const parsed = parseLevelFileText(text);
          if (!parsed.ok) {
            notes.push(`${file.name}：${parsed.errors[0]}`);
            continue;
          }
          for (const level of parsed.levels) {
            try {
              adopt(level);
              changed = true;
            } catch (err) {
              notes.push(`${level.name}：${err instanceof Error ? err.message : String(err)}`);
            }
          }
          if (parsed.errors.length > 0) notes.push(`${file.name} 里有 ${parsed.errors.length} 条读不了`);
        } catch (err) {
          notes.push(`${file.name}：${err instanceof Error ? err.message : String(err)}`);
        }
      }
      setMsg(notes.filter(Boolean).join('；') || '导入了。');
      render();
    })();
  });

  mask.addEventListener('keydown', (ev) => {
    const el = ev.target as HTMLElement;
    if (el.hasAttribute('data-rename-input') && ev.key === 'Enter') {
      const id = renaming;
      const input = el as HTMLInputElement;
      const level = id ? find(id) : null;
      const name = input.value.trim().slice(0, 24);
      if (level && name) {
        const saved = saveUserLevel({ ...level, name, map: { ...level.map, name } });
        if (saved.ok) {
          changed = true;
          setMsg(`已改名：「${name}」`);
        } else setMsg(saved.errors.join('；'));
      }
      renaming = null;
      render();
    }
  });

  render();
  document.body.appendChild(mask);
}

/** 给外部的提示：这份是不是"我的关卡"（云端来的 id 不是） */
export function isLocalLevelId(id: string | null | undefined): boolean {
  return isUserLevelId(id);
}
