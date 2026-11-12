/**
 * 星图视图：把 `star-layout` 算出来的节点和连线画成"一张特殊的棋盘"。
 *
 * ── 它为什么不是 `s.boards` 里的一张图 ────────────────────
 *
 * 星图描述的是"图与图之间的关系"，把它塞进 `boards` 会自指：`boardIds()`
 * 多出一项、面板又把星图列进去，发射井的 `lanesFrom(nodeOf(silo))` 也会
 * 认为"我站在星图这张图上"。所以这里只借棋盘**长得像**的那部分
 * （正方网格、格子坐标），不复用 `renderBoard` 的数据管线。
 *
 * 规则层完全不知道这个文件存在。
 */

import type { PlayerId } from '../core/types.ts';
import type { PlayerView } from '../core/fog.ts';
import { boardIdOf } from '../core/board.ts';
import { starLayout } from './star-layout.ts';

export interface StarSelection {
  kind: 'node' | 'lane';
  id: string;
}

function esc(t: string): string {
  return t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

/**
 * 画一次星图。
 *
 * 每帧重画整块也可以接受（节点就几个），但仍然用签名挡一下：
 * 棋盘那边的渲染是每帧调用的，星图跟着抖没有意义。
 */
export function renderStarMap(
  el: HTMLElement,
  view: PlayerView,
  me: PlayerId,
  sel: StarSelection | null,
): void {
  const s = view.state;
  const lay = starLayout(s);

  if (!lay) {
    if (el.dataset.sig !== 'none') {
      el.dataset.sig = 'none';
      el.innerHTML = '';
    }
    return;
  }

  const readyOn = (board?: string): number => {
    if (!board) return 0;
    return s.units.filter(
      (u) => u.owner === me && boardIdOf(u) === board && !u.acted &&
        s.unitTypes[u.type]?.category !== 'building',
    ).length;
  };
  const contactOn = (board?: string): boolean => {
    if (!board) return false;
    return s.units.some((u) => u.owner !== me && boardIdOf(u) === board);
  };
  const tripsOn = (id: string): number =>
    (s.transit ?? []).filter((t) => t.to === id).length;

  const sig = [
    lay.size,
    `${sel?.kind ?? ''}:${sel?.id ?? ''}`,
    ...lay.nodes.map(
      (n) => `${n.id}/${n.x},${n.y}/${n.stations.length}/${readyOn(n.board)}/${contactOn(n.board) ? 1 : 0}/${tripsOn(n.id)}`,
    ),
    ...lay.lanes.map((l) => `${l.id}/${l.turns}`),
  ].join('|');
  if (el.dataset.sig === sig) return;
  el.dataset.sig = sig;

  /*
   * 航线分两层：
   *   · SVG 那根线只负责**好看**（pointer-events: none）；
   *   · 点击交给一根**普通 DOM 的透明长条**（`.sm-lane-tap`），
   *     用百分比 + rotate 铺在两点之间。
   *
   * 为什么不给 `<line>` 挂 pointer-events：上一版就是这么写的，
   * 实机上点不到——SVG 根上的 `pointer-events: none` 靠子元素覆盖这条路
   * 依赖继承与命中的细节，改一次错一次。普通按钮的命中是浏览器最基础的能力，
   * 没有这种不确定性；顺带还能有 hover 和键盘焦点。
   */
  const size = lay.size;
  const lines = lay.lanes
    .map((l) => {
      const on = sel?.kind === 'lane' && sel.id === l.id;
      const x1 = l.a.x + 0.5;
      const y1 = l.a.y + 0.5;
      const x2 = l.b.x + 0.5;
      const y2 = l.b.y + 0.5;
      const geom = `x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"`;
      return `<g class="sm-lane${on ? ' on' : ''}"><line class="sm-lane-line" ${geom}></line></g>`;
    })
    .join('');

  // 命中条：从 a 的中心拉到 b 的中心，宽度 = 两点距离（百分比），再旋转
  const taps = lay.lanes
    .map((l) => {
      const on = sel?.kind === 'lane' && sel.id === l.id;
      const x1 = ((l.a.x + 0.5) / size) * 100;
      const y1 = ((l.a.y + 0.5) / size) * 100;
      const dx = l.b.x - l.a.x;
      const dy = l.b.y - l.a.y;
      const len = (Math.hypot(dx, dy) / size) * 100;
      const deg = (Math.atan2(dy, dx) * 180) / Math.PI;
      return (
        `<button class="sm-lane-tap${on ? ' on' : ''}"` +
        ` data-act="star-lane" data-id="${esc(l.id)}"` +
        ` aria-label="${esc(`${l.a.name} 到 ${l.b.name} 的航线`)}"` +
        ` style="left:${x1}%;top:${y1}%;width:${len}%;transform:rotate(${deg}deg)"></button>`
      );
    })
    .join('');

  const cells = lay.nodes
    .map((n) => {
      const on = sel?.kind === 'node' && sel.id === n.id;
      const ready = readyOn(n.board);
      const contact = contactOn(n.board);
      const trips = tripsOn(n.id);
      const title = n.board
        ? `${n.name}：左键查看，右侧面板可以前往`
        : `${n.name}：还没有能落脚的地方`;
      return (
        `<button class="sm-node${on ? ' on' : ''}${n.board ? '' : ' bare'}"` +
        ` data-act="star-node" data-id="${esc(n.id)}"` +
        ` style="grid-column:${n.x + 1};grid-row:${n.y + 1}"` +
        ` title="${esc(title)}">` +
        `<span class="sm-node-name">${esc(n.name)}</span>` +
        (ready > 0 ? `<span class="sm-ready" title="待命部队">${ready}</span>` : '') +
        (contact ? '<i class="sm-contact" title="这里有敌人"></i>' : '') +
        (trips > 0 ? `<span class="sm-trip" title="有东西正在飞来">${trips}</span>` : '') +
        (n.stations.length > 0
          ? `<span class="sm-stations" title="轨道上停泊 ${n.stations.length} 座空间站">${n.stations.length}</span>`
          : '') +
        `</button>`
      );
    })
    .join('');

  // 背景格：只是给"棋盘"一个骨架，不接点击、不放东西。
  // 用 DOM 而不是 CSS 渐变画网格线——渐变里的百分比和格宽对不齐，
  // 25~81 个空 div 的开销可以忽略。
  const backdrop = Array.from(
    { length: lay.size * lay.size },
    () => '<div class="sm-cell"></div>',
  ).join('');

  el.innerHTML =
    `<div class="sm-sheet">` +
    `<div class="sm-head">` +
    `<span class="sm-title">星图</span>` +
    `<span class="sm-hint">点星球看信息 · 点航线看航程</span>` +
    `<button class="sm-close" data-act="star-close">关闭</button>` +
    `</div>` +
    `<div class="sm-grid" style="--sm:${lay.size}">` +
    `<svg class="sm-lanes" viewBox="0 0 ${lay.size} ${lay.size}" preserveAspectRatio="none">${lines}</svg>` +
    backdrop +
    taps +
    cells +
    `</div>` +
    `</div>`;
}
