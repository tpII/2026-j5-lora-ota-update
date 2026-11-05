# Trabajo futuro

Ideas y tareas que se postergaron a propósito, cada una con la decisión que la originó.

## Retransmisión en la malla

Para el segundo informe, con tres o más nodos. El filtro de repetidos por origen, época y secuencia ya existe ([ADR 0005](adrs/0005-frame-without-hop-count.md)). Con la malla, cada nodo retransmitiría una sola vez cada paquete ajeno nuevo, después de una espera aleatoria que evite choques con otros retransmisores. Conviene sumarla con un parámetro de consola que la active, apagado por defecto mientras se prueba. Como la trama no tiene contador de saltos, la deduplicación es lo único que corta la propagación.

No todos los tipos se retransmiten. TEST no se retransmite: una corrida mide un único enlace. ECHO, en cambio, tendría que retransmitirse para medir M4 según la cantidad de saltos, como prevé el E1. Un paquete retransmitido tiene que distinguirse de uno escuchado en forma directa, porque hoy la trama no indica qué nodo la emitió por última vez: el receptor anotaría como vecino al origen lejano, con el RSSI del nodo que retransmitió, y lo mantendría en la tabla mientras le siguieran llegando paquetes suyos por otro camino. Un campo de la trama con el último nodo que la emitió lo resolvería para todos los tipos. Otra idea es que el HELLO, y solo él, acumule la cadena de nodos que lo retransmitieron. Cualquiera de las dos obligaría a enmendar la ADR 0005.

Con dos nodos, el panel arma el grafo de conexiones con la tabla de vecinos del nodo conectado y con la lista de vecinos que trae el HELLO de cada uno, lo que alcanza para ver hasta dos saltos. Más lejos hacen falta HELLO retransmitidos. Para el grafo alcanzan esas listas de vecinos, siempre que lleguen los HELLO de todos los nodos: la cadena de retransmisores solo mostraría el camino de la primera copia, porque el filtro de repetidos descarta las demás. El bloqueo de la activación en el panel ([ADR 0011](adrs/0011-implicit-activation-without-rollback.md)) pasaría a abarcar también a los nodos que el panel conoce por HELLO retransmitidos.

## Supresión de envíos en la malla

Con tres o más nodos, varios nodos pueden responder a la vez al mismo HELLO, y los que completan una imagen con la misma ráfaga la reenvían casi juntos ([ADR 0010](adrs/0010-receiver-driven-repair.md)). La idea es que cada nodo espere un tiempo aleatorio, proporcional al tiempo de aire de un fragmento, y cancele el envío si en ese lapso escucha fragmentos de la misma versión enviados por otro nodo. El HELLO del vecino que siga sin la imagen vuelve a disparar el envío. Una variante más fina no cancela si el nodo que transmite no figura en la lista de vecinos del que necesita la imagen, a costa de guardar las listas de vecinos de cada vecino. La detección de actividad de canal de RadioLib (`scanChannel()`) puede sumarse para escuchar el canal antes de transmitir.

## Conflictos de versión (RF6)

Hoy no se detectan dos imágenes distintas con la misma versión ([ADR 0010](adrs/0010-receiver-driven-repair.md)). Con la hora Unix como versión, solo aparecen si dos operadores cargan programas distintos en el mismo segundo o si la versión se edita a mano. La idea es una etiqueta de 2 bytes, el comienzo del SHA-256 de la imagen, en cada fragmento y en el HELLO junto a la versión disponible. El receptor no mezclaría imágenes, y el panel podría marcar el conflicto y bloquear la activación.

## Resultados de la VM desde cualquier nodo

El RF1 pide que los resultados de cada nodo se vean desde una computadora conectada a cualquier nodo, y el RF8 y M5 piden compararlos con el intérprete de referencia según el programa y la versión que cada nodo tiene activos. Hoy los `PRINT` salen solo por la consola y el OLED del nodo que ejecuta el programa. El E1 los ponía en el HELLO, pero el HELLO tiene que seguir siendo corto ([ADR 0010](adrs/0010-receiver-driven-repair.md)) y un tick puede ejecutar muchos `PRINT`. Las fallas ya viajan en el byte de estado de la VM del HELLO ([ADR 0011](adrs/0011-implicit-activation-without-rollback.md)). Cada resultado que viaje por LoRa tiene que indicar la versión activa y el tick que lo produjeron. Quedan por discutir estas opciones:

- Un mensaje propio por tick con los valores de los `PRINT`, sin reparación: se pierde con la misma probabilidad que cualquier otro paquete.
- Los cuatro registros al terminar cada tick, 16 bytes: como la VM es determinista, el panel puede ejecutar el tick siguiente desde esos registros y compararlo con los que el nodo informe después.
- Una consulta del panel a un nodo remoto por LoRa: solo lee, pero suma un mensaje de pedido entre nodos.

## Pérdida según el tamaño del fragmento

Las PDR de campo del E2 se midieron con tramas de 20 bytes, y la prueba de capacidad con tramas de 255 bytes se hizo sobre la mesa ([ADR 0009](adrs/0009-self-describing-fragments.md)). Falta una salida a campo que compare, en un mismo punto y con señal débil, la pérdida de fragmentos de 231 bytes y de 32 a 64 bytes, con el parámetro de consola del tamaño del fragmento. El resultado define el tamaño por defecto y si conviene ajustarlo según la modulación.

## Restricciones regulatorias en el firmware

Después de las pruebas de radio, el firmware debería hacer cumplir la Res. ENACOM 4653/2019 ([ADR 0004](adrs/0004-only-500-khz-channels-on-air.md)). La idea es un parámetro que indique si el nodo tiene antena o carga. Con antena, el firmware rechazaría 125 y 250 kHz y limitaría la potencia a unos 26 dBm.
