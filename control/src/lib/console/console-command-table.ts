/**
 * The console commands as the contract lists them (CONSOLE_COMMANDS, the same table the firmware
 * dispatches with): their names, the characters a line of each may take, and the first word of a
 * line as the firmware reads it. The builders of the panel are in $lib/commands/console-command.ts.
 */
import { CONSOLE_COMMANDS, CONSOLE_LINE_CAPACITY } from "$lib/protocol/protocol-contract.ts";

export type ConsoleCommandDefinition = (typeof CONSOLE_COMMANDS)[number];
export type ConsoleCommandForm = ConsoleCommandDefinition["forms"][number];
/** What a form of a command does; the simulated node binds a handler to each one. */
export type ConsoleCommandAction = ConsoleCommandForm["action"];

/** The words of a command line as the firmware splits them: text separated by spaces. */
export function commandWordsOf(commandLine: string): string[] {
  return commandLine.split(" ").filter((word) => word !== "");
}

/** First word of a command line, as the firmware reports it in the `cmd` field of `error`. */
export function commandWordOf(commandLine: string): string {
  return commandWordsOf(commandLine)[0] ?? "";
}

export function findConsoleCommand(name: string): ConsoleCommandDefinition | null {
  return CONSOLE_COMMANDS.find((command) => command.name === name) ?? null;
}

export function consoleCommandOf(action: ConsoleCommandAction): {
  readonly command: ConsoleCommandDefinition;
  readonly form: ConsoleCommandForm;
} {
  for (const command of CONSOLE_COMMANDS) {
    const form = command.forms.find((candidate) => candidate.action === action);
    if (form !== undefined) {
      return { command, form };
    }
  }
  throw new Error(`no console command does ${action}`);
}

/**
 * The line of a form that takes no argument besides its selector, such as "status" or
 * "radio reset". Throws for a form that needs other arguments.
 */
export function bareCommandLineOf(action: ConsoleCommandAction): string {
  const { command, form } = consoleCommandOf(action);
  const words = form.selector === null ? [command.name] : [command.name, form.selector];
  if (form.minimumArguments > words.length - 1) {
    throw new Error(`${action} needs arguments`);
  }
  return words.join(" ");
}

/**
 * Characters the node accepts in `commandLine`, as its command table sets them: the capacity of
 * the command it names, or CONSOLE_LINE_CAPACITY for a line that names none.
 */
export function lineCapacityOf(commandLine: string): number {
  return findConsoleCommand(commandWordOf(commandLine))?.lineCapacity ?? CONSOLE_LINE_CAPACITY;
}
