import express from 'express';
import cors from 'cors';
import 'dotenv/config';
import crypto from 'node:crypto';

const app = express();
const port = Number(process.env.PORT || 3000);
const API_ACCESS_KEY = process.env.API_ACCESS_KEY || '';
const baseUrl = (process.env.TUYA_BASE_URL || 'https://openapi.tuyaus.com').replace(/\/$/, '');
const deviceId = process.env.TUYA_DEVICE_ID || '';
const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const PROGRAMS_URL = SUPABASE_URL ? SUPABASE_URL + '/rest/v1/riegos24_programs' : '';
const EVENTS_URL = SUPABASE_URL ? SUPABASE_URL + '/rest/v1/riegos24_events' : '';
const RAIN_LIMIT_MM = Math.max(0, Number(process.env.WEATHER_RAIN_LIMIT_MM || 2));
const WIND_LIMIT_KMH = Math.max(1, Number(process.env.WEATHER_WIND_LIMIT_KMH || 35));
const TZ = process.env.SCHEDULE_TIMEZONE || 'America/Argentina/Cordoba';
let programs = [];
let programsReady = false;
const firedScheduleKeys = new Set();

function supabaseHeaders(extra = {}) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('Falta configurar SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY en Render.');
  }
  return { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: 'Bearer ' + SUPABASE_SERVICE_ROLE_KEY, 'Content-Type': 'application/json', ...extra };
}
async function persistPrograms() {
  const response = await fetch(PROGRAMS_URL + '?on_conflict=id', {
    method: 'POST',
    headers: supabaseHeaders({ Prefer: 'resolution=merge-duplicates,return=minimal' }),
    body: JSON.stringify({ id: 'main', programs, updated_at: new Date().toISOString() }),
  });
  if (!response.ok) throw new Error('No se pudieron guardar los programas en Supabase (HTTP ' + response.status + ').');
}
async function loadPrograms() {
  const response = await fetch(PROGRAMS_URL + '?id=eq.main&select=programs', {
    headers: supabaseHeaders({ Accept: 'application/json' }),
  });
  if (!response.ok) throw new Error('No se pudieron cargar los programas de Supabase (HTTP ' + response.status + ').');
  const rows = await response.json();
  programs = Array.isArray(rows?.[0]?.programs) ? rows[0].programs : [];
  programsReady = true;
}
async function recordEvent(event, detail = '', zoneId = null, ok = true, source = 'server') {
  console.log(`[${ok ? 'OK' : 'ERROR'}] ${event}: ${detail}`);
  if (!EVENTS_URL || !SUPABASE_SERVICE_ROLE_KEY) return;
  try {
    const response = await fetch(EVENTS_URL, { method: 'POST', headers: supabaseHeaders({ Prefer: 'return=minimal' }), body: JSON.stringify({ event, detail: String(detail).slice(0, 1000), zone_id: zoneId, ok, source }) });
    if (!response.ok) console.error('No se pudo guardar evento en Supabase: HTTP ' + response.status);
  } catch (e) { console.error('No se pudo guardar evento:', e.message); }
}
async function getDeviceZoneStates() {
  const data = await authed('GET', `/v1.0/iot-03/devices/${encodeURIComponent(deviceId)}/status`);
  const result = Array.isArray(data.result) ? data.result : [];
  return Object.values(zones).map(zone => {
    const dp = result.find(item => item.code === zone.code);
    return { id: zone.id, code: zone.code, known: !!dp && typeof dp.value === 'boolean', on: dp && typeof dp.value === 'boolean' ? dp.value : null, value: dp?.value ?? null };
  });
}
async function getWeatherSafety() {
  const url = 'https://api.open-meteo.com/v1/forecast?latitude=-27.33&longitude=-58.57&current=precipitation,wind_speed_10m&hourly=precipitation&forecast_days=1&forecast_hours=4&timezone=America%2FArgentina%2FCordoba';
  const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error('Clima no disponible (HTTP ' + response.status + ')');
  const data = await response.json();
  if (!data.current || !Array.isArray(data.hourly?.precipitation)) throw new Error('Pronóstico incompleto');
  const rainMm = data.hourly.precipitation.slice(0, 4).reduce((sum, n) => sum + Number(n || 0), 0);
  const windKmh = Number(data.current.wind_speed_10m || 0);
  return { rainMm, windKmh, rainLimitMm: RAIN_LIMIT_MM, windLimitKmh: WIND_LIMIT_KMH, blocked: (RAIN_LIMIT_MM > 0 && rainMm >= RAIN_LIMIT_MM) || windKmh >= WIND_LIMIT_KMH };
}
function localScheduleParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const v = Object.fromEntries(parts.map(p => [p.type, p.value]));
  const days = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { day: days[v.weekday], time: v.hour + ':' + v.minute, date: v.year + '-' + v.month + '-' + v.day };
}

const zones = {
  '1': { id: 1, name: 'Patio trasero', code: process.env.ZONE_1_CODE || 'switch_1' },
  '2': { id: 2, name: 'Patio delantero', code: process.env.ZONE_2_CODE || 'switch_2' },
};
const autoOffTimers = new Map();

app.use(cors({ origin: true, methods: ['GET', 'POST', 'PUT', 'OPTIONS'], allowedHeaders: ['Content-Type', 'x-api-key'] }));
app.use(express.json({ limit: '32kb' }));
app.use(express.static('public'));
app.use((req, res, next) => {
  if (req.path === '/api/health' || req.method === 'OPTIONS') return next();
  if (!API_ACCESS_KEY || req.headers['x-api-key'] !== API_ACCESS_KEY) {
    return res.status(401).json({ ok: false, error: 'No autorizado' });
  }
  next();
});

function requireConfig() {
  const missing = ['TUYA_ACCESS_ID', 'TUYA_ACCESS_SECRET', 'TUYA_DEVICE_ID'].filter(k => !process.env[k]);
  if (missing.length) { const e = new Error(`Falta configurar: ${missing.join(', ')}`); e.status = 503; throw e; }
}
const sha256 = v => crypto.createHash('sha256').update(v).digest('hex');
const hmac = v => crypto.createHmac('sha256', process.env.TUYA_ACCESS_SECRET).update(v).digest('hex').toUpperCase();
const nonce = () => crypto.randomUUID().replaceAll('-', '');

async function tuyaRequest(method, path, body = undefined, accessToken = '') {
  requireConfig();
  const timestamp = String(Date.now()), requestNonce = nonce();
  const bodyText = body === undefined ? '' : JSON.stringify(body);
  const stringToSign = `${method.toUpperCase()}\n${sha256(bodyText)}\n\n${path}`;
  const signText = accessToken
    ? `${process.env.TUYA_ACCESS_ID}${accessToken}${timestamp}${requestNonce}${stringToSign}`
    : `${process.env.TUYA_ACCESS_ID}${timestamp}${requestNonce}${stringToSign}`;
  const headers = {
    client_id: process.env.TUYA_ACCESS_ID, sign: hmac(signText), t: timestamp,
    sign_method: 'HMAC-SHA256', nonce: requestNonce,
  };
  if (accessToken) headers.access_token = accessToken;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(`${baseUrl}${path}`, {
    method: method.toUpperCase(), headers, body: body === undefined ? undefined : bodyText,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.success === false) {
    const e = new Error(data.msg || `Tuya respondió HTTP ${response.status}`);
    e.status = 502; e.details = { code: data.code, success: data.success }; throw e;
  }
  return data;
}

let tokenCache = { value: '', expiresAt: 0 };
async function getToken() {
  if (tokenCache.value && Date.now() < tokenCache.expiresAt - 60000) return tokenCache.value;
  const data = await tuyaRequest('GET', '/v1.0/token?grant_type=1');
  if (!data.result?.access_token) throw new Error('Tuya no devolvió access_token');
  tokenCache = { value: data.result.access_token, expiresAt: Date.now() + Number(data.result.expire_time || 3600) * 1000 };
  return tokenCache.value;
}
async function authed(method, path, body) {
  const token = await getToken();
  try { return await tuyaRequest(method, path, body, token); }
  catch (e) {
    if (![1004, 1010, 1011].includes(Number(e.details?.code))) throw e;
    tokenCache = { value: '', expiresAt: 0 };
    return tuyaRequest(method, path, body, await getToken());
  }
}
async function sendZoneCommand(zone, on) {
  return authed('POST', `/v1.0/iot-03/devices/${encodeURIComponent(deviceId)}/commands`, {
    commands: [{ code: zone.code, value: on }],
  });
}
function clearZoneTimer(id) {
  const old = autoOffTimers.get(String(id));
  if (old) clearTimeout(old);
  autoOffTimers.delete(String(id));
}
let sequenceState = { running: false, currentZone: null, step: 0, total: 0, message: 'Secuencia inactiva', runId: 0 };
let manualCommandBusy = false;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function runSequence(runId, items) {
  sequenceState = { running: true, currentZone: null, step: 0, total: items.length, message: 'Secuencia iniciada', runId };
  try {
    for (let i = 0; i < items.length; i++) {
      if (sequenceState.runId !== runId) return;
      const item = items[i], zone = zones[String(item.id)];
      sequenceState.currentZone = zone.name; sequenceState.step = i + 1;
      sequenceState.message = 'Regando ' + zone.name + ' (' + (i + 1) + '/' + items.length + ') por ' + item.minutes + ' min';
      const before = await getDeviceZoneStates();
      if (before.some(state => !state.known)) throw new Error('Estado de relés no confirmado; se cancela por seguridad.');
      for (const state of before.filter(state => state.on)) {
        const activeZone = zones[String(state.id)];
        await sendZoneCommand(activeZone, false);
        clearZoneTimer(activeZone.id);
      }
      const afterOff = await getDeviceZoneStates();
      if (afterOff.some(state => !state.known || state.on)) throw new Error('No se pudo confirmar OFF en ambas zonas; se cancela el riego.');
      await sendZoneCommand(zone, true);
      scheduleAutoOff(zone, item.minutes);
      await recordEvent('Zona encendida', zone.name + ' por ' + item.minutes + ' min', zone.id, true, 'sequence');
      const endAt = Date.now() + item.minutes * 60000;
      while (Date.now() < endAt && sequenceState.runId === runId) await sleep(Math.min(1000, endAt - Date.now()));
      if (sequenceState.runId !== runId) return;
      clearZoneTimer(zone.id);
      await sendZoneCommand(zone, false);
      const confirmedOff = await getDeviceZoneStates();
      if (confirmedOff.some(state => !state.known || (state.id === zone.id && state.on))) throw new Error('No se confirmó el apagado de ' + zone.name);
      await recordEvent('Zona apagada', zone.name, zone.id, true, 'sequence');
    }
    if (sequenceState.runId === runId) {
      sequenceState.running = false; sequenceState.currentZone = null; sequenceState.message = 'Ciclo secuencial finalizado';
    }
  } catch (e) {
    sequenceState.running = false; sequenceState.message = 'Error en secuencia: ' + e.message;
    await recordEvent('Fallo de secuencia', e.message, null, false, 'sequence');
    console.error('Fallo en secuencia:', e.message);
    for (const zone of Object.values(zones)) {
      clearZoneTimer(zone.id);
      try { await sendZoneCommand(zone, false); } catch (offError) { console.error('Fallo de seguridad OFF zona ' + zone.id + ': ' + offError.message); }
    }
  }
}
function scheduleAutoOff(zone, minutes) {
  clearZoneTimer(zone.id);
  const timer = setTimeout(async () => {
    try { await sendZoneCommand(zone, false); console.log(`Auto-OFF enviado a zona ${zone.id} (${zone.name})`); }
    catch (e) { console.error(`FALLO auto-OFF zona ${zone.id}: ${e.message}`); }
    finally { autoOffTimers.delete(String(zone.id)); }
  }, minutes * 60000);
  timer.unref?.();
  autoOffTimers.set(String(zone.id), timer);
  return new Date(Date.now() + minutes * 60000).toISOString();
}

app.get('/api/health', (_req, res) => res.json({
  ok: true, app: 'Riegos24 API', mode: 'tuya-cloud',
  configured: Boolean(API_ACCESS_KEY && process.env.TUYA_ACCESS_ID && process.env.TUYA_ACCESS_SECRET && deviceId),
  programsStorage: Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) ? 'supabase' : 'not_configured',
}));
app.get('/api/zones', (_req, res) => res.json({
  zones: Object.values(zones).map(({ id, name, code }) => ({ id, name, code })),
}));

app.get('/api/programs', async (_req, res, next) => {
  try { if (!programsReady) await loadPrograms(); res.json({ ok: true, timezone: TZ, programs }); }
  catch (e) { next(e); }
});
app.put('/api/programs', async (req, res, next) => {
  try {
    const incoming = req.body?.programs;
    if (!Array.isArray(incoming) || incoming.length > 50) return res.status(400).json({ ok: false, error: 'La lista de programas no es válida (máximo 50).' });
    const clean = incoming.map((p, i) => {
      const time = String(p.time || '');
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw Object.assign(new Error('Hora inválida en programa ' + (i + 1)), { status: 400 });
      const days = Array.isArray(p.days) ? [...new Set(p.days.map(Number).filter(d => Number.isInteger(d) && d >= 0 && d <= 6))] : [];
      const durations = {};
      for (const id of [1, 2]) {
        const m = Number(p.durations?.[id] ?? 0);
        if (!Number.isFinite(m) || m < 0 || m > 240) throw Object.assign(new Error('Duración inválida en programa ' + (i + 1)), { status: 400 });
        durations[id] = Math.floor(m);
      }
      const delayUntil = p.delayUntil && Number.isFinite(Date.parse(p.delayUntil)) ? new Date(p.delayUntil).toISOString() : null;
      return { id: Number(p.id) || i + 1, name: String(p.name || ('Programa ' + (i + 1))).slice(0, 80), time, days, durations, enabled: p.enabled === true, delayUntil };
    });
    programs = clean;
    await persistPrograms();
    programsReady = true;
    res.json({ ok: true, programs, saved: true, storage: 'supabase' });
  } catch (e) { next(e); }
});
app.get('/api/sequence/status', (_req, res) => res.json({ ok: true, ...sequenceState, runId: undefined }));
app.get('/api/history', async (_req, res, next) => {
  try {
    const response = await fetch(EVENTS_URL + '?select=id,created_at,event,detail,zone_id,ok,source&order=created_at.desc&limit=200', { headers: supabaseHeaders({ Accept: 'application/json' }) });
    if (!response.ok) throw new Error('No se pudo cargar el historial (HTTP ' + response.status + ').');
    res.json({ ok: true, events: await response.json() });
  } catch (e) { next(e); }
});
app.post('/api/sequence/start', async (req, res, next) => {
  try {
    if (sequenceState.running) return res.status(409).json({ ok: false, error: 'Ya hay una secuencia en curso', sequence: sequenceState });
    const requested = Array.isArray(req.body?.zones) ? req.body.zones : [];
    if (!requested.length || requested.length > 2) return res.status(400).json({ ok: false, error: 'Indicá una o dos zonas con su duración.' });
    const items = requested.map(item => {
      const id = Number(item.id), zone = zones[String(id)], minutes = Number(item.minutes);
      if (!zone || !Number.isFinite(minutes) || minutes < 1 || minutes > 240) throw Object.assign(new Error('Zona o duración inválida'), { status: 400 });
      return { id, minutes: Math.floor(minutes) };
    });
    const runId = sequenceState.runId + 1;
    sequenceState = { running: true, currentZone: null, step: 0, total: items.length, message: 'Secuencia en preparación', runId };
    runSequence(runId, items);
    res.json({ ok: true, accepted: true, message: 'Secuencia iniciada en el servidor. Puede cerrar la página; no reinicie el servicio durante el ciclo.' });
  } catch (e) { next(e); }
});
app.post('/api/sequence/stop', async (_req, res, next) => {
  try {
    sequenceState.runId++;
    sequenceState.running = false; sequenceState.currentZone = null; sequenceState.message = 'Secuencia detenida por el usuario';
    const results = [];
    for (const zone of Object.values(zones)) {
      clearZoneTimer(zone.id);
      try { await sendZoneCommand(zone, false); results.push({ zone: zone.id, ok: true }); }
      catch (e) { results.push({ zone: zone.id, ok: false, error: e.message }); }
    }
    res.json({ ok: true, stopped: true, results, warning: results.some(x => !x.ok) ? 'No se pudo enviar OFF a todas las zonas.' : undefined });
  } catch (e) { next(e); }
});

app.get('/api/device/status', async (_req, res, next) => {
  try {
    const data = await authed('GET', `/v1.0/iot-03/devices/${encodeURIComponent(deviceId)}/status`);
    const result = Array.isArray(data.result) ? data.result : [];
    const zoneStatus = Object.values(zones).map(zone => {
      const dp = result.find(item => item.code === zone.code);
      return { id: zone.id, name: zone.name, code: zone.code, known: Boolean(dp), on: dp && typeof dp.value === 'boolean' ? dp.value : null, value: dp?.value ?? null };
    });
    res.json({ ok: true, deviceId, result, zones: zoneStatus, statusConfirmed: zoneStatus.every(z => z.known && typeof z.on === 'boolean') });
  } catch (e) { next(e); }
});

app.post('/api/zones/:id/command', async (req, res, next) => {
  try {
    const zone = zones[req.params.id];
    if (!zone) return res.status(404).json({ ok: false, error: 'Zona inexistente' });
    if (typeof req.body?.on !== 'boolean') return res.status(400).json({ ok: false, error: 'El campo on debe ser true o false' });
    if (req.body.on && req.body.confirm !== 'I_CONFIRM_WATERING') return res.status(400).json({ ok: false, error: 'Falta confirmación explícita para encender', required: 'confirm: I_CONFIRM_WATERING' });
    if (req.body.on && sequenceState.running) return res.status(409).json({ ok: false, error: 'Hay una secuencia activa. Detenela antes de regar manualmente.' });
    if (req.body.on && manualCommandBusy) return res.status(409).json({ ok: false, error: 'Hay otra orden manual en curso.' });
    if (!req.body.on) {
      clearZoneTimer(zone.id);
      const result = await sendZoneCommand(zone, false);
      return res.json({ ok: true, zone: zone.id, code: zone.code, requested: false, commandAccepted: result.success !== false, tuya: result });
    }
    manualCommandBusy = true;
    try {
      const rawMinutes = Number(req.body.durationMinutes);
      const minutes = Number.isFinite(rawMinutes) && rawMinutes > 0 ? Math.max(1, Math.min(240, Math.floor(rawMinutes))) : 1;
      const states = await getDeviceZoneStates();
      if (states.some(state => !state.known)) return res.status(409).json({ ok: false, error: 'No se conoce el estado real de ambos relés; por seguridad no se inicia el riego.' });
      const otherOn = states.find(state => state.id !== zone.id && state.on);
      if (otherOn) return res.status(409).json({ ok: false, error: 'La otra zona está encendida. Apagala y confirmá el estado antes de continuar.' });
      const result = await sendZoneCommand(zone, true);
      const autoOffAt = scheduleAutoOff(zone, minutes);
      await recordEvent('Riego manual iniciado', zone.name + ' por ' + minutes + ' min', zone.id, true, 'manual');
      res.json({ ok: true, zone: zone.id, code: zone.code, requested: true, durationMinutes: minutes, autoOffAt, commandAccepted: result.success !== false, tuya: result, warning: 'El autoapagado del servidor no sobrevive a reinicios; confirmá el temporizador físico si está disponible.' });
    } finally { manualCommandBusy = false; }
  } catch (e) { next(e); }
});

async function schedulerTick() {
  if (!programsReady) await loadPrograms();
  const now = localScheduleParts();
  const due = programs.filter(p => p.enabled && p.days.includes(now.day) && p.time === now.time && (!p.delayUntil || Date.parse(p.delayUntil) <= Date.now()));
  for (const p of due) {
    const key = now.date + ' ' + p.id + ' ' + p.time;
    if (firedScheduleKeys.has(key)) continue;
    firedScheduleKeys.add(key);
    if (firedScheduleKeys.size > 500) firedScheduleKeys.clear();
    if (sequenceState.running || manualCommandBusy) { await recordEvent('Programa omitido', p.name + ': hay riego activo', null, false, 'scheduler'); continue; }
    let wx;
    try { wx = await getWeatherSafety(); }
    catch (e) { await recordEvent('Programa pospuesto', p.name + ': clima sin verificar; ' + e.message, null, false, 'weather'); continue; }
    if (wx.blocked) { await recordEvent('Programa pospuesto por clima', p.name + ': lluvia ' + wx.rainMm.toFixed(1) + ' mm/4h; viento ' + wx.windKmh + ' km/h', null, true, 'weather'); continue; }
    const items = [1, 2].map(id => ({ id, minutes: Number(p.durations?.[id] || 0) })).filter(x => x.minutes > 0);
    if (!items.length) { console.log('Programa sin duraciones; omitido:', p.name); continue; }
    const runId = sequenceState.runId + 1;
    await recordEvent('Programa horario iniciado', p.name + ' · ' + now.date + ' ' + now.time + ' · lluvia ' + wx.rainMm.toFixed(1) + ' mm/4h · viento ' + wx.windKmh + ' km/h', null, true, 'scheduler');
    runSequence(runId, items).catch(e => console.error('Error de programa:', e.message));
  }
}
setInterval(() => schedulerTick().catch(e => console.error('Error del planificador:', e.message)), 15000);
app.use((error, _req, res, _next) => {
  res.status(Number(error.status) || 500).json({ ok: false, error: error.message || 'Error interno', ...(error.details ? { details: error.details } : {}) });
});
loadPrograms().catch(e => console.error('No se pudieron cargar programas al iniciar:', e.message));
app.listen(port, () => {
  console.log(`Riegos24 API escuchando en puerto ${port}; zona horaria ${TZ}`);
  (async () => {
    try {
      requireConfig();
      for (const zone of Object.values(zones)) { clearZoneTimer(zone.id); await sendZoneCommand(zone, false); }
      await recordEvent('Reinicio seguro', 'Se enviaron órdenes OFF a las dos zonas al iniciar el servidor.', null, true, 'startup');
    } catch (e) { await recordEvent('Fallo de apagado al iniciar', e.message, null, false, 'startup'); }
  })();
});
