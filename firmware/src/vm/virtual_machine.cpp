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

// Registers that follow the opcode in each operand form.
static size_t registerOperandCount(OperandForm form) {
  switch (form) {
  case OperandForm::None:
  case OperandForm::Immediate:
  case OperandForm::Address:
    return 0;
  case OperandForm::Register:
  case OperandForm::RegisterImmediate:
  case OperandForm::RegisterAddress:
    return 1;
  case OperandForm::RegisterRegister:
    return 2;
  }
  return 0;
}

// Position of the 16-bit target of a jump or a call within its instruction, or 0 for the forms
// that carry no address.
static size_t addressOperandOffset(OperandForm form) {
  switch (form) {
  case OperandForm::Address:
    return 1;
  case OperandForm::RegisterAddress:
    return 2;
  case OperandForm::None:
  case OperandForm::Register:
  case OperandForm::RegisterImmediate:
  case OperandForm::RegisterRegister:
  case OperandForm::Immediate:
    return 0;
  }
  return 0;
}

// Checks the instruction at the address without running it; returns true when it is well formed.
static bool checkInstruction(const uint8_t *code, size_t length, size_t address,
                             ProgramDefectReason &reason) {
  const uint8_t opcode = code[address];
  const size_t instruction = instructionLength(opcode);
  if (instruction == 0) {
    reason = ProgramDefectReason::InvalidOpcode;
    return false;
  }
  if (address + instruction > length) {
    reason = ProgramDefectReason::TruncatedInstruction;
    return false;
  }
  const size_t registers = registerOperandCount(INSTRUCTION_DECODING.forms[opcode]);
  for (size_t operand = 1; operand <= registers; ++operand) {
    if (!isRegisterOperand(code[address + operand])) {
      reason = ProgramDefectReason::InvalidRegister;
      return false;
    }
  }
  return true;
}

static bool isMarked(const uint8_t *marks, size_t address) {
  return (marks[address / 8] & (1U << (address % 8))) != 0;
}

bool validateProgram(const uint8_t *code, size_t length, ValidProgram &program,
                     ProgramDefect &defect) {
  defect = ProgramDefect{0, ProgramDefectReason::InvalidOpcode};
  if (length < MINIMUM_PROGRAM_SIZE || length > MAXIMUM_PROGRAM_SIZE) {
    return false;
  }
  // First pass: every instruction is well formed; mark where each one starts.
  uint8_t instructionStarts[(PROGRAM_CAPACITY + 7) / 8] = {};
  for (size_t address = 0; address < length; address += instructionLength(code[address])) {
    ProgramDefectReason reason{};
    if (!checkInstruction(code, length, address, reason)) {
      defect = ProgramDefect{address, reason};
      return false;
    }
    instructionStarts[address / 8] |= static_cast<uint8_t>(1U << (address % 8));
  }
  // Second pass: every jump and call lands on the start of an instruction, so that the VM never
  // decodes the operands of an instruction as an opcode.
  for (size_t address = 0; address < length; address += instructionLength(code[address])) {
    const size_t offset = addressOperandOffset(INSTRUCTION_DECODING.forms[code[address]]);
    if (offset == 0) {
      continue;
    }
    const uint16_t target = readUint16(code + address + offset);
    if (target >= length || !isMarked(instructionStarts, target)) {
      defect = ProgramDefect{address, ProgramDefectReason::InvalidJumpTarget};
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
  case Opcode::Sleep:
  case Opcode::Jump:
  case Opcode::JumpIfZero:
  case Opcode::JumpIfNotZero:
  case Opcode::JumpIfNegative:
  case Opcode::Call:
  case Opcode::Return:
  case Opcode::ConfigurePin:
  case Opcode::ReadPin:
  case Opcode::WritePin:
    // Their effects write no register here; execute() handles them before.
    return target;
  }
  return target;
}

// Whether the register meets the condition of a branch opcode.
static bool isBranchTaken(Opcode opcode, int32_t value) {
  switch (opcode) {
  case Opcode::JumpIfZero:
    return value == 0;
  case Opcode::JumpIfNotZero:
    return value != 0;
  case Opcode::JumpIfNegative:
    return value < 0;
  default:
    return false;
  }
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
  case OperandForm::Immediate:
  case OperandForm::Address:
  case OperandForm::RegisterAddress:
    return 0;
  }
  return 0;
}

void VirtualMachine::begin(PinPort &pins, const BoardModelDescription &board) {
  pins_ = &pins;
  board_ = &board;
  for (PinState &state : pinStates_) {
    state = PinState::Unconfigured;
  }
  programLength_ = 0;
  version_ = 0;
  memset(registers_, 0, sizeof(registers_));
  programCounter_ = 0;
  stackDepth_ = 0;
  startCount_ = 0;
  printCount_ = 0;
  running_ = false;
  fault_ = VmFault::None;
  lastFault_ = VmFault::None;
  faultedSinceReport_ = false;
}

void VirtualMachine::loadProgram(uint32_t version, const ValidProgram &program) {
  releasePins();
  memcpy(program_, program.code(), program.length());
  programLength_ = program.length();
  version_ = version;
  programCounter_ = 0;
  stackDepth_ = 0;
  startCount_ = 0;
  printCount_ = 0;
  running_ = false;
  fault_ = VmFault::None;
  lastFault_ = VmFault::None;
  faultedSinceReport_ = false;
}

void VirtualMachine::setRegisters(const int32_t values[REGISTER_COUNT]) {
  memcpy(registers_, values, sizeof(registers_));
}

void VirtualMachine::startVM() {
  if (programLength_ == 0) {
    return;
  }
  programCounter_ = 0;
  stackDepth_ = 0;
  fault_ = VmFault::None;
  releasePins();
  ++startCount_;
  running_ = true;
}

void VirtualMachine::releasePins() {
  for (size_t pin = 0; pin < VM_PIN_COUNT; ++pin) {
    if (pinStates_[pin] != PinState::Unconfigured) {
      pins_->release(board_->vmPins[pin]);
      pinStates_[pin] = PinState::Unconfigured;
    }
  }
}

VmFault VirtualMachine::executePinInstruction(InstructionEffect effect, const uint8_t *operands) {
  // The second register holds the number of the pin of the VM, from 0, which the list of the board
  // turns into its GPIO; a negative number becomes a large one and is no pin either.
  const uint32_t index = static_cast<uint32_t>(registers_[operands[1] - 1]);
  if (index >= VM_PIN_COUNT) {
    return VmFault::InvalidPin;
  }
  const uint8_t pin = board_->vmPins[index];
  int32_t &value = registers_[operands[0] - 1];
  switch (effect) {
  case InstructionEffect::PinMode: {
    const bool output = value != 0;
    pins_->configure(pin, output ? PinDirection::Output : PinDirection::Input);
    pinStates_[index] = output ? PinState::Output : PinState::Input;
    return VmFault::None;
  }
  case InstructionEffect::PinRead:
    if (pinStates_[index] == PinState::Unconfigured) {
      return VmFault::PinMode;
    }
    value = pins_->read(pin) ? 1 : 0;
    return VmFault::None;
  case InstructionEffect::PinWrite:
    if (pinStates_[index] != PinState::Output) {
      return VmFault::PinMode;
    }
    pins_->write(pin, value != 0);
    return VmFault::None;
  default:
    return VmFault::None;
  }
}

VmStep VirtualMachine::stop(VmFault fault) {
  running_ = false;
  fault_ = fault;
  faultAddress_ = programCounter_;
  lastFault_ = fault;
  faultedSinceReport_ = true;
  return VmStep::Faulted;
}

VmStep VirtualMachine::execute(uint32_t budget) {
  if (!running_) {
    return VmStep::Idle;
  }
  for (uint32_t step = 0; step < budget; ++step) {
    if (programCounter_ >= programLength_) {
      return stop(VmFault::EndOfProgram);
    }
    const uint8_t code = program_[programCounter_];
    const Opcode opcode = static_cast<Opcode>(code);
    const uint8_t *operands = program_ + programCounter_ + 1;
    const uint16_t next = static_cast<uint16_t>(programCounter_ + instructionLength(code));

    const InstructionEffect effect = INSTRUCTION_DECODING.effects[code];
    switch (effect) {
    case InstructionEffect::Halt:
      running_ = false;
      return VmStep::Halted;
    case InstructionEffect::Print:
      printedRegister_ = operands[0];
      ++printCount_;
      programCounter_ = next;
      return VmStep::Printed;
    case InstructionEffect::Sleep:
      sleepMillis_ = readUint32(operands);
      programCounter_ = next;
      return VmStep::Sleeping;
    case InstructionEffect::Jump:
      programCounter_ = readUint16(operands);
      continue;
    case InstructionEffect::Branch:
      programCounter_ =
          isBranchTaken(opcode, registers_[operands[0] - 1]) ? readUint16(operands + 1) : next;
      continue;
    case InstructionEffect::Call:
      if (stackDepth_ >= RETURN_STACK_DEPTH) {
        return stop(VmFault::StackOverflow);
      }
      returnStack_[stackDepth_++] = next;
      programCounter_ = readUint16(operands);
      continue;
    case InstructionEffect::Return:
      if (stackDepth_ == 0) {
        return stop(VmFault::StackUnderflow);
      }
      programCounter_ = returnStack_[--stackDepth_];
      continue;
    case InstructionEffect::PinMode:
    case InstructionEffect::PinRead:
    case InstructionEffect::PinWrite: {
      const VmFault fault = executePinInstruction(effect, operands);
      if (fault != VmFault::None) {
        return stop(fault);
      }
      programCounter_ = next;
      continue;
    }
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
    programCounter_ = next;
  }
  return VmStep::Running;
}

} // namespace firmware
