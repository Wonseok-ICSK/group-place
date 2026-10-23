-- 먼저 이전 앱 코드로 되돌린 뒤 실행. 휴지통이 비어 있지 않으면 데이터 보호를 위해 중단한다.
begin;
do $$ begin
 if exists(select 1 from public.trash_jobs) then raise exception 'trash_not_empty_restore_or_purge_before_rollback'; end if;
end $$;
drop function public.save_visit_review(uuid,date,uuid,numeric,text,jsonb);
drop trigger maintenance_guard_photo on public.place_photos;
drop function public.maintenance_guard_photo();
drop policy "place photos select" on storage.objects;
do $$ declare r record; begin
 for r in select definition from public.maintenance_rollback loop execute r.definition; end loop;
end $$;
grant execute on function public.save_visit_review(uuid,date,uuid,numeric,text) to authenticated;
revoke all on function public.save_visit_review(uuid,date,uuid,numeric,text) from public,anon;
grant delete on public.places,public.place_photos,public.visits,public.reviews,public.categories,public.cup_results to authenticated;
drop function public.save_shared_note(uuid,text,text),public.trash_item(text,uuid),public.trash_uploads(text[]),public.maintenance_claim(),
 public.maintenance_finish(uuid,uuid,text),public.maintenance_status(),public.maintenance_photo_active(text),public.maintenance_version();
drop function public.maintenance_archive(text,uuid,jsonb,text[]),public.maintenance_place_snapshot(uuid[]),public.maintenance_photo_paths(uuid[]);
drop table public.trash_jobs,public.maintenance_rollback;
commit;
notify pgrst,'reload schema';
