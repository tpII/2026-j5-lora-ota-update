#!/usr/bin/env bash
# Compiles and runs the host tests of the hardware-independent firmware modules.
set -euo pipefail

TESTS_DIRECTORY="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_DIRECTORY="${TESTS_DIRECTORY}/../src"
OUTPUT_DIRECTORY="$(mktemp -d)"
trap 'rm -rf "${OUTPUT_DIRECTORY}"' EXIT

c++ -std=c++17 -Wall -Wextra -DARDUINO_HELTEC_WIFI_LORA_32_V2 \
  -I"${TESTS_DIRECTORY}/stubs" -I"${SOURCE_DIRECTORY}" \
  "${TESTS_DIRECTORY}/host_tests.cpp" \
  "${SOURCE_DIRECTORY}/network/duplicate_filter.cpp" \
  "${SOURCE_DIRECTORY}/services/echo_service.cpp" \
  "${SOURCE_DIRECTORY}/services/presence_service.cpp" \
  "${SOURCE_DIRECTORY}/services/test_run_service.cpp" \
  "${SOURCE_DIRECTORY}/radio/time_on_air.cpp" \
  -o "${OUTPUT_DIRECTORY}/host_tests"

"${OUTPUT_DIRECTORY}/host_tests"
