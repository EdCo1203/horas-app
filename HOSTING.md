# Publicar la app en internet (Hostinger)

Esta guía explica cómo poner el sistema online. Hay dos caminos en Hostinger. Para esta app **recomiendo el VPS**, porque usa una base de datos SQLite que necesita escribir en disco de forma permanente y conviene tener el proceso siempre corriendo.

> Los precios y nombres de planes cambian seguido. Verificá siempre en el carrito de Hostinger antes de contratar. A julio de 2026, el VPS más chico (KVM 1) alcanza para esta app; si esperás varios gestores usándola a la vez, KVM 2 va más holgado.

---

## Opción A — VPS (recomendada)

Control total, SQLite persistente, proceso siempre activo. Requiere unos comandos por SSH, pero es directo.

### 1. Contratar el VPS

1. En Hostinger, contratá un plan **VPS** (KVM 1 o KVM 2).
2. Elegí **Ubuntu 24.04** como sistema operativo.
3. Anotá la **IP** del servidor (la ves en hPanel → VPS → Manage → Overview) y la contraseña de root.

### 2. Conectarte por SSH

Desde tu compu (Terminal en Mac/Linux, o PowerShell/PuTTY en Windows):

```bash
ssh root@LA_IP_DE_TU_VPS
```

### 3. Instalar Node.js

```bash
apt update && apt upgrade -y
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs git
node --version    # debería mostrar v22.x
```

### 4. Subir el proyecto

Dos formas. La más simple: subir el ZIP.

**Con el ZIP** (desde tu compu, en otra terminal):
```bash
scp horas-app.zip root@LA_IP_DE_TU_VPS:/root/
```
Después, ya conectado por SSH al servidor:
```bash
cd /root
apt install -y unzip
unzip horas-app.zip
cd horas-app/backend
```

**O con Git**, si lo tenés en un repositorio:
```bash
cd /root
git clone TU_REPO horas-app
cd horas-app/backend
```

### 5. Instalar y configurar

```bash
npm install
cp .env.example .env
nano .env
```

En el editor (`nano`), completá:
- `JWT_SECRET` con una cadena larga (generá una con `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` y pegala).
- Los correos y contraseñas de los 2 admins.
- `AIRTABLE_TOKEN`, `AIRTABLE_BASE_ID`, `AIRTABLE_TABLE` y `AIRTABLE_VIEW`.

Guardá con `Ctrl+O`, `Enter`, y salí con `Ctrl+X`. Después:

```bash
npm run init-db      # crea los 2 admins
```

### 6. Dejar la app corriendo siempre (PM2)

PM2 mantiene la app viva y la reinicia si el servidor se reinicia.

```bash
npm install -g pm2
pm2 start server.js --name horas
pm2 startup           # ejecutá el comando que te imprime
pm2 save
```

La app ya está corriendo en el puerto 4000. Probala: `http://LA_IP_DE_TU_VPS:4000`.

### 7. Dominio + HTTPS (Nginx + Let's Encrypt)

Para usar un dominio propio con candado (https), poné Nginx delante:

```bash
apt install -y nginx
```

Creá la config:
```bash
nano /etc/nginx/sites-available/horas
```
Pegá (cambiá `tudominio.com`):
```nginx
server {
    listen 80;
    server_name tudominio.com www.tudominio.com;
    location / {
        proxy_pass http://localhost:4000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```
Activala y reiniciá:
```bash
ln -s /etc/nginx/sites-available/horas /etc/nginx/sites-enabled/
nginx -t && systemctl restart nginx
```

Apuntá tu dominio a la IP del VPS (un registro **A** en tu proveedor de dominio → la IP del VPS). Después, certificado gratis:
```bash
apt install -y certbot python3-certbot-nginx
certbot --nginx -d tudominio.com -d www.tudominio.com
```
Certbot configura el https solo. Listo: `https://tudominio.com`.

### 8. Abrir el firewall

```bash
ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw enable
```

### Actualizar la app más adelante

```bash
cd /root/horas-app/backend
# (subir los archivos nuevos o git pull)
npm install
pm2 restart horas
```

### Recuperar acceso de admin (si se pierde la contraseña de todos)

Conectado por SSH al servidor:
```bash
cd /root/horas-app/backend
node scripts/recover.js list                     # ver usuarios
node scripts/recover.js reset admin1@empresa.com  # resetear su contraseña
```
Requiere acceso SSH al servidor, por eso es seguro: no se expone en la app ni se guardan contraseñas en texto plano.

---

## Opción B — Hosting Node.js administrado (más simple, menos control)

Disponible en planes **Business** o **Cloud** de Hostinger. No tocás el servidor: subís el código (ZIP o GitHub) y Hostinger lo corre.

Pasos generales (en hPanel → Websites → Add Website → tipo Node.js):
1. Elegí desplegar por **subida de ZIP** o **GitHub**.
2. Framework: elegí **"Other"** (esta app es Express, no un framework detectable).
3. Comando de arranque: `node server.js` (o `npm start`), dentro de la carpeta `backend`.
4. Cargá las variables de entorno (las del `.env`) en el panel de la app.

**Antes de usar esta opción, tené en cuenta una limitación importante:** el hosting administrado puede reiniciar el proceso o no garantizar disco persistente entre despliegues, y esta app guarda las justificaciones/ajustes en un archivo SQLite. Si el disco no persiste, esos datos se podrían perder al redeployar. Si vas por este camino, confirmá con soporte de Hostinger que la carpeta `backend/data/` se conserva entre reinicios y despliegues. Si no lo garantizan, usá el VPS (Opción A), o pedime que cambie la base a un servicio de base de datos externo (por ejemplo PostgreSQL administrado), que sería la forma correcta de usar el hosting administrado.

---

## Resumen

| | VPS (A) | Administrado (B) |
|---|---|---|
| Dificultad | Media (unos comandos) | Baja (subir y listo) |
| SQLite persistente | Sí | Hay que confirmarlo con soporte |
| Control | Total | Limitado |
| Recomendado para esta app | **Sí** | Solo si confirman disco persistente |

Si me decís por cuál vas, te ajusto lo que haga falta (por ejemplo, migrar la base a PostgreSQL si elegís el administrado).
