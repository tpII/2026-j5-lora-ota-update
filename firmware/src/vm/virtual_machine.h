#ifndef J5_VIRTUAL_MACHINE_H
#define J5_VIRTUAL_MACHINE_H

#include <stddef.h>
#include <stdint.h>

namespace firmware {

// Program memory of the virtual machine, in bytes. Raise it to 2048 if the firmware has room for
// it; the console line that carries a program grows with it.
constexpr size_t PROGRAM_CAPACITY = 1024;

constexpr uint8_t REGISTER_COUNT = 4;

// Opcodes (docs/protocol/virtual-machine.md). Group 0x0n holds the configuration instructions,
// 0x1n the arithmetic ones and 0x2n the logic ones; 0x3n is reserved for control. In groups 0x1n
// and 0x2n an even opcode takes a 32-bit immediate and the next odd one a source register.
enum class Opcode : uint8_t {
  Halt = 0x00,
  Print = 0x01,
  Load = 0x02,
  AddImmediate = 0x10,
  AddRegister = 0x11,
  SubtractImmediate = 0x12,
  SubtractRegister = 0x13,
  MultiplyImmediate = 0x14,
  MultiplyRegister = 0x15,
  DivideImmediate = 0x16,
  DivideRegister = 0x17,
  ModuloImmediate = 0x18,
  ModuloRegister = 0x19,
  AndImmediate = 0x20,
  AndRegister = 0x21,
  OrImmediate = 0x22,
  OrRegister = 0x23,
  ExclusiveOrImmediate = 0x24,
  ExclusiveOrRegister = 0x25,
  ShiftLeftImmediate = 0x26,
  ShiftLeftRegister = 0x27,
  ShiftRightImmediate = 0x28,
  ShiftRightRegister = 0x29,
  Not = 0x2A,
};

enum class ProgramLoad : uint8_t { Accepted, VersionNotNewer, InvalidLength, Malformed };

enum class VmFault : uint8_t {
  None,
  DivisionByZero,
  InstructionLimit,
  EndOfProgram,
  InvalidOpcode,
  InvalidRegister,
  TruncatedInstruction,
};

enum class VmStep : uint8_t { Idle, Running, Printed, Halted, Faulted };

// Length in bytes of the instruction that starts with the opcode, or 0 for an unknown opcode.
size_t instructionLength(uint8_t opcode);

// Name of a fault as the console writes it, for example "division_by_zero".
const char *vmFaultName(VmFault fault);

// Decodes an even number of hexadecimal digits. Returns false on any other character, an odd
// count or more bytes than the capacity.
bool decodeHexBytes(const char *text, uint8_t *output, size_t capacity, size_t &length);

// The register machine that runs the active program: four 32-bit signed registers, a program
// counter and the program memory. A tick runs the program from address 0 to HALT or to a fault;
// execute() runs it in slices so that the main loop keeps serving the radio. The registers keep
// their values from one tick to the next. Version 0 is the factory program, which is empty.
class VirtualMachine {
public:
  void begin(uint32_t instructionLimit);

  // Checks the whole program before replacing the active one: known opcodes, registers 1 to 4 and
  // no instruction cut by the end. On Malformed, errorOffset is the address of the bad
  // instruction. A load stops the tick in progress and restarts the tick count.
  ProgramLoad loadProgram(uint32_t version, const uint8_t *code, size_t length,
                          size_t &errorOffset);
  void setRegisters(const int32_t values[REGISTER_COUNT]);

  void startTick();
  // Runs at most budget instructions and stops early after a PRINT, at HALT or on a fault.
  VmStep execute(uint32_t budget);

  bool hasProgram() const { return programLength_ > 0; }
  bool isRunning() const { return running_; }
  uint32_t version() const { return version_; }
  size_t programLength() const { return programLength_; }
  uint32_t tickNumber() const { return tickNumber_; }
  uint16_t programCounter() const { return programCounter_; }
  // index goes from 0 (R1) to 3 (R4).
  int32_t registerValue(uint8_t index) const { return registers_[index]; }
  // Register written by the last PRINT, from 1 to 4.
  uint8_t printedRegister() const { return printedRegister_; }
  VmFault fault() const { return fault_; }
  uint16_t faultAddress() const { return faultAddress_; }

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
};

} // namespace firmware

#endif
