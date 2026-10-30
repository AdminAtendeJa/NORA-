// Motor de flujos de Nora: intérprete puro (sin red ni base de datos).
// Lo usan igual el servidor (flow-engine) y el simulador del panel, así lo que el dueño prueba es lo que se ejecuta.
//
// Un flujo es una lista de pasos. `condicion` lleva dos ramas (si / si_no). Antes de ejecutar se "compila" a una
// lista plana con saltos, de modo que el estado de una conversación es solo un número (`pc`) y unos datos.

export type Op = 'igual' | 'distinto' | 'contiene' | 'mayor' | 'menor' | 'existe';
export type Validacion = 'texto' | 'numero' | 'si_no' | 'opciones';

export type Paso =
  | { id: string; tipo: 'mensaje'; texto: string }
  | { id: string; tipo: 'pregunta'; texto: string; campo: string; validacion: Validacion; opciones?: string[] }
  | { id: string; tipo: 'condicion'; campo: string; op: Op; valor?: string; si: Paso[]; si_no: Paso[] }
  | { id: string; tipo: 'esperar'; minutos: number }
  | { id: string; tipo: 'etiquetar'; etiqueta: string }
  | { id: string; tipo: 'etapa'; etapa: string }
  | { id: string; tipo: 'humano'; motivo?: string }
  | { id: string; tipo: 'nora' };

export type Definicion = { pasos: Paso[] };

type PasoSimple = Exclude<Paso, { tipo: 'condicion' }>;
type Cond = { campo: string; op: Op; valor?: string };
export type Instruccion =
  | { op: 'paso'; paso: PasoSimple }
  | { op: 'si_no_salta'; cond: Cond; destino: number }
  | { op: 'salta'; destino: number };

export type Esperando =
  | { tipo: 'respuesta'; texto: string; campo: string; validacion: Validacion; opciones?: string[]; intentos: number }
  | { tipo: 'tiempo'; hasta: string }
  | null;

export type Fin = null | 'completado' | 'humano' | 'nora';
export type Estado = { pc: number; datos: Record<string, string>; esperando: Esperando; fin: Fin };

export type Accion =
  | { tipo: 'enviar'; texto: string }
  | { tipo: 'guardar'; campo: string; valor: string }
  | { tipo: 'etiquetar'; etiqueta: string }
  | { tipo: 'etapa'; etapa: string }
  | { tipo: 'humano'; motivo: string };

export const MAX_PASOS = 100;
const MAX_INSTRUCCIONES_POR_TURNO = 200;
const MAX_INTENTOS = 3;

export const estadoInicial = (datos: Record<string, string> = {}): Estado => ({ pc: 0, datos: { ...datos }, esperando: null, fin: null });

// ---- Compilación: ramas → saltos ----
export function compilar(pasos: Paso[]): Instruccion[] {
  const out: Instruccion[] = [];
  const emitir = (lista: Paso[]) => {
    for (const p of lista || []) {
      if (p.tipo !== 'condicion') { out.push({ op: 'paso', paso: p }); continue; }
      const salto: Extract<Instruccion, { op: 'si_no_salta' }> = { op: 'si_no_salta', cond: { campo: p.campo, op: p.op, valor: p.valor }, destino: -1 };
      out.push(salto);
      emitir(p.si);
      const fin: Extract<Instruccion, { op: 'salta' }> = { op: 'salta', destino: -1 };
      out.push(fin);
      salto.destino = out.length;
      emitir(p.si_no);
      fin.destino = out.length;
    }
  };
  emitir(pasos);
  return out;
}

// ---- Utilidades de texto ----
const norm = (s: unknown) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

export function interpolar(texto: string, datos: Record<string, string>): string {
  return String(texto ?? '').replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => datos[k] ?? '');
}

export function textoPregunta(texto: string, validacion: Validacion, opciones?: string[]): string {
  if (validacion === 'opciones' && opciones?.length) return `${texto}\n${opciones.map((o, i) => `${i + 1}. ${o}`).join('\n')}`;
  return texto;
}

// ---- Validación de la respuesta del cliente ----
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

export function evaluar(cond: Cond, datos: Record<string, string>): boolean {
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

// ---- Ejecución ----
// `entrada` es el mensaje del cliente (null si solo se despierta por tiempo o se arranca el flujo).
export function avanzar(prog: Instruccion[], previo: Estado, entrada: string | null, ahora: Date = new Date()): { estado: Estado; acciones: Accion[] } {
  const estado: Estado = { ...previo, datos: { ...previo.datos } };
  const acciones: Accion[] = [];
  if (estado.fin) return { estado, acciones };

  const esp = estado.esperando;
  if (esp?.tipo === 'respuesta') {
    if (entrada === null) return { estado, acciones };
    const r = validar(entrada, esp.validacion, esp.opciones);
    if (!r.ok) {
      const intentos = esp.intentos + 1;
      if (intentos >= MAX_INTENTOS) {
        acciones.push({ tipo: 'humano', motivo: `El cliente no respondió "${esp.campo}" de forma válida` });
        estado.fin = 'humano'; estado.esperando = null;
        return { estado, acciones };
      }
      acciones.push({ tipo: 'enviar', texto: `No te entendí bien. ${interpolar(textoPregunta(esp.texto, esp.validacion, esp.opciones), estado.datos)}` });
      estado.esperando = { ...esp, intentos };
      return { estado, acciones };
    }
    estado.datos[esp.campo] = r.valor;
    acciones.push({ tipo: 'guardar', campo: esp.campo, valor: r.valor });
    estado.esperando = null;
    estado.pc += 1;
  } else if (esp?.tipo === 'tiempo') {
    if (ahora.getTime() < new Date(esp.hasta).getTime()) return { estado, acciones };
    estado.esperando = null;
  }

  for (let n = 0; n < MAX_INSTRUCCIONES_POR_TURNO; n++) {
    if (estado.pc >= prog.length) { estado.fin = 'completado'; return { estado, acciones }; }
    const ins = prog[estado.pc];
    if (ins.op === 'salta') { estado.pc = ins.destino; continue; }
    if (ins.op === 'si_no_salta') { estado.pc = evaluar(ins.cond, estado.datos) ? estado.pc + 1 : ins.destino; continue; }

    const p = ins.paso;
    switch (p.tipo) {
      case 'mensaje':
        if (p.texto?.trim()) acciones.push({ tipo: 'enviar', texto: interpolar(p.texto, estado.datos) });
        estado.pc += 1; break;
      case 'pregunta':
        acciones.push({ tipo: 'enviar', texto: interpolar(textoPregunta(p.texto, p.validacion, p.opciones), estado.datos) });
        estado.esperando = { tipo: 'respuesta', texto: p.texto, campo: p.campo, validacion: p.validacion, opciones: p.opciones, intentos: 0 };
        return { estado, acciones };
      case 'esperar':
        estado.esperando = { tipo: 'tiempo', hasta: new Date(ahora.getTime() + Math.max(0, p.minutos) * 60_000).toISOString() };
        estado.pc += 1;
        return { estado, acciones };
      case 'etiquetar': acciones.push({ tipo: 'etiquetar', etiqueta: p.etiqueta }); estado.pc += 1; break;
      case 'etapa': acciones.push({ tipo: 'etapa', etapa: p.etapa }); estado.pc += 1; break;
      case 'humano':
        acciones.push({ tipo: 'humano', motivo: p.motivo || 'Lo pidió el flujo' });
        estado.fin = 'humano'; estado.pc += 1; return { estado, acciones };
      case 'nora':
        estado.fin = 'nora'; estado.pc += 1; return { estado, acciones };
    }
  }
  // Demasiados pasos seguidos sin esperar: se corta para no entrar en un bucle.
  estado.fin = 'completado';
  return { estado, acciones };
}

// ---- Revisión del flujo antes de guardarlo / activarlo ----
export function revisar(def: Definicion): string[] {
  const errores: string[] = [];
  let total = 0;
  const campos = new Set<string>();
  const recorrer = (pasos: Paso[], ruta: string) => {
    pasos.forEach((p, i) => {
      total += 1;
      const donde = `${ruta}${i + 1}`;
      if (p.tipo === 'mensaje' && !p.texto?.trim()) errores.push(`Paso ${donde}: el mensaje está vacío`);
      if (p.tipo === 'pregunta') {
        if (!p.texto?.trim()) errores.push(`Paso ${donde}: la pregunta está vacía`);
        if (!/^[a-z][a-z0-9_]{0,29}$/.test(p.campo || '')) errores.push(`Paso ${donde}: el dato a guardar necesita un nombre (letras minúsculas y _)`);
        if (campos.has(p.campo)) errores.push(`Paso ${donde}: el dato "${p.campo}" ya se usa en otra pregunta`);
        campos.add(p.campo);
        if (p.validacion === 'opciones' && (p.opciones || []).filter((o) => o.trim()).length < 2) errores.push(`Paso ${donde}: pon al menos 2 opciones`);
      }
      if (p.tipo === 'condicion') {
        if (!p.campo) errores.push(`Paso ${donde}: elige qué dato comparar`);
        if (p.op !== 'existe' && !String(p.valor ?? '').trim()) errores.push(`Paso ${donde}: falta el valor de comparación`);
        recorrer(p.si || [], `${donde}.sí.`);
        recorrer(p.si_no || [], `${donde}.no.`);
      }
      if (p.tipo === 'esperar' && !(p.minutos > 0)) errores.push(`Paso ${donde}: la espera debe ser mayor que 0 minutos`);
      if (p.tipo === 'etiquetar' && !p.etiqueta?.trim()) errores.push(`Paso ${donde}: falta la etiqueta`);
    });
  };
  recorrer(def?.pasos || [], '');
  if (total === 0) errores.push('El flujo no tiene pasos');
  if (total > MAX_PASOS) errores.push(`Máximo ${MAX_PASOS} pasos`);
  return errores;
}
