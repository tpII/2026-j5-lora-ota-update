#include "activation_controller.h"

namespace firmware {

void ActivationController::begin(EventSink &events, const TransferService &transfer,
                                 PresenceService &presence, PinPort &pins, BoardModel model) {
  events_ = &events;
  transfer_ = &transfer;
  presence_ = &presence;
  vm_.begin(pins, describeBoardModel(model));
}

bool ActivationController::activateAvailable(ActivationCause cause, uint16_t source,
                                             uint32_t nowMillis) {
  return activate(transfer_->availableVersion(), transfer_->availableProgram(), cause, source,
                  nowMillis);
}

bool ActivationController::activate(uint32_t version, const ValidProgram &program,
                                    ActivationCause cause, uint16_t source, uint32_t nowMillis) {
  if (version <= vm_.version()) {
    return false;
  }
  const uint32_t previous = vm_.version();
  vm_.loadProgram(version, program);

  JsonObject event = events_->beginEvent(ConsoleEvent::Activation);
  event["version"] = version;
  event["previous"] = previous;
  event["cause"] = activationCauseName(cause);
  setOptionalNodeId(event, "src", source);
  events_->writeEvent();
  reportVirtualMachine();
  events_->debug("VM: program v%lu", static_cast<unsigned long>(version));
  presence_->requestImmediate();

  // The program starts at once, whatever the time: since the VM runs without ticks, the activation
  // needs no clock, and nowMillis stays only for the listener interface of the transfer.
  (void)nowMillis;
  pauseMillis_ = 0;
  vm_.startVM();
  return true;
}

void ActivationController::onAvailableVersionChanged() { presence_->requestImmediate(); }

void ActivationController::onActivationWanted(ActivationCause cause, uint16_t source,
                                              uint32_t nowMillis) {
  activateAvailable(cause, source, nowMillis);
}

void ActivationController::loadRegisters(const int32_t (&values)[REGISTER_COUNT]) {
  vm_.setRegisters(values);
  reportVirtualMachine();
  events_->debug("VM: registers loaded");
}

void ActivationController::reportVirtualMachine() {
  JsonObject event = events_->beginEvent(ConsoleEvent::Vm);
  event["version"] = vm_.version();
  event["size"] = vm_.programLength();
  event["starts"] = vm_.startCount();
  JsonArray registers = event["registers"].to<JsonArray>();
  for (uint8_t index = 0; index < REGISTER_COUNT; ++index) {
    registers.add(vm_.registerValue(index));
  }
  events_->writeEvent();
}

void ActivationController::reportProgram() {
  JsonObject event = events_->beginEvent(ConsoleEvent::Program);
  event["version"] = vm_.version();
  event["size"] = vm_.programLength();
  events_->writeEvent("code", vm_.program(), vm_.programLength());
}

void ActivationController::poll(uint32_t nowMillis) {
  if (!vm_.hasProgram()) {
    return;
  }
  if (!vm_.isRunning()) {
    if (nowMillis - stoppedMillis_ < VM_RESTART_DELAY_MS) {
      return;
    }
    pauseMillis_ = 0;
    vm_.startVM();
  }
  if (nowMillis - pauseStartMillis_ < pauseMillis_) {
    return;
  }
  switch (vm_.execute(VM_INSTRUCTIONS_PER_POLL)) {
  case VmStep::Sleeping:
    pauseStartMillis_ = nowMillis;
    pauseMillis_ = vm_.sleepMillis();
    break;
  case VmStep::Printed: {
    pauseStartMillis_ = nowMillis;
    pauseMillis_ = VM_MINIMUM_PRINT_INTERVAL_MS;
    const uint8_t index = vm_.printedRegister();
    const int32_t value = vm_.registerValue(index - 1);
    JsonObject event = events_->beginEvent(ConsoleEvent::VmPrint);
    event["n"] = vm_.printCount();
    event["reg"] = index;
    event["value"] = value;
    events_->writeEvent();
    events_->debug("VM: R%u - 0x%08lX", index,
                   static_cast<unsigned long>(static_cast<uint32_t>(value)));
    break;
  }
  case VmStep::Faulted: {
    stoppedMillis_ = nowMillis;
    JsonObject event = events_->beginEvent(ConsoleEvent::VmFault);
    event["starts"] = vm_.startCount();
    event["pc"] = vm_.faultAddress();
    event["reason"] = vmFaultName(vm_.fault());
    events_->writeEvent();
    events_->debug("VM: %s", vmFaultName(vm_.fault()));
    break;
  }
  case VmStep::Halted:
    stoppedMillis_ = nowMillis;
    // The program starts again from address 0 after VM_RESTART_DELAY_MS.
    events_->debug("VM: HALT stop-reset");
    break;
  case VmStep::Idle:
  case VmStep::Running:
    break;
  }
}

} // namespace firmware
