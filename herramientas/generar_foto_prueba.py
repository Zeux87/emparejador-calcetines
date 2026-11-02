#!/usr/bin/env python3
"""
generar_foto_prueba.py — Genera una foto SINTÉTICA de calcetines desparejados
sobre una sábana, para probar emparejar_calcetines.py sin tener que hacer fotos.

Uso:
    python generar_foto_prueba.py [-o prueba.jpg] [--semilla 1]

Además de la imagen guarda <nombre>_verdad.json con qué calcetín es pareja de cuál
(sirve para medir el acierto del emparejador).
"""
import argparse
import json
from pathlib import Path

import cv2
import numpy as np

ANCHO, ALTO = 2000, 1500

# Colores en RGB (se convierten a BGR al dibujar)
CATALOGO = [
    # nombre,                 base,            dibujo,      color dibujo,     escala, talon/puntera
    ("negro adulto",          (25, 25, 28),    "liso",      None,             1.00, None),
    ("negro niño",            (30, 30, 33),    "liso",      None,             0.70, None),
    ("blanco talón gris",     (238, 238, 235), "liso",      None,             1.00, (150, 150, 155)),
    ("gris jaspeado",         (130, 130, 136), "jaspeado",  None,             1.00, None),
    ("marino rayas rojas",    (32, 42, 82),    "rayas",     (190, 30, 40),    1.00, None),
    ("rojo lunares",          (180, 25, 35),   "lunares",   (245, 245, 240),  0.95, None),
    ("verde rayas finas",     (40, 110, 60),   "rayas_f",   (230, 200, 40),   1.00, None),
    ("marino liso",           (35, 45, 90),    "liso",      None,             1.00, None),
    ("azul claro",            (120, 160, 210), "liso",      None,             0.95, (60, 80, 140)),
]
HUERFANOS = [
    ("amarillo rayas moradas (huérfano)", (230, 200, 40), "rayas", (100, 50, 130), 1.00, None),
]


def mascara_calcetin(escala, rng):
    """Forma de calcetín en 'L' en un lienzo local (pierna vertical, pie hacia la derecha)."""
    w = int(72 * escala)                 # ancho de la pierna/pie
    largo = int(270 * escala * rng.uniform(0.97, 1.03))
    pie = int(150 * escala * rng.uniform(0.97, 1.03))
    H, W = largo + w // 2 + 10, w + pie + 20
    m = np.zeros((H, W), np.uint8)
    cv2.rectangle(m, (5, 5), (5 + w, 5 + largo), 255, -1)                       # pierna
    cv2.rectangle(m, (5, 5 + largo - w), (5 + w + pie - w // 2, 5 + largo), 255, -1)  # pie
    cv2.circle(m, (5 + w + pie - w // 2, 5 + largo - w // 2), w // 2, 255, -1)  # puntera
    cv2.ellipse(m, (5 + w // 2, 5 + largo - w // 2), (w // 2 + 4, w // 2 + 6), 0, 0, 180, 255, -1)  # talón
    m = cv2.GaussianBlur(m, (0, 0), 3)
    m = (m > 127).astype(np.uint8) * 255
    return m, w, largo, pie


def textura(nombre_dibujo, base, color2, talon, shape, w, largo, pie, rng, brillo):
    H, W = shape
    img = np.zeros((H, W, 3), np.float32)
    img[:] = np.array(base[::-1], np.float32)
    yy, xx = np.mgrid[0:H, 0:W]
    fase = rng.uniform(0, 40)
    if nombre_dibujo in ("rayas", "rayas_f"):
        periodo, grosor = (40, 12) if nombre_dibujo == "rayas" else (18, 5)
        raya = ((yy + fase) % periodo) < grosor
        img[raya] = np.array(color2[::-1], np.float32)
    elif nombre_dibujo == "lunares":
        esp = 30
        dy = (yy + fase) % esp - esp / 2
        dx = (xx + fase + ((yy + fase) // esp % 2) * esp / 2) % esp - esp / 2
        img[(dx * dx + dy * dy) < 49] = np.array(color2[::-1], np.float32)
    elif nombre_dibujo == "jaspeado":
        ruido = cv2.GaussianBlur(rng.normal(0, 1, (H, W)).astype(np.float32), (0, 0), 1.2)
        img += (ruido * 35)[..., None]
    if talon is not None:
        c = np.array(talon[::-1], np.float32)
        cx, cy = 5 + w + pie - w // 2, 5 + largo - w // 2
        img[((xx - cx) ** 2 + (yy - cy) ** 2) < (w * 0.55) ** 2] = c       # puntera
        img[((xx - 5 - w // 2) ** 2 + (yy - cy) ** 2) < (w * 0.6) ** 2] = c  # talón
    # puño elástico: franja superior un poco más oscura
    img[(yy < 5 + int(0.12 * largo))] *= 0.88
    # canalé de punto + ruido fino
    img *= (1 + 0.04 * np.sin(xx * 2 * np.pi / 4))[..., None]
    img += rng.normal(0, 3, img.shape).astype(np.float32)
    return img * brillo


def fondo(tipo, rng):
    yy, xx = np.mgrid[0:ALTO, 0:ANCHO]
    lento = cv2.resize(rng.normal(0, 1, (12, 16)).astype(np.float32), (ANCHO, ALTO), interpolation=cv2.INTER_CUBIC)
    if tipo == "beige":
        # Sábana clara: ojo, los calcetines blancos apenas contrastan con ella
        img = np.zeros((ALTO, ANCHO, 3), np.float32) + np.array((195, 212, 226), np.float32)
        img += (lento * 6)[..., None]
        img *= (1 + 0.015 * np.sin(xx * 2 * np.pi / 3) * np.sin(yy * 2 * np.pi / 3))[..., None]
        return img
    # Suelo de madera de tono medio: contrasta con calcetines claros y oscuros
    img = np.zeros((ALTO, ANCHO, 3), np.float32) + np.array((85, 120, 160), np.float32)  # BGR
    img += (lento * 5)[..., None]
    alto_tabla = 180
    tabla = yy // alto_tabla
    tono = rng.uniform(0.9, 1.08, tabla.max() + 1)[tabla]
    veta = cv2.GaussianBlur(rng.normal(0, 1, (ALTO, ANCHO // 8)).astype(np.float32), (0, 0), sigmaX=1.0, sigmaY=0.8)
    veta = cv2.resize(veta, (ANCHO, ALTO), interpolation=cv2.INTER_LINEAR)
    img *= (tono * (1 + 0.05 * veta))[..., None]
    img[(yy % alto_tabla) < 2] *= 0.75  # juntas entre tablas
    return img


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("-o", "--salida", default="prueba.jpg")
    ap.add_argument("--semilla", type=int, default=1)
    ap.add_argument("--fondo", choices=["madera", "beige"], default="madera")
    a = ap.parse_args()
    rng = np.random.default_rng(a.semilla)

    lista = []
    for i, c in enumerate(CATALOGO):
        lista += [(i, c), (i, c)]
    for j, c in enumerate(HUERFANOS):
        lista.append((100 + j, c))
    rng.shuffle(lista)

    img = fondo(a.fondo, rng)
    ocupado = np.zeros((ALTO, ANCHO), np.uint8)
    verdad = []
    for idx, (pareja, (nombre, base, dib, c2, esc, talon)) in enumerate(lista):
        m, w, largo, pie = mascara_calcetin(esc, rng)
        brillo = rng.uniform(0.9, 1.05)  # uno puede estar más lavado que otro
        tex = textura(dib, base, c2, talon, m.shape, w, largo, pie, rng, brillo)
        if rng.random() < 0.5:           # izquierdo / derecho
            m, tex = m[:, ::-1].copy(), tex[:, ::-1].copy()
        ang = rng.uniform(0, 360)
        D = int(np.hypot(*m.shape)) + 4
        M = cv2.getRotationMatrix2D((m.shape[1] / 2, m.shape[0] / 2), ang, 1)
        M[0, 2] += D / 2 - m.shape[1] / 2
        M[1, 2] += D / 2 - m.shape[0] / 2
        mr = cv2.warpAffine(m, M, (D, D), flags=cv2.INTER_LINEAR)
        tr = cv2.warpAffine(tex, M, (D, D), flags=cv2.INTER_LINEAR)
        alfa = (mr.astype(np.float32) / 255)[..., None]
        # sombreado: bordes algo más oscuros (volumen)
        dist = cv2.distanceTransform((mr > 127).astype(np.uint8), cv2.DIST_L2, 5)
        tr *= (0.82 + 0.18 * np.clip(dist / 12, 0, 1))[..., None]
        colocado = False
        for _ in range(4000):
            x0 = rng.integers(20, ANCHO - D - 20)
            y0 = rng.integers(20, ALTO - D - 20)
            zona = ocupado[y0:y0 + D, x0:x0 + D]
            if not np.any(zona[mr > 0]):
                colocado = True
                break
        if not colocado:
            raise SystemExit("No caben los calcetines; prueba otra semilla")
        sub = img[y0:y0 + D, x0:x0 + D]
        # sombra suave proyectada
        sombra = cv2.GaussianBlur(mr, (0, 0), 6).astype(np.float32) / 255
        sombra = np.roll(np.roll(sombra, 5, 0), 5, 1)
        sub *= (1 - 0.18 * sombra)[..., None]
        sub[:] = sub * (1 - alfa) + tr * alfa
        mdil = cv2.dilate(mr, np.ones((25, 25), np.uint8))
        ocupado[y0:y0 + D, x0:x0 + D] |= (mdil > 0).astype(np.uint8)
        ys, xs = np.nonzero(mr > 127)
        verdad.append({"id": idx, "pareja": int(pareja), "nombre": nombre,
                       "centro": [float(xs.mean() + x0), float(ys.mean() + y0)]})

    # iluminación desigual + viñeteo + ruido de sensor
    yy, xx = np.mgrid[0:ALTO, 0:ANCHO]
    luz = 0.88 + 0.16 * (xx / ANCHO) - 0.06 * (yy / ALTO)
    vin = 1 - 0.18 * (((xx - ANCHO / 2) / ANCHO) ** 2 + ((yy - ALTO / 2) / ALTO) ** 2)
    img *= (luz * vin)[..., None]
    img += rng.normal(0, 3.5, img.shape).astype(np.float32)
    img = cv2.GaussianBlur(img, (0, 0), 0.8)
    out = np.clip(img, 0, 255).astype(np.uint8)
    cv2.imwrite(a.salida, out, [cv2.IMWRITE_JPEG_QUALITY, 90])
    Path(Path(a.salida).with_suffix("").as_posix() + "_verdad.json").write_text(
        json.dumps(verdad, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"Guardado {a.salida} con {len(verdad)} calcetines")


if __name__ == "__main__":
    main()
