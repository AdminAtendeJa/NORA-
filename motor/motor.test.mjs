// Ejecutar: node --experimental-strip-types --test motor.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { compilar, avanzar, estadoInicial, validar, evaluar, revisar, interpolar } from './motor.ts';

let n = 0;
const id = () => `p${++n}`;
const msg = (texto) => ({ id: id(), tipo: 'mensaje', texto });
const preg = (texto, campo, validacion = 'texto', opciones) => ({ id: id(), tipo: 'pregunta', texto, campo, validacion, opciones });
const cond = (campo, op, valor, si, si_no = []) => ({ id: id(), tipo: 'condicion', campo, op, valor, si, si_no });
const textos = (r) => r.acciones.filter((a) => a.tipo === 'enviar').map((a) => a.texto);

// Flujo de cualificación típico
const flujo = () => [
  msg('Hola {{nombre}}, soy Nora 👋'),
  preg('¿Cuál es tu presupuesto mensual en USD?', 'presupuesto', 'numero'),
  cond('presupuesto', 'mayor', '500',
    [{ id: id(), tipo: 'etiquetar', etiqueta: 'caliente' }, msg('Perfecto, te paso con un asesor'), { id: id(), tipo: 'humano', motivo: 'Lead caliente' }],
    [msg('Gracias, te dejo info'), { id: id(), tipo: 'etapa', etapa: 'interesado' }, { id: id(), tipo: 'nora' }]),
];

test('arranca: saluda con el nombre y espera la primera respuesta', () => {
  const prog = compilar(flujo());
  const r = avanzar(prog, estadoInicial({ nombre: 'Ana' }), null);
  assert.deepEqual(textos(r), ['Hola Ana, soy Nora 👋', '¿Cuál es tu presupuesto mensual en USD?']);
  assert.equal(r.estado.esperando.tipo, 'respuesta');
  assert.equal(r.estado.fin, null);
});

test('rama "sí": presupuesto alto → etiqueta, mensaje y pasa a humano', () => {
  const prog = compilar(flujo());
  let r = avanzar(prog, estadoInicial({ nombre: 'Ana' }), null);
  r = avanzar(prog, r.estado, 'unos $1.200 al mes');
  assert.equal(r.estado.datos.presupuesto, '1200');
  assert.deepEqual(r.acciones.map((a) => a.tipo), ['guardar', 'etiquetar', 'enviar', 'humano']);
  assert.equal(r.estado.fin, 'humano');
});

test('rama "no": presupuesto bajo → etapa y entrega a Nora', () => {
  const prog = compilar(flujo());
  let r = avanzar(prog, estadoInicial(), null);
  r = avanzar(prog, r.estado, '300');
  assert.deepEqual(r.acciones.map((a) => a.tipo), ['guardar', 'enviar', 'etapa']);
  assert.equal(r.estado.fin, 'nora');
});

test('respuesta inválida: repite la pregunta y tras 3 intentos pasa a una persona', () => {
  const prog = compilar(flujo());
  let r = avanzar(prog, estadoInicial(), null);
  r = avanzar(prog, r.estado, 'no sé');
  assert.match(textos(r)[0], /No te entendí/);
  assert.equal(r.estado.esperando.intentos, 1);
  r = avanzar(prog, r.estado, 'mmm');
  r = avanzar(prog, r.estado, 'jaja');
  assert.equal(r.estado.fin, 'humano');
  assert.equal(r.acciones[0].tipo, 'humano');
});

test('sin mensaje del cliente no avanza mientras espera respuesta', () => {
  const prog = compilar(flujo());
  const r1 = avanzar(prog, estadoInicial(), null);
  const r2 = avanzar(prog, r1.estado, null);
  assert.deepEqual(r2.acciones, []);
  assert.deepEqual(r2.estado, r1.estado);
});

test('condición con rama vacía y condiciones anidadas', () => {
  const prog = compilar([
    preg('¿Eres empresa? (sí/no)', 'empresa', 'si_no'),
    cond('empresa', 'igual', 'si', [
      preg('¿Cuántos empleados?', 'empleados', 'numero'),
      cond('empleados', 'mayor', '10', [msg('Plan grande')], [msg('Plan chico')]),
    ]),
    msg('Fin'),
  ]);
  let r = avanzar(prog, estadoInicial(), null);
  r = avanzar(prog, r.estado, 'Sí');
  assert.match(textos(r)[0], /empleados/);
  r = avanzar(prog, r.estado, '25');
  assert.deepEqual(textos(r), ['Plan grande', 'Fin']);
  assert.equal(r.estado.fin, 'completado');
  // rama "no" vacía: salta directo a "Fin"
  let s = avanzar(prog, estadoInicial(), null);
  s = avanzar(prog, s.estado, 'no');
  assert.deepEqual(textos(s), ['Fin']);
});

test('esperar: pausa, no avanza antes de tiempo y continúa al vencer', () => {
  const prog = compilar([msg('Hola'), { id: id(), tipo: 'esperar', minutos: 30 }, msg('¿Sigues ahí?')]);
  const t0 = new Date('2026-10-30T10:00:00Z');
  let r = avanzar(prog, estadoInicial(), null, t0);
  assert.deepEqual(textos(r), ['Hola']);
  assert.equal(r.estado.esperando.tipo, 'tiempo');
  assert.equal(r.estado.esperando.hasta, '2026-10-30T10:30:00.000Z');
  const antes = avanzar(prog, r.estado, null, new Date('2026-10-30T10:10:00Z'));
  assert.deepEqual(antes.acciones, []);
  const despues = avanzar(prog, r.estado, null, new Date('2026-10-30T10:31:00Z'));
  assert.deepEqual(textos(despues), ['¿Sigues ahí?']);
  assert.equal(despues.estado.fin, 'completado');
});

test('validar: números, sí/no y opciones', () => {
  assert.deepEqual(validar('1.500', 'numero'), { ok: true, valor: '1500' });
  assert.deepEqual(validar('1,500', 'numero'), { ok: true, valor: '1500' });
  assert.deepEqual(validar('12,5', 'numero'), { ok: true, valor: '12.5' });
  assert.deepEqual(validar('R$ 300 por mes', 'numero'), { ok: true, valor: '300' });
  assert.equal(validar('mucho', 'numero').ok, false);
  assert.deepEqual(validar('Sí, claro', 'si_no'), { ok: true, valor: 'si' });
  assert.deepEqual(validar('Não', 'si_no'), { ok: true, valor: 'no' });
  assert.equal(validar('quizás', 'si_no').ok, false);
  const ops = ['Comprar', 'Alquilar'];
  assert.deepEqual(validar('2', 'opciones', ops), { ok: true, valor: 'Alquilar' });
  assert.deepEqual(validar('quiero alquilar', 'opciones', ops), { ok: true, valor: 'Alquilar' });
  assert.equal(validar('3', 'opciones', ops).ok, false);
  assert.equal(validar('   ', 'texto').ok, false);
});

test('pregunta con opciones muestra la lista numerada', () => {
  const prog = compilar([preg('¿Qué buscas?', 'tipo', 'opciones', ['Comprar', 'Alquilar'])]);
  const r = avanzar(prog, estadoInicial(), null);
  assert.equal(textos(r)[0], '¿Qué buscas?\n1. Comprar\n2. Alquilar');
});

test('evaluar: operadores y datos vacíos', () => {
  assert.equal(evaluar({ campo: 'a', op: 'existe' }, {}), false);
  assert.equal(evaluar({ campo: 'a', op: 'existe' }, { a: 'x' }), true);
  assert.equal(evaluar({ campo: 'a', op: 'contiene', valor: 'ola' }, { a: 'HOLA' }), true);
  assert.equal(evaluar({ campo: 'a', op: 'menor', valor: '10' }, { a: '5' }), true);
  assert.equal(evaluar({ campo: 'a', op: 'mayor', valor: '10' }, { a: 'abc' }), false);
  assert.equal(evaluar({ campo: 'a', op: 'distinto', valor: 'x' }, {}), true);
});

test('un flujo largo sin esperas no entra en bucle infinito', () => {
  const pasos = Array.from({ length: 150 }, () => ({ id: id(), tipo: 'etiquetar', etiqueta: 'x' }));
  const r = avanzar(compilar(pasos), estadoInicial(), null);
  assert.equal(r.estado.fin, 'completado');
});

test('interpolar deja vacío lo que no existe', () => {
  assert.equal(interpolar('Hola {{nombre}}{{apellido}}!', { nombre: 'Ana' }), 'Hola Ana!');
});

test('revisar detecta errores típicos', () => {
  assert.deepEqual(revisar({ pasos: [] }), ['El flujo no tiene pasos']);
  const e = revisar({ pasos: [msg(''), preg('¿Y?', 'Mal Nombre'), preg('¿Otra?', 'ok'), preg('¿Otra?', 'ok'), cond('', 'igual', '', [msg('')])] });
  assert.ok(e.some((x) => /mensaje está vacío/.test(x)));
  assert.ok(e.some((x) => /necesita un nombre/.test(x)));
  assert.ok(e.some((x) => /ya se usa/.test(x)));
  assert.ok(e.some((x) => /elige qué dato/.test(x)));
  assert.ok(e.some((x) => /falta el valor/.test(x)));
  assert.deepEqual(revisar({ pasos: flujo() }), []);
});
