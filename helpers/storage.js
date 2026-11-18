/* Supabase Storage por su API REST, con la service role key (solo en el servidor, nunca en el frontend).
   El bucket debe ser privado: el navegador recibe URL firmadas que vencen. */
import { env } from "../config/env.js";

export const storageConfigurado = () => !!(env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY);

const cabeceras = () => ({
  Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
  apikey: env.SUPABASE_SERVICE_ROLE_KEY,
  "Content-Type": "application/json"
});

/** URL firmadas para varias rutas del bucket. Devuelve { ruta: url }; si Storage no está configurado, {}. */
export async function firmarUrls(rutas, segundos = 3600) {
  if (!rutas.length || !storageConfigurado()) return {};
  const r = await fetch(`${env.SUPABASE_URL}/storage/v1/object/sign/${encodeURIComponent(env.STORAGE_BUCKET)}`, {
    method: "POST",
    headers: cabeceras(),
    body: JSON.stringify({ expiresIn: segundos, paths: rutas })
  });
  if (!r.ok) throw new Error(`Supabase Storage respondió ${r.status} al firmar URL`);
  const lista = await r.json();
  const out = {};
  for (const x of lista) if (x.signedURL && !x.error) out[x.path] = `${env.SUPABASE_URL}/storage/v1${x.signedURL}`;
  return out;
}

/* Memoria de URL firmadas (miniaturas y fotos de los pedidos). Supabase pone la hora en cada firma, así que firmar la
   misma foto dos veces da dos URL distintas: el navegador y el CDN no pueden reusar la imagen ya bajada y la vuelven a
   descargar en cada recarga de la lista. Aquí cada ruta se firma por 2 horas y se devuelve la misma URL mientras le
   quede al menos 1 hora: quien la recibe siempre tiene una hora de uso, como antes. La memoria es por instancia y se
   olvida al borrar el archivo (`borrarArchivos`). */
const FIRMA_REUSABLE_S = 2 * 3600, MINIMO_RESTANTE_MS = 3600 * 1000, TOPE_MEMORIA = 50_000;
const memoriaFirmas = new Map(); // ruta → { url, vence (ms) }; en orden de firma, la más vieja primero

/** Como `firmarUrls`, pero repite la URL de una ruta mientras le quede al menos 1 hora. Devuelve { ruta: url }. */
export async function firmarUrlsReusables(rutas, ahora = Date.now()) {
  const out = {}, faltan = [];
  for (const r of new Set(rutas)) {
    const m = memoriaFirmas.get(r);
    if (m && m.vence - ahora >= MINIMO_RESTANTE_MS) out[r] = m.url; else faltan.push(r);
  }
  if (!faltan.length) return out;
  const nuevas = await firmarUrls(faltan, FIRMA_REUSABLE_S);
  const vence = ahora + FIRMA_REUSABLE_S * 1000;
  for (const [r, url] of Object.entries(nuevas)) {
    memoriaFirmas.delete(r); // al volver a ponerla queda al final (la más nueva)
    memoriaFirmas.set(r, { url, vence });
    out[r] = url;
  }
  for (const r of memoriaFirmas.keys()) { if (memoriaFirmas.size <= TOPE_MEMORIA) break; memoriaFirmas.delete(r); }
  return out;
}

/** Para las pruebas: olvida todas las URL firmadas. */
export const olvidarFirmas = () => memoriaFirmas.clear();

const objeto = ruta => `${env.SUPABASE_URL}/storage/v1/object/${encodeURIComponent(env.STORAGE_BUCKET)}/${ruta}`;

/** Sube un archivo al bucket. Por defecto no reemplaza: cada foto tiene un nombre nuevo que pone el servidor.
    La importación de Firestore usa `reemplazar` para poder repetirse sin error. */
export async function subirArchivo(ruta, contenido, tipoContenido, { reemplazar = false } = {}) {
  const r = await fetch(objeto(ruta), {
    method: "POST",
    headers: { ...cabeceras(), "Content-Type": tipoContenido, "x-upsert": String(reemplazar), "Cache-Control": "max-age=31536000" },
    body: contenido
  });
  if (!r.ok) throw new Error(`Supabase Storage respondió ${r.status} al subir ${ruta}`);
}

/** Borra archivos del bucket. Se usa para no dejar huérfanos si falla el registro en la base. */
export async function borrarArchivos(rutas) {
  for (const r of rutas) memoriaFirmas.delete(r);
  if (!rutas.length || !storageConfigurado()) return;
  const r = await fetch(`${env.SUPABASE_URL}/storage/v1/object/${encodeURIComponent(env.STORAGE_BUCKET)}`, {
    method: "DELETE", headers: cabeceras(), body: JSON.stringify({ prefixes: rutas })
  });
  if (!r.ok) throw new Error(`Supabase Storage respondió ${r.status} al borrar archivos`);
}
