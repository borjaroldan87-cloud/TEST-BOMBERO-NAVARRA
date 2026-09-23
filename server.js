import express from "express";
import multer from "multer";
import { GoogleGenAI } from "@google/genai";
import fs from "fs";
import path from "path";
import { PDFDocument } from "pdf-lib";
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
let EXAM_STYLE_STORE = null;

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
  `);await db.query(`
  ALTER TABLE coverage_items
  ADD COLUMN IF NOT EXISTS manual_page TEXT
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
async function loadExamStyleStore(){
  const result = await db.query(
    "SELECT value FROM app_state WHERE key = $1",
    ["exam_style_store"]
  );

  if(result.rows.length){
    EXAM_STYLE_STORE = result.rows[0].value;
  }

  return EXAM_STYLE_STORE;
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

async function saveExamStyleStore(storeName){
  await db.query(
    `INSERT INTO app_state (key, value)
     VALUES ($1, $2)
     ON CONFLICT (key)
     DO UPDATE SET value = EXCLUDED.value`,
    ["exam_style_store", storeName]
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
   source_page, manual_page, source_evidence)
 VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
 ON CONFLICT (topic_id, concept, item_type, evaluation_type)
 DO NOTHING`,
[
  topicId,
  item.section || null,
  item.concept,
  item.itemType,
  item.evaluationType,
  item.sourcePage ?? null,
  item.manualPage ?? null,
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
function normalizeCoverageItem(item){
  const clean = value =>
    typeof value === "string"
      ? value.trim().replace(/\s+/g, " ")
      : value;

  return {
    ...item,
    section: clean(item.section) || null,
    concept: clean(item.concept),
    itemType: clean(item.itemType),
    evaluationType: clean(item.evaluationType),
    sourceEvidence: clean(item.sourceEvidence) || null
  };
}
function coverageKey(item){
  const normalized=normalizeCoverageItem(item);

  const text=value=>
    String(value ?? "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g,"")
      .replace(/[^\p{L}\p{N}]+/gu," ")
      .trim()
      .replace(/\s+/g," ");

  return [
    Number(normalized.sourcePage) || 0,
    text(normalized.concept),
    text(normalized.itemType),
    text(normalized.evaluationType)
  ].join("|");
}

function deduplicateCoverageItems(items){
  const unique=new Map();

  for(const rawItem of items){
    const item=normalizeCoverageItem(rawItem);

    if(!item.concept){
      continue;
    }

    const key=coverageKey(item);

    if(!unique.has(key)){
      unique.set(key,item);
      continue;
    }

    const current=unique.get(key);

    if(
      (!current.sourceEvidence && item.sourceEvidence) ||
      String(item.sourceEvidence ?? "").length >
      String(current.sourceEvidence ?? "").length
    ){
      unique.set(key,{
        ...current,
        ...item,
        worked:Boolean(current.worked || item.worked)
      });
    }
  }

  return [...unique.values()];
}
async function semanticDeduplicateCoverageItems(items){
  if(!items.length){
    return [];
  }

  const compactItems=items.map(item=>({
    id:item.id,
    page:item.sourcePage,
    concept:item.concept,
    itemType:item.itemType,
    evaluationType:item.evaluationType
  }));

  const prompt=`
Actúa como auditor de un mapa curricular para una oposición de Bomberos de Navarra.

Recibirás elementos examinables extraídos DEL MISMO TEMA.

OBJETIVO:
Detectar exclusivamente elementos que representan realmente el mismo conocimiento
aunque estén redactados de forma diferente.

REGLAS CRÍTICAS:

1. NO agrupes elementos solo porque hablen del mismo asunto.
2. NO agrupes conocimientos complementarios.
3. NO agrupes cifras, condiciones, excepciones, procedimientos o consecuencias diferentes.
4. NO elimines variantes que exijan conocimientos distintos.
5. Si dos elementos tienen el mismo concepto pero evalúan aspectos materialmente distintos,
   deben conservarse separados.
6. Agrupa únicamente cuando responder correctamente a uno implique necesariamente conocer
   exactamente la misma información que para responder al otro.
7. Ante cualquier duda, CONSERVA ambos.
8. Los números de página ayudan a contextualizar, pero no determinan por sí solos que sean duplicados.
9. No inventes, corrijas ni añadas contenido.
10. Devuelve únicamente grupos con DOS O MÁS IDs realmente equivalentes.

FORMATO JSON EXACTO:

{
  "groups":[
    {
      "keepId":123,
      "duplicateIds":[456,789],
      "reason":"Explicación breve de por qué evalúan exactamente el mismo conocimiento"
    }
  ]
}

El keepId debe ser uno de los IDs del grupo.
duplicateIds NO debe contener keepId.

ELEMENTOS:
${JSON.stringify(compactItems)}
`;
const ai=aiClient();
  const response=await ai.models.generateContent({
    model:"gemini-3.5-flash-lite",
    contents:prompt,
    config:{
      responseMimeType:"application/json",
      responseJsonSchema:{
        type:"object",
        properties:{
          groups:{
            type:"array",
            items:{
              type:"object",
              properties:{
                keepId:{type:"integer"},
                duplicateIds:{
                  type:"array",
                  items:{type:"integer"}
                },
                reason:{type:"string"}
              },
              required:["keepId","duplicateIds","reason"]
            }
          }
        },
        required:["groups"]
      }
    }
  });

  const parsed=JSON.parse(response.text);

  return Array.isArray(parsed.groups)
    ? parsed.groups
    : [];
}
async function validateSemanticDuplicateGroups(items,groups){
  if(!groups.length){
    return [];
  }

  const itemMap=new Map(
    items.map(item=>[Number(item.id),item])
  );

  const candidates=groups.map(group=>({
    keep:itemMap.get(Number(group.keepId)),
    duplicates:group.duplicateIds
      .map(id=>itemMap.get(Number(id)))
      .filter(Boolean),
    firstReason:group.reason
  })).filter(group=>group.keep && group.duplicates.length);

  const ai=aiClient();

  const prompt=`
Eres la SEGUNDA Y ÚLTIMA AUDITORÍA de deduplicación de un mapa curricular
para una oposición de Bomberos de Navarra.

Una primera auditoría ha propuesto grupos de posibles duplicados.
Debes revisar esos grupos de forma MUY CONSERVADORA utilizando el contenido
completo de cada registro, especialmente concept, itemType, evaluationType,
sourcePage y sourceEvidence.

OBJETIVO:
Autorizar exclusivamente eliminaciones que NO provoquen ninguna pérdida
de conocimiento examinable ni de una forma de evaluación materialmente distinta.

REGLA FUNDAMENTAL:
Dos registros solo pueden fusionarse cuando son REDUNDANTES DE VERDAD.

Para autorizar la eliminación de un registro deben cumplirse TODAS estas condiciones:

1. Expresan exactamente el mismo dato, regla, definición, fórmula,
   clasificación, procedimiento, condición o conocimiento.
2. No contienen cifras, límites, excepciones, pasos o condiciones diferentes.
3. Ninguno aporta información examinable adicional.
4. La eliminación no reduce la cobertura curricular.
5. No representan formas de evaluación materialmente diferentes que interese conservar.
6. sourceEvidence confirma la equivalencia.
7. Ante la mínima duda, NO autorices la eliminación.

EJEMPLOS DE LO QUE NO DEBES FUSIONAR:
- funciones de raíces y funciones de ramas;
- coeficiente aerodinámico y módulo de Young;
- definición de una técnica y pasos de ejecución;
- aplicación de una técnica y normas de seguridad;
- fórmula y significado de sus variables;
- valor numérico y procedimiento para obtenerlo;
- clasificación y características de cada categoría.

IMPORTANTE:
Puedes aceptar solo una parte de los duplicateIds de un grupo.
No estás obligado a aceptar el grupo completo.

Devuelve ÚNICAMENTE los IDs cuya eliminación sea segura.

FORMATO JSON EXACTO:

{
  "approvedGroups":[
    {
      "keepId":123,
      "deleteIds":[456],
      "reason":"Ambos registros contienen exactamente la misma unidad examinable."
    }
  ]
}

Si ningún candidato puede eliminarse con seguridad:

{
  "approvedGroups":[]
}

CANDIDATOS:
${JSON.stringify(candidates)}
`;

  const response=await ai.models.generateContent({
    model:"gemini-3.5-flash-lite",
    contents:prompt,
    config:{
      responseMimeType:"application/json",
      responseJsonSchema:{
        type:"object",
        properties:{
          approvedGroups:{
            type:"array",
            items:{
              type:"object",
              properties:{
                keepId:{type:"integer"},
                deleteIds:{
                  type:"array",
                  items:{type:"integer"}
                },
                reason:{type:"string"}
              },
              required:["keepId","deleteIds","reason"]
            }
          }
        },
        required:["approvedGroups"]
      }
    }
  });

  const parsed=JSON.parse(response.text);

  return Array.isArray(parsed.approvedGroups)
    ? parsed.approvedGroups
    : [];
}
async function finalDuplicateDecision(items,approvedGroups){
  if(!approvedGroups.length){
    return [];
  }

  const itemMap=new Map(
    items.map(item=>[Number(item.id),item])
  );

  const pairs=[];

  for(const group of approvedGroups){
    const keep=itemMap.get(Number(group.keepId));
    if(!keep) continue;

    for(const deleteId of group.deleteIds){
      const candidate=itemMap.get(Number(deleteId));
      if(!candidate) continue;

      pairs.push({
        keep,
        candidate
      });
    }
  }

  if(!pairs.length){
    return [];
  }

  const ai=aiClient();

  const prompt=`
Eres el control final de deduplicación de un mapa curricular para una
oposición de Bomberos de Navarra.

Cada elemento representa una UNIDAD EXAMINABLE extraída del temario.

Recibirás parejas:
- keep: elemento que se conservaría.
- candidate: elemento que se plantea eliminar.

Debes decidir CADA PAREJA POR SEPARADO.

La prioridad absoluta es NO PERDER COBERTURA.

DECISIÓN "DELETE":
Solo cuando keep y candidate contienen EXACTAMENTE la misma unidad examinable.

DECISIÓN "KEEP":
Siempre que candidate permita evaluar cualquier dato, paso, cifra, condición,
excepción, relación, definición, fórmula, variable, clasificación, procedimiento,
medida de seguridad o detalle que no esté íntegramente contenido en keep.

REGLAS OBLIGATORIAS:

1. Pertenecer al mismo concepto NO significa ser duplicado.

2. Dos pasos diferentes del mismo procedimiento son unidades diferentes:
   KEEP.

3. Una regla general y uno de sus detalles concretos:
   KEEP.

4. Una clasificación y cada una de sus categorías:
   KEEP.

5. Una fórmula y el significado de una variable:
   KEEP.

6. Una técnica y sus indicaciones, pasos, límites o medidas de seguridad:
   KEEP.

7. Una cifra y otra cifra relacionada:
   KEEP.

8. Una definición y una consecuencia:
   KEEP.

9. Una pregunta directa y otra que exige conocimiento materialmente distinto:
   KEEP.

10. Solo la redacción puede variar para poder decidir DELETE.
    El conocimiento necesario para responder debe ser el mismo.

11. Compara especialmente sourceEvidence.
    No decidas DELETE por similitud de los títulos conceptuales.

12. Si candidate contiene aunque sea UN detalle examinable adicional:
    KEEP.

13. Ante cualquier duda:
    KEEP.

Para cada pareja indica también:
- sharedKnowledge: qué información tienen realmente en común.
- uniqueCandidateKnowledge: qué aporta candidate que no aporta keep.
  Si no aporta absolutamente nada diferente, devuelve cadena vacía.

Solo DELETE cuando uniqueCandidateKnowledge sea cadena vacía.

FORMATO JSON EXACTO:

{
  "decisions":[
    {
      "keepId":123,
      "candidateId":456,
      "decision":"KEEP",
      "sharedKnowledge":"...",
      "uniqueCandidateKnowledge":"...",
      "reason":"..."
    }
  ]
}

PAREJAS:
${JSON.stringify(pairs)}
`;

  const response=await ai.models.generateContent({
    model:"gemini-3.5-flash-lite",
    contents:prompt,
    config:{
      responseMimeType:"application/json",
      responseJsonSchema:{
        type:"object",
        properties:{
          decisions:{
            type:"array",
            items:{
              type:"object",
              properties:{
                keepId:{type:"integer"},
                candidateId:{type:"integer"},
                decision:{
                  type:"string",
                  enum:["KEEP","DELETE"]
                },
                sharedKnowledge:{type:"string"},
                uniqueCandidateKnowledge:{type:"string"},
                reason:{type:"string"}
              },
              required:[
                "keepId",
                "candidateId",
                "decision",
                "sharedKnowledge",
                "uniqueCandidateKnowledge",
                "reason"
              ]
            }
          }
        },
        required:["decisions"]
      }
    }
  });

  const parsed=JSON.parse(response.text);

  return Array.isArray(parsed.decisions)
    ? parsed.decisions
    : [];
}
async function splitPdfIntoChunks(pdfPath, pagesPerChunk=5){
  const sourceBytes=fs.readFileSync(pdfPath);
  const sourcePdf=await PDFDocument.load(sourceBytes);

  const totalPages=sourcePdf.getPageCount();
  const chunks=[];

  for(let start=0; start<totalPages; start+=pagesPerChunk){
    const end=Math.min(start+pagesPerChunk,totalPages);

    const chunkPdf=await PDFDocument.create();
    const pageIndexes=[];

    for(let i=start;i<end;i++){
      pageIndexes.push(i);
    }

    const copiedPages=await chunkPdf.copyPages(sourcePdf,pageIndexes);

    copiedPages.forEach(page=>{
      chunkPdf.addPage(page);
    });

    const chunkBytes=await chunkPdf.save();

    chunks.push({
      startPage:start+1,
      endPage:end,
      data:Buffer.from(chunkBytes).toString("base64")
    });
  }

  return {
    totalPages,
    chunks
  };
}
const manualPageMapSchema={
  type:"object",
  properties:{
    pages:{
      type:"array",
      items:{
        type:"object",
        properties:{
          sourcePage:{type:"integer"},
          manualPage:{type:["integer","string","null"]}
        },
        required:["sourcePage","manualPage"]
      }
    }
  },
  required:["pages"]
};

async function extractManualPageMap(ai,chunks){
  const pageMap=[];

  for(const chunk of chunks){
    console.log(
      `PAGE MAP: analizando páginas físicas ${chunk.startPage}-${chunk.endPage}`
    );

    const response=await ai.models.generateContent({
      model:"gemini-3.5-flash-lite",
      contents:[
        {
          text:`
Analiza exclusivamente la NUMERACIÓN IMPRESA de las páginas del PDF adjunto.

El PDF adjunto corresponde a las páginas físicas ${chunk.startPage} a ${chunk.endPage}
del documento original.

Debes devolver EXACTAMENTE un registro por cada página física del PDF adjunto.

Para cada página:

- sourcePage: número de página física del documento original.
- manualPage: número de página que aparece IMPRESO VISUALMENTE en el pie de página
  del propio manual.

REGLAS OBLIGATORIAS:

1. Lee manualPage directamente de cada página.
2. NO calcules diferencias u offsets entre sourcePage y manualPage.
3. NO deduzcas manualPage utilizando las páginas anteriores o posteriores.
4. NO confundas sourcePage con manualPage.
5. Si una página no muestra una numeración impresa identificable con seguridad,
   manualPage debe ser null.
6. No analices el contenido técnico del documento.
7. No generes conceptos ni preguntas.
8. Devuelve exactamente las páginas físicas comprendidas entre
   ${chunk.startPage} y ${chunk.endPage}.
`
        },
        {
          inlineData:{
            mimeType:"application/pdf",
            data:chunk.data
          }
        }
      ],
      config:{
        responseMimeType:"application/json",
        responseJsonSchema:manualPageMapSchema
      }
    });

    const parsed=JSON.parse(response.text);

    if(!parsed.pages || !Array.isArray(parsed.pages)){
      throw new Error(
        `No se pudo obtener el mapa de páginas ${chunk.startPage}-${chunk.endPage}.`
      );
    }

    const expectedCount=chunk.endPage-chunk.startPage+1;

    if(parsed.pages.length!==expectedCount){
      throw new Error(
        `El mapa ${chunk.startPage}-${chunk.endPage} debía devolver ${expectedCount} páginas y devolvió ${parsed.pages.length}.`
      );
    }

    for(const page of parsed.pages){
      if(
        page.sourcePage<chunk.startPage ||
        page.sourcePage>chunk.endPage
      ){
        throw new Error(
          `sourcePage inválida en el mapa de páginas: ${page.sourcePage}.`
        );
      }
    }

    pageMap.push(...parsed.pages);
  }

  return pageMap;
}
async function applyManualPageMapToTopic(topicId,pageMap){
  let updatedRows=0;

  for(const page of pageMap){
    if(page.manualPage===null || page.manualPage===undefined){
      continue;
    }

    const result=await db.query(
      `UPDATE coverage_items
       SET manual_page=$1
       WHERE topic_id=$2
       AND source_page=$3`,
      [
        String(page.manualPage),
        topicId,
        page.sourcePage
      ]
    );

    updatedRows+=result.rowCount;
  }

  return updatedRows;
}
function coverageGapPrompt(existingItems, startPage, endPage){
  const existingSummary=existingItems.map(item=>({
    concept:item.concept,
    itemType:item.item_type,
    evaluationType:item.evaluation_type,
    sourcePage:item.source_page
  }));

  return `
ACTÚAS COMO AUDITOR EXHAUSTIVO DE COBERTURA DE UN TEMARIO DE OPOSICIÓN.

Estás revisando únicamente las páginas ${startPage} a ${endPage}
del documento original.

Ya existe un análisis previo de estas páginas. Los elementos examinables
detectados anteriormente son:

${JSON.stringify(existingSummary)}

TU ÚNICA MISIÓN ES DETECTAR CONTENIDO EXAMINABLE QUE FALTE.

Compara exhaustivamente el PDF adjunto con la lista anterior.

Debes buscar especialmente omisiones de:
- definiciones y conceptos;
- datos numéricos y unidades;
- tablas, filas, columnas y relaciones entre valores;
- fórmulas y cada una de sus variables;
- cálculos y posibles aplicaciones de las fórmulas;
- clasificaciones y enumeraciones;
- procedimientos y secuencias;
- condiciones, límites y excepciones;
- relaciones causa-efecto;
- diferencias entre conceptos similares;
- medidas de seguridad;
- indicaciones y contraindicaciones;
- contenido técnico presente en esquemas, figuras o gráficos;
- cualquier detalle literal susceptible de convertirse en una pregunta tipo test.

REGLAS:
1. NO repitas elementos que ya estén representados en la lista previa.
2. NO inventes información.
3. TODO elemento nuevo debe estar respaldado literalmente por estas páginas.
4. Divide un mismo contenido en varios elementos cuando permita evaluar
   conocimientos realmente distintos.
5. Si una fórmula permite preguntar por su identificación, variables,
   despeje o aplicación, considera esas posibilidades por separado cuando
   estén respaldadas por el documento.
6. Si una tabla contiene varios datos examinables, no la reduzcas a una
   descripción genérica de "la tabla".
7. sourcePage debe corresponder a una página comprendida entre
   ${startPage} y ${endPage}.
8. Si no falta absolutamente ningún elemento examinable, devuelve items: [].

Devuelve EXCLUSIVAMENTE los elementos que faltan.
`;
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
async function ensureExamStyleStore(){
  if(EXAM_STYLE_STORE) return EXAM_STYLE_STORE;

  await loadExamStyleStore();
  if(EXAM_STYLE_STORE) return EXAM_STYLE_STORE;

  const ai=aiClient();

  const store=await ai.fileSearchStores.create({
    config:{
      displayName:"Bombero Navarra - Examenes oficiales 2024-2026",
      embeddingModel:"models/gemini-embedding-2"
    }
  });

  EXAM_STYLE_STORE=store.name;
  await saveExamStyleStore(EXAM_STYLE_STORE);

  return EXAM_STYLE_STORE;
}
async function ingestExamStyle(filePath, displayName){
  const ai=aiClient();
  const store=await ensureExamStyleStore();

  let op=await ai.fileSearchStores.uploadToFileSearchStore({
    file:filePath,
    fileSearchStoreName:store,
    config:{displayName}
  });

  await waitOp(ai,op);

  return store;
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
app.post("/api/ingest-official-exams", async (req,res)=>{
  try{
    const dataFiles = fs.readdirSync(path.resolve("data"));

const file2024 = dataFiles.find(name =>
  name.includes("PRUEBA TEORICA BOMBEROS") &&
  name.includes("2024")
);

const file2026 = dataFiles.find(name =>
  name === "Prueba modelo B.pdf"
);

if(!file2024){
  throw new Error("No se encuentra el examen oficial de 2024.");
}

if(!file2026){
  throw new Error("No se encuentra el examen oficial de 2026.");
}

const exam2024 = path.resolve("data", file2024);
const exam2026 = path.resolve("data", file2026);

    if(!fs.existsSync(exam2024)){
      throw new Error("No se encuentra el examen oficial de 2024.");
    }

    if(!fs.existsSync(exam2026)){
      throw new Error("No se encuentra el examen oficial de 2026.");
    }

    const store = await ensureExamStyleStore();

    await ingestExamStyle(
      exam2024,
      "Examen oficial Bomberos Navarra - Modelo B - 2024"
    );

    await ingestExamStyle(
      exam2026,
      "Examen oficial Bomberos Navarra - Modelo B - 2026"
    );

    res.json({
      ok:true,
      message:"Exámenes oficiales 2024 y 2026 indexados como referencia de estilo.",
      examStyleStore:store
    });

  }catch(e){
    console.error("ERROR INDEXANDO EXÁMENES OFICIALES:",e);
    res.status(500).json({
      ok:false,
      error:e?.message || String(e)
    });
  }
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
      manualPage:{type:["integer","string","null"]},
      difficulty:{type:"string",enum:["media","alta"]},
      questionFamily:{
        type:"string",
        enum:[
          "2026_CORRECTA",
          "2026_INCORRECTA",
          "2026_RAZONAMIENTO",
          "2024_NUMERICA",
          "2024_TEXTO",
          "CALCULO_FORMULACION",
          "GRAFICA"
        ]
      },
graphic:{
  type:["object","null"],
  properties:{
    type:{
      type:"string",
      enum:[
        "technical",
        "geometry",
        "mechanism",
        "configuration",
        "circuit",
        "forces"
      ]
    },
    title:{type:"string"},
    elements:{
      type:"array",
      items:{
        type:"object",
        properties:{
          id:{type:"string"},
          shape:{
            type:"string",
            enum:[
              "line",
              "rect",
              "circle",
              "ellipse",
              "polygon",
              "polyline",
              "arrow",
              "text"
            ]
          },
          label:{type:"string"},
          x:{type:"number"},
          y:{type:"number"},
          x2:{type:["number","null"]},
          y2:{type:["number","null"]},
          width:{type:["number","null"]},
          height:{type:["number","null"]},
          radius:{type:["number","null"]},
          points:{
            type:"array",
            items:{
              type:"object",
              properties:{
                x:{type:"number"},
                y:{type:"number"}
              },
              required:["x","y"]
            }
          }
        },
        required:[
          "id",
          "shape",
          "label",
          "x",
          "y",
          "x2",
          "y2",
          "width",
          "height",
          "radius",
          "points"
        ]
      }
    },
    description:{type:"string"}
  },
  required:[
    "type",
    "title",
    "elements",
    "description"
  ]
}
   },required:[
      "stem",
      "options",
      "correctIndex",
      "explanation",
      "sourceEvidence",
      "sourcePage",
      "manualPage",
      "difficulty",
      "questionFamily",
      "graphic"
    ]}}
  },
  required:["questions"]
};
const validationSchema={
  type:"object",
  properties:{
    results:{
      type:"array",
      items:{
        type:"object",
        properties:{
          index:{type:"integer",minimum:0},
          valid:{type:"boolean"},
          issues:{
            type:"array",
            items:{type:"string"}
          },
          familyValid:{type:"boolean"},
          familyIssues:{
            type:"array",
            items:{type:"string"}
          },
          graphicValid:{type:["boolean","null"]},
          graphicIssues:{
            type:"array",
            items:{type:"string"}
          }
        },
        required:[
          "index",
          "valid",
          "issues",
          "familyValid",
          "familyIssues",
          "graphicValid",
          "graphicIssues"
        ]
      }
    }
  },
  required:["results"]
};
const coverageSchema={
  type:"object",
  properties:{
    items:{
      type:"array",
      items:{
        type:"object",
        properties:{
          section:{type:"string"},
          concept:{type:"string"},
          itemType:{
            type:"string",
            enum:[
              "concepto",
              "dato_numerico",
              "tabla",
              "formula",
              "procedimiento",
              "clasificacion",
              "enumeracion",
              "excepcion",
              "relacion",
              "otro"
            ]
          },
          evaluationType:{
            type:"string",
            enum:[
              "literal",
              "identificacion",
              "comprension",
              "comparacion",
              "aplicacion",
              "calculo",
              "interpretacion",
              "secuencia",
              "pertenencia_exclusion",
              "relacion_variables"
            ]
          },
          sourcePage:{type:["integer","null"]},
manualPage:{type:["integer","string","null"]},
sourceEvidence:{type:"string"}
        },
        required:[
          "section",
          "concept",
          "itemType",
          "evaluationType",
          "sourcePage",
          "manualPage",
          "sourceEvidence"
        ]
      }
    }
  },
  required:["items"]
};
function coverageAnalysisPrompt(){
  return `Eres un analista de temario para una oposición de Bombero de Navarra.

MISIÓN:
Analiza exhaustivamente el documento recuperado mediante File Search y crea un INVENTARIO DE CONTENIDO EXAMINABLE.

Este inventario servirá posteriormente para:
1. generar preguntas tipo test;
2. controlar qué contenido ya se ha trabajado;
3. calcular el porcentaje de cobertura del tema;
4. detectar qué contenido sigue pendiente.

Por ello, la prioridad es NO OMITIR contenido razonablemente examinable y NO crear elementos artificiales o redundantes.

FUENTE ÚNICA:
- Utiliza exclusivamente el documento recuperado mediante File Search.
- No añadas conocimiento externo.
- No corrijas, completes ni sustituyas el contenido del documento con conocimientos propios.
- Conserva la terminología, cifras, unidades, clasificaciones y criterios utilizados por la fuente.
- Si algo no puede sustentarse inequívocamente con el documento, no lo incluyas.

CRITERIO DE OPOSICIÓN:
Analiza el contenido desde la perspectiva de una oposición de Bombero de Navarra de nivel alto.
Considera examinable cualquier información que razonablemente pueda convertirse en una pregunta objetiva de 4 opciones con una sola respuesta correcta.
No descartes información por ser demasiado literal, específica, numérica o aparentemente secundaria.

GRANULARIDAD:
- Divide el tema en unidades examinables con significado propio.
- Un elemento debe representar un conocimiento o capacidad concreta que pueda evaluarse de forma independiente.
- No agrupes contenidos distintos únicamente porque aparezcan en el mismo párrafo, apartado o tabla.
- No fragmentes una misma idea en múltiples elementos equivalentes únicamente cambiando su redacción.
- Dos elementos sobre el mismo concepto son válidos cuando evalúan conocimientos o capacidades sustancialmente diferentes.
- El objetivo NO es producir el mayor número posible de items, sino representar exhaustivamente todo lo razonablemente examinable sin redundancia artificial.

TIPOS DE CONTENIDO:
Identifica, cuando existan:
- conceptos y definiciones;
- características y propiedades;
- datos numéricos;
- porcentajes;
- dimensiones y medidas;
- unidades;
- límites, intervalos y umbrales;
- clasificaciones y categorías;
- enumeraciones;
- relaciones entre conceptos;
- causas y consecuencias expresamente indicadas;
- condiciones de aplicación;
- excepciones;
- procedimientos;
- secuencias y orden de actuaciones;
- tablas;
- fórmulas;
- relaciones entre variables;
- ejemplos técnicos que contengan conocimiento generalizable respaldado por la fuente;
- cualquier otro contenido susceptible de evaluación objetiva.

TABLAS:
Analiza cada tabla con especial profundidad.
No consideres una tabla como un único elemento si contiene varios conocimientos independientes.
Identifica cuando proceda:
- significado de filas, columnas o categorías;
- valores concretos relevantes;
- correspondencias;
- comparaciones;
- límites e intervalos;
- pertenencias y exclusiones;
- excepciones;
- relaciones entre diferentes valores.
No generes combinaciones triviales de cada celda solo para aumentar artificialmente el inventario.

FÓRMULAS:
Para cada fórmula determina qué formas de evaluación están realmente respaldadas por el documento.
Pueden incluir, cuando proceda:
- reconocimiento o identificación;
- significado de variables;
- unidades;
- relación entre magnitudes;
- despeje o aplicación;
- cálculo numérico;
- interpretación del resultado;
- efecto objetivo de modificar una variable.
No inventes aplicaciones que requieran principios, constantes o supuestos externos al documento.

PROCEDIMIENTOS:
Cuando exista un procedimiento, analiza independientemente cuando proceda:
- objetivo;
- condiciones de aplicación;
- material o elementos implicados;
- acciones;
- orden o secuencia;
- comprobaciones;
- límites;
- prohibiciones;
- excepciones;
- actuaciones anteriores o posteriores.
No dividas pasos que carezcan de significado examinable independiente.

ENUMERACIONES Y CLASIFICACIONES:
Cuando existan, considera cuando proceda:
- identificación;
- pertenencia;
- exclusión;
- correspondencia;
- diferencias;
- características;
- número de elementos, únicamente cuando ese número tenga sentido examinable.
No crees múltiples items equivalentes que evalúen exactamente la misma memorización.

DATOS NUMÉRICOS:
Conserva exactamente los valores, unidades, signos, intervalos y condiciones de la fuente.
Un mismo dato puede participar en diferentes tipos de evaluación únicamente si realmente exige capacidades diferentes, por ejemplo recuerdo literal frente a aplicación en un cálculo.

TIPOS DE EVALUACIÓN:
Asigna a cada item el evaluationType que mejor represente cómo puede evaluarse:
- literal
- identificacion
- comprension
- comparacion
- aplicacion
- calculo
- interpretacion
- secuencia
- pertenencia_exclusion
- relacion_variables

No generes automáticamente todos los evaluationType para cada concepto.
Incluye únicamente aquellos que tengan sentido real según el contenido disponible.

CONTROL DE DUPLICADOS:
Antes de devolver el inventario, revisa mentalmente todos los items.
Elimina:
- duplicados;
- paráfrasis del mismo conocimiento;
- variantes que solo cambien palabras;
- divisiones artificiales;
- elementos que no puedan generar una pregunta objetiva y defendible.

CONTROL DE OMISIONES:
Antes de finalizar, realiza una segunda revisión mental del documento buscando específicamente:
- cifras;
- porcentajes;
- unidades;
- tablas;
- fórmulas;
- notas;
- excepciones;
- enumeraciones;
- clasificaciones;
- procedimientos;
- condiciones;
- límites;
- relaciones;
- contenido de apartados que haya quedado sin representar.

CAMPOS:
- section: apartado o contexto del documento al que pertenece.
- concept: descripción precisa y autosuficiente del conocimiento que se evaluará.
- itemType: tipo de contenido según el esquema proporcionado.
- evaluationType: forma concreta de evaluación.
- sourcePage: página si puede identificarse con seguridad; null si no.
- sourceEvidence: evidencia breve y fiel de la fuente suficiente para justificar que el item existe. No inventes ni completes información.

REGLA FINAL:
La calidad del inventario se mide por dos criterios simultáneos:
EXHAUSTIVIDAD: no dejar contenido razonablemente examinable sin representar.
PRECISIÓN: no inflar el inventario mediante elementos redundantes, artificiales o no respaldados por la fuente.

Devuelve exclusivamente el JSON solicitado por el esquema.`;
}
function officialStyleAnalysisPrompt(){
  return `
Analiza exclusivamente el ESTILO DE REDACCIÓN Y CONSTRUCCIÓN DE PREGUNTAS
de los exámenes oficiales de Bomberos de Navarra disponibles en File Search.

IMPORTANTE:
Estos documentos NO son fuente factual para futuros test.
No debes crear un temario, extraer respuestas correctas ni convertir sus datos
técnicos en conocimiento de referencia.

Tu trabajo es construir un PERFIL DE ESTILO reutilizable.

Distingue claramente los patrones observados en 2024 y 2026 y da mayor peso
al estilo de 2026 como referencia principal.

Analiza:

1. Estructura habitual de los enunciados.
2. Longitud y complejidad de los enunciados.
3. Estructura y longitud de las cuatro opciones.
4. Forma de construir distractores plausibles.
5. Uso de preguntas directas.
6. Uso de CORRECTA / INCORRECTA / NO ES CORRECTA.
7. Preguntas conceptuales.
8. Preguntas numéricas.
9. Preguntas de cálculo.
10. Preguntas procedimentales.
11. Preguntas contextualizadas u operativas.
12. Grado de razonamiento exigido.
13. Uso de referencias explícitas a manuales, páginas o normativa.
14. Diferencias relevantes entre 2024 y 2026.
15. Patrones que hacen que una pregunta parezca propia del examen oficial.
16. Patrones de dificultad y construcción de distractores.
17. Errores de estilo que un generador debe evitar.
18. Reglas concretas para generar preguntas MÁS EXIGENTES que las oficiales
    manteniendo su aspecto, lógica y forma de preguntar.

REGLAS CRÍTICAS:
- Analiza FORMA, no contenido factual.
- No conviertas ninguna respuesta del examen en fuente de verdad.
- No incluyas un banco de preguntas oficiales.
- No copies preguntas completas.
- Puedes describir estructuras abstractas de preguntas.
- El perfil debe servir para generar preguntas nuevas usando OTRO almacén
  independiente como única fuente factual.
- 2026 debe tener prioridad estilística sobre 2024.
- Conserva de 2024 los rasgos formales útiles que complementen 2026.

Devuelve un perfil técnico, concreto y directamente utilizable como
instrucciones para otro modelo generador.
`;
}
function generationPrompt(count,difficulty,mode){
  return `Eres el generador de preguntas de entrenamiento para la oposición de Bombero de Navarra.

Debes generar EXACTAMENTE ${count} preguntas tipo test.
Dificultad solicitada: ${difficulty}.
Modo solicitado: ${mode}.

==================================================
1. FUENTE DE VERDAD
==================================================

Los documentos recuperados mediante File Search son la ÚNICA fuente factual.

Todo dato necesario para:
- comprender el enunciado;
- identificar la respuesta correcta;
- demostrar que los distractores son incorrectos;
- realizar cálculos;
- interpretar situaciones;

debe estar respaldado por esos documentos.

PROHIBIDO:
- usar conocimiento externo;
- completar lagunas con conocimiento general;
- introducir normas, valores, procedimientos o terminología no presentes;
- asumir datos técnicos no proporcionados;
- utilizar los exámenes oficiales como fuente factual.

Si la fuente no permite construir una pregunta inequívoca, descártala y genera otra.

==================================================
2. PERFIL DEL TRIBUNAL: MODELOS 2024 + 2026
==================================================

Imita la filosofía de redacción observada en los modelos oficiales B
de Bombero de Navarra de 2024 y 2026.

Los exámenes oficiales son referencia EXCLUSIVAMENTE DE ESTILO.

Da predominio al estilo observado en 2026, conservando los rasgos útiles de 2024.

RASGOS 2026:
- enunciados directos y técnicos;
- lectura atenta;
- comprensión real del contenido;
- relación entre datos o conceptos;
- aplicación práctica;
- situaciones operativas cuando la fuente las permita;
- cálculos cuando existan datos o fórmulas suficientes;
- alternativas plausibles y próximas entre sí;
- razonamiento basado exclusivamente en el temario.

RASGOS 2024:
- elevada precisión literal;
- atención a definiciones;
- cifras y unidades exactas;
- clasificaciones;
- límites;
- excepciones;
- procedimientos;
- pequeños matices del manual;
- referencias concretas al contenido cuando resulten naturales.

No fuerces una proporción matemática entre ambos estilos.
La forma de preguntar debe adaptarse al contenido.

==================================================
3. NIVEL DE EXIGENCIA
==================================================

El entrenamiento debe ser deliberadamente exigente y, cuando la fuente lo permita,
superior al nivel habitual de los exámenes oficiales de referencia.

La dificultad debe proceder de:
- precisión;
- dominio del contenido;
- discriminación entre conceptos próximos;
- comprensión;
- relación;
- aplicación;
- cálculo;
- secuencias;
- excepciones;
- condiciones;
- diferencias sutiles pero objetivas.

NUNCA aumentes dificultad mediante:
- ambigüedad;
- información ausente;
- trucos lingüísticos injustificados;
- redacción artificialmente confusa;
- distractores discutibles;
- conocimiento externo.

Una pregunta difícil debe seguir teniendo UNA respuesta inequívoca.

==================================================
4. COBERTURA Y DIVERSIDAD
==================================================

Antes de redactar, identifica mentalmente los conocimientos examinables presentes
en los fragmentos recuperados.

Considera especialmente:
- conceptos y subconceptos;
- definiciones;
- características;
- cifras;
- porcentajes;
- unidades;
- medidas;
- límites;
- intervalos;
- tablas;
- fórmulas;
- variables;
- clasificaciones;
- enumeraciones;
- procedimientos;
- secuencias;
- condiciones;
- excepciones;
- prohibiciones;
- medidas de seguridad;
- relaciones entre variables;
- actuaciones anteriores y posteriores.

Distribuye las preguntas entre conocimientos diferentes siempre que la fuente lo permita.

NO generes dentro del mismo test:
- dos preguntas equivalentes;
- paráfrasis de la misma pregunta;
- preguntas que solo cambien números arbitrariamente;
- preguntas que evalúen exactamente la misma memorización.

Un mismo apartado puede originar varias preguntas únicamente cuando cada una evalúe
una unidad de conocimiento o capacidad realmente diferente.

==================================================
5. TABLAS
==================================================

Cuando existan tablas, pueden evaluarse:
- valores;
- categorías;
- correspondencias;
- límites;
- intervalos;
- comparaciones;
- excepciones;
- relaciones entre filas o columnas;
- interpretaciones inequívocas derivadas directamente de la tabla.

No consideres una tabla agotada por preguntar un único dato.

Respeta exactamente sus cifras, unidades y condiciones.

==================================================
6. FÓRMULAS Y CÁLCULOS
==================================================

Cuando la fuente contenga información suficiente, pueden evaluarse:
- identificación de fórmula;
- significado de variables;
- unidades;
- relaciones entre magnitudes;
- despeje;
- aplicación numérica;
- interpretación del resultado;
- efecto objetivo de modificar una variable.

Todo cálculo debe resolverse exclusivamente mediante:
1. información proporcionada por la fuente;
2. datos incluidos legítimamente en el enunciado;
3. operaciones matemáticas necesarias.

No introduzcas constantes, reglas técnicas ni supuestos externos.

Los distractores numéricos pueden derivarse de errores razonables de cálculo,
unidades, operaciones o aplicación de la fórmula.
REPRESENTACIÓN DE FÓRMULAS, SÍMBOLOS Y NOTACIÓN CIENTÍFICA:

Toda fórmula, operación, magnitud, unidad, símbolo químico o expresión
científica debe escribirse como texto plano Unicode seguro, estándar y
directamente legible por el navegador.

La notación debe conservar fielmente la utilizada en la fuente cuando sea
relevante para responder correctamente.

NO utilices:
- LaTeX;
- MathML;
- comandos como \frac, \sqrt, \times, \cdot, \pi, \rho, \mu, etc.;
- delimitadores como $, $$, \( \), \[ \];
- caracteres decorativos o variantes tipográficas innecesarias;
- sustitutos visuales de un símbolo científico real.

OPERADORES Y SÍMBOLOS MATEMÁTICOS:

Utiliza directamente, cuando corresponda:

+  suma
-  resta
×  multiplicación
/  división
=  igualdad
≈  aproximadamente
<  menor que
>  mayor que
≤  menor o igual que
≥  mayor o igual que
±  más/menos
√  raíz cuadrada
%  porcentaje
°  grados
π  pi

Utiliza paréntesis ( ) siempre que sean necesarios para hacer inequívoco
el orden de las operaciones.

LETRAS GRIEGAS Y VARIABLES:

Cuando la fuente utilice letras griegas como símbolos de magnitudes,
coeficientes o variables, conserva el símbolo Unicode correspondiente.

Ejemplos de símbolos que pueden aparecer:

ρ  rho
μ  mu
η  eta
λ  lambda
Δ  delta mayúscula
δ  delta minúscula
α  alfa
β  beta
γ  gamma
θ  theta
φ  phi
ω  omega
Ω  omega mayúscula
Σ  sigma mayúscula
σ  sigma minúscula

Estos ejemplos NO constituyen una lista cerrada.
Puede utilizarse cualquier letra griega o símbolo científico estándar que
aparezca realmente en la fuente.

Nunca sustituyas automáticamente una letra griega por una letra latina
visualmente parecida si esa sustitución puede alterar el significado.

POTENCIAS, ÍNDICES Y NOTACIÓN EXPONENCIAL:

Para cuadrados y cubos pueden utilizarse:

m²
m³
v²

Para exponentes más complejos utiliza preferentemente notación ASCII clara:

x^4
d^5
10^-3
10^6

Si un subíndice es importante y puede representarse de forma segura, puede
utilizarse Unicode. Si existe riesgo de corrupción o ambigüedad, utiliza una
representación textual inequívoca, por ejemplo:

CO2
H2O
P1
P2

Nunca sacrifiques el significado científico por intentar reproducir una
tipografía especial.

RAÍCES:

La raíz cuadrada puede escribirse con √ cuando la expresión sea sencilla:

√25
√(a² + b²)

Si una raíz compleja pudiera resultar ambigua, utiliza una representación
textual inequívoca equivalente.

UNIDADES Y MAGNITUDES:

Conserva exactamente las unidades necesarias para resolver la pregunta.

Admite notación científica y técnica estándar como, entre otras:

m
m²
m³
s
kg
N
Pa
kPa
bar
J
W
V
A
Ω
S
Hz
°C
L
L/min
m/s
m/s²
kg/m³

La lista NO es cerrada. Utiliza cualquier unidad presente en la fuente y
respeta mayúsculas, minúsculas, exponentes, prefijos y símbolos cuando sean
relevantes.

QUÍMICA:

Los símbolos de los elementos químicos deben conservar su escritura estándar
y respetar mayúsculas y minúsculas:

H
O
C
N
Na
Cl
Fe
Ca

Las fórmulas químicas, estados de oxidación, cargas, valencias y demás
notación química deben reproducirse de forma inequívoca según la fuente.

Cuando un superíndice o subíndice Unicode pueda provocar problemas de
representación, utiliza una alternativa de texto plano que preserve
inequívocamente el significado.

No inventes elementos, valencias, cargas, fórmulas químicas ni propiedades:
todo contenido científico sigue sujeto a la fuente factual.

FÓRMULAS:

Las fracciones deben escribirse preferentemente mediante "/" y paréntesis
suficientes para conservar inequívocamente el orden de operaciones.

Ejemplos de representación:

Radio = perímetro / (2 × π)

Área = π × r²

ρ = m / V

v = distancia / tiempo

a = Δv / Δt

√(a² + b²)

La representación de una fórmula nunca debe introducir símbolos corruptos,
caracteres de sustitución como � ni secuencias de escape visibles.

COMPROBACIÓN FINAL:

Antes de devolver cualquier pregunta, opción, explicación o evidencia que
contenga notación matemática, física, química o técnica, comprueba que:

1. todos los símbolos son legibles;
2. no aparece el carácter �;
3. no quedan comandos LaTeX ni secuencias de escape;
4. la fórmula conserva inequívocamente su significado;
5. las unidades están correctamente representadas;
6. los exponentes, índices, cargas o valencias no han perdido significado;
7. la notación coincide con la fuente cuando esa notación sea examinable.

Si existe riesgo de que un carácter especial se represente incorrectamente,
utiliza una alternativa de texto plano más simple que conserve exactamente
el significado científico.
==================================================
7. PROCEDIMIENTOS Y CLASIFICACIONES
==================================================

En procedimientos considera, cuando proceda:
- material;
- acciones;
- orden;
- secuencia;
- condiciones;
- comprobaciones;
- límites;
- prohibiciones;
- excepciones;
- acciones previas;
- acciones posteriores;
- medidas de seguridad.

En enumeraciones y clasificaciones considera:
- identificación;
- pertenencia;
- exclusión;
- correspondencia;
- diferencias;
- características;
- número de elementos cuando tenga verdadero valor examinable.

==================================================
8. TIPOS DE PREGUNTA
==================================================

Utiliza una mezcla deliberada de familias de pregunta para reproducir de forma
más fiel la variedad observada en los exámenes oficiales de 2024 y 2026.

FAMILIAS PRIORITARIAS:

IDENTIFICACIÓN OBLIGATORIA DE FAMILIA:

Cada pregunta generada debe incluir el campo questionFamily.

questionFamily debe contener EXACTAMENTE uno de estos valores:

- "2026_CORRECTA"
- "2026_INCORRECTA"
- "2026_RAZONAMIENTO"
- "2024_NUMERICA"
- "2024_TEXTO"
- "CALCULO_FORMULACION"
- "GRAFICA"

El valor de questionFamily debe corresponder a la familia que realmente
cumple la pregunta, no únicamente a la familia que se intentó generar.

Para cualquier pregunta que NO pertenezca a la familia GRAFICA:
graphic debe ser null.

Para una pregunta de familia GRAFICA:
questionFamily debe ser "GRAFICA" y graphic debe contener una estructura
gráfica válida conforme al schema de salida.

No utilices ningún otro valor para questionFamily.

A. LITERAL / PRECISIÓN — ESTILO 2024

Las preguntas de esta familia reproducen el estilo literal y de precisión
característico del examen oficial de 2024.

En un bloque completo de 10 preguntas deben generarse TRES preguntas de esta
familia:

- DOS preguntas 2024_NUMERICA, siempre que la fuente contenga datos numéricos
  adecuados y suficientes.
- UNA pregunta 2024_TEXTO.

Las TRES son preguntas de estilo LITERAL 2024.
La diferencia entre NUMÉRICA y TEXTO se refiere únicamente al contenido
evaluado, NO al formato del enunciado.

FORMATO DEL ENUNCIADO:

Cuando el coverage item utilizado tenga manualPage disponible, utiliza la
estructura:

"Conforme al manual elaborado por el CEIS Guadalajara, [título o materia
identificable del manual], página X, ..."

X debe proceder EXCLUSIVAMENTE de manualPage.

NUNCA utilices sourcePage como número visible en el enunciado.
NUNCA calcules manualPage mediante offsets.
NUNCA inventes una página.
NUNCA inventes el título o materia del manual.

Si manualPage es null o no existe una referencia segura para construir esa
cita, formula una pregunta literal/precisa sin inventar la referencia de
página.

A1. 2024_NUMERICA

Debe evaluar literalmente un dato numérico presente en la fuente.

Prioriza, cuando existan:
- porcentajes;
- distancias;
- tiempos;
- ángulos;
- diámetros;
- longitudes;
- capacidades;
- límites;
- intervalos o rangos;
- cantidades;
- valores máximos o mínimos;
- unidades;
- cualquier otro dato numérico explícito y relevante del temario.

La respuesta correcta debe corresponder al dato exacto de la fuente.
VARIEDAD Y NIVEL DE LAS PREGUNTAS NUMÉRICAS:

No limites las preguntas numéricas al formato simple "¿cuál es el valor de X?".

Manteniendo siempre el carácter LITERAL 2024 y sin convertir la pregunta en
un ejercicio de cálculo, utiliza también, cuando la fuente lo permita:

- identificación de valores máximos o mínimos;
- límites superiores o inferiores;
- intervalos y rangos;
- porcentajes;
- distancias y separaciones;
- tiempos y duraciones;
- ángulos;
- diámetros, longitudes y otras dimensiones;
- capacidades y cantidades;
- unidades asociadas correctamente a una magnitud;
- correspondencia entre un dato numérico y el concepto, condición,
  procedimiento o situación al que pertenece;
- selección del dato exacto aplicable entre varios valores próximos
  presentes o plausibles dentro del mismo contexto técnico.

Cuando existan varios datos numéricos relacionados en la fuente, prioriza
preguntas que obliguen a distinguir con precisión cuál corresponde al
concepto o condición preguntados.

No conviertas esta mayor exigencia en razonamiento 2026 ni en
CÁLCULO/FORMULACIÓN: la respuesta de 2024_NUMERICA debe seguir estando
literalmente respaldada por el dato del manual.

Prioriza diversidad de datos. No reutilices el mismo dato numérico para
crear preguntas esencialmente equivalentes mientras existan otros
coverage_items numéricos adecuados sin trabajar.
Los distractores deben ser valores numéricos próximos y plausibles,
preferentemente del mismo orden de magnitud y con la misma unidad, de forma
que la pregunta exija conocer con precisión el dato del manual.

NO conviertas estas preguntas en ejercicios de cálculo salvo que la familia
asignada sea específicamente CÁLCULO/FORMULACIÓN.

NO preguntes repetidamente el mismo dato cambiando únicamente la redacción
mientras existan otros coverage_items numéricos sin trabajar.

Si no existen suficientes datos numéricos respaldados por la fuente, NO
inventes datos para cumplir esta cuota. La sustitución se realizará conforme
a las reglas de fallback del test.

A2. 2024_TEXTO

Debe evaluar de forma literal y precisa contenido textual del manual, por
ejemplo:
- definiciones;
- clasificaciones;
- enumeraciones;
- condiciones;
- procedimientos;
- secuencias;
- excepciones;
- características;
- relaciones expresamente establecidas en la fuente.

La respuesta correcta debe reproducir fielmente el significado del contenido
recuperado del temario.

Los distractores deben seguir siendo plausibles y próximos al contenido real,
pero sin alterar la literalidad factual de la respuesta correcta.

REGLA DE PÁGINA PARA TODA LA FAMILIA 2024:

Cuando se cite una página en el enunciado, dicha página debe ser manualPage.
La misma manualPage es la que debe conservarse como página visible de la fuente
en la corrección.

sourcePage es exclusivamente una referencia interna del PDF y NO debe
mostrarse al opositor como página del manual.

B. CORRECTA / INCORRECTA — ESTILO 2026

Estas preguntas pertenecen a la familia de RAZONAMIENTO / APLICACIÓN.
NO conviertas una pregunta literal o de reconocimiento directo en estilo 2026
limitándote a añadir "CORRECTA" o "INCORRECTA".

La resolución debe exigir comprender, aplicar, comparar, relacionar,
interpretar o discriminar información técnica del temario.

B1. 2026 — CORRECTA

Cuando la familia asignada sea 2026_CORRECTA:

- formula el enunciado para buscar la opción CORRECTA;
- construye las cuatro alternativas como afirmaciones completas,
  técnicamente desarrolladas y de complejidad semejante;
- EXACTAMENTE UNA de las cuatro afirmaciones debe ser correcta según la fuente;
- las otras TRES deben ser falsas pero técnicamente plausibles;
- las cuatro deben pertenecer al mismo campo conceptual;
- evita que la correcta pueda localizarse por simple reconocimiento,
  longitud, precisión de redacción o descarte superficial;
- cuando la fuente lo permita, exige aplicar una condición, comparar conceptos
  próximos, relacionar información o interpretar una situación técnica.

La diferencia entre la correcta y los distractores debe ser técnicamente
relevante y, especialmente en dificultad alta, preferentemente depender de
uno o pocos detalles discriminantes.

B2. 2026 — INCORRECTA

Cuando la familia asignada sea 2026_INCORRECTA:

- formula inequívocamente el enunciado para buscar la opción INCORRECTA;
- construye las cuatro alternativas como afirmaciones completas,
  técnicamente desarrolladas y de complejidad semejante;
- EXACTAMENTE TRES afirmaciones deben ser verdaderas según la fuente;
- EXACTAMENTE UNA debe ser falsa;
- la afirmación falsa debe ser SUTIL y técnicamente plausible;
- las cuatro deben pertenecer al mismo campo conceptual;
- evita falsedades grotescas, extremas o detectables por sentido común;
- cuando sea posible, crea la falsa modificando únicamente un detalle
  técnicamente decisivo de una afirmación próxima a la verdadera:
  cifra, unidad, límite, condición, categoría, término, relación,
  posición, paso o secuencia;
- la resolución debe exigir conocimiento del temario y razonamiento,
  no detectar una palabra delatora.

Antes de aceptar una 2026_INCORRECTA comprueba obligatoriamente:
1. que existen exactamente TRES afirmaciones verdaderas;
2. que existe exactamente UNA afirmación falsa;
3. que la falsa es la única respuesta válida a lo preguntado;
4. que no puede localizarse por tono, extremismo, longitud o redacción.

C. RAZONAMIENTO PURO / APLICACIÓN — ESTILO 2026

Cuando la familia asignada sea 2026_RAZONAMIENTO:

Esta pregunta NO debe adoptar obligatoriamente la estructura
"señale la CORRECTA" o "señale la INCORRECTA".

Debe exigir aplicar o relacionar conocimiento del temario mediante,
preferentemente:

- una situación técnica;
- un procedimiento;
- una decisión operativa;
- una relación entre conceptos;
- una comparación de condiciones;
- una consecuencia derivada de los datos disponibles;
- una selección de actuación;
- una interpretación técnica de información combinada.

Evita preguntas cuya respuesta pueda obtenerse localizando literalmente
una única frase del temario.

Cuando la fuente lo permita, combina DOS o más elementos relacionados del
mismo objetivo de cobertura o de información próxima recuperada por File Search.

La dificultad debe proceder de aplicar correctamente el conocimiento,
discriminar conceptos próximos o relacionar condiciones, NO de introducir
ambigüedad, información externa o supuestos no respaldados por la fuente.

Las cuatro alternativas deben ser técnicamente plausibles y competitivas.
La respuesta correcta debe depender exclusivamente del contenido recuperado
del temario.

REGLA COMÚN PARA LAS CINCO PREGUNTAS ESTILO 2026:

En un bloque completo de 10 preguntas, la distribución asignada a esta familia
debe producir:

- DOS preguntas 2026_CORRECTA;
- DOS preguntas 2026_INCORRECTA;
- UNA pregunta 2026_RAZONAMIENTO.

Las cinco deben evaluar razonamiento o aplicación.
Las cuatro CORRECTA/INCORRECTA NO cuentan como estilo 2026 si solo evalúan
memorización literal disfrazada mediante esas fórmulas de enunciado.

Si la fuente no permite construir de forma factual una situación compleja,
reduce la complejidad de la situación, pero NO inventes hechos, condiciones,
procedimientos ni relaciones ausentes del temario.

D. CÁLCULO / FORMULACIÓN

Cuando la familia asignada sea CALCULO_FORMULACION, la pregunta debe evaluar
la comprensión y aplicación de cálculos, fórmulas o relaciones entre
magnitudes expresamente respaldadas por el temario.

Esta familia NO exige necesariamente realizar una operación numérica.

Puede adoptar, cuando la fuente lo permita, cualquiera de estas formas:

- resolver un cálculo convencional;
- seleccionar la fórmula correcta aplicable a una situación;
- identificar qué magnitud permite calcular una fórmula;
- identificar las variables o magnitudes que intervienen en una fórmula;
- seleccionar un despeje correcto de una fórmula;
- reconocer la relación existente entre dos o más magnitudes;
- determinar cómo varía una magnitud cuando cambia otra, únicamente cuando
  esa relación esté respaldada por la fuente;
- seleccionar, entre varias fórmulas plausibles, cuál corresponde al
  problema o situación planteados;
- aplicar correctamente unidades, conversiones o equivalencias cuando
  formen parte del contenido del temario.

Las fórmulas deben representarse mediante notación Unicode/ASCII clara y
segura, manteniendo el sistema de representación matemática ya establecido.

La respuesta correcta y todos los datos necesarios para resolver la pregunta
deben estar respaldados por la información recuperada del temario.

NO introduzcas fórmulas, constantes, relaciones, conversiones, datos ni
procedimientos obtenidos de conocimiento externo.

Los distractores deben ser técnicamente plausibles. Cuando sea apropiado,
constrúyelos mediante:

- intercambio de variables;
- operadores incorrectos pero plausibles;
- despejes próximos pero erróneos;
- unidades o conversiones confundibles;
- fórmulas reales próximas recuperadas de la fuente;
- relaciones entre magnitudes invertidas o modificadas de forma sutil.

Debe existir UNA única respuesta inequívocamente correcta.

Si la fuente recuperada no contiene evidencia suficiente para construir una
pregunta válida de CÁLCULO/FORMULACIÓN, NO inventes contenido para cumplir la
cuota. Aplica las reglas de sustitución/fallback definidas para las familias
del test.
E. INTERPRETACIÓN GRÁFICA

Cuando la familia asignada sea GRAFICA, debe existir una REPRESENTACIÓN
TÉCNICA VISUAL REAL que sea necesaria para resolver la pregunta.

Una pregunta NO pertenece a la familia GRAFICA simplemente porque un contenido
textual pueda convertirse en cajas, círculos, nodos, flechas o conexiones.

CRITERIO FUNDAMENTAL:

El dibujo debe representar una configuración, forma, disposición, geometría,
recorrido, conexión, mecanismo o situación física/técnica que razonablemente
podría aparecer representada mediante un esquema o dibujo en un examen técnico.

La pregunta debe exigir conocimiento del temario para interpretar correctamente
esa representación.

Una persona que desconozca el contenido NO debe poder deducir fácilmente la
respuesta simplemente leyendo etiquetas, siguiendo flechas o interpretando
relaciones textuales evidentes.

SON USOS VÁLIDOS, CUANDO ESTÉN RESPALDADOS POR LA FUENTE:

- geometrías, formas y cortes técnicos;
- identificación de partes de un corte o configuración;
- comparación entre distintas configuraciones visuales;
- posición relativa de elementos;
- disposición espacial de equipos;
- recorrido físico de cuerdas, cables, conductos o flujos;
- sistemas de poleas y polipastos;
- conexiones eléctricas o hidráulicas;
- configuraciones serie/paralelo cuando estén respaldadas por el temario;
- esquemas de fuerzas;
- palancas, pistones u otros sistemas físicos;
- problemas de cálculo cuya geometría o disposición sea necesaria;
- ubicación relativa de equipos o elementos operativos;
- identificación de componentes mediante su posición o geometría;
- secuencias físicas representables visualmente;
- cualquier otra configuración técnica cuya representación gráfica aporte
  información imprescindible para resolver la pregunta.

EJEMPLOS DEL TIPO DE RAZONAMIENTO VISUAL BUSCADO:

Estos ejemplos describen FORMATOS posibles y NO aportan contenido factual.
Solo pueden utilizarse cuando el temario recuperado respalde realmente
los elementos y relaciones necesarios.

- representar gráficamente distintos tipos de cortes de tala y exigir
  identificar cuál corresponde al tipo preguntado;
- mostrar un corte sobre un tronco e identificar una parte, posición,
  orientación o geometría respaldada por el manual;
- representar un sistema de poleas o polipasto y exigir identificar su
  configuración o característica;
- representar varias disposiciones de equipos y preguntar cuál corresponde
  a la configuración descrita por el temario;
- representar un sistema físico necesario para resolver un problema de
  hidráulica, fuerzas u otra materia técnica;
- representar conexiones o disposiciones técnicas y exigir reconocer la
  configuración correcta.

PROHIBICIONES ABSOLUTAS:

NO generes como GRAFICA:

- mapas conceptuales;
- mapas mentales;
- organigramas creados a partir de conceptos;
- palabras o frases dentro de círculos o cajas unidas mediante líneas;
- diagramas que simplemente conviertan una enumeración textual en nodos;
- relaciones artificiales entre conceptos independientes;
- esquemas cuya información esencial esté escrita literalmente en las etiquetas;
- dibujos decorativos;
- gráficos que puedan eliminarse sin cambiar la forma de resolver la pregunta;
- jeroglíficos o representaciones abstractas creadas únicamente para cumplir
  la cuota de GRAFICA;
- representaciones cuya geometría, posición, conexión o relación técnica
  necesite inventarse porque no está respaldada por la fuente.

TEST DE NECESIDAD VISUAL:

Antes de aceptar una pregunta GRAFICA realiza mentalmente esta comprobación:

"Si elimino completamente graphic y dejo únicamente stem + options,
¿puede resolverse esencialmente igual?"

Si la respuesta es SÍ:
NO es una pregunta GRAFICA válida.

Aplica el fallback correspondiente.

TEST DE REALIDAD TÉCNICA:

Antes de generar graphic comprueba también:

1. ¿Existe en la fuente una forma, disposición, conexión, geometría,
   recorrido, mecanismo o relación espacial/física inequívoca que pueda
   representarse?
2. ¿El dibujo representa esa realidad técnica y no una relación conceptual
   inventada?
3. ¿La interpretación visual exige conocimiento del temario?
4. ¿El gráfico aporta información necesaria para discriminar la respuesta?
5. ¿Podría razonablemente utilizarse un dibujo de este tipo en una prueba
   técnica de oposición?

Si cualquiera de estas condiciones falla:
NO generes GRAFICA y aplica el fallback.

NO es obligatorio que la fuente contenga una imagen original.

Puede construirse un dibujo técnico a partir de una descripción textual
cuando la fuente determine de forma inequívoca la geometría, posición,
conexión, recorrido o relación física representada.

Está PROHIBIDO completar esa representación mediante conocimiento externo.

ESTRUCTURA DEL CAMPO graphic:

Para esta familia, graphic NO puede ser null.

graphic.type debe utilizar exclusivamente uno de estos valores:

- "technical"
- "geometry"
- "mechanism"
- "configuration"
- "circuit"
- "forces"

Selecciona el tipo que mejor describa la representación técnica.

graphic.title debe contener un título breve y neutral que NO revele
la respuesta.

graphic.elements debe contener las PRIMITIVAS GRÁFICAS necesarias para
construir el dibujo técnico.

Cada elemento debe incluir SIEMPRE todos estos campos:

- id
- shape
- label
- x
- y
- x2
- y2
- width
- height
- radius
- points

shape debe utilizar exclusivamente uno de estos valores:

- "line"
- "rect"
- "circle"
- "ellipse"
- "polygon"
- "polyline"
- "arrow"
- "text"

SIGNIFICADO DE LAS PRIMITIVAS:

"line":
línea recta técnica. Utiliza x, y como inicio y x2, y2 como final.

"rect":
elemento rectangular. Utiliza x, y como posición y width, height como
dimensiones.

"circle":
elemento circular, por ejemplo una polea o una sección circular cuando
proceda. Utiliza x, y como centro y radius como radio.

"ellipse":
elemento elíptico. Utiliza x, y como centro y width, height como dimensiones.

"polygon":
forma cerrada definida mediante points. Utilízala para cuñas, cortes,
perfiles u otras geometrías poligonales.

"polyline":
recorrido abierto definido mediante points. Utilízala cuando proceda para
cuerdas, cables, recorridos, conductos u otros trazados físicos.

"arrow":
flecha técnica para representar únicamente una dirección, sentido,
movimiento o fuerza respaldados por la fuente.
Utiliza x, y como origen y x2, y2 como destino.

"text":
texto breve necesario dentro del dibujo, especialmente identificadores
como A, B, C, D, 1, 2, 3, etc.
Utiliza x, y como posición.

COORDENADAS:

Todas las coordenadas y dimensiones deben expresarse en una escala
normalizada de 0 a 100.

Cuando un campo geométrico no sea aplicable a una determinada shape,
devuelve null.

Para points:
- utiliza [] cuando la shape no necesite puntos;
- cada punto debe contener x e y;
- todas sus coordenadas deben estar entre 0 y 100.

label:

- debe ser una cadena;
- utiliza "" cuando el elemento no necesite texto visible;
- evita etiquetas explicativas largas;
- NO escribas en label la respuesta ni la propiedad que el opositor
  debe identificar.

REGLAS DE CONSTRUCCIÓN:

- combina varias primitivas para construir un único dibujo técnico;
- NO representes cada concepto como un elemento independiente;
- NO utilices círculos o rectángulos como simples contenedores de texto;
- NO construyas mapas conceptuales;
- NO conviertas relaciones textuales en conexiones visuales artificiales;
- representa objetos, geometrías, posiciones, recorridos y configuraciones
  físicas mediante sus formas;
- utiliza "text" únicamente para referencias mínimas necesarias;
- una polea, por ejemplo, debe representarse mediante geometría circular y
  el recorrido físico de la cuerda, no mediante un círculo que contenga
  la palabra "polea";
- un corte debe representarse mediante líneas/polígonos que reproduzcan
  su geometría, no mediante una caja que contenga el nombre del corte;
- una conexión técnica debe representarse mediante líneas, recorridos o
  elementos físicos, no mediante nodos conceptuales unidos por flechas;
- pueden combinarse tantas primitivas como sean necesarias para que el
  dibujo resulte claro, pero evita elementos decorativos.

graphic ya NO utiliza el campo connections.
Toda relación visual debe quedar representada mediante las propias
primitivas de graphic.elements.

graphic.description debe describir objetivamente qué representa el dibujo
para permitir su validación, pero NO debe revelar la respuesta correcta.

COHERENCIA OBLIGATORIA:

- graphic debe contener toda la información visual necesaria;
- stem debe obligar realmente a interpretar graphic;
- las opciones deben evaluar el conocimiento técnico representado;
- debe existir UNA única respuesta correcta;
- la solución debe depender de la representación visual;
- toda geometría, posición, conexión, recorrido, medida, fuerza o relación
  técnica debe estar respaldada por la fuente;
- NO inventes elementos para hacer posible el dibujo.

Si la fuente no permite construir una representación técnica real,
factual, inequívoca y examinable:
NO generes una GRAFICA.

Aplica inmediatamente las reglas de sustitución/fallback del test.



REGLAS DE SUSTITUCIÓN / FALLBACK DE FAMILIAS:

La distribución objetivo debe respetarse siempre que el contenido factual
recuperado del temario permita construir preguntas válidas de cada familia.

La fidelidad a la fuente tiene PRIORIDAD ABSOLUTA sobre el cumplimiento
artificial de una cuota.

Para las familias GRAFICA y CALCULO_FORMULACION aplica este orden:

1. Distribución normal:
   - UNA pregunta GRAFICA.
   - UNA pregunta CALCULO_FORMULACION.

2. Si NO existe evidencia suficiente para construir una GRAFICA válida,
   pero sí existe contenido válido de cálculo o formulación:
   - genera DOS preguntas CALCULO_FORMULACION.

3. Si NO existe contenido válido para CALCULO_FORMULACION,
   pero sí existen DOS posibilidades gráficas válidas y suficientemente
   diferentes:
   - genera DOS preguntas GRAFICA.

4. Si NO existe contenido válido ni para GRAFICA ni para
   CALCULO_FORMULACION:
   - sustituye ambas por preguntas 2024_NUMERICA cuando existan datos
     numéricos suficientes y diferentes en la fuente.

5. Si tampoco existen suficientes datos numéricos:
   - utiliza 2024_TEXTO para las plazas restantes.

REGLAS OBLIGATORIAS DEL FALLBACK:

- NUNCA inventes gráficos, fórmulas, datos, relaciones o procedimientos para
  cumplir una cuota.
- NUNCA sacrifiques factualidad para mantener la distribución prevista.
- Las preguntas sustitutas deben seguir cumpliendo íntegramente las reglas
  de su questionFamily final.
- questionFamily debe reflejar SIEMPRE la familia realmente generada después
  de aplicar el fallback.
- Dos preguntas de la misma familia obtenidas mediante fallback deben evaluar
  contenidos suficientemente diferentes; evita duplicados o reformulaciones
  del mismo dato o concepto mientras existan alternativas válidas.
- La sustitución afecta únicamente a las plazas que no puedan cubrirse con
  evidencia suficiente; no altera innecesariamente las demás familias.

DISTRIBUCIÓN DEL TEST:

No permitas que todas las preguntas adopten la misma estructura.

Cuando count >= 5 y la fuente lo permita:
- incluye al menos UNA pregunta literal o de precisión estilo 2024;
- incluye al menos UNA pregunta formulada como INCORRECTA;
- incluye preguntas de comprensión, aplicación o razonamiento estilo 2026;
- completa el resto con las familias más adecuadas a los objetivos de cobertura.

Cuando count >= 10 y la fuente lo permita:
- incluye al menos DOS preguntas literales o de precisión estilo 2024;
- incluye al menos DOS preguntas CORRECTA/INCORRECTA, siendo al menos UNA
  de ellas INCORRECTA;
- conserva una presencia significativa de aplicación o razonamiento estilo 2026.

Estas reglas de distribución NO autorizan a inventar contenido ni a forzar una
familia incompatible con el objetivo de cobertura.

DIFICULTAD Y NIVEL DE DISCRIMINACIÓN:

Estas reglas se aplican transversalmente a TODAS las familias de preguntas,
respetando siempre las reglas específicas de cada familia.

En dificultad Alta:

- reduce al mínimo las preguntas resolubles por reconocimiento superficial;
- prioriza diferencias pequeñas pero técnicamente relevantes entre las opciones;
- cuando la fuente lo permita, enfrenta conceptos, condiciones, datos,
  procedimientos o categorías próximos entre sí;
- evita que una opción pueda descartarse únicamente por sentido común,
  redacción extraña, extremismo, falta de precisión o pertenecer claramente
  a otro campo conceptual;
- cuando la familia lo permita y la fuente aporte evidencia suficiente,
  combina o relaciona DOS o más elementos del contenido recuperado;
- exige aplicación, discriminación o precisión siempre que sea compatible
  con la familia asignada;
- una pregunta difícil NO debe ser ambigua: debe existir una única respuesta
  inequívocamente válida según la fuente;
- la dificultad debe proceder del dominio preciso del temario, NO de
  información externa, trampas lingüísticas, supuestos inventados o
  formulaciones confusas.

En preguntas 2024_NUMERICA, aumenta la dificultad principalmente mediante
distractores numéricos próximos, unidades plausibles y datos susceptibles
de confusión dentro del propio temario, manteniendo el carácter literal.

En preguntas 2024_TEXTO, aumenta la dificultad mediante alternativas
conceptualmente próximas y pequeñas diferencias de término, condición,
clasificación, secuencia o excepción, manteniendo el carácter literal.

En las familias 2026, aumenta la dificultad mediante aplicación,
comparación, relación de información y discriminación entre actuaciones
o afirmaciones técnicamente próximas.

En CÁLCULO/FORMULACIÓN y GRÁFICA, la dificultad debe proceder de interpretar
y aplicar correctamente la información disponible, nunca de datos ausentes
o supuestos no respaldados por la fuente.

OPCIONES DESARROLLADAS:

Cuando la pregunta evalúe CORRECTA/INCORRECTA, procedimientos, aplicación,
comparación o razonamiento, evita reducir sistemáticamente las opciones a
palabras o datos aislados.

Cuando la fuente lo permita, construye las cuatro alternativas como
afirmaciones completas, técnicamente plausibles y de complejidad semejante,
diferenciadas por uno o pocos elementos relevantes.

La dificultad debe proceder de distinguir el contenido técnico de las
alternativas, no de su longitud ni de pistas formales.

Antes de aceptar una pregunta negativa, comprueba especialmente que la polaridad
del enunciado y de las cuatro opciones sea inequívoca.
==================================================
9. OPCIONES Y DISTRACTORES — CALIDAD DE TRIBUNAL
==================================================

Cada pregunta tendrá EXACTAMENTE 4 opciones.
EXACTAMENTE UNA será correcta.

OBJETIVO PRINCIPAL:
Un opositor bien preparado NO debe poder localizar la respuesta correcta
por descarte superficial, por diferencias de redacción o porque los
distractores resulten evidentemente absurdos.

Las cuatro alternativas deben pertenecer al MISMO campo conceptual y
parecer razonables en una primera lectura.

CONSTRUCCIÓN PRIORITARIA DE DISTRACTORES:

Siempre que la fuente lo permita, construye cada distractor partiendo de
información REAL y próxima presente en el temario y modifica el MÍNIMO
elemento necesario para convertirla en falsa para ESA pregunta.

Prioriza, en este orden:

1. Sustituir una cifra por otra cifra próxima o por otra cifra real del
   mismo apartado, tabla o procedimiento.

2. Intercambiar límites, intervalos, porcentajes, unidades, magnitudes,
   categorías o valores pertenecientes a elementos próximos.

3. Sustituir UN término técnico por otro término real y próximo de la
   misma materia.

4. Alterar UNA condición de aplicación manteniendo correcto el resto de
   la alternativa.

5. Intercambiar dos pasos próximos de una secuencia o procedimiento.

6. Asignar correctamente una propiedad, valor, función o característica,
   pero al elemento, categoría o situación equivocada.

7. Utilizar una regla verdadera del temario en un contexto próximo en el
   que deja de ser aplicable.

8. En cálculos, utilizar resultados derivados de errores razonables:
   conversión incorrecta de unidades, operación invertida, omisión de un
   factor, aplicación de una fórmula próxima o error de orden de
   operaciones.

REGLA DE CAMBIO MÍNIMO:

Cuando sea posible, la diferencia entre la opción correcta y un
distractor debe reducirse a UNA variable discriminante:

- una cifra;
- una unidad;
- un término;
- una condición;
- una categoría;
- una posición;
- un paso;
- un signo;
- una relación;
- un límite.

Evita convertir toda la frase en falsa si basta modificar un único
elemento.

PLAUSIBILIDAD OBLIGATORIA:

Antes de aceptar cada distractor pregúntate internamente:

"¿Un opositor que conoce el tema de forma incompleta podría considerar
seriamente que esta opción es correcta?"

Si la respuesta es NO, descarta ese distractor y crea otro.

Los tres distractores deben ser inequívocamente falsos según la fuente,
pero la falsedad debe depender del CONOCIMIENTO DEL TEMARIO, no de pistas
lingüísticas.
PRUEBA DE COMPETITIVIDAD ENTRE ALTERNATIVAS:

No basta con que un distractor sea técnicamente falso. Debe ser una alternativa
competitiva y verosímil frente a la correcta.

Antes de aceptar definitivamente las cuatro opciones, compáralas entre sí como
si fueran presentadas a un opositor preparado que conoce el tema pero puede
confundir detalles próximos.

Para cada distractor exige simultáneamente:

- que pertenezca al mismo campo conceptual que la respuesta correcta;
- que conserve la mayor parte posible de la estructura factual de la correcta;
- que su falsedad dependa preferentemente de UN detalle discriminante;
- que ese detalle pueda confundirse razonablemente con otro dato, término,
  límite, condición, categoría, paso o relación próximo del temario;
- que no pueda descartarse sin conocer el contenido concreto preguntado;
- que no resulte más extraño, extremo, genérico o artificioso que la correcta.

En dificultad alta, intenta que al menos DOS distractores obliguen a discriminar
con precisión entre información muy próxima.

Cuando la fuente proporcione varios datos, categorías, pasos, límites,
propiedades o conceptos relacionados, utilízalos entre sí para construir
distractores antes de inventar modificaciones arbitrarias.

EJEMPLO DE CRITERIO, NO DE CONTENIDO:

Si la respuesta correcta depende de que un límite sea 25 %, son preferibles
como distractores otros porcentajes próximos o valores reales relacionados
presentes en el mismo contexto antes que cifras extremas sin relación.

Si la respuesta correcta identifica el paso 4 de un procedimiento, son
preferibles acciones pertenecientes realmente a los pasos 3, 5 o a una fase
próxima antes que una acción ajena al procedimiento.

Si la respuesta correcta asigna una propiedad al elemento A, es preferible
asignarle una propiedad real del elemento B próximo antes que inventar una
propiedad inexistente.

CONTROL FINAL DE DESCARTE:

Rechaza y reconstruye cualquier distractor si ocurre UNA de estas situaciones:

1. Puede descartarse por sentido común sin conocer el temario.
2. Contiene una exageración que delata su falsedad.
3. Introduce maquinaria, condiciones, cifras, materiales, procedimientos o
   conceptos sin apoyo próximo en la fuente únicamente para fabricar una falsa.
4. Su redacción es sensiblemente menos precisa o natural que la correcta.
5. La correcta destaca por ser la única opción moderada, completa o técnicamente
   bien redactada.
6. Dos distractores son esencialmente la misma falsa con palabras distintas.
7. El opositor podría eliminarlo antes de recordar el dato concreto evaluado.
FILTRO ANTI-DISTRACTOR OBVIO — OBLIGATORIO:

Antes de aceptar definitivamente una pregunta, realiza una segunda revisión
centrada EXCLUSIVAMENTE en detectar distractores artificiales o fáciles de
eliminar.

REGLA FUNDAMENTAL:
Un distractor NO es bueno simplemente porque sea falso.
Debe ser una respuesta que un opositor preparado pueda considerar plausible
si no recuerda con precisión el contenido evaluado.

PROHIBIDO crear distractores cuya falsedad resulte evidente por contener:

- cifras, porcentajes, potencias, distancias o unidades arbitrarias que no
  procedan de información próxima y real del temario;
- condiciones absurdamente restrictivas o absolutas introducidas únicamente
  para hacer falsa la opción;
- acciones manifiestamente improcedentes, peligrosas o ajenas al procedimiento
  cuando existen alternativas próximas en el propio temario;
- referencias irrelevantes al contexto preguntado;
- tecnicismos inventados o combinaciones artificiales de términos técnicos;
- expresiones delatoras como "exclusivamente", "obligatoriamente", "siempre",
  "nunca", "exactamente", "por completo" o equivalentes CUANDO se introduzcan
  artificialmente y permitan descartar la opción sin conocer el temario;
- detalles exagerados que hagan que una alternativa parezca mucho menos
  razonable que la correcta;
- datos externos o inventados que no sean necesarios para evaluar el concepto.

IMPORTANTE:
Las palabras absolutas NO están prohibidas cuando formen parte real del
contenido recuperado de la fuente o sean necesarias para reproducir fielmente
una regla del temario. Lo prohibido es utilizarlas artificialmente como pista
para fabricar una opción falsa.

PRIORIDAD PARA CONSTRUIR CADA DISTRACTOR:

1. Utilizar otro dato REAL y próximo del mismo apartado.
2. Intercambiar dos datos, categorías, condiciones o pasos reales próximos.
3. Modificar UNA sola variable discriminante de una afirmación verdadera.
4. Aplicar una regla verdadera a una situación próxima pero incorrecta.
5. Solo si la fuente no permite ninguna de las anteriores, crear una
   modificación mínima que siga siendo técnicamente plausible.

Si para crear un distractor necesitas inventar una circunstancia extravagante,
una cifra arbitraria o una afirmación obviamente absurda, NO utilices ese
distractor. Reformula la pregunta o utiliza otro aspecto del objetivo de
cobertura.

PRUEBA CIEGA FINAL:

Lee únicamente las cuatro opciones, ignorando momentáneamente cuál has marcado
como correcta.

Pregúntate:

"¿Puede localizarse la respuesta correcta por tono, sentido común, extremismo,
longitud, precisión, vocabulario o absurdo de las otras opciones, sin dominar
el contenido concreto del temario?"

Si la respuesta es SÍ, RECHAZA LA PREGUNTA COMPLETA y reconstrúyela.

En dificultad ALTA, intenta que al menos TRES de las cuatro opciones resulten
razonablemente defendibles en una primera lectura y que la resolución dependa
de identificar con precisión el dato, condición, relación, secuencia, fórmula
o excepción correcta del temario.

La dificultad debe provenir del CONOCIMIENTO, no de la confusión ni de la
invención.
OBJETIVO DE CALIDAD:

Idealmente, antes de recordar con precisión el dato del temario, un opositor
preparado debería poder dudar razonablemente entre la correcta y al menos DOS
distractores.

La dificultad debe proceder de discriminar conocimiento próximo, NO de
ambigüedad, redacción retorcida ni información externa.


PALABRAS DELATORAS:

No introduzcas artificialmente en los distractores expresiones absolutas
como:

"siempre", "nunca", "exclusivamente", "exactamente", "en cualquier caso",
"en cualquier especie", "sin excepción", "únicamente", "obligatoriamente",
"estándar absoluto", "en todos los casos".

Solo pueden aparecer cuando esa expresión absoluta esté realmente
justificada por la fuente o cuando el estilo oficial analizado muestre que
es necesaria para evaluar una distinción concreta.

No utilices una palabra absoluta como mecanismo barato para convertir una
opción en falsa.

SIMETRÍA ENTRE OPCIONES:

Las cuatro alternativas deben mantener, en la medida de lo posible:

- longitud semejante;
- estructura gramatical semejante;
- grado de precisión semejante;
- número parecido de datos y condiciones;
- terminología del mismo nivel técnico.

No permitas que la forma de la respuesta revele cuál es correcta.

DIFICULTAD ALTA:

Si difficulty = "alta", aumenta la dificultad mediante PROXIMIDAD entre
alternativas, integración de conceptos próximos, discriminación de
condiciones, secuencias, cifras o cálculos.

NO aumentes la dificultad haciendo el enunciado artificialmente largo,
rebuscado o ambiguo.

En dificultad alta, al menos DOS de los tres distractores deben ser
especialmente próximos a la respuesta correcta y exigir conocer con
precisión el dato, condición, procedimiento o relación evaluada.
REGLAS ADICIONALES PARA DIFICULTAD ALTA:

La dificultad ALTA debe exigir discriminación técnica, aplicación o
relación de conocimientos; no debe equivaler simplemente a una pregunta
más detallada.

- En preguntas de aplicación o razonamiento estilo 2026, cuando la fuente
  lo permita, exige relacionar DOS O MÁS elementos recuperados del temario.

- Cuando sea viable, plantea primero una situación o escenario en el que
  el opositor deba identificar QUÉ regla, condición, procedimiento,
  relación o fórmula resulta aplicable antes de resolver la pregunta.

- En preguntas de cálculo, cuando la fuente lo permita, evita limitarte
  a sustituir directamente un único dato en una fórmula. Exige seleccionar
  los datos o la fórmula pertinentes y, cuando sea viable, realizar MÁS
  DE UNA operación.

- En preguntas formuladas como INCORRECTA, construye TRES afirmaciones
  verdaderas, técnicamente próximas y difíciles de descartar; la respuesta
  debe ser la ÚNICA afirmación falsa.

- En preguntas formuladas como CORRECTA, construye TRES afirmaciones falsas
  técnicamente próximas a la verdadera y evita falsedades caricaturescas
  o detectables por sentido común.

- En preguntas literales o de precisión estilo 2024, incrementa la
  dificultad mediante datos, términos, límites, condiciones o confusores
  próximos presentes en la fuente. NO la incrementes mediante redacción
  enrevesada, ambigua o artificialmente extensa.

Estas exigencias se aplican solo cuando la información recuperada permita
construirlas sin inventar contenido ni introducir conocimiento externo.

ESTILO DE REDACCIÓN:

Redacta de forma natural, sobria y administrativa, como un tribunal de
oposición.

Evita introducciones artificiales o innecesariamente grandilocuentes como:

"Conforme a los datos teóricos..."
"Atendiendo a los conocimientos generales..."
"En virtud de las consideraciones conceptuales..."

No añadas contexto verbal que no contribuya a evaluar conocimiento.

Usa las fórmulas de pregunta observadas en la referencia oficial cuando
resulten naturales, sin repetir mecánicamente la misma estructura.

"Ninguna de las anteriores" y "Todas las anteriores" deben ser
excepcionales y solo utilizarse cuando estén justificadas por la
estructura de la pregunta, nunca como recurso para fabricar dificultad.

==================================================
10. POSICIÓN DE LA RESPUESTA
==================================================

La posición de la respuesta correcta debe comportarse de forma NATURAL y no
seguir un patrón artificialmente equilibrado.

Asigna correctIndex entre 0, 1, 2 y 3 sin favorecer sistemáticamente ninguna
posición.

NO intentes repartir las respuestas correctas de forma perfectamente uniforme
dentro de cada test. Un examen real puede contener de forma natural varias
respuestas correctas consecutivas en la misma posición.

Por tanto, son admisibles rachas ocasionales de 2, 3 o incluso 4 respuestas
correctas consecutivas en una misma letra, así como distribuciones desiguales
dentro de un test concreto.

Lo que debe evitarse es un SESGO RECURRENTE entre tests: que una misma posición
aparezca como correcta de forma anormalmente frecuente o que se reproduzcan
repetidamente secuencias similares.

No construyas patrones artificiales como A-B-C-D-A-B-C-D ni fuerces una
cantidad idéntica de A, B, C y D.

La secuencia debe parecer compatible con una distribución aleatoria natural:
puede contener agrupaciones y rachas, pero no debe presentar una preferencia
deliberada por ninguna posición.

La posición de la respuesta correcta nunca debe influir en la redacción,
longitud, precisión o apariencia de las alternativas.

==================================================
11. EXPLICACIÓN Y CORRECCIÓN
==================================================

Para CADA pregunta, explanation debe funcionar como una corrección pedagógica
completa y útil para el estudio.

OBJETIVO:
Después de responder una pregunta, el opositor debe poder comprender qué
conocimiento concreto determina la respuesta correcta y qué error conceptual,
numérico, procedimental o de interpretación existe en las alternativas
incorrectas, sin necesidad de volver inmediatamente al documento.

La explicación debe:

1. Explicar de forma directa por qué la respuesta correcta es correcta.

2. Identificar el dato, definición, regla, relación, fórmula, clasificación,
   condición, límite, procedimiento o razonamiento concreto que determina
   la solución.

3. Explicar brevemente por qué CADA una de las otras alternativas es incorrecta
   SI la información recuperada de la fuente permite demostrarlo de forma
   inequívoca.

4. Cuando un distractor proceda de confundir dos datos, conceptos, categorías,
   pasos, límites o propiedades reales del temario, indicar específicamente
   cuál es la confusión.

5. En preguntas numéricas o de cálculo, mostrar el razonamiento u operación
   necesaria para obtener el resultado correcto cuando sea útil para comprender
   la solución.

6. En preguntas de secuencias o procedimientos, indicar qué paso, posición,
   condición o actuación hace incorrecta cada alternativa cuando la fuente
   permita determinarlo.

7. En preguntas con formulación CORRECTA, INCORRECTA o NO, explicar la solución
   respetando explícitamente la polaridad del enunciado para evitar una
   corrección confusa.

REGLA DE FIDELIDAD:

Toda afirmación incluida en explanation debe estar respaldada exclusivamente
por la información factual recuperada del temario.

NO inventes una explicación para justificar un distractor.

Si la fuente permite demostrar que una alternativa es incorrecta pero no
permite determinar con seguridad qué concepto concreto representa, limita la
explicación a señalar la contradicción demostrable.

Si la fuente NO permite justificar inequívocamente por qué una alternativa es
incorrecta, no inventes información para explicarla.

FORMATO:

Redacta explanation como un texto compacto y claro.

Cuando resulte útil para distinguir las alternativas, puedes identificar
explícitamente A), B), C) y D).

Ejemplo de estructura:

"La correcta es B porque [...]. A es incorrecta porque [...]. C confunde [...]
con [...]. D es incorrecta porque [...]."

No es obligatorio utilizar exactamente esta redacción ni convertir todas las
explicaciones en una enumeración mecánica.

Prioriza claridad y utilidad para el estudio.

EVITA:

- limitarte a repetir literalmente la opción correcta;
- escribir únicamente "según el temario, la correcta es...";
- explicar solo la correcta cuando la fuente permite justificar también los
  distractores;
- introducir conocimiento externo para completar una explicación;
- convertir la corrección en un texto innecesariamente largo;
- atribuir a un distractor un significado que la fuente no permita demostrar.

La explicación debe conservar las cifras, unidades, condiciones, términos
técnicos y matices necesarios para comprender exactamente la solución.

==============================================
12. EVIDENCIA Y PÁGINA
==============================================

sourceEvidence debe contener una evidencia breve, fiel y suficiente del contenido
recuperado que sustenta la respuesta.

No inventes una cita ni atribuyas al documento palabras que no estén respaldadas.

sourcePage:
- representa exclusivamente la página física del archivo PDF;
- se utiliza únicamente como referencia interna para localizar el contenido;
- NO debe utilizarse como número de página visible para el opositor;
- nunca deduzcas a partir de sourcePage la numeración impresa del manual.

manualPage:
- representa exclusivamente el número de página impreso en el pie de página del propio manual;
- utiliza el valor proporcionado por el objetivo de cobertura cuando esté disponible;
- este es el número que debe utilizarse en referencias visibles del tipo "página X";
- si no puede determinarse con seguridad, devuelve null;
- nunca calcules manualPage aplicando un desplazamiento u offset a sourcePage;
- nunca inventes una página.
==================================================
13. CONTROL DE CALIDAD INTERNO
==================================================

ANTES DE DEVOLVER EL TEST, revisa internamente CADA pregunta.

Comprueba:

A. ¿Todo el conocimiento necesario procede de la fuente?
B. ¿Existe exactamente una respuesta correcta?
C. ¿Los otros tres distractores son realmente falsos?
D. ¿Existe alguna interpretación alternativa razonable?
E. ¿Las cifras, unidades y límites coinciden con la fuente?
F. ¿La polaridad CORRECTA/INCORRECTA/NO está bien resuelta?
G. ¿sourceEvidence demuestra realmente la respuesta?
H. ¿sourcePage está sustentada o debe ser null?
I. ¿La explicación permite comprender la solución?
J. ¿La pregunta repite esencialmente otra del mismo test?
K. ¿Hay alguna pista formal que delate la respuesta correcta?
L. ¿Se ha introducido conocimiento externo?

Si una pregunta falla UNA SOLA de estas comprobaciones:
DESCÁRTALA y sustitúyela antes de devolver el resultado.

==================================================
14. REGLA FINAL
==================================================

Devuelve EXACTAMENTE ${count} preguntas válidas.

Prioridades, en este orden:

1. Fidelidad absoluta al temario.
2. Una única respuesta inequívocamente correcta.
3. Calidad técnica y defendibilidad.
4. Nivel de exigencia alto.
5. Estilo tribunal 2024/2026, con predominio del enfoque 2026.
6. Cobertura y diversidad.
7. Calidad de los distractores.
8. Utilidad de la explicación para estudiar el error.

Nunca sacrifiques exactitud para aumentar dificultad o variedad.`;
}
async function getOfficialExamStyleReference(){
  if(!EXAM_STYLE_STORE){
    await loadExamStyleStore();
  }

  if(!EXAM_STYLE_STORE){
    throw new Error("No está disponible el almacén de estilo de los exámenes oficiales.");
  }

  const ai = aiClient();

  const prompt = `
Analiza los exámenes oficiales de Bomberos de Navarra contenidos en este File Search Store.

IMPORTANTE:
Estos documentos NO son fuente factual del temario.
NO debes extraer de ellos conocimientos para decidir cuál es la respuesta correcta de una pregunta futura.
Su única función es servir como REFERENCIA DE ESTILO DEL TRIBUNAL.

Analiza conjuntamente los modelos oficiales 2024 y 2026, dando MAYOR PESO al estilo observado en 2026 y conservando los rasgos útiles de 2024.

Extrae exclusivamente características de estilo útiles para generar nuevos test:

1. Forma de redactar los enunciados.
2. Longitud habitual de preguntas y respuestas.
3. Estructura gramatical.
4. Uso de preguntas directas.
5. Uso de CORRECTA, INCORRECTA, NO, etc.
6. Forma de plantear cálculos.
7. Forma de plantear situaciones prácticas.
8. Forma de preguntar procedimientos y secuencias.
9. Forma de preguntar cifras, límites, clasificaciones y definiciones.
10. Construcción de distractores.
11. Similitud y equilibrio entre las cuatro opciones.
12. Nivel de sutileza de los distractores.
13. Uso de cambios mínimos de términos, cifras, unidades, orden o condiciones.
14. Grado de razonamiento exigido.
15. Patrones que puedan delatar artificialmente la respuesta correcta y que deban evitarse.
16. Diferencias relevantes entre el estilo 2024 y 2026.
17. Rasgos del modelo 2026 que deberían predominar en nuevos test.
18. Cualquier otro patrón formal recurrente útil para reproducir fielmente el estilo del tribunal.

REGLAS ABSOLUTAS:

- NO conviertas ninguna respuesta de los exámenes en conocimiento factual.
- NO indiques qué opción era correcta en ninguna pregunta oficial.
- NO uses datos concretos de los exámenes como fuente de verdad.
- NO sustituyas nunca el temario por estos documentos.
- Describe PATRONES DE REDACCIÓN Y CONSTRUCCIÓN, no contenido factual.
- El resultado debe poder utilizarse como guía de estilo para crear preguntas nuevas a partir de otra fuente documental independiente.

Devuelve una guía de estilo compacta pero suficientemente precisa para que otro modelo pueda reproducir el estilo del tribunal.
`;

  const response = await ai.models.generateContent({
    model:"gemini-3.5-flash-lite",
    contents:prompt,
    config:{
      tools:[
        {
          fileSearch:{
            fileSearchStoreNames:[EXAM_STYLE_STORE]
          }
        }
      ]
    }
  });

  const text = response.text?.trim();

  if(!text){
    throw new Error("No se pudo obtener la referencia de estilo de los exámenes oficiales.");
  }

  return text;
}
async function getCachedOfficialExamStyleReference(){
  const cached = await db.query(
    "SELECT value FROM app_state WHERE key=$1 LIMIT 1",
    ["official_exam_style_reference"]
  );

  if(cached.rows.length && cached.rows[0].value?.trim()){
    console.log("OFFICIAL STYLE: referencia recuperada de PostgreSQL");
    return cached.rows[0].value;
  }

  console.log("OFFICIAL STYLE: no existe caché; obteniendo referencia desde File Search");

  const styleReference = await getOfficialExamStyleReference();

  await db.query(`
    INSERT INTO app_state (key,value)
    VALUES ($1,$2)
    ON CONFLICT (key)
    DO UPDATE SET value=EXCLUDED.value
  `,[
    "official_exam_style_reference",
    styleReference
  ]);

  console.log("OFFICIAL STYLE: referencia guardada en PostgreSQL");

  return styleReference;
}
app.post("/api/analyze-coverage", async(req,res)=>{
  try{
    if(!STORE) throw new Error("Primero indexa el PDF.");

    const ai=aiClient();

    console.log("COVERAGE: iniciando análisis");

    const pdfPath=path.resolve("data/apeo-poda.pdf");

if(!fs.existsSync(pdfPath)){
  throw new Error("No se encuentra el PDF para analizar.");
}

const {totalPages,chunks}=await splitPdfIntoChunks(pdfPath,5);

console.log(
  `COVERAGE: ${totalPages} páginas divididas en ${chunks.length} bloques`
);

const allItems=[];

for(const chunk of chunks){
  console.log(
    `COVERAGE: analizando páginas ${chunk.startPage}-${chunk.endPage}`
  );

  const response=await ai.models.generateContent({
    model:"gemini-3.5-flash-lite",
    contents:[
      {
        text:
          coverageAnalysisPrompt()+
          `

IMPORTANTE:
Estás analizando únicamente las páginas ${chunk.startPage} a ${chunk.endPage}
del documento original.

Analiza exhaustivamente TODO el contenido de estas páginas.
No omitas tablas, cifras, fórmulas, clasificaciones, procedimientos,
excepciones, definiciones ni elementos gráficos con contenido examinable.

Cuando indiques sourcePage, utiliza exclusivamente el número de página física del PDF original, dentro del rango ${chunk.startPage} a ${chunk.endPage}. Este dato es interno.

Cuando indiques manualPage, utiliza exclusivamente el número de página impreso que aparece en el pie de página del propio manual. Debes leerlo directamente de la página. No lo deduzcas a partir de sourcePage ni calcules ningún desplazamiento. Si no puede identificarse con seguridad, devuelve null.
`
      },
      {
        inlineData:{
          mimeType:"application/pdf",
          data:chunk.data
        }
      }
    ],
    config:{
      responseMimeType:"application/json",
      responseJsonSchema:coverageSchema
    }
  });

  const parsedChunk=JSON.parse(response.text);

  if(!parsedChunk.items || !Array.isArray(parsedChunk.items)){
    throw new Error(
      `El bloque ${chunk.startPage}-${chunk.endPage} no devolvió elementos válidos.`
    );
  }

  allItems.push(...parsedChunk.items);

  console.log(
    `COVERAGE: páginas ${chunk.startPage}-${chunk.endPage} completadas: ${parsedChunk.items.length} elementos`
  );
}

console.log(
  `COVERAGE: todos los bloques completados. Total bruto: ${allItems.length}`
);
console.log("COVERAGE AUDIT: iniciando segunda pasada para detectar omisiones");

const auditItems=[];

for(const chunk of chunks){
  const existingChunkItems=allItems.filter(item=>
    Number(item.sourcePage)>=chunk.startPage &&
    Number(item.sourcePage)<=chunk.endPage
  );

  console.log(
    `COVERAGE AUDIT: revisando páginas ${chunk.startPage}-${chunk.endPage}`
  );

  try{
    const auditResponse=await ai.models.generateContent({
      model:"gemini-3.6-flash",
      contents:[
        {
          text:coverageGapPrompt(
            existingChunkItems.map(item=>({
              concept:item.concept,
              item_type:item.itemType,
              evaluation_type:item.evaluationType,
              source_page:item.sourcePage
            })),
            chunk.startPage,
            chunk.endPage
          )
        },
        {
          inlineData:{
            mimeType:"application/pdf",
            data:chunk.data
          }
        }
      ],
      config:{
        responseMimeType:"application/json",
        responseJsonSchema:coverageSchema
      }
    });

    const parsedAudit=JSON.parse(auditResponse.text);

    if(parsedAudit.items && Array.isArray(parsedAudit.items)){
      auditItems.push(...parsedAudit.items);

      console.log(
        `COVERAGE AUDIT: páginas ${chunk.startPage}-${chunk.endPage}: ${parsedAudit.items.length} omisiones detectadas`
      );
    }

  }catch(e){
    console.warn(
      `COVERAGE AUDIT: páginas ${chunk.startPage}-${chunk.endPage} no auditadas por error temporal: ${e.message}`
    );
  }
}

allItems.push(...auditItems);

console.log(
  `COVERAGE AUDIT: completada. Añadidos ${auditItems.length} elementos. Total: ${allItems.length}`
);
const deduplicatedItems=deduplicateCoverageItems(allItems);

console.log(
  `COVERAGE: deduplicación exacta/normalizada: ${allItems.length} -> ${deduplicatedItems.length}`
);

const parsed={
  items:deduplicatedItems
};

    if(!parsed.items || !Array.isArray(parsed.items) || parsed.items.length===0){
      throw new Error("Gemini no devolvió elementos de cobertura.");
    }

    const validItems=parsed.items.filter(item=>
      item &&
      typeof item.concept==="string" &&
      item.concept.trim() &&
      typeof item.itemType==="string" &&
      typeof item.evaluationType==="string" &&
      typeof item.sourceEvidence==="string" &&
      item.sourceEvidence.trim()
    );

    if(validItems.length===0){
      throw new Error("El análisis no contiene elementos de cobertura válidos.");
    }

    const topic=await getOrCreateTopic(
      "Apeo y poda de arbolado",
      "apeo-poda.pdf"
    );

    await saveCoverageItems(topic.id,validItems);

    const result=await db.query(
      `SELECT
         t.id,
         t.name,
         t.total_items,
         COUNT(c.id) FILTER (WHERE c.worked = TRUE)::int AS worked_items,
         COUNT(c.id) FILTER (WHERE c.worked = FALSE)::int AS pending_items
       FROM topics t
       LEFT JOIN coverage_items c ON c.topic_id = t.id
       WHERE t.id = $1
       GROUP BY t.id`,
      [topic.id]
    );

    const summary=result.rows[0];

    const total=Number(summary.total_items)||0;
    const worked=Number(summary.worked_items)||0;

    const coveragePercentage=
      total>0
        ? Number(((worked/total)*100).toFixed(1))
        : 0;

    console.log(
      "COVERAGE: análisis guardado:",
      total,
      "elementos"
    );

    res.json({
      ok:true,
      topicId:summary.id,
      topic:summary.name,
      totalItems:total,
      workedItems:worked,
      pendingItems:Number(summary.pending_items)||0,
      coveragePercentage
    });

  }catch(e){
    console.error("ERROR COVERAGE:",e);

    res.status(500).json({
      ok:false,
      error:e?.message || String(e)
    });
  }
});
app.post("/api/repair-manual-pages", async(req,res)=>{
  try{
    const pdfPath=path.resolve("data/apeo-poda.pdf");

    if(!fs.existsSync(pdfPath)){
      throw new Error("No se encuentra apeo-poda.pdf.");
    }

    const topicResult=await db.query(
      `SELECT id, name
       FROM topics
       WHERE name=$1
       LIMIT 1`,
      ["Apeo y poda de arbolado"]
    );

    if(!topicResult.rows.length){
      throw new Error(
        "No existe la cobertura de Apeo y poda de arbolado."
      );
    }

    const topic=topicResult.rows[0];
    const ai=aiClient();

    console.log("PAGE MAP: iniciando reparación");

    const {totalPages,chunks}=
      await splitPdfIntoChunks(pdfPath,5);

    const pageMap=
      await extractManualPageMap(ai,chunks);

    if(pageMap.length!==totalPages){
      throw new Error(
        `El mapa debía contener ${totalPages} páginas y contiene ${pageMap.length}.`
      );
    }

    const updatedRows=
      await applyManualPageMapToTopic(
        topic.id,
        pageMap
      );

    const remainingResult=await db.query(
      `SELECT COUNT(*)::int AS total
       FROM coverage_items
       WHERE topic_id=$1
       AND manual_page IS NULL`,
      [topic.id]
    );

    console.log(
      "PAGE MAP: reparación completada",
      updatedRows,
      "registros actualizados"
    );

    res.json({
      ok:true,
      topic:topic.name,
      totalPdfPages:totalPages,
      pageMap,
      updatedRows,
      remainingWithoutManualPage:
        remainingResult.rows[0].total
    });

  }catch(e){
    console.error(
      "ERROR REPAIR MANUAL PAGES:",
      e
    );

    res.status(500).json({
      ok:false,
      error:e?.message || String(e)
    });
  }
});
app.get("/api/coverage-semantic-audit", async(req,res)=>{
  try{
    const topicResult=await db.query(`
      SELECT id, name
      FROM topics
      WHERE name = $1
      LIMIT 1
    `,["Apeo y poda de arbolado"]);

    if(!topicResult.rows.length){
      throw new Error("No se encontró el tema Apeo y poda de arbolado.");
    }

    const topic=topicResult.rows[0];

    const result=await db.query(`
      SELECT *
      FROM coverage_items
      WHERE topic_id = $1
      ORDER BY source_page, id
    `,[topic.id]);

    const items=result.rows.map(row=>({
      id:row.id,
      section:row.section,
      concept:row.concept,
      itemType:row.item_type,
      evaluationType:row.evaluation_type,
      sourcePage:row.source_page,
      sourceEvidence:row.source_evidence,
      worked:row.worked
    }));

    const groups=await semanticDeduplicateCoverageItems(items);
const approvedGroups=await validateSemanticDuplicateGroups(items,groups);
const decisions=await finalDuplicateDecision(items,approvedGroups);

const deleteDecisions=decisions.filter(
  d=>d.decision==="DELETE" &&
     String(d.uniqueCandidateKnowledge ?? "").trim()===""
);

const keepDecisions=decisions.filter(
  d=>d.decision!=="DELETE" ||
     String(d.uniqueCandidateKnowledge ?? "").trim()!==""
);
    res.json({
      ok:true,
      topic:topic.name,
      totalItems:items.length,
      candidateGroups:groups.length,
approvedGroups:approvedGroups.length,
pairDecisions:decisions.length,
safeDeletes:deleteDecisions.length,
keptCandidates:keepDecisions.length,
deleteDecisions
    });

  }catch(e){
    console.error("ERROR SEMANTIC COVERAGE AUDIT:",e);

    res.status(500).json({
      ok:false,
      error:e?.message||String(e)
    });
  }
});
app.post("/api/coverage-deduplicate", async(req,res)=>{
  try{
    const topicResult=await db.query(`
      SELECT id, name
      FROM topics
      WHERE name = $1
      LIMIT 1
    `,["Apeo y poda de arbolado"]);

    if(!topicResult.rows.length){
      throw new Error("No se encontró el tema Apeo y poda de arbolado.");
    }

    const topic=topicResult.rows[0];

    const result=await db.query(`
      SELECT *
      FROM coverage_items
      WHERE topic_id = $1
      ORDER BY id
    `,[topic.id]);

    const original=result.rows;

    const mapped=original.map(row=>({
      id:row.id,
      section:row.section,
      concept:row.concept,
      itemType:row.item_type,
      evaluationType:row.evaluation_type,
      sourcePage:row.source_page,
      sourceEvidence:row.source_evidence,
      worked:row.worked
    }));

    const unique=deduplicateCoverageItems(mapped);

    const keepIds=new Set(
      unique
        .map(item=>item.id)
        .filter(id=>id!==undefined && id!==null)
    );

    const deleteIds=original
      .map(row=>row.id)
      .filter(id=>!keepIds.has(id));

    if(deleteIds.length){
      await db.query(
        `DELETE FROM coverage_items
         WHERE topic_id = $1
         AND id = ANY($2::int[])`,
        [topic.id,deleteIds]
      );
    }

    const countResult=await db.query(
      `SELECT COUNT(*)::int AS total
       FROM coverage_items
       WHERE topic_id = $1`,
      [topic.id]
    );

    const finalTotal=countResult.rows[0].total;

    await db.query(
      `UPDATE topics
       SET total_items = $1
       WHERE id = $2`,
      [finalTotal,topic.id]
    );

    res.json({
      ok:true,
      topic:topic.name,
      before:original.length,
      removed:deleteIds.length,
      after:finalTotal
    });

  }catch(e){
    console.error("ERROR COVERAGE DEDUPLICATE:",e);
    res.status(500).json({
      ok:false,
      error:e?.message||String(e)
    });
  }
});
app.get("/api/coverage-audit", async(req,res)=>{
  try{
    const topic=await getOrCreateTopic(
      "Apeo y poda de arbolado",
      "apeo-poda.pdf"
    );

    const result=await db.query(
      `SELECT
        id,
        section,
        concept,
        item_type,
        evaluation_type,
        source_page,
        source_evidence,
        worked
      FROM coverage_items
      WHERE topic_id = $1
      ORDER BY source_page ASC NULLS LAST, id ASC`,
      [topic.id]
    );

    res.json({
      ok:true,
      topic:topic.name,
      total:result.rows.length,
      items:result.rows
    });

  }catch(e){
    console.error("ERROR COVERAGE AUDIT:",e);

    res.status(500).json({
      ok:false,
      error:e?.message || String(e)
    });
  }
});
async function getCoverageTargetsForGeneration(count){
  const result=await db.query(`
    SELECT
      ci.id,
      ci.section,
      ci.concept,
      ci.item_type,
      ci.evaluation_type,
      ci.source_page,
      ci.manual_page,
      ci.source_evidence
    FROM coverage_items ci
    JOIN topics t ON t.id = ci.topic_id
    WHERE ci.worked = FALSE
    ORDER BY RANDOM()
    LIMIT $1
  `,[count]);

  const families = buildQuestionFamilyPlan(count);

return result.rows.map((item,index)=>({
  ...item,
  questionFamily: families[index] || "GENERAL"
}));
}
function shuffleArray(items){
  const shuffled = [...items];

  for(let i = shuffled.length - 1; i > 0; i--){
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }

  return shuffled;
}

function buildQuestionFamilyPlan(count){
  const baseBlock = [
    "2026_CORRECTA",
    "2026_CORRECTA",
    "2026_INCORRECTA",
    "2026_INCORRECTA",
    "2026_RAZONAMIENTO",
    "2024_NUMERICA",
    "2024_NUMERICA",
    "2024_TEXTO",
    "CALCULO_FORMULACION",
    "GRAFICA"
  ];

  const plansByCount = {
    5: [
      "2026_CORRECTA",
      "2026_INCORRECTA",
      "2026_RAZONAMIENTO",
      "2024_TEXTO",
      "CALCULO_FORMULACION"
    ],
    10: baseBlock,
    20: [...baseBlock, ...baseBlock],
    40: [...baseBlock, ...baseBlock, ...baseBlock, ...baseBlock]
  };

  const plan = plansByCount[count];

  if(!plan){
    throw new Error(`Cantidad de preguntas no soportada para distribución: ${count}`);
  }

  return shuffleArray(plan);
}
function coverageTargetsPrompt(targets){
  if(!targets.length) return "";

  return `

==================================================
OBJETIVOS OBLIGATORIOS DE COBERTURA
==================================================

El sistema ha seleccionado ${targets.length} unidades examinables que todavía NO han sido trabajadas.

Debes generar EXACTAMENTE UNA pregunta sobre CADA objetivo siguiente.
No sustituyas estos objetivos por otros conceptos que te parezcan más interesantes.
No concentres las preguntas en otros contenidos recuperados por File Search.

OBJETIVOS:

${targets.map((item,index)=>`
OBJETIVO ${index+1}
- Familia de pregunta asignada: ${item.questionFamily || "GENERAL"}
- Esta familia es OBLIGATORIA salvo imposibilidad factual demostrable.
- Apartado: ${item.section || "No especificado"}
- Concepto: ${item.concept}
- Tipo de contenido: ${item.item_type}
- Tipo de evaluación solicitado: ${item.evaluation_type}
- Página física PDF (uso interno): ${item.source_page ?? "No determinada"}
- Página impresa del manual (para mostrar al opositor): ${item.manual_page ?? "No determinada"}
- Evidencia catalogada: ${item.source_evidence || "No disponible"}
`).join("\n")}

REGLAS DE COBERTURA:
- La pregunta 1 debe evaluar el OBJETIVO 1.
- La pregunta 2 debe evaluar el OBJETIVO 2.
- Continúa exactamente en ese orden.
- No generes dos preguntas sobre el mismo objetivo.
- El objetivo indica QUÉ conocimiento debe evaluarse.
- File Search sigue siendo la fuente factual definitiva.
- Verifica cada objetivo contra el documento recuperado antes de formular la pregunta.
- Si la evidencia catalogada y el documento recuperado presentan alguna incompatibilidad, prevalece el documento original.
`;
}

async function markCoverageTargetsWorked(targets){
  if(!targets.length) return;

  const ids=targets.map(item=>item.id);

  await db.query(
    `UPDATE coverage_items
     SET worked = TRUE
     WHERE id = ANY($1::int[])`,
    [ids]
  );
}
async function validateGeneratedQuestions(ai,questions){
  const validationPrompt=`
Eres un validador estricto de preguntas de oposición.

FUENTE DE VERDAD

- La ÚNICA fuente factual disponible durante esta validación es el campo sourceEvidence de cada pregunta.
- sourceEvidence procede del temario recuperado mediante File Search durante la generación.
- Valida cada pregunta exclusivamente contra su propio sourceEvidence.
- No uses conocimiento general, memoria propia ni información externa.
- No uses los exámenes oficiales como fuente factual.
- Si sourceEvidence no permite demostrar una afirmación esencial de la pregunta, no la des por válida.
- No presupongas como cierto ningún dato que no esté respaldado por sourceEvidence.

TAREA

Valida TODAS las preguntas recibidas.

Para cada pregunta debes realizar DOS validaciones:
1. FIABILIDAD FACTUAL.
2. CUMPLIMIENTO REAL DE questionFamily.

VALIDACIÓN FACTUAL

Comprueba:

1. Que el enunciado pueda resolverse exclusivamente con el temario.
2. Que la opción indicada por correctIndex sea la respuesta válida según
   el temario y la polaridad de la pregunta.
3. Que exista exactamente UNA respuesta válida a lo preguntado.
4. Que ninguna otra opción pueda defenderse también como respuesta válida.
5. Que sourceEvidence respalde realmente la respuesta.
6. Que explanation sea coherente con la respuesta y con el temario.
7. Que cifras, unidades, porcentajes, fórmulas, relaciones, límites y
   condiciones coincidan con el temario.
8. Que NO, INCORRECTA, FALSA, EXCEPTO y expresiones equivalentes se
   interpreten respetando exactamente su polaridad.
9. Que no se introduzcan datos o afirmaciones esenciales que requieran
   conocimiento externo.
10. Que sourcePage represente exclusivamente la página física del PDF y
    se utilice solo como referencia interna.
11. Que manualPage represente exclusivamente la numeración impresa visible
    del propio manual.
12. Que nunca se deduzca manualPage a partir de sourcePage ni mediante offsets.
13. Si el enunciado cita una página del manual, dicha página debe coincidir
    con manualPage. Nunca debe utilizar sourcePage como página visible.

VALIDACIÓN DE FAMILIA

Comprueba que questionFamily describe lo que la pregunta REALMENTE hace,
no únicamente la familia que pretendía generar.

2026_CORRECTA:
- debe exigir razonamiento, aplicación, comparación, relación o discriminación;
- debe buscar inequívocamente la opción correcta;
- debe existir exactamente UNA afirmación correcta;
- las otras tres deben ser falsas pero técnicamente plausibles;
- no debe ser una pregunta meramente literal disfrazada mediante la palabra
  CORRECTA.

2026_INCORRECTA:
- debe exigir razonamiento, aplicación, comparación, relación o discriminación;
- debe buscar inequívocamente la opción incorrecta;
- EXACTAMENTE TRES afirmaciones deben ser verdaderas según el temario;
- EXACTAMENTE UNA afirmación debe ser falsa;
- esa falsa debe ser la única respuesta válida;
- no debe ser una pregunta meramente literal disfrazada mediante la palabra
  INCORRECTA.

2026_RAZONAMIENTO:
- debe exigir aplicar o relacionar información;
- no debe depender de una simple recuperación literal de una única frase;
- no necesita adoptar formato CORRECTA/INCORRECTA;
- todos los supuestos necesarios deben estar respaldados por el temario.

2024_NUMERICA:
- debe ser una pregunta literal/de precisión estilo 2024;
- debe evaluar un dato numérico explícitamente respaldado por el temario;
- no debe convertirse indebidamente en un ejercicio de cálculo;
- si cita manual y página, la página visible debe coincidir con manualPage.

2024_TEXTO:
- debe ser una pregunta literal/de precisión estilo 2024;
- debe evaluar contenido textual respaldado por el temario;
- si cita manual y página, la página visible debe coincidir con manualPage.

CALCULO_FORMULACION:
- debe evaluar realmente cálculo, fórmula, despeje, magnitudes, unidades,
  conversiones o relaciones entre magnitudes;
- la fórmula o relación utilizada debe estar respaldada por el temario;
- todos los datos necesarios para resolverla deben estar disponibles;
- cualquier operación, despeje, equivalencia o relación debe ser correcta.

GRAFICA:
- graphic debe existir y NO ser null;
- la representación debe ser una estructura TÉCNICA VISUAL REAL:
  geometría, forma, corte, disposición espacial, configuración física,
  recorrido, conexión técnica, mecanismo, sistema, fuerzas o situación
  física representable;
- NO consideres válida una representación por el mero hecho de contener
  elementos unidos mediante líneas o flechas;
- RECHAZA mapas conceptuales, mapas mentales, organigramas, palabras o
  frases dentro de círculos/cajas conectados mediante líneas y cualquier
  conversión artificial de contenido textual en nodos;
- RECHAZA diagramas que representen relaciones conceptuales entre términos
  en lugar de relaciones físicas, espaciales, geométricas o técnicas;
- RECHAZA gráficos decorativos o cuya información esencial ya esté
  explícitamente escrita en stem, options o labels;
- las etiquetas deben ser mínimas y NO deben proporcionar directamente
  el conocimiento que debería deducir el opositor;
- el gráfico debe ser NECESARIO para resolver correctamente la pregunta;
- aplica obligatoriamente este test:
  "Si elimino completamente graphic y dejo stem + options,
   ¿la pregunta puede resolverse esencialmente igual?"
  Si la respuesta es sí, graphicValid=false;
- la representación debe exigir interpretar visualmente una forma,
  posición, geometría, conexión, recorrido, disposición, mecanismo,
  fuerza u otra característica técnica;
- la interpretación debe requerir conocimiento del temario y no poder
  resolverse simplemente leyendo las etiquetas o siguiendo relaciones
  textuales evidentes;
- debe existir evidencia suficiente en sourceEvidence para respaldar la
  geometría, posición, conexión, recorrido, disposición o relación técnica
  utilizada para determinar la respuesta;
- puede aceptarse un dibujo construido a partir de una descripción textual
  aunque la fuente no contenga una imagen original, PERO únicamente cuando
  sourceEvidence determine inequívocamente la estructura técnica representada;
- RECHAZA cualquier geometría, posición, conexión, recorrido, medida,
  orientación, fuerza o relación técnica introducida mediante conocimiento
  externo o inventada para hacer posible el gráfico;
- stem, options, correctIndex y graphic deben ser mutuamente coherentes;
- todo elemento mencionado mediante identificadores como A, B, C, D,
  1, 2, 3, etc. debe aparecer inequívocamente identificado de la misma
  forma en graphic;
- si una opción menciona "elemento A", "posición B", "figura 2" o equivalente
  y esa referencia no puede localizarse inequívocamente en graphic,
  graphicValid=false;
- los elementos físicos o técnicos necesarios para resolver la pregunta
  deben existir en graphic;
- las conexiones necesarias deben corresponder a relaciones físicas o
  técnicas reales y NO a asociaciones conceptuales inventadas;
- graphic.description debe describir objetivamente la representación y
  NO revelar la respuesta;
- debe existir UNA única respuesta válida;
- si el dibujo resulta abstracto, arbitrario o no representa una
  configuración técnica examinable, graphicValid=false;
- si el contenido podría convertirse razonablemente en una pregunta textual
  pero NO en un dibujo técnico real, graphicValid=false;
- cuando cualquiera de estas condiciones falle, familyValid=false,
  graphicValid=false y valid=false.

REGLAS DEL CAMPO graphic

- Para cualquier familia distinta de GRAFICA, graphic debe ser null.
- Para preguntas no gráficas devuelve graphicValid=null.
- graphicIssues debe ser [] cuando no existan problemas gráficos.

Para GRAFICA, graphic debe cumplir además TODAS estas condiciones estructurales:

1. graphic debe ser un objeto y graphic.elements debe contener al menos un elemento.

2. graphic.type debe ser exclusivamente uno de:
   "technical",
   "geometry",
   "mechanism",
   "configuration",
   "circuit",
   "forces".

3. Cada elemento de graphic.elements debe utilizar exclusivamente una de estas shape:
   "line",
   "rect",
   "circle",
   "ellipse",
   "polygon",
   "polyline",
   "arrow",
   "text".

4. Todas las coordenadas utilizadas deben estar comprendidas entre 0 y 100.

5. Para shape="line":
   x2 e y2 deben existir y definir el extremo final.

6. Para shape="arrow":
   x2 e y2 deben existir y definir el destino.
   La dirección representada debe estar respaldada por sourceEvidence.

7. Para shape="rect":
   width y height deben existir y ser mayores que 0.

8. Para shape="circle":
   radius debe existir y ser mayor que 0.

9. Para shape="ellipse":
   width y height deben existir y ser mayores que 0.

10. Para shape="polygon":
    points debe contener al menos TRES puntos válidos.

11. Para shape="polyline":
    points debe contener al menos DOS puntos válidos.

12. Para shape="text":
    label debe contener texto visible y necesario.
    Debe utilizarse únicamente para identificadores o referencias mínimas
    y NO debe revelar la respuesta.

13. Los campos geométricos no utilizados por una determinada shape pueden
    ser null y points puede ser [] cuando no sea necesario.

14. Las primitivas deben representar objetos, formas, recorridos, posiciones,
    conexiones o configuraciones técnicas reales.
    NO deben utilizarse como simples contenedores de conceptos escritos.

15. graphic ya NO utiliza el campo connections.
    Las relaciones visuales deben construirse mediante las propias primitivas
    de graphic.elements.

16. Si stem u options hacen referencia a A, B, C, D, 1, 2, 3 u otro
    identificador visual, dicho identificador debe aparecer inequívocamente
    en el gráfico.

17. graphic.description debe ser neutral y NO revelar la solución.

18. El conjunto de primitivas debe ser suficiente para que el dibujo resulte
    interpretable sin imaginar elementos técnicos ausentes.

19. Aunque la estructura sea formalmente válida, graphicValid=false si el
    resultado sigue siendo un mapa conceptual, una representación abstracta,
    un gráfico decorativo o un dibujo innecesario.

20. graphicValid solo puede ser true cuando el gráfico sea simultáneamente:
    - estructuralmente válido;
    - factual;
    - técnicamente coherente;
    - visualmente interpretable;
    - necesario para resolver la pregunta.

Si incumple cualquiera de las condiciones aplicables:
- graphicValid=false;
- familyValid=false;
- valid=false;
- describe el motivo concreto en graphicIssues y familyIssues.

RESULTADO

Para cada pregunta devuelve:

- index: índice original empezando en 0.
- valid: true únicamente si la pregunta supera TODAS las comprobaciones
  factuales Y de familia aplicables.
- issues: problemas de fiabilidad factual. Si no existen, [].
- familyValid: true únicamente si la pregunta cumple realmente las reglas
  de questionFamily.
- familyIssues: incumplimientos de familia. Si no existen, [].
- graphicValid:
    * true o false para GRAFICA;
    * null para cualquier otra familia.
- graphicIssues: problemas gráficos; [] cuando no existan.

CRITERIO FINAL

- Ante una contradicción factual clara, valid=false.
- Si falta evidencia suficiente para verificar un aspecto esencial,
  valid=false.
- Si familyValid=false, valid=false.
- Si una pregunta GRAFICA tiene graphicValid=false, valid=false.
- No corrijas ni reescribas preguntas.
- No mejores estilo ni dificultad durante la validación.
- No evalúes si la pregunta te gusta.
- Limítate a comprobar factualidad, unicidad de respuesta, polaridad,
  cumplimiento de familia y coherencia gráfica conforme a estas reglas.

ÍNDICES

- index empieza en 0.
- Devuelve exactamente un resultado por cada pregunta.
- Conserva exactamente el mismo orden.

PREGUNTAS A VALIDAR:
\${JSON.stringify(questions)}
`;

const runtimeValidationSchema = structuredClone(validationSchema);

runtimeValidationSchema.properties.results.minItems = questions.length;
runtimeValidationSchema.properties.results.maxItems = questions.length;
  const response=await ai.models.generateContent({
    model:"gemini-3.5-flash-lite",
    contents:validationPrompt,
    config:{
      responseMimeType:"application/json",
      responseJsonSchema:runtimeValidationSchema
    }
  });

  const validation=JSON.parse(response.text);
console.log("VALIDATOR RAW RESPONSE:", response.text);
 console.log(
  "VALIDACIÓN: preguntas=",
  questions.length,
  "resultados=",
  validation?.results?.length,
  "indices=",
  validation?.results?.map(r=>r.index)
);
  if(
    !validation.results ||
    validation.results.length!==questions.length
  ){
    throw new Error(
      "El validador factual no devolvió un resultado por cada pregunta."
    );
  }

  for(let i=0;i<validation.results.length;i++){
    const result=validation.results[i];

    if(result.index!==i){
      throw new Error(
        "El validador factual devolvió índices inconsistentes."
      );
    }
  }

  return validation.results;
}
async function regenerateInvalidQuestions(
  ai,
  invalidResults,
  originalQuestions,
  targets,
  difficulty,
  mode,
  officialStyle
){
  const replacementTargets =
    invalidResults.map(result => targets[result.index]);

  const rejectedQuestions =
  invalidResults.map(result => ({
    index: result.index,
    question: originalQuestions[result.index],
    issues: result.issues,
    familyIssues: result.familyIssues || [],
    graphicIssues: result.graphicIssues || []
  }));

  const replacementPrompt =
    generationPrompt(replacementTargets.length, difficulty, mode) +
    coverageTargetsPrompt(replacementTargets) +
    `
========================================
REGENERACIÓN DE PREGUNTAS RECHAZADAS
========================================

Debes generar EXACTAMENTE ${replacementTargets.length} preguntas.

Estas preguntas sustituyen preguntas rechazadas por una validación factual independiente.

MOTIVOS DEL RECHAZO:
${JSON.stringify(rejectedQuestions)}

REGLAS OBLIGATORIAS:
- Genera una pregunta por cada objetivo de cobertura recibido.
- Mantén exactamente el mismo orden que los objetivos.
- Corrige específicamente los problemas indicados por el validador.
- NO reutilices la afirmación que provocó el rechazo salvo que File Search permita demostrarla.
- File Search y el temario son la única fuente factual.
- No inventes datos para completar información ausente.
- Todas las reglas normales de generación siguen siendo obligatorias.
- Conserva la questionFamily de la pregunta rechazada cuando exista evidencia
  suficiente en el temario para corregirla dentro de esa misma familia.
- Si esa familia no puede construirse válidamente con la evidencia recuperada,
  aplica exclusivamente las reglas de fallback definidas en generationPrompt
  y asigna a questionFamily la familia final realmente generada.
- Si el rechazo contiene familyIssues o graphicIssues, corrige explícitamente
  esos problemas además de cualquier problema factual indicado en issues.

========================================
REFERENCIA DINÁMICA DE ESTILO
========================================

Úsala EXCLUSIVAMENTE como referencia de redacción, estructura,
distractores, cálculos y nivel de razonamiento.

NO la utilices como fuente factual.

${officialStyle}

========================================
FIN DE REFERENCIA
========================================
`;

  const response = await ai.models.generateContent({
    model:"gemini-3.5-flash-lite",
    contents:replacementPrompt,
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

  const parsed = JSON.parse(response.text);

  if(
    !parsed.questions ||
    parsed.questions.length !== replacementTargets.length
  ){
    throw new Error(
      "La regeneración no devolvió el número esperado de preguntas."
    );
  }

  return {
    questions: parsed.questions,
    targets: replacementTargets
  };
}
app.post("/api/generate", async(req,res)=>{
  try{
    if(!STORE) throw new Error("Primero indexa el PDF.");

    const count=Math.min(Math.max(Number(req.body.count)||10,5),40);
    const difficulty=req.body.difficulty==="media" ? "media" : "alta";
    const mode=["literal","mixto","calculos"].includes(req.body.mode)
      ? req.body.mode
      : "mixto";

    const targets=await getCoverageTargetsForGeneration(count);

    if(targets.length<count){
      throw new Error(
        `Solo quedan ${targets.length} unidades de cobertura sin trabajar.`
      );
    }

    const ai=aiClient();

    console.log(
      "GENERATECONTENT: iniciando con",
      targets.length,
      "objetivos de cobertura"
    );

    const officialStyle = await getCachedOfficialExamStyleReference();

const prompt =
  generationPrompt(count,difficulty,mode) +
  coverageTargetsPrompt(targets) +
  `

===============================================
REFERENCIA DINÁMICA DE ESTILO — EXÁMENES OFICIALES
===============================================

La siguiente información procede del análisis independiente de los exámenes
oficiales de Bomberos de Navarra 2024 y 2026.

Úsala EXCLUSIVAMENTE para reproducir:
- redacción;
- estructura;
- construcción de distractores;
- planteamiento de cálculos;
- situaciones prácticas;
- nivel de razonamiento;
- formato conceptual de las preguntas.

NO utilices esta referencia como fuente factual.
NO extraigas de ella respuestas ni conocimientos.
La única fuente factual continúa siendo el temario recuperado mediante File Search.

Da predominio al estilo 2026, conservando los rasgos útiles del modelo 2024.

--- REFERENCIA DE ESTILO ---

${officialStyle}

--- FIN DE REFERENCIA DE ESTILO ---
`;

    const response=await ai.models.generateContent({
      model:"gemini-3.5-flash-lite",
      contents:prompt,
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
console.log("TEXTO GEMINI:", response.text.slice(0,1500));
    const parsed=JSON.parse(response.text);

    if(
      !parsed.questions ||
      parsed.questions.length!==count
    ){
      throw new Error(
        `Gemini debía devolver ${count} preguntas y devolvió ${parsed.questions?.length || 0}.`
      );
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
console.log("VALIDACIÓN FACTUAL: iniciando");

let finalQuestions = [...parsed.questions];
let factualValidation =
  await validateGeneratedQuestions(ai, finalQuestions);

let invalidQuestions =
  factualValidation.filter(result => !result.valid);

const MAX_REPLACEMENT_ATTEMPTS = 2;
let replacementAttempt = 0;

while(
  invalidQuestions.length > 0 &&
  replacementAttempt < MAX_REPLACEMENT_ATTEMPTS
){
  replacementAttempt++;

  console.log(
    `VALIDACIÓN FACTUAL: ${invalidQuestions.length} preguntas rechazadas. ` +
    `Intento de sustitución ${replacementAttempt}/${MAX_REPLACEMENT_ATTEMPTS}`
  );

  const regenerated =
    await regenerateInvalidQuestions(
      ai,
      invalidQuestions,
      finalQuestions,
      targets,
      difficulty,
      mode,
      officialStyle
    );

  const replacementValidation =
    await validateGeneratedQuestions(
      ai,
      regenerated.questions
    );

  const stillInvalid = [];

  for(let i=0;i<regenerated.questions.length;i++){
    const originalIndex = invalidQuestions[i].index;
    const validationResult = replacementValidation[i];

    if(validationResult.valid){
      finalQuestions[originalIndex] =
        regenerated.questions[i];
    }else{
      stillInvalid.push({
  index: originalIndex,
  valid: false,
  issues: validationResult.issues || [],
  familyIssues: validationResult.familyIssues || [],
  graphicIssues: validationResult.graphicIssues || []
});
    }
  }

  invalidQuestions = stillInvalid;
}

if(invalidQuestions.length > 0){
  const details = invalidQuestions
    .map(result =>
      `Pregunta ${result.index + 1}: ${
        result.issues?.join(" | ") ||
        "fallo factual no especificado"
      }`
    )
    .join(" || ");

  throw new Error(
    `No se pudieron obtener todas las preguntas con validación factual. ${details}`
  );
}

console.log(
  "VALIDACIÓN FACTUAL: todas las preguntas superadas"
);

parsed.questions = finalQuestions;
    /*
      Las preguntas mantienen el mismo orden que los objetivos:
      pregunta 1 -> objetivo 1
      pregunta 2 -> objetivo 2
      etc.

      Solo llegamos aquí después de recibir y validar
      exactamente el número solicitado de preguntas.
    */
    await markCoverageTargetsWorked(targets);

    console.log(
      "COBERTURA: marcados como trabajados",
      targets.map(t=>t.id)
    );

    res.json({
      ok:true,
      questions:parsed.questions,
      coverage:{
        targeted:targets.length,
        markedWorked:targets.length
      }
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
app.get("/api/coverage-audit", async(req,res)=>{
  try{
    const topicResult=await db.query(
      `SELECT id, name, total_items
       FROM topics
       WHERE name=$1
       LIMIT 1`,
      ["Apeo y poda de arbolado"]
    );

    if(!topicResult.rows.length){
      throw new Error("No existe el análisis de cobertura del tema.");
    }

    const topic=topicResult.rows[0];

    const itemsResult=await db.query(
      `SELECT
         id,
         section,
         concept,
         item_type,
         evaluation_type,
         source_page,
         source_evidence,
         worked
       FROM coverage_items
       WHERE topic_id=$1
       ORDER BY source_page ASC, section ASC, id ASC`,
      [topic.id]
    );

    const items=itemsResult.rows;

    const byPage={};
    const byType={};
    const byEvaluation={};

    for(const item of items){
      const page=String(item.source_page ?? "sin_pagina");
      const type=item.item_type || "sin_tipo";
      const evaluation=item.evaluation_type || "sin_tipo";

      byPage[page]=(byPage[page]||0)+1;
      byType[type]=(byType[type]||0)+1;
      byEvaluation[evaluation]=(byEvaluation[evaluation]||0)+1;
    }

    res.json({
      ok:true,
      topic:topic.name,
      databaseTotal:items.length,
      topicTotal:Number(topic.total_items)||0,
      byPage,
      byType,
      byEvaluation,
      items
    });

  }catch(e){
    console.error("ERROR COVERAGE AUDIT READ:",e);

    res.status(500).json({
      ok:false,
      error:e?.message || String(e)
    });
  }
});
async function startServer(){
  await initDatabase();
  await loadStore();
  await loadExamStyleStore();

  app.listen(process.env.PORT || 3000, ()=>{
    console.log("Test Bombero V2 listo");
    console.log("TEMARIO STORE recuperado:", STORE || "ninguno");
    console.log(
      "EXAM STYLE STORE recuperado:",
      EXAM_STYLE_STORE || "ninguno"
    );
  });
}

startServer().catch(e=>{
  console.error("ERROR INICIANDO SERVIDOR:", e);
  process.exit(1);
});
