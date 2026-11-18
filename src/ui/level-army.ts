/**
 * 关卡编辑器的摆兵面板（E3）。
 *
 * 要解决的是三个具体的痛（都写在 PLAN 的 E3 里）：
 *   1. `deploy` 是"写坐标"，坐标落到水上 / 城格上会被**静默跳过**，战报里只留一句
 *      "摆不上去"——作者根本不会去看；
 *   2. 兵种只能写"本局存在的"，写错时代或写错 id 同样静默跳过；
 *   3. `hidden` 的席位必须靠 `deploy` 事件上场，忘了写就永远不来。
 *
 * 所以这里的核心不是"好看"，是**在放下去的那一刻就说清楚行不行**。
 *
 * 一条不变量：货架只给"这一关真的有可能出现"的兵种——
 *   本时代能造的（`era <= startEra`）+ 关卡自带的 `units`。
 * 这样从源头上就写不出"青铜关摆了坦克"。想摆高时代的兵也能摆，
 * 但会先被 lint 警告一句（那是故意的设计，不是错误）。
 */

import { CONFIG, ERAS, UNIT_TYPES, isPseudoUnit } from '../core/config.ts';
import { unitStatLine } from '../core/info.ts';
import { loadCustomUnits } from '../core/customUnits.ts';
import { standState } from '../core/level-lint.ts';
import { terrainFromChar } from '../core/mapgen.ts';
import type { DeployUnit } from '../core/level.ts';
import type { LevelDef } from '../core/level.ts';
import type { PlayerId, UnitTypeDef } from '../core/types.ts';
import { cityLookup, gridFromRows, renderLevelGrid } from './level-grid.ts';
import { toast } from './toast.ts';

const SEATS: PlayerId[] = ['A', 'B', 'C', 'D'];
const SEAT_NAME: Record<string, string> = { A: '红方', B: '蓝方', C: '绿方', D: '黄方' };
/** 城的边长（和画布保持同一个假设：地图数据里没有城大小这个字段） */
const CITY_SIZE = 2;

export interface LevelArmyOptions {
  level: LevelDef;
  onApply: (level: LevelDef) => void;
  onClose?: () => void;
}

const esc = (t: string) =>
  t.replace(/[&<>"]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;'));

interface Placed extends DeployUnit {
  owner: PlayerId;
}

export function openLevelArmy(opts: LevelArmyOptions): void {
  const level = opts.level;
  const seatCount = level.seats?.count ?? 2;
  const seats = SEATS.slice(0, seatCount);
  const startEra = level.setup?.startEra ?? 1;
  const w = level.map.w;
  const h = level.map.h;
  const rows = level.map.rows;

  /** 本局的兵种表：内置 + 玩家自定义 + 这一关自带。和 `createMatch` 的口径一致到"够用" */
  const catalog: Record<string, UnitTypeDef> = {
    ...UNIT_TYPES,
    ...loadCustomUnits(),
    ...(level.units ?? {}),
  };

  /** 城位按"每家几座城"给，占格交给共用底座算（和画布同一份规则） */
  const cityPoints: Partial<Record<PlayerId, Array<{ x: number; y: number }>>> = {
    A: level.map.citiesA,
    B: level.map.citiesB,
    ...(level.seats?.cities?.C ? { C: level.seats.cities.C } : {}),
    ...(level.seats?.cities?.D ? { D: level.seats.cities.D } : {}),
  };
  const cityAt = cityLookup(cityPoints, CITY_SIZE);
  const grid = gridFromRows(rows, w, h);

  /** 从关卡数据恢复出来的兵（含所有席位，摆的时候要看见对面） */
  let placed: Placed[] = [];
  for (const [seat, list] of Object.entries(level.deploy ?? {})) {
    for (const u of list ?? []) placed.push({ ...u, owner: seat as PlayerId });
  }

  /** 正在摆哪一家 */
  let editing: PlayerId = seats[0] ?? 'A';
  /** 手上拿的兵种 */
  let picked: string | null = null;

  /*
   * 别叫 `unitAt`：`npm run lint:boards` 把那个名字当"默认地球那一格"的投影函数
   * （多图对局里那样写会静默出错）。这儿是编辑器自己的临时数组，和棋盘无关，
   * 起个不一样的名字省得被误判，也省得以后有人真以为它在读局面。
   */
  const unitOnCell = (x: number, y: number) => placed.find((u) => u.x === x && u.y === y) ?? null;

  const standOf = (type: string, x: number, y: number): string | null => {
    if (x < 0 || y < 0 || x >= w || y >= h) return '超出棋盘';
    const t = terrainFromChar(rows[y]?.[x] ?? '.');
    const state = standState(catalog[type], t);
    if (state === 'bad') return `${CONFIG.terrainName[t]}上站不住`;
    const city = cityAt(x, y);
    if (city && city.seat !== editing) return `那是${SEAT_NAME[city.seat] ?? city.seat}的城`;
    const other = unitOnCell(x, y);
    if (other) return `这一格已经有${SEAT_NAME[other.owner] ?? other.owner}的兵了`;
    return null;
  };

  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  mask.innerHTML = `
    <div class="modal wide">
      <div class="modal-head">
        <h2>摆兵</h2>
        <p>选一家、选兵种，点格子摆放。点自己的兵是撤掉。写了兵力的那一方不再自动撒兵。</p>
      </div>
      <div class="modal-body">
        <div class="level-army-seats" data-seats></div>
        <div class="level-canvas-wrap">
          <div class="level-palette">
            <div class="editor-group-title" data-palette-title>兵种</div>
            <div class="level-brushes level-army-units" data-units></div>
          </div>
          <div class="level-canvas-box">
            <div class="lv-grid level-canvas" data-canvas></div>
            <div class="level-canvas-foot">
              <span data-coord>第 -, - 格</span>
              <span data-counts></span>
            </div>
          </div>
        </div>
        <div class="field-hint" data-foot>改完点「保存」。</div>
      </div>
      <div class="modal-foot">
        <button class="btn btn-sm" data-act="clear">清空这一家</button>
        <button class="btn btn-primary" data-act="apply">保存</button>
        <button class="btn" data-act="cancel">取消</button>
      </div>
    </div>`;

  const q = <T extends Element>(sel: string): T => mask.querySelector(sel) as T;
  const canvasEl = q<HTMLDivElement>('[data-canvas]');
  const seatsEl = q<HTMLDivElement>('[data-seats]');
  const unitsEl = q<HTMLDivElement>('[data-units]');
  const paletteTitleEl = q<HTMLDivElement>('[data-palette-title]');
  const footEl = q<HTMLDivElement>('[data-foot]');
  const coordEl = q<HTMLSpanElement>('[data-coord]');
  const countsEl = q<HTMLSpanElement>('[data-counts]');

  /**
   * 货架：**全部兵种**，按时代分组，不做任何过滤。
   *
   * 这里原先只给"本时代能造的"，那是错的："青铜关空投一辆坦克"是正经的关卡设计，
   * 不是配置错误。框架允许（`unitTypes` 里本来就有全时代的兵），编辑器没有资格替作者
   * 做这个决定。时代分组只是让人找得到，不是一堵墙。
   */
  const shelf = (): Array<{ group: string; units: UnitTypeDef[] }> => {
    const own = new Set(Object.keys(level.units ?? {}));
    const groups: Array<{ group: string; units: UnitTypeDef[] }> = [];
    for (const era of ERAS) {
      const list = Object.values(catalog)
        .filter((d) => !isPseudoUnit(d.id) && !own.has(d.id) && d.era === era.level)
        .sort((a, b) => a.cost - b.cost);
      if (list.length > 0) groups.push({ group: `${era.name}（第 ${era.level} 时代）`, units: list });
    }
    // 不在任何时代里的（数据异常 / 扩展临时兵种）别丢掉，单独一组兜住
    const orphans = Object.values(catalog).filter(
      (d) => !isPseudoUnit(d.id) && !own.has(d.id) && !ERAS.some((e) => e.level === d.era),
    );
    if (orphans.length > 0) groups.push({ group: '其它', units: orphans });
    const ownUnits = Object.values(level.units ?? {});
    if (ownUnits.length > 0) groups.push({ group: '这一关自带', units: ownUnits });
    return groups;
  };

  const renderSeats = (): void => {
    seatsEl.innerHTML = seats
      .map((seat) => {
        const n = placed.filter((u) => u.owner === seat).length;
        return `<button type="button" class="level-seat-tab lv-${seat} ${
          editing === seat ? 'active' : ''
        }" data-own="${seat}">${SEAT_NAME[seat] ?? seat}<i>${n}</i></button>`;
      })
      .join('');
  };

  const renderShelf = (): void => {
    const groups = shelf();
    const total = groups.reduce((n, g) => n + g.units.length, 0);
    paletteTitleEl.textContent = `兵种（${total} 种，全时代都能摆；这一关开局是第 ${startEra} 时代）`;
    unitsEl.innerHTML = groups
      .map(
        (g) => `<div class="level-army-group">${esc(g.group)}</div>${g.units
          .map((d) => {
            const on = picked === d.id;
            return `<button type="button" class="level-brush ${on ? 'active' : ''}" data-unit="${esc(d.id)}" title="${
              esc(d.name)
            } · ${esc(unitStatLine(d))}${d.summonedOnly ? ' · 只能由事件刷出' : ''}">
                <span class="level-swatch lv-unit-swatch lv-${editing}">${esc(d.short)}</span>
                <span>${esc(d.name)}<i class="level-brush-char">${d.maxHp}血 ${d.move}移 ${d.range}射</i></span>
              </button>`;
          })
          .join('')}`,
      )
      .join('');
  };

  const renderGrid = (): void => {
    renderLevelGrid(canvasEl, {
      w,
      h,
      grid,
      cityAt,
      cityLabel: (hit) => hit.seat,
      overlay: (x, y) => {
        const unit = unitOnCell(x, y);
        if (!unit) return '';
        return `<span class="lv-unit lv-${unit.owner}">${esc(catalog[unit.type]?.short ?? '?')}</span>`;
      },
      extraClass: (x, y) => {
        const unit = unitOnCell(x, y);
        if (unit) return `lv-${unit.owner}`;
        const city = cityAt(x, y);
        return city ? `lv-${city.seat}` : '';
      },
    });
    countsEl.textContent = seats
      .map((s) => `${SEAT_NAME[s] ?? s} ${placed.filter((u) => u.owner === s).length}`)
      .join(' · ');
  };

  const refresh = (): void => {
    renderSeats();
    renderShelf();
    renderGrid();
  };

  const place = (x: number, y: number): void => {
    const here = unitOnCell(x, y);
    if (here) {
      if (here.owner !== editing) {
        footEl.textContent = `${SEAT_NAME[here.owner] ?? here.owner}的兵在这儿。切到那一家才能撤掉。`;
        return;
      }
      placed = placed.filter((u) => !(u.x === x && u.y === y));
      renderSeats();
      renderGrid();
      footEl.textContent = '撤掉了。';
      return;
    }
    if (!picked) {
      footEl.textContent = '先在左边选一个兵种。';
      return;
    }
    const why = standOf(picked, x, y);
    if (why) {
      footEl.textContent = `(${x}, ${y}) 放不了：${why}。`;
      return;
    }
    placed.push({ type: picked, x, y, owner: editing });
    renderSeats();
    renderGrid();
    footEl.textContent = '';
  };

  canvasEl.addEventListener('pointerdown', (ev) => {
    const el = (ev.target as HTMLElement).closest<HTMLElement>('[data-x]');
    if (!el) return;
    ev.preventDefault();
    place(Number(el.dataset.x), Number(el.dataset.y));
  });

  canvasEl.addEventListener('pointermove', (ev) => {
    const el = (ev.target as HTMLElement).closest<HTMLElement>('[data-x]');
    if (el) coordEl.textContent = `第 ${el.dataset.x}, ${el.dataset.y} 格`;
  });

  mask.addEventListener('click', (ev) => {
    const t = ev.target as HTMLElement;

    const seatBtn = t.closest<HTMLElement>('[data-own]');
    if (seatBtn) {
      editing = seatBtn.dataset.own as PlayerId;
      refresh();
      footEl.textContent = `现在摆${SEAT_NAME[editing] ?? editing}的兵。`;
      return;
    }
    const unitBtn = t.closest<HTMLElement>('[data-unit]');
    if (unitBtn) {
      picked = unitBtn.dataset.unit ?? null;
      renderShelf();
      return;
    }

    const act = t.closest<HTMLElement>('[data-act]')?.dataset.act;
    if (act === 'cancel') {
      mask.remove();
      opts.onClose?.();
      return;
    }
    if (act === 'clear') {
      const before = placed.length;
      placed = placed.filter((u) => u.owner !== editing);
      if (placed.length !== before) {
        renderSeats();
        renderGrid();
        footEl.textContent = `清掉了${SEAT_NAME[editing] ?? editing}的 ${before - placed.length} 个兵。`;
      }
      return;
    }
    if (act === 'apply') {
      // 引擎那边静默跳过的问题，这里先说清：零兵的席位等于"开局什么都没有"
      const empty = seats.filter((s) => placed.filter((u) => u.owner === s).length === 0);
      if (empty.length > 0) {
        const names = empty.map((s) => SEAT_NAME[s] ?? s).join('、');
        if (!window.confirm(`${names}一个兵都没有。这一方会以"零兵力"开局（不是自动撒兵），确定吗？`)) return;
      }
      const next: LevelDef = { ...level };
      const deploy: Partial<Record<PlayerId, DeployUnit[]>> = {};
      for (const seat of seats) {
        const list = placed.filter((u) => u.owner === seat).map((u) => ({ type: u.type, x: u.x, y: u.y }));
        /*
         * **每一席都写键，空的也写成 `[]`**（2026-11-18 第二次修）。
         *
         * 上一版只给"原本有兵、现在清空"的席位写 `[]`，于是**旧关卡永远治不好**：
         * 那些关卡在更早的版本里就把空席位的键删掉了，作者再怎么删兵也只会得到
         * "还是没有这个键" → 开局继续自动撒兵。而弹窗明明写着"会以零兵力开局
         * （不是自动撒兵）"——那句话当时是在说谎。
         *
         * 现在改成：动过「摆兵」就等于作者接管了**所有**席位。点「应用」时
         * 已经会二次确认每一席的零兵状态，作者看到的就是最终结果。
         */
        deploy[seat] = list;
      }
      if (Object.keys(deploy).length > 0) next.deploy = deploy;
      else delete (next as { deploy?: unknown }).deploy;
      opts.onApply(next);
      mask.remove();
      toast('兵力已更新，别忘了点「保存到我的关卡」');
    }
  });

  refresh();
  document.body.appendChild(mask);
  if (seats.length > 0) footEl.textContent = `现在摆${SEAT_NAME[editing] ?? editing}的兵：选兵种 → 点格子。`;
}
