# Riegos24 Smart Irrigation — plan de finalización

## Estado actual
- La interfaz web está publicada en Render.
- Los programas y el historial se guardan en Supabase.
- El backend consulta los horarios desde un proceso Node y envía órdenes a Tuya.
- El servicio de Render está en el plan Free; no debe considerarse un planificador 24/7 fiable.
- El estado de los ciclos y los temporizadores de autoapagado están en memoria del proceso; un reinicio puede interrumpirlos.

## Requisitos para producción
1. Ejecutar el planificador en un servicio siempre activo (sin suspensión por inactividad).
2. Persistir en Supabase el estado de cada ejecución: identificador, programa, zona, inicio, vencimiento, fase y resultado.
3. Al reiniciar, enviar OFF a ambas zonas, verificar el estado real y marcar cualquier ejecución anterior como interrumpida. No reanudar un ciclo automáticamente sin una política explícita y segura.
4. Usar operaciones idempotentes para impedir dobles ejecuciones si coinciden ticks del planificador o se reinicia el proceso.
5. Garantizar autoapagado con un mecanismo independiente del proceso web cuando el hardware lo permita; el temporizador de memoria no es suficiente.
6. Confirmar cada comando con lectura de estado Tuya; un comando aceptado no demuestra que el relé físico haya cambiado.
7. Si el pronóstico climático no está disponible, registrar el motivo y aplicar una política explícita de fallo seguro.
8. Añadir pruebas automatizadas para horarios, zona horaria, pausas climáticas, duplicados, reinicios, pérdida de Tuya/Supabase y duración de los ciclos.
9. Verificar en una prueba real controlada que cada zona encienda y se apague, con la aplicación cerrada, y revisar el historial.

## No cambiar sin confirmar
- Horarios y días ya guardados por el usuario.
- Duraciones por zona.
- Umbrales de lluvia y viento.
- Plan de alojamiento con coste mensual.

## Criterio de aceptación
No declarar el proyecto autónomo hasta comprobar un horario real con el teléfono desconectado, confirmación de OFF al terminar, persistencia del historial y comportamiento seguro tras reiniciar el servidor.