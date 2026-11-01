-- 三/四人联机：房间表补两个席位列
--
-- 背景：warchess_rooms 一开始只有 seat_a / seat_b（两方对局），三人四人局
-- 需要 seat_c / seat_d 才能记下"谁坐在绿方、黄方"。列名和 src/net/room.ts 的
-- SEAT_COLUMN 一一对应，加人只改那一张表。
--
-- 这两列是**可空**的：两人局写 null，老房间读出来也是 null，两边都不用迁移数据。
-- 代码里对此做了降级（见 room.ts createRoom）：库还没跑这条 alter 时，
-- 两人局照样能建房（写入时自动省掉这两列），只有三人四人局会明确报错让你来跑它。
--
-- 执行位置：云数据库的 SQL 控制台（同一个 app，不是本地 Postgres）。
-- 可重复执行。

alter table warchess_rooms add column if not exists seat_c text;
alter table warchess_rooms add column if not exists seat_d text;

comment on column warchess_rooms.seat_c is 'C 座（绿方）的席位令牌；没坐人就是 null。三人四人局用';
comment on column warchess_rooms.seat_d is 'D 座（黄方）的席位令牌；没坐人就是 null。四人局用';

-- 检查：应该能看到 seat_a ~ seat_d 四列
-- select column_name, data_type, is_nullable
--   from information_schema.columns
--  where table_name = 'warchess_rooms' and column_name like 'seat%'
--  order by column_name;
