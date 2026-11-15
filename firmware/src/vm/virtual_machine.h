#ifndef J5_VIRTUAL_MACHINE_H
#define J5_VIRTUAL_MACHINE_H

#include <stddef.h>
#include <stdint.h>

#include "../protocol/protocol_contract.h"
#include "pin_port.h"

namespace firmware {

// PROGRAM_CAPACITY, REGISTER_COUNT, RETURN_STACK_DEPTH, the opcodes, the faults, the program
// defects and the GPIO of each pin of the VM on each board are in the protocol contract
// (docs/protocol/virtual-machine.md).

enum class VmStep : uint8_t { Idle, Running, Printed, Sleeping, Halted, Faulted };

// Where validateProgram() found a program wrong: the address of the first bad instruction and why.
// For a length out of range it is address 0 and InvalidOpcode, which no caller reads: the image
// verifier rejects such a length before it validates the program.
struct ProgramDefect {
  size_t address;
  ProgramDefectReason reason;
};

// A program that validateProgram() accepted: from MINIMUM_PROGRAM_SIZE to MAXIMUM_PROGRAM_SIZE
// bytes, known opcodes, registers 1 to REGISTER_COUNT, no instruction cut by the end and every
// jump or call aimed at the start of an instruction. Only validateProgram() and copyTo() make one,
// so the VM loads and runs it without checking it again. It refers to the bytes it was made from,
// which must stay unchanged while it is in use. A default one is empty and refers to nothing.
class ValidProgram {
public:
  ValidProgram() = default;

  const uint8_t *code() const { return code_; }
  size_t length() const { return length_; }

  // Copies the program to destination, which has room for length() bytes, and returns the copy.
  ValidProgram copyTo(uint8_t *destination) const;

private:
  friend bool validateProgram(const uint8_t *code, size_t length, ValidProgram &program,
                              ProgramDefect &defect);

  ValidProgram(const uint8_t *code, size_t length) : code_(code), length_(length) {}

  const uint8_t *code_ = nullptr;
  size_t length_ = 0;
};

// Checks a whole program without running it. On success, program refers to code; on failure, the
// defect tells where and why.
bool validateProgram(const uint8_t *code, size_t length, ValidProgram &program,
                     ProgramDefect &defect);

// The register machine that runs the active program: REGISTER_COUNT 32-bit signed registers, a
// program counter, a return stack of RETURN_STACK_DEPTH levels and the program memory. The program
// runs without end; execute() runs it in blocks so that the main loop keeps serving the radio.
// After HALT or a fault the caller starts it again from address 0 with startVM(), and the
// registers keep their values across those starts. PINM, PINR and PINW name the pins of the VM,
// from 0 to VM_PIN_COUNT - 1, and reach the GPIO that the board gives each one through a PinPort,
// so that a program runs the same on every board model; every start leaves the pins unconfigured.
// Version 0 is the factory program, which is empty.
class VirtualMachine {
public:
  // pins drives the GPIO of the board; board gives the GPIO of each pin of the VM.
  void begin(PinPort &pins, const BoardModelDescription &board);

  // Replaces the active program with a copy of the program, as the version. A load stops the
  // program, restarts the start and output counts, clears the faults since the last load and
  // releases the pins; the registers keep their values. Which version may replace which is the
  // activation rule, not the VM's.
  void loadProgram(uint32_t version, const ValidProgram &program);
  void setRegisters(const int32_t values[REGISTER_COUNT]);

  // Starts the program from address 0 with an empty return stack and every pin unconfigured.
  void startVM();
  // Runs at most budget instructions and stops early after a PRINT or a SLEEP, at HALT or on a
  // fault. After a SLEEP the caller waits sleepMillis() before it calls execute() again. A valid
  // program can only raise the faults of VmFault; what validateProgram() rejects never runs.
  VmStep execute(uint32_t budget);

  bool hasProgram() const { return programLength_ > 0; }
  bool isRunning() const { return running_; }
  uint32_t version() const { return version_; }
  size_t programLength() const { return programLength_; }
  const uint8_t *program() const { return program_; }
  // Times the program started from address 0 since it was loaded.
  uint32_t startCount() const { return startCount_; }
  // Outputs since the program was loaded; after a PRINT, the number of that output.
  uint32_t printCount() const { return printCount_; }
  uint8_t stackDepth() const { return stackDepth_; }
  // index goes from 0, for R1, to REGISTER_COUNT - 1.
  int32_t registerValue(uint8_t index) const { return registers_[index]; }
  // Register that the last PRINT names, from 1 to REGISTER_COUNT.
  uint8_t printedRegister() const { return printedRegister_; }
  // Milliseconds that the last SLEEP asks to wait.
  uint32_t sleepMillis() const { return sleepMillis_; }
  VmFault fault() const { return fault_; }
  uint16_t faultAddress() const { return faultAddress_; }
  // Last fault since the program was loaded, or None, and whether the program faulted since the
  // last HELLO: the state that the HELLO announces
  // (docs/adrs/0011-implicit-activation-without-rollback.md).
  VmFault lastFault() const { return lastFault_; }
  bool hasFaultedSinceReport() const { return faultedSinceReport_; }
  void clearFaultReport() { faultedSinceReport_ = false; }

private:
  // What PINM left on each pin of the VM.
  enum class PinState : uint8_t { Unconfigured, Input, Output };

  VmStep stop(VmFault fault);
  // Runs PINM, PINR or PINW; returns VmFault::None when the instruction ran.
  VmFault executePinInstruction(InstructionEffect effect, const uint8_t *operands);
  // Leaves every pin that the program configured as an input without pull, and unconfigured.
  void releasePins();

  uint8_t program_[PROGRAM_CAPACITY] = {};
  size_t programLength_ = 0;
  uint32_t version_ = 0;
  int32_t registers_[REGISTER_COUNT] = {};
  uint16_t programCounter_ = 0;
  uint16_t returnStack_[RETURN_STACK_DEPTH] = {};
  uint8_t stackDepth_ = 0;
  uint32_t startCount_ = 0;
  uint32_t printCount_ = 0;
  bool running_ = false;
  uint8_t printedRegister_ = 0;
  uint32_t sleepMillis_ = 0;
  VmFault fault_ = VmFault::None;
  uint16_t faultAddress_ = 0;
  VmFault lastFault_ = VmFault::None;
  bool faultedSinceReport_ = false;
  PinPort *pins_ = nullptr;
  const BoardModelDescription *board_ = nullptr;
  PinState pinStates_[VM_PIN_COUNT] = {};
};

} // namespace firmware

#endif
