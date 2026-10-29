/**
 * 侧栏面板。
 *
 * 原则：只展示 playerView 过滤后的信息。
 * 迷雾下"敌方还剩几个单位""对方金币多少"这类全局统计一律不显示，
 * 否则迷雾就白做了。城市归属和耐久是公开信息（城墙就在那儿）。
 */

import {
  CATEGORY_NAME,
  CONFIG,
  buildCostOf,
  buildPowerOf,
  eraDef,
  navigable,
  passable,
} from '../core/config.ts';
import { canPay, costLabel, resourceShort } from '../core/resources.ts';
import { expansionById, unitSourceOf } from '../core/expansions.ts';
import { PACK_ALL, packLabel, packOk, packRow } from './packs.ts';
import { buildMatchReport, type ReportSide } from '../core/report.ts';
import type { PlayerView } from '../core/fog.ts';
import { CLIMATE_ICON, climateEffectLines, describeTerrain, describeUnit, TERRAIN_INFO } from '../core/info.ts';
import { CLIMATE_NAME, SEASON_NAME, SEASON_TURNS, climateAt, seasonOf, type Climate } from '../core/climate.ts';
import {
  buildingAt,
  citiesOf,
  cityById,
  cityName,
  cityRegenOf,
  cityTiles,
  disbandRefundOf,
  distToCity,
  effectiveStats,
  heroSkillsOf,
  recruitResCost,
  recruitSpawnCells,
  unitIncome,
  unitsOf,
  upgradeCostOf,
  utype,
  visionOf,
} from '../core/rules.ts';
import type { GameState, PlayerId, Unit, UnitTypeDef } from '../core/types.ts';
import { chimeLabel } from './sound.ts';

export interface PanelInput {
  view: PlayerView;
  me: PlayerId;
  selectedUnit: Unit | null;
  selectedCityId: string | null;
  /** 选中的军营（自己的军营点开就是产兵面板） */
  selectedCampId: string | null;
  /** 点空地时选中的地形，用来显示地形说明 */
  selectedTile: { x: number; y: number } | null;
  /**
   * 强制模式的当前档位（null = 没开）。
   *
   * 它是**持续**的模式，不是"给下一次点击上膛"：开着的时候棋盘上的点击
   * 只按这一个动词解释，不选中、不下别的指令，再点一次按钮才退出。
   * 和按住 Alt/Shift 是两条路——键盘党按修饰键（一次性），
   * 触屏和鼠标党点这两个按钮。状态放在 main 里，面板只负责显示"现在是哪一档"。
   */
  forceMode?: 'move' | 'attack' | null;
  /** 撤回栈里还有没有东西（联机局提交过也会清空）；不传按 false 处理 */
  canUndo?: boolean;
  /** 回合提示音的音量（0~1），按钮上直接显示档位 */
  chimeVolume?: number;
  /**
   * 产兵搜索框里的字。
   *
   * 高时代一屏能站四十多个兵种，靠滚动找"长弓手"要翻半天。
   * 这里只做**过滤**，不改变"能买什么"——可买集合仍然由时代和编制决定。
   */
  recruitQuery?: string;
  /**
   * 按扩展包筛选产兵列表。
   *
   * 空串 = 全部；`core` = 原版兵种；其它值是扩展 id。
   * 和搜索框是"与"的关系：搜 "弓" + 只看「奇想·骑士」，就是那个包里名字带弓的。
   */
  recruitPack?: string;
  /**
   * 战报用谁的眼睛看：给一个 PlayerId 就只看这一方（+ 公开的战损），
   * 给 null 就是全都看得见。不传按"全都看得见"处理。
   *
   * 为什么要和 `me` 分开：热座是一台机器两个人轮流玩，
   * 谁都没有理由被蒙在鼓里，那时候 me 仍然是某一方，但战报该全给。
   */
  logSide?: PlayerId | null;
  /**
   * 正在给水军选下水点：给的是"正在等位置的那个兵种"。
   *
   * 临水的城挨着好几片水时，光按产兵按钮不知道该从哪片下水，所以先上膛、
   * 把可选格点亮，玩家点哪格就从哪格出。这个字段只用来写提示语。
   */
  spawnPick?: { type: string } | null;
  /**
   * 观战位：两边都不归我。
   *
   * 只有这一条开关是不够的——必须**同时**让 `mine` 全线失效，
   * 否则 me()='A' 会让 A 方的单位长出一整排"产兵/建造/拆除"按钮，
   * 点下去再被规则挡住，体验上等于一个坏掉的界面。
   */
  spectator?: boolean;
  /**
   * 指挥官模式：走位与开火归 AI，棋盘只剩"看"。
   *
   * 和 spectator 一样让 `mine` 全线失效（否则己方单位会长出一整排按钮，
   * 点下去再被规则挡住，等于一个坏掉的界面），区别只在提示文案：
   * 观战是"两边都不归我"，指挥官是"归我，但这一手不亲自下"。
   */
  commander?: boolean;
  /**
   * 结算卡上的「对局数据」区块。只有一局打完才传，别的时候是 undefined。
   *
   * 默认关：上传对局数据这件事必须玩家自己勾、自己点，
   * 而且点之前得先看见"要交出去的是哪些东西"。
   */
  report?: PanelReport;
}

export interface PanelReport {
  /** 「允许上传对局数据」这个开关本身，存在本机、跨对局保留 */
  optedIn: boolean;
  status: 'idle' | 'sending' | 'done' | 'failed';
  /** 上传结果的具体结论，原样显示——不要只说"出错了" */
  note?: string;
  /** 失败之后玩家还能做什么 */
  howTo?: string;
  /**
   * 这一局有没有逐回合摘要，以及规模。
   *
   * 空字符串 = 这局没开详细记录（只交终局快照）。有值时显示成一行，
   * 让玩家知道"我同意交的东西比上次多了什么"，而不是悄无声息地变大。
   */
  detail?: string;
}

/**
 * 侧栏最近一次写下去的 HTML。
 *
 * 一帧里侧栏的开销几乎全在"把这些字符串变成 DOM"上（实测 32×32：整段 1.7ms，
 * 其中拼字符串只有 0.05ms）。而大部分 render 的触发和侧栏无关——棋盘上换了选中、
 * 顶栏换了回合、AI 走了一步但金币和战报都没动。内容一模一样还重写一遍，
 * 等于每帧白扔一百多个节点，还把滚动位置和正在输入的搜索框一起弄没。
 *
 * 所以先拼、后比、一样就不写。判"一样"用的是拼出来的整串，不是另做一份摘要：
 * 摘要漏一个字段就会让面板停在旧内容上，那种 bug 比慢难查得多。
 */
const panelHtmlCache = new WeakMap<HTMLElement, string>();

/**
 * 让缓存作废。
 *
 * 侧栏被别人直接写过之后必须调一次（上帝模式的兵种货架就是这么干的）：
 * 缓存里留着"上一次的普通面板"，下一帧内容碰巧一样就会跳过写入，
 * 货架会一直挂在屏幕上，而状态里一切正常——这类 bug 极难复现。
 */
export function invalidatePanel(el: HTMLElement): void {
  panelHtmlCache.delete(el);
}

export function renderPanel(el: HTMLElement, input: PanelInput): void {
  const html = panelHtml(input);
  // firstChild 一起看：侧栏被清空过（但没走 invalidatePanel）时不能凭缓存跳过
  if (panelHtmlCache.get(el) === html && el.firstChild) return;
  panelHtmlCache.set(el, html);
  el.innerHTML = html;
}

function panelHtml(input: PanelInput): string {
  const { view, me } = input;
  const s = view.state;
  /**
   * 「浓雾蔽野」把"看不清对面"当成规则本身，钱袋也得跟着看不见。
   *
   * 只看数量不给数字：雾里连地形都要走一遍才记得住，隔壁还剩多少钱更不该
   * 摆在 HUD 上——那等于免费送一份"他还能不能再买一队兵"的情报，
   * 玩家照着这个数决定要不要趁现在压过去，雾就白做了。
   * 观战位例外：它本来就是全图视角（顶栏写着"全图视角"），遮一半反而自相矛盾。
   */
  const blackout = s.config.expansionIds.includes('blackout');
  const hideEnemyGold = (p: PlayerId) => blackout && p !== me && input.spectator !== true;

  // HUD 里的资源行：金币永远显示，其余资源只在"真的存在"时出现。
  // 原版只玩金币，多出来的空徽章只会让面板看起来像坏了。
  const resLine = (p: PlayerId) => {
    const ps = s.players[p];
    const parts = [
      hideEnemyGold(p)
        ? '<span title="「浓雾蔽野」下打探不到对面的钱袋">金币 ?</span>'
        : `金币 ${ps.gold}`,
    ];
    for (const [id, n] of Object.entries(ps.res ?? {})) {
      if (!n || n <= 0) continue;
      if (id === 'gold') continue;
      parts.push(`${resourceShort(id)} ${n}`);
    }
    return parts.join(' · ');
  };
  const spectator = input.spectator === true;
  /** 只看不给动：观战位和指挥官模式都算，后面所有 `mine` 都挂在它上面 */
  const readOnly = spectator || input.commander === true;
  const other: PlayerId = me === 'A' ? 'B' : 'A';
  const myTurn = !spectator && s.current === me && !s.winner;

  const myCities = s.cities.filter((c) => c.owner === me).length;
  const otherCities = s.cities.filter((c) => c.owner === other).length;

  const turnBadge = s.winner
    ? `<span class="turn-badge">对局结束</span>`
    : spectator
      ? `<span class="turn-badge watching">观战中 · 全图视角</span>`
      : `<span class="turn-badge active-${s.current}">
         ${s.current === me ? '轮到你行动' : `等待 ${s.players[s.current].name}`}
       </span>`;

  const detail = renderDetail(input, myTurn);
  const logHtml = renderLog(input);

  // 蛋等着落位：这条提示必须显眼。它是"你的回合被暂停了"的状态，
  // 不写在最上面的话，玩家会以为点了没反应。
  const egg = s.pendingEgg;
  const eggMine = !!egg && !readOnly && egg.owner === me && s.current === me;
  const eggBanner = !egg
    ? ''
    : `<div class="card" style="border-color:#c9a227">
         <div class="card-title">${eggMine ? '选一格孵化' : '蛋在等着'}</div>
         <div class="hint">${
           eggMine
             ? `不死鸟的蛋落在 ${String.fromCharCode(65 + egg.x)}${egg.y + 1} 附近。点棋盘上的橙格放它，孵化后带 ${Math.round(egg.hpRatio * 100)}% 生命。`
             : `${s.players[egg.owner].name} 手里还有一枚没孵化的蛋。`
         }</div>
       </div>`;

  const activeNames = s.config.expansionIds
    .map((id) => expansionById(id)?.name)
    .filter((n): n is string => !!n);
  const expansionText = activeNames.length > 0 ? activeNames.join(' · ') : '无';

  return `
    <div class="card">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px">
        ${turnBadge}
        <span class="hint">第 ${s.turn} 次行动</span>
      </div>
      <div style="margin-top:12px">
        <div class="versus">
          <div class="vs-side">
            <div class="vs-name"><span class="vs-dot a"></span>${s.players.A.name}</div>
            <div class="vs-stats">${resLine('A')}<br />城市 ${me === 'A' ? myCities : otherCities}</div>
          </div>
          <div class="vs-mid">VS</div>
          <div class="vs-side right">
            <div class="vs-name">${s.players.B.name}<span class="vs-dot b"></span></div>
            <div class="vs-stats">${resLine('B')}<br />城市 ${me === 'B' ? myCities : otherCities}</div>
          </div>
        </div>
      </div>
      <div class="meta-line">${s.fog ? '迷雾开启' : '迷雾关闭'} · 棋盘 ${s.w}×${s.h}</div>
      <div class="meta-line">扩展：${escapeHtml(expansionText)}</div>
    </div>

    ${eggBanner}

    ${renderReport(s, input.report)}

    <div class="card">${detail}</div>

    <div class="card">
      <div class="card-title">战报</div>
      ${logHtml}
    </div>

    <div class="side-footer">
      <button class="btn btn-primary btn-block" data-act="end-turn" ${myTurn ? '' : 'disabled'}>
        ${myTurn ? '结束行动，交给对方' : spectator ? '观战中 · 只能看' : '等待对方行动中'}
      </button>
      <div class="side-actions">
        <button class="btn btn-sm" data-act="undo" ${input.canUndo === true && myTurn ? '' : 'disabled'}>撤回一步</button>
        <button class="btn btn-sm btn-quiet-danger" data-act="surrender" ${myTurn ? '' : 'disabled'}>认输</button>
      </div>
      <button class="btn btn-sm btn-block" data-act="chime">${chimeLabel(input.chimeVolume ?? 0.6)}</button>
      <div class="hint" style="text-align:center">
        ${
          spectator
            ? '这是全图视角：双方的伏兵和金币都看得见。别在两个人还在打的时候念出来。'
            : '每一步都会自动存档，随时可以关掉页面'
        }
      </div>
    </div>
  `;
}

/**
 * 结算卡上的「这局的数据要不要捐出来」。
 *
 * 三件事必须同时成立，玩家才可能真的愿意点：
 *   1) 默认是关的，勾选只代表"允许"，点上传才真的发；
 *   2) 发之前把要发什么摊开写清楚——种子、回合数、双方阵容，一条条列；
 *   3) 失败的时候说清楚是哪一步不对（没开通 / 凭据过期 / 网络不通），
 *      并且报告始终能复制、能下载，不会因为传不上去就白打一局。
 *
 * 沙盒和观战位不出现这个区块（数据没意义 / 不是你的对局），由调用方挡掉。
 */
function renderReport(s: GameState, info: PanelInput['report']): string {
  if (!info) return '';
  const rep = buildMatchReport(s);
  const winnerText = rep.winner ? `${rep.winner} 方胜` : '还没有胜者';
  const roster = (x: ReportSide): string => {
    const list = Object.entries(x.roster)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([id, n]) => `${s.unitTypes[id]?.name ?? id}×${n}`);
    return list.length > 0 ? list.join('、') : '没有兵了';
  };

  const busy = info.status === 'sending';
  const canSend = info.optedIn && !busy && info.status !== 'done';
  const status =
    info.status === 'sending'
      ? '<div class="hint report-status">正在上传…</div>'
      : info.status === 'done'
        ? `<div class="hint report-status done">${escapeHtml(
            info.note ?? '已上传，谢谢。这批数据会用来调 AI 和兵种数值。',
          )}</div>`
        : info.status === 'failed'
          ? `<div class="hint report-status failed">${escapeHtml(info.note ?? '没传上去')}</div>${
              info.howTo ? `<div class="hint report-howto">${escapeHtml(info.howTo)}</div>` : ''
            }`
          : '';

  return `<div class="card report-card">
    <div class="card-title">这局的数据要不要捐出来</div>
    <div class="hint">
      打完的局能帮上忙：哪个兵种偏贵、哪套扩展一开就一边倒，光靠自己打的几十局是看不出来的。
      这些数据只用于<b>调整数值、改进 AI</b>，也可能用于<b>训练模型</b>或发布<b>聚合统计</b>
      （不会公开单条记录）。勾上只是"允许"，点下面的按钮才真的发出去。
    </div>
    <ul class="report-list">
      <li>地图种子 ${rep.seed} · ${rep.board.w}×${rep.board.h} · ${rep.turns} 次行动 · ${winnerText}</li>
      <li>${rep.expansions.length > 0 ? `扩展 ${rep.expansions.length} 个` : '没有开扩展'} · 兵种表 ${rep.packSize} 个${
        rep.ai.opponent || rep.ai.ally ? ` · AI ${rep.ai.level === 'basic' ? '初级' : '高级'}` : ''
      }</li>
      <li>${rep.sides
        .map((x) => `${x.side} 方 ${x.cities} 城 / ${x.units} 兵 / 最高时代 ${x.eras[0] ?? '-'}`)
        .join('　')}</li>
      <li>阵容：${rep.sides.map((x) => `${x.side} 方 ${roster(x)}`).join('；')}</li>
    </ul>
    ${
      info.detail
        ? `<div class="hint report-detail">这局还记了逐回合摘要：${escapeHtml(info.detail)}</div>`
        : ''
    }
    <div class="hint report-privacy">
      不含玩家名、房间码、操作流水。会上传一个<b>随机浏览器代号</b>（只用于限流和去重，
      不关联任何账号）。提交后<b>无法单独撤回</b>——系统不知道哪条是你的。
    </div>
    <label class="report-opt">
      <input type="checkbox" data-act="report-opt" ${info.optedIn ? 'checked' : ''} />
      <span>允许上传对局数据（存在本机，随时可以取消）</span>
    </label>
    <div class="report-actions">
      <button class="btn btn-sm btn-primary" data-act="report-upload" ${canSend ? '' : 'disabled'}>${
        info.status === 'done' ? '已上传' : '匿名上传这局'
      }</button>
      <button class="btn btn-sm" data-act="report-copy">复制报告</button>
      <button class="btn btn-sm" data-act="report-download">下载 .json</button>
    </div>
    ${status}
  </div>`;
}

/**
 * 英雄技能菜单。
 *
 * 长得和"可建造""产兵"一样，因为它们回答的是同一类问题：
 * "这一回合，我手上这几个人能做什么"。冷却是灰按钮，不是不显示——
 * 玩家要知道"再等一回合"，而不是以为技能丢了。
 */
function heroSkillBlock(s: GameState, units: Unit[]): string {
  const rows: string[] = [];
  for (const u of units) {
    const def = utype(s, u.type);
    if (!def.skills || def.skills.length === 0) continue;
    for (const k of heroSkillsOf(s, u)) {
      rows.push(
        `<button class="recruit-btn" data-act="hero-skill" data-id="${u.id}" data-skill="${k.def.id}" ${k.ready ? '' : 'disabled'}>
           <span class="unit-chip ${u.owner === 'A' ? 'a' : 'b'}" style="width:26px;height:26px;font-size:12px">${def.short}</span>
           <span class="meta"><b>${def.name} · ${k.def.name}</b><span>${escapeHtml(k.def.summary)}</span></span>
           <span class="price">${k.ready ? '就绪' : `${k.cd} 回合`}</span>
         </button>`,
      );
    }
  }
  if (rows.length === 0) return '';
  return `<div class="card-title" style="margin-top:14px">英雄技能</div>
    <div class="recruit-list">${rows.join('')}</div>
    <div class="hint" style="margin-top:8px">技能不占行动，每个英雄每回合最多一次。冷却中的按钮会显示还要等几回合。</div>`;
}

function renderDetail(input: PanelInput, myTurn: boolean): string {
  const { view, me, selectedUnit, selectedCityId, selectedCampId, selectedTile } = input;
  const s = view.state;
  /** 没开「季节与气候」的局里，天气相关的块一律不出现——不留一排"温和" */
  const weatherOn = s.config.expansionIds.includes('seasons');

  // 军营：自己点开就是产兵面板，跟城市那套是一回事
  if (selectedCampId) {
    return renderCamp(input, myTurn);
  }

  if (selectedCityId) {
    return renderCity(input, myTurn);
  }

  if (selectedTile) {
    const tile = s.tiles[selectedTile.y * s.w + selectedTile.x];
    if (tile) {
      const info = TERRAIN_INFO[tile.terrain];
      const lines = describeTerrain(tile.terrain, s);
      const coord = `${String.fromCharCode(65 + selectedTile.x)}${selectedTile.y + 1}`;
      return `
        <div class="unit-head">
          <div class="unit-chip" style="border-radius:8px;background:#8b8477">地</div>
          <div>
            <div class="unit-title">${info.name}</div>
            <div class="unit-sub">坐标 ${coord}</div>
          </div>
        </div>
        <div class="info-row"><span>进入消耗</span><b>${info.cost}</b></div>
        <div class="info-row"><span>防御加成</span><b>${info.defense}</b></div>
        ${
          weatherOn
            ? `<div class="card-title" style="margin-top:12px">这里的天气</div>
               ${weatherBlock(climateAt(s, selectedTile.x, selectedTile.y))}`
            : ''
        }
        <div class="unit-notes">${lines.map((l) => `<div>· ${l}</div>`).join('')}</div>
      `;
    }
  }

  if (selectedUnit) {
    const def = utype(s, selectedUnit.type);
    const ratio = selectedUnit.hp / def.maxHp;
    const spectator = input.spectator === true;
    const readOnly = spectator || input.commander === true;
    const mine = !readOnly && selectedUnit.owner === me;
    // 残兵不给钱，按钮上就得写清楚——"回收 0 金"看着像程序出错
    const refund = disbandRefundOf(s, selectedUnit);
    const status: string[] = [];
    if (spectator) {
      status.push('观战中 · 仅查看');
    } else if (mine) {
      if (!selectedUnit.moved) status.push('可移动');
      if (!selectedUnit.acted) status.push('可攻击');
      if (selectedUnit.moved && selectedUnit.acted) status.push('本回合已行动完毕');
    } else {
      // 别人的单位只给看：兵种一多，临场查对面射程/护甲是刚需，
      // 但这张卡上不该出现任何能按的东西
      status.push(
        input.commander === true && selectedUnit.owner === me
          ? '指挥官模式 · 走位归 AI，可遣散'
          : `${s.players[selectedUnit.owner].name}单位 · 仅查看`,
      );
    }

    // 建造单位：列出它能盖的东西，点了就进选址模式
    const buildables = (def.builds ?? [])
      .map((id) => s.unitTypes[id])
      .filter((x): x is UnitTypeDef => !!x);
    const notes = describeUnit(s, def);
    const noteBlock =
      notes.length === 0
        ? ''
        : `<div class="unit-notes">${notes.map((n) => `<div>· ${n}</div>`).join('')}</div>`;
    /**
     * 遣散：指挥官模式下也留着。
     *
     * 走位和开火归 AI，但"这个兵还留不留"是经济决定——造多了占着路口、
     * 或者想腾出钱去升时代，撤回四成该由玩家自己拍板。规则层本来就允许
     * （只看是不是你的、船里有没有货），先前是界面拿 `mine` 一刀切掉了。
     */
    const canDisband = !spectator && selectedUnit.owner === me && myTurn;
    const canBuildNow = mine && !selectedUnit.acted;
    // 建造清单只在"自己的单位"上出现：对敌方展示一份点不动的建造菜单没有意义
    const buildBlock =
      buildables.length === 0 || !mine
        ? ''
        : `<div class="card-title" style="margin-top:14px">可建造</div>
           <div class="recruit-list">${buildables
             .map((b) => {
               const price = recruitResCost(s, me, b);
               const dis = !canBuildNow || !canPay(s.players[me], price);
               const tag = b.bridges
                 ? '架在水上 · 双向通行'
                 : b.barracks
                   ? `能产兵 · ${(b.buildOn ?? []).map((t) => CONFIG.terrainName[t]).join('/')}${
                       b.requiresWater ? ' · 必须临水' : ''
                     }`
                   : b.autoAttack
                     ? `自动开火 ${b.range} 格`
                     : b.incomeByTerrain || b.income || b.yield
                       ? `产出 ${yieldShort(b)}`
                       : '工事';
               // 建造难度和驻军是"看不见但决定怎么用"的两条，必须写在按钮上：
               // 一个要投两回合才成型的塔，玩家在第一回合就得知道它现在是块工地。
               // 点数后面跟的是"这个工兵要几回合"，因为玩家真正关心的是工期，
               // 而工期取决于谁去修——这正是建造点数要表达的东西。
               const mods: string[] = [];
               const need = buildCostOf(b);
               const power = buildPowerOf(def);
               mods.push(
                 need <= power
                   ? `建造 ${need} 点 · 当回合完工`
                   : `建造 ${need} 点 · 施工 ${Math.ceil(need / power)} 回合`,
               );
               if ((b.footprint ?? 1) > 1) mods.push('占 2×2');
               if (b.garrison) mods.push('可驻军');
               const tagLine = mods.length > 0 ? `${tag} · ${mods.join(' · ')}` : tag;
               return `<button class="recruit-btn" data-act="build" data-type="${b.id}" ${dis ? 'disabled' : ''}>
                 <span class="unit-chip ${me === 'A' ? 'a' : 'b'}" style="width:26px;height:26px;font-size:12px">${b.short}</span>
                 <span class="meta"><b>${b.name}</b><span>攻 ${b.atk} · 甲 ${b.armor} · 血 ${b.maxHp} · ${tagLine}</span></span>
                 <span class="price">${costLabel(price)}</span>
               </button>`;
             })
             .join('')}</div>
           <div class="hint" style="margin-top:8px">建造要占掉这个单位的整回合，选址范围 ${CONFIG.buildRange} 格。</div>`;

    // 运输船：装卸是它唯一会做的事，所以单独开一块，写清载了谁、还能装几个
    const cargo = selectedUnit.cargo ?? [];
    const cap = def.capacity ?? 0;
    const cargoBlock = !def.transport
      ? ''
      : `<div class="card-title" style="margin-top:14px">货舱 ${cargo.length} / ${cap}</div>
         <div class="hint">${
           cargo.length === 0
             ? '空船。贴着岸边走，把陆军接上来。'
             : cargo.map((u) => `${utype(s, u.type).name}（${u.hp}）`).join(' · ')
         }</div>
         <div class="recruit-list" style="margin-top:8px">
           <button class="recruit-btn" data-act="load" ${!mine || selectedUnit.acted || cargo.length >= cap ? 'disabled' : ''}>
             <span class="unit-chip ${me === 'A' ? 'a' : 'b'}" style="width:26px;height:26px;font-size:12px">装</span>
             <span class="meta"><b>装载</b><span>把贴身的陆军接上船（占掉它这一回合）</span></span>
             <span class="price">—</span>
           </button>
           ${
             cargo.length === 0
               ? ''
               : `<button class="recruit-btn" data-act="unload" ${!mine || selectedUnit.acted ? 'disabled' : ''}>
                    <span class="unit-chip ${me === 'A' ? 'a' : 'b'}" style="width:26px;height:26px;font-size:12px">卸</span>
                    <span class="meta"><b>卸载</b><span>放到船边一格空地，下船后本回合不能再动</span></span>
                    <span class="price">—</span>
                  </button>`
           }
         </div>`;

    // 站在自家军营上的兵：点击优先选中兵（否则那个兵会被建筑盖住、再也选不中），
    // 所以军营的产兵面板要在这里留一个入口。
    const under = buildingAt(s, selectedUnit.x, selectedUnit.y);
    const underCampDef = under ? utype(s, under.type) : null;
    const underCamp =
      under && !readOnly && under.owner === me && underCampDef?.barracks ? under : null;

    // ── 真实数值 ──
    // 面板数字必须和结算同源：effectiveStats 把光环、击杀成长、威吓、
    // 狂暴、哀兵必胜、地形、诅咒、扩展改甲全部算进去，
    // movePower/visionOf 则是移动力和视野的同一个真相源。
    // 面板再也不显示"裸装"数值——玩家对不上账，比没有数字更糟。
    const eff = effectiveStats(s, selectedUnit);
    const vision = visionOf(s, selectedUnit);
    const income = unitIncome(s, selectedUnit);
    const signed = (n: number): string => (n > 0 ? `+${n}` : String(n));
    const modRow = (scope: string, it: { label: string; delta: number }): string =>
      `<div class="info-row stat-mod"><span>${scope} · ${it.label}</span><b class="${
        it.delta >= 0 ? 'up' : 'down'
      }">${signed(it.delta)}</b></div>`;
    const atkChanged = eff.atk !== eff.atkBase;
    const armorChanged = eff.armor !== eff.armorBase;
    // 只有一个数被改过时，括号里必须点名是哪一个——不写"甲基础 1"的话，
    // "3 / 4（基础 1）"看起来像是攻击也变成了 1
    const baseNote =
      atkChanged && armorChanged
        ? `（基础 ${eff.atkBase} / ${eff.armorBase}）`
        : atkChanged
          ? `（攻基础 ${eff.atkBase}）`
          : armorChanged
            ? `（甲基础 ${eff.armorBase}）`
            : '';
    const statModBlock =
      eff.atkItems.length + eff.armorItems.length > 0
        ? `<div class="stat-mods">${eff.atkItems.map((it) => modRow('攻', it)).join('')}${eff.armorItems
            .map((it) => modRow('甲', it))
            .join('')}</div>`
        : '';

    return `
      <div class="unit-head">
        <div class="unit-chip ${selectedUnit.owner === 'A' ? 'a' : 'b'}">${def.short}</div>
        <div>
          <div class="unit-title">${def.name}</div>
          <div class="unit-sub">${s.players[selectedUnit.owner].name} · ${status.join(' / ')}</div>
        </div>
      </div>
      ${
        underCamp
          ? `<button class="btn btn-sm btn-block" data-act="open-camp" data-id="${underCamp.id}" style="margin-top:10px">
              打开脚下的军营（${underCampDef?.name}）
             </button>`
          : ''
      }
      <div class="hpbar"><i style="width:${ratio * 100}%;background:${barColor(ratio)}"></i></div>
      <div class="info-row"><span>生命</span><b>${selectedUnit.hp} / ${def.maxHp}</b></div>
      <div class="info-row">
        <span>攻击 / 护甲</span>
        <b>${eff.atk} / ${eff.armor}${baseNote}</b>
      </div>
      ${statModBlock}
      <div class="info-row"><span>移动力</span><b>${
        eff.move !== eff.moveBase ? `${eff.move}（基础 ${eff.moveBase}）` : eff.move
      }</b></div>
      <div class="info-row"><span>射程 / 视野</span><b>${def.range} / ${vision}</b></div>
      ${
        // 天气紧跟在"移动力 / 射程 / 视野"后面：这几项正是它改的东西，
        // 放在别处玩家就得自己把两处信息对起来
        weatherOn
          ? `<div class="card-title" style="margin-top:12px">脚下的天气</div>
             ${weatherBlock(climateAt(s, selectedUnit.x, selectedUnit.y))}`
          : ''
      }
      ${income > 0 ? `<div class="info-row"><span>每回合收入</span><b>${income} 金</b></div>` : ''}
      ${
        def.splash
          ? `<div class="info-row"><span>溅射</span><b>主目标 ${def.splash} 格内（不含斜角）· ${Math.round(CONFIG.splashRatio * 100)}%</b></div>`
          : ''
      }
      ${def.burst ? `<div class="info-row"><span>连击</span><b>${def.burst} 段 · 每段独立减甲</b></div>` : ''}
      ${mine && myTurn ? heroSkillBlock(s, [selectedUnit]) : ''}
      ${cargoBlock}
      ${buildBlock}
      ${noteBlock}
      ${
        mine && myTurn
          ? `<div class="force-row">
               <button class="force-btn${input.forceMode === 'move' ? ' armed' : ''}" data-act="force-move">
                 强制移动 <kbd>Alt</kbd>
               </button>
               <button class="force-btn${input.forceMode === 'attack' ? ' armed' : ''}" data-act="force-attack">
                 强制攻击 <kbd>Shift</kbd>
               </button>
             </div>
             <div class="hint" style="margin-top:6px">
               同一格压着多个目标（兵站在自己的塔上、飞行单位停在敌人头顶）时，<b>连点同一格会在它们之间轮换</b>。
               <br /><br />
               走不上桥、或者点不到身下那格时，按<b>强制移动</b>：它会一直扣着，期间点棋盘只有
               "走上去"一种意思（不选中、不下别的指令），再点一次按钮才退出。
               按住 <kbd>Alt</kbd> 点可达格是同样的效果，只是只生效一次。
             </div>`
          : ''
      }
      ${
        canDisband
          ? `<button class="btn btn-sm btn-block btn-quiet-danger" data-act="disband" style="margin-top:12px">
               ${refund > 0 ? `拆除（回收 ${refund} 金）` : '拆除（残兵不回收金币）'}
             </button>`
          : ''
      }
    `;
  }

  // 没选中任何东西时的默认页：把自己的英雄技能摆出来。
  // "每回合像建造那样给一个选择"——不去点单位也能看到今天能开什么。
  const myHeroes =
    input.spectator !== true && myTurn ? unitsOf(s, me).filter((u) => utype(s, u.type).skills) : [];
  const heroBlock = heroSkillBlock(s, myHeroes);

  return `
    ${heroBlock}
    <div class="card-title"${heroBlock ? ' style="margin-top:14px"' : ''}>操作</div>
    <div class="hint">
      点自己的单位 → 蓝色格子是可移动范围，红框是可攻击目标。<br /><br />
      点自己的城市 → 产兵、以及花钱升级时代。升级后能造更高级的兵种，城市也更硬。<br /><br />
      点对方的城市 → 查看它的时代、耐久和护甲。攻城伤害 = 攻击 − 城市护甲。<br /><br />
      点任何一块空地 → 看这块地形能干什么、适合谁站。<br /><br />
      同一格有好几个东西时，连点会轮换选中；选中自己的兵之后，侧栏有两个模式按钮：<br />
      <b>强制移动</b>（<kbd>Alt</kbd>）—— 点可达格就走上去，无视压在上面的棋子（比如走上桥面）；<br />
      <b>强制攻击</b>（<kbd>Shift</kbd>）—— 打身下的目标。<br />
      点按钮进入的模式会一直扣着，期间棋盘只认这一个动作，<b>再点一次按钮才退出</b>；
      按住修饰键则只对下一次点击生效。
    </div>
  `;
}

function renderCity(input: PanelInput, myTurn: boolean): string {
  const { view, me, selectedCityId } = input;
  const s = view.state;
  const city = selectedCityId ? cityById(s, selectedCityId) : undefined;
  if (!city) return '';

  const readOnly = input.spectator === true || input.commander === true;
  const mine = !readOnly && city.owner === me;
  const ratio = city.hp / city.maxHp;
  const era = eraDef(city.era);
  const garrison = unitsOf(s, city.owner).filter((u) =>
    cityTiles(city).some((t) => t.x === u.x && t.y === u.y),
  ).length;
  const freeSlots = city.size * city.size - garrison;
  const gold = s.players[me].gold;

  // 水军要下到城边那一格空水面上去；没有就造不了
  const hasPort = cityTiles(city).some((t) =>
    [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ].some(([dx, dy]) => {
      const nb = s.tiles[(t.y + dy) * s.w + (t.x + dx)];
      // 港口认"船停得下的水面"：深水、桥面、浅流都算（和 navigable 同一条判定，
      // 不然会出现"规则里能下水、面板偏说需要临水"的两张皮）
      return !!nb && navigable(nb.terrain) && !s.units.some((u) => u.x === t.x + dx && u.y === t.y + dy);
    }),
  );

  // 回血：只有"有驻军 + 城外没有敌人"才成立，所以要把当前状态说清楚，
  // 否则玩家只会看到血条不动而不知道为什么
  const regen = cityRegenOf(s, city);
  const besieged = s.units.some(
    (u) => u.owner !== city.owner && distToCity(u, city) <= 1,
  );
  const regenText =
    regen > 0 ? `每回合 +${regen}` : besieged ? '被围城，无法休整' : '城内没有驻军，不回血';

  const upgradeCost = upgradeCostOf(s, city);
  const nextEra = upgradeCost === null ? null : eraDef(city.era + 1);

  // 城里只产"能被派出去的单位"，建筑要用建造单位去盖
  const buildable = Object.values(s.unitTypes).filter(
    (d) =>
      d.category !== 'building' &&
      !d.summonedOnly &&
      d.era <= city.era &&
      d.era >= city.era - 1,
  );
  const locked = Object.values(s.unitTypes).filter((d) => d.era > city.era);

  const unitButton = (def: UnitTypeDef) => {
    const slotsOk = def.domain === 'water' ? hasPort : freeSlots > 0;
    const disabled = !myTurn || !slotsOk;

    let extra = '';
    if (def.incomeByTerrain) {
      const best = Object.entries(def.incomeByTerrain).sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))[0];
      if (best) {
        extra = ` · ${CONFIG.terrainName[best[0] as keyof typeof CONFIG.terrainName]} +${best[1]}`;
      }
    } else if (def.income) {
      extra = ` · +${def.income} 金`;
    }
    if (def.domain === 'water') {
      if (!hasPort) extra += ' · 需要临水';
      else {
        // 能下水的水面不止一格时明说"可选"：不说的话，玩家按下去只看到
        // 船凭空出现在某一格上，永远不知道原来可以挑。
        const cells = recruitSpawnCells(s, city.id, undefined, def.id).length;
        extra += cells > 1 ? ` · ${cells} 处水面可选` : ' · 水上';
      }
    }

    return recruitButton(s, me, def, disabled, extra);
  };

  const q = (input.recruitQuery ?? '').trim();
  const pack = input.recruitPack ?? PACK_ALL;
  const shown = buildable.filter((d) => matchRecruit(d, q) && packOk(d, pack));

  const grouped = (['combat', 'economy', 'builder'] as const)
    .map((cat) => {
      const items = shown.filter((d) => d.category === cat);
      if (items.length === 0) return '';
      return `<div class="recruit-group">
        <div class="recruit-group-title">${CATEGORY_NAME[cat]}</div>
        <div class="recruit-list">${items.map(unitButton).join('')}</div>
      </div>`;
    })
    .join('');

  const recruitGroups =
    shown.length === 0
      ? emptyRecruitHint(q, pack, buildable.length, '这座城')
      : grouped;

  const upgradeBlock =
    mine && nextEra && upgradeCost !== null
      ? `<button class="upgrade-btn" data-act="upgrade" ${!myTurn || gold < upgradeCost ? 'disabled' : ''}>
           <span class="upgrade-main">
             <b>升级到「${nextEra.name}」时代</b>
             <span>耐久 ${city.maxHp} → ${nextEra.cityMaxHp} · 护甲 ${city.armor} → ${nextEra.cityArmor} · 收入 ${era.cityIncome} → ${nextEra.cityIncome}</span>
           </span>
           <span class="price">${upgradeCost}</span>
         </button>`
      : mine
        ? '<div class="hint">已经是最高时代。</div>'
        : '';

  return `
    <div class="unit-head">
      <div class="unit-chip ${city.owner === 'A' ? 'a' : 'b'}" style="border-radius:8px">城</div>
      <div>
        <div class="unit-title">城市 ${cityName(city)}</div>
        <div class="unit-sub">${s.players[city.owner].name} · ${era.name}时代 · 驻军 ${garrison}/${city.size * city.size}</div>
      </div>
    </div>
    <div class="hpbar"><i style="width:${ratio * 100}%;background:${barColor(ratio)}"></i></div>
    <div class="info-row"><span>耐久</span><b>${city.hp} / ${city.maxHp}</b></div>
    <div class="info-row"><span>护甲</span><b>${city.armor}</b></div>
    <div class="info-row"><span>每回合收入</span><b>${era.cityIncome} 金</b></div>
    <div class="info-row"><span>驻军休整</span><b>${regenText}</b></div>
    ${upgradeBlock}
    ${
      mine
        ? `<div class="card-title" style="margin-top:14px">生产</div>
           ${packRow(buildable, pack)}
           ${recruitSearchBox(q, shown.length, buildable.length)}
           ${recruitGroups}
           ${
             input.spawnPick
               ? `<div class="hint" style="margin-top:10px">点棋盘上亮起来的水面，把「${
                   s.unitTypes[input.spawnPick.type]?.name ?? input.spawnPick.type
                 }」放下去。点别处就取消。</div>`
               : ''
           }
           <div class="hint" style="margin-top:10px">
             ${
               freeSlots > 0
                 ? `城内还有 ${freeSlots} 个空位。新兵当回合不能行动，建筑建成即不可移动。`
                 : '城内已站满，先让部队挪一挪。'
             }
             ${
               locked.length > 0
                 ? `<br />升级后可解锁：${locked.map((d) => d.name).join('、')}`
                 : ''
             }
           </div>`
        : `<div class="hint" style="margin-top:12px">
             ${
               input.spectator
                 ? `这是${s.players[city.owner].name}的城市（${era.name}时代），耐久 ${city.hp} / ${city.maxHp}。观战不给操作。`
                 : input.commander === true
                   ? `这是${s.players[city.owner].name}的城市（${era.name}时代），耐久 ${city.hp} / ${city.maxHp}。指挥官模式下产兵按你排的序列走。`
                   : `这是${s.players[city.owner].name}的城市（${era.name}时代），耐久打空才能易主。攻城伤害 = 你的攻击 − ${city.armor}。`
             }
             <br />攻陷后会连同它的时代一起接收。
           </div>`
    }
  `;
}

function barColor(ratio: number): string {
  if (ratio <= 0.3) return '#e07b6b';
  if (ratio <= 0.6) return '#e8c76b';
  return '#7ec47e';
}

/**
 * 兵种来源徽标。
 *
 * 面板里现在同时躺着原版、时代兵和五个奇想包，光看名字分不出"九头蛇"是
 * 哪来的——更要命的是：关掉那个包，它就凭空消失了。标出来最省事。
 * 原版兵种没有徽标（多数，不加噪音）。
 */
function sourceTag(def: UnitTypeDef): string {
  const src = unitSourceOf(def.id);
  if (!src) return '';
  return `<span class="recruit-src" title="来自扩展包「${escapeHtml(src)}」，开局没勾就买不到">${escapeHtml(src)}</span>`;
}

/**
 * 搜兵种：名字、代号、职能、时代、包名都能命中，多词按"且"处理（"奇想 弓"）。
 *
 * 刻意不去搜数值（"攻 20"）：那是筛选器，不是搜索框，两件事混在一起
 * 会让"为什么搜 20 出来一堆"变成新的困惑。
 */
function matchRecruit(def: UnitTypeDef, q: string): boolean {
  if (!q) return true;
  const hay = [
    def.name,
    def.short,
    def.id,
    CATEGORY_NAME[def.category],
    `${eraDef(def.era).name}时代`,
    unitSourceOf(def.id) ?? '',
  ]
    .join(' ')
    .toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((w) => hay.includes(w));
}

/**
 * 产兵列表空掉时那句话。
 *
 * "搜不到"和"这个包里没有"是两种不同的空：前者玩家会去清搜索框，
 * 后者要去点「全部」。只会说"没有可造的兵"等于让人自己猜。
 */
function emptyRecruitHint(q: string, pack: string, total: number, subject: string): string {
  const head =
    q && pack
      ? `没有匹配「${escapeHtml(q)}」的兵种（只看「${escapeHtml(packLabel(pack))}」）`
      : q
        ? `没有匹配「${escapeHtml(q)}」的兵种`
        : pack
          ? `「${escapeHtml(packLabel(pack))}」里没有这一档能造的兵`
          : '没有可造的兵种';
  return `<div class="hint">${head}。${subject}在售 ${total} 种，清掉筛选看全部。</div>`;
}

/**
 * 搜索框。
 *
 * 兵种少于 6 个就不显示——早期城市一共四行，摆个搜索框纯属添乱。
 * 输入框的 value 由 PanelInput 回填，重绘之后字还在（光标在末尾）。
 */function recruitSearchBox(q: string, shownCount: number, total: number): string {
  if (total < 6) return '';
  const count = q ? `${shownCount}/${total}` : `共 ${total} 种`;
  return `<div class="recruit-search">
    <input
      type="search"
      class="recruit-search-input"
      data-act="recruit-search"
      value="${escapeHtml(q)}"
      placeholder="搜兵种：名字 / 代号 / 职能 / 包名"
      autocomplete="off"
      spellcheck="false"
    />
    <span class="recruit-search-count">${count}</span>
  </div>`;
}

/** 建造按钮上"产出 X"那半句：只看兵种表里写了什么，不猜运行时换算 */
function yieldShort(def: UnitTypeDef): string {
  // 只写 yield 的建筑（粮仓、砖窑、建材基地……）产多少就是它的全部卖点，
  // 所以这里印数值而不是只印一个"材"字——建造按钮上那行字是玩家唯一会读的地方。
  if (def.yield) {
    const flat = Object.entries(def.yield)
      .filter(([, n]) => (n ?? 0) > 0)
      .map(([id, n]) => `+${n}${resourceShort(id)}`)
      .join('·');
    if (flat) return flat;
  }
  const ids = new Set<string>();
  if (def.yield) for (const id of Object.keys(def.yield)) ids.add(id);
  if (def.incomeByTerrain || def.income) ids.add('gold');
  return Array.from(ids).map((id) => resourceShort(id)).join('·') || '资源';
}

/** 产兵按钮：城市和军营共用一套写法，省得两处的样式慢慢跑偏 */
function recruitButton(
  s: GameState,
  me: PlayerId,
  def: UnitTypeDef,
  disabled: boolean,
  extra: string,
): string {
  const price = recruitResCost(s, me, def);
  // 英雄的价钱是"造价 + 首次解锁费"，按钮上必须显示合计：
  // 看到 300 金的按钮却扣了 450，玩家只会觉得算错了。
  const unlockFee =
    def.hero === true && !(s.unlocked?.[me] ?? []).includes(def.id) ? (def.unlockCost ?? 0) : 0;
  const aliveHere = def.hero === true && s.units.some((u) => u.owner === me && u.type === def.id);
  const payCost = unlockFee > 0 ? { ...price, gold: (price.gold ?? 0) + unlockFee } : price;
  const blocked = disabled || aliveHere || !canPay(s.players[me], payCost);
  const tag = aliveHere ? ' · 场上已有' : unlockFee > 0 ? ` · 解锁 ${unlockFee}` : '';
  // 血量必须出现在购买清单里：攻甲移射都是"打得怎么样"，血是"挨得怎么样"，
  // 一个新兵站上前线能顶几刀，玩家在按下生产之前就该知道。
  const detail = `攻 ${def.atk} · 甲 ${def.armor} · 血 ${def.maxHp} · 移 ${def.move} · 射 ${def.range}${tag}`;
  return `<button class="recruit-btn" data-act="recruit" data-type="${def.id}" ${blocked ? 'disabled' : ''}>
    <span class="unit-chip ${me === 'A' ? 'a' : 'b'}" style="width:26px;height:26px;font-size:12px">${def.short}</span>
    <span class="meta">
      <b>${def.name}${sourceTag(def)}</b>
      <span>${detail}${extra}</span>
    </span>
    <span class="price">${costLabel(payCost)}</span>
  </button>`;
}

const DIRS_4: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

/**
 * 军营面板。
 *
 * 军营就是"能往前推的产兵点"：产兵规则和城市一模一样，唯一的区别是
 * 它自己没有时代——时代跟着最近的那座己方城市走，城丢了兵就补不上。
 * 所以这里要把"补给来自哪座城、是几级"写清楚，否则玩家不知道为什么
 * 忽然造不出高级兵了。
 */
function renderCamp(input: PanelInput, myTurn: boolean): string {
  const { view, me, selectedCampId } = input;
  const s = view.state;
  const camp = selectedCampId ? s.units.find((u) => u.id === selectedCampId) : undefined;
  if (!camp) return '';

  const def = utype(s, camp.type);
  const readOnly = input.spectator === true || input.commander === true;
  const mine = !readOnly && camp.owner === me;
  const ratio = camp.hp / def.maxHp;

  // 补给：军营的时代在落成那一刻就钉死了（Unit.era），后方城市升级不会
  // 隔空把它带着换代。旧存档没有这个字段，按最近己方城市的时代兜底。
  const own = citiesOf(s, camp.owner);
  const supply = own.reduce<typeof own[number] | null>(
    (a, b) => (!a || distToCity(camp, b) < distToCity(camp, a) ? b : a),
    null,
  );
  const era = camp.era ?? (supply ? supply.era : 0);

  // 兵从四邻出来，所以"能出兵"取决于四邻有多少空地 / 空水面
  const landSlots: Array<{ x: number; y: number }> = [];
  const waterSlots: Array<{ x: number; y: number }> = [];
  for (const [dx, dy] of DIRS_4) {
    const x = camp.x + dx;
    const y = camp.y + dy;
    const t = s.tiles[y * s.w + x];
    if (!t) continue;
    if (s.units.some((u) => u.x === x && u.y === y)) continue;
    if (navigable(t.terrain)) waterSlots.push({ x, y });
    else if (passable(t.terrain)) landSlots.push({ x, y });
  }

  const buildable = Object.values(s.unitTypes).filter(
    (d) =>
      d.category !== 'building' && !d.summonedOnly && d.era <= era && d.era >= era - 1,
  );

  const q = (input.recruitQuery ?? '').trim();
  const pack = input.recruitPack ?? PACK_ALL;
  const shown = buildable.filter((d) => matchRecruit(d, q) && packOk(d, pack));

  const grouped = (['combat', 'economy', 'builder'] as const)
    .map((cat) => {
      const items = shown.filter((d) => d.category === cat);
      if (items.length === 0) return '';
      return `<div class="recruit-group">
        <div class="recruit-group-title">${CATEGORY_NAME[cat]}</div>
        <div class="recruit-list">${items
          .map((d) => {
            const slotsOk = d.domain === 'water' ? waterSlots.length > 0 : landSlots.length > 0;
            const extra =
              d.domain === 'water'
                ? waterSlots.length > 1
                  ? ` · ${waterSlots.length} 处水面可选`
                  : ' · 下水'
                : '';
            return recruitButton(s, me, d, !myTurn || !slotsOk, extra);
          })
          .join('')}</div>
      </div>`;
    })
    .join('');

  const groups =
    shown.length === 0
      ? emptyRecruitHint(q, pack, buildable.length, '这座营')
      : grouped;

  // 军营的时代是写死的。后方城市一旦追上来，玩家会看到"我有三级城，
  // 这座营怎么还只出二级兵"——必须明说这是落成时的时代，不是 bug。
  const staleEra = !!supply && supply.era > era;
  const supplyLine = supply
    ? `补给来自「${cityName(supply)}」· 落成于 ${eraDef(era).name}时代${
        staleEra ? `（后方已到 ${eraDef(supply.era).name}，这座营不跟着换代）` : ''
      }`
    : '没有己方城市，补给断了';

  return `
    <div class="unit-head">
      <div class="unit-chip ${camp.owner === 'A' ? 'a' : 'b'}" style="border-radius:8px">${def.short}</div>
      <div>
        <div class="unit-title">${def.name}</div>
        <div class="unit-sub">${s.players[camp.owner].name} · 前线产兵点</div>
      </div>
    </div>
    <div class="hpbar"><i style="width:${ratio * 100}%;background:${barColor(ratio)}"></i></div>
    <div class="info-row"><span>生命</span><b>${camp.hp} / ${def.maxHp}</b></div>
    <div class="info-row"><span>攻击 / 护甲</span><b>${def.atk} / ${def.armor}</b></div>
    <div class="info-row"><span>自动开火</span><b>${def.range} 格内每回合 ${def.atk} 点</b></div>
    <div class="info-row"><span>补给</span><b>${supplyLine}</b></div>
    ${
      mine && supply
        ? `<div class="card-title" style="margin-top:14px">生产</div>
           ${packRow(buildable, pack)}
           ${recruitSearchBox(q, shown.length, buildable.length)}
           ${groups}
           ${
             input.spawnPick
               ? `<div class="hint" style="margin-top:10px">点棋盘上亮起来的水面，把「${
                   s.unitTypes[input.spawnPick.type]?.name ?? input.spawnPick.type
                 }」放下去。点别处就取消。</div>`
               : ''
           }
           <div class="hint" style="margin-top:10px">
             兵从营门四邻的空地出来（当前 ${landSlots.length} 个空位${
               waterSlots.length > 0 ? `、${waterSlots.length} 格空水面` : ''
             }）。
             <br />军营自己不会升级，时代在落成那一刻就定了——想要新兵，就在新地方再扎一座营。
           </div>`
        : `<div class="hint" style="margin-top:12px">
             ${
               supply
                 ? `这是${s.players[camp.owner].name}的军营。把它打掉，对方就少一个前线补给点。`
                 : '没有城市供养，这座军营已经产不出兵了。'
             }
           </div>`
    }
  `;
}

/**
 * 战报。
 *
 * `logSide` 决定"用谁的眼睛看"：
 *   · 一个 PlayerId —— 只看这一方自己的条目，加上棋盘上看得见的战损
 *     （`open` 标记：兵倒下、桥塌、城破）。对面造了什么、走了哪、攒了多少钱，
 *     对己方来说就是免费视野，没理由给——这也是迷雾做了却不做战报过滤时
 *     最容易漏的一个后门。
 *   · null —— 全都看得见：观战位、双 AI 观战、以及一台机器两个人轮流的热座。
 */
function renderLog(input: PanelInput): string {
  const { view, me } = input;
  const scope = input.logSide === undefined ? null : input.logSide;
  const entries = scope ? view.state.log.filter((e) => e.player === scope || e.open === true) : view.state.log;
  if (entries.length === 0) {
    return scope
      ? '<div class="log-empty">还没有己方战报。你做的事和场上的战损会记在这里。</div>'
      : '<div class="log-empty">还没有战报。走第一步吧。</div>';
  }
  const recent = entries.slice(-14).reverse();
  return `<div class="log">${recent
    .map((e) => {
      const side = e.player === 'A' ? 'a' : 'b';
      const label = e.player === me ? '你' : view.state.players[e.player].name;
      // 战损那条挂个"公开"的小标：读的人得知道"这条对面也看得见"
      const open = e.open === true && scope !== null;
      return `<div class="log-item ${side}${open ? ' open' : ''}"><span class="who">${label}</span>${escapeHtml(e.text)}</div>`;
    })
    .join('')}</div>`;
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
 * 顶部栏。
 *
 * 这里刻意分成"骨架"和"刷新"两半：骨架只插进 DOM 一次，
 * 之后每一步只改文本、class 和 hidden，**绝不重建按钮节点**。
 *
 * 为什么这么较真：AI 托管时每一步都会 render，如果 topbar.innerHTML 每次重写，
 * 浏览器在 mousedown 和 mouseup 之间就把按钮换成了新节点，
 * 于是 click 事件根本不会派发——表现就是"AI 一跑，什么按钮都点不动"。
 */
export interface TopbarState {
  fog: boolean;
  /** 勾了「浓雾蔽野」：迷雾锁定开启，顶栏那个开关要禁用 */
  blackout: boolean;
  turn: number;
  /** 季节条文案；null 表示这一局没开「季节与气候」 */
  season: string | null;
  current: PlayerId;
  currentName: string;
  /** 当前行动方是不是 AI 在走 */
  aiCurrent: boolean;
  /** AI 的档位显示名：'初级 AI' / '高级 AI'。顶栏只有一小块地方，别写全句 */
  aiLevelName: string;
  /** 是否有任一方交给 AI（有才显示暂停/速度） */
  aiAny: boolean;
  paused: boolean;
  speedName: string;
  /** 联机房间码；null 表示本机对局 */
  roomCode: string | null;
  /** 联机里轮到对方了，正在等他提交 */
  waitingForPeer: boolean;
  /** 观战位：既不是等对方，也不是轮到我 */
  spectator?: boolean;
  /** 上帝模式：全图无雾，两边都归玩家摆，所以"轮到谁"不是重点 */
  god?: boolean;
}

/**
 * 天气徽标：图标 + 中文名。
 *
 * `w-<id>` 这个 class 让每种气候有自己的底色，一眼能分冷暖和干湿；
 * 颜色只是辅助，名字和数值才是准的（色弱玩家也得读得懂）。
 */
export function weatherBadge(c: Climate): string {
  return `<span class="weather-badge w-${c}">${CLIMATE_ICON[c]} ${CLIMATE_NAME[c]}</span>`;
}

/**
 * 天气说明块：徽标 + 逐条效果。
 *
 * 效果文字从效果表派生（见 info.ts 的 climateEffectLines），
 * 所以这里不用维护第二份文案。
 */
export function weatherBlock(c: Climate): string {
  const lines = climateEffectLines(c);
  const body =
    lines.length === 0
      ? `<div class="weather-none">这一格没有额外影响。</div>`
      : `<div class="unit-notes">${lines.map((l) => `<div>· ${l}</div>`).join('')}</div>`;
  return `<div class="weather-box">${weatherBadge(c)}${body}</div>`;
}

/** 季节条：顶栏常驻，显示"现在是哪一季、还有几回合换季" */
export function seasonLabel(turn: number): string {
  const season = seasonOf(turn);
  const left = SEASON_TURNS - ((Math.max(1, turn) - 1) % SEASON_TURNS);
  return `${SEASON_NAME[season]} · 剩 ${left} 回合`;
}

export function topbarShell(): string {
  return `
    <div class="brand">方格战棋 <small>回合制 · 1v1</small></div>
    <div class="turn-chip" title="当前行动方">
      <b data-ref="turn"></b>
      <span class="side-dot a" data-ref="dot"></span>
      <span data-ref="who"></span>
    </div>
    <span class="weather-chip" data-ref="season" title="季节：每 10 回合换一季" hidden></span>
    <button class="room-pill" data-act="online" data-ref="room" title="当前房间" hidden></button>
    <div class="topbar-spacer"></div>
    <div class="topbar-actions">
      <button class="btn btn-sm" data-act="ai-pause" data-ref="pause" hidden>暂停 AI</button>
      <button class="btn btn-sm" data-act="ai-speed" data-ref="speed" hidden>速度</button>
      <button class="btn btn-sm" data-act="toggle-ai" data-ref="toggle-ai">交给 AI</button>
      <button class="btn btn-sm" data-act="online">联机</button>
      <button class="btn btn-sm" data-act="toggle-fog" data-ref="fog">迷雾：开</button>
      <button class="btn btn-sm" data-act="manual">规则书</button>
      <button class="btn btn-sm" data-act="unit-editor">兵种编辑器</button>
      <button class="btn btn-sm" data-act="export">导出对局</button>
      <button class="btn btn-sm" data-act="import">导入对局</button>
      <button class="btn btn-sm" data-act="new-game">新对局</button>
    </div>
  `;
}

/**
 * 顶栏内容的签名。变了才重写，没变就整段跳过。
 *
 * `render()` 每帧都调它，但顶栏这十几个文字一回合只变几次：回合数、谁在走、
 * 有没有 AI、房间码……全是标量，拼个签名比逐处 `textContent =` 便宜一个数量级。
 *
 * 返回值是"真的改过"，调用方据此决定要不要重新算"顶栏还能不能往两边滚"——
 * 那个判断要读 `scrollWidth`，是一笔强制布局，不能每帧都付。
 */
const topbarSigs = new WeakMap<HTMLElement, string>();

export function updateTopbar(root: HTMLElement, s: TopbarState): boolean {
  const sig = [
    s.turn,
    s.season ?? '',
    s.current,
    s.currentName,
    s.aiCurrent ? 1 : 0,
    s.aiLevelName,
    s.aiAny ? 1 : 0,
    s.paused ? 1 : 0,
    s.speedName,
    s.roomCode ?? '',
    s.waitingForPeer ? 1 : 0,
    s.spectator ? 1 : 0,
    s.god ? 1 : 0,
    s.fog ? 1 : 0,
    s.blackout ? 1 : 0,
  ].join('|');
  if (topbarSigs.get(root) === sig) return false;
  topbarSigs.set(root, sig);

  const ref = (name: string) => root.querySelector<HTMLElement>(`[data-ref="${name}"]`);

  const turn = ref('turn');
  if (turn) turn.textContent = `第 ${s.turn} 回合`;

  // 季节：天气是逐格的，顶栏只放"现在换算哪一季"这个全局事实；
  // 具体这一格是什么天气，留给侧栏（选中单位 / 格子时显示）。
  const season = ref('season');
  if (season) {
    season.hidden = !s.season;
    if (s.season) season.textContent = s.season;
  }

  const dot = ref('dot');
  if (dot) dot.className = `side-dot ${s.current === 'A' ? 'a' : 'b'}`;

  const who = ref('who');
  if (who) {
    who.textContent = s.god
      ? '上帝模式 · 全图'
      : s.spectator
        ? '观战 · 全图'
        : s.waitingForPeer
          ? '等待对方提交'
          : s.currentName + (s.aiCurrent ? ` · ${s.aiLevelName}` : '');
  }

  const room = ref('room');
  if (room) {
    room.hidden = !s.roomCode;
    if (s.roomCode) room.textContent = `${s.spectator ? '观战' : '房间'} ${s.roomCode}`;
  }

  const pause = ref('pause');
  if (pause) {
    pause.hidden = !s.aiAny;
    pause.textContent = s.paused ? '继续' : '暂停 AI';
  }

  const speed = ref('speed');
  if (speed) {
    speed.hidden = !s.aiAny;
    speed.textContent = `速度 ${s.speedName}`;
  }

  const ai = ref('toggle-ai');
  if (ai) {
    // 沙盒里"托管某一方"这个开关没有意义：两边本来就归 AI 打，
    // 而顶栏这个按钮会把它变成"回合自动往前跑"，摆兵就摆不安稳了。
    ai.hidden = s.god === true;
    ai.textContent = s.aiCurrent ? '收回操作权' : '交给 AI';
    ai.classList.toggle('btn-primary', s.aiCurrent);
  }

  const fog = ref('fog');
  if (fog) {
    // 浓雾扩展下不给关：这个扩展的全部意义就是"地图本身看不见"，
    // 允许关掉雾等于让它失效
    fog.textContent = s.blackout ? '迷雾：浓雾（锁定）' : `迷雾：${s.fog ? '开' : '关'}`;
    fog.classList.toggle('is-locked', s.blackout);
  }
  return true;
}

export const TERRAIN_NAMES = CONFIG.terrainName;
