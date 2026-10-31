#ifndef J5_CONSOLE_LINE_LIMIT_H
#define J5_CONSOLE_LINE_LIMIT_H

#include <stddef.h>
#include <string.h>

#include "../configuration.h"

namespace firmware {

constexpr const char *PROGRAM_COMMAND_PREFIX = "load_program ";

// Longest line the console accepts, given the characters received so far: every command is
// limited to CONSOLE_LINE_CAPACITY except load_program, which carries a whole program.
inline size_t consoleLineLimit(const char *text, size_t length) {
  const size_t prefixLength = strlen(PROGRAM_COMMAND_PREFIX);
  if (length >= prefixLength && strncmp(text, PROGRAM_COMMAND_PREFIX, prefixLength) == 0) {
    return PROGRAM_LINE_CAPACITY;
  }
  return CONSOLE_LINE_CAPACITY;
}

} // namespace firmware

#endif
