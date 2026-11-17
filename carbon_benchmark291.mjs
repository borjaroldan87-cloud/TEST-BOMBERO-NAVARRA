// SOURCE ORIGINAL: SERVER290; nueva capa 291 aislada de producción.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import {createHmac,timingSafeEqual} from 'node:crypto';
const require=createRequire(import.meta.url);
const {cases,validateFixtures}=require('./carbon_benchmark290_data.cjs');
validateFixtures();
const schema={
  type:'object',
  properties:{
    stem:{type:'string'},
    options:{type:'array',minItems:4,maxItems:4,items:{type:'string'}},
    correctIndex:{type:'integer',minimum:0,maximum:3},
    explanation:{type:'string'},
    supportQuote:{type:'string'}
  },
  required:['stem','options','correctIndex','explanation','supportQuote']
};
function normalize(s){return String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();}
function checks(q,c=null){
  const out=[];
  if(!q||typeof q!=='object')return ['JSON ausente'];
  if(typeof q.stem!=='string'||q.stem.trim().length<25)out.push('Enunciado corto o vacío');
  if(/^seg[uú]n (el )?manual|^seg[uú]n (el )?ceis/i.test(q.stem.trim()))out.push('Cabecera genérica no deseada');
  if(!Array.isArray(q.options)||q.options.length!==4||q.options.some(x=>typeof x!=='string'||x.trim().length<4))return [...out,'No hay cuatro alternativas no vacías'];
  if(new Set(q.options.map(normalize)).size!==4)out.push('Alternativas repetidas o equivalentes literalmente');
  if(!Number.isInteger(q.correctIndex)||q.correctIndex<0||q.correctIndex>3)out.push('Índice de respuesta inválido');
  if(normalize(q.options[q.correctIndex]).length>=13 && normalize(q.stem).includes(normalize(q.options[q.correctIndex])))out.push('Respuesta literal incluida en el enunciado');
  if(typeof q.supportQuote!=='string'||q.supportQuote.trim().length<15)out.push('Falta respaldo documental');
  else if(c && !normalize(c.evidence).includes(normalize(q.supportQuote)))out.push('Cita NO literal en el extracto del PDF');
  return out;
}
function makePrompt(c){return `PRUEBA COMPARATIVA CIEGA — OPOSICIÓN BOMBEROS NAVARRA, 2026.
Eres examinador experto. Trabaja EXCLUSIVAMENTE con la evidencia del PDF original CEIS suministrada abajo. No añadas BOE, conocimientos externos, procedimientos no citados, leyes actuales ni datos inventados.
Genera EXACTAMENTE UNA pregunta individual de DIFICULTAD MUY ALTA, similar por redacción, economía de lenguaje y rigor al examen de oposición de bomberos Navarra de 2026.
La pregunta DEBE evaluar el objetivo concreto sin repetir su texto en el enunciado. Evita una premisa que regale la respuesta.
Cuatro alternativas técnicamente próximas y creíbles, de longitud y sintaxis comparables, exactamente una correcta. Distractores: modifica UN dato, una condición, una relación, una unidad o una secuencia que conste en el fragmento. No uses disparates, negaciones caricaturescas, absolutos infundados ni opciones de tema ajeno.
No emplees cabeceras repetitivas («según el manual», «acerca de...»). Si pides la INCORRECTA, las otras TRES deben ser literalmente verdaderas y distintas según la evidencia.
Cuando hay operaciones, deben derivarse solo de las fórmulas del PDF; explicita en el enunciado datos numéricos necesarios pero NO la fórmula resolutiva.
${c.kind==='grafica'?'La IMAGEN adjunta es una de las imágenes originales elegidas por el opositor. Haz imprescindible interpretarla junto al texto; no preguntes solo qué palabra aparece escrita ni copies su pie de foto.':'Esta ficha es SOLO TEXTO, no menciones ningún dibujo ni hagas depender la respuesta de imagen.'}
Si la evidencia no permite una pregunta genuinamente difícil, prioriza exactitud sobre complejidad ficticia.
Elige la respuesta correcta entre las cuatro y explica por qué las demás fallan. En supportQuote transcribe literalmente una porción del fragmento de evidencia que respalde la respuesta. No cites otras fuentes.

TEMA: ${c.theme}. PÁGINA IMPRESA DEL MANUAL: ${c.page}.
OBJETIVO INDIVIDUAL: ${c.objective}
EXTRACTO DOCUMENTAL SUMINISTRADO:
${c.evidence}

Devuelve solo el JSON requerido: stem, options (4), correctIndex (0–3), explanation, supportQuote.`;}
function safeImage(c){
  if(!c.image)return null;
  const root=path.resolve(process.cwd(),'public','graphics');
  const file=path.resolve(root,c.image);
  if(!file.startsWith(root+path.sep))throw Error('Ruta de imagen no permitida');
  if(!fs.existsSync(file))throw Error('Imagen original no localizada en el repositorio: '+c.image);
  const stat=fs.statSync(file);
  if(stat.size>2_000_000)throw Error('Imagen original demasiado grande: '+c.id);
  return {inlineData:{mimeType:/\.png$/i.test(file)?'image/png':'image/jpeg',data:fs.readFileSync(file).toString('base64')}};
}
// SERVER291 · Ensayo Carbon HIGH nativo en Interactions API / background.
// Solo 10 casos; mantiene la comparación con las respuestas Flash ya generadas.
// NO modifica DB, modelos de producción, SRS o preguntas existentes.
const SELECTED_IDS=['G38-01','G38-02','G39-01','G39-02','G41-01',
  'T38-01','T39-01','T40-01','T41-01','T42-01'];
const selected=SELECTED_IDS.map(id=>{
  const c=cases.find(c=>c.id===id);
  if(!c)throw Error('Caso comparativo inexistente: '+id);
  return c;
});
const baseline=JSON.parse(fs.readFileSync(new URL('./carbon_benchmark291_flash10.json',import.meta.url),'utf8'));
for(const c of selected){if(baseline[c.id]?.ok!==true)throw Error('Falta línea base Flash: '+c.id);}
const PROVIDER='https://generativelanguage.googleapis.com/v1beta/interactions';
const LEVEL='high';
// Máximo práctico próximo al límite UNIFICADO de 1.048.576 tokens, incluyendo razonamiento.
// No se limita el razonamiento mediante un presupuesto artificial. Puede implicar coste elevado.
const MAX_OUTPUT=1000000;
function quoteSafe(s){return String(s).replace(/[<>&]/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]));}
function html(){
  const index=JSON.stringify(selected.map(({id,theme,kind,page})=>({id,theme,kind,page}))).replace(/</g,'\\u003c');
  const flash=JSON.stringify(baseline).replace(/</g,'\\u003c');
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Comparativa Gemini 4 Carbon HIGH · 10 casos</title>
<style>body{font:15px system-ui,sans-serif;max-width:1100px;margin:25px auto;padding:0 15px;background:#f8fafc;color:#1c2938}h1{font-size:24px}p{line-height:1.55}button{border:1px solid #475569;border-radius:8px;background:white;padding:11px 14px;margin:4px;cursor:pointer}button.primary{background:#173e6e;color:white}button:disabled{opacity:.45;cursor:not-allowed}small{color:#526074}.box{border:1px solid #cad2de;background:#fff;padding:12px;border-radius:9px;margin:12px 0}.cols{display:grid;grid-template-columns:1fr 1fr;gap:12px}details{background:white;border:1px solid #d0d7de;border-radius:9px;padding:11px;margin:9px 0}summary{font-weight:bold;cursor:pointer}pre{white-space:pre-wrap;overflow-wrap:anywhere}.fail{color:#ab2424}.ok{color:#08654a}h3{margin-bottom:6px}@media(max-width:620px){.cols{grid-template-columns:1fr}}</style></head><body>
<h1>Comparativa Carbon HIGH frente a Flash · 10 conocimientos</h1>
<p><strong>5 casos gráficos y 5 textuales</strong> · Mismas fichas y mismo prompt del SERVER290. Flash: respuestas ya generadas, SIN nuevas llamadas. Carbon: <strong>HIGH</strong> (máximo oficial), mediante Interactions API <strong>background</strong>, con continuación larga y hasta 1.000.000 tokens de salida (razonamiento incluido, límite técnico).</p>
<div class="box"><strong>ATENCIÓN AL COSTE:</strong> Carbon factura los tokens de razonamiento. El límite técnico indicado permitiría un coste teórico cercano a <strong>10 USD por pregunta</strong> al precio introductorio de 10 USD/millón de tokens de salida (y aproximadamente el doble desde diciembre). Una prueba de diez preguntas podría acercarse a <strong>100 USD</strong> si consumiera todo el máximo. Normalmente el consumo será menor, pero no hay garantía. Revisa tu presupuesto en Google AI Studio antes de iniciar.</div>
<div><button class="primary" id="pilot">1. Iniciar UNA pregunta Carbon HIGH</button><button class="primary" id="all">2. Generar las otras nueve</button><button id="stop">Detener cola tras la petición actual</button><button id="refresh">Comprobar resultados pendientes</button><button id="download">Descargar comparación JSON</button></div>
<div class="box" id="status" aria-live="polite">Sin iniciar. No se ha efectuado ninguna llamada nueva a Carbon.</div>
<p><small>Las tareas se ejecutan en Google, incluso si cierras esta página. Cada identificador se guarda en este navegador para consultar el resultado después de recargar. «Detener» detiene las siguientes preguntas, pero no cancela una petición ya enviada al proveedor. No se modifica PostgreSQL ni la generación normal.</small></p><div id="results"></div>
<script>
const CASES=${index}, FLASH=${flash}, STORE='navarra-carbon291-high-background-v1';
let records={};let busy=false,stopping=false;
try{records=JSON.parse(localStorage.getItem(STORE)||'{}')||{}}catch{records={}}
const el=id=>document.getElementById(id);
const save=()=>localStorage.setItem(STORE,JSON.stringify(records));
function field(tag,s,parent){const e=document.createElement(tag);e.textContent=String(s||'');parent.append(e);return e;}
const doneCount=()=>CASES.filter(c=>records[c.id]?.result?.ok===true).length;
function render(){let count=doneCount(),pending=CASES.filter(c=>records[c.id]?.id&&!records[c.id]?.result).length;
  el('pilot').disabled=busy||!!records[CASES[0].id];
  el('all').disabled=busy||!records[CASES[0].id]?.result?.ok||count>=10;
  el('status').textContent='Flash ya disponibles: 10/10 · Carbon HIGH válidas: '+count+'/10 · pendientes en Google: '+pending+(busy?' · comprobando/ejecutando…':'');
  const root=el('results');root.replaceChildren();for(const c of CASES){const d=document.createElement('details');const s=document.createElement('summary');s.textContent=c.id+' · Tema '+c.theme+' · '+c.kind+' · p. '+c.page;d.append(s);const cols=document.createElement('div');cols.className='cols';for(const [name,r] of [['Flash',FLASH[c.id]],['Carbon HIGH',records[c.id]?.result]]){const box=document.createElement('div');field('h3',name,box);if(r?.ok){field('p',r.question?.stem||'',box);(r.question?.options||[]).forEach((x,i)=>field('p','ABCD'[i]+') '+x+(i===r.question.correctIndex?' [correcta]':''),box));field('small','Tokens '+(r.usage?.total||0)+' · tiempo '+Math.round((r.ms||0)/1000)+' s · modelo '+(r.modelVersion||r.model||''),box);if(r.warnings?.length)field('pre','Avisos: '+r.warnings.join('; '),box);}else if(r){field('pre','Error: '+(r.error||'Respuesta no válida'),box).className='fail';}else{const state=records[c.id];field('small',state?.id?'En ejecución o pendiente: '+state.id:'Pendiente',box);}cols.append(box);}d.append(cols);root.append(d);}}
async function api(path,method,body){let r=await fetch('/api/admin/carbon291'+path,{method,headers:{'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});let j;try{j=await r.json();}catch{throw Error('Respuesta HTTP no interpretable ('+r.status+')')}if(!r.ok)throw Error(j.error||'HTTP '+r.status);return j;}
async function checkOne(c){const rec=records[c.id];if(!rec?.id||rec?.result)return rec?.result;
  const r=await api('/status','POST',{caseId:c.id,id:rec.id,signature:rec.signature});
  if(r.done){rec.result=r.result||{ok:false,error:'Estado final sin resultado'};rec.result.ms=Math.max(0,Date.now()-Date.parse(rec.startedAt||new Date().toISOString()));rec.finishedAt=new Date().toISOString();save();render();}
  return rec.result;
}
async function waitOne(c){while(!records[c.id]?.result){try{await checkOne(c);}catch(e){el('status').textContent='Error consultando '+c.id+': '+e.message+' · El identificador sigue guardado; utiliza «Comprobar resultados pendientes». ';throw e;}
    if(records[c.id]?.result)break;await new Promise(resolve=>setTimeout(resolve,6000));}
  return records[c.id]?.result;}
async function startOne(c){if(records[c.id]?.id){return await waitOne(c)}
  // No repetir automáticamente una petición cuya respuesta inicial se perdió.
  const started=await api('/start','POST',{caseId:c.id});records[c.id]={id:started.id,signature:started.signature,startedAt:new Date().toISOString()};save();render();return await waitOne(c);}
async function pilot(){if(busy)return;if(!confirm('¿Confirmas UNA llamada Carbon en HIGH, con razonamiento sin capado artificial y posible coste elevado?'))return;busy=true;render();try{const x=await startOne(CASES[0]);if(!x?.ok)alert('El piloto no ha devuelto una pregunta válida: '+(x?.error||'sin detalle')+'. No se lanzarán las otras nueve.');}catch(e){alert('Error: '+e.message+'. Comprueba si quedó una petición pendiente antes de repetir.');}finally{busy=false;render();}}
async function all(){if(busy||!records[CASES[0].id]?.result?.ok)return;if(!confirm('¿Confirmas generar los nueve casos restantes con Carbon HIGH? Pueden generar costes elevados. No se harán llamadas a Flash.'))return;busy=true;stopping=false;render();try{for(const c of CASES.slice(1)){if(stopping)break;if(records[c.id]?.result?.ok)continue;const r=await startOne(c);if(!r?.ok){alert('Se ha detenido en '+c.id+': '+(r?.error||'sin respuesta')+'. Ningún reintento automático.');break;}}}catch(e){alert('Se ha detenido: '+e.message+'; conserva las peticiones ya iniciadas.');}finally{busy=false;render();}}
async function refresh(){if(busy)return;busy=true;render();try{for(const c of CASES)if(records[c.id]?.id&&!records[c.id]?.result){await checkOne(c);}}catch(e){alert('Consulta temporal fallida: '+e.message);}finally{busy=false;render();}}
el('pilot').onclick=pilot;el('all').onclick=all;el('stop').onclick=()=>{stopping=true;};el('refresh').onclick=refresh;
el('download').onclick=()=>{const obj={version:291,method:'Interactions API background; Carbon HIGH; max_output_tokens 1000000',cases:CASES,flash:FLASH,carbon:records,disclaimer:'La inspección automática no certifica calidad opositora.'};const url=URL.createObjectURL(new Blob([JSON.stringify(obj,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='COMPARATIVA_CARBON_HIGH_10_VS_FLASH_291.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),2000);};
render();if(Object.values(records).some(r=>r.id&&!r.result))refresh();
</script></body></html>`;
}
function longText(out){
  if(typeof out?.output_text==='string'&&out.output_text.trim())return out.output_text;
  const steps=(out?.steps||[]).filter(x=>x.type==='model_output');
  return steps.flatMap(x=>(x.content||[]).filter(y=>y.type==='text'&&typeof y.text==='string').map(y=>y.text)).join('');
}
function extractOutput(out,c,ms){
  const usage=out.usage||{};const text=longText(out);let q;
  try{q=JSON.parse(text.trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,''));}catch{}
  const stats={prompt:Number(usage.total_input_tokens||0),output:Number(usage.total_output_tokens||0),thought:Number(usage.total_thought_tokens||0),total:Number(usage.total_tokens||0)};
  if(!q||!Array.isArray(q.options)||q.options.length!==4||!Number.isInteger(q.correctIndex)||q.correctIndex<0||q.correctIndex>3){
    return {ok:false,caseId:c.id,model:'gemini-4-carbon',thinkingLevel:LEVEL,ms,usage:stats,
      error:'Salida incompleta/JSON inválido. Estado: '+String(out.status)+'. Caracteres: '+text.length+'. Tokens pensamiento: '+stats.thought+'. Texto inicial: '+text.slice(0,160)};
  }
  const reported=String(out.model||'');
  if(reported&&!reported.startsWith('gemini-4-carbon')){
    return {ok:false,caseId:c.id,model:'gemini-4-carbon',modelVersion:reported,thinkingLevel:LEVEL,ms,usage:stats,error:'El proveedor reportó un modelo distinto al solicitado: '+reported};
  }
  return {ok:true,benchmark291:true,caseId:c.id,kind:c.kind,theme:c.theme,model:'gemini-4-carbon',
    modelVersion:reported||'(no informado)',thinkingLevel:LEVEL,ms,usage:stats,question:q,warnings:[...(reported?[]:['Proveedor no informa versión exacta']),...checks(q,c)]};
}
function safeStatus(id){return typeof id==='string'&&id.length>=8&&id.length<1024&&/^[A-Za-z0-9_:\-]+$/.test(id);}
export function registerCarbonBenchmark291(app,{auth,apiKey=()=>process.env.GEMINI_API_KEY,remoteFetch=fetch}){
  if(typeof auth!=='function')throw Error('Falta autenticación administrador');
  const used=new Map(); const sign=(id,caseId)=>createHmac('sha256',String(process.env.TOPIC_ADMIN_PASSWORD||'')).update('291|'+caseId+'|'+id).digest('hex');
  const provider=async (url,options={})=>{
    const key=apiKey();if(!key)throw Error('No existe GEMINI_API_KEY en Render');
    const r=await remoteFetch(url,{...options,headers:{'x-goog-api-key':key,'Api-Revision':'2026-05-20','Content-Type':'application/json'},signal:AbortSignal.timeout(35000)});
    const raw=await r.text();let data;try{data=JSON.parse(raw);}catch{throw Error('Proveedor HTTP '+r.status+' no devolvió JSON ('+raw.slice(0,160)+')');}
    if(!r.ok)throw Error('Google HTTP '+r.status+': '+String(data?.error?.message||raw).slice(0,320));return data;
  };
  app.get('/admin/comparativa-carbon',auth,(_req,res)=>res.set('Cache-Control','no-store').type('html').send(html()));
  app.post('/api/admin/comparativa-carbon/one',auth,(_req,res)=>res.status(409).json({error:'Interfaz anterior desactivada: actualiza /admin/comparativa-carbon'}));
  app.post('/api/admin/carbon291/start',auth,async(req,res)=>{
    const caseId=String(req.body?.caseId||'');const c=selected.find(x=>x.id===caseId);
    if(!c)return res.status(400).json({error:'Caso no admitido'});
    if(used.has(caseId))return res.status(200).json(used.get(caseId));
    // Evita duplicar llamadas por pulsaciones simultáneas dentro de un proceso.
    const hold={id:null,pending:true};used.set(caseId,hold);
    try{
      const input=[{type:'text',text:makePrompt(c)}];const im=safeImage(c);
      if(im)input.push({type:'image',data:im.inlineData.data,mime_type:im.inlineData.mimeType});
      const interaction=await provider(PROVIDER,{method:'POST',body:JSON.stringify({
        model:'gemini-4-carbon',input,background:true,store:true,
        generation_config:{thinking_level:LEVEL,max_output_tokens:MAX_OUTPUT},
        response_format:{type:'text',mime_type:'application/json',schema}
      })});
      if(!safeStatus(interaction.id))throw Error('Google no devolvió un identificador válido, no reintentes sin comprobar consumos.');
      const record={id:interaction.id,signature:sign(interaction.id,caseId)};used.set(caseId,record);res.status(202).json(record);
    }catch(e){
      used.delete(caseId);res.status(502).json({error:String(e?.message||e).slice(0,500)+'; no se ha reintentado automáticamente'});
    }
  });
  app.post('/api/admin/carbon291/status',auth,async(req,res)=>{
    const caseId=String(req.body?.caseId||''),id=String(req.body?.id||''),sig=String(req.body?.signature||'');
    const c=selected.find(x=>x.id===caseId);
    if(!c||!safeStatus(id)||!/^[a-f0-9]{64}$/.test(sig))return res.status(400).json({error:'Identificador inválido'});
    const expected=Buffer.from(sign(id,caseId),'hex'),actual=Buffer.from(sig,'hex');
    if(!timingSafeEqual(expected,actual))return res.status(403).json({error:'Identificador no asociado a este ensayo'});
    try{
      const out=await provider(PROVIDER+'/'+encodeURIComponent(id),{method:'GET'});
      const state=String(out.status||'').toLowerCase();
      if(state==='completed'){return res.json({done:true,status:state,result:extractOutput(out,c,0)});}
      if(['failed','cancelled','requires_action'].includes(state))return res.json({done:true,status:state,result:{ok:false,caseId,error:state+': '+JSON.stringify(out.error||'sin detalle').slice(0,300)}});
      return res.json({done:false,status:state||'in_progress',usage:out.usage||null});
    }catch(e){return res.status(502).json({error:String(e?.message||e).slice(0,500)+'; conserva el ID y vuelve a consultar, sin crear otra llamada'});}
  });
  return {cases:selected.length,model:'gemini-4-carbon',thinkingLevel:LEVEL,outputTechnicalLimit:MAX_OUTPUT,background:true};
}
export const testing291={selected,makePrompt,checks,extractOutput,html};
