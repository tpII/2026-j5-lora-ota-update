#ifndef J5_CONSOLE_LINE_RECORDER_H
#define J5_CONSOLE_LINE_RECORDER_H

#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

#include "console/event_sink.h"

// The console of a node under test: the lines it writes, the text of its OLED and the reading of
// its clock. Every event line of every recorder also goes to the record of the whole run, which
// run_host_tests.sh writes to firmware/protocol/test-vectors/firmware-console-lines.jsonl, so that
// the control panel checks with its parser every event the firmware emits in these tests.
class RecordingEventOutput : public firmware::EventOutput {
public:
  uint32_t millis = 0;
  std::vector<std::string> lines;
  std::vector<std::string> displayLines;

  uint32_t eventMillis() const override { return millis; }
  uint8_t writeLine(const char *line, size_t length) override;
  void showDebugText(const char *text) override { displayLines.push_back(text); }

  void clear() {
    lines.clear();
    displayLines.clear();
  }
  // The lines written since the last clear(), joined with "\n".
  std::string text() const;
  // The debug text shown on the OLED since the last clear(), joined with "\n".
  std::string displayText() const;
};

// A node console under test: the sink and the output it writes to.
struct RecordingConsole {
  RecordingEventOutput output;
  firmware::EventSink events;

  RecordingConsole() { events.begin(output); }
  void clear() { output.clear(); }
};

// Writes the distinct event lines of the run, in the order they first appeared, one per line.
// Returns false when the file cannot be written.
bool writeRecordedConsoleLines(const char *path);

// The events of the contract that no line of the run carries, which the panel would then never
// parse in its tests.
std::vector<std::string> unrecordedConsoleEvents();

#endif
