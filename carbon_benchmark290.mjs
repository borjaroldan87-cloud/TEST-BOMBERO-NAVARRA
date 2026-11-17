// SERVER290 · Comparativa A/B controlada: 20 preguntas por modelo, SIN ALTERAR BD.
// /admin/comparativa-carbon requiere TOPIC_ADMIN_PASSWORD existente.
// Las llamadas solo se ejecutan al pulsar INICIAR en la interfaz protegida.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url);
const {cases,validateFixtures}=require('./carbon_benchmark290_data.cjs');
validateFixtures();

const MODELS=Object.freeze(['gemini-3.6-flash','gemini-4-carbon']);
const MAX_CALLS=40; // 20 casos x 2 modelos, 0 reintentos implícitos.
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
function html(){
  const list=JSON.stringify(cases.map(({id,theme,kind,page})=>({id,theme,kind,page}))).replace(/</g,'\\u003c');
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Comparativa Gemini 4 Carbon · SERVER290</title>
<style>body{font:15px system-ui,sans-serif;max-width:1080px;margin:24px auto;padding:0 16px;color:#17212c;background:#f8f9fb}h1{font-size:24px}p{line-height:1.5}button{border:1px solid #344054;padding:10px 14px;border-radius:8px;cursor:pointer;background:white;margin:4px 6px 4px 0}button.primary{background:#1a365d;color:white}.cols{display:grid;grid-template-columns:1fr 1fr;gap:15px}pre{white-space:pre-wrap;overflow-wrap:anywhere}article{background:white;border:1px solid #d4d9df;border-radius:10px;padding:14px;margin:10px 0}small{color:#54606d}summary{font-weight:650;cursor:pointer}#status{padding:10px 0;font-weight:600}span.error{color:#b42318}@media(max-width:700px){.cols{grid-template-columns:1fr}} </style>
</head><body><h1>Comparativa Carbon vs Flash · 20 conocimientos</h1>
<p><strong>Prueba aislada:</strong> 10 preguntas con imagen, 10 de texto. Dos modelos sobre el mismo PDF y prompt, 40 llamadas como máximo. <strong>No se modifica PostgreSQL, Gemini de producción ni las estadísticas.</strong> El gasto de API empieza solo al pulsar «Iniciar».</p>
<div><button class="primary" id="start">Iniciar / continuar prueba</button><button id="pause">Detener después de esta llamada</button><button id="download">Descargar resultados JSON</button><button id="reset">Reiniciar resultados locales</button></div>
<div id="status"></div><p><small>Se conservan los resultados en este navegador hasta que se borren. Acceso protegido por la contraseña existente de administración de temas. Si aparece HTTP 403/429, el modelo no tiene cuota o permiso; no se sustituye por otro.</small></p>
<div id="results"></div>
<script>
const CASES=${list};const MODELS=['gemini-3.6-flash','gemini-4-carbon'];const STORAGE_KEY='navarra-carbon290-ab-v1';let results={};let running=false;let paused=false;
try{results=JSON.parse(localStorage.getItem(STORAGE_KEY)||'{}')||{}}catch{}
const byId=id=>document.getElementById(id);
function save(){localStorage.setItem(STORAGE_KEY,JSON.stringify(results));}
function text(tag,content,parent){const e=document.createElement(tag);e.textContent=content;parent.append(e);return e;}
function render(){const statuses=Object.values(results);const ok=statuses.filter(x=>x.ok).length;const fail=statuses.filter(x=>!x.ok).length;const ms=statuses.filter(x=>x.ok).reduce((n,x)=>n+(x.ms||0),0);const tok=statuses.filter(x=>x.ok).reduce((n,x)=>n+(x.usage?.total||0),0);byId('status').textContent='Respuestas recibidas: '+ok+'/40; errores: '+fail+'; tiempo agregado: '+Math.round(ms/1000)+' s; tokens declarados: '+tok+'; '+(running?'en curso':'sin actividad');
const root=byId('results');root.replaceChildren();for(const c of CASES){const art=document.createElement('article');const det=document.createElement('details');const sums=document.createElement('summary');sums.textContent=c.id+' · Tema '+c.theme+' · '+c.kind+' · p. '+c.page;det.append(sums);const pair=document.createElement('div');pair.className='cols';for(const model of MODELS){const box=document.createElement('div');text('h3',model,box);const r=results[c.id+'|'+model];if(!r)text('small','Sin probar',box);else if(!r.ok){const e=text('pre','ERROR: '+r.error,box);e.className='error';}else{const q=r.question;text('p',q.stem||'(sin enunciado)',box);(q.options||[]).forEach((op,i)=>text('p',String.fromCharCode(65+i)+') '+op+(i===q.correctIndex?' [correcta]':''),box));text('small','Tiempo '+Math.round(r.ms/1000)+' s; tokens '+r.usage.total+'; versión API '+r.modelVersion,box);if(r.warnings.length)text('pre','Avisos automáticos: '+r.warnings.join('; '),box);text('p','Fuente: '+(q.supportQuote||''),box);text('p','Explicación: '+(q.explanation||''),box);}pair.append(box);}det.append(pair);art.append(det);root.append(art);}}
async function run(){if(running)return;running=true;paused=false;byId('start').disabled=true;render();try{for(const c of CASES){if(paused)break;for(const model of MODELS){if(paused)break;const k=c.id+'|'+model;if(Object.prototype.hasOwnProperty.call(results,k))continue;byId('status').textContent='Generando '+c.id+' con '+model+'… (sin reintentos automáticos)';let obj;try{const resp=await fetch('/api/admin/comparativa-carbon/one',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({caseId:c.id,model})});obj=await resp.json();if(!resp.ok)throw Error(obj.error||'HTTP '+resp.status);results[k]=obj;}catch(e){results[k]={ok:false,error:String(e.message||e)};}
save();render();}}}finally{running=false;byId('start').disabled=false;render();}}
byId('start').onclick=run;byId('pause').onclick=()=>{paused=true;byId('status').textContent='Se detendrá después de la llamada actual.';};
byId('download').onclick=()=>{const blob=new Blob([JSON.stringify({version:290,source:'PDF CEIS suministrados',models:MODELS,caseIndex:CASES,results},null,2)],{type:'application/json'});const u=URL.createObjectURL(blob);const a=document.createElement('a');a.href=u;a.download='RESULTADOS_AB_GEMINI_CARBON_290.json';a.click();setTimeout(()=>URL.revokeObjectURL(u),1000);};
byId('reset').onclick=()=>{if(!confirm('¿Borrar los resultados guardados en este navegador? No borra preguntas ni base de datos.'))return;results={};save();render();};render();
</script></body></html>`;
}
export function registerCarbonBenchmark290(app,{aiClient,auth}){
  if(!app||typeof aiClient!=='function'||typeof auth!=='function')throw Error('Falta integración benchmark');
  let totalCalls=0,busy=false;
  const attempted=new Set(), completedResults=new Map();
  app.get('/admin/comparativa-carbon',auth,(_req,res)=>res.type('html').send(html()));
  app.post('/api/admin/comparativa-carbon/one',auth,async(req,res)=>{
    const id=String(req.body?.caseId||'');const model=String(req.body?.model||'');
    const c=cases.find(x=>x.id===id);
    if(!c||!MODELS.includes(model))return res.status(400).json({ok:false,error:'Caso o modelo no autorizado'});
    if(completedResults.has(id+'|'+model)){
      const saved=completedResults.get(id+'|'+model);
      return res.status(saved.ok?200:502).json(saved);
    }
    if(busy)return res.status(409).json({ok:false,error:'Ya hay una llamada de ensayo en curso'});
    if(totalCalls>=MAX_CALLS)return res.status(429).json({ok:false,error:'Límite absoluto de 40 llamadas por proceso alcanzado. Descarga los resultados.'});
    const key=id+'|'+model;
    if(attempted.has(key))return res.status(409).json({ok:false,error:'Caso ya intentado; no se repetirá automáticamente (protección de coste)'});
    busy=true;attempted.add(key);totalCalls++;
    const began=Date.now();
    try{
      const parts=[{text:makePrompt(c)}];const im=safeImage(c);if(im)parts.push(im);
      const response=await aiClient().models.generateContent({
        model,contents:[{role:'user',parts}],
        config:{responseMimeType:'application/json',responseJsonSchema:schema,
          thinkingConfig:{thinkingLevel:'high'},maxOutputTokens:6500,
          httpOptions:{timeout:90000}}
      });
      let q;try{q=JSON.parse(String(response?.text||''));}catch{throw Error('El proveedor no devolvió JSON interpretable');}
      const u=response?.usageMetadata||{};
      const result={ok:true,caseId:id,kind:c.kind,theme:c.theme,model,
        modelVersion:String(response?.modelVersion||'(no informada)'),ms:Date.now()-began,
        usage:{prompt:Number(u.promptTokenCount||0),output:Number(u.candidatesTokenCount||0),thought:Number(u.thoughtsTokenCount||0),total:Number(u.totalTokenCount||0)},
        warnings:checks(q,c),question:q};
      completedResults.set(key,result);
      return res.json(result);
    }catch(e){
      const result={ok:false,error:String(e?.message||e).slice(0,500),caseId:id,model,ms:Date.now()-began};
      completedResults.set(key,result);
      return res.status(502).json(result);
    }finally{busy=false;}
  });
  return {cases:cases.length,limits:MAX_CALLS,models:MODELS};
}

// Para pruebas locales exportar funciones puras sin exponer rutas ni llamada a IA.
export const testing290={makePrompt,checks,validateFixtures,MODELS};
