# WiFi con un punto de acceso propio en cada nodo

El E1 (§4.3.2) descartó el WiFi para no cargar al nodo con una interfaz que no aporta a la distribución por LoRa. A pedido del docente a cargo, el panel de control se conecta a un nodo por USB o por WiFi. Para el WiFi, cada nodo levanta su propio punto de acceso con el SSID `J5-<id>`, donde `<id>` es el identificador del nodo. Así el nodo no depende de ninguna red externa.

El WiFi solo transporta los comandos y los eventos de la consola entre un nodo y el panel de control en una computadora. Los nodos nunca se comunican entre sí por WiFi: entre nodos solo hay LoRa.

## Opciones consideradas

- Modo estación sobre una red existente: el panel vería a todos los nodos a la vez, pero haría falta infraestructura y credenciales que no pueden quedar en el repositorio público.
- Ambos modos, con el punto de acceso como respaldo: suma configuración sin un caso de uso que hoy lo justifique.

## Consecuencias

- Una computadora ve un solo nodo por vez a través del WiFi y pierde la conexión a internet mientras está asociada a él.
- El consumo del nodo sube mientras el WiFi está activo.
- Cómo llega el panel al nodo a través de esa red está en la [ADR 0003](0003-control-panel-as-pwa-over-websocket.md).
