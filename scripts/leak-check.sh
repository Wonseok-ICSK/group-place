#!/usr/bin/env bash
# 공개 저장소에 들어가면 안 되는 값을 커밋 전에 찾는다(스테이징된 내용 기준).
# 사용: bash scripts/leak-check.sh   (git config core.hooksPath .githooks 로 커밋마다 자동 실행)
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
# 연결하면 안 되는 Supabase 프로젝트(별도의 비공개 배포). ID 대신 SHA-256만 둔다.
blocked_ref_sha256=(b7ed2b80671cdca9a6b48622040a2143d853dd32baff32ba6abd46ab15719cf4)
status=0
report() { echo "leak-check: $*" >&2; status=1; }

# 1) 비밀 키·토큰 모양
if git grep --cached -n -I -E 'sb_secret_[A-Za-z0-9_-]{10,}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}|BEGIN [A-Z ]*PRIVATE KEY|postgres(ql)?://[^[:space:]]+:[^[:space:]@]+@' -- . ':!scripts/leak-check.sh' ':!*.test.cjs'; then
  report '비밀 키나 토큰처럼 보이는 값이 있어요'
fi
# 테스트 파일의 가짜 키는 이름에 test/other/fake가 들어가야 한다
if git grep --cached -h -o -I -E 'sb_secret_[A-Za-z0-9_-]{10,}' -- '*.test.cjs' | grep -v -E 'test|other|fake'; then
  report '테스트 파일에 진짜처럼 보이는 secret key가 있어요'
fi
# 2) 다른 배포를 가리키는 값: Supabase 프로젝트 ID(해시 비교), vercel.app 주소
while IFS= read -r ref; do
  [[ -n "$ref" ]] || continue
  h="$(printf '%s' "$ref" | sha256sum | cut -d' ' -f1)"
  for b in "${blocked_ref_sha256[@]}"; do
    [[ "$h" != "$b" ]] || report "연결하면 안 되는 Supabase 프로젝트 ID가 있어요: $ref"
  done
done < <(git grep --cached -h -o -I -E '[a-z0-9]{20}\.supabase\.co' -- . | cut -d. -f1 | sort -u || true)
if git grep --cached -n -I -E '[a-z0-9-]+\.vercel\.app' -- . ':!scripts/leak-check.sh'; then
  report 'vercel.app 주소가 있어요(원래 앱 주소일 수 있음)'
fi
# 3) 커밋 작성자 메일은 GitHub noreply 주소만
email="$(git config user.email || true)"
[[ "$email" == *@users.noreply.github.com ]] || report "커밋 메일이 noreply 주소가 아니에요: $email (git config user.email ...@users.noreply.github.com)"

if (( status )); then echo 'leak-check: 실패. 위 항목을 고친 뒤 다시 커밋하세요.' >&2; exit 1; fi
echo 'leak-check: 통과'
