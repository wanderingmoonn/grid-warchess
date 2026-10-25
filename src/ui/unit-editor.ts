/**
 * 兵种编辑器。
 *
 * 设计原则：内置兵种只读。想改手感就"复制一份"变成自定义的，
 * 这样你永远有一个原版可以对照，也不会把平衡基准搞坏。
 *
 * 现在这个版本做的是"数值编辑"：改属性、改造价、改地形产出、改建造清单。
 * 再加能力（比如"攻击后不被反击"）需要往 UnitTypeDef 里加字段，
 * 那是下一步的事。
 */

import { ABILITIES, ABILITY_GROUP_NAME, type AbilityGroup } from '../core/abilities.ts';
import { ERAS, UNIT_TYPES } from '../core/config.ts';
import {
  blankUnit,
  cloneAsCustom,
  exportCustomUnits,
  importCustomUnits,
  loadCustomUnits,
  nextCustomId,
  removeCustomUnit,
  upsertCustomUnit,
} from '../core/customUnits.ts';
import type { Terrain, UnitCategory, UnitTypeDef } from '../core/types.ts';

const CATEGORIES: Array<{ id: UnitCategory; name: string }> = [
  { id: 'combat', name: '战斗单位' },
  { id: 'economy', name: '经济单位' },
  { id: 'builder', name: '建造单位' },
  { id: 'building', name: '建筑' },
];

const TERRAINS: Array<{ id: Terrain; name: string }> = [
  { id: 'plain', name: '平原' },
  { id: 'forest', name: '森林' },
  { id: 'hill', name: '丘陵' },
  { id: 'city', name: '城市' },
];

const NUM_FIELDS = ['cost', 'atk', 'armor', 'maxHp', 'move', 'range', 'vision'] as const;

export function openUnitEditor(onClose?: () => void): void {
  const mask = document.createElement('div');
  mask.className = 'modal-mask';

  let view: 'list' | 'edit' = 'list';
  let draft: UnitTypeDef | null = null;
  let editingExisting = false;

  const close = () => {
    mask.remove();
    onClose?.();
  };

  const categoryName = (c: UnitCategory) => CATEGORIES.find((x) => x.id === c)?.name ?? c;

  const esc = (t: string) =>
    t.replace(/[&<>"]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;'));

  const rowHtml = (u: UnitTypeDef, editable: boolean) => `
    <div class="editor-row">
      <span class="editor-chip">${esc(u.short)}</span>
      <span class="editor-name">
        ${esc(u.name)}
        <small>${categoryName(u.category)} · ${ERAS[u.era - 1]?.name ?? '?'} · 造价 ${u.cost}</small>
      </span>
      <span class="editor-actions">
        ${
          editable
            ? `<button class="btn btn-sm" data-act="edit" data-id="${u.id}">编辑</button>
               <button class="btn btn-sm" data-act="del" data-id="${u.id}">删除</button>`
            : `<button class="btn btn-sm" data-act="copy" data-id="${u.id}">复制</button>`
        }
      </span>
    </div>`;

  const listView = () => {
    const custom = loadCustomUnits();
    const customUnits = Object.values(custom);

    const builtin = ERAS.map((era) => {
      const units = Object.values(UNIT_TYPES).filter((u) => u.era === era.level);
      if (units.length === 0) return '';
      return `<div class="editor-group">
        <div class="editor-group-title">内置 · ${era.name}</div>
        ${units.map((u) => rowHtml(u, false)).join('')}
      </div>`;
    }).join('');

    const mine =
      customUnits.length === 0
        ? `<div class="editor-empty">还没有自定义兵种。点上面的「新建」或者复制一个内置的来改。</div>`
        : customUnits.map((u) => rowHtml(u, true)).join('');

    return `
      <div class="modal-head">
        <h2>兵种编辑器</h2>
        <p>内置兵种只读（那是平衡基准）。想改就复制一份，改出来的存在本机，可以带进任何一局。</p>
      </div>
      <div class="modal-body">
        <div class="editor-toolbar">
          <button class="btn btn-primary btn-sm" data-act="new">新建兵种</button>
          <button class="btn btn-sm" data-act="export">导出</button>
          <button class="btn btn-sm" data-act="import">导入</button>
        </div>
        <div class="editor-group">
          <div class="editor-group-title">我的自定义（${customUnits.length}）</div>
          ${mine}
        </div>
        ${builtin}
      </div>
      <div class="modal-foot">
        <button class="btn" data-act="close">关闭</button>
      </div>
    `;
  };

  const editView = () => {
    if (!draft) return '';
    const d = draft;
    const usesTerrain = !!d.incomeByTerrain;
    const isBuilder = d.category === 'builder';
    const isBuilding = d.category === 'building';
    const needsIncome = d.category === 'economy' || d.category === 'building';

    const buildings = Object.values(UNIT_TYPES).filter((u) => u.category === 'building');

    const num = (field: (typeof NUM_FIELDS)[number], label: string) => `
      <label class="editor-field">
        <span>${label}</span>
        <input type="number" min="0" data-field="${field}" value="${d[field]}" />
      </label>`;

    const incomeBlock = needsIncome
      ? `<div class="editor-block">
           <label class="editor-check">
             <input type="checkbox" data-toggle="terrain" ${usesTerrain ? 'checked' : ''} />
             按地形产出（不勾就是固定产金）
           </label>
           ${
             usesTerrain
               ? `<div class="editor-grid">${TERRAINS.map(
                   (t) => `<label class="editor-field">
                     <span>${t.name}</span>
                     <input type="number" min="0" data-terrain="${t.id}" value="${d.incomeByTerrain?.[t.id] ?? 0}" />
                   </label>`,
                 ).join('')}</div>`
               : `<label class="editor-field">
                    <span>每回合产金</span>
                    <input type="number" min="0" data-field="income" value="${d.income ?? 0}" />
                  </label>`
           }
         </div>`
      : '';

    const buildBlock = isBuilder
      ? `<div class="editor-block">
           <div class="editor-block-title">能建造什么</div>
           <div class="editor-checks">
             ${buildings
               .map(
                 (b) => `<label class="editor-check">
                   <input type="checkbox" data-build="${b.id}" ${d.builds?.includes(b.id) ? 'checked' : ''} />
                   ${b.name}
                 </label>`,
               )
               .join('')}
           </div>
         </div>`
      : '';

    const abilityBlock = `<div class="editor-block">
           <div class="editor-block-title">特殊能力</div>
           ${(['attack', 'defense', 'move', 'support'] as AbilityGroup[])
             .map((g) => {
               const items = ABILITIES.filter((a) => a.group === g);
               if (items.length === 0) return '';
               return `<div class="editor-ability-group">
                 <span class="editor-ability-tag">${ABILITY_GROUP_NAME[g]}</span>
                 <div class="editor-checks">
                   ${items
                     .map(
                       (a) => `<label class="editor-check" title="${esc(a.summary)}">
                         <input type="checkbox" data-ability="${a.id}" ${d.abilities?.includes(a.id) ? 'checked' : ''} />
                         ${a.name}
                       </label>`,
                     )
                     .join('')}
                 </div>
               </div>`;
             })
             .join('')}
           <div class="editor-hint">勾上的能力在 rules.ts 里对应的位置生效。悬停名字可以看说明。</div>
         </div>`;

    const autoBlock = isBuilding
      ? `<div class="editor-block">
           <label class="editor-check">
             <input type="checkbox" data-toggle="autoAttack" ${d.autoAttack ? 'checked' : ''} />
             每回合自动对射程内敌人开火
           </label>
         </div>`
      : '';

    return `
      <div class="modal-head">
        <h2>${editingExisting ? '编辑兵种' : '新建兵种'}</h2>
        <p>${esc(d.id)}</p>
      </div>
      <div class="modal-body">
        <div class="editor-block">
          <div class="editor-block-title">基本信息</div>
          <div class="editor-grid">
            <label class="editor-field">
              <span>名称</span>
              <input type="text" data-field="name" value="${esc(d.name)}" />
            </label>
            <label class="editor-field">
              <span>图标（一个字）</span>
              <input type="text" maxlength="1" data-field="short" value="${esc(d.short)}" />
            </label>
            <label class="editor-field">
              <span>时代</span>
              <select data-field="era">
                ${ERAS.map(
                  (e) => `<option value="${e.level}" ${d.era === e.level ? 'selected' : ''}>${e.name}</option>`,
                ).join('')}
              </select>
            </label>
            <label class="editor-field">
              <span>类别</span>
              <select data-field="category">
                ${CATEGORIES.map(
                  (c) =>
                    `<option value="${c.id}" ${d.category === c.id ? 'selected' : ''}>${c.name}</option>`,
                ).join('')}
              </select>
            </label>
          </div>
        </div>

        <div class="editor-block">
          <div class="editor-block-title">数值</div>
          <div class="editor-grid">
            ${num('cost', '造价')}
            ${num('atk', '攻击')}
            ${num('armor', '护甲')}
            ${num('maxHp', '生命')}
            ${num('move', '移动力')}
            ${num('range', '射程')}
            ${num('vision', '视野')}
          </div>
          <div class="editor-hint">移动力填 0 就是建筑（不可移动）。射程 1 是近战，2 以上是远程。</div>
        </div>

        ${incomeBlock}
        ${buildBlock}
        ${autoBlock}
        ${abilityBlock}
      </div>
      <div class="modal-foot">
        <button class="btn" data-act="cancel-edit">取消</button>
        <button class="btn btn-primary" data-act="save">保存</button>
      </div>
    `;
  };

  const paint = () => {
    mask.innerHTML = `<div class="modal wide">${view === 'list' ? listView() : editView()}</div>`;
  };

  const startEdit = (unit: UnitTypeDef, existing: boolean) => {
    draft = structuredClone(unit);
    editingExisting = existing;
    view = 'edit';
    paint();
  };

  const saveDraft = () => {
    if (!draft) return;
    if (!draft.name.trim()) {
      window.alert('名字不能为空');
      return;
    }
    if (!draft.short.trim()) draft.short = draft.name.trim().slice(0, 1);
    // 数值兜底，防止负数和 NaN
    for (const f of NUM_FIELDS) {
      const v = Number(draft[f]);
      draft[f] = Number.isFinite(v) && v >= 0 ? Math.round(v) : 0;
    }
    if (draft.incomeByTerrain) {
      const cleaned: Partial<Record<Terrain, number>> = {};
      for (const t of TERRAINS) {
        const v = draft.incomeByTerrain[t.id];
        if (typeof v === 'number' && v > 0) cleaned[t.id] = Math.round(v);
      }
      draft.incomeByTerrain = cleaned;
    }
    const all = loadCustomUnits();
    if (!all[draft.id]) draft.id = nextCustomId(all);
    upsertCustomUnit(draft);
    draft = null;
    view = 'list';
    paint();
  };

  mask.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    if (target === mask) {
      close();
      return;
    }

    const act = target.closest<HTMLElement>('[data-act]')?.dataset.act;
    const id = target.closest<HTMLElement>('[data-id]')?.dataset.id;

    switch (act) {
      case 'close':
        close();
        return;
      case 'new': {
        const all = loadCustomUnits();
        startEdit(blankUnit(all), false);
        return;
      }
      case 'copy': {
        if (!id) return;
        const src = UNIT_TYPES[id];
        if (!src) return;
        const all = loadCustomUnits();
        startEdit(cloneAsCustom(src, all), false);
        return;
      }
      case 'edit': {
        if (!id) return;
        const u = loadCustomUnits()[id];
        if (u) startEdit(u, true);
        return;
      }
      case 'del': {
        if (!id) return;
        if (window.confirm('删掉这个兵种？已经有对局用到它的话，那局会失效。')) {
          removeCustomUnit(id);
          paint();
        }
        return;
      }
      case 'cancel-edit':
        draft = null;
        view = 'list';
        paint();
        return;
      case 'save':
        saveDraft();
        return;
      case 'export': {
        const text = exportCustomUnits();
        void navigator.clipboard
          ?.writeText(text)
          .then(() => window.alert('自定义兵种已复制到剪贴板，可以发给别人。'))
          .catch(() => window.prompt('复制下面的内容：', text));
        return;
      }
      case 'import': {
        const text = window.prompt('粘贴别人发来的兵种数据：');
        if (!text) return;
        const n = importCustomUnits(text);
        window.alert(n > 0 ? `导入了 ${n} 个兵种` : '这段内容无效');
        paint();
        return;
      }
    }
  });

  // 输入：只改 draft，不重绘，保住焦点
  mask.addEventListener('input', (e) => {
    const el = e.target as HTMLInputElement | HTMLSelectElement;
    const field = el.dataset.field;
    if (!draft || !field) return;

    if (field === 'name' || field === 'short') {
      draft[field] = el.value;
      return;
    }
    if (field === 'era' || field === 'category') {
      (draft as unknown as Record<string, string | number>)[field] =
        field === 'era' ? Number(el.value) : el.value;
      // 类别变了要重绘（产出/建造区块会变）
      paint();
      return;
    }
    if (field === 'income') {
      draft.income = Number(el.value) || 0;
      return;
    }
    if ((NUM_FIELDS as readonly string[]).includes(field)) {
      (draft as unknown as Record<string, number>)[field] = Number(el.value) || 0;
    }
  });

  mask.addEventListener('change', (e) => {
    const el = e.target as HTMLInputElement;
    if (!draft) return;

    const terrainKey = el.dataset.terrain as Terrain | undefined;
    if (terrainKey) {
      draft.incomeByTerrain = {
        ...(draft.incomeByTerrain ?? {}),
        [terrainKey]: Number(el.value) || 0,
      };
      return;
    }

    const toggle = el.dataset.toggle;
    if (toggle === 'terrain') {
      if (el.checked) {
        draft.incomeByTerrain = { plain: 5, forest: 3, hill: 4, city: 0 };
        delete draft.income;
      } else {
        delete draft.incomeByTerrain;
        draft.income = 5;
      }
      paint();
      return;
    }
    if (toggle === 'autoAttack') {
      draft.autoAttack = el.checked;
      return;
    }

    const abilityId = el.dataset.ability;
    if (abilityId) {
      const set = new Set(draft.abilities ?? []);
      if (el.checked) set.add(abilityId);
      else set.delete(abilityId);
      draft.abilities = Array.from(set);
      return;
    }

    const buildId = el.dataset.build;
    if (buildId) {
      const set = new Set(draft.builds ?? []);
      if (el.checked) set.add(buildId);
      else set.delete(buildId);
      draft.builds = Array.from(set);
    }
  });

  paint();
  document.body.appendChild(mask);
}

/** 给开局面板用：内置 + 自定义合并成一张表 */
export function allAvailableUnits(): Record<string, UnitTypeDef> {
  return { ...UNIT_TYPES, ...loadCustomUnits() };
}
