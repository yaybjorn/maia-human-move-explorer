export function orderedPositions(pack) {
  return [...(pack.positions || [])].sort((a, b) =>
    (a.learningOrder ?? Number.MAX_SAFE_INTEGER) - (b.learningOrder ?? Number.MAX_SAFE_INTEGER)
      || a.id.localeCompare(b.id));
}

export function defaultChapters(pack, target = 24) {
  const positions = orderedPositions(pack);
  if (!positions.length) return [];
  const count = Math.max(1, Math.round(positions.length / target));
  return Array.from({ length: count }, (_, index) => {
    const start = Math.round(index * positions.length / count);
    const end = Math.round((index + 1) * positions.length / count);
    return {
      id: uniqueChapterID(pack.id, [], index + 1),
      title: `Chapter ${index + 1}`,
      positionIDs: positions.slice(start, end).map(position => position.id),
    };
  });
}

export function validateChapters(pack, chapters) {
  const expected = orderedPositions(pack).map(position => position.id);
  const actual = chapters.flatMap(chapter => chapter.positionIDs || []);
  const errors = [];
  if (!chapters.length) errors.push("Add at least one chapter.");
  if (chapters.some(chapter => !chapter.title?.trim())) errors.push("Every chapter needs a name.");
  if (chapters.some(chapter => !(chapter.positionIDs || []).length)) errors.push("A chapter cannot be empty.");
  if (new Set(chapters.map(chapter => chapter.id)).size !== chapters.length) errors.push("Chapter IDs must be unique.");
  if (actual.length !== expected.length || actual.some((id, index) => id !== expected[index])) {
    errors.push("Every position must appear exactly once in learning order.");
  }
  return errors;
}

export function startsFromChapters(pack, chapters) {
  const positions = orderedPositions(pack);
  const indexByID = new Map(positions.map((position, index) => [position.id, index]));
  const starts = chapters.map(chapter => indexByID.get(chapter.positionIDs?.[0])).filter(Number.isInteger);
  return starts.length === chapters.length ? starts : [];
}

export function chaptersFromStarts(pack, chapters, starts) {
  const positions = orderedPositions(pack);
  const sorted = [...starts].sort((a, b) => a - b);
  return sorted.map((start, index) => ({
    id: chapters[index]?.id || uniqueChapterID(pack.id, chapters, index + 1),
    title: chapters[index]?.title || `Chapter ${index + 1}`,
    positionIDs: positions.slice(start, sorted[index + 1] ?? positions.length).map(position => position.id),
  }));
}

export function moveBoundary(pack, chapters, chapterIndex, newStart) {
  const starts = startsFromChapters(pack, chapters);
  if (chapterIndex <= 0 || chapterIndex >= starts.length) return chapters;
  const minimum = starts[chapterIndex - 1] + 1;
  const maximum = (starts[chapterIndex + 1] ?? orderedPositions(pack).length) - 1;
  starts[chapterIndex] = Math.max(minimum, Math.min(maximum, newStart));
  return chaptersFromStarts(pack, chapters, starts);
}

export function addBoundary(pack, chapters, positionIndex) {
  const starts = startsFromChapters(pack, chapters);
  if (positionIndex <= 0 || positionIndex >= orderedPositions(pack).length || starts.includes(positionIndex)) return chapters;
  const insertion = starts.findIndex(start => start > positionIndex);
  const chapterIndex = insertion === -1 ? starts.length : insertion;
  starts.splice(chapterIndex, 0, positionIndex);
  const existing = [...chapters];
  existing.splice(chapterIndex, 0, {
    id: uniqueChapterID(pack.id, chapters, chapterIndex + 1),
    title: `Chapter ${chapterIndex + 1}`,
    positionIDs: [],
  });
  return chaptersFromStarts(pack, existing, starts);
}

export function removeChapter(pack, chapters, chapterIndex) {
  if (chapters.length <= 1 || chapterIndex <= 0) return chapters;
  const starts = startsFromChapters(pack, chapters);
  starts.splice(chapterIndex, 1);
  const remaining = chapters.filter((_, index) => index !== chapterIndex);
  return chaptersFromStarts(pack, remaining, starts);
}

export function manifestFor(pack, chapters) {
  return { schemaVersion: 1, packID: pack.id, chapters };
}

function uniqueChapterID(packID, chapters, preferred) {
  const used = new Set(chapters.map(chapter => chapter.id));
  let number = preferred;
  while (used.has(`${packID}-chapter-${number}`)) number += 1;
  return `${packID}-chapter-${number}`;
}
