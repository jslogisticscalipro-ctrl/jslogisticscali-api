/* Recogidas de patinador y su QR de traspaso (tabla recogidas_patinador). Las funciones reciben `db` (la conexión de la
   transacción) para que el servicio las junte con el cambio del pedido. */
import { query } from "../config/db.js";
import { filaAObjeto } from "../helpers/sql.js";

export const obtenerBloqueada = async (db, guia) =>
  filaAObjeto((await db.query(`SELECT * FROM recogidas_patinador WHERE guia = $1 FOR UPDATE`, [guia])).rows[0]);

export const obtenerPorCodigoBloqueada = async (db, hash) =>
  filaAObjeto((await db.query(`SELECT * FROM recogidas_patinador WHERE codigo_hash = $1 FOR UPDATE`, [hash])).rows[0]);

export async function crear(db, { guia, patinadorId, uid }) {
  const r = await db.query(
    `INSERT INTO recogidas_patinador (guia, patinador_id, recogido_uid) VALUES ($1, $2, $3) ON CONFLICT (guia) DO NOTHING RETURNING *`,
    [guia, patinadorId, uid]
  );
  return filaAObjeto(r.rows[0]);
}

export const borrar = (db, guia) => db.query(`DELETE FROM recogidas_patinador WHERE guia = $1`, [guia]);

/** Guarda el HMAC del código nuevo (el anterior deja de servir). `minutos` es lo que dura. */
export async function ponerCodigo(db, { guia, hash, minutos, uid }) {
  const r = await db.query(
    `UPDATE recogidas_patinador SET codigo_hash = $2, codigo_vence = now() + make_interval(mins => $3), codigo_uid = $4, codigo_creado = now()
     WHERE guia = $1 RETURNING codigo_vence`,
    [guia, hash, minutos, uid]
  );
  return r.rows[0].codigo_vence;
}

export const cerrar = (db, { guia, mensajeroId, uid }) => db.query(
  `UPDATE recogidas_patinador SET traspasado_a = $2, traspasado_en = now(), traspasado_uid = $3 WHERE guia = $1`, [guia, mensajeroId, uid]);

/** Recogidas por pasar a un mensajero (aún sin canjear), las más antiguas primero. `patinadorId` las limita a un patinador. */
export async function pendientes({ patinadorId } = {}, db = { query }) {
  const r = await db.query(
    `SELECT r.guia, r.recogido_en, r.patinador_id, m.nombre AS patinador_nombre, coalesce(c.nombre, s.nombre) AS remitente,
            s.direccion_recogida, s.direccion_entrega, s.destinatario_nombre, s.paquetes,
            CASE WHEN r.codigo_hash IS NOT NULL AND r.codigo_vence > now() THEN r.codigo_vence END AS codigo_vence
     FROM recogidas_patinador r
     JOIN pedidos p ON p.guia = r.guia AND p.estado = 'aceptado' AND p.mensajero_id = r.patinador_id
     JOIN solicitudes s ON s.guia = r.guia
     JOIN mensajeros m ON m.id = r.patinador_id
     LEFT JOIN clientes c ON c.id = p.cliente_id
     WHERE r.traspasado_en IS NULL AND ($1::text IS NULL OR r.patinador_id = $1)
     ORDER BY r.recogido_en, r.guia`,
    [patinadorId ?? null]
  );
  return r.rows.map(filaAObjeto);
}
