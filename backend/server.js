import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import db from './db.js';
import { login } from './auth.js';
import apiRoutes from './routes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(express.json());

// Login (público).
app.post('/api/login', (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email y contraseña requeridos' });
  const result = login(email, password);
  if (!result) return res.status(401).json({ error: 'Credenciales incorrectas' });
  res.json(result);
});

// Info de la sesión actual (útil para el frontend al recargar).
app.get('/api/health', (req, res) => {
  const stats = {
    users: db.prepare('SELECT count(*) c FROM users').get().c,
    workers: db.prepare('SELECT count(*) c FROM workers').get().c,
    weeks: db.prepare('SELECT count(*) c FROM weeks').get().c,
  };
  res.json({ ok: true, stats });
});

// Rutas protegidas de la API.
app.use('/api', apiRoutes);

// Servir el frontend estático (build simple de un solo HTML).
app.use('/', express.static(path.join(__dirname, '..', 'frontend')));

app.listen(PORT, () => {
  console.log(`\n🟢 Servidor en http://localhost:${PORT}`);
  console.log(`   Frontend:  http://localhost:${PORT}/`);
  console.log(`   API:       http://localhost:${PORT}/api\n`);
});
