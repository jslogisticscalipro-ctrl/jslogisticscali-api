/* Control del espacio de las fotos (Supabase Storage): cuánto ocupan, aviso al acercarse al tope y liberar espacio
   borrando guías completas, de la más antigua a la más reciente. Solo administración.

   - El espacio se mide con `pedido_archivos.bytes` (se guarda al subir cada foto): una sola suma en la base, sin recorrer el bucket.
     Si se puede leer `storage.objects` (Supabase), se usa también como medida real: incluye las fotos de guías en la papelera.
   - Lo que se borra: TODOS los archivos de la guía (salida, entrega, firma, miniatura, previas). La guía y sus datos siguen
     igual; queda marcada con `fotos_borradas` y el detalle avisa que las fotos se borraron.
   - Nunca se toca: guías por recoger o en ruta, guías con una diferencia de cobro sin revisar y guías cerradas hace menos de
     `DIAS_PROTEGIDOS` días. */
import { env } from "../config/env.js";
import { borrarArchivos, storageConfigurado } from "../helpers/storage.js";
import { datosInvalidos } from "./errores.js";
import { enTransaccion } from "./transaccion.js";
import { registrar } from "./historial.js";
import { exigirAdmin } from "./contexto.js";
import { HttpError } from "../helpers/errores.js";

export const DIAS_PROTEGIDOS = 30;
export const MAX_GUIAS_POR_VEZ = 2000;
const UMBRAL_INICIAL = 85, UMBRAL_CRITICO = 95;
const LOTE_BUCKET = 500;

const limiteBytes = () => env.FOTOS_LIMITE_MB * 1024 * 1024;
const num = x => Number(x) || 0;
const diaBogota = d => (d ? new Intl.DateTimeFormat("en-CA", { timeZone: "America/Bogota" }).format(new Date(d)) : null);
const diaCorto = dia => (dia ? dia.split("-").reverse().join("/") : "");

/** Filtro de las guías que sí se pueden liberar. $1 y $2 son el rango (desde, hasta) en días AAAA-MM-DD de Colombia, o null. */
const ELEGIBLES = `
  p.estado IN ('entregado', 'devuelto') AND p.entregado IS NOT NULL
  AND p.entregado < now() - interval '${DIAS_PROTEGIDOS} days'
  AND NOT (p.dif_cobro <> 0 AND NOT p.dif_revisada)
  AND ($1::date IS NULL OR p.entregado >= ($1::date)::timestamp AT TIME ZONE 'America/Bogota')
  AND ($2::date IS NULL OR p.entregado < (($2::date + 1))::timestamp AT TIME ZONE 'America/Bogota')`;

export async function umbralDeAviso(db) {
  const r = await db.query(`SELECT valor->>'umbral' AS u FROM ajustes WHERE clave = 'fotos'`);
  const u = Number(r.rows[0]?.u);
  return Number.isInteger(u) && u >= 50 && u <= 99 ? u : UMBRAL_INICIAL;
}

/** Lo que muestra la pestaña «Respaldo y espacio» y el aviso de Inicio. */
export async function estadoFotos(db) {
  const [r, umbral, liberable] = await Promise.all([
    db.query(`SELECT count(*)::int AS archivos, count(DISTINCT guia)::int AS guias, COALESCE(sum(bytes), 0) AS bytes,
                     count(*) FILTER (WHERE bytes IS NULL)::int AS sin_tamano, min(creado) AS mas_antigua
              FROM pedido_archivos`),
    umbralDeAviso(db),
    db.query(`SELECT count(DISTINCT p.guia)::int AS guias, count(a.id)::int AS archivos, COALESCE(sum(a.bytes), 0) AS bytes
              FROM pedidos p JOIN pedido_archivos a ON a.guia = p.guia WHERE ${ELEGIBLES}`, [null, null])
  ]);
  const f = r.rows[0];
  let usado = num(f.bytes), medida = "base";
  try { // en Supabase, los archivos del bucket están en storage.objects: es lo que Supabase cuenta (incluye la papelera)
    const o = await db.query(`SELECT COALESCE(sum((metadata->>'size')::bigint), 0) AS bytes FROM storage.objects WHERE bucket_id = $1`, [env.STORAGE_BUCKET]);
    if (num(o.rows[0].bytes) > 0) { usado = num(o.rows[0].bytes); medida = "bucket"; }
  } catch { /* sin acceso a storage.objects: se queda la suma de la base */ }
  const limite = limiteBytes(), porcentaje = Math.round((usado / limite) * 1000) / 10;
  return {
    bytes: usado, limiteBytes: limite, porcentaje, umbral, medida,
    nivel: porcentaje >= UMBRAL_CRITICO ? "critico" : porcentaje >= umbral ? "aviso" : "normal",
    archivos: f.archivos, guias: f.guias, sinTamano: f.sin_tamano, masAntigua: f.mas_antigua,
    liberable: { guias: liberable.rows[0].guias, archivos: liberable.rows[0].archivos, bytes: num(liberable.rows[0].bytes) },
    diasProtegidos: DIAS_PROTEGIDOS, storageConfigurado: storageConfigurado()
  };
}

/** Cambia a partir de qué porcentaje se muestra el aviso en Inicio. */
export async function cambiarUmbral(ctx, { umbral }) {
  exigirAdmin(ctx.actor);
  await enTransaccion(ctx, async t => {
    await t.c.query(`INSERT INTO ajustes (clave, valor) VALUES ('fotos', $1::jsonb)
      ON CONFLICT (clave) DO UPDATE SET valor = ajustes.valor || EXCLUDED.valor, actualizado = now()`, [JSON.stringify({ umbral })]);
    await registrar(t, `Cambió el aviso de espacio de fotos al ${umbral} %`);
  });
  return { umbral };
}

/** Guías que se borrarían: las más antiguas primero. cantidad = cuántas guías; desde/hasta = días de cierre (opcionales). */
async function elegir(db, { cantidad, desde, hasta }) {
  const tope = Math.min(cantidad || MAX_GUIAS_POR_VEZ, MAX_GUIAS_POR_VEZ);
  const g = await db.query(
    `SELECT p.guia, p.entregado FROM pedidos p
     WHERE ${ELEGIBLES} AND EXISTS (SELECT 1 FROM pedido_archivos a WHERE a.guia = p.guia)
     ORDER BY p.entregado ASC, p.guia ASC LIMIT $3`, [desde || null, hasta || null, tope]);
  const guias = g.rows.map(x => x.guia);
  const a = guias.length
    ? (await db.query(`SELECT ruta, bytes FROM pedido_archivos WHERE guia = ANY($1)`, [guias])).rows : [];
  return {
    guias, rutas: a.map(x => x.ruta),
    resumen: {
      guias: guias.length, archivos: a.length, bytes: a.reduce((s, x) => s + num(x.bytes), 0), sinTamano: a.filter(x => x.bytes == null).length,
      desde: diaBogota(g.rows[0]?.entregado), hasta: diaBogota(g.rows.at(-1)?.entregado), maximoPorVez: MAX_GUIAS_POR_VEZ
    }
  };
}

/** Libera espacio borrando las fotos de las guías cerradas más antiguas. Dos pasos, los dos con este mismo servicio:
    - simular: devuelve el resumen (cuántas guías, fotos, MB y de qué fechas) sin borrar nada.
    - confirmar: con `confirmar: "BORRAR"` y `guiasEsperadas` (las que mostró el resumen) borra de verdad. Si desde entonces
      cambió la lista, no borra y pide revisar otra vez. */
export async function liberar(ctx, { cantidad, desde, hasta, simular = false, confirmar, guiasEsperadas }) {
  exigirAdmin(ctx.actor);
  if (!cantidad && !desde && !hasta) throw datosInvalidos("Escribe cuántas guías quieres liberar o elige un rango de fechas.");
  if (desde && hasta && desde > hasta) throw datosInvalidos("La fecha «desde» no puede ser después de «hasta».");
  if (!storageConfigurado()) throw new HttpError(503, "FOTOS_NO_CONFIGURADAS", "Las fotos todavía no están configuradas en el servidor. Avísale a administración.");

  const { guias, rutas, resumen } = await elegir(ctx.db, { cantidad, desde, hasta });
  if (simular) return { simulacion: true, ...resumen };
  if (confirmar !== "BORRAR") throw datosInvalidos("Para borrar tienes que escribir BORRAR.");
  if (!guias.length) throw datosInvalidos("No hay fotos que se puedan borrar con ese criterio.");
  if (guiasEsperadas !== guias.length) throw new HttpError(409, "LISTA_CAMBIO", "La lista cambió desde que la revisaste. Revísala otra vez antes de borrar.");

  // Primero el bucket: si falla, no se toca la base y no queda ninguna referencia rota. Si la base falla después,
  // las fotos ya no existen y la guía simplemente no las muestra (se puede repetir).
  for (let i = 0; i < rutas.length; i += LOTE_BUCKET) await borrarArchivos(rutas.slice(i, i + LOTE_BUCKET));

  await enTransaccion(ctx, async t => {
    await t.c.query(`DELETE FROM pedido_archivos WHERE guia = ANY($1)`, [guias]);
    await t.c.query(`UPDATE pedidos SET fotos_borradas = true, actualizado = now() WHERE guia = ANY($1)`, [guias]);
    t.cambios.add("pedidos");
    const mb = (resumen.bytes / 1048576).toFixed(1).replace(".", ",");
    await registrar(t, `Liberó espacio: borró ${resumen.archivos} fotos de ${resumen.guias} guías cerradas entre el ${diaCorto(resumen.desde)} y el ${diaCorto(resumen.hasta)} (${mb} MB)`);
  });
  return { simulacion: false, ...resumen };
}
