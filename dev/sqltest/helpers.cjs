'use strict';
// groups.sql 시험 도우미: PGlite(메모리 안 Postgres)로 새 DB를 만들고, Supabase 흉내(stubs.sql) 위에
// schema.sql → friends-keepalive.sql → friends-signup.sql (→ groups.sql)을 실행한다. 운영·시험 Supabase에는 연결하지 않음.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');
const { pgcrypto } = require('@electric-sql/pglite/contrib/pgcrypto');

const ROOT = path.resolve(__dirname, '..', '..');
const SQL = (name) => fs.readFileSync(path.join(ROOT, 'supabase', name), 'utf8');
const STUBS = fs.readFileSync(path.join(__dirname, 'stubs.sql'), 'utf8');

// 시험용 사용자 id: n번 → 00000000-0000-4000-8000-00000000000n
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

async function newDb({ groups = true } = {}) {
  const db = await PGlite.create({ extensions: { pgcrypto } });
  await db.exec(STUBS);
  await db.exec(SQL('schema.sql'));
  await db.exec(SQL('friends-keepalive.sql'));
  await db.exec(SQL('friends-signup.sql'));
  if (groups) await db.exec(SQL('groups.sql'));
  return db;
}

async function addUsers(db, ...ns) {
  for (const n of ns) {
    await db.query('insert into auth.users (id, email) values ($1, $2) on conflict do nothing', [uid(n), `u${n}@example.invalid`]);
  }
}

// who: null(= superuser postgres) | { role: 'anon'|'authenticated'|'service_role', uid?: string }
// 한 문장을 그 역할로 실행(트랜잭션 안에서 set local role, request.jwt.claim.sub). 실패하면 되돌리고 오류를 다시 던짐
async function run(db, who, sql, params = []) {
  if (!who) return (await db.query(sql, params)).rows;
  await db.exec('begin');
  try {
    await db.query("select set_config('request.jwt.claim.sub', $1, true)", [who.uid || '']);
    await db.exec(`set local role ${who.role}`);
    const r = await db.query(sql, params);
    await db.exec('commit');
    return r.rows;
  } catch (e) {
    await db.exec('rollback');
    throw e;
  }
}

const asUser = (n) => ({ role: 'authenticated', uid: uid(n) });
const ANON = { role: 'anon' };
const SERVICE = { role: 'service_role' };

// 오류 메시지가 pattern(문자열이면 그대로 포함, 정규식이면 일치)이어야 함
async function expectError(promise, pattern) {
  let err;
  try { await promise; } catch (e) { err = e; }
  assert.ok(err, `오류가 나야 하는데 성공함 (기대: ${pattern})`);
  if (pattern instanceof RegExp) assert.match(err.message, pattern);
  else assert.equal(err.message, pattern);
  return err;
}

// ---------- 자주 쓰는 동작 ----------
async function createRoom(db, n, name = '방', nick = `n${n}`) {
  const [r] = await run(db, asUser(n), 'select public.create_couple($1, $2) as id', [nick, name]);
  return r.id;
}
async function codeOf(db, room) {
  const [r] = await db.query('select invite_code from public.couples where id = $1', [room]).then((x) => x.rows);
  return r && r.invite_code;
}
async function join(db, n, code, nick = `n${n}`) {
  const [r] = await run(db, SERVICE, 'select public.join_couple_for($1, $2, $3) as id', [uid(n), code, nick]);
  return r.id;
}
async function members(db, room) {
  return (await db.query('select user_id, role, color, display_name, created_at from public.couple_members where couple_id = $1 order by created_at, user_id', [room])).rows;
}
async function count(db, sql, params = []) {
  const [r] = (await db.query(`select count(*)::int as n from (${sql}) x`, params)).rows;
  return r.n;
}

module.exports = {
  ROOT, SQL, uid, newDb, addUsers, run, asUser, ANON, SERVICE, expectError,
  createRoom, codeOf, join, members, count,
};
