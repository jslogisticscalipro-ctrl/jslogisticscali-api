/* Ayudas comunes de los servicios: quién hace la petición, cargar el estado para calcular y validar datos.
   Los servicios reciben ctx = { actor, db, eventos } (lo arma controllers/accion.js). */
import { cargarEstado, COLS_ESTADO, Meta, enTransaccion, MODELOS } from "../models/documentos.js";
import { crearCalculos, tipoDe } from "../helpers/calculos.js";
import { datosInvalidos, permisoNegado, yaContadoError } from "./errores.js";
import { esDia, hoy } from "../helpers/fechas.js";
import { MEDIOS } from "../helpers/constantes.js";

/** Quien hace la petición, con los nombres que usan las reglas de la app (firestore.rules). */
export function actorDe(u) {
  if (!u) return null;
  const rol = u.rol;
  return {
    uid: u.id, email: u.email, nombre: u.nombre || u.email || "", rol, clienteId: u.clienteId || "", mensajeroId: u.mensajeroId || "",
    esAdmin: rol === "admin", esAsistente: rol === "asistente", esOficina: rol === "admin" || rol === "asistente",
    esEquipo: rol === "admin" || rol === "asistente" || rol === "mensajero", esCliente: rol === "cliente"
  };
}

/** Carga las colecciones indicadas (por defecto todo el estado S) y devuelve los cálculos de la app sobre ellas. */
export async function calculosDe(c, cols = COLS_ESTADO) {
  const S = await cargarEstado(c, cols), corteRemoto = await Meta.corte(c);
  return crearCalculos(S, { corteRemoto });
}

/** Los cálculos de UN mensajero (su período abierto, su sueldo de la semana, sus adelantos) leyendo solo lo suyo: sus
    guías (y las de sus liquidaciones), recaudos, bases y adelantos, pagos que recibió en la calle, liquidaciones y
    jornadas. Da lo mismo que `calculosDe` para `periodoMensajero(mid)`, `sueldoPersonaSemana(mid, …)`, `sinDescuento(mid, …)`
    y `semanasAdelanto()` (lo prueba test/periodo-mensajero.test.js); cualquier otro cálculo (saldos, caja, otras personas)
    debe usar `calculosDe`. El dueño y la oficina cobran lo que dejan los demás: para ellos se carga todo, como antes. */
export async function calculosDeMensajero(c, mid) {
  const mensajeros = await MODELOS.mensajeros.listar(c);
  const m = mensajeros.find(x => x.id === mid);
  if (["dueno", "oficina"].includes(tipoDe(m))) return calculosDe(c);
  const S = Object.fromEntries(COLS_ESTADO.map(k => [k, {}]));
  for (const x of mensajeros) S.mensajeros[x.id] = x;
  const leer = async (col, filtro) => { const mod = MODELOS[col]; for (const d of await mod.listar(c, { filtro })) S[col][d[mod.pk]] = d; };
  const lecturas = [
    () => leer("liquidaciones", { mensajeroId: mid }), () => leer("recaudos", { mensajeroId: mid }), () => leer("cajamovs", { personaId: mid }),
    () => leer("movimientos", { mensajeroId: mid }), () => leer("jornadas", { personaId: mid }), () => leer("pedidos", { mensajeroId: mid })
  ];
  // pg no deja dos consultas a la vez dentro de una transacción (un solo cliente).
  if (enTransaccion(c)) for (const f of lecturas) await f(); else await Promise.all(lecturas.map(f => f()));
  // Las guías de sus liquidaciones que hoy son de otra persona (si se reasignaron) también entran en el ajuste.
  const otras = [...new Set(Object.values(S.liquidaciones).flatMap(l => l.guias || []))].filter(g => !S.pedidos[g]);
  if (otras.length) for (const d of await MODELOS.pedidos.listar(c, { filtro: { guia: { in: otras } } })) S.pedidos[d.guia] = d;
  return crearCalculos(S, { corteRemoto: 0 });
}

/** Los cálculos de la caja de UNA oficina (`cajaOficina(auid)`) leyendo solo lo de esa persona: sus movimientos de caja
    (cierres, sobrantes, bases que dio, cuentas internas), las entregas y pagos que recibió y los domicilios que pagó.
    Da lo mismo que `calculosDe` para `cajaOficina(auid)` (lo prueba test/caja-respuestas.test.js); para otra cosa, usa `calculosDe`. */
export async function calculosDeOficina(c, auid) {
  const S = Object.fromEntries(COLS_ESTADO.map(k => [k, {}]));
  const poner = (col, docs) => { const mod = MODELOS[col]; for (const d of docs) S[col][d[mod.pk]] = d; };
  const todo = col => MODELOS[col].listar(c);
  const filtrado = (col, filtro) => MODELOS[col].listar(c, { filtro });
  const lecturas = [
    ["mensajeros", () => todo("mensajeros")], ["clientes", () => todo("clientes")], ["cuentas", () => todo("cuentas")],
    ["cajamovs", () => filtrado("cajamovs", [{ personaUid: auid }, { porUid: auid }])],
    ["recaudos", () => filtrado("recaudos", { porUid: auid })],
    ["movimientos", () => filtrado("movimientos", { porUid: auid })],
    ["pedidos", () => filtrado("pedidos", { domiPagoUid: auid })]
  ];
  // pg no deja dos consultas a la vez dentro de una transacción (un solo cliente).
  if (enTransaccion(c)) for (const [col, f] of lecturas) poner(col, await f());
  else for (const [col, docs] of await Promise.all(lecturas.map(async ([col, f]) => [col, await f()]))) poner(col, docs);
  return crearCalculos(S, { corteRemoto: 0 });
}

/** Las mismas cuentas del arqueo (yaContado, fechaCaja, diaAntesDelArqueo, textoContado…) sin cargar toda la caja:
    basta con la hora del último arqueo, que sale de una sola consulta (Meta.corteCompleto). Úsalo cuando solo se
    valida una fecha contra lo ya contado; si hace falta algo más de la caja, usa calculosDe. */
export async function calculosDeCorte(c) {
  const S = await cargarEstado(c, []);
  return crearCalculos(S, { corteRemoto: await Meta.corteCompleto(c) });
}

/* ---- permisos (equivalentes a las funciones de firestore.rules) ---- */
export const exigirAdmin = a => { if (!a?.esAdmin) throw permisoNegado("Solo administración puede hacer esto."); };
export const exigirOficina = a => { if (!a?.esOficina) throw permisoNegado("Solo la oficina puede hacer esto."); };
export const exigirEquipo = a => { if (!a?.esEquipo) throw permisoNegado(); };
export const esMio = (a, mid) => !!a?.mensajeroId && mid === a.mensajeroId;

/* ---- validaciones con los mismos mensajes que la app ---- */
export const numero = v => (v === "" || v === null || v === undefined ? NaN : Number(v));
export function valorPositivo(v, msg = "Escribe un valor mayor a cero") {
  const n = numero(v);
  if (!(n > 0)) throw datosInvalidos(msg);
  return Math.round(n);
}
export function medioValido(m, msg = "Elige el medio de pago") {
  if (!MEDIOS[m]) throw datosInvalidos(msg);
  return m;
}
/** Día de un movimiento: AAAA-MM-DD, sin pasar de hoy. Vacío = hoy. */
export function diaValido(d) {
  const dia = d || hoy();
  if (!esDia(dia)) throw datosInvalidos("El día no es válido (AAAA-MM-DD).");
  if (dia > hoy()) throw datosInvalidos("No se pueden registrar movimientos de días que no han llegado.");
  return dia;
}
export const texto = (v, max = 500) => String(v ?? "").trim().slice(0, max);
export function exigirNoContado(calc, fecha) {
  if (calc.yaContado(fecha)) throw yaContadoError(calc.textoContado());
}
export function exigirDiaAbierto(calc, dia) {
  const msg = calc.diaAntesDelArqueo(dia);
  if (msg) throw yaContadoError(msg);
}
