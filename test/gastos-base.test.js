/* Los gastos de caja salen de la Base de JS: POST /api/caja/movimientos con cat "gasto" guarda cuentaId = la cuenta de
   tipo "base", que baja su "Base actual" y lo lista en sus movimientos. La caja por medio no cambia. */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { pool, reiniciarBase, crearCuenta, sesion } from "./ayuda.js";

let admin, asistente, mensajero;
const mov = datos => admin.post("/api/caja/movimientos").send({ tipo: "sale", medio: "efectivo", fecha: new Date().toISOString(), ...datos });
const cuentas = async () => (await admin.get("/api/cuentas")).body.cuentas;
const base = async () => (await cuentas()).find(c => c.tipo === "base");

before(async () => {
  await reiniciarBase();
  await crearCuenta({ email: "admin@js.co", rol: "admin" });
  await crearCuenta({ email: "asis@js.co", rol: "asistente" });
  admin = await sesion("admin@js.co");
  asistente = await sesion("asis@js.co");
  const m1 = (await admin.post("/api/mensajeros").send({ nombre: "Carlos" })).body.mensajero;
  await crearCuenta({ email: "carlos@js.co", rol: "mensajero", mensajeroId: m1.id });
  mensajero = await sesion("carlos@js.co");
  // Plata en la caja para poder sacar
  assert.equal((await admin.post("/api/caja/movimientos").send({ tipo: "entra", cat: "otro_entra", valor: 500000, medio: "efectivo", fecha: new Date().toISOString() })).status, 201);
});
after(() => pool.end());

test("sin ninguna cuenta de tipo base, el gasto se guarda como antes, sin cuentaId", async () => {
  const r = await mov({ cat: "gasto", valor: 7000, concepto: "Agua" });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.movimiento.cuentaId, undefined);
  assert.equal((await pool.query("SELECT cuenta_id FROM cajamovs WHERE id = $1", [r.body.movimiento.id])).rows[0].cuenta_id, null);
});

test("con las cuentas iniciales, el gasto queda cargado a la Base de JS y baja su Base actual", async () => {
  assert.equal((await admin.post("/api/cuentas/iniciales")).status, 201);
  const antes = await base();
  assert.equal(antes.nombre, "Base de JS");
  const r = await mov({ cat: "gasto", valor: 80000, concepto: "LUZ" });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.movimiento.cat, "gasto");
  assert.equal(r.body.movimiento.cuentaId, antes.id);
  const despues = await base();
  assert.equal(despues.estado.txt, "Base actual");
  assert.equal(despues.estado.valor, antes.estado.valor - 80000);
  assert.ok(despues.movimientos.some(m => m.id === r.body.movimiento.id && m.cat === "gasto"));
  // Las cuentas de socios no cambian
  for (const c of (await cuentas()).filter(x => x.tipo !== "base")) assert.equal(c.saldo, 0);
});

test("arriendo y otro no llevan cuentaId ni cambian la Base de JS; el gasto viejo sin cuentaId tampoco", async () => {
  const antes = await base();
  for (const cat of ["arriendo", "otro"]) {
    const r = await mov({ cat, valor: 30000, concepto: cat });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.movimiento.cuentaId, undefined, cat);
  }
  const despues = await base();
  assert.equal(despues.saldo, antes.saldo);
  assert.equal(despues.movimientos.length, antes.movimientos.length);
  assert.ok(!despues.movimientos.some(m => m.concepto === "Agua"), "el gasto de antes de tener cuenta base no entra");
});

test("la caja por medio es la misma que si el gasto no tuviera cuentaId", async () => {
  const r = await mov({ cat: "gasto", valor: 15000, medio: "nequi", concepto: "Papelería" });
  assert.equal(r.status, 201);
  const con = (await admin.get("/api/caja/resumen")).body;
  await pool.query("UPDATE cajamovs SET cuenta_id = NULL WHERE cat = 'gasto'");
  const sin = (await admin.get("/api/caja/resumen")).body;
  for (const k of ["porMedio", "total", "disponible", "porPagar", "porCobrar"]) assert.deepEqual(con[k], sin[k], k);
  assert.ok(con.porMedio.nequi < 0); // el gasto sí salió de la caja
});

test("sincronizar: el asistente ve los gastos (la Base de JS completa) y el mensajero no", async () => {
  const r = await mov({ cat: "gasto", valor: 5000, concepto: "Bolsas" });
  const a = (await asistente.get("/api/sincronizar")).body.datos;
  assert.ok(a.cajamovs[r.body.movimiento.id], "el asistente recibe el gasto");
  assert.ok(Object.values(a.cajamovs).filter(c => c.cat === "gasto").length >= 4);
  assert.ok(!Object.values(a.cajamovs).some(c => c.cat === "arriendo" || c.cat === "otro"), "las demás salidas siguen sin verse");
  const m = (await mensajero.get("/api/sincronizar")).body.datos;
  assert.ok(!Object.values(m.cajamovs || {}).some(c => c.cat === "gasto"));
});
