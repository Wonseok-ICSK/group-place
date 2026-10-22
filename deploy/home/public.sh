#!/usr/bin/env bash
# 홈 서버에서 root로 실행: 공개 방 목록 보기와 관리자 숨기기 (docs/public-rooms-design.md §3.7).
# secret key(/etc/our-places/secret.env, set-secret.sh가 넣음)로 supabase/public.sql의 admin_* 함수를 부른다.
# 사용:
#   ssh wonseok-home "sudo bash /srv/our-places/current/deploy/home/public.sh list"              공개 방 목록
#   ssh wonseok-home "sudo bash /srv/our-places/current/deploy/home/public.sh hide k7m2p9xa4c"   둘러보기·보기 링크에서 숨김
#   ssh wonseok-home "sudo bash /srv/our-places/current/deploy/home/public.sh show k7m2p9xa4c"   숨김 풀기
# 숨기기·풀기 뒤에는 서비스를 다시 시작해 서버 캐시(방 2분·목록 1분)를 비운다. 멤버는 그대로 쓸 수 있다.
# 내보내기(kick)·코드 바꾸기(rotate)는 없다(방장이 앱에서 초대 코드를 다시 만든다).
# 키는 화면·명령줄 인자에 남기지 않는다(curl에는 -K -로 표준 입력을 통해 헤더를 넘김).
set -euo pipefail
umask 077

die() { echo "ERROR: $*" >&2; exit 2; }
usage() { die '사용: public.sh list | hide <공개 키> | show <공개 키>'; }
[[ "$(id -u)" == 0 ]] || die 'sudo로 실행하세요'
command -v curl >/dev/null || die 'curl이 필요해요'
command -v jq >/dev/null || die 'jq가 필요해요 (sudo apt-get install -y jq)'
env_file=/etc/our-places/env
secret_file=/etc/our-places/secret.env
[[ -f "$env_file" ]] || die "$env_file 이 없어요. 먼저 deploy.ps1로 설치하세요"
[[ -f "$secret_file" ]] || die "secret key가 없어요. 먼저 set-secret.sh로 넣으세요"
url="$(sed -n 's/^SUPABASE_URL=//p' "$env_file")"
[[ "$url" =~ ^https://[a-z0-9]{20}\.supabase\.co$ ]] || die "$env_file 의 SUPABASE_URL이 이상해요"
key="$(sed -n 's/^SUPABASE_SECRET_KEY=//p' "$secret_file")"
[[ "$key" =~ ^sb_secret_[A-Za-z0-9_-]{10,200}$ ]] || die "$secret_file 의 키 형식이 이상해요. set-secret.sh로 다시 넣으세요"
trap 'key=""' EXIT

# rpc <함수> <JSON 본문>: 성공하면 응답 본문을 출력, 실패하면 이유를 알리고 끝냄
rpc() {
  local fn="$1" data="$2" resp code body
  resp="$(printf 'header = "apikey: %s"\nheader = "Authorization: Bearer %s"\n' "$key" "$key" \
    | curl -sS -m 15 -w '\n%{http_code}' -K - -X POST -H 'content-type: application/json' \
        --data-binary "$data" "$url/rest/v1/rpc/$fn" 2>/dev/null)" || die 'Supabase에 연결하지 못했어요'
  code="${resp##*$'\n'}"
  body="${resp%$'\n'*}"
  case "$code" in
    200) printf '%s' "$body" ;;
    401|403) die 'secret key가 맞지 않아요. set-secret.sh로 다시 넣으세요' ;;
    404) die '친구용 프로젝트에 supabase/public.sql을 먼저 실행하세요' ;;
    *) die "요청 실패 (HTTP $code): $(jq -r '.message // empty' <<<"$body" 2>/dev/null || true)" ;;
  esac
}

# 공개 키: 소문자·숫자 10자 (l·o·0·1 없음). 초대 코드(8자리 대문자)와 헷갈리지 않게 이 형식만 받는다
check_key() { [[ "${1:-}" =~ ^[a-km-np-z2-9]{10}$ ]] || die "공개 키 형식이 아니에요(소문자·숫자 10자): ${1:-}"; }

set_hidden() {
  local k="$1" hidden="$2" ok
  check_key "$k"
  ok="$(rpc admin_set_room_hidden "$(jq -nc --arg key "$k" --argjson hidden "$hidden" '{p_key: $key, p_hidden: $hidden}')")"
  [[ "$ok" == true ]] || die "그 공개 키의 방이 없어요: $k"
  systemctl restart our-places.service || die '바꿨지만 서비스를 다시 시작하지 못했어요 (캐시는 2분 안에 비워져요)'
}

cmd="${1:-}"
case "$cmd" in
  list)
    [[ $# -eq 1 ]] || usage
    # 방 이름 속 제어 문자(터미널을 조작하는 ESC 등)는 ?로 바꿔서 출력
    rpc admin_public_rooms '{}' | jq -r '
      def clean: gsub("[[:cntrl:]]"; "?");
      if length == 0 then "공개 방이 없어요."
      else (["공개 키", "이름", "숨김", "멤버", "장소", "만든 때"] | @tsv),
           (.[] | [.key, (.name // "" | clean), (.hidden_at // "-"), (.members | tostring), (.places | tostring), .created_at] | @tsv)
      end'
    ;;
  hide)
    [[ $# -eq 2 ]] || usage
    set_hidden "$2" true
    echo "숨겼어요: $2 (둘러보기 목록·보기 링크에서 안 보임, 멤버는 그대로 씀)"
    ;;
  show)
    [[ $# -eq 2 ]] || usage
    set_hidden "$2" false
    echo "숨김을 풀었어요: $2"
    ;;
  *) usage ;;
esac
