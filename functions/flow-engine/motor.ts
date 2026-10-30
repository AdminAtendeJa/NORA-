// Motor de flujos de Nora, versión 2: un GRAFO de nodos y conexiones, como el Salesbot de Kommo.
// Es lógica pura (sin red ni base de datos): la usan igual el servidor (flow-engine) y la previsualización del panel,
// así lo que el dueño prueba es exactamente lo que se ejecuta.
//
// Cada nodo tiene "puertos" de salida; una arista une un puerto con el nodo siguiente:
//   next    → continuar            btn:N → el cliente eligió el botón N     otra    → cualquier otra respuesta
//   timeout → no respondió a tiempo   si/no → resultado de una condición

export type Op = 'igual' | 'distinto' | 'contiene' | 'mayor' | 'menor' | 'existe';
export type Validacion = 'texto' | 'numero' | 'si_no' | 'opciones';
export type Boton = { titulo: string; sinonimos?: string[] };

type Base = { id: string; x: number; y: number; n?: number };   // n = número estable del paso (#n en el editor)
export type Nodo =
  | (Base & { tipo: 'inicio' })
  | (Base & { tipo: 'mensaje'; texto: string; botones: Boton[]; espera?: boolean; timeoutMin?: number })
  | (Base & { tipo: 'pregunta'; texto: string; campo: string; validacion: Validacion; opciones?: string[]; timeoutMin?: number })
  | (Base & { tipo: 'condicion'; campo: string; op: Op; valor?: string })
  | (Base & { tipo: 'esperar'; minutos: number })
  | (Base & { tipo: 'etiquetar'; etiqueta: string })
  | (Base & { tipo: 'etapa'; etapa: string })
  | (Base & { tipo: 'humano'; motivo?: string })
  | (Base & { tipo: 'nora' })
  | (Base & { tipo: 'fin' });

export type TipoNodo = Nodo['tipo'];
export type Arista = { id: string; de: string; puerto: string; a: string };
export type Definicion = { version: 2; nodos: Nodo[]; aristas: Arista[] };

export type Esperando =
  | { tipo: 'respuesta'; nodo: string; intentos: number; vence?: string }
  | { tipo: 'tiempo'; hasta: string }
  | null;
export type Fin = null | 'completado' | 'humano' | 'nora';
export type Estado = { nodo: string | null; datos: Record<string, string>; esperando: Esperando; fin: Fin };

export type Accion =
  | { tipo: 'enviar'; texto: string; botones?: string[] }
  | { tipo: 'guardar'; campo: string; valor: string }
  | { tipo: 'etiquetar'; etiqueta: string }
  | { tipo: 'etapa'; etapa: string }
  | { tipo: 'humano'; motivo: string };

export const MAX_NODOS = 100;
export const MAX_BOTONES = 10;       // hasta 3 salen como botones de WhatsApp; más, como lista numerada
export const MAX_BOTONES_NATIVOS = 3;
export const MAX_TITULO_BOTON = 20;  // límite de WhatsApp para el texto de un botón
const MAX_PASOS_POR_TURNO = 200;
const MAX_INTENTOS = 3;

export const definicionVacia = (): Definicion => ({ version: 2, nodos: [{ id: 'inicio', tipo: 'inicio', x: 0, y: 0 }], aristas: [] });
export const estadoInicial = (def: Definicion, datos: Record<string, string> = {}): Estado =>
  ({ nodo: def.nodos.find((n) => n.tipo === 'inicio')?.id ?? null, datos: { ...datos }, esperando: null, fin: null });

// ---- Utilidades de texto ----
export const norm = (s: unknown) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

export function interpolar(texto: string, datos: Record<string, string>): string {
  return String(texto ?? '').replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => datos[k] ?? '');
}

export function textoPregunta(texto: string, validacion: Validacion, opciones?: string[]): string {
  if (validacion === 'opciones' && opciones?.length) return `${texto}\n${opciones.map((o, i) => `${i + 1}. ${o}`).join('\n')}`;
  return texto;
}

// ---- Validación de la respuesta del cliente a una pregunta ----
export function validar(entrada: string, validacion: Validacion, opciones: string[] = []): { ok: true; valor: string } | { ok: false } {
  const t = String(entrada ?? '').trim();
  if (!t) return { ok: false };
  switch (validacion) {
    case 'texto': return { ok: true, valor: t.slice(0, 500) };
    case 'numero': {
      const m = t.match(/-?\d[\d.,]*/);
      if (!m) return { ok: false };
      let n = m[0].replace(/[.,]+$/, '');
      if (/^-?\d{1,3}([.,]\d{3})+$/.test(n)) n = n.replace(/[.,]/g, '');   // 1.500 / 1,500 → 1500
      else n = n.replace(',', '.');                                        // 12,5 → 12.5
      const v = Number(n);
      return Number.isFinite(v) ? { ok: true, valor: String(v) } : { ok: false };
    }
    case 'si_no': {
      const n = norm(t);
      if (/^(si|s|yes|y|sim|claro|ok|dale|por supuesto|correcto|afirmativo)\b/.test(n)) return { ok: true, valor: 'si' };
      if (/^(no|n|nope|nao|negativo)\b/.test(n)) return { ok: true, valor: 'no' };
      return { ok: false };
    }
    case 'opciones': {
      const n = norm(t);
      const idx = /^\d+$/.test(n) ? Number(n) - 1 : -1;
      if (idx >= 0 && idx < opciones.length) return { ok: true, valor: opciones[idx] };
      const hit = opciones.find((o) => norm(o) === n) ?? opciones.find((o) => n.length >= 3 && (norm(o).includes(n) || n.includes(norm(o))));
      return hit ? { ok: true, valor: hit } : { ok: false };
    }
  }
}

// ¿Qué botón quiso decir el cliente? Por el título exacto, por su número, o por un sinónimo (como en Kommo).
export function elegirBoton(entrada: string, botones: Boton[]): number {
  const n = norm(entrada);
  if (!n) return -1;
  if (/^\d+$/.test(n)) { const i = Number(n) - 1; if (i >= 0 && i < botones.length) return i; }
  const exacto = botones.findIndex((b) => norm(b.titulo) === n);
  if (exacto >= 0) return exacto;
  const sinonimo = botones.findIndex((b) => (b.sinonimos || []).some((s) => { const x = norm(s); return x && (n === x || n.split(/[^\p{L}\p{N}]+/u).includes(x) || (x.length >= 4 && n.includes(x))); }));
  if (sinonimo >= 0) return sinonimo;
  return botones.findIndex((b) => { const t = norm(b.titulo); return n.length >= 4 && t.length >= 4 && (t.includes(n) || n.includes(t)); });
}

export function evaluar(cond: { campo: string; op: Op; valor?: string }, datos: Record<string, string>): boolean {
  const v = datos[cond.campo];
  const vacio = v === undefined || String(v).trim() === '';
  if (cond.op === 'existe') return !vacio;
  if (vacio) return cond.op === 'distinto';
  const a = norm(v), b = norm(cond.valor);
  switch (cond.op) {
    case 'igual': return a === b;
    case 'distinto': return a !== b;
    case 'contiene': return a.includes(b);
    case 'mayor': case 'menor': {
      const x = Number(v), y = Number(String(cond.valor ?? '').replace(',', '.'));
      if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
      return cond.op === 'mayor' ? x > y : x < y;
    }
  }
  return false;
}

export const botonesActivos = (n: { botones?: Boton[] }): Boton[] => (n.botones || []).filter((b) => b.titulo?.trim());
export const nodoEspera = (n: Nodo): boolean => n.tipo === 'pregunta' || (n.tipo === 'mensaje' && (botonesActivos(n).length > 0 || !!n.espera));

// ---- Ejecución ----
// `entrada` es el mensaje del cliente (null si solo se despierta por tiempo o se arranca el flujo).
export function avanzar(def: Definicion, previo: Estado, entrada: string | null, ahora: Date = new Date()): { estado: Estado; acciones: Accion[] } {
  const estado: Estado = { ...previo, datos: { ...previo.datos } };
  const acciones: Accion[] = [];
  if (estado.fin) return { estado, acciones };

  const nodos = new Map(def.nodos.map((n) => [n.id, n]));
  const sale = new Map(def.aristas.map((a) => [`${a.de}|${a.puerto}`, a.a]));
  const destino = (id: string, puerto: string): string | null => sale.get(`${id}|${puerto}`) ?? null;
  const venceEn = (min: number | undefined, id: string) =>
    min && min > 0 && sale.has(`${id}|timeout`) ? new Date(ahora.getTime() + min * 60_000).toISOString() : undefined;

  const esp = estado.esperando;
  if (esp?.tipo === 'tiempo') {
    if (ahora.getTime() < new Date(esp.hasta).getTime()) return { estado, acciones };
    estado.esperando = null;                       // venció la pausa: sigue en estado.nodo
  } else if (esp?.tipo === 'respuesta') {
    const nodo = nodos.get(esp.nodo);
    if (!nodo) { estado.fin = 'completado'; estado.esperando = null; return { estado, acciones }; }

    if (entrada === null) {                        // despertado por el reloj: ¿venció el tiempo sin respuesta?
      if (!esp.vence || ahora.getTime() < new Date(esp.vence).getTime()) return { estado, acciones };
      estado.esperando = null; estado.nodo = destino(nodo.id, 'timeout');
    } else if (nodo.tipo === 'mensaje') {
      const botones = botonesActivos(nodo);
      const i = botones.length ? elegirBoton(entrada, botones) : -1;
      if (i >= 0) { estado.esperando = null; estado.nodo = destino(nodo.id, `btn:${i}`); }
      else if (sale.has(`${nodo.id}|otra`) || botones.length === 0) { estado.esperando = null; estado.nodo = destino(nodo.id, 'otra'); }
      else {                                       // hay botones pero respondió otra cosa y no hay salida «otra respuesta»
        const intentos = esp.intentos + 1;
        if (intentos >= MAX_INTENTOS) {
          acciones.push({ tipo: 'humano', motivo: 'El cliente no eligió ninguna opción' });
          estado.fin = 'humano'; estado.esperando = null; estado.nodo = null;
          return { estado, acciones };
        }
        acciones.push({ tipo: 'enviar', texto: `Elige una de las opciones. ${interpolar(nodo.texto, estado.datos)}`.trim(), botones: botones.map((b) => b.titulo) });
        estado.esperando = { ...esp, intentos };
        return { estado, acciones };
      }
    } else if (nodo.tipo === 'pregunta') {
      const r = validar(entrada, nodo.validacion, nodo.opciones);
      if (r.ok) {
        estado.datos[nodo.campo] = r.valor;
        acciones.push({ tipo: 'guardar', campo: nodo.campo, valor: r.valor });
        estado.esperando = null; estado.nodo = destino(nodo.id, 'next');
      } else {
        const intentos = esp.intentos + 1;
        if (intentos >= MAX_INTENTOS) {
          estado.esperando = null;
          if (sale.has(`${nodo.id}|otra`)) estado.nodo = destino(nodo.id, 'otra');
          else {
            acciones.push({ tipo: 'humano', motivo: `El cliente no respondió "${nodo.campo}" de forma válida` });
            estado.fin = 'humano'; estado.nodo = null;
            return { estado, acciones };
          }
        } else {
          acciones.push({ tipo: 'enviar', texto: `No te entendí bien. ${interpolar(textoPregunta(nodo.texto, nodo.validacion, nodo.opciones), estado.datos)}` });
          estado.esperando = { ...esp, intentos };
          return { estado, acciones };
        }
      }
    } else { estado.esperando = null; estado.nodo = destino(nodo.id, 'next'); }
  }

  for (let paso = 0; paso < MAX_PASOS_POR_TURNO; paso++) {
    const nodo = estado.nodo ? nodos.get(estado.nodo) : undefined;
    if (!nodo) { estado.fin = 'completado'; estado.nodo = null; return { estado, acciones }; }
    switch (nodo.tipo) {
      case 'inicio': estado.nodo = destino(nodo.id, 'next'); break;
      case 'mensaje': {
        const botones = botonesActivos(nodo);
        if (nodo.texto?.trim()) acciones.push({ tipo: 'enviar', texto: interpolar(nodo.texto, estado.datos), botones: botones.length ? botones.map((b) => b.titulo) : undefined });
        if (nodoEspera(nodo)) { estado.esperando = { tipo: 'respuesta', nodo: nodo.id, intentos: 0, vence: venceEn(nodo.timeoutMin, nodo.id) }; return { estado, acciones }; }
        estado.nodo = destino(nodo.id, 'next'); break;
      }
      case 'pregunta':
        acciones.push({ tipo: 'enviar', texto: interpolar(textoPregunta(nodo.texto, nodo.validacion, nodo.opciones), estado.datos) });
        estado.esperando = { tipo: 'respuesta', nodo: nodo.id, intentos: 0, vence: venceEn(nodo.timeoutMin, nodo.id) };
        return { estado, acciones };
      case 'condicion': estado.nodo = destino(nodo.id, evaluar(nodo, estado.datos) ? 'si' : 'no'); break;
      case 'esperar':
        estado.esperando = { tipo: 'tiempo', hasta: new Date(ahora.getTime() + Math.max(0, nodo.minutos) * 60_000).toISOString() };
        estado.nodo = destino(nodo.id, 'next');
        return { estado, acciones };
      case 'etiquetar': acciones.push({ tipo: 'etiquetar', etiqueta: nodo.etiqueta }); estado.nodo = destino(nodo.id, 'next'); break;
      case 'etapa': acciones.push({ tipo: 'etapa', etapa: nodo.etapa }); estado.nodo = destino(nodo.id, 'next'); break;
      case 'humano':
        acciones.push({ tipo: 'humano', motivo: nodo.motivo || 'Lo pidió el flujo' });
        estado.fin = 'humano'; estado.nodo = null; return { estado, acciones };
      case 'nora': estado.fin = 'nora'; estado.nodo = null; return { estado, acciones };
      case 'fin': estado.fin = 'completado'; estado.nodo = null; return { estado, acciones };
    }
  }
  estado.fin = 'completado';                       // demasiados pasos seguidos sin esperar: se corta para no entrar en un bucle
  estado.nodo = null;
  return { estado, acciones };
}

// ---- Revisión antes de guardar / activar ----
// `errores` impiden activar el flujo; `avisos` solo informan (p. ej. un paso suelto que nunca se ejecutaría).
export function revisar(def: Definicion): { errores: string[]; avisos: string[] } {
  const errores: string[] = [], avisos: string[] = [];
  const nodos = def?.nodos || [], aristas = def?.aristas || [];
  const numero = new Map(nodos.map((n, i) => [n.id, i]));
  const nombre = (n: Nodo) => `Paso ${n.n ?? numero.get(n.id)}`;
  const pasos = nodos.filter((n) => n.tipo !== 'inicio');
  if (pasos.length === 0) errores.push('El flujo no tiene pasos');
  if (nodos.length > MAX_NODOS) errores.push(`Máximo ${MAX_NODOS} pasos`);
  const inicio = nodos.find((n) => n.tipo === 'inicio');
  if (!inicio) errores.push('Falta el nodo de inicio');
  else if (pasos.length && !aristas.some((a) => a.de === inicio.id && a.puerto === 'next')) errores.push('Conecta el inicio con el primer paso');

  const campos = new Set<string>();
  for (const n of nodos) {
    if (n.tipo === 'mensaje') {
      const bs = botonesActivos(n);
      if (!n.texto?.trim()) errores.push(`${nombre(n)}: el mensaje está vacío`);
      if ((n.botones || []).some((b) => !b.titulo?.trim())) errores.push(`${nombre(n)}: hay un botón sin texto`);
      if (bs.length > MAX_BOTONES) errores.push(`${nombre(n)}: máximo ${MAX_BOTONES} botones`);
      if (bs.length > 0 && bs.length <= MAX_BOTONES_NATIVOS && bs.some((b) => b.titulo.length > MAX_TITULO_BOTON)) errores.push(`${nombre(n)}: los botones miden máximo ${MAX_TITULO_BOTON} caracteres`);
      if (new Set(bs.map((b) => norm(b.titulo))).size !== bs.length) errores.push(`${nombre(n)}: hay botones repetidos`);
    }
    if (n.tipo === 'pregunta') {
      if (!n.texto?.trim()) errores.push(`${nombre(n)}: la pregunta está vacía`);
      if (!/^[a-z][a-z0-9_]{0,29}$/.test(n.campo || '')) errores.push(`${nombre(n)}: el dato a guardar necesita un nombre (letras minúsculas y _)`);
      if (campos.has(n.campo)) errores.push(`${nombre(n)}: el dato "${n.campo}" ya se usa en otra pregunta`);
      campos.add(n.campo);
      if (n.validacion === 'opciones' && (n.opciones || []).filter((o) => o.trim()).length < 2) errores.push(`${nombre(n)}: pon al menos 2 opciones`);
    }
    if (n.tipo === 'condicion') {
      if (!n.campo) errores.push(`${nombre(n)}: elige qué dato comparar`);
      if (n.op !== 'existe' && !String(n.valor ?? '').trim()) errores.push(`${nombre(n)}: falta el valor de comparación`);
    }
    if (n.tipo === 'esperar' && !(n.minutos > 0)) errores.push(`${nombre(n)}: la espera debe ser mayor que 0 minutos`);
    if (n.tipo === 'etiquetar' && !n.etiqueta?.trim()) errores.push(`${nombre(n)}: falta la etiqueta`);
    if (n.tipo === 'etapa' && !n.etapa?.trim()) errores.push(`${nombre(n)}: elige una etapa`);
  }
  for (const a of aristas) {
    if (!numero.has(a.de) || !numero.has(a.a)) errores.push('Hay una conexión que apunta a un paso que no existe');
  }
  // Pasos a los que nunca se llega desde el inicio
  if (inicio) {
    const visto = new Set<string>([inicio.id]); const cola = [inicio.id];
    while (cola.length) { const id = cola.pop()!; for (const a of aristas) if (a.de === id && !visto.has(a.a)) { visto.add(a.a); cola.push(a.a); } }
    for (const n of pasos) if (!visto.has(n.id)) avisos.push(`${nombre(n)} no está conectado: nunca se ejecutará`);
  }
  return { errores: [...new Set(errores)], avisos };
}
