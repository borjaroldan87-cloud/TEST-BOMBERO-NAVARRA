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
          sourceEvidence:{type:"string"}
        },
        required:[
          "section",
          "concept",
          "itemType",
          "evaluationType",
          "sourcePage",
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

Cuando indiques sourcePage utiliza la numeración REAL del documento original:
${chunk.startPage} a ${chunk.endPage}.`
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
const parsed={
  items:allItems
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

  app.listen(process.env.PORT || 3000, ()=>{
    console.log("Test Bombero V2 listo");
    console.log("STORE recuperado:", STORE || "ninguno");
  });
}

startServer().catch(e=>{
  console.error("ERROR INICIANDO SERVIDOR:", e);
  process.exit(1);
});
