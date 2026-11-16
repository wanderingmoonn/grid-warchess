/**
 * 关卡编辑器的席位面板。
 *
 * 框架里本来就有一整套席位设定（`LevelSeats` / `LevelSetup`），但编辑器一直只让人改 JSON。
 * 结果是"第三家中途登场""这一家的城开局就是铁器"这些**正经设计**，只能靠背字段名。
 * 这个面板把它们搬成能点的东西。
 *
 * 一条原则（2026-11-16 用户定的）：**框架支持的东西，编辑器不许缩窄。**
 * 所以这里没有"推荐值"、没有"这样会变难"的拦截，只有事实性的提示
 * （比如"第三家还没有城，得先去画地图摆一座"）。
 */

import { ERAS } from '../core/config.ts';
import { passable } from '../core/config.ts';
import { terrainFromChar } from '../core/mapgen.ts';
import type { LevelDef, LevelSeats } from '../core/level.ts';
import type { MapPoint } from '../core/fixed-maps.ts';
import type { PlayerId } from '../core/types.ts';
import { toast } from './toast.ts';

const SEAT_ORDER: PlayerId[] = ['A', 'B', 'C', 'D'];
const SEAT_NAME: Record<string, string> = { A: '红方', B: '蓝方', C: '绿方', D: '黄方' };
const CITY_SIZE = 2;

export interface LevelSeatsOptions {
  level: LevelDef;
  onApply: (level: LevelDef) => void;
  onClose?: () => void;
}

const esc = (t: string) =>
  t.replace(/[&<>"]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : c));

export function openLevelSeats(opts: LevelSeatsOptions): void {
  const level = opts.level;
  const w = level.map.w;
  const h = level.map.h;

  let count: 2 | 3 | 4 = (level.seats?.count ?? 2) as 2 | 3 | 4;
  const ai = new Set<PlayerId>(level.seats?.ai ?? []);
  const hidden = new Set<PlayerId>(level.seats?.hidden ?? []);
  /** 没有城的席位（靠开局兵力打）。和"中途登场"互斥，apply 时会拦 */
  const cityless = new Set<PlayerId>(level.seats?.cityless ?? []);
  /** 只记"和开局时代不一样"的那些 */
  const cityEra: Partial<Record<PlayerId, number>> = { ...(level.seats?.cityEra ?? {}) };
  /** C / D 的城位（A / B 在地图里） */
  const extraCities: Partial<Record<'C' | 'D', MapPoint[]>> = {
    ...(level.seats?.cities?.C ? { C: level.seats.cities.C.map((p) => ({ ...p })) } : {}),
    ...(level.seats?.cities?.D ? { D: level.seats.cities.D.map((p) => ({ ...p })) } : {}),
  };
  let startEra = level.setup?.startEra;

  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  mask.innerHTML = `
    <div class="modal wide">
      <div class="modal-head">
        <h2>席位</h2>
        <p>
          几家、谁交给电脑、谁中途才登场、每家的城开局是第几级——都在这一页。
          第三四家的城位要先去「画地图」里摆，这里只显示有没有。
        </p>
      </div>
      <div class="modal-body">
        <label class="editor-field level-seat-start">
          <span>开局时代（所有城的默认等级，也决定开局金币）</span>
          <select data-start-era></select>
        </label>
        <div class="field-hint" data-start-hint></div>
        <div class="level-seat-count" data-count></div>
        <div class="level-seat-list" data-rows></div>
        <div class="field-hint" data-foot></div>
      </div>
      <div class="modal-foot">
        <button class="btn btn-primary btn-sm" data-act="apply">用这套席位</button>
        <button class="btn" data-act="cancel">取消</button>
      </div>
    </div>`;

  const q = <T extends Element>(sel: string): T => mask.querySelector(sel) as T;
  const rowsEl = q<HTMLDivElement>('[data-rows]');
  const countEl = q<HTMLDivElement>('[data-count]');
  const startSel = q<HTMLSelectElement>('[data-start-era]');
  const startHintEl = q<HTMLDivElement>('[data-start-hint]');
  const footEl = q<HTMLDivElement>('[data-foot]');

  startSel.innerHTML =
    `<option value="">跟面板走（玩家自己选）</option>` +
    ERAS.map((e) => `<option value="${e.level}">${esc(e.name)}（第 ${e.level} 级）</option>`).join('');
  startSel.value = startEra === undefined ? '' : String(startEra);

  const seated = (): PlayerId[] => SEAT_ORDER.slice(0, count);

  /** 现有全部城位（含 A/B），用来判断新加的城会不会压上去 */
  const allCityPoints = (): MapPoint[] => [
    ...level.map.citiesA,
    ...level.map.citiesB,
    ...(extraCities.C ?? []),
    ...(extraCities.D ?? []),
  ];

  /**
   * 给新加的一家找一块能放城的地方。
   *
   * 为什么不直接拒绝"没有城就不能加第三家"：那样流程会死锁——
   * 加不了第三家，就没法在画布上摆它的城；而画布的席位页签是跟着 `seats.count` 走的。
   * 所以先塞到角落，作者再去画布挪。找不到空地才真的拒绝。
   */
  const findCitySpot = (): MapPoint | null => {
    const taken = allCityPoints();
    const candidates: MapPoint[] = [
      { x: 1, y: h - 1 - CITY_SIZE },
      { x: w - 1 - CITY_SIZE, y: 1 },
      { x: 1, y: 1 },
      { x: w - 1 - CITY_SIZE, y: h - 1 - CITY_SIZE },
      { x: Math.floor((w - CITY_SIZE) / 2), y: Math.floor((h - CITY_SIZE) / 2) },
    ];
    for (const p of candidates) {
      if (p.x < 0 || p.y < 0 || p.x + CITY_SIZE > w || p.y + CITY_SIZE > h) continue;
      if (taken.some((q2) => Math.abs(q2.x - p.x) < CITY_SIZE && Math.abs(q2.y - p.y) < CITY_SIZE)) continue;
      let ok = true;
      for (let dy = 0; dy < CITY_SIZE && ok; dy += 1) {
        for (let dx = 0; dx < CITY_SIZE && ok; dx += 1) {
          const t = terrainFromChar(level.map.rows[p.y + dy]?.[p.x + dx] ?? '.');
          if (!passable(t)) ok = false;
        }
      }
      if (ok) return p;
    }
    return null;
  };

  const setCount = (n: 2 | 3 | 4): void => {
    if (n === count) return;
    if (n > count) {
      // 加席位：每一家都要有城，否则数据过不了校验（也就打不开画布）
      for (const seat of SEAT_ORDER.slice(count, n)) {
        if (seat !== 'C' && seat !== 'D') continue;
        if ((extraCities[seat] ?? []).length > 0) continue;
        const spot = findCitySpot();
        if (!spot) {
          footEl.textContent = `加不了第 ${n} 家：地图上找不到一块空着的平地放城。先去「画地图」腾地方。`;
          return;
        }
        extraCities[seat] = [spot];
      }
    } else {
      // 减席位：把尾巴上那几家的城 / 晚登场 / 时代一起清掉，别留下查不到的脏数据
      for (const seat of SEAT_ORDER.slice(n, count)) {
        if (seat === 'C' || seat === 'D') delete extraCities[seat];
        hidden.delete(seat);
        delete cityEra[seat];
      }
    }
    count = n;
    for (const seat of [...ai]) if (!seated().includes(seat)) ai.delete(seat);
    render();
  };

  const render = (): void => {
    countEl.innerHTML = [2, 3, 4]
      .map(
        (n) => `<button type="button" class="chip ${count === n ? 'active' : ''}" data-count-btn="${n}">${n} 家</button>`,
      )
      .join('');

    rowsEl.innerHTML = seated()
      .map((seat) => {
        const hasCity = seat === 'A' || seat === 'B' ? (seat === 'A' ? level.map.citiesA : level.map.citiesB).length > 0 : (extraCities[seat as 'C' | 'D'] ?? []).length > 0;
        const eraSel = `<select data-era-for="${seat}">
            <option value="">跟开局一样</option>
            ${ERAS.map(
              (e) =>
                `<option value="${e.level}" ${Number(cityEra[seat]) === e.level ? 'selected' : ''}>${esc(
                  e.name,
                )}</option>`,
            ).join('')}
          </select>`;
        return `<div class="level-seat-row lv-${seat}">
            <span class="level-seat-name">${SEAT_NAME[seat] ?? seat}</span>
            <label class="editor-check"><input type="checkbox" data-ai-for="${seat}" ${
              ai.has(seat) ? 'checked' : ''
            }> 电脑托管</label>
            <label class="editor-check"><input type="checkbox" data-hidden-for="${seat}" ${
              hidden.has(seat) ? 'checked' : ''
            }> 中途才登场</label>
            <label class="editor-check"><input type="checkbox" data-cityless-for="${seat}" ${
              cityless.has(seat) ? 'checked' : ''
            }> 没有城</label>
            ${
              cityless.has(seat)
                ? '<span class="level-seat-city">靠开局兵力打（没有产线、没有收入）</span>'
                : `<label class="level-seat-era">城的时代 ${eraSel}</label>
                   <span class="level-seat-city ${hasCity ? '' : 'is-missing'}">${hasCity ? '有城' : '没有城'}</span>`
            }
          </div>`;
      })
      .join('');

    const startLabel =
      startEra === undefined
        ? '开局时代：不锁定，玩家自己选（锁了就等于锁开局金币）'
        : `开局时代：锁定 ${ERAS[startEra - 1]?.name ?? startEra}`;
    startHintEl.textContent = startLabel;

    const noCity = seated().filter((seat) => {
      if (cityless.has(seat)) return false; // 标了"没有城"的席位本来就不该有城
      const list = seat === 'A' ? level.map.citiesA : seat === 'B' ? level.map.citiesB : extraCities[seat as 'C' | 'D'] ?? [];
      return list.length === 0;
    });
    footEl.textContent =
      noCity.length > 0
        ? `${noCity.map((s) => SEAT_NAME[s] ?? s).join('、')}还没有城。${noCity.some((s) => s === 'C' || s === 'D') ? '去「画地图」给它们各摆一座。' : ''}`
        : '中途登场的席位要有事件把它叫上场（现在是 lint 在提醒，事件表单还没做）。';
  };

  mask.addEventListener('change', (ev) => {
    const el = ev.target as HTMLElement;
    if (el === startSel) {
      startEra = startSel.value === '' ? undefined : Number(startSel.value);
      render();
      return;
    }
    const aiSeat = el.getAttribute('data-ai-for') as PlayerId | null;
    if (aiSeat) {
      if ((el as HTMLInputElement).checked) ai.add(aiSeat);
      else ai.delete(aiSeat);
      return;
    }
    const hiddenSeat = el.getAttribute('data-hidden-for') as PlayerId | null;
    if (hiddenSeat) {
      if ((el as HTMLInputElement).checked) hidden.add(hiddenSeat);
      else hidden.delete(hiddenSeat);
      render();
      return;
    }
    const citylessSeat = el.getAttribute('data-cityless-for') as PlayerId | null;
    if (citylessSeat) {
      if ((el as HTMLInputElement).checked) {
        cityless.add(citylessSeat);
        // 没城就不该有"城的时代"，也不该留着城位（两边都写会被校验拒）
        delete cityEra[citylessSeat];
        if (citylessSeat === 'C' || citylessSeat === 'D') delete extraCities[citylessSeat];
      } else {
        cityless.delete(citylessSeat);
      }
      render();
      return;
    }

    const eraSeat = el.getAttribute('data-era-for') as PlayerId | null;
    if (eraSeat) {
      const v = (el as HTMLSelectElement).value;
      if (v === '') delete cityEra[eraSeat];
      else cityEra[eraSeat] = Number(v);
    }
  });

  mask.addEventListener('click', (ev) => {
    const t = ev.target as HTMLElement;
    const countBtn = t.closest<HTMLElement>('[data-count-btn]');
    if (countBtn) {
      setCount(Number(countBtn.dataset.countBtn) as 2 | 3 | 4);
      return;
    }
    const act = t.closest<HTMLElement>('[data-act]')?.dataset.act;
    if (act === 'cancel') {
      mask.remove();
      opts.onClose?.();
      return;
    }
    if (act === 'apply') {
      const clash = [...cityless].filter((seat) => hidden.has(seat));
      if (clash.length > 0) {
        footEl.textContent = `${clash.map((s) => SEAT_NAME[s] ?? s).join('、')}同时被标成「没有城」和「中途才登场」：未登场要靠 deploy 事件放城，这两件事冲突。`;
        return;
      }
      const next: LevelDef = { ...level };
      // A/B 的城位在地图里，标了"没有城"就要一起清掉（不然校验会拒）
      if (cityless.has('A') || cityless.has('B')) {
        next.map = {
          ...level.map,
          ...(cityless.has('A') ? { citiesA: [] } : {}),
          ...(cityless.has('B') ? { citiesB: [] } : {}),
        };
      }

      const seats: LevelSeats = {
        count,
        ...(cityless.size > 0 ? { cityless: [...cityless] } : {}),
        // 显式写出来（含空数组）：这是"这一关的硬设定"，不留给面板去猜
        ai: [...ai],
        ...(hidden.size > 0 ? { hidden: [...hidden] } : {}),
        ...(Object.keys(cityEra).length > 0 ? { cityEra: { ...cityEra } } : {}),
        ...(count > 2
          ? {
              cities: {
                ...(extraCities.C ? { C: extraCities.C.map((p) => ({ ...p })) } : {}),
                ...(extraCities.D ? { D: extraCities.D.map((p) => ({ ...p })) } : {}),
              },
            }
          : {}),
      };
      next.seats = seats;
      const setup = { ...(level.setup ?? {}) };
      if (startEra === undefined) delete (setup as { startEra?: number }).startEra;
      else setup.startEra = startEra;
      if (Object.keys(setup).length > 0) next.setup = setup;
      else delete (next as { setup?: unknown }).setup;

      opts.onApply(next);
      mask.remove();
      toast('席位已更新，别忘了点「保存到我的关卡」');
    }
  });

  render();
  document.body.appendChild(mask);
}
