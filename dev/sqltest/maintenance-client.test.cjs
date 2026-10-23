'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const html=fs.readFileSync(path.join(__dirname,'../../index.html'),'utf8');
function storage(){const m=new Map();return {get length(){return m.size},key:i=>[...m.keys()][i],getItem:k=>m.get(k)||null,setItem:(k,v)=>m.set(k,v),removeItem:k=>m.delete(k)}}
test('V031 초안: 계정·방 분리, 14일 만료, 읽기 전용 상세에서는 저장하지 않음',()=>{
 const ctx={state:{roomId:'A',places:[],sheet:{type:'detail',id:'p'}},who:'u1',readOnly:false,uid:()=>ctx.who,ro:()=>ctx.readOnly,
  localStorage:storage(),setTimeout:()=>1,clearTimeout(){},Date,Map,Set,$:()=>({value:'내용'})};
 vm.createContext(ctx);vm.runInContext(html.slice(html.indexOf("const DRAFT ="),html.indexOf('/* ---------- 시트: 장소 월드컵')),ctx);
 vm.runInContext("putDraft(draftKey('note','p'),{text:'내 방 메모',at:Date.now()});flushDrafts()",ctx);
 assert.equal(vm.runInContext("readDraft(draftKey('note','p')).text",ctx),'내 방 메모');
 ctx.state.roomId='B';assert.equal(vm.runInContext("readDraft(draftKey('note','p'))",ctx),null);
 ctx.state.roomId='A';ctx.who='u2';assert.equal(vm.runInContext("readDraft(draftKey('note','p'))",ctx),null);
 ctx.who='u1';ctx.readOnly=true;ctx.state.places=[{id:'p',shared_note:''}];ctx.keepNoteDraft();
 assert.equal(vm.runInContext("readDraft(draftKey('note','p')).text",ctx),'내 방 메모');
 vm.runInContext("putDraft(draftKey('note','p'),{text:'오래된 메모',at:Date.now()-15*864e5});flushDrafts()",ctx);
 assert.equal(vm.runInContext("readDraft(draftKey('note','p'))",ctx),null);assert.equal(ctx.localStorage.length,0);
});
test('V031 세션: 조회 예외·일시 네트워크 오류는 로그인 대신 재시도, 복구 시 방을 불러옴',async()=>{
 let mode='throw',loaded=0,rendered=0;
 const ctx={state:{},render:()=>rendered++,loadAll:async()=>loaded++,toast(){},friendly:e=>e.message,
  sb:{auth:{getSession:async()=>{if(mode==='throw')throw Error('network');return mode==='error'?{data:{session:null},error:{name:'AuthRetryableFetchError'}}:{data:{session:{user:{id:'u'}}},error:null}}}},
  window:{addEventListener(){}}};vm.createContext(ctx);
 vm.runInContext(html.slice(html.indexOf('const isNetErr ='),html.indexOf('/* ---------- 시작 ---------- */')),ctx);
 await ctx.bootSession();assert.equal(ctx.state.authRetry,true);assert.equal(loaded,0);
 mode='error';await ctx.bootSession();assert.equal(ctx.state.authRetry,true);
 mode='ok';await ctx.bootSession();assert.equal(ctx.state.authRetry,false);assert.equal(loaded,1);assert.equal(rendered,3);
});
