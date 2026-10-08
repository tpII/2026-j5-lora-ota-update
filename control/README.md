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
vp run typecheck  # revisa los tipos de los componentes Svelte, de vite.config.ts y del service worker
```

El service worker solo se registra en la versión de producción, así que el funcionamiento sin red se prueba con `vp build` y `vp preview`.

## Publicación

El panel se publica en Cloudflare como un Worker con activos estáticos, sin código propio del lado del servidor: Cloudflare sirve los archivos de `dist/` por HTTPS, que es lo que exigen Web Serial y la instalación como PWA ([ADR 0003](../docs/adrs/0003-control-panel-as-pwa-over-websocket.md)). La configuración está en `wrangler.jsonc` y Wrangler, la herramienta de línea de comandos de Cloudflare, es una dependencia de desarrollo.

```sh
vp exec wrangler login   # una sola vez por computadora: abre el navegador y autoriza la cuenta
vp run deploy            # compila y publica dist/
```

- La primera publicación crea el Worker `j5-control-panel` en la cuenta y lo deja en `https://j5-control-panel.<subdominio>.workers.dev`; Wrangler muestra la dirección al terminar. Las siguientes reemplazan la versión publicada.
- Cualquier otra ruta devuelve `index.html` (`not_found_handling`), así un enlace a una ruta vieja sigue abriendo el panel.
- Un dominio propio se agrega desde el panel de Cloudflare, en la configuración del Worker, o con `routes` en `wrangler.jsonc`.
- Antes de publicar conviene correr `vp test`, `vp check` y `vp run typecheck`, que el script no ejecuta.
- El plan gratuito de Workers sirve activos estáticos sin límite de tráfico.

Como alternativa, Cloudflare puede compilar y publicar desde el repositorio en cada _push_ (Workers Builds). En ese caso, el directorio raíz es `control`, el comando de compilación es `pnpm build` y el de publicación es `pnpm exec wrangler deploy`.

## Funcionamiento sin red

El panel tiene que abrir aunque la computadora esté asociada al punto de acceso de un nodo y no tenga internet. El service worker de `src/service-worker.ts` usa Workbox:

- Al instalarse guarda la página, los archivos de `assets/`, el manifiesto y los íconos de esa compilación. vite-plugin-pwa escribe esa lista en el service worker al compilarlo.
- Cada navegación va primero a la red, con un plazo de 3 s. Si la red falla o no responde a tiempo, entrega la página guardada. Así, siempre que el servidor esté al alcance, el panel muestra la última versión.
- Los demás archivos guardados salen de la caché. Una compilación nueva trae otro service worker, que reemplaza todo lo guardado la primera vez que el panel se abre con red.
- Las conexiones WebSocket y los pedidos a otros orígenes no pasan por el service worker.

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
├── service-worker.ts                service worker, que compila vite-plugin-pwa
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
public/                              íconos
```

La lógica vive en módulos de TypeScript puro, sin Svelte, con sus pruebas al lado (`*.test.ts`); los componentes solo presentan el estado. `$lib` apunta a `src/lib/`, como en SvelteKit, y está declarado en `vite.config.ts` y en `tsconfig.app.json`. El service worker corre en otro ámbito global, así que no lo revisa `tsconfig.app.json` sino `tsconfig.worker.json`, con los tipos de WebWorker.

## Dependencias

- Svelte 5 para la interfaz y Tailwind 4 para los estilos.
- Zod describe cada evento de la consola una sola vez, como esquema, en `lib/console/console-event.ts`; los tipos de TypeScript se infieren de esos esquemas. El panel importa la variante `zod/mini`, de la que el empaquetador conserva solo lo que se usa.
- vite-plugin-pwa y Workbox generan el manifiesto y el service worker. El manifiesto está en `vite.config.ts`.
- `@types/w3c-web-serial` y `@types/wicg-file-system-access` declaran Web Serial y el selector de carpetas de File System Access, que la biblioteca DOM de TypeScript todavía no incluye. `tsconfig.app.json` los incluye en `types`.

## Criterios ante huecos del contrato

- Un receptor que no oye ningún paquete de una corrida nunca la abre, así que no emite `run_end`. Si ese nodo estaba conectado al panel y escuchaba en el canal del emisor, el panel cierra la recepción con cero paquetes, PDR 0 y motivo `timeout` una vez que vence el plazo del receptor. La prueba de capacidad hace lo mismo al terminar cada punto.
- El firmware escribe `null` en `rssi_avg`, `rssi_min`, `rssi_max` y `snr_avg` de `run_end` cuando no hay paquetes; el panel lo acepta y deja vacías esas columnas de `summary.csv`.
- Una línea que empieza con `{` pero no es JSON válido se toma como texto de depuración. Un objeto JSON con un evento desconocido o con campos inválidos se muestra como objeto no reconocido, con la descripción del primer campo que no cumple el contrato, y se exporta igual. Los motivos de `error` que el panel no conoce se aceptan.
- Los campos numéricos aceptan cualquier número finito, con decimales o sin ellos: el firmware escribe un valor entero sin decimales, por ejemplo `-35`. Un campo opcional que llega en `null` se toma como ausente.
- Cada línea de `events.jsonl` es el texto exacto que emitió el firmware con `node` y `host_time` agregados al final.
- En `metadata.json`, `operators` es un texto libre y `date` lleva el desplazamiento horario de la computadora.
- El número `<NN>` de una exportación es el siguiente al mayor que ya existe para esa fecha y esa prueba.
- La prueba de capacidad envía a los dos nodos la frecuencia, la modulación, el preámbulo y la palabra de sincronismo de cada punto; la potencia y el LNA quedan como estén.

## Pruebas

Las pruebas no necesitan placas. Usan sesiones de consola grabadas en el formato del contrato y un par de nodos simulados que responden los comandos con las mismas líneas que el firmware. Cubren el análisis de líneas, el estado derivado de cada nodo, los resúmenes de corridas, la prueba de capacidad completa, la exportación y los dos transportes.
