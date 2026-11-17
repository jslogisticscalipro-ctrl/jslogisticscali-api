/* GET /liquidaciones/:id: la liquidación con sus entregas, el nombre de cada remitente y si es la última (para reabrir). */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { pool, reiniciarBase, crearCuenta, sesion } from "./ayuda.js";

let admin, asistente, mensajero, m1, c1;
const entregar = async (tarifa, cobro) => {
  const g = (await admin.post("/api/pedidos").send({ mensajeroId: m1.id, clienteId: c1.id, valorServicio: tarifa, aCobrar: cobro })).body.pedido.guia;
  const e = await mensajero.post(`/api/pedidos/${g}/entrega`).send({ destinatario: "Ana", valorCobrado: cobro, metodo: "efectivo" });
  assert.equal(e.status, 200, JSON.stringify(e.body));
  return g;
};

before(async () => {
  await reiniciarBase();
  await crearCuenta({ email: "admin@js.co", rol: "admin" });
  await crearCuenta({ email: "asis@js.co", rol: "asistente" });
  admin = await sesion("admin@js.co");
  asistente = await sesion("asis@js.co");
  m1 = (await admin.post("/api/mensajeros").send({ nombre: "Carlos" })).body.mensajero;
  c1 = (await asistente.post("/api/clientes").send({ nombre: "Tienda Uno", telefono: "3001234567", tarifa: 8000 })).body.cliente;
  await crearCuenta({ email: "carlos@js.co", rol: "mensajero", mensajeroId: m1.id });
  mensajero = await sesion("carlos@js.co");
});
after(() => pool.end());

test("el detalle trae las guías de la liquidación, el remitente y si es la última", async () => {
  const g1 = await entregar(8000, 50000), g2 = await entregar(8000, 30000);
  const l1 = (await admin.post("/api/liquidaciones").send({ mensajeroId: m1.id, entregaFinal: 80000, medio: "efectivo" })).body.liquidacion;
  const g3 = await entregar(8000, 20000);
  const l2 = (await admin.post("/api/liquidaciones").send({ mensajeroId: m1.id, entregaFinal: 20000, medio: "efectivo" })).body.liquidacion;

  const d1 = await admin.get(`/api/liquidaciones/${l1.id}`);
  assert.equal(d1.status, 200, JSON.stringify(d1.body));
  assert.equal(d1.body.liquidacion.id, l1.id);
  assert.deepEqual(d1.body.entregas.map(p => p.guia).sort(), [g1, g2].sort());
  assert.equal(d1.body.clientes[c1.id], "Tienda Uno");
  assert.equal(d1.body.esUltima, false);
  assert.match(d1.body.liquidacion.fecha, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(d1.body.entregas[0].creado, /^\d{4}-\d{2}-\d{2}T/);

  const d2 = (await admin.get(`/api/liquidaciones/${l2.id}`)).body;
  assert.deepEqual(d2.entregas.map(p => p.guia), [g3]);
  assert.equal(d2.esUltima, true);
});

test("solo administración la ve y una que no existe responde 404", async () => {
  const l = (await admin.get("/api/liquidaciones")).body.liquidaciones[0];
  assert.equal((await asistente.get(`/api/liquidaciones/${l.id}`)).status, 403);
  assert.equal((await mensajero.get(`/api/liquidaciones/${l.id}`)).status, 403);
  assert.equal((await admin.get("/api/liquidaciones/no-existe")).status, 404);
});
