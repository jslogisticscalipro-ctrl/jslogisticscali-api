/* Avisos en tiempo real por Server-Sent Events (GET /api/eventos).
   Cuando una transacción termina bien, se avisa qué colecciones cambiaron; cada pantalla vuelve a pedir lo suyo.
   A cada cuenta solo le llegan avisos de lo que puede leer.
   Sirve con una sola instancia del servidor (lo normal en Render). Con varias, habría que cambiarlo por LISTEN/NOTIFY de Postgres. */
import { EventEmitter } from "node:events";

const bus = new EventEmitter();
bus.setMaxListeners(500);

/** Las guías quitadas que esa cuenta tenía en su lista: la oficina, las borradas; el mensajero, las suyas; el cliente, las de su ficha.
    Así nadie se entera del número de una guía que no podía ver. */
function quitadosPara(lista, { esOficina, mensajeroId, clienteId }) {
  if (!Array.isArray(lista)) return [];
  return lista.filter(q => (q.todos && esOficina) || (mensajeroId && q.mensajeroId === mensajeroId) || (q.todos && clienteId && q.clienteId === clienteId)).map(q => q.guia);
}

export const eventos = {
  /** meta.solicitudClienteId: si viene (aunque sea null), solo esa cuenta cliente recibe el aviso; null = solo oficina.
      meta.pedidosQuitados: [{ guia, mensajeroId, clienteId, todos }] guías que salen de la lista (ver transaccion.js). */
  emitir(cols, meta) { if (cols?.length) bus.emit("cambio", { cols, ...(meta || {}) }); },
  /** Deja abierta la respuesta y le escribe los avisos. visibles: colecciones que esa cuenta puede leer.
      opciones.clienteId / esOficina permiten filtrar los avisos de solicitudes de otros clientes. */
  conectar(req, res, visibles, opciones = {}) {
    res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    res.write("retry: 5000\n\n");
    const alCambiar = evento => {
      const cols = Array.isArray(evento) ? evento : evento?.cols;
      if (!cols?.length) return;
      const mias = cols.filter(c => visibles.includes(c));
      if (!mias.length) return;
      // Los avisos de solicitudes llevan la ficha destino. La oficina ve todas; un cliente solo las suyas.
      if (Object.prototype.hasOwnProperty.call(evento, "solicitudClienteId") && !opciones.esOficina) {
        if (!evento.solicitudClienteId || evento.solicitudClienteId !== opciones.clienteId) return;
      }
      const quitados = mias.includes("pedidos") ? quitadosPara(evento.pedidosQuitados, opciones) : [];
      res.write(`event: cambio\ndata: ${JSON.stringify({
        cols: mias, t: Date.now(),
        ...(evento.solicitudClienteId ? { solicitudClienteId: evento.solicitudClienteId } : {}),
        ...(quitados.length ? { pedidosQuitados: quitados } : {})
      })}\n\n`);
    };
    const latido = setInterval(() => res.write(": latido\n\n"), 25000); // que los proxies no corten la conexión
    bus.on("cambio", alCambiar);
    req.on("close", () => { clearInterval(latido); bus.off("cambio", alCambiar); });
  },
  get conectados() { return bus.listenerCount("cambio"); }
};
