import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from './supabase.js';
import Conectar from './Conectar.jsx';
import Conocimiento from './Conocimiento.jsx';
import Flujos from './Flujos.jsx';
import './panel.css';

const PESTANAS = [
  ['conversaciones', 'Conversaciones'],
  ['flujos', 'Flujos'],
  ['conocimiento', 'Conocimiento'],
  ['whatsapp', 'WhatsApp'],
];

export default function Panel({ session, org, orgs, onCambiarOrg }) {
  const [tab, setTab] = useState('conversaciones');
  return (
    <div className="app">
      <header className="barra">
        <strong className="logo">Nora</strong>
        {orgs.length > 1
          ? <select value={org.id} onChange={(e) => onCambiarOrg(e.target.value)}>{orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select>
          : <span className="suave">{org.name}</span>}
        <nav>
          {PESTANAS.map(([id, nombre]) => (
            <button key={id} className={tab === id ? 'activa' : ''} onClick={() => setTab(id)}>{nombre}</button>
          ))}
        </nav>
        <span className="espacio" />
        <span className="suave pequeno">{session.user.email}</span>
        <button className="enlace" onClick={() => supabase.auth.signOut()}>Salir</button>
      </header>
      {tab === 'conversaciones' && <Conversaciones org={org} />}
      {tab === 'flujos' && <Flujos org={org} supabase={supabase} />}
      {tab === 'conocimiento' && <Conocimiento org={org} />}
      {tab === 'whatsapp' && <Conexiones org={org} session={session} />}
    </div>
  );
}

const hora = (iso) => {
  if (!iso) return '';
  const d = new Date(iso), hoy = new Date();
  return d.toDateString() === hoy.toDateString()
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString([], { day: '2-digit', month: 'short' });
};

function Conversaciones({ org }) {
  const [lista, setLista] = useState(null);
  const [sel, setSel] = useState(null);
  const [mensajes, setMensajes] = useState([]);
  const [error, setError] = useState('');
  const selRef = useRef(null);
  const finRef = useRef(null);
  selRef.current = sel;
  const puedeEditar = org.role === 'dueno' || org.role === 'admin' || org.role === 'agente';

  const cargarLista = useCallback(async () => {
    const { data, error: e } = await supabase.from('conversations')
      .select('id, atiende, needs_human, handoff_reason, unread_count, ultimo_mensaje, last_message_at, contacts(name, phone, etapa, tags, datos)')
      .eq('organization_id', org.id)
      .order('last_message_at', { ascending: false, nullsFirst: false }).limit(100);
    if (e) { setError(e.message); setLista([]); return; }
    setError(''); setLista(data || []);
  }, [org.id]);

  const cargarMensajes = useCallback(async (id) => {
    if (!id) return;
    const { data } = await supabase.from('messages')
      .select('id, direction, autor, type, body, transcripcion, delivery_status, delivery_error, created_at')
      .eq('conversation_id', id).order('created_at', { ascending: true }).limit(300);
    if (selRef.current === id) setMensajes(data || []);
  }, []);

  // Tiempo real (cada mensaje o cambio de conversación) con un refresco de respaldo cada 15 s.
  useEffect(() => {
    setSel(null); setMensajes([]); setLista(null);
    cargarLista();
    const canal = supabase.channel(`bandeja-${org.id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'conversations', filter: `organization_id=eq.${org.id}` }, () => cargarLista())
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages', filter: `organization_id=eq.${org.id}` }, (p) => {
        cargarLista();
        if (p.new?.conversation_id === selRef.current) cargarMensajes(selRef.current);
      })
      .subscribe();
    const t = setInterval(() => { cargarLista(); if (selRef.current) cargarMensajes(selRef.current); }, 15000);
    return () => { supabase.removeChannel(canal); clearInterval(t); };
  }, [org.id, cargarLista, cargarMensajes]);

  useEffect(() => { finRef.current?.scrollIntoView?.({ block: 'end' }); }, [mensajes]);

  async function abrir(c) {
    setSel(c.id); setMensajes([]);
    await cargarMensajes(c.id);
    if (c.unread_count > 0) {
      await supabase.from('conversations').update({ unread_count: 0 }).eq('id', c.id);
      cargarLista();
    }
  }
  async function cambiarAtiende(c, atiende) {
    const { error: e } = await supabase.from('conversations').update({ atiende }).eq('id', c.id);
    if (e) setError(e.message); else cargarLista();
  }

  const actual = (lista || []).find((c) => c.id === sel);
  if (lista === null) return <div className="centro">Cargando…</div>;

  return (
    <div className="pn-bandeja">
      <aside className="pn-lista" aria-label="Conversaciones">
        {error && <p className="error">{error}</p>}
        {lista.length === 0 && <p className="suave pn-pad">Aún no hay conversaciones. Aparecerán cuando un cliente escriba al número conectado.</p>}
        <ul>
          {lista.map((c) => (
            <li key={c.id}>
              <button className={`pn-fila ${sel === c.id ? 'sel' : ''}`} onClick={() => abrir(c)}>
                <span className="pn-fila-cab">
                  <b>{c.contacts?.name || c.contacts?.phone || 'Cliente'}</b>
                  <small className="suave">{hora(c.last_message_at)}</small>
                </span>
                <span className="pn-fila-pie">
                  <span className="pn-previa">{c.ultimo_mensaje || '—'}</span>
                  {c.needs_human && <span className="pn-badge aviso" title={c.handoff_reason || ''}>Necesita persona</span>}
                  {c.atiende === 'humano' && !c.needs_human && <span className="pn-badge">Pausada</span>}
                  {c.unread_count > 0 && <span className="pn-badge cuenta">{c.unread_count}</span>}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </aside>

      <section className="pn-chat">
        {!actual ? <p className="suave pn-vacio">Elige una conversación.</p> : (
          <>
            <div className="pn-chat-cab">
              <div>
                <b>{actual.contacts?.name || 'Cliente'}</b> <span className="suave">{actual.contacts?.phone}</span>
                <div className="pn-datos">
                  {actual.contacts?.etapa && <span className="pn-chip">Etapa: {actual.contacts.etapa}</span>}
                  {(actual.contacts?.tags || []).map((t) => <span className="pn-chip" key={t}>🏷️ {t}</span>)}
                  {Object.entries(actual.contacts?.datos || {}).map(([k, v]) => <span className="pn-chip dato" key={k}>{k}: {String(v)}</span>)}
                </div>
              </div>
              {puedeEditar && (
                actual.atiende === 'nora'
                  ? <button onClick={() => cambiarAtiende(actual, 'humano')} title="Nora deja de responder en este chat">Pausar a Nora</button>
                  : <button className="primario" onClick={() => cambiarAtiende(actual, 'nora')}>Reactivar a Nora</button>
              )}
            </div>
            {actual.needs_human && <p className="pn-alerta">Nora pidió ayuda{actual.handoff_reason ? `: ${actual.handoff_reason}` : ''}. Responde al cliente desde WhatsApp.</p>}
            <div className="pn-mensajes" role="log">
              {mensajes.map((m) => (
                <div key={m.id} className={`pn-burbuja ${m.direction === 'entrante' ? 'in' : 'out'}`}>
                  <small className="suave">{m.direction === 'entrante' ? 'Cliente' : m.autor === 'humano' ? 'Persona' : 'Nora'}{m.type === 'audio' ? ' · 🎤 audio' : ''}</small>
                  <div>{m.type === 'audio' && m.direction === 'entrante' ? (m.transcripcion || '[audio sin transcribir]') : m.body}</div>
                  {m.delivery_status === 'failed' && <small className="error">No se pudo enviar{m.delivery_error ? `: ${m.delivery_error}` : ''}</small>}
                  <small className="suave pn-hora">{hora(m.created_at)}</small>
                </div>
              ))}
              <div ref={finRef} />
            </div>
          </>
        )}
      </section>
    </div>
  );
}

function Conexiones({ org }) {
  const [filas, setFilas] = useState(null);
  const [error, setError] = useState('');
  const puedeEditar = org.role === 'dueno' || org.role === 'admin';

  const cargar = useCallback(async () => {
    const { data, error: e } = await supabase.from('whatsapp_connections')
      .select('id, display_phone, phone_number_id, status, quality_rating, created_at').eq('organization_id', org.id).order('created_at');
    if (e) { setError(e.message); setFilas([]); return; }
    setError(''); setFilas(data || []);
  }, [org.id]);
  useEffect(() => { setFilas(null); cargar(); }, [cargar]);

  async function desconectar(f) {
    if (!window.confirm(`¿Desconectar ${f.display_phone || f.phone_number_id}? Nora dejará de responder en ese número.`)) return;
    const { error: e } = await supabase.rpc('desconectar_whatsapp', { p_connection_id: f.id });
    if (e) setError(e.message); else cargar();
  }

  return (
    <main className="pagina ancha">
      <h2>Números de WhatsApp</h2>
      <p className="suave">Cada número conectado lo atiende Nora con el conocimiento y los flujos de este negocio.</p>
      {error && <p className="error">{error}</p>}
      {filas === null ? <p className="suave">Cargando…</p> : filas.length === 0
        ? <p className="suave">Todavía no hay números conectados.</p>
        : (
          <ul className="pn-numeros">
            {filas.map((f) => (
              <li key={f.id} className="pn-numero">
                <div><b>{f.display_phone || f.phone_number_id}</b>
                  <div className="suave pequeno">Estado: {f.status}{f.quality_rating ? ` · Calidad: ${f.quality_rating}` : ''}</div></div>
                {puedeEditar && <button onClick={() => desconectar(f)}>Desconectar</button>}
              </li>
            ))}
          </ul>
        )}
      {puedeEditar && <Conectar orgId={org.id} onListo={cargar} />}
    </main>
  );
}
