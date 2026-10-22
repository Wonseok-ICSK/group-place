/* =====================================================================
   화면 확인용 개발 서버 (가짜 Supabase). 바깥 네트워크에 나가지 않는다.
   index.html 파일은 그대로 두고, 보낼 때만 아래를 바꾼다 (홈 서버 deploy/home/server.cjs와 같은 방식):
     - supabase-js CDN <script>  → /dev/mock/supabase-mock.js (메모리 데이터, 지어낸 사람·방)
     - Pretendard 글꼴 CDN <link> → 뺌 (컴퓨터에 있는 글꼴로 보임)
     - SUPABASE_URL / SUPABASE_KEY → 'https://mock.invalid' / 'mock-key' (설정 안내 화면 대신 앱이 뜨게)
     - LOGIN_ID_DOMAIN → 'mock.invalid' (아이디 로그인), SIGNUP_ENABLED → true (초대 코드로 가입·코드로 참여는 /api/*)
   /api/*는 가짜 Supabase가 브라우저 안에서 받는다(여기까지 오면 404).
   CSP로 같은 주소(127.0.0.1) 말고는 스크립트·연결·이미지를 막아서, 실수로 바깥에 나가려 해도 브라우저가 막는다.
   index.html은 요청마다 다시 읽으니 고친 뒤 새로고침만 하면 된다.

   사용: node dev/mock/serve.mjs [포트]      (기본 8099)
         http://127.0.0.1:8099/?mock=picker   장면은 supabase-mock.js 맨 위 설명 참고
   ===================================================================== */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const HOST = '127.0.0.1'; // 이 컴퓨터에서만
const PORT = Number(process.argv[2] || process.env.PORT || 8099);
const MOCK_DOMAIN = 'mock.invalid'; // supabase-mock.js의 DOMAIN과 같게

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
};
// 인라인 스크립트·스타일은 앱이 원래 씀. data:·blob:은 가짜 사진과 올린 사진 미리보기
const CSP = [
  "default-src 'self'", "script-src 'self' 'unsafe-inline'", "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:", "font-src 'self'", "connect-src 'self'", "manifest-src 'self'",
].join('; ');

// 꼭 한 번 맞아야 함: index.html 모양이 바뀌어서 못 바꾸면 조용히 넘어가지 않고 알려 줌
function replaceOnce(src, re, value, what) {
  const n = (src.match(new RegExp(re.source, `${re.flags.replace('g', '')}g`)) || []).length;
  if (n !== 1) throw new Error(`index.html에서 ${what}을(를) 정확히 한 번 찾지 못했어요 (${n}번)`);
  return src.replace(re, () => value); // 함수로 넘겨 값 속 $ 문자를 그대로 둔다
}
function page() {
  let html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  html = replaceOnce(html, /<script src="https:\/\/cdn\.jsdelivr\.net\/npm\/@supabase\/supabase-js@[^"\n]*"[^>\n]*><\/script>/,
    '<script src="/dev/mock/supabase-mock.js"></script>', 'supabase-js <script>');
  html = replaceOnce(html, /<link rel="stylesheet" href="https:\/\/cdn\.jsdelivr\.net\/gh\/orioncactus\/pretendard[^"\n]*">/, '', 'Pretendard <link>');
  html = replaceOnce(html, /const SUPABASE_URL = '[^'\n]*';/, `const SUPABASE_URL = 'https://${MOCK_DOMAIN}';`, 'SUPABASE_URL');
  html = replaceOnce(html, /const SUPABASE_KEY = '[^'\n]*';/, "const SUPABASE_KEY = 'mock-key';", 'SUPABASE_KEY');
  html = replaceOnce(html, /const LOGIN_ID_DOMAIN = '[^'\n]*';/, `const LOGIN_ID_DOMAIN = '${MOCK_DOMAIN}';`, 'LOGIN_ID_DOMAIN');
  html = replaceOnce(html, /const SIGNUP_ENABLED = (?:true|false);/, 'const SIGNUP_ENABLED = true;', 'SIGNUP_ENABLED');
  // 남은 바깥 주소가 있으면 알려 줌 (og:* 미리보기 주소와 지도 링크·설명 주석은 불러오지 않으니 괜찮음)
  for (const m of html.matchAll(/<(?:script|link)\b[^>]*\b(?:src|href)="(https?:\/\/[^"]+)"/g)) {
    if (!/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(m[1])) console.warn(`[serve] 바깥 주소를 불러오려는 태그가 남았어요: ${m[1]}`);
  }
  return html;
}
// 보내도 되는 파일만 (저장소의 다른 파일·.git은 안 보냄)
function staticFile(urlPath) {
  if (urlPath === '/dev/mock/supabase-mock.js') return path.join(HERE, 'supabase-mock.js');
  if (urlPath === '/manifest.json' || urlPath === '/og.png') return path.join(ROOT, urlPath.slice(1));
  const icon = /^\/icons\/([A-Za-z0-9._-]+)$/.exec(urlPath);
  if (icon && !icon[1].startsWith('.')) return path.join(ROOT, 'icons', icon[1]);
  return null;
}

const server = http.createServer((req, res) => {
  const send = (status, type, body) => {
    res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'content-security-policy': CSP, 'x-content-type-options': 'nosniff' });
    res.end(req.method === 'HEAD' ? undefined : body);
  };
  let urlPath;
  try { urlPath = decodeURIComponent(new URL(req.url, `http://${HOST}`).pathname); } catch { send(400, TYPES['.json'], '{"error":"bad url"}'); return; }
  if (req.method !== 'GET' && req.method !== 'HEAD') { send(404, TYPES['.json'], '{"error":"mock: 이 API는 없어요 (가짜 Supabase가 브라우저에서 받음)"}'); return; }
  if (urlPath === '/' || urlPath === '/index.html') {
    try { send(200, TYPES['.html'], page()); } catch (err) { send(500, 'text/plain; charset=utf-8', String(err.message || err)); console.error(`[serve] ${err.message}`); }
    return;
  }
  const file = staticFile(urlPath);
  if (!file || !fs.existsSync(file)) { send(404, 'text/plain; charset=utf-8', 'not found'); return; }
  send(200, TYPES[path.extname(file)] || 'application/octet-stream', fs.readFileSync(file));
});
server.listen(PORT, HOST, () => {
  console.log(`가짜 Supabase 화면: http://${HOST}:${PORT}/?mock=picker  (장면: picker·two·onboard·login, &go=A|B|C)`);
});
