/* El período, el sueldo de la semana y los adelantos de UN mensajero, leyendo solo lo suyo (calculosDeMensajero),
   tienen que dar exactamente lo mismo que cargando todo el sistema (calculosDe). Es la red de seguridad para
   que liquidar y "Mi caja" lean menos sin tocar ninguna regla de saldos. */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { pool, reiniciarBase } from "./ayuda.js";
import { generarDatos } from "./generador.js";
import { MODELOS } from "../models/documentos.js";
import { calculosDe, calculosDeMensajero } from "../servicios/contexto.js";
import { tipoDe } from "../helpers/calculos.js";
import { moverDia, hoy, semanaDe, moverSemana } from "../helpers/fechas.js";

before(reiniciarBase);
after(() => pool.end());

/** Guarda S en la base con los modelos (lo que no cabe en el esquema queda como lo dejaría la importación). */
async function guardarEstado(S) {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    for (const col of ["clientes", "mensajeros", "cuentas", "usuarios", "pedidos", "movimientos", "recaudos", "liquidaciones", "cajamovs", "jornadas"]) {
      for (const d of Object.values(S[col])) {
        const doc = col === "usuarios" ? { ...d, email: d.email || d.uid + "@sin-correo.test" } : d;
        await MODELOS[col].guardar(c, doc);
      }
    }
    await c.query("COMMIT");
  } catch (e) { await c.query("ROLLBACK"); throw e; } finally { c.release(); }
}


const r = x => JSON.parse(JSON.stringify(x, (k, v) => (typeof v === "number" ? Math.round(v * 100) / 100 : v)));
const periodo = (calc, m) => { const p = calc.periodoMensajero(m); return { ...p, ul: p.ul?.id, ps: p.ps.map(y => y.guia), recs: p.recs.map(y => y.id), bases: p.bases.map(y => y.id), cobrosCli: p.cobrosCli.map(y => y.id) }; };
const sueldo = (calc, m, sem) => { const y = calc.sueldoPersonaSemana(m, sem); return { ...y, adelantos: y.adelantos.map(c => c.id).sort(), pagos: y.pagos.map(c => c.id).sort() }; }; // sin ORDER BY, la base no promete el orden de los empates

test("calculosDeMensajero da lo mismo que calculosDe para el período y el sueldo de cada persona", async () => {
  for (const semilla of [7, 21, 1234]) {
    await reiniciarBase();
    const S = generarDatos(semilla);
    for (const p of Object.values(S.pedidos)) if (p.valorCobrado < 0) p.valorCobrado = 0;
    // Un día sin el descuento de $ 25.000 para el primer mensajero normal (la regla lee jornadas de esa persona).
    const mens = Object.values(S.mensajeros).find(m => tipoDe(m) === "mensajero");
    if (mens) S.jornadas[mens.id + "_sindesc_" + moverDia(hoy(), -1)] = { id: mens.id + "_sindesc_" + moverDia(hoy(), -1), personaId: mens.id, dia: moverDia(hoy(), -1), valor: 0, sinDescuento: true };
    await guardarEstado(JSON.parse(JSON.stringify(S)));
    const completo = await calculosDe(pool), mids = Object.keys(S.mensajeros), h = hoy();
    const semanas = [0, 1, 2, 3, 5].map(i => moverSemana(semanaDe(h), -i)), dias = [...Array(10)].map((_, i) => moverDia(h, -i));
    const cliente = await pool.connect(); // también dentro de una transacción (así lo usa liquidar)
    try {
      await cliente.query("BEGIN");
      for (const c of [pool, cliente]) for (const m of mids) {
        const solo = await calculosDeMensajero(c, m);
        const que = `${m} (${tipoDe(S.mensajeros[m])}, semilla ${semilla})`;
        assert.deepEqual(r(periodo(solo, m)), r(periodo(completo, m)), "período de " + que);
        for (const sem of semanas) assert.deepEqual(r(sueldo(solo, m, sem)), r(sueldo(completo, m, sem)), `sueldo ${sem} de ` + que);
        for (const d of dias) assert.equal(solo.sinDescuento(m, d), completo.sinDescuento(m, d), `sinDescuento ${d} de ` + que);
        assert.deepEqual(solo.semanasAdelanto(), completo.semanasAdelanto());
        const enRuta = x => Object.values(x.S.pedidos).filter(p => p.estado === "pendiente" && p.mensajeroId === m).length;
        assert.equal(enRuta(solo), enRuta(completo), "en ruta de " + que);
      }
      await cliente.query("COMMIT");
    } finally { cliente.release(); }
  }
});
