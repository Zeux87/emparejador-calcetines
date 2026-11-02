# Calcetines — emparejador de calcetines

App Android que, a partir de una foto de calcetines desparejados, rodea cada pareja con el mismo color y un número. Los calcetines sin pareja salen en gris con una ✕.

![Ejemplo](docs/ejemplo.jpg)

## Descargar la app

Cada vez que se sube un cambio a `main`, GitHub compila el APK solo. Lo encontrarás en la sección **Releases** de este repositorio. Descarga el `.apk` desde el móvil e instálalo; si Android lo pide, permite instalar apps de ese origen.

## Cómo hacer la foto

- Calcetines **extendidos y sin tocarse** (si se tocan un poco intenta separarlos; si se montan, no).
- **Fondo liso de tono medio**: suelo de madera, manta gris… Un fondo blanco o negro se confunde con calcetines de ese color.
- **Desde arriba**, con buena luz y sin sombras fuertes.

## Qué hace

- Hace la foto con la cámara o la coge de la galería. Todo se procesa en el móvil, sin conexión.
- Separa los calcetines del fondo modelando el color de la tela o el suelo (aunque la luz no sea uniforme).
- Saca una "huella" de cada calcetín: colores dominantes, histograma de color, textura (LBP), rayas a lo largo de la pierna, variación interna de color y tamaño (distingue talla de adulto y de niño).
- Empareja buscando la combinación de parejas más parecidas; las que no tienen un candidato claro llevan **?** y las que no tienen pareja, **✕**.
- **Exigencia** (Estricta / Normal / Flexible): cuánto se tienen que parecer dos calcetines para emparejarlos.
- **Corregir**: toca un calcetín y luego su pareja; o selecciónalo y pulsa **Separar**.
- Toca un calcetín para ver solo su pareja. Zoom con pellizco o doble toque.
- Compartir la imagen con el resultado.
- Avisa cuando hay una versión nueva en Releases y la instala desde la propia app.

## Estructura

- `app/src/main/assets/emparejador.js`: el motor de detección y emparejamiento (JavaScript puro, sin librerías).
- `app/src/main/assets/index.html`: la interfaz.
- `app/src/main/java/es/pablo/calcetines/MainActivity.java`: la ventana Android (cámara, galería, compartir y actualizaciones).
- `.github/workflows/compilar-apk.yml`: compila y publica el APK.
- `herramientas/`: banco de pruebas con fotos sintéticas.
- `prototipo-python/`: el prototipo original en Python/OpenCV.

## Banco de pruebas

Para medir el acierto antes y después de tocar el motor:

```
pip install opencv-python numpy
python herramientas/preparar_banco.py
node herramientas/banco-pruebas.js
```

Genera fotos sintéticas (fondo de madera y sábana beige) con parejas conocidas y un calcetín huérfano, y comprueba cuántas parejas acierta la app.

## Actualizaciones

La app comprueba al abrirse si hay una versión nueva en Releases. Para que funcione, el repositorio tiene que ser público.

La clave de firma (`app/calcetines.jks`) está en el repositorio para que cada versión se pueda instalar encima de la anterior.
