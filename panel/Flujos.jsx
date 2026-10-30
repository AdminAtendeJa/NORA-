import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { avanzar, compilar, estadoInicial, revisar } from './motor.ts';
import './flujos.css';

// Constructor de flujos (estilo Salesbot de Kommo): el dueño arma pasos y ramas, y los prueba en el simulador.
// Uso: <Flujos org={org} supabase={supabase} />   (org trae { id, role })

const TIPOS = {
  mensaje: { nombre: 'Enviar mensaje', icono: '💬', ayuda: 'Nora escribe un texto' },
  pregunta: { nombre: 'Hacer una pregunta', icono: '❓', ayuda: 'Espera la respuesta y la guarda' },
  condicion: { nombre: 'Condición', icono: '🔀', ayuda: 'Si pasa X hace una cosa, si no, otra' },
  esperar: { nombre: 'Esperar', icono: '⏱️', ayuda: 'Pausa antes del siguiente paso' },
  etiquetar: { nombre: 'Poner etiqueta', icono: '🏷️', ayuda: 'Marca al cliente' },
  etapa: { nombre: 'Cambiar etapa', icono: '📍', ayuda: 'Mueve al cliente en el embudo' },
  humano: { nombre: 'Pasar a una persona', icono: '🙋', ayuda: 'Termina el flujo y avisa al equipo' },
  nora: { nombre: 'Nora responde', icono: '🤖', ayuda: 'Termina el flujo; sigue la IA' },
};
const ETAPAS = [['nuevo', 'Nuevo'], ['interesado', 'Interesado'], ['cliente', 'Cliente'], ['perdido', 'Perdido']];
const VALIDACIONES = [['texto', 'Texto libre'], ['numero', 'Número'], ['si_no', 'Sí / No'], ['opciones', 'Opciones']];
const OPERADORES = [['igual', 'es igual a'], ['distinto', 'es distinto de'], ['contiene', 'contiene'], ['mayor', 'es mayor que'], ['menor', 'es menor que'], ['existe', 'tiene respuesta']];

const uid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2));
const nuevoPaso = (tipo) => {
  const base = { id: uid(), tipo };
  switch (tipo) {
    case 'mensaje': return { ...base, texto: '' };
    case 'pregunta': return { ...base, texto: '', campo: '', validacion: 'texto', opciones: [] };
    case 'condicion': return { ...base, campo: '', op: 'igual', valor: '', si: [], si_no: [] };
    case 'esperar': return { ...base, minutos: 5 };
    case 'etiquetar': return { ...base, etiqueta: '' };
    case 'etapa': return { ...base, etapa: 'interesado' };
    case 'humano': return { ...base, motivo: '' };
    default: return base;
  }
};
const flujoVacio = () => ({ id: null, nombre: 'Nuevo flujo', activo: false, disparador: { tipo: 'conversacion_nueva' }, definicion: { pasos: [] } });
const slug = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 30);

function camposDe(pasos, acc = []) {
  for (const p of pasos) {
    if (p.tipo === 'pregunta' && p.campo) acc.push(p.campo);
    if (p.tipo === 'condicion') { camposDe(p.si || [], acc); camposDe(p.si_no || [], acc); }
  }
  return acc;
}

function MenuAgregar({ onAgregar }) {
  const [abierto, setAbierto] = useState(false);
  return (
    <div className="fl-agregar">
      <button type="button" className="fl-btn-agregar" onClick={() => setAbierto(!abierto)} aria-expanded={abierto}>＋ Agregar paso</button>
      {abierto && (
        <div className="fl-menu" role="menu">
          {Object.entries(TIPOS).map(([t, d]) => (
            <button type="button" role="menuitem" key={t} onClick={() => { onAgregar(t); setAbierto(false); }}>
              <span className="fl-ico">{d.icono}</span><span><b>{d.nombre}</b><small>{d.ayuda}</small></span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function CamposPaso({ paso, cambiar, campos }) {
  const { tipo } = paso;
  if (tipo === 'mensaje') return (
    <textarea rows={2} placeholder="Escribe el mensaje. Usa {{nombre}} para insertar datos del cliente." value={paso.texto} onChange={(e) => cambiar({ texto: e.target.value })} />
  );
  if (tipo === 'pregunta') return (
    <>
      <textarea rows={2} placeholder="¿Qué quieres preguntar?" value={paso.texto} onChange={(e) => cambiar({ texto: e.target.value })} />
      <div className="fl-fila">
        <label>Guardar como
          <input placeholder="ej. presupuesto" value={paso.campo} onChange={(e) => cambiar({ campo: slug(e.target.value) })} />
        </label>
        <label>Tipo de respuesta
          <select value={paso.validacion} onChange={(e) => cambiar({ validacion: e.target.value })}>
            {VALIDACIONES.map(([v, n]) => <option key={v} value={v}>{n}</option>)}
          </select>
        </label>
      </div>
      {paso.validacion === 'opciones' && (
        <label>Opciones (una por línea)
          <textarea rows={3} value={(paso.opciones || []).join('\n')} onChange={(e) => cambiar({ opciones: e.target.value.split('\n') })} />
        </label>
      )}
    </>
  );
  if (tipo === 'condicion') return (
    <div className="fl-fila fl-cond">
      <span>Si</span>
      <select value={paso.campo} onChange={(e) => cambiar({ campo: e.target.value })} aria-label="Dato">
        <option value="">— dato —</option>
        {[...new Set(['nombre', ...campos])].map((c) => <option key={c} value={c}>{c}</option>)}
      </select>
      <select value={paso.op} onChange={(e) => cambiar({ op: e.target.value })} aria-label="Condición">
        {OPERADORES.map(([v, n]) => <option key={v} value={v}>{n}</option>)}
      </select>
      {paso.op !== 'existe' && <input placeholder="valor" value={paso.valor ?? ''} onChange={(e) => cambiar({ valor: e.target.value })} aria-label="Valor" />}
    </div>
  );
  if (tipo === 'esperar') return (
    <label className="fl-inline">Esperar <input type="number" min="1" value={paso.minutos} onChange={(e) => cambiar({ minutos: Number(e.target.value) })} /> minutos
      <small>Mientras espera, si el cliente escribe, responde Nora.</small>
    </label>
  );
  if (tipo === 'etiquetar') return <input placeholder="Nombre de la etiqueta (ej. lead caliente)" value={paso.etiqueta} onChange={(e) => cambiar({ etiqueta: e.target.value })} />;
  if (tipo === 'etapa') return (
    <select value={paso.etapa} onChange={(e) => cambiar({ etapa: e.target.value })}>{ETAPAS.map(([v, n]) => <option key={v} value={v}>{n}</option>)}</select>
  );
  if (tipo === 'humano') return <input placeholder="Motivo para el equipo (opcional)" value={paso.motivo ?? ''} onChange={(e) => cambiar({ motivo: e.target.value })} />;
  return <p className="fl-nota">Desde aquí responde Nora con su conocimiento del negocio.</p>;
}

function ListaPasos({ pasos, onChange, campos, soloLectura }) {
  const cambiar = (i, parche) => onChange(pasos.map((p, k) => (k === i ? { ...p, ...parche } : p)));
  const quitar = (i) => onChange(pasos.filter((_, k) => k !== i));
  const mover = (i, d) => {
    const j = i + d;
    if (j < 0 || j >= pasos.length) return;
    const copia = pasos.slice();
    [copia[i], copia[j]] = [copia[j], copia[i]];
    onChange(copia);
  };
  const terminal = pasos.findIndex((p) => p.tipo === 'humano' || p.tipo === 'nora');
  return (
    <div className="fl-lista">
      {pasos.map((p, i) => (
        <div className={`fl-paso fl-${p.tipo}`} key={p.id}>
          <div className="fl-paso-cab">
            <span className="fl-ico" aria-hidden>{TIPOS[p.tipo].icono}</span>
            <b>{TIPOS[p.tipo].nombre}</b>
            {!soloLectura && (
              <span className="fl-acciones">
                <button type="button" onClick={() => mover(i, -1)} disabled={i === 0} aria-label="Subir paso">↑</button>
                <button type="button" onClick={() => mover(i, 1)} disabled={i === pasos.length - 1} aria-label="Bajar paso">↓</button>
                <button type="button" onClick={() => quitar(i)} aria-label="Eliminar paso">✕</button>
              </span>
            )}
          </div>
          <fieldset disabled={soloLectura} className="fl-cuerpo">
            <CamposPaso paso={p} cambiar={(parche) => cambiar(i, parche)} campos={campos} />
          </fieldset>
          {p.tipo === 'condicion' && (
            <div className="fl-ramas">
              <div className="fl-rama fl-rama-si"><h4>✅ Si se cumple</h4>
                <ListaPasos pasos={p.si || []} onChange={(v) => cambiar(i, { si: v })} campos={campos} soloLectura={soloLectura} /></div>
              <div className="fl-rama fl-rama-no"><h4>↪️ Si no se cumple</h4>
                <ListaPasos pasos={p.si_no || []} onChange={(v) => cambiar(i, { si_no: v })} campos={campos} soloLectura={soloLectura} /></div>
            </div>
          )}
          {terminal === i && i < pasos.length - 1 && <p className="fl-aviso">Este paso termina el flujo: los pasos de abajo nunca se ejecutarán.</p>}
        </div>
      ))}
      {!soloLectura && <MenuAgregar onAgregar={(t) => onChange([...pasos, nuevoPaso(t)])} />}
    </div>
  );
}

function Simulador({ flujo }) {
  const [chat, setChat] = useState([]);
  const [estado, setEstado] = useState(null);
  const [texto, setTexto] = useState('');
  const fin = useRef(null);
  const prog = useMemo(() => compilar(flujo.definicion.pasos), [flujo.definicion]);

  const aplicarAcciones = (acciones) => acciones.map((a) => {
    if (a.tipo === 'enviar') return { de: 'nora', texto: a.texto };
    if (a.tipo === 'etiquetar') return { de: 'sis', texto: `🏷️ Etiqueta: ${a.etiqueta}` };
    if (a.tipo === 'etapa') return { de: 'sis', texto: `📍 Etapa: ${a.etapa}` };
    if (a.tipo === 'humano') return { de: 'sis', texto: `🙋 Pasa a una persona (${a.motivo})` };
    return null;
  }).filter(Boolean);

  const empezar = () => {
    const r = avanzar(prog, estadoInicial({ nombre: 'Cliente de prueba' }), null);
    setEstado(r.estado); setChat(aplicarAcciones(r.acciones));
  };
  const enviar = (e) => {
    e.preventDefault();
    if (!texto.trim() || !estado || estado.fin) return;
    const r = avanzar(prog, estado, texto);
    setChat((c) => [...c, { de: 'cli', texto }, ...aplicarAcciones(r.acciones)]);
    setEstado(r.estado); setTexto('');
  };
  useEffect(() => { fin.current?.scrollIntoView?.({ block: 'end' }); }, [chat]);

  const errores = revisar(flujo.definicion);
  const finTxt = { completado: 'El flujo terminó.', humano: 'El flujo pasó la conversación a una persona.', nora: 'Desde aquí responde Nora (IA).' };
  return (
    <aside className="fl-sim" aria-label="Simulador">
      <h3>Probar el flujo</h3>
      {errores.length > 0 ? <p className="fl-nota">Arregla primero: {errores[0]}</p> : (
        <>
          <div className="fl-chat" role="log">
            {chat.length === 0 && <p className="fl-nota">Pulsa «Empezar» para simular que entra un cliente.</p>}
            {chat.map((m, i) => <div key={i} className={`fl-burbuja fl-${m.de}`}>{m.texto}</div>)}
            {estado?.fin && <p className="fl-nota">{finTxt[estado.fin]}</p>}
            <div ref={fin} />
          </div>
          {Object.keys(estado?.datos || {}).length > 0 && <pre className="fl-datos">{JSON.stringify(estado.datos, null, 1)}</pre>}
          <form onSubmit={enviar} className="fl-sim-form">
            <input value={texto} onChange={(e) => setTexto(e.target.value)} placeholder="Responde como el cliente…" disabled={!estado || !!estado.fin} aria-label="Mensaje del cliente" />
            <button type="submit" disabled={!estado || !!estado.fin}>Enviar</button>
          </form>
          <button type="button" className="fl-sec" onClick={empezar}>{estado ? '↺ Reiniciar' : '▶ Empezar'}</button>
        </>
      )}
    </aside>
  );
}

export default function Flujos({ org, supabase }) {
  const puedeEditar = org?.role === 'dueno' || org?.role === 'admin';
  const [lista, setLista] = useState(null);
  const [flujo, setFlujo] = useState(null);       // borrador en edición
  const [sucio, setSucio] = useState(false);
  const [msg, setMsg] = useState(null);
  const [guardando, setGuardando] = useState(false);

  const cargar = useCallback(async () => {
    const { data, error } = await supabase.from('flujos').select('*').eq('organization_id', org.id).order('created_at');
    if (error) { setMsg({ tipo: 'error', texto: error.message }); setLista([]); return; }
    setLista(data || []);
  }, [org.id, supabase]);
  useEffect(() => { setFlujo(null); setSucio(false); cargar(); }, [cargar]);

  const editar = (f) => { setFlujo(JSON.parse(JSON.stringify(f))); setSucio(false); setMsg(null); };
  const confirmarSalida = () => !sucio || window.confirm('Tienes cambios sin guardar. ¿Descartarlos?');
  const cambiar = (parche) => { setFlujo((f) => ({ ...f, ...parche })); setSucio(true); };
  const errores = flujo ? revisar(flujo.definicion) : [];
  const campos = useMemo(() => (flujo ? camposDe(flujo.definicion.pasos) : []), [flujo]);

  async function guardar(activo = flujo.activo) {
    if (activo && errores.length) { setMsg({ tipo: 'error', texto: `Para activarlo: ${errores[0]}` }); return; }
    if (!flujo.nombre.trim()) { setMsg({ tipo: 'error', texto: 'Ponle un nombre al flujo' }); return; }
    if (flujo.disparador.tipo === 'palabra_clave' && !(flujo.disparador.palabras || []).length) { setMsg({ tipo: 'error', texto: 'Escribe al menos una palabra clave' }); return; }
    setGuardando(true); setMsg(null);
    const fila = { organization_id: org.id, nombre: flujo.nombre.trim(), activo, disparador: flujo.disparador, definicion: flujo.definicion };
    const { data, error } = flujo.id
      ? await supabase.from('flujos').update(fila).eq('id', flujo.id).select().single()
      : await supabase.from('flujos').insert(fila).select().single();
    setGuardando(false);
    if (error) { setMsg({ tipo: 'error', texto: error.message }); return; }
    setFlujo(data); setSucio(false); setMsg({ tipo: 'ok', texto: activo ? 'Guardado y activo' : 'Guardado' });
    cargar();
  }
  async function borrar() {
    if (!flujo.id) { setFlujo(null); return; }
    if (!window.confirm(`¿Eliminar el flujo «${flujo.nombre}»? Las conversaciones que lo estén usando seguirán hasta terminar.`)) return;
    const { error } = await supabase.from('flujos').delete().eq('id', flujo.id);
    if (error) { setMsg({ tipo: 'error', texto: error.message }); return; }
    setFlujo(null); setSucio(false); cargar();
  }

  if (lista === null) return <div className="fl fl-centro">Cargando…</div>;

  return (
    <div className="fl">
      <nav className="fl-lateral" aria-label="Flujos">
        <h2>Flujos</h2>
        {puedeEditar && <button type="button" className="fl-primario" onClick={() => { if (confirmarSalida()) editar(flujoVacio()); }}>＋ Nuevo flujo</button>}
        {lista.length === 0 && <p className="fl-nota">Aún no tienes flujos. Un flujo dice qué hace Nora desde que entra un cliente.</p>}
        <ul>
          {lista.map((f) => (
            <li key={f.id}>
              <button type="button" className={flujo?.id === f.id ? 'fl-sel' : ''} onClick={() => { if (confirmarSalida()) editar(f); }}>
                <span className={`fl-punto ${f.activo ? 'on' : ''}`} title={f.activo ? 'Activo' : 'Apagado'} />
                {f.nombre}
              </button>
            </li>
          ))}
        </ul>
      </nav>

      {!flujo ? (
        <section className="fl-vacio"><p>Elige un flujo o crea uno nuevo.</p></section>
      ) : (
        <>
          <section className="fl-editor">
            {!puedeEditar && <p className="fl-aviso">Solo el dueño y los administradores pueden editar flujos.</p>}
            <div className="fl-cab">
              <input className="fl-nombre" value={flujo.nombre} onChange={(e) => cambiar({ nombre: e.target.value })} disabled={!puedeEditar} aria-label="Nombre del flujo" />
              {puedeEditar && (
                <div className="fl-botones">
                  <button type="button" className="fl-sec" onClick={borrar}>Eliminar</button>
                  <button type="button" className="fl-sec" disabled={guardando || (!sucio && !!flujo.id)} onClick={() => guardar()}>{guardando ? 'Guardando…' : 'Guardar'}</button>
                  <button type="button" className="fl-primario" disabled={guardando} onClick={() => guardar(!flujo.activo)}>{flujo.activo ? 'Apagar' : 'Guardar y activar'}</button>
                </div>
              )}
            </div>
            {msg && <p className={`fl-msg fl-${msg.tipo}`} role="status">{msg.texto}</p>}

            <div className="fl-disparador">
              <h3>⚡ Cuándo empieza</h3>
              <fieldset disabled={!puedeEditar}>
                <select value={flujo.disparador.tipo} onChange={(e) => cambiar({ disparador: e.target.value === 'palabra_clave' ? { tipo: 'palabra_clave', palabras: [] } : { tipo: 'conversacion_nueva' } })}>
                  <option value="conversacion_nueva">Cuando entra un cliente nuevo (su primer mensaje)</option>
                  <option value="palabra_clave">Cuando el cliente escribe una palabra clave</option>
                </select>
                {flujo.disparador.tipo === 'palabra_clave' && (
                  <label>Palabras clave (separadas por coma)
                    <input value={(flujo.disparador.palabras || []).join(', ')} placeholder="precio, información, cotización"
                      onChange={(e) => cambiar({ disparador: { tipo: 'palabra_clave', palabras: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) } })} />
                  </label>
                )}
              </fieldset>
              <small>Si hay varios flujos activos, se usa el primero que coincida. Si el cliente ya está en un flujo, no empieza otro.</small>
            </div>

            <h3>Pasos</h3>
            <ListaPasos pasos={flujo.definicion.pasos} campos={campos} soloLectura={!puedeEditar}
              onChange={(pasos) => cambiar({ definicion: { ...flujo.definicion, pasos } })} />
            {flujo.definicion.pasos.length > 0 && errores.length > 0 && (
              <ul className="fl-errores" aria-label="Pendiente por arreglar">{errores.slice(0, 5).map((e) => <li key={e}>{e}</li>)}</ul>
            )}
          </section>
          <Simulador flujo={flujo} />
        </>
      )}
    </div>
  );
}
