#ifndef J5_ACTIVATION_CONTROLLER_H
#define J5_ACTIVATION_CONTROLLER_H

#include <stddef.h>
#include <stdint.h>

#include "../console/event_sink.h"
#include "../protocol/protocol_contract.h"
#include "../vm/pin_port.h"
#include "../vm/virtual_machine.h"
#include "presence_service.h"
#include "transfer_service.h"

namespace firmware {

// The active version and the VM that runs it (docs/protocol/frame.md, "Activación", and
// docs/adrs/0011-implicit-activation-without-rollback.md). It holds the activation rule for its
// three causes, the console, a HELLO and a neighbor that already runs the version: the available
// image becomes active only when its version is newer than the active one. As the listener of the
// transfer it hears when the available version changes and when a neighbor runs it, and it asks
// the presence service for an immediate HELLO whenever what the HELLO announces changes. It runs
// the program without end, with its waits and its restarts, and emits activation, vm, vm_print,
// vm_fault and program.
class ActivationController : public TransferListener {
public:
  // pins drives the GPIO of the board, whose model gives the pins that the program may use.
  void begin(EventSink &events, const TransferService &transfer, PresenceService &presence,
             PinPort &pins, BoardModel model);

  uint32_t activeVersion() const override { return vm_.version(); }
  // What the HELLO announces about the VM.
  VmFault lastFault() const { return vm_.lastFault(); }
  bool hasFaultedSinceReport() const { return vm_.hasFaultedSinceReport(); }
  // A HELLO has announced the faults so far; the next one reports only the later ones.
  void clearFaultReport() { vm_.clearFaultReport(); }

  // The activation rule: when the version of the available image of the transfer is newer than
  // the active one, loads its program, emits activation and vm, asks for an immediate HELLO and
  // starts the program at once, even if the previous one was waiting. Returns false,
  // without any event, when the version is not newer. source is the node of a HELLO or a neighbor
  // cause; a console cause has none.
  bool activateAvailable(ActivationCause cause, uint16_t source, uint32_t nowMillis);

  // TransferListener.
  void onAvailableVersionChanged() override;
  void onActivationWanted(ActivationCause cause, uint16_t source, uint32_t nowMillis) override;

  void loadRegisters(const int32_t (&values)[REGISTER_COUNT]);
  void reportVirtualMachine();
  void reportProgram();

  // Runs a block of VM_INSTRUCTIONS_PER_POLL instructions, so that the main loop keeps serving the
  // radio. It runs nothing during the wait that follows a PRINT (VM_MINIMUM_PRINT_INTERVAL_MS) or
  // a SLEEP, and starts the program again from address 0 VM_RESTART_DELAY_MS after HALT or a
  // fault.
  void poll(uint32_t nowMillis);

private:
  bool activate(uint32_t version, const ValidProgram &program, ActivationCause cause,
                uint16_t source, uint32_t nowMillis);

  EventSink *events_ = nullptr;
  const TransferService *transfer_ = nullptr;
  PresenceService *presence_ = nullptr;
  VirtualMachine vm_;
  // When the program last stopped at HALT or on a fault, and the wait that follows a PRINT or a
  // SLEEP: the VM runs nothing until pauseMillis_ have passed since pauseStartMillis_.
  uint32_t stoppedMillis_ = 0;
  uint32_t pauseStartMillis_ = 0;
  uint32_t pauseMillis_ = 0;
};

} // namespace firmware

#endif
