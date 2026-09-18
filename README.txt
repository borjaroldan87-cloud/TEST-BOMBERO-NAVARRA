TEST BOMBERO NAVARRA — V2 REAL

Qué está hecho:
- Backend separado: la API key NO va al navegador.
- PDF de Apeo y poda incluido como benchmark.
- Indexación real mediante Gemini File Search.
- Generación dinámica de 5–40 preguntas.
- Salida estructurada: 4 opciones, 1 correcta, explicación, evidencia y página si está disponible.
- Validación estructural local.
- Interfaz de examen y revisión.

Qué falta para probarlo contra Gemini:
1) desplegar esta carpeta en un hosting Node;
2) crear la variable de entorno GEMINI_API_KEY en ese hosting;
3) iniciar;
4) pulsar INDEXAR PDF y después GENERAR TEST REAL.

IMPORTANTE:
No pegar GEMINI_API_KEY en app.js, index.html ni ningún archivo público.
La prueba definitiva de calidad solo existe después de ejecutar llamadas reales con la clave del usuario.
