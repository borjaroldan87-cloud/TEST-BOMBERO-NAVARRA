'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),crypto=require('node:crypto');
const c=require('./t40_text_revisadas287_data.js');
const original=require('./t40_selected_32_data.js');
const code=fs.readFileSync('./server.js','utf8');
assert.equal(c.schema,1); assert.equal(c.revision,287); assert.equal(c.topic_id,50);
assert.equal(c.questions.length,16); assert.equal(original.schema,2); assert.equal(original.selected_count,32);
assert.equal(original.questions.length,32);assert.equal(original.original_user_images.length,32);
const originalTextIds=new Set(original.text_conversions.map(x=>x.old_question_id));
const used=new Set(), usedOld=new Set(),usedCov=new Set();
const histogram=[0,0,0,0];
for(const q of c.questions){
 assert(!used.has(q.id));used.add(q.id);
 assert(!usedOld.has(q.legacy_old_graphic_id));usedOld.add(q.legacy_old_graphic_id);
 assert(originalTextIds.has(q.legacy_old_graphic_id));
 assert(!usedCov.has(q.coverage_id));usedCov.add(q.coverage_id);
 assert.equal(q.options.length,4);assert.equal(new Set(q.options.map(s=>s.trim().toLowerCase())).size,4);
 assert(q.stem.length>=110 && q.stem.length<650);
 assert(q.correct_index>=0 && q.correct_index<=3);
 histogram[q.correct_index]++;
 assert(q.options[q.correct_index].length>=25);
 assert(!/seg[uú]n el manual ceis guadalajara \(p\./i.test(q.stem));
 assert(!/^¿qu[eé] (?:intervalo|clase|combinaci[oó]n|aumento) /i.test(q.stem));
 assert(q.explanation.length>60 && q.source_evidence.length>60);
 assert(/^\d+$/.test(q.manual_page));
 assert(/^[a-f\d]{32}$/.test(q.old_stem_md5) && /^[a-f\d]{32}$/.test(q.old_correct_answer_md5));
 assert.equal(typeof q.old_correct_index,'number');
}
assert.deepEqual(histogram,[4,4,4,4]);
assert.equal(1800*(.35-.06),522); // Question 2935
assert.equal(1600*1.06,1696); // Q2938
assert.equal(1600*1.35,2160);
assert.equal(1600*2,3200);
assert.equal(18-(-9),27); // Q2940
assert(code.includes('async function applyT40TextRevisions287()'));
assert(code.includes('T287_T40_16_TEXTOS_REVISADOS'));
assert(code.includes('validation_version=287'));
assert(code.includes('await syncT40Selected32_272()'));
const updater=code.slice(code.indexOf('async function applyT40TextRevisions287()'),code.indexOf('// T40-272:'));
assert(!/DELETE FROM|TRUNCATE TABLE/i.test(updater));
assert(!/SET\s+(?:times_shown|times_correct|times_wrong|times_blank|active|graphic|coverage_item_id)/i.test(updater));
assert(updater.includes('BEGIN') && updater.includes('ROLLBACK') && updater.includes('COMMIT'));
assert(updater.includes('T287: baseline original inesperada'));
assert(updater.includes('T287: pregunta gráfica de origen ausente'));
const import272=code.slice(code.indexOf('async function syncT40Selected32_272()'),code.indexOf('async function syncT40Selected32_272()')+19000);
assert(import272.includes('validation_version=287 AND stem=$3'));
assert(import272.includes('T40_272/T287: texto revisado no reconocido'));
console.log('OK 287: 16 conversiones trazadas, 32 imágenes originales, cuatro opciones, respuestas equilibradas, aritmética, migración transaccional sin pérdida de estadísticas');
