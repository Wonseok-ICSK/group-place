-- 이 앱의 Supabase 프로젝트에 schema.sql 다음으로 실행한다.
-- 홈 서버의 our-places-keepalive.timer가 하루 한 번 이 함수를 불러, 무료 프로젝트가 7일 동안 요청이 없어
-- 일시정지되는 것을 막는다. 아무 표도 읽지 않고 1만 돌려준다.
create or replace function public.keepalive()
returns integer
language sql
stable
security invoker
set search_path = ''
as $$ select 1 $$;

revoke all on function public.keepalive() from public;
grant execute on function public.keepalive() to anon;

-- 되돌리기: drop function public.keepalive();
