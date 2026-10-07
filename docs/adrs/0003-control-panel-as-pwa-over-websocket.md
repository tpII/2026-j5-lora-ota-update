# Panel publicado como PWA que llega al nodo por WebSocket

El panel de control es una aplicación web estática publicada por HTTPS e instalable como PWA, tal como prevé el E1. Por USB usa Web Serial. Por WiFi, con la computadora asociada al punto de acceso del nodo ([ADR 0002](0002-wifi-access-point-per-node.md)), abre un WebSocket sin cifrar contra `ws://192.168.4.1`. Chrome lo permite desde una página segura gracias al permiso de acceso a la red local, que cubre WebSocket desde la versión 147 y acepta la opción `targetAddressSpace: "local"` desde la 154. Cada línea de la consola viaja como un mensaje de texto, así que los dos transportes comparten el mismo protocolo.

El nodo no sirve páginas: solo expone el WebSocket con `esp_http_server`, el servidor de ESP-IDF que ya incluye el core de Arduino. Ese servidor corre en su propia tarea, fijada al núcleo 0. Sus funciones de atención solo copian líneas a colas acotadas, y `loop()` las procesa y encola las respuestas. Así toda la lógica del nodo sigue en el bucle único que describe el E1.

## Opciones consideradas

- Que el nodo sirva el panel desde su flash: anda en cualquier navegador sin instalar nada, pero esa página no es un contexto seguro y pierde Web Serial, la instalación como PWA y la API criptográfica del navegador (`crypto.subtle`). Además, ata cada versión del panel a una del firmware.
- WebSocket cifrado (WSS) en el nodo: cuesta entre 40 y 45 KB de RAM por sesión, tarda entre 1,5 y 2 s en negociar y obliga a aceptar un certificado autofirmado.
- Otras bibliotecas: arduinoWebSockets bloquea `loop()` hasta 5 s; ESPAsyncWebServer ocupa casi el doble y tiene una fuga de memoria abierta; Mongoose es GPLv2 y no está en el gestor de bibliotecas de Arduino.

## Consecuencias

- El panel exige Chrome o Chromium 154 o posterior, y el operador acepta una vez por navegador el permiso de red local.
- Fuera de las tareas del core, la única que se suma es la del servidor, y nunca toca la radio ni el estado del nodo.
