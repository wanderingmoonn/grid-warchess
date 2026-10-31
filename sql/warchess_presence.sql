-- 房间在线状态（观战人数）
--
-- 什么时候要执行这个文件：想让联机房间显示"现在有几个人在看"的时候，一次性执行。
-- 不执行也不影响下棋：界面只是不显示人数，其余功能照常。
--
-- 为什么单独一张表，而不是往 warchess_rooms 里加一列：
--   room 那一行是**整局快照**，提交时按 turn 做乐观锁（submitTurn）。
--   往同一行里写 presence，就得和"提交回合"抢同一行——观战者每次心跳都可能
--   把一次提交挤掉，或者反过来被提交覆盖。一条在线状态＝一行独立记录，
--   谁写谁的，天然不互相踩。
--
-- 边界：
--   · 房间码就是钥匙，任何人拿到 6 位码都能看到这间房有几个人在看（本来也能看棋）。
--   · 表里只有随机 client_id、角色、昵称和心跳时间，没有账号信息。
--   · 行会被心跳反复覆盖（主键是 room + client_id），不会无限增长；
--     过期行按 seen_at 过滤，不参与计数。

create table if not exists public.warchess_presence (
  -- 6 位房间码（warchess_rooms.code）
  room       text        not null,
  -- 这台浏览器的随机代号（src/net/client-id.ts）。不是身份，只用来去重
  client_id  text        not null,
  -- 'watch' = 观战，'seat' = 参赛者。人数只统计 watch
  role       text        not null default 'watch',
  -- 显示用的名字（观战者一般就叫"观众"）
  name       text        not null default '',
  seen_at    timestamptz not null default now(),
  primary key (room, client_id)
);

-- 读永远是"这个房间的全部心跳"，按 room 建索引足够
create index if not exists warchess_presence_room_idx
  on public.warchess_presence (room, seen_at desc);

alter table public.warchess_presence enable row level security;

-- GRANT 与 POLICY 是两道独立的门：只做 RLS 不 GRANT 会得到形似"策略失效"的 42501
grant select, insert, update on public.warchess_presence to anon, authenticated;

drop policy if exists warchess_presence_read on public.warchess_presence;
create policy warchess_presence_read on public.warchess_presence
  for select to anon, authenticated using (true);

drop policy if exists warchess_presence_write on public.warchess_presence;
create policy warchess_presence_write on public.warchess_presence
  for insert to anon, authenticated with check (true);

drop policy if exists warchess_presence_touch on public.warchess_presence;
create policy warchess_presence_touch on public.warchess_presence
  for update to anon, authenticated using (true) with check (true);
