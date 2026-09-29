let qs=[],ans=[],i=0,sessionId=null;
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
        "
      >
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
        <strong>BLOQUE TEMÁTICO 3</strong><br>
        Conocimientos específicos<br><br>

        <strong>Tema:</strong> Apeo y poda de arbolado<br>
        <strong>${qs.length} preguntas</strong>
        (de la 1 a la ${qs.length})
      </div>

      ${qs.map((q,k)=>`
        <div class="exam-question">

          <div class="question-stem">
            ${k+1}. ${q.stem}
          </div>
${renderGraphic(q)}
          <div>
            ${q.options.map((option,j)=>`
              <button
                class="opt ${ans[k]===j?"sel":""}"
                onclick="pick(${k},${j})">
                <b>${"ABCD"[j]})</b> ${option}
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

    await Promise.all(
      answeredQuestions.map(item=>
        api("/api/answer",{
          method:"POST",
          body:JSON.stringify({
            sessionId:Number(sessionId),
            questionId:item.questionId,
            selectedIndex:item.selectedIndex
          })
        })
      )
    );
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
            ${"ABCD"[answer]}) ${q.options[answer]}
          </p>
        `;
      }

      const correctAnswer=
        !isCorrect
        ?`
          <p class="ok">
            <b>Respuesta correcta:</b>
            ${"ABCD"[q.correctIndex]}) ${q.options[q.correctIndex]}
          </p>
        `
        :"";

      return `
        <div class="c">

          <p>
            <b>${k+1}. ${q.stem}</b>
          </p>

          ${userAnswer}

          ${correctAnswer}

          <p>
            ${q.explanation}
          </p>

          <p class="muted">
            <b>Fuente:</b>
            ${q.sourceEvidence}
            ${q.manualPage!=null?` · pág. ${q.manualPage}`:""}
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
    </span>
  `;
}
async function loadStatistics(){
  try{
    const data=await api("/api/statistics");

    const topics=data.topics || [];

    const topic=
      topics.find(
        item=>item.topic==="Apeo y poda de arbolado"
      ) || topics[0];

    if(!topic) return;

    const coverage=topic.coverage;
    const performance=topic.performance;

    $("coverageValue").textContent=
      `${coverage.percentage} %`;

    $("coverageDetail").textContent=
      `${coverage.workedItems} de ${coverage.totalItems} elementos trabajados`;

    $("coverageBar").style.width=
      `${Math.min(
        100,
        Math.max(0,coverage.percentage)
      )}%`;

    if(performance.percentage===null){

      $("performanceValue").textContent="-- %";

      $("performanceValue").style.color="#777";

      $("performanceDetail").textContent=
        "Sin respuestas registradas";

      $("performanceBar").style.width="0%";
      $("performanceBar").style.backgroundColor="#777";

    }else{

      const color=
        performanceColor(performance.percentage);

      $("performanceValue").textContent=
        `${performance.percentage} %`;

      $("performanceValue").style.color=color;

      $("performanceDetail").textContent=
        `${performance.correct} aciertos · ${performance.wrong} errores`;

      $("performanceBar").style.width=
        `${Math.min(
          100,
          Math.max(0,performance.percentage)
        )}%`;

      $("performanceBar").style.backgroundColor=color;
    }

    const topicBars=$("topicPerformanceBars");

    if(topicBars){

      topicBars.innerHTML=
        topics.map(item=>{

          const p=item.performance;

          return `
            <div style="margin:14px 0">

              <div
                style="
                  display:flex;
                  justify-content:space-between;
                  gap:12px;
                  align-items:center;
                "
              >
                <span>
                  ${item.topic}
                </span>

                ${
                  p.percentage===null
                    ? `
                      <strong style="color:#777">
                        --
                      </strong>
                    `
                    : `
                      <strong
                        style="color:${performanceColor(
                          p.percentage
                        )}"
                      >
                        ${p.percentage} %
                      </strong>
                    `
                }
              </div>

              ${performanceBar(p.percentage)}

            </div>
          `;
        }).join("");
    }

  }catch(e){
    console.error(
      "ERROR CARGANDO ESTADÍSTICAS:",
      e
    );
  }
}

function performanceBadge(performance){
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
      style="
        color:${performanceColor(performance.percentage)};
        font-weight:800;
      "
    >
      ${performance.percentage} %
    </strong>
    <span>
      · ${performance.correct} aciertos
      · ${performance.wrong} errores
    </span>
  `;
}

async function loadSectionStatistics(){
  try{

    const [
      sectionData,
      knowledgeData
    ]=await Promise.all([
      api("/api/statistics/sections"),
      api("/api/statistics/knowledge")
    ]);

    const topicName=
      "Apeo y poda de arbolado";

    const sections=
      (sectionData.sections || [])
        .filter(
          item=>item.topic===topicName
        );

    const knowledge=
      (knowledgeData.knowledge || [])
        .filter(
          item=>item.topic===topicName
        );

    const container=$("sectionStats");

    if(!container) return;

    if(!sections.length){
      container.innerHTML="";
      return;
    }

    container.innerHTML=`

      <div class="section-stats-title">
        Rendimiento por secciones
      </div>

      ${sections.map(item=>{

        const coverage=item.coverage;
        const performance=item.performance;

        const sectionKnowledge=
          knowledge.filter(
            k=>
              (k.section || "Sin sección")===
              item.section
          );

        return `

          <details
            style="
              padding:12px 0;
              border-bottom:1px solid #ddd;
            "
          >

            <summary
              style="
                cursor:pointer;
              "
            >

              <div
                style="
                  display:flex;
                  justify-content:space-between;
                  gap:12px;
                  margin-bottom:4px;
                "
              >

                <strong>
                  ${item.section}
                </strong>

                ${
                  performance.percentage===null
                    ? `
                      <strong style="color:#777">
                        --
                      </strong>
                    `
                    : `
                      <strong
                        style="color:${performanceColor(
                          performance.percentage
                        )}"
                      >
                        ${performance.percentage} %
                      </strong>
                    `
                }

              </div>

              ${performanceBar(
                performance.percentage
              )}

              <div
                style="
                  margin-top:5px;
                  font-size:.85em;
                  color:#666;
                "
              >
                Cobertura:
                ${coverage.percentage} %
                ·
                ${coverage.workedItems}/${coverage.totalItems}
              </div>

            </summary>

            <div
              style="
                margin-top:12px;
                padding-left:12px;
              "
            >

              ${
                sectionKnowledge.length
                  ? sectionKnowledge.map(k=>`

                    <div
                      style="
                        padding:9px 0;
                        border-top:1px solid #eee;
                      "
                    >

                      <div>
                        ${k.concept}
                      </div>

                      <div
                        style="
                          margin-top:3px;
                          font-size:.9em;
                        "
                      >
                        ${performanceText(
                          k.performance
                        )}
                      </div>
<div
  style="
    margin-top:4px;
    font-size:.8em;
    color:#777;
    line-height:1.5;
  "
>
  <div>
    Respuestas:
    ${k.performance?.answered ?? 0}
    ·
    Etapa SRS:
    ${k.srs?.reviewStage ?? "--"}
  </div>

  <div>
    ${
      k.srs?.nextReviewAt
        ? `
          Próximo repaso:
          ${new Date(
            k.srs.nextReviewAt
          ).toLocaleDateString(
            "es-ES"
          )}
        `
        : "Sin repaso programado"
    }
  </div>

  <div>
    ${
      k.srs?.lastAskedAt
        ? `
          Última aparición:
          ${new Date(
            k.srs.lastAskedAt
          ).toLocaleDateString(
            "es-ES"
          )}
        `
        : "Nunca preguntado"
    }
  </div>
</div>
                            ? `
                              Próximo repaso:
                              ${new Date(
                                k.srs.nextReviewAt
                              ).toLocaleDateString(
                                "es-ES"
                              )}
                            `
                            : "Sin repaso programado"
                        }
                      </div>

                    </div>

                  `).join("")

                  : `
                    <div
                      style="
                        padding:9px 0;
                        color:#777;
                      "
                    >
                      Sin conocimientos respondidos
                    </div>
                  `
              }

            </div>

          </details>
        `;

      }).join("")}
    `;

  }catch(e){

    console.error(
      "ERROR CARGANDO DESGLOSE COMPLETO:",
      e
    );

  }
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
loadSectionStatistics();
