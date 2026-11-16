/* Recogida con patinador y traspaso por QR.
   1. El patinador marca una guía suya "aceptado" como recogida (marcarRecogido). La guía no cambia de estado ni de dueño.
   2. La oficina genera un QR (generarQr): un código aleatorio de un solo uso; en la base solo queda su HMAC.
   3. Un mensajero lo escanea (vistaPrevia y canjear): la guía YA EXISTENTE pasa a su nombre y sigue "aceptado", para que
      haga "Recoger" (foto inicial) como con cualquier guía asignada. No se crea ninguna guía.
   Todo con la guía bloqueada (FOR UPDATE), así dos escaneos a la vez no se pisan. */
import { createHmac, randomInt } from "node:crypto";
import { env } from "../config/env.js";
import { Pedidos } from "../models/documentos.js";
import * as Mensajero from "../models/mensajero.model.js";
import * as Recogida from "../models/recogidaPatinador.model.js";
import { HttpError } from "../helpers/errores.js";
import { enTransaccion, actualizar } from "./transaccion.js";
import { registrar } from "./historial.js";
import { noEncontrado, permisoNegado, conflicto } from "./errores.js";
import { exigirOficina } from "./contexto.js";

// Sin I, L, O ni U: no se confunden al leerlos o escribirlos a mano.
const ALFABETO = "0123456789ABCDEFGHJKMNPQRSTVWXYZ", LARGO = 10;
export const codigoNuevo = () => Array.from({ length: LARGO }, () => ALFABETO[randomInt(ALFABETO.length)]).join("");
/** Acepta minúsculas, guion o espacios, y las letras que se confunden (O→0, I y L→1). Devuelve null si no tiene la forma. */
export function limpiarCodigo(x) {
  const c = String(x ?? "").toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
  return c.length === LARGO && [...c].every(ch => ALFABETO.includes(ch)) ? c : null;
}
export const hashCodigo = c => createHmac("sha256", env.JWT_SECRET).update("traspaso-qr:" + c).digest("hex");

const NO_EXISTE = "La guía no existe";
const CODIGO_MALO = () => new HttpError(400, "CODIGO_INVALIDO", "Ese código no sirve o ya venció. Pídele a administración uno nuevo.");

const esPatinador = a => a?.rol === "patinador";
const exigirPatinadorUOficina = a => { if (!esPatinador(a) && !a?.esOficina) throw permisoNegado(); };
const exigirMensajero = a => { if (a?.rol !== "mensajero" || !a.mensajeroId) throw permisoNegado("Solo un mensajero con su nombre vinculado en Personal puede recibir un paquete por QR."); };

async function guiaDeRecogida(t, guia) {
  const p = await Pedidos.obtener(t.c, guia, { bloquear: true });
  if (!p) throw noEncontrado(NO_EXISTE);
  return p;
}

/** El patinador (o la oficina por él) marca que ya tiene el paquete. Repetirlo no hace nada. */
export async function marcarRecogido(ctx, guia) {
  const a = ctx.actor;
  exigirPatinadorUOficina(a);
  return enTransaccion(ctx, async t => {
    const p = await guiaDeRecogida(t, guia);
    if (esPatinador(a) && p.mensajeroId !== a.mensajeroId) throw noEncontrado(NO_EXISTE);
    const dueno = await Mensajero.buscarPorId(p.mensajeroId, t.c);
    if (dueno?.tipo !== "patinador") throw conflicto("Esa guía no está asignada a un patinador.", undefined, "NO_ES_PATINADOR");
    if (p.estado !== "aceptado") throw conflicto("Ese pedido ya no está por recoger.", undefined, p.estado === "pendiente" ? "YA_RECOGIDO" : "YA_CERRADA");
    const fila = await Recogida.crear(t.c, { guia, patinadorId: p.mensajeroId, uid: a.uid });
    if (fila) await registrar(t, `Marcó ${guia} como recogido por ${dueno.nombre} (queda por pasar a un mensajero)`, { col: "pedidos", id: guia });
    t.cambios.add("pedidos");
    return { guia, recogido: true };
  });
}

/** Deshacer una recogida marcada por error: el patinador, mientras no pasen TRASPASO_DESHACER_MINUTOS; la oficina siempre. Solo si nadie canjeó el QR. */
export async function deshacerRecogido(ctx, guia) {
  const a = ctx.actor;
  exigirPatinadorUOficina(a);
  return enTransaccion(ctx, async t => {
    const p = await guiaDeRecogida(t, guia);
    if (esPatinador(a) && p.mensajeroId !== a.mensajeroId) throw noEncontrado(NO_EXISTE);
    const fila = await Recogida.obtenerBloqueada(t.c, guia);
    if (!fila) return { guia, recogido: false };
    if (fila.traspasadoEn) throw conflicto("Ese paquete ya se le pasó a un mensajero.", undefined, "YA_TRASPASADO");
    if (esPatinador(a) && Date.now() - new Date(fila.recogidoEn).getTime() > env.TRASPASO_DESHACER_MINUTOS * 60_000)
      throw conflicto("Ya pasó el tiempo para deshacerlo: pídele a administración que lo corrija.", undefined, "TIEMPO_VENCIDO");
    await Recogida.borrar(t.c, guia);
    await registrar(t, `Deshizo la recogida de ${guia}: vuelve a estar por recoger`, { col: "pedidos", id: guia });
    t.cambios.add("pedidos");
    return { guia, recogido: false };
  });
}

/** La oficina genera (o reemplaza) el QR. El código solo se devuelve aquí: en la base queda su HMAC. */
export async function generarQr(ctx, guia) {
  const a = ctx.actor;
  exigirOficina(a);
  return enTransaccion(ctx, async t => {
    const p = await guiaDeRecogida(t, guia);
    const fila = await Recogida.obtenerBloqueada(t.c, guia);
    if (!fila) throw conflicto("Esa guía todavía no la marca como recogida el patinador.", undefined, "SIN_RECOGER");
    if (fila.traspasadoEn || p.estado !== "aceptado" || p.mensajeroId !== fila.patinadorId)
      throw conflicto("Esa guía ya no está con el patinador.", undefined, "YA_TRASPASADO");
    const codigo = codigoNuevo();
    const vence = await Recogida.ponerCodigo(t.c, { guia, hash: hashCodigo(codigo), minutos: env.TRASPASO_QR_MINUTOS, uid: a.uid });
    await registrar(t, `Generó el QR para pasar ${guia} a un mensajero`, { col: "pedidos", id: guia });
    return { guia, codigo, vence };
  });
}

/** Busca el código y revisa que siga sirviendo. Con `bloquear` toma el candado de la guía antes de mirar nada más. */
async function resolver(t, codigoCrudo) {
  const codigo = limpiarCodigo(codigoCrudo);
  if (!codigo) throw CODIGO_MALO();
  const fila = await Recogida.obtenerPorCodigoBloqueada(t.c, hashCodigo(codigo));
  if (!fila) throw CODIGO_MALO();
  const p = await Pedidos.obtener(t.c, fila.guia, { bloquear: true });
  return { fila, p };
}

/** Lo que el mensajero ve antes de confirmar. Solo lo mínimo para reconocer el paquete: nada de teléfonos. */
export async function vistaPrevia(ctx, codigoCrudo) {
  const a = ctx.actor;
  exigirMensajero(a);
  return enTransaccion(ctx, async t => {
    const { fila, p } = await resolver(t, codigoCrudo);
    if (fila.traspasadoEn) {
      if (fila.traspasadoA === a.mensajeroId) return { ...(await resumen(t, p, fila)), yaEsTuyo: true };
      throw yaLoTiene(await Mensajero.buscarPorId(fila.traspasadoA, t.c));
    }
    if (new Date(fila.codigoVence) <= new Date()) throw CODIGO_MALO();
    if (!p || p.estado !== "aceptado" || p.mensajeroId !== fila.patinadorId) throw conflicto("Ese paquete cambió. Pídele a administración un QR nuevo.", undefined, "TRASPASO_CAMBIO");
    return { ...(await resumen(t, p, fila)), yaEsTuyo: false };
  });
}

const yaLoTiene = m => conflicto(`Ese paquete ya lo tiene ${m?.nombre || "otro mensajero"}.`, undefined, "CODIGO_USADO");

async function resumen(t, p, fila) {
  const r = await t.c.query(
    `SELECT s.destinatario_nombre, s.direccion_entrega, s.paquetes, coalesce(c.nombre, s.nombre) AS remitente, m.nombre AS patinador_nombre
     FROM solicitudes s LEFT JOIN clientes c ON c.id = $2 JOIN mensajeros m ON m.id = $3 WHERE s.guia = $1`, [p.guia, p.clienteId || null, fila.patinadorId]);
  const f = r.rows[0] || {};
  return { guia: p.guia, remitente: f.remitente || "", destinatarioNombre: f.destinatario_nombre || "", direccionEntrega: f.direccion_entrega || "",
    paquetes: f.paquetes || 1, patinadorNombre: f.patinador_nombre || "", vence: fila.codigoVence };
}

/** El mensajero se queda con el paquete. Escanear dos veces el mismo QR da el mismo resultado; otro mensajero recibe 409. */
export async function canjear(ctx, codigoCrudo) {
  const a = ctx.actor;
  exigirMensajero(a);
  return enTransaccion(ctx, async t => {
    const { fila, p } = await resolver(t, codigoCrudo);
    if (fila.traspasadoEn) {
      if (fila.traspasadoA === a.mensajeroId) return { guia: fila.guia, yaEsTuyo: true };
      throw yaLoTiene(await Mensajero.buscarPorId(fila.traspasadoA, t.c));
    }
    if (new Date(fila.codigoVence) <= new Date()) throw CODIGO_MALO();
    if (!p || p.estado !== "aceptado" || p.mensajeroId !== fila.patinadorId) throw conflicto("Ese paquete cambió. Pídele a administración un QR nuevo.", undefined, "TRASPASO_CAMBIO");
    const m = await Mensajero.buscarPorId(a.mensajeroId, t.c);
    if (!m || !m.activo || m.tipo !== "mensajero") throw permisoNegado("Tu ficha no puede recibir paquetes. Pídele a administración que la revise.");
    await actualizar(t, "pedidos", p.guia, { mensajeroId: m.id }, { antes: p });
    await t.c.query(`UPDATE solicitudes SET mensajero_id = $2, actualizado = now() WHERE guia = $1`, [p.guia, m.id]);
    await Recogida.cerrar(t.c, { guia: p.guia, mensajeroId: m.id, uid: a.uid });
    await registrar(t, `${m.nombre} recibió ${p.guia} del patinador por QR (ya la puede recoger con foto)`, { col: "pedidos", id: p.guia });
    t.cambios.add("solicitudes");
    return { guia: p.guia, yaEsTuyo: false };
  });
}

