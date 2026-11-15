// Host tests of the virtual machine: the shared vectors of
// firmware/protocol/test-vectors/virtual-machine.json, the validation of a program and the state
// that the HELLO announces.

#include <cstring>

#include "encoding/hex_codec.h"
#include "generated_test_vectors.h"
#include "host_test_harness.h"
#include "recording_pin_port.h"
#include "vm/virtual_machine.h"

using namespace firmware;

// A machine on the pins of the V4.3 unless the test names another board.
static void beginMachine(VirtualMachine &machine, RecordingPinPort &pins,
                         BoardModel model = BoardModel::HeltecV43) {
  machine.begin(pins, describeBoardModel(model));
}

// Starts the program and runs it to HALT or to a fault, three instructions at a time.
static VmStep runToStop(VirtualMachine &machine) {
  machine.startVM();
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

static const char *stepName(VmStep step) {
  switch (step) {
  case VmStep::Halted:
    return "halted";
  case VmStep::Faulted:
    return "faulted";
  case VmStep::Idle:
  case VmStep::Running:
  case VmStep::Printed:
  case VmStep::Sleeping:
    return "running";
  }
  return "running";
}

// Runs a run vector of firmware/protocol/test-vectors/virtual-machine.json on the board and checks
// every result. Each start runs to HALT, to a fault or to the instruction limit of the vector, one
// instruction at a time so that the limit is exact. The vector names the pins of the VM; the port
// sees the GPIO that the board gives each one.
static void checkRunVector(const VirtualMachineRunVector &vector,
                           const BoardModelDescription &board) {
  RecordingPinPort pins;
  for (size_t index = 0; index < vector.pinLevelCount; ++index) {
    pins.inputLevels[board.vmPins[vector.pinLevels[index].pin]] = vector.pinLevels[index].high;
  }
  VirtualMachine machine;
  machine.begin(pins, board);
  CHECK(loadHex(machine, 1, vector.program));
  machine.setRegisters(vector.registers);
  int32_t printed[MAXIMUM_VECTOR_PRINTS + 1] = {};
  uint8_t printedRegisters[MAXIMUM_VECTOR_PRINTS + 1] = {};
  size_t printedCount = 0;
  uint32_t sleeps[MAXIMUM_VECTOR_SLEEPS + 1] = {};
  size_t sleepCount = 0;
  VmStep step = VmStep::Idle;
  for (uint32_t start = 0; start < vector.starts; ++start) {
    machine.startVM();
    for (uint32_t executed = 0; executed < vector.maximumInstructions; ++executed) {
      step = machine.execute(1);
      if (step == VmStep::Printed && printedCount <= MAXIMUM_VECTOR_PRINTS) {
        printedRegisters[printedCount] = machine.printedRegister();
        printed[printedCount++] = machine.registerValue(machine.printedRegister() - 1);
      } else if (step == VmStep::Sleeping && sleepCount <= MAXIMUM_VECTOR_SLEEPS) {
        sleeps[sleepCount++] = machine.sleepMillis();
      } else if (step == VmStep::Halted || step == VmStep::Faulted) {
        break;
      }
    }
  }
  CHECK(std::strcmp(stepName(step), vector.step) == 0);
  CHECK(printedCount == vector.printCount && machine.printCount() == vector.printCount);
  for (size_t index = 0; index < vector.printCount && index < printedCount; ++index) {
    CHECK(printedRegisters[index] == vector.prints[index].registerNumber);
    CHECK(printed[index] == vector.prints[index].value);
  }
  CHECK(sleepCount == vector.sleepCount);
  for (size_t index = 0; index < vector.sleepCount && index < sleepCount; ++index) {
    CHECK(sleeps[index] == vector.sleeps[index]);
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
  CHECK(machine.startCount() == vector.startCount);
  CHECK(machine.stackDepth() == vector.stackDepth);
  // The output pins at the end, and their levels: none beside those of the vector.
  size_t outputCount = 0;
  for (size_t pin = 0; pin < RecordingPinPort::PIN_COUNT; ++pin) {
    outputCount += pins.outputs[pin] ? 1 : 0;
  }
  CHECK(outputCount == vector.pinOutputCount);
  for (size_t index = 0; index < vector.pinOutputCount; ++index) {
    const PinLevelVector &output = vector.pinOutputs[index];
    const uint8_t gpio = board.vmPins[output.pin];
    CHECK(pins.outputs[gpio] && pins.outputLevels[gpio] == output.high);
  }
}

J5_HOST_TEST(testVirtualMachine) {
  // The same program gives the same results on every board model.
  for (const BoardModelDescription &board : BOARD_MODEL_DESCRIPTIONS) {
    for (const VirtualMachineRunVector &vector : VIRTUAL_MACHINE_RUN_VECTORS) {
      checkRunVector(vector, board);
    }
  }

  // The validation checks the whole program, the targets of jumps and calls included, and tells
  // where the first bad instruction is and why.
  for (const ProgramCheckVector &vector : PROGRAM_CHECK_VECTORS) {
    uint8_t code[PROGRAM_CAPACITY];
    size_t length = 0;
    CHECK(decodeHexBytes(vector.program, code, sizeof(code), length));
    ProgramDefect defect{};
    ValidProgram program;
    CHECK(validateProgram(code, length, program, defect) == vector.valid);
    if (vector.valid) {
      CHECK(program.length() == length);
    } else {
      CHECK(defect.address == vector.address && program.length() == 0);
      CHECK(std::strcmp(programDefectReasonName(defect.reason), vector.reason) == 0);
    }
  }

  RecordingPinPort pins;
  VirtualMachine machine;
  beginMachine(machine, pins);
  CHECK(machine.version() == 0 && !machine.hasProgram());
  CHECK(loadHex(machine, 2, "00"));
  CHECK(machine.version() == 2 && machine.programLength() == 1);

  // A program without end returns after each block, and starting again empties the return stack.
  CHECK(loadHex(machine, 3,
                "340600"
                "300000"
                "100101000000"
                "300600"));
  machine.startVM();
  for (int block = 0; block < 3; ++block) {
    CHECK(machine.execute(64) == VmStep::Running);
  }
  CHECK(machine.stackDepth() == 1);
  machine.startVM();
  CHECK(machine.stackDepth() == 0 && machine.isRunning() && machine.startCount() == 2);
}

J5_HOST_TEST(testVirtualMachineStatus) {
  RecordingPinPort pins;
  VirtualMachine machine;
  beginMachine(machine, pins);
  CHECK(machine.lastFault() == VmFault::None && !machine.hasFaultedSinceReport());
  // PRINT R1; DIVI R1, 0; HALT: every start faults.
  CHECK(loadHex(machine, 1,
                "0101"
                "160100000000"
                "00"));
  runToStop(machine);
  CHECK(machine.lastFault() == VmFault::DivisionByZero && machine.hasFaultedSinceReport());
  // A HELLO announces the fault and clears the failing mark; the last fault stays.
  machine.clearFaultReport();
  CHECK(machine.lastFault() == VmFault::DivisionByZero && !machine.hasFaultedSinceReport());
  // ADDI R2, 1; DIVR R1, R2; HALT with R2 = -1: the first start faults and the second halts. A
  // start that ends in HALT leaves the failing mark until the next HELLO.
  CHECK(loadHex(machine, 2,
                "100201000000"
                "170102"
                "00"));
  const int32_t registers[REGISTER_COUNT] = {1, -1, 3, 4};
  machine.setRegisters(registers);
  CHECK(runToStop(machine) == VmStep::Faulted && machine.hasFaultedSinceReport());
  CHECK(runToStop(machine) == VmStep::Halted && machine.hasFaultedSinceReport());
  CHECK(machine.lastFault() == VmFault::DivisionByZero);
  // A load clears the faults, keeps the registers and restarts the counts.
  CHECK(loadHex(machine, 3, "00"));
  CHECK(machine.lastFault() == VmFault::None && !machine.hasFaultedSinceReport());
  CHECK(machine.registerValue(3) == 4 && machine.startCount() == 0 && machine.printCount() == 0);
  runToStop(machine);
  CHECK(machine.startCount() == 1 && !machine.hasFaultedSinceReport());

  ProgramDefect defect{};
  ValidProgram program;
  const uint8_t valid[] = {0x01, 0x01, 0x00};
  const uint8_t cut[] = {0x01, 0x01, 0x02, 0x01};
  CHECK(validateProgram(valid, sizeof(valid), program, defect));
  CHECK(program.code() == valid && program.length() == sizeof(valid));
  CHECK(!validateProgram(cut, sizeof(cut), program, defect) && defect.address == 2);
  CHECK(defect.reason == ProgramDefectReason::TruncatedInstruction);
  // Neither an empty program nor one over the capacity; the image verifier rejects their length
  // before, so the defect only says address 0.
  uint8_t halts[MAXIMUM_PROGRAM_SIZE + 1] = {};
  CHECK(!validateProgram(halts, 0, program, defect) && defect.address == 0);
  CHECK(!validateProgram(halts, sizeof(halts), program, defect) && defect.address == 0);
  CHECK(validateProgram(halts, MAXIMUM_PROGRAM_SIZE, program, defect));
  // A copy of a valid program is valid and refers to its own bytes.
  uint8_t copy[sizeof(valid)] = {};
  CHECK(validateProgram(valid, sizeof(valid), program, defect));
  const ValidProgram moved = program.copyTo(copy);
  CHECK(moved.code() == copy && moved.length() == sizeof(valid));
  CHECK(std::memcmp(copy, valid, sizeof(valid)) == 0);
}

// LOAD R1, 1; LOAD R2, 0; PINM R1, R2; PINW R1, R2; HALT: lights the white LED, pin 0 of the VM.
static const char *const LIGHT_LED_PROGRAM = "020101000000"
                                             "020200000000"
                                             "400102"
                                             "420102"
                                             "00";

J5_HOST_TEST(testVirtualMachinePinsOfEachBoard) {
  // Pin 0 is the white LED of both boards: GPIO 25 on the V2 and GPIO 35 on the V4.3.
  struct LedPin {
    BoardModel model;
    uint8_t gpio;
  };
  const LedPin ledPins[] = {{BoardModel::HeltecV2, 25}, {BoardModel::HeltecV43, 35}};
  for (const LedPin &led : ledPins) {
    RecordingPinPort pins;
    VirtualMachine machine;
    beginMachine(machine, pins, led.model);
    CHECK(loadHex(machine, 1, LIGHT_LED_PROGRAM));
    CHECK(runToStop(machine) == VmStep::Halted);
    const uint8_t gpio = led.gpio;
    CHECK(pins.configured[gpio] && pins.outputs[gpio] && pins.outputLevels[gpio]);
    size_t configuredCount = 0;
    for (size_t pin = 0; pin < RecordingPinPort::PIN_COUNT; ++pin) {
      configuredCount += pins.configured[pin] ? 1 : 0;
    }
    CHECK(configuredCount == 1);
  }
}

J5_HOST_TEST(testVirtualMachinePinRelease) {
  RecordingPinPort pins;
  VirtualMachine machine;
  beginMachine(machine, pins);
  CHECK(loadHex(machine, 1, LIGHT_LED_PROGRAM));
  CHECK(runToStop(machine) == VmStep::Halted);
  CHECK(pins.configured[35] && pins.outputs[35] && pins.outputLevels[35]);
  // Starting again releases the pin before the first instruction runs.
  machine.startVM();
  CHECK(!pins.configured[35] && !pins.outputs[35]);
  CHECK(runToStop(machine) == VmStep::Halted && pins.outputs[35]);
  // So does loading another program.
  CHECK(loadHex(machine, 2, "00"));
  CHECK(!pins.configured[35] && !pins.outputs[35]);
}
