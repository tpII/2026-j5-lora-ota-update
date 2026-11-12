#ifndef J5_CONSOLE_COMMANDS_H
#define J5_CONSOLE_COMMANDS_H

#include <stddef.h>
#include <stdint.h>

#include "../console/command_line.h"
#include "../console/event_sink.h"
#include "../protocol/protocol_contract.h"
#include "../radio/radio_settings.h"
#include "node_services.h"

namespace firmware {

constexpr size_t ERROR_DETAIL_CAPACITY = 48;

// What the console commands ask of the node beyond its services: the radio, the WiFi and the
// reports that span the hardware. The other commands act on NodeServices directly. Commands that
// start or report timers get the clock reading of the pass of the main loop that runs them.
class CommandTarget {
public:
  virtual bool isRadioStarted() const = 0;
  // The settings that a radio change starts from: those that wait for the transmission in
  // progress to end, or else the current ones.
  virtual RadioSettings requestedRadioSettings() const = 0;

  virtual void reportStatus(uint32_t nowMillis) = 0;
  virtual void reportRadio() = 0;
  virtual void requestRadioSettings(const RadioSettings &settings) = 0;
  virtual void setWirelessEnabled(bool enabled) = 0;

protected:
  ~CommandTarget() = default;
};

class CommandInvocation;

// Runs one form of a command. The table of commands (CONSOLE_COMMANDS) comes from the protocol
// contract, and console_commands.cpp binds a handler to each of its actions.
using CommandHandler = void (*)(CommandInvocation &invocation);

struct CommandContext {
  CommandTarget &node;
  NodeServices &services;
  EventSink &events;
};

// The arguments of one command line and the errors of its command. Each read reports its own
// error, so a handler stops at the first read that returns false.
class CommandInvocation {
public:
  CommandInvocation(const ConsoleCommand &command, const CommandLine &line, uint32_t nowMillis,
                    const CommandContext &context)
      : command_(command), line_(line), nowMillis_(nowMillis), context_(context) {}

  CommandTarget &node() const { return context_.node; }
  NodeServices &services() const { return context_.services; }
  EventSink &events() const { return context_.events; }
  uint32_t nowMillis() const { return nowMillis_; }
  size_t argumentCount() const { return line_.wordCount() - 1; }
  const char *argument(size_t index) const { return line_.wordAt(index + 1); }

  // An unsigned number (console/argument_reader.h). Any other word is a usage error; a number
  // outside minimum..maximum is out_of_range, with the detail "<name> <minimum>..<maximum>".
  bool readUnsigned(size_t index, const char *name, uint32_t minimum, uint32_t maximum,
                    uint32_t &value);
  // A register value (console/argument_reader.h). Any other word is out_of_range, with the
  // accepted forms as detail.
  bool readRegisterValue(size_t index, int32_t &value);

  // usage, with the usage of the command as detail, followed by the qualification if any.
  void rejectUsage(const char *qualification = nullptr);
  void reject(ErrorReason reason, const char *detail = nullptr);

private:
  const ConsoleCommand &command_;
  const CommandLine &line_;
  uint32_t nowMillis_;
  const CommandContext &context_;
};

// Executes one console line, or reports why it cannot. overflowed tells that the transport cut a
// line longer than MAXIMUM_COMMAND_LINE_LENGTH. The line is split in place.
void executeCommandLine(char *line, bool overflowed, uint32_t nowMillis,
                        const CommandContext &context);

} // namespace firmware

#endif
