/* GET /cuentas/resumen: las cifras de Cuentas → Cuentas (total en caja, por medio, disponible de JS) y el saldo de cada cuenta
   interna, iguales a los cálculos completos; la Base de JS cuenta los gastos cargados a ella. Oficina sí, mensajero no. */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { pool, reiniciarBase, crearCuenta, sesion } from "./ayuda.js";
import { calculosDe } from "../servicios/contexto.js";

let admin, asistente, mensajero;
const mov = datos => admin.post("/api/caja/movimientos").send({ medio: "efectivo", fecha: new Date().toISOString(), ...datos });

before(async () => {
  await reiniciarBase();
  await crearCuenta({ email: "admin@js.co", rol: "admin" });
  await crearCuenta({ email: "asis@js.co", rol: "asistente" });
  admin = await sesion("admin@js.co");
  asistente = await sesion("asis@js.co");
  const m1 = (await admin.post("/api/mensajeros").send({ nombre: "Carlos" })).body.mensajero;
  await crearCuenta({ email: "carlos@js.co", rol: "mensajero", mensajeroId: m1.id });
  mensajero = await sesion("carlos@js.co");
  assert.equal((await admin.post("/api/cuentas/iniciales")).status, 201);
  const cuentas = (await admin.get("/api/cuentas")).body.cuentas, id = n => cuentas.find(c => c.nombre.startsWith(n)).id;
  for (const d of [
    { tipo: "entra", cat: "otro_entra", valor: 500000 },
    { tipo: "entra", cat: "otro_entra", valor: 80000, medio: "nequi" },
    { tipo: "sale", cat: "interna", cuentaId: id("JS Envíos"), valor: 120000, concepto: "préstamo" },
    { tipo: "entra", cat: "interna", cuentaId: id("JS Envíos"), valor: 20000, concepto: "abono", medio: "bancolombia" },
    { tipo: "entra", cat: "interna", cuentaId: id("Base de JS"), valor: 300000, concepto: "base inicial" },
    { tipo: "sale", cat: "gasto", valor: 45000, concepto: "gasolina" } // se carga a la Base de JS
  ]) assert.equal((await mov(d)).status, 201, JSON.stringify(d));
});
after(() => pool.end());

test("da las mismas cifras y saldos que los cálculos completos", async () => {
  const r = await asistente.get("/api/cuentas/resumen");
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const calc = await calculosDe(pool), R = calc.resumenCaja();
  const x = r.body.resumen;
  assert.equal(x.total, R.total);
  assert.equal(x.disponible, R.disponible);
  assert.deepEqual(x.porMedio, R.porMedio);
  assert.equal(x.cuentas.length, 3);
  for (const cu of x.cuentas) assert.equal(cu.saldo, calc.saldoCuenta(cu.id), cu.nombre);
  // La Base de JS: entraron 300.000 a la caja desde la base (base de −300.000) y el gasto de 45.000 salió de ella.
  const base = x.cuentas.find(c => c.tipo === "base");
  assert.deepEqual(base.estado, { txt: "Base actual", valor: 300000 - 45000 });
  const js = x.cuentas.find(c => c.nombre.startsWith("JS Envíos"));
  assert.deepEqual(js.estado, { txt: "Te debe", valor: 100000 });
  // Lo mismo que GET /cuentas (la lista de la pestaña)
  const lista = (await admin.get("/api/cuentas")).body.cuentas;
  for (const cu of lista) assert.equal(x.cuentas.find(c => c.id === cu.id).saldo, cu.saldo);
});

test("el mensajero no puede verlo", async () => {
  const r = await mensajero.get("/api/cuentas/resumen");
  assert.equal(r.status, 403);
});
