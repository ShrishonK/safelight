/* ============================================================
   cull.js — picking the keepers out of a shoot
   ------------------------------------------------------------
   A second mode, reached by the tab in the header. The panels get
   out of the way, the photo fills the window and the filmstrip lies
   along the bottom: arrow keys walk the shoot, K flags what's worth
   editing, and Move takes the flagged files to a folder of their own.

   Flags live per folder and survive a restart. Nothing is copied or
   overwritten: a move is a move, it can be undone for as long as the
   app is open, and a photo's edits follow it to its new home.
   ============================================================ */
'use strict';

const CULL = { on: false, out: null, filter: 'all', picks: new Set(), stored: {}, lastMove: null };

const CULL_FILTERS = {
  all: () => true,
  raw: n => RAWRE.test(n),
  jpeg: n => /\.jpe?g$/i.test(n),
  png: n => /\.(png|webp)$/i.test(n),
  fedr: n => /\.fedr$/i.test(n)
};
function cullMatches(name) { return (CULL_FILTERS[CULL.filter] || CULL_FILTERS.all)(name); }

const dirOf = p => p.slice(0, Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')));
const baseOf = p => p.split(/[\\/]/).pop();
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* ---------- flags ---------- */
let _pathKey = '', _pathSet = new Set();
function folderPaths() {
  const key = FOLDER.dir + '|' + FOLDER.files.length;
  if (key !== _pathKey) { _pathKey = key; _pathSet = new Set(FOLDER.files.map(f => f.path)); }
  return _pathSet;
}
function flaggedHere() {
  const here = folderPaths();
  return FOLDER.files.filter(f => CULL.picks.has(f.path)).map(f => f.path).filter(p => here.has(p));
}

let _pickTimer = 0;
function savePicks() {
  if (!FOLDER.dir || !window.native) return;
  clearTimeout(_pickTimer);
  _pickTimer = setTimeout(() => {
    delete CULL.stored[FOLDER.dir];
    CULL.stored[FOLDER.dir] = [...CULL.picks];
    const dirs = Object.keys(CULL.stored);
    for (const d of dirs.slice(0, Math.max(0, dirs.length - 5))) delete CULL.stored[d];
    N.storeSet({ cullPicks: CULL.stored });
  }, 400);
}
/* called by folder.js whenever a folder opens */
function loadPicksForFolder() {
  CULL.picks = new Set((CULL.stored && CULL.stored[FOLDER.dir]) || []);
  CULL.lastMove = null;
  cullSync();
}

function toggleFlag(path) {
  if (!path) return;
  if (CULL.picks.has(path)) CULL.picks.delete(path); else CULL.picks.add(path);
  const el = THUMB_EL.get(path);
  if (el) el.classList.toggle('is-flagged', CULL.picks.has(path));
  savePicks();
  cullSync();
}
function flagCurrent() {
  const im = IM();
  if (!im || !im.path) { toast('Open a photo first'); return; }
  toggleFlag(im.path);
}

/* ---------- the mode ---------- */
function setCullMode(on) {
  if (on === CULL.on) return;
  CULL.on = on;
  document.body.classList.toggle('cull', on);
  if (window.native) N.storeSet({ cullMode: on });      // start in whichever mode you left off in
  document.getElementById('tabCull').classList.toggle('on', on);
  document.getElementById('tabDevelop').classList.toggle('on', !on);
  // the same filmstrip element, re-hung under the photo or back in the sidebar
  const strip = document.getElementById('strip');
  document.getElementById(on ? 'cullstrip' : 'side').append(strip);
  if (on && A.cropMode) toggleCrop();
  if (on) { A.showMask = false; A.before = false; }    // a viewing mode: no mask overlay over the photo
  renderFolder();
  cullSync();
  requestRender(false);
  if (on && A.cur < 0) {
    const list = stripFiles();
    if (list.length) openPhotoAt(FOLDER.files.indexOf(list[0]));
  }
}
function toggleCullMode() { setCullMode(!CULL.on); }

function cullSync() {
  const bar = document.getElementById('cullbar');
  if (!bar) return;
  bar.hidden = !CULL.on;
  document.getElementById('cullstrip').hidden = !CULL.on;
  const inEl = document.getElementById('cullIn');
  inEl.textContent = FOLDER.dir ? baseOf(FOLDER.dir) : 'no folder open';
  inEl.title = FOLDER.dir || '';
  const outEl = document.getElementById('cullOut');
  outEl.textContent = CULL.out ? baseOf(CULL.out) : 'choose a folder';
  outEl.title = CULL.out || '';
  const n = flaggedHere().length;
  document.getElementById('cullCount').textContent = n ? `${n} flagged` : 'nothing flagged';
  const mv = document.getElementById('cullMove');
  mv.textContent = n ? `Move ${n}` : 'Move';
  mv.disabled = !n || !CULL.out;
  document.getElementById('cullUndo').hidden = !(CULL.lastMove && CULL.lastMove.length);
  document.getElementById('cullFilter').value = CULL.filter;
  const im = IM();
  document.getElementById('flagbadge').hidden = !(CULL.on && im && im.path && CULL.picks.has(im.path));
}

/* ---------- moving the keepers ---------- */
function cullConfirm(n, then) {
  document.getElementById('card').innerHTML =
    `<h4>Move ${n} photo${n === 1 ? '' : 's'}</h4>
     <div class="cbody">
       <div class="hint" style="color:var(--text);margin:6px 0">
         ${n === 1 ? 'This file leaves' : 'These files leave'} <b>${esc(FOLDER.dir)}</b><br>and ${n === 1 ? 'ends' : 'end'} up in <b>${esc(CULL.out)}</b>.
       </div>
       <div class="hint">Nothing is overwritten — a name already in use gets a number. Edits you have made travel with the photo, and <b>Move back</b> undoes this until you move again or quit.</div>
     </div>
     <div class="foot"><button class="tb" id="cmCancel">Cancel</button><button class="tb primary" id="cmGo">Move ${n}</button></div>`;
  document.getElementById('modal').classList.add('open');
  const close = () => document.getElementById('modal').classList.remove('open');
  document.getElementById('cmCancel').onclick = close;
  document.getElementById('cmGo').onclick = () => { close(); then(); };
}

async function runMove(items, what) {
  flushEdits();                       // pending edits belong to the old path
  const at = FOLDER.cur;
  await busy(what);
  let res = [];
  try { res = await N.cullMove(items); }
  catch (e) { showError('The move failed', [String(e.message || e)]); return []; }
  finally { busy(null); }
  for (const r of res) {
    if (!r.to) continue;
    CULL.picks.delete(r.from);
    forgetPhoto(r.from);
    const url = THUMBS.get(r.from);
    if (url) { URL.revokeObjectURL(url); THUMBS.delete(r.from); }
  }
  savePicks();
  await refreshFolder();
  // the photo on screen may have just left the folder; land where it was
  if (A.cur < 0) {
    const list = stripFiles();
    if (list.length) openPhotoAt(FOLDER.files.indexOf(list[clamp(at, 0, list.length - 1)]));
  }
  cullSync();
  const failed = res.filter(r => r.error);
  if (failed.length) {
    showError(`${failed.length} photo${failed.length === 1 ? '' : 's'} could not be moved`,
      failed.map(f => baseOf(f.from) + ' — ' + f.error));
  }
  return res.filter(r => r.to);
}

async function cullMoveFlagged() {
  if (!FOLDER.dir) { toast('Open a folder first'); return; }
  if (!CULL.out) { toast('Choose an output folder first'); return; }
  if (CULL.out === FOLDER.dir) { toast('The output folder is the folder you are culling'); return; }
  const paths = flaggedHere();
  if (!paths.length) { toast('Nothing flagged — press K on the ones worth keeping'); return; }
  cullConfirm(paths.length, async () => {
    const moved = await runMove(paths.map(p => ({ from: p, toDir: CULL.out })), `Moving ${paths.length} photo${paths.length === 1 ? '' : 's'}`);
    CULL.lastMove = moved.length ? moved : null;
    cullSync();
    if (moved.length) toast(`Moved ${moved.length} photo${moved.length === 1 ? '' : 's'} to ${baseOf(CULL.out)}`);
  });
}

async function cullMoveBack() {
  const last = CULL.lastMove;
  if (!last || !last.length) return;
  const back = await runMove(last.map(r => ({ from: r.to, toDir: dirOf(r.from), toName: baseOf(r.from) })), 'Moving back');
  for (const r of back) if (folderPaths().has(r.to)) CULL.picks.add(r.to);   // still flagged, as they were
  CULL.lastMove = null;
  savePicks();
  renderFolder();
  cullSync();
  if (back.length) toast(`Moved ${back.length} photo${back.length === 1 ? '' : 's'} back`);
}

/* ---------- wiring ---------- */
document.addEventListener('DOMContentLoaded', () => {
  if (!window.native) return;

  document.getElementById('tabDevelop').onclick = () => setCullMode(false);
  document.getElementById('tabCull').onclick = () => setCullMode(true);
  document.getElementById('cullPickIn').onclick = async () => {
    const dir = await N.pickFolder();
    if (dir) openFolder(dir);
  };
  document.getElementById('cullPickOut').onclick = async () => {
    const dir = await N.pickCullOut();
    if (!dir) return;
    CULL.out = dir;
    cullSync();
  };
  document.getElementById('cullFilter').onchange = e => {
    CULL.filter = e.target.value;
    N.storeSet({ cullFilter: CULL.filter });
    renderFolder();
    cullSync();
  };
  document.getElementById('cullMove').onclick = cullMoveFlagged;
  document.getElementById('cullUndo').onclick = cullMoveBack;

  N.onMenu(cmd => { if (cmd === 'cull') toggleCullMode(); });

  // K flags the photo on screen; in Develop mode K still adds a colour mask
  addEventListener('keydown', e => {
    if (!CULL.on) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'Escape') { setCullMode(false); e.stopImmediatePropagation(); return; }
    if (e.key.toLowerCase() === 'k') { flagCurrent(); e.preventDefault(); e.stopImmediatePropagation(); }
  }, true);

  N.storeGet().then(st => {
    if (!st) return;
    CULL.out = st.cullOut || null;
    CULL.filter = st.cullFilter || 'all';
    CULL.stored = st.cullPicks || {};
    if (FOLDER.dir) loadPicksForFolder();
    cullSync();
    if (st.cullMode) setCullMode(true);
  });
});
