/* El arqueo y el cierre de una caja de oficina responden con lo que guardaron (movimientos), para que la app los
   ponga en pantalla sin volver a bajar todo; deshacer el arqueo responde con el corte que queda. */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { pool, reiniciarBase, crearCuenta, sesion } from "./ayuda.js";

let admin, uidAsis;

before(async () => {
  await reiniciarBase();
  await crearCuenta({ email: "admin@js.co", rol: "admin" });
  const a = await crearCuenta({ email: "asis@js.co", rol: "asistente" });
  uidAsis = a.id || a.uid;
  admin = await sesion("admin@js.co");
});
after(() => pool.end());

test("cierre de oficina responde con los movimientos que guardó", async () => {
  assert.ok(uidAsis, "uid del asistente");
  const base = await admin.post(`/api/caja/oficinas/${uidAsis}/base`).send({ valor: 20000 });
  assert.equal(base.status, 201, JSON.stringify(base.body));
  // Entrega 25.000 teniendo 20.000: 5.000 de más en efectivo son sobrante
  const r = await admin.post(`/api/caja/oficinas/${uidAsis}/cierre`).send({ efectivo: 25000, nequi: 0, bancolombia: 0, nota: "cierre" });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const movs = r.body.movimientos;
  assert.equal(movs.length, 2);
  assert.deepEqual(movs.map(m => m.cat).sort(), ["oficina", "sobrante"]);
  assert.equal(movs.find(m => m.cat === "sobrante").valor, 5000);
  assert.equal(movs.find(m => m.cat === "oficina").valor, 25000);
  assert.match(movs[0].fecha, /^\d{4}-\d{2}-\d{2}T/);
  // Son los mismos que quedaron en la base
  const lista = (await admin.get("/api/caja/movimientos")).body.movimientos.map(m => m.id);
  for (const m of movs) assert.ok(lista.includes(m.id));
});

test("el arqueo responde con el conteo y sus diferencias; deshacer responde con el corte que queda", async () => {
  const esp = (await admin.get("/api/caja/arqueo/esperado")).body.esperado;
  const contado = { ...esp, efectivo: esp.efectivo - 1000 }; // falta 1.000 en efectivo
  const a = await admin.post("/api/caja/arqueos").send({ contado, nota: "prueba" });
  assert.equal(a.status, 201, JSON.stringify(a.body));
  const { id, movimientos } = a.body.arqueo;
  const marca = movimientos.find(m => m.id === id);
  assert.ok(marca && marca.tipo === "marca", "viene el conteo");
  const dif = movimientos.find(m => m.id !== id);
  assert.equal(dif.valor, 1000);
  assert.equal(dif.tipo, "sale");
  assert.equal(dif.arqueoId, id);
  assert.equal(marca.fecha, a.body.arqueo.fecha);
  const d = await admin.delete(`/api/caja/arqueos/${id}`);
  assert.equal(d.status, 200);
  assert.equal(d.body.corte, null); // no hay arqueo anterior: la caja queda abierta
});
