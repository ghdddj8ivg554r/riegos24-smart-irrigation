import express from 'express';
import cors from 'cors';
import 'dotenv/config';
import crypto from 'node:crypto';

const app = express();
const port = Number(process.env.PORT || 3000);

const API_ACCESS_KEY = process.env.API_ACCESS_KEY || '';
const baseUrl = (
process.env.TUYA_BASE_URL || 'https://openapi.tuyaus.com'
).replace(/\/$/, '');
const deviceId = process.env.TUYA_DEVICE_ID || '';

const zones = {
'1': {
id: 1,
name: 'Patio delantero',
code: process.env.ZONE_1_CODE || 'switch_1',
},
'2': {
id: 2,
name: 'Patio trasero',
code: process.env.ZONE_2_CODE || 'switch_2',
},
};

app.use(cors({
origin: true,
methods: ['GET', 'POST', 'OPTIONS'],
allowedHeaders: ['Content-Type', 'x-api-key'],
}));

app.use(express.json({ limit: '32kb' }));
app.use(express.static('public'));

app.use((req, res, next) => {
if (req.path === '/api/health' || req.method === 'OPTIONS') {
return next();
}

const key = req.headers['x-api-key'];

if (!API_ACCESS_KEY || key !== API_ACCESS_KEY) {
return res.status(401).json({
ok: false,
error: 'No autorizado',
});
}

next();
});

function requireConfig() {
const missing = [
'TUYA_ACCESS_ID',
'TUYA_ACCESS_SECRET',
'TUYA_DEVICE_ID',
].filter((key) => !process.env[key]);

if (missing.length) {
const error = new Error(
  `Falta configurar: ${missing.join(', ')}`
);
error.status = 503;
throw error;
}
}

const sha256 = (value) =>
crypto.createHash('sha256').update(value).digest('hex');

const hmac = (value) =>
crypto
.createHmac('sha256', process.env.TUYA_ACCESS_SECRET)
.update(value)
.digest('hex')
.toUpperCase();

const nonce = () => crypto.randomUUID().replaceAll('-', '');

async function tuyaRequest(
method,
path,
body = undefined,
accessToken = ''
) {
requireConfig();

const timestamp = String(Date.now());
const requestNonce = nonce();
const bodyText = body === undefined ? '' : JSON.stringify(body);
const contentHash = sha256(bodyText);

const stringToSign =
  `${method.toUpperCase()}\n${contentHash}\n\n${path}`;

const signText = accessToken
  ? `${process.env.TUYA_ACCESS_ID}${accessToken}${timestamp}${requestNonce}${stringToSign}`
  : `${process.env.TUYA_ACCESS_ID}${timestamp}${requestNonce}${stringToSign}`;

const headers = {
client_id: process.env.TUYA_ACCESS_ID,
sign: hmac(signText),
t: timestamp,
sign_method: 'HMAC-SHA256',
nonce: requestNonce,
};

if (accessToken) {
headers.access_token = accessToken;
}

if (body !== undefined) {
headers['Content-Type'] = 'application/json';
}

const response = await fetch(`${baseUrl}${path}`, {
method: method.toUpperCase(),
headers,
body: body === undefined ? undefined : bodyText,
});

const data = await response.json().catch(() => ({}));

if (!response.ok || data.success === false) {
const error = new Error(
  data.msg || `Tuya respondió HTTP ${response.status}`
);

error.status = 502;
error.details = {
  code: data.code,
  success: data.success,
};

throw error;

}

return data;
}

let tokenCache = {
value: '',
expiresAt: 0,
};

async function getToken() {
if (
tokenCache.value &&
Date.now() < tokenCache.expiresAt - 60000
) {
return tokenCache.value;
}

const data = await tuyaRequest(
'GET',
'/v1.0/token?grant_type=1'
);

if (!data.result?.access_token) {
throw new Error('Tuya no devolvió access_token');
}

tokenCache = {
value: data.result.access_token,
expiresAt:
Date.now() +
Number(data.result.expire_time || 3600) * 1000,
};

return tokenCache.value;
}

async function authed(method, path, body) {
const token = await getToken();

try {
return await tuyaRequest(method, path, body, token);
} catch (error) {
const code = Number(error.details?.code);

if (![1004, 1010, 1011].includes(code)) {
  throw error;
}

tokenCache = {
  value: '',
  expiresAt: 0,
};

return await tuyaRequest(
  method,
  path,
  body,
  await getToken()
);

}
}

app.get('/api/health', (_req, res) => {
res.json({
ok: true,
app: 'Riegos24 API',
mode: 'tuya-cloud',
configured: Boolean(
API_ACCESS_KEY &&
process.env.TUYA_ACCESS_ID &&
process.env.TUYA_ACCESS_SECRET &&
deviceId
),
});
});

app.get('/api/zones', (_req, res) => {
res.json({
zones: Object.values(zones).map(
({ id, name, code }) => ({ id, name, code })
),
});
});

app.get('/api/device/status', async (_req, res, next) => {
try {
const data = await authed(
'GET',
`/v1.0/iot-03/devices/${encodeURIComponent(deviceId)}/status`
);

res.json({
  ok: true,
  deviceId,
  result: data.result,
});

} catch (error) {
next(error);
}
});

app.post('/api/zones/:id/command', async (req, res, next) => {
try {
const zone = zones[req.params.id];

if (!zone) {
  return res.status(404).json({
    ok: false,
    error: 'Zona inexistente',
  });
}

if (typeof req.body?.on !== 'boolean') {
  return res.status(400).json({
    ok: false,
    error: 'El campo on debe ser true o false',
  });
}

if (
  req.body.on === true &&
  req.body.confirm !== 'I_CONFIRM_WATERING'
) {
  return res.status(400).json({
    ok: false,
    error: 'Falta confirmación explícita para encender',
    required: 'confirm: I_CONFIRM_WATERING',
  });
}

const body = {
  commands: [
    {
      code: zone.code,
      value: req.body.on,
    },
  ],
};

const data = await authed(
  'POST',
  `/v1.0/iot-03/devices/${encodeURIComponent(deviceId)}/commands`,
  body
);

res.json({
  ok: true,
  zone: zone.id,
  code: zone.code,
  requested: req.body.on,
  tuya: data,
});

} catch (error) {
next(error);
}
});

app.use((error, _req, res, _next) => {
const status = Number(error.status) || 500;

res.status(status).json({
ok: false, 
error: error.message || 'Error interno',
...(error.details ? { details: error.details } : {}),
});
});

app.listen(port, () => {
  console.log(`Riegos24 API escuchando en puerto ${port}`);
});
