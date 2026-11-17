'use strict';
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const pack=require('./t41_graficas_textos289_data.js');
const source=require('./t41_selected_5_data.js');
const prior284=require('./t41_revisadas_284.js');
const root=process.cwd(),server=fs.readFileSync(path.join(root,'server.js'),'utf8');
assert.equal(pack.revision,289);assert.equal(pack.topic_id,54);
assert.equal(pack.texts.length,90);assert.equal(pack.graphics.length,5);
assert.equal(source.questions.length,5);assert.equal(prior284.length,24);
assert.equal(new Set(pack.texts.map(x=>x.old_graphic_id)).size,90);
assert.equal(new Set(pack.graphics.map(x=>x.file)).size,5);
assert.equal(new Set([...pack.texts,...pack.graphics].map(x=>x.id)).size,95);
assert.equal(pack.texts.filter(q=>q.question_family==='2026_INCORRECTA').length,9);
const counts=[0,0,0,0];
const all=pack.texts.concat(pack.graphics);
for(const q of all){
 assert.equal(q.options.length,4);assert.equal(new Set(q.options).size,4);
 assert(q.correct_index>=0&&q.correct_index<=3);
 assert(q.stem.length>=105);assert(q.explanation.length>=45);
 if(!q.key)assert.equal(q.coverage_id,q.id+23060);
 assert.equal(Number(q.manual_page)-174,q.source_page);
 assert(!q.stem.startsWith('Según el manual CEIS Guadalajara'),String(q.id));
 assert(!q.stem.toLowerCase().includes(q.options[q.correct_index].toLowerCase()),'respuesta revelada '+q.id);
 assert(!/\b(?:la figura representada|el sistema representado)\b/i.test(q.stem),'imagen implícita '+q.id);
 counts[q.correct_index]++;
}
assert(Math.max(...counts)-Math.min(...counts)<3,'balanced choice positions '+counts);
const orig=new Map(source.questions.map(x=>[x.key,x]));
for(let i=0;i<5;i++){
 const q=pack.graphics[i],o=orig.get(q.key);
 assert(o);assert.equal(q.id,3112+i);assert.equal(q.file,o.file);
 assert.equal(q.old_graphic_id,o.old_question_id);
 assert.equal(q.old_stem,o.stem);assert.deepEqual(q.old_options,o.options);
 assert.equal(q.old_correct_index,o.correct_index);
}
assert(server.includes('async function applyT41GraphAndTextRevisions289()'));
assert(server.includes('await applyT41GraphAndTextRevisions289()'));
assert(server.includes('text289.get(Number(oldQ.id))'));
assert(server.includes('pic289.get(q.key)'));
assert(server.includes('validation_version IN (284,289)'));
const start=server.indexOf('async function applyT41GraphAndTextRevisions289()');
const end=server.indexOf('// T41-274:',start);
assert(start>=0&&end>start);
const script=server.slice(start,end)+'\nglobalThis.__run=applyT41GraphAndTextRevisions289;';
assert(script.includes('BEGIN')&&script.includes('ROLLBACK')&&script.includes('COMMIT'));
assert(!/DELETE FROM|TRUNCATE TABLE|\bUPDATE\s+coverage_items|\bUPDATE\s+test_session/.test(script));
assert(!/SET\s+active=|SET\s+graphic=|SET\s+times_(?:shown|correct|wrong|blank)/.test(script));
// Mock transactional PostgreSQL integration with precise old ID and image fidelity.
function createAdapter(){
 const historical=pack.texts.map(q=>({id:q.old_graphic_id,coverage_item_id:q.coverage_id,active:false,graphic:{sourceId:'historic/T42_FIG_01_P178.png'},options:q.options.slice(),correct_index:q.correct_index,manual_page:q.manual_page}));
 const byGraphic=new Map(pack.graphics.map(q=>[q.id,q]));
 const original=new Map(source.questions.map(q=>[q.key,q]));
 let rows=all.map((q,i)=>{
  const isG=Boolean(q.key),ref=isG?original.get(q.key):null;
  const o=isG?ref.options.slice():q.options.slice();
  const stem=isG?ref.stem:'Según el manual CEIS Guadalajara (p. '+q.manual_page+'), acerca de prueba: pregunta original de validación';
  const cor=isG?ref.correct_index:q.correct_index;
  if(!isG){const historicalQ=historical.find(x=>x.id===q.old_graphic_id);historicalQ.options=o.slice();historicalQ.correct_index=cor;}
  return {id:q.id,coverage_item_id:q.coverage_id,stem,options:o,correct_index:cor,
    explanation:'explicación original',source_page:q.source_page,manual_page:q.manual_page,
    question_family:isG?'GRAFICA':'2026_RAZONAMIENTO',validation_version:8,
    graphic:isG?{externalKey:q.key,sourceId:'tuneles/'+q.file,originalSelected:true,assetId:2500+i}:null,
    active:true,difficulty:'muy alta',topic_id:54,exam_relevant:true,
    times_shown:i+7,times_correct:i+2,times_wrong:i%4,times_blank:i%2};
 });
 const stats=()=>rows.map(x=>[x.id,x.coverage_item_id,x.times_shown,x.times_correct,x.times_wrong,x.times_blank,x.graphic&&x.graphic.sourceId]);
 const initial=JSON.stringify(stats());
 let snap=null,commits=0,rollbacks=0,updates=0;
 const client={
  async query(sql,param=[]){
   if(sql==='BEGIN'){snap=structuredClone(rows);return {rows:[],rowCount:0};}
   if(sql==='COMMIT'){snap=null;commits++;return {rows:[],rowCount:0};}
   if(sql==='ROLLBACK'){if(snap){rows=snap;snap=null;}rollbacks++;return {rows:[],rowCount:0};}
   if(sql.includes('pg_advisory_xact_lock'))return {rows:[{}],rowCount:1};
   if(sql.includes('FROM topics WHERE id=54 FOR UPDATE'))return {rows:[{id:54,topic_order:41,name:'TEMA 41. INCENDIOS EN TÚNELES',source_file:pack.pdf_source_name,block:'especifico',total_items:425}],rowCount:1};
   if(sql.includes('FROM question_bank q JOIN coverage_items c')&&sql.includes('q.id BETWEEN 3022 AND 3116'))return {rows,rowCount:rows.length};
   if(sql.includes('FROM question_bank WHERE id BETWEEN 1602 AND 1691'))return {rows:historical,rowCount:historical.length};
   if(sql.includes('UPDATE question_bank SET stem=')){
    const [id,stem,options,correct_index,explanation,source_evidence,question_family]=param;
    const q=rows.find(x=>x.id===id);assert(q);
    Object.assign(q,{stem,options:JSON.parse(options),correct_index,explanation,source_evidence,question_family,validation_version:289});updates++;
    return {rows:[{id}],rowCount:1};
   }
   if(sql.includes('COUNT(*) FILTER')&&sql.includes('wrong_version')){
    const txt=rows.filter(x=>x.id<=3111&&x.active&&!x.graphic).length;
    const imgs=rows.filter(x=>x.id>=3112&&x.active&&x.graphic).length;
    const sources=new Set(rows.filter(x=>x.id>=3112&&x.active).map(x=>x.graphic?.sourceId)).size;
    const wrong_version=rows.filter(x=>x.validation_version!==289).length;
    return {rows:[{txt,imgs,sources,wrong_version}],rowCount:1};
   }
   throw Error('Unexpected SQL '+sql.slice(0,180));
  }, release(){}
 };
 const db={connect:async()=>client};
 const ctx={globalThis:{},db,createHash:crypto.createHash,
  require:(p)=>p.includes('g​​raficas_textos')?pack:p.includes('t41_graficas_textos289')?pack:p.includes('t41_revisadas_284')?prior284:require(p),
  t41FivePack274:()=>source,Map,Set,Number,String,Boolean,JSON,Error,Array,console};
 vm.runInNewContext(script,ctx);
 return {async run(){return ctx.globalThis.__run();},get rows(){return rows;},get updates(){return updates;},get commits(){return commits;},get rollbacks(){return rollbacks;},get stats(){return JSON.stringify(stats());},get initial(){return initial;},tamper(id){rows.find(x=>x.id===id).stem='ALTERADO SIN CONTROL';}};
}
(async()=>{
 const a=createAdapter();
 const first=await a.run();assert.equal(first.rewritten,95);assert.equal(a.commits,1);assert.equal(a.updates,95);assert.equal(a.stats,a.initial);
 const second=await a.run();assert.equal(second.alreadyReviewed,95);assert.equal(second.rewritten,0);assert.equal(a.commits,2);assert.equal(a.updates,95);assert.equal(a.stats,a.initial);
 const b=createAdapter();b.tamper(3064);await assert.rejects(()=>b.run(),/texto original\/clave\/tema incompatibles/);
 assert.equal(b.commits,0);assert.equal(b.rollbacks,1);assert(b.rows.every(q=>q.validation_version===8));
 console.log('PASS T289: 90 conversiones +5 gráficas; balance',counts.join('/'),'idempotencia, transaction COMMIT/ROLLBACK, no cambios ID/imagen/SRS/stats.');
})().catch(e=>{console.error(e);process.exit(1)});
