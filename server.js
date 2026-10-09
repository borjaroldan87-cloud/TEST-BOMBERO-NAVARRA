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

const GRAPHIC_GROUP_EXCEPTIONS = Object.freeze({
  nrbq: ["correspondencias-pictogramas"],
  vehiculos: ["ciclo-motor-2-tiempos", "ciclo-motor-4-tiempos"]
});

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
    UPDATE topics
    SET file_search_indexed = TRUE
    WHERE total_items > 0
      AND file_search_indexed = FALSE
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
async function getGraphicAssetForGeneration({
  topicFolder = null,
  coverageItem = null
} = {}){
  const params = [];
  const conditions = [
  "is_usable = TRUE",
  "analysis_status = 'analyzed'",
      "sanitization_version >= 2",
  "is_official_reference = FALSE"
];

  if(topicFolder){
    params.push(topicFolder);
    conditions.push(`topic_folder = $${params.length}`);
  }
const coverageText = [
  coverageItem?.section,
  coverageItem?.concept,
  coverageItem?.source_evidence
]
  .filter(Boolean)
  .join(" ")
  .trim();

if(!coverageText){
  return null;
}

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
      is_official_reference,
      times_asked,
      last_asked_at
    FROM graphic_assets
    WHERE ${conditions.join(" AND ")}
    ORDER BY
      times_asked ASC,
      last_asked_at ASC NULLS FIRST,
      id ASC
    LIMIT 40`,
  params
);

if(!result.rows.length){
  return null;
}
const normalizeGraphicText = value =>
  String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9ñ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const stopWords = new Set([
  "para","como","con","sin","por","del","las","los","una","uno","unos","unas",
  "que","sus","este","esta","estos","estas","desde","hasta","sobre","entre",
  "segun","mediante","tipo","tipos","forma","formas","caso","casos","parte",
  "partes","elemento","elementos","sistema","sistemas","procedimiento",
  "procedimientos","aplicacion","aplicaciones","imagen","figura","esquema",
  "ilustracion","representacion"
]);

const tokenSet = value =>
  new Set(
    normalizeGraphicText(value)
      .split(/\s+/)
      .filter(word => word.length >= 4 && !stopWords.has(word))
  );

const intersection = (a, b) =>
  [...a].filter(token => b.has(token));

const coverageCore = [
  coverageItem?.concept,
  coverageItem?.section
]
  .filter(Boolean)
  .join(" ");

const coverageCoreTokens = tokenSet(coverageCore);

if (!coverageCoreTokens.size) {
  return null;
}

const compatibleAssets = [];

for (const asset of result.rows) {
  /*
  REGLA CLAVE:
  La compatibilidad se decide primero usando el CONCEPTO del asset.
  description y source_evidence NO pueden convertir por sí solos
  una imagen incompatible en compatible.
  */
  const assetConcept = normalizeGraphicText(asset.concept);
  const assetConceptTokens = tokenSet(asset.concept);

  if (!assetConcept || !assetConceptTokens.size) {
    continue;
  }

  const sharedCore = intersection(
    assetConceptTokens,
    coverageCoreTokens
  );

  const normalizedCoverageCore =
    normalizeGraphicText(coverageCore);

  const exactConceptRelation =
    normalizedCoverageCore.includes(assetConcept) ||
    assetConcept.includes(normalizedCoverageCore);

  /*
  Para conceptos de varias palabras exigimos coincidencia conceptual
  suficiente. Una palabra aislada como "tension" o "corte" no basta.
  */
  const conceptCoverageRatio =
    sharedCore.length / assetConceptTokens.size;

  let conceptCompatible = false;

  if (exactConceptRelation) {
    conceptCompatible = true;
  } else if (
    assetConceptTokens.size >= 2 &&
    sharedCore.length >= 2 &&
    conceptCoverageRatio >= 0.5
  ) {
    conceptCompatible = true;
  } else if (
    assetConceptTokens.size === 1 &&
    sharedCore.length === 1
  ) {
    /*
    Un concepto gráfico de una sola palabra solo se acepta
    si esa palabra aparece en el CONCEPTO curricular,
    no únicamente en section/source_evidence.
    */
    const coverageConceptTokens =
      tokenSet(coverageItem?.concept);

    const onlyToken = [...assetConceptTokens][0];

    conceptCompatible =
      coverageConceptTokens.has(onlyToken);
  }

  if (!conceptCompatible) {
    continue;
  }

  /*
  Una vez demostrada la compatibilidad conceptual,
  description/source_evidence solo sirven para desempatar.
  Nunca para habilitar la pareja.
  */
  const supportingTokens = tokenSet([
    asset.description,
    asset.source_evidence
  ].filter(Boolean).join(" "));

  const coverageEvidenceTokens =
    tokenSet(coverageItem?.source_evidence);

  const supportMatches = intersection(
    supportingTokens,
    coverageEvidenceTokens
  ).length;

  const score =
    (exactConceptRelation ? 1000 : 0) +
    (sharedCore.length * 100) +
    Math.round(conceptCoverageRatio * 100) +
    supportMatches;

  compatibleAssets.push({
    asset,
    score,
    sharedCore
  });
}

compatibleAssets.sort((a, b) => {
  if (b.score !== a.score) {
    return b.score - a.score;
  }

  if (a.asset.times_asked !== b.asset.times_asked) {
    return a.asset.times_asked - b.asset.times_asked;
  }

  return Number(a.asset.id) - Number(b.asset.id);
});

const selectedAsset =
  compatibleAssets.length
    ? compatibleAssets[0].asset
    : null;

console.log(
  "GRAPHIC_MATCH_DEBUG",
  JSON.stringify({
    topicFolder,
    coverageId: coverageItem?.id ?? null,
    coverageConcept: coverageItem?.concept || null,
    candidates: result.rows.length,
    compatibleCandidates: compatibleAssets.length,
    selectedAssetId: selectedAsset?.id ?? null,
    selectedAssetConcept: selectedAsset?.concept ?? null,
    sharedCore: compatibleAssets[0]?.sharedCore ?? []
  })
);

return selectedAsset;

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

  const parsed=
    JSON.parse(
      fs.readFileSync(indexPath,"utf8")
    );

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
    `,
    [
      JSON.stringify(rows)
    ]
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

async function saveCoverageItems(topicId, items){
  const client=await db.connect();

  try{
    await client.query("BEGIN");

    const stateResult=await client.query(
      `SELECT
         EXISTS (
           SELECT 1
           FROM coverage_items
           WHERE topic_id = $1
             AND (
               worked = TRUE OR
               times_asked > 0 OR
               times_correct > 0 OR
               times_wrong > 0 OR
               times_blank > 0
             )
         ) AS has_history,
         EXISTS (
           SELECT 1
           FROM question_bank qb
           JOIN coverage_items ci
             ON ci.id = qb.coverage_item_id
           WHERE ci.topic_id = $1
         ) AS has_questions,
         EXISTS (
           SELECT 1
           FROM coverage_items
           WHERE topic_id = $1
         ) AS has_existing`,
      [topicId]
    );

    const state=stateResult.rows[0];

    if(
      state?.has_existing === true &&
      (
        state?.has_history === true ||
        state?.has_questions === true
      )
    ){
      throw new Error(
        "COVERAGE: no se puede reemplazar automáticamente un tema que ya tiene historial de estudio o preguntas generadas."
      );
    }

    if(state?.has_existing === true){
      await client.query(
        `DELETE FROM coverage_items
         WHERE topic_id = $1`,
        [topicId]
      );
    }

    for(const item of items){
      await client.query(
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

    await client.query(
      `UPDATE topics
       SET
         total_items = (
           SELECT COUNT(*)
           FROM coverage_items
           WHERE topic_id = $1
         ),
         worked_items = 0
       WHERE id = $1`,
      [topicId]
    );

    await client.query("COMMIT");

  }catch(error){
    await client.query("ROLLBACK");
    throw error;

  }finally{
    client.release();
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

Conserva de forma vinculada y sin mezclar filas:
- nombre del parque solar;
- promotor;
- municipio o municipios asociados;
- parque de bomberos asociado;
- potencia;
- año de puesta en servicio.

La relación PARQUE SOLAR -> MUNICIPIO -> PARQUE DE BOMBEROS
debe quedar representada expresamente.

Promotor, potencia y año deben conservarse para mantener
íntegra la información de la fila, pero NO deben convertirse
por sí mismos en objetivos de pregunta automática.

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
async function ingest(filePath, displayName){
  const ai=aiClient(); const store=await ensureStore();
  let op=await ai.fileSearchStores.uploadToFileSearchStore({
    file:filePath, fileSearchStoreName:store,
    config:{displayName,mimeType:"application/pdf"}
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

    const topicOrder=
      Number.isInteger(rawOrder) &&
      rawOrder > 0
        ? rawOrder
        : null;

    let topic=
      await getOrCreateTopic(
        topicName,
        req.file.originalname
      );

    const metadataResult=
      await db.query(
        `UPDATE topics
         SET
           source_file = $2,
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
      difficulty:{type:"string",enum:["alta","muy alta"]},
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
    assetId:{
      type:"integer",
      minimum:1
    },
    sourceId:{
      type:"string"
    },
    publicUrl:{
      type:"string"
    },
    assetType:{
      type:"string",
      enum:["individual","group"]
    },
    concept:{
      type:"string"
    },
    description:{
      type:"string"
    },
    crop:{
      type:["object","null"],
      properties:{
        x:{type:"number",minimum:0,maximum:1},
        y:{type:"number",minimum:0,maximum:1},
        width:{type:"number",minimum:0,maximum:1},
        height:{type:"number",minimum:0,maximum:1}
      },
      required:[
        "x",
        "y",
        "width",
        "height"
      ]
    }
  },
  required:[
    "assetId",
    "sourceId",
    "publicUrl",
    "assetType",
    "concept",
    "description",
    "crop"
  ]
},






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
          distractorsValid:{type:"boolean"},
distractorIssues:{
  type:"array",
  items:{type:"string"}
},
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
  "distractorsValid",
  "distractorIssues",
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
Dificultad base mínima: ${difficulty}.
La dificultad específica indicada para cada objetivo de cobertura tiene prioridad sobre esta dificultad base.
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
REPRESENTACIÓN MATEMÁTICA UNIFICADA (APLICABLE A TODOS LOS TEMAS):

Los campos stem, options y explanation aceptan prosa normal junto con
expresiones de notación matemática LaTeX, delimitadas SIEMPRE por
\\( ... \\) para matemáticas en línea y \\[ ... \\] para fórmulas centradas.
Usa únicamente comandos matemáticos estándar compatibles con KaTeX.
No uses HTML, imágenes, MathML, Markdown matemático, delimitadores de dólares,
ni la palabra "Sumatorio" dentro de una fórmula. El signo de sumatorio es \\sum.

FORMATO OBLIGATORIO Y EJEMPLOS:
- Fracción: \\(\\frac{a+b}{c}\\).
- Suma de términos: \\(\\sum_{i=1}^{n} a_i\\).
- Fórmula con varios factores: \\[Q_s=\\frac{\\sum_{i=1}^{n}q_i G_i C_i}{A}\\,R\\]
- Radicales: \\(\\sqrt{x^2+y^2}\\).
- Subíndices: \\(P_1\\), \\(Q_s\\), \\(C_i\\).
- Potencias: \\(v^2\\), \\(10^{-3}\\), \\(m^3\\).
- Índices y límites: \\(\\sum_{i=1}^{n}\\), \\(\\frac{dP}{dt}\\).
- Griego y relaciones: \\(\\rho\\), \\(\\mu\\), \\(\\Delta\\), \\(\\leq\\), \\(\\geq\\), \\(\\approx\\).
- Unidades: \\(25\\,\\mathrm{kN/m^2}\\), \\(3\\,\\mathrm{m/s^2}\\).
- Relaciones, derivadas y conversiones: notación dimensional correcta, y
  \\(\\mathrm{kg/m^3}\\) cuando sea necesario expresar unidades.
- Química: fórmulas con subíndices mediante \\(\\mathrm{H_2O}\\) o
  \\(\\mathrm{CO_2}\\); reacciones con notación matemática inequívoca.
  Mantén símbolos y estados que aparezcan expresamente en la fuente.

Las fórmulas deben SER MATEMÁTICAMENTE EQUIVALENTES a las originales del PDF.
No inventes variables, factores, operaciones, unidades, límites, índices,
funciones ni constantes. Si la fuente no ofrece límites del sumatorio, no
inventes n o los índices: usa la suma sin límites \\(\\sum q_iG_iC_i\\).
Si la expresión original no distingue entre cocientes, factores o agrupaciones,
NO la cambies. Nunca alteres el sentido por mejorar la tipografía.

Escribe fórmulas completas, legibles y simétricas en las cuatro alternativas.
No uses "Sumatorio(...)" ni "sqrt(...)" ni una división textual larga con / cuando
pueda expresarse como una fracción clara. En cambio, deja como texto normal
magnitudes simples como 25 kN/m² si no forman parte de una fórmula.

El campo sourceEvidence DEBE mantener el dato recuperado del PDF fielmente,
sin transformarlo en ecuaciones distintas. sourcePage y manualPage sin cambios.

En validación, una opción cuyo LaTeX sea ilegible, incompleto, tenga llaves
sin cerrar, altere el orden de las operaciones o dé lugar a una equivalencia
matemática indeseada es INVÁLIDA y debe regenerarse. Los cuatro resultados
correctos y los distractores de cálculos deben verificarse numéricamente.

NIVEL ALTO PARA NORMATIVA TÉCNICA SIN ANKI:

- Exige aplicación real de límites, condiciones, tablas, clasificaciones,
  fórmulas y excepciones de los documentos aportados.
- En alternativas de CORRECTA, contrasta por separado LAS CUATRO contra la
  misma cláusula reglamentaria: solo UNA puede ser verdadera.
- En alternativas de INCORRECTA, las otras TRES deben ser afirmaciones verdaderas
  aunque no sean enumeraciones exhaustivas. No conviertas una condición parcial
  verdadera en falsa por el mero hecho de no citar los demás requisitos.
- Prohibidas opciones descartables por pura lógica, absolutos artificiales,
  inventos obvios, tecnicismos ajenos o términos como «automáticamente exento»
  salvo que el PDF los respalde y hagan falta realmente para la pregunta.
- Los cuatro distractores deben pertenecer al mismo eje conceptual y comparar
  diferencias pequeñas pero inequívocas: una cifra, condición, tipo, coeficiente,
  categoría, unidad, sujeto obligado, excepción o supuesto de aplicación.
- Si el reglamento incluye VARIOS valores simultáneamente ciertos (por ejemplo,
  anchura y gálibo de un vial), nunca conviertas dos valores ciertos en
  respuestas alternativas a una pregunta de opción única.
- No preguntes únicamente definiciones obvias cuando puedas evaluar el régimen
  de aplicación, una excepción, una condición combinada o un cálculo.
- Relee todas las opciones como un inspector adversarial antes de entregar.

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

- NO cites por defecto CEIS Guadalajara, manuales ni páginas.
- La forma visible del enunciado depende del BLOQUE del objetivo.
- Solo una política específica del bloque puede autorizar una referencia
  a manual o página.
- NUNCA utilices sourcePage como número visible en el enunciado.
- NUNCA calcules manualPage mediante offsets.
- NUNCA inventes una página, norma, artículo, título o referencia.

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
  presentes o plausibles dentro del mismo 
en la corrección.contexto técnico.

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

Cuando la familia asignada sea GRAFICA, la pregunta debe utilizar
EXCLUSIVAMENTE el asset gráfico real que haya sido proporcionado para ese
objetivo de generación.

Está PROHIBIDO generar, reconstruir o inventar un dibujo mediante primitivas,
SVG, líneas, círculos, rectángulos, nodos, flechas, paths u otras formas
geométricas creadas por el modelo.

El campo graphic NO describe un dibujo que debas construir.
El campo graphic identifica una imagen técnica REAL procedente de la biblioteca
gráfica previamente analizada.

REGLA FUNDAMENTAL:

La pregunta debe depender realmente de observar la imagen.

Antes de aceptar una pregunta GRAFICA realiza esta comprobación:

"Si elimino completamente la imagen y dejo únicamente stem + options,
¿puede resolverse esencialmente igual?"

Si la respuesta es SÍ:
NO es una pregunta GRAFICA válida y debe aplicarse el fallback correspondiente.

USO DEL ASSET:

Cuando se proporcione un asset gráfico para la pregunta:

- utiliza exclusivamente ese asset;
- interpreta únicamente lo que realmente muestra;
- no inventes elementos que no aparezcan en él;
- no alteres su geometría, disposición, componentes o relaciones;
- no sustituyas la imagen por una descripción textual equivalente;
- no describas en el enunciado aquello que precisamente debe interpretar
  visualmente el opositor;
- utiliza concept y description únicamente como metadatos para comprender
  qué representa el asset;
- respeta sourceEvidence y la información factual recuperada del temario
  como fuente de verdad para construir la pregunta.

El hecho de que un asset exista NO autoriza a introducir conocimiento externo.

Toda respuesta correcta, distractor, relación técnica, denominación,
procedimiento, cifra o conclusión evaluada debe continuar estando respaldada
por el temario recuperado.

CAMPO graphic:

Para una pregunta GRAFICA, graphic debe conservar EXACTAMENTE los datos del
asset proporcionado:

- assetId
- sourceId
- publicUrl
- assetType
- concept
- description
- crop

NO modifiques estos valores.
NO inventes otro assetId, sourceId, publicUrl ni crop.
NO construyas graphic desde cero.

Para cualquier pregunta que NO pertenezca a GRAFICA:
graphic debe ser null.

TIPOS DE PREGUNTA GRÁFICA:

Cuando el asset y la fuente factual lo permitan, puede evaluarse:

- identificación de una configuración;
- identificación de una parte o elemento por su posición;
- interpretación de cortes o geometrías;
- comparación de configuraciones visuales;
- posición relativa de elementos;
- recorridos de cuerdas, cables, conductos o flujos;
- sistemas de poleas o polipastos;
- conexiones eléctricas o hidráulicas;
- disposición de equipos;
- mecanismos;
- secuencias físicas representadas visualmente;
- interpretación de componentes;
- cálculos cuya resolución dependa de la configuración mostrada;
- cualquier otra característica técnica que requiera realmente observar
  el asset.

PROHIBICIONES:

NO conviertas el asset en una simple excusa visual para formular una pregunta
que podría resolverse sin verlo.

NO reveles en stem u options la información que el opositor debe obtener
observando la imagen.

NO utilices el nombre del archivo, sourceId, concept, description ni otros
metadatos internos como pista para responder.

NO preguntes por información visual que no pueda distinguirse con seguridad
en el asset.

NO completes partes ambiguas de la imagen mediante conocimiento externo.

NO generes mapas conceptuales, diagramas abstractos ni representaciones nuevas.

COHERENCIA OBLIGATORIA:

Antes de aceptar la pregunta comprueba:

1. El asset proporcionado es necesario para resolverla.
2. La pregunta evalúa conocimiento técnico del temario.
3. La información visual utilizada aparece realmente en el asset.
4. Existe exactamente una respuesta correcta.
5. Los distractores son plausibles y están respaldados o pueden demostrarse
   falsos mediante la fuente factual.
6. El enunciado no revela lo que debe interpretarse visualmente.
7. graphic conserva exactamente los datos del asset proporcionado.

Si cualquiera de estas condiciones falla:
NO generes una GRAFICA y aplica inmediatamente el fallback correspondiente.


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

o afirmaciones técnicamente próximas.- Dos preguntas de la misma familia obtenidas mediante fallback deben evaluar
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

En preguntas donde se busca la opción CORRECTA:

- los tres distractores deben ser inequívocamente falsos según la fuente,
  pero técnicamente plausibles y muy próximos a la respuesta correcta;
- su falsedad debe depender de un detalle discriminante del temario:
  cifra, unidad, término, condición, categoría, límite, relación, paso,
  secuencia, aplicación o excepción;
- evita distractores que puedan descartarse por sentido común, por una
  diferencia exagerada o por pertenecer a otro eje conceptual;
los TRES distractores deben obligar a discriminar conocimiento técnico
muy próximo a la correcta.

En preguntas donde se busca la opción INCORRECTA:

- exactamente tres alternativas deben ser verdaderas según la fuente;
- la única alternativa falsa debe ser la respuesta correcta;
- esa falsedad debe ser sutil y depender igualmente de un detalle técnico
  discriminante;
- las tres alternativas verdaderas deben ser suficientemente próximas y
  competitivas para que no pueda localizarse la falsa por descarte superficial.

En ambos casos:

- las cuatro alternativas deben mantener un nivel semejante de precisión,
  extensión, tecnicidad y naturalidad;
- la respuesta válida no debe destacar lingüística ni estructuralmente;
- resolver la pregunta debe exigir haber estudiado con precisión el temario,
  no detectar una opción absurda o una pista de redacción;
- "inequívocamente falsa" o "inequívocamente verdadera" significa que su
  condición queda determinada por la fuente, NO que resulte evidente para
  el opositor.
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

En dificultad alta, los TRES distractores deben obligar a discriminar
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

En dificultad alta, los TRES distractores deben ser
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
DIFICULTAD MUY ALTA:

Cuando un objetivo indique:
Dificultad adaptativa requerida: muy alta

aplica TODAS las reglas de dificultad alta y aumenta adicionalmente la
exigencia cognitiva, sin introducir información externa ni ambigüedad.

- Prioriza preguntas que obliguen a relacionar DOS O MÁS datos, condiciones,
  reglas, conceptos, pasos o consecuencias respaldados por el temario.

- Cuando la fuente lo permita, exige decidir primero qué principio,
  procedimiento, condición, fórmula o excepción resulta aplicable y después
  utilizarlo correctamente para resolver la pregunta.

- Los TRES distractores deben ser técnicamente plausibles y próximos a la
  respuesta correcta. Evita opciones descartables por sentido común,
  diferencias exageradas o términos claramente impropios.

- En preguntas numéricas o de cálculo, cuando la evidencia lo permita,
  exige encadenar al menos DOS operaciones, conversiones, relaciones o
  decisiones de cálculo, en lugar de una sustitución directa trivial.

- En preguntas de razonamiento, prioriza diferencias de condición,
  excepción, secuencia, límite, aplicación o consecuencia que obliguen a
  dominar con precisión el conocimiento evaluado.

- La dificultad MUY ALTA nunca debe proceder de hacer el enunciado más largo,
  ambiguo, rebuscado o tramposo.

- Si la evidencia disponible para ese objetivo no permite aumentar la
  complejidad sin inventar información, genera una pregunta de dificultad
  alta técnicamente sólida antes que fabricar dificultad artificial.
  - El campo difficulty debe reflejar la dificultad REAL finalmente generada.
  Devuelve "muy alta" únicamente cuando la pregunta cumpla realmente las
  exigencias adicionales de dificultad muy alta.
  Si has tenido que aplicar el fallback anterior, devuelve difficulty: "alta".
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
async function getOfficialGeographyStyleReference(){
  if(!EXAM_STYLE_STORE){
    await loadExamStyleStore();
  }

  if(!EXAM_STYLE_STORE){
    throw new Error(
      "No está disponible el almacén de estilo de los exámenes oficiales."
    );
  }

  const ai = aiClient();

  const prompt = `
Analiza los exámenes oficiales de Bomberos de Navarra 2024 y 2026
contenidos en este File Search Store.

OBJETIVO EXCLUSIVO:
Localiza y analiza ÚNICAMENTE las preguntas que correspondan
inequívocamente al bloque de GEOGRAFÍA.

NO analices como Geografía preguntas de legislación,
materia técnica de bomberos u otros bloques.

Estos exámenes NO son fuente factual del temario.
Su única función aquí es revelar CÓMO PREGUNTA EL TRIBUNAL
LA MATERIA DE GEOGRAFÍA.

Analiza conjuntamente 2024 y 2026,
dando mayor peso al estilo observado en 2026.

Extrae patrones útiles sobre:

1. Tipos de relaciones geográficas que pregunta el tribunal.
2. Pertenencia o exclusión de municipios, localidades,
   infraestructuras, ámbitos o elementos territoriales.
3. Asociaciones entre dos o más datos.
4. Forma de preguntar listas y conjuntos.
5. Identifica QUÉ tipos concretos de datos numéricos pregunta realmente
   el tribunal y cuáles NO aparecen como objeto de pregunta.
   NO presupongas que superficie, perímetro, potencia, producción,
   promotor, año de puesta en servicio u otros campos de tablas
   sean examinables por el mero hecho de existir en el temario.
6. Relaciones entre municipios, parques, infraestructuras,
   líneas, recorridos o ámbitos territoriales.
7. Uso de preguntas CORRECTA, INCORRECTA, NO u otras
   formulaciones negativas.
8. Longitud y estructura habitual de enunciados y opciones.
9. Construcción de distractores geográficos plausibles.
10. Uso de elementos reales próximos o pertenecientes
    a categorías similares como distractores.
11. Nivel de literalidad frente a razonamiento.
12. Diferencias relevantes entre las preguntas de
    Geografía de 2024 y 2026.
13. Rasgos del modelo 2026 que deberían predominar.

CARTOGRAFÍA Y ORIENTACIÓN ESPACIAL:

Identifica también como categoría separada las preguntas
cuya resolución dependa de observar o interpretar un mapa,
por ejemplo:

- orientación norte/sur/este/oeste entre accidentes geográficos;
- posición espacial relativa;
- qué elemento queda respecto de otro;
- proximidad o situación deducida visualmente;
- recorridos o relaciones espaciales que no estén expresados
  textualmente en una fuente factual.

Describe CÓMO formula el tribunal estas preguntas,
pero NO deduzcas ni proporciones sus respuestas
y NO conviertas esas relaciones espaciales en conocimiento factual.

Distingue expresamente estas preguntas cartográficas
de aquellas relaciones de orden, orientación o recorrido
que sí estén ESCRITAS literalmente en una fuente textual.

REGLAS ABSOLUTAS:

- NO uses las respuestas oficiales como fuente factual.
- NO indiques cuál era la opción correcta de una pregunta oficial.
- NO copies preguntas completas del examen.
- NO extraigas datos concretos para utilizarlos posteriormente
  como conocimiento.
- Describe patrones de evaluación, redacción y distractores.
- Si una pregunta no puede identificarse inequívocamente
  como Geografía, no la incluyas en el análisis.
- La futura fuente factual seguirá siendo exclusivamente
  el temario cargado en File Search.

Devuelve una guía específica y compacta de ESTILO DE GEOGRAFÍA,
diferenciando claramente:

A) familias de preguntas reproducibles con seguridad
   desde el temario textual;

B) preguntas de interpretación cartográfica/orientación
   que requieren mapa y que NO deben generarse
   automáticamente sin una fuente cartográfica suficiente.
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
    throw new Error(
      "No se pudo obtener la referencia específica de estilo de Geografía."
    );
  }

  return text;
}

async function getCachedOfficialGeographyStyleReference(){
  const cached = await db.query(
    "SELECT value FROM app_state WHERE key=$1 LIMIT 1",
    ["official_geography_style_reference_v2"]
  );

  if(cached.rows.length && cached.rows[0].value?.trim()){
    console.log(
      "GEOGRAPHY STYLE: referencia recuperada de PostgreSQL"
    );
    return cached.rows[0].value;
  }

  console.log(
    "GEOGRAPHY STYLE: no existe caché; obteniendo referencia desde File Search"
  );

  const styleReference =
    await getOfficialGeographyStyleReference();

  await db.query(`
    INSERT INTO app_state (key,value)
    VALUES ($1,$2)
    ON CONFLICT (key)
    DO UPDATE SET value=EXCLUDED.value
  `,[
    "official_geography_style_reference_v2",
    styleReference
  ]);

  console.log(
    "GEOGRAPHY STYLE: referencia guardada en PostgreSQL"
  );

  return styleReference;
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
app.post("/api/analyze-coverage", async(req,res)=>{
  let uploadedPdfPath=null;
  let topic=null;
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
    await setCoverageRunState(
      coverageRunId,
      {
        status:"processing",
        topicId:Number(topic.id),
        topic:topic.name
      }
    );
        if(topic.file_search_indexed !== true){
      console.log(
        `COVERAGE: indexando en File Search ${topic.name}`
      );

      await ingest(
        pdfPath,
        topic.name
      );

      const indexedResult=
        await db.query(
          `UPDATE topics
           SET file_search_indexed = TRUE
           WHERE id = $1
           RETURNING *`,
          [Number(topic.id)]
        );

      topic=indexedResult.rows[0];

      console.log(
        `COVERAGE: File Search listo para ${topic.name}`
      );
    }
const coverageChunkPages=
  coverageTopicNumber(topic.name)===22
    ? 1
    : 5;

const {totalPages,chunks}=
  await splitPdfIntoChunks(
    pdfPath,
    coverageChunkPages
  );

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
const allItems=[];

for(const chunk of chunks){
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

for(const chunk of auditChunks){
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
await saveCoverageItems(
      topic.id,
      validItems
    );

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
    if(uploadedPdfPath){
      fs.unlink(
        uploadedPdfPath,
        ()=>{}
      );
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
       WHERE topic_id = $1
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
       WHERE topic_id = $1
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
    legislacion:[
      "2026_CORRECTA",
      "2026_INCORRECTA",
      "2024_TEXTO",
      "2026_CORRECTA",
      "2026_INCORRECTA"
    ],

    geografia:[
      "2026_CORRECTA",
      "2026_INCORRECTA",
      "2026_CORRECTA",
      "2026_INCORRECTA",
      "2024_TEXTO"
    ],

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
async function getFreshReplacementTargetForTest({
  excludedIds = [],
  occupiedTargets = [],
  preferredFamily = "2024_TEXTO"
} = {}){
  const candidates =
    await getAdaptiveCoverageCandidates(1000);

  const excluded = new Set(
    excludedIds.map(id => Number(id))
  );

  const normalize = value =>
    String(value || "")
      .trim()
      .toLowerCase();

  const occupiedKeys = new Set(
    occupiedTargets.map(target =>
      `${normalize(target.section)}||${normalize(target.concept)}`
    )
  );

  const familyForCandidate = (candidate, family) => {
    /*
    La plaza gráfica no debe bloquear la entrega del test.
    Si una pregunta gráfica agota sus intentos,
    cae temporalmente a texto.
    El sistema gráfico se termina en el punto 10.
    */
    if(family === "GRAFICA"){
      return "2024_TEXTO";
    }

    if(family === "CALCULO_FORMULACION"){
      const compatible =
        candidate.item_type === "formula" ||
        candidate.evaluation_type === "calculo" ||
        candidate.evaluation_type === "relacion_variables";

      return compatible
        ? "CALCULO_FORMULACION"
        : null;
    }

    if(family === "2024_NUMERICA"){
      const evidence = [
        candidate.concept,
        candidate.source_evidence
      ]
        .filter(Boolean)
        .join(" ");

      const compatible =
        candidate.item_type === "dato_numerico" ||
        /\d/.test(evidence);

      return compatible
        ? "2024_NUMERICA"
        : null;
    }

    return family;
  };

  /*
  Primera pasada:
  intentamos conservar la familia original.
  */
  for(const candidate of candidates){
    if(excluded.has(Number(candidate.id))){
      continue;
    }

    const key =
      `${normalize(candidate.section)}||${normalize(candidate.concept)}`;

    if(occupiedKeys.has(key)){
      continue;
    }

    const finalFamily =
      familyForCandidate(
        candidate,
        preferredFamily
      );

    if(!finalFamily){
      continue;
    }

    const target = {
      ...candidate,
      questionFamily:finalFamily
    };

    target.adaptiveDifficulty =
      getAdaptiveDifficulty(target);

    target.previousBankQuestion =
      await getLatestBankQuestionForTarget(target);

    return target;
  }

  /*
  Segunda pasada:
  si la familia concreta no encuentra ningún candidato
  compatible, priorizamos entregar una pregunta válida
  antes que destruir el test completo.
  */
  for(const candidate of candidates){
    if(excluded.has(Number(candidate.id))){
      continue;
    }

    const key =
      `${normalize(candidate.section)}||${normalize(candidate.concept)}`;

    if(occupiedKeys.has(key)){
      continue;
    }

    const target = {
      ...candidate,
      questionFamily:"2024_TEXTO"
    };

    target.adaptiveDifficulty =
      getAdaptiveDifficulty(target);

    target.previousBankQuestion =
      await getLatestBankQuestionForTarget(target);

    return target;
  }

  return null;
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
function getAdaptiveDifficulty(target){
if(target?.failed_difficulty === "muy alta"){
  return "muy alta";
}
  const asked =
    Number(target.times_asked || 0);

  const correct =
    Number(target.times_correct || 0);

  const wrong =
    Number(target.times_wrong || 0);

  const blank =
    Number(target.times_blank || 0);

  const attempts =
    correct + wrong + blank;

  if(attempts < 2){
    return "alta";
  }

  const performance =
    correct / attempts;

  if(
    performance >= 0.85 &&
    asked >= 3
  ){
    return "muy alta";
  }

  if(
    performance < 0.50
  ){
    return "alta";
  }

  return "alta";
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
const adaptiveCandidates =
  await getAdaptiveCoverageCandidates(
    nucleusCandidateLimit,
    allowedTopicIds,
    selectionStrategy
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
      /\bubicad[oa]\s+en\s+(.+?)(?=,\s*(?:asociad[oa]|adscrit[oa]|con\b)|$)/i
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
    const geographyFamilies = [
      "2026_CORRECTA",
      "2026_INCORRECTA",
      "2026_RAZONAMIENTO",
      "2024_TEXTO"
    ];

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
 async function attachDistractorContextToTargets(targets){
  if(!Array.isArray(targets) || !targets.length){
    return;
  }

  /*
  Contexto territorial maestro del Tema 21.
  Se carga una sola vez por generación.
  */
  const territorialResult =
    await db.query(`
      SELECT
        ci.id,
        ci.section,
        ci.concept,
        ci.source_page,
        ci.manual_page,
        ci.source_evidence
      FROM coverage_items ci
      JOIN topics t
        ON t.id = ci.topic_id
      WHERE
        t.topic_order = 21
        AND LOWER(BTRIM(COALESCE(ci.section,''))) IN (
  LOWER('Tema 21 - municipios y ámbitos'),
  LOWER('Tema 21 - concejos y localidades')
)
        AND ci.concept LIKE '%->%'
      ORDER BY ci.id ASC
    `);

  const normalizeGeo=value=>
    String(value || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g,"")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g," ")
      .trim()
      .replace(/\s+/g," ");

  const territorialRows=
    territorialResult.rows.map(row=>{

const parts=
  String(row.concept || "")
    .split("->")
    .map(part=>part.trim())
    .filter(Boolean);

const rawEntity=
  String(parts[0] || "")
    .trim()
    .replace(
      /^Municipio de\s+/i,
      ""
    );

const parentMunicipality=
  parts.length >= 3
    ? String(parts[1] || "").trim()
    : rawEntity;

const operationalArea=
  parts.length >= 3
    ? String(
        parts[parts.length - 1] || ""
      ).trim()
    : String(parts[1] || "").trim();

const aliases=
  rawEntity
    .split("/")
    .map(normalizeGeo)
    .filter(alias=>alias.length >= 3);

const municipalityAliases=
  parentMunicipality
    .replace(
      /^Municipio de\s+/i,
      ""
    )
    .split("/")
    .map(normalizeGeo)
    .filter(alias=>alias.length >= 3);

return {
  ...row,
  rawEntity,
  parentMunicipality,
  aliases,
  municipalityAliases,
  operationalArea,
  normalizedOperationalArea:
    normalizeGeo(operationalArea)
      };
    });

  for(const target of targets){

    if(!target?.topic_name || !target?.id){
      target.distractorContext=[];
      target.territorialContext={
        exact:[],
        nearby:[]
      };
      continue;
    }

    /*
    Banco factual del propio tema.
    Ampliamos de 6 a 12 para disponer de
    más alternativas reales.
    */
    const result=
      await db.query(
        `
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
        JOIN topics t
          ON t.id = ci.topic_id
        WHERE
          t.name = $1
          AND ci.id <> $2
          AND ci.source_evidence IS NOT NULL
          AND BTRIM(ci.source_evidence) <> ''
          AND (
            (
              $3::text IS NOT NULL
              AND BTRIM($3::text) <> ''
              AND LOWER(
                BTRIM(
                  COALESCE(ci.section,'')
                )
              ) =
              LOWER(BTRIM($3::text))
            )
            OR
            (
              $4::int IS NOT NULL
              AND ci.source_page IS NOT NULL
              AND ci.source_page BETWEEN
                ($4::int - 2)
                AND
                ($4::int + 2)
            )
          )
        ORDER BY
          CASE
            WHEN
              $3::text IS NOT NULL
              AND BTRIM($3::text) <> ''
              AND LOWER(
                BTRIM(
                  COALESCE(ci.section,'')
                )
              ) =
              LOWER(BTRIM($3::text))
            THEN 0
            ELSE 1
          END,
          CASE
            WHEN ci.item_type = $5
            THEN 0
            ELSE 1
          END,
          CASE
            WHEN
              $4::int IS NOT NULL
              AND ci.source_page IS NOT NULL
            THEN
              ABS(
                ci.source_page -
                $4::int
              )
            ELSE 999
          END,
          ci.id ASC
        LIMIT 12
        `,
        [
          target.topic_name,
          Number(target.id),
          target.section || null,
          target.source_page ?? null,
          target.item_type || null
        ]
      );

    target.distractorContext=
      result.rows;

    target.territorialContext={
      exact:[],
      nearby:[]
    };

    const topicNumber=
      coverageTopicNumber(
        target.topic_name
      );

    if(
      !Number.isInteger(topicNumber) ||
      topicNumber < 21 ||
      topicNumber > 26
    ){
      continue;
    }

const conceptText=
  String(target.concept || "")
    .trim();

let operationalLocationText="";

/*
Para TEMA 21 el propio concept ya contiene:
MUNICIPIO -> PARQUE
o
CONCEJO -> MUNICIPIO -> PARQUE
*/
if(topicNumber===21){

  const conceptParts=
    conceptText
      .split("->")
      .map(part=>part.trim())
      .filter(Boolean);

  operationalLocationText=
    String(conceptParts[0] || "")
      .replace(
        /^Municipio de\s+/i,
        ""
      )
      .trim();

}else{

  /*
  Para instalaciones buscamos EXCLUSIVAMENTE
  la parte que identifica su municipio/localidad.

  Nunca buscamos el parque dentro del texto completo,
  evitando que "Parque Central de Pamplona/Iruña"
  provoque una falsa detección de Pamplona.
  */
  const locationPatterns=[
    /\bubicad[oa]s?\s+en\s+(.+?)(?=,\s*(?:asociad|adscrit|correspond|depend|con\s+(?:una|un|el|la)|parque)|\.\s*$|$)/i,

    /\bsituad[oa]s?\s+en\s+(.+?)(?=,\s*(?:asociad|adscrit|correspond|depend|con\s+(?:una|un|el|la)|parque)|\.\s*$|$)/i,

    /\bemplazad[oa]s?\s+en\s+(.+?)(?=,\s*(?:asociad|adscrit|correspond|depend|con\s+(?:una|un|el|la)|parque)|\.\s*$|$)/i,

    /\blocalizad[oa]s?\s+en\s+(.+?)(?=,\s*(?:asociad|adscrit|correspond|depend|con\s+(?:una|un|el|la)|parque)|\.\s*$|$)/i,

    /\ben\s+el\s+municipio\s+de\s+(.+?)(?=,\s*(?:asociad|adscrit|correspond|depend|con\s+(?:una|un|el|la)|parque)|\.\s*$|$)/i,

    /\bmunicipio(?:s)?\s+asociad[oa]s?\s*[:\-]?\s*(.+?)(?=,\s*(?:parque|asociad|adscrit|correspond)|\.\s*$|$)/i
  ];

  for(const pattern of locationPatterns){

    const match=
      conceptText.match(pattern);

    if(match?.[1]){
      operationalLocationText=
        String(match[1])
          .trim();

      break;
    }
  }
}

/*
Texto NORMALIZADO que contiene solamente
el lugar operativo detectado.
*/
const normalizedOperationalLocation=
  operationalLocationText
    ? ` ${normalizeGeo(
        operationalLocationText
      )} `
    : "";

/*
Relacionamos el lugar exclusivamente con
las entidades territoriales exactas del T21.

Ejemplos:
Orkoien -> Cordovilla
Sesma -> Lodosa
Milagro -> Peralta/Azkoien

Si aparece un concejo, se recupera su fila:
CONCEJO -> MUNICIPIO -> PARQUE.
*/
const exact=
  normalizedOperationalLocation
    ? territorialRows
        .filter(row=>
          row.aliases.some(alias=>
            normalizedOperationalLocation.includes(
              ` ${alias} `
            )
          )
        )
        .filter(
          (row,index,array)=>
            array.findIndex(other=>
              normalizeGeo(other.concept) ===
              normalizeGeo(row.concept)
            ) === index
        )
        .sort((a,b)=>{

          const maxA=
            Math.max(
              0,
              ...a.aliases.map(
                alias=>alias.length
              )
            );

          const maxB=
            Math.max(
              0,
              ...b.aliases.map(
                alias=>alias.length
              )
            );

          return maxB-maxA;
        })
        .slice(0,4)
    : [];

    if(!exact.length){
      continue;
    }

    const exactIds=
      new Set(
        exact.map(row=>
          Number(row.id)
        )
      );

    const exactAreas=
      new Set(
        exact
          .map(row=>
            row.normalizedOperationalArea
          )
          .filter(Boolean)
      );

    const exactPages=
      new Set(
        exact
          .map(row=>
            String(
              row.manual_page || ""
            )
          )
          .filter(Boolean)
      );

    const nearby=
      territorialRows
        .filter(row=>
          !exactIds.has(
            Number(row.id)
          ) &&
          (
            exactAreas.has(
              row.normalizedOperationalArea
            ) ||
            exactPages.has(
              String(
                row.manual_page || ""
              )
            )
          )
        )
        .sort((a,b)=>{
          const sameAreaA=
            exactAreas.has(
              a.normalizedOperationalArea
            )
              ? 0
              : 1;

          const sameAreaB=
            exactAreas.has(
              b.normalizedOperationalArea
            )
              ? 0
              : 1;

          return (
            sameAreaA-
            sameAreaB ||
            Number(a.id)-
            Number(b.id)
          );
        })
        .slice(0,16);
const cleanTerritorialRow=row=>({
  id:row.id,

  entity:
    row.rawEntity,

  parentMunicipality:
    row.parentMunicipality,

  concept:
    row.concept,

  source_page:
    row.source_page,

  manual_page:
    row.manual_page,

  source_evidence:
    row.source_evidence,

  operationalArea:
    row.operationalArea
});
    target.operationalLocation=
  operationalLocationText || null;
    /*
==================================================
POOL FACTUAL DE OPCIONES DE GEOGRAFÍA
==================================================

No genera respuestas.
Solo entrega al generador candidatos reales y
territorialmente competitivos procedentes del T21
y del propio tema.

IMPORTANTE:
"mismo ámbito operativo" NO significa necesariamente
municipio geográficamente colindante.
La vecindad estricta solo podrá afirmarse cuando
dispongamos de evidencia cartográfica suficiente.
*/

const municipalitySection=
  normalizeGeo(
    "Tema 21 - municipios y ámbitos"
  );

const subordinateSection=
  normalizeGeo(
    "Tema 21 - concejos y localidades"
  );

const isMunicipalityRow=row=>
  normalizeGeo(row.section) ===
  municipalitySection;

const isSubordinateRow=row=>
  normalizeGeo(row.section) ===
  subordinateSection;

const uniqueBy=(rows,keyFn)=>{
  const seen=new Set();

  return rows.filter(row=>{
    const key=
      String(keyFn(row) || "")
        .trim();

    if(!key || seen.has(key)){
      return false;
    }

    seen.add(key);
    return true;
  });
};

const exactOperationalAreas=
  new Set(
    exact
      .map(row=>
        row.normalizedOperationalArea
      )
      .filter(Boolean)
  );

const targetEntityKey=
  normalizeGeo(
    operationalLocationText
  );

const exactPrimary=
  exact.find(row=>
    row.aliases.some(alias=>
      alias === targetEntityKey
    )
  ) ||
  exact[0] ||
  null;

const targetParentMunicipality=
  exactPrimary?.parentMunicipality ||
  operationalLocationText ||
  null;

const targetParentMunicipalityKey=
  normalizeGeo(
    targetParentMunicipality
  );

const targetManualPage=
  Number(
    exactPrimary?.manual_page
  );

const pageDistance=row=>{
  const page=
    Number(row?.manual_page);

  if(
    Number.isFinite(targetManualPage) &&
    Number.isFinite(page)
  ){
    return Math.abs(
      page-targetManualPage
    );
  }

  return 999;
};

/*
--------------------------------------------------
A) MUNICIPIOS COMPETITIVOS
--------------------------------------------------

Primero:
- mismo parque/sede operativa;
- misma página o páginas próximas del Anexo I;
- nunca repetir el propio municipio.
*/

const municipalityCandidates=
  uniqueBy(
    territorialRows
      .filter(row=>
        isMunicipalityRow(row) &&
        exactOperationalAreas.has(
          row.normalizedOperationalArea
        ) &&
        !row.aliases.some(alias=>
          alias === targetEntityKey
        )
      )
      .sort((a,b)=>
        pageDistance(a)-
        pageDistance(b) ||
        Number(a.id)-Number(b.id)
      ),
    row=>
      normalizeGeo(row.rawEntity)
  )
  .slice(0,16)
  .map(row=>({
    entity:
      row.rawEntity,

    operationalArea:
      row.operationalArea,

    concept:
      row.concept,

    source_page:
      row.source_page,

    manual_page:
      row.manual_page
  }));

/*
--------------------------------------------------
B) CONCEJOS DEL MISMO MUNICIPIO
--------------------------------------------------

Sirve especialmente para preguntas:

"¿Qué concejo NO pertenece al municipio X?"

Los concejos correctos deben salir de aquí.
*/

const sameMunicipalitySubordinates=
  uniqueBy(
    territorialRows
      .filter(row=>
        isSubordinateRow(row) &&
        normalizeGeo(
          row.parentMunicipality
        ) ===
        targetParentMunicipalityKey &&
        !row.aliases.some(alias=>
          alias === targetEntityKey
        )
      )
      .sort((a,b)=>
        Number(a.id)-Number(b.id)
      ),
    row=>
      normalizeGeo(row.rawEntity)
  )
  .slice(0,16)
  .map(row=>({
    entity:
      row.rawEntity,

    parentMunicipality:
      row.parentMunicipality,

    operationalArea:
      row.operationalArea,

    concept:
      row.concept,

    source_page:
      row.source_page,

    manual_page:
      row.manual_page
  }));

/*
--------------------------------------------------
C) CONCEJOS COMPETITIVOS DE OTROS MUNICIPIOS
--------------------------------------------------

Prioridad:
- mismo parque/sede;
- municipio padre diferente;
- posición próxima dentro del Anexo I.

Son candidatos para el único distractor falso
de una pregunta de pertenencia de concejos.
*/

const nearbySubordinates=
  uniqueBy(
    territorialRows
      .filter(row=>
        isSubordinateRow(row) &&
        exactOperationalAreas.has(
          row.normalizedOperationalArea
        ) &&
        normalizeGeo(
          row.parentMunicipality
        ) !==
        targetParentMunicipalityKey
      )
      .sort((a,b)=>
        pageDistance(a)-
        pageDistance(b) ||
        Number(a.id)-Number(b.id)
      ),
    row=>
      normalizeGeo(row.rawEntity)
  )
  .slice(0,16)
  .map(row=>({
    entity:
      row.rawEntity,

    parentMunicipality:
      row.parentMunicipality,

    operationalArea:
      row.operationalArea,

    concept:
      row.concept,

    source_page:
      row.source_page,

    manual_page:
      row.manual_page
  }));

/*
--------------------------------------------------
D) PARQUES/SEDES ALTERNATIVOS
--------------------------------------------------

El correcto sale de exactOperationalAreas.

Los alternativos se ordenan por proximidad de aparición
en el Anexo I, pero NO se afirma por ello que sean
geográficamente colindantes.
*/

const alternativeOperationalAreas=
  uniqueBy(
    territorialRows
      .filter(row=>
        row.normalizedOperationalArea &&
        !exactOperationalAreas.has(
          row.normalizedOperationalArea
        )
      )
      .sort((a,b)=>
        pageDistance(a)-
        pageDistance(b) ||
        Number(a.id)-Number(b.id)
      ),
    row=>
      row.normalizedOperationalArea
  )
  .slice(0,8)
  .map(row=>({
    operationalArea:
      row.operationalArea,

    exampleEntity:
      row.rawEntity,

    source_page:
      row.source_page,

    manual_page:
      row.manual_page
  }));

/*
--------------------------------------------------
E) REGISTROS REALES DEL MISMO TEMA
--------------------------------------------------

Para preguntas inversas:
municipio -> polígono
municipio -> solar
municipio -> eólico
etc.

No entregamos datos inventados:
son coverage_items reales del mismo tema.
*/

const sameTopicRecords=
  result.rows
    .slice(0,16)
    .map(row=>({
      id:
        row.id,

      concept:
        row.concept,

      source_page:
        row.source_page,

      manual_page:
        row.manual_page
    }));

target.optionPools={
  correctLocation:
    operationalLocationText || null,

  correctOperationalAreas:
    exact.map(row=>
      row.operationalArea
    ),

  municipalitiesSameOperationalArea:
    municipalityCandidates,

  subordinatesSameMunicipality:
    sameMunicipalitySubordinates,

  subordinatesOtherMunicipalitiesSameOperationalArea:
    nearbySubordinates,

  alternativeOperationalAreas:
    alternativeOperationalAreas,

  sameTopicRecords:
    sameTopicRecords
};
    target.territorialContext={
      exact:
        exact.map(
          cleanTerritorialRow
        ),

      nearby:
        nearby.map(
          cleanTerritorialRow
        )
    };
  }
}
  function geographyOfficialArchetypePrompt(target,index=0){
  const topicNumber=
    coverageTopicNumber(target?.topic_name);

  if(
    !Number.isInteger(topicNumber) ||
    topicNumber < 21 ||
    topicNumber > 27
  ){
    return "";
  }

  const base={
    21:[
      {
        id:"INCIDENTE_LOCALIDAD_SEDE",
        pattern:
          "Plantea un aviso o incidente en una localidad, municipio o concejo y pregunta qué sede/parque operativo se movilizaría primero."
      },
      {
        id:"PERTENENCIA_SEDE",
        pattern:
          "Pregunta qué municipio, localidad o concejo pertenece a una sede concreta."
      },
      {
        id:"NO_PERTENECE_AMBITO",
        pattern:
          "Presenta cuatro localidades plausibles y pregunta cuál NO pertenece al ámbito territorial indicado."
      },
      {
        id:"RELACION_CRUZADA",
        pattern:
          "Presenta cuatro parejas municipio/concejo -> sede y exige identificar la pareja correcta o incorrecta."
      },
      {
        id:"MISMA_ZONA_SEDES_DISTINTAS",
        pattern:
          "Construye las alternativas usando municipios de sedes próximas o administrativamente agrupadas para obligar a distinguir la sede operativa exacta."
      }
    ],

    22:[
      {
        id:"POLIGONO_LOCALIDAD",
        pattern:
          "Da el nombre de un polígono o emplazamiento industrial y pregunta en qué municipio/localidad se encuentra."
      },
      {
        id:"POLIGONO_SEDE",
        pattern:
          "Plantea un incidente industrial en un polígono concreto y pregunta qué sede/parque operativo acudiría en primer lugar."
      },
      {
        id:"POLIGONO_MUNICIPIO_SEDE",
        pattern:
          "Presenta cuatro combinaciones polígono -> municipio -> sede y exige seleccionar la única combinación íntegramente correcta."
      },
      {
        id:"POLIGONO_INCORRECTA",
        pattern:
          "Presenta cuatro relaciones reales o casi reales entre polígonos, municipios y sedes y pregunta cuál es INCORRECTA."
      },
      {
        id:"MUNICIPIO_POLIGONO",
        pattern:
          "Da un municipio y obliga a identificar cuál de varios polígonos pertenece realmente a él."
      }
    ],

    23:[
      {
        id:"SOLAR_SEDE",
        pattern:
          "Plantea un incidente en una planta o parque solar concreto y pregunta qué sede/parque operativo corresponde."
      },
      {
        id:"SOLAR_MUNICIPIO",
        pattern:
          "Da el nombre de una instalación solar y pregunta en qué municipio se encuentra."
      },
      {
        id:"SOLAR_MUNICIPIO_SEDE",
        pattern:
          "Presenta combinaciones instalación solar -> municipio -> sede y exige discriminar la combinación correcta."
      },
      {
        id:"SOLAR_INCORRECTA",
        pattern:
          "Presenta cuatro asociaciones de plantas solares con municipios o sedes y pregunta cuál es INCORRECTA."
      }
    ],

    24:[
      {
        id:"EOLICO_SEDE",
        pattern:
          "Plantea un incendio o incidencia en un parque eólico concreto y pregunta qué sede/parque operativo corresponde."
      },
      {
        id:"EOLICO_MUNICIPIO",
        pattern:
          "Da el nombre de un parque eólico y pregunta en qué municipio o municipios se localiza."
      },
      {
        id:"EOLICO_MUNICIPIO_SEDE",
        pattern:
          "Presenta cuatro combinaciones parque eólico -> municipio -> sede y exige seleccionar la única correcta."
      },
      {
        id:"EOLICO_INCORRECTA",
        pattern:
          "Presenta cuatro asociaciones parque eólico/municipio/sede y pregunta cuál es INCORRECTA."
      }
    ],

    25:[
      {
        id:"HELIPUERTO_MUNICIPIO",
        pattern:
          "Da una instalación de helipuerto o helisuperficie y pregunta en qué municipio se encuentra."
      },
      {
        id:"MUNICIPIO_HELIPUERTO",
        pattern:
          "Da un municipio y pregunta cuál de varias instalaciones corresponde a él."
      },
      {
        id:"HELIPUERTO_TIPO_USO",
        pattern:
          "Pregunta por el tipo, uso operativo o estado de una instalación concreta cuando el temario lo indique expresamente."
      },
      {
        id:"HELIPUERTO_RELACION_INCORRECTA",
        pattern:
          "Presenta cuatro asociaciones instalación -> municipio/tipo y pregunta cuál es INCORRECTA."
      }
    ],

    26:[
      {
        id:"ESTACION_EXISTENCIA",
        pattern:
          "Presenta varias localidades y pregunta en cuál existe o NO existe estación o punto ferroviario."
      },
      {
        id:"ESTACION_SEDE",
        pattern:
          "Plantea una incidencia en una estación o punto ferroviario y pregunta qué sede/parque operativo corresponde."
      },
      {
        id:"ESTACION_LINEA_TRAMO",
        pattern:
          "Da una estación o punto y pregunta a qué línea o tramo pertenece."
      },
      {
        id:"LINEA_MUNICIPIO",
        pattern:
          "Da una línea o tramo y exige reconocer qué municipio o estación pertenece a él."
      },
      {
        id:"FERROCARRIL_INCORRECTA",
        pattern:
          "Presenta cuatro asociaciones estación/municipio/línea y pregunta cuál es INCORRECTA."
      }
    ],

    27:[
      {
        id:"CAMINO_PERTENENCIA",
        pattern:
          "Pregunta qué municipio pertenece o NO pertenece a un recorrido concreto del Camino."
      },
      {
        id:"CAMINO_ORDEN",
        pattern:
          "Presenta varios municipios o puntos del recorrido y pregunta el orden correcto en el sentido indicado por la fuente."
      },
      {
        id:"CAMINO_ENTRADA_SALIDA",
        pattern:
          "Pregunta por el municipio o punto de entrada, salida, paso o unión de un recorrido cuando figure expresamente en el temario."
      },
      {
        id:"CAMINO_SECUENCIA_INCORRECTA",
        pattern:
          "Presenta cuatro secuencias o relaciones de paso y pregunta cuál es INCORRECTA."
      }
    ]
  };

  const available=
    Array.isArray(base[topicNumber])
      ? [...base[topicNumber]]
      : [];

  /*
  Arquetipos especiales observados en examen oficial.
  Solo se habilitan cuando el propio objetivo aporta
  evidencia factual suficiente.
  */
  const evidence=
    [
      target?.concept,
      target?.source_evidence,
      ...(Array.isArray(target?.distractorContext)
        ? target.distractorContext.map(
            item=>item?.source_evidence
          )
        : [])
    ]
      .filter(Boolean)
      .join(" ");

  const normalizedEvidence=
    evidence
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g,"")
      .toLowerCase();

  const hasRoadEvidence=
    /\b(?:na|n|a|ap)-?\d{1,4}\b/
      .test(normalizedEvidence);

  if(
    (topicNumber===22 || topicNumber===24) &&
    hasRoadEvidence
  ){
    available.push({
      id:"ACCESO_OPERATIVO",
      pattern:
        "Plantea una incidencia en la instalación y pregunta por la carretera o acceso operativo correcto, usando exclusivamente carreteras expresamente respaldadas por la fuente."
    });
  }

  if(
    topicNumber===26 &&
    /\btunel|tuneles\b/.test(normalizedEvidence)
  ){
    available.push({
      id:"TUNEL_RELACION",
      pattern:
        "Plantea una incidencia o identificación en un túnel y exige relacionarlo con estación, línea, municipio o sede cuando esa relación figure en la fuente."
    });
  }

  if(!available.length){
    return "";
  }

  const numericId=
    Number(target?.id);

  const selector=
    Number.isInteger(numericId)
      ? numericId + Number(index || 0)
      : Number(index || 0);

  const selected=
    available[
      Math.abs(selector) %
      available.length
    ];

  return `
- ARQUETIPO OFICIAL DE GEOGRAFÍA ASIGNADO:
  ${selected.id}

- ESTRUCTURA A IMITAR:
  ${selected.pattern}
REGLAS DEL ARQUETIPO:

- Imita la ESTRUCTURA de las preguntas oficiales, nunca su contenido factual.
- No copies literalmente ninguna pregunta oficial.
- Sustituye nombres y hechos por datos del objetivo y del temario.
- Mantén el objetivo curricular seleccionado.

==================================================
REGLA DE ENUNCIADO
==================================================

- PRIORIDAD ABSOLUTA: enunciados breves, naturales y directos.
- Formula UNA incógnita principal por pregunta.
- NO añadas información que permita deducir la respuesta sin conocer el dato.
- NO expliques en el enunciado la relación territorial que precisamente se pregunta.
- NO utilices frases artificiales como:
  "analizando la distribución industrial y territorial...",
  "conforme a los registros técnicos...",
  "según la catalogación...",
  "en relación con su adscripción operativa..."
  salvo que sean realmente necesarias.

EJEMPLOS DE ESTRUCTURA ADECUADA:

- "¿En qué municipio se encuentra el Polígono Industrial X?"
- "Se produce un incendio en el Polígono Industrial X.
   ¿Qué parque de bomberos se movilizará en primer lugar?"
- "¿En qué municipio se encuentra el Parque Solar X?"
- "Se produce un incendio en el Parque Eólico X.
   ¿Qué parque de bomberos se movilizará en primer lugar?"
- "Se produce un accidente en el concejo X.
   ¿Qué parque de bomberos se movilizará en primer lugar?"

==================================================
NO REGALAR LA RESPUESTA
==================================================

- Si preguntas MUNICIPIO:
  el enunciado NO debe indicar el parque ni otra relación
  territorial que permita deducir fácilmente el municipio.

- Si preguntas PARQUE:
  si el incidente ocurre en una instalación concreta,
  da el nombre de la instalación pero NO añadas además
  su municipio salvo que sea imprescindible para el arquetipo.

- Si preguntas INSTALACIÓN:
  no añadas otra característica que identifique
  inequívocamente la respuesta.

==================================================
HOMOGENEIDAD DE LAS CUATRO OPCIONES
==================================================

- Las cuatro opciones deben pertenecer a la MISMA categoría.

- Pregunta por municipio:
  CUATRO municipios.

- Pregunta por concejo:
  CUATRO concejos.

- Pregunta por parque:
  CUATRO parques/sedes operativas.

- Pregunta por polígono:
  CUATRO polígonos industriales.

- Pregunta por parque solar:
  CUATRO instalaciones solares.

- Pregunta por parque eólico:
  CUATRO parques eólicos.

- Pregunta por helipuerto/helisuperficie:
  CUATRO instalaciones de esa categoría.

- NO mezcles municipio + parque dentro de una misma opción
  en una pregunta simple.

==================================================
DIFICULTAD DE LOS DISTRACTORES
==================================================

- Está PROHIBIDO construir distractores fácilmente descartables
  por pertenecer a zonas evidentemente incompatibles cuando
  existan alternativas territoriales más plausibles.

- Utiliza prioritariamente:
  1. CONTEXTO TERRITORIAL DEL TEMA 21;
  2. RELACIONES TERRITORIALES PRÓXIMAS;
  3. BANCO FACTUAL CERCANO del propio tema.

- Para preguntas de MUNICIPIO:
  los tres distractores deben ser municipios territorialmente
  plausibles respecto a la respuesta correcta.

- Prioriza municipios pertenecientes al mismo parque operativo
  o a ámbitos inmediatamente relacionados presentes en el
  contexto factual suministrado.

- NO inventes que dos municipios son colindantes.
  Solo utiliza vecindad geográfica cuando la fuente lo respalde.

- Para preguntas de PARQUE:
  utiliza sedes/parques que constituyan alternativas operativas
  plausibles para esa zona.
  Evita opciones absurdamente alejadas si existen alternativas mejores.

- Cuando el Tema 21 permita determinar una sede concreta,
  utiliza SIEMPRE esa sede concreta.

- NO uses como respuesta operativa agrupaciones administrativas
  como "Lodosa-Peralta/Azkoien" cuando pueda determinarse
  Lodosa o Peralta/Azkoien de forma individual.

==================================================
MUNICIPIOS Y CONCEJOS — TEMA 21
==================================================

- En preguntas del tipo:
  "¿Qué concejo NO pertenece al municipio X?"

  construye preferentemente:
  - TRES concejos reales pertenecientes al municipio preguntado;
  - UN concejo real perteneciente a otro municipio próximo o
    territorialmente plausible.

- El distractor incorrecto debe ser verosímil:
  nunca elijas deliberadamente un concejo de una zona
  evidentemente remota si dispones de uno más competitivo.

- También son prioritarias:
  municipio/concejo -> parque operativo;
  concejo -> municipio;
  municipio -> sede;
  pertenencia y exclusión territorial.

==================================================
POLÍGONOS, SOLARES, EÓLICOS Y HELIPUERTOS
==================================================

- Para T22, T23, T24 y T25 prioriza preguntas simples:
  instalación -> municipio
  e
  instalación/lugar -> parque operativo.

- REGLA ADICIONAL T22:
  Si el tema es T22, el enunciado y las opciones deben contener únicamente
  nombres de polígonos/emplazamientos, municipios/localidades y/o parques/sedes
  necesarios para resolver la relación territorial.
  No introduzcas superficie, área, perímetro, número de fila ni expresiones
  genéricas como "características técnicas", "datos técnicos" o
  "características del polígono".

- Las preguntas combinadas
  instalación -> municipio -> parque
  pueden aparecer, pero NO deben dominar el test.

- No repitas innecesariamente un municipio o una instalación
  cuando existan otros objetivos disponibles.

==================================================
POLARIDAD
==================================================

- Si questionFamily es 2026_INCORRECTA:
  deben existir exactamente TRES opciones verdaderas
  y UNA falsa.

- Si questionFamily es 2026_CORRECTA:
  debe existir exactamente UNA opción válida.

- No fabriques la opción falsa mediante una asociación
  territorial grotesca; debe ser una confusión plausible.

==================================================
DIVERSIDAD
==================================================

- Evita reutilizar en varias preguntas consecutivas:
  el mismo municipio,
  el mismo concejo,
  la misma instalación,
  el mismo parque
  o los mismos distractores.

- La dificultad debe proceder del conocimiento territorial,
  NO de enunciados innecesariamente complejos.
`;
}    
function geographyPromptSafeText(target,value){
  const topicNumber=
    coverageTopicNumber(target?.topic_name);

  let text=
    String(value || "").trim();

  if(topicNumber === 22){
    /*
    El coverage de T22 conserva superficie/perímetro para fidelidad documental,
    pero esos campos NO son materia examinable. No los exponemos al generador,
    porque contaminaban especialmente las preguntas INCORRECTA.
    */
    text = text
      .replace(/\s*,?\s*superficie\b.*$/i,"")
      .replace(/\s*,?\s*per[ií]metro\b.*$/i,"")
      .replace(/^\s*\d+\s+(?=(?:pol[ií]gono|[aá]rea|zona|parque|sector|ciudad)\b)/i,"")
      .replace(/\s+\d+(?:[.,]\d+)?\s+\d+(?:[.,]\d+)?\s*$/i,"")
      .trim();
  }

  return text;
}

function geographyPromptSafeEvidence(target){
  const topicNumber=
    coverageTopicNumber(target?.topic_name);

  if(topicNumber === 22){
    /*
    Para T22 el concepto ya contiene la relación útil
    instalación -> municipio -> parque. Evitamos pasar al prompt
    las columnas numéricas crudas de la tabla.
    */
    return geographyPromptSafeText(
      target,
      target?.concept || target?.source_evidence || ""
    );
  }

  return String(target?.source_evidence || "").trim();
}

function geographyExamQuestionPolicy(target){
  const topicNumber=
    coverageTopicNumber(target?.topic_name);

  if(
    !Number.isInteger(topicNumber) ||
    topicNumber < 21 ||
    topicNumber > 27
  ){
    return "";
  }

  const common = `
- CRITERIO DE RELEVANCIA DE EXAMEN:
  Los exámenes oficiales de Bomberos de Navarra utilizan estos temas
  principalmente para evaluar conocimiento territorial y operativo.
- Que un dato aparezca en una tabla NO significa que tenga la misma
  relevancia como pregunta de oposición.
- No conviertas metadatos incidentales de una tabla en el objeto de la pregunta.
- Prioriza relaciones útiles para localizar una emergencia, determinar
  el parque competente, reconocer una instalación o comprender un recorrido.
- Carreteras, accesos, proximidades u orientación SOLO pueden preguntarse
  cuando estén respaldados expresamente por la fuente factual disponible.
- Nunca deduzcas una ruta o posición utilizando conocimiento externo.
`;

  if(topicNumber === 21){
    return `
${common}

TEMA 21 — PARQUES, MUNICIPIOS Y CONCEJOS

PRIORIDAD:
1. municipio/localidad/concejo -> parque o sede;
2. parque/sede -> ámbito territorial;
3. pertenencia o exclusión territorial.

NO conviertas automáticamente en pregunta:
- estadísticas de intervenciones;
- cifras de plantilla;
- cantidades administrativas;
- otros datos numéricos secundarios
cuando el mismo registro permite evaluar la relación territorial.
`;
  }

  if(topicNumber === 22){
    return `
${common}

TEMA 22 — POLÍGONOS Y EMPLAZAMIENTOS INDUSTRIALES

PREGUNTABLE:
1. polígono/emplazamiento -> municipio;
2. polígono/emplazamiento -> parque de bomberos;
3. combinación polígono -> municipio -> parque;
4. pertenencia/exclusión entre instalaciones y municipios;
5. acceso por carretera SOLO si la fuente factual lo expresa.

PROHIBIDO COMO OBJETO DE PREGUNTA:
- superficie;
- área;
- perímetro;
- número de fila de la tabla.

Esos campos pueden conservarse internamente para identificar
correctamente el registro, pero NO deben aparecer en el enunciado,
las opciones ni como eje de los distractores.

REGLA ESPECÍFICA PARA 2026_INCORRECTA:
- La opción INCORRECTA debe construirse EXCLUSIVAMENTE alterando una relación
  polígono/emplazamiento -> municipio y/o parque.
- Está PROHIBIDO formular preguntas genéricas sobre "características técnicas",
  "datos técnicos", "características del polígono" o "adscripción técnica".
- Usa formatos como:
  "¿Cuál de las siguientes relaciones polígono-municipio es INCORRECTA?"
  "¿Cuál de las siguientes asociaciones polígono-parque es INCORRECTA?"
  "Señale la combinación polígono-municipio-parque INCORRECTA:"

- La explicación final debe justificar SOLO la relación territorial preguntada.
  No reproduzcas superficie, área, perímetro ni número de fila aunque aparezcan
  en la fuente original.
`;
  }

  if(topicNumber === 23){
    return `
${common}

TEMA 23 — PARQUES SOLARES

PREGUNTABLE:
1. instalación solar -> municipio;
2. instalación solar -> parque de bomberos;
3. combinación instalación -> municipio -> parque;
4. pertenencia/exclusión entre instalaciones y ámbitos territoriales;
5. acceso SOLO si está expresamente respaldado por la fuente.

PROHIBIDO COMO OBJETO DE PREGUNTA:
- promotor;
- potencia instalada o nominal;
- año de puesta en servicio.

Estos datos se conservan por fidelidad documental,
pero NO constituyen objetivos normales de examen.
`;
  }

  if(topicNumber === 24){
    return `
${common}

TEMA 24 — PARQUES EÓLICOS

PREGUNTABLE:
1. parque eólico -> municipio o municipios;
2. parque eólico -> parque de bomberos;
3. combinación instalación -> municipio -> parque;
4. acceso por carretera SOLO cuando la fuente lo respalde expresamente.

NO preguntes metadatos técnicos o empresariales tales como:
- promotor;
- potencia;
- producción;
- fecha de puesta en servicio;
- número de aerogeneradores,
salvo que una futura evidencia oficial demuestre expresamente
que el tribunal utiliza ese campo.
`;
  }

  if(topicNumber === 25){
    return `
${common}

TEMA 25 — HELIPUERTOS Y HELISUPERFICIES

PREGUNTABLE:
- instalación -> municipio;
- tipo o uso operativo;
- estado cuando sea relevante;
- identificación de una instalación.

No preguntes cuál es la instalación "más cercana"
si esa proximidad exige una deducción cartográfica no disponible.

No conviertas coordenadas, dimensiones, códigos internos
o datos administrativos en preguntas.
`;
  }

  if(topicNumber === 26){
    return `
${common}

TEMA 26 — RED FERROVIARIA

PRIORIDAD:
1. estación/punto -> parque de bomberos;
2. existencia o identificación de estación/punto;
3. estación -> línea/tramo;
4. estación -> municipio;
5. relaciones generales línea -> tramo -> municipios.

NO preguntes como objetivo principal:
- dirección postal exacta;
- longitud;
- número de registro.

Estos datos pueden conservarse como apoyo documental.
`;
  }

  if(topicNumber === 27){
    return `
${common}

TEMA 27 — CAMINO DE SANTIAGO

PREGUNTABLE:
- pertenencia de un municipio al recorrido;
- orden Norte-Sur cuando figure expresamente;
- orden Este-Oeste cuando figure expresamente;
- entrada, paso y unión de recorridos cuando estén escritos en la fuente.

Las secuencias textuales explícitas SÍ son preguntables.
No deduzcas orientación ni recorrido a partir de conocimiento cartográfico externo.
`;
  }

  return "";
}
function geographyOptionPoolsPrompt(item){

  const topicNumber=
    coverageTopicNumber(
      item?.topic_name
    );

  if(
    !Number.isInteger(topicNumber) ||
    topicNumber < 21 ||
    topicNumber > 25
  ){
    return "";
  }

  const pools=
    item?.optionPools || {};

  const municipalities=
    Array.isArray(
      pools.municipalitiesSameOperationalArea
    )
      ? pools.municipalitiesSameOperationalArea
      : [];

  const sameMunicipalitySubordinates=
    Array.isArray(
      pools.subordinatesSameMunicipality
    )
      ? pools.subordinatesSameMunicipality
      : [];

  const nearbySubordinates=
    Array.isArray(
      pools.subordinatesOtherMunicipalitiesSameOperationalArea
    )
      ? pools.subordinatesOtherMunicipalitiesSameOperationalArea
      : [];

  const alternativeOperationalAreas=
    Array.isArray(
      pools.alternativeOperationalAreas
    )
      ? pools.alternativeOperationalAreas
      : [];

  const sameTopicRecords=
    Array.isArray(
      pools.sameTopicRecords
    )
      ? pools.sameTopicRecords
      : [];

  const correctOperationalAreas=
    Array.isArray(
      pools.correctOperationalAreas
    )
      ? pools.correctOperationalAreas
      : [];

  return `
==================================================
POOL FACTUAL OBLIGATORIO PARA LAS OPCIONES
==================================================

LUGAR/MUNICIPIO CORRECTO DEL OBJETIVO:
${pools.correctLocation || "No determinado"}

SEDE/PARQUE OPERATIVO CORRECTO SEGÚN TEMA 21:
${
  correctOperationalAreas.length
    ? correctOperationalAreas.join(" | ")
    : "No determinado"
}

MUNICIPIOS COMPETITIVOS DEL MISMO ÁMBITO OPERATIVO:
${
  municipalities.length
    ? municipalities
        .map(
          (row,index)=>
            `${index+1}. ${row.entity}`
        )
        .join("\n")
    : "No disponibles"
}

CONCEJOS/LOCALIDADES DEL MISMO MUNICIPIO:
${
  sameMunicipalitySubordinates.length
    ? sameMunicipalitySubordinates
        .map(
          (row,index)=>
            `${index+1}. ${row.entity}`
        )
        .join("\n")
    : "No disponibles"
}

CONCEJOS/LOCALIDADES DE OTROS MUNICIPIOS DEL MISMO ÁMBITO:
${
  nearbySubordinates.length
    ? nearbySubordinates
        .map(
          (row,index)=>
            `${index+1}. ${row.entity} -> ${row.parentMunicipality}`
        )
        .join("\n")
    : "No disponibles"
}

OTRAS SEDES/PARQUES DISPONIBLES:
${
  alternativeOperationalAreas.length
    ? alternativeOperationalAreas
        .map(
          (row,index)=>
            `${index+1}. ${row.operationalArea}`
        )
        .join("\n")
    : "No disponibles"
}

OTROS REGISTROS REALES DEL MISMO TEMA:
${
  sameTopicRecords.length
    ? sameTopicRecords
        .map(
          (row,index)=>
            `${index+1}. ${geographyPromptSafeText(item,row.concept)}`
        )
        .join("\n")
    : "No disponibles"
}

==================================================
REGLAS OBLIGATORIAS DE CONSTRUCCIÓN
==================================================

1. SI LA PREGUNTA PIDE UN MUNICIPIO:

- La respuesta correcta debe ser:
  ${pools.correctLocation || "el municipio factual del objetivo"}.

- Si existen al menos TRES municipios en
  MUNICIPIOS COMPETITIVOS DEL MISMO ÁMBITO OPERATIVO,
  los TRES distractores DEBEN salir de esa lista.

- Está PROHIBIDO sustituirlos por municipios arbitrarios
  de otras zonas de Navarra.

- Las cuatro opciones deben ser únicamente nombres
  de municipios/localidades.

- No añadas el parque, comarca ni ninguna pista
  territorial dentro de las opciones.

2. SI LA PREGUNTA PIDE EL PARQUE/SEDE QUE ACTÚA PRIMERO:

- Usa como correcta la sede operativa concreta obtenida del Tema 21.

- Si el Tema 21 distingue dos sedes físicas,
  usa la sede concreta y NO la denominación
  administrativa agrupada.

- Está expresamente prohibido responder:
  "Lodosa-Peralta/Azkoien"
  cuando pueda determinarse Lodosa o Peralta/Azkoien.

- Lo mismo se aplica a cualquier otro parque
  con sedes operativas diferenciadas.

- Las cuatro opciones serán exclusivamente
  nombres de parques/sedes.

- No incluyas municipio + parque en la misma opción.

3. SI LA PREGUNTA ES:

"¿QUÉ CONCEJO NO PERTENECE AL MUNICIPIO X?"

y existen datos suficientes:

- TRES opciones deben salir literalmente de
  CONCEJOS/LOCALIDADES DEL MISMO MUNICIPIO.

- UNA opción debe salir de
  CONCEJOS/LOCALIDADES DE OTROS MUNICIPIOS
  DEL MISMO ÁMBITO.

- La opción falsa debe ser real.
  No inventes ningún concejo.

- NO utilices como opción falsa una localidad
  evidentemente ajena si existe una alternativa
  territorialmente más competitiva.

4. SI LA PREGUNTA PIDE IDENTIFICAR UNA INSTALACIÓN:

- Usa instalaciones reales procedentes de
  OTROS REGISTROS REALES DEL MISMO TEMA.

- Todas las opciones deben ser del mismo tipo:
  cuatro polígonos,
  cuatro parques solares,
  cuatro parques eólicos
  o cuatro helipuertos/helisuperficies.

5. PRINCIPIO DE DIFICULTAD:

Una opción NO es válida como distractor simplemente
porque sea falsa.

Debe ser suficientemente plausible como para que
un opositor necesite conocer el temario para descartarla.

Si un distractor puede eliminarse únicamente porque
pertenece claramente a otra zona territorial,
RECHÁZALO y usa otro del pool.

6. PRINCIPIO DE CAMBIO MÍNIMO:

En preguntas territoriales simples cambia UNA sola variable:

- instalación correcta + municipio incorrecto plausible;
- instalación correcta + parque incorrecto plausible;
- municipio correcto + instalación incorrecta plausible;
- municipio correcto + concejo incorrecto plausible.

No conviertas simultáneamente municipio, parque e instalación
en datos falsos salvo que el arquetipo oficial exija
expresamente una pregunta combinada.

7. PROHIBIDO DAR PISTAS:

Si preguntas por municipio,
NO menciones en el enunciado el parque correspondiente.

Si preguntas por parque,
NO menciones el municipio si el nombre de la instalación
es suficiente para formular la pregunta.

Si preguntas por un concejo,
NO incluyas datos que revelen su municipio padre.

8. PRIORIDAD:

Cuando este POOL FACTUAL disponga de suficientes alternativas,
SUS DATOS TIENEN PRIORIDAD sobre cualquier distractor
que el modelo pudiera inventar por iniciativa propia.

No uses conocimiento externo para mejorar,
completar o sustituir estos pools.
`;
}
function blockQuestionPolicy(item){
  const block=
    String(item?.topic_block || "")
      .trim()
      .toLowerCase();

  if(block === "legislacion"){
    return `

==================================================
POLÍTICA ESPECÍFICA — LEGISLACIÓN
==================================================

- Redacta como una pregunta normativa de oposición.
- Está PROHIBIDO citar CEIS Guadalajara, manuales, páginas físicas o páginas impresas.
- Está PROHIBIDO preguntar por índices, posición de epígrafes, orden de apartados,
  estructura editorial del documento o numeración dentro del índice.
- Pregunta por el contenido jurídico examinable: literalidad normativa, competencias,
  derechos, obligaciones, órganos, composición, plazos, mayorías, procedimientos,
  requisitos, excepciones, efectos y relaciones entre preceptos.
- Si la evidencia permite identificar con seguridad una norma o artículo, utiliza
  formulaciones del tipo "De acuerdo con...", "Según el artículo..." o equivalentes.
- Si la norma o artículo NO están respaldados por la evidencia recuperada, no los inventes.
- Los distractores deben ser jurídicamente plausibles y cercanos al contenido preguntado.
- Constitución: si se pregunta por un propósito del preámbulo, no ofrezcas dos
  propósitos verdaderos en una pregunta de respuesta correcta única, ni cuatro
  verdaderos cuando se solicite la incorrecta.
- Constitución: el Rey es Jefe del Estado (art. 56), pero la función ejecutiva
  corresponde al Gobierno (art. 97); no presentes al Rey como cabeza del poder
  ejecutivo en una opción que marques como correcta.
`;
  }

  if(block === "geografia"){
    return `

==================================================
POLÍTICA ESPECÍFICA — GEOGRAFÍA
==================================================

- Formula preguntas territoriales directas, breves y operativas.
- Está PROHIBIDO citar CEIS Guadalajara, manuales o páginas.
- Está PROHIBIDO preguntar por índices, epígrafes o estructura editorial del documento.
`;
  }

  if(block === "especifico"){
    const literalFamily=
      item?.questionFamily === "2024_NUMERICA" ||
      item?.questionFamily === "2024_TEXTO";

    if(literalFamily && item?.manual_page){
      return `

==================================================
POLÍTICA ESPECÍFICA — BLOQUE ESPECÍFICO
==================================================

- En esta familia literal 2024, y SOLO porque existe manualPage fiable,
  puedes utilizar cuando encaje con el estilo oficial:
  "Conforme al manual elaborado por el CEIS Guadalajara, [materia], página ${item.manual_page}, ..."
- La referencia es opcional: no fuerces la fórmula cuando perjudique la naturalidad.
- Nunca uses sourcePage como página visible.
`;
    }

    return `

==================================================
POLÍTICA ESPECÍFICA — BLOQUE ESPECÍFICO
==================================================

- Redacta conforme al estilo técnico de los exámenes oficiales.
- No fuerces referencias a CEIS o páginas fuera de las familias literales 2024
  con manualPage fiable.
`;
  }

  return "";
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

async function getLegislationAnkiStyleReference(targets){
  if(!Array.isArray(targets) || !targets.length){
    return "";
  }

  const sourceOrders=[
    ...new Set(
      targets
        .filter(target=>
          String(target?.topic_block || "")
            .trim()
            .toLowerCase() === "legislacion"
        )
        .map(target=>
          ankiLegislationSourceOrderForTopicName(
            target?.topic_name
          )
        )
        .filter(Number.isInteger)
    )
  ];

  if(!sourceOrders.length){
    return "";
  }

  const result=await db.query(
    `
    SELECT
      topic_order,
      topic,
      stem,
      options,
      correct_index
    FROM (
      SELECT
        topic_order,
        topic,
        stem,
        options,
        correct_index,
        ROW_NUMBER() OVER (
          PARTITION BY topic_order
          ORDER BY times_used ASC, id ASC
        ) AS rn
      FROM legislation_anki_questions
      WHERE
        topic_order = ANY($1::int[])
        AND validation_status = 'validated'
        AND direct_use_eligible = TRUE
    ) ranked
    WHERE rn <= 6
    ORDER BY topic_order ASC, rn ASC
    `,
    [sourceOrders]
  );

  // SERVER_80: tampoco enseñar al generador ejemplos Anki que incumplen
  // los dos controles normativos; la base de datos permanece intacta.
  const safeStyleRows=result.rows.filter(row =>
    !legislationKnownAmbiguityIssue(row)
  );
  if(!safeStyleRows.length){
    return "";
  }

  return `

==================================================
CORPUS ANKI — MODELO DE REDACCIÓN DE LEGISLACIÓN
==================================================

Las preguntas siguientes proceden del banco Anki del opositor.
Úsalas EXCLUSIVAMENTE como modelo de:
- longitud y naturalidad del enunciado;
- forma de preguntar legislación;
- construcción de distractores;
- nivel de precisión y literalidad.

NO son fuente factual para la pregunta nueva.
NO copies automáticamente sus respuestas.
NO sustituyen al temario.
La única fuente factual continúa siendo File Search sobre los PDF del temario.

EJEMPLOS:
${safeStyleRows.map((row,index)=>`
EJEMPLO ${index+1}
Tema Anki: ${row.topic}
Enunciado: ${row.stem}
Opciones: ${JSON.stringify(row.options)}
`).join("\n")}
--- FIN DEL CORPUS ANKI ---
`;
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

function legislationLexicalScore(targetText,candidateText){
  const targetTokens=legislationMatchTokens(targetText);
  const candidateTokens=legislationMatchTokens(candidateText);

  if(!targetTokens.size || !candidateTokens.size){
    return 0;
  }

  let intersection=0;
  for(const token of targetTokens){
    if(candidateTokens.has(token)){
      intersection++;
    }
  }

  const targetCoverage=
    intersection / targetTokens.size;
  const candidateCoverage=
    intersection / candidateTokens.size;

  const targetNumbers=
    normalizeLegislationMatchText(targetText)
      .match(/\b\d+\b/g) || [];
  const candidateNumbers=new Set(
    normalizeLegislationMatchText(candidateText)
      .match(/\b\d+\b/g) || []
  );

  const sharedNumbers=
    targetNumbers.filter(number=>
      candidateNumbers.has(number)
    ).length;

  return (
    targetCoverage * 0.70 +
    candidateCoverage * 0.25 +
    Math.min(sharedNumbers,3) * 0.05
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

function legislationAnkiFamilyCompatible(targetFamily,stem){
  const inferred=inferLegislationAnkiFamily(stem);

  if(targetFamily === "2026_INCORRECTA"){
    return inferred === "2026_INCORRECTA";
  }

  if(targetFamily === "2026_CORRECTA"){
    return inferred === "2026_CORRECTA";
  }

  return true;
}

const legislationAnkiMatchSchema={
  type:"object",
  properties:{
    matches:{
      type:"array",
      items:{
        type:"object",
        properties:{
          targetIndex:{type:"integer",minimum:0},
          ankiQuestionId:{type:["integer","null"]},
          reason:{type:"string"}
        },
        required:["targetIndex","ankiQuestionId","reason"]
      }
    }
  },
  required:["matches"]
};

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

async function getDirectLegislationAnkiQuestionsForTargets(ai,targets,maxDirectAllowed=Infinity){
  const direct=new Map();
  if(!Array.isArray(targets) || !targets.length){return direct;}
  const supported=targets.map((target,index)=>({
    target,index,sourceOrder:ankiLegislationSourceOrderForTopicName(target?.topic_name)
  })).filter(item=>
    String(item.target?.topic_block||"").trim().toLowerCase()==="legislacion" &&
    Number.isInteger(item.sourceOrder)
  );
  if(!supported.length){return direct;}

  const coverageIds=supported.map(item=>Number(item.target.id));
  const linked=await db.query(`
    SELECT id, anki_note_id, topic_order, stem, options, correct_index,
           correct_answer, validation_evidence, validated_coverage_item_id,
           last_used_at, times_used
    FROM legislation_anki_questions
    WHERE validation_status='validated' AND direct_use_eligible=TRUE
      AND validated_coverage_item_id=ANY($1::int[])
    ORDER BY validated_coverage_item_id, times_used ASC, id ASC
  `,[coverageIds]);
  const linkedByCoverage=new Map();
  for(const row of linked.rows){
    const key=Number(row.validated_coverage_item_id);
    if(!linkedByCoverage.has(key)){linkedByCoverage.set(key,[]);}
    linkedByCoverage.get(key).push(row);
  }
  const used=new Set();
  const unresolved=[];
  let linkedRejected=0;
  const cutoff=Date.now()-12*60*60*1000;
  const isRecent=row=>row.last_used_at!=null &&
    new Date(row.last_used_at).getTime()>=cutoff;

  for(const item of supported){
    const rows=(linkedByCoverage.get(Number(item.target.id))||[]).filter(row=>
      !used.has(Number(row.id)) && !isRecent(row) && Number(row.topic_order)===item.sourceOrder &&
      !legislationKnownAmbiguityIssue(row) &&
      legislationAnkiFamilyCompatible(item.target.questionFamily,row.stem)
    );
    const exact=rows.filter(row=>
      !legislationConflictingArticles(item.target,row) &&
      legislationExactCoverageLink(item.target,row)
    );
    linkedRejected+=rows.length-exact.length;
    const chosen=exact.find(row=>!isRecent(row));
    if(chosen && direct.size<maxDirectAllowed){
      used.add(Number(chosen.id));
      direct.set(item.index,buildDirectAnkiQuestion(chosen,item.target));
    }else{unresolved.push(item);}
  }
  console.log('ANKI LINKED MATCH:',JSON.stringify({
    selected:direct.size,unmatched:unresolved.length,linkedRejected
  }));
  if(!unresolved.length || direct.size>=maxDirectAllowed || !ai?.models?.generateContent){return direct;}

  const orders=[...new Set(unresolved.map(item=>item.sourceOrder))];
  const pool=await db.query(`
    SELECT id, anki_note_id, topic_order, stem, options, correct_index,
           correct_answer, validation_evidence, validated_coverage_item_id,
           last_used_at, times_used
    FROM legislation_anki_questions
    WHERE validation_status='validated' AND direct_use_eligible=TRUE
      AND topic_order=ANY($1::int[])
    ORDER BY topic_order ASC, times_used ASC, id ASC
  `,[orders]);
  const byOrder=new Map();
  for(const row of pool.rows){
    const order=Number(row.topic_order);
    if(!byOrder.has(order)){byOrder.set(order,[]);}
    byOrder.get(order).push(row);
  }
  const payload=[];
  const candidateRows=new Map();
  for(const item of unresolved){
    const targetText=[item.target.concept,item.target.source_evidence]
      .filter(Boolean).join(" ");
    if(targetText.trim().length<20){continue;}
    const candidates=(byOrder.get(item.sourceOrder)||[]).filter(row=>
      !used.has(Number(row.id)) && !isRecent(row) &&
      (row.validated_coverage_item_id==null ||
        Number(row.validated_coverage_item_id)===Number(item.target.id)) &&
      !legislationKnownAmbiguityIssue(row) &&
      legislationAnkiFamilyCompatible(item.target.questionFamily,row.stem) &&
      !legislationConflictingArticles(item.target,row)
    ).map(row=>({
      row,
      score:legislationLexicalScore(targetText,
        [row.stem,row.correct_answer].filter(Boolean).join(" "))
    })).filter(entry=>entry.score>=0.10)
      .sort((a,b)=>b.score-a.score ||
        Number(isRecent(a.row))-Number(isRecent(b.row)) ||
        Number(a.row.times_used)-Number(b.row.times_used) ||
        Number(a.row.id)-Number(b.row.id))
      .slice(0,6);
    if(!candidates.length){continue;}
    candidateRows.set(item.index,new Map(candidates.map(c=>[Number(c.row.id),c])));
    payload.push({
      targetIndex:item.index,
      targetConcept:String(item.target.concept||"").slice(0,300),
      pdfEvidence:String(item.target.source_evidence||"").slice(0,650),
      choices:candidates.map(c=>({
        ankiQuestionId:Number(c.row.id),
        stem:String(c.row.stem||"").slice(0,500),
        options:c.row.options,
        correctIndex:Number(c.row.correct_index),
        pdfValidationEvidence:String(c.row.validation_evidence||"").slice(0,350)
      }))
    });
  }
  if(!payload.length){
    console.log('ANKI SEMANTIC MATCH:',JSON.stringify({checked:0,selected:0}));
    return direct;
  }
  const schema=structuredClone(legislationAnkiMatchSchema);
  schema.properties.matches.minItems=payload.length;
  schema.properties.matches.maxItems=payload.length;
  schema.properties.matches.items.properties.evidenceQuote={type:"string"};
  schema.properties.matches.items.required.push("evidenceQuote");
  const prompt=`Eres un comprobador MUY ESTRICTO de equivalencia curricular.
Las preguntas FDF ya fueron validadas FACTUALMENTE con el PDF del alumno.
Ahora debes comprobar EXCLUSIVAMENTE si la pregunta evalúa EL MISMO dato que
el objetivo individual de coverage_item y su pdfEvidence, no un concepto vecino.

REGLAS:
- No confundas igualdad temática, sección, órgano o artículo con igualdad de dato.
- Una pregunta debe poder contestarse COMPLETAMENTE con la evidencia del objetivo.
- Si la evidencia es insuficiente, el objetivo es genérico, o hay duda: null.
- No completes lagunas con conocimiento externo ni infieras datos ausentes.
- Devuelve un registro por targetIndex, con ankiQuestionId elegido o null.
- Cada pregunta solo se puede asignar una vez; prioriza el encaje exacto.
- 'reason' debe mencionar el dato concreto compartido, o por qué rechazas.
- Para una coincidencia válida, evidenceQuote debe copiar literalmente un fragmento
  de AL MENOS DOS palabras relevantes del targetConcept o pdfEvidence que DEMUESTRE
  el dato preguntado. No puede ser solo el nombre de la ley o del órgano.
- Si eliges null, evidenceQuote debe ser una cadena vacía.

OBJETIVOS PDF Y PREGUNTAS FDF:\n${JSON.stringify(payload)}`;
  let parsed;
  try{
    const response=await ai.models.generateContent({
      model:'gemini-3.5-flash-lite',contents:prompt,
      config:{responseMimeType:'application/json',responseJsonSchema:schema}
    });
    parsed=JSON.parse(String(response?.text||""));
  }catch(error){
    console.warn('ANKI SEMANTIC MATCH: sin respuesta fiable; generación PDF.',
      error?.message||String(error));
    return direct;
  }
  if(!Array.isArray(parsed?.matches)||parsed.matches.length!==payload.length){
    console.warn('ANKI SEMANTIC MATCH: longitud inválida; generación PDF.');
    return direct;
  }
  let approved=0;
  const unresolvedByIndex=new Map(unresolved.map(item=>[item.index,item]));
  for(const match of parsed.matches){
    const index=Number(match.targetIndex);
    const item=unresolvedByIndex.get(index);
    if(direct.size>=maxDirectAllowed)break;
    if(!item || direct.has(index)||match.ankiQuestionId==null){continue;}
    const questionId=Number(match.ankiQuestionId);
    const entry=candidateRows.get(index)?.get(questionId);
    if(!entry || used.has(questionId) || !String(match.reason||'').trim()){continue;}
    // Exigir prueba textual localizada en el coverage_item, nunca una
    // mera afirmación semántica del modelo que no podamos contrastar.
    const quoted=normalizeLegislationMatchText(match.evidenceQuote||"");
    const support=normalizeLegislationMatchText([
      item.target.concept,item.target.source_evidence
    ].filter(Boolean).join(" "));
    if(quoted.length<12 || legislationMatchTokens(quoted).size<2 ||
       !support.includes(quoted)){continue;}
    // Segunda barrera local antes de confiar en la aprobación de la IA.
    if(entry.score<0.10 || legislationConflictingArticles(item.target,entry.row)){
      continue;
    }
    const question=buildDirectAnkiQuestion(entry.row,item.target);
    question.ankiSemanticLinkApproved=true;
    used.add(questionId);
    direct.set(index,question);
    approved++;
  }
  console.log('ANKI SEMANTIC MATCH:',JSON.stringify({
    poolValidated:pool.rows.length,checked:payload.length,approved,
    noCandidates:unresolved.length-payload.length,selectedTotal:direct.size,
    unmatched:supported.length-direct.size
  }));
  return direct;
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


function generatedMathNotationIssue(question){
  for(const item of [question?.stem,...(Array.isArray(question?.options)?question.options:[]),question?.explanation]){
    const t=String(item||'');
    if(!t)continue;
    if(t.includes('\uFFFD'))return 'FÓRMULA: hay un símbolo Unicode ilegible.';
    if(/\bSumatorio\s*\(/i.test(t))return 'FÓRMULA: se usó Sumatorio textual, no notación matemática.';
    const opens=(t.match(/\\\(/g)||[]).length;
    const closes=(t.match(/\\\)/g)||[]).length;
    const blockOpens=(t.match(/\\\[/g)||[]).length;
    const blockCloses=(t.match(/\\\]/g)||[]).length;
    if(opens!==closes || blockOpens!==blockCloses){
      return 'FÓRMULA: delimitadores de notación matemática desequilibrados.';
    }
    const mathSegments=[...t.matchAll(/\\\(([\s\S]*?)\\\)|\\\[([\s\S]*?)\\\]/g)];
    for(const segment of mathSegments){
      const tex=segment[1]??segment[2]??'';
      let braces=0;
      for(const ch of tex){if(ch==='{')braces++;else if(ch==='}')braces--;if(braces<0)break;}
      if(braces!==0 || tex.length>1200){return 'FÓRMULA: llaves incorrectas o expresión demasiado larga.';}
    }
  }
  return null;
}
function legislationQuestionIssue(target,question){
  if(
    String(target?.topic_block || "")
      .trim()
      .toLowerCase() !== "legislacion"
  ){
    return null;
  }

  if(
    ["GRAFICA"]
      .includes(question?.questionFamily)
  ){
    return (
      "LEGISLACIÓN: familia de pregunta incompatible con el bloque."
    );
  }

  const stem=
    String(question?.stem || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g,"")
      .toLowerCase()
      .replace(/\s+/g," ")
      .trim();

  const forbidden=[
    /\bceis\s+guadalajara\b/,
    /\bmanual\s+elaborado\b/,
    /\bpagina\s+\d+\b/,
    /\bindice\b/,
    /\bestructura\s+(?:general|tematica|del\s+documento)\b/,
    /\bnumero\s+de\s+orden\b/,
    /\bocupa\s+(?:el\s+)?(?:primer|segundo|tercer|cuarto|quinto|sexto|septimo|octavo|noveno|decimo|\d+)\s+lugar\b/,
    /\borden\s+de\s+(?:los\s+)?apartados\b/
  ];

  if(forbidden.some(pattern=>pattern.test(stem))){
    return (
      "LEGISLACIÓN: el enunciado contiene una referencia editorial " +
      "o de manual prohibida para este bloque."
    );
  }

  const knownAmbiguity=legislationKnownAmbiguityIssue(question);
  if(knownAmbiguity){return knownAmbiguity;}

  // Control objetivo adicional para legislación reglamentaria: descarta
  // absolutos artificiales no sustentados que delatan opciones falsas.
  // No altera la baraja Anki; solo se utiliza para preguntas generadas.
  const evidence=String(question?.sourceEvidence||'')
    .normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
  const options=Array.isArray(question?.options)?question.options:[];
  const suspicious=[
    /\bautomaticamente\b/,
    /\bsin (?:ninguna|cualquier) limitacion\b/,
    /\bsiempre y en cualquier caso\b/,
    /\btotalmente exent[oa]s?\b/,
    /\ben exclusiva\b/,
    /\bprioritaria y exclusivamente\b/,
    /\bsin excepciones\b/
  ];
  for(const option of options){
    const text=String(option||'').normalize('NFD')
      .replace(/[\u0300-\u036f]/g,'').toLowerCase();
    if(suspicious.some(rx=>rx.test(text)&&!rx.test(evidence))){
      return 'LEGISLACIÓN: distractor con absoluto lingüístico evidente no sustentado en la fuente.';
    }
  }
  return null;
}

// Filtro conservador de pistas manifiestas observado en tests reales de
// Legislacion sin Anki. No analiza la veracidad de una opcion ni sustituye
// la validacion independiente del PDF. Solo se invoca con independentPdfCheck.
function hardLegislationDistractorIssue(question){
  const normalized=value=>String(value||'').normalize('NFD')
    .replace(/[\u0300-\u036f]/g,'').toLowerCase();
  const source=normalized(question?.sourceEvidence);
  const opts=Array.isArray(question?.options)?question.options:[];
  const patterns=[
    /\btotalmente prohibid[oa]s?\b/,
    /\ben cualquier circunstancia\b/,
    /\bde forma estricta\s+unicamente\b/,
    /\bsin restricciones de ningun tipo\b/,
    /\bse corresponde estrictamente\b/
  ];
  for(const option of opts){
    const text=normalized(option);
    for(const pattern of patterns){
      if(pattern.test(text) && !pattern.test(source)){
        return 'LEGISLACION (DIFICULTAD): opcion con una exageracion o absoluto no apoyado literalmente por sourceEvidence; reformular con una diferencia reglamentaria proxima.';
      }
    }
  }
  return null;
}

function coverageTargetsPrompt(targets){
  if(!targets.length) return "";

  return `

==================================================
OBJETIVOS OBLIGATORIOS DE COBERTURA
==================================================

${targets.some(item=>item.failedQuestion)
  ? `El sistema ha seleccionado ${targets.length} conocimientos previamente fallados que deben volver a evaluarse mediante variantes nuevas.`
  : `El sistema ha seleccionado ${targets.length} objetivos mediante selección adaptativa.

Estos objetivos pueden corresponder a:
- repasos SRS vencidos;
- conocimientos con errores o rendimiento débil;
- contenido todavía no trabajado;
- conocimientos ya trabajados que requieren mantenimiento.

Debes evaluar exactamente los objetivos seleccionados independientemente de que sean nuevos o ya hayan sido trabajados.`
}

Debes generar EXACTAMENTE UNA pregunta sobre CADA objetivo siguiente.
No sustituyas estos objetivos por otros conceptos que te parezcan más interesantes.
No concentres las preguntas en otros contenidos recuperados por File Search.

OBJETIVOS:

${targets.map((item,index)=>`
OBJETIVO ${index+1}
- Tema/documento obligatorio: ${item.topic_name || "No especificado"}
- Usa este tema/documento como fuente factual principal.
- EXCEPCIÓN GEOGRÁFICA CONTROLADA:
  si este objetivo incluye CONTEXTO TERRITORIAL DEL TEMA 21,
  puedes y debes utilizar ese contexto exclusivamente para determinar
  municipio/concejo -> sede/parque operativo exacto y para construir
  distractores territoriales plausibles.
- No utilices el Tema 21 para completar ningún otro dato del objetivo.
- Familia de pregunta asignada: ${item.questionFamily || "GENERAL"}
- Esta familia es OBLIGATORIA salvo imposibilidad factual demostrable.
- Apartado: ${item.section || "No especificado"}
- Concepto: ${geographyPromptSafeText(item,item.concept)}
- Tipo de contenido: ${item.item_type}
- Tipo de evaluación solicitado: ${item.evaluation_type}
- Dificultad adaptativa requerida: ${item.adaptiveDifficulty || "alta"}
- Página física PDF (uso interno): ${item.source_page ?? "No determinada"}
${item.manual_page
  ? `- Página impresa del manual (uso interno): ${item.manual_page}`
  : ""}
- Evidencia catalogada: ${geographyPromptSafeEvidence(item) || "No disponible"}
${item.territorialContext?.exact?.length ? `

- CONTEXTO TERRITORIAL DEL TEMA 21 — RELACIÓN OPERATIVA EXACTA:
${item.territorialContext.exact.map((contextItem,index)=>`
  ${index+1}. ${contextItem.concept}
`).join("")}

${item.territorialContext.nearby?.length ? `
- RELACIONES TERRITORIALES PRÓXIMAS PARA DISTRACTORES:
${item.territorialContext.nearby.map((contextItem,index)=>`
  ${index+1}. ${contextItem.concept}
`).join("")}
` : ""}

REGLAS TERRITORIALES OBLIGATORIAS:

- Si el tema objetivo muestra una denominación administrativa agrupada
  y el Tema 21 permite identificar la sede concreta, PREVALECE la
  asignación operativa concreta del Tema 21.

- Lodosa y Peralta/Azkoien son sedes operativas distintas.
- Altsasu/Alsasua y Auritz/Burguete son sedes operativas distintas.
- Navascués/Nabaskoze y Sangüesa/Zangoza son sedes operativas distintas.

- NO utilices la denominación administrativa agrupada como respuesta
  cuando pueda determinarse la sede concreta.

- Los distractores deben construirse preferentemente con municipios,
  sedes y parques de estas relaciones territoriales próximas.

- Para preguntas instalación -> municipio/parque:
  al menos DOS distractores deben diferir de la correcta únicamente
  en una relación territorial plausible.

- Es válido y recomendable usar municipios de la misma sede o de
  sedes territorialmente próximas para que el opositor tenga que
  conocer realmente la asignación.

- Evita como distractores parques evidentemente alejados o
  territorialmente absurdos cuando existan alternativas próximas.

- No inventes proximidades geográficas.
  Usa exclusivamente las relaciones suministradas aquí y las
  recuperadas del temario.

- Si utilizas información del Tema 21 para fijar la sede operativa,
  inclúyela también en sourceEvidence.
` : ""}
${blockQuestionPolicy(item)}
${geographyExamQuestionPolicy(item)}
${geographyOfficialArchetypePrompt(item,index)}
${geographyOptionPoolsPrompt(item)}
${Array.isArray(item.distractorContext) && item.distractorContext.length ? `
- BANCO FACTUAL CERCANO PARA CONSTRUIR DISTRACTORES:
${item.distractorContext.map((contextItem,contextIndex)=>`  ${contextIndex+1}. Apartado: ${contextItem.section || "No especificado"} | Concepto: ${geographyPromptSafeText(item,contextItem.concept)} | Evidencia: ${coverageTopicNumber(item?.topic_name)===22 ? geographyPromptSafeText(item,contextItem.concept) : (contextItem.source_evidence || "")}`).join("\n")}

REGLAS DE USO DEL BANCO FACTUAL:
- Este banco NO cambia el objetivo de la pregunta.
- Procede de unidades próximas del mismo tema y sirve para localizar confusiones reales.
- Prioriza estos hechos para construir los TRES distractores antes de inventar variantes.
- Confirma mediante File Search cualquier hecho contextual que vayas a utilizar.
- Puedes atribuir a propósito una propiedad real de un concepto próximo al elemento equivocado, intercambiar condiciones, pasos, cifras o categorías cercanas, siempre que la falsedad para ESTA pregunta quede demostrada por el temario.
- Está prohibido introducir maquinaria, procedimientos, materiales, magnitudes o situaciones que no aparezcan en el objetivo, en este banco factual o en contenido próximo recuperado mediante File Search.
- sourceEvidence debe incluir evidencia suficiente para demostrar la respuesta y, cuando se utilice este banco para los distractores, también la relación factual necesaria para explicar por qué esos distractores no son válidos para lo preguntado.
` : ""}
${item.failedQuestion ? `
- MODO REPASO DE FALLO:
  Este objetivo corresponde a un conocimiento previamente fallado.
- Dificultad de la pregunta fallada anterior:
  ${item.failed_difficulty || "alta"}

- Si la pregunta fallada anterior tenía difficulty="muy alta",
  esta nueva variante DEBE mantener difficulty="muy alta".
  En ese caso NO está permitido aplicar el fallback general a "alta".
  La nueva pregunta debe mantener como mínimo el nivel cognitivo y técnico
  de la pregunta fallada, sin inventar contenido externo ni fabricar
  dificultad artificial.
- PREGUNTA FALLADA ANTERIOR:
  ${item.failedQuestion.stem}

- OPCIONES ANTERIORES:
  ${JSON.stringify(item.failedQuestion.options)}

REGLAS OBLIGATORIAS PARA ESTA VARIANTE:
- Evalúa EXACTAMENTE el mismo conocimiento del objetivo.
- Genera una pregunta NUEVA.
- NO copies ni parafrasees superficialmente el enunciado anterior.
- NO reutilices el mismo conjunto de opciones.
- NO mantengas deliberadamente la respuesta correcta en la misma posición.
- Cambia el ángulo de evaluación cuando el temario lo permita:
  aplicación, discriminación, relación, identificación, secuencia, cálculo o precisión.
- La dificultad debe ser igual o superior a la pregunta anterior.
- La respuesta debe seguir siendo demostrable exclusivamente con el temario.
- El objetivo es comprobar que el opositor ha aprendido el CONOCIMIENTO,
  no que recuerda la redacción o la posición de una respuesta.
` : ""}
${item.previousBankQuestion ? `
- PREGUNTA RECIENTE DEL BANCO SOBRE ESTE MISMO CONOCIMIENTO:
  ${item.previousBankQuestion.stem}

- OPCIONES DE ESA PREGUNTA:
  ${JSON.stringify(item.previousBankQuestion.options)}

REGLAS ANTIRREPETICIÓN:
- Evalúa el mismo conocimiento objetivo, pero genera una pregunta NUEVA.
- NO copies el enunciado anterior.
- NO hagas una paráfrasis superficial conservando la misma estructura.
- NO reutilices el mismo conjunto de opciones.
- Cambia el ángulo de evaluación cuando el temario lo permita.
- Mantén la familia de pregunta asignada y la dificultad adaptativa requerida.
- La variedad nunca autoriza a introducir información ajena al temario.
` : ""}
${item.questionFamily === "GRAFICA" && item.graphicAsset ? `
- TRATAMIENTO GRÁFICO OBLIGATORIO:
  Esta pregunta dispone de un asset gráfico REAL previamente analizado.
  Debes utilizar EXCLUSIVAMENTE este asset.

- ASSET ID: ${item.graphicAsset.id}
- SOURCE ID: ${item.graphicAsset.source_id}
- URL PÚBLICA: ${item.graphicAsset.public_url}
- TIPO DE ASSET: ${item.graphicAsset.asset_type}
- CONCEPTO: ${item.graphicAsset.concept || "No especificado"}
- DESCRIPCIÓN VISUAL: ${item.graphicAsset.description || "No disponible"}

- RECORTE NORMALIZADO:
  x: ${item.graphicAsset.crop_x ?? 0}
  y: ${item.graphicAsset.crop_y ?? 0}
  width: ${item.graphicAsset.crop_width ?? 1}
  height: ${item.graphicAsset.crop_height ?? 1}

El campo graphic de la pregunta debe devolver EXACTAMENTE:

{
  "assetId": ${item.graphicAsset.id},
  "sourceId": ${JSON.stringify(item.graphicAsset.source_id)},
  "publicUrl": ${JSON.stringify(item.graphicAsset.public_url)},
  "assetType": ${JSON.stringify(item.graphicAsset.asset_type)},
  "concept": ${JSON.stringify(item.graphicAsset.concept || "")},
  "description": ${JSON.stringify(item.graphicAsset.description || "")},
  "crop": {
    "x": ${Number(item.graphicAsset.crop_x ?? 0)},
    "y": ${Number(item.graphicAsset.crop_y ?? 0)},
    "width": ${Number(item.graphicAsset.crop_width ?? 1)},
    "height": ${Number(item.graphicAsset.crop_height ?? 1)}
  }
}

REGLAS:
- Conserva assetId, sourceId, publicUrl, assetType, concept, description y crop EXACTAMENTE.
- No inventes otro asset, no modifiques URL, identificadores ni crop y no generes ningún dibujo nuevo.
- No construyas graphic.elements.
- REGLA DE LENGUAJE VISIBLE OBLIGATORIA:
  En stem, options y explanation está absolutamente prohibido mostrar
  terminología interna de la aplicación.

  Nunca escribas: "asset", "graphicAsset", "assetId", "sourceId",
  "publicUrl", "crop", "metadata", "metadatos" ni nombres internos equivalentes.

  Para referirte al contenido visual utiliza únicamente términos naturales
  para un examen: "imagen", "figura", "esquema", "ilustración",
  "representación" o directamente el elemento técnico mostrado.

  El opositor nunca debe poder deducir que la imagen procede de un sistema
  interno de assets.
- La imagen y sus metadatos visuales sirven EXCLUSIVAMENTE para identificar,
  seleccionar y mostrar el asset.
- concept, description, sourceId, nombre de archivo y cualquier descripción
  obtenida del análisis visual NO son fuente factual.

- TODA afirmación técnica de esta pregunta debe proceder del TEMARIO recuperado
  mediante File Search: significado técnico, aplicación, condiciones de uso,
  procedimiento, respuesta correcta, distractores, explanation y sourceEvidence.

- La imagen determina QUÉ se observa.
  El TEMARIO determina QUÉ significa técnicamente.

- Antes de formular la pregunta, recupera del TEMARIO evidencia textual que
  sustente específicamente el concepto representado por el asset.
- Si esa evidencia no permite determinar con seguridad qué representa, para qué
  se utiliza o cuáles son sus características, NO completes la información
  mediante inferencia visual: aplica el fallback de familia.

- sourceEvidence debe contener EXCLUSIVAMENTE texto factual recuperado del
  TEMARIO. Nunca utilices como sourceEvidence la descripción visual del asset.
- manualPage debe corresponder EXCLUSIVAMENTE a la evidencia factual recuperada
  del TEMARIO. Nunca deduzcas la página desde el asset o sus metadatos.
- correctIndex, options y explanation deben quedar completamente respaldados
  por esa evidencia factual.
- Si existe cualquier contradicción entre los metadatos visuales y el TEMARIO,
  prevalece SIEMPRE el TEMARIO.
- La imagen debe formar parte real de la tarea: el opositor debe observar,
  identificar, distinguir, comparar, localizar, interpretar o relacionar
  algún elemento visual concreto del asset.
- NO es necesario que la respuesta sea imposible de deducir para un opositor
  que ya conozca perfectamente el contenido teórico.
- La pregunta sigue siendo GRAFICA aunque el concepto representado también
  esté definido textualmente en el TEMARIO.
- La imagen solo será decorativa si el enunciado no exige observar ni
  interpretar ningún elemento visual concreto de ella.
- No describas en el enunciado ni en las opciones la característica visual
  concreta que el opositor debe reconocer en la imagen.
` : ""}
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
- La asignación GRAFICA nunca autoriza a inventar un dibujo cuando la fuente no sustenta una representación técnica inequívoca.
`;
}
async function getLatestBankQuestionForTarget(target){

  if(!target?.id){
    return null;
  }

  const result = await db.query(
    `
    SELECT
      stem,
      options
    FROM question_bank
    WHERE
      coverage_item_id = $1
      AND active = TRUE
      AND graphic IS NULL
    ORDER BY
      last_shown_at DESC NULLS LAST,
      id DESC
    LIMIT 1
    `,
    [Number(target.id)]
  );

  if(!result.rows.length){
    return null;
  }

  return {
    stem: result.rows[0].stem,
    options: Array.isArray(result.rows[0].options)
      ? result.rows[0].options
      : []
  };
}
async function getReusableQuestionForTarget(target, difficulty){

  if(!target?.id){
    return null;
  }
if(target.questionFamily === "GRAFICA"){
  return null;
}
  /*
  No reutilizamos una pregunta literal cuando:

  - el conocimiento acaba de fallarse;
  - es contenido nuevo;
  - todavía no existe historial suficiente.

  En esos casos interesa generar una variante nueva.
  */
  if(
  target.failedQuestion ||
  target.latest_nonblank_failed === true ||
  target.worked === false ||
  Number(target.times_asked || 0) < 2
){
  return null;
}

  const result = await db.query(
    `
    SELECT
      id,
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
      times_shown,
      times_correct,
      times_wrong,
      times_blank,
      last_shown_at

    FROM question_bank

    WHERE
  coverage_item_id = $1
  AND active = TRUE
  AND validation_version >= 6
  AND difficulty = $2
  AND question_family = $3
  AND graphic IS NULL
  AND (
  last_shown_at IS NULL
  OR last_shown_at <= NOW() - INTERVAL '30 days'
)

    ORDER BY
      times_shown ASC,
      last_shown_at ASC NULLS FIRST,
      id ASC

    LIMIT 1
    `,
    [
  Number(target.id),
  difficulty,
  target.questionFamily
]
  );

  if(!result.rows.length){
    return null;
  }

  const row = result.rows[0];

  return {
    questionId:Number(row.id),

    coverageItemId:
      Number(row.coverage_item_id),

    stem:row.stem,

    options:Array.isArray(row.options)
      ? row.options
      : [],

    correctIndex:
      Number(row.correct_index),

    explanation:
      row.explanation || "",

    sourceEvidence:
      row.source_evidence || "",

    sourcePage:
      row.source_page ?? null,

    manualPage:
      row.manual_page ?? null,

    questionFamily:
      row.question_family,

    difficulty:
      row.difficulty,

    graphic:
      row.graphic || null,

    reused:true
  };
}
async function isExactBankDuplicate(target, question){
  if(!target?.id || !question?.stem || !Array.isArray(question?.options)){
    return false;
  }
  // En Legislación también se comparan preguntas de otros coverage_items
  // pertenecientes al mismo tema. Evita regenerar idénticos enunciados
  // al avanzar de un epígrafe a otro sin alterar el banco persistente.
  const isLegal=String(target.topic_block||'').trim().toLowerCase()==='legislacion';
  const result=await db.query(`
    SELECT qb.id
    FROM question_bank qb
    WHERE qb.active=TRUE AND (
      (qb.coverage_item_id=$1
       AND LOWER(TRIM(qb.stem))=LOWER(TRIM($2))
       AND qb.options=$3::jsonb)
      OR ($4::int IS NOT NULL
        AND EXISTS (SELECT 1 FROM coverage_items ci
                    WHERE ci.id=qb.coverage_item_id AND ci.topic_id=$4)
        AND LOWER(REGEXP_REPLACE(TRIM(qb.stem),'[[:space:]]+',' ','g')) =
            LOWER(REGEXP_REPLACE(TRIM($2),'[[:space:]]+',' ','g')))
    ) LIMIT 1
  `,[Number(target.id),String(question.stem),JSON.stringify(question.options),
     isLegal ? Number(target.topic_id) : null]);
  return result.rows.length>0;
}
async function persistGeneratedTest({
  questions,
  targets,
  requestedCount,
  difficulty,
  mode,
  testType = "normal"
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
    `SELECT id
FROM question_bank
WHERE id = $1
  AND coverage_item_id = $2
  AND active = TRUE
  AND validation_version >= 6
LIMIT 1`,
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

  questionId = Number(question.questionId);
await client.query(
  `UPDATE question_bank
   SET
     last_shown_at = NOW(),
     updated_at = NOW()
   WHERE id = $1`,
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
async function validateDistractorCompetitiveness(ai, questions){
  const schema = {
    type:"object",
    properties:{
      results:{
        type:"array",
        items:{
          type:"object",
          properties:{
            index:{
              type:"integer",
              minimum:0
            },
            answerStandsOut:{
              type:"boolean"
            },
            answerStandoutReason:{
              type:"string"
            },
            assessments:{
              type:"array",
              minItems:3,
              maxItems:3,
              items:{
                type:"object",
                properties:{
  optionIndex:{
    type:"integer",
    minimum:0,
    maximum:3
  },
  competitive:{
    type:"boolean"
  },
  sameTechnicalAxis:{
    type:"boolean"
  },
  confusionAnchor:{
    type:"string"
  },
  reason:{
    type:"string"
  }
},
required:[
  "optionIndex",
  "competitive",
  "sameTechnicalAxis",
  "confusionAnchor",
  "reason"
]
              }
            }
          },
          required:[
            "index",
            "answerStandsOut",
            "answerStandoutReason",
            "assessments"
          ]
        }
      }
    },
    required:["results"]
  };

  schema.properties.results.minItems = questions.length;
  schema.properties.results.maxItems = questions.length;

  const compactQuestions = questions.map((question,index)=>({
    index,
    stem:question.stem,
    options:question.options,
    correctIndex:question.correctIndex,
    questionFamily:question.questionFamily,
    difficulty:question.difficulty,
    sourceEvidence:question.sourceEvidence
  }));
const normalizeAuditText = value =>
  String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g,"")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g," ")
    .replace(/\s+/g," ")
    .trim();

const auditStopWords = new Set([
  "para","como","desde","hasta","entre","sobre","donde","cuando",
  "cual","cuales","esta","este","estos","estas","una","uno","unos",
  "unas","del","las","los","que","con","sin","por","sus","se","al",
  "de","la","el","y","o","en","un"
]);

const contentTokens = value =>
  normalizeAuditText(value)
    .split(" ")
    .filter(token =>
      token.length >= 5 &&
      !auditStopWords.has(token)
    );

const absoluteTerms = [
  "siempre",
  "nunca",
  "exclusivamente",
  "unicamente",
  "obligatoriamente",
  "invariablemente",
  "instantaneamente",
  "rigurosamente",
  "exactamente",
  "completamente",
  "cualquier",
  "por completo"
];

const unsupportedAbsoluteTerms = (optionText,sourceEvidence) => {
  const option = normalizeAuditText(optionText);
  const source = normalizeAuditText(sourceEvidence);

  return absoluteTerms.filter(term =>
    option.includes(term) &&
    !source.includes(term)
  );
};

const lexicalAxisCheck = (optionText,question) => {
  const optionTokens =
    [...new Set(contentTokens(optionText))];

  if(optionTokens.length < 6){
    return {
      valid:true,
      ratio:1
    };
  }

  const referenceTokens = new Set(
    contentTokens(
      `${question.stem || ""} ${question.sourceEvidence || ""}`
    )
  );

  const shared =
    optionTokens.filter(token =>
      referenceTokens.has(token)
    ).length;

  const ratio =
    optionTokens.length
      ? shared / optionTokens.length
      : 1;

  return {
    valid:ratio >= 0.35,
    ratio
  };
};
  const prompt = `
Actúa exclusivamente como AUDITOR ADVERSARIAL DE DISTRACTORES
para preguntas tipo test de una oposición de Bomberos.

NO debes comprobar si correctIndex es correcto.
ASUME siempre que correctIndex identifica la respuesta que debe marcar
el opositor.

sourceEvidence contiene el fragmento factual del temario que respalda
la pregunta.

Tu trabajo consiste en auditar INDIVIDUALMENTE las TRES opciones cuyo
índice sea distinto de correctIndex.

Para cada una debes devolver además:

sameTechnicalAxis=true únicamente cuando la alternativa evalúa el MISMO
dato, propiedad, procedimiento, condición, relación, magnitud o concepto
concreto que la respuesta correcta. Compartir tema general no basta.

confusionAnchor debe ser una COPIA LITERAL de un fragmento concreto de
sourceEvidence que explique por qué la alternativa podría confundirse
razonablemente con el conocimiento correcto.

REGLAS PARA confusionAnchor:
- debe aparecer literalmente en sourceEvidence;
- no lo parafrasees;
- debe contener suficiente información técnica para justificar la confusión;
- no uses títulos genéricos ni palabras aisladas;
- si no existe un fragmento real que justifique esa confusión,
  devuelve confusionAnchor="" y competitive=false.

competitive=true:
solo cuando esa alternativa puede competir razonablemente con la
respuesta correcta ante un opositor preparado, sameTechnicalAxis=true
y confusionAnchor contiene una base factual real de sourceEvidence.

competitive=false:
cuando pueda eliminarse sin recordar con precisión el conocimiento
preguntado, cuando no pertenezca al mismo eje técnico o cuando no exista
una base concreta en sourceEvidence que justifique la confusión.
MARCA competitive=false si ocurre cualquiera de estas situaciones:

1. La opción pertenece a otro eje conceptual.

2. Introduce maquinaria, procedimientos, variables, magnitudes,
   fenómenos o condiciones ajenos al conocimiento evaluado.

3. Puede eliminarse por sentido común.

4. Contiene una exageración, formulación extrema, acción manifiestamente
   improcedente o detalle técnicamente pintoresco.

5. Utiliza palabras como "exclusivamente", "únicamente", "siempre",
   "nunca", "por completo", "instantáneamente", "rigurosamente",
   "exactamente" u otros absolutos de manera artificial.

6. En una pregunta numérica utiliza otro tipo de magnitud o un valor
   claramente lejano en vez de un dato próximo y confundible.

7. En una pregunta de fórmula contiene una expresión dimensional o
   algebraicamente absurda.

8. En una secuencia introduce pasos ajenos al procedimiento en lugar de
   modificar plausiblemente el orden, posición o condición de pasos
   reales próximos.

9. Suena técnica, pero no constituye una confusión razonable respecto
   al contenido de sourceEvidence.

10. Un opositor podría descartarla sin necesitar recordar el dato,
    condición, procedimiento, relación o concepto exacto del temario.

Además evalúa answerStandsOut.

answerStandsOut se refiere EXCLUSIVAMENTE a una pista visible de
redacción, estructura o plausibilidad que permita localizar la opción
correctIndex sin dominar el conocimiento preguntado.

NO marques answerStandsOut=true simplemente porque la opción correctIndex:
- coincida mejor con sourceEvidence;
- reproduzca con mayor exactitud el dato verdadero;
- sea factual o técnicamente correcta;
- sea la única respaldada plenamente por el temario.

Eso es normal y NO constituye una pista.

Marca answerStandsOut=true únicamente cuando la opción correctIndex
resulte identificable por su FORMA, por ejemplo:
- lenguaje absoluto o extremo artificial;
- afirmación manifiestamente absurda;
- concepto perteneciente a otro eje técnico;
- longitud o grado de detalle claramente diferente;
- terminología impropia;
- procedimiento evidentemente disparatado;
- redacción artificial que la haga destacar.

REGLA ESPECIAL PARA 2026_INCORRECTA:

En esta familia correctIndex identifica precisamente la afirmación FALSA
que debe marcar el opositor.

Por tanto, answerStandsOut=true si esa afirmación falsa resulta demasiado
fácil de localizar por ser extrema, absoluta, absurda, ajena al mismo eje
conceptual o claramente menos plausible que las tres afirmaciones verdaderas.

La falsedad debe ser sutil y técnicamente próxima.

IMPORTANTE:

- Evalúa exactamente TRES alternativas por pregunta.
- No evalúes como distractor la opción correctIndex.
- Devuelve sus índices reales: 0, 1, 2 o 3.
- No seas benevolente.
- No agrupes el juicio de las tres alternativas.
- Cada distractor debe superar el estándar por sí mismo.
- Que una alternativa sea falsa no significa que sea un buen distractor.
- Que utilice vocabulario técnico tampoco significa que sea competitiva.
- No inventes un confusionAnchor para justificar una opción débil.
- Si dudas entre true y false, devuelve competitive=false.
PREGUNTAS:
${JSON.stringify(compactQuestions)}
`;

  const response = await ai.models.generateContent({
    model:"gemini-3.5-flash-lite",
    contents:prompt,
    config:{
      responseMimeType:"application/json",
      responseJsonSchema:schema,
      temperature:0.1
    }
  });

  const parsed = JSON.parse(response.text);

  if(
    !Array.isArray(parsed.results) ||
    parsed.results.length !== questions.length
  ){
    throw new Error(
      "El auditor independiente de distractores devolvió un número incorrecto de resultados."
    );
  }

  const resultsByIndex = new Map();

for(const result of parsed.results){
  const index = Number(result.index);

  if(
    !Number.isInteger(index) ||
    index < 0 ||
    index >= questions.length ||
    resultsByIndex.has(index)
  ){
    throw new Error(
      "El auditor independiente de distractores devolvió índices inválidos o duplicados."
    );
  }

  resultsByIndex.set(index,result);
}

if(resultsByIndex.size !== questions.length){
  throw new Error(
    "El auditor independiente de distractores no devolvió todos los índices esperados."
  );
}

const normalizedResults = [];

for(let i=0;i<questions.length;i++){
  const result = resultsByIndex.get(i);
  const question = questions[i];

  const expectedIndexes = [0,1,2,3]
    .filter(index =>
      index !== Number(question.correctIndex)
    );

  const assessments =
    Array.isArray(result.assessments)
      ? result.assessments
      : [];

  const receivedIndexes = assessments
    .map(item => Number(item.optionIndex))
    .sort((a,b) => a-b);

  const sortedExpected = [...expectedIndexes]
    .sort((a,b) => a-b);

  if(
    assessments.length !== 3 ||
    JSON.stringify(receivedIndexes) !==
      JSON.stringify(sortedExpected)
  ){
    throw new Error(
      `El auditor de distractores devolvió alternativas incorrectas en la pregunta ${i + 1}.`
    );
  }

  const sourceNormalized =
    normalizeAuditText(question.sourceEvidence);

  const auditedAssessments =
    assessments.map(item => {
      const optionIndex =
        Number(item.optionIndex);

      const optionText =
        question.options?.[optionIndex] || "";

      const anchorNormalized =
        normalizeAuditText(item.confusionAnchor);

      const anchorValid =
        anchorNormalized.length >= 12 &&
        sourceNormalized.includes(anchorNormalized);

      const unsupportedAbsolutes =
        unsupportedAbsoluteTerms(
          optionText,
          question.sourceEvidence
        );

      const axisCheck =
        lexicalAxisCheck(
          optionText,
          question
        );

      const locallyCompetitive =
        item.competitive === true &&
        item.sameTechnicalAxis === true &&
        anchorValid &&
        unsupportedAbsolutes.length === 0 &&
        axisCheck.valid === true;

      const localIssues = [];

      if(item.competitive !== true){
        localIssues.push(item.reason);
      }

      if(item.sameTechnicalAxis !== true){
        localIssues.push(
          "No pertenece al mismo eje técnico concreto."
        );
      }

      if(!anchorValid){
        localIssues.push(
          "No aporta un confusionAnchor literal y suficiente de sourceEvidence."
        );
      }

      if(unsupportedAbsolutes.length){
        localIssues.push(
          `Usa absolutos no respaldados por sourceEvidence: ${unsupportedAbsolutes.join(", ")}.`
        );
      }

      if(axisCheck.valid !== true){
        localIssues.push(
          `Se aleja léxicamente del conocimiento evaluado (ratio ${axisCheck.ratio.toFixed(2)}).`
        );
      }

      return {
        optionIndex,
        locallyCompetitive,
        localIssues
      };
    });

  const competitiveCount =
    auditedAssessments.filter(item =>
      item.locallyCompetitive === true
    ).length;

  const distractorIssues =
    auditedAssessments
      .filter(item =>
        item.locallyCompetitive !== true
      )
      .map(item =>
        `Opción ${item.optionIndex + 1}: ${item.localIssues.join(" ")}`
      );

  if(result.answerStandsOut === true){
    distractorIssues.push(
      `AVISO DE REDACCIÓN: ${result.answerStandoutReason}`
    );
  }

  let incorrectAnswerStandsOut =
    question.questionFamily === "2026_INCORRECTA" &&
    result.answerStandsOut === true;

  if(question.questionFamily === "2026_INCORRECTA"){
    const correctOption =
      question.options?.[
        Number(question.correctIndex)
      ] || "";

    const unsupportedCorrectAbsolutes =
      unsupportedAbsoluteTerms(
        correctOption,
        question.sourceEvidence
      );

    const correctAxisCheck =
      lexicalAxisCheck(
        correctOption,
        question
      );

    if(
      unsupportedCorrectAbsolutes.length ||
      correctAxisCheck.valid !== true
    ){
      incorrectAnswerStandsOut = true;

      if(unsupportedCorrectAbsolutes.length){
        distractorIssues.push(
          `OPCIÓN INCORRECTA DEMASIADO EVIDENTE: absolutos no respaldados por sourceEvidence: ${unsupportedCorrectAbsolutes.join(", ")}.`
        );
      }

      if(correctAxisCheck.valid !== true){
        distractorIssues.push(
          `OPCIÓN INCORRECTA DEMASIADO ALEJADA DEL EJE TÉCNICO (ratio ${correctAxisCheck.ratio.toFixed(2)}).`
        );
      }
    }
  }

  normalizedResults.push({
    index:i,
    distractorsValid:
      competitiveCount === 3 &&
      !incorrectAnswerStandsOut,
    distractorIssues
  });
}


  
return normalizedResults;
}
function geographyForbiddenQuestionIssue(target,question){
  const topicNumber=
    coverageTopicNumber(target?.topic_name);

  const rules={
    22:[
      /\bsuperficie\b/,
      /\bperimetro\b/,
      /\barea\s+(?:total|exacta|registrada|del|de la)\b/,
      /\bm2\b/,
      /\bmetros?\s+cuadrados?\b/,
      /\bnumero\s+de\s+fila\b/,
      /\bfila\s+\d+\b/
    ],
    23:[
      /\bpromotor(?:a)?\b/,
      /\bpotencia\b/,
      /\bmegavatios?\b/,
      /\bkilovatios?\b/,
      /\bmw\b/,
      /\bkw\b/,
      /\b(?:puesta|entrada|entro)\s+en\s+servicio\b/,
      /\bano\s+(?:de\s+)?(?:puesta|entrada)\s+en\s+servicio\b/
    ],
    24:[
      /\bpromotor(?:a)?\b/,
      /\bpotencia\b/,
      /\bproduccion\b/,
      /\bmegavatios?\b/,
      /\bkilovatios?\b/,
      /\bmw\b/,
      /\bkw\b/,
      /\b(?:puesta|entrada|entro)\s+en\s+servicio\b/,
      /\bnumero\s+de\s+aerogeneradores\b/,
      /\bcuantos?\s+aerogeneradores\b/
    ]
  };

  const forbidden=
    rules[topicNumber];

  if(!forbidden){
    return null;
  }

  const visibleText=[
    question?.stem,
    ...(Array.isArray(question?.options)
      ? question.options
      : [])
  ]
    .filter(Boolean)
    .join(" ")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g,"")
    .replace(/²/g,"2")
    .toLowerCase();

  if(forbidden.some(pattern=>pattern.test(visibleText))){
    return (
      `RELEVANCIA GEOGRÁFICA: la pregunta del Tema ${topicNumber} ` +
      `contiene datos expresamente prohibidos para esta oposición.`
    );
  }

  return null;
}
function geographyOperationalParkIssue(target,question){
  const exact =
    Array.isArray(
      target?.territorialContext?.exact
    )
      ? target.territorialContext.exact
      : [];

  if(!exact.length){
    return null;
  }

  const normalize=value=>
    String(value || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g,"")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g," ")
      .trim()
      .replace(/\s+/g," ");

  const stem=
    normalize(question?.stem);

  const asksOperationalPark=
    /\b(parque|bomberos|moviliz|competente|referencia|cobertura|atendid|adscripcion|servicio)\b/
      .test(stem);

  if(!asksOperationalPark){
    return null;
  }

  const correctOption=
    question?.options?.[
      Number(question.correctIndex)
    ] || "";

  const normalizedCorrect=
    normalize(correctOption);

  const exactAreas=[
    ...new Set(
      exact
        .map(item=>
          normalize(
            item.operationalArea ||
            String(item.concept || "")
              .split("->")
              .slice(1)
              .join("->")
          )
        )
        .filter(Boolean)
    )
  ];

  if(exactAreas.length !== 1){
    return null;
  }

  const exactArea=
    exactAreas[0]
      .replace(/^sede de /,"")
      .replace(/^parque de /,"")
      .trim();

  const groupedAdministrativeLabels=[
    /lodosa peralta azkoien/,
    /altsasu alsasua auritz burguete/,
    /navascues nabaskoze sanguesa zangoza/
  ];

  if(
    groupedAdministrativeLabels.some(
      pattern=>pattern.test(normalizedCorrect)
    )
  ){
    return (
      "GEOGRAFÍA OPERATIVA: se ha utilizado como respuesta " +
      "un parque agrupado administrativamente cuando el Tema 21 " +
      "permite determinar la sede operativa concreta."
    );
  }

  if(
    exactArea &&
    !normalizedCorrect.includes(exactArea)
  ){
    return (
      "GEOGRAFÍA OPERATIVA: la respuesta correcta no coincide " +
      "con la sede/parque operativo exacto determinado por el Tema 21."
    );
  }

  return null;
}
function geographyOptionPoolIssue(target,question){

  const topicNumber=
    coverageTopicNumber(
      target?.topic_name
    );

  if(
    !Number.isInteger(topicNumber) ||
    topicNumber < 21 ||
    topicNumber > 25
  ){
    return null;
  }

  const pools=
    target?.optionPools;

  if(!pools){
    return null;
  }

  const options=
    Array.isArray(question?.options)
      ? question.options
      : [];

  if(options.length !== 4){
    return null;
  }

  const correctIndex=
    Number(question?.correctIndex);

  if(
    !Number.isInteger(correctIndex) ||
    correctIndex < 0 ||
    correctIndex > 3
  ){
    return null;
  }

  const normalize=value=>
    String(value || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g,"")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g," ")
      .trim()
      .replace(/\s+/g," ");

  const normalizeEntity=value=>
    normalize(value)
      .replace(
        /^(?:municipio|concejo|localidad)\s+de\s+/,
        ""
      )
      .replace(
        /^(?:parque\s+de\s+bomberos|parque|sede)\s+de\s+/,
        ""
      )
      .trim();

  const matchesEntity=(value,entity)=>{
    const option=
      normalizeEntity(value);

    const candidate=
      normalizeEntity(entity);

    return (
      option &&
      candidate &&
      option === candidate
    );
  };

  const matchesAny=(value,entities)=>
    entities.some(entity=>
      matchesEntity(
        value,
        entity
      )
    );

  const stem=
    normalize(question?.stem);

  const complexQuestion=
    /\b(?:incorrecta|incorrecto|combinacion|afirmaciones|relaciones|correspondencia)\b/
      .test(stem);

  const asksMunicipality=
    !complexQuestion &&
    (
      /\ben que municipio\b/.test(stem) ||
      /\ba que municipio\b/.test(stem) ||
      /\bque municipio\b/.test(stem) ||
      /\bcual es el municipio\b/.test(stem)
    );

  const asksOperationalPark=
    !complexQuestion &&
    (
      /\bque parque(?: de bomberos)?\b/.test(stem) ||
      /\bcual es el parque(?: de bomberos)?\b/.test(stem) ||
      /\bque sede\b/.test(stem) ||
      /\bcual es la sede\b/.test(stem)
    );

  const asksConcejoExclusion=
    /\bconcejos?\b/.test(stem) &&
    (
      /\bno pertenece\b/.test(stem) ||
      /\bno pertenecen\b/.test(stem) ||
      /\bno forma parte\b/.test(stem)
    );

  /*
  ================================================
  1. PREGUNTA SIMPLE DE MUNICIPIO
  ================================================
  */

  if(asksMunicipality){

    const correctLocation=
      pools.correctLocation;

    if(!correctLocation){
      return null;
    }

    const correctOption=
      options[correctIndex];

    if(
      !matchesEntity(
        correctOption,
        correctLocation
      )
    ){
      return (
        "GEOGRAFÍA — MUNICIPIO: la opción marcada como correcta " +
        "no coincide con el municipio/localidad factual del objetivo."
      );
    }

    const candidates=
      Array.isArray(
        pools.municipalitiesSameOperationalArea
      )
        ? pools.municipalitiesSameOperationalArea
            .map(row=>row?.entity)
            .filter(Boolean)
        : [];

    /*
    Solo hacemos obligatorio el pool cuando
    realmente tenemos tres distractores disponibles.
    */
    if(candidates.length >= 3){

      for(let i=0;i<options.length;i++){

        if(i===correctIndex){
          continue;
        }

        if(
          !matchesAny(
            options[i],
            candidates
          )
        ){
          return (
            "GEOGRAFÍA — DISTRACTOR TERRITORIAL: una pregunta " +
            "de municipio contiene un distractor que no procede " +
            "del pool competitivo del mismo ámbito operativo."
          );
        }
      }
    }
  }

  /*
  ================================================
  2. PREGUNTA SIMPLE DE PARQUE/SEDE
  ================================================
  */

  if(asksOperationalPark){

    const correctAreas=
      Array.isArray(
        pools.correctOperationalAreas
      )
        ? [
            ...new Set(
              pools.correctOperationalAreas
                .filter(Boolean)
            )
          ]
        : [];

    /*
    Solo imponemos una respuesta exacta cuando
    el objetivo conduce inequívocamente a UNA sede.
    */
    if(correctAreas.length === 1){

      const correctOption=
        options[correctIndex];

      if(
        !matchesEntity(
          correctOption,
          correctAreas[0]
        )
      ){
        return (
          "GEOGRAFÍA — PARQUE OPERATIVO: la opción correcta " +
          "no coincide con la sede/parque exacto determinado " +
          "por el Tema 21."
        );
      }

      const alternatives=
        Array.isArray(
          pools.alternativeOperationalAreas
        )
          ? pools.alternativeOperationalAreas
              .map(
                row=>row?.operationalArea
              )
              .filter(Boolean)
          : [];

      if(alternatives.length >= 3){

        for(let i=0;i<options.length;i++){

          if(i===correctIndex){
            continue;
          }

          if(
            !matchesAny(
              options[i],
              alternatives
            )
          ){
            return (
              "GEOGRAFÍA — DISTRACTOR DE PARQUE: una alternativa " +
              "no procede del pool factual de sedes/parques disponibles."
            );
          }
        }
      }
    }
  }

  /*
  ================================================
  3. CONCEJO QUE NO PERTENECE AL MUNICIPIO
  ================================================

  Estructura obligatoria cuando existen datos:
  3 concejos verdaderos del municipio
  +
  1 concejo real de otro municipio del mismo ámbito.

  La opción de otro municipio debe ser correctIndex
  porque la pregunta solicita el que NO pertenece.
  */

  if(asksConcejoExclusion){

    const sameMunicipality=
      Array.isArray(
        pools.subordinatesSameMunicipality
      )
        ? pools.subordinatesSameMunicipality
            .map(row=>row?.entity)
            .filter(Boolean)
        : [];

    const otherMunicipalities=
      Array.isArray(
        pools.subordinatesOtherMunicipalitiesSameOperationalArea
      )
        ? pools.subordinatesOtherMunicipalitiesSameOperationalArea
            .map(row=>row?.entity)
            .filter(Boolean)
        : [];

    if(
      sameMunicipality.length >= 3 &&
      otherMunicipalities.length >= 1
    ){

      let sameCount=0;
      let otherCount=0;

      for(let i=0;i<options.length;i++){

        const inSame=
          matchesAny(
            options[i],
            sameMunicipality
          );

        const inOther=
          matchesAny(
            options[i],
            otherMunicipalities
          );

        if(inSame){
          sameCount++;
        }

        if(inOther){
          otherCount++;
        }

        if(
          i===correctIndex &&
          !inOther
        ){
          return (
            "GEOGRAFÍA — CONCEJOS: en una pregunta de NO pertenencia, " +
            "la opción marcada como correcta debe ser un concejo real " +
            "de otro municipio territorialmente plausible."
          );
        }

        if(
          i!==correctIndex &&
          !inSame
        ){
          return (
            "GEOGRAFÍA — CONCEJOS: las tres opciones que sí pertenecen " +
            "deben ser concejos reales del municipio preguntado."
          );
        }
      }

      if(
        sameCount !== 3 ||
        otherCount !== 1
      ){
        return (
          "GEOGRAFÍA — CONCEJOS: la pregunta no respeta la estructura " +
          "3 concejos reales del municipio + 1 concejo real de otro municipio."
        );
      }
    }
  }

  /*
  ================================================
  4. OPCIONES DUPLICADAS
  ================================================
  */

  const normalizedOptions=
    options.map(
      normalizeEntity
    );

  if(
    new Set(
      normalizedOptions
    ).size !== 4
  ){
    return (
      "GEOGRAFÍA — OPCIONES: existen alternativas duplicadas " +
      "o equivalentes dentro de la misma pregunta."
    );
  }

  return null;
}
async function validateGeneratedQuestions(ai,questions,{independentPdfCheck=false,targets=[]}={}){
  const independentInstructions=independentPdfCheck ? `
============================================
VERIFICACIÓN REGLAMENTARIA INDEPENDIENTE
============================================
Esta muestra consta de preguntas nuevas de legislación SIN Anki.
No aceptes sourceEvidence como demostración suficiente de veracidad: fue
redactado por el generador y puede contener errores u omisiones.
Busca en File Search del TEMARIO ORIGINAL el pasaje concreto que determina la
verdad o falsedad de CADA una de las cuatro alternativas; incluye condiciones
que pudieran convertir en válidas varias respuestas.

OBJETIVOS CURRICULARES (solo para localizar fragmentos; no son autoridad):
${JSON.stringify(targets.map((target,index)=>({index,topic:target.topic_name,section:target.section,concept:target.concept})))}

Para cada pregunta, devuelve optionAssessment con exactamente 4 etiquetas,
en orden A, B, C, D. Usa:
- ANSWER: satisface inequívocamente lo solicitado en el enunciado;
- DISTRACTOR: no satisface lo solicitado según la norma recuperada;
- UNVERIFIABLE: no puede justificarse o descartarse con datos recuperados.

Una afirmación VERDADERA pero incompleta NO pasa a ser falsa por omitir
otros requisitos: interpreta la afirmación que realmente dice.

La respuesta es válida solo si hay EXACTAMENTE UNA etiqueta ANSWER,
coincide con correctIndex y las otras TRES son DISTRACTOR.
Si hay dos ANSWER, aunque correctIndex apunte a una de ellas, rechaza la
pregunta y explica cuáles son los dos datos simultáneamente verdaderos.
Si algún punto es UNVERIFIABLE, rechaza. Si el documento PDF contradice
sourceEvidence, prevalece SIEMPRE el PDF.
En CALCULO_FORMULACION, comprueba algebraicamente equivalencia, paréntesis,
fracciones, unidades y orden de las operaciones de cada opción.

AUDITORÍA OBLIGATORIA DE DIFICULTAD (usar los CAMPOS YA EXISTENTES):
Es un dictamen DISTINTO de la verdad factual. Evalúa la pregunta como si
fueras un opositor experimentado, mirando enunciado y las cuatro opciones,
y contrastando con el PDF si cada diferencia es realmente reglamentaria.
NO concedas distractorsValid=true por el mero hecho de tener respuesta unica.

- Revisa por separado las TRES opciones que no son correctIndex: cada una
  debe exigir conocer un dato, cifra, excepcion, condicion, limite,
  categoria o procedimiento preciso para descartarla.
- Si UNA de ellas se elimina por sentido comun, cambio de tema, magnitud
  inverosimil, exageracion, absoluto no sustentado o detalle arbitrario,
  devuelve distractorsValid=false e incluye en distractorIssues un motivo
  concreto con la letra de esa opcion (A/B/C/D).
- Revisa por separado si la opcion que corresponde a correctIndex destaca
  artificialmente por redaccion, longitud, tono, detalle o inverosimilitud.
  Si destaca, devuelve distractorsValid=false e incluye el motivo en
  distractorIssues.
- En preguntas INCORRECTA, correctIndex es la afirmacion FALSA: evita que
  sea una falsedad ridicula. Las otras tres afirmaciones verdaderas pueden
  ser incompletas sin dejar de ser verdaderas.
- En CALCULO_FORMULACION, rechaza equivalencias algebraicas entre opciones
  y magnitudes dimensionalmente absurdas. En NUMERICA compara magnitudes
  homogeneas con valores cercanos y unidades coherentes.
- Un requisito autenticamente absoluto o una opcion larga y exacta NO es
  automaticamente invalido. Justifica todo defecto en la evidencia del PDF.
- Si los tres distractores son competitivos Y la respuesta no destaca por
  forma, marca distractorsValid=true y distractorIssues=[].
- No añadas campos nuevos al JSON: usa distractorsValid y distractorIssues,
  ambos definidos en el esquema de respuesta habitual del validador.

EJEMPLOS GENERALES DE DESCARTE SIN MEMORIZAR (no son datos del temario):
  - Un requisito reglamentario frente a 'exencion automatica universal'.
  - Una clasificacion tecnica frente a 'cualquier caso queda prohibido'.
  - Una formula dimensionalmente posible frente a tres expresiones imposibles.
  - Un valor preciso frente a alternativas de magnitudes diferentes.
NO equipares el uso de un absoluto con falsedad: puede ser texto literal
correcto; valora si constituye una pista no sustentada.
` : '';
  const validationPrompt= independentInstructions + `
Eres un validador estricto de preguntas de oposición.

FUENTE DE VERDAD

${independentPdfCheck ? `- La única fuente factual autoritativa es el PDF original recuperado nuevamente mediante File Search.
- sourceEvidence es una pista redactada por el generador y debe verificarse, no asumirse.
- Cualquier afirmación no contrastable con el PDF debe rechazarse.` : `- La ÚNICA fuente factual disponible durante esta validación es el campo sourceEvidence de cada pregunta.
- sourceEvidence procede del temario recuperado mediante File Search durante la generación.
- Valida cada pregunta exclusivamente contra su propio sourceEvidence.
- Si sourceEvidence no permite demostrar una afirmación esencial de la pregunta, no la des por válida.`}
- No uses conocimiento general, memoria propia ni información externa.
- No uses los exámenes oficiales como fuente factual.
- No presupongas como cierto ningún dato que no esté respaldado por la fuente factual que corresponde a este modo.

TAREA

Valida TODAS las preguntas recibidas.

Para cada pregunta debes realizar TRES validaciones:
1. FIABILIDAD FACTUAL.
2. CUMPLIMIENTO REAL DE questionFamily.
3. COMPETITIVIDAD Y PLAUSIBILIDAD DE LOS DISTRACTORES.

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
VALIDACIÓN DE DISTRACTORES

Evalúa la calidad competitiva de las cuatro alternativas, no solo su
verdad o falsedad.

distractorsValid=true únicamente cuando los distractores sean suficientemente
plausibles para un opositor preparado que no recuerde con precisión el
conocimiento evaluado.

Marca distractorsValid=false cuando ocurra cualquiera de estas situaciones:

1. Uno o más distractores pueden descartarse por sentido común sin conocer
   el temario.

2. Un distractor pertenece a un eje conceptual claramente distinto del que
   determina la respuesta correcta y por ello resulta fácil eliminarlo.

3. La correcta destaca por ser claramente más precisa, moderada, completa,
   técnica o natural que las demás.

4. Un distractor contiene una cifra, condición, término, maquinaria,
   procedimiento o detalle arbitrario sin proximidad razonable con el
   conocimiento evaluado.

5. La falsedad del distractor depende de una exageración, término absoluto,
   formulación absurda o pista lingüística evidente.

6. Dos distractores son esencialmente la misma alternativa falsa expresada
   con palabras diferentes.

7. Cuando la fuente permite construir alternativas próximas, los distractores
   se alejan innecesariamente de la respuesta correcta en lugar de variar una
   cifra, condición, término, categoría, paso, límite o relación próxima.
   
8. En dificultad alta, los TRES distractores deben exigir discriminar
   conocimiento técnico próximo a la respuesta correcta.
   Si UNO SOLO de los tres puede descartarse sin conocer con precisión
   el contenido evaluado, distractorsValid=false.

9. En dificultad muy alta, los TRES distractores deben ser técnicamente
   competitivos y próximos. Si cualquiera de ellos no lo es,
   distractorsValid=false.


No marques distractorsValid=false simplemente porque un distractor sea falso:
debe ser falso según la fuente, pero además plausible.

No inventes conocimiento externo para evaluar plausibilidad.
Juzga exclusivamente a partir de stem, options, correctIndex y sourceEvidence.
REGLAS DE VALIDEZ GRÁFICA

Una pregunta GRAFICA solo puede tener graphicValid=true cuando se cumplen
TODAS estas condiciones:

1. graphic debe contener un asset gráfico real:
   assetId, sourceId, publicUrl, assetType y crop.

2. La imagen debe participar de forma real en la pregunta.

   NO apliques un test de imprescindibilidad absoluta.
   Una pregunta GRAFICA sigue siendo válida aunque el mismo conocimiento
   técnico pudiera evaluarse también mediante una pregunta puramente textual.

   graphicValid=true cuando el opositor deba observar la imagen para
   identificar, reconocer, comparar, localizar o interpretar el elemento,
   configuración, procedimiento o situación técnica sobre la que pregunta
   el enunciado.

   NO marques graphicValid=false únicamente porque sourceEvidence permita
   conocer o justificar textualmente la respuesta correcta.

   Marca graphicValid=false solo cuando la imagen sea realmente decorativa:
   es decir, cuando el enunciado y las opciones ya proporcionen explícitamente
   toda la información visual necesaria y observar la imagen no aporte nada
   a la tarea planteada.

3. stem y options NO deben describir verbalmente la información visual
   que el opositor debe obtener observando la imagen.

4. concept, description, sourceId, publicUrl, sourceCaption, sourceText,
   nombre de archivo y cualquier otro metadato del asset NO constituyen
   evidencia factual y NO pueden utilizarse para determinar, completar
   o justificar la respuesta.
- SEGURIDAD DE LENGUAJE INTERNO:
  Revisa conjuntamente stem, options y explanation.
  Si cualquiera contiene terminología interna de la aplicación como
  "asset", "graphicAsset", "assetId", "sourceId", "publicUrl", "crop",
  "metadata" o "metadatos", la pregunta es INVALIDA.

  No basta con que la pregunta sea técnicamente correcta:
  cualquier exposición de terminología interna obliga a rechazarla.
5. Toda afirmación técnica contenida en stem, options y explanation debe
   estar respaldada por sourceEvidence.

6. sourceEvidence debe proceder exclusivamente del TEMARIO recuperado
   mediante File Search. Si sourceEvidence contiene únicamente una
   descripción visual del asset o información procedente de sus
   metadatos:
   graphicValid=false y valid=false.

7. La respuesta correcta debe poder justificarse completamente mediante
   sourceEvidence. La imagen únicamente puede aportar la identificación
   o interpretación visual necesaria para aplicar esa evidencia.

8. explanation debe justificar la respuesta mediante sourceEvidence y
   NO mediante una reinterpretación libre del dibujo ni mediante los
   metadatos del asset.

9. manualPage debe corresponder exclusivamente a la evidencia factual
   contenida en sourceEvidence. Nunca puede deducirse de graphic,
   concept, description, sourceId, sourceCaption, sourceText o cualquier
   otro metadato visual.

10. Si sourceEvidence no permite establecer con seguridad el significado,
    aplicación, procedimiento, condición, valor o característica técnica
    necesaria para responder:
    graphicValid=false y valid=false.

11. Si existe contradicción entre cualquier metadato o descripción visual
    del asset y sourceEvidence, prevalece SIEMPRE sourceEvidence.

12. Debe existir exactamente una respuesta correcta según la polaridad
    de la pregunta y sourceEvidence.

13. Si assetType="group", la composición completa solo puede utilizarse
    cuando la interpretación dependa realmente de dicha composición.

14. No se exige ni se permite graphic.elements, graphic.type, shapes,
    coordenadas 0-100, paths, primitivas SVG ni ningún dibujo generado.
    No rechaces una pregunta por ausencia de graphic.elements.

15. Si la pregunta exige identificar A, B, C, D, números, posiciones,
    componentes u otras referencias visuales, dichas referencias deben
    poder localizarse inequívocamente en la imagen.

16. Marca graphicValid=false si la imagen es meramente decorativa, es ambigua
    para la identificación solicitada o no permite observar con seguridad
    el dato visual que exige la pregunta.

    NO consideres una imagen redundante o innecesaria por el mero hecho de que
    el conocimiento técnico asociado también esté explicado en sourceEvidence.


COHERENCIA DE FAMILIA

Para GRAFICA:

- graphic debe ser distinto de null;
- graphicValid debe ser true para que familyValid pueda ser true;
- si graphicValid=false, familyValid=false y valid=false;
- describe el motivo concreto en graphicIssues y familyIssues.

Para cualquier familia distinta de GRAFICA:

- graphic debe ser null;
- graphicValid=null;
- graphicIssues=[].

RESULTADO

Para cada pregunta devuelve:

- index: índice original empezando en 0.
- valid: true únicamente si la pregunta supera TODAS las comprobaciones
  factuales, de familia, de competitividad de distractores y gráficas
  que resulten aplicables.
- issues: problemas de fiabilidad factual. Si no existen, [].
- familyValid: true únicamente si la pregunta cumple realmente las reglas
  de questionFamily.
- familyIssues: incumplimientos de familia. Si no existen, [].
- distractorsValid: true únicamente si los distractores superan la validación
  de competitividad y plausibilidad.
- distractorIssues: problemas concretos detectados en los distractores.
  Si no existen, [].
- graphicValid:
    * true o false para GRAFICA;
    * null para cualquier otra familia.
- graphicIssues: problemas gráficos; [] cuando no existan.

CRITERIO FINAL

- Ante una contradicción factual clara, valid=false.
- Si falta evidencia suficiente para verificar un aspecto esencial,
  valid=false.
- Si familyValid=false, valid=false.
- Si distractorsValid=false, valid=false.
- Si una pregunta GRAFICA tiene graphicValid=false, valid=false.
- No corrijas ni reescribas preguntas.
- No mejores estilo ni dificultad durante la validación.
- No evalúes si la pregunta te gusta.
- Limítate a comprobar factualidad, unicidad de respuesta, polaridad,
  cumplimiento de familia, competitividad de distractores y coherencia
  gráfica conforme a estas reglas.

ÍNDICES

- index empieza en 0.
- Devuelve exactamente un resultado por cada pregunta.
- Conserva exactamente el mismo orden.

PREGUNTAS A VALIDAR:
${JSON.stringify(questions)}
`;

const runtimeValidationSchema = structuredClone(validationSchema);
if(independentPdfCheck){
  const item=runtimeValidationSchema.properties.results.items;
  item.properties.optionAssessment={
    type:"array",
    items:{type:"string",enum:["ANSWER","DISTRACTOR","UNVERIFIABLE"]},
    minItems:4,
    maxItems:4
  };
  // Mantener el esquema exacto que ya funcionaba en SERVER 87 con File Search.
  // La dificultad se informa mediante distractorsValid/distractorIssues,
  // presentes en validationSchema. No se agregan objetos anidados nuevos.
  item.required=[...item.required,"optionAssessment"];
}

runtimeValidationSchema.properties.results.minItems = questions.length;
runtimeValidationSchema.properties.results.maxItems = questions.length;
  const response=await ai.models.generateContent({
    model:"gemini-3.5-flash-lite",
    contents:validationPrompt,
    config:{
      ...(independentPdfCheck ? {tools:[{fileSearch:{fileSearchStoreNames:[STORE]}}]} : {}),
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
  const question=questions[i];

  if(result.index!==i){
    throw new Error(
      "El validador factual devolvió índices inconsistentes."
    );
  }

  if(independentPdfCheck){
    const flags=Array.isArray(result.optionAssessment)
      ? result.optionAssessment : [];
    if(flags.length!==4 || flags.some(flag=>!['ANSWER','DISTRACTOR'].includes(flag)) ||
      flags.filter(flag=>flag==='ANSWER').length!==1 ||
      flags[Number(question.correctIndex)]!=='ANSWER'){
      result.valid=false;
      result.issues=[...(result.issues||[]),
        'Validación independiente del PDF: no existe respuesta única comprobada. '+
        'Evaluación A-D: '+JSON.stringify(flags)];
    }

    // La dificultad se verifica con los campos de validacion ya soportados.
    // No se introduce un nuevo objeto anidado en responseJsonSchema:
    // los requisitos de competitividad se encuentran en el prompt y en
    // distractorsValid/distractorIssues, con los reintentos habituales.

  }
  const graphicInvalid =
    question?.questionFamily === "GRAFICA" &&
    result.graphicValid !== true;

  if(
    result.familyValid !== true ||
    result.distractorsValid !== true ||
    graphicInvalid
  ){
    result.valid = false;
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
distractorIssues: result.distractorIssues || [],
graphicIssues: result.graphicIssues || []
  }));

  const legislationAnkiStyle =
    await getLegislationAnkiStyleReference(
      replacementTargets
    );

  const replacementPrompt =
    generationPrompt(replacementTargets.length, difficulty, mode) +
    coverageTargetsPrompt(replacementTargets) +
    legislationAnkiStyle +
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
- REGENERACIÓN POR FAMILIA:
  La familia asignada al objetivo es obligatoria mientras exista evidencia suficiente en el temario para construirla correctamente.

- Si questionFamily es CALCULO_FORMULACION:
  la nueva pregunta DEBE exigir necesariamente una operación, fórmula, despeje, conversión de unidades, relación entre magnitudes o cálculo numérico respaldado por el temario.
  No generes una pregunta meramente descriptiva, literal o conceptual.
  Si el objetivo original no contiene evidencia suficiente para construir un cálculo válido, aplica el fallback de familia definido en generationPrompt y devuelve en questionFamily la familia realmente generada.

- Si questionFamily es 2026_CORRECTA:
  no te limites a reproducir literalmente una única frase del sourceEvidence.
  Construye una pregunta que exija aplicación, comparación, discriminación técnica o razonamiento cuando la evidencia recuperada lo permita.

- Antes de devolver cada sustitución, comprueba que el contenido REAL de la pregunta cumple la familia indicada en questionFamily.
- Conserva la questionFamily de la pregunta rechazada cuando exista evidencia
  suficiente en el temario para corregirla dentro de esa misma familia.
- Si esa familia no puede construirse válidamente con la evidencia recuperada,
  aplica exclusivamente las reglas de fallback definidas en generationPrompt
  y asigna a questionFamily la familia final realmente generada.
- Si el rechazo contiene familyIssues, distractorIssues o graphicIssues,
  corrige explícitamente esos problemas además de cualquier problema factual
  indicado en issues.

- Si existen distractorIssues, reconstruye los distractores defectuosos.
  No te limites a cambiar palabras: corrige exactamente el problema de
  plausibilidad, proximidad conceptual, simetría o descarte superficial
  indicado por el validador.
${replacementTargets.length && replacementTargets.every(t =>
  String(t?.topic_block || '').trim().toLowerCase() === 'legislacion'
) ? `- En legislación técnica SIN Anki, no sustituyas una falsedad grosera por otra
  igual de obvia: cambia UN detalle normativo cercano (cifra, excepción,
  sujeto, condicion, orden o categoría) usando exclusivamente el PDF.
  La opción elegida en preguntas INCORRECTA no debe destacar visualmente.
  Una afirmación verdadera aunque incompleta sigue siendo verdadera.` : ''}

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
for(let i=0;i<parsed.questions.length;i++){
  const target = replacementTargets[i];
  const question = parsed.questions[i];

  if(target?.questionFamily === "GRAFICA" && target?.graphicAsset){
    question.questionFamily = "GRAFICA";
    question.graphic = {
      assetId: target.graphicAsset.id,
      sourceId: target.graphicAsset.source_id,
      publicUrl: target.graphicAsset.public_url,
      assetType: target.graphicAsset.asset_type,
      concept: target.graphicAsset.concept || "",
      description: target.graphicAsset.description || "",
           maskRegions: Array.isArray(target.graphicAsset.mask_regions)
        ? target.graphicAsset.mask_regions
        : [],
      crop: {
        x: Number(target.graphicAsset.crop_x ?? 0),
        y: Number(target.graphicAsset.crop_y ?? 0),
        width: Number(target.graphicAsset.crop_width ?? 1),
        height: Number(target.graphicAsset.crop_height ?? 1)
      }
    };
  }
}
  return {
    questions: parsed.questions,
    targets: replacementTargets
  };
}
app.get("/api/statistics", async(req,res)=>{
  try{
    const result = await db.query(`
      SELECT
  t.id AS topic_id,
  t.name AS topic_name,
  t.block AS block,
  t.topic_order AS topic_order,

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
  t.topic_order NULLS LAST,
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

      GROUP BY
        t.id,
        t.name,
        COALESCE(
          NULLIF(TRIM(ci.section),''),
          'Sin sección'
        )

      ORDER BY
        t.id,
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
// de coverage_items. Solo se utilizan tarjetas validadas y enlazadas al dato
// curricular correspondiente. Nunca se sustituye la cuota con generadas nuevas
// sin informar al usuario de la causa.
// SERVER_86: Anki original y cobertura curricular son dimensiones independientes.
// La plaza Anki no necesita inventar un enlace a otro coverage_item.
// Las fichas técnicas quedan exam_relevant=FALSE y por tanto no contaminan el
// porcentaje de temario cubierto. El mismo motor de historial y SRS las procesa.
async function applyLegislationAnkiQuota84(originalTargets,allowedTopicIds){
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
    WHERE topic_order=ANY($1::int[]) AND option_count=4
      AND direct_use_eligible=TRUE AND validation_status<>'rejected'
    GROUP BY topic_order`,[orders]);
  const availableOrders=new Set(inventory.rows.filter(r=>Number(r.total)>0)
    .map(r=>Number(r.topic_order)));
  const groups=[...topicGroups].filter(([,g])=>availableOrders.has(g.order));
  if(!groups.length)return null; // Tema técnico sin baraja: generación PDF.
  const totalSlots=groups.reduce((sum,[,g])=>sum+g.indices.length,0);
  const required=Math.ceil(totalSlots*0.8);
  const quotas=new Map(groups.map(([id,g])=>[id,Math.floor(g.indices.length*0.8)]));
  const rest=groups.map(([id,g])=>({id,fract:g.indices.length*0.8-Math.floor(g.indices.length*0.8)}))
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
      WHERE a.topic_order=$1 AND a.option_count=4 AND a.direct_use_eligible=TRUE
        AND a.validation_status<>'rejected'
      ORDER BY CASE WHEN COALESCE(sr.next_review_at,vr.next_review_at)<=NOW()
        THEN 0 ELSE 1 END ASC,a.times_used ASC,a.last_used_at ASC NULLS FIRST,a.id ASC
      LIMIT 700`,[g.order,topicId]);
    const chosen=[];
    for(const a of query.rows){
      const options=Array.isArray(a.options)?a.options:[];
      const correct=Number(a.correct_index);
      const textKey=normalizeLegislationMatchText(a.stem);
      if(!textKey||options.length!==4||!Number.isInteger(correct)||correct<0||correct>3||
         options.some(o=>typeof o!=='string'||!o.trim())||
         notes.has(String(a.anki_note_id))||stems.has(textKey)||
         legislationKnownAmbiguityIssue({stem:a.stem,options}))continue;
      chosen.push(a);notes.add(String(a.anki_note_id));stems.add(textKey);
      if(chosen.length===needs)break;
    }
    if(chosen.length!==needs){
      throw new Error(`ANKI: el tema ${g.order} tiene ${chosen.length} preguntas aptas para ${needs} plazas. No se generan sustituciones ocultas.`);
    }
    selectedRows.set(topicId,chosen);
  }

  const targets=[...originalTargets],direct=new Map();
  const reserved=new Set();
  for(const [topicId,g] of groups){
    const topicSlots=g.indices.slice(0,quotas.get(topicId));
    const chosen=selectedRows.get(topicId)||[];
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
        q.explanation='Pregunta original de Anki (sin vínculo curricular verificado).';
        q.sourceEvidence='Baraja Anki original del tema; sin vinculación a unidad curricular.';
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
  console.log('LEGISLACION CUOTA ANKI 86:',JSON.stringify({required,
    anki:direct.size,nuevas:targets.length-direct.size,
    originalesSinEnlace:[...direct.values()].filter(q=>q.ankiIndependent).length,
    ids:[...direct.values()].map(q=>q.ankiQuestionId)}));
  if(direct.size!==required)throw new Error('ANKI: cuota incompleta; se cancela la sesión.');
  return {targets,direct,required};
}

app.post("/api/generate", async(req,res)=>{
  try{
    if(!STORE) throw new Error("Primero indexa el PDF.");

    const requestedCount =
  Number(req.body.count) || 10;

const allowedCounts =
  new Set([5,10,20,30,40,45,60,75]);

if(!allowedCounts.has(requestedCount)){
  throw new Error(
    "Número de preguntas no válido."
  );
}

const count=requestedCount;

  const difficulty = "alta";

const mode=
  ["literal","mixto","calculos"].includes(req.body.mode)
    ? req.body.mode
    : "mixto";

const testType=
  req.body.testType==="failed"
    ? "failed"
    : "normal";
const examMode=
  req.body.examMode==="simulation"
    ? "simulation"
    : "training";
const ai=aiClient();
const allowedTopicIds =
  await resolveGenerationTopicScope(req.body);
    let targets=
  testType==="failed"
    ? await getFailedCoverageTargets(
        count,
        allowedTopicIds
      )
    : await getCoverageTargetsForGeneration(
        count,
        ai,
        allowedTopicIds,
        examMode==="simulation"
          ? "simulation"
          : "adaptive"
      );
    if(targets.length===0){
  throw new Error(
    testType==="failed"
      ? "No tienes conocimientos fallados pendientes."
      : "No quedan unidades de cobertura disponibles."
  );
}

   const quota84=testType==='normal'
     ? await applyLegislationAnkiQuota84(targets,allowedTopicIds)
     : null;
   if(quota84){targets=quota84.targets;}
   const generationCount = targets.length;
    for(const target of targets){
  target.adaptiveDifficulty =
  getAdaptiveDifficulty(target);
}
    const reusableQuestions = new Map();

if(testType === "normal"){
  for(let i = 0; i < targets.length; i++){
    const topicNumber =
      coverageTopicNumber(
        targets[i]?.topic_name
      );

    if(
      Number.isInteger(topicNumber) &&
      topicNumber >= 21 &&
      topicNumber <= 27
    ){
      continue;
    }

    /*
    LEGISLACIÓN:
    no reutilizar el banco histórico generado antes de la integración Anki.
    Esas preguntas pueden pertenecer a versiones antiguas de prompts y
    distractores. Primero se intenta Anki validado y, si no existe coincidencia
    exacta, se genera una pregunta nueva con las reglas actuales.
    */
    if(
      String(targets[i]?.topic_block || "")
        .trim()
        .toLowerCase() === "legislacion"
    ){
      continue;
    }

    const reusable =
      await getReusableQuestionForTarget(
        targets[i],
        targets[i].adaptiveDifficulty || difficulty
      );

    if(reusable){
      reusableQuestions.set(i, reusable);
    }
  }
}

console.log(
  "BANCO DE PREGUNTAS:",
  reusableQuestions.size,
  "reutilizables de",
  targets.length
);

const directAnkiQuestions=new Map(quota84?.direct||[]);
if(testType==='failed'){
  for(let i=0;i<targets.length;i++){
    if(targets[i].item_type!=='anki_independent')continue;
    const found=await db.query(`
      SELECT qb.*,a.anki_note_id,a.validation_status FROM question_bank qb
      JOIN legislation_anki_questions a ON a.id=qb.source_anki_question_id
      WHERE qb.coverage_item_id=$1 AND qb.active=TRUE
        AND a.validation_status<>'rejected'
      ORDER BY qb.id DESC LIMIT 1`,[Number(targets[i].id)]);
    if(!found.rows.length)throw new Error('ANki: tarjeta original fallada no disponible.');
    const r=found.rows[0];
    directAnkiQuestions.set(i,{
      stem:r.stem,options:r.options,correctIndex:Number(r.correct_index),
      explanation:r.explanation||'',sourceEvidence:r.source_evidence||'',
      sourcePage:null,manualPage:null,questionFamily:r.question_family,
      difficulty:r.difficulty||'alta',graphic:null,reused:false,ankiDirect:true,
      ankiIndependent:true,ankiQuestionId:Number(r.source_anki_question_id),
      ankiNoteId:Number(r.anki_note_id),ankiOriginalStatus:r.validation_status
    });
    targets[i].ankiIndependent=true;
  }
}

if(testType === "normal" && !quota84){
  const unresolvedIndexes=[];
  const unresolvedTargets=[];

  for(let i=0; i<targets.length; i++){
    if(reusableQuestions.has(i)){
      continue;
    }

    unresolvedIndexes.push(i);
    unresolvedTargets.push(targets[i]);
  }

  const legislationSlots=unresolvedTargets.filter(target=>
    String(target?.topic_block||'').trim().toLowerCase()==='legislacion'
  ).length;
  const directLocal=
    await getDirectLegislationAnkiQuestionsForTargets(
      ai,
      unresolvedTargets,
      Math.ceil(legislationSlots*0.80)
    );

  for(const [localIndex,question] of directLocal){
    const originalIndex=
      unresolvedIndexes[localIndex];

    if(Number.isInteger(originalIndex)){
      directAnkiQuestions.set(
        originalIndex,
        question
      );
    }
  }
}

if(quota84 && directAnkiQuestions.size!==quota84.required){
  throw new Error(`CUOTA ANKI: se esperaban ${quota84.required} preguntas Anki exactas.`);
}
console.log(
  "ANKI DIRECTO:",
  directAnkiQuestions.size,
  "preguntas exactas de",
  targets.length
);

    console.log(
      "GENERATECONTENT: iniciando con",
      targets.length,
      "objetivos de cobertura"
    );
const generationTargets = [];
const generationIndexes = [];

for(let i = 0; i < targets.length; i++){

  if(
    reusableQuestions.has(i) ||
    directAnkiQuestions.has(i)
  ){
    continue;
  }

  generationTargets.push(targets[i]);
  generationIndexes.push(i);
}
   if(testType === "normal"){
  for(const target of generationTargets){
    target.previousBankQuestion =
      await getLatestBankQuestionForTarget(target);
  }
} 
await attachDistractorContextToTargets(
  generationTargets
);
console.log(
  "GENERACIÓN NUEVA:",
  generationTargets.length,
  "objetivos de",
  targets.length
);

const newGenerationCount =
  generationTargets.length;

let prompt = null;
let finalQuestions = [];
if(newGenerationCount > 0){
const officialStyle =
  await getCachedOfficialExamStyleReference();

const hasGeographyTargets =
  generationTargets.some(target=>{
    const topicNumber =
      coverageTopicNumber(target.topic_name);

    return (
      Number.isInteger(topicNumber) &&
      topicNumber >= 21 &&
      topicNumber <= 27
    );
  });

const geographyStyle =
  hasGeographyTargets
    ? await getCachedOfficialGeographyStyleReference()
    : "";

const legislationAnkiStyle =
  await getLegislationAnkiStyleReference(
    generationTargets
  );

prompt =
  generationPrompt(
      newGenerationCount,
      difficulty,
      mode
    ) +
    coverageTargetsPrompt(
      generationTargets
    ) +
    legislationAnkiStyle +
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
` +
(
  hasGeographyTargets
    ? `

==================================================
ESTILO ESPECÍFICO — GEOGRAFÍA 2024/2026
==================================================

La siguiente referencia procede exclusivamente del análisis
de las preguntas de GEOGRAFÍA de los exámenes oficiales
de Bomberos de Navarra 2024 y 2026.

APLICACIÓN:

- Aplícala EXCLUSIVAMENTE a los objetivos de los temas 21 a 27.
- Para objetivos de otros bloques, sigue utilizando únicamente
  las reglas generales de generación y estilo oficial.
- La referencia de Geografía describe CÓMO pregunta el tribunal.
- NO es fuente factual.
- Toda respuesta correcta y todo distractor deben continuar
  estando respaldados por el temario factual recuperado.

--- REFERENCIA ESPECÍFICA DE GEOGRAFÍA ---

${geographyStyle}

--- FIN DE REFERENCIA ESPECÍFICA DE GEOGRAFÍA ---

==================================================
BARRERA CARTOGRÁFICA — GEOGRAFÍA
==================================================

NO generes preguntas cuya respuesta requiera DEDUCIR por conocimiento
cartográfico externo o por interpretación de un mapa no proporcionado:

- qué accidente geográfico está al norte, sur, este u oeste de otro;
- posiciones espaciales relativas;
- proximidades geográficas;
- recorridos deducidos visualmente;
- qué elemento se encuentra entre otros;
- orientación respecto de montes, sierras, ríos, valles,
  municipios u otros accidentes;
- cualquier relación espacial que NO esté expresamente respaldada
  por el temario factual recuperado.

Estas familias pueden existir en los exámenes oficiales,
pero quedan FUERA de la generación automática de la plataforma.

EXCEPCIÓN IMPORTANTE:

Si el propio temario expresa TEXTUALMENTE una relación de orientación,
orden, secuencia o recorrido, SÍ puede preguntarse.

Ejemplos de relaciones permitidas cuando estén explícitas en el temario:
- una lista ordenada de norte a sur;
- municipios recorridos por una línea;
- pertenencia de una localidad a un ámbito;
- relaciones territoriales expresamente escritas.

No confundas una relación textual explícita con una deducción cartográfica.

Para Geografía prioriza las familias reproducibles observadas
en los exámenes oficiales 2024/2026 siempre que puedan construirse
íntegramente con los datos del temario.
`
    : ""
);

    // Exigencia adicional acotada a Legislacion de generacion completamente
    // nueva. No se aplica a preguntas Anki, ni a temas mixtos o Geografia.
    const hardLegislationOnly = quota84 === null &&
      generationTargets.length > 0 &&
      generationTargets.every(t =>
        String(t.topic_block || "").trim().toLowerCase() === "legislacion"
      );
    if(hardLegislationOnly){
      prompt += `

==================================================
CONTROL FINAL DE DIFICULTAD — LEGISLACION SIN ANKI
==================================================

La exactitud juridica es irrenunciable: todas las respuestas deben poder
justificarse en el PDF factual. Pero una pregunta valida NO es necesariamente
dificil. Aplica estas reglas ANTES de devolver el test:

1. Cada pregunta evalua el objetivo de cobertura asignado, no otro apartado.
   Si dos objetivos proximos requieren dos preguntas, interroga hechos o
   condiciones DISTINTAS. No inventes datos para fabricar variedad.
2. Disena primero la discriminacion: cifra proxima con misma unidad,
   condicion/excepcion concreta, sujeto obligado, categoria vecina,
   plazo proximo, relacion reglamentaria o formula casi identica.
3. Para CORRECTA, escribe tres alternativas falsas pero creibles para
   alguien que haya estudiado; para INCORRECTA, redacta tres afirmaciones
   VERDADERAS (aunque alguna sea parcial) y una falsedad MUY SUTIL.
4. Evita opciones de otro eje, afirmaciones absurdas, absolutos gratuitos
   y pistas como 'sin restriccion alguna' o 'automaticamente exento'.
   Los absolutos autenticos del reglamento SI deben conservarse.
5. Si una alternativa se elimina por su tono, longitud muy diferente,
   sentido comun o terminologia extravagante, REHAZ LAS CUATRO.
6. En numeros compara magnitudes homogeneas con valores vecinos; en
   formulas respeta dimensiones, notacion KaTeX y equivalencia algebraica.
7. No basta con que cuatro opciones parezcan tecnicas: para cada una,
   verifica el detalle normativo concreto que la hace verdadera o falsa.
   No marques una verdad parcial como falsa por falta de otros requisitos.
8. Si el PDF no permite elaborar tres distractores competitivos sin
   ambiguedad, cambia el enfoque de la pregunta SOBRE EL MISMO OBJETIVO.
   Nunca inventes hechos ni cambies el objetivo para elevar la dificultad.

La calidad buscada es SUPERIOR a un test de memorizacion superficial,
pero siempre con exactamente UNA respuesta correcta y fundamento literal.
`;
    }

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
console.log(
  "TARGETS GRAFICOS:",
  generationTargets.map((t, i) => ({
    index: i,
    family: t.questionFamily,
    graphicAssetId: t.graphicAsset?.id ?? null,
    graphicSourceId: t.graphicAsset?.source_id ?? null
  }))
);
    console.log("GENERATECONTENT: respuesta recibida");
console.log("TEXTO GEMINI:", response.text.slice(0,1500));
    const parsed=JSON.parse(response.text);
for(let i=0;i<parsed.questions.length;i++){
  const target = generationTargets[i];
  const question = parsed.questions[i];

  if(target?.questionFamily === "GRAFICA" && target?.graphicAsset){
    question.questionFamily = "GRAFICA";
    question.graphic = {
      assetId: target.graphicAsset.id,
      sourceId: target.graphicAsset.source_id,
      publicUrl: target.graphicAsset.public_url,
      assetType: target.graphicAsset.asset_type,
      concept: target.graphicAsset.concept || "",
      description: target.graphicAsset.description || "",
           maskRegions: Array.isArray(target.graphicAsset.mask_regions)
        ? target.graphicAsset.mask_regions
        : [],
      crop: {
        x: Number(target.graphicAsset.crop_x ?? 0),
        y: Number(target.graphicAsset.crop_y ?? 0),
        width: Number(target.graphicAsset.crop_width ?? 1),
        height: Number(target.graphicAsset.crop_height ?? 1)
      }
    };
  }
}
  if(
  !parsed.questions ||
  parsed.questions.length !== newGenerationCount
){
  throw new Error(
    `Gemini debía devolver ${newGenerationCount} preguntas y devolvió ${parsed.questions?.length || 0}.`
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

finalQuestions = [...parsed.questions];
    for (let i = 0; i < finalQuestions.length; i++) {
  const target = generationTargets[i];
  const q = finalQuestions[i];
      q.difficulty =
  target?.adaptiveDifficulty === "muy alta"
    ? q.difficulty
    : "alta";

  if (target?.questionFamily === "GRAFICA" && target?.graphicAsset) {
    q.questionFamily = "GRAFICA";

    q.graphic = {
      assetId: target.graphicAsset.id,
      sourceId: target.graphicAsset.source_id,
      publicUrl: target.graphicAsset.public_url,
      assetType: target.graphicAsset.asset_type,
      concept: target.graphicAsset.concept || "",
      description: target.graphicAsset.description || "",
      maskRegions: Array.isArray(target.graphicAsset.mask_regions)
  ? target.graphicAsset.mask_regions
  : [],
      crop: {
        x: Number(target.graphicAsset.crop_x ?? 0),
        y: Number(target.graphicAsset.crop_y ?? 0),
        width: Number(target.graphicAsset.crop_width ?? 1),
        height: Number(target.graphicAsset.crop_height ?? 1)
      }
    };
  } else {
    q.graphic = null;
  }
}

const independentPdfCheck = quota84===null && generationTargets.length>0 &&
  generationTargets.every(t=>String(t.topic_block||'').trim().toLowerCase()==='legislacion');
let factualValidation =
  await validateGeneratedQuestions(ai, finalQuestions,
    {independentPdfCheck,targets:generationTargets});

for(let i = 0; i < factualValidation.length; i++){
  const target = generationTargets[i];
  const question = finalQuestions[i];

  const legislationIssue =
    generatedMathNotationIssue(question) ||
    legislationQuestionIssue(
      target,
      question
    ) ||
    (independentPdfCheck ? hardLegislationDistractorIssue(question) : null);

  if(legislationIssue){
    factualValidation[i] = {
      ...factualValidation[i],
      valid:false,
      issues:[
        ...(factualValidation[i].issues || []),
        legislationIssue
      ]
    };
  }

  const geographyRelevanceIssue =
    geographyForbiddenQuestionIssue(
      target,
      question
    );

  if(geographyRelevanceIssue){
    console.log(
      "GEOGRAPHY DETERMINISTIC REJECTION:",
      JSON.stringify({
        phase:"initial",
        targetId:target?.id ?? null,
        topic:target?.topic_name || null,
        issue:geographyRelevanceIssue,
        stem:question?.stem || null,
        options:Array.isArray(question?.options)
          ? question.options
          : []
      })
    );

    factualValidation[i] = {
      ...factualValidation[i],
      valid:false,
      issues:[
        ...(factualValidation[i].issues || []),
        geographyRelevanceIssue
      ]
    };
  }
  const geographyOperationalIssue =
  geographyOperationalParkIssue(
    target,
    question
  );

if(geographyOperationalIssue){
  factualValidation[i] = {
    ...factualValidation[i],
    valid:false,
    issues:[
      ...(factualValidation[i].issues || []),
      geographyOperationalIssue
    ]
  };
}
const geographyOptionIssue =
  geographyOptionPoolIssue(
    target,
    question
  );

if(geographyOptionIssue){
  factualValidation[i] = {
    ...factualValidation[i],
    valid:false,
    issues:[
      ...(factualValidation[i].issues || []),
      geographyOptionIssue
    ]
  };
}
  if(
    target?.failed_difficulty === "muy alta" &&
    question?.difficulty !== "muy alta"
  ){
    factualValidation[i] = {
      ...factualValidation[i],
      valid:false,
      issues:[
        ...(factualValidation[i].issues || []),
        'Una variante de una pregunta fallada con dificultad "muy alta" no puede bajar a "alta".'
      ]
    };
  }

  const exactDuplicate =
    await isExactBankDuplicate(target, question);

  if(exactDuplicate){
    factualValidation[i] = {
      ...factualValidation[i],
      valid:false,
      issues:[
        ...(factualValidation[i].issues || []),
        "La pregunta generada duplica exactamente una pregunta ya existente del banco."
      ]
    };
  }
}

let invalidQuestions =
  factualValidation.filter(result => !result.valid);

for(
  let regenerationAttempt = 1;
  regenerationAttempt <= 3 &&
  invalidQuestions.length > 0;
  regenerationAttempt++
){
  console.log(
    "VALIDACIÓN FINAL:",
    invalidQuestions.length,
    `preguntas rechazadas. Regeneración ${regenerationAttempt}/3.`
  );

  const regenerated =
    await regenerateInvalidQuestions(
      ai,
      invalidQuestions,
      finalQuestions,
      generationTargets,
      difficulty,
      mode,
      officialStyle
    );

  const replacementValidation =
    await validateGeneratedQuestions(
      ai,
      regenerated.questions,
      {independentPdfCheck,
       targets:invalidQuestions.map(result=>generationTargets[result.index])}
    );

  const stillInvalid = [];

  for(let i = 0; i < regenerated.questions.length; i++){
    const originalIndex = invalidQuestions[i].index;
    const validationResult = replacementValidation[i];
    const targetForValidation =
      generationTargets[originalIndex];

    const legislationIssue =
      generatedMathNotationIssue(regenerated.questions[i]) ||
      legislationQuestionIssue(
        targetForValidation,
        regenerated.questions[i]
      ) ||
      (independentPdfCheck ? hardLegislationDistractorIssue(regenerated.questions[i]) : null);

    if(legislationIssue){
      validationResult.valid = false;
      validationResult.issues = [
        ...(validationResult.issues || []),
        legislationIssue
      ];
    }

    const geographyRelevanceIssue =
      geographyForbiddenQuestionIssue(
        targetForValidation,
        regenerated.questions[i]
      );

    if(geographyRelevanceIssue){
      console.log(
        "GEOGRAPHY DETERMINISTIC REJECTION:",
        JSON.stringify({
          phase:"regeneration",
          attempt:regenerationAttempt,
          targetId:targetForValidation?.id ?? null,
          topic:targetForValidation?.topic_name || null,
          issue:geographyRelevanceIssue,
          stem:regenerated.questions[i]?.stem || null,
          options:Array.isArray(regenerated.questions[i]?.options)
            ? regenerated.questions[i].options
            : []
        })
      );

      validationResult.valid = false;
      validationResult.issues = [
        ...(validationResult.issues || []),
        geographyRelevanceIssue
      ];
    }
    const geographyOperationalIssue =
  geographyOperationalParkIssue(
    targetForValidation,
    regenerated.questions[i]
  );

if(geographyOperationalIssue){
  validationResult.valid = false;
  validationResult.issues = [
    ...(validationResult.issues || []),
    geographyOperationalIssue
  ];
}

const geographyOptionIssue =
  geographyOptionPoolIssue(
    targetForValidation,
    regenerated.questions[i]
  );

if(geographyOptionIssue){
  validationResult.valid = false;
  validationResult.issues = [
    ...(validationResult.issues || []),
    geographyOptionIssue
  ];
}
    
    if(
      targetForValidation?.failed_difficulty === "muy alta" &&
      regenerated.questions[i]?.difficulty !== "muy alta"
    ){
      validationResult.valid = false;
      validationResult.issues = [
        ...(validationResult.issues || []),
        'Una variante de una pregunta fallada con dificultad "muy alta" no puede bajar a "alta".'
      ];
    }

    const exactDuplicate =
      await isExactBankDuplicate(
        targetForValidation,
        regenerated.questions[i]
      );

    if(exactDuplicate){
      validationResult.valid = false;
      validationResult.issues = [
        ...(validationResult.issues || []),
        "La pregunta regenerada duplica exactamente una pregunta ya existente del banco."
      ];
    }

    if(validationResult.valid){
      const replacementQuestion =
        regenerated.questions[i];

      const originalTarget =
        generationTargets[originalIndex];

      replacementQuestion.difficulty =
        originalTarget?.adaptiveDifficulty === "muy alta"
          ? replacementQuestion.difficulty
          : "alta";

      if(
        originalTarget?.questionFamily === "GRAFICA" &&
        originalTarget?.graphicAsset
      ){
        replacementQuestion.questionFamily = "GRAFICA";
        replacementQuestion.graphic = {
          assetId: originalTarget.graphicAsset.id,
          sourceId: originalTarget.graphicAsset.source_id,
          publicUrl: originalTarget.graphicAsset.public_url,
          assetType: originalTarget.graphicAsset.asset_type,
          concept: originalTarget.graphicAsset.concept || "",
          description: originalTarget.graphicAsset.description || "",
          maskRegions: Array.isArray(
            originalTarget.graphicAsset.mask_regions
          )
            ? originalTarget.graphicAsset.mask_regions
            : [],
          crop: {
            x: Number(
              originalTarget.graphicAsset.crop_x ?? 0
            ),
            y: Number(
              originalTarget.graphicAsset.crop_y ?? 0
            ),
            width: Number(
              originalTarget.graphicAsset.crop_width ?? 1
            ),
            height: Number(
              originalTarget.graphicAsset.crop_height ?? 1
            )
          }
        };
      }

      finalQuestions[originalIndex] =
        replacementQuestion;
    }else{
      stillInvalid.push({
        index:originalIndex,
        valid:false,
        issues:validationResult.issues || [],
        familyIssues:
          validationResult.familyIssues || [],
        distractorIssues:
          validationResult.distractorIssues || [],
        graphicIssues:
          validationResult.graphicIssues || []
      });
    }
  }

  invalidQuestions = stillInvalid;
}

if(invalidQuestions.length > 0){
  throw new Error(
    `Quedaron ${invalidQuestions.length} preguntas sin superar la validación final tras 3 regeneraciones.`
  );
}

console.log(
  "VALIDACIÓN FACTUAL: todas las preguntas superadas"
);
    }
      
    


const completeQuestions =
  new Array(targets.length);

for(const [index, reusable] of reusableQuestions){
  completeQuestions[index] = reusable;
}

for(const [index, directAnki] of directAnkiQuestions){
  completeQuestions[index] = directAnki;
}

for(let i = 0; i < finalQuestions.length; i++){
  const originalIndex = generationIndexes[i];
  completeQuestions[originalIndex] = finalQuestions[i];
}

if(completeQuestions.some(question => !question)){
  throw new Error(
    "No se pudo reconstruir el test completo."
  );
}

finalQuestions = completeQuestions;

console.log(
  "TEST SOURCES:",
  finalQuestions.map((question,index)=>({
    position:index + 1,
    coverageId:Number(targets[index]?.id || 0),
    topic:targets[index]?.topic_name || null,
    source:
      question?.ankiDirect === true
        ? (question?.ankiIndependent ? "ANKI_ORIGINAL" : "ANKI_VALIDADO")
        : question?.reused === true
          ? "BANCO_REUTILIZADO"
          : "GENERADA_NUEVA",
    options:Array.isArray(question?.options)
      ? question.options.length
      : 0,
    correctIndex:Number(question?.correctIndex)
  }))
);

    /*
      Las preguntas mantienen el mismo orden que los objetivos:
      pregunta 1 -> objetivo 1
      pregunta 2 -> objetivo 2
      etc.

      Solo llegamos aquí después de recibir y validar
      exactamente el número solicitado de preguntas.
    */
        const persistedTest = await persistGeneratedTest({
  questions: finalQuestions,
  targets,
  requestedCount: count,
  difficulty,
  mode,
  testType
});

    console.log(
      "PERSISTENCIA TEST:",
      JSON.stringify({
        sessionId: persistedTest.sessionId,
        questions: persistedTest.questions.length
      })
    );

    finalQuestions = persistedTest.questions;

console.log("COBERTURA 83: pendientes de respuesta, no trabajados al crear la sesión",targets.map(t=>t.id));

    res.json({
  ok:true,
  sessionId:persistedTest.sessionId,
  questions:finalQuestions,
  coverage:{
    targeted:targets.length,
    markedWorked:0
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
  questions:finalQuestions
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
  const cleanup83=await db.query(`
    UPDATE coverage_items SET worked=FALSE
    WHERE worked=TRUE AND COALESCE(times_asked,0)=0
  `);
  console.log("COBERTURA 83: elementos mostrados pero no respondidos reparados:",cleanup83.rowCount);
console.log("STARTUP ANKI: syncLegislationAnkiQuestions");
await syncLegislationAnkiQuestions();
console.log("STARTUP ANKI OK");
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
  });
}

startServer().catch(e=>{
  console.error("ERROR INICIANDO SERVIDOR:", e);
  process.exit(1);
});
