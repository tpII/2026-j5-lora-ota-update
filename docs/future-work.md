# Trabajo futuro

Ideas y tareas que se postergaron a propósito, cada una con la decisión que la originó.

## Retransmisión en la malla

Para el segundo informe, con tres o más nodos. El filtro de repetidos por origen, época y secuencia ya existe ([ADR 0005](adrs/0005-frame-without-hop-count.md)). Con la malla, cada nodo retransmitiría una sola vez cada paquete ajeno nuevo, después de una espera aleatoria que evite choques con otros retransmisores. Conviene sumarla con un parámetro de consola que la active, apagado por defecto mientras se prueba. Como la trama no tiene contador de saltos, la deduplicación es lo único que corta la propagación.

## Restricciones regulatorias en el firmware

Después de las pruebas de radio, el firmware debería hacer cumplir la Res. ENACOM 4653/2019 ([ADR 0004](adrs/0004-only-500-khz-channels-on-air.md)). La idea es un parámetro que indique si el nodo tiene antena o carga. Con antena, el firmware rechazaría 125 y 250 kHz y limitaría la potencia a unos 26 dBm.

## M1 con la transferencia

M1 se mide recién cuando exista la transferencia de imágenes ([ADR 0006](adrs/0006-convergence-time-deferred.md)).

## Corridas de capacidad con 125 y 250 kHz

Quedan para cuando el grupo tenga atenuadores o cargas de 50 Ω ([ADR 0004](adrs/0004-only-500-khz-channels-on-air.md)).
