# Nora SaaS

Nora es un agente de WhatsApp multi-negocio: responde con el conocimiento de cada negocio, entiende audios,
contesta con voz y ejecuta **flujos de automatización estilo Kommo (Salesbot)** que el dueño arma desde un panel.

- **Backend:** Supabase (proyecto `xjqxabmnkyzifehmvnew`): base de datos con RLS por negocio, Edge Functions, Vault y cron.
- **Panel:** Vercel, proyecto `nora-panel` (producción: `nora-panel-seven.vercel.app`). React + Vite.
- **IA:** OpenAI (texto y transcripción de audios) o Claude; voz con ElevenLabs.

## Contenido del repositorio

| Carpeta | Qué es | Estado |
|---|---|---|
| `motor/` | Intérprete de flujos (lógica pura) y sus 13 tests | Probado |
| `panel/` | `Panel.jsx` (bandeja, flujos, conocimiento, WhatsApp), `Flujos.jsx` (editor con simulador), estilos y `motor.ts` | En producción |
| `sql/0008_flujos.sql` | Tablas `flujos` y `flujo_ejecuciones`, RLS y funciones | Aplicada |
| `sql/0009_0011_cron_flujos.sql` | Cron que despierta los pasos «Esperar» (estado final) | Aplicada |
| `functions/flow-engine/` | Ejecuta los flujos por cada mensaje y por tiempo | Desplegada (v1) |
| `functions/whatsapp-webhook/` | Webhook de Meta: primero consulta a `flow-engine`; si no se ocupa, responde Nora | Desplegada (v4) |
| `functions/nora-responder/` | Nora: transcribe audios (OpenAI), responde (OpenAI o Claude) y envía voz (ElevenLabs) | Desplegada (v2) |

## Qué NO está en este repositorio (importante)

- **Migraciones 0002–0007** (roles, bandeja, planes y uso, plantillas por nicho, equipo/citas/auditoría/almacenamiento, audio y voz):
  están aplicadas en Supabase pero no como archivos. Exportarlas con `supabase db pull`.
- **Funciones `whatsapp-connect` y `nora-conocimiento`:** desplegadas en Supabase; traerlas con `supabase functions download`.
- **Archivos originales del panel:** `App.jsx`, `Auth.jsx`, `CrearNegocio.jsx`, `Conectar.jsx`, `Conocimiento.jsx`, `styles.css`,
  `supabase.js`, `main.jsx`, `index.html`, `package.json`, `vite.config.js`. Existen en el despliegue de Vercel, pero Vercel solo devuelve
  los primeros ~2 KB de cada archivo, así que no se pudieron recuperar. Se reutilizan **por su huella SHA1** al desplegar (ver más abajo).
  Para tener el panel completo en este repo hay que copiarlos desde donde se escribieron originalmente o reescribirlos.

## Cómo funciona un flujo

1. **Disparador:** cliente nuevo (su primer mensaje) o palabra clave.
2. **Pasos:** enviar mensaje, hacer una pregunta (valida y guarda el dato), condición con dos ramas, esperar, etiquetar,
   cambiar etapa, pasar a una persona, o dar el control a Nora (IA).
3. El webhook llama a `flow-engine`; si devuelve `handled: true` no responde Nora. Si falla o no hay flujo, responde Nora.
4. Los datos quedan en `contacts.datos`, las etiquetas en `contacts.tags` y la etapa en `contacts.etapa`.
5. Cada ejecución congela la definición al empezar: editar un flujo no rompe conversaciones en curso.

## Seguridad: cómo se autentican las funciones

Las Edge Functions de este proyecto reciben `SUPABASE_SERVICE_ROLE_KEY` en el **formato nuevo** (`sb_secret_…`), no como JWT.
Por eso:
- Las llamadas entre funciones (webhook → `flow-engine` / `nora-responder`) usan esa clave del entorno y funcionan.
- El cron usa la **Secret key nueva** guardada en el Vault como `service_role_key`. La clave antigua (JWT `eyJ…`) y el *JWT Secret*
  **no sirven** aquí: `flow-engine` responde 403.
- Nunca pegar claves en chats ni en el repositorio.

## Puesta en marcha

1. **Base de datos:** migraciones 0002–0007 → `sql/0008_flujos.sql` → `sql/0009_0011_cron_flujos.sql`.
2. **Secretos del cron:** `select vault.create_secret('sb_secret_...', 'service_role_key');` (SQL Editor).
3. **Secretos de las funciones** (Supabase → Edge Functions → Secrets): `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN`,
   `OPENAI_API_KEY`, `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID`, `ELEVENLABS_MODEL` (recomendado `eleven_flash_v2_5`)
   y, opcional, `ANTHROPIC_API_KEY`, `NORA_LLM_PROVIDER`, `NORA_OPENAI_MODEL`.
4. **Funciones:** desplegar `flow-engine` (`verify_jwt=true`, incluye `motor.ts`), `whatsapp-webhook` (`verify_jwt=false`) y `nora-responder` (`verify_jwt=true`).
5. **Panel (Vercel):** variables `VITE_SUPABASE_URL`, `VITE_SUPABASE_KEY` (publishable `sb_publishable_…`), y para conectar números
   `VITE_META_APP_ID` y `VITE_META_CONFIG_ID`.
6. **Meta:** app con el producto WhatsApp y el webhook `https://xjqxabmnkyzifehmvnew.supabase.co/functions/v1/whatsapp-webhook`.

## Desplegar el panel reutilizando los archivos originales

La API de despliegue de Vercel acepta, por archivo, el contenido o su huella SHA1 (si ya está en el almacén del equipo).
Los archivos nuevos de `panel/` se suben con su contenido; los originales se referencian por SHA1. Las rutas son **relativas a la raíz
del proyecto** (`index.html`, `package.json`, `src/App.jsx`, …), sin prefijo extra: un `src/` de más rompe `npm install`.

## Tests

```bash
cd motor && node --experimental-strip-types --no-warnings --test motor.test.mjs
```

`motor/motor.ts` es la fuente única; `panel/motor.ts` y `functions/flow-engine/motor.ts` son copias. Si se modifica, copiarlo a los tres sitios.

## Limitaciones conocidas

- Los flujos solo entienden **texto**: si el cliente responde con audio a una pregunta, se le pide que escriba.
- Durante un paso «Esperar», si el cliente escribe, responde Nora.
- Las etapas son cuatro fijas (`nuevo`, `interesado`, `cliente`, `perdido`).
- La bandeja es de solo lectura: se puede pausar/reactivar a Nora por conversación, pero **responder como persona desde el panel aún no existe**
  (haría falta una función que envíe por Meta con el token del número).
- Ningún mensaje real de WhatsApp ha pasado todavía por la cadena completa: falta conectar Meta.
