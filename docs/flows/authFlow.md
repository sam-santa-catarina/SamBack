# Manual de pruebas — Endpoints de Autenticación (Postman)

## 0. Preparación general

- Base URL: `http://localhost:3000/api/auth`
- Todas las peticiones son `POST`
- Header `Content-Type: application/json` en todas las que llevan body
- Postman debe tener "Send cookies" activado (por defecto) para que refresh-token funcione, ya que el servidor manda la cookie `refresh_token` como `httpOnly`
- Para `change-password` se necesita el header `Authorization: Bearer <access_token>` obtenido de un login exitoso

Antes de empezar, confirmen en la base de datos:

- Que `tRolUsuario` tenga al menos el rol con `id = DEFAULT_ROLE_ID` (por defecto 3, "Capturista")
- Que `tEstatusUsuario` tenga los 4 estatus en este orden: 1=Nuevo, 2=Normal, 3=Bloqueado, 4=Eliminado (el código depende de estos IDs exactos)

---

## 1. Endpoint: POST /register

### 1.1 Body vacío o campos faltantes

```json
    {}
```

Esperado: `400` — "Los campos nombre_usuario y correo_electronico son obligatorios"

### 1.2 Nombre muy corto (menos de 3 caracteres)

```json
    { "nombre_usuario": "Al", "correo_electronico": "prueba1@scsam.com" }
```

Esperado: `400` — error de longitud de nombre

### 1.3 Nombre muy largo (más de 60 caracteres)

```json
    { "nombre_usuario": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "correo_electronico": "prueba2@scsam.com" }
```

Esperado: `400` — error de longitud de nombre

### 1.4 Nombre con números o símbolos

```json
    { "nombre_usuario": "Usuario123", "correo_electronico": "prueba3@scsam.com" }
```
Esperado: `400` — "El nombre de usuario solo puede contener letras y espacios"

### 1.5 Correo muy corto (menos de 10 caracteres)

```json
    { "nombre_usuario": "Juan Perez", "correo_electronico": "a@b.com" }
```    

Esperado: `400` — error de longitud de correo

### 1.6 Correo con formato inválido

```json
    { "nombre_usuario": "Juan Perez", "correo_electronico": "esto-no-es-un-correo" }
```

Esperado: `400` — "El correo electrónico no tiene un formato válido"

### 1.7 Registro exitoso

```json
    { "nombre_usuario": "Juan Perez", "correo_electronico": "juan.perez@scsam.com" }
```

Esperado: `201` con `user: { id, nombre_usuario, correo_electronico }`

Nota: Guardar el correo usado, se necesita para las pruebas de login.

### 1.8 Correo duplicado

Repetir exactamente el body del punto 1.7.

Esperado: `409` — "El correo ya está registrado"

### 1.9 Rate limit de registro

Mandar más de 20 requests distintos (correos diferentes) en menos de 15 minutos.

Esperado: a partir del request 21, `429` — "Demasiados intentos de registro. Intenta más tarde."

---

## 2. Endpoint: POST /login

Usar el usuario creado en 1.7 (contraseña inicial siempre es `password`).

### 2.1 Body vacío o campos faltantes

```json
    {}
```

Esperado: `400` — "Correo y contraseña son obligatorios"

### 2.2 Correo con formato inválido

```json
    { "correo": "no-es-correo", "contrasena": "password" }
```

Esperado: `400` — "Correo o contraseña no válidos"

### 2.3 Contraseña como no-string o demasiado larga (>100 caracteres)

```json
    { "correo": "juan.perez@scsam.com", "contrasena": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }
```

Esperado: `400` — "Correo o contraseña no válidos"

### 2.4 Correo que no existe

```json
    { "correo": "no.existe@scsam.com", "contrasena": "ClaveX123!" }
```

Esperado: `401` — "Credenciales inválidas"

### 2.5 Contraseña incorrecta

```json
    { "correo": "juan.perez@scsam.com", "contrasena": "ClaveMala123!" }
```

Esperado: `401` — "Credenciales inválidas"

### 2.6 Bloqueo por 5 intentos fallidos

Repetir el request 2.5 cinco veces seguidas contra el mismo usuario.

- Intentos 1 a 4: `401` — "Credenciales inválidas"
- Intento 5: sigue siendo `401` (el bloqueo se guarda, pero la respuesta de ese intento aún es "credenciales inválidas")
- Intento 6 en adelante: `423` — "Cuenta bloqueada. Intente nuevamente en X minutos"

Nota: Verificar en BD que `tAcceso.bloqueado_hasta` tenga una fecha ~15 min en el futuro y que `tUsuario.id_estatus_usuario` sea 3 (Bloqueado).

### 2.7 Login exitoso (usuario nuevo, contraseña por defecto)

```json
    { "correo": "juan.perez@scsam.com", "contrasena": "password" }
```

Esperado: `200`, body con:
- `requiere_cambio_contrasena: true`
- `tokens.access_token`
- Cookie `refresh_token` seteada (revisar en la pestaña Cookies de Postman)

Nota: Guardar el `access_token`, se usa en la sección 4.

### 2.8 Rate limit de login

Mandar más de 30 requests de login en menos de 10 minutos.

Esperado: a partir del request 31, `429` — "Demasiados intentos de inicio de sesión. Intenta más tarde."

---

## 3. Endpoint: POST /refresh-token

Depende de la cookie `refresh_token`, no de body ni headers manuales (Postman la manda sola si ya hizo login antes en la misma sesión de la app).

### 3.1 Sin cookie

En Postman, borrar manualmente la cookie del dominio (ícono "Cookies" bajo el botón Send) antes de correr este request.

Esperado: `400` — "Refresh token es requerido"

### 3.2 Cookie con JWT inválido o corrupto

Editar manualmente la cookie en Postman y ponerle un valor cualquiera tipo `abc.def.ghi`.

Esperado: `401` — "Refresh token inválido o expirado"

### 3.3 Refresh exitoso

Con la cookie válida (obtenida del login 2.7).

Esperado: `200` con nuevo `tokens.access_token` y una nueva cookie `refresh_token` (rotación de token — la anterior queda revocada).

### 3.4 Reintentar el mismo refresh token ya usado

Volver a correr el mismo request 3.3 pero con la cookie vieja (guardar el valor antes de que Postman la sobrescriba con la nueva).

Esperado: `401` — "Sesión revocada por seguridad" (y debe revocar TODAS las sesiones activas del usuario por seguridad — verificar en `tSesion` que todas queden `revoked = true`)

### 3.5 Rate limit de refresh

Mandar más de 30 requests en menos de 15 minutos.

Esperado: a partir del request 31, `429` — "Demasiadas solicitudes de sesión. Intenta más tarde."

---

## 4. Endpoint: POST /change-password

Requiere header `Authorization: Bearer <access_token>` (del login 2.7 o del refresh 3.3).

### 4.1 Sin header Authorization

No mandar el header.

Esperado: `401` — "Token de acceso requerido"

### 4.2 Header mal formado (sin "Bearer ")

    Authorization: eyJhbGciOiJIUzI1NiIs...

Esperado: `401` — "Token de acceso requerido"

### 4.3 Token inválido/expirado

    Authorization: Bearer token.invalido.aqui

Esperado: `401` — "Token inválido o expirado"

### 4.4 Body vacío o campos faltantes

```json
    {}
```

Esperado: `400` — "La contraseña actual y la nueva son obligatorias"

### 4.5 Contraseña nueva muy corta

```json
    { "contrasena_actual": "password", "contrasena_nueva": "Abc1!" }
```

Esperado: `400` — "La nueva contraseña debe tener entre 8 y 70 caracteres"

### 4.6 Contraseña nueva sin cumplir el patrón (falta mayúscula/número/especial)

```json
    { "contrasena_actual": "password", "contrasena_nueva": "abcdefgh" }
```

Esperado: `400` — mensaje sobre mayúscula, minúscula, número y carácter especial

### 4.7 Contraseña nueva igual a la actual

```json
    { "contrasena_actual": "password", "contrasena_nueva": "password" }
```

Esperado: `400` — "La nueva contraseña debe ser diferente a la actual"

### 4.8 Contraseña actual incorrecta

```json
    { "contrasena_actual": "ContrasenaMala1!", "contrasena_nueva": "NuevaClave123!" }
```

Esperado: `401` — "La contraseña actual es incorrecta"

### 4.9 Cambio exitoso

```json
    { "contrasena_actual": "password", "contrasena_nueva": "NuevaClave123!" }
```

Esperado: `200` — "Contraseña actualizada exitosamente"

Verificar después de este paso:

- En BD, `tUsuario.id_estatus_usuario` debe ser 2 (Normal)
- En BD, todas las filas de `tSesion` de este usuario deben tener `revoked = true`
- La cookie `refresh_token` debe quedar limpiada en la respuesta

### 4.10 Confirmar el cambio con un nuevo login

```json
    { "correo": "juan.perez@scsam.com", "contrasena": "NuevaClave123!" }
```

Esperado: `200` con `requiere_cambio_contrasena: false`

### 4.11 Intentar usar el access_token viejo (previo al cambio) en cualquier endpoint protegido

Este JWT en sí sigue siendo válido hasta que expire (el cambio de contraseña no invalida el JWT, solo revoca las sesiones de refresh). Esto es esperado — no es un bug. Confirmar con el equipo si se quiere invalidar también el access_token viejo de inmediato.

---

## 5. Orden recomendado para correr todo de corrido

1. Register (1.7) → guardar correo
2. Login (2.7) → guardar access_token y cookie
3. Refresh-token (3.3) → confirmar rotación
4. Change-password (4.9) → confirmar estatus Normal
5. Login de nuevo (4.10) → confirmar que ya no pide cambio
6. Repetir con un usuario nuevo aparte para probar el bloqueo por 5 intentos (2.6), ya que este flujo dificulta las pruebas si comparten usuario con el resto.
