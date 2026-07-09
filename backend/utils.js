// Normaliza texto: trim + colapsa espacios. Sirve para comparar gestores
// (en Airtable vienen con espacios finales: "Cesar ", "Romulo ").
export function normName(s) {
  if (s == null) return '';
  return String(s).replace(/\s+/g, ' ').trim();
}

// Un registro de Airtable puede tener varios rider IDs en el mismo campo:
// "4379207, 4558829". Devuelve la lista de IDs limpios (solo dígitos).
export function expandRiderIds(raw) {
  if (raw == null) return [];
  return String(raw)
    .replace(/\.0\b/g, '')
    .split(/[,;/]+/)
    .map((x) => x.trim())
    .filter((x) => /^\d+$/.test(x));
}

// Un solo rider id normalizado (para el CSV de horas, que trae uno por fila).
export function cleanId(raw) {
  if (raw == null) return '';
  const m = String(raw).match(/\d+/);
  return m ? m[0] : '';
}

// Convierte "40H", "30", "20 h" -> número. Devuelve null si no se puede.
export function parseHoras(raw) {
  if (raw == null || raw === '') return null;
  const m = String(raw).replace(',', '.').match(/[\d.]+/);
  return m ? parseFloat(m[0]) : null;
}

// Estado -> is_baja
export function isBaja(estado) {
  return /baja/i.test(String(estado || '')) ? 1 : 0;
}

// Clasifica una fila de horas contra la jornada esperada, aplicando ajustes.
// Tolerancia exacta: cualquier diferencia cuenta.
// horas_efectivas = trabajadas + perdonadas - descontadas
export function classify({ horasContrato, horasTrabajadas, descontadas = 0, perdonadas = 0 }) {
  if (horasContrato == null || horasTrabajadas == null) {
    return { estado: 'sin_datos', diff: null, efectivas: horasTrabajadas };
  }
  const efectivas = round2(horasTrabajadas + (perdonadas || 0) - (descontadas || 0));
  const diff = round2(efectivas - horasContrato);
  let estado;
  if (diff > 0) estado = 'extra';
  else if (diff < 0) estado = 'falta';
  else estado = 'ok';
  return { estado, diff, efectivas };
}

export function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
