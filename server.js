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

ESTILO DE OPOSICIÓN:
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
