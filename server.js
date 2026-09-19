import express from "express";
import multer from "multer";
import { GoogleGenAI } from "@google/genai";
import fs from "fs";
import path from "path";
import pg from "pg";
const { Pool } = pg;

const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});
const app = express();
const upload = multer({ dest: "uploads/" });
app.use(express.json({limit:"2mb"}));
app.use(express.static("public"));

function aiClient(){
  if(!process.env.GEMINI_API_KEY) throw new Error("Falta GEMINI_API_KEY");
  return new GoogleGenAI({apiKey: process.env.GEMINI_API_KEY});
}

let STORE = null;
const sleep = ms => new Promise(r=>setTimeout(r,ms));
async function initDatabase(){
  await db.query(`
    CREATE TABLE IF NOT EXISTS app_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);  await db.query(`
    CREATE TABLE IF NOT EXISTS topics (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      source_file TEXT,
      total_items INTEGER NOT NULL DEFAULT 0,
      worked_items INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS coverage_items (
      id SERIAL PRIMARY KEY,
      topic_id INTEGER NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
      section TEXT,
      concept TEXT NOT NULL,
      item_type TEXT NOT NULL,
      evaluation_type TEXT NOT NULL,
      source_page INTEGER,
      source_evidence TEXT,
      worked BOOLEAN NOT NULL DEFAULT FALSE,
      times_asked INTEGER NOT NULL DEFAULT 0,
      times_correct INTEGER NOT NULL DEFAULT 0,
      times_wrong INTEGER NOT NULL DEFAULT 0,
      last_asked_at TIMESTAMPTZ,
      UNIQUE(topic_id, concept, item_type, evaluation_type)
    )
  `);
}
async function loadStore(){
  const result = await db.query(
    "SELECT value FROM app_state WHERE key = $1",
    ["file_search_store"]
  );

  if(result.rows.length){
    STORE = result.rows[0].value;
  }

  return STORE;
}

async function saveStore(storeName){
  await db.query(
    `INSERT INTO app_state (key, value)
     VALUES ($1, $2)
     ON CONFLICT (key)
     DO UPDATE SET value = EXCLUDED.value`,
    ["file_search_store", storeName]
  );
}
async function getOrCreateTopic(name, sourceFile=null){
  const existing = await db.query(
    "SELECT * FROM topics WHERE name = $1 LIMIT 1",
    [name]
  );

  if(existing.rows.length){
    return existing.rows[0];
  }

  const created = await db.query(
    `INSERT INTO topics (name, source_file)
     VALUES ($1, $2)
     RETURNING *`,
    [name, sourceFile]
  );

  return created.rows[0];
}

async function saveCoverageItems(topicId, items){
  for(const item of items){
    await db.query(
      `INSERT INTO coverage_items
       (topic_id, section, concept, item_type, evaluation_type,
        source_page, source_evidence)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (topic_id, concept, item_type, evaluation_type)
       DO NOTHING`,
      [
        topicId,
        item.section || null,
        item.concept,
        item.itemType,
        item.evaluationType,
        item.sourcePage ?? null,
        item.sourceEvidence || null
      ]
    );
  }

  await db.query(
    `UPDATE topics
     SET total_items = (
       SELECT COUNT(*)
       FROM coverage_items
       WHERE topic_id = $1
     )
     WHERE id = $1`,
    [topicId]
  );
}
async function waitOp(ai, op){
  while(!op.done){ await sleep(2500); op = await ai.operations.get({operation: op}); }
  return op;
}

async function ensureStore(){
  if(STORE) return STORE;

  await loadStore();
  if(STORE) return STORE;

  const ai=aiClient();
  const store=await ai.fileSearchStores.create({config:{
    displayName:"Bombero Navarra - Apeo y poda",
    embeddingModel:"models/gemini-embedding-2"
  }});

  STORE=store.name;
  await saveStore(STORE);

  return STORE;
}

async function ingest(filePath, displayName){
  const ai=aiClient(); const store=await ensureStore();
  let op=await ai.fileSearchStores.uploadToFileSearchStore({
    file:filePath, fileSearchStoreName:store,
    config:{displayName}
  });
  await waitOp(ai,op);
  return store;
}

app.get("/api/status",(req,res)=>res.json({ok:true,keyConfigured:!!process.env.GEMINI_API_KEY,store:STORE}));

app.post("/api/ingest-benchmark", async(req,res)=>{
  try{
    const p=path.resolve("data/apeo-poda.pdf");
    if(!fs.existsSync(p)) throw new Error("No está el PDF de benchmark.");
    const store=await ingest(p,"Apeo y poda de arbolado");
    res.json({ok:true,store});
  }catch(e){res.status(500).json({ok:false,error:e.message})}
});

app.post("/api/upload", upload.single("pdf"), async(req,res)=>{
  try{
    if(!req.file) throw new Error("Falta PDF");
    const store=await ingest(req.file.path,req.file.originalname);
    fs.unlink(req.file.path,()=>{});
    res.json({ok:true,store});
  }catch(e){res.status(500).json({ok:false,error:e.message})}
});

const questionSchema={
 type:"object",
 properties:{
  questions:{type:"array",items:{type:"object",properties:{
   stem:{type:"string"},
   options:{type:"array",items:{type:"string"},minItems:4,maxItems:4},
   correctIndex:{type:"integer",minimum:0,maximum:3},
   explanation:{type:"string"},
   sourceEvidence:{type:"string"},
   sourcePage:{type:["integer","null"]},
   difficulty:{type:"string",enum:["media","alta"]}
  },required:["stem","options","correctIndex","explanation","sourceEvidence","sourcePage","difficulty"]}}
 },required:["questions"]
};

function generationPrompt(count,difficulty,mode){
  return `Eres un generador de preguntas para una oposición de Bombero de Navarra.

FUENTE DE CONTENIDO:
Los documentos recuperados mediante File Search son la ÚNICA fuente de verdad.
No uses conocimiento externo ni completes información que no esté respaldada por la fuente.

OBJETIVO:
Genera EXACTAMENTE ${count} preguntas tipo test, en español, dificultad ${difficulty}, modo ${mode}.
Las preguntas deben parecer redactadas para una oposición oficial de Bombero de Navarra.

COBERTURA DEL TEMARIO:
- Antes de redactar las preguntas, identifica mentalmente los distintos conceptos, apartados, datos y procedimientos disponibles en los fragmentos recuperados.
- Distribuye las preguntas entre el mayor número posible de conceptos y apartados diferentes.
- Cada pregunta debe evaluar preferentemente un concepto principal distinto.
- No concentres el test en una sola sección del documento si existe información suficiente de otras secciones.
- Evita preguntas repetidas, casi equivalentes o que evalúen esencialmente el mismo conocimiento.
- No descartes información por parecer demasiado literal o numérica.
- Son examinables cifras, porcentajes, medidas, unidades, valores de tablas, fórmulas, enumeraciones, clasificaciones, excepciones, condiciones, procedimientos, secuencias, relaciones y cualquier otro dato contenido en la fuente.
ANÁLISIS Y EXPLOTACIÓN DEL CONTENIDO:
- No consideres que un contenido queda agotado por haber formulado una sola pregunta sobre él. Analiza qué aspectos independientes y razonablemente examinables contiene.
- Trata como unidades potencialmente examinables los conceptos, subconceptos, definiciones, características, condiciones, relaciones, clasificaciones, enumeraciones, secuencias, procedimientos, excepciones, cifras, porcentajes, medidas, unidades, límites, tablas, fórmulas y ejemplos técnicos respaldados por la fuente.
- Una misma materia puede admitir varias preguntas si evalúan conocimientos o capacidades realmente diferentes. Evita, en cambio, preguntas equivalentes que únicamente cambien palabras, orden de las opciones o valores arbitrarios.
- En TABLAS, analiza no solo valores aislados, sino también relaciones entre filas y columnas, comparaciones, categorías, límites, intervalos, excepciones y cualquier interpretación que pueda obtenerse inequívocamente de la propia tabla.
- No consideres una tabla trabajada por haber preguntado únicamente uno de sus datos.
- En FÓRMULAS, cuando la fuente lo permita, pueden evaluarse de manera independiente: identificación de la fórmula adecuada, significado de variables, unidades, relaciones entre magnitudes, despeje de incógnitas, aplicación numérica, interpretación del resultado y consecuencias objetivas de modificar una variable.
- Los ejercicios numéricos deben poder resolverse exclusivamente con la información de la fuente y operaciones matemáticas apropiadas. No introduzcas constantes, reglas técnicas ni supuestos externos que no estén respaldados por el documento.
- En PROCEDIMIENTOS y SECUENCIAS, evalúa también orden, condiciones de ejecución, acciones previas o posteriores, excepciones y consecuencias expresamente sustentadas por la fuente.
- En ENUMERACIONES y CLASIFICACIONES, evita limitarte siempre a preguntar cuántos elementos existen: pregunta también pertenencia, exclusión, correspondencia, diferencias y características cuando la fuente lo permita.
- Para crear distractores, utiliza preferentemente conceptos próximos, cifras cercanas, elementos de otras categorías de la misma fuente, alteraciones de secuencia o modificaciones técnicamente plausibles, pero comprueba que cada distractor sea inequívocamente falso para la pregunta concreta.
- Prioriza ampliar progresivamente la cobertura del contenido antes de volver a evaluar de forma equivalente conocimientos ya utilizados.
- La diversidad no debe conseguirse inventando información. Si un contenido solo admite una forma inequívoca y razonable de ser preguntado, no fuerces variantes artificiales.
ESTILO DE OPOSICIÓN:
PATRÓN DE REDACCIÓN DEL TRIBUNAL:
- Imita la filosofía de redacción observada en los exámenes oficiales Modelo B de Bombero de Navarra 2024 y 2026, combinando deliberadamente ambos estilos.
- ESTILO 2024: preguntas precisas, literales y muy vinculadas al contenido concreto del manual; atención extrema a definiciones, clasificaciones, cifras, límites, excepciones, procedimientos y pequeños matices capaces de diferenciar una respuesta correcta de otra aparentemente válida.
- ESTILO 2026: preguntas que exijan lectura atenta, comprensión, comparación, relación entre conceptos, razonamiento y aplicación práctica del contenido; utiliza enunciados y alternativas desarrolladas cuando resulte natural.
- Incluye preguntas formuladas como "Señale la opción CORRECTA", "Señale la opción INCORRECTA" o mediante negaciones como "NO", cuando sean adecuadas, comprobando con especial rigor la polaridad para evitar errores.
- Cuando el contenido lo permita, plantea situaciones operativas o problemas contextualizados que obliguen a aplicar la información de la fuente y no únicamente a reconocer una frase literal.
- Cuando el contenido permita cálculos, genera también problemas que exijan seleccionar y aplicar correctamente fórmulas, datos y unidades de la fuente.
- No fuerces una proporción fija entre los estilos 2024 y 2026. Elige para cada contenido la forma de evaluación que produzca la pregunta más exigente, natural y representativa de una oposición de Bombero de Navarra.
- Los exámenes oficiales sirven únicamente como referencia de ESTILO. La respuesta y todo conocimiento necesario para resolver cada pregunta deben proceder exclusivamente de los documentos recuperados mediante File Search.

NIVEL DE EXIGENCIA:
- El nivel objetivo debe ser superior al habitual de los exámenes oficiales de referencia, para que el entrenamiento resulte más exigente que el examen real.
- Aumenta la dificultad mediante conocimiento, precisión, comprensión, relación, aplicación y razonamiento; NUNCA mediante ambigüedad, información externa, redacciones artificiosamente confusas o trampas discutibles.
- En dificultad alta, prioriza diferencias sutiles pero objetivas: cifras próximas, conceptos relacionados, excepciones, secuencias, condiciones de aplicación, relaciones entre variables y alternativas técnicamente plausibles.
- Evita distractores absurdos o fácilmente descartables. Un opositor bien preparado debe necesitar conocer el contenido o razonarlo correctamente para descartar cada alternativa.
- Equilibra la longitud, precisión y apariencia de las cuatro alternativas para que la respuesta correcta no pueda identificarse por pistas de redacción.
- Combina preguntas de conocimiento literal con preguntas que exijan comprensión, relación y razonamiento sobre el contenido.
- Incluye, cuando el contenido lo permita, preguntas del tipo "señale la CORRECTA" y "señale la INCORRECTA".
- En preguntas de dificultad alta, utiliza también alternativas desarrolladas que obliguen a leer y comparar cuidadosamente varias afirmaciones.
- Los distractores deben ser plausibles, próximos al contenido correcto y diferenciarse mediante matices relevantes.
- Cuando el contenido permita realizar cálculos, genera también problemas de cálculo que obliguen a aplicar correctamente los datos o fórmulas de la fuente.
- No conviertas todas las preguntas en preguntas de razonamiento: los datos literales y numéricos también deben ser evaluados.

REGLAS OBLIGATORIAS:
- 4 opciones y exactamente una correcta.
- La respuesta correcta debe estar demostrada literalmente o de forma inequívoca por la fuente.
- Nunca puede haber dos respuestas razonablemente defendibles.
- Respeta exactamente cifras, unidades, terminología, excepciones y procedimientos del documento.
- Mezcla las posiciones A/B/C/D de las respuestas correctas sin un patrón evidente.
- sourceEvidence debe contener una paráfrasis breve del fragmento que demuestra la respuesta, NO inventada.
- sourcePage: número de página si la recuperación permite identificarlo; null si no.
- explanation: explicación clara y estrictamente basada en la fuente que permita comprender por qué la respuesta correcta lo es.
- Si una pregunta no puede fundamentarse con seguridad, descártala y crea otra.

PRIORIDAD:
Calidad, fidelidad al documento, diversidad temática y cobertura del contenido tienen prioridad sobre generar preguntas rápidamente.`;
}
app.post("/api/generate", async(req,res)=>{
  try{
    if(!STORE) throw new Error("Primero indexa el PDF.");

    const count=Math.min(Math.max(Number(req.body.count)||10,5),40);
    const difficulty=req.body.difficulty==="media" ? "media" : "alta";
    const mode=["literal","mixto","calculos"].includes(req.body.mode)
      ? req.body.mode
      : "mixto";

    const ai=aiClient();

    console.log("GENERATECONTENT: iniciando");

    const response=await ai.models.generateContent({
      model:"gemini-3.5-flash-lite",
      contents:generationPrompt(count,difficulty,mode),
      config:{
        tools:[{
          fileSearch:{
            fileSearchStoreNames:[STORE]
          }
        }],
        responseMimeType:"application/json",
        responseJsonSchema:questionSchema
      }
    });

    console.log("GENERATECONTENT: respuesta recibida");

    const parsed=JSON.parse(response.text);

    if(!parsed.questions || parsed.questions.length===0){
      throw new Error("Gemini no devolvió preguntas.");
    }

    for(const q of parsed.questions){
      if(
        q.options?.length!==4 ||
        !Number.isInteger(q.correctIndex) ||
        q.correctIndex<0 ||
        q.correctIndex>3
      ){
        throw new Error("Pregunta inválida detectada.");
      }
    }

    res.json({
      ok:true,
      questions:parsed.questions
    });

  }catch(e){
    console.error("ERROR GENERATECONTENT:",e);
    res.status(500).json({
      ok:false,
      error:e?.message || String(e)
    });
  }
});
app.get("/api/generate-status/:id", async(req,res)=>{
  try{
    const ai=aiClient();

    const interaction=await ai.interactions.get(req.params.id);

    console.log(
      "GENERATE STATUS:",
      req.params.id,
      interaction.status
    );

    if(interaction.status==="failed"){
      throw new Error(
        interaction.error?.message ||
        "Gemini no pudo generar el test."
      );
    }

    if(interaction.status!=="completed"){
      return res.json({
        ok:true,
        completed:false,
        status:interaction.status
      });
    }

    const parsed=JSON.parse(interaction.output_text);

    if(
      !parsed.questions ||
      parsed.questions.length===0
    ){
      throw new Error("Gemini no devolvió preguntas.");
    }

    for(const q of parsed.questions){
      if(
        q.options?.length!==4 ||
        !Number.isInteger(q.correctIndex) ||
        q.correctIndex<0 ||
        q.correctIndex>3
      ){
        throw new Error("Pregunta inválida detectada.");
      }
    }

    res.json({
      ok:true,
      completed:true,
      questions:parsed.questions
    });

  }catch(e){
    console.error("ERROR GENERATE STATUS:",e);

    res.status(500).json({
      ok:false,
      error:e?.message || String(e)
    });
  }
});

async function startServer(){
  await initDatabase();
  await loadStore();

  app.listen(process.env.PORT || 3000, ()=>{
    console.log("Test Bombero V2 listo");
    console.log("STORE recuperado:", STORE || "ninguno");
  });
}

startServer().catch(e=>{
  console.error("ERROR INICIANDO SERVIDOR:", e);
  process.exit(1);
});
