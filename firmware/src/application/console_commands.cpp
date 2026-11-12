#include "console_commands.h"

#include <stdio.h>
#include <string.h>

#include "../console/argument_reader.h"
#include "radio_command.h"

namespace firmware {

static constexpr size_t HELP_LINE_CAPACITY = 96;
static constexpr const char *HELP_INDENT = "  ";

bool CommandInvocation::readUnsigned(size_t index, const char *name, uint32_t minimum,
                                     uint32_t maximum, uint32_t &value) {
  uint64_t number = 0;
  if (!parseUnsignedNumber(argument(index), number)) {
    rejectUsage();
    return false;
  }
  if (number < minimum || number > maximum) {
    char detail[ERROR_DETAIL_CAPACITY];
    writeRangeDetail(detail, sizeof(detail), name, minimum, maximum);
    reject(ErrorReason::OutOfRange, detail);
    return false;
  }
  value = static_cast<uint32_t>(number);
  return true;
}

// REGISTER_VALUE_DETAIL names the range of parseRegisterValue, INT32_MIN to UINT32_MAX: the
// generator checks that the contract keeps that range.
bool CommandInvocation::readRegisterValue(size_t index, int32_t &value) {
  if (!parseRegisterValue(argument(index), value)) {
    reject(ErrorReason::OutOfRange, REGISTER_VALUE_DETAIL);
    return false;
  }
  return true;
}

void CommandInvocation::rejectUsage(const char *qualification) {
  if (qualification == nullptr) {
    reject(ErrorReason::Usage, command_.usage);
    return;
  }
  char detail[ERROR_DETAIL_CAPACITY];
  snprintf(detail, sizeof(detail), "%s %s", command_.usage, qualification);
  reject(ErrorReason::Usage, detail);
}

void CommandInvocation::reject(ErrorReason reason, const char *detail) {
  context_.events.error(command_.name, reason, detail);
}

// ---------------------------------------------------------------------------------------------
// Handlers, in the order of the actions of the table

static void listCommands(CommandInvocation &invocation);

static void reportStatus(CommandInvocation &invocation) {
  invocation.node().reportStatus(invocation.nowMillis());
}

static void requestEcho(CommandInvocation &invocation) {
  uint16_t destination = 0;
  if (!parseNodeIdentifier(invocation.argument(0), destination) || destination == NO_NODE_ID ||
      destination == BROADCAST_NODE_ID || destination == invocation.services().nodeId()) {
    invocation.rejectUsage("with the id of another node");
    return;
  }
  uint32_t size = DEFAULT_ECHO_SIZE;
  if (invocation.argumentCount() > 1 &&
      !invocation.readUnsigned(1, "size", MINIMUM_ECHO_SIZE, MAXIMUM_ECHO_SIZE, size)) {
    return;
  }
  if (!invocation.services().requestEcho(destination, static_cast<uint16_t>(size))) {
    invocation.reject(ErrorReason::Busy, "transmit queue full");
  }
}

static void stopRun(CommandInvocation &invocation) {
  TestRunService &runs = invocation.services().runs;
  if (!runs.isSending()) {
    invocation.reject(ErrorReason::Usage, "no run in progress");
    return;
  }
  runs.requestStop();
}

static void startRun(CommandInvocation &invocation) {
  uint32_t count = 0;
  uint32_t size = 0;
  uint32_t interval = 0;
  if (!invocation.readUnsigned(0, "count", MINIMUM_RUN_COUNT, MAXIMUM_RUN_COUNT, count) ||
      !invocation.readUnsigned(1, "size", MINIMUM_TEST_SIZE, MAXIMUM_TEST_SIZE, size) ||
      !invocation.readUnsigned(2, "interval", MINIMUM_RUN_INTERVAL_MS, MAXIMUM_RUN_INTERVAL_MS,
                               interval)) {
    return;
  }
  invocation.services().runs.startSending(static_cast<uint16_t>(count), static_cast<uint16_t>(size),
                                          static_cast<uint16_t>(interval), invocation.nowMillis());
}

static void enableWireless(CommandInvocation &invocation) {
  invocation.node().setWirelessEnabled(true);
}

static void disableWireless(CommandInvocation &invocation) {
  invocation.node().setWirelessEnabled(false);
}

static void resendLastFrame(CommandInvocation &invocation) {
  TransmitQueue &queue = invocation.services().queue;
  if (!queue.hasLastSent()) {
    invocation.reject(ErrorReason::Usage, "nothing to resend");
    return;
  }
  if (!queue.enqueueResend()) {
    invocation.reject(ErrorReason::Busy, "transmit queue full");
  }
}

static void releasePresence(CommandInvocation &invocation) {
  invocation.services().presence.release(invocation.nowMillis());
}

static void holdPresence(CommandInvocation &invocation) {
  uint32_t seconds = 0;
  if (invocation.readUnsigned(1, "seconds", MINIMUM_PRESENCE_HOLD_S, MAXIMUM_PRESENCE_HOLD_S,
                              seconds)) {
    invocation.services().presence.hold(seconds * 1000, invocation.nowMillis());
  }
}

static void loadRegisters(CommandInvocation &invocation) {
  int32_t values[REGISTER_COUNT];
  for (uint8_t index = 0; index < REGISTER_COUNT; ++index) {
    if (!invocation.readRegisterValue(index, values[index])) {
      return;
    }
  }
  invocation.services().activation.loadRegisters(values);
}

static void loadImage(CommandInvocation &invocation) {
  char detail[ERROR_DETAIL_CAPACITY];
  switch (
      invocation.services().transfer.loadImage(invocation.argument(0), detail, sizeof(detail))) {
  case ImageLoad::Accepted:
    // The image is not activated: only the immediate HELLO and the full burst follow.
    break;
  case ImageLoad::Invalid:
    invocation.reject(ErrorReason::InvalidImage, detail);
    break;
  case ImageLoad::VersionNotNewer:
    invocation.reject(ErrorReason::VersionNotNewer, detail);
    break;
  }
}

static void activateAvailableVersion(CommandInvocation &invocation) {
  NodeServices &services = invocation.services();
  uint32_t version = 0;
  if (!invocation.readUnsigned(0, "version", 0, MAXIMUM_IMAGE_VERSION, version)) {
    return;
  }
  char detail[ERROR_DETAIL_CAPACITY];
  if (version != services.transfer.availableVersion()) {
    snprintf(detail, sizeof(detail), "available version %lu",
             static_cast<unsigned long>(services.transfer.availableVersion()));
    invocation.reject(ErrorReason::NotAvailable, detail);
    return;
  }
  if (!services.activation.activateAvailable(ActivationCause::Console, NO_NODE_ID,
                                             invocation.nowMillis())) {
    snprintf(detail, sizeof(detail), "active version %lu",
             static_cast<unsigned long>(services.activation.activeVersion()));
    invocation.reject(ErrorReason::VersionNotNewer, detail);
  }
}

static void changeFragmentSize(CommandInvocation &invocation) {
  NodeServices &services = invocation.services();
  if (invocation.argumentCount() > 0) {
    uint32_t size = 0;
    if (!invocation.readUnsigned(0, "bytes", MINIMUM_FRAGMENT_SIZE, MAXIMUM_FRAGMENT_SIZE, size)) {
      return;
    }
    services.transfer.setFragmentSize(static_cast<uint8_t>(size));
  }
  services.transfer.reportTransfer();
}

static void reportProgram(CommandInvocation &invocation) {
  invocation.services().activation.reportProgram();
}

// ---------------------------------------------------------------------------------------------
// The table (CONSOLE_COMMANDS, from the protocol contract): help lists the commands in its order

static CommandHandler handlerOf(CommandAction action) {
  switch (action) {
  case CommandAction::ListCommands:
    return listCommands;
  case CommandAction::ReportStatus:
    return reportStatus;
  case CommandAction::ReportRadio:
    return reportRadio;
  case CommandAction::ResetRadio:
    return resetRadio;
  case CommandAction::ChangeRadio:
    return changeRadio;
  case CommandAction::RequestEcho:
    return requestEcho;
  case CommandAction::StopRun:
    return stopRun;
  case CommandAction::StartRun:
    return startRun;
  case CommandAction::EnableWireless:
    return enableWireless;
  case CommandAction::DisableWireless:
    return disableWireless;
  case CommandAction::ResendLastFrame:
    return resendLastFrame;
  case CommandAction::ReleasePresence:
    return releasePresence;
  case CommandAction::HoldPresence:
    return holdPresence;
  case CommandAction::LoadRegisters:
    return loadRegisters;
  case CommandAction::LoadImage:
    return loadImage;
  case CommandAction::ActivateAvailableVersion:
    return activateAvailableVersion;
  case CommandAction::ChangeFragmentSize:
    return changeFragmentSize;
  case CommandAction::ReportProgram:
    return reportProgram;
  }
  return nullptr;
}

static constexpr size_t textLength(const char *text) {
  size_t length = 0;
  while (text[length] != '\0') {
    ++length;
  }
  return length;
}

// The transports accept the longest line of any command, and no command allows more.
static constexpr bool isLongestLineAccepted() {
  size_t longest = 0;
  for (const ConsoleCommand &command : CONSOLE_COMMANDS) {
    longest = command.maximumLineLength > longest ? command.maximumLineLength : longest;
  }
  return longest == MAXIMUM_COMMAND_LINE_LENGTH;
}

// Every form fits in the words that CommandLine keeps, and every usage in a help line.
static constexpr bool doCommandsFit() {
  for (const ConsoleCommand &command : CONSOLE_COMMANDS) {
    if (textLength(HELP_INDENT) + textLength(command.usage) >= HELP_LINE_CAPACITY) {
      return false;
    }
    for (size_t index = 0; index < command.formCount; ++index) {
      if (command.forms[index].maximumArguments + 1U > CommandLine::MAXIMUM_WORDS) {
        return false;
      }
    }
  }
  return true;
}

static_assert(isLongestLineAccepted(), "MAXIMUM_COMMAND_LINE_LENGTH is not the longest line");
static_assert(doCommandsFit(), "a command does not fit in CommandLine or in a help line");

static void listCommands(CommandInvocation &invocation) {
  EventSink &events = invocation.events();
  events.writeText("commands:");
  char text[HELP_LINE_CAPACITY];
  for (const ConsoleCommand &command : CONSOLE_COMMANDS) {
    snprintf(text, sizeof(text), "%s%s", HELP_INDENT, command.usage);
    events.writeText(text);
  }
}

// ---------------------------------------------------------------------------------------------
// Dispatch

static const ConsoleCommand *findCommand(const char *name) {
  for (const ConsoleCommand &command : CONSOLE_COMMANDS) {
    if (strcmp(command.name, name) == 0) {
      return &command;
    }
  }
  return nullptr;
}

static const CommandForm *selectForm(const ConsoleCommand &command, const CommandLine &line) {
  const size_t argumentCount = line.wordCount() - 1;
  for (size_t index = 0; index < command.formCount; ++index) {
    const CommandForm &form = command.forms[index];
    const bool selected = form.selector == nullptr ||
                          (argumentCount > 0 && strcmp(line.wordAt(1), form.selector) == 0);
    if (selected && argumentCount >= form.minimumArguments &&
        argumentCount <= form.maximumArguments) {
      return &form;
    }
  }
  return nullptr;
}

// An error for a line whose first word may be no command at all, so it is cut to a short name.
static void reportLineError(const CommandLine &line, ErrorReason reason, EventSink &events) {
  char word[ERROR_COMMAND_WORD_LENGTH + 1];
  snprintf(word, sizeof(word), "%s", line.commandWord());
  events.error(word, reason);
}

static bool meetsPrecondition(CommandPrecondition precondition, const CommandContext &context) {
  switch (precondition) {
  case CommandPrecondition::RejectedDuringRun:
    return !context.services.runs.isActive();
  case CommandPrecondition::RejectedDuringEcho:
    return !context.services.echo.isPending();
  case CommandPrecondition::NeedsRadio:
    return context.node.isRadioStarted();
  }
  return false;
}

// The first precondition of the form that the node does not meet, in the order of the checks, or
// nullptr when it meets them all.
static const CommandPreconditionCheck *findUnmetPrecondition(const CommandForm &form,
                                                             const CommandContext &context) {
  for (const CommandPreconditionCheck &check : COMMAND_PRECONDITIONS) {
    if ((form.preconditions & preconditionFlag(check.precondition)) != 0 &&
        !meetsPrecondition(check.precondition, context)) {
      return &check;
    }
  }
  return nullptr;
}

void executeCommandLine(char *line, bool overflowed, uint32_t nowMillis,
                        const CommandContext &context) {
  EventSink &events = context.events;
  const size_t length = strlen(line);
  const CommandLine words(line);
  const ConsoleCommand *command = findCommand(words.commandWord());
  const size_t lineLimit = command != nullptr ? command->maximumLineLength : CONSOLE_LINE_CAPACITY;
  if (overflowed || length > lineLimit) {
    reportLineError(words, ErrorReason::LineTooLong, events);
    return;
  }
  if (words.wordCount() == 0) {
    return;
  }
  if (command == nullptr) {
    reportLineError(words, ErrorReason::UnknownCommand, events);
    return;
  }
  const CommandForm *form = selectForm(*command, words);
  if (form == nullptr) {
    events.error(command->name, ErrorReason::Usage, command->usage);
    return;
  }
  const CommandPreconditionCheck *unmet = findUnmetPrecondition(*form, context);
  if (unmet != nullptr) {
    events.error(command->name, unmet->refusalReason, unmet->refusalDetail);
    return;
  }
  CommandInvocation invocation(*command, words, nowMillis, context);
  handlerOf(form->action)(invocation);
}

} // namespace firmware
