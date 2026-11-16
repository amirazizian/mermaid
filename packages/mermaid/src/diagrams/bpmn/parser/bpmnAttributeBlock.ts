/**
 * Reads the text of an element's `@{ key: value, ... }` block the way YAML reads a flow mapping,
 * far enough to know where the block ends and where its keys are written. Scalars, quoted
 * text, lists, mappings, tags and anchors are followed; an alias or a list written as a key is
 * not, which at worst places an error at the start of the block.
 *
 * The lexer and the parser both use this one reading. The lexer takes the block's extent from
 * it, and the parser takes the place of each key, so the two cannot come to disagree about
 * where a quoted value ends or which `}` closes the block. Every character is read once.
 */

/** A key at the top of a block: its text as written, and where it starts, counted from the `@`. */
export interface BlockKey {
  text: string;
  offset: number;
}

export interface ScannedBlock {
  /** Where the block ends, counted from the start of the text: after its `}`, or where the reading stopped. */
  end: number;
  /** Whether a `}` closed the block. */
  closed: boolean;
  /** Whether the reading stopped inside quoted text that its line does not close. */
  openQuote: boolean;
  keys: BlockKey[];
}

const isLineBreak = (char: string): boolean => char === '\n' || char === '\r';
const isSpace = (char: string): boolean => char === ' ' || char === '\t';
const isFlowIndicator = (char: string): boolean =>
  char === ',' || char === '[' || char === ']' || char === '{' || char === '}';

const isQuote = (char: string): boolean => char === '"' || char === "'";
const isWordChar = (char: string | undefined): boolean => char !== undefined && /\w/.test(char);
/** Whether the word that starts at `index` (a tag or an anchor) ends in a space on its line. */
const endsWithSpace = (text: string, index: number): boolean => {
  let end = index;
  while (end < text.length && !isSpace(text[end]) && !isLineBreak(text[end])) {
    if (isFlowIndicator(text[end])) {
      return false;
    }
    end++;
  }
  return end < text.length && isSpace(text[end]);
};

/** A single quote straight after a letter or a digit, as in `it's`. */
const isApostrophe = (text: string, index: number): boolean =>
  text[index] === "'" && isWordChar(text[index - 1]);

/** Whether the `:` at `index` separates a key from its value, rather than being part of a name. */
const separates = (text: string, index: number): boolean => {
  const next = text[index + 1];
  return next === undefined || isSpace(next) || isLineBreak(next) || isFlowIndicator(next);
};

/** Whether a quote, a comment or a block starts at `index`: what ends plain text on a later line. */
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
 * Reads the block that opens with `@{` at `start`.
 *
 * A quote opens quoted text only where a key or a value starts, so the apostrophe in
 * `state: it's` is a plain character. A `}` closes the innermost `{` that is open, and the block
 * when none is. The reading stops at the end of the line; with `acrossLines` it goes on over
 * the lines that follow, until one of them opens a block or a comment of its own.
 */
export function scanAttributeBlock(text: string, start: number, acrossLines = false): ScannedBlock {
  const keys: BlockKey[] = [];
  const open: string[] = [];
  let expectingKey = true;
  // Whether a scalar may start here: nothing but spaces since the last indicator.
  let atStart = true;
  let afterQuoted = false;
  let firstLine = true;
  let index = start + 2;
  const stopped = (openQuote = false): ScannedBlock => ({
    end: index,
    closed: false,
    openQuote,
    keys,
  });

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
    const wasQuoted = afterQuoted;
    afterQuoted = false;
    const topLevelKey = expectingKey && open.length === 0;

    // On a line after the first, which may be a statement of its own, a quote opens quoted
    // text wherever it stands, as it does in a label; the apostrophe in `it's` does not.
    if ((atStart || (!firstLine && !isApostrophe(text, index))) && isQuote(char)) {
      const quoted = quotedEnd(text, index);
      if (topLevelKey) {
        keys.push({ text: text.slice(index, quoted.end), offset: index - start });
        expectingKey = false;
      }
      index = quoted.end;
      if (!quoted.closed && !acrossLines) {
        return stopped(true);
      }
      atStart = false;
      afterQuoted = true;
    } else if (char === '[' || char === '{') {
      open.push(char);
      expectingKey = false;
      atStart = true;
      index++;
    } else if (char === ']') {
      if (open[open.length - 1] === '[') {
        open.pop();
      }
      atStart = false;
      // Like quoted text, a list or a mapping may be followed by `:` with no space after it.
      afterQuoted = true;
      index++;
    } else if (char === '}') {
      const mapping = open.lastIndexOf('{');
      index++;
      if (mapping < 0) {
        return { end: index, closed: true, openQuote: false, keys };
      }
      open.length = mapping;
      atStart = false;
      afterQuoted = true;
    } else if (char === ',') {
      expectingKey ||= open.length === 0;
      atStart = true;
      index++;
    } else if (char === ':' && (wasQuoted || separates(text, index))) {
      if (topLevelKey) {
        // A value with no key in front of it.
        keys.push({ text: '', offset: index - start });
        expectingKey = false;
      }
      atStart = true;
      index++;
    } else if (atStart && topLevelKey && char === '?' && separates(text, index)) {
      // `? key : value`, the long way to write a key.
      index++;
    } else if (atStart && (char === '!' || char === '&') && endsWithSpace(text, index)) {
      // A tag (`!!str`) or an anchor (`&name`) stands in front of a key or a value, which
      // starts after it.
      while (index < text.length && !isSpace(text[index])) {
        index++;
      }
    } else {
      // Plain text runs to the next indicator, or to a `:` that separates.
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
      if (atStart && topLevelKey) {
        keys.push({ text: text.slice(index, end).trimEnd(), offset: index - start });
        expectingKey = false;
      }
      atStart = false;
      index = end;
    }
  }
  return stopped();
}
