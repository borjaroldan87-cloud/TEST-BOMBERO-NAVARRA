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
FUENTE ÚNICA: los documentos recuperados mediante File Search. No uses conocimiento externo.
Genera EXACTAMENTE ${count} preguntas tipo test, en español, dificultad ${difficulty}, modo ${mode}.
REGLAS OBLIGATORIAS:
- 4 opciones y exactamente una correcta.
- La respuesta correcta debe estar demostrada literalmente o de forma inequívoca por la fuente.
- Distractores plausibles pero falsos según la fuente; nunca dos respuestas defendibles.
- Respeta cifras, unidades, terminología y procedimientos del documento.
- Evita preguntas repetidas o casi equivalentes.
- Mezcla posiciones A/B/C/D sin patrón evidente.
- sourceEvidence debe contener una paráfrasis breve del fragmento que demuestra la respuesta, NO inventada.
- sourcePage: número de página si la recuperación permite identificarlo; null si no.
- explanation: breve y estrictamente basada en la fuente.
Si una pregunta no puede fundamentarse con seguridad, no la uses y crea otra.`;
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
