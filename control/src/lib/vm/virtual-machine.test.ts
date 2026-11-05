// The cases follow testVirtualMachine in firmware/tests/host_tests.cpp, with the same programs, so
// that the node and the panel are checked against the same values.
import { describe, expect, it } from "vite-plus/test";
import { VirtualMachine, checkProgram, finishTick, runTick } from "./virtual-machine.ts";

function codeOf(hex: string): Uint8Array {
  return Uint8Array.from(hex.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));
}

function loaded(
  hex: string,
  registers: readonly number[] = [0, 0, 0, 0],
  limit?: number,
): VirtualMachine {
  const machine = new VirtualMachine(limit);
  expect(machine.load(codeOf(hex)).valid).toBe(true);
  machine.setRegisters(registers);
  return machine;
}

describe("VirtualMachine", () => {
  it("runs the example program and prints after each PRINT", () => {
    const machine = loaded(
      "020105000000" +
        "020203000000" +
        "110102" +
        "0101" +
        "12010a000000" +
        "150102" +
        "0101" +
        "00",
    );
    const outcome = runTick(machine);
    expect(outcome.step).toBe("halted");
    expect(outcome.prints.map((print) => print.value)).toEqual([8, -6]);
    expect(machine.tickNumber).toBe(1);
  });

  it("keeps the registers from one tick to the next", () => {
    const machine = loaded("100101000000" + "00");
    runTick(machine);
    runTick(machine);
    expect(machine.registers[0]).toBe(2);
  });

  it("wraps around and shifts as the firmware does", () => {
    const machine = loaded(
      "100101000000" +
        "170203" +
        "190303" +
        "2004ffffffff" +
        "2a04" +
        "280401000000" +
        "260321000000" +
        "00",
      [2147483647, -7, 2, 0],
    );
    expect(runTick(machine).step).toBe("halted");
    expect(machine.registers).toEqual([-2147483648, -3, 0, -1]);

    const minimum = loaded("1601ffffffff" + "1801ffffffff" + "00", [-2147483648, 0, 0, 0]);
    runTick(minimum);
    expect(minimum.registers[0]).toBe(0);
  });

  it("ends the tick on a fault and keeps the address of the instruction", () => {
    const division = loaded("0101" + "160100000000" + "00");
    expect(runTick(division).step).toBe("faulted");
    expect([division.fault, division.faultAddress]).toEqual(["division_by_zero", 2]);

    const unfinished = loaded("0101");
    runTick(unfinished);
    expect(unfinished.fault).toBe("end_of_program");

    const limited = loaded("0101" + "0101" + "0101" + "0101" + "00", [0, 0, 0, 0], 3);
    runTick(limited);
    expect(limited.fault).toBe("instruction_limit");
  });

  it("runs one instruction at a time and finishes the tick later", () => {
    const machine = loaded("020107000000" + "0101" + "00");
    machine.startTick();
    expect(machine.execute(1)).toBe("running");
    expect(machine.programCounter).toBe(6);
    expect(machine.execute(1)).toBe("printed");
    expect(finishTick(machine).step).toBe("halted");
  });
});

describe("checkProgram", () => {
  it("rejects what the node rejects", () => {
    expect(checkProgram(codeOf("0101" + "3f"))).toEqual({
      valid: false,
      address: 2,
      fault: "invalid_opcode",
    });
    expect(checkProgram(codeOf("110105"))).toMatchObject({ fault: "invalid_register" });
    expect(checkProgram(codeOf("020100"))).toMatchObject({ fault: "truncated_instruction" });
  });
});
