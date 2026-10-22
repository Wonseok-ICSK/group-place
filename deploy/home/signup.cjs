// 친구용 홈 서버: 초대 코드로 가입(POST /api/signup)과 앱 안에서 방 코드로 참여(POST /api/join).
// server.cjs가 secret key를 확인한 뒤에만 켠다.
// 가입: { code, username, password, displayName } → 200 { access_token, refresh_token, joined, couple_id } (브라우저가 sb.auth.setSession)
// 참여: Authorization: Bearer <로그인 토큰>, { code, displayName } → 200 { joined: true, couple_id }
// 코드는 두 가지를 받는다:
//   가입 코드 W-XXXX-XXXX: 관리자가 만든 1회용 코드(supabase/friends-signup.sql). 가입만 하고 방은 앱에서 만든다(couple_id: null).
//   방 코드 8자리: 방 멤버가 보낸 초대 코드. 가입하면서(또는 앱 안에서) 그 방에 들어간다
//   (supabase/groups.sql의 join_couple_for 규칙: 방은 5명까지, 한 사람은 방 3개까지, 이미 그 방 멤버면 그 방 id를 그대로 돌려줌).
// 친구용 프로젝트는 앱이 join_couple을 직접 못 부르게 막아 두고(friends-signup.sql), 여기서 횟수를 센 뒤 join_couple_for로 넣는다.
// 계정은 아이디로 만든다: Supabase Auth는 이메일이 필요해서 '<아이디>@<LOGIN_ID_DOMAIN>'(메일은 보내지 않음).
// 코드 맞히기를 막으려고 가입과 참여를 합쳐 IP마다 1시간에 5번, 전체 1시간에 30번까지만 받는다.
// 성공(200)과 코드를 맞혀 본 것이 아닌 실패(아이디 중복 등)는 세지 않는다. 틀린 코드·찬 방·방 3개 초과는 센다.
// 따로 '계정 만들기' 제한: 가입으로 실제로 생긴 계정(과 아이디 중복 확인)은 IP마다 하루 3개, 전체 하루 20개까지.
// 성공을 안 세는 위 제한만 있으면 열린 방 코드 하나로 가입→나가기를 되풀이해 계정을 끝없이 만들 수 있어서.
// 로그에는 종류와 결과만 남긴다. 비밀번호·토큰·키·아이디·코드는 남기지 않는다.
'use strict';

const { randomUUID } = require('node:crypto');

const SIGNUP_CODE_RE = /^W[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{8}$/;
const SPACE_CODE_RE = /^[0-9A-F]{8}$/;
const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,19}$/;
const MAX_BODY = 2048;
const CALL_TIMEOUT_MS = 8000;
const LIMITS = { perIp: 5, total: 30, windowMs: 3600_000 };
// 만든 계정 수: 한 방(최대 5명)의 친구들이 같은 Wi-Fi에서 한꺼번에 가입해도 되게 IP마다 하루 6개, 전체 하루 20개
const ACCOUNT_LIMITS = { perIp: 6, total: 20, windowMs: 24 * 3600_000 };
const BAD_REQUEST = '요청 형식이 올바르지 않아요';

const MSG = {
  badCode: '이 초대 코드로는 가입할 수 없어요. 코드를 다시 확인하거나 새 코드를 받아 주세요.',
  codeFormat: '초대 코드를 다시 확인해 주세요. (W로 시작하는 가입 코드나 8자리 방 코드)',
  username: '아이디는 영문 소문자·숫자와 . _ - 로 3~20자예요. (맨 앞은 영문이나 숫자)',
  password: '비밀번호는 8~72자로 입력해 주세요.',
  displayName: '앱에서 보일 이름을 1~20자로 입력해 주세요.',
  duplicate: '이미 쓰는 아이디예요. 다른 아이디를 골라 주세요.',
  weak: '비밀번호가 너무 쉬워요. 더 길게 입력해 주세요.',
  invalidId: '이 아이디는 쓸 수 없어요. 다른 아이디를 골라 주세요.',
  failed: '가입을 끝내지 못했어요. 잠시 후 다시 시도해 주세요.',
  joinUnknown: '가입은 됐지만 방에 들어갔는지 확인하지 못했어요. 잠시 후 아이디와 비밀번호로 로그인해 보세요.',
  // 앱 안에서 참여 (index.html friendly()의 문구와 글자까지 같게: invalid_code / room_full / too_many_rooms)
  spaceCode: '8자리 방 초대 코드를 다시 확인해 주세요.',
  joinInvalid: '초대 코드를 다시 확인해 주세요.',
  joinFull: '이 방은 이미 5명이 모두 찼어요.',
  tooManyRooms: '방은 3개까지 들어갈 수 있어요. 다른 방에서 나간 뒤 다시 시도해 주세요.',
  joinFailed: '참여하지 못했어요. 잠시 후 다시 시도해 주세요.',
  login: '로그인이 끝났어요. 다시 로그인해 주세요.',
};

const HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
};
function send(res, status, body, extra = {}) {
  res.writeHead(status, { ...HEADERS, ...extra });
  res.end(JSON.stringify(body));
}

// 'w-7kq2 xm9a' → 'W7KQ2XM9A'
const normalizeCode = (s) => String(s ?? '').toUpperCase().replace(/[\s-]/g, '');

// 앱에서 보일 이름: 앞뒤 공백을 빼고 1~20자, 제어 문자 없음. 안 되면 null
function cleanDisplayName(raw) {
  const s = raw.trim();
  const len = [...s].length;
  return len < 1 || len > 20 || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(s) ? null : s;
}

// 가입 요청 확인. 통과하면 { kind: 'invite' | 'space', code, username, password, displayName }
function validate(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: BAD_REQUEST };
  const { code: rawCode, username: rawName, password, displayName: rawDisplay } = body;
  if (typeof rawCode !== 'string' || typeof rawName !== 'string' || typeof password !== 'string' || typeof rawDisplay !== 'string') {
    return { error: BAD_REQUEST };
  }
  const code = normalizeCode(rawCode);
  const kind = SIGNUP_CODE_RE.test(code) ? 'invite' : SPACE_CODE_RE.test(code) ? 'space' : '';
  if (!kind) return { error: MSG.codeFormat };
  const username = rawName.trim().toLowerCase();
  if (!USERNAME_RE.test(username) || username.includes('..') || username.endsWith('.')) return { error: MSG.username };
  // bcrypt가 72바이트까지만 쓰므로 바이트로 센다 (한글은 한 글자에 3바이트)
  if (password.length < 8 || Buffer.byteLength(password, 'utf8') > 72) return { error: MSG.password };
  const displayName = cleanDisplayName(rawDisplay);
  if (displayName === null) return { error: MSG.displayName };
  return { kind, code, username, password, displayName };
}

// 참여 요청 확인. 통과하면 { code, displayName }
function validateJoin(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: BAD_REQUEST };
  const { code: rawCode, displayName: rawDisplay } = body;
  if (typeof rawCode !== 'string' || typeof rawDisplay !== 'string') return { error: BAD_REQUEST };
  const code = normalizeCode(rawCode);
  if (!SPACE_CODE_RE.test(code)) return { error: MSG.spaceCode };
  const displayName = cleanDisplayName(rawDisplay);
  if (displayName === null) return { error: MSG.displayName };
  return { code, displayName };
}

// 참여 요청의 로그인 토큰. JWT 모양만 보고, 진짜인지는 Supabase에 묻는다
function bearer(req) {
  const m = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(String(req.headers.authorization || ''));
  return m && m[1].length <= 4096 ? m[1] : '';
}

// 접속한 곳: cloudflared가 넣는 cf-connecting-ip (서버는 127.0.0.1에서만 받아서 밖에서는 이 헤더를 못 꾸밈), 없으면 소켓 주소
function clientIp(req) {
  const h = req.headers['cf-connecting-ip'];
  if (typeof h === 'string' && /^[0-9A-Fa-f:.]{2,45}$/.test(h.trim())) return h.trim();
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}
// 세는 단위: IPv4는 주소 하나, IPv6는 한 회선이 통째로 받는 /64
function ipKey(ip) {
  ip = String(ip || '').trim().toLowerCase().replace(/%.*$/, '');
  const v4 = /^(?:::ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/.exec(ip);
  if (v4) return v4[1];
  if (!ip.includes(':')) return ip || 'unknown';
  let groups = ip.split(':');
  if (ip.includes('::')) {
    const [head, tail] = ip.split('::');
    const h = head ? head.split(':') : [];
    const t = tail ? tail.split(':') : [];
    groups = [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t];
  }
  return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, '') || '0').join(':')}::/64`;
}

// 1시간 동안 IP마다 perIp번, 전체 total번. 받아 준 시도만 기록하므로 기록은 최대 total개.
// 받아 주면 { ok: true, refund() }: refund는 그 한 번을 기록에서 뺀다(성공, 코드를 맞혀 본 것이 아닌 실패용)
function createLimiter({ perIp = LIMITS.perIp, total = LIMITS.total, windowMs = LIMITS.windowMs, now = Date.now } = {}) {
  const byIp = new Map();
  let all = [];
  const drop = (list, t) => {
    const i = list ? list.indexOf(t) : -1;
    if (i >= 0) list.splice(i, 1);
  };
  return function take(key) {
    const t = now();
    const fresh = (list) => list.filter((x) => t - x < windowMs);
    all = fresh(all);
    for (const [k, list] of byIp) {
      const f = fresh(list);
      if (f.length) byIp.set(k, f); else byIp.delete(k);
    }
    const wait = (list) => Math.max(1, Math.ceil((list[0] + windowMs - t) / 1000));
    const mine = byIp.get(key) || [];
    if (mine.length >= perIp) return { ok: false, scope: 'ip', retryAfter: wait(mine) };
    if (all.length >= total) return { ok: false, scope: 'global', retryAfter: wait(all) };
    mine.push(t);
    byIp.set(key, mine);
    all.push(t);
    let counted = true;
    return {
      ok: true,
      refund() {
        if (!counted) return;
        counted = false;
        const list = byIp.get(key);
        drop(list, t);
        if (list && !list.length) byIp.delete(key);
        drop(all, t);
      },
    };
  };
}

// 본문을 끝까지 읽고(연결을 돌려줌) JSON이면 풀어서 돌려줌. 다른 주소로 넘어가지 않음(키가 딴 데로 가지 않게)
async function call(fetchImpl, url, { method = 'GET', headers = {}, body } = {}) {
  const init = { method, headers: { ...headers }, redirect: 'error', signal: AbortSignal.timeout(CALL_TIMEOUT_MS) };
  if (body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const r = await fetchImpl(url, init);
  const text = await r.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { ok: r.ok, status: r.status, json };
}

// 새 secret key(sb_secret_…)는 apikey 헤더에 넣는다. Authorization에도 같은 값을 넣는 것은 supabase-js와 같은 방식
// (값이 apikey와 똑같을 때만 받아 줌). 둘 다 이 프로젝트 주소로만 보낸다.
const adminHeaders = (secretKey) => ({ apikey: secretKey, authorization: `Bearer ${secretKey}` });

// 시작할 때 한 번: secret key가 이 프로젝트 것인지(관리자 API), friends-signup.sql과 groups.sql을 실행했는지 확인.
// → { ok } 또는 { ok: false, retry(다시 해 볼 만한지), reason(짧은 이유, 키는 넣지 않음) }
async function verifySecretKey({ supabaseUrl, secretKey, fetchImpl = fetch }) {
  const headers = adminHeaders(secretKey);
  const down = { ok: false, retry: true, reason: 'Supabase에 연결하지 못했어요' };
  let r;
  try {
    r = await call(fetchImpl, `${supabaseUrl}/auth/v1/admin/users?page=1&per_page=1`, { headers });
  } catch { return down; }
  if (r.status === 401 || r.status === 403) return { ok: false, retry: false, reason: 'secret key가 이 프로젝트 것이 아니거나 폐기됐어요' };
  if (!r.ok) return { ok: false, retry: true, reason: `관리자 API 응답 ${r.status}` };
  try {
    r = await call(fetchImpl, `${supabaseUrl}/rest/v1/rpc/space_code_open`, { method: 'POST', headers, body: { p_code: '00000000' } });
  } catch { return down; }
  if (r.status === 404) return { ok: false, retry: false, reason: '친구용 프로젝트에 supabase/friends-signup.sql을 먼저 실행해 주세요' };
  if (r.status === 401 || r.status === 403) return { ok: false, retry: false, reason: 'secret key로 가입 함수를 부를 수 없어요 (권한)' };
  if (!r.ok) return { ok: false, retry: true, reason: `가입 함수 응답 ${r.status}` };
  // 참여 함수도 있는지: 빈 사용자로 부르면 함수가 'not_authenticated'로 거절함(아무것도 바꾸지 않음)
  try {
    r = await call(fetchImpl, `${supabaseUrl}/rest/v1/rpc/join_couple_for`, {
      method: 'POST', headers, body: { p_user: null, p_invite_code: '', p_display_name: '' },
    });
  } catch { return down; }
  if (r.status === 404) return { ok: false, retry: false, reason: '친구용 프로젝트에 지금 버전의 supabase/friends-signup.sql(join_couple_for 포함)을 실행해 주세요' };
  if (r.status === 401 || r.status === 403) return { ok: false, retry: false, reason: 'secret key로 참여 함수를 부를 수 없어요 (권한)' };
  if (!(r.status === 400 && /not_authenticated/.test(String((r.json && r.json.message) || '')))) {
    return { ok: false, retry: true, reason: `참여 함수 응답 ${r.status}` };
  }
  // 여러 방·5명 규칙(groups.sql)을 실행했는지: 예전 join_couple_for는 2명·1방이라 이 서버와 답이 안 맞음
  try {
    r = await call(fetchImpl, `${supabaseUrl}/rest/v1/rpc/groups_schema_version`, { method: 'POST', headers, body: {} });
  } catch { return down; }
  if (r.status === 404) return { ok: false, retry: false, reason: '친구용 프로젝트에 supabase/groups.sql을 먼저 실행해 주세요' };
  if (r.status === 401 || r.status === 403) return { ok: false, retry: false, reason: 'secret key로 방 규칙 버전을 확인할 수 없어요 (권한)' };
  if (!(r.ok && typeof r.json === 'number' && r.json >= 1)) return { ok: false, retry: true, reason: `방 규칙 버전 응답 ${r.status}` };
  return { ok: true };
}

async function readJson(req) {
  let s = '';
  req.setEncoding('utf8'); // 여러 조각으로 나뉜 한글도 깨지지 않게
  for await (const chunk of req) {
    s += chunk;
    if (s.length > MAX_BODY) { const e = new Error('too large'); e.tooLarge = true; throw e; }
  }
  return JSON.parse(s || 'null');
}

// /api/signup과 /api/join. 둘이 같은 횟수 제한을 나눠 쓴다 → { signup(req, res), join(req, res) }
function createSignupApi({ supabaseUrl, publishableKey, secretKey, idDomain, allowedOrigin = '', fetchImpl = fetch, now = Date.now, log = console.log, limits = {}, accountLimits = {} }) {
  if (!supabaseUrl || !publishableKey || !secretKey || !idDomain) throw new Error('createSignupApi: 설정이 비어 있어요');
  const take = createLimiter({ ...LIMITS, ...limits, now });
  // 가입(/api/signup)만: 실제로 만든 계정 수. 참여(/api/join)는 계정을 만들지 않으므로 안 씀
  const created = createLimiter({ ...ACCOUNT_LIMITS, ...accountLimits, now });
  const admin = adminHeaders(secretKey);
  const rest = (p) => `${supabaseUrl}/rest/v1/${p}`;
  const authUrl = (p) => `${supabaseUrl}/auth/v1/${p}`;
  const emailOf = (v) => `${v.username}@${idDomain}`;
  const rpcAdmin = (fn, args) => call(fetchImpl, rest(`rpc/${fn}`), { method: 'POST', headers: admin, body: args });

  // 관리자 API로 계정 만들기 (Supabase의 '새 가입 막기'와 상관없이 됨, 메일 인증 없이 바로 확인된 계정).
  // 계정 ID(id)는 미리 정해서 보낸다: 응답을 놓쳐도(시간 초과) 무엇을 지울지 안다.
  // 관리자 목록의 '가입한 아이디'는 본인이 못 고치는 app_metadata에서 읽는다(user_metadata는 본인이 바꿀 수 있음)
  async function createUser(v, id) {
    const r = await call(fetchImpl, authUrl('admin/users'), {
      method: 'POST',
      headers: admin,
      body: {
        id,
        email: emailOf(v),
        password: v.password,
        email_confirm: true,
        user_metadata: { username: v.username, display_name: v.displayName },
        app_metadata: { username: v.username },
      },
    });
    if (r.ok && r.json && typeof r.json.id === 'string') return { id: r.json.id };
    const j = r.json || {};
    const code = typeof j.error_code === 'string' ? j.error_code : typeof j.code === 'string' ? j.code : '';
    const msg = String(j.msg || j.message || j.error_description || '');
    if (code === 'email_exists' || code === 'user_already_exists' || /already (been )?registered|already exists/i.test(msg)) return { fail: 'duplicate' };
    if (code === 'weak_password' || /password should|weak/i.test(msg)) return { fail: 'weak' };
    if (code === 'email_address_invalid' || code === 'validation_failed') return { fail: 'invalid_id' };
    return { fail: 'create' };
  }
  // 비밀번호로 로그인해서 브라우저에 넘길 토큰을 받음 (공개 키로, 사람이 로그인하는 것과 같은 길)
  async function signIn(v) {
    const r = await call(fetchImpl, authUrl('token?grant_type=password'), {
      method: 'POST', headers: { apikey: publishableKey }, body: { email: emailOf(v), password: v.password },
    });
    const j = r.json || {};
    if (r.ok && typeof j.access_token === 'string' && typeof j.refresh_token === 'string') {
      return { access_token: j.access_token, refresh_token: j.refresh_token };
    }
    return null;
  }
  // 되돌리기: 계정이 없어졌으면(지웠거나 원래 없어서 404) true. 실패해도 응답은 그대로 하고 결과만 로그에
  async function removeUser(id) {
    try {
      const r = await call(fetchImpl, authUrl(`admin/users/${encodeURIComponent(id)}`), { method: 'DELETE', headers: admin });
      if (r.ok || r.status === 404) return true;
    } catch { /* 아래에서 로그 */ }
    log('signup cleanup fail:delete_user');
    return false;
  }
  async function release(code) {
    try {
      const r = await rpcAdmin('release_signup_invite', { p_code: code });
      if (!r.ok) log('signup cleanup fail:release');
    } catch { log('signup cleanup fail:release'); }
  }
  // 참여 응답을 놓쳤을 때: userId가 '그 코드의 방'에 들어가 있는지. 다른 방 멤버인 것은 성공으로 치지 않는다(방이 여러 개라서).
  // couples!inner라야 코드가 다른 방의 멤버 줄이 빠진다(그냥 couples(...)면 couples: null로 남아서 다 나옴).
  // → { coupleId } | false(아님) | null(확인하지 못함: 모르는데 '아님'으로 보고 계정을 지우지 않게)
  async function memberOfCode(userId, code) {
    try {
      const q = `couple_members?select=couple_id,couples!inner(invite_code)&user_id=eq.${encodeURIComponent(userId)}`
        + `&couples.invite_code=eq.${encodeURIComponent(code)}`;
      const r = await call(fetchImpl, rest(q), { headers: admin });
      if (r.ok && Array.isArray(r.json)) {
        const row = r.json.find((x) => x && typeof x.couple_id === 'string' && x.couples && x.couples.invite_code === code);
        if (row) return { coupleId: row.couple_id };
        return r.json.length ? null : false; // 모양이 이상하면 모르는 것으로
      }
    } catch { /* 아래 */ }
    return null;
  }
  // userId를 방에 넣음 (secret key로 join_couple_for: 방 5명·사람 3방, 이미 그 방 멤버면 같은 방 id, 코드는 그대로 남음)
  // → { joined: true, coupleId } | { fail: 'invalid_code' | 'room_full' | 'too_many_rooms' | 'invalid_display_name' }
  //   | null(결과를 모름: 오류·시간 초과·이상한 응답)
  async function joinSpace(userId, code, displayName) {
    let r;
    try {
      r = await rpcAdmin('join_couple_for', { p_user: userId, p_invite_code: code, p_display_name: displayName });
    } catch { return null; }
    if (r.ok) return typeof r.json === 'string' && r.json ? { joined: true, coupleId: r.json } : null;
    const m = /invalid_code|room_full|too_many_rooms|invalid_display_name/.exec(String((r.json && r.json.message) || ''));
    return m ? { fail: m[0] } : null;
  }
  // 로그인 토큰의 주인 (공개 키 + 그 토큰으로 물음). 계정 ID, 토큰이 안 맞으면 '', 확인하지 못하면 null
  async function userOf(token) {
    const r = await call(fetchImpl, authUrl('user'), { headers: { apikey: publishableKey, authorization: `Bearer ${token}` } });
    if (r.ok && r.json && typeof r.json.id === 'string' && r.json.id) return r.json.id;
    if (r.status === 401 || r.status === 403 || r.status === 404) return '';
    return null;
  }

  const done = (session, coupleId = null) => ({ status: 200, body: { ...session, joined: !!coupleId, couple_id: coupleId }, outcome: 'ok' });
  // 닉네임을 DB가 받지 않음(서버가 미리 걸러서 실제로는 안 옴). 코드 확인 전에 나는 오류라 횟수를 돌려줌
  const nameFail = () => ({ status: 400, body: { error: MSG.displayName }, outcome: 'bad_name', refund: true });
  const badCode = (outcome = 'bad_code') => ({ status: 400, body: { error: MSG.badCode }, outcome });
  const failed = (step) => ({ status: 502, body: { error: MSG.failed }, outcome: `fail:${step}` });
  // 아이디·비밀번호 때문에 실패: 코드는 이미 맞은 것이라(코드를 잡았거나 열린 방) 시도 횟수를 돌려줌(refund)
  const userFail = (fail) => (fail === 'duplicate' ? { status: 409, body: { error: MSG.duplicate }, outcome: 'duplicate', refund: true }
    : fail === 'weak' ? { status: 400, body: { error: MSG.weak }, outcome: 'weak_password', refund: true }
      : fail === 'invalid_id' ? { status: 400, body: { error: MSG.invalidId }, outcome: 'invalid_id', refund: true }
        : failed('create'));

  // 가입 코드: 코드 잡기 → 계정 만들기 → 코드에 계정 기록 → 로그인. 중간에 실패하면 계정을 지우고 코드를 돌려놓음
  async function viaInvite(v) {
    let claimed;
    try { claimed = await rpcAdmin('claim_signup_invite', { p_code: v.code }); } catch { return failed('claim'); }
    if (!claimed.ok) return failed('claim');
    if (claimed.json !== true) return badCode();
    let userId = randomUUID();
    let step = 'create';
    try {
      const made = await createUser(v, userId);
      if (made.fail && made.fail !== 'create') { await release(v.code); return userFail(made.fail); }
      if (made.fail) throw new Error(step); // 알 수 없는 실패: 만들어졌을 수도 있으니 아래에서 지워 봄
      userId = made.id;
      step = 'finish';
      const fin = await rpcAdmin('finish_signup_invite', { p_code: v.code, p_user: userId });
      if (!fin.ok || fin.json !== true) throw new Error(step);
      step = 'signin';
      const session = await signIn(v);
      if (!session) throw new Error(step);
      return done(session, null);
    } catch {
      // 계정을 먼저 지움(만들다 끊겼어도 미리 정한 ID로, 없으면 404라 그대로 통과).
      // 코드에 기록됐더라도(used_by) 계정이 지워지면 비워지므로 그다음 되돌리기가 됨.
      // 못 지웠으면 코드를 돌려놓지 않음: 코드 하나로 계정이 둘 생기지 않게 (목록에 '가입 중단·확인 필요'로 남음)
      if (await removeUser(userId)) await release(v.code);
      else log('signup cleanup skipped:release');
      return failed(step);
    }
  }

  // 방 코드: 미리 확인 → 계정 만들기 → 로그인 → 그 사람으로 join_couple_for. 못 들어가면 계정을 지움
  async function viaSpace(v) {
    let open;
    try { open = await rpcAdmin('space_code_open', { p_code: v.code }); } catch { return failed('precheck'); }
    if (!open.ok) return failed('precheck');
    if (open.json !== true) return badCode();
    const newId = randomUUID();
    let made;
    try { made = await createUser(v, newId); } catch { made = { fail: 'create' }; }
    if (made.fail && made.fail !== 'create') return userFail(made.fail);
    if (made.fail) {
      await removeUser(newId); // 응답만 놓쳤으면 만들어져 있음: 방 없는 계정을 남기지 않게
      return failed('create');
    }
    const userId = made.id;
    // 로그인을 먼저: 참여한 뒤에 로그인이 실패하면 계정을 지워야 하고, 그러면 방 멤버들에게 들어왔다 사라진 사람이 생기므로
    let session = null;
    try { session = await signIn(v); } catch { session = null; }
    if (!session) { await removeUser(userId); return failed('signin'); }
    const j = await joinSpace(userId, v.code, v.displayName);
    if (j && j.joined) return done(session, j.coupleId);
    if (j && j.fail === 'invalid_display_name') { await removeUser(userId); return nameFail(); }
    if (j && j.fail) {
      // 그사이 다른 사람이 먼저 들어가 방이 찼거나(5명) 방이 지워지는 중: 코드가 틀린 것과 같은 답
      // (새 계정이라 too_many_rooms는 나올 수 없지만 나와도 같은 답)
      await removeUser(userId);
      return badCode('bad_code_raced');
    }
    // 응답만 놓쳤을 수도 있으니(시간 초과) 지우기 전에 실제로 그 코드의 방에 들어갔는지 확인
    const member = await memberOfCode(userId, v.code);
    if (member) return done(session, member.coupleId);
    if (member === null) {
      // 확인도 못 함: 들어갔는데 지우면 방 멤버들에게 들어왔다 사라진 사람이 생기므로 계정은 그대로 둠(로그인해서 확인 가능)
      log('signup cleanup skipped:join_unknown');
      return { status: 502, body: { error: MSG.joinUnknown }, outcome: 'fail:join_unknown' };
    }
    await removeUser(userId);
    return failed('join');
  }

  // 앱 안에서 참여 (로그인한 사람. 방이 이미 1~2개 있어도 됨, 이미 그 방 멤버면 같은 방 id로 성공)
  // join_couple_for가 코드를 먼저 확인하므로 room_full·too_many_rooms도 '코드가 맞았다'는 뜻 → 셈(refund 없음)
  async function joinAs(userId, v) {
    const ok = (coupleId) => ({ status: 200, body: { joined: true, couple_id: coupleId }, outcome: 'ok' });
    const j = await joinSpace(userId, v.code, v.displayName);
    if (j && j.joined) return ok(j.coupleId);
    if (j && j.fail === 'invalid_code') return { status: 400, body: { error: MSG.joinInvalid }, outcome: 'bad_code' };
    if (j && j.fail === 'room_full') return { status: 400, body: { error: MSG.joinFull }, outcome: 'full' };
    if (j && j.fail === 'too_many_rooms') return { status: 409, body: { error: MSG.tooManyRooms }, outcome: 'too_many_rooms' };
    if (j && j.fail) return nameFail();
    const member = await memberOfCode(userId, v.code); // 응답만 놓쳤을 수도 있으니 그 코드의 방에 들어갔는지 확인
    if (member) return ok(member.coupleId);
    return { status: 502, body: { error: MSG.joinFailed }, outcome: 'fail:join' };
  }

  // 공통 확인(POST, 이 사이트에서 온 JSON, 크기) 뒤 본문. 안 맞으면 바로 답하고 undefined
  async function readRequest(req, res) {
    if (req.method !== 'POST') { send(res, 405, { error: 'POST만 받아요' }, { allow: 'POST' }); return undefined; }
    const origin = req.headers.origin;
    if (allowedOrigin && origin && origin !== allowedOrigin) { send(res, 403, { error: '다른 사이트에서 온 요청은 받지 않아요' }); return undefined; }
    if (!/^application\/json\s*(;|$)/i.test(String(req.headers['content-type'] || ''))) { send(res, 415, { error: 'JSON으로 보내 주세요' }); return undefined; }
    if (Number(req.headers['content-length'] || 0) > MAX_BODY) { send(res, 413, { error: '요청이 너무 커요' }, { connection: 'close' }); return undefined; }
    try { return await readJson(req); } catch (e) {
      if (e && e.tooLarge) send(res, 413, { error: '요청이 너무 커요' }, { connection: 'close' });
      else send(res, 400, { error: BAD_REQUEST });
      return undefined;
    }
  }
  function tooMany(res, gate) {
    const minutes = Math.max(1, Math.ceil(gate.retryAfter / 60));
    return send(res, 429, { error: `시도가 너무 많아요. ${minutes}분 뒤에 다시 해 주세요.` }, { 'retry-after': String(gate.retryAfter) });
  }

  async function handleSignup(req, res) {
    const body = await readRequest(req, res);
    if (body === undefined) return;
    const v = validate(body);
    if (v.error) return send(res, 400, { error: v.error });
    // 형식이 맞는 시도는 일단 센다. 끝난 뒤 성공(200)과 코드는 맞았는데 아이디·비밀번호로 실패한 것은 돌려줌
    const gate = take(ipKey(clientIp(req)));
    if (!gate.ok) {
      log(`signup ${v.kind} limited:${gate.scope}`);
      return tooMany(res, gate);
    }
    const acct = created(ipKey(clientIp(req)));
    if (!acct.ok) {
      gate.refund(); // 코드를 넣어 보지도 않았으니 코드 맞히기 횟수는 돌려줌
      log(`signup ${v.kind} limited:account_${acct.scope}`);
      return tooMany(res, acct);
    }
    const result = v.kind === 'invite' ? await viaInvite(v) : await viaSpace(v);
    if (result.refund || result.status === 200) gate.refund();
    // 계정 수: 계정이 남은 것(성공, 들어갔는지 모르는 채 둔 계정)과 아이디 중복(있는 아이디를 알아보는 데 쓰일 수 있음)만 셈
    if (result.status !== 200 && result.outcome !== 'fail:join_unknown' && result.outcome !== 'duplicate') acct.refund();
    log(`signup ${v.kind} ${result.outcome}`);
    return send(res, result.status, result.body);
  }

  async function handleJoin(req, res) {
    const body = await readRequest(req, res);
    if (body === undefined) return;
    const v = validateJoin(body);
    if (v.error) return send(res, 400, { error: v.error });
    const token = bearer(req);
    if (!token) return send(res, 401, { error: MSG.login });
    // 로그인한 사람의 시도만 셈: 토큰이 없으면 코드를 넣어 볼 수 없으니 전체 횟수를 쓰지 않게
    let userId;
    try { userId = await userOf(token); } catch { userId = null; }
    if (userId === null) { log('join fail:user'); return send(res, 502, { error: MSG.joinFailed }); }
    if (!userId) { log('join unauthorized'); return send(res, 401, { error: MSG.login }); }
    const gate = take(ipKey(clientIp(req)));
    if (!gate.ok) {
      log(`join limited:${gate.scope}`);
      return tooMany(res, gate);
    }
    const result = await joinAs(userId, v);
    if (result.refund || result.status === 200) gate.refund(); // 성공은 세지 않음
    log(`join ${result.outcome}`);
    return send(res, result.status, result.body);
  }

  // 예상 못 한 오류도 여기서 막음 (서버 전체가 멈추지 않게). 오류 내용에는 입력값이 섞일 수 있어 남기지 않음
  const guard = (name, fn) => async (req, res) => {
    try { await fn(req, res); } catch {
      log(`${name} error`);
      if (!res.headersSent) send(res, 500, { error: '잠시 후 다시 시도해 주세요' });
    }
  };
  return { signup: guard('signup', handleSignup), join: guard('join', handleJoin) };
}

module.exports = { createSignupApi, verifySecretKey, validate, validateJoin, normalizeCode, createLimiter, clientIp, ipKey, MSG };
