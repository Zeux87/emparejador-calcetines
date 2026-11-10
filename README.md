# Calcetines — emparejador de calcetines

App Android que, a partir de una foto de calcetines desparejados, rodea cada pareja con el mismo color y un número. Los calcetines sin pareja salen en gris con una ✕.

![Ejemplo](docs/ejemplo.jpg)

## Descargar la app

Cada vez que se sube un cambio a `main`, GitHub compila el APK solo. Lo encontrarás en la sección **Releases** de este repositorio. Descarga el `.apk` desde el móvil e instálalo; si Android lo pide, permite instalar apps de ese origen.

## Cómo hacer la foto

- Calcetines **extendidos** por el suelo. Pueden tocarse, pero que no se monten unos encima de otros.
- **Fondo liso**: suelo, manta o sábana.
- **Desde arriba**, con todos dentro y buena luz.

## Qué hace

- Hace la foto con la cámara o la coge de la galería. Todo se procesa en el móvil, sin conexión (unos 10-25 s; la primera vez algo más porque carga los modelos).
- **SlimSAM** (modelo de segmentación) recorta cada calcetín por separado, aunque estén arrugados o se toquen.
- **DINOv2** (modelo de visión) saca la huella de cada trozo del dibujo del calcetín. Para comparar dos calcetines se miran los 20 trozos más distintivos (logos, rayas, tramas) frente al resto de calcetines de la foto, así que cuenta el dibujo y no la forma con la que ha caído.
- **Diferencias generales**: al parecido de DINOv2 se le resta cuando los calcetines se diferencian a simple vista: colores que uno tiene y el otro no (un gris liso frente a uno gris con franjas rojas) y distinta cantidad de dibujo (liso frente a rombos, rayas o tramas).
- Dos calcetines son pareja si cada uno es el más parecido del otro y el parecido supera el umbral.
- Si Android cierra la app mientras la cámara está abierta (pasa por falta de memoria), al volver la foto se recupera y se analiza igualmente. Si el análisis se queda sin memoria, la app se vuelve a abrir y lo avisa. Si no hay ninguno claro, se quedan sin pareja (**✕**); las parejas justas llevan **?**.
- Si el motor de IA no puede arrancar, la app usa el motor básico anterior (colores y formas) y lo indica.
- **Cajón de desparejados**: al pulsar **Hecho**, los calcetines que se quedan sin pareja se guardan en el móvil (miniatura y huella). En las fotos siguientes se comparan también con los del cajón y, si aparece su pareja, se marca con la etiqueta «cajón» y una tarjeta con la miniatura del guardado. Al confirmar, salen del cajón. Desde la pantalla del cajón se les puede poner nombre o borrarlos.
- **Parejas conocidas**: al pulsar **Hecho**, cada pareja confirmada se recuerda en el móvil (miniatura y huella de uno de los dos calcetines). Si más adelante un calcetín de una pareja conocida sale solo en una foto, la app lo reconoce, enseña de cuál es y avisa de que falta el otro; si va al cajón, hereda el nombre. Una pareja que ya se conocía no se duplica: suma una vista. Desde la pantalla **Parejas conocidas** se les puede poner nombre o borrarlas. Las parejas conocidas solo sirven para reconocer: no cambian qué calcetines de la foto se emparejan.
- **Revisar dudosas**: las parejas justas (con **?**) se revisan una a una con los dos calcetines lado a lado: **Sí, son pareja**, **No lo son** o **No lo sé**. Una pareja rechazada no se vuelve a proponer en esa foto, y lo que decidas cuenta para el ajuste del umbral.
- **Casos de prueba**: al pulsar **Hecho** se puede marcar «Guardar la foto como caso de prueba». La foto entera y las parejas dadas por buenas se guardan para medir el acierto del motor con fotos reales (ver «Banco de pruebas con fotos reales»).
- **Aprende de tus correcciones**: cada vez que pulsas **Hecho** se guardan las parejas confirmadas (con tus correcciones). A partir de 4 parejas confirmadas, la app ajusta el umbral de parecido al que mejor habría acertado con tus calcetines.
- **Exportar datos para mejorar**: genera un JSON con las fotos guardadas, las parejas confirmadas y el cajón, para compartirlo y ajustar el motor con fotos reales.
- **Exigencia** (Estricta / Normal / Flexible): cuánto se tienen que parecer dos calcetines para emparejarlos.
- **Corregir**: toca un calcetín y luego su pareja; o selecciónalo y pulsa **Separar**.
- Toca un calcetín para ver solo su pareja. Zoom con pellizco o doble toque.
- Compartir la imagen con el resultado.
- Avisa cuando hay una versión nueva en Releases y la instala desde la propia app.

## Estructura

- `app/src/main/assets/motor-ia.js`: el motor con IA (SlimSAM + DINOv2 con onnxruntime-web).
- `app/src/main/assets/emparejador.js`: el motor básico (separa suelo y objetos; también es el respaldo).
- Los modelos (`assets/modelos/`) y onnxruntime-web (`assets/ort/`) no están en el repositorio: el flujo de compilación los descarga y comprueba su huella SHA-256.
- `app/src/main/assets/index.html`: la interfaz.
- `app/src/main/java/es/pablo/calcetines/MainActivity.java`: la ventana Android (cámara, galería, compartir y actualizaciones).
- `.github/workflows/compilar-apk.yml`: compila y publica el APK.
- `herramientas/`: bancos de pruebas (fotos reales y sintéticas).
- `prototipo-python/`: el prototipo original en Python/OpenCV.

## Banco de pruebas con fotos reales (motor con IA)

Mide cuántas parejas acierta el motor con IA en fotos de verdad, con los mismos modelos que lleva el APK.

1. En la app, al pulsar **Hecho**, marca «Guardar la foto como caso de prueba» (solo si cada calcetín está bien rodeado y las parejas son las correctas).
2. En la pantalla de inicio, pulsa **Exportar datos para mejorar** y guarda el archivo `.json`.
3. Importa los casos y pasa el banco:

```
node herramientas/importar-casos.js calcetines-datos-AAAA-MM-DD.json
npm install --no-save playwright
node herramientas/banco-reales.js --barrido
```

`banco-reales.js` abre la app en Chrome sin ventana, analiza cada foto y compara las parejas con las guardadas. Necesita los modelos en `app/src/main/assets/modelos/` y onnxruntime-web en `app/src/main/assets/ort/` (los pasos están en el flujo de compilación). Con `--barrido` enseña los fallos con cada umbral. No usa el cajón ni las parejas conocidas.

Los casos se guardan en `herramientas/casos-reales/`, que **no se sube** al repositorio (son fotos de tu casa y el repositorio es público). Si se suben, el flujo de compilación pasa el banco con ellos en cada versión.

El flujo de compilación pasa siempre el banco con unos casos sintéticos de control (`herramientas/casos-control.py`), para comprobar que el motor arranca y empareja de principio a fin. El resultado sale en el resumen de la ejecución y no impide publicar.

## Banco de pruebas (motor básico)

Para medir el acierto del motor básico con fotos sintéticas:

```
pip install opencv-python numpy
python herramientas/preparar_banco.py
node herramientas/banco-pruebas.js
```

Genera fotos sintéticas (fondo de madera y sábana beige) con parejas conocidas y un calcetín huérfano, y comprueba cuántas parejas acierta. El motor con IA se ha ajustado con fotos reales.

Para la penalización por colores y dibujo del motor con IA (no necesita los modelos):

```
node herramientas/prueba-diferencias.js
```

Las sesiones exportadas guardan esa penalización (`P`) junto al parecido (`S`) para poder reajustarla con fotos reales.

## Actualizaciones

La app comprueba al abrirse si hay una versión nueva en Releases. Para que funcione, el repositorio tiene que ser público.

La clave de firma (`app/calcetines.jks`) está en el repositorio para que cada versión se pueda instalar encima de la anterior.

## Modelos y licencias

- SlimSAM (`Xenova/slimsam-77-uniform`), derivado de Segment Anything (Apache 2.0).
- DINOv2 small (`Xenova/dinov2-small`), de Meta (Apache 2.0).
- onnxruntime-web, de Microsoft (MIT).
