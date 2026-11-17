/* calculosDeCorte (solo la hora del último arqueo) debe dar lo mismo que calculosDe con toda la caja. */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { pool, reiniciarBase } from "./ayuda.js";
import { calculosDe, calculosDeCorte } from "../servicios/contexto.js";
import { hoy } from "../helpers/fechas.js";

before(reiniciarBase);
after(() => pool.end());

const igual = async (etiqueta) => {
  const c = { query: (...a) => pool.query(...a) };
  const [a, b] = await Promise.all([calculosDe(c, ["cajamovs"]), calculosDeCorte(c)]);
  const dias = [hoy(), "2020-01-01", "2099-01-01"];
  assert.equal(b.corteCaja(), a.corteCaja(), etiqueta + ": corte");
  assert.equal(b.textoContado(), a.textoContado(), etiqueta + ": texto");
  for (const f of [0, 1, a.corteCaja(), a.corteCaja() + 1, Date.now()]) assert.equal(b.yaContado(f), a.yaContado(f), etiqueta + ": yaContado " + f);
  for (const d of dias) {
    assert.equal(b.fechaCaja(d), a.fechaCaja(d), etiqueta + ": fechaCaja " + d);
    assert.equal(b.diaAntesDelArqueo(d), a.diaAntesDelArqueo(d), etiqueta + ": diaAntesDelArqueo " + d);
  }
};

test("sin arqueos", () => igual("vacía"));

test("con saldo inicial, arqueo y corte guardado", async () => {
  const ins = (id, cat, fecha) => pool.query(`INSERT INTO cajamovs (id, tipo, cat, valor, medio, fecha) VALUES ($1, 'entrada', $2, 1000, 'efectivo', $3)`, [id, cat, new Date(fecha)]);
  await ins("i1", "inicial", Date.now() - 5 * 86400000);
  await igual("inicial");
  await ins("a1", "arqueo", Date.now() - 2 * 86400000);
  await igual("arqueo");
  await pool.query(`INSERT INTO ajustes (clave, valor) VALUES ('caja', $1::jsonb) ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor`, [JSON.stringify({ corte: new Date(Date.now() - 86400000).toISOString() })]);
  await igual("corte guardado");
});
