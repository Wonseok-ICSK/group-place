# 보안 정책

## 알려 주기

취약점은 공개 이슈로 올리지 말고 GitHub의 **Security → Report a vulnerability**(비공개 신고)로 알려 주세요. 재현 방법과 영향 범위를 적어 주시면 확인 후 답하겠습니다.

## 저장소에 넣지 않는 것

- Supabase secret key(`sb_secret_…`), service_role 키, DB 비밀번호, Cloudflare 터널 토큰
- 실제 서비스 주소의 운영 설정 파일(`/etc/our-places/*`), 사용자 데이터와 사진

화면(`index.html`)에 들어가는 Publishable key는 공개돼도 되는 값이지만, 저장소에는 자리표시값만 둡니다. 커밋 전에 `bash scripts/leak-check.sh`가 이런 값을 찾아 막습니다.
