'use strict';
// 서버 전용: 휴지통 정리와 DB·Storage 백업. HTTP로 실행시키는 경로는 없다.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const STATE = '/var/lib/our-places-jobs';
const BACKUPS = '/var/backups/group-place';
const PG_KEYS = ['PGHOST','PGPORT','PGUSER','PGDATABASE','PGPASSWORD','PGSSLMODE'];
function command(cmd, args, env = {}) {
  return new Promise((resolve, reject) => execFile(cmd, args, {
    env: { PATH: process.env.PATH, LC_ALL: 'C', ...env }, windowsHide: true,
    timeout: 10 * 60e3, maxBuffer: 1024 * 1024,
  }, (err, out) => err ? reject(new Error('COMMAND_FAILED')) : resolve(out)));
}
function safeObject(name) {
  return typeof name === 'string' && name.length <= 500 && !/[\x00-\x1f\\]/.test(name)
    && name.split('/').every((p) => p && p !== '.' && p !== '..');
}
function createMaintenance({ url, secret, fetchImpl = fetch, now = Date.now, exec = command, root = BACKUPS, stateDir = STATE, env = process.env } = {}) {
  const headers = { apikey: secret, authorization: `Bearer ${secret}`, 'content-type': 'application/json' };
  async function request(route, init = {}) {
    const r = await fetchImpl(`${url}${route}`, { ...init, headers: { ...headers, ...init.headers }, redirect: 'error', signal: AbortSignal.timeout(30000) });
    if (!r.ok) { if (r.body) await r.body.cancel().catch(() => {}); throw new Error('SUPABASE_REQUEST_FAILED'); }
    return r;
  }
  const rpc = async (name, body = {}) => (await request(`/rest/v1/rpc/${name}`, { method: 'POST', body: JSON.stringify(body) })).json();
  async function record(result) {
    await fs.promises.mkdir(stateDir, { recursive: true, mode: 0o750 });
    const file = path.join(stateDir, 'runs.json');
    let rows = [];
    try { rows = JSON.parse(await fs.promises.readFile(file, 'utf8')); } catch { /* 최초 실행 */ }
    if (!Array.isArray(rows)) rows = [];
    const tmp = `${file}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    const counts = { backup: 0, purge: 0 };
    const recent = [result, ...rows].filter((r) => Object.hasOwn(counts,r.kind) && ++counts[r.kind] <= (r.kind === 'backup' ? 30 : 60));
    await fs.promises.writeFile(tmp, JSON.stringify(recent), { mode: 0o640 });
    await fs.promises.chmod(tmp, 0o640);
    if (process.platform !== 'win32' && process.getuid && process.getuid() === 0) {
      // systemd의 Group=ourplaces로 생성된 파일을 관리자 서비스가 읽을 수 있다.
      const info = await fs.promises.stat(stateDir);
      await fs.promises.chown(tmp, 0, info.gid);
    }
    await fs.promises.rename(tmp, file);
  }
  async function purge() {
    const result = { kind: 'purge', started_at: new Date(now()).toISOString(), status: 'ok', jobs: 0, files: 0, failed: 0 };
    try {
      for (let n = 0; n < 100; n++) {
        const rows = await rpc('maintenance_claim');
        if (!Array.isArray(rows)) throw new Error('INVALID_JOB');
        const job = rows[0];
        if (!job) break;
        let error = null;
        try {
          if (!Array.isArray(job.paths) || job.paths.some((p) => !safeObject(p))) throw new Error('INVALID_JOB');
          for (let i = 0; i < job.paths.length; i += 100) {
            const r = await request('/storage/v1/object/place-photos', { method: 'DELETE', body: JSON.stringify({ prefixes: job.paths.slice(i, i + 100) }) });
            await r.arrayBuffer();
          }
        } catch { error = 'STORAGE_DELETE_FAILED'; result.failed++; }
        // Storage 성공을 확인한 뒤에만 휴지통 원본을 지운다. 실패·프로세스 종료는 DB의 lease/next_attempt로 재시도.
        if (!await rpc('maintenance_finish', { p_id: job.id, p_lease: job.lease, p_error: error })) throw new Error('LEASE_EXPIRED');
        if (!error) { result.jobs++; result.files += job.paths.length; }
      }
      if (result.failed) result.status = 'partial';
    } catch { result.status = 'failed'; result.error = 'PURGE_FAILED'; }
    result.finished_at = new Date(now()).toISOString();
    await record(result);
    return result;
  }
  async function listObjects(prefix = '') {
    const result = [];
    for (let offset = 0; ; offset += 100) {
      const page = await (await request('/storage/v1/object/list/place-photos', {
        method: 'POST', body: JSON.stringify({ prefix, offset, limit: 100, sortBy: { column: 'name', order: 'asc' } }),
      })).json();
      if (!Array.isArray(page)) throw new Error('STORAGE_LIST_FAILED');
      for (const item of page) {
        const name = prefix ? `${prefix}/${item.name}` : item.name;
        if (!safeObject(name)) throw new Error('INVALID_OBJECT_PATH');
        if (item.id == null) result.push(...await listObjects(name));
        else result.push({ name, size: Number(item.metadata && item.metadata.size) || null });
      }
      if (page.length < 100) break;
    }
    return result;
  }
  async function backup() {
    const started = now();
    const result = { kind: 'backup', started_at: new Date(started).toISOString(), status: 'failed', files: 0, bytes: 0 };
    const id = `${new Date(started).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')}-${crypto.randomBytes(3).toString('hex')}`;
    const base = path.resolve(root), staging = path.join(base, `.pending-${id}`), target = path.join(base, id);
    let completed = false;
    try {
      if (!env.PGHOST || !env.PGUSER || !env.PGPASSWORD) throw new Error('BACKUP_DB_CONFIG_MISSING');
      await fs.promises.mkdir(base, { recursive: true, mode: 0o700 });
      const disk = await fs.promises.statfs(base);
      if (Number(disk.bavail) * Number(disk.bsize) < 256 * 1024 * 1024) throw new Error('BACKUP_DISK_FULL');
      await fs.promises.mkdir(staging, { mode: 0o700 });
      const pg = Object.fromEntries(PG_KEYS.filter((k) => env[k]).map((k) => [k, env[k]]));
      const dump = path.join(staging, 'database.dump');
      await exec('pg_dump', ['--format=custom', '--no-owner', '--no-acl', '--schema=public', '--schema=auth', '--schema=storage', '--schema=backup', '--file', dump], pg);
      await exec('pg_restore', ['--list', dump]);
      const dbHash = crypto.createHash('sha256');
      for await (const chunk of fs.createReadStream(dump)) dbHash.update(chunk);
      const manifest = { version: 1, id, created_at: result.started_at, database: 'database.dump',
        database_size: (await fs.promises.stat(dump)).size, database_sha256: dbHash.digest('hex'), objects: [] };
      const objects = await listObjects();
      for (const object of objects) {
        const file = path.join(staging, 'storage', ...object.name.split('/'));
        await fs.promises.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
        const r = await request(`/storage/v1/object/authenticated/place-photos/${object.name.split('/').map(encodeURIComponent).join('/')}`);
        let size = 0;
        const hash = crypto.createHash('sha256');
        const meter = new Transform({ transform(chunk, encoding, callback) { size += chunk.length; hash.update(chunk); callback(null, chunk); } });
        await pipeline(Readable.fromWeb(r.body), meter, fs.createWriteStream(file, { flags: 'wx', mode: 0o600 }));
        if (object.size != null && object.size !== size) throw new Error('BACKUP_SIZE_MISMATCH');
        manifest.objects.push({ path: object.name, size, sha256: hash.digest('hex') });
        result.files++; result.bytes += size;
      }
      result.bytes += (await fs.promises.stat(dump)).size;
      const schemaDir = path.resolve(__dirname, '../../supabase');
      await fs.promises.cp(schemaDir, path.join(staging, 'sql'), { recursive: true });
      await fs.promises.writeFile(path.join(staging, 'manifest.json'), JSON.stringify(manifest), { mode: 0o600 });
      await fs.promises.rename(staging, target);
      completed = true;
      result.status = 'ok'; result.id = id;
      // 새 백업이 완성된 뒤에만 14일 이전의 완성된 백업을 정리한다. 임의 경로·링크는 따라가지 않는다.
      for (const entry of await fs.promises.readdir(base, { withFileTypes: true })) {
        if (!entry.isDirectory() || !/^\d{8}T\d{6}Z-[0-9a-f]{6}$/.test(entry.name) || entry.name === id) continue;
        const file = path.join(base, entry.name);
        const info = await fs.promises.stat(file);
        if (started - info.mtimeMs > 14 * 86400e3) await fs.promises.rm(file, { recursive: true });
      }
    } catch (e) {
      const known = ['BACKUP_DB_CONFIG_MISSING','BACKUP_DISK_FULL','BACKUP_SIZE_MISMATCH'];
      result.error = known.includes(e.message) ? e.message : 'BACKUP_FAILED';
    } finally {
      if (!completed) await fs.promises.rm(staging, { recursive: true, force: true }).catch(() => {});
    }
    result.finished_at = new Date(now()).toISOString();
    await record(result);
    return result;
  }
  return { purge, backup, rpc };
}

if (require.main === module) {
  process.umask(0o027);
  const env = process.env;
  if (!/^https:\/\/[a-z0-9]{20}\.supabase\.co$/.test(env.SUPABASE_URL || '') || !/^sb_secret_/.test(env.SUPABASE_SECRET_KEY || '')) {
    console.error('작업 설정을 확인하세요.'); process.exitCode = 78;
  } else {
    const api = createMaintenance({ url: env.SUPABASE_URL, secret: env.SUPABASE_SECRET_KEY });
    const mode = process.argv[2];
    if (!['purge','backup'].includes(mode)) process.exitCode = 78;
    else api[mode]().then((r) => { console.log(`${r.kind}: ${r.status}`); if (r.status !== 'ok') process.exitCode = 1; }, () => { console.error('작업 결과 저장 실패'); process.exitCode = 1; });
  }
}
module.exports = { createMaintenance, safeObject };
