/* Recogida con patinador y traspaso por QR: marcar recogido, generar el QR, canjearlo y los casos límite. */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { pool, reiniciarBase, crearCuenta, sesion } from "./ayuda.js";

let oficina, patinador, otroPatinador, carlos, diana, cliente, idPat, idCarlos, idDiana;

const pedir = async (s, direccionEntrega) => { await s.post("/api/solicitudes/portal").send({
  nombre: "Tienda Luna", telefono: "300 111 2233", direccionRecogida: "Cra 10 # 5-20, Cali", paquetes: 2,
  destinatarioNombre: "Pedro Ruiz", direccionEntrega }); };
/** Una solicitud confirmada y asignada al patinador: devuelve la guía. */
async function guiaDelPatinador(dir) {
  await pedir(cliente, dir);
  const s = (await cliente.get("/api/solicitudes/mias")).body.solicitudes.find(x => x.direccionEntrega === dir);
  await oficina.post(`/api/solicitudes/${s.id}/aceptar`).send({ valor: 8000 });
  const r = await oficina.post(`/api/solicitudes/${s.id}/asignar`).send({ mensajeroId: idPat });
  assert.equal(r.status, 200);
  return r.body.pedido.guia;
}
const cuerpo = codigo => ({ codigo });

before(async () => {
  await reiniciarBase();
  await crearCuenta({ email: "admin@js.co", rol: "admin" });
  oficina = await sesion("admin@js.co");
  idPat = (await oficina.post("/api/mensajeros").send({ nombre: "Tomás Patín", tipo: "patinador", tarifa: 70000 })).body.mensajero.id;
  const idOtroPat = (await oficina.post("/api/mensajeros").send({ nombre: "Otro Patín", tipo: "patinador", tarifa: 70000 })).body.mensajero.id;
  idCarlos = (await oficina.post("/api/mensajeros").send({ nombre: "Carlos Moto" })).body.mensajero.id;
  idDiana = (await oficina.post("/api/mensajeros").send({ nombre: "Diana Moto" })).body.mensajero.id;
  const idCliente = (await oficina.post("/api/clientes").send({ nombre: "Tienda Luna", telefono: "3001112233", tarifa: 8000 })).body.cliente.id;
  await crearCuenta({ email: "pat@js.co", rol: "patinador", mensajeroId: idPat });
  await crearCuenta({ email: "pat2@js.co", rol: "patinador", mensajeroId: idOtroPat });
  await crearCuenta({ email: "carlos@js.co", rol: "mensajero", mensajeroId: idCarlos });
  await crearCuenta({ email: "diana@js.co", rol: "mensajero", mensajeroId: idDiana });
  await crearCuenta({ email: "luna@js.co", rol: "cliente", clienteId: idCliente });
  patinador = await sesion("pat@js.co"); otroPatinador = await sesion("pat2@js.co");
  carlos = await sesion("carlos@js.co"); diana = await sesion("diana@js.co"); cliente = await sesion("luna@js.co");
});
after(() => pool.end());

test("el patinador marca recogido: sale de sus solicitudes y espera al mensajero", async () => {
  const guia = await guiaDelPatinador("Calle 1 # 1-1");
  assert.equal((await patinador.get("/api/patinador/solicitudes")).body.total, 1);
  assert.equal((await otroPatinador.post(`/api/patinador/solicitudes/${guia}/recogido`)).status, 404); // la guía no es suya
  assert.equal((await carlos.post(`/api/patinador/solicitudes/${guia}/recogido`)).status, 403);
  const r = await patinador.post(`/api/patinador/solicitudes/${guia}/recogido`);
  assert.equal(r.status, 200);
  assert.equal((await patinador.post(`/api/patinador/solicitudes/${guia}/recogido`)).status, 200); // doble toque: igual
  assert.equal((await patinador.get("/api/patinador/solicitudes")).body.total, 0);
  const esperan = (await patinador.get("/api/patinador/recogidas")).body.data;
  assert.deepEqual(esperan.map(x => x.guia), [guia]);
  assert.equal(esperan[0].codigoVence, null);
  assert.equal((await oficina.get("/api/patinador/recogidas")).body.data.length, 1);
  assert.equal((await otroPatinador.get("/api/patinador/recogidas")).body.data.length, 0);
});

test("solo la oficina genera el QR, y solo de una guía ya recogida", async () => {
  const sinRecoger = await guiaDelPatinador("Calle 2 # 2-2");
  assert.equal((await oficina.post(`/api/patinador/recogidas/${sinRecoger}/qr`)).status, 409);
  const guia = (await oficina.get("/api/patinador/recogidas?mensajeroId=" + idPat)).body.data[0].guia;
  assert.equal((await patinador.post(`/api/patinador/recogidas/${guia}/qr`)).status, 403);
  assert.equal((await carlos.post(`/api/patinador/recogidas/${guia}/qr`)).status, 403);
  const r = await oficina.post(`/api/patinador/recogidas/${guia}/qr`);
  assert.equal(r.status, 201);
  assert.match(r.body.qr.codigo, /^[0-9A-HJKMNP-TV-Z]{10}$/);
  // En la base solo queda el HMAC, nunca el código.
  const { rows } = await pool.query(`SELECT codigo_hash FROM recogidas_patinador WHERE guia = $1`, [guia]);
  assert.ok(rows[0].codigo_hash && !rows[0].codigo_hash.includes(r.body.qr.codigo));
});

test("canjear: la guía existente pasa al mensajero, sigue por recoger y deja rastro; repetirlo es igual y otro mensajero recibe 409", async () => {
  const guia = (await oficina.get("/api/patinador/recogidas")).body.data.find(x => x.direccionEntrega === "Calle 1 # 1-1").guia;
  const { codigo } = (await oficina.post(`/api/patinador/recogidas/${guia}/qr`)).body.qr;
  assert.equal((await patinador.post("/api/traspasos/canjear").send(cuerpo(codigo))).status, 403);
  assert.equal((await oficina.post("/api/traspasos/canjear").send(cuerpo(codigo))).status, 403);
  const v = await carlos.post("/api/traspasos/vista-previa").send(cuerpo(codigo.toLowerCase().slice(0, 5) + "-" + codigo.slice(5)));
  assert.equal(v.status, 200);
  assert.equal(v.body.traspaso.guia, guia);
  assert.equal(v.body.traspaso.destinatarioNombre, "Pedro Ruiz");
  assert.equal(v.body.traspaso.yaEsTuyo, false);
  assert.ok(!JSON.stringify(v.body).includes("3001112233")); // sin teléfonos
  const antes = (await pool.query(`SELECT count(*)::int n FROM pedidos`)).rows[0].n;
  const c = await carlos.post("/api/traspasos/canjear").send(cuerpo(codigo));
  assert.equal(c.status, 200);
  assert.equal(c.body.traspaso.guia, guia);
  assert.equal((await pool.query(`SELECT count(*)::int n FROM pedidos`)).rows[0].n, antes); // no se crea otra guía
  const p = (await carlos.get(`/api/pedidos/${guia}`)).body.pedido;
  assert.equal(p.mensajeroId, idCarlos);
  assert.equal(p.estado, "aceptado"); // sigue por recoger: falta la foto inicial
  assert.equal((await pool.query(`SELECT mensajero_id FROM solicitudes WHERE guia = $1`, [guia])).rows[0].mensajero_id, idCarlos);
  assert.equal((await patinador.get("/api/patinador/recogidas")).body.data.some(x => x.guia === guia), false);
  const h = await pool.query(`SELECT 1 FROM historial WHERE registro = $1 AND accion LIKE '%por QR%'`, [guia]);
  assert.equal(h.rowCount, 1);
  // Doble escaneo del mismo mensajero: igual. Otro mensajero: 409 con el nombre de quien lo tiene.
  assert.equal((await carlos.post("/api/traspasos/canjear").send(cuerpo(codigo))).body.traspaso.yaEsTuyo, true);
  const otro = await diana.post("/api/traspasos/canjear").send(cuerpo(codigo));
  assert.equal(otro.status, 409);
  assert.equal(otro.body.error.code, "CODIGO_USADO");
  assert.match(otro.body.error.message, /Carlos Moto/);
  // Ya no se puede deshacer ni generar otro QR.
  assert.equal((await oficina.post(`/api/patinador/recogidas/${guia}/qr`)).status, 409);
  assert.equal((await oficina.delete(`/api/patinador/solicitudes/${guia}/recogido`)).status, 409);
});

test("dos mensajeros canjean a la vez: solo uno se queda con el paquete", async () => {
  const guia = await guiaDelPatinador("Calle 3 # 3-3");
  await patinador.post(`/api/patinador/solicitudes/${guia}/recogido`);
  const { codigo } = (await oficina.post(`/api/patinador/recogidas/${guia}/qr`)).body.qr;
  const [a, b] = await Promise.all([carlos, diana].map(s => s.post("/api/traspasos/canjear").send(cuerpo(codigo))));
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
});

test("código inventado, mal escrito, vencido o reemplazado: el mismo 400 sin pistas", async () => {
  const guia = await guiaDelPatinador("Calle 4 # 4-4");
  await patinador.post(`/api/patinador/solicitudes/${guia}/recogido`);
  const uno = (await oficina.post(`/api/patinador/recogidas/${guia}/qr`)).body.qr.codigo;
  const dos = (await oficina.post(`/api/patinador/recogidas/${guia}/qr`)).body.qr.codigo; // reemplaza al anterior
  for (const malo of ["ABCDEFGHJK", "corto", "###", uno]) {
    const r = await carlos.post("/api/traspasos/canjear").send(cuerpo(malo));
    assert.equal(r.status, 400, malo); assert.equal(r.body.error.code, "CODIGO_INVALIDO");
  }
  await pool.query(`UPDATE recogidas_patinador SET codigo_vence = now() - interval '1 minute' WHERE guia = $1`, [guia]);
  assert.equal((await carlos.post("/api/traspasos/canjear").send(cuerpo(dos))).body.error.code, "CODIGO_INVALIDO");
  assert.equal((await carlos.post("/api/traspasos/canjear").send({ codigo: dos, extra: 1 })).status, 400); // cuerpo estricto
});

test("si la guía cambia mientras hay QR (la oficina la reasigna), el canje falla y no la mueve", async () => {
  const guia = await guiaDelPatinador("Calle 5 # 5-5");
  await patinador.post(`/api/patinador/solicitudes/${guia}/recogido`);
  const { codigo } = (await oficina.post(`/api/patinador/recogidas/${guia}/qr`)).body.qr;
  await pool.query(`UPDATE pedidos SET mensajero_id = $2 WHERE guia = $1`, [guia, idDiana]);
  const r = await carlos.post("/api/traspasos/canjear").send(cuerpo(codigo));
  assert.equal(r.status, 409); assert.equal(r.body.error.code, "TRASPASO_CAMBIO");
  assert.equal((await pool.query(`SELECT mensajero_id FROM pedidos WHERE guia = $1`, [guia])).rows[0].mensajero_id, idDiana);
});

test("deshacer: el patinador dentro del plazo, la oficina siempre", async () => {
  const guia = await guiaDelPatinador("Calle 6 # 6-6");
  await patinador.post(`/api/patinador/solicitudes/${guia}/recogido`);
  assert.equal((await otroPatinador.delete(`/api/patinador/solicitudes/${guia}/recogido`)).status, 404);
  await pool.query(`UPDATE recogidas_patinador SET recogido_en = now() - interval '11 minutes' WHERE guia = $1`, [guia]);
  const tarde = await patinador.delete(`/api/patinador/solicitudes/${guia}/recogido`);
  assert.equal(tarde.status, 409); assert.equal(tarde.body.error.code, "TIEMPO_VENCIDO");
  assert.equal((await oficina.delete(`/api/patinador/solicitudes/${guia}/recogido`)).status, 200);
  assert.ok((await patinador.get("/api/patinador/solicitudes?limit=50")).body.data.some(x => x.guia === guia)); // vuelve a su lista
  await patinador.post(`/api/patinador/solicitudes/${guia}/recogido`);
  assert.equal((await patinador.delete(`/api/patinador/solicitudes/${guia}/recogido`)).status, 200); // dentro del plazo
});

test("una guía que no es de un patinador o ya salió a la calle no se puede marcar como recogida", async () => {
  await pedir(cliente, "Calle 7 # 7-7");
  const s = (await cliente.get("/api/solicitudes/mias")).body.solicitudes.find(x => x.direccionEntrega === "Calle 7 # 7-7");
  await oficina.post(`/api/solicitudes/${s.id}/aceptar`).send({ valor: 8000 });
  const g = (await oficina.post(`/api/solicitudes/${s.id}/asignar`).send({ mensajeroId: idCarlos })).body.pedido.guia;
  assert.equal((await oficina.post(`/api/patinador/solicitudes/${g}/recogido`)).status, 409);
  assert.equal((await patinador.post(`/api/patinador/solicitudes/JS-99999/recogido`)).status, 404);
  assert.equal((await patinador.post(`/api/patinador/solicitudes/xx/recogido`)).status, 400);
});
