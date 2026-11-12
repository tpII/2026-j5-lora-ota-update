#ifndef J5_ACTIVATION_CONTROLLER_H
#define J5_ACTIVATION_CONTROLLER_H

#include <stddef.h>
#include <stdint.h>

#include "../console/event_sink.h"
#include "../protocol/protocol_contract.h"
#include "../vm/virtual_machine.h"
#include "presence_service.h"
#include "transfer_service.h"

namespace firmware {

// The active version and the VM that runs it (docs/protocol/frame.md, "Activación", and
// docs/adrs/0011-implicit-activation-without-rollback.md). It holds the activation rule for its
// three causes, the console, a HELLO and a neighbor that already runs the version: the available
// image becomes active only when its version is newer than the active one. As the listener of the
// transfer it hears when the available version changes and when a neighbor runs it, and it asks
// the presence service for an immediate HELLO whenever what the HELLO announces changes. It
// schedules the ticks and emits activation, vm, vm_print, vm_fault and program.
class ActivationController : public TransferListener {
public:
  void begin(EventSink &events, const TransferService &transfer, PresenceService &presence);

  uint32_t activeVersion() const override { return vm_.version(); }
  // What the HELLO announces about the VM.
  VmFault lastFault() const { return vm_.lastFault(); }
  bool lastTickFaulted() const { return vm_.lastTickFaulted(); }

  // The activation rule: when the version of the available image of the transfer is newer than
  // the active one, loads its program, emits activation and vm, asks for an immediate HELLO and
  // runs the first tick at once; the next ones follow every VM_TICK_PERIOD_MS. Returns false,
  // without any event, when the version is not newer. source is the node of a HELLO or a neighbor
  // cause; a console cause has none.
  bool activateAvailable(ActivationCause cause, uint16_t source, uint32_t nowMillis);

  // TransferListener.
  void onAvailableVersionChanged() override;
  void onActivationWanted(ActivationCause cause, uint16_t source, uint32_t nowMillis) override;

  void loadRegisters(const int32_t (&values)[REGISTER_COUNT]);
  void reportVirtualMachine();
  void reportProgram();

  // Starts a tick when its period has passed and runs a slice of VM_INSTRUCTIONS_PER_POLL
  // instructions of the tick in progress, so that the main loop keeps serving the radio.
  void poll(uint32_t nowMillis);

private:
  bool activate(uint32_t version, const ValidProgram &program, ActivationCause cause,
                uint16_t source, uint32_t nowMillis);

  EventSink *events_ = nullptr;
  const TransferService *transfer_ = nullptr;
  PresenceService *presence_ = nullptr;
  VirtualMachine vm_;
  uint32_t lastTickMillis_ = 0;
};

} // namespace firmware

#endif
