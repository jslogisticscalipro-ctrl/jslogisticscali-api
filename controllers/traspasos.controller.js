/* QR de traspaso de una guía de patinador a mensajero. Las reglas están en servicios/traspasos.js. */
import * as Servicio from "../servicios/traspasos.js";
import { ctxDe } from "./accion.js";

/** POST /traspasos/vista-previa { codigo } → { guia, remitente, destinatarioNombre, direccionEntrega, paquetes, patinadorNombre, vence, yaEsTuyo }. */
export async function vistaPrevia(req, res) {
  res.json({ traspaso: await Servicio.vistaPrevia(ctxDe(req), req.valido.body.codigo) });
}

/** POST /traspasos/canjear { codigo } → { traspaso: { guia, yaEsTuyo } }. */
export async function canjear(req, res) {
  res.json({ traspaso: await Servicio.canjear(ctxDe(req), req.valido.body.codigo) });
}
