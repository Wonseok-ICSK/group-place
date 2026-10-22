-- 멤버 색 바꾸기 (v0.1.2): 더 화사한 무지개 순서 24색 + 직접 고른 색(#rrggbb).
-- 실행 순서: schema.sql → friends-keepalive.sql → friends-signup.sql → groups.sql → 이 파일. SQL Editor에서 한 번만 실행하세요.
-- 중간에 실패하면 전부 취소됩니다. 이미 적용했으면 맨 앞 확인에서 멈춥니다.
-- 설계와 API 계약: docs/groups-design.md §10 (색 id·값, 함수 인자·오류 코드는 그 문서가 기준)
-- 되돌리기: colors_rollback.sql (서버를 이전 릴리스로 먼저 되돌린 뒤 실행. groups_rollback.sql보다 먼저)
--
-- 바뀌는 것:
--   - member_colors: 예전 40색을 지우고 새 24색(빨강 → 주황 → 노랑 → 초록 → 청록 → 파랑 → 남색 → 보라 → 분홍)을 넣음.
--     밝은/어두운 화면 값(light, dark)도 이 표에 둠(비슷한 색 막기에 씀). 표는 지금처럼 앱에서 못 읽음
--   - couple_members.color: 팔레트 id 또는 직접 고른 색 '#rrggbb'(소문자) 하나. 방 안에서 같은 값은 지금처럼 unique로 막음.
--     팔레트 id는 palette_color(자동 계산 칸)의 외래 키로 확인
--   - 기존 멤버 색은 색상각(OKLCH hue)이 가장 가까운 새 색으로 바꿈(방 안에서 겹치면 다음으로 가까운 색)
--   - set_member_color: 팔레트 id나 '#rrggbb'를 받음. 다른 멤버 색과 거의 같으면(OKLab 거리 0.03 미만) color_too_close
--   - 새로 들어온 멤버의 무작위 색(pick_member_color): 새 24색 중 아무도 안 쓰고 다른 멤버 색과 거의 같지 않은 색
--   - 적용 전 멤버 색은 backup.couple_colors_v011_<시각>에 복사해 둠
--   - groups_schema_version()은 그대로 1 (홈 서버는 색을 다루지 않음)
--
-- 잠금: 이 SQL은 확인 직후 couple_members·member_colors를 access exclusive로 잠가 끝날 때까지(1초 안팎) 색 바꾸기·참여를 기다리게 함.
--   set_member_color는 지금처럼 방 잠금(couples 행 for update)만이고, 멤버인지 먼저 확인한 뒤 잠금 (남의 방 행을 잠그지 못하게).

begin;

-- 예전 40색(groups.sql, 화면 v0.1.1의 밝은 화면 값): 기존 멤버 색을 새 색으로 옮길 때만 씀
create temp table _gp_old_colors (id text primary key, light text not null) on commit drop;
insert into _gp_old_colors (id, light) values
  ('orange', '#d76f05'), ('tangerine', '#c97801'), ('amber', '#bd7a05'), ('mustard', '#a48904'), ('olive', '#8f900d'),
  ('lime', '#73970b'), ('green', '#459d2e'), ('emerald', '#0f9f5c'), ('jade', '#119d7c'), ('teal', '#0e8c86'),
  ('cyan', '#0a9aa1'), ('sky', '#0698b2'), ('azure', '#0296c5'), ('blue', '#0091e4'), ('cobalt', '#4b89f2'),
  ('indigo', '#7281f4'), ('violet', '#9079ef'), ('purple', '#a971e3'), ('orchid', '#be6ad1'), ('pink', '#d362b2'),
  ('orange-deep', '#8d561e'), ('tangerine-deep', '#875913'), ('amber-deep', '#7c5f08'), ('mustard-deep', '#6e640d'),
  ('olive-deep', '#5d681c'), ('lime-deep', '#4a6c2d'), ('green-deep', '#346f3e'), ('emerald-deep', '#13714e'),
  ('jade-deep', '#027060'), ('teal-deep', '#106e6c'), ('cyan-deep', '#126d78'), ('sky-deep', '#076c86'),
  ('azure-deep', '#186994'), ('blue-deep', '#36659a'), ('cobalt-deep', '#4b619d'), ('indigo-deep', '#5d5c9c'),
  ('violet-deep', '#6d5898'), ('purple-deep', '#7a5490'), ('orchid-deep', '#855084'), ('pink-deep', '#904d71');

do $$
declare
  v_n integer;
begin
  if to_regclass('public.member_colors') is null
     or not exists (select 1 from information_schema.columns
                    where table_schema = 'public' and table_name = 'couple_members' and column_name = 'color') then
    raise exception '먼저 supabase/groups.sql을 실행하세요.';
  end if;
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'member_colors' and column_name = 'light') then
    raise exception '이미 적용된 SQL이에요 (member_colors.light 칸이 있음).';
  end if;
  if to_regprocedure('public.set_member_color(uuid, text)') is null
     or to_regprocedure('public.pick_member_color(uuid)') is null then
    raise exception 'set_member_color·pick_member_color 함수가 없어요. groups.sql을 먼저 실행하세요.';
  end if;
  -- 확인·backup·옮기기가 한 시점의 데이터를 보게 먼저 잠금 (아래 alter가 어차피 잡는 가장 센 잠금이라 그사이 색 바꾸기·참여는 끝날 때까지 기다림)
  lock table public.couple_members, public.member_colors in access exclusive mode;
  select count(*) into v_n from public.couple_members m where not exists (select 1 from _gp_old_colors o where o.id = m.color);
  if v_n > 0 then
    raise exception '예상하지 못한 데이터: 예전 40색 목록에 없는 색을 쓰는 멤버가 %명 있어요.', v_n;
  end if;
  -- 적용 전 색을 남겨 둠 (되돌리기는 가장 가까운 색으로 옮기므로, 정확히 되살리려면 이 표를 씀)
  create schema if not exists backup;
  execute format('create table backup.%I as select couple_id, user_id, color from public.couple_members',
                 'couple_colors_v011_' || to_char(now() at time zone 'Asia/Seoul', 'YYYYMMDD_HH24MISS'));
end $$;

-- ---------- 색 목록 바꾸기 ----------
alter table public.couple_members drop constraint couple_members_color_fkey;
-- 예전 id와 새 id가 겹치므로(orange, teal 등) 먼저 'old:'를 붙여 비켜 둠
update public.couple_members set color = 'old:' || color;

delete from public.member_colors;
alter table public.member_colors drop constraint member_colors_id_check;
alter table public.member_colors
  add column light text not null,
  add column dark text not null,
  add constraint member_colors_id_check check (id ~ '^[a-z]+$'),
  add constraint member_colors_light_check check (light ~ '^#[0-9a-f]{6}$'),
  add constraint member_colors_dark_check check (dark ~ '^#[0-9a-f]{6}$');

-- 화면 index.html의 MEMBER_COLORS와 id·순서·값이 같아야 한다(dev/sqltest가 확인). 순서 = 색 고르기 화면 순서(무지개)
insert into public.member_colors (id, position, light, dark) values
  ('red', 1, '#f53c41', '#ff726b'),
  ('coral', 2, '#f66336', '#ff8d6c'),
  ('orange', 3, '#f87805', '#fe9b5d'),
  ('tangerine', 4, '#fa960b', '#feac59'),
  ('amber', 5, '#f7ae05', '#febe4d'),
  ('yellow', 6, '#f7cd03', '#ffd83d'),
  ('chartreuse', 7, '#cbd20d', '#dce307'),
  ('lime', 8, '#84c903', '#99e51c'),
  ('green', 9, '#04bb3d', '#45dc5f'),
  ('emerald', 10, '#0cb477', '#23d891'),
  ('mint', 11, '#0cd2a9', '#3ceabf'),
  ('teal', 12, '#02afa6', '#25d2c7'),
  ('cyan', 13, '#09c0d3', '#07ddf2'),
  ('sky', 14, '#04aee0', '#41cbff'),
  ('azure', 15, '#049aed', '#5fb9fe'),
  ('blue', 16, '#0182f3', '#5ea7ff'),
  ('cobalt', 17, '#3461ef', '#6892fe'),
  ('indigo', 18, '#5e4dee', '#8384ff'),
  ('violet', 19, '#885af5', '#a890fe'),
  ('purple', 20, '#ac55f4', '#c68bff'),
  ('orchid', 21, '#cf63e7', '#ea8dff'),
  ('magenta', 22, '#db3cc6', '#ff6ae8'),
  ('pink', 23, '#ef64b3', '#ff91cb'),
  ('rose', 24, '#ec4179', '#ff799b');

-- ---------- 색 계산 (내부 전용) ----------
-- '#rrggbb' → OKLab [L, a, b] (Björn Ottosson의 sRGB → OKLab 식. 화면도 같은 식을 씀)
create or replace function public.member_color_lab(p_hex text)
returns double precision[]
language sql
immutable
strict
set search_path = ''
as $$
  with rgb as (
    select array(
      select case when c <= 0.04045 then c / 12.92 else power((c + 0.055) / 1.055, 2.4) end
      from (select i, get_byte(decode(substr(p_hex, 2, 6), 'hex'), i) / 255.0::double precision as c
            from generate_series(0, 2) as i) x
      order by i) as v
  ), lms as (
    select cbrt(0.4122214708 * v[1] + 0.5363325363 * v[2] + 0.0514459929 * v[3]) as l,
           cbrt(0.2119034982 * v[1] + 0.6806995451 * v[2] + 0.1073969566 * v[3]) as m,
           cbrt(0.0883024619 * v[1] + 0.2817188376 * v[2] + 0.6299787005 * v[3]) as s
    from rgb
  )
  select array[0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
               1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
               0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s]
  from lms
$$;

-- 두 '#rrggbb' 사이 OKLab 거리(ΔE_OK). 0이면 같은 색, 0.02 안팎이 겨우 구별되는 정도
create or replace function public.member_color_delta(p_a text, p_b text)
returns double precision
language sql
immutable
strict
set search_path = ''
as $$
  select sqrt(power(a[1] - b[1], 2) + power(a[2] - b[2], 2) + power(a[3] - b[3], 2))
  from (select public.member_color_lab(p_a) as a, public.member_color_lab(p_b) as b) x
$$;

-- 두 '#rrggbb'의 색상각(OKLCH hue) 차이, 0~180도. 색을 옮길 때(가장 가까운 색) 씀
create or replace function public.member_color_hue_gap(p_a text, p_b text)
returns double precision
language sql
immutable
strict
set search_path = ''
as $$
  select least(d, 360 - d)
  from (select abs(degrees(atan2(a[3], a[2])) - degrees(atan2(b[3], b[2]))) as d
        from (select public.member_color_lab(p_a) as a, public.member_color_lab(p_b) as b) x) y
$$;

-- 멤버 색 값(팔레트 id 또는 '#rrggbb') → 화면에 칠하는 색 [밝은 화면, 어두운 화면].
-- 직접 고른 색은 두 화면 모두 그 색. 모르는 값이면 null
create or replace function public.member_color_fills(p_color text)
returns text[]
language sql
stable
strict
set search_path = ''
as $$
  select case
           when p_color ~ '^#[0-9a-f]{6}$' then array[p_color, p_color]
           else (select array[c.light, c.dark] from public.member_colors c where c.id = p_color)
         end
$$;

-- 두 멤버 색이 얼마나 비슷한지: 밝은 화면끼리, 어두운 화면끼리 잰 OKLab 거리 중 작은 쪽
-- (어느 한 화면에서라도 거의 같아 보이면 비슷한 색). 모르는 값이 있으면 null
create or replace function public.member_color_distance(p_a text, p_b text)
returns double precision
language sql
stable
strict
set search_path = ''
as $$
  select least(public.member_color_delta(a[1], b[1]), public.member_color_delta(a[2], b[2]))
  from (select public.member_color_fills(p_a) as a, public.member_color_fills(p_b) as b) x
  where a is not null and b is not null
$$;

-- 기존 멤버 색 옮기기: 방마다 방장 → 들어온 순서로, 예전 색(밝은 화면 값)과 색상각이 가장 가까운 새 색.
-- 그 방에서 이미 누가 받은 색은 건너뜀(같으면 OKLab 거리, 그다음 목록 순서)
do $$
declare
  r record;
  v_new text;
begin
  for r in
    select m.couple_id, m.user_id, o.light
    from public.couple_members m
    join _gp_old_colors o on 'old:' || o.id = m.color
    order by m.couple_id, (m.role = 'owner') desc, m.created_at, m.user_id
  loop
    select c.id into v_new
    from public.member_colors c
    where not exists (select 1 from public.couple_members x where x.couple_id = r.couple_id and x.color = c.id)
    order by public.member_color_hue_gap(r.light, c.light), public.member_color_delta(r.light, c.light), c.position
    limit 1;
    update public.couple_members set color = v_new where couple_id = r.couple_id and user_id = r.user_id;
  end loop;
end $$;

-- 색 값: 팔레트 id(소문자) 또는 직접 고른 '#rrggbb'(소문자). 방 안에서 같은 값은 couple_members_couple_color_key가 막음
alter table public.couple_members
  add constraint couple_members_color_check check (color ~ '^(#[0-9a-f]{6}|[a-z]+)$');
-- 팔레트 id일 때만 값이 있는 자동 계산 칸: 없는 팔레트 id를 외래 키로 막음(직접 고른 색은 null이라 검사 안 함)
alter table public.couple_members
  add column palette_color text generated always as (case when color like '#%' then null else color end) stored;
alter table public.couple_members
  add constraint couple_members_palette_color_fkey foreign key (palette_color) references public.member_colors (id);

-- ---------- 함수 ----------
-- 그 방에서 아무도 안 쓰고, 다른 멤버 색과 거의 같지 않은(거리 0.03 이상) 팔레트 색 하나를 무작위로 (내부 전용)
create or replace function public.pick_member_color(p_couple uuid)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_color text;
begin
  select c.id into v_color
  from public.member_colors c
  where not exists (
    select 1 from public.couple_members m
    where m.couple_id = p_couple
      -- 팔레트끼리는 늘 0.04 이상 떨어져 있어서(dev/sqltest c1이 확인) 거리는 직접 고른 색하고만 잼
      and (m.color = c.id or (m.color like '#%' and public.member_color_distance(m.color, c.id) < 0.03))
  )
  order by random()
  limit 1;
  if v_color is null then
    raise exception 'no_free_color'; -- 5명·24색이라 실제로는 안 남
  end if;
  return v_color;
end;
$$;

-- 내 색 바꾸기: 팔레트 id 또는 '#rrggbb'(대소문자·앞뒤 공백 상관없음, 소문자로 저장). 저장된 값을 돌려줌.
-- 다른 멤버와 같은 값이면 color_taken, 같지는 않아도 거의 같으면(어느 한 화면에서 OKLab 거리 0.03 미만) color_too_close.
-- (앱에는 color 칸 update 권한이 없어서 이 함수로만 바꿈)
create or replace function public.set_member_color(p_couple uuid, p_color text)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_color text := lower(btrim(p_color));
  v_now text;
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;
  -- 멤버가 아니면 잠그기 전에 거절 (남의 방 couples 행을 잠그지 못하게). 잠근 뒤 한 번 더 확인 (그사이 나가기)
  if not exists (select 1 from public.couple_members where couple_id = p_couple and user_id = v_uid) then
    raise exception 'not_member';
  end if;
  perform 1 from public.couples where id = p_couple for update;
  if not found then
    raise exception 'not_member';
  end if;
  select color into v_now from public.couple_members where couple_id = p_couple and user_id = v_uid;
  if v_now is null then
    raise exception 'not_member';
  end if;
  if v_color is null
     or (v_color !~ '^#[0-9a-f]{6}$' and not exists (select 1 from public.member_colors where id = v_color)) then
    raise exception 'invalid_color';
  end if;
  if v_now = v_color then
    return v_now;
  end if;
  if exists (select 1 from public.couple_members where couple_id = p_couple and user_id <> v_uid and color = v_color) then
    raise exception 'color_taken';
  end if;
  if exists (select 1 from public.couple_members
             where couple_id = p_couple and user_id <> v_uid
               and public.member_color_distance(color, v_color) < 0.03) then
    raise exception 'color_too_close';
  end if;
  begin
    update public.couple_members set color = v_color where couple_id = p_couple and user_id = v_uid;
  exception when unique_violation then
    raise exception 'color_taken';
  end;
  return v_color;
end;
$$;

-- ---------- 권한 ----------
-- set_member_color·pick_member_color는 create or replace라 권한이 그대로지만 한 번 더 적음. 색 계산 함수는 내부 전용
revoke all on function public.set_member_color(uuid, text) from public, anon;
grant execute on function public.set_member_color(uuid, text) to authenticated;
revoke all on function public.pick_member_color(uuid) from public, anon, authenticated;
revoke all on function public.member_color_lab(text) from public, anon, authenticated;
revoke all on function public.member_color_delta(text, text) from public, anon, authenticated;
revoke all on function public.member_color_hue_gap(text, text) from public, anon, authenticated;
revoke all on function public.member_color_fills(text) from public, anon, authenticated;
revoke all on function public.member_color_distance(text, text) from public, anon, authenticated;
revoke all on public.member_colors from public, anon, authenticated;

commit;
