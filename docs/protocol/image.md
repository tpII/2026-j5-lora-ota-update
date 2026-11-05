# Imagen

Contrato de la imagen que el operador firma en el panel y que los nodos se transfieren ([ADR 0012](../adrs/0012-image-format-and-operator-key.md)). Los campos de más de un byte van en little-endian.

## Formato

| Campo | Bytes | Descripción |
|---|---|---|
| `magic` | 2 | `4A 35`, los caracteres `J5` |
| `flags` | 1 | Reservado; hoy vale `0` |
| `version` | 4 | Versión de la imagen, de 1 a 4294967295 |
| `length` | 2 | Largo del programa en bytes, de 1 a 1024 |
| `program` | `length` | Programa de la VM ([la VM](virtual-machine.md)) |
| `signature` | 64 | Firma Ed25519 del operador |

Los primeros 9 bytes forman la cabecera. Una imagen ocupa entre 74 y 1097 bytes.

## Firma

`signature` es la firma Ed25519 (RFC 8032) de un mensaje de 41 bytes: la cabecera seguida del SHA-256 del programa. Así la firma cubre la versión, el tamaño y el hash del programa, como prevé el E1.

```
mensaje = magic ‖ flags ‖ version ‖ length ‖ SHA-256(program)
```

El firmware la verifica con libsodium, que viene con el core de ESP32, y el panel firma con `crypto.subtle`.

## Verificación

Un nodo acepta una imagen, llegue por la consola o por la radio, solo si se cumplen todas estas condiciones:

1. el largo total es `9 + length + 64`;
2. `magic` es `4A 35` y `flags` es `0`;
3. `version` es mayor que 0 y `length` va de 1 a 1024;
4. la firma es válida con la clave pública del operador;
5. el programa pasa la validación de la VM: opcodes conocidos, registros de 1 a 4 y ninguna instrucción cortada por el final.

Las cuatro primeras condiciones se informan con el motivo `format` o `signature` y la última, con `program` (ver [consola](console.md)).

## Claves del operador

El nodo compila la clave pública del operador; la privada queda en la computadora del operador. La clave pública va como 64 dígitos hexadecimales en la macro `J5_OPERATOR_PUBLIC_KEY`, que se reemplaza con `firmware/build_opt.h` igual que la clave de red ([trama](frame.md)):

```
-DJ5_OPERATOR_PUBLIC_KEY="\"<64 dígitos hexadecimales>\""
```

Para desarrollo, el repositorio incluye un par por defecto. La clave privada está en `keys/default_operator_key.pem` y la pública vale `9b82c16539e90d39d9f1a1f786f30c123d8292453b88bdd271c412230940b573`. Cualquiera que tenga el repositorio puede firmar con ese par, así que solo sirve para el banco. El evento `boot` indica con `operator_key` si el nodo usa la clave por defecto.

Un par nuevo se genera con OpenSSL o desde el panel:

```sh
openssl genpkey -algorithm ed25519 -out operator_key.pem
openssl pkey -in operator_key.pem -pubout -outform DER | tail -c 32 | xxd -p -c 64
```

El panel importa la clave privada desde un archivo PEM con formato PKCS#8, como el que produce el primer comando. El segundo imprime la clave pública en el formato de `J5_OPERATOR_PUBLIC_KEY`.

## Versión

Al firmar, el panel propone como versión la hora Unix UTC en segundos ([ADR 0011](../adrs/0011-implicit-activation-without-rollback.md)). Los nodos solo comparan cuál es mayor; la versión 0 es el programa de fábrica, que está vacío y no tiene imagen.
