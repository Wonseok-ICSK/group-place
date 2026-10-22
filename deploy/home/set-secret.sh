#!/usr/bin/env bash
# 홈 서버에서 root로 실행: 친구용 Supabase secret key(sb_secret_…)를 넣거나 지워서 '초대 코드로 가입'을 켜고 끈다.
# 사용(키는 화면에 안 보이게 입력하므로 ssh -t로):
#   ssh -t wonseok-home "sudo bash /srv/our-places/current/deploy/home/set-secret.sh"            키 넣기(바꾸기)
#   ssh -t wonseok-home "sudo bash /srv/our-places/current/deploy/home/set-secret.sh --remove"   키 지우고 가입 끄기
# 먼저 친구용 프로젝트 SQL Editor에서 supabase/friends-signup.sql을 실행해 둔다.
# 키는 /etc/our-places/secret.env(root:ourplaces 640)에만 저장한다. 명령줄 인자·로그·화면에 남기지 않는다
# (curl에는 -K -로 표준 입력을 통해 헤더를 넘긴다).
set -euo pipefail
umask 077

die() { echo "ERROR: $*" >&2; exit 2; }
[[ "$(id -u)" == 0 ]] || die 'sudo로 실행하세요'
env_dir=/etc/our-places
env_file="$env_dir/env"
secret_file="$env_dir/secret.env"
[[ -f "$env_file" ]] || die "$env_file 이 없어요. 먼저 deploy.ps1로 설치하세요"
url="$(sed -n 's/^SUPABASE_URL=//p' "$env_file")"
[[ "$url" =~ ^https://[a-z0-9]{20}\.supabase\.co$ ]] || die "$env_file 의 SUPABASE_URL이 이상해요"
port="$(sed -n 's/^PORT=//p' "$env_file")"
[[ "$port" =~ ^[0-9]{4,5}$ ]] || port=8090

tmp=''
key=''
cleanup() { rm -f -- "${tmp:-}"; key=''; }
trap cleanup EXIT

# 서버가 지금 내보내는 화면에 SIGNUP_ENABLED = <true|false>가 보일 때까지 최대 20초 기다림
wait_signup() {
  local want="$1" body _
  for _ in $(seq 1 20); do
    body="$(curl -fsS -m 3 "http://127.0.0.1:$port/" 2>/dev/null)" || body=''
    if [[ "$body" == *"const SIGNUP_ENABLED = $want;"* ]]; then return 0; fi
    sleep 1
  done
  return 1
}

case "${1:-}" in
  --remove)
    rm -f -- "$secret_file"
    systemctl restart our-places.service
    if wait_signup false; then
      echo '초대 코드로 가입을 껐어요 (secret key를 지웠어요).'
      echo '키를 아예 못 쓰게 하려면 Supabase → Project Settings → API Keys에서 그 secret key를 삭제하세요.'
      exit 0
    fi
    die '서버가 응답하지 않아요: journalctl -u our-places -n 30'
    ;;
  '') ;;
  *) die '사용: set-secret.sh [--remove]' ;;
esac

[[ -t 0 ]] || die '키는 터미널에서 직접 입력해야 해요: ssh -t wonseok-home "sudo bash .../set-secret.sh"'
command -v curl >/dev/null || die 'curl이 필요해요'

echo "친구용 프로젝트($url)의 secret key를 넣어요."
echo 'Supabase → Project Settings → API Keys → Secret keys에서 복사한 sb_secret_… 값을 붙여넣고 Enter (화면에 안 보여요).'
printf 'secret key: '
IFS= read -rs key || die '입력이 없어요'
echo
key="${key//[[:space:]]/}"  # 붙여넣을 때 섞인 공백·줄바꿈 제거
[[ "$key" =~ ^sb_secret_[A-Za-z0-9_-]{10,200}$ ]] || die 'sb_secret_로 시작하는 secret key가 아니에요 (publishable key나 예전 service_role JWT는 안 받아요)'

# 키를 표준 입력(curl 설정)으로 넘겨 요청: ps나 명령 기록에 남지 않게. 결과는 HTTP 코드만
supabase_code() {  # supabase_code <방법> <경로> [JSON 본문]
  local method="$1" path="$2" code
  local -a body=()
  if [[ -n "${3:-}" ]]; then body=(-H 'content-type: application/json' --data-binary "$3"); fi
  code="$(printf 'header = "apikey: %s"\nheader = "Authorization: Bearer %s"\n' "$key" "$key" \
    | curl -sS -m 15 -o /dev/null -w '%{http_code}' -K - -X "$method" "${body[@]}" "$url$path" 2>/dev/null)" || code=000
  echo "$code"
}

echo '확인 중…'
code="$(supabase_code GET '/auth/v1/admin/users?page=1&per_page=1')"
case "$code" in
  200) ;;
  401|403) die '이 프로젝트의 secret key가 아니거나 삭제된 키예요. 친구용 프로젝트에서 다시 복사해 주세요' ;;
  000) die 'Supabase에 연결하지 못했어요. 인터넷 연결을 확인하고 다시 실행하세요' ;;
  *) die "키를 확인하지 못했어요 (관리자 API HTTP $code)" ;;
esac
code="$(supabase_code POST /rest/v1/rpc/space_code_open '{"p_code":"00000000"}')"
case "$code" in
  200) ;;
  404) die '친구용 프로젝트에 supabase/friends-signup.sql을 아직 실행하지 않았어요. SQL Editor에서 실행한 뒤 다시 하세요' ;;
  *) die "가입 함수를 확인하지 못했어요 (HTTP $code)" ;;
esac

# 같은 폴더에 임시 파일로 쓰고 한 번에 바꿈(반쯤 쓴 파일을 서비스가 읽지 않게)
tmp="$(mktemp "$env_dir/.secret.XXXXXX")"
printf 'SUPABASE_SECRET_KEY=%s\n' "$key" >"$tmp"
key=''
chown root:ourplaces "$tmp"
chmod 640 "$tmp"
mv -f -- "$tmp" "$secret_file"
tmp=''

systemctl restart our-places.service
if wait_signup true; then
  site="$(sed -n 's/^PUBLIC_ORIGIN=//p' /etc/our-places/env 2>/dev/null | tail -n 1)"
  echo "초대 코드로 가입을 켰어요: ${site:-사이트} 로그인 화면의 '초대 코드로 가입'."
  echo '가입 코드 만들기: sudo bash /srv/our-places/current/deploy/home/invite.sh new <메모>'
else
  echo '키는 저장했지만 화면에 가입이 켜지지 않았어요: journalctl -u our-places -n 30' >&2
  exit 1
fi
