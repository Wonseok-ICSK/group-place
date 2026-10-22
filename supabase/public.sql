-- 공개 방 (v0.2.0): 로그인한 앱 사용자 누구나 둘러볼 수 있는 방, 공개 범위는 만들 때 정하고 바꿀 수 없음.
-- 실행 순서: schema.sql → friends-keepalive.sql → friends-signup.sql → groups.sql → colors.sql → 이 파일. SQL Editor에서 한 번만 실행하세요.
-- 중간에 실패하면 전부 취소됩니다. 이미 적용했으면 맨 앞 확인에서 멈춥니다.
-- 설계와 API 계약: docs/public-rooms-design.md §2 (함수 이름·인자·반환 JSON 키·오류 코드는 그 문서 §2.5·§2.6·§9가 기준)
-- 되돌리기: public_rollback.sql (홈 서버를 이전 릴리스로 먼저 되돌린 뒤 실행)
--
-- 바뀌는 것:
--   - couples에 칸 4개: visibility('private'|'public', 기본 private), description(공개 방 소개 60자, 개인 방은 ''),
--     public_key(보기 링크용 10자, 공개 방만, 초대 코드와 글자 모음·길이가 다름), public_hidden_at(관리자 숨기기).
--     기존 방은 모두 개인 방. visibility·public_key는 트리거가 바꾸지 못하게 막음(service_role·SQL Editor도)
--   - place_photos.thumb_path(320px 썸네일 '<장소 id>/t/<파일>', null 가능)
--   - public_room_acks: 공개 방 동의 기록(만들기 'create'·참여 'join'). 방 FK가 없어 나가도, 방이 지워져도 남음. service_role만
--   - 공개 방에서는 닉네임이 로그인 아이디와 같으면 막음(nickname_is_login_id). 개인 방은 그대로
--   - 사진 저장소 정책 세 개(select·insert·delete)에 is_couple_member를 직접 넣음(결과는 지금과 같음)
--   - 새 함수(앱): create_room, public_create_status, set_room_description, regenerate_invite_code, public_ack_version
--   - 새 함수(서버만): join_room_for, space_code_info, public_room_list, public_room_view, public_rooms_version,
--     admin_set_room_hidden, admin_public_rooms
--   - 내부 함수(아무도 직접 못 부름): public_login_id, public_room_activity, public_text_ok, public_nick_key,
--     트리거 함수 couples_freeze_visibility·couples_public_text·enforce_public_nickname
--   - 공개 방의 방 이름·소개·닉네임에는 제어 문자·보이지 않는 글자·글자 방향을 바꾸는 글자를 못 씀(개인 방은 그대로)
--   - join_couple_for: 공개 방 코드면 ack_required (옛 서버가 동의 없이 넣지 못하게). 개인 방은 그대로
--   - begin_room_delete: 썸네일 경로(thumb_path)도 돌려줌
--   - create_couple, space_code_open, leave_room은 그대로 (create_couple은 늘 개인 방)
--   - 공개 응답(public_room_list·public_room_view)에는 초대 코드·방/사용자 uuid·방장 표시·찜·정확한 날짜가 없음.
--     마지막 활동은 'week'|'month'|'older'로만, 사진은 저장소 크기가 작은 것만(썸네일 150KB·큰 사진 2MB 이하)
--     JSON은 모두 jsonb_build_object로 키를 하나씩 적음(허용 목록)
--
-- 잠금 순서(교착 방지): ① 사람 잠금(pg_advisory_xact_lock 'group-place:member:<uid>') → ② 공개 방 만들기 잠금
--   ('group-place:public-create', 공개 방을 만들 때만) → ③ 방 잠금(couples 행 for update). 반대 순서로 잡는 곳은 없음.

begin;

do $$
begin
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'member_colors' and column_name = 'light') then
    raise exception '먼저 supabase/colors.sql을 실행하세요.';
  end if;
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'couples' and column_name = 'visibility') then
    raise exception '이미 적용된 SQL이에요 (couples.visibility 칸이 있음).';
  end if;
  if to_regprocedure('public.join_couple_for(uuid, text, text)') is null
     or to_regprocedure('public.begin_room_delete(uuid)') is null then
    raise exception 'join_couple_for·begin_room_delete 함수가 없어요. groups.sql을 먼저 실행하세요.';
  end if;
  if to_regprocedure('extensions.gen_random_bytes(integer)') is null then
    raise exception 'extensions.gen_random_bytes가 없어요. 먼저 실행: create extension if not exists pgcrypto with schema extensions;';
  end if;
end $$;

-- ---------- couples ----------
alter table public.couples
  add column visibility text not null default 'private',
  add column description text not null default '',
  add column public_key text,
  add column public_hidden_at timestamptz; -- 관리자 숨기기. 앱에는 couples update 권한이 원래 없음
alter table public.couples
  add constraint couples_visibility_check check (visibility in ('private', 'public')),
  add constraint couples_description_check check (description = btrim(description) and char_length(description) <= 60
                                                  and (visibility = 'public' or description = '')),
  -- 공개 키 글자 모음: abcdefghijkmnpqrstuvwxyz23456789 (32자, l·o·0·1 뺌) 10자
  add constraint couples_public_key_check check (public_key ~ '^[a-km-np-z2-9]{10}$'),
  add constraint couples_public_key_match check ((visibility = 'public') = (public_key is not null)),
  add constraint couples_public_key_key unique (public_key); -- null은 여러 개 가능

-- 공개 범위와 공개 키는 바꿀 수 없다 (service_role·SQL Editor도. 바꾸려면 이 트리거를 지워야 함)
create or replace function public.couples_freeze_visibility()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.visibility is distinct from old.visibility then
    raise exception 'visibility_immutable';
  end if;
  if new.public_key is distinct from old.public_key then
    raise exception 'public_key_immutable';
  end if;
  return new;
end;
$$;

create trigger couples_freeze_visibility
  before update on public.couples
  for each row execute function public.couples_freeze_visibility();

-- 공개 방의 방 이름·소개에는 제어 문자·보이지 않는 글자·방향 바꾸는 글자를 못 씀 (둘러보기 목록에서 다른 방처럼 꾸미지 못하게).
-- create_room·rename_room·set_room_description 모두 이 트리거를 지남. 개인 방은 검사하지 않음
create or replace function public.couples_public_text()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.visibility = 'public' then
    if not public.public_text_ok(new.name) then
      raise exception 'invalid_room_name';
    end if;
    if not public.public_text_ok(new.description) then
      raise exception 'invalid_description';
    end if;
  end if;
  return new;
end;
$$;

create trigger couples_public_text
  before insert or update of name, description on public.couples
  for each row execute function public.couples_public_text();

-- ---------- place_photos ----------
-- 썸네일(320px JPEG) 경로 '<place_id>/t/<무작위>.jpg'. 앱의 place_photos 권한은 표 단위 insert(새 칸 포함)·update(position)만이라
-- 썸네일 경로는 넣을 때만 정함
alter table public.place_photos add column thumb_path text;
alter table public.place_photos
  add constraint place_photos_thumb_path_check check (thumb_path is null or (
    split_part(thumb_path, '/', 1) = place_id::text and split_part(thumb_path, '/', 2) = 't'
    and char_length(thumb_path) <= 300)),
  add constraint place_photos_thumb_path_key unique (thumb_path);

-- ---------- 동의 기록 ----------
-- 나가도, 방이 지워져도 남김(방 FK 없음). 공개 방 만들기 간격(7일) 확인에도 씀. 정책 없이 RLS만 켜고 권한 회수 → service_role만
create table public.public_room_acks (
  id bigint generated always as identity,
  couple_id uuid not null,
  user_id uuid not null references auth.users (id) on delete cascade,
  kind text not null,
  version smallint not null,
  acked_at timestamptz not null default now(),
  constraint public_room_acks_pkey primary key (id),
  constraint public_room_acks_kind_check check (kind in ('create', 'join')),
  constraint public_room_acks_version_check check (version >= 1)
);
create index public_room_acks_user_idx on public.public_room_acks (user_id, kind, acked_at desc);
alter table public.public_room_acks enable row level security;
revoke all on public.public_room_acks from public, anon, authenticated;
revoke all on sequence public.public_room_acks_id_seq from public, anon, authenticated;

-- ---------- 함수 ----------
-- 오류는 raise exception '<코드>' (PostgREST가 HTTP 400, message = 코드). 화면은 friendly()로 바꿔 보여 줌.
-- 상수: 방장인 공개 방 1개, 만들기 간격 7일, 전체 공개 방 30개, 소개 60자, 동의 문구 버전 1, 목록 50개, 방 JSON 장소 300곳·사진 3장

-- 지금 동의 문구 버전. 화면 PUBLIC_ACK_VERSION과 같아야 함(dev/sqltest가 비교). 올리면 기존 동의는 다시 받아야 함(설계 §10.1)
create or replace function public.public_ack_version()
returns integer
language sql
immutable
set search_path = ''
as $$ select 1 $$;

-- 이 SQL이 적용됐는지 확인용 (홈 서버 시작 확인). 표를 읽지 않음
create or replace function public.public_rooms_version()
returns integer
language sql
stable
security invoker
set search_path = ''
as $$ select 1 $$;

-- 로그인 아이디(소문자): 서버가 넣은 app_metadata.username, 없으면 이메일 @ 앞부분 (내부 전용)
create or replace function public.public_login_id(p_user uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select lower(coalesce(nullif(btrim(u.raw_app_meta_data ->> 'username'), ''),
                        nullif(split_part(u.email::text, '@', 1), '')))
  from auth.users u
  where u.id = p_user
$$;

-- 공개 방 글자 확인 (내부 전용): 제어 문자, 보이지 않는 글자(U+200B·200C·2060–2064·FEFF), 글자 방향을 바꾸는 글자
-- (U+200E·200F·202A–202E·2066–2069)가 없으면 true. U+200D(이모지 잇기)는 이모지 닉네임에 쓰여서 허용.
-- 홈 서버 signup.cjs cleanDisplayName·화면 BAD_TEXT_RE와 같은 글자 모음
create or replace function public.public_text_ok(p text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p is null or p !~ '[\u0001-\u001f\u007f-\u009f\u200b\u200c\u200e\u200f\u202a-\u202e\u2060-\u2069\ufeff]'
$$;

-- 닉네임 = 로그인 아이디 비교용 (내부 전용): NFKC(전각 ｍｉｎ → min)로 바꾸고 보이지 않는 글자(U+200D 포함)를 지운 뒤 앞뒤 공백 빼고 소문자
create or replace function public.public_nick_key(p text)
returns text
language sql
immutable
set search_path = ''
as $$
  select lower(btrim(regexp_replace(normalize(coalesce(p, ''), NFKC),
                                    '[\u00ad\u034f\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]', '', 'g')))
$$;

-- 방의 마지막 활동 시각: 방 만든 때, 장소·방문 추가, 후기 쓰기·고치기, 사진 올리기 중 가장 늦은 것 (내부 전용)
create or replace function public.public_room_activity(p_couple uuid)
returns timestamptz
language sql
stable
security definer
set search_path = ''
as $$
  select greatest(
    (select c.created_at from public.couples c where c.id = p_couple),
    (select max(p.created_at) from public.places p where p.couple_id = p_couple),
    (select max(v.created_at) from public.visits v join public.places p on p.id = v.place_id where p.couple_id = p_couple),
    (select max(r.updated_at) from public.reviews r join public.places p on p.id = r.place_id where p.couple_id = p_couple),
    (select max(ph.created_at) from public.place_photos ph join public.places p on p.id = ph.place_id where p.couple_id = p_couple))
$$;

-- 공개 방에서: 보이지 않는 글자·방향 바꾸는 글자가 든 닉네임은 invalid_display_name,
-- 닉네임이 로그인 아이디와 같으면(대소문자·전각·보이지 않는 글자 무시, public_nick_key) nickname_is_login_id. 개인 방은 검사하지 않음
create or replace function public.enforce_public_nickname()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (select 1 from public.couples c where c.id = new.couple_id and c.visibility = 'public') then
    if not public.public_text_ok(new.display_name) then
      raise exception 'invalid_display_name';
    end if;
    if public.public_nick_key(new.display_name) = public.public_login_id(new.user_id) then
      raise exception 'nickname_is_login_id';
    end if;
  end if;
  return new;
end;
$$;

create trigger couple_members_public_nickname
  before insert or update of display_name on public.couple_members
  for each row execute function public.enforce_public_nickname();

-- 방 만들기 (개인·공개). create_couple과 같은 규칙 + 공개 범위·소개·동의. 인자 기본값 없음(PostgREST 겹침 방지).
-- 공개 방이면 공개 키와 방장 동의 기록('create')을 같이 저장
create or replace function public.create_room(p_display_name text, p_room_name text, p_visibility text,
                                              p_description text, p_ack_version integer)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_name text := btrim(p_room_name);
  v_display text := btrim(p_display_name);
  v_desc text := coalesce(btrim(p_description), '');
  v_public boolean;
  v_key text;
  v_bytes bytea;
  v_couple uuid;
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;

  -- ① 사람 잠금: 같은 사람이 동시에 방을 만들거나 들어가도 3개를 넘지 않게
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
  if p_visibility is null or p_visibility not in ('private', 'public') then
    raise exception 'invalid_visibility';
  end if;
  v_public := p_visibility = 'public';
  if char_length(v_desc) > 60 or (not v_public and v_desc <> '') then
    raise exception 'invalid_description';
  end if;

  if v_public then
    if not public.public_text_ok(v_name) then
      raise exception 'invalid_room_name';
    end if;
    if not public.public_text_ok(v_desc) then
      raise exception 'invalid_description';
    end if;
    if not public.public_text_ok(v_display) then
      raise exception 'invalid_display_name';
    end if;
    if public.public_nick_key(v_display) = public.public_login_id(v_uid) then
      raise exception 'nickname_is_login_id';
    end if;
    if p_ack_version is distinct from public.public_ack_version() then
      raise exception 'ack_required';
    end if;
    -- ② 공개 방 만들기 잠금: 전체 30개·간격 확인과 만들기를 한 번에 한 사람씩
    perform pg_advisory_xact_lock(hashtextextended('group-place:public-create', 0));
    -- 지금 방장인 공개 방(지우는 중인 방도 셈). 남의 공개 방 멤버인 것은 안 셈
    if exists (select 1 from public.couples c
               join public.couple_members m on m.couple_id = c.id
               where m.user_id = v_uid and m.role = 'owner' and c.visibility = 'public') then
      raise exception 'public_owner_limit';
    end if;
    -- 7일 안에 공개 방을 만든 기록(방을 지워도 기록은 남아서 지운 방도 셈)
    if exists (select 1 from public.public_room_acks a
               where a.user_id = v_uid and a.kind = 'create' and a.acked_at > now() - interval '7 days') then
      raise exception 'public_create_gap';
    end if;
    -- 전체 공개 방(숨김·지우는 중 포함)
    if (select count(*) from public.couples where visibility = 'public') >= 30 then
      raise exception 'public_rooms_full';
    end if;
  end if;

  -- 초대 코드(8자리 대문자 16진수)와 공개 키. 아주 드물게 겹치면 둘 다 다시 뽑음
  for attempt in 1..10 loop
    v_key := null;
    if v_public then
      v_key := '';
      v_bytes := extensions.gen_random_bytes(10);
      for i in 0..9 loop
        -- 256은 32로 나눠떨어져서 글자마다 확률이 같음
        v_key := v_key || substr('abcdefghijkmnpqrstuvwxyz23456789', get_byte(v_bytes, i) % 32 + 1, 1);
      end loop;
    end if;
    begin
      insert into public.couples (name, created_by, invite_code, visibility, description, public_key)
      values (v_name, v_uid, upper(encode(extensions.gen_random_bytes(4), 'hex')), p_visibility, v_desc, v_key)
      returning id into v_couple;
      exit;
    exception when unique_violation then
      null;
    end;
  end loop;
  if v_couple is null then
    raise exception 'retry';
  end if;

  -- 색은 트리거가 무작위로 채움. 닉네임 트리거도 한 번 더 확인
  insert into public.couple_members (couple_id, user_id, role, display_name)
  values (v_couple, v_uid, 'owner', v_display);

  insert into public.categories (couple_id, name, position)
  select v_couple, d.name, d.ord
  from unnest(array['맛집', '카페', '술집', '디저트', '놀거리', '여행', '성당', '기타']) with ordinality as d (name, ord);

  if v_public then
    insert into public.public_room_acks (couple_id, user_id, kind, version)
    values (v_couple, v_uid, 'create', p_ack_version);
  end if;

  return v_couple;
end;
$$;

-- 지금 공개 방을 만들 수 있는지 (화면이 공개 카드를 회색으로 둘지). 실제 확인은 create_room이 다시 함.
-- reason은 too_many_rooms → public_owner_limit → public_create_gap → public_rooms_full 순서로 첫 번째.
-- next_at은 public_create_gap일 때만 (마지막 만들기 기록 + 7일, UTC 'YYYY-MM-DDTHH:MI:SS+00:00')
create or replace function public.public_create_status()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_last timestamptz;
  v_reason text;
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;
  select max(a.acked_at) into v_last
  from public.public_room_acks a
  where a.user_id = v_uid and a.kind = 'create' and a.acked_at > now() - interval '7 days';

  if (select count(*) from public.couple_members where user_id = v_uid) >= 3 then
    v_reason := 'too_many_rooms';
  elsif exists (select 1 from public.couples c
                join public.couple_members m on m.couple_id = c.id
                where m.user_id = v_uid and m.role = 'owner' and c.visibility = 'public') then
    v_reason := 'public_owner_limit';
  elsif v_last is not null then
    v_reason := 'public_create_gap';
  elsif (select count(*) from public.couples where visibility = 'public') >= 30 then
    v_reason := 'public_rooms_full';
  end if;

  return jsonb_build_object(
    'allowed', v_reason is null,
    'reason', v_reason,
    'next_at', case when v_reason = 'public_create_gap'
                    then to_char((v_last + interval '7 days') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"+00:00"') end,
    'ack_version', public.public_ack_version());
end;
$$;

-- 공개 방 소개 바꾸기 (방장만). 저장된 소개를 돌려줌. null은 빈 소개
-- 멤버가 아니면 잠그기 전에 거절 (남의 방 couples 행을 잠그지 못하게). 잠근 뒤 한 번 더 확인 (그사이 나가기)
create or replace function public.set_room_description(p_couple uuid, p_description text)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_desc text := coalesce(btrim(p_description), '');
  v_role text;
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;
  if not exists (select 1 from public.couple_members where couple_id = p_couple and user_id = v_uid) then
    raise exception 'not_member';
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
    raise exception 'description_owner_only';
  end if;
  if not exists (select 1 from public.couples where id = p_couple and visibility = 'public') then
    raise exception 'not_public';
  end if;
  if char_length(v_desc) > 60 then
    raise exception 'invalid_description';
  end if;
  update public.couples set description = v_desc where id = p_couple;
  return v_desc;
end;
$$;

-- 초대 코드 다시 만들기 (방장만, 개인·공개 모든 방). 새 8자리 대문자 16진수 코드를 돌려줌.
-- 예전 코드는 그 순간부터 invalid_code. 이미 들어온 멤버는 그대로. 지우는 중인 방도 막지 않음(어차피 15분 동안 코드를 안 받음)
create or replace function public.regenerate_invite_code(p_couple uuid)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_old text;
  v_new text;
  v_role text;
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;
  if not exists (select 1 from public.couple_members where couple_id = p_couple and user_id = v_uid) then
    raise exception 'not_member';
  end if;
  select invite_code into v_old from public.couples where id = p_couple for update;
  if not found then
    raise exception 'not_member';
  end if;
  select role into v_role from public.couple_members where couple_id = p_couple and user_id = v_uid;
  if v_role is null then
    raise exception 'not_member';
  end if;
  if v_role <> 'owner' then
    raise exception 'invite_owner_only';
  end if;
  for attempt in 1..10 loop
    v_new := upper(encode(extensions.gen_random_bytes(4), 'hex'));
    continue when v_new is not distinct from v_old;
    begin
      update public.couples set invite_code = v_new where id = p_couple;
      return v_new;
    exception when unique_violation then
      null; -- 아주 드물게 다른 방 코드와 겹치면 다시 뽑음
    end;
  end loop;
  raise exception 'retry';
end;
$$;

-- 방 코드로 참여 (새 홈 서버가 횟수를 센 뒤 secret key로 부름). 개인·공개 방 모두.
-- 확인 순서: 코드 → 이미 멤버(already_member 반환) → room_full → too_many_rooms → (공개) invalid_display_name(글자) → nickname_is_login_id →
--   (공개, 동의 버전이 지금과 다름) need_ack 반환(raise 아님, 아무것도 안 바꿈).
-- groups.sql의 join_couple_for와 달리 room_full을 too_many_rooms보다 먼저 봄(설계 §2.5)
create or replace function public.join_room_for(p_user uuid, p_invite_code text, p_display_name text, p_ack_version integer)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := p_user;
  v_display text := btrim(p_display_name);
  v_couple uuid;
  v_name text;
  v_public boolean;
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;
  if v_display is null or char_length(v_display) not between 1 and 20 then
    raise exception 'invalid_display_name';
  end if;

  -- ① 사람 잠금 → ③ 방 잠금 (지우는 중인 방은 15분 동안 코드가 없는 것처럼)
  perform pg_advisory_xact_lock(hashtextextended('group-place:member:' || v_uid::text, 0));

  select id, name, visibility = 'public' into v_couple, v_name, v_public
  from public.couples
  where invite_code = upper(btrim(p_invite_code))
    and (deleting_at is null or deleting_at <= now() - interval '15 minutes')
  for update;

  if v_couple is null then
    raise exception 'invalid_code';
  end if;

  if exists (select 1 from public.couple_members where couple_id = v_couple and user_id = v_uid) then
    return jsonb_build_object('status', 'already_member', 'couple_id', v_couple, 'public', v_public);
  end if;

  if (select count(*) from public.couple_members where couple_id = v_couple) >= 5 then
    raise exception 'room_full';
  end if;

  if (select count(*) from public.couple_members where user_id = v_uid) >= 3 then
    raise exception 'too_many_rooms';
  end if;

  if v_public then
    if not public.public_text_ok(v_display) then
      raise exception 'invalid_display_name';
    end if;
    if public.public_nick_key(v_display) = public.public_login_id(v_uid) then
      raise exception 'nickname_is_login_id';
    end if;
    if p_ack_version is distinct from public.public_ack_version() then
      return jsonb_build_object('status', 'need_ack', 'couple_id', null, 'public', true,
                                'room_name', v_name, 'ack_version', public.public_ack_version());
    end if;
  end if;

  -- 색은 트리거가 그 방의 빈 색으로 무작위
  insert into public.couple_members (couple_id, user_id, role, display_name)
  values (v_couple, v_uid, 'member', v_display);

  if v_public then
    insert into public.public_room_acks (couple_id, user_id, kind, version)
    values (v_couple, v_uid, 'join', p_ack_version);
  end if;

  return jsonb_build_object('status', 'joined', 'couple_id', v_couple, 'public', v_public);
end;
$$;

-- 가입 전 미리 확인 (계정을 만들기 전, 서버만). open = space_code_open과 같은 뜻(코드 있음, 5명 미만, 지우는 중 아님).
-- 열려 있는 공개 방일 때만 방 이름을 돌려줌 (닫힌 코드는 공개 방인지도 알려 주지 않음)
create or replace function public.space_code_info(p_code text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'open', x.id is not null,
    'public', coalesce(x.visibility = 'public', false),
    'room_name', case when x.visibility = 'public' then x.name end,
    'ack_version', public.public_ack_version())
  from (select 1) d
  left join lateral (
    select c.id, c.name, c.visibility
    from public.couples c
    where c.invite_code = upper(btrim(p_code))
      and (c.deleting_at is null or c.deleting_at <= now() - interval '15 minutes')
      and (select count(*) from public.couple_members m where m.couple_id = c.id) < 5
  ) x on true
$$;

-- 둘러보기 목록 (서버만). 공개·숨기지 않음·지우는 중 아님·장소 1곳 이상인 방, 마지막 활동이 최근인 순 50개.
-- 원소 키는 정확히 9개(설계 §2.6). 초대 코드·방 uuid·사용자 uuid는 넣지 않음.
-- 마지막 활동은 날짜 대신 'week'(KST 날짜로 7일 안) | 'month'(31일 안) | 'older'만 (방문 날짜를 월까지만 보이는 것과 맞춤)
create or replace function public.public_room_list()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with rooms as (
    select c.id, c.public_key, c.name, c.description, public.public_room_activity(c.id) as active_at
    from public.couples c
    where c.visibility = 'public'
      and c.public_hidden_at is null
      and (c.deleting_at is null or c.deleting_at <= now() - interval '15 minutes')
      and exists (select 1 from public.places p where p.couple_id = c.id)
    order by active_at desc, c.public_key
    limit 50
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'key', r.public_key,
      'name', r.name,
      'description', r.description,
      'member_count', (select count(*) from public.couple_members m where m.couple_id = r.id),
      'colors', coalesce((select jsonb_agg(m.color order by m.created_at, m.user_id)
                          from public.couple_members m where m.couple_id = r.id), '[]'::jsonb),
      'place_count', (select count(*) from public.places p where p.couple_id = r.id),
      'visited_count', (select count(*) from public.places p where p.couple_id = r.id and p.status = 'visited'),
      'review_count', (select count(*) from public.reviews v join public.places p on p.id = v.place_id where p.couple_id = r.id),
      'active', (select case when z.d < 7 then 'week' when z.d < 31 then 'month' else 'older' end
                 from (select (now() at time zone 'Asia/Seoul')::date - (r.active_at at time zone 'Asia/Seoul')::date as d) z))
    order by r.active_at desc, r.public_key), '[]'::jsonb)
  from rooms r
$$;

-- 공개 방 하나 (서버만, 서버가 사진 경로를 서명한 뒤 경로는 지움). 키 형식이 틀리거나, 없거나, 개인 방·숨김·지우는 중(15분 안)이면 null.
-- 장소 0곳이어도 보임. 키는 정확히 설계 §2.6. 멤버는 들어온 순서로 m1–m5(응답 안에서만 쓰는 번호, 방장 표시 없음),
-- 나간 사람이 담은 장소·후기는 null("예전 멤버"). 날짜는 모두 'YYYY-MM'(KST). 찜(favorite)은 넣지 않음, 함께 쓰는 메모는 넣음
create or replace function public.public_room_view(p_key text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_key text;
  v_name text;
  v_desc text;
  v_total integer;
  v_result jsonb;
begin
  if p_key is null or p_key !~ '^[a-km-np-z2-9]{10}$' then
    return null;
  end if;
  select c.id, c.public_key, c.name, c.description into v_id, v_key, v_name, v_desc
  from public.couples c
  where c.public_key = p_key
    and c.visibility = 'public'
    and c.public_hidden_at is null
    and (c.deleting_at is null or c.deleting_at <= now() - interval '15 minutes');
  if v_id is null then
    return null;
  end if;
  select count(*) into v_total from public.places p where p.couple_id = v_id;

  with mem as (
    select m.user_id, m.display_name, m.color,
           row_number() over (order by m.created_at, m.user_id) as ord
    from public.couple_members m
    where m.couple_id = v_id
  ), pl as (
    select p.id, p.name, p.category, p.address, p.naver_url, p.status, p.shared_note, p.created_at, p.created_by,
           greatest(p.created_at,
                    (select max(v.created_at) from public.visits v where v.place_id = p.id),
                    (select max(r.updated_at) from public.reviews r where r.place_id = p.id)) as act
    from public.places p
    where p.couple_id = v_id
    order by act desc, p.id
    limit 300
  )
  select jsonb_build_object(
    'v', 1,
    'key', v_key,
    'name', v_name,
    'description', v_desc,
    'member_count', (select count(*) from mem),
    'place_count', v_total,
    'truncated', v_total > 300,
    'active', (select case when z.d < 7 then 'week' when z.d < 31 then 'month' else 'older' end
               from (select (now() at time zone 'Asia/Seoul')::date
                            - (public.public_room_activity(v_id) at time zone 'Asia/Seoul')::date as d) z),
    'members', coalesce((select jsonb_agg(jsonb_build_object('m', 'm' || mem.ord, 'name', mem.display_name, 'color', mem.color)
                                          order by mem.ord)
                         from mem), '[]'::jsonb),
    'categories', coalesce((select jsonb_agg(c.name order by c.position, c.created_at, c.name)
                            from public.categories c where c.couple_id = v_id), '[]'::jsonb),
    'places', coalesce((select jsonb_agg(jsonb_build_object(
        'id', pl.id,
        'name', pl.name,
        'category', pl.category,
        'address', pl.address,
        'map_url', pl.naver_url,
        'status', pl.status,
        'shared_note', pl.shared_note,
        'added_month', to_char(pl.created_at at time zone 'Asia/Seoul', 'YYYY-MM'),
        'added_by', (select 'm' || mem.ord from mem where mem.user_id = pl.created_by),
        'visits', coalesce((select jsonb_agg(jsonb_build_object(
            'month', to_char(v.visited_on, 'YYYY-MM'),
            'reviews', coalesce((select jsonb_agg(jsonb_build_object(
                'by', case when mm.ord is not null then 'm' || mm.ord end,
                'rating', r.rating,
                'body', r.body)
              order by mm.ord nulls last, r.created_at, r.id)
              from public.reviews r left join mem mm on mm.user_id = r.author_id
              where r.visit_id = v.id), '[]'::jsonb))
          order by v.visited_on desc, v.created_at desc)
          from public.visits v where v.place_id = pl.id), '[]'::jsonb),
        'photo_count', (select count(*) from public.place_photos ph where ph.place_id = pl.id),
        -- 저장소에 있는 파일 크기가 작은 것만 (멤버가 큰 파일을 썸네일로 넣어 방문자 전송량을 쓰지 못하게):
        -- 썸네일 150,000바이트·큰 사진 2,000,000바이트 이하. 파일이 없거나 크기를 모르면 null(화면은 회색 자리)
        'photos', coalesce((select jsonb_agg(jsonb_build_object(
                                               'path', case when x.path_size <= 2000000 then x.path end,
                                               'thumb', case when x.thumb_size <= 150000 then x.thumb_path end)
                                             order by x.position, x.created_at, x.id)
                            from (select ph.path, ph.thumb_path, ph.position, ph.created_at, ph.id,
                                         (select case when o.metadata ->> 'size' ~ '^[0-9]{1,12}$' then (o.metadata ->> 'size')::bigint end
                                          from storage.objects o
                                          where o.bucket_id = 'place-photos' and o.name = ph.path limit 1) as path_size,
                                         (select case when o.metadata ->> 'size' ~ '^[0-9]{1,12}$' then (o.metadata ->> 'size')::bigint end
                                          from storage.objects o
                                          where o.bucket_id = 'place-photos' and o.name = ph.thumb_path limit 1) as thumb_size
                                  from public.place_photos ph where ph.place_id = pl.id
                                  order by ph.position, ph.created_at, ph.id
                                  limit 3) x), '[]'::jsonb))
      order by pl.act desc, pl.id)
      from pl), '[]'::jsonb))
  into v_result;
  return v_result;
end;
$$;

-- 관리자 숨기기 (deploy/home/public.sh, 서버만). 그 키의 공개 방이 있으면 true (이미 숨겼으면 숨긴 시각은 그대로)
create or replace function public.admin_set_room_hidden(p_key text, p_hidden boolean)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if p_key is null or p_hidden is null then
    return false;
  end if;
  update public.couples
  set public_hidden_at = case when p_hidden then coalesce(public_hidden_at, now()) end
  where public_key = btrim(p_key) and visibility = 'public';
  return found;
end;
$$;

-- 공개 방 목록 (관리자 스크립트, 서버만). 시각은 한국 시간 문자열, 최근 만든 방부터
create or replace function public.admin_public_rooms()
returns table (key text, name text, hidden_at text, members integer, places integer, created_at text)
language sql
stable
security definer
set search_path = ''
as $$
  select c.public_key,
         c.name,
         to_char(c.public_hidden_at at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI'),
         (select count(*) from public.couple_members m where m.couple_id = c.id)::integer,
         (select count(*) from public.places p where p.couple_id = c.id)::integer,
         to_char(c.created_at at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI')
  from public.couples c
  where c.visibility = 'public'
  order by c.created_at desc, c.public_key;
$$;

-- ---------- 바뀌는 기존 함수 ----------
-- 방 코드로 참여 (옛 홈 서버용, 이름·인자 그대로). groups.sql 본문 + 공개 방이면 ack_required
-- (동의 없이 공개 방에 넣지 못하게. 새 서버는 join_room_for를 씀)
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

  -- 공개 방은 동의가 있어야 들어감 (이 함수에는 동의 인자가 없음)
  if exists (select 1 from public.couples where id = v_couple and visibility = 'public') then
    raise exception 'ack_required';
  end if;

  -- 색은 트리거가 그 방의 빈 색으로 무작위
  insert into public.couple_members (couple_id, user_id, role, display_name)
  values (v_couple, v_uid, 'member', v_display);

  return v_couple;
end;
$$;

-- 마지막 멤버가 방을 지우기 전: 사진 파일 경로를 모두 돌려주고 15분 동안 새 참여를 막음. groups.sql 본문 + 썸네일 경로
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

  -- 사진 표(place_photos)의 경로·썸네일 경로 + 예전 사진 칸(places.photo_path).
  -- place_photos.path·thumb_path는 제약으로 '<장소 id>/…'만 들어가지만 photo_path는 아무 글이나 들어갈 수 있었으므로
  -- 그 장소 폴더 안의 경로만 돌려줌(다른 방 사진 경로를 넣어 두고 마지막 멤버가 지우게 하는 것을 막음)
  select coalesce(array_agg(x.path order by x.path), '{}') into v_paths
  from (
    select ph.path
    from public.place_photos ph
    join public.places p on p.id = ph.place_id
    where p.couple_id = p_couple
    union
    select ph.thumb_path
    from public.place_photos ph
    join public.places p on p.id = ph.place_id
    where p.couple_id = p_couple and ph.thumb_path is not null
    union
    select p.photo_path
    from public.places p
    where p.couple_id = p_couple and p.photo_path is not null
      and split_part(p.photo_path, '/', 1) = p.id::text
  ) x;
  return v_paths;
end;
$$;

-- ---------- 사진 저장소 정책 ----------
-- 지금은 places RLS 덕에 결과가 같지만, 나중에 places select를 넓히는 실수를 해도 남의 장소 폴더에 사진을 올리거나 지울 수 없게
-- 멤버 확인을 직접 넣음. 썸네일 '<place_id>/t/<파일>'도 foldername(...)[1]이 장소 id라 같은 정책을 탐.
-- 주의: 하위 쿼리 안에서는 places.name(장소 이름)과 겹치므로 반드시 objects.name 으로 씀.
drop policy "place photos select" on storage.objects;
drop policy "place photos insert" on storage.objects;
drop policy "place photos delete" on storage.objects;
create policy "place photos select" on storage.objects for select to authenticated
  using (bucket_id = 'place-photos'
         and exists (select 1 from public.places p
                     where p.id::text = (storage.foldername(objects.name))[1]
                       and public.is_couple_member(p.couple_id)));
create policy "place photos insert" on storage.objects for insert to authenticated
  with check (bucket_id = 'place-photos'
              and exists (select 1 from public.places p
                          where p.id::text = (storage.foldername(objects.name))[1]
                            and public.is_couple_member(p.couple_id)));
create policy "place photos delete" on storage.objects for delete to authenticated
  using (bucket_id = 'place-photos'
         and exists (select 1 from public.places p
                     where p.id::text = (storage.foldername(objects.name))[1]
                       and public.is_couple_member(p.couple_id)));

-- ---------- 권한 ----------
-- 함수는 기본으로 모두(public)에게 열리고 Supabase 기본 권한이 anon·authenticated에도 열어 두므로 하나씩 정함.
-- couples·places 등 표 권한과 RLS 정책은 넓히지 않음(새 칸은 기존 select 권한 + 멤버 정책으로 멤버에게만 보임)
-- 앱
revoke all on function public.create_room(text, text, text, text, integer) from public, anon;
grant execute on function public.create_room(text, text, text, text, integer) to authenticated;
revoke all on function public.public_create_status() from public, anon;
grant execute on function public.public_create_status() to authenticated;
revoke all on function public.set_room_description(uuid, text) from public, anon;
grant execute on function public.set_room_description(uuid, text) to authenticated;
revoke all on function public.regenerate_invite_code(uuid) from public, anon;
grant execute on function public.regenerate_invite_code(uuid) to authenticated;
revoke all on function public.public_ack_version() from public, anon;
grant execute on function public.public_ack_version() to authenticated, service_role;
-- 서버만
revoke all on function public.join_room_for(uuid, text, text, integer) from public, anon, authenticated;
grant execute on function public.join_room_for(uuid, text, text, integer) to service_role;
revoke all on function public.space_code_info(text) from public, anon, authenticated;
grant execute on function public.space_code_info(text) to service_role;
revoke all on function public.public_room_list() from public, anon, authenticated;
grant execute on function public.public_room_list() to service_role;
revoke all on function public.public_room_view(text) from public, anon, authenticated;
grant execute on function public.public_room_view(text) to service_role;
revoke all on function public.public_rooms_version() from public, anon, authenticated;
grant execute on function public.public_rooms_version() to service_role;
revoke all on function public.admin_set_room_hidden(text, boolean) from public, anon, authenticated;
grant execute on function public.admin_set_room_hidden(text, boolean) to service_role;
revoke all on function public.admin_public_rooms() from public, anon, authenticated;
grant execute on function public.admin_public_rooms() to service_role;
-- 내부 전용 (트리거·다른 함수 안에서만)
revoke all on function public.public_login_id(uuid) from public, anon, authenticated;
revoke all on function public.public_room_activity(uuid) from public, anon, authenticated;
revoke all on function public.public_text_ok(text) from public, anon, authenticated;
revoke all on function public.public_nick_key(text) from public, anon, authenticated;
revoke all on function public.couples_public_text() from public, anon, authenticated;
revoke all on function public.couples_freeze_visibility() from public, anon, authenticated;
revoke all on function public.enforce_public_nickname() from public, anon, authenticated;
-- 바뀐 기존 함수는 create or replace라 권한이 그대로지만 한 번 더 적음 (groups.sql과 같게)
revoke all on function public.join_couple_for(uuid, text, text) from public, anon, authenticated;
grant execute on function public.join_couple_for(uuid, text, text) to service_role;
revoke all on function public.begin_room_delete(uuid) from public, anon;
grant execute on function public.begin_room_delete(uuid) to authenticated;

commit;
