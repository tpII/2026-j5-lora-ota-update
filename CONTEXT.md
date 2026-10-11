# J5 LoRa OTA Update

Peer-to-peer network of Heltec ESP32 boards with LoRa transceivers that distribute programs for a custom micro VM and activate them in a coordinated way. Course project for Taller de Proyecto II (UNLP, 2026), group J5. The plan agreed with the course is `docs/E1-J5.pdf`.

## Directives

These apply to every contributor, human or agent.

### Writing

- Documentation is written entirely in technical Argentine Spanish (es-AR): reports, ADRs, READMEs and protocol contracts.
  - No Oxford comma: Spanish does not put a comma before the final "y" of a list.
  - No grammatical structures carried over from English: no gratuitous passive voice ("fue diseñado por"), no gerunds used as adjectives ("un paquete conteniendo"), no possessives where Spanish uses articles, no Title Case in headings.
  - Regional vocabulary: "computadora" (not "ordenador"), "celular" (not "móvil"), "placa" (not "tarjeta").
  - Formal, impersonal register: never address the reader as "vos" (or "tú") and no colloquialisms such as "che".
- Code is written in English, and so are code comments, console commands and events and the text shown on the OLED display.
- The user interface of the control panel is written in Spanish, under the same rules as the documentation.
- File and directory names are in English, documents included.
- Names are chosen the way an IBM engineer of the 1990s would choose them: descriptive, formal and conventional; nothing colloquial, humorous or borrowed from modern chat culture. This applies to variables, functions, files, directories, scripts, branches and commits. Example: `deploy_dashboards.sh`, not `push_dashboards.sh`.

### Code style

- C and C++ follow the LLVM style with a 100-column limit, applied with clang-format through the `.clang-format` file at the repository root.
- C and C++ names follow the Arduino library style guide:
  - types and classes in `UpperCamelCase` (`RadioLink`);
  - functions, methods, variables and parameters in `lowerCamelCase` (`setOutputPower()`, `packetCount`);
  - `enum class` enumerators in `UpperCamelCase` (`BoardModel::HeltecV2`), because all-caps names collide with Arduino macros such as `INPUT` or `DEFAULT`;
  - `constexpr` constants in `UPPER_SNAKE_CASE`; macros only when unavoidable, prefixed with `J5_`;
  - file and directory names in lowercase snake_case, after the main class of the file (`radio_link.h` and `radio_link.cpp` hold `RadioLink`), with the files grouped in directories by responsibility;
  - a module starts with `begin()` and stops with `end()`;
  - all firmware code lives in the `firmware` namespace;
  - as the LLVM Coding Standards ask, functions and variables private to a file are `static`, and anonymous namespaces only enclose private type declarations, as small as possible.
- TypeScript and Svelte code in `control/` follows the usual conventions of those languages.

### Decisions

- Decisions that are hard to reverse, surprising without context and the result of a real trade-off are recorded as ADRs in `docs/adrs/`.
- Every deviation from the E1 is recorded in an ADR.
- ADRs are short documents in Spanish: a title and one to three paragraphs, with optional "Opciones consideradas" and "Consecuencias" sections. Files are named `NNNN-slug.md`, numbered in sequence, with an English slug.
- When an ADR is added or amended, the code it governs changes in the same commit. A code change that contradicts an ADR amends that ADR in the same commit.

### Version control

- Never commit or push unless explicitly asked to in the current request.
- Commit messages are a single line in English of the form `area: summary`, for example `firmware: add power sweep command`.

## Language

Each term gives the canonical English word (used in code) and the canonical Spanish word (used in documentation).

### Network

**Node** (es: *nodo*):
A board running the common firmware. All nodes are equivalent; none has a fixed role.
_Avoid_: device, master, slave, gateway

**Board** (es: *placa*):
The Heltec WiFi LoRa 32 hardware a node runs on. Exactly two board models exist in the network: V2 (ESP32 with SX1276) and V4.3 (ESP32-S3 with SX1262 and an external RF front-end).
_Avoid_: card, module; "version" for V2 and V4.3, a word reserved for programs (es: tarjeta, versión de placa)

**Neighbor** (es: *vecino*):
A node whose HELLO messages this node receives directly.
_Avoid_: peer

**Hello** (es: *HELLO* or *mensaje de presencia*):
The message each node broadcasts periodically with its identity, its state and how it hears each neighbor.
_Avoid_: beacon, heartbeat

**Epoch** (es: *época*):
A per-node counter, kept across reboots, that increases at every boot and whenever the packet sequence wraps around. Together with the source and the sequence it identifies a packet.
_Avoid_: boot count, generation

**Operator** (es: *operador*):
The person who loads programs from a computer. The only trusted source: only the operator's private key signs valid images.
_Avoid_: user, administrator

**Control panel** (es: *panel de control*):
The web application on the operator's computer that connects to a node over USB serial or WiFi.
_Avoid_: dashboard, frontend, app

**Event stream** (es: *flujo de eventos*):
The timestamped sequence of events a node emits for the operator. Every metric is derived from it.
_Avoid_: log, output

### What the network distributes

**Firmware** (es: *firmware*):
The native program of a board, built from a single source tree and flashed over USB. It never travels over LoRa.
_Avoid_: using it for VM programs

**Program** (es: *programa*):
VM bytecode. The only thing the network distributes and executes.
_Avoid_: firmware, code, application

**Image** (es: *imagen*):
A program packaged with its header. The unit that is signed, transferred and activated.
_Avoid_: binary, file

**Version** (es: *versión*):
A 32-bit number that identifies an image. Between two versions the higher one wins; two different images with the same version are a conflict.
_Avoid_: revision, build

### Radio

**Radio settings** (es: *parámetros de radio*):
The frequency, modulation, transmit power, preamble length and sync word of a node, plus the receiver LNA mode on the V4.3.
_Avoid_: RF parameters, configuration

**Modulation** (es: *modulación*):
Spreading factor, bandwidth and coding rate: the part of the radio settings that two nodes must share, together with the frequency, to hear each other. Transmit power is not part of it.
_Avoid_: data rate, profile

**Transmit power** (es: *potencia de transmisión*):
The power delivered at the antenna connector, in dBm, whatever the board model. The transceiver setting that produces it is an internal detail.
_Avoid_: using it for the transceiver setting

### Radio measurements

**Power sweep** (es: *barrido de potencia*):
A test that keeps the modulation fixed, steps the transmit power of one board and records RSSI, SNR and packet delivery ratio at the other, for each direction and each pair of board models.
_Avoid_: range test, power test

**Capacity test** (es: *prueba de capacidad*):
A test that, for a given modulation and payload size, transmits packets back to back and measures goodput, packet delivery ratio and time on air against the Semtech formula.
_Avoid_: throughput test

**Communication test** (es: *prueba de comunicación*):
A field test with one operator at each node: both operators agree on a modulation, one node enters receiver mode and the other, in sender mode, asks it for a series of minimum-length echoes. It records RSSI and SNR in both directions, delivery, round-trip time and useful bits. While it lasts, both nodes hold their HELLO messages; afterwards each returns to its previous modulation.
_Avoid_: link test, ping test

**Channel capacity** (es: *capacidad del canal*):
The highest sustained goodput with a packet delivery ratio of at least 99 % for a given modulation.
_Avoid_: bandwidth, bitrate, throughput

**Test run** (es: *corrida*):
One numbered execution, with fixed radio settings, of a step of a power sweep or a point of a capacity test.
_Avoid_: benchmark, trial
