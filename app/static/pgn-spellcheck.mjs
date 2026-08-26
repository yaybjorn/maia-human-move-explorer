export function extractCommentSources(pgn) {
  const sources = [];
  let inTag = false;
  let lineStart = true;

  for (let index = 0; index < pgn.length; index += 1) {
    const character = pgn[index];
    if (character === '\n' || character === '\r') {
      lineStart = true;
      continue;
    }
    if (lineStart && /\s/.test(character)) continue;
    if (lineStart && character === '%') {
      while (index < pgn.length && !/[\r\n]/.test(pgn[index])) index += 1;
      lineStart = true;
      continue;
    }
    lineStart = false;
    if (character === '[' && !inTag) { inTag = true; continue; }
    if (character === ']' && inTag) { inTag = false; continue; }
    if (inTag) continue;

    let rawStart;
    let rawEnd;
    if (character === '{') {
      rawStart = index + 1;
      rawEnd = pgn.indexOf('}', rawStart);
      if (rawEnd < 0) throw new Error('Invalid PGN: an opening { comment brace has no closing }.');
      index = rawEnd;
    } else if (character === ';') {
      rawStart = index + 1;
      rawEnd = pgn.slice(rawStart).search(/[\r\n]/);
      rawEnd = rawEnd < 0 ? pgn.length : rawStart + rawEnd;
      index = rawEnd - 1;
    } else {
      continue;
    }

    const raw = pgn.slice(rawStart, rawEnd);
    const leading = raw.length - raw.trimStart().length;
    const trailing = raw.length - raw.trimEnd().length;
    const comment = raw.slice(leading, raw.length - trailing || raw.length);
    if (!comment) continue;
    sources.push({
      sourceId: sources.length,
      comment,
      contentStart: rawStart + leading,
      contentEnd: rawEnd - trailing,
      history: `Comment ${sources.length + 1}`
    });
  }
  return sources;
}

export function attachMoveHistories(sources, contexts) {
  const histories = new Map();
  for (const context of contexts) {
    const key = context.comment.trim();
    const queue = histories.get(key) || [];
    queue.push(context.history);
    histories.set(key, queue);
  }
  return sources.map(source => ({
    ...source,
    history: histories.get(source.comment)?.shift() || source.history
  }));
}

export function applyIssueSuggestion(pgn, issue, replacement) {
  const source = extractCommentSources(pgn).find(item => item.sourceId === issue.sourceId);
  if (!source) throw new Error('That comment could not be found in the current PGN.');
  const start = source.contentStart + issue.start;
  const end = source.contentStart + issue.end;
  return `${pgn.slice(0, start)}${replacement}${pgn.slice(end)}`;
}

export function fixedFilename(originalName) {
  const base = (originalName || 'repertoire.pgn').replace(/\.pgn$/i, '');
  return `${base}-fixed.pgn`;
}
