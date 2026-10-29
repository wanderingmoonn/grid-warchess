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
import { canAttack, canMove, heroSkillsOf } from '../core/rules.ts';
import { paintTerrainsFor } from '../core/sandbox.ts';
import type { GameState, LogEntry, PlayerId, Terrain, Unit } from '../core/types.ts';
import { packOk, packRow } from './packs.ts';

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
   * 手上那支兵的一句话（血量、攻击、还剩不剩行动力）。空串＝没选中。
   *
   * 沙盒里没有属性卡，而自己下场走子时这几项每一下都要看。
   */
  selected: string;
  /**
   * 手上那支兵本人（没选中就是 null）。
   *
   * 工具栏上那句话只能放一行，技能按钮放不下——而"能不能开技能"恰恰是
   * 操控档里最容易踩空的一件事：货架把侧栏整块占走了，属性卡和技能菜单
   * 都不在，英雄站到对面脸上了也没有一个能按的按钮。所以侧栏要单独
   * 给这支兵留一块地方，见 `pickedCard`。
   */
  picked: Unit | null;
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
           <div class="chip-row">${ERAS.filter((e) => e.level <= eraCeilingOf(ui.state))
             .map((e) => chip(ui.cityEra === e.level, 'god-city-era', e.name, `data-era="${e.level}"`))
             .join('')}</div>
         </div>`
      : '';

  const sideChips = (['A', 'B'] as PlayerId[])
    .map((p) => chip(ui.side === p, 'god-side', s.players[p].name, `data-side="${p}"`))
    .join('');

  // 操控档：摆完之后是自己下场，还是交给 AI。
  //
  // 和「摆给」挨着放，因为它俩是同一个问题的两半——一个说"这是谁的东西"，
  // 一个说"这一边由谁动手"。分开摆的话，玩家会以为"摆给蓝方"就等于"蓝方归我走"。
  const playName = s.players[ui.side].name;
  const playChips = [
    chip(
      ui.play === null,
      'god-play',
      '只摆放',
      'data-play="none" title="点棋盘只落子；两边都要按「交给 AI」才动"',
    ),
    chip(
      ui.play === 'me',
      'god-play',
      `我打${playName}`,
      'data-play="me" title="只操控这一边，对面交给 AI：你走一步、看它怎么应"',
    ),
    chip(
      ui.play === 'both',
      'god-play',
      '两边我都打',
      'data-play="both" title="摆完自己演一遍，两边都由你走"',
    ),
  ].join('');

  // 轮次条：只在操控档出现。它要回答的是一句话——"现在该谁动"。
  const turnRow =
    ui.play === null
      ? ''
      : `<div class="god-group">
           <span class="god-label">轮次</span>
           <div class="chip-row">${turnLabel(ui, s)}<button class="btn btn-sm${ui.myTurn ? ' btn-primary' : ''}" data-act="god-end-turn"${
             ui.myTurn ? '' : ' disabled'
           } title="这一回合走完了，交给对面">结束回合</button></div>
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
    <div class="god-group">
      <span class="god-label">操控</span>
      <div class="chip-row">${playChips}</div>
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
        <button class="btn btn-primary" data-act="god-run-round" title="AI 操控两边各走一回合，然后交还给你">交给 AI · 一回合</button>
        <button class="btn" data-act="god-run-dead" title="AI 一直打到一方没兵为止，随时可以按停止">接管 · 打到全灭</button>
        <button class="btn btn-sm" data-act="undo" title="退回上一步（包括战斗之前）">撤回</button>
      </div>
    </div>
    <span class="god-status">${ui.result || ui.selected || brushHint(ui, s)}</span>
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
    return `点${s.players[s.current].name}的兵选中：蓝格走过去、红格开火。走完按「结束回合」`;
  }
  switch (ui.brush.kind) {
    case 'unit': {
      const def = s.unitTypes[ui.brush.type];
      return `笔刷：${def?.name ?? ui.brush.type} —— 点棋盘落子，可以连着摆`;
    }
    case 'city':
      return '笔刷：城市 —— 点 2×2 的左上角，橙格是能放的位置';
    case 'erase':
      return '笔刷：橡皮 —— 点单位擦单位，点空城擦城';
    case 'terrain':
      return `笔刷：${CONFIG.terrainName[ui.brush.terrain]} —— 点一格改地形，可以连着刷（城格和站着东西的格改不了）`;
    default:
      return '笔刷：查看 —— 点一格看看那儿有什么';
  }
}

/**
 * 侧栏顶上那块「手上这支兵」。
 *
 * 为什么必须单开一块：上帝模式的侧栏整块让给了兵种货架，正常对局里那张
 * 属性卡（含英雄技能菜单）在这个模式下根本不存在。于是操控档里
 * "选中英雄 → 按技能"这条路是断的——玩家看得见矮人王站在那儿，
 * 也看得见「投斧」两个字印在货架上，但棋盘上没有任何一个按钮能开它。
 *
 * 契约只有一条：**能按的按钮就是现在真能按的**。冷却中、不是自己这一方、
 * 没轮到自己，一律灰掉并写清原因——沙漠盒里最容易让人以为"坏了"的，
 * 就是一个亮着的按钮点下去什么都不发生。
 */
function pickedCard(ui: GodUi): string {
  const s = ui.state;
  const u = ui.picked;
  if (!u) return '';
  const def = s.unitTypes[u.type];
  if (!def) return '';

  const mine = u.owner === s.current;
  const canAct = ui.myTurn && mine;
  const owner = s.players[u.owner].name;

  const facts: string[] = [`${u.hp}/${def.maxHp} 血`];
  if (def.atk > 0) facts.push(`攻 ${def.atk}${def.armor ? ` · 甲 ${def.armor}` : ''} · 射程 ${def.range}`);
  facts.push(canMove(u) ? '还能走' : '走完了');
  if (def.atk > 0) facts.push(canAttack(u) ? '还能打' : '打完了');

  const skills = heroSkillsOf(s, u);
  const rows = skills
    .map((k) => {
      const on = k.ready && canAct;
      const why = !mine
        ? '不是这一方'
        : !ui.myTurn
          ? '等它走完'
          : k.ready
            ? ''
            : k.chargeMax > 0
              ? `${k.toNext} 回合回一发`
              : `${k.cd} 回合`;
      // 充能型技能把"还剩几发"写在名字后面：只写"就绪/冷却"会丢掉
      // "它其实攒着三发"这个信息，而那正是这个技能最要紧的一点
      const chargeNote = k.chargeMax > 0 ? ` · ${k.charge}/${k.chargeMax} 发` : '';
      return `<button class="recruit-btn" data-act="hero-skill" data-id="${u.id}" data-skill="${k.def.id}" ${
        on ? '' : 'disabled'
      }>
        <span class="unit-chip ${u.owner === 'A' ? 'a' : 'b'}" style="width:26px;height:26px;font-size:12px">${def.short}</span>
        <span class="meta"><b>${def.name} · ${k.def.name}${chargeNote}</b><span>${escapeHtml(k.def.summary)}</span></span>
        <span class="price">${on ? '就绪' : escapeHtml(why)}</span>
      </button>`;
    })
    .join('');

  const tail = skills.length === 0
    ? '<div class="hint">这个兵没有主动技能。技能不占行动，冷却中的按钮会写还要等几回合。</div>'
    : `<div class="recruit-list">${rows}</div>
       <div class="hint">技能不占行动，每个英雄每回合最多一次。</div>`;

  return `<div class="card">
    <div class="card-title">手上这支兵</div>
    <div class="unit-head">
      <div class="unit-chip ${u.owner === 'A' ? 'a' : 'b'}">${def.short}</div>
      <div>
        <div class="unit-title">${def.name}</div>
        <div class="unit-sub">${owner} · ${def.era} 代${def.hero ? ' · 英雄' : ''}</div>
      </div>
    </div>
    <div class="hint">${facts.join(' · ')}</div>
    ${
      ui.play === null
        ? '<div class="hint">现在只是摆子，技能开不了。先选「我打…」或「两边我都打」。</div>'
        : ''
    }
    ${tail}
  </div>`;
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
  //
  // 先过一遍扩展包筛选：一屏混着五六个包的时候，"按时代分组"反而是帮倒忙
  // （每个时代组里都掺着别家的兵）。
  const pool = Object.values(s.unitTypes).filter((u) => packOk(u, ui.pack));
  // 只列到这一局的时代上限：没开「现代战争」的局里不会出现第六代兵种，
  // 但货架是按 ERAS 分组的，不过滤就会留一个永远空着的"现代"标签。
  const ceiling = eraCeilingOf(s);
  const groups = ERAS.filter((era) => era.level <= ceiling).map((era) => {
    const units = pool
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
         <div class="hint">${
           ui.play === null
             ? '点一个兵种当笔刷，再点棋盘落子；点同一个兵种可以取消。'
             : '点兵种当笔刷＝接着摆放；再点一次同一个兵种放下笔刷，就能直接用棋盘走子。'
         }</div>
         ${packRow(Object.values(s.unitTypes), ui.pack, 'god-pack')}
         <div class="god-shelf">${groups}</div>
       </div>`;

  /*
   * 「手上这支兵」摆在货架**上面**。
   *
   * 不是塞进货架里：这块要回答的是"我这一下能做什么"，货架回答的是
   * "还能摆什么"，摆完笔刷一放下就再也用不到货架了，而这块卡片
   * 是操控档里每一步都要看的。AI 在跑的时候整块收掉——那时候没有
   * "手上"这回事（点棋盘都不许）。
   */
  const picked = ui.running ? '' : pickedCard(ui);

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
