// 구글 지도 링크 → 장소 이름·주소 (브라우저에서는 구글에 직접 물어볼 수 없어서 Vercel 서버 함수로 대신 가져옴)
// POST /api/place  { url }   Authorization: Bearer <로그인한 사람의 supabase access token>
// → 200 { name, address } · 400 구글 지도 링크가 아님 · 401 로그인 필요 · 502 구글에서 못 가져옴
// POST /api/place  { warm: true }  → 204 (미리 준비, 아래 warm 참고)
// 공식 API가 아니라 구글 지도 웹페이지가 쓰는 데이터를 읽는 방식이라, 구글이 형식을 바꾸면 이름만(링크에서) 나오거나 실패할 수 있음
const crypto = require('node:crypto');
const SUPABASE_URL = process.env.SUPABASE_URL || ''; // 서버 설정 (deploy/home/server.cjs가 확인한 값)
const SUPABASE_KEY = process.env.SUPABASE_KEY || ''; // 공개 키 (Publishable key)
const HEADERS = {
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  'accept-language': 'ko-KR,ko;q=0.9',
};

// 구글 지도 주소만 받음 (다른 곳으로 가는 리다이렉트도 막음)
const isGoogle = (h) => /^(www\.|maps\.)?google\.(com|[a-z]{2}|co\.[a-z]{2}|com\.[a-z]{2})$/.test(h);
function mapsUrl(raw, base) {
  if (!base && !/^[a-z][a-z0-9+.-]*:/i.test(raw)) raw = 'https://' + raw; // https:// 없이 붙여넣은 링크
  let u;
  try { u = new URL(raw, base); } catch { return null; }
  if (!/^https?:$/.test(u.protocol) || u.port || u.username || u.password) return null;
  u.protocol = 'https:';
  const h = u.hostname;
  const ok = h === 'maps.app.goo.gl'
    || (h === 'goo.gl' && u.pathname.startsWith('/maps'))
    || (isGoogle(h) && (h.startsWith('maps.') || u.pathname === '/maps' || u.pathname.startsWith('/maps/')));
  if (!ok) return null;
  if (isGoogle(h)) {
    // google.co.kr·google.co.jp 같은 나라별 주소도 구글 본 주소로 (google.○○ 중엔 구글이 아닌 곳도 있어서, 받은 주소로는 안 감)
    u.hostname = h.startsWith('maps.') ? 'maps.google.com' : 'www.google.com';
    u.searchParams.set('hl', 'ko'); // 이름·주소를 한국어로
  }
  return u;
}

// 짧은 링크(maps.app.goo.gl)를 따라가서 장소 페이지를 받음
async function openPage(url, signal) {
  for (let i = 0; i < 5; i++) {
    const r = await fetch(url, { redirect: 'manual', headers: HEADERS, signal });
    if (r.status >= 300 && r.status < 400) {
      url = mapsUrl(r.headers.get('location') || '', url);
      discard(r);
      if (!url) throw new Error('구글 지도 밖으로 가는 링크');
      continue;
    }
    if (!r.ok) { discard(r); throw new Error(`구글 지도 ${r.status}`); }
    return { url, html: await r.text() };
  }
  throw new Error('리다이렉트가 너무 많음');
}

const text = (v) => (typeof v === 'string' ? v.trim() : '');
// 읽지 않을 응답 본문은 바로 버린다 (오래 도는 서버에서 연결이 쌓이지 않게)
const discard = (r) => r.body?.cancel().catch(() => {});
// 가게가 아니라 지도에 찍은 위치: 좌표, 도·분·초, 플러스 코드(HX8V+373)
const isPin = (s) => /°|^-?\d+(\.\d+)?\s*,\s*-?\d+(\.\d+)?$|^[23456789CFGHJMPQRVWX]{4,8}\+[23456789CFGHJMPQRVWX]{0,3}(\s|$)/i.test(s);

// 장소 페이지가 미리 불러 두는 장소 정보(/maps/preview/place)에서 이름(11번)·주소(39번, 없으면 2번 줄들)
async function placeInfo(page, signal) {
  const m = page.html.match(/<link href="(\/maps\/preview\/place\?[^"]+)"/);
  const url = m && mapsUrl(m[1].replace(/&amp;/g, '&'), page.url);
  if (!url) return {};
  const r = await fetch(url, { redirect: 'manual', headers: HEADERS, signal });
  if (!r.ok) { discard(r); return {}; }
  const t = await r.text();
  let p;
  try { p = JSON.parse(t.slice(t.indexOf('\n') + 1))[6]; } catch { return {}; } // 첫 줄은 )]}'
  if (!Array.isArray(p)) return {};
  const lines = Array.isArray(p[2]) ? p[2].map(text).filter(Boolean).join(', ') : '';
  return { name: text(p[11]), address: (text(p[39]) || lines).replace(/^대한민국\s+/, '') };
}

// 장소 정보를 못 받았을 때: 링크에 들어 있는 이름 (…/maps/place/이름/… 또는 ?q=이름, 주소&ftid=…)
function nameFromUrl(u) {
  const m = u.pathname.match(/^\/maps\/place\/([^/]+)/);
  if (m) { try { return decodeURIComponent(m[1].replace(/\+/g, ' ')).trim(); } catch { return ''; } }
  const q = u.searchParams.get('q');
  return q && u.searchParams.get('ftid') ? q.split(',')[0].trim() : '';
}

// 로그인 확인. Supabase 로그인 토큰(JWT)이 Supabase 공개 키(ES256)로 서명돼 있으면 여기서 바로 확인한다(Supabase에 안 물어봄).
// 공개 키 목록은 서버가 도는 동안 기억해 둔다. 모르는 형식의 토큰이면 예전처럼 Supabase에 물어본다
let jwks = {}, jwksAt = 0;
async function signingKey(kid) {
  if (!jwks[kid] && Date.now() - jwksAt > 60000) { // 새 키가 생겼을 수 있으니 1분에 한 번까지 다시 받음
    jwksAt = Date.now();
    const r = await fetch(`${SUPABASE_URL}/auth/v1/.well-known/jwks.json`, { signal: AbortSignal.timeout(5000) });
    if (r.ok) jwks = Object.fromEntries(((await r.json()).keys || []).map((k) => [k.kid, crypto.createPublicKey({ key: k, format: 'jwk' })]));
    else discard(r);
  }
  return jwks[kid];
}
const part = (s) => JSON.parse(Buffer.from(s, 'base64url').toString());
async function signedIn(req) {
  const auth = String(req.headers.authorization || '');
  const m = auth.match(/^Bearer ([\w-]+)\.([\w-]+)\.([\w-]+)$/); // Supabase access token(JWT) 모양만
  if (!m) return false;
  let head = {}, claims = {};
  try { head = part(m[1]); claims = part(m[2]); } catch { /* 모르는 형식 → Supabase에 물어봄 */ }
  const key = head.alg === 'ES256' && typeof head.kid === 'string' ? await signingKey(head.kid).catch(() => null) : null;
  if (!key) {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: SUPABASE_KEY, authorization: auth }, signal: AbortSignal.timeout(5000) });
    const ok = r.ok;
    discard(r);
    return ok;
  }
  const ok = crypto.verify('sha256', Buffer.from(`${m[1]}.${m[2]}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(m[3], 'base64url'));
  return ok && claims.iss === `${SUPABASE_URL}/auth/v1` && claims.role === 'authenticated' && claims.exp > Date.now() / 1000 - 30;
}

// 장소 추가·정보 수정을 열 때와 다른 앱에서 돌아왔을 때 앱이 미리 부름 ({ warm: true }).
// 공개 키를 미리 받고 구글 연결을 열어 둬서, 바로 뒤에 오는 진짜 요청이 빨라진다
async function warm(req, res) {
  if (!(await signedIn(req))) return send(res, 401, { error: '로그인이 필요해요' });
  const signal = AbortSignal.timeout(3000);
  await Promise.all(['https://maps.app.goo.gl/', 'https://www.google.com/maps?hl=ko'].map((u) =>
    fetch(u, { method: 'HEAD', redirect: 'manual', headers: HEADERS, signal }).then(discard, () => {})));
  res.statusCode = 204;
  res.end();
}

async function readBody(req) {
  if (req.body !== undefined) return typeof req.body === 'string' ? JSON.parse(req.body) : req.body; // Vercel이 미리 읽어 둔 경우
  let s = '';
  req.setEncoding('utf8'); // 여러 조각으로 나뉜 한글도 깨지지 않게
  for await (const c of req) { s += c; if (s.length > 4096) throw new Error('너무 긺'); }
  return JSON.parse(s || '{}');
}

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(body));
}

async function handle(req, res) {
  if (req.method !== 'POST') { res.setHeader('allow', 'POST'); return send(res, 405, { error: 'POST만 받아요' }); }
  if (!SUPABASE_URL || !SUPABASE_KEY) return send(res, 500, { error: '서버 설정이 필요해요' });
  let body;
  try { body = await readBody(req); } catch { return send(res, 400, { error: '요청 형식이 올바르지 않아요' }); }
  if (body && body.warm === true) return warm(req, res);
  const start = mapsUrl(body && typeof body.url === 'string' ? body.url.trim().slice(0, 2000) : '');
  if (!start) return send(res, 400, { error: '구글 지도 링크가 아니에요' });
  try {
    if (!(await signedIn(req))) return send(res, 401, { error: '로그인이 필요해요' });
  } catch (e) {
    console.error('로그인 확인 실패', e.message);
    return send(res, 502, { error: '로그인을 확인하지 못했어요' });
  }
  try {
    const signal = AbortSignal.timeout(8000);
    const page = await openPage(start, signal);
    const info = await placeInfo(page, signal).catch(() => ({}));
    let name = info.name || nameFromUrl(page.url) || nameFromUrl(start);
    let address = info.address || '';
    if (isPin(name)) name = address = ''; // 찍은 위치엔 가게 이름이 없고 주소도 동네 이름 정도라 안 채움
    if (isPin(address)) address = '';
    if (!name && !address) return send(res, 502, { error: '장소 정보를 찾지 못했어요' });
    return send(res, 200, { name: name.slice(0, 80), address: address.slice(0, 200) });
  } catch (e) {
    console.error('구글 지도 읽기 실패', e.message);
    return send(res, 502, { error: '구글 지도에서 정보를 가져오지 못했어요' });
  }
}

// 예상 못 한 오류도 여기서 막음 (처리 안 된 오류는 함수 프로세스를 통째로 죽여 같이 돌던 요청까지 끊김)
module.exports = async function handler(req, res) {
  try { await handle(req, res); } catch (e) {
    console.error('place 오류', e && e.message);
    if (!res.headersSent) send(res, 500, { error: '잠시 후 다시 시도해 주세요' });
  }
};
// 테스트용 (node에서 require해서 확인)
module.exports.mapsUrl = mapsUrl;
module.exports.nameFromUrl = nameFromUrl;
