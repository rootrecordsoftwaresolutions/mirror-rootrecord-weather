const { app, BrowserWindow, ipcMain, shell } = require('electron');
const Store = require('electron-store');
const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();
const crypto = require('crypto');

function resolveWeatherManagerHome() {
  const directHome = String(process.env.RR_WEATHER_HOME || '').trim();
  if (directHome) return path.resolve(directHome);
  const installedPointer = path.join(path.dirname(process.execPath), 'weather-manager-data-path.txt');
  try {
    if (fs.existsSync(installedPointer)) {
      const customPath = String(fs.readFileSync(installedPointer, 'utf8') || '').trim();
      if (customPath) return path.resolve(customPath);
    }
  } catch {
    // Ignore pointer read errors and continue with default path logic.
  }
  const envHome = String(process.env.ROOTRECORD_HOME || '').trim();
  if (envHome) return path.join(path.resolve(envHome), 'Weather Manager');
  if (process.platform === 'win32') {
    const localAppData = String(process.env.LOCALAPPDATA || '').trim();
    if (localAppData) return path.join(localAppData, 'RootRecord', 'Weather Manager');
  }
  return path.join(app.getPath('appData'), 'RootRecord', 'Weather Manager');
}

const WEATHER_MANAGER_HOME = resolveWeatherManagerHome();
fs.mkdirSync(WEATHER_MANAGER_HOME, { recursive: true });
try {
  app.setPath('userData', WEATHER_MANAGER_HOME);
} catch {
  // Ignore path override issues and continue.
}

const store = new Store({ cwd: WEATHER_MANAGER_HOME });
let mainWindow;
let alertWindow;
let db;

const LOCATION_CONFIG_KEY = 'weatherLocationConfig';
const DATA_ARCHIVE_KEY = 'weatherDataArchive';
const OPEN_AT_LOGIN_KEY = 'openAtLogin';
const AUTH_SESSION_TOKEN_KEY = 'coreAuthSessionToken';
const AUTH_EMAIL_KEY = 'coreAuthEmail';
const DEVICE_ID_KEY = 'coreAuthDeviceId';

// Match Business Manager shipped default; env var still overrides this.
const SHIPPED_CORE_API_BASE_URL = 'https://rootrecord-license.wildecho94.workers.dev';
const CORE_API_BASE_URL = String(process.env.LICENSE_API_BASE_URL || SHIPPED_CORE_API_BASE_URL).trim();
const CORE_API_SHARED_BEARER = String(process.env.LICENSE_API_SECRET || '').trim();
const ALERT_SOUNDS_DIR = String(
  process.env.RR_ALERT_SOUNDS_DIR ||
  'C:\\Users\\Admin\\Documents\\RR Business Operations\\Development\\Resources'
).trim();

function initLocalDatabase() {
  const dbPath = path.join(app.getPath('userData'), 'weather-manager.db');
  db = new sqlite3.Database(dbPath);
  db.serialize(() => {
    db.run(`
      CREATE TABLE IF NOT EXISTS rr_event_records (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT NOT NULL,
        category TEXT NOT NULL,
        event_time TEXT,
        is_forecast INTEGER NOT NULL DEFAULT 0,
        title TEXT,
        severity TEXT,
        location_name TEXT,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    db.run('CREATE INDEX IF NOT EXISTS idx_rr_event_records_source ON rr_event_records(source)');
    db.run('CREATE INDEX IF NOT EXISTS idx_rr_event_records_category ON rr_event_records(category)');
    db.run('CREATE INDEX IF NOT EXISTS idx_rr_event_records_forecast ON rr_event_records(is_forecast)');
    db.run('CREATE INDEX IF NOT EXISTS idx_rr_event_records_event_time ON rr_event_records(event_time)');
  });
}

function runSql(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) return reject(err);
      resolve(this);
    });
  });
}

function allSql(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows);
    });
  });
}

function getOrCreateDeviceId() {
  const existing = String(store.get(DEVICE_ID_KEY, '') || '').trim();
  if (existing) return existing;
  const created = crypto.randomUUID();
  store.set(DEVICE_ID_KEY, created);
  return created;
}

function getCoreApiBaseUrlOrThrow() {
  if (!CORE_API_BASE_URL) {
    throw new Error('Core auth API is not configured. Set LICENSE_API_BASE_URL.');
  }
  return CORE_API_BASE_URL.replace(/\/+$/, '');
}

async function coreApiJson(pathname, body, token, method = 'POST') {
  const base = getCoreApiBaseUrlOrThrow();
  const headers = { 'Content-Type': 'application/json' };
  const bearer = String(token || '').trim() || CORE_API_SHARED_BEARER;
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  let response;
  try {
    response = await fetch(`${base}${pathname}`, {
      method,
      headers,
      body: method === 'GET' ? undefined : JSON.stringify(body || {}),
      signal: controller.signal
    });
  } catch (error) {
    if (error && error.name === 'AbortError') {
      throw new Error('Core auth request timed out.');
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok) {
    let message = `HTTP ${response.status}`;
    if (payload && typeof payload === 'object') {
      if (typeof payload.error === 'string') message = payload.error;
      if (payload.error && typeof payload.error === 'object' && payload.error.message) message = String(payload.error.message);
      if (payload.message) message = String(payload.message);
    }
    throw new Error(message);
  }
  return payload || {};
}

async function storeRecords(records, meta) {
  if (!db || !Array.isArray(records) || !records.length) return;
  await runSql('BEGIN TRANSACTION');
  try {
    for (const record of records) {
      await runSql(
        `INSERT INTO rr_event_records
          (source, category, event_time, is_forecast, title, severity, location_name, payload_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          String(meta.source || 'unknown'),
          String(meta.category || 'general'),
          record && record.eventTime ? String(record.eventTime) : null,
          meta.isForecast ? 1 : 0,
          record && record.title ? String(record.title) : null,
          record && record.severity ? String(record.severity) : null,
          record && record.locationName ? String(record.locationName) : null,
          JSON.stringify(record || {})
        ]
      );
    }
    await runSql('COMMIT');
  } catch (error) {
    await runSql('ROLLBACK');
    throw error;
  }
}

function applyOpenAtLoginSetting() {
  if (process.platform !== 'win32') return;
  const enabled = Boolean(store.get(OPEN_AT_LOGIN_KEY, false));
  const options = { openAtLogin: enabled };
  if (process.defaultApp) {
    options.path = process.execPath;
    options.args = [app.getAppPath()];
  } else {
    options.path = process.execPath;
  }
  try {
    app.setLoginItemSettings(options);
  } catch {
    // Ignore login registration failures to avoid blocking app startup.
  }
}

function defaultConfig() {
  return {
    isConfigured: false,
    radiusMiles: 150,
    unitSystem: 'imperial',
    criticalAlerts: {
      weatherEnabled: true,
      usgsEnabled: true,
      usgsMinMagnitude: 5.0,
      usgsMaxDistanceMiles: 200,
      soundPath: ''
    },
    locations: []
  };
}

function readLocationConfig() {
  const cfg = store.get(LOCATION_CONFIG_KEY, defaultConfig());
  if (!cfg || typeof cfg !== 'object') return defaultConfig();
  if (!Array.isArray(cfg.locations)) return defaultConfig();
  const radius = Number(cfg.radiusMiles);
  const unitSystem = String(cfg.unitSystem || '').toLowerCase() === 'metric' ? 'metric' : 'imperial';
  const alerts = cfg.criticalAlerts && typeof cfg.criticalAlerts === 'object' ? cfg.criticalAlerts : {};
  const usgsMinMagnitude = Number(alerts.usgsMinMagnitude);
  const usgsMaxDistanceMiles = Number(alerts.usgsMaxDistanceMiles);
  const soundPath = String(alerts.soundPath || '').trim();
  return {
    isConfigured: Boolean(cfg.isConfigured),
    radiusMiles: Number.isFinite(radius) && radius > 0 ? radius : 150,
    unitSystem,
    criticalAlerts: {
      weatherEnabled: alerts.weatherEnabled !== false,
      usgsEnabled: alerts.usgsEnabled !== false,
      usgsMinMagnitude: Number.isFinite(usgsMinMagnitude) ? Math.max(0, usgsMinMagnitude) : 5.0,
      usgsMaxDistanceMiles: Number.isFinite(usgsMaxDistanceMiles) && usgsMaxDistanceMiles > 0 ? usgsMaxDistanceMiles : 200,
      soundPath
    },
    locations: cfg.locations
      .map((loc) => ({
        name: String(loc.name || '').trim(),
        latitude: Number(loc.latitude),
        longitude: Number(loc.longitude)
      }))
      .filter((loc) => loc.name && Number.isFinite(loc.latitude) && Number.isFinite(loc.longitude))
  };
}

function defaultArchive() {
  return {
    noaa: [],
    usgs: [],
    canada: [],
    tsunamis: [],
    noaaDashboard: [],
    spaceWeather: [],
    cyclones: [],
    wildfires: [],
    forecasts: []
  };
}

function readArchive() {
  const archive = store.get(DATA_ARCHIVE_KEY, defaultArchive());
  if (!archive || typeof archive !== 'object') return defaultArchive();
  return {
    noaa: Array.isArray(archive.noaa) ? archive.noaa : [],
    usgs: Array.isArray(archive.usgs) ? archive.usgs : [],
    canada: Array.isArray(archive.canada) ? archive.canada : [],
    tsunamis: Array.isArray(archive.tsunamis) ? archive.tsunamis : [],
    noaaDashboard: Array.isArray(archive.noaaDashboard) ? archive.noaaDashboard : [],
    spaceWeather: Array.isArray(archive.spaceWeather) ? archive.spaceWeather : [],
    cyclones: Array.isArray(archive.cyclones) ? archive.cyclones : [],
    wildfires: Array.isArray(archive.wildfires) ? archive.wildfires : [],
    forecasts: Array.isArray(archive.forecasts) ? archive.forecasts : []
  };
}

function writeArchive(archive) {
  store.set(DATA_ARCHIVE_KEY, archive);
}

function appendArchive(type, items) {
  if (!Array.isArray(items) || !items.length) return;
  const archive = readArchive();
  const stamped = items.map((item) => ({
    receivedAt: new Date().toISOString(),
    payload: item
  }));
  if (type === 'noaa') archive.noaa.push(...stamped);
  if (type === 'usgs') archive.usgs.push(...stamped);
  if (type === 'canada') archive.canada.push(...stamped);
  if (type === 'tsunamis') archive.tsunamis.push(...stamped);
  if (type === 'noaaDashboard') archive.noaaDashboard.push(...stamped);
  if (type === 'spaceWeather') archive.spaceWeather.push(...stamped);
  if (type === 'cyclones') archive.cyclones.push(...stamped);
  if (type === 'wildfires') archive.wildfires.push(...stamped);
  if (type === 'forecasts') archive.forecasts.push(...stamped);
  writeArchive(archive);
}

function createOrShowCriticalPopup(payload) {
  const safePayload = payload && typeof payload === 'object' ? payload : {};
  const lines = Array.isArray(safePayload.lines) ? safePayload.lines : [];
  const title = String(safePayload.title || 'Critical Alert');
  const message = lines.join('\n');

  if (alertWindow && !alertWindow.isDestroyed()) {
    alertWindow.webContents.send('critical-popup-data', { title, message });
    alertWindow.show();
    alertWindow.focus();
    return;
  }

  alertWindow = new BrowserWindow({
    width: 560,
    height: 340,
    alwaysOnTop: true,
    skipTaskbar: false,
    frame: true,
    title: 'Root Record Critical Alert',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });
  alertWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  alertWindow.setAlwaysOnTop(true, 'screen-saver');
  alertWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8" />
      <title>Critical Alert</title>
      <style>
        body { margin: 0; padding: 14px; background: #200000; color: #ffdede; font-family: 'Segoe UI', sans-serif; }
        h2 { margin: 0 0 10px 0; color: #ff8a8a; }
        #msg { white-space: pre-wrap; background: #2b0d0d; border: 1px solid #5a1d1d; padding: 10px; border-radius: 4px; height: 220px; overflow-y: auto; }
        button { margin-top: 10px; padding: 8px 12px; background: #b71c1c; color: white; border: none; border-radius: 4px; cursor: pointer; }
      </style>
    </head>
    <body>
      <h2 id="title">Critical Alert</h2>
      <div id="msg"></div>
      <button onclick="window.close()">Dismiss</button>
      <script>
        const { ipcRenderer } = require('electron');
        function update(data) {
          document.getElementById('title').textContent = data.title || 'Critical Alert';
          document.getElementById('msg').textContent = data.message || '';
        }
        ipcRenderer.on('critical-popup-data', (_e, data) => update(data || {}));
        update(${JSON.stringify({ title, message })});
      </script>
    </body>
    </html>
  `));
  alertWindow.show();
  alertWindow.focus();
  alertWindow.on('closed', () => {
    alertWindow = null;
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1500,
    height: 950,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: true,
      contextIsolation: false,
      sandbox: false
    },
    title: 'Root Record Weather Manager'
  });
  mainWindow.setMenu(null);

  const appHtml = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8" />
      <title>Root Record Weather Manager</title>
      <style>
        body {
          font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
          margin: 0;
          padding: 20px;
          background: #1e1e1e;
          color: #d4d4d4;
        }
        .auth-gate {
          position: fixed;
          inset: 0;
          z-index: 1000;
          background: #121212;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 20px;
        }
        .auth-card {
          width: 100%;
          max-width: 520px;
          background: #252526;
          border-radius: 8px;
          border: 1px solid #333;
          padding: 18px;
        }
        .container { display: flex; height: calc(100vh - 40px); gap: 18px; }
        .sidebar {
          width: 340px;
          background: #252526;
          padding: 16px;
          border-radius: 6px;
          overflow-y: auto;
        }
        .main {
          flex: 1;
          background: #252526;
          padding: 16px;
          border-radius: 6px;
          overflow-y: auto;
        }
        .btn {
          background: #007acc;
          color: white;
          border: none;
          padding: 8px 14px;
          margin: 4px 0;
          border-radius: 4px;
          cursor: pointer;
        }
        .btn:hover { background: #005f9d; }
        .btn:disabled {
          background: #5a5a5a;
          cursor: not-allowed;
        }
        .btn.success { background: #2e7d32; }
        .btn.success:hover { background: #256628; }
        .btn.danger { background: #b71c1c; }
        .btn.danger:hover { background: #8e1616; }
        .card {
          background: #2d2d30;
          border-left: 3px solid #007acc;
          border-radius: 4px;
          padding: 10px;
          margin-bottom: 10px;
        }
        .clickable-card {
          cursor: pointer;
          transition: background 0.15s ease, transform 0.08s ease;
        }
        .clickable-card:hover {
          background: #34343a;
        }
        .clickable-card:active {
          transform: translateY(1px);
        }
        .status {
          padding: 10px;
          border-radius: 4px;
          margin: 8px 0 14px 0;
          font-size: 13px;
        }
        .status.ok { background: #1b5e20; }
        .status.warn { background: #8a6d1b; }
        .status.error { background: #7f1d1d; }
        .row { margin-bottom: 10px; }
        label { display: block; font-size: 12px; color: #b8b8b8; margin-bottom: 4px; }
        input {
          width: calc(100% - 16px);
          padding: 8px;
          border: 1px solid #555;
          border-radius: 4px;
          background: #1e1e1e;
          color: #d4d4d4;
        }
        .location-row {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 8px;
          padding: 8px;
          margin-bottom: 6px;
          background: #1e1e1e;
          border-radius: 4px;
        }
        .muted { color: #9a9a9a; font-size: 12px; }
        .section-title { color: #4ec9b0; margin-top: 0; }
        .result-group { margin-bottom: 22px; }
        .dashboard-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
          gap: 12px;
          margin: 12px 0 18px 0;
        }
        .map-modal {
          position: fixed;
          inset: 0;
          background: rgba(0, 0, 0, 0.72);
          z-index: 1200;
          display: none;
          align-items: center;
          justify-content: center;
          padding: 16px;
        }
        .map-card {
          width: min(900px, 96vw);
          height: min(680px, 92vh);
          background: #252526;
          border-radius: 8px;
          border: 1px solid #333;
          padding: 12px;
          display: flex;
          flex-direction: column;
        }
        #locationMap {
          flex: 1;
          border: 1px solid #333;
          border-radius: 6px;
          min-height: 360px;
          background: #111;
        }
        .detail-modal {
          position: fixed;
          inset: 0;
          background: rgba(0, 0, 0, 0.72);
          z-index: 1201;
          display: none;
          align-items: center;
          justify-content: center;
          padding: 16px;
        }
        .detail-card {
          width: min(820px, 96vw);
          max-height: min(680px, 92vh);
          overflow: auto;
          background: #252526;
          border-radius: 8px;
          border: 1px solid #333;
          padding: 12px;
        }
        pre {
          background: #161616;
          padding: 10px;
          border-radius: 4px;
          border: 1px solid #333;
          white-space: pre-wrap;
          word-wrap: break-word;
        }
      </style>
    </head>
    <body>
      <div id="authGate" class="auth-gate" style="display:none;">
        <div class="auth-card">
          <h1 style="margin-top:0;">Root Record Sign In</h1>
          <p class="muted">You must sign in or create an account before Weather Manager can load.</p>
          <div class="row">
            <label for="authEmail">Email</label>
            <input id="authEmail" placeholder="you@example.com" />
          </div>
          <div class="row">
            <label for="authPassword">Password</label>
            <input id="authPassword" type="password" placeholder="At least 10 characters" />
          </div>
          <div class="row">
            <button id="authSignInBtn" class="btn success" onclick="authSignIn()">Sign In</button>
            <button id="authSignUpBtn" class="btn" onclick="authSignUp()">Create Account</button>
            <button id="authSubscribeBtn" class="btn warning" onclick="startCheckout()">Subscribe</button>
            <button id="authOpenWebsiteBtn" class="btn" onclick="openRootRecordWebsite()">Open RootRecord.com</button>
          </div>
          <p id="trialNotice" class="muted" style="margin-top:4px;">New accounts include a 14-day free trial.</p>
          <div id="authStatus" class="status warn">Enter your email and password to sign in.</div>
        </div>
      </div>

      <div id="appShell" class="container" style="display:flex;">
        <aside class="sidebar">
          <h2 class="section-title">Resources</h2>
          <button class="btn" style="width:100%" onclick="showPage('weather')">Weather (NOAA)</button>
          <button class="btn" style="width:100%" onclick="showPage('earthquakes')">Earthquakes & Tsunamis</button>
          <button class="btn" style="width:100%" onclick="showPage('space-weather')">Space Weather</button>
          <button class="btn" style="width:100%" onclick="showPage('cyclones')">Cyclone Tracker</button>
          <button class="btn" style="width:100%" onclick="showPage('wildfires')">Wildfires</button>
          <button class="btn" style="width:100%" onclick="showPage('forecasts')">Forecasts</button>
          <button class="btn" style="width:100%" onclick="showPage('settings')">Settings</button>
          <button class="btn" style="width:100%" onclick="showPage('about')">About / Coverage</button>
          <button class="btn" style="width:100%" onclick="showPage('contact')">Contact & Feedback</button>
        </aside>

        <main class="main">
          <div id="weather-page" class="page">
            <h1>Weather (NOAA)</h1>
            <p class="muted">All active NOAA watches, warnings, and advisories scoped by your configured locations.</p>
            <div id="weatherRunStatus" class="status warn">Setup is required before weather data fetch.</div>
            <button id="weatherRefreshBtn" class="btn" onclick="refreshNoaa()">Refresh NOAA Alerts</button>
            <div class="dashboard-grid">
              <div class="card clickable-card" onclick="openDashboardDetail('weatherCurrentCard','Current Conditions')">
                <h3 style="margin-top:0;">Current Conditions</h3>
                <div id="weatherCurrentCard" class="muted">No NOAA current condition data yet.</div>
              </div>
              <div class="card clickable-card" onclick="openDashboardDetail('weatherDailyCard','Daily Forecast')">
                <h3 style="margin-top:0;">Daily Forecast</h3>
                <div id="weatherDailyCard" class="muted">No NOAA daily forecast data yet.</div>
              </div>
              <div class="card clickable-card" onclick="openDashboardDetail('weatherAveragesCard','24h Averages')">
                <h3 style="margin-top:0;">24h Averages</h3>
                <div id="weatherAveragesCard" class="muted">No NOAA average data yet.</div>
              </div>
            </div>
            <div class="dashboard-grid">
              <div class="card clickable-card" onclick="openDashboardDetail('weatherRadarCard','NOAA Radar Layers')">
                <h3 style="margin-top:0;">NOAA Radar Layers</h3>
                <div id="weatherRadarCard" class="muted">No radar layer assets yet.</div>
              </div>
              <div class="card clickable-card" onclick="openDashboardDetail('weatherSatelliteCard','NOAA Satellite Layers')">
                <h3 style="margin-top:0;">NOAA Satellite Layers</h3>
                <div id="weatherSatelliteCard" class="muted">No satellite layer assets yet.</div>
              </div>
              <div class="card clickable-card" onclick="openDashboardDetail('weatherIconCard','NOAA Icon Assets')">
                <h3 style="margin-top:0;">NOAA Icon Assets</h3>
                <div id="weatherIconCard" class="muted">No icon assets yet.</div>
              </div>
            </div>
            <div class="result-group">
              <h2>NOAA Alerts</h2>
              <div id="noaaResults"></div>
            </div>
            <div class="result-group">
              <h2>Environment Canada Alerts</h2>
              <div id="canadaResults"></div>
            </div>
          </div>

          <div id="earthquakes-page" class="page" style="display:none;">
            <h1>Earthquakes & Tsunamis</h1>
            <p class="muted">USGS earthquakes plus tsunami warning center bulletins.</p>
            <div id="earthquakesRunStatus" class="status warn">Setup is required before earthquake/tsunami data fetch.</div>
            <button id="earthquakesRefreshBtn" class="btn" onclick="refreshWeather()">Refresh Earthquakes & Tsunamis</button>
            <div class="result-group">
              <h2>USGS Earthquakes</h2>
              <div id="usgsResults"></div>
            </div>
            <div class="result-group">
              <h2>Tsunami Bulletins</h2>
              <div id="tsunamiResults"></div>
            </div>
          </div>

          <div id="space-weather-page" class="page" style="display:none;">
            <h1>Space Weather</h1>
            <p class="muted">NOAA Space Weather Prediction Center alerts and warnings.</p>
            <div id="spaceWeatherRunStatus" class="status warn">Setup is required before space weather data fetch.</div>
            <button id="spaceWeatherRefreshBtn" class="btn" onclick="refreshSpaceWeather()">Refresh Space Weather</button>
            <div class="result-group">
              <h2>SWPC Alerts</h2>
              <div id="spaceWeatherResults"></div>
            </div>
          </div>

          <div id="cyclones-page" class="page" style="display:none;">
            <h1>Cyclone Tracker</h1>
            <p class="muted">Live cyclone events from public event feeds.</p>
            <div id="cyclonesRunStatus" class="status warn">Setup is required before cyclone data fetch.</div>
            <button id="cyclonesRefreshBtn" class="btn" onclick="refreshCyclones()">Refresh Cyclones</button>
            <div class="result-group">
              <h2>Active Cyclone Events</h2>
              <div id="cycloneResults"></div>
            </div>
          </div>

          <div id="wildfires-page" class="page" style="display:none;">
            <h1>Wildfires</h1>
            <p class="muted">Global wildfire events from public event feeds.</p>
            <div id="wildfiresRunStatus" class="status warn">Setup is required before wildfire data fetch.</div>
            <button id="wildfiresRefreshBtn" class="btn" onclick="refreshWildfires()">Refresh Wildfires</button>
            <div class="result-group">
              <h2>Active Wildfire Events</h2>
              <div id="wildfireResults"></div>
            </div>
          </div>

          <div id="forecasts-page" class="page" style="display:none;">
            <h1>Forecasts</h1>
            <p class="muted">Future-only forecast periods for configured locations.</p>
            <div id="forecastsRunStatus" class="status warn">Setup is required before forecast data fetch.</div>
            <button id="forecastsRefreshBtn" class="btn" onclick="refreshForecasts()">Refresh Forecasts</button>
            <div class="result-group">
              <h2>NOAA Forecast Periods</h2>
              <div id="forecastResults"></div>
            </div>
          </div>

          <div id="settings-page" class="page" style="display:none;">
            <h1>Settings</h1>
            <div id="setupStatus" class="status warn">Checking configuration...</div>
            <div class="row">
              <label style="display:flex;align-items:center;gap:10px;cursor:pointer;">
                <input id="openAtLoginToggle" type="checkbox" style="width:20px;height:20px;" onchange="toggleOpenAtLogin()" />
                <span>Start Root Record Weather Manager when Windows signs in</span>
              </label>
            </div>
            <div class="row">
              <label for="unitSystem">Units</label>
              <select id="unitSystem" onchange="onUnitSystemChanged()" style="width:100%;padding:8px;border:1px solid #555;border-radius:4px;background:#1e1e1e;color:#d4d4d4;">
                <option value="imperial">Imperial (F, mph, mi)</option>
                <option value="metric">Metric (C, km/h, km)</option>
              </select>
            </div>
            <div class="row">
              <label for="radiusMiles">Pull Radius (miles)</label>
              <input id="radiusMiles" placeholder="e.g. 150" />
            </div>
            <h3>Critical Popup Alerts</h3>
            <div class="row">
              <label style="display:flex;align-items:center;gap:10px;cursor:pointer;">
                <input id="weatherCriticalToggle" type="checkbox" style="width:20px;height:20px;" />
                <span>Enable weather critical popups (NOAA + Environment Canada)</span>
              </label>
            </div>
            <div class="row">
              <label style="display:flex;align-items:center;gap:10px;cursor:pointer;">
                <input id="usgsCriticalToggle" type="checkbox" style="width:20px;height:20px;" />
                <span>Enable USGS earthquake critical popups</span>
              </label>
            </div>
            <div class="row">
              <label for="usgsMinMagnitude">USGS popup minimum magnitude</label>
              <input id="usgsMinMagnitude" placeholder="e.g. 3.0" />
            </div>
            <div class="row">
              <label for="usgsPopupDistance">USGS popup max distance (miles)</label>
              <input id="usgsPopupDistance" placeholder="e.g. 200" />
            </div>
            <div class="row">
              <label for="alertSoundSelect">Critical alert sound</label>
              <select id="alertSoundSelect" style="width:100%;padding:8px;border:1px solid #555;border-radius:4px;background:#1e1e1e;color:#d4d4d4;">
                <option value="">No custom sound</option>
              </select>
            </div>
            <button class="btn" onclick="previewSelectedAlertSound()">Test Selected Sound</button>
            <button class="btn" onclick="saveAlertSettings()">Save Alert Settings</button>
            <div class="row">
              <label for="locationName">Location Name</label>
              <input id="locationName" placeholder="Home, Shop, Cabin..." />
            </div>
            <div class="row">
              <label for="locationLat">Latitude</label>
              <input id="locationLat" placeholder="e.g. 47.6062" />
            </div>
            <div class="row">
              <label for="locationLon">Longitude</label>
              <input id="locationLon" placeholder="e.g. -122.3321" />
            </div>
            <button class="btn" onclick="openLocationMapPicker()">Pick on Map</button>
            <button class="btn" onclick="addLocation()">Add Location</button>

            <h3>Configured Locations</h3>
            <div id="locationList"></div>
            <button class="btn success" onclick="completeSetup()">Finalize Setup</button>
            <p class="muted">Data calls are blocked until setup is finalized with at least one location.</p>

            <div class="result-group">
              <h3>Archive Totals</h3>
              <pre id="archiveSummary">Loading...</pre>
            </div>
          </div>
          <div id="about-page" class="page" style="display:none;">
            <h1>About / Data Coverage</h1>
            <div class="card">
              <h3>Commercial-use data sources included</h3>
              <p><strong>NOAA / NWS:</strong> United States weather alerts (watches, warnings, advisories).</p>
              <p><strong>Environment Canada:</strong> Canada weather alerts via Open Government Licence - Canada.</p>
              <p><strong>USGS:</strong> Global earthquake data (includes Asia, Australia, Europe, Africa, and Americas).</p>
              <p><strong>NOAA Tsunami Warning Centers:</strong> Tsunami bulletins and advisories.</p>
              <p><strong>NOAA SWPC:</strong> Space weather alert products.</p>
              <p><strong>NASA EONET:</strong> Public global event feeds used for cyclone and wildfire tracking pages.</p>
              <p><strong>NOAA Gridpoints:</strong> Forecast periods shown in Forecasts page (future-only).</p>
            </div>
            <div class="card">
              <h3>Regional coverage summary</h3>
              <p><strong>United States:</strong> Weather alerts + earthquakes.</p>
              <p><strong>Canada:</strong> Weather alerts + earthquakes.</p>
              <p><strong>Asia / Australia / Europe / Africa / South America:</strong> Earthquake data now; weather alerts added only when clear free commercial licensing is confirmed.</p>
            </div>
            <div class="card">
              <h3>Why some weather providers are not included yet</h3>
              <p>Some regional weather APIs require paid commercial plans or separate written licensing agreements. This app only includes sources with clearly documented free commercial reuse rights.</p>
            </div>
            <div class="card">
              <h3>Polling cadence</h3>
              <p><strong>USGS (Earthquakes & Tsunamis page):</strong> scheduled every 5 minutes for near-real-time updates.</p>
              <p><strong>All other API sources:</strong> scheduled every 30 minutes.</p>
            </div>
          </div>
          <div id="contact-page" class="page" style="display:none;">
            <h1>Contact & Feedback</h1>
            <div class="card">
              <h3>Official Root Record links</h3>
              <p><strong>Website:</strong> <a href="#" onclick="openRootRecordWebsite()">https://rootrecord.com</a></p>
              <p><strong>Support Email:</strong> <a href="#" onclick="emailRootRecordSupport()">rootrecord@outlook.com</a></p>
            </div>
            <div class="card">
              <h3>Send feedback</h3>
              <p>Use email for bug reports, feature requests, and general feedback about Root Record Weather Manager.</p>
              <button class="btn" onclick="emailRootRecordSupport()">Email Support</button>
              <button class="btn" onclick="openRootRecordWebsite()">Open RootRecord.com</button>
            </div>
          </div>
        </main>
      </div>
      <div id="mapModal" class="map-modal">
        <div class="map-card">
          <h3 style="margin:0 0 8px 0;">Select Location on Map</h3>
          <p class="muted" style="margin:0 0 8px 0;">Click anywhere to place the marker, then apply coordinates.</p>
          <div id="locationMap"></div>
          <div style="margin-top:10px;display:flex;gap:8px;align-items:center;justify-content:space-between;flex-wrap:wrap;">
            <span id="mapCoordLabel" class="muted">No point selected.</span>
            <div>
              <button class="btn" onclick="applyPickedLocation()">Use Selected Point</button>
              <button class="btn danger" onclick="closeLocationMapPicker()">Cancel</button>
            </div>
          </div>
        </div>
      </div>
      <div id="dashboardDetailModal" class="detail-modal" onclick="closeDashboardDetail(event)">
        <div class="detail-card">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px;">
            <h3 id="dashboardDetailTitle" style="margin:0;">Dashboard Detail</h3>
            <button class="btn danger" onclick="closeDashboardDetail()">Close</button>
          </div>
          <div id="dashboardDetailBody" class="muted">No details loaded yet.</div>
        </div>
      </div>

      <script>
        let ipcRenderer;
        try {
          ({ ipcRenderer } = require('electron'));
        } catch (_error) {
          const bridge = (typeof window !== 'undefined' && window.rootRecordBridge) ? window.rootRecordBridge : null;
          if (bridge && typeof bridge.invoke === 'function') {
            ipcRenderer = { invoke: (channel, payload) => bridge.invoke(channel, payload) };
          } else {
            ipcRenderer = {
              invoke: async () => {
                throw new Error('IPC bridge unavailable. Please reinstall the latest build.');
              }
            };
            setTimeout(() => {
              const statusEl = document.getElementById('authStatus');
              if (statusEl) {
                statusEl.className = 'status error';
                statusEl.textContent = 'App runtime not fully initialized. Please reinstall/update this build.';
              }
            }, 0);
          }
        }
        let config = {
          isConfigured: false,
          radiusMiles: 150,
          unitSystem: 'imperial',
          criticalAlerts: {
            weatherEnabled: true,
            usgsEnabled: true,
            usgsMinMagnitude: 5.0,
            usgsMaxDistanceMiles: 200,
            soundPath: ''
          },
          locations: []
        };
        let mapPickerReady = false;
        let mapPicker;
        let mapMarker;
        let pickedLatLon = null;
        let availableAlertSounds = [];
        const detailItems = {
          noaa: [],
          canada: [],
          usgs: [],
          tsunamis: [],
          spaceWeather: [],
          cyclones: [],
          wildfires: [],
          forecasts: []
        };

        function escapeHtml(value) {
          return String(value || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
        }

        function toNumber(value) {
          const n = Number(value);
          return Number.isFinite(n) ? n : null;
        }

        function getUnitSystem() {
          return config && config.unitSystem === 'metric' ? 'metric' : 'imperial';
        }

        function getAlertPrefs() {
          const prefs = config && config.criticalAlerts && typeof config.criticalAlerts === 'object' ? config.criticalAlerts : {};
          const minMagnitude = Number(prefs.usgsMinMagnitude);
          const maxDistanceMiles = Number(prefs.usgsMaxDistanceMiles);
          return {
            weatherEnabled: prefs.weatherEnabled !== false,
            usgsEnabled: prefs.usgsEnabled !== false,
            usgsMinMagnitude: Number.isFinite(minMagnitude) ? Math.max(0, minMagnitude) : 5.0,
            usgsMaxDistanceMiles: Number.isFinite(maxDistanceMiles) && maxDistanceMiles > 0 ? maxDistanceMiles : 200,
            soundPath: String(prefs.soundPath || '').trim()
          };
        }

        function fileUrlFromPath(filePath) {
          return encodeURI('file:///' + String(filePath || '').replace(/\\/g, '/'));
        }

        async function loadAlertSounds() {
          const select = document.getElementById('alertSoundSelect');
          if (!select) return;
          availableAlertSounds = await ipcRenderer.invoke('get-alert-sounds');
          const options = ['<option value="">No custom sound</option>'];
          for (const sound of availableAlertSounds) {
            options.push('<option value="' + escapeHtml(sound.path) + '">' + escapeHtml(sound.name) + '</option>');
          }
          select.innerHTML = options.join('');
        }

        function storedMilesToUiRadius(miles) {
          const n = Number(miles);
          if (!Number.isFinite(n)) return 150;
          return getUnitSystem() === 'metric' ? n * 1.60934 : n;
        }

        function uiRadiusToStoredMiles(uiRadius) {
          const n = Number(uiRadius);
          if (!Number.isFinite(n)) return 150;
          return getUnitSystem() === 'metric' ? (n / 1.60934) : n;
        }

        function applyRadiusLabelAndValue() {
          const label = document.querySelector('label[for="radiusMiles"]');
          if (label) {
            label.textContent = getUnitSystem() === 'metric' ? 'Pull Radius (km)' : 'Pull Radius (miles)';
          }
          const field = document.getElementById('radiusMiles');
          if (field) field.value = String(storedMilesToUiRadius(config.radiusMiles).toFixed(1).replace(/\.0$/, ''));
          const distLabel = document.querySelector('label[for="usgsPopupDistance"]');
          if (distLabel) distLabel.textContent = getUnitSystem() === 'metric' ? 'USGS popup max distance (km)' : 'USGS popup max distance (miles)';
          const distInput = document.getElementById('usgsPopupDistance');
          if (distInput) distInput.value = String(storedMilesToUiRadius(getAlertPrefs().usgsMaxDistanceMiles).toFixed(1).replace(/\.0$/, ''));
        }

        function applyAlertSettingsFields() {
          const prefs = getAlertPrefs();
          const weatherToggle = document.getElementById('weatherCriticalToggle');
          const usgsToggle = document.getElementById('usgsCriticalToggle');
          const minMagnitude = document.getElementById('usgsMinMagnitude');
          const soundSelect = document.getElementById('alertSoundSelect');
          if (weatherToggle) weatherToggle.checked = Boolean(prefs.weatherEnabled);
          if (usgsToggle) usgsToggle.checked = Boolean(prefs.usgsEnabled);
          if (minMagnitude) minMagnitude.value = String(prefs.usgsMinMagnitude);
          if (soundSelect) soundSelect.value = prefs.soundPath || '';
        }

        function playAlertSound(soundPath) {
          const chosenPath = String(soundPath || '').trim();
          if (!chosenPath) return;
          try {
            const audio = new Audio(fileUrlFromPath(chosenPath));
            audio.volume = 1.0;
            void audio.play();
          } catch {
            // Ignore sound playback errors.
          }
        }

        function previewSelectedAlertSound() {
          const select = document.getElementById('alertSoundSelect');
          if (!select) return;
          playAlertSound(select.value);
        }

        async function saveAlertSettings() {
          const weatherToggle = document.getElementById('weatherCriticalToggle');
          const usgsToggle = document.getElementById('usgsCriticalToggle');
          const minMagnitudeRaw = toNumber((document.getElementById('usgsMinMagnitude') || {}).value || '');
          const distanceUiRaw = toNumber((document.getElementById('usgsPopupDistance') || {}).value || '');
          const soundSelect = document.getElementById('alertSoundSelect');
          const prefs = getAlertPrefs();
          const next = {
            weatherEnabled: weatherToggle ? Boolean(weatherToggle.checked) : prefs.weatherEnabled,
            usgsEnabled: usgsToggle ? Boolean(usgsToggle.checked) : prefs.usgsEnabled,
            usgsMinMagnitude: minMagnitudeRaw === null || minMagnitudeRaw < 0 ? 5.0 : minMagnitudeRaw,
            usgsMaxDistanceMiles: distanceUiRaw === null || distanceUiRaw <= 0 ? 200 : uiRadiusToStoredMiles(distanceUiRaw),
            soundPath: soundSelect ? String(soundSelect.value || '').trim() : prefs.soundPath
          };
          config.criticalAlerts = next;
          config = await ipcRenderer.invoke('save-location-config', config);
          applyAlertSettingsFields();
          applyRadiusLabelAndValue();
        }

        function formatDistanceFromMiles(miles) {
          const n = Number(miles);
          if (!Number.isFinite(n)) return 'n/a';
          if (getUnitSystem() === 'metric') return (n * 1.60934).toFixed(1) + ' km';
          return n.toFixed(1) + ' mi';
        }

        function formatTemperatureF(value) {
          const n = Number(value);
          if (!Number.isFinite(n)) return 'n/a';
          if (getUnitSystem() === 'metric') return (((n - 32) * 5) / 9).toFixed(1) + ' C';
          return n.toFixed(1) + ' F';
        }

        function formatWindMph(value) {
          const raw = String(value || '').trim();
          const first = Number(raw.split(' ')[0]);
          if (Number.isFinite(first)) {
            if (getUnitSystem() === 'metric') return (first * 1.60934).toFixed(1) + ' km/h';
            return first.toFixed(1) + ' mph';
          }
          return raw || 'n/a';
        }

        function normalizeForecastTemp(temp, unit) {
          const n = Number(temp);
          const u = String(unit || '').toUpperCase();
          if (!Number.isFinite(n)) return 'n/a';
          if (getUnitSystem() === 'imperial') {
            if (u === 'C') return ((n * 9) / 5 + 32).toFixed(1) + ' F';
            return n.toFixed(1) + ' F';
          }
          if (u === 'F') return (((n - 32) * 5) / 9).toFixed(1) + ' C';
          return n.toFixed(1) + ' C';
        }

        function ensureLeafletLoaded() {
          return new Promise((resolve, reject) => {
            if (window.L) return resolve();
            const css = document.createElement('link');
            css.rel = 'stylesheet';
            css.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
            document.head.appendChild(css);
            const js = document.createElement('script');
            js.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
            js.onload = () => resolve();
            js.onerror = () => reject(new Error('Failed to load map library.'));
            document.head.appendChild(js);
          });
        }

        function setMapCoordLabel(text) {
          const el = document.getElementById('mapCoordLabel');
          if (el) el.textContent = text;
        }

        function setPickedLocation(lat, lon) {
          pickedLatLon = { lat, lon };
          setMapCoordLabel('Selected: ' + lat.toFixed(6) + ', ' + lon.toFixed(6));
          if (mapMarker) {
            mapMarker.setLatLng([lat, lon]);
          } else {
            mapMarker = window.L.marker([lat, lon]).addTo(mapPicker);
          }
        }

        async function openLocationMapPicker() {
          try {
            await ensureLeafletLoaded();
            const modal = document.getElementById('mapModal');
            if (modal) modal.style.display = 'flex';
            const latInput = toNumber((document.getElementById('locationLat') || {}).value || '');
            const lonInput = toNumber((document.getElementById('locationLon') || {}).value || '');
            const startLat = latInput !== null ? latInput : 39.8283;
            const startLon = lonInput !== null ? lonInput : -98.5795;
            if (!mapPickerReady) {
              mapPicker = window.L.map('locationMap').setView([startLat, startLon], latInput !== null && lonInput !== null ? 9 : 4);
              // OSM tile servers can block packaged desktop requests without referrer headers.
              // Use Esri basemap tiles for a stable, no-auth map picker experience.
              window.L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', {
                maxZoom: 18,
                attribution: 'Tiles &copy; Esri'
              }).addTo(mapPicker);
              mapPicker.on('click', (evt) => {
                setPickedLocation(evt.latlng.lat, evt.latlng.lng);
              });
              mapPickerReady = true;
            } else {
              mapPicker.setView([startLat, startLon], latInput !== null && lonInput !== null ? 9 : 4);
            }
            if (latInput !== null && lonInput !== null) {
              setPickedLocation(latInput, lonInput);
            } else {
              pickedLatLon = null;
              if (mapMarker) {
                mapPicker.removeLayer(mapMarker);
                mapMarker = null;
              }
              setMapCoordLabel('No point selected.');
            }
            setTimeout(() => {
              if (mapPicker) mapPicker.invalidateSize();
            }, 20);
          } catch (error) {
            alert('Map picker unavailable: ' + error.message);
          }
        }

        function closeLocationMapPicker() {
          const modal = document.getElementById('mapModal');
          if (modal) modal.style.display = 'none';
        }

        function applyPickedLocation() {
          if (!pickedLatLon) {
            alert('Select a point on the map first.');
            return;
          }
          const latInput = document.getElementById('locationLat');
          const lonInput = document.getElementById('locationLon');
          if (latInput) latInput.value = pickedLatLon.lat.toFixed(6);
          if (lonInput) lonInput.value = pickedLatLon.lon.toFixed(6);
          closeLocationMapPicker();
        }

        function openDashboardDetail(sourceId, title) {
          const modal = document.getElementById('dashboardDetailModal');
          const titleEl = document.getElementById('dashboardDetailTitle');
          const bodyEl = document.getElementById('dashboardDetailBody');
          const source = document.getElementById(sourceId);
          if (!modal || !titleEl || !bodyEl || !source) return;
          titleEl.textContent = String(title || 'Dashboard Detail');
          bodyEl.innerHTML = source.innerHTML || '<span class="muted">No detail available yet.</span>';
          modal.style.display = 'flex';
        }

        function closeDashboardDetail(event) {
          if (event && event.target && event.target.id !== 'dashboardDetailModal') return;
          const modal = document.getElementById('dashboardDetailModal');
          if (modal) modal.style.display = 'none';
        }

        function openExternalUrl(url) {
          const cleanUrl = String(url || '').trim();
          if (!cleanUrl || !/^https?:\/\//i.test(cleanUrl)) return;
          void ipcRenderer.invoke('open-external-url', cleanUrl);
        }

        function detailLine(label, value) {
          const text = String(value == null ? '' : value).trim();
          if (!text) return '';
          return '<div style="margin-bottom:6px;"><span class="muted">' + escapeHtml(label) + ':</span> ' + escapeHtml(text) + '</div>';
        }

        function eventDetailHtml(type, item) {
          if (!item || typeof item !== 'object') return '<span class="muted">No detail available.</span>';
          const sourceUrl = String(item.detailUrl || item.url || item.source || '').trim();
          const lines = [];
          if (type === 'usgs') {
            lines.push(detailLine('Magnitude', item.magnitude));
            lines.push(detailLine('Time', item.time));
            lines.push(detailLine('Distance', formatDistanceFromMiles(item.distanceMiles)));
            lines.push(detailLine('Matched Location', item.locationName));
            lines.push(detailLine('Depth (km)', item.depthKm));
            lines.push(detailLine('USGS Alert', item.alertLevel));
            lines.push(detailLine('Status', item.status));
          } else if (type === 'tsunamis') {
            lines.push(detailLine('Updated', item.updated || item.published));
            lines.push(detailLine('Summary', item.summary));
          } else if (type === 'forecasts') {
            lines.push(detailLine('Location', item.locationName));
            lines.push(detailLine('Window', (item.startTime || '') + ' to ' + (item.endTime || '')));
            lines.push(detailLine('Temperature', normalizeForecastTemp(item.temperature, item.temperatureUnit)));
            lines.push(detailLine('Forecast', item.detailedForecast || item.shortForecast));
          } else {
            lines.push(detailLine('Title', item.title || item.event || item.name || item.message));
            lines.push(detailLine('Severity', item.severity));
            lines.push(detailLine('Location', item.locationName || item.areaDesc));
            lines.push(detailLine('Time', item.time || item.updated || item.published || item.geometryDate));
            lines.push(detailLine('Summary', item.headline || item.description || item.summary || item.shortForecast));
          }
          if (sourceUrl && /^https?:\/\//i.test(sourceUrl)) {
            lines.push(
              '<button class="btn" onclick="openExternalUrl(\'' + escapeHtml(sourceUrl).replace(/'/g, '&#039;') + '\')">Open Official Source</button>'
            );
          }
          return lines.filter(Boolean).join('');
        }

        function openEventDetail(type, index) {
          const group = detailItems[type];
          const item = Array.isArray(group) ? group[index] : null;
          if (!item) return;
          const title = item.event || item.title || item.name || item.message || (type.toUpperCase() + ' Event');
          const modal = document.getElementById('dashboardDetailModal');
          const titleEl = document.getElementById('dashboardDetailTitle');
          const bodyEl = document.getElementById('dashboardDetailBody');
          if (!modal || !titleEl || !bodyEl) return;
          titleEl.textContent = String(title);
          bodyEl.innerHTML = eventDetailHtml(type, item);
          modal.style.display = 'flex';
        }

        function milesBetween(lat1, lon1, lat2, lon2) {
          const toRad = (n) => n * Math.PI / 180;
          const earthRadiusMiles = 3958.8;
          const dLat = toRad(lat2 - lat1);
          const dLon = toRad(lon2 - lon1);
          const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
          const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
          return earthRadiusMiles * c;
        }

        function getBoundingBox(locations, milesRadius = 150) {
          const padDegrees = Math.max(0.3, milesRadius / 69);
          const lats = locations.map((loc) => loc.latitude);
          const lons = locations.map((loc) => loc.longitude);
          return {
            minLat: Math.max(-90, Math.min(...lats) - padDegrees),
            maxLat: Math.min(90, Math.max(...lats) + padDegrees),
            minLon: Math.max(-180, Math.min(...lons) - padDegrees),
            maxLon: Math.min(180, Math.max(...lons) + padDegrees)
          };
        }

        function showPage(pageName) {
          const pages = ['weather', 'earthquakes', 'space-weather', 'cyclones', 'wildfires', 'forecasts', 'settings', 'about', 'contact'];
          for (const p of pages) {
            const el = document.getElementById(p + '-page');
            if (el) el.style.display = p === pageName ? 'block' : 'none';
          }
        }

        function onUnitSystemChanged() {
          const sel = document.getElementById('unitSystem');
          if (!sel) return;
          config.unitSystem = sel.value === 'metric' ? 'metric' : 'imperial';
          applyRadiusLabelAndValue();
          applyAlertSettingsFields();
        }

        async function openRootRecordWebsite() {
          await ipcRenderer.invoke('open-rootrecord-website');
        }

        async function emailRootRecordSupport() {
          await ipcRenderer.invoke('email-rootrecord-support');
        }

        function setAuthStatus(kind, text) {
          const el = document.getElementById('authStatus');
          if (!el) return;
          el.className = 'status ' + kind;
          el.textContent = text;
        }

        if (typeof window !== 'undefined') {
          window.addEventListener('error', (event) => {
            const message = event && event.error && event.error.message
              ? event.error.message
              : (event && event.message ? event.message : 'Unknown renderer error');
            setAuthStatus('error', 'UI runtime error: ' + message);
          });
          window.addEventListener('unhandledrejection', (event) => {
            const reason = event && event.reason;
            const message = reason && reason.message ? reason.message : String(reason || 'Unknown async error');
            setAuthStatus('error', 'UI async error: ' + message);
          });
        }

        function showMainApp() {
          const gate = document.getElementById('authGate');
          const appShell = document.getElementById('appShell');
          if (gate) gate.style.display = 'none';
          if (appShell) appShell.style.display = 'flex';
        }

        function setTrialNotice(text) {
          const el = document.getElementById('trialNotice');
          if (!el) return;
          el.textContent = text || 'New accounts include a 14-day free trial.';
        }

        async function initializeAuthGate() {
          try {
            const state = await Promise.race([
              ipcRenderer.invoke('core-auth-state'),
              new Promise((_, reject) => setTimeout(() => reject(new Error('Session check timed out. Please sign in manually.')), 15000))
            ]);
            if (state.authenticated) {
              if (state.message) setTrialNotice(state.message);
              showMainApp();
              return;
            }
            const emailInput = document.getElementById('authEmail');
            if (emailInput && state.email) emailInput.value = state.email;
            setAuthStatus('warn', state.message || 'Sign in required.');
            if (state.entitlement && state.entitlement.reason === 'past_due') {
              setTrialNotice('Subscription past due. Subscribe to restore access.');
            } else if (state.entitlement && state.entitlement.reason === 'trialing' && state.entitlement.trialRemaining) {
              setTrialNotice('Trial active: ' + state.entitlement.trialRemaining);
            } else {
              setTrialNotice('New accounts include a 14-day free trial.');
            }
          } catch (error) {
            setAuthStatus('error', 'Auth check failed: ' + error.message);
          }
        }

        async function authSignIn() {
          const email = (document.getElementById('authEmail') || {}).value || '';
          const password = (document.getElementById('authPassword') || {}).value || '';
          setAuthStatus('warn', 'Signing in...');
          try {
            const result = await ipcRenderer.invoke('core-auth-login', { email, password });
            if (result && result.entitlement && result.entitlement.allow) {
              if (result.entitlement.reason === 'trialing' && result.entitlement.trialRemaining) {
                setTrialNotice('Trial active: ' + result.entitlement.trialRemaining);
              }
              setAuthStatus('ok', 'Sign-in successful.');
              showMainApp();
            } else {
              setAuthStatus('warn', 'Signed in, but subscription/trial is required.');
              setTrialNotice('Your 14-day trial may have ended. Subscribe to continue.');
            }
          } catch (error) {
            setAuthStatus('error', 'Sign-in failed: ' + error.message);
          }
        }

        async function authSignUp() {
          const email = (document.getElementById('authEmail') || {}).value || '';
          const password = (document.getElementById('authPassword') || {}).value || '';
          setAuthStatus('warn', 'Creating account...');
          try {
            const result = await ipcRenderer.invoke('core-auth-signup', { email, password });
            if (result && result.entitlement && result.entitlement.allow) {
              setAuthStatus('ok', 'Account created. 14-day trial started.');
              if (result.entitlement.trialRemaining) {
                setTrialNotice('Trial active: ' + result.entitlement.trialRemaining);
              } else {
                setTrialNotice('14-day free trial is active.');
              }
              showMainApp();
            } else {
              setAuthStatus('warn', 'Account created, but access not yet granted.');
            }
          } catch (error) {
            setAuthStatus('error', 'Sign-up failed: ' + error.message);
          }
        }

        async function startCheckout() {
          setAuthStatus('warn', 'Opening subscription checkout...');
          try {
            await ipcRenderer.invoke('core-auth-checkout');
            setAuthStatus('ok', 'Checkout opened in your browser. Return after purchase and sign in again.');
          } catch (error) {
            setAuthStatus('error', 'Checkout failed: ' + error.message);
          }
        }

        async function renderArchiveSummary() {
          const summary = document.getElementById('archiveSummary');
          if (!summary) return;
          const archive = await ipcRenderer.invoke('archive-summary');
          summary.textContent =
            'NOAA saved records: ' + archive.noaa +
            '\\nEnvironment Canada saved records: ' + archive.canada +
            '\\nUSGS saved records: ' + archive.usgs +
            '\\nTsunami saved records: ' + archive.tsunamis +
            '\\nNOAA dashboard snapshots: ' + archive.noaaDashboard +
            '\\nSpace weather saved records: ' + archive.spaceWeather +
            '\\nCyclone saved records: ' + archive.cyclones +
            '\\nWildfire saved records: ' + archive.wildfires +
            '\\nForecast saved records: ' + archive.forecasts;
        }

        async function restoreFromArchive() {
          try {
            const snapshot = await ipcRenderer.invoke('archive-latest', { count: 250 });
            const noaaItems = Array.isArray(snapshot.noaa) ? snapshot.noaa : [];
            const canadaItems = Array.isArray(snapshot.canada) ? snapshot.canada : [];
            const usgsItems = Array.isArray(snapshot.usgs) ? snapshot.usgs : [];
            const tsunamiItems = Array.isArray(snapshot.tsunamis) ? snapshot.tsunamis : [];
            const dashboard = snapshot.noaaDashboard && typeof snapshot.noaaDashboard === 'object' ? snapshot.noaaDashboard : null;
            const spaceWeatherItems = Array.isArray(snapshot.spaceWeather) ? snapshot.spaceWeather : [];
            const cycloneItems = Array.isArray(snapshot.cyclones) ? snapshot.cyclones : [];
            const wildfireItems = Array.isArray(snapshot.wildfires) ? snapshot.wildfires : [];
            const forecastItems = Array.isArray(snapshot.forecasts) ? snapshot.forecasts : [];

            if (dashboard) renderNoaaDashboard(dashboard);
            renderNoaa(noaaItems);
            renderCanadaAlerts(canadaItems);
            renderUsgs(usgsItems);
            renderTsunamis(tsunamiItems);
            renderSpaceWeather(spaceWeatherItems);
            renderCyclones(cycloneItems);
            renderWildfires(wildfireItems);
            renderForecasts(forecastItems);

            const hasAny = noaaItems.length || canadaItems.length || usgsItems.length || tsunamiItems.length ||
              spaceWeatherItems.length || cycloneItems.length || wildfireItems.length || forecastItems.length || dashboard;
            if (hasAny) {
              const weatherStatus = document.getElementById('weatherRunStatus');
              if (weatherStatus) {
                weatherStatus.className = 'status ok';
                weatherStatus.textContent = 'Loaded latest locally saved data snapshot.';
              }
            }
          } catch {
            // Ignore archive restore failures to keep startup resilient.
          }
        }

        function renderSetupState() {
          const setupStatus = document.getElementById('setupStatus');
          const weatherRunStatus = document.getElementById('weatherRunStatus');
          const earthquakesRunStatus = document.getElementById('earthquakesRunStatus');
          const spaceWeatherRunStatus = document.getElementById('spaceWeatherRunStatus');
          const cyclonesRunStatus = document.getElementById('cyclonesRunStatus');
          const wildfiresRunStatus = document.getElementById('wildfiresRunStatus');
          const forecastsRunStatus = document.getElementById('forecastsRunStatus');
          const weatherRefreshBtn = document.getElementById('weatherRefreshBtn');
          const earthquakesRefreshBtn = document.getElementById('earthquakesRefreshBtn');
          const spaceWeatherRefreshBtn = document.getElementById('spaceWeatherRefreshBtn');
          const cyclonesRefreshBtn = document.getElementById('cyclonesRefreshBtn');
          const wildfiresRefreshBtn = document.getElementById('wildfiresRefreshBtn');
          const forecastsRefreshBtn = document.getElementById('forecastsRefreshBtn');
          if (config.isConfigured) {
            setupStatus.className = 'status ok';
            setupStatus.textContent = 'Configuration complete. Location-scoped data fetch is enabled.';
            weatherRunStatus.className = 'status ok';
            weatherRunStatus.textContent = 'Ready to fetch NOAA weather alerts.';
            earthquakesRunStatus.className = 'status ok';
            earthquakesRunStatus.textContent = 'Ready to fetch earthquake and tsunami data.';
            spaceWeatherRunStatus.className = 'status ok';
            spaceWeatherRunStatus.textContent = 'Ready to fetch space weather data.';
            cyclonesRunStatus.className = 'status ok';
            cyclonesRunStatus.textContent = 'Ready to fetch cyclone data.';
            wildfiresRunStatus.className = 'status ok';
            wildfiresRunStatus.textContent = 'Ready to fetch wildfire data.';
            forecastsRunStatus.className = 'status ok';
            forecastsRunStatus.textContent = 'Ready to fetch forecast data.';
            weatherRefreshBtn.disabled = false;
            earthquakesRefreshBtn.disabled = false;
            spaceWeatherRefreshBtn.disabled = false;
            cyclonesRefreshBtn.disabled = false;
            wildfiresRefreshBtn.disabled = false;
            forecastsRefreshBtn.disabled = false;
          } else {
            setupStatus.className = 'status warn';
            setupStatus.textContent = 'Setup incomplete. Add at least one location and finalize setup.';
            weatherRunStatus.className = 'status warn';
            weatherRunStatus.textContent = 'Weather data ingestion locked until setup is finalized.';
            earthquakesRunStatus.className = 'status warn';
            earthquakesRunStatus.textContent = 'Earthquake data ingestion locked until setup is finalized.';
            spaceWeatherRunStatus.className = 'status warn';
            spaceWeatherRunStatus.textContent = 'Space weather ingestion locked until setup is finalized.';
            cyclonesRunStatus.className = 'status warn';
            cyclonesRunStatus.textContent = 'Cyclone ingestion locked until setup is finalized.';
            wildfiresRunStatus.className = 'status warn';
            wildfiresRunStatus.textContent = 'Wildfire ingestion locked until setup is finalized.';
            forecastsRunStatus.className = 'status warn';
            forecastsRunStatus.textContent = 'Forecast ingestion locked until setup is finalized.';
            weatherRefreshBtn.disabled = true;
            earthquakesRefreshBtn.disabled = true;
            spaceWeatherRefreshBtn.disabled = true;
            cyclonesRefreshBtn.disabled = true;
            wildfiresRefreshBtn.disabled = true;
            forecastsRefreshBtn.disabled = true;
          }
        }

        function renderLocations() {
          const list = document.getElementById('locationList');
          if (!config.locations.length) {
            list.innerHTML = '<p class="muted">No locations configured yet.</p>';
            return;
          }
          list.innerHTML = config.locations.map((loc, idx) => {
            return \`
              <div class="location-row">
                <div>
                  <strong>\${escapeHtml(loc.name)}</strong><br/>
                  <span class="muted">\${loc.latitude.toFixed(4)}, \${loc.longitude.toFixed(4)}</span>
                </div>
                <button class="btn danger" onclick="removeLocation(\${idx})">Remove</button>
              </div>
            \`;
          }).join('');
        }

        async function loadConfig() {
          config = await ipcRenderer.invoke('get-location-config');
          const openAtLogin = await ipcRenderer.invoke('get-open-at-login');
          const openAtLoginToggle = document.getElementById('openAtLoginToggle');
          if (openAtLoginToggle) openAtLoginToggle.checked = Boolean(openAtLogin);
          const unitSel = document.getElementById('unitSystem');
          if (unitSel) unitSel.value = config.unitSystem === 'metric' ? 'metric' : 'imperial';
          await loadAlertSounds();
          applyRadiusLabelAndValue();
          applyAlertSettingsFields();
          renderLocations();
          renderSetupState();
          await restoreFromArchive();
          await renderArchiveSummary();
        }

        async function toggleOpenAtLogin() {
          const openAtLoginToggle = document.getElementById('openAtLoginToggle');
          if (!openAtLoginToggle) return;
          await ipcRenderer.invoke('set-open-at-login', Boolean(openAtLoginToggle.checked));
        }

        async function addLocation() {
          const name = document.getElementById('locationName').value.trim();
          const latitude = toNumber(document.getElementById('locationLat').value.trim());
          const longitude = toNumber(document.getElementById('locationLon').value.trim());
          const radiusUiRaw = toNumber(document.getElementById('radiusMiles').value.trim());
          const radiusUi = radiusUiRaw === null || radiusUiRaw <= 0 ? storedMilesToUiRadius(150) : radiusUiRaw;
          const radiusMiles = uiRadiusToStoredMiles(radiusUi);
          if (!name) {
            alert('Location name is required.');
            return;
          }
          if (latitude === null || longitude === null) {
            alert('Latitude and longitude must be valid numbers.');
            return;
          }
          if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
            alert('Latitude must be -90 to 90 and longitude must be -180 to 180.');
            return;
          }
          config.locations.push({ name, latitude, longitude });
          config.isConfigured = false;
          config.radiusMiles = radiusMiles;
          config.unitSystem = getUnitSystem();
          config = await ipcRenderer.invoke('save-location-config', config);
          document.getElementById('locationName').value = '';
          document.getElementById('locationLat').value = '';
          document.getElementById('locationLon').value = '';
          applyRadiusLabelAndValue();
          renderLocations();
          renderSetupState();
        }

        async function removeLocation(index) {
          config.locations.splice(index, 1);
          config.isConfigured = false;
          const radiusUi = toNumber(document.getElementById('radiusMiles').value.trim());
          if (radiusUi && radiusUi > 0) config.radiusMiles = uiRadiusToStoredMiles(radiusUi);
          config.unitSystem = getUnitSystem();
          config = await ipcRenderer.invoke('save-location-config', config);
          applyRadiusLabelAndValue();
          renderLocations();
          renderSetupState();
        }

        async function completeSetup() {
          const radiusUiRaw = toNumber(document.getElementById('radiusMiles').value.trim());
          const radiusUi = radiusUiRaw === null || radiusUiRaw <= 0 ? storedMilesToUiRadius(150) : radiusUiRaw;
          const radiusMiles = uiRadiusToStoredMiles(radiusUi);
          if (!config.locations.length) {
            alert('At least one location is required before finalizing setup.');
            return;
          }
          config.radiusMiles = radiusMiles;
          config.unitSystem = getUnitSystem();
          config.isConfigured = true;
          config = await ipcRenderer.invoke('save-location-config', config);
          applyRadiusLabelAndValue();
          renderSetupState();
        }

        function renderNoaa(items) {
          const el = document.getElementById('noaaResults');
          detailItems.noaa = Array.isArray(items) ? items : [];
          if (!items.length) {
            el.innerHTML = '<p class="muted">No active alerts near your configured locations.</p>';
            return;
          }
          el.innerHTML = items.map((item, index) => {
            return \`
              <div class="card clickable-card" onclick="openEventDetail('noaa', \${index})">
                <strong>\${escapeHtml(item.event || 'Alert')}</strong><br/>
                <span class="muted">\${escapeHtml(item.severity || 'Unknown severity')} | \${escapeHtml(item.areaDesc || 'No area provided')}</span><br/>
                <span class="muted">Matched location: \${escapeHtml(item.locationName)}</span><br/>
                <span>\${escapeHtml(item.headline || 'No headline')}</span>
              </div>
            \`;
          }).join('');
        }

        function renderNoaaDashboard(data) {
          const currentEl = document.getElementById('weatherCurrentCard');
          const dailyEl = document.getElementById('weatherDailyCard');
          const avgEl = document.getElementById('weatherAveragesCard');
          const radarEl = document.getElementById('weatherRadarCard');
          const satelliteEl = document.getElementById('weatherSatelliteCard');
          const iconEl = document.getElementById('weatherIconCard');
          if (!currentEl || !dailyEl || !avgEl || !radarEl || !satelliteEl || !iconEl) return;

          const currentRows = Array.isArray(data && data.current) ? data.current : [];
          if (!currentRows.length) {
            currentEl.innerHTML = '<span class="muted">No current conditions available.</span>';
          } else {
            currentEl.innerHTML = currentRows.map((row) => {
              const iconHtml = row.icon
                ? '<img src="' + escapeHtml(row.icon) + '" style="width:34px;height:34px;vertical-align:middle;border-radius:4px;margin-right:6px;" />'
                : '';
              return \`
                <div style="margin-bottom:8px;">
                  \${iconHtml}<strong>\${escapeHtml(row.locationName)}</strong><br/>
                  <span class="muted">\${escapeHtml(row.text || 'Current')}</span><br/>
                  <span>Temp: \${escapeHtml(formatTemperatureF(row.temperatureF))}, Wind: \${escapeHtml(formatWindMph(row.windMph))}</span>
                </div>
              \`;
            }).join('');
          }

          const dailyRows = Array.isArray(data && data.daily) ? data.daily : [];
          if (!dailyRows.length) {
            dailyEl.innerHTML = '<span class="muted">No daily forecast periods available.</span>';
          } else {
            dailyEl.innerHTML = dailyRows.map((row) => {
              return \`
                <div style="margin-bottom:8px;">
                  <strong>\${escapeHtml(row.locationName)} - \${escapeHtml(row.name)}</strong><br/>
                  <span>\${escapeHtml(row.shortForecast || '')}</span><br/>
                  <span class="muted">\${escapeHtml(normalizeForecastTemp(row.temperature, row.temperatureUnit))}</span>
                </div>
              \`;
            }).join('');
          }

          const avgRows = Array.isArray(data && data.averages) ? data.averages : [];
          if (!avgRows.length) {
            avgEl.innerHTML = '<span class="muted">No hourly data available for averages.</span>';
          } else {
            avgEl.innerHTML = avgRows.map((row) => {
              return \`
                <div style="margin-bottom:8px;">
                  <strong>\${escapeHtml(row.locationName)}</strong><br/>
                  <span>Avg Temp (24h): \${escapeHtml(formatTemperatureF(row.avgTempF))}</span><br/>
                  <span>Avg Wind (24h): \${escapeHtml(formatWindMph(row.avgWindMph))}</span>
                </div>
              \`;
            }).join('');
          }

          const radarRows = Array.isArray(data && data.radar) ? data.radar : [];
          if (!radarRows.length) {
            radarEl.innerHTML = '<span class="muted">No radar station assets available for configured locations.</span>';
          } else {
            radarEl.innerHTML = radarRows.map((row) => {
              return \`
                <div style="margin-bottom:10px;">
                  <strong>\${escapeHtml(row.locationName)}</strong><br/>
                  <span class="muted">Station: \${escapeHtml(row.station)}</span><br/>
                  <img src="\${escapeHtml(row.url)}" alt="Radar loop" style="width:100%;max-height:170px;object-fit:contain;border:1px solid #333;border-radius:4px;background:#111;" />
                </div>
              \`;
            }).join('');
          }

          const satelliteRows = Array.isArray(data && data.satellite) ? data.satellite : [];
          if (!satelliteRows.length) {
            satelliteEl.innerHTML = '<span class="muted">No satellite assets available.</span>';
          } else {
            satelliteEl.innerHTML = satelliteRows.map((row) => {
              return \`
                <div style="margin-bottom:10px;">
                  <strong>\${escapeHtml(row.label)}</strong><br/>
                  <img src="\${escapeHtml(row.url)}" alt="Satellite image" style="width:100%;max-height:170px;object-fit:contain;border:1px solid #333;border-radius:4px;background:#111;" />
                </div>
              \`;
            }).join('');
          }

          const iconRows = Array.isArray(data && data.iconAssets) ? data.iconAssets : [];
          if (!iconRows.length) {
            iconEl.innerHTML = '<span class="muted">No icon assets found in forecast data.</span>';
          } else {
            iconEl.innerHTML = iconRows.map((row) => {
              return \`
                <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
                  <img src="\${escapeHtml(row.icon)}" alt="Forecast icon" style="width:34px;height:34px;border-radius:4px;border:1px solid #333;background:#111;" />
                  <span>\${escapeHtml(row.locationName)} - \${escapeHtml(row.name)}</span>
                </div>
              \`;
            }).join('');
          }
        }

        function renderCanadaAlerts(items) {
          const el = document.getElementById('canadaResults');
          if (!el) return;
          detailItems.canada = Array.isArray(items) ? items : [];
          if (!items.length) {
            el.innerHTML = '<p class="muted">No active Environment Canada alerts near your configured locations.</p>';
            return;
          }
          el.innerHTML = items.map((item, index) => {
            return \`
              <div class="card clickable-card" onclick="openEventDetail('canada', \${index})">
                <strong>\${escapeHtml(item.event || item.title || 'Alert')}</strong><br/>
                <span class="muted">\${escapeHtml(item.severity || 'Unknown severity')} | \${escapeHtml(item.areaDesc || 'No area provided')}</span><br/>
                <span class="muted">Matched location: \${escapeHtml(item.locationName)}</span><br/>
                <span>\${escapeHtml(item.headline || item.description || 'No headline')}</span>
              </div>
            \`;
          }).join('');
        }

        function renderUsgs(items) {
          const el = document.getElementById('usgsResults');
          detailItems.usgs = Array.isArray(items) ? items : [];
          if (!items.length) {
            el.innerHTML = '<p class="muted">No recent earthquakes within your configured radius.</p>';
            return;
          }
          el.innerHTML = items.map((item, index) => {
            return \`
              <div class="card clickable-card" onclick="openEventDetail('usgs', \${index})">
                <strong>M\${escapeHtml(item.magnitude)} - \${escapeHtml(item.place)}</strong><br/>
                <span class="muted">\${escapeHtml(item.time)} | \${escapeHtml(formatDistanceFromMiles(item.distanceMiles))} from \${escapeHtml(item.locationName)}</span>
              </div>
            \`;
          }).join('');
        }

        function renderTsunamis(items) {
          const el = document.getElementById('tsunamiResults');
          if (!el) return;
          detailItems.tsunamis = Array.isArray(items) ? items : [];
          if (!items.length) {
            el.innerHTML = '<p class="muted">No active tsunami bulletins found.</p>';
            return;
          }
          el.innerHTML = items.map((item, index) => {
            return \`
              <div class="card clickable-card" onclick="openEventDetail('tsunamis', \${index})">
                <strong>\${escapeHtml(item.title || 'Tsunami Bulletin')}</strong><br/>
                <span class="muted">\${escapeHtml(item.updated || item.published || '')}</span><br/>
                <span>\${escapeHtml(item.summary || 'No bulletin summary')}</span>
              </div>
            \`;
          }).join('');
        }

        function renderSpaceWeather(items) {
          const el = document.getElementById('spaceWeatherResults');
          if (!el) return;
          detailItems.spaceWeather = Array.isArray(items) ? items : [];
          if (!items.length) {
            el.innerHTML = '<p class="muted">No current space weather alerts from SWPC.</p>';
            return;
          }
          el.innerHTML = items.map((item, index) => {
            return \`
              <div class="card clickable-card" onclick="openEventDetail('spaceWeather', \${index})">
                <strong>\${escapeHtml(item.message || 'Space Weather Alert')}</strong><br/>
              </div>
            \`;
          }).join('');
        }

        function renderCyclones(items) {
          const el = document.getElementById('cycloneResults');
          if (!el) return;
          detailItems.cyclones = Array.isArray(items) ? items : [];
          if (!items.length) {
            el.innerHTML = '<p class="muted">No active cyclone events found.</p>';
            return;
          }
          el.innerHTML = items.map((item, index) => {
            return \`
              <div class="card clickable-card" onclick="openEventDetail('cyclones', \${index})">
                <strong>\${escapeHtml(item.title || 'Cyclone Event')}</strong><br/>
                <span class="muted">\${escapeHtml(item.geometryDate || '')}</span><br/>
                <span>\${escapeHtml(item.source || 'Public event feed')}</span>
              </div>
            \`;
          }).join('');
        }

        function renderWildfires(items) {
          const el = document.getElementById('wildfireResults');
          if (!el) return;
          detailItems.wildfires = Array.isArray(items) ? items : [];
          if (!items.length) {
            el.innerHTML = '<p class="muted">No active wildfire events found.</p>';
            return;
          }
          el.innerHTML = items.map((item, index) => {
            return \`
              <div class="card clickable-card" onclick="openEventDetail('wildfires', \${index})">
                <strong>\${escapeHtml(item.title || 'Wildfire Event')}</strong><br/>
                <span class="muted">\${escapeHtml(item.geometryDate || '')}</span><br/>
                <span>\${escapeHtml(item.source || 'Public event feed')}</span>
              </div>
            \`;
          }).join('');
        }

        function renderForecasts(items) {
          const el = document.getElementById('forecastResults');
          if (!el) return;
          detailItems.forecasts = Array.isArray(items) ? items : [];
          if (!items.length) {
            el.innerHTML = '<p class="muted">No future forecast periods available for configured locations.</p>';
            return;
          }
          el.innerHTML = items.map((item, index) => {
            return \`
              <div class="card clickable-card" onclick="openEventDetail('forecasts', \${index})">
                <strong>\${escapeHtml(item.locationName)} - \${escapeHtml(item.name || 'Forecast')}</strong><br/>
                <span class="muted">\${escapeHtml(item.startTime || '')} to \${escapeHtml(item.endTime || '')}</span><br/>
                <span>\${escapeHtml(item.detailedForecast || item.shortForecast || '')}</span><br/>
                <span class="muted">\${escapeHtml(normalizeForecastTemp(item.temperature, item.temperatureUnit))}</span>
              </div>
            \`;
          }).join('');
        }

        function isCriticalNoaaEvent(item) {
          const event = String(item.event || '').toLowerCase();
          const severity = String(item.severity || '').toLowerCase();
          const criticalKeywords = ['tornado', 'hurricane', 'tsunami', 'flash flood warning', 'blizzard', 'severe thunderstorm warning'];
          return severity === 'extreme' || severity === 'severe' || criticalKeywords.some((key) => event.includes(key));
        }

        async function maybeTriggerCriticalPopup(noaaItems, usgsItems, canadaItems) {
          const prefs = getAlertPrefs();
          const criticalNoaa = prefs.weatherEnabled ? noaaItems.filter(isCriticalNoaaEvent) : [];
          const criticalCanada = prefs.weatherEnabled ? (canadaItems || []).filter((item) => isCriticalNoaaEvent(item)) : [];
          const criticalUsgs = prefs.usgsEnabled
            ? usgsItems.filter((item) => {
              const magnitude = Number(item.magnitude);
              const distance = Number(item.distanceMiles);
              return Number.isFinite(magnitude) &&
                magnitude >= prefs.usgsMinMagnitude &&
                Number.isFinite(distance) &&
                distance <= prefs.usgsMaxDistanceMiles;
            })
            : [];
          if (!criticalNoaa.length && !criticalUsgs.length && !criticalCanada.length) return;
          const lines = [];
          for (const item of criticalNoaa.slice(0, 6)) {
            lines.push('[NOAA] ' + (item.event || 'Critical alert') + ' near ' + item.locationName);
          }
          for (const item of criticalCanada.slice(0, 6)) {
            lines.push('[Environment Canada] ' + (item.event || item.title || 'Critical alert') + ' near ' + item.locationName);
          }
          for (const item of criticalUsgs.slice(0, 6)) {
            lines.push('[USGS] M' + item.magnitude + ' - ' + item.place + ' (' + formatDistanceFromMiles(item.distanceMiles) + ' from ' + item.locationName + ')');
          }
          playAlertSound(prefs.soundPath);
          await ipcRenderer.invoke('show-critical-popup', {
            title: 'Critical Weather / Seismic Alert',
            lines
          });
        }

        async function refreshNoaa() {
          if (!config.isConfigured || !config.locations.length) {
            alert('Setup must be completed before data can be retrieved.');
            return;
          }
          const runStatus = document.getElementById('weatherRunStatus');
          runStatus.className = 'status warn';
          runStatus.textContent = 'Fetching NOAA data...';
          try {
            const noaa = await ipcRenderer.invoke('fetch-noaa-alerts');
            const canada = await ipcRenderer.invoke('fetch-canada-alerts');
            const dashboard = await ipcRenderer.invoke('fetch-noaa-dashboard', { locations: config.locations });

            const filteredNoaa = [];
            for (const feature of noaa.features || []) {
              const props = feature.properties || {};
              const area = String(props.areaDesc || '').toLowerCase();
              for (const loc of config.locations) {
                if (area.includes(loc.name.toLowerCase())) {
                  filteredNoaa.push({
                    id: props.id || props.messageType || props.event + ':' + props.sent,
                    event: props.event,
                    severity: props.severity,
                    areaDesc: props.areaDesc,
                    headline: props.headline,
                    locationName: loc.name
                  });
                  break;
                }
              }
            }
            const filteredCanada = [];
            for (const feature of canada.features || []) {
              const props = feature.properties || {};
              const area = String(
                props.areaDesc ||
                props.area ||
                props.title ||
                props.description ||
                ''
              ).toLowerCase();
              for (const loc of config.locations) {
                if (area.includes(loc.name.toLowerCase())) {
                  filteredCanada.push({
                    id: props.id || props.identifier || props.title,
                    event: props.event || props.type || props.title,
                    severity: props.severity || props.urgency || props.certainty,
                    areaDesc: props.areaDesc || props.area || props.title,
                    headline: props.headline || props.description || props.title,
                    locationName: loc.name,
                    title: props.title,
                    description: props.description
                  });
                  break;
                }
              }
            }
            await ipcRenderer.invoke('archive-noaa', filteredNoaa);
            await ipcRenderer.invoke('archive-canada', filteredCanada);
            await ipcRenderer.invoke('archive-noaa-dashboard', dashboard ? [dashboard] : []);
            await ipcRenderer.invoke('store-records', {
              source: 'NOAA',
              category: 'weather_alert',
              isForecast: false,
              records: filteredNoaa.map((item) => ({
                eventTime: null,
                title: item.event,
                severity: item.severity,
                locationName: item.locationName,
                ...item
              }))
            });
            await ipcRenderer.invoke('store-records', {
              source: 'Environment Canada',
              category: 'weather_alert',
              isForecast: false,
              records: filteredCanada.map((item) => ({
                eventTime: null,
                title: item.event || item.title,
                severity: item.severity,
                locationName: item.locationName,
                ...item
              }))
            });
            await maybeTriggerCriticalPopup(filteredNoaa, [], filteredCanada);
            await renderArchiveSummary();
            renderNoaaDashboard(dashboard);
            renderNoaa(filteredNoaa);
            renderCanadaAlerts(filteredCanada);
            runStatus.className = 'status ok';
            runStatus.textContent = 'NOAA + Environment Canada weather refresh complete for configured locations.';
          } catch (error) {
            runStatus.className = 'status error';
            runStatus.textContent = 'NOAA refresh failed: ' + error.message;
          }
        }


        async function refreshWeather() {
          if (!config.isConfigured || !config.locations.length) {
            alert('Setup must be completed before data can be retrieved.');
            return;
          }
          const runStatus = document.getElementById('earthquakesRunStatus');
          runStatus.className = 'status warn';
          runStatus.textContent = 'Fetching earthquake and tsunami data...';
          try {
            const box = getBoundingBox(config.locations, config.radiusMiles || 150);
            const usgs = await ipcRenderer.invoke('fetch-usgs-events', box);
            const tsunamis = await ipcRenderer.invoke('fetch-tsunami-bulletins');
            const filteredUsgs = [];
            for (const feature of usgs.features || []) {
              const coords = (feature.geometry && feature.geometry.coordinates) || [];
              const lon = Number(coords[0]);
              const lat = Number(coords[1]);
              if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
              let nearest = null;
              for (const loc of config.locations) {
                const dist = milesBetween(loc.latitude, loc.longitude, lat, lon);
                if (!nearest || dist < nearest.distance) {
                  nearest = { locationName: loc.name, distance: dist };
                }
              }
              if (nearest && nearest.distance <= 200) {
                filteredUsgs.push({
                  id: feature.id,
                  magnitude: feature.properties && feature.properties.mag,
                  place: feature.properties && feature.properties.place,
                  time: new Date(feature.properties && feature.properties.time).toLocaleString(),
                  distanceMiles: nearest.distance.toFixed(1),
                  locationName: nearest.locationName,
                  detailUrl: feature.properties && feature.properties.url,
                  alertLevel: feature.properties && feature.properties.alert,
                  status: feature.properties && feature.properties.status,
                  depthKm: Number.isFinite(Number(coords[2])) ? Number(coords[2]).toFixed(1) : ''
                });
              }
            }
            const radiusLimit = Number(config.radiusMiles || 150);
            const radiusFiltered = filteredUsgs.filter((item) => Number(item.distanceMiles) <= radiusLimit);
            await ipcRenderer.invoke('archive-usgs', radiusFiltered);
            await ipcRenderer.invoke('archive-tsunamis', tsunamis.entries || []);
            await ipcRenderer.invoke('store-records', {
              source: 'USGS',
              category: 'earthquake',
              isForecast: false,
              records: radiusFiltered.map((item) => ({
                eventTime: item.time,
                title: item.place,
                severity: item.magnitude,
                locationName: item.locationName,
                ...item
              }))
            });
            await ipcRenderer.invoke('store-records', {
              source: 'Tsunami Warning Centers',
              category: 'tsunami',
              isForecast: false,
              records: (tsunamis.entries || []).map((entry) => ({
                eventTime: entry.updated || entry.published || null,
                title: entry.title,
                severity: null,
                locationName: null,
                ...entry
              }))
            });
            await maybeTriggerCriticalPopup([], radiusFiltered, []);
            await renderArchiveSummary();
            renderUsgs(radiusFiltered);
            renderTsunamis(tsunamis.entries || []);
            runStatus.className = 'status ok';
            runStatus.textContent = 'Earthquake and tsunami refresh complete.';
          } catch (error) {
            runStatus.className = 'status error';
            runStatus.textContent = 'Earthquake/Tsunami refresh failed: ' + error.message;
          }
        }

        async function refreshSpaceWeather() {
          if (!config.isConfigured || !config.locations.length) return;
          const runStatus = document.getElementById('spaceWeatherRunStatus');
          runStatus.className = 'status warn';
          runStatus.textContent = 'Fetching NOAA SWPC alerts...';
          try {
            const data = await ipcRenderer.invoke('fetch-space-weather');
            const items = Array.isArray(data.items) ? data.items : [];
            await ipcRenderer.invoke('archive-space-weather', items);
            await ipcRenderer.invoke('store-records', {
              source: 'NOAA SWPC',
              category: 'space_weather',
              isForecast: false,
              records: items.map((item) => ({
                eventTime: null,
                title: item.message,
                severity: null,
                locationName: null,
                ...item
              }))
            });
            renderSpaceWeather(items);
            await renderArchiveSummary();
            runStatus.className = 'status ok';
            runStatus.textContent = 'Space weather refresh complete.';
          } catch (error) {
            runStatus.className = 'status error';
            runStatus.textContent = 'Space weather refresh failed: ' + error.message;
          }
        }

        async function refreshCyclones() {
          if (!config.isConfigured || !config.locations.length) return;
          const runStatus = document.getElementById('cyclonesRunStatus');
          runStatus.className = 'status warn';
          runStatus.textContent = 'Fetching cyclone events...';
          try {
            const data = await ipcRenderer.invoke('fetch-cyclones');
            const items = Array.isArray(data.items) ? data.items : [];
            await ipcRenderer.invoke('archive-cyclones', items);
            await ipcRenderer.invoke('store-records', {
              source: 'NASA EONET',
              category: 'cyclone',
              isForecast: false,
              records: items.map((item) => ({
                eventTime: item.geometryDate || null,
                title: item.title,
                severity: null,
                locationName: null,
                ...item
              }))
            });
            renderCyclones(items);
            await renderArchiveSummary();
            runStatus.className = 'status ok';
            runStatus.textContent = 'Cyclone refresh complete.';
          } catch (error) {
            runStatus.className = 'status error';
            runStatus.textContent = 'Cyclone refresh failed: ' + error.message;
          }
        }

        async function refreshWildfires() {
          if (!config.isConfigured || !config.locations.length) return;
          const runStatus = document.getElementById('wildfiresRunStatus');
          runStatus.className = 'status warn';
          runStatus.textContent = 'Fetching wildfire events...';
          try {
            const data = await ipcRenderer.invoke('fetch-wildfires');
            const items = Array.isArray(data.items) ? data.items : [];
            await ipcRenderer.invoke('archive-wildfires', items);
            await ipcRenderer.invoke('store-records', {
              source: 'NASA EONET',
              category: 'wildfire',
              isForecast: false,
              records: items.map((item) => ({
                eventTime: item.geometryDate || null,
                title: item.title,
                severity: null,
                locationName: null,
                ...item
              }))
            });
            renderWildfires(items);
            await renderArchiveSummary();
            runStatus.className = 'status ok';
            runStatus.textContent = 'Wildfire refresh complete.';
          } catch (error) {
            runStatus.className = 'status error';
            runStatus.textContent = 'Wildfire refresh failed: ' + error.message;
          }
        }

        async function refreshData() {
          await Promise.all([refreshNoaa(), refreshWeather(), refreshSpaceWeather(), refreshCyclones(), refreshWildfires(), refreshForecasts()]);
        }

        async function refreshForecasts() {
          if (!config.isConfigured || !config.locations.length) return;
          const runStatus = document.getElementById('forecastsRunStatus');
          runStatus.className = 'status warn';
          runStatus.textContent = 'Fetching future forecast data...';
          try {
            const allForecasts = [];
            for (const loc of config.locations) {
              const data = await ipcRenderer.invoke('fetch-noaa-forecast', {
                latitude: loc.latitude,
                longitude: loc.longitude
              });
              const periods = data && data.properties && Array.isArray(data.properties.periods)
                ? data.properties.periods
                : [];
              const now = new Date();
              const future = periods
                .filter((period) => period && period.startTime && new Date(period.startTime) > now)
                .map((period) => ({ ...period, locationName: loc.name }));
              allForecasts.push(...future);
            }
            await ipcRenderer.invoke('archive-forecasts', allForecasts);
            await ipcRenderer.invoke('store-records', {
              source: 'NOAA',
              category: 'forecast',
              isForecast: true,
              records: allForecasts.map((item) => ({
                eventTime: item.startTime || null,
                title: item.name,
                severity: null,
                locationName: item.locationName,
                ...item
              }))
            });
            renderForecasts(allForecasts);
            await renderArchiveSummary();
            runStatus.className = 'status ok';
            runStatus.textContent = 'Forecast refresh complete.';
          } catch (error) {
            runStatus.className = 'status error';
            runStatus.textContent = 'Forecast refresh failed: ' + error.message;
          }
        }

        async function quickRefreshUSGSOnly() {
          if (!config.isConfigured || !config.locations.length) return;
          await refreshWeather();
        }

        setInterval(() => {
          void quickRefreshUSGSOnly();
        }, 5 * 60 * 1000);

        async function quickRefreshNonUSGS() {
          if (!config.isConfigured || !config.locations.length) return;
          await Promise.all([refreshNoaa(), refreshSpaceWeather(), refreshCyclones(), refreshWildfires(), refreshForecasts()]);
        }

        setInterval(() => {
          void quickRefreshNonUSGS();
        }, 30 * 60 * 1000);

        if (typeof window !== 'undefined') {
          try {
            Object.assign(window, {
              addLocation,
              removeLocation,
              completeSetup,
              refreshNoaa,
              refreshWeather,
              refreshSpaceWeather,
              refreshCyclones,
              refreshWildfires,
              refreshForecasts,
              showPage,
              toggleOpenAtLogin,
              openRootRecordWebsite,
              emailRootRecordSupport,
              authSignIn,
              authSignUp,
              startCheckout,
              onUnitSystemChanged,
              saveAlertSettings,
              openLocationMapPicker,
              closeLocationMapPicker,
              applyPickedLocation,
              openDashboardDetail,
              closeDashboardDetail,
              openEventDetail,
              openExternalUrl,
              previewSelectedAlertSound
            });
          } catch (error) {
            setAuthStatus('error', 'UI initialization failed: ' + (error && error.message ? error.message : String(error)));
          }
        }

        const authSignInBtn = document.getElementById('authSignInBtn');
        if (authSignInBtn) authSignInBtn.addEventListener('click', () => { void authSignIn(); });
        const authSignUpBtn = document.getElementById('authSignUpBtn');
        if (authSignUpBtn) authSignUpBtn.addEventListener('click', () => { void authSignUp(); });
        const authSubscribeBtn = document.getElementById('authSubscribeBtn');
        if (authSubscribeBtn) authSubscribeBtn.addEventListener('click', () => { void startCheckout(); });
        const authOpenWebsiteBtn = document.getElementById('authOpenWebsiteBtn');
        if (authOpenWebsiteBtn) authOpenWebsiteBtn.addEventListener('click', () => { void openRootRecordWebsite(); });
        document.addEventListener('click', (event) => {
          const target = event && event.target ? event.target.closest('button') : null;
          if (!target) return;
          if (target.id === 'authSignInBtn') void authSignIn();
          if (target.id === 'authSignUpBtn') void authSignUp();
          if (target.id === 'authSubscribeBtn') void startCheckout();
          if (target.id === 'authOpenWebsiteBtn') void openRootRecordWebsite();
        });

        loadConfig();
      </script>
    </body>
    </html>
  `;
  const runtimeUiPath = path.join(app.getPath('userData'), 'rrwm-runtime-ui.html');
  fs.writeFileSync(runtimeUiPath, appHtml, 'utf8');
  mainWindow.loadFile(runtimeUiPath);
  mainWindow.webContents.on('did-finish-load', () => {
    const fallbackScript = `
      (() => {
        if (window.__rrwmFallbackWired) return;
        window.__rrwmFallbackWired = true;
        const pages = ['weather', 'earthquakes', 'space-weather', 'cyclones', 'wildfires', 'forecasts', 'settings', 'about', 'contact'];
        const fallbackShowPage = (pageName) => {
          for (const p of pages) {
            const el = document.getElementById(p + '-page');
            if (el) el.style.display = p === pageName ? 'block' : 'none';
          }
        };
        if (typeof window.showPage !== 'function') {
          window.showPage = fallbackShowPage;
        }
        document.addEventListener('click', (event) => {
          const btn = event && event.target ? event.target.closest('button') : null;
          if (!btn) return;
          const text = (btn.textContent || '').trim().toLowerCase();
          if (text === 'weather (noaa)') fallbackShowPage('weather');
          if (text === 'earthquakes & tsunamis') fallbackShowPage('earthquakes');
          if (text === 'space weather') fallbackShowPage('space-weather');
          if (text === 'cyclone tracker') fallbackShowPage('cyclones');
          if (text === 'wildfires') fallbackShowPage('wildfires');
          if (text === 'forecasts') fallbackShowPage('forecasts');
          if (text === 'settings') fallbackShowPage('settings');
          if (text === 'about / coverage') fallbackShowPage('about');
          if (text === 'contact & feedback') fallbackShowPage('contact');
        }, true);
      })();
    `;
    void mainWindow.webContents.executeJavaScript(fallbackScript).catch(() => {});
  });

  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools();
  }
}

app.whenReady().then(() => {
  initLocalDatabase();
  applyOpenAtLoginSetting();
  createWindow();
});

app.on('window-all-closed', () => {
  if (db) db.close();
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

ipcMain.handle('get-location-config', async () => {
  return readLocationConfig();
});

ipcMain.handle('save-location-config', async (_event, config) => {
  const radius = Number(config && config.radiusMiles);
  const unitSystem = String(config && config.unitSystem ? config.unitSystem : '').toLowerCase() === 'metric' ? 'metric' : 'imperial';
  const alerts = config && config.criticalAlerts && typeof config.criticalAlerts === 'object' ? config.criticalAlerts : {};
  const usgsMinMagnitude = Number(alerts.usgsMinMagnitude);
  const usgsMaxDistanceMiles = Number(alerts.usgsMaxDistanceMiles);
  const soundPath = String(alerts.soundPath || '').trim();
  const next = {
    isConfigured: Boolean(config && config.isConfigured),
    radiusMiles: Number.isFinite(radius) && radius > 0 ? radius : 150,
    unitSystem,
    criticalAlerts: {
      weatherEnabled: alerts.weatherEnabled !== false,
      usgsEnabled: alerts.usgsEnabled !== false,
      usgsMinMagnitude: Number.isFinite(usgsMinMagnitude) ? Math.max(0, usgsMinMagnitude) : 5.0,
      usgsMaxDistanceMiles: Number.isFinite(usgsMaxDistanceMiles) && usgsMaxDistanceMiles > 0 ? usgsMaxDistanceMiles : 200,
      soundPath
    },
    locations: Array.isArray(config && config.locations) ? config.locations : []
  };
  store.set(LOCATION_CONFIG_KEY, next);
  return readLocationConfig();
});

function ensureConfigured() {
  const cfg = readLocationConfig();
  if (!cfg.isConfigured || !cfg.locations.length) {
    throw new Error('Location setup is incomplete. Configure and finalize setup first.');
  }
  return cfg;
}

ipcMain.handle('archive-noaa', async (_event, items) => {
  appendArchive('noaa', items);
  return { ok: true };
});

ipcMain.handle('archive-usgs', async (_event, items) => {
  appendArchive('usgs', items);
  return { ok: true };
});

ipcMain.handle('archive-canada', async (_event, items) => {
  appendArchive('canada', items);
  return { ok: true };
});

ipcMain.handle('archive-tsunamis', async (_event, items) => {
  appendArchive('tsunamis', items);
  return { ok: true };
});

ipcMain.handle('archive-noaa-dashboard', async (_event, items) => {
  appendArchive('noaaDashboard', items);
  return { ok: true };
});

ipcMain.handle('archive-space-weather', async (_event, items) => {
  appendArchive('spaceWeather', items);
  return { ok: true };
});

ipcMain.handle('archive-cyclones', async (_event, items) => {
  appendArchive('cyclones', items);
  return { ok: true };
});

ipcMain.handle('archive-wildfires', async (_event, items) => {
  appendArchive('wildfires', items);
  return { ok: true };
});

ipcMain.handle('archive-forecasts', async (_event, items) => {
  appendArchive('forecasts', items);
  return { ok: true };
});

ipcMain.handle('store-records', async (_event, payload) => {
  const p = payload || {};
  const records = Array.isArray(p.records) ? p.records : [];
  await storeRecords(records, {
    source: p.source || 'unknown',
    category: p.category || 'general',
    isForecast: Boolean(p.isForecast)
  });
  return { ok: true, count: records.length };
});

ipcMain.handle('archive-summary', async () => {
  const archive = readArchive();
  return {
    noaa: archive.noaa.length,
    canada: archive.canada.length,
    usgs: archive.usgs.length,
    tsunamis: archive.tsunamis.length,
    noaaDashboard: archive.noaaDashboard.length,
    spaceWeather: archive.spaceWeather.length,
    cyclones: archive.cyclones.length,
    wildfires: archive.wildfires.length,
    forecasts: archive.forecasts.length
  };
});

ipcMain.handle('archive-latest', async (_event, options) => {
  const archive = readArchive();
  const countRaw = Number(options && options.count);
  const count = Number.isFinite(countRaw) && countRaw > 0 ? Math.min(1000, Math.floor(countRaw)) : 250;
  const pull = (arr) => (Array.isArray(arr) ? arr.slice(-count).map((entry) => entry && entry.payload).filter(Boolean) : []);
  const dashboardRows = pull(archive.noaaDashboard);
  return {
    noaa: pull(archive.noaa),
    canada: pull(archive.canada),
    usgs: pull(archive.usgs),
    tsunamis: pull(archive.tsunamis),
    noaaDashboard: dashboardRows.length ? dashboardRows[dashboardRows.length - 1] : null,
    spaceWeather: pull(archive.spaceWeather),
    cyclones: pull(archive.cyclones),
    wildfires: pull(archive.wildfires),
    forecasts: pull(archive.forecasts)
  };
});

ipcMain.handle('show-critical-popup', async (_event, payload) => {
  createOrShowCriticalPopup(payload);
  return { ok: true };
});

ipcMain.handle('fetch-noaa-alerts', async () => {
  ensureConfigured();
  const response = await fetch('https://api.weather.gov/alerts/active', {
    headers: {
      'User-Agent': 'RootRecordWeatherManager/1.0 (rootrecord@outlook.com)',
      'Accept': 'application/geo+json'
    }
  });
  if (!response.ok) {
    throw new Error(`NOAA request failed: ${response.status}`);
  }
  return await response.json();
});

ipcMain.handle('fetch-canada-alerts', async () => {
  ensureConfigured();
  const response = await fetch('https://api.weather.gc.ca/collections/weather-alerts/items?f=json');
  if (!response.ok) {
    throw new Error(`Environment Canada request failed: ${response.status}`);
  }
  return await response.json();
});

ipcMain.handle('fetch-usgs-events', async (_event, box) => {
  ensureConfigured();
  const params = new URLSearchParams({
    format: 'geojson',
    starttime: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString(),
    minlatitude: String(box && box.minLat != null ? box.minLat : -90),
    maxlatitude: String(box && box.maxLat != null ? box.maxLat : 90),
    minlongitude: String(box && box.minLon != null ? box.minLon : -180),
    maxlongitude: String(box && box.maxLon != null ? box.maxLon : 180)
  });
  const url = `https://earthquake.usgs.gov/fdsnws/event/1/query?${params.toString()}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`USGS request failed: ${response.status}`);
  }
  return await response.json();
});

ipcMain.handle('fetch-noaa-forecast', async (_event, coords) => {
  ensureConfigured();
  const latitude = Number(coords && coords.latitude);
  const longitude = Number(coords && coords.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    throw new Error('Invalid coordinates for NOAA forecast request');
  }
  const pointsResponse = await fetch(`https://api.weather.gov/points/${latitude},${longitude}`, {
    headers: {
      'User-Agent': 'RootRecordWeatherManager/1.0 (rootrecord@outlook.com)',
      'Accept': 'application/geo+json'
    }
  });
  if (!pointsResponse.ok) {
    throw new Error(`NOAA points request failed: ${pointsResponse.status}`);
  }
  const points = await pointsResponse.json();
  const forecastUrl = points && points.properties ? points.properties.forecast : null;
  if (!forecastUrl) {
    throw new Error('NOAA forecast endpoint not available for this location');
  }
  const forecastResponse = await fetch(forecastUrl, {
    headers: {
      'User-Agent': 'RootRecordWeatherManager/1.0 (rootrecord@outlook.com)',
      'Accept': 'application/geo+json'
    }
  });
  if (!forecastResponse.ok) {
    throw new Error(`NOAA forecast request failed: ${forecastResponse.status}`);
  }
  return await forecastResponse.json();
});

async function fetchNoaaJson(url) {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'RootRecordWeatherManager/1.0 (rootrecord@outlook.com)',
      'Accept': 'application/geo+json'
    }
  });
  if (!response.ok) {
    throw new Error(`NOAA request failed: ${response.status}`);
  }
  return await response.json();
}

ipcMain.handle('fetch-noaa-dashboard', async (_event, payload) => {
  ensureConfigured();
  const locations = Array.isArray(payload && payload.locations) ? payload.locations : [];
  const current = [];
  const daily = [];
  const averages = [];
  const radar = [];
  const iconAssets = [];
  const satellite = [
    { label: 'GOES East - CONUS Geocolor', url: 'https://cdn.star.nesdis.noaa.gov/GOES16/ABI/CONUS/GEOCOLOR/latest.jpg' },
    { label: 'GOES West - CONUS Geocolor', url: 'https://cdn.star.nesdis.noaa.gov/GOES18/ABI/CONUS/GEOCOLOR/latest.jpg' }
  ];

  for (const loc of locations) {
    const latitude = Number(loc.latitude);
    const longitude = Number(loc.longitude);
    const locationName = String(loc.name || 'Location');
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) continue;

    try {
      const points = await fetchNoaaJson(`https://api.weather.gov/points/${latitude},${longitude}`);
      const props = points && points.properties ? points.properties : {};

      if (props.forecast) {
        const forecast = await fetchNoaaJson(props.forecast);
        const periods = forecast && forecast.properties && Array.isArray(forecast.properties.periods)
          ? forecast.properties.periods
          : [];
        const first = periods[0];
        if (first) {
          daily.push({
            locationName,
            name: first.name || 'Period',
            shortForecast: first.shortForecast || '',
            temperature: first.temperature,
            temperatureUnit: first.temperatureUnit
          });
        }
        for (const period of periods.slice(0, 6)) {
          if (period && period.icon) {
            iconAssets.push({
              locationName,
              name: period.name || 'Period',
              icon: period.icon
            });
          }
        }
      }

      if (props.radarStation) {
        const station = String(props.radarStation || '').trim().toUpperCase();
        if (station) {
          radar.push({
            locationName,
            station,
            url: `https://radar.weather.gov/ridge/standard/${station}_loop.gif`
          });
        }
      }

      if (props.forecastHourly) {
        const hourly = await fetchNoaaJson(props.forecastHourly);
        const periods = hourly && hourly.properties && Array.isArray(hourly.properties.periods)
          ? hourly.properties.periods
          : [];
        const now = new Date();
        const next24 = periods.filter((p) => p && p.startTime && (new Date(p.startTime) > now)).slice(0, 24);
        if (next24.length) {
          const tempVals = next24.map((p) => Number(p.temperature)).filter((n) => Number.isFinite(n));
          const windVals = next24
            .map((p) => Number(String(p.windSpeed || '').split(' ')[0]))
            .filter((n) => Number.isFinite(n));
          const avgTemp = tempVals.length ? tempVals.reduce((a, b) => a + b, 0) / tempVals.length : null;
          const avgWind = windVals.length ? windVals.reduce((a, b) => a + b, 0) / windVals.length : null;
          const first = next24[0];
          current.push({
            locationName,
            text: first.shortForecast || '',
            temperatureF: first.temperature,
            windMph: first.windSpeed || '',
            icon: first.icon || ''
          });
          averages.push({
            locationName,
            avgTempF: avgTemp !== null ? avgTemp.toFixed(1) : 'n/a',
            avgWindMph: avgWind !== null ? avgWind.toFixed(1) : 'n/a'
          });
        }
      } else if (props.observationStations) {
        const stations = await fetchNoaaJson(props.observationStations);
        const stationList = Array.isArray(stations && stations.features) ? stations.features : [];
        const stationId = stationList[0] && stationList[0].properties ? stationList[0].properties.stationIdentifier : null;
        if (stationId) {
          const latest = await fetchNoaaJson(`https://api.weather.gov/stations/${stationId}/observations/latest`);
          const lp = latest && latest.properties ? latest.properties : {};
          const tempC = lp.temperature && lp.temperature.value != null ? Number(lp.temperature.value) : null;
          const windMps = lp.windSpeed && lp.windSpeed.value != null ? Number(lp.windSpeed.value) : null;
          const tempF = tempC !== null && Number.isFinite(tempC) ? ((tempC * 9) / 5 + 32).toFixed(1) : 'n/a';
          const windMph = windMps !== null && Number.isFinite(windMps) ? (windMps * 2.23694).toFixed(1) : 'n/a';
          current.push({
            locationName,
            text: lp.textDescription || '',
            temperatureF: tempF,
            windMph: windMph,
            icon: ''
          });
        }
      }
    } catch {
      // Keep dashboard resilient per-location.
    }
  }

  return { current, daily, averages, radar, satellite, iconAssets };
});

function extractTagValue(block, tagName) {
  const regex = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'i');
  const match = String(block || '').match(regex);
  if (!match) return '';
  return match[1].replace(/<!\\[CDATA\\[|\\]\\]>/g, '').replace(/<[^>]+>/g, '').trim();
}

ipcMain.handle('fetch-tsunami-bulletins', async () => {
  ensureConfigured();
  const response = await fetch('https://www.tsunami.gov/events/xml/PAAQAtom.xml');
  if (!response.ok) {
    throw new Error(`Tsunami bulletin request failed: ${response.status}`);
  }
  const xml = await response.text();
  const entries = [];
  const blocks = xml.match(/<entry[\s\S]*?<\/entry>/gi) || [];
  for (const block of blocks.slice(0, 30)) {
    entries.push({
      title: extractTagValue(block, 'title'),
      summary: extractTagValue(block, 'summary'),
      updated: extractTagValue(block, 'updated'),
      published: extractTagValue(block, 'published')
    });
  }
  return { entries };
});

ipcMain.handle('fetch-space-weather', async () => {
  ensureConfigured();
  const response = await fetch('https://services.swpc.noaa.gov/products/alerts.json');
  if (!response.ok) {
    throw new Error(`Space weather request failed: ${response.status}`);
  }
  const rows = await response.json();
  const items = Array.isArray(rows)
    ? rows
        .slice(1, 60)
        .map((row) => ({ message: Array.isArray(row) ? row.join(' | ') : String(row) }))
    : [];
  return { items };
});

async function fetchEonetCategory(categoryId) {
  const url = `https://eonet.gsfc.nasa.gov/api/v3/events?status=open&category=${encodeURIComponent(categoryId)}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`EONET request failed: ${response.status}`);
  }
  const json = await response.json();
  const events = Array.isArray(json.events) ? json.events : [];
  return {
    items: events.slice(0, 60).map((event) => ({
      id: event.id,
      title: event.title,
      source: Array.isArray(event.sources) && event.sources[0] ? event.sources[0].url : '',
      geometryDate: Array.isArray(event.geometry) && event.geometry[0] ? event.geometry[0].date : ''
    }))
  };
}

ipcMain.handle('fetch-cyclones', async () => {
  ensureConfigured();
  return await fetchEonetCategory('severeStorms');
});

ipcMain.handle('fetch-wildfires', async () => {
  ensureConfigured();
  return await fetchEonetCategory('wildfires');
});

ipcMain.handle('get-open-at-login', async () => {
  return Boolean(store.get(OPEN_AT_LOGIN_KEY, false));
});

ipcMain.handle('set-open-at-login', async (_event, enabled) => {
  store.set(OPEN_AT_LOGIN_KEY, Boolean(enabled));
  applyOpenAtLoginSetting();
  return { ok: true, openAtLogin: Boolean(store.get(OPEN_AT_LOGIN_KEY, false)) };
});

ipcMain.handle('core-auth-state', async () => {
  const email = String(store.get(AUTH_EMAIL_KEY, '') || '').trim();
  const token = String(store.get(AUTH_SESSION_TOKEN_KEY, '') || '').trim();
  if (!CORE_API_BASE_URL) {
    return {
      authenticated: false,
      email,
      message: 'Core auth API is not configured on this build.'
    };
  }
  if (!token) {
    return {
      authenticated: false,
      email,
      message: 'Sign in or create an account to continue.'
    };
  }
  try {
    await coreApiJson('/v1/me', null, token, 'GET');
  } catch {
    store.delete(AUTH_SESSION_TOKEN_KEY);
    return {
      authenticated: false,
      email,
      message: 'Session expired. Please sign in again.'
    };
  }
  try {
    const entitlement = await fetchEntitlementForEmail(email, token);
    if (entitlement.allow) {
      const trialMsg = entitlement.reason === 'trialing' && entitlement.trialRemaining
        ? `Trial active (${entitlement.trialRemaining}).`
        : '';
      return { authenticated: true, email, message: trialMsg, entitlement };
    }
    return {
      authenticated: false,
      email,
      message: entitlement.reason === 'past_due'
        ? 'Subscription past due. Update billing to continue.'
        : 'Your 14-day trial has ended. Subscribe to continue.',
      entitlement
    };
  } catch {
    return {
      authenticated: true,
      email,
      message: 'Signed in. Entitlement check unavailable right now.',
      entitlement: {
        allow: true,
        access: 'unknown',
        reason: 'service_unavailable',
        trialRemaining: ''
      }
    };
  }
});

async function coreAuthExchange(action, payload) {
  const email = String(payload && payload.email ? payload.email : '').trim();
  const password = String(payload && payload.password ? payload.password : '');
  if (!email) throw new Error('Email is required.');
  if (!password || password.length < 10) throw new Error('Password must be at least 10 characters.');
  const deviceId = getOrCreateDeviceId();
  const route = action === 'signup' ? '/v1/auth/signup' : '/v1/auth/login';
  const body = await coreApiJson(route, { email, password, device_id: deviceId }, null);
  const token = String(body.access_token || '').trim();
  if (!token) throw new Error('No access token returned by server.');
  store.set(AUTH_SESSION_TOKEN_KEY, token);
  store.set(AUTH_EMAIL_KEY, email);
  return { ok: true, email };
}

function trialRemainingText(trialEndsAt) {
  if (!trialEndsAt) return '';
  const end = new Date(trialEndsAt);
  if (Number.isNaN(end.getTime())) return '';
  const now = new Date();
  const ms = end.getTime() - now.getTime();
  if (ms <= 0) return 'Trial ended';
  const mins = Math.floor(ms / 60000);
  const days = Math.floor(mins / (60 * 24));
  const hours = Math.floor((mins - days * 24 * 60) / 60);
  if (days > 0) return `${days}d ${hours}h remaining`;
  return `${Math.max(0, hours)}h remaining`;
}

async function fetchEntitlementForEmail(email, token) {
  const deviceId = getOrCreateDeviceId();
  const body = await coreApiJson('/v1/entitlement', { email, device_id: deviceId }, token);
  const access = String(body.access || '').toLowerCase();
  const reason = String(body.reason || '').toLowerCase();
  const trialEndsAt = body.trial_ends_at || null;
  const allow = access === 'full';
  return {
    allow,
    access,
    reason,
    trialEndsAt,
    trialRemaining: trialRemainingText(trialEndsAt),
    raw: body
  };
}

ipcMain.handle('core-auth-login', async (_event, payload) => {
  const result = await coreAuthExchange('login', payload || {});
  const token = String(store.get(AUTH_SESSION_TOKEN_KEY, '') || '').trim();
  let entitlement;
  try {
    entitlement = await fetchEntitlementForEmail(result.email, token);
  } catch {
    entitlement = {
      allow: true,
      access: 'unknown',
      reason: 'service_unavailable',
      trialRemaining: ''
    };
  }
  return { ...result, entitlement };
});

ipcMain.handle('core-auth-signup', async (_event, payload) => {
  const result = await coreAuthExchange('signup', payload || {});
  const token = String(store.get(AUTH_SESSION_TOKEN_KEY, '') || '').trim();
  let entitlement;
  try {
    entitlement = await fetchEntitlementForEmail(result.email, token);
  } catch {
    entitlement = {
      allow: true,
      access: 'unknown',
      reason: 'service_unavailable',
      trialRemaining: ''
    };
  }
  return { ...result, entitlement };
});

ipcMain.handle('core-auth-checkout', async () => {
  const email = String(store.get(AUTH_EMAIL_KEY, '') || '').trim();
  const token = String(store.get(AUTH_SESSION_TOKEN_KEY, '') || '').trim();
  if (!email) throw new Error('Sign in required before checkout.');
  const body = await coreApiJson('/v1/billing/checkout', { email }, token);
  const url = String(body.url || '').trim();
  if (!url.startsWith('http')) {
    throw new Error('Checkout URL unavailable.');
  }
  await shell.openExternal(url);
  return { ok: true };
});

ipcMain.handle('open-external-url', async (_event, urlInput) => {
  const url = String(urlInput || '').trim();
  if (!/^https?:\/\//i.test(url)) {
    throw new Error('Invalid URL');
  }
  await shell.openExternal(url);
  return { ok: true };
});

ipcMain.handle('get-alert-sounds', async () => {
  try {
    if (!ALERT_SOUNDS_DIR || !fs.existsSync(ALERT_SOUNDS_DIR)) return [];
    const allowed = new Set(['.mp3', '.wav', '.ogg', '.m4a', '.flac', '.aac']);
    const entries = fs.readdirSync(ALERT_SOUNDS_DIR, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => {
        const full = path.join(ALERT_SOUNDS_DIR, entry.name);
        return {
          name: entry.name,
          path: full,
          ext: path.extname(entry.name).toLowerCase()
        };
      })
      .filter((item) => allowed.has(item.ext))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((item) => ({ name: item.name, path: item.path }));
  } catch {
    return [];
  }
});

ipcMain.handle('open-rootrecord-website', async () => {
  await shell.openExternal('https://rootrecord.com');
  return { ok: true };
});

ipcMain.handle('email-rootrecord-support', async () => {
  await shell.openExternal('mailto:rootrecord@outlook.com');
  return { ok: true };
});
