#ifndef J5_COMMAND_LINE_H
#define J5_COMMAND_LINE_H

#include <stddef.h>

#include "../protocol/protocol_contract.h"

namespace firmware {

// Longest console line a transport accepts: the longest that any command allows, which is a whole
// image. The command layer enforces the limit of each command (application/console_commands.h).
constexpr size_t MAXIMUM_COMMAND_LINE_LENGTH = IMAGE_LINE_CAPACITY;

// The words of a console command line (docs/protocol/console.md, "Comandos"): text separated by
// one or more spaces. The first word names the command and the others are its arguments.
class CommandLine {
public:
  // Words kept from one line; console_commands.cpp checks that every command fits.
  static constexpr size_t MAXIMUM_WORDS = 17;

  // Splits the line in place: the space after each word becomes '\0'. Words beyond MAXIMUM_WORDS
  // still count in wordCount(), so a line with too many words can be refused.
  explicit CommandLine(char *line);

  size_t wordCount() const { return wordCount_; }
  // A kept word: index below wordCount() and below MAXIMUM_WORDS.
  const char *wordAt(size_t index) const { return words_[index]; }
  // The command word, or an empty text for a line without words.
  const char *commandWord() const { return wordCount_ > 0 ? words_[0] : ""; }

private:
  const char *words_[MAXIMUM_WORDS] = {};
  size_t wordCount_ = 0;
};

} // namespace firmware

#endif
