import 'dotenv/config';
import db from '../db.js';
import { hashPassword } from '../auth.js';

// Crea los 2 usuarios admin a partir de las variables de entorno.
// Idempotente: si ya existen (por email), no los duplica.

const admins = [
  { email: process.env.ADMIN1_EMAIL, password: process.env.ADMIN1_PASSWORD, name: 'Admin 1' },
  { email: process.env.ADMIN2_EMAIL, password: process.env.ADMIN2_PASSWORD, name: 'Admin 2' },
];

const insert = db.prepare(`
  INSERT INTO users (email, password_hash, role, display_name)
  VALUES (?, ?, 'admin', ?)
  ON CONFLICT(email) DO NOTHING
`);

let created = 0;
for (const a of admins) {
  if (!a.email || !a.password) {
    console.warn('⚠  Falta email/password de un admin en .env — saltando.');
    continue;
  }
  const res = insert.run(a.email, hashPassword(a.password), a.name);
  if (res.changes > 0) {
    created++;
    console.log(`✔  Admin creado: ${a.email}`);
  } else {
    console.log(`•  Ya existía: ${a.email}`);
  }
}

console.log(`\nListo. ${created} admin(s) nuevos. Total usuarios: ${db.prepare('SELECT count(*) c FROM users').get().c}`);
