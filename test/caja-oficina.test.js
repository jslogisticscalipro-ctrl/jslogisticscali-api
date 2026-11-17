/* La caja de UNA oficina leyendo solo lo suyo (calculosDeOficina) tiene que dar exactamente lo mismo que cargando
   todo el sistema (calculosDe). Es la red de seguridad para que el cierre de oficina lea menos sin tocar la regla. */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { pool, reiniciarBase } from "./ayuda.js";
import { generarDatos } from "./generador.js";
import { MODELOS } from "../models/documentos.js";
import { calculosDe, calculosDeOficina } from "../servicios/contexto.js";

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
const caja = (calc, uid) => { const o = calc.cajaOficina(uid); return { saldo: o.saldo, total: o.total, L: o.L.map(x => [x.fecha, x.concepto, x.valor, x.medio, x.ref ?? null]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) }; };

test("calculosDeOficina da lo mismo que calculosDe para la caja de cada asistente", async () => {
  for (const semilla of [7, 21, 1234]) {
    await reiniciarBase();
    const S = generarDatos(semilla);
    for (const p of Object.values(S.pedidos)) if (p.valorCobrado < 0) p.valorCobrado = 0;
    await guardarEstado(JSON.parse(JSON.stringify(S)));
    const completo = await calculosDe(pool);
    const uids = Object.values(S.usuarios).filter(u => u.rol === "asistente").map(u => u.uid);
    assert.ok(uids.length, "hay asistentes");
    const cliente = await pool.connect(); // también dentro de una transacción (así lo usa el cierre)
    try {
      await cliente.query("BEGIN");
      for (const c of [pool, cliente]) for (const uid of uids) {
        const solo = await calculosDeOficina(c, uid);
        const esperado = caja(completo, uid);
        assert.ok(esperado.L.length > 0, "la caja de " + uid + " tiene movimientos (semilla " + semilla + ")");
        assert.deepEqual(r(caja(solo, uid)), r(esperado), `caja de ${uid} (semilla ${semilla})`);
      }
      await cliente.query("COMMIT");
    } finally { cliente.release(); }
  }
});
