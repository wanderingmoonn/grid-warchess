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

import { ERAS } from '../core/config.ts';
import type { GameState, LogEntry, PlayerId } from '../core/types.ts';

export type GodBrush =
  | { kind: 'none' }
  | { kind: 'city' }
  | { kind: 'erase' }
  | { kind: 'unit'; type: string };

export interface GodUi {
  state: GameState;
  /** 这一下摆哪一方 */
  side: PlayerId;
  brush: GodBrush;
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
        <span class="cmd-hint">AI 正在同时操控两边 · 第 ${ui.round} 回合</span>
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
           <div class="chip-row">${ERAS.map((e) => chip(ui.cityEra === e.level, 'god-city-era', e.name, `data-era="${e.level}"`)).join('')}</div>
         </div>`
      : '';

  const sideChips = (['A', 'B'] as PlayerId[])
    .map((p) => chip(ui.side === p, 'god-side', s.players[p].name, `data-side="${p}"`))
    .join('');

  return `
    <div class="cmd-head">
      <b>上帝模式</b>
      <span class="cmd-hint">全图无雾 · 摆兵摆城都不要钱</span>
    </div>
    <div class="god-group">
      <span class="god-label">摆给</span>
      <div class="chip-row">${sideChips}</div>
    </div>
    <div class="god-group">
      <span class="god-label">笔刷</span>
      <div class="chip-row">
        ${chip(ui.brush.kind === 'none', 'god-brush', '查看', 'data-brush="none"')}
        ${chip(ui.brush.kind === 'city', 'god-brush', '城市', 'data-brush="city"')}
        ${chip(ui.brush.kind === 'erase', 'god-brush', '橡皮', 'data-brush="erase"')}
      </div>
    </div>
    ${eraChips}
    ${speedRow(ui)}
    <div class="god-group">
      <div class="chip-row">
        <button class="btn btn-primary" data-act="god-run-round" title="AI 操控两边各走一回合，然后交还给你">交给 AI · 一回合</button>
        <button class="btn" data-act="god-run-dead" title="AI 一直打到一方没兵为止，随时可以按停止">接管 · 打到全灭</button>
        <button class="btn btn-sm" data-act="undo" title="退回上一步（包括战斗之前）">撤回</button>
      </div>
    </div>
    <span class="god-status">${ui.result || brushHint(ui, s)}</span>
  `;
}

function countUnits(s: GameState, p: PlayerId): number {
  return s.units.filter((u) => u.owner === p).length;
}

function brushHint(ui: GodUi, s: GameState): string {
  switch (ui.brush.kind) {
    case 'unit': {
      const def = s.unitTypes[ui.brush.type];
      return `笔刷：${def?.name ?? ui.brush.type} —— 点棋盘落子，可以连着摆`;
    }
    case 'city':
      return '笔刷：城市 —— 点 2×2 的左上角，橙格是能放的位置';
    case 'erase':
      return '笔刷：橡皮 —— 点单位擦单位，点空城擦城';
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
  const groups = ERAS.map((era) => {
    const units = Object.values(s.unitTypes)
      .filter((u) => u.era === era.level)
      .sort((a, b) => a.cost - b.cost || a.name.localeCompare(b.name));
    if (units.length === 0) return '';
    const chips = units
      .map((u) => {
        const on = ui.brush.kind === 'unit' && ui.brush.type === u.id;
        return `<button class="chip ${on ? 'active' : ''}" data-act="god-pick" data-unit="${u.id}" title="${u.cost} 金 · ${u.maxHp} 血 · 攻 ${u.atk}${u.armor ? ` · 甲 ${u.armor}` : ''}">
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
         <div class="hint">点一个兵种当笔刷，再点棋盘落子；点同一个兵种可以取消。</div>
         <div class="god-shelf">${groups}</div>
       </div>`;

  return `
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
