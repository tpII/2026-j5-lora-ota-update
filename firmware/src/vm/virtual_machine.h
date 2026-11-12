#ifndef J5_VIRTUAL_MACHINE_H
#define J5_VIRTUAL_MACHINE_H

#include <stddef.h>
#include <stdint.h>

#include "../protocol/protocol_contract.h"

namespace firmware {

// PROGRAM_CAPACITY, REGISTER_COUNT, the opcodes and the faults are in the protocol contract
// (docs/protocol/virtual-machine.md).

enum class VmStep : uint8_t { Idle, Running, Printed, Halted, Faulted };

// Where validateProgram() found a program wrong: the address of the first bad instruction and the
// fault that running it would raise, or address 0 and VmFault::None for a length out of range.
struct ProgramDefect {
  size_t address;
  VmFault fault;
};

// A program that validateProgram() accepted: from MINIMUM_PROGRAM_SIZE to MAXIMUM_PROGRAM_SIZE
// bytes, known opcodes, registers 1 to REGISTER_COUNT and no instruction cut by the end. Only
// validateProgram() and copyTo() make one, so the VM loads and runs it without checking it again.
// It refers to the bytes it was made from, which must stay unchanged while it is in use. A default
// one is empty and refers to nothing.
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
// program counter and the program memory. A tick runs the program from address 0 to HALT or to a
// fault; execute() runs it in slices so that the main loop keeps serving the radio. The registers
// keep their values from one tick to the next. Version 0 is the factory program, which is empty.
class VirtualMachine {
public:
  void begin(uint32_t instructionLimit);

  // Replaces the active program with a copy of the program, as the version. A load stops the tick
  // in progress, restarts the tick count and clears the faults since the last load; the registers
  // keep their values. Which version may replace which is the activation rule, not the VM's.
  void loadProgram(uint32_t version, const ValidProgram &program);
  void setRegisters(const int32_t values[REGISTER_COUNT]);

  void startTick();
  // Runs at most budget instructions and stops early after a PRINT, at HALT or on a fault. A valid
  // program can only fault with division_by_zero, instruction_limit or end_of_program; the other
  // faults of the contract are those that validateProgram() rejects.
  VmStep execute(uint32_t budget);

  bool hasProgram() const { return programLength_ > 0; }
  bool isRunning() const { return running_; }
  uint32_t version() const { return version_; }
  size_t programLength() const { return programLength_; }
  const uint8_t *program() const { return program_; }
  uint32_t tickNumber() const { return tickNumber_; }
  // index goes from 0, for R1, to REGISTER_COUNT - 1.
  int32_t registerValue(uint8_t index) const { return registers_[index]; }
  // Register that the last PRINT names, from 1 to REGISTER_COUNT.
  uint8_t printedRegister() const { return printedRegister_; }
  VmFault fault() const { return fault_; }
  uint16_t faultAddress() const { return faultAddress_; }
  // Last fault since the program was loaded, or None, and whether the last tick ended in a fault:
  // the state that the HELLO announces (docs/adrs/0011-implicit-activation-without-rollback.md).
  VmFault lastFault() const { return lastFault_; }
  bool lastTickFaulted() const { return lastTickFaulted_; }

private:
  VmStep stop(VmFault fault);

  uint8_t program_[PROGRAM_CAPACITY] = {};
  size_t programLength_ = 0;
  uint32_t version_ = 0;
  int32_t registers_[REGISTER_COUNT] = {};
  uint16_t programCounter_ = 0;
  uint32_t tickNumber_ = 0;
  uint32_t instructionCount_ = 0;
  uint32_t instructionLimit_ = 0;
  bool running_ = false;
  uint8_t printedRegister_ = 0;
  VmFault fault_ = VmFault::None;
  uint16_t faultAddress_ = 0;
  VmFault lastFault_ = VmFault::None;
  bool lastTickFaulted_ = false;
};

} // namespace firmware

#endif
