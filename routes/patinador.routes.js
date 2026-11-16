import { Router } from "express";
import * as C from "../controllers/patinador.controller.js";
import * as V from "../validators/patinador.validator.js";
import { validar } from "../middleware/validar.js";
import { permitir, OFICINA } from "../middleware/autorizar.js";

// Caja del patinador. Él anota en su propia caja; administración puede anotar en la de cualquier patinador (como en el
// modo Mensajero) y la oficina puede consultarlas.
const r = Router();
r.get("/caja", permitir("patinador", OFICINA), validar({ query: V.caja }), C.caja);
r.get("/solicitudes", permitir("patinador", OFICINA), validar({ query: V.solicitudes }), C.solicitudes);
r.post("/solicitudes/:guia/recogido", permitir("patinador", OFICINA), validar({ params: V.paramGuiaRecogida }), C.marcarRecogido);
r.delete("/solicitudes/:guia/recogido", permitir("patinador", OFICINA), validar({ params: V.paramGuiaRecogida }), C.deshacerRecogido);
r.get("/recogidas", permitir("patinador", OFICINA), validar({ query: V.recogidas }), C.recogidas);
r.post("/recogidas/:guia/qr", permitir(OFICINA), validar({ params: V.paramGuiaRecogida }), C.generarQr);
r.get("/resumen", permitir(OFICINA), C.resumen); // bloque Patinadores de Caja → Mensajeros
r.post("/caja", permitir("patinador", "admin"), validar({ body: V.registro }), C.registrar);
export default r;
