import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import db from './db.js';

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-cambiar';
const TOKEN_TTL = '12h';

export function hashPassword(plain) {
  return bcrypt.hashSync(plain, 10);
}

export function verifyPassword(plain, hash) {
  return bcrypt.compareSync(plain, hash);
}

export function login(email, password) {
  const user = db
    .prepare('SELECT * FROM users WHERE lower(email) = lower(?) AND active = 1')
    .get(email);
  if (!user) return null;
  if (!verifyPassword(password, user.password_hash)) return null;

  const token = jwt.sign(
    {
      id: user.id,
      email: user.email,
      role: user.role,
      gestor_name: user.gestor_name,
      display_name: user.display_name,
    },
    JWT_SECRET,
    { expiresIn: TOKEN_TTL }
  );
  return {
    token,
    user: {
      id: user.id,
      email: user.email,
      role: user.role,
      gestor_name: user.gestor_name,
      display_name: user.display_name,
    },
  };
}

// Middleware: exige token válido.
export function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'No autenticado' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'Token inválido o expirado' });
  }
}

// Middleware: exige rol admin.
export function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin')
    return res.status(403).json({ error: 'Requiere rol admin' });
  next();
}
