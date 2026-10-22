-- 이 앱의 Supabase 프로젝트에 schema.sql 다음으로 실행한다.
-- 초대 코드로 가입: 관리자가 만든 1회용 가입 코드(W-XXXX-XXXX)나 공간의 8자리 초대 코드로 친구가 직접 가입한다.
-- 가입 처리는 홈 서버(deploy/home/signup.cjs, POST /api/signup)가 secret key로 아래 함수를 불러서 한다.
-- 공간 코드 맞히기 횟수 제한: 친구용에서는 앱(authenticated)이 join_couple을 직접 못 부르게 막고,
--   홈 서버(POST /api/join, /api/signup)가 횟수를 센 뒤 join_couple_for로 대신 넣는다. 그래서 친구용 앱에서
--   코드로 참여하려면 홈 서버에 secret key가 있어야 한다(공간 만들기는 상관없음). schema.sql은 그대로 둔다.
-- 표와 함수는 secret key(service_role)로만 쓸 수 있다. 앱(anon·authenticated)에서는 보이지도 불리지도 않는다.
-- 한 번만 실행하세요. 중간에 실패하면 전부 취소됩니다. 실행한 뒤 홈 서버에서 set-secret.sh로 secret key를 넣습니다.
-- 되돌리기: friends-signup_rollback.sql
--
-- 쓰는 법 (SQL Editor, 또는 홈 서버의 deploy/home/invite.sh):
--   select public.new_signup_invite('민수');              -- 7일 동안 쓸 수 있는 가입 코드 (예: W-7KQ2-XM9A)
--   select public.new_signup_invite('민수', 3);           -- 3일짜리
--   select * from public.list_signup_invites();           -- 목록 (상태, 메모, 만료, 가입한 아이디)
--   select public.revoke_signup_invite('W-7KQ2-XM9A');    -- 아직 안 쓴 코드 취소

begin;

do $$
begin
  if to_regclass('public.signup_invites') is not null then
    raise exception '이미 적용된 SQL이에요 (signup_invites 표가 있음).';
  end if;
  if to_regprocedure('public.join_couple(text, text)') is null then
    raise exception 'join_couple 함수가 없어요. 먼저 supabase/schema.sql을 실행하세요.';
  end if;
  -- Supabase는 pgcrypto를 extensions 스키마에 둔다. 코드 만들기에 그 안의 gen_random_bytes를 쓴다
  if to_regprocedure('extensions.gen_random_bytes(integer)') is null then
    raise exception 'extensions.gen_random_bytes가 없어요. 먼저 실행: create extension if not exists pgcrypto with schema extensions;';
  end if;
end $$;

-- 가입 코드: 'W' + 헷갈리는 글자(0 1 I L O)를 뺀 8자. 화면에는 W-XXXX-XXXX로 보여 줌.
-- used_at: 가입 시작(서버가 코드를 잡음), finished_at: 계정을 코드에 기록함, used_by: 그 계정(지우면 비워짐).
create table public.signup_invites (
  code text not null,
  note text not null default '',
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '7 days',
  used_at timestamptz,
  finished_at timestamptz,
  used_by uuid references auth.users (id) on delete set null,
  revoked_at timestamptz,
  constraint signup_invites_pkey primary key (code),
  constraint signup_invites_code_check check (code ~ '^W[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{8}$'),
  constraint signup_invites_note_check check (char_length(note) <= 100)
);

-- 정책 없이 RLS만 켬 + 권한 회수: Supabase 기본 권한이 public 스키마 표를 anon·authenticated에 열어 두므로 직접 막는다
alter table public.signup_invites enable row level security;
revoke all on public.signup_invites from public, anon, authenticated;

-- ---------- 함수 (전부 secret key 전용) ----------
-- 코드 입력은 대문자로 바꾸고 공백·하이픈을 뺀다 ('w-7kq2 xm9a' → 'W7KQ2XM9A')

-- 새 가입 코드. p_days일 뒤 만료 (기본 7일, 1~90)
create or replace function public.new_signup_invite(p_note text default '', p_days integer default 7)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_alphabet constant text := '23456789ABCDEFGHJKMNPQRSTUVWXYZ'; -- 31자
  v_bytes bytea;
  v_code text;
  v_byte integer;
begin
  if p_days is null or p_days < 1 or p_days > 90 then
    raise exception '유효 기간은 1~90일이에요.';
  end if;
  for attempt in 1..10 loop
    -- 248(= 31 × 8) 이상인 바이트는 버려서 글자마다 확률이 같게
    v_code := 'W';
    while char_length(v_code) < 9 loop
      v_bytes := extensions.gen_random_bytes(16);
      for i in 0..15 loop
        v_byte := get_byte(v_bytes, i);
        if v_byte < 248 and char_length(v_code) < 9 then
          v_code := v_code || substr(v_alphabet, v_byte % 31 + 1, 1);
        end if;
      end loop;
    end loop;
    begin
      insert into public.signup_invites (code, note, expires_at)
      values (v_code, left(coalesce(trim(p_note), ''), 100), now() + make_interval(days => p_days));
      return 'W-' || substr(v_code, 2, 4) || '-' || substr(v_code, 6, 4);
    exception when unique_violation then
      null; -- 아주 드물게 겹치면 새로 뽑음
    end;
  end loop;
  raise exception '가입 코드를 만들지 못했어요. 다시 실행해 주세요.';
end;
$$;

-- 아직 안 쓴 코드 취소. 취소했으면 true
create or replace function public.revoke_signup_invite(p_code text)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  update public.signup_invites
  set revoked_at = now()
  where code = upper(regexp_replace(coalesce(p_code, ''), '[[:space:]-]', '', 'g'))
    and used_at is null
    and revoked_at is null;
  return found;
end;
$$;

-- 가입 시작: 쓸 수 있는 코드(안 씀·안 취소·안 만료)면 한 번에 '처리 중'으로 바꾸고 true.
-- 한 문장(update)이라 같은 코드로 동시에 가입해도 한 사람만 true
create or replace function public.claim_signup_invite(p_code text)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  update public.signup_invites
  set used_at = now()
  where code = upper(regexp_replace(coalesce(p_code, ''), '[[:space:]-]', '', 'g'))
    and used_at is null
    and revoked_at is null
    and expires_at > now();
  return found;
end;
$$;

-- 가입이 실패했을 때 claim을 되돌림. 남은 계정이 없고(서버가 먼저 지움) 방금(10분 안) 시작한 것만
create or replace function public.release_signup_invite(p_code text)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  update public.signup_invites
  set used_at = null,
      finished_at = null
  where code = upper(regexp_replace(coalesce(p_code, ''), '[[:space:]-]', '', 'g'))
    and used_at is not null
    and used_at > now() - interval '10 minutes'
    and used_by is null;
  return found;
end;
$$;

-- 가입 끝: 처리 중인 코드에 가입한 계정을 기록. 기록했으면 true
create or replace function public.finish_signup_invite(p_code text, p_user uuid)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if p_user is null then
    return false;
  end if;
  update public.signup_invites
  set used_by = p_user,
      finished_at = now()
  where code = upper(regexp_replace(coalesce(p_code, ''), '[[:space:]-]', '', 'g'))
    and used_at is not null
    and used_by is null;
  return found;
end;
$$;

-- 목록 (최근 것부터, 시각은 한국 시간).
-- 가입한 아이디는 서버가 넣은 app_metadata에서 읽는다(user_metadata는 본인이 바꿀 수 있어서 믿지 않음).
-- '가입 중단·확인 필요': 가입 도중 서버가 멈췄거나 되돌리기에 실패한 코드. 다시 쓸 수 없고,
--   공간 없는 '<아이디>@<LOGIN_ID_DOMAIN>' 계정이 남았을 수 있다(README 참고).
create or replace function public.list_signup_invites()
returns table (code text, status text, note text, created_at text, expires_at text, used_at text, username text)
language sql
stable
security definer
set search_path = ''
as $$
  select 'W-' || substr(i.code, 2, 4) || '-' || substr(i.code, 6, 4),
         case
           when i.revoked_at is not null then '취소됨'
           when i.used_by is not null then '사용됨'
           when i.finished_at is not null then '사용됨(계정 삭제)'
           when i.used_at is not null and i.used_at > now() - interval '10 minutes' then '가입 중'
           when i.used_at is not null then '가입 중단·확인 필요'
           when i.expires_at <= now() then '만료'
           else '사용 가능'
         end,
         i.note,
         to_char(i.created_at at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI'),
         to_char(i.expires_at at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI'),
         to_char(i.used_at at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI'),
         coalesce(u.raw_app_meta_data ->> 'username', split_part(u.email::text, '@', 1))
  from public.signup_invites i
  left join auth.users u on u.id = i.used_by
  order by i.created_at desc;
$$;

-- 공간 초대 코드(8자리)로 가입할 수 있는지 미리 확인: 코드가 있고 멤버가 2명 미만이면 true.
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
    where c.invite_code = upper(trim(p_code))
      and (select count(*) from public.couple_members m where m.couple_id = c.id) < 2
  );
$$;

-- 공간 코드로 참여: join_couple(schema.sql)과 같은 규칙(최대 2명, 다 차면 초대 코드 폐기)으로 p_user를 넣는다.
-- 홈 서버가 횟수를 센 뒤에만 부른다. join_couple 본문을 고치면 이것도 같이 고친다.
create or replace function public.join_couple_for(p_user uuid, p_invite_code text, p_display_name text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := p_user;
  v_couple uuid;
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;

  if exists (select 1 from public.couple_members where user_id = v_uid) then
    raise exception 'already_in_couple';
  end if;

  -- 동시에 두 명이 참여하는 경우를 막기 위해 행 잠금
  select id into v_couple
  from public.couples
  where invite_code = upper(trim(p_invite_code))
  for update;

  if v_couple is null then
    raise exception 'invalid_code';
  end if;

  if (select count(*) from public.couple_members where couple_id = v_couple) >= 2 then
    raise exception 'couple_full';
  end if;

  insert into public.couple_members (couple_id, user_id, role, display_name)
  values (v_couple, v_uid, 'member', coalesce(trim(p_display_name), ''));

  -- 두 사람이 모두 들어왔으니 초대 코드 폐기
  update public.couples set invite_code = null where id = v_couple;

  return v_couple;
end;
$$;

-- 권한: 함수는 기본으로 모두(public)에게 열리고 Supabase 기본 권한이 anon·authenticated에도 열어 두므로 전부 회수
revoke all on function public.new_signup_invite(text, integer) from public, anon, authenticated;
revoke all on function public.revoke_signup_invite(text) from public, anon, authenticated;
revoke all on function public.claim_signup_invite(text) from public, anon, authenticated;
revoke all on function public.release_signup_invite(text) from public, anon, authenticated;
revoke all on function public.finish_signup_invite(text, uuid) from public, anon, authenticated;
revoke all on function public.list_signup_invites() from public, anon, authenticated;
revoke all on function public.space_code_open(text) from public, anon, authenticated;
revoke all on function public.join_couple_for(uuid, text, text) from public, anon, authenticated;
grant execute on function public.new_signup_invite(text, integer) to service_role;
grant execute on function public.revoke_signup_invite(text) to service_role;
grant execute on function public.claim_signup_invite(text) to service_role;
grant execute on function public.release_signup_invite(text) to service_role;
grant execute on function public.finish_signup_invite(text, uuid) to service_role;
grant execute on function public.list_signup_invites() to service_role;
grant execute on function public.space_code_open(text) to service_role;
grant execute on function public.join_couple_for(uuid, text, text) to service_role;

-- 앱에서 join_couple을 바로 부르면 횟수 제한 없이 공간 코드를 맞혀 볼 수 있으므로 친구용에서는 거둔다.
-- (되돌리기 SQL이 schema.sql처럼 authenticated에 다시 열어 줌)
revoke all on function public.join_couple(text, text) from public, anon, authenticated;

commit;
