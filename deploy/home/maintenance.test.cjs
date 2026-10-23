'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createMaintenance,safeObject}=require('./maintenance.cjs');
function setup(fetchImpl,env={},extra={}){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'gp-jobs-'));return {dir,api:createMaintenance({url:'https://test.invalid',secret:'test-secret',fetchImpl,root:path.join(dir,'backups'),stateDir:path.join(dir,'state'),env,...extra})}}
test('purge: 삭제 실패는 finish(error)로 원본 유지, 성공 뒤에만 finish(null)',async()=>{
 for(const fail of [true,false]){
  const calls=[];let claims=0;const x=setup(async(url,init)=>{const body=JSON.parse(init.body||'{}');calls.push({url,body});
   if(url.endsWith('/maintenance_claim'))return Response.json(claims++===0?[{id:'job',lease:'lease',paths:['p/a.jpg']}]:[]);
   if(url.includes('/storage/'))return Response.json({}, {status:fail?503:200});return Response.json(true);
  });try{const r=await x.api.purge();assert.equal(r.status,fail?'partial':'ok');const finish=calls.find(c=>c.url.endsWith('/maintenance_finish'));assert.equal(finish.body.p_error,fail?'STORAGE_DELETE_FAILED':null);assert.ok(calls.findIndex(c=>c.url.includes('/storage/'))<calls.indexOf(finish));assert.ok(!fs.readFileSync(path.join(x.dir,'state/runs.json'),'utf8').includes('test-secret'))}finally{fs.rmSync(x.dir,{recursive:true,force:true})}
 }
});
test('backup: 접속 설정 누락은 실패 기록이며 성공으로 보고하지 않음',async()=>{
 const x=setup(()=>{throw Error('network should not run')});try{const r=await x.api.backup();assert.equal(r.status,'failed');assert.equal(r.error,'BACKUP_DB_CONFIG_MISSING');const rows=JSON.parse(fs.readFileSync(path.join(x.dir,'state/runs.json')));assert.equal(rows[0].status,'failed')}finally{fs.rmSync(x.dir,{recursive:true,force:true})}
});
test('Storage 경로는 상대 경로·역슬래시·제어 문자를 거절',()=>{for(const p of ['../a','p/../a','/a','p\\a','p/\na'])assert.equal(safeObject(p),false);assert.equal(safeObject('p/t/a.jpg'),true)});

test('backup: DB 목차 검증과 사진 해시를 포함한 완성본만 공개, 실패 시 이전 백업 보존',async()=>{
 for(const fail of [false,true]){
  const commands=[];
  const x=setup(async(url,init)=>{
   if(url.includes('/object/list/')){const {prefix}=JSON.parse(init.body);return Response.json(prefix?[{name:'a.jpg',id:'photo',metadata:{size:3}}]:[{name:'p',id:null}])}
   if(fail)return new Response('error',{status:503});
   return new Response(new Uint8Array([1,2,3]));
  },{PGHOST:'db.test.invalid',PGUSER:'postgres',PGPASSWORD:'test-password'},{exec:async(cmd,args,env)=>{
   commands.push({cmd,args});
   assert.ok(!args.join(' ').includes('test-password'));
   if(cmd==='pg_dump'){assert.equal(env.PGPASSWORD,'test-password');fs.writeFileSync(args[args.indexOf('--file')+1],'test database')}
   return '';
  }});
  try{
   const old=path.join(x.dir,'backups','20260101T000000Z-abcdef');fs.mkdirSync(old,{recursive:true});fs.writeFileSync(path.join(old,'keep'),'previous');
   const result=await x.api.backup();assert.equal(result.status,fail?'failed':'ok');
   assert.equal(commands[1].cmd,'pg_restore');
   assert.ok(fs.existsSync(path.join(old,'keep')),'기존 완성본은 실패해도 보존');
   assert.ok(!fs.readdirSync(path.join(x.dir,'backups')).some(n=>n.startsWith('.pending-')));
   if(!fail){
    const target=path.join(x.dir,'backups',result.id);const m=JSON.parse(fs.readFileSync(path.join(target,'manifest.json')));
    assert.equal(m.objects[0].path,'p/a.jpg');assert.equal(m.objects[0].size,3);assert.match(m.objects[0].sha256,/^[a-f0-9]{64}$/);
    assert.match(m.database_sha256,/^[a-f0-9]{64}$/);assert.ok(fs.existsSync(path.join(target,'sql/maintenance.sql')));
    assert.ok(!JSON.stringify(m).includes('test-password'));
   }
  }finally{fs.rmSync(x.dir,{recursive:true,force:true})}
 }
});
