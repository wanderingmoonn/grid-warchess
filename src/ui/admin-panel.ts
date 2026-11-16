/**
 * 审核台：放行 / 下架 / 删除玩家提交的**关卡**和**地图**，顺带看反馈快照与整体计数。
 *
 * 打开方式：在游戏链接后加 `&admin=1`（例如 `?sharecode=xxx&admin=1`）。
 *
 * 为什么不做一个独立的 admin.html：
 *   - 多入口要改构建配置，而这套东西只在需要审核时打开，不值得为它多一个包；
 *   - 审核台要读的云端凭据和游戏是同一套，放同一个应用里反而少一类「线上域名
 *     和 publishableKey 对不上」的坑（cloud-config.ts 顶上记着这个事故）。
 *
 * **口令怎么保管**：这里不存、不校验口令，只把它原样带进数据库的
 * `SECURITY DEFINER` 函数，由库里那张没有策略的 `warchess_admin` 表判断。
 * 也就是说：前端拿到密钥也改不了别人的关卡——所有提权都发生在服务端，
 * 前端只有一句 `rpc(...)`。口令本身存在本机 localStorage，方便下次打开。
 */

import { cloudDatabase } from '../net/room.ts';
import { mapThumbSvg } from './map-thumb.ts';
import { validateLevel, type LevelDef } from '../core/level.ts';

interface AdminRow {
  id: number;
  name: string;
  author?: string | null;
  w?: number;
  h?: number;
  seats?: number;
  events?: number;
  listed?: boolean;
  at?: string;
  note?: string;
  build?: string;
  seed?: number;
  turns?: number;
}

interface AdminData {
  levels: AdminRow[];
  maps: AdminRow[];
  snapshots: AdminRow[];
  log?: Array<{ at: string; kind: string; rid: number; action: string }>;
  stats: Record<string, number>;
}

type Db = {
  rpc(
    name: string,
    args?: Record<string, unknown>,
  ): PromiseLike<{ data?: unknown; error?: { message?: string } | null }>;
};

const TOKEN_KEY = 'wc-admin-token';
type Tab = 'levels' | 'maps' | 'snapshots';

const esc = (s: unknown): string =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

function ago(iso?: string): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const min = Math.round((Date.now() - t) / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} 小时前`;
  return `${Math.round(h / 24)} 天前`;
}

export function openAdminPanel(opts: { onPlay?: (level: LevelDef) => void } = {}): void {
  const mask = document.createElement('div');
  mask.className = 'admin-mask';
  document.body.appendChild(mask);

  let token = localStorage.getItem(TOKEN_KEY) ?? '';
  let tab: Tab = 'levels';
  let data: AdminData | null = null;
  let busy = false;
  let msg = '';
  /** 点「查看」时抓回来的一行：用来画地图缩略图 + 关键信息 */
  let detailRow: { kind: string; row: Record<string, any> } | null = null;
  let detailErr = '';

  const db = async (): Promise<Db> => (await cloudDatabase()) as unknown as Db;

  /**
   * 「查看」面板：**先给一眼能看懂的东西**（地图缩略图 + 关键数字），
   * 原始 JSON 折在下面。
   *
   * 只丢一坨 JSON 是偷懒：审核要看的是"这张图能不能玩、是不是刷屏的垃圾"，
   * 而 `{"w":24,...}` 这种字符串谁也读不出形状。缩略图复用的是选关卡片
   * 同一个函数（`mapThumbSvg`），所以这里看到的和玩家选关时看到的完全一致。
   */
  const detailHtml = (): string => {
    if (detailErr) return `<pre class="admin-detail">${esc(detailErr)}</pre>`;
    if (!detailRow) return '';
    const { kind, row } = detailRow;
    const lv = kind === 'level' ? (row.data as Record<string, any>) : null;
    const map =
      kind === 'level'
        ? (lv?.map as Record<string, any> | undefined)
        : kind === 'map'
          ? {
              name: row.name,
              w: row.w,
              h: row.h,
              rows: row.rows,
              citiesA: row.cities_a,
              citiesB: row.cities_b,
              source: 'user',
            }
          : null;
    const thumb = map
      ? `<div class="admin-thumb">${mapThumbSvg(map as never, 2, lv?.seats?.cities as never)}</div>`
      : '';
    const facts: string[] = [];
    if (kind === 'level' && lv) {
      facts.push(`${lv.map?.w ?? '?'}×${lv.map?.h ?? '?'}`);
      facts.push(`${lv.seats?.count ?? 2} 家`);
      const ai = Array.isArray(lv.seats?.ai) ? lv.seats.ai.join('/') : '';
      facts.push(ai ? `电脑：${ai}` : '全真人');
      facts.push(`${Array.isArray(lv.events) ? lv.events.length : 0} 条事件`);
      if (Array.isArray(lv.goals) && lv.goals.length) facts.push(`${lv.goals.length} 个目标`);
    } else if (kind === 'map') {
      facts.push(`${row.w}×${row.h}`);
      facts.push(`${Array.isArray(row.cities_a) ? row.cities_a.length : 0}+${
        Array.isArray(row.cities_b) ? row.cities_b.length : 0
      } 城`);
    } else {
      facts.push(`回合 ${row.turns ?? '?'}`);
      facts.push(`种子 ${row.seed ?? '?'}`);
      if (row.build) facts.push(String(row.build));
    }
    const raw = JSON.stringify(row, null, 2);
    const playable = kind === 'level' && opts.onPlay ? lv : null;
    return `
      ${thumb}
      ${
        playable
          ? `<div class="admin-play"><button class="btn btn-sm" data-act="play" data-id="${row.id}">试玩这张关</button>
             <span class="admin-note">会在游戏里直接开一局（不影响已有存档，点「新对局」可退出）</span></div>`
          : ''
      }
      <div class="admin-facts">${facts.map((t) => `<span class="admin-chip">${esc(t)}</span>`).join('')}</div>
      <details class="admin-raw">
        <summary>原始 JSON（${Math.round(raw.length / 1024)}KB）</summary>
        <pre class="admin-detail">${esc(raw.slice(0, 6000))}</pre>
      </details>`;
  };

  const paint = (): void => {
    const stats = data?.stats;
    const rows = data ? (tab === 'levels' ? data.levels : tab === 'maps' ? data.maps : data.snapshots) : [];

    const statLine = stats
      ? [
          `待审关卡 ${stats.levels_pending ?? 0}`,
          `关卡 ${stats.levels ?? 0}`,
          `待审地图 ${stats.maps_pending ?? 0}`,
          `地图 ${stats.maps ?? 0}`,
          `反馈 ${stats.snapshots ?? 0}`,
          `对局报告 ${stats.reports ?? 0}`,
          `房间 ${stats.rooms ?? 0}`,
        ]
          .map((t) => `<span class="admin-chip">${esc(t)}</span>`)
          .join('')
      : '';

    mask.innerHTML = `
      <section class="admin-card" role="dialog" aria-label="审核台">
        <header class="admin-head">
          <h2>审核台</h2>
          <button class="btn btn-sm" data-act="close">关闭</button>
        </header>
        ${
          token
            ? `
          <div class="admin-stats">${statLine}</div>
          <div class="admin-tabs">
            <button class="chip ${tab === 'levels' ? 'active' : ''}" data-tab="levels">关卡${
              stats?.levels_pending ? `（${stats.levels_pending} 待审）` : ''
            }</button>
            <button class="chip ${tab === 'maps' ? 'active' : ''}" data-tab="maps">地图${
              stats?.maps_pending ? `（${stats.maps_pending} 待审）` : ''
            }</button>
            <button class="chip ${tab === 'snapshots' ? 'active' : ''}" data-tab="snapshots">反馈快照</button>
            <button class="btn btn-sm" data-act="reload">刷新</button>
          </div>
          <div class="admin-msg">${esc(msg)}</div>
          <div class="admin-list">
            ${
              busy
                ? '<p class="admin-empty">读取中…</p>'
                : rows.length === 0
                  ? '<p class="admin-empty">这一栏是空的</p>'
                  : rows
                      .map((r) => {
                        const kind = tab === 'levels' ? 'level' : 'map';
                        const meta =
                          tab === 'snapshots'
                            ? `${esc(r.build ?? '')} · 回合 ${esc(r.turns ?? '')} · 种子 ${esc(r.seed ?? '')}`
                            : `${esc(r.w ?? '?')}×${esc(r.h ?? '?')}${
                                tab === 'levels' ? ` · ${esc(r.seats ?? 2)} 家 · ${esc(r.events ?? 0)} 事件` : ''
                              }`;
                        const badge = r.listed ? '已放行' : '待审';
                        const viewBtn = `<button class="btn btn-sm" data-act="view" data-kind="${
                          tab === 'snapshots' ? 'snapshot' : kind
                        }" data-id="${r.id}">查看</button>`;
                        const actions =
                          tab === 'snapshots'
                            ? viewBtn
                            : `${viewBtn}
                               <button class="btn btn-sm" data-act="toggle" data-kind="${kind}" data-id="${r.id}" data-listed="${
                                 r.listed ? '1' : '0'
                               }">${r.listed ? '下架' : '放行'}</button>
                               <button class="btn btn-sm btn-danger" data-act="del" data-kind="${kind}" data-id="${r.id}">删除</button>`;
                        return `
                          <div class="admin-row">
                            <div class="admin-row-main">
                              <b>${esc(r.name ?? r.note ?? '（无题）')}</b>
                              <span class="admin-badge ${r.listed ? 'ok' : 'wait'}">${badge}</span>
                              <div class="admin-meta">${meta}${r.author ? ` · ${esc(r.author)}` : ''} · ${esc(ago(r.at))}</div>
                            </div>
                            <div class="admin-row-act">${actions}</div>
                          </div>`;
                      })
                      .join('')
            }
          </div>
          ${detailHtml()}
          ${
            (data?.log ?? []).length > 0
              ? `<div class="admin-log"><b>最近操作</b>${(data?.log ?? [])
                  .slice(0, 6)
                  .map(
                    (g) =>
                      `<span class="admin-log-item">${esc(g.action)} ${esc(g.kind)} #${g.rid} · ${esc(ago(g.at))}</span>`,
                  )
                  .join('')}</div>`
              : ''
          }
          <div class="admin-foot">
            <button class="btn btn-sm" data-act="forget">清除口令</button>
            <span class="admin-note">放行后别人就能看到；删除不可恢复。</span>
          </div>`
            : `
          <p class="admin-note">输入管理口令。口令只发给数据库，前端不保存明文校验逻辑。</p>
          <input class="admin-token" type="password" placeholder="管理口令" autocomplete="off" />
          <div class="admin-msg">${esc(msg)}</div>
          <button class="btn" data-act="login">进入</button>`
        }
      </section>`;
  };

  const load = async (): Promise<void> => {
    if (!token) return;
    busy = true;
    msg = '';
    paint();
    try {
      const res = await (await db()).rpc('warchess_admin_list', { t: token });
      if (res.error) {
        /*
         * 口令错时**把输入框放回来**（2026-11-16）。
         *
         * 原来只是把 "bad admin token" 原样显示在统计条下面，人看到的是一句英文、
         * 而且界面还停在"已登录"的样子（没有输入框可改）——只能点「清除口令」重来，
         * 而那句话没提示这一点。口令是手打的（`1` 和 `l` 这种字最容易抄错），
         * 所以这条路必须好走。
         */
        const raw = res.error.message ?? '读取失败';
        if (/bad admin token/i.test(raw)) {
          localStorage.removeItem(TOKEN_KEY);
          token = '';
          msg = '口令不对，已清空——重新输入一次';
        } else {
          msg = raw;
        }
        data = null;
      } else {
        data = res.data as AdminData;
      }
    } catch (err) {
      msg = err instanceof Error ? err.message : '读取失败';
    }
    busy = false;
    paint();
  };

  const act = async (kind: string, id: number, what: 'toggle' | 'del', listed: boolean): Promise<void> => {
    if (what === 'del' && !window.confirm('删除后不可恢复，确定？')) return;
    busy = true;
    paint();
    try {
      const call =
        what === 'del'
          ? (await db()).rpc('warchess_admin_del', { t: token, kind, rid: id })
          : (await db()).rpc('warchess_admin_set', { t: token, kind, rid: id, listed: !listed });
      const res = await call;
      msg = res.error ? (res.error.message ?? '操作失败') : what === 'del' ? '已删除' : listed ? '已下架' : '已放行';
    } catch (err) {
      msg = err instanceof Error ? err.message : '操作失败';
    }
    busy = false;
    await load();
  };

  mask.addEventListener('click', (ev) => {
    const el = (ev.target as HTMLElement).closest<HTMLElement>('[data-act], [data-tab]');
    if (!el) {
      if (ev.target === mask) mask.remove();
      return;
    }
    const t = el.dataset.tab as Tab | undefined;
    if (t) {
      tab = t;
      paint();
      return;
    }
    const a = el.dataset.act;
    if (a === 'close') mask.remove();
    else if (a === 'reload') void load();
    else if (a === 'login') {
      const input = mask.querySelector<HTMLInputElement>('.admin-token');
      token = input?.value.trim() ?? '';
      if (!token) {
        msg = '口令不能为空';
        paint();
        return;
      }
      localStorage.setItem(TOKEN_KEY, token);
      void load();
    } else if (a === 'forget') {
      localStorage.removeItem(TOKEN_KEY);
      token = '';
      data = null;
      msg = '';
      paint();
    } else if (a === 'play' && detailRow && opts.onPlay) {
      const checked = validateLevel(detailRow.row.data as object);
      if (!checked.ok) {
        detailErr = `这张关的数据过不了校验，打不开：${checked.errors[0] ?? ''}`;
        paint();
        return;
      }
      mask.remove();
      opts.onPlay(checked.level);
    } else if (a === 'view') {
      const kind = el.dataset.kind ?? 'level';
      void (async () => {
        detailErr = '';
        detailRow = null;
        try {
          const res = await (await db()).rpc('warchess_admin_one', {
            t: token,
            kind,
            rid: Number(el.dataset.id),
          });
          if (res.error) detailErr = `读取失败：${res.error.message ?? ''}`;
          else if (res.data) detailRow = { kind, row: res.data as Record<string, any> };
          else detailErr = '这一条已经不在了（刚被删掉？）';
        } catch (err) {
          detailErr = err instanceof Error ? err.message : '读取失败';
        }
        paint();
      })();
    } else if (a === 'toggle' || a === 'del') {
      void act(el.dataset.kind ?? 'level', Number(el.dataset.id), a, el.dataset.listed === '1');
    }
  });

  paint();
  if (token) void load();
}
