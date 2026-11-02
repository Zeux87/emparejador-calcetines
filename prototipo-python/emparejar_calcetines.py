#!/usr/bin/env python3
"""
emparejar_calcetines.py — Prototipo: busca las parejas de calcetines en una foto
y rodea cada pareja con el mismo color.

Uso:
    python emparejar_calcetines.py foto.jpg [-o resultado.jpg] [--umbral 0.6] [--debug]

Requisitos:
    pip install opencv-python numpy scikit-image networkx

Condiciones para la foto (versión prototipo):
    - Calcetines extendidos y SIN tocarse entre sí.
    - Fondo liso que contraste (sábana, suelo, mesa).
    - Foto cenital (desde arriba), con luz más o menos uniforme.

Cómo funciona:
    1. Segmentación: modela el color del fondo (con su iluminación desigual) y
       separa todo lo que no es fondo; cada mancha grande es un calcetín.
    2. Huella de cada calcetín: colores dominantes, histograma de color,
       textura (LBP), patrón de rayas (FFT a lo largo de la pierna),
       variación interna de color y tamaño.
    3. Distancia entre todos los pares de calcetines y emparejamiento óptimo
       (máximo emparejamiento ponderado); los que no tienen pareja
       suficientemente parecida quedan como huérfanos.
    4. Dibuja cada pareja con un color y número; los huérfanos en gris con "?".
"""
import argparse
import json
import sys
from pathlib import Path

import cv2
import networkx as nx
import numpy as np
from skimage.feature import local_binary_pattern

MAX_LADO = 1600          # se reduce la foto a este tamaño máximo para ir rápido
LADO_NORMALIZADO = 200   # cada calcetín se reescala a este largo para comparar texturas

# Peso de cada rasgo en la distancia final (suman 1)
PESOS = {
    "color_dominante": 0.30,
    "histograma": 0.15,
    "textura": 0.15,
    "rayas": 0.15,
    "variacion": 0.10,
    "tamano": 0.15,
}
# Mínimos para normalizar (evita amplificar ruido si todos los calcetines son lisos, etc.)
SUELOS = {
    "color_dominante": 4.0,
    "histograma": 0.05,
    "textura": 0.02,
    "rayas": 0.5,
    "variacion": 1.5,
    "tamano": 0.08,
}

PALETA = [  # BGR, colores bien distintos entre sí
    (0, 0, 255), (0, 200, 0), (255, 80, 0), (0, 220, 255), (255, 0, 255),
    (255, 255, 0), (0, 128, 255), (128, 0, 255), (0, 255, 128), (180, 105, 255),
    (255, 160, 120), (40, 90, 160), (120, 255, 255), (200, 200, 0), (90, 0, 140),
]


# ----------------------------------------------------------------------------- utilidades
def cargar(ruta):
    img = cv2.imread(str(ruta))
    if img is None:
        sys.exit(f"No puedo abrir la imagen: {ruta}")
    h, w = img.shape[:2]
    s = MAX_LADO / max(h, w)
    if s < 1:
        img = cv2.resize(img, (int(w * s), int(h * s)), interpolation=cv2.INTER_AREA)
    return img


def a_lab(img):
    """BGR uint8 -> Lab float (L 0-100, a/b aprox. -128..127)."""
    return cv2.cvtColor(img.astype(np.float32) / 255.0, cv2.COLOR_BGR2LAB)


# ----------------------------------------------------------------------------- 1. segmentación
def modelar_fondo(lab, mascara_fondo):
    """Ajusta un polinomio de grado 2 por canal a los píxeles de fondo.
    Así se tiene en cuenta que la luz no es uniforme en toda la foto."""
    h, w = lab.shape[:2]
    ys, xs = np.nonzero(mascara_fondo)
    if len(xs) > 30000:
        sel = np.random.default_rng(0).choice(len(xs), 30000, replace=False)
        ys, xs = ys[sel], xs[sel]
    xn, yn = xs / w, ys / h
    A = np.stack([np.ones_like(xn), xn, yn, xn * xn, xn * yn, yn * yn], 1)
    gy, gx = np.mgrid[0:h, 0:w]
    gxn, gyn = gx / w, gy / h
    G = np.stack([np.ones_like(gxn), gxn, gyn, gxn * gxn, gxn * gyn, gyn * gyn], -1)
    fondo = np.zeros_like(lab, dtype=np.float32)
    for c in range(3):
        coef, *_ = np.linalg.lstsq(A, lab[ys, xs, c], rcond=None)
        fondo[..., c] = G @ coef
    return fondo


def separar_pegados(objetos, img):
    """Intenta separar calcetines que se tocan. Si una mancha es bastante más grande
    que la típica, se 'adelgaza' (transformada de distancia) hasta que se parte en
    núcleos, y esos núcleos se usan como semillas de un watershed sobre la foto.
    Si la mancha no se parte (calcetines solapados), se deja como está."""
    h, w = objetos.shape
    cs, _ = cv2.findContours(objetos, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    areas = np.array([cv2.contourArea(c) for c in cs])
    validas = areas[areas > 0.0015 * h * w]
    if len(validas) < 3:
        return list(cs)
    tipica = float(np.median(validas))
    resultado = []
    for c, a in zip(cs, areas):
        if a < 1.5 * tipica:
            resultado.append(c)
            continue
        x, y, bw, bh = cv2.boundingRect(c)
        x0, y0 = max(0, x - 10), max(0, y - 10)
        x1, y1 = min(w, x + bw + 10), min(h, y + bh + 10)
        m = np.zeros((y1 - y0, x1 - x0), np.uint8)
        cv2.drawContours(m, [c], -1, 255, -1, offset=(-x0, -y0))
        dist = cv2.distanceTransform(m, cv2.DIST_L2, 5)
        semillas = None
        for frac in (0.3, 0.4, 0.5, 0.6):
            nucleo = (dist > frac * dist.max()).astype(np.uint8)
            n, etq, stats, _ = cv2.connectedComponentsWithStats(nucleo)
            trozos = [i for i in range(1, n) if stats[i, cv2.CC_STAT_AREA] > 0.08 * tipica * (1 - frac)]
            if len(trozos) >= 2:
                semillas = np.zeros(m.shape, np.int32)
                for k, i in enumerate(trozos, 1):
                    semillas[etq == i] = k
                break
        if semillas is None:
            resultado.append(c)
            continue
        fondo_id = semillas.max() + 1
        semillas[m == 0] = fondo_id
        cv2.watershed(np.ascontiguousarray(img[y0:y1, x0:x1]), semillas)
        for k in range(1, fondo_id):
            parte = ((semillas == k) & (m > 0)).astype(np.uint8) * 255
            pcs, _ = cv2.findContours(parte, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
            if pcs:
                resultado.append(max(pcs, key=cv2.contourArea) + np.array([[x0, y0]], np.int32))
    return resultado


def segmentar(img, lab, carpeta_debug=None):
    h, w = lab.shape[:2]
    lab_s = cv2.GaussianBlur(lab, (0, 0), 2)

    # Primera estimación del fondo: el borde de la foto
    b = max(5, int(0.02 * min(h, w)))
    mascara_fondo = np.zeros((h, w), bool)
    mascara_fondo[:b, :] = mascara_fondo[-b:, :] = True
    mascara_fondo[:, :b] = mascara_fondo[:, -b:] = True

    objetos = None
    umbral_de = None
    for _ in range(3):  # refinado iterativo: fondo -> objetos -> fondo sin objetos -> ...
        fondo = modelar_fondo(lab_s, mascara_fondo)
        diff = lab_s - fondo
        diff[..., 0] *= 0.6  # menos peso a la luminosidad para tolerar sombras suaves
        dist = np.sqrt((diff ** 2).sum(-1))
        # Umbral adaptado al "ruido" del fondo: mediana + 8 desviaciones robustas (MAD)
        ruido = dist[mascara_fondo]
        med = float(np.median(ruido))
        mad = float(np.median(np.abs(ruido - med))) * 1.4826
        umbral_de = float(np.clip(med + 8 * mad, 5, 15))
        objetos = (dist > umbral_de).astype(np.uint8) * 255
        k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (15, 15))
        mascara_fondo = cv2.dilate(objetos, k) == 0

    # Limpieza morfológica (cierre pequeño para no "soldar" calcetines cercanos)
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
    objetos = cv2.morphologyEx(objetos, cv2.MORPH_CLOSE, k)
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (7, 7))
    objetos = cv2.morphologyEx(objetos, cv2.MORPH_OPEN, k)
    # Rellenar agujeros (lunares claros, talones, etc.)
    cs, _ = cv2.findContours(objetos, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    objetos = np.zeros_like(objetos)
    cv2.drawContours(objetos, cs, -1, 255, -1)

    contornos = separar_pegados(objetos, img)
    areas = np.array([cv2.contourArea(c) for c in contornos]) if contornos else np.array([])
    if len(areas) == 0:
        return [], objetos, umbral_de
    grandes = areas[areas > 0.0015 * h * w]
    minimo = max(0.0015 * h * w, 0.25 * float(np.median(grandes)) if len(grandes) else 0)
    contornos = [c for c, a in zip(contornos, areas) if a >= minimo]

    if carpeta_debug:
        cv2.imwrite(str(Path(carpeta_debug) / "debug_mascara.png"), objetos)
    return contornos, objetos, umbral_de


# ----------------------------------------------------------------------------- 2. rasgos
def recorte_normalizado(img_gris, lab, mascara, contorno):
    """Gira el calcetín para que su eje largo quede vertical y lo reescala
    a LADO_NORMALIZADO píxeles de largo."""
    (cx, cy), (rw, rh), ang = cv2.minAreaRect(contorno)
    if rw < rh:
        ang += 90  # ahora el lado largo queda horizontal tras girar 'ang'
    largo = max(rw, rh)
    D = int(largo * 1.3) + 4
    M = cv2.getRotationMatrix2D((cx, cy), ang - 90, 1.0)  # -90 => eje largo vertical
    M[0, 2] += D / 2 - cx
    M[1, 2] += D / 2 - cy
    g = cv2.warpAffine(img_gris, M, (D, D), flags=cv2.INTER_LINEAR)
    L = cv2.warpAffine(lab[..., 0], M, (D, D), flags=cv2.INTER_LINEAR)
    m = cv2.warpAffine(mascara, M, (D, D), flags=cv2.INTER_NEAREST)
    ys, xs = np.nonzero(m)
    y0, y1, x0, x1 = ys.min(), ys.max() + 1, xs.min(), xs.max() + 1
    g, L, m = g[y0:y1, x0:x1], L[y0:y1, x0:x1], m[y0:y1, x0:x1]
    if g.shape[1] > g.shape[0]:  # por si acaso quedó tumbado
        g, L, m = np.rot90(g).copy(), np.rot90(L).copy(), np.rot90(m).copy()
    s = LADO_NORMALIZADO / g.shape[0]
    tam = (max(8, int(g.shape[1] * s)), LADO_NORMALIZADO)
    g = cv2.resize(g, tam, interpolation=cv2.INTER_AREA)
    L = cv2.resize(L, tam, interpolation=cv2.INTER_AREA)
    m = cv2.resize(m, tam, interpolation=cv2.INTER_NEAREST)
    return g, L, m, largo


def perfil_rayas(L, m):
    """Patrón de rayas transversales: perfil de luminosidad a lo largo de la pierna
    y su espectro (FFT). Es invariante a dar la vuelta al calcetín."""
    filas = []
    for y in range(L.shape[0]):
        sel = m[y] > 0
        if sel.sum() >= max(3, 0.1 * m.shape[1]):
            filas.append(L[y][sel].mean())
        elif filas:
            filas.append(filas[-1])
    if len(filas) < 16:
        return np.zeros(40, np.float32)
    p = np.array(filas, np.float32)
    p = np.interp(np.linspace(0, len(p) - 1, 256), np.arange(len(p)), p)
    tendencia = suavizar_1d(p, 12)
    p = (p - tendencia) * np.hanning(256)
    espectro = np.abs(np.fft.rfft(p))[2:42] / 256
    return suavizar_1d(espectro.astype(np.float32), 1)


def suavizar_1d(v, sigma):
    """Suavizado gaussiano de un vector (bordes en espejo)."""
    r = int(round(sigma * 4))
    k = np.exp(-0.5 * (np.arange(-r, r + 1) / sigma) ** 2)
    k /= k.sum()
    ext = np.pad(np.asarray(v, np.float64), r, mode="reflect")
    return np.convolve(ext, k, mode="valid").astype(np.float32)


def huella(img, lab, gris, contorno):
    h, w = gris.shape
    mascara = np.zeros((h, w), np.uint8)
    cv2.drawContours(mascara, [contorno], -1, 255, -1)
    # Erosión para no mezclar el borde con el fondo
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (9, 9))
    interior = cv2.erode(mascara, k)
    if cv2.countNonZero(interior) < 200:
        interior = mascara

    px = lab[interior > 0]

    # Colores dominantes (k-means, 3 grupos) -> firma para EMD
    muestra = px[np.random.default_rng(0).choice(len(px), min(4000, len(px)), replace=False)]
    crit = (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 30, 0.5)
    _, etiquetas, centros = cv2.kmeans(muestra.astype(np.float32), 3, None, crit, 3, cv2.KMEANS_PP_CENTERS)
    pesos = np.bincount(etiquetas.ravel(), minlength=3).astype(np.float32)
    pesos /= pesos.sum()
    firma = np.hstack([pesos[:, None], centros]).astype(np.float32)

    # Histograma Lab 3D
    hist = cv2.calcHist([lab], [0, 1, 2], interior, [6, 8, 8], [0, 100, -80, 80, -80, 80])
    hist = (hist / max(hist.sum(), 1)).astype(np.float32)

    # Textura y rayas sobre el recorte normalizado
    g, Lr, mr, largo = recorte_normalizado(gris, lab, interior, contorno)
    lbp_vec = []
    for P, R in ((8, 1), (16, 3)):
        lbp = local_binary_pattern(g, P, R, method="uniform")
        hh, _ = np.histogram(lbp[mr > 0], bins=P + 2, range=(0, P + 2))
        lbp_vec.append(hh / max(hh.sum(), 1))
    lbp_vec = np.concatenate(lbp_vec).astype(np.float32)

    rayas = perfil_rayas(Lr, mr)
    variacion = px.std(0).astype(np.float32)  # cuánto varía el color dentro (lisos vs estampados)

    area = cv2.countNonZero(mascara)
    M = cv2.moments(contorno)
    centro = (M["m10"] / M["m00"], M["m01"] / M["m00"]) if M["m00"] else tuple(contorno[0][0])
    return {
        "firma": firma, "hist": hist, "lbp": lbp_vec, "rayas": rayas,
        "variacion": variacion, "tamano": np.log(np.sqrt(area)), "largo": largo,
        "area": area, "centro": centro, "mascara": mascara,
        "color_medio_lab": px.mean(0),
    }


# ----------------------------------------------------------------------------- 3. distancias y emparejamiento
def distancias_crudas(a, b):
    emd, _, _ = cv2.EMD(a["firma"], b["firma"], cv2.DIST_L2)
    hist = cv2.compareHist(a["hist"], b["hist"], cv2.HISTCMP_BHATTACHARYYA)
    chi = 0.5 * np.sum((a["lbp"] - b["lbp"]) ** 2 / (a["lbp"] + b["lbp"] + 1e-9))
    return {
        "color_dominante": float(emd),
        "histograma": float(hist),
        "textura": float(chi),
        "rayas": float(np.linalg.norm(a["rayas"] - b["rayas"])),
        "variacion": float(np.linalg.norm(a["variacion"] - b["variacion"])),
        "tamano": float(abs(a["tamano"] - b["tamano"])),
    }


def matriz_distancias(huellas):
    n = len(huellas)
    crudas = {}
    for i in range(n):
        for j in range(i + 1, n):
            crudas[(i, j)] = distancias_crudas(huellas[i], huellas[j])
    # Normalización: cada rasgo se divide por su mediana entre todos los pares
    # (así no hay que ajustar escalas a mano y se adapta a cada foto)
    escalas = {}
    for k in PESOS:
        vals = [d[k] for d in crudas.values()]
        escalas[k] = max(float(np.median(vals)) if vals else 1.0, SUELOS[k])
    D = np.full((n, n), np.inf)
    for (i, j), d in crudas.items():
        D[i, j] = D[j, i] = sum(PESOS[k] * d[k] / escalas[k] for k in PESOS)
    return D


def emparejar(D, umbral):
    n = len(D)
    G = nx.Graph()
    G.add_nodes_from(range(n))
    for i in range(n):
        for j in range(i + 1, n):
            if D[i, j] < umbral:
                G.add_edge(i, j, weight=umbral - D[i, j])
    parejas = sorted(tuple(sorted(p)) for p in nx.max_weight_matching(G, maxcardinality=False))
    resultado = []
    for i, j in parejas:
        # margen = cuánto mejor es esta pareja que la siguiente alternativa de cada uno
        alt_i = np.sort(np.delete(D[i], [i, j]))[0] if n > 2 else np.inf
        alt_j = np.sort(np.delete(D[j], [i, j]))[0] if n > 2 else np.inf
        margen = float(min(alt_i, alt_j) - D[i, j])
        resultado.append({"a": i, "b": j, "distancia": float(D[i, j]), "margen": margen,
                          "segura": margen > 0.15})
    emparejados = {x for p in parejas for x in p}
    huerfanos = [i for i in range(n) if i not in emparejados]
    return resultado, huerfanos


# ----------------------------------------------------------------------------- 4. dibujo
def punto_etiqueta(mascara):
    """Punto más 'interior' del calcetín (máximo de la transformada de distancia)."""
    dist = cv2.distanceTransform(mascara, cv2.DIST_L2, 5)
    _, _, _, p = cv2.minMaxLoc(dist)
    return p


def dibujar(img, contornos, huellas, parejas, huerfanos):
    out = img.copy()
    grosor = max(3, int(0.004 * max(img.shape[:2])))
    fuente = cv2.FONT_HERSHEY_SIMPLEX
    escala_txt = max(0.6, 0.0009 * max(img.shape[:2]))
    radio = int(22 * escala_txt)

    def etiqueta(p, texto, color):
        cv2.circle(out, p, radio, (0, 0, 0), -1, cv2.LINE_AA)
        cv2.circle(out, p, radio - 3, color, -1, cv2.LINE_AA)
        (tw, th), _ = cv2.getTextSize(texto, fuente, escala_txt, 2)
        cv2.putText(out, texto, (p[0] - tw // 2, p[1] + th // 2), fuente, escala_txt,
                    (0, 0, 0), 2, cv2.LINE_AA)

    for n, par in enumerate(parejas, 1):
        color = PALETA[(n - 1) % len(PALETA)]
        for idx in (par["a"], par["b"]):
            cv2.drawContours(out, [contornos[idx]], -1, (0, 0, 0), grosor + 4, cv2.LINE_AA)
            cv2.drawContours(out, [contornos[idx]], -1, color, grosor, cv2.LINE_AA)
            etiqueta(punto_etiqueta(huellas[idx]["mascara"]), str(n) + ("" if par["segura"] else "?"), color)
    for idx in huerfanos:
        cv2.drawContours(out, [contornos[idx]], -1, (0, 0, 0), grosor + 4, cv2.LINE_AA)
        cv2.drawContours(out, [contornos[idx]], -1, (170, 170, 170), grosor, cv2.LINE_AA)
        etiqueta(punto_etiqueta(huellas[idx]["mascara"]), "X", (170, 170, 170))

    resumen = f"{len(parejas)} parejas  |  {len(huerfanos)} sin pareja"
    (tw, th), _ = cv2.getTextSize(resumen, fuente, escala_txt * 1.2, 2)
    cv2.rectangle(out, (10, 10), (30 + tw, 30 + th + 10), (255, 255, 255), -1)
    cv2.putText(out, resumen, (20, 25 + th), fuente, escala_txt * 1.2, (0, 0, 0), 2, cv2.LINE_AA)
    return out


# ----------------------------------------------------------------------------- principal
def procesar(ruta, salida=None, umbral=0.6, debug=False):
    img = cargar(ruta)
    lab = a_lab(img)
    gris = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    salida = salida or str(Path(ruta).with_name(Path(ruta).stem + "_parejas.jpg"))
    carpeta = Path(salida).parent
    carpeta.mkdir(parents=True, exist_ok=True)
    contornos, _, umbral_de = segmentar(img, lab, carpeta if debug else None)
    if len(contornos) < 2:
        sys.exit(f"Solo he encontrado {len(contornos)} calcetín(es). Revisa el fondo/la luz (usa --debug).")

    huellas = [huella(img, lab, gris, c) for c in contornos]
    D = matriz_distancias(huellas)
    parejas, huerfanos = emparejar(D, umbral)
    out = dibujar(img, contornos, huellas, parejas, huerfanos)

    cv2.imwrite(salida, out, [cv2.IMWRITE_JPEG_QUALITY, 92])

    informe = {
        "imagen": str(ruta),
        "calcetines_detectados": len(contornos),
        "umbral_segmentacion_deltaE": umbral_de,
        "parejas": [{
            "numero": n,
            "centros": [list(map(round, huellas[p["a"]]["centro"])), list(map(round, huellas[p["b"]]["centro"]))],
            "distancia": round(p["distancia"], 3),
            "margen": round(p["margen"], 3),
            "segura": p["segura"],
        } for n, p in enumerate(parejas, 1)],
        "sin_pareja": [list(map(round, huellas[i]["centro"])) for i in huerfanos],
    }
    if debug:
        np.set_printoptions(precision=2, suppress=True, linewidth=200)
        print("Matriz de distancias:\n", np.where(np.isinf(D), 0, D))
        Path(Path(salida).with_suffix(".json")).write_text(
            json.dumps(informe, ensure_ascii=False, indent=1), encoding="utf-8")

    print(f"Calcetines detectados: {len(contornos)}")
    for p in informe["parejas"]:
        estado = "segura" if p["segura"] else "DUDOSA"
        print(f"  Pareja {p['numero']:>2}: {p['centros'][0]} <-> {p['centros'][1]}  "
              f"dist={p['distancia']:.2f}  margen={p['margen']:.2f}  ({estado})")
    for c in informe["sin_pareja"]:
        print(f"  Sin pareja: {c}")
    print(f"Resultado guardado en {salida}")
    return informe, img.shape


def main():
    ap = argparse.ArgumentParser(description="Empareja calcetines en una foto.")
    ap.add_argument("foto")
    ap.add_argument("-o", "--salida", help="imagen de salida (por defecto <foto>_parejas.jpg)")
    ap.add_argument("--umbral", type=float, default=0.6,
                    help="distancia máxima para aceptar una pareja (más bajo = más exigente)")
    ap.add_argument("--debug", action="store_true", help="guarda la máscara, la matriz y un JSON")
    a = ap.parse_args()
    procesar(a.foto, a.salida, a.umbral, a.debug)


if __name__ == "__main__":
    main()
