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

function show(){
  const q=qs[i];
  const answered=answeredCount();
  const pending=qs.length-answered;

  $("quiz").classList.remove("hidden");

  $("quiz").innerHTML=`
    <div class="exam-toolbar">
      <div>
        Contestadas <b>${answered}</b>
        · Pendientes <b>${pending}</b>
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

      <div class="question-number">
        Pregunta ${i+1} de ${qs.length}
      </div>

      <div class="question-stem">
        ${i+1}. ${q.stem}
      </div>

      <div>
        ${q.options.map((option,j)=>`
          <button
            class="opt ${ans[i]===j?"sel":""}"
            onclick="pick(${j})">
            <b>${"ABCD"[j]})</b> ${option}
          </button>
        `).join("")}
      </div>

      <div style="margin-top:18px">
        <button
          class="secondary"
          onclick="clearAnswer()">
          DEJAR EN BLANCO
        </button>
      </div>

      <div class="exam-nav">

        <button
          class="secondary"
          onclick="previousQuestion()"
          ${i===0?"disabled":""}>
          ANTERIOR
        </button>

        ${
          i<qs.length-1
          ?`
            <button
              class="primary"
              onclick="nextQuestion()">
              SIGUIENTE
            </button>
          `
          :`
            <button
              class="primary"
              onclick="requestFinish()">
              FINALIZAR
            </button>
          `
        }

      </div>

    </div>
  `;

  updateTimer();
}

function pick(j){
  ans[i]=j;
  show();
}

function clearAnswer(){
  ans[i]=null;
  show();
}

function previousQuestion(){
  if(i>0){
    i--;
    show();
  }
}

function nextQuestion(){
  if(i<qs.length-1){
    i++;
    show();
  }
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
            ${q.sourcePage?` · pág. ${q.sourcePage}`:""}
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
async function testLocal(){
  qs=[
    {
      stem:"Pregunta local de prueba número 1.",
      options:[
        "Primera opción",
        "Segunda opción",
        "Tercera opción",
        "Cuarta opción"
      ],
      correctIndex:1,
      explanation:"Explicación local de prueba para comprobar la corrección.",
      sourceEvidence:"Evidencia local de prueba.",
      sourcePage:1
    },
    {
      stem:"Señale la opción INCORRECTA en esta segunda pregunta local de prueba.",
      options:[
        "Opción A de prueba",
        "Opción B de prueba",
        "Opción C de prueba",
        "Opción D de prueba"
      ],
      correctIndex:2,
      explanation:"Explicación local de la segunda pregunta.",
      sourceEvidence:"Evidencia local de prueba.",
      sourcePage:2
    },
    {
      stem:"Esta tercera pregunta sirve para comprobar que una respuesta marcada puede volver a dejarse en blanco.",
      options:[
        "Respuesta A",
        "Respuesta B",
        "Respuesta C",
        "Respuesta D"
      ],
      correctIndex:0,
      explanation:"Explicación local de la tercera pregunta.",
      sourceEvidence:"Evidencia local de prueba.",
      sourcePage:3
    },
    {
      stem:"Pregunta local número 4 para comprobar la navegación hacia atrás y hacia delante.",
      options:[
        "Respuesta A",
        "Respuesta B",
        "Respuesta C",
        "Respuesta D"
      ],
      correctIndex:3,
      explanation:"Explicación local de la cuarta pregunta.",
      sourceEvidence:"Evidencia local de prueba.",
      sourcePage:4
    },
    {
      stem:"Última pregunta local para comprobar la finalización del test con preguntas sin contestar.",
      options:[
        "Respuesta A",
        "Respuesta B",
        "Respuesta C",
        "Respuesta D"
      ],
      correctIndex:1,
      explanation:"Explicación local de la quinta pregunta.",
      sourceEvidence:"Evidencia local de prueba.",
      sourcePage:5
    }
  ];

  ans=Array(qs.length).fill(null);
  pos=0;
  render();
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
