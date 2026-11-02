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

    return res?.error ? classify(res.error) : { ok: true };
  } catch (err) {
    return classify(err as DbFailure);
  }
}

export const SNAPSHOT_TABLE = TABLE;
