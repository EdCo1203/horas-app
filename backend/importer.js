import { parse } from 'csv-parse/sync';
import db from './db.js';
import {
  normName,
  expandRiderIds,
  cleanId,
  parseHoras,
  isBaja,
} from './utils.js';

// Detecta separador (Airtable exporta con coma; el CSV de incentivos con ';').
function detectDelimiter(text) {
  const firstLine = text.split(/\r?\n/)[0] || '';
  return firstLine.split(';').length > firstLine.split(',').length ? ';' : ',';
}

function parseCsv(buffer) {
  // Quitar BOM (Airtable/Excel lo agregan y rompe el nombre de la 1ª columna).
  const text = buffer.toString('utf8').replace(/^\uFEFF/, '');
  const delimiter = detectDelimiter(text);
  return parse(text, {
    delimiter,
    columns: true,
    skip_empty_lines: true,
    relax_quotes: true,
    relax_column_count: true,
    trim: true,
  });
}

/**
 * Importa el CSV de personal exportado de Airtable (Personal-GENERAL.csv).
 * Hace upsert por cada rider_id (expandiendo los registros con varios IDs).
 * Devuelve { total, riders }.
 */
export function importPersonal(buffer) {
  const rows = parseCsv(buffer);
  const upsert = db.prepare(`
    INSERT INTO workers (rider_id, nombre, gestor, email, region, vehiculo, estado, horas_contrato, is_baja, updated_at)
    VALUES (@rider_id, @nombre, @gestor, @email, @region, @vehiculo, @estado, @horas_contrato, @is_baja, datetime('now'))
    ON CONFLICT(rider_id) DO UPDATE SET
      nombre=excluded.nombre, gestor=excluded.gestor, email=excluded.email,
      region=excluded.region, vehiculo=excluded.vehiculo, estado=excluded.estado,
      horas_contrato=excluded.horas_contrato, is_baja=excluded.is_baja,
      updated_at=datetime('now')
  `);

  let riders = 0;
  const tx = db.transaction((records) => {
    for (const r of records) {
      const ids = expandRiderIds(r.RIDERID);
      if (ids.length === 0) continue; // sin rider id no podemos cruzar
      const horas =
        parseHoras(r.hrsDeContratoNum) ?? parseHoras(r.horasDeContrato);
      for (const id of ids) {
        upsert.run({
          rider_id: id,
          nombre: r.nombreCompleto || null,
          gestor: normName(r.gestor) || null,
          email: r.email || null,
          region: r.region || null,
          vehiculo: r.vehiculo || null,
          estado: r.estadoDelTrabajador || null,
          horas_contrato: horas,
          is_baja: isBaja(r.estadoDelTrabajador),
        });
        riders++;
      }
    }
  });
  tx(rows);
  return { total: rows.length, riders };
}

/**
 * Importa el CSV de horas semanales (Arendel_-_Incentivos_Wxx.csv).
 * Requiere date_from y date_to (indicados por el usuario al subir).
 * Crea/actualiza la semana y sus filas de horas.
 * Devuelve { weekId, filas, cruzados, sinFicha }.
 */
export function importHours(buffer, { label, dateFrom, dateTo, filename, userId }) {
  const rows = parseCsv(buffer);

  const weekStmt = db.prepare(`
    INSERT INTO weeks (label, date_from, date_to, filename, uploaded_by)
    VALUES (@label, @date_from, @date_to, @filename, @uploaded_by)
    ON CONFLICT(date_from, date_to) DO UPDATE SET
      label=excluded.label, filename=excluded.filename, uploaded_by=excluded.uploaded_by
    RETURNING id
  `);
  const week = weekStmt.get({
    label: label || null,
    date_from: dateFrom,
    date_to: dateTo,
    filename: filename || null,
    uploaded_by: userId || null,
  });
  const weekId = week.id;

  // Limpiamos horas previas de esa semana para reemplazar por la carga nueva.
  db.prepare('DELETE FROM hours WHERE week_id = ?').run(weekId);

  const ins = db.prepare(`
    INSERT INTO hours (week_id, rider_id, nombre_csv, h_contrato, h_trabajadas, ciudad, total_pedidos, incentivo_total)
    VALUES (@week_id, @rider_id, @nombre_csv, @h_contrato, @h_trabajadas, @ciudad, @total_pedidos, @incentivo_total)
    ON CONFLICT(week_id, rider_id) DO UPDATE SET
      nombre_csv=excluded.nombre_csv, h_contrato=excluded.h_contrato,
      h_trabajadas=excluded.h_trabajadas, ciudad=excluded.ciudad,
      total_pedidos=excluded.total_pedidos, incentivo_total=excluded.incentivo_total
  `);

  const hasFicha = db.prepare('SELECT 1 FROM workers WHERE rider_id = ?');
  let cruzados = 0;
  let sinFicha = 0;

  const tx = db.transaction((records) => {
    for (const r of records) {
      const rid = cleanId(r['Rider ID']);
      if (!rid) continue;
      ins.run({
        week_id: weekId,
        rider_id: rid,
        nombre_csv: r['Nombre'] || null,
        h_contrato: parseHoras(r['H. Contrato']),
        h_trabajadas: parseHoras(r['H. Trabajadas']),
        ciudad: r['Ciudad'] || null,
        total_pedidos: parseInt(r['Total Pedidos'], 10) || null,
        incentivo_total: parseHoras(r['Incentivo Total €']),
      });
      if (hasFicha.get(rid)) cruzados++;
      else sinFicha++;
    }
  });
  tx(rows);

  return { weekId, filas: rows.length, cruzados, sinFicha };
}
