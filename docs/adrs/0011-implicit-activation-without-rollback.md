# Activación implícita, ordenada por el operador y sin reversión automática

La orden de activar es la versión activa que anuncia el HELLO: un nodo que tiene v como versión disponible y escucha un HELLO que anuncia v como versión activa la activa. Lo mismo hace si completa la imagen de v cuando algún vecino de su tabla ya la anuncia como activa, sin esperar el HELLO siguiente. Cada nodo emite un HELLO apenas cambia su versión activa o su versión disponible. La primera activación la ordena el operador desde el panel, con un comando de consola al nodo conectado, que tiene que tener v disponible. El panel arma el grafo de conexiones con los HELLO y deshabilita la orden mientras algún nodo del grafo no anuncie v como versión disponible. El RF4 del E1 dejaba esa decisión al nodo origen; ahora la toma el operador, y el firmware no necesita saber cuál es el origen. Cargar la imagen en un nodo es, a la vez, la orden de propagarla.

Un nodo nunca vuelve por su cuenta a la versión anterior, a diferencia de la reversión automática que el E1 preveía para una versión que falla en su primer tick (§5.2). Cada falla termina el tick y el nodo sigue en la red (RF7). El HELLO lleva un byte con el estado de la VM: en los bits 0 a 2, el motivo de la última falla desde la activación (0 si no hubo ninguna); en el bit 3, si el último tick terminó en falla; los bits 4 a 7 quedan reservados. El protocolo tampoco tiene una orden de abortar: para abortar o revertir, el operador carga desde el panel una versión nueva, que puede llevar un programa anterior. Al firmar, el panel propone como versión la hora Unix UTC en segundos, y los nodos solo comparan cuál es mayor.

## Opciones consideradas

- Un mensaje de activación propio, repetido hasta que todos confirmen: es más rápido, pero un nodo que se reinicia mucho después igual necesita la regla implícita.
- Que el nodo origen active solo cuando todos sus vecinos tienen la versión disponible, como pedía el RF4: el grupo prefiere que el operador observe la red y decida.
- Una sola versión en el HELLO, con un bit de «en ejecución» o «esperando la orden»: ahorra 3 bytes, pero el panel no sabría qué versión ejecuta un nodo mientras espera la orden (RF10).
- Reversión automática después de una falla en el primer tick: con la activación implícita, el nodo revertido volvería a activar la versión al escuchar a sus vecinos, en ciclo.
- Un mensaje de revocación para abortar: la revocación se pierde al reiniciar y cualquiera con la clave de red podría usarla. Reemplazar la versión por una nueva deja en el operador la capacidad de autorizar (RF12).

## Consecuencias

- El firmware no impone el bloqueo del panel: desde la consola se puede activar antes, y así se cumple la activación forzada del RF5.
- Un nodo que estuvo fuera de alcance o que se reinició recibe la imagen disponible de sus vecinos por la regla de envío ([ADR 0010](0010-receiver-driven-repair.md)) y la activa cuando algún vecino la anuncia como activa; mientras tanto ejecuta el programa de fábrica. Si el nodo origen se reinicia antes de la activación, recupera la imagen de sus vecinos, y el operador puede dar la orden desde cualquier nodo.
- Para revertir sin tener el programa anterior, el panel necesita un comando de consola que devuelva el programa activo del nodo conectado, para volver a firmarlo con una versión nueva.
- Si la computadora del operador tiene la hora adelantada, esa versión les gana a todas las correctas hasta que se reinicie toda la red.
- M1 incluye la demora del operador en dar la orden. Por eso el panel la informa también separada en distribución, hasta que todos los nodos tienen la versión disponible, y activación, desde la orden.
- La activación avanza un salto por cada HELLO. Si se pierde el HELLO inmediato, ese vecino activa recién con el siguiente HELLO periódico.
- La carga sin cabecera ni firma con `load_program` ([ADR 0008](0008-register-virtual-machine.md)) queda reemplazada por la carga de imágenes firmadas.
