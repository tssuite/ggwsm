// @license
// Copyright (c) 2026 ggsuite
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

// Unit tests for the Node host — the half of the bridge that gg never sees.
//
// Every callback here is what `dart:io` ends up calling once gg runs, so
// the tests read like a `dart:io` conformance suite: the same operations,
// against a real temp directory, with the same expectations.

import { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
    createNodeHost, needsShell, NodeStartedProcess, nodePlatformToDart,
    outcomeExitCode, readLineFrom, resolveExecutable, spawnCommand
} from '../host-node.js';
import { EntityType, GgHost, StartedProcess } from '../host.js';


/**
 * Whether this machine lets an unprivileged process create a symbolic link.
 *
 * Windows refuses one unless the process is elevated or Developer Mode is
 * on, and `dart:io` hits exactly the same wall: its `CreateSymbolicLinkW`
 * call passes `SYMBOLIC_LINK_FLAG_ALLOW_UNPRIVILEGED_CREATE`, and Developer
 * Mode is what makes that flag work. So a refusal here is the machine's
 * answer rather than a bug in the host, and the cases that need a link say
 * so instead of failing. Junctions would work unprivileged, but `dart:io`
 * does not create those, so neither does the host.
 */
const symlinksAllowed = ((): boolean => {
  const probe = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-symlink-probe-'));
  try {
    fs.writeFileSync(path.join(probe, 'target'), '');
    fs.symlinkSync(path.join(probe, 'target'), path.join(probe, 'link'));
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(probe, { recursive: true, force: true });
  }
})();

describe('createNodeHost()', () => {
  let tmp: string;
  let host: GgHost;

  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gg-host-')));
    host = createNodeHost({ workingDirectory: tmp });
  });

  afterEach(() => {
    // Windows keeps a directory locked while a process still sits in it,
    // and a child that just wrote its last file may need another moment to
    // actually exit. Retrying rides out that gap instead of failing the
    // next test's cleanup.
    fs.rmSync(tmp, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  });

  // ###########################################################################
  describe('fs', () => {
    test('answers typeOf for files, directories and gaps', () => {
      fs.writeFileSync(path.join(tmp, 'file.txt'), 'x');
      fs.mkdirSync(path.join(tmp, 'dir'));

      expect(host.fs.typeOf(path.join(tmp, 'file.txt'), true)).toBe(
        EntityType.File,
      );
      expect(host.fs.typeOf(path.join(tmp, 'dir'), true)).toBe(
        EntityType.Directory,
      );
      expect(host.fs.typeOf(path.join(tmp, 'nope'), true)).toBe(
        EntityType.NotFound,
      );
    });

    test('resolves relative paths against its own working directory', () => {
      fs.writeFileSync(path.join(tmp, 'rel.txt'), 'relative');

      expect(host.fs.typeOf('rel.txt', true)).toBe(EntityType.File);
      expect(new TextDecoder().decode(host.fs.readBytes('rel.txt'))).toBe(
        'relative',
      );
    });

    test('reads and writes bytes, appending on demand', () => {
      const file = path.join(tmp, 'bytes.bin');
      host.fs.writeBytes(file, new Uint8Array([1, 2, 3]), false);
      expect([...host.fs.readBytes(file)]).toEqual([1, 2, 3]);

      host.fs.writeBytes(file, new Uint8Array([4]), true);
      expect([...host.fs.readBytes(file)]).toEqual([1, 2, 3, 4]);

      host.fs.writeBytes(file, new Uint8Array([9]), false);
      expect([...host.fs.readBytes(file)]).toEqual([9]);
    });

    test('creates directories and files', () => {
      host.fs.createDirectory(path.join(tmp, 'a/b/c'), true);
      expect(fs.existsSync(path.join(tmp, 'a/b/c'))).toBe(true);

      host.fs.createFile(path.join(tmp, 'a/b/c/new.txt'), true);
      expect(fs.readFileSync(path.join(tmp, 'a/b/c/new.txt'), 'utf8')).toBe('');

      // Creating an existing file leaves its content alone.
      fs.writeFileSync(path.join(tmp, 'a/b/c/new.txt'), 'kept');
      host.fs.createFile(path.join(tmp, 'a/b/c/new.txt'), false);
      expect(fs.readFileSync(path.join(tmp, 'a/b/c/new.txt'), 'utf8')).toBe(
        'kept',
      );
    });

    test('deletes files and directories', () => {
      fs.writeFileSync(path.join(tmp, 'gone.txt'), 'x');
      host.fs.deleteEntity(path.join(tmp, 'gone.txt'), false);
      expect(fs.existsSync(path.join(tmp, 'gone.txt'))).toBe(false);

      fs.mkdirSync(path.join(tmp, 'tree/sub'), { recursive: true });
      fs.writeFileSync(path.join(tmp, 'tree/sub/f.txt'), 'x');
      host.fs.deleteEntity(path.join(tmp, 'tree'), true);
      expect(fs.existsSync(path.join(tmp, 'tree'))).toBe(false);
    });

    test('lists directories flat and recursively', () => {
      fs.mkdirSync(path.join(tmp, 'list/sub'), { recursive: true });
      fs.writeFileSync(path.join(tmp, 'list/top.txt'), 'x');
      fs.writeFileSync(path.join(tmp, 'list/sub/deep.txt'), 'x');

      const flat = host.fs.listDirectory(path.join(tmp, 'list'), false);
      expect(flat.map((e) => path.basename(e.path)).sort()).toEqual([
        'sub',
        'top.txt',
      ]);
      expect(flat.find((e) => e.path.endsWith('sub'))?.type).toBe(
        EntityType.Directory,
      );
      expect(flat.find((e) => e.path.endsWith('top.txt'))?.type).toBe(
        EntityType.File,
      );

      const deep = host.fs.listDirectory(path.join(tmp, 'list'), true);
      expect(deep.map((e) => path.basename(e.path))).toContain('deep.txt');
    });

    test('renames and copies', () => {
      fs.writeFileSync(path.join(tmp, 'from.txt'), 'payload');

      host.fs.rename(path.join(tmp, 'from.txt'), path.join(tmp, 'to.txt'));
      expect(fs.readFileSync(path.join(tmp, 'to.txt'), 'utf8')).toBe('payload');

      host.fs.copyFile(path.join(tmp, 'to.txt'), path.join(tmp, 'copy.txt'));
      expect(fs.readFileSync(path.join(tmp, 'copy.txt'), 'utf8')).toBe(
        'payload',
      );
    });

    test('tracks its working directory without moving the Node process', () => {
      const nodeCwd = process.cwd();

      expect(host.fs.currentDirectory()).toBe(tmp);
      fs.mkdirSync(path.join(tmp, 'inner'));
      host.fs.setCurrentDirectory(path.join(tmp, 'inner'));

      expect(host.fs.currentDirectory()).toBe(path.join(tmp, 'inner'));
      expect(process.cwd()).toBe(nodeCwd);
    });

    test('creates temp directories below a parent', () => {
      const temp = host.fs.createTempDirectory(tmp, 'prefix');
      expect(fs.existsSync(temp)).toBe(true);
      expect(path.basename(temp).startsWith('prefix')).toBe(true);
      expect(host.fs.systemTempDirectory()).toBe(os.tmpdir());
    });

    // Every case that needs a link of its own. See `symlinksAllowed`: a
    // Windows machine without Developer Mode cannot create one, and native
    // gg could not either, so these report as skipped rather than failed.
    describe.skipIf(!symlinksAllowed)('symbolic links', () => {
      test('answers typeOf for a link and for what it points at', () => {
        fs.writeFileSync(path.join(tmp, 'file.txt'), 'x');
        fs.symlinkSync(path.join(tmp, 'file.txt'), path.join(tmp, 'link.txt'));

        expect(host.fs.typeOf(path.join(tmp, 'link.txt'), false)).toBe(
          EntityType.Link,
        );
        // Followed, the link is the file it points at.
        expect(host.fs.typeOf(path.join(tmp, 'link.txt'), true)).toBe(
          EntityType.File,
        );
      });

      test('deletes a link and leaves its target alone', () => {
        fs.writeFileSync(path.join(tmp, 'target.txt'), 'x');
        fs.symlinkSync(path.join(tmp, 'target.txt'), path.join(tmp, 'l'));

        host.fs.deleteEntity(path.join(tmp, 'l'), false);

        expect(fs.existsSync(path.join(tmp, 'l'))).toBe(false);
        expect(fs.existsSync(path.join(tmp, 'target.txt'))).toBe(true);
      });

      test('lists a link as a link', () => {
        fs.mkdirSync(path.join(tmp, 'list'), { recursive: true });
        fs.writeFileSync(path.join(tmp, 'list/top.txt'), 'x');
        fs.symlinkSync(
          path.join(tmp, 'list/top.txt'),
          path.join(tmp, 'list/link.txt'),
        );

        const flat = host.fs.listDirectory(path.join(tmp, 'list'), false);

        expect(flat.find((e) => e.path.endsWith('link.txt'))?.type).toBe(
          EntityType.Link,
        );
      });

      test('creates, reads and resolves symbolic links', () => {
        fs.writeFileSync(path.join(tmp, 'real.txt'), 'x');
        host.fs.createLink(path.join(tmp, 'sym'), path.join(tmp, 'real.txt'));

        expect(host.fs.linkTarget(path.join(tmp, 'sym'))).toBe(
          path.join(tmp, 'real.txt'),
        );
        expect(host.fs.resolveSymbolicLinks(path.join(tmp, 'sym'))).toBe(
          path.join(tmp, 'real.txt'),
        );
      });
    });

    // The mirror image of the block above. The same three callbacks still
    // have to behave on a machine that refuses symbolic links, and between
    // the two blocks every one of them is exercised wherever the suite
    // runs.
    describe.skipIf(symlinksAllowed)('where links are not permitted', () => {
      test('resolves a path that involves no link at all', () => {
        fs.writeFileSync(path.join(tmp, 'plain.txt'), 'x');

        expect(host.fs.resolveSymbolicLinks(path.join(tmp, 'plain.txt'))).toBe(
          path.join(tmp, 'plain.txt'),
        );
      });

      test('hands the refusal to gg rather than swallowing it', () => {
        // A swallowed error would leave gg believing it made a link.
        fs.writeFileSync(path.join(tmp, 'real.txt'), 'x');

        expect(() =>
          host.fs.createLink(path.join(tmp, 'sym'), path.join(tmp, 'real.txt')),
        ).toThrow(/EPERM|EACCES/);
      });

      // A junction is the one reparse point Windows makes without a
      // privilege. It is not what `dart:io` creates, so the host never
      // makes one, but it reads back as a link and that is enough to put
      // the link-reading half of the host through its paces here.
      test('reads a junction like any other link', () => {
        fs.mkdirSync(path.join(tmp, 'dir'));
        fs.symlinkSync(path.join(tmp, 'dir'), path.join(tmp, 'j'), 'junction');

        expect(host.fs.linkTarget(path.join(tmp, 'j'))).toBe(
          path.join(tmp, 'dir'),
        );
        expect(host.fs.typeOf(path.join(tmp, 'j'), false)).toBe(
          EntityType.Link,
        );
        // Followed, the junction is the directory it points at.
        expect(host.fs.typeOf(path.join(tmp, 'j'), true)).toBe(
          EntityType.Directory,
        );
      });

      test('lists a junction as a link', () => {
        fs.mkdirSync(path.join(tmp, 'list', 'dir'), { recursive: true });
        fs.symlinkSync(
          path.join(tmp, 'list', 'dir'),
          path.join(tmp, 'list', 'j'),
          'junction',
        );

        const flat = host.fs.listDirectory(path.join(tmp, 'list'), false);

        expect(flat.find((e) => e.path.endsWith('j'))?.type).toBe(
          EntityType.Link,
        );
      });
    });

    test('lets a read of a missing file fail', () => {
      // gg asks `typeOf` before it reads; a read that still fails is a real
      // error and must not be swallowed.
      expect(() => host.fs.readBytes(path.join(tmp, 'missing'))).toThrow();
    });
  });

  // ###########################################################################
  describe('process', () => {
    const options = {
      includeParentEnvironment: true,
      runInShell: false,
      detached: false,
    };

    test('runs a program and reports its output', async () => {
      const result = await host.process.run(
        process.execPath,
        ['-e', 'process.stdout.write("out"); process.stderr.write("err")'],
        options,
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('out');
      expect(result.stderr).toBe('err');
    });

    test('reports a child killed by a signal as a failure', async () => {
      const result = await host.process.run(
        process.execPath,
        ['-e', 'process.kill(process.pid, "SIGKILL")'],
        options,
      );

      // No exit status exists for a killed process on POSIX; the shells
      // gg cares about report those as 128 + signal. Windows has no real
      // signals — Node emulates SIGKILL with `TerminateProcess(handle, 1)`
      // — so status is never null there and only »not zero« is the actual
      // contract (see the `run()` implementation).
      if (process.platform === 'win32') {
        expect(result.exitCode).not.toBe(0);
      } else {
        expect(result.exitCode).toBe(128);
      }
    });

    test('reports a non-zero exit code', async () => {
      const result = await host.process.run(
        process.execPath,
        ['-e', 'process.exit(3)'],
        options,
      );

      expect(result.exitCode).toBe(3);
    });

    test('runs in the requested directory', async () => {
      fs.mkdirSync(path.join(tmp, 'elsewhere'));
      const result = await host.process.run(
        process.execPath,
        ['-e', 'process.stdout.write(process.cwd())'],
        { ...options, workingDirectory: path.join(tmp, 'elsewhere') },
      );

      expect(fs.realpathSync(result.stdout)).toBe(
        path.join(tmp, 'elsewhere'),
      );
    });

    test('passes extra environment variables through', async () => {
      const result = await host.process.run(
        process.execPath,
        ['-e', 'process.stdout.write(process.env.GG_MARKER ?? "")'],
        { ...options, environment: { GG_MARKER: 'set' } },
      );

      expect(result.stdout).toBe('set');
    });

    test('can keep the parent environment out', async () => {
      const isolated = createNodeHost({
        workingDirectory: tmp,
        environment: { KEPT: 'yes' },
      });
      const result = await isolated.process.run(
        process.execPath,
        ['-e', 'process.stdout.write(String(process.env.KEPT))'],
        { ...options, includeParentEnvironment: false },
      );

      expect(result.stdout).toBe('undefined');
    });

    test('reports a missing executable as a failed run', async () => {
      // Throwing here would cross the Wasm boundary as an opaque error;
      // gg expects the shape of a command that ran and failed.
      const result = await host.process.run(
        'ggwsm-definitely-not-installed',
        [],
        options,
      );

      expect(result.exitCode).toBe(127);
      expect(result.stderr).not.toBe('');
    });

    test('runs through a shell when asked', async () => {
      // `echo` is a builtin of both sh and cmd.exe, so this is the one
      // place a bare shell word is portable.
      const result = await host.process.run('echo', ['hello-shell'], {
        ...options,
        runInShell: true,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('hello-shell');
    });

    test('takes the executable as a name, not as a command line', async () => {
      const result = await host.process.run('echo hello-shell', [], {
        ...options,
        runInShell: true,
      });

      if (process.platform === 'win32') {
        // `cmd.exe /c` re-parses its argument as a command line rather
        // than accepting it as one opaque word the way a POSIX shell's
        // single quotes do, so it runs `echo` with `hello-shell` as its
        // argument. `Process.run('echo hello-shell', [], runInShell:
        // true)` behaves the same way natively on Windows.
        expect(result.exitCode).toBe(0);
        expect(result.stdout.trim()).toBe('hello-shell');
      } else {
        // `dart:io` quotes the executable like any other word, so a shell
        // run is not a place to smuggle in a command line. Measured
        // against a native `Process.run('echo hello', [], runInShell:
        // true)`, which reports the same 127.
        expect(result.exitCode).toBe(127);
      }
    });

    test('keeps an argument with spaces and semicolons whole', async () => {
      // The regression this guards: Node's `shell: true` concatenates the
      // arguments unescaped, so a commit message arrived as three of them
      // and a `;` started a second command.
      const result = await host.process.run(
        process.execPath,
        [
          '-e',
          'console.log(JSON.stringify(process.argv.slice(1)))',
          'fix the bug',
          'a;b',
        ],
        { ...options, runInShell: true },
      );

      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual(['fix the bug', 'a;b']);
    });

    test('start(detached) returns without waiting', async () => {
      const marker = path.join(tmp, 'detached.txt');
      const started = await host.process.start(
        process.execPath,
        ['-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')`],
        { ...options, detached: true },
      );

      expect(started.pid).toBeGreaterThan(0);

      // A detached child is fire and forget: it reports no output and its
      // exit callback fires at once, because gg never waits for it.
      let exited = -1;
      started.onStdout(() => {});
      started.onStderr(() => {});
      started.onExit((code) => (exited = code));
      expect(exited).toBe(0);
      expect(() => started.writeStdin('ignored')).not.toThrow();
      expect(() => started.closeStdin()).not.toThrow();

      // »Fire and forget« still means the child runs, so wait for the
      // proof. Waiting is also what keeps the cleanup working: the child
      // has `tmp` as its working directory, and Windows keeps a directory
      // locked for as long as a process sits in it.
      await vi.waitFor(() => expect(fs.existsSync(marker)).toBe(true), {
        timeout: 30_000,
      });
    });
  });

  // ###########################################################################
  describe('started processes', () => {
    const options = {
      includeParentEnvironment: true,
      runInShell: false,
      detached: false,
    };

    /** Collects a started process' output and exit code. */
    function collect(started: StartedProcess): Promise<{
      out: string;
      err: string;
      chunks: number;
      code: number;
    }> {
      return new Promise((resolve) => {
        const decoder = new TextDecoder();
        let out = '';
        let err = '';
        let chunks = 0;
        started.onStdout((chunk) => {
          out += decoder.decode(chunk);
          chunks += 1;
        });
        started.onStderr((chunk) => {
          err += decoder.decode(chunk);
        });
        started.onExit((code) => resolve({ out, err, chunks, code }));
      });
    }

    test('streams stdout and stderr and reports the exit code', async () => {
      const started = await host.process.start(
        process.execPath,
        [
          '-e',
          'process.stdout.write("out"); process.stderr.write("err"); process.exit(3)',
        ],
        options,
      );

      const result = await collect(started);
      expect(result.out).toBe('out');
      expect(result.err).toBe('err');
      expect(result.code).toBe(3);
      expect(started.pid).toBeGreaterThan(0);
    });

    test('buffers output produced before a listener arrives', async () => {
      // The whole reason the handle buffers: a fast program can be done
      // before Dart attaches its listeners one microtask later, and gg
      // reading an empty run is exactly the bug this guards.
      const started = await host.process.start(
        process.execPath,
        ['-e', 'process.stdout.write("early")'],
        options,
      );

      await new Promise((r) => setTimeout(r, 200));

      const result = await collect(started);
      expect(result.out).toBe('early');
      expect(result.code).toBe(0);
    });

    test('buffers stderr produced before a listener arrives', async () => {
      const started = await host.process.start(
        process.execPath,
        ['-e', 'process.stderr.write("early-error")'],
        options,
      );

      await new Promise((r) => setTimeout(r, 200));

      expect((await collect(started)).err).toBe('early-error');
    });

    test('delivers output in more than one chunk', async () => {
      const started = await host.process.start(
        process.execPath,
        [
          '-e',
          "process.stdout.write('one\\n');" +
            "setTimeout(() => process.stdout.write('two\\n'), 200)",
        ],
        options,
      );

      const result = await collect(started);
      expect(result.chunks).toBeGreaterThan(1);
      expect(result.out).toBe('one\ntwo\n');
    });

    test('carries stdin into the program', async () => {
      const started = await host.process.start(
        process.execPath,
        ['-e', 'process.stdin.pipe(process.stdout)'],
        options,
      );
      const done = collect(started);

      started.writeStdin('through stdin');
      started.closeStdin();

      expect((await done).out).toBe('through stdin');
    });

    test('kills a running program', async () => {
      const started = await host.process.start(
        process.execPath,
        ['-e', 'setTimeout(() => {}, 30000)'],
        options,
      );
      const done = collect(started);

      expect(started.kill('SIGTERM')).toBe(true);
      expect((await done).code).not.toBe(0);
    });

    test('falls back to SIGTERM for an unknown signal', async () => {
      const started = await host.process.start(
        process.execPath,
        ['-e', 'setTimeout(() => {}, 30000)'],
        options,
      );
      const done = collect(started);

      expect(started.kill('ProcessSignal.sigwhatever')).toBe(true);
      await done;
    });

    test('reports a missing executable as a failed run', async () => {
      const started = await host.process.start(
        'ggwsm-definitely-not-installed',
        [],
        options,
      );

      expect((await collect(started)).code).toBe(127);
    });

    test('keeps the first exit code when close and error both fire', () => {
      // A real child normally reports one terminal event. Node makes no
      // promise about that, so the wrapper guards against a second one
      // overwriting the code gg already saw.
      const child = new EventEmitter();
      const started = new NodeStartedProcess(
        child as unknown as ChildProcess,
        false,
      );

      const codes: number[] = [];
      started.onExit((code) => codes.push(code));

      child.emit('close', 3, null);
      child.emit('error', new Error('after close'));

      expect(codes).toEqual([3]);
    });
  });

  // ###########################################################################
  describe('needsShell()', () => {
    test('honours what gg asked for', () => {
      expect(needsShell('git', true, 'linux')).toBe(true);
      expect(needsShell('git', true, 'win32')).toBe(true);
    });

    test('leaves a plain command alone', () => {
      expect(needsShell('git', false, 'linux')).toBe(false);
      expect(needsShell('git', false, 'win32')).toBe(false);
    });

    test('forces a shell for batch files on Windows', () => {
      // Node throws EINVAL for a .bat without a shell (CVE-2024-27980),
      // and gg calls pana.bat and flutter.bat without asking for one.
      expect(needsShell('pana.bat', false, 'win32')).toBe(true);
      expect(needsShell('C:\\tools\\flutter.CMD', false, 'win32')).toBe(true);
    });

    test('leaves batch files alone everywhere else', () => {
      expect(needsShell('pana.bat', false, 'linux')).toBe(false);
    });

    test('does not mistake something else for a batch file', () => {
      expect(needsShell('battery', false, 'win32')).toBe(false);
      expect(needsShell('a.bat.exe', false, 'win32')).toBe(false);
    });

    test('decides for this platform by default', () => {
      expect(needsShell('pana.bat', false)).toBe(process.platform === 'win32');
    });
  });

  // ###########################################################################
  describe('outcomeExitCode()', () => {
    test('passes a real status through', () => {
      expect(outcomeExitCode(0)).toBe(0);
      expect(outcomeExitCode(3)).toBe(3);
    });

    test('turns a killed child into a failure', () => {
      // No status means a signal ended it, and gg must not read that as a
      // silent success.
      expect(outcomeExitCode(null)).toBe(128);
    });
  });

  // ###########################################################################
  describe('resolveExecutable()', () => {
    // Real files, because the lookup is a `PATH` walk. The names are the
    // ones that actually bite on Windows: the Dart SDK and pnpm are
    // reached through wrappers there.
    let bin: string;
    let env: NodeJS.ProcessEnv;

    beforeEach(() => {
      bin = path.join(tmp, 'bin');
      fs.mkdirSync(bin, { recursive: true });
      env = { PATH: bin, PATHEXT: '.COM;.EXE;.BAT;.CMD' };
    });

    test('leaves everything alone off Windows', () => {
      fs.writeFileSync(path.join(bin, 'dart.BAT'), '');

      expect(resolveExecutable('dart', env, 'linux')).toBe('dart');
    });

    test('names the .bat a bare command resolves to', () => {
      fs.writeFileSync(path.join(bin, 'dart.BAT'), '');

      expect(resolveExecutable('dart', env, 'win32')).toBe(
        path.join(bin, 'dart.BAT'),
      );
    });

    test('names a .cmd wrapper too', () => {
      fs.writeFileSync(path.join(bin, 'pnpm.CMD'), '');

      expect(resolveExecutable('pnpm', env, 'win32')).toBe(
        path.join(bin, 'pnpm.CMD'),
      );
    });

    test('leaves an executable Node can find to Node', () => {
      // Node resolves .com and .exe by itself, so renaming those would
      // only make the command line longer.
      fs.writeFileSync(path.join(bin, 'git.EXE'), '');

      expect(resolveExecutable('git', env, 'win32')).toBe('git');
    });

    test('prefers the .exe when both are on the way', () => {
      // PATHEXT order decides, the way it does in a Windows shell.
      fs.writeFileSync(path.join(bin, 'dart.EXE'), '');
      fs.writeFileSync(path.join(bin, 'dart.BAT'), '');

      expect(resolveExecutable('dart', env, 'win32')).toBe('dart');
    });

    test('takes the first directory on PATH that has a hit', () => {
      const first = path.join(tmp, 'first');
      fs.mkdirSync(first, { recursive: true });
      fs.writeFileSync(path.join(bin, 'dart.BAT'), '');

      expect(
        resolveExecutable('dart', { ...env, PATH: `${first};${bin}` }, 'win32'),
      ).toBe(path.join(bin, 'dart.BAT'));
    });

    test('leaves a name that already carries an extension', () => {
      // `needsShell` handles those; a lookup would only second-guess gg.
      expect(resolveExecutable('pana.bat', env, 'win32')).toBe('pana.bat');
    });

    test('leaves a name that carries a directory', () => {
      expect(resolveExecutable('C:\\tools\\dart', env, 'win32')).toBe(
        'C:\\tools\\dart',
      );
      expect(resolveExecutable('tools/dart', env, 'win32')).toBe('tools/dart');
    });

    test('leaves a command it cannot find anywhere', () => {
      // Unchanged, so the spawn fails as the missing command it is rather
      // than as something this function invented.
      expect(resolveExecutable('ggwsm-nothing-here', env, 'win32')).toBe(
        'ggwsm-nothing-here',
      );
    });

    test('reads Path when that is how PATH is spelled', () => {
      fs.writeFileSync(path.join(bin, 'dart.BAT'), '');

      expect(
        resolveExecutable('dart', { Path: bin, PATHEXT: '.BAT' }, 'win32'),
      ).toBe(path.join(bin, 'dart.BAT'));
    });

    test('copes with no PATH and no PATHEXT at all', () => {
      expect(resolveExecutable('dart', {}, 'win32')).toBe('dart');

      // Without PATHEXT the built-in list still finds the wrapper.
      fs.writeFileSync(path.join(bin, 'dart.BAT'), '');
      expect(resolveExecutable('dart', { PATH: bin }, 'win32')).toBe(
        path.join(bin, 'dart.BAT'),
      );
    });

    test('resolves for this platform by default', () => {
      expect(resolveExecutable('ggwsm-nothing-here')).toBe(
        'ggwsm-nothing-here',
      );
    });
  });

  // ###########################################################################
  describe('spawnCommand()', () => {
    test('spawns directly when no shell is involved', () => {
      expect(spawnCommand('git', ['status'], false, 'linux')).toEqual({
        executable: 'git',
        args: ['status'],
      });
    });

    test('quotes every word for a POSIX shell', () => {
      // Node's own `shell: true` would join these with spaces, which turns
      // one commit message into three arguments and lets `;` start a
      // second command. `dart:io` single-quotes instead, and so do we.
      expect(
        spawnCommand('git', ['commit', '-m', 'fix the bug; ok'], true, 'linux'),
      ).toEqual({
        executable: '/bin/sh',
        args: ["-c", "'git' 'commit' '-m' 'fix the bug; ok'"],
      });
    });

    test('leaves and re-enters the quoting for an embedded quote', () => {
      // A single-quoted shell string has no escape character, so a `'` has
      // to be spelled out between quoted runs.
      expect(spawnCommand('echo', ["it's"], true, 'linux').args[1]).toBe(
        `'echo' 'it'"'"'s'`,
      );
    });

    test('uses the Android shell there', () => {
      expect(spawnCommand('sh', [], true, 'android').executable).toBe(
        '/system/bin/sh',
      );
    });

    test('hands Windows an argument vector after cmd /c', () => {
      // Windows gets the arguments unquoted on purpose: Node escapes them
      // on the way into the command line, the same way `dart:io` does.
      expect(
        spawnCommand('git', ['commit', '-m', 'a b'], true, 'win32'),
      ).toEqual({
        executable: 'cmd.exe',
        args: ['/c', 'git', 'commit', '-m', 'a b'],
      });
    });

    test('runs a batch file through cmd without being asked', () => {
      expect(spawnCommand('pana.bat', ['.'], false, 'win32')).toEqual({
        executable: 'cmd.exe',
        args: ['/c', 'pana.bat', '.'],
      });
    });

    test('builds for this platform by default', () => {
      expect(spawnCommand('git', ['status'], false).executable).toBe('git');
    });
  });

  // ###########################################################################
  describe('platform', () => {
    test('reports the environment as entries', () => {
      const scoped = createNodeHost({
        workingDirectory: tmp,
        environment: { A: '1', B: '2' },
      });

      expect(scoped.platform.environmentEntries().sort()).toEqual([
        ['A', '1'],
        ['B', '2'],
      ]);
    });

    test('reports the operating system the way Dart spells it', () => {
      expect(host.platform.operatingSystem()).toBe(
        nodePlatformToDart(process.platform),
      );
      expect(nodePlatformToDart('darwin')).toBe('macos');
      expect(nodePlatformToDart('win32')).toBe('windows');
      expect(nodePlatformToDart('linux')).toBe('linux');
    });

    test('reports the path separator', () => {
      expect(host.platform.pathSeparator()).toBe(path.sep);
    });

    test('remembers the exit code gg asks for', () => {
      expect(host.platform.exitCode()).toBe(0);
      host.platform.setExitCode(42);
      expect(host.platform.exitCode()).toBe(42);
    });
  });

  // ###########################################################################
  describe('console', () => {
    test('routes output to the sinks it was given', () => {
      const out: string[] = [];
      const err: string[] = [];
      const captured = createNodeHost({
        workingDirectory: tmp,
        onStdout: (t) => out.push(t),
        onStderr: (t) => err.push(t),
      });

      captured.console.writeStdout('to-stdout');
      captured.console.writeStderr('to-stderr');

      expect(out).toEqual(['to-stdout']);
      expect(err).toEqual(['to-stderr']);
    });

    test('writes to the real streams by default', () => {
      expect(() => host.console.writeStdout('')).not.toThrow();
      expect(() => host.console.writeStderr('')).not.toThrow();
    });

    test('answers the terminal questions', () => {
      expect(typeof host.console.hasTerminal()).toBe('boolean');
      expect(typeof host.console.supportsAnsiEscapes()).toBe('boolean');
      expect(host.console.terminalColumns()).toBeGreaterThan(0);
    });

    test('reads one line at a time and stops at end of input', () => {
      // Against a real descriptor rather than the runner's own stdin,
      // which in a worker is a pipe that never closes.
      const file = path.join(tmp, 'input.txt');
      fs.writeFileSync(file, 'first\r\nsecond\nno-newline');
      const fd = fs.openSync(file, 'r');
      try {
        expect(readLineFrom(fd)).toBe('first');
        expect(readLineFrom(fd)).toBe('second');
        // A last line without a trailing newline still counts …
        expect(readLineFrom(fd)).toBe('no-newline');
        // … and after it there is nothing left to answer with.
        expect(readLineFrom(fd)).toBeNull();
      } finally {
        fs.closeSync(fd);
      }
    });

    test('reports end of input on a closed descriptor', () => {
      const file = path.join(tmp, 'closed.txt');
      fs.writeFileSync(file, 'x');
      const fd = fs.openSync(file, 'r');
      fs.closeSync(fd);

      // Reading a closed descriptor throws EBADF, which is »no more
      // input« as far as gg is concerned.
      expect(readLineFrom(fd)).toBeNull();
    });

    test('reads gg answers from the descriptor it was given', () => {
      const file = path.join(tmp, 'answers.txt');
      fs.writeFileSync(file, 'yes\n');
      const fd = fs.openSync(file, 'r');
      try {
        const scripted = createNodeHost({ workingDirectory: tmp, stdinFd: fd });
        expect(scripted.console.readLine()).toBe('yes');
        expect(scripted.console.readLine()).toBeNull();
      } finally {
        fs.closeSync(fd);
      }
    });

    test('ships prompts a Node terminal can answer', () => {
      // Covered in detail by prompts-node.test.ts; here only that the
      // host carries them at all.
      expect(host.prompts).toBeDefined();
    });
  });
});
