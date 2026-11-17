/* Cuentas internas: la tabla paginada (GET /caja/movimientos/pagina) da lo mismo que filtrar todo en memoria, y una entrada o
   salida valida el día contra el último arqueo con solo la hora del corte. */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { pool, reiniciarBase, crearCuenta, sesion } from "./ayuda.js";
import { paginaInternos, armarPaginaInternos } from "../servicios/caja.js";
import { Cajamovs } from "../models/documentos.js";
import { diaDe, hoy } from "../helpers/fechas.js";

const DIA = 86400000;
let admin, cuentaId;

before(async () => {
  await reiniciarBase();
  await crearCuenta({ email: "admin@js.co", rol: "admin" });
  admin = await sesion("admin@js.co");
  const cu = await admin.post("/api/cuentas").send({ nombre: "JS Envíos", tipo: "socio" });
  assert.equal(cu.status, 201, JSON.stringify(cu.body));
  cuentaId = cu.body.cuenta.id;
  // Movimientos de varias categorías, medios y días (incluidos los cambios de día de Colombia, 05:00 UTC).
  const medios = ["efectivo", "nequi", "bancolombia"], cats = ["interna", "interna", "gasto", "base", "oficina", "interna"];
  const t0 = Date.parse("2026-11-10T05:00:00Z");
  for (let i = 0; i < 60; i++) {
    const fecha = t0 + (i % 7) * DIA + (i % 3 === 0 ? -60000 : 60000) + i * 1000;
    await pool.query(`INSERT INTO cajamovs (id, tipo, cat, valor, medio, concepto, fecha, cuenta_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      ["m" + i, i % 2 ? "entra" : "sale", cats[i % cats.length], 1000 * (i + 1), medios[i % 3], "mov " + i, new Date(fecha), cats[i % cats.length] === "interna" ? cuentaId : null]);
  }
});
after(() => pool.end());

test("la página de movimientos internos es igual a filtrar todo en memoria", async () => {
  const ctx = { actor: { esOficina: true, esAdmin: true }, db: pool };
  const todos = await Cajamovs.listar(pool);
  const dias = ["", ...new Set(todos.map(m => diaDe(m.fecha)))];
  let probados = 0;
  for (const dia of dias) for (const medio of ["", "efectivo", "nequi", "bancolombia"]) for (const [pagina, porPagina] of [[1, 5], [2, 5], [3, 4], [1, 100], [99, 10]]) {
    const q = { dia: dia || undefined, medio: medio || undefined, pagina, porPagina };
    assert.deepEqual(await paginaInternos(ctx, q), armarPaginaInternos(todos, q), JSON.stringify(q));
    probados++;
  }
  assert.ok(probados > 100);
});

test("entrada y salida: guarda en un día abierto y rechaza un día ya contado en un arqueo", async () => {
  const ok = await admin.post("/api/caja/movimientos").send({ tipo: "entra", cat: "interna", cuentaId, valor: 50000, medio: "efectivo", concepto: "devolución", dia: hoy() });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal(ok.body.movimiento.cat, "interna");
  assert.equal(ok.body.movimiento.valor, 50000);
  // Un arqueo hoy: un día anterior ya quedó contado.
  await pool.query(`INSERT INTO cajamovs (id, tipo, cat, valor, medio, fecha) VALUES ('arq', 'entra', 'arqueo', 0, 'efectivo', now())`);
  const ayer = diaDe(Date.now() - DIA);
  const no = await admin.post("/api/caja/movimientos").send({ tipo: "sale", cat: "interna", cuentaId, valor: 1000, medio: "nequi", concepto: "préstamo", dia: ayer });
  assert.equal(no.status, 409, JSON.stringify(no.body));
});
