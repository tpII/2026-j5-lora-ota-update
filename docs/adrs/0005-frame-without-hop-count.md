# Trama sin contador de saltos y con la versión del protocolo dentro del HMAC

Cada trama lleva una cabecera de 8 bytes (tipo, origen, destino, época y secuencia) y termina con una etiqueta de 8 bytes: el comienzo del HMAC-SHA256 calculado con la clave de red. La época es un contador que el nodo guarda en NVS y que aumenta en cada arranque y cada vez que la secuencia da la vuelta. A diferencia de lo que el E1 preveía para la malla (§5.2), la trama no tiene un contador de saltos: cada nodo recuerda, por origen, la última época y la última secuencia vistas, y con eso decide si un paquete es nuevo o repetido y, cuando haya malla, si lo retransmite.

La versión del protocolo no ocupa lugar en la trama porque entra en el cálculo del HMAC. Un paquete armado con otra versión del protocolo falla la autenticación y se descarta como cualquier tráfico ajeno.

## Opciones consideradas

- Un byte de saltos restantes, como preveía el E1.
- Un byte de versión en la cabecera: hace explícita la incompatibilidad, pero cuesta un byte de aire en cada paquete.

## Consecuencias

- El cuerpo admite hasta 239 bytes (255 − 16).
- Sin contador de saltos, lo único que corta la propagación de un paquete en la malla es la deduplicación.
- Un paquete que llega después de otro posterior del mismo origen se toma como repetido, aunque no se haya visto antes.
