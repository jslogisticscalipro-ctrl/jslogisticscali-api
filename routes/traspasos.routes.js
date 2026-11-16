import { Router } from "express";
import * as C from "../controllers/traspasos.controller.js";
import * as V from "../validators/traspasos.validator.js";
import { validar } from "../middleware/validar.js";
import { permitir } from "../middleware/autorizar.js";
import { limiteTraspaso } from "../middleware/seguridad.js";

// Solo el mensajero escanea: es quien recibe el paquete. El código es corto, así que hay límite de intentos por cuenta.
const r = Router();
r.post("/vista-previa", permitir("mensajero"), limiteTraspaso, validar({ body: V.codigo }), C.vistaPrevia);
r.post("/canjear", permitir("mensajero"), limiteTraspaso, validar({ body: V.codigo }), C.canjear);
export default r;
