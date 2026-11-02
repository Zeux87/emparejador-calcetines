#!/usr/bin/env node
/*
 * banco-pruebas.js — Mide el acierto del motor de la app (assets/emparejador.js)
 * con las fotos sintéticas de herramientas/banco (créalas con preparar_banco.py).
 *
 * Uso:  node herramientas/banco-pruebas.js [umbral]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const E = require(path.join(__dirname, '..', 'app', 'src', 'main', 'assets', 'emparejador.js'));

const dir = path.join(__dirname, 'banco');
const umbral = parseFloat(process.argv[2] || '0.6');
if (!fs.existsSync(dir)) {
  console.error('No hay banco de fotos. Ejecuta antes: python herramientas/preparar_banco.py');
  process.exit(1);
}

let fotos = 0, bien = 0, mal = 0, esperadas = 0, detectados = 0, totales = 0, ms = 0;
for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.rgba')).sort()) {
  const buf = fs.readFileSync(path.join(dir, f));
  const w = buf.readUInt32LE(0), h = buf.readUInt32LE(4);
  const rgba = new Uint8Array(buf.buffer, buf.byteOffset + 8, w * h * 4);
  const verdad = JSON.parse(fs.readFileSync(path.join(dir, f.replace('.rgba', '_verdad.json')), 'utf8'));

  const t0 = Date.now();
  const r = E.analizar(rgba, w, h);
  const { parejas, huerfanos } = E.emparejar(r.D, umbral);
  ms += Date.now() - t0;

  const real = (c) => {
    let mejor = null, d = Infinity;
    for (const v of verdad) {
      const dd = Math.hypot(v.centro[0] - c[0], v.centro[1] - c[1]);
      if (dd < d) { d = dd; mejor = v; }
    }
    return d < 35 ? mejor : null;
  };
  let ok = 0;
  const fallos = [];
  for (const p of parejas) {
    const a = real(r.calcetines[p.a].huella.centro), b = real(r.calcetines[p.b].huella.centro);
    if (a && b && a.pareja === b.pareja && a.pareja < 100) ok++;
    else fallos.push(`${a ? a.nombre : '?'} <-> ${b ? b.nombre : '?'}`);
  }
  const nParejas = new Set(verdad.filter((v) => v.pareja < 100).map((v) => v.pareja)).size;
  fotos++; bien += ok; mal += fallos.length; esperadas += nParejas;
  detectados += r.calcetines.length; totales += verdad.length;
  const sin = huerfanos.map((i) => { const v = real(r.calcetines[i].huella.centro); return v ? v.nombre : '?'; });
  console.log(`${f.padEnd(16)} detectados ${r.calcetines.length}/${verdad.length}  parejas bien ${ok}/${nParejas}` +
    (fallos.length ? `  MAL: ${fallos.join('; ')}` : '') + `  sin pareja: ${sin.join(', ') || '-'}`);
}
console.log(`\n${fotos} fotos · calcetines detectados ${detectados}/${totales} · parejas bien ${bien}/${esperadas} · mal ${mal} · ${Math.round(ms / Math.max(1, fotos))} ms/foto`);
process.exitCode = mal ? 1 : 0;
