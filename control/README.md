# Panel de control

Aplicación web con la que el operador maneja los nodos de la red J5. Se conecta a la consola de cada nodo por USB, con Web Serial, o por WiFi, con un WebSocket contra el punto de acceso del nodo. Muestra el flujo de eventos, los vecinos y los parámetros de radio, pide ecos, transmite corridas, ejecuta la prueba de capacidad y la prueba de comunicación, firma y carga imágenes, ordena su activación y exporta las mediciones con el formato de [`measurements/README.md`](../measurements/README.md). Es una aplicación de una sola página, estática e instalable como PWA ([ADR 0003](../docs/adrs/0003-control-panel-as-pwa-over-websocket.md)). El contrato con el firmware está en [`docs/protocol/console.md`](../docs/protocol/console.md).

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
- **Flujo de eventos**: las líneas de todos los nodos, con filtros por nodo y por tipo de evento. El JSON de los eventos aparece coloreado y el texto de depuración, atenuado. En pantallas de menos de 768 píxeles de ancho, como la de un celular, la hora, el nodo y el tipo de cada línea van en un renglón y el contenido en el de abajo. Desde esta sección también se envían comandos sueltos.
- **Vecinos**: lo que cada nodo sabe de sus vecinos a partir de `hello` y `neighbor`, incluido cómo escucha cada vecino a los suyos.
- **Radio**: un formulario por nodo, validado con los rangos de [`docs/protocol/radio.md`](../docs/protocol/radio.md) y del modelo de placa, con las advertencias de la [ADR 0004](../docs/adrs/0004-only-500-khz-channels-on-air.md). El selector del LNA de la V4.3 muestra el modo que informa el nodo pero está deshabilitado, porque con el LNA activo una señal fuerte puede dañar el SX1262; el modo solo se cambia desde la consola, con `radio lna`.
- **Eco**: ecos sueltos o en serie, con el RTT y la calidad en los dos sentidos.
- **Corridas**: corridas manuales y el resumen de todas las corridas de los nodos conectados.
- **Prueba de capacidad**: recorre una matriz de modulaciones y largos sobre dos nodos, con pausa, reanudación, avance y tiempo restante estimado. Por defecto mide de SF7 a SF12 a 500 kHz, CR 4/5, 239 bytes y 300 paquetes por punto.
- **Prueba de comunicación**: para el campo, con un operador en cada nodo y cada uno conectado al suyo. Los operadores acuerdan el SF, el ancho de banda y la tasa de código, y cada uno elige un modo:
  - **Receptor**: se activa antes de empezar y se desactiva al terminar. Al activarlo, el nodo suspende sus HELLO y aplica la modulación acordada; mientras está activo, el panel registra los ecos que responde, con la RSSI y la SNR de cada pedido. Al desactivarlo, el nodo vuelve a la modulación anterior y reanuda los HELLO.
  - **Emisor**: suspende sus HELLO, aplica la misma modulación, pide al vecino ecos de 4 bytes (100 por defecto) y al final vuelve a su modulación y reanuda los HELLO, aunque la prueba se detenga o falle. Muestra la RSSI y la SNR de ida y de vuelta, la entrega, el RTT y los bits útiles.

  Los dos modos exportan sus métricas a `measurements/` en una carpeta propia.

- **Actualización**: todo el ciclo de una imagen ([imagen](../docs/protocol/image.md), [ADR 0011](../docs/adrs/0011-implicit-activation-without-rollback.md)), contra el nodo conectado que se elige arriba:
  - **Clave del operador**: carga la clave privada Ed25519 desde un archivo PEM con formato PKCS#8 o genera un par nuevo. La clave queda solo en la memoria de la pestaña y el panel indica si es la del par por defecto. De un par generado muestra la clave pública, la línea de `firmware/build_opt.h` que la compila y un botón para descargar la clave privada, que no se guarda en ningún otro lado. Si el nodo informa en `boot` una clave del operador distinta de la cargada, el panel avisa que va a rechazar la firma, pero no impide la carga, para poder probar el rechazo.
  - **Firmar y cargar una imagen**: ensambla el programa del editor, que es el mismo de la pestaña Simulador, lo firma con la versión indicada y envía `load_image`. Propone como versión la hora Unix UTC en segundos y no deja firmar una versión que no sea mayor que la disponible del nodo; avisa si algún nodo del grafo ya tiene una mayor o si la versión supera la hora de la computadora. También fija y consulta el tamaño de fragmento con `fragment_size`. Debajo del selector del nodo, el panel muestra si el nodo aceptó la última imagen o el error con que la rechazó.
  - **Activación**: envía `activate <versión>` al nodo conectado. Propone la versión disponible más alta que algún nodo todavía no activó y habilita la orden solo cuando todos los nodos del grafo de conexiones la anuncian como disponible; si no, lista los que la bloquean y por qué. La activación forzada del RF5 envía la orden igual, desde un recuadro aparte y después de una confirmación que nombra los nodos que todavía no la tienen.
  - **Grafo de conexiones**: cada nodo con su fuente (consola, HELLO de un vecino o solo la lista de vecinos de otro nodo), la versión activa, la versión disponible, la recepción en curso de los nodos conectados y el estado de la VM; cada enlace con la RSSI y la SNR en los dos sentidos; y la actividad reciente de la transferencia en los nodos conectados: ráfagas, reportes, imágenes, rechazos y activaciones.
  - **Reversión**: pide el programa activo con `program` y lo vuelve a firmar con una versión nueva, igual que cualquier imagen que el panel firmó desde que se abrió. Cualquiera de esos programas también se puede llevar al editor, desensamblado.
  - **Métricas de la actualización**: M1, con su distribución y su activación, M2 y M3 de cada imagen cargada desde que se descartó el registro, recalculadas cada segundo mientras la pestaña está a la vista, y su exportación a `measurements/<AAAA-MM-DD>-update-<NN>/`.
- **VM**: el estado de la VM del nodo conectado, la carga de registros con `load_registers` y las salidas de cada PRINT. Los programas no se cargan en esta sección: llegan como imágenes firmadas, desde Actualización.
- **Simulador**: el intérprete de referencia, que ejecuta el programa del editor en la computadora.
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
    ├── nodes/                       conexión, estado derivado de cada nodo y grafo de conexiones
    ├── image/                       formato, firma, verificación y controles previos a la carga de las imágenes
    ├── radio/                       parámetros de radio y tiempo de aire
    ├── vm/                          ensamblador, desensamblador e intérprete de referencia de la VM
    ├── measurements/                corridas, pruebas de capacidad y de comunicación, eco, métricas de actualización y exportación
    ├── utils/                       formato de valores, textos de la interfaz y utilidades
    └── testing/                     sesiones grabadas y nodo simulado para las pruebas
public/                              íconos
```

La lógica vive en módulos de TypeScript puro, sin Svelte, con sus pruebas al lado (`*.test.ts`); los componentes solo presentan el estado. `$lib` apunta a `src/lib/`, como en SvelteKit, y está declarado en `vite.config.ts` y en `tsconfig.app.json`. El service worker corre en otro ámbito global, así que no lo revisa `tsconfig.app.json` sino `tsconfig.worker.json`, con los tipos de WebWorker.

## Dependencias

- Svelte 5 para la interfaz y Tailwind 4 para los estilos.
- Zod describe cada evento de la consola una sola vez, como esquema, en `lib/console/console-event.ts`; los tipos de TypeScript se infieren de esos esquemas. El panel importa la variante `zod/mini`, de la que el empaquetador conserva solo lo que se usa.
- vite-plugin-pwa y Workbox generan el manifiesto y el service worker. El manifiesto está en `vite.config.ts`.
- Shiki colorea el JSON del flujo de eventos, en `lib/console/console-line-highlighter.ts`. Se cargan solo la gramática de JSON y el tema `light-plus`, el tema claro de VS Code. La gramática viene precompilada (`@shikijs/langs-precompiled`), con sus expresiones regulares ya escritas para JavaScript, así que el motor que la ejecuta no necesita WebAssembly ni el conversor de expresiones de Oniguruma: el resaltador arranca en forma sincrónica y suma unos 39 KB comprimidos al panel. Cada línea coloreada se guarda en una caché, así que solo se procesan las líneas nuevas.
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
- La prueba de comunicación cambia solo el SF, el ancho de banda y la tasa de código. La frecuencia, el preámbulo y la palabra de sincronismo tienen que coincidir en los dos nodos, como en la red. Al terminar, cada modo devuelve a su nodo la modulación que informaba al empezar.
- En el emisor, la suspensión de los HELLO dura lo que tardaría la serie si se perdieran todos los ecos, más un minuto. En el receptor dura una hora y el panel la renueva cada 30 minutos mientras el modo siga activo. Si el panel pierde la conexión, los HELLO vuelven solos al vencer el plazo, pero la modulación de prueba queda hasta que se cambie desde Radio o se reinicie el nodo.
- El panel cuenta como actualización cada versión que un nodo acepta con `load_image`, es decir, cuando la consola de ese nodo responde con su evento `image` de la versión con `via` en `"console"`. M1 empieza en el primer `load_image` aceptado; un `load_image` rechazado no crea una actualización, aunque queda en `commands` de `metadata.json`. Descartar el registro de mediciones también olvida esos comandos.
- Una actualización termina con el primer `load_image` aceptado de otra versión. Sus nodos son los que nombran los eventos hasta que converge, sin los que nadie escuchó en los 60 s anteriores, como en el grafo de conexiones; un nodo que aparece después no la reabre. M2 descarta los contadores `tx` de los eventos `neighbor`, que repiten el de un HELLO anterior, y reconoce un reinicio por el cambio de época.
- La orden de activación se habilita con el grafo de conexiones del momento: un nodo vecino que nadie escuchó en los últimos 60 s sale del grafo y deja de bloquearla. Un nodo que solo aparece en la lista de vecinos de otro no tiene versiones conocidas y la bloquea.
- La versión 0 no tiene imagen, así que la reversión al programa de fábrica no es posible; el panel lo indica y sugiere cargar un programa con solo HALT.
- El panel no puede saber si el vecino está en modo receptor: si no lo está, o usa otra modulación, todos los ecos se pierden.

## Pruebas

Las pruebas no necesitan placas. Usan sesiones de consola grabadas en el formato del contrato y un par de nodos simulados que responden los comandos con las mismas líneas que el firmware. Cubren el análisis de líneas, el estado derivado de cada nodo, los resúmenes de corridas, la prueba de capacidad completa, la firma de imágenes contra el vector de prueba de OpenSSL, una actualización grabada con su reparación y su activación, el grafo de conexiones, las métricas M1 a M3 y su exportación, el desensamblador, la exportación y los dos transportes.
