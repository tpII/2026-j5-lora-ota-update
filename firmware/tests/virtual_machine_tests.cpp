// Host tests of the virtual machine: the shared vectors of
// firmware/protocol/test-vectors/virtual-machine.json, the validation of a program and the state
// that the HELLO announces.

#include <cstring>

#include "encoding/hex_codec.h"
#include "generated_test_vectors.h"
#include "host_test_harness.h"
#include "vm/virtual_machine.h"

using namespace firmware;

// Runs a whole tick and returns how it ended.
static VmStep runTick(VirtualMachine &machine) {
  machine.startTick();
  for (;;) {
    const VmStep step = machine.execute(3);
    if (step == VmStep::Halted || step == VmStep::Faulted || step == VmStep::Idle) {
      return step;
    }
  }
}

static bool loadHex(VirtualMachine &machine, uint32_t version, const char *hex) {
  uint8_t code[PROGRAM_CAPACITY];
  size_t length = 0;
  ProgramDefect defect{};
  ValidProgram program;
  if (!decodeHexBytes(hex, code, sizeof(code), length) ||
      !validateProgram(code, length, program, defect)) {
    return false;
  }
  machine.loadProgram(version, program);
  return true;
}

// Runs a run vector of firmware/protocol/test-vectors/virtual-machine.json and checks every result.
static void checkRunVector(const VirtualMachineRunVector &vector) {
  VirtualMachine machine;
  machine.begin(vector.instructionLimit);
  CHECK(loadHex(machine, 1, vector.program));
  machine.setRegisters(vector.registers);
  int32_t printed[MAXIMUM_VECTOR_PRINTS + 1] = {};
  uint8_t printedRegisters[MAXIMUM_VECTOR_PRINTS + 1] = {};
  size_t printedCount = 0;
  VmStep step = VmStep::Idle;
  for (uint32_t tick = 0; tick < vector.ticks; ++tick) {
    machine.startTick();
    do {
      step = machine.execute(3);
      if (step == VmStep::Printed && printedCount <= MAXIMUM_VECTOR_PRINTS) {
        printedRegisters[printedCount] = machine.printedRegister();
        printed[printedCount++] = machine.registerValue(machine.printedRegister() - 1);
      }
    } while (step != VmStep::Halted && step != VmStep::Faulted && step != VmStep::Idle);
  }
  const bool halted = std::strcmp(vector.step, "halted") == 0;
  CHECK(step == (halted ? VmStep::Halted : VmStep::Faulted));
  CHECK(printedCount == vector.printCount);
  for (size_t index = 0; index < vector.printCount && index < printedCount; ++index) {
    CHECK(printedRegisters[index] == vector.prints[index].registerNumber);
    CHECK(printed[index] == vector.prints[index].value);
  }
  for (uint8_t index = 0; index < REGISTER_COUNT; ++index) {
    CHECK(machine.registerValue(index) == vector.expectedRegisters[index]);
  }
  if (vector.fault == nullptr) {
    CHECK(machine.fault() == VmFault::None);
  } else {
    CHECK(std::strcmp(vmFaultName(machine.fault()), vector.fault) == 0);
    CHECK(machine.faultAddress() == vector.faultAddress);
  }
  CHECK(machine.tickNumber() == vector.tickNumber);
}

J5_HOST_TEST(testVirtualMachine) {
  for (const VirtualMachineRunVector &vector : VIRTUAL_MACHINE_RUN_VECTORS) {
    checkRunVector(vector);
  }

  // The validation checks the whole program and tells where the first bad instruction is and
  // which fault it would raise.
  for (const ProgramCheckVector &vector : PROGRAM_CHECK_VECTORS) {
    uint8_t code[PROGRAM_CAPACITY];
    size_t length = 0;
    CHECK(decodeHexBytes(vector.program, code, sizeof(code), length));
    ProgramDefect defect{};
    ValidProgram program;
    CHECK(validateProgram(code, length, program, defect) == vector.valid);
    CHECK(defect.address == vector.address && program.length() == 0);
    CHECK(std::strcmp(vmFaultName(defect.fault), vector.fault) == 0);
  }

  VirtualMachine machine;
  machine.begin(100);
  CHECK(machine.version() == 0 && !machine.hasProgram());
  CHECK(loadHex(machine, 2, "00"));
  CHECK(machine.version() == 2 && machine.programLength() == 1);
}

J5_HOST_TEST(testVirtualMachineStatus) {
  VirtualMachine machine;
  machine.begin(100);
  CHECK(machine.lastFault() == VmFault::None && !machine.lastTickFaulted());
  // PRINT R1; DIVI R1, 0; HALT: every tick faults.
  CHECK(loadHex(machine, 1,
                "0101"
                "160100000000"
                "00"));
  runTick(machine);
  CHECK(machine.lastFault() == VmFault::DivisionByZero && machine.lastTickFaulted());
  // ADDI R2, 1; DIVR R1, R2; HALT with R2 = -1: the first tick faults and the second halts. A tick
  // that ends in HALT clears the failing mark but keeps the last fault.
  CHECK(loadHex(machine, 2,
                "100201000000"
                "170102"
                "00"));
  const int32_t registers[REGISTER_COUNT] = {1, -1, 3, 4};
  machine.setRegisters(registers);
  CHECK(runTick(machine) == VmStep::Faulted && machine.lastTickFaulted());
  CHECK(runTick(machine) == VmStep::Halted);
  CHECK(machine.lastFault() == VmFault::DivisionByZero && !machine.lastTickFaulted());
  // A load clears the faults, keeps the registers and restarts the tick count.
  CHECK(loadHex(machine, 3, "00"));
  CHECK(machine.lastFault() == VmFault::None && !machine.lastTickFaulted());
  CHECK(machine.registerValue(3) == 4 && machine.tickNumber() == 0);
  runTick(machine);
  CHECK(machine.tickNumber() == 1 && !machine.lastTickFaulted());

  ProgramDefect defect{};
  ValidProgram program;
  const uint8_t valid[] = {0x01, 0x01, 0x00};
  const uint8_t cut[] = {0x01, 0x01, 0x02, 0x01};
  CHECK(validateProgram(valid, sizeof(valid), program, defect));
  CHECK(program.code() == valid && program.length() == sizeof(valid));
  CHECK(!validateProgram(cut, sizeof(cut), program, defect) && defect.address == 2);
  CHECK(defect.fault == VmFault::TruncatedInstruction);
  // Neither an empty program nor one over the capacity, which no fault describes.
  uint8_t halts[MAXIMUM_PROGRAM_SIZE + 1] = {};
  CHECK(!validateProgram(halts, 0, program, defect));
  CHECK(defect.address == 0 && defect.fault == VmFault::None);
  CHECK(!validateProgram(halts, sizeof(halts), program, defect));
  CHECK(defect.address == 0 && defect.fault == VmFault::None);
  CHECK(validateProgram(halts, MAXIMUM_PROGRAM_SIZE, program, defect));
  // A copy of a valid program is valid and refers to its own bytes.
  uint8_t copy[sizeof(valid)] = {};
  CHECK(validateProgram(valid, sizeof(valid), program, defect));
  const ValidProgram moved = program.copyTo(copy);
  CHECK(moved.code() == copy && moved.length() == sizeof(valid));
  CHECK(std::memcmp(copy, valid, sizeof(valid)) == 0);
}
