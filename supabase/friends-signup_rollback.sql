-- friends-signup.sql 되돌리기 (친구용 Supabase 프로젝트에만)
-- 가입 코드 표와 함수(join_couple_for 포함)를 지우고, 앱에서 join_couple을 다시 부를 수 있게 schema.sql처럼 열어 둠.
-- 지우기 전 코드 목록은 backup 스키마에 복사해 둠.
-- 이미 가입한 계정과 공간은 그대로 남음 (계정은 Authentication → Users에서 따로 관리).
-- 순서: 홈 서버에서 가입 끄기(sudo bash /srv/our-places/current/deploy/home/set-secret.sh --remove) → 이 SQL 실행.
-- (그 사이에는 앱에서 공간 코드로 참여가 안 되고, 반대로 하면 그 사이 가입·참여 시도가 실패할 뿐 다른 기능은 그대로예요.)

begin;

do $$
begin
  if to_regclass('public.signup_invites') is null then
    raise exception '되돌릴 것이 없어요 (signup_invites 표가 없음).';
  end if;
  create schema if not exists backup;
  execute format('create table backup.%I as table public.signup_invites',
                 'signup_invites_' || to_char(now() at time zone 'Asia/Seoul', 'YYYYMMDD_HH24MISS'));
end $$;

drop function if exists public.new_signup_invite(text, integer);
drop function if exists public.revoke_signup_invite(text);
drop function if exists public.claim_signup_invite(text);
drop function if exists public.release_signup_invite(text);
drop function if exists public.finish_signup_invite(text, uuid);
drop function if exists public.list_signup_invites();
drop function if exists public.space_code_open(text);
drop function if exists public.join_couple_for(uuid, text, text);
drop table public.signup_invites;

-- schema.sql과 같은 권한으로 되돌림: 로그인한 사람이 앱에서 직접 참여
grant execute on function public.join_couple(text, text) to authenticated;

commit;
