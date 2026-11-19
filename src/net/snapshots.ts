/**
 * 局面快照的上传通道。
 *
 * 和 `reports.ts` 长得几乎一样，但**表是分开的**，这是刻意的：
 *
 *   · warchess_reports  —— 匿名平衡数据，公开上交，代表怎么切都行；
 *   · warchess_snapshots —— 完整局面（带名字、带坐标、带日志），是"我遇到个问题"。
 *
 * 混进一张表，第一件坏事就是"匿名"这句话不再成立；第二件是分析查询
 * 会把 bug 单当成对局算进胜率里。宁可在两张表里各写一遍错误分类，
 * 也不要在一张表上挂两个语义。
 *
 * 仍然不做重试、不做队列、不偷偷后台发：发不发是玩家点那一下的决定。
 */

import {
  SNAPSHOT_CONSENT_VERSION,
  snapshotSignature,
  type BugSnapshot,
} from '../core/snapshot.ts';
import { campaignCode } from './campaign.ts';
import { clientId } from './client-id.ts';
import { cloudDatabase, isMissingColumn } from './room.ts';

const TABLE = 'warchess_snapshots';

export interface SnapshotUploadResult {
  ok: boolean;
  /** 云端已经有这一条了（同一回合、同一句描述、一分钟内）。对玩家等于成功 */
  duplicate?: boolean;
  reason?: string;
  howTo?: string;
  note?: string;
  /** 回读确认到的行号：玩家截图这一行，开发者就能直接找到那条反馈 */
  id?: number;
}

interface DbFailure {
  code?: string;
  message?: string;
}

function classify(err: DbFailure | undefined): SnapshotUploadResult {
  const code = (err?.code ?? '').replace(/^DATABASE_/, '');
  const msg = (err?.message ?? '').toLowerCase();

  if (code === '42P01' || /relation .*does not exist|undefined table|schema cache/.test(msg)) {
    return {
      ok: false,
      reason: '收集端还没开通（云数据库里没有 warchess_snapshots 这张表）',
      howTo: '在云数据库里执行一次 sql/warchess_snapshots.sql 就能开始收；没开通也不影响玩，快照可以「复制」出来直接发给作者。',
    };
  }
  if (code === '23505' || /duplicate key|unique constraint/.test(msg)) {
    return { ok: true, duplicate: true, note: '这条刚刚传过了（同一回合、同一句描述）' };
  }
  if (/too many (reports|snapshots)/.test(msg)) {
    return {
      ok: false,
      reason: '这一小时传得太频繁了，先歇一会儿',
      howTo: '限流是按浏览器算的；快照还在，可以「复制 JSON」发出来。',
    };
  }
  if (code === '42501' || /permission denied|not authorized|invalid_client|origin/.test(msg)) {
    return {
      ok: false,
      reason: '服务端不接受这次上传（凭据或域名对不上）',
      howTo: '核对 src/net/cloud-config.ts 里的域名与密钥是不是当前发布的那一套。',
    };
  }
  // 体积：完整局面 + 逐回合摘要可能上百 KB，库里的 CHECK 会拦
  if (code === '54000' || /too large|payload.*size|check constraint/.test(msg)) {
    return {
      ok: false,
      reason: '这份局面太大了（地图很大 + 开了逐回合记录）',
      howTo: '取消勾选「连同逐回合摘要」，或者只「复制 JSON」发出来。',
    };
  }
  return {
    ok: false,
    reason: `上传没成功：${err?.message ?? '网络不通'}`,
    howTo: '快照还在，可以「复制 JSON」发出来，换个时间再试。',
  };
}

/**
 * 上传一份快照。永远不抛：调用方是界面上的一个按钮。
 */
/**
 * 按 fingerprint 把刚写的那行读回来。
 *
 * 三种结果：`id`（读到了，带行号）、`missing`（没有——权限或写入失败）、
 * `unknown`（读接口本身出错，不敢断言）。
 */
async function readBack(fingerprint: string): Promise<{ kind: 'id'; id: number } | { kind: 'missing' } | { kind: 'unknown' }> {
  try {
    const db = (await cloudDatabase()) as unknown as {
      from(name: string): {
        select(cols: string): {
          eq(col: string, val: string): {
            limit(n: number): PromiseLike<{ data?: Array<{ id?: number }> | null; error?: unknown }>;
          };
        };
      };
    };
    const r = await db.from(TABLE).select('id').eq('fingerprint', fingerprint).limit(1);
    if (r?.error) return { kind: 'unknown' };
    const first = r?.data?.[0];
    return first && typeof first.id === 'number' ? { kind: 'id', id: first.id } : { kind: 'missing' };
  } catch {
    return { kind: 'unknown' };
  }
}

export async function uploadSnapshot(snap: BugSnapshot): Promise<SnapshotUploadResult> {
  try {
    const db = (await cloudDatabase()) as unknown as {
      from(name: string): {
        insert(row: Record<string, unknown>): PromiseLike<{ error?: DbFailure | null }>;
      };
    };

    const row: Record<string, unknown> = {
      client_id: clientId(),
      fingerprint: snapshotSignature(snap),
      campaign: campaignCode(),
      consent: SNAPSHOT_CONSENT_VERSION,
      created_at: snap.at,
      version: snap.v,
      build: snap.build,
      note: snap.note,
      seed: snap.seed,
      turns: snap.turns,
      player_count: snap.playerCount,
      current_player: snap.current,
      winner: snap.winner,
      // 整份快照塞进 payload：以后加字段不用改表
      payload: snap,
    };

    let res = await db.from(TABLE).insert(row);
    if (res?.error && isMissingColumn(res.error)) {
      // 表还是早先那一版（没有 player_count / current_player / build 这些列）：
      // 摘掉新列再试。少几列不影响 payload 里的完整数据。
      delete row.build;
      delete row.player_count;
      delete row.current_player;
      res = await db.from(TABLE).insert(row);
    }
    if (res?.error) return classify(res.error);

    /*
     * **回读确认**（2026-11-19）：写入成功不等于"开发者看得到"。
     *
     * 反馈反复说"上传了但看不到"，而原来这里只要 insert 没报错就回一句
     * "已上传"——RLS 拒绝、网络吞掉、或者表名写错，玩家看到的都是同一句话。
     * 现在写完按 fingerprint 读回来：
     *   · 读得到 → 把行号显示给玩家（"已上传 #12"），他截图就能给开发者定位；
     *   · 读不到 → 明确说"写进去了但读不回来"，这通常是 RLS 策略问题。
     */
    const back = await readBack(row.fingerprint as string);
    if (back.kind === 'missing') {
      /*
       * 写进去了但读不回来：**不算失败**（数据确实落了，别让玩家白填一次），
       * 但必须说清楚——这通常是读权限策略的问题，不是玩家操作错。
       */
      return {
        ok: true,
        note: '已写入，但云端不允许回读确认（读权限策略）。如果开发者说没收到，请用「复制」把内容直接发给他。',
      };
    }
    if (back.kind === 'id') return { ok: true, id: back.id };
    return { ok: true };
  } catch (err) {
    return classify(err as DbFailure);
  }
}

export const SNAPSHOT_TABLE = TABLE;
