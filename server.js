import express from 'express';
import cors from 'cors';
import 'dotenv/config';
import crypto from 'node:crypto';

const app = express();
const port = Number(process.env.PORT || 3000);
const API_ACCESS_KEY = process.env.API_ACCESS_KEY || '';
const baseUrl = (process.env.TUYA_BASE_URL || 'https://openapi.tuyaus.com').replace(//$/, '');
const deviceId = process.env.TUYA_DEVICE_ID || '';

const zones = {
'1': { id: 1, name: 'Patio delantero', code: process.env.ZONE_1_CODE || 'switch_1' },
'2': { id: 2, name: 'Patio trasero', code: process.env.ZONE_2_CODE || 'switch_2' },
};

const origins = (process.env.CORS_ORIGINS || 'http://localhost:3000')
.split(',')
.map(x => x.trim())
.filter(Boolean);

// CORS antes de la autenticación.
app.use(cors({
origin(origin, cb) {
if (!origin || origins.includes('*') || origins.includes(origin)) {
return cb(null, true);
}
return cb(new Error('Origen no permitido por CORS'));
},
methods: ['GET', 'POST', 'OPTIONS'],
allowedHeaders: ['Content-Type', 'x-api-key'],
}));

app.use(express.json({ limit: '32kb' }));

// Publicar la aplicación web desde la carpeta public.
app.use(express.static('public'));

// Proteger la API después de permitir las solicitudes OPTIONS.
app.use((req, res, next) => {
if (req.path === '/api/health' || req.method === 'OPTIONS') return next();

const key = req.headers['x-api-key'];
if (!API_ACCESS_KEY || key !== API_ACCESS_KEY) {
return res.status(401).json({ ok: false, error: 'No autorizado' });
}

next();
});
