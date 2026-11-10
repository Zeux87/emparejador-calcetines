#!/usr/bin/env node
/*
 * banco-reales.js — Mide el acierto del motor con IA (assets/motor-ia.js) con fotos de verdad.
 *
 * Abre la app en Chrome sin ventana, le pasa cada foto de la carpeta de casos y compara las
 * parejas que propone con las que se dieron por buenas. Usa los mismos modelos que el APK.
 *
 * Uso:
 *   node herramientas/banco-reales.js [carpeta] [--umbral 0.27] [--barrido]
 *
 *   carpeta     por defecto herramientas/casos-reales (créala con importar-casos.js)
 *   --umbral    umbral de parecido (por defecto, el del motor)
 *   --barrido   además, enseña los fallos con cada umbral entre 0,15 y 0,40
 *
 * Necesita:
 *   - los modelos en app/src/main/assets/modelos/ y onnxruntime-web en app/src/main/assets/ort/
 *     (los mismos pasos que .github/workflows/compilar-apk.yml)
 *   - Playwright:  npm install --no-save playwright   (usa el Chrome instalado; si no lo
 *     encuentra, indica la ruta con la variable CHROME)
 *
 * No usa el cajón ni las parejas conocidas: mide solo las parejas dentro de cada foto.
 * Termina con código 1 si hay algún fallo.
 */
'use strict';
const fs = require('fs');
const http = require('http');
const path = require('path');

const ASSETS = path.join(__dirname, '..', 'app', 'src', 'main', 'assets');

/* ------------------------------------------------------------ evaluación (sin navegador) */

const clave = (a, b) => (a < b ? a + '-' + b : b + '-' + a);

// A qué calcetín del caso corresponde cada calcetín detectado (o -1). Cada uno del caso, una vez.
function corresponder(caso, det) {
  const W = det.ancho, H = det.alto, lado = Math.max(W, H);
  const cand = [];
  det.calcetines.forEach((d, i) => {
    caso.calcetines.forEach((v, j) => {
      const [x, y] = d.etiqueta;
      const dist = Math.hypot((x - v.centro[0]) * W, (y - v.centro[1]) * H);
      let vale;
      if (v.caja) {
        const mg = 0.01;
        vale = x >= v.caja[0] - mg && x <= v.caja[2] + mg && y >= v.caja[1] - mg && y <= v.caja[3] + mg;
      } else {
        vale = dist <= 0.06 * lado;
      }
      if (vale) cand.push({ i, j, dist });
    });
  });
  cand.sort((p, q) => p.dist - q.dist);
  const deDet = new Array(det.calcetines.length).fill(-1), usado = new Set();
  for (const c of cand) {
    if (deDet[c.i] >= 0 || usado.has(c.j)) continue;
    deDet[c.i] = c.j; usado.add(c.j);
  }
  return deDet;
}

// Compara las parejas propuestas (índices de calcetines detectados) con las del caso
function evaluar(caso, det, parejas) {
  const deDet = corresponder(caso, det);
  const buenas = new Set(caso.parejas.map(([a, b]) => clave(a, b)));
  const vistas = new Set();
  let bien = 0;
  const mal = [];
  for (const [a, b] of parejas) {
    const x = deDet[a], y = deDet[b];
    if (x >= 0 && y >= 0 && buenas.has(clave(x, y))) { bien++; vistas.add(clave(x, y)); } else mal.push([x, y]);
  }
  const perdidas = [...buenas].filter((k) => !vistas.has(k));
  return {
    esperados: caso.calcetines.length, detectados: det.calcetines.length,
    sinCorresponder: deDet.filter((x) => x < 0).length,
    parejas: buenas.size, bien, mal, perdidas,
  };
}

function matriz(S) {
  return S.map((f) => Float64Array.from(f, (v) => (v == null ? -Infinity : v)));
}

/* ------------------------------------------------------------ navegador */

const TIPOS = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.wasm': 'application/wasm', '.onnx': 'application/octet-stream', '.jpg': 'image/jpeg', '.json': 'application/json' };

const PAGINA = `<!DOCTYPE html><meta charset="utf-8"><title>banco</title>
<script src="ort/ort.wasm.min.js"></script><script src="emparejador.js"></script><script src="motor-ia.js"></script>
<script>
window.analizarCaso = async (url) => {
  const img = new Image();
  img.src = url;
  await img.decode();
  // igual que la app: la foto se reduce a 2048 px de lado antes de analizarla
  const s = Math.min(1, 2048 / Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(img.naturalWidth * s)); c.height = Math.max(1, Math.round(img.naturalHeight * s));
  const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, c.width, c.height);
  const r = await MotorIA.analizar(c, {});
  return {
    ancho: r.ancho, alto: r.alto, tiempos: r.tiempos,
    calcetines: r.calcetines.map((k) => ({ etiqueta: [k.huella.etiqueta[0] / r.ancho, k.huella.etiqueta[1] / r.alto] })),
    S: r.S.map((f) => Array.from(f, (v) => (Number.isFinite(v) ? v : null))),
  };
};
</script>`;

function servidor(dirCasos) {
  const srv = http.createServer((req, res) => {
    const ruta = decodeURIComponent(req.url.split('?')[0]);
    const cab = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp', 'Cache-Control': 'no-store' };
    if (ruta === '/__banco.html') { res.writeHead(200, { ...cab, 'Content-Type': TIPOS['.html'] }); res.end(PAGINA); return; }
    const enCasos = ruta.startsWith('/__casos/');
    const base = enCasos ? dirCasos : ASSETS;
    const archivo = path.normalize(path.join(base, enCasos ? ruta.slice(9) : ruta));
    if (!archivo.startsWith(base) || !fs.existsSync(archivo) || !fs.statSync(archivo).isFile()) { res.writeHead(404, cab); res.end(); return; }
    res.writeHead(200, { ...cab, 'Content-Type': TIPOS[path.extname(archivo)] || 'application/octet-stream' });
    fs.createReadStream(archivo).pipe(res);
  });
  return new Promise((ok) => srv.listen(0, '127.0.0.1', () => ok(srv)));
}

async function abrirNavegador() {
  let pw;
  try { pw = require('playwright'); } catch (e) {
    throw new Error('Falta Playwright. Instálalo con: npm install --no-save playwright');
  }
  const args = ['--no-sandbox'];
  if (process.env.CHROME) return pw.chromium.launch({ executablePath: process.env.CHROME, args });
  try { return await pw.chromium.launch({ channel: 'chrome', args }); } catch (e) { return pw.chromium.launch({ args }); }
}

/* ------------------------------------------------------------ programa */

async function principal() {
  const args = process.argv.slice(2);
  let dir = path.join(__dirname, 'casos-reales'), umbral = null, barrido = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--umbral') umbral = parseFloat(args[++i]);
    else if (args[i] === '--barrido') barrido = true;
    else dir = path.resolve(args[i]);
  }
  const archivos = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort() : [];
  if (!archivos.length) {
    console.log(`No hay casos en ${dir}. Impórtalos con: node herramientas/importar-casos.js <archivo exportado>`);
    return 0;
  }
  for (const f of ['modelos/slimsam-encoder-q.onnx', 'modelos/slimsam-decoder-q.onnx', 'modelos/dinov2-small-q.onnx', 'ort/ort.wasm.min.js']) {
    if (!fs.existsSync(path.join(ASSETS, f))) throw new Error(`Falta app/src/main/assets/${f} (mira los pasos de descarga en .github/workflows/compilar-apk.yml)`);
  }
  globalThis.Emparejador = require(path.join(ASSETS, 'emparejador.js'));
  require(path.join(ASSETS, 'motor-ia.js'));
  const M = globalThis.MotorIA;
  if (umbral == null || !Number.isFinite(umbral)) umbral = M.CFG.umbralBase;

  const srv = await servidor(dir);
  const url = `http://127.0.0.1:${srv.address().port}`;
  const nav = await abrirNavegador();
  const lineas = [];
  const tot = { casos: 0, esperados: 0, detectados: 0, parejas: 0, bien: 0, mal: 0, perdidas: 0, ms: 0, roto: 0 };
  const guardados = [];
  try {
    const pag = await nav.newPage();
    pag.on('pageerror', (e) => console.error('  [página] ' + e.message));
    await pag.goto(url + '/__banco.html');
    for (const f of archivos) {
      const caso = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      let det;
      try {
        det = await pag.evaluate((u) => window.analizarCaso(u), `${url}/__casos/${encodeURIComponent(caso.foto)}`);
      } catch (e) {
        tot.casos++; tot.roto++;
        lineas.push(`${caso.id}: NO SE HA PODIDO ANALIZAR (${String(e.message).split('\n')[0]})`);
        continue;
      }
      const n = det.calcetines.length;
      const S = matriz(det.S);
      const parejas = S.length ? M.emparejar(S, umbral, n).parejas.map((p) => [p.a, p.b]) : [];
      const r = evaluar(caso, det, parejas);
      guardados.push({ caso, det, S, n });
      tot.casos++; tot.esperados += r.esperados; tot.detectados += r.detectados; tot.parejas += r.parejas;
      tot.bien += r.bien; tot.mal += r.mal.length; tot.perdidas += r.perdidas.length; tot.ms += det.tiempos.total;
      lineas.push(`${String(caso.id).padEnd(16)} calcetines ${r.detectados}/${r.esperados}  parejas bien ${r.bien}/${r.parejas}` +
        (r.mal.length ? `  MAL: ${r.mal.map((p) => p.join('+')).join(', ')}` : '') +
        (r.perdidas.length ? `  NO VISTAS: ${r.perdidas.join(', ')}` : '') +
        `  ${(det.tiempos.total / 1000).toFixed(1)} s` + (caso.corregida ? '  (corregida a mano)' : ''));
    }
  } finally {
    await nav.close();
    srv.close();
  }
  const fallos = tot.mal + tot.perdidas + tot.roto;
  const resumen = `${tot.casos} casos · umbral ${umbral.toFixed(3)} · calcetines ${tot.detectados}/${tot.esperados} · parejas bien ${tot.bien}/${tot.parejas}` +
    ` · mal ${tot.mal} · no vistas ${tot.perdidas}` + (tot.roto ? ` · sin analizar ${tot.roto}` : '') +
    ` · ${(tot.ms / 1000 / Math.max(1, tot.casos - tot.roto)).toFixed(1)} s/foto`;
  console.log(lineas.join('\n'));
  console.log('\n' + resumen);

  let tabla = '';
  if (barrido && guardados.length) {
    tabla = '\numbral  mal  no vistas\n';
    for (let T = 0.15; T <= 0.40001; T += 0.01) {
      let mal = 0, perd = 0;
      for (const g of guardados) {
        const r = evaluar(g.caso, g.det, g.S.length ? M.emparejar(g.S, T, g.n).parejas.map((p) => [p.a, p.b]) : []);
        mal += r.mal.length; perd += r.perdidas.length;
      }
      tabla += `${T.toFixed(2)}    ${String(mal).padStart(3)}  ${String(perd).padStart(3)}\n`;
    }
    console.log(tabla);
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,
      `### Banco de pruebas: ${path.basename(dir)}\n\n${fallos ? '⚠️' : '✅'} ${resumen}\n\n\`\`\`\n${lineas.join('\n')}\n${tabla}\`\`\`\n`);
  }
  return fallos ? 1 : 0;
}

if (require.main === module) {
  principal().then((c) => { process.exitCode = c; }, (e) => { console.error(e.message || e); process.exitCode = 2; });
}

module.exports = { corresponder, evaluar };
