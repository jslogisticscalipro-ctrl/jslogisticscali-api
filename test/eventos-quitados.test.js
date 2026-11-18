/* Avisos en tiempo real de guías que salen de una lista (borradas o pasadas a otro mensajero): a cada cuenta solo le llega
   el número de las guías que tenía. No necesita base de datos. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { eventos } from "../servicios/eventos.js";

/** Abre una conexión SSE falsa y devuelve los avisos que le llegan. */
function conectar(visibles, opciones) {
  const req = new EventEmitter(), escritos = [];
  const res = { writeHead() {}, write: x => escritos.push(x) };
  eventos.conectar(req, res, visibles, opciones);
  return {
    avisos: () => escritos.filter(x => x.startsWith("event: cambio")).map(x => JSON.parse(x.split("data: ")[1])),
    cerrar: () => req.emit("close")
  };
}

test("la guía borrada le llega a la oficina, a su mensajero y a su cliente; no a otro mensajero", () => {
  const oficina = conectar(["pedidos"], { esOficina: true, clienteId: "", mensajeroId: "" });
  const carlos = conectar(["pedidos"], { esOficina: false, clienteId: "", mensajeroId: "m1" });
  const diana = conectar(["pedidos"], { esOficina: false, clienteId: "", mensajeroId: "m2" });
  const tienda = conectar(["pedidos"], { esOficina: false, clienteId: "c1", mensajeroId: "" });
  try {
    eventos.emitir(["pedidos", "papelera"], { pedidosQuitados: [{ guia: "JS-00009", mensajeroId: "m1", clienteId: "c1", todos: true }] });
    assert.deepEqual(oficina.avisos()[0].pedidosQuitados, ["JS-00009"]);
    assert.deepEqual(carlos.avisos()[0].pedidosQuitados, ["JS-00009"]);
    assert.deepEqual(tienda.avisos()[0].pedidosQuitados, ["JS-00009"]);
    assert.equal(diana.avisos()[0].pedidosQuitados, undefined, "otro mensajero no se entera del número");
  } finally { [oficina, carlos, diana, tienda].forEach(x => x.cerrar()); }
});

test("una guía pasada a otro mensajero solo sale de la lista del anterior", () => {
  const oficina = conectar(["pedidos"], { esOficina: true, clienteId: "", mensajeroId: "" });
  const carlos = conectar(["pedidos"], { esOficina: false, clienteId: "", mensajeroId: "m1" });
  try {
    eventos.emitir(["pedidos"], { pedidosQuitados: [{ guia: "JS-00010", mensajeroId: "m1", clienteId: "", todos: false }] });
    assert.deepEqual(carlos.avisos()[0].pedidosQuitados, ["JS-00010"]);
    assert.equal(oficina.avisos()[0].pedidosQuitados, undefined, "la oficina la sigue viendo");
  } finally { [oficina, carlos].forEach(x => x.cerrar()); }
});
