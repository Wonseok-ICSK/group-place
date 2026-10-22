<# 홈 서버에 마지막 커밋(HEAD)을 올린다.
   사용(저장소 맨 위 폴더에서):
     pwsh -File deploy/home/deploy.ps1
     pwsh -File deploy/home/deploy.ps1 -SupabaseUrl https://<id>.supabase.co -SupabaseKey sb_publishable_... `
         -PublicOrigin https://<사이트 주소> -LoginIdDomain id.<도메인>   (처음 한 번, 바꿀 때. 나중엔 생략하면 지금 값 유지)
   커밋하지 않은 수정은 올라가지 않는다. 서버 쪽 일은 deploy/home/install.sh가 한다.
   설치는 서버의 systemd-run 안에서 돌아서, 중간에 SSH가 끊겨도 끝까지(실패하면 되돌리기까지) 진행된다.
#>
param(
    [ValidatePattern('\A[A-Za-z0-9@._-]+\z', Options = 'None')][string]$Target = 'wonseok-home',
    [ValidatePattern('\Ahttps://[a-z0-9]{20}\.supabase\.co\z', Options = 'None')][string]$SupabaseUrl,
    [ValidatePattern('\Asb_publishable_[A-Za-z0-9_-]{10,200}\z', Options = 'None')][string]$SupabaseKey,
    [ValidatePattern('\Ahttps://[a-z0-9-]+(\.[a-z0-9-]+)+\z', Options = 'None')][string]$PublicOrigin,
    [ValidatePattern('\A([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}\z', Options = 'None')][string]$LoginIdDomain
)
$ErrorActionPreference = 'Stop'
if ([bool]$SupabaseUrl -ne [bool]$SupabaseKey) { throw '-SupabaseUrl과 -SupabaseKey는 함께 주세요' }
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$commit = (& git -C $root rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0) { throw 'git rev-parse 실패' }
if (& git -C $root status --porcelain --untracked-files=no) {
    Write-Warning '커밋하지 않은 수정이 있어요. 올라가는 건 마지막 커밋뿐이에요.'
}
$short = $commit.Substring(0, 12)
$local = Join-Path ([IO.Path]::GetTempPath()) "our-places-$short.tar.gz"
try {
    # core.autocrlf=false: Windows에서도 저장소 그대로(LF) 묶는다. CRLF가 섞이면 서버에서 install.sh가 돌지 않는다.
    & git -C $root -c core.autocrlf=false archive --format=tar.gz -o $local $commit
    if ($LASTEXITCODE -ne 0) { throw 'git archive 실패' }
    # 서버의 /tmp에 이번 배포만 쓰는 폴더(이름을 예측할 수 없게)
    $dir = "$(& ssh $Target 'mktemp -d /tmp/our-places.XXXXXX')".Trim()
    if ($LASTEXITCODE -ne 0 -or $dir -cnotmatch '\A/tmp/our-places\.[A-Za-z0-9]{6}\z') { throw "서버 임시 폴더를 만들지 못했어요: $dir" }
    & scp -q $local "${Target}:$dir/release.tar.gz"
    if ($LASTEXITCODE -ne 0) { throw '업로드 실패' }
} finally { Remove-Item -LiteralPath $local -ErrorAction SilentlyContinue }

$setenv = if ($SupabaseUrl) { "--setenv=SUPABASE_URL=$SupabaseUrl --setenv=SUPABASE_KEY=$SupabaseKey " } else { '' }
if ($PublicOrigin) { $setenv += "--setenv=PUBLIC_ORIGIN=$PublicOrigin " }
if ($LoginIdDomain) { $setenv += "--setenv=LOGIN_ID_DOMAIN=$LoginIdDomain " }
# 서버에서 실행할 내용: 묶음에서 install.sh를 꺼내 실행하고, 끝나면 임시 폴더를 지운다.
$inner = 'tar -xzOf "$1/release.tar.gz" deploy/home/install.sh > "$1/install.sh" && bash "$1/install.sh" "$1/release.tar.gz" "$2"; s=$?; rm -rf -- "$1"; exit $s'
$cmd = "sudo systemd-run --quiet --wait --pipe --collect --unit=our-places-install-$short ${setenv}/bin/bash -c '$inner' _ $dir $commit"
& ssh $Target $cmd
if ($LASTEXITCODE -ne 0) { throw "서버 설치 실패: ssh $Target `"journalctl -u our-places -n 30`"" }
Write-Host "올림: $short"
