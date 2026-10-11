# Riegos24 Smart Irrigation — backend inicial Tuya

Este es un **andamio de desarrollo**, no una conexión ya validada ni lista para regar sin pruebas. El HTML original de Claude no se modifica; este backend se prepara por separado para conservar el prototipo.

## Qué incluye

- `GET /api/health`: estado del backend y presencia de configuración.
- `GET /api/zones`: mapeo inicial de las dos zonas a `switch_1` y `switch_2`.
- `GET /api/device/status`: consulta el estado del dispositivo en Tuya.
- `POST /api/zones/1/command` y `/api/zones/2/command`: envía el booleano al DP configurado.
- Credenciales guardadas en variables de entorno, nunca en el HTML.
- Confirmación adicional requerida para encender una zona.

## Antes de usarlo

1. Confirmar en Tuya que el proyecto usa la región/base URL correcta. El ejemplo utiliza `https://openapi.tuyaus.com` por el centro de datos de EE. UU. que se veía en las capturas; confirmar antes de producción.
2. Verificar que `TUYA_ACCESS_ID`, `TUYA_ACCESS_SECRET` y `TUYA_DEVICE_ID` corresponden al proyecto y al relé correctos.
3. Confirmar que el servicio IoT Core tiene autorización y cuota activa para estas APIs.
4. Validar el modelo de DP en `Get the instruction set of the device`; `switch_1` y `switch_2` fueron observados en Device Debugging, pero hay que confirmar que son los códigos aceptados por `Send commands`.
5. Probar primero con el relé desconectado de electroválvulas o con una carga de prueba segura. El comando `OFF` no debe considerarse protección física garantizada si Internet o Tuya fallan.
6. Añadir autenticación de usuario, límites de frecuencia, registros persistentes y control de acceso antes de publicar en Internet. Este starter no implementa todavía login.

## Ejecutar localmente

Requiere Node.js 20 o superior.

```bash
npm install
cp .env.example .env
# Editar .env localmente, sin compartirlo ni subirlo a GitHub
npm start
```

Abrir `http://localhost:3000/api/health`.

## Ejemplos de prueba

Consultar zonas:

```bash
curl http://localhost:3000/api/zones
```

Consultar estado real de Tuya:

```bash
curl http://localhost:3000/api/device/status
```

Enviar OFF a zona 1 (no enciende agua):

```bash
curl -X POST http://localhost:3000/api/zones/1/command -H 'Content-Type: application/json' -d '{"on":false}'
```

Encender requiere una confirmación extra:

```bash
curl -X POST http://localhost:3000/api/zones/1/command -H 'Content-Type: application/json' -d '{"on":true,"confirm":"I_CONFIRM_WATERING"}'
```

No publiques este backend sin añadir autenticación y restricciones de acceso. No pongas credenciales Tuya en el HTML ni en una app APK.
