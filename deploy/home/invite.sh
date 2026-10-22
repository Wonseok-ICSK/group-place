#!/usr/bin/env bash
# 홈 서버에서 root로 실행: 친구용 가입 코드(W-XXXX-XXXX) 만들기·목록·취소.
# secret key(/etc/our-places/secret.env, set-secret.sh가 넣음)로 supabase/friends-signup.sql의 함수를 부른다.
# 사용:
#   ssh wonseok-home "sudo bash /srv/our-places/current/deploy/home/invite.sh new 민수"      7일짜리 코드 (메모: 민수)
#   ssh wonseok-home "sudo bash /srv/our-places/current/deploy/home/invite.sh new 민수 3"    3일짜리
#   ssh wonseok-home "sudo bash /srv/our-places/current/deploy/home/invite.sh list"          목록
#   ssh wonseok-home "sudo bash /srv/our-places/current/deploy/home/invite.sh revoke W-7KQ2-XM9A"   안 쓴 코드 취소
# 키는 화면·명령줄 인자에 남기지 않는다(curl에는 -K -로 표준 입력을 통해 헤더를 넘김).
set -euo pipefail
umask 077

die() { echo "ERROR: $*" >&2; exit 2; }
usage() { die '사용: invite.sh new <메모> [유효 일수 1~90, 기본 7] | list | revoke <코드>'; }
[[ "$(id -u)" == 0 ]] || die 'sudo로 실행하세요'
command -v curl >/dev/null || die 'curl이 필요해요'
command -v jq >/dev/null || die 'jq가 필요해요 (sudo apt-get install -y jq)'
env_file=/etc/our-places/env
secret_file=/etc/our-places/secret.env
[[ -f "$env_file" ]] || die "$env_file 이 없어요. 먼저 deploy.ps1로 설치하세요"
[[ -f "$secret_file" ]] || die "secret key가 없어요. 먼저 set-secret.sh로 넣거나, Supabase SQL Editor에서 select public.new_signup_invite('메모'); 로 만드세요"
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
    404) die '친구용 프로젝트에 supabase/friends-signup.sql을 먼저 실행하세요' ;;
    *) die "요청 실패 (HTTP $code): $(jq -r '.message // empty' <<<"$body" 2>/dev/null || true)" ;;
  esac
}

cmd="${1:-}"
case "$cmd" in
  new)
    note="${2:-}"
    days="${3:-7}"
    [[ -n "$note" ]] || die '누구에게 줄 코드인지 메모를 적어 주세요: invite.sh new 민수'
    (( ${#note} <= 100 )) || die '메모는 100자까지예요'
    [[ "$days" =~ ^[0-9]{1,2}$ ]] || die '유효 일수는 1~90이에요'
    days=$((10#$days))  # 08 같은 입력도 10진수로
    (( days >= 1 && days <= 90 )) || die '유효 일수는 1~90이에요'
    code="$(rpc new_signup_invite "$(jq -nc --arg note "$note" --argjson days "$days" '{p_note: $note, p_days: $days}')" | jq -r '.')"
    [[ "$code" =~ ^W-[A-Z0-9]{4}-[A-Z0-9]{4}$ ]] || die "코드를 받지 못했어요: $code"
    echo "가입 코드: $code  (메모: $note, ${days}일 동안 한 번)"
    site="$(sed -n 's/^PUBLIC_ORIGIN=//p' /etc/our-places/env 2>/dev/null | tail -n 1)"
    echo "친구에게: ${site:-사이트} → '초대 코드로 가입'에 이 코드를 넣어 주세요."
    ;;
  list)
    [[ $# -eq 1 ]] || usage
    # 메모·아이디 속 제어 문자(터미널을 조작하는 ESC 등)는 ?로 바꿔서 출력 (@tsv는 탭·줄바꿈·\만 바꿈)
    rpc list_signup_invites '{}' | jq -r '
      def clean: gsub("[[:cntrl:]]"; "?");
      if length == 0 then "가입 코드가 없어요."
      else (["코드", "상태", "메모", "만료", "가입한 아이디"] | @tsv),
           (.[] | [.code, .status, (.note // "" | clean), .expires_at, (.username // "" | clean)] | @tsv)
      end'
    ;;
  revoke)
    [[ $# -eq 2 && -n "$2" ]] || usage
    ok="$(rpc revoke_signup_invite "$(jq -nc --arg code "$2" '{p_code: $code}')")"
    if [[ "$ok" == true ]]; then echo "취소했어요: $2"; else die "취소할 수 없어요 (없는 코드거나 이미 쓰였거나 이미 취소됨): $2"; fi
    ;;
  *) usage ;;
esac
