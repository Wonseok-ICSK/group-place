-- V0.2.3 코드에서 이전 코드로 되돌린 뒤 실행. 데이터는 그대로 보존한다.
begin;
drop trigger if exists place_photos_enforce_limit on public.place_photos;
drop function if exists public.enforce_place_photo_limit();
drop function if exists public.save_visit_review(uuid, date, uuid, numeric, text);
drop function if exists public.stability_schema_version();
commit;
notify pgrst, 'reload schema';
