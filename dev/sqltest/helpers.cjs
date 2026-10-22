'use strict';
// groups.sql·colors.sql 시험 도우미: PGlite(메모리 안 Postgres)로 새 DB를 만들고, Supabase 흉내(stubs.sql) 위에
// schema.sql → friends-keepalive.sql → friends-signup.sql (→ groups.sql → colors.sql)을 실행한다. 운영·시험 Supabase에는 연결하지 않음.
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

// groups: groups.sql까지, colors: 그 위에 colors.sql까지 (colors는 groups가 있어야 함)
async function newDb({ groups = true, colors = false } = {}) {
  const db = await PGlite.create({ extensions: { pgcrypto } });
  await db.exec(STUBS);
  await db.exec(SQL('schema.sql'));
  await db.exec(SQL('friends-keepalive.sql'));
  await db.exec(SQL('friends-signup.sql'));
  if (groups) await db.exec(SQL('groups.sql'));
  if (groups && colors) await db.exec(SQL('colors.sql'));
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

// 적용 전후 비교용: public 스키마의 함수(본문·권한)·제약·인덱스·칸·트리거·정책·표/칸 권한
async function snapshot(db) {
  const q = async (sql) => (await db.query(sql)).rows.map((r) => Object.values(r).join(' | '));
  return {
    functions: await q(`select p.oid::regprocedure::text, pg_get_functiondef(p.oid),
                               coalesce((select string_agg(a::text, ',' order by a::text) from unnest(p.proacl) a), '')
                        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                        where n.nspname = 'public' order by 1`),
    constraints: await q(`select conrelid::regclass::text, conname, pg_get_constraintdef(oid) from pg_constraint
                          where connamespace = 'public'::regnamespace order by 1, 2`),
    indexes: await q("select tablename, indexname, indexdef from pg_indexes where schemaname = 'public' order by 1, 2"),
    columns: await q(`select table_name, column_name, data_type, is_nullable, coalesce(column_default, '')
                      from information_schema.columns where table_schema = 'public' order by 1, ordinal_position`),
    triggers: await q("select tgrelid::regclass::text, tgname from pg_trigger where not tgisinternal order by 1, 2"),
    policies: await q("select schemaname, tablename, policyname, cmd, coalesce(qual, ''), coalesce(with_check, '') from pg_policies order by 1, 2, 3"),
    tableAcl: await q(`select c.relname, coalesce((select string_agg(a::text, ',' order by a::text) from unnest(c.relacl) a), '')
                       from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' order by 1`),
    columnAcl: await q(`select c.relname, a.attname, coalesce((select string_agg(x::text, ',' order by x::text) from unnest(a.attacl) x), '')
                        from pg_attribute a join pg_class c on c.oid = a.attrelid
                        where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' and a.attnum > 0 and not a.attisdropped
                          and a.attacl is not null order by 1, 2`),
  };
}

module.exports = {
  ROOT, SQL, uid, newDb, addUsers, run, asUser, ANON, SERVICE, expectError,
  createRoom, codeOf, join, members, count, snapshot,
};
