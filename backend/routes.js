import express from 'express';
import multer from 'multer';
import db from './db.js';
import { requireAuth, requireAdmin, hashPassword } from './auth.js';
import { importHours } from './importer.js';
import { syncPersonalFromAirtable, airtableConfigured, lastSync, getSyncLog } from './airtable.js';
import { classify, normName } from './utils.js';

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

// Todas las rutas requieren estar autenticado.
router.use(requireAuth);

// ---- Semanas ----

// Lista de semanas cargadas (para el selector).
router.get('/weeks', (req, res) => {
  const weeks = db
    .prepare('SELECT id, label, date_from, date_to, filename, created_at FROM weeks ORDER BY date_from DESC')
    .all();
  res.json(weeks);
});

// ---- Carga de CSVs (solo admin) ----

// Estado de la conexión con Airtable (configurado + última sincronización).
router.get('/airtable/status', requireAdmin, (req, res) => {
  res.json({ configured: airtableConfigured(), last_sync: lastSync() });
});

// Sincroniza el personal DIRECTO desde Airtable (solo lectura). Botón "Sincronizar".
router.post('/airtable/sync', requireAdmin, async (req, res) => {
  if (!airtableConfigured())
    return res.status(400).json({ error: 'Airtable no está configurado. Completá token, base ID y tabla en el .env.' });
  try {
    const result = await syncPersonalFromAirtable({ id: req.user.id, email: req.user.email });
    res.json({ ok: true, ...result, last_sync: lastSync() });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// Historial (log) de sincronizaciones.
router.get('/airtable/log', requireAdmin, (req, res) => {
  res.json(getSyncLog(50));
});

// Importa el CSV de horas semanales. Requiere rango de fechas.
router.post('/import/hours', requireAdmin, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Falta el archivo CSV' });
  const { date_from, date_to, label } = req.body;
  if (!date_from || !date_to)
    return res.status(400).json({ error: 'Indicá date_from y date_to (de qué día a qué día)' });
  try {
    const result = importHours(req.file.buffer, {
      label,
      dateFrom: date_from,
      dateTo: date_to,
      filename: req.file.originalname,
      userId: req.user.id,
    });
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(400).json({ error: 'Error importando horas: ' + e.message });
  }
});

// ---- Filas de una semana (vista principal) ----

// Devuelve, para una semana, cada rider con su ficha, clasificación y ajustes.
// Aplica scoping por rol: gestor solo ve los suyos.
// Filtros: ?filter=extra|falta|ok|sin_ficha|baja|all  &  ?q=texto
router.get('/weeks/:weekId/rows', (req, res) => {
  const weekId = parseInt(req.params.weekId, 10);
  const result = buildWeekRows(weekId, req.user, { filter: req.query.filter, q: req.query.q });
  if (!result) return res.status(404).json({ error: 'Semana no encontrada' });
  res.json(result);
});

// Construye las filas de una semana (con clasificación, ajustes, scoping y filtros).
// Reutilizado por la vista y por el export CSV.
function buildWeekRows(weekId, user, { filter = 'all', q = '' } = {}) {
  const week = db.prepare('SELECT * FROM weeks WHERE id = ?').get(weekId);
  if (!week) return null;

  const rows = db
    .prepare(
      `SELECT h.rider_id, h.nombre_csv, h.h_trabajadas, h.h_contrato AS h_contrato_csv,
              h.ciudad, h.total_pedidos, h.incentivo_total,
              w.nombre, w.gestor, w.email, w.region, w.vehiculo, w.estado,
              w.horas_contrato, w.is_baja,
              a.horas_descontadas, a.horas_perdonadas, a.justificacion, a.updated_at AS ajuste_at
       FROM hours h
       LEFT JOIN workers w ON w.rider_id = h.rider_id
       LEFT JOIN adjustments a ON a.week_id = h.week_id AND a.rider_id = h.rider_id
       WHERE h.week_id = ?`
    )
    .all(weekId);

  const isAdmin = user.role === 'admin';
  const myGestor = normName(user.gestor_name);

  const enriched = [];
  for (const r of rows) {
    const tieneFicha = r.nombre != null;
    // Scoping: el gestor solo ve trabajadores cuyo campo 'gestor' == su nombre.
    if (!isAdmin) {
      if (!tieneFicha) continue;
      if (normName(r.gestor) !== myGestor) continue;
    }

    // Jornada esperada: usa la de Airtable; si no hay ficha, cae a la del CSV.
    const jornada = r.horas_contrato ?? r.h_contrato_csv;
    const desc = r.horas_descontadas || 0;
    const perd = r.horas_perdonadas || 0;
    const cls = classify({
      horasContrato: jornada,
      horasTrabajadas: r.h_trabajadas,
      descontadas: desc,
      perdonadas: perd,
    });

    let estado = tieneFicha ? cls.estado : 'sin_ficha';

    enriched.push({
      rider_id: r.rider_id,
      nombre: r.nombre || r.nombre_csv,
      gestor: r.gestor,
      email: r.email,
      region: r.region,
      ciudad: r.ciudad,
      vehiculo: r.vehiculo,
      estado_trabajador: r.estado,
      is_baja: !!r.is_baja,
      tiene_ficha: tieneFicha,
      jornada,
      h_trabajadas: r.h_trabajadas,
      horas_descontadas: desc,
      horas_perdonadas: perd,
      horas_efectivas: cls.efectivas,
      diff: cls.diff,
      clasificacion: estado, // extra | falta | ok | sin_ficha | sin_datos
      justificacion: r.justificacion || '',
      total_pedidos: r.total_pedidos,
      incentivo_total: r.incentivo_total,
    });
  }

  // Agregar a los que están en Airtable (activos) pero NO en el CSV de horas:
  // aparecen con 0 horas y categoría "no_trabajo".
  const idsEnHoras = new Set(rows.map((r) => String(r.rider_id)));
  const workersActivos = db
    .prepare(
      `SELECT rider_id, nombre, gestor, email, region, vehiculo, estado, horas_contrato, is_baja
       FROM workers
       WHERE is_baja = 0`
    )
    .all();

  for (const w of workersActivos) {
    if (idsEnHoras.has(String(w.rider_id))) continue; // ya está (trabajó)
    // Scoping: el gestor solo ve los suyos.
    if (!isAdmin && normName(w.gestor) !== myGestor) continue;

    enriched.push({
      rider_id: w.rider_id,
      nombre: w.nombre,
      gestor: w.gestor,
      email: w.email,
      region: w.region,
      ciudad: w.region, // no hay ciudad de CSV; usamos la región de Airtable
      vehiculo: w.vehiculo,
      estado_trabajador: w.estado,
      is_baja: !!w.is_baja,
      tiene_ficha: true,
      jornada: w.horas_contrato,
      h_trabajadas: 0,
      horas_descontadas: 0,
      horas_perdonadas: 0,
      horas_efectivas: 0,
      diff: w.horas_contrato != null ? -w.horas_contrato : null,
      clasificacion: 'no_trabajo',
      justificacion: '',
      total_pedidos: null,
      incentivo_total: null,
    });
  }

  // Filtro por categoría
  const f = (filter || 'all').toLowerCase();
  let filtered = enriched;
  if (f === 'extra') filtered = enriched.filter((x) => x.clasificacion === 'extra');
  else if (f === 'falta') filtered = enriched.filter((x) => x.clasificacion === 'falta');
  else if (f === 'ok') filtered = enriched.filter((x) => x.clasificacion === 'ok');
  else if (f === 'no_trabajo') filtered = enriched.filter((x) => x.clasificacion === 'no_trabajo');
  else if (f === 'sin_ficha') filtered = enriched.filter((x) => !x.tiene_ficha);
  else if (f === 'baja') filtered = enriched.filter((x) => x.is_baja);

  // Búsqueda por texto (nombre o rider id)
  const query = (q || '').toLowerCase().trim();
  if (query) {
    filtered = filtered.filter(
      (x) =>
        (x.nombre || '').toLowerCase().includes(query) ||
        String(x.rider_id).includes(query)
    );
  }

  const summary = {
    total: enriched.length,
    extra: enriched.filter((x) => x.clasificacion === 'extra').length,
    falta: enriched.filter((x) => x.clasificacion === 'falta').length,
    ok: enriched.filter((x) => x.clasificacion === 'ok').length,
    no_trabajo: enriched.filter((x) => x.clasificacion === 'no_trabajo').length,
    sin_ficha: enriched.filter((x) => !x.tiene_ficha).length,
    baja: enriched.filter((x) => x.is_baja).length,
  };

  return { week, summary, rows: filtered };
}

// Convierte filas a CSV. headers = [[clave, etiqueta], ...]
function toCsv(headers, rows) {
  const esc = (v) => {
    if (v == null) return '';
    const s = String(v);
    return /[";,\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const head = headers.map((h) => esc(h[1])).join(',');
  const body = rows
    .map((r) => headers.map((h) => esc(r[h[0]])).join(','))
    .join('\n');
  // BOM para que Excel abra bien los acentos.
  return '\uFEFF' + head + '\n' + body + '\n';
}

// Export CSV de las HORAS de una semana (respeta filtro de gestor/categoría y scoping).
router.get('/weeks/:weekId/export', (req, res) => {
  const weekId = parseInt(req.params.weekId, 10);
  const result = buildWeekRows(weekId, req.user, { filter: req.query.filter, q: req.query.q });
  if (!result) return res.status(404).json({ error: 'Semana no encontrada' });

  const headers = [
    ['rider_id', 'Rider ID'],
    ['nombre', 'Nombre'],
    ['gestor', 'Gestor'],
    ['ciudad', 'Ciudad'],
    ['jornada', 'Jornada'],
    ['h_trabajadas', 'Horas trabajadas'],
    ['horas_descontadas', 'Horas descontadas'],
    ['horas_perdonadas', 'Horas perdonadas'],
    ['horas_efectivas', 'Horas efectivas'],
    ['diff', 'Diferencia'],
    ['clasificacion', 'Estado'],
    ['justificacion', 'Justificación'],
    ['estado_trabajador', 'Estado trabajador'],
  ];
  const csv = toCsv(headers, result.rows);
  const gestorTag = req.query.filter && req.query.filter !== 'all' ? '_' + req.query.filter : '';
  const fname = `horas_${result.week.date_from}_a_${result.week.date_to}${gestorTag}.csv`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
  res.send(csv);
});

// ---- Ajustes (justificar / descontar / perdonar) ----

// Guarda o actualiza el ajuste de un rider en una semana.
// Gestores solo pueden ajustar a sus propios trabajadores.
router.put('/weeks/:weekId/rows/:riderId/adjust', (req, res) => {
  const weekId = parseInt(req.params.weekId, 10);
  const riderId = String(req.params.riderId);
  const { horas_descontadas = 0, horas_perdonadas = 0, justificacion = '' } = req.body;

  // Validación de permisos: gestor solo su gente.
  if (req.user.role !== 'admin') {
    const w = db.prepare('SELECT gestor FROM workers WHERE rider_id = ?').get(riderId);
    if (!w || normName(w.gestor) !== normName(req.user.gestor_name)) {
      return res.status(403).json({ error: 'No podés ajustar a este trabajador' });
    }
  }

  const desc = Math.max(0, parseFloat(horas_descontadas) || 0);
  const perd = Math.max(0, parseFloat(horas_perdonadas) || 0);

  db.prepare(
    `INSERT INTO adjustments (week_id, rider_id, horas_descontadas, horas_perdonadas, justificacion, updated_by, updated_at)
     VALUES (@week_id, @rider_id, @desc, @perd, @just, @uid, datetime('now'))
     ON CONFLICT(week_id, rider_id) DO UPDATE SET
       horas_descontadas=excluded.horas_descontadas,
       horas_perdonadas=excluded.horas_perdonadas,
       justificacion=excluded.justificacion,
       updated_by=excluded.updated_by,
       updated_at=datetime('now')`
  ).run({ week_id: weekId, rider_id: riderId, desc, perd, just: justificacion, uid: req.user.id });

  res.json({ ok: true });
});

// ---- Apartado de Riders (personal de Airtable, independiente de la semana) ----

// Devuelve los riders con filtros combinables. Scoping: gestor solo los suyos.
// Query params (todos opcionales):
//   q         -> busca por Rider ID o nombre
//   ciudad    -> región/ciudad exacta (regionPersonal)
//   jornada   -> horas de contrato exactas (10,20,30,40)
//   estado    -> estado del trabajador (ALTA, BAJA MEDICA, ...)
//   cuenta    -> Activo | Inactivo
router.get('/riders', (req, res) => {
  const isAdmin = req.user.role === 'admin';
  const rows = queryRiders(req.user, req.query);
  const scopeParams = isAdmin ? {} : { myGestor: normName(req.user.gestor_name) };
  res.json({
    total: rows.length,
    rows,
    filtros: {
      ciudades: distinctCol('region', isAdmin, scopeParams),
      jornadas: distinctCol('horas_contrato', isAdmin, scopeParams),
      estados: distinctCol('estado', isAdmin, scopeParams),
      cuentas: distinctCol('estado_cuenta', isAdmin, scopeParams),
    },
  });
});

// Consulta de riders con filtros y scoping. Reutilizada por la vista y el export.
function queryRiders(user, query = {}) {
  const isAdmin = user.role === 'admin';
  const conds = [];
  const params = {};
  if (!isAdmin) {
    conds.push('gestor = @myGestor');
    params.myGestor = normName(user.gestor_name);
  }
  if (query.ciudad) { conds.push('region = @ciudad'); params.ciudad = query.ciudad; }
  if (query.jornada) { conds.push('horas_contrato = @jornada'); params.jornada = parseFloat(query.jornada); }
  if (query.estado) { conds.push('estado = @estado'); params.estado = query.estado; }
  if (query.cuenta) { conds.push('estado_cuenta = @cuenta'); params.cuenta = query.cuenta; }
  if (query.q) {
    conds.push('(rider_id LIKE @q OR upper(nombre) LIKE upper(@q))');
    params.q = '%' + String(query.q).trim() + '%';
  }
  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
  return db
    .prepare(
      `SELECT rider_id, nombre, gestor, email, region AS ciudad, vehiculo,
              estado, estado_cuenta, horas_contrato, is_baja
       FROM workers ${where}
       ORDER BY nombre`
    )
    .all(params);
}

// Export CSV de la base de riders (las 2 bases juntas). Respeta filtros y scoping.
router.get('/riders/export', (req, res) => {
  const rows = queryRiders(req.user, req.query);
  const headers = [
    ['rider_id', 'Rider ID'],
    ['nombre', 'Nombre'],
    ['gestor', 'Gestor'],
    ['ciudad', 'Ciudad'],
    ['horas_contrato', 'Jornada'],
    ['estado', 'Estado trabajador'],
    ['estado_cuenta', 'Estado cuenta'],
    ['vehiculo', 'Vehículo'],
    ['email', 'Email'],
  ];
  const csv = toCsv(headers, rows);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="riders.csv"');
  res.send(csv);
});

// Helper: valores distintos de una columna, respetando el scope del gestor.
function distinctCol(col, isAdmin, scopeParams) {
  const where = isAdmin
    ? `WHERE ${col} IS NOT NULL AND ${col} <> ''`
    : `WHERE gestor = @myGestor AND ${col} IS NOT NULL AND ${col} <> ''`;
  return db.prepare(`SELECT DISTINCT ${col} v FROM workers ${where} ORDER BY ${col}`)
    .all(scopeParams).map((r) => r.v);
}

// ---- Gestión de usuarios (solo admin) ----

// Lista de gestores disponibles (nombres del campo 'gestor' en Airtable).
router.get('/gestores', requireAdmin, (req, res) => {
  const rows = db
    .prepare(`SELECT DISTINCT gestor FROM workers WHERE gestor IS NOT NULL AND gestor <> '' ORDER BY gestor`)
    .all();
  res.json(rows.map((r) => r.gestor));
});

// Lista de usuarios del sistema.
router.get('/users', requireAdmin, (req, res) => {
  const users = db
    .prepare('SELECT id, email, role, gestor_name, display_name, active, created_at FROM users ORDER BY role, email')
    .all();
  res.json(users);
});

// Crea un usuario (gestor u otro admin). Asigna nombre de gestor (de Airtable) al correo.
router.post('/users', requireAdmin, (req, res) => {
  const { email, password, role = 'gestor', gestor_name, display_name } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email y contraseña requeridos' });
  if (!['admin', 'gestor'].includes(role)) return res.status(400).json({ error: 'Rol inválido' });
  if (role === 'gestor' && !gestor_name)
    return res.status(400).json({ error: 'Un gestor necesita gestor_name (nombre de Airtable)' });

  try {
    const info = db
      .prepare(
        `INSERT INTO users (email, password_hash, role, gestor_name, display_name)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(email, hashPassword(password), role, role === 'gestor' ? normName(gestor_name) : null, display_name || null);
    res.json({ ok: true, id: info.lastInsertRowid });
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return res.status(409).json({ error: 'Ese email ya existe' });
    res.status(400).json({ error: e.message });
  }
});

// Edita rol / gestor / activo / contraseña de un usuario.
router.put('/users/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { role, gestor_name, display_name, active, password } = req.body;
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!u) return res.status(404).json({ error: 'Usuario no encontrado' });

  const newRole = role || u.role;
  const newActive = active != null ? (active ? 1 : 0) : u.active;

  // Protección: no quedarse sin ningún admin activo.
  const activeAdmins = db
    .prepare("SELECT count(*) c FROM users WHERE role='admin' AND active=1")
    .get().c;
  const wasActiveAdmin = u.role === 'admin' && u.active === 1;
  const staysActiveAdmin = newRole === 'admin' && newActive === 1;
  if (wasActiveAdmin && !staysActiveAdmin && activeAdmins <= 1) {
    return res.status(400).json({ error: 'No podés dejar el sistema sin ningún admin activo.' });
  }

  // Protección: no desactivarte ni quitarte admin a vos mismo.
  if (id === req.user.id && (newActive === 0 || newRole !== 'admin')) {
    return res.status(400).json({ error: 'No podés desactivarte ni cambiarte el rol a vos mismo.' });
  }

  db.prepare(
    `UPDATE users SET
       role = ?,
       gestor_name = ?,
       display_name = ?,
       active = ?,
       password_hash = ?
     WHERE id = ?`
  ).run(
    newRole,
    newRole === 'gestor' ? normName(gestor_name ?? u.gestor_name) : null,
    display_name ?? u.display_name,
    newActive,
    password ? hashPassword(password) : u.password_hash,
    id
  );
  res.json({ ok: true });
});

// Elimina un usuario. No podés borrarte a vos mismo ni al último admin.
router.delete('/users/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!u) return res.status(404).json({ error: 'Usuario no encontrado' });

  if (id === req.user.id) {
    return res.status(400).json({ error: 'No podés eliminar tu propio usuario.' });
  }
  if (u.role === 'admin') {
    const admins = db.prepare("SELECT count(*) c FROM users WHERE role='admin'").get().c;
    if (admins <= 1) return res.status(400).json({ error: 'No podés eliminar al último admin.' });
  }

  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  res.json({ ok: true });
});

export default router;
