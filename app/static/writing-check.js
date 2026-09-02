import {
  canIgnoreWord,
  ignoredWritingRanges,
  normaliseIgnoredWord,
  overlapsIgnoredRange,
  writingTextForLint
} from './writing-rules.mjs';

const CHECKED_KINDS = new Set([
  'Agreement', 'BoundaryError', 'Capitalization', 'Eggcorn', 'Formatting',
  'Grammar', 'Malapropism', 'Nonstandard', 'Punctuation', 'Regionalism',
  'Repetition', 'Spelling', 'Typo', 'Usage', 'WordChoice', 'WordOrder'
]);

const CHESS_TERMS = [
  'Maia', 'Stockfish', 'PGN', 'FEN', 'SAN', 'UCI', 'chess', 'checkmate',
  'castling', 'fianchetto', 'gambit', 'kingside', 'queenside', 'repertoire',
  'Kilkenny', 'Portsmouth', 'Jobava'
];

let linterPromise;

async function getLinter() {
  if (!linterPromise) {
    linterPromise = import('./vendor/harper/index.js').then(async harper => {
      const binary = harper.createBinaryModuleFromUrl(
        new URL('./vendor/harper/harper-full.wasm', import.meta.url).href,
        'full'
      );
      const linter = new harper.LocalLinter({
        binary,
        dialect: harper.Dialect.British
      });
      await linter.setup();
      await linter.importWords(CHESS_TERMS);
      return linter;
    });
  }
  return linterPromise;
}

function looksLikeChessNotation(value) {
  return /^(?:O-O(?:-O)?[+#]?|[KQRBN]?[a-h]?[1-8]?x?[a-h][1-8](?:=[QRBN])?[+#]?|[a-h][1-8][a-h][1-8][qrbn]?)$/i.test(value);
}

function initialSurnameContext(comment, start, problem) {
  if (!/^\p{Lu}\.?$/u.test(problem)) return null;
  const initial = `${problem[0]}.`;
  if (comment.slice(start, start + initial.length) !== initial) return null;
  const following = comment.slice(start + initial.length);
  if (/^\p{Lu}[\p{L}'’-]+/u.test(following)) {
    return { initial, end: start + initial.length, missingSpace: true };
  }
  if (/^\s+\p{Lu}[\p{L}'’-]+/u.test(following)) {
    return { initial, end: start + initial.length, missingSpace: false };
  }
  return null;
}

function normaliseSuggestions(problem, suggestions, initialContext) {
  const replacements = suggestions.map(suggestion => suggestion.get_replacement_text());

  // Harper interprets a missing space after a comma as replacing the comma
  // with whitespace. Keep the punctuation and add the missing space instead.
  const corrected = replacements.map(value => (
    problem === ',' && /^\s+$/u.test(value) ? `,${value}` : value
  ));

  // Initials attached to surnames are valid names with one missing space, not
  // misspellings such as "Jo" or "Jr". Put the useful correction first.
  if (initialContext?.missingSpace) {
    corrected.unshift(`${initialContext.initial} `);
  }

  return corrected.filter((value, index, values) => values.indexOf(value) === index).slice(0, 4);
}

export function writingSuggestionLabel(problem, replacement) {
  const value = String(replacement);
  if (value === `${problem} ` || /^\s+$/u.test(value)) return 'Add space';
  return `Fix: ${value || 'Remove'}`;
}

export function writingBulkFix(issue) {
  const problem = String(issue?.problem ?? '');
  const replacement = issue?.suggestions?.[0];
  if (!problem || typeof replacement !== 'string') return null;
  return {
    key: JSON.stringify([problem, replacement]),
    label: problem === '...' && replacement === '…'
      ? 'Fix all ellipses'
      : `Fix all “${problem}”`,
    replacement
  };
}

export function groupWritingBulkFixes(issues) {
  const grouped = new Map();
  for (const issue of issues) {
    const fix = writingBulkFix(issue);
    if (!fix) continue;
    const current = grouped.get(fix.key) || { ...fix, issues: [] };
    current.issues.push(issue);
    grouped.set(fix.key, current);
  }
  return [...grouped.values()].filter(fix => fix.issues.length > 1);
}

export async function checkWriting(sources, { ignoredWords = [] } = {}) {
  const linter = await getLinter();
  const findings = [];
  const ignoredWordSet = new Set(ignoredWords.map(normaliseIgnoredWord));

  for (const source of sources) {
    const ignoredRanges = ignoredWritingRanges(source.comment, {
      allowSanPlaceholder: source.sourceId === 'metadata:fallbackFeedback'
    });
    const lints = await linter.lint(writingTextForLint(source.comment), {
      language: 'plaintext',
      dedup: true
    });

    for (const lint of lints) {
      const kind = lint.lint_kind();
      const problem = lint.get_problem_text();
      const span = lint.span();
      const initialContext = initialSurnameContext(source.comment, span.start, problem);
      if (
        !CHECKED_KINDS.has(kind) ||
        looksLikeChessNotation(problem) ||
        ignoredWordSet.has(normaliseIgnoredWord(problem)) ||
        initialContext?.missingSpace === false ||
        overlapsIgnoredRange(span.start, span.end, ignoredRanges)
      ) {
        span.free();
        lint.free();
        continue;
      }

      const suggestions = lint.suggestions();
      findings.push({
        sourceId: source.sourceId,
        history: source.history,
        comment: source.comment,
        kind: lint.lint_kind_pretty(),
        message: initialContext?.missingSpace
          ? 'Add a space between the initial and surname.'
          : lint.message(),
        problem: initialContext?.initial || problem,
        start: span.start,
        end: initialContext?.end || span.end,
        canIgnore: canIgnoreWord(initialContext?.initial || problem),
        suggestions: normaliseSuggestions(
          problem,
          suggestions,
          initialContext
        )
      });
      suggestions.forEach(suggestion => suggestion.free());
      span.free();
      lint.free();
    }
  }

  return findings;
}
