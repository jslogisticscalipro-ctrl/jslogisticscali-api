/* sueldosDia agrupa las guías por día una sola vez por instancia. La regla en sí la cubre equivalencia.test.js (contra la
   app); aquí se comprueba que el índice no cambia nada: pedir los días en otro orden o de nuevo da lo mismo, y cada día
   trae exactamente las guías cerradas de ese día. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { generarDatos } from "./generador.js";
import { crearCalculos } from "../helpers/calculos.js";
import { hoy, moverDia, semanaDe, moverSemana } from "../helpers/fechas.js";

test("sueldosDia no depende del orden ni de las veces que se pida", () => {
  const S = generarDatos(7), copia = () => JSON.parse(JSON.stringify(S));
  const dias = [...Array(40)].map((_, i) => moverDia(hoy(), -i));
  const a = crearCalculos(copia(), { corteRemoto: 0 }), b = crearCalculos(copia(), { corteRemoto: 0 });
  const primero = dias.map(d => a.sueldosDia(d));
  const alReves = [...dias].reverse().map(d => b.sueldosDia(d)).reverse();
  assert.deepEqual(alReves, primero);
  assert.deepEqual(dias.map(d => a.sueldosDia(d)), primero);
  assert.ok(primero.some(x => Object.keys(x.res).length), "algún día tiene sueldos");
  const sem = semanaDe(hoy());
  for (let i = 0; i < 4; i++) assert.deepEqual(a.resumenSemana(moverSemana(sem, -i)), b.resumenSemana(moverSemana(sem, -i)));
});
