let qs=[],ans=[],i=0,sessionId=null;
const $=id=>document.getElementById(id);
async function api(url,opts={}){let r=await fetch(url,{headers:{"Content-Type":"application/json"},...opts});let j=await r.json();if(!j.ok)throw Error(j.error||"Error");return j}
async function status(){try{let j=await api("/api/status");$("status").textContent=j.keyConfigured?"API preparada":"Falta configurar GEMINI_API_KEY"}catch(e){$("status").textContent=e.message}}
async function ingest(){try{$("ingest").textContent="Indexando…";await api("/api/ingest-benchmark",{method:"POST"});$("ingest").textContent="✓ PDF INDEXADO"}catch(e){alert(e.message);$("ingest").textContent="1. INDEXAR PDF"}}
const wait=ms=>new Promise(r=>setTimeout(r,ms));
function inferTopicOrder(fileName,fallbackOrder){
  const base=
    String(fileName || "")
      .replace(/\.pdf$/i,"")
      .trim();

  const match=
    base.match(
    /^\s*(?:tema\s*)?(\d{1,3})(?=(?:\s*[\.\-_\)]|\s+|$))/i
    );

  if(match){
    const parsed=Number(match[1]);

    if(
      Number.isInteger(parsed) &&
      parsed > 0
    ){
      return parsed;
    }
  }

  return fallbackOrder;
}

function topicNameFromFile(fileName){
  return String(fileName || "")
    .replace(/\.pdf$/i,"")
    .replace(/_/g," ")
    .replace(/\s+/g," ")
    .trim();
}

async function readBatchResponse(response){
  const raw=
    await response.text();

  let data;

  try{
    data=
      raw
        ? JSON.parse(raw)
        : {};
  }catch{
    throw new Error(
      `Respuesta no válida del servidor (${response.status}).`
    );
  }

  if(
    !response.ok ||
    data.ok === false
  ){
    throw new Error(
      data.error ||
      `Error HTTP ${response.status}`
    );
  }

  return data;
}
async function waitForCoverageRun(runId,timeoutMs=1800000){
  const startedAt=Date.now();

  while(Date.now()-startedAt < timeoutMs){
    const state=await api(
      `/api/coverage-run/${encodeURIComponent(runId)}`
    );

    if(state.status === "completed"){
      return state;
    }

    if(state.status === "error"){
      throw new Error(
        state.error ||
        "El análisis de cobertura terminó con error."
      );
    }

    await wait(3000);
  }

  throw new Error(
    "El análisis sigue sin confirmar después de 30 minutos."
  );
}
async function uploadTopicBatch(){
  const input=
    $("topicUploadFiles");

  const block=
    $("topicUploadBlock")?.value;

  const btn=
    $("uploadTopics");

  const statusBox=
    $("uploadTopicsStatus");

  const files=
    Array.from(
      input?.files || []
    );

  if(!files.length){
    alert(
      "Selecciona al menos un PDF."
    );
    return;
  }

  if(
    ![
      "legislacion",
      "geografia",
      "especifico"
    ].includes(block)
  ){
    alert(
      "Selecciona un bloque válido."
    );
    return;
  }

  const entries=
    files
      .map((file,index)=>({
        file,
        topicName:
          topicNameFromFile(
            file.name
          ),
        topicOrder:
          inferTopicOrder(
            file.name,
            index + 1
          )
      }))
      .sort((a,b)=>
        a.topicOrder - b.topicOrder ||
        a.file.name.localeCompare(
          b.file.name,
          "es"
        )
      );

  const errors=[];
  let completed=0;

  btn.disabled=true;

  try{
    for(
      let index=0;
      index<entries.length;
      index++
    ){
      const entry=
        entries[index];

      const position=
        index + 1;

      try{
      
        statusBox.textContent=
          `${position}/${entries.length} · ` +
          `Indexando ${entry.topicName}...`;

        const formData=
          new FormData();

        formData.append(
          "pdf",
          entry.file
        );

        formData.append(
          "topicName",
          entry.topicName
        );

        formData.append(
          "block",
          block
        );

        formData.append(
          "topicOrder",
          String(entry.topicOrder)
        );

        const uploadResponse=
          await fetch(
            "/api/upload",
            {
              method:"POST",
              body:formData
            }
          );

        const uploaded=
          await readBatchResponse(
            uploadResponse
          );

        statusBox.textContent=
          `${position}/${entries.length} · ` +
          `Analizando cobertura de ${entry.topicName}...`;

        const runId=
          globalThis.crypto?.randomUUID?.() ||
          `coverage-${Date.now()}-${Math.random().toString(36).slice(2)}`;

        let analyzed;

        try{
          const coverageResponse=
            await fetch(
              "/api/analyze-coverage",
              {
                method:"POST",
                headers:{
                  "Content-Type":
                    "application/json"
                },
                body:JSON.stringify({
                  topicId:
                    uploaded.topicId,
                  uploadToken:
                    uploaded.uploadToken,
                  runId
                })
              }
            );

          analyzed=
            await readBatchResponse(
              coverageResponse
            );

        }catch(error){
          if(
            String(error?.message || error)
              .includes("Failed to fetch")
          ){
            statusBox.textContent=
              `${position}/${entries.length} · ` +
              `Conexión interrumpida. Verificando ${entry.topicName}...`;

            analyzed=
              await waitForCoverageRun(runId);
          }else{
            throw error;
          }
        }

        completed++;

        statusBox.textContent=
          `${position}/${entries.length} · ✓ ` +
          `${entry.topicName} · ` +
          `${analyzed.totalItems} elementos`;

      }catch(error){
        const message=
          error?.message ||
          String(error);

        errors.push(
          `${entry.file.name}: ${message}`
        );

        statusBox.textContent=
          `${position}/${entries.length} · ERROR en ` +
          `${entry.topicName}. Continuando...`;

        await wait(600);
      }
    }

    const failed=
      errors.length;

    statusBox.textContent=
      `Carga terminada · ` +
      `${completed} correctos · ` +
      `${failed} con error`;

    let summary=
      "CARGA DE TEMAS COMPLETADA\n\n"+
      "Procesados correctamente: "+
      completed+
      "\n"+
      "Con error: "+
      failed;

    if(errors.length){
      summary+=
        "\n\nERRORES:\n"+
        errors
          .slice(0,10)
          .join("\n");

      if(errors.length>10){
        summary+=
          `\n... y ${
            errors.length-10
          } errores más.`;
      }
    }

    alert(summary);

  }finally{
    btn.disabled=false;
  }
}
// Recuerda una generación que terminó en Render aunque se cortase HTTP.
// No vuelve a pedir otro test: consulta el MISMO runId hasta obtenerlo.
async function waitForGenerationRun93(runId){
  const deadline=Date.now()+12*60*1000;
  while(Date.now()<deadline){
    await wait(4000);
    let status;
    try{status=await api(`/api/generation-run/${encodeURIComponent(runId)}`);}
    catch(error){
      // Los estados desconocidos no se resuelven por seguir esperando.
      if(/No existe esa generaci|Identificador de test inv/i.test(String(error?.message||error))){
        throw error;
      }
      continue; // Error temporal de red: no duplicar generación.
    }
    if(status.status==='completed')return status;
    if(status.status==='failed'||status.status==='stale'){
      throw new Error(status.error||'No se pudo completar la generación.');
    }
  }
  throw new Error('No se recibió el test dentro del tiempo de espera. Comprueba Render antes de volver a generar.');
}
async function generate(){
  const btn=$("generate");
  const originalText=btn.textContent;

  try{
    btn.disabled=true;
    btn.textContent="GENERANDO TEST...";

    const allScope=
  $("scopeAll")?.checked === true;

if(
  !allScope &&
  selectedBlocks.size===0 &&
  selectedTopicIds.size===0
){
  throw new Error(
    "Selecciona al menos un bloque o tema."
  );
}

currentTestLabel=
  buildSelectionLabel();

const runId=globalThis.crypto?.randomUUID?.() ||
  `generation-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const generationPayload={
  runId,
  count:+$("count").value,
  difficulty:$("difficulty").value,
  mode:$("mode").value,
  testType:$("testType")?.value || "normal",
  examMode:$("examMode")?.value || "training",
  selectedBlocks:allScope?[]:[...selectedBlocks],
  selectedTopicIds:allScope?[]:[...selectedTopicIds]
};
let j;
let uncertainTransport=false;
try{
  const response=await fetch('/api/generate',{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify(generationPayload)
  });
  const raw=await response.text();
  try{j=JSON.parse(raw);}catch{
    // Un proxy puede devolver HTML (502/503/504) después del COMMIT.
    // En ese caso el resultado es DESCONOCIDO, no un test fallido.
    uncertainTransport=true;
  }
  // Una respuesta de gateway 408/502/503/504 no demuestra fracaso
  // de la operación: también puede ocultar un COMMIT completado.
  if([408,502,503,504].includes(response.status))uncertainTransport=true;
  if(!uncertainTransport){
    if(j?.ok===false){
      throw new Error(j.error||`Error HTTP ${response.status}`);
    }
    if(!response.ok)throw new Error(`Error HTTP ${response.status}`);
  }
}catch(error){
  if(!/failed to fetch|networkerror|network error|load failed/i.test(String(error?.message||error)))throw error;
  uncertainTransport=true;
}
if(uncertainTransport){
  btn.textContent='RECUPERANDO TEST...';
  j=await waitForGenerationRun93(runId);
}
if(j?.pending){
  btn.textContent='RECUPERANDO TEST...';
  j=await waitForGenerationRun93(runId);
}

    if(!j.ok){
      throw new Error(j.error||"No se pudo generar el test.");
    }

    if(!j.questions || j.questions.length===0){
      throw new Error("No se recibieron preguntas.");
    }

    qs=j.questions;
    sessionId=j.sessionId;
ans=Array(qs.length).fill(null);
i=0;

    $("quiz").style.display="block";
    $("result").innerHTML="";
    show();
    startExamTimer();

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
let timerInterval=null;
let remainingSeconds=0;

function startExamTimer(){
  clearInterval(timerInterval);

  // Regla del test: 1 minuto por pregunta.
  remainingSeconds=qs.length*60;

  updateTimer();

  timerInterval=setInterval(()=>{
    remainingSeconds--;

    if(remainingSeconds<=0){
      remainingSeconds=0;
      updateTimer();
      clearInterval(timerInterval);
      finish(true);
      return;
    }

    updateTimer();
  },1000);
}

function updateTimer(){
  const timer=$("timer");
  if(!timer)return;

  const minutes=Math.floor(remainingSeconds/60);
  const seconds=remainingSeconds%60;

  timer.textContent=
    String(minutes).padStart(2,"0")+":"+
    String(seconds).padStart(2,"0");
}

function answeredCount(){
  return ans.filter(x=>Number.isInteger(x)).length;
}

function renderGraphic(q){
  const g=q?.graphic;

  if(!g?.publicUrl){
    return "";
  }

  const esc=value=>String(value??"")
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;");

  const clamp01=value=>{
    const n=Number(value);
    if(!Number.isFinite(n)) return null;
    return Math.min(1,Math.max(0,n));
  };

  const crop=g.crop ?? {};

  const x=clamp01(crop.x) ?? 0;
  const y=clamp01(crop.y) ?? 0;
  const width=clamp01(crop.width) ?? 1;
  const height=clamp01(crop.height) ?? 1;

  const safeWidth=Math.max(
    0.001,
    Math.min(width,1-x)
  );

  const safeHeight=Math.max(
    0.001,
    Math.min(height,1-y)
  );

  const imageWidth=100/safeWidth;
  const imageLeft=-(x/safeWidth)*100;
  const imageTop=-(y/safeHeight)*100;

  const cropRatio=safeWidth/safeHeight;

  const maskRegions=
    Array.isArray(g.maskRegions)
      ? g.maskRegions
      : [];

  const masksHtml=maskRegions.map(region=>{
    const rx=clamp01(region?.x);
    const ry=clamp01(region?.y);
    const rw=clamp01(region?.width);
    const rh=clamp01(region?.height);

    if(
      rx===null ||
      ry===null ||
      rw===null ||
      rh===null ||
      rw<=0 ||
      rh<=0
    ){
      return "";
    }

    const regionRight=Math.min(1,rx+rw);
    const regionBottom=Math.min(1,ry+rh);

    const visibleLeft=Math.max(x,rx);
    const visibleTop=Math.max(y,ry);
    const visibleRight=Math.min(x+safeWidth,regionRight);
    const visibleBottom=Math.min(y+safeHeight,regionBottom);

    if(
      visibleRight<=visibleLeft ||
      visibleBottom<=visibleTop
    ){
      return "";
    }

    const left=
      ((visibleLeft-x)/safeWidth)*100;

    const top=
      ((visibleTop-y)/safeHeight)*100;

    const maskWidth=
      ((visibleRight-visibleLeft)/safeWidth)*100;

    const maskHeight=
      ((visibleBottom-visibleTop)/safeHeight)*100;

    return `
      <span
        aria-hidden="true"
        style="
          position:absolute;
          left:${left}%;
          top:${top}%;
          width:${maskWidth}%;
          height:${maskHeight}%;
          background:#fff;
          z-index:2;
          pointer-events:none;
        "
      ></span>
    `;
  }).join("");

  return `
    <div
      class="question-graphic"
      style="
        width:min(100%,480px);
        aspect-ratio:${cropRatio};
        max-height:320px;
        overflow:hidden;
        position:relative;
        margin:14px auto;
        background:#fff;
      "
    >
      <img
        src="${esc(g.publicUrl)}"
        alt="Imagen técnica de la pregunta"
        draggable="false"
        style="
          position:absolute;
          display:block;
          width:${imageWidth}%;
          height:auto;
          max-width:none;
          left:${imageLeft}%;
          top:${imageTop}%;
          user-select:none;
          -webkit-user-drag:none;
          z-index:1;
        "
      >
      ${masksHtml}
    </div>
  `;
}


function show(){
  const answered=answeredCount();
  const blank=qs.length-answered;

  $("quiz").classList.remove("hidden");

  $("quiz").innerHTML=`
    <div class="exam-toolbar">
      <div>
        Contestadas <b>${answered}</b>
        · En blanco <b>${blank}</b>
      </div>

      <div class="exam-timer">
        Tiempo <span id="timer">--:--</span>
      </div>
    </div>

    <div class="exam-paper">

      <div class="exam-heading">
        <strong>PRUEBA TEÓRICA</strong>
        <span>TEST DE ENTRENAMIENTO · NO OFICIAL</span>
      </div>

      <div class="exam-block-info">

  <strong>
    ${escapeHtml(currentTestLabel)}
  </strong>

  <br><br>

  <strong>
    ${qs.length} preguntas
  </strong>

  (de la 1 a la ${qs.length})

</div>

      ${qs.map((q,k)=>`
        <div class="exam-question">

          <div class="question-stem">
            ${k+1}. ${formatExamContent(q.stem)}
          </div>
${renderGraphic(q)}
          <div>
            ${q.options.map((option,j)=>`
              <button
                class="opt ${ans[k]===j?"sel":""}"
                onclick="pick(${k},${j})">
                <b>${"ABCD"[j]})</b> ${formatExamContent(option)}
              </button>
            `).join("")}
          </div>

        </div>
      `).join("")}

      <div class="exam-nav">
        <button
          class="primary"
          onclick="requestFinish()">
          FINALIZAR Y ENTREGAR
        </button>
      </div>

    </div>
  `;

  updateTimer();
}

function pick(questionIndex,optionIndex){
  /*
    Pulsar otra opción cambia la respuesta.
    Pulsar de nuevo la misma opción la deja en blanco.
  */
  if(ans[questionIndex]===optionIndex){
    ans[questionIndex]=null;
  }else{
    ans[questionIndex]=optionIndex;
  }

  const scrollPosition=window.scrollY;

  show();

  window.scrollTo(0,scrollPosition);
}

function requestFinish(){
  const pending=qs.length-answeredCount();

  let message="¿Quieres finalizar y entregar el test?";

  if(pending>0){
    message=
      `Tienes ${pending} pregunta${pending===1?"":"s"} sin contestar.\n\n`+
      `Se contabilizarán como respuestas en blanco.\n\n`+
      `¿Quieres finalizar igualmente?`;
  }

  if(confirm(message)){
    finish(false);
  }
}

async function finish(auto=false){
  clearInterval(timerInterval);
  try{
    if(!Number.isInteger(Number(sessionId))){
      throw new Error("No existe una sesión válida para este test.");
    }

    const answeredQuestions=qs
      .map((q,index)=>({
        questionId:Number(q.questionId),
        selectedIndex:ans[index]
      }))
      .filter(item=>Number.isInteger(item.selectedIndex));

    // Guardado secuencial: evita saturar Render/PostgreSQL con 10–75
    // escrituras simultáneas. La API conserva la idempotencia por pregunta.
    for(const item of answeredQuestions){
      await api("/api/answer",{
        method:"POST",
        body:JSON.stringify({
          sessionId:Number(sessionId),
          questionId:item.questionId,
          selectedIndex:item.selectedIndex
        })
      });
    }
    await api("/api/finish-test",{
      method:"POST",
      body:JSON.stringify({
        sessionId:Number(sessionId)
      })
    });
  }catch(e){
    alert(
      "No se pudieron guardar los resultados del test.\n\n"+
      (e?.message||String(e))
    );
    return;
  }
  const correct=ans.filter(
    (answer,index)=>answer===qs[index].correctIndex
  ).length;

  const answered=answeredCount();
  const wrong=answered-correct;
  const blank=qs.length-answered;

  const pointsPerCorrect=0.8;
  const penaltyPerWrong=pointsPerCorrect/3;

  const score=
    correct*pointsPerCorrect-
    wrong*penaltyPerWrong;

  const maxScore=qs.length*pointsPerCorrect;

  $("quiz").classList.add("hidden");
  $("result").classList.remove("hidden");

  $("result").innerHTML=`
    <div class="c">

      <h2>
        ${auto?"TIEMPO FINALIZADO":"TEST FINALIZADO"}
      </h2>

      <p>
        <b>Aciertos:</b> ${correct}<br>
        <b>Errores:</b> ${wrong}<br>
        <b>En blanco:</b> ${blank}
      </p>

      <p>
        <b>Puntuación:</b>
        ${score.toFixed(2)} / ${maxScore.toFixed(2)}
      </p>

      <button
        class="primary"
        onclick="review()">
        REVISAR TEST
      </button>

    </div>
  `;
}

function review(){
  $("result").innerHTML=
    qs.map((q,k)=>{

      const answer=ans[k];
      const isBlank=!Number.isInteger(answer);
      const isCorrect=answer===q.correctIndex;

      let userAnswer;

      if(isBlank){
        userAnswer=`
          <p class="muted">
            <b>Tu respuesta:</b> EN BLANCO
          </p>
        `;
      }else{
        userAnswer=`
          <p class="${isCorrect?"ok":"bad"}">
            <b>Tu respuesta:</b>
            ${"ABCD"[answer]}) ${formatExamContent(q.options[answer])}
          </p>
        `;
      }

      const correctAnswer=
        !isCorrect
        ?`
          <p class="ok">
            <b>Respuesta correcta:</b>
            ${"ABCD"[q.correctIndex]}) ${formatExamContent(q.options[q.correctIndex])}
          </p>
        `
        :"";

      return `
        <div class="c">

          <p>
            <b>${k+1}. ${formatExamContent(q.stem)}</b>
          </p>

          ${userAnswer}

          ${correctAnswer}

          <p>
            ${formatExamContent(q.explanation)}
          </p>

          <p class="muted">
            <b>Fuente:</b>
            ${formatExamContent(q.sourceEvidence)}
            ${q.manualPage!=null?` · pág. ${escapeHtml(q.manualPage)}`:""}
          </p>

        </div>
      `;
    }).join("")
    +
    `
      <button
        class="primary"
        onclick="location.reload()">
        NUEVO TEST
      </button>
    `;
}
function performanceColor(percentage){
  if(percentage===null || percentage===undefined){
    return "#777";
  }

  if(percentage>=80) return "#16803a";
  if(percentage>=60) return "#2563eb";
  if(percentage>=40) return "#ca8a04";
  if(percentage>=20) return "#ea580c";

  return "#dc2626";
}

function performanceBar(percentage){
  const hasData=
    percentage!==null &&
    percentage!==undefined;

  const value=hasData
    ? Math.min(100,Math.max(0,Number(percentage)))
    : 0;

  const color=performanceColor(percentage);

  return `
    <div
      style="
        width:100%;
        height:10px;
        background:#e5e7eb;
        border-radius:999px;
        overflow:hidden;
        margin-top:5px;
      "
    >
      <div
        style="
          width:${value}%;
          height:100%;
          background:${color};
          border-radius:999px;
        "
      ></div>
    </div>
  `;
}

function performanceText(performance){
  if(
    performance?.percentage===null ||
    performance?.percentage===undefined
  ){
    return `
      <strong style="color:#777">
        Sin respuestas
      </strong>
    `;
  }

  return `
    <strong
      style="color:${performanceColor(
        performance.percentage
      )}"
    >
      ${performance.percentage} %
    </strong>

    <span>
  · ${performance.correct} aciertos
  · ${performance.wrong} errores
  · ${performance.blank ?? 0} blancos
</span>
  `;
}
let topicCatalog=[];
let sectionStatistics=[];
let knowledgeStatistics=[];

const selectedBlocks=new Set();
const selectedTopicIds=new Set();

let statsFocusTopicId=null;
let currentTestLabel="Todo el temario";
function syncExamMode(){
  const simulation =
    $("examMode")?.value === "simulation";

  const testType=
    $("testType");

  const generateButton=
    $("generate");

  const kicker=
    document.querySelector(
      ".panel-kicker"
    );

  if(simulation){

    if(testType){
      testType.value="normal";
      testType.disabled=true;
    }

    if(generateButton){
      generateButton.textContent=
        "INICIAR SIMULACRO";
    }

    if(kicker){
      kicker.textContent=
        "SIMULACRO";
    }

  }else{

    if(testType){
      testType.disabled=false;
    }

    if(generateButton){
      generateButton.textContent=
        "GENERAR TEST";
    }

    if(kicker){
      kicker.textContent=
        "ENTRENAMIENTO";
    }
  }
}
const BLOCK_META={
  legislacion:{
    label:"Legislación",
    order:1
  },
  geografia:{
    label:"Geografía",
    order:2
  },
  especifico:{
    label:"Específico",
    order:3
  }
};

/*
 * MATH-86: formato universal de notación KaTeX para toda la aplicación.
 * No se realizan sustituciones algebraicas: el servidor determina la fórmula,
 * el cliente se limita a representarla. Ante error, muestra el texto original.
 */
/*
 * Conserva las fórmulas antiguas como hechos algebraicos intactos: cuando
 * el texto usa Sumatorio(...) y operaciones aritméticas convencionales,
 * genera tipografía matemática sin cambiar el orden de las operaciones.
 * Si la expresión no pertenece a esa gramática, NO se transforma.
 */
function legacyExamFormulaToLatex(value){
  const raw=String(value||'').trim();
  const match=raw.match(/^([A-Za-z][A-Za-z0-9_]*)\s*=\s*(.+)$/);
  if(!match || !/\bSumatorio\s*\(/i.test(match[2]))return null;
  const expression=match[2].replace(/\s+/g,'');
  const tokens=expression.match(/Sumatorio|[A-Za-z_][A-Za-z_0-9]*|\d+(?:\.\d+)?|[()+*\/^\-]/gi);
  if(!tokens || tokens.join('')!==expression)return null;
  let i=0;
  const peek=()=>tokens[i];
  const take=t=>peek()===t?(i++,true):false;
  const symbol=name=>{
    if(name==='Qs')return 'Q_s';
    if(/^[qGC]i$/.test(name))return `${name[0]}_i`;
    return name.replaceAll('_','\\_');
  };
  function primary(){
    if(take('(')){
      const p=expr();if(!take(')'))throw Error('unclosed group');
      return {kind:'group',part:p};
    }
    if(take('-'))return {kind:'neg',part:primary()};
    const token=peek();
    if(!token)throw Error('unexpected end');
    i++;
    if(/^Sumatorio$/i.test(token)){
      if(!take('('))throw Error('sum needs parenthesis');
      const p=expr();if(!take(')'))throw Error('sum unclosed');
      return {kind:'sum',part:p};
    }
    if(/^(?:[A-Za-z_][A-Za-z_0-9]*|\d+(?:\.\d+)?)$/.test(token)){
      return {kind:'atom',name:token};
    }
    throw Error('unsupported token');
  }
  function power(){let lhs=primary();if(take('^'))lhs={kind:'power',a:lhs,b:power()};return lhs;}
  function term(){
    let lhs=power();
    while(peek()==='*'||peek()==='/'){
      const op=tokens[i++];lhs={kind:op==='*'?'mul':'div',a:lhs,b:power()};
    }
    return lhs;
  }
  function expr(){
    let lhs=term();
    while(peek()==='+'||peek()==='-'){
      const op=tokens[i++];lhs={kind:op==='+'?'add':'sub',a:lhs,b:term()};
    }
    return lhs;
  }
  function tex(n){
    if(n.kind==='atom')return symbol(n.name);
    if(n.kind==='group')return `\\left(${tex(n.part)}\\right)`;
    if(n.kind==='sum')return `\\sum\\left(${tex(n.part)}\\right)`;
    if(n.kind==='neg')return `-${tex(n.part)}`;
    if(n.kind==='power')return `{${tex(n.a)}}^{${tex(n.b)}}`;
    if(n.kind==='mul')return `${tex(n.a)}\\cdot ${tex(n.b)}`;
    if(n.kind==='div')return `\\frac{${tex(n.a)}}{${tex(n.b)}}`;
    if(n.kind==='add')return `${tex(n.a)}+${tex(n.b)}`;
    if(n.kind==='sub')return `${tex(n.a)}-${tex(n.b)}`;
    throw Error('unsupported expression');
  }
  try{
    const tree=expr();
    if(i!==tokens.length)return null;
    return `${symbol(match[1])}=${tex(tree)}`;
  }catch{return null;}
}

function formatExamContent(value){
  let text=String(value ?? "");
  if(window.katex){
    const legacyMath=legacyExamFormulaToLatex(text);
    if(legacyMath)text=`\\[${legacyMath}\\]`;
  }
  const mathRx=/\\\[([\s\S]*?)\\\]|\\\(([\s\S]*?)\\\)/g;
  let last=0,html="",match;
  while((match=mathRx.exec(text))!==null){
    html+=escapeHtml(text.slice(last,match.index));
    const displayMode=match[1]!==undefined;
    const latex=displayMode?match[1]:match[2];
    if(window.katex && latex.length<=1200){
      try{
        html+=window.katex.renderToString(latex,{
          displayMode,
          throwOnError:true,
          trust:false,
          strict:"warn",
          output:"htmlAndMathml",
          maxExpand:300
        });
      }catch(error){
        console.warn('Fórmula no representable, manteniendo texto original:',error.message);
        html+=escapeHtml(match[0]);
      }
    }else{
      html+=escapeHtml(match[0]);
    }
    last=mathRx.lastIndex;
  }
  html+=escapeHtml(text.slice(last));
  return html.replace(/\n/g,'<br>');
}

function escapeHtml(value){
  return String(value ?? "")
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#039;");
}

function topicBlock(topic){
  if(
    topic?.block &&
    BLOCK_META[topic.block]
  ){
    return topic.block;
  }

  const order=
    Number(topic?.topicOrder);

  if(order>=21 && order<=27){
    return "geografia";
  }

  if(order>=1 && order<=19){
    return "legislacion";
  }

  return "especifico";
}

function blockLabel(block){
  return (
    BLOCK_META[block]?.label ||
    block ||
    "Otros"
  );
}

function sortTopics(a,b){
  const blockA=
    BLOCK_META[topicBlock(a)]?.order || 99;

  const blockB=
    BLOCK_META[topicBlock(b)]?.order || 99;

  if(blockA!==blockB){
    return blockA-blockB;
  }

  const orderA=
    Number.isFinite(Number(a.topicOrder))
      ? Number(a.topicOrder)
      : 9999;

  const orderB=
    Number.isFinite(Number(b.topicOrder))
      ? Number(b.topicOrder)
      : 9999;

  return (
    orderA-orderB ||
    String(a.topic)
      .localeCompare(
        String(b.topic),
        "es"
      )
  );
}

function allScopeSelected(){
  return $("scopeAll")?.checked === true;
}

function getSelectedTopics(){
  if(allScopeSelected()){
    return [...topicCatalog];
  }

  return topicCatalog.filter(topic=>
    selectedBlocks.has(
      topicBlock(topic)
    ) ||
    selectedTopicIds.has(
      Number(topic.topicId)
    )
  );
}

function setAllScope(checked){
  if(checked){
    selectedBlocks.clear();
    selectedTopicIds.clear();
  }

  statsFocusTopicId=null;

  renderTopicSelector();
  renderSelectionStatistics();
}

function toggleBlock(block,checked){
  $("scopeAll").checked=false;

  if(checked){
    selectedBlocks.add(block);

    for(const topic of topicCatalog){
      if(topicBlock(topic)===block){
        selectedTopicIds.delete(
          Number(topic.topicId)
        );
      }
    }
  }else{
    selectedBlocks.delete(block);
  }

  statsFocusTopicId=null;

  renderTopicSelector();
  renderSelectionStatistics();
}

function toggleTopic(topicId,checked){
  $("scopeAll").checked=false;

  const id=Number(topicId);

  const topic=
    topicCatalog.find(item=>
      Number(item.topicId)===id
    );

  if(!topic) return;

  const block=
    topicBlock(topic);

  if(selectedBlocks.has(block)){
    selectedBlocks.delete(block);
  }

  if(checked){
    selectedTopicIds.add(id);
  }else{
    selectedTopicIds.delete(id);
  }

  statsFocusTopicId=null;

  renderTopicSelector();
  renderSelectionStatistics();
}

function buildSelectionLabel(){
  if(allScopeSelected()){
    return "Todo el temario";
  }

  const topics=
    getSelectedTopics();

  if(
    selectedBlocks.size===1 &&
    selectedTopicIds.size===0
  ){
    return blockLabel(
      [...selectedBlocks][0]
    );
  }

  if(topics.length===1){
    return topics[0].topic;
  }

  if(topics.length>1){
    return `${topics.length} temas seleccionados`;
  }

  return "Sin contenido seleccionado";
}

function renderTopicSelector(){
  const container=
    $("topicSelector");

  if(!container) return;

  const groups=[
    "legislacion",
    "geografia",
    "especifico"
  ];

  container.innerHTML=
    groups.map(block=>{

      const topics=
        topicCatalog
          .filter(topic=>
            topicBlock(topic)===block
          )
          .sort(sortTopics);

      if(!topics.length){
        return "";
      }

      const wholeBlock=
        selectedBlocks.has(block);

      return `
        <details class="block-card">

          <summary>

            <input
              type="checkbox"
              ${wholeBlock ? "checked" : ""}
              onclick="event.stopPropagation()"
              onchange="
                toggleBlock(
                  '${block}',
                  this.checked
                )
              "
            >

            <div class="block-summary-text">
              <strong>
                ${blockLabel(block)}
              </strong>

              <small>
                ${topics.length}
                tema${topics.length===1 ? "" : "s"}
              </small>
            </div>

          </summary>

          <div class="topic-check-list">

            ${topics.map(topic=>{

              const id=
                Number(topic.topicId);

              const checked=
                wholeBlock ||
                selectedTopicIds.has(id);

              return `
                <label class="topic-check">

                  <input
                    type="checkbox"
                    ${checked ? "checked" : ""}
                    ${wholeBlock ? "disabled" : ""}
                    onchange="
                      toggleTopic(
                        ${id},
                        this.checked
                      )
                    "
                  >

                  <span>
                    ${escapeHtml(topic.topic)}
                  </span>

                </label>
              `;

            }).join("")}

          </div>

        </details>
      `;

    }).join("");

  const summary=
    $("selectionSummary");

  if(summary){
    const selected=
      getSelectedTopics();

    summary.textContent=
      allScopeSelected()
        ? `Todo el temario · ${topicCatalog.length} temas disponibles`
        : selected.length
          ? `${selected.length} tema${selected.length===1 ? "" : "s"} seleccionado${selected.length===1 ? "" : "s"}`
          : "Selecciona al menos un bloque o tema";
  }
}

function aggregateTopics(topics){
  const aggregate={
    totalItems:0,
    workedItems:0,
    pendingItems:0,
    correct:0,
    wrong:0,
    blank:0,
    answered:0,
    coveragePercentage:0,
    performancePercentage:null
  };

  for(const topic of topics){

    aggregate.totalItems+=
      Number(
        topic.coverage?.totalItems || 0
      );

    aggregate.workedItems+=
      Number(
        topic.coverage?.workedItems || 0
      );

    aggregate.correct+=
      Number(
        topic.performance?.correct || 0
      );

    aggregate.wrong+=
      Number(
        topic.performance?.wrong || 0
      );

    aggregate.blank+=
      Number(
        topic.performance?.blank || 0
      );
  }

  aggregate.pendingItems=
    Math.max(
      0,
      aggregate.totalItems-
      aggregate.workedItems
    );

  aggregate.answered=
    aggregate.correct+
    aggregate.wrong+
    aggregate.blank;

  aggregate.coveragePercentage=
    aggregate.totalItems>0
      ? Number(
          (
            aggregate.workedItems /
            aggregate.totalItems *
            100
          ).toFixed(1)
        )
      : 0;

  aggregate.performancePercentage=
    aggregate.answered>0
      ? Number(
          (
            aggregate.correct /
            aggregate.answered *
            100
          ).toFixed(1)
        )
      : null;

  return aggregate;
}

function renderSelectionStatistics(){
  const topics=
    getSelectedTopics();

  const title=
    $("statsScopeTitle");

  if(title){
    title.textContent=
      buildSelectionLabel();
  }

  if(!topics.length){
    $("coverageValue").textContent="-- %";
    $("coverageDetail").textContent=
      "Sin contenido seleccionado";
    $("performanceValue").textContent="-- %";
    $("performanceDetail").textContent=
      "Sin contenido seleccionado";
    $("pendingValue").textContent="--";
    $("answerCount").textContent="--";
    $("answerBreakdown").textContent=
      "-- aciertos · -- errores · -- blancos";
    $("coverageBar").style.width="0%";
    $("performanceBar").style.width="0%";
    $("topicStatsGrid").innerHTML="";
    $("sectionStats").innerHTML="";
    return;
  }

  const aggregate=
    aggregateTopics(topics);

  $("coverageValue").textContent=
    `${aggregate.coveragePercentage} %`;

  $("coverageDetail").textContent=
    `${aggregate.workedItems} de ${aggregate.totalItems} elementos`;

  $("coverageBar").style.width=
    `${aggregate.coveragePercentage}%`;

  if(
    aggregate.performancePercentage===null
  ){
    $("performanceValue").textContent=
      "-- %";

    $("performanceValue").style.color=
      "#64748b";

    $("performanceDetail").textContent=
      "Sin respuestas registradas";

    $("performanceBar").style.width=
      "0%";
  }else{
    const color=
      performanceColor(
        aggregate.performancePercentage
      );

    $("performanceValue").textContent=
      `${aggregate.performancePercentage} %`;

    $("performanceValue").style.color=
      color;

    $("performanceDetail").textContent=
      `${aggregate.correct} aciertos · ${aggregate.wrong} errores · ${aggregate.blank} blancos`;

    $("performanceBar").style.width=
      `${aggregate.performancePercentage}%`;

    $("performanceBar").style.background=
      color;
  }

  $("pendingValue").textContent=
    aggregate.pendingItems;

  $("answerCount").textContent=
    aggregate.answered;

  $("answerBreakdown").textContent=
    `${aggregate.correct} aciertos · ${aggregate.wrong} errores · ${aggregate.blank} blancos`;

  renderTopicStatistics(topics);

  if(topics.length===1){
    openTopicStats(
      Number(topics[0].topicId),
      true
    );
  }else if(
    statsFocusTopicId &&
    !topics.some(topic=>
      Number(topic.topicId)===
      Number(statsFocusTopicId)
    )
  ){
    statsFocusTopicId=null;
    $("sectionStats").innerHTML="";
  }
}

function renderTopicStatistics(topics){
  const container=
    $("topicStatsGrid");

  if(!container) return;

  const blocks=[
    "legislacion",
    "geografia",
    "especifico"
  ];

  container.innerHTML=
    blocks.map(block=>{

      const blockTopics=
        topics
          .filter(topic=>
            topicBlock(topic)===block
          )
          .sort(sortTopics);

      if(!blockTopics.length){
        return "";
      }

      const aggregate=
        aggregateTopics(blockTopics);

      return `
        <details class="stats-block">

          <summary>
            ${blockLabel(block)}
            ·
            ${aggregate.coveragePercentage} % cobertura
          </summary>

          <div class="topic-card-grid">

            ${blockTopics.map(topic=>{

              const performance=
                topic.performance?.percentage;

              return `
                <button
                  class="topic-stat-card"
                  onclick="
                    openTopicStats(
                      ${Number(topic.topicId)}
                    )
                  "
                >

                  <strong>
                    ${escapeHtml(topic.topic)}
                  </strong>

                  <div class="topic-stat-meta">
                    <span>
                      Cobertura
                      ${topic.coverage.percentage} %
                    </span>

                    <span>
                      ${
                        performance===null
                          ? "Sin respuestas"
                          : `${performance} %`
                      }
                    </span>
                  </div>

                </button>
              `;

            }).join("")}

          </div>

        </details>
      `;

    }).join("");
}

function openTopicStats(
  topicId,
  automatic=false
){
  const topic=
    topicCatalog.find(item=>
      Number(item.topicId)===
      Number(topicId)
    );

  if(!topic) return;

  statsFocusTopicId=
    Number(topicId);

  $("topicDetailTitle").textContent=
    `Desglose · ${topic.topic}`;

  renderTopicDetail(
    Number(topicId)
  );

  const panel=
    $("topicDetailPanel");

  if(panel){
    panel.open=true;

    if(!automatic){
      panel.scrollIntoView({
        behavior:"smooth",
        block:"start"
      });
    }
  }
}

function renderTopicDetail(topicId){
  const sections=
    sectionStatistics.filter(item=>
      Number(item.topicId)===
      Number(topicId)
    );

  const knowledge=
    knowledgeStatistics.filter(item=>
      Number(item.topicId)===
      Number(topicId)
    );

  const container=
    $("sectionStats");

  if(!container) return;

  if(!sections.length){
    container.innerHTML=`
      <p class="muted">
        Este tema todavía no tiene desglose disponible.
      </p>
    `;
    return;
  }

  container.innerHTML=
    sections.map(section=>{

      const sectionKnowledge=
        knowledge.filter(item=>
          (
            item.section ||
            "Sin sección"
          )===section.section
        );

      const performance=
        section.performance;

      return `
        <details
          style="
            padding:12px 0;
            border-bottom:1px solid #e2e8f0;
          "
        >

          <summary
            style="
              cursor:pointer;
              font-weight:700;
            "
          >

            ${escapeHtml(section.section)}

            ·

            ${
              performance.percentage===null
                ? "sin respuestas"
                : `${performance.percentage} %`
            }

            <div
              style="
                margin-top:5px;
                color:#64748b;
                font-size:11px;
                font-weight:400;
              "
            >
              Cobertura:
              ${section.coverage.percentage} %
              ·
              ${section.coverage.workedItems}/${section.coverage.totalItems}
              ·
              ${section.coverage.pendingItems} pendientes
            </div>

          </summary>

          <div
            style="
              padding:
                8px 4px 0 14px;
            "
          >

            ${sectionKnowledge.map(item=>`

              <div
                style="
                  padding:9px 0;
                  border-top:1px solid #eef2f7;
                "
              >

                <div>
                  ${escapeHtml(item.concept)}
                </div>

                <div
                  style="
                    margin-top:4px;
                    font-size:12px;
                  "
                >
                  ${performanceText(
                    item.performance
                  )}
                </div>

                <div
                  style="
                    margin-top:4px;
                    color:#64748b;
                    font-size:11px;
                  "
                >
                  Etapa SRS:
                  ${
                    item.srs?.reviewStage ??
                    "--"
                  }

                  ·

                  ${
                    item.srs?.nextReviewAt
                      ? `Próximo repaso: ${
                          new Date(
                            item.srs.nextReviewAt
                          ).toLocaleDateString(
                            "es-ES"
                          )
                        }`
                      : "Sin repaso programado"
                  }
                </div>

              </div>

            `).join("")}

          </div>

        </details>
      `;

    }).join("");
}

async function loadStatistics(){
  try{

    const [
      statistics,
      sections,
      knowledge
    ]=await Promise.all([
      api("/api/statistics"),
      api("/api/statistics/sections"),
      api("/api/statistics/knowledge")
    ]);

    topicCatalog=
      (statistics.topics || [])
        .sort(sortTopics);

    sectionStatistics=
      sections.sections || [];

    knowledgeStatistics=
      knowledge.knowledge || [];

    renderTopicSelector();
    renderSelectionStatistics();

  }catch(e){

    console.error(
      "ERROR CARGANDO ESTADÍSTICAS:",
      e
    );

  }
}

async function refreshStudyData(){
  await loadStatistics();
}
          

async function ingestOfficialExams(){
  const ok = confirm(
    "Se indexarán los exámenes oficiales 2024 y 2026 en el almacén independiente de estilo. ¿Continuar?"
  );

  if(!ok) return;

  try{
    const r = await fetch("/api/ingest-official-exams",{
      method:"POST"
    });

    const data = await r.json();

    if(!r.ok){
      throw new Error(data.error || "Error indexando los exámenes oficiales");
    }

    alert(
      "Exámenes oficiales 2024 y 2026 indexados correctamente como referencia de estilo."
    );

  }catch(e){
    alert("ERROR: " + e.message);
  }
}
status();
loadStatistics();
syncExamMode();

