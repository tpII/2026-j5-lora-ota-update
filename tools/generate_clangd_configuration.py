#!/usr/bin/env python3
"""Generates firmware/.clangd so clangd (Zed, VS Code, Neovim) understands the firmware.

arduino-cli writes a compilation database for a build profile of firmware/sketch.yaml, but its
entries point to the copies of the sketch inside the build directory and hide most flags behind
response files. This script expands those flags, asks the Xtensa compiler for its own include
directories and writes every option into firmware/.clangd, so clangd works on the real sources.

The result holds absolute paths of this computer: run the script again after changing the profile,
the core or a library.

Usage: tools/generate_clangd_configuration.py [profile]
The profile is one of firmware/sketch.yaml, the first one by default.
"""

import argparse
import datetime
import json
import os
import shlex
import subprocess
import sys
import tempfile
from pathlib import Path

REPOSITORY_DIRECTORY = Path(__file__).resolve().parent.parent
FIRMWARE_DIRECTORY = REPOSITORY_DIRECTORY / "firmware"
CONFIGURATION_PATH = FIRMWARE_DIRECTORY / ".clangd"
HOST_TEST_SCRIPT = FIRMWARE_DIRECTORY / "tests" / "run_host_tests.sh"
PROFILE_LISTER = REPOSITORY_DIRECTORY / "tools" / "list_build_profiles.mjs"
# Generic Xtensa triple: clangd only needs the data model and the predefined macros.
CLANG_TARGET = "xtensa-esp-elf"
LANGUAGE_FLAGS = ("-fno-rtti", "-frtti", "-fexceptions", "-fno-exceptions")


def build_compilation_database(profile: str, build_directory: str) -> list:
    subprocess.run(
        [
            "arduino-cli",
            "compile",
            "--profile",
            profile,
            "--only-compilation-database",
            "--build-path",
            build_directory,
            str(FIRMWARE_DIRECTORY),
        ],
        check=True,
        stdout=subprocess.DEVNULL,
    )
    return json.loads(Path(build_directory, "compile_commands.json").read_text())


def select_sketch_entry(database: list) -> dict:
    for entry in database:
        file_name = entry["file"].replace(os.sep, "/")
        if "/sketch/src/" in file_name and file_name.endswith(".cpp"):
            return entry
    sys.exit("The compilation database has no entry for a source file of the sketch.")


def expand_arguments(arguments: list) -> list:
    """Replaces response files (@file) by their contents, recursively."""
    expanded = []
    for argument in arguments:
        if argument.startswith("@"):
            response_file = Path(argument[1:])
            if response_file.is_file():
                expanded.extend(expand_arguments(shlex.split(response_file.read_text())))
        else:
            expanded.append(argument)
    return expanded


def collect_options(arguments: list) -> dict:
    defines = []
    include_directories = []
    language_flags = []
    standard = None
    prefix = ""
    index = 0
    while index < len(arguments):
        argument = arguments[index]
        following = arguments[index + 1] if index + 1 < len(arguments) else ""
        if argument.startswith("-D"):
            defines.append(argument)
        elif argument == "-iprefix":
            prefix = following
            index += 1
        elif argument == "-iwithprefixbefore":
            include_directories.append(os.path.normpath(prefix + following))
            index += 1
        elif argument.startswith("-I") and len(argument) > 2:
            include_directories.append(os.path.normpath(argument[2:]))
        elif argument == "-I":
            include_directories.append(os.path.normpath(following))
            index += 1
        elif argument.startswith("-std="):
            standard = argument  # The last one wins, as in GCC.
        elif argument in LANGUAGE_FLAGS:
            language_flags.append(argument)
        index += 1
    return {
        "defines": list(dict.fromkeys(defines)),
        "include_directories": list(dict.fromkeys(include_directories)),
        "language_flags": list(dict.fromkeys(language_flags)),
        "standard": standard or "-std=gnu++2a",
    }


def query_compiler_include_directories(compiler: str) -> list:
    """System include directories of the Xtensa compiler: libstdc++ and newlib."""
    result = subprocess.run(
        [compiler, "-xc++", "-E", "-v", "-"],
        stdin=subprocess.DEVNULL,
        capture_output=True,
        text=True,
        check=True,
    )
    directories = []
    inside = False
    for line in result.stderr.splitlines():
        if line.startswith("#include <...> search starts here:"):
            inside = True
        elif line.startswith("End of search list."):
            break
        elif inside:
            directories.append(os.path.normpath(line.strip()))
    return directories


def list_build_profiles() -> list:
    """Build profiles of firmware/sketch.yaml, in the order of the file."""
    result = subprocess.run(
        ["node", str(PROFILE_LISTER)], capture_output=True, text=True, check=True
    )
    return result.stdout.split()


def query_host_test_flags() -> list:
    """Compiler options of the host tests, from the script that builds them."""
    result = subprocess.run(
        ["bash", str(HOST_TEST_SCRIPT), "--print-compile-flags"],
        capture_output=True,
        text=True,
        check=True,
    )
    return result.stdout.splitlines()


def quote(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def write_configuration(
    profile: str, options: dict, compiler_directories: list, host_test_flags: list
) -> None:
    sketch_directory = os.path.normpath(str(FIRMWARE_DIRECTORY))
    lines = [
        f"# Generated by tools/generate_clangd_configuration.py for the {profile} profile",
        f"# on {datetime.date.today().isoformat()}. Do not edit: run the script again after changing",
        "# the profile, the core or a library. The paths belong to this computer.",
        "If:",
        "  PathExclude: tests/.*",
        "CompileFlags:",
        "  # The database of arduino-cli points to copies of the sketch; these options apply to the",
        "  # real sources instead.",
        "  CompilationDatabase: None",
        "  Add:",
        f"    - --target={CLANG_TARGET}",
        "    - -nostdlibinc",
    ]
    lines += [f"    - {quote(define)}" for define in options["defines"]]
    lines.append("    # The sketch; everything else as system headers, so their warnings stay quiet.")
    lines.append(f"    - {quote('-I' + sketch_directory)}")
    for directory in options["include_directories"]:
        if directory != sketch_directory:
            lines.append(f"    - {quote('-isystem' + directory)}")
    lines.append("    # Toolchain headers (libstdc++ and newlib) last, as GCC searches them.")
    lines += [f"    - {quote('-isystem' + directory)}" for directory in compiler_directories]
    lines += [
        "---",
        "If:",
        "  PathMatch: .*\\.(ino|cpp|h)",
        "  PathExclude: tests/.*",
        "CompileFlags:",
        "  Add:",
        "    - -xc++",
        f"    - {options['standard']}",
    ]
    lines += [f"    - {flag}" for flag in options["language_flags"]]
    lines += [
        "---",
        "# The Arduino IDE includes Arduino.h in every .ino file.",
        "If:",
        "  PathMatch: .*\\.ino",
        "CompileFlags:",
        "  Add:",
        "    - -include",
        "    - Arduino.h",
        "---",
        "If:",
        "  PathMatch: .*\\.c",
        "  PathExclude: tests/.*",
        "CompileFlags:",
        "  Add:",
        "    - -xc",
        "    - -std=gnu17",
        "---",
        "# Host tests: compiled for the computer with the options of tests/run_host_tests.sh.",
        "If:",
        "  PathMatch: tests/.*",
        "CompileFlags:",
        "  CompilationDatabase: None",
        "  Add:",
        "    - -xc++",
    ]
    lines += [f"    - {quote(flag)}" for flag in host_test_flags]
    CONFIGURATION_PATH.write_text("\n".join(lines) + "\n")


def main() -> None:
    profiles = list_build_profiles()
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("profile", nargs="?", default=profiles[0], choices=profiles)
    profile = parser.parse_args().profile

    with tempfile.TemporaryDirectory() as build_directory:
        database = build_compilation_database(profile, build_directory)
        entry = select_sketch_entry(database)
        arguments = entry.get("arguments") or shlex.split(entry["command"])
        options = collect_options(expand_arguments(arguments[1:]))
        compiler_directories = query_compiler_include_directories(arguments[0])

    write_configuration(profile, options, compiler_directories, query_host_test_flags())
    print(f"Wrote {CONFIGURATION_PATH.relative_to(REPOSITORY_DIRECTORY)} for {profile}.")


if __name__ == "__main__":
    main()
