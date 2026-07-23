import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = path.join(DATA_DIR, 'horas.db');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

/**
 * Esquema:
 *
 * users          -> personas que hacen login. role = 'admin' | 'gestor'.
 *                   gestor_name = nombre tal como aparece en el campo 'gestor' de Airtable
 *                   (para gestores). Los admin ven todo.
 *
 * workers        -> ficha de cada trabajador, importada del CSV de Airtable (Personal-GENERAL).
 *                   Se refresca en cada importación (upsert por rider_id).
 *
 * weeks          -> cada carga semanal del CSV de horas. Guarda el rango de fechas indicado.
 *
 * hours          -> horas trabajadas por rider en una semana concreta (del CSV de incentivos).
 *
 * adjustments    -> justificaciones y ajustes que hace el gestor/admin sobre una fila
 *                   (semana + rider): horas descontadas, horas perdonadas y nota.
 */

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('admin','gestor')),
  gestor_name   TEXT,               -- nombre del gestor (coincide con campo 'gestor' de Airtable)
  display_name  TEXT,
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS workers (
  rider_id        TEXT PRIMARY KEY,
  nombre          TEXT,
  gestor          TEXT,             -- normalizado (trim)
  email           TEXT,
  region          TEXT,
  vehiculo        TEXT,
  estado          TEXT,             -- ALTA / BAJA (...) etc.
  estado_cuenta   TEXT,             -- Activo / Inactivo (estado de la cuenta de Glovo)
  horas_contrato  REAL,            -- hrsDeContratoNum
  is_baja         INTEGER NOT NULL DEFAULT 0,
  en_airtable     INTEGER NOT NULL DEFAULT 1,   -- 1 = vino en la última sync, 0 = ya no está en Airtable
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_workers_gestor ON workers(gestor);

CREATE TABLE IF NOT EXISTS weeks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  label       TEXT,                 -- ej. "W26" o lo que escriba el usuario
  date_from   TEXT NOT NULL,        -- YYYY-MM-DD (día indicado por el usuario)
  date_to     TEXT NOT NULL,        -- YYYY-MM-DD
  filename    TEXT,
  uploaded_by INTEGER REFERENCES users(id),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(date_from, date_to)
);

CREATE TABLE IF NOT EXISTS hours (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  week_id        INTEGER NOT NULL REFERENCES weeks(id) ON DELETE CASCADE,
  rider_id       TEXT NOT NULL,
  nombre_csv     TEXT,              -- nombre tal como viene en el CSV de horas
  h_contrato     REAL,             -- H. Contrato del CSV
  h_trabajadas   REAL,             -- H. Trabajadas del CSV (fuente de verdad de lo hecho)
  ciudad         TEXT,
  total_pedidos  INTEGER,
  incentivo_total REAL,
  UNIQUE(week_id, rider_id)
);
CREATE INDEX IF NOT EXISTS idx_hours_week ON hours(week_id);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS sync_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at  TEXT NOT NULL DEFAULT (datetime('now')),
  ok          INTEGER NOT NULL,        -- 1 = éxito, 0 = error
  registros   INTEGER,                 -- registros leídos de Airtable
  riders      INTEGER,                 -- filas guardadas en workers
  mensaje     TEXT,                    -- detalle o mensaje de error
  user_id     INTEGER REFERENCES users(id),
  user_email  TEXT
);

CREATE TABLE IF NOT EXISTS upload_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  subido_at   TEXT NOT NULL DEFAULT (datetime('now')),
  filename    TEXT,
  week_id     INTEGER,
  week_label  TEXT,
  date_from   TEXT,
  date_to     TEXT,
  filas       INTEGER,
  cruzados    INTEGER,
  sin_ficha   INTEGER,
  user_id     INTEGER REFERENCES users(id),
  user_email  TEXT
);

CREATE TABLE IF NOT EXISTS adjustments (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  week_id        INTEGER NOT NULL REFERENCES weeks(id) ON DELETE CASCADE,
  rider_id       TEXT NOT NULL,
  horas_descontadas REAL NOT NULL DEFAULT 0,  -- horas que el gestor descuenta
  horas_perdonadas  REAL NOT NULL DEFAULT 0,  -- horas que se le perdonan
  justificacion  TEXT,
  updated_by     INTEGER REFERENCES users(id),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(week_id, rider_id)
);
`);

// Migración: agregar columna en_airtable si la base ya existía sin ella.
try {
  const cols = db.prepare(`PRAGMA table_info(workers)`).all();
  if (!cols.some((c) => c.name === 'en_airtable')) {
    db.exec(`ALTER TABLE workers ADD COLUMN en_airtable INTEGER NOT NULL DEFAULT 1`);
  }
} catch (e) {
  // si algo falla, no rompemos el arranque
}

export default db;
