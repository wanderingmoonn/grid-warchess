-- 联机房间的聊天表
--
-- 什么时候要执行这个文件：想让联机房间里能说话的时候，一次性执行。
-- 不执行也不影响下棋：界面会明说"聊天还没开通"，其余功能照常。
--
-- 为什么单开一张表、而不是塞进 warchess_rooms.state：
--   state 是**整局快照**，提交时整块覆盖。聊天住在里面就只能跟着"结束回合"发出去，
--   观战位根本不提交，等于永远发不出声；而"只改 state 里的 chat 字段"要先读整行再整块写回，
--   中途对方提交的那一回合会被抹掉。一条消息＝一次 insert，天然不互相覆盖。
--
-- 边界（表结构本身就是这句话的注脚）：
--   · 房间码就是钥匙。任何拿到 6 位码的人都能读这个房间的聊天、也能发言。
--     这里没有账号、没有私聊，所以别在聊天里放真名和联系方式。
--   · 只给 select / insert：消息发出去之后不能改也不能删。
--     真需要清理就由管理员连接（migrate 角色）定期删老房间，和房间表的节奏一致。

create table if not exists public.warchess_chat (
  id          bigserial primary key,
  created_at  timestamptz not null default now(),
  -- 6 位房间码（warchess_rooms.code）
  room        text        not null,
  -- 'A' / 'B' / 'watch'。只用于显示"我方 / 对方 / 观众"，不是身份证明
  seat        text        not null,
  -- 显示用的名字（玩家名，或者"观众"）
  name        text        not null,
  -- 已经过客户端清洗：去控制字符、压空白、截到 120 字
  body        text        not null
);

-- 取消息永远是"这个房间、id 比上次大"，所以按 (room, id) 建索引
create index if not exists warchess_chat_room_idx
  on public.warchess_chat (room, id);

alter table public.warchess_chat enable row level security;

-- GRANT 和 POLICY 是两道独立的门，只做 RLS 不 GRANT 会得到形似"策略失效"的 42501。
grant select, insert on public.warchess_chat to anon, authenticated;
grant usage, select on sequence public.warchess_chat_id_seq to anon, authenticated;

drop policy if exists warchess_chat_insert on public.warchess_chat;
create policy warchess_chat_insert on public.warchess_chat
  for insert to anon, authenticated
  with check (true);

-- 读是放开的：房间码就是这条链路的边界（见文件头）。
-- 想收紧的话，只能在服务端拿席位令牌做校验——那是"联机防作弊"那条路上的事。
drop policy if exists warchess_chat_read on public.warchess_chat;
create policy warchess_chat_read on public.warchess_chat
  for select to anon, authenticated using (true);
