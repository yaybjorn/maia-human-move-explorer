const ACCEPTED_PHRASES = [
  /\bfaint-hearted\b/giu,
  /\botherwise known as\b/giu
];

const BLACK_MOVE_NOTATION = /\.\.\.(?:O-O(?:-O)?|[KQRBN]?[a-h]?[1-8]?x?[a-h][1-8](?:=[QRBN])?[+#]?)/g;

function addMatches(ranges, value, pattern) {
  pattern.lastIndex = 0;
  for (const match of value.matchAll(pattern)) {
    ranges.push({ start: match.index, end: match.index + match[0].length });
  }
}

export function ignoredWritingRanges(value) {
  const ranges = [];

  // Square-bracketed PGN directives such as [%csl ...] and [%cal ...] are
  // machine annotations, not prose. Ignore any bracketed block so future PGN
  // directives do not need their own special case.
  addMatches(ranges, value, /\[[\s\S]*?\]/g);
  addMatches(ranges, value, BLACK_MOVE_NOTATION);
  ACCEPTED_PHRASES.forEach(pattern => addMatches(ranges, value, pattern));

  return ranges;
}

export function overlapsIgnoredRange(start, end, ranges) {
  return ranges.some(range => start < range.end && end > range.start);
}

export function normaliseIgnoredWord(value) {
  return String(value).trim().toLocaleLowerCase('en-GB');
}

export function canIgnoreWord(value) {
  return /^[\p{L}][\p{L}'’-]*$/u.test(value);
}
