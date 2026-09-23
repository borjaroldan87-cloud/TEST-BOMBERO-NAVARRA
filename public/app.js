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

  if(!g || !Array.isArray(g.elements) || g.elements.length===0){
    return "";
  }

  const esc=(value)=>String(value??"")
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;");

  const clamp=(value,min=0,max=100)=>{
    const n=Number(value);
    if(!Number.isFinite(n)) return min;
    return Math.min(max,Math.max(min,n));
  };

  const sx=value=>clamp(value)*6;
  const sy=value=>clamp(value)*3.2;

  const pointString=points=>{
    if(!Array.isArray(points)) return "";

    return points
      .map(p=>`${sx(p?.x)},${sy(p?.y)}`)
      .join(" ");
  };

  const drawElement=(el,index)=>{
    const shape=String(el?.shape??"");
    const label=String(el?.label??"");

    const x=sx(el?.x);
    const y=sy(el?.y);

    const x2=el?.x2==null ? null : sx(el.x2);
    const y2=el?.y2==null ? null : sy(el.y2);

    const width=el?.width==null
      ? null
      : clamp(el.width)*6;

    const height=el?.height==null
      ? null
      : clamp(el.height)*3.2;

    const radius=el?.radius==null
      ? null
      : clamp(el.radius)*3.2;

    const points=pointString(el?.points);

    const text=label
      ? `
        <text
          x="${x}"
          y="${y-7}"
          text-anchor="middle"
          font-size="13"
          font-weight="600"
        >${esc(label)}</text>
      `
      : "";

    switch(shape){

      case "line":
        if(x2==null || y2==null) return "";
        return `
          <g>
            <line
              x1="${x}" y1="${y}"
              x2="${x2}" y2="${y2}"
              stroke="currentColor"
              stroke-width="2.5"
              stroke-linecap="round"
            />
            ${text}
          </g>
        `;

      case "rect":
        if(width==null || height==null) return "";
        return `
          <g>
            <rect
              x="${x}"
              y="${y}"
              width="${width}"
              height="${height}"
              fill="none"
              stroke="currentColor"
              stroke-width="2.5"
            />
            ${text}
          </g>
        `;

      case "circle":
        if(radius==null) return "";
        return `
          <g>
            <circle
              cx="${x}"
              cy="${y}"
              r="${radius}"
              fill="none"
              stroke="currentColor"
              stroke-width="2.5"
            />
            ${text}
          </g>
        `;

      case "ellipse":
        if(width==null || height==null) return "";
        return `
          <g>
            <ellipse
              cx="${x}"
              cy="${y}"
              rx="${width/2}"
              ry="${height/2}"
              fill="none"
              stroke="currentColor"
              stroke-width="2.5"
            />
            ${text}
          </g>
        `;

      case "polygon":
        if(!points) return "";
        return `
          <g>
            <polygon
              points="${points}"
              fill="none"
              stroke="currentColor"
              stroke-width="2.5"
              stroke-linejoin="round"
            />
            ${text}
          </g>
        `;

      case "polyline":
        if(!points) return "";
        return `
          <g>
            <polyline
              points="${points}"
              fill="none"
              stroke="currentColor"
              stroke-width="2.5"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
            ${text}
          </g>
        `;

      case "arrow":
        if(x2==null || y2==null) return "";
        return `
          <g>
            <line
              x1="${x}" y1="${y}"
              x2="${x2}" y2="${y2}"
              stroke="currentColor"
              stroke-width="2.5"
              marker-end="url(#arrowhead-${index})"
            />
            <defs>
              <marker
                id="arrowhead-${index}"
                markerWidth="10"
                markerHeight="7"
                refX="9"
                refY="3.5"
                orient="auto"
              >
                <polygon
                  points="0 0, 10 3.5, 0 7"
                  fill="currentColor"
                />
              </marker>
            </defs>
            ${text}
          </g>
        `;

      case "text":
        return `
          <text
            x="${x}"
            y="${y}"
            text-anchor="middle"
            font-size="14"
            font-weight="700"
          >${esc(label)}</text>
        `;

      default:
        return "";
    }
  };

  const drawing=g.elements
    .map((el,index)=>drawElement(el,index))
    .join("");

  return `
    <div class="question-graphic">
      ${g.title
        ? `<div><b>${esc(g.title)}</b></div>`
        : ""}

      <svg
        viewBox="0 0 600 320"
        role="img"
        aria-label="${esc(g.description||g.title||"Dibujo técnico de la pregunta")}"
        style="width:100%;max-width:700px;height:auto;display:block;margin:12px auto;"
      >
        ${drawing}
      </svg>

      ${g.description
        ? `<div class="muted">${esc(g.description)}</div>`
        : ""}
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

function finish(auto=false){
  clearInterval(timerInterval);

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
status();
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
