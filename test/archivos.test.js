/* Fotos y firmas de los pedidos. Supabase Storage se reemplaza por un bucket en memoria (fetch simulado). */
process.env.SUPABASE_URL = "https://bucket-de-prueba.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "llave-de-prueba";
process.env.STORAGE_BUCKET = "pedidos";

import { test, before, after } from "node:test";
import assert from "node:assert/strict";

const bucket = new Map();
let fallarSubida = false; // simula que Supabase rechaza la subida
const fetchReal = globalThis.fetch;
globalThis.fetch = async (url, op = {}) => {
  const u = new URL(url);
  if (u.host !== "bucket-de-prueba.supabase.co") return fetchReal(url, op);
  if (op.headers?.Authorization !== "Bearer llave-de-prueba") return new Response("{}", { status: 401 });
  const json = (d, status = 200) => new Response(JSON.stringify(d), { status, headers: { "Content-Type": "application/json" } });
  const base = "/storage/v1/object/pedidos";
  if (u.pathname === "/storage/v1/object/sign/pedidos" && op.method === "POST") {
    const { paths } = JSON.parse(op.body);
    return json(paths.map(path => bucket.has(path)
      ? { path, signedURL: `/object/sign/pedidos/${path}?token=t` }
      : { path, error: "not found", signedURL: null }));
  }
  if (u.pathname === base && op.method === "DELETE") {
    for (const r of JSON.parse(op.body).prefixes) bucket.delete(r);
    return json([]);
  }
  if (u.pathname.startsWith(base + "/") && op.method === "POST") {
    const ruta = u.pathname.slice(base.length + 1);
    if (fallarSubida) return json({ error: "falla simulada" }, 503);
    if (bucket.has(ruta)) return json({ error: "Duplicate" }, 409);
    bucket.set(ruta, { tipo: op.headers["Content-Type"], bytes: op.body.length });
    return json({ Key: "pedidos/" + ruta });
  }
  return json({ error: "no simulado" }, 400);
};

const { pool, reiniciarBase, crearCuenta, sesion } = await import("./ayuda.js");

// Una "foto" mínima: basta con la firma de bytes del formato.
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 1)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200, 2)]);

let admin, mensajero, otroMensajero, guia;

before(async () => {
  await reiniciarBase();
  await crearCuenta({ email: "admin@js.co", rol: "admin" });
  admin = await sesion("admin@js.co");
  const m1 = (await admin.post("/api/mensajeros").send({ nombre: "Carlos" })).body.mensajero;
  const m2 = (await admin.post("/api/mensajeros").send({ nombre: "Diana" })).body.mensajero;
  await crearCuenta({ email: "carlos@js.co", rol: "mensajero", mensajeroId: m1.id });
  await crearCuenta({ email: "diana@js.co", rol: "mensajero", mensajeroId: m2.id });
  mensajero = await sesion("carlos@js.co");
  otroMensajero = await sesion("diana@js.co");
  guia = (await mensajero.post("/api/pedidos").send({})).body.pedido.guia;
});
after(() => pool.end());

const subir = (s, g, tipo, cuerpo, mime = "image/jpeg") =>
  s.post(`/api/pedidos/${g}/archivos/${tipo}`).set("Content-Type", mime).send(cuerpo);

test("el mensajero sube la foto de salida y la miniatura de su guía", async () => {
  const r = await subir(mensajero, guia, "salida", JPEG);
  assert.equal(r.status, 201);
  assert.equal(r.body.archivo.tipo, "salida");
  assert.match(r.body.archivo.url, /^https:\/\/bucket-de-prueba\.supabase\.co\/storage\/v1\/object\/sign\/pedidos\/JS-00001\/salida-.+\.jpg\?token=t$/);
  assert.equal((await subir(mensajero, guia, "mini", PNG, "image/png")).status, 201);

  const [ruta] = [...bucket.keys()].filter(k => k.includes("/salida-"));
  assert.equal(bucket.get(ruta).tipo, "image/jpeg");

  // La lista trae la miniatura firmada y nunca la ruta interna.
  const lista = await mensajero.get("/api/pedidos?estado=pendiente");
  const p = lista.body.pedidos.find(x => x.guia === guia);
  assert.match(p.mini, /\/mini-.+\.png\?token=t$/);
  assert.equal(p.miniRuta, undefined);
});

test("la entrega guarda foto y firma, y el detalle las muestra con URL firmadas", async () => {
  assert.equal((await subir(mensajero, guia, "entrega", JPEG)).status, 201);
  assert.equal((await subir(mensajero, guia, "firma", JPEG)).status, 201);
  const e = await mensajero.post(`/api/pedidos/${guia}/entrega`).send({ destinatario: "Ana", valorCobrado: 0, metodo: "efectivo" });
  assert.equal(e.status, 200);

  const r = await admin.get(`/api/pedidos/${guia}/archivos`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.archivos.map(a => a.tipo).sort(), ["entrega", "firma", "salida"]); // la miniatura no va aquí
  for (const a of r.body.archivos) assert.match(a.url, /\?token=t$/);

  const h = await pool.query(`SELECT accion FROM historial WHERE registro = $1 AND accion LIKE 'Agregó%'`, [guia]);
  assert.equal(h.rowCount, 3); // salida, entrega y firma; la miniatura no se anota
});

test("si se cambia la foto, queda la más reciente", async () => {
  const nueva = await subir(admin, guia, "entrega", PNG, "image/png");
  const r = await admin.get(`/api/pedidos/${guia}/archivos`);
  assert.equal(r.body.archivos.find(a => a.tipo === "entrega").url, nueva.body.archivo.url);
});

test("otro mensajero no puede subir fotos a una guía ajena (404)", async () => {
  const r = await subir(otroMensajero, guia, "entrega", JPEG);
  assert.equal(r.status, 404);
});

test("rechaza lo que no es imagen aunque diga que lo es", async () => {
  const falso = await subir(mensajero, guia, "entrega", Buffer.from("<script>alert(1)</script>".repeat(5)));
  assert.equal(falso.status, 415);
  assert.equal(falso.body.error.code, "NO_ES_IMAGEN");
  const json = await mensajero.post(`/api/pedidos/${guia}/archivos/entrega`).send({ foto: "data:image/jpeg;base64,AAAA" });
  assert.equal(json.status, 415);
});

test("rechaza tipos inventados y fotos de más de 1 MB", async () => {
  assert.equal((await subir(admin, guia, "previa", JPEG)).status, 400);
  assert.equal((await subir(admin, guia, "cualquiera", JPEG)).status, 400);
  const grande = Buffer.concat([JPEG, Buffer.alloc(1024 * 1024)]);
  const r = await subir(admin, guia, "entrega", grande);
  assert.equal(r.status, 413);
});

test("pasadas 24 horas el mensajero ya no agrega fotos; la oficina sí", async () => {
  await pool.query(`UPDATE pedidos SET entregado = now() - interval '25 hours' WHERE guia = $1`, [guia]);
  const r = await subir(mensajero, guia, "entrega", JPEG);
  assert.equal(r.status, 403);
  assert.equal((await subir(admin, guia, "entrega", JPEG)).status, 201);
});

test("si la guía no existe no sube nada al bucket", async () => {
  const antes = bucket.size;
  assert.equal((await subir(admin, "JS-99999", "entrega", JPEG)).status, 404);
  assert.equal(bucket.size, antes);
});

test("con ?sinUrl=1 la subida no firma la URL (la app interna no la usa)", async () => {
  const r = await admin.post(`/api/pedidos/${guia}/archivos/salida?sinUrl=1`).set("Content-Type", "image/jpeg").send(JPEG);
  assert.equal(r.status, 201);
  assert.equal(r.body.archivo.tipo, "salida");
  assert.equal(r.body.archivo.url, null);
});

test("POST /pedidos/miniaturas: firma solo las miniaturas de guías que la cuenta puede ver", async () => {
  await subir(mensajero, guia, "mini", PNG, "image/png");
  const suya = await mensajero.post("/api/pedidos/miniaturas").send({ guias: [guia, "JS-99999"] });
  assert.equal(suya.status, 200);
  assert.deepEqual(Object.keys(suya.body.minis), [guia], "la guía que no existe no aparece");
  assert.match(suya.body.minis[guia], /\/mini-.+\.png\?token=t$/);

  const ajena = await otroMensajero.post("/api/pedidos/miniaturas").send({ guias: [guia] });
  assert.equal(ajena.status, 200);
  assert.deepEqual(ajena.body.minis, {}, "otro mensajero no recibe nada (ni se confirma que existe)");

  const oficina = await admin.post("/api/pedidos/miniaturas").send({ guias: [guia] });
  assert.equal(oficina.body.minis[guia], suya.body.minis[guia], "la misma foto repite la misma URL");
});

test("POST /pedidos/miniaturas: valida la entrada y exige sesión", async () => {
  assert.equal((await mensajero.post("/api/pedidos/miniaturas").send({ guias: [] })).status, 400);
  assert.equal((await mensajero.post("/api/pedidos/miniaturas").send({ guias: ["no-es-guia"] })).status, 400);
  assert.equal((await mensajero.post("/api/pedidos/miniaturas").send({ guias: Array(101).fill(guia) })).status, 400);
  assert.equal((await mensajero.post("/api/pedidos/miniaturas").send({ guias: [guia], otro: 1 })).status, 400);
});

/* ---- Guía y foto en un solo paso (POST /pedidos/con-foto): sin foto no hay guía ---- */
const conFoto = (s, cuerpo = JPEG, mime = "image/jpeg", q = "") => s.post("/api/pedidos/con-foto" + q).set("Content-Type", mime).send(cuerpo);
const contador = async () => (await pool.query(`SELECT n FROM contadores WHERE nombre = 'guia'`)).rows[0].n;

test("con-foto: el mensajero crea la guía con su foto de salida, a su nombre y en cero", async () => {
  const r = await conFoto(mensajero);
  assert.equal(r.status, 201);
  const p = r.body.pedido;
  assert.equal(p.estado, "pendiente");
  assert.equal(p.valorServicio, 0);
  assert.equal(p.sinFoto, false);
  const a = await mensajero.get(`/api/pedidos/${p.guia}/archivos`);
  assert.deepEqual(a.body.archivos.map(x => x.tipo), ["salida"]);
  assert.ok([...bucket.keys()].some(k => k.startsWith(p.guia + "/salida-")));
});

test("con-foto: si la foto no sube, la guía no se crea y el consecutivo no avanza", async () => {
  const antes = await contador(), guiasAntes = (await pool.query("SELECT count(*)::int AS n FROM pedidos")).rows[0].n;
  fallarSubida = true;
  try { assert.equal((await conFoto(mensajero)).status, 500); } finally { fallarSubida = false; }
  assert.equal(await contador(), antes, "no queda hueco en la numeración");
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM pedidos")).rows[0].n, guiasAntes);
  const siguiente = (await conFoto(mensajero)).body.pedido;
  assert.equal(siguiente.n, antes + 1);
});

test("con-foto: rechaza lo que no es imagen sin crear guía", async () => {
  const antes = await contador();
  assert.equal((await conFoto(mensajero, Buffer.from("hola, no soy una foto"), "image/jpeg")).status, 415);
  assert.equal(await contador(), antes);
});

test("con-foto: la oficina elige el mensajero; sin él, o con uno que no existe, no crea nada", async () => {
  const antes = await contador();
  assert.equal((await conFoto(admin)).status, 400);
  assert.equal((await conFoto(admin, JPEG, "image/jpeg", "?mensajeroId=no-existe")).status, 400);
  assert.equal(await contador(), antes);
  const mid = (await pool.query("SELECT mensajero_id FROM usuarios WHERE email = 'carlos@js.co'")).rows[0].mensajero_id;
  const r = await conFoto(admin, JPEG, "image/jpeg", "?mensajeroId=" + mid);
  assert.equal(r.status, 201);
  assert.equal(r.body.pedido.mensajeroId, mid);
});

test("sinFoto: la oficina ve las guías por entregar que se quedaron sin foto de salida", async () => {
  const vieja = (await mensajero.post("/api/pedidos").send({})).body.pedido.guia;   // como la app vieja: guía primero, foto después
  const reciente = (await mensajero.post("/api/pedidos").send({})).body.pedido.guia;
  const conLaFoto = (await conFoto(mensajero)).body.pedido.guia;
  await pool.query(`UPDATE pedidos SET creado = now() - interval '11 minutes' WHERE guia = ANY($1)`, [[vieja, conLaFoto]]);
  const r = await admin.get("/api/pedidos?sinFoto=true&pagina=1&porPagina=100");
  assert.equal(r.status, 200);
  const guias = r.body.pedidos.map(p => p.guia);
  assert.ok(guias.includes(vieja), "la que lleva más de 10 minutos sin foto aparece");
  assert.ok(!guias.includes(reciente), "la recién creada puede estar subiendo todavía");
  assert.ok(!guias.includes(conLaFoto), "la que tiene foto no aparece");
  assert.ok(r.body.pedidos.every(p => p.sinFoto === true));
});
