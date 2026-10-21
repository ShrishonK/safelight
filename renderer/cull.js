/* ============================================================
   cull.js — first pass through a shoot
   ------------------------------------------------------------
   Cull mode never develops anything: it shows each file's
   embedded preview, so stepping through hundreds of raws is as
   fast as reading them off disk. K flags the keepers; the
   flagged set then moves to its own folder and opens in a new
   workspace tab, ready to edit.
   ============================================================ */
'use strict';

const CULL = { on: false, side: 7 };   // the ribbon shows `side` photos either side of the current one

function isCulling() { return CULL.on; }

function setMode(mode) {
  const on = mode === 'cull';
  document.querySelectorAll('#modeSeg button').forEach(b => b.classList.toggle('on', b.dataset.mode === mode));
  if (on === CULL.on) return;
  CULL.on = on;
  if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
  document.body.classList.toggle('cull', on);
  if (on) {
    if (FOLDER.files.length && FOLDER.cur < 0) {
      // start on the photo being edited if it lives in this folder
      const im = IM();
      const k = im ? FOLDER.files.findIndex(f => f.path === im.path) : -1;
      FOLDER.cur = k >= 0 ? k : 0;
    }
    renderCull();
    return;
  }
  // back to the editor, on whichever photo the cull ended on
  renderFolder();
  const f = FOLDER.files[FOLDER.cur], im = IM();
  if (f && (!im || im.path !== f.path)) openPhotoAt(FOLDER.cur);
  else requestRender(false);
}

/* ---------- the view ---------- */
function renderCull() {
  if (!CULL.on) return;
  const files = FOLDER.files, n = files.length;
  const img = document.getElementById('cullImg'), msg = document.getElementById('cullMsg');
  updateFlagCounts();

  if (!FOLDER.dir || !n) {
    img.removeAttribute('src');
    document.getElementById('cullFlag').hidden = true;
    document.getElementById('cullName').textContent = '';
    document.getElementById('cullPrev').disabled = document.getElementById('cullNext').disabled = true;
    document.getElementById('ribbon').innerHTML = '';
    msg.innerHTML = FOLDER.dir ? 'No photos in this folder'
      : 'Open a folder to cull it<br><kbd>Ctrl+Shift+O</kbd> or Folder… in Edit mode';
    return;
  }

  const i = FOLDER.cur = clamp(FOLDER.cur, 0, n - 1);
  const f = files[i];
  document.getElementById('cullName').textContent = `${f.name}  ·  ${i + 1} / ${n}`;
  document.getElementById('cullFlag').hidden = !FLAGS.has(f.path);
  document.getElementById('cullPrev').disabled = i === 0;
  document.getElementById('cullNext').disabled = i === n - 1;

  if (THUMBS.has(f.path)) { showCullImage(f.path); }
  else {
    img.removeAttribute('src'); img.dataset.path = '';
    msg.textContent = THUMB_BAD.has(f.path) ? 'No preview in this file' : 'Loading preview…';
  }
  renderRibbon(i);

  // nearest first, so the photo on screen decodes before its neighbours
  const want = [i];
  for (let d = 1; d <= CULL.side; d++) want.push(i + d, i - d);
  const paths = want.filter(k => k >= 0 && k < n).map(k => files[k].path);
  thumbPrune(new Set(paths));
  for (let k = paths.length - 1; k >= 0; k--) {
    const p = paths[k];
    thumbFor(p, true).then(() => {
      if (!CULL.on) return;
      if (FOLDER.files[FOLDER.cur] && FOLDER.files[FOLDER.cur].path === p) showCullImage(p);
      fillRibbonCell(p);
    }).catch(e => {
      if (e.message === 'skipped' || !CULL.on) return;
      if (FOLDER.files[FOLDER.cur] && FOLDER.files[FOLDER.cur].path === p) msg.textContent = 'No preview in this file';
    });
  }
}

function showCullImage(p) {
  const img = document.getElementById('cullImg');
  if (img.dataset.path !== p) { img.src = THUMBS.get(p); img.dataset.path = p; }
  document.getElementById('cullMsg').textContent = '';
}

function renderRibbon(i) {
  const rib = document.getElementById('ribbon');
  const slots = CULL.side * 2 + 1;
  if (rib.children.length !== slots) {
    rib.innerHTML = '';
    for (let s = 0; s < slots; s++) {
      const c = document.createElement('div');
      c.innerHTML = '<img alt="" decoding="async"><div class="ty"></div><div class="flagbar" hidden>FLAGGED</div>';
      c.onclick = () => { const k = +c.dataset.index; if (k >= 0) cullGo(k); };
      rib.append(c);
    }
  }
  [...rib.children].forEach((c, s) => {
    const k = i - CULL.side + s;
    const f = FOLDER.files[k];
    const im = c.querySelector('img');
    if (!f) {
      c.className = 'rcell blank'; c.dataset.index = -1; c.dataset.path = '';
      im.removeAttribute('src');
      return;
    }
    c.className = 'rcell' + (k === i ? ' cur' : '');
    c.dataset.index = k; c.dataset.path = f.path; c.title = f.name;
    c.querySelector('.ty').textContent = extOf(f.name);
    c.querySelector('.flagbar').hidden = !FLAGS.has(f.path);
    if (THUMBS.has(f.path)) { if (im.getAttribute('src') !== THUMBS.get(f.path)) im.src = THUMBS.get(f.path); }
    else im.removeAttribute('src');
  });
}

function fillRibbonCell(p) {
  for (const c of document.getElementById('ribbon').children) {
    if (c.dataset.path !== p) continue;
    const im = c.querySelector('img');
    if (im.getAttribute('src') !== THUMBS.get(p)) im.src = THUMBS.get(p);
  }
}

function cullGo(k) {
  if (!FOLDER.files.length) return;
  FOLDER.cur = clamp(k, 0, FOLDER.files.length - 1);
  saveTabs();
  renderCull();
}
const cullStep = d => cullGo(FOLDER.cur + d);

function toggleFlag() {
  const f = FOLDER.files[FOLDER.cur];
  if (!f) return;
  if (FLAGS.has(f.path)) FLAGS.delete(f.path); else FLAGS.add(f.path);
  saveFlags();
  renderCull();
}

function clearFlags() {
  const here = flaggedHere();
  if (!here.length) return;
  if (!confirm(`Remove the flag from ${here.length} photo${here.length === 1 ? '' : 's'} in ${FOLDER.name}?`)) return;
  here.forEach(f => FLAGS.delete(f.path));
  saveFlags();
  renderCull();
}

/* ---------- moving the keepers into their own workspace ---------- */
function moveDialog() {
  const picks = flaggedHere();
  if (!picks.length) { toast('Flag photos with K first'); return; }
  let parent = FOLDER.dir;
  const card = document.getElementById('card');
  card.innerHTML = `
    <h4>Move ${picks.length} flagged photo${picks.length === 1 ? '' : 's'}</h4>
    <div class="cbody">
      <div class="field"><span>New folder</span><input type="text" id="mvName"></div>
      <div class="field"><span>Inside</span><button class="tb" id="mvWhere"
        style="max-width:190px;overflow:hidden;text-overflow:ellipsis"></button></div>
      <div class="hint" id="mvInfo"></div>
    </div>
    <div class="foot">
      <button class="tb" id="mvCancel">Cancel</button>
      <button class="tb primary" id="mvGo">Move &amp; open</button>
    </div>`;
  const where = document.getElementById('mvWhere');
  const showWhere = () => { where.textContent = baseName(parent); where.title = parent; };
  showWhere();
  document.getElementById('mvName').value = 'Selects';
  document.getElementById('mvInfo').textContent =
    `The files are moved, not copied — they leave ${FOLDER.name}. Edits and any .xmp or .slcar ` +
    `sidecars go with them, and the new folder opens in its own workspace tab.`;
  const modal = document.getElementById('modal');
  modal.classList.add('open');
  const nameEl = document.getElementById('mvName');
  nameEl.focus(); nameEl.select();

  where.onclick = async () => {
    const d = await N.chooseDir('Put the new folder inside…', parent);
    if (d) { parent = d; showWhere(); }
  };
  document.getElementById('mvCancel').onclick = () => modal.classList.remove('open');
  const go = () => {
    const name = nameEl.value.trim();
    if (!name || /[\\/:*?"<>|]/.test(name) || name === '.' || name === '..') { toast('Pick a folder name without / \\ : * ? " < > |'); return; }
    modal.classList.remove('open');
    moveFlagged(picks, parent, name);
  };
  document.getElementById('mvGo').onclick = go;
  nameEl.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
}

async function moveFlagged(picks, parent, name) {
  // land back in the source folder on the first photo that stays behind
  const stay = FOLDER.files.slice(FOLDER.cur).concat(FOLDER.files.slice(0, FOLDER.cur)).find(f => !FLAGS.has(f.path));
  let r;
  try {
    await busy(`Moving ${picks.length} photo${picks.length === 1 ? '' : 's'} to ${name}`);
    r = await N.moveFiles(picks.map(f => f.path), parent, name);
  } finally { busy(null); }
  if (!r || r.error) { showError('Nothing was moved', [r ? r.error : 'the move failed']); return; }

  const ok = r.moved.filter(m => m.to), bad = r.moved.filter(m => m.error);
  remapMoved(ok);
  FOLDER.cur = stay ? FOLDER.files.indexOf(stay) : -1;
  await openFolder(FOLDER.dir, { quiet: true });          // rescan: the keepers are gone from here
  if (await openFolder(r.dest, { newTab: true, quiet: true })) {
    FOLDER.cur = FOLDER.files.length ? 0 : -1;
    setMode('edit');
  }
  if (bad.length) showError(`${bad.length} photo${bad.length === 1 ? ' was' : 's were'} not moved`,
    bad.map(b => baseName(b.from) + ' — ' + b.error));
  else toast(`Moved ${ok.length} photo${ok.length === 1 ? '' : 's'} to ${name}`);
}

/* ---------- wiring ---------- */
document.addEventListener('DOMContentLoaded', () => {
  if (!window.native) { document.getElementById('modeSeg').hidden = true; return; }

  document.querySelectorAll('#modeSeg button').forEach(b => b.onclick = () => setMode(b.dataset.mode));
  document.getElementById('cullPrev').onclick = () => cullStep(-1);
  document.getElementById('cullNext').onclick = () => cullStep(1);
  document.getElementById('cullPic').ondblclick = () => setMode('edit');
  document.getElementById('btnMoveFlagged').onclick = moveDialog;
  document.getElementById('btnUnflag').onclick = clearFlags;

  // runs before folder.js and app.js see the key: edit shortcuts (masks, crop,
  // presets) would otherwise act on a photo that isn't even on screen
  addEventListener('keydown', e => {
    if (!CULL.on) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;          // menu chords
    if (document.getElementById('modal').classList.contains('open')) return;
    const k = e.key;
    if (k === 'ArrowRight' || k === 'ArrowDown') cullStep(1);
    else if (k === 'ArrowLeft' || k === 'ArrowUp') cullStep(-1);
    else if (k === 'Home') cullGo(0);
    else if (k === 'End') cullGo(FOLDER.files.length - 1);
    else if (k.toLowerCase() === 'k') { if (!e.repeat) toggleFlag(); }
    else if (k === 'Enter' || k === 'Escape') setMode('edit');
    e.preventDefault();
    e.stopImmediatePropagation();
  }, true);
});
