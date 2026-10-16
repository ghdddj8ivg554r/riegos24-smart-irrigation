# Riegos24 Smart Irrigation — plan de finalización

## Mejoras ya preparadas en la rama de trabajo
- Se extrajeron las funciones de horario y validación a un módulo comprobable.
- Se añadieron pruebas de zona horaria argentina, días/horas, pausas climáticas, clave de ejecución y validación de programas.
- Se añadió GitHub Actions para ejecutar las pruebas y verificar la sintaxis de `server.js`.
- Se impiden ejecuciones simultáneas del tick del planificador.
- Se creó la tabla aditiva `public.riegos24_runtime` en Supabase para guardar estado de ejecución.
- Los ciclos secuenciales guardan el estado de la zona activa y limpian el estado al terminar.
- Los autoapagados manuales guardan su vencimiento en Supabase y lo limpian al terminar.
- En el arranque, el servidor manda OFF a ambas zonas, identifica ejecuciones guardadas como interrumpidas, las cancela sin reanudar a ciegas y deja registro.
- El planificador espera a que termine la recuperación inicial antes de procesar horarios.
- El endpoint de salud informa si la recuperación de arranque terminó, la zona horaria y el almacenamiento de estado.

## Estado actual de producción
- La rama `main` y el servicio activo de Render no se modificaron con estos cambios; están en una rama y un PR de borrador.
- La primera ejecución de pruebas unitarias terminó correctamente. La verificación de sintaxis está añadida a CI y debe confirmarse en la última revisión.
- Los programas y el historial siguen almacenándose en Supabase.
- El servicio de Render está en el plan Free; puede suspenderse o reiniciarse y no debe considerarse un planificador 24/7 fiable.
- El autoapagado cloud sigue dependiendo del proceso. Guardar el vencimiento ayuda a detectar interrupciones, pero no puede apagar una válvula mientras el servidor está caído.
- Los relés siguen dependiendo de Tuya Cloud. No se ha verificado que estos modelos permitan control local sin Internet.

## Pendiente antes de producción
1. Elegir alojamiento realmente disponible 24/7 sin asumir un coste sin autorización. Alternativa alineada con el objetivo de autonomía local: evaluar Home Assistant en la notebook disponible y comprobar la compatibilidad local real de los relés antes de depender de ello.
2. Revisar y probar el orden de persistencia del temporizador manual y todos los casos de fallo de Tuya/Supabase.
3. Añadir pruebas automatizadas para reinicios, pérdidas de conexión, pausas climáticas, duplicados y duración de los ciclos.
4. Definir una política segura para temporizadores vencidos y riegos interrumpidos; no reanudar automáticamente un ciclo sin comprobar estado físico.
5. Garantizar autoapagado independiente del servidor cuando el hardware lo permita.
6. Ejecutar una prueba real controlada de cada zona, con la aplicación cerrada, y revisar el historial.
7. No modificar horarios, días, duraciones ni umbrales climáticos guardados sin autorización.

## Criterio de aceptación
No declarar el proyecto autónomo hasta comprobar un horario real con el teléfono desconectado, confirmación del apagado, historial persistente y comportamiento seguro tras reiniciar el servidor y perder Internet.
