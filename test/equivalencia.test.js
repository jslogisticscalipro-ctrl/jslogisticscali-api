/* Prueba de equivalencia: ejecuta el app/js/app.js ORIGINAL (el que está en producción) en una máquina virtual
   con un navegador falso, le carga los mismos datos que al servidor y compara resultado por resultado:
   saldos, períodos de mensajeros, libro y resumen de caja, cajas de oficina, arqueos, sueldos, cuadres y repetidos.
   Si alguien cambia la lógica en un lado y no en el otro, esta prueba falla. */
process.env.TZ = "America/Bogota"; // la app usa la hora del equipo; en la oficina es la de Colombia

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import vm from "node:vm";
import { generarDatos } from "./generador.js";
import { crearCalculos, resultadoArqueo, netoArqueo, sueldoPedidos, diaSueldo } from "../helpers/calculos.js";
import { DESC_SUELDO } from "../helpers/constantes.js";
import { diasSemana, moverDia, hoy, semanaDe, moverSemana } from "../helpers/fechas.js";

const RUTA_APP = new URL("../../app/js/app.js", import.meta.url);

function cargarAppOriginal() {
  const nada = new Proxy(function () {}, {
    get: (t, k) => (k === Symbol.toPrimitive ? () => "" : k === Symbol.iterator ? function* () {} : k === "then" ? undefined : k === "length" ? 0 : nada),
    apply: () => nada, construct: () => nada, set: () => true, has: () => true
  });
  const ctx = vm.createContext({
    document: nada, navigator: { onLine: true }, localStorage: { getItem: () => null, setItem() {} }, location: { reload() {} },
    addEventListener() {}, setInterval() {}, setTimeout() {}, clearTimeout() {}, scrollTo() {}, console, URL, Blob: function () {}, Image: function () {}
  });
  ctx.window = ctx;
  vm.runInContext(readFileSync(RUTA_APP, "utf8"), ctx, { filename: "app.js" });
  return ctx;
}

const esSinDesc = k => k.includes("_sindesc_");
function sinJornadasSinDesc(S) { for (const k of Object.keys(S.jornadas)) if (esSinDesc(k)) delete S.jornadas[k]; return S; }

const r = x => JSON.parse(JSON.stringify(x, (k, v) => (typeof v === "number" ? Math.round(v * 100) / 100 : v)));

test("los cálculos del servidor dan exactamente lo mismo que app/js/app.js", { skip: !existsSync(RUTA_APP) && "no se encontró app/js/app.js" }, () => {
  for (const semilla of [7, 21, 1234]) {
    // El app/js/app.js de este repositorio todavía no tiene "un día sin el descuento de $ 25.000": a los dos lados se les
    // quitan esas jornadas y se comparan; el efecto de la excepción se compara aparte, en la prueba de abajo.
    const datos = sinJornadasSinDesc(generarDatos(semilla));
    const ctx = cargarAppOriginal();
    ctx.__datos = JSON.stringify(datos);
    vm.runInContext(`{ const d = JSON.parse(__datos); for (const k of Object.keys(S)) { S[k] = {}; Object.assign(S[k], d[k] || {}); } }`, ctx);
    const app = code => r(vm.runInContext(code, ctx));
    const srv = crearCalculos(JSON.parse(JSON.stringify(datos)), { corteRemoto: 0 });
    const cids = Object.keys(datos.clientes), mids = Object.keys(datos.mensajeros), h = hoy();
    const dias = [...Array(12)].map((_, i) => moverDia(h, -i * 3));
    const semanas = [0, 1, 2, 3, 5].map(i => moverSemana(semanaDe(h), -i));

    const casos = {
      saldoCliente: [`Object.keys(S.clientes).map(saldoCliente)`, cids.map(srv.saldoCliente)],
      filasCuenta: [`Object.keys(S.clientes).map(filasCuenta)`, cids.map(srv.filasCuenta)],
      periodoMensajero: [`Object.keys(S.mensajeros).map(m=>{const p=periodoMensajero(m);return {...p,ps:p.ps.map(x=>x.guia),recs:p.recs.map(x=>x.id),bases:p.bases.map(x=>x.id)}})`,
        // cobros y cobrosCli (pagos de clientes que recibió el mensajero) no existen en la app vieja: se comparan aparte en dinero.test.js.
        mids.map(m => { const { cobros, cobrosCli, ...p } = srv.periodoMensajero(m); return { ...p, ps: p.ps.map(x => x.guia), recs: p.recs.map(x => x.id), bases: p.bases.map(x => x.id) }; })],
      libroCaja: [`libroCaja()`, srv.libroCaja()],
      resumenCaja: [`(({L,...x})=>x)(resumenCaja())`, (({ L, ...x }) => x)(srv.resumenCaja())],
      cajaOficina: [`["a1","a2","ad"].map(cajaOficina)`, ["a1", "a2", "ad"].map(srv.cajaOficina)],
      esperadoArqueo: [`esperadoArqueo()`, srv.esperadoArqueo()],
      corteCaja: [`corteCaja()`, srv.corteCaja()],
      sueldosDia: [`${JSON.stringify(dias)}.map(sueldosDia)`, dias.map(srv.sueldosDia)],
      resumenSemana: [`${JSON.stringify(semanas)}.map(s=>{const x=resumenSemana(s);return {...x,filas:x.filas.map(f=>({...f,m:f.m.id,adelantos:f.adelantos.map(c=>c.id)}))}})`,
        semanas.map(s => { const x = srv.resumenSemana(s); return { ...x, filas: x.filas.map(f => ({ ...f, m: f.m.id, adelantos: f.adelantos.map(c => c.id) })) }; })],
      sueldoPersonaSemana: [`${JSON.stringify(semanas)}.flatMap(s=>Object.keys(S.mensajeros).map(m=>{const x=sueldoPersonaSemana(m,s);return {...x,adelantos:x.adelantos.map(c=>c.id),pagos:x.pagos.map(c=>c.id)}}))`,
        semanas.flatMap(s => mids.map(m => { const x = srv.sueldoPersonaSemana(m, s); return { ...x, adelantos: x.adelantos.map(c => c.id), pagos: x.pagos.map(c => c.id) }; }))],
      pendienteAnterior: [`Object.keys(S.mensajeros).map(m=>pendienteAnterior(m,semanaDe(hoy())).map(x=>[x.sem,x.neto]))`, mids.map(m => srv.pendienteAnterior(m, semanaDe(h)).map(x => [x.sem, x.neto]))],
      cuadreDia: [`${JSON.stringify(dias)}.map(cuadreDia)`, dias.map(srv.cuadreDia)],
      gruposRepetidos: [`gruposRepetidos().map(g=>g.map(c=>c.id))`, srv.gruposRepetidos().map(g => g.map(c => c.id))],
      parecidos: [`parecidos("Tienda Luna","3110000000").map(d=>[d.c.id,d.igual])`, srv.parecidos("Tienda Luna", "3110000000").map(d => [d.c.id, d.igual])],
      pendientesCierre: [`(x=>({mens:x.mens.map(y=>[y.m.id,y.debe]),ofis:x.ofis.map(y=>[y.u.uid,y.s]),sinRem:x.sinRem.length,sinServ:x.sinServ.length,enRuta:x.enRuta.length,arqueoHoy:x.arqueoHoy}))(pendientesCierre())`,
        (x => ({ mens: x.mens.map(y => [y.m.id, y.debe]), ofis: x.ofis.map(y => [y.u.uid, y.s]), sinRem: x.sinRem.length, sinServ: x.sinServ.length, enRuta: x.enRuta.length, arqueoHoy: x.arqueoHoy }))(srv.pendientesCierre())],
      sueldoPeriodo: [`Object.keys(S.mensajeros).map(m=>sueldoPedidos(periodoMensajero(m).ps))`, mids.map(m => sueldoPedidos(srv.periodoMensajero(m).ps, srv.sinDescuento))],
      saldoCuenta: [`["cu1","cu2","cu3"].map(saldoCuenta)`, ["cu1", "cu2", "cu3"].map(srv.saldoCuenta)],
      yaContado: [`[Date.now(), Date.now()-3*864e5, Date.now()-20*864e5].map(yaContado)`, [Date.now(), Date.now() - 3 * 864e5, Date.now() - 20 * 864e5].map(srv.yaContado)],
      semanasAdelanto: [`semanasAdelanto().map(x=>x[0])`, srv.semanasAdelanto().map(x => x[0])],
      diasSemana: [`diasSemana(semanaDe(hoy()))`, diasSemana(semanaDe(h))]
    };
    casos.resultadoArqueo = [`arqueosCaja().map(a=>[a.id,resultadoArqueo(a),netoArqueo(a)])`, srv.arqueosCaja().map(a => [a.id, resultadoArqueo(a), netoArqueo(a)])];

    for (const [nombre, [codigoApp, valorSrv]] of Object.entries(casos)) {
      assert.deepEqual(r(valorSrv), app(codigoApp), `${nombre} no coincide con la app (semilla ${semilla})`);
    }
  }
});


/* Un día sin el descuento de $ 25.000 (app.js de referencia: commit 3c89cb6 del repositorio de la app). Como el app/js/app.js
   de aquí no lo trae, se compara el servidor con las jornadas "sindesc" contra la app sin ellas: la única diferencia debe
   ser que, cada día marcado en que el mensajero tuvo entregas, él gana $ 25.000 más y el dueño $ 25.000 menos. */
test("un día sin descuento: el mensajero gana el 70 % completo y el dueño deja de sumar esos $ 25.000", { skip: !existsSync(RUTA_APP) && "no se encontró app/js/app.js" }, () => {
  let marcadosConEntregas = 0, marcadosSinEntregas = 0, conPeriodo = 0;
  for (const semilla of [7, 21, 1234]) {
    const datos = generarDatos(semilla);
    const marcas = Object.values(datos.jornadas).filter(j => esSinDesc(j.id));
    assert.ok(marcas.length >= 4, "el generador debe traer jornadas sin descuento");
    const ctx = cargarAppOriginal();
    ctx.__datos = JSON.stringify(sinJornadasSinDesc(JSON.parse(JSON.stringify(datos))));
    vm.runInContext(`{ const d = JSON.parse(__datos); for (const k of Object.keys(S)) { S[k] = {}; Object.assign(S[k], d[k] || {}); } }`, ctx);
    const app = code => r(vm.runInContext(code, ctx));
    const srv = crearCalculos(JSON.parse(JSON.stringify(datos)), { corteRemoto: 0 });
    const dueno = Object.values(datos.mensajeros).find(m => m.tipo === "dueno").id;
    for (const j of marcas) assert.equal(srv.sinDescuento(j.personaId, j.dia), true);

    for (const dia of new Set(marcas.map(j => j.dia))) {
      const a = app(`sueldosDia(${JSON.stringify(dia)})`), s = r(srv.sueldosDia(dia));
      const conEntregas = marcas.filter(j => j.dia === dia && a.res[j.personaId] !== undefined);
      marcadosConEntregas += conEntregas.length; marcadosSinEntregas += marcas.filter(j => j.dia === dia).length - conEntregas.length;
      const n = conEntregas.length, res = { ...a.res };
      for (const j of conEntregas) res[j.personaId] += DESC_SUELDO;
      if (n) res[dueno] -= n * DESC_SUELDO;
      // Un día marcado sin entregas no cambia nada.
      assert.deepEqual(s, { ...a, res, desc: a.desc - n * DESC_SUELDO, nMens: a.nMens - n, javier: a.javier - n * DESC_SUELDO }, `sueldosDia ${dia} (semilla ${semilla})`);
    }
    // Sueldo del período de cada mensajero: $ 25.000 más por cada día marcado del período en que tuvo entregas.
    const mids = Object.keys(datos.mensajeros);
    const appSueldo = app(`Object.keys(S.mensajeros).map(m=>sueldoPedidos(periodoMensajero(m).ps))`);
    const srvSueldo = mids.map(m => sueldoPedidos(srv.periodoMensajero(m).ps, srv.sinDescuento));
    const extra = mids.map(m => { const ds = new Set(srv.periodoMensajero(m).ps.map(diaSueldo)); return marcas.filter(j => j.personaId === m && ds.has(j.dia)).length * DESC_SUELDO; });
    assert.deepEqual(r(srvSueldo), appSueldo.map((x, i) => x + extra[i]), `sueldo del período (semilla ${semilla})`);
    conPeriodo += extra.filter(Boolean).length;
  }
  assert.ok(marcadosConEntregas > 0 && marcadosSinEntregas > 0 && conPeriodo > 0);
});
