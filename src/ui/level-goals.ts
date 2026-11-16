/**
 * 胜负条件（`goals`）面板。
 *
 * 这块以前只能改 JSON。它比事件简单（没有"动作序列"），但有两个容易误会的点，
 * 必须在界面上说清：
 *   1. **按数组顺序判定，先成立的赢。** 所以"限时击杀"要写成
 *      `[assassinate, survive]`——斩首写前面才是玩家的目标。
 *   2. **goal 只是"提前宣布赢"，不取消默认判定。** 城丢光、兵打光，照普通规则判输，
 *      不用另写失败条件。
 */

import { UNIT_TYPES, isPseudoUnit } from '../core/config.ts';
import { goalText, type LevelDef, type LevelGoal, type LevelZone } from '../core/level.ts';
import { bindZoneDrag, cityLookup, gridFromRows, renderLevelGrid } from './level-grid.ts';
import type { PlayerId } from '../core/types.ts';
import { toast } from './toast.ts';

const SEAT_ORDER: PlayerId[] = ['A', 'B', 'C', 'D'];
const SEAT_NAME: Record<string, string> = { A: '红方', B: '蓝方', C: '绿方', D: '黄方' };
const KIND_NAME: Record<string, string> = {
  survive: '守住一段时间',
  escort: '把兵送到某处',
  assassinate: '消灭某个目标',
};

export interface LevelGoalsOptions {
  level: LevelDef;
  onApply: (level: LevelDef) => void;
  onClose?: () => void;
}

const esc = (t: string) =>
  t.replace(/[&<>"]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : ''));

export function openLevelGoals(opts: LevelGoalsOptions): void {
  const level = opts.level;
  const w = level.map.w;
  const h = level.map.h;
  const seatCount = level.seats?.count ?? 2;
  const seats = SEAT_ORDER.slice(0, seatCount);
  const grid = gridFromRows(level.map.rows, w, h);
  const cityAt = cityLookup(
    {
      A: level.map.citiesA,
      B: level.map.citiesB,
      ...(level.seats?.cities?.C ? { C: level.seats.cities.C } : {}),
      ...(level.seats?.cities?.D ? { D: level.seats.cities.D } : {}),
    },
    2,
  );
  const catalog = { ...UNIT_TYPES, ...(level.units ?? {}) };
  const unitList = Object.values(catalog).filter((d) => !isPseudoUnit(d.id));

  let goals: LevelGoal[] = structuredClone(level.goals ?? []);
  /** 正在给第几条选护送区 */
  let picking: number | null = null;
  let preview: LevelZone | null = null;

  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  mask.innerHTML = `
    <div class="modal wide">
      <div class="modal-head">
        <h2>胜负条件</h2>
        <p>额外的胜负捷径，按顺序判定，先成立的赢。</p>
      </div>
      <div class="modal-body">
        <div class="level-goals-wrap">
          <div class="level-goals-col">
            <div class="level-events-toolbar">
              <select class="level-mini-select" data-new-kind>
                ${Object.entries(KIND_NAME)
                  .map(([k, n]) => `<option value="${k}">${esc(n)}</option>`)
                  .join('')}
              </select>
              <button class="btn btn-sm" data-act="add">加一条</button>
              <span class="field-hint" data-count></span>
            </div>
            <div class="level-goals-list" data-list></div>
          </div>
          <div class="level-events-side">
            <div class="level-pick-hint" data-pick-hint>右边这块地图用来选「送到哪里」。</div>
            <div class="level-canvas" data-canvas></div>
            <div class="level-canvas-foot"><span data-coord>第 -, - 格</span><span data-pick-state></span></div>
          </div>
        </div>
        <div class="field-hint" data-foot>改完点「保存」。</div>
      </div>
      <div class="modal-foot">
        <button class="btn btn-primary" data-act="apply">保存</button>
        <button class="btn" data-act="cancel">取消</button>
      </div>
    </div>`;

  const q = <T extends Element>(sel: string): T => mask.querySelector(sel) as T;
  const listEl = q<HTMLDivElement>('[data-list]');
  const countEl = q<HTMLSpanElement>('[data-count]');
  const canvasEl = q<HTMLDivElement>('[data-canvas]');
  const coordEl = q<HTMLSpanElement>('[data-coord]');
  const pickStateEl = q<HTMLSpanElement>('[data-pick-state]');
  const pickHintEl = q<HTMLDivElement>('[data-pick-hint]');
  const footEl = q<HTMLDivElement>('[data-foot]');

  const centerZone = (): LevelZone => ({ x0: Math.floor(w / 2), y0: Math.floor(h / 2), x1: Math.floor(w / 2), y1: Math.floor(h / 2) });

  const seatOpts = (cur: PlayerId | undefined): string =>
    seats.map((s) => `<option value="${s}" ${cur === s ? 'selected' : ''}>${SEAT_NAME[s] ?? s}</option>`).join('');

  const unitOpts = (cur: string | undefined, allowAny: boolean): string =>
    `${allowAny ? `<option value="" ${!cur ? 'selected' : ''}>任何兵种</option>` : ''}${unitList
      .map((d) => `<option value="${esc(d.id)}" ${cur === d.id ? 'selected' : ''}>${esc(d.name)}</option>`)
      .join('')}`;

  const defaultGoal = (kind: LevelGoal['kind']): LevelGoal => {
    if (kind === 'escort') return { kind: 'escort', seat: seats[0] ?? 'A', zone: centerZone() };
    if (kind === 'assassinate') {
      const target = unitList.find((d) => d.summonedOnly === true)?.id;
      return {
        kind: 'assassinate',
        winner: seats[0] ?? 'A',
        loser: seats[1] ?? 'B',
        ...(target ? { unitType: target } : {}),
      };
    }
    return { kind: 'survive', seat: seats[0] ?? 'A', untilTurn: 20 };
  };

  function card(g: LevelGoal, i: number): string {
    const head = `<span class="level-event-no">${i + 1}</span>
      <select class="level-mini-select" data-kind="${i}">${Object.entries(KIND_NAME)
        .map(([k, n]) => `<option value="${k}" ${g.kind === k ? 'selected' : ''}>${esc(n)}</option>`)
        .join('')}</select>`;

    let body = '';
    if (g.kind === 'survive') {
      body = `<span class="level-when-arg">
          <select class="level-mini-select" data-seat="${i}">${seatOpts(g.seat)}</select>
          守到第
          <input type="number" class="level-mini-num" min="1" max="999" data-until="${i}" value="${g.untilTurn}">
          次行动<span class="field-hint">（${seatCount} 家局 ≈ 第 ${Math.ceil(g.untilTurn / Math.max(1, seatCount))} 轮）</span>
        </span>`;
    } else if (g.kind === 'escort') {
      body = `<span class="level-when-arg">
          <select class="level-mini-select" data-seat="${i}">${seatOpts(g.seat)}</select>
          把
          <select class="level-mini-select" data-unit="${i}">${unitOpts(g.unitType, true)}</select>
          送到
          <button class="btn btn-sm" data-pick="${i}">${esc(zoneText(g.zone))}</button>
        </span>`;
    } else {
      body = `<span class="level-when-arg">
          <select class="level-mini-select" data-winner="${i}">${seatOpts(g.winner)}</select>
          消灭
          <select class="level-mini-select" data-loser="${i}">${seatOpts(g.loser)}</select>
          的
          <select class="level-mini-select" data-unit="${i}">${unitOpts(g.unitType, true)}</select>
          <input class="level-say-input" data-label="${i}" value="${esc(g.label ?? '')}" placeholder="叫它什么（顶栏会显示，比如「守将」）">
        </span>`;
    }

    return `<div class="level-event-card level-goal-card" data-goal="${i}">
        <div class="level-event-head">${head}
          <span class="level-goal-order">
            <button class="btn btn-sm" data-up="${i}" title="往前挪（先判）">↑</button>
            <button class="btn btn-sm" data-down="${i}" title="往后挪">↓</button>
            <button class="btn btn-sm" data-del="${i}">删除</button>
          </span>
        </div>
        <div class="level-goal-row">${body}</div>
        <div class="field-hint">${esc(previewText(g))}</div>
      </div>`;
  }

  function previewText(g: LevelGoal): string {
    const who = g.kind === 'assassinate' ? `（${SEAT_NAME[g.winner] ?? g.winner}赢）` : `（${SEAT_NAME[g.seat] ?? g.seat}赢）`;
    let extra = '';
    if (g.kind === 'assassinate' && g.unitType) {
      const def = catalog[g.unitType];
      // 只提示、不拦：作者可能就是想让对面"再也补不出来"（比如把它唯一的城打掉）
      if (def && def.summonedOnly !== true) {
        extra = `　· 这个兵种玩家造得出来，对面会一直补人——除非你能一口气清空。`;
      }
    }
    return `${goalText(g)}${who}${extra}`;
  }

  function zoneText(z: LevelZone): string {
    const x0 = Math.min(z.x0, z.x1);
    const x1 = Math.max(z.x0, z.x1);
    const y0 = Math.min(z.y0, z.y1);
    const y1 = Math.max(z.y0, z.y1);
    const cells = (x1 - x0 + 1) * (y1 - y0 + 1);
    return `${x0},${y0} → ${x1},${y1}（${cells} 格）`;
  }

  function renderList(): void {
    listEl.innerHTML =
      goals.length === 0
        ? '<div class="editor-empty">还没有额外胜负条件。这一关就按普通规则打（把对手打光）。</div>'
        : goals.map(card).join('');
    countEl.textContent = goals.length === 0 ? '按普通规则判胜负' : `${goals.length} 条，按顺序判`;
  }

  function renderMap(): void {
    const zone = preview ?? (picking !== null && goals[picking]?.kind === 'escort' ? (goals[picking] as { zone: LevelZone }).zone : null);
    const inZone = (x: number, y: number): boolean =>
      !!zone &&
      x >= Math.min(zone.x0, zone.x1) &&
      x <= Math.max(zone.x0, zone.x1) &&
      y >= Math.min(zone.y0, zone.y1) &&
      y <= Math.max(zone.y0, zone.y1);

    renderLevelGrid(canvasEl, {
      w,
      h,
      grid,
      cityAt,
      cityLabel: (hit) => hit.seat,
      extraClass: (x, y) => (inZone(x, y) ? 'is-selected' : ''),
    });
    pickStateEl.textContent = picking !== null ? '正在框选「送到哪里」…' : '';
  }

  const renderAll = (): void => {
    renderList();
    renderMap();
  };

  /* ---- 地图：拖框选护送区 ---- */
  canvasEl.addEventListener('pointermove', (ev) => {
    const cell = (ev.target as HTMLElement).closest<HTMLElement>('[data-x]');
    if (cell) coordEl.textContent = `第 ${cell.dataset.x}, ${cell.dataset.y} 格`;
  });

  bindZoneDrag(canvasEl, {
    enabled: () => picking !== null,
    onUpdate: (z) => {
      preview = z;
      renderMap();
    },
    onCommit: (zone) => {
      if (picking === null) return;
      const g = goals[picking];
      if (g && g.kind === 'escort') g.zone = zone;
      preview = null;
      picking = null;
      renderAll();
      footEl.textContent = '护送区改好了。';
    },
  });

  /* ---- 表单 ---- */
  mask.addEventListener('input', (ev) => {
    const el = ev.target as HTMLElement;
    const until = el.getAttribute('data-until');
    if (until !== null) {
      const g = goals[Number(until)];
      if (g && g.kind === 'survive') g.untilTurn = Math.max(1, Math.round(Number((el as HTMLInputElement).value) || 1));
      return;
    }
    const label = el.getAttribute('data-label');
    if (label !== null) {
      const g = goals[Number(label)];
      if (g && g.kind === 'assassinate') {
        const v = (el as HTMLInputElement).value.trim();
        if (v) g.label = v;
        else delete g.label;
      }
    }
  });

  mask.addEventListener('change', (ev) => {
    const el = ev.target as HTMLElement;
    const val = (el as HTMLInputElement | HTMLSelectElement).value;

    const kind = el.getAttribute('data-kind');
    if (kind !== null) {
      goals[Number(kind)] = defaultGoal(val as LevelGoal['kind']);
      renderAll();
      return;
    }
    const seat = el.getAttribute('data-seat');
    if (seat !== null) {
      const g = goals[Number(seat)];
      if (g && (g.kind === 'survive' || g.kind === 'escort')) g.seat = val as PlayerId;
      renderList();
      return;
    }
    const unit = el.getAttribute('data-unit');
    if (unit !== null) {
      const g = goals[Number(unit)];
      if (g && (g.kind === 'escort' || g.kind === 'assassinate')) {
        if (val) g.unitType = val;
        else delete g.unitType;
      }
      renderList();
      return;
    }
    const winner = el.getAttribute('data-winner');
    if (winner !== null) {
      const g = goals[Number(winner)];
      if (g && g.kind === 'assassinate') g.winner = val as PlayerId;
      renderList();
      return;
    }
    const loser = el.getAttribute('data-loser');
    if (loser !== null) {
      const g = goals[Number(loser)];
      if (g && g.kind === 'assassinate') g.loser = val as PlayerId;
      renderList();
      return;
    }
    const until = el.getAttribute('data-until');
    if (until !== null) {
      const g = goals[Number(until)];
      if (g && g.kind === 'survive') g.untilTurn = Math.max(1, Math.round(Number(val) || 1));
      renderList();
    }
  });

  mask.addEventListener('click', (ev) => {
    const t = ev.target as HTMLElement;

    const pickBtn = t.closest<HTMLElement>('[data-pick]');
    if (pickBtn) {
      picking = Number(pickBtn.dataset.pick);
      pickHintEl.textContent = '在下面的地图上拖一个矩形 → 松手就定「送到哪里」。';
      renderMap();
      return;
    }

    const up = t.closest<HTMLElement>('[data-up]');
    if (up) {
      const i = Number(up.dataset.up);
      if (i > 0) {
        const arr = [...goals];
        [arr[i - 1], arr[i]] = [arr[i]!, arr[i - 1]!];
        goals = arr;
        renderList();
      }
      return;
    }
    const down = t.closest<HTMLElement>('[data-down]');
    if (down) {
      const i = Number(down.dataset.down);
      if (i < goals.length - 1) {
        const arr = [...goals];
        [arr[i + 1], arr[i]] = [arr[i]!, arr[i + 1]!];
        goals = arr;
        renderList();
      }
      return;
    }
    const del = t.closest<HTMLElement>('[data-del]');
    if (del) {
      goals = goals.filter((_g, idx) => idx !== Number(del.dataset.del));
      renderAll();
      return;
    }

    const act = t.closest<HTMLElement>('[data-act]')?.dataset.act;
    if (act === 'add') {
      const sel = mask.querySelector<HTMLSelectElement>('[data-new-kind]');
      goals = [...goals, defaultGoal((sel?.value ?? 'survive') as LevelGoal['kind'])];
      renderAll();
      return;
    }
    if (act === 'cancel') {
      mask.remove();
      opts.onClose?.();
      return;
    }
    if (act === 'apply') {
      // 只拦"必然永远不成立"的那一种：斩首目标根本不存在
      const broken = goals.filter(
        (g) => g.kind === 'assassinate' && !!g.unitType && !catalog[g.unitType],
      );
      if (broken.length > 0) {
        footEl.textContent = '有一条「消灭某个目标」选中的兵种在这一局不存在，先换一个。';
        return;
      }
      const next: LevelDef = { ...level };
      if (goals.length > 0) next.goals = goals.map((g) => structuredClone(g));
      else delete (next as { goals?: unknown }).goals;
      opts.onApply(next);
      mask.remove();
      toast('胜负条件已更新，别忘了点「保存到我的关卡」');
    }
  });

  renderAll();
  document.body.appendChild(mask);
  if (goals.length === 0) footEl.textContent = '这一关目前没有额外胜负条件：把对手打光就赢。';
}
