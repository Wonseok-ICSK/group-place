// deploy/home/signup.cjs 테스트 (가짜 Supabase로). 실행: node --test "deploy/home/*.test.cjs"
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const s = require('./signup.cjs');

const SUPA = 'https://abcdefghijklmnopqrst.supabase.co';
const PUB = 'sb_publishable_testtesttesttest';
const SECRET = 'sb_secret_testsecretsecretsecret';
const DOMAIN = 'id.example.com';
const ORIGIN = 'https://places.example.com';
const INVITE = 'W23456789';
const SPACE = 'ABCDEF12';
const ROOM_A = 'aaaaaaaa-0000-4000-8000-00000000000a'; // SPACE 코드의 방 id
const ROOM_FULL = 'ffffffff-0000-4000-8000-00000000000f'; // FFFF0000: 이미 5명
const PW = 'correct-horse-9';
const ACK = 1; // public.sql public_ack_version()
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
// 가짜 로그인 토큰: JWT처럼 점 세 조각
const tokenOf = (id) => `at.${id}.sig`;
const idOfBearer = (h) => (/^Bearer at\.([^.]+)\.sig$/.exec(String(h || '')) || [])[1] || '';

// ---------- 가짜 요청·응답 ----------
function fakeReq({ method = 'POST', body, raw, headers = {}, ip = '203.0.113.7' } = {}) {
  const r = new Readable({ read() {} });
  const text = raw !== undefined ? raw : body === undefined ? '' : JSON.stringify(body);
  if (text) r.push(Buffer.from(text, 'utf8'));
  r.push(null);
  r.method = method;
  r.headers = { 'content-type': 'application/json', origin: ORIGIN, ...(ip ? { 'cf-connecting-ip': ip } : {}), ...headers };
  r.socket = { remoteAddress: '127.0.0.1' };
  return r;
}
function fakeRes() {
  return {
    status: 0, headers: {}, text: '', headersSent: false,
    writeHead(status, h) { this.status = status; Object.assign(this.headers, h); this.headersSent = true; },
    end(b) { this.text = b ? String(b) : ''; },
    get json() { return this.text ? JSON.parse(this.text) : null; },
  };
}

// ---------- 가짜 Supabase ----------
// invites: 코드 → 'open' | 'claimed' | 'used:<id>' | 'revoked' | 'expired'
// spaces: 방 코드 → { id, n(멤버 수), deleting(마지막 멤버가 지우는 중), pub(공개 방), name }
// members: user id → Set<방 id> (groups.sql: 한 사람이 방 3개까지)
// over: { '<METHOD> <경로>': (c, db, base) => 응답 } 로 바꿔 끼움 (base는 원래 동작)
function fakeSupabase({ over = {} } = {}) {
  const db = {
    invites: new Map([[INVITE, 'open'], ['W33333333', 'revoked'], ['W44444444', 'expired']]),
    spaces: new Map([[SPACE, { id: ROOM_A, n: 1, deleting: false }], ['FFFF0000', { id: ROOM_FULL, n: 5, deleting: false }]]),
    acks: [], // 공개 방 동의 기록 { user, room, version }
    users: new Map(), // id → { email, password, meta, app }
    members: new Map(),
    seq: 0,
    // 방 하나 더 (멤버 n명, 그중 누구도 테스트 사용자는 아님) → 방 id. pub이면 공개 방(이름 name)
    addRoom(code, n = 1, { pub = false, name = '' } = {}) {
      const id = `00000000-0000-4000-9000-${code.toLowerCase().padStart(12, '0')}`;
      this.spaces.set(code, { id, n, deleting: false, pub, name });
      return id;
    },
    // 테스트 사용자를 그 코드의 방에 넣음 (없는 방이면 만듦)
    addMember(userId, code) {
      if (!this.spaces.has(code)) this.addRoom(code, 0);
      const room = this.spaces.get(code);
      room.n++;
      const mine = this.members.get(userId) || new Set();
      mine.add(room.id);
      this.members.set(userId, mine);
      return room.id;
    },
    codeOf(roomId) {
      for (const [code, room] of this.spaces) if (room.id === roomId) return code;
      return '';
    },
  };
  const calls = [];
  const isAdmin = (h) => h.apikey === SECRET && h.authorization === `Bearer ${SECRET}`;
  const deny = { status: 401, body: { message: 'Invalid API key' } };
  const raise = (message) => ({ status: 400, body: { code: 'P0001', message } });
  const routes = {
    'GET /auth/v1/admin/users': (c) => (isAdmin(c.headers) ? { status: 200, body: { users: [] } } : deny),
    'POST /rest/v1/rpc/claim_signup_invite': (c) => {
      if (!isAdmin(c.headers)) return deny;
      if (db.invites.get(c.body.p_code) !== 'open') return { status: 200, body: false };
      db.invites.set(c.body.p_code, 'claimed');
      return { status: 200, body: true };
    },
    'POST /rest/v1/rpc/release_signup_invite': (c) => {
      if (!isAdmin(c.headers)) return deny;
      if (db.invites.get(c.body.p_code) !== 'claimed') return { status: 200, body: false };
      db.invites.set(c.body.p_code, 'open');
      return { status: 200, body: true };
    },
    'POST /rest/v1/rpc/finish_signup_invite': (c) => {
      if (!isAdmin(c.headers)) return deny;
      if (db.invites.get(c.body.p_code) !== 'claimed') return { status: 200, body: false };
      db.invites.set(c.body.p_code, `used:${c.body.p_user}`);
      return { status: 200, body: true };
    },
    'POST /rest/v1/rpc/space_code_open': (c) => {
      if (!isAdmin(c.headers)) return deny;
      const room = db.spaces.get(c.body.p_code);
      return { status: 200, body: !!room && room.n < 5 && !room.deleting };
    },
    'POST /rest/v1/rpc/groups_schema_version': (c) => (isAdmin(c.headers) ? { status: 200, body: 1 } : deny),
    'POST /rest/v1/rpc/public_rooms_version': (c) => (isAdmin(c.headers) ? { status: 200, body: 1 } : deny),
    // public.sql §2.6: 공개 방이고 열려 있을 때만 방 이름
    'POST /rest/v1/rpc/space_code_info': (c) => {
      if (!isAdmin(c.headers)) return deny;
      const room = db.spaces.get(c.body.p_code);
      const open = !!room && room.n < 5 && !room.deleting;
      const pub = !!room && !!room.pub;
      return { status: 200, body: { open, public: pub, room_name: open && pub ? room.name : null, ack_version: ACK } };
    },
    'POST /auth/v1/admin/users': (c) => {
      if (!isAdmin(c.headers)) return deny;
      if ([...db.users.values()].some((u) => u.email === c.body.email)) {
        return { status: 422, body: { code: 422, error_code: 'email_exists', msg: 'A user with this email address has already been registered' } };
      }
      const id = c.body.id || `00000000-0000-4000-8000-${String(++db.seq).padStart(12, '0')}`;
      db.users.set(id, { email: c.body.email, password: c.body.password, confirm: c.body.email_confirm, meta: c.body.user_metadata, app: c.body.app_metadata });
      return { status: 200, body: { id, email: c.body.email } };
    },
    'POST /auth/v1/token': (c) => {
      if (c.headers.apikey !== PUB || c.headers.authorization) return deny;
      const hit = [...db.users.entries()].find(([, u]) => u.email === c.body.email && u.password === c.body.password);
      if (!hit) return { status: 400, body: { error_code: 'invalid_credentials' } };
      return { status: 200, body: { access_token: tokenOf(hit[0]), refresh_token: `rt-${hit[0]}`, token_type: 'bearer' } };
    },
    'GET /auth/v1/user': (c) => {
      if (c.headers.apikey !== PUB) return deny;
      const id = idOfBearer(c.headers.authorization);
      if (!db.users.has(id)) return { status: 403, body: { error_code: 'bad_jwt', msg: 'invalid JWT' } };
      return { status: 200, body: { id, email: db.users.get(id).email } };
    },
    // 친구용 DB에서는 앱(authenticated)이 직접 못 부름 (friends-signup.sql)
    'POST /rest/v1/rpc/join_couple': () => ({ status: 401, body: { code: '42501', message: 'permission denied for function join_couple' } }),
    // groups.sql §2.5.1 순서: 사용자 → 닉네임 → 코드(지우는 중인 방은 없는 코드) → 이미 그 방이면 같은 id → 방 3개 → 5명
    'POST /rest/v1/rpc/join_couple_for': (c) => {
      if (!isAdmin(c.headers)) return deny;
      const id = c.body.p_user;
      if (!id) return raise('not_authenticated');
      const name = String(c.body.p_display_name ?? '').trim();
      if (!name || [...name].length > 20) return raise('invalid_display_name');
      const room = db.spaces.get(String(c.body.p_invite_code ?? '').trim().toUpperCase());
      if (!room || room.deleting) return raise('invalid_code');
      const mine = db.members.get(id) || new Set();
      if (mine.has(room.id)) return { status: 200, body: room.id };
      if (mine.size >= 3) return raise('too_many_rooms');
      if (room.n >= 5) return raise('room_full');
      room.n++;
      mine.add(room.id);
      db.members.set(id, mine);
      return { status: 200, body: room.id };
    },
    // public.sql §2.5 순서: 사용자 → 닉네임 → 코드(지우는 중인 방은 없는 코드) → 이미 멤버 → 방 참 → 방 3개
    //   → (공개) 닉네임=아이디 → (공개) 동의(없으면 아무것도 안 바꾸고 need_ack)
    'POST /rest/v1/rpc/join_room_for': (c) => {
      if (!isAdmin(c.headers)) return deny;
      const id = c.body.p_user;
      if (!id) return raise('not_authenticated');
      const name = String(c.body.p_display_name ?? '').trim();
      if (!name || [...name].length > 20) return raise('invalid_display_name');
      const room = db.spaces.get(String(c.body.p_invite_code ?? '').trim().toUpperCase());
      if (!room || room.deleting) return raise('invalid_code');
      const mine = db.members.get(id) || new Set();
      const pub = !!room.pub;
      if (mine.has(room.id)) return { status: 200, body: { status: 'already_member', couple_id: room.id, public: pub } };
      if (room.n >= 5) return raise('room_full');
      if (mine.size >= 3) return raise('too_many_rooms');
      if (pub) {
        const u = db.users.get(id) || {};
        const loginId = (u.app && u.app.username) || String(u.email || '').split('@')[0];
        if (loginId && name.toLowerCase() === loginId.toLowerCase()) return raise('nickname_is_login_id');
        if (c.body.p_ack_version !== ACK) {
          return { status: 200, body: { status: 'need_ack', couple_id: null, public: true, room_name: room.name, ack_version: ACK } };
        }
        db.acks.push({ user: id, room: room.id, version: c.body.p_ack_version });
      }
      room.n++;
      mine.add(room.id);
      db.members.set(id, mine);
      return { status: 200, body: { status: 'joined', couple_id: room.id, public: pub } };
    },
    // PostgREST처럼: 끼워 넣은 표(couples)의 조건은 !inner일 때만 부모 줄(couple_members)을 거른다
    'GET /rest/v1/couple_members': (c) => {
      if (!isAdmin(c.headers)) return deny;
      const q = new URL(`${SUPA}${c.path}`).searchParams;
      const id = (q.get('user_id') || '').replace(/^eq\./, '');
      const want = q.has('couples.invite_code') ? q.get('couples.invite_code').replace(/^eq\./, '') : null;
      const inner = /couples!inner\(/.test(q.get('select') || '');
      const rows = [];
      for (const roomId of db.members.get(id) || []) {
        const code = db.codeOf(roomId);
        if (want === null || code === want) rows.push({ couple_id: roomId, couples: { invite_code: code } });
        else if (!inner) rows.push({ couple_id: roomId, couples: null });
      }
      return { status: 200, body: rows };
    },
    'DELETE /auth/v1/admin/users/:id': (c) => {
      if (!isAdmin(c.headers)) return deny;
      const id = decodeURIComponent(c.path.split('?')[0].split('/').pop());
      const had = db.users.delete(id);
      // 계정을 지우면 방 멤버(on delete cascade)와 코드의 used_by(on delete set null)도 같이 정리됨
      for (const roomId of db.members.get(id) || []) db.spaces.get(db.codeOf(roomId)).n--;
      db.members.delete(id);
      for (const [code, st] of db.invites) if (st === `used:${id}`) db.invites.set(code, 'claimed');
      return { status: had ? 200 : 404, body: {} };
    },
  };
  async function fetchImpl(url, init = {}) {
    const u = new URL(url);
    assert.equal(u.origin, SUPA, '프로젝트 주소로만 보냄');
    assert.equal(init.redirect, 'error');
    const method = init.method || 'GET';
    const c = { method, path: u.pathname + u.search, headers: init.headers || {}, body: init.body ? JSON.parse(init.body) : undefined };
    calls.push(c);
    let key = `${method} ${u.pathname}`;
    if (method === 'DELETE' && u.pathname.startsWith('/auth/v1/admin/users/')) key = 'DELETE /auth/v1/admin/users/:id';
    const base = routes[key];
    const h = (key in over ? over[key] : null) || base;
    if (!h) return respond({ status: 404, body: { message: 'no route' } });
    return respond(await h(c, db, base));
  }
  function respond(out) {
    return { ok: out.status >= 200 && out.status < 300, status: out.status, text: async () => (out.body === undefined ? '' : JSON.stringify(out.body)) };
  }
  return { db, calls, fetchImpl, paths: () => calls.map((c) => `${c.method} ${c.path.split('?')[0]}`) };
}

function setup({ over, clock } = {}) {
  const sb = fakeSupabase({ over });
  const logs = [];
  const t = { now: 1_000_000_000_000 };
  const api = s.createSignupApi({
    supabaseUrl: SUPA, publishableKey: PUB, secretKey: SECRET, idDomain: DOMAIN, allowedOrigin: ORIGIN,
    fetchImpl: sb.fetchImpl, now: clock || (() => t.now), log: (m) => logs.push(String(m)),
    accountLimits: { perIp: 3 }, // 아래 시험들은 IP마다 하루 3개로 세는 방식을 확인한다(실제 기본값은 6)
  });
  const seen = [];
  async function post(body, opts = {}) {
    const res = fakeRes();
    await api.signup(fakeReq({ body, ...opts }), res);
    seen.push(res.text);
    return res;
  }
  // 앱 안에서 참여: token이 있으면 Authorization: Bearer <token>
  async function join(body, { token, headers = {}, ...opts } = {}) {
    const res = fakeRes();
    await api.join(fakeReq({ body, ...opts, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers } }), res);
    seen.push(res.text);
    return res;
  }
  // 로그인한 친구 (방은 sb.db.addMember로 넣음)
  function seedUser(id = '11111111-2222-4333-8444-555555555555', email = `friend@${DOMAIN}`) {
    sb.db.users.set(id, { email, password: PW });
    return { id, token: tokenOf(id) };
  }
  return { sb, logs, t, api, handler: api.signup, post, join, seedUser, seen };
}
const form = (over = {}) => ({ code: INVITE, username: 'minsu', password: PW, displayName: '민수', ...over });
const joinForm = (over = {}) => ({ code: SPACE, displayName: '민수', ...over });

// ---------- 입력 확인·정리 ----------
test('코드·아이디 정리', () => {
  assert.equal(s.normalizeCode(' w-2345 6789 '), 'W23456789');
  assert.equal(s.normalizeCode('abcd-ef12'), 'ABCDEF12');
  const a = s.validate(form({ code: 'w-2345-6789', username: '  MinSu ', displayName: '  민수 ' }));
  assert.deepEqual(a, { kind: 'invite', code: 'W23456789', username: 'minsu', password: PW, displayName: '민수', ackVersion: null });
  const b = s.validate(form({ code: 'abcd ef12' }));
  assert.equal(b.kind, 'space');
  assert.equal(b.code, 'ABCDEF12');
  assert.equal(s.validate(form({ username: 'a.b_c-9' })).username, 'a.b_c-9');
  assert.deepEqual(s.validateJoin({ code: ' abcd-ef12 ', displayName: ' 민수 ' }), { code: SPACE, displayName: '민수', ackVersion: null });
  assert.deepEqual(s.validateJoin({ code: 'W-2345-6789', displayName: '민수' }), { error: s.MSG.spaceCode });
  assert.deepEqual(s.validateJoin({ code: SPACE, displayName: ' ' }), { error: s.MSG.displayName });
  for (const body of [null, [], { code: SPACE }, { code: 1, displayName: 'x' }]) assert.ok(s.validateJoin(body).error, JSON.stringify(body));
});

test('잘못된 입력은 400 문구', () => {
  const bad = [
    [{ code: 'W1234567' }, s.MSG.codeFormat], // 1은 가입 코드에 없는 글자, 길이도 모자람
    [{ code: 'W2345678I' }, s.MSG.codeFormat],
    [{ code: 'ABCDEF1' }, s.MSG.codeFormat],
    [{ code: 'ABCDEFG1' }, s.MSG.codeFormat], // 16진수가 아님
    [{ code: '' }, s.MSG.codeFormat],
    [{ username: 'ab' }, s.MSG.username],
    [{ username: 'minsu@gmail.com' }, s.MSG.username],
    [{ username: 'min+su' }, s.MSG.username],
    [{ username: '_minsu' }, s.MSG.username],
    [{ username: 'min..su' }, s.MSG.username],
    [{ username: 'minsu.' }, s.MSG.username],
    [{ username: '민수' }, s.MSG.username],
    [{ username: 'a'.repeat(21) }, s.MSG.username],
    [{ password: '1234567' }, s.MSG.password],
    [{ password: 'a'.repeat(73) }, s.MSG.password],
    [{ password: '가'.repeat(25) }, s.MSG.password], // 25자지만 75바이트
    [{ displayName: '   ' }, s.MSG.displayName],
    [{ displayName: '가'.repeat(21) }, s.MSG.displayName],
    [{ displayName: '민\u0000수' }, s.MSG.displayName],
    // 보이지 않는 글자·방향 바꾸는 글자 (아이디처럼 보이는 닉네임, 뒤집힌 이름)
    [{ displayName: 'min\u200bji92' }, s.MSG.displayName],
    [{ displayName: '민\u202e수' }, s.MSG.displayName],
    [{ displayName: '민\u2066수' }, s.MSG.displayName],
    [{ displayName: '민\ufeff수' }, s.MSG.displayName], // 앞뒤의 U+FEFF는 trim()이 지움
    [{ displayName: '민\n수' }, s.MSG.displayName],
  ];
  for (const [over, msg] of bad) assert.deepEqual(s.validate(form(over)), { error: msg }, JSON.stringify(over));
  assert.ok(s.validate(form({ password: 'a'.repeat(72) })).kind);
  assert.ok(s.validate(form({ displayName: '😀'.repeat(20) })).kind); // 글자 수는 코드 포인트로
  for (const body of [null, [], 'x', { ...form(), code: 1 }, { code: INVITE }]) {
    assert.ok(s.validate(body).error, JSON.stringify(body));
  }
});

test('IP 단위: IPv4는 하나, IPv6는 /64', () => {
  assert.equal(s.ipKey('203.0.113.7'), '203.0.113.7');
  assert.equal(s.ipKey('::ffff:203.0.113.7'), '203.0.113.7');
  assert.equal(s.ipKey('2001:db8:1:2:3:4:5:6'), s.ipKey('2001:0db8:0001:0002::9'));
  assert.notEqual(s.ipKey('2001:db8:1:2::1'), s.ipKey('2001:db8:1:3::1'));
  assert.equal(s.ipKey('::1'), '0:0:0:0::/64');
  assert.equal(s.clientIp({ headers: { 'cf-connecting-ip': ' 198.51.100.1 ' }, socket: { remoteAddress: '127.0.0.1' } }), '198.51.100.1');
  assert.equal(s.clientIp({ headers: { 'cf-connecting-ip': 'nope<script>' }, socket: { remoteAddress: '127.0.0.1' } }), '127.0.0.1');
  assert.equal(s.clientIp({ headers: {}, socket: { remoteAddress: '::1' } }), '::1');
});

// ---------- 시도 횟수 제한 ----------
test('제한: IP마다 1시간 5번, 전체 30번, 1시간 지나면 풀림', () => {
  let now = 0;
  const take = s.createLimiter({ now: () => now });
  for (let i = 0; i < 5; i++) assert.equal(take('a').ok, true);
  const sixth = take('a');
  assert.equal(sixth.ok, false);
  assert.equal(sixth.scope, 'ip');
  assert.equal(sixth.retryAfter, 3600);
  assert.equal(take('b').ok, true); // 다른 IP는 따로
  now = 3600_000 - 1;
  assert.equal(take('a').ok, false);
  now = 3600_000;
  assert.equal(take('a').ok, true); // 첫 시도가 1시간 지나 빠짐
  // 전체 30번
  let t2 = 0;
  const take2 = s.createLimiter({ now: () => t2 });
  for (let i = 0; i < 30; i++) { t2 = i * 1000; assert.equal(take2(`ip${i}`).ok, true); }
  const over = take2('new-ip');
  assert.equal(over.ok, false);
  assert.equal(over.scope, 'global');
  assert.equal(over.retryAfter, 3600 - 29);
  t2 = 3600_000;
  assert.equal(take2('new-ip').ok, true);
});

test('제한: refund는 그 한 번만 빼고(두 번 불러도 한 번), IP·전체 둘 다에서 뺌', () => {
  const take = s.createLimiter({ now: () => 0, perIp: 2, total: 3 });
  const first = take('a');
  first.refund();
  first.refund();
  assert.equal(take('a').ok, true);
  assert.equal(take('a').ok, true);
  assert.equal(take('a').scope, 'ip');
  assert.equal(take('b').ok, true);
  assert.equal(take('c').scope, 'global');
});

test('요청: 같은 IP 6번째는 429 + Retry-After, 결과와 상관없이 셈, 형식이 틀린 요청은 안 셈', async () => {
  const { post, sb, t } = setup();
  for (let i = 0; i < 10; i++) assert.equal((await post(form({ code: 'nope' }))).status, 400); // 형식 오류: 안 셈
  for (let i = 0; i < 5; i++) {
    const r = await post(form({ code: 'W9999999A', username: `user${i}` })); // 없는 코드: 셈
    assert.equal(r.status, 400);
    assert.equal(r.json.error, s.MSG.badCode);
  }
  const sixth = await post(form());
  assert.equal(sixth.status, 429);
  assert.equal(sixth.headers['retry-after'], '3600');
  assert.match(sixth.json.error, /시도가 너무 많아요. 60분 뒤에/);
  assert.equal(sb.db.invites.get(INVITE), 'open'); // 막힌 요청은 Supabase까지 가지 않음
  assert.equal((await post(form(), { ip: '198.51.100.9' })).status, 200); // 다른 IP는 됨
  t.now += 3600_000;
  assert.equal((await post(form({ code: SPACE, username: 'partner' }))).status, 200); // 1시간 뒤 풀림
});

test('요청: 전체 1시간 30번', async () => {
  const { post } = setup();
  for (let i = 0; i < 30; i++) assert.equal((await post(form({ code: 'W9999999A' }), { ip: `198.51.100.${i}` })).status, 400);
  const r = await post(form(), { ip: '192.0.2.1' });
  assert.equal(r.status, 429);
  assert.ok(Number(r.headers['retry-after']) > 0);
});

test('cf-connecting-ip가 없으면 소켓 주소로 셈', async () => {
  const { post } = setup();
  for (let i = 0; i < 5; i++) await post(form({ code: 'W9999999A' }), { ip: '' });
  assert.equal((await post(form(), { ip: '' })).status, 429);
});

test('성공은 코드 맞히기 횟수에 안 셈: 같은 IP에서 가입 3번 200, 4번째는 계정 제한 429, 코드 맞히기는 5번 그대로 남음', async () => {
  const { post, join, seedUser, sb, logs, t } = setup();
  const u = seedUser();
  sb.db.invites.set('W55555555', 'open');
  sb.db.addRoom('B0000001', 1);
  const codes = [INVITE, SPACE, 'B0000001'];
  for (const [i, code] of codes.entries()) {
    const r = await post(form({ code, username: `user${i}` }));
    assert.equal(r.status, 200, `성공 ${i}`);
  }
  const before = sb.calls.length;
  const fourth = await post(form({ code: 'W55555555', username: 'user3' }));
  assert.equal(fourth.status, 429);
  assert.match(fourth.json.error, /시도가 너무 많아요/);
  assert.equal(sb.calls.length, before); // 막힌 가입은 Supabase까지 가지 않음
  assert.equal(sb.db.invites.get('W55555555'), 'open');
  assert.ok(logs.includes('signup invite limited:account_ip'));
  assert.equal((await post(form({ code: 'W9999999A', username: 'guess' }))).status, 429); // 오늘은 이 IP에서 가입이 막힘
  // 코드 맞히기 횟수(참여와 나눠 씀)는 하나도 안 썼음: 틀린 코드 5번까지 400, 6번째 429
  for (let i = 0; i < 5; i++) assert.equal((await join(joinForm({ code: '99999999' }), { token: u.token })).status, 400);
  assert.equal((await join(joinForm({ code: '99999999' }), { token: u.token })).status, 429);
  assert.equal(logs.filter((l) => / ok$/.test(l)).length, 3);
  t.now += 24 * 3600_000; // 하루 지나면 둘 다 풀림
  assert.equal((await post(form({ code: 'W55555555', username: 'user4' }))).status, 200);
});

test('계정 제한: 방 코드 가입→나가기를 되풀이해도 같은 IP에서 4번째 계정은 429', async () => {
  const { post, sb, logs } = setup();
  for (let i = 0; i < 3; i++) {
    assert.equal((await post(form({ code: SPACE, username: `loop${i}` }))).status, 200, `가입 ${i}`);
    sb.db.spaces.get(SPACE).n = 1; // 새 계정이 leave_room으로 나간 셈: 자리는 다시 빔
  }
  const r = await post(form({ code: SPACE, username: 'loop3' }));
  assert.equal(r.status, 429);
  assert.equal(sb.db.users.size, 3);
  assert.ok(logs.includes('signup space limited:account_ip'));
  assert.equal((await post(form({ code: SPACE, username: 'other' }), { ip: '198.51.100.77' })).status, 200); // 다른 IP는 됨
});

test('계정 제한: IP가 달라도 전체 하루 20개까지 (성공은 코드 맞히기 전체 30번에는 안 셈)', async () => {
  const { post, sb, logs } = setup();
  for (let r = 0; r < 5; r++) sb.db.addRoom(`D000000${r}`, 0);
  for (let i = 0; i < 20; i++) {
    const code = `D000000${Math.floor(i / 4)}`;
    assert.equal((await post(form({ code, username: `many${i}` }), { ip: `198.51.100.${i}` })).status, 200, `가입 ${i}`);
  }
  sb.db.addRoom('D0000009', 0);
  const r = await post(form({ code: 'D0000009', username: 'many20' }), { ip: '192.0.2.1' });
  assert.equal(r.status, 429);
  assert.ok(logs.includes('signup space limited:account_global'));
  assert.equal(sb.db.users.size, 20);
});

test('계정 제한: 실패(틀린 코드·약한 비밀번호·닉네임 거절·찬 방)로 계정이 안 남으면 안 셈', async () => {
  const { post, sb } = setup();
  for (let i = 0; i < 4; i++) assert.equal((await post(form({ code: 'W9999999A', username: `bad${i}` }))).status, 400);
  // 코드 맞히기는 4번 썼지만 계정 수는 0: 다른 IP에서 계정 3개는 그대로 됨
  for (let i = 0; i < 3; i++) assert.equal((await post(form({ code: SPACE, username: `ok${i}` }), { ip: '198.51.100.5' })).status, 200);
  assert.equal(sb.db.users.size, 3);
  const weak = setup({ over: { 'POST /auth/v1/admin/users': () => ({ status: 422, body: { error_code: 'weak_password', msg: 'x' } }) } });
  for (let i = 0; i < 4; i++) assert.equal((await weak.post(form({ code: SPACE }))).status, 400);
  assert.equal((await weak.post(form({ code: 'W9999999A' }))).status, 400); // 약한 비밀번호 4번 뒤에도 429 아님
});

test('제한: 성공은 전체 30번에도 들어가지 않음', async () => {
  const { post, sb } = setup();
  sb.db.addRoom('C0000001', 0);
  for (let i = 0; i < 30; i++) assert.equal((await post(form({ code: 'W9999999A' }), { ip: `198.51.100.${i}` })).status, 400);
  assert.equal((await post(form({ code: 'C0000001', username: 'late' }), { ip: '192.0.2.1' })).status, 429); // 전체가 찼음
  const fresh = setup();
  for (let i = 0; i < 4; i++) assert.equal((await fresh.post(form({ code: SPACE, username: `ok${i}` }), { ip: `198.51.100.${i}` })).status, 200);
  for (let i = 0; i < 30; i++) assert.equal((await fresh.post(form({ code: 'W9999999A' }), { ip: `203.0.113.${i}` })).status, 400);
  assert.equal((await fresh.post(form({ code: 'W9999999A' }), { ip: '192.0.2.1' })).status, 429);
});

test('코드는 맞고 아이디가 이미 있으면(409) 코드 맞히기 횟수는 안 셈, 계정 제한에는 셈(아이디 알아보기 막기)', async () => {
  const { post, join, seedUser, sb, logs } = setup();
  const u = seedUser('99999999-2222-4333-8444-555555555555', `other@${DOMAIN}`);
  sb.db.users.set('existing', { email: `minsu@${DOMAIN}`, password: 'x' });
  for (let i = 0; i < 2; i++) {
    assert.equal((await post(form())).status, 409, `가입 코드 ${i}`);
    assert.equal(sb.db.invites.get(INVITE), 'open');
  }
  assert.equal((await post(form({ code: SPACE }))).status, 409, '방 코드');
  const r = await post(form({ code: SPACE }));
  assert.equal(r.status, 429); // 계정 제한(IP마다 하루 3번)
  assert.ok(logs.includes('signup space limited:account_ip'));
  // 코드 맞히기 횟수는 그대로 남아 있음: 틀린 코드 5번까지 400, 6번째 429
  for (let i = 0; i < 5; i++) assert.equal((await join(joinForm({ code: '99999999' }), { token: u.token })).status, 400);
  assert.equal((await join(joinForm({ code: '99999999' }), { token: u.token })).status, 429);
  assert.ok(logs.includes('join limited:ip'));
  // 다른 IP에서는 중복 확인이 다시 되지만, 그 IP도 하루 3번까지
  for (let i = 0; i < 3; i++) assert.equal((await post(form(), { ip: '198.51.100.40' })).status, 409);
  assert.equal((await post(form(), { ip: '198.51.100.40' })).status, 429);
});

test('약한 비밀번호·쓸 수 없는 아이디도 횟수를 세지 않음', async () => {
  for (const errorCode of ['weak_password', 'email_address_invalid']) {
    const { post } = setup({ over: { 'POST /auth/v1/admin/users': () => ({ status: 422, body: { error_code: errorCode, msg: 'x' } }) } });
    for (let i = 0; i < 7; i++) assert.equal((await post(form())).status, 400);
    for (let i = 0; i < 5; i++) assert.equal((await post(form({ code: 'W9999999A' }))).status, 400);
    assert.equal((await post(form())).status, 429);
  }
});

// ---------- 가입 코드 ----------
test('가입 코드로 가입: 아이디 계정, 메일 인증 없음, 계정 ID는 서버가 정함, 코드는 사용됨', async () => {
  const { post, sb, logs } = setup();
  const r = await post(form({ code: 'w-2345-6789', username: 'MinSu' }));
  assert.equal(r.status, 200);
  assert.equal(r.json.joined, false);
  assert.equal(r.json.couple_id, null); // 방은 앱에서 만든다
  assert.match(r.json.access_token, /^at\./);
  assert.match(r.json.refresh_token, /^rt-/);
  assert.equal(r.headers['cache-control'], 'no-store');
  assert.equal(r.headers['x-content-type-options'], 'nosniff');
  const [id, user] = [...sb.db.users.entries()][0];
  assert.match(id, UUID_RE);
  assert.equal(sb.calls.find((c) => c.path === '/auth/v1/admin/users').body.id, id);
  assert.equal(user.email, `minsu@${DOMAIN}`);
  assert.equal(user.confirm, true);
  assert.deepEqual(user.meta, { username: 'minsu', display_name: '민수' });
  assert.deepEqual(user.app, { username: 'minsu' }); // 관리자 목록용, 본인은 못 고침
  assert.equal(sb.db.invites.get(INVITE), `used:${id}`);
  assert.deepEqual(sb.paths(), [
    'POST /rest/v1/rpc/claim_signup_invite', 'POST /auth/v1/admin/users',
    'POST /rest/v1/rpc/finish_signup_invite', 'POST /auth/v1/token',
  ]);
  assert.deepEqual(logs, ['signup invite ok']);
  // 같은 코드 두 번째: 일반 문구
  const again = await post(form({ username: 'other' }));
  assert.equal(again.status, 400);
  assert.equal(again.json.error, s.MSG.badCode);
});

test('쓸 수 없는 코드(없음·취소·만료·이미 씀·5명 찬 방·지우는 중인 방)는 모두 같은 문구', async () => {
  const { post, sb } = setup();
  sb.db.invites.set('W55555555', 'used:someone');
  sb.db.addRoom('DE1E7E00', 1);
  sb.db.spaces.get('DE1E7E00').deleting = true;
  const codes = ['W9999999A', 'W33333333', 'W44444444', 'W55555555', 'FFFF0000', 'DE1E7E00', '00000000'];
  const answers = [];
  for (const [i, code] of codes.entries()) answers.push(await post(form({ code }), { ip: `198.51.100.${i}` }));
  for (const r of answers) {
    assert.equal(r.status, 400);
    assert.deepEqual(r.json, { error: s.MSG.badCode });
  }
  assert.equal(sb.db.users.size, 0);
  assert.ok(!sb.paths().includes('POST /auth/v1/admin/users'));
});

test('가입 코드: 이미 쓰는 아이디면 409, 코드는 돌려놓음', async () => {
  const { post, sb } = setup();
  sb.db.users.set('existing', { email: `minsu@${DOMAIN}`, password: 'x' });
  const r = await post(form());
  assert.equal(r.status, 409);
  assert.equal(r.json.error, s.MSG.duplicate);
  assert.match(r.json.error, /^이미 쓰는 아이디예요/);
  assert.equal(sb.db.invites.get(INVITE), 'open');
  assert.equal(sb.db.users.size, 1);
});

test('가입 코드: 기록 실패 → 계정 지우고 코드 돌려놓음 (지우기가 먼저)', async () => {
  const { post, sb, logs } = setup({ over: { 'POST /rest/v1/rpc/finish_signup_invite': () => ({ status: 500, body: { message: 'boom' } }) } });
  const r = await post(form());
  assert.equal(r.status, 502);
  assert.equal(r.json.error, s.MSG.failed);
  assert.equal(sb.db.users.size, 0);
  assert.equal(sb.db.invites.get(INVITE), 'open');
  const p = sb.paths();
  const del = p.findIndex((x) => x.startsWith('DELETE /auth/v1/admin/users/'));
  assert.ok(del >= 0 && del < p.indexOf('POST /rest/v1/rpc/release_signup_invite'));
  assert.deepEqual(logs, ['signup invite fail:finish']);
});

test('가입 코드: 기록은 됐는데 응답이 끊김 → 계정 지우면 used_by가 비워져 코드가 돌아옴', async () => {
  const sbFinish = { calls: 0 };
  const { post, sb } = setup({
    over: {
      'POST /rest/v1/rpc/finish_signup_invite': (c, db) => {
        sbFinish.calls++;
        db.invites.set(c.body.p_code, `used:${c.body.p_user}`);
        throw new Error('socket hang up');
      },
    },
  });
  const r = await post(form());
  assert.equal(r.status, 502);
  assert.equal(sbFinish.calls, 1);
  assert.equal(sb.db.users.size, 0);
  assert.equal(sb.db.invites.get(INVITE), 'open');
});

test('가입 코드: 로그인 실패 → 계정 지우고 코드 돌려놓음', async () => {
  const { post, sb, logs } = setup({ over: { 'POST /auth/v1/token': () => ({ status: 500, body: {} }) } });
  const r = await post(form());
  assert.equal(r.status, 502);
  assert.equal(sb.db.users.size, 0);
  assert.equal(sb.db.invites.get(INVITE), 'open');
  assert.deepEqual(logs, ['signup invite fail:signin']);
});

test('가입 코드: 계정 만들기 연결 실패(안 만들어짐) → 지워 보고(404) 코드 돌려놓음', async () => {
  const { post, sb, logs } = setup({ over: { 'POST /auth/v1/admin/users': () => { throw new Error('ECONNRESET'); } } });
  const r = await post(form());
  assert.equal(r.status, 502);
  assert.equal(sb.db.invites.get(INVITE), 'open');
  assert.ok(sb.paths().includes('POST /rest/v1/rpc/release_signup_invite'));
  assert.deepEqual(logs, ['signup invite fail:create']);
});

test('가입 코드: 계정은 만들어졌는데 응답이 끊김 → 미리 정한 ID로 지우고 코드 돌려놓음, 다시 하면 됨', async () => {
  let n = 0;
  const { post, sb } = setup({
    over: {
      'POST /auth/v1/admin/users': (c, db, base) => {
        const out = base(c);
        if (n++ === 0) throw new Error('timeout'); // 첫 번째: 만들어졌지만 응답을 못 받음
        return out;
      },
    },
  });
  const r = await post(form());
  assert.equal(r.status, 502);
  assert.equal(sb.db.users.size, 0); // 남은 계정 없음
  assert.equal(sb.db.invites.get(INVITE), 'open');
  const again = await post(form()); // 같은 아이디로 다시: '이미 쓰는 아이디'가 아님
  assert.equal(again.status, 200);
  assert.equal(sb.db.users.size, 1);
});

test('가입 코드: 응답이 끊겼고 계정 지우기도 실패 → 코드를 돌려놓지 않음 (코드 하나에 계정 둘 막기)', async () => {
  const { post, sb, logs } = setup({
    over: {
      'POST /auth/v1/admin/users': (c, db, base) => { base(c); throw new Error('timeout'); },
      'DELETE /auth/v1/admin/users/:id': () => ({ status: 500, body: {} }),
    },
  });
  const r = await post(form());
  assert.equal(r.status, 502);
  assert.equal(sb.db.invites.get(INVITE), 'claimed');
  assert.ok(!sb.paths().includes('POST /rest/v1/rpc/release_signup_invite'));
  assert.deepEqual(logs, ['signup cleanup fail:delete_user', 'signup cleanup skipped:release', 'signup invite fail:create']);
});

test('가입 코드: 약한 비밀번호·쓸 수 없는 아이디는 400, 코드 돌려놓음', async () => {
  for (const [errorCode, msg] of [['weak_password', s.MSG.weak], ['email_address_invalid', s.MSG.invalidId]]) {
    const { post, sb } = setup({ over: { 'POST /auth/v1/admin/users': () => ({ status: 422, body: { error_code: errorCode, msg: 'x' } }) } });
    const r = await post(form());
    assert.equal(r.status, 400);
    assert.equal(r.json.error, msg);
    assert.equal(sb.db.invites.get(INVITE), 'open');
  }
});

test('가입 코드: claim 자체가 실패(SQL 없음 등)하면 502, 계정은 안 만듦', async () => {
  const { post, sb } = setup({ over: { 'POST /rest/v1/rpc/claim_signup_invite': () => ({ status: 404, body: { code: 'PGRST202' } }) } });
  const r = await post(form());
  assert.equal(r.status, 502);
  assert.equal(sb.db.users.size, 0);
});

// ---------- 방 코드로 가입 ----------
test('방 코드로 가입: 바로 그 방에 들어감 (secret key로 join_room_for, 그 사람 ID로), 응답에 방 id', async () => {
  const { post, sb, logs } = setup();
  sb.db.spaces.get(SPACE).n = 4;
  const r = await post(form({ code: 'abcd-ef12', username: 'partner', displayName: '지훈' }));
  assert.equal(r.status, 200);
  assert.equal(r.json.joined, true);
  assert.equal(r.json.couple_id, ROOM_A);
  assert.equal(sb.db.spaces.get(SPACE).n, 5);
  assert.deepEqual(sb.paths(), [
    'POST /rest/v1/rpc/space_code_info', 'POST /auth/v1/admin/users', 'POST /auth/v1/token', 'POST /rest/v1/rpc/join_room_for',
  ]);
  const [id] = [...sb.db.users.keys()];
  const join = sb.calls.find((c) => c.path === '/rest/v1/rpc/join_room_for');
  assert.deepEqual(join.body, { p_user: id, p_invite_code: SPACE, p_display_name: '지훈', p_ack_version: null });
  assert.equal(join.headers.apikey, SECRET);
  assert.deepEqual(logs, ['signup space ok']);
  // 5명이 찼으니 같은 코드로는 더 못 들어감 (계정도 안 만듦)
  const sixth = await post(form({ code: SPACE, username: 'sixth' }));
  assert.equal(sixth.status, 400);
  assert.equal(sixth.json.error, s.MSG.badCode);
  assert.equal(sb.db.users.size, 1);
});

test('방 코드: 이미 쓰는 아이디면 409, 방은 그대로', async () => {
  const { post, sb } = setup();
  sb.db.users.set('existing', { email: `partner@${DOMAIN}`, password: 'x' });
  const r = await post(form({ code: SPACE, username: 'partner' }));
  assert.equal(r.status, 409);
  assert.equal(sb.db.spaces.get(SPACE).n, 1);
  assert.ok(!sb.paths().includes('POST /rest/v1/rpc/join_room_for'));
});

test('방 코드: 그사이 방이 5명으로 참(경쟁) → 계정 지우고 같은 일반 문구', async () => {
  const { post, sb, logs } = setup({
    over: {
      'POST /rest/v1/rpc/join_room_for': () => ({ status: 400, body: { code: 'P0001', message: 'room_full' } }),
    },
  });
  const r = await post(form({ code: SPACE, username: 'partner' }));
  assert.equal(r.status, 400);
  assert.equal(r.json.error, s.MSG.badCode);
  assert.equal(sb.db.users.size, 0);
  assert.ok(!sb.paths().includes('GET /rest/v1/couple_members'));
  assert.deepEqual(logs, ['signup space bad_code_raced']);
});

test('방 코드: DB가 닉네임을 거절하면 계정 지우고 이름 문구, 횟수는 안 셈', async () => {
  const { post, sb, logs } = setup({
    over: { 'POST /rest/v1/rpc/join_room_for': () => ({ status: 400, body: { code: 'P0001', message: 'invalid_display_name' } }) },
  });
  for (let i = 0; i < 7; i++) {
    const r = await post(form({ code: SPACE, username: `partner${i}` }));
    assert.equal(r.status, 400);
    assert.equal(r.json.error, s.MSG.displayName);
  }
  assert.equal(sb.db.users.size, 0);
  assert.equal(logs[0], 'signup space bad_name');
});

test('방 코드: 응답이 끊겼고 확인해 보니 그 방에 없으면 계정 지우고 502', async () => {
  const { post, sb, logs } = setup({ over: { 'POST /rest/v1/rpc/join_room_for': () => { throw new Error('timeout'); } } });
  const r = await post(form({ code: SPACE, username: 'partner' }));
  assert.equal(r.status, 502);
  assert.equal(r.json.error, s.MSG.failed);
  assert.equal(sb.db.users.size, 0);
  assert.deepEqual(logs, ['signup space fail:join']);
});

test('방 코드: 참여 응답이 끊겼지만 실제로 그 방에 들어갔으면 성공 (방 id도 줌)', async () => {
  const { post, sb } = setup({
    over: {
      'POST /rest/v1/rpc/join_room_for': (c, db, base) => { base(c); throw new Error('timeout'); },
    },
  });
  const r = await post(form({ code: SPACE, username: 'partner' }));
  assert.equal(r.status, 200);
  assert.equal(r.json.joined, true);
  assert.equal(r.json.couple_id, ROOM_A);
  assert.equal(sb.db.users.size, 1);
  assert.equal(sb.db.spaces.get(SPACE).n, 2);
  const check = sb.calls.find((c) => c.path.startsWith('/rest/v1/couple_members'));
  const q = new URL(`${SUPA}${check.path}`).searchParams;
  assert.equal(q.get('select'), 'couple_id,couples!inner(invite_code)');
  assert.equal(q.get('couples.invite_code'), `eq.${SPACE}`);
  assert.equal(check.headers.apikey, SECRET);
});

test('방 코드: 참여 응답도 끊기고 멤버 확인도 실패 → 계정을 지우지 않음 (들어갔을 수도 있으니)', async () => {
  const { post, sb, logs } = setup({
    over: {
      'POST /rest/v1/rpc/join_room_for': (c, db, base) => { base(c); throw new Error('timeout'); },
      'GET /rest/v1/couple_members': () => ({ status: 503, body: {} }),
    },
  });
  const r = await post(form({ code: SPACE, username: 'partner' }));
  assert.equal(r.status, 502);
  assert.equal(r.json.error, s.MSG.joinUnknown);
  assert.equal(sb.db.users.size, 1);
  assert.equal(sb.db.spaces.get(SPACE).n, 2);
  assert.ok(!sb.paths().some((p) => p.startsWith('DELETE ')));
  assert.deepEqual(logs, ['signup cleanup skipped:join_unknown', 'signup space fail:join_unknown']);
});

test('방 코드: 참여 실패(서버 오류) → 계정 지움', async () => {
  const { post, sb, logs } = setup({ over: { 'POST /rest/v1/rpc/join_room_for': () => ({ status: 500, body: { message: 'x' } }) } });
  const r = await post(form({ code: SPACE, username: 'partner' }));
  assert.equal(r.status, 502);
  assert.equal(sb.db.users.size, 0);
  assert.equal(sb.db.spaces.get(SPACE).n, 1);
  assert.deepEqual(logs, ['signup space fail:join']);
});

test('방 코드: 로그인 실패 → 계정 지움, 참여는 안 함', async () => {
  const { post, sb } = setup({ over: { 'POST /auth/v1/token': () => ({ status: 503, body: {} }) } });
  const r = await post(form({ code: SPACE, username: 'partner' }));
  assert.equal(r.status, 502);
  assert.equal(sb.db.users.size, 0);
  assert.ok(!sb.paths().includes('POST /rest/v1/rpc/join_room_for'));
});

test('방 코드: 계정은 만들어졌는데 응답이 끊김 → 미리 정한 ID로 지움, 방은 그대로', async () => {
  const { post, sb, logs } = setup({
    over: { 'POST /auth/v1/admin/users': (c, db, base) => { base(c); throw new Error('timeout'); } },
  });
  const r = await post(form({ code: SPACE, username: 'partner' }));
  assert.equal(r.status, 502);
  assert.equal(sb.db.users.size, 0);
  assert.equal(sb.db.spaces.get(SPACE).n, 1);
  assert.ok(!sb.paths().includes('POST /auth/v1/token'));
  assert.deepEqual(logs, ['signup space fail:create']);
});

test('계정 지우기가 실패해도 응답은 하고 로그에 남김', async () => {
  const { post, logs } = setup({
    over: {
      'POST /rest/v1/rpc/join_room_for': () => ({ status: 500, body: {} }),
      'DELETE /auth/v1/admin/users/:id': () => ({ status: 500, body: {} }),
    },
  });
  const r = await post(form({ code: SPACE, username: 'partner' }));
  assert.equal(r.status, 502);
  assert.deepEqual(logs, ['signup cleanup fail:delete_user', 'signup space fail:join']);
});

// ---------- 앱 안에서 참여 (POST /api/join) ----------
test('참여: 로그인한 사람을 확인하고 secret key로 그 사람을 넣음', async () => {
  const { join, sb, logs, seedUser } = setup();
  const u = seedUser();
  const r = await join(joinForm({ code: 'abcd-ef12' }), { token: u.token });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { joined: true, couple_id: ROOM_A });
  assert.equal(r.headers['cache-control'], 'no-store');
  assert.deepEqual([...sb.db.members.get(u.id)], [ROOM_A]);
  assert.equal(sb.db.spaces.get(SPACE).n, 2);
  assert.deepEqual(sb.paths(), ['GET /auth/v1/user', 'POST /rest/v1/rpc/join_room_for']);
  const who = sb.calls[0];
  assert.equal(who.headers.apikey, PUB);
  assert.equal(who.headers.authorization, `Bearer ${u.token}`);
  assert.deepEqual(sb.calls[1].body, { p_user: u.id, p_invite_code: SPACE, p_display_name: '민수', p_ack_version: null });
  assert.deepEqual(logs, ['join ok']);
});

test('참여: 틀린 코드·5명 찬 방·방 3개 초과 문구', async () => {
  const { join, sb, seedUser } = setup();
  const u = seedUser();
  let r = await join(joinForm({ code: '99999999' }), { token: u.token });
  assert.equal(r.status, 400);
  assert.equal(r.json.error, s.MSG.joinInvalid);
  r = await join(joinForm({ code: 'FFFF0000' }), { token: u.token });
  assert.equal(r.status, 400);
  assert.equal(r.json.error, s.MSG.joinFull);
  for (const code of ['A0000001', 'A0000002', 'A0000003']) sb.db.addMember(u.id, code);
  r = await join(joinForm(), { token: u.token });
  assert.equal(r.status, 409);
  assert.equal(r.json.error, s.MSG.tooManyRooms);
  assert.equal(sb.db.spaces.get(SPACE).n, 1);
  assert.equal(sb.db.members.get(u.id).size, 3);
});

test('참여: 방이 이미 1~2개 있어도 들어감, 같은 방에 다시 보내면 같은 방 id로 200 (아무것도 안 바뀜)', async () => {
  const { join, sb, seedUser, logs } = setup();
  const u = seedUser();
  const first = sb.db.addMember(u.id, 'A0000001');
  const second = sb.db.addMember(u.id, 'A0000002');
  let r = await join(joinForm(), { token: u.token });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { joined: true, couple_id: ROOM_A });
  assert.deepEqual([...sb.db.members.get(u.id)], [first, second, ROOM_A]);
  assert.equal(sb.db.spaces.get(SPACE).n, 2);
  // 방 3개가 됐어도 이미 들어간 방이면 성공 (too_many_rooms보다 먼저 봄)
  r = await join(joinForm({ code: 'a000 0001' }), { token: u.token });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { joined: true, couple_id: first });
  assert.equal(sb.db.spaces.get('A0000001').n, 1);
  r = await join(joinForm(), { token: u.token });
  assert.deepEqual(r.json, { joined: true, couple_id: ROOM_A });
  assert.equal(sb.db.spaces.get(SPACE).n, 2);
  assert.deepEqual(logs, ['join ok', 'join ok', 'join ok']);
});

test('참여: 가입과 같은 횟수 제한을 나눠 씀 (IP마다 1시간 5번)', async () => {
  const { post, join, sb, seedUser } = setup();
  const u = seedUser();
  for (let i = 0; i < 3; i++) assert.equal((await post(form({ code: 'W9999999A' }))).status, 400);
  for (let i = 0; i < 2; i++) assert.equal((await join(joinForm({ code: '99999999' }), { token: u.token })).status, 400);
  const sixth = await join(joinForm(), { token: u.token });
  assert.equal(sixth.status, 429);
  assert.equal(sixth.headers['retry-after'], '3600');
  assert.match(sixth.json.error, /시도가 너무 많아요/);
  assert.equal(sb.db.spaces.get(SPACE).n, 1); // 막힌 요청은 참여까지 가지 않음
  assert.equal((await post(form({ code: 'W9999999A' }))).status, 429); // 가입도 막힘
  assert.equal((await join(joinForm(), { token: u.token, ip: '198.51.100.9' })).status, 200); // 다른 IP는 됨
});

test('참여: 로그인 토큰이 없거나 안 맞거나 형식이 틀리면 거절하고 횟수는 안 셈', async () => {
  const { join, sb, logs, seedUser } = setup();
  for (let i = 0; i < 3; i++) assert.equal((await join(joinForm())).status, 401);
  for (let i = 0; i < 3; i++) assert.equal((await join(joinForm(), { headers: { authorization: 'Bearer not-a-jwt' } })).status, 401);
  for (let i = 0; i < 3; i++) {
    const r = await join(joinForm(), { token: tokenOf('nobody') });
    assert.equal(r.status, 401);
    assert.equal(r.json.error, s.MSG.login);
  }
  const u = seedUser();
  for (let i = 0; i < 3; i++) assert.equal((await join(joinForm({ code: 'W-2345-6789' }), { token: u.token })).status, 400);
  assert.equal(sb.calls.filter((c) => c.path === '/auth/v1/user').length, 3); // 형식이 틀린 토큰은 Supabase에 묻지 않음
  assert.equal((await join(joinForm(), { token: u.token })).status, 200);
  assert.ok(logs.includes('join unauthorized'));
});

test('참여: 찬 방·방 3개 초과는 코드를 맞힌 것이라 셈, 성공은 세지 않음', async () => {
  const { join, sb, seedUser, logs } = setup();
  const a = seedUser();
  for (let i = 0; i < 7; i++) assert.equal((await join(joinForm(), { token: a.token })).status, 200); // 같은 방 다시: 안 셈
  for (let i = 0; i < 3; i++) assert.equal((await join(joinForm({ code: 'FFFF0000' }), { token: a.token })).status, 400);
  sb.db.addMember(a.id, 'A0000001');
  sb.db.addMember(a.id, 'A0000002');
  sb.db.addRoom('A0000003', 1);
  for (let i = 0; i < 2; i++) assert.equal((await join(joinForm({ code: 'A0000003' }), { token: a.token })).status, 409);
  const r = await join(joinForm({ code: '99999999' }), { token: a.token });
  assert.equal(r.status, 429);
  assert.equal(sb.db.spaces.get('A0000003').n, 1);
  assert.deepEqual(logs.slice(7), ['join full', 'join full', 'join full', 'join too_many_rooms', 'join too_many_rooms', 'join limited:ip']);
});

test('참여: DB가 닉네임을 거절하면(invalid_display_name) 이름 문구, 횟수는 안 셈', async () => {
  const { join, seedUser, logs } = setup({
    over: { 'POST /rest/v1/rpc/join_room_for': () => ({ status: 400, body: { code: 'P0001', message: 'invalid_display_name' } }) },
  });
  const u = seedUser();
  for (let i = 0; i < 7; i++) {
    const r = await join(joinForm(), { token: u.token });
    assert.equal(r.status, 400);
    assert.equal(r.json.error, s.MSG.displayName);
  }
  assert.equal(logs[0], 'join bad_name');
});

test('참여: 응답이 끊겼어도 실제로 그 방에 들어갔으면 성공(방 id), 못 들어갔으면 502', async () => {
  const ok = setup({ over: { 'POST /rest/v1/rpc/join_room_for': (c, db, base) => { base(c); throw new Error('timeout'); } } });
  const u = ok.seedUser();
  const got = await ok.join(joinForm(), { token: u.token });
  assert.equal(got.status, 200);
  assert.deepEqual(got.json, { joined: true, couple_id: ROOM_A });
  const bad = setup({ over: { 'POST /rest/v1/rpc/join_room_for': () => ({ status: 500, body: {} }) } });
  const v = bad.seedUser();
  const r = await bad.join(joinForm(), { token: v.token });
  assert.equal(r.status, 502);
  assert.equal(r.json.error, s.MSG.joinFailed);
  assert.deepEqual(bad.logs, ['join fail:join']);
});

test('참여: 응답이 끊겼고 다른 방에만 들어가 있으면 성공으로 치지 않음 (502, 셈)', async () => {
  const { join, sb, seedUser, logs } = setup({ over: { 'POST /rest/v1/rpc/join_room_for': () => { throw new Error('timeout'); } } });
  const u = seedUser();
  sb.db.addMember(u.id, 'A0000001');
  const r = await join(joinForm(), { token: u.token });
  assert.equal(r.status, 502);
  assert.equal(r.json.error, s.MSG.joinFailed);
  assert.deepEqual(logs, ['join fail:join']);
  // 이 실패는 셈: 4번 더 하면 6번째는 429
  for (let i = 0; i < 4; i++) assert.equal((await join(joinForm(), { token: u.token })).status, 502);
  assert.equal((await join(joinForm(), { token: u.token })).status, 429);
});

test('참여: 확인 요청이 !inner 없이 다른 방 줄까지 받아도(couples: null) 성공으로 치지 않음', async () => {
  const { join, sb, seedUser } = setup({
    over: {
      'POST /rest/v1/rpc/join_room_for': () => { throw new Error('timeout'); },
      'GET /rest/v1/couple_members': (c, db) => {
        const id = new URL(`${SUPA}${c.path}`).searchParams.get('user_id').replace(/^eq\./, '');
        return { status: 200, body: [...(db.members.get(id) || [])].map((couple_id) => ({ couple_id, couples: null })) };
      },
    },
  });
  const u = seedUser();
  sb.db.addMember(u.id, 'A0000001');
  assert.equal((await join(joinForm(), { token: u.token })).status, 502);
});

test('참여: 응답도 끊기고 멤버 확인도 실패하면 502', async () => {
  const { join, seedUser } = setup({
    over: {
      'POST /rest/v1/rpc/join_room_for': (c, db, base) => { base(c); throw new Error('timeout'); },
      'GET /rest/v1/couple_members': () => ({ status: 503, body: {} }),
    },
  });
  const u = seedUser();
  const r = await join(joinForm(), { token: u.token });
  assert.equal(r.status, 502);
  assert.equal(r.json.error, s.MSG.joinFailed);
});

test('참여: 성공 응답에 방 id가 없으면(이상한 응답) 그 코드의 방인지 확인해서 방 id를 줌', async () => {
  const { join, seedUser } = setup({
    over: { 'POST /rest/v1/rpc/join_room_for': (c, db, base) => { base(c); return { status: 200, body: null }; } },
  });
  const u = seedUser();
  const r = await join(joinForm(), { token: u.token });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { joined: true, couple_id: ROOM_A });
});

test('참여: 로그인 확인이 안 되면(Supabase 오류) 502, 횟수는 안 셈', async () => {
  const { join, logs, seedUser } = setup({ over: { 'GET /auth/v1/user': () => ({ status: 500, body: {} }) } });
  const u = seedUser();
  for (let i = 0; i < 7; i++) assert.equal((await join(joinForm(), { token: u.token })).status, 502);
  assert.equal(logs[0], 'join fail:user');
});

test('참여: 요청 모양 (메서드, 형식, 다른 사이트)', async () => {
  const { api, seedUser } = setup();
  const u = seedUser();
  const run = async ({ headers = {}, ...opts }) => {
    const res = fakeRes();
    await api.join(fakeReq({ ...opts, headers: { authorization: `Bearer ${u.token}`, ...headers } }), res);
    return res;
  };
  let r = await run({ method: 'GET' });
  assert.equal(r.status, 405);
  r = await run({ body: joinForm(), headers: { 'content-type': 'text/plain' } });
  assert.equal(r.status, 415);
  r = await run({ body: joinForm(), headers: { origin: 'https://evil.example' } });
  assert.equal(r.status, 403);
  r = await run({ raw: '{nope' });
  assert.equal(r.status, 400);
});

// ---------- 요청 모양 ----------
test('요청 모양: 메서드, 형식, 크기, 다른 사이트', async () => {
  const { handler } = setup();
  const run = async (opts) => { const res = fakeRes(); await handler(fakeReq(opts), res); return res; };
  let r = await run({ method: 'GET' });
  assert.equal(r.status, 405);
  assert.equal(r.headers.allow, 'POST');
  r = await run({ body: form(), headers: { 'content-type': 'text/plain' } });
  assert.equal(r.status, 415);
  r = await run({ raw: JSON.stringify({ ...form(), pad: 'x'.repeat(2100) }) });
  assert.equal(r.status, 413);
  r = await run({ body: form(), headers: { 'content-length': '5000' } });
  assert.equal(r.status, 413);
  r = await run({ raw: '{nope' });
  assert.equal(r.status, 400);
  r = await run({ body: form(), headers: { origin: 'https://evil.example' } });
  assert.equal(r.status, 403);
  r = await run({ body: form(), headers: { 'content-type': 'application/json; charset=utf-8' } });
  assert.equal(r.status, 200);
  for (const x of [r]) assert.equal(x.headers['cache-control'], 'no-store');
});

test('한글 이름이 여러 조각으로 나뉘어 와도 그대로', async () => {
  const { handler, sb } = setup();
  const buf = Buffer.from(JSON.stringify(form({ displayName: '가나다라' })), 'utf8');
  const cut = buf.indexOf(Buffer.from('가', 'utf8')) + 1; // '가' 가운데서 자름
  const req = new Readable({ read() {} });
  req.push(buf.subarray(0, cut)); req.push(buf.subarray(cut)); req.push(null);
  req.method = 'POST';
  req.headers = { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.50' };
  req.socket = { remoteAddress: '127.0.0.1' };
  const res = fakeRes();
  await handler(req, res);
  assert.equal(res.status, 200);
  assert.equal([...sb.db.users.values()][0].meta.display_name, '가나다라');
});

test('응답·로그에 키·비밀번호·아이디·토큰이 없고, 사용자 쪽 요청에는 secret key를 안 보냄', async () => {
  const { post, join, sb, logs, seen, seedUser } = setup({ over: {} });
  await post(form());
  await post(form({ code: SPACE, username: 'partner', password: 'another-pass-1' }));
  await post(form({ code: 'W9999999A', username: 'guess' }));
  sb.db.users.set('dup', { email: `taken@${DOMAIN}`, password: 'x' });
  await post(form({ code: SPACE, username: 'taken' }), { ip: '198.51.100.77' });
  const u = seedUser();
  await join(joinForm({ code: '99999999' }), { token: u.token, ip: '198.51.100.78' });
  await join(joinForm({ code: 'FFFF0000' }), { token: tokenOf('nobody'), ip: '198.51.100.78' });
  const out = [...seen, ...logs].join('\n');
  for (const secret of [SECRET, PUB, PW, 'another-pass-1', 'minsu', 'partner', 'guess', 'taken', DOMAIN, u.id, u.token]) {
    assert.ok(!out.includes(secret), `응답·로그에 ${secret}`);
  }
  for (const line of logs) assert.match(line, /^(signup (invite|space|cleanup)|join) [a-z_:]+$/);
  for (const c of sb.calls) {
    if (c.path.startsWith('/auth/v1/token') || c.path.startsWith('/auth/v1/user')) {
      assert.ok(!JSON.stringify(c.headers).includes(SECRET), `${c.path}에 secret key`);
    }
  }
  assert.ok(!sb.paths().includes('POST /rest/v1/rpc/join_couple')); // 앱용 join_couple은 친구용에서 막혀 있으니 안 씀
});

test('예상 못 한 오류도 500으로 답하고 입력값은 로그에 없음', async () => {
  const { post, join, logs, seedUser } = setup({ clock: () => { throw new Error('clock broke minsu'); } });
  const r = await post(form());
  assert.equal(r.status, 500);
  const u = seedUser();
  const j = await join(joinForm(), { token: u.token });
  assert.equal(j.status, 500);
  assert.deepEqual(logs, ['signup error', 'join error']);
});

test('설정이 비면 만들지 않음', () => {
  assert.throws(() => s.createSignupApi({ supabaseUrl: SUPA, publishableKey: PUB, secretKey: '', idDomain: DOMAIN }));
});

// ---------- 시작할 때 확인 ----------
test('verifySecretKey: 맞는 키, 다른 프로젝트 키, 연결 실패, SQL 미실행, join_couple_for 없음', async () => {
  const good = fakeSupabase();
  assert.deepEqual(await s.verifySecretKey({ supabaseUrl: SUPA, secretKey: SECRET, fetchImpl: good.fetchImpl }), { ok: true });
  assert.deepEqual(good.paths(), [
    'GET /auth/v1/admin/users', 'POST /rest/v1/rpc/space_code_open', 'POST /rest/v1/rpc/join_couple_for', 'POST /rest/v1/rpc/groups_schema_version',
    'POST /rest/v1/rpc/public_rooms_version',
  ]);
  assert.equal(good.db.members.size, 0); // 확인만 하고 아무도 넣지 않음
  const wrong = fakeSupabase();
  const r1 = await s.verifySecretKey({ supabaseUrl: SUPA, secretKey: 'sb_secret_otherotherother', fetchImpl: wrong.fetchImpl });
  assert.equal(r1.ok, false);
  assert.equal(r1.retry, false);
  assert.ok(!r1.reason.includes('sb_secret_'));
  const down = await s.verifySecretKey({ supabaseUrl: SUPA, secretKey: SECRET, fetchImpl: async () => { throw new Error('ENOTFOUND'); } });
  assert.equal(down.ok, false);
  assert.equal(down.retry, true);
  const noSql = fakeSupabase({ over: { 'POST /rest/v1/rpc/space_code_open': () => ({ status: 404, body: { code: 'PGRST202' } }) } });
  const r2 = await s.verifySecretKey({ supabaseUrl: SUPA, secretKey: SECRET, fetchImpl: noSql.fetchImpl });
  assert.equal(r2.ok, false);
  assert.match(r2.reason, /friends-signup\.sql/);
  const oldSql = fakeSupabase({ over: { 'POST /rest/v1/rpc/join_couple_for': () => ({ status: 404, body: { code: 'PGRST202' } }) } });
  const r3 = await s.verifySecretKey({ supabaseUrl: SUPA, secretKey: SECRET, fetchImpl: oldSql.fetchImpl });
  assert.equal(r3.ok, false);
  assert.equal(r3.retry, false);
  assert.match(r3.reason, /join_couple_for/);
});

test('verifySecretKey: groups.sql을 안 돌렸으면(groups_schema_version 없음) 다시 해 보지 않고 꺼 둠', async () => {
  const noGroups = fakeSupabase({ over: { 'POST /rest/v1/rpc/groups_schema_version': () => ({ status: 404, body: { code: 'PGRST202' } }) } });
  const r1 = await s.verifySecretKey({ supabaseUrl: SUPA, secretKey: SECRET, fetchImpl: noGroups.fetchImpl });
  assert.equal(r1.ok, false);
  assert.equal(r1.retry, false);
  assert.match(r1.reason, /groups\.sql/);
  const denied = fakeSupabase({ over: { 'POST /rest/v1/rpc/groups_schema_version': () => ({ status: 403, body: {} }) } });
  const r2 = await s.verifySecretKey({ supabaseUrl: SUPA, secretKey: SECRET, fetchImpl: denied.fetchImpl });
  assert.equal(r2.ok, false);
  assert.equal(r2.retry, false);
  const flaky = fakeSupabase({ over: { 'POST /rest/v1/rpc/groups_schema_version': () => ({ status: 503, body: {} }) } });
  const r3 = await s.verifySecretKey({ supabaseUrl: SUPA, secretKey: SECRET, fetchImpl: flaky.fetchImpl });
  assert.equal(r3.ok, false);
  assert.equal(r3.retry, true);
  const zero = fakeSupabase({ over: { 'POST /rest/v1/rpc/groups_schema_version': () => ({ status: 200, body: 0 }) } });
  assert.equal((await s.verifySecretKey({ supabaseUrl: SUPA, secretKey: SECRET, fetchImpl: zero.fetchImpl })).ok, false);
});

// ---------- 문구 ----------
test('문구: 예전 두 사람·공간 표현이 없음', () => {
  for (const [k, v] of Object.entries(s.MSG)) assert.ok(!/두 사람|공간/.test(v), `MSG.${k}: ${v}`);
  assert.equal(s.MSG.joinAlready, undefined);
  assert.match(s.MSG.joinFull, /5명/);
  assert.match(s.MSG.tooManyRooms, /3개/);
});

test('문구: 틀린 코드·찬 방·방 3개 초과 문구가 index.html friendly()와 글자까지 같음', (t) => {
  const html = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', '..', 'index.html'), 'utf8');
  const start = html.indexOf('function friendly(');
  assert.ok(start >= 0, 'index.html에 friendly()가 있어야 함');
  const body = html.slice(start, html.indexOf('\n}\n', start));
  if (!/room_full/.test(body)) { t.skip('index.html friendly()가 아직 room_full을 모름 (화면 작업 뒤에 다시 확인)'); return; }
  const said = (code) => {
    const m = new RegExp(`/${code}/\\.test\\(m\\)\\) return '([^']*)'`).exec(body);
    return m && m[1];
  };
  assert.equal(said('invalid_code'), s.MSG.joinInvalid);
  assert.equal(said('room_full'), s.MSG.joinFull);
  assert.equal(said('too_many_rooms'), s.MSG.tooManyRooms);
});

test('계정 제한 기본값: 같은 IP에서 하루 6개까지 가입되고 7번째는 429', async () => {
  const sb = fakeSupabase({});
  const logs = [];
  const api = s.createSignupApi({
    supabaseUrl: SUPA, publishableKey: PUB, secretKey: SECRET, idDomain: DOMAIN, allowedOrigin: ORIGIN,
    fetchImpl: sb.fetchImpl, now: () => 1_000_000_000_000, log: (m) => logs.push(String(m)),
  });
  for (let r = 0; r < 2; r++) sb.db.addRoom(`E000000${r}`, 0);
  for (let i = 0; i < 6; i++) {
    const res = fakeRes();
    await api.signup(fakeReq({ body: form({ code: `E000000${Math.floor(i / 4)}`, username: `same${i}` }) }), res);
    assert.equal(res.status, 200, `가입 ${i}`);
  }
  const res = fakeRes();
  await api.signup(fakeReq({ body: form({ code: 'E0000001', username: 'same6' }) }), res);
  assert.equal(res.status, 429);
  assert.ok(logs.includes('signup space limited:account_ip'));
});

// ---------- 공개 방 동의 (docs/public-rooms-design.md §3.8, S11–S13) ----------
const PUB_CODE = 'C0FFEE01';
const PUB_NAME = '서울 라멘 지도';
const addPublic = (sb, n = 1) => sb.db.addRoom(PUB_CODE, n, { pub: true, name: PUB_NAME });

test('S11 참여: 공개 방은 동의 없이 409 needAck(방 이름·버전), 아무것도 안 바뀜, 버전 1이면 200 + 동의 기록', async () => {
  const { join, sb, seedUser, logs } = setup();
  const roomId = addPublic(sb);
  const u = seedUser();
  let r = await join(joinForm({ code: PUB_CODE }), { token: u.token });
  assert.equal(r.status, 409);
  assert.deepEqual(r.json, { error: s.MSG.needAck, needAck: true, roomName: PUB_NAME, ackVersion: ACK });
  assert.equal(sb.db.spaces.get(PUB_CODE).n, 1);
  assert.equal(sb.db.members.get(u.id), undefined);
  assert.equal(sb.db.acks.length, 0);
  r = await join(joinForm({ code: PUB_CODE, ackVersion: 1 }), { token: u.token });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { joined: true, couple_id: roomId });
  assert.deepEqual(sb.db.acks, [{ user: u.id, room: roomId, version: 1 }]);
  const call = sb.calls.filter((c) => c.path === '/rest/v1/rpc/join_room_for').pop();
  assert.deepEqual(call.body, { p_user: u.id, p_invite_code: PUB_CODE, p_display_name: '민수', p_ack_version: 1 });
  // 이미 멤버면 동의 없이도 같은 방 id (already_member)
  r = await join(joinForm({ code: PUB_CODE }), { token: u.token });
  assert.equal(r.status, 200);
  assert.equal(r.json.couple_id, roomId);
  assert.deepEqual(logs, ['join need_ack', 'join ok', 'join ok']);
});

test('S11 참여: needAck 409와 nickIsId 400은 시도 횟수에서 빠짐 (여러 번 받아도 다음 정상 요청이 됨)', async () => {
  const { join, sb, seedUser } = setup();
  addPublic(sb);
  const u = seedUser();
  for (let i = 0; i < 7; i++) {
    const r = await join(joinForm({ code: PUB_CODE }), { token: u.token });
    assert.equal(r.status, 409, `${i}`);
    assert.equal(r.json.needAck, true);
  }
  // 닉네임이 로그인 아이디(friend@…의 friend)와 같음: 대소문자 무시
  for (let i = 0; i < 7; i++) {
    const r = await join(joinForm({ code: PUB_CODE, displayName: 'Friend', ackVersion: 1 }), { token: u.token });
    assert.equal(r.status, 400, `${i}`);
    assert.deepEqual(r.json, { error: s.MSG.nickIsId, nickIsId: true });
  }
  // 개인 방에서는 아이디와 같은 닉네임도 됨
  const ok = await join(joinForm({ displayName: 'friend' }), { token: u.token });
  assert.equal(ok.status, 200);
  // 틀린 코드는 그대로 셈: 5번까지 400, 6번째 429
  for (let i = 0; i < 5; i++) assert.equal((await join(joinForm({ code: '99999999' }), { token: u.token })).status, 400);
  assert.equal((await join(joinForm({ code: '99999999' }), { token: u.token })).status, 429);
});

test('S11 참여 순서: 방이 차고(5명) 방 3개인 사람 → 400 joinFull (방 참이 먼저), 공개 방이어도 동의보다 먼저', async () => {
  const { join, sb, seedUser } = setup();
  const u = seedUser();
  for (const code of ['A0000001', 'A0000002', 'A0000003']) sb.db.addMember(u.id, code);
  let r = await join(joinForm({ code: 'FFFF0000' }), { token: u.token });
  assert.equal(r.status, 400);
  assert.equal(r.json.error, s.MSG.joinFull);
  addPublic(sb, 5);
  r = await join(joinForm({ code: PUB_CODE }), { token: u.token });
  assert.equal(r.status, 400);
  assert.equal(r.json.error, s.MSG.joinFull);
  sb.db.spaces.get(PUB_CODE).n = 2;
  r = await join(joinForm({ code: PUB_CODE }), { token: u.token });
  assert.equal(r.status, 409);
  assert.equal(r.json.error, s.MSG.tooManyRooms, '방 3개는 동의보다 먼저');
  assert.equal(r.json.needAck, undefined, '409지만 needAck가 아님(화면이 구별)');
});

test('S11 ackVersion 형식: 정수 1~100만, 그 밖은 400(안 셈)', async () => {
  const { join, sb, seedUser } = setup();
  const u = seedUser();
  for (const bad of ['1', 0, 101, 1.5, true, [], {}]) {
    const r = await join(joinForm({ ackVersion: bad }), { token: u.token });
    assert.equal(r.status, 400, JSON.stringify(bad));
    assert.equal(r.json.error, '요청 형식이 올바르지 않아요');
    assert.deepEqual(s.validate(form({ ackVersion: bad })), { error: '요청 형식이 올바르지 않아요' });
  }
  assert.ok(!sb.paths().includes('POST /rest/v1/rpc/join_room_for'));
  assert.equal(s.validateJoin(joinForm({ ackVersion: null })).ackVersion, null);
  assert.equal(s.validateJoin(joinForm({ ackVersion: 100 })).ackVersion, 100);
});

test('S11 join_room_for가 이상한 모양을 주면 그 코드의 방에 들어갔는지 확인 (기존 응답 놓침과 같게)', async () => {
  const { join, seedUser } = setup({
    over: { 'POST /rest/v1/rpc/join_room_for': () => ({ status: 200, body: { status: 'need_ack', ack_version: 'x' } }) },
  });
  const u = seedUser();
  const r = await join(joinForm(), { token: u.token });
  assert.equal(r.status, 502);
  assert.equal(r.json.error, s.MSG.joinFailed);
});

test('S12 가입: 공개 방 코드는 동의 없이 409 needAck이고 계정을 만들지 않음, 시도·계정 수 둘 다 돌려줌', async () => {
  const { post, sb, logs } = setup();
  addPublic(sb);
  // IP 시도 5번·계정 3개보다 많이 받아도 다음 가입이 됨
  for (let i = 0; i < 7; i++) {
    const r = await post(form({ code: PUB_CODE, username: `jihun${i}`, displayName: '지훈' }));
    assert.equal(r.status, 409, `${i}`);
    assert.deepEqual(r.json, { error: s.MSG.needAck, needAck: true, roomName: PUB_NAME, ackVersion: ACK });
  }
  assert.ok(!sb.paths().includes('POST /auth/v1/admin/users'), '동의 전에는 계정을 만들지 않음');
  assert.equal(sb.db.users.size, 0);
  assert.ok(sb.paths().every((p) => p === 'POST /rest/v1/rpc/space_code_info'));
  const ok = await post(form({ code: PUB_CODE, username: 'jihun', displayName: '지훈', ackVersion: 1 }));
  assert.equal(ok.status, 200);
  assert.equal(ok.json.joined, true);
  assert.equal(ok.json.couple_id, sb.db.spaces.get(PUB_CODE).id);
  assert.equal(sb.db.acks.length, 1);
  assert.equal(logs.filter((l) => l === 'signup space need_ack').length, 7);
  assert.equal(logs.at(-1), 'signup space ok');
});

test('S12 가입: 공개 방에서 닉네임=아이디는 계정 전에 400 nickIsId(안 셈), 개인 방은 됨', async () => {
  const { post, sb } = setup();
  addPublic(sb);
  for (let i = 0; i < 7; i++) {
    const r = await post(form({ code: PUB_CODE, username: 'jihun', displayName: 'JiHun', ackVersion: 1 }));
    assert.equal(r.status, 400);
    assert.deepEqual(r.json, { error: s.MSG.nickIsId, nickIsId: true });
  }
  // 전각 글자·이모지 잇기(U+200D)로 아이디처럼 보이게 해도 같은 아이디로 봄
  for (const nick of ['ｊｉｈｕｎ', 'JI‍HUN']) {
    const r = await post(form({ code: PUB_CODE, username: 'jihun', displayName: nick, ackVersion: 1 }));
    assert.deepEqual(r.json, { error: s.MSG.nickIsId, nickIsId: true }, nick);
  }
  assert.equal(sb.db.users.size, 0);
  assert.ok(!sb.paths().includes('POST /auth/v1/admin/users'));
  const priv = await post(form({ code: SPACE, username: 'minsu', displayName: 'minsu' }));
  assert.equal(priv.status, 200);
  assert.equal(priv.json.couple_id, ROOM_A);
});

test('S12 가입: 계정을 만든 뒤 need_ack(그사이 문구 버전이 바뀜)면 계정을 지우고 새 버전으로 409', async () => {
  const { post, sb, logs } = setup({
    over: {
      'POST /rest/v1/rpc/join_room_for': () => ({ status: 200, body: { status: 'need_ack', couple_id: null, public: true, room_name: PUB_NAME, ack_version: 2 } }),
    },
  });
  addPublic(sb);
  const r = await post(form({ code: PUB_CODE, username: 'jihun', displayName: '지훈', ackVersion: 1 }));
  assert.equal(r.status, 409);
  assert.deepEqual(r.json, { error: s.MSG.needAck, needAck: true, roomName: PUB_NAME, ackVersion: 2 });
  assert.equal(sb.db.users.size, 0, '계정 지움');
  assert.equal(sb.calls.filter((c) => c.method === 'DELETE' && c.path.startsWith('/auth/v1/admin/users/')).length, 1);
  assert.deepEqual(logs, ['signup space need_ack']);
});

test('S12 가입: DB가 닉네임=아이디로 거절하면(계정 뒤) 계정을 지우고 400 nickIsId', async () => {
  const { post, sb } = setup({
    over: { 'POST /rest/v1/rpc/join_room_for': () => ({ status: 400, body: { code: 'P0001', message: 'nickname_is_login_id' } }) },
  });
  addPublic(sb);
  const r = await post(form({ code: PUB_CODE, username: 'jihun', displayName: '지훈', ackVersion: 1 }));
  assert.equal(r.status, 400);
  assert.equal(r.json.nickIsId, true);
  assert.equal(sb.db.users.size, 0);
});

test('S12 가입: 미리 확인(space_code_info)이 실패·이상한 모양이면 502, 계정은 안 만듦', async () => {
  for (const out of [{ status: 500, body: {} }, { status: 200, body: true }, { status: 200, body: { open: true, public: true, ack_version: null } }]) {
    const { post, sb } = setup({ over: { 'POST /rest/v1/rpc/space_code_info': () => out } });
    const r = await post(form({ code: SPACE, username: 'partner' }));
    assert.equal(r.status, 502, JSON.stringify(out));
    assert.equal(r.json.error, s.MSG.failed);
    assert.equal(sb.db.users.size, 0);
  }
});

test('S13 verifySecretKey: public.sql을 안 돌렸으면(public_rooms_version 없음) 다시 해 보지 않고 꺼 둠', async () => {
  const no = fakeSupabase({ over: { 'POST /rest/v1/rpc/public_rooms_version': () => ({ status: 404, body: { code: 'PGRST202' } }) } });
  const r1 = await s.verifySecretKey({ supabaseUrl: SUPA, secretKey: SECRET, fetchImpl: no.fetchImpl });
  assert.equal(r1.ok, false);
  assert.equal(r1.retry, false);
  assert.match(r1.reason, /public\.sql/);
  const flaky = fakeSupabase({ over: { 'POST /rest/v1/rpc/public_rooms_version': () => ({ status: 503, body: {} }) } });
  const r2 = await s.verifySecretKey({ supabaseUrl: SUPA, secretKey: SECRET, fetchImpl: flaky.fetchImpl });
  assert.equal(r2.ok, false);
  assert.equal(r2.retry, true);
  const denied = fakeSupabase({ over: { 'POST /rest/v1/rpc/public_rooms_version': () => ({ status: 403, body: {} }) } });
  assert.equal((await s.verifySecretKey({ supabaseUrl: SUPA, secretKey: SECRET, fetchImpl: denied.fetchImpl })).retry, false);
  const zero = fakeSupabase({ over: { 'POST /rest/v1/rpc/public_rooms_version': () => ({ status: 200, body: 0 }) } });
  assert.equal((await s.verifySecretKey({ supabaseUrl: SUPA, secretKey: SECRET, fetchImpl: zero.fetchImpl })).ok, false);
});

test('S13 문구: needAck·nickIsId가 index.html friendly() 문구와 글자까지 같음', (t) => {
  const html = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', '..', 'index.html'), 'utf8');
  const start = html.indexOf('function friendly(');
  const body = html.slice(start, html.indexOf('\n}\n', start));
  if (!/nickname_is_login_id/.test(body)) { t.skip('index.html friendly()가 아직 공개 방 문구를 모름 (화면 작업 뒤에 다시 확인)'); return; }
  const said = (re) => {
    const m = new RegExp(`/${re}/\\.test\\(m\\)\\) return '([^']*)'`).exec(body);
    return m && m[1];
  };
  assert.equal(said('nickname_is_login_id'), s.MSG.nickIsId);
  assert.equal(said('ack_required\\|need_ack'), s.MSG.needAck);
});
