const { withAndroidManifest, withDangerousMod, withMainActivity } = require('@expo/config-plugins');
const fs   = require('fs');
const path = require('path');

function withProcessText(config) {

  // Registra la Activity en AndroidManifest.xml
  config = withAndroidManifest(config, (cfg) => {
    const app = cfg.modResults.manifest.application[0];
    if (!app.activity) app.activity = [];

    const ya = app.activity.some(a => a.$?.['android:name']?.includes('ProcessTextActivity'));
    if (!ya) {
      app.activity.push({
        $: {
          'android:name':    '.ProcessTextActivity',
          'android:label':   '. Cambio Rápido',
          'android:theme':   '@style/Theme.AppCompat.Light.Dialog.Alert',
          'android:exported':'true',
          'android:noHistory':'true',
        },
        // android:priority="999" hace que aparezca primero en el menú de selección
        // de texto de Android (por encima de Opera, Gemini, ChatGPT, etc.)
        'intent-filter': [{
          $:        { 'android:priority': '999' },
          action:   [{ $: { 'android:name': 'android.intent.action.PROCESS_TEXT' } }],
          category: [{ $: { 'android:name': 'android.intent.category.DEFAULT' } }],
          data:     [{ $: { 'android:mimeType': 'text/plain' } }],
        }],
      });
    }

    // ── Mosaico de Ajustes rápidos ──────────────────────────────
    const yaTileAct = app.activity.some(a => a.$?.['android:name']?.includes('TileConvertActivity'));
    if (!yaTileAct) {
      app.activity.push({
        $: {
          'android:name':               '.TileConvertActivity',
          'android:label':              'Cambio Rápido',
          'android:theme':              '@android:style/Theme.Translucent.NoTitleBar',
          'android:exported':           'false',
          'android:noHistory':          'true',
          'android:excludeFromRecents': 'true',
          'android:taskAffinity':       `${cfg.android?.package || 'com.cambiorapido'}.tile`,
          'android:launchMode':         'singleTask',
        },
      });
    }

    if (!app.service) app.service = [];
    const yaTile = app.service.some(s => s.$?.['android:name']?.includes('CambioTileService'));
    if (!yaTile) {
      app.service.push({
        $: {
          'android:name':       '.CambioTileService',
          'android:label':      'Cambio Rápido',
          'android:icon':       '@drawable/ic_tile_cambio',
          'android:permission': 'android.permission.BIND_QUICK_SETTINGS_TILE',
          'android:exported':   'true',
        },
        'intent-filter': [{
          action: [{ $: { 'android:name': 'android.service.quicksettings.action.QS_TILE' } }],
        }],
      });
    }
    return cfg;
  });

  // Copia el .kt al lugar correcto dentro del proyecto Android generado
  config = withDangerousMod(config, ['android', (cfg) => {
    const pkg     = cfg.android?.package || 'com.cambiorapido';
    const pkgPath = pkg.replace(/\./g, '/');
    const dest    = path.join(
      cfg.modRequest.platformProjectRoot,
      'app/src/main/java', pkgPath
    );
    fs.mkdirSync(dest, { recursive: true });

    const pluginsDir = path.join(cfg.modRequest.projectRoot, 'plugins');
    for (const file of ['ProcessTextActivity.kt', 'TileConvertActivity.kt', 'CambioTileService.kt']) {
      let kt = fs.readFileSync(path.join(pluginsDir, file), 'utf8');
      kt = kt.replace(/^\uFEFF/, '').replace('PACKAGE_NAME', pkg);
      fs.writeFileSync(path.join(dest, file), kt);
    }

    // Icono del mosaico
    const drawable = path.join(cfg.modRequest.platformProjectRoot, 'app/src/main/res/drawable');
    fs.mkdirSync(drawable, { recursive: true });
    fs.copyFileSync(path.join(pluginsDir, 'ic_tile_cambio.xml'), path.join(drawable, 'ic_tile_cambio.xml'));
    return cfg;
  }]);

  // Al abrir la app, pide agregar el mosaico a Ajustes rápidos (Android 13+)
  config = withMainActivity(config, (cfg) => {
    let src = cfg.modResults.contents;
    if (!src.includes('CambioTileService.requestAddTile')) {
      src = src.replace(/(super\.onCreate\([^)]*\))/, '$1\n    CambioTileService.requestAddTile(this)');
    }
    cfg.modResults.contents = src;
    return cfg;
  });

  return config;
}

module.exports = withProcessText;