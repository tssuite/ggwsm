// @license
// Copyright (c) 2026 ggsuite
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { Readable } from 'node:stream';
import { describe, expect, test } from 'vitest';

import { createNodeHost } from '../host-node.js';
import {
  askOnTerminal,
  chooseByArrows,
  createNodePrompts,
  uncolored,
  UnansweredPromptError,
} from '../prompts-node.js';

/**
 * A stream that claims to be a terminal, so the raw-mode paths run.
 *
 * The real ones cannot be used in a test: taking the process' own stdin
 * into raw mode would swallow the test runner's keys.
 */
class FakeTty extends Readable {
  /** What `isTerminal` looks for. */
  isTTY = true;
  /** Whether raw mode is on, so a test can check it was restored. */
  isRaw = false;
  /** How often raw mode was switched, so a leak would show. */
  rawModeCalls: boolean[] = [];

  /**
   * Records the raw mode the caller asked for.
   * @param mode - Whether to turn raw mode on.
   * @returns This stream, the way `setRawMode` does.
   */
  setRawMode(mode: boolean): this {
    this.isRaw = mode;
    this.rawModeCalls.push(mode);
    return this;
  }

  /** Nothing to pull — the test pushes keys in. */
  override _read(): void {}

  /**
   * Feeds one key sequence in, once the reader is listening.
   * @param keys - The bytes a terminal would send.
   */
  press(keys: string): void {
    setImmediate(() => this.push(keys));
  }
}

/**
 * Builds prompts that read from a scripted list of answers.
 * @param answers - What the user "types", in order. Runs out into `null`.
 * @returns The prompts and everything they wrote.
 */
function scripted(answers: string[]): {
  prompts: ReturnType<typeof createNodePrompts>;
  written: string[];
  asked: string[];
} {
  const written: string[] = [];
  const asked: string[] = [];
  const prompts = createNodePrompts({
    // Not a terminal, so the numbered list and the bracketed suggestion
    // are what these exercise.
    input: Readable.from([]),
    write: (text) => written.push(text),
    ask: async (prompt) => {
      asked.push(prompt);
      return answers.shift() ?? null;
    },
  });
  return { prompts, written, asked };
}

describe('createNodePrompts()', () => {
  // ###########################################################################
  describe('select, without a terminal', () => {
    test('returns the index the user picked', async () => {
      const { prompts, written } = scripted(['2']);

      const index = await prompts.select(
        'Pick one',
        ['alpha', 'beta', 'gamma'],
        0,
      );

      expect(index).toBe(1);
      expect(written.join('')).toContain('Pick one');
      expect(written.join('')).toContain('2) beta');
    });

    test('marks the initial choice and takes it on an empty answer', async () => {
      const { prompts, written, asked } = scripted(['']);

      const index = await prompts.select('Pick', ['no', 'yes'], 1);

      expect(index).toBe(1);
      // The marker tells the user what return will give them.
      expect(written.join('')).toContain('> 2) yes');
      expect(asked.join('')).toContain('[2]');
    });

    test('asks again after an answer that is not a choice', async () => {
      const { prompts, written } = scripted(['nope', '17', '1']);

      expect(await prompts.select('Pick', ['a', 'b'], 0)).toBe(0);
      expect(written.join('')).toContain('between 1 and 2');
    });

    test('falls back to the first choice for an out-of-range initial', async () => {
      const { prompts } = scripted(['']);
      expect(await prompts.select('Pick', ['a', 'b'], 99)).toBe(0);
    });

    test('refuses to guess when stdin ends', async () => {
      const { prompts } = scripted([]);

      // Picking a default here would decide what gets published.
      await expect(prompts.select('Pick', ['a', 'b'], 0)).rejects.toThrow(
        UnansweredPromptError,
      );
    });
  });

  // ###########################################################################
  describe('select, on a terminal', () => {
    test('walks the list with the arrow keys', async () => {
      const tty = new FakeTty();
      const written: string[] = [];

      const picked = chooseByArrows(
        tty,
        (text) => written.push(text),
        'Select version increment:',
        ['Patch', 'Minor', 'Major'],
        0,
      );
      tty.press('\x1b[B\x1b[B\r');

      expect(await picked).toBe(2);
      // The marker followed the keys rather than the digits being typed.
      expect(written.join('')).toContain('❯\x1b[0m \x1b[34mMajor');
    });

    test('draws in gg\'s colours: question yellow, marked blue, rest white', async () => {
      const tty = new FakeTty();
      const written: string[] = [];

      // gg may send colours of its own; the theme replaces them, the way
      // native gg's prompt theme does, and keeps bold.
      const picked = chooseByArrows(
        tty,
        (text) => written.push(text),
        '\x1b[36mWhat should happen?\x1b[0m',
        ['\x1b[33mMove\x1b[0m', 'Remove with \x1b[1m»gg do rm«\x1b[22m'],
        0,
      );
      tty.press('\r');
      await picked;

      const drawn = written.join('');
      expect(drawn).toContain('\x1b[33mWhat should happen?\x1b[0m\n');
      expect(drawn).toContain('\x1b[90m❯\x1b[0m \x1b[34mMove\x1b[0m\n');
      expect(drawn).toContain(
        '  \x1b[37mRemove with \x1b[1m»gg do rm«\x1b[22m\x1b[0m\n',
      );
      expect(drawn).not.toContain('\x1b[36m');
    });

    test('goes back up again', async () => {
      const tty = new FakeTty();

      const picked = chooseByArrows(tty, () => {}, 'Pick', ['a', 'b', 'c'], 2);
      tty.press('\x1b[A\r');

      expect(await picked).toBe(1);
    });

    test('takes k and j as well', async () => {
      const tty = new FakeTty();

      const picked = chooseByArrows(tty, () => {}, 'Pick', ['a', 'b', 'c'], 0);
      tty.press('jjk\r');

      expect(await picked).toBe(1);
    });

    test('wraps around at both ends', async () => {
      const tty = new FakeTty();

      // Up from the first entry is the last one — the long walk back is
      // what the wrap saves.
      const picked = chooseByArrows(tty, () => {}, 'Pick', ['a', 'b', 'c'], 0);
      tty.press('\x1b[A\x1b[B\x1b[B\r');

      expect(await picked).toBe(1);
    });

    test('still takes the number of an entry', async () => {
      const tty = new FakeTty();

      const picked = chooseByArrows(tty, () => {}, 'Pick', ['a', 'b', 'c'], 0);
      tty.press('3\r');

      expect(await picked).toBe(2);
    });

    test('ignores a number that is not an entry', async () => {
      const tty = new FakeTty();

      const picked = chooseByArrows(tty, () => {}, 'Pick', ['a', 'b'], 0);
      tty.press('9x\r');

      expect(await picked).toBe(0);
    });

    test('starts at the first entry for an out-of-range initial', async () => {
      const tty = new FakeTty();

      const picked = chooseByArrows(tty, () => {}, 'Pick', ['a', 'b'], 99);
      tty.press('\r');

      expect(await picked).toBe(0);
    });

    test('gives up on ctrl-c rather than picking for the user', async () => {
      const tty = new FakeTty();

      // Raw mode swallows the interrupt, so it has to be read as a key.
      const picked = chooseByArrows(tty, () => {}, 'Pick', ['a', 'b'], 0);
      tty.press('\x03');

      expect(await picked).toBeNull();
    });

    test('does not mistake a plain c for the interrupt', async () => {
      const tty = new FakeTty();

      const picked = chooseByArrows(tty, () => {}, 'Pick', ['a', 'b'], 1);
      tty.press('c\r');

      expect(await picked).toBe(1);
    });

    test('ignores a key it has no name for', async () => {
      const tty = new FakeTty();

      // An umlaut arrives as bytes readline does not name, and must not
      // be read as a digit or a command.
      const picked = chooseByArrows(tty, () => {}, 'Pick', ['a', 'b'], 0);
      tty.press('ü\r');

      expect(await picked).toBe(0);
    });

    test('gives up when the terminal goes away', async () => {
      const tty = new FakeTty();

      const picked = chooseByArrows(tty, () => {}, 'Pick', ['a', 'b'], 0);
      setImmediate(() => tty.emit('end'));

      expect(await picked).toBeNull();
    });

    test('leaves the terminal as it found it', async () => {
      const tty = new FakeTty();
      const written: string[] = [];

      const picked = chooseByArrows(
        tty,
        (text) => written.push(text),
        'Pick',
        ['a', 'b'],
        0,
      );
      tty.press('\r');
      await picked;

      // A prompt that left raw mode on would eat every key the user types
      // afterwards, and a hidden cursor would stay hidden.
      expect(tty.isRaw).toBe(false);
      expect(tty.rawModeCalls).toEqual([true, false]);
      expect(written.join('')).toContain('\x1b[?25h');
    });

    test('leaves raw mode alone when it was already on', async () => {
      const tty = new FakeTty();
      tty.setRawMode(true);
      tty.rawModeCalls = [];

      const picked = chooseByArrows(tty, () => {}, 'Pick', ['a', 'b'], 0);
      tty.press('\r');
      await picked;

      expect(tty.isRaw).toBe(true);
      expect(tty.rawModeCalls).toEqual([true]);
    });

    test('redraws over the list instead of below it', async () => {
      const tty = new FakeTty();
      const written: string[] = [];

      const picked = chooseByArrows(
        tty,
        (text) => written.push(text),
        'Pick',
        ['a', 'b', 'c'],
        0,
      );
      tty.press('\x1b[B\r');
      await picked;

      // One line for the prompt plus one per entry.
      expect(written.join('')).toContain('\x1b[4A');
    });

    test('redraws a question of several lines in full', async () => {
      const tty = new FakeTty();
      const written: string[] = [];

      const picked = chooseByArrows(
        tty,
        (text) => written.push(text),
        '\nPick',
        ['a', 'b', 'c'],
        0,
      );
      tty.press('\x1b[B\r');
      await picked;

      // The blank line, the question and the three entries.
      expect(written.join('')).toContain('\x1b[5A');
    });

    test('is what the prompts use when stdin is a terminal', async () => {
      const tty = new FakeTty();
      const prompts = createNodePrompts({ input: tty, write: () => {} });

      const picked = prompts.select('Pick', ['a', 'b'], 0);
      tty.press('\x1b[B\r');

      expect(await picked).toBe(1);
    });
  });

  // ###########################################################################
  describe('input, without a terminal', () => {
    test('returns what the user typed', async () => {
      const { prompts, asked } = scripted(['my message']);

      expect(await prompts.input('Message', '', '', false)).toBe('my message');
      // readline owns the prompt — it needs the prompt's width to place
      // the cursor, so the caller must not write it separately.
      expect(asked).toEqual(['Message: ']);
    });

    test('keeps the suggested text on an empty answer', async () => {
      const { prompts, asked } = scripted(['']);

      expect(await prompts.input('Message', '', 'suggested', false)).toBe(
        'suggested',
      );
      expect(asked.join('')).toContain('[suggested]');
    });

    test('falls back to the default value when there is no initial text', async () => {
      const { prompts } = scripted(['']);
      expect(await prompts.input('Message', 'fallback', '', false)).toBe(
        'fallback',
      );
    });

    test('prefers the initial text over the default value', async () => {
      const { prompts } = scripted(['']);
      expect(await prompts.input('Message', 'default', 'initial', false)).toBe(
        'initial',
      );
    });

    test('refuses to guess when stdin ends', async () => {
      const { prompts } = scripted([]);
      await expect(prompts.input('Message', 'x', '', false)).rejects.toThrow(
        /stdin ended/,
      );
    });
  });

  // ###########################################################################
  describe('input, on a terminal', () => {
    test('starts the buffer with what gg proposed', async () => {
      const tty = new FakeTty();
      const asked: [string, string][] = [];
      const prompts = createNodePrompts({
        input: tty,
        write: () => {},
        ask: async (prompt, initialText) => {
          asked.push([prompt, initialText]);
          return 'Provide gg via npm, edited';
        },
      });

      expect(await prompts.input('Edit merge message:', '', 'seed', true)).toBe(
        'Provide gg via npm, edited',
      );
      // Not a bracketed hint: the proposal is in the buffer, ready to be
      // changed, the way interact's editor has it.
      expect(asked).toEqual([['\x1b[33mEdit merge message:\x1b[0m ', 'seed']]);
    });

    test('means »none« when the user clears the buffer', async () => {
      const tty = new FakeTty();
      const prompts = createNodePrompts({
        input: tty,
        write: () => {},
        ask: async () => '',
      });

      // interact reads an emptied buffer as the default value, and gg
      // passes none for the merge message — so an emptied editor is an
      // empty message rather than the proposal sneaking back in.
      expect(await prompts.input('Edit merge message:', '', 'seed', true)).toBe(
        '',
      );
    });

    test('seeds readline with the initial text', async () => {
      const tty = new FakeTty();
      const written: string[] = [];

      const answer = askOnTerminal(
        tty,
        (text) => written.push(text),
        'Edit merge message: ',
        'Provide gg via npm',
      );
      tty.press('!\r');

      // The seed is editable, so a keystroke lands after it rather than
      // replacing it.
      expect(await answer).toBe('Provide gg via npm!');
    });
  });

  // ###########################################################################
  describe('defaults', () => {
    test('reads a line off the input stream', async () => {
      // No `ask`: the answer comes through readline, which is the path a
      // user at a terminal takes.
      const written: string[] = [];
      const prompts = createNodePrompts({
        write: (text) => written.push(text),
        input: Readable.from(['2\n']),
      });

      expect(await prompts.select('Pick', ['a', 'b'], 0)).toBe(1);
      expect(written.join('')).toContain('Pick');
    });

    test('writes the question to stdout when no sink is given', async () => {
      const prompts = createNodePrompts({ input: Readable.from(['hi\n']) });
      expect(await prompts.input('Message', '', '', false)).toBe('hi');
    });

    test('reports end of input when the stream fails', async () => {
      // A broken stdin must end the question rather than leave gg waiting
      // on an answer that can no longer arrive.
      const broken = new Readable({
        read(): void {
          this.destroy(new Error('stdin is gone'));
        },
      });

      expect(await askOnTerminal(broken, () => {}, 'Q: ')).toBeNull();
    });

    test('reports end of input on an empty stream', async () => {
      const prompts = createNodePrompts({
        write: () => {},
        input: Readable.from([]),
      });

      await expect(prompts.input('Message', '', '', false)).rejects.toThrow(
        UnansweredPromptError,
      );
    });
  });

  // ###########################################################################
  describe('as part of the Node host', () => {
    test('is supplied by default', async () => {
      expect(createNodeHost().prompts).toBeDefined();
    });

    test('can be switched off', async () => {
      // Then gg refuses its interactive commands with an actionable
      // message instead of asking a question nobody is there to answer.
      expect(createNodeHost({ prompts: false }).prompts).toBeUndefined();
    });

    test('can be replaced', async () => {
      const { prompts } = scripted(['1']);
      expect(createNodeHost({ prompts }).prompts).toBe(prompts);
    });

    test('reads its answers from the stream the host was given', async () => {
      const written: string[] = [];
      const host = createNodeHost({
        stdin: Readable.from(['from the host\n']),
        onStdout: (text) => written.push(text),
      });

      expect(await host.prompts!.input('Message', '', '', false)).toBe(
        'from the host',
      );
      // The question goes through the host console, so an embedder that
      // captures gg's output captures the prompt with it.
      expect(written.join('')).toContain('Message');
    });
  });
});

// #############################################################################
describe('uncolored()', () => {
  test('removes foreground and background colours', () => {
    expect(uncolored('\x1b[33ma\x1b[39m \x1b[41;97mb\x1b[49;39m')).toBe('a b');
  });

  test('removes 256 and true colours with their parameters', () => {
    expect(uncolored('\x1b[38;5;208ma\x1b[48;2;1;2;3;1mb')).toBe(
      'a\x1b[1mb',
    );
    expect(uncolored('\x1b[38:5:208ma')).toBe('a');
  });

  test('keeps bold, italic and underline', () => {
    expect(uncolored('\x1b[1;34mcmd\x1b[22m')).toBe('\x1b[1mcmd\x1b[22m');
    expect(uncolored('\x1b[3mi\x1b[23m \x1b[4mu\x1b[24m')).toBe(
      '\x1b[3mi\x1b[23m \x1b[4mu\x1b[24m',
    );
  });

  test('turns a reset into ending only what was switched on', () => {
    // A plain reset would end the theme's colour, too.
    expect(uncolored('\x1b[1;32mok\x1b[0m rest')).toBe(
      '\x1b[1mok\x1b[22m rest',
    );
    expect(uncolored('\x1b[32mok\x1b[m rest')).toBe('ok rest');
  });

  test('forgets an attribute once it was ended', () => {
    expect(uncolored('\x1b[4mu\x1b[24m\x1b[0m')).toBe('\x1b[4mu\x1b[24m');
  });

  test('removes bright colours and keeps codes it does not know', () => {
    expect(uncolored('\x1b[93;103ma\x1b[53mb')).toBe('a\x1b[53mb');
  });

  test('keeps an extended colour it cannot read the length of', () => {
    // Neither 5 nor 2: only the 38 goes, what follows is left as it is.
    expect(uncolored('\x1b[38;9ma')).toBe('\x1b[9ma');
  });

  test('ends only the attribute that was ended', () => {
    // Underline ended, bold still on — the reset ends bold alone.
    expect(uncolored('\x1b[1;4ma\x1b[24mb\x1b[0m')).toBe(
      '\x1b[1;4ma\x1b[24mb\x1b[22m',
    );
  });

  test('leaves text without escape sequences alone', () => {
    expect(uncolored('plain')).toBe('plain');
  });
});
