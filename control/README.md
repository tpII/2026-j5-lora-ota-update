# Panel de control

Aplicación web con la que el operador maneja los nodos de la red J5. Se conecta a la consola de cada nodo por USB, con Web Serial, o por WiFi, con un WebSocket contra el punto de acceso del nodo. Muestra el flujo de eventos, los vecinos y los parámetros de radio, pide ecos, transmite corridas, ejecuta la prueba de capacidad y exporta las mediciones con el formato de [`measurements/README.md`](../measurements/README.md). Es una aplicación de una sola página, estática e instalable como PWA ([ADR 0003](../docs/adrs/0003-control-panel-as-pwa-over-websocket.md)). El contrato con el firmware está en [`docs/protocol/console.md`](../docs/protocol/console.md).

## Requisitos

- Chrome o Chromium 154 o posterior. Otros navegadores no ofrecen Web Serial ni la opción `targetAddressSpace` del WebSocket.
- Web Serial solo funciona en un contexto seguro: el panel tiene que estar servido por HTTPS o desde `localhost`. Sin Web Serial, el panel lo indica y deja disponible solo la conexión por WiFi.
- Para conectar por WiFi, la computadora se asocia a la red `J5-<id>` del nodo ([ADR 0002](../docs/adrs/0002-wifi-access-point-per-node.md)). La primera vez, el navegador pide el permiso de acceso a la red local, que hay que aceptar.
- Para desarrollar: Vite+ 1.0 (el comando `vp`), que administra Node.js y pnpm.

## Uso

```sh
vp install        # instala las dependencias
vp dev            # servidor de desarrollo en http://localhost:5173
vp build          # compila la versión de producción en dist/
vp preview        # sirve dist/ para probarla
vp test           # corre las pruebas
vp check          # revisa formato, lint y tipos del código TypeScript
vp run typecheck  # revisa los tipos de los componentes Svelte con svelte-check
```

El service worker solo se registra en la versión de producción, así que el funcionamiento sin red se prueba con `vp build` y `vp preview`.

## Secciones

- **Nodos conectados**: un recuadro por conexión con el identificador, el modelo de placa, el transporte, un resumen de la radio, los clientes WiFi y la actividad en curso. Al abrir una conexión, el panel envía `status` para conocer el identificador del nodo.
- **Flujo de eventos**: las líneas de todos los nodos, con filtros por nodo y por tipo de evento. El texto de depuración aparece atenuado. Desde esta sección también se envían comandos sueltos.
- **Vecinos**: lo que cada nodo sabe de sus vecinos a partir de `hello` y `neighbor`, incluido cómo escucha cada vecino a los suyos.
- **Radio**: un formulario por nodo, validado con los rangos de [`docs/protocol/radio.md`](../docs/protocol/radio.md) y del modelo de placa, con las advertencias de la [ADR 0004](../docs/adrs/0004-only-500-khz-channels-on-air.md).
- **Eco**: ecos sueltos o en serie, con el RTT y la calidad en los dos sentidos.
- **Corridas**: corridas manuales y el resumen de todas las corridas de los nodos conectados.
- **Prueba de capacidad**: recorre una matriz de modulaciones y largos sobre dos nodos, con pausa, reanudación, avance y tiempo restante estimado. Por defecto mide de SF7 a SF12 a 500 kHz, CR 4/5, 239 bytes y 300 paquetes por punto.
- **Exportar**: la ficha de la medición y la exportación. Con la API File System Access, el panel pide la carpeta `measurements/` y crea dentro la subcarpeta con el número siguiente; sin ella, descarga los tres archivos.

## Estructura

```
src/
├── main.ts                          punto de entrada
├── App.svelte                       raíz de la interfaz, con las pestañas
├── app.css                          estilos globales y Tailwind
├── service-worker-registration.ts   registro del service worker
├── types/                           declaraciones de Web Serial y File System Access
└── lib/                             el resto del código, importado con el alias $lib
    ├── components/                  componentes Svelte; sections/ tiene uno por pestaña
    ├── state/                       estado reactivo de la aplicación (.svelte.ts)
    ├── console/                     eventos, comandos y lectura de líneas de la consola
    ├── transports/                  Web Serial y WebSocket detrás de una misma interfaz
    ├── nodes/                       conexión y estado derivado de cada nodo
    ├── radio/                       parámetros de radio y tiempo de aire
    ├── measurements/                corridas, prueba de capacidad, eco y exportación
    ├── utils/                       formato de valores, textos de la interfaz y utilidades
    └── testing/                     sesiones grabadas y nodo simulado para las pruebas
public/                              manifiesto, íconos y service worker
```

La lógica vive en módulos de TypeScript puro, sin Svelte, con sus pruebas al lado (`*.test.ts`); los componentes solo presentan el estado. `$lib` apunta a `src/lib/`, como en SvelteKit, y está declarado en `vite.config.ts` y en `tsconfig.app.json`.

## Criterios ante huecos del contrato

- Un receptor que no oye ningún paquete de una corrida nunca la abre, así que no emite `run_end`. Si ese nodo estaba conectado al panel y escuchaba en el canal del emisor, el panel cierra la recepción con cero paquetes, PDR 0 y motivo `timeout` una vez que vence el plazo del receptor. La prueba de capacidad hace lo mismo al terminar cada punto.
- El firmware escribe `null` en `rssi_avg`, `rssi_min`, `rssi_max` y `snr_avg` de `run_end` cuando no hay paquetes; el panel lo acepta y deja vacías esas columnas de `summary.csv`.
- Una línea que empieza con `{` pero no es JSON válido se toma como texto de depuración. Un objeto JSON con un evento desconocido o con campos inválidos se muestra como objeto no reconocido y se exporta igual. Los motivos de `error` que el panel no conoce se aceptan.
- Cada línea de `events.jsonl` es el texto exacto que emitió el firmware con `node` y `host_time` agregados al final.
- En `metadata.json`, `operators` es un texto libre y `date` lleva el desplazamiento horario de la computadora.
- El número `<NN>` de una exportación es el siguiente al mayor que ya existe para esa fecha y esa prueba.
- La prueba de capacidad envía a los dos nodos la frecuencia, la modulación, el preámbulo y la palabra de sincronismo de cada punto; la potencia y el LNA quedan como estén.

## Pruebas

Las pruebas no necesitan placas. Usan sesiones de consola grabadas en el formato del contrato y un par de nodos simulados que responden los comandos con las mismas líneas que el firmware. Cubren el análisis de líneas, el estado derivado de cada nodo, los resúmenes de corridas, la prueba de capacidad completa, la exportación y los dos transportes.
