# Fragmentos autodescriptos con tamaño elegido en cada transferencia

Una imagen (cabecera, hasta 1024 bytes de programa y la firma Ed25519 de 64 bytes) ocupa alrededor de 1,1 KB, y el cuerpo de una trama admite 239 bytes, así que la imagen viaja dividida en fragmentos. Cada fragmento empieza con una cabecera de 8 bytes: la versión de la imagen (4 bytes) y, con un byte cada uno, el índice del fragmento, la cantidad de fragmentos de la imagen, el tamaño del fragmento y la cantidad de fragmentos que le quedan a la ráfaga. Le siguen hasta 231 bytes de la imagen. Cualquier fragmento alcanza para que el receptor sepa dónde va cada byte y cuántos fragmentos le faltan, así que no hace falta un anuncio previo ni un intercambio de inicio. Todos los fragmentos van dirigidos a `FFFF`. Solo se fragmentan las imágenes: HELLO, ECHO y TEST siguen entrando en una trama.

El tamaño del fragmento lo elige, en cada transferencia, el nodo que envía la imagen, con un parámetro de consola: 231 bytes por defecto y 32 como mínimo. Las PDR de campo del E2 se midieron con tramas de 20 bytes, y la prueba de capacidad, con tramas de 255 bytes, se hizo sobre la mesa. Todavía no se sabe cuánto influye el largo de la trama con señal débil. Con el tamaño como parámetro, una salida a campo puede comparar fragmentos largos y cortos sin cambiar el protocolo.

## Opciones consideradas

- Un anuncio separado antes de cada ráfaga, con el tamaño y la cantidad de fragmentos: con una pérdida de hasta el 50 %, la mitad de las veces el receptor recibe fragmentos que no puede ubicar.
- Un anuncio con confirmación, como `FragSessionSetupReq` y `FragSessionSetupAns` de LoRaWAN (TS004): LoRaWAN lo necesita porque su fragmento lleva solo la sesión y el índice. Con un 50 % de pérdida en cada sentido, el anuncio y su confirmación llegan juntos una de cada cuatro veces.
- El anuncio dentro del fragmento 0: falla igual cuando se pierde ese fragmento.
- Un tamaño fijo: el máximo reduce la sobrecarga y uno chico pierde menos tramas con señal débil, pero cualquiera de los dos impide medir la diferencia.

## Consecuencias

- Cada fragmento suma 24 bytes de sobrecarga (16 de la trama y 8 de su cabecera), alrededor del 9 % con el tamaño máximo. Una imagen de 1,1 KB ocupa 5 fragmentos, unos 0,5 s de aire a SF7 y 500 kHz.
- Con fragmentos de 32 bytes, una imagen llega a 35 fragmentos y su mapa de bits, a 5 bytes ([ADR 0010](0010-receiver-driven-repair.md)).
- El tamaño exacto de la imagen se conoce con el último fragmento. Antes, la cantidad y el tamaño de los fragmentos dan una cota superior.
- Los fragmentos y los demás cambios de la transferencia forman la versión 2 del protocolo, y todas las placas tienen que regrabarse.
