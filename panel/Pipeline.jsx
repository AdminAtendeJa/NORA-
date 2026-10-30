import { useCallback, useEffect, useMemo, useState } from 'react';
import './pipeline.css';

const COLORES = ['#3b82f6', '#8b5cf6', '#f59e0b', '#10b981', '#ef4444', '#ec4899', '#14b8a6', '#64748b'];
const TIPOS = [['normal', 'Normal'], ['ganado', 'Ganado ✓'], ['perdido', 'Perdido ✗']];

const clave = (nombre) =>
  (nombre.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 20) || 'etapa')
  + '_' + Math.random().toString(36).slice(2, 6);

const dinero = (n) => Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 0 });
const dias = (iso) => Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 86400000));

export default function Pipeline({ org, supabase }) {
  const puedeEstructura = org.role === 'dueno' || org.role === 'admin';
  const puedeMover = puedeEstructura || org.role === 'agente';
  const [pipelines, setPipelines] = useState(null);
  const [etapas, setEtapas] = useState([]);
  const [contactos, setContactos] = useState([]);
  const [sel, setSel] = useState(null);
  const [error, setError] = useState('');
  const [editando, setEditando] = useState(null); // id de etapa
  const [ajustes, setAjustes] = useState(false); // panel del pipeline
  const [arrastrando, setArrastrando] = useState(null);
  const [sobre, setSobre] = useState(null);

  const cargar = useCallback(async () => {
    const [p, e, c] = await Promise.all([
      supabase.from('pipelines').select('id, nombre, orden').eq('organization_id', org.id).order('orden').order('created_at'),
      supabase.from('pipeline_etapas').select('id, pipeline_id, clave, nombre, color, orden, tipo').eq('organization_id', org.id).order('orden').order('created_at'),
      supabase.from('contacts').select('id, name, phone, etapa, pipeline_id, valor, etapa_desde, tags').eq('organization_id', org.id).order('etapa_desde', { ascending: false }).limit(1000),
    ]);
    const fallo = p.error || e.error || c.error;
    if (fallo) { setError(fallo.message); setPipelines((x) => x || []); return; }
    setError('');
    setPipelines(p.data); setEtapas(e.data); setContactos(c.data);
    setSel((s) => (p.data.some((x) => x.id === s) ? s : p.data[0]?.id ?? null));
  }, [org.id, supabase]);

  useEffect(() => {
    setPipelines(null); setSel(null); cargar();
    const t = setInterval(cargar, 20000);
    return () => clearInterval(t);
  }, [cargar]);

  const pipeline = (pipelines || []).find((p) => p.id === sel);
  const columnas = useMemo(() => etapas.filter((e) => e.pipeline_id === sel), [etapas, sel]);
  const delPipeline = useMemo(() => contactos.filter((c) => c.pipeline_id === sel), [contactos, sel]);

  const fallar = (r) => { if (r?.error) { setError(r.error.message); return true; } return false; };

  async function crearPipeline(nombre, conEjemplo) {
    const orden = (pipelines || []).length;
    const { data, error: e } = await supabase.from('pipelines').insert({ organization_id: org.id, nombre, orden }).select('id').single();
    if (e) { setError(e.message); return; }
    if (conEjemplo) {
      const filas = [['Nuevo', COLORES[0], 'normal'], ['En proceso', COLORES[2], 'normal'], ['Ganado', COLORES[3], 'ganado'], ['Perdido', COLORES[4], 'perdido']]
        .map(([n, color, tipo], i) => ({ organization_id: org.id, pipeline_id: data.id, clave: clave(n), nombre: n, color, tipo, orden: i }));
      fallar(await supabase.from('pipeline_etapas').insert(filas));
    }
    await cargar(); setSel(data.id);
  }

  async function renombrarPipeline(nombre) {
    if (!nombre.trim() || nombre === pipeline.nombre) return;
    if (!fallar(await supabase.from('pipelines').update({ nombre: nombre.trim() }).eq('id', sel))) cargar();
  }

  async function borrarPipeline(destino) {
    const r = delPipeline.length ? await supabase.rpc('eliminar_pipeline', { p_pipeline: sel, p_destino: destino })
      : await supabase.from('pipelines').delete().eq('id', sel);
    if (!fallar(r)) { setAjustes(false); setSel(null); cargar(); }
  }

  async function agregarEtapa() {
    const orden = columnas.reduce((m, c) => Math.max(m, c.orden), -1) + 1;
    const nombre = 'Nueva etapa';
    const { data, error: e } = await supabase.from('pipeline_etapas')
      .insert({ organization_id: org.id, pipeline_id: sel, clave: clave(nombre), nombre, color: COLORES[orden % COLORES.length], orden })
      .select('id').single();
    if (e) { setError(e.message); return; }
    await cargar(); setEditando(data.id);
  }

  async function guardarEtapa(id, cambios) {
    setEtapas((es) => es.map((x) => (x.id === id ? { ...x, ...cambios } : x)));
    fallar(await supabase.from('pipeline_etapas').update(cambios).eq('id', id));
  }

  async function moverEtapa(e, dir) {
    const i = columnas.findIndex((c) => c.id === e.id), otro = columnas[i + dir];
    if (!otro) return;
    // Reasigna posiciones 0..n para no depender de números repetidos
    const orden = columnas.map((c) => c.id);
    orden.splice(i, 1); orden.splice(i + dir, 0, e.id);
    setEtapas((es) => es.map((x) => (orden.includes(x.id) ? { ...x, orden: orden.indexOf(x.id) } : x)));
    const rs = await Promise.all(orden.map((id, n) => supabase.from('pipeline_etapas').update({ orden: n }).eq('id', id)));
    if (rs.some(fallar)) cargar();
  }

  async function borrarEtapa(e, destino) {
    const n = delPipeline.filter((c) => c.etapa === e.clave).length;
    const r = n ? await supabase.rpc('eliminar_etapa', { p_etapa: e.id, p_destino: destino })
      : await supabase.from('pipeline_etapas').delete().eq('id', e.id);
    if (!fallar(r)) { setEditando(null); cargar(); }
  }

  async function moverContacto(id, nueva) {
    const c = contactos.find((x) => x.id === id);
    if (!c || c.etapa === nueva) return;
    setContactos((cs) => cs.map((x) => (x.id === id ? { ...x, etapa: nueva, etapa_desde: new Date().toISOString() } : x)));
    if (fallar(await supabase.from('contacts').update({ etapa: nueva }).eq('id', id))) cargar();
  }

  async function guardarValor(id, texto) {
    const v = Math.max(0, Number(texto) || 0);
    setContactos((cs) => cs.map((x) => (x.id === id ? { ...x, valor: v } : x)));
    fallar(await supabase.from('contacts').update({ valor: v }).eq('id', id));
  }

  if (pipelines === null) return <div className="centro">Cargando…</div>;

  if (pipelines.length === 0) {
    return (
      <main className="pagina">
        <h2>Pipeline</h2>
        {error && <p className="error">{error}</p>}
        {puedeEstructura ? <NuevoPipeline primero onCrear={crearPipeline} /> : <p className="suave">El dueño del negocio todavía no creó ningún pipeline.</p>}
      </main>
    );
  }

  return (
    <div className="pp">
      <div className="pp-barra">
        <div className="pp-tabs" role="tablist" aria-label="Pipelines">
          {pipelines.map((p) => (
            <button key={p.id} role="tab" aria-selected={p.id === sel} className={p.id === sel ? 'activa' : ''} onClick={() => { setSel(p.id); setAjustes(false); setEditando(null); }}>{p.nombre}</button>
          ))}
          {puedeEstructura && <NuevoPipeline onCrear={crearPipeline} />}
        </div>
        <span className="espacio" />
        <span className="suave pequeno">{delPipeline.length} clientes · {dinero(delPipeline.reduce((s, c) => s + Number(c.valor || 0), 0))} en total</span>
        {puedeEstructura && <button onClick={() => setAjustes((a) => !a)} aria-expanded={ajustes}>⚙ Pipeline</button>}
        {puedeEstructura && <button className="primario" onClick={agregarEtapa}>＋ Etapa</button>}
      </div>
      {error && <p className="error pp-error">{error} <button className="enlace" onClick={() => setError('')}>Cerrar</button></p>}

      {ajustes && pipeline && (
        <AjustesPipeline key={pipeline.id} pipeline={pipeline} otros={pipelines.filter((p) => p.id !== sel)} nClientes={delPipeline.length}
          onRenombrar={renombrarPipeline} onBorrar={borrarPipeline} />
      )}

      <div className="pp-tablero">
        {columnas.length === 0 && <p className="suave pp-pad">Este pipeline no tiene etapas. {puedeEstructura ? 'Pulsa «＋ Etapa» para crear la primera.' : ''}</p>}
        {columnas.map((col, i) => {
          const cards = delPipeline.filter((c) => c.etapa === col.clave);
          return (
            <section key={col.id} className={`pp-col ${sobre === col.id ? 'sobre' : ''}`} aria-label={`Etapa ${col.nombre}`}
              onDragOver={(ev) => { if (arrastrando) { ev.preventDefault(); setSobre(col.id); } }}
              onDragLeave={() => setSobre((s) => (s === col.id ? null : s))}
              onDrop={(ev) => { ev.preventDefault(); setSobre(null); if (arrastrando) moverContacto(arrastrando, col.clave); setArrastrando(null); }}>
              <header className="pp-col-cab" style={{ borderTopColor: col.color }}>
                {editando === col.id ? (
                  <EditorEtapa key={col.id} etapa={col} i={i} total={columnas.length} nClientes={cards.length}
                    otras={columnas.filter((c) => c.id !== col.id)}
                    onGuardar={(c) => guardarEtapa(col.id, c)} onMover={(d) => moverEtapa(col, d)} onBorrar={(dest) => borrarEtapa(col, dest)} onCerrar={() => setEditando(null)} />
                ) : (
                  <>
                    <div className="pp-col-titulo">
                      <b>{col.nombre}</b>
                      {(col.tipo === 'ganado' || col.tipo === 'perdido') && <span className={`pp-tipo ${col.tipo}`}>{col.tipo === 'ganado' ? 'Ganado' : 'Perdido'}</span>}
                      {puedeEstructura && <button className="enlace" aria-label={`Editar etapa ${col.nombre}`} onClick={() => setEditando(col.id)}>✎</button>}
                    </div>
                    <small className="suave">{cards.length} · {dinero(cards.reduce((s, c) => s + Number(c.valor || 0), 0))}</small>
                  </>
                )}
              </header>
              <div className="pp-cards">
                {cards.length === 0 && <p className="pp-vacia">Sin clientes</p>}
                {cards.map((c) => (
                  <article key={c.id} className={`pp-card ${arrastrando === c.id ? 'arrastrando' : ''}`} draggable={puedeMover}
                    onDragStart={(ev) => { setArrastrando(c.id); ev.dataTransfer.effectAllowed = 'move'; ev.dataTransfer.setData('text/plain', c.id); }}
                    onDragEnd={() => { setArrastrando(null); setSobre(null); }}>
                    <b>{c.name || c.phone}</b>
                    {c.name && <small className="suave">{c.phone}</small>}
                    <div className="pp-card-pie">
                      <label className="pp-valor">
                        <span className="suave">Valor</span>
                        <input type="number" min="0" inputMode="decimal" defaultValue={c.valor || ''} placeholder="0" disabled={!puedeMover}
                          aria-label={`Valor de ${c.name || c.phone}`}
                          onBlur={(ev) => { if (Number(ev.target.value || 0) !== Number(c.valor || 0)) guardarValor(c.id, ev.target.value); }} />
                      </label>
                      <small className="suave" title="Tiempo en esta etapa">{dias(c.etapa_desde)} d</small>
                    </div>
                    {(c.tags || []).length > 0 && <div className="pp-tags">{c.tags.map((t) => <span key={t} className="pn-chip">{t}</span>)}</div>}
                    {puedeMover && (
                      <select className="pp-mover" aria-label={`Mover a ${c.name || c.phone}`} value={c.etapa} onChange={(ev) => moverContacto(c.id, ev.target.value)}>
                        {columnas.map((x) => <option key={x.id} value={x.clave}>{x.nombre}</option>)}
                      </select>
                    )}
                  </article>
                ))}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}

function NuevoPipeline({ onCrear, primero }) {
  const [abierto, setAbierto] = useState(!!primero);
  const [nombre, setNombre] = useState('');
  const [ejemplo, setEjemplo] = useState(true);
  if (!abierto) return <button className="pp-nuevo" onClick={() => setAbierto(true)}>＋ Nuevo pipeline</button>;
  return (
    <form className="pp-form" onSubmit={(e) => { e.preventDefault(); if (nombre.trim()) { onCrear(nombre.trim(), ejemplo); setNombre(''); if (!primero) setAbierto(false); } }}>
      {primero && <p className="suave">Un pipeline es el camino que recorre un cliente (por ejemplo «Ventas» o «Soporte»). Tú decides sus etapas.</p>}
      <input autoFocus value={nombre} maxLength={40} onChange={(e) => setNombre(e.target.value)} placeholder="Nombre del pipeline" aria-label="Nombre del pipeline" />
      <label className="pp-check"><input type="checkbox" checked={ejemplo} onChange={(e) => setEjemplo(e.target.checked)} /> Empezar con etapas de ejemplo</label>
      <button className="primario" disabled={!nombre.trim()}>Crear pipeline</button>
      {!primero && <button type="button" onClick={() => setAbierto(false)}>Cancelar</button>}
    </form>
  );
}

function AjustesPipeline({ pipeline, otros, nClientes, onRenombrar, onBorrar }) {
  const [nombre, setNombre] = useState(pipeline.nombre);
  const [destino, setDestino] = useState(otros[0]?.id || '');
  const [confirmar, setConfirmar] = useState(false);
  const bloqueado = nClientes > 0 && otros.length === 0;
  return (
    <div className="pp-ajustes">
      <label>Nombre <input value={nombre} maxLength={40} onChange={(e) => setNombre(e.target.value)} onBlur={() => onRenombrar(nombre)} /></label>
      {!confirmar ? <button className="peligro" onClick={() => setConfirmar(true)}>Eliminar pipeline</button> : (
        <span className="pp-confirma">
          {bloqueado && <span className="error">Crea otro pipeline antes: este tiene {nClientes} clientes.</span>}
          {!bloqueado && nClientes > 0 && (
            <label>Pasar sus {nClientes} clientes a <select value={destino} onChange={(e) => setDestino(e.target.value)}>
              {otros.map((p) => <option key={p.id} value={p.id}>{p.nombre}</option>)}</select></label>
          )}
          <button className="peligro" disabled={bloqueado} onClick={() => onBorrar(destino)}>Sí, eliminar</button>
          <button onClick={() => setConfirmar(false)}>Cancelar</button>
        </span>
      )}
    </div>
  );
}

function EditorEtapa({ etapa, i, total, nClientes, otras, onGuardar, onMover, onBorrar, onCerrar }) {
  const [nombre, setNombre] = useState(etapa.nombre);
  const [destino, setDestino] = useState(otras[0]?.clave || '');
  const [confirmar, setConfirmar] = useState(false);
  const cerrar = () => { if (nombre.trim() && nombre.trim() !== etapa.nombre) onGuardar({ nombre: nombre.trim() }); onCerrar(); };
  const bloqueado = nClientes > 0 && otras.length === 0;
  return (
    <div className="pp-edit">
      <input autoFocus value={nombre} maxLength={40} aria-label="Nombre de la etapa" onChange={(e) => setNombre(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') cerrar(); }} />
      <div className="pp-colores" role="radiogroup" aria-label="Color de la etapa">
        {COLORES.map((c) => (
          <button key={c} role="radio" aria-checked={etapa.color === c} aria-label={`Color ${c}`} className={etapa.color === c ? 'sel' : ''} style={{ background: c }} onClick={() => onGuardar({ color: c })} />
        ))}
      </div>
      <select value={etapa.tipo} aria-label="Tipo de etapa" onChange={(e) => onGuardar({ tipo: e.target.value })}>
        {TIPOS.map(([v, t]) => <option key={v} value={v}>{t}</option>)}
      </select>
      <div className="pp-edit-fila">
        <button disabled={i === 0} aria-label="Mover etapa a la izquierda" onClick={() => onMover(-1)}>◀</button>
        <button disabled={i === total - 1} aria-label="Mover etapa a la derecha" onClick={() => onMover(1)}>▶</button>
        <span className="espacio" />
        <button className="primario" onClick={cerrar}>Listo</button>
      </div>
      {!confirmar ? <button className="peligro" onClick={() => setConfirmar(true)}>Eliminar etapa</button> : (
        <div className="pp-confirma">
          {bloqueado && <span className="error">Es la única etapa y tiene clientes.</span>}
          {!bloqueado && nClientes > 0 && (
            <label>Pasar sus {nClientes} clientes a <select value={destino} onChange={(e) => setDestino(e.target.value)}>
              {otras.map((c) => <option key={c.id} value={c.clave}>{c.nombre}</option>)}</select></label>
          )}
          <button className="peligro" disabled={bloqueado} onClick={() => onBorrar(destino)}>Sí, eliminar</button>
          <button onClick={() => setConfirmar(false)}>Cancelar</button>
        </div>
      )}
    </div>
  );
}
