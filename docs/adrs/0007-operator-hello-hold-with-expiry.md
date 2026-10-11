# Suspensión de los HELLO a pedido del operador, con vencimiento

La prueba de comunicación mide un enlace con ecos y necesita el canal libre de HELLO, tanto para que no choquen con los ecos como para que ningún nodo cambie de modulación con tramas en vuelo. Hasta ahora el nodo solo suspendía sus HELLO durante una corrida. Se agrega el comando `presence off <segundos>`, que los suspende hasta `presence on` o hasta que vence el plazo, de 1 a 3600 s. El plazo es obligatorio: si el panel pierde la conexión en medio de una prueba, el nodo vuelve solo a anunciarse y la red no lo pierde para siempre.

La prueba se hace en campo, con un operador en cada nodo y cada uno conectado al suyo. Los operadores acuerdan la modulación y la coordinan a mano: uno pone su nodo en modo receptor y el otro, en modo emisor, pide los ecos. Cada panel suspende los HELLO y cambia la modulación solo de su propio nodo.

## Opciones consideradas

- Suspensión sin plazo: es más simple, pero un nodo que pierde la consola queda mudo hasta reiniciarse.
- Que el panel repita la suspensión cada pocos segundos: suma tráfico de consola y depende igual de que el panel siga conectado.
- Los dos nodos conectados al mismo panel, que cambia la modulación de ambos: no sirve en campo, donde los nodos están a distancia.
- Que el emisor coordine al vecino por LoRa: evita el segundo operador, pero hace falta un mensaje de configuración remota, que cualquiera con la clave de red podría usar para cambiar la radio de otro nodo.

## Consecuencias

- Hace falta un operador en cada nodo. El panel no puede comprobar que el vecino esté en modo receptor con la misma modulación; si no lo está, todos los ecos se pierden.
- El modo receptor mantiene la suspensión todo el tiempo que esté activo: pide el plazo máximo y el panel lo renueva cada 30 minutos.
- Si el panel pierde la conexión, los HELLO vuelven solos al vencer el plazo, pero la modulación de prueba queda hasta que se cambie desde Radio o se reinicie el nodo.
- Mientras dura la suspensión, el OLED tampoco se redibuja, para no demorar las respuestas de eco.
- Los nodos que no participan siguen enviando HELLO con la modulación de la red. Si la prueba usa esa misma modulación, pueden chocar con los ecos.
- Si la prueba dura más de 60 s, los vecinos que no participan dejan de listar a los dos nodos hasta el próximo HELLO.
