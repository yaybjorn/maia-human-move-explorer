const ACCEPTED_PHRASES = [
  /\bfaint-hearted\b/giu,
  /\botherwise known as\b/giu
];

const BLACK_MOVE_NOTATION = /\.\.\.(?:O-O(?:-O)?|[KQRBN]?[a-h]?[1-8]?x?[a-h][1-8](?:=[QRBN])?[+#]?)/g;

// SAN inside prose may carry annotation glyphs that look like sentence
// punctuation to a grammar checker: f5!, Nf3?!, Bxe6+!, O-O!, etc. Match a
// complete token with conservative text boundaries so normal prose remains
// untouched. This is lexical SAN recognition; comments often discuss a
// hypothetical move, so requiring legality in the current board position
// would incorrectly reject useful chess prose.
const SAN_TOKEN = /(^|[\s.([{"'“‘])((?:O-O(?:-O)?|0-0(?:-0)?|[KQRBN](?:[a-h]|[1-8]|[a-h][1-8])?x?[a-h][1-8]|(?:[a-h]x)?[a-h][1-8](?:=[QRBN])?)(?:\+\+|[+#])?(?:!!|\?\?|!\?|\?!|!|\?)?)(?=$|[\s)\]}"'”’.,;:])/gu;

function addMatches(ranges, value, pattern) {
  pattern.lastIndex = 0;
  for (const match of value.matchAll(pattern)) {
    ranges.push({ start: match.index, end: match.index + match[0].length });
  }
}

function sanMatches(value) {
  SAN_TOKEN.lastIndex = 0;
  return [...value.matchAll(SAN_TOKEN)].map(match => {
    const start = match.index + match[1].length;
    return { start, end: start + match[2].length, token: match[2] };
  });
}

export function writingTextForLint(value) {
  const characters = value.split('');
  for (const match of sanMatches(value)) {
    for (let index = match.start; index < match.end; index += 1) {
      if (characters[index] === '!' || characters[index] === '?') characters[index] = ' ';
    }
  }
  return characters.join('');
}

export function ignoredWritingRanges(value) {
  const ranges = [];

  // Square-bracketed PGN directives such as [%csl ...] and [%cal ...] are
  // machine annotations, not prose. Ignore any bracketed block so future PGN
  // directives do not need their own special case.
  addMatches(ranges, value, /\[[\s\S]*?\]/g);
  addMatches(ranges, value, BLACK_MOVE_NOTATION);
  sanMatches(value).forEach(({ start, end }) => ranges.push({ start, end }));
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
