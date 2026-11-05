# Formato de la imagen y par de claves del operador por defecto

La imagen sigue el formato del E1: una cabecera de 9 bytes con el número mágico, las banderas, la versión de 32 bits y el largo del programa, seguida del programa y de la firma Ed25519 de 64 bytes. El número mágico ocupa 2 bytes, `J5` (`4A 35`), y no uno como decía el E1. La firma cubre la cabecera y el SHA-256 del programa, es decir, la versión, el tamaño y el hash, como prevé el E1. El firmware la verifica con libsodium, que ya viene compilado en el core de ESP32 3.3.12, y el panel firma con `crypto.subtle`. El formato está en [la imagen](../protocol/image.md).

La clave pública del operador se compila en el firmware igual que la clave de red ([ADR 0005](0005-frame-without-hop-count.md)), con un valor por defecto que se reemplaza en `firmware/build_opt.h`. El par por defecto está en el repositorio, con la clave privada en `keys/default_operator_key.pem`, para que cualquier integrante del grupo pueda firmar sin generar ni repartir claves. El evento `boot` indica si el nodo usa la clave por defecto.

## Opciones consideradas

- Firmar la cabecera y el programa enteros: es más simple, porque Ed25519 ya calcula su propio hash, pero se aparta del E1 sin ganar nada medible.
- Ningún par por defecto: cumple mejor el RF12, pero obliga a generar un par y a compilar cada placa con su clave pública antes de cargar la primera imagen.
- Monocypher o la biblioteca Crypto de Arduino: suman una dependencia que el core ya resuelve.

## Consecuencias

- Con el par por defecto, cualquiera que tenga el repositorio público puede firmar una imagen válida. Solo sirve para el banco; para una demostración con el RF12 hay que compilar otra clave pública.
- La generación y la distribución de las claves siguen fuera del alcance, como dice el E1.
