// Motor de flujos de Nora (estilo Salesbot de Kommo).
// POST { conversation_id, wamid } — lo llama el webhook por cada mensaje nuevo, con la service role key.
//   → { handled: true }  el flujo se ocupó del mensaje: el webhook NO llama a nora-responder.
//   → { handled: false } no hay flujo (o terminó en "Nora responde"): el webhook llama a nora-responder.
// POST { tick: true } — lo llama un cron cada minuto: despierta los flujos que estaban en un paso "Esperar".
// La lógica de los pasos vive en ./motor.ts (la misma que usa el simulador del panel).
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'npm:@supabase/supabase-js@2';
import { timingSafeEqual } from 'node:crypto';
import { avanzar, compilar, estadoInicial, interpolar, type Accion, type Definicion, type Estado } from './motor.ts';

const GRAPH = 'https://graph.facebook.com/v23.0';
const TIPOS_TEXTO = ['text', 'button', 'interactive', 'location'];
const ETAPAS = ['nuevo', 'interesado', 'cliente', 'perdido'];
const MAX_TICK = 50;

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } });
const msgError = (e: unknown) => String((e as Error)?.message || e).slice(0, 300);
const norm = (s: unknown) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

function esServicio(req: Request): boolean {
  const clave = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
  const real = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
  const a = new TextEncoder().encode(clave), b = new TextEncoder().encode(real);
  return !!real && a.length === b.length && timingSafeEqual(a, b);
}

async function enviarTexto(admin: any, phoneNumberId: string, para: string, texto: string) {
  const { data: secreto } = await admin.rpc('leer_secreto_whatsapp', { p_phone_number_id: phoneNumberId });
  let token = '';
  try { token = JSON.parse(secreto || '{}').token || ''; } catch { /* secreto mal formado */ }
  if (!token) return { ok: false, error: 'Sin token de WhatsApp para este número' } as { ok: boolean; wamid?: string; error?: string };
  const r = await fetch(`${GRAPH}/${phoneNumberId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to: para, type: 'text', text: { body: texto, preview_url: false } }),
    signal: AbortSignal.timeout(15000),
  });
  const d: any = await r.json().catch(() => ({}));
  if (!r.ok) return { ok: false, error: d?.error?.message || `Meta respondió ${r.status}` };
  return { ok: true, wamid: d?.messages?.[0]?.id as string | undefined };
}

// Ejecuta las acciones que pidió el motor. Un fallo de envío no tumba el flujo: queda registrado en el mensaje.
async function aplicar(admin: any, conv: any, contactId: string | null, acciones: Accion[]) {
  for (const a of acciones) {
    try {
      if (a.tipo === 'enviar') {
        const envio = await enviarTexto(admin, conv.phone_number_id, conv.phone, a.texto);
        await admin.from('messages').insert({
          organization_id: conv.organization_id, conversation_id: conv.id, wamid: envio.wamid ?? null, direction: 'saliente', autor: 'nora', type: 'text',
          body: a.texto, delivery_status: envio.ok ? 'sent' : 'failed', delivery_error: envio.ok ? null : envio.error,
        });
      } else if (a.tipo === 'guardar' && contactId) {
        await admin.rpc('contacto_guardar_dato', { p_contact: contactId, p_campo: a.campo, p_valor: a.valor });
      } else if (a.tipo === 'etiquetar' && contactId) {
        await admin.rpc('contacto_agregar_etiqueta', { p_contact: contactId, p_etiqueta: a.etiqueta });
      } else if (a.tipo === 'etapa' && contactId && ETAPAS.includes(a.etapa)) {
        await admin.from('contacts').update({ etapa: a.etapa }).eq('id', contactId);
      } else if (a.tipo === 'humano') {
        await admin.from('conversations').update({ atiende: 'humano', handoff_reason: a.motivo }).eq('id', conv.id);
      }
    } catch (e) { console.error('accion', a.tipo, msgError(e)); }
  }
}

function estadoAFila(estado: Estado) {
  const terminado = estado.fin !== null;
  return {
    estado,
    status: terminado ? 'completada' : 'activa',
    siguiente_ejecucion: !terminado && estado.esperando?.tipo === 'tiempo' ? estado.esperando.hasta : null,
  };
}

// Avanza una ejecución. El UPDATE con `updated_at` evita que dos mensajes seguidos la avancen a la vez.
async function ejecutar(admin: any, conv: any, run: any, entrada: string | null): Promise<{ fin: Estado['fin'] }> {
  const prog = compilar((run.definicion as Definicion).pasos || []);
  const { estado, acciones } = avanzar(prog, run.estado as Estado, entrada);
  const { data: tomada } = await admin.from('flujo_ejecuciones').update(estadoAFila(estado))
    .eq('id', run.id).eq('updated_at', run.updated_at).eq('status', 'activa').select('id');
  if (!tomada?.length) return { fin: null };  // otro proceso ya la avanzó
  await aplicar(admin, conv, run.contact_id, acciones);
  return { fin: estado.fin };
}

async function cargarConversacion(admin: any, conversationId: string) {
  const { data: c } = await admin.from('conversations')
    .select('id, organization_id, atiende, contact_id, connection_id, contacts(phone, name, datos), whatsapp_connections(phone_number_id)')
    .eq('id', conversationId).maybeSingle();
  if (!c) return null;
  return {
    id: c.id, organization_id: c.organization_id, atiende: c.atiende, contact_id: c.contact_id as string | null,
    phone: String(c.contacts?.phone || ''), nombre: c.contacts?.name as string | null, datos: (c.contacts?.datos || {}) as Record<string, string>,
    phone_number_id: String(c.whatsapp_connections?.phone_number_id || ''),
  };
}

async function tick(admin: any) {
  const { data: runs } = await admin.from('flujo_ejecuciones').select('*').eq('status', 'activa')
    .lte('siguiente_ejecucion', new Date().toISOString()).limit(MAX_TICK);
  let n = 0;
  for (const run of runs || []) {
    try {
      const conv = await cargarConversacion(admin, run.conversation_id);
      if (!conv || conv.atiende !== 'nora' || !conv.phone_number_id) {
        await admin.from('flujo_ejecuciones').update({ status: 'cancelada', siguiente_ejecucion: null }).eq('id', run.id);
        continue;
      }
      await ejecutar(admin, conv, run, null);
      n++;
    } catch (e) {
      console.error('tick', run.id, msgError(e));
      await admin.from('flujo_ejecuciones').update({ status: 'error', error: msgError(e), siguiente_ejecucion: null }).eq('id', run.id);
    }
  }
  return { ok: true, procesadas: n };
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'Método no permitido' }, 405);
  if (!esServicio(req)) return json({ error: 'Solo uso interno' }, 403);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: 'JSON inválido' }, 400); }
  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

  if (body?.tick) return json(await tick(admin));

  const { conversation_id, wamid } = body || {};
  if (!conversation_id || !wamid) return json({ error: 'Faltan conversation_id y wamid' }, 400);

  try {
    const conv = await cargarConversacion(admin, conversation_id);
    if (!conv || !conv.phone_number_id || !conv.phone) return json({ handled: false });

    // Si una persona tomó el chat, el flujo en curso se cancela y no se arranca otro.
    if (conv.atiende !== 'nora') {
      await admin.from('flujo_ejecuciones').update({ status: 'cancelada', siguiente_ejecucion: null }).eq('conversation_id', conv.id).eq('status', 'activa');
      return json({ handled: false });
    }

    const { data: msg } = await admin.from('messages').select('type, body, transcripcion, created_at')
      .eq('conversation_id', conv.id).eq('wamid', wamid).maybeSingle();
    if (!msg) return json({ handled: false });
    const texto = String(msg.transcripcion || msg.body || '');

    // 1) ¿Hay un flujo en curso para esta conversación?
    const { data: run } = await admin.from('flujo_ejecuciones').select('*').eq('conversation_id', conv.id).eq('status', 'activa').maybeSingle();
    if (run) {
      if (run.estado?.esperando?.tipo === 'tiempo') return json({ handled: false });          // está en una pausa: Nora atiende mientras tanto
      if (run.estado?.esperando?.tipo === 'respuesta' && !TIPOS_TEXTO.includes(msg.type)) {
        // Audio, imagen…: por ahora el flujo solo entiende texto
        await aplicar(admin, conv, run.contact_id, [{ tipo: 'enviar', texto: 'Por favor respóndeme por escrito 🙏' }]);
        return json({ handled: true });
      }
      await ejecutar(admin, conv, run, texto);
      return json({ handled: true });  // el mensaje del cliente ya se usó como respuesta del flujo (aunque este termine en "Nora responde")
    }

    // 2) Si no, ¿algún flujo activo se dispara con este mensaje?
    const { data: flujos } = await admin.from('flujos').select('id, disparador, definicion')
      .eq('organization_id', conv.organization_id).eq('activo', true).order('created_at');
    if (!flujos?.length) return json({ handled: false });

    const { count: entrantes } = await admin.from('messages').select('id', { count: 'exact', head: true })
      .eq('conversation_id', conv.id).eq('direction', 'entrante');
    const nuevaConversacion = (entrantes ?? 0) <= 1;
    const t = norm(texto);
    const elegido = flujos.find((f: any) => {
      if (f.disparador?.tipo === 'conversacion_nueva') return nuevaConversacion;
      if (f.disparador?.tipo === 'palabra_clave') return (f.disparador.palabras || []).some((p: string) => norm(p).trim() && t.includes(norm(p).trim()));
      return false;
    });
    if (!elegido) return json({ handled: false });

    const datos = { ...conv.datos, ...(conv.nombre ? { nombre: conv.nombre } : {}) };
    const estado = estadoInicial(datos);
    const { data: nueva, error } = await admin.from('flujo_ejecuciones').insert({
      organization_id: conv.organization_id, flujo_id: elegido.id, conversation_id: conv.id, contact_id: conv.contact_id,
      definicion: elegido.definicion, estado,
    }).select('*').single();
    if (error) {  // otro mensaje la creó justo antes (índice único): se deja que la atienda esa
      console.error('crear ejecución', error.message);
      return json({ handled: true });
    }
    const r = await ejecutar(admin, conv, nueva, null);
    // Si el flujo arranca directamente con "Nora responde", este mismo mensaje lo contesta Nora.
    return json({ handled: !(r.fin === 'nora' && !(await huboMensajes(admin, conv.id, msg.created_at))) });
  } catch (e) {
    console.error('flow-engine', msgError(e));
    return json({ handled: false });   // ante un fallo, que Nora responda: nunca dejar al cliente sin respuesta
  }
});

async function huboMensajes(admin: any, conversationId: string, desde: string): Promise<boolean> {
  const { count } = await admin.from('messages').select('id', { count: 'exact', head: true })
    .eq('conversation_id', conversationId).eq('direction', 'saliente').gt('created_at', desde);
  return (count ?? 0) > 0;
}
