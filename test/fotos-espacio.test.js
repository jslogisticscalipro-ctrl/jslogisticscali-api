/* Control del espacio de las fotos: medir, aviso y liberar espacio borrando guías completas (más antiguas primero). */
process.env.SUPABASE_URL = "https://bucket-de-prueba.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "llave-de-prueba";
process.env.STORAGE_BUCKET = "pedidos";
process.env.FOTOS_LIMITE_MB = "1"; // tope de 1 MB para que unas pocas fotos de prueba lo llenen

import { test, before, after } from "node:test";
import assert from "node:assert/strict";

const bucket = new Map();
const fetchReal = globalThis.fetch;
globalThis.fetch = async (url, op = {}) => {
  const u = new URL(url);
  if (u.host !== "bucket-de-prueba.supabase.co") return fetchReal(url, op);
  const json = (d, status = 200) => new Response(JSON.stringify(d), { status, headers: { "Content-Type": "application/json" } });
  const base = "/storage/v1/object/pedidos";
  if (u.pathname === base && op.method === "DELETE") { for (const r of JSON.parse(op.body).prefixes) bucket.delete(r); return json([]); }
  if (u.pathname.startsWith(base + "/") && op.method === "POST") { bucket.set(u.pathname.slice(base.length + 1), op.body.length); return json({}); }
  if (u.pathname === "/storage/v1/object/sign/pedidos") return json(JSON.parse(op.body).paths.map(path => bucket.has(path) ? { path, signedURL: `/object/sign/pedidos/${path}?token=t` } : { path, error: "no", signedURL: null }));
  return json({}, 400);
};

const { pool, reiniciarBase, crearCuenta, sesion } = await import("./ayuda.js");
const FOTO = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(100_000, 1)]); // ~100 KB

let admin, asistente, guias = [];
const subir = (g, tipo) => admin.post(`/api/pedidos/${g}/archivos/${tipo}`).set("Content-Type", "image/jpeg").send(FOTO);
const cerrar = (g, dias, extra = "") => pool.query(`UPDATE pedidos SET estado = 'entregado', entregado = now() - ($2 || ' days')::interval ${extra} WHERE guia = $1`, [g, String(dias)]);

before(async () => {
  await reiniciarBase();
  await crearCuenta({ email: "admin@js.co", rol: "admin" });
  await crearCuenta({ email: "asis@js.co", rol: "asistente" });
  admin = await sesion("admin@js.co");
  asistente = await sesion("asis@js.co");
  const m = (await admin.post("/api/mensajeros").send({ nombre: "Carlos" })).body.mensajero;
  // 5 guías con salida + entrega + firma: edades 200, 100, 60 días, 10 días (protegida) y una de 90 con diferencia sin revisar
  for (let i = 0; i < 5; i++) {
    const g = (await admin.post("/api/pedidos").send({ mensajeroId: m.id })).body.pedido.guia;
    for (const t of ["salida", "entrega", "firma"]) assert.equal((await subir(g, t)).status, 201);
    guias.push(g);
  }
  await cerrar(guias[0], 200); await cerrar(guias[1], 100); await cerrar(guias[2], 60); await cerrar(guias[3], 10);
  await cerrar(guias[4], 90, ", dif_cobro = 5000, dif_revisada = false");
});
after(() => pool.end());

test("el espacio usado sale de los tamaños guardados y avisa al pasar el umbral", async () => {
  const r = await admin.get("/api/respaldo/espacio");
  assert.equal(r.status, 200);
  const f = r.body.fotos;
  assert.equal(f.archivos, 15);
  assert.equal(f.bytes, 15 * FOTO.length);
  assert.equal(f.sinTamano, 0);
  assert.equal(f.nivel, "critico"); // ~1,43 MB de un tope de 1 MB
  assert.equal(f.umbral, 85);
  assert.equal(f.liberable.guias, 3); // la de 10 días y la de la diferencia sin revisar no se pueden
});

test("solo administración ve el espacio, cambia el aviso y libera", async () => {
  assert.equal((await asistente.get("/api/respaldo/espacio")).status, 403);
  assert.equal((await asistente.put("/api/respaldo/fotos/aviso").send({ umbral: 70 })).status, 403);
  assert.equal((await asistente.post("/api/respaldo/fotos/liberar").send({ cantidad: 1, simular: true })).status, 403);
});

test("el porcentaje del aviso se puede cambiar y se valida", async () => {
  assert.equal((await admin.put("/api/respaldo/fotos/aviso").send({ umbral: 20 })).status, 400);
  assert.equal((await admin.put("/api/respaldo/fotos/aviso").send({ umbral: 100 })).status, 400);
  assert.equal((await admin.put("/api/respaldo/fotos/aviso").send({ umbral: 90 })).status, 200);
  assert.equal((await admin.get("/api/respaldo/espacio")).body.fotos.umbral, 90);
});

test("simular no borra nada y cuenta las guías más antiguas primero", async () => {
  const r = await admin.post("/api/respaldo/fotos/liberar").send({ cantidad: 2, simular: true });
  assert.equal(r.status, 200);
  assert.equal(r.body.guias, 2); assert.equal(r.body.archivos, 6); assert.equal(r.body.bytes, 6 * FOTO.length);
  assert.ok(r.body.desde < r.body.hasta);
  assert.equal(bucket.size, 15);
});

test("borrar exige escribir BORRAR y que la lista no haya cambiado", async () => {
  assert.equal((await admin.post("/api/respaldo/fotos/liberar").send({ cantidad: 2, guiasEsperadas: 2 })).status, 400);
  const mal = await admin.post("/api/respaldo/fotos/liberar").send({ cantidad: 2, confirmar: "BORRAR", guiasEsperadas: 1 });
  assert.equal(mal.status, 409);
  assert.equal(mal.body.error.code, "LISTA_CAMBIO");
  assert.equal((await admin.post("/api/respaldo/fotos/liberar").send({})).status, 400);
  assert.equal(bucket.size, 15);
});

test("libera las 2 guías más antiguas: borra archivos y filas, y la guía sigue funcionando", async () => {
  const r = await admin.post("/api/respaldo/fotos/liberar").send({ cantidad: 2, confirmar: "BORRAR", guiasEsperadas: 2 });
  assert.equal(r.status, 200);
  assert.equal(r.body.archivos, 6);
  assert.equal(bucket.size, 9);
  assert.ok(![...bucket.keys()].some(k => k.startsWith(guias[0] + "/") || k.startsWith(guias[1] + "/")));

  const a = await admin.get(`/api/pedidos/${guias[0]}/archivos`);
  assert.equal(a.status, 200);
  assert.deepEqual(a.body.archivos, []);
  assert.equal(a.body.borradas, true);
  const g = await admin.get(`/api/pedidos/${guias[0]}`);
  assert.equal(g.status, 200);
  assert.equal(g.body.pedido.estado, "entregado");
  assert.equal((await admin.get(`/api/pedidos/${guias[2]}/archivos`)).body.archivos.length, 3); // la siguiente no se tocó

  const h = await pool.query(`SELECT accion FROM historial WHERE accion LIKE 'Liberó espacio%'`);
  assert.equal(h.rowCount, 1);
  assert.match(h.rows[0].accion, /6 fotos de 2 guías/);
});

test("nunca borra guías recientes ni con diferencia sin revisar; el rango elige por fecha de cierre", async () => {
  const hoy = new Date().toISOString().slice(0, 10);
  const r = await admin.post("/api/respaldo/fotos/liberar").send({ desde: "2020-01-01", hasta: hoy, simular: true });
  assert.equal(r.body.guias, 1); // solo la de 60 días
  const rango = await admin.post("/api/respaldo/fotos/liberar").send({ desde: "2020-01-01", hasta: "2020-12-31", simular: true });
  assert.equal(rango.body.guias, 0);
  const sin = await admin.post("/api/respaldo/fotos/liberar").send({ desde: "2020-01-01", hasta: "2020-12-31", confirmar: "BORRAR", guiasEsperadas: 0 });
  assert.equal(sin.status, 400); // nada que borrar con ese rango
  assert.equal((await admin.post("/api/respaldo/fotos/liberar").send({ desde: "2025-02-01", hasta: "2025-01-01", simular: true })).status, 400);
});
