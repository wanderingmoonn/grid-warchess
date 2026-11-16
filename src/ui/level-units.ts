/**
 * 关卡独有兵种（`units`）面板。
 *
 * 这一关的"守将""游骑"这类单位放在 `level.units` 里：它们不进全局表，
 * 别的对局看不到、规则书里没有、AI 也不会采购。做斩首关的目标时必须用它
 * （普通兵种对面会一直补）。
 *
 * 复用的是兵种编辑器那套思路：**内置只读，想改就复制一份**。
 * 区别是这里存在的不是 localStorage，而是这一关的 JSON。
 */

import { ERAS, isPseudoUnit } from '../core/config.ts';
import { expansionById, unitSourceIdOf } from '../core/expansions.ts';
import { unitStatLine } from '../core/info.ts';
import { allAvailableUnits } from './unit-editor.ts';
import type { LevelDef } from '../core/level.ts';
import type { UnitCategory, UnitTypeDef } from '../core/types.ts';
import { toast } from './toast.ts';

const CATEGORIES: Array<{ id: UnitCategory; name: string }> = [
  { id: 'combat', name: '战斗单位' },
  { id: 'economy', name: '经济单位' },
  { id: 'builder', name: '建造单位' },
  { id: 'building', name: '建筑' },
];

const NUM_FIELDS = ['cost', 'maxHp', 'atk', 'armor', 'move', 'range', 'vision'] as const;
const NUM_NAME: Record<(typeof NUM_FIELDS)[number], string> = {
  cost: '造价',
  maxHp: '血量',
  atk: '攻击',
  armor: '护甲',
  move: '移动',
  range: '射程',
  vision: '视野',
};

export interface LevelUnitsOptions {
  level: LevelDef;
  onApply: (level: LevelDef) => void;
  onClose?: () => void;
}

const esc = (t: string) =>
  t.replace(/[&<>"]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : ''));

export function openLevelUnits(opts: LevelUnitsOptions): void {
  const level = opts.level;
  /** 这一关自己的兵种表（一份可变的工作副本） */
  let units: Record<string, UnitTypeDef> = structuredClone(level.units ?? {});
  /** 编辑中的那一份；null = 在列表页 */
  let draft: UnitTypeDef | null = null;
  /** 正在编辑原来的 id（改 id 时要先删旧的） */
  let editingId: string | null = null;
  /** 这一关禁用的兵种 id（可变工作副本） */
  const ban = new Set<string>(level.banUnits ?? []);
  /** 禁用区的搜索词：空着时只列"已经禁掉的"，输入后才从全表里找 */
  let banQuery = '';

  const catalog = allAvailableUnits();
  const builtinIds = new Set(Object.keys(catalog));

  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  mask.innerHTML = `<div class="modal wide"></div>`;
  const shell = mask.querySelector<HTMLDivElement>('.modal')!;
  const q = <T extends Element>(sel: string): T => mask.querySelector(sel) as T;

  const nextId = (): string => {
    const used = new Set([...Object.keys(units), ...builtinIds]);
    for (let i = 1; i < 999; i += 1) {
      const id = `lv${i}`;
      if (!used.has(id)) return id;
    }
    return `lv${Date.now().toString(36)}`;
  };

  const blank = (): UnitTypeDef => ({
    id: nextId(),
    name: '新兵种',
    short: '新',
    era: level.setup?.startEra ?? 1,
    category: 'combat',
    cost: 50,
    move: 2,
    atk: 10,
    armor: 2,
    maxHp: 30,
    range: 1,
    vision: 3,
    summonedOnly: true,
  });

  /** 一个兵种的"出处"小字：包名 · 第 N 代（关卡独有兵种就没有包名） */
  const originOf = (d: UnitTypeDef): string => {
    const pack = unitSourceIdOf(d.id);
    const name = pack ? expansionById(pack)?.name ?? pack : '关卡自带';
    return `${name} · 第 ${d.era} 代`;
  };

  /**
   * 禁用区的那份列表。
   *
   * 空搜索时**只列已经禁掉的**——全表七十多个兵种铺在这儿，光是滚到"关卡独有
   * 兵种"那一块都要翻三屏。输入关键词之后才开始从全表里找，这是"想禁谁就搜谁"。
   */
  const banListHtml = (): string => {
    const q = banQuery.trim();
    const rows: UnitTypeDef[] = [];
    if (q) {
      for (const d of Object.values(catalog)) {
        if (isPseudoUnit(d.id)) continue;
        if (!d.name.includes(q) && !d.id.toLowerCase().includes(q.toLowerCase())) continue;
        rows.push(d);
        if (rows.length >= 30) break;
      }
    } else {
      for (const id of ban) {
        const d = catalog[id];
        // 已经在全表里找不到的（未开对应扩展、或者关卡兵种改了 id）也要列出来，
        // 否则作者会看到"禁了 5 个、列表里只有 3 个"，不知道剩下两个是什么
        rows.push(
          d ?? {
            id,
            name: `${id}（本局没有这个兵种）`,
            short: '?',
            era: 0,
            category: 'combat',
            cost: 0,
            move: 0,
            atk: 0,
            armor: 0,
            maxHp: 0,
            range: 0,
            vision: 0,
          },
        );
      }
    }
    if (rows.length === 0) {
      return q
        ? `<div class="editor-empty">没有名字里带「${esc(q)}」的兵种。</div>`
        : '<div class="editor-empty">还没有禁用任何兵种。搜一个名字，或者点「禁用本关刷出来的兵」。</div>';
    }
    return rows
      .map(
        (d) => `<label class="editor-check level-ban-item">
          <input type="checkbox" data-ban="${esc(d.id)}" ${ban.has(d.id) ? 'checked' : ''}>
          <b>${esc(d.name)}</b><small>${esc(originOf(d))}</small>
        </label>`,
      )
      .join('');
  };

  /** 只刷禁用区，不动整块面板——否则搜索框每敲一个字都会失焦 */
  const paintBanList = (): void => {
    const box = mask.querySelector('[data-ban-list]');
    if (box) box.innerHTML = banListHtml();
  };

  const listView = (): string => {
    const rows = Object.values(units);
    return `
      <div class="modal-head">
        <h2>关卡独有兵种</h2>
        <p>这些兵只属于这一关，别的对局看不到。「斩首」目标要用它们。</p>
      </div>
      <div class="modal-body">
        <div class="editor-toolbar">
          <button class="btn btn-primary btn-sm" data-act="new">新建兵种</button>
          <select class="level-mini-select" data-copy-src>
            <option value="">复制一个现有兵种…</option>
            ${Object.values(catalog)
              .filter((d) => !isPseudoUnit(d.id))
              .map((d) => `<option value="${esc(d.id)}">${esc(d.name)}（第 ${d.era} 时代）</option>`)
              .join('')}
          </select>
          <button class="btn btn-sm" data-act="copy">复制</button>
        </div>
        <div class="level-unit-list">
          ${
            rows.length === 0
              ? '<div class="editor-empty">还没有关卡独有兵种。想做一个「守将」，点「新建」或者从现有兵种复制一个再改。</div>'
              : rows
                  .map(
                    (u) => `<div class="editor-row level-unit-row">
                      <span class="level-swatch lv-unit-swatch">${esc(u.short)}</span>
                      <span class="editor-name">${esc(u.name)}<small>${esc(unitStatLine(u))}${
                        u.summonedOnly ? ' · 只能由部署/事件出现' : ''
                      }</small></span>
                      <span class="editor-actions">
                        <button class="btn btn-sm" data-edit="${esc(u.id)}">编辑</button>
                        <button class="btn btn-sm" data-del="${esc(u.id)}">删除</button>
                      </span>
                    </div>`,
                  )
                  .join('')
          }
        </div>
        <div class="field-hint">id 撞内置兵种时建议换个名字。</div>

        <div class="level-ban">
          <div class="field-label">禁用兵种</div>
          <div class="field-hint">
            这一关两边都不能造它们——**事件刷兵不受影响**。用来挡"玩家拿敌人的招牌兵反打敌人"，
            比如邪龙关里那条邪龙王。
          </div>
          <div class="level-rules-filter">
            <input class="level-say-input" data-ban-query placeholder="搜兵种名（空着只显示已禁用的）" value="${esc(banQuery)}">
            <button class="btn btn-sm" data-act="ban-spawned">禁用本关刷出来的兵</button>
            <button class="btn btn-sm" data-act="ban-clear">全部恢复</button>
          </div>
          <div class="level-ban-list" data-ban-list>${banListHtml()}</div>
        </div>
      </div>
      <div class="modal-foot">
        <button class="btn btn-primary" data-act="apply">保存</button>
        <button class="btn" data-act="cancel">取消</button>
      </div>`;
  };

  const editView = (): string => {
    const d = draft!;
    return `
      <div class="modal-head">
        <h2>${editingId ? '编辑兵种' : '新建兵种'}</h2>
        <p>存下来后，「摆兵」和「事件」里都能选到它。</p>
      </div>
      <div class="modal-body">
        <div class="editor-grid">
          <label class="editor-field"><span>名字</span><input data-f="name" value="${esc(d.name)}"></label>
          <label class="editor-field"><span>棋盘上的单字</span><input data-f="short" maxlength="2" value="${esc(d.short)}"></label>
          <label class="editor-field"><span>id（事件和部署里用它）</span><input data-f="id" value="${esc(d.id)}"></label>
          <label class="editor-field"><span>时代</span><select data-f="era">${ERAS.map(
            (e) => `<option value="${e.level}" ${d.era === e.level ? 'selected' : ''}>${esc(e.name)}</option>`,
          ).join('')}</select></label>
          <label class="editor-field"><span>类别</span><select data-f="category">${CATEGORIES.map(
            (c) => `<option value="${c.id}" ${d.category === c.id ? 'selected' : ''}>${esc(c.name)}</option>`,
          ).join('')}</select></label>
        </div>
        <div class="editor-grid level-unit-nums">
          ${NUM_FIELDS.map(
            (f) =>
              `<label class="editor-field"><span>${NUM_NAME[f]}</span><input type="number" min="0" data-num="${f}" value="${d[f]}"></label>`,
          ).join('')}
        </div>
        <label class="editor-check">
          <input type="checkbox" data-f="summonedOnly" ${d.summonedOnly ? 'checked' : ''}>
          只能由部署/事件出现
        </label>
        <div class="field-hint">做「斩首」目标时必须勾上，否则对面会一直补。</div>
        <div class="level-issues" data-issues></div>
      </div>
      <div class="modal-foot">
        <button class="btn btn-primary btn-sm" data-act="save-unit">存下这个兵种</button>
        <button class="btn" data-act="back">返回列表</button>
      </div>`;
  };

  const render = (): void => {
    shell.innerHTML = draft ? editView() : listView();
  };

  const readForm = (): boolean => {
    if (!draft) return false;
    // 抓一份局部引用：draft 在别处（点击回调里）会被重新赋值，
    // 类型收窄在这个作用域里保不住
    const d = draft;
    const nameEl = q<HTMLInputElement>('[data-f="name"]');
    const shortEl = q<HTMLInputElement>('[data-f="short"]');
    const idEl = q<HTMLInputElement>('[data-f="id"]');
    d.name = nameEl.value.trim();
    d.short = shortEl.value.trim() || d.name.slice(0, 1);
    d.id = idEl.value.trim();
    const eraSel = q<HTMLSelectElement>('[data-f="era"]');
    const catSel = q<HTMLSelectElement>('[data-f="category"]');
    d.era = Number(eraSel.value);
    d.category = catSel.value as UnitCategory;
    for (const f of NUM_FIELDS) {
      const el = q<HTMLInputElement>(`[data-num="${f}"]`);
      d[f] = Math.max(0, Math.round(Number(el.value) || 0));
    }
    const only = q<HTMLInputElement>('[data-f="summonedOnly"]');
    if (only.checked) d.summonedOnly = true;
    else delete d.summonedOnly;

    const issues: string[] = [];
    if (!d.id) issues.push('id 不能为空（部署和事件靠它认这个兵）');
    if (!d.name) issues.push('名字不能为空');
    if (d.id && Object.keys(units).some((k) => k === d.id && k !== editingId)) {
      issues.push(`id「${d.id}」这一关已经有一个兵种用了`);
    }
    const box = mask.querySelector('.level-issues');
    if (box) {
      box.innerHTML = issues
        .map((t) => `<div class="level-issue is-error"><b>存不了</b>${esc(t)}</div>`)
        .join('');
    }
    return issues.length === 0;
  };

  /*
   * 禁用区是**单独一块**，不跟上面的"关卡独有兵种"共用 render()。
   * 它自己的勾选和搜索只刷新那一块——整块重绘会让搜索框每敲一个字就失焦。
   */
  mask.addEventListener('change', (ev) => {
    const el = ev.target as HTMLInputElement;
    const id = el.getAttribute('data-ban');
    if (!id) return;
    if (el.checked) ban.add(id);
    else ban.delete(id);
    paintBanList();
  });

  mask.addEventListener('input', (ev) => {
    const el = ev.target as HTMLInputElement;
    if (!el.hasAttribute('data-ban-query')) return;
    banQuery = el.value;
    paintBanList();
  });

  /** 关卡事件里刷过的兵种（敌人靠事件进场，这几样最该禁） */
  const spawnedTypes = (): string[] => {
    const out: string[] = [];
    for (const e of level.events ?? []) {
      for (const act of e.do) {
        if (act.kind !== 'spawn') continue;
        for (const u of act.units) if (!out.includes(u.type)) out.push(u.type);
      }
    }
    return out;
  };

  mask.addEventListener('click', (ev) => {
    const t = ev.target as HTMLElement;

    const editBtn = t.closest<HTMLElement>('[data-edit]');
    if (editBtn) {
      const id = editBtn.dataset.edit ?? '';
      const src = units[id];
      if (src) {
        draft = structuredClone(src);
        editingId = id;
        render();
      }
      return;
    }
    const delBtn = t.closest<HTMLElement>('[data-del]');
    if (delBtn) {
      const id = delBtn.dataset.del ?? '';
      if (window.confirm(`删掉「${units[id]?.name ?? id}」？已经用它摆的兵、写过的事件会引用不到这个兵种。`)) {
        delete units[id];
        render();
      }
      return;
    }

    const act = t.closest<HTMLElement>('[data-act]')?.dataset.act;
    if (act === 'new') {
      draft = blank();
      editingId = null;
      render();
      return;
    }
    if (act === 'copy') {
      const srcSel = q<HTMLSelectElement>('[data-copy-src]');
      const src = catalog[srcSel.value];
      if (!src) {
        toast('先在上面选一个要复制的兵种');
        return;
      }
      const copy = structuredClone(src);
      copy.id = nextId();
      copy.name = `${src.name}（本关）`.slice(0, 12);
      // 复制出来默认"只能由部署/事件出现"：关卡兵种多半就是这个用途，
      // 想让它进产线自己把这个勾去掉（那是作者的决定）
      copy.summonedOnly = true;
      draft = copy;
      editingId = null;
      render();
      return;
    }
    if (act === 'ban-spawned') {
      const list = spawnedTypes();
      if (list.length === 0) {
        toast('这一关没有用事件刷过兵，没东西可禁');
        return;
      }
      for (const id of list) ban.add(id);
      banQuery = '';
      mask.querySelectorAll<HTMLInputElement>('[data-ban-query]').forEach((el) => {
        el.value = '';
      });
      paintBanList();
      toast(`禁了 ${list.length} 个刷出来的兵种`);
      return;
    }
    if (act === 'ban-clear') {
      ban.clear();
      banQuery = '';
      mask.querySelectorAll<HTMLInputElement>('[data-ban-query]').forEach((el) => {
        el.value = '';
      });
      paintBanList();
      return;
    }
    if (act === 'back') {
      draft = null;
      editingId = null;
      render();
      return;
    }
    if (act === 'save-unit') {
      if (!draft) return;
      if (!readForm()) return;
      // 改了 id 的话，旧的键要删掉，否则会留下一个"查不到但还在数据里"的兵种
      if (editingId && editingId !== draft.id) delete units[editingId];
      units[draft.id] = draft;
      draft = null;
      editingId = null;
      render();
      return;
    }
    if (act === 'cancel') {
      mask.remove();
      opts.onClose?.();
      return;
    }
    if (act === 'apply') {
      const next: LevelDef = { ...level };
      if (Object.keys(units).length > 0) next.units = structuredClone(units);
      else delete (next as { units?: unknown }).units;
      if (ban.size > 0) next.banUnits = [...ban];
      else delete (next as { banUnits?: unknown }).banUnits;
      opts.onApply(next);
      mask.remove();
      toast('兵种表已更新，别忘了点「保存到我的关卡」');
    }
  });

  render();
  document.body.appendChild(mask);
}
