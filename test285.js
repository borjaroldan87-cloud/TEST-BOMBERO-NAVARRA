const fs=require('fs');const vm=require('vm');const assert=require('assert');
const s=fs.readFileSync(__dirname+'/server.js','utf8');
const a=s.indexOf('function bank278Norm(x)'),b=s.indexOf('async function resetBank136(');
assert(a>=0&&b>a);
const code=s.slice(a,b)+'\nmodule.exports={bank285PickBalanced,bank285GraphicVerified,bank285ChooseBlock};';
const env={module:{exports:{}},console:{log:()=>{}},db:{query:async (_,params)=>({rows:params[0].map(i=>({block:i===1?'legislacion':i===2?'geografia':'especifico'}))})},Math};
vm.runInNewContext(code,env);
const {bank285PickBalanced}=env.module.exports;
function make(block,n,graphic=0,unmarked=0,topicOffset=0){
  const pairs=[];for(let i=0;i<n+graphic+unmarked;i++){
    const isG=i>=n,good=i<n+graphic,assetId=10000+topicOffset*1000+i;
    pairs.push({target:{id:100000+topicOffset*1000+i,topic_id:topicOffset*100+i%8,topic_block:block,
      section:'apartado'+(i%7),concept:'concept'+i,manual_page:String(10+i%30),source_page:i%30},
      question:{questionId:100000+topicOffset*1000+i,timesShown278:0,
        graphic:isG?{originalSelected:good,assetId,publicUrl:'/graphics/test'+i+'.png'}:null}});
  }return pairs;
}
(async()=>{
  const pool=[...make('legislacion',80,0,0,1),...make('geografia',80,0,0,2),...make('especifico',100,12,25,3)];
  for(let i=0;i<50;i++){
    const result=await bank285PickBalanced(pool,75,null,'mixto');
    assert.equal(result.length,75);
    for(const block of ['legislacion','geografia','especifico'])assert.equal(result.filter(x=>x.target.topic_block===block).length,25);
    assert(result.filter(x=>x.question.graphic).length<=7);
    assert(result.filter(x=>x.question.graphic).every(x=>x.question.graphic.originalSelected===true));
    assert.equal(new Set(result.map(x=>x.question.questionId)).size,75);
    assert.equal(new Set(result.map(x=>x.target.id)).size,75);
    assert(new Set(result.map(x=>x.target.topic_id)).size>=20);
  }
  for(const count of [60,100]){
    const result=await bank285PickBalanced(pool,count,null,'mixto');
    assert.equal(result.length,count);
    const perBlock=['legislacion','geografia','especifico'].map(b=>result.filter(x=>x.target.topic_block===b).length);
    assert(Math.max(...perBlock)-Math.min(...perBlock)<=1);
    assert(result.filter(x=>x.question.graphic).length<=Math.floor(count/10));
  }
  const two=await bank285PickBalanced(pool,75,[1,3],'mixto');
  assert.equal(two.filter(x=>x.target.topic_block==='legislacion').length,38);
  assert.equal(two.filter(x=>x.target.topic_block==='especifico').length,37);
  const none=await bank285PickBalanced(pool,75,null,'literal');
  assert.equal(none.filter(x=>x.question.graphic).length,0);
  const specific=await bank285PickBalanced(pool,75,[3],'mixto');
  assert.equal(specific.length,75);
  assert.equal(specific.filter(x=>x.question.graphic).length,7);
  await assert.rejects(()=>bank285PickBalanced(make('especifico',150,40,0,3),75,null,'mixto'),/legislacion/);
  await assert.rejects(()=>bank285PickBalanced([...make('legislacion',80,0,0,1),...make('geografia',80,0,0,2),...make('especifico',2,100,0,3)],75,null,'mixto'),/preguntas textuales/);
  console.log('PASS: 50 simulacros 75 (25/25/25), cap 7 gráficas, originales; pruebas 2 bloques, 1 bloque, literal, errores de falta de cobertura/texto.');
})().catch(e=>{console.error(e);process.exit(1)});
