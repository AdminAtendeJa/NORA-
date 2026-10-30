// Webhook de WhatsApp Cloud API (Meta) para todos los clientes de Nora.
// GET  → verificación de Meta (hub.challenge).
// POST → valida la firma, resuelve la organización por `phone_number_id`, guarda mensajes y estados de entrega
//        y, si la conversación la atiende Nora, dispara `nora-responder`.
// Secretos (Supabase → Edge Functions → Secrets): WHATSAPP_VERIFY_TOKEN y WHATSAPP_APP_SECRET.
// Sin WHATSAPP_APP_SECRET se rechaza todo POST. Se despliega con verify_jwt = false (Meta no manda JWT).
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'npm:@supabase/supabase-js@2';
import { timingSafeEqual } from 'node:crypto';

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void };

async function firmaValida(req: Request, raw: string): Promise<boolean> {
  const secret = Deno.env.get('WHATSAPP_APP_SECRET');
  if (!secret) { console.error('Falta WHATSAPP_APP_SECRET: se rechaza el webhook'); return false; }
  const header = req.headers.get('x-hub-signature-256') || '';
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(raw));
  const hex = Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('');
  const esperado = new TextEncoder().encode(`sha256=${hex}`), recibido = new TextEncoder().encode(header);
  return esperado.length === recibido.length && timingSafeEqual(esperado, recibido);
}

// Texto legible de cada tipo de mensaje. Los audios se transcriben después, en `nora-responder`.
function contenidoDe(m: any): string | null {
  switch (m.type) {
    case 'text': return m.text?.body ?? null;
    case 'image': return m.image?.caption ?? '[imagen]';
    case 'audio': return '[audio]';
    case 'video': return m.video?.caption ?? '[video]';
    case 'document': return m.document?.caption ?? '[documento]';
    case 'sticker': return '[sticker]';
    case 'button': return m.button?.text ?? null;
    case 'interactive': return m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title ?? null;
    case 'location': {
      const l = m.location || {};
      return `Ubicación: ${l.latitude}, ${l.longitude}${l.name ? ` (${l.name})` : ''}`;
    }
    case 'reaction': return m.reaction?.emoji ? `Reacción: ${m.reaction.emoji}` : null;
    default: return `[mensaje de tipo "${m.type}" no soportado]`;
  }
}

// Archivo adjunto (audio, imagen, video, documento, sticker): su id en Meta sirve para descargarlo después.
const TIPOS_CON_ARCHIVO = ['audio', 'image', 'video', 'document', 'sticker'];
function archivoDe(m: any): { id: string | null; mime: string | null } {
  if (!TIPOS_CON_ARCHIVO.includes(m.type)) return { id: null, mime: null };
  const a = m[m.type] || {};
  return { id: a.id ?? null, mime: a.mime_type ?? null };
}

async function llamar(funcion: string, cuerpo: Record<string, unknown>, ms: number): Promise<any> {
  const r = await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/${funcion}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cuerpo),
    signal: AbortSignal.timeout(ms),
  });
  return r.json().catch(() => ({}));
}

async function despachar(conversationId: string, wamid: string, tipo: string) {
  let manejado = false;
  try {
    const r = await llamar('flow-engine', { conversation_id: conversationId, wamid }, 30_000);
    manejado = r?.handled === true;
  } catch (err) { console.error('flow-engine', err); }
  if (manejado) return;
  try { await llamar('nora-responder', { conversation_id: conversationId, wamid }, 120_000); }
  catch (err) { console.error('nora-responder', tipo, err); }
}

async function procesar(body: any) {
  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

  for (const entry of body?.entry || []) {
    for (const change of entry?.changes || []) {
      const value = change?.value || {};
      const phoneNumberId = String(value?.metadata?.phone_number_id || '');
      if (!phoneNumberId) continue;

      const nombres: Record<string, string> = {};
      for (const c of value.contacts || []) nombres[c.wa_id] = c.profile?.name;

      for (const s of value.statuses || []) {
        const e = s.errors?.[0];
        const detalle = e ? [e.title, e.error_data?.details, e.code ? `(código ${e.code})` : null].filter(Boolean).join(' — ') : null;
        const { error } = await admin.rpc('whatsapp_actualizar_estado', { p_wamid: s.id, p_estado: s.status, p_error: detalle });
        if (error) console.error('estado', error.message);
      }

      for (const m of value.messages || []) {
        try {
          const from = String(m.from || '').replace(/\D/g, '');
          const archivo = archivoDe(m);
          const { data, error } = await admin.rpc('whatsapp_registrar_entrante', {
            p_phone_number_id: phoneNumberId,
            p_from: from,
            p_name: nombres[m.from] ?? null,
            p_wamid: m.id,
            p_type: m.type,
            p_body: contenidoDe(m),
            p_media_id: archivo.id,
            p_media_mime: archivo.mime,
          });
          if (error) { console.error('registrar', error.message); continue; }
          if (data === null) { console.error('Número sin registrar en whatsapp_connections:', phoneNumberId); continue; }

          // Si la conversación la atiende Nora y el mensaje es nuevo (no un reintento de Meta): primero lo ve el motor de flujos
          // (automatizaciones del dueño); si no se ocupa de él, responde Nora. Si el motor falla, responde Nora.
          if (!data.duplicado && data.atiende === 'nora' && m.type !== 'reaction') {
            EdgeRuntime.waitUntil(despachar(data.conversation_id, m.id, m.type));
          }
        } catch (err) {
          console.error('mensaje', m?.id, err);
        }
      }
    }
  }
}

Deno.serve(async (req) => {
  if (req.method === 'GET') {
    const u = new URL(req.url);
    const token = Deno.env.get('WHATSAPP_VERIFY_TOKEN');
    if (token && u.searchParams.get('hub.mode') === 'subscribe' && u.searchParams.get('hub.verify_token') === token) {
      return new Response(u.searchParams.get('hub.challenge') || '', { status: 200 });
    }
    return new Response('Forbidden', { status: 403 });
  }
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const raw = await req.text();
  if (!(await firmaValida(req, raw))) return new Response('Firma inválida', { status: 401 });

  let body: any;
  try { body = JSON.parse(raw); } catch { return new Response('JSON inválido', { status: 400 }); }

  // Se procesa antes de responder: así un fallo se ve en los logs y Meta reintenta solo si devolvemos error.
  try { await procesar(body); } catch (err) { console.error('procesar', err); }
  return new Response('ok', { status: 200 });
});
