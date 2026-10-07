# Solo canales de 500 kHz en el aire

El RNF5 del E1 compromete la banda de 915 a 928 MHz como de uso libre. La Res. ENACOM 4653/2019 (anexo, §2.1) la habilita sin autorización individual en tres categorías:

- modulación digital de banda ancha, con un ancho a −6 dB de al menos 500 kHz: hasta 1 W conducido, 4 W de PIRE y 8 dBm cada 3 kHz;
- salto de frecuencia en 50 o más canales: hasta 1 W conducido y 4 W de PIRE;
- otros sistemas: hasta 200 µW de PIRE.

LoRa en un canal fijo de 125 o 250 kHz cae en la última categoría. Con una antena de 2 a 3 dBi admite unos −10 dBm conducidos, por debajo del mínimo de las dos placas: +2 dBm la V2 y unos +4 dBm la V4.3. Por eso, con antena solo se usan canales de 500 kHz, que entran como banda ancha. Van centrados entre 915,25 y 927,75 MHz y admiten unos 26 dBm como máximo en el conector de antena, por el límite de densidad espectral. Los canales de 125 y 250 kHz quedan para el banco, con cable coaxial y atenuadores o cargas de 50 Ω. Por ahora el firmware no impone estos límites y la responsabilidad es del operador; las restricciones se agregan después de las pruebas.

## Opciones consideradas

- Canal fijo de 125 kHz con un atenuador en cada nodo, para quedar debajo de 200 µW de PIRE: es legal, pero obliga a tener los atenuadores siempre puestos.
- Salto de frecuencia en 50 o más canales de 125 kHz: es legal a plena potencia, pero los nodos tienen que saltar sincronizados, y eso es un protocolo aparte.

## Consecuencias

- El grupo no tiene atenuadores, así que en el primer informe la prueba de capacidad se hace solo con 500 kHz. Las corridas con 125 y 250 kHz esperan a que los haya.
- No se midió el ancho a −6 dB de estas placas con 500 kHz. La pertenencia a la categoría de banda ancha se apoya en que LoRa de 500 kHz se usa así en el plan US915.
- La Res. 581-MM/2018, a la que remite la resolución, trata además la homologación de los equipos transmisores (artículo 4.3). No se verificó si estas placas están homologadas.
