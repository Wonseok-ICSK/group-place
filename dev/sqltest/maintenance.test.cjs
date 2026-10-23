'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { newDb,SQL,addUsers,run,asUser,ANON,SERVICE,uid,createRoom,join,codeOf,count } = require('./helpers.cjs');
async function setup() {
 const db=await newDb({public:true});await db.exec(SQL('stability.sql'));await db.exec(SQL('maintenance.sql'));
 await addUsers(db,1,2,3);const room=await createRoom(db,1);await join(db,2,await codeOf(db,room));
 const [p]=await run(db,asUser(1),"insert into public.places(couple_id,name,category,created_by) values($1,'시험 장소','기타',$2) returning id",[room,uid(1)]);
 return {db,room,place:p.id};
}
const trash=(db,n,kind,id)=>run(db,asUser(n),'select public.trash_item($1,$2) as ok',[kind,id]);
test('V031: 장소·연결 데이터는 원자적으로 휴지통으로, 사진 경로는 72시간 보관, 사용자 접근과 직접 삭제 차단',async()=>{
 const {db,place}=await setup();try{
  const [ph]=await run(db,asUser(1),'insert into public.place_photos(place_id,path,thumb_path,created_by) values($1,$2,$3,$4) returning id',[place,`${place}/${'a'.repeat(32)}.jpg`,`${place}/t/${'a'.repeat(32)}.jpg`,uid(1)]);
  await assert.rejects(trash(db,3,'place',place),/not_member/);
  await assert.rejects(run(db,asUser(1),'delete from public.places where id=$1',[place]),/permission denied/);
  assert.equal((await trash(db,1,'place',place))[0].ok,true);
  assert.equal(await count(db,'select 1 from public.places where id=$1',[place]),0);
  const [j]=(await db.query("select *,extract(epoch from purge_after-created_at)::int as seconds from public.trash_jobs")).rows;
  assert.equal(j.seconds,259200);assert.equal(j.paths.length,2);assert.equal(j.payload.place_photos[0].id,ph.id);
  await assert.rejects(run(db,asUser(1),'select * from public.trash_jobs'),/permission denied/);
  await assert.rejects(run(db,ANON,'select public.maintenance_claim()'),/permission denied/);
  assert.equal((await run(db,SERVICE,'select * from public.maintenance_claim()')).length,0);
  await db.query("update public.trash_jobs set purge_after=now()-interval '1 second'");
  const latePath=`${place}/${'c'.repeat(32)}.jpg`;
  await db.query("insert into storage.objects(bucket_id,name) values('place-photos',$1)",[latePath]);
  const [claim]=await run(db,SERVICE,'select * from public.maintenance_claim()');assert.equal(claim.id,j.id);
  assert.ok(claim.paths.includes(latePath),'삭제와 겹쳐 늦게 끝난 업로드도 만료 시 정리');
  assert.equal((await run(db,SERVICE,'select * from public.maintenance_claim()')).length,0,'lease 중복 작업 방지');
  assert.equal((await run(db,SERVICE,'select public.maintenance_finish($1,$2,null) as ok',[j.id,'00000000-0000-4000-8000-000000000000']))[0].ok,false);
  await run(db,SERVICE,"select public.maintenance_finish($1,$2,'STORAGE_DELETE_FAILED')",[j.id,claim.lease]);
  assert.equal(await count(db,'select 1 from public.trash_jobs'),1,'실패 시 원본 보존');
  await db.query("update public.trash_jobs set next_attempt=now()-interval '1 second'");
  const [again]=await run(db,SERVICE,'select * from public.maintenance_claim()');
  await run(db,SERVICE,'select public.maintenance_finish($1,$2,null)',[again.id,again.lease]);
  assert.equal(await count(db,'select 1 from public.trash_jobs'),0);
 }finally{await db.close()}
});
test('V031: 다른 멤버의 후기·다른 후기 있는 방문 삭제 금지, 내 후기만 휴지통으로',async()=>{
 const {db,place}=await setup();try{
  const [v]=await run(db,asUser(1),"select public.save_visit_review($1,'2026-10-23',null,4,'내 후기',null) as id",[place]);
  await run(db,asUser(2),"select public.save_visit_review($1,'2026-10-23',null,5,'다른 후기',null)",[place]);
  const [r]=(await db.query('select id from public.reviews where author_id=$1',[uid(2)])).rows;
  await assert.rejects(trash(db,1,'review',r.id),/not_author/);await assert.rejects(trash(db,1,'visit',v.id),/other_reviews/);
  await trash(db,2,'review',r.id);assert.equal(await count(db,'select 1 from public.reviews'),1);
 }finally{await db.close()}
});
test('V031: 오래된 후기·날짜·메모는 새 기록을 덮지 않고 새 방문 빈 저장은 기존 후기 유지',async()=>{
 const {db,place}=await setup();try{
  const [v]=await run(db,asUser(1),"select public.save_visit_review($1,'2026-10-23',null,4,'처음',null) as id",[place]);
  const base={day:'2026-10-23',rating:4,body:'처음'};
  await run(db,asUser(1),"select public.save_visit_review($1,'2026-10-23',$2,5,'새 기록',$3)",[place,v.id,base]);
  await assert.rejects(run(db,asUser(1),"select public.save_visit_review($1,'2026-10-23',$2,3,'오래된 기록',$3)",[place,v.id,base]),/review_changed/);
  await run(db,asUser(1),"select public.save_visit_review($1,'2026-10-23',null,null,'',null)",[place]);
  assert.equal((await db.query('select body from public.reviews')).rows[0].body,'새 기록');
  await run(db,asUser(1),"select public.save_shared_note($1,'새 메모','')",[place]);
  await assert.rejects(run(db,asUser(2),"select public.save_shared_note($1,'오래된 메모','')",[place]),/note_changed/);
  await run(db,asUser(1),"select public.save_visit_review($1,'2026-10-24',$2,5,'새 기록',$3)",[place,v.id,{...base,rating:5,body:'새 기록'}]);
  assert.equal((await db.query('select visited_on::text as day from public.visits')).rows[0].day,'2026-10-24');
  await assert.rejects(run(db,asUser(1),"select public.save_visit_review($1,'2026-10-25',$2,5,'충돌',$3)",[place,v.id,{...base,rating:5,body:'새 기록'}]),/visit_changed/);
  // 사용자가 날짜를 건드리지 않았다면 다른 멤버가 바꾼 날짜를 유지한다.
  await run(db,asUser(1),"select public.save_visit_review($1,'2026-10-23',$2,4,'후기만 변경',$3)",[place,v.id,{...base,rating:5,body:'새 기록'}]);
  assert.equal((await db.query('select visited_on::text as day from public.visits')).rows[0].day,'2026-10-24');
 }finally{await db.close()}
});
test('V031: 마지막 멤버의 방 삭제도 Storage 작업 없이 휴지통, 비어 있지 않은 휴지통 rollback 중단',async()=>{
 const {db,room}=await setup();try{
  await run(db,asUser(2),'select public.leave_room($1)',[room]);
  await run(db,asUser(1),'select public.begin_room_delete($1)',[room]);
  await run(db,asUser(1),'select public.leave_room($1)',[room]);
  assert.equal(await count(db,'select 1 from public.couples where id=$1',[room]),0);
  assert.equal(await count(db,"select 1 from public.trash_jobs where kind='room'"),1);
  await assert.rejects(db.exec(SQL('maintenance_rollback.sql')),/trash_not_empty/);await db.exec('rollback');
 }finally{await db.close()}
});

test('V031: 삭제 대기 사진의 경로 재등록 금지, 빈 휴지통에서는 완전히 되돌릴 수 있음',async()=>{
 const {db,place}=await setup();try{
  const photoPath=`${place}/${'b'.repeat(32)}.jpg`;
  const [ph]=await run(db,asUser(1),'insert into public.place_photos(place_id,path,created_by) values($1,$2,$3) returning id',[place,photoPath,uid(1)]);
  await trash(db,1,'photo',ph.id);
  await assert.rejects(run(db,asUser(2),'insert into public.place_photos(place_id,path,created_by) values($1,$2,$3)',[place,photoPath,uid(2)]),/photo_path_retired/);
  // 시험 DB에서만 작업을 비우고 rollback 구조를 검증한다.
  await db.exec('delete from public.trash_jobs');await db.exec(SQL('maintenance_rollback.sql'));
  assert.equal((await db.query("select to_regclass('public.trash_jobs') as t")).rows[0].t,null);
  await run(db,asUser(1),'delete from public.places where id=$1',[place]);
 }finally{await db.close()}
});
