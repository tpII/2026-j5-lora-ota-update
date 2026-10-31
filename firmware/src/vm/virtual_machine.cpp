#include "virtual_machine.h"

#include <string.h>

#include "../network/byte_order.h"

namespace firmware {

static constexpr uint8_t OPCODE_GROUP_MASK = 0xF0;
static constexpr uint8_t ARITHMETIC_GROUP = 0x10;
static constexpr uint8_t LOGIC_GROUP = 0x20;
static constexpr uint8_t REGISTER_FORM_BIT = 0x01;
static constexpr size_t IMMEDIATE_INSTRUCTION_LENGTH = 6;
static constexpr size_t REGISTER_INSTRUCTION_LENGTH = 3;
static constexpr uint32_t SHIFT_MASK = 31;

static bool isBinaryOperation(uint8_t opcode) {
  const uint8_t group = opcode & OPCODE_GROUP_MASK;
  return (group == ARITHMETIC_GROUP && opcode <= static_cast<uint8_t>(Opcode::ModuloRegister)) ||
         (group == LOGIC_GROUP && opcode <= static_cast<uint8_t>(Opcode::ShiftRightRegister));
}

static bool isRegisterOperand(uint8_t operand) { return operand >= 1 && operand <= REGISTER_COUNT; }

size_t instructionLength(uint8_t opcode) {
  if (isBinaryOperation(opcode)) {
    return (opcode & REGISTER_FORM_BIT) != 0 ? REGISTER_INSTRUCTION_LENGTH
                                             : IMMEDIATE_INSTRUCTION_LENGTH;
  }
  switch (static_cast<Opcode>(opcode)) {
  case Opcode::Halt:
    return 1;
  case Opcode::Print:
  case Opcode::Not:
    return 2;
  case Opcode::Load:
    return IMMEDIATE_INSTRUCTION_LENGTH;
  default:
    return 0;
  }
}

const char *vmFaultName(VmFault fault) {
  switch (fault) {
  case VmFault::None:
    return "none";
  case VmFault::DivisionByZero:
    return "division_by_zero";
  case VmFault::InstructionLimit:
    return "instruction_limit";
  case VmFault::EndOfProgram:
    return "end_of_program";
  case VmFault::InvalidOpcode:
    return "invalid_opcode";
  case VmFault::InvalidRegister:
    return "invalid_register";
  case VmFault::TruncatedInstruction:
    return "truncated_instruction";
  }
  return "none";
}

static int hexDigitValue(char digit) {
  if (digit >= '0' && digit <= '9') {
    return digit - '0';
  }
  if (digit >= 'a' && digit <= 'f') {
    return digit - 'a' + 10;
  }
  if (digit >= 'A' && digit <= 'F') {
    return digit - 'A' + 10;
  }
  return -1;
}

bool decodeHexBytes(const char *text, uint8_t *output, size_t capacity, size_t &length) {
  const size_t digits = strlen(text);
  if (digits % 2 != 0 || digits / 2 > capacity) {
    return false;
  }
  for (size_t index = 0; index < digits / 2; ++index) {
    const int high = hexDigitValue(text[2 * index]);
    const int low = hexDigitValue(text[2 * index + 1]);
    if (high < 0 || low < 0) {
      return false;
    }
    output[index] = static_cast<uint8_t>((high << 4) | low);
  }
  length = digits / 2;
  return true;
}

// Checks the instruction at the address without running it.
static VmFault checkInstruction(const uint8_t *code, size_t length, size_t address) {
  const uint8_t opcode = code[address];
  const size_t instruction = instructionLength(opcode);
  if (instruction == 0) {
    return VmFault::InvalidOpcode;
  }
  if (address + instruction > length) {
    return VmFault::TruncatedInstruction;
  }
  if (instruction == 1) {
    return VmFault::None;
  }
  if (!isRegisterOperand(code[address + 1])) {
    return VmFault::InvalidRegister;
  }
  if (instruction == REGISTER_INSTRUCTION_LENGTH && !isRegisterOperand(code[address + 2])) {
    return VmFault::InvalidRegister;
  }
  return VmFault::None;
}

// Arithmetic wraps around in two's complement, as on the control panel's reference interpreter.
// The caller has already rejected a zero divisor.
static int32_t applyOperation(uint8_t operation, int32_t left, int32_t right) {
  const uint32_t leftBits = static_cast<uint32_t>(left);
  const uint32_t rightBits = static_cast<uint32_t>(right);
  switch (static_cast<Opcode>(operation)) {
  case Opcode::AddImmediate:
    return static_cast<int32_t>(leftBits + rightBits);
  case Opcode::SubtractImmediate:
    return static_cast<int32_t>(leftBits - rightBits);
  case Opcode::MultiplyImmediate:
    return static_cast<int32_t>(leftBits * rightBits);
  case Opcode::DivideImmediate:
    return left == INT32_MIN && right == -1 ? INT32_MIN : left / right;
  case Opcode::ModuloImmediate:
    return right == -1 ? 0 : left % right;
  case Opcode::AndImmediate:
    return static_cast<int32_t>(leftBits & rightBits);
  case Opcode::OrImmediate:
    return static_cast<int32_t>(leftBits | rightBits);
  case Opcode::ExclusiveOrImmediate:
    return static_cast<int32_t>(leftBits ^ rightBits);
  case Opcode::ShiftLeftImmediate:
    return static_cast<int32_t>(leftBits << (rightBits & SHIFT_MASK));
  case Opcode::ShiftRightImmediate:
    // Arithmetic shift: the sign bit fills the vacated positions.
    return left >> (rightBits & SHIFT_MASK);
  default:
    return left;
  }
}

void VirtualMachine::begin(uint32_t instructionLimit) {
  instructionLimit_ = instructionLimit;
  programLength_ = 0;
  version_ = 0;
  memset(registers_, 0, sizeof(registers_));
  programCounter_ = 0;
  tickNumber_ = 0;
  running_ = false;
  fault_ = VmFault::None;
}

ProgramLoad VirtualMachine::loadProgram(uint32_t version, const uint8_t *code, size_t length,
                                        size_t &errorOffset) {
  errorOffset = 0;
  if (version <= version_) {
    return ProgramLoad::VersionNotNewer;
  }
  if (length == 0 || length > PROGRAM_CAPACITY) {
    return ProgramLoad::InvalidLength;
  }
  for (size_t address = 0; address < length; address += instructionLength(code[address])) {
    if (checkInstruction(code, length, address) != VmFault::None) {
      errorOffset = address;
      return ProgramLoad::Malformed;
    }
  }
  memcpy(program_, code, length);
  programLength_ = length;
  version_ = version;
  programCounter_ = 0;
  tickNumber_ = 0;
  running_ = false;
  fault_ = VmFault::None;
  return ProgramLoad::Accepted;
}

void VirtualMachine::setRegisters(const int32_t values[REGISTER_COUNT]) {
  memcpy(registers_, values, sizeof(registers_));
}

void VirtualMachine::startTick() {
  if (programLength_ == 0) {
    return;
  }
  programCounter_ = 0;
  instructionCount_ = 0;
  fault_ = VmFault::None;
  ++tickNumber_;
  running_ = true;
}

VmStep VirtualMachine::stop(VmFault fault) {
  running_ = false;
  fault_ = fault;
  faultAddress_ = programCounter_;
  return VmStep::Faulted;
}

VmStep VirtualMachine::execute(uint32_t budget) {
  if (!running_) {
    return VmStep::Idle;
  }
  for (uint32_t step = 0; step < budget; ++step) {
    if (instructionCount_ >= instructionLimit_) {
      return stop(VmFault::InstructionLimit);
    }
    if (programCounter_ >= programLength_) {
      return stop(VmFault::EndOfProgram);
    }
    const VmFault check = checkInstruction(program_, programLength_, programCounter_);
    if (check != VmFault::None) {
      return stop(check);
    }
    ++instructionCount_;
    const uint8_t opcode = program_[programCounter_];
    const uint8_t *operands = program_ + programCounter_ + 1;
    const size_t length = instructionLength(opcode);

    if (opcode == static_cast<uint8_t>(Opcode::Halt)) {
      running_ = false;
      return VmStep::Halted;
    }
    int32_t &target = registers_[operands[0] - 1];
    if (opcode == static_cast<uint8_t>(Opcode::Print)) {
      printedRegister_ = operands[0];
      programCounter_ += length;
      return VmStep::Printed;
    }
    if (opcode == static_cast<uint8_t>(Opcode::Load)) {
      target = static_cast<int32_t>(readUint32(operands + 1));
    } else if (opcode == static_cast<uint8_t>(Opcode::Not)) {
      target = static_cast<int32_t>(~static_cast<uint32_t>(target));
    } else {
      const bool registerForm = (opcode & REGISTER_FORM_BIT) != 0;
      const int32_t source = registerForm ? registers_[operands[1] - 1]
                                          : static_cast<int32_t>(readUint32(operands + 1));
      const uint8_t operation = static_cast<uint8_t>(opcode & ~REGISTER_FORM_BIT);
      if (source == 0 && (operation == static_cast<uint8_t>(Opcode::DivideImmediate) ||
                          operation == static_cast<uint8_t>(Opcode::ModuloImmediate))) {
        return stop(VmFault::DivisionByZero);
      }
      target = applyOperation(operation, target, source);
    }
    programCounter_ += length;
  }
  return VmStep::Running;
}

} // namespace firmware
