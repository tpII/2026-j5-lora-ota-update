#include "virtual_machine.h"

#include <string.h>

#include "../encoding/byte_order.h"

namespace firmware {

static constexpr uint32_t SHIFT_MASK = 31;

// How the instruction that starts with each byte is encoded and what it does: its length, or 0 for
// a byte that is no opcode, its operand form and its effect.
namespace {
struct InstructionDecodingTable {
  uint8_t lengths[256];
  OperandForm forms[256];
  InstructionEffect effects[256];
};
} // namespace

static constexpr InstructionDecodingTable buildInstructionDecodingTable() {
  InstructionDecodingTable table{};
  for (const InstructionEncoding &encoding : INSTRUCTION_ENCODINGS) {
    const uint8_t opcode = static_cast<uint8_t>(encoding.opcode);
    table.lengths[opcode] = static_cast<uint8_t>(operandFormLength(encoding.form));
    table.forms[opcode] = encoding.form;
    table.effects[opcode] = encoding.effect;
  }
  return table;
}

static constexpr InstructionDecodingTable INSTRUCTION_DECODING = buildInstructionDecodingTable();

static bool isRegisterOperand(uint8_t operand) { return operand >= 1 && operand <= REGISTER_COUNT; }

// Length in bytes of the instruction that starts with the opcode, or 0 for an unknown opcode.
static size_t instructionLength(uint8_t opcode) { return INSTRUCTION_DECODING.lengths[opcode]; }

static VmFault checkInstruction(const uint8_t *code, size_t length, size_t address) {
  const uint8_t opcode = code[address];
  const size_t instruction = instructionLength(opcode);
  if (instruction == 0) {
    return VmFault::InvalidOpcode;
  }
  if (address + instruction > length) {
    return VmFault::TruncatedInstruction;
  }
  const OperandForm form = INSTRUCTION_DECODING.forms[opcode];
  if (form == OperandForm::None) {
    return VmFault::None;
  }
  if (!isRegisterOperand(code[address + 1])) {
    return VmFault::InvalidRegister;
  }
  if (form == OperandForm::RegisterRegister && !isRegisterOperand(code[address + 2])) {
    return VmFault::InvalidRegister;
  }
  return VmFault::None;
}

bool validateProgram(const uint8_t *code, size_t length, ValidProgram &program,
                     ProgramDefect &defect) {
  defect = ProgramDefect{0, VmFault::None};
  if (length < MINIMUM_PROGRAM_SIZE || length > MAXIMUM_PROGRAM_SIZE) {
    return false;
  }
  for (size_t address = 0; address < length; address += instructionLength(code[address])) {
    const VmFault fault = checkInstruction(code, length, address);
    if (fault != VmFault::None) {
      defect = ProgramDefect{address, fault};
      return false;
    }
  }
  program = ValidProgram(code, length);
  return true;
}

ValidProgram ValidProgram::copyTo(uint8_t *destination) const {
  if (destination != code_) {
    memcpy(destination, code_, length_);
  }
  ValidProgram copy;
  copy.code_ = destination;
  copy.length_ = length_;
  return copy;
}

// The value that an instruction writes to its target register, from the target and the source:
// the immediate or the second register, as the operand form of the opcode says. Arithmetic wraps
// around in two's complement, as on the control panel's reference interpreter. The caller has
// already rejected a zero divisor.
static int32_t applyOperation(Opcode opcode, int32_t target, int32_t source) {
  const uint32_t targetBits = static_cast<uint32_t>(target);
  const uint32_t sourceBits = static_cast<uint32_t>(source);
  switch (opcode) {
  case Opcode::Load:
    return source;
  case Opcode::AddImmediate:
  case Opcode::AddRegister:
    return static_cast<int32_t>(targetBits + sourceBits);
  case Opcode::SubtractImmediate:
  case Opcode::SubtractRegister:
    return static_cast<int32_t>(targetBits - sourceBits);
  case Opcode::MultiplyImmediate:
  case Opcode::MultiplyRegister:
    return static_cast<int32_t>(targetBits * sourceBits);
  case Opcode::DivideImmediate:
  case Opcode::DivideRegister:
    return target == INT32_MIN && source == -1 ? INT32_MIN : target / source;
  case Opcode::ModuloImmediate:
  case Opcode::ModuloRegister:
    return source == -1 ? 0 : target % source;
  case Opcode::AndImmediate:
  case Opcode::AndRegister:
    return static_cast<int32_t>(targetBits & sourceBits);
  case Opcode::OrImmediate:
  case Opcode::OrRegister:
    return static_cast<int32_t>(targetBits | sourceBits);
  case Opcode::ExclusiveOrImmediate:
  case Opcode::ExclusiveOrRegister:
    return static_cast<int32_t>(targetBits ^ sourceBits);
  case Opcode::ShiftLeftImmediate:
  case Opcode::ShiftLeftRegister:
    return static_cast<int32_t>(targetBits << (sourceBits & SHIFT_MASK));
  case Opcode::ShiftRightImmediate:
  case Opcode::ShiftRightRegister:
    // Arithmetic shift: the sign bit fills the vacated positions.
    return target >> (sourceBits & SHIFT_MASK);
  case Opcode::Not:
    return static_cast<int32_t>(~targetBits);
  case Opcode::Halt:
  case Opcode::Print:
    // Their effects write no register; execute() handles them before.
    return target;
  }
  return target;
}

static int32_t readSource(OperandForm form, const uint8_t *operands,
                          const int32_t (&registers)[REGISTER_COUNT]) {
  switch (form) {
  case OperandForm::RegisterImmediate:
    return static_cast<int32_t>(readUint32(operands + 1));
  case OperandForm::RegisterRegister:
    return registers[operands[1] - 1];
  case OperandForm::None:
  case OperandForm::Register:
    return 0;
  }
  return 0;
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
  lastFault_ = VmFault::None;
  lastTickFaulted_ = false;
}

void VirtualMachine::loadProgram(uint32_t version, const ValidProgram &program) {
  memcpy(program_, program.code(), program.length());
  programLength_ = program.length();
  version_ = version;
  programCounter_ = 0;
  tickNumber_ = 0;
  running_ = false;
  fault_ = VmFault::None;
  lastFault_ = VmFault::None;
  lastTickFaulted_ = false;
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
  lastFault_ = fault;
  lastTickFaulted_ = true;
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
    ++instructionCount_;
    const uint8_t code = program_[programCounter_];
    const Opcode opcode = static_cast<Opcode>(code);
    const uint8_t *operands = program_ + programCounter_ + 1;
    const size_t length = instructionLength(code);

    const InstructionEffect effect = INSTRUCTION_DECODING.effects[code];
    switch (effect) {
    case InstructionEffect::Halt:
      running_ = false;
      lastTickFaulted_ = false;
      return VmStep::Halted;
    case InstructionEffect::Print:
      printedRegister_ = operands[0];
      programCounter_ += length;
      return VmStep::Printed;
    case InstructionEffect::Write:
    case InstructionEffect::Divide:
      break;
    }
    // The contract gives these effects only forms that start with the target register.
    int32_t &target = registers_[operands[0] - 1];
    const int32_t source = readSource(INSTRUCTION_DECODING.forms[code], operands, registers_);
    if (effect == InstructionEffect::Divide && source == 0) {
      return stop(VmFault::DivisionByZero);
    }
    target = applyOperation(opcode, target, source);
    programCounter_ += length;
  }
  return VmStep::Running;
}

} // namespace firmware
