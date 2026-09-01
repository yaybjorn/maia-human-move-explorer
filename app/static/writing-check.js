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
      if (
        !CHECKED_KINDS.has(kind) ||
        looksLikeChessNotation(problem) ||
        ignoredWordSet.has(normaliseIgnoredWord(problem)) ||
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
        message: lint.message(),
        problem,
        start: span.start,
        end: span.end,
        canIgnore: canIgnoreWord(problem),
        suggestions: suggestions
          .map(suggestion => suggestion.get_replacement_text())
          .filter((value, index, values) => values.indexOf(value) === index)
          .slice(0, 4)
      });
      suggestions.forEach(suggestion => suggestion.free());
      span.free();
      lint.free();
    }
  }

  return findings;
}
