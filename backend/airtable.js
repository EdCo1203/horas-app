import db from './db.js';
import { normName, expandRiderIds, parseHoras, isBaja } from './utils.js';

const AIRTABLE_API = 'https://api.airtable.com/v0';

// Devuelve la lista de bases configuradas. La primera usa las variables
// AIRTABLE_TOKEN / AIRTABLE_BASE_ID / AIRTABLE_TABLE / AIRTABLE_VIEW.
// Las siguientes usan el sufijo _2, _3, … (ej. AIRTABLE_BASE_ID_2).
// Si una base no define su propio token o tabla, hereda los de la primera.
function bases() {
  const baseToken = process.env.AIRTABLE_TOKEN;
  const baseTable = process.env.AIRTABLE_TABLE || 'Cuentas de Glovo';
  const list = [];

  // Base principal
  if (process.env.AIRTABLE_BASE_ID) {
    list.push({
      token: baseToken,
      baseId: process.env.AIRTABLE_BASE_ID,
      table: baseTable,
      view: process.env.AIRTABLE_VIEW || '',
      gestorFijo: process.env.AIRTABLE_GESTOR || '',
    });
  }

  // Bases adicionales: _2, _3, … (hasta 9)
  for (let i = 2; i <= 9; i++) {
    const baseId = process.env[`AIRTABLE_BASE_ID_${i}`];
    if (!baseId) continue;
    list.push({
      token: process.env[`AIRTABLE_TOKEN_${i}`] || baseToken,
      baseId,
      table: process.env[`AIRTABLE_TABLE_${i}`] || baseTable,
      view: process.env[`AIRTABLE_VIEW_${i}`] || '',
      gestorFijo: process.env[`AIRTABLE_GESTOR_${i}`] || '',
    });
  }

  return list;
}

// ¿Está configurado Airtable? (al menos una base con token, baseId y tabla)
export function airtableConfigured() {
  return bases().some((b) => b.token && b.baseId && b.table);
}

// Trae todos los registros de UNA base (con paginación).
async function fetchRecordsFromBase(c) {
  const records = [];
  let offset;
  const base = `${AIRTABLE_API}/${c.baseId}/${encodeURIComponent(c.table)}`;

  do {
    const url = new URL(base);
    url.searchParams.set('pageSize', '100');
    if (c.view) url.searchParams.set('view', c.view);
    if (offset) url.searchParams.set('offset', offset);

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${c.token}` },
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const donde = `(base ${c.baseId})`;
      if (res.status === 401) throw new Error(`Airtable: token inválido o sin permisos (401) ${donde}.`);
      if (res.status === 403) throw new Error(`Airtable: el token no tiene acceso a esta base (403) ${donde}.`);
      if (res.status === 404) throw new Error(`Airtable: base, tabla o vista no encontrada (404) ${donde}. Revisá los nombres en .env.`);
      if (res.status === 429) throw new Error('Airtable: demasiadas peticiones (429). Esperá unos segundos y reintentá.');
      throw new Error(`Airtable respondió ${res.status} ${donde}: ${body.slice(0, 200)}`);
    }

    const data = await res.json();
    records.push(...data.records);
    offset = data.offset;
  } while (offset);

  return records;
}

// Trae los registros de TODAS las bases configuradas y los junta.
async function fetchAllRecords() {
  const list = bases();
  if (list.length === 0) {
    throw new Error('Falta configuración de Airtable en .env (token, base ID o tabla).');
  }
  const all = [];
  for (const c of list) {
    if (!c.token || !c.baseId || !c.table) continue;
    const recs = await fetchRecordsFromBase(c);
    // Adjuntamos la config de la base a cada registro (para el gestor fijo).
    for (const r of recs) r.__base = c;
    all.push(...recs);
  }
  return all;
}

// Mapea un registro de Airtable (tabla "Cuentas de Glovo") a la forma de workers.
// Tolera nombres de campo alternativos por si la base varía ligeramente.
function mapRecord(fields, baseCfg = {}) {
  const pick = (...keys) => {
    for (const k of keys) {
      if (fields[k] != null && fields[k] !== '') return fields[k];
    }
    return null;
  };

  // Airtable puede devolver campos como objetos o arrays (colaborador, adjunto,
  // lookup, múltiple, fórmula…). SQLite solo acepta texto/número/null, así que
  // aplanamos cualquier valor no escalar a texto plano.
  const toText = (v) => {
    if (v == null) return null;
    if (typeof v === 'string') return v;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    if (Array.isArray(v)) {
      const parts = v.map((x) => toText(x)).filter((x) => x != null && x !== '');
      return parts.length ? parts.join(', ') : null;
    }
    if (typeof v === 'object') {
      // Formas típicas de Airtable: {name}, {email}, {url}, {label}, {text}, {filename}
      return v.email || v.name || v.text || v.label || v.url || v.filename || null;
    }
    return null;
  };

  const riderRaw = pick('riderId', 'RIDERID', 'Rider ID', 'RiderId');
  const nombre = pick('personal', 'Personal', 'nombreCompleto', 'Nombre');
  const gestorCampo = pick('gestorPersonal', 'gestor', 'Gestor');
  const email = pick('email', 'Email');
  const region = pick('regionPersonal', 'region', 'Region');
  const vehiculo = pick('vehiculo', 'vehiculos', 'vehiculoDeCuenta', 'vehiculoDeContrato', 'vehiculoDeLaCuenta', 'Vehiculo');
  const estadoTrab = pick('estadoDelTrabajador', 'estadoDeLaPersona', 'estado');
  const estadoCuenta = pick('estadoDeLaCuenta');
  const horas = parseHoras(toText(pick('hrsDeContratoNum', 'HORASNUMERICAS', 'hrsDeContrato', 'horasDeContrato')));

  // Gestor: usa el campo si existe; si no, el gestor fijo de la base (para bases
  // que no traen gestor, como las de otras ciudades).
  const gestorText = normName(toText(gestorCampo));
  const gestor = gestorText || normName(baseCfg.gestorFijo) || null;

  return {
    riderIds: expandRiderIds(toText(riderRaw)),
    nombre: toText(nombre),
    gestor,
    email: toText(email),
    region: toText(region),
    vehiculo: toText(vehiculo),
    estado: toText(estadoTrab),
    estado_cuenta: toText(estadoCuenta),
    horas_contrato: horas,
    is_baja: isBaja(toText(estadoTrab)),
  };
}

/**
 * Sincroniza el personal desde Airtable a la tabla local `workers`.
 * Solo lectura de Airtable. Registra cada intento en sync_log (éxito o error).
 * Devuelve { registros, riders }.
 */
export async function syncPersonalFromAirtable(user = {}) {
  const logResult = (ok, registros, riders, mensaje) => {
    db.prepare(
      `INSERT INTO sync_log (ok, registros, riders, mensaje, user_id, user_email)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(ok ? 1 : 0, registros ?? null, riders ?? null, mensaje ?? null, user.id ?? null, user.email ?? null);
  };

  let records;
  try {
    records = await fetchAllRecords();
  } catch (e) {
    logResult(false, null, null, e.message);
    throw e;
  }

  const upsert = db.prepare(`
    INSERT INTO workers (rider_id, nombre, gestor, email, region, vehiculo, estado, estado_cuenta, horas_contrato, is_baja, updated_at)
    VALUES (@rider_id, @nombre, @gestor, @email, @region, @vehiculo, @estado, @estado_cuenta, @horas_contrato, @is_baja, datetime('now'))
    ON CONFLICT(rider_id) DO UPDATE SET
      nombre=excluded.nombre, gestor=excluded.gestor, email=excluded.email,
      region=excluded.region, vehiculo=excluded.vehiculo, estado=excluded.estado,
      estado_cuenta=excluded.estado_cuenta, horas_contrato=excluded.horas_contrato,
      is_baja=excluded.is_baja, updated_at=datetime('now')
  `);

  let riders = 0;
  try {
    const tx = db.transaction((recs) => {
      for (const rec of recs) {
        const m = mapRecord(rec.fields || {}, rec.__base || {});
        if (m.riderIds.length === 0) continue;
        for (const id of m.riderIds) {
          upsert.run({
            rider_id: id,
            nombre: m.nombre,
            gestor: m.gestor,
            email: m.email,
            region: m.region,
            vehiculo: m.vehiculo,
            estado: m.estado,
            estado_cuenta: m.estado_cuenta,
            horas_contrato: m.horas_contrato,
            is_baja: m.is_baja,
          });
          riders++;
        }
      }
    });
    tx(records);
  } catch (e) {
    logResult(false, records.length, riders, 'Error guardando: ' + e.message);
    throw e;
  }

  // Registrar la fecha de la última sincronización.
  db.prepare(
    `INSERT INTO meta (key, value) VALUES ('last_sync', datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value=datetime('now')`
  ).run();

  logResult(true, records.length, riders, `${riders} riders desde ${records.length} registros`);

  return { registros: records.length, riders };
}

// Devuelve el historial de sincronizaciones (más recientes primero).
export function getSyncLog(limit = 50) {
  return db
    .prepare('SELECT id, started_at, ok, registros, riders, mensaje, user_email FROM sync_log ORDER BY id DESC LIMIT ?')
    .all(limit);
}

export function lastSync() {
  const row = db.prepare(`SELECT value FROM meta WHERE key='last_sync'`).get();
  return row ? row.value : null;
}
