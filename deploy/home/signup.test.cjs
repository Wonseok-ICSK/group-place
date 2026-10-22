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
const PW = 'correct-horse-9';
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
// spaces: 공간 코드 → 멤버 수
// over: { '<METHOD> <경로>': (c, db, base) => 응답 } 로 바꿔 끼움 (base는 원래 동작)
function fakeSupabase({ over = {} } = {}) {
  const db = {
    invites: new Map([[INVITE, 'open'], ['W33333333', 'revoked'], ['W44444444', 'expired']]),
    spaces: new Map([[SPACE, 1], ['FFFF0000', 2]]),
    users: new Map(), // id → { email, password, meta, app }
    members: new Map(), // user id → 공간 코드
    seq: 0,
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
      const n = db.spaces.get(c.body.p_code);
      return { status: 200, body: n !== undefined && n < 2 };
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
    'POST /rest/v1/rpc/join_couple_for': (c) => {
      if (!isAdmin(c.headers)) return deny;
      const id = c.body.p_user;
      if (!id) return raise('not_authenticated');
      if (db.members.has(id)) return raise('already_in_couple');
      const n = db.spaces.get(c.body.p_invite_code);
      if (n === undefined) return raise('invalid_code');
      if (n >= 2) return raise('couple_full');
      db.spaces.set(c.body.p_invite_code, n + 1);
      db.members.set(id, c.body.p_invite_code);
      return { status: 200, body: 'couple-id' };
    },
    'GET /rest/v1/couple_members': (c) => {
      if (!isAdmin(c.headers)) return deny;
      const id = new URL(`${SUPA}${c.path}`).searchParams.get('user_id').replace(/^eq\./, '');
      return { status: 200, body: db.members.has(id) ? [{ couple_id: 'couple-id' }] : [] };
    },
    'DELETE /auth/v1/admin/users/:id': (c) => {
      if (!isAdmin(c.headers)) return deny;
      const id = decodeURIComponent(c.path.split('?')[0].split('/').pop());
      const had = db.users.delete(id);
      // 계정을 지우면 공간 멤버(on delete cascade)와 코드의 used_by(on delete set null)도 같이 정리됨
      if (db.members.has(id)) { db.spaces.set(db.members.get(id), db.spaces.get(db.members.get(id)) - 1); db.members.delete(id); }
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
    const h = over[key] || base;
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
  // 로그인했고 아직 공간이 없는 친구
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
  assert.deepEqual(a, { kind: 'invite', code: 'W23456789', username: 'minsu', password: PW, displayName: '민수' });
  const b = s.validate(form({ code: 'abcd ef12' }));
  assert.equal(b.kind, 'space');
  assert.equal(b.code, 'ABCDEF12');
  assert.equal(s.validate(form({ username: 'a.b_c-9' })).username, 'a.b_c-9');
  assert.deepEqual(s.validateJoin({ code: ' abcd-ef12 ', displayName: ' 민수 ' }), { code: SPACE, displayName: '민수' });
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

test('코드는 맞고 아이디가 이미 있으면(409) 횟수를 세지 않음, 틀린 코드는 그대로 셈', async () => {
  const { post, sb } = setup();
  sb.db.users.set('existing', { email: `minsu@${DOMAIN}`, password: 'x' });
  for (let i = 0; i < 6; i++) {
    assert.equal((await post(form())).status, 409, `가입 코드 ${i}`);
    assert.equal(sb.db.invites.get(INVITE), 'open');
  }
  for (let i = 0; i < 6; i++) assert.equal((await post(form({ code: SPACE }))).status, 409, `공간 코드 ${i}`);
  for (let i = 0; i < 5; i++) assert.equal((await post(form({ code: 'W9999999A' }))).status, 400);
  assert.equal((await post(form({ username: 'fresh' }))).status, 429);
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

test('쓸 수 없는 코드(없음·취소·만료·이미 씀·찬 공간)는 모두 같은 문구', async () => {
  const { post, sb } = setup();
  sb.db.invites.set('W55555555', 'used:someone');
  const codes = ['W9999999A', 'W33333333', 'W44444444', 'W55555555', 'FFFF0000', '00000000'];
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

// ---------- 공간 코드로 가입 ----------
test('공간 코드로 가입: 바로 그 공간에 들어감 (secret key로 join_couple_for, 그 사람 ID로)', async () => {
  const { post, sb, logs } = setup();
  const r = await post(form({ code: 'abcd-ef12', username: 'partner', displayName: '지훈' }));
  assert.equal(r.status, 200);
  assert.equal(r.json.joined, true);
  assert.equal(sb.db.spaces.get(SPACE), 2);
  assert.deepEqual(sb.paths(), [
    'POST /rest/v1/rpc/space_code_open', 'POST /auth/v1/admin/users', 'POST /auth/v1/token', 'POST /rest/v1/rpc/join_couple_for',
  ]);
  const [id] = [...sb.db.users.keys()];
  const join = sb.calls.find((c) => c.path === '/rest/v1/rpc/join_couple_for');
  assert.deepEqual(join.body, { p_user: id, p_invite_code: SPACE, p_display_name: '지훈' });
  assert.equal(join.headers.apikey, SECRET);
  assert.deepEqual(logs, ['signup space ok']);
  // 공간이 찼으니 같은 코드로는 더 못 들어감
  const third = await post(form({ code: SPACE, username: 'third' }));
  assert.equal(third.status, 400);
  assert.equal(third.json.error, s.MSG.badCode);
});

test('공간 코드: 이미 쓰는 아이디면 409, 공간은 그대로', async () => {
  const { post, sb } = setup();
  sb.db.users.set('existing', { email: `partner@${DOMAIN}`, password: 'x' });
  const r = await post(form({ code: SPACE, username: 'partner' }));
  assert.equal(r.status, 409);
  assert.equal(sb.db.spaces.get(SPACE), 1);
  assert.ok(!sb.paths().includes('POST /rest/v1/rpc/join_couple_for'));
});

test('공간 코드: 그사이 공간이 참(경쟁) → 계정 지우고 같은 일반 문구', async () => {
  const { post, sb, logs } = setup({
    over: {
      'POST /rest/v1/rpc/join_couple_for': () => ({ status: 400, body: { code: 'P0001', message: 'couple_full' } }),
    },
  });
  const r = await post(form({ code: SPACE, username: 'partner' }));
  assert.equal(r.status, 400);
  assert.equal(r.json.error, s.MSG.badCode);
  assert.equal(sb.db.users.size, 0);
  assert.ok(!sb.paths().includes('GET /rest/v1/couple_members'));
  assert.deepEqual(logs, ['signup space bad_code_raced']);
});

test('공간 코드: 참여 응답이 끊겼지만 실제로 들어갔으면 성공', async () => {
  const { post, sb } = setup({
    over: {
      'POST /rest/v1/rpc/join_couple_for': (c, db, base) => { base(c); throw new Error('timeout'); },
    },
  });
  const r = await post(form({ code: SPACE, username: 'partner' }));
  assert.equal(r.status, 200);
  assert.equal(r.json.joined, true);
  assert.equal(sb.db.users.size, 1);
  assert.equal(sb.db.spaces.get(SPACE), 2);
});

test('공간 코드: 참여 응답도 끊기고 멤버 확인도 실패 → 계정을 지우지 않음 (상대 공간이 코드 없이 남지 않게)', async () => {
  const { post, sb, logs } = setup({
    over: {
      'POST /rest/v1/rpc/join_couple_for': (c, db, base) => { base(c); throw new Error('timeout'); },
      'GET /rest/v1/couple_members': () => ({ status: 503, body: {} }),
    },
  });
  const r = await post(form({ code: SPACE, username: 'partner' }));
  assert.equal(r.status, 502);
  assert.equal(r.json.error, s.MSG.joinUnknown);
  assert.equal(sb.db.users.size, 1);
  assert.equal(sb.db.spaces.get(SPACE), 2);
  assert.ok(!sb.paths().some((p) => p.startsWith('DELETE ')));
  assert.deepEqual(logs, ['signup cleanup skipped:join_unknown', 'signup space fail:join_unknown']);
});

test('공간 코드: 참여 실패(서버 오류) → 계정 지움', async () => {
  const { post, sb, logs } = setup({ over: { 'POST /rest/v1/rpc/join_couple_for': () => ({ status: 500, body: { message: 'x' } }) } });
  const r = await post(form({ code: SPACE, username: 'partner' }));
  assert.equal(r.status, 502);
  assert.equal(sb.db.users.size, 0);
  assert.equal(sb.db.spaces.get(SPACE), 1);
  assert.deepEqual(logs, ['signup space fail:join']);
});

test('공간 코드: 로그인 실패 → 계정 지움, 참여는 안 함', async () => {
  const { post, sb } = setup({ over: { 'POST /auth/v1/token': () => ({ status: 503, body: {} }) } });
  const r = await post(form({ code: SPACE, username: 'partner' }));
  assert.equal(r.status, 502);
  assert.equal(sb.db.users.size, 0);
  assert.ok(!sb.paths().includes('POST /rest/v1/rpc/join_couple_for'));
});

test('공간 코드: 계정은 만들어졌는데 응답이 끊김 → 미리 정한 ID로 지움, 공간은 그대로', async () => {
  const { post, sb, logs } = setup({
    over: { 'POST /auth/v1/admin/users': (c, db, base) => { base(c); throw new Error('timeout'); } },
  });
  const r = await post(form({ code: SPACE, username: 'partner' }));
  assert.equal(r.status, 502);
  assert.equal(sb.db.users.size, 0);
  assert.equal(sb.db.spaces.get(SPACE), 1);
  assert.ok(!sb.paths().includes('POST /auth/v1/token'));
  assert.deepEqual(logs, ['signup space fail:create']);
});

test('계정 지우기가 실패해도 응답은 하고 로그에 남김', async () => {
  const { post, logs } = setup({
    over: {
      'POST /rest/v1/rpc/join_couple_for': () => ({ status: 500, body: {} }),
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
  assert.deepEqual(r.json, { joined: true });
  assert.equal(r.headers['cache-control'], 'no-store');
  assert.equal(sb.db.members.get(u.id), SPACE);
  assert.equal(sb.db.spaces.get(SPACE), 2);
  assert.deepEqual(sb.paths(), ['GET /auth/v1/user', 'POST /rest/v1/rpc/join_couple_for']);
  const who = sb.calls[0];
  assert.equal(who.headers.apikey, PUB);
  assert.equal(who.headers.authorization, `Bearer ${u.token}`);
  assert.deepEqual(sb.calls[1].body, { p_user: u.id, p_invite_code: SPACE, p_display_name: '민수' });
  assert.deepEqual(logs, ['join ok']);
});

test('참여: 틀린 코드·찬 공간·이미 공간 있음 문구', async () => {
  const { join, sb, seedUser } = setup();
  const u = seedUser();
  let r = await join(joinForm({ code: '99999999' }), { token: u.token });
  assert.equal(r.status, 400);
  assert.equal(r.json.error, s.MSG.joinInvalid);
  r = await join(joinForm({ code: 'FFFF0000' }), { token: u.token });
  assert.equal(r.status, 400);
  assert.equal(r.json.error, s.MSG.joinFull);
  sb.db.members.set(u.id, 'FFFF0000');
  r = await join(joinForm(), { token: u.token });
  assert.equal(r.status, 409);
  assert.equal(r.json.error, s.MSG.joinAlready);
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
  assert.equal(sb.db.spaces.get(SPACE), 1); // 막힌 요청은 참여까지 가지 않음
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

test('참여: 이미 공간이 있어서 거절된 것은 횟수를 세지 않음', async () => {
  const { join, sb, seedUser } = setup();
  const a = seedUser();
  sb.db.members.set(a.id, 'FFFF0000');
  for (let i = 0; i < 7; i++) assert.equal((await join(joinForm({ code: '99999999' }), { token: a.token })).status, 409);
  const b = seedUser('99999999-2222-4333-8444-555555555555', `other@${DOMAIN}`);
  for (let i = 0; i < 5; i++) assert.equal((await join(joinForm({ code: '99999999' }), { token: b.token })).status, 400);
  assert.equal((await join(joinForm(), { token: b.token })).status, 429);
});

test('참여: 응답이 끊겼어도 실제로 들어갔으면 성공, 못 들어갔으면 502', async () => {
  const ok = setup({ over: { 'POST /rest/v1/rpc/join_couple_for': (c, db, base) => { base(c); throw new Error('timeout'); } } });
  const u = ok.seedUser();
  assert.equal((await ok.join(joinForm(), { token: u.token })).status, 200);
  const bad = setup({ over: { 'POST /rest/v1/rpc/join_couple_for': () => ({ status: 500, body: {} }) } });
  const v = bad.seedUser();
  const r = await bad.join(joinForm(), { token: v.token });
  assert.equal(r.status, 502);
  assert.equal(r.json.error, s.MSG.joinFailed);
  assert.deepEqual(bad.logs, ['join fail:join']);
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
  assert.deepEqual(good.paths(), ['GET /auth/v1/admin/users', 'POST /rest/v1/rpc/space_code_open', 'POST /rest/v1/rpc/join_couple_for']);
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
