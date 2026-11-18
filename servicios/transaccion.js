/* Escrituras con las mismas reglas que guardar()/actualizar()/borrar() de la app:
   - guardar y actualizar dejan el cambio en el historial;
   - borrar deja una copia en la papelera (si la colección la usa) y lo anota en el historial.
   Todo pasa dentro de una transacción; al terminar bien se avisa a las pantallas abiertas qué colecciones cambiaron. */
import { MODELOS, Papelera } from "../models/documentos.js";
import { PAPELERA_COLS } from "../helpers/constantes.js";
import { nuevoId } from "../helpers/ids.js";
import { logCambio } from "./historial.js";

/** Ejecuta fn(t) en una transacción. t = { c, actor, ctx, cambios, quitados }.
    quitados: guías que alguna pantalla debe sacar de su lista ya (borradas, o pasadas a otro mensajero). Van en el aviso
    para que el panel del mensajero no espere la recarga completa de pedidos, que tiene una pausa mínima de 45 s. */
export async function enTransaccion(ctx, fn) {
  const cambios = new Set(), quitados = [];
  const r = await ctx.db.transaccion(c => fn({ c, actor: ctx.actor, ctx, cambios, quitados }));
  if (cambios.size) ctx.eventos?.emitir([...cambios], quitados.length ? { pedidosQuitados: quitados } : undefined);
  return r;
}

/** Anota una guía que sale de la lista de alguien. todos: true si sale de todas (borrada); false si solo la pierde su mensajero anterior. */
function quitar(t, p, todos) {
  if (!p || !t.quitados) return;
  t.quitados.push({ guia: p.guia, mensajeroId: p.mensajeroId || "", clienteId: p.clienteId || "", todos });
}

const modelo = col => { const m = MODELOS[col]; if (!m) throw new Error("Colección desconocida: " + col); return m; };

export async function guardar(t, col, doc, { log = true } = {}) {
  const m = modelo(col), id = doc[m.pk];
  const antes = log ? await m.obtener(t.c, id) : null;
  const d = await m.guardar(t.c, doc);
  t.cambios.add(col);
  if (log) await logCambio(t, antes ? "editar" : "crear", col, id, doc, antes);
  return d;
}
/** Cambia campos de un documento existente. Si no existe, devuelve null (la app recibía "not-found"). */
export async function actualizar(t, col, id, cambios, { log = true, antes } = {}) {
  const m = modelo(col);
  if (log && !antes) antes = await m.obtener(t.c, id);
  const d = await m.actualizar(t.c, id, cambios);
  if (!d) return null;
  t.cambios.add(col);
  if (col === "pedidos" && antes?.mensajeroId && cambios.mensajeroId !== undefined && cambios.mensajeroId !== antes.mensajeroId) quitar(t, antes, false);
  if (log) await logCambio(t, "editar", col, id, cambios, antes);
  return d;
}
/** Borra un documento. grupo: para restaurar juntos lo que se borró junto. */
export async function borrar(t, col, id, { grupo, sinPapelera = false, log = true } = {}) {
  const m = modelo(col);
  const antes = await m.borrar(t.c, id);
  if (!antes) return null;
  t.cambios.add(col);
  if (col === "pedidos") quitar(t, antes, true);
  if (!sinPapelera && PAPELERA_COLS.includes(col)) {
    await Papelera.guardar(t.c, { col, docId: id, data: antes, uid: t.actor?.uid || "", grupo: grupo || nuevoId() });
    t.cambios.add("papelera");
  }
  if (log) await logCambio(t, "borrar", col, id, null, antes);
  return antes;
}
