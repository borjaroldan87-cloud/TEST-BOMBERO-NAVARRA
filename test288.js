'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs'),crypto=require('node:crypto'),vm=require('node:vm');
const revised=require('./t40_graficas_revisadas288_data.js');
const baseline=require('./t40_selected_32_data.js');
const code=fs.readFileSync('./server.js','utf8');
assert.equal(revised.revision,288);assert.equal(revised.topic_id,50);
assert.equal(revised.questions.length,32);
assert.equal(baseline.questions.length,32);assert.equal(baseline.original_user_images.length,32);
const expected=new Map(baseline.questions.map(q=>[q.external_key,q]));
const imgs=new Map(baseline.original_user_images.map(q=>[q.file,q]));
const hist=[0,0,0,0];
const seenId=new Set(),seenC=new Set(),seenG=new Set();
const keys=[];
for(const q of revised.questions){
 assert(!seenId.has(q.id));seenId.add(q.id);assert(!seenC.has(q.coverage_id));seenC.add(q.coverage_id);
 assert(!seenG.has(q.external_key));seenG.add(q.external_key);keys.push(q.external_key);
 const o=expected.get(q.external_key);assert(o,'expected missing');
 const im=imgs.get(q.file);assert(im,'image original missing');
 assert.equal(q.coverage_id,o.coverage_id);assert.equal(q.legacy_old_graphic_id,o.old_graphic_id);
 assert.equal(q.source_pdf_page,o.source_pdf_page);assert.equal(String(q.manual_page),String(o.manual_page));
 assert.equal(q.old_stem,o.stem);assert.deepEqual(q.old_options,o.options);
 assert.equal(q.old_stem_md5,crypto.createHash('md5').update(o.stem).digest('hex'));
 assert.equal(q.old_right_md5,crypto.createHash('md5').update(o.options[o.correct_index]).digest('hex'));
 assert(q.stem.includes('¿')&&q.stem.length>120&&q.stem.length<550);
 assert(!q.stem.includes('Según el manual CEIS Guadalajara (p.'));
 assert(q.source_evidence.includes('CEIS Guadalajara')&&/Pp?\./.test(q.explanation));
 assert.equal(q.options.length,4);assert.equal(new Set(q.options).size,4);
 assert(q.correct_index>=0&&q.correct_index<4);hist[q.correct_index]++;
 assert(!q.stem.toLowerCase().includes(q.options[q.correct_index].toLowerCase()),'answer disclosed in stem '+q.external_key);
 assert(q.options.every(x=>x.length>6));
 assert(q.explanation.length>35);
 assert(/^[a-f0-9]{40}$/.test(im.git_blob_sha1));
}
assert.deepEqual(hist,[8,8,8,8]);
assert.equal(new Set(revised.questions.map(x=>x.file)).size,32);
assert.equal(1800*2-1800*1.35,1170); // 27
assert(Math.abs(43-32*(.8+.4)-4.6)<1e-9); // 28
assert(Math.abs(25.92*(9/6)**2-25.92-32.4)<1e-9); // 29
assert(code.includes('async function applyT40GraphicRevisions288()'));
assert(code.includes("T288_T40_32_GRAFICAS_REVISADAS"));
const migration=code.slice(code.indexOf('async function applyT40GraphicRevisions288()'),code.indexOf('// T40-272:'));
assert(migration.includes('BEGIN')&&migration.includes('ROLLBACK')&&migration.includes('COMMIT'));
assert(!/DELETE FROM|TRUNCATE TABLE/.test(migration));
assert(!/UPDATE\s+(?:coverage_items|test_sessions|test_session_questions|graphic_assets)/.test(migration));
assert(!/SET\s+active\s*=|SET\s+graphic\s*=|SET\s+times_shown|SET\s+times_correct|SET\s+times_wrong/.test(migration));
const importer=code.slice(code.indexOf('async function syncT40Selected32_272()'),code.indexOf('// T41-274:'));
assert(importer.includes("graphic->>'externalKey'=$2"));
assert(importer.includes('reviewedVersion')&&importer.includes('oldVersion'));
assert(importer.includes('Number(current.validation_version)===288'));
assert(importer.includes("require('./t40_graficas_revisadas288_data.js')"));
assert(code.indexOf('await syncT40Selected32_272()')<code.lastIndexOf('await applyT40GraphicRevisions288()'));
// Test transactional migration with an in-memory database adapter, preserving statistics.
function makeAdapter(){
 const rows=baseline.questions.map((o,i)=>({
  id:revised.questions[i].id,coverage_item_id:o.coverage_id,stem:o.stem,
  options:o.options.slice(),correct_index:o.correct_index,
  explanation:o.explanation,source_evidence:o.source_evidence,
  graphic:{originalSelected:true,externalKey:o.external_key,
     sourceId:'incendios-interior/'+o.file,assetId:imgs.get(o.file).asset_id_expected},
  active:true,question_family:'GRAFICA',difficulty:'muy alta',validation_version:8,
  source_page:o.source_pdf_page,manual_page:o.manual_page,topic_id:50,exam_relevant:true,
  times_shown:i+13,times_correct:7+i,times_wrong:3+i,times_blank:2+i,
 }));
 const originalHistory=rows.map(x=>[x.id,x.times_shown,x.times_correct,x.times_wrong,x.times_blank,x.coverage_item_id,x.graphic.sourceId]);
 let snapshot=null, commits=0, rollbacks=0, updates=0;
 const client={
  async query(sql,params=[]){
   if(sql==='BEGIN'){snapshot=structuredClone(rows);return {rowCount:0,rows:[]};}
   if(sql==='COMMIT'){commits++;snapshot=null;return {rowCount:0,rows:[]};}
   if(sql==='ROLLBACK'){rollbacks++;if(snapshot){rows.splice(0,rows.length,...snapshot);snapshot=null;}return {rowCount:0,rows:[]};}
   if(sql.startsWith('SELECT pg_advisory'))return {rowCount:1,rows:[{}]};
   if(sql.includes('SELECT id,source_file,topic_order,block FROM topics'))return {rowCount:1,rows:[{id:50,topic_order:40,block:'especifico',source_file:baseline.pdf_source_name}]};
   if(sql.includes('FROM question_bank q JOIN coverage_items cv'))return {rowCount:rows.length,rows};
   if(sql.includes('UPDATE question_bank SET stem=')){
    const [id,stem,options,correct_index,explanation,evidence]=params;
    const r=rows.find(r=>r.id===id);assert(r);Object.assign(r,{stem,options:JSON.parse(options),correct_index,explanation,source_evidence:evidence,validation_version:288});updates++;return {rowCount:1,rows:[{id}]};
   }
   throw Error('Unexpected SQL: '+sql.slice(0,110));
  },release(){}
 };
 return {db:{connect:async()=>client},rows,history:originalHistory,counters:()=>({commits,rollbacks,updates})};
}
(async()=>{
 const c=makeAdapter();
 const ctx={db:c.db,createHash:crypto.createHash,require:x=>{
  if(x==='./t40_graficas_revisadas288_data.js')return revised;
  if(x==='./t40_selected_32_data.js')return baseline;
  throw Error('Unexpected module '+x);
 },Number,String,Map,Set,JSON,Error,Array,console};
 vm.createContext(ctx);vm.runInContext(migration+'\nthis.migrate=applyT40GraphicRevisions288;',ctx);
 const a=await ctx.migrate();assert.equal(a.revised,32);assert.equal(a.alreadyRevised,0);
 const b=await ctx.migrate();assert.equal(b.revised,0);assert.equal(b.alreadyRevised,32);
 assert.deepEqual(c.counters(),{commits:2,rollbacks:0,updates:32});
 assert.deepEqual(c.rows.map(x=>[x.id,x.times_shown,x.times_correct,x.times_wrong,x.times_blank,x.coverage_item_id,x.graphic.sourceId]),c.history);
 // Existing different baseline must abort and ROLLBACK (never blindly overwrite).
 c.rows[20].stem='intervención externa no auditada';c.rows[20].validation_version=8;
 await assert.rejects(ctx.migrate(),/ROLLBACK/);
 assert.equal(c.counters().rollbacks,1);
 console.log('PASS 288: 32 revisiones, 32 originales, 8 respuestas A/B/C/D, cálculo, no pistas literales, transacción idempotente + rollback por conflicto, sin alterar estadísticas.');
})().catch(e=>{console.error(e.stack||e);process.exit(1)});
