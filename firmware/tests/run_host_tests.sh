#!/usr/bin/env bash
# Compiles and runs the host tests of the hardware-independent firmware modules.
set -euo pipefail

TESTS_DIRECTORY="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_DIRECTORY="${TESTS_DIRECTORY}/../src"
OUTPUT_DIRECTORY="$(mktemp -d)"
trap 'rm -rf "${OUTPUT_DIRECTORY}"' EXIT

# ArduinoJson is header-only: use the copy that a profile build downloads, or the one of the IDE.
ARDUINOJSON_DIRECTORY="$(ls -d "${HOME}"/.arduino15/internal/ArduinoJson_*/ArduinoJson/src \
  "${HOME}"/Arduino/libraries/ArduinoJson/src 2>/dev/null | head -n 1 || true)"
if [[ -z "${ARDUINOJSON_DIRECTORY}" ]]; then
  echo "ArduinoJson not found: build a profile once, for example" >&2
  echo "  arduino-cli compile --profile heltec_v4_3 firmware" >&2
  exit 1
fi

c++ -std=c++17 -Wall -Wextra -DARDUINO_HELTEC_WIFI_LORA_32_V2 \
  -I"${TESTS_DIRECTORY}/stubs" -I"${SOURCE_DIRECTORY}" -I"${ARDUINOJSON_DIRECTORY}" \
  "${TESTS_DIRECTORY}/host_tests.cpp" \
  "${SOURCE_DIRECTORY}/console/event_fields.cpp" \
  "${SOURCE_DIRECTORY}/network/duplicate_filter.cpp" \
  "${SOURCE_DIRECTORY}/services/echo_service.cpp" \
  "${SOURCE_DIRECTORY}/services/presence_service.cpp" \
  "${SOURCE_DIRECTORY}/services/test_run_service.cpp" \
  "${SOURCE_DIRECTORY}/radio/time_on_air.cpp" \
  -o "${OUTPUT_DIRECTORY}/host_tests"

"${OUTPUT_DIRECTORY}/host_tests"
