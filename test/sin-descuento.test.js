/* Un día sin el descuento de $ 25.000 para un mensajero (PUT y DELETE /api/sueldos/sin-descuento/:personaId/:dia):
   ese día gana el 70 % completo y el dueño deja de sumar esos $ 25.000. Solo administración, solo mensajeros y días que ya llegaron. */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { pool, reiniciarBase, crearCuenta, sesion } from "./ayuda.js";
import { hoy, moverDia } from "../helpers/fechas.js";

let admin, asistente, mensajero, m1, dueno, pat;
const dia = hoy();
const ruta = (pid, d = dia) => `/api/sueldos/sin-descuento/${pid}/${d}`;
const delDia = async (pid) => {
  const p = (await admin.get(`/api/sueldos/semana?semana=${dia}`)).body;
  const i = p.dias.indexOf(dia), f = p.filas.find(x => x.persona.id === pid);
  return { sueldo: f.vals[i], sinDescuento: f.sinDescuento[i] };
};

before(async () => {
  await reiniciarBase();
  await crearCuenta({ email: "admin@js.co", rol: "admin" });
  await crearCuenta({ email: "asis@js.co", rol: "asistente" });
  admin = await sesion("admin@js.co");
  asistente = await sesion("asis@js.co");
  m1 = (await admin.post("/api/mensajeros").send({ nombre: "Carlos" })).body.mensajero;
  dueno = (await admin.post("/api/mensajeros").send({ nombre: "Javier", tipo: "dueno" })).body.mensajero;
  pat = (await admin.post("/api/mensajeros").send({ nombre: "Pedro", tipo: "patinador", tarifa: 40000 })).body.mensajero;
  await crearCuenta({ email: "carlos@js.co", rol: "mensajero", mensajeroId: m1.id });
  mensajero = await sesion("carlos@js.co");
  const c1 = (await asistente.post("/api/clientes").send({ nombre: "Tienda Uno", telefono: "3001234567" })).body.cliente;
  // Carlos hizo $ 100.000 de domicilios hoy: normal gana $ 45.000; sin descuento, $ 70.000.
  const guia = (await admin.post("/api/pedidos").send({ mensajeroId: m1.id, clienteId: c1.id, valorServicio: 100000, aCobrar: 0 })).body.pedido.guia;
  const e = await mensajero.post(`/api/pedidos/${guia}/entrega`).send({ destinatario: "Ana", valorCobrado: 0, metodo: "efectivo" });
  assert.equal(e.status, 200, JSON.stringify(e.body));
});
after(() => pool.end());

test("administración marca el día: el mensajero gana $ 25.000 más y el dueño $ 25.000 menos; DELETE lo revierte", async () => {
  const antes = { m: await delDia(m1.id), d: await delDia(dueno.id) };
  assert.deepEqual(antes.m, { sueldo: 45000, sinDescuento: false });
  assert.equal(Math.round(antes.d.sueldo), 55000); // 30 % de 100.000 + los 25.000 de Carlos

  const r = await admin.put(ruta(m1.id));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.jornada, { id: `${m1.id}_sindesc_${dia}`, personaId: m1.id, dia, valor: 0, sinDescuento: true, nota: "Sin descuento de $ 25.000" });
  assert.deepEqual(await delDia(m1.id), { sueldo: 70000, sinDescuento: true });
  assert.equal(Math.round((await delDia(dueno.id)).sueldo), Math.round(antes.d.sueldo) - 25000); // el 30 % es decimal, como en la app
  const plan = (await admin.get(`/api/sueldos/semana?semana=${dia}`)).body.calculoDueno.find(x => x.dia === dia);
  assert.equal(plan.desc, 0); assert.equal(plan.nMens, 0);

  // Marcar otra vez no escribe nada nuevo: devuelve lo que ya está.
  const otra = await admin.put(ruta(m1.id));
  assert.equal(otra.status, 200); assert.deepEqual(otra.body.jornada, r.body.jornada);
  const { rows } = await pool.query("SELECT sin_descuento FROM jornadas WHERE id = $1", [`${m1.id}_sindesc_${dia}`]);
  assert.deepEqual(rows, [{ sin_descuento: true }]);

  const q = await admin.delete(ruta(m1.id));
  assert.equal(q.status, 200); assert.deepEqual(q.body, { quitado: true });
  assert.deepEqual(await delDia(m1.id), antes.m);
  assert.deepEqual(await delDia(dueno.id), antes.d);
  assert.deepEqual((await admin.delete(ruta(m1.id))).body, { quitado: false });
});

test("solo administración: asistente y mensajero reciben 403", async () => {
  assert.equal((await asistente.put(ruta(m1.id))).status, 403);
  assert.equal((await mensajero.put(ruta(m1.id))).status, 403);
  assert.equal((await asistente.delete(ruta(m1.id))).status, 403);
  assert.equal((await mensajero.delete(ruta(m1.id))).status, 403);
});

test("un día que no ha llegado, un día inválido, una persona que no es mensajero o que no existe", async () => {
  const futuro = await admin.put(ruta(m1.id, moverDia(dia, 1)));
  assert.equal(futuro.status, 400); assert.equal(futuro.body.error.message, "No se puede marcar un día que no ha llegado.");
  assert.equal((await admin.put(ruta(m1.id, "2026-13-45"))).status, 400);
  for (const pid of [pat.id, dueno.id]) {
    const x = await admin.put(ruta(pid));
    assert.equal(x.status, 400); assert.equal(x.body.error.message, "Solo a los mensajeros se les descuentan los $ 25.000.");
  }
  assert.equal((await admin.put(ruta("no-existe"))).status, 404);
});

test("queda en el historial y \"Mi sueldo\" del mensajero muestra el día sin descuento", async () => {
  assert.equal((await admin.put(ruta(m1.id))).status, 200);
  const h = (await admin.get(`/api/historial?desde=${dia}`)).body.cambios;
  assert.ok(h.some(c => c.resumen.includes(`Carlos · ${dia} · sin descuento de $ 25.000`)), JSON.stringify(h.map(c => c.resumen)));
  const mio = await mensajero.get(`/api/sueldos/mensajeros/${m1.id}?semana=${dia}`);
  assert.equal(mio.status, 200);
  const d = mio.body.porDia.find(x => x.dia === dia);
  assert.equal(d.sinDescuento, true); assert.equal(d.sueldo, 70000); assert.equal(d.domicilios, 100000);
  assert.ok(mio.body.porDia.filter(x => x.dia !== dia).every(x => x.sinDescuento === false));
  // El período del mensajero (liquidación) también usa la excepción.
  assert.equal((await admin.get(`/api/mensajeros/${m1.id}/periodo`)).body.periodo.sueldo, 70000);
});
