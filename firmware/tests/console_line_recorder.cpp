#include "console_line_recorder.h"

#include <cstdio>
#include <set>

// Function-local statics, so that they exist before the recorders of every file use them.
static std::vector<std::string> &recordedEventLines() {
  static std::vector<std::string> lines;
  return lines;
}

static std::set<std::string> &recordedEventSet() {
  static std::set<std::string> lines;
  return lines;
}

uint8_t RecordingEventOutput::writeLine(const char *line, size_t length) {
  const std::string text(line, length);
  lines.push_back(text);
  if (!text.empty() && text[0] == '{' && recordedEventSet().insert(text).second) {
    recordedEventLines().push_back(text);
  }
  return 0;
}

static std::string joinLines(const std::vector<std::string> &lines) {
  std::string joined;
  for (const std::string &line : lines) {
    if (!joined.empty()) {
      joined += '\n';
    }
    joined += line;
  }
  return joined;
}

std::string RecordingEventOutput::text() const { return joinLines(lines); }

std::string RecordingEventOutput::displayText() const { return joinLines(displayLines); }

std::vector<std::string> unrecordedConsoleEvents() {
  static const std::string EVENT_KEY = R"("ev":")";
  std::set<std::string> recorded;
  for (const std::string &line : recordedEventLines()) {
    const size_t start = line.find(EVENT_KEY);
    if (start != std::string::npos) {
      const size_t nameStart = start + EVENT_KEY.size();
      recorded.insert(line.substr(nameStart, line.find('"', nameStart) - nameStart));
    }
  }
  std::vector<std::string> missing;
  for (size_t index = 0; index < firmware::CONSOLE_EVENT_COUNT; ++index) {
    const char *name = firmware::consoleEventName(static_cast<firmware::ConsoleEvent>(index));
    if (recorded.count(name) == 0) {
      missing.push_back(name);
    }
  }
  return missing;
}

bool writeRecordedConsoleLines(const char *path) {
  FILE *file = std::fopen(path, "w");
  if (file == nullptr) {
    std::printf("Cannot write %s.\n", path);
    return false;
  }
  for (const std::string &line : recordedEventLines()) {
    std::fprintf(file, "%s\n", line.c_str());
  }
  return std::fclose(file) == 0;
}
