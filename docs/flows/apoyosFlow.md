# Casos de prueba — Módulo de Apoyos

Cubre los 3 endpoints:
- `GET /api/apoyos` (listar)
- `POST /api/apoyos/importar` (carga de apoyos otorgados)
- `POST /api/apoyos/importar-pendientes` (carga de apoyos pendientes)

**Nota general:** en todos los archivos Excel, los encabezados van en la **fila 4** y los datos comienzan en la **fila 5**. Se asume que un mismo Excel siempre pertenece a **una sola dependencia**.

---

## 1. Autenticación y permisos

| ID | Caso | Precondición | Pasos | Resultado esperado |
|----|------|---------------|-------|---------------------|
| AUTH-01 | Usuario no autenticado intenta listar | Sin sesión / token inválido | `GET /api/apoyos` | Rechazado por el middleware de autenticación (antes de llegar al controller) |
| AUTH-02 | Usuario no-Administrador intenta importar otorgados | Login con rol distinto a Administrador | `POST /api/apoyos/importar` con archivo válido | `403` — "Solo el Administrador puede importar apoyos" |
| AUTH-03 | Usuario no-Administrador intenta importar pendientes | Login con rol distinto a Administrador | `POST /api/apoyos/importar-pendientes` con archivo válido | `403` — "Solo el Administrador puede importar apoyos pendientes" |
| AUTH-04 | Administrador importa otorgados | Login como Administrador | `POST /api/apoyos/importar` con archivo válido | Se procesa normalmente (no hay rechazo por rol) |
| AUTH-05 | Administrador importa pendientes | Login como Administrador | `POST /api/apoyos/importar-pendientes` con archivo válido | Se procesa normalmente |

---

## 2. GET /api/apoyos (listar)

| ID | Caso | Precondición | Pasos | Resultado esperado |
|----|------|---------------|-------|---------------------|
| LIST-01 | Administrador ve todas las dependencias | Login como Administrador; hay apoyos de varias dependencias en BD | `GET /api/apoyos` sin filtros | Regresa registros de **todas** las dependencias |
| LIST-02 | Supervisor ve todas las dependencias | Login como Supervisor | `GET /api/apoyos` sin filtros | Regresa registros de **todas** las dependencias |
| LIST-03 | Rol restringido solo ve su dependencia | Login con rol distinto de Admin/Supervisor, con `id_dependencia` asignado | `GET /api/apoyos` sin filtros | Regresa **solo** registros de la dependencia del usuario, aunque haya apoyos de otras dependencias en BD |
| LIST-04 | Rol restringido no puede ver otra dependencia aunque la pida | Mismo usuario que LIST-03 | `GET /api/apoyos?id_dependencia=<otra>` (si el filtro existiera) o cualquier intento de forzar otra dependencia | Sigue regresando solo su propia dependencia, el filtro/parámetro del cliente se ignora |
| LIST-05 | Usuario sin dependencia asignada y rol restringido | Login con rol restringido y `id_dependencia` nulo | `GET /api/apoyos` | `403` — "No tiene una dependencia asignada" |
| LIST-06 | Paginación básica | BD con más de 30 registros | `GET /api/apoyos` (sin `limit`/`offset`) | Regresa 30 registros (`DEFAULT_LIMIT`), `hasMore: true` si hay más |
| LIST-07 | Paginación con `limit` personalizado | BD con registros suficientes | `GET /api/apoyos?limit=10` | Regresa máximo 10 registros |
| LIST-08 | `limit` mayor al máximo permitido | — | `GET /api/apoyos?limit=500` | Se limita a `MAX_LIMIT` (100), no regresa 500 |
| LIST-09 | `offset` avanza la paginación | — | `GET /api/apoyos?offset=30&limit=30` | Regresa el siguiente bloque de 30, sin repetir los primeros |
| LIST-10 | Búsqueda por CURP con menos de 3 caracteres | — | `GET /api/apoyos?curp=AB` | `400` — pide al menos 3 caracteres |
| LIST-11 | Búsqueda por CURP con prefijo válido | Hay registros con CURP que empiezan igual | `GET /api/apoyos?curp=ABC` | Regresa solo los registros cuya CURP empieza con "ABC" |
| LIST-12 | Respuesta incluye nombres resueltos | — | `GET /api/apoyos` | Cada registro trae `dependencia`, `programa` y `capturado_por` como texto, no solo IDs |

---

## 3. POST /api/apoyos/importar (otorgados)

### 3.1 Validaciones del archivo

| ID | Caso | Pasos | Resultado esperado |
|----|------|-------|---------------------|
| OTG-F01 | Sin archivo adjunto | `POST /api/apoyos/importar` sin campo `file` | `400` — "Debe subir un archivo Excel (.xlsx)" |
| OTG-F02 | Archivo sin hojas | Subir un `.xlsx` sin ninguna hoja | `400` — "El archivo Excel no contiene hojas" |
| OTG-F03 | Archivo con menos de 4 filas | Subir Excel con solo 2-3 filas | `400` — "...se espera encabezados en la fila 4" |
| OTG-F04 | Fila 4 sin encabezados (todos vacíos) | Excel con fila 4 en blanco | `400` — "No se encontraron encabezados en la fila 4" |
| OTG-F05 | Archivo sin filas de datos (solo encabezados) | Excel con encabezados en fila 4 y nada después | `400` — "El archivo Excel está vacío" |
| OTG-F06 | Filas completamente vacías intercaladas | Excel con filas en blanco entre registros válidos | Las filas vacías se ignoran, no generan error ni se cuentan |

### 3.2 Validaciones de datos por fila

| ID | Caso | Dato de prueba | Resultado esperado |
|----|------|------------------|---------------------|
| OTG-V01 | Nombre vacío | `NOMBRE(S)` = "" | Error: "Nombres inválidos..." |
| OTG-V02 | Nombre con números | `NOMBRE(S)` = "Juan123" | Error: "Nombres inválidos..." |
| OTG-V03 | Nombre de 1 solo carácter | `NOMBRE(S)` = "J" | Error: "Nombres inválidos..." (mínimo 2 caracteres) |
| OTG-V04 | Nombre con apóstrofe, guion y punto | `NOMBRE(S)` = "Ma. José D'Ángelo-Pérez" | Válido (permitido por el regex) |
| OTG-V05 | Nombre con acentos | `NOMBRE(S)` = "José María Muñoz" | Válido |
| OTG-V06 | Sin apellido paterno ni materno | Ambos vacíos | Error: "Debe ingresar al menos un apellido..." |
| OTG-V07 | Solo apellido paterno | Materno vacío, paterno válido | Válido, `apellido_materno` queda `null` |
| OTG-V08 | Solo apellido materno | Paterno vacío, materno válido | Válido, `apellido_paterno` queda `null` |
| OTG-V09 | Apellido con caracteres inválidos | `APELLIDO PATERNO` = "García#1" | Error: "Apellido paterno inválido" |
| OTG-V10 | CURP con formato inválido (letras de más/menos) | `CURP` = "ABC123" | Error: "CURP inválida..." |
| OTG-V11 | CURP válida en minúsculas | `CURP` = curp válida en minúsculas | Válido, se guarda en mayúsculas |
| OTG-V12 | CURP con espacios extra | `CURP` = " ABCD123456HDFXYZ01 " | Válido después de trim |
| OTG-V13 | Dependencia que no existe en catálogo | `DEPENDENCIA` = "Dependencia Inventada" | Error: 'Dependencia "..." no encontrada...' |
| OTG-V14 | Dependencia con mayúsculas/minúsculas distintas al catálogo | `DEPENDENCIA` = "desarrollo social" (catálogo tiene "Desarrollo Social") | Válido (comparación case-insensitive) |
| OTG-V15 | Programa que no existe para esa dependencia | `PROGRAMA` = programa real pero de otra dependencia | Error: 'Programa "..." no encontrado para la dependencia...' |
| OTG-V16 | Programa válido para la dependencia | Combinación correcta | Válido |
| OTG-V17 | Dependencia inválida Y programa presente | `DEPENDENCIA` inválida, `PROGRAMA` con texto | Error de dependencia + error: "No se pudo validar el programa porque la dependencia es inválida" |
| OTG-V18 | Número exterior vacío | `NÚMERO EXTERIOR` = "" | Se guarda automáticamente como "S/N" |
| OTG-V19 | Cantidad no numérica | `CANTIDAD` = "abc" | Error: "Cantidad debe ser un número entero positivo" |
| OTG-V20 | Cantidad negativa o cero | `CANTIDAD` = "0" o "-5" | Error: "Cantidad debe ser un número entero positivo" |
| OTG-V21 | Cantidad vacía | `CANTIDAD` = "" | Válido, toma el valor por defecto (1) |
| OTG-V22 | Monto negativo | `MONTO` = "-100" | Error: "Monto debe ser un número positivo..." |
| OTG-V23 | Monto vacío | `MONTO` = "" | Válido, se guarda como `null` (apoyo en especie) |
| OTG-V24 | Monto con decimales | `MONTO` = "1670.25" | Válido |
| OTG-V25 | Fecha en formato incorrecto | `FECHA DE APOYO` = "2025-06-30" (no es DD/MM/AAAA) | Error: "Fecha de apoyo inválida..." |
| OTG-V26 | Fecha inexistente | `FECHA DE APOYO` = "31/02/2025" | Error: "Fecha de apoyo inválida..." |
| OTG-V27 | Fecha vacía | `FECHA DE APOYO` = "" | Válido, se guarda como `null` |
| OTG-V28 | Fecha como número de serie de Excel | Celda con formato de fecha nativo de Excel | Se convierte automáticamente a DD/MM/AAAA y luego a YYYY-MM-DD |
| OTG-V29 | Concepto vacío | `CONCEPTO DE APOYO` = "" | Válido, se guarda como `null` (a diferencia de pendientes, aquí NO es obligatorio) |
| OTG-V30 | Fila con múltiples errores a la vez | Nombre inválido + CURP inválida + sin apellidos | Todos los mensajes de error se acumulan en una sola observación separados por `; ` |

### 3.3 Lógica de negocio (pendiente / duplicado / inserción)

Estos casos son los más importantes — verifican el comportamiento corregido.

| ID | Caso | Precondición en BD | Pasos | Resultado esperado |
|----|------|----------------------|-------|---------------------|
| OTG-N01 | Completar un pendiente exacto | Existe un registro con `otorgado=false` para curp+nombres+apellidos+dependencia+programa+concepto que coincide con la fila | Subir Excel con esa fila | Se **actualiza** ese registro (llena localidad, calle, número, cantidad, monto, fecha) y `otorgado=true`. Cuenta como `actualizados` |
| OTG-N02 | Pendiente con concepto distinto no se toca | Existe pendiente con concepto "Ganado", el Excel trae concepto "Rastrojo" para la misma persona/programa | Subir Excel | El pendiente de "Ganado" queda intacto; la fila de "Rastrojo" no lo encuentra y sigue el flujo de inserción/duplicado |
| OTG-N03 | Insertar cuando no hay nada previo | BD vacía para esa persona/programa/concepto | Subir Excel | Se **inserta** como registro nuevo con `otorgado=true`. Cuenta como `insertados` |
| OTG-N04 | Re-subir el mismo Excel sin cambios | Ya se importó una vez (todo otorgado, sin pendientes) | Subir exactamente el mismo archivo otra vez | **Todo se ignora** (`ignorados` = total de filas válidas), `insertados=0`, `actualizados=0` |
| OTG-N05 | Misma persona, mismo programa, dos conceptos distintos en el mismo archivo | Excel con 2 filas para la misma curp+programa+dependencia pero diferente `CONCEPTO DE APOYO` | Subir Excel | Se insertan **ambos** como registros separados (no se pisan entre sí) |
| OTG-N06 | Mismo concepto pero cantidad distinta | Ya existe un otorgado con cantidad=15; el Excel trae la misma identidad pero cantidad=3 | Subir Excel | No es duplicado exacto → se inserta como **nuevo** registro (no se ignora, no se actualiza el existente) |
| OTG-N07 | Mismo concepto pero monto distinto | Análogo a N06 pero variando `MONTO` | Subir Excel | Se inserta como nuevo registro |
| OTG-N08 | Mismo concepto pero fecha distinta | Análogo a N06 pero variando `FECHA DE APOYO` | Subir Excel | Se inserta como nuevo registro (permite que la misma persona reciba el mismo apoyo en fechas distintas) |
| OTG-N09 | Mismo concepto pero localidad/calle/número distintos | Análogo a N06 variando domicilio | Subir Excel | Se inserta como nuevo registro |
| OTG-N10 | Todos los campos iguales excepto un espacio extra o mayúsculas en texto libre | Ej. `CALLE` = "Morelos" vs BD "MORELOS " | Subir Excel | Verificar cómo se comporta (la limpieza normaliza espacios pero no mayúsculas en texto libre — confirmar con el equipo si esto debe ignorarse o no) |
| OTG-N11 | Reimportación después de "arreglar" un registro corrupto | Insertar manualmente un duplicado con datos ligeramente distintos a propósito, luego subir el Excel correcto | Subir Excel | El nuevo se inserta aparte del "corrupto" (confirma que el sistema no intenta fusionar registros existentes entre sí) |

### 3.4 Archivo de errores

| ID | Caso | Pasos | Resultado esperado |
|----|------|-------|---------------------|
| OTG-E01 | Excel con al menos una fila con error | Subir Excel con una fila inválida | La respuesta es un archivo `.xlsx` descargable, no JSON |
| OTG-E02 | Nombre del archivo de errores incluye la dependencia | Excel de la dependencia "Desarrollo Social" con errores | El archivo descargado se llama `errores-registros-otorgados-desarrollo-social.xlsx` |
| OTG-E03 | Nombre de archivo sin acentos ni espacios | Dependencia con acentos, ej. "Educación Pública" | El slug queda sin acentos, en minúsculas y con guiones, ej. `educacion-publica` |
| OTG-E04 | Excel de errores conserva las columnas originales | — | El archivo generado tiene las mismas columnas que el original, más la columna "Atención" |
| OTG-E05 | Columna "Atención" describe el/los error(es) de cada fila | Fila con 2 errores | La celda "Atención" de esa fila muestra ambos mensajes separados por `; ` |
| OTG-E06 | Encabezado `X-Import-Result` presente | Respuesta con archivo de errores | El header incluye JSON con `insertados`, `actualizados`, `ignorados`, `errores`, `total_procesados` |
| OTG-E07 | Todas las dependencias del archivo son inválidas | Excel donde ninguna fila resuelve una dependencia válida | El archivo de errores se llama `errores-registros-otorgados-sin-dependencia.xlsx` |
| OTG-E08 | Excel sin errores | Todas las filas válidas | La respuesta es JSON (no archivo), con `message`, `insertados`, `actualizados`, `total` |

---

## 4. POST /api/apoyos/importar-pendientes

### 4.1 Validaciones del archivo

Mismos casos que la sección 3.1 (OTG-F01 a OTG-F06), aplicados a este endpoint. Renombrar como `PEND-F01` a `PEND-F06`.

### 4.2 Validaciones de datos por fila

| ID | Caso | Dato de prueba | Resultado esperado |
|----|------|------------------|---------------------|
| PEND-V01 a V17 | Mismas validaciones que OTG-V01 a OTG-V17 (nombres, apellidos, CURP, dependencia, programa) | — | Mismo comportamiento |
| PEND-V18 | Concepto vacío | `CONCEPTO DE APOYO` = "" | Error: "El concepto de apoyo es obligatorio" (**a diferencia de otorgados, aquí SÍ es obligatorio**) |
| PEND-V19 | Concepto presente | `CONCEPTO DE APOYO` = "Ganado" | Válido |
| PEND-V20 | El archivo no trae columnas de localidad/calle/número/cantidad/monto/fecha | Excel solo con las 7 columnas esperadas | No se generan errores por columnas faltantes (no se piden) |

### 4.3 Lógica de negocio

| ID | Caso | Precondición en BD | Pasos | Resultado esperado |
|----|------|----------------------|-------|---------------------|
| PEND-N01 | Insertar pendiente nuevo | No existe nada con esa identidad (curp+nombres+apellidos+dependencia+programa+concepto) | Subir Excel | Se inserta con `otorgado=false` y el resto de campos en `null`. Cuenta como `insertados` |
| PEND-N02 | Re-subir el mismo pendiente | Ya existe un pendiente idéntico (`otorgado=false`) | Subir el mismo Excel otra vez | Se **ignora** (no se duplica). Cuenta como `ignorados` |
| PEND-N03 | Pendiente para un apoyo que ya fue otorgado | Existe un registro `otorgado=true` con esa misma identidad completa | Subir Excel de pendientes con esos datos | Se **ignora** (no tiene caso crear un pendiente de algo ya entregado) |
| PEND-N04 | Misma persona, dos conceptos distintos | Excel con 2 filas, mismo curp+programa+dependencia, distinto concepto | Subir Excel | Se insertan **ambos** pendientes por separado |
| PEND-N05 | Pendiente y luego completarlo vía `/importar` | Se sube primero el pendiente (PEND-N01), luego se sube un Excel de otorgados con la misma identidad básica + concepto | 1) `POST /importar-pendientes` 2) `POST /importar` | El segundo paso completa el pendiente (`actualizados=1` en el segundo endpoint), no crea un registro duplicado |
| PEND-N06 | Pendientes duplicados en el mismo archivo | El mismo Excel de pendientes trae 2 veces la misma fila exacta | Subir Excel | La primera aparición se inserta; la segunda debe evaluarse contra lo que ya está en BD — **importante**: como la verificación es contra BD y no contra el propio archivo, confirmar si la 2ª fila idéntica dentro del mismo archivo se ignora o se duplica (revisar con el equipo si hace falta una validación adicional intra-archivo) |

### 4.4 Archivo de errores

| ID | Caso | Pasos | Resultado esperado |
|----|------|-------|---------------------|
| PEND-E01 | Nombre del archivo de errores | Excel de "Desarrollo Social" con errores | Se descarga `errores-registros-pendientes-desarrollo-social.xlsx` |
| PEND-E02 | Excel sin errores | Todas las filas válidas | Respuesta JSON con `message`, `insertados`, `ignorados`, `total` |
| PEND-E03 | Encabezado `X-Import-Result` | Respuesta con archivo de errores | JSON con `insertados`, `ignorados`, `errores`, `total_procesados` |

---

## 5. Casos de integración (flujo completo)

| ID | Caso | Pasos | Resultado esperado |
|----|------|-------|---------------------|
| INT-01 | Ciclo completo pendiente → otorgado | 1) Subir Excel de pendientes (persona X, concepto "Ganado") 2) Subir Excel de otorgados con la misma persona/programa/concepto y el resto de los datos completos | El registro pendiente se completa y pasa a `otorgado=true`; no queda un registro pendiente huérfano ni uno duplicado |
| INT-02 | Base limpia → primera carga → segunda carga idéntica | 1) Truncar tabla `tApoyo` (ambiente de pruebas) 2) Subir Excel de otorgados válido (N filas, sin errores) 3) Subir el mismo Excel otra vez | Paso 2: `insertados=N`, `actualizados=0`, `ignorados=0`. Paso 3: `insertados=0`, `actualizados=0`, `ignorados=N` |
| INT-03 | Modificar un campo y volver a subir | Después de INT-02, cambiar el `MONTO` de una sola fila en el Excel y volver a subirlo | Solo esa fila se inserta como **nuevo** registro (no se actualiza el anterior); el resto se ignora |
| INT-04 | Roles distintos ven resultados distintos en `listar` tras la carga | Después de una carga con varias dependencias en BD | Login con Administrador vs con rol restringido de una dependencia específica, comparar resultados de `GET /api/apoyos` | Administrador ve todo; el rol restringido solo su dependencia |

---

## Notas para el tester

- Los casos **OTG-N\*** y **PEND-N\*** son los más críticos: verifican que no se repita el bug original donde subir el mismo Excel dos veces generaba actualizaciones en lugar de ignorar registros.
- Para preparar los Excel de prueba, usar los mismos nombres de encabezado documentados en cada sección (`NOMBRE(S)`, `APELLIDO PATERNO`, `APELLIDO MATERNO`, `CURP`, `DEPENDENCIA`, `PROGRAMA`, `CONCEPTO DE APOYO`, y para otorgados además `LOCALIDAD`, `CALLE`, `NÚMERO EXTERIOR`, `CANTIDAD`, `MONTO`, `FECHA DE APOYO`).
- Los casos marcados con "confirmar con el equipo" (OTG-N10, PEND-N06) son ambigüedades de negocio que vale la pena aclarar antes de reportarlos como bug.