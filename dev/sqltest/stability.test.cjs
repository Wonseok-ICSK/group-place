'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { newDb, SQL, addUsers, run, asUser, ANON, SERVICE, uid, createRoom, codeOf, join, count, snapshot, expectError } = require('./helpers.cjs');

async function setup() {
  const db = await newDb({ public: true });
  await db.exec(SQL('stability.sql'));
  await addUsers(db, 1, 2, 3);
  const room = await createRoom(db, 1);
  await join(db, 2, await codeOf(db, room));
  const [p] = await run(db, asUser(1), "insert into public.places(couple_id,name,category,created_by) values ($1,'시험 장소','기타',$2) returning id", [room, uid(1)]);
  return { db, room, place: p.id };
}
const save = (db, user, place, { day = '2026-10-23', visit = null, rating = 4, body = '후기' } = {}) =>
  run(db, asUser(user), 'select public.save_visit_review($1,$2,$3,$4,$5) as id', [place, day, visit, rating, body]).then((r) => r[0].id);
const photo = (db, user, place, n) => run(db, asUser(user),
  'insert into public.place_photos(place_id,path,position,created_by) values ($1,$2,$3,$4)',
  [place, `${place}/${String(n).padStart(32, '0')}.jpg`, n, uid(user)]);

test('V023: 같은 날짜를 먼저 본 두 멤버가 저장해도 방문 하나와 각자의 후기, 작성자는 유지', async () => {
  const { db, place } = await setup();
  try {
    const a = await save(db, 1, place);
    const b = await save(db, 2, place, { body: '다른 멤버 후기' });
    assert.equal(a, b);
    assert.equal(await count(db, 'select 1 from public.visits where place_id=$1', [place]), 1);
    assert.equal(await count(db, 'select 1 from public.reviews where visit_id=$1', [a]), 2);
    assert.equal((await db.query('select created_by from public.visits where id=$1', [a])).rows[0].created_by, uid(1));
    await save(db, 1, place, { body: '재시도·수정', rating: 4.5 });
    assert.equal(await count(db, 'select 1 from public.reviews where visit_id=$1', [a]), 2);
    assert.equal((await db.query('select body from public.reviews where visit_id=$1 and author_id=$2', [a, uid(1)])).rows[0].body, '재시도·수정');
    await save(db, 1, place, { visit: a, rating: null, body: '  ' });
    assert.equal(await count(db, 'select 1 from public.reviews where visit_id=$1', [a]), 1, '다른 멤버 후기는 유지');
  } finally { await db.close(); }
});

test('V023: 후기 저장 실패는 새 방문 생성·기존 날짜 변경까지 모두 되돌림', async () => {
  const { db, place } = await setup();
  try {
    await assert.rejects(save(db, 1, place, { rating: 6 }), /reviews_rating_check/);
    assert.equal(await count(db, 'select 1 from public.visits where place_id=$1', [place]), 0);
    const id = await save(db, 1, place);
    await assert.rejects(save(db, 1, place, { visit: id, day: '2026-10-22', rating: 6 }), /reviews_rating_check/);
    const [row] = (await db.query('select visited_on::text as day from public.visits where id=$1', [id])).rows;
    assert.equal(row.day, '2026-10-23');
  } finally { await db.close(); }
});

test('V023: 멤버 아닌 사용자·다른 장소 방문·anon·빈 사용자 차단, 기존 RLS 유지', async () => {
  const { db, place, room } = await setup();
  try {
    await expectError(save(db, 3, place), 'not_member');
    await expectError(save(db, 1, place, { visit: '00000000-0000-4000-8000-999999999999' }), 'visit_gone');
    const id = await save(db, 1, place);
    const [other] = await run(db, asUser(1), "insert into public.places(couple_id,name,category,created_by) values ($1,'다른 장소','기타',$2) returning id", [room, uid(1)]);
    await expectError(save(db, 1, other.id, { visit: id }), 'visit_gone');
    await assert.rejects(run(db, ANON, "select public.save_visit_review($1,'2026-10-23',null,4,'x')", [place]), /permission denied/);
    await expectError(run(db, { role: 'authenticated' }, "select public.save_visit_review($1,'2026-10-23',null,4,'x')", [place]), 'not_authenticated');
    await assert.rejects(run(db, asUser(1), 'select public.enforce_place_photo_limit()'), /permission denied/);
    assert.equal((await run(db, SERVICE, 'select public.stability_schema_version() as v'))[0].v, 1);
    await assert.rejects(run(db, asUser(1), 'select public.stability_schema_version()'), /permission denied/);
  } finally { await db.close(); }
});

test('V023: 서로 9장으로 알고 있어도 DB는 11번째 사진을 거절하고 지운 뒤 다시 허용', async () => {
  const { db, place } = await setup();
  try {
    for (let n = 0; n < 9; n++) await photo(db, 1, place, n);
    await photo(db, 1, place, 9);
    await expectError(photo(db, 2, place, 10), 'photo_limit');
    assert.equal(await count(db, 'select 1 from public.place_photos where place_id=$1', [place]), 10);
    await run(db, asUser(2), 'delete from public.place_photos where place_id=$1 and position=0', [place]);
    await photo(db, 2, place, 10);
    assert.equal(await count(db, 'select 1 from public.place_photos where place_id=$1', [place]), 10);
  } finally { await db.close(); }
});

test('V023: 기존 데이터 보존·중복 적용 차단·rollback 후 구조 원복·재적용', async () => {
  const db = await newDb({ public: true });
  try {
    await addUsers(db, 1);
    const room = await createRoom(db, 1);
    const [p] = await run(db, asUser(1), "insert into public.places(couple_id,name,category,created_by) values ($1,'기존 장소','기타',$2) returning id", [room, uid(1)]);
    for (let n = 0; n < 11; n++) await photo(db, 1, p.id, n);
    const before = await snapshot(db);
    await db.exec(SQL('stability.sql'));
    assert.equal(await count(db, 'select 1 from public.place_photos'), 11);
    await expectError(photo(db, 1, p.id, 11), 'photo_limit');
    await assert.rejects(db.exec(SQL('stability.sql')), /already_applied/);
    await db.exec('rollback');
    await db.exec(SQL('stability_rollback.sql'));
    assert.deepEqual(await snapshot(db), before);
    assert.equal(await count(db, 'select 1 from public.place_photos'), 11);
    await db.exec(SQL('stability.sql'));
  } finally { await db.close(); }
});
