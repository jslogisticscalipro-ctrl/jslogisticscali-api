/* Lo que espera el arqueo, leyendo solo lo que necesita (calculosDeArqueo), tiene que dar exactamente lo mismo que cargando todo
   el sistema (calculosDe). Es la red de seguridad para que arquear lea menos sin tocar ninguna regla de caja. */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { pool, reiniciarBase } from "./ayuda.js";
import { generarDatos } from "./generador.js";
import { MODELOS } from "../models/documentos.js";
import { calculosDe, calculosDeArqueo } from "../servicios/contexto.js";

before(reiniciarBase);
after(() => pool.end());

async function guardarEstado(S) {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    for (const col of ["clientes", "mensajeros", "cuentas", "usuarios", "pedidos", "movimientos", "recaudos", "liquidaciones", "cajamovs", "jornadas"]) {
      for (const d of Object.values(S[col])) {
        const doc = col === "usuarios" ? { ...d, email: d.email || d.uid + "@sin-correo.test" } : d;
        await MODELOS[col].guardar(c, doc);
      }
    }
    await c.query("COMMIT");
  } catch (e) { await c.query("ROLLBACK"); throw e; } finally { c.release(); }
}
const r = x => JSON.parse(JSON.stringify(x, (k, v) => (typeof v === "number" ? Math.round(v * 100) / 100 : v)));

test("calculosDeArqueo da lo mismo que calculosDe para lo esperado, el libro y los arqueos", async () => {
  for (const semilla of [7, 21, 1234]) {
    await reiniciarBase();
    const S = generarDatos(semilla);
    for (const p of Object.values(S.pedidos)) if (p.valorCobrado < 0) p.valorCobrado = 0;
    await guardarEstado(JSON.parse(JSON.stringify(S)));
    const completo = await calculosDe(pool), esperado = completo.esperadoArqueo();
    assert.ok(Object.values(esperado.e).some(v => v), "hay plata esperada (semilla " + semilla + ")");
    const cliente = await pool.connect(); // también dentro de una transacción (así lo usa hacerArqueo)
    try {
      await cliente.query("BEGIN");
      for (const c of [pool, cliente]) {
        const solo = await calculosDeArqueo(c);
        assert.deepEqual(r(solo.esperadoArqueo()), r(esperado), "esperado, semilla " + semilla);
        assert.deepEqual(r(solo.arqueosCaja()), r(completo.arqueosCaja()), "arqueos, semilla " + semilla);
        const libro = L => L.map(x => [x.fecha, x.valor, x.medio, x.cat, x.ref ?? null]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
        assert.deepEqual(r(libro(solo.libroCaja())), r(libro(completo.libroCaja())), "libro de caja, semilla " + semilla);
      }
      await cliente.query("COMMIT");
    } finally { cliente.release(); }
  }
});
