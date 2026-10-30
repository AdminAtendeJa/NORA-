// Ejecutar: node --experimental-strip-types --no-warnings --test motor.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { avanzar, estadoInicial, validar, evaluar, revisar, interpolar, elegirBoton, definicionVacia } from './motor.ts';

// Constructor de grafos para los tests: nodo(id, tipo, datos) y conectar(de, puerto, a)
const nodo = (id, tipo, datos = {}) => ({ id, tipo, x: 0, y: 0, ...datos });
const grafo = (nodos, conexiones) => ({
  version: 2,
  nodos: [nodo('inicio', 'inicio'), ...nodos],
  aristas: conexiones.map(([de, puerto, a], i) => ({ id: `e${i}`, de, puerto, a })),
});
const textos = (r) => r.acciones.filter((a) => a.tipo === 'enviar').map((a) => a.texto);
const tipos = (r) => r.acciones.map((a) => a.tipo);
const t0 = new Date('2026-10-30T10:00:00Z');
const mas = (min) => new Date(t0.getTime() + min * 60_000);

// Flujo tipo Kommo: saludo con botones; cada botón lleva a un camino distinto
const bienvenida = () => grafo([
  nodo('m1', 'mensaje', { texto: 'Hola {{nombre}}, ¿en qué te ayudo?', timeoutMin: 30, botones: [
    { titulo: 'Producto', sinonimos: ['catalogo', 'precios'] }, { titulo: 'Mi pedido' }, { titulo: 'Hablar con alguien' }] }),
  nodo('m2', 'mensaje', { texto: '¿Qué producto te interesa?' }),
  nodo('m3', 'mensaje', { texto: 'Pásame tu número de pedido.' }),
  nodo('h', 'humano', { motivo: 'Pidió una persona' }),
  nodo('f', 'fin'),
  nodo('t', 'etiquetar', { etiqueta: 'sin respuesta' }),
  nodo('n', 'nora'),
], [['inicio', 'next', 'm1'], ['m1', 'btn:0', 'm2'], ['m1', 'btn:1', 'm3'], ['m1', 'btn:2', 'h'], ['m1', 'otra', 'n'], ['m1', 'timeout', 't'],
    ['m2', 'next', 'f'], ['m3', 'next', 'f'], ['t', 'next', 'f']]);

test('arranca: saluda con el nombre, ofrece los botones y se queda esperando', () => {
  const def = bienvenida();
  const r = avanzar(def, estadoInicial(def, { nombre: 'Ana' }), null, t0);
  assert.deepEqual(r.acciones, [{ tipo: 'enviar', texto: 'Hola Ana, ¿en qué te ayudo?', botones: ['Producto', 'Mi pedido', 'Hablar con alguien'] }]);
  assert.equal(r.estado.esperando.tipo, 'respuesta');
  assert.equal(r.estado.esperando.nodo, 'm1');
  assert.equal(r.estado.esperando.vence, mas(30).toISOString());
});

test('botón pulsado: sigue por su camino y termina', () => {
  const def = bienvenida();
  let r = avanzar(def, estadoInicial(def), null, t0);
  r = avanzar(def, r.estado, 'Mi pedido', t0);
  assert.deepEqual(textos(r), ['Pásame tu número de pedido.']);
  assert.equal(r.estado.fin, 'completado');
});

test('botón por su número, por sinónimo y por palabra dentro de una frase', () => {
  const def = bienvenida();
  const empieza = () => avanzar(def, estadoInicial(def), null, t0).estado;
  assert.deepEqual(textos(avanzar(def, empieza(), '1', t0)), ['¿Qué producto te interesa?']);
  assert.deepEqual(textos(avanzar(def, empieza(), 'quiero ver el catálogo', t0)), ['¿Qué producto te interesa?']);
  assert.deepEqual(textos(avanzar(def, empieza(), 'PRECIOS por favor', t0)), ['¿Qué producto te interesa?']);
  const r = avanzar(def, empieza(), 'hablar con alguien', t0);
  assert.equal(r.estado.fin, 'humano');
  assert.deepEqual(tipos(r), ['humano']);
});

test('«otra respuesta»: si escribe algo que no es un botón, sigue por esa salida (aquí entrega a Nora)', () => {
  const def = bienvenida();
  let r = avanzar(def, estadoInicial(def), null, t0);
  r = avanzar(def, r.estado, 'tengo una duda rara sobre garantías', t0);
  assert.equal(r.estado.fin, 'nora');
});

test('«sin respuesta»: si pasa el tiempo, sigue por la salida de tiempo; antes de tiempo no hace nada', () => {
  const def = bienvenida();
  const r0 = avanzar(def, estadoInicial(def), null, t0);
  const antes = avanzar(def, r0.estado, null, mas(10));
  assert.deepEqual(antes.acciones, []);
  assert.deepEqual(antes.estado, r0.estado);
  const despues = avanzar(def, r0.estado, null, mas(31));
  assert.deepEqual(tipos(despues), ['etiquetar']);
  assert.equal(despues.estado.fin, 'completado');
});

test('sin salida «sin respuesta» conectada no se programa ningún tiempo límite', () => {
  const def = grafo([nodo('m', 'mensaje', { texto: 'Hola', botones: [{ titulo: 'Sí' }], timeoutMin: 30 })], [['inicio', 'next', 'm']]);
  assert.equal(avanzar(def, estadoInicial(def), null, t0).estado.esperando.vence, undefined);
});

test('botones sin salida «otra»: pide elegir y tras 3 intentos pasa a una persona', () => {
  const def = grafo([nodo('m', 'mensaje', { texto: 'Elige', botones: [{ titulo: 'A' }, { titulo: 'B' }] }), nodo('f', 'fin')],
    [['inicio', 'next', 'm'], ['m', 'btn:0', 'f'], ['m', 'btn:1', 'f']]);
  let r = avanzar(def, estadoInicial(def), null, t0);
  r = avanzar(def, r.estado, 'no sé', t0);
  assert.match(textos(r)[0], /Elige una de las opciones/);
  assert.deepEqual(r.acciones[0].botones, ['A', 'B']);
  r = avanzar(def, r.estado, 'mmm', t0);
  r = avanzar(def, r.estado, 'jaja', t0);
  assert.equal(r.estado.fin, 'humano');
});

test('mensaje sin botones continúa solo; con «esperar respuesta» espera cualquier texto', () => {
  const def = grafo([nodo('a', 'mensaje', { texto: 'Uno' }), nodo('b', 'mensaje', { texto: 'Dos', espera: true }), nodo('c', 'mensaje', { texto: 'Tres' })],
    [['inicio', 'next', 'a'], ['a', 'next', 'b'], ['b', 'otra', 'c']]);
  let r = avanzar(def, estadoInicial(def), null, t0);
  assert.deepEqual(textos(r), ['Uno', 'Dos']);
  assert.equal(r.estado.esperando.nodo, 'b');
  r = avanzar(def, r.estado, 'lo que sea', t0);
  assert.deepEqual(textos(r), ['Tres']);
  assert.equal(r.estado.fin, 'completado');
});

test('pregunta + condición: guarda el dato y elige la rama', () => {
  const def = grafo([
    nodo('p', 'pregunta', { texto: '¿Presupuesto en USD?', campo: 'presupuesto', validacion: 'numero' }),
    nodo('c', 'condicion', { campo: 'presupuesto', op: 'mayor', valor: '500' }),
    nodo('e1', 'etiquetar', { etiqueta: 'caliente' }), nodo('h', 'humano', { motivo: 'Lead caliente' }),
    nodo('e2', 'etapa', { etapa: 'interesado' }), nodo('n', 'nora'),
  ], [['inicio', 'next', 'p'], ['p', 'next', 'c'], ['c', 'si', 'e1'], ['e1', 'next', 'h'], ['c', 'no', 'e2'], ['e2', 'next', 'n']]);
  let r = avanzar(def, estadoInicial(def), null, t0);
  const alto = avanzar(def, r.estado, 'unos $1.200 al mes', t0);
  assert.equal(alto.estado.datos.presupuesto, '1200');
  assert.deepEqual(tipos(alto), ['guardar', 'etiquetar', 'humano']);
  assert.equal(alto.estado.fin, 'humano');
  const bajo = avanzar(def, r.estado, '300', t0);
  assert.deepEqual(tipos(bajo), ['guardar', 'etapa']);
  assert.equal(bajo.estado.fin, 'nora');
});

test('pregunta: respuesta inválida repite; al tercer fallo va a «otra» si existe, y si no, a una persona', () => {
  const base = (conOtra) => grafo([nodo('p', 'pregunta', { texto: '¿Cuánto?', campo: 'monto', validacion: 'numero' }), nodo('x', 'etiquetar', { etiqueta: 'raro' })],
    [['inicio', 'next', 'p'], ...(conOtra ? [['p', 'otra', 'x']] : [])]);
  for (const conOtra of [true, false]) {
    const def = base(conOtra);
    let r = avanzar(def, estadoInicial(def), null, t0);
    r = avanzar(def, r.estado, 'no sé', t0);
    assert.match(textos(r)[0], /No te entendí/);
    r = avanzar(def, r.estado, 'mmm', t0);
    r = avanzar(def, r.estado, 'jaja', t0);
    assert.equal(r.estado.fin, conOtra ? 'completado' : 'humano');
    assert.equal(tipos(r)[0], conOtra ? 'etiquetar' : 'humano');
  }
});

test('esperar: pausa, no avanza antes de tiempo y continúa al vencer', () => {
  const def = grafo([nodo('a', 'mensaje', { texto: 'Hola' }), nodo('e', 'esperar', { minutos: 30 }), nodo('b', 'mensaje', { texto: '¿Sigues ahí?' })],
    [['inicio', 'next', 'a'], ['a', 'next', 'e'], ['e', 'next', 'b']]);
  let r = avanzar(def, estadoInicial(def), null, t0);
  assert.deepEqual(textos(r), ['Hola']);
  assert.equal(r.estado.esperando.hasta, mas(30).toISOString());
  assert.deepEqual(avanzar(def, r.estado, null, mas(10)).acciones, []);
  const despues = avanzar(def, r.estado, null, mas(31));
  assert.deepEqual(textos(despues), ['¿Sigues ahí?']);
  assert.equal(despues.estado.fin, 'completado');
});

test('un ciclo sin esperas no entra en bucle infinito; un ciclo con pregunta sí puede repetirse', () => {
  const ciclo = grafo([nodo('a', 'etiquetar', { etiqueta: 'x' })], [['inicio', 'next', 'a'], ['a', 'next', 'a']]);
  assert.equal(avanzar(ciclo, estadoInicial(ciclo), null, t0).estado.fin, 'completado');
  const vuelve = grafo([nodo('m', 'mensaje', { texto: '¿Otra vez?', botones: [{ titulo: 'Sí' }, { titulo: 'No' }] }), nodo('f', 'fin')],
    [['inicio', 'next', 'm'], ['m', 'btn:0', 'm'], ['m', 'btn:1', 'f']]);
  let r = avanzar(vuelve, estadoInicial(vuelve), null, t0);
  r = avanzar(vuelve, r.estado, 'sí', t0);
  assert.equal(r.estado.esperando.nodo, 'm');
  r = avanzar(vuelve, r.estado, 'no', t0);
  assert.equal(r.estado.fin, 'completado');
});

test('conexión faltante: el flujo simplemente termina', () => {
  const def = grafo([nodo('a', 'mensaje', { texto: 'Hola' })], [['inicio', 'next', 'a']]);
  const r = avanzar(def, estadoInicial(def), null, t0);
  assert.deepEqual(textos(r), ['Hola']);
  assert.equal(r.estado.fin, 'completado');
});

test('validar: números, sí/no y opciones', () => {
  assert.deepEqual(validar('1.500', 'numero'), { ok: true, valor: '1500' });
  assert.deepEqual(validar('12,5', 'numero'), { ok: true, valor: '12.5' });
  assert.deepEqual(validar('R$ 300 por mes', 'numero'), { ok: true, valor: '300' });
  assert.equal(validar('mucho', 'numero').ok, false);
  assert.deepEqual(validar('Sí, claro', 'si_no'), { ok: true, valor: 'si' });
  assert.deepEqual(validar('Não', 'si_no'), { ok: true, valor: 'no' });
  assert.deepEqual(validar('2', 'opciones', ['Comprar', 'Alquilar']), { ok: true, valor: 'Alquilar' });
  assert.equal(validar('   ', 'texto').ok, false);
});

test('elegirBoton y evaluar', () => {
  const bs = [{ titulo: 'Comprar', sinonimos: ['adquirir'] }, { titulo: 'Alquilar' }];
  assert.equal(elegirBoton('2', bs), 1);
  assert.equal(elegirBoton('Quiero adquirir una casa', bs), 0);
  assert.equal(elegirBoton('nada que ver', bs), -1);
  assert.equal(evaluar({ campo: 'a', op: 'existe' }, {}), false);
  assert.equal(evaluar({ campo: 'a', op: 'contiene', valor: 'ola' }, { a: 'HOLA' }), true);
  assert.equal(evaluar({ campo: 'a', op: 'menor', valor: '10' }, { a: '5' }), true);
  assert.equal(evaluar({ campo: 'a', op: 'distinto', valor: 'x' }, {}), true);
  assert.equal(interpolar('Hola {{nombre}}{{apellido}}!', { nombre: 'Ana' }), 'Hola Ana!');
});

test('revisar: errores que bloquean y avisos que no', () => {
  const vacio = revisar(definicionVacia());
  assert.deepEqual(vacio.errores, ['El flujo no tiene pasos']);
  assert.deepEqual(revisar(bienvenida()), { errores: [], avisos: [] });

  const malo = grafo([
    nodo('a', 'mensaje', { texto: '', botones: [] }),
    nodo('b', 'pregunta', { texto: '¿Y?', campo: 'Mal Nombre', validacion: 'texto' }),
    nodo('c', 'mensaje', { texto: 'x', botones: [{ titulo: 'Un título larguísimo de más de veinte' }] }),
    nodo('d', 'mensaje', { texto: 'x', botones: [{ titulo: 'Sí' }, { titulo: 'sí' }] }),
    nodo('e', 'condicion', { campo: '', op: 'igual' }),
    nodo('suelto', 'etiquetar', { etiqueta: 'x' }),
  ], [['a', 'next', 'b']]);
  const r = revisar(malo);
  for (const parte of [/Conecta el inicio/, /mensaje está vacío/, /necesita un nombre/, /máximo 20 caracteres/, /repetidos/, /elige qué dato/])
    assert.ok(r.errores.some((x) => parte.test(x)), String(parte));
  assert.ok(r.avisos.some((x) => /no está conectado/.test(x)));
  const roto = grafo([nodo('a', 'fin')], [['inicio', 'next', 'a'], ['a', 'next', 'no_existe']]);
  assert.ok(revisar(roto).errores.some((x) => /no existe/.test(x)));
});

test('revisar: un botón sin texto bloquea, y los pasos se nombran con su número estable', () => {
  const def = grafo([nodo('a', 'mensaje', { n: 7, texto: 'Hola', botones: [{ titulo: 'Sí' }, { titulo: '  ' }] })], [['inicio', 'next', 'a']]);
  assert.ok(revisar(def).errores.some((x) => /Paso 7: hay un botón sin texto/.test(x)));
});
