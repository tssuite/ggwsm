# Changelog

## Unreleased

### Fixed

- Prompts are drawn in gg's colour scheme, like native gg: the question
  is yellow, the marked option blue behind a dark gray `❯`, every other
  option white. Colours gg puts into a question or an option are
  replaced, bold stays.
- A question that starts with a blank line is redrawn in full when the
  arrow keys move the marker, instead of leaving a stale line behind.
- Picks up gg 17.4.2.

## 0.0.4 - 2026-08-20

### Fixed

- `ggwsm dna add` and `ggwsm dna build` crashed. The DNA engine reached
  for `Isolate.resolvePackageUri` and `Process.runSync`, neither of which
  a WebAssembly build has. Picks up helix 1.1.0, which routes both
  through the host. The whole quickstart now runs under `ggwsm`.

## 0.0.3 - 2026-08-20

### Added

- The `gg` command line itself, compiled to WebAssembly. `npx @tssuite/ggwsm
  <args>` runs it; `bin` in package.json makes the binary available to
  npm scripts as `ggwsm`.
- `createNodeHost()` — the file system, process, platform and console
  callbacks gg needs, implemented on `node:fs`, `node:child_process` and
  `process`. It tracks gg's working directory itself rather than moving the
  Node process'.
- `runGg(args, options)` and `init()` for driving gg from TypeScript, with
  any `GgHost` — including one that is not a file system at all.
- End-to-end tests that spawn the built binary as a real process against a
  throwaway gg workspace with a git repository in it.

- Started processes stream: `host.process.start` hands over a
  `StartedProcess` while the program runs, so gg sees `dart test`'s output
  line by line and can type into a program's stdin. Without it
  `gg one can commit` read a passing suite as a failure.

- `createNodeHost` supplies the interactive prompts, so the commands that
  ask questions work. A numbered list and a line of input rather than the
  native arrow-key list — `package:interact` needs `dart:ffi`. Pass
  `prompts: false` to leave gg without them.

- CI runs on Windows as well as Linux. The build scripts no longer reach
  for `rm`, `cp` and `chmod`, the process fixtures no longer for `sh`,
  `cat` and `sleep`, and batch wrappers are given the shell Node requires
  for them.

- The prompt callbacks are asynchronous, so the Node host reads through
  `readline` rather than blocking on a file descriptor — which is what a
  Windows console handle does not support.

### Changed

- The bridge is now `globalThis.ggBridge` with two methods, `setHost` and
  `run`. The four interop demo patterns it carried before are gone; the
  package is a tool now, not an example.
- Preconditions are checked in TypeScript, so a misused bridge throws a
  readable `Error` instead of an opaque `WebAssembly.Exception`.

### Fixed

- `globalThis.location` is installed before the module starts.
  `package:path` reads `Uri.base` from it to decide between posix and
  windows separators, and Node has no `location` — without this the first
  path gg built trapped with `illegal cast`.
- Ignore CHANGELOG.md for prettier
- Update dart dependencies
- Update dart and typescript dependencies
- Update to latest dependencies
- Bump `gg` to 17.2.2
