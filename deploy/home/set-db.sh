#!/usr/bin/env bash
# root로 실행. 비밀번호는 숨김 입력으로만 받고 명령줄·로그에 넣지 않는다.
set -euo pipefail
[[ "$(id -u)" == 0 && -t 0 ]] || { echo 'SSH 터미널에서 sudo bash set-db.sh로 실행하세요.' >&2; exit 2; }
ref="$(sed -n 's@^SUPABASE_URL=https://\([a-z0-9]*\)\.supabase\.co$@\1@p' /etc/our-places/env)"
[[ "$ref" =~ ^[a-z0-9]{20}$ ]] || exit 2
read -r -p 'Supabase session pooler host [aws-0-ap-northeast-2.pooler.supabase.com]: ' db_host
export PGHOST="${db_host:-aws-0-ap-northeast-2.pooler.supabase.com}"
[[ "$PGHOST" =~ ^[a-z0-9.-]+\.supabase\.(com|co)$ ]] || exit 2
export PGPORT=5432 PGDATABASE=postgres PGUSER="postgres.$ref" PGSSLMODE=require PGCONNECT_TIMEOUT=10
read -r -s -p '현재 Supabase DB 비밀번호: ' PGPASSWORD
echo
export PGPASSWORD
if [[ "$(psql -At -v ON_ERROR_STOP=1 -c 'select public.stability_schema_version()' 2>/dev/null)" != 1 ]]; then
  unset PGPASSWORD
  echo 'DB 인증 또는 프로젝트 확인 실패. 비밀번호와 session pooler 주소를 확인하세요.' >&2
  exit 1
fi
python3 - <<'PY'
import os,json,tempfile
dest='/etc/our-places/backup.env'
fd,tmp=tempfile.mkstemp(prefix='.backup-env-',dir='/etc/our-places')
with os.fdopen(fd,'w') as f:
    for key in ['PGHOST','PGPORT','PGDATABASE','PGUSER','PGPASSWORD','PGSSLMODE']:
        f.write(key+'='+json.dumps(os.environ[key],ensure_ascii=False)+'\n')
os.chmod(tmp,0o600)
os.replace(tmp,dest)
PY
unset PGPASSWORD
echo 'DB 연결을 확인했고 root 전용 backup.env에 저장했어요.'
