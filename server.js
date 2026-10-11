import express from 'express';
import cors from 'cors';
import 'dotenv/config';
import crypto from 'node:crypto';

const app = express();
app.use(express.json({ limit: '32kb' }));
const port = Number(process.env.PORT || 3000);
const baseUrl = (process.env.TUYA_BASE_URL || 'https://openapi.tuyaus.com').replace(/\/$/, '');
const deviceId = process.env.TUYA_DEVICE_ID || '';
const zones = {
  '1': { id: 1, name: 'Patio delantero', code: process.env.ZONE_1_CODE || 'switch_1' },
  '2': { id: 2, name: 'Patio trasero', code: process.env.ZONE_2_CODE || 'switch_2' },
};

const origins = (process.env.CORS_ORIGINS || 'http://localhost:3000').split(',').map(x => x.trim()).filter(Boolean);
app.use(cors({ origin(origin, cb) {
  // Permite herramientas locales sin Origin; en producción configurar dominios exactos.
  if (!origin || origins.includes('*') || origins.includes(origin)) return cb(null, true);
  return cb(new Error('Origen no permitido por CORS'));
} }));

function requireConfig() {
  const missing = ['TUYA_ACCESS_ID', 'TUYA_ACCESS_SECRET', 'TUYA_DEVICE_ID'].filter(k => !process.env[k]);
  if (missing.length) {
    const e = new Error(`Falta configurar: ${missing.join(', ')}`);
    e.status = 503;
    throw e;
  }
}
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const hmac = value => crypto.createHmac('sha256', process.env.TUYA_ACCESS_SECRET).update(value).digest('hex').toUpperCase();
const nonce = () => crypto.randomUUID().replaceAll('-', '');

async function tuyaRequest(method, path, body = undefined, accessToken = '') {
  requireConfig();
  const timestamp = String(Date.now());
  const n = nonce();
  const bodyText = body === undefined ? '' : JSON.stringify(body);
  const contentHash = sha256(bodyText);
  const stringToSign = `${method.toUpperCase()}\n${contentHash}\n\n${path}`;
  const signText = accessToken
    ? `${process.env.TUYA_ACCESS_ID}${accessToken}${timestamp}${n}${stringToSign}`
    : `${process.env.TUYA_ACCESS_ID}${timestamp}${n}${stringToSign}`;
  const headers = {
    client_id: process.env.TUYA_ACCESS_ID,
    sign: hmac(signText),
    t: timestamp,
    sign_method: 'HMAC-SHA256',
    nonce: n,
  };
  if (accessToken) headers.access_token = accessToken;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  const response = await fetch(`${baseUrl}${path}`, {
    method: method.toUpperCase(), headers,
    body: body === undefined ? undefined : bodyText,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.success === false) {
    const e = new Error(data.msg || `Tuya respondió HTTP ${response.status}`);
    e.status = 502;
    e.details = { code: data.code, success: data.success };
    throw e;
  }
  return data;
}

let tokenCache = { value: '', expiresAt: 0 };
async function getToken() {
  if (tokenCache.value && Date.now() < tokenCache.expiresAt - 60_000) return tokenCache.value;
  const data = await tuyaRequest('GET', '/v1.0/token?grant_type=1');
  if (!data.result?.access_token) throw new Error('Tuya no devolvió access_token');
  tokenCache = { value: data.result.access_token, expiresAt: Date.now() + Number(data.result.expire_time || 3600) * 1000 };
  return tokenCache.value;
}
async function authed(method, path, body) {
  const token = await getToken();
  try {
    return await tuyaRequest(method, path, body, token);
  } catch (e) {
    // Reintento único si Tuya indica token inválido/expirado.
    if (![1004, 1010, 1011].includes(Number(e.details?.code))) throw e;
    tokenCache = { value: '', expiresAt: 0 };
    return await tuyaRequest(method, path, body, await getToken());
  }
}

app.get('/api/health', (_req, res) => res.json({ ok: true, app: 'Riegos24 API', mode: 'tuya-cloud', configured: Boolean(process.env.TUYA_ACCESS_ID && process.env.TUYA_ACCESS_SECRET && deviceId) }));
app.get('/api/zones', (_req, res) => res.json({ zones: Object.values(zones).map(({ id, name, code }) => ({ id, name, code })) }));
app.get('/api/device/status', async (_req, res, next) => {
  try {
    const data = await authed('GET', `/v1.0/iot-03/devices/${encodeURIComponent(deviceId)}/status`);
    res.json({ ok: true, deviceId, result: data.result });
  } catch (e) { next(e); }
});
app.post('/api/zones/:id/command', async (req, res, next) => {
  try {
    const zone = zones[req.params.id];
    if (!zone) return res.status(404).json({ ok: false, error: 'Zona inexistente' });
    if (typeof req.body?.on !== 'boolean') return res.status(400).json({ ok: false, error: 'El campo on debe ser true o false' });
    // Protección básica: se exige una confirmación explícita para cualquier encendido.
    if (req.body.on === true && req.body.confirm !== 'I_CONFIRM_WATERING') {
      return res.status(400).json({ ok: false, error: 'Falta confirmación explícita para encender', required: 'confirm: I_CONFIRM_WATERING' });
    }
    const body = { commands: [{ code: zone.code, value: req.body.on }] };
    const data = await authed('POST', `/v1.0/iot-03/devices/${encodeURIComponent(deviceId)}/commands`, body);
    res.json({ ok: true, zone: zone.id, code: zone.code, requested: req.body.on, tuya: data });
  } catch (e) { next(e); }
});
app.use((err, _req, res, _next) => {
  const status = Number(err.status) || 500;
  res.status(status).json({ ok: false, error: err.message || 'Error interno', ...(err.details ? { details: err.details } : {}) });
});
app.listen(port, () => console.log(`Riegos24 API escuchando en puerto ${port}`));
