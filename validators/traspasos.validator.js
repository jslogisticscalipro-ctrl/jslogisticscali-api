/* QR de traspaso: el código llega tal como lo escribe o lo lee la cámara; el servicio lo limpia y lo valida. */
import { z } from "zod";
import { id } from "./comunes.js";

export const codigo = z.object({ codigo: z.string().trim().min(1, "Escribe el código").max(120, "Ese código no es válido"),
  mensajeroId: id.optional() // solo la oficina (modo Mensajero): a nombre de quién se recibe; el mensajero lo recibe siempre a su nombre
}).strict();
