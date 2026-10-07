# Placas Heltec V2 y V4.3 en la misma red

El E1 preveía dos placas Heltec WiFi LoRa 32 V2. El grupo trabaja en cambio con placas V2 (ESP32 y SX1276) y V4.3 (ESP32-S3, SX1262 y una etapa de RF externa) mezcladas en la misma red, y esos son los únicos dos modelos soportados. Como los microcontroladores son distintos, un mismo binario no puede correr en las dos placas: el RNF3 («todos los nodos deben correr el mismo firmware») se cumple con un único código fuente que se compila una vez por modelo, cada una con su perfil de `firmware/sketch.yaml`.

## Opciones consideradas

- Usar un solo modelo en toda la red: simplifica el firmware y las mediciones, pero deja afuera placas disponibles y la comparación entre transceptores distintos.

## Consecuencias

- Los dos transceptores tienen que configurarse con parámetros compatibles para escucharse, y sus rangos de potencia de transmisión difieren. Ambas cosas se fijan en los contratos de `docs/protocol/`.
- Las pruebas de radio se hacen para cada par de modelos y en ambos sentidos, porque el enlace entre una V2 y una V4.3 puede ser asimétrico.
- El perfil de la V4.3 fija las opciones de USB que hacen falta para que la consola salga por el puerto USB. Desde el IDE de Arduino hay que elegirlas a mano.
