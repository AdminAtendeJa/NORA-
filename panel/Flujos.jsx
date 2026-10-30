import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { ReactFlow, ReactFlowProvider, Background, Controls, MiniMap, Handle, Position, MarkerType, useNodesState, useEdgesState, useReactFlow } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { avanzar, estadoInicial, revisar, definicionVacia, nodoEspera, MAX_BOTONES } from './motor.ts';
import './flujos.css';

// Constructor de flujos con lienzo de nodos (como el Salesbot de Kommo): cada paso es una caja que se arrastra,
// cada botón de respuesta tiene su propia salida, y las líneas unen un puerto con el paso siguiente.
// Uso: <Flujos org={org} supabase={supabase} />   (org trae { id, role })

const TIPOS = {
  mensaje: { nombre: 'Mensaje', icono: '💬', ayuda: 'Envía un texto, con botones de respuesta' },
  pregunta: { nombre: 'Pregunta', icono: '❓', ayuda: 'Pide un dato y lo guarda' },
  condicion: { nombre: 'Condición', icono: '🔀', ayuda: 'Elige un camino según un dato' },
  esperar: { nombre: 'Pausa', icono: '⏱️', ayuda: 'Espera un tiempo y sigue' },
  etiquetar: { nombre: 'Etiqueta', icono: '🏷️', ayuda: 'Marca al cliente' },
  etapa: { nombre: 'Etapa', icono: '📍', ayuda: 'Mueve al cliente en el embudo' },
  humano: { nombre: 'Pasar a una persona', icono: '🙋', ayuda: 'Detiene el bot y avisa al equipo' },
  nora: { nombre: 'Nora responde', icono: '🤖', ayuda: 'Detiene el bot; sigue la IA' },
  fin: { nombre: 'Detener bot', icono: '⛔', ayuda: 'Termina el flujo' },
};
const ETAPAS = [['nuevo', 'Nuevo'], ['interesado', 'Interesado'], ['cliente', 'Cliente'], ['perdido', 'Perdido']];
const VALIDACIONES = [['texto', 'Texto libre'], ['numero', 'Número'], ['si_no', 'Sí / No'], ['opciones', 'Opciones']];
const OPERADORES = [['igual', 'es igual a'], ['distinto', 'es distinto de'], ['contiene', 'contiene'], ['mayor', 'es mayor que'], ['menor', 'es menor que'], ['existe', 'tiene respuesta']];

const uid = () => (crypto.randomUUID ? crypto.randomUUID().slice(0, 8) : String(Math.random()).slice(2, 10));
const slug = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 30);

const datosNuevos = (tipo) => ({
  mensaje: { texto: '', botones: [], espera: false, timeoutMin: 60 },
  pregunta: { texto: '', campo: '', validacion: 'texto', opciones: [], timeoutMin: 60 },
  condicion: { campo: '', op: 'igual', valor: '' },
  esperar: { minutos: 5 }, etiquetar: { etiqueta: '' }, etapa: { etapa: 'interesado' }, humano: { motivo: '' }, nora: {}, fin: {},
}[tipo]);

// Salidas válidas de un paso según su configuración: sirve para soltar las conexiones que dejan de existir.
function puertosValidos(tipo, d) {
  switch (tipo) {
    case 'inicio': case 'esperar': case 'etiquetar': case 'etapa': return ['next'];
    case 'mensaje': {
      const bs = d.botones || [];
      return bs.length > 0 || d.espera ? [...bs.map((_, i) => `btn:${i}`), 'otra', 'timeout'] : ['next'];
    }
    case 'pregunta': return ['next', 'otra', 'timeout'];
    case 'condicion': return ['si', 'no'];
    default: return [];
  }
}

// ---- Conversión entre el lienzo (nodos/aristas de React Flow) y la definición que se guarda ----
const ESTILO_ARISTA = { type: 'default', markerEnd: { type: MarkerType.ArrowClosed, width: 12, height: 12 } };
function aLienzo(def, disparador) {
  const nodes = def.nodos.map((n) => {
    const { id, tipo, x, y, ...datos } = n;
    return { id, type: tipo, position: { x, y }, data: tipo === 'inicio' ? { disparador } : datos, deletable: tipo !== 'inicio' };
  });
  const edges = def.aristas.map((a) => ({ id: a.id, source: a.de, sourceHandle: a.puerto, target: a.a, targetHandle: 'in', ...ESTILO_ARISTA }));
  return { nodes, edges };
}
function aDefinicion(nodes, edges) {
  return {
    version: 2,
    nodos: nodes.map((n) => {
      const base = { id: n.id, tipo: n.type, x: Math.round(n.position.x), y: Math.round(n.position.y) };
      if (n.type === 'inicio') return base;
      return { ...base, ...n.data };
    }),
    aristas: edges.filter((e) => e.sourceHandle).map((e) => ({ id: e.id, de: e.source, puerto: e.sourceHandle, a: e.target })),
  };
}
const resumenDisparador = (d) => (d?.tipo === 'palabra_clave' ? `Palabra clave: ${(d.palabras || []).join(', ') || '—'}` : 'Cliente nuevo (su primer mensaje)');

// ---- Contexto del editor: los nodos lo usan para editarse sin recibir funciones por props ----
const Ctx = createContext(null);

function Puerto({ id, etiqueta, extra, tono }) {
  return (
    <div className={`fl-puerto ${tono || ''}`}>
      <span>{etiqueta}</span>{extra}
      <Handle type="source" position={Position.Right} id={id} className="fl-handle" />
    </div>
  );
}

function Caja({ id, tipo, selected, entrada = true, children }) {
  const { eliminar, numero } = useContext(Ctx);
  const meta = TIPOS[tipo] || { nombre: 'Inicio del bot', icono: '▶️' };
  return (
    <div className={`fl-nodo fl-t-${tipo} ${selected ? 'sel' : ''}`}>
      {entrada && <Handle type="target" position={Position.Left} id="in" className="fl-handle fl-handle-in" />}
      <div className="fl-nodo-cab">
        <span aria-hidden>{meta.icono}</span><b>{meta.nombre}</b>
        {tipo !== 'inicio' && <span className="fl-n">#{numero(id)}</span>}
        {tipo !== 'inicio' && <button type="button" className="nodrag fl-x" onClick={() => eliminar(id)} aria-label={`Eliminar ${meta.nombre}`}>✕</button>}
      </div>
      <div className="fl-nodo-cuerpo">{children}</div>
    </div>
  );
}

function NodoInicio({ id, data, selected }) {
  const { actualizar, soloLectura } = useContext(Ctx);
  const d = data.disparador || { tipo: 'conversacion_nueva' };
  return (
    <Caja id={id} tipo="inicio" selected={selected} entrada={false}>
      <label>Se lanza cuando
        <select className="nodrag" disabled={soloLectura} value={d.tipo}
          onChange={(e) => actualizar(id, { disparador: e.target.value === 'palabra_clave' ? { tipo: 'palabra_clave', palabras: [] } : { tipo: 'conversacion_nueva' } })}>
          <option value="conversacion_nueva">entra un cliente nuevo</option>
          <option value="palabra_clave">el cliente escribe una palabra clave</option>
        </select>
      </label>
      {d.tipo === 'palabra_clave' && (
        <label>Palabras clave (coma)
          <input className="nodrag" disabled={soloLectura} placeholder="precio, información" value={(d.palabras || []).join(', ')}
            onChange={(e) => actualizar(id, { disparador: { tipo: 'palabra_clave', palabras: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) } })} />
        </label>
      )}
      <Puerto id="next" etiqueta="▶ Inicio" />
    </Caja>
  );
}

function Tiempo({ id, data }) {
  const { actualizar, soloLectura } = useContext(Ctx);
  return (
    <Puerto id="timeout" etiqueta="Sin respuesta tras" tono="aviso"
      extra={<><input type="number" min="1" className="nodrag fl-min" disabled={soloLectura} value={data.timeoutMin ?? 60} onChange={(e) => actualizar(id, { timeoutMin: Number(e.target.value) })} /><span>min</span></>} />
  );
}

// Un botón de respuesta es una píldora dentro de la burbuja; sus sinónimos se despliegan solo si hace falta.
function BotonRespuesta({ i, b, cambiar, quitar, soloLectura }) {
  const [abierto, setAbierto] = useState(false);
  const mostrar = abierto || (b.sinonimos || []).length > 0;
  return (
    <div className="fl-pastilla">
      <div className="fl-pastilla-fila">
        <input className="nodrag" disabled={soloLectura} value={b.titulo} placeholder={`Botón ${i + 1}`} onChange={(e) => cambiar({ titulo: e.target.value })} aria-label={`Texto del botón ${i + 1}`} />
        {!soloLectura && !mostrar && <button type="button" className="nodrag fl-mini" onClick={() => setAbierto(true)} aria-label={`Añadir sinónimos al botón ${i + 1}`} title="Añadir sinónimos: palabras que cuentan como este botón si el cliente escribe">＋</button>}
        {!soloLectura && <button type="button" className="nodrag fl-mini" onClick={quitar} aria-label={`Quitar botón ${i + 1}`}>✕</button>}
      </div>
      {mostrar && (
        <input className="nodrag fl-sin" disabled={soloLectura} value={(b.sinonimos || []).join(', ')} placeholder="sinónimos, separados por coma"
          onChange={(e) => cambiar({ sinonimos: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) })} aria-label={`Sinónimos del botón ${i + 1}`} />
      )}
      <Handle type="source" position={Position.Right} id={`btn:${i}`} className="fl-handle" />
    </div>
  );
}

function NodoMensaje({ id, data, selected }) {
  const { actualizar, quitarBoton, soloLectura } = useContext(Ctx);
  const botones = data.botones || [];
  const espera = botones.length > 0 || data.espera;
  const cambiarBoton = (i, parche) => actualizar(id, { botones: botones.map((b, k) => (k === i ? { ...b, ...parche } : b)) });
  return (
    <Caja id={id} tipo="mensaje" selected={selected}>
      <div className="fl-bub">
        <textarea className="nodrag nowheel" rows={2} disabled={soloLectura} value={data.texto} placeholder="Escribe el mensaje. {{nombre}} inserta datos del cliente."
          onChange={(e) => actualizar(id, { texto: e.target.value })} />
        {botones.map((b, i) => (
          <BotonRespuesta key={i} i={i} b={b} cambiar={(parche) => cambiarBoton(i, parche)} quitar={() => quitarBoton(id, i)} soloLectura={soloLectura} />
        ))}
        {!soloLectura && botones.length < MAX_BOTONES && (
          <button type="button" className="nodrag fl-mas" onClick={() => actualizar(id, { botones: [...botones, { titulo: '', sinonimos: [] }] })}>＋ Botón de respuesta</button>
        )}
      </div>
      {botones.length === 0 && (
        <label className="fl-check"><input className="nodrag" type="checkbox" disabled={soloLectura} checked={!!data.espera} onChange={(e) => actualizar(id, { espera: e.target.checked })} /> Esperar la respuesta del cliente</label>
      )}
      {espera ? (<><Puerto id="otra" etiqueta={botones.length ? 'Otra respuesta' : 'Cuando responda'} /><Tiempo id={id} data={data} /></>) : <Puerto id="next" etiqueta="Siguiente" />}
    </Caja>
  );
}

function NodoPregunta({ id, data, selected }) {
  const { actualizar, soloLectura } = useContext(Ctx);
  return (
    <Caja id={id} tipo="pregunta" selected={selected}>
      <textarea className="nodrag nowheel" rows={2} disabled={soloLectura} value={data.texto} placeholder="¿Qué quieres preguntar?" onChange={(e) => actualizar(id, { texto: e.target.value })} />
      <label>Guardar la respuesta como
        <input className="nodrag" disabled={soloLectura} value={data.campo} placeholder="ej. presupuesto" onChange={(e) => actualizar(id, { campo: slug(e.target.value) })} />
      </label>
      <label>Tipo de respuesta
        <select className="nodrag" disabled={soloLectura} value={data.validacion} onChange={(e) => actualizar(id, { validacion: e.target.value })}>
          {VALIDACIONES.map(([v, n]) => <option key={v} value={v}>{n}</option>)}
        </select>
      </label>
      {data.validacion === 'opciones' && (
        <label>Opciones (una por línea)
          <textarea className="nodrag nowheel" rows={3} disabled={soloLectura} value={(data.opciones || []).join('\n')} onChange={(e) => actualizar(id, { opciones: e.target.value.split('\n') })} />
        </label>
      )}
      <Puerto id="next" etiqueta="Respuesta válida" tono="ok" />
      <Puerto id="otra" etiqueta="No válida (tras 3 intentos)" />
      <Tiempo id={id} data={data} />
    </Caja>
  );
}

function NodoCondicion({ id, data, selected }) {
  const { actualizar, campos, soloLectura } = useContext(Ctx);
  return (
    <Caja id={id} tipo="condicion" selected={selected}>
      <label>Si el dato
        <select className="nodrag" disabled={soloLectura} value={data.campo} onChange={(e) => actualizar(id, { campo: e.target.value })}>
          <option value="">— elige —</option>
          {[...new Set(['nombre', ...campos])].map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      </label>
      <select className="nodrag" disabled={soloLectura} value={data.op} onChange={(e) => actualizar(id, { op: e.target.value })} aria-label="Condición">
        {OPERADORES.map(([v, n]) => <option key={v} value={v}>{n}</option>)}
      </select>
      {data.op !== 'existe' && <input className="nodrag" disabled={soloLectura} placeholder="valor" value={data.valor ?? ''} onChange={(e) => actualizar(id, { valor: e.target.value })} aria-label="Valor" />}
      <Puerto id="si" etiqueta="✅ Sí" tono="ok" />
      <Puerto id="no" etiqueta="↪ No" />
    </Caja>
  );
}

function NodoSimple({ id, data, selected, tipo }) {
  const { actualizar, soloLectura } = useContext(Ctx);
  return (
    <Caja id={id} tipo={tipo} selected={selected}>
      {tipo === 'esperar' && (
        <label className="fl-inline">Esperar
          <input className="nodrag fl-min" type="number" min="1" disabled={soloLectura} value={data.minutos} onChange={(e) => actualizar(id, { minutos: Number(e.target.value) })} /> min
        </label>
      )}
      {tipo === 'etiquetar' && <input className="nodrag" disabled={soloLectura} placeholder="Etiqueta (ej. lead caliente)" value={data.etiqueta} onChange={(e) => actualizar(id, { etiqueta: e.target.value })} aria-label="Etiqueta" />}
      {tipo === 'etapa' && (
        <select className="nodrag" disabled={soloLectura} value={data.etapa} onChange={(e) => actualizar(id, { etapa: e.target.value })} aria-label="Etapa">
          {ETAPAS.map(([v, n]) => <option key={v} value={v}>{n}</option>)}
        </select>
      )}
      {tipo === 'humano' && <input className="nodrag" disabled={soloLectura} placeholder="Motivo para el equipo (opcional)" value={data.motivo ?? ''} onChange={(e) => actualizar(id, { motivo: e.target.value })} aria-label="Motivo" />}
      {tipo === 'nora' && <p className="fl-nota">Desde aquí responde Nora con el conocimiento del negocio.</p>}
      {tipo === 'fin' && <p className="fl-nota">El bot se detiene. Nora vuelve a atender normalmente.</p>}
      {['esperar', 'etiquetar', 'etapa'].includes(tipo) ? <Puerto id="next" etiqueta="Siguiente" /> : <p className="fl-pie">Fin del camino</p>}
    </Caja>
  );
}

const nodeTypes = {
  inicio: NodoInicio, mensaje: NodoMensaje, pregunta: NodoPregunta, condicion: NodoCondicion,
  esperar: (p) => <NodoSimple {...p} tipo="esperar" />, etiquetar: (p) => <NodoSimple {...p} tipo="etiquetar" />, etapa: (p) => <NodoSimple {...p} tipo="etapa" />,
  humano: (p) => <NodoSimple {...p} tipo="humano" />, nora: (p) => <NodoSimple {...p} tipo="nora" />, fin: (p) => <NodoSimple {...p} tipo="fin" />,
};

// ---- Previsualizar bot: ejecuta el mismo motor que el servidor, con botones pulsables y reloj simulado ----
function Previsualizar({ def, onCerrar }) {
  const [chat, setChat] = useState([]);
  const [estado, setEstado] = useState(null);
  const [texto, setTexto] = useState('');
  const [reloj, setReloj] = useState(() => new Date());
  const fin = useRef(null);
  const { errores } = useMemo(() => revisar(def), [def]);

  const aChat = (acciones) => acciones.map((a) => {
    if (a.tipo === 'enviar') return { de: 'nora', texto: a.texto, botones: a.botones };
    if (a.tipo === 'etiquetar') return { de: 'sis', texto: `🏷️ Etiqueta: ${a.etiqueta}` };
    if (a.tipo === 'etapa') return { de: 'sis', texto: `📍 Etapa: ${a.etapa}` };
    if (a.tipo === 'humano') return { de: 'sis', texto: `🙋 Pasa a una persona (${a.motivo})` };
    return null;
  }).filter(Boolean);

  const empezar = () => {
    const ahora = new Date(); setReloj(ahora);
    const r = avanzar(def, estadoInicial(def, { nombre: 'Cliente de prueba' }), null, ahora);
    setEstado(r.estado); setChat(aChat(r.acciones));
  };
  const responder = (t) => {
    if (!t.trim() || !estado || estado.fin) return;
    const r = avanzar(def, estado, t, reloj);
    setChat((c) => [...c.map((m) => ({ ...m, botones: undefined })), { de: 'cli', texto: t }, ...aChat(r.acciones)]);
    setEstado(r.estado); setTexto('');
  };
  // Adelanta el reloj hasta que venza la pausa o el tiempo de «sin respuesta»
  const saltarTiempo = () => {
    const e = estado?.esperando; if (!e) return;
    const meta = e.tipo === 'tiempo' ? e.hasta : e.vence;
    const ahora = new Date(meta ? new Date(meta).getTime() + 1000 : reloj.getTime() + 3600_000); setReloj(ahora);
    const r = avanzar(def, estado, null, ahora);
    setChat((c) => [...c.map((m) => ({ ...m, botones: undefined })), { de: 'sis', texto: '⏱ Pasó el tiempo' }, ...aChat(r.acciones)]);
    setEstado(r.estado);
  };
  useEffect(() => { fin.current?.scrollIntoView?.({ block: 'end' }); }, [chat]);

  const finTxt = { completado: 'El bot terminó.', humano: 'El bot pasó la conversación a una persona.', nora: 'Desde aquí responde Nora (IA).' };
  const ultimo = chat[chat.length - 1];
  const puedeSaltar = estado && !estado.fin && estado.esperando && (estado.esperando.tipo === 'tiempo' || estado.esperando.vence);
  return (
    <aside className="fl-prev" aria-label="Previsualizar bot">
      <div className="fl-prev-cab"><h3>Previsualizar bot</h3><button type="button" className="fl-x" onClick={onCerrar} aria-label="Cerrar previsualización">✕</button></div>
      {errores.length > 0 ? <p className="fl-nota">Arregla primero: {errores[0]}</p> : (
        <>
          <div className="fl-chat" role="log">
            {chat.length === 0 && <p className="fl-nota">Pulsa «Empezar» para simular que entra un cliente.</p>}
            {chat.map((m, i) => <div key={i} className={`fl-burbuja fl-${m.de}`}>{m.texto}</div>)}
            {ultimo?.botones?.length > 0 && !estado?.fin && (
              <div className="fl-chips">{ultimo.botones.map((b) => <button type="button" key={b} onClick={() => responder(b)}>{b}</button>)}</div>
            )}
            {estado?.fin && <p className="fl-nota">{finTxt[estado.fin]}</p>}
            <div ref={fin} />
          </div>
          {Object.keys(estado?.datos || {}).length > 0 && <pre className="fl-datos">{JSON.stringify(estado.datos, null, 1)}</pre>}
          <form onSubmit={(e) => { e.preventDefault(); responder(texto); }} className="fl-sim-form">
            <input value={texto} onChange={(e) => setTexto(e.target.value)} placeholder="Responde como el cliente…" disabled={!estado || !!estado.fin} aria-label="Mensaje del cliente" />
            <button type="submit" disabled={!estado || !!estado.fin}>Enviar</button>
          </form>
          <div className="fl-prev-pie">
            <button type="button" onClick={empezar}>{estado ? '↺ Reiniciar' : '▶ Empezar'}</button>
            {puedeSaltar && <button type="button" onClick={saltarTiempo}>⏱ Simular que pasa el tiempo</button>}
          </div>
        </>
      )}
    </aside>
  );
}

// ---- Editor a pantalla completa ----
function Editor({ flujo, org, supabase, puedeEditar, onCerrar }) {
  const inicial = useMemo(() => {
    const def = flujo.definicion?.version === 2 ? flujo.definicion : definicionVacia();
    return aLienzo(def, flujo.disparador || { tipo: 'conversacion_nueva' });
  }, [flujo]);
  const [nodes, setNodes, onNodesChange] = useNodesState(inicial.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(inicial.edges);
  const [nombre, setNombre] = useState(flujo.nombre);
  const [id, setId] = useState(flujo.id);
  const [activo, setActivo] = useState(!!flujo.activo);
  const [sucio, setSucio] = useState(!flujo.id);
  const [msg, setMsg] = useState(null);
  const [guardando, setGuardando] = useState(false);
  const [vistaPrevia, setVistaPrevia] = useState(false);
  const [verPendientes, setVerPendientes] = useState(false);
  const { screenToFlowPosition } = useReactFlow();
  const nodesRef = useRef(nodes); nodesRef.current = nodes;

  const def = useMemo(() => aDefinicion(nodes, edges), [nodes, edges]);
  const disparador = nodes.find((n) => n.type === 'inicio')?.data.disparador || { tipo: 'conversacion_nueva' };
  const { errores, avisos } = useMemo(() => revisar(def), [def]);
  const campos = useMemo(() => nodes.filter((n) => n.type === 'pregunta' && n.data.campo).map((n) => n.data.campo), [nodes]);
  const numero = useCallback((nid) => nodesRef.current.find((n) => n.id === nid)?.data.n ?? '?', []);

  // Cada paso lleva un número estable (#n); los pasos viejos sin número lo reciben aquí.
  useEffect(() => {
    if (nodes.some((n) => n.type !== 'inicio' && !n.data.n)) {
      let max = Math.max(0, ...nodes.map((n) => n.data.n || 0));
      setNodes((ns) => ns.map((n) => (n.type === 'inicio' || n.data.n ? n : { ...n, data: { ...n.data, n: ++max } })));
    }
  }, [nodes, setNodes]);

  const actualizar = useCallback((nid, parche) => {
    const actual = nodesRef.current.find((n) => n.id === nid); if (!actual) return;
    const nuevo = { ...actual, data: { ...actual.data, ...parche } };
    const validos = new Set(puertosValidos(nuevo.type, nuevo.data));
    setNodes((ns) => ns.map((n) => (n.id === nid ? nuevo : n)));
    setEdges((es) => es.filter((e) => e.source !== nid || validos.has(e.sourceHandle)));
    setSucio(true);
  }, [setNodes, setEdges]);

  const quitarBoton = useCallback((nid, k) => {
    const actual = nodesRef.current.find((n) => n.id === nid); if (!actual) return;
    setNodes((ns) => ns.map((n) => (n.id === nid ? { ...n, data: { ...n.data, botones: n.data.botones.filter((_, i) => i !== k) } } : n)));
    setEdges((es) => es.filter((e) => !(e.source === nid && e.sourceHandle === `btn:${k}`)).map((e) => {
      const j = e.source === nid && e.sourceHandle?.startsWith('btn:') ? Number(e.sourceHandle.slice(4)) : -1;
      return j > k ? { ...e, id: uid(), sourceHandle: `btn:${j - 1}` } : e;
    }));
    setSucio(true);
  }, [setNodes, setEdges]);

  const eliminar = useCallback((nid) => {
    setNodes((ns) => ns.filter((n) => n.id !== nid));
    setEdges((es) => es.filter((e) => e.source !== nid && e.target !== nid));
    setSucio(true);
  }, [setNodes, setEdges]);

  // Una sola línea por salida: conectar de nuevo desde el mismo puerto reemplaza la anterior.
  const alConectar = useCallback((c) => {
    if (!puedeEditar || c.source === c.target) return;
    setEdges((es) => [...es.filter((e) => !(e.source === c.source && e.sourceHandle === c.sourceHandle)), { id: uid(), ...c, targetHandle: 'in', ...ESTILO_ARISTA }]);
    setSucio(true);
  }, [setEdges, puedeEditar]);

  // Un paso nuevo aparece en un hueco libre cerca del centro de lo que se ve, nunca encima de otro.
  const agregar = (tipo) => {
    const ancho = 310, alto = 280;
    const max = Math.max(0, ...nodesRef.current.map((n) => n.data.n || 0));
    const centro = screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
    const libre = (x, y) => !nodesRef.current.some((n) => Math.abs(n.position.x - x) < ancho && Math.abs(n.position.y - y) < alto);
    let pos = { x: centro.x - ancho / 2, y: centro.y - alto / 2 };
    buscar: for (let anillo = 0; anillo < 8; anillo++) {
      for (const dx of anillo === 0 ? [0] : [anillo, -anillo]) {
        for (let dy = -anillo; dy <= anillo; dy++) {
          const x = centro.x - ancho / 2 + dx * ancho, y = centro.y - alto / 2 + dy * alto;
          if (libre(x, y)) { pos = { x, y }; break buscar; }
        }
      }
    }
    setNodes((ns) => [...ns.map((n) => ({ ...n, selected: false })), { id: uid(), type: tipo, position: pos, data: { ...datosNuevos(tipo), n: max + 1 }, selected: true }]);
    setSucio(true);
  };

  async function guardar(queActivo = activo) {
    if (queActivo && errores.length) { setMsg({ tipo: 'error', texto: `Para activarlo: ${errores[0]}` }); setVerPendientes(true); return; }
    if (!nombre.trim()) { setMsg({ tipo: 'error', texto: 'Ponle un nombre al flujo' }); return; }
    if (disparador.tipo === 'palabra_clave' && !(disparador.palabras || []).length) { setMsg({ tipo: 'error', texto: 'Escribe al menos una palabra clave en el inicio' }); return; }
    setGuardando(true); setMsg(null);
    const fila = { organization_id: org.id, nombre: nombre.trim(), activo: queActivo, disparador, definicion: def };
    const { data, error } = id
      ? await supabase.from('flujos').update(fila).eq('id', id).select().single()
      : await supabase.from('flujos').insert(fila).select().single();
    setGuardando(false);
    if (error) { setMsg({ tipo: 'error', texto: error.message }); return; }
    setId(data.id); setActivo(!!data.activo); setSucio(false);
    setMsg({ tipo: 'ok', texto: data.activo ? 'Guardado y activo' : 'Guardado' });
  }

  const cerrar = () => { if (!sucio || window.confirm('Tienes cambios sin guardar. ¿Salir sin guardar?')) onCerrar(!!id); };
  const ctx = useMemo(() => ({ actualizar, quitarBoton, eliminar, campos, numero, soloLectura: !puedeEditar }), [actualizar, quitarBoton, eliminar, campos, numero, puedeEditar]);

  return (
    <Ctx.Provider value={ctx}>
      <div className="fl-editor" role="dialog" aria-label="Editor de flujo">
        <header className="fl-barra">
          <button type="button" onClick={cerrar} aria-label="Volver a la lista de flujos">← Flujos</button>
          <input className="fl-nombre" value={nombre} disabled={!puedeEditar} onChange={(e) => { setNombre(e.target.value); setSucio(true); }} aria-label="Nombre del flujo" />
          <span className={`fl-estado ${activo ? 'on' : ''}`}>{activo ? '● Activo' : '○ Apagado'}</span>
          <span className="fl-espacio" />
          {(errores.length > 0 || avisos.length > 0) && (
            <button type="button" className={`fl-pend ${errores.length ? 'err' : ''}`} onClick={() => setVerPendientes(!verPendientes)} aria-expanded={verPendientes}>
              ⚠ {errores.length + avisos.length} pendiente{errores.length + avisos.length === 1 ? '' : 's'}
            </button>
          )}
          <button type="button" onClick={() => setVistaPrevia(!vistaPrevia)} aria-pressed={vistaPrevia}>▶ Previsualizar bot</button>
          {puedeEditar && <button type="button" disabled={guardando || (!sucio && !!id)} onClick={() => guardar()}>{guardando ? 'Guardando…' : 'Guardar'}</button>}
          {puedeEditar && <button type="button" className="fl-primario" disabled={guardando} onClick={() => guardar(!activo)}>{activo ? 'Apagar' : 'Guardar y activar'}</button>}
        </header>
        {msg && <p className={`fl-msg fl-${msg.tipo}`} role="status">{msg.texto}</p>}
        {verPendientes && (errores.length > 0 || avisos.length > 0) && (
          <ul className="fl-lista-pend" aria-label="Pendiente por arreglar">
            {errores.map((e) => <li key={e} className="err">{e}</li>)}{avisos.map((e) => <li key={e}>{e}</li>)}
          </ul>
        )}
        {!puedeEditar && <p className="fl-aviso">Solo el dueño y los administradores pueden editar flujos.</p>}

        <div className="fl-lienzo">
          {puedeEditar && (
            <nav className="fl-paleta" aria-label="Agregar paso">
              <p className="fl-paleta-tit">Agregar paso</p>
              {Object.entries(TIPOS).map(([t, m]) => (
                <button type="button" key={t} onClick={() => agregar(t)} title={`${m.nombre}: ${m.ayuda}`} aria-label={`Agregar ${m.nombre}`}><span aria-hidden>{m.icono}</span><small>{m.nombre}</small></button>
              ))}
            </nav>
          )}
          <div className="fl-fondo-lienzo">
          <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onConnect={alConectar}
            onNodeDragStop={() => setSucio(true)} deleteKeyCode={puedeEditar ? ['Delete'] : null} nodesDraggable={puedeEditar} nodesConnectable={puedeEditar}
            fitView fitViewOptions={{ padding: 0.1, minZoom: 0.55, maxZoom: 1.1 }} minZoom={0.25} maxZoom={1.6} colorMode="system" proOptions={{ hideAttribution: true }}>
            <Background gap={22} />
            <Controls showInteractive={false} />
            <MiniMap pannable zoomable className="fl-minimapa" style={{ width: 150, height: 96 }} />
          </ReactFlow>
          {vistaPrevia && <Previsualizar def={def} onCerrar={() => setVistaPrevia(false)} />}
          </div>
        </div>
      </div>
    </Ctx.Provider>
  );
}

// ---- Lista de flujos ----
export default function Flujos({ org, supabase }) {
  const puedeEditar = org?.role === 'dueno' || org?.role === 'admin';
  const [lista, setLista] = useState(null);
  const [abierto, setAbierto] = useState(null);   // flujo en edición
  const [msg, setMsg] = useState(null);

  const cargar = useCallback(async () => {
    const { data, error } = await supabase.from('flujos').select('*').eq('organization_id', org.id).order('created_at');
    if (error) { setMsg({ tipo: 'error', texto: error.message }); setLista([]); return; }
    setLista(data || []);
  }, [org.id, supabase]);
  useEffect(() => { setAbierto(null); setLista(null); cargar(); }, [cargar]);

  async function alternar(f) {
    setMsg(null);
    if (!f.activo) {
      const def = f.definicion?.version === 2 ? f.definicion : definicionVacia();
      const { errores } = revisar(def);
      if (errores.length) { setMsg({ tipo: 'error', texto: `«${f.nombre}» no se puede activar: ${errores[0]}` }); return; }
    }
    const { error } = await supabase.from('flujos').update({ activo: !f.activo }).eq('id', f.id);
    if (error) setMsg({ tipo: 'error', texto: error.message }); else cargar();
  }
  async function borrar(f) {
    if (!window.confirm(`¿Eliminar el flujo «${f.nombre}»? Las conversaciones que lo estén usando seguirán hasta terminar.`)) return;
    const { error } = await supabase.from('flujos').delete().eq('id', f.id);
    if (error) setMsg({ tipo: 'error', texto: error.message }); else cargar();
  }

  if (lista === null) return <div className="fl-lista-pagina fl-centro">Cargando…</div>;

  if (abierto) {
    return (
      <ReactFlowProvider>
        <Editor key={abierto.id || 'nuevo'} flujo={abierto} org={org} supabase={supabase} puedeEditar={puedeEditar}
          onCerrar={(recargar) => { setAbierto(null); if (recargar) cargar(); }} />
      </ReactFlowProvider>
    );
  }

  return (
    <main className="fl-lista-pagina">
      <div className="fl-lista-cab">
        <div><h2>Flujos de mensajes</h2><p className="fl-nota">Define qué hace Nora desde que entra un cliente: preguntas, botones, esperas y cuándo pasa a una persona.</p></div>
        {puedeEditar && <button type="button" className="fl-primario" onClick={() => setAbierto({ id: null, nombre: 'Nuevo flujo', activo: false, disparador: { tipo: 'conversacion_nueva' }, definicion: definicionVacia() })}>＋ Nuevo flujo</button>}
      </div>
      {msg && <p className={`fl-msg fl-${msg.tipo}`} role="status">{msg.texto}</p>}
      {lista.length === 0 ? (
        <div className="fl-vacio"><p><b>Aún no tienes flujos.</b></p><p className="fl-nota">Crea el primero: por ejemplo, un saludo con botones «Producto», «Mi pedido» y «Hablar con alguien».</p></div>
      ) : (
        <ul className="fl-tarjetas">
          {lista.map((f) => (
            <li key={f.id} className="fl-tarjeta">
              <div className="fl-tarjeta-info">
                <b>{f.nombre}</b>
                <span className="fl-nota">{resumenDisparador(f.disparador)} · {(f.definicion?.nodos || []).filter((n) => n.tipo !== 'inicio').length} pasos</span>
              </div>
              <label className="fl-interruptor" title={f.activo ? 'Activo: Nora lo usa' : 'Apagado'}>
                <input type="checkbox" role="switch" checked={f.activo} disabled={!puedeEditar} onChange={() => alternar(f)} aria-label={`${f.activo ? 'Apagar' : 'Activar'} ${f.nombre}`} />
                <span>{f.activo ? 'Activo' : 'Apagado'}</span>
              </label>
              <button type="button" onClick={() => setAbierto(f)}>{puedeEditar ? 'Editar' : 'Ver'}</button>
              {puedeEditar && <button type="button" onClick={() => borrar(f)} aria-label={`Eliminar ${f.nombre}`}>Eliminar</button>}
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
