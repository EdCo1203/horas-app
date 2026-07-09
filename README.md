# Control de Horas

Sistema para revisar las horas semanales del personal, cruzando el personal de Airtable con el CSV de horas de la semana. Marca quién hizo menos o más de su jornada, permite filtrar y justificar, y separa el acceso entre administradores y gestores.

## Qué hace

- **Login con roles.** Dos administradores (se crean al inicializar) y los gestores que cree el admin.
- **Personal directo de Airtable.** El admin toca **"Sincronizar desde Airtable"** y trae el personal por API (solo lectura, no escribe nada de vuelta).
- **Horas por CSV.** Las horas de la semana se siguen subiendo como archivo, indicando de qué día a qué día.
- **Admin:** ve a todos, sincroniza Airtable, sube el CSV de horas, gestiona usuarios y asigna a cada gestor su nombre.
- **Gestor:** ve solo a los trabajadores donde el campo gestor de Airtable coincide con su nombre.
- **Cruce por Rider ID** (soporta fichas de Airtable con varios IDs en el mismo campo, separados por coma).
- **Apartado "Riders":** lista del personal (independiente de la semana) con filtros combinables por ciudad/región, horas de contrato, estado del trabajador (ALTA / BAJA…) y estado de la cuenta (Activo / Inactivo), más búsqueda por nombre o Rider ID. Admin ve todos; gestor solo los suyos.
- **Exportar a CSV.** En Horas hay un botón "Descargar CSV" que exporta la semana con los ajustes y justificaciones (respeta el filtro de gestor/categoría que tengas puesto, así sacás el general o el de un gestor). En Riders, otro botón exporta la base de personal (las dos bases de Airtable juntas). Admin exporta todo; gestor solo lo suyo.
- **Clasificación exacta:** cualquier diferencia respecto a la jornada cuenta como *falta* o *extra*. Sin margen.
- **Filtros y búsqueda:** Todos / Con extras / Les falta / En jornada / Sin ficha / En baja, más búsqueda por nombre o Rider ID.
- **Justificaciones y ajustes:** por cada trabajador y semana se pueden descontar horas, perdonar horas y escribir una justificación. Las horas efectivas y la diferencia se recalculan solas.
- **Los que están en el CSV de horas pero no tienen ficha** en Airtable aparecen en la categoría *Sin ficha* (no se ocultan).
- **Los de baja** se marcan con una etiqueta y tienen su propio filtro.

## Requisitos

- Node.js 18 o superior (probado en Node 22).

## Instalación

```bash
cd backend
npm install
cp .env.example .env      # editá .env (ver abajo)
npm run init-db           # crea los 2 admins a partir del .env
npm start                 # levanta el servidor
```

Abrí **http://localhost:4000** en el navegador.

## Configuración (.env)

| Variable | Para qué |
|---|---|
| `PORT` | Puerto del servidor (por defecto 4000). |
| `JWT_SECRET` | Secreto para firmar los tokens de sesión. **Cambialo** por una cadena larga y aleatoria. |
| `ADMIN1_EMAIL` / `ADMIN1_PASSWORD` | Credenciales del primer admin (solo se usan al ejecutar `init-db`). |
| `ADMIN2_EMAIL` / `ADMIN2_PASSWORD` | Credenciales del segundo admin. |
| `AIRTABLE_TOKEN` | Personal Access Token de Airtable con permiso de **solo lectura** (`data.records:read`). Crealo en https://airtable.com/create/tokens y dale acceso a tu base. |
| `AIRTABLE_BASE_ID` | El ID de tu base: la parte que empieza con `app...` en la URL (`https://airtable.com/appXXXX/...`). |
| `AIRTABLE_TABLE` | Nombre exacto de la tabla de personal (por defecto `Cuentas de Glovo`). |
| `AIRTABLE_VIEW` | Nombre exacto de la vista a leer (respetá mayúsculas y acentos). Dejalo vacío para traer todos los registros. |
| `AIRTABLE_BASE_ID_2` (opcional) | Segunda base de Airtable, si manejás el personal en más de una (ej. otras ciudades). Misma estructura de campos. El sistema junta el personal de todas las bases en una sola lista. Podés agregar más con `_3`, `_4`… Cada una acepta su propia `AIRTABLE_TABLE_2` / `AIRTABLE_VIEW_2` / `AIRTABLE_TOKEN_2`; si no ponés token, usa el de la base principal. |

### Cómo obtener el token de Airtable (solo lectura)

1. Entrá a https://airtable.com/create/tokens y creá un **Personal Access Token**.
2. En *Scopes*, agregá solo `data.records:read`.
3. En *Access*, elegí tu base.
4. Copiá el token (empieza con `pat...`) y pegalo en `AIRTABLE_TOKEN` del `.env`. No lo compartas ni lo subas a git.

Generá un buen `JWT_SECRET` así:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

## Uso, paso a paso

1. **Entrá como admin.**
2. **Cargar datos → Sincronizar desde Airtable:** trae el personal directo de tu base (nombres, gestores, jornada, estado, región). Repetilo cuando cambie el personal; actualiza por Rider ID. Muestra la fecha de la última sincronización y un **historial** de cada sincronización (fecha, resultado, cantidad de riders y quién la hizo), incluidos los intentos que fallaron.
3. **Cargar datos → Importar horas:** subí el CSV de la semana (`Arendel_-_Incentivos_Wxx.csv`), indicá **de qué día a qué día** es la semana y una etiqueta opcional (ej. `W26`).
4. **Usuarios:** creá cada gestor con su correo y elegí su **nombre de gestor** de la lista (que sale de Airtable). Así solo verá a los suyos.
5. **Horas:** elegí la semana, filtrá por extras / faltas, buscá, y usá **Ajustar** para descontar o perdonar horas con su justificación.

## Cómo se calcula

```
horas_efectivas = horas_trabajadas + horas_perdonadas − horas_descontadas
diferencia      = horas_efectivas − jornada
```

- `diferencia > 0` → **Extra**
- `diferencia < 0` → **Falta**
- `diferencia = 0` → **En jornada**

La jornada sale de `horasDeContrato` / `hrsDeContrato` de Airtable; si el trabajador no tiene ficha, se usa la `H. Contrato` del CSV.

## Estructura

```
backend/
  server.js         Servidor Express (login + API + sirve el frontend)
  routes.js         Rutas de la API (sync Airtable, semanas, filas, ajustes, usuarios)
  airtable.js       Conector de Airtable (lectura del personal, paginación, mapeo de campos)
  importer.js       Parseo y cruce del CSV de horas
  auth.js           Login, JWT y control de roles
  db.js             SQLite (esquema)
  utils.js          Normalización, clasificación de horas
  scripts/
    initDb.js            Crea los admins
    airtabletest.mjs     Prueba del conector de Airtable (con API simulada)
  data/horas.db     Base de datos (se crea sola)
frontend/
  index.html        Toda la interfaz (una sola página)
```

## Recuperar el acceso de un admin

Si un admin olvida su contraseña, otro admin puede resetearla desde el dashboard (pestaña Usuarios → Editar → nueva contraseña). Las contraseñas nunca se muestran: siempre se ponen de nuevo, por seguridad (se guardan cifradas con bcrypt, no se pueden "ver").

Si se perdió el acceso a **todos** los admins, se recupera desde el servidor por SSH, sin exponer nada en la app:

```bash
cd backend
node scripts/recover.js list                          # ver los usuarios
node scripts/recover.js reset admin1@empresa.com       # resetear (pide o genera la clave)
node scripts/recover.js reset admin1@empresa.com Clave123   # resetear con una clave puesta por vos
node scripts/recover.js create-admin nuevo@empresa.com # crear un admin de emergencia
```

Si no ponés la contraseña, el script la pide de forma oculta o genera una aleatoria y te la muestra una sola vez. Todo esto requiere acceso al servidor, así que solo lo puede hacer quien administra la máquina.

## Notas

- Airtable es **solo lectura**: el sistema nunca escribe en tu base.
- Las justificaciones y ajustes se guardan en la base propia (SQLite), no se escriben de vuelta a Airtable.
- Al reimportar una semana con el mismo rango de fechas, se reemplazan sus horas; los ajustes guardados de esa semana se conservan mientras exista.
- El archivo `.env` no debe subirse a un repositorio: contiene el secreto y las contraseñas iniciales.
