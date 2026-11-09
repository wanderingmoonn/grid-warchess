/**
 * 上帝模式的界面：顶上一条工具栏，侧边一个兵种货架，外加一块战报。
 *
 * 为什么不像平时那样"点单位出卡片"：这个模式里没有人想看属性卡——
 * 兵是自己一手摆上去的，摆的时候就知道它是谁。真正要看的只有三件事：
 * 还能选什么（货架），点下去会发生什么（笔刷），以及**AI 刚才干了什么**。
 *
 * 战报是后加的，原因是这个模式把两边都交给 AI 之后，棋盘上只剩结果：
 * 谁先动的手、不死鸟是不是留下了一枚蛋、矮人王的斧头扔没扔，全看不见。
 * 而"AI 到底会不会用技能"本身就是要验证的东西——不给它说话的地方，
 * 就只能靠猜。所以战报在这里不是装饰，是唯一能读到的过程。
 *
 * 两个函数分开，是因为它们刷新的频率不一样：工具栏里有按钮（AI 跑的时候
 * 要换成一整条进度），货架里有一批 chip。分开画，AI 跑起来的时候
 * 不用每一步都重排 60 个按钮。
 */

import { CONFIG, ERAS } from '../core/config.ts';
import { eraCeilingOf } from '../core/expansions.ts';
import { buildListOf } from '../core/build-list.ts';
import { unitStatLine } from '../core/info.ts';

import { paintTerrainsFor } from '../core/sandbox.ts';
import type { GameState, LogEntry, PlayerId, Terrain } from '../core/types.ts';
import { packOk, packRow, eraChipRow, eraOk } from './packs.ts';
import { matchRecruit } from './panel.ts';

export type GodBrush =
  | { kind: 'none' }
  | { kind: 'city' }
  | { kind: 'erase' }
  | { kind: 'terrain'; terrain: Terrain }
  | { kind: 'unit'; type: string };

export interface GodUi {
  state: GameState;
  /** 这一下摆哪一方 */
  side: PlayerId;
  brush: GodBrush;
  /**
   * 货架按扩展包筛选：空串 = 全部，`core` = 原版，其它是扩展 id。
   *
   * 沙盒的货架是按时代分组的，而奇想包那批兵种散在各个时代里——
   * 想摆一队"奇想·骑士"得在六个时代组里一个个找。按包切一刀最省事。
   */
  pack: string;
  /**
   * 货架按时代筛选：`ERA_ALL` = 全部。
   *
   * 和 pack 是**与**的关系。沙盒的货架本来就按时代分组，这一维看起来
   * 有点重复，但它解决的是另一件事：想单独看某一代的兵时，分组版仍然
   * 要滚动穿过别的组；筛完就只剩那一组。
   */
  era: number;
  /** 摆城时用哪个时代（1-5） */
  cityEra: number;
  /** AI 正在打 */
  running: boolean;
  /** 打到第几回合（running 时有意义） */
  round: number;
  /** 上一次打完的结论，空串表示还没打过 */
  result: string;
  /** AI 每步之间的停顿档位（索引到 speedNames） */
  speed: number;
  speedNames: readonly string[];
  /** 战报。最新的在最后，渲染时自己倒过来 */
  log: readonly LogEntry[];
  /**
   * 谁亲手走：`null` = 只摆放（老样子），`'me'` = 我打 `side` 这一边，
   * `'both'` = 两边都由我走。
   */
  play: 'me' | 'both' | null;
  /** 现在轮不轮到玩家自己走 */
  myTurn: boolean;
  /** AI 正在替对面走**这一个回合**（不是两边都托管，那个走的是 running） */
  passing: boolean;
  /**
   * 侧栏顶上那块「选中了什么」的完整属性卡（已经渲染好的 HTML，空串＝没选中）。
   *
   * 为什么是"渲染好的字符串"而不是让这里自己画：属性卡里那套东西
   * （光环、规则加成、真实数值、技能按钮、上下船）和正常对局是**同一份代码**。
   * 沙盒里另画一份精简版的话，迟早会出现"沙盒说 12、实战打出来 15"。
   * 所以由 main 那边调 `detailCardHtml()` 生成，这里只负责摆位置。
   */
  detail: string;
  /**
   * 货架的按字搜索词（空串＝不过滤）。
   *
   * 和产兵面板用同一个匹配函数（`matchRecruit`）：名字、代号、职能、时代、包名都算，
   * 多词按"且"处理。两个界面搜同一个词命中不同的东西，是最难解释的那种不一致。
   */
  query: string;
  /**
   * 快捷模式：开着的时候键盘上有快捷键直接结束回合，不用去点那颗按钮。
   *
   * 摆一场歼灭战要按十几次「结束回合」，鼠标每次都得横跨半个屏幕；
   * 而沙盒本来就是键盘党在用的东西（摆兵、刷地形都是连点）。
   */
  quick: boolean;
}

const chip = (on: boolean, act: string, label: string, extra = ''): string =>
  `<button class="chip ${on ? 'active' : ''}" data-act="${act}" ${extra}>${label}</button>`;

/**
 * 速度档位。
 *
 * 和外面那条"AI 速度"是同一套档位（慢/快/极快），但**分开存**：
 * 正常对局里最慢那一档是给"看清对手怎么走"用的，而沙盒里看的是几十回合的
 * 走势，用最慢档放一场歼灭战要等一分多钟。所以沙盒默认快一档。
 */
function speedRow(ui: GodUi): string {
  const chips = ui.speedNames
    .map((n, i) => chip(ui.speed === i, 'god-speed', n, `data-speed="${i}"`))
    .join('');
  return `<div class="god-group">
      <span class="god-label">速度</span>
      <div class="chip-row">${chips}</div>
    </div>`;
}

/** 顶上那条：阵营 / 笔刷 / 执行。AI 在跑的时候整条换成"正在打 + 停止"。 */
export function godBarHtml(ui: GodUi): string {
  const s = ui.state;

  if (ui.running) {
    return `
      <div class="cmd-head">
        <b>上帝模式</b>
        <span class="cmd-hint">AI 正在走第 ${ui.round} 回合</span>
      </div>
      <div class="god-group">
        <div class="god-live">
          <span class="god-count"><i class="side-dot a"></i>${s.players.A.name} ${countUnits(s, 'A')}</span>
          <span class="god-count"><i class="side-dot b"></i>${s.players.B.name} ${countUnits(s, 'B')}</span>
        </div>
        ${ui.speedNames
          .map((n, i) => chip(ui.speed === i, 'god-speed', n, `data-speed="${i}"`))
          .join('')}
        <button class="btn god-push" data-act="god-stop">停止</button>
      </div>
    `;
  }

  const eraChips =
    ui.brush.kind === 'city'
      ? `<div class="god-group">
           <span class="god-label">城的时代</span>
           <div class="chip-row">${ERAS.filter((e) => e.level <= eraCeilingOf(ui.state))
             .map((e) => chip(ui.cityEra === e.level, 'god-city-era', e.name, `data-era="${e.level}"`))
             .join('')}</div>
         </div>`
      : '';

  const sideChips = (['A', 'B'] as PlayerId[])
    .map((p) => chip(ui.side === p, 'god-side', s.players[p].name, `data-side="${p}"`))
    .join('');

  // 操控档现在固定是"两边我都打"：沙盒的用途就是自己演一遍，
  // 而"只摆放 / 我打一边"这两档和它抢的是同一个位置——想歇手的时候
  // 下面那两颗「交给 AI」按钮才是正解（跑一回合 / 打到全灭）。
  // 三颗 chip 留着只会让人以为"点了会换一种模式"，其实只是换谁来按鼠标。

  // 轮次条：只在操控档出现。它要回答的是一句话——"现在该谁动"。
  const turnRow =
    ui.play === null
      ? ''
      : `<div class="god-group">
           <span class="god-label">轮次</span>
           <div class="chip-row">${turnLabel(ui, s)}<button class="btn btn-sm${ui.myTurn ? ' btn-primary' : ''}" data-act="god-end-turn"${
             ui.myTurn ? '' : ' disabled'
           } title="这一回合走完了，交给对面">结束回合</button>${chip(
             ui.quick,
             'god-quick',
             '快捷模式',
             'data-quick="1" title="开着的时候按空格直接结束回合，不用去点那颗按钮"',
           )}<span class="hint">${ui.quick ? '空格 = 结束回合' : '打开后可用空格结束回合'}</span></div>
         </div>`;

  // 地形笔刷常驻显示，不折进"笔刷"那一组里。
  //
  // 折起来的话没人知道这个模式还能改地形——而"摆一场渡河战"恰恰是沙盒
  // 最想要的东西。六个 chip 占不了多少地方，摆出来比藏起来划算。
  // 画笔名单跟着扩展开关走：没开「地形高差」就没有台地/熔岩那几颗按钮
  const terrainChips = paintTerrainsFor(s).map((t) =>
    chip(
      ui.brush.kind === 'terrain' && ui.brush.terrain === t,
      'god-terrain',
      CONFIG.terrainName[t],
      `data-terrain="${t}"`,
    ),
  ).join('');

  return `
    <div class="cmd-head">
      <b>上帝模式</b>
      <span class="cmd-hint">${
        ui.play === null ? '全图无雾 · 摆兵摆城都不要钱' : '全图无雾 · 放下笔刷后点棋盘就是走子'
      }</span>
    </div>
    <div class="god-group">
      <span class="god-label">摆给</span>
      <div class="chip-row">${sideChips}</div>
    </div>
    ${turnRow}
    <div class="god-group">
      <span class="god-label">笔刷</span>
      <div class="chip-row">
        ${chip(
          ui.brush.kind === 'none',
          'god-brush',
          ui.play === null ? '查看' : '操控',
          `data-brush="none" title="${
            ui.play === null ? '点一格看看那儿有什么' : '放下笔刷，点棋盘就是走子/开火'
          }"`,
        )}
        ${chip(ui.brush.kind === 'city', 'god-brush', '城市', 'data-brush="city"')}
        ${chip(ui.brush.kind === 'erase', 'god-brush', '橡皮', 'data-brush="erase"')}
      </div>
    </div>
    <div class="god-group">
      <span class="god-label">刷地形</span>
      <div class="chip-row">${terrainChips}</div>
    </div>
    ${eraChips}
    ${speedRow(ui)}
    <div class="god-group">
      <div class="chip-row">
        <button class="btn btn-primary" data-act="god-run-round" title="AI 替当前这一方走完这一回合（顶栏那个「第 N 回合」只加 1），然后交还给你">交给 AI · 一回合</button>
        <button class="btn" data-act="god-run-dead" title="AI 一直打到一方没兵为止，随时可以按停止">接管 · 打到全灭</button>
        <button class="btn btn-sm" data-act="undo" title="退回上一步（包括战斗之前）">撤回</button>
        <button class="btn btn-sm" data-act="god-map-upload" title="把这一局的地形和城位存成一张地图，交到云端地图库（要审核）">上传这张图</button>
      </div>
    </div>
    ${(() => {
      const note = ui.result || brushHint(ui, s);
      return note ? `<span class="god-status">${note}</span>` : '';
    })()}
  `;
}

function countUnits(s: GameState, p: PlayerId): number {
  return s.units.filter((u) => u.owner === p).length;
}

/**
 * "现在该谁动"。
 *
 * 三态要分清：AI 正在替对面走这一步、轮到玩家、轮到 AI 但还没推起来。
 * 最后一种看着像瞬间状态，其实会实打实出现在"你刚切到操控档、对面还没开跑"
 * 的那一帧上——那时候棋盘点不动，没有一句解释，玩家只会以为按钮坏了。
 */
function turnLabel(ui: GodUi, s: GameState): string {
  if (ui.passing) {
    return `<span class="hint">${s.players[s.current].name}（AI）正在走这一步…</span>`;
  }
  if (ui.myTurn) return `<span class="hint">轮到${s.players[s.current].name}（你）</span>`;
  return `<span class="hint">${s.players[s.current].name}（AI）的回合</span>`;
}

function brushHint(ui: GodUi, s: GameState): string {
  // 空手 + 操控档：这时候点棋盘不是"查看"，是走子。提示得跟着换，
  // 否则玩家看到"点一格看看那儿有什么"，点下去却把兵动了。
  if (ui.brush.kind === 'none' && ui.play !== null) {
    if (ui.passing) return '对面正在走这一步，走完就轮到你';
    if (!ui.myTurn) return `${s.players[s.current].name}（AI）的回合，它走完就轮到你`;
    // 轮到你了：这里不再写"点兵选中、蓝格红格、走完按结束回合"那一长串。
    // 棋盘和右侧面板已经把这三件事显示得很清楚，工具栏再念一遍只是噪音。
    return '';
  }
  switch (ui.brush.kind) {
    case 'unit': {
      const def = s.unitTypes[ui.brush.type];
      return `笔刷：${def?.name ?? ui.brush.type} —— 点一格落子；按住拖过去能连着铺一片`;
    }
    case 'city':
      return '笔刷：城市 —— 点 2×2 的左上角，橙格是能放的位置';
    case 'erase':
      return '笔刷：橡皮 —— 点单位擦单位，点空城擦城；按住拖过去能连着擦';
    case 'terrain':
      return `笔刷：${CONFIG.terrainName[ui.brush.terrain]} —— 点一格改地形，或按住拖过去整片刷（城格和站着东西的格改不了）`;
    default:
      return '笔刷：查看 —— 点一格看看那儿有什么';
  }
}

function escapeHtml(t: string): string {
  return t.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

/**
 * 货架的搜索框。
 *
 * 样式和产兵面板那个**完全一样**（同 class `recruit-search`），因为它是同一件事：
 * 在几十个兵种里找某一个。两处长得不一样只会让人以为功能不同。
 *
 * 输入法那套处理不在这个文件里——`main.ts` 里有一份 `data-act` 无关的组字保护，
 * 两个搜索框共用它。之前那次"输入文字变成一串乱码"就是组字中途重绘导致的，
 * 所以这里**绝不能**自己再挂一套 keydown/input。
 */
function godSearchBox(q: string, shown: number, total: number): string {
  if (total < 6) return '';
  const qq = q ?? '';
  const count = qq ? `${shown}/${total}` : `共 ${total} 种`;
  return `<div class="recruit-search">
    <input
      type="search"
      class="recruit-search-input"
      data-act="god-search"
      value="${escapeHtml(qq)}"
      placeholder="搜兵种：名字 / 代号 / 职能 / 包名"
      autocomplete="off"
      spellcheck="false"
    />
    <span class="recruit-search-count">${count}</span>
  </div>`;
}

/** 最近这么几条战报。再多也读不过来，而且会把货架挤出屏幕 */
const LOG_ROWS = 12;

/**
 * 战报。
 *
 * 和正常对局那张卡的区别：这里不写"你"，两边都直呼其名——沙盒里没人
 * 是"你"，连视角都是全图的。
 */
function godLogHtml(ui: GodUi): string {
  if (ui.log.length === 0) {
    return '<div class="log-empty">还没有战报。摆完兵按「交给 AI」就有的看了。</div>';
  }
  const recent = ui.log.slice(-LOG_ROWS).reverse();
  return `<div class="log">${recent
    .map((e) => {
      const side = e.player === 'A' ? 'a' : 'b';
      return `<div class="log-item ${side}"><span class="who">${escapeHtml(ui.state.players[e.player].name)}</span>${escapeHtml(e.text)}</div>`;
    })
    .join('')}</div>`;
}

/** 侧栏：场上形势 + 战报 + 兵种货架。 */
export function godShelfHtml(ui: GodUi): string {
  const s = ui.state;

  // 按时代分组、组内按造价排：想找"坦克"就往现代那一组看，
  // 比在一个 60 项的长列表里从头扫快得多。
  //
  // 先过两维筛选：一屏混着五六个包的时候，"按时代分组"反而是帮倒忙
  // （每个时代组里都掺着别家的兵）；只留一代的时候，分组也只剩一组。
  //
  // 只列到这一局的时代上限：没开「现代战争」的局里不会出现第六代兵种，
  // 但货架是按 ERAS 分组的，不过滤就会留一个永远空着的"现代"标签。
  //
  // 两行 chip 用的都是这份**封顶之后**的清单：筛选栏上的数字必须和货架上
  // 真能点到的按钮对得上，否则"全部 47"里会混进十几个摆不出来的兵。
  const ceiling = eraCeilingOf(s);
  const shelfDefs = Object.values(s.unitTypes).filter((u) => u.era <= ceiling);
  // 三个条件是**与**：包 / 时代 / 搜索词。搜出来的东西永远是"这一包这一代里的"，
  // 不会因为搜索把范围悄悄放大——那会让人以为筛选没生效
  const pool = shelfDefs.filter(
    (u) => packOk(u, ui.pack) && eraOk(u, ui.era) && matchRecruit(u, ui.query),
  );
  const groups = ERAS.filter((era) => era.level <= ceiling).map((era) => {
    const units = pool
      .filter((u) => u.era === era.level)
      .sort((a, b) => a.cost - b.cost || a.name.localeCompare(b.name));
    if (units.length === 0) return '';
    const chips = units
      .map((u) => {
        const on = ui.brush.kind === 'unit' && ui.brush.type === u.id;
        // 货架上也要能看出这个工兵能盖什么，别等摆到棋盘上再点开属性卡
        const builds = buildListOf(u, {
          nameOf: (id) => s.unitTypes[id]?.name ?? id,
          exists: (id) => !!s.unitTypes[id],
        });
        const buildTip = builds.names.length > 0
          ? ` · 可建 ${escapeHtml(builds.names.join('、'))}`
          : '';
        return `<button class="chip ${on ? 'active' : ''}" data-act="god-pick" data-unit="${u.id}" title="${u.cost} 金 · ${unitStatLine(u)}${buildTip}">
          ${u.short} ${u.name}
        </button>`;
      })
      .join('');
    return `<div class="era-group">
      <span class="era-tag">${era.name}</span>
      <div class="chip-row">${chips}</div>
    </div>`;
  }).join('');

  const side = (p: PlayerId) => `
    <div class="god-side-row">
      <span class="vs-dot ${p === 'A' ? 'a' : 'b'}"></span>
      <b>${s.players[p].name}</b>
      <span class="hint">${countUnits(s, p)} 兵 · ${s.cities.filter((c) => c.owner === p).length} 城</span>
      <button class="btn btn-sm btn-quiet-danger" data-act="god-clear" data-side="${p}">撤走部队</button>
    </div>`;

  /*
   * AI 在打的时候，货架整块收掉。
   *
   * 两个理由：这时候点棋盘会被拦（"AI 正在打，先按停止"），货架留着也只是
   * 一堆按不动的按钮；更重要的是战报——它是这几步里唯一能看到的东西，
   * 压在六十个兵种下面等于没有。
   */
  const shelfCard = ui.running
    ? `<div class="card">
         <div class="card-title">兵种货架</div>
         <div class="hint">AI 在打，摆不了东西。先按「停止」，或者等它打完。</div>
       </div>`
    : `<div class="card">
         <div class="card-title">兵种货架</div>
         <div class="hint">${
           ui.play === null
             ? '点一个兵种当笔刷，再点棋盘落子；点同一个兵种可以取消。'
             : '点兵种当笔刷＝接着摆放；再点一次同一个兵种放下笔刷，就能直接用棋盘走子。'
         }</div>
         ${packRow(shelfDefs, ui.pack, 'god-pack')}
         ${eraChipRow(shelfDefs, ui.era, 'god-era')}
         ${godSearchBox(ui.query, pool.length, shelfDefs.length)}
         <div class="god-shelf">${
           groups ||
           `<div class="hint">${
             ui.query
               ? `没有匹配「${escapeHtml(ui.query)}」的兵。清掉搜索框，或者换一个扩展包 / 时代。`
               : '这一档没有兵。换一个扩展包 / 时代，或者点「全部」回到完整货架。'
           }</div>`
         }</div>
       </div>`;

  /*
   * 「手上这支兵」摆在货架**上面**。
   *
   * 不是塞进货架里：这块要回答的是"我这一下能做什么"，货架回答的是
   * "还能摆什么"，摆完笔刷一放下就再也用不到货架了，而这块卡片
   * 是操控档里每一步都要看的。AI 在跑的时候整块收掉——那时候没有
   * "手上"这回事（点棋盘都不许）。
   */
  // AI 在跑的时候整块收掉：那时候点棋盘都不许，"选中了什么"没有意义
  const picked = ui.running ? '' : ui.detail;

  return `
    ${picked}
    ${shelfCard}

    <div class="card">
      <div class="card-title">战报</div>
      ${godLogHtml(ui)}
    </div>

    <div class="card">
      <div class="card-title">场上</div>
      ${side('A')}
      ${side('B')}
      <div class="hint" style="margin-top:8px">
        金库和产线在这个模式里不起作用：两边都不会自己造兵，场上这些就是全部家当。
        城留着当靶子用——想试"这支部队啃不啃得下一座城"，就摆一座上去。
      </div>
    </div>
  `;
}
