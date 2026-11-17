'use strict';
const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const vm=require('node:vm');
const pack=require('./t41_graficas_textos289_data.js');
const selected=require('./t41_selected_5_data.js');
const prior284=require('./t41_revisadas_284.js');
const server=fs.readFileSync('server.js','utf8');
const start=server.indexOf('function t41FivePack274()');
const stop=server.indexOf('// SERVER275:',start);
const script=server.slice(start,stop)+'\nglobalThis.__run=syncT41FiveImages274;';
const byImage=new Map(selected.questions.map(q=>[q.key,q]));
const existing=[...pack.texts,...pack.graphics].map(q=>({
 id:q.id,coverage_item_id:q.coverage_id,stem:q.stem,options:q.options,correct_index:q.correct_index,
 validation_version:289,active:true,graphic:q.key?{sourceId:'tuneles/'+q.file,originalSelected:true,externalKey:q.key}:null,
 question_family:q.key?'GRAFICA':'2026_RAZONAMIENTO',manual_page:q.manual_page,source_page:q.source_page,
 explanation:q.explanation,source_evidence:q.source_evidence, difficulty:q.difficulty}));
// The saved 90 historical questions remain inactive and are never deleted.
const old=pack.texts.map(q=>({id:q.old_graphic_id,coverage_item_id:q.coverage_id,stem:'¿Qué parámetro representa la figura histórica?',
 options:['A','B','C','D'],correct_index:0,explanation:'Datos históricos',source_evidence:'Fuente PDF original CEIS',
 source_page:q.source_page,manual_page:q.manual_page,active:false,difficulty:'muy alta',question_family:'GRAFICA',
 graphic:{sourceId:'incendios-tuneles/T42_FIG_01_P178.png'}}));
const assets=selected.questions.map((q,i)=>({id:i+1500,source_file:q.file,source_id:'tuneles/'+q.file,public_url:'/graphics/tuneles/'+q.file,is_usable:true}));
let inserts=0,commits=0,rollbacks=0;
const conn={
 async query(sql,args=[]){
  if(sql==='BEGIN'||sql.includes('pg_advisory_xact_lock'))return {rowCount:0,rows:[]};
  if(sql==='COMMIT'){commits++;return {rowCount:0,rows:[]};}
  if(sql==='ROLLBACK'){rollbacks++;return {rowCount:0,rows:[]};}
  if(sql.includes('FROM topics WHERE id=54 FOR UPDATE'))return {rows:[{id:54,topic_order:41,name:'TEMA 41. INCENDIOS EN TÚNELES',block:'especifico',total_items:425}],rowCount:1};
  if(sql.includes('WHERE c.topic_id=54 AND q.id BETWEEN 1602 AND 1691'))return {rows:old,rowCount:90};
  if(sql.includes("WHERE topic_folder='tuneles' AND source_file=ANY"))return {rows:assets,rowCount:5};
  if(sql.includes('AND graphic IS NULL') && sql.includes('validation_version IN (284,289)')){
   const q=existing.filter(x=>x.coverage_item_id===args[0]&&!x.graphic&&
    (x.stem===args[1]||(x.id===args[2]&&[284,289].includes(x.validation_version))));
   return {rows:q,rowCount:q.length};
  }
  if(sql.includes('SELECT id,stem,options,correct_index,graphic,active,validation_version') && sql.includes('validation_version=289')){
   const q=existing.filter(x=>x.coverage_item_id===args[0]&&
     (x.stem===args[1]||(x.id===args[2]&&x.validation_version===289)));
   return {rows:q,rowCount:q.length};
  }
  if(sql.includes('INSERT INTO question_bank')){inserts++;throw Error('Duplicate creation during restart');}
  if(sql.startsWith('UPDATE question_bank SET active=FALSE'))return {rows:[],rowCount:0};
  if(sql.startsWith('UPDATE graphic_assets SET'))return {rows:[],rowCount:0};
  if(sql.includes("COUNT(DISTINCT q.graphic->>'sourceId')"))return {rows:[{n:5,sources:5,low:0}],rowCount:1};
  if(sql.includes('q.id BETWEEN 3022 AND 3111'))return {rows:[{n:90}],rowCount:1};
  throw Error('Unexpected query: '+sql.slice(0,230));
 },release(){}
};
const env={globalThis:{},require:(p)=> p.includes('t41_graficas_textos289')?pack:p.includes('t41_revisadas_284')?prior284:require(p),
 db:{connect:async()=>conn},fs:{...fs,existsSync:(p)=>p.includes('/public/graphics/tuneles/')?true:fs.existsSync(p)},path,
 process,Map,Set,String,Number,Array,JSON,Error,Promise,console};
vm.runInNewContext(script,env);
(async()=>{
 const first=await env.globalThis.__run();
 assert.equal(first.textExisting,90);assert.equal(first.graphicExisting,5);
 assert.equal(first.textCreated,0);assert.equal(first.graphicNew,0);assert.equal(inserts,0);assert.equal(commits,1);assert.equal(rollbacks,0);
 const second=await env.globalThis.__run();
 assert.equal(second.textExisting,90);assert.equal(second.graphicExisting,5);assert.equal(inserts,0);assert.equal(commits,2);
 console.log('PASS T289 importer 274: reinicios sobre 90 textos + 5 imágenes ya revisadas, sin duplicados, sin INSERT.');
})().catch(e=>{console.error(e);process.exit(1)});
