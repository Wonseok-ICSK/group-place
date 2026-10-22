// 친구용 홈 서버가 시작할 때 쓰는 순수 함수들 (server.cjs는 읽자마자 서버를 띄우므로 시험은 이 파일을 부른다).
//   replaceOnce: index.html의 정해진 줄이 정확히 하나일 때만 바꿈(아니면 throw → server.cjs가 설정 오류로 멈춤)
//   buildPages: SIGNUP_ENABLED × PUBLIC_ROOMS_ENABLED 네 벌의 화면 (docs/public-rooms-design.md §3.2)
//   publicConfig: PUBLIC_ROOMS / PUBLIC_PHOTOS / PUBLIC_ANON 설정 확인 (§3.1)
//   isRoomLink: /r/<공개 키> 경로인지 (§3.3)
'use strict';

const ROOM_LINK_RE = /^\/r\/[a-km-np-z2-9]{10}$/;
const SIGNUP_RE = /const SIGNUP_ENABLED = (?:true|false);/;
const PUBLIC_RE = /const PUBLIC_ROOMS_ENABLED = (?:true|false);/;

function replaceOnce(src, re, value, what) {
  const count = (src.match(new RegExp(re.source, 'g')) || []).length;
  if (count !== 1) throw new Error(`index.html에서 ${what} 줄을 정확히 하나 찾지 못했어요 (${count}개)`);
  return src.replace(re, () => value); // 함수로 넘겨 값 속 $ 문자를 그대로 둔다
}

// 네 벌을 미리 만든다. get(가입 켬, 공개 방 켬) → Buffer
function buildPages(html) {
  const pages = [false, true].map((signup) => {
    const s = replaceOnce(html, SIGNUP_RE, `const SIGNUP_ENABLED = ${signup};`, 'SIGNUP_ENABLED');
    return [false, true].map((pub) => Buffer.from(replaceOnce(s, PUBLIC_RE, `const PUBLIC_ROOMS_ENABLED = ${pub};`, 'PUBLIC_ROOMS_ENABLED'), 'utf8'));
  });
  return { get: (signup, pub) => pages[signup ? 1 : 0][pub ? 1 : 0] };
}

// on|off 설정 하나. 비어 있으면 기본값, 그 밖의 값은 throw
function onOff(env, name, def) {
  const raw = env[name];
  if (raw === undefined || String(raw).trim() === '') return def;
  const v = String(raw).trim();
  if (v !== 'on' && v !== 'off') throw new Error(`${name}는 on 또는 off여야 해요`);
  return v === 'on';
}

// → { rooms, photos, stateDir }. PUBLIC_ANON=on은 v0.2.0에서 받지 않는다(§10을 끝낸 버전에서 푼다)
function publicConfig(env) {
  const rooms = onOff(env, 'PUBLIC_ROOMS', false);
  const photos = onOff(env, 'PUBLIC_PHOTOS', true);
  if (onOff(env, 'PUBLIC_ANON', false)) throw new Error('PUBLIC_ANON은 아직 켤 수 없어요(docs/public-rooms-design.md §10)');
  // systemd StateDirectory=our-places → STATE_DIRECTORY=/var/lib/our-places (여러 개면 콜론으로 이어짐, 첫 번째만)
  const dir = String(env.STATE_DIRECTORY || '').split(':')[0].trim();
  return { rooms, photos, stateDir: dir.startsWith('/') || /^[A-Za-z]:[\\/]/.test(dir) ? dir : '' };
}

const isRoomLink = (pathname) => ROOM_LINK_RE.test(pathname);

module.exports = { replaceOnce, buildPages, publicConfig, isRoomLink, ROOM_LINK_RE };
