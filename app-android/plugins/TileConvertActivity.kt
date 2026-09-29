package PACKAGE_NAME

import android.app.Activity
import android.app.AlertDialog
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.InputType
import android.view.WindowManager
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.Toast
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.URL
import java.text.DecimalFormat
import java.text.DecimalFormatSymbols
import java.util.Locale
import java.util.concurrent.Executors

/**
 * Se abre desde el mosaico de Ajustes rápidos.
 * 1. Lee el número del portapapeles (solo es posible cuando la ventana tiene foco).
 * 2. Si no hay número, pide escribirlo.
 * 3. Muestra la conversión y copia el resultado al portapapeles para pegarlo en el banco.
 */
class TileConvertActivity : Activity() {

    private val executor = Executors.newSingleThreadExecutor()
    private val handler  = Handler(Looper.getMainLooper())
    private var started  = false

    companion object {
        private const val PREFS_NAME = "cambio_rapido_cache"   // mismo cache que ProcessTextActivity
        private const val KEY_RATE   = "cached_rate"
        private const val KEY_SAVED  = "cached_at"
        private const val MAX_CACHE_AGE_MS = 26 * 60 * 60 * 1000L
        private const val DIALOG_THEME = android.R.style.Theme_DeviceDefault_Dialog_Alert

        fun fmt(n: Double): String {
            val sym = DecimalFormatSymbols(Locale("es", "VE")).apply {
                groupingSeparator = '.'
                decimalSeparator  = ','
            }
            return DecimalFormat("#,##0.00", sym).format(n)
        }

        /** Formato para pegar en campos de monto: sin separador de miles, coma decimal. */
        fun fmtPlain(n: Double): String {
            val sym = DecimalFormatSymbols(Locale("es", "VE")).apply { decimalSeparator = ',' }
            return DecimalFormat("0.00", sym).format(n)
        }

        /**
         * Entiende "1.234,56", "1,234.56", "20.50", "20,5", "Bs. 3.650,00", "$20".
         * Regla: si hay punto y coma, el último que aparece es el decimal.
         * Si hay solo uno, es decimal cuando le siguen 1 o 2 dígitos al final.
         */
        fun parseAmount(raw: String): Double? {
            var s = raw.replace("[^0-9.,]".toRegex(), "")
            if (s.isEmpty()) return null
            val lastDot = s.lastIndexOf('.')
            val lastComma = s.lastIndexOf(',')
            s = when {
                lastDot >= 0 && lastComma >= 0 -> {
                    if (lastComma > lastDot) s.replace(".", "").replace(",", ".")
                    else s.replace(",", "")
                }
                lastComma >= 0 -> normalizeSingle(s, ',')
                lastDot >= 0   -> normalizeSingle(s, '.')
                else -> s
            }
            val v = s.toDoubleOrNull() ?: return null
            return if (v > 0) v else null
        }

        private fun normalizeSingle(s: String, sep: Char): String {
            val count = s.count { it == sep }
            val decimals = s.length - s.lastIndexOf(sep) - 1
            return if (count == 1 && decimals in 1..2) s.replace(sep, '.')
                   else s.replace(sep.toString(), "")
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_STATE_VISIBLE)
    }

    // Android 10+ solo deja leer el portapapeles cuando la app tiene el foco.
    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (!hasFocus || started) return
        started = true

        val amount = readClipboard()?.let { parseAmount(it) }
        if (amount != null) convert(amount) else askAmount()
    }

    private fun readClipboard(): String? = try {
        val cm = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        val clip = cm.primaryClip
        if (clip != null && clip.itemCount > 0) clip.getItemAt(0).coerceToText(this)?.toString() else null
    } catch (e: Exception) { null }

    private fun askAmount() {
        val input = EditText(this).apply {
            inputType = InputType.TYPE_CLASS_NUMBER or InputType.TYPE_NUMBER_FLAG_DECIMAL
            hint = "Ej: 20,50"
        }
        val box = FrameLayout(this).apply {
            val p = (20 * resources.displayMetrics.density).toInt()
            setPadding(p, p / 2, p, 0)
            addView(input)
        }
        AlertDialog.Builder(this, DIALOG_THEME)
            .setTitle("Cambio Rápido")
            .setMessage("No hay un monto copiado. Escríbelo:")
            .setView(box)
            .setPositiveButton("Convertir") { _, _ ->
                val a = parseAmount(input.text.toString())
                if (a == null) toastAndFinish("Monto no válido") else convert(a)
            }
            .setNegativeButton("Cancelar") { _, _ -> finish() }
            .setOnCancelListener { finish() }
            .show()
        input.requestFocus()
    }

    private fun convert(amount: Double) {
        executor.execute {
            val rate = fetchRateWithCache()
            handler.post {
                if (isFinishing) return@post
                if (rate == null) toastAndFinish("Sin conexión y sin tasa guardada")
                else showResult(amount, rate)
            }
        }
    }

    private fun showResult(amount: Double, rate: Double) {
        val toBs  = amount * rate
        val toUsd = amount / rate
        AlertDialog.Builder(this, DIALOG_THEME)
            .setTitle("Monto: ${fmt(amount)}")
            .setMessage("Tasa BCV: ${fmt(rate)} Bs/$\n\nToca una opción para copiarla y pégala en el banco.")
            .setPositiveButton("$ → Bs  ${fmt(toBs)}") { _, _ -> copyAndFinish(fmtPlain(toBs), "${fmt(toBs)} Bs") }
            .setNegativeButton("Bs → $  ${fmt(toUsd)}") { _, _ -> copyAndFinish(fmtPlain(toUsd), "$${fmt(toUsd)}") }
            .setNeutralButton("Cancelar") { _, _ -> finish() }
            .setOnCancelListener { finish() }
            .show()
    }

    private fun copyAndFinish(value: String, shown: String) {
        val cm = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        cm.setPrimaryClip(ClipData.newPlainText("Cambio Rápido", value))
        // Android 13+ ya muestra su propio aviso de "copiado"
        if (Build.VERSION.SDK_INT < 33) {
            Toast.makeText(this, "Copiado: $shown", Toast.LENGTH_SHORT).show()
        }
        finish()
    }

    private fun toastAndFinish(msg: String) {
        Toast.makeText(this, msg, Toast.LENGTH_SHORT).show()
        finish()
    }

    // ── Tasa: red primero, luego cache (misma lógica que ProcessTextActivity) ──
    private fun fetchRateWithCache(): Double? {
        val prefs = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val fresh = fetchFromApi()
        if (fresh != null) {
            prefs.edit()
                .putFloat(KEY_RATE, fresh.toFloat())
                .putLong(KEY_SAVED, System.currentTimeMillis())
                .apply()
            return fresh
        }
        val age = System.currentTimeMillis() - prefs.getLong(KEY_SAVED, 0L)
        if (age < MAX_CACHE_AGE_MS) {
            val cached = prefs.getFloat(KEY_RATE, 0f).toDouble()
            if (cached > 0) return cached
        }
        return null
    }

    // Dolar oficial BCV desde la API publica DolarApi (https://ve.dolarapi.com)
    private fun fetchFromApi(): Double? {
        return try {
            val conn = URL("https://ve.dolarapi.com/v1/dolares/oficial").openConnection() as HttpURLConnection
            conn.requestMethod  = "GET"
            conn.connectTimeout = 8000
            conn.readTimeout    = 8000
            conn.setRequestProperty("Accept", "application/json")
            val response = BufferedReader(InputStreamReader(conn.inputStream)).readText()
            val value = JSONObject(response).optDouble("promedio", 0.0)
            if (value > 0) value else null
        } catch (e: Exception) { null }
    }

    override fun onDestroy() {
        super.onDestroy()
        executor.shutdownNow()
    }
}
