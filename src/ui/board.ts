/**
 * 棋盘渲染。
 *
 * 三层结构：格子 → 城市方块 → 棋子。
 * 城市是 2×2 的独立实体，单独占一层，这样血条能横跨四格而不被格子边界切断。
 *
 * **格子层是增量的，另外两层整块重写。**
 *
 * 12×12 那会儿整层重建确实更快也更不容易出 bug，但 32×32 是 1 024 个格子：
 * 每帧丢掉重建 1 024 个 div、再让浏览器重算 1 024 格的样式和布局，
 * 实测吃掉单帧的九成。而格子的"身世"其实一辈子只定两次——位置（x, y）整局不变，
 * 地形开局定一次，之后每帧真正会变的只有高亮档（可达 / 可攻击 / 威胁 / 可放置）。
 * 所以格子节点留着复用，只改变化那几格的 `className`。
 *
 * 城市和棋子照旧整块重写：它们加起来才几十个节点，按 id 做 diff 省下的时间
 * 还不够赔 bug 的风险。唯一的例外是内容没变时干脆不写（见 `paintLayer`）。
 *
 * 棋子移动用 FLIP 补间让位移"滑过去"而不是瞬间跳。位移量从格坐标直接算，
 * 不问浏览器要矩形——写完一大块 DOM 再读 `getBoundingClientRect`，
 * 在真机上等于把整套布局同步重算一遍，比动画本身贵得多。
 */

import type { PlayerView } from '../core/fog.ts';
import { buildProgress, cityName, footprintOf, isAirborne, underConstruction, utype } from '../core/rules.ts';
import type { GameState, Unit } from '../core/types.ts';

export interface BoardUi {
  selectedId: string | null;
  /** 可达格索引 */
  reach: number[];
  /** 可攻击的敌方单位 id */
  targets: string[];
  /** 可攻城的城市 id */
  siegeTargets: string[];
  /** 当前选中的城市 id */
  selectedCityId: string | null;
  /** 处于野外建造模式时，可以放置建筑的空格 */
  placeable: number[];
  /** 威胁范围：移动之后能打到哪些格 */
  threat: number[];
  /**
   * 这一步实际走的路线（单位 id → 格子串），只用来画移动动画。
   *
   * 不给也能用：退化成"起点直线滑到终点"。给了就沿路线拐弯，
   * 绕着河走、绕过友军的时候，观众看得出来它是怎么绕的——观战能不能看懂，
   * 差的就是这一口气。
   */
  movePath?: Map<string, Array<{ x: number; y: number }>>;
  /**
   * 经济单位的移动产出预览：格索引 → 站上那格后的每回合收入。
   *
   * 只在"选中带收入的经济单位、且它还能动"时有值。数字印在可达格的
   * 角上，玩家挪农民之前就能看到"去平原收 7、蹲河边多 3"——
   * 收入本来就是按格子算的，不把数字放回格子上，这个机制就只活在说明书里。
   */
  incomeHints?: Map<number, number>;
  /**
   * 这一帧要"抖一下"的单位：id → 强度。
   *
   * 1 = 挨打（左右震），0.5 = 出手（往前一顿）。数值只是动画幅度，
   * 由调用方按"受伤轻重/是不是主动方"给。放在这里而不是让 board 自己判：
   * 只有调用方知道刚刚结算的是哪一下，棋盘看到的永远只是"已经算完的状态"。
   */
  impacts?: ReadonlyMap<string, number>;
}

/**
 * 打击感的两个动作。
 *
 * 用 Web Animations 而不是加 class：棋盘是**增量补丁**渲染，同一个节点会被反复
 * 复用，靠 class 增删触发动画要么不重播、要么得配一堆 setTimeout 去摘 class。
 * `composite: 'add'` 让这段位移叠加在 FLIP 的位移上，两者不会互相覆盖。
 *
 * jsdom 里没有 `Element.animate`（单元测试就跑在那儿），这时直接跳过——
 * 动画是锦上添花，不该让"棋盘能不能渲染"依赖它。
 */
function playImpact(node: HTMLElement, strength: number): void {
  const animate = node.animate;
  if (typeof animate !== 'function') return;
  const strong = strength >= 0.9;
  const frames = strong
    ? [
        { transform: 'translate(0, 0)' },
        { transform: 'translate(-7%, 2%) rotate(-4deg)' },
        { transform: 'translate(6%, -2%) rotate(3deg)' },
        { transform: 'translate(-4%, 1%)' },
        { transform: 'translate(0, 0)' },
      ]
    : [
        { transform: 'translate(0, 0)' },
        { transform: 'translate(8%, 0) scale(1.06)' },
        { transform: 'translate(0, 0) scale(1)' },
      ];
  node.animate(frames, {
    duration: strong ? 260 : 200,
    easing: 'ease-out',
    composite: 'add',
  });
}

const TERRAIN_CLASS: Record<string, string> = {
  plain: 't-plain',
  forest: 't-forest',
  hill: 't-hill',
  water: 't-water',
  mountain: 't-mountain',
  bridge: 't-bridge',
  city: 't-city',
  plateau: 't-plateau',
  valley: 't-valley',
  marsh: 't-marsh',
  dune: 't-dune',
  shallow: 't-shallow',
  lava: 't-lava',
  volcano: 't-volcano',
};

function ensureStructure(el: HTMLElement): void {
  if (el.querySelector('.tiles')) return;
  // 城市层放在棋子之后：背景透明，所以只在视觉上叠一层边框和血条，
  // 不会挡住棋子，pointer-events 也穿过去，点格子照常生效。
  el.innerHTML = '<div class="tiles"></div><div class="units"></div><div class="cities"></div>';
}

/**
 * 格子层的节点缓存。
 *
 * `key` 一变就整层重建：格子数变了（换地图）或者浓雾档变了（unknown 那一档
 * 的 class 集合不一样）。除此之外一律只改变化的那几格。
 *
 * 缓存挂在 `.tiles` 元素上而不是模块级变量：棋盘元素被换掉（换局、重挂载）时
 * 旧缓存跟着旧元素一起被回收，不会拿着上一张图的节点去改。
 */
interface TileLayer {
  key: string;
  nodes: HTMLElement[];
  /** 上一次写下去的 className，逐格比；一样就不碰 DOM */
  cls: string[];
  /** 上一次写的角标 HTML（'' ＝ 没有角标） */
  badge: string[];
}

const tileLayers = new WeakMap<HTMLElement, TileLayer>();

/**
 * 这两层整块重写，但**内容没变就不写**。
 *
 * 屏幕上大部分 render 是"顶栏变了 / 横幅变了 / 缩放变了"，棋盘一格没动。
 * 照写一遍 innerHTML 的代价不只是拼字符串：节点全被换掉，浏览器的样式缓存、
 * 焦点、正在跑的动画全部作废。存一份上次写进去的字串比这便宜得多。
 */
const layerHtml = new WeakMap<HTMLElement, string>();

function paintLayer(el: HTMLElement, html: string): void {
  if (layerHtml.get(el) === html) return;
  layerHtml.set(el, html);
  el.innerHTML = html;
}

/** 写自定义属性，值没变就不碰：每帧重写同一个 `--cell` 会让样式表整片失效 */
function setVar(el: HTMLElement, name: string, value: string): void {
  if (el.style.getPropertyValue(name) === value) return;
  el.style.setProperty(name, value);
}

/**
 * 一个棋子在层里的样子：属性拆成几项，内容单独一份。
 *
 * 拆开是为了**原地补丁**：同一个兵位置变了、血条短了一截，节点可以留着，
 * 只改变的那几项。整块 `innerHTML` 每帧重建 43 个棋子，代价不只是拼字符串——
 * 旧节点全被丢掉，浏览器的样式缓存作废，正在跑的 FLIP 动画也会被打断。
 */
interface UnitItem {
  /** 身份：单位 id 或幽灵的坐标。用来在两次渲染之间对上同一个节点 */
  key: string;
  cls: string;
  style: string;
  title: string;
  x: number;
  y: number;
  /** 单位 id；幽灵没有（它只是个"最后已知位置"的记号） */
  id?: string;
  /** 占地格数，只有宽单位（2×2 城、大船）才有 */
  fp?: number;
  inner: string;
  /** 血量比例（0~1）。受击时用它和节点上记着的旧值算"掉了多少" */
  hpRatio?: number;
  /** 上面所有字段的一次性摘要，一样就整节点不碰 */
  sig: string;
}

interface UnitNode {
  node: HTMLElement;
  sig: string;
}

const unitLayers = new WeakMap<HTMLElement, Map<string, UnitNode>>();

/**
 * 这一次绘制的序号。
 *
 * 打击动画必须"一次动作播一次"，而 `render()` 会因为顶栏、横幅、缩放的任何变化
 * 被反复调用。用绘制序号当记号：同一个序号只播一次，下一次 render 的序号变了，
 * 才会让同一个单位再抖一次——那时也确实是一个新的动作了。
 */
let paintStamp = 0;

function writeUnitNode(node: HTMLElement, it: UnitItem): void {
  // 先记住旧血量再重写内容：重写之后节点上就只剩新值了
  const before = Number(node.dataset.hpRatio ?? '');
  node.className = it.cls;
  node.setAttribute('style', it.style);
  node.title = it.title;
  node.dataset.x = String(it.x);
  node.dataset.y = String(it.y);
  if (it.id !== undefined) node.dataset.id = it.id;
  else node.dataset.ghost = '1';
  if (it.fp !== undefined) node.dataset.fp = String(it.fp);
  node.innerHTML = it.inner;
  if (it.hpRatio !== undefined) {
    node.dataset.hpRatio = String(it.hpRatio);
    // 只有在**掉血**时才演那截残留：回血时冒一条橙条会让人以为又挨了一下
    if (Number.isFinite(before) && before > it.hpRatio + 0.001) {
      const lag = node.querySelector<HTMLElement>('.hp-lag');
      if (lag) {
        lag.style.setProperty('--chip-from', `${Math.max(2, before * 100)}%`);
        lag.style.setProperty('--chip-to', `${Math.max(2, it.hpRatio * 100)}%`);
        lag.classList.add('chipped');
      }
    }
  }
}

/**
 * 把棋子层刷成 `items` 的样子。
 *
 * 三步：对上号的节点只改变化的部分、多出来的摘掉、顺序按 `items` 摆正
 * （DOM 顺序决定谁压在谁上面：建筑在底、地面单位居中、空中单位在最上）。
 * 顺序那一步用"就地移动"而不是"全部重插"——已经对的位置一格都不动，
 * 只有真的换了顺序的节点才会被挪。
 */
function paintUnits(
  unitsEl: HTMLElement,
  items: UnitItem[],
  impacts?: ReadonlyMap<string, number>,
): void {
  let cache = unitLayers.get(unitsEl);
  if (!cache) {
    cache = new Map();
    unitLayers.set(unitsEl, cache);
  }

  const doc = unitsEl.ownerDocument;
  const want: HTMLElement[] = [];
  const alive = new Set<string>();
  for (const it of items) {
    alive.add(it.key);
    let entry = cache.get(it.key);
    if (!entry) {
      const node = doc.createElement('div');
      writeUnitNode(node, it);
      entry = { node, sig: it.sig };
      cache.set(it.key, entry);
    } else if (entry.sig !== it.sig) {
      writeUnitNode(entry.node, it);
      entry.sig = it.sig;
    }
    want.push(entry.node);
    if (impacts && it.id) {
      const power = impacts.get(it.id);
      // 同一个 id 一次动作只抖一次：paint 会被同一个状态重复调用，
      // 不复位成"这一下已经播过"，就会变成连点式的持续抽搐。
      if (power !== undefined && entry.node.dataset.impactAt !== String(paintStamp)) {
        entry.node.dataset.impactAt = String(paintStamp);
        playImpact(entry.node, power);
      }
    }
  }
  for (const key of Array.from(cache.keys())) if (!alive.has(key)) cache.delete(key);

  let cursor = unitsEl.firstChild;
  for (const node of want) {
    if (node === cursor) {
      cursor = cursor.nextSibling;
      continue;
    }
    unitsEl.insertBefore(node, cursor);
  }
  // 剩下的都是这一帧不该存在的（单位死了、幽灵过期了）
  while (cursor) {
    const next = cursor.nextSibling;
    unitsEl.removeChild(cursor);
    cursor = next;
  }
}

function hpClass(ratio: number): string {
  if (ratio <= 0.3) return 'low';
  if (ratio <= 0.6) return 'mid';
  return '';
}

/** 时代用罗马数字表示，比阿拉伯数字更像"时代" */
function romanEra(era: number): string {
  return ['I', 'II', 'III', 'IV', 'V'][era - 1] ?? String(era);
}

export function renderBoard(el: HTMLElement, view: PlayerView, ui: BoardUi): void {
  ensureStructure(el);
  const s = view.state;
  const tilesEl = el.querySelector<HTMLElement>('.tiles');
  const citiesEl = el.querySelector<HTMLElement>('.cities');
  const unitsEl = el.querySelector<HTMLElement>('.units');
  if (!tilesEl || !citiesEl || !unitsEl) return;

  // 先记录棋子旧位置，供 FLIP 用。
  // 读的是 dataset 不是 rect：位置本来就是按格坐标算的，四个数字在手边，
  // 没必要为此让浏览器把布局算一遍。
  const prevPos = new Map<string, { x: number; y: number }>();
  unitsEl.querySelectorAll<HTMLElement>('.unit').forEach((node) => {
    const id = node.dataset.id;
    if (id) prevPos.set(id, { x: Number(node.dataset.x), y: Number(node.dataset.y) });
  });

  const cellSize = Math.max(18, (el.clientWidth - 12) / s.w);
  setVar(el, '--cell', `${cellSize}px`);
  setVar(el, '--cols', String(s.w));
  setVar(el, '--rows', String(s.h));

  el.classList.toggle('fog', s.fog);

  // 浓雾（blackout 扩展）：连地形都不给看。
  // 基础规则的雾只遮单位，地图本身永远可见；这个扩展把"地图"也遮掉——
  // 视野外只剩一片黑，城市要侦察到才画得出来。
  const blackout = s.fog && s.config.expansionIds.includes('blackout');
  el.classList.toggle('blackout', blackout);

  const visibleSet = new Set(view.visible);
  // 浓雾下"去过、此刻看不见"的格：按记忆里的样子画，压暗一档
  const rememberedTiles = view.rememberedTiles;
  const reachSet = new Set(ui.reach);
  const placeSet = new Set(ui.placeable);
  const threatSet = new Set(ui.threat);
  const targetPositions = new Set<number>();
  for (const id of ui.targets) {
    const u = s.units.find((x) => x.id === id);
    if (u) targetPositions.add(u.y * s.w + u.x);
  }

  // ---- 格子 ----
  //
  // 整层只在"格子数或浓雾档变了"时重建一次，之后逐格比 class：
  // 没变的格一行 DOM 都不碰，变了的只改 className。
  const layerKey = `${s.w}x${s.h}x${blackout ? 'b' : 'n'}`;
  let layer = tileLayers.get(tilesEl);
  if (!layer || layer.key !== layerKey || layer.nodes.length !== s.w * s.h) {
    // 重建走一次 innerHTML 而不是 createElement 循环：位置写死在 data-x/data-y 上，
    // 这两项整局不变，所以建完就再也不用管了。
    const shell: string[] = [];
    for (let i = 0; i < s.w * s.h; i++) {
      const x = i % s.w;
      const y = (i - x) / s.w;
      shell.push(`<div class="tile" data-x="${x}" data-y="${y}"></div>`);
    }
    // 直接写 innerHTML，绕开 paintLayer 的"内容相同就不写"——
    // 重建这条路上层里本来就没有节点，跳过判断没有意义
    tilesEl.innerHTML = shell.join('');
    const nodes = Array.from(tilesEl.children) as HTMLElement[];
    layer = {
      key: layerKey,
      nodes,
      cls: new Array(nodes.length).fill(''),
      badge: new Array(nodes.length).fill(''),
    };
    tileLayers.set(tilesEl, layer);
  }

  for (let y = 0; y < s.h; y++) {
    for (let x = 0; x < s.w; x++) {
      const i = y * s.w + x;
      const tile = s.tiles[i];
      const node = layer.nodes[i];
      if (!tile || !node) continue;

      // 三档：眼前亮着 / 去过（浓雾下按记忆画）/ 从没去过（浓雾下全黑）
      const lit = !blackout || visibleSet.has(i);
      const memo = lit ? undefined : rememberedTiles.get(i);
      const seen = lit || memo !== undefined;
      let cls = seen ? `tile ${TERRAIN_CLASS[memo ?? tile.terrain] ?? 't-plain'}` : 'tile unknown';
      if (memo !== undefined) cls += ' remembered';
      if (lit && tile.cityId) {
        const city = s.cities.find((c) => c.id === tile.cityId);
        if (city) cls += ` own-${city.owner}`;
      }
      if (targetPositions.has(i)) cls += ' attackable';
      else if (reachSet.has(i)) cls += ' reach';
      if (threatSet.has(i) && !reachSet.has(i)) cls += ' threat';
      if (placeSet.has(i)) cls += ' placeable';
      if (s.fog && !visibleSet.has(i)) cls += ' out';

      if (layer.cls[i] !== cls) {
        // className 整体赋值比 classList 逐项增删快，而且不会有残留：
        // 上一帧的 reach、这一帧没有，整体赋值一次就干净了
        node.className = cls;
        layer.cls[i] = cls;
      }

      // 产出徽标只跟着可达格走：站不上去的地形（水、山）没有讨论价值
      const hint = ui.incomeHints?.get(i);
      const badge = hint !== undefined ? `<span class="tile-income">+${hint}</span>` : '';
      if (layer.badge[i] !== badge) {
        node.innerHTML = badge;
        layer.badge[i] = badge;
      }
    }
  }

  // ---- 城市 ----
  // 浓雾下城市也分三档：眼前看得见就照实画；以前去过就画记忆里的那一份
  // （虚线框 + "旧情报"）；从没去过连边框都不给——敌城的位置本身就是情报。
  const cityInSight = (city: { x: number; y: number; size: number }): boolean => {
    for (let dy = 0; dy < city.size; dy++) {
      for (let dx = 0; dx < city.size; dx++) {
        if (visibleSet.has((city.y + dy) * s.w + (city.x + dx))) return true;
      }
    }
    return false;
  };
  const cityParts: string[] = [];
  for (const city of s.cities) {
    const lit = !blackout || cityInSight(city);
    const memo = lit ? undefined : view.rememberedCities.get(city.id);
    if (!lit && !memo) continue;

    // 记忆只能代表当时：城会易手、会升级，所以这三项一律以快照为准
    const owner = memo ? memo.owner : city.owner;
    const era = memo ? memo.era : city.era;
    const ruined = memo ? memo.ruined : city.ruined === true;
    const ago = memo ? Math.max(0, s.turn - memo.seenAt) : 0;

    const cls = ['city-block', `owner-${owner}`, `era-${era}`];
    if (ruined) cls.push('ruined');
    if (memo) cls.push('stale');
    if (ui.siegeTargets.includes(city.id)) cls.push('siege-target');
    if (ui.selectedCityId === city.id) cls.push('selected');

    const ratio = city.hp / city.maxHp;
    const style = [
      `left:${(city.x / s.w) * 100}%`,
      `top:${(city.y / s.h) * 100}%`,
      `width:${(city.size / s.w) * 100}%`,
      `height:${(city.size / s.h) * 100}%`,
    ].join(';');

    // 旧情报不画血条：上次看到的耐久早就不是现在这条了，画出来是假消息
    const when = ago === 0 ? '刚刚' : `${ago} 个行动前`;
    const plate = memo
      ? `<div class="city-stale">旧情报 · ${when}</div>`
      : ruined
        ? '<div class="city-ruin">废墟 · 待接管</div>'
        : `<div class="city-hp"><i class="${hpClass(ratio)}" style="width:${Math.max(3, ratio * 100)}%"></i></div>
               <div class="city-armor">甲 ${city.armor}</div>`;
    const note = memo
      ? `${when}看到的：时代 ${romanEra(era)}${ruined ? '，当时是废墟' : ''}`
      : ruined
        ? '已成废墟：派兵入驻并支付重建费才能接管'
        : `耐久 ${city.hp}/${city.maxHp} · 护甲 ${city.armor}`;

    cityParts.push(`<div class="${cls.join(' ')}" data-city-id="${city.id}" style="${style}" title="${cityName(city)} · ${note}">
      <div class="city-plate">
        <div class="city-era">${romanEra(era)}</div>
        <div class="city-name">${cityName(city)}</div>
        ${plate}
      </div>
    </div>`);
  }
  paintLayer(citiesEl, cityParts.join(''));
  // ---- 棋子 ----
  // 建筑先画、部队后画：同一格上"站着的兵"必须压在"设施"上面。
  // 反过来的话，兵被自己的塔盖住，点下去选中的是塔——那个兵就再也选不中、
  // 也就再也走不开了。z-index 不管这件事，DOM 顺序管。
  // 空中单位最后画：它和地面单位可以叠在一格，画在上面才叫"在你头顶"。
  const ordered = [...s.units].sort((a, b) => {
    const rank = (u: Unit) =>
      utype(s, u.type).category === 'building' ? 0 : isAirborne(s, u) ? 2 : 1;
    return rank(a) - rank(b);
  });
  const items: UnitItem[] = [];
  for (const u of ordered) items.push(unitItem(s, u, ui));
  for (const ghost of view.ghosts) {
    items.push(ghostItem(s, ghost.x, ghost.y, ghost.type, ghost.seenAt, s.turn));
  }

  paintStamp += 1;
  paintUnits(unitsEl, items, ui.impacts);

  // ---- 补间（FLIP） ----
  //
  // 有路线就沿路线走（拐弯、绕过河），没路线就直线滑过去。
  // 拐弯这件事只在"走了两格以上"时才看得出来，一格的距离两种画法一样。
  //
  // 位移量自己算：`.units` 是 `.board` 内缩 6px 的那块，格子按百分比均分它，
  // 所以一格的像素宽就是 (棋盘宽 − 12) / 列数。整条路上一次布局都不用求。
  const boxW = Math.max(0, el.clientWidth - 12);
  const cellW = s.w > 0 ? boxW / s.w : 0;
  const cellH = s.h > 0 ? boxW / s.h : 0;
  unitsEl.querySelectorAll<HTMLElement>('.unit').forEach((node) => {
    const id = node.dataset.id;
    if (!id) return;
    const old = prevPos.get(id);
    if (!old) return;
    const nowX = Number(node.dataset.x);
    const nowY = Number(node.dataset.y);
    let dx = (old.x - nowX) * cellW;
    let dy = (old.y - nowY) * cellH;

    // 上一次滑动还没落地，就把"欠"的那一截接上。
    //
    // AI 快起来之后两次重绘可能只隔 70ms，而一格要滑 150ms——直接开一段新的，
    // 棋子会先按新基准跳过去再往回补，肉眼看到的就是抽搐。
    // 起点 = 新格子的上一格（dx,dy） + 上一段没走完的余量，位移就接得上了。
    // 缓动必须是线性的，否则"走了几成"没法反算，余量就是错的。
    const t = nowMs();
    const prev = slides.get(node);
    if (prev) {
      const k = Math.min(1, Math.max(0, (t - prev.at) / prev.dur));
      dx += prev.dx * (1 - k);
      dy += prev.dy * (1 - k);
      prev.anim.cancel();
      slides.delete(node);
    }
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return;

    // 路线只有在"这一段就是从上一格直接走过来的"时才敢用：
    // 极快档会攒几步才重绘一次，这时 route 只覆盖最后一步，
    // 拿它去演两三格的位移，头一格会直接跳到终点附近——又是一次抽搐。
    const route = prev ? undefined : ui.movePath?.get(id);
    const onRoute =
      route && route.length > 2 && route[0] && route[0].x === old.x && route[0].y === old.y;
    const cells = Math.max(Math.abs(dx) / (cellW || 1), Math.abs(dy) / (cellH || 1));

    let frames: Array<{ transform: string }>;
    let dur: number;
    if (onRoute) {
      frames = route
        .slice(0, -1)
        .reverse()
        .map((c) => ({ transform: `translate(${(c.x - nowX) * cellW}px, ${(c.y - nowY) * cellH}px)` }));
      frames.push({ transform: 'translate(0, 0)' });
      // 一格 70ms：这个数还管着 AI 那边"等动画播完再走下一步"的停顿，两边必须一样
      dur = Math.min(560, 70 * (route.length - 1));
    } else {
      frames = [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'translate(0, 0)' }];
      // 一格 150ms，多走几格按距离加时；封顶 420ms，别让长行军把人看困
      dur = Math.min(420, 150 * Math.max(1, Math.round(cells)));
    }

    const anim = node.animate(frames, { duration: dur, easing: 'linear' });
    // 落地就销账：下一次位移照常从零算，不会把残余当成本次起点
    anim.onfinish = () => {
      if (slides.get(node)?.anim === anim) slides.delete(node);
    };
    slides.set(node, { dx, dy, at: t, dur, anim });
  });
}

/**
 * 正在飞的那一段：起点偏移、开始时刻、时长。
 *
 * 按**节点**记而不是按单位 id：换局、换棋盘尺寸都会换掉一批节点，
 * 旧记录跟着节点一起被回收，不用谁记得来清。值为 WeakMap，也不占内存。
 */
const slides = new WeakMap<
  HTMLElement,
  { dx: number; dy: number; at: number; dur: number; anim: Animation }
>();

function nowMs(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

function tileRect(s: GameState, x: number, y: number, n = 1): string {
  return [
    `left:${(x / s.w) * 100}%`,
    `top:${(y / s.h) * 100}%`,
    `width:${(n * 100) / s.w}%`,
    `height:${(n * 100) / s.h}%`,
  ].join(';');
}

function unitItem(s: GameState, u: Unit, ui: BoardUi): UnitItem {
  const def = utype(s, u.type);
  const ratio = u.hp / def.maxHp;
  const isSpent = u.owner === s.current && u.moved && u.acted;
  const isSelected = ui.selectedId === u.id;
  const isTarget = ui.targets.includes(u.id);
  const fp = footprintOf(s, u);

  const cls = ['unit', `owner-${u.owner}`, `cat-${def.category}`];
  // 空中层：缩一号 + 往左上挪一点，和脚底下那个兵能同时看见
  if (isAirborne(s, u)) cls.push('air');
  if (fp > 1) cls.push('wide');
  if (isSpent) cls.push('spent');
  if (isSelected) cls.push('selected');
  if (isTarget) cls.push('targeted');

  const playerName = s.players[u.owner].name;
  const kindText =
    def.category === 'building' ? '建筑' : def.category === 'economy' ? '经济单位' : '部队';
  const name = `${playerName} · ${def.name}（${kindText}）· ${u.hp}/${def.maxHp} · 甲 ${def.armor}`;

  const cargo = u.cargo?.length ?? 0;
  const cargoBadge =
    cargo > 0
      ? `<span style="font-size:9px;vertical-align:top;opacity:.85">${cargo}</span>`
      : '';

  // 工地：进度条压在血条上面。没有它，玩家只看到一座"残血"的建筑，
  // 却不知道自己投了多少、还差多少——施工这件事就只活在日志里。
  const site = underConstruction(u);
  const prog = site ? buildProgress(s, u) : null;
  const siteCls = site ? ' site' : '';
  const buildBar = prog
    ? `<div class="unit-build" title="施工 ${prog.done}/${prog.need} · 每回合 +${prog.rate} · 还要 ${prog.turnsLeft} 回合"><i style="width:${Math.max(
        3,
        prog.ratio * 100,
      )}%"></i></div>`
    : '';
  const siteNote = prog ? ` · 工地 ${prog.done}/${prog.need}（+${prog.rate}/回合）` : '';

  const title = `${name}${siteNote}${cargo > 0 ? ` · 载 ${cargo} 个单位` : ''}`;
  const inner = `<div class="unit-inner">${def.short}${cargoBadge}
      ${buildBar}
      <div class="unit-hp"><i class="hp-lag"></i><i class="hp-now ${hpClass(ratio)}" style="width:${Math.max(2, ratio * 100)}%"></i></div>
    </div>`;
  const clsText = `${cls.join(' ')}${siteCls}`;
  const style = tileRect(s, u.x, u.y, fp);
  return {
    key: `u:${u.id}`,
    cls: clsText,
    style,
    title,
    x: u.x,
    y: u.y,
    id: u.id,
    fp,
    inner,
    hpRatio: Math.max(0, Math.min(1, ratio)),
    sig: `${clsText}|${style}|${title}|${inner}`,
  };
}

function ghostItem(
  s: GameState,
  x: number,
  y: number,
  type: string,
  seenAt: number,
  currentTurn: number,
): UnitItem {
  const def = utype(s, type);
  const title = `最后已知位置：${def.name}（${currentTurn - seenAt} 个行动前）`;
  const inner = `<div class="unit-inner">${def.short}</div>`;
  const style = tileRect(s, x, y);
  return {
    key: `g:${x},${y},${type}`,
    cls: 'unit ghost',
    style,
    title,
    x,
    y,
    inner,
    sig: `ghost|${style}|${title}|${inner}`,
  };
}

/** 从事件目标反推棋盘坐标 */
export function coordsFromEvent(e: Event): { x: number; y: number } | null {
  const target = e.target as HTMLElement | null;
  if (!target) return null;
  const node = target.closest<HTMLElement>('[data-x]');
  if (!node) return null;
  const x = Number(node.dataset.x);
  const y = Number(node.dataset.y);
  if (Number.isNaN(x) || Number.isNaN(y)) return null;
  return { x, y };
}

/** 推断点到的是哪个棋子 */
export function unitIdFromEvent(e: Event): string | null {
  const target = e.target as HTMLElement | null;
  if (!target) return null;
  const node = target.closest<HTMLElement>('[data-id]');
  return node?.dataset.id ?? null;
}

/** 推断点到的是哪座城市 */
export function cityIdFromEvent(e: Event): string | null {
  const target = e.target as HTMLElement | null;
  if (!target) return null;
  const node = target.closest<HTMLElement>('[data-city-id]');
  return node?.dataset.cityId ?? null;
}
