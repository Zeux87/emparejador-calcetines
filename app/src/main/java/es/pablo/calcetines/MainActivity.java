package es.pablo.calcetines;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.MediaStore;
import android.provider.Settings;
import android.util.Base64;
import android.util.JsonWriter;
import android.view.View;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import androidx.core.content.FileProvider;
import androidx.webkit.WebViewAssetLoader;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.OutputStreamWriter;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.Arrays;
import java.util.Date;
import java.util.Locale;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;

public class MainActivity extends Activity {

    private static final String REPO = "Zeux87/emparejador-calcetines";
    private static final String API_ULTIMA = "https://api.github.com/repos/" + REPO + "/releases/latest";

    private static final int REQ_CAMARA = 10;
    private static final int REQ_GALERIA = 11;
    private static final int REQ_PERMISO_CAMARA = 21;

    // La app se sirve desde un dominio https propio para que el motor de IA pueda usar
    // varios hilos (necesita "aislamiento de origen": cabeceras COOP/COEP).
    private static final String DOMINIO = "appassets.androidplatform.net";
    private static final String INICIO = "https://" + DOMINIO + "/assets/index.html";
    private WebViewAssetLoader cargador;

    private WebView web;
    private ValueCallback<Uri[]> callback;
    private Uri fotoUri;

    private static final String PAGINA_VERSIONES = "https://github.com/" + REPO + "/releases/latest";

    // Datos de la última versión encontrada en GitHub
    private volatile String urlApk = null;
    private volatile String versionNueva = null;

    // Estado de la actualización: evita dos descargas a la vez y deja el instalador
    // pendiente si la descarga acaba con la app en segundo plano
    private final AtomicBoolean descargando = new AtomicBoolean(false);
    private volatile File apkPendiente = null;
    private volatile boolean enPrimerPlano = false;

    @Override
    protected void onCreate(Bundle estado) {
        super.onCreate(estado);
        web = new WebView(this);
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);

        web.addJavascriptInterface(new Puente(), "AndroidApp");

        cargador = new WebViewAssetLoader.Builder()
                .setDomain(DOMINIO)
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
                .build();

        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest r) {
                Uri u = r.getUrl();
                WebResourceResponse resp = cargador.shouldInterceptRequest(u);
                if (resp == null) return null;
                String ruta = u.getPath() == null ? "" : u.getPath();
                if (ruta.endsWith(".wasm")) resp.setMimeType("application/wasm");
                else if (ruta.endsWith(".mjs") || ruta.endsWith(".js")) resp.setMimeType("text/javascript");
                else if (ruta.endsWith(".onnx")) resp.setMimeType("application/octet-stream");
                Map<String, String> cab = new HashMap<>();
                if (resp.getResponseHeaders() != null) cab.putAll(resp.getResponseHeaders());
                cab.put("Cross-Origin-Opener-Policy", "same-origin");
                cab.put("Cross-Origin-Embedder-Policy", "require-corp");
                cab.put("Cross-Origin-Resource-Policy", "same-origin");
                cab.put("Cache-Control", "no-cache");
                resp.setResponseHeaders(cab);
                return resp;
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                Uri u = r.getUrl();
                if (DOMINIO.equals(u.getHost())) return false;
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, u));
                } catch (Exception ignored) {
                }
                return true;
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView v, ValueCallback<Uri[]> cb, FileChooserParams p) {
                if (callback != null) callback.onReceiveValue(null);
                callback = cb;
                if (p.isCaptureEnabled()) abrirCamara();
                else abrirGaleria();
                return true;
            }
        });

        aplicarTema();
        web.loadUrl(INICIO);
    }

    @Override
    protected void onResume() {
        super.onResume();
        enPrimerPlano = true;
        File f = apkPendiente;
        if (f != null) {
            apkPendiente = null;
            lanzarInstalador(f);
        }
    }

    @Override
    protected void onPause() {
        enPrimerPlano = false;
        super.onPause();
    }

    @Override
    public void onConfigurationChanged(Configuration nueva) {
        super.onConfigurationChanged(nueva);
        aplicarTema();
    }

    /* ---------------- Tema: colores de las barras del sistema ---------------- */

    private void aplicarTema() {
        boolean oscuro = (getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK)
                == Configuration.UI_MODE_NIGHT_YES;
        int fondo = Color.parseColor(oscuro ? "#121212" : "#F3F0EA");
        int barra = Color.parseColor(oscuro ? "#1D1C1B" : "#FFFFFF");
        getWindow().setStatusBarColor(fondo);
        getWindow().setNavigationBarColor(barra);
        if (web != null) web.setBackgroundColor(fondo);
        View decor = getWindow().getDecorView();
        int f = decor.getSystemUiVisibility();
        int claros = View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
        if (Build.VERSION.SDK_INT >= 26) claros |= View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
        decor.setSystemUiVisibility(oscuro ? (f & ~claros) : (f | claros));
    }

    /* ---------------- Cámara y galería ---------------- */

    private boolean tienePermisoCamara() {
        return checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED;
    }

    @Override
    public void onRequestPermissionsResult(int req, String[] permisos, int[] resultados) {
        super.onRequestPermissionsResult(req, permisos, resultados);
        if (req != REQ_PERMISO_CAMARA) return;
        boolean ok = resultados != null && resultados.length > 0
                && resultados[0] == PackageManager.PERMISSION_GRANTED;
        if (ok) {
            lanzarCamara();
        } else {
            Toast.makeText(this, "Sin permiso de cámara", Toast.LENGTH_SHORT).show();
            devolverFoto(null);
        }
    }

    // Al declarar el permiso CAMERA, Android exige tenerlo concedido para usar la cámara del sistema
    private void abrirCamara() {
        if (!tienePermisoCamara()) {
            requestPermissions(new String[]{Manifest.permission.CAMERA}, REQ_PERMISO_CAMARA);
            return;
        }
        lanzarCamara();
    }

    private void lanzarCamara() {
        try {
            File dir = new File(getCacheDir(), "fotos");
            if (!dir.exists()) dir.mkdirs();
            File[] viejas = dir.listFiles();
            if (viejas != null) for (File v : viejas) v.delete();
            File f = new File(dir, "calcetines_" + System.currentTimeMillis() + ".jpg");
            fotoUri = FileProvider.getUriForFile(this, getPackageName() + ".fotos", f);
            Intent i = new Intent(MediaStore.ACTION_IMAGE_CAPTURE);
            i.putExtra(MediaStore.EXTRA_OUTPUT, fotoUri);
            i.addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_READ_URI_PERMISSION);
            startActivityForResult(i, REQ_CAMARA);
        } catch (Exception e) {
            Toast.makeText(this, "No se ha podido abrir la cámara", Toast.LENGTH_SHORT).show();
            abrirGaleria();
        }
    }

    private void abrirGaleria() {
        Intent i = new Intent(Intent.ACTION_GET_CONTENT);
        i.setType("image/*");
        i.addCategory(Intent.CATEGORY_OPENABLE);
        try {
            startActivityForResult(Intent.createChooser(i, "Elige la foto de los calcetines"), REQ_GALERIA);
        } catch (Exception e) {
            devolverFoto(null);
        }
    }

    private void devolverFoto(Uri[] resultado) {
        if (callback != null) {
            callback.onReceiveValue(resultado);
            callback = null;
        }
    }

    @Override
    protected void onActivityResult(int req, int res, Intent data) {
        super.onActivityResult(req, res, data);
        if (callback == null) return;
        Uri[] resultado = null;
        if (res == RESULT_OK) {
            if (req == REQ_CAMARA && fotoUri != null) {
                resultado = new Uri[]{fotoUri};
            } else if (req == REQ_GALERIA && data != null && data.getData() != null) {
                resultado = new Uri[]{data.getData()};
            }
        }
        devolverFoto(resultado);
    }

    @Override
    public void onBackPressed() {
        if (web == null) {
            super.onBackPressed();
            return;
        }
        // La página decide si el botón atrás vuelve a una vista anterior; si no, se sale de la app
        web.evaluateJavascript("(window.onAndroidBack && window.onAndroidBack()) ? 1 : 0", v -> {
            if (!"1".equals(v)) finish();
        });
    }

    /* ---------------- Compartir el resultado ---------------- */

    private void compartirImagen(String base64) {
        try {
            byte[] datos = Base64.decode(base64, Base64.DEFAULT);
            File dir = new File(getCacheDir(), "compartir");
            if (!dir.exists()) dir.mkdirs();
            File f = new File(dir, "parejas-calcetines.jpg");
            try (OutputStream out = new FileOutputStream(f)) {
                out.write(datos);
            }
            Uri uri = FileProvider.getUriForFile(this, getPackageName() + ".fotos", f);
            Intent i = new Intent(Intent.ACTION_SEND);
            i.setType("image/jpeg");
            i.putExtra(Intent.EXTRA_STREAM, uri);
            i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            runOnUiThread(() -> {
                try {
                    startActivity(Intent.createChooser(i, "Compartir resultado"));
                } catch (Exception e) {
                    Toast.makeText(this, "No hay ninguna app para compartir", Toast.LENGTH_SHORT).show();
                }
            });
        } catch (Exception e) {
            runOnUiThread(() -> Toast.makeText(this, "No se ha podido compartir", Toast.LENGTH_SHORT).show());
        }
    }

    /* ---------------- Almacenamiento: cajón, sesiones y ajustes ---------------- */

    private File dirDatos() {
        File d = new File(getFilesDir(), "datos");
        if (!d.exists()) d.mkdirs();
        return d;
    }

    private static boolean claveValida(String k) {
        return k != null && k.matches("[A-Za-z0-9_\\-]{1,80}");
    }

    private synchronized String leerDato(String clave) {
        if (!claveValida(clave)) return null;
        File f = new File(dirDatos(), clave);
        if (!f.exists()) return null;
        try (FileInputStream in = new FileInputStream(f)) {
            return leerTodo(in);
        } catch (Exception e) {
            return null;
        }
    }

    private synchronized boolean escribirDato(String clave, String valor) {
        if (!claveValida(clave) || valor == null) return false;
        File dir = dirDatos();
        File tmp = new File(dir, clave + ".tmp");
        File destino = new File(dir, clave);
        try (OutputStream out = new FileOutputStream(tmp)) {
            out.write(valor.getBytes(StandardCharsets.UTF_8));
        } catch (Exception e) {
            tmp.delete();
            return false;
        }
        // Escritura atómica: si algo falla a medias, el archivo anterior sigue intacto
        if (destino.exists() && !destino.delete()) {
            tmp.delete();
            return false;
        }
        return tmp.renameTo(destino);
    }

    private synchronized void borrarDato(String clave) {
        if (!claveValida(clave)) return;
        new File(dirDatos(), clave).delete();
    }

    // Junta todos los datos guardados (sesiones con sus fotos, cajón y ajustes) en un
    // archivo JSON y abre el menú de compartir para mandarlo donde quieras.
    private void exportarDatos() {
        new Thread(() -> {
            try {
                File dir = new File(getCacheDir(), "compartir");
                if (!dir.exists()) dir.mkdirs();
                File[] viejos = dir.listFiles();
                if (viejos != null) for (File v : viejos) if (v.getName().endsWith(".json")) v.delete();
                String fecha = new SimpleDateFormat("yyyy-MM-dd", Locale.US).format(new Date());
                File f = new File(dir, "calcetines-datos-" + fecha + ".json");
                int n = 0;
                try (OutputStream os = new FileOutputStream(f);
                     JsonWriter w = new JsonWriter(new OutputStreamWriter(os, StandardCharsets.UTF_8))) {
                    w.beginObject();
                    w.name("app").value("calcetines");
                    w.name("formato").value(1);
                    w.name("fecha").value(new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss", Locale.US).format(new Date()));
                    w.name("version").value(nombreVersion());
                    w.name("datos").beginObject();
                    File[] archivos = dirDatos().listFiles();
                    if (archivos != null) {
                        Arrays.sort(archivos);
                        for (File a : archivos) {
                            String k = a.getName();
                            if (!claveValida(k)) continue;
                            String v = leerDato(k);
                            if (v == null) continue;
                            w.name(k).value(v);
                            n++;
                        }
                    }
                    w.endObject();
                    w.endObject();
                }
                final int total = n;
                Uri uri = FileProvider.getUriForFile(this, getPackageName() + ".fotos", f);
                Intent i = new Intent(Intent.ACTION_SEND);
                i.setType("application/json");
                i.putExtra(Intent.EXTRA_STREAM, uri);
                i.putExtra(Intent.EXTRA_SUBJECT, "Datos de Calcetines " + fecha);
                i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                runOnUiThread(() -> {
                    try {
                        startActivity(Intent.createChooser(i, "Exportar datos"));
                    } catch (Exception e) {
                        Toast.makeText(this, "No hay ninguna app para compartir", Toast.LENGTH_SHORT).show();
                    }
                });
                llamarJs("onExportDone", textoJs("Exportados " + total + " registros."));
            } catch (Exception e) {
                llamarJs("onExportDone", textoJs("No se ha podido exportar."));
            }
        }).start();
    }

    /* ---------------- Versión instalada ---------------- */

    private long codigoVersion() {
        try {
            PackageInfo pi = getPackageManager().getPackageInfo(getPackageName(), 0);
            return pi.getLongVersionCode();
        } catch (Exception e) {
            return 0;
        }
    }

    private String nombreVersion() {
        try {
            PackageInfo pi = getPackageManager().getPackageInfo(getPackageName(), 0);
            return pi.versionName;
        } catch (Exception e) {
            return "?";
        }
    }

    /* ---------------- Comunicación con la página ---------------- */

    private void llamarJs(final String funcion, final String argumentoJson) {
        web.post(() -> web.evaluateJavascript(
                "window." + funcion + " && window." + funcion + "(" + argumentoJson + ")", null));
    }

    private static String textoJs(String s) {
        return JSONObject.quote(s);
    }

    private static String leerTodo(InputStream in) throws Exception {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        return new String(out.toByteArray(), StandardCharsets.UTF_8);
    }

    private HttpURLConnection abrir(String url) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(15000);
        c.setReadTimeout(30000);
        c.setInstanceFollowRedirects(true);
        c.setRequestProperty("User-Agent", "Calcetines");
        return c;
    }

    /* ---------------- Buscar actualización ---------------- */

    private void buscarActualizacion() {
        new Thread(() -> {
            JSONObject r = new JSONObject();
            try {
                r.put("current", nombreVersion());
                HttpURLConnection c = abrir(API_ULTIMA);
                c.setRequestProperty("Accept", "application/vnd.github+json");
                int code = c.getResponseCode();
                if (code == 404) {
                    r.put("error", "No encuentro versiones publicadas. Comprueba que el repositorio de GitHub es público.");
                    llamarJs("onUpdateInfo", r.toString());
                    return;
                }
                if (code != 200) {
                    r.put("error", "GitHub no responde ahora mismo (código " + code + "). Prueba más tarde.");
                    llamarJs("onUpdateInfo", r.toString());
                    return;
                }
                JSONObject rel = new JSONObject(leerTodo(c.getInputStream()));
                String tag = rel.optString("tag_name", "");
                String nombre = tag.startsWith("v") ? tag.substring(1) : tag;
                long numero = 0;
                int punto = nombre.lastIndexOf('.');
                try {
                    numero = Long.parseLong(punto >= 0 ? nombre.substring(punto + 1) : nombre);
                } catch (Exception ignored) {
                }
                String apk = null;
                JSONArray assets = rel.optJSONArray("assets");
                if (assets != null) {
                    for (int i = 0; i < assets.length(); i++) {
                        JSONObject a = assets.getJSONObject(i);
                        if (a.optString("name", "").endsWith(".apk")) {
                            apk = a.optString("browser_download_url", null);
                            break;
                        }
                    }
                }
                boolean hay = numero > codigoVersion() && apk != null;
                urlApk = hay ? apk : null;
                versionNueva = hay ? nombre : null;
                r.put("available", hay);
                r.put("latest", nombre);
            } catch (Exception e) {
                try {
                    r.put("error", "No hay conexión con GitHub. Revisa internet y vuelve a probar.");
                } catch (Exception ignored) {
                }
            }
            llamarJs("onUpdateInfo", r.toString());
        }).start();
    }

    /* ---------------- Descargar e instalar ---------------- */

    private File dirActualizaciones() {
        File dir = new File(getCacheDir(), "actualizaciones");
        if (!dir.exists()) dir.mkdirs();
        return dir;
    }

    // Comprueba que el archivo es un APK de esta app y más nuevo que el instalado
    private String problemaApk(File f) {
        if (f == null || !f.exists() || f.length() < 100_000) return "El archivo descargado está incompleto.";
        try {
            PackageInfo pi = getPackageManager().getPackageArchiveInfo(f.getAbsolutePath(), 0);
            if (pi == null) return "El archivo descargado no es un APK válido.";
            if (!getPackageName().equals(pi.packageName)) return "El archivo descargado no es de esta app.";
            if (pi.getLongVersionCode() <= codigoVersion()) return "La versión descargada no es más nueva que la instalada.";
        } catch (Exception e) {
            return "No se puede leer el archivo descargado.";
        }
        return null;
    }

    private void errorActualizacion(String mensaje) {
        llamarJs("onUpdateError", textoJs(mensaje));
    }

    private void lanzarInstalador(File f) {
        runOnUiThread(() -> {
            try {
                Uri uri = FileProvider.getUriForFile(this, getPackageName() + ".fotos", f);
                Intent i = new Intent(Intent.ACTION_VIEW);
                i.setDataAndType(uri, "application/vnd.android.package-archive");
                i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                startActivity(i);
                llamarJs("onUpdateDone", textoJs("Confirma la instalación en la ventana de Android."));
            } catch (Exception e) {
                errorActualizacion("Android no ha abierto el instalador (" + e.getClass().getSimpleName() + ").");
            }
        });
    }

    private void instalarActualizacion() {
        final String url = urlApk;
        final String version = versionNueva;
        if (url == null || version == null) {
            errorActualizacion("Primero busca actualizaciones.");
            return;
        }
        if (!getPackageManager().canRequestPackageInstalls()) {
            runOnUiThread(() -> {
                try {
                    startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                            Uri.parse("package:" + getPackageName())));
                } catch (Exception ignored) {
                }
            });
            llamarJs("onUpdateDone", textoJs("Activa «Permitir de esta fuente» para Calcetines, vuelve atrás y pulsa Actualizar otra vez."));
            return;
        }
        if (!descargando.compareAndSet(false, true)) {
            llamarJs("onUpdateDone", textoJs("Ya se está descargando, espera un momento."));
            return;
        }
        new Thread(() -> {
            try {
                File dir = dirActualizaciones();
                File destino = new File(dir, "Calcetines-" + version + ".apk");
                // Si ya estaba descargada y es válida, no se vuelve a bajar
                if (problemaApk(destino) != null) {
                    File[] viejos = dir.listFiles();
                    if (viejos != null) for (File v : viejos) v.delete();
                    File parcial = new File(dir, "descarga.part");
                    HttpURLConnection c = abrir(url);
                    c.setReadTimeout(60000);
                    int code = c.getResponseCode();
                    if (code != 200) throw new Exception("GitHub ha respondido con el código " + code + ".");
                    long total = c.getContentLengthLong();
                    long leido = 0;
                    try (InputStream in = c.getInputStream(); OutputStream out = new FileOutputStream(parcial)) {
                        byte[] buf = new byte[65536];
                        int ultimo = -1, n;
                        while ((n = in.read(buf)) > 0) {
                            out.write(buf, 0, n);
                            leido += n;
                            if (total > 0) {
                                int pct = (int) (leido * 100 / total);
                                if (pct >= ultimo + 2) {
                                    ultimo = pct;
                                    llamarJs("onUpdateProgress", pct + "," + (leido / 1048576) + "," + (total / 1048576));
                                }
                            }
                        }
                    }
                    if (total > 0 && leido != total) throw new Exception("La descarga se ha cortado. Vuelve a probar con buena conexión.");
                    if (!parcial.renameTo(destino)) throw new Exception("No se ha podido guardar la descarga.");
                }
                String problema = problemaApk(destino);
                if (problema != null) throw new Exception(problema);
                if (enPrimerPlano) {
                    lanzarInstalador(destino);
                } else {
                    // Android no deja abrir el instalador con la app en segundo plano: se abre al volver
                    apkPendiente = destino;
                    llamarJs("onUpdateDone", textoJs("Descargada. Se instalará al volver a la app."));
                }
            } catch (Exception e) {
                String m = e.getMessage();
                errorActualizacion(m != null && m.endsWith(".") ? m : "No se ha podido descargar la actualización. Revisa la conexión y vuelve a probar.");
            } finally {
                descargando.set(false);
            }
        }).start();
    }

    private void abrirPaginaVersiones() {
        runOnUiThread(() -> {
            try {
                startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(PAGINA_VERSIONES)));
            } catch (Exception e) {
                Toast.makeText(this, "No hay ningún navegador", Toast.LENGTH_SHORT).show();
            }
        });
    }

    /* ---------------- Funciones visibles desde la página ---------------- */

    private class Puente {
        @JavascriptInterface
        public String versionName() {
            return nombreVersion();
        }

        @JavascriptInterface
        public void checkUpdate() {
            buscarActualizacion();
        }

        @JavascriptInterface
        public void installUpdate() {
            instalarActualizacion();
        }

        @JavascriptInterface
        public void openReleasePage() {
            abrirPaginaVersiones();
        }

        @JavascriptInterface
        public void shareImage(String base64) {
            new Thread(() -> compartirImagen(base64)).start();
        }

        @JavascriptInterface
        public String storeGet(String clave) {
            return leerDato(clave);
        }

        @JavascriptInterface
        public boolean storeSet(String clave, String valor) {
            return escribirDato(clave, valor);
        }

        @JavascriptInterface
        public void storeDelete(String clave) {
            borrarDato(clave);
        }

        @JavascriptInterface
        public void exportData() {
            exportarDatos();
        }
    }
}
