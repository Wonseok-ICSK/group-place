-- 그룹 기능 (MVP 1단계): 한 방에 5명까지, 한 사람이 방 3개까지, 멤버마다 색, 방 이름 바꾸기, 나가기.
-- 실행 순서: schema.sql → friends-keepalive.sql → friends-signup.sql → 이 파일. SQL Editor에서 한 번만 실행하세요.
-- 중간에 실패하면 전부 취소됩니다. 이미 적용했으면 맨 앞 확인에서 멈춥니다.
-- 설계와 API 계약: docs/groups-design.md (함수 이름·인자·오류 코드는 그 문서 §9가 기준)
-- 되돌리기: groups_rollback.sql (서버를 이전 릴리스로 먼저 되돌린 뒤 실행)
--
-- 바뀌는 것:
--   - 한 사람 한 방 제약(couple_members_one_couple_per_user)을 없애고 방 3개 제한으로 바꿈
--   - 방마다 5명까지 (예전 2명). 다 차도 초대 코드를 지우지 않음. 2명이 차서 지워졌던 코드는 새로 만듦
--   - 멤버 색(couple_members.color, 색 목록은 member_colors). 방 안에서 겹치지 않음. 기존 멤버는 방장 teal, 다른 사람 amber
--   - 방장은 방마다 한 명. 방장이 나가면 가장 먼저 들어온 남은 멤버가 방장이 됨
--   - 새 함수: rename_room, set_member_color, begin_room_delete, leave_room, groups_schema_version
--   - create_couple, join_couple, join_couple_for, space_code_open은 이름·인자를 그대로 두고 본문만 바꿈
--   - 화면에 쓰는 말은 방/멤버/방장/닉네임이지만 표 이름(couples 등)은 그대로 둠
--   - 후기 고치기 정책: 지금 그 방 멤버일 때만 (나간 뒤 남은 후기를 고치지 못하게)
--   - 예전 사진 칸(places.photo_path)은 앱에서 못 고침 (v1.5부터 안 씀. 다른 방 사진 경로를 넣어 지우게 하는 것을 막음)
--
-- 잠금 순서(교착 방지): ① 사람 잠금(pg_advisory_xact_lock) → ② 방 잠금(couples 행 for update). 반대 순서로 잡는 곳은 없음.

begin;

do $$
declare
  v_n integer;
begin
  if to_regclass('public.signup_invites') is null then
    raise exception '먼저 supabase/friends-signup.sql을 실행하세요.';
  end if;
  if to_regclass('public.member_colors') is not null then
    raise exception '이미 적용된 SQL이에요 (member_colors 표가 있음).';
  end if;
  if to_regprocedure('public.join_couple_for(uuid, text, text)') is null
     or to_regprocedure('public.create_couple(text, text)') is null then
    raise exception 'create_couple·join_couple_for 함수가 없어요. schema.sql과 friends-signup.sql을 먼저 실행하세요.';
  end if;
  if to_regprocedure('extensions.gen_random_bytes(integer)') is null then
    raise exception 'extensions.gen_random_bytes가 없어요. 먼저 실행: create extension if not exists pgcrypto with schema extensions;';
  end if;
  -- 예전 규칙에서는 2명까지라 3명 이상은 없어야 한다. 다만 groups_rollback.sql로 되돌렸다가 다시 적용하는 경우
  -- 3~5명 방이 남아 있을 수 있어서 새 규칙의 한도(5명)를 넘는 방만 막는다.
  select count(*) into v_n
  from (select couple_id from public.couple_members group by couple_id having count(*) > 5) x;
  if v_n > 0 then
    raise exception '예상하지 못한 데이터: 멤버가 6명 이상인 방이 %개 있어요.', v_n;
  end if;
  select count(*) into v_n
  from (select couple_id from public.couple_members where role = 'owner' group by couple_id having count(*) > 1) x;
  if v_n > 0 then
    raise exception '예상하지 못한 데이터: 방장(owner)이 두 명 이상인 방이 %개 있어요.', v_n;
  end if;
  select count(*) into v_n
  from (select user_id from public.couple_members group by user_id having count(*) > 3) x;
  if v_n > 0 then
    raise exception '예상하지 못한 데이터: 방 4개 이상에 든 사람이 %명 있어요.', v_n;
  end if;
end $$;

-- ---------- 멤버 색 목록 ----------
-- 화면 index.html의 MEMBER_COLORS와 id·순서가 같아야 한다(dev/sqltest가 확인). 실제 색 값은 화면에만 있다.
create table public.member_colors (
  id text not null,
  position smallint not null,
  constraint member_colors_pkey primary key (id),
  constraint member_colors_position_key unique (position),
  constraint member_colors_id_check check (id ~ '^[a-z]+(-deep)?$')
);
-- 정책 없이 RLS만 켬 + 권한 회수: 앱은 index.html의 목록을 쓰고, 이 표는 색 id 확인(외래 키)용
alter table public.member_colors enable row level security;
revoke all on public.member_colors from public, anon, authenticated;

insert into public.member_colors (id, position) values
  ('orange', 1), ('tangerine', 2), ('amber', 3), ('mustard', 4), ('olive', 5),
  ('lime', 6), ('green', 7), ('emerald', 8), ('jade', 9), ('teal', 10),
  ('cyan', 11), ('sky', 12), ('azure', 13), ('blue', 14), ('cobalt', 15),
  ('indigo', 16), ('violet', 17), ('purple', 18), ('orchid', 19), ('pink', 20),
  ('orange-deep', 21), ('tangerine-deep', 22), ('amber-deep', 23), ('mustard-deep', 24), ('olive-deep', 25),
  ('lime-deep', 26), ('green-deep', 27), ('emerald-deep', 28), ('jade-deep', 29), ('teal-deep', 30),
  ('cyan-deep', 31), ('sky-deep', 32), ('azure-deep', 33), ('blue-deep', 34), ('cobalt-deep', 35),
  ('indigo-deep', 36), ('violet-deep', 37), ('purple-deep', 38), ('orchid-deep', 39), ('pink-deep', 40);

-- ---------- couple_members ----------
alter table public.couple_members drop constraint couple_members_one_couple_per_user;
create index couple_members_user_idx on public.couple_members (user_id); -- 사람마다 방 수 세기용

alter table public.couple_members add column color text references public.member_colors (id);
-- 채우기: 방마다 방장(없으면 먼저 들어온 사람) → teal, 다음 사람 → amber (예전 두 사람 색과 같게).
-- 되돌렸다가 다시 적용해서 3~5명인 방이 있으면 셋째부터는 목록 순서대로 남은 색.
update public.couple_members m
set color = case r.rn
              when 1 then 'teal'
              when 2 then 'amber'
              else (select c.id
                    from (select id, row_number() over (order by position) as n
                          from public.member_colors where id not in ('teal', 'amber')) c
                    where c.n = r.rn - 2)
            end
from (select couple_id, user_id,
             row_number() over (partition by couple_id order by (role = 'owner') desc, created_at, user_id) as rn
      from public.couple_members) r
where m.couple_id = r.couple_id and m.user_id = r.user_id;
alter table public.couple_members alter column color set not null;
alter table public.couple_members add constraint couple_members_couple_color_key unique (couple_id, color);
create unique index couple_members_one_owner on public.couple_members (couple_id) where role = 'owner';
-- 닉네임: 앞뒤 공백 없이 1~20자. 기존 행은 검사하지 않고(not valid) 새로 쓰는 값만 검사
alter table public.couple_members add constraint couple_members_display_name_check
  check (display_name = btrim(display_name) and char_length(display_name) between 1 and 20) not valid;

-- ---------- couples ----------
-- 마지막 멤버가 방을 지우는 중(사진 파일을 지우는 동안 15분 동안 새 참여를 막음)
alter table public.couples add column deleting_at timestamptz;
-- 방 이름: 앞뒤 공백 없이 1~30자. 기존 행은 검사하지 않음
alter table public.couples add constraint couples_name_check
  check (name = btrim(name) and char_length(name) between 1 and 30) not valid;

-- 2명이 차서 지워졌던 초대 코드를 다시 만듦: 이제 코드는 방이 있는 동안 계속 씀(코드 다시 만들기 없음)
do $$
declare
  r record;
begin
  for r in select id from public.couples where invite_code is null loop
    loop
      begin
        update public.couples
        set invite_code = upper(encode(extensions.gen_random_bytes(4), 'hex'))
        where id = r.id;
        exit;
      exception when unique_violation then
        null; -- 아주 드물게 겹치면 다시 뽑음
      end;
    end loop;
  end loop;
end $$;

-- ---------- 함수 ----------
-- 오류는 raise exception '<코드>' (PostgREST가 HTTP 400, code P0001, message = 코드로 돌려줌). 화면은 friendly()로 바꿔 보여 줌.

-- 그 방에서 아무도 안 쓰는 색 하나를 무작위로 (내부 전용)
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
  where not exists (select 1 from public.couple_members m where m.couple_id = p_couple and m.color = c.id)
  order by random()
  limit 1;
  if v_color is null then
    raise exception 'no_free_color'; -- 5명·40색이라 실제로는 안 남
  end if;
  return v_color;
end;
$$;

-- 멤버를 넣을 때마다 (함수 밖에서 직접 넣어도) 방 5명·사람 3방 제한을 지키고, 색이 없으면 빈 색을 채움
create or replace function public.enforce_member_caps()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('group-place:member:' || new.user_id::text, 0));
  perform 1 from public.couples where id = new.couple_id for update;
  if (select count(*) from public.couple_members where couple_id = new.couple_id) >= 5 then
    raise exception 'room_full';
  end if;
  if (select count(*) from public.couple_members where user_id = new.user_id) >= 3 then
    raise exception 'too_many_rooms';
  end if;
  if new.color is null then
    new.color := public.pick_member_color(new.couple_id);
  end if;
  return new;
end;
$$;

create trigger couple_members_enforce_caps
  before insert on public.couple_members
  for each row execute function public.enforce_member_caps();

-- 방 만들기: 만든 사람이 방장. 이름·인자는 schema.sql과 같고(기본값 default null은 create or replace로 못 지움),
-- 방 이름이 비어 있으면 invalid_room_name
create or replace function public.create_couple(p_display_name text, p_couple_name text default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_name text := btrim(p_couple_name);
  v_display text := btrim(p_display_name);
  v_couple uuid;
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;

  -- 사람 잠금: 같은 사람이 동시에 방을 만들거나 들어가도 3개를 넘지 않게
  perform pg_advisory_xact_lock(hashtextextended('group-place:member:' || v_uid::text, 0));

  if (select count(*) from public.couple_members where user_id = v_uid) >= 3 then
    raise exception 'too_many_rooms';
  end if;
  if v_name is null or char_length(v_name) not between 1 and 30 then
    raise exception 'invalid_room_name';
  end if;
  if v_display is null or char_length(v_display) not between 1 and 20 then
    raise exception 'invalid_display_name';
  end if;

  -- 초대 코드: 8자리 대문자 16진수. 아주 드물게 겹치면 다시 뽑음
  loop
    begin
      insert into public.couples (name, created_by, invite_code)
      values (v_name, v_uid, upper(encode(extensions.gen_random_bytes(4), 'hex')))
      returning id into v_couple;
      exit;
    exception when unique_violation then
      null;
    end;
  end loop;

  -- 색은 트리거가 무작위로 채움
  insert into public.couple_members (couple_id, user_id, role, display_name)
  values (v_couple, v_uid, 'owner', v_display);

  insert into public.categories (couple_id, name, position)
  select v_couple, d.name, d.ord
  from unnest(array['맛집', '카페', '술집', '디저트', '놀거리', '여행', '성당', '기타']) with ordinality as d (name, ord);

  return v_couple;
end;
$$;

-- 방 코드로 참여 (홈 서버가 횟수를 센 뒤 secret key로 부름).
-- 코드를 먼저 확인하므로 too_many_rooms·room_full도 "코드가 맞았다"는 뜻(서버는 이것도 시도로 셈).
-- 이미 그 방 멤버면 아무것도 안 바꾸고 그 방 id를 돌려줌(같은 요청을 다시 보내도 안전). 초대 코드는 지우지 않음.
create or replace function public.join_couple_for(p_user uuid, p_invite_code text, p_display_name text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := p_user;
  v_display text := btrim(p_display_name);
  v_couple uuid;
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;
  if v_display is null or char_length(v_display) not between 1 and 20 then
    raise exception 'invalid_display_name';
  end if;

  -- ① 사람 잠금 → ② 방 잠금 (지우는 중인 방은 15분 동안 코드가 없는 것처럼)
  perform pg_advisory_xact_lock(hashtextextended('group-place:member:' || v_uid::text, 0));

  select id into v_couple
  from public.couples
  where invite_code = upper(btrim(p_invite_code))
    and (deleting_at is null or deleting_at <= now() - interval '15 minutes')
  for update;

  if v_couple is null then
    raise exception 'invalid_code';
  end if;

  if exists (select 1 from public.couple_members where couple_id = v_couple and user_id = v_uid) then
    return v_couple;
  end if;

  if (select count(*) from public.couple_members where user_id = v_uid) >= 3 then
    raise exception 'too_many_rooms';
  end if;

  if (select count(*) from public.couple_members where couple_id = v_couple) >= 5 then
    raise exception 'room_full';
  end if;

  -- 색은 트리거가 그 방의 빈 색으로 무작위
  insert into public.couple_members (couple_id, user_id, role, display_name)
  values (v_couple, v_uid, 'member', v_display);

  return v_couple;
end;
$$;

-- 앱에서 직접 참여: 친구용에서는 실행 권한을 거둔 상태로 둠(friends-signup.sql). 규칙은 join_couple_for 하나로
create or replace function public.join_couple(p_invite_code text, p_display_name text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
begin
  return public.join_couple_for((select auth.uid()), p_invite_code, p_display_name);
end;
$$;

-- 방 초대 코드(8자리)로 가입할 수 있는지 미리 확인: 코드가 있고, 멤버가 5명 미만이고, 지우는 중이 아니면 true
create or replace function public.space_code_open(p_code text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.couples c
    where c.invite_code = upper(btrim(p_code))
      and (c.deleting_at is null or c.deleting_at <= now() - interval '15 minutes')
      and (select count(*) from public.couple_members m where m.couple_id = c.id) < 5
  );
$$;

-- 방 이름 바꾸기 (방장만). 저장된 이름을 돌려줌
create or replace function public.rename_room(p_couple uuid, p_name text)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_name text := btrim(p_name);
  v_role text;
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;
  perform 1 from public.couples where id = p_couple for update;
  if not found then
    raise exception 'not_member';
  end if;
  select role into v_role from public.couple_members where couple_id = p_couple and user_id = v_uid;
  if v_role is null then
    raise exception 'not_member';
  end if;
  if v_role <> 'owner' then
    raise exception 'not_owner';
  end if;
  if v_name is null or char_length(v_name) not between 1 and 30 then
    raise exception 'invalid_room_name';
  end if;
  update public.couples set name = v_name where id = p_couple;
  return v_name;
end;
$$;

-- 내 색 바꾸기: 그 방에서 아무도 안 쓰는 색만. 저장된 색 id를 돌려줌
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
  v_now text;
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;
  perform 1 from public.couples where id = p_couple for update;
  if not found then
    raise exception 'not_member';
  end if;
  select color into v_now from public.couple_members where couple_id = p_couple and user_id = v_uid;
  if v_now is null then
    raise exception 'not_member';
  end if;
  if p_color is null or not exists (select 1 from public.member_colors where id = p_color) then
    raise exception 'invalid_color';
  end if;
  if v_now = p_color then
    return v_now;
  end if;
  if exists (select 1 from public.couple_members where couple_id = p_couple and color = p_color) then
    raise exception 'color_taken';
  end if;
  begin
    update public.couple_members set color = p_color where couple_id = p_couple and user_id = v_uid;
  exception when unique_violation then
    raise exception 'color_taken';
  end;
  return p_color;
end;
$$;

-- 마지막 멤버가 방을 지우기 전: 사진 파일 경로를 모두 돌려주고 15분 동안 새 참여를 막음.
-- (사진 파일은 SQL로 못 지워서 화면이 Storage API로 먼저 지운 뒤 leave_room을 부름)
create or replace function public.begin_room_delete(p_couple uuid)
returns text[]
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_paths text[];
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;
  perform 1 from public.couples where id = p_couple for update;
  if not found then
    raise exception 'not_member';
  end if;
  if not exists (select 1 from public.couple_members where couple_id = p_couple and user_id = v_uid) then
    raise exception 'not_member';
  end if;
  if exists (select 1 from public.couple_members where couple_id = p_couple and user_id <> v_uid) then
    raise exception 'not_last_member';
  end if;

  update public.couples set deleting_at = now() where id = p_couple;

  -- 사진 표(place_photos)의 경로 + 예전 사진 칸(places.photo_path).
  -- place_photos.path는 제약으로 '<장소 id>/…'만 들어가지만 photo_path는 아무 글이나 들어갈 수 있었으므로
  -- 그 장소 폴더 안의 경로만 돌려줌(다른 방 사진 경로를 넣어 두고 마지막 멤버가 지우게 하는 것을 막음)
  select coalesce(array_agg(x.path order by x.path), '{}') into v_paths
  from (
    select ph.path
    from public.place_photos ph
    join public.places p on p.id = ph.place_id
    where p.couple_id = p_couple
    union
    select p.photo_path
    from public.places p
    where p.couple_id = p_couple and p.photo_path is not null
      and split_part(p.photo_path, '/', 1) = p.id::text
  ) x;
  return v_paths;
end;
$$;

-- 방에서 나가기.
-- 다른 멤버가 남으면: 이 방에서 내가 쓴 후기·월드컵 기록과 내가 만든 빈 방문을 지우고 나감(색이 비워짐).
--   내가 담은 장소·올린 사진, 다른 사람 후기가 달린 방문은 남음. 내가 방장이면 가장 먼저 들어온 남은 멤버가 방장.
-- 혼자 남았으면: 방과 그 안의 데이터를 모두 지움(사진 파일은 화면이 begin_room_delete 뒤에 먼저 지움).
create or replace function public.leave_room(p_couple uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_role text;
  v_new_owner uuid;
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;
  perform 1 from public.couples where id = p_couple for update;
  if not found then
    raise exception 'not_member';
  end if;
  select role into v_role from public.couple_members where couple_id = p_couple and user_id = v_uid;
  if v_role is null then
    raise exception 'not_member';
  end if;

  if not exists (select 1 from public.couple_members where couple_id = p_couple and user_id <> v_uid) then
    -- 방을 지우는 것은 begin_room_delete(사진 경로 받기 + 15분 참여 막기)를 15분 안에 부른 뒤에만.
    -- 둘이 거의 동시에 나가서 혼자 남게 된 경우 등: 화면이 사진을 지우고 한 번 더 확인받도록 'last_member'로 돌려보냄
    if not exists (select 1 from public.couples where id = p_couple and deleting_at > now() - interval '15 minutes') then
      raise exception 'last_member';
    end if;
    -- categories, places(→ visits, reviews, place_photos), cup_results, couple_members가 같이 지워짐
    delete from public.couples where id = p_couple;
    return jsonb_build_object('room_deleted', true, 'new_owner', null);
  end if;

  -- 멤버 줄을 먼저 지움: 이 뒤로 시작하는 내 후기 쓰기는 RLS(멤버만)에서 막힘
  delete from public.couple_members where couple_id = p_couple and user_id = v_uid;

  -- 다른 방의 내 후기는 그대로 (이 방 장소만)
  delete from public.reviews r
  using public.places p
  where p.id = r.place_id and p.couple_id = p_couple and r.author_id = v_uid;

  -- 내가 만든 방문 중 후기가 하나도 안 남은 것만
  delete from public.visits v
  using public.places p
  where p.id = v.place_id and p.couple_id = p_couple and v.created_by = v_uid
    and not exists (select 1 from public.reviews r where r.visit_id = v.id);

  delete from public.cup_results where couple_id = p_couple and user_id = v_uid;

  if v_role = 'owner' then
    select m.user_id into v_new_owner
    from public.couple_members m
    where m.couple_id = p_couple
    order by m.created_at, m.user_id
    limit 1;
    update public.couple_members set role = 'owner' where couple_id = p_couple and user_id = v_new_owner;
  end if;

  return jsonb_build_object('room_deleted', false, 'new_owner', v_new_owner);
end;
$$;

-- ---------- 정책·열 권한 ----------
-- 후기 고치기: 예전 정책은 '내가 쓴 후기'만 봐서, 나가기와 동시에 쓴 후기가 남으면 나간 뒤에도 고칠 수 있었음.
-- 지금 그 장소의 방 멤버일 때만 고칠 수 있게 함(되돌리기에서 예전 정책으로 돌림)
drop policy "Authors can update own reviews" on public.reviews;
create policy "Authors can update own reviews" on public.reviews for update to authenticated
  using (author_id = (select auth.uid())
         and exists (select 1 from public.places p where p.id = reviews.place_id and public.is_couple_member(p.couple_id)))
  with check (author_id = (select auth.uid())
              and exists (select 1 from public.places p where p.id = reviews.place_id and public.is_couple_member(p.couple_id)));

-- 예전 사진 칸은 앱이 쓰지 않으므로 고치기 권한을 거둠(되돌리기에서 다시 줌)
revoke update (photo_path) on public.places from authenticated;

-- 이 SQL이 적용됐는지 확인용 (홈 서버 시작 확인·화면 오류 안내). 표를 읽지 않음
create or replace function public.groups_schema_version()
returns integer
language sql
stable
security invoker
set search_path = ''
as $$ select 1 $$;

-- ---------- 권한 ----------
-- 함수는 기본으로 모두(public)에게 열리고 Supabase 기본 권한이 anon·authenticated에도 열어 두므로 하나씩 정함.
-- couple_members.color에는 update 권한을 주지 않음(색 바꾸기는 set_member_color만). display_name 권한·정책은 그대로.
revoke all on function public.create_couple(text, text) from public, anon;
grant execute on function public.create_couple(text, text) to authenticated;
revoke all on function public.join_couple(text, text) from public, anon, authenticated;
revoke all on function public.join_couple_for(uuid, text, text) from public, anon, authenticated;
grant execute on function public.join_couple_for(uuid, text, text) to service_role;
revoke all on function public.space_code_open(text) from public, anon, authenticated;
grant execute on function public.space_code_open(text) to service_role;
revoke all on function public.rename_room(uuid, text) from public, anon;
grant execute on function public.rename_room(uuid, text) to authenticated;
revoke all on function public.set_member_color(uuid, text) from public, anon;
grant execute on function public.set_member_color(uuid, text) to authenticated;
revoke all on function public.begin_room_delete(uuid) from public, anon;
grant execute on function public.begin_room_delete(uuid) to authenticated;
revoke all on function public.leave_room(uuid) from public, anon;
grant execute on function public.leave_room(uuid) to authenticated;
revoke all on function public.groups_schema_version() from public, anon;
grant execute on function public.groups_schema_version() to authenticated, service_role;
revoke all on function public.pick_member_color(uuid) from public, anon, authenticated;
revoke all on function public.enforce_member_caps() from public, anon, authenticated;

commit;
