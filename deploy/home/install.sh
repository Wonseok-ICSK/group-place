#!/usr/bin/env bash
# 홈 서버에서 root로 실행: our-places 친구용 릴리스를 설치하고 바꾼다. 보통은 deploy/home/deploy.ps1이 부른다.
# 사용: sudo bash install.sh <릴리스.tar.gz> <커밋 ID>
#   설정 파일을 만들거나 바꿀 때: sudo SUPABASE_URL=https://<id>.supabase.co SUPABASE_KEY=sb_publishable_... bash install.sh ...
#   (주소와 Publishable key는 공개돼도 되는 값이다. secret·service_role 키는 받지 않는다.
#    초대 코드 가입용 secret key는 서버에서 set-secret.sh로 따로 넣는다: /etc/our-places/secret.env, 이 스크립트는 건드리지 않음)
# 코드: /srv/our-places/releases/<커밋> (root 소유, 서비스 계정은 읽기만), current 심볼릭 링크로 전환.
# 설정: /etc/our-places/env (root:ourplaces 640). 새 릴리스가 응답하지 않으면 유닛 파일과 이전 릴리스로 되돌린다.
set -euo pipefail

die() { echo "ERROR: $*" >&2; exit 2; }
[[ "$(id -u)" == 0 ]] || die 'sudo로 실행하세요'
tarball="${1:-}"
rel="${2:-}"
[[ -f "$tarball" ]] || die "릴리스 파일이 없어요: $tarball"
[[ "$rel" =~ ^[0-9a-f]{7,40}$ ]] || die "커밋 ID가 이상해요: $rel"
base=/srv/our-places
env_dir=/etc/our-places
env_file="$env_dir/env"
default_port=8090
origin_re='^https://[a-z0-9-]+(\.[a-z0-9-]+)+$'
domain_re='^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$'
url_re='^https://[a-z0-9]{20}\.supabase\.co$'
key_re='^sb_publishable_[A-Za-z0-9_-]{10,200}$'
blocked_ref_sha256=(b7ed2b80671cdca9a6b48622040a2143d853dd32baff32ba6abd46ab15719cf4)  # 연결하면 안 되는 Supabase 프로젝트(별도의 비공개 배포). ID 대신 SHA-256만 둔다
units=(our-places.service our-places-keepalive.service our-places-keepalive.timer)

# 동시에 두 번 돌지 않게
exec 9>/run/lock/our-places-install.lock
flock -n 9 || die '다른 설치가 진행 중이에요'

# 중간에 실패해도 임시 파일을 남기지 않는다(각 변수는 mv 뒤에 비운다).
tmp=''
tmp_env=''
unit_backup=''
cleanup() { rm -rf -- "${tmp:-}" "${tmp_env:-}" "${unit_backup:-}"; }
trap cleanup EXIT

# Node 20 이상(Ubuntu 패키지, 유닛은 /usr/bin/node를 쓴다), curl
export DEBIAN_FRONTEND=noninteractive
node_major() { [[ -x /usr/bin/node ]] && /usr/bin/node -p 'process.versions.node.split(".")[0]' || echo 0; }
if (( $(node_major) < 20 )) || ! command -v curl >/dev/null; then
  apt-get update -q
  apt-get install -y -q nodejs curl
fi
(( $(node_major) >= 20 )) || die '/usr/bin/node 20 이상이 필요해요'

getent group ourplaces >/dev/null || groupadd --system ourplaces
id ourplaces >/dev/null 2>&1 || useradd --system --gid ourplaces --home-dir /nonexistent --no-create-home \
  --shell /usr/sbin/nologin ourplaces

install -d -o root -g root -m 755 "$base" "$base/releases"
rm -rf -- "$base"/releases/.new.*  # 예전 실패가 남긴 임시 폴더
target="$base/releases/$rel"
if [[ ! -d "$target" ]]; then
  tmp="$(mktemp -d "$base/releases/.new.XXXXXX")"
  tar -xzf "$tarball" -C "$tmp" --no-same-owner --no-same-permissions
  for f in index.html api/place.js deploy/home/server.cjs deploy/home/signup.cjs deploy/home/public.cjs deploy/home/pages.cjs; do
    [[ -f "$tmp/$f" ]] || die "릴리스에 $f 이 없어요 (index.html, api/place.js, deploy/home/server.cjs·signup.cjs·public.cjs·pages.cjs가 모두 있어야 해요)"
  done
  chown -R root:root "$tmp"
  chmod -R u=rwX,go=rX "$tmp"
  mv -T "$tmp" "$target"
  tmp=''
fi

install -d -o root -g ourplaces -m 750 "$env_dir"
if [[ -n "${SUPABASE_URL:-}" || -n "${SUPABASE_KEY:-}" ]]; then
  [[ "${SUPABASE_URL:-}" =~ $url_re ]] || die 'SUPABASE_URL은 https://<프로젝트 ID 20자>.supabase.co 형식이어야 해요'
  [[ "${SUPABASE_KEY:-}" =~ $key_re ]] || die 'SUPABASE_KEY는 Publishable key(sb_publishable_…)만 받아요'
  ref="${SUPABASE_URL#https://}"
  ref_hash="$(printf '%s' "${ref%%.*}" | sha256sum | cut -d' ' -f1)"
  for blocked in "${blocked_ref_sha256[@]}"; do
    [[ "$ref_hash" != "$blocked" ]] || die '이 서버에 연결하면 안 되는 Supabase 프로젝트예요. 이 배포용 프로젝트 주소를 넣어 주세요'
  done
  # 사이트 주소와 아이디 로그인 주소: 새로 받은 값이 없으면 지금 설정 파일의 값을 그대로 쓴다
  # (LOGIN_ID_DOMAIN이 바뀌면 이미 만든 아이디 계정이 아이디로 로그인되지 않는다)
  old_origin=''
  old_domain=''
  old_public=''
  if [[ -f "$env_file" ]]; then
    old_origin="$(sed -n 's/^PUBLIC_ORIGIN=//p' "$env_file" | tail -n 1)"
    old_domain="$(sed -n 's/^LOGIN_ID_DOMAIN=//p' "$env_file" | tail -n 1)"
    # 공개 방 스위치는 손으로 넣는 값이라 설정 파일을 새로 써도 그대로 옮긴다 (on/off만)
    old_public="$(grep -E '^PUBLIC_(ROOMS|PHOTOS)=(on|off)$' "$env_file" || true)"
  fi
  origin="${PUBLIC_ORIGIN:-$old_origin}"
  login_domain="${LOGIN_ID_DOMAIN:-$old_domain}"
  [[ "$origin" =~ $origin_re ]] || die 'PUBLIC_ORIGIN(사이트 주소, https://…)을 함께 주세요 (deploy.ps1 -PublicOrigin)'
  [[ "$login_domain" =~ $domain_re ]] || die 'LOGIN_ID_DOMAIN(아이디 로그인 주소)을 함께 주세요 (deploy.ps1 -LoginIdDomain)'
  tmp_env="$(mktemp "$env_dir/.env.XXXXXX")"
  printf 'SUPABASE_URL=%s\nSUPABASE_KEY=%s\nPUBLIC_ORIGIN=%s\nPORT=%s\n' \
    "$SUPABASE_URL" "$SUPABASE_KEY" "$origin" "$default_port" >"$tmp_env"
  printf 'LOGIN_ID_DOMAIN=%s\n' "$login_domain" >>"$tmp_env"
  if [[ -n "$old_public" ]]; then printf '%s\n' "$old_public" >>"$tmp_env"; fi
  chown root:ourplaces "$tmp_env"
  chmod 640 "$tmp_env"
  mv -f -- "$tmp_env" "$env_file"
  tmp_env=''
fi
rm -f -- "$env_dir"/.env.*

# 되돌릴 수 있게 지금 유닛 파일과 릴리스를 기억해 둔다.
unit_backup="$(mktemp -d /run/our-places-units.XXXXXX)"
for unit in "${units[@]}"; do
  if [[ -f "/etc/systemd/system/$unit" ]]; then cp -p "/etc/systemd/system/$unit" "$unit_backup/"; fi
done
previous=''
if [[ -L "$base/current" ]]; then previous="$(readlink -e -- "$base/current" || true)"; fi

switch_to() {
  ln -sfn "$1" "$base/.current.new"
  mv -T "$base/.current.new" "$base/current"
}
port="$default_port"
if [[ -f "$env_file" ]]; then
  p="$(sed -n 's/^PORT=//p' "$env_file")"
  [[ "$p" =~ ^[0-9]{4,5}$ ]] && port="$p"
fi
healthy() {  # 설정한 Supabase 주소가 들어간 화면을 실제로 내보내는지
  local url body
  url="$(sed -n 's/^SUPABASE_URL=//p' "$env_file")"
  curl -fsS -m 3 -o /dev/null "http://127.0.0.1:$port/healthz" 2>/dev/null || return 1
  body="$(curl -fsS -m 3 "http://127.0.0.1:$port/" 2>/dev/null)" || return 1
  [[ -n "$url" && "$body" == *"const SUPABASE_URL = '$url';"* ]]
}
wait_healthy() {
  local _
  for _ in $(seq 1 20); do
    if healthy; then return 0; fi
    sleep 1
  done
  return 1
}
rolled_back=0
rollback() {
  trap - ERR
  (( rolled_back )) && return
  rolled_back=1
  echo '새 릴리스가 응답하지 않아요: journalctl -u our-places -n 30' >&2
  for unit in "${units[@]}"; do
    if [[ -f "$unit_backup/$unit" ]]; then cp -p "$unit_backup/$unit" "/etc/systemd/system/$unit"; fi
  done
  systemctl daemon-reload || true
  if [[ -n "$previous" && "$previous" == "$base"/releases/* && -d "$previous" && "$previous" != "$target" ]]; then
    switch_to "$previous"
    systemctl restart our-places.service || true
    if [[ -f "$env_file" ]] && wait_healthy; then
      echo "이전 릴리스로 되돌렸고 정상 응답해요: $previous" >&2
    else
      echo "이전 릴리스로 되돌렸지만 응답이 없어요: $previous (journalctl -u our-places)" >&2
    fi
  fi
}

for unit in "${units[@]}"; do
  install -m 644 -o root -g root "$target/deploy/home/$unit" "/etc/systemd/system/$unit"
done
systemctl daemon-reload
switch_to "$target"
trap 'rollback; exit 1' ERR
systemctl enable --quiet our-places.service our-places-keepalive.timer
if [[ ! -f "$env_file" ]]; then
  trap - ERR
  echo "코드는 설치했지만 $env_file 이 없어 서비스를 시작하지 않았어요."
  echo "친구용 Supabase 주소와 Publishable key를 넣어 다시 실행하세요 (deploy.ps1 -SupabaseUrl ... -SupabaseKey ...)."
  exit 0
fi

systemctl restart our-places.service || true  # 성공 여부는 아래 응답 확인으로 판단
if ! wait_healthy; then
  rollback
  exit 1
fi
trap - ERR

systemctl restart our-places-keepalive.timer  # enable만으로는 다음 부팅까지 타이머가 돌지 않는다
if ! systemctl start our-places-keepalive.service; then
  echo '경고: keepalive 호출 실패. 친구용 프로젝트에 supabase/friends-keepalive.sql을 실행했는지 확인하세요.' >&2
fi

# 릴리스는 최근 3개만 남긴다(지금 쓰는 것은 항상 남김).
current_real="$(readlink -e -- "$base/current")"
while IFS= read -r old; do
  [[ "$(readlink -e -- "$old")" == "$current_real" ]] || rm -rf -- "$old"
done < <(ls -1dt "$base"/releases/*/ | tail -n +4)

echo "our-places $rel 설치 완료 ($(curl -fsS -m 3 "http://127.0.0.1:$port/healthz"))"
if [[ -f "$env_dir/secret.env" ]]; then
  echo "가입 코드 만들기: sudo bash $base/current/deploy/home/invite.sh new <메모>"
  if grep -qx 'PUBLIC_ROOMS=on' "$env_file" 2>/dev/null; then
    echo "공개 방: 켬 (목록·숨기기: sudo bash $base/current/deploy/home/public.sh list)"
  else
    echo "공개 방: 꺼 둠. 켜려면 $env_file 에 PUBLIC_ROOMS=on 을 넣고 sudo systemctl restart our-places"
  fi
else
  echo "초대 코드 가입은 꺼져 있어요. 켜려면: ssh -t <서버> \"sudo bash $base/current/deploy/home/set-secret.sh\""
fi
