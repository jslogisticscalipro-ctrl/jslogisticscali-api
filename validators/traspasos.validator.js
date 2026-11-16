/* QR de traspaso: el código llega tal como lo escribe o lo lee la cámara; el servicio lo limpia y lo valida. */
import { z } from "zod";

export const codigo = z.object({ codigo: z.string().trim().min(1, "Escribe el código").max(120, "Ese código no es válido") }).strict();
