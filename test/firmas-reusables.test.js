/* URL firmadas que se repiten entre respuestas (helpers/storage.js › firmarUrlsReusables). Supabase se simula:
   cada firma lleva un token distinto, como la de verdad, y se cuentan las llamadas. */
process.env.SUPABASE_URL = "https://firmas-de-prueba.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "llave-de-prueba";
process.env.STORAGE_BUCKET = "pedidos";
process.env.NODE_ENV = "test";
process.env.JWT_SECRET ??= "secreto-de-pruebas-que-no-sirve-en-produccion-123";
process.env.DATABASE_URL ??= "postgresql://postgres@127.0.0.1:5432/jsl_test"; // no se conecta: solo lo exige la configuración

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

let llamadas = [], n = 0;
const fetchReal = globalThis.fetch;
globalThis.fetch = async (url, op = {}) => {
  const u = new URL(url);
  if (u.host !== "firmas-de-prueba.supabase.co") return fetchReal(url, op);
  const json = d => new Response(JSON.stringify(d), { status: 200, headers: { "Content-Type": "application/json" } });
  if (u.pathname === "/storage/v1/object/sign/pedidos") {
    const { paths, expiresIn } = JSON.parse(op.body);
    llamadas.push({ paths, expiresIn });
    return json(paths.map(path => path.startsWith("no-existe")
      ? { path, error: "not found", signedURL: null }
      : { path, signedURL: `/object/sign/pedidos/${path}?token=t${++n}` }));
  }
  if (u.pathname === "/storage/v1/object/pedidos" && op.method === "DELETE") return json([]);
  return new Response("{}", { status: 400 });
};

const { firmarUrlsReusables, borrarArchivos, olvidarFirmas } = await import("../helpers/storage.js");
const HORA = 3600 * 1000;

beforeEach(() => { olvidarFirmas(); llamadas = []; });

test("la misma foto da la misma URL en respuestas seguidas, sin volver a firmar", async () => {
  const t0 = Date.now();
  const a = await firmarUrlsReusables(["JS-1/mini-a.jpg", "JS-2/mini-b.jpg"], t0);
  const b = await firmarUrlsReusables(["JS-1/mini-a.jpg", "JS-2/mini-b.jpg"], t0 + 30 * 60 * 1000);
  assert.deepEqual(b, a);
  assert.equal(llamadas.length, 1);
  assert.equal(llamadas[0].expiresIn, 7200, "se firma por 2 horas");
});

test("solo se firman las que faltan, en una sola llamada", async () => {
  const t0 = Date.now();
  await firmarUrlsReusables(["JS-1/mini-a.jpg"], t0);
  const r = await firmarUrlsReusables(["JS-1/mini-a.jpg", "JS-3/mini-c.jpg", "JS-3/mini-c.jpg"], t0 + 1000);
  assert.equal(llamadas.length, 2);
  assert.deepEqual(llamadas[1].paths, ["JS-3/mini-c.jpg"]);
  assert.equal(Object.keys(r).length, 2);
});

test("cuando a la URL le queda menos de 1 hora se firma otra", async () => {
  const t0 = Date.now();
  const a = await firmarUrlsReusables(["JS-1/mini-a.jpg"], t0);
  const casi = await firmarUrlsReusables(["JS-1/mini-a.jpg"], t0 + HORA); // le queda justo 1 hora: sirve
  assert.equal(casi["JS-1/mini-a.jpg"], a["JS-1/mini-a.jpg"]);
  const b = await firmarUrlsReusables(["JS-1/mini-a.jpg"], t0 + HORA + 1);
  assert.notEqual(b["JS-1/mini-a.jpg"], a["JS-1/mini-a.jpg"]);
  assert.equal(llamadas.length, 2);
});

test("un archivo borrado se olvida y uno que no existe no se recuerda", async () => {
  const t0 = Date.now();
  const a = await firmarUrlsReusables(["JS-1/mini-a.jpg", "no-existe/x.jpg"], t0);
  assert.equal(a["no-existe/x.jpg"], undefined);
  await borrarArchivos(["JS-1/mini-a.jpg"]);
  await firmarUrlsReusables(["JS-1/mini-a.jpg", "no-existe/x.jpg"], t0 + 1000);
  assert.equal(llamadas.length, 2);
  assert.deepEqual(llamadas[1].paths, ["JS-1/mini-a.jpg", "no-existe/x.jpg"]);
});
