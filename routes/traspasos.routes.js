import { Router } from "express";
import * as C from "../controllers/traspasos.controller.js";
import * as V from "../validators/traspasos.validator.js";
import { validar } from "../middleware/validar.js";
import { permitir, OFICINA } from "../middleware/autorizar.js";
import { limiteTraspaso } from "../middleware/seguridad.js";

// Escanea el mensajero (quien recibe el paquete) o la oficina en su modo Mensajero, diciendo a nombre de quién. El código es corto, así que hay límite de intentos por cuenta.
const r = Router();
r.post("/vista-previa", permitir("mensajero", OFICINA), limiteTraspaso, validar({ body: V.codigo }), C.vistaPrevia);
r.post("/canjear", permitir("mensajero", OFICINA), limiteTraspaso, validar({ body: V.codigo }), C.canjear);
export default r;
