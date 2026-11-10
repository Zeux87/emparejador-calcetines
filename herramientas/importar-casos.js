#!/usr/bin/env node
/*
 * importar-casos.js — Saca los casos de prueba de un archivo exportado por la app
 * («Exportar datos para mejorar») y los deja listos para banco-reales.js.
 *
 * Un caso de prueba es una foto que guardaste con la casilla «Guardar la foto como caso
 * de prueba»: la foto entera y las parejas que diste por buenas al pulsar Hecho.
 *
 * Uso:  node herramientas/importar-casos.js calcetines-datos-2026-11-10.json [carpeta]
 *
 * Por defecto escribe en herramientas/casos-reales/ (no se sube al repositorio):
 *   <id>.jpg   la foto
 *   <id>.json  dónde está cada calcetín y qué parejas son las correctas
 */
'use strict';
const fs = require('fs');
const path = require('path');

function importar(archivo, destino) {
  const exp = JSON.parse(fs.readFileSync(archivo, 'utf8'));
  if (!exp || exp.app !== 'calcetines' || !exp.datos) throw new Error('No es un archivo exportado por la app Calcetines');
  fs.mkdirSync(destino, { recursive: true });
  const res = { nuevos: 0, repetidos: 0, descartados: 0 };
  for (const [clave, texto] of Object.entries(exp.datos)) {
    if (!clave.startsWith('ses_')) continue;
    let s;
    try { s = typeof texto === 'string' ? JSON.parse(texto) : texto; } catch (e) { continue; }
    if (!s || !s.caso) continue;
    const m = /^data:image\/jpeg;base64,(.+)$/.exec(s.foto || '');
    if (!m || s.motor !== 'ia' || !Array.isArray(s.calcetines) || !s.calcetines.length) { res.descartados++; continue; }
    const n = s.nFoto;
    const caso = {
      id: s.id, foto: s.id + '.jpg', origen: 'app', fecha: s.fecha, version: s.version,
      corregida: !!s.corregida,
      calcetines: s.calcetines.slice(0, n).map((c) => ({ centro: c.centro, caja: c.caja })),
      // parejas dentro de la foto; las que se hicieron con un calcetín del cajón cuentan como sin pareja
      parejas: (s.final || []).filter(([a, b]) => a < n && b < n),
      conCajon: (s.final || []).filter(([a, b]) => a >= n || b >= n).map(([a, b]) => Math.min(a, b)),
    };
    const json = path.join(destino, s.id + '.json');
    if (fs.existsSync(json)) res.repetidos++; else res.nuevos++;
    fs.writeFileSync(path.join(destino, caso.foto), Buffer.from(m[1], 'base64'));
    fs.writeFileSync(json, JSON.stringify(caso, null, 1));
  }
  return res;
}

if (require.main === module) {
  const archivo = process.argv[2];
  const destino = process.argv[3] || path.join(__dirname, 'casos-reales');
  if (!archivo) {
    console.error('Uso: node herramientas/importar-casos.js <archivo exportado .json> [carpeta de destino]');
    process.exit(2);
  }
  try {
    const r = importar(archivo, destino);
    console.log(`Casos nuevos: ${r.nuevos} · ya estaban: ${r.repetidos} · descartados: ${r.descartados}`);
    console.log(`Carpeta: ${destino}`);
    if (!r.nuevos && !r.repetidos) console.log('El archivo no trae ningún caso de prueba. Marca la casilla «Guardar la foto como caso de prueba» al pulsar Hecho.');
  } catch (e) {
    console.error('No se ha podido importar: ' + e.message);
    process.exit(1);
  }
}

module.exports = { importar };
