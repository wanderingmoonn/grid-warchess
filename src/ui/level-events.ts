/**
 * 关卡编辑器的事件表单（E4a）。
 *
 * 这块是整套编辑器里唯一"有逻辑"的东西。设计上的核心判断：
 * **它不是一门语言，只是把 `LevelEvent` 摊成能点的句子。**
 * 所以没有分支、没有变量、没有事件链，也不做拖拽连线——那三条边界一旦破了，
 * 保存格式、校验、试玩全要跟着改。
 *
 * 一条事件 = 一张卡片：`当 … 就 …`。
 *   · 当：第 N 次行动 / 某家的兵死了 / 有单位走进区域；
 *   · 就：播报 / 刷兵 / 换打法 / 让某家登场 / 改地形。
 *
 * 两个"必须让人看得见"的地方：
 *   1. **`turn` 是行动序号不是轮**——输入框旁边直接算给你看（两家局约第几轮）；
 *   2. **区域和落点在地图上点**，不让人手写 x0/y0/x1/y1。
 */

import { CONFIG, UNIT_TYPES, isPseudoUnit } from '../core/config.ts';
import { standState } from '../core/level-lint.ts';
import {
  LEVEL_TERRAINS,
  type LevelDo,
  type LevelEvent,
  type LevelDef,
  type LevelTerrain,
  type LevelWhen,
  type LevelWhenLeaf,
  type LevelZone,
} from '../core/level.ts';
import type { PlayerId } from '../core/types.ts';
import { bindZoneDrag, cellFromEvent, cityLookup, gridFromRows, renderLevelGrid, terrainAt } from './level-grid.ts';
import { toast } from './toast.ts';

const SEAT_ORDER: PlayerId[] = ['A', 'B', 'C', 'D'];
const SEAT_NAME: Record<string, string> = { A: '红方', B: '蓝方', C: '绿方', D: '黄方' };
const STRATEGY_NAME: Record<string, string> = {
  auto: '自动（按局势自己判断）',
  rush: '速攻（压上去打）',
  boom: '发育（先攒经济）',
  hold: '固守（守住不出）',
};
const DO_KIND_NAME: Record<string, string> = {
  say: '播报一句话',
  spawn: '刷一批兵',
  doctrine: '换这一家的打法',
  deploy: '让某一家登场',
  terrain: '改一片地形',
  reveal: '点亮一片区域',
  gold: '给某一家金币',
};
const WHEN_KIND_NAME: Record<string, string> = {
  turn: '第 N 次行动',
  unitDied: '某一家的兵死了',
  enter: '有单位走进区域',
  fired: '另一件事已发生',
};

/** 组合节点的名字。下拉里和叶子并列，选它就是"把这个条件换成一个组" */
const WHEN_GROUP_NAME: Record<string, string> = {
  all: '全部满足（且）',
  any: '任一满足（或）',
  not: '取反（不）',
};

export interface LevelEventsOptions {
  level: LevelDef;
  onApply: (level: LevelDef) => void;
  onClose?: () => void;
}

const esc = (t: string) =>
  t.replace(/[&<>"]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : c));

/** 选点/选区时"正在给谁选" */
type PickTarget =
  | { kind: 'zone'; ev: number; slot: 'when' | 'do'; act: number; /** slot 是 when 时：条件树里的路径 */ path?: string }
  | { kind: 'spawn'; ev: number; act: number };

export function openLevelEvents(opts: LevelEventsOptions): void {
  const level = opts.level;
  const w = level.map.w;
  const h = level.map.h;
  const seatCount = level.seats?.count ?? 2;
  const seats = SEAT_ORDER.slice(0, seatCount);
  const hiddenSeats = new Set(level.seats?.hidden ?? []);
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

  /** 这一关可能出现的兵种：全部内置 + 自定义 + 关卡自带。**不按时代过滤** */
  const catalog = { ...UNIT_TYPES, ...(level.units ?? {}) };
  const unitOptions = Object.values(catalog).filter((d) => !isPseudoUnit(d.id));
  const firstCombat = unitOptions.find((d) => d.category === 'combat')?.id ?? unitOptions[0]?.id ?? 'militia';

  let events: LevelEvent[] = structuredClone(level.events ?? []);
  /** 卡片 / 时间轴。时间轴是"看节奏"的视图，改数据仍然在卡片里 */
  let view: 'cards' | 'timeline' = 'cards';
  /** 从时间轴点进来时要高亮哪一张卡 */
  let focusIdx: number | null = null;
  let pick: PickTarget | null = null;
  /** 拖拽中的预览区域（松手就写进事件里） */
  let previewZone: LevelZone | null = null;

  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  mask.innerHTML = `
    <div class="modal wide">
      <div class="modal-head">
        <h2>关卡事件</h2>
        <p>一条事件就是「当…就…」，动作按顺序执行。区域和落点在右边地图上点。</p>
      </div>
      <div class="modal-body">
        <div class="level-events-wrap">
          <div class="level-events-col">
            <div class="level-events-toolbar">
              <button class="chip" data-view="cards">卡片</button>
              <button class="chip" data-view="timeline">时间轴</button>
              <select data-template class="level-mini-select"></select>
              <button class="btn btn-sm" data-act="add-event">加一条事件</button>
              <span class="field-hint" data-summary></span>
            </div>
            <div class="level-events-list" data-list></div>
            <div class="level-issues" data-issues></div>
          </div>
          <div class="level-events-side">
            <div class="level-pick-hint" data-pick-hint>右边这块地图用来选区域 / 点落点。</div>
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
  const issuesEl = q<HTMLDivElement>('[data-issues]');
  const summaryEl = q<HTMLSpanElement>('[data-summary]');
  const canvasEl = q<HTMLDivElement>('[data-canvas]');
  const coordEl = q<HTMLSpanElement>('[data-coord]');
  const pickStateEl = q<HTMLSpanElement>('[data-pick-state]');
  const pickHintEl = q<HTMLDivElement>('[data-pick-hint]');
  const footEl = q<HTMLDivElement>('[data-foot]');
  const templateSel = q<HTMLSelectElement>('[data-template]');

  /* ---------- 默认值与小工具 ---------- */

  const centerZone = (size = 1): LevelZone => ({
    x0: Math.max(0, Math.floor(w / 2) - Math.floor(size / 2)),
    y0: Math.max(0, Math.floor(h / 2) - Math.floor(size / 2)),
    x1: Math.max(0, Math.floor(w / 2) + Math.floor(size / 2)),
    y1: Math.max(0, Math.floor(h / 2) + Math.floor(size / 2)),
  });

  const zoneText = (z: LevelZone): string => {
    const x0 = Math.min(z.x0, z.x1);
    const x1 = Math.max(z.x0, z.x1);
    const y0 = Math.min(z.y0, z.y1);
    const y1 = Math.max(z.y0, z.y1);
    const cells = (x1 - x0 + 1) * (y1 - y0 + 1);
    return `${x0},${y0} → ${x1},${y1}（${cells} 格）`;
  };

  /** 下一个没被占用的 id。**改 id 等于换一件事**，所以只在新事件上生成 */
  const nextId = (): string => {
    const used = new Set(events.map((e) => e.id));
    for (let i = 1; i < 999; i += 1) {
      const id = `e${i}`;
      if (!used.has(id)) return id;
    }
    return `e${Date.now().toString(36)}`;
  };

  const defaultWhen = (kind: LevelWhenLeaf['kind']): LevelWhenLeaf => {
    if (kind === 'unitDied') return { kind: 'unitDied' };
    if (kind === 'enter') return { kind: 'enter', zone: centerZone(2) };
    return { kind: 'turn', at: 5 };
  };

  const defaultDo = (kind: LevelDo['kind']): LevelDo => {
    if (kind === 'spawn') return { kind: 'spawn', owner: seats[1] ?? 'B', units: [] };
    if (kind === 'doctrine') return { kind: 'doctrine', seat: seats[1] ?? 'B', strategy: 'rush' };
    if (kind === 'deploy') {
      const seat = seats.find((s) => hiddenSeats.has(s)) ?? seats[seats.length - 1] ?? 'C';
      return { kind: 'deploy', seat };
    }
    if (kind === 'terrain') return { kind: 'terrain', zone: centerZone(2), to: 'deep' };
    if (kind === 'reveal') return { kind: 'reveal', zone: centerZone(2) };
    if (kind === 'gold') return { kind: 'gold', seat: seats[0] ?? 'A', amount: 100 };
    return { kind: 'say', text: '这一关发生了点事。' };
  };

  const seatOptions = (cur: PlayerId | undefined, allowAny = false): string =>
    `${allowAny ? `<option value="" ${!cur ? 'selected' : ''}>任何一家</option>` : ''}${seats
      .map((s) => `<option value="${s}" ${cur === s ? 'selected' : ''}>${SEAT_NAME[s] ?? s}</option>`)
      .join('')}`;

  const unitOptionsHtml = (cur: string | undefined, allowAny = false): string =>
    `${allowAny ? `<option value="" ${!cur ? 'selected' : ''}>任何兵种</option>` : ''}${unitOptions
      .map((d) => `<option value="${esc(d.id)}" ${cur === d.id ? 'selected' : ''}>${esc(d.name)}</option>`)
      .join('')}`;

  /* ---------- 渲染：卡片 ---------- */

  /*
   * ── 条件树的路径 ──
   *
   * 条件是一棵树，但 DOM 里每个控件都得知道"我改的是哪一个节点"。
   * 用一段字符串路径表示位置：
   *
   *   ''        根（就是 ev.when 本身）
   *   '0'       根这个组里的第 0 个子节点（是 all 还是 any 由父节点决定）
   *   '0.not'   上面那个节点的 not 子节点
   *
   * 只写**下标**，不写 `all`/`any`：父节点只有一个列表，从它身上就能判断。
   * 控件属性统一写成 `{事件序号}:{路径}`。
   */
  const joinPath = (path: string, seg: string): string => (path ? `${path}.${seg}` : seg);

  /** 控件属性统一写成 `事件序号:路径`，这里拆开 */
  const parseKey = (key: string): { i: number; path: string } => {
    const at = key.indexOf(':');
    return at < 0 ? { i: Number(key), path: '' } : { i: Number(key.slice(0, at)), path: key.slice(at + 1) };
  };

  const whenAt = (root: LevelWhen, path: string): LevelWhen | null => {
    let cur: LevelWhen | null = root;
    for (const seg of path.split('.').filter(Boolean)) {
      if (!cur) return null;
      if (seg === 'not') {
        cur = 'not' in cur ? cur.not : null;
        continue;
      }
      const idx = Number(seg);
      const list = 'all' in cur ? cur.all : 'any' in cur ? cur.any : null;
      cur = list && Number.isInteger(idx) ? (list[idx] ?? null) : null;
    }
    return cur;
  };

  /** 把某处换成 `next`（`null` = 删掉）。根不能删 */
  const whenReplace = (ev: LevelEvent, path: string, next: LevelWhen | null): void => {
    if (!path) {
      if (next) ev.when = next;
      return;
    }
    const parts = path.split('.');
    const last = parts.pop()!;
    const parent = whenAt(ev.when, parts.join('.'));
    if (!parent) return;
    if (last === 'not') {
      // `not` 必须有一个子节点：删它没有意义，换才有的说
      if (next && 'not' in parent) parent.not = next;
      return;
    }
    const idx = Number(last);
    const list = 'all' in parent ? parent.all : 'any' in parent ? parent.any : null;
    if (!list || !Number.isInteger(idx)) return;
    if (next) list[idx] = next;
    else if (list.length > 1) list.splice(idx, 1);
  };

  const whenChildren = (node: LevelWhen): { kind: 'all' | 'any' | 'not'; list: LevelWhen[] } | null => {
    if ('all' in node) return { kind: 'all', list: node.all };
    if ('any' in node) return { kind: 'any', list: node.any };
    if ('not' in node) return { kind: 'not', list: [node.not] };
    return null;
  };

  const whenAddChild = (ev: LevelEvent, path: string, what: 'leaf' | 'group'): void => {
    const node = whenAt(ev.when, path);
    if (!node) return;
    const kids = whenChildren(node);
    if (!kids || kids.kind === 'not') return;
    if (what === 'leaf') {
      kids.list.push({ kind: 'turn', at: 5 });
      return;
    }
    // 新加一个"另一种"组：当前是且就加或，反之亦然——最常用的组合就是这两种混着写
    const other: LevelWhen = kids.kind === 'all' ? { any: [{ kind: 'turn', at: 5 }] } : { all: [{ kind: 'turn', at: 5 }] };
    kids.list.push(other);
  };

  /**
   * 条件类型下拉：**叶子和组放在同一个下拉里**。
   *
   * 分成两个下拉的话，"把一个条件换成组"就没有入口了——而这正是写组合条件
   * 的第一步（先换成「全部满足」，再往里加条件）。
   */
  const whenKindSelect = (key: string, current: string): string =>
    `<select class="level-mini-select" data-when-kind="${key}">
       <optgroup label="单个条件">${Object.entries(WHEN_KIND_NAME)
         .map(([k, n]) => `<option value="${k}" ${current === k ? 'selected' : ''}>${esc(n)}</option>`)
         .join('')}</optgroup>
       <optgroup label="改成组合">${Object.entries(WHEN_GROUP_NAME)
         .map(([k, n]) => `<option value="${k}" ${current === k ? 'selected' : ''}>${esc(n)}</option>`)
         .join('')}</optgroup>
     </select>`;

  /** 叶子条件的那一行。`key` 是 `事件序号:路径` */
  function whenLeafRow(node: LevelWhenLeaf, key: string, depth: number, canDelete: boolean): string {
    const kindSel = whenKindSelect(key, node.kind);
    const del = `<button class="btn btn-sm when-del" data-when-del="${key}" ${
      canDelete ? '' : 'disabled title="条件至少要有一条"'
    }>×</button>`;

    if (node.kind === 'turn') {
      // 轮次换算是这块最容易被算错的地方：直接写出来，不让人自己除
      const rounds = seatCount > 0 ? Math.ceil(node.at / seatCount) : node.at;
      const op = node.op ?? '>=';
      const opSel = `<select class="level-mini-select" data-when-op="${key}">${(
        ['>=', '<=', '=', '>', '<'] as const
      )
        .map((o) => `<option value="${o}" ${op === o ? 'selected' : ''}>${o}</option>`)
        .join('')}</select>`;
      return `<div class="when-row" style="--d:${depth}"><span class="when-row-arg">${kindSel} ${opSel}
          <input type="number" min="1" max="999" class="level-mini-num" data-when-at="${key}" value="${node.at}">
          <span class="field-hint">（${seatCount} 家局 ≈ 第 ${rounds} 轮）</span></span>${del}</div>`;
    }
    if (node.kind === 'unitDied') {
      return `<div class="when-row" style="--d:${depth}"><span class="when-row-arg">${kindSel}
          <select class="level-mini-select" data-when-owner="${key}">${seatOptions(node.owner, true)}</select>
          <select class="level-mini-select" data-when-type="${key}">${unitOptionsHtml(node.type, true)}</select>
          死了</span>${del}</div>`;
    }
    if (node.kind === 'enter') {
      return `<div class="when-row" style="--d:${depth}"><span class="when-row-arg">${kindSel}
        <select class="level-mini-select" data-when-owner="${key}">${seatOptions(node.owner, true)}</select>
        的单位走进 <button class="btn btn-sm" data-pick-when-zone="${key}">${esc(zoneText(node.zone))}</button>
      </span>${del}</div>`;
    }
    // fired：从本关其它事件里挑一个，可选"已经发生过几次"
    const others = events.filter((e) => e.id !== events[Number(key.split(':')[0])]?.id);
    const firedSel = `<select class="level-mini-select" data-when-fired="${key}">${
      others.length === 0
        ? '<option value="">（这一关还没有别的事件）</option>'
        : others
            .map((e) => `<option value="${esc(e.id)}" ${node.id === e.id ? 'selected' : ''}>${esc(e.id)}</option>`)
            .join('')
    }</select>`;
    /*
     * 次数：留空＝"发生过就行"（老语义）。填了才按比较符比。
     * 比较符只在填了次数时才有意义，所以下拉放在输入框前面、默认 >=。
     */
    const opSel = `<select class="level-mini-select" data-when-times-op="${key}" title="次数怎么比">${(
      ['>=', '=', '>', '<=', '<'] as const
    )
      .map((o) => `<option value="${o}" ${(node.op ?? '>=') === o ? 'selected' : ''}>${o}</option>`)
      .join('')}</select>`;
    const timesInput = `<input type="number" min="1" max="999" class="level-mini-num" data-when-times="${key}"
        value="${node.times ?? ''}" placeholder="—" title="留空＝只要发生过就算">`;
    return `<div class="when-row" style="--d:${depth}"><span class="when-row-arg">${kindSel} ${firedSel} 已发生
        ${opSel}${timesInput} 次<span class="field-hint">（不填次数＝发生过就行）</span></span>${del}</div>`;
  }

  /** 递归渲染：叶子一行，组是"标题 + 缩进的子节点 + 加按钮" */
  function whenTree(ev: LevelEvent, i: number, node: LevelWhen, path: string, depth: number): string {
    const key = `${i}:${path}`;
    const kids = whenChildren(node);
    if (!kids) {
      return whenLeafRow(node as LevelWhenLeaf, key, depth, path !== '');
    }
    const groupSel = whenKindSelect(key, kids.kind);
    const del = `<button class="btn btn-sm when-del" data-when-del="${key}" ${
      path !== '' ? '' : 'disabled title="根条件不能删，可以改成单个条件"'
    }>×</button>`;
    const children = kids.list
      .map((child, idx) => whenTree(ev, i, child, joinPath(path, kids.kind === 'not' ? 'not' : String(idx)), depth + 1))
      .join('');
    const add =
      kids.kind === 'not'
        ? ''
        : `<div class="when-add" style="--d:${depth + 1}">
             <button class="btn btn-sm" data-when-add="${key}:leaf">+ 条件</button>
             <button class="btn btn-sm" data-when-add="${key}:group">+ ${kids.kind === 'all' ? '或组' : '且组'}</button>
           </div>`;
    return `<div class="when-group" style="--d:${depth}">
        <div class="when-row when-group-head"><span class="when-row-arg">${groupSel}</span>${del}</div>
        <div class="when-children">${children}</div>
        ${add}
      </div>`;
  }

  function whenControls(ev: LevelEvent, i: number): string {
    return `<div class="when-tree">${whenTree(ev, i, ev.when, '', 0)}</div>`;
  }

  function doControls(act: LevelDo, i: number, j: number): string {
    const kindSel = `<select class="level-mini-select" data-do-kind="${i}:${j}">${Object.entries(DO_KIND_NAME)
      .map(([k, n]) => `<option value="${k}" ${act.kind === k ? 'selected' : ''}>${esc(n)}</option>`)
      .join('')}</select>`;

    if (act.kind === 'say') {
      return `${kindSel}<input class="level-say-input" data-say="${i}:${j}" value="${esc(act.text)}" placeholder="战报里会写这一句（双方都看得到）">`;
    }
    if (act.kind === 'spawn') {
      const chips =
        act.units.length === 0
          ? '<span class="level-spawn-empty">还没有落点——点下面的按钮，然后在地图上点位置</span>'
          : act.units
              .map(
                (u, k) =>
                  `<span class="level-spawn-chip">${esc(catalog[u.type]?.short ?? '?')} (${u.x},${u.y})
                     <button data-spawn-del="${i}:${j}:${k}" title="删掉这个落点">×</button></span>`,
              )
              .join('');
      return `${kindSel}
        <span class="level-when-arg">
          <select class="level-mini-select" data-spawn-owner="${i}:${j}">${seatOptions(act.owner)}</select>
          派
          <select class="level-mini-select" data-spawn-type="${i}:${j}">${unitOptionsHtml(
            (act as { lastType?: string }).lastType ?? firstCombat,
          )}</select>
          <button class="btn btn-sm" data-pick-spawn="${i}:${j}">在地图上点位置</button>
        </span>
        <div class="level-spawn-chips">${chips}</div>`;
    }
    if (act.kind === 'doctrine') {
      return `${kindSel}<span class="level-when-arg">
          <select class="level-mini-select" data-doc-seat="${i}:${j}">${seatOptions(act.seat)}</select>
          改成
          <select class="level-mini-select" data-doc-strategy="${i}:${j}">${Object.entries(STRATEGY_NAME)
            .map(([k, n]) => `<option value="${k}" ${act.strategy === k ? 'selected' : ''}>${esc(n)}</option>`)
            .join('')}</select>
        </span>`;
    }
    if (act.kind === 'deploy') {
      const opts = seats.filter((s) => hiddenSeats.has(s));
      if (opts.length === 0) {
        return `${kindSel}<span class="level-spawn-empty">这一关没有「中途登场」的席位（在「席位」面板里设）。</span>`;
      }
      return `${kindSel}<span class="level-when-arg">
          <select class="level-mini-select" data-deploy-seat="${i}:${j}">${opts
            .map((s) => `<option value="${s}" ${act.seat === s ? 'selected' : ''}>${SEAT_NAME[s] ?? s}</option>`)
            .join('')}</select>
          上场（用这一关「摆兵」里给它写好的兵力）
        </span>`;
    }
    if (act.kind === 'reveal') {
      const forever = (act.turns ?? 1) < 0;
      return `${kindSel}<span class="level-when-arg">
          点亮 <button class="btn btn-sm" data-pick-do-zone="${i}:${j}">${esc(zoneText(act.zone))}</button>
          持续 <input type="number" min="1" max="99" class="level-mini-num" data-reveal-turns="${i}:${j}" value="${
            forever ? 1 : act.turns ?? 1
          }" ${forever ? 'disabled' : ''}>
          次行动
          <label class="editor-check"><input type="checkbox" data-reveal-forever="${i}:${j}" ${
            forever ? 'checked' : ''
          }> 一直亮</label>
          <span class="field-hint">（到期重新没入迷雾；1 次 ≈ 亮到下一手）</span>
        </span>`;
    }
    if (act.kind === 'gold') {
      return `${kindSel}<span class="level-when-arg">
          <select class="level-mini-select" data-gold-seat="${i}:${j}">${seatOptions(act.seat)}</select>
          <input type="number" class="level-mini-num" min="-9999" max="9999" data-gold-amount="${i}:${j}" value="${act.amount}">
          金币
          <span class="field-hint">（正数给钱，负数扣钱；扣到 0 为止，不会变负）</span>
        </span>`;
    }
    return `${kindSel}<span class="level-when-arg">
        把 <button class="btn btn-sm" data-pick-do-zone="${i}:${j}">${esc(zoneText(act.zone))}</button>
        改成
        <select class="level-mini-select" data-terr-to="${i}:${j}">${LEVEL_TERRAINS.map(
          (t) => `<option value="${t}" ${act.to === t ? 'selected' : ''}>${esc(CONFIG.terrainName[t] ?? t)}</option>`,
        ).join('')}</select>
        <span class="field-hint">（城和桥改不了；改成<b>深水</b>会把桥冲垮）</span>
      </span>`;
  }

  /** 把一件事压成一行摘要，供时间轴用 */
  function summarize(ev: LevelEvent): { chips: string[]; detail: string } {
    const chips: string[] = [];
    const details: string[] = [];
    for (const act of ev.do) {
      if (act.kind === 'say') chips.push('播报');
      else if (act.kind === 'spawn') {
        chips.push(`刷兵 ${act.units.length}`);
        const where = act.units.slice(0, 3).map((u) => `(${u.x},${u.y})`).join(' ');
        details.push(`落点 ${where}${act.units.length > 3 ? ' …' : ''}`);
      } else if (act.kind === 'reveal') {
        const z = act.zone;
        const n = (Math.abs(z.x1 - z.x0) + 1) * (Math.abs(z.y1 - z.y0) + 1);
        const span = (act.turns ?? 1) < 0 ? '一直亮' : act.turns && act.turns > 1 ? `${act.turns} 次` : '1 次';
        chips.push(`点亮 ${n} 格 · ${span}`);
      } else if (act.kind === 'doctrine') chips.push('换打法');
      else if (act.kind === 'deploy') chips.push(`第 ${act.seat} 家登场`);
      else if (act.kind === 'terrain') {
        // 真数一遍会被改到的格子：只按 `only` 过滤，不猜引擎的兜底（城格/占位）
        let cells = 0;
        const x0 = Math.min(act.zone.x0, act.zone.x1);
        const x1 = Math.max(act.zone.x0, act.zone.x1);
        const y0 = Math.min(act.zone.y0, act.zone.y1);
        const y1 = Math.max(act.zone.y0, act.zone.y1);
        for (let y = y0; y <= y1; y += 1) {
          for (let x = x0; x <= x1; x += 1) {
            if (x < 0 || y < 0 || x >= w || y >= h) continue;
            const t = terrainAt(grid, x, y);
            /*
             * 桥面：只有"改成深水"才会把它冲垮，那才算一格变化。
             * 其余情况下桥面不动（变的是桥下河床），不该报进"改几格"。
             */
            if (t === 'bridge') {
              if (act.to === 'deep' && (!act.only || act.only.length === 0 || act.only.includes('water'))) {
                cells += 1;
              }
              continue;
            }
            if (act.only && act.only.length > 0) {
              // 事件能改的地形是 LEVEL_TERRAINS 的子集，这里的 t 可能更宽（城/虚空），
              // 用 includes 前先确认它在这个子集里
              if (!LEVEL_TERRAINS.includes(t as LevelTerrain) || !act.only.includes(t as LevelTerrain)) continue;
            }
            cells += 1;
          }
        }
        chips.push(`改地形 ${cells} 格`);
        details.push(`改成${CONFIG.terrainName[act.to] ?? act.to}`);
      }
    }
    return { chips, detail: details.join(' · ') };
  }

  function renderTimeline(): void {
    if (events.length === 0) {
      listEl.innerHTML = '<div class="editor-empty">还没有事件，时间轴是空的。</div>';
      return;
    }
    /*
     * 条件可能是组合树（没有 `kind`）。这类归到"看情况触发"那一组——
     * "第几次行动"只对单条件 `turn` 有意义。
     */
    const turnAt = (w: LevelWhen): number | null =>
      'kind' in w && w.kind === 'turn' ? w.at : null;
    const judgeLabel = (w: LevelWhen): [string, string] => {
      if (!('kind' in w)) return ['多条件', '满足组合条件时'];
      if (w.kind === 'unitDied') return ['兵死了', '有人阵亡时'];
      if (w.kind === 'fired') return ['事件已发生', '之前那件事之后'];
      return ['走进区域', '踩到点上时'];
    };
    const withAt = events
      .map((ev, i) => ({ ev, i, at: turnAt(ev.when) }))
      .filter((x) => x.at !== null)
      .sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
    const others = events.map((ev, i) => ({ ev, i })).filter((x) => turnAt(x.ev.when) === null);

    const row = (x: { ev: LevelEvent; i: number }, at: string, sub: string): string => {
      const sum = summarize(x.ev);
      return `<button type="button" class="level-timeline-row" data-jump="${x.i}">
          <span class="level-timeline-at">${at}<i>${sub}</i></span>
          <span class="level-timeline-body">
            <span class="level-timeline-chips">${sum.chips
              .map((c) => `<span class="level-tl-chip">${esc(c)}</span>`)
              .join('')}</span>
            ${sum.detail ? `<span class="level-timeline-detail">${esc(sum.detail)}</span>` : ''}
          </span>
        </button>`;
    };

    listEl.innerHTML = `
      <div class="level-timeline">
        ${
          withAt.length > 0
            ? withAt
                .map((x) =>
                  row(x, `第 ${x.at ?? 0} 次`, `约第 ${Math.ceil((x.at ?? 0) / Math.max(1, seatCount))} 轮`),
                )
                .join('')
            : '<div class="editor-empty">还没有按时机触发的事件。</div>'
        }
        ${
          others.length > 0
            ? `<div class="level-timeline-group">看情况触发</div>${others
                .map((x) =>
                  row(x, ...judgeLabel(x.ev.when)),
                )
                .join('')}`
            : ''
        }
      </div>`;
  }

  function renderList(): void {
    if (view === 'timeline') {
      renderTimeline();
      return;
    }
    if (events.length === 0) {
      listEl.innerHTML =
        '<div class="editor-empty">还没有事件。上面选一个模板开始，或者加一条空的自己填。</div>';
      return;
    }
    listEl.innerHTML = events
      .map(
        (ev, i) => `
      <div class="level-event-card ${focusIdx === i ? 'is-focus' : ''}" data-ev="${i}">
        <div class="level-event-head">
          <span class="level-event-no">${i + 1}</span>
          <span class="level-event-when">当 ${whenControls(ev, i)}</span>
          <button class="btn btn-sm level-event-del" data-ev-del="${i}">删除</button>
        </div>
        ${
          'kind' in ev.when && ev.when.kind === 'enter'
            ? `<label class="editor-check level-event-repeat"><input type="checkbox" data-repeat="${i}" ${
                ev.repeat ? 'checked' : ''
              }> 每次走进都触发（不勾＝只触发一次）</label>`
            : ''
        }
        <div class="level-event-dos">
          ${ev.do
            .map(
              (act, j) => `<div class="level-do-row">
                <span class="level-do-no">${j + 1}</span>
                ${doControls(act, i, j)}
                <button class="btn btn-sm" data-do-del="${i}:${j}" title="删掉这个动作">×</button>
              </div>`,
            )
            .join('')}
        </div>
        <div class="level-event-foot">
          <select class="level-mini-select" data-do-add-kind="${i}">${Object.entries(DO_KIND_NAME)
            .map(([k, n]) => `<option value="${k}">${esc(n)}</option>`)
            .join('')}</select>
          <button class="btn btn-sm" data-do-add="${i}">再做一个动作</button>
          <span class="field-hint">id ${esc(ev.id)}</span>
        </div>
      </div>`,
      )
      .join('');
  }

  function renderSummary(): void {
    const turns = events
      .map((e) => ('kind' in e.when && e.when.kind === 'turn' ? e.when.at : null))
      .filter((n): n is number => n !== null);
    const early = turns.length > 0 ? Math.min(...turns) : null;
    const late = turns.length > 0 ? Math.max(...turns) : null;
    summaryEl.textContent =
      events.length === 0
        ? '还没有事件'
        : `共 ${events.length} 条${early !== null ? ` · 最早第 ${early} 次、最晚第 ${late} 次行动` : ''}`;
  }

  /* ---------- 渲染：地图（选区 / 落点） ---------- */

  /** 当前该高亮哪一片：拖拽中优先，其次是这次选点要改的那一块 */
  const activeZone = (): LevelZone | null => {
    if (previewZone) return previewZone;
    if (!pick) return null;
    if (pick.kind === 'zone') {
      const ev = events[pick.ev];
      if (!ev) return null;
      if (pick.slot === 'when') {
        const node = whenAt(ev.when, pick.path ?? '');
        return node && 'kind' in node && node.kind === 'enter' ? node.zone : null;
      }
      const act = ev.do[pick.act];
      return act && (act.kind === 'terrain' || act.kind === 'reveal') ? act.zone : null;
    }
    return null;
  };

  function renderMap(): void {
    const zone = activeZone();
    const inZone = (x: number, y: number): boolean =>
      !!zone && x >= Math.min(zone.x0, zone.x1) && x <= Math.max(zone.x0, zone.x1) && y >= Math.min(zone.y0, zone.y1) && y <= Math.max(zone.y0, zone.y1);

    renderLevelGrid(canvasEl, {
      w,
      h,
      grid,
      cityAt,
      cityLabel: (hit) => hit.seat,
      extraClass: (x, y) => (inZone(x, y) ? 'is-selected' : ''),
      overlay: (x, y) => {
        // 刷兵落点标出来，作者一眼能看到"兵会落在哪"
        const marks: string[] = [];
        for (const ev of events) {
          for (const act of ev.do) {
            if (act.kind !== 'spawn') continue;
            for (const u of act.units) {
              if (u.x === x && u.y === y) marks.push(`<span class="lv-spawn-dot">${esc(catalog[u.type]?.short ?? '?')}</span>`);
            }
          }
        }
        return marks.join('');
      },
    });
    pickStateEl.textContent = pick ? (pick.kind === 'zone' ? '正在框选区域…' : '正在点落点…') : '';
  }

  /** 两个视图按钮谁高亮——统一在这儿刷，别在模板字符串里算（那里 view 的类型会被收窄） */
  const syncViewChips = (): void => {
    mask.querySelectorAll<HTMLElement>('[data-view]').forEach((el) => {
      el.classList.toggle('active', el.dataset.view === view);
    });
  };

  function renderAll(): void {
    renderList();
    renderSummary();
    renderMap();
    syncViewChips();
  }

  /* ---------- 校验（表单这一层） ---------- */

  function problems(): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const allIds = new Set(events.map((e) => e.id));
    const refsOf = (w: LevelWhen): string[] => {
      if ('all' in w) return w.all.flatMap(refsOf);
      if ('any' in w) return w.any.flatMap(refsOf);
      if ('not' in w) return refsOf(w.not);
      return w.kind === 'fired' ? [w.id] : [];
    };
    for (const [i, ev] of events.entries()) {
      const tag = `第 ${i + 1} 条`;
      if (seen.has(ev.id)) out.push(`${tag}：事件 id「${ev.id}」重复了，触发记录会分不清`);
      seen.add(ev.id);
      for (const ref of refsOf(ev.when)) {
        if (!allIds.has(ref)) out.push(`${tag}：条件引用了不存在的「${ref}」，这个条件永远不会成立`);
      }

      if ('kind' in ev.when) {
        if (ev.when.kind === 'turn' && (!Number.isFinite(ev.when.at) || ev.when.at < 1)) {
          out.push(`${tag}：触发时机要是大于 0 的行动序号`);
        }
        if (ev.when.kind === 'enter' && outOfBounds(ev.when.zone)) {
          out.push(`${tag}：进入区域整块在地图外，永远不会触发`);
        }
      }
      if (ev.do.length === 0) out.push(`${tag}：一个动作都没有`);
      for (const [j, act] of ev.do.entries()) {
        const at = `${tag} 第 ${j + 1} 个动作`;
        if (act.kind === 'say' && act.text.trim().length === 0) {
          out.push(`${at}：播报是空的（玩家会看到一行空白）`);
        }
        if (act.kind === 'terrain') {
          if (!LEVEL_TERRAINS.includes(act.to)) out.push(`${at}：改成「${act.to}」不被允许（桥/城/虚空改不了）`);
          if (outOfBounds(act.zone)) out.push(`${at}：区域整块在地图外，改了也没有效果`);
        }
        if (act.kind === 'reveal' && outOfBounds(act.zone)) {
          out.push(`${at}：点亮区域整块在地图外，点了也没有效果`);
        }
        if (act.kind === 'spawn') {
          if (act.units.length === 0) out.push(`${at}：刷兵没有落点（至少在地图上点一个位置）`);
          for (const u of act.units) {
            if (!catalog[u.type]) out.push(`${at}：兵种「${u.type}」在这一局不存在`);
            if (outOfBounds({ x0: u.x, y0: u.y, x1: u.x, y1: u.y })) {
              out.push(`${at}：落点 (${u.x},${u.y}) 在棋盘外`);
            } else {
              // 站不住会"就近找位"（引擎的规定），所以只提醒，不当成不能存
              const st = standState(catalog[u.type], terrainAt(grid, u.x, u.y));
              if (st === 'bad') {
                out.push(`${at}：(${u.x},${u.y}) 是${CONFIG.terrainName[terrainAt(grid, u.x, u.y)]}，这个兵种站不住，会被挤到旁边`);
              }
            }
          }
        }
        if (act.kind === 'deploy' && !hiddenSeats.has(act.seat)) {
          out.push(`${at}：「${SEAT_NAME[act.seat] ?? act.seat}」不是中途登场的席位，这个动作不会有效果`);
        }
      }
    }
    return out;
  }

  function outOfBounds(z: LevelZone): boolean {
    const x0 = Math.min(z.x0, z.x1);
    const x1 = Math.max(z.x0, z.x1);
    const y0 = Math.min(z.y0, z.y1);
    const y1 = Math.max(z.y0, z.y1);
    return x1 < 0 || y1 < 0 || x0 >= w || y0 >= h;
  }

  const renderIssues = (list: string[]): void => {
    issuesEl.innerHTML =
      list.length === 0
        ? ''
        : list.map((t) => `<div class="level-issue is-error"><b>还不能存</b>${esc(t)}</div>`).join('');
  };

  /* ---------- 交互：地图 ---------- */

  /*
   * 刷兵选点：点一格加一个兵。
   * 框选区域交给共用的 `bindZoneDrag`——它和胜负条件里的护送区是同一件事，
   * 各写一份迟早会出现"事件里能拖、胜负里拖不动"这种鬼问题。
   */
  canvasEl.addEventListener('pointerdown', (ev) => {
    if (pick?.kind !== 'spawn') return;
    const cell = cellFromEvent(ev, canvasEl);
    if (!cell) return;
    ev.preventDefault();
    const ev0 = events[pick.ev];
    const act = ev0?.do[pick.act];
    if (!act || act.kind !== 'spawn') return;
    const def = catalog[(act as { lastType?: string }).lastType ?? firstCombat];
    if (!def) return;
    act.units = [...act.units, { type: def.id, x: cell.x, y: cell.y }];
    renderAll();
    footEl.textContent = `落点 (${cell.x}, ${cell.y}) 已加。继续点，或者再点一次「在地图上点位置」结束。`;
  });

  canvasEl.addEventListener('pointermove', (ev) => {
    const cell = cellFromEvent(ev, canvasEl);
    if (cell) coordEl.textContent = `第 ${cell.x}, ${cell.y} 格`;
  });

  bindZoneDrag(canvasEl, {
    enabled: () => pick?.kind === 'zone',
    onUpdate: (z) => {
      previewZone = z;
      renderMap();
    },
    onCommit: (zone) => {
      if (!pick || pick.kind !== 'zone') return;
      const ev0 = events[pick.ev];
      if (ev0) {
        if (pick.slot === 'when') {
          const node = whenAt(ev0.when, pick.path ?? '');
          if (node && 'kind' in node && node.kind === 'enter') node.zone = zone;
        }
        const act = ev0.do[pick.act];
        if (pick.slot === 'do' && act && (act.kind === 'terrain' || act.kind === 'reveal')) act.zone = zone;
      }
      previewZone = null;
      pick = null;
      renderAll();
      footEl.textContent = '区域改好了。';
    },
  });

  /* ---------- 交互：按钮与表单 ---------- */

  mask.addEventListener('input', (ev) => {
    const el = ev.target as HTMLElement;
    const say = el.getAttribute('data-say');
    if (say) {
      const [i, j] = say.split(':').map(Number);
      const act = events[i!]?.do[j!];
      if (act && act.kind === 'say') act.text = (el as HTMLInputElement).value;
      return;
    }
    const rvTurns = el.getAttribute('data-reveal-turns');
    if (rvTurns) {
      const [i, j] = rvTurns.split(':').map(Number);
      const act = events[i!]?.do[j!];
      if (act && act.kind === 'reveal') {
        const n = Math.max(1, Math.min(99, Math.round(Number((el as HTMLInputElement).value) || 1)));
        // 1 是默认值，不写进 JSON（少一个字段少一句要解释的话）
        if (n === 1) delete act.turns;
        else act.turns = n;
      }
      return;
    }
    const times = el.getAttribute('data-when-times');
    if (times) {
      const key = parseKey(times);
      const node = events[key.i] ? whenAt(events[key.i]!.when, key.path) : null;
      if (node && 'kind' in node && node.kind === 'fired') {
        const raw = (el as HTMLInputElement).value.trim();
        if (!raw) {
          // 清空＝回到"发生过就行"，顺手把比较符也删掉（留着是死字段）
          delete node.times;
          delete node.op;
        } else {
          node.times = Math.max(1, Math.min(999, Math.round(Number(raw) || 1)));
        }
      }
      return;
    }
    const at = el.getAttribute('data-when-at');
    if (at) {
      const key = parseKey(at);
      const node = events[key.i] ? whenAt(events[key.i]!.when, key.path) : null;
      if (node && 'kind' in node && node.kind === 'turn') {
        node.at = Math.max(1, Math.round(Number((el as HTMLInputElement).value) || 1));
      }
    }
  });

  mask.addEventListener('change', (ev) => {
    const el = ev.target as HTMLElement;
    const val = (el as HTMLInputElement | HTMLSelectElement).value;

    const whenKind = el.getAttribute('data-when-kind');
    if (whenKind !== null) {
      /*
       * 换类型 = 把这一处**整个替换**成新节点：叶子换叶子就是换 kind，
       * 换成组就是包一层（里面放一个默认叶子）。原来写的是 `ev0.when = ...`，
       * 现在要精准落到树上某一处，所以走 `whenReplace`。
       */
      const key = parseKey(whenKind);
      const ev0 = events[key.i];
      if (ev0) {
        const next: LevelWhen | null =
          val === 'all'
            ? { all: [{ kind: 'turn', at: 5 }] }
            : val === 'any'
              ? { any: [{ kind: 'turn', at: 5 }] }
              : val === 'not'
                ? { not: { kind: 'turn', at: 5 } }
                : defaultWhen(val as LevelWhenLeaf['kind']);
        if (next) whenReplace(ev0, key.path, next);
      }
      renderAll();
      return;
    }
    const whenOwner = el.getAttribute('data-when-owner');
    if (whenOwner !== null) {
      const key = parseKey(whenOwner);
      const node = events[key.i] ? whenAt(events[key.i]!.when, key.path) : null;
      if (node && 'kind' in node && (node.kind === 'unitDied' || node.kind === 'enter')) {
        node.owner = (val || undefined) as PlayerId | undefined;
      }
      renderList();
      return;
    }
    const whenType = el.getAttribute('data-when-type');
    if (whenType !== null) {
      const key = parseKey(whenType);
      const node = events[key.i] ? whenAt(events[key.i]!.when, key.path) : null;
      if (node && 'kind' in node && node.kind === 'unitDied') node.type = val || undefined;
      return;
    }
    const whenOp = el.getAttribute('data-when-op');
    if (whenOp !== null) {
      const key = parseKey(whenOp);
      const node = events[key.i] ? whenAt(events[key.i]!.when, key.path) : null;
      if (node && 'kind' in node && node.kind === 'turn') {
        // 默认值 `>=` 不写进数据：少一个字段少一句要解释的话
        if (val === '>=') delete node.op;
        else node.op = val as '>=' | '<=' | '=' | '>' | '<';
      }
      renderList();
      return;
    }
    const whenFired = el.getAttribute('data-when-fired');
    if (whenFired !== null) {
      const key = parseKey(whenFired);
      const node = events[key.i] ? whenAt(events[key.i]!.when, key.path) : null;
      if (node && 'kind' in node && node.kind === 'fired' && val) node.id = val;
      return;
    }
    const timesOp = el.getAttribute('data-when-times-op');
    if (timesOp !== null) {
      const key = parseKey(timesOp);
      const node = events[key.i] ? whenAt(events[key.i]!.when, key.path) : null;
      if (node && 'kind' in node && node.kind === 'fired' && node.times !== undefined) {
        if (val === '>=') delete node.op;
        else node.op = val as '>=' | '<=' | '=' | '>' | '<';
      }
      renderList();
      return;
    }
    const doKind = el.getAttribute('data-do-kind');
    if (doKind) {
      const [i, j] = doKind.split(':').map(Number);
      const target = events[i!]?.do[j!];
      if (target) events[i!]!.do[j!] = defaultDo(val as LevelDo['kind']);
      renderAll();
      return;
    }
    const spawnOwner = el.getAttribute('data-spawn-owner');
    if (spawnOwner) {
      const [i, j] = spawnOwner.split(':').map(Number);
      const act = events[i!]?.do[j!];
      if (act && act.kind === 'spawn') act.owner = val as PlayerId;
      return;
    }
    const spawnType = el.getAttribute('data-spawn-type');
    if (spawnType) {
      const [i, j] = spawnType.split(':').map(Number);
      const act = events[i!]?.do[j!];
      // 记在动作上，但不写进 JSON：这是"下一个点要放什么"的界面状态
      if (act && act.kind === 'spawn') (act as { lastType?: string }).lastType = val;
      return;
    }
    const goldSeat = el.getAttribute('data-gold-seat');
    if (goldSeat) {
      const [i, j] = goldSeat.split(':').map(Number);
      const act = events[i!]?.do[j!];
      if (act && act.kind === 'gold') act.seat = val as PlayerId;
      return;
    }
    const goldAmount = el.getAttribute('data-gold-amount');
    if (goldAmount) {
      const [i, j] = goldAmount.split(':').map(Number);
      const act = events[i!]?.do[j!];
      if (act && act.kind === 'gold') {
        // 0 没有意义（等于什么都没做），退到 ±1
        const n = Math.round(Number(val) || 0);
        act.amount = n === 0 ? 1 : Math.max(-9999, Math.min(9999, n));
      }
      return;
    }
    const docSeat = el.getAttribute('data-doc-seat');
    if (docSeat) {
      const [i, j] = docSeat.split(':').map(Number);
      const act = events[i!]?.do[j!];
      if (act && act.kind === 'doctrine') act.seat = val as PlayerId;
      return;
    }
    const docStrategy = el.getAttribute('data-doc-strategy');
    if (docStrategy) {
      const [i, j] = docStrategy.split(':').map(Number);
      const act = events[i!]?.do[j!];
      if (act && act.kind === 'doctrine') act.strategy = val as 'auto' | 'rush' | 'boom' | 'hold';
      return;
    }
    const deploySeat = el.getAttribute('data-deploy-seat');
    if (deploySeat) {
      const [i, j] = deploySeat.split(':').map(Number);
      const act = events[i!]?.do[j!];
      if (act && act.kind === 'deploy') act.seat = val as PlayerId;
      return;
    }
    const terrTo = el.getAttribute('data-terr-to');
    if (terrTo) {
      const [i, j] = terrTo.split(':').map(Number);
      const act = events[i!]?.do[j!];
      if (act && act.kind === 'terrain') act.to = val as LevelTerrain;
      return;
    }
    const forever = el.getAttribute('data-reveal-forever');
    if (forever) {
      const [i, j] = forever.split(':').map(Number);
      const act = events[i!]?.do[j!];
      if (act && act.kind === 'reveal') {
        if ((el as HTMLInputElement).checked) act.turns = -1;
        else delete act.turns;
      }
      renderList();
      return;
    }
    const repeat = el.getAttribute('data-repeat');
    if (repeat !== null) {
      const ev0 = events[Number(repeat)];
      if (ev0) ev0.repeat = (el as HTMLInputElement).checked;
    }
  });

  mask.addEventListener('click', (ev) => {
    const t = ev.target as HTMLElement;

    // 选区域 / 点落点：进入待选模式，提示作者去右边地图上操作
    const pickWhenZone = t.closest<HTMLElement>('[data-pick-when-zone]');
    if (pickWhenZone) {
      const key = parseKey(pickWhenZone.dataset.pickWhenZone ?? '');
      pick = { kind: 'zone', ev: key.i, slot: 'when', act: -1, path: key.path };
      pickHintEl.textContent = '在下面的地图上拖一个矩形 → 松手就定区域。';
      renderMap();
      return;
    }
    const pickDoZone = t.closest<HTMLElement>('[data-pick-do-zone]');
    if (pickDoZone) {
      const [i, j] = (pickDoZone.dataset.pickDoZone ?? '').split(':').map(Number);
      pick = { kind: 'zone', ev: i!, slot: 'do', act: j! };
      pickHintEl.textContent = '在下面的地图上拖一个矩形 → 松手就定区域。';
      renderMap();
      return;
    }
    const pickSpawn = t.closest<HTMLElement>('[data-pick-spawn]');
    if (pickSpawn) {
      const [i, j] = (pickSpawn.dataset.pickSpawn ?? '').split(':').map(Number);
      pick = { kind: 'spawn', ev: i!, act: j! };
      pickHintEl.textContent = '在地图上点位置，点一次加一个兵；再点一次这个按钮结束。';
      renderMap();
      return;
    }

    const spawnDel = t.closest<HTMLElement>('[data-spawn-del]');
    if (spawnDel) {
      const [i, j, k] = (spawnDel.dataset.spawnDel ?? '').split(':').map(Number);
      const act = events[i!]?.do[j!];
      if (act && act.kind === 'spawn') act.units = act.units.filter((_u, idx) => idx !== k);
      renderAll();
      return;
    }

    const whenDel = t.closest<HTMLElement>('[data-when-del]');
    if (whenDel) {
      const key = parseKey(whenDel.dataset.whenDel ?? '');
      const ev0 = events[key.i];
      // 根不能删：删了这条事件就没有条件了。按钮那边也是 disabled 的
      if (ev0 && key.path) whenReplace(ev0, key.path, null);
      renderAll();
      return;
    }
    const whenAdd = t.closest<HTMLElement>('[data-when-add]');
    if (whenAdd) {
      const raw = whenAdd.dataset.whenAdd ?? '';
      const cut = raw.lastIndexOf(':');
      const key = parseKey(raw.slice(0, cut));
      const what = raw.slice(cut + 1) as 'leaf' | 'group';
      const ev0 = events[key.i];
      if (ev0) whenAddChild(ev0, key.path, what);
      renderAll();
      return;
    }

    const evDel = t.closest<HTMLElement>('[data-ev-del]');
    if (evDel) {
      events = events.filter((_e, idx) => idx !== Number(evDel.dataset.evDel));
      pick = null;
      renderAll();
      return;
    }
    const doDel = t.closest<HTMLElement>('[data-do-del]');
    if (doDel) {
      const [i, j] = (doDel.dataset.doDel ?? '').split(':').map(Number);
      const ev0 = events[i!];
      if (ev0) ev0.do = ev0.do.filter((_a, idx) => idx !== j);
      renderAll();
      return;
    }
    const doAdd = t.closest<HTMLElement>('[data-do-add]');
    if (doAdd) {
      const i = Number(doAdd.dataset.doAdd);
      const sel = mask.querySelector<HTMLSelectElement>(`[data-do-add-kind="${i}"]`);
      const ev0 = events[i];
      if (ev0 && sel) ev0.do = [...ev0.do, defaultDo(sel.value as LevelDo['kind'])];
      renderAll();
      return;
    }

    const viewBtn = t.closest<HTMLElement>('[data-view]');
    if (viewBtn) {
      view = viewBtn.dataset.view === 'timeline' ? 'timeline' : 'cards';
      focusIdx = null;
      renderList();
      syncViewChips();
      return;
    }
    const jump = t.closest<HTMLElement>('[data-jump]');
    if (jump) {
      focusIdx = Number(jump.dataset.jump);
      view = 'cards';
      renderList();
      syncViewChips();
      // 滚到那一张卡：列表是内滚动的，不滚的话点完像没反应
      const card = listEl.querySelector<HTMLElement>(`[data-ev="${focusIdx}"]`);
      card?.scrollIntoView?.({ block: 'nearest' });
      return;
    }

    const act = t.closest<HTMLElement>('[data-act]')?.dataset.act;
    if (act === 'add-event') {
      events = [...events, { id: nextId(), when: defaultWhen('turn'), do: [defaultDo('say')] }];
      renderAll();
      return;
    }
    if (act === 'cancel') {
      mask.remove();
      opts.onClose?.();
      return;
    }
    if (act === 'apply') {
      const list = problems();
      if (list.length > 0) {
        renderIssues(list);
        footEl.textContent = `还有 ${list.length} 处不能存，先改完。`;
        return;
      }
      const next: LevelDef = { ...level };
      // 把界面上的临时字段（lastType）剥掉，别让它跟着 JSON 走
      const cleaned = events.map((e) => ({
        ...e,
        do: e.do.map((a) => {
          if (a.kind !== 'spawn') return a;
          const { lastType: _drop, ...rest } = a as typeof a & { lastType?: string };
          return rest as LevelDo;
        }),
      }));
      if (cleaned.length > 0) next.events = cleaned;
      else delete (next as { events?: unknown }).events;
      opts.onApply(next);
      mask.remove();
      toast('事件已更新，别忘了点「保存到我的关卡」');
    }
  });

  /* ---------- 模板 ---------- */

  const templates: Array<{ id: string; name: string; build: () => LevelEvent }> = [
    {
      id: 'bridge',
      name: '炸桥 / 塌方',
      build: () => ({
        id: '',
        when: { kind: 'turn', at: 10 },
        do: [
          { kind: 'say', text: '桥被炸断了。' },
          { kind: 'terrain', zone: centerZone(2), to: 'deep' },
        ],
      }),
    },
    {
      id: 'reinforce',
      name: '边缘援军',
      build: () => ({
        id: '',
        when: { kind: 'turn', at: 8 },
        // 落点默认给地图**边缘**：直接刷在玩家腹地，玩家的第一反应是"AI 在耍赖"
        do: [
          { kind: 'say', text: '远处来了援军。' },
          { kind: 'spawn', owner: seats[1] ?? 'B', units: [{ type: firstCombat, x: 0, y: 0 }] },
        ],
      }),
    },
    {
      id: 'latecomer',
      name: '第三方中途登场',
      build: () => ({
        id: '',
        when: { kind: 'turn', at: 8 },
        do: [
          { kind: 'say', text: '第三方进场了。' },
          { kind: 'deploy', seat: seats.find((s) => hiddenSeats.has(s)) ?? seats[seats.length - 1] ?? 'C' },
        ],
      }),
    },
    {
      id: 'doctrine',
      name: '换这一家的打法',
      build: () => ({
        id: '',
        when: { kind: 'turn', at: 6 },
        do: [{ kind: 'doctrine', seat: seats[1] ?? 'B', strategy: 'rush' }],
      }),
    },
    {
      id: 'collapse',
      name: '定时塌方（只改平原）',
      build: () => ({
        id: '',
        when: { kind: 'turn', at: 12 },
        do: [
          { kind: 'say', text: '地面塌了一片。' },
          { kind: 'terrain', zone: centerZone(2), to: 'water', only: ['plain'] },
        ],
      }),
    },
  ];

  templateSel.innerHTML =
    '<option value="">从模板开始…</option>' +
    templates.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join('');

  templateSel.addEventListener('change', () => {
    const tpl = templates.find((t) => t.id === templateSel.value);
    if (!tpl) return;
    const ev0 = tpl.build();
    ev0.id = nextId();
    events = [...events, ev0];
    templateSel.value = '';
    renderAll();
    footEl.textContent = `已加入「${tpl.name}」。数字和区域按你这一关的情况改。`;
  });

  renderAll();
  document.body.appendChild(mask);
  if (events.length === 0) {
    footEl.textContent = '这一关还没有事件。先从上面选一个模板，或者加一条空的。';
  }
}
