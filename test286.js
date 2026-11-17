'use strict';
const fs=require('fs'),assert=require('assert'),crypto=require('crypto');
const a=require('./t38_graphics_data.js'),b=require('./t39_graphics_data.js'),review=require('./t38_t39_revisadas286_data.js');
const q=[...a.questions,...b.questions];
const keys=q.map(x=>x.external_key);
assert.strictEqual(q.length,8);
assert.strictEqual(new Set(keys).size,8);
assert.deepStrictEqual([a.original_user_images.length,b.original_user_images.length],[3,5]);
assert.strictEqual(new Set(q.map(x=>x.file)).size,8);
assert.strictEqual(new Set(review.questions.map(x=>x.external_key)).size,8);
for(const x of q){
 const patch=review.questions.find(v=>v.external_key===x.external_key);
 assert(patch,'revisión ausente '+x.external_key);
 assert.strictEqual(patch.stem,x.stem);
 assert.deepStrictEqual(patch.options,x.options);
 assert.strictEqual(patch.correct_index,x.correct_index);
 assert.strictEqual(patch.source_evidence,x.source_evidence);
 assert.strictEqual(patch.explanation,x.explanation);
 assert.strictEqual(patch.coverage_id,x.coverage_id);
 assert(x.difficulty==='muy alta');
 assert(x.options.length===4&&new Set(x.options).size===4);
 assert(Number.isInteger(x.correct_index)&&x.correct_index>=0&&x.correct_index<4);
 assert(!/según el manual ceis guadalajara/i.test(x.stem));
 assert((x.stem.includes('¿')&&x.stem.includes('?'))||/señale|indique/i.test(x.stem));
 assert(/páginas? impresas?/i.test(x.source_evidence));
}
// Independent numerical checks of applied physics and changes.
assert.strictEqual(1200-800,400);                            // T38 001
assert(198<200);                                              // T38 003
assert.strictEqual(180*9,1620);                              // T39 001
assert.strictEqual((180*.8)*(9/1.2),1080);                   // T39 001
assert(Math.abs(1-1080/1620-1/3)<1e-10);                     // T39 001
assert.strictEqual(600*.75+400*1.1,890);                    // T39 002
assert.strictEqual(100*(1000-890)/1000,11);                  // T39 002
assert.strictEqual(35+10+55*.8,89);                          // T39 003
assert(Math.abs(10*(5**2/3**2)-20-70/9)<1e-10);              // T39 004
assert(Math.abs(20*(5**2/3**2)-50-50/9)<1e-10);              // T39 005
const server=fs.readFileSync('./server.js','utf8');
assert(server.includes('async function applyOriginalGraphicRevisions286()'));
assert(server.includes('T286_GRAFICAS_38_39_REVISADAS'));
assert(server.includes('syncT38SelectedGraphics270()'));
assert(server.includes('syncT39OriginalGraphics271()'));
assert(server.indexOf('applyOriginalGraphicRevisions286()\n      .then')<server.lastIndexOf('syncT38SelectedGraphics270()'));
assert.strictEqual((server.match(/T286_GRAFICAS_38_39_REVISADAS/g)||[]).length,1);
// No direct mutation of performance or identity fields in the migration.
const segment=server.slice(server.indexOf('async function applyOriginalGraphicRevisions286()'),server.indexOf('// T38-270: solo tres'));
assert(!segment.includes('DELETE FROM'));
assert(!/SET\s+times_shown|SET\s+times_correct|SET\s+times_wrong/i.test(segment));
console.log('OK AUDITORÍA286: 8 originales, 8 revisiones, 8 imágenes, cálculos, cita, selección y preservación de estadísticas');
