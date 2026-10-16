export function localScheduleParts(date = new Date(), timeZone = 'America/Argentina/Cordoba') {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit',
    hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  const days = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    day: days[values.weekday],
    time: values.hour + ':' + values.minute,
    date: values.year + '-' + values.month + '-' + values.day,
  };
}

export function isProgramDue(program, nowParts, nowMs = Date.now()) {
  if (!program || program.enabled !== true) return false;
  if (!Array.isArray(program.days) || !program.days.includes(nowParts.day)) return false;
  if (program.time !== nowParts.time) return false;
  if (program.delayUntil && Date.parse(program.delayUntil) > nowMs) return false;
  return true;
}

export function scheduleRunKey(program, nowParts) {
  return String(nowParts.date) + ' ' + String(program.id) + ' ' + String(program.time);
}

export function normalizeProgram(program, index) {
  const time = String(program?.time || '');
  if (!/^([01]\\d|2[0-3]):[0-5]\\d$/.test(time)) throw new Error('Hora inválida en programa ' + (index + 1));
  const days = Array.isArray(program.days)
    ? [...new Set(program.days.map(Number).filter(day => Number.isInteger(day) && day >= 0 && day <= 6))]
    : [];
  const durations = {};
  for (const id of [1, 2]) {
    const minutes = Number(program.durations?.[id] ?? 0);
    if (!Number.isFinite(minutes) || minutes < 0 || minutes > 240) throw new Error('Duración inválida en programa ' + (index + 1));
    durations[id] = Math.floor(minutes);
  }
  const delayUntil = program.delayUntil && Number.isFinite(Date.parse(program.delayUntil))
    ? new Date(program.delayUntil).toISOString() : null;
  return {
    id: Number(program.id) || index + 1,
    name: String(program.name || ('Programa ' + (index + 1))).slice(0, 80),
    time, days, durations, enabled: program.enabled === true, delayUntil,
  };
}
