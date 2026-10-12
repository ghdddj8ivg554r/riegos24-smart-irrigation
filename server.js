import express from 'express';
import cors from 'cors';
import 'dotenv/config';
import crypto from 'node:crypto';

const app = express();
const port = Number(process.env.PORT || 3000);
const API_ACCESS_KEY = process.env.API_ACCESS_KEY || '';
const baseUrl = (process.env.TUYA_BASE_URL || 'https://openapi.tuyaus.com').replace(/\/$/, '');
const deviceId = process.env.TUYA_DEVICE_ID || '';
const zones = {
  '1': { id: 1, name: 'Patio delantero', code: process.env.ZONE_1_CODE || 'switch_1' },
  '2': { id: 2, name: 'Patio trasero', code: process.env.ZONE_2_CODE || 'switch_2' },
};

// IMPORTANTE: estos temporizadores son de respaldo y se pierden si Render reinicia el proceso.
const autoOffTimers = new Map();

app.use(cors({ origin: true, methods: ['GET', 'POST', 'OPTIONS'], allowedHeaders: ['Content-Type', 'x-api-key'] }));
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
function scheduleAutoOff(zone, minutes) {
  clearZoneTimer(zone.id);
  const timer = setTimeout(async () => {
    try {
      await sendZoneCommand(zone, false);
      console.log(`Auto-OFF enviado a zona ${zone.id} (${zone.name})`);
    } catch (e) {
      console.error(`FALLO auto-OFF zona ${zone.id}: ${e.message}`);
    } finally {
      autoOffTimers.delete(String(zone.id));
    }
  }, minutes * 60000);
  timer.unref?.();
  autoOffTimers.set(String(zone.id), timer);
  return new Date(Date.now() + minutes * 60000).toISOString();
}

app.get('/api/health', (_req, res) => res.json({
  ok: true, app: 'Riegos24 API', mode: 'tuya-cloud',
  configured: Boolean(API_ACCESS_KEY && process.env.TUYA_ACCESS_ID && process.env.TUYA_ACCESS_SECRET && deviceId),
}));
app.get('/api/zones', (_req, res) => res.json({
  zones: Object.values(zones).map(({ id, name, code }) => ({ id, name, code })),
}));

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
    if (req.body.on && req.body.confirm !== 'I_CONFIRM_WATERING') {
      return res.status(400).json({ ok: false, error: 'Falta confirmación explícita para encender', required: 'confirm: I_CONFIRM_WATERING' });
    }
    if (!req.body.on) {
      clearZoneTimer(zone.id);
      const result = await sendZoneCommand(zone, false);
      return res.json({ ok: true, zone: zone.id, code: zone.code, requested: false, commandAccepted: result.success !== false, tuya: result });
    }
    const rawMinutes = Number(req.body.durationMinutes);
    const minutes = Number.isFinite(rawMinutes) && rawMinutes > 0 ? Math.max(1, Math.min(240, Math.floor(rawMinutes))) : 1;
    const result = await sendZoneCommand(zone, true);
    const autoOffAt = scheduleAutoOff(zone, minutes);
    res.json({
      ok: true, zone: zone.id, code: zone.code, requested: true, durationMinutes: minutes,
      autoOffAt, commandAccepted: result.success !== false, tuya: result,
      warning: 'El temporizador es de respaldo y no sobrevive a reinicios de Render.',
    });
  } catch (e) { next(e); }
});

app.use((error, _req, res, _next) => {
  res.status(Number(error.status) || 500).json({
    ok: false, error: error.message || 'Error interno',
    ...(error.details ? { details: error.details } : {}),
  });
});
app.listen(port, () => console.log(`Riegos24 API escuchando en puerto ${port}`));
