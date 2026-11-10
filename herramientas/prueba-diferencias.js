#!/usr/bin/env node
/*
 * prueba-diferencias.js — Comprueba la penalización por colores y dibujo del motor con IA
 * (assets/motor-ia.js) con recortes sintéticos de 224x224: parejas iguales con distinta luz
 * y arrugas, y calcetines distintos (gris liso, gris con franjas rojas, rombos…).
 *
 * Uso:  node herramientas/prueba-diferencias.js
 */
'use strict';
const path = require('path');
const assets = path.join(__dirname, '..', 'app', 'src', 'main', 'assets');
globalThis.Emparejador = require(path.join(assets, 'emparejador.js'));
require(path.join(assets, 'motor-ia.js'));
const M = globalThis.MotorIA;

const LADO = 224, P = LADO * LADO;

function aleatorio(semilla) {
  let s = semilla >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

// Recorte plegado sintético: 3 tramos de calcetín lado a lado sobre fondo gris
function recorte(dibujo, semilla, luz) {
  const rnd = aleatorio(semilla);
  const rgb = new Float32Array(P * 3), cob = new Float32Array(P);
  const fase = rnd() * 6, fase2 = rnd() * 6, inclina = (rnd() - 0.5) * 0.4;
  const pliegues = [20 + rnd() * 180, 20 + rnd() * 180];
  for (let y = 0; y < LADO; y++) {
    for (let x = 0; x < LADO; x++) {
      const o = y * LADO + x;
      const tramo = Math.floor(x / 70);
      const dentro = x % 70 > 3 && x % 70 < 67 && tramo < 3 && y > 8 && y < 216;
      if (!dentro) { rgb[3 * o] = 104; rgb[3 * o + 1] = 116; rgb[3 * o + 2] = 124; continue; }
      cob[o] = 1;
      const v = tramo * 208 + y; // posición a lo largo del calcetín
      const u = x % 70;
      let c = dibujo(u, v);
      // luz y arrugas: sombreado suave, pliegues algo más oscuros y punto del tejido
      let k = luz * (1 + 0.12 * Math.sin(v / 23 + fase) + 0.08 * Math.sin(u / 11 + fase2 + inclina * v));
      for (const p of pliegues) if (Math.abs(y - p - inclina * u) < 2) k *= 0.8;
      c = c.map((ch) => Math.max(0, Math.min(255, ch * k + (rnd() - 0.5) * 10)));
      rgb[3 * o] = c[0]; rgb[3 * o + 1] = c[1]; rgb[3 * o + 2] = c[2];
    }
  }
  // el recorte real sale de un supermuestreo: algo suavizado
  const sal = new Float32Array(P * 3);
  for (let y = 0; y < LADO; y++) for (let x = 0; x < LADO; x++) {
    for (let ch = 0; ch < 3; ch++) {
      let s = 0, n = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const yy = Math.min(LADO - 1, Math.max(0, y + dy)), xx = Math.min(LADO - 1, Math.max(0, x + dx));
        s += rgb[3 * (yy * LADO + xx) + ch]; n++;
      }
      sal[3 * (y * LADO + x) + ch] = s / n;
    }
  }
  return { rgb: sal, cob };
}

const GRIS = [128, 128, 128], ROJO = [190, 40, 45], MARINO = [35, 45, 90], BLANCO = [225, 225, 220], NEGRO = [30, 30, 32];
const liso = (c) => () => c;
const franjas = (fondo, raya, periodo, ancho) => (u, v) => (v % periodo < ancho ? raya : fondo);
const rombos = (a, b, t) => (u, v) => {
  const p = (Math.abs(((u + v) % t) - t / 2) + Math.abs(((u - v + 1000 * t) % t) - t / 2)) < t / 2;
  return p ? a : b;
};
const puntaRoja = (fondo) => (u, v) => (v > 560 ? ROJO : fondo); // talón/puntera de color

const calcetines = {
  'gris liso A': [liso(GRIS), 1, 1.0],
  'gris liso B': [liso(GRIS), 2, 0.9],
  'gris franjas rojas A': [franjas(GRIS, ROJO, 60, 15), 3, 1.0],
  'gris franjas rojas B': [franjas(GRIS, ROJO, 60, 15), 4, 0.92],
  'gris raya roja fina': [franjas(GRIS, ROJO, 80, 7), 5, 1.0],
  'gris puntera roja A': [puntaRoja(GRIS), 6, 1.0],
  'gris puntera roja B (escondida)': [(u, v) => (v > 610 ? ROJO : GRIS), 7, 0.95],
  'rombos marino/gris A': [rombos(MARINO, GRIS, 40), 8, 1.0],
  'rombos marino/gris B': [rombos(MARINO, GRIS, 40), 9, 0.9],
  'marino liso': [liso(MARINO), 10, 1.0],
  'rayas blanco/negro A': [franjas(BLANCO, NEGRO, 24, 12), 11, 1.0],
  'rayas blanco/negro B': [franjas(BLANCO, NEGRO, 24, 12), 12, 0.88],
  'blanco liso': [liso(BLANCO), 13, 1.0],
};

const nombres = Object.keys(calcetines);
const desc = nombres.map((n) => { const [d, s, l] = calcetines[n]; return M.descriptor(recorte(d, s, l)); });
const pareja = (a, b) => a.replace(/ [AB]( \(.*\))?$/, '') === b.replace(/ [AB]( \(.*\))?$/, '') && a !== b;

console.log('Dibujo de cada calcetín (parte con bordes):');
nombres.forEach((n, i) => console.log(`  ${n.padEnd(34)} ${desc[i].dibujo.toFixed(3)}`));
console.log('\nPenalización (se resta al parecido; umbral Normal ≈ 0.27):');
let malIguales = 0, malDistintos = 0;
for (let a = 0; a < nombres.length; a++) {
  for (let b = a + 1; b < nombres.length; b++) {
    const p = M.penalizacion(desc[a], desc[b], false);
    const iguales = pareja(nombres[a], nombres[b]);
    const marca = iguales ? (p > 0.05 ? '  ✗ (pareja castigada)' : '  ✓ pareja') : (p < 0.1 ? '  · poca' : '');
    if (iguales && p > 0.05) malIguales++;
    if (!iguales && p < 0.1) malDistintos++;
    if (iguales || p < 0.15 || process.argv.includes('-v')) {
      console.log(`  ${nombres[a].padEnd(32)} ↔ ${nombres[b].padEnd(32)} ${p.toFixed(3)}${marca}`);
    }
  }
}
console.log(`\nParejas verdaderas castigadas: ${malIguales}. Pares distintos poco castigados (<0.10): ${malDistintos}.`);
console.log('(Con -v se listan todos los pares.)');

// ida y vuelta del descriptor guardado en el cajón
const g = M.descDeGuardado(JSON.parse(JSON.stringify(M.descAGuardar(desc[2]))));
console.log(`Descriptor guardado y recuperado: penalización consigo mismo ${M.penalizacion(desc[2], g, false).toFixed(4)}`);
