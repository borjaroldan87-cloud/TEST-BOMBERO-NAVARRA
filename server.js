import express from "express";
import multer from "multer";
import { GoogleGenAI } from "@google/genai";
import fs from "fs";
import path from "path";
import { PDFDocument } from "pdf-lib";
import pg from "pg";
import { createHash, timingSafeEqual } from "node:crypto";
import { inflateSync } from "node:zlib";
import { spawnSync } from "node:child_process";
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
const GRAPHICS_ROOT = path.join(process.cwd(), "public", "graphics");

const GRAPHIC_TOPIC_FOLDERS = Object.freeze([
  "teoria-fuego",
  "incendios-interior",
  "hidraulica",
  "tuneles",
  "incendios-industriales",
  "incendios-vegetacion",
  "salvamento-altura",
  "trafico",
  "ferroviarios",
  "apicola",
  "edificacion-apeos",
  "apeo-poda",
  "estructuras-colapsadas",
  "ascensores",
  "electricidad",
  "nrbq",
  "herramientas",
  "vehiculos"
]);

const GRAPHIC_IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".webp"
]);
function buildGraphicSourceInventory(){
  const inventory = [];

  for(const topicFolder of GRAPHIC_TOPIC_FOLDERS){
    const folderPath = path.join(GRAPHICS_ROOT, topicFolder);

    if(!fs.existsSync(folderPath)){
      console.warn(`[graphics] Carpeta no encontrada: ${topicFolder}`);
      continue;
    }

    const files = fs.readdirSync(folderPath, { withFileTypes: true });

    for(const entry of files){
      if(!entry.isFile()) continue;

      const extension = path.extname(entry.name).toLowerCase();
      if(!GRAPHIC_IMAGE_EXTENSIONS.has(extension)) continue;

      inventory.push({
        topicFolder,
        fileName: entry.name,
        absolutePath: path.join(folderPath, entry.name),
        publicUrl: `/graphics/${topicFolder}/${encodeURIComponent(entry.name)}`,
        sourceId: `${topicFolder}/${entry.name}`
      });
    }
  }

  return inventory;
}

const GRAPHIC_SOURCE_INVENTORY = buildGraphicSourceInventory();

console.log(
  `[graphics] ${GRAPHIC_SOURCE_INVENTORY.length} imágenes fuente detectadas en ` +
  `${new Set(GRAPHIC_SOURCE_INVENTORY.map(item => item.topicFolder)).size} temas.`
);
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
// SERVER 102: en una base de datos recien creada, `block` debe existir
// ANTES de la normalizacion de temas. En Render con DB existente es idempotente.
await db.query(`
  ALTER TABLE topics ADD COLUMN IF NOT EXISTS block TEXT
`);
await db.query(`
  UPDATE topics
  SET block = 'especifico'
  WHERE
    (block IS NULL OR TRIM(block) = '')
    AND LOWER(TRIM(name)) = 'apeo y poda de arbolado'
`);

  await db.query(`
    ALTER TABLE topics
    ADD COLUMN IF NOT EXISTS topic_order INTEGER
  `);
await db.query(`
  UPDATE topics
  SET topic_order =
    (
      regexp_match(
        name,
        '^\\s*TEMA\\s*([0-9]{1,3})',
        'i'
      )
    )[1]::integer
  WHERE name ~* '^\\s*TEMA\\s*[0-9]{1,3}'
`);
  await db.query(`
    ALTER TABLE topics
    ADD COLUMN IF NOT EXISTS file_search_indexed BOOLEAN NOT NULL DEFAULT FALSE
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS topic_source_documents (
      topic_id INTEGER PRIMARY KEY REFERENCES topics(id) ON DELETE CASCADE,
      document_name TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
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

await db.query(`
  ALTER TABLE coverage_items
  ADD COLUMN IF NOT EXISTS exam_relevant BOOLEAN NOT NULL DEFAULT TRUE
`);

await db.query(`
  UPDATE coverage_items ci
  SET exam_relevant = FALSE
  FROM topics t
  WHERE
    ci.topic_id = t.id
    AND t.block = 'legislacion'
    AND ci.exam_relevant = TRUE
    AND (
      LOWER(BTRIM(COALESCE(ci.section,''))) IN (
        'índice',
        'indice',
        'índice general',
        'indice general',
        'sumario',
        'tabla de contenidos'
      )
      OR LOWER(COALESCE(ci.concept,'')) LIKE '%estructura general%'
      OR LOWER(COALESCE(ci.concept,'')) LIKE '%estructura temática%'
      OR LOWER(COALESCE(ci.concept,'')) LIKE '%estructura tematica%'
      OR LOWER(COALESCE(ci.concept,'')) LIKE '%número de orden%'
      OR LOWER(COALESCE(ci.concept,'')) LIKE '%numero de orden%'
      OR LOWER(COALESCE(ci.concept,'')) LIKE '%orden de los apartados%'
      OR LOWER(COALESCE(ci.concept,'')) LIKE '%orden de apartados%'
      OR LOWER(COALESCE(ci.concept,'')) LIKE '%posición en el índice%'
      OR LOWER(COALESCE(ci.concept,'')) LIKE '%posicion en el indice%'
      OR LOWER(COALESCE(ci.concept,'')) LIKE '%posición dentro del índice%'
      OR LOWER(COALESCE(ci.concept,'')) LIKE '%posicion dentro del indice%'
      OR (
        LOWER(COALESCE(ci.concept,'')) LIKE '%ocupa%'
        AND LOWER(COALESCE(ci.concept,'')) LIKE '%lugar%'
        AND LOWER(COALESCE(ci.concept,'')) LIKE '%índice%'
      )
      OR (
        LOWER(COALESCE(ci.concept,'')) LIKE '%ocupa%'
        AND LOWER(COALESCE(ci.concept,'')) LIKE '%lugar%'
        AND LOWER(COALESCE(ci.concept,'')) LIKE '%indice%'
      )
    )
`);

   await db.query(`
    CREATE TABLE IF NOT EXISTS graphic_assets (
      id SERIAL PRIMARY KEY,
      source_id TEXT NOT NULL,
      topic_folder TEXT NOT NULL,
      source_file TEXT NOT NULL,
      public_url TEXT NOT NULL,

      asset_index INTEGER NOT NULL DEFAULT 0,
      asset_type TEXT NOT NULL DEFAULT 'individual',

      concept TEXT,
      description TEXT,
      source_evidence TEXT,

      crop_x NUMERIC,
      crop_y NUMERIC,
      crop_width NUMERIC,
      crop_height NUMERIC,

      is_official_reference BOOLEAN NOT NULL DEFAULT FALSE,
      is_usable BOOLEAN NOT NULL DEFAULT FALSE,
      analysis_status TEXT NOT NULL DEFAULT 'pending',

      times_asked INTEGER NOT NULL DEFAULT 0,
      last_asked_at TIMESTAMPTZ,

      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

      UNIQUE(source_id, asset_index)
    )
    `);

  await db.query(`
    ALTER TABLE graphic_assets
    ADD COLUMN IF NOT EXISTS mask_regions JSONB NOT NULL DEFAULT '[]'::jsonb
  `);

  await db.query(`
    ALTER TABLE graphic_assets
    ADD COLUMN IF NOT EXISTS sanitization_version INTEGER NOT NULL DEFAULT 1
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS question_bank (
      id BIGSERIAL PRIMARY KEY,

      coverage_item_id INTEGER NOT NULL
        REFERENCES coverage_items(id) ON DELETE CASCADE,

      stem TEXT NOT NULL,
      options JSONB NOT NULL,
      correct_index INTEGER NOT NULL
        CHECK (correct_index BETWEEN 0 AND 3),

      explanation TEXT,
      source_evidence TEXT,
      source_page INTEGER,
      manual_page TEXT,

      question_family TEXT NOT NULL,
      difficulty TEXT NOT NULL,

      graphic JSONB,

      times_shown INTEGER NOT NULL DEFAULT 0,
      times_correct INTEGER NOT NULL DEFAULT 0,
      times_wrong INTEGER NOT NULL DEFAULT 0,
      last_shown_at TIMESTAMPTZ,

      active BOOLEAN NOT NULL DEFAULT TRUE,

      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await db.query(`
  ALTER TABLE question_bank
  ADD COLUMN IF NOT EXISTS validation_version INTEGER NOT NULL DEFAULT 1
`);

await db.query(`
  CREATE INDEX IF NOT EXISTS idx_question_bank_coverage
  ON question_bank(coverage_item_id)
`);
// SERVER 107: una pregunta aprobada no entregada no puede duplicarse
// por dos peticiones concurrentes sobre el mismo objetivo curricular.
await db.query(`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_legislation_ready107_dedupe
  ON question_bank (coverage_item_id, md5(lower(btrim(stem))))
  WHERE validation_version=107 AND active=TRUE
`);
// SERVER 114: VERSION 113 necesita su propio índice único para evitar
// preguntas pendientes duplicadas si coinciden dos generaciones concurrentes.
await db.query(`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_legislation_ready113_dedupe
  ON question_bank (coverage_item_id, md5(lower(btrim(stem))))
  WHERE validation_version=113 AND active=TRUE
`);

  await db.query(`
    CREATE TABLE IF NOT EXISTS test_sessions (
      id BIGSERIAL PRIMARY KEY,

      requested_count INTEGER NOT NULL,
      difficulty TEXT,
      mode TEXT,

      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ,

      total_questions INTEGER NOT NULL DEFAULT 0,
      correct_answers INTEGER NOT NULL DEFAULT 0,
      wrong_answers INTEGER NOT NULL DEFAULT 0,

      completed BOOLEAN NOT NULL DEFAULT FALSE
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS test_session_questions (
      id BIGSERIAL PRIMARY KEY,

      session_id BIGINT NOT NULL
        REFERENCES test_sessions(id) ON DELETE CASCADE,

      question_id BIGINT NOT NULL
        REFERENCES question_bank(id) ON DELETE RESTRICT,

      coverage_item_id INTEGER NOT NULL
        REFERENCES coverage_items(id) ON DELETE RESTRICT,

      position INTEGER NOT NULL,

      selected_index INTEGER,
      is_correct BOOLEAN,

      answered_at TIMESTAMPTZ,

      UNIQUE(session_id, position)
    )
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_test_questions_session
    ON test_session_questions(session_id)
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_test_questions_coverage
    ON test_session_questions(coverage_item_id)
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS coverage_review_state (
      coverage_item_id INTEGER PRIMARY KEY
        REFERENCES coverage_items(id) ON DELETE CASCADE,

      review_stage INTEGER NOT NULL DEFAULT 0
        CHECK (review_stage >= 0),

      next_review_at TIMESTAMPTZ,
      last_review_at TIMESTAMPTZ,

      consecutive_correct INTEGER NOT NULL DEFAULT 0,
      consecutive_wrong INTEGER NOT NULL DEFAULT 0,

      total_reviews INTEGER NOT NULL DEFAULT 0,
      total_correct INTEGER NOT NULL DEFAULT 0,
      total_wrong INTEGER NOT NULL DEFAULT 0,

      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_review_due
    ON coverage_review_state(next_review_at)
  `);
    await db.query(`
  ALTER TABLE coverage_items
  ADD COLUMN IF NOT EXISTS times_blank INTEGER NOT NULL DEFAULT 0
`);

await db.query(`
  ALTER TABLE question_bank
  ADD COLUMN IF NOT EXISTS times_blank INTEGER NOT NULL DEFAULT 0
`);

await db.query(`
  ALTER TABLE test_sessions
  ADD COLUMN IF NOT EXISTS blank_answers INTEGER NOT NULL DEFAULT 0
`);
  
await db.query(`
  ALTER TABLE test_sessions
  ADD COLUMN IF NOT EXISTS test_type TEXT NOT NULL DEFAULT 'normal'
`);
await db.query(`
  ALTER TABLE test_session_questions
  ADD COLUMN IF NOT EXISTS is_blank BOOLEAN NOT NULL DEFAULT FALSE
`);

await db.query(`
  ALTER TABLE coverage_review_state
  ADD COLUMN IF NOT EXISTS total_blank INTEGER NOT NULL DEFAULT 0
`);
await db.query(`
  CREATE TABLE IF NOT EXISTS legislation_anki_questions (
    id BIGSERIAL PRIMARY KEY,
    anki_note_id BIGINT NOT NULL UNIQUE,
    topic_order INTEGER NOT NULL,
    deck_path TEXT NOT NULL,
    topic TEXT NOT NULL,
    stem TEXT NOT NULL,
    options JSONB NOT NULL,
    correct_index INTEGER NOT NULL
      CHECK (correct_index BETWEEN 0 AND 3),
    correct_answer TEXT,
    option_count INTEGER NOT NULL
      CHECK (option_count IN (3,4)),
    direct_use_eligible BOOLEAN NOT NULL DEFAULT FALSE,
    tags JSONB NOT NULL DEFAULT '[]'::jsonb,
    fingerprint TEXT NOT NULL,
    validation_status TEXT NOT NULL DEFAULT 'pending'
      CHECK (validation_status IN ('pending','validated','rejected')),
    validation_reason TEXT,
    validated_coverage_item_id INTEGER
      REFERENCES coverage_items(id) ON DELETE SET NULL,
    validated_at TIMESTAMPTZ,
    times_used INTEGER NOT NULL DEFAULT 0,
    last_used_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )
`);

await db.query(`
  CREATE INDEX IF NOT EXISTS idx_legislation_anki_topic_status
  ON legislation_anki_questions(topic_order, validation_status)
`);

await db.query(`
  CREATE INDEX IF NOT EXISTS idx_legislation_anki_fingerprint
  ON legislation_anki_questions(fingerprint)
`);

await db.query(`
  ALTER TABLE legislation_anki_questions
  ADD COLUMN IF NOT EXISTS validation_evidence TEXT
`);

await db.query(`
  ALTER TABLE question_bank
  ADD COLUMN IF NOT EXISTS source_anki_question_id BIGINT
    REFERENCES legislation_anki_questions(id) ON DELETE SET NULL
`);

await db.query(`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_question_bank_anki_coverage
  ON question_bank(source_anki_question_id, coverage_item_id)
  WHERE source_anki_question_id IS NOT NULL
`);
}
async function syncGraphicAssets(){
  const graphicsRoot = path.join(process.cwd(), "public", "graphics");

  if(!fs.existsSync(graphicsRoot)){
    console.log("GRAPHICS: carpeta public/graphics no encontrada");
    return { folders:0, files:0 };
  }

  const imageExtensions = new Set([
    ".png",
    ".jpg",
    ".jpeg",
    ".webp"
  ]);

  const topicFolders = fs.readdirSync(graphicsRoot, {
    withFileTypes:true
  }).filter(entry => entry.isDirectory());

  let files = 0;

  for(const folder of topicFolders){
    const folderPath = path.join(graphicsRoot, folder.name);

    const images = fs.readdirSync(folderPath, {
      withFileTypes:true
    }).filter(entry =>
      entry.isFile() &&
      imageExtensions.has(path.extname(entry.name).toLowerCase())
    );

    for(const image of images){
      const sourceId = `${folder.name}/${image.name}`;
      const publicUrl =
        `/graphics/${encodeURIComponent(folder.name)}/${encodeURIComponent(image.name)}`;

      await db.query(
        `INSERT INTO graphic_assets (
          source_id,
          topic_folder,
          source_file,
          public_url
        )
        VALUES ($1,$2,$3,$4)
        ON CONFLICT (source_id, asset_index)
        DO UPDATE SET
          topic_folder = EXCLUDED.topic_folder,
          source_file = EXCLUDED.source_file,
          public_url = EXCLUDED.public_url,
          updated_at = NOW()`,
        [
          sourceId,
          folder.name,
          image.name,
          publicUrl
        ]
      );

      files++;
    }
  }

  console.log(
    `GRAPHICS: ${files} imágenes registradas en ${topicFolders.length} temas`
  );

  return {
    folders:topicFolders.length,
    files
  };
}
const graphicAssetAnalysisSchema = {
  type:"object",
  properties:{
    sourceType:{
      type:"string",
      enum:["technical_image","official_exam_reference","unusable"]
    },

    sourceCaption:{
      type:["string","null"]
    },

    sourceText:{
      type:["string","null"]
    },

    useAsGroup:{
      type:"boolean"
    },

    groupReason:{
      type:["string","null"]
    },

    assets:{
      type:"array",
      items:{
        type:"object",
        properties:{
          assetIndex:{type:"integer"},

          concept:{type:"string"},

          visualDescription:{type:"string"},

          textToRemove:{
            type:"array",
            items:{type:"string"}
          },
          maskRegions:{
            type:"array",
            items:{
              type:"object",
              properties:{
                x:{type:"number"},
                y:{type:"number"},
                width:{type:"number"},
                height:{type:"number"},
                visibleText:{type:"string"},
                kind:{
                  type:"string",
                  enum:[
                    "editorial_text",
                    "three_cut_sequence_number"
                  ]
                },
                reason:{type:"string"}
              },
              required:[
                "x",
                "y",
                "width",
                "height",
                "visibleText",
                "kind",
                "reason"
              ]
            }
          },
          crop:{
            type:["object","null"],
            properties:{
              x:{type:"number"},
              y:{type:"number"},
              width:{type:"number"},
              height:{type:"number"}
            },
            required:["x","y","width","height"]
          },

          needsImageToAnswer:{
            type:"boolean"
          },

          usableForGraphicQuestion:{
            type:"boolean"
          },

          rejectionReason:{
            type:["string","null"]
          }
        },
        required:[
          "assetIndex",
          "concept",
          "visualDescription",
          "textToRemove",
          "maskRegions",
          "crop",
          "needsImageToAnswer",
          "usableForGraphicQuestion",
          "rejectionReason"
        ]
      }
    }
  },

  required:[
    "sourceType",
    "sourceCaption",
    "sourceText",
    "useAsGroup",
    "groupReason",
    "assets"
  ]
};
const GRAPHIC_GROUP_RULES = {
  nrbq:[
    {
      key:"clp_correspondences",
      description:"Correspondencias entre pictogramas antiguos y pictogramas CLP"
    }
  ],

  vehiculos:[
    {
      key:"two_stroke_cycle",
      description:"Ciclo completo del motor de dos tiempos"
    },
    {
      key:"gasoline_engine_cycle",
      description:"Ciclo de trabajo completo del motor de gasolina"
    }
  ]
};

function graphicGroupRulesPrompt(topicFolder){
  const rules = GRAPHIC_GROUP_RULES[topicFolder] || [];

  if(!rules.length){
    return `
REGLA DE AGRUPACIÓN:
- Trata los dibujos de esta imagen individualmente siempre que sean separables.
- No mantengas varios dibujos juntos por comodidad.
- Si una imagen contiene varios esquemas independientes, devuelve un asset distinto para cada uno.
`;
  }

  return `
REGLA DE AGRUPACIÓN:
Estas son las ÚNICAS composiciones de este tema que pueden mantenerse como conjunto:

${rules.map(rule => `- ${rule.description}`).join("\n")}

Solo usa useAsGroup=true si la imagen corresponde realmente a una de esas composiciones.
Cualquier otra imagen con varios dibujos debe dividirse en assets individuales siempre que sean separables.
`;
}
async function analyzeGraphicSource(ai, graphicRow){
  const imagePath = path.join(
    process.cwd(),
    "public",
    "graphics",
    graphicRow.topic_folder,
    graphicRow.source_file
  );

  if(!fs.existsSync(imagePath)){
    throw new Error(`Imagen gráfica no encontrada: ${imagePath}`);
  }

  const imageBytes = fs.readFileSync(imagePath);
  const extension = path.extname(graphicRow.source_file).toLowerCase();

  const mimeTypes = {
    ".png":"image/png",
    ".jpg":"image/jpeg",
    ".jpeg":"image/jpeg",
    ".webp":"image/webp"
  };

  const mimeType = mimeTypes[extension];

  if(!mimeType){
    throw new Error(`Formato gráfico no soportado: ${extension}`);
  }

  const prompt = `
Analiza esta imagen para incorporarla a una biblioteca cerrada de imágenes
destinada exclusivamente a preguntas gráficas de una oposición de Bomberos
de Navarra.

TEMA/CARPETA:
${graphicRow.topic_folder}

${graphicGroupRulesPrompt(graphicRow.topic_folder)}

OBJETIVO:
Identificar exactamente qué material gráfico útil contiene la imagen y cómo
debe utilizarse posteriormente para generar preguntas de interpretación visual.

REGLAS OBLIGATORIAS:

1. Determina si es una imagen técnica del temario, una referencia de examen
oficial o una imagen no utilizable.

2. No inventes contenido que no sea visible.

3. Por defecto, cada dibujo, esquema o configuración independiente debe
convertirse en un asset independiente.

4. Solo conserva conjuntamente varios dibujos cuando las reglas específicas
del tema lo permitan expresamente.

5. Para cada asset devuelve crop con coordenadas NORMALIZADAS entre 0 y 1:
x, y, width y height.

6. El crop debe conservar íntegramente el dibujo técnico necesario y excluir
del encuadre TODO contenido editorial o periférico que no sea necesario para
interpretar técnicamente la imagen.

Debe quedar FUERA del crop siempre que pueda excluirse sin cortar información
técnica necesaria:
- pies de imagen o pies de figura;
- títulos y encabezados;
- párrafos explicativos;
- referencias editoriales como "Figura 3", "Fig. 3", "Imagen 4",
  "Ilustración 2" o numeraciones equivalentes;
- números que formen parte únicamente de la numeración de la figura;
- cualquier texto exterior al dibujo que no sea necesario para resolver
  una pregunta gráfica.

No amplíes el crop para conservar un título, pie de imagen, número de figura
o texto periférico.

7. Si uno de esos textos invade físicamente el dibujo y no puede eliminarse
mediante crop sin cortar una parte técnicamente necesaria, conserva íntegro
el dibujo e incluye ese texto exacto en textToRemove para su posterior
sanitización.

8. textToRemove debe contener únicamente contenido visible que deba ocultarse:
texto editorial que no haya podido excluirse mediante crop o información que
revele directamente la respuesta.

NO incluyas en textToRemove números, símbolos, cotas, magnitudes, letras o
etiquetas cuando sean funcionales y necesarias para interpretar técnicamente
el dibujo.

8.A. maskRegions debe contener las coordenadas exactas de las ÚNICAS zonas
interiores que posteriormente deban ocultarse.

Las coordenadas x, y, width y height de cada maskRegion están NORMALIZADAS
entre 0 y 1 respecto a la IMAGEN FUENTE ORIGINAL, no respecto al crop.

Por defecto:
maskRegions debe ser [].

Solo están permitidos estos dos casos:

A) kind="editorial_text"

Úsalo exclusivamente cuando un pie, número de figura, título o texto editorial
innecesario quede dentro del dibujo útil y NO pueda eliminarse mediante crop
sin cortar información técnica necesaria.

La región debe cubrir únicamente ese texto, con el mínimo rectángulo posible.

B) kind="three_cut_sequence_number"

Esta excepción SOLO puede utilizarse cuando:
- TEMA/CARPETA sea "apeo-poda";
- la imagen represente visualmente la técnica de los tres cortes;
- aparezcan los números 1, 2 o 3 indicando el orden de los cortes.

En ese único caso crea una maskRegion independiente para cada número visible
1, 2 y 3 que indique la secuencia.

visibleText debe ser exactamente "1", "2" o "3".

PROHIBICIONES ABSOLUTAS:

- NO marques otros números de imágenes de Apeo y poda.
- NO marques números de ningún otro tema.
- NO marques cotas.
- NO marques medidas.
- NO marques ángulos.
- NO marques magnitudes.
- NO marques referencias funcionales.
- NO marques A/B/C/D.
- NO marques símbolos técnicos.
- NO marques etiquetas necesarias para interpretar el dibujo.
- NO uses three_cut_sequence_number fuera de la técnica de los tres cortes.

Si existe cualquier duda sobre si una región debe ocultarse:
NO la marques.

Cada maskRegion debe quedar completamente dentro de la imagen:
x >= 0
y >= 0
width > 0
height > 0
x + width <= 1
y + height <= 1

9. usableForGraphicQuestion=true únicamente cuando pueda formularse una
pregunta cuya resolución dependa realmente de observar la imagen.

10. needsImageToAnswer=true únicamente cuando eliminar la imagen impediría
resolver correctamente la pregunta prevista.

11. concept debe identificar brevemente qué representa el asset.

12. visualDescription debe describir únicamente lo visible, sin anticipar
la respuesta correcta.

13. Respeta estrictamente las reglas de agrupación específicas del tema.

Devuelve exclusivamente la estructura solicitada.
`;

  const response = await ai.models.generateContent({
    model:"gemini-3.5-flash-lite",
    contents:[
      {
        role:"user",
        parts:[
          { text:prompt },
          {
            inlineData:{
              mimeType,
              data:imageBytes.toString("base64")
            }
          }
        ]
      }
    ],
    config:{
      responseMimeType:"application/json",
      responseJsonSchema:graphicAssetAnalysisSchema,
      temperature:0.1
    }
  });

  const rawText = response.text?.trim();

  if(!rawText){
    throw new Error(
      `Gemini no devolvió análisis para ${graphicRow.source_id}`
    );
  }

  let analysis;

  try{
    analysis = JSON.parse(rawText);
  }catch{
    throw new Error(
      `Respuesta JSON inválida analizando ${graphicRow.source_id}`
    );
  }

  if(!Array.isArray(analysis.assets)){
    analysis.assets = [];
  }

  return analysis;
}
function normalizeGraphicMaskRegions(maskRegions, topicFolder){
  if(!Array.isArray(maskRegions)){
    return [];
  }

  const normalized=[];

  for(const region of maskRegions){
    const x=Number(region?.x);
    const y=Number(region?.y);
    const width=Number(region?.width);
    const height=Number(region?.height);

    if(
      !Number.isFinite(x) ||
      !Number.isFinite(y) ||
      !Number.isFinite(width) ||
      !Number.isFinite(height) ||
      x < 0 ||
      y < 0 ||
      width <= 0 ||
      height <= 0 ||
      x + width > 1 ||
      y + height > 1
    ){
      continue;
    }

    const kind=String(region?.kind || "").trim();
    const visibleText=String(region?.visibleText || "").trim();
    const reason=String(region?.reason || "").trim();

    if(
      kind !== "editorial_text" &&
      kind !== "three_cut_sequence_number"
    ){
      continue;
    }

    if(!visibleText){
      continue;
    }

    if(kind === "three_cut_sequence_number"){
      if(
        topicFolder !== "apeo-poda" ||
        !["1","2","3"].includes(visibleText)
      ){
        continue;
      }
    }

    normalized.push({
      x,
      y,
      width,
      height,
      visibleText,
      kind,
      reason
    });
  }

  return normalized;
}
async function saveGraphicAnalysis(graphicRow, analysis){
  const assets = Array.isArray(analysis.assets)
    ? analysis.assets
    : [];

  const client = await db.connect();

  try{
    await client.query("BEGIN");

    if(!assets.length){
      await client.query(
        `UPDATE graphic_assets
         SET
           analysis_status = 'rejected',
           is_usable = FALSE,
           sanitization_version = 2,
           updated_at = NOW()
         WHERE source_id = $1`,
        [graphicRow.source_id]
      );

      await client.query("COMMIT");
      return;
    }

    await client.query(
      `UPDATE graphic_assets
       SET
         analysis_status = 'superseded',
         is_usable = FALSE,
         sanitization_version = 2,
         updated_at = NOW()
       WHERE source_id = $1`,
      [graphicRow.source_id]
    );

    for(const asset of assets){
      const assetIndex = Number(asset.assetIndex);

      if(!Number.isInteger(assetIndex) || assetIndex < 0){
        throw new Error(
          `assetIndex inválido en ${graphicRow.source_id}`
        );
      }

      await client.query(
        `INSERT INTO graphic_assets (
          source_id,
          topic_folder,
          source_file,
          public_url,
          asset_index,
          asset_type,
          concept,
          description,
          source_evidence,
          crop_x,
          crop_y,
          crop_width,
          crop_height,
          mask_regions,
          is_official_reference,
          is_usable,
          analysis_status,
          sanitization_version
        )
        VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,
          $10,$11,$12,$13,$14::jsonb,$15,$16,$17,$18
        )
        ON CONFLICT (source_id, asset_index)
        DO UPDATE SET
          topic_folder = EXCLUDED.topic_folder,
          source_file = EXCLUDED.source_file,
          public_url = EXCLUDED.public_url,
          asset_type = EXCLUDED.asset_type,
          concept = EXCLUDED.concept,
          description = EXCLUDED.description,
          source_evidence = EXCLUDED.source_evidence,
          crop_x = EXCLUDED.crop_x,
          crop_y = EXCLUDED.crop_y,
          crop_width = EXCLUDED.crop_width,
          crop_height = EXCLUDED.crop_height,
          mask_regions = EXCLUDED.mask_regions,
          is_official_reference = EXCLUDED.is_official_reference,
          is_usable = EXCLUDED.is_usable,
          analysis_status = EXCLUDED.analysis_status,
          sanitization_version = EXCLUDED.sanitization_version,
          updated_at = NOW()`,
        [
          graphicRow.source_id,
          graphicRow.topic_folder,
          graphicRow.source_file,
          graphicRow.public_url,
          assetIndex,
          analysis.useAsGroup === true ? "group" : "individual",
          asset.concept || null,
          asset.visualDescription || null,
          [
            analysis.sourceCaption,
            analysis.sourceText
          ].filter(Boolean).join("\n") || null,
          asset.crop?.x ?? null,
          asset.crop?.y ?? null,
          asset.crop?.width ?? null,
          asset.crop?.height ?? null,
          JSON.stringify(
            normalizeGraphicMaskRegions(
              asset.maskRegions,
              graphicRow.topic_folder
            )
          ),
          analysis.sourceType === "official_exam_reference",
          asset.usableForGraphicQuestion === true &&
            asset.needsImageToAnswer === true,
          asset.usableForGraphicQuestion === true
            ? "analyzed"
            : "rejected",
          2
        ]
      );
    }

    await client.query("COMMIT");
  }catch(error){
    await client.query("ROLLBACK");
    throw error;
  }finally{
    client.release();
  }
}
 
async function analyzePendingGraphicSources({ limit = 1 } = {}){
  const ai = aiClient();

  const pending = await db.query(
    `SELECT DISTINCT ON (source_id)
       source_id,
       topic_folder,
       source_file,
       public_url
     FROM graphic_assets
     WHERE analysis_status = 'pending'
     ORDER BY source_id, asset_index ASC
     LIMIT $1`,
    [limit]
  );

  const results = [];

  for(const graphicRow of pending.rows){
    try{
      console.log(
        `[graphics] Analizando ${graphicRow.source_id}`
      );

      const analysis = await analyzeGraphicSource(ai, graphicRow);

      await saveGraphicAnalysis(graphicRow, analysis);

      results.push({
        sourceId:graphicRow.source_id,
        ok:true,
        sourceType:analysis.sourceType,
        useAsGroup:analysis.useAsGroup,
        assets:analysis.assets.length
      });

      console.log(
        `[graphics] OK ${graphicRow.source_id}: ${analysis.assets.length} assets`
      );
  }catch(error){
  const errorMessage = error?.message || String(error);

  console.error(
    `[graphics] ERROR ${graphicRow.source_id}:`,
    errorMessage
  );

  await db.query(
    `UPDATE graphic_assets
     SET
       analysis_status = 'error',
       is_usable = FALSE,
       description = $2,
       updated_at = NOW()
     WHERE source_id = $1
       AND analysis_status = 'pending'`,
    [
      graphicRow.source_id,
      errorMessage
    ]
  );

  results.push({
    sourceId:graphicRow.source_id,
    ok:false,
    error:errorMessage
  });
}
  }

  return {
    requested:limit,
    pendingFound:pending.rows.length,
    results
  };
}
async function reanalyzeGraphicSourcesForSanitization({
  limit = 1,
  retryErrors = false
} = {}){
  const ai = aiClient();

  const pending = await db.query(
    `SELECT DISTINCT ON (source_id)
       source_id,
       topic_folder,
       source_file,
       public_url
     FROM graphic_assets
          WHERE sanitization_version < 2
       AND (
         analysis_status IN ('analyzed','rejected','error')
         OR (
           $2::boolean = TRUE
           AND analysis_status = 'sanitization_error'
         )
       )
     ORDER BY source_id, asset_index ASC
     LIMIT $1`,
    [limit,retryErrors]
  );

  const results = [];

  for(const graphicRow of pending.rows){
    try{
      console.log(
        `[graphics] Reanalizando sanitización ${graphicRow.source_id}`
      );

      const analysis = await analyzeGraphicSource(ai, graphicRow);

      await saveGraphicAnalysis(graphicRow, analysis);

      results.push({
        sourceId:graphicRow.source_id,
        ok:true,
        sourceType:analysis.sourceType,
        useAsGroup:analysis.useAsGroup,
        assets:analysis.assets.length
      });
    }catch(error){
      const errorMessage = error?.message || String(error);

      console.error(
        `[graphics] ERROR reanalizando ${graphicRow.source_id}:`,
        errorMessage
      );

      await db.query(
        `UPDATE graphic_assets
         SET
           analysis_status = 'sanitization_error',
           is_usable = FALSE,
           description = $2,
           updated_at = NOW()
         WHERE source_id = $1
           AND sanitization_version < 2`,
        [
          graphicRow.source_id,
          errorMessage
        ]
      );

      results.push({
        sourceId:graphicRow.source_id,
        ok:false,
        error:errorMessage
      });
    }
  }

  const remainingResult = await db.query(
    `SELECT COUNT(DISTINCT source_id)::int AS total
     FROM graphic_assets
     WHERE sanitization_version < 2
       AND analysis_status IN ('analyzed','rejected','error')`
  );

  const failedResult = await db.query(
    `SELECT COUNT(DISTINCT source_id)::int AS total
     FROM graphic_assets
     WHERE sanitization_version < 2
       AND analysis_status = 'sanitization_error'`
  );

  return {
    requested:limit,
    pendingFound:pending.rows.length,
    remainingSources:Number(remainingResult.rows[0]?.total || 0),
    failedSources:Number(failedResult.rows[0]?.total || 0),
    results
  };
}
function graphicTopicFolderFromTopicName(topicName){
  const text = String(topicName || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g,"")
    .toLowerCase();

  const rules = [
    ["teoria-fuego", ["teoria del fuego"]],
    ["incendios-interior", ["incendios de interior", "incendio de interior"]],
    ["hidraulica", ["hidraulica"]],
    ["tuneles", ["tuneles", "tunel"]],
    ["incendios-industriales", ["incendios industriales", "incendio industrial"]],
    ["incendios-vegetacion", ["incendios de vegetacion", "incendio de vegetacion"]],
    ["salvamento-altura", ["salvamento en altura", "salvamento altura"]],
    ["trafico", ["trafico"]],
    ["ferroviarios", ["ferroviario", "ferroviarios"]],
    ["apicola", ["apicola"]],
    ["edificacion-apeos", ["edificacion", "apeos"]],
    ["apeo-poda", ["apeo y poda", "poda de arbolado", "apeo de arbolado"]],
    ["estructuras-colapsadas", ["estructuras colapsadas", "estructura colapsada"]],
    ["ascensores", ["ascensores", "ascensor"]],
    ["electricidad", ["electricidad", "riesgo electrico"]],
    ["nrbq", ["nrbq"]],
    ["herramientas", ["herramientas"]],
    ["vehiculos", ["vehiculos", "vehiculo", "motores", "motor"]]
  ];

  for(const [folder,aliases] of rules){
    if(aliases.some(alias => text.includes(alias))){
      return folder;
    }
  }

  return null;
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
async function syncLegislationAnkiQuestions(){
  const indexPath=
    path.join(
      process.cwd(),
      "legislation_anki_index.json"
    );

  if(!fs.existsSync(indexPath)){
    console.log(
      "[anki-legislation] legislation_anki_index.json no encontrado."
    );
    return;
  }

  // 93K: no reescribir miles de preguntas Anki en cada despliegue
  // cuando el índice es idéntico al ya sincronizado.
  const indexRaw=fs.readFileSync(indexPath,"utf8");
  const indexHash=createHash("sha256").update(indexRaw).digest("hex");
  const syncKey="legislation_anki_index_sha256_v1";
  const previousSync=await db.query(
    "SELECT value FROM app_state WHERE key = $1",
    [syncKey]
  );
  let previousMarker=null;
  try{
    previousMarker=JSON.parse(previousSync.rows[0]?.value || "null");
  }catch(_error){
    previousMarker=null;
  }
  if(
    previousMarker?.sha256===indexHash &&
    Number.isInteger(previousMarker?.count) &&
    previousMarker.count>0
  ){
    const total=await db.query(
      "SELECT COUNT(*)::int AS total FROM legislation_anki_questions"
    );
    if(Number(total.rows[0]?.total)>=previousMarker.count){
      console.log(
        "[anki-legislation] Índice sin cambios; sincronización omitida:",
        previousMarker.count
      );
      return;
    }
  }

  const parsed=JSON.parse(indexRaw);

  const source=
    Array.isArray(parsed?.questions)
      ? parsed.questions
      : [];

  if(!source.length){
    throw new Error(
      "ANKI LEGISLACIÓN: el índice no contiene preguntas."
    );
  }

  const rows=
    source.map(question=>{
      const topic=
        String(question?.topic || "").trim();

      const topicMatch=
        topic.match(/^\s*(\d{1,2})\./);

      const options=
        Array.isArray(question?.options)
          ? question.options.map(
              option=>String(option || "").trim()
            )
          : [];

      const correctIndex=
        Number(question?.correctIndex);

      return {
        anki_note_id:
          Number(question?.ankiNoteId),

        topic_order:
          topicMatch
            ? Number(topicMatch[1])
            : null,

        deck_path:
          String(question?.deckPath || "").trim(),

        topic,

        stem:
          String(question?.stem || "").trim(),

        options,

        correct_index:
          correctIndex,

        correct_answer:
          String(
            question?.correctAnswer ||
            options[correctIndex] ||
            ""
          ).trim(),

        option_count:
          options.length,

        direct_use_eligible:
          [3,4].includes(options.length),

        tags:
          Array.isArray(question?.tags)
            ? question.tags
            : [],

        fingerprint:
          String(
            question?.fingerprint || ""
          ).trim()
      };
    });

  const invalid=
    rows.find(row=>
      !Number.isInteger(row.anki_note_id) ||
      !Number.isInteger(row.topic_order) ||
      row.topic_order < 1 ||
      row.topic_order > 11 ||
      !row.stem ||
      ![3,4].includes(row.option_count) ||
      !Number.isInteger(row.correct_index) ||
      row.correct_index < 0 ||
      row.correct_index >= row.option_count ||
      !row.fingerprint
    );

  if(invalid){
    throw new Error(
      `ANKI LEGISLACIÓN: registro inválido ${invalid.anki_note_id || "sin ID"}.`
    );
  }

  await db.query(
    `
    INSERT INTO legislation_anki_questions (
      anki_note_id,
      topic_order,
      deck_path,
      topic,
      stem,
      options,
      correct_index,
      correct_answer,
      option_count,
      direct_use_eligible,
      tags,
      fingerprint
    )

    SELECT
      x.anki_note_id,
      x.topic_order,
      x.deck_path,
      x.topic,
      x.stem,
      x.options,
      x.correct_index,
      x.correct_answer,
      x.option_count,
      x.direct_use_eligible,
      x.tags,
      x.fingerprint

    FROM jsonb_to_recordset(
      $1::jsonb
    ) AS x(
      anki_note_id BIGINT,
      topic_order INTEGER,
      deck_path TEXT,
      topic TEXT,
      stem TEXT,
      options JSONB,
      correct_index INTEGER,
      correct_answer TEXT,
      option_count INTEGER,
      direct_use_eligible BOOLEAN,
      tags JSONB,
      fingerprint TEXT
    )

    ON CONFLICT (anki_note_id)
    DO UPDATE SET
      topic_order = EXCLUDED.topic_order,
      deck_path = EXCLUDED.deck_path,
      topic = EXCLUDED.topic,
      stem = EXCLUDED.stem,
      options = EXCLUDED.options,
      correct_index = EXCLUDED.correct_index,
      correct_answer = EXCLUDED.correct_answer,
      option_count = EXCLUDED.option_count,
      direct_use_eligible = EXCLUDED.direct_use_eligible,
      tags = EXCLUDED.tags,
      fingerprint = EXCLUDED.fingerprint,
      updated_at = NOW()
    WHERE (
      legislation_anki_questions.topic_order,
      legislation_anki_questions.deck_path,
      legislation_anki_questions.topic,
      legislation_anki_questions.stem,
      legislation_anki_questions.options,
      legislation_anki_questions.correct_index,
      legislation_anki_questions.correct_answer,
      legislation_anki_questions.option_count,
      legislation_anki_questions.direct_use_eligible,
      legislation_anki_questions.tags,
      legislation_anki_questions.fingerprint
    ) IS DISTINCT FROM (
      EXCLUDED.topic_order,
      EXCLUDED.deck_path,
      EXCLUDED.topic,
      EXCLUDED.stem,
      EXCLUDED.options,
      EXCLUDED.correct_index,
      EXCLUDED.correct_answer,
      EXCLUDED.option_count,
      EXCLUDED.direct_use_eligible,
      EXCLUDED.tags,
      EXCLUDED.fingerprint
    )
    `,
    [
      JSON.stringify(rows)
    ]
  );

  // 93K: la marca se guarda solo después de completar la importación.
  await db.query(
    `INSERT INTO app_state (key,value) VALUES ($1,$2)
     ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`,
    [syncKey, JSON.stringify({sha256:indexHash,count:rows.length})]
  );

  const status=
    await db.query(`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (
          WHERE option_count = 4
        )::int AS four_options,
        COUNT(*) FILTER (
          WHERE option_count = 3
        )::int AS three_options
      FROM legislation_anki_questions
    `);

  console.log(
    "[anki-legislation]",
    JSON.stringify(status.rows[0])
  );
}

async function getLegislationAnkiValidationStatus(){
  const totals=await db.query(`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (
        WHERE validation_status = 'pending'
      )::int AS pending,
      COUNT(*) FILTER (
        WHERE validation_status = 'validated'
      )::int AS validated,
      COUNT(*) FILTER (
        WHERE validation_status = 'rejected'
      )::int AS rejected,
      COUNT(*) FILTER (
        WHERE option_count = 3
      )::int AS three_options,
      COUNT(*) FILTER (
        WHERE option_count = 4
      )::int AS four_options
    FROM legislation_anki_questions
  `);

  const byTopic=await db.query(`
    SELECT
      topic_order,
      MIN(topic) AS topic,
      COUNT(*)::int AS total,
      COUNT(*) FILTER (
        WHERE validation_status = 'pending'
      )::int AS pending,
      COUNT(*) FILTER (
        WHERE validation_status = 'validated'
      )::int AS validated,
      COUNT(*) FILTER (
        WHERE validation_status = 'rejected'
      )::int AS rejected
    FROM legislation_anki_questions
    GROUP BY topic_order
    ORDER BY topic_order ASC
  `);

  return {
    ...totals.rows[0],
    byTopic:byTopic.rows
  };
}

async function getLegislationTopicNamesForAnkiOrder(topicOrder){
  const result=await db.query(`
    SELECT
      name,
      topic_order
    FROM topics
    WHERE block = 'legislacion'
    ORDER BY topic_order ASC NULLS LAST, id ASC
  `);

  return result.rows
    .filter(row=>
      ankiLegislationSourceOrderForTopicName(
        row.name
      ) === Number(topicOrder)
    )
    .map(row=>row.name);
}

const legislationAnkiValidationSchema={
  type:"object",
  properties:{
    results:{
      type:"array",
      items:{
        type:"object",
        properties:{
          ankiNoteId:{type:"integer"},
          valid:{type:"boolean"},
          reason:{type:"string"},
          evidence:{type:"string"}
        },
        required:[
          "ankiNoteId",
          "valid",
          "reason",
          "evidence"
        ]
      }
    }
  },
  required:["results"]
};

async function validateLegislationAnkiBatch({
  topicOrder=null,
  limit=10
}={}){
  if(!STORE){
    throw new Error(
      "ANKI LEGISLACIÓN: el File Search factual todavía no está cargado."
    );
  }

  const safeLimit=
    Math.min(
      Math.max(
        Number(limit) || 10,
        1
      ),
      20
    );

  let effectiveTopicOrder=
    topicOrder === null ||
    topicOrder === undefined ||
    String(topicOrder).trim() === ""
      ? null
      : Number(topicOrder);

  if(effectiveTopicOrder == null){
    const nextTopic=await db.query(`
      SELECT topic_order
      FROM legislation_anki_questions
      WHERE validation_status = 'pending'
      ORDER BY topic_order ASC, id ASC
      LIMIT 1
    `);

    if(!nextTopic.rows.length){
      return {
        processed:0,
        topicOrder:null,
        complete:true,
        status:
          await getLegislationAnkiValidationStatus()
      };
    }

    effectiveTopicOrder=
      Number(nextTopic.rows[0].topic_order);
  }

  if(
    !Number.isInteger(effectiveTopicOrder) ||
    effectiveTopicOrder < 1 ||
    effectiveTopicOrder > 11
  ){
    throw new Error(
      "ANKI LEGISLACIÓN: topicOrder debe estar entre 1 y 11."
    );
  }

  const pending=await db.query(
    `
    SELECT
      id,
      anki_note_id,
      topic_order,
      topic,
      stem,
      options,
      correct_index,
      correct_answer,
      option_count
    FROM legislation_anki_questions
    WHERE
      validation_status = 'pending'
      AND topic_order = $1
    ORDER BY id ASC
    LIMIT $2
    `,
    [
      effectiveTopicOrder,
      safeLimit
    ]
  );

  if(!pending.rows.length){
    return {
      processed:0,
      topicOrder:effectiveTopicOrder,
      complete:true,
      status:
        await getLegislationAnkiValidationStatus()
    };
  }

  const relatedTopicNames=
    await getLegislationTopicNamesForAnkiOrder(
      effectiveTopicOrder
    );

  const questions=
    pending.rows.map(row=>({
      ankiNoteId:
        Number(row.anki_note_id),

      topic:
        row.topic,

      stem:
        row.stem,

      options:
        row.options,

      correctIndex:
        Number(row.correct_index),

      markedCorrectAnswer:
        row.correct_answer,

      optionCount:
        Number(row.option_count)
    }));

  const runtimeSchema=
    structuredClone(
      legislationAnkiValidationSchema
    );

  runtimeSchema.properties.results.minItems=
    questions.length;

  runtimeSchema.properties.results.maxItems=
    questions.length;

  const prompt=`
Eres un auditor factual estricto de preguntas de LEGISLACIÓN
para una oposición de Bomberos de Navarra.

FUENTE DE VERDAD:
- Utiliza EXCLUSIVAMENTE File Search sobre los PDF del temario factual.
- NO uses conocimiento general, memoria propia, el banco Anki ni los exámenes
  oficiales como fuente factual.
- El banco Anki que recibes es únicamente el OBJETO que debes comprobar.
- Si el temario recuperado no permite demostrar con seguridad la respuesta,
  marca valid=false.

BLOQUE ANKI:
${effectiveTopicOrder}

DENOMINACIÓN ANKI:
${pending.rows[0]?.topic || "No especificada"}

TEMAS/DOCUMENTOS FACTUALES RELACIONADOS EN LA APLICACIÓN:
${relatedTopicNames.length
  ? relatedTopicNames.map(name=>`- ${name}`).join("\n")
  : "- No se ha podido identificar por nombre. Busca en los PDF factuales únicamente por el contenido normativo de la pregunta."}

TAREA PARA CADA PREGUNTA:
1. Comprueba el enunciado contra el temario factual.
2. Comprueba que la opción indicada por correctIndex sea correcta.
3. Comprueba que ninguna otra opción sea también correcta según la polaridad
   exacta del enunciado.
4. Respeta preguntas originales de 3 o de 4 opciones: ambas son válidas.
5. NO rechaces una pregunta por estilo, longitud o redacción si es
   factualmente correcta y unívoca.
6. Si existe contradicción con el temario o falta soporte suficiente para
   demostrar la respuesta, valid=false.
7. evidence debe resumir de forma breve el contenido factual recuperado que
   permite comprobar la respuesta. No inventes artículos, cifras ni normas.
8. reason debe explicar brevemente por qué se valida o se rechaza.

Devuelve EXACTAMENTE un resultado por pregunta, en el mismo orden y con
el mismo ankiNoteId.

PREGUNTAS:
${JSON.stringify(questions)}
`;

  const ai=aiClient();

  let parsed=null;
  let lastValidationError=null;

  for(let attempt=1; attempt<=6; attempt++){
    try{
      const response=
        await ai.models.generateContent({
          model:"gemini-3.5-flash-lite",
          contents:prompt,
          config:{
            tools:[{
              fileSearch:{
                fileSearchStoreNames:[STORE]
              }
            }],
            responseMimeType:"application/json",
            responseJsonSchema:runtimeSchema
          }
        });

      const rawText=
        typeof response?.text === "string"
          ? response.text.trim()
          : "";

      if(!rawText){
        throw new Error(
          "ANKI LEGISLACIÓN: Gemini devolvió una respuesta vacía."
        );
      }

      parsed=JSON.parse(rawText);
      lastValidationError=null;
      break;

    }catch(error){
      lastValidationError=error;

      console.warn(
        "ANKI VALIDATION BATCH RETRY",
        JSON.stringify({
          topicOrder:effectiveTopicOrder,
          attempt,
          maxAttempts:6,
          error:error?.message || String(error)
        })
      );

      if(attempt < 6){
        const delays=[2000,4000,8000,15000,30000];
        await sleep(delays[attempt-1] || 30000);
      }
    }
  }

  if(!parsed){
    throw new Error(
      `ANKI LEGISLACIÓN: no se pudo validar el lote tras 6 intentos. ${
        lastValidationError?.message || "Respuesta inválida de Gemini."
      }`
    );
  }

  if(
    !Array.isArray(parsed?.results) ||
    parsed.results.length !== questions.length
  ){
    throw new Error(
      "ANKI LEGISLACIÓN: el validador no devolvió un resultado por pregunta."
    );
  }

  const expectedIds=
    questions.map(
      question=>Number(question.ankiNoteId)
    );

  for(let i=0;i<parsed.results.length;i++){
    const result=parsed.results[i];

    if(
      Number(result.ankiNoteId) !==
      expectedIds[i]
    ){
      throw new Error(
        "ANKI LEGISLACIÓN: el validador devolvió IDs u orden inconsistentes."
      );
    }
  }

  const client=
    await db.connect();

  try{
    await client.query("BEGIN");

    for(const result of parsed.results){
      await client.query(
        `
        UPDATE legislation_anki_questions
        SET
          validation_status = $2,
          validation_reason = $3,
          validation_evidence = $4,
          validated_at = NOW(),
          updated_at = NOW()
        WHERE anki_note_id = $1
        `,
        [
          Number(result.ankiNoteId),
          result.valid === true
            ? "validated"
            : "rejected",
          String(result.reason || "").trim() || null,
          String(result.evidence || "").trim() || null
        ]
      );
    }

    await client.query("COMMIT");

  }catch(error){
    await client.query("ROLLBACK");
    throw error;

  }finally{
    client.release();
  }

  const validated=
    parsed.results.filter(
      result=>result.valid === true
    ).length;

  const rejected=
    parsed.results.length - validated;

  return {
    processed:parsed.results.length,
    topicOrder:effectiveTopicOrder,
    topic:
      pending.rows[0]?.topic || null,
    factualTopics:
      relatedTopicNames,
    validated,
    rejected,
    complete:false,
    results:parsed.results,
    status:
      await getLegislationAnkiValidationStatus()
  };
}


const legislationAnkiValidationRunner = {
  running:false,
  startedAt:null,
  finishedAt:null,
  processed:0,
  validated:0,
  rejected:0,
  batches:0,
  lastTopicOrder:null,
  lastError:null
};

async function runLegislationAnkiValidationQueue({
  batchSize=20,
  delayMs=750
}={}){
  if(legislationAnkiValidationRunner.running){
    return;
  }

  legislationAnkiValidationRunner.running=true;
  legislationAnkiValidationRunner.startedAt=
    new Date().toISOString();
  legislationAnkiValidationRunner.finishedAt=null;
  legislationAnkiValidationRunner.processed=0;
  legislationAnkiValidationRunner.validated=0;
  legislationAnkiValidationRunner.rejected=0;
  legislationAnkiValidationRunner.batches=0;
  legislationAnkiValidationRunner.lastTopicOrder=null;
  legislationAnkiValidationRunner.lastError=null;

  try{
    while(true){
      const status=
        await getLegislationAnkiValidationStatus();

      const pending=
        Number(status?.pending || 0);

      if(pending <= 0){
        break;
      }

      const batch=
        await validateLegislationAnkiBatch({
          topicOrder:null,
          limit:batchSize
        });

      if(!batch?.processed){
        break;
      }

      legislationAnkiValidationRunner.processed +=
        Number(batch.processed || 0);

      legislationAnkiValidationRunner.validated +=
        Number(batch.validated || 0);

      legislationAnkiValidationRunner.rejected +=
        Number(batch.rejected || 0);

      legislationAnkiValidationRunner.batches += 1;

      legislationAnkiValidationRunner.lastTopicOrder=
        batch.topicOrder ?? null;

      console.log(
        "[anki-legislation-runner]",
        JSON.stringify({
          batch:
            legislationAnkiValidationRunner.batches,
          topicOrder:
            batch.topicOrder,
          processed:
            batch.processed,
          validated:
            batch.validated,
          rejected:
            batch.rejected,
          remaining:
            Number(batch?.status?.pending || 0)
        })
      );

      if(delayMs > 0){
        await sleep(delayMs);
      }
    }

  }catch(error){
    legislationAnkiValidationRunner.lastError=
      error?.message || String(error);

    console.error(
      "ANKI VALIDATION RUNNER ERROR:",
      error
    );

  }finally{
    legislationAnkiValidationRunner.running=false;
    legislationAnkiValidationRunner.finishedAt=
      new Date().toISOString();

    console.log(
      "[anki-legislation-runner] finalizado",
      JSON.stringify(
        legislationAnkiValidationRunner
      )
    );
  }
}

app.get(
  "/api/legislation-anki/validation-runner-status",
  async(req,res)=>{
    try{
      res.json({
        ok:true,
        runner:{
          ...legislationAnkiValidationRunner
        },
        status:
          await getLegislationAnkiValidationStatus()
      });

    }catch(error){
      res.status(500).json({
        ok:false,
        error:error?.message || String(error)
      });
    }
  }
);

app.get(
  "/api/legislation-anki/validation-run",
  async(req,res)=>{
    try{
      const batchSize=
        Math.min(
          Math.max(
            Number(req.query?.batchSize) || 20,
            1
          ),
          20
        );

      if(!legislationAnkiValidationRunner.running){
        setImmediate(()=>{
          runLegislationAnkiValidationQueue({
            batchSize,
            delayMs:750
          }).catch(error=>{
            console.error(
              "ANKI VALIDATION RUNNER UNHANDLED:",
              error
            );
          });
        });
      }

      res.json({
        ok:true,
        started:
          !legislationAnkiValidationRunner.running,
        message:
          "Validación automática iniciada o ya en ejecución.",
        runner:{
          ...legislationAnkiValidationRunner
        },
        status:
          await getLegislationAnkiValidationStatus()
      });

    }catch(error){
      console.error(
        "ANKI VALIDATION RUN START ERROR:",
        error
      );

      res.status(500).json({
        ok:false,
        error:error?.message || String(error)
      });
    }
  }
);

app.get(
  "/api/legislation-anki/validation-status",
  async(req,res)=>{
    try{
      res.json({
        ok:true,
        status:
          await getLegislationAnkiValidationStatus()
      });

    }catch(error){
      console.error(
        "ANKI VALIDATION STATUS ERROR:",
        error
      );

      res.status(500).json({
        ok:false,
        error:error?.message || String(error)
      });
    }
  }
);

app.get(
  "/api/legislation-anki/validate-next",
  async(req,res)=>{
    try{
      const rawTopicOrder=
        req.query?.topicOrder;

      const topicOrder=
        rawTopicOrder == null ||
        rawTopicOrder === ""
          ? null
          : Number(rawTopicOrder);

      const limit=
        Number(req.query?.limit || 10);

      const result=
        await validateLegislationAnkiBatch({
          topicOrder,
          limit
        });

      res.json({
        ok:true,
        ...result
      });

    }catch(error){
      console.error(
        "ANKI VALIDATION ERROR:",
        error
      );

      res.status(500).json({
        ok:false,
        error:error?.message || String(error)
      });
    }
  }
);

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

// Sustitución por identidad del conocimiento, sin borrar preguntas ni sesiones históricas.
// La referencia al nuevo documento se confirma en la MISMA transacción que la cobertura.
async function saveCoverageItems(topicId, items, documentName){
  const client=await db.connect();
  try{
    await client.query("BEGIN");
    await client.query("SELECT id FROM topics WHERE id=$1 FOR UPDATE",[topicId]);
    const unique=new Map();
    for(const item of items){
      unique.set(JSON.stringify([item.concept,item.itemType,item.evaluationType]),item);
    }
    const oldRows=await client.query(`SELECT id,concept,item_type,evaluation_type,source_evidence
      FROM coverage_items WHERE topic_id=$1`,[topicId]);
    const priorByKey=new Map(oldRows.rows.map(row=>[
      JSON.stringify([row.concept,row.item_type,row.evaluation_type]),row]));
    const changed=[];
    const keep=[];
    for(const item of unique.values()){
      const previous=priorByKey.get(JSON.stringify([item.concept,item.itemType,item.evaluationType]));
      if(previous && String(previous.source_evidence||"")!==String(item.sourceEvidence||""))
        changed.push(previous.id);
      const row=await client.query(`
        INSERT INTO coverage_items
          (topic_id,section,concept,item_type,evaluation_type,
           source_page,manual_page,source_evidence,exam_relevant)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,TRUE)
        ON CONFLICT (topic_id,concept,item_type,evaluation_type)
        DO UPDATE SET section=EXCLUDED.section,
          source_page=EXCLUDED.source_page,
          manual_page=EXCLUDED.manual_page,
          source_evidence=EXCLUDED.source_evidence,
          exam_relevant=TRUE
        RETURNING id`,[topicId,item.section||null,item.concept,
          item.itemType,item.evaluationType,item.sourcePage??null,
          item.manualPage??null,item.sourceEvidence||null]);
      keep.push(row.rows[0].id);
    }
    // Los elementos eliminados del PDF dejan de ser seleccionables. Se conservan
    // físicamente si hay preguntas o estadísticas referenciándolos.
    const retired=await client.query(`UPDATE coverage_items SET exam_relevant=FALSE
      WHERE topic_id=$1 AND exam_relevant=TRUE
        AND item_type<>'anki_independent'
        AND NOT(id=ANY($2::int[])) RETURNING id`,[topicId,keep]);
    const deactivate=[...new Set([...changed,...retired.rows.map(row=>row.id)])];
    if(deactivate.length){
      await client.query(`UPDATE question_bank SET active=FALSE
        WHERE coverage_item_id=ANY($1::int[])`,[deactivate]);
    }
    await client.query(`DELETE FROM coverage_items ci
      WHERE ci.topic_id=$1 AND ci.exam_relevant=FALSE
        AND ci.item_type<>'anki_independent' 
        AND ci.worked=FALSE AND ci.times_asked=0
        AND ci.times_correct=0 AND ci.times_wrong=0 AND ci.times_blank=0
        AND NOT EXISTS(SELECT 1 FROM question_bank qb WHERE qb.coverage_item_id=ci.id)
        AND NOT EXISTS(SELECT 1 FROM test_session_questions sq WHERE sq.coverage_item_id=ci.id)
        AND NOT EXISTS(SELECT 1 FROM coverage_review_state rs WHERE rs.coverage_item_id=ci.id)
        AND NOT EXISTS(SELECT 1 FROM legislation_anki_questions aq WHERE aq.validated_coverage_item_id=ci.id)`,[topicId]);
    await client.query(`UPDATE topics SET file_search_indexed=TRUE,
      total_items=(SELECT COUNT(*) FROM coverage_items
        WHERE topic_id=$1 AND exam_relevant=TRUE),
      worked_items=(SELECT COUNT(*) FROM coverage_items
        WHERE topic_id=$1 AND exam_relevant=TRUE AND worked=TRUE)
      WHERE id=$1`,[topicId]);
    await client.query(`INSERT INTO topic_source_documents(topic_id,document_name)
      VALUES($1,$2) ON CONFLICT(topic_id) DO UPDATE
      SET document_name=EXCLUDED.document_name,updated_at=NOW()`,[topicId,documentName]);
    await client.query("COMMIT");
  }catch(error){
    await client.query("ROLLBACK");
    throw error;
  }finally{client.release();}
}
// Los servidores anteriores identificaban las fuentes por nombre de tema;
// los actuales también utilizan "tema-ID-...". Reconocer ambas formas evita
// volver a indexar un tema ignorando una fuente antigua.
function normalizeTopicDocumentName(value){
  return String(value||"").normalize("NFD")
    .replace(/[\u0300-\u036f]/g,"")
    .toLowerCase().replace(/\.pdf$/i,"")
    .replace(/[^a-z0-9]+/g," ").trim();
}
function documentsBelongingToTopic(documents,topic,previousName){
  const aliases=new Set([topic.name,topic.source_file]
    .map(normalizeTopicDocumentName).filter(Boolean));
  const prefix=`tema-${Number(topic.id)}-`;
  const found=new Map();
  for(const doc of documents){
    if(!doc?.name)continue;
    const label=String(doc.displayName||"");
    if(doc.name===previousName || label.startsWith(prefix) ||
       aliases.has(normalizeTopicDocumentName(label))){
      found.set(doc.name,doc);
    }
  }
  return [...found.values()];
}
async function listFactualDocuments(ai,store){
  // @google/genai devuelve un Pager<Document>, no {documents,nextPageToken}.
  // El iterador realiza automáticamente la paginación de 20 en 20.
  const pager=await ai.fileSearchStores.documents.list({
    parent:store,config:{pageSize:20}
  });
  const docs=[];
  for await(const document of pager){
    if(document?.name)docs.push(document);
  }
  return docs;
}
async function replaceTopicDocument(topic,pdfPath,items){
  const ai=aiClient();
  const store=await ensureStore();
  const known=await db.query(
    "SELECT document_name FROM topic_source_documents WHERE topic_id=$1",
    [topic.id]);
  const previousName=known.rows[0]?.document_name||null;
  const documents=await listFactualDocuments(ai,store);
  const oldDocs=documentsBelongingToTopic(documents,topic,previousName);
  if(!oldDocs.length && topic.file_search_indexed){
    // En instalaciones antiguas el indicador se activaba aun sin conservar
    // un ID de documento. Un cero en la lista no justifica cancelar la carga.
    console.warn(`[coverage] ${topic.name}: indicador antiguo de indexación `+
      `sin documento localizable; se sustituirá la cobertura validada.`);
  }
  if(previousName && !documents.some(d=>d.name===previousName)){
    console.warn(`[coverage] ${topic.name}: puntero antiguo sin documento `+
      `en File Search: ${previousName}`);
  }
  const displayName=`tema-${topic.id}-${Date.now()}-`+
    Math.random().toString(36).slice(2,8);
  let newDoc=null;
  let saved=false;
  try{
    const uploaded=await ingest(pdfPath,displayName,true);
    // La respuesta de la operación de subida es la fuente primaria del ID.
    // Evita depender de la visibilidad inmediata del listado de documentos.
    if(uploaded.documentName){
      newDoc={name:uploaded.documentName,displayName};
    }else{
      for(let attempt=0;attempt<4;attempt++){
        const updated=await listFactualDocuments(ai,store);
        newDoc=updated.find(doc=>doc.displayName===displayName);
        if(newDoc?.name)break;
        await sleep(2000);
      }
    }
    if(!newDoc?.name)throw new Error(
      "La operación de subida no devolvió documentName y la fuente no "+
      "figura en el listado; se conserva la cobertura anterior.");
    await saveCoverageItems(topic.id,items,newDoc.name);
    saved=true;
  }catch(error){
    if(!saved){
      // Si se indexó pero la consulta de documentos falló, buscar por el
      // nombre ÚNICO de esta operación antes de abandonar el intento.
      try{
        const candidates=newDoc?.name?[newDoc]:
          (await listFactualDocuments(ai,store)).filter(d=>
            d.displayName===displayName);
        for(const doc of candidates){
          await ai.fileSearchStores.documents.delete({
            name:doc.name,config:{force:true}
          });
        }
      }catch(cleanupError){
        console.error("[coverage] Fuente nueva pendiente de limpieza",cleanupError);
      }
    }
    throw error;
  }
  // El registro nuevo y su cobertura ya se guardaron conjuntamente en PG.
  // Solo ahora eliminar las fuentes anteriores del MISMO tema.
  const errors=[];
  for(const doc of oldDocs){
    if(doc.name===newDoc.name)continue;
    try{
      await ai.fileSearchStores.documents.delete({
        name:doc.name,config:{force:true}
      });
    }catch(error){
      errors.push(doc.name);
      console.error(`[coverage] No se ha podido eliminar ${doc.name}`,error);
    }
  }
  if(errors.length){
    throw new Error("La cobertura nueva ya está guardada, pero no se pudieron "+
      "retirar estas fuentes antiguas de File Search: "+errors.join(", ")+
      ". No generes tests de este tema hasta resolverlo.");
  }
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
function coverageTopicNumber(topicName){
  const normalized=String(topicName || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g,"")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g," ")
    .trim();

  const match=normalized.match(
    /(?:^|\s)tema\s*(\d+)(?:\s|$)/
  );

  return match
    ? Number(match[1])
    : null;
}
function coverageTopicRulesPrompt(topicName){
  const topicNumber=
    coverageTopicNumber(topicName);

   if(topicNumber===21){
  return `
REGLAS ESPECÍFICAS DEL TEMA 21 — PARQUES, MUNICIPIOS Y CONCEJOS:

Este tema contiene relaciones territoriales que deben conservarse
con absoluta precisión.

IMPORTANTE:
Estas reglas estructurales se aplican especialmente al apartado
"1.9. ANEXO I. POBLACIÓN QUE ATIENDEN INICIALMENTE LOS PARQUES DE BOMBEROS".

El resto del documento debe seguir analizándose normalmente y también deben
extraerse todos sus demás datos examinables: características de los parques,
cifras, clasificaciones, mapas de riesgos, sedes, intervenciones, efectivos,
mando y cualquier otro contenido sustentado por el PDF.

==================================================
A) MUNICIPIOS, ENTIDADES O ÁMBITOS PRINCIPALES
==================================================

En el ANEXO I, cada municipio, entidad territorial o ámbito principal
que aparece directamente bajo un parque o una sede debe convertirse
en UN elemento independiente.

NO agrupes varios municipios en un mismo elemento.

Para CADA relación territorial principal usa obligatoriamente:

section="Tema 21 - municipios y ámbitos"
itemType="relacion"
evaluationType="pertenencia_exclusion"

El concept debe identificar inequívocamente:

ENTIDAD -> PARQUE/SEDE O RADIO QUE LA ATIENDE

Ejemplos de estructura conceptual:

"Municipio de Andosilla -> Sede de Lodosa"
"Municipio de Ituren -> Parque de Oronoz"
"Pamplona/Iruña -> Trinitarios"

NO uses conceptos genéricos como:
"municipios atendidos por Estella-Lizarra"
o
"municipios desde X hasta Y".

Cada municipio debe existir individualmente.

Si la misma denominación territorial aparece legítimamente asociada
a dos ámbitos distintos, conserva AMBAS relaciones como conocimientos
diferentes. No las deduzcas ni fusiones por compartir nombre.

Bardenas Reales debe tratarse como una entidad/ámbito territorial
principal aunque no sea un municipio.

OBJETIVO ESTRUCTURAL GLOBAL DEL ANEXO I:
deben existir al menos 275 relaciones independientes de esta categoría.

==================================================
B) CONCEJOS Y LOCALIDADES SUBORDINADAS
==================================================

Cada concejo o localidad subordinada debe convertirse también
en UN elemento independiente.

NO agrupes varios concejos o localidades en un mismo concept.

Para CADA concejo o localidad usa obligatoriamente:

section="Tema 21 - concejos y localidades"
itemType="relacion"
evaluationType="pertenencia_exclusion"

El concept debe conservar, siempre que el PDF permita determinarlo:

CONCEJO/LOCALIDAD -> MUNICIPIO PADRE -> PARQUE/SEDE O RADIO

Ejemplo:

"Aritzu -> Anue -> Cordovilla"

Si el documento dice:

"Concejos: Aritzu, Burutain, Egozkue..."

debes crear un elemento independiente para Aritzu,
otro para Burutain, otro para Egozkue, etc.

También debes tratar de forma individual:

- los casos escritos en singular como "Concejo: Rada";
- las localidades subordinadas que aparecen bajo un municipio aunque
  el documento no utilice expresamente la palabra "Concejos";
- las localidades de Baztan enumeradas inmediatamente bajo Baztan.

NO crees un único elemento como:

"Concejos de Anue: Aritzu, Burutain, Egozkue..."

porque eso impide controlar individualmente cada relación.

OBJETIVO ESTRUCTURAL GLOBAL DEL ANEXO I:
deben existir al menos 357 relaciones independientes de esta categoría.

==================================================
C) RELACIÓN PARQUE -> MUNICIPIO -> CONCEJO
==================================================

Conserva siempre los tres niveles cuando el documento permita determinarlos:

PARQUE/RADIO -> MUNICIPIO -> CONCEJO O LOCALIDAD

Respeta estrictamente los cambios de:

- parque;
- sede;
- municipio padre;
- página;
- posición vertical y orden de lectura dentro de la misma página.

REGLA DE ORDEN DENTRO DE UNA PÁGINA:

Una cabecera de parque, sede o municipio SOLO afecta a los elementos
que aparecen DESPUÉS de esa cabecera en el orden normal de lectura.

NUNCA apliques una cabecera hacia atrás a municipios, concejos o
localidades que aparecen antes de ella en la misma página.

Si una página contiene primero la continuación de un parque anterior
y más abajo comienza un parque nuevo:

1. los elementos anteriores a la nueva cabecera siguen perteneciendo
   al parque o sede que venía de la página anterior;

2. únicamente los elementos posteriores a la nueva cabecera pertenecen
   al nuevo parque o sede.

EJEMPLOS REALES DE ESTE DOCUMENTO:

- En la página manual 19, Ituren, Lesaka, Oiz, Saldias, Sunbilla,
  Urdazubi/Urdax, Urroz, Zubieta y Zugarramurdi siguen perteneciendo
  al PARQUE DE ORONOZ.

  Solo DESPUÉS de la cabecera
  "f) Parque Central de Pamplona/Iruña"
  comienza el ámbito del Parque Central/Cordovilla.

- En la página manual 13, Orbaizeta, Orbara,
  Oroz-Betelu/Orotz-Betelu y Orreaga/Roncesvalles siguen perteneciendo
  a la SEDE DE AURITZ/BURGUETE.

  Solo DESPUÉS de la cabecera
  "b) Parque de Estella-Lizarra"
  comienzan los municipios de Estella-Lizarra.

NO atribuyas automáticamente a una nueva página el último municipio,
parque o sede de la página anterior si la continuidad del documento
no lo confirma.

Usa el contexto de continuidad únicamente cuando la estructura del PDF
demuestre que el listado continúa.

Ante cualquier conflicto entre una cabecera anterior y una cabecera
posterior de la misma página, manda siempre el ORDEN REAL DE LECTURA
DEL PDF.
==================================================
D) REGLA ESPECÍFICA DEL PARQUE CENTRAL
==================================================

Para este proyecto:

- existen 12 sedes físicas de parque pero 11 radios territoriales
  generales de actuación;
- Pamplona dispone de las sedes de Trinitarios y Cordovilla;
- TRINITARIOS se considera exclusivamente para la ciudad
  de Pamplona/Iruña;
- el resto de municipios, concejos y localidades adscritos al
  Parque Central deben asociarse a CORDOVILLA.

Por tanto:

Pamplona/Iruña -> Trinitarios

y las restantes relaciones del ámbito territorial del Parque Central:

municipio/concejo/localidad -> Cordovilla

==================================================
E) PROHIBICIONES
==================================================

NO:

- agrupes varios municipios en una misma unidad;
- agrupes varios concejos en una misma unidad;
- sustituyas entradas individuales por resúmenes de listas;
- elimines una relación porque otra tenga un nombre parecido;
- mezcles concejos pertenecientes a municipios distintos;
- mezcles municipios de parques o sedes distintos;
- inventes relaciones territoriales;
- deduzcas relaciones que el PDF no permita establecer;
- utilices conocimiento externo para completar el documento.

sourceEvidence debe conservar siempre evidencia literal suficiente
para comprobar la relación concreta.

Antes de finalizar el análisis completo del documento verifica que,
como mínimo, el ANEXO I contiene:

- 275 relaciones independientes en
  "Tema 21 - municipios y ámbitos";
- 357 relaciones independientes en
  "Tema 21 - concejos y localidades".

Estas unidades estructurales NO sustituyen al resto del contenido
examinable del Tema 21, que también debe conservarse.
`;
}

  if(topicNumber===22){
    return `
REGLAS ESPECÍFICAS DEL TEMA 22 — ACTIVIDADES INDUSTRIALES:

Este tema contiene una tabla de emplazamientos y ámbitos industriales.

REGLA FUNDAMENTAL:

TODO registro de la tabla es materia de estudio,
independientemente de la denominación concreta que utilice,
SALVO las filas identificadas expresamente con el término
"Área industrial" seguido de su numeración o código.

Por tanto:

- NO limites la extracción a registros cuyo nombre contenga
  "Polígono Industrial";

- conserva también cualquier registro denominado, por ejemplo,
  parque empresarial, zona, sector, ciudad, campus empresarial,
  área de actividades económicas, polígono, instalación industrial
  o cualquier otra denominación presente en la tabla;

- la denominación concreta del registro NO determina su exclusión.

ÚNICA EXCLUSIÓN:

Excluye exclusivamente las filas cuyo nombre corresponda al patrón:

"Área industrial" + numeración/código

Ejemplos de filas que deben EXCLUIRSE:

"Área industrial 202-1"
"Área industrial 104-1"
"Área industrial 902-3"

No generes ninguna unidad examinable sobre esas filas.

Cualquier otra fila de la tabla debe conservarse.
CONTROL ESTRUCTURAL OBLIGATORIO:

La tabla completa contiene 702 filas numeradas.

De ellas:
- 493 filas son "Área industrial" + código y deben EXCLUIRSE;
- 209 filas son registros válidos y deben CONSERVARSE.

Por tanto, en el conjunto completo del documento deben quedar
representadas exactamente las 209 filas válidas.

En cada fragmento de PDF que recibas:

- devuelve EXACTAMENTE UNA unidad de cobertura por cada fila válida
  presente en ese fragmento;
- NO agrupes varias filas en una sola unidad;
- NO resumas conjuntos de registros;
- NO omitas una fila válida aunque su denominación sea poco habitual;
- NO intentes generar 209 elementos dentro de un único fragmento:
  devuelve únicamente las filas válidas físicamente presentes
  en las páginas recibidas.

El campo sourceEvidence de cada unidad debe comenzar SIEMPRE
con el número de fila original de la tabla.
Para CADA registro válido conserva exactamente:

- número de fila, cuando aparezca;
- denominación completa;
- municipio o municipios asociados;
- parque de bomberos asociado;
- superficie/área;
- perímetro.

Cada fila válida debe permanecer como una unidad independiente.

La relación:

REGISTRO -> MUNICIPIO -> PARQUE DE BOMBEROS

debe quedar expresamente representada y ser preguntable.

Los valores de área/superficie, perímetro y número de fila
deben conservarse por fidelidad documental e identificación
del registro, pero NO constituyen por sí mismos objetivos
prioritarios de pregunta en la generación automática.

La prioridad examinable es:

REGISTRO -> MUNICIPIO -> PARQUE DE BOMBEROS.
NO:

- mezcles datos de filas consecutivas;
- atribuyas a un registro el municipio de otro;
- atribuyas a un registro el parque de otro;
- atribuyas a un registro el área o perímetro de otro;
- excluyas una fila válida por no contener las palabras
  "Polígono Industrial";
- incluyas filas "Área industrial" numeradas.

La prioridad es conservar TODAS las filas válidas de la tabla,
excluyendo únicamente las filas "Área industrial" numeradas.
`;
  }

  if(topicNumber===23){
    return `
REGLAS ESPECÍFICAS DEL TEMA 23 — PARQUES SOLARES:

Cada fila representa un parque solar concreto.

Conserva de forma vinculada, sin mezclar instalaciones:
- denominación exacta y fase I/II/III cuando conste;
- municipio o concejo, únicamente si figura literalmente;
- orientación, carreteras y referencias geográficas completas;
- parque de bomberos según el epígrafe de la ficha.

La relación INSTALACIÓN -> UBICACIÓN DOCUMENTADA -> PARQUE DE BOMBEROS
se mantiene explícita; no atribuyas un parque por proximidad.
No preguntes por potencia, promotor ni año de puesta en servicio,
que no forman parte del documento manuscrito definitivo.

La prioridad examinable es:

PARQUE SOLAR -> MUNICIPIO -> PARQUE DE BOMBEROS.

NO mezcles columnas ni datos pertenecientes a instalaciones diferentes.
`;
  }

  if(topicNumber===24){
    return `
REGLAS ESPECÍFICAS DEL TEMA 24 — PARQUES EÓLICOS:

Cada fila representa un parque eólico concreto.

Conserva exactamente:
- nombre del parque eólico;
- municipio o municipios asociados;
- parque de bomberos asociado.

La relación PARQUE EÓLICO -> MUNICIPIO -> PARQUE DE BOMBEROS
es prioritaria.

Si una instalación afecta a varios municipios,
conserva todos los municipios asociados sin reducirlos a uno.

NO mezcles información entre filas.
`;
  }

  if(topicNumber===25){
    return `
REGLAS ESPECÍFICAS DEL TEMA 25 — HELIPUERTOS Y HELISUPERFICIES:

Cada fila representa una instalación concreta.

Conserva exactamente las relaciones entre:
- nombre;
- municipio;
- uso o clase indicada;
- estado;
- tipo.

Distingue expresamente cuando corresponda:
- helisuperficie;
- aeródromo;
- aeropuerto;
- hospital;
- policía;
- estadio;
- parque de bomberos;
- otras categorías que aparezcan literalmente.

Conserva también si está activa o inoperativa
y si es en superficie, terraza, pináculo o cualquier otro tipo indicado.

NO mezcles datos de instalaciones distintas.
`;
  }

  if(topicNumber===26){
  return `
REGLAS ESPECÍFICAS DEL TEMA 26 — RED DEL FERROCARRIL:

Este tema contiene una tabla ferroviaria con celdas combinadas.
NO debes interpretar cada línea visual como si todas las columnas
se repitieran expresamente.

OBJETIVO ESTRUCTURAL:

Debes crear dos grupos de contenido:

==================================================
A) ESTACIONES Y PUNTOS FERROVIARIOS
==================================================

La tabla contiene EXACTAMENTE 14 registros de estaciones o puntos
ferroviarios, correspondientes a los números 1 a 14.

Genera EXACTAMENTE 14 unidades independientes.

Usa section exactamente:
"Tema 26 - estaciones y puntos ferroviarios"

Usa:
itemType="relacion"
evaluationType="identificacion"

Los 14 registros son:

1. ALTSASU-PUEBLO (APD)
2. ALTSASU
3. CASTEJON DE EBRO
4. CORTES DE NAVARRA
5. ETXARRI-ARANATZ
6. UHARTE-ARAKIL
7. FECULAS-NAVARRA
8. MARCILLA DE NAVARRA
9. OLITE-ERRIBERRI
10. PAMPLONA/IRUÑA
11. RIBAFORADA
12. TAFALLA
13. TUDELA DE NAVARRA
14. VILLAFRANCA DE NAVARRA

Para CADA registro conserva conjuntamente:

- número de registro;
- nombre exacto;
- tipo o marcador del punto ferroviario cuando aparezca;
- línea de FFCC;
- tramo;
- longitud asociada;
- localidad o municipio cuando pueda identificarse inequívocamente;
- dirección exacta;
- parque de bomberos asociado específicamente a la estación.

IMPORTANTE SOBRE EL TIPO:

- conserva literalmente cualquier marcador que aparezca, por ejemplo "(APD)";
- si el documento no muestra un marcador específico, no inventes
  "apeadero", "apartadero" u otra categoría;
- el encabezado general "Estaciones de la red ferroviaria" puede utilizarse
  para describir los registros sin marcador.

IMPORTANTE SOBRE MUNICIPIOS:

NO utilices automáticamente la lista "Municipio(s) por los que pasa"
del eje ferroviario como si fuese el municipio concreto de la estación.

Esa lista pertenece al EJE/LÍNEA, no necesariamente a la estación.

==================================================
REGLA CRÍTICA DE CELDAS COMBINADAS
==================================================

La línea y el tramo de los registros 1 a 14 son:

- Nº 1:
  Madrid-Irún -> Madrid-Irún

- Nº 2, 3 y 4:
  Zaragoza-Altsasu/Alsasua -> Castejón-Altsasu/Alsasua

- Nº 5 y 6:
  Madrid-Irún -> Madrid-Irún

- Nº 7, 8, 9, 10 y 11:
  Zaragoza-Altsasu/Alsasua -> Castejón-Altsasu/Alsasua

- Nº 12 y 13:
  Madrid-Irún -> Madrid-Irún

- Nº 14:
  Zaragoza-Altsasu/Alsasua -> Castejón-Altsasu/Alsasua

RESPETA EXACTAMENTE ESTA CORRESPONDENCIA.

No atribuyas una línea o tramo a una estación por proximidad visual.

==================================================
B) LÍNEAS Y TRAMOS
==================================================

Conserva también las relaciones generales del eje ferroviario.

Usa section exactamente:
"Tema 26 - líneas y tramos"

Usa:
itemType="relacion"
evaluationType="identificacion"

Deben quedar representadas estas CINCO relaciones:

1. Madrid-Irún
   -> Madrid-Irún

2. Zaragoza-Altsasu/Alsasua
   -> Castejón-Altsasu/Alsasua

3. Castejón-Logroño-Bilbao
   -> Castejón-Logroño

4. Zaragoza-Altsasu/Alsasua
   -> Cortes-Castejón

5. Soria-Castejón (Sin servicio)
   -> Castejón-Valverde (Sin servicio)

Para cada una conserva:

- línea;
- tramo;
- municipios por los que pasa;
- parque o parques de bomberos asociados;
- condición "Sin servicio" cuando corresponda.

MUY IMPORTANTE:

Los municipios:

Castejón; Corella; Cintruéñigo; Fitero

pertenecen a:

Soria-Castejón (Sin servicio)
-> Castejón-Valverde (Sin servicio)

NO los atribuyas a Castejón-Logroño.

==================================================

NO mezcles:

- parque asociado al eje ferroviario;
- parque asociado específicamente a una estación;
- municipios atravesados por una línea;
- localidad concreta de una estación.

Son relaciones distintas.

La prioridad de estudio es:

1. estación/punto ferroviario -> parque de bomberos;
2. tipo o marcador del punto ferroviario;
3. estación -> línea y tramo;
4. estación -> localidad/municipio;
5. estación -> dirección;
6. estación -> longitud.

La longitud debe conservarse aunque tenga menor prioridad examinable.

No inventes información que no aparezca en la tabla.
`;
}
  
  if(topicNumber===27){
    return `
REGLAS ESPECÍFICAS DEL TEMA 27 — CAMINO DE SANTIAGO:

ESTE TEMA NO ADMITE RESÚMENES DE LISTAS.
Cada entrada territorial y cada posición de recorrido debe quedar representada
como una unidad examinable independiente.

La página contiene TRES LISTADOS DISTINTOS.
NO relaciones horizontalmente nombres que solo coinciden visualmente en una fila.

A) MUNICIPIOS POR LOS QUE PASA EL CAMINO DE SANTIAGO

- La primera columna contiene EXACTAMENTE 42 municipios.
- Genera EXACTAMENTE 42 elementos independientes para esta columna:
  UNO por cada municipio, sin agrupar dos municipios en un mismo elemento.
- Cada elemento debe permitir preguntar si ese municipio pertenece al conjunto
  de municipios por los que pasa el Camino de Santiago.
- Usa section exactamente: "Camino de Santiago - municipios".
- Usa itemType="relacion".
- Usa evaluationType="pertenencia_exclusion".
- El concept debe identificar un único municipio.

B) ORDEN NORTE A SUR

- La columna "Municipios de Norte a Sur" contiene EXACTAMENTE 30 posiciones.
- Genera EXACTAMENTE 30 elementos independientes:
  UNO por cada posición/municipio de esa columna.
- Conserva en cada elemento:
  * el municipio;
  * su posición relativa dentro de esta secuencia;
  * si la tabla lo identifica como Camino francés, Camino aragonés
    o Camino francés/Camino aragonés.
- Usa section exactamente: "Camino de Santiago - Norte a Sur".
- Usa itemType="relacion".
- Usa evaluationType="secuencia".
- NO resumas toda la secuencia en un único elemento.

C) ORDEN ESTE A OESTE

- La columna "Municipios de Este a Oeste" contiene EXACTAMENTE 14 posiciones.
- Genera EXACTAMENTE 14 elementos independientes:
  UNO por cada posición/municipio de esa columna.
- Conserva en cada elemento:
  * el municipio;
  * su posición relativa dentro de esta secuencia;
  * si la tabla lo identifica como Camino francés, Camino aragonés
    o Camino francés/Camino aragonés.
- Usa section exactamente: "Camino de Santiago - Este a Oeste".
- Usa itemType="relacion".
- Usa evaluationType="secuencia".
- NO resumas toda la secuencia en un único elemento.

D) TRAZADO GENERAL

Extrae también como conocimientos independientes los datos expresos del texto
superior de la página sobre:
- por dónde entra el Camino francés;
- por qué localidad indicada pasa el Camino francés;
- por dónde entra el Camino aragonés;
- dónde se une el Camino aragonés al Camino francés.

Usa para ellos section: "Camino de Santiago - trazado general".

REGLAS CRÍTICAS:

1. Los tres listados son independientes.
2. Que tres nombres aparezcan en la misma fila visual NO crea una relación entre ellos.
3. Un mismo municipio puede aparecer legítimamente en más de un listado.
   NO lo elimines por ello: pertenencia y posición son conocimientos diferentes.
4. NO agrupes varios municipios en un único concept.
5. NO devuelvas conceptos globales del tipo "orden del Camino francés"
   sustituyendo las entradas individuales.
6. sourceEvidence debe conservar el dato literal suficiente para comprobar
   el municipio, su listado y, cuando proceda, su adscripción al camino.
7. No inventes municipios, posiciones ni adscripciones.
8. Antes de responder verifica obligatoriamente que has creado, como mínimo:
   - 42 elementos de municipios;
   - 30 elementos de Norte a Sur;
   - 14 elementos de Este a Oeste.
   Es decir, un mínimo estructural de 86 elementos antes de añadir
   los conocimientos generales del trazado.
`;
  }
  return "";
}
function coverageContinuityPrompt(topicName, previousItems=[]){
  const topicNumber=coverageTopicNumber(topicName);

  if(
    ![21,22,23,24,25,26,27].includes(topicNumber) ||
    !Array.isArray(previousItems) ||
    previousItems.length===0
  ){
    return "";
  }

  const context=previousItems
    .slice(-12)
    .map(item=>({
      section:item.section ?? null,
      concept:item.concept ?? null,
      sourcePage:item.sourcePage ?? item.source_page ?? null,
      sourceEvidence:item.sourceEvidence ?? item.source_evidence ?? null
    }));

  return `
CONTEXTO DE CONTINUIDAD DE PÁGINAS ANTERIORES:
${JSON.stringify(context)}

Este contexto procede del MISMO documento y sirve únicamente para reconocer
continuaciones de una tabla, lista o bloque iniciado en páginas anteriores.
Úsalo para conservar correctamente la entidad padre o relación que continúa.
NO crees elementos a partir del contexto si no existe contenido correspondiente
en las páginas que estás analizando ahora.
`;
}
function coverageGapPrompt(existingItems, startPage, endPage, topicName, previousItems=[]){
  const existingSummary=existingItems.map(item=>({
    section:item.section ?? null,
    concept:item.concept,
    itemType:item.itemType ?? item.item_type,
    evaluationType:item.evaluationType ?? item.evaluation_type,
    sourcePage:item.sourcePage ?? item.source_page,
    sourceEvidence:item.sourceEvidence ?? item.source_evidence ?? null
  }));

  return `${coverageTopicRulesPrompt(topicName)}\n${coverageContinuityPrompt(topicName, previousItems)}\nACTÚAS COMO AUDITOR EXHAUSTIVO DE COBERTURA DE UN TEMARIO DE OPOSICIÓN.

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
async function ingest(filePath, displayName, returnDocumentName=false){
  const ai=aiClient(); const store=await ensureStore();
  let op=await ai.fileSearchStores.uploadToFileSearchStore({
    file:filePath, fileSearchStoreName:store,
    config:{displayName,mimeType:"application/pdf"}
  });
  op=await waitOp(ai,op);
  if(op?.error){
    throw new Error("Error de subida a File Search: "+JSON.stringify(op.error));
  }
  // La API devuelve el recurso exacto en response.documentName.
  return returnDocumentName
    ? {store,documentName:op?.response?.documentName||null}
    : store;
}


// SERVER 82: gestión de temas cargados por error. Operación restringida con contraseña
// independiente, comprobación transaccional y borrado de la fuente de File Search.
function topicAdminAuth(req,res,next){
  const password=process.env.TOPIC_ADMIN_PASSWORD;
  if(!password || password.length<12){
    return res.status(503).send('Configura TOPIC_ADMIN_PASSWORD (mínimo 12 caracteres) en Render.');
  }
  const auth=req.get('authorization')||'';
  let supplied='';
  if(auth.startsWith('Basic ')){
    try{ supplied=Buffer.from(auth.slice(6),'base64').toString('utf8').split(':').slice(1).join(':'); }catch{}
  }
  const a=Buffer.from(supplied),b=Buffer.from(password);
  if(a.length!==b.length || !requireSafeCompare82(a,b)){
    res.set('WWW-Authenticate','Basic realm="Administrar temas"');
    return res.status(401).send('Contraseña requerida');
  }
  next();
}
function requireSafeCompare82(a,b){return timingSafeEqual(a,b);}

function escapeTopicHtml82(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
app.get('/administrar-temas',topicAdminAuth,async(req,res)=>{
  try{
    const rows=(await db.query(`SELECT t.id,t.name,t.total_items,
      (SELECT COUNT(*)::int FROM coverage_items ci WHERE ci.topic_id=t.id) AS actual_items
      FROM topics t ORDER BY t.name,t.id`)).rows;
    res.set('Cache-Control','no-store');
    res.type('html').send(`<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Administrar temas</title>
    <style>body{font:16px system-ui;max-width:800px;margin:30px auto;padding:12px}article{border:1px solid #ccc;padding:14px;margin:10px 0;border-radius:8px}button{padding:9px;cursor:pointer}input{padding:9px;width:95%}small{color:#555}</style>
    <h1>Administrar temas</h1><p>El borrado definitivo solo se permite si el tema no tiene preguntas, sesiones ni progreso. Escribe el nombre exacto para confirmar.</p>
    ${rows.map(t=>`<article><b>${escapeTopicHtml82(t.name)}</b><p><small>ID ${t.id} · ${t.actual_items} conocimientos</small></p>${/^\s*(?:TEMA\s*23\s*[.:-]?\s*)?(?:parques|plantas)\s+solares\s*$/i.test(t.name)?`<button data-solar-id="${t.id}" data-solar-name="${escapeTopicHtml82(t.name)}">Eliminar tema solar y sus pruebas</button>`:`<button data-id="${t.id}" data-name="${escapeTopicHtml82(t.name)}">Eliminar este tema</button>`}</article>`).join('')}
    <script>document.querySelectorAll('button[data-id]').forEach(b=>b.onclick=async()=>{
      const name=b.dataset.name;const typed=prompt('Para eliminar DEFINITIVAMENTE el tema, escribe su nombre exacto:\\n'+name);
      if(typed!==name)return alert('Cancelado: el nombre no coincide.');
      if(!confirm('¿Eliminar '+name+' y sus conocimientos? Esta acción no se puede deshacer.'))return;
      b.disabled=true;
      try{const r=await fetch('/api/admin/topics/'+b.dataset.id,{method:'DELETE',headers:{'Content-Type':'application/json','X-Topic-Admin':'delete'},body:JSON.stringify({confirmName:typed})});const x=await r.json();alert(x.message||x.error||'Error');if(x.ok)location.reload();}catch(e){alert('Error de conexión: '+e.message);}finally{b.disabled=false;}
    });
    document.querySelectorAll('button[data-solar-id]').forEach(b=>b.onclick=async()=>{
      const name=b.dataset.solarName;
      if(prompt('Escribe exactamente el nombre del tema que deseas sustituir:\\n'+name)!==name)return alert('Cancelado.');
      if(prompt('Se borrarán las preguntas, repasos y respuestas de prueba de ESTE tema.\\nPara continuar escribe BORRAR PRUEBAS SOLARES')!=='BORRAR PRUEBAS SOLARES')return alert('Cancelado.');
      if(!confirm('¿Confirmas borrar definitivamente este tema solar y sus pruebas, sin eliminar datos de otros temas?'))return;
      b.disabled=true;
      try{const r=await fetch('/api/admin/topics/'+b.dataset.solarId,{method:'DELETE',headers:{'Content-Type':'application/json','X-Topic-Admin':'delete'},body:JSON.stringify({confirmName:name,deleteSolarTrialData:true,confirmDeleteTrialData:'BORRAR PRUEBAS SOLARES'})});const x=await r.json();alert(x.message||x.error||'Error');if(x.ok)location.reload();}catch(e){alert('Error de conexión: '+e.message);}finally{b.disabled=false;}
    });</script></html>`);
  }catch(e){res.status(500).send('No se pudieron listar los temas: '+escapeTopicHtml82(e.message));}
});
app.delete('/api/admin/topics/:id',topicAdminAuth,async(req,res)=>{
  if(req.get('X-Topic-Admin')!=='delete')return res.status(403).json({error:'Solicitud no autorizada'});
  const id=Number(req.params.id);
  if(!Number.isSafeInteger(id)||id<1)return res.status(400).json({error:'ID incorrecto'});
  const client=await db.connect();let sourceName=null,deletedName=null;
  try{
    await client.query('BEGIN');
    const found=await client.query('SELECT id,name FROM topics WHERE id=$1 FOR UPDATE',[id]);
    if(!found.rowCount)throw Object.assign(new Error('El tema ya no existe.'),{status:404});
    deletedName=found.rows[0].name;
    if(req.body?.confirmName!==deletedName)throw Object.assign(new Error('El nombre de confirmación no coincide.'),{status:400});
    const state=await client.query(`SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER(WHERE ci.worked OR ci.times_asked>0 OR ci.times_correct>0 OR ci.times_wrong>0 OR ci.times_blank>0)::int AS progress,
      (SELECT COUNT(*)::int FROM question_bank qb JOIN coverage_items c ON c.id=qb.coverage_item_id WHERE c.topic_id=$1) AS questions,
      (SELECT COUNT(*)::int FROM test_session_questions sq JOIN coverage_items c ON c.id=sq.coverage_item_id WHERE c.topic_id=$1) AS sessions,
      (SELECT COUNT(*)::int FROM coverage_review_state rs JOIN coverage_items c ON c.id=rs.coverage_item_id WHERE c.topic_id=$1) AS reviews
      FROM coverage_items ci WHERE ci.topic_id=$1`,[id]);
    const st=state.rows[0];
    // Excepción controlada: SOLO Plantas solares y SOLO con confirmación adicional.
    // No afecta a preguntas ni a repasos de ningún otro tema.
    const solarPurgeAuthorized=/^\s*(?:TEMA\s*23\s*[.:-]?\s*)?(?:parques|plantas)\s+solares\s*$/i.test(deletedName) &&
      req.body?.deleteSolarTrialData===true &&
      req.body?.confirmDeleteTrialData==='BORRAR PRUEBAS SOLARES';
    if(st.progress||st.questions||st.sessions||st.reviews){
      if(!solarPurgeAuthorized){
        throw Object.assign(new Error('No se ha eliminado: este tema tiene preguntas, sesiones o progreso. Consulta antes de borrarlo.'),{status:409});
      }
      // Las filas de sesión referencian preguntas y cobertura mediante ON DELETE RESTRICT.
      // Retirarlas primero permite eliminar el tema sin tocar datos de otros temas.
      const removed=await client.query(`
        DELETE FROM test_session_questions sq USING coverage_items ci
        WHERE sq.coverage_item_id=ci.id AND ci.topic_id=$1
        RETURNING sq.session_id`,[id]);
      const affectedIds=[...new Set(removed.rows.map(row=>String(row.session_id)))];
      if(affectedIds.length){
        // Sesiones exclusivamente solares: sin preguntas restantes, se eliminan.
        await client.query(`
          DELETE FROM test_sessions ts WHERE ts.id=ANY($1::bigint[])
          AND NOT EXISTS(SELECT 1 FROM test_session_questions sq WHERE sq.session_id=ts.id)`,[affectedIds]);
        // Sesiones mixtas: conservar sus preguntas de otros temas y ajustar resultados.
        await client.query(`
          UPDATE test_sessions ts SET
            total_questions=r.total,
            correct_answers=r.correct,
            wrong_answers=r.wrong,
            blank_answers=r.blank
          FROM (SELECT sq.session_id,
            COUNT(*)::int AS total,
            COUNT(*) FILTER(WHERE sq.is_correct=TRUE)::int AS correct,
            COUNT(*) FILTER(WHERE sq.is_correct=FALSE AND sq.is_blank=FALSE)::int AS wrong,
            COUNT(*) FILTER(WHERE sq.is_blank=TRUE)::int AS blank
            FROM test_session_questions sq
            WHERE sq.session_id=ANY($1::bigint[])
            GROUP BY sq.session_id) r
          WHERE ts.id=r.session_id`,[affectedIds]);
      }
    }
    const doc=await client.query('SELECT document_name FROM topic_source_documents WHERE topic_id=$1',[id]);
    sourceName=doc.rows[0]?.document_name||null;
    await client.query('DELETE FROM topics WHERE id=$1',[id]);
    await client.query('COMMIT');
  }catch(e){await client.query('ROLLBACK');return res.status(e.status||500).json({ok:false,error:e.message});}
  finally{client.release();}
  // La fuente factual se retira también del almacén Gemini para evitar contaminación futura.
  // Un fallo remoto no revierte el borrado local; se informa explícitamente.
  if(sourceName){
    try{
      const ai=aiClient();
      await ai.fileSearchStores.documents.delete({name:sourceName,config:{force:true}});
    }catch(e){
      console.error('[admin] Tema eliminado, documento remoto pendiente:',sourceName,e);
      return res.json({ok:true,message:`Tema «${deletedName}» eliminado de PostgreSQL. ATENCIÓN: no se pudo eliminar su documento de Gemini File Search; requiere limpieza del documento ${sourceName}.`});
    }
  }
  res.json({ok:true,message:`Tema «${deletedName}» eliminado definitivamente, junto con su cobertura${sourceName?' y documento de Gemini':''}.`});
});

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
    if(!req.file){
      throw new Error("Falta PDF");
    }

const pdfHeaderBuffer=Buffer.alloc(1024);
let pdfHeaderLength=0;
let pdfFd=null;

try{
  pdfFd=fs.openSync(req.file.path,"r");

  pdfHeaderLength=fs.readSync(
    pdfFd,
    pdfHeaderBuffer,
    0,
    pdfHeaderBuffer.length,
    0
  );

}finally{
  if(pdfFd!==null){
    fs.closeSync(pdfFd);
  }
}

const pdfHeader=
  pdfHeaderBuffer
    .subarray(0,pdfHeaderLength)
    .toString("latin1");

if(!pdfHeader.includes("%PDF-")){
  throw new Error(
    "El archivo seleccionado no contiene una firma PDF válida."
  );
}

    const topicName=
      String(
        req.body?.topicName ||
        path.basename(
          req.file.originalname,
          path.extname(req.file.originalname)
        )
      )
        .replace(/[_-]+/g," ")
        .replace(/\s+/g," ")
        .trim();

    if(!topicName){
      throw new Error("Falta el nombre del tema.");
    }

    const normalizedBlock=
      String(req.body?.block || "")
        .trim()
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g,"");

    const blockAliases={
      legislacion:"legislacion",
      geografia:"geografia",
      especifico:"especifico",
      especificos:"especifico"
    };

    const block=
      normalizedBlock
        ? blockAliases[normalizedBlock]
        : null;

    if(normalizedBlock && !block){
      throw new Error(
        "Bloque inválido. Usa legislacion, geografia o especifico."
      );
    }

    const rawOrder=
      Number(req.body?.topicOrder);

    // El frontend puede no enviar topicOrder; recuperar el número escrito
    // al principio del nombre evita que se muestre como 0 (sin orden).
    const writtenOrder=topicName.match(/^\s*TEMA\s*([0-9]{1,3})\b/i);
    const inferredOrder=writtenOrder?Number(writtenOrder[1]):null;
    // Si el nombre incluye TEMA 23 / 24 / 26 / 27 / 36, su número
    // tiene prioridad sobre el orden enviado por el formulario.
    // El frontend anterior enviaba 1 al cargar un PDF "TEMA_23_...".
    const topicOrder=
      inferredOrder !== null
        ? inferredOrder
        : (Number.isInteger(rawOrder) && rawOrder>0 ? rawOrder : null);

    let topic=
      await getOrCreateTopic(
        topicName,
        req.file.originalname
      );

    const metadataResult=
      await db.query(
        `UPDATE topics
         SET
           source_file = CASE WHEN total_items > 0
             THEN COALESCE(source_file,$2) ELSE $2 END,
           block = COALESCE($3, block),
           topic_order = COALESCE($4, topic_order)
         WHERE id = $1
         RETURNING *`,
        [
          Number(topic.id),
          req.file.originalname,
          block,
          topicOrder
        ]
      );

    topic=metadataResult.rows[0];

    res.json({
      ok:true,
      topicId:Number(topic.id),
      topic:topic.name,
      block:topic.block,
      topicOrder:topic.topic_order,
      totalItems:Number(topic.total_items || 0),
      uploadToken:req.file.filename,
      fileSearchIndexed:
        topic.file_search_indexed === true
    });

  }catch(e){
    if(req.file?.path){
      fs.unlink(req.file.path,()=>{});
    }

    res.status(500).json({
      ok:false,
      error:e?.message || String(e)
    });
  }
});
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
function coverageAnalysisPrompt(topicName, previousItems=[]){
  return `${coverageTopicRulesPrompt(topicName)}\n${coverageContinuityPrompt(topicName, previousItems)}\nEres un analista de temario para una oposición de Bombero de Navarra.

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
- section: utiliza el encabezado real del APARTADO que agrupa los datos, respetando
  su jerarquía. No inventes secciones y NO conviertas cada ficha, entidad o fila
  (por ejemplo, el nombre de un monte) en una sección independiente.
  Si la fuente agrupa fichas bajo un parque, capítulo o bloque, todas las fichas
  de ese grupo deben conservar ese mismo encabezado.
- Si el PDF contiene registros identificados con códigos únicos (por ejemplo,
  ABC-0001), genera exactamente UN elemento por cada registro numerado y copia
  su identificador literal al INICIO de sourceEvidence. No omitas registros
  por parecer repetitivos; no mezcles dos identificadores en un elemento.
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







async function generateCoverageWithRetry(ai,request){
  const retryDelays=[
    3000,
    7000,
    15000,
    30000,
    60000
  ];

  for(let attempt=0;;attempt++){
    try{
      return await ai.models.generateContent(
        request
      );

    }catch(error){
      const status=
        Number(
          error?.status ??
          error?.code ??
          error?.error?.code
        );

      const message=
        String(
          error?.message ||
          error ||
          ""
        );

      const transient=
  status!==402 &&
  (
    status===429 ||
    status===503 ||
    /UNAVAILABLE|high demand|temporar/i.test(
      message
    )
  );

      if(
        !transient ||
        attempt>=retryDelays.length
      ){
        throw error;
      }

      const delay=
        retryDelays[attempt];

      console.warn(
        `COVERAGE RETRY: error temporal ${status || "desconocido"}. ` +
        `Reintento ${attempt+2}/${retryDelays.length+1} en ${delay/1000}s.`
      );

      await sleep(delay);
    }
  }
}
async function setCoverageRunState(runId,state){
  if(!runId) return;

  await db.query(
    `INSERT INTO app_state (key,value)
     VALUES ($1,$2)
     ON CONFLICT (key)
     DO UPDATE SET value=EXCLUDED.value`,
    [
      `coverage_run:${runId}`,
      JSON.stringify({
        ...state,
        updatedAt:new Date().toISOString()
      })
    ]
  );
}
// Verificador genérico de códigos secuenciales que están escritos literalmente
// en flujos de texto PDF (sin conversión OCR y sin llamadas adicionales a IA).
// Si el PDF no permite leerlos con seguridad, no impone este control.
function decodePdfAscii85(data){
  const input=data.toString("latin1").replace(/\s+/g,"")
    .replace(/^<~/,"").replace(/~>.*$/s,"");
  const output=[];let tuple=[];
  const emit=(group,count)=>{
    let value=0;
    for(const digit of group)value=value*85+(digit-33);
    if(value>0xffffffff)throw new Error("ASCII85 fuera de rango");
    output.push(...[(value>>>24)&255,(value>>>16)&255,
      (value>>>8)&255,value&255].slice(0,count));
  };
  for(const ch of input){
    if(ch==="z"&&!tuple.length){output.push(0,0,0,0);continue;}
    const digit=ch.charCodeAt(0);
    if(digit<33||digit>117)throw new Error("ASCII85 inválido");
    tuple.push(digit);
    if(tuple.length===5){emit(tuple,4);tuple=[];}
  }
  if(tuple.length>1){
    const count=tuple.length;
    while(tuple.length<5)tuple.push(117);
    emit(tuple,count-1);
  }
  return Buffer.from(output);
}
function structuredPdfFromText(filePath){
  const proc=spawnSync("pdftotext",["-layout","-enc","UTF-8",filePath,"-"],
    {encoding:"utf8",maxBuffer:32*1024*1024,timeout:45000});
  if(proc.error || proc.status!==0 || !proc.stdout?.trim())return null;
  const pages=proc.stdout.split("\f").filter(p=>p.trim());
  const all=pages.flatMap((p,i)=>p.split(/\r?\n/).map(line=>({line:line.trim(),page:i+1})));
  const numbered=all.filter(x=>/^[EH]\d{3}\s*\|\s*\S/.test(x.line));
  // Only enter the strict fiche parser for an actual sequential E/H document.
  if(numbered.length>=20){
    const prefix=numbered[0].line[0];
    if(numbered.some(x=>x.line[0]!==prefix))throw Error('PDF: prefijos de fichas mezclados');
    const ids=new Set(),sections=new Map(),literalItems=[];
    let section=null,record=null;
    const flush=()=>{
      if(!record)return;
      if(!record.section)throw Error(`Ficha ${record.code} sin encabezado de parque`);
      if(ids.has(record.id))throw Error(`Ficha ${record.code} repetida`);
      if(record.lines.length<2)throw Error(`Ficha ${record.code} sin contenido`);
      ids.add(record.id);sections.set(record.id,record.section);
      literalItems.push({section:record.section,
        concept:record.lines.join(' ').replace(/\s+/g,' ').trim(),
        itemType:'relacion',evaluationType:'identificacion',sourcePage:record.page,
        sourceEvidence:`${record.code} · ${record.lines.join(' ').replace(/\s+/g,' ').trim()}`});
      record=null;
    };
    for(const {line,page} of all){
      if(/^PARQUE DE\s+\S/i.test(line)){flush();section=line.replace(/\s+/g,' ').trim();continue;}
      const m=line.match(/^([EH])(\d{3})\s*\|\s*(.+)$/);
      if(m){flush();if(m[1]!==prefix)throw Error(`Prefijo inesperado ${m[1]}`);
        record={id:Number(m[2]),code:m[1]+m[2],section,page,lines:[m[3].trim()]};continue;}
      if(/^Orientaciones directas e inversas/i.test(line) || /^Embalses, balsas, lagunas y barrancos$/i.test(line)){flush();break;}
      if(!record || !line || /^Origen:\s*IMG_/i.test(line) ||
        /^(?:Geografía de Navarra|TEMA NUEVO|Fichas estructuradas por parque|Reglas de lectura)/i.test(line))continue;
      // Ignore footer and pagination; preserve the original data and field names.
      if(!/^Página\s+\d+\b/i.test(line))record.lines.push(line);
    }
    flush();
    const max=Math.max(...ids);
    if(!ids.has(1)||max!==ids.size||ids.size!==numbered.length)
      throw Error(`Fichas incompletas: ${ids.size} distintas, máximo ${max}, ${numbered.length} encabezados`);
    return {prefix,digits:3,ids,sections,recordPages:pages.length,literalItems};
  }
  if(/CARRETERAS DE NAVARRA/i.test(proc.stdout.slice(0,500))){
    const sectionsNames=new Set(['AUTOVÍAS','AUTOPISTAS','CARRETERAS DE ALTAS PRESTACIONES',
      'CARRETERAS DE INTERÉS GENERAL','VÍAS DESDOBLADAS','CARRETERAS DE INTERÉS DE LA COMUNIDAD FORAL']);
    let section=null,record=null;const items=[];
    const flush=()=>{if(!record)return;
      if(!record.section||record.lines.length<2)throw Error(`Ficha de vía incompleta: ${record.lines[0]}`);
      const id=items.length+1,code='V'+String(id).padStart(3,'0');
      const concept=record.lines.join(' ').replace(/\s+/g,' ').trim();
      items.push({section:record.section,concept,itemType:'relacion',evaluationType:'identificacion',
        sourcePage:record.page,sourceEvidence:`${code} · ${concept}`});record=null;};
    for(const {line,page} of all){
      if(sectionsNames.has(line)){flush();section=line;continue;}
      const head=/^(?:A|AP|N|NA|PA)-\d+[A-Z0-9-]*(?:\s+R)?(?:\s+[—-]\s+tramo\s+\d+|\s+[—-]\s+Ronda\s+Oeste)?\s*[·]\s*\S/i;
      if(head.test(line)){flush();record={section,page,lines:[line]};continue;}
      if(/^Control de consistencia de longitudes$/i.test(line)){flush();break;}
      if(!record||!line||/^Fuente:\s*IMG_/i.test(line)||
        /^Carreteras Navarra\s*·\s*Fuente del usuario/i.test(line)||
        /^\d+\s*$/.test(line))continue;
      record.lines.push(line);
    }
    flush();
    if(items.length<35)throw Error(`Extracción de carreteras insuficiente: ${items.length}`);
    // The PDF begins with category and network totals. Keep those facts as
    // independent records rather than silently dropping the opening table.
    const totals=[];
    const firstPage=pages[0].split(/\r?\n/);
    let inTotals=false;
    for(const raw of firstPage){
      const line=raw.trim();
      if(/^Categoría \/ total\s+Km$/i.test(line)){inTotals=true;continue;}
      if(inTotals && /^Los 2\.253 km/i.test(line))break;
      if(inTotals){
        const m=line.match(/^(.+?)\s{2,}([\d.,]+)\s*$/);
        if(m)totals.push({label:m[1].trim(),value:m[2]});
      }
    }
    const totalItems=totals.map(t=>({section:'Totales anotados en el material',
      concept:`${t.label}: ${t.value} km`,itemType:'dato_numerico',
      evaluationType:'identificacion',sourcePage:1,sourceEvidence:''}));
    items.unshift(...totalItems);
    for(let i=0;i<items.length;i++){
      const code='V'+String(i+1).padStart(3,'0');
      items[i].sourceEvidence=code+' · '+items[i].concept;
    }
    const ids=new Set(items.map((_,i)=>i+1));
    const sections=new Map(items.map((x,i)=>[i+1,x.section]));
    return {prefix:'V',digits:3,ids,sections,recordPages:pages.length,literalItems:items};
  }
  // Road codes such as N-111 are not fiche identifiers and must never
  // be treated as a numbered sequence requiring a park.
  if(/CARRETERAS DE NAVARRA/i.test(proc.stdout.slice(0,500)))return null;
  return null;
}
// Cobertura factual cerrada de los cinco temas corregidos.
// Inventario integrado EN el PDF, visible y con firma SHA-256, sin llamadas
// a Gemini para extraer fichas. No modifica la generación de preguntas.
async function geoCoverageMetadataRecords(pdfPath, topicName){
  const topicNumber=coverageTopicNumber(topicName);
  if(![23,24,26,27,36].includes(topicNumber))return null;
  const bytes=fs.readFileSync(pdfPath);
  const pdf=await PDFDocument.load(bytes,{updateMetadata:false});
  const subject=String(pdf.getSubject()||"");
  if(!subject.startsWith("GEOFACT1|")){
    throw new Error(`El TEMA ${topicNumber} necesita su PDF definitivo con fichas GEO numeradas. `+
      `No se sustituye la cobertura actual por una extracción parcial.`);
  }
  const parts=subject.split("|");
  if(parts.length!==3 || !/^[a-f0-9]{64}$/i.test(parts[1]) ||
      !/^[A-Za-z0-9+/=]+$/.test(parts[2])){
    throw new Error("Cobertura GEO: metadatos del PDF inválidos. No se guarda nada.");
  }
  const data=inflateSync(Buffer.from(parts[2],"base64"));
  if(createHash("sha256").update(data).digest("hex")!==parts[1].toLowerCase()){
    throw new Error("Cobertura GEO: firma del inventario no coincide con el PDF.");
  }
  const manifest=JSON.parse(data.toString("utf8"));
  if(manifest.format!=="GEOFACT1" || Number(manifest.topic)!==topicNumber ||
      !Array.isArray(manifest.items) || manifest.items.length<30 ||
      manifest.items.length>2000){
    throw new Error("Cobertura GEO: tema o número de fichas incorrecto.");
  }
  const sections=new Map(),ids=new Set(),literalItems=[];
  for(let i=0;i<manifest.items.length;i++){
    const r=manifest.items[i];
    const id=i+1,code=`GEO-${String(id).padStart(4,"0")}`;
    if(r.id!==code || !r.section || !r.concept ||
        r.sourceEvidence!==`${code} · ${r.concept}` ||
        !Number.isInteger(r.sourcePage) || r.sourcePage<1 ||
        r.sourcePage>pdf.getPageCount()){
      throw new Error(`Cobertura GEO incompleta o inválida: registro ${code}.`);
    }
    if(!["relacion","dato_numerico","concepto","enumeracion"].includes(r.itemType) ||
        !["identificacion","secuencia","relacion_variables","literal"].includes(r.evaluationType)){
      throw new Error(`Cobertura GEO: clasificación inválida ${code}.`);
    }
    ids.add(id);sections.set(id,r.section);
    literalItems.push({section:r.section,concept:r.concept,itemType:r.itemType,
      evaluationType:r.evaluationType,sourcePage:r.sourcePage,
      manualPage:null,sourceEvidence:r.sourceEvidence});
  }
  console.log(`[coverage] TEMA ${topicNumber}: ${literalItems.length} fichas literales `+
    `validadas dentro del PDF. 0 llamadas Gemini para cobertura.`);
  return {prefix:"GEO-",digits:4,ids,sections,recordPages:pdf.getPageCount(),literalItems};
}

function sequentialPdfRecordIds(filePath){
  const deterministic=structuredPdfFromText(filePath);
  if(deterministic)return deterministic;
  if(/(?:^|[\/])34_CARRETERAS\.pdf$/i.test(filePath))return null;
  const bytes=fs.readFileSync(filePath);
  const latin=bytes.toString("latin1");
  const groups=new Map();
  const sectionByCode=new Map();
  const parsedRecords=new Map();
  let recordPage=0;
  const cmapByObject=new Map();
  const fontUnicodeRef=new Map();
  for(const obj of latin.matchAll(/\b(\d+)\s+0\s+obj\b([\s\S]*?)endobj/g)){
    const name=obj[2].match(/\/Name\s+\/([A-Za-z0-9+]+)/);
    const cmap=obj[2].match(/\/ToUnicode\s+(\d+)\s+0\s+R/);
    if(name&&cmap)fontUnicodeRef.set(name[1],Number(cmap[1]));
  }
  let heading=null;
  const stream=/\bstream\r?\n/g;
  let match;
  while((match=stream.exec(latin))!==null){
    const start=match.index+match[0].length;
    const end=latin.indexOf("endstream",start);
    if(end<0)break;
    stream.lastIndex=end+9;
    let contents=bytes.subarray(start,end);
    try{
      const header=latin.slice(Math.max(0,match.index-300),match.index);
      if(/\/ASCII85Decode\b/.test(header))contents=decodePdfAscii85(contents);
      if(/\/FlateDecode\b/.test(header))contents=inflateSync(contents);
      const txt=contents.toString("latin1");
      if(txt.includes("beginbfchar")){
        const before=latin.slice(Math.max(0,match.index-600),match.index);
        const objectNo=[...before.matchAll(/\b(\d+)\s+0\s+obj\b/g)].pop()?.[1];
        if(objectNo){
          const mapping=new Map();
          for(const ch of txt.matchAll(/<([0-9A-F]{2})>\s+<([0-9A-F]{4})>/gi)){
            const scalar=parseInt(ch[2],16);
            if(scalar>0)mapping.set(parseInt(ch[1],16),String.fromCodePoint(scalar));
          }
          cmapByObject.set(Number(objectNo),mapping);
        }
      }
      // Leer las fichas literalmente cuando el PDF ya contiene una unidad
      // examinable numerada por línea. Sin rehacer datos mediante IA.
      const pageHasRecords=/\b[A-Z][A-Z0-9]{1,12}[-_]\d{3,6}\b/.test(txt);
      if(pageHasRecords)recordPage++;
      let currentRecord=null;
      let printedPage=null;
      const finishRecord=()=>{
        if(!currentRecord)return;
        const r=currentRecord;
        r.text=r.text.replace(/\s+/g," ").trim();
        if(r.text.length>=10){
          const category=r.kind.toUpperCase();
          const numeric=/ALTITUD|LONGITUD|DISTANCIA|ALTURA|PESO|TEMPERATURA|PRESI[ÓO]N|VELOCIDAD|PORCENTAJE/.test(category);
          const statement=`${r.kind}: ${r.text}`;
          parsedRecords.set(`${r.prefix}:${r.digits}`,{
            section:r.section||null,
            concept:statement,
            itemType:numeric?"dato_numerico":"relacion",
            evaluationType:numeric?"identificacion":"relacion_variables",
            sourcePage:r.page,
            manualPage:r.manual,
            sourceEvidence:`${r.prefix}${r.digits} · ${statement}`
          });
        }
        currentRecord=null;
      };
      let activeFont=null;
      for(const token of txt.matchAll(/\/([A-Za-z0-9+]+)\s+[0-9.]+\s+Tf|\((?:\\.|[^\)])*\)\s*Tj/g)){
        if(token[1]){activeFont=token[1];continue;}
        const unicode=cmapByObject.get(fontUnicodeRef.get(activeFont));
        const label=token[0].slice(1,token[0].lastIndexOf(")"))
          .replace(/\\([0-7]{1,3})/g,(_match,octal)=>
            unicode?.get(parseInt(octal,8))||" ")
          .replace(/\\([()])/g,"$1").trim();
        const value=label.trim();
        if(printedPage===null && /^\d{1,4}$/.test(value))printedPage=value;
        const parsed=value.match(/^([A-Z][A-Z0-9]{1,12}[-_])(\d{3,6})\s*[·•]\s*([^:]{2,55}):\s*(.*)$/);
        if(parsed){
          finishRecord();
          currentRecord={prefix:parsed[1].toUpperCase(),digits:parsed[2],
            kind:parsed[3].trim(),text:parsed[4],page:recordPage,
            manual:printedPage,section:heading};
        }else if(currentRecord){
          if(/^PARQUE DE\b/.test(value) || /^Monte.+·\s*\d+\s*m$/.test(value)){
            finishRecord();
          }else if(value && !/^\d{1,4}$/.test(value)){
            currentRecord.text+=" "+value;
          }
        }
        // Los registros nunca son encabezados. Cuando el PDF está agrupado
        // por parques, únicamente un encabezado PARQUE DE ... cambia el grupo.
        const isParkHeading=/^PARQUE DE [A-ZÁÉÍÓÚÜÑ \/().-]{3,}$/i.test(label);
        const isOtherHeading=label.length>=6 && label.length<=90 &&
          /^[A-ZÁÉÍÓÚÜÑ][A-ZÁÉÍÓÚÜÑ \/().-]+$/.test(label) &&
          /[A-Z]{3}/.test(label) && !/\bTEMA\b/.test(label) &&
          !/^[A-Z][A-Z0-9]{1,12}[-_]\d{3,6}\b/.test(label);
        if(isParkHeading || (isOtherHeading && !/^PARQUE DE /i.test(heading||""))){
          heading=label;
        }
        const code=label.match(/\b([A-Z][A-Z0-9]{1,12}[-_])(\d{3,6})\b/);
        if(code && heading){
          sectionByCode.set(`${code[1].toUpperCase()}:${code[2]}`,heading);
        }
      }
      finishRecord();
      for(const item of txt.matchAll(/\b([A-Z][A-Z0-9]{1,12}[-_])(\d{3,6})\b/g)){
        const prefix=item[1].toUpperCase(),digits=item[2].length;
        const key=`${prefix}:${digits}`;
        if(!groups.has(key))groups.set(key,new Set());
        groups.get(key).add(Number(item[2]));
      }
    }catch(_error){/* Flujos no textuales o filtros PDF distintos: ignorar. */}
  }
  for(const [key,ids] of [...groups].sort((a,b)=>b[1].size-a[1].size)){
    const max=Math.max(...ids);
    if(ids.size>=30 && ids.has(1) && max<=Math.ceil(ids.size*1.03)){
      const [prefix,digits]=key.split(":");
      const sections=new Map();
      for(const id of ids){
        const section=sectionByCode.get(`${prefix}:${String(id).padStart(Number(digits),"0")}`);
        if(section)sections.set(id,section);
      }
      const records=[...ids].sort((a,b)=>a-b).map(id=>
        parsedRecords.get(`${prefix}:${String(id).padStart(Number(digits),"0")}`));
      const literalItems=records.length===ids.size && records.every(item=>
        item && item.section && item.sourceEvidence.length>=25 &&
        item.sourcePage>=1 && item.manualPage!==null)
        ? records : null;
      return {prefix,digits:Number(digits),ids,sections,recordPages:recordPage,
        literalItems};
    }
  }
  return null;
}
app.post("/api/analyze-coverage", async(req,res)=>{
  let uploadedPdfPath=null;
  let topic=null;
  let coverageLock=null;
  let ownsCoverageLock=false;
  const coverageRunId=
    String(req.body?.runId || "")
      .trim()
      .slice(0,120);
  try{
    if(!STORE) throw new Error("Primero indexa el PDF.");

    const ai=aiClient();
    const coverageGenerate=
      request =>
        generateCoverageWithRetry(
          ai,
          request
        );
    console.log("COVERAGE: iniciando análisis");

    const requestedTopicId=
      Number(req.body?.topicId);

    const uploadToken=
      String(req.body?.uploadToken || "")
        .trim();

    let pdfPath;

    if(
      Number.isInteger(requestedTopicId) &&
      requestedTopicId > 0 &&
      uploadToken
    ){
      const topicResult=
        await db.query(
          `SELECT *
           FROM topics
           WHERE id = $1
           LIMIT 1`,
          [requestedTopicId]
        );

      if(!topicResult.rows.length){
        throw new Error(
          "No existe el tema solicitado."
        );
      }

      topic=topicResult.rows[0];

      pdfPath=
        path.resolve(
          "uploads",
          path.basename(uploadToken)
        );

      uploadedPdfPath=pdfPath;

    }else{
      pdfPath=
        path.resolve(
          "data/apeo-poda.pdf"
        );

      topic=
        await getOrCreateTopic(
          "Apeo y poda de arbolado",
          "apeo-poda.pdf"
        );
    }

    if(!fs.existsSync(pdfPath)){
      throw new Error(
        "No se encuentra el PDF para analizar."
      );
    }
    // Excluir dos reindexaciones simultáneas del mismo tema incluso con
    // varias instancias de Node. La sesión PG libera el bloqueo al terminar.
    coverageLock=await db.connect();
    const locked=await coverageLock.query(
      "SELECT pg_try_advisory_lock($1::bigint) AS ok",
      [900000000000+Number(topic.id)]);
    if(locked.rows[0]?.ok!==true){
      throw new Error("Este tema ya está siendo procesado; espera a que termine.");
    }
    ownsCoverageLock=true;
    await setCoverageRunState(
      coverageRunId,
      {
        status:"processing",
        topicId:Number(topic.id),
        topic:topic.name
      }
    );
    // SERVER 85: omitir el lector auxiliar de fichas SOLO en Específico.
    // Los manuales extensos pueden bloquearse al inspeccionar flujos de fuentes
    // antes del análisis por páginas. Geografía y Legislación quedan intactas.
    const structuredSource=String(topic.block || "").trim().toLowerCase()==="especifico"
      ? null
      : ((await geoCoverageMetadataRecords(pdfPath,topic.name)) ||
          sequentialPdfRecordIds(pdfPath));
    if(structuredSource){
      console.log(`[coverage] Fuente numerada: ${structuredSource.ids.size} IDs `+
        `con prefijo ${structuredSource.prefix}; extracción por bloques cortos.`);
    }

    // No modificar File Search hasta que el análisis nuevo esté validado.
    // El PDF antiguo sigue activo si el procesamiento fracasa.
const coverageChunkPages=
  coverageTopicNumber(topic.name)===22 ? 1 :
  structuredSource ? 2 : 5;

const literalItems=structuredSource?.literalItems || null;
// Para estos cinco temas la fuente completa ya está verificada dentro del PDF.
// Evitar dividir páginas y llamar dos veces a Gemini sin necesidad.
const {totalPages,chunks}=literalItems
  ? {totalPages:structuredSource.recordPages,chunks:[]}
  : await splitPdfIntoChunks(pdfPath,coverageChunkPages);
if(literalItems){
  console.log(`[coverage] Extracción literal PDF: ${literalItems.length} registros, `+
    `${new Set(literalItems.map(x=>x.section)).size} secciones; sin llamadas a Gemini.`);
}


console.log(
  `COVERAGE: ${totalPages} páginas divididas en ${chunks.length} bloques`
);
const normalizeChunkSourcePages=(items,chunk)=>{
  const list=
    Array.isArray(items)
      ? items
      : [];

  const chunkSize=
    chunk.endPage-chunk.startPage+1;

  const returnedPages=
    list
      .map(item=>Number(item?.sourcePage))
      .filter(page=>Number.isInteger(page));

  const usesRelativePages=
    chunk.startPage>1 &&
    returnedPages.length>0 &&
    returnedPages.every(
      page=>page>=1 && page<=chunkSize
    ) &&
    (
      chunk.startPage>chunkSize ||
      returnedPages.some(
        page=>page<chunk.startPage
      )
    );

  if(!usesRelativePages){
    return list;
  }

  return list.map(item=>{
    const page=Number(item?.sourcePage);

    if(
      Number.isInteger(page) &&
      page>=1 &&
      page<=chunkSize
    ){
      return {
        ...item,
        sourcePage:
          chunk.startPage+page-1
      };
    }

    return item;
  });
};
const allItems=literalItems?[...literalItems]:[];

for(const chunk of (literalItems?[]:chunks)){
  console.log(
    `COVERAGE: analizando páginas ${chunk.startPage}-${chunk.endPage}`
  );

  const response=await coverageGenerate({
    model:"gemini-3.5-flash-lite",
    contents:[
      {
        text:
    coverageAnalysisPrompt(
  topic.name,
  allItems
)+
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

  const normalizedChunkItems=
  normalizeChunkSourcePages(
    parsedChunk.items,
    chunk
  );

allItems.push(
  ...normalizedChunkItems
);

  console.log(
    `COVERAGE: páginas ${chunk.startPage}-${chunk.endPage} completadas: ${parsedChunk.items.length} elementos`
  );
}

console.log(
  `COVERAGE: todos los bloques completados. Total bruto: ${allItems.length}`
);
console.log("COVERAGE AUDIT: iniciando segunda pasada para detectar omisiones");

let auditChunks=chunks;

if(coverageTopicNumber(topic.name)===21){
  const fineAudit=
    await splitPdfIntoChunks(pdfPath,2);

  const denseStartPage=11;
  const denseEndPage=30;

  const coarseOutsideDenseArea=
    chunks.filter(chunk =>
      chunk.endPage < denseStartPage ||
      chunk.startPage > denseEndPage
    );

  const fineDenseArea=
    fineAudit.chunks.filter(chunk =>
      chunk.startPage >= denseStartPage &&
      chunk.endPage <= denseEndPage
    );

  auditChunks=[
    ...coarseOutsideDenseArea,
    ...fineDenseArea
  ].sort(
    (a,b)=>a.startPage-b.startPage
  );

  console.log(
    `COVERAGE AUDIT TEMA 21: auditoría fina en páginas ${denseStartPage}-${denseEndPage}; ${auditChunks.length} bloques de auditoría`
  );
}

const auditItems=[];

for(const chunk of (literalItems?[]:auditChunks)){
  const existingChunkItems=allItems.filter(item=>
    Number(item.sourcePage)>=chunk.startPage &&
    Number(item.sourcePage)<=chunk.endPage
  );

  console.log(
    `COVERAGE AUDIT: revisando páginas ${chunk.startPage}-${chunk.endPage}`
  );

    const auditResponse=await coverageGenerate({
    model:"gemini-3.5-flash-lite",
    contents:[
      {
        text:coverageGapPrompt(
existingChunkItems,
chunk.startPage,
chunk.endPage,
topic.name,
allItems.filter(item=>{
  const sourcePage=Number(item.sourcePage);
  return Number.isFinite(sourcePage) &&
    sourcePage >= 1 &&
    sourcePage < chunk.startPage;
})
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
    const normalizedAuditItems=
  normalizeChunkSourcePages(
    parsedAudit.items,
    chunk
  );

auditItems.push(
  ...normalizedAuditItems
);

    console.log(
      `COVERAGE AUDIT: páginas ${chunk.startPage}-${chunk.endPage}: ${parsedAudit.items.length} omisiones detectadas`
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
    // La aceptación exige coincidencia exacta con todos los códigos leídos del PDF.
    // No depende del tema; si no hay códigos consecutivos, sigue la vía normal.
    if(structuredSource){
      const found=new Map();
      for(const item of validItems){
        const m=String(item.sourceEvidence||"").match(
          /^\s*([A-Z][A-Z0-9]{0,12}[-_]?)(\d{3,6})\b/i);
        if(!m || m[1].toUpperCase()!==structuredSource.prefix ||
           m[2].length!==structuredSource.digits)continue;
        const id=Number(m[2]);
        if(found.has(id))throw new Error(`COVERAGE: identificador `+
          `${structuredSource.prefix}${m[2]} repetido. No se sustituye el tema.`);
        found.set(id,item);
      }
      const missing=[...structuredSource.ids].filter(id=>!found.has(id));
      const extra=[...found.keys()].filter(id=>!structuredSource.ids.has(id));
      if(missing.length || extra.length || found.size!==validItems.length){
        const code=id=>structuredSource.prefix+String(id).padStart(structuredSource.digits,"0");
        throw new Error(`COVERAGE INCOMPLETA: PDF=${structuredSource.ids.size}, `+
          `extraídos=${found.size}, faltan=${missing.length}, extras=${extra.length}. `+
          `Primeros ausentes: ${missing.slice(0,12).map(code).join(", ")}. `+
          `El tema y su PDF anterior permanecen intactos.`);
      }
      // Se conserva el orden documental de los identificadores, NO el orden
      // alfabético arbitrario que devolviera Gemini.
      validItems.splice(0,validItems.length,
        ...[...structuredSource.ids].sort((a,b)=>a-b).map(id=>{
          const item=found.get(id);
          const section=structuredSource.sections.get(id);
          if(!section){
            throw new Error(`COVERAGE: no se pudo identificar el encabezado original `+
              `del registro ${structuredSource.prefix}${String(id).padStart(structuredSource.digits,"0")}. `+
              `No se sustituye el tema.`);
          }
          return {...item,section};
        }));
    }
    

if(coverageTopicNumber(topic.name)===22){
  const normalizeTema22Text=value=>
    String(value || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g,"")
      .toLowerCase()
      .trim();

  const getTema22RowNumber=item=>{
    const match=
      String(item?.sourceEvidence || "")
        .match(/^\s*(\d{1,3})\b/);

    return match
      ? Number(match[1])
      : null;
  };

  const isExcludedIndustrialArea=item=>
    /^\s*\d{1,3}\s+area industrial\b/.test(
      normalizeTema22Text(
        item.sourceEvidence
      )
    );

  const tema22Candidates=
    validItems.filter(
      item=>!isExcludedIndustrialArea(item)
    );

  const rowsByNumber=
    new Map();

  for(const item of tema22Candidates){
    const rowNumber=
      getTema22RowNumber(item);

    if(
      !Number.isInteger(rowNumber) ||
      rowNumber<1 ||
      rowNumber>702
    ){
      continue;
    }

    const previous=
      rowsByNumber.get(rowNumber);

    if(!previous){
      rowsByNumber.set(
        rowNumber,
        item
      );
      continue;
    }

    const currentScore=
      String(item.concept || "").length +
      String(item.sourceEvidence || "").length;

    const previousScore=
      String(previous.concept || "").length +
      String(previous.sourceEvidence || "").length;

    if(currentScore>previousScore){
      rowsByNumber.set(
        rowNumber,
        item
      );
    }
  }

  if(rowsByNumber.size!==209){
    throw new Error(
      `COVERAGE TEMA 22 incompleta: ` +
      `${rowsByNumber.size}/209 filas válidas distintas.`
    );
  }

  const tema22FinalItems=
    [...rowsByNumber.entries()]
      .sort(
        (a,b)=>a[0]-b[0]
      )
      .map(
        ([,item])=>item
      );

  validItems.splice(
    0,
    validItems.length,
    ...tema22FinalItems
  );

  console.log(
    `COVERAGE TEMA 22: ` +
    `${tema22Candidates.length} elementos válidos detectados -> ` +
    `${validItems.length} filas únicas conservadas.`
  );
}
    if(coverageTopicNumber(topic.name)===21){
  const structuralKey=value=>
    String(value || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g,"")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g," ")
      .replace(/\s+/g," ")
      .trim();

  const municipalityKeys=new Set(
    validItems
      .filter(item=>
        structuralKey(item.section)==="tema 21 municipios y ambitos" &&
        String(item.itemType || "").toLowerCase()==="relacion" &&
        String(item.evaluationType || "").toLowerCase()==="pertenencia_exclusion"
      )
      .map(item=>structuralKey(item.concept))
  );

  const subordinateKeys=new Set(
    validItems
      .filter(item=>
        structuralKey(item.section)==="tema 21 concejos y localidades" &&
        String(item.itemType || "").toLowerCase()==="relacion" &&
        String(item.evaluationType || "").toLowerCase()==="pertenencia_exclusion"
      )
      .map(item=>structuralKey(item.concept))
  );

  if(
    municipalityKeys.size<275 ||
    subordinateKeys.size<357
  ){
    throw new Error(
      `COVERAGE TEMA 21 incompleta: ` +
      `${municipalityKeys.size}/275 municipios o ámbitos y ` +
      `${subordinateKeys.size}/357 concejos o localidades.`
    );
  }
}
    if(
      coverageTopicNumber(topic.name)===27 &&
      validItems.length<86
    ){
      throw new Error(
        `COVERAGE TEMA 27 incompleta: ${validItems.length} elementos válidos; mínimo estructural esperado: 86.`
      );
    }
    // Un único procedimiento compartido por TODOS los temas. No utiliza
    // file_search_indexed como prueba de que exista una fuente antigua.
    await replaceTopicDocument(topic,pdfPath,validItems);

    const result=await db.query(
      `SELECT
         t.id,
         t.name,
         t.total_items,
         COUNT(c.id) FILTER (WHERE c.worked = TRUE)::int AS worked_items,
         COUNT(c.id) FILTER (WHERE c.worked = FALSE)::int AS pending_items
       FROM topics t
       LEFT JOIN coverage_items c ON c.topic_id = t.id AND c.exam_relevant=TRUE
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
    await setCoverageRunState(
      coverageRunId,
      {
        status:"completed",
        topicId:Number(summary.id),
        topic:summary.name,
        totalItems:total,
        workedItems:worked,
        pendingItems:Number(summary.pending_items)||0,
        coveragePercentage
      }
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

    try{
      await setCoverageRunState(
        coverageRunId,
        {
          status:"error",
          topicId:topic?.id ? Number(topic.id) : null,
          topic:topic?.name || null,
          error:e?.message || String(e)
        }
      );
    }catch(runStateError){
      console.error(
        "ERROR GUARDANDO ESTADO COVERAGE:",
        runStateError
      );
    }

    if(!res.headersSent){
      res.status(500).json({
        ok:false,
        error:e?.message || String(e)
      });
    }

  }finally{
    if(coverageLock){
      try{
        if(ownsCoverageLock) await coverageLock.query("SELECT pg_advisory_unlock($1::bigint)",
          [900000000000+Number(topic.id)]);
      }catch(error){console.error("[coverage] Liberación de bloqueo",error);}
      coverageLock.release();
    }
    // Solo la solicitud que adquirió el bloqueo puede retirar el PDF.
    // Una petición duplicada rechazada NO debe borrar el archivo que
    // la solicitud activa todavía necesita para subirlo a File Search.
    if(uploadedPdfPath && ownsCoverageLock){
      fs.unlink(uploadedPdfPath,()=>{});
    }
  }
});
app.get("/api/coverage-run/:runId", async(req,res)=>{
  try{
    const runId=
      String(req.params?.runId || "")
        .trim()
        .slice(0,120);

    if(!runId){
      return res.status(400).json({
        ok:false,
        error:"Falta runId."
      });
    }

    const result=await db.query(
      `SELECT value
       FROM app_state
       WHERE key=$1
       LIMIT 1`,
      [`coverage_run:${runId}`]
    );

    if(!result.rows.length){
      return res.json({
        ok:true,
        found:false,
        status:"unknown"
      });
    }

    let state={};

    try{
      state=JSON.parse(result.rows[0].value);
    }catch{
      state={status:"unknown"};
    }

    res.json({
      ok:true,
      found:true,
      ...state
    });

  }catch(e){
    res.status(500).json({
      ok:false,
      error:e?.message || String(e)
    });
  }
});
app.get("/api/geography-coverage-audit", async(req,res)=>{
  try{
    const topicOrder=Number(req.query?.topicOrder);

    if(!Number.isInteger(topicOrder) || topicOrder < 1){
      return res.status(400).json({
        ok:false,
        error:"topicOrder debe ser un entero positivo."
      });
    }

    const search=
      String(req.query?.q || "")
        .trim()
        .slice(0,200);

    const rawLimit=Number(req.query?.limit);
    const limit=
      Number.isInteger(rawLimit)
        ? Math.min(Math.max(rawLimit,1),250)
        : 100;

    const rawOffset=Number(req.query?.offset);
    const offset=
      Number.isInteger(rawOffset) && rawOffset >= 0
        ? rawOffset
        : 0;

    const topicResult=await db.query(
      `SELECT
         id,
         name,
         total_items,
         worked_items
       FROM topics
       WHERE block = 'geografia'
         AND topic_order = $1
       ORDER BY id ASC
       LIMIT 1`,
      [topicOrder]
    );

    if(!topicResult.rows.length){
      return res.status(404).json({
        ok:false,
        error:"No se encontró ese tema de Geografía."
      });
    }

    const topic=topicResult.rows[0];

    const countResult=await db.query(
      `SELECT COUNT(*)::int AS total
       FROM coverage_items
       WHERE topic_id = $1 AND exam_relevant=TRUE
         AND (
           $2 = '' OR
           COALESCE(section,'') ILIKE '%' || $2 || '%' OR
           concept ILIKE '%' || $2 || '%' OR
           COALESCE(source_evidence,'') ILIKE '%' || $2 || '%'
         )`,
      [topic.id,search]
    );

    const itemsResult=await db.query(
      `SELECT
         id,
         section,
         concept,
         item_type,
         evaluation_type,
         source_page,
         manual_page,
         source_evidence
       FROM coverage_items
       WHERE topic_id = $1 AND exam_relevant=TRUE
         AND (
           $2 = '' OR
           COALESCE(section,'') ILIKE '%' || $2 || '%' OR
           concept ILIKE '%' || $2 || '%' OR
           COALESCE(source_evidence,'') ILIKE '%' || $2 || '%'
         )
       ORDER BY
         source_page ASC NULLS LAST,
         section ASC NULLS LAST,
         id ASC
       LIMIT $3
       OFFSET $4`,
      [topic.id,search,limit,offset]
    );

    res.json({
      ok:true,
      topicOrder,
      topic:topic.name,
      totalItems:Number(topic.total_items || 0),
      workedItems:Number(topic.worked_items || 0),
      filter:search || null,
      totalMatching:Number(countResult.rows[0]?.total || 0),
      returned:itemsResult.rows.length,
      limit,
      offset,
      items:itemsResult.rows
    });

  }catch(e){
    console.error("ERROR GEOGRAPHY COVERAGE AUDIT:",e);

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
function buildQuestionFamilyPlan(targets){
  if(!Array.isArray(targets) || !targets.length){
    return [];
  }

  const plans={
    // Nivel C: predomina el dato literal comprobable. Las preguntas
    // INCORRECTA requieren probar tres verdades, por eso no superan el 20%.
    legislacion:[
      "2026_CORRECTA",
      "2024_TEXTO",
      "2026_CORRECTA",
      "2026_INCORRECTA",
      "2024_TEXTO"
    ],

    // Solo estilo: en Geografía 2026 predominan preguntas directas
    // sobre ubicaciones, recorridos, relaciones y actuaciones operativas.
    // No se impone una cuota CORRECTA/INCORRECTA.
    geografia:["2024_TEXTO"],

    especifico:[
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
    ]
  };

  const counters={
    legislacion:0,
    geografia:0,
    especifico:0
  };

  return targets.map(item=>{
    const block=
      String(item?.topic_block || "especifico")
        .trim()
        .toLowerCase();

    const plan=
      plans[block] || plans.especifico;

    const current=
      counters[block] ?? 0;

    counters[block]=current + 1;

    return plan[current % plan.length];
  });
}
async function selectSemanticGraphicPair(
  ai,
  coverageCandidates,
  graphicAssets
){
  if(
    !Array.isArray(coverageCandidates) ||
    !coverageCandidates.length ||
    !Array.isArray(graphicAssets) ||
    !graphicAssets.length
  ){
    return null;
  }

  const coverageForModel = coverageCandidates.map(item => ({
    id: Number(item.id),
    topic: item.topic_name || "",
    topicFolder: graphicTopicFolderFromTopicName(item.topic_name) || "",
    section: item.section || "",
    concept: item.concept || ""
  }));

  const assetsForModel = graphicAssets.map(asset => ({
    id: Number(asset.id),
    topicFolder: asset.topic_folder || "",
    concept: asset.concept || "",
    description: asset.description || ""
  }));

  const semanticPrompt = `
Actúas exclusivamente como emparejador semántico de material didáctico
para una oposición de bomberos.

Debes relacionar UNA imagen técnica ya analizada con UN objetivo curricular.

IMPORTANTE:
- NO generes ninguna pregunta.
- NO determines ninguna respuesta correcta.
- NO aportes conocimiento externo.
- NO completes información que no esté presente.
- Solo decides si ambos elementos representan EL MISMO CONCEPTO TÉCNICO.
- Una coincidencia de palabras aisladas NO demuestra compatibilidad.
- Ejemplo de incompatibilidad:
  "tensión de la cadena de motosierra" NO es el mismo concepto que
  "zonas de tensión y compresión de un fuste apoyado".
- Debe existir correspondencia técnica clara entre lo representado
  por la imagen y el concepto curricular.
- description sirve únicamente para comprender qué representa la imagen.
- Si no existe ninguna pareja inequívoca, devuelve compatible=false.
- Es preferible rechazar todas las parejas antes que producir una
  asociación dudosa.

OBJETIVOS CURRICULARES:
${JSON.stringify(coverageForModel)}

IMÁGENES TÉCNICAS YA ANALIZADAS:
${JSON.stringify(assetsForModel)}

Selecciona la pareja con correspondencia técnica más clara.
`;

  const semanticSchema = {
    type: "object",
    properties: {
      compatible: { type: "boolean" },
      coverageId: {
        type: ["integer","null"]
      },
      assetId: {
        type: ["integer","null"]
      },
      reason: {
        type: "string"
      }
    },
    required: [
      "compatible",
      "coverageId",
      "assetId",
      "reason"
    ]
  };

  const response = await ai.models.generateContent({
    model: "gemini-3.5-flash-lite",
    contents: semanticPrompt,
    config: {
      responseMimeType: "application/json",
      responseJsonSchema: semanticSchema
    }
  });

  const decision = JSON.parse(response.text);

  console.log(
    "GRAPHIC_SEMANTIC_DECISION",
    JSON.stringify(decision)
  );

  if(
    !decision?.compatible ||
    !Number.isInteger(decision.coverageId) ||
    !Number.isInteger(decision.assetId)
  ){
    return null;
  }

  const coverageItem = coverageCandidates.find(
    item => Number(item.id) === Number(decision.coverageId)
  );

  const graphicAsset = graphicAssets.find(
    asset => Number(asset.id) === Number(decision.assetId)
  );

  if(!coverageItem || !graphicAsset){
    return null;
  }

  /*
  Barrera determinista:
  Gemini solo puede devolver IDs que realmente le hemos proporcionado.
  */
  return {
    coverageItem,
    graphicAsset
  };
}
    function normalizeGenerationBlocks(value){
  const allowed =
    new Set([
      "legislacion",
      "geografia",
      "especifico"
    ]);

  const input =
    Array.isArray(value)
      ? value
      : [];

  return [
    ...new Set(
      input
        .map(item=>
          String(item || "")
            .trim()
            .toLowerCase()
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g,"")
        )
        .filter(item=>allowed.has(item))
    )
  ];
}

function normalizeGenerationTopicIds(value){
  const input =
    Array.isArray(value)
      ? value
      : [];

  return [
    ...new Set(
      input
        .map(Number)
        .filter(id=>
          Number.isInteger(id) &&
          id > 0
        )
    )
  ];
}

async function resolveGenerationTopicScope(body = {}){
  const selectedBlocks =
    normalizeGenerationBlocks(
      body.selectedBlocks
    );

  const selectedTopicIds =
    normalizeGenerationTopicIds(
      body.selectedTopicIds
    );

  /*
  Sin filtros = todo el temario.
  Mantiene compatibilidad con la interfaz actual
  mientras terminamos el frontend.
  */
  if(
    !selectedBlocks.length &&
    !selectedTopicIds.length
  ){
    return null;
  }

  const result =
    await db.query(
      `
      SELECT id
      FROM topics
      WHERE
        (
          COALESCE(
            array_length($1::text[],1),
            0
          ) > 0
          AND block = ANY($1::text[])
        )
        OR
        (
          COALESCE(
            array_length($2::int[],1),
            0
          ) > 0
          AND id = ANY($2::int[])
        )
      ORDER BY
        CASE block
          WHEN 'legislacion' THEN 1
          WHEN 'geografia' THEN 2
          WHEN 'especifico' THEN 3
          ELSE 4
        END,
        topic_order NULLS LAST,
        id
      `,
      [
        selectedBlocks,
        selectedTopicIds
      ]
    );

  const allowedTopicIds =
    result.rows
      .map(row=>Number(row.id))
      .filter(Number.isInteger);

  if(!allowedTopicIds.length){
    throw new Error(
      "La selección de contenido no contiene ningún tema disponible."
    );
  }

  return allowedTopicIds;
}
async function getFailedCoverageTargets(
  count,
  allowedTopicIds = null
){
  const result = await db.query(
    `
    WITH latest_answer AS (
      SELECT DISTINCT ON (tsq.coverage_item_id)
        tsq.coverage_item_id,
        tsq.question_id,
        tsq.is_correct,
        tsq.is_blank,
        tsq.answered_at

      FROM test_session_questions tsq

      WHERE
        tsq.answered_at IS NOT NULL
        AND tsq.is_blank = FALSE

      ORDER BY
        tsq.coverage_item_id,
        tsq.answered_at DESC,
        tsq.id DESC
    )

    SELECT
      ci.id,
      ci.topic_id,
      ci.exam_relevant,
      t.name AS topic_name,
      t.block AS topic_block,
      ci.section,
      ci.concept,
      ci.item_type,
      ci.evaluation_type,
      ci.source_page,
      ci.manual_page,
      ci.source_evidence,
ci.times_asked,
ci.times_correct,
ci.times_wrong,
ci.times_blank,

la.question_id AS failed_question_id,
la.answered_at AS failed_at,
qb.difficulty AS failed_difficulty,

qb.question_family AS question_family,
qb.stem AS failed_stem,
qb.options AS failed_options

    FROM latest_answer la

    JOIN coverage_items ci
      ON ci.id = la.coverage_item_id

    JOIN topics t
  ON t.id = ci.topic_id

JOIN question_bank qb
  ON qb.id = la.question_id

WHERE
  la.is_correct = FALSE
  AND (ci.exam_relevant = TRUE OR ci.item_type='anki_independent')
  AND ${GEOGRAPHY_EXAMINABLE_SQL_125}
  AND (
    $2::int[] IS NULL
    OR ci.topic_id = ANY($2::int[])
  )

ORDER BY
      la.answered_at DESC

    LIMIT $1
    `,
  [
  Number(count),
  Array.isArray(allowedTopicIds)
    ? allowedTopicIds
    : null
]
  );

  return result.rows.map(row=>({
  ...row,

questionFamily:
  row.question_family === "GRAFICA"
    ? "2024_TEXTO"
    : (row.question_family || "2024_TEXTO"),

  failedQuestion:{
    questionId:
      Number(row.failed_question_id),

    stem:
      row.failed_stem,

    options:
      row.failed_options
  }
}));
}
async function getAdaptiveCoverageCandidates(
  limit = 120,
  allowedTopicIds = null,
  selectionStrategy = "adaptive"
){
  const orderClause =
    selectionStrategy === "simulation"
      ? `ORDER BY RANDOM()`
      : `
        ORDER BY
          adaptive_priority ASC,

          CASE
            WHEN crs.next_review_at IS NOT NULL
            THEN crs.next_review_at
          END ASC NULLS LAST,

          ci.times_wrong DESC,
          ci.times_blank DESC,
          ci.times_asked ASC,
          ci.last_asked_at ASC NULLS FIRST,
          ci.id ASC
      `;
  const result = await db.query(
    `
    SELECT
      ci.id,
      ci.topic_id,
      t.name AS topic_name,
      t.block AS topic_block,
      ci.section,
      ci.concept,
      ci.item_type,
      ci.evaluation_type,
      ci.source_page,
      ci.manual_page,
      ci.source_evidence,
      ci.worked,
      ci.times_asked,
      ci.times_correct,
      ci.times_wrong,
      ci.times_blank,
      ci.last_asked_at,

      crs.review_stage,
      crs.next_review_at,
      crs.last_review_at,
      crs.consecutive_correct,
      crs.consecutive_wrong,
      crs.total_reviews,

        COALESCE(
        last_nonblank_answer.is_correct = FALSE,
        FALSE
      ) AS latest_nonblank_failed,
      CASE
        WHEN
          ci.times_asked > 0
          AND crs.next_review_at IS NOT NULL
          AND crs.next_review_at <= NOW()
        THEN 1

        WHEN
  ci.times_asked > 0
  AND last_nonblank_answer.is_correct = FALSE
THEN 2

        WHEN
          ci.times_asked > 0
          AND (ci.times_wrong + ci.times_blank) > 0
          AND (
            ci.times_correct::numeric /
            NULLIF(
              ci.times_correct +
              ci.times_wrong +
              ci.times_blank,
              0
            )
          ) < 0.70
        THEN 3

        WHEN COALESCE(ci.times_asked,0) = 0
        THEN 4

        ELSE 5
      END AS adaptive_priority

    FROM coverage_items ci

JOIN topics t
  ON t.id = ci.topic_id

LEFT JOIN coverage_review_state crs
  ON crs.coverage_item_id = ci.id

LEFT JOIN LATERAL (
  SELECT
    tsq.is_correct,
    tsq.answered_at
  FROM test_session_questions tsq
  WHERE
    tsq.coverage_item_id = ci.id
    AND tsq.answered_at IS NOT NULL
    AND tsq.is_blank = FALSE
  ORDER BY
    tsq.answered_at DESC,
    tsq.id DESC
  LIMIT 1
) last_nonblank_answer
  ON TRUE

WHERE
  ci.exam_relevant = TRUE
  AND ${GEOGRAPHY_EXAMINABLE_SQL_125}
  AND (
    $2::int[] IS NULL
    OR ci.topic_id = ANY($2::int[])
  )

    ${orderClause}

    LIMIT $1
    `,
    [
  Number(limit),
  Array.isArray(allowedTopicIds)
    ? allowedTopicIds
    : null
]
  );

  return result.rows;
}

async function getNewCoverageCandidate(
  allowedTopicIds = null
){
  const result = await db.query(`
    SELECT
      ci.id,
      ci.topic_id,
      t.name AS topic_name,
      t.block AS topic_block,
      ci.section,
      ci.concept,
      ci.item_type,
      ci.evaluation_type,
      ci.source_page,
      ci.manual_page,
      ci.source_evidence,
      ci.worked,
      ci.times_asked,
      ci.times_correct,
      ci.times_wrong,
      ci.times_blank,
      ci.last_asked_at,
      NULL::integer AS review_stage,
      NULL::timestamptz AS next_review_at,
      NULL::timestamptz AS last_review_at,
      NULL::integer AS consecutive_correct,
      NULL::integer AS consecutive_wrong,
      NULL::integer AS total_reviews,
      4 AS adaptive_priority
    FROM coverage_items ci
    JOIN topics t
      ON t.id = ci.topic_id
    WHERE
  ci.exam_relevant = TRUE
  AND ${GEOGRAPHY_EXAMINABLE_SQL_125}
  AND ci.times_asked = 0
  AND (
    $1::int[] IS NULL
    OR ci.topic_id = ANY($1::int[])
  )
    ORDER BY
      ci.times_asked ASC,
      ci.last_asked_at ASC NULLS FIRST,
      ci.id ASC
    LIMIT 1
  `,
  [
    Array.isArray(allowedTopicIds)
      ? allowedTopicIds
      : null
  ]
);

  return result.rows[0] || null;
}

/* SERVER 83: selector puro, testeable y sin llamadas de red.
 * Una cobertura equivale a un hecho examinable; Anki solo se favorece
 * cuando existe un enlace REAL contrastado con ese mismo hecho.
 */
function chooseLegislationCoverage83({candidates,statsRows,recentRows,verifiedAnkiIds,freshAnkiIds,count,strategy,sectionKey,tokensFor,overlap,seed}){
  const norm=value=>String(value||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .toLowerCase().replace(/[^a-z0-9]+/g,' ').trim().replace(/\s+/g,' ');
  const subkey=item=>`${Number(item.topic_id)}:${norm(item.section||'sin epigrafe')}`;
  const conceptKey=item=>`${Number(item.topic_id)}:${norm(item.concept)}`;
  const nucleus=item=>sectionKey(item)||subkey(item);
  const stats=new Map((statsRows||[]).map(row=>[subkey(row),{
    total:Number(row.total)||1, asked:Number(row.asked_count)||0
  }]));
  // Comparar el dato central, nunca texto editorial/páginas que comparten plantilla.
  const conceptStop=new Set('articulo articulos sobre segun conforme acuerdo constitucion espanola organica funcion funciones regulacion regimen juridico contenido establecer establece indica cuales respuesta preguntas ejercicio deber deberes derecho derechos facultad facultades corresponde determinadas determinacion estas estos aquellos toda todos normativa prevision previsiones definicion definiciones entre cual para como hasta donde quienes siguiente siguientes'.split(' '));
  const tokenCache=new WeakMap();
  const contentTokens=item=>{
    if(tokenCache.has(item))return tokenCache.get(item);
    const set=new Set(norm(item.concept).split(' ').filter(t=>t && (t.length>=4 || /^\d+$/.test(t)) && !conceptStop.has(t)));
    tokenCache.set(item,set);return set;
  };
  const recentIds=new Set(), recentConcepts=new Set(), recentByNucleus=new Map();
  const recentBySub=new Map(), pastConcepts=[];
  const recentSessionIds=[...new Set((recentRows||[]).map(row=>Number(row.session_id)))].sort((a,b)=>b-a);
  const sessionRanks=new Map(recentSessionIds.map((id,index)=>[id,index]));
  for(const row of recentRows||[]){
    recentIds.add(Number(row.id));
    recentConcepts.add(conceptKey(row));
    const nk=nucleus(row),sk=subkey(row),rank=sessionRanks.get(Number(row.session_id))??99;
    const hit=recentByNucleus.get(nk)||{hits:0,latest:99};
    hit.hits++;hit.latest=Math.min(hit.latest,rank);recentByNucleus.set(nk,hit);
    const sub=recentBySub.get(sk)||{hits:0,latest:99};
    sub.hits++;sub.latest=Math.min(sub.latest,rank);recentBySub.set(sk,sub);
    pastConcepts.push({nucleus:nk,tokens:contentTokens(row),item:row});
  }
  const historicByNucleus=new Map();
  const seenSub=new Set();
  for(const candidate of candidates){
    const sk=subkey(candidate);
    if(seenSub.has(sk))continue;
    seenSub.add(sk);
    const nk=nucleus(candidate),s=stats.get(sk)||{total:1,asked:0};
    const old=historicByNucleus.get(nk)||{total:0,asked:0};
    old.total+=s.total;old.asked+=s.asked;
    historicByNucleus.set(nk,old);
  }
  const seenIds=new Set();const seenConcepts=new Set();const seenNuclei=new Map();
  const selected=[];let selectedAnki=0,selectedNew=0;
  const isNew=item=>Number(item.times_asked||0)===0;
  const hasAnki=item=>verifiedAnkiIds.has(Number(item.id));
  const freshAnki=item=>freshAnkiIds.has(Number(item.id));
  const recentCache=new WeakMap();
  const recent=item=>{
    if(recentCache.has(item))return recentCache.get(item);
    const tokens=contentTokens(item);
    const value=recentIds.has(Number(item.id))||recentConcepts.has(conceptKey(item))||
      (tokens.size>=4 && pastConcepts.some(prev=>prev.nucleus===nucleus(item) &&
        prev.tokens.size>=4 && overlap(tokens,prev.tokens)>=0.90));
    recentCache.set(item,value);return value;
  };
  const distinctWithinTest=item=>!seenConcepts.has(conceptKey(item)) && !selected.some(other=>
    nucleus(other)===nucleus(item) && contentTokens(item).size>=4 &&
    contentTokens(other).size>=4 && overlap(contentTokens(item),contentTokens(other))>=0.85);
  // Se ordenan las secciones y núcleos por su exposición histórica, no por ID.
  function score(item){
    const nk=nucleus(item),sk=subkey(item);
    const nh=recentByNucleus.get(nk)||{hits:0,latest:99};
    const sh=recentBySub.get(sk)||{hits:0,latest:99};
    const st=stats.get(sk)||{total:1,asked:0};
    const nt=historicByNucleus.get(nk)||{total:1,asked:0};
    const priority=Number(item.adaptive_priority)||5;
    const seen=seenNuclei.get(nk)||0;
    const recentNucPenalty=nh.latest===0?105:nh.latest===1?50:nh.latest===2?23:0;
    const recentSubPenalty=sh.latest===0?60:sh.latest===1?25:0;
    const topicSame=selected.filter(s=>Number(s.topic_id)===Number(item.topic_id)).length;
    return -seen*220-recentNucPenalty-recentSubPenalty
      -nh.hits*2.5-sh.hits*2.8
      -36*nt.asked/Math.max(1,nt.total)
      -54*st.asked/Math.max(1,st.total)
      -Math.min(12,Number(item.times_asked||0))*5
      -topicSame*16
      +(isNew(item)?25:0)
      +(priority===1?22:priority===2?16:priority===3?10:0)
      +((priority===1 && item.next_review_at)?Math.min(10,Math.max(0,(Date.now()-new Date(item.next_review_at))/86400000)):0);
  }
  const idOrder=item=>((Math.imul(Number(item.id)||0,1103515245)^Math.imul(seed||0,12345))>>>0);
  function take(filter,{permitSameNucleus=false,permitRecent=false}={}){
    const pool=candidates.filter(item=>
      !seenIds.has(Number(item.id)) && filter(item) && distinctWithinTest(item) &&
      (permitSameNucleus||!seenNuclei.has(nucleus(item))) &&
      (permitRecent||!recent(item)));
    if(!pool.length)return false;
    pool.sort((a,b)=>score(b)-score(a)||idOrder(a)-idOrder(b)||Number(a.id)-Number(b.id));
    const picked=pool[0];
    selected.push(picked);seenIds.add(Number(picked.id));seenConcepts.add(conceptKey(picked));
    const nk=nucleus(picked);seenNuclei.set(nk,(seenNuclei.get(nk)||0)+1);
    if(hasAnki(picked))selectedAnki++;
    if(isNew(picked))selectedNew++;
    return true;
  }
  // Seleccion preliminar: 80% objetivo Anki. La cuota obligatoria y la
  // validacion del enlace se aplican finalmente en applyLegislationAnkiQuota84.
  const requestedAnki=Math.ceil(count*0.80);
  const requestedNew=(strategy==='simulation')?0:Math.ceil(count*0.50);
  const actualFreshAnki=candidates.filter(c=>freshAnki(c)&&!recent(c)).length;
  const ankiGoal=Math.min(requestedAnki,actualFreshAnki);
  // Si no coincide con objetivos no trabajados, la prioridad Anki se comprueba
  // posteriormente contra todo el banco validado del tema.
  const overlapCount=candidates.filter(c=>freshAnki(c)&&isNew(c)&&!recent(c)).length;
  const newGoal=Math.min(requestedNew,count-ankiGoal+overlapCount);
  function exhaust(predicate,goalFn){
    for(let pass=0;pass<2&&selected.length<count&&goalFn();pass++){
      while(selected.length<count&&goalFn() && take(predicate,{permitSameNucleus:pass===1})){}
    }
  }
  // 1. Anki NUEVAS para cumplir ambas metas y reducir repetición de conocimientos.
  exhaust(c=>freshAnki(c)&&isNew(c),()=>selectedAnki<ankiGoal&&selectedNew<newGoal);
  // 2. Anki vinculadas contrastadas NO recientes.
  exhaust(c=>freshAnki(c),()=>selectedAnki<ankiGoal);
  // 3. Extensión de cobertura REAL (no presentaciones sin responder).
  exhaust(c=>isNew(c),()=>selectedNew<newGoal);
  // 4. Resto: SRS y debilidades con rotación por sección y núcleo.
  exhaust(()=>true,()=>selected.length<count);
  // 5. Único respaldo: la ventana reciente se relaja si no alcanza el material.
  // No relajar coincidencias dentro del MISMO test ni falsear la fuente Anki.
  if(selected.length<count){
    for(const permitSameNucleus of [false,true]){
      while(selected.length<count&&take(()=>true,{permitSameNucleus,permitRecent:true})){}
    }
  }
  const metrics={requested:count,selected:selected.length,
    uniqueNuclei:seenNuclei.size,uniqueSubindexes:new Set(selected.map(subkey)).size,
    historicallyRecentReused:selected.filter(recent).length,
    ankiVerified:selectedAnki,ankiGoalRequested:requestedAnki,ankiPoolFresh:actualFreshAnki,
    newActual:selectedNew,newGoalRequested:requestedNew,
    selectedCoverageIds:selected.map(x=>Number(x.id)),
    selectedNuclei:selected.map(nucleus)};
  return {selected,metrics};
}

// SERVER_85: helpers compartidos entre seleccion de cobertura y cuota Anki 80 %.
const legislationDiversityNormalize = value =>
  String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g,"")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g," ")
    .trim()
    .replace(/\s+/g," ");

const legislationSectionKey = candidate => {
  if(
    String(candidate?.topic_block || "")
      .trim()
      .toLowerCase() !== "legislacion"
  ){
    return null;
  }

  const section = legislationDiversityNormalize(candidate?.section);
  const concept = legislationDiversityNormalize(candidate?.concept);
  const evidence = legislationDiversityNormalize(candidate?.source_evidence);
  const text = [section,concept,evidence].filter(Boolean).join(" ");
  if(!text){ return null; }

  const topicId = Number(candidate?.topic_id || 0);
  const topicName = legislationDiversityNormalize(candidate?.topic_name);
  const isConstitution =
    coverageTopicNumber(candidate?.topic_name) === 1 &&
    /constitucion/.test(topicName);

  /*
   * SERVER_73 — CONSTITUCIÓN: núcleo jurídico real, no epígrafe editorial.
   * Clasificar ANTES de escoger coverage_items. Una sub-sección de Cortes
   * no puede constituir un núcleo nuevo, ni «suspensión individual» debe
   * aparecer como otro núcleo distinto de la suspensión general.
   * Priorizar la sección, después el concepto y por último la evidencia:
   * una mención incidental a Gobierno o Cortes en la evidencia no desplaza
   * el título constitucional que estamos evaluando.
   */
  if(isConstitution){
    const keyForArticle = value => {
      const articles = [...String(value||"").matchAll(
        /\b(?:articulo|articulos|art|arts)\s*(\d{1,3})(?!\d)/g
      )].map(match=>Number(match[1]));
      if(articles.includes(55)){ return "suspension_estados_excepcionales"; }
      const range = (min,max)=>articles.some(n=>n>=min && n<=max);
      if(range(166,169)){ return "reforma_constitucional"; }
      if(range(159,165)){ return "tribunal_constitucional"; }
      if(range(137,158)){ return "organizacion_territorial"; }
      if(range(128,136)){ return "economia_hacienda"; }
      if(range(117,127)){ return "poder_judicial"; }
      if(range(97,107)){ return "gobierno_administracion"; }
      if(range(66,96)){ return "cortes_generales"; }
      if(range(56,65)){ return "corona"; }
      if(range(10,54)){ return "derechos_deberes"; }
      if(range(1,9)){ return "titulo_preliminar"; }
      return null;
    };

    const keyForText = (value, isSection=false) => {
      if(!value){ return null; }
      // La prioridad evita colisiones semánticas (Cortes controlan Gobierno).
      if(/\bpreambulo\b/.test(value)){ return "preambulo"; }
      if(/suspension|suspend|estado de sitio|estado de excepcion|estado de alarma|estados excepcionales/.test(value)){
        return "suspension_estados_excepcionales";
      }
      if(/tribunal constitucional|\btitulo ix\b/.test(value)){
        return "tribunal_constitucional";
      }
      if(/reforma constitucional|reforma de la constitucion|\btitulo x\b/.test(value)){
        return "reforma_constitucional";
      }
      if(/\bcorona\b|\brey\b|\bmonarca\b|refrendo|regencia|sucesion a la corona|\btitulo ii\b/.test(value)){
        return "corona";
      }
      if(/cortes generales|\bcongreso\b|\bsenado\b|\bcamaras?\b|\bdiputad|\bsenador|\bparlamentari|mandato imperativo|\btitulo iii\b/.test(value)){
        return "cortes_generales";
      }
      if(/poder judicial|jueces|magistrados|consejo general del poder judicial|ministerio fiscal|\btitulo vi\b/.test(value)){
        return "poder_judicial";
      }
      if(/organizacion territorial|comunidades autonomas|municipios|provincias|\btitulo viii\b/.test(value)){
        return "organizacion_territorial";
      }
      if(/economia y hacienda|haciendas locales|tribut|\btitulo vii\b/.test(value)){
        return "economia_hacienda";
      }
      if(/gobierno y administracion|presidente del gobierno|consejo de ministros|\btitulo iv\b|\btitulo v\b/.test(value)){
        return "gobierno_administracion";
      }
      if(/derechos y deberes|derechos fundamentales|tutela judicial|recurso de amparo|\btitulo i\b/.test(value)){
        return "derechos_deberes";
      }
      if(/titulo preliminar|estado social|soberania nacional|monarquia parlamentaria|pluralismo politico/.test(value)){
        return "titulo_preliminar";
      }
      // Concepto/evidencia, NO sección: evita que el mero uso de Gobierno
      // en un comentario sobre las Cortes distorsione el núcleo.
      if(!isSection){
        if(/\bgobierno\b|\badministracion\b/.test(value)){
          return "gobierno_administracion";
        }
        if(/\blibertad\b|\bigualdad\b|\bderechos\b/.test(value)){
          return "derechos_deberes";
        }
      }
      return null;
    };

    const nucleus =
      keyForText(section,true) ||
      keyForArticle(section) ||
      keyForText(concept) ||
      keyForArticle(concept) ||
      keyForArticle(evidence) ||
      keyForText(evidence) ||
      "otros_constitucion";

    // Los epígrafes desconocidos NO se hacen pasar por núcleos independientes.
    return `${topicId}:nucleus:${nucleus}`;
  }

  /* Otros temas de Legislación: preservar las reglas previas (server_72). */
  const articleNumbers = [...text.matchAll(
    /(?:articulo|articulos|art|arts)\s*(\d{1,3})/g
  )].map(match=>Number(match[1]));
  const hasArticleInRange = (min,max) =>
    articleNumbers.some(number=>number>=min && number<=max);
  let nucleus = null;
  if(/\bpreambulo\b/.test(text)){ nucleus="preambulo"; }
  else if(/\bcorona\b|\brey\b|\bsucesion\b|\bregencia\b|\brefrendo\b/.test(text) || hasArticleInRange(56,65)){
    nucleus="corona";
  }else if(/suspension.*derech|derech.*suspension|estado.*alarma|estado.*excepcion|estado.*sitio|estados.*excepcional/.test(text) || articleNumbers.includes(55)){
    nucleus="suspension_estados_excepcionales";
  }else if(/tribunal constitucional/.test(text) || hasArticleInRange(159,165)){
    nucleus="tribunal_constitucional";
  }else if(/reforma constitucional|reforma.*constitucion/.test(text) || hasArticleInRange(166,169)){
    nucleus="reforma_constitucional";
  }else if(/cortes generales|congreso|senado|diputad|senador/.test(text) || hasArticleInRange(66,96)){
    nucleus="cortes_generales";
  }else if(/gobierno|administracion|presidente del gobierno|consejo de ministros/.test(text) || hasArticleInRange(97,107)){
    nucleus="gobierno_administracion";
  }else if(/poder judicial|jueces|magistrados|tribunales|consejo general del poder judicial|ministerio fiscal/.test(text) || hasArticleInRange(117,127)){
    nucleus="poder_judicial";
  }else if(/organizacion territorial|comunidades autonomas|municipios|provincias|autonomia/.test(text) || hasArticleInRange(137,158)){
    nucleus="organizacion_territorial";
  }else if(/economia|hacienda|presupuestos|tribut|sector publico/.test(text) || hasArticleInRange(128,136)){
    nucleus="economia_hacienda";
  }else if(/derechos fundamentales|derechos y deberes|libertad|igualdad|tutela|recurso de amparo|defensor del pueblo/.test(text) || hasArticleInRange(10,54)){
    nucleus="derechos_deberes";
  }else if(/titulo preliminar|estado social|soberania|monarquia parlamentaria|pluralismo politico|lengua oficial|bandera|capital del estado|partidos politicos|sindicatos/.test(text) || hasArticleInRange(1,9)){
    nucleus="titulo_preliminar";
  }
  if(nucleus){ return `${topicId}:nucleus:${nucleus}`; }
  return section ? `${topicId}:section:${section}` : null;
};
const geographyNorm115 = value => String(value ?? '')
  .normalize('NFD').replace(/[\u0300-\u036f]/g,'')
  .toLowerCase().replace(/[^a-z0-9]+/g,' ').trim().replace(/\s+/g,' ');
const geographyTopic115 = target => {
  const named=coverageTopicNumber(target?.topic_name);
  if(named!=null)return Number(named);
  // Los títulos subidos son también «30 TUNELES», «28 RIOS...».
  // No alterar el analizador global usado por otros bloques.
  const leading=String(target?.topic_name||'').trim().match(/^(\d{1,2})(?:\s|[.·:_-])/);
  return leading ? Number(leading[1]) : 0;
};
const geographyPure115 = targets => Array.isArray(targets) && targets.length>0 &&
  targets.every(t=>String(t?.topic_block||'').toLowerCase()==='geografia' &&
    [21,22,23,24,28,30].includes(geographyTopic115(t)));
function geographyTunnelRoad78(item){
  // Sólo identificadores explícitos del PDF, sin inferir parques ni carreteras.
  const source=[item?.section,item?.concept,item?.source_evidence].filter(Boolean).join(' ');
  const road=source.match(/\b(?:N\s*[-–]\s*121\s*[-–]\s*A|A\s*[-–]\s*15|AP\s*[-–]\s*15|A\s*[-–]\s*21|N\s*[-–]\s*\d{2,4}|NA\s*[-–]\s*\d{2,4}(?:\s*[-–]\s*\d+)?|A\s*[-–]\s*\d{1,3})\b/i);
  return road ? geographyNorm115(road[0]) : null;
}
function geographyAreaGroup115(item){
  if(geographyTopic115(item)===30){
    const road=geographyTunnelRoad78(item);
    if(road)return `${item?.topic_id||0}:via:${road}`;
    // Sin vía explícita: no inventar una; conservar apartado real.
    return `${item?.topic_id||0}:tunel:${geographyNorm115(item?.section)||'sin_via'}`;
  }
  // Tema 28: repartir los objetivos entre fichas de ríos R01, R02, etc.
  // Se usan exclusivamente los identificadores del propio temario.
  if(geographyTopic115(item)===28){
    const section=String(item?.section||'');
    const concept=String(item?.concept||'');
    const evidence=String(item?.source_evidence||'');
    const ficha=section.match(/\bR(\d{2})(?:-\d{2})?\b/i) ||
      concept.match(/\bR(\d{2})-\d{2}\b/i) ||
      evidence.match(/\bR(\d{2})-\d{2}\b/i);
    if(ficha)return `${item?.topic_id||0}:rio:R${ficha[1]}`;
    // Si el identificador no aparece, conservar el apartado real.
    return `${item?.topic_id||0}:rio:${geographyNorm115(item?.section)||'sin_ficha'}`;
  }
  const concept=String(item?.concept||'');
  const arrow=concept.split('->').map(s=>s.trim()).filter(Boolean);
  const area=arrow.length>=2 ? arrow[arrow.length-1] :
    concept.match(/\bcon\s+el\s+parque\s+(?:de\s+)?([^,]+)/i)?.[1] ||
    concept.match(/\bparque\s+(?:de\s+bomberos\s+)?asociado\s*[:\-]?\s*([^,]+)/i)?.[1] ||
    String(item?.section||'');
  return `${item?.topic_id||0}:${geographyNorm115(area)||'sin_area'}`;
}
// SERVER 81: única política transversal de rotación entre objetivos.
// Opera ANTES de elegir plazas, dentro de cada prioridad SRS; no altera la BD.
// Legislación mantiene su selector 83 especializado y sus enlaces Anki.
function geographyDiverseCandidates115(rows){
  if(!Array.isArray(rows)||rows.length<2)return rows;
  if(rows.every(r=>String(r?.topic_block||'').trim().toLowerCase()==='legislacion'))return rows;
  const norm=value=>String(value||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .toLowerCase().replace(/[^a-z0-9]+/g,' ').trim().replace(/\s+/g,' ');
  const sectionOf=row=>`${row.topic_id}:seccion:${norm(row.section)||'sin seccion'}`;
  const pageOf=row=>{const page=row.manual_page??row.source_page;return page==null||String(page).trim()===''?null:`${row.topic_id}:pagina:${String(page).trim()}`;};
  // La relación factual se define por el conocimiento, no por el texto generado.
  const factOf=row=>`${row.topic_id}:${norm(row.concept)||`item ${row.id}`}`;
  const usedTopics=new Map(),usedSections=new Map(),usedFacts=new Map(),usedPages=new Map();
  const result=[];
  const priorities=[...new Set(rows.map(r=>Number(r.adaptive_priority)||0))].sort((a,b)=>a-b);
  for(const priority of priorities){
    const pending=rows.filter(r=>(Number(r.adaptive_priority)||0)===priority);
    // Primera vuelta: alternar temas, secciones y hechos, sin sacrificar SRS.
    while(pending.length){
      let best=0,bestScore=null;
      for(let i=0;i<pending.length;i++){
        const row=pending[i],topic=String(row.topic_id),section=sectionOf(row),fact=factOf(row);
        const page=pageOf(row);
        const score=[usedFacts.get(fact)||0,usedSections.get(section)||0,
          page?(usedPages.get(page)||0):0,usedTopics.get(topic)||0,i];
        if(!bestScore||score.some((v,j)=>v!==bestScore[j]&&score.slice(0,j).every((x,k)=>x===bestScore[k])&&v<bestScore[j])){
          best=i;bestScore=score;
        }
      }
      const row=pending.splice(best,1)[0];
      result.push(row);
      const topic=String(row.topic_id),section=sectionOf(row),fact=factOf(row);
      usedTopics.set(topic,(usedTopics.get(topic)||0)+1);
      usedSections.set(section,(usedSections.get(section)||0)+1);
      usedFacts.set(fact,(usedFacts.get(fact)||0)+1);
      const page=pageOf(row);if(page)usedPages.set(page,(usedPages.get(page)||0)+1);
    }
  }
  return result;
}

/* SERVER 123: preguntas de ubicación, intervención y pertenencia territorial.
   Familias cerradas: nunca superficie, potencia, promotores ni deducciones de distancia.
   Un plan de formato por OBJETIVO reduce la invención de asociaciones nuevas. */

// Corrección editorial 13/10: T22 pregunta SOLO POLÍGONOS con nombre.
// No convierte filas de ÁREA, ZONA, SECTOR o CIUDAD en objetivos de examen.
// El filtro afecta a la selección, no elimina registros históricos de cobertura.
// SERVER 125: la misma regla de examinabilidad para selección, historial y
// estadísticas. No borra ni modifica los 209 registros históricos del Tema 22.
// El filtro SQL reproduce el prefijo de geographyEligible124 (polígono con nombre).
const GEOGRAPHY_EXAMINABLE_SQL_125 = `(
  LOWER(BTRIM(COALESCE(t.block,''))) <> 'geografia'
  OR t.topic_order IS DISTINCT FROM 22
  OR BTRIM(COALESCE(ci.concept,'')) ~* '^pol[ií]gono[[:space:]]+[^[:space:]]'
)`;

// En el PDF T22 aparecen varias sedes AGRUPADAS. Estas no son parques únicos.
// Lodosa, Peralta, Alsasua, Oronoz, Navascués y Sangüesa son independientes.

// Los once parques son respuestas distintas; alias bilingües sí equivalen.




// SERVER 135 — tablas del PDF proporcionado por el usuario (T23/T24).
// Solo se emplean tres columnas examinables: instalación, municipios y parque.
// No se alteran los coverage_items ni la fuente factual; se restaura su lectura
// estructurada cuando el texto generado en cobertura no expresa «ubicado en».
// SERVER 80: tablas territoriales 135 retiradas. Mezclaban fuentes antiguas con
// la cobertura GEOFACT1 definitiva (p.ej. Rada -> Tafalla, hoy Peralta).
// No se usa ninguna tabla de hechos adicional al PDF/coverage_items.
function geographyTableRecord135(){ return null; }

// SERVER 125: '/' puede separar dos municipios o dos nombres del MISMO
// municipio (castellano/euskera). Solo se acepta la segunda situación si
// T21 documenta ambos alias en la misma entidad; la ambigüedad se excluye
// ANTES de pagar una generación. Nunca deducir proximidad/distancias.



// 127: eliminar pistas SOLO cuando son datos territoriales conocidos del PDF.
// No se alteran la respuesta, su índice, la cita ni el registro de cobertura.










// SERVER 123: rechazos deterministas ANTES de consumir File Search.
// El auditor documental sigue siendo obligatorio para CADA pregunta entregada.







async function getCoverageTargetsForGeneration(
  count,
  ai,
  allowedTopicIds = null,
  selectionStrategy = "adaptive"
){
  /*
    SELECCIÓN DE OBJETIVOS

    - Las familias no gráficas conservan el funcionamiento normal.
    - La plaza GRAFICA se resuelve buscando una combinación REAL:
        coverage_item + graphic_asset compatible.
    - Nunca se utiliza un asset de otro tema.
    - Nunca se reutiliza un asset agotado si quedan alternativas.
    - Si no existe ninguna combinación gráfica válida:
        CALCULO_FORMULACION -> 2024_NUMERICA -> 2024_TEXTO.
  */

// LEGISLACIÓN (un único tema): ver suficientes páginas y núcleos.
// El orden de prioridad adaptativa se conserva; la consulta sigue siendo
// PostgreSQL local, sin llamadas adicionales a Gemini.
const nucleusCandidateLimit =
  Array.isArray(allowedTopicIds) && allowedTopicIds.length === 1
    ? Math.max(count * 100, 1400)
    : (Array.isArray(allowedTopicIds) && allowedTopicIds.length<=20 ? Math.max(count * 70, 2400) : Math.max(count * 25, 300));
const adaptiveCandidates = geographyDiverseCandidates115(
  await getAdaptiveCoverageCandidates(
    nucleusCandidateLimit,
    allowedTopicIds,
    selectionStrategy
  )
);

if(adaptiveCandidates.length < count){
  throw new Error(
    `No hay suficientes coverage_items disponibles para generar ${count} preguntas.`
  );
}

/*
SELECCIÓN ANTI-SOLAPAMIENTO

Evita incluir en el mismo test conocimientos prácticamente
idénticos, sin eliminar ni fusionar coverage_items de la BD.

La prioridad adaptativa ya viene ordenada desde SQL.
Por tanto recorremos los candidatos en ese mismo orden y
conservamos siempre el candidato de mayor prioridad.
*/
const selectedAdaptive = [];

/*
Mientras exista contenido nuevo, garantizamos una plaza
para avance de cobertura.

No fijamos porcentajes rígidos:
el resto del test continúa gobernado por la prioridad adaptativa.
*/
let newCandidate = null;

if(selectionStrategy !== "simulation"){
  newCandidate =
    adaptiveCandidates.find(
      candidate => Number(candidate.times_asked || 0) === 0
    );

  if(!newCandidate){
    newCandidate =
      await getNewCoverageCandidate(
        allowedTopicIds
      );
  }
}

// SERVER_82: la primera plaza nueva de Legislación se elige DESPUÉS
// de ordenar subíndices según el historial; no por el menor id de BD.
const legislationScope82 = adaptiveCandidates.length > 0 &&
  adaptiveCandidates.every(item => String(item?.topic_block || '').trim().toLowerCase() === 'legislacion');
// SERVER 81: conservar la plaza de cobertura nueva del selector original.
// La lista ya está equilibrada dentro de su prioridad por el plan transversal.
if(newCandidate && !legislationScope82){
  selectedAdaptive.push(newCandidate);
}

const deferredGeographyCandidates = [];
const usedGeographyMunicipalities = new Set();

/*
DIVERSIDAD INTERNA — LEGISLACIÓN

En tests de un mismo tema legal evitamos concentrar varias preguntas
seguidas en la misma página/fragmento del temario mientras existan
objetivos equivalentes de otras páginas.

No elimina coverage_items ni altera prioridades SRS: únicamente difiere
los candidatos de una página ya representada hasta completar primero
una muestra más amplia del tema.
*/
const deferredLegislationPageCandidates = [];
const deferredLegislationSemanticCandidates = [];
const usedLegislationPages = new Set();
const usedLegislationSections = new Set();
const usedLegislationSemanticTexts = [];

const LEGISLATION_DIVERSITY_STOPWORDS = new Set([
  "segun","conforme","acuerdo","articulo","articulos","ley","foral",
  "real","decreto","organica","constitucion","espanola","navarra",
  "sera","seran","puede","pueden","debe","deben","cual","cuales",
  "siguiente","siguientes","respuesta","respuestas","correcta","incorrecta",
  "verdadera","falsa","entre","sobre","para","como","cuando","donde",
  "desde","hasta","este","esta","estos","estas","aquel","aquella",
  "del","las","los","una","uno","unos","unas","que","por","con",
  "sin","sus","son","sea","sean","tiene","tienen","corresponde"
]);

const legislationDiversityTokens = candidate => {
  const text = legislationDiversityNormalize([
    candidate?.section,
    candidate?.concept,
    candidate?.source_evidence
  ].filter(Boolean).join(" "));

  return new Set(
    text.split(" ").filter(token =>
      token &&
      (token.length >= 4 || /^\d+$/.test(token)) &&
      !LEGISLATION_DIVERSITY_STOPWORDS.has(token)
    )
  );
};

const legislationSemanticOverlap = (a,b) => {
  if(!a?.size || !b?.size){
    return 0;
  }

  let intersection = 0;
  for(const token of a){
    if(b.has(token)){
      intersection++;
    }
  }

  return intersection / Math.min(a.size,b.size);
};

const legislationPageKey = candidate => {
  if(
    String(candidate?.topic_block || "")
      .trim()
      .toLowerCase() !== "legislacion"
  ){
    return null;
  }

  const page =
    candidate?.manual_page ??
    candidate?.source_page ??
    null;

  if(page == null || String(page).trim() === ""){
    return null;
  }

  return `${Number(candidate?.topic_id || 0)}:${String(page).trim()}`;
};

const geographyMunicipalityKey = candidate => {
  const topicNumber =
    coverageTopicNumber(candidate?.topic_name);

  if(![22,23,24,25].includes(topicNumber)){
    return null;
  }

  const concept =
    String(candidate?.concept || "");

  const match =
    concept.match(
      /\bubicad[oa]s?\s+en\s+(.+?)(?=\s+con\s+(?:el|la)\s+parque\b|,\s*(?:asociad[oa]|adscrit[oa]|superficie|per[ií]metro)\b|$)/i
    );

  if(!match?.[1]){
    return null;
  }

  return match[1]
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g,"")
    .toLowerCase()
    .trim()
    .replace(/\s+/g," ");
};

for(const selected of selectedAdaptive){
  const key =
    geographyMunicipalityKey(selected);

  if(key){
    usedGeographyMunicipalities.add(key);
  }

  const legislationPage =
    legislationPageKey(selected);

  if(legislationPage){
    usedLegislationPages.add(
      legislationPage
    );
  }

  const legislationSection =
    legislationSectionKey(selected);

  if(legislationSection){
    usedLegislationSections.add(
      legislationSection
    );
  }

  if(
    String(selected?.topic_block || "")
      .trim()
      .toLowerCase() === "legislacion"
  ){
    usedLegislationSemanticTexts.push(
      legislationDiversityTokens(selected)
    );
  }
}
/*
LEGISLACIÓN — SELECCIÓN POR NÚCLEO PRIMERO

Cuando el test seleccionado pertenece exclusivamente al bloque de Legislación,
la primera pasada no elige coverage_items uno tras otro. Primero ocupa, en el
orden adaptativo original, una plaza por núcleo jurídico distinto. Solo después,
si todavía faltan preguntas, actúan las pasadas normales de respaldo.

La clave de núcleo incluye topic_id, por lo que también funciona al seleccionar
varios temas de Legislación sin mezclar sus núcleos entre sí.
*/
const legislationOnlySelection =
  adaptiveCandidates.length > 0 &&
  adaptiveCandidates.every(candidate =>
    String(candidate?.topic_block || "")
      .trim()
      .toLowerCase() === "legislacion"
  );

/*
SERVER_74 — diversificación y prioridad Anki SIN cambiar la prioridad SRS.
- Los candidatos mantienen el orden por adaptive_priority (vencidos,
  debilidades, nuevo y mantenimiento).
- En el MISMO nivel de prioridad se prefieren los conocimientos que tienen
  una pregunta Anki/FDF validada y vinculada, para reducir generación Gemini.
- En Constitución no se admiten más de dos objetivos del mismo conjunto
  de actividad legislativa en la primera pasada si quedan otras opciones.
- No se toca ningún coverage_item, ni las preguntas originales FDF.
*/
const constitutionOnlySelection =
  legislationOnlySelection &&
  adaptiveCandidates.every(candidate =>
    coverageTopicNumber(candidate?.topic_name) === 1 &&
    /constitucion/.test(legislationDiversityNormalize(candidate?.topic_name))
  );

const constitutionLegislativeProcessKey = candidate => {
  if(!constitutionOnlySelection){ return null; }
  const text = legislationDiversityNormalize([
    candidate?.section,
    candidate?.concept
  ].filter(Boolean).join(" "));
  return /(?:proyectos? de ley|proposiciones? de ley|iniciativa legislativa|iniciativa popular|decretos? leyes|decreto ley|procedimiento legislativo|funcion legislativa|promulgacion de las leyes|sancion de las leyes|entrada en vigor de las leyes|vacatio legis|elaboracion de las leyes|leyes organicas|delegacion legislativa|legislacion delegada|decretos? legislativos?|ley(?:es)? de bases|textos? refundidos?)/.test(text)
    ? "actividad_legislativa"
    : null;
};
// SERVER_75: evitamos específicamente duplicar la legislación delegada
// (aunque los coverage_items tengan secciones o núcleos distintos).
// Solo se aplica en la primera pasada y no impide el fallback si faltan candidatos.
const constitutionLegislativeSubtopicKey = candidate => {
  if(!constitutionOnlySelection){ return null; }
  const text = legislationDiversityNormalize([
    candidate?.section,
    candidate?.concept
  ].filter(Boolean).join(" "));
  if(/(?:delegacion legislativa|legislacion delegada|decretos? legislativos?|ley(?:es)? de bases|textos? refundidos?|refundir textos|refundicion)/.test(text)){
    return "legislacion_delegada";
  }
  return null;
};

// SERVER_83 — sustituimos el selector completo (no un nuevo parche de ranking).
// La selección se apoya en sesiones anteriores, objetivos realmente contestados,
// rotación entre núcleos/subíndices y enlaces Anki validados contra el mismo PDF.
if(legislationOnlySelection){
  const topicIds=[...new Set(adaptiveCandidates.map(x=>Number(x.topic_id)).filter(Number.isInteger))];
  const statsResult=await db.query(`
    SELECT topic_id, section, COUNT(*)::int AS total,
           COALESCE(SUM(times_asked),0)::int AS asked_count
    FROM coverage_items
    WHERE exam_relevant=TRUE AND topic_id=ANY($1::int[])
    GROUP BY topic_id,section
  `,[topicIds]);
  const recentResult=await db.query(`
    WITH recent_sessions AS (
      SELECT DISTINCT tsq.session_id
      FROM test_session_questions tsq
      JOIN coverage_items ci ON ci.id=tsq.coverage_item_id
      WHERE ci.topic_id=ANY($1::int[])
      ORDER BY tsq.session_id DESC
      LIMIT 18
    )
    SELECT ci.id,ci.topic_id,ci.section,ci.concept,ci.source_evidence,
           tsq.session_id
    FROM test_session_questions tsq
    JOIN recent_sessions rs ON rs.session_id=tsq.session_id
    JOIN coverage_items ci ON ci.id=tsq.coverage_item_id
    WHERE ci.topic_id=ANY($1::int[])
  `,[topicIds]);
  const linked=await db.query(`
    SELECT id,anki_note_id,topic_order,stem,options,correct_index,
      correct_answer,validation_evidence,validated_coverage_item_id,
      last_used_at,times_used
    FROM legislation_anki_questions
    WHERE validation_status='validated' AND direct_use_eligible=TRUE
      AND validated_coverage_item_id=ANY($1::int[])
    ORDER BY times_used ASC,id ASC
  `,[adaptiveCandidates.map(item=>Number(item.id))]);
  const candidateById=new Map(adaptiveCandidates.map(item=>[Number(item.id),item]));
  const verifiedAnkiIds=new Set(),freshAnkiIds=new Set();
  let rejectedAnki=0;
  const freshnessCutoff=Date.now()-12*60*60*1000;
  for(const row of linked.rows){
    const target=candidateById.get(Number(row.validated_coverage_item_id));
    if(!target || Number(row.topic_order)!==ankiLegislationSourceOrderForTopicName(target.topic_name) ||
      legislationKnownAmbiguityIssue(row) || legislationConflictingArticles(target,row) ||
      !legislationExactCoverageLink(target,row)){
      rejectedAnki++;continue;
    }
    const id=Number(target.id);
    verifiedAnkiIds.add(id);
    const fresh=!row.last_used_at||new Date(row.last_used_at).getTime()<freshnessCutoff;
    if(fresh)freshAnkiIds.add(id);
    if(!target.ankiPreferredFamily||fresh){
      target.ankiPreferredFamily=inferLegislationAnkiFamily(row.stem);
    }
  }
  const lastSession=recentResult.rows.reduce((n,r)=>Math.max(n,Number(r.session_id)||0),0);
  const decision=chooseLegislationCoverage83({
    candidates:adaptiveCandidates,
    statsRows:statsResult.rows,
    recentRows:recentResult.rows,
    verifiedAnkiIds,freshAnkiIds,count,strategy:selectionStrategy,
    sectionKey:legislationSectionKey,tokensFor:legislationDiversityTokens,
    overlap:legislationSemanticOverlap,seed:lastSession+1
  });
  if(decision.selected.length<count){
    throw new Error(`Rotación 83: solo ${decision.selected.length} conocimientos distintos para ${count} plazas. No rellenamos con repeticiones.`);
  }
  selectedAdaptive.push(...decision.selected);
  console.log('LEGISLATION ROTATION 83:',JSON.stringify({
    ...decision.metrics,ankiLinkedVerified:verifiedAnkiIds.size,
    ankiLinkRejected:rejectedAnki,selectionStrategy
  }));
}

for(const candidate of adaptiveCandidates){

  if(selectedAdaptive.length >= count){
    break;
  }

  if(
    selectedAdaptive.some(
      selected => Number(selected.id) === Number(candidate.id)
    )
  ){
    continue;
  }

  const candidateConcept =
    String(candidate.concept || "")
      .trim()
      .toLowerCase();

  const candidateSection =
    String(candidate.section || "")
      .trim()
      .toLowerCase();

  const overlaps = selectedAdaptive.some(selected => {

    const selectedConcept =
      String(selected.concept || "")
        .trim()
        .toLowerCase();

    const selectedSection =
      String(selected.section || "")
        .trim()
        .toLowerCase();

    return (
      candidateConcept &&
      candidateConcept === selectedConcept &&
      candidateSection === selectedSection
    );
  });

  if(overlaps){
    continue;
  }
const geographyMunicipality =
  geographyMunicipalityKey(candidate);

if(
  geographyMunicipality &&
  usedGeographyMunicipalities.has(
    geographyMunicipality
  )
){
  deferredGeographyCandidates.push(candidate);
  continue;
}

const legislationSection =
  legislationSectionKey(candidate);

const legislationTokens =
  legislationDiversityTokens(candidate);

const legislationSemanticRepeated =
  String(candidate?.topic_block || "")
    .trim()
    .toLowerCase() === "legislacion" &&
  (
    (
      legislationSection &&
      usedLegislationSections.has(legislationSection)
    ) ||
    usedLegislationSemanticTexts.some(tokens =>
      legislationSemanticOverlap(
        legislationTokens,
        tokens
      ) >= 0.42
    )
  );

if(legislationSemanticRepeated){
  deferredLegislationSemanticCandidates.push(candidate);
  continue;
}

const legislationPage =
  legislationPageKey(candidate);

if(
  legislationPage &&
  usedLegislationPages.has(
    legislationPage
  )
){
  deferredLegislationPageCandidates.push(candidate);
  continue;
}

  selectedAdaptive.push(candidate);
if(geographyMunicipality){
  usedGeographyMunicipalities.add(
    geographyMunicipality
  );
}
if(legislationPage){
  usedLegislationPages.add(
    legislationPage
  );
}
if(legislationSection){
  usedLegislationSections.add(
    legislationSection
  );
}
if(
  String(candidate?.topic_block || "")
    .trim()
    .toLowerCase() === "legislacion"
){
  usedLegislationSemanticTexts.push(
    legislationTokens
  );
}
  if(selectedAdaptive.length === count){
    break;
  }
}
if(selectedAdaptive.length < count){

  for(
    const candidate
    of deferredGeographyCandidates
  ){

    if(
      selectedAdaptive.some(
        selected =>
          Number(selected.id) ===
          Number(candidate.id)
      )
    ){
      continue;
    }

    const candidateConcept =
      String(candidate.concept || "")
        .trim()
        .toLowerCase();

    const candidateSection =
      String(candidate.section || "")
        .trim()
        .toLowerCase();

    const overlaps =
      selectedAdaptive.some(selected =>
        String(selected.concept || "")
          .trim()
          .toLowerCase() ===
            candidateConcept &&
        String(selected.section || "")
          .trim()
          .toLowerCase() ===
            candidateSection
      );

    if(overlaps){
      continue;
    }

    selectedAdaptive.push(candidate);

    if(selectedAdaptive.length === count){
      break;
    }
  }
}
if(selectedAdaptive.length < count){
  for(
    const candidate
    of deferredLegislationSemanticCandidates
  ){
    if(
      selectedAdaptive.some(
        selected =>
          Number(selected.id) ===
          Number(candidate.id)
      )
    ){
      continue;
    }

    const candidateConcept =
      String(candidate.concept || "")
        .trim()
        .toLowerCase();

    const candidateSection =
      String(candidate.section || "")
        .trim()
        .toLowerCase();

    const overlaps =
      selectedAdaptive.some(selected =>
        String(selected.concept || "")
          .trim()
          .toLowerCase() ===
            candidateConcept &&
        String(selected.section || "")
          .trim()
          .toLowerCase() ===
            candidateSection
      );

    if(overlaps){
      continue;
    }

    const nucleusKey = legislationSectionKey(candidate);
    if(
      nucleusKey &&
      usedLegislationSections.has(nucleusKey)
    ){
      continue;
    }

    selectedAdaptive.push(candidate);

    const pageKey = legislationPageKey(candidate);
    if(pageKey){
      usedLegislationPages.add(pageKey);
    }
    if(nucleusKey){
      usedLegislationSections.add(nucleusKey);
    }
    usedLegislationSemanticTexts.push(
      legislationDiversityTokens(candidate)
    );

    if(selectedAdaptive.length === count){
      break;
    }
  }
}

if(selectedAdaptive.length < count){
  for(
    const candidate
    of deferredLegislationPageCandidates
  ){
    if(
      selectedAdaptive.some(
        selected =>
          Number(selected.id) ===
          Number(candidate.id)
      )
    ){
      continue;
    }

    const candidateConcept =
      String(candidate.concept || "")
        .trim()
        .toLowerCase();

    const candidateSection =
      String(candidate.section || "")
        .trim()
        .toLowerCase();

    const overlaps =
      selectedAdaptive.some(selected =>
        String(selected.concept || "")
          .trim()
          .toLowerCase() ===
            candidateConcept &&
        String(selected.section || "")
          .trim()
          .toLowerCase() ===
            candidateSection
      );

    if(overlaps){
      continue;
    }

    selectedAdaptive.push(candidate);

    if(selectedAdaptive.length === count){
      break;
    }
  }
}

if(selectedAdaptive.length < count){
  throw new Error(
    `Solo se han podido seleccionar ${selectedAdaptive.length} objetivos distintos para un test de ${count} preguntas.`
  );
}
const result = {
  rows: selectedAdaptive
};

console.log(
  "LEGISLATION DIVERSITY:",
  selectedAdaptive
    .filter(item =>
      String(item?.topic_block || "")
        .trim()
        .toLowerCase() === "legislacion"
    )
    .map(item => ({
      coverageId:Number(item.id),
      page:item.manual_page ?? item.source_page ?? null,
      nucleus:legislationSectionKey(item),
      section:item.section || "",
      concept:String(item.concept || "").slice(0,120)
    }))
);

  const families = buildQuestionFamilyPlan(result.rows);

  const selected = result.rows.map((item,index)=>({
    ...item,
    questionFamily: item.ankiPreferredFamily || families[index] || "GENERAL"
  }));
/*
VALIDACIÓN PREVIA DE COMPATIBILIDAD DE FAMILIAS

Evita enviar a Gemini objetivos que no contienen el tipo de
información necesario para la familia asignada.
*/
for (let i = 0; i < selected.length; i++) {
  const item = selected[i];

  const evidenceText = [
    item.concept,
    item.source_evidence
  ]
    .filter(Boolean)
    .join(" ");

  if (item.questionFamily === "CALCULO_FORMULACION") {
    const calculationCompatible =
      item.item_type === "formula" ||
      item.evaluation_type === "calculo" ||
      item.evaluation_type === "relacion_variables";

    if (!calculationCompatible) {
      item.questionFamily = "2024_TEXTO";

      console.log(
        "FAMILY_COMPATIBILITY_FALLBACK",
        JSON.stringify({
          coverageId: item.id,
          from: "CALCULO_FORMULACION",
          to: "2024_TEXTO",
          reason: "coverage_sin_capacidad_de_calculo"
        })
      );
    }
  }

  if (item.questionFamily === "2024_NUMERICA") {
    const numericCompatible =
      item.item_type === "dato_numerico" ||
      /\d/.test(evidenceText);

    if (!numericCompatible) {
      item.questionFamily = "2024_TEXTO";

      console.log(
        "FAMILY_COMPATIBILITY_FALLBACK",
        JSON.stringify({
          coverageId: item.id,
          from: "2024_NUMERICA",
          to: "2024_TEXTO",
          reason: "coverage_sin_dato_numerico"
        })
      );
    }
  }
}
  /*
/*
=================================================
RESOLUCIÓN SEMÁNTICA DE LA PLAZA GRAFICA
=================================================

La imagen gobierna la plaza gráfica.

No intentamos emparejar mediante tokens ni puntuaciones léxicas.
Reunimos coverage todavía disponible + assets gráficos utilizables
y Gemini selecciona UNA pareja que represente el mismo concepto técnico.

Si no existe una pareja inequívoca, se aplica fallback.
*/
for(let i = 0; i < selected.length; i++){

  if(selected[i].questionFamily !== "GRAFICA"){
    continue;
  }

  const originalGraphicSlot = selected[i];

  /*
  Coverage que ya está ocupado por las demás plazas del test.
  El coverage de la propia plaza GRAFICA sí puede participar.
  */
  const occupiedCoverageIds = selected
    .filter((_, index) => index !== i)
    .map(item => Number(item.id));

  const graphicCoverageResult = await db.query(
    `
    SELECT
      ci.id,
      t.name AS topic_name,
      t.block AS topic_block,
      ci.section,
      ci.concept,
      ci.item_type,
      ci.evaluation_type,
      ci.source_page,
      ci.manual_page,
      ci.source_evidence
    FROM coverage_items ci
    JOIN topics t ON t.id = ci.topic_id
    WHERE
  ci.exam_relevant = TRUE
  AND ${GEOGRAPHY_EXAMINABLE_SQL_125}
  AND (
    $3::text = 'simulation'
    OR ci.worked = FALSE
  )
  AND NOT (ci.id = ANY($1::int[]))
  AND (
    $2::int[] IS NULL
    OR ci.topic_id = ANY($2::int[])
  )
    ORDER BY
      ci.times_asked ASC,
      ci.last_asked_at ASC NULLS FIRST,
      ci.id ASC
    LIMIT 120
    `,
    [
  occupiedCoverageIds,
  Array.isArray(allowedTopicIds)
    ? allowedTopicIds
    : null,
  selectionStrategy
]
  );

  /*
  Solo conservamos coverage perteneciente a temas que tienen
  una carpeta gráfica conocida.
  */
  const graphicCoverageCandidates =
    graphicCoverageResult.rows
      .map(item => ({
        ...item,
        topic_folder:
          graphicTopicFolderFromTopicName(item.topic_name)
      }))
      .filter(item => item.topic_folder);

  const topicFolders = [
    ...new Set(
      graphicCoverageCandidates.map(item => item.topic_folder)
    )
  ];

  let graphicAssets = [];

  if(topicFolders.length){
    const graphicAssetsResult = await db.query(
      `
      SELECT
        id,
        source_id,
        topic_folder,
        source_file,
        public_url,
        asset_index,
        asset_type,
        concept,
        description,
        source_evidence,
        crop_x,
        crop_y,
        crop_width,
        crop_height,
        mask_regions,
        is_official_reference,
        times_asked,
        last_asked_at
      FROM graphic_assets
      WHERE is_usable = TRUE
        AND analysis_status = 'analyzed'
        AND sanitization_version >= 2
        AND is_official_reference = FALSE
        AND topic_folder = ANY($1::text[])
      ORDER BY
        times_asked ASC,
        last_asked_at ASC NULLS FIRST,
        id ASC
      LIMIT 120
      `,
      [topicFolders]
    );

    graphicAssets = graphicAssetsResult.rows;
  }

  /*
  Una sola decisión semántica.
  */
  const semanticPair =
    await selectSemanticGraphicPair(
      ai,
      graphicCoverageCandidates,
      graphicAssets
    );

  /*
  Barrera adicional determinista:
  incluso si Gemini devolviera dos IDs existentes,
  ambos deben pertenecer al mismo tema gráfico.
  */
  const pairTopicFolder =
    semanticPair
      ? graphicTopicFolderFromTopicName(
          semanticPair.coverageItem.topic_name
        )
      : null;

  const pairIsSameTopic =
    semanticPair &&
    pairTopicFolder &&
    pairTopicFolder === semanticPair.graphicAsset.topic_folder;

  if(pairIsSameTopic){

    const matchedCoverageItem =
      semanticPair.coverageItem;

    const matchedGraphicAsset =
      semanticPair.graphicAsset;

    selected[i] = {
      ...matchedCoverageItem,
      questionFamily: "GRAFICA",

      graphicAsset: {
        id: Number(matchedGraphicAsset.id),
        source_id: matchedGraphicAsset.source_id,
        public_url: matchedGraphicAsset.public_url,
        asset_type: matchedGraphicAsset.asset_type,
        concept: matchedGraphicAsset.concept || "",
        description: matchedGraphicAsset.description || "",
        crop_x: Number(matchedGraphicAsset.crop_x ?? 0),
        crop_y: Number(matchedGraphicAsset.crop_y ?? 0),
        crop_width: Number(matchedGraphicAsset.crop_width ?? 1),
                crop_height: Number(matchedGraphicAsset.crop_height ?? 1),
        mask_regions: Array.isArray(matchedGraphicAsset.mask_regions)
          ? matchedGraphicAsset.mask_regions
          : []
      }
    };

    console.log(
      "GRAPHIC_TARGET_SELECTED_SEMANTIC",
      JSON.stringify({
        coverageId: matchedCoverageItem.id,
        topic: matchedCoverageItem.topic_name,
        coverageConcept: matchedCoverageItem.concept,
        assetId: matchedGraphicAsset.id,
        assetConcept: matchedGraphicAsset.concept
      })
    );

    continue;
  }

  /*
  FALLBACK:
  únicamente cuando no existe una pareja gráfica semánticamente válida.
  */
  const originalText = [
    originalGraphicSlot.section,
    originalGraphicSlot.concept,
    originalGraphicSlot.source_evidence
  ]
    .filter(Boolean)
    .join(" ");

  const hasNumericData =
    originalGraphicSlot.item_type === "dato_numerico" ||
    /\d/.test(originalText);

  const hasCalculationPotential =
    originalGraphicSlot.item_type === "formula" ||
    originalGraphicSlot.evaluation_type === "calculo" ||
    originalGraphicSlot.evaluation_type === "relacion_variables";

  if(hasCalculationPotential){
    selected[i] = {
      ...originalGraphicSlot,
      questionFamily: "CALCULO_FORMULACION"
    };
  }else if(hasNumericData){
    selected[i] = {
      ...originalGraphicSlot,
      questionFamily: "2024_NUMERICA"
    };
  }else{
    selected[i] = {
      ...originalGraphicSlot,
      questionFamily: "2024_TEXTO"
    };
  }

  console.log(
    "GRAPHIC_TARGET_FALLBACK_SEMANTIC",
    JSON.stringify({
      coverageId: originalGraphicSlot.id,
      topic: originalGraphicSlot.topic_name,
      coverageCandidates: graphicCoverageCandidates.length,
      graphicAssets: graphicAssets.length,
      fallbackFamily: selected[i].questionFamily
    })
  );
}

/*
GEOGRAFÍA T21-T27:
las familias numéricas genéricas no deben forzar
preguntas sobre metadatos de tablas.
*/
for(let index = 0; index < selected.length; index++){
  const item = selected[index];

  const topicNumber =
    coverageTopicNumber(item.topic_name);

  const isOperationalGeography =
    Number.isInteger(topicNumber) &&
    topicNumber >= 21 &&
    topicNumber <= 27;

  if(
    isOperationalGeography &&
    (
      item.questionFamily === "2024_NUMERICA" ||
      item.questionFamily === "CALCULO_FORMULACION"
    )
  ){
    const geographyFamilies = ["2024_TEXTO"];

    item.questionFamily =
      geographyFamilies[
        index % geographyFamilies.length
      ];
  }
}

  const usedIds = new Set();

  for(const item of selected){

    if(usedIds.has(Number(item.id))){
      throw new Error(
        `Coverage duplicado durante la selección de objetivos: ${item.id}`
      );
    }

    usedIds.add(Number(item.id));
  }

  return selected;
}
 
      







function ankiLegislationSourceOrderForTopicName(topicName){
  const text=
    String(topicName || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g,"")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g," ")
      .trim()
      .replace(/\s+/g," ");

  if(!text){
    return null;
  }

  if(text.includes("constitucion")) return 2;
  if(text.includes("union europea")) return 3;
  if(text.includes("lorafna")) return 6;

  if(
    text.includes("parlamento") ||
    text.includes("comptos") ||
    text.includes("defensor del pueblo")
  ){
    return 7;
  }

  if(
    text.includes("gobierno de navarra") ||
    text.includes("gobierno navarra")
  ){
    return 8;
  }

  if(
    text.includes("fuentes del derecho") ||
    (text.includes("fuentes") && text.includes("derecho"))
  ){
    return 1;
  }

  if(
    text.includes("11 2019") ||
    text.includes("administracion de la comunidad foral")
  ){
    return 9;
  }

  if(
    text.includes("actos administrativos") ||
    text.includes("acto administrativo")
  ){
    return 4;
  }

  if(
    text.includes("39 2015") ||
    text.includes("procedimiento administrativo comun") ||
    text.includes("disposiciones generales")
  ){
    return 5;
  }

  if(text.includes("13 2007")) return 10;

  if(
    text.includes("igualdad") ||
    text.includes("17 2019")
  ){
    return 11;
  }

  return null;
}



function normalizeLegislationMatchText(value){
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g,"")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g," ")
    .trim()
    .replace(/\s+/g," ");
}

const LEGISLATION_MATCH_STOPWORDS = new Set([
  "segun","conforme","acuerdo","articulo","articulos","ley","foral",
  "real","decreto","organica","constitucion","espanola","navarra",
  "sera","seran","puede","pueden","debe","deben","cual","cuales",
  "siguiente","siguientes","respuesta","respuestas","correcta","incorrecta",
  "verdadera","falsa","entre","sobre","para","como","cuando","donde",
  "desde","hasta","este","esta","estos","estas","aquel","aquella",
  "del","las","los","una","uno","unos","unas","que","por","con",
  "sin","sus","son","sea","sean","tiene","tienen","corresponde"
]);

function legislationMatchTokens(value){
  return new Set(
    normalizeLegislationMatchText(value)
      .split(" ")
      .filter(token=>
        token &&
        (token.length >= 4 || /^\d+$/.test(token)) &&
        !LEGISLATION_MATCH_STOPWORDS.has(token)
      )
  );
}



function inferLegislationAnkiFamily(stem){
  const text=normalizeLegislationMatchText(stem);

  if(
    /\bincorrect[ao]s?\b/.test(text) ||
    /\bfals[ao]s?\b/.test(text) ||
    /\bno\s+(?:corresponde|pertenece|puede|podra|debe|sera|es|son|tiene|tienen)\b/.test(text)
  ){
    return "2026_INCORRECTA";
  }

  return "2026_CORRECTA";
}

function buildDirectAnkiQuestion(row,target){
  return {
    stem:row.stem,
    options:Array.isArray(row.options)
      ? row.options
      : [],
    correctIndex:Number(row.correct_index),
    explanation:
      row.validation_evidence ||
      target.source_evidence ||
      "",
    sourceEvidence:
      target.source_evidence ||
      row.validation_evidence ||
      "",
    sourcePage:
      target.source_page ?? null,
    manualPage:
      target.manual_page ?? null,
    difficulty:
      target.adaptiveDifficulty || "alta",
    questionFamily:
      target.questionFamily === "2024_TEXTO"
        ? "2024_TEXTO"
        : inferLegislationAnkiFamily(row.stem),
    graphic:null,
    reused:false,
    ankiDirect:true,
    ankiQuestionId:Number(row.id),
    ankiNoteId:Number(row.anki_note_id)
  };
}

// SERVER_78: comprobación conservadora y LOCAL de la relación pregunta-objetivo.
// El banco FDF está validado frente al PDF, pero eso NO valida automáticamente
// la correspondencia con cualquier coverage_item del mismo tema.
function legislationExactCoverageLink(target,ankiRow){
  const normal=normalizeLegislationMatchText;
  const concept=String(target?.concept || "");
  const stem=String(ankiRow?.stem || "");
  const options=Array.isArray(ankiRow?.options) ? ankiRow.options : [];
  const answer=options[Number(ankiRow?.correct_index)] || ankiRow?.correct_answer || "";
  const questionText=[stem,answer].filter(Boolean).join(" ");

  // No se acepta la sección editorial como única prueba de equivalencia.
  const generic=new Set([
    "contenido","regulacion","normativa","normativo","normas","estudio",
    "general","generales","disposiciones","identificacion","definicion",
    "concepto","caracteristicas","aspectos","elementos","ambito",
    "establecido","establecida","establecidas","correspondientes",
    "forma","formas","casos","supuestos","relacion","relaciones",
    "principio","principios","fundamento","fundamentos","tipo","tipos",
    "especifico","especifica","ejercicio","aplicacion","constitucional",
    "constitucionales","juridica","juridico","leyes","derechos","deberes"
  ]);
  const meaningfulTokens=text=>[...legislationMatchTokens(text)]
    .filter(token=>!generic.has(token));
  const targetTokens=meaningfulTokens(concept);
  const questionTokens=new Set(meaningfulTokens(questionText));

  // Conceptos genéricos sin anclajes comprobables van a generación PDF.
  if(targetTokens.length < 2 || questionTokens.size < 2){return false;}
  const shared=targetTokens.filter(token=>questionTokens.has(token));
  const ratio=shared.length/targetTokens.length;
  if(shared.length < 2 || ratio < 0.72){return false;}

  // Cuando AMBOS indican artículo concreto, deben compartirlo. No usar los
  // números de epígrafes editoriales (4.1, 2.3) como artículos jurídicos.
  const articles=text=>new Set(
    [...String(text||"").matchAll(/\b(?:art(?:[ií]culo|[ií]culos)?\.?|arts\.?)[\s:ºn\.]*([0-9]{1,4})(?:\.[0-9]+)?/gi)]
      .map(m=>m[1])
  );
  const targetArticles=articles(concept);
  const questionArticles=articles(stem);
  if(targetArticles.size && questionArticles.size &&
    ![...targetArticles].some(n=>questionArticles.has(n))){
    return false;
  }
  return true;
}

// SERVER_79: Anki validado por el PDF y vínculo con coverage_item son dos garantías distintas.
// 1. Emparejar automáticamente solo vínculos existentes y lexicalmente inequívocos.
// 2. Para los demás, una única comprobación semántica por test (candidatos restringidos,
//    mismo tema + familia + evidencia PDF). Ante duda se genera pregunta nueva.
// Nunca modificar el enunciado, número de opciones o solución original de FDF.
function legislationConflictingArticles(target,row){
  const articles=value=>{
    const normalized=normalizeLegislationMatchText(value);
    const found=new Set(
      [...normalized.matchAll(/\b(?:articulo|articulos|art|arts)\s+(\d{1,4})\b/g)]
        .map(match=>Number(match[1]))
    );
    for(const match of normalized.matchAll(
      /\b(?:articulo|articulos|art|arts)\s+(\d{1,4})\s+(?:a|al|hasta)\s+(\d{1,4})\b/g
    )){
      const from=Number(match[1]),to=Number(match[2]);
      if(to>=from && to-from<=100){
        for(let n=from;n<=to;n++){found.add(n);}
      }
    }
    return found;
  };
  const targetArticles=articles([target?.concept,target?.source_evidence].filter(Boolean).join(" "));
  const questionArticles=articles(row?.stem);
  return targetArticles.size>0 && questionArticles.size>0 &&
    ![...targetArticles].some(value=>questionArticles.has(value));
}



// SERVER_80: dos barreras factuales de Constitución (BOE, preámbulo y arts. 56 y 97).
// Detectan solamente contradicciones incontrovertibles; no alteran PDF, Anki,
// banco, historial ni la validez de preguntas legítimas con distractores falsos.
// Los enunciados literales sin CORRECTA/INCORRECTA siguen siendo válidos.
function legislationKnownAmbiguityIssue(question){
  const norm = value => String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
  const stem = norm(question?.stem);
  const options = Array.isArray(question?.options)
    ? question.options.map(norm)
    : [];
  if(!options.length){return null;}
  const asksIncorrect = /\b(?:incorrect[ao]s?|fals[ao]s?|errone[ao]s?)\b/.test(stem) ||
    /\bno\s+(?:es|son|resulta|resultan|se\s+ajusta|corresponde|pertenece)\b/.test(stem);

  // FALLO 1: todos estos seis objetivos están literalmente proclamados en
  // el preámbulo. Preguntar cuál es la INCORRECTA entre cuatro de ellos
  // produce cero soluciones; dos o más en una pregunta positiva producen
  // varias soluciones. Comparar POR OPCIÓN, no por coincidencia de dos frases
  // concretas, que dejaba escapar la pregunta observada en server 79.
  if(/preambulo/.test(stem)){
    const declared=[
      /garantizar\s+(?:la\s+)?convivencia\s+democratica/,
      /consolidar\s+(?:un\s+)?estado\s+de\s+derecho/,
      /proteger\s+a\s+todos\s+los\s+espanoles/,
      /promover\s+(?:el\s+)?progreso\s+de\s+la\s+cultura/,
      /establecer\s+(?:una\s+)?sociedad\s+democratica\s+avanzada/,
      /colaborar\s+en\s+el\s+fortalecimiento\s+de\s+unas\s+relaciones\s+pacificas/
    ];
    const explicitlyTrue = options.filter(option =>
      declared.some(pattern => pattern.test(option))
    ).length;
    if(asksIncorrect && explicitlyTrue===options.length){
      return "LEGISLACIÓN (preámbulo): todas las opciones son propósitos constitucionales verdaderos; no existe una incorrecta.";
    }
    if(!asksIncorrect && explicitlyTrue>=2){
      return "LEGISLACIÓN (preámbulo): existen varias alternativas verdaderas para una pregunta de respuesta única.";
    }
  }

  // FALLO 2: la Corona es Jefatura del Estado (art. 56 CE). El Gobierno
  // ejerce la función ejecutiva (art. 97 CE). La expresión del material de
  // academia «Rey, cabeza del poder ejecutivo» NO puede ser opción correcta
  // en una pregunta afirmativa, aunque figure en el PDF fuente.
  // Sí puede emplearse COMO DISTRACTOR en una pregunta correcta, o como la
  // opción falsa elegida en una pregunta de tipo INCORRECTA.
  // Error real observado en T1: «De las Cámaras» comprende arts. 66-80.
  // La afirmación 67-80 no puede tomarse como enumeración completa.
  // Se descarta el ítem entero para evitar dobles respuestas incorrectas.
  if(/\bcamaras?\b|\bcortes\b/.test(stem) &&
    options.some(option=>/(?:articulos?|arts?)\s+(?:dedicados?|regulan?|comprenden?|extienden?|abarcan?|desde|del)?[\s\w]*?\b67\s+(?:al|a|hasta)\s+(?:el\s+)?80\b/.test(option) &&
      /\bcamaras?\b|\bconstitucion\b/.test(option))){
    return 'LEGISLACIÓN (Cortes): sección De las Cámaras de la CE comprende arts. 66-80, no solo 67-80.';
  }
  // Error real observado: una CA no adquiere potestad para celebrar tratados
  // por poder solicitar o impulsar acuerdos ante el Estado.
  if(/tratados? internacionales?/.test(stem) &&
      /competencia|celebracion|celebrar/.test(stem) &&
      !asksIncorrect){
    const index=Number(question?.correctIndex ?? question?.correct_index);
    const chosen=options[index]||'';
    if(/comunidades? autonomas?/.test(chosen) &&
       /(?:pueden?|podran?|facultad|no carece|capacidad|competencia compartida|cogestionad)/.test(chosen) &&
       !/(?:no\s+(?:pueden?|podran?|tienen?\s+competencia)|carecen?\s+de\s+competencia)/.test(chosen)){
      return 'LEGISLACIÓN (Tratados): posible atribución de celebración de tratados a comunidades autónomas.';
    }
  }
  const selectedIndex=Number(question?.correctIndex ?? question?.correct_index);
  if(!asksIncorrect && Number.isInteger(selectedIndex) &&
     selectedIndex>=0 && selectedIndex<options.length){
    const selected=options[selectedIndex];
    if(/\b(?:rey|monarca)(?:\s*,)?\s+(?:(?:como|es|sera|actua|ejerce)\s+)?(?:la\s+)?(?:cabeza|jefe|titular)\s+del?\s+poder\s+ejecutivo\b/.test(selected)){
      return "LEGISLACIÓN (Corona): la opción marcada atribuye erróneamente al Rey la jefatura del poder ejecutivo (arts. 56 y 97 CE).";
    }
  }
  return null;
}




// SERVER 113: checkpoint de trabajo APROBADO pero sin entregar.
// validation_version=113 + last_shown_at=NULL marca una pregunta que ha
// superado verificacion factual independiente Y auditoria de dificultad.
// No hay sesion, respuesta, uso Anki ni modificación de cobertura/SRS.
const LEGISLATION_READY_VERSION_107 = 113; // 113: auditoría ciega contra PDF + controles deterministas







async function persistGeneratedTest({
  questions,
  targets,
  requestedCount,
  difficulty,
  mode,
  testType = "normal",
  runId = null,
  runSignature = null
}){
  if(
    !Array.isArray(questions) ||
    !Array.isArray(targets) ||
    questions.length !== targets.length
  ){
    throw new Error(
      "PERSISTENCIA: questions y targets no tienen correspondencia 1:1."
    );
  }

  const client = await db.connect();

  try{
    await client.query("BEGIN");

    const sessionResult = await client.query(
  `INSERT INTO test_sessions (
    requested_count,
    difficulty,
    mode,
    test_type,
    total_questions
  )
  VALUES ($1,$2,$3,$4,$5)
  RETURNING id`,
  [
    requestedCount,
    difficulty,
    mode,
    testType,
    questions.length
  ]
);

    const sessionId = Number(sessionResult.rows[0].id);
    const persistedQuestions = [];

    for(let i = 0; i < questions.length; i++){
      const question = questions[i];
      const target = targets[i];
      // Prioridad a la página IMPRESA del manual. La página física del PDF
      // se utiliza únicamente si no hay numeración de manual disponible.
      if(!String(question.manualPage ?? '').trim() && String(target.manual_page ?? '').trim())
        question.manualPage = target.manual_page;
      if(!String(question.sourcePage ?? '').trim() && String(target.source_page ?? '').trim())
        question.sourcePage = target.source_page;
      let questionId;

if(
  question.ankiDirect === true &&
  Number.isInteger(Number(question.ankiQuestionId))
){
  const ankiQuestionId=
    Number(question.ankiQuestionId);

  const ankiCheck=await client.query(
    `SELECT
       id,
       validation_status,
       direct_use_eligible,
       validated_coverage_item_id,
       anki_note_id,
       validation_evidence,
       topic_order,
       stem,
       options,
       correct_index
     FROM legislation_anki_questions
     WHERE id = $1
     FOR UPDATE`,
    [ankiQuestionId]
  );

  if(!ankiCheck.rows.length){
    throw new Error(
      `PERSISTENCIA: pregunta Anki ${ankiQuestionId} inexistente.`
    );
  }

  const ankiRow=ankiCheck.rows[0];

  if(question.stem!==ankiRow.stem ||
    JSON.stringify(question.options)!==JSON.stringify(ankiRow.options) ||
    Number(question.correctIndex)!==Number(ankiRow.correct_index)){
    throw new Error(`PERSISTENCIA: Anki ${ankiQuestionId} difiere de la tarjeta original.`);
  }
  const technicalAnki=question.ankiIndependent===true &&
    target.exam_relevant===false && target.item_type==='anki_independent' &&
    String(target.concept)===`ANKI_ORIGINAL_NOTA_${String(ankiRow.anki_note_id)}` &&
    Number(target.topic_id)>0 &&
    ankiLegislationSourceOrderForTopicName(target.topic_name)===Number(ankiRow.topic_order);
  if(
    (ankiRow.validation_status !== "validated" && !technicalAnki) ||
    ankiRow.validation_status === 'rejected' ||
    ankiRow.direct_use_eligible !== true
  ){
    throw new Error(
      `PERSISTENCIA: pregunta Anki ${ankiQuestionId} no es apta para el modo solicitado.`
    );
  }

  if(!technicalAnki &&
    ankiRow.validated_coverage_item_id != null &&
    Number(ankiRow.validated_coverage_item_id) !== Number(target.id)
  ){
    throw new Error(
      `PERSISTENCIA: pregunta Anki ${ankiQuestionId} ya está enlazada a otro coverage_item.`
    );
  }

  // SERVER_78: barrera transaccional. Nunca persistir ni sumar SRS/cobertura
  // bajo un objetivo que no tenga relación curricular contrastada.
  if(!technicalAnki && (
    (Number(ankiRow.validated_coverage_item_id) !== Number(target.id) &&
      ankiRow.validated_coverage_item_id != null) ||
    (!legislationExactCoverageLink(target,ankiRow) &&
      question.ankiSemanticLinkApproved !== true)
  )){
    throw new Error(
      `PERSISTENCIA: relación Anki ${ankiQuestionId} -> cobertura ${target.id} no acreditada.`
    );
  }

  const existingAnkiBank=await client.query(
    `SELECT id
     FROM question_bank
     WHERE
       source_anki_question_id = $1
       AND coverage_item_id = $2
       AND active = TRUE
     LIMIT 1`,
    [
      ankiQuestionId,
      Number(target.id)
    ]
  );

  if(existingAnkiBank.rows.length){
    questionId=
      Number(existingAnkiBank.rows[0].id);

    await client.query(
      `UPDATE question_bank
       SET
         last_shown_at = NOW(),
         updated_at = NOW()
       WHERE id = $1`,
      [questionId]
    );
  }else{
    const questionResult=await client.query(
      `INSERT INTO question_bank (
        coverage_item_id,
        stem,
        options,
        correct_index,
        explanation,
        source_evidence,
        source_page,
        manual_page,
        question_family,
        difficulty,
        graphic,
        validation_version,
        last_shown_at,
        source_anki_question_id
      )
      VALUES (
        $1,$2,$3::jsonb,$4,$5,$6,$7,$8,$9,$10,NULL,6,NOW(),$11
      )
      RETURNING id`,
      [
        Number(target.id),
        question.stem,
        JSON.stringify(question.options),
        Number(question.correctIndex),
        question.explanation || null,
        question.sourceEvidence || null,
        question.sourcePage ?? null,
        question.manualPage != null
          ? String(question.manualPage)
          : null,
        question.questionFamily,
        question.difficulty || difficulty,
        ankiQuestionId
      ]
    );

    questionId=
      Number(questionResult.rows[0].id);
  }

  await client.query(
    `UPDATE legislation_anki_questions
     SET
       validated_coverage_item_id = CASE WHEN $3::boolean THEN validated_coverage_item_id
         ELSE COALESCE(validated_coverage_item_id, $2) END,
       times_used = times_used + 1,
       last_used_at = NOW(),
       updated_at = NOW()
     WHERE id = $1
       AND ($3::boolean OR validated_coverage_item_id IS NULL OR validated_coverage_item_id = $2)`,
    [ankiQuestionId, Number(target.id),technicalAnki]
  );

}else if(
  question.reused === true &&
  Number.isInteger(Number(question.questionId))
){
  const reusableCheck = await client.query(
    `SELECT id,validation_version,times_shown,last_shown_at,question_family,difficulty,
            stem,options,correct_index
FROM question_bank
WHERE id = $1
  AND coverage_item_id = $2
  AND active = TRUE
  AND validation_version >= 6
LIMIT 1 FOR UPDATE`,
    [
      Number(question.questionId),
      Number(target.id)
    ]
  );

  if(!reusableCheck.rows.length){
    throw new Error(
      `PERSISTENCIA: la pregunta reutilizada ${question.questionId} no corresponde al coverage_item ${target.id}.`
    );
  }

  const bankRow107=reusableCheck.rows[0];
  if(question.readyVerified107===true){
    if(Number(bankRow107.validation_version)!==LEGISLATION_READY_VERSION_107 ||
       bankRow107.last_shown_at!=null || Number(bankRow107.times_shown||0)!==0 ||
       bankRow107.difficulty!=='muy alta' ||
       bankRow107.stem!==question.stem ||
       JSON.stringify(bankRow107.options)!==JSON.stringify(question.options) ||
       Number(bankRow107.correct_index)!==question.correctIndex ||
       bankRow107.question_family!==question.questionFamily){
      throw new Error('Checkpoint 107: pregunta consumida o alterada concurrentemente.');
    }
  }else if(Number(bankRow107.validation_version)===LEGISLATION_READY_VERSION_107){
    throw new Error('Checkpoint 107: consumo no autorizado de pregunta sin entregar.');
  }
  questionId = Number(question.questionId);
await client.query(
  `UPDATE question_bank
   SET last_shown_at=NOW(), updated_at=NOW(),
       validation_version=CASE WHEN validation_version=${LEGISLATION_READY_VERSION_107} THEN 6 ELSE validation_version END
   WHERE id=$1`,
  [questionId]
);
}else{

  const questionResult = await client.query(
    `INSERT INTO question_bank (
      coverage_item_id,
      stem,
      options,
      correct_index,
      explanation,
      source_evidence,
      source_page,
      manual_page,
      question_family,
difficulty,
graphic,
validation_version,
last_shown_at
)
VALUES (
  $1,$2,$3::jsonb,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,6,NOW()
)
    RETURNING id`,
    [
      Number(target.id),
      question.stem,
      JSON.stringify(question.options),
      Number(question.correctIndex),
      question.explanation || null,
      question.sourceEvidence || null,
      question.sourcePage ?? null,
      question.manualPage != null
        ? String(question.manualPage)
        : null,
      question.questionFamily,
      question.difficulty || difficulty,
      question.graphic
        ? JSON.stringify(question.graphic)
        : null
    ]
  );

  questionId = Number(questionResult.rows[0].id);
}

await client.query(
  `INSERT INTO test_session_questions (
    session_id,
    question_id,
    coverage_item_id,
    position
  )
  VALUES ($1,$2,$3,$4)`,
  [
    sessionId,
    questionId,
    Number(target.id),
    i + 1
  ]
);
if(
  question.questionFamily === "GRAFICA" &&
  Number.isInteger(Number(question.graphic?.assetId))
){
  await client.query(
    `UPDATE graphic_assets
     SET
       times_asked = times_asked + 1,
       last_asked_at = NOW(),
       updated_at = NOW()
     WHERE id = $1`,
    [Number(question.graphic.assetId)]
  );
}
persistedQuestions.push({
  ...question,
  questionId,
  coverageItemId:Number(target.id)
});

    }

    // La sesión y su comprobante de recuperación se confirman EN LA MISMA
    // TRANSACCIÓN. No puede existir una sesión confirmada sin su runId
    // recuperable cuando el navegador pierde la respuesta HTTP.
    if(runId){
      const completedPayload={
        status:'completed',
        signature:runSignature,
        sessionId,
        questions:persistedQuestions,
        coverage:{targeted:targets.length,markedWorked:0},
        updatedAt:new Date().toISOString()
      };
      const recoveryState=await client.query(
        `UPDATE app_state SET value=$2 WHERE key=$1
         AND value::jsonb->>'status'='processing'
         AND value::jsonb->>'signature'=$3
         RETURNING key`,
        [`generation_run:${runId}`,JSON.stringify(completedPayload),runSignature]
      );
      if(recoveryState.rowCount!==1){
        throw new Error('PERSISTENCIA: registro de recuperación del test inconsistente.');
      }
    }
    await client.query("COMMIT");

    return {
      sessionId,
      questions:persistedQuestions
    };

  }catch(error){
    await client.query("ROLLBACK");
    throw error;

  }finally{
    client.release();
  }
}
function getNextReviewDate(reviewStage, now = new Date()){
  const next = new Date(now);

  let days;

  if(reviewStage <= 1){
    days = 1;
  }else if(reviewStage === 2){
    days = 7;
  }else if(reviewStage === 3){
    days = 14;
  }else{
    days = 30;
  }

  next.setUTCDate(next.getUTCDate() + days);

  return next;
}

async function registerQuestionAnswer({
  sessionId,
  questionId,
  selectedIndex
}){
  if(
    !Number.isInteger(Number(sessionId)) ||
    !Number.isInteger(Number(questionId)) ||
    !Number.isInteger(Number(selectedIndex)) ||
    Number(selectedIndex) < 0 ||
    Number(selectedIndex) > 3
  ){
    throw new Error("RESPUESTA: datos inválidos.");
  }

  const client = await db.connect();

  try{
    await client.query("BEGIN");

    const result = await client.query(
      `SELECT
         tsq.id AS session_question_id,
         tsq.coverage_item_id,
         tsq.selected_index,
         tsq.is_correct,
         tsq.answered_at,
         qb.correct_index
       FROM test_session_questions tsq
       JOIN question_bank qb
         ON qb.id = tsq.question_id
       WHERE tsq.session_id = $1
         AND tsq.question_id = $2
       FOR UPDATE`,
      [
        Number(sessionId),
        Number(questionId)
      ]
    );

    if(!result.rows.length){
      throw new Error(
        "RESPUESTA: la pregunta no pertenece a esta sesión."
      );
    }

    const row = result.rows[0];

    if(row.answered_at){
      /*
        GUARDADO IDEMPOTENTE:
        si el navegador repite exactamente la misma respuesta porque una
        respuesta HTTP se perdió o Render devolvió una página intermedia,
        no contamos de nuevo estadísticas ni SRS. Simplemente confirmamos
        que esa respuesta ya estaba persistida.
      */
      if(Number(row.selected_index) === Number(selectedIndex)){
        await client.query("COMMIT");

        return {
          isCorrect:Boolean(row.is_correct),
          correctIndex:Number(row.correct_index),
          alreadySaved:true
        };
      }

      throw new Error(
        "RESPUESTA: esta pregunta ya había sido contestada con otra opción."
      );
    }

    const coverageItemId = Number(row.coverage_item_id);
    const correctIndex = Number(row.correct_index);
    const isCorrect =
      Number(selectedIndex) === correctIndex;

    const now = new Date();

    const reviewResult = await client.query(
      `SELECT *
       FROM coverage_review_state
       WHERE coverage_item_id = $1
       FOR UPDATE`,
      [coverageItemId]
    );

    const current =
      reviewResult.rows[0] || null;

    let reviewStage;
    let consecutiveCorrect;
    let consecutiveWrong;

    if(isCorrect){
      reviewStage = current
        ? Math.max(1, Number(current.review_stage) + 1)
        : 1;

      consecutiveCorrect =
        current
          ? Number(current.consecutive_correct) + 1
          : 1;

      consecutiveWrong = 0;

    }else{
      /*
        Un fallo devuelve el conocimiento al ciclo corto.
        Conservamos todo el historial acumulado.
      */
      reviewStage = 1;
      consecutiveCorrect = 0;

      consecutiveWrong =
        current
          ? Number(current.consecutive_wrong) + 1
          : 1;
    }

    const nextReviewAt =
      getNextReviewDate(reviewStage, now);

    await client.query(
      `INSERT INTO coverage_review_state (
         coverage_item_id,
         review_stage,
         next_review_at,
         last_review_at,
         consecutive_correct,
         consecutive_wrong,
         total_reviews,
         total_correct,
         total_wrong,
         updated_at
       )
       VALUES (
         $1,$2,$3,$4,$5,$6,
         1,$7,$8,NOW()
       )
       ON CONFLICT (coverage_item_id)
       DO UPDATE SET
         review_stage = EXCLUDED.review_stage,
         next_review_at = EXCLUDED.next_review_at,
         last_review_at = EXCLUDED.last_review_at,
         consecutive_correct = EXCLUDED.consecutive_correct,
         consecutive_wrong = EXCLUDED.consecutive_wrong,
         total_reviews =
           coverage_review_state.total_reviews + 1,
         total_correct =
           coverage_review_state.total_correct + EXCLUDED.total_correct,
         total_wrong =
           coverage_review_state.total_wrong + EXCLUDED.total_wrong,
         updated_at = NOW()`,
      [
        coverageItemId,
        reviewStage,
        nextReviewAt,
        now,
        consecutiveCorrect,
        consecutiveWrong,
        isCorrect ? 1 : 0,
        isCorrect ? 0 : 1
      ]
    );

    await client.query(
      `UPDATE test_session_questions
       SET
         selected_index = $1,
         is_correct = $2,
         answered_at = $3
       WHERE id = $4`,
      [
        Number(selectedIndex),
        isCorrect,
        now,
        Number(row.session_question_id)
      ]
    );

    await client.query(
      `UPDATE question_bank
       SET
         times_shown = times_shown + 1,
         times_correct =
           times_correct + $1,
         times_wrong =
           times_wrong + $2,
         last_shown_at = $3,
         updated_at = NOW()
       WHERE id = $4`,
      [
        isCorrect ? 1 : 0,
        isCorrect ? 0 : 1,
        now,
        Number(questionId)
      ]
    );

    await client.query(
      `UPDATE coverage_items
       SET
         worked = TRUE,
         times_asked = times_asked + 1,
         times_correct =
           times_correct + $1,
         times_wrong =
           times_wrong + $2,
         last_asked_at = $3
       WHERE id = $4`,
      [
        isCorrect ? 1 : 0,
        isCorrect ? 0 : 1,
        now,
        coverageItemId
      ]
    );

    const sessionStats = await client.query(
      `SELECT
         COUNT(*) FILTER (
           WHERE answered_at IS NOT NULL
         )::int AS answered,

         COUNT(*) FILTER (
           WHERE is_correct = TRUE
         )::int AS correct,

         COUNT(*) FILTER (
           WHERE is_correct = FALSE
         )::int AS wrong,

         COUNT(*)::int AS total
       FROM test_session_questions
       WHERE session_id = $1`,
      [Number(sessionId)]
    );

    const stats = sessionStats.rows[0];

    const completed =
      Number(stats.answered) === Number(stats.total);

    await client.query(
      `UPDATE test_sessions
       SET
         correct_answers = $1,
         wrong_answers = $2,
         completed = $3,
         completed_at =
           CASE
             WHEN $3 = TRUE THEN NOW()
             ELSE completed_at
           END
       WHERE id = $4`,
      [
        Number(stats.correct),
        Number(stats.wrong),
        completed,
        Number(sessionId)
      ]
    );

    await client.query("COMMIT");

    return {
      isCorrect,
      correctIndex,
      reviewStage,
      nextReviewAt,
      completed,
      stats:{
        answered:Number(stats.answered),
        total:Number(stats.total),
        correct:Number(stats.correct),
        wrong:Number(stats.wrong)
      }
    };

  }catch(error){
    await client.query("ROLLBACK");
    throw error;

  }finally{
    client.release();
  }
}
app.get("/api/debug-srs", async(req,res)=>{
  try{
    const result = await db.query(`
      SELECT
        crs.coverage_item_id,
        t.name AS topic,
        ci.section,
        ci.concept,
        crs.review_stage,
        crs.next_review_at,
        crs.last_review_at,
        crs.consecutive_correct,
        crs.consecutive_wrong,
        crs.total_reviews,
        crs.total_correct,
        crs.total_wrong
      FROM coverage_review_state crs
      JOIN coverage_items ci
        ON ci.id = crs.coverage_item_id
      JOIN topics t
        ON t.id = ci.topic_id
      ORDER BY crs.last_review_at DESC
      LIMIT 50
    `);

    res.json({
      ok:true,
      count:result.rows.length,
      reviews:result.rows
    });

  }catch(e){
    console.error("ERROR DEBUG SRS:",e);

    res.status(500).json({
      ok:false,
      error:e?.message || String(e)
    });
  }
});


// SERVER 125: se ha eliminado una funcion historica sin referencias ejecutables.

// SERVER 94 — Ejemplos pedagógicos acordados para LEGISLACIÓN, no hechos reutilizables.
// Cada base es la única respuesta correcta; cada variante modifica un único detalle.
// Ninguna pregunta de esta biblioteca puede constituir evidencia factual para otros temas.
const LEGISLACION_REFERENCIAS_94 = Object.freeze([
  {id:'CE-A',topic:'1',level:'alta',source:'Constitución, art. 55.2',
    stem:'Según el artículo 55.2 de la Constitución Española, en las investigaciones sobre bandas armadas o elementos terroristas, ¿qué conjunto de derechos puede suspenderse individualmente con las garantías exigidas?',
    base:'Los derechos reconocidos en los artículos 17.2, 18.2 y 18.3.',
    variants:[[['17.2','17.3']], [['18.2','18.1']], [['18.3','18.4']], null],
    why:'Tres apartados legales exactos. Cada opción cambia un único apartado; nivel Alta por depender de una disposición concreta.'},
  {id:'CE-M',topic:'1',level:'muy alta',source:'Constitución, art. 99',
    stem:'De conformidad con el artículo 99 de la Constitución Española, cuando la primera votación de investidura no obtiene mayoría absoluta, indique el procedimiento posterior íntegramente correcto: nueva votación, mayoría exigida, cómputo de los dos meses, disolución y refrendo.',
    base:'La segunda votación se celebrará cuarenta y ocho horas después y bastará la mayoría simple. Si ningún candidato obtiene la confianza, transcurridos dos meses desde la primera votación de investidura, el Rey disolverá ambas Cámaras y convocará elecciones con el refrendo del Presidente del Congreso.',
    variants:[[['primera votación de investidura','segunda votación de investidura']],null,[['Presidente del Congreso','Presidente del Gobierno']],[['mayoría simple','mayoría absoluta']]],
    why:'Cuatro condiciones relacionadas; la alteración de un único cómputo, mayoría u órgano cambia la validez de toda la alternativa.'},
  {id:'AT-A1',topic:'17',level:'alta',source:'ITC-RAT 01, aparato extraíble',
    stem:'Según la ITC-RAT 01, ¿qué definición corresponde correctamente a un aparato extraíble?',
    base:'Aparato que permite separarlo del conjunto de la instalación bajo tensión, pero sin carga, y situarlo en posición de seguridad, con sus circuitos de alta tensión sin tensión.',
    variants:[[['pero sin carga','y con carga']],[['bajo tensión, pero sin carga','sin tensión, pero con carga']],null,[['con sus circuitos de alta tensión sin tensión','con sus circuitos de alta tensión bajo tensión']]],
    why:'Diferencia precisa entre separación bajo tensión y circulación de carga y condición de seguridad final.'},
  {id:'AT-A2',topic:'17',level:'alta',source:'ITC-RAT 01, interruptor automático',
    stem:'De acuerdo con la ITC-RAT 01, ¿qué característica diferencia un interruptor automático de un interruptor?',
    base:'Además de las funciones propias del interruptor, es capaz de interrumpir corrientes en condiciones anormales especificadas del circuito, tales como las de cortocircuito.',
    variants:[null,[['es capaz de interrumpir','es capaz de soportar, pero no de interrumpir']],[['condiciones anormales','condiciones normales']],[['tales como las de cortocircuito','exceptuadas las de cortocircuito']]],
    why:'Contrasta capacidad de soportar e interrumpir corrientes normales o de cortocircuito.'},
  {id:'AT-M1',topic:'17',level:'muy alta',source:'ITC-RAT 01, corrientes de defecto y puesta a tierra',
    stem:'Según las definiciones de la ITC-RAT 01, señale la distinción íntegramente correcta entre corriente de defecto a tierra y corriente de puesta a tierra, atendiendo a sus recorridos y a la elevación del potencial de tierra.',
    base:'La corriente de defecto a tierra es la que, existiendo un solo punto de defecto, se deriva desde el circuito averiado a tierra o a partes conectadas a tierra. La corriente de puesta a tierra es la corriente total que se deriva a través de la puesta a tierra y es la parte de la corriente de defecto que provoca la elevación de su potencial.',
    variants:[[['y es la parte de la corriente de defecto','y no es la parte de la corriente de defecto']],null,[['un solo punto de defecto','varios puntos de defecto']],[['a través de la puesta a tierra','directamente por el punto de defecto']]],
    why:'Confronta dos conceptos técnicos casi idénticos y la relación normativa entre corriente total y elevación de potencial.'},
  {id:'AT-M2',topic:'17',level:'muy alta',source:'Reglamento AT, arts. 20-21',
    stem:'Atendiendo conjuntamente a los artículos 20 y 21 del Reglamento de AT, determine la alternativa íntegramente correcta respecto de instalaciones privadas no destinadas a cesión, instalaciones promovidas por terceros para cesión y régimen de inspecciones.',
    base:'Las instalaciones privadas no destinadas a cesión siguen el procedimiento de puesta en servicio de la ITC-RAT 22 sin necesidad de autorización administrativa. Las promovidas por terceros para su cesión se someten al régimen de autorizaciones y presentan la documentación de la ITC-RAT 22. Las inspecciones periódicas se realizan cada tres años, salvo condiciones especiales de las ITC, por organismos de control habilitados.',
    variants:[[['sin necesidad de autorización administrativa','con necesidad de autorización administrativa']],[['se someten al régimen de autorizaciones','no se someten al régimen de autorizaciones']],[['cada tres años','cada dos años']],null],
    why:'Tres supuestos reglamentarios independientes, con autorización, documentación y plazos fácilmente confundibles.'},
  {id:'BT-A1',topic:'18',level:'alta',source:'ITC-BT-11, acometida aérea posada sobre fachada',
    stem:'Según la ITC-BT-11, ¿qué combinación de tensión asignada y altura de protección rígida se aplica a la acometida aérea posada sobre fachada?',
    base:'Los cables serán aislados de tensión asignada 0,6/1 kV y los tramos situados a altura inferior a 2,5 m se protegerán con tubos o canales rígidos.',
    variants:[[['inferior a 2,5 m','inferior a 3 m']],[['inferior a 2,5 m','igual o inferior a 2,5 m']],[['0,6/1 kV','0,45/0,75 kV']],null],
    why:'Un límite estricto de altura y una tensión técnica concreta, con alternativas solo mínimamente distintas.'},
  {id:'BT-A2',topic:'18',level:'alta',source:'ITC-BT-12, instalaciones de enlace',
    stem:'De conformidad con la ITC-BT-12, ¿cuál de estas afirmaciones define correctamente los límites y la titularidad de las instalaciones de enlace?',
    base:'Comienzan al finalizar la acometida, incluyen la caja general de protección y terminan en los dispositivos generales de mando y protección. Son propiedad del usuario, responsable de su conservación y mantenimiento.',
    variants:[[['incluyen la caja general de protección','no incluyen la caja general de protección']],null,[['Son propiedad del usuario','Son propiedad de la empresa distribuidora']],[['terminan en los dispositivos generales de mando y protección','terminan en la derivación individual']]],
    why:'Distingue cuatro conceptos limítrofes de las instalaciones de enlace.'},
  {id:'BT-M1',topic:'18',level:'muy alta',source:'ITC-BT-12, esquema para un usuario',
    stem:'En relación con el esquema simplificado para un solo usuario de la ITC-BT-12, determine la alternativa que describe correctamente la disposición de CGP, equipo de medida, LGA y fusibles de seguridad.',
    base:'Cuando la caja general de protección y el equipo de medida coinciden en el mismo lugar, pueden simplificarse las instalaciones de enlace, sin existir línea general de alimentación. En consecuencia, el fusible de seguridad coincide con el fusible de la CGP.',
    variants:[null,[['sin existir línea general de alimentación','existiendo línea general de alimentación']],[['el fusible de seguridad coincide','el fusible de seguridad no coincide']],[['en el mismo lugar','en lugares distintos']]],
    why:'Conexión causal de cuatro piezas del esquema, una sola alteración por alternativa.'},
  {id:'BT-M2',topic:'18',level:'muy alta',source:'ITC-BT-11, instalación de acometidas',
    stem:'Según las prescripciones generales de la ITC-BT-11, determine la alternativa íntegramente correcta respecto de trazado, aislamiento, terrenos de dominio público y acometidas independientes.',
    base:'Las acometidas seguirán con carácter general los trazados más cortos y mantendrán el aislamiento hasta los elementos de conexión de la CGP. Discurrirán por terrenos de dominio público salvo servidumbres de paso autorizadas, y podrán establecerse acometidas independientes para suministros complementarios o por características especiales.',
    variants:[[['podrán establecerse acometidas independientes','no podrán establecerse acometidas independientes']],[['servidumbres de paso autorizadas','servidumbres de paso no autorizadas']],null,[['hasta los elementos de conexión de la CGP','únicamente hasta la entrada del edificio']]],
    why:'Integra cuatro reglas cercanas con una salvedad y una excepción; mantiene estructura en las cuatro respuestas.'},
  {id:'SI4-A1',topic:'19.1',level:'alta',source:'CTE SI 4, extintores portátiles',
    stem:'Según las exigencias generales de dotación de extintores portátiles del CTE SI 4, señale la alternativa correcta.',
    base:'Se dispondrá de extintores de eficacia 21A-113B a una distancia máxima de 15 m de recorrido desde todo origen de evacuación, situándose los de zonas de riesgo especial en el exterior del local y próximos a la puerta de acceso.',
    variants:[[['en el exterior del local','en el interior del local']],null,[['15 m','20 m']],[['21A-113B','21A-89B']]],
    why:'Precisión de eficacia, recorrido medido y ubicación exacta.'},
  {id:'SI4-A2',topic:'19.1',level:'alta',source:'CTE SI 4, administrativo y detección',
    stem:'De acuerdo con el CTE SI 4, ¿qué umbrales y ámbitos de detección son exigibles en edificios de uso Administrativo?',
    base:'Si la superficie construida excede de 2.000 m², se dispondrán detectores en zonas de riesgo alto; si excede de 5.000 m², se dispondrán en todo el edificio.',
    variants:[[['detectores en zonas de riesgo alto; si excede de 5.000 m², se dispondrán en todo el edificio','detectores en todo el edificio; si excede de 5.000 m², se dispondrán en zonas de riesgo alto']],[['excede de 2.000 m²','es igual o superior a 2.000 m²']],[['2.000 m²','2.500 m²']],null],
    why:'Diferencia entre superar el umbral o igualarlo y el alcance del sistema.'},
  {id:'SI4-M1',topic:'19.1',level:'muy alta',source:'CTE SI 4, uso Comercial',
    stem:'Respecto del uso Comercial conforme al CTE SI 4, señale la opción íntegramente correcta para BIE, columna seca, alarma, detección y extinción automática.',
    base:'Se exigen BIE si la superficie construida excede de 500 m², columna seca si la altura de evacuación excede de 24 m, alarma si la superficie excede de 1.000 m² y detección si excede de 2.000 m². La extinción automática se exige si el área pública de ventas excede de 1.500 m² y la carga de fuego ponderada y corregida aportada por los productos comercializados es superior a 500 MJ/m².',
    variants:[[['superior a 500 MJ/m²','igual o superior a 500 MJ/m²']],[['excede de 24 m','excede de 20 m']],null,[['excede de 1.500 m²','es igual o superior a 1.500 m²']]],
    why:'Cinco requisitos simultáneos, con errores aislados de umbral, cuantificador y magnitud.'},
  {id:'SI4-M2',topic:'19.1',level:'muy alta',source:'CTE SI 4, aparcamientos',
    stem:'Según el CTE SI 4, señale la diferencia íntegramente correcta entre aparcamientos convencionales y robotizados para BIE, detección, alarma y extinción automática.',
    base:'En aparcamientos convencionales se exigen BIE y detección cuando la superficie construida excede de 500 m². Los aparcamientos robotizados están excluidos de esa exigencia de BIE, dispondrán de pulsadores de alarma en todo caso y contarán con instalación automática de extinción independientemente de su superficie.',
    variants:[null,[['están excluidos de esa exigencia de BIE','están incluidos en esa exigencia de BIE']],[['pulsadores de alarma en todo caso','pulsadores de alarma cuando excedan de 500 m²']],[['independientemente de su superficie','cuando la superficie exceda de 500 m²']]],
    why:'Diferencia de uso robotizado/convencional, excepción expresa, umbral y obligación incondicionada.'},
  {id:'SI5-A1',topic:'19.2',level:'alta',source:'CTE SI 5, viales de aproximación',
    stem:'De acuerdo con SI 5 del CTE, para edificios de altura de evacuación descendente superior a 9 m, indique la combinación correcta de ancho, gálibo, resistencia del vial y trazado curvo.',
    base:'Anchura mínima libre de 3,5 m, altura libre de 4,5 m y capacidad portante de 20 kN/m²; en tramos curvos, radios mínimos de 5,30 m y 12,50 m y anchura libre de circulación de 7,20 m.',
    variants:[null,[['7,20 m','7,50 m']],[['5,30 m','5,50 m']],[['20 kN/m²','25 kN/m²']]],
    why:'Medidas próximas, iguales unidades y diferencias de pocos centímetros.'},
  {id:'SI5-A2',topic:'19.2',level:'alta',source:'CTE SI 5, accesibilidad por fachada',
    stem:'Según SI 5 del CTE, ¿qué medidas de alféizar, dimensiones de huecos y separación máxima entre ejes permiten la accesibilidad por fachada?',
    base:'Alféizar a altura no mayor de 1,20 m respecto de la planta; huecos de dimensiones horizontal y vertical mínimas de 0,80 m y 1,20 m, respectivamente; separación máxima entre ejes verticales de 25 m.',
    variants:[[['25 m','20 m']],[['0,80 m y 1,20 m','1,20 m y 0,80 m']],null,[['no mayor de 1,20 m','no mayor de 1,50 m']]],
    why:'Exige identificar la orientación de cada dimensión, límite superior y separación de huecos.'},
  {id:'SI5-M1',topic:'19.2',level:'muy alta',source:'CTE SI 5, espacios de maniobra',
    stem:'Conforme a las condiciones de SI 5 sobre entorno de los edificios, seleccione la opción íntegramente correcta para distancia a fachada según altura de evacuación, recorrido hasta accesos y pendiente.',
    base:'Con altura de evacuación de 15 m, la distancia máxima a fachada es 23 m; con altura de evacuación de 20 m, es 18 m; por encima de 20 m, es 10 m. La distancia máxima hasta los accesos necesarios es 30 m y la pendiente máxima del espacio de maniobra es 10 %.',
    variants:[[['es 23 m','es 18 m']],[['es 18 m','es 10 m']],[['es 30 m','es 25 m']],null],
    why:'Dos límites inclusivos, tres rangos de altura y dos características del espacio de maniobra.'},
  {id:'SI5-M2',topic:'19.2',level:'muy alta',source:'CTE SI 5, zonas de interfaz forestal',
    stem:'Según SI 5 del CTE en zonas edificadas limítrofes o interiores a áreas forestales, identifique la solución íntegramente correcta para franja, camino perimetral y acceso alternativo o único.',
    base:'Se dispondrá una franja de separación de 25 m libre de vegetación propagadora del incendio y un camino perimetral de 5 m, que podrá incluirse en la franja. La zona dispondrá preferentemente de dos accesos alternativos y, si no es posible, el acceso único finalizará en fondo de saco circular de 12,50 m de radio.',
    variants:[[['podrá incluirse en la franja','no podrá incluirse en la franja']],null,[['preferentemente de dos accesos','obligatoriamente de dos accesos']],[['12,50 m de radio','12,50 m de diámetro']]],
    why:'Contrasta 25 m frente a 5 m, inclusión del camino, preferencia/no obligación y radio/diámetro.'}
]);

function buildLegislacionReference94(reference){
  if(!reference || !Array.isArray(reference.variants) || reference.variants.length!==4){
    throw new Error('Referencia Legislación 94 sin cuatro alternativas.');
  }
  const correctIndexes=reference.variants.map((changes,i)=>changes===null?i:-1).filter(i=>i>=0);
  if(correctIndexes.length!==1)throw new Error('Referencia Legislación 94 sin respuesta única.');
  const options=reference.variants.map(changes=>{
    let answer=reference.base;
    for(const [from,to] of changes||[]){
      if(!answer.includes(from))throw new Error('Variante Legislativa 94 incorrecta '+reference.id+': '+from);
      answer=answer.replace(from,to);
    }
    return answer;
  });
  if(new Set(options).size!==4)throw new Error('Referencia Legislativa 94 contiene duplicados: '+reference.id);
  return {id:reference.id,level:reference.level,source:reference.source,
    stem:reference.stem,options,correctIndex:correctIndexes[0],why:reference.why};
}
// SERVER 100 — Contrato resistente de respuesta para Gemini 3.8, SOLO
// Legislacion Muy alta. Un error transitorio o JSON malformado no invalida
// inmediatamente un lote entero; 402/400 y fallos no transitorios NO se
// reintentan. No se aprueba ninguna pregunta en este nivel de transporte.


// SERVER 108: los exámenes de 10 o más preguntas Muy altas ya no
// dependen de UNA sola generación larga con File Search. Se envían lotes
// secuenciales de como máximo cinco objetivos. El contrato curricular,
// PDF factual, auditoría, familia, orden y validación final se conservan.
// ATENCIÓN: segmentar no elimina una cuota 429 agotada de Google; la
// detectaríamos en el primer lote y no enviaríamos los siguientes.





function legislationCalibrationTopic94(target){
  const str=String(target?.topic_name||'').toLowerCase();
  if(str.includes('si 4')||/19\.1\b/.test(str))return '19.1';
  if(str.includes('si 5')||/19\.2\b/.test(str))return '19.2';
  const n=Number((str.match(/(?:tema\s*)?(\d+)/)||[])[1]);
  return Number.isFinite(n)?String(n):'';
}

function pickLegislationExamples94(targets,level,count){
  const requestedTopic=legislationCalibrationTopic94(targets?.[0]);
  // If we are testing labelled examples, NEVER show any of those same
  // examples inside the calibration prompt: that would leak the answer.
  const holdoutIds=new Set((targets||[]).map(t=>t?.benchmarkReferenceId99).filter(Boolean));
  const pool=LEGISLACION_REFERENCIAS_94.filter(q=>q.level===level && !holdoutIds.has(q.id));
  // Diversidad: no usar siempre Constitución ni sesgar a la materia examinada.
  const rotate=(requestedTopic.split('').reduce((n,s)=>n+s.charCodeAt(0),0)+
    (Array.isArray(targets)?targets.length:0))%pool.length;
  const rotated=[...pool.slice(rotate),...pool.slice(0,rotate)];
  const chosen=[];
  // Primero una referencia afín si existe; las demás, de otra materia:
  // evitar que Gemini repita por mimetismo el contenido factual del ejemplo.
  const related=rotated.find(q=>q.topic===requestedTopic);
  if(related && count>0)chosen.push(related);
  for(const q of rotated){
    if(!chosen.some(x=>x.topic===q.topic))chosen.push(q);
    if(chosen.length===count)break;
  }
  return chosen.map(buildLegislacionReference94);
}


/* SERVER 102 — candidatos exclusivamente de prioridades 4/5 de los
 * TEMAS ya seleccionados; no consumir la ventana de 450 filas en SRS/fallos.
 * La prioridad se CALCULA con la misma regla que el selector adaptativo.
 * Ningún candidato se marca como trabajado por esta consulta.
 */


/* SERVER 101: evitar reparaciones estériles y sustituir SOLO objetivos de
 * contenido nuevo/mantenimiento NO Anki si existe una alternativa mejor del
 * MISMO tema, prioridad, clase nuevo/repaso y familia. La sustitución no se
 * compromete hasta que la nueva pregunta supera ambas validaciones.
 * No se modifica la DB ni el seguimiento del objetivo anterior.
 */






// El control de calidad no puede descartar preguntas FACTUALMENTE validas:
// un fallo de Gemini en esta auditoria deja el examen disponible, con
// clasificacion conservadora "alta" y registro explicito del problema.
// SERVER 93J — mejora iterativa y AUDITABLE de dificultad Muy alta.
// Solo modifica preguntas NUEVAS de Legislación. No modifica Anki original,
// metas curriculares, sesiones, SRS, estadisticas ni el resto de bloques.





// SEGUNDO CONTRASTE ESPECIALIZADO: en preguntas de tipo INCORRECTA/FALSA,
// las cuatro opciones son afirmaciones independientes. El validador general
// podía aprobar dos falsedades con correctIndex apuntando solo a una.
// Este contraste NO recibe correctIndex, explicación ni sourceEvidence del
// generador: evita que la segunda revisión copie su respuesta esperada.





// SERVER 111: un solo reintento compacto por los objetivos rechazados.
// Nunca se usan las reparaciones individuales ni cambio especulativo de tema.

// SERVER 125: se ha eliminado una funcion historica sin referencias ejecutables.



app.get("/api/statistics", async(req,res)=>{
  try{
    const result = await db.query(`
      SELECT
  t.id AS topic_id,
  t.name AS topic_name,
  t.block AS block,
  COALESCE((regexp_match(t.name,'^\\s*TEMA\\s*([0-9]{1,3})','i'))[1]::integer, t.topic_order) AS topic_order,

  COUNT(ci.id)::int AS total_items,

        COUNT(ci.id) FILTER (
          WHERE ci.worked = TRUE
        )::int AS worked_items,

        COALESCE(SUM(ci.times_asked),0)::int AS times_asked,
        COALESCE(SUM(ci.times_correct),0)::int AS times_correct,
        COALESCE(SUM(ci.times_wrong),0)::int AS times_wrong,
        COALESCE(SUM(ci.times_blank),0)::int AS times_blank

      FROM topics t

      LEFT JOIN coverage_items ci
        ON ci.topic_id = t.id
       AND ci.exam_relevant = TRUE
       AND ${GEOGRAPHY_EXAMINABLE_SQL_125}

      GROUP BY
  t.id,
  t.name,
  t.block,
  t.topic_order

ORDER BY
  CASE t.block
    WHEN 'legislacion' THEN 1
    WHEN 'geografia' THEN 2
    WHEN 'especifico' THEN 3
    ELSE 4
  END,
  COALESCE((regexp_match(t.name,'^\\s*TEMA\\s*([0-9]{1,3})','i'))[1]::integer, t.topic_order) NULLS LAST,
  t.id
    `);

    const ankiPerformance=await db.query(`
      SELECT topic_id,COALESCE(SUM(times_asked),0)::int AS times_asked,
        COALESCE(SUM(times_correct),0)::int AS times_correct,
        COALESCE(SUM(times_wrong),0)::int AS times_wrong,
        COALESCE(SUM(times_blank),0)::int AS times_blank
      FROM coverage_items WHERE exam_relevant=FALSE AND item_type='anki_independent'
      GROUP BY topic_id`);
    const independentByTopic=new Map(ankiPerformance.rows.map(r=>[Number(r.topic_id),r]));
    for(const row of result.rows){
      const own=independentByTopic.get(Number(row.topic_id));
      if(!own)continue;
      for(const k of ['times_asked','times_correct','times_wrong','times_blank']){
        row[k]=Number(row[k]||0)+Number(own[k]||0);
      }
    }
    const topics = result.rows.map(row=>{
      const totalItems = Number(row.total_items) || 0;
      const workedItems = Number(row.worked_items) || 0;

      const timesAsked = Number(row.times_asked) || 0;
      const timesCorrect = Number(row.times_correct) || 0;
      const timesWrong = Number(row.times_wrong) || 0;
      const timesBlank = Number(row.times_blank) || 0;

      const answered =
        timesCorrect + timesWrong + timesBlank;

      const coveragePercentage =
        totalItems > 0
          ? Number(
              (
                workedItems /
                totalItems *
                100
              ).toFixed(1)
            )
          : 0;

      const performancePercentage =
        answered > 0
          ? Number(
              (
                timesCorrect /
                answered *
                100
              ).toFixed(1)
            )
          : null;

      return {
        topicId:Number(row.topic_id),
        topic:row.topic_name,
block:row.block || null,
topicOrder:
  row.topic_order != null
    ? Number(row.topic_order)
    : null,
        coverage:{
          totalItems,
          workedItems,
          pendingItems:
            Math.max(0,totalItems-workedItems),
          percentage:coveragePercentage
        },

        performance:{
          timesAsked,
          answered,
          correct:timesCorrect,
          wrong:timesWrong,
          blank:timesBlank,
          percentage:performancePercentage
        }
      };
    });

    const totals = topics.reduce(
      (acc,topic)=>{
        acc.totalItems +=
          topic.coverage.totalItems;

        acc.workedItems +=
          topic.coverage.workedItems;

        acc.timesAsked +=
          topic.performance.timesAsked;

        acc.correct +=
          topic.performance.correct;

        acc.wrong +=
          topic.performance.wrong;

        acc.blank +=
          topic.performance.blank;

        return acc;
      },
      {
        totalItems:0,
        workedItems:0,
        timesAsked:0,
        correct:0,
        wrong:0,
        blank:0
      }
    );

    const totalAnswered =
      totals.correct +
      totals.wrong +
      totals.blank;

    res.json({
      ok:true,

      global:{
        coverage:{
          totalItems:totals.totalItems,
          workedItems:totals.workedItems,
          pendingItems:
            Math.max(
              0,
              totals.totalItems -
              totals.workedItems
            ),
          percentage:
            totals.totalItems > 0
              ? Number(
                  (
                    totals.workedItems /
                    totals.totalItems *
                    100
                  ).toFixed(1)
                )
              : 0
        },

        performance:{
          timesAsked:totals.timesAsked,
          answered:totalAnswered,
          correct:totals.correct,
          wrong:totals.wrong,
          blank:totals.blank,
          percentage:
            totalAnswered > 0
              ? Number(
                  (
                    totals.correct /
                    totalAnswered *
                    100
                  ).toFixed(1)
                )
              : null
        }
      },

      topics
    });

  }catch(e){
    console.error("ERROR STATISTICS:",e);

    res.status(500).json({
      ok:false,
      error:e?.message || String(e)
    });
  }
});


app.get("/api/statistics/sections", async(req,res)=>{
  try{
    const result=await db.query(`
      SELECT
        t.id AS topic_id,
        t.name AS topic_name,

        COALESCE(
          NULLIF(TRIM(ci.section),''),
          'Sin sección'
        ) AS section,

        COUNT(ci.id)::int AS total_items,
        MIN(ci.source_page) AS first_source_page,

        COUNT(ci.id) FILTER (
          WHERE ci.worked = TRUE
        )::int AS worked_items,

        COALESCE(SUM(ci.times_asked),0)::int
          AS times_asked,

        COALESCE(SUM(ci.times_correct),0)::int
          AS times_correct,

        COALESCE(SUM(ci.times_wrong),0)::int
  AS times_wrong,

COALESCE(SUM(ci.times_blank),0)::int
  AS times_blank

      FROM topics t

      JOIN coverage_items ci
        ON ci.topic_id = t.id
       AND ci.exam_relevant = TRUE
       AND ${GEOGRAPHY_EXAMINABLE_SQL_125}

      GROUP BY
        t.id,
        t.name,
        COALESCE(
          NULLIF(TRIM(ci.section),''),
          'Sin sección'
        )

      ORDER BY
        t.id,
        first_source_page ASC NULLS LAST,
        section
    `);

    const sections=result.rows.map(row=>{
      const totalItems=
        Number(row.total_items)||0;

      const workedItems=
        Number(row.worked_items)||0;

      const correct=
        Number(row.times_correct)||0;

      const wrong=
  Number(row.times_wrong)||0;

const blank=
  Number(row.times_blank)||0;

const answered=
  correct+wrong+blank;

      return {
        topicId:Number(row.topic_id),
        topic:row.topic_name,
        section:row.section,

        coverage:{
          totalItems,
          workedItems,

          pendingItems:
            Math.max(
              0,
              totalItems-workedItems
            ),

          percentage:
            totalItems>0
              ? Number(
                  (
                    workedItems /
                    totalItems *
                    100
                  ).toFixed(1)
                )
              : 0
        },

        performance:{
          timesAsked:
            Number(row.times_asked)||0,

          answered,
          correct,
          wrong,
          blank,

          percentage:
            answered>0
              ? Number(
                  (
                    correct /
                    answered *
                    100
                  ).toFixed(1)
                )
              : null
        }
      };
    });

    const ankiSections=await db.query(`
      SELECT ci.topic_id,t.name AS topic_name,
        COALESCE(SUM(ci.times_asked),0)::int AS times_asked,
        COALESCE(SUM(ci.times_correct),0)::int AS times_correct,
        COALESCE(SUM(ci.times_wrong),0)::int AS times_wrong,
        COALESCE(SUM(ci.times_blank),0)::int AS times_blank
      FROM coverage_items ci JOIN topics t ON t.id=ci.topic_id
      WHERE ci.exam_relevant=FALSE AND ci.item_type='anki_independent'
      GROUP BY ci.topic_id,t.name HAVING SUM(ci.times_asked)>0`);
    for(const row of ankiSections.rows){
      const correct=Number(row.times_correct)||0,wrong=Number(row.times_wrong)||0;
      const blank=Number(row.times_blank)||0,answered=correct+wrong+blank;
      sections.push({topicId:Number(row.topic_id),topic:row.topic_name,
        section:'Anki original (repaso)',
        coverage:{totalItems:0,workedItems:0,pendingItems:0,percentage:0},
        performance:{timesAsked:Number(row.times_asked)||0,answered,correct,wrong,blank,
          percentage:answered?Number((correct/answered*100).toFixed(1)):null}});
    }
    res.json({
      ok:true,
      sections
    });

  }catch(e){
    console.error(
      "ERROR STATISTICS SECTIONS:",
      e
    );

    res.status(500).json({
      ok:false,
      error:e?.message || String(e)
    });
  }
});
app.get("/api/statistics/knowledge", async(req,res)=>{
  try{
    const result = await db.query(`
      SELECT
        ci.id AS coverage_item_id,
        t.id AS topic_id,
        t.name AS topic_name,
        ci.section,
        ci.concept,
        ci.times_asked,
        ci.times_correct,
        ci.times_wrong,
        ci.times_blank,
        ci.last_asked_at,
        crs.review_stage,
        crs.next_review_at
      FROM coverage_items ci

      JOIN topics t
        ON t.id = ci.topic_id

      LEFT JOIN coverage_review_state crs
        ON crs.coverage_item_id = ci.id

      WHERE (ci.exam_relevant = TRUE OR ci.item_type='anki_independent')
        AND ${GEOGRAPHY_EXAMINABLE_SQL_125}

      ORDER BY
        t.id,
        ci.section,
        ci.id
    `);

    const knowledge = result.rows.map(row=>{
      const correct =
        Number(row.times_correct) || 0;

      const wrong =
  Number(row.times_wrong) || 0;

const blank =
  Number(row.times_blank) || 0;

const answered =
  correct + wrong + blank;

      return {
        coverageItemId:
          Number(row.coverage_item_id),

        topicId:
          Number(row.topic_id),

        topic:
          row.topic_name,

        section:
          row.section,

        concept:
          row.concept,

        performance:{
          answered,
          correct,
          wrong,
          blank,

          percentage:
            answered > 0
              ? Number(
                  (
                    correct /
                    answered *
                    100
                  ).toFixed(1)
                )
              : null
        },

        srs:{
          reviewStage:
            row.review_stage != null
              ? Number(row.review_stage)
              : null,

          nextReviewAt:
            row.next_review_at,

          lastAskedAt:
            row.last_asked_at
        }
      };
    });

    res.json({
      ok:true,
      count:knowledge.length,
      knowledge
    });

  }catch(e){
    console.error(
      "ERROR STATISTICS KNOWLEDGE:",
      e
    );

    res.status(500).json({
      ok:false,
      error:e?.message || String(e)
    });
  }
});
app.post("/api/answer", async(req,res)=>{
  try{
    const sessionId = Number(req.body.sessionId);
    const questionId = Number(req.body.questionId);
    const selectedIndex = Number(req.body.selectedIndex);

    if(
      !Number.isInteger(sessionId) ||
      sessionId < 1 ||
      !Number.isInteger(questionId) ||
      questionId < 1 ||
      !Number.isInteger(selectedIndex) ||
      selectedIndex < 0 ||
      selectedIndex > 3
    ){
      return res.status(400).json({
        ok:false,
        error:"Datos de respuesta inválidos."
      });
    }

    const result = await registerQuestionAnswer({
      sessionId,
      questionId,
      selectedIndex
    });

    res.json({
      ok:true,
      ...result
    });

  }catch(e){
    console.error("ERROR REGISTER ANSWER:",e);

    const message = e?.message || String(e);

    const status =
      message.includes("no pertenece") ||
      message.includes("ya había sido contestada")
        ? 409
        : 500;

    res.status(status).json({
      ok:false,
      error:message
    });
  }
});
app.post("/api/finish-test", async(req,res)=>{
  const client = await db.connect();

  try{
    const sessionId = Number(req.body.sessionId);

    if(
      !Number.isInteger(sessionId) ||
      sessionId < 1
    ){
      return res.status(400).json({
        ok:false,
        error:"Sesión inválida."
      });
    }

    await client.query("BEGIN");

    /*
      Toda pregunta todavía sin answered_at al entregar
      el examen se convierte en BLANCO real.
    */
    const blankResult = await client.query(
      `UPDATE test_session_questions
       SET
         is_blank = TRUE,
         answered_at = NOW()
       WHERE session_id = $1
         AND answered_at IS NULL
       RETURNING
         question_id,
         coverage_item_id`,
      [sessionId]
    );

    /*
      Los blancos cuentan como aparición de la pregunta,
      pero NO como acierto ni como error.
    */
    for(const row of blankResult.rows){
      await client.query(
        `UPDATE question_bank
         SET
           times_shown = times_shown + 1,
           times_blank = times_blank + 1,
           last_shown_at = NOW(),
           updated_at = NOW()
         WHERE id = $1`,
        [Number(row.question_id)]
      );

      await client.query(
        `UPDATE coverage_items
         SET
           worked = TRUE,
           times_asked = times_asked + 1,
           times_blank = times_blank + 1,
           last_asked_at = NOW()
         WHERE id = $1`,
        [Number(row.coverage_item_id)]
      );

      await client.query(
        `INSERT INTO coverage_review_state (
           coverage_item_id,
           review_stage,
           next_review_at,
           last_review_at,
           consecutive_correct,
           consecutive_wrong,
           total_reviews,
           total_correct,
           total_wrong,
           total_blank,
           updated_at
         )
         VALUES (
           $1,
           1,
           $2,
           NOW(),
           0,
           0,
           1,
           0,
           0,
           1,
           NOW()
         )
         ON CONFLICT (coverage_item_id)
         DO UPDATE SET
           review_stage = 1,
           next_review_at = EXCLUDED.next_review_at,
           last_review_at = NOW(),
           consecutive_correct = 0,
           consecutive_wrong = 0,
           total_reviews =
             coverage_review_state.total_reviews + 1,
           total_blank =
             coverage_review_state.total_blank + 1,
           updated_at = NOW()`,
        [
          Number(row.coverage_item_id),
          getNextReviewDate(1, new Date())
        ]
      );
    }

    const statsResult = await client.query(
      `SELECT
         COUNT(*) FILTER (
           WHERE is_correct = TRUE
         )::int AS correct,

         COUNT(*) FILTER (
           WHERE is_correct = FALSE
             AND is_blank = FALSE
         )::int AS wrong,

         COUNT(*) FILTER (
           WHERE is_blank = TRUE
         )::int AS blank

       FROM test_session_questions
       WHERE session_id = $1`,
      [sessionId]
    );

    const stats = statsResult.rows[0];

    const result = await client.query(
      `UPDATE test_sessions
       SET
         completed = TRUE,
         completed_at = NOW(),
         correct_answers = $1,
         wrong_answers = $2,
         blank_answers = $3
       WHERE id = $4
       RETURNING id`,
      [
        Number(stats.correct),
        Number(stats.wrong),
        Number(stats.blank),
        sessionId
      ]
    );

    if(!result.rows.length){
      throw new Error("Sesión no encontrada.");
    }

    await client.query("COMMIT");

    res.json({
      ok:true,
      sessionId,
      correct:Number(stats.correct),
      wrong:Number(stats.wrong),
      blank:Number(stats.blank)
    });

  }catch(e){
    await client.query("ROLLBACK");

    console.error("ERROR FINISH TEST:",e);

    res.status(500).json({
      ok:false,
      error:e?.message || String(e)
    });

  }finally{
    client.release();
  }
});
// SERVER_84: cuota Anki por fuente real, independiente de la seleccion inicial
// de coverage_items. Solo preguntas originales validadas frente al PDF;
// la ausencia de un enlace a un coverage_item concreto NO invalida la tarjeta.
// Las fichas de repaso independientes no computan cobertura del temario.
// SERVER_86: Anki original y cobertura curricular son dimensiones independientes.
// La plaza Anki no necesita inventar un enlace a otro coverage_item.
// Las fichas técnicas quedan exam_relevant=FALSE y por tanto no contaminan el
// porcentaje de temario cubierto. El mismo motor de historial y SRS las procesa.
async function applyLegislationAnkiQuota84(originalTargets,allowedTopicIds,requestedDifficulty="alta"){
  // Revisión: tarjetas Anki ORIGINALES de 3 y de 4 opciones, sin modificar.
  // SERVER 93G: este selector se llama SOLO en Alta; conserva
  // el 80 % de tarjetas originales validadas y el 20 % nuevas.
  const originalShare = 0.80; // Exclusivo de Alta; Muy alta genera desde PDF.
  const topicGroups=new Map();
  originalTargets.forEach((item,index)=>{
    if(String(item?.topic_block||'').trim().toLowerCase()!=='legislacion')return;
    const order=ankiLegislationSourceOrderForTopicName(item.topic_name);
    if(!Number.isInteger(order))return;
    const key=Number(item.topic_id);
    if(!topicGroups.has(key))topicGroups.set(key,{order,indices:[]});
    topicGroups.get(key).indices.push(index);
  });
  if(!topicGroups.size)return null;
  const orders=[...new Set([...topicGroups.values()].map(g=>g.order))];
  const inventory=await db.query(`
    SELECT topic_order,COUNT(*)::int AS total
    FROM legislation_anki_questions
    WHERE topic_order=ANY($1::int[]) AND option_count IN (3,4)
    GROUP BY topic_order`,[orders]);
  const availableOrders=new Set(inventory.rows.filter(r=>Number(r.total)>0)
    .map(r=>Number(r.topic_order)));
  const groups=[...topicGroups].filter(([,g])=>availableOrders.has(g.order));
  if(!groups.length)return null; // Tema técnico sin baraja: generación PDF.
  const totalSlots=groups.reduce((sum,[,g])=>sum+g.indices.length,0);
  const required=Math.ceil(totalSlots*originalShare);
  const quotas=new Map(groups.map(([id,g])=>[id,Math.floor(g.indices.length*originalShare)]));
  const rest=groups.map(([id,g])=>({id,fract:g.indices.length*originalShare-Math.floor(g.indices.length*originalShare)}))
    .sort((a,b)=>b.fract-a.fract||a.id-b.id);
  for(let i=0;i<required-[...quotas.values()].reduce((a,b)=>a+b,0);i++){
    quotas.set(rest[i].id,(quotas.get(rest[i].id)||0)+1);
  }
  const slots=[];
  for(const [id,g] of groups)slots.push(...g.indices.slice(0,quotas.get(id)));
  slots.sort((a,b)=>a-b);

  const selectedRows=new Map();
  const stems=new Set(), notes=new Set();
  // Traer variedad de la baraja completa, no solo los pocos enlaces verificados.
  // Ordenar por usos anteriores favorece contenido nuevo antes de repetir.
  for(const [topicId,g] of groups){
    const needs=quotas.get(topicId)||0;
    if(!needs)continue;
    const query=await db.query(`
      SELECT a.id,a.anki_note_id,a.topic_order,a.stem,a.options,
             a.correct_index,a.correct_answer,a.validation_status,
             a.validation_evidence,a.validated_coverage_item_id,
             a.times_used,a.last_used_at,
             ci.id AS linked_id,ci.topic_id AS linked_topic_id,
             ci.section AS linked_section,ci.concept AS linked_concept,
             ci.source_evidence AS linked_evidence,ci.exam_relevant AS linked_exam_relevant
      FROM legislation_anki_questions a
      LEFT JOIN coverage_items ci ON ci.id=a.validated_coverage_item_id
      LEFT JOIN coverage_items shadow ON shadow.topic_id=$2
        AND shadow.item_type='anki_independent'
        AND shadow.concept=('ANKI_ORIGINAL_NOTA_'||a.anki_note_id::text)
      LEFT JOIN coverage_review_state sr ON sr.coverage_item_id=shadow.id
      LEFT JOIN coverage_review_state vr ON vr.coverage_item_id=ci.id
      WHERE a.topic_order=$1 AND a.option_count IN (3,4) AND a.direct_use_eligible=TRUE
        AND a.validation_status='validated'
      ORDER BY CASE WHEN COALESCE(sr.next_review_at,vr.next_review_at)<=NOW()
        THEN 0 ELSE 1 END ASC,a.times_used ASC,a.last_used_at ASC NULLS FIRST,a.id ASC
      LIMIT 700`,[g.order,topicId]);
    const chosen=[];
    for(const a of query.rows){
      const options=Array.isArray(a.options)?a.options:[];
      const correct=Number(a.correct_index);
      const textKey=normalizeLegislationMatchText(a.stem);
      if(!textKey||![3,4].includes(options.length)||!Number.isInteger(correct)||correct<0||correct>=options.length||
         options.some(o=>typeof o!=='string'||!o.trim())||
         // Mantener originales; no aceptar alternativas idénticas en un test.
         new Set(options.map(normalizeLegislationMatchText)).size!==options.length||
         notes.has(String(a.anki_note_id))||stems.has(textKey)||
         legislationKnownAmbiguityIssue({stem:a.stem,options}))continue;
      chosen.push(a);notes.add(String(a.anki_note_id));stems.add(textKey);
      if(chosen.length===needs)break;
    }
    if(chosen.length!==needs){
      // El 80/20 es OBLIGATORIO: no convertir tarjetas Anki pendientes de
      // verificación PDF en preguntas PDF nuevas sin informar al usuario.
      // Interrumpir ANTES de llamar a Gemini y de escribir una sesión.
      throw new Error(`ANKI 80/20 no disponible en el tema ${g.order}: `+
        `${chosen.length}/${needs} tarjetas originales aptas y verificadas. `+
        `Completa primero la validación Anki contra los PDF del temario.`);
    }
    selectedRows.set(topicId,chosen);
  }

  const targets=[...originalTargets],direct=new Map();
  const reserved=new Set();
  for(const [topicId,g] of groups){
    const chosen=selectedRows.get(topicId)||[];
    const topicSlots=g.indices.slice(0,chosen.length);
    for(let i=0;i<topicSlots.length;i++){
      const a=chosen[i],slot=topicSlots[i];
      // El enlace curricular previo solo es válido si fue realmente aprobado.
      const linkTarget={
        id:a.linked_id,topic_id:a.linked_topic_id,
        topic_name:originalTargets[slot].topic_name,topic_block:'legislacion',
        concept:a.linked_concept,section:a.linked_section,
        source_evidence:a.linked_evidence
      };
      const linked=a.validation_status==='validated'&&a.linked_exam_relevant===true&&
        Number(a.linked_topic_id)===topicId&&Number(a.linked_id)>0&&
        !reserved.has(Number(a.linked_id))&&legislationExactCoverageLink(linkTarget,a)&&
        !legislationConflictingArticles(linkTarget,a);
      let target;
      if(linked){
        const real=await db.query(`
          SELECT ci.*,t.name AS topic_name,t.block AS topic_block
          FROM coverage_items ci JOIN topics t ON t.id=ci.topic_id
          WHERE ci.id=$1`,[Number(a.linked_id)]);
        if(real.rows.length)target=real.rows[0];
      }
      if(!target){
        // Ficha técnica de repaso. No es una afirmación de cobertura curricular.
        const concept=`ANKI_ORIGINAL_NOTA_${String(a.anki_note_id)}`;
        const record=await db.query(`
          INSERT INTO coverage_items(topic_id,section,concept,item_type,evaluation_type,
            source_page,source_evidence,exam_relevant)
          VALUES ($1,'Anki original (repaso)',$2,'anki_independent','ANKI',NULL,NULL,FALSE)
          ON CONFLICT(topic_id,concept,item_type,evaluation_type)
          DO UPDATE SET exam_relevant=FALSE
          RETURNING *`,[topicId,concept]);
        target={...record.rows[0],topic_name:originalTargets[slot].topic_name,
          topic_block:'legislacion',ankiIndependent:true};
      }
      target.questionFamily=inferLegislationAnkiFamily(a.stem);
      targets[slot]=target;reserved.add(Number(target.id));
      const q=buildDirectAnkiQuestion({
        ...a,anki_note_id:Number(a.anki_note_id),validation_evidence:
          linked?a.validation_evidence:null
      },target);
      q.ankiIndependent=Boolean(target.ankiIndependent);
      q.ankiOriginalStatus=a.validation_status;
      if(q.ankiIndependent){
        // Validación factual Anki realizada contra File Search del temario.
        // No adjudicar una página ni una cobertura curricular que no constan.
        q.explanation=String(a.validation_evidence || 'Tarjeta original validada con el temario PDF.');
        q.sourceEvidence=String(a.validation_evidence || 'Pregunta Anki validada frente al temario PDF.');
        q.sourcePage=null;q.manualPage=null;
      }
      direct.set(slot,q);
    }
  }
  // Mantener solo las preguntas nuevas elegidas para su tema, sin ninguna
  // colisión con tarjetas ya utilizadas en esta sesión.
  for(let index=0;index<targets.length;index++){
    if(direct.has(index))continue;
    if(reserved.has(Number(targets[index].id))){
      // Evitar colisión únicamente entre slots, sin reinterpretar sus contenidos.
      const candidate=await getAdaptiveCoverageCandidates(150,allowedTopicIds,'adaptive');
      const next=candidate.find(c=>Number(c.topic_id)===Number(targets[index].topic_id)&&
        c.item_type!=='anki_independent'&&!reserved.has(Number(c.id)));
      if(!next)throw new Error('ANKI: no quedan objetivos curriculares distintos para las preguntas nuevas.');
      targets[index]=next;
    }
    reserved.add(Number(targets[index].id));
  }
  console.log('LEGISLACION CUOTA ANKI 93E:',JSON.stringify({difficulty:requestedDifficulty,originalShare,required,
    anki:direct.size,nuevas:targets.length-direct.size,
    originalesSinEnlace:[...direct.values()].filter(q=>q.ankiIndependent).length,
    ids:[...direct.values()].map(q=>q.ankiQuestionId)}));
  // La cuota es obligatoria donde existe baraja; si no se alcanza, no se
  // lanza la generación. Las preguntas nuevas de PDF conservan su 20 %.
  if(direct.size!==required){
    throw new Error(`ANKI 80/20 no cumplido: ${direct.size}/${required} `+
      'tarjetas originales aptas. No se generará una mezcla distinta.');
  }
  return {targets,direct,required,actual:direct.size};
}

/* SERVER 93G — Muy alta: 50 % de variantes NUEVAS de tarjetas Anki
 * validadas y enlazadas al PDF + 50 % preguntas NUEVAS directamente del PDF.
 * La tarjeta original NO se presenta, NO se reescribe, NO se cuenta como usada
 * y NO crea coverage_items técnicos de Anki. Si no existe vínculo seguro,
 * la plaza vuelve al PDF y se informa del déficit; NUNCA se inventa enlace.
 * Alta utiliza, sin cambios, applyLegislationAnkiQuota84 (80 % originales).
 */

// SERVER 125: se ha eliminado una funcion historica sin referencias ejecutables.


/* Si no hay cinco enlaces persistidos, reutilizar EL COMPROBADOR SEMÁNTICO
 * PREEXISTENTE (una tanda): selección de FDF ya validada y equivalencia
 * estricta con una cita textual del coverage_item del PDF. El resultado
 * se usa exclusivamente como SEMILLA y nunca como pregunta Anki directa.
 * Un fallo del comprobador deja preguntas PDF; no se fuerza ninguna relación.
 */


/* SERVER 93I — RESCATE CURRICULAR DE SEMILLAS EN MUY ALTA.
 * Anki es un estímulo de redacción, NO evidencia normativa. La comprobación
 * de la nueva pregunta con File Search sigue siendo obligatoria y separada.
 * Se permiten tarjetas no rechazadas sin vínculo anterior, pero solo después
 * de contrastar el dato concreto con evidencia ya extraída del PDF.
 * Las alternativas curriculares conservan tema, prioridad SRS y familia;
 * nunca se crean coverage_items ni se incrementa uso de la tarjeta original.
 */


/* SERVER 93E — semillas verificables para preguntas nuevas MUY ALTAS.
 * Anki NO es fuente normativa. Solo se usa como pregunta de partida cuando
 * la nota validada corresponde inequívocamente al mismo coverage_item.
 * Sin enlace exacto, el generador continúa normalmente con el PDF y el
 * corpus de estilo ya disponible. No modifica la DB ni contadores Anki.
 */




/* SERVER 92 — Rotación semántica para tests de legislación SIN baraja.
 * Trabaja únicamente sobre objetivos ANTES de generar preguntas.
 * No transforma cobertura, no altera SRS, ni toca las cuotas Anki.
 * Solo reemplaza redundancias evitables por objetivos del MISMO tema y
 * MISMA prioridad adaptativa / situación nuevo-vs-repaso.
 */






// SERVER 93C: selección factual de objetivos alternativos de legislación.
// Solo desplaza contenido nuevo/mantenimiento dentro del mismo tema y nivel
// de prioridad; SRS vencido, debilidades/falladas (1-3) quedan intocables.


/* SERVIDOR 93: recuperación de tests tras interrupciones HTTP.
 * Registro idempotente por petición del navegador, en PostgreSQL.
 * No cambia la generación, la validación ni los ciclos de repaso.
 */
function normalizeGenerationRunId(value){
  const id=String(value||'').trim();
  return /^[a-zA-Z0-9_-]{16,100}$/.test(id)?id:null;
}
function generationRunSignature(body={}){
  // Hash del ámbito solicitado: un runId NO puede recuperarse con otro
  // cuestionario o diferente modo de examen por accidente.
  const normalized={
    count:Number(body.count)||10,
    difficulty:String(body.difficulty||'alta'),
    mode:String(body.mode||'mixto'),
    testType:String(body.testType||'normal'),
    examMode:String(body.examMode||'training'),
    selectedBlocks:Array.isArray(body.selectedBlocks)
      ? [...new Set(body.selectedBlocks.map(String))].sort():[],
    selectedTopicIds:Array.isArray(body.selectedTopicIds)
      ? [...new Set(body.selectedTopicIds.map(String))].sort():[]
  };
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}
async function readGenerationRun(runId){
  const result=await db.query('SELECT value FROM app_state WHERE key=$1',
    [`generation_run:${runId}`]);
  if(!result.rows.length)return null;
  try{return JSON.parse(result.rows[0].value);}
  catch{throw new Error('El registro de recuperación existe pero está dañado.');}
}
async function startGenerationRun(runId,signature){
  const inserted=await db.query(`INSERT INTO app_state(key,value)
      VALUES($1,$2) ON CONFLICT (key) DO NOTHING RETURNING key`,[
    `generation_run:${runId}`,
    JSON.stringify({status:'processing',signature,startedAt:new Date().toISOString()})
  ]);
  if(inserted.rows.length)return null;
  const prior=await readGenerationRun(runId);
  if(!prior)throw new Error('No se pudo consultar la generación ya registrada.');
  return prior;
}
// SERVER 140: una sola solicitud puede reclamar una ejecución fallida.
// UPDATE condicional atómico de PostgreSQL: conserva el borrador ya verificado
// hasta que la transacción final confirme la sesión o termine un nuevo error.
async function claimFailedGenerationRun140(runId,signature){
  const now=new Date().toISOString();
  const result=await db.query(`UPDATE app_state
    SET value=jsonb_set(
      jsonb_set(value::jsonb, '{status}', to_jsonb('processing'::text)),
      '{startedAt}', to_jsonb($3::text)
    )::text
    WHERE key=$1
      AND value::jsonb->>'status'='failed'
      AND value::jsonb->>'signature'=$2
    RETURNING key`, [`generation_run:${runId}`,signature,now]);
  return result.rowCount===1;
}
async function writeGenerationRun(runId,state){
  if(!runId)return;
  await db.query(`UPDATE app_state SET value=$2 WHERE key=$1`,[
    `generation_run:${runId}`,
    JSON.stringify({...state,updatedAt:new Date().toISOString()})
  ]);
}
app.get('/api/generation-run/:runId',async(req,res)=>{
  res.set('Cache-Control','no-store');
  const runId=normalizeGenerationRunId(req.params.runId);
  if(!runId)return res.status(400).json({ok:false,error:'Identificador de test inválido.'});
  try{
    const state=await readGenerationRun(runId);
    if(!state)return res.status(404).json({ok:false,error:'No existe esa generación.'});
    if(state.status==='completed')return res.json({ok:true,status:'completed',
      sessionId:state.sessionId,questions:publicManualPageQuestions(state.questions),coverage:state.coverage});
    if(state.status==='failed')return res.json({ok:true,status:'failed',
      resumable:Boolean(state.draft?.questions?.some(Boolean)),
      validQuestions:state.draft?.questions?.filter(Boolean).length||0,
      error:state.error||'La generación no pudo completarse.'});
    const age=Date.now()-new Date(state.startedAt||0).getTime();
    if(age>30*60*1000)return res.json({ok:true,status:'stale',
      error:'La generación no concluyó. Comprueba los registros antes de reintentar.'});
    return res.json({ok:true,status:'processing'});
  }catch(error){
    console.error('ERROR GENERATION-RUN:',error);
    return res.status(500).json({ok:false,error:'No se pudo recuperar el test.'});
  }
});

// SERVER 123: selección común de registros alternativos ANTES o DESPUÉS de
// generar. Mismo tema, sin duplicados ni cambios en prioridades de BD.

// Solo sustituye plazas rechazadas, conservando intactas las aprobadas.
// Límite de coste: un lote adicional (<=5) y una auditoría, sin nuevos bucles.



// SERVER 135 — rescate territorial determinista, sin llamadas a Gemini.
// Solamente usa relaciones de la tabla PDF 23/24 o los registros T21
// ya cruzados con la cobertura. Si falta una relación, no inventa respuesta.


/* MOTOR 136 — RECORRIDO ÚNICO. Sustituye íntegramente al POST anterior.
 * No cambia tablas, cobertura, SRS, estadísticas ni persistencia transaccional.
 * Extracción factual local desde coverage_items; File Search SOLO cuando
 * falta extracto. Auditoría independiente y limitada a respuesta única.
 */
const R136_MODEL = String(process.env.RESET_GENERATION_MODEL_136 || 'gemini-3.6-flash');
const R136_AUDITOR = String(process.env.RESET_VALIDATION_MODEL_136 || 'gemini-3.5-flash-lite');
// SERVER 139: datos acotados por petición. El PDF nunca se acorta más
// de lo que ya acotaba resetPrompt136 (3.000 caracteres por objetivo).
// Se pueden agrupar varios temas DEL MISMO BLOQUE gracias al índice de slot.
const R136_BATCH = 10;
const R136_CONTEXT_BUDGET = 18000; // caracteres de evidencia por llamada
const R136_CONCURRENCY = Math.min(3, Math.max(1, Number(process.env.RESET_GEMINI_PARALLELISM || 2) || 2));
const R136_TIMEOUT_MS = 65000;
const R136_NORM = value => String(value ?? '').normalize('NFKC').toLocaleLowerCase('es').replace(/\s+/g,' ').trim();
function resetShape136(q){
  if(!q || typeof q.stem!=='string' ||
     q.stem.trim().length<((q.ankiDirect===true||q.ankiOriginalBank===true)?1:15))return 'Enunciado vacío/corto';
  // Sólo las tarjetas Anki originales (o validadas ya guardadas en banco)
  // pueden tener 3 opciones. Las generadas por Gemini siguen exigiendo 4.
  const originalAnki=(q.ankiDirect===true||q.ankiOriginalBank===true);
  const allowed=originalAnki?[3,4]:[4];
  if(!Array.isArray(q.options)||!allowed.includes(q.options.length)||
     q.options.some(x=>typeof x!=='string'||!x.trim()))return 'Opciones inválidas';
  if(new Set(q.options.map(R136_NORM)).size!==q.options.length)return 'Opciones duplicadas';
  // Igualdad visible: guiones, signos y espacios no diferencian respuestas.
  const shown=q.options.map(x=>String(x).normalize('NFD')
    .replace(/[\u0300-\u036f]/g,'').toLowerCase()
    .replace(/[–—-]/g,' ').replace(/[^a-z0-9]+/g,' ').trim());
  if(new Set(shown).size!==q.options.length)return 'Opciones equivalentes';
  if(!Number.isInteger(q.correctIndex)||q.correctIndex<0||
     q.correctIndex>=q.options.length)return 'Índice incorrecto';
  return null;
}
function resetQuote136(quote, excerpt){
  const norm=R136_NORM(quote),text=R136_NORM(excerpt);
  return norm.length>=18 && text.includes(norm);
}
// No crear preguntas locales para parques solares/eólicos a partir de tablas
// antiguas: ambas materias pasan por la generación + auditoría documental.
function resetGeoTableQuestion136(){ return null; }
// Une objetivos contiguos del mismo bloque SIN perder su posición global.
// Un lote se limita por número de preguntas Y tamaño de evidencia, para evitar
// que una petición enorme convierta menos llamadas en más latencia y 504.
function resetGroups139(rows){
  const groups=[];
  for(const row of rows){
    const last=groups.at(-1);
    const block=String(row.t.topic_block||'').toLowerCase();
    const bytes=Math.min(3000,String(row.t.source_evidence||'').length);
    const current=last ? last.reduce((n,r)=>n+Math.min(3000,String(r.t.source_evidence||'').length),0):0;
    if(last&&last.length<R136_BATCH &&
       String(last[0].t.topic_block||'').toLowerCase()===block &&
       current+bytes<=R136_CONTEXT_BUDGET){
      last.push(row);
    }else groups.push([row]);
  }
  return groups;
}
async function resetPool136(tasks,worker,limit=R136_CONCURRENCY){
  const out=new Array(tasks.length);let cursor=0;
  await Promise.all(Array.from({length:Math.min(limit,tasks.length)},async()=>{
    for(;;){const i=cursor++;if(i>=tasks.length)break;
      try{out[i]={ok:true,value:await worker(tasks[i],i)};}
      catch(e){out[i]={ok:false,error:String(e?.message||e)};}
    }
  }));
  return out;
}
// GEOGRAFÍA 2026: modelos sintácticos elaborados a partir de las preguntas
// oficiales 26-50 mostradas por el usuario. NO son transcripciones literales,
// ni contienen respuestas o datos para validar hechos del temario.
// La selección es exclusivamente de ESTILO: no modifica dificultad, cobertura,
// familia factual, distractores, fuentes, auditoría ni selección de objetivos.
const GEOGRAFIA_PATRONES_ESTILO_2026=Object.freeze([
  {tema:/embalse|balsa|laguna|agua|helicopter|incendio forestal/,modelo:'Ante un incendio en [ubicación documentada], ¿qué punto de agua corresponde según el temario?'},
  {tema:/localidad|municipio|concejo|valle|termino|bardenas/,modelo:'¿Cuál de las siguientes localidades pertenece a [ámbito territorial]? (También cabe preguntar cuál NO pertenece, si hay evidencia para las cuatro opciones.)'},
  {tema:/barrio|parque de bomberos|moviliza|localidad|sima/,modelo:'SOS Navarra recibe un aviso de [incidente] en [lugar]. ¿Qué parque de bomberos se movilizará?'},
  {tema:/poligono|industrial|carretera|ruta|acceso/,modelo:'Ante un aviso en [instalación o polígono], ¿por qué carretera accedería [parque indicado]?'},
  {tema:/puerto|collado|sender|recorrido|travesia|gr-/,modelo:'Durante una travesía desde [origen] hacia [destino], ¿qué puerto o collado se atraviesa según la ruta documentada?'},
  {tema:/monte|sierra|cima|orientacion|cardinal|norte|sur|este|oeste/,modelo:'Desde [monte o alto], ¿qué [río/localidad] se encuentra en la dirección cardinal indicada?'},
  {tema:/camino|itinerario|carretera|poblacion|nucleo/,modelo:'Al seguir [ruta documentada] desde [origen], ¿qué localidad o vía se encuentra a continuación?'},
  {tema:/tunel|galeria|cercan/,modelo:'Se registra un accidente en [túnel documentado]. ¿Qué parque figura asignado a ese túnel en el temario?'},
  {tema:/precipitacion|climat|meteorolog/,modelo:'Según los datos de climatología del temario, ¿qué estación registra [magnitud consultada]?'},
  {tema:/afluente|hidrograf|rio|arroyo|cuenca/,modelo:'¿De qué río es afluente [curso de agua] según la relación directa documentada?'},
  {tema:/afluente|hidrograf|rio|arroyo|cuenca/,modelo:'¿Por qué río pasarán las aguas de [curso de agua], siguiendo una cadena de afluentes documentada?'},
  {tema:/ferroviari|apeadero|apartadero|linea ferrea|estacion de tren/,modelo:'En [línea o tramo ferroviario], ¿qué estación, apeadero o apartadero corresponde a [localidad o relación documentada]?'},
  {tema:/eolic|solar|parque eolico|na-/,modelo:'¿Dónde se sitúa [instalación] respecto a [carretera o referencia territorial]?'},
  {tema:/helisuperficie|helipuerto|aerodromo|evacua/,modelo:'¿Qué localidad aparece vinculada a [instalación aérea], según la relación específica del temario?'},
  {tema:/voluntario|parque|intervencion|accident/,modelo:'¿Qué parque de bomberos atendería [punto documentado], según la asignación territorial?'},
]);
function pickGeografiaExamples73(targets,count=3){
  const norm=x=>String(x||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
  const list=Array.isArray(targets)?targets:[];
  const topics=norm(list.map(t=>t?.topic_name||'').join(' '));
  const source=norm(list.map(t=>`${t?.section||''} ${t?.concept||''}`).join(' '));
  // Primero los modelos del tema seleccionado, luego los del concepto.
  // El resto sólo sirve de recurso cuando no existen tres afines.
  const related=GEOGRAFIA_PATRONES_ESTILO_2026.map((e,i)=>({e,i,
    score:(e.tema.test(topics)?2:0)+(e.tema.test(source)?1:0)}))
    .filter(x=>x.score>0).sort((a,b)=>b.score-a.score||a.i-b.i).map(x=>x.e);
  const selected=related.length?related.slice(0,count):[
    {modelo:'¿Qué [entidad] corresponde a [relación geográfica documentada]?' }
  ];
  return selected.map(e=>e.modelo);
}
// Estilo exclusivo del tema «Conexiones por carretera desde parques de bomberos».
// Los tres ejemplos son demostraciones de FORMATO, no evidencia factual:
// las respuestas reales siempre se auditan contra el temario cargado.
const CONEXIONES_ESTILO_EJEMPLOS_2026=Object.freeze([
  'TIPO 1 (localidad → secuencia): «Desde el Parque Central de Pamplona, ¿qué secuencia de carreteras corresponde al recorrido hacia Muskitz?» A) PA-31 → A-15 → AP-15 → N-240-A → Red local [correcta]; B) PA-31 → A-15 → N-240-A → AP-15 → Red local; C) PA-31 → AP-15 → A-15 → N-240-A → Red local; D) PA-31 → A-15 → AP-15 → NA-240-A → Red local.',
  'TIPO 2 (secuencia → localidad): «¿A qué localidad se accede desde el Parque de Lodosa mediante NA-123 → NA-134 → NA-122 → NA-601?» A) Larraga; B) Lerín [correcta]; C) Garínoain; D) Lantz.',
  'TIPO 3 (alternativas documentadas): «Desde el Parque de Tafalla, ¿qué afirmación sobre el recorrido hacia Garínoain es correcta?» A) Únicamente por AP-15; B) N-121 y después NA-601; C) N-121 exclusivamente o N-121 → AP-15 → N-121 [correcta]; D) Obligatoriamente AP-15 antes de N-121.'
]);
function esTemaConexiones2026(target){
  const nombre=String(target?.topic_name||'').normalize('NFD')
    .replace(/[\u0300-\u036f]/g,'').toLowerCase();
  return /conexiones.*(?:carretera|parque)|(?:carretera|parque).*conexiones|recorridos? por carretera.*parque/.test(nombre);
}
// Referencias de estilo exclusivas del tema Parques eólicos (Tema 2).
// No constituyen evidencia factual: cada respuesta se verifica en el temario.
const EOLICOS_ESTILO_EJEMPLOS_2026=Object.freeze([
  'TIPO 1 (instalación → parque): «Se declara un incendio en [PARQUE EÓLICO documentado]. ¿Qué parque de bomberos interviene en primera salida?» A-D cuatro parques operativos de la misma región, con una sola asignación demostrada en el epígrafe del PDF.',
  'TIPO 2 (instalación → ubicación): «¿Dónde se encuentra [PARQUE EÓLICO documentado]?» A-D cuatro ubicaciones detalladas de similar longitud que combinan municipio, orientación y carretera; tres incorrectas, una correcta según el registro.',
  'TIPO 3 (ubicación → instalación): «¿Qué parque eólico se sitúa [ORIENTACIÓN + MUNICIPIO + CARRETERA documentados]?» A-D cuatro nombres reales y comparables procedentes exclusivamente del PDF; no usar una instalación alternativa que comparta todos los atributos.'
]);
// TEMA 23 — PLANTAS SOLARES: 12 modelos aprobados, SOLO estilo.
// No son fuente factual ni preguntas pregrabadas; el PDF de cada objetivo manda.
const SOLARES_ESTILO_EJEMPLOS_2026=Object.freeze([
  'PRIMERA SALIDA: «Se declara un incendio en la planta solar Valdegón. ¿Qué parque interviene en primera salida?» A) Lodosa; B) Estella [correcta]; C) Peralta; D) Tafalla.',
  'UBICACIÓN: «¿Dónde se encuentra Alto Monplanete?» A) Noreste de Olite, NA-5300; B) Suroeste de Olite, entre NA-115 y N-121 [correcta]; C) Sur de Olite, entre Beire y Pitillas; D) Suroeste de Tafalla, NA-132.',
  'IDENTIFICACIÓN: «¿Qué planta se encuentra al este de Corella, entre AP-15 y AP-15-R?» A) Cierzo; B) Guardián; C) La Sarda [correcta]; D) Cierzo N.',
  'PRIMERA SALIDA: «En caso de incendio en Ganazo, ¿qué parque interviene en primera salida?» A) Sangüesa; B) Peralta; C) Tafalla [correcta]; D) Lodosa.',
  'UBICACIÓN: «¿Dónde se encuentra Corraliza del Vecino?» A) Norte de Cabanillas, entre NA-126, NA-134 y NA-125 [correcta]; B) Norte de Fustiñana, NA-126; C) Este de Villafranca; D) Noroeste de Bardenas, N-121.',
  'IDENTIFICACIÓN: «¿Qué planta está al sur de Sesma, junto a NA-129?» A) El Salobral de la Coja; B) El Salobre [correcta]; C) El Encimero; D) Valdegón.',
  'PRIMERA SALIDA: «¿Qué parque interviene en primera salida en Cáseda 2?» A) Central de Pamplona; B) Tafalla; C) Sangüesa [correcta]; D) Peralta.',
  'IDENTIFICACIÓN: «¿Qué planta está al noroeste de Cortes, en el límite con Buñuel, paralela a A-68?» A) La Dehesa; B) Atalaya [correcta]; C) La Olivera; D) Ablitas.',
  'PRIMERA SALIDA: «¿Qué parque tiene asignada Arbanta?» A) Estella; B) Peralta; C) Lodosa [correcta]; D) Tudela.',
  'IDENTIFICACIÓN: «¿Qué instalación está al suroeste de Fontellas, junto a AP-68?» A) Fontellas; B) La Olivera [correcta]; C) Ablitas; D) La Torre Martiniega.',
  'UBICACIÓN: «¿Qué planta se encuentra al norte de Valtierra, paralela a NA-134?» A) Arguedas; B) Valtierra [correcta]; C) Arguedas I El Común; D) Arguedas II Molinaz.',
  'IDENTIFICACIÓN: «¿Qué planta está al oeste de Corella y de NA-161?» A) La Sarda; B) Cierzo; C) Guardián [correcta]; D) El Vinagre.'
]);
// SERVER 82 — El catálogo mantiene los 12 ejemplos aprobados. Gemini recibe
// solo tres por lote (uno de cada operación) para evitar sobreadaptación a los
// modelos directos y acotar tokens. Rotación determinista, sin azar ni llamadas.
function resetSolarExamples82(targets){
  const seed=targets.reduce((sum,t)=>sum+(Number(t?.id)||0),0);
  const families=[[0,3,6,8],[1,4],[2,5,7,9,10,11]];
  return families.map((family,i)=>SOLARES_ESTILO_EJEMPLOS_2026[
    family[(seed+i)%family.length]
  ]);
}
function esTemaSolares2026(target){
  const nombre=String(target?.topic_name||'').normalize('NFD')
    .replace(/[\u0300-\u036f]/g,'').toLowerCase();
  return /parques? solares?|plantas? solares?|instalaciones? (?:solares?|fotovoltaicas?)|parques? fotovoltaicos?/.test(nombre);
}
const SOLARES_REGLAS_2026=`TEMA 23 — PLANTAS SOLARES, ESTILO OPOSICIÓN BOMBEROS DE NAVARRA:
- Imita la naturalidad, precisión y distractores de los 12 ejemplos aprobados, pero NUNCA uses sus nombres, alternativas o respuestas como fuente factual.
- Alterna cuando esté documentado: instalación → parque de primera salida; instalación → ubicación (municipio, carreteras y orientación); descripción geográfica → instalación; supuesto breve de incendio/accidente → parque expresamente asignado.
- MUY ALTA: prioriza discriminar DOS referencias próximas comprobables del mismo registro (por ejemplo nombre + carretera + orientación, o ubicación + parque) y opciones que cambian solo un dato relevante. No es dificultad sumar datos inconexos ni usar lenguaje artificioso.
- Distractores: cuatro alternativas de la misma clase y extensión similar, con municipios, parques, vías o instalaciones geográficamente comparables. Usa preferentemente otros hechos del PDF aportados en OBJETIVOS; nunca inventes un nombre, ruta, parque o situación ni confundas cercanía con adscripción.
- Las instalaciones Rada I/Rada II, Cáseda 1/2/3, La Pedrera I/II/III y Montes del Cierzo/Montes del Cierzo II comparten sus descripciones documentadas; NO hagas una pregunta de identificación geográfica cuya respuesta pudiera ser cualquiera de esas instalaciones. Tampoco incluyas entre las alternativas otra instalación que cumpla exactamente el mismo enunciado.
- Para determinar el parque en primera salida, el epígrafe PARQUE [nombre] del OBJETIVO es dato factual de la fuente. No sustituyas su asignación por deducciones a partir del municipio. El parque válido es el del epígrafe de cada ficha, aunque otros registros del mismo municipio pertenezcan a otro parque.
- Reproduce los nombres EXACTAMENTE como estén en el PDF más reciente, incluso I/II y tildes. Nunca emplees «según la tabla», números GEO, número de hoja, preguntas sobre promotor, potencia, superficie o puesta en servicio.
- Preguntas variadas, cuatro opciones realmente diferentes, una sola correcta demostrable y explicación breve; los fragmentos de OBJETIVOS son la única evidencia.
- TERMINOLOGÍA: no inventes registros ni autoridades («registro territorial de emergencias»). Ubicación geográfica se pregunta como ubicación; cuando consultes asignación operativa di «radio de actuación de los parques de bomberos» si el epígrafe del PDF documenta ese parque.`;
const EOLICOS_REGLAS_EXAMEN_80=`TEMA 24 — PARQUES EÓLICOS, ESTILO OPOSICIÓN BOMBEROS DE NAVARRA:
- Reproduce los TRES modelos aprobados: instalación → parque de bomberos; instalación → ubicación detallada; descripción de emplazamiento → instalación. Introduce supuestos breves de intervención solo si el parque consta en el objetivo.
- Dificultad MUY ALTA: dos o más relaciones territoriales documentadas, sin pistas en el enunciado y distractores del MISMO tipo y dificultad, preferentemente de parques cercanos, fases próximas, carreteras similares o municipios limítrofes.
- Cuando una instalación atraviesa varios municipios o ámbitos operativos, NO la reduzcas a un único parque; plantea una pregunta que refleje la relación completa si está respaldada.
- No inventes municipios, vías, parque de salida, carreteras o límites a partir de nombres de los parques. No copies literalmente la respuesta de ningún ejemplo de estilo.
- Si varios parques comparten exactamente los atributos con que se pregunta, reformula a otro atributo o rechaza el ítem; cuatro respuestas deben ser distintas y solo una compatible con el enunciado.
- Evita «según la tabla del temario», «qué combinación figura», opciones burdas y cambios de categorías que delaten la solución.
- TERMINOLOGÍA: no atribuyas información a un supuesto «registro territorial de emergencias» o «registro de emergencias». Para una ubicación geográfica, pregunta directamente dónde se encuentra la instalación. Si preguntas qué parque atiende un sector, usa «según el radio de actuación de los parques de bomberos» únicamente cuando el epígrafe del PDF sustente expresamente esa asignación.`;
function esTemaEolicos2026(target){
  const nombre=String(target?.topic_name||'').normalize('NFD')
    .replace(/[\u0300-\u036f]/g,'').toLowerCase();
  return /parques? eolicos?|instalaciones eolicas?/.test(nombre);
}
// Tema 3 — ferrocarril. Ejemplos aprobados: SOLO estilo; los datos de cada
// pregunta nueva deben estar demostrados en la evidencia curricular del objetivo.
const FERROCARRIL_ESTILO_EJEMPLOS_2026=Object.freeze([
  'TIPO 1 (incidente → parque de primera salida): «En caso de accidente ferroviario en el apartadero de Marcilla, ¿qué parque de bomberos actuaría en primera salida?» A) Tudela; B) Tafalla; C) Peralta [correcta]; D) Lodosa.',
  'TIPO 2 (instalación → clasificación): «¿Cómo está clasificada la instalación ferroviaria de Cizur Mayor?» A) Apartadero-cargadero; B) Apeadero-cargadero [correcta]; C) Apeadero; D) Apartadero.',
  'TIPO 3 (pasos con semibarreras): «¿En cuáles de los siguientes puntos de la línea Zaragoza–Alsasua existen pasos con semibarreras?» A) Noáin y Pamplona; B) Esquíroz y Berrioplano [correcta]; C) Cizur Mayor y Landaben; D) Zuasti e Irurzun.',
  'TIPO 4 (línea → trazado documentado): «¿Qué carretera sigue la línea Soria–Castejón, cruzándose con ella?» A) A-1; B) NA-660; C) N-113 [correcta]; D) NA-134-2.',
  'TIPO 5 (recuento por línea): «¿Cuántos apeaderos aparecen en la línea Madrid–Irún?» A) Uno; B) Dos [correcta]; C) Tres; D) Cuatro.'
]);
function esTemaFerrocarril2026(target){
  const nombre=String(target?.topic_name||'').normalize('NFD')
    .replace(/[\u0300-\u036f]/g,'').toLowerCase();
  return /ferrocarril|red ferroviaria|lineas ferroviarias|infraestructura ferroviaria/.test(nombre);
}
// TEMA 27 CAMINO DE SANTIAGO: referencias exclusivamente de estilo.
// No se insertan en el banco ni sustituyen la evidencia factual del PDF.
const CAMINO_ESTILO_EJEMPLOS_2026=Object.freeze([
  'PRIMERA SALIDA: «Un peregrino sufre un accidente en Pekotxeta. ¿Qué parque de bomberos intervendrá en primera salida?» A) Oronoz; B) Burguete [correcta]; C) Central de Pamplona; D) Sangüesa.',
  'CASCO URBANO: «¿Por cuál de los siguientes concejos no atraviesa el Camino de Santiago su casco urbano?» A) Aurizberri/Espinal; B) Bizkarreta-Gerendiain; C) Lintzoain; D) Mezkiritz [correcta].',
  'DOBLE RELACIÓN: «¿Por cuál de los siguientes concejos no atraviesa el Camino de Santiago su casco urbano y qué parque intervendría en primera salida en dicha localidad?» A) Aurizberri/Espinal — Burguete; B) Bizkarreta-Gerendiain — Burguete; C) Lintzoain — Burguete; D) Mezkiritz — Burguete [correcta]. Todas las parejas localidad-parque son verdaderas: solo cambia la condición del casco urbano.',
  'ORDEN: «En dirección a Pamplona, ¿en qué orden se encuentran estas localidades del Camino de Baztan?» A) Arizkun – Elizondo – Elbete – Irurita; B) Arizkun – Elbete – Elizondo – Irurita [correcta]; C) Elbete – Arizkun – Irurita – Elizondo; D) Arizkun – Elbete – Irurita – Elizondo.',
  'INCIDENTE: «Se produce un incendio en una vivienda de Abínzano. ¿Qué parque de bomberos interviene en primera salida?» A) Sangüesa; B) Burguete; C) Estella; D) Central de Pamplona [correcta].',
  'MUNICIPIO: «¿A qué municipio pertenecen Izco, Abínzano y Salinas de Ibargoiti?» A) Urraúl Bajo; B) Ibargoiti [correcta]; C) Unciti; D) Noáin (Valle de Elorz).',
  'DISTINCIÓN TERRITORIAL: «¿Por cuál de las siguientes localidades no atraviesa el Camino de Santiago su casco urbano?» A) Akerreta; B) Irotz; C) Larrasoaña [correcta]; D) Zabaldika.',
  'CONFLUENCIA: «¿En qué localidad confluyen el Camino Francés procedente de Valcarlos y el Camino de Baztan?» A) Arre; B) Villava [correcta]; C) Burlada; D) Pamplona.',
  'CONCEJOS PRÓXIMOS: «¿Cuál de estas localidades atraviesa el Camino de Santiago por su casco urbano?» A) Arizala; B) Murugarren; C) Lorca [correcta]; D) Lácar.',
  'CONCEJOS DE UN MUNICIPIO: «¿Cuál de estas localidades atraviesa el Camino de Santiago por su casco urbano?» A) Erratzu; B) Gartzain; C) Berroeta [correcta]; D) Lekaroz.'
]);
function esTemaCamino2026(target){
  const nombre=String(target?.topic_name||'').normalize('NFD')
    .replace(/[\u0300-\u036f]/g,'').toLowerCase();
  return /camino de santiago/.test(nombre);
}
const CAMINO_REGLAS_2026=`CAMINO DE SANTIAGO (SOLO SI EL OBJETIVO PERTENECE A ESTE TEMA):
- Redacción natural de oposición: no escribas «no figura en la relación», «según la lista» ni menciones municipio, variante o parque cuando eso facilite la respuesta.
- Diferencia rigurosamente término municipal atravesado, territorio de concejo, localidad del itinerario y casco urbano físicamente atravesado. No deduzcas unos de otros.
- Si preguntas por una localidad NO atravesada por su casco urbano, la evidencia debe demostrar expresamente ese extremo. No basta su ausencia en una lista parcial.
- Distractores prioritarios: concejos del mismo municipio, luego misma demarcación de parque y finalmente localidades próximas; las cuatro opciones deben ser verosímiles y una sola correcta.
- En preguntas combinadas casco urbano + primera salida, todas las parejas localidad-parque deben ser correctas; la respuesta se distingue únicamente por la condición del trazado.
- Para primera salida usa exclusivamente la asignación documentada; no infieras proximidad ni tiempo de llegada. Pamplona ciudad/Trinitarios no equivale a Central Cordovilla.
- Alterna sin cuotas rígidas: accidente o incendio y parque, concejo y casco urbano, orden de localidades, municipio, confluencia, secuencia y relaciones combinadas. Dos o tres ejemplos de un patrón bastan; no repitas su enunciado ni sus nombres.
- No inventes bifurcaciones, pasos por núcleos, adscripciones o exclusiones. Una pregunta combinada requiere evidencia documental de TODOS sus componentes y distractores. Si falta, formula una relación más simple sustentada en el objetivo.
- Los ejemplos de estilo NO son fuente factual ni preguntas para reproducir; prevalece siempre el PDF factual del tema.`;
// SERVER 81 — criterio editorial transversal para todas las materias.
// Solo modifica el texto enviado a Gemini: ninguna ruta, modelo, llamada,
// dificultad, cuota Anki, cobertura, banco o validador cambia.
function reglasCalidadTransversal81(difficulty,leg,geo){
  const nivel=String(difficulty||'').toLowerCase()==='muy alta'
    ? 'MUY ALTA: distractores muy próximos; combina dos condiciones SOLO si ambas constan en el mismo objetivo. Si solo consta una, no inventes la segunda.'
    : 'ALTA: exige precisión y comprensión, no mera eliminación de respuestas absurdas.';
  const materia=leg
    ? 'LEGISLACIÓN: diferencias literales de competencia, sujeto, plazo o excepción SOLO si constan; respetar polaridad y cuota Anki.'
    :geo
      ? 'GEOGRAFÍA: distinguir municipio, concejo, casco urbano, parque asignado, vía y sentido; no deducir por proximidad ni fundir variantes.'
      : 'ESPECÍFICO: contrastar componentes, magnitudes, unidades o procedimientos documentados; no inventar límites.';
  return `CALIDAD TRANSVERSAL DE OPOSICIÓN:
- Enunciado natural y directo, sin pistas, fórmulas vacías ni preguntas sobre tablas o páginas.
- Cuatro alternativas distintas de la MISMA categoría, extensión y precisión similares. Distractores cercanos: variar una propiedad significativa y comprobable, no añadir nombres ni hechos externos. Prohibidas pistas gramaticales y una opción desproporcionadamente detallada.
- Exactamente UNA alternativa compatible con el enunciado completo. Si dos comparten la respuesta o la evidencia no discrimina, reformular usando otro atributo demostrado del mismo objetivo.
- Explicación breve que justifique la solución. Ejemplos oficiales y de calibración: SOLO estilo; PDF: ÚNICA fuente factual.
${nivel}
${materia}`;
}
// SERVER 82 — Comparaciones SOLO en 23/24 Muy alta. Siempre salen de
// coverage_items vigente del MISMO tema, nunca de los ejemplos de estilo.
// Un SELECT por test (NO una llamada adicional a Gemini). Si falla, el motor
// continúa sin comparadores. No altera selección adaptativa ni cobertura.
function resetGeoCompareTargets82(targets,difficulty){
  return String(difficulty)==='muy alta' && targets.some(t=>
    esTemaSolares2026(t)||esTemaEolicos2026(t));
}
async function resetGeoComparePool82(targets,difficulty){
  if(!resetGeoCompareTargets82(targets,difficulty))return [];
  const ids=[...new Set(targets.filter(t=>esTemaSolares2026(t)||esTemaEolicos2026(t))
    .map(t=>Number(t.topic_id)).filter(Number.isInteger))];
  if(!ids.length)return [];
  try{
    const result=await db.query(`SELECT ci.id,ci.topic_id,ci.section,ci.concept,
             left(ci.source_evidence,500) AS source_evidence
      FROM coverage_items ci JOIN topics tp ON tp.id=ci.topic_id
      WHERE ci.topic_id=ANY($1::int[]) AND ci.exam_relevant=TRUE
        AND length(trim(COALESCE(ci.source_evidence,'')))>=55
        AND tp.block='geografia'
      ORDER BY ci.id LIMIT 300`,[ids]);
    return result.rows;
  }catch(error){
    console.warn('RESET_82_COMPARADORES_NO_DISPONIBLES:',String(error?.message||error).slice(0,100));
    return [];
  }
}
function resetGeoCompareRoads82(text){
  return new Set((String(text||'').toUpperCase().match(/\b(?:AP|NA|PA|A|N)-\d+(?:-[A-Z0-9]+)*/g)||[]));
}
function resetGeoComparisons82(targets,pool,difficulty){
  if(!resetGeoCompareTargets82(targets,difficulty)||!pool.length)return [];
  const selected=new Set(targets.map(t=>Number(t.id)));
  const result=[],already=new Set();
  let budget=4600;
  for(let i=0;i<targets.length;i++){
    const t=targets[i];
    if(!(esTemaSolares2026(t)||esTemaEolicos2026(t)))continue;
    const section=R136_NORM(t.section),road=resetGeoCompareRoads82(t.source_evidence);
    const ranked=pool.filter(c=>Number(c.topic_id)===Number(t.topic_id)&&
        !selected.has(Number(c.id))&&!already.has(Number(c.id)))
      .map(c=>{
        const otherRoads=resetGeoCompareRoads82(c.source_evidence);
        const common=[...road].filter(x=>otherRoads.has(x)).length;
        return {c,score:(R136_NORM(c.section)===section?5:0)+8*common};
      })
      .sort((a,b)=>b.score-a.score||Number(a.c.id)-Number(b.c.id));
    // Prefer same documented area/roads; absent comparison is safer than
    // inferring adjacency from names or geography we have not verified.
    for(const {c,score} of ranked.slice(0,12)){
      if(score<=0||budget<150)break;
      const evidence=String(c.source_evidence||'').slice(0,240);
      const item={slot:i+1,epigrafe:String(c.section||'').slice(0,90),
        concepto:String(c.concept||'').slice(0,135),fragmento:evidence};
      const length=JSON.stringify(item).length;
      if(length>budget)continue;
      result.push(item);budget-=length;already.add(Number(c.id));
      // Un comparador por objetivo limita ruido, tokens y latencia.
      break;
    }
  }
  return result;
}
function resetPrompt136(targets,difficulty,mode,comparisons=[]){
  const leg=targets.every(t=>String(t.topic_block).toLowerCase()==='legislacion');
  const geo=targets.every(t=>String(t.topic_block).toLowerCase()==='geografia');
  const soloConexiones=geo && targets.length>0 && targets.every(esTemaConexiones2026);
  const soloEolicos=geo && targets.length>0 && targets.every(esTemaEolicos2026);
  const soloSolares=geo && targets.length>0 && targets.every(esTemaSolares2026);
  const soloFerrocarril=geo && targets.length>0 && targets.every(esTemaFerrocarril2026);
  const soloCamino=geo && targets.length>0 && targets.every(esTemaCamino2026);
  const examples=leg ? pickLegislationExamples94(targets,difficulty,2) :
    soloConexiones ? CONEXIONES_ESTILO_EJEMPLOS_2026 :
    soloEolicos ? EOLICOS_ESTILO_EJEMPLOS_2026 :
    soloSolares ? resetSolarExamples82(targets) :
    soloFerrocarril ? FERROCARRIL_ESTILO_EJEMPLOS_2026 :
    soloCamino ? CAMINO_ESTILO_EJEMPLOS_2026 :
    geo ? pickGeografiaExamples73(targets,3) : [
    'T21: concejo a municipio y parque; no confundir municipio con concejo.',
    'T22-25: instalación a municipio y asignación de parque, según tabla literal.',
    'Ríos: afluente directo o cadena indirecta sólo si todos los eslabones constan en el PDF.',
    'No adelantar la respuesta en el propio enunciado ni inferir proximidad desde mapas.'
  ];
  const items=targets.map((t,i)=>({slot:i+1,tema:t.topic_name,epigrafe:t.section,
    concepto:t.concept,fragmento:String(t.source_evidence||'').slice(0,3000),
    familia:t.questionFamily||'2024_TEXTO',
    }));
  const styleTitle=geo
    ? 'MODELOS DE REDACCIÓN BASADOS EN LAS PREGUNTAS 26-50 DE GEOGRAFÍA 2026 (SOLO ESTILO, NO FUENTE FACTUAL)'
    : 'REFERENCIAS DE CALIBRACIÓN (SOLO ESTILO)';
  return `Eres examinador de Bombero de Navarra, oposición nivel C. Redacta ${targets.length} preguntas NUEVAS, nivel ${difficulty}, modalidad ${mode}.
NUNCA utilices conocimientos externos ni hechos de ejemplos de exámenes. La ÚNICA fuente factual son los fragmentos del PDF proporcionados en OBJETIVOS; si falta el dato, recupera exclusivamente del PDF del temario mediante File Search cuando se te habilite.
Un objetivo por pregunta, EN ORDEN. Cuatro opciones homogéneas; exactamente una correcta. Distractores plausibles pero falsos a la luz del texto. No inventes normas, cifras o excepciones.
${geo && (soloSolares||soloEolicos) ? 'MUY ALTA significa discriminación territorial precisa y distractores próximos, no preguntas triviales de una columna. En ALTA mantén precisión, cuatro alternativas homogéneas y enunciados naturales. Evita introducciones del tipo «Según la tabla del temario». La sección PARQUE del objetivo es un dato factual explícito.': 'No endurezcas artificialmente el nivel: Alta / Muy alta son niveles del examen de funcionario C, no de posgrado.'} ${geo?'':'En modalidad INCORRECTA hay tres afirmaciones verdaderas y una falsa.'}
La auditoría independiente aportará la cita textual del PDF. Devuelve únicamente enunciado, cuatro alternativas, índice y explicación breve.
Pregunta sólo lo respaldado, evita pistas y duplicados. Mantén exactamente la familia de cada objetivo. Formato JSON según el esquema solicitado.
${reglasCalidadTransversal81(difficulty,leg,geo)}\nDIVERSIDAD TRANSVERSAL (Legislación, Geografía, Específico): cada OBJETIVO es un hecho distinto; pregunta por su relación examinable, no repitas enunciados equivalentes ni inviertas el mismo dato entre preguntas. Si hay varias operaciones documentadas (identificar, relacionar, aplicar, ordenar, distinguir), distribúyelas; NO fuerces operaciones sin evidencia. No repitas un patrón sólo por aparecer en los ejemplos de estilo.
${geo?'ESTILO GEOGRAFÍA: Formula preguntas directas sobre un hecho, una ubicación, una relación, un itinerario o una intervención documentada. Prefiere enunciados positivos; permite NO cuando la relación negativa esté plenamente acreditada. No uses fórmulas genéricas como «señale la correcta/incorrecta» ni impongas cuotas de polaridad. No inventes escenarios, trayectos o proximidades. La dificultad, los distractores y la verificación factual siguen las reglas comunes.':''}
${styleTitle}: ${JSON.stringify(examples).slice(0,soloSolares?8500:4400)}
${soloCamino?CAMINO_REGLAS_2026+' DIFERENCIA RAMALES: un municipio, concejo, lugar del recorrido y casco urbano son niveles distintos; si una secuencia está dividida en ramales, NO conviertas sus registros en pasos sucesivos obligatorios. La orientación izquierda/derecha solo se interpreta en el sentido de marcha indicado expresamente en el PDF.':''}
${soloFerrocarril?'FERROCARRIL: Prioridad operativa a instalación ferroviaria concreta → parque de bomberos asignado para primera salida ante incidente, SIN deducir proximidad ni tiempos de respuesta. Trabaja también la clasificación literal de cada instalación (estación, apeadero, apartadero, cargadero y mixtas), TODOS los pasos con semibarreras documentados, las relaciones línea → carreteras que sigue o cruza y los recuentos por línea y categoría cuando sean demostrables. Sin porcentajes ni cuotas por modalidad: agota progresivamente los objetivos distintos de cobertura; no descartes tipos con pocos casos. Alterna instalaciones, tramos y operaciones cuando los OBJETIVOS seleccionados lo permitan; no repitas la misma relación ni concentres preguntas en una sola página o sección si hay otros objetivos disponibles. Evita preguntas artificiales sobre cuál es la única línea fuera de servicio o combinaciones triviales de vía única/doble y servicio. No confundir paso con semibarreras con estación, apeadero o apartadero. La selección de objetivos y el SRS son responsabilidad del servidor; estos ejemplos SOLO muestran estilo, no aportan hechos.':''}
${soloSolares?SOLARES_REGLAS_2026:''}
${soloEolicos?EOLICOS_REGLAS_EXAMEN_80:''}
${soloConexiones?'CONEXIONES POR CARRETERA: Alterna las tres modalidades mostradas cuando el objetivo documental lo permita; NO generes preguntas cuya operación principal sea identificar una salida. Las salidas S. y la red local R.LOCAL pueden aparecer dentro del itinerario correcto cuando consten literalmente. Respeta orden, vías, parque de origen y alternativas documentadas. No deduzcas itinerarios de mapas ni inventes carreteras locales de cuatro cifras. Los ejemplos son SOLO estilo, no hechos que puedas trasladar a otros objetivos.':''}
${geo?'Los modelos son solo plantillas de enunciado: sustituye los corchetes por hechos verificables del PDF. No copies nombres, respuestas ni supuestos no documentados. Para cualquier tema, no concentres todas las preguntas en una misma operación si los fragmentos sustentan otras. Los supuestos de incendio/accidente sólo preguntan por el parque ASIGNADO en el temario, nunca por tiempos o proximidad inferidos. Los extremos cardinales sólo se preguntan si el fragmento identifica literalmente el extremo y el túnel; no los deduzcas del orden de una carretera. No reveles la respuesta en el enunciado. Nunca preguntes por códigos GEO-xxxx, números de hoja entre corchetes ([hoja N]), páginas del PDF ni índices editoriales: no son materia examinable.':''}
${(soloSolares||soloEolicos)&&comparisons.length&&difficulty==='muy alta'?`COMPARADORES REALES (mismo PDF, otras fichas): ${JSON.stringify(comparisons)}
Utiliza los COMPARADORES para elegir distractores del mismo tipo, con carreteras, municipios o parques efectivamente documentados. NO transformes un comparador en la respuesta de otro OBJETIVO; NO afirmes proximidad no documentada. Antes de cerrar cada pregunta verifica mentalmente que ningún comparador satisfaga también el enunciado. Si varias fichas comparten descripción, pregunta por otro atributo demostrable o usa otra operación.\n`:''}OBJETIVOS: ${JSON.stringify(items)}`;
}
// Esquema mínimo del motor nuevo: la procedencia y familia las asigna el
// servidor desde coverage_items, nunca el generador. Menos tokens, menos fallos.
const RESET_GENERATE_SCHEMA_137={type:'object',properties:{questions:{type:'array',
  items:{type:'object',properties:{stem:{type:'string'},options:{type:'array',
  items:{type:'string'},minItems:4,maxItems:4},correctIndex:{type:'integer',minimum:0,
  maximum:3},explanation:{type:'string'}},
  required:['stem','options','correctIndex','explanation']}}},required:['questions']};
const RESET_AUDIT_SCHEMA_136={type:'object',properties:{results:{type:'array',items:{type:'object',
  properties:{index:{type:'integer'},answer:{type:'integer',minimum:-1,maximum:3},quote:{type:'string'}},
  required:['index','answer','quote']}}},required:['results']};
// Métricas reales observables sin registrar el texto curricular en los logs.
// Una llamada de generación + una auditoría INDEPENDIENTE por lote.
async function resetGeminiCall139(ai,phase,opts){
  const start=Date.now();
  try{
    const response=await ai.models.generateContent(opts);
    const meta=response?.usageMetadata||{};
    console.log('RESET_139_PROVEEDOR:',JSON.stringify({
      phase,model:opts.model,ms:Date.now()-start,
      promptTokens:Number(meta.promptTokenCount||0),
      outputTokens:Number(meta.candidatesTokenCount||0),
      thinkingTokens:Number(meta.thoughtsTokenCount||0),
      totalTokens:Number(meta.totalTokenCount||0),
      cachedTokens:Number(meta.cachedContentTokenCount||0)
    }));
    return response;
  }catch(error){
    console.warn('RESET_139_PROVEEDOR_ERROR:',JSON.stringify({
      phase,model:opts.model,ms:Date.now()-start,
      status:Number(error?.status||error?.code||0),
      kind:String(error?.message||error).slice(0,160)
    }));
    throw error;
  }
}
async function resetGenerateGroup136(ai, group,difficulty,mode,comparisonPool=[]){
  const requiresSearch=group.some(t=>String(t.source_evidence||'').trim().length<55);
  if(requiresSearch)throw Error('Objetivo sin extracto PDF suficiente. No se realizan llamadas pagadas para adivinar hechos.');
  // El número exigido en JSON debe coincidir con los objetivos del lote.
  // Reduce la posibilidad de lotes incompletos sin agregar llamadas ni auditorías.
  const fixedCountSchema=(schema,key,count)=>({ ...schema,properties:{...schema.properties,
    [key]:{...schema.properties[key],minItems:count,maxItems:count}}});
  const geoHighChallenge=difficulty==='muy alta' && group.length>0 &&
    group.every(t=>esTemaSolares2026(t)||esTemaEolicos2026(t));
  const comparisons=resetGeoComparisons82(group,comparisonPool,difficulty);
  if(geoHighChallenge)console.log('RESET_82_COMPARACIONES:',JSON.stringify({
    objetivos:group.length,comparadores:comparisons.length}));
  const response=await resetGeminiCall139(ai,'generar',{model:R136_MODEL,
    contents:resetPrompt136(group,difficulty,mode,comparisons),config:{
      // PDF acotado y ya recuperado: ningún File Search redundante.
      httpOptions:{timeout:R136_TIMEOUT_MS},
      ...(R136_MODEL.startsWith('gemini-3.')?{thinkingConfig:{thinkingLevel:geoHighChallenge?'medium':'low'}}:{}),
      responseMimeType:'application/json',
      responseJsonSchema:fixedCountSchema(RESET_GENERATE_SCHEMA_137,'questions',group.length)}});
  const parsed=JSON.parse(String(response?.text||'{}'));
  if(!Array.isArray(parsed.questions))throw Error('Sin array de preguntas');
  const questions=Array.from({length:group.length},(_,i)=>parsed.questions[i]||null);
  // Auditor independiente: una llamada por lote, no múltiples auditores
  // superpuestos. No audita dificultad subjetiva, sólo respuesta y evidencia.
  const blind=questions.flatMap((q,i)=>{
    if(resetShape136(q))return [];
    if((esTemaSolares2026(group[i])||esTemaEolicos2026(group[i])) &&
       /seg[uú]n la tabla|qu[eé] combinaci[oó]n.*figura/i.test(q.stem))return [];
    return [{index:i,tema:group[i].topic_name,
      epigrafe:group[i].section,concepto:group[i].concept,
      fragmento:String(group[i].source_evidence||'').slice(0,3500),
      stem:q.stem,options:q.options}];
  });
  if(!blind.length)return questions.map(()=>null);
  // El texto de auditoría es IDÉNTICO al SERVER 81 para todas las materias
  // sin comparadores. El refuerzo contextual solo afecta a solares/eólicos
  // Muy alta y no añade otra llamada de validación.
  const baselineAuditPrompt82=`Audita un test de oposición comparando EXCLUSIVAMENTE los datos del PDF entregados por fila, incluido su EPÍGRAFE como asignación expresa de parque; sin memoria externa, sin copiar hechos de modelos de estilo. answer=0..3 SOLO cuando existe una única respuesta sustentada por la FILA evaluada. Antes de elegir, contrasta LAS CUATRO alternativas con el enunciado COMPLETO y con la evidencia de esta fila. Para detectar una segunda respuesta válida, examina también las OTRAS FILAS DEL MISMO TEMA presentes en este lote como posibles contraejemplos, incluso si corresponden a otro índice; NO las utilices para justificar la respuesta principal ni mezcles objetivos. Si otro registro demuestra explícitamente que una segunda opción satisface TODAS las condiciones del enunciado, answer=-1, aunque la opción prevista sea más cercana, frecuente, concentrada o encaje mejor. No rechaces por simples semejanzas parciales: exige coincidencia documental con el enunciado completo. Si dos opciones son iguales/equivalentes, o dos satisfacen el mismo enunciado, o la respuesta exige deducir un municipio o parque ausente, answer=-1. quote: transcribe un fragmento LITERAL del campo fragmento (18+ caracteres) que justifique la respuesta; puedes usar el EPÍGRAFE para validar la asignación del parque, pero no como sustituto de quote. Si falta evidencia, answer=-1. Fila index conserva índice original. FILAS: ${JSON.stringify(blind)}`;
  const auditPrompt82=comparisons.length?baselineAuditPrompt82.replace(
    ' quote: transcribe',
    ' Si los COMPARADORES del mismo PDF demuestran que otra alternativa también satisface el enunciado, answer=-1. Un comparador NO sustituye la evidencia de la fila auditada. quote: transcribe'
  ).replace(' FILAS: ',` COMPARADORES POR SLOT: ${JSON.stringify(comparisons)}. FILAS: `)
    :baselineAuditPrompt82;
  const auditing=await resetGeminiCall139(ai,'auditar',{model:R136_AUDITOR,
    contents:auditPrompt82,
    config:{httpOptions:{timeout:R136_TIMEOUT_MS},responseMimeType:'application/json',
      responseJsonSchema:fixedCountSchema(RESET_AUDIT_SCHEMA_136,'results',blind.length)}});
  const audits=JSON.parse(String(auditing?.text||'{}'))?.results;
  if(!Array.isArray(audits))throw Error('Auditoría sin resultados');
  return questions.map((q,i)=>{
    const a=audits.find(x=>x.index===i);
    if(resetShape136(q)||!a||a.answer!==q.correctIndex ||
      !resetQuote136(a.quote,group[i].source_evidence))return null;
    const evidence=String(a.quote);
    return {...q,sourceEvidence:evidence,sourcePage:group[i].source_page??null,
      manualPage:group[i].manual_page??null,
      questionFamily:group[i].questionFamily||'2024_TEXTO',difficulty,graphic:null};
  });
}
// SERVER 83 — barajado de PRESENTACIÓN ANTES de persistir la pregunta nueva.
// Conserva la respuesta literal y todas las alternativas ya auditadas contra PDF.
// Equilibra las letras contando las preguntas originales que no deben tocarse.
function resetBalanceNewAnswers83(questions){
  const counts=[0,0,0,0];
  const fresh=[];
  for(let i=0;i<questions.length;i++){
    const q=questions[i];
    const mutable=q && q.reused!==true && q.ankiDirect!==true &&
      q.ankiOriginalBank!==true && q.ankiQuestionId==null &&
      Array.isArray(q.options) && q.options.length===4;
    if(mutable)fresh.push(i);
    else if(q && Number.isInteger(q.correctIndex) && q.correctIndex>=0 && q.correctIndex<4)
      counts[q.correctIndex]++;
  }
  // El orden de tratamiento y los empates son aleatorios: no introducir
  // un patrón A-B-C-D visible entre exámenes ni entre preguntas contiguas.
  const shuffledIndexes=[...fresh];
  for(let i=shuffledIndexes.length-1;i>0;i--){
    const j=Math.floor(Math.random()*(i+1));
    [shuffledIndexes[i],shuffledIndexes[j]]=[shuffledIndexes[j],shuffledIndexes[i]];
  }
  const result=[...questions];
  for(const index of shuffledIndexes){
    const q=questions[index];
    const right=q.options[q.correctIndex];
    const distractors=q.options.filter((_,i)=>i!==q.correctIndex);
    if(distractors.length!==3 || right===undefined)
      throw Error('No se pueden redistribuir las opciones de esta pregunta.');
    for(let i=distractors.length-1;i>0;i--){
      const j=Math.floor(Math.random()*(i+1));
      [distractors[i],distractors[j]]=[distractors[j],distractors[i]];
    }
    const least=Math.min(...counts);
    const candidateIndexes=[0,1,2,3].filter(i=>counts[i]===least);
    const target=candidateIndexes[Math.floor(Math.random()*candidateIndexes.length)];
    counts[target]++;
    const options=new Array(4),other=[...distractors];
    options[target]=right;
    for(let i=0;i<4;i++)if(i!==target)options[i]=other.shift();
    if(options[target]!==right ||
      [...options].sort().join('\u0000')!==[...q.options].sort().join('\u0000'))
      throw Error('Las opciones no se han conservado en el barajado.');
    result[index]={...q,options,correctIndex:target};
  }
  return result;
}

async function resetBank136(allowedTopicIds,count,difficulty){
  // Tests >40: el banco dicta QUÉ conocimientos existen, no una selección
  // previa de cobertura que pudiera no tener preguntas almacenadas.
  const result=await db.query(`SELECT qb.*,ci.topic_id,ci.section,ci.concept,
    ci.item_type,ci.evaluation_type,ci.exam_relevant,ci.source_evidence AS ci_evidence,
    ci.source_page AS ci_source_page,ci.manual_page AS ci_manual_page,
    t.name AS topic_name,t.block AS topic_block,
    aq.validation_status AS anki_validation_status,
    aq.direct_use_eligible AS anki_direct_eligible
    FROM question_bank qb JOIN coverage_items ci ON ci.id=qb.coverage_item_id
    JOIN topics t ON t.id=ci.topic_id
    LEFT JOIN legislation_anki_questions aq ON aq.id=qb.source_anki_question_id
    WHERE qb.active=TRUE AND (ci.exam_relevant=TRUE OR ci.item_type='anki_independent')
      AND qb.validation_version>=6
      AND qb.validation_version NOT IN (107,113)
      AND ($1::int[] IS NULL OR ci.topic_id=ANY($1::int[]))
      AND qb.difficulty=$2
    ORDER BY qb.times_shown ASC,qb.last_shown_at ASC NULLS FIRST,qb.id DESC
    LIMIT 1500`,[allowedTopicIds,difficulty]);
  const usedQuestions=new Set(),usedCoverage=new Set(),pairs=[];
  for(const r of result.rows){
    const stem=R136_NORM(r.stem),ci=Number(r.correct_index),id=Number(r.coverage_item_id);
    const ankiOriginalBank=Boolean(r.source_anki_question_id &&
      r.anki_validation_status==='validated' && r.anki_direct_eligible===true);
    if(usedQuestions.has(stem)||usedCoverage.has(id)||
      resetShape136({stem:r.stem,options:r.options,correctIndex:ci,ankiOriginalBank}))continue;
    usedQuestions.add(stem);usedCoverage.add(id);
    const target={id,topic_id:Number(r.topic_id),topic_name:r.topic_name,
      topic_block:r.topic_block,section:r.section,concept:r.concept,
      item_type:r.item_type,evaluation_type:r.evaluation_type,
      exam_relevant:r.exam_relevant,source_evidence:r.ci_evidence,
      source_page:r.ci_source_page,manual_page:r.ci_manual_page};
    const question={stem:r.stem,options:r.options,correctIndex:ci,
      sourceEvidence:r.source_evidence||'',sourcePage:r.source_page??null,
      manualPage:r.manual_page??null,explanation:r.explanation||'',
      questionFamily:r.question_family,difficulty:r.difficulty,
      graphic:r.graphic||null,reused:true,questionId:Number(r.id),
      ankiOriginalBank};
    pairs.push({question,target});if(pairs.length>=count)break;
  }
  if(pairs.length!==count)throw Error(`Banco insuficiente para ${count} preguntas ${difficulty}; hay ${pairs.length} aptas en esta selección.`);
  return pairs;
}
function publicManualPageQuestions(questions){
  return (questions||[]).map(q=>({...q,sourcePage:null,
    manualPage:q.manualPage??null}));
}
app.post('/api/generate',async(req,res)=>{
  const started=Date.now();const supplied=req.body?.runId;
  const runId=normalizeGenerationRunId(supplied);const signature=runId?generationRunSignature(req.body):null;
  let resume136=null,draft136=null;
  // Solo el propietario del runId puede registrar su fracaso.
  // Nunca sobrescribir un test en curso perteneciente a otra petición.
  let ownsRun140=false;
  try{
    if(supplied!=null&&!runId)return res.status(400).json({ok:false,error:'Identificador de test inválido.'});
    if(runId){const prior=await startGenerationRun(runId,signature);
      if(!prior)ownsRun140=true;
      if(prior){if(prior.signature!==signature)return res.status(409).json({ok:false,error:'Configuración de runId distinta.'});
        if(prior.status==='completed')return res.json({ok:true,sessionId:prior.sessionId,
          questions:publicManualPageQuestions(prior.questions),coverage:prior.coverage});
        if(prior.status==='failed') {
          // Una sola pestaña debe reclamar el reintento. El segundo POST
          // obtiene «pending» y NO duplica llamadas a Gemini.
          const claimed=await claimFailedGenerationRun140(runId,signature);
          if(!claimed)return res.json({ok:true,pending:true,runId});
          ownsRun140=true;
          // Guardar la referencia ANTES del preflight: un error temprano
          // no puede borrar las preguntas válidas del intento anterior.
          if(prior.draft?.targets?.length && Array.isArray(prior.draft.questions)){
            resume136=prior.draft;
            draft136=prior.draft;
          }
        } else return res.json({ok:true,pending:true,runId});
      }
    }
    if(!STORE)throw Error('Primero indexa el PDF del temario.');
    const count=Number(req.body?.count)||10;
    if(!Number.isInteger(count) || !(count===5||count===10||count===20||count===30||count===40||
      (count>40&&count<=120)))throw Error('Número de preguntas no admitido.');
    const difficulty=req.body?.difficulty==='muy alta'?'muy alta':'alta';
    const mode=['literal','mixto','calculos'].includes(req.body?.mode)?req.body.mode:'mixto';
    const testType=req.body?.testType==='failed'?'failed':'normal';
    const examMode=req.body?.examMode==='simulation'?'simulation':'adaptive';
    const topicIds=await resolveGenerationTopicScope(req.body);
    let targets=resume136?.targets || (count>40?[]:(testType==='failed'
      ?await getFailedCoverageTargets(count,topicIds)
      :await getCoverageTargetsForGeneration(count,{models:{generateContent:(...args)=>
        aiClient().models.generateContent(...args)}},topicIds,examMode)));
    if(Array.isArray(topicIds) && topicIds.length===1 &&
       targets.some(t=>Number(t.topic_id)!==Number(topicIds[0])))
      throw Error('Los conocimientos obtenidos no corresponden al tema seleccionado. No se genera el test.');
    if(count<=40&&!targets.length)throw Error('No hay conocimientos disponibles en ese ámbito.');
    if(count<=40&&targets.length!==count && testType==='normal')throw Error(`Cobertura insuficiente: ${targets.length}/${count}.`);
    const direct=new Map();
    if(!resume136&&testType==='normal'&&difficulty==='alta'&&count<=40){
      const quota=await applyLegislationAnkiQuota84(targets,topicIds,'alta');
      if(quota){targets.splice(0,targets.length,...quota.targets);
        for(const [i,q] of quota.direct)direct.set(i,q);
      }
    }
    // Preflight SIN GEMINI: cuando un objetivo no trae fragmento del PDF,
    // sustituirlo por otro del MISMO tema que sí lo trae. No altera cobertura
    // ni el historial; evita pagar lotes destinados a rechazo automático.
    if(!resume136&&testType==='normal'&&count<=40){
      const missing=targets.map((t,i)=>({t,i})).filter(({t,i})=>
        !direct.has(i)&&String(t.source_evidence||'').trim().length<55&&
        !geographyTableRecord135(t));
      if(missing.length){
        const alternates=await getAdaptiveCoverageCandidates(
          Math.max(count*50,1000),topicIds,examMode);
        const occupied=new Set(targets.map(t=>Number(t.id)));
        for(const {t,i} of missing){
          const substitute=alternates.find(a=>Number(a.topic_id)===Number(t.topic_id)&&
            !occupied.has(Number(a.id))&&
            (String(a.source_evidence||'').trim().length>=55||geographyTableRecord135(a)));
          if(substitute){targets[i]=substitute;occupied.add(Number(substitute.id));}
        }
      }
    }
    let questions=resume136?.questions?.length===targets.length
      ?Array.from(resume136.questions):Array.from({length:targets.length},()=>null);
    for(const [i,q] of direct)questions[i]=q;
    draft136={targets,questions};
    if(count>40){
      const pairs=await resetBank136(topicIds,count,difficulty);
      targets=pairs.map(x=>x.target);questions=pairs.map(x=>x.question);
    }else{
      // Las preguntas son nuevas salvo la cuota de Anki ORIGINAL de Alta.
      const todo=targets.map((t,index)=>({t,index})).filter(x=>!questions[x.index]);
      const usedLocalStems=new Set(questions.filter(Boolean).map(q=>R136_NORM(q.stem)));
      for(const {t,index} of todo){
        for(const shift of [0,1]){
          const local=resetGeoTableQuestion136(t,index+shift,difficulty);
          if(local&&!usedLocalStems.has(R136_NORM(local.stem))){
            questions[index]=local;usedLocalStems.add(R136_NORM(local.stem));break;
          }
        }
      }
      let remaining=todo.filter(x=>!questions[x.index]);
      // SERVER 82: carga acotada de fichas comparables, una sola consulta.
      // No cambia objetivos, sesiones ni la política de la selección.
      const comparisonPool82=await resetGeoComparePool82(targets,difficulty);
      // Lotes dinámicos: 10 como máximo, o menos si el PDF es extenso.
      // Cada pregunta conserva su objetivo individual aunque cambie el tema.
      const groups=resetGroups139(remaining);
      const ai=groups.length?aiClient():null;
      const run=await resetPool136(groups,async group=>{
        const items=group.map(x=>x.t);
        return resetGenerateGroup136(ai,items,difficulty,mode,comparisonPool82);
      });
      const failures=[];
      for(let i=0;i<groups.length;i++){
        if(!run[i].ok){failures.push({batch:i,reason:run[i].error});continue;}
        for(let j=0;j<groups[i].length;j++){
          const slot=groups[i][j].index,q=run[i].value[j];
          if(q)questions[slot]=q;else failures.push({slot,reason:'no verificable con PDF'});
        }
      }
      // Depuración determinista ANTES del rescate: una pregunta con enunciado
      // idéntico a otra no puede destruir un examen completo al persistir.
      // Conservamos la primera pregunta verificada, sin inventar alternativas.
      const acceptedStems=new Set();
      for(let i=0;i<questions.length;i++){
        if(!questions[i])continue;
        const key=R136_NORM(questions[i].stem);
        if(acceptedStems.has(key)){
          questions[i]=null;
          failures.push({slot:i,reason:'enunciado duplicado entre lotes'});
        }else acceptedStems.add(key);
      }
      draft136={targets,questions};
      // Un solo rescate. Antes se repetía el MISMO objetivo que ya había
      // fallado, favoreciendo bucles. En modo normal intentamos un objetivo
      // alternativo del MISMO tema; no cambiamos objetivos en Solo falladas.
      let holes=targets.map((t,index)=>({t,index})).filter(x=>!questions[x.index]);
      if(holes.length){
        const upstreamExhausted=failures.some(x=>/\b429\b|RESOURCE_EXHAUSTED|quota|\b503\b|DEADLINE_EXCEEDED|budget|high demand/i.test(x.reason||''));
        if(upstreamExhausted){
          console.warn('RESET_136_SIN_REINTENTO_POR_PROVEEDOR:',JSON.stringify({
            valid:questions.filter(Boolean).length,missing:holes.length}));
        } else {
          if(testType==='normal'){
            const alternatives=await getAdaptiveCoverageCandidates(
              Math.max(1000,count*50),topicIds,examMode);
            const occupied=new Set(targets.map(t=>Number(t.id)));
            for(const slot of holes){
              const other=alternatives.find(candidate=>
                Number(candidate.topic_id)===Number(slot.t.topic_id) &&
                !occupied.has(Number(candidate.id)) &&
                (String(candidate.source_evidence||'').trim().length>=55 ||
                  geographyTableRecord135(candidate)));
              if(!other)continue;
              targets[slot.index]=other;
              occupied.add(Number(other.id));
              slot.t=other;
              // Si es un hecho territorial comprobado, NO llamar a Gemini.
              const local=resetGeoTableQuestion136(other,slot.index,difficulty);
              if(local && !acceptedStems.has(R136_NORM(local.stem))){
                questions[slot.index]=local;
                acceptedStems.add(R136_NORM(local.stem));
              }
            }
          }
          holes=holes.filter(x=>!questions[x.index]);
          // Igual límite de contexto en el único rescate autorizado.
          const repairGroups=resetGroups139(holes);
          if(repairGroups.length){
            const repaired=await resetPool136(repairGroups,async group=>
              resetGenerateGroup136(ai,group.map(x=>x.t),difficulty,mode,comparisonPool82),2);
            repaired.forEach((result,g)=>{
              if(!result.ok){failures.push({batch:g,reason:result.error});return;}
              repairGroups[g].forEach((item,j)=>{
                const question=result.value[j];if(!question)return;
                const key=R136_NORM(question.stem);
                if(acceptedStems.has(key))return;
                questions[item.index]=question;acceptedStems.add(key);
              });
            });
          }
        }
      }
      draft136={targets,questions};
      // Nunca considerar válidas respuestas cuyo origen no ha sido verificado.
      if(questions.some(q=>!q)){
        const valid=questions.filter(Boolean).length;
        console.warn('RESET_136_INCOMPLETO:',JSON.stringify({count,valid,
          failed:count-valid,failures:failures.slice(0,8),ms:Date.now()-started}));
        throw Error(`Generadas y verificadas ${valid} de ${count} preguntas; ${count-valid} no superaron verificación PDF. No se guardó un examen incompleto.`);
      }
    }
    if(questions.some((q,i)=>!q||resetShape136(q))){
      throw Error('Pregunta malformada detectada antes de guardar.');
    }
    const unique=new Set(questions.map(q=>R136_NORM(q.stem)));
    if(unique.size!==questions.length)throw Error('Preguntas duplicadas; no se guardó test.');
    // SERVER 83: equilibrado mecánico de letras. NUNCA confiar la posición
    // correcta a Gemini. Solo se modifican preguntas NUEVAS de Gemini;
    // tarjetas Anki ORIGINALES y preguntas reutilizadas conservan su orden.
    // Cada alternativa conserva su texto; el índice correcto se remapea.
    questions=resetBalanceNewAnswers83(questions);
    if(questions.some(q=>resetShape136(q)))
      throw Error('Redistribución de opciones inválida: no se guardó el test.');
    const persisted=await persistGeneratedTest({questions,targets,requestedCount:count,
      difficulty,mode,testType,runId,runSignature:signature});
    console.log('RESET_136_COMPLETO:',JSON.stringify({count,sessionId:persisted.sessionId,
      ms:Date.now()-started,local:questions.filter(q=>q.resetLocal136).length}));
    return res.json({ok:true,sessionId:persisted.sessionId,questions:publicManualPageQuestions(persisted.questions),
      coverage:{targeted:targets.length,markedWorked:0}});
  }catch(e){
    if(runId&&ownsRun140){try{await writeGenerationRun(runId,{status:'failed',signature,
      error:String(e?.message||e),draft:draft136?.questions?.some(Boolean)?draft136:null});}
      catch(x){console.error('RESET_136_ESTADO_ERROR:',String(x?.message||x));}}
    console.error('RESET_136_FALLO:',String(e?.message||e));
    return res.status(e?.status||500).json({ok:false,error:String(e?.message||e),
      runId:runId||null,resumable:Boolean(runId&&draft136?.questions?.some(Boolean)),
      validQuestions:draft136?.questions?.filter(Boolean).length||0});
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
  questions:publicManualPageQuestions(parsed.questions)
});

  }catch(e){
    console.error("ERROR GENERATE STATUS:",e);

    res.status(500).json({
      ok:false,
      error:e?.message || String(e)
    });
  }
});
app.get("/api/graphics/analyze-pending", async (req,res)=>{
  try{
    const requestedLimit = Number(req.query?.limit ?? 10);

    const limit = Number.isInteger(requestedLimit)
      ? Math.min(Math.max(requestedLimit,1),10)
      : 10;

    const result =
      await analyzePendingGraphicSources({ limit });

    res.json({
      ok:true,
      ...result
    });
  }catch(error){
    console.error(
      "[graphics] Error en /api/graphics/analyze-pending:",
      error
    );

    res.status(500).json({
      ok:false,
      error:error?.message || String(error)
    });
  }
});

app.get("/api/graphics/reanalyze-sanitization", async (req,res)=>{
  try{
    const requestedLimit = Number(req.query?.limit ?? 10);

    const limit = Number.isInteger(requestedLimit)
      ? Math.min(Math.max(requestedLimit,1),10)
      : 10;

    const retryErrors =
      String(req.query?.retryErrors ?? "")
        .toLowerCase() === "true";

    const result =
      await reanalyzeGraphicSourcesForSanitization({
        limit,
        retryErrors
      });

    res.json({
      ok:true,
      ...result
    });
  }catch(error){
    console.error(
      "[graphics] Error en /api/graphics/reanalyze-sanitization:",
      error
    );

    res.status(500).json({
      ok:false,
      error:error?.message || String(error)
    });
  }
});


app.get("/api/graphics/inspect-latest", async (req,res)=>{
  try{
    const result = await db.query(
      `SELECT
        id,
        source_id,
        topic_folder,
        source_file,
        public_url,
        asset_index,
        asset_type,
        concept,
        description,
        source_evidence,
        crop_x,
        crop_y,
        crop_width,
        crop_height,
        mask_regions,
        sanitization_version,
        is_official_reference,
        is_usable,
        analysis_status,
        times_asked,
        last_asked_at,
        updated_at
      FROM graphic_assets
      WHERE analysis_status IN ('analyzed','rejected')
      ORDER BY updated_at DESC
      LIMIT 1`
    );

    if(!result.rows.length){
      return res.status(404).json({
        ok:false,
        error:"No hay assets gráficos analizados."
      });
    }

    res.json({
      ok:true,
      asset:result.rows[0]
    });
  }catch(error){
    console.error(
      "[graphics] Error en /api/graphics/inspect-latest:",
      error
    );

    res.status(500).json({
      ok:false,
      error:error?.message || String(error)
    });
  }
});
async function startServer(){
  console.log("STARTUP 1/4: initDatabase");
  await initDatabase();
  console.log("STARTUP 1/4 OK");
  // SERVER 80: desactivar SOLO preguntas locales antiguas de tablas de
  // solares/eólicos. Sus territorios estaban desactualizados. No borra tests,
  // respuestas, estadísticas, cobertura ni preguntas de otros temas.
  try{
    const oldGeo=await db.query(`UPDATE question_bank qb
       SET active=FALSE,updated_at=NOW()
       FROM coverage_items ci JOIN topics t ON t.id=ci.topic_id
       WHERE qb.coverage_item_id=ci.id AND qb.active=TRUE
         AND t.block='geografia'
         AND t.name ~* '^TEMA[[:space:]]*(23|24)[^0-9]'
         AND qb.stem ~* '^seg[uú]n la tabla del temario'`);
    console.log('SERVER 80: preguntas obsoletas desactivadas:',oldGeo.rowCount);
  }catch(error){
    console.warn('SERVER 80: no se pudieron desactivar preguntas antiguas:',
      String(error?.message||error));
  }

  const cleanup83=await db.query(`
    UPDATE coverage_items SET worked=FALSE
    WHERE worked=TRUE AND COALESCE(times_asked,0)=0
  `);
  console.log("COBERTURA 83: elementos mostrados pero no respondidos reparados:",cleanup83.rowCount);
  // 93K: la sincronización masiva Anki nunca debe bloquear
  // la apertura del puerto que Render utiliza para su health check.
  console.log("STARTUP 2/4: syncGraphicAssets");
  await syncGraphicAssets();
  console.log("STARTUP 2/4 OK");

  console.log("STARTUP 3/4: loadStore");
  await loadStore();
  console.log("STARTUP 3/4 OK");

  console.log("STARTUP 4/4: loadExamStyleStore");
  await loadExamStyleStore();
  console.log("STARTUP 4/4 OK");

  app.listen(process.env.PORT || 3000, ()=>{
    console.log("Test Bombero V2 listo");
    console.log("TEMARIO STORE recuperado:", STORE || "ninguno");
    console.log(
      "EXAM STYLE STORE recuperado:",
      EXAM_STYLE_STORE || "ninguno"
    );
    console.log("STARTUP ANKI: sincronización post-arranque");
    // Conexión activa antes de comenzar el trabajo pesado. No se
    // modifica la base de preguntas ni su historial de validación.
    syncLegislationAnkiQuestions()
      .then(()=>console.log("STARTUP ANKI OK"))
      .catch(error=>console.error(
        "ERROR SINCRONIZANDO ANKI (servidor operativo):",error
      ));
  });
}

startServer().catch(e=>{
  console.error("ERROR INICIANDO SERVIDOR:", e);
  process.exit(1);
});
