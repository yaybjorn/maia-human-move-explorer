import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../app/static/studio.js', import.meta.url), 'utf8');
const openSource = source.slice(source.indexOf('async function openCourse('), source.indexOf('\nasync function hydrateSourceDocument('));

test('card open shows the editor, while cancellation leaves the current course intact', async () => {
  const state = {courseID:'old', courses:[], analysisToken:0};
  const elements = new Map();
  const element = id => { if (!elements.has(id)) elements.set(id, {}); return elements.get(id); };
  let isDirty = true, confirmed = false, shown = null, fetched = 0;
  const noop = () => {};
  const context = {state, location:{hash:'#dashboard'}, CSS:{escape:s=>s}, document:{querySelector:()=>({})},
    dirty:()=>isDirty, confirm:()=>confirmed, closeRecordingChoice:noop, closeEditorChoice:noop,
    invalidateDiagnostics:noop, stopEditorMaia:noop, showStatus:noop,
    api:{course:async id=>{fetched++; return {course:{id}, draft:{document:{metadata:{title:id}}}};}},
    normalizeDocument:d=>d, hydrateSourceDocument:async d=>({document:d}), coalesceIdenticalHints:d=>d, resetUserGames:noop,
    setEffectivePosition:d=>{state.document=d}, clearCrashRecovery:noop, restoreCrashRecovery:noop,
    $:element, renderAll:noop, refreshPosition:async()=>{}, switchView:v=>{shown=v}, JSON};
  const open = vm.runInNewContext(`(${openSource})`, context);
  assert.equal(await open('cowboy', {view:'editor'}), false);
  assert.equal(state.courseID, 'old'); assert.equal(fetched, 0);
  confirmed = true;
  for (const id of ['cowboy','portsmouth','kilkenny']) {
    assert.equal(await open(id, {view:'editor'}), true);
    assert.equal(state.courseID, id); assert.equal(shown, 'editor');
    isDirty = false;
  }
  context.location.hash = '#writing';
  await open('cowboy'); assert.equal(shown, 'writing');
  assert.match(source, /openCourse\(card\.dataset\.course, \{ view: "editor" \}\)/);
});
