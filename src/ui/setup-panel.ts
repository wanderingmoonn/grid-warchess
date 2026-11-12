/**
 * 开始界面。
 *
 * 以前这里只有一页"新对局设置"，所有东西往下摞：规则、时代、兵种、扩展……
 * 再加上后来的固定地图，一条长卷里既装"这一局怎么打"，也装"这局打哪张图"，
 * 两件事混在一起。现在拆成左侧两页：
 *
 *   · 战役——一局怎么打（对手、时代、尺寸、兵种、扩展）；
 *   · 地图——在哪张图上打（内置图、玩家上传的图、上传入口）。
 *
 * 地图那一页是**选**和**传**放在一起的：玩家在这里挑图，作者也在这里交图，
 * 传完的那张立刻出现在同一个画廊里、并且自动被选中——不用再跑去别的面板。
 *
 * 面板只负责收集选择，真正的校验和构建交给 createMatch。
 */

import { ERAS, UNIT_TYPES, eraDef, isPseudoUnit } from '../core/config.ts';
import { allAvailableUnits } from './unit-editor.ts';
import { expansionUnitsFor } from '../core/setup.ts';
import { buildListOf } from '../core/build-list.ts';
import { unitStatLine } from '../core/info.ts';
import {
  EXPANSIONS,
  availableExpansions,
  eraCeilingFor,
  expansionById,
  lockedEraPacks,
} from '../core/expansions.ts';
import { MAP_STYLES, MAP_SYMMETRIES, mapStylesFor, twoCityMinSize } from '../core/mapgen.ts';
import { draftAlwaysAllowed } from '../core/draft.ts';
import {
  MAP_MAX_BYTES,
  MAP_MAX_SIZE,
  MAP_MIN_SIZE,
  TERRAIN_LEGEND,
  allFixedMaps,
  fixedMapById,
  parseMapFile,
  registerUserMaps,
  type FixedMap,
} from '../core/fixed-maps.ts';
import { cachedMaps, listSharedMaps, uploadSharedMap } from '../net/maps.ts';
import { mapThumbSvg } from './map-thumb.ts';
import {
  BOARD_SIZES,
  MAX_BOARD_SIZE,
  MIN_BOARD_SIZE,
  clampBoardSize,
  randomSeed,
} from '../core/setup.ts';
import type { MatchConfig, UnitTypeDef } from '../core/types.ts';

export interface SetupResult {
  config: MatchConfig;
  seed: number;
}

/**
 * 起始时代对应的标准棋盘尺寸。
 *
 * 这是"标准对局"的默认组合：青铜配小图打快棋，火器之后配大图拉开战线。
 * 玩家当然可以手动改尺寸——这里只是把默认值调成匹配的。
 */
export function DEFAULT_SIZE_FOR_ERA(era: number): number {
  if (era <= 1) return 12;
  if (era === 2) return 16;
  return 20;
}

/**
 * 这个开关的选择记住在哪。
 *
 * 不放进 state.config 就够了吗？不够——config 跟着**这一局**走，清存档、换浏览器就没了。
 * 玩家说的"只勾一次"是"以后每次开新局都别再让我勾"，所以单独存一份偏好。
 * 优先级：本机偏好 > 上一局 config > 关。
 */
const RECORD_PREF_KEY = 'warchess.setup.record';

function loadRecordPref(): boolean | null {
  try {
    const raw = localStorage.getItem(RECORD_PREF_KEY);
    return raw === null ? null : raw === '1';
  } catch {
    return null;
  }
}

/** 转义进 HTML 的东西：地图名来自玩家上传，不能直接插进 DOM */
function esc(raw: string): string {
  return raw.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function saveRecordPref(on: boolean): void {
  try {
    localStorage.setItem(RECORD_PREF_KEY, on ? '1' : '0');
  } catch {
    // 隐私模式写不进去：这一次有效，下次回到上一局 config 的值
  }
}

export function openSetupPanel(initial: MatchConfig, seed: number): Promise<SetupResult | null> {
  return new Promise((resolve) => {
    const config: MatchConfig = {
      size: initial.size,
      startEra: initial.startEra,
      aiOpponent: initial.aiOpponent,
      aiAlly: initial.aiAlly,
      aiLevel: initial.aiLevel === 'basic' ? 'basic' : initial.aiLevel === 'tactic' ? 'tactic' : 'advanced',
      // 内核跟着上一局走：连着跟测试 AI 打几局是常态（换阵营再来一把）。
      // 缺省是手写引擎——老存档里没有这个字段，读出来就该是它。
      aiBrain: initial.aiBrain === 'net' ? 'net' : 'script',
      // 人数跟着上一局走：连着开三人局是常态
      playerCount: initial.playerCount ?? 2,
      // 双城市开局跟着上一局走（和"人数"一样，是这一局的设定）
      twoCities: initial.twoCities === true,
      // 时代路线跟着上一局走（面板暂时不提供选择器，留给扩展/调试指定）
      ...(initial.eraRoute ? { eraRoute: initial.eraRoute } : {}),
      // 先手方跟着上一局走：想连打几局都是自己后手，只选一次就够
      firstSide: initial.firstSide === 'B' || initial.firstSide === 'random' ? initial.firstSide : 'A',
      mapStyle: initial.mapStyle ?? 'random',
      mapSymmetry: initial.mapSymmetry ?? 'fair',
      // 固定地图跟着上一局走：同一张图连着打几局是常态（复盘 / 换阵营再来一把）
      fixedMap: initial.fixedMap,
      expansionIds: [...initial.expansionIds],
      enabledUnits: [...initial.enabledUnits],
      // 关掉的兵种是"上一局的选择"的一部分：不抄过来的话，每次开新局
      // 兵种池都会回到"扩展兵全开"的默认状态，那个开关等于一次性的。
      disabledUnits: [...(initial.disabledUnits ?? [])],
      commanderMode: initial.commanderMode === true,
      godMode: initial.godMode === true,
      draftMode: initial.draftMode === true,
      // 两档选卡时限：不传就是规则层那对默认值（禁用 25s / 选人 30s）
      draftBanMs: initial.draftBanMs,
      draftPickMs: initial.draftPickMs,
      // 这里也是逐个字段抄的：漏一个，界面上那个开关就等于永远关着。
      // 优先用本机偏好（"只勾一次"），其次沿用上一局的选择，最后才是关。
      /*
       * 默认**开**（2026-11-11 用户拍板改的）。
       *
       * 原来是默认关，理由是"不勾就不记，也不多交东西"。那条立场本身没错，
       * 代价是数据：65 局里只有 19 局带动作序列，剩下 46 局事后想复盘都没有素材。
       *
       * 改默认开之后，边界仍然清楚：
       *   · **记录**默认开——它只发生在这台机器上，不替玩家做任何对外动作；
       *   · **发送**仍然要玩家在结算卡上点一下，这一层没动；
       *   · 取消勾选会记住（loadRecordPref），下次还是关的。
       * 换句话说：默认帮你把素材留着，但决定权还在你手里。
       */
      recordDetail: loadRecordPref() ?? true,
    };

    // 上一次存下来的勾选里可能带着伪单位（攻城结算用的「城市」壳）或者本版
    // 已经不认识的 id——它们是"存档能起来"和"清单一格不多"的分界线。
    const availableCatalog = allAvailableUnits();
    config.enabledUnits = Array.from(
      new Set(config.enabledUnits.filter((id) => availableCatalog[id] && !isPseudoUnit(id))),
    );
    // 全都洗没了就保底给一个真兵种：空名单会让开局面板一格都没有
    if (config.enabledUnits.length === 0) {
      const firstValid = Object.values(availableCatalog).find((u) => !isPseudoUnit(u.id));
      if (firstValid) config.enabledUnits.push(firstValid.id);
    }

    let currentSeed = seed;

    // 上一次的选择（存下来的 config）可能带着"第六时代"，而这一次的扩展勾选
    // 里没有「现代战争」——先夹一次，否则面板上五颗时代按钮没有一个高亮，
    // 玩家看不出自己到底会从哪一级开局。
    const ceilingAtOpen = eraCeilingFor(config.expansionIds);
    if (config.startEra > ceilingAtOpen) config.startEra = ceilingAtOpen;

    const mask = document.createElement('div');
    mask.className = 'modal-mask';

    const close = (result: SetupResult | null) => {
      alive = false;
      mask.remove();
      resolve(result);
    };

    /*
     * ── 兵种池：一张"这一局能造什么"的全表 ──
     *
     * 名单有三路来源，合成一张表：
     *   1. 本体兵种（UNIT_TYPES）——「勾选」由 enabledUnits 记，默认只开一部分；
     *   2. 自定义兵种（本机编辑器里捏的）——默认就在池子里；
     *   3. 已开扩展带来的兵种——同样默认就在池子里（勾了海军就该有那十几条船）。
     *
     * 后两路是"默认开"，所以它们的关闭状态必须另外记一笔（disabledUnits），
     * 不能只靠"不在 enabledUnits 里"表达——那会把"玩家关掉了它"和
     * "这一版还不认识这个 id"混成一件事，老存档读进来整支舰队都会消失。
     *
     * 这张表按扩展勾选缓存一份：面板一重绘就要用，两百多个兵种现算两遍不值得。
     */
    interface UnitPoolView {
      key: string;
      catalog: Record<string, UnitTypeDef>;
      /** 默认就在池子里的那些（自定义 + 扩展兵） */
      extras: Set<string>;
      /** id → 出处（扩展名 / 自定义），写进 chip 的 title */
      source: Map<string, string>;
    }
    let poolView: UnitPoolView | null = null;

    const unitPool = (): UnitPoolView => {
      const key = config.expansionIds.join('|');
      if (poolView && poolView.key === key) return poolView;
      const base = allAvailableUnits();
      const fromPacks = expansionUnitsFor(config.expansionIds);
      const catalog: Record<string, UnitTypeDef> = { ...base, ...fromPacks };
      const extras = new Set(Object.keys(catalog).filter((id) => !UNIT_TYPES[id]));
      const source = new Map<string, string>();
      for (const e of EXPANSIONS) {
        for (const u of e.units ?? []) if (fromPacks[u.id]) source.set(u.id, e.name);
      }
      for (const id of Object.keys(base)) if (!UNIT_TYPES[id]) source.set(id, '自定义');
      poolView = { key, catalog, extras, source };
      return poolView;
    };

    /** 这个兵种这一局开着吗。默认进场的那些看 disabledUnits，本体兵种看 enabledUnits */
    const isUnitOn = (id: string): boolean => {
      const { extras } = unitPool();
      return extras.has(id)
        ? !(config.disabledUnits ?? []).includes(id)
        : config.enabledUnits.includes(id);
    };

    /** 开着的兵种总数（伪单位不算：那是攻城结算的壳） */
    const onUnitCount = (): number =>
      Object.keys(unitPool().catalog).filter((id) => !isPseudoUnit(id) && isUnitOn(id)).length;

    const setUnitOn = (id: string, on: boolean): void => {
      const { extras } = unitPool();
      const isExtra = extras.has(id);
      // 先把两张表里的记录都擦掉，下面只负责"在需要的地方补一笔"——
      // 两条记录同时存在时，isUnitOn 读哪个都说不清。
      config.enabledUnits = config.enabledUnits.filter((x) => x !== id);
      config.disabledUnits = (config.disabledUnits ?? []).filter((x) => x !== id);
      if (on) {
        // 默认进场的那些，开回来＝把那笔"关掉"的记录擦掉就够了，
        // 不必再塞进 enabledUnits：塞进去会在换扩展之后留下一串孤儿 id。
        if (!isExtra) config.enabledUnits.push(id);
      } else if (isExtra) {
        config.disabledUnits.push(id);
      }
    };

    /** 弹层开着的时候，两处"已选 N"要跟着就地更新，不用整块重绘 */
    const paintPoolCount = (): void => {
      const n = String(onUnitCount());
      mask.querySelectorAll<HTMLElement>('[data-pool-count]').forEach((el) => {
        el.textContent = n;
      });
    };

    /*
     * 兵种池弹层开没开。
     *
     * 以前这一大块是直接铺在战役页最下面的：两百多个 chip 把整页撑成一长卷，
     * 想改一下"要不要带船"得先滚过时代、尺寸、扩展。收进一层弹层之后，
     * 战役页只剩一行摘要，而全表照旧在——只是要按一下才出来。
     */
    let poolOpen = false;

    /** 把一颗按钮翻译回选择器，重绘之后靠它把键盘焦点还给同一个按钮 */
    const selectorFor = (el: HTMLElement): string | null => {
      const d = el.dataset;
      if (d.tab) return `[data-tab="${d.tab}"]`;
      if (d.unit) return `[data-unit="${d.unit}"]`;
      if (d.era) return `[data-era="${d.era}"]`;
      if (d.size) return `[data-size="${d.size}"]`;
      if (d.mapstyle) return `[data-mapstyle="${d.mapstyle}"]`;
      if (d.exp) return `[data-exp="${d.exp}"]`;
      if (d.symmetry) return `[data-symmetry="${d.symmetry}"]`;
      if (d.ailevel) return `[data-ailevel="${d.ailevel}"]`;
      if (d.ai !== undefined) return `[data-ai="${d.ai}"]`;
      if (d.act) return `[data-act="${d.act}"]`;
      return null;
    };

    /** 左侧两页：战役（怎么打）与地图（在哪打）。默认停在战役 */
    let tab: 'battle' | 'maps' = 'battle';
    /** 换页的时候把滚动条拨回顶部：留在上一页的位置会让人以为页面没换 */
    let resetScroll = false;

    /** 待上传的地图文件（本地解析完、还没发出去） */
    let mapDraft: FixedMap | null = null;
    let mapNote = '';
    let mapBad = false;

    /*
     * 固定地图：内置四张 + 云端地图库里别人上传的那些。
     *
     * 三件事按这个顺序发生，界面上不会闪：
     *   1. 同步登记**本机缓存**里上一次拉到的地图——断网也能立刻选；
     *   2. 异步拉云端，回来了再重绘一次（`alive` 保证关闭面板后不再碰 DOM）；
     *   3. 失败只写一行提示，不挡开局：地图拉不到，随机地形照样能打。
     */
    registerUserMaps(cachedMaps());
    let cloudNote = '';
    let alive = true;

    /** 拉一次地图库。地图页上的「刷新」也走这里，所以单独拎出来 */
    const loadCloudMaps = (): void => {
      void listSharedMaps().then((res) => {
        if (!alive) return;
        if (res.maps.length > 0) registerUserMaps(res.maps);
        cloudNote = res.ok ? '' : (res.reason ?? '');
        paint();
      });
    };

    /**
     * 读一个地图文件：体积 → 解析 → 预览。
     *
     * 顺序不能换：先看体积，省得把一个 10MB 的文件整个读进内存再拒；
     * 解析失败就把错误留在原地（带行列号），不清空也不弹窗——
     * 玩家要的是"第 3 行第 4 列那个字符不认识"，不是"上传失败"。
     */
    const readMapFile = (file: File): void => {
      if (file.size > MAP_MAX_BYTES) {
        mapDraft = null;
        mapBad = true;
        mapNote = `文件太大（${Math.round(file.size / 1024)}KB，上限 ${MAP_MAX_BYTES / 1024}KB）`;
        paint();
        return;
      }
      void file.text().then((text) => {
        if (!alive) return;
        const parsed = parseMapFile(text);
        if (parsed.ok) {
          mapDraft = parsed.map;
          mapBad = false;
          mapNote = '';
        } else {
          mapDraft = null;
          mapBad = true;
          // 最多三条：再多就不是"提示"，是把整个错误日志糊在界面上
          mapNote = parsed.errors.slice(0, 3).join('；');
        }
        paint();
      });
    };

    /** 一张地图卡片：缩略图 + 名字 + 尺寸/来源 */
    const mapCard = (id: string, name: string, size: string, thumb: string, active: boolean, extra = '') =>
      `<button type="button" class="map-card ${active ? 'active' : ''}" data-map="${id}" title="${name}">
         <span class="map-card-thumb">${thumb}</span>
         <b>${name}</b>
         <i>${size}${extra}</i>
       </button>`;

    const paint = () => {
      // 面板是整块 innerHTML 换掉的，重绘会把滚动位置和键盘焦点一起清零。
      // 点一个兵种就"弹回顶部"就是这么来的——所以先把两者记下来，画完再搬回去。
      const prevBody = mask.querySelector<HTMLElement>('.modal-body');
      // 换页时把滚动条拨回顶部：留在上一页的位置会让人以为"点错了、没反应"
      const prevScrollTop = resetScroll ? 0 : (prevBody?.scrollTop ?? 0);
      const prevScrollLeft = resetScroll ? 0 : (prevBody?.scrollLeft ?? 0);
      // 兵种池弹层有自己的滚动区，而且它盖在上面——不单独记一份的话，
      // 在弹层里点「全选」这种会重绘的操作会把两百多个兵种弹回第一行。
      const prevPoolScroll = mask.querySelector<HTMLElement>('.pool-body')?.scrollTop ?? 0;
      resetScroll = false;
      const prevFocusEl = document.activeElement;
      const prevFocus =
        prevFocusEl instanceof HTMLElement && mask.contains(prevFocusEl)
          ? selectorFor(prevFocusEl)
          : null;

      // 时代按钮跟着"这一局能升到第几级"走。
      //
      // 没勾「现代战争」时这里只有五格——第六时代在 ERAS 里，但基础规则升不上去
      // （见 config.ts 的 BASE_MAX_ERA）。多摆一格的结果是：玩家从第六时代开局，
      // 城里一件六代兵都造不出来，还得自己猜为什么。
      //
      // 天花板每次重绘现算，所以勾上/取消那个包，按钮会当场增减，不用重启面板。
      /*
       * 人数：两家 / 三家 / 四家。
       *
       * 三家四家一律**全真人**（AI 的目标选择是"只有一个对手"写的，见 ai.ts），
       * 所以选了三家/四家之后，下面那栏"对手"会整块收起——不留一个点了没反应的开关。
       */
      const playerCount = config.playerCount ?? 2;
      const playerChips = [2, 3, 4]
        .map(
          (n) =>
            `<button class="chip ${playerCount === n ? 'active' : ''}" data-players="${n}">${n} 人</button>`,
        )
        .join('');
      const twoCities = config.twoCities === true && playerCount > 2;
      const playerHint =
        playerCount === 2
          ? '红蓝对峙，敌我分明'
          : `${playerCount} 家各自为战，每家${twoCities ? '两' : '一'}座城`;
      const playerNote =
        playerCount === 2
          ? '两人局可以带 AI：人机对战、双 AI 观战都行。'
          : `${playerCount} 人局只支持全真人（本地热座或联机）：这套 AI 的目标选择只认"一个对手"，多方混战会打成一团。${
              twoCities
                ? '双城市开局：每家两座城，丢一座不算出局，全丢才出局。'
                : '每方开局恰好一座城，城丢了就出局。'
            }${config.size < 16 ? '人多地小会摆不开，建议至少 16 × 16。' : ''}`;

      /*
       * 双城市开局的开关：只在三人四人局出现。
       *
       * 两家局本来就是"每家两座城"（对峙 / 对角两种布局），这个开关对它没有意义，
       * 留着只会让人以为点了会有变化。棋盘太小也摆不开八座城（间距是硬条件），
       * 开关上直接把最小边长写出来，点了会自动把尺寸抬上去。
       */
      const twoCityToggle =
        playerCount === 2
          ? ''
          : `<button class="chip ${twoCities ? 'active' : ''}" data-two-cities="1"
               title="每家两座城，摆在外圈、两两相邻；两城之间不保证连通。连线不交叉、城市间距有下限">
               ${twoCities ? '双城市开局：开' : '双城市开局：关'}
             </button>`;

      const ceiling = eraCeilingFor(config.expansionIds);
      const eras = ERAS.filter((e) => e.level <= ceiling);
      const eraChips = eras.map(
        (e) =>
          `<button class="chip ${config.startEra === e.level ? 'active' : ''}" data-era="${e.level}" title="${e.name}">${e.short}</button>`,
      ).join('');

      /*
       * 地貌跟着扩展走：勾了「地形高差」才多出高原 / 峡谷 / 沼泽 / 群岛 / 大川。
       * 这里每次都按当前勾选重算，所以开关扩展时列表会立刻增减——
       * "勾了才有这些按钮"，列表本身就是扩展开关的镜子。**双人和多人同一份列表**。
       */
      const multi = (config.playerCount ?? 2) > 2;
      const styles = mapStylesFor(config.expansionIds);
      const styleChips = styles
        .map(
          (st) =>
            `<button class="chip ${config.mapStyle === st.id ? 'active' : ''}" data-mapstyle="${st.id}" title="${st.note}">${st.name}</button>`,
        )
        .join('');
      // 提示也跟着变：没勾扩展时说清"多出来的地貌去哪了"，勾了就说现在是几种
      const extraStyles = styles.length - MAP_STYLES.length;
      const styleHint = multi
        ? `共 ${styles.length} 种，双人多人同一份；随机＝每局抽一种。` +
          '多人图上这几套扩展地貌只保证"有山有水有意思"，不保证逐家对称——要严格配平选本体那四种'
        : extraStyles > 0
          ? `共 ${styles.length} 种：扩展额外解锁了 ${extraStyles} 种；随机＝每局抽一种`
          : '决定天险长什么样；随机＝每局抽一种。勾上带地貌的扩展会在这里多出选项';

      /*
       * 地图数据：地图那一页要用。
       *
       * 默认是「随机地形」——开始界面的默认值必须和"不选"一致，
       * 否则每次开局都会被一张别人画好的图顶掉，玩家还得先学会怎么取消。
       * 选中的卡片加 `active`，靠一条主色描边和随机那张区分开；
       * 缩略图直接用同一份地形数据画，所见即所得。
       */
      const fixedMaps = allFixedMaps();
      const pickedMapId = config.fixedMap?.id ?? '';
      const thumbCity = Math.max(2, Math.min(3, Math.round(config.citySize ?? 2)));
      const builtinCards = fixedMaps.filter((m) => m.source !== 'user');
      const userCards = fixedMaps.filter((m) => m.source === 'user');
      const mapHint = config.fixedMap
        ? `已选「${esc(config.fixedMap.name)}」：这一局的地貌、对称、尺寸与种子都不生效`
        : `随机地形每局不同。选一张固定地图就照着它打——联机两边、复盘重开都是同一张`;

      // 时代那一栏的提示要指出"还能往上开"：只写"从哪一级开始"的话，
      // 没勾过时代扩展的人根本不知道这游戏还有第六时代。
      // 包名从 lockedEraPacks 取，别在文案里写死——以后再加一个抬上限的包，
      // 这里自动就把名字念出来了。
      const lockedPacks = lockedEraPacks(config.expansionIds);
      const eraHint =
        ceiling < ERAS.length && lockedPacks.length > 0
          ? `从哪一级开始；越高一局越短。这一局科技线到${eraDef(ceiling).name}封顶——勾上「${lockedPacks.join('」「')}」可升到${eraDef(ERAS.length).name}`
          : '从哪一级开始；越高一局越短';

      const symChips = MAP_SYMMETRIES.map(
        (sy) =>
          `<button class="chip ${config.mapSymmetry === sy.id ? 'active' : ''}" data-symmetry="${sy.id}" title="${sy.note}">${sy.name}</button>`,
      ).join('');

      // 只在对局里有 AI 的时候才给难度选项：双人热座选它没有意义
      const aiOn = config.aiOpponent || config.aiAlly;
      /*
       * 第四个按钮：测试 AI（策略网络）。
       *
       * 它在这一行里，但**不是第四档难度**——难度是手写引擎的算法档位，
       * 而它是换了一个内核（见 rl/brain.ts），没有档位可言。所以用
       * `data-aibrain` 单独标一个属性，而不是 `data-ailevel="net"`：
       * 后者会让 `aiLevel` 这个字段凭空多出一个不存在的值，存档、上报、
       * 复盘全都要跟着改，而它本来是个三选一。
       *
       * 点它的时候 `aiLevel` 仍留在原处——权重加载失败要退回手写 AI 时，
       * "退回到哪一档"得有个说法，`advanced` 是默认值也是最稳的一档。
       *
       * **指挥官模式不出现这个按钮**：那个模式的 AI 只执行玩家排的生产队列
       * （`budget.order`），而网络内核不认队列（见 main.ts 的 runAiTurn）。
       * 摆一个点了不生效的按钮，比不摆更糟。
       */
      const netAllowed = !config.commanderMode;
      const netOn = netAllowed && config.aiBrain === 'net';
      const aiLevelChips = aiOn
        ? `<div class="chip-row ai-level-row">
            <button class="chip ${!netOn && config.aiLevel === 'basic' ? 'active' : ''}" data-ailevel="basic" title="只想着往前推：不算对面能打到哪，也不挑交换比">初级 AI</button>
            <button class="chip ${!netOn && config.aiLevel === 'tactic' ? 'active' : ''}" data-ailevel="tactic" title="在高级的评估之上再挂三套战术：速攻压制、骚扰消耗、弃城爆发——打法会随局面换档">中级 AI</button>
            <button class="chip ${!netOn && config.aiLevel === 'advanced' ? 'active' : ''}" data-ailevel="advanced" title="威胁范围、换子价值、有效战力、现金预算、英雄技优先级都算，走位与采购按局势定">高级 AI</button>
            ${
              netAllowed
                ? `<button class="chip is-brain ${netOn ? 'active' : ''}" data-aibrain="net" title="自博弈训练出来的策略网络。自带全视野：开雾也看得见你的全部部队；只会一种打法节奏，没有档位">测试 AI · 全视野</button>`
                : ''
            }
          </div>
          <div class="field-hint">${
            netOn
              ? '测试 AI 自带全视野——开雾对它没有作用，它能看见你的全部部队。它是在 10×10 / 12×12 的青铜开局上练出来的，<b>别的尺寸与时代会很弱</b>，也没有初级/中级/高级之分'
              : netAllowed
                ? '初级适合熟悉规则；中级会随局面换打法（速攻 / 骚扰 / 弃城）；高级算得最细，走位与采购都稳'
                : '指挥官模式下的 AI 只执行你排好的生产序列，用的是手写引擎；测试 AI 不认队列，所以这一档不提供'
          }</div>`
        : '';

      const sizeChips = BOARD_SIZES.map(
        (s) =>
          `<button class="chip ${config.size === s ? 'active' : ''}" data-size="${s}">${s} × ${s}</button>`,
      ).join('');

      /*
       * 兵种池：按时代分组，一眼看出哪些开局就有、哪些要升级城市才能造。
       *
       * 只列到天花板：第六代的兵在没开「现代战争」的局里永远不会出现在兵表上，
       * 把它们摆在池子里只会让玩家勾一个点了没反应的选项。
       *
       * 组内先本体、后扩展（虚线框），各自按造价从小到大——玩家找"骑兵在哪"
       * 时眼睛是顺着名录扫的，混在一起排就变成了随机顺序。
       */
      const { catalog, extras, source } = unitPool();
      const allUnits = Object.values(catalog).filter((u) => !isPseudoUnit(u.id));
      const unitGroups = eras
        .map((era) => {
          const units = allUnits
            .filter((u) => u.era === era.level)
            .sort(
              (a, b) =>
                Number(extras.has(a.id)) - Number(extras.has(b.id)) || a.cost - b.cost,
            );
          if (units.length === 0) return '';
          const chips = units
            .map((u) => {
              const from = source.get(u.id);
              // 开局勾兵时就把"能盖什么"写在悬停里：玩家是在这里决定要不要
              // 带上这个工兵的，等造出来再点属性卡已经晚了。
              const builds = buildListOf(u, {
                nameOf: (id) => catalog[id]?.name ?? id,
                exists: (id) => !!catalog[id],
                eraOf: (id) => catalog[id]?.era,
              });
              const buildTip = builds.names.length > 0 ? ` · 可建 ${builds.names.join('、')}` : '';
              /*
               * 选卡模式下，经济/建造单位、生产性建筑、桥、经济建筑**不进卡池**：
               * 它们开局自带（`draftAlwaysAllowed`）。这张表是"这一局能造什么"，
               * 所以它们照样列——但不标出来的话，玩家会以为"磨坊怎么还在卡池里"。
               * 2026-11-08 就是因为这个来问的（那份其实是老存档里落过盘的旧池子）。
               */
              const auto = config.draftMode && draftAlwaysAllowed(u);
              const autoTip = auto ? ' · 选卡模式下开局自带，不进卡池' : '';
              // 悬停里也给完整数值行（含视野）：这里是玩家决定"带不带它"的地方，
              // 只有一个造价和名字的话，几个同类兵之间根本没法比
              const title = `${u.name}${from ? ` · ${from}` : ''} · 造价 ${u.cost} · ${unitStatLine(u)}${buildTip}${autoTip}`;
              return `<button class="chip ${isUnitOn(u.id) ? 'active' : ''} ${
                from ? 'is-extra' : ''
              }" data-unit="${u.id}" title="${esc(title)}">
                 ${u.short} ${u.name}${auto ? '<span class="chip-auto">自带</span>' : ''}
               </button>`;
            })
            .join('');
          return `<div class="era-group">
            <span class="era-tag">${era.name}</span>
            <div class="chip-row">${chips}</div>
          </div>`;
        })
        .join('');

      const poolTotal = allUnits.length;
      const extraTotal = allUnits.filter((u) => extras.has(u.id)).length;
      const onTotal = allUnits.filter((u) => isUnitOn(u.id)).length;
      // 数字单独套一层，点开弹层里勾选时只改这一格，不重绘按钮
      const poolHint = `已选 <span data-pool-count>${onTotal}</span> / ${poolTotal}${
        extraTotal > 0 ? ` · 其中 ${extraTotal} 个来自扩展或自定义` : ''
      }`;

      // 前置关系直接写在卡片上：一个"勾了却不生效"的开关比没有这个开关更糟
      const reqLine = (id: string): string => {
        const need = expansionById(id)?.requires ?? [];
        if (need.length === 0) return '';
        const names = need.map((r) => expansionById(r)?.name ?? r).join('、');
        return `<span class="expansion-req">需先开：${names}</span>`;
      };
      // 隐藏的扩展（规则在跑但玩家还选不到）不列出来
      //
      // 每条只印一句 `blurb`，不印 `summary`。
      // summary 是写给规则书看的：动辄一百多字，还爱把十几个兵种名一口气列完
      // （"桨帆船、德罗蒙、卡拉克、盖伦……"）。这个面板只回答"勾不勾"，
      // 想读细则的人点规则书——那里每册都有专章。没写 blurb 的退回 summary，
      // 免得将来新加的包在面板上变成一行空白。
      const expItems = availableExpansions().map(
        (e) => `
        <label class="expansion-item ${config.expansionIds.includes(e.id) ? 'on' : ''}">
          <input type="checkbox" data-exp="${e.id}" ${config.expansionIds.includes(e.id) ? 'checked' : ''} />
          <span class="expansion-body">
            <b>${e.name}</b>
            <span>${e.blurb ?? e.summary}</span>
            ${reqLine(e.id)}
          </span>
        </label>`,
      ).join('');

      /* ── 战役页：这一局怎么打 ── */
      const battleView = `
            <section class="field">
              <div class="field-label">
                数据收集 <span class="field-hint">会在下次开新局时沿用这次的选择</span>
              </div>
              <label class="expansion-item ${config.recordDetail ? 'on' : ''}">
                <input type="checkbox" data-field="record" ${config.recordDetail ? 'checked' : ''} />
                <span class="expansion-body">
                  <b>记录这局的详细数据（默认开启）</b>
                  <span>
                    记每回合的兵力 / 城防 / 金币，以及双方的出兵与行动次数，
                    还有每一步的动作——这局能在本地逐帧重放。
                    不记玩家名与房间码。取消勾选就不再记录（会记住你的选择）；
                    上传仍要你在结算卡上点一下，不点不会发出去。
                  </span>
                </span>
              </label>
            </section>

            <section class="field">
              <div class="field-label">
                人数 <span class="field-hint">${playerHint}</span>
              </div>
              <div class="chip-row">${playerChips}${twoCityToggle}</div>
              <div class="field-hint">${playerNote}</div>
            </section>

            <section class="field">
              <div class="field-label">对手 <span class="field-hint">${
                netOn ? '测试 AI 自带全视野：开雾也看得见你' : 'AI 会跟你一样受迷雾限制'
              }</span></div>
              ${
                playerCount > 2
                  ? `<div class="field-hint">${playerCount} 人局固定为「全真人」：可以本地热座轮流操作，也可以建房联机。AI 不进多方局。</div>`
                  : config.godMode
                  ? `<div class="field-hint">上帝模式是纯单人沙盒：两边都归你摆，AI 只在点「交给 AI」时同时操控两边。</div>`
                  : `<div class="chip-row">
                <button class="chip ${!config.aiOpponent && !config.aiAlly ? 'active' : ''}" data-ai="0">双人热座</button>
                <button class="chip ${config.aiOpponent && !config.aiAlly ? 'active' : ''}" data-ai="1">人机对战</button>
                <button class="chip ${config.aiAlly ? 'active' : ''}" data-ai="2">双 AI 观战</button>
              </div>
              ${aiLevelChips}`
              }
            </section>

            ${
              config.godMode
                ? ''
                : playerCount === 2
                  ? `<section class="field">
              <div class="field-label">先手 <span class="field-hint">${
                config.aiOpponent || config.aiAlly
                  ? '你操作红方；选「蓝方先手」就是 AI 先动一步'
                  : '谁先行动、谁先禁/先选卡；后手照旧拿「先后手补偿」'
              }</span></div>
              <div class="chip-row">
                <button class="chip ${!config.firstSide || config.firstSide === 'A' ? 'active' : ''}" data-first="A">红方先手</button>
                <button class="chip ${config.firstSide === 'B' ? 'active' : ''}" data-first="B">蓝方先手</button>
                <button class="chip ${config.firstSide === 'random' ? 'active' : ''}" data-first="random">随机</button>
              </div>
              ${config.firstSide === 'random' ? '<div class="field-hint">按这一局的种子抽，抽到什么就存成什么——复盘不会变。</div>' : ''}
            </section>`
                  : `<section class="field">
              <div class="field-label">先手 <span class="field-hint">谁先行动、谁先禁/先选卡</span></div>
              <div class="chip-row">
                <button class="chip ${!config.firstSide || config.firstSide === 'A' ? 'active' : ''}" data-first="A">按席位顺序</button>
                <button class="chip ${config.firstSide === 'random' ? 'active' : ''}" data-first="random">随机</button>
              </div>
              ${
                config.firstSide === 'random'
                  ? '<div class="field-hint">在参赛的席位上抽（三家就在 A/B/C 里抽），抽到谁谁先动；抽完存成具体席位，复盘不会变。</div>'
                  : ''
              }
              <div class="field-hint">多人局的城位与出生点按席位固定，不跟着这个走——这里只决定谁先动。</div>
            </section>`
            }

            <section class="field">
              <div class="field-label">
                起始时代 <span class="field-hint">${eraHint}</span>
              </div>
              <div class="chip-row">${eraChips}</div>
            </section>

            <section class="field">
              <div class="field-label">
                棋盘大小 <span class="field-hint">预设之外可以自己填 ${MIN_BOARD_SIZE}~${MAX_BOARD_SIZE}</span>
              </div>
              <div class="chip-row">${sizeChips}</div>
              <div class="size-row">
                <input class="text-input size-input" data-field="size" type="number"
                  min="${MIN_BOARD_SIZE}" max="${MAX_BOARD_SIZE}" step="1"
                  value="${config.size}" inputmode="numeric" aria-label="自定义棋盘边长" />
                <span class="field-hint">边长（格）。${MIN_BOARD_SIZE}×${MIN_BOARD_SIZE} 是"街角斗殴"图，64×64 要配合缩放看。</span>
              </div>
            </section>

            <section class="field">
              <div class="field-label">
                你的角色 <span class="field-hint">指挥官模式：只决定造什么兵，其余交给 AI</span>
              </div>
              <div class="chip-row">
                <button class="chip ${!config.commanderMode && !config.godMode ? 'active' : ''}" data-role="full" title="每个单位都由你自己走、自己打">亲自指挥</button>
                <button class="chip ${config.commanderMode ? 'active' : ''}" data-role="commander" title="你只排接下来几回合造什么，建造、移动、攻击、升级全部由 AI 执行">指挥官模式</button>
                ${
                  playerCount > 2
                    ? ''
                    : `<button class="chip ${config.godMode ? 'active' : ''}" data-role="god" title="纯单人沙盒：不要金币、不看回合，随手摆兵摆城，然后让 AI 同时操控两边打给你看">上帝模式</button>`
                }
              </div>
              <div class="field-hint">${
                config.godMode
                  ? '上帝模式下棋盘全图可见：点兵种→点棋盘落子，摆完点「交给 AI · 一回合」看一回合，或者「接管 · 打到全灭」看完整场。'
                  : config.commanderMode && playerCount > 2
                    ? '多人局也能用指挥官模式：每一方（包括你自己）只排生产序列，走位、建造、攻击、升级全部由 AI 执行。三家四家局里 AI 会按"所有敌人"打仗，但主攻方向只认最强的那一家。'
                    : '指挥官模式下棋盘只看不碰：点自己的城 → 在右侧点兵种，就排进顶端的生产队列，点一次执行交给参谋部打完。配合「双 AI 观战」可以量出这套限制下 AI 的表现。'
              }</div>
            </section>

            <section class="field">
              <div class="field-label">
                选卡 <span class="field-hint">开局先禁用与选人，双方只用选到的兵</span>
              </div>
              ${
                playerCount > 2
                  ? `<div class="field-hint">多人局暂不支持选卡：禁选是"双方互相看不见"设计的，三家四家一桌要改的是整套 BP 界面，不是加两行。这一局直接按下方勾选的兵种池开局。</div>`
                  : `<div class="chip-row">
                <button class="chip ${config.draftMode ? '' : 'active'}" data-draft-mode="off" title="原版开局：这一局有哪些兵由开局面板决定">关闭</button>
                <button class="chip ${config.draftMode ? 'active' : ''}" data-draft-mode="on" title="系统抽一个兵种池，双方各禁 1 个、各选 6 个；没选到的造不出来，经济/建造/军营不受限">开启选卡模式</button>
              </div>`
              }
              <div class="field-hint">${
                config.draftMode
                  ? '开局先停在「等待开局」：那里可以建房、把邀请链接发给朋友，也可以直接本机开打；点「开始选卡」之后双方同时禁用（互相看不见），再按蛇形顺序轮流选人。选卡期间不能走棋；超出时限时禁用视为放弃、选人由系统随机补；右上角可随时跳过或退出。'
                  : '打开之后，这一局能造什么由开局的选卡决定——下方逐个勾选兵种在这个模式下不再生效。'
              }</div>
              ${
                config.draftMode
                  ? `<div class="field-label" style="margin-top:10px">
                       禁用时限 <span class="field-hint">只看一眼名单的事，给短一点</span>
                     </div>
                     <div class="chip-row">
                       ${[15_000, 25_000, 40_000, 60_000]
                         .map(
                           (ms) =>
                             `<button class="chip ${
                               (config.draftBanMs ?? 25_000) === ms ? 'active' : ''
                             }" data-draft-ban="${ms}">${ms / 1000} 秒</button>`,
                         )
                         .join('')}
                     </div>
                     <div class="field-label" style="margin-top:10px">
                       选人时限 <span class="field-hint">每一手单独计时，选出六轮</span>
                     </div>
                     <div class="chip-row">
                       ${[20_000, 30_000, 45_000, 75_000]
                         .map(
                           (ms) =>
                             `<button class="chip ${
                               (config.draftPickMs ?? 30_000) === ms ? 'active' : ''
                             }" data-draft-pick="${ms}">${ms / 1000} 秒</button>`,
                         )
                         .join('')}
                     </div>`
                  : ''
              }
            </section>

            <section class="field">
              <div class="field-label">
                地貌 <span class="field-hint">${styleHint}</span>
              </div>
              <div class="chip-row">${styleChips}</div>
            </section>

            <section class="field">
              <div class="field-label">
                地形对称
                <span class="field-hint">${
                  multi
                    ? '三人四人图按旋转等分自动配平（四家 90°、三家三块等量），没有"地势各异 / 完全镜像"这两档'
                    : '地势各异：两侧地形数量相同、分布不同'
                }</span>
              </div>
              ${multi ? '' : `<div class="chip-row">${symChips}</div>`}
            </section>

            <section class="field">
              <div class="field-label">
                兵种池 <span class="field-hint">这一局能造什么，扩展兵种也在这里开关</span>
              </div>
              <button type="button" class="pool-open" data-act="unit-pool">
                <span class="pool-open-text">
                  <b>调整兵种池</b>
                  <i>${poolHint}${config.draftMode ? ' · 本局开了选卡，名单由 BP 决定' : ''}</i>
                </span>
                <span class="pool-open-go">展开</span>
              </button>
              <div class="field-hint">至少留一个；高时代兵种要城市升级后才能生产。带「扩」的是扩展 / 自定义兵种，默认就开着。</div>
            </section>

            <section class="field">
              <div class="field-label">扩展规则 <span class="field-hint">可多选，效果叠加</span></div>
              <div class="expansion-list">${expItems}</div>
            </section>

            <section class="field">
              <div class="field-label">地图种子</div>
              <div class="seed-row">
                <code>${currentSeed}</code>
                <button class="btn btn-sm" data-act="reroll">换一张地图</button>
              </div>
              <div class="field-hint">同一个种子永远生成同一张地图，方便复盘和公平对战。</div>
            </section>`;

      /*
       * 地图页：选图与传图是同一件事的两头。
       *
       * 之前"上传"藏在上帝模式侧栏里，而"选图"在开局面板里——同一条流水线的
       * 两端被拆到两个互不相干的地方，玩家画完图得先想"我该去哪个面板"。
       * 现在合成一页：上面挑，下面传，传完那张图直接出现在上面的画廊里并被选中。
       */
      const mapsView = `
            ${
              (config.playerCount ?? 2) > 2
                ? `<section class="field">
                     <div class="field-label">这一局的地图 <span class="field-hint">${(config.playerCount ?? 2)} 人图由种子生成</span></div>
                     <div class="field-hint">多人局不用固定地图：一张手绘图只有两个城位（A/B），塞不下第三第四家。这一局按种子生成一张 ${(config.playerCount ?? 2)} 方对称图——四家是 90° 旋转对称（严格相同），三家是三足鼎立、各区地形数量配平。</div>
                   </section>`
                : `<section class="field">
              <div class="field-label">
                这一局的地图 <span class="field-hint">${mapHint}</span>
              </div>
              <div class="map-gallery">
                <button type="button" class="map-card ${pickedMapId ? '' : 'active'}" data-map="" title="按种子每局生成">
                  <span class="map-card-thumb is-random">随机</span>
                  <b>随机地形</b>
                  <i>按种子生成</i>
                </button>
                ${builtinCards
                  .map((m) =>
                    mapCard(m.id, esc(m.name), `${m.w}×${m.h}`, mapThumbSvg(m, thumbCity), m.id === pickedMapId),
                  )
                  .join('')}
              </div>
              <div class="field-hint">内置图是手摆的对称图，两边条件一样，不随机、不可改。选了固定地图，战役页里的地貌 / 对称 / 尺寸 / 种子都不再起作用。</div>
            </section>`
            }

            <section class="field">
              <div class="field-label">
                玩家上传 <span class="field-hint">${userCards.length > 0 ? `${userCards.length} 张，来自地图库` : '来自地图库'}</span>
                <button class="btn btn-sm" data-act="map-refresh" style="margin-left:auto">刷新</button>
              </div>
              ${
                userCards.length > 0
                  ? `<div class="map-gallery">${userCards
                      .map((m) =>
                        mapCard(
                          m.id,
                          esc(m.name),
                          `${m.w}×${m.h}`,
                          mapThumbSvg(m, thumbCity),
                          m.id === pickedMapId,
                          `${m.author ? ` · ${esc(m.author)}` : ''}${m.pending ? ' · 待审核' : ''}`,
                        ),
                      )
                      .join('')}</div>`
                  : `<div class="field-hint">库里还没有公开的图。下面传一张上去，审核通过后所有人都能在这里选到它。</div>`
              }
              ${cloudNote ? `<div class="map-note">${esc(cloudNote)}</div>` : ''}
            </section>

            <section class="field">
              <div class="field-label">
                上传地图 <span class="field-hint">传上去要审核，通过之后所有玩家开局都能选到</span>
              </div>
              ${
                mapDraft
                  ? `<div class="map-draft">
                       <span class="map-draft-thumb">${mapThumbSvg(mapDraft, thumbCity)}</span>
                       <div class="map-draft-meta">
                         <b>${esc(mapDraft.name)}</b>
                         <span>${mapDraft.w} × ${mapDraft.h} · 城 ${mapDraft.citiesA.length} : ${mapDraft.citiesB.length}</span>
                         <span class="field-hint">看一眼缩略图，确认是这个文件再传。</span>
                       </div>
                       <div class="map-draft-act">
                         <button class="btn btn-sm btn-primary" data-act="map-upload">提交审核</button>
                         <button class="btn btn-sm" data-act="map-cancel">取消</button>
                       </div>
                     </div>`
                  : `<div class="chip-row">
                       <button class="btn btn-sm" data-act="map-file">选择地图文件…</button>
                       <a class="btn btn-sm" href="maps/example-map.txt" download="example-map.txt">下载一个模板</a>
                     </div>
                     <div class="field-hint">
                       支持 <code>.json</code> 或纯文本网格${TERRAIN_LEGEND}，用 <code>A</code>/<code>B</code> 标两边城的左上角。
                       单文件 ≤ ${Math.round(MAP_MAX_BYTES / 1024)}KB，${MAP_MIN_SIZE}~${MAP_MAX_SIZE} 格见方。
                       先在本地解析校验，不合格的文件不会发出去。
                     </div>`
              }
              ${mapNote ? `<div class="map-note ${mapBad ? 'is-bad' : 'is-ok'}">${esc(mapNote)}</div>` : ''}
            </section>

            <input type="file" data-field="map-file" accept=".json,.txt,application/json,text/plain" hidden />`;

      const summary = `${config.size} × ${config.size} · ${eraDef(config.startEra).name} · ${
        (config.playerCount ?? 2) > 2 ? `${config.playerCount} 人 · ` : ''
      }${config.fixedMap ? esc(config.fixedMap.name) : '随机地形'}`;

      mask.innerHTML = `
        <div class="modal start-panel">
          <aside class="start-rail">
            <div class="start-brand">
              <b>时代与回旋镖</b>
              <span>回合制战棋</span>
            </div>
            <nav class="start-nav">
              <button class="start-nav-item ${tab === 'battle' ? 'active' : ''}" data-tab="battle">
                <b>战役</b>
                <span>规则 · 时代 · 兵种</span>
              </button>
              <button class="start-nav-item ${tab === 'maps' ? 'active' : ''}" data-tab="maps">
                <b>地图</b>
                <span>选图 · 上传</span>
              </button>
            </nav>
            <div class="start-rail-foot">同一个种子永远生成同一张地图</div>
          </aside>

          <div class="start-col">
            <div class="modal-head">
              ${
                tab === 'battle'
                  ? `<h2>战役</h2>
                     <p>选好规则再开局。扩展规则会改变伤害、经济或视野的计算方式。</p>`
                  : `<h2>地图</h2>
                     <p>挑一张现成的地图，或者把自己画的上传上去——传上去的图，所有玩家开局都能选到。</p>`
              }
            </div>

            <div class="modal-body">${tab === 'battle' ? battleView : mapsView}</div>

            <div class="modal-foot start-foot">
              <div class="start-summary">${summary}</div>
              <div class="start-actions">
                <button class="btn" data-act="cancel">取消</button>
                <button class="btn btn-primary" data-act="start">开始对局</button>
              </div>
            </div>
          </div>

          ${
            poolOpen
              ? `<div class="pool-layer" role="dialog" aria-modal="true" aria-label="兵种池">
                   <div class="pool-head">
                     <div class="pool-head-text">
                       <b>兵种池</b>
                       <span>${poolHint} —— 关掉的兵这一局造不出来</span>
                     </div>
                     <button class="btn btn-sm btn-primary" data-act="unit-pool-close">完成</button>
                   </div>
                   <div class="pool-body">${unitGroups}</div>
                   <div class="pool-foot">
                     <button class="btn btn-sm" data-act="unit-pool-all">全选</button>
                     <button class="btn btn-sm" data-act="unit-pool-base">只留本体</button>
                     <span class="field-hint">带「扩」的是扩展 / 自定义兵种：勾了对应的包就自动在池子里，不想用才在这里关；虚线框＝这一局关掉了。</span>
                   </div>
                 </div>`
              : ''
          }
        </div>
      `;

      // 把滚动位置与焦点搬回重绘前的状态
      const nextBody = mask.querySelector<HTMLElement>('.modal-body');
      if (nextBody) {
        nextBody.scrollTop = prevScrollTop;
        nextBody.scrollLeft = prevScrollLeft;
      }
      const nextPool = mask.querySelector<HTMLElement>('.pool-body');
      if (nextPool) nextPool.scrollTop = prevPoolScroll;
      if (prevFocus) {
        mask.querySelector<HTMLElement>(prevFocus)?.focus({ preventScroll: true });
      }
    };

    mask.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;

      if (target === mask) {
        // 兵种池盖在面板上：这时候点外面是"关掉这一层"，而不是把整个开局
        // 设置也一起关掉——两百多个兵种还没看完就被弹出去，得重来一遍。
        if (poolOpen) {
          poolOpen = false;
          paint();
          return;
        }
        close(null);
        return;
      }

      // 左侧导航：换页就是换一屏内容，滚动位置跟着归零
      const tabBtn = target.closest<HTMLElement>('[data-tab]');
      if (tabBtn?.dataset.tab) {
        const next = tabBtn.dataset.tab === 'maps' ? 'maps' : 'battle';
        if (next === tab) return;
        tab = next;
        resetScroll = true;
        paint();
        return;
      }

      // 人数：三家四家一律全真人，顺手把互斥的开关关掉——
      // 留一个"开着但不生效"的开关，比没有这个开关更让人费解。
      const playersBtn = target.closest<HTMLElement>('[data-players]');
      if (playersBtn?.dataset.players) {
        const n = Number(playersBtn.dataset.players);
        config.playerCount = n === 3 ? 3 : n === 4 ? 4 : 2;
        if (config.playerCount > 2) {
          config.aiOpponent = false;
          config.aiAlly = false;
          // 指挥官模式**留着**：多人局也能用（每一方只排生产序列，其余交给 AI）。
          // 以前这里一起关掉，是因为 AI 只认一个对手——那条限制已经放开。
          config.draftMode = false;
          // 沙盒面板是按"两边"写的（摆给红方/摆给蓝方、交给 AI 同时操两边），
          // 三家四家局里没有对应物，索性一起关掉
          config.godMode = false;
          // 城门只有两个：多人局用不了固定地图，清掉免得带着上一局的选择进场
          config.fixedMap = undefined;
          // 正好停在"这个时代的默认尺寸"上＝玩家还没自己挑过，就顺手放大到 16×16：
          // 12×12 上四家各占一角，开局就走不动。玩家自己挑过的尺寸一律不动。
          if (config.size === DEFAULT_SIZE_FOR_ERA(config.startEra)) {
            config.size = Math.max(config.size, 16);
          }
          /*
           * 双城市开局开着的时候再抬一道：三家的最小边是 16、四家是 20（四家走田字，
           * 每块都得单独放下一对基地）。这里不抬的话，面板上写着 16×16、
           * 实际开局被 setup 悄悄拉成 20×20——尺寸显示和真打的那张图对不上。
           */
          if (config.twoCities) {
            const need = twoCityMinSize(2, config.playerCount === 4 ? 4 : 3);
            if (config.size < need) config.size = need;
          }
        }
        // 回到两人局：双城市开局这个开关不适用（两家本来就两座城），顺手关掉
        if (config.playerCount === 2) config.twoCities = false;
        paint();
        return;
      }

      // 双城市开局：切换 + 自动把棋盘抬到能放下八座城的尺寸
      const twoBtn = target.closest<HTMLElement>('[data-two-cities]');
      if (twoBtn) {
        config.twoCities = !(config.twoCities === true);
        if (config.twoCities) {
          // 最小边长跟"几家"有关（三家走外圈环、四家走田字四区），式子只有 mapgen 那一份
          const need = twoCityMinSize(2, config.playerCount === 4 ? 4 : 3);
          if (config.size < need) config.size = need;
        }
        paint();
        return;
      }

      const firstBtn = target.closest<HTMLElement>('[data-first]');
      if (firstBtn?.dataset.first) {
        const v = firstBtn.dataset.first;
        config.firstSide = v === 'B' ? 'B' : v === 'random' ? 'random' : 'A';
        paint();
        return;
      }

      const aiBtn = target.closest<HTMLElement>('[data-ai]');
      if (aiBtn?.dataset.ai !== undefined) {
        const mode = aiBtn.dataset.ai;
        config.aiAlly = mode === '2';
        config.aiOpponent = mode === '1' || mode === '2';
        // 指挥官模式保留：双 AI 观战时两边都受"一回合一个兵"的限制，
        // 这正是用来量"这套限制下 AI 到底能打成什么样"的场景。
        paint();
        return;
      }

      const draftBtn = target.closest<HTMLElement>('[data-draft-mode]');
      if (draftBtn?.dataset.draftMode) {
        config.draftMode = draftBtn.dataset.draftMode === 'on';
        // 沙盒是"随手摆兵"的地方，跟"这一局只能造选到的兵"正好相反
        if (config.draftMode && config.godMode) {
          config.godMode = false;
          config.commanderMode = false;
        }
        paint();
        return;
      }

      // 两档时限分开存：禁用和选人的节奏不一样，共用一个旋钮必然其中一头难受
      const banBtn = target.closest<HTMLElement>('[data-draft-ban]');
      if (banBtn?.dataset.draftBan) {
        config.draftBanMs = Number(banBtn.dataset.draftBan);
        paint();
        return;
      }
      const pickBtn = target.closest<HTMLElement>('[data-draft-pick]');
      if (pickBtn?.dataset.draftPick) {
        config.draftPickMs = Number(pickBtn.dataset.draftPick);
        paint();
        return;
      }

      const roleBtn = target.closest<HTMLElement>('[data-role]');
      if (roleBtn?.dataset.role) {
        const role = roleBtn.dataset.role;
        config.commanderMode = role === 'commander';
        config.godMode = role === 'god';
        /*
         * 两人局：指挥官模式必须对着 AI 打——热座两边都是人，就没人执行战术了。
         * 多人局不一样：AI 只替**排了队列的那一方**执行，其余席位照旧由人操作，
         * 所以这里不能顺手把 aiOpponent 打开（那会在面板上留下一个不生效的开关）。
         */
        if (config.commanderMode && (config.playerCount ?? 2) <= 2) {
          config.aiOpponent = true;
          config.aiAlly = false;
        }
        // 上帝模式是纯单人沙盒：两边都由玩家摆，托管开关留着只会
        // 让某一方在开局就自己跑起来，"摆完再看"这件事就做不到了
        if (config.godMode) {
          config.aiOpponent = false;
          config.aiAlly = false;
          config.commanderMode = false;
          // 测试 AI 的选择也一并放下：上帝模式那一栏根本不显示 AI 选项，
          // 留着它就成了"看不见却生效"的设定——沙盒里点「交给 AI」时会突然
          // 换成网络内核，而面板上没有任何地方写着这件事。
          config.aiBrain = 'script';
          // 沙盒不产兵，选卡在这一局没有任何作用，别留个"开了却不生效"的开关
          config.draftMode = false;
        }
        paint();
        return;
      }

      const lvBtn = target.closest<HTMLElement>('[data-ailevel]');
      if (lvBtn?.dataset.ailevel) {
        const lv = lvBtn.dataset.ailevel;
        config.aiLevel = lv === 'basic' ? 'basic' : lv === 'tactic' ? 'tactic' : 'advanced';
        // 点档位＝"用手写引擎的那一档"，从测试 AI 切回来就靠这一下
        config.aiBrain = 'script';
        paint();
        return;
      }

      const brainBtn = target.closest<HTMLElement>('[data-aibrain]');
      if (brainBtn?.dataset.aibrain) {
        config.aiBrain = brainBtn.dataset.aibrain === 'net' ? 'net' : 'script';
        paint();
        return;
      }

      const eraBtn = target.closest<HTMLElement>('[data-era]');
      if (eraBtn?.dataset.era) {
        config.startEra = Number(eraBtn.dataset.era);
        // 选时代会顺手把棋盘换成这个时代的"标准尺寸"：
        // 青铜 12×12、铁器 16×16、火器/蒸汽/现代 20×20。
        // 理由是实测出来的——小图配信息化开局，摆不下几个兵就打成一团；
        // 大图配青铜开局，两边要走十个回合才照面。
        config.size = DEFAULT_SIZE_FOR_ERA(config.startEra);
        paint();
        return;
      }

      const sizeBtn = target.closest<HTMLElement>('[data-size]');
      if (sizeBtn?.dataset.size) {
        config.size = Number(sizeBtn.dataset.size);
        paint();
        return;
      }

      const styleBtn = target.closest<HTMLElement>('[data-mapstyle]');
      if (styleBtn?.dataset.mapstyle) {
        config.mapStyle = styleBtn.dataset.mapstyle as NonNullable<MatchConfig['mapStyle']>;
        paint();
        return;
      }

      const mapBtn = target.closest<HTMLElement>('[data-map]');
      if (mapBtn) {
        // 空字符串＝"随机地形"：必须能取消，否则选了固定图就再也回不去了
        const id = mapBtn.dataset.map ?? '';
        const picked = id ? fixedMapById(id) : null;
        config.fixedMap = picked ?? undefined;
        // 尺寸跟着地图走：面板上那排尺寸按钮显示的是"这一局多大"，
        // 选了 16×16 的图却还亮着 20×20，就是在说一句和事实相反的话。
        if (picked) config.size = picked.w;
        paint();
        return;
      }

      const symBtn = target.closest<HTMLElement>('[data-symmetry]');
      if (symBtn?.dataset.symmetry) {
        config.mapSymmetry = symBtn.dataset.symmetry as NonNullable<MatchConfig['mapSymmetry']>;
        paint();
        return;
      }

      const unitBtn = target.closest<HTMLElement>('[data-unit]');
      if (unitBtn?.dataset.unit) {
        const id = unitBtn.dataset.unit;
        const wasOn = isUnitOn(id);
        // 至少留一个：一个兵都没有的池子开不了局，而"开局才发现造不了兵"
        // 比"这一下点不动"难解释得多。弹层里就这么一下的静默拒绝。
        if (wasOn && onUnitCount() <= 1) return;
        setUnitOn(id, !wasOn);
        // 只翻转这一颗 chip 的样式，不重绘整个弹层：
        // 两百多个 chip 重绘会闪，滚动位置也得再搬一次。
        unitBtn.classList.toggle('active', !wasOn);
        paintPoolCount();
        return;
      }

      const act = target.closest<HTMLElement>('[data-act]')?.dataset.act;
      if (act === 'cancel') close(null);
      if (act === 'start') {
        // 按注册顺序固定下来：同样的勾选组合，不管点击先后，生效顺序都一样。
        // 钩子是有叠加效果的，顺序漂移会让"同一局"算出不同结果。
        // 前置补齐再排序。勾选时已经补过一次，这里再补一次是因为
        // 配置也可能从别处进来（存档、分享的链接），不能假设它自洽。
        const ids = new Set(config.expansionIds);
        for (const id of Array.from(ids)) {
          for (const need of expansionById(id)?.requires ?? []) ids.add(need);
        }
        const ordered = EXPANSIONS.filter((e) => ids.has(e.id)).map((e) => e.id);
        close({ config: { ...config, expansionIds: ordered }, seed: currentSeed });
      }
      if (act === 'reroll') {
        currentSeed = randomSeed();
        paint();
      }

      // ── 兵种池弹层：展开 / 收起 / 全选 / 只留本体 ──
      if (act === 'unit-pool') {
        poolOpen = true;
        paint();
        return;
      }
      if (act === 'unit-pool-close') {
        poolOpen = false;
        paint();
        return;
      }
      if (act === 'unit-pool-all' || act === 'unit-pool-base') {
        // 两颗都是"一次改一整套"，改完必须重绘——不像单点一颗那样能就地翻转。
        // 「只留本体」不会把池子清空（本体兵种全部留下），所以过得了"至少留一个"。
        const onlyBase = act === 'unit-pool-base';
        const { catalog, extras } = unitPool();
        for (const id of Object.keys(catalog)) {
          if (isPseudoUnit(id)) continue;
          setUnitOn(id, onlyBase ? !extras.has(id) : true);
        }
        paint();
        return;
      }

      // ── 地图页：选文件 / 上传 / 取消 / 刷新 ──
      if (act === 'map-file') {
        mask.querySelector<HTMLInputElement>('[data-field="map-file"]')?.click();
        return;
      }
      if (act === 'map-cancel') {
        mapDraft = null;
        mapNote = '';
        paint();
        return;
      }
      if (act === 'map-refresh') {
        mapNote = '正在刷新地图库…';
        mapBad = false;
        paint();
        loadCloudMaps();
        return;
      }
      if (act === 'map-upload') {
        if (!mapDraft) return;
        const draft = mapDraft;
        mapNote = '正在上传…';
        mapBad = false;
        paint();
        void uploadSharedMap(draft).then((res) => {
          if (!alive) return;
          if (res.ok && res.map) {
            const got = res.map;
            // 登记进本机注册表，并**当场选中**：传完就该能直接用，
            // 不该让人再去画廊里找一遍自己刚传的那张。
            registerUserMaps([got]);
            config.fixedMap = got;
            config.size = got.w;
            mapDraft = null;
            mapNote = `已提交「${got.name}」，等审核放行后别人就能选到它（本局已选中，你自己随时能用）`;
            mapBad = false;
          } else {
            mapNote = res.reason ?? '上传失败';
            mapBad = true;
          }
          paint();
        });
        return;
      }
    });

    /**
     * 自定义边长输入。
     *
     * 每敲一下就夹一次范围并立刻生效，但**不重绘面板**——
     * 重绘会把输入框换成新节点，光标和还没输完的数字都会被吞掉
     * （"想输 24，输到 2 就被重绘回 12"）。只同步 chip 的高亮即可。
     */
    const applySizeInput = (input: HTMLInputElement, commit: boolean): void => {
      config.size = clampBoardSize(input.value);
      mask.querySelectorAll<HTMLElement>('[data-size]').forEach((el) => {
        el.classList.toggle('active', Number(el.dataset.size) === config.size);
      });
      // commit = 失焦/回车：这时候把夹过的值写回框里，免得留着一个越界的 999
      if (commit) input.value = String(config.size);
    };
    mask.addEventListener('input', (e) => {
      const input = e.target as HTMLInputElement;
      if (input.dataset.field === 'size') applySizeInput(input, false);
    });
    mask.addEventListener('change', (e) => {
      const input = e.target as HTMLInputElement;
      if (input.dataset.field === 'map-file') {
        const file = input.files?.[0];
        // 先把 value 清掉：同一个文件改完再选一次，change 才会重新触发
        input.value = '';
        if (file) readMapFile(file);
        return;
      }
      if (input.dataset.field === 'size') {
        applySizeInput(input, true);
        return;
      }
      if (input.dataset.field === 'record') {
        config.recordDetail = input.checked;
        saveRecordPref(input.checked);
        // 只翻转卡片边框，不整块重绘：checkbox 重绘会闪，焦点也会丢
        input.closest('.expansion-item')?.classList.toggle('on', input.checked);
        return;
      }
      const id = input.dataset.exp;
      if (!id) return;
      // 地貌列表是扩展的函数：勾上/取消可能让"地貌"一栏多出或少掉几个 chip。
      // 记下变动前后的选项数，变了就整块重绘（不重绘的话新 chip 要等下次重绘才出现）。
      const stylesBefore = mapStylesFor(config.expansionIds).length;
      // 时代按钮也一样是扩展的函数：「现代战争」勾上就多出「信息化」这一格。
      const erasBefore = ERAS.filter((e) => e.level <= eraCeilingFor(config.expansionIds)).length;
      // 兵种池同样是扩展的函数：这一包带的兵会多出来 / 少掉十几格。
      const unitsBefore = Object.keys(unitPool().catalog).length;
      if (input.checked) {
        if (!config.expansionIds.includes(id)) config.expansionIds.push(id);
        // 自动补上前置：勾了「骑士团」却没勾「法则」，这包兵根本不会进场。
        for (const need of expansionById(id)?.requires ?? []) {
          if (config.expansionIds.includes(need)) continue;
          config.expansionIds.push(need);
          const box = mask.querySelector<HTMLInputElement>(`[data-exp="${need}"]`);
          if (box) {
            box.checked = true;
            box.closest('.expansion-item')?.classList.add('on');
          }
        }
      } else {
        config.expansionIds = config.expansionIds.filter((x) => x !== id);
        // 这一包的兵从名单里消失了，那些"关掉"的记录也就没了意义——
        // 留着的话，下次再把这一包勾回来，玩家会发现几条船还是关着的，
        // 而他上次关它们可能已经是好几局以前的事。
        const gone = new Set((expansionById(id)?.units ?? []).map((u) => u.id));
        if (gone.size > 0) {
          config.disabledUnits = (config.disabledUnits ?? []).filter((x) => !gone.has(x));
        }
      }
      // 关掉「地形高差」之后，原来选中的高原/峡谷必须退回"随机"——
      // 不然会画出一张满地图台地、但规则里没有高度的图。
      const available = mapStylesFor(config.expansionIds);
      if (!available.some((st) => st.id === (config.mapStyle ?? 'random'))) {
        config.mapStyle = 'random';
      }
      // 起手时代也不能停在一个刚被关掉的时代上：关掉「现代战争」之后，
      // startEra 若还是 6，开局会静默退回第五时代，而按钮上没有任何东西
      // 显示这件事——玩家只会觉得"我明明选了现代"。
      const ceilingNow = eraCeilingFor(config.expansionIds);
      if (config.startEra > ceilingNow) config.startEra = ceilingNow;
      const erasAfter = ERAS.filter((e) => e.level <= ceilingNow).length;
      // 选项数变了就重绘（地貌 chip、时代按钮、兵种池的格子都要增删）。
      // 其余情况只改边框，避免 checkbox 闪。
      if (
        available.length !== stylesBefore ||
        erasAfter !== erasBefore ||
        Object.keys(unitPool().catalog).length !== unitsBefore
      ) {
        paint();
        return;
      }
      // 让卡片边框跟着变，不重绘整个面板（否则 checkbox 会闪）
      input.closest('.expansion-item')?.classList.toggle('on', input.checked);
    });

    paint();
    document.body.appendChild(mask);
    loadCloudMaps();
  });
}
