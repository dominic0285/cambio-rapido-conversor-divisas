package PACKAGE_NAME

import android.app.PendingIntent
import android.app.StatusBarManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.graphics.drawable.Icon
import android.os.Build
import android.service.quicksettings.Tile
import android.service.quicksettings.TileService

/**
 * Mosaico de Ajustes rápidos "Cambio Rápido".
 * Al tocarlo abre TileConvertActivity, que lee el portapapeles y convierte.
 */
class CambioTileService : TileService() {

    companion object {
        private const val PREFS = "cambio_rapido_cache"
        private const val KEY_ASKED = "tile_add_asked"

        /**
         * Android 13+: muestra el aviso del sistema "¿Agregar mosaico a Ajustes rápidos?".
         * Se pide una sola vez (Android bloquea pedirlo repetidamente si el usuario lo rechaza).
         */
        fun requestAddTile(context: Context, force: Boolean = false) {
            if (Build.VERSION.SDK_INT < 33) return
            val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            if (!force && prefs.getBoolean(KEY_ASKED, false)) return
            try {
                val sbm = context.getSystemService(StatusBarManager::class.java) ?: return
                sbm.requestAddTileService(
                    ComponentName(context, CambioTileService::class.java),
                    "Cambio Rápido",
                    Icon.createWithResource(context, R.drawable.ic_tile_cambio),
                    context.mainExecutor
                ) { _ -> prefs.edit().putBoolean(KEY_ASKED, true).apply() }
            } catch (e: Exception) { /* algunos fabricantes no lo soportan */ }
        }
    }

    override fun onStartListening() {
        super.onStartListening()
        val tile = qsTile ?: return
        tile.state = Tile.STATE_INACTIVE
        tile.label = "Cambio Rápido"
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val prefs = getSharedPreferences("cambio_rapido_cache", Context.MODE_PRIVATE)
            val rate = prefs.getFloat("cached_rate", 0f).toDouble()
            tile.subtitle = if (rate > 0) "BCV ${TileConvertActivity.fmt(rate)}" else "Copia un monto"
        }
        tile.updateTile()
    }

    override fun onClick() {
        super.onClick()
        if (isLocked) {
            unlockAndRun { launchConverter() }
        } else {
            launchConverter()
        }
    }

    private fun launchConverter() {
        val intent = Intent(this, TileConvertActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)

        if (Build.VERSION.SDK_INT >= 34) {
            val pi = PendingIntent.getActivity(
                this, 0, intent,
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
            )
            startActivityAndCollapse(pi)
        } else {
            @Suppress("DEPRECATION")
            startActivityAndCollapse(intent)
        }
    }
}
