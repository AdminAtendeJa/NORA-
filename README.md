# Nora SaaS

Nora es un agente de WhatsApp multi-negocio: responde con el conocimiento de cada negocio, entiende audios,
contesta con voz y ejecuta **flujos de automatización estilo Kommo (Salesbot)** que el dueño arma desde un panel.

- **Backend:** Supabase (proyecto `xjqxabmnkyzifehmvnew`): base de datos con RLS por negocio, Edge Functions, Vault y cron.
- **Panel:** Vercel, proyecto `nora-panel` (producción: `nora-panel-seven.vercel.app`). React + Vite.
- **IA:** OpenAI (texto y transcripción de audios) o Claude; voz con ElevenLabs.

## Contenido del repositorio

| Carpeta | Qué es | Estado |
|---|---|---|
| `motor/` | Motor de flujos **v2, basado en grafo de nodos** (lógica pura) y sus 17 tests | Probado |
| `panel/` | `Panel.jsx` (bandeja, flujos, conocimiento, WhatsApp), `Flujos.jsx` (**editor de lienzo estilo Kommo** con previsualización), estilos, `motor.ts` y `package.json` (añade `@xyflow/react`) | En producción |
| `sql/0008_flujos.sql` | Tablas `flujos` y `flujo_ejecuciones`, RLS y funciones | Aplicada |
| `sql/0009_0011_cron_flujos.sql` | Cron que despierta los pasos «Esperar» y los «Sin respuesta» (estado final) | Aplicada |
| `sql/0012_flujos_grafo.sql` | Cambia `flujos.definicion` de lista de pasos a grafo (`nodos` + `aristas`) | Aplicada |
| `functions/flow-engine/` | Ejecuta los flujos (botones nativos de WhatsApp, tiempos límite) | Desplegada (v2) |
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

## Cómo funciona un flujo (como el Salesbot de Kommo)

El dueño arma el flujo en un **lienzo**: cada paso es una caja arrastrable y las líneas unen una **salida** con el paso siguiente.

- **Inicio:** se lanza cuando entra un cliente nuevo (su primer mensaje) o cuando escribe una palabra clave.
- **Mensaje:** texto con hasta 10 **botones de respuesta**. Cada botón tiene su propia salida y admite **sinónimos** (si el cliente escribe en vez de pulsar).
  Hasta 3 botones salen como botones nativos de WhatsApp; con más, como lista numerada. Salidas extra: **«Otra respuesta»** y **«Sin respuesta tras N min»**.
- **Pregunta:** pide un dato, lo valida (texto, número, sí/no, opciones) y lo guarda en `contacts.datos`. Salidas: válida, no válida (tras 3 intentos), sin respuesta.
- **Condición** (sí/no), **Pausa**, **Etiqueta**, **Etapa**, **Pasar a una persona**, **Nora responde** y **Detener bot**.
- **Previsualizar bot:** ejecuta el mismo motor que el servidor, con botones pulsables y un botón para simular que pasa el tiempo.

Definición guardada (`flujos.definicion`): `{ "version": 2, "nodos": [...], "aristas": [{ "de", "puerto", "a" }] }`.
Puertos: `next`, `btn:N`, `otra`, `timeout`, `si`, `no`.

El webhook llama a `flow-engine`; si devuelve `handled: true` no responde Nora. Si falla o no hay flujo, responde Nora.
Cada ejecución congela la definición al empezar: editar un flujo no rompe conversaciones en curso.

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

- Los flujos solo entienden **texto y botones**: si el cliente responde con audio a una pregunta, se le pide que escriba.
- Durante un paso «Pausa», si el cliente escribe, responde Nora.
- Las etapas son cuatro fijas (`nuevo`, `interesado`, `cliente`, `perdido`).
- Los botones son «respuestas rápidas» de WhatsApp (máx. 3 nativos, 20 caracteres). No hay aún disparadores por etapa ni retraso de arranque (Kommo sí los tiene).
- La previsualización del lienzo está probada con datos falsos; los botones nativos de WhatsApp no se han probado con Meta real.
- La bandeja es de solo lectura: se puede pausar/reactivar a Nora por conversación, pero **responder como persona desde el panel aún no existe**
  (haría falta una función que envíe por Meta con el token del número).
- Ningún mensaje real de WhatsApp ha pasado todavía por la cadena completa: falta conectar Meta.
