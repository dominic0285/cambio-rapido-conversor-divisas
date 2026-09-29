package PACKAGE_NAME

import android.app.Activity
import android.app.AlertDialog
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.os.Bundle
import android.os.Handler
import android.os.Looper
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

class ProcessTextActivity : Activity() {

    private val executor = Executors.newSingleThreadExecutor()
    private val handler  = Handler(Looper.getMainLooper())

    companion object {
        private const val PREFS_NAME  = "cambio_rapido_cache"
        private const val KEY_RATE    = "cached_rate"
        private const val KEY_SAVED   = "cached_at"
        // 26 horas: cubre fin de semana (el BCV no actualiza sabado/domingo)
        private const val MAX_CACHE_AGE_MS = 26 * 60 * 60 * 1000L
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val selectedText = intent
            .getCharSequenceExtra(Intent.EXTRA_PROCESS_TEXT)
            ?.toString()?.trim() ?: ""

        val isReadOnly = intent
            .getBooleanExtra(Intent.EXTRA_PROCESS_TEXT_READONLY, false)

        // Normalizar: quita puntos de miles, convierte coma decimal a punto
        val normalized = selectedText
            .replace(".", "")
            .replace(",", ".")
            .replace("[^0-9.]".toRegex(), "")

        val amount = normalized.toDoubleOrNull()

        if (amount == null || amount == 0.0) {
            Toast.makeText(this, "Selecciona un número válido", Toast.LENGTH_SHORT).show()
            finish()
            return
        }

        executor.execute {
            val rate = fetchRateWithCache()
            handler.post {
                if (rate == null) {
                    Toast.makeText(this, "Sin conexión y sin datos guardados", Toast.LENGTH_SHORT).show()
                    finish()
                    return@post
                }
                showDialog(amount, rate, isReadOnly)
            }
        }
    }

    // Intenta DolarApi; si falla, usa cache de SharedPreferences
    private fun fetchRateWithCache(): Double? {
        val prefs = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

        // 1. Intentar red
        val fresh = fetchFromApi()
        if (fresh != null) {
            prefs.edit()
                .putFloat(KEY_RATE, fresh.toFloat())
                .putLong(KEY_SAVED, System.currentTimeMillis())
                .apply()
            return fresh
        }

        // 2. Usar cache si tiene menos de MAX_CACHE_AGE_MS
        val savedAt = prefs.getLong(KEY_SAVED, 0L)
        val age = System.currentTimeMillis() - savedAt
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

    private fun fmt(n: Double): String {
        val sym = DecimalFormatSymbols(Locale("es", "VE")).apply {
            groupingSeparator = '.'
            decimalSeparator  = ','
        }
        return DecimalFormat("#,##0.00", sym).format(n)
    }

    private fun showDialog(amount: Double, rate: Double, isReadOnly: Boolean) {
        val toBs  = fmt(amount * rate)
        val toUsd = fmt(amount / rate)

        AlertDialog.Builder(this)
            .setTitle("Cambio Rápido")
            .setMessage("Tasa BCV: ${fmt(rate)} Bs/$")
            .setPositiveButton("→ Bs   $toBs") { _, _ -> returnText("$toBs Bs", isReadOnly) }
            .setNegativeButton("→ $   $toUsd") { _, _ -> returnText("$$toUsd", isReadOnly) }
            .setNeutralButton("Cancelar") { _, _ -> finish() }
            .setOnCancelListener { finish() }
            .show()
    }

    private fun returnText(result: String, isReadOnly: Boolean) {
        if (!isReadOnly) {
            setResult(RESULT_OK, Intent().apply {
                putExtra(Intent.EXTRA_PROCESS_TEXT, result)
            })
        }
        finish()
    }

    override fun onDestroy() {
        super.onDestroy()
        executor.shutdownNow()
    }
}
