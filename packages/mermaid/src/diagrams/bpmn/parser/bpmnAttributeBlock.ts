/**
 * Reads the text of an element's `@{ key: value, ... }` block the way YAML reads a flow mapping,
 * far enough to know where the block ends and where its keys are written. What js-yaml follows
 * in a flow mapping is followed here by the same rules: plain and quoted scalars, lists,
 * mappings, tags, anchors, aliases and `?` keys. A `#` comment is not followed: on one line it
 * would hide the block's `}` from YAML, so a block that holds one cannot be read at all. Text
 * that js-yaml cannot read is not refused here: the reading goes on to the next `}` that can
 * close the block, and it is the parser that refuses what YAML cannot read.
 *
 * The lexer and the parser both use this one reading. The lexer takes the block's extent from
 * it, and the parser takes the place of each key, so the two cannot come to disagree about
 * where a quoted value ends or which `}` closes the block. The text is read in one pass, from
 * left to right, so the reading takes time in proportion to its length.
 */

/** A key at the top of a block. */
export interface BlockKey {
  /**
   * The key as it is written, from the start of its entry to its `:`, or to the end of the
   * entry when no `:` follows. A `?`, a tag or an anchor in front of the key is part of it.
   */
  text: string;
  /** Whether a `:` follows the key. */
  colon: boolean;
  /** Where the key itself starts, after any `?`, tag or anchor, counted from the `@`. */
  offset: number;
}

export interface ScannedBlock {
  /** Where the block ends, counted from the start of the text: after its `}`, or where the reading stopped. */
  end: number;
  /** Whether a `}` closed the block. */
  closed: boolean;
  /**
   * Where the quoted text opens that the reading stopped in, because its line does not close
   * it. Counted from the start of the text.
   */
  openQuote?: number;
  keys: BlockKey[];
}

const isLineBreak = (char: string): boolean => char === '\n' || char === '\r';
const isSpace = (char: string): boolean => char === ' ' || char === '\t';
const isFlowIndicator = (char: string): boolean =>
  char === ',' || char === '[' || char === ']' || char === '{' || char === '}';

const isQuote = (char: string): boolean => char === '"' || char === "'";
const isWordChar = (char: string | undefined): boolean => char !== undefined && /\w/.test(char);

/** A single quote straight after a letter or a digit, as in `it's`. */
const isApostrophe = (text: string, index: number): boolean =>
  text[index] === "'" && isWordChar(text[index - 1]);

/** Whether a blank, a line break or the end of the text stands at `index`. */
const endsWord = (text: string, index: number): boolean =>
  index >= text.length || isSpace(text[index]) || isLineBreak(text[index]);

/** Whether the `:` at `index` separates a key from its value, rather than being part of a name. */
const separates = (text: string, index: number): boolean =>
  endsWord(text, index + 1) || isFlowIndicator(text[index + 1]);

/** Whether a quote, a comment or a block starts at `index`: what ends a word on a later line. */
const startsOwnText = (text: string, index: number): boolean =>
  (isQuote(text[index]) && !isApostrophe(text, index)) ||
  text.startsWith('%%', index) ||
  text.startsWith('@{', index);

/**
 * Where the quoted text that opens at `start` ends, just after its closing quote, as YAML reads
 * it: a backslash escapes the next character in double quotes only, and a single quote is
 * written twice inside single quotes. `closed` is false when the line ends first.
 */
function quotedEnd(text: string, start: number): { end: number; closed: boolean } {
  const quote = text[start];
  let index = start + 1;
  while (index < text.length && !isLineBreak(text[index])) {
    if (quote === '"' && text[index] === '\\' && index + 1 < text.length) {
      index += isLineBreak(text[index + 1]) ? 1 : 2;
    } else if (text[index] !== quote) {
      index++;
    } else if (quote === "'" && text[index + 1] === "'") {
      index += 2;
    } else {
      return { end: index + 1, closed: true };
    }
  }
  return { end: index, closed: false };
}

/**
 * Where the name that starts at `index` ends: the name of an anchor or an alias, or a tag. It
 * ends at a blank, at the end of its line, at a flow indicator and, on a line after the first,
 * where a quote, a comment or a block starts.
 */
function nameEnd(text: string, index: number, firstLine: boolean): number {
  let end = index;
  while (
    !endsWord(text, end) &&
    !isFlowIndicator(text[end]) &&
    (firstLine || !startsOwnText(text, end))
  ) {
    end++;
  }
  return end;
}

/**
 * Where the tag that starts with the `!` at `index` ends. A tag written in full,
 * `!<tag:yaml.org,2002:str>`, ends after its `>` and may hold a flow indicator. A tag written
 * any other way ends as a name does.
 */
function tagEnd(text: string, index: number, firstLine: boolean): number {
  if (text[index + 1] !== '<') {
    return nameEnd(text, index + 1, firstLine);
  }
  let end = index + 2;
  while (!endsWord(text, end) && (firstLine || !startsOwnText(text, end))) {
    if (text[end++] === '>') {
      break;
    }
  }
  return end;
}

/**
 * Reads the block that opens with `@{` at `start`.
 *
 * A quote opens quoted text only where a key or a value starts, so the apostrophe in
 * `state: it's` is a plain character. A `}` closes the innermost `{` that is open, and the block
 * when none is. The reading stops at the end of the line; with `acrossLines` it goes on over
 * the lines that follow, until one of them opens a block or a comment of its own.
 */
export function scanAttributeBlock(text: string, start: number, acrossLines = false): ScannedBlock {
  const keys: BlockKey[] = [];
  // The lists and the mappings that are open inside the block, the innermost last.
  const open: string[] = [];
  // Whether a key or a value may start here: nothing stands between the last indicator and
  // this place but blanks, a `?`, tags and anchors.
  let nodeStart = true;
  // Whether an entry starts here, of the block or of a list or a mapping in it.
  let entryStart = true;
  // Whether quoted text, a list, a mapping or an alias has just been read. A `:` after one of
  // them separates, whatever follows it.
  let afterNode = false;
  // The entry at the top of the block that is being read: where it starts, where its key
  // starts, and whether the `:` after its key has been read.
  let entry: { start?: number; key?: number; colon: boolean } = { colon: false };
  let firstLine = true;
  let index = start + 2;

  const stopped = (openQuote?: number): ScannedBlock => ({
    end: index,
    closed: false,
    openQuote,
    keys,
  });
  /** The key of the entry at the top of the block starts at `index`, unless it has started. */
  const startKey = (): void => {
    if (open.length === 0 && !entry.colon) {
      entry.key ??= index;
    }
  };
  /** Ends the entry at the top of the block at `index`. One with no `:` is a key with no value. */
  const endEntry = (): void => {
    if (!entry.colon && entry.start !== undefined) {
      keys.push({
        text: text.slice(entry.start, index),
        colon: false,
        offset: (entry.key ?? entry.start) - start,
      });
    }
    entry = { colon: false };
  };

  while (index < text.length) {
    const char = text[index];
    if (isLineBreak(char)) {
      if (!acrossLines) {
        return stopped();
      }
      firstLine = false;
      index++;
      continue;
    }
    if (isSpace(char)) {
      index++;
      continue;
    }
    if (!firstLine && (text.startsWith('%%', index) || text.startsWith('@{', index))) {
      return stopped();
    }
    const wasAfterNode = afterNode;
    afterNode = false;
    const wasEntryStart = entryStart;
    entryStart = false;
    const atTop = open.length === 0;
    if (atTop && char !== ',' && char !== '}') {
      entry.start ??= index;
    }

    // On a line after the first, which may be a statement of its own, a quote opens quoted
    // text wherever it stands, as it does in a label; the apostrophe in `it's` does not.
    if (isQuote(char) && (nodeStart || (!firstLine && !isApostrophe(text, index)))) {
      const quoted = quotedEnd(text, index);
      if (!quoted.closed && !acrossLines) {
        const openQuote = index;
        index = quoted.end;
        return stopped(openQuote);
      }
      startKey();
      index = quoted.end;
      nodeStart = false;
      afterNode = true;
    } else if (char === '[' || char === '{') {
      startKey();
      open.push(char);
      nodeStart = true;
      entryStart = true;
      index++;
    } else if (char === ']') {
      if (open[open.length - 1] === '[') {
        open.pop();
      }
      nodeStart = false;
      afterNode = true;
      index++;
    } else if (char === '}') {
      const mapping = open.lastIndexOf('{');
      if (mapping < 0) {
        endEntry();
        return { end: index + 1, closed: true, keys };
      }
      open.length = mapping;
      nodeStart = false;
      afterNode = true;
      index++;
    } else if (char === ',') {
      if (atTop) {
        endEntry();
      }
      nodeStart = true;
      entryStart = true;
      index++;
    } else if (char === ':' && (wasAfterNode || separates(text, index))) {
      if (atTop && !entry.colon) {
        const from = entry.start ?? index;
        keys.push({
          text: text.slice(from, index),
          colon: true,
          offset: (entry.key ?? from) - start,
        });
        entry.colon = true;
      }
      nodeStart = true;
      index++;
    } else if (wasEntryStart && char === '?' && endsWord(text, index + 1)) {
      // `? key : value`, the long way to write a key, in the block or in a mapping inside it.
      index++;
    } else if (nodeStart && char === '!') {
      // A tag (`!!str`) stands in front of a key or a value, which may start straight after it.
      index = tagEnd(text, index, firstLine);
    } else if (nodeStart && char === '&') {
      // So does an anchor (`&name`).
      index = nameEnd(text, index + 1, firstLine);
    } else if (nodeStart && char === '*') {
      // An alias (`*name`) stands for a key or a value written before it.
      startKey();
      index = nameEnd(text, index + 1, firstLine);
      // A `:` straight after the name is part of it: to YAML `*a: x` is the alias `a:` and
      // then a text it cannot read. What follows such a `:` is still read as a value is, so
      // that the block ends where its author ended it and is refused whole, for the alias.
      nodeStart = text[index - 1] === ':';
      afterNode = true;
    } else {
      // Plain text runs to the next indicator, or to a `:` that separates.
      startKey();
      let end = index + 1;
      while (
        end < text.length &&
        !isLineBreak(text[end]) &&
        !isFlowIndicator(text[end]) &&
        !(text[end] === ':' && separates(text, end)) &&
        (firstLine || !startsOwnText(text, end))
      ) {
        end++;
      }
      index = end;
      nodeStart = false;
    }
  }
  return stopped();
}
