/* Cuentas → Movimientos y Ganancias: leer de la base solo los tipos de oficina, el rango con margen y los clientes que
   aparecen da exactamente la misma respuesta que leer las tablas completas y filtrar en memoria. */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { pool, reiniciarBase } from "./ayuda.js";
import { paginaOficina, gananciasPorCliente, armarPaginaMovimientos, armarGananciasPorCliente } from "../servicios/movimientos.js";
import { Movimientos, Clientes } from "../models/documentos.js";
import { diaDe } from "../helpers/fechas.js";

const DIA = 86400000;
const ctx = { actor: { esOficina: true, esAdmin: true }, db: pool };

before(async () => {
  await reiniciarBase();
  for (let i = 1; i <= 12; i++) await pool.query(`INSERT INTO clientes (id, nombre, telefono) VALUES ($1, $2, '')`, ["c" + i, ["Tienda Luna", "Moda Sol", "Ana Ruíz", "Calzado Pie"][i % 4] + " " + i]);
  // Todos los tipos, con fechas justo antes y después de la medianoche de Colombia (05:00 UTC), en varios días.
  const tipos = ["pago_de_cliente", "pago_a_cliente", "compra_cliente", "ganancia", "cargo", "abono"];
  const t0 = Date.parse("2026-11-01T05:00:00Z");
  for (let i = 0; i < 240; i++) {
    const tipo = tipos[i % tipos.length], fecha = t0 + (i % 12) * DIA + (i % 2 ? -60000 : 60000) + i * 1000;
    await pool.query(`INSERT INTO movimientos (id, cliente_id, tipo, valor, medio, nota, fecha) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      ["m" + i, "c" + (1 + (i % 12)), tipo, 1000 * (1 + (i % 9)), ["pago_de_cliente", "pago_a_cliente", "compra_cliente"].includes(tipo) ? "efectivo" : null, i % 5 ? "guía JS-" + i : "", new Date(fecha)]);
  }
});
after(() => pool.end());

test("la lista y Ganancias dan lo mismo que leer todo", async () => {
  const [movs, clientes] = await Promise.all([Movimientos.listar(pool), Clientes.listar(pool)]);
  const dias = [...new Set(movs.map(m => diaDe(m.fecha)))].sort();
  const rangos = [[], [dias[0]], [undefined, dias[3]], [dias[2], dias[2]], [dias[1], dias[7]], ["2026-10-01", "2026-10-05"], [dias.at(-1)]];
  let n = 0;
  for (const [desde, hasta] of rangos) for (const buscar of ["", "luna", "ruiz", "JS-1", "nadie"]) for (const [pagina, porPagina] of [[1, 6], [2, 6], [1, 100]]) {
    const base = { desde, hasta, buscar, pagina, porPagina };
    for (const tipo of ["todos", "pagos", "compras", "ganancias"]) {
      const f = { ...base, tipo };
      assert.deepEqual(await paginaOficina(ctx, f), armarPaginaMovimientos(movs, clientes, f), "lista " + JSON.stringify(f));
      n++;
    }
    assert.deepEqual(await gananciasPorCliente(ctx, base), armarGananciasPorCliente(movs, clientes, base), "ganancias " + JSON.stringify(base));
  }
  assert.ok(n > 300);
});
