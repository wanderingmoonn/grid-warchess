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
import { markKindOf } from '../core/mark-registry.ts';
import { unitStatBits } from '../core/info.ts';
import { 
  buildProgress, 
  cityName, 
  footprintOf, 
  isAirborne, 
  underConstruction, 
  utype,
  maxHpOf
} from '../core/rules.ts';
import type { GameState, PlayerId, Unit } from '../core/types.ts';
import { costLabel, resourceShort } from '../core/resources.ts';
import type { ResourceCost } from '../core/resources.ts';
import { heatStep } from '../core/heat.ts';
import { unitArtUrl } from './unit-art.ts';

export interface BoardUi {
  selectedId: string | null;
  /** 可达格索引 */
  reach: number[];
  /** 可攻击的敌方单位 id */
  targets: string[];
  /** 可攻城的城市 id */
  siegeTargets: string[];
  /** 正在等待选方向的技能高亮格子 */
  aimTiles?: number[];
  /** 技能的波及范围格子 */
  skillThreatTiles?: number[];
  /** 当前选中的城市 id */
  selectedCityId: string | null;
  /**
   * 新手教程要圈的格子（格索引）与要框的城市 id。
   *
   * 走渲染参数而不是"渲染完再往 DOM 上贴 class"：棋盘是每帧重建的，贴上去的 class
   * 下一帧就没了；而且第一次渲染在 rAF 里，贴的那一下可能贴在还没建出来的节点上。
   */
  tutorialTiles?: number[];
  tutorialCityId?: string | null;
  /** 教程要指出的自家城（琥珀色框）：升级/造兵那两步靠它告诉玩家点哪 */
  tutorialOwnCityId?: string | null;
  /** 处于野外建造模式时，可以放置建筑的空格 */
  placeable: number[];
  /**
   * 上帝模式的框选矩形（格索引）。只在沙盒里有值。
   *
   * 走渲染参数而不是"框完再贴 class"：棋盘每帧重建，贴上去的 class 下一帧
   * 就没了；而且拖动过程中每帧都在重画，贴 class 会闪。
   */
  marqueeTiles?: number[];
  /** 威胁范围：移动之后能打到哪些格 */
  threat: number[];
  /**
   * 战况烈度：上一次敌方回合里，这一格上的我方单位挨了几下（格索引 → 次数）。
   *
   * 和上面的 `threat` 不是一回事：那个是"我打得到哪"（前瞻），这个是"刚才在哪儿挨的打"（复盘）。
   * 次数越多闪得越快。视野外的格子在 main.ts 就算掉了，不会走到这里。
   */
  heat?: Map<number, number>;
  /**
   * 扩展的棋盘视图：格索引 → CSS 颜色。
   *
   * 只有"视图打开"时才有值（悬停或钉住，状态在 main.ts）。这一层铺在
   * **地面之上、棋子之下**——它染的是地，不该盖住人和标记。
   *
   * 核心不知道颜色代表什么：灵气、污染、视野都走同一个口子。
   */
  boardView?: Map<number, string>;
  /**
   * 染色层上再写一个字符（风向箭头）。和 `boardView` 同层同格，
   * 只有扩展给了字才有节点——没字的时候这一层和从前一模一样。
   */
  boardGlyph?: Map<number, string>;
  /**
   * 这一下**刚刚打出去**的格子（格索引 → 次数），闪一次就散。
   *
   * 和 `heat` 是两个方向：那个是"上回合我在这挨打"（历史、常驻、出手即收），
   * 这个是"我这一手打到了哪"（当下、一次性）。用同一套 `.fx-heat` 色块与分档，
   * 让玩家不必学第二套视觉语言。
   *
   * `flashSeq` 是重播用的序号：同一批格子连着挨两下时，DOM 字串不变，
   * `paintLayer` 会认为"没变"而不重写，动画就不会重播。带上序号，
   * 每次动作的字串都不同，节点重建、动画从头再来。
   */
  heatFlash?: Map<number, number>;
  /** 闪烁批次号（每次动作 +1）；只用来强制重播动画 */
  flashSeq?: number;
  /**
   * 这一步实际走的路线（单位 id → 格子串），只用来画移动动画。
   *
   * 不给也能用：退化成"起点直线滑到终点"。给了就沿路线拐弯，
   * 绕着河走、绕过友军的时候，观众看得出来它是怎么绕的——观战能不能看懂，
   * 差的就是这一口气。
   */
  movePath?: Map<string, Array<{ x: number; y: number }>>;
  /**
   * 经济单位的移动产出预览：格索引 → 站上那格后的**完整产出表**。
   *
   * 只在"选中经济单位、且它还能动"时有值。数字印在可达格的角上，
   * 玩家挪农民之前就能看到"去平原收 7、蹲河边多 3"——收入本来就是按格子
   * 算的，不把数字放回格子上，这个机制就只活在说明书里。
   *
   * 存的是整张资源表而不是一个金币数：多资源扩展的单位（灵田、灵矿、粮仓）
   * 金币可能没变、灵石变了很多，只传数字的话这一格和前几格看着一模一样。
   * 徽标上仍只印金币（格子太小），其余资源挂在格子的原生悬停里。
   */
  incomeHints?: Map<number, ResourceCost>;
  /**
   * 这一帧要"抖一下"的单位：id → 强度。
   *
   * 1 = 挨打（左右震），0.5 = 出手（往前一顿）。数值只是动画幅度，
   * 由调用方按"受伤轻重/是不是主动方"给。放在这里而不是让 board 自己判：
   * 只有调用方知道刚刚结算的是哪一下，棋盘看到的永远只是"已经算完的状态"。
   */
  impacts?: ReadonlyMap<string, number>;
  /**
   * 这一次动作里**真的掉了血**的单位：id → 掉血前的血量比例（0~1）。
   *
   * 以前血条残留是靠"节点上记着的旧比例"自己比对出来的，结果是：
   * 只要渲染被跳过或重放（AI 连走、悔棋、换局），某些早就受过伤的单位
   * 会莫名其妙再演一次掉血动画。现在改成由调用方在**动作前后**对账，
   * 一次动作只给出这一次真的少血的单位——棋盘只画它给的，不再自己猜。
   */
  hpDrops?: ReadonlyMap<string, number>;
  /**
   * 这个视角是谁的（渲染"地上的东西"要用）。
   *
   * 只影响一件事：自己布的那几件画成实心、敌方已发现的画成空心虚线框。
   * 不给也照样画，只是不分这两种——脚本里的屏幕快照、性能基准都走这条路，
   * 不该为了一个装饰性差别去补一个座位号。
   */
  me?: PlayerId;
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
  // 深水（外海）：必须有自己的一档。以前它不在这张表里，`?? 't-plain'`
  // 把外海兜底成了平原色——地图上"过不去的深水"和"随便走的草地"长得一样。
  deep: 't-deep',
  mountain: 't-mountain',
  bridge: 't-bridge',
  city: 't-city',
  plateau: 't-plateau',
  valley: 't-valley',
  marsh: 't-marsh',
  dune: 't-dune',
  regolith: 't-regolith',
  crater: 't-crater',
  shallow: 't-shallow',
  lava: 't-lava',
  volcano: 't-volcano',
};

function ensureStructure(el: HTMLElement): void {
  if (el.querySelector('.tiles')) return;
  // 城市层放在棋子之后：背景透明，所以只在视觉上叠一层边框和血条，
  // 不会挡住棋子，pointer-events 也穿过去，点格子照常生效。
  // 烈度层放在最后：它要压在棋子**上面**。
  // 以前把红罩画在格子里，一个兵站在那格上就把红全挡住了——
  // 看起来像"没生效"。现在它是一整层，红罩盖过棋子，一眼就能看见"这人挨了打"。
  // 最后两层都在棋子之上：烈度常驻层（上回合挨打）与它的一次性闪烁层（这一下打了哪）。
  // 闪烁层单独一层，是为了不污染常驻层的"内容相同就不写"缓存——那层按格累积、
  // 大多帧不变；这层每次动作都要重播动画，混在一起会互相把对方的 diff 打断。
  el.innerHTML =
    '<div class="tiles"></div><div class="board-view"></div><div class="marks"></div><div class="units"></div><div class="cities"></div><div class="heat"></div><div class="heat-flash"></div>';
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
  /** 当前血量比例（0~1） */
  hpRatio?: number;
  /** 掉血前的比例；只有这一帧真的掉了血才有值 */
  chipFrom?: number;
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
  node.className = it.cls;
  node.setAttribute('style', it.style);
  node.title = it.title;
  node.dataset.x = String(it.x);
  node.dataset.y = String(it.y);
  if (it.id !== undefined) node.dataset.id = it.id;
  else node.dataset.ghost = '1';
  if (it.fp !== undefined) node.dataset.fp = String(it.fp);
  node.innerHTML = it.inner;
  /*
   * 残留条只在"这一次动作里真的掉了血"时演：起点由调用方给的旧比例决定，
   * 不是从节点上猜的（猜的那一版会在渲染重放时让老伤号再抖一次）。
   *
   * 再加一道"这一次绘制已经演过"的记号：写节点可能因为别的原因被调用两次，
   * 没有记号就会给同一笔掉血叠第二遍动画。
   */
  if (
    it.chipFrom !== undefined &&
    it.hpRatio !== undefined &&
    it.chipFrom > it.hpRatio + 0.001 &&
    node.dataset.chipAt !== String(paintStamp)
  ) {
    const lag = node.querySelector<HTMLElement>('.hp-lag');
    if (lag) {
      node.dataset.chipAt = String(paintStamp);
      playChip(lag, Math.max(2, it.chipFrom * 100), Math.max(2, it.hpRatio * 100));
    }
  }
}

/**
 * 血条残留动画。
 *
 * 为什么不用 class + CSS 动画（那正是"掉血动画重复播放"活下来的原因）：
 * `paintUnits` 会为了对齐 DOM 顺序调用 `insertBefore`——一个节点从父节点上被
 * 摘下再插回去时，浏览器会把**正在跑的 CSS 动画从头再来一遍**。而顺序变化最常
 * 发生在"这一下有单位死了"的那一帧，正好和掉血同帧：于是橙条播完一遍，
 * 被前移的节点又播一遍。上一版只堵了"渲染重放"（靠调用方对账），
 * 堵不住浏览器自己的重播。
 *
 * Web Animations 挂在元素上，重新插入不会重播；再配一个绘制序号，
 * 同一次绘制里也不会演两遍。老环境没有 `animate` 就退回 CSS 类（能动就行）。
 */
function playChip(lag: HTMLElement, fromPct: number, toPct: number): void {
  const frames: Keyframe[] = [
    { width: `${fromPct}%`, opacity: 0.95, offset: 0 },
    { width: `${fromPct}%`, opacity: 0.95, offset: 0.4 },
    { width: `${toPct}%`, opacity: 0.72, offset: 0.82 },
    { width: `${toPct}%`, opacity: 0, offset: 1 },
  ];
  const animate = (lag as HTMLElement & {
    animate?: (k: Keyframe[], o?: KeyframeAnimationOptions) => unknown;
  }).animate;
  if (typeof animate === 'function') {
    animate.call(lag, frames, {
      duration: 620,
      easing: 'cubic-bezier(0.22, 0.75, 0.3, 1)',
      fill: 'forwards',
    });
    return;
  }
  lag.style.setProperty('--chip-from', `${fromPct}%`);
  lag.style.setProperty('--chip-to', `${toPct}%`);
  lag.classList.add('chipped');
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

/**
 * 格子角上那枚产出徽标的文字。
 *
 * 只印金币：格子太小，三四样资源挤进去会盖住半个棋盘。金币为 0 的纯多资源
 * 单位（粮仓这类）改成印第一项非金币资源，免得出现一个毫无意义的 `+0`。
 * 完整清单在格子的原生悬停里（见 renderBoard 里的 title），那份不占地方。
 */
function incomeBadgeOf(cost: ResourceCost): string {
  const gold = cost.gold ?? 0;
  if (gold > 0) return `+${gold}`;
  const first = Object.entries(cost).find(([, n]) => (n ?? 0) > 0);
  return first ? `+${first[1]}${resourceShort(first[0])}` : '';
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

  /*
   * 大地图模式。
   *
   * 32×32 是 1024 格，64×64 是 4096 格——四倍。每格身上挂的动效（迷雾压暗、
   * 高亮淡入）在小图上是"顺手就画"，在 4096 格上就是几千个同时进行的合成层。
   * 这个 class 只做一件事：让 CSS 把这些**逐格**的昂贵效果关掉（见 style.css
   * 的 `.board.big` 段），换成纯色块。规则一行不动。
   *
   * 阈值选 1024：32×32 关雾打起来很流畅，64×64 才是需要保护的那一档。
   */
  el.classList.toggle('big', s.w * s.h > 1024);

  // 浓雾（blackout 扩展）：连地形都不给看。
  // 基础规则的雾只遮单位，地图本身永远可见；这个扩展把"地图"也遮掉——
  // 视野外只剩一片黑，城市要侦察到才画得出来。
  const blackout = s.fog && s.config.expansionIds.includes('blackout');
  el.classList.toggle('blackout', blackout);

  const visibleSet = new Set(view.visible);
  // 浓雾下"去过、此刻看不见"的格：按记忆里的样子画，压暗一档
  const rememberedTiles = view.rememberedTiles;
  const reachSet = new Set(ui.reach);
  const aimSet = new Set(ui.aimTiles);
  const skillThreatSet = new Set(ui.skillThreatTiles);
  const placeSet = new Set(ui.placeable);
  const marqueeSet = new Set(ui.marqueeTiles ?? []);
  const tutSet = new Set(ui.tutorialTiles ?? []);
  const threatSet = new Set(ui.threat);
  // 战况烈度：格索引 → 上一个敌方回合挨打的次数。不是自己回合时是 undefined
  const heatSet = ui.heat ?? null;
  // 这一下刚打出去的格子：过一会儿由调用方清掉，这里只负责画出来
  const flashSet = ui.heatFlash ?? null;
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
      /*
       * 纹理错位（--jx / --jy）。
       *
       * 森林、丘陵这些纹理是**按格平铺**的（每格一个元素，背景只能各自重复），
       * 三棵固定位置的树冠会在每一格同一个角落出现，连成片就是一张壁纸。
       * 按坐标给一点偏移，同色地形连起来才像"一片林子"而不是"一堆同样的砖"。
       * 这两项整局不变，所以和 data-x/data-y 一起在重建时写死。
       */
      const jx = ((x * 37 + y * 61) % 7) * 3;
      const jy = ((x * 53 + y * 17) % 7) * 3;
      /*
       * 地形 tile 的变体号（0/1/2）——**按"林子深处/中间/边缘"分配**，不是随机。
       *
       * 第一版用 (x*7+y*13)%3 纯按坐标取模：技术上确实"不连续"，但观感上
       * 三种树一格一换，像把三张贴纸随手撒在格子上，一片林子看不出结构。
       *
       * 现在按 8 邻居里有几格是同种地形来分层：
       *   5~8 个 → 深处（0，大冠树）—— 林子的芯
       *   2~4 个 → 中间（1，针叶）—— 过渡带
       *   0~1 个 → 边缘（2，灌木）—— 贴着草地的边
       * 单格孤立的树自然全是灌木，成片的林子外面一圈灌木、里面大树，
       * 远看就有"林缘 → 林心"的层次。
       *
       * 再叠一点按坐标的微扰（约 1/9 的格子顺延一档），否则同一层会过于整齐。
       */
      const terrainAt = (tx: number, ty: number): string | null =>
        tx < 0 || ty < 0 || tx >= s.w || ty >= s.h
          ? null
          : (s.tiles[ty * s.w + tx]?.terrain ?? null);
      const here = s.tiles[i]?.terrain ?? null;
      let same = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          if (terrainAt(x + dx, y + dy) === here) same += 1;
        }
      }
      /*
       * 同地形之间那条线，**不在这一层解决**。
       *
       * 这里曾经算出 `data-jr / data-jd`，让 CSS 把相邻同地形的那条边设成
       * transparent。抹不干净：真正的缝不是 border，是每格背景各自绘制、
       * 各自由亚像素落点抗锯齿留下的 1px 差。现在地面整块挂在 `.tiles` 上、
       * 格子一律 `border-color: transparent`（见 style.css 的地形材质段）。
       */
      const ring = same >= 5 ? 0 : same >= 2 ? 1 : 2;
      const variant = (ring + ((x * 17 + y * 23) % 9 === 0 ? 1 : 0)) % 3;
      /*
       * 稀疏地形的装饰密度：约 1/5 的格子带一个小图案，其余留白。
       *
       * 第一版是"每格都放"，结果整片草地像菜园——战棋里平原的观感是
       * **大片空 + 零星一点东西**，密了就变成图案阵列，反而比纯色更乱。
       * 森林不参与这个开关：林子本来就该是密的。
       */
      const deco = (x * 31 + y * 17) % 5 === 0 ? '1' : '0';
      /*
       * `--x/--y` 也一起给：开了地形材质之后，每格要按**格坐标**去大图上取景，
       * 相邻格取相邻区域，整盘才是一张连续的地面（而不是每格一张小贴图）。
       */
      shell.push(
        `<div class="tile" data-x="${x}" data-y="${y}" data-v="${variant}" data-d="${deco}" style="--jx:${jx}px;--jy:${jy}px;--x:${x};--y:${y}"></div>`,
      );
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

      if (aimSet.has(i)) cls += ' aim';
      if (skillThreatSet.has(i)) cls += ' skill-threat'; 

      if (threatSet.has(i) && !reachSet.has(i)) cls += ' threat';
      if (placeSet.has(i)) cls += ' placeable';
      if (marqueeSet.has(i)) cls += ' god-sel';
      if (tutSet.has(i)) cls += ' tut-ring';
      if (s.fog && !visibleSet.has(i)) cls += ' out';

      if (layer.cls[i] !== cls) {
        // className 整体赋值比 classList 逐项增删快，而且不会有残留：
        // 上一帧的 reach、这一帧没有，整体赋值一次就干净了
        node.className = cls;
        layer.cls[i] = cls;
      }

      // 产出徽标只跟着可达格走：站不上去的地形（水、山）没有讨论价值
      const hint = ui.incomeHints?.get(i);
      const badgeText = hint ? incomeBadgeOf(hint) : '';
      const badge = badgeText ? `<span class="tile-income">${badgeText}</span>` : '';
      if (layer.badge[i] !== badge) {
        node.innerHTML = badge;
        layer.badge[i] = badge;
      }
      /*
       * 其余资源挂格子的原生悬停（方案乙）：徽标只留金币。
       * 悬停必须挂在格子节点上，不能挂 `.tile-income`——那枚徽标是
       * `pointer-events: none`，鼠标从它上面穿过去，浏览器根本不会弹 title。
       */
      const tip = hint ? `站在这里的每回合产出：${costLabel(hint)}` : '';
      if (node.title !== tip) node.title = tip;
    }
  }

  // ---- 地上的东西（水雷/地雷……）----
  //
  // 排在格子之上、棋子之下：它是"这一格的状态"，不该盖住站在上面的人。
  // 只画视图里给到的那几条——可见性在 playerView 里已经裁过了，
  // 这里再兜一次"视野外不画"，防调用方忘了传 fog 视图。
  //
  // 自己布的画成实心，敌方已发现的画成空心 + 虚线框：
  // 一眼分得出"这是我埋的"还是"这是刚蹚出来的"。
  const marksEl = el.querySelector<HTMLElement>('.marks');
  if (marksEl) {
    const cells: string[] = [];
    for (const m of view.state.marks ?? []) {
      const i = m.y * s.w + m.x;
      if (s.fog && !visibleSet.has(i)) continue;
      const kind = markKindOf(m.kind);
      const mine = ui.me === undefined ? undefined : m.owner === ui.me;
      cells.push(
        `<i class="fx-mark ${mine === undefined ? '' : mine ? 'mine' : 'seen'} own-${m.owner}" ` +
          `data-kind="${m.kind}" title="${kind?.name ?? m.kind}" ` +
          `style="grid-column:${m.x + 1};grid-row:${m.y + 1}"></i>`,
      );
    }
    paintLayer(marksEl, cells.join(''));
  }

  // ---- 战况烈度层 ----
  //
  // 只画"有数的那几格"，用 grid-column/row 定位，不为整张图铺节点；
  // 内容不变就不写 DOM（paintLayer 的老规矩），所以每帧几乎零开销。
  //
  // 这一层在棋子之上：红罩盖住棋子，才看得出"站在这里的这个人挨过打"。
  // 雾里不画——main 已经按可见格过滤过，这里再兜一层，防调用方忘了传。
  // ---- 扩展的棋盘视图（灵气浓度等）----
  //
  // 铺在地面之上、标记与棋子之下：它染的是"地"，不该盖住人和图标。
  // 每一格都建节点（不像 heat 只画"有数的那几格"），因为"这里很稀"本身
  // 也是信息；`paintLayer` 逐字比对，没变化就不写 DOM，所以并不贵。
  const viewEl = el.querySelector<HTMLElement>('.board-view');
  if (viewEl) {
    const cells: string[] = [];
    if (ui.boardView) {
      for (const i of Array.from(ui.boardView.keys()).sort((a, b) => a - b)) {
        const color = ui.boardView.get(i);
        if (!color) continue;
        const x = i % s.w;
        const y = (i - x) / s.w;
        const glyph = ui.boardGlyph?.get(i) ?? '';
        cells.push(
          `<i class="fx-qi${glyph ? ' wind' : ''}" data-x="${x}" data-y="${y}" ` +
            `style="grid-column:${x + 1};grid-row:${y + 1};background:${color}">${glyph}</i>`,
        );
      }
    }
    paintLayer(viewEl, cells.join(''));
  }

  const heatEl = el.querySelector<HTMLElement>('.heat');
  if (heatEl) {
    const cells: string[] = [];
    if (heatSet) {
      for (const i of Array.from(heatSet.keys()).sort((a, b) => a - b)) {
        if (!visibleSet.has(i)) continue;
        const n = heatSet.get(i) ?? 0;
        if (n <= 0) continue;
        const x = i % s.w;
        const y = (i - x) / s.w;
        // 只画色块，不写数字：血条已经把"伤得多重"说清楚了，
        // 这里要回答的是"哪儿在打"，多一个数字只是噪声。
        cells.push(
          `<i class="fx-heat d${heatStep(n)}" data-x="${x}" data-y="${y}" ` +
            `style="grid-column:${x + 1};grid-row:${y + 1}"></i>`,
        );
      }
    }
    paintLayer(heatEl, cells.join(''));
  }

  // ---- 出手闪烁层 ----
  //
  // 和上面同构、同样只给有内容的格子建节点，区别只在于：这一层不常驻，
  // 由 main 在约 0.7 秒后把数据清空、再重绘一次，节点随之消失。
  // 动画写在 CSS（`.fx-heat.flash`），只播一次，不和常驻层的无限脉冲打架。
  const flashEl = el.querySelector<HTMLElement>('.heat-flash');
  if (flashEl) {
    const cells: string[] = [];
    if (flashSet) {
      const seq = ui.flashSeq ?? 0;
      for (const i of Array.from(flashSet.keys()).sort((a, b) => a - b)) {
        if (!visibleSet.has(i)) continue;
        const n = flashSet.get(i) ?? 0;
        if (n <= 0) continue;
        const x = i % s.w;
        const y = (i - x) / s.w;
        cells.push(
          `<i class="fx-heat flash d${heatStep(n)}" data-x="${x}" data-y="${y}" ` +
            `data-flash="${seq}" ` +
            `style="grid-column:${x + 1};grid-row:${y + 1}"></i>`,
        );
      }
    }
    paintLayer(flashEl, cells.join(''));
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
    if (ui.tutorialCityId && city.id === ui.tutorialCityId) cls.push('tut-city-ring');
    if (ui.tutorialOwnCityId && city.id === ui.tutorialOwnCityId) cls.push('tut-city-ring-own');
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
  const ratio = u.hp / maxHpOf(s,u);
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
  /*
   * 悬停提示里的数值行走共用口径（含「视野」）。
   *
   * 血已经用"当前/上限"写在前面了，这里把「血」那一段筛掉，别写两遍。
   */
  const statBits = unitStatBits(def).filter((b) => !b.startsWith('血 '));
  const name = `${playerName} · ${def.name}（${kindText}）· ${u.hp}/${def.maxHp} · ${statBits.join(' · ')}`;

  const cargo = u.cargo?.length ?? 0;
  const cargoBadge =
    cargo > 0
      ? `<span style="font-size:var(--fs-micro);vertical-align:top;opacity:.85">${cargo}</span>`
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
  /*
   * 有贴图就用贴图，没有就还是那个汉字。
   *
   * 只在 `.unit-inner` 的**内容**上换，圆角方块和阵营底色都不动——
   * 阵营色回答的是"这是谁的兵"，比"这是什么兵"更该优先读到，图替换掉的只是字。
   */
  const artUrl = unitArtUrl(u.type);
  const glyph = artUrl
    ? `<img class="unit-art" src="${artUrl}" alt="" draggable="false" />`
    : def.short;
  const inner = `<div class="unit-inner${artUrl ? ' has-art' : ''}">${glyph}${cargoBadge}
      ${buildBar}
      <div class="unit-hp"><i class="hp-lag"></i><i class="hp-now ${hpClass(ratio)}" style="width:${Math.max(2, ratio * 100)}%"></i></div>
    </div>`;
  const clsText = `${cls.join(' ')}${siteCls}`;
  const style = tileRect(s, u.x, u.y, fp);
  return {
    /*
     * key 里带上"有没有贴图"这一维。
     *
     * 棋子层按 key 做 diff（内容没变就不写 DOM），而贴图清单是**异步到货**的：
     * 第一帧没有图、写进了缓存，清单到了之后 key 若还是同一个，diff 会认定
     * "内容没变"直接跳过——开关打开了、棋盘照旧全是汉字。
     */
    key: `u:${u.id}${artUrl ? ':art' : ''}`,
    cls: clsText,
    style,
    title,
    x: u.x,
    y: u.y,
    id: u.id,
    fp,
    inner,
    hpRatio: Math.max(0, Math.min(1, ratio)),
    chipFrom: ui.hpDrops?.get(u.id),
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
  if (node) {
    const x = Number(node.dataset.x);
    const y = Number(node.dataset.y);
    if (Number.isNaN(x) || Number.isNaN(y)) return null;
    return { x, y };
  }

  /*
   * 兜底：点在棋盘上、但没落在任何一格上。
   *
   * 这些地方以前是**整片死区**，因为命中完全靠"事件目标是不是一个 `[data-x]` 节点"：
   *   · `.board` 有 6px 内边距，那一圈只是背景色，不是格子；
   *   · 放大时 `fitBoard` 写的是 `Math.round(基准 × 档位)`，格子是按百分比分的，
   *     除不尽时最后一列/行会留下不到一像素的缝；
   *   · 以后谁再往棋盘上盖一层装饰（不写 data-x），也会一起变成死区。
   *
   * 于是"点地图边缘没反应"会被当成偶发 bug 报上来，而每次都只是差了几像素。
   * 现在退化成一次几何换算：拿 `.tiles` 的真实矩形和行列数反推序号，
   * 越界就夹到边界格。宁可点歪到相邻格，也比整块区域点了没动静好——
   * 玩家能看出"点歪了"，看不出"这里没实现"。
   */
  const board = target.closest<HTMLElement>('.board');
  if (!board) return null;

  // 只认鼠标/触摸那类带坐标的事件：键盘触发的 click 坐标是 0,0，换算出来是假命中
  const ev = e as MouseEvent;
  if (typeof ev.clientX !== 'number' || typeof ev.clientY !== 'number') return null;
  if (ev.clientX === 0 && ev.clientY === 0) return null;

  return cellAtPoint(board, ev.clientX, ev.clientY);
}

/**
 * 按屏幕坐标算落在哪一格（纯几何，**不看事件目标**）。
 *
 * 拖动绘制只能用这一条。指针被 `setPointerCapture` 抓到棋盘上之后，
 * `pointermove` 的 target 就是 `.board` 本身了，`closest('[data-x]')` 永远查不到
 * 格子——按老路径算，整根拖动画出来会是空的。合并采样（getCoalescedEvents）
 * 拿到的那些中间点也一样没有格子节点可查。
 *
 * 顺带把上面那段兜底的几何换算收成一份：两处各写一遍，迟早会改歪一处。
 */
export function cellAtPoint(
  board: HTMLElement,
  clientX: number,
  clientY: number,
): { x: number; y: number } | null {
  const tiles = board.querySelector<HTMLElement>('.tiles');
  if (!tiles) return null;

  const cols = Number(board.style.getPropertyValue('--cols')) || 0;
  const rows = Number(board.style.getPropertyValue('--rows')) || 0;
  const box = tiles.getBoundingClientRect();
  if (cols <= 0 || rows <= 0 || box.width <= 0 || box.height <= 0) return null;

  const clamp = (v: number, hi: number): number => Math.min(hi, Math.max(0, v));
  const x = clamp(Math.floor(((clientX - box.left) / box.width) * cols), cols - 1);
  const y = clamp(Math.floor(((clientY - box.top) / box.height) * rows), rows - 1);
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
