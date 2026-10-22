// 친구용 홈 서버: Vercel이 하던 일(정적 파일 + POST /api/place)과 친구용 '초대 코드로 가입'(POST /api/signup),
// 앱 안에서 방 코드로 참여(POST /api/join, 친구용 DB는 join_couple을 앱에서 직접 못 부름)를 맡는다.
// 로그인·데이터·사진은 친구용 Supabase 프로젝트가 맡고, 이 서버는 그 주소와 공개 키를 index.html에 넣어 줄 뿐이다.
// 저장소의 index.html에는 자리표시값이 들어 있고, 보낼 때만 아래 줄들을 설정값으로 바꾼다. 파일 자체는 고치지 않는다.
//   const SUPABASE_URL / const SUPABASE_KEY / og:url / og:image / const LOGIN_ID_DOMAIN / const SIGNUP_ENABLED
// 환경 변수(/etc/our-places/env): SUPABASE_URL, SUPABASE_KEY(Publishable key), PUBLIC_ORIGIN, PORT(기본 8090),
//   LOGIN_ID_DOMAIN(아이디 로그인용 주소, 예: id.example.com. 이미 만든 아이디 계정이 이 주소로 되어 있으니 바꾸지 않는다)
// 선택(/etc/our-places/secret.env, set-secret.sh가 씀): SUPABASE_SECRET_KEY. 있으면 확인한 뒤에만 가입과 앱 안 코드 참여를 켠다
//   (없으면 친구용 앱에서는 방 코드로 참여가 안 된다. 방 만들기는 된다).
// 127.0.0.1에서만 받고, 밖에서는 Cloudflare Tunnel 같은 리버스 프록시(PUBLIC_ORIGIN)로만 들어온다.
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createSignupApi, verifySecretKey } = require('./signup.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT || 8090);
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_KEY || '';
const PUBLIC_ORIGIN = process.env.PUBLIC_ORIGIN || '';
const LOGIN_ID_DOMAIN = (process.env.LOGIN_ID_DOMAIN || '').trim().toLowerCase();
const SECRET_KEY = (process.env.SUPABASE_SECRET_KEY || '').trim();
delete process.env.SUPABASE_SECRET_KEY; // api/place.js 등 다른 코드는 읽을 일이 없으니 환경에서 치운다
// 이 서버에 연결하면 안 되는 Supabase 프로젝트(별도의 비공개 배포). 공개 저장소라 프로젝트 ID 대신 SHA-256만 둔다.
const BLOCKED_PROJECT_REF_SHA256 = ['b7ed2b80671cdca9a6b48622040a2143d853dd32baff32ba6abd46ab15719cf4'];
const CONFIG_ERROR = 78; // our-places.service의 RestartPreventExitStatus: 설정 오류면 다시 시작하지 않는다

function fail(message) {
  console.error(`설정 오류: ${message}`);
  process.exit(CONFIG_ERROR);
}
if (!/^https:\/\/[a-z0-9]{20}\.supabase\.co$/.test(SUPABASE_URL)) fail('SUPABASE_URL은 https://<프로젝트 ID 20자>.supabase.co 형식이어야 해요');
if (!/^sb_publishable_[A-Za-z0-9_-]{10,200}$/.test(SUPABASE_KEY)) fail('SUPABASE_KEY는 Publishable key(sb_publishable_…)여야 해요. secret·service_role 키는 넣지 마세요');
if (!/^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(PUBLIC_ORIGIN)) fail('PUBLIC_ORIGIN은 https://주소 형식이어야 해요(끝에 / 없이)');
if (!Number.isInteger(PORT) || PORT < 1024 || PORT > 65535) fail('PORT가 올바르지 않아요');
const projectRef = SUPABASE_URL.slice('https://'.length, 'https://'.length + 20);
if (BLOCKED_PROJECT_REF_SHA256.includes(crypto.createHash('sha256').update(projectRef).digest('hex'))) fail('이 서버에 연결하면 안 되는 Supabase 프로젝트예요. 이 배포용 프로젝트 주소를 넣어 주세요');
if (!/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(LOGIN_ID_DOMAIN)) fail('LOGIN_ID_DOMAIN을 id.example.com 같은 주소로 설정하세요(/etc/our-places/env)');
// secret key는 없거나 틀려도 사이트는 연다(가입만 꺼 둔다). 이유만 남기고 키 값은 어디에도 남기지 않는다.
let signupOff = SECRET_KEY ? '' : 'secret key 없음';
if (SECRET_KEY && !/^sb_secret_[A-Za-z0-9_-]{10,200}$/.test(SECRET_KEY)) signupOff = 'SUPABASE_SECRET_KEY가 sb_secret_… 형식이 아니에요';

// index.html: 정해진 줄이 정확히 하나씩 있을 때만 바꾼다. 앱이 바뀌어 못 찾으면 자리표시값 그대로 뜨지 않게 아예 멈춘다.
const raw = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
function replaceOnce(src, re, value, what) {
  const count = (src.match(new RegExp(re.source, 'g')) || []).length;
  if (count !== 1) fail(`index.html에서 ${what} 줄을 정확히 하나 찾지 못했어요 (${count}개)`);
  return src.replace(re, () => value); // 함수로 넘겨 값 속 $ 문자를 그대로 둔다
}
let html = raw;
html = replaceOnce(html, /const SUPABASE_URL = '[^'\n]*';/, `const SUPABASE_URL = '${SUPABASE_URL}';`, 'SUPABASE_URL');
html = replaceOnce(html, /const SUPABASE_KEY = '[^'\n]*';/, `const SUPABASE_KEY = '${SUPABASE_KEY}';`, 'SUPABASE_KEY');
html = replaceOnce(html, /<meta property="og:url" content="[^"\n]*">/, `<meta property="og:url" content="${PUBLIC_ORIGIN}/">`, 'og:url');
html = replaceOnce(html, /<meta property="og:image" content="[^"\n]*">/, `<meta property="og:image" content="${PUBLIC_ORIGIN}/og.png">`, 'og:image');
html = replaceOnce(html, /const LOGIN_ID_DOMAIN = '[^'\n]*';/, `const LOGIN_ID_DOMAIN = '${LOGIN_ID_DOMAIN}';`, 'LOGIN_ID_DOMAIN');
// 원본 index.html에 실제 값(프로젝트 ID, 공개 키, 사이트 주소)이 들어 있었다면, 보낼 화면에 그 값이 남아 있을 때 멈춘다.
// 자리표시값(YOUR-PROJECT, YOUR_KEY, YOUR-SITE)은 앱 안의 설정 확인 문구에도 쓰이므로 이 검사에서 뺀다.
const originalUrl = (/const SUPABASE_URL = '([^'\n]*)';/.exec(raw) || [])[1] || '';
const originalKey = (/const SUPABASE_KEY = '([^'\n]*)';/.exec(raw) || [])[1] || '';
const originalSite = ((/<meta property="og:url" content="([^"\n]*)">/.exec(raw) || [])[1] || '').replace(/\/+$/, '');
const originalRef = (/^https:\/\/([a-z0-9]+)\.supabase\.co/.exec(originalUrl) || [])[1] || '';
// 설정값이 index.html에 들어 있던 값 그대로면 시작하지 않는다.
if (SUPABASE_URL === originalUrl || SUPABASE_KEY === originalKey) fail('index.html에 들어 있는 값과 같아요. 이 배포용 Supabase 프로젝트의 주소와 키를 넣어 주세요');
const realKey = /^sb_publishable_/.test(originalKey) ? originalKey : '';
const realSite = /YOUR-SITE/.test(originalSite) ? '' : originalSite;
for (const [old, fresh, what] of [[originalRef, SUPABASE_URL, '원래 Supabase 프로젝트 ID'], [realKey, SUPABASE_KEY, '원래 공개 키'], [realSite, PUBLIC_ORIGIN, '원래 사이트 주소']]) {
  if (old && !fresh.includes(old) && html.includes(old)) fail(`보낼 index.html에 ${what}가 남아 있어요`);
}
// 가입 화면(SIGNUP_ENABLED)은 secret key 확인이 끝나야 켠다: 끈 화면으로 시작했다가, 확인되면 켠 화면으로 바꾼다.
const SIGNUP_RE = /const SIGNUP_ENABLED = (?:true|false);/;
const pageSignupOff = Buffer.from(replaceOnce(html, SIGNUP_RE, 'const SIGNUP_ENABLED = false;', 'SIGNUP_ENABLED'), 'utf8');
const pageSignupOn = Buffer.from(replaceOnce(html, SIGNUP_RE, 'const SIGNUP_ENABLED = true;', 'SIGNUP_ENABLED'), 'utf8');

// 보낼 파일은 시작할 때 전부 메모리에 올린다. 목록에 없는 경로는 404라서 저장소의 다른 파일(.git, api 소스 등)은 나가지 않는다.
const TYPES = { '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml' };
const files = new Map();
function addFile(urlPath, body, ext, cache) {
  files.set(urlPath, { body, type: TYPES[ext], cache });
}
function setPage(page) {
  addFile('/', page, '.html', 'no-cache');
  addFile('/index.html', page, '.html', 'no-cache');
}
setPage(pageSignupOff);
addFile('/manifest.json', fs.readFileSync(path.join(ROOT, 'manifest.json')), '.json', 'public, max-age=3600');
addFile('/og.png', fs.readFileSync(path.join(ROOT, 'og.png')), '.png', 'public, max-age=86400');
for (const name of fs.readdirSync(path.join(ROOT, 'icons'))) {
  if (/^[a-z0-9-]+\.(png|svg)$/.test(name)) {
    addFile(`/icons/${name}`, fs.readFileSync(path.join(ROOT, 'icons', name)), path.extname(name), 'public, max-age=86400');
  }
}

// api/place.js는 Vercel용 그대로 쓴다(process.env의 SUPABASE_URL/KEY로 로그인 확인, 본문 4096자 제한).
const place = require(path.join(ROOT, 'api', 'place.js'));

// 초대 코드로 가입·참여: secret key가 있을 때만 만들고, verifySecretKey가 통과해야 받는다(그 전엔 503).
const api = signupOff ? null : createSignupApi({
  supabaseUrl: SUPABASE_URL, publishableKey: SUPABASE_KEY, secretKey: SECRET_KEY, idDomain: LOGIN_ID_DOMAIN, allowedOrigin: PUBLIC_ORIGIN,
});
let signupReady = false;
const RETRY_MS = [30_000, 120_000, 600_000, 1_800_000, 3_600_000]; // 연결 문제면 점점 길게 다시 확인(마지막 값으로 계속)
async function enableSignup(attempt = 0) {
  let r;
  try {
    r = await verifySecretKey({ supabaseUrl: SUPABASE_URL, secretKey: SECRET_KEY });
  } catch {
    r = { ok: false, retry: true, reason: '확인 중 오류' };
  }
  if (r.ok) {
    signupReady = true;
    setPage(pageSignupOn);
    console.log('초대 코드로 가입: 켬');
    return;
  }
  if (!r.retry) { console.error(`초대 코드로 가입: 꺼 둠 (${r.reason})`); return; }
  const wait = RETRY_MS[Math.min(attempt, RETRY_MS.length - 1)];
  console.error(`초대 코드로 가입: 아직 꺼 둠 (${r.reason}), ${Math.round(wait / 1000)}초 뒤 다시 확인`);
  setTimeout(() => { enableSignup(attempt + 1); }, wait).unref();
}

const SECURITY = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'x-frame-options': 'DENY',
};

function sendText(res, status, text, extra = {}) {
  res.writeHead(status, { ...SECURITY, 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', ...extra });
  res.end(text);
}

const server = http.createServer((req, res) => {
  const pathname = (req.url || '/').split('?')[0];
  if (pathname === '/api/place') {
    if (Number(req.headers['content-length'] || 0) > 8192) return sendText(res, 413, '요청이 너무 커요');
    for (const [k, v] of Object.entries(SECURITY)) res.setHeader(k, v);
    return void place(req, res); // handler가 스스로 오류를 잡아 응답한다
  }
  if (pathname === '/api/signup' || pathname === '/api/join') {
    if (!api) return sendText(res, 404, '찾을 수 없어요');
    const join = pathname === '/api/join';
    if (!signupReady) {
      res.writeHead(503, { ...SECURITY, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'retry-after': '60' });
      const what = join ? '코드로 참여할' : '가입을 받을';
      return void res.end(JSON.stringify({ error: `지금은 ${what} 수 없어요. 잠시 후 다시 시도해 주세요.` }));
    }
    return void (join ? api.join : api.signup)(req, res); // 크기·형식·횟수 제한과 오류 응답은 signup.cjs가 한다
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return sendText(res, 405, 'GET만 받아요', { allow: 'GET, HEAD' });
  if (pathname === '/healthz') return sendText(res, 200, 'ok');
  const file = files.get(pathname);
  if (!file) return sendText(res, 404, '찾을 수 없어요');
  res.writeHead(200, { ...SECURITY, 'content-type': file.type, 'cache-control': file.cache, 'content-length': file.body.length });
  res.end(req.method === 'HEAD' ? undefined : file.body);
});
server.headersTimeout = 10_000;
server.requestTimeout = 30_000;
server.keepAliveTimeout = 120_000; // cloudflared가 연결을 90초까지 다시 쓰므로 그보다 길게(짧으면 가끔 502)
server.listen(PORT, HOST, () => {
  console.log(`our-places 친구용 서버: http://${HOST}:${PORT} (Supabase ${new URL(SUPABASE_URL).hostname}, 공개 주소 ${PUBLIC_ORIGIN}, 아이디 로그인 @${LOGIN_ID_DOMAIN}, 파일 ${files.size}개)`);
  if (api) enableSignup();
  else console.log(`초대 코드로 가입: 꺼 둠 (${signupOff})`);
});
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5_000).unref();
  });
}
