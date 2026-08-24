const CHECKED_KINDS = new Set([
  'Agreement', 'BoundaryError', 'Capitalization', 'Eggcorn', 'Formatting',
  'Grammar', 'Malapropism', 'Nonstandard', 'Punctuation', 'Regionalism',
  'Repetition', 'Spelling', 'Typo', 'Usage', 'WordChoice', 'WordOrder'
]);

const CHESS_TERMS = [
  'Maia', 'Stockfish', 'PGN', 'FEN', 'SAN', 'UCI', 'chess', 'checkmate',
  'castling', 'fianchetto', 'gambit', 'kingside', 'queenside', 'repertoire'
];

let linterPromise;

async function getLinter() {
  if (!linterPromise) {
    linterPromise = Promise.all([
      import('./vendor/harper/index.js'),
      import('./vendor/harper/binary.js')
    ]).then(async ([harper, binaryModule]) => {
      const linter = new harper.LocalLinter({
        binary: binaryModule.binary,
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

export async function checkWriting(sources) {
  const linter = await getLinter();
  const findings = [];

  for (const source of sources) {
    const lints = await linter.lint(source.comment, {
      language: 'plaintext',
      dedup: true
    });

    for (const lint of lints) {
      const kind = lint.lint_kind();
      const problem = lint.get_problem_text();
      if (!CHECKED_KINDS.has(kind) || looksLikeChessNotation(problem)) {
        lint.free();
        continue;
      }

      const span = lint.span();
      const suggestions = lint.suggestions();
      findings.push({
        history: source.history,
        comment: source.comment,
        kind: lint.lint_kind_pretty(),
        message: lint.message(),
        problem,
        start: span.start,
        end: span.end,
        suggestions: suggestions
          .map(suggestion => suggestion.get_replacement_text())
          .filter((value, index, values) => value && values.indexOf(value) === index)
          .slice(0, 4)
      });
      suggestions.forEach(suggestion => suggestion.free());
      span.free();
      lint.free();
    }
  }

  return findings;
}
