let qs=[],ans=[],i=0;
const $=id=>document.getElementById(id);
async function api(url,opts={}){let r=await fetch(url,{headers:{"Content-Type":"application/json"},...opts});let j=await r.json();if(!j.ok)throw Error(j.error||"Error");return j}
async function status(){try{let j=await api("/api/status");$("status").textContent=j.keyConfigured?"API preparada":"Falta configurar GEMINI_API_KEY"}catch(e){$("status").textContent=e.message}}
async function ingest(){try{$("ingest").textContent="Indexando…";await api("/api/ingest-benchmark",{method:"POST"});$("ingest").textContent="✓ PDF INDEXADO"}catch(e){alert(e.message);$("ingest").textContent="1. INDEXAR PDF"}}
const wait=ms=>new Promise(r=>setTimeout(r,ms));

async function generate(){
  const btn=$("generate");
  const originalText=btn.textContent;

  try{
    btn.disabled=true;
    btn.textContent="GENERANDO TEST...";

    const j=await api("/api/generate",{
      method:"POST",
      body:JSON.stringify({
        count:+$("count").value,
        difficulty:$("difficulty").value,
        mode:$("mode").value
      })
    });

    if(!j.ok){
      throw new Error(j.error||"No se pudo generar el test.");
    }

    if(!j.questions || j.questions.length===0){
      throw new Error("No se recibieron preguntas.");
    }

    qs=j.questions;
    ans=[];
    i=0;

    $("quiz").style.display="block";
    $("result").innerHTML="";
    show();

  }catch(e){
    alert(e?.message||String(e));
  }finally{
    btn.disabled=false;
    btn.textContent=originalText;
  }
}
async function analyzeCoverage(){
  const btn=$("coverage");
  const originalText=btn.textContent;

  try{
    btn.disabled=true;
    btn.textContent="ANALIZANDO TODO EL TEMA...";

    const j=await api("/api/analyze-coverage",{
      method:"POST",
      body:JSON.stringify({})
    });

    if(!j.ok){
      throw new Error(j.error||"No se pudo analizar la cobertura del tema.");
    }

    alert(
      "ANÁLISIS COMPLETADO\n\n"+
      "Tema: "+j.topic+"\n"+
      "Elementos detectados: "+j.totalItems+"\n"+
      "Trabajados: "+j.workedItems+"\n"+
      "Pendientes: "+j.pendingItems+"\n"+
      "Cobertura actual: "+j.coveragePercentage+" %"
    );

  }catch(e){
    alert(e?.message||String(e));
  }finally{
    btn.disabled=false;
    btn.textContent=originalText;
  }
}
function show(){let q=qs[i];$("quiz").innerHTML=`<div class="c"><div class="muted">Pregunta ${i+1}/${qs.length}</div><h2>${q.stem}</h2>${q.options.map((x,j)=>`<button class="opt ${ans[i]===j?"sel":""}" onclick="pick(${j})">${"ABCD"[j]}) ${x}</button>`).join("")}<button onclick="${i?`i--;show()`:"void(0)"}">Anterior</button> <button onclick="${i<qs.length-1?`next()`:`finish()`}">${i<qs.length-1?"Siguiente":"Finalizar"}</button></div>`}
function pick(j){ans[i]=j;show()} function next(){if(ans[i]===null)return alert("Selecciona una respuesta");i++;show()}
function finish(){if(ans.some(x=>x===null))return alert("Faltan respuestas");let ok=ans.filter((x,k)=>x===qs[k].correctIndex).length;$("quiz").classList.add("hidden");$("result").classList.remove("hidden");$("result").innerHTML=`<div class="c"><h2>${ok}/${qs.length} · ${Math.round(ok/qs.length*100)}%</h2><button onclick="review()">REVISAR</button></div>`}
function review(){$("result").innerHTML=qs.map((q,k)=>`<div class="c"><b>${k+1}. ${q.stem}</b><p class="${ans[k]===q.correctIndex?"ok":"bad"}">Tu respuesta: ${"ABCD"[ans[k]]}) ${q.options[ans[k]]}</p>${ans[k]!==q.correctIndex?`<p class="ok">Correcta: ${"ABCD"[q.correctIndex]}) ${q.options[q.correctIndex]}</p>`:""}<p>${q.explanation}</p><p class="muted"><b>Fuente:</b> ${q.sourceEvidence}${q.sourcePage?` · pág. ${q.sourcePage}`:""}</p></div>`).join("")+`<button onclick="location.reload()">NUEVO TEST</button>`}
status();

