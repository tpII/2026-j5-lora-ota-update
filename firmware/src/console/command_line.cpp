#include "command_line.h"

namespace firmware {

CommandLine::CommandLine(char *line) {
  char *position = line;
  while (*position != '\0') {
    while (*position == ' ') {
      ++position;
    }
    if (*position == '\0') {
      break;
    }
    if (wordCount_ < MAXIMUM_WORDS) {
      words_[wordCount_] = position;
    }
    ++wordCount_;
    while (*position != '\0' && *position != ' ') {
      ++position;
    }
    if (*position == ' ') {
      *position++ = '\0';
    }
  }
}

} // namespace firmware
