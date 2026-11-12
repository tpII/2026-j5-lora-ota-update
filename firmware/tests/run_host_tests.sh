#!/usr/bin/env bash
# Compiles and runs the host tests of the hardware-independent firmware modules: every .cpp file of
# src/ except those listed in HARDWARE_SOURCES, and every .cpp file of tests/.
#
# The tests write every event line they produce; the run fails when those lines leave out an event
# of the contract or differ from firmware/protocol/test-vectors/firmware-console-lines.jsonl, which the
# control panel parses in its tests.
#
# Usage: run_host_tests.sh [--print-compile-flags | --update-console-lines]
#   --print-compile-flags   prints the compiler options of the host tests, one per line, and exits;
#                           tools/generate_clangd_configuration.py reads them.
#   --update-console-lines  writes the event lines of the run to the file instead of comparing.
set -euo pipefail

TESTS_DIRECTORY="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FIRMWARE_DIRECTORY="$(dirname "${TESTS_DIRECTORY}")"
SOURCE_DIRECTORY="${FIRMWARE_DIRECTORY}/src"
CONSOLE_LINES_FILE="${FIRMWARE_DIRECTORY}/protocol/test-vectors/firmware-console-lines.jsonl"

# Sources that need the ESP32 core, its libraries or the board, relative to src/.
HARDWARE_SOURCES=(
  application/node_application.cpp
  board/heltec_v2.cpp
  board/heltec_v4_3.cpp
  console/console.cpp
  console/serial_transport.cpp
  console/wireless_transport.cpp
  display/debug_display.cpp
  network/node_identity.cpp
  radio/radio_link.cpp
)

# ArduinoJson is header-only. The host tests use the version that firmware/sketch.yaml pins, from
# the copy that mise run setup:firmware or a profile build downloads, or from the libraries of the
# IDE.
find_arduinojson_directory() {
  local versions
  versions="$(sed -n 's/^ *- ArduinoJson (\(.*\))$/\1/p' "${FIRMWARE_DIRECTORY}/sketch.yaml" | sort -u)"
  if [[ -z "${versions}" || "$(wc -l <<<"${versions}")" -ne 1 ]]; then
    echo "firmware/sketch.yaml must pin one ArduinoJson version for every profile." >&2
    return 1
  fi
  local candidate
  for candidate in "${HOME}"/.arduino15/internal/ArduinoJson_"${versions}"_*/ArduinoJson; do
    if [[ -f "${candidate}/src/ArduinoJson.h" ]]; then
      echo "${candidate}/src"
      return 0
    fi
  done
  candidate="${HOME}/Arduino/libraries/ArduinoJson"
  if grep -qx "version=${versions}" "${candidate}/library.properties" 2>/dev/null; then
    echo "${candidate}/src"
    return 0
  fi
  echo "ArduinoJson ${versions}, the version of firmware/sketch.yaml, is not installed: run" >&2
  echo "mise run setup:firmware, which installs what every profile pins." >&2
  return 1
}

ARDUINOJSON_DIRECTORY="$(find_arduinojson_directory)"

COMPILE_FLAGS=(
  -std=c++17
  -Wall
  -Wextra
  "-I${TESTS_DIRECTORY}/stubs"
  "-I${TESTS_DIRECTORY}"
  "-I${SOURCE_DIRECTORY}"
  "-I${ARDUINOJSON_DIRECTORY}"
)

UPDATE_CONSOLE_LINES=0
case "${1:-}" in
  "") ;;
  --print-compile-flags)
    printf '%s\n' "${COMPILE_FLAGS[@]}"
    exit 0
    ;;
  --update-console-lines) UPDATE_CONSOLE_LINES=1 ;;
  *)
    echo "Unknown option: $1" >&2
    exit 1
    ;;
esac

# The generated protocol sources must match firmware/protocol/contract.json and firmware/protocol/test-vectors.
node "${FIRMWARE_DIRECTORY}/../tools/generate_protocol_sources.mjs" --check

# The firmware takes libsodium from the ESP32 core; on the host computer, from the system.
if [[ ! -f /usr/include/sodium.h ]] && ! pkg-config --exists libsodium 2>/dev/null; then
  echo "libsodium not found: install it, for example with pacman -S libsodium" >&2
  echo "  or apt install libsodium-dev" >&2
  exit 1
fi

is_hardware_source() {
  local source="$1" hardware
  for hardware in "${HARDWARE_SOURCES[@]}"; do
    if [[ "${source}" == "${hardware}" ]]; then
      return 0
    fi
  done
  return 1
}

SOURCES=()
while IFS= read -r source; do
  if ! is_hardware_source "${source}"; then
    SOURCES+=("${SOURCE_DIRECTORY}/${source}")
  fi
done < <(cd "${SOURCE_DIRECTORY}" && find . -name '*.cpp' | sed 's|^\./||' | LC_ALL=C sort)

for hardware in "${HARDWARE_SOURCES[@]}"; do
  if [[ ! -f "${SOURCE_DIRECTORY}/${hardware}" ]]; then
    echo "run_host_tests.sh lists src/${hardware}, which does not exist." >&2
    exit 1
  fi
done

OUTPUT_DIRECTORY="$(mktemp -d)"
trap 'rm -rf "${OUTPUT_DIRECTORY}"' EXIT

# A switch over an enumeration of the contract that leaves out a value, such as a new key of the
# radio command or a new opcode, fails the build.
c++ "${COMPILE_FLAGS[@]}" -Werror=unused-function -Werror=switch \
  "${TESTS_DIRECTORY}"/*.cpp "${SOURCES[@]}" \
  -lsodium -o "${OUTPUT_DIRECTORY}/host_tests"

"${OUTPUT_DIRECTORY}/host_tests" "${OUTPUT_DIRECTORY}/console-lines.jsonl"

if [[ "${UPDATE_CONSOLE_LINES}" -eq 1 ]]; then
  cp "${OUTPUT_DIRECTORY}/console-lines.jsonl" "${CONSOLE_LINES_FILE}"
  echo "Wrote ${CONSOLE_LINES_FILE}."
elif ! diff -u "${CONSOLE_LINES_FILE}" "${OUTPUT_DIRECTORY}/console-lines.jsonl"; then
  echo "The event lines of the host tests differ from ${CONSOLE_LINES_FILE}." >&2
  echo "If the change is intended, run: firmware/tests/run_host_tests.sh --update-console-lines" >&2
  exit 1
fi
