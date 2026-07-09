import 'dotenv/config';
import readline from 'readline';
import db from '../db.js';
import { hashPassword } from '../auth.js';

/**
 * Herramienta de recuperación de acceso — se ejecuta SOLO desde el servidor (SSH).
 * No expone nada en la app web ni guarda contraseñas en texto plano:
 * la contraseña nueva se convierte en hash bcrypt igual que siempre.
 *
 * Uso:
 *   node scripts/recover.js list
 *   node scripts/recover.js reset <email> [nueva_contraseña]
 *   node scripts/recover.js create-admin <email> [contraseña]
 *
 * Si no pasás la contraseña, el script la pide de forma interactiva
 * (sin mostrarla en pantalla) o genera una aleatoria y te la muestra una vez.
 */

const [, , cmd, arg1, arg2] = process.argv;

function genPassword() {
  // Contraseña aleatoria legible (para mostrarla una sola vez).
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  let out = '';
  for (let i = 0; i < 14; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out + '!';
}

function askHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const stdout = process.stdout;
    // Ocultar lo que se escribe.
    const onData = (char) => {
      char = char + '';
      if (['\n', '\r', '\u0004'].includes(char)) process.stdin.removeListener('data', onData);
      else stdout.write('\x1B[2K\x1B[200D' + question + '*'.repeat(rl.line.length));
    };
    process.stdin.on('data', onData);
    rl.question(question, (value) => {
      rl.close();
      stdout.write('\n');
      resolve(value);
    });
  });
}

function listUsers() {
  const users = db
    .prepare('SELECT id, email, role, gestor_name, active FROM users ORDER BY role, email')
    .all();
  if (users.length === 0) {
    console.log('No hay usuarios en la base.');
    return;
  }
  console.log('\nUsuarios del sistema:\n');
  for (const u of users) {
    const estado = u.active ? 'activo' : 'INACTIVO';
    const gestor = u.gestor_name ? `  gestor: ${u.gestor_name}` : '';
    console.log(`  [${u.id}] ${u.email}  (${u.role}, ${estado})${gestor}`);
  }
  console.log('');
}

async function resetPassword(email, password) {
  const u = db.prepare('SELECT * FROM users WHERE lower(email) = lower(?)').get(email);
  if (!u) {
    console.error(`✖  No existe un usuario con el correo: ${email}`);
    process.exit(1);
  }
  let pass = password;
  let generated = false;
  if (!pass) {
    pass = await askHidden('Nueva contraseña (dejá vacío para generar una): ');
    if (!pass) {
      pass = genPassword();
      generated = true;
    }
  }
  db.prepare("UPDATE users SET password_hash = ?, active = 1 WHERE id = ?").run(hashPassword(pass), u.id);
  console.log(`\n✔  Contraseña actualizada para ${u.email} (${u.role}). El usuario quedó activo.`);
  if (generated) {
    console.log(`\n   Contraseña nueva (guardala, no se vuelve a mostrar):\n\n      ${pass}\n`);
  }
}

async function createAdmin(email, password) {
  const exists = db.prepare('SELECT 1 FROM users WHERE lower(email) = lower(?)').get(email);
  if (exists) {
    console.error(`✖  Ya existe un usuario con ese correo. Usá "reset" para cambiarle la contraseña.`);
    process.exit(1);
  }
  let pass = password;
  let generated = false;
  if (!pass) {
    pass = await askHidden('Contraseña del nuevo admin (vacío para generar): ');
    if (!pass) {
      pass = genPassword();
      generated = true;
    }
  }
  db.prepare(
    "INSERT INTO users (email, password_hash, role, display_name, active) VALUES (?, ?, 'admin', ?, 1)"
  ).run(email, hashPassword(pass), 'Admin (recuperación)');
  console.log(`\n✔  Admin de emergencia creado: ${email}`);
  if (generated) {
    console.log(`\n   Contraseña (guardala, no se vuelve a mostrar):\n\n      ${pass}\n`);
  }
}

function usage() {
  console.log(`
Herramienta de recuperación de acceso (ejecutar desde el servidor).

  node scripts/recover.js list
      Lista todos los usuarios (correo, rol, estado).

  node scripts/recover.js reset <email> [contraseña]
      Resetea la contraseña de un usuario y lo deja activo.
      Si no ponés contraseña, te la pide oculta o genera una.

  node scripts/recover.js create-admin <email> [contraseña]
      Crea un admin de emergencia (por si se perdió el acceso a todos).
`);
}

(async () => {
  try {
    if (cmd === 'list') listUsers();
    else if (cmd === 'reset' && arg1) await resetPassword(arg1, arg2);
    else if (cmd === 'create-admin' && arg1) await createAdmin(arg1, arg2);
    else usage();
  } catch (e) {
    console.error('Error:', e.message);
    process.exit(1);
  }
  process.exit(0);
})();
