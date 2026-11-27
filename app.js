import { parseMap, serializeMap, getRoot, children, findNode, addNode, setTitle, deleteNode, moveNode } from './model.js';

const $ = id => document.getElementById(id);
const canvas = $('canvas'), world = $('world'), nodesLayer = $('nodes'), lines = $('lines');
let doc = null, filename = '', savedSnapshot = '', selectedId = null;
let activeFileHandle = null, fileRevision = null, saveInProgress = false;
let openInProgress = false, openSequence = 0, pendingFallback = null;
let undoStack = [], redoStack = [], scale = 1, panX = 0, panY = 0, bounds = null;
let dialogAction = null, inlineDraft = null, pointer = null, drop = null, toastTimer;
const CARD_WIDTH = 220, LEVEL_GAP = 82, V_GAP = 22;

function notice(message) {
  $('toast').textContent = message;
  $('toast').classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('toast').classList.remove('show'), 3500);
}
const sameId = (a, b) => String(a) === String(b);
const snapshot = () => JSON.stringify(doc);
const dirty = () => doc && (snapshot() !== savedSnapshot ||
  (inlineDraft && inlineDraft.value !== findNode(doc, inlineDraft.id)?.title));
const readOnly = () => doc && doc.links !== undefined && (!Array.isArray(doc.links) || doc.links.length > 0);
function setTransform() {
  world.style.transform = `translate(${panX}px, ${panY}px) scale(${scale})`;
  $('zoom-label').textContent = `${Math.round(scale * 100)}%`;
}
function isRoot(id) { return doc && sameId(getRoot(doc).id, id); }
function selection() { return doc && selectedId !== null ? findNode(doc, selectedId) : null; }
function infoFor(id) {
  if (!doc) return null;
  const root = getRoot(doc);
  function visit(node, parent, side) {
    if (sameId(node.id, id)) return { node, parent, side };
    for (const entry of children(node)) {
      const result = visit(entry.node, node, node === root ? entry.side : side);
      if (result) return result;
    }
    return null;
  }
  return visit(root, null, 'right');
}
function updateControls() {
  const selected = !!selection() && !readOnly() && !openInProgress, root = selected && isRoot(selectedId);
  $('save').disabled = !doc || saveInProgress || openInProgress;
  $('overwrite').disabled = !doc || !activeFileHandle || readOnly() || saveInProgress || openInProgress;
  $('overwrite').title = activeFileHandle ? '開いたファイルに上書き保存' : '上書き保存には対応ブラウザでファイルを開き直してください';
  $('open').disabled = saveInProgress || openInProgress; $('open-empty').disabled = saveInProgress || openInProgress;
  $('undo').disabled = !undoStack.length || openInProgress; $('redo').disabled = !redoStack.length || openInProgress;
  $('add-child').disabled = !selected; $('add-sibling').disabled = !selected || root;
  $('edit').disabled = !selected; $('delete').disabled = !selected || root;
  $('filename').textContent = doc ? filename : 'ファイルが選択されていません';
  $('save-state').textContent = saveInProgress ? '保存中…' : openInProgress ? '読み込み中…' : readOnly() ? '未対応のリンクがあるため閲覧のみ' : doc ? (dirty() ? '未保存の変更があります' : activeFileHandle ? '変更なし' : '元ファイルは変更しません') : 'ファイルを開いてください';
  $('hint').textContent = readOnly() ? '閲覧のみ ・ 背景ドラッグで画面を移動' : doc ? 'ノードに重ねると子になります ・ 背景ドラッグで画面を移動' : 'ファイルを開いて始めましょう';
}
function choose(id) {
  selectedId = id;
  for (const el of nodesLayer.children) el.classList.toggle('selected', sameId(el._nodeId, id));
  updateControls();
}
function mutate(fn) {
  if (!doc || openInProgress) return;
  const old = snapshot();
  try {
    const result = fn();
    if (snapshot() !== old) { undoStack.push(old); if (undoStack.length > 100) undoStack.shift(); redoStack = []; }
    render(); updateControls();
    return result;
  } catch (error) {
    doc = JSON.parse(old); render(); updateControls(); notice(error.message || '操作できませんでした。');
    return null;
  }
}
function undo() {
  if (openInProgress) return;
  if (pointer) clearDrag();
  if (inlineDraft) finishInlineDraft();
  if (!undoStack.length) return;
  redoStack.push(snapshot()); doc = JSON.parse(undoStack.pop());
  if (!findNode(doc, selectedId)) selectedId = getRoot(doc).id;
  render(); updateControls();
}
function redo() {
  if (openInProgress) return;
  if (pointer) clearDrag();
  if (inlineDraft) finishInlineDraft();
  if (!redoStack.length) return;
  undoStack.push(snapshot()); doc = JSON.parse(redoStack.pop());
  if (!findNode(doc, selectedId)) selectedId = getRoot(doc).id;
  render(); updateControls();
}

function card(node) {
  const el = document.createElement('div');
  el.className = 'node' + (isRoot(node.id) ? ' root-node' : '') + (sameId(node.id, selectedId) ? ' selected' : '');
  if (inlineDraft && sameId(node.id, inlineDraft.id)) {
    el.classList.add('editing');
    const input = document.createElement('textarea');
    input.className = 'inline-node-input';
    input.value = inlineDraft.value;
    input.rows = 2;
    input.setAttribute('aria-label', 'ノードの文字を編集');
    input.placeholder = '文字を入力';
    input.addEventListener('pointerdown', event => event.stopPropagation());
    input.addEventListener('dblclick', event => event.stopPropagation());
    input.addEventListener('wheel', event => event.stopPropagation());
    input.addEventListener('input', () => { if (inlineDraft) inlineDraft.value = input.value; });
    input.addEventListener('compositionstart', () => { if (inlineDraft) inlineDraft.composing = true; });
    input.addEventListener('compositionend', () => { if (inlineDraft) inlineDraft.composing = false; });
    input.addEventListener('keydown', event => {
      event.stopPropagation();
      if (event.isComposing || event.keyCode === 229 || inlineDraft?.composing) return;
      if (event.key === 'Escape') { event.preventDefault(); cancelInlineDraft(); }
      else if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); finishInlineDraft(); }
      else if (event.key === 'Tab') { event.preventDefault(); finishInlineDraft(); }
    });
    input.addEventListener('blur', () => { if (inlineDraft) finishInlineDraft(); });
    el.appendChild(input);
  } else {
    el.textContent = node.title || '（空のノード）';
  }
  el.title = isRoot(node.id) ? '中心ノード' : 'ドラッグして枝を移動';
  if (!inlineDraft || !sameId(node.id, inlineDraft.id)) {
    el.setAttribute('role', 'button'); el.setAttribute('aria-label', node.title || '空のノード');
  }
  el._nodeId = node.id;
  el.addEventListener('pointerdown', onNodeDown);
  el.addEventListener('dblclick', event => { event.stopPropagation(); choose(node.id); openDialog('edit'); });
  nodesLayer.appendChild(el);
  return el;
}
function render() {
  nodesLayer.replaceChildren(); lines.replaceChildren();
  $('empty').hidden = !!doc;
  $('empty').style.display = doc ? 'none' : '';
  if (!doc) return;
  const root = getRoot(doc), records = new Map();
  // Reserve screen-space for sibling insertion targets while a branch is dragged.
  // This affects only the temporary drawing; no stored positions are changed.
  function gapFor(node, side) {
    return pointer?.moved && sameId(node.id, pointer.reorderParentId) &&
      (node !== root || side === pointer.reorderSide)
      ? Math.max(V_GAP, 68 / scale) : V_GAP;
  }
  function build(node, side, depth, parent = null) {
    const el = card(node), rec = { node, side, depth, parent, el, children: [], h: el.offsetHeight };
    records.set(String(node.id), rec);
    rec.children = children(node).map(entry => build(entry.node, depth === 0 ? entry.side : side, depth + 1, rec));
    rec.block = Math.max(rec.h, rec.children.reduce((s, c) => s + c.block, 0) + Math.max(0, rec.children.length - 1) * gapFor(node, side));
    return rec;
  }
  const tree = build(root, 'right', 0);
  tree.x = 0; tree.y = 0;
  function place(rec, top) {
    rec.x = (rec.side === 'left' ? -1 : 1) * rec.depth * (CARD_WIDTH + LEVEL_GAP);
    rec.y = top + rec.block / 2;
    const gap = gapFor(rec.node, rec.side);
    let y = top + (rec.block - (rec.children.reduce((s, c) => s + c.block, 0) + Math.max(0, rec.children.length - 1) * gap)) / 2;
    for (const child of rec.children) { place(child, y); y += child.block + gap; }
  }
  for (const side of ['left', 'right']) {
    const group = tree.children.filter(c => c.side === side);
    const gap = gapFor(root, side);
    const height = group.reduce((s, c) => s + c.block, 0) + Math.max(0, group.length - 1) * gap;
    let y = -height / 2;
    for (const rec of group) { place(rec, y); y += rec.block + gap; }
  }
  bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const rec of records.values()) {
    rec.el.style.left = `${rec.x - CARD_WIDTH / 2}px`; rec.el.style.top = `${rec.y - rec.h / 2}px`;
    bounds.minX = Math.min(bounds.minX, rec.x - CARD_WIDTH / 2); bounds.maxX = Math.max(bounds.maxX, rec.x + CARD_WIDTH / 2);
    bounds.minY = Math.min(bounds.minY, rec.y - rec.h / 2); bounds.maxY = Math.max(bounds.maxY, rec.y + rec.h / 2);
    if (rec.parent) {
      const sign = rec.side === 'left' ? -1 : 1;
      const x1 = rec.parent.x + sign * CARD_WIDTH / 2, x2 = rec.x - sign * CARD_WIDTH / 2, mid = (x1 + x2) / 2;
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', `M ${x1} ${rec.parent.y} C ${mid} ${rec.parent.y}, ${mid} ${rec.y}, ${x2} ${rec.y}`);
      path.setAttribute('stroke', rec.side === 'left' ? '#aac9b4' : '#88b99e'); path.setAttribute('stroke-width', '2'); path.setAttribute('fill', 'none');
      lines.appendChild(path);
    }
  }
  setTransform();
}
function fit() {
  if (!doc || !bounds) return;
  const w = canvas.clientWidth, h = canvas.clientHeight, margin = 70;
  scale = Math.max(.1, Math.min(1, (w - margin * 2) / Math.max(1, bounds.maxX - bounds.minX), (h - margin * 2) / Math.max(1, bounds.maxY - bounds.minY)));
  panX = w / 2 - (bounds.minX + bounds.maxX) / 2 * scale;
  panY = h / 2 - (bounds.minY + bounds.maxY) / 2 * scale;
  setTransform();
}
function zoom(factor, cx = canvas.clientWidth / 2, cy = canvas.clientHeight / 2) {
  const next = Math.min(2, Math.max(.1, scale * factor));
  panX = cx - (cx - panX) * next / scale; panY = cy - (cy - panY) * next / scale; scale = next; setTransform();
}

// During a drag, move the map when the pointer remains near the canvas edge.
// The animation belongs to a specific pointer state and never edits the map.
let dragPanFrameId = null;
let dragPanLastTime = null;
const DRAG_PAN_EDGE = 48, DRAG_PAN_SPEED = 360, DRAG_PAN_MIN_VISIBLE = 36;
function stopDragPan() {
  if (dragPanFrameId !== null) cancelAnimationFrame(dragPanFrameId);
  dragPanFrameId = null;
  dragPanLastTime = null;
}
function dragPanVelocity(value, low, high) {
  const edge = Math.min(DRAG_PAN_EDGE, (high - low) / 4);
  if (edge <= 0 || value < low || value > high) return 0;
  if (value < low + edge) return DRAG_PAN_SPEED * (low + edge - value) / edge;
  if (value > high - edge) return -DRAG_PAN_SPEED * (value - high + edge) / edge;
  return 0;
}
function dragPanDirection(state) {
  if (!state || pointer !== state || state.type !== 'node' || !state.moved) return null;
  const view = canvas.getBoundingClientRect(), {lastX: x, lastY: y} = state;
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < view.left || x > view.right || y < view.top || y > view.bottom) return null;
  const point = document.elementFromPoint(x, y);
  // Don't pan while hovering the floating toolbar or any other control.
  if (!point || !canvas.contains(point)) return null;
  const vx = dragPanVelocity(x, view.left, view.right);
  const vy = dragPanVelocity(y, view.top, view.bottom);
  return vx || vy ? {vx, vy, view} : null;
}
function dragPanClamped(current, delta, min, max) {
  // If the user had already panned beyond the limits, never jump their view.
  if (delta < 0 && current <= min || delta > 0 && current >= max) return current;
  if (current < min || current > max) return current + delta;
  return Math.max(min, Math.min(max, current + delta));
}
function scheduleDragPan() {
  if (dragPanFrameId !== null || !dragPanDirection(pointer)) return;
  const state = pointer;
  dragPanFrameId = requestAnimationFrame(time => {
    dragPanFrameId = null;
    if (pointer !== state) return;
    const direction = dragPanDirection(state);
    if (!direction || !bounds) { dragPanLastTime = null; return; }
    if (dragPanLastTime !== null && time - dragPanLastTime < 30) { scheduleDragPan(); return; }
    const dt = dragPanLastTime === null ? 0 : Math.min(0.05, Math.max(0, (time - dragPanLastTime) / 1000));
    dragPanLastTime = time;
    const margin = DRAG_PAN_MIN_VISIBLE, view = direction.view;
    const nextX = dragPanClamped(panX, direction.vx * dt, margin - bounds.maxX * scale, view.width - margin - bounds.minX * scale);
    const nextY = dragPanClamped(panY, direction.vy * dt, margin - bounds.maxY * scale, view.height - margin - bounds.minY * scale);
    if (nextX !== panX || nextY !== panY) {
      panX = nextX; panY = nextY; setTransform();
      for (const zone of state.reorderZones || []) zone.remove();
      state.reorderZones = [];
      showReorderZones();
      updateDragHover(state.lastX, state.lastY);
    }
    else if (dt > 0) { dragPanLastTime = null; return; }
    if (pointer === state) scheduleDragPan();
  });
}

function clearDrop() {
  for (const el of nodesLayer.children) el.classList.remove('drop-child', 'drop-before', 'drop-after', 'drop-invalid', 'dragging');
  for (const zone of pointer?.reorderZones || []) zone.classList.remove('active');
  drop = null;
}
function clearDrag() {
  stopDragPan();
  const restoreLayout = pointer?.moved && pointer?.reorderParentId != null;
  pointer?.ghost?.remove();
  for (const zone of pointer?.reorderZones || []) zone.remove();
  pointer = null;
  canvas.classList.remove('is-panning');
  clearDrop();
  if (restoreLayout) render();
  updateControls();
}
function isWithinBranch(node, targetId) {
  return sameId(node.id, targetId) || children(node).some(entry => isWithinBranch(entry.node, targetId));
}
function dragTarget(x, y) {
  const view = canvas.getBoundingClientRect();
  if (x < view.left || x > view.right || y < view.top || y > view.bottom) return null;
  const point = document.elementFromPoint(x, y);
  if (!point) return null;
  const zone = point?.closest('.reorder-zone');
  if (zone && pointer.reorderZones?.includes(zone)) {
    const el = Array.from(nodesLayer.children).find(item => sameId(item._nodeId, zone._targetId));
    if (el) return { el, kind: zone._kind, zone };
  }
  // An actual node always means “make it a child”, even at its edges.
  const hit = point?.closest('.node');
  if (hit && nodesLayer.contains(hit)) {
    const rect = hit.getBoundingClientRect();
    if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) return { el: hit, kind: 'child' };
  }
  // The canvas can be covered by the toolbar or other controls.  Do not
  // interpret a drop on those controls as a drop on the map underneath.
  if (!canvas.contains(point)) return null;
  // Keep sibling reordering available in a small gap immediately outside a card.
  let best = null;
  for (const el of nodesLayer.children) {
    if (sameId(el._nodeId, pointer.id) || isRoot(el._nodeId)) continue;
    const rect = el.getBoundingClientRect();
    if (x < rect.left || x > rect.right) continue;
    const before = rect.top - y, after = y - rect.bottom;
    const distance = before >= 0 ? before : after >= 0 ? after : Infinity;
    if (distance <= 9 && (!best || distance < best.distance)) {
      best = { el, kind: before >= 0 ? 'before' : 'after', distance };
    }
  }
  // On blank canvas, allow the *visible drag preview* to be dropped onto a
  // node even if the mouse pointer is just outside it.  Require substantial
  // overlap of both rectangles, and never guess between multiple matches.
  const dragged = findNode(doc, pointer.id);
  const original = infoFor(pointer.id);
  const preview = pointer.ghost?.getBoundingClientRect();
  if (!dragged || !original || !preview || preview.width <= 0 || preview.height <= 0) return null;
  const candidates = [];
  for (const el of nodesLayer.children) {
    const target = findNode(doc, el._nodeId);
    if (!target || isWithinBranch(dragged, target.id) || target === original.parent) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    const left = Math.max(preview.left, rect.left, view.left);
    const right = Math.min(preview.right, rect.right, view.right);
    const top = Math.max(preview.top, rect.top, view.top);
    const bottom = Math.min(preview.bottom, rect.bottom, view.bottom);
    const area = Math.max(0, right - left) * Math.max(0, bottom - top);
    if (area < rect.width * rect.height * 0.5 || area < preview.width * preview.height * 0.5) continue;
    // Ignore a node hidden by a toolbar or another element at its centre.
    const cx = (Math.max(rect.left, view.left) + Math.min(rect.right, view.right)) / 2;
    const cy = (Math.max(rect.top, view.top) + Math.min(rect.bottom, view.bottom)) / 2;
    const visible = document.elementFromPoint(cx, cy);
    if (!visible || !el.contains(visible)) continue;
    candidates.push(el);
    if (candidates.length > 1) return null;
  }
  return candidates.length === 1 ? { el: candidates[0], kind: 'child', overlap: true } : best;
}

function showReorderZones() {
  const branch = infoFor(pointer.id);
  if (!branch?.parent) return;
  const view = canvas.getBoundingClientRect();
  const sideSiblings = children(branch.parent).filter(entry =>
    !isRoot(branch.parent.id) || entry.side === branch.side);
  const originIndex = sideSiblings.findIndex(entry => sameId(entry.node.id, pointer.id));
  const siblings = sideSiblings.filter(entry => !sameId(entry.node.id, pointer.id));
  const nodeElements = Array.from(nodesLayer.children);
  const rects = nodeElements.map(el => el.getBoundingClientRect());
  pointer.reorderZones = [];
  for (const [siblingIndex, sibling] of siblings.entries()) {
    const el = nodeElements.find(item => sameId(item._nodeId, sibling.node.id));
    if (!el) continue;
    const rect = el.getBoundingClientRect();
    for (const kind of ['before', 'after']) {
      // Returning to the original order is represented by the original node's
      // placeholder, so don't add duplicate no-op targets around siblings.
      const isOrigin = originIndex >= 0 && siblingIndex + (kind === 'after' ? 1 : 0) === originIndex;
      if (isOrigin) continue;
      const top = kind === 'before' ? rect.top - 32 : rect.bottom + 4;
      const bottom = top + 28;
      // Never cover a node: its entire visible box remains a child drop target.
      if (top < view.top || bottom > view.bottom || rect.right <= view.left || rect.left >= view.right ||
          rects.some(r => rect.left < r.right && rect.right > r.left && top < r.bottom && bottom > r.top)) continue;
      const zone = document.createElement('div');
      zone.className = 'reorder-zone';
      zone.textContent = rect.width >= 70 ? 'ここに挿入' : '＋';
      zone.title = kind === 'before' ? 'このノードの前に挿入' : 'このノードの後に挿入';
      zone._targetId = sibling.node.id; zone._kind = kind;
      zone.style.left = `${Math.max(view.left, rect.left)}px`;
      zone.style.top = `${top}px`;
      zone.style.width = `${Math.min(view.right, rect.right) - Math.max(view.left, rect.left)}px`;
      zone.style.height = '28px';
      canvas.appendChild(zone);
      pointer.reorderZones.push(zone);
    }
  }
}
function onNodeDown(event) {
  if (event.button !== 0 || !doc || openInProgress) return;
  event.stopPropagation();
  let el = event.currentTarget;
  if (inlineDraft) {
    const id = el._nodeId;
    finishInlineDraft();
    // Finishing the draft re-renders the map; find the replacement element.
    el = Array.from(nodesLayer.children).find(item => sameId(item._nodeId, id));
    if (!el) return;
  }
  canvas.focus({ preventScroll: true });
  choose(el._nodeId);
  const rect = el.getBoundingClientRect();
  const info = infoFor(el._nodeId);
  pointer = { type: 'node', id: el._nodeId, el, startX: event.clientX, startY: event.clientY,
    offsetX: event.clientX - rect.left, offsetY: event.clientY - rect.top, moved: false, ghost: null,
    reorderParentId: info?.parent?.id ?? null, reorderSide: info?.side };
}
canvas.addEventListener('pointerdown', event => {
  if (event.button !== 0 || !doc || event.target.closest('.node')) return;
  pointer = { type: 'pan', startX: event.clientX, startY: event.clientY, x: panX, y: panY };
  canvas.classList.add('is-panning');
});
window.addEventListener('pointermove', event => {
  if (!pointer) return;
  if (pointer.type === 'pan') { panX = pointer.x + event.clientX - pointer.startX; panY = pointer.y + event.clientY - pointer.startY; setTransform(); return; }
  if (readOnly() || isRoot(pointer.id)) return;
  if (Math.hypot(event.clientX - pointer.startX, event.clientY - pointer.startY) < 5 && !pointer.moved) return;
  if (!pointer.moved) {
    pointer.ghost = document.createElement('div');
    pointer.ghost.className = 'node drag-ghost';
    pointer.ghost.textContent = findNode(doc, pointer.id)?.title || '（空のノード）';
    pointer.ghost.style.transform = `scale(${scale})`;
    document.body.appendChild(pointer.ghost);
    pointer.moved = true;
    if (pointer.reorderParentId != null) {
      render();
      pointer.el = Array.from(nodesLayer.children).find(item => sameId(item._nodeId, pointer.id));
      // Keep the original node's measured height so branches do not jump
      // after replacing its visible contents with a single placeholder.
      pointer.el.style.height = `${pointer.el.offsetHeight}px`;
      pointer.el.textContent = '元の位置';
      pointer.el.title = '元の位置（ここで離すと変更しません）';
      pointer.el.setAttribute('aria-label', '元の位置');
      showReorderZones();
    }
  }
  pointer.moved = true;
  pointer.lastX = event.clientX; pointer.lastY = event.clientY;
  updateDragHover(event.clientX, event.clientY);
  if (dragPanDirection(pointer)) scheduleDragPan(); else stopDragPan();
});
function updateDragHover(x, y) {
  clearDrop(); pointer.el.classList.add('dragging');
  pointer.overOriginal = false;
  pointer.ghost.style.left = `${x - pointer.offsetX}px`;
  pointer.ghost.style.top = `${y - pointer.offsetY}px`;
  $('hint').textContent = 'ノードに重ねると子に移動 ・「ここに挿入」で順序を変更 ・ Escで中止';
  const hit = dragTarget(x, y);
  if (!hit) return;
  const { el, kind } = hit;
  hit.zone?.classList.add('active');
  const rect = el.getBoundingClientRect(), target = infoFor(el._nodeId);
  if (!target) return;
  const dragged = findNode(doc, pointer.id);
  if (dragged && sameId(dragged.id, target.node.id)) {
    pointer.overOriginal = true;
    $('hint').textContent = '元の位置です';
    return;
  }
  if (!dragged || isWithinBranch(dragged, target.node.id)) {
    el.classList.add('drop-invalid');
    $('hint').textContent = '自分自身やその子孫には移動できません';
    return;
  }
  let side = target.side;
  if (isRoot(target.node.id)) side = x < rect.left + rect.width / 2 ? 'left' : 'right';
  drop = { targetId: target.node.id, kind, side };
  el.classList.add(`drop-${kind}`);
}
window.addEventListener('pointerup', () => {
  if (!pointer) return;
  const current = pointer, destination = drop;
  clearDrag();
  if (current.type !== 'node' || !current.moved) return;
  if (!destination) {
    if (!current.overOriginal) notice('移動先を選べませんでした。ノードまたは挿入枠に重ねてください。');
    return;
  }
  const target = infoFor(destination.targetId);
  if (!target) return;
  const parent = destination.kind === 'child' ? target.node : target.parent;
  if (!parent) return;
  const original = infoFor(current.id);
  if (destination.kind === 'child' && original?.parent === parent && (!isRoot(parent.id) || original.side === destination.side)) {
    notice('すでにこのノードの子になっています。');
    return;
  }
  const side = isRoot(parent.id) ? (destination.kind === 'child' ? destination.side : target.side) : target.side;
  const peers = children(parent).filter(entry => (!isRoot(parent.id) || entry.side === side) && !sameId(entry.node.id, current.id));
  const index = destination.kind === 'child' ? peers.length : Math.max(0, peers.findIndex(entry => sameId(entry.node.id, target.node.id))) + (destination.kind === 'after' ? 1 : 0);
  if (destination.kind !== 'child' && original?.parent === parent && original.side === side) {
    const oldIndex = children(parent).filter(entry => !isRoot(parent.id) || entry.side === side)
      .findIndex(entry => sameId(entry.node.id, current.id));
    if (index === oldIndex) return;
  }
  mutate(() => moveNode(doc, current.id, parent.id, index, side));
});
window.addEventListener('pointercancel', clearDrag);
window.addEventListener('blur', () => { if (pointer) clearDrag(); });
window.addEventListener('resize', () => { if (pointer?.type === 'node' && pointer.moved) clearDrag(); });
canvas.addEventListener('wheel', event => {
  if (!doc) return;
  if (pointer?.type === 'node' && pointer.moved) { event.preventDefault(); return; }
  event.preventDefault(); const rect = canvas.getBoundingClientRect();
  zoom(event.deltaY < 0 ? 1.12 : 1 / 1.12, event.clientX - rect.left, event.clientY - rect.top);
}, { passive: false });

function showInlineDraft() {
  const input = nodesLayer.querySelector('.inline-node-input');
  if (!input) return;
  const viewRect = canvas.getBoundingClientRect();
  const nodeRect = input.closest('.node').getBoundingClientRect();
  const padding = 24;
  if (nodeRect.left < viewRect.left + padding) panX += viewRect.left + padding - nodeRect.left;
  else if (nodeRect.right > viewRect.right - padding) panX -= nodeRect.right - (viewRect.right - padding);
  if (nodeRect.top < viewRect.top + padding) panY += viewRect.top + padding - nodeRect.top;
  else if (nodeRect.bottom > viewRect.bottom - padding) panY -= nodeRect.bottom - (viewRect.bottom - padding);
  setTransform();
  input.focus({ preventScroll: true });
}
function beginInlineDraft(kind) {
  if (openInProgress) return;
  if (readOnly()) { notice('未対応のノード間リンクがあるため編集できません。'); return; }
  if (inlineDraft) finishInlineDraft();
  const current = selection(); if (!current || (kind === 'sibling' && isRoot(current.id))) return;
  const before = snapshot(), previousId = selectedId;
  try {
    const info = infoFor(current.id);
    let added;
    if (kind === 'edit') {
      added = current;
    } else if (kind === 'child') {
      added = addNode(doc, current.id, '', info?.side || 'right');
    } else {
      const parent = info.parent, side = info.side;
      const peers = children(parent).filter(entry => !isRoot(parent.id) || entry.side === side);
      const index = peers.findIndex(entry => sameId(entry.node.id, current.id)) + 1;
      added = addNode(doc, parent.id, '', side);
      moveNode(doc, added.id, parent.id, index, side);
    }
    selectedId = added.id;
    inlineDraft = { id: added.id, value: kind === 'edit' ? added.title : '', before, previousId, composing: false };
    render(); updateControls(); showInlineDraft();
    $('hint').textContent = 'Enterで確定 ・ Shift+Enterで改行 ・ Escで取り消し';
  } catch (error) {
    inlineDraft = null; doc = JSON.parse(before); selectedId = previousId;
    render(); updateControls(); notice(error.message || 'ノードを追加できませんでした。');
  }
}
function finishInlineDraft() {
  if (!inlineDraft) return;
  const draft = inlineDraft;
  const input = nodesLayer.querySelector('.inline-node-input');
  if (input) draft.value = input.value;
  inlineDraft = null;
  try {
    setTitle(doc, draft.id, draft.value);
    if (snapshot() !== draft.before) {
      undoStack.push(draft.before); if (undoStack.length > 100) undoStack.shift(); redoStack = [];
    }
    render(); updateControls(); canvas.focus({ preventScroll: true });
  } catch (error) {
    doc = JSON.parse(draft.before); selectedId = draft.previousId;
    render(); updateControls(); notice(error.message || 'ノードを追加できませんでした。');
  }
}
function cancelInlineDraft() {
  if (!inlineDraft) return;
  const draft = inlineDraft; inlineDraft = null;
  doc = JSON.parse(draft.before); selectedId = draft.previousId;
  render(); updateControls(); canvas.focus({ preventScroll: true });
}
function openDialog(kind) {
  if (readOnly()) { notice('未対応のノード間リンクがあるため編集できません。'); return; }
  beginInlineDraft(kind);
}
$('edit-dialog').querySelector('form').addEventListener('submit', event => {
  event.preventDefault();
  if (!dialogAction) return;
  const action = dialogAction, title = $('title-input').value;
  $('edit-dialog').close(); dialogAction = null;
  if (action.kind === 'edit') { mutate(() => setTitle(doc, action.id, title)); return; }
  if (action.kind === 'child') {
    const current = infoFor(action.id), side = current?.side || 'right';
    const added = mutate(() => addNode(doc, action.id, title, side));
    if (added) { choose(added.id); }
    return;
  }
  const current = infoFor(action.id); if (!current?.parent) return;
  const parentId = current.parent.id, side = current.side;
  const peers = children(current.parent).filter(entry => !isRoot(parentId) || entry.side === side);
  const index = peers.findIndex(entry => sameId(entry.node.id, action.id)) + 1;
  const added = mutate(() => { const node = addNode(doc, parentId, title, side); moveNode(doc, node.id, parentId, index, side); return node; });
  if (added) choose(added.id);
});
for (const id of ['close-dialog', 'cancel-dialog']) $(id).addEventListener('click', () => { dialogAction = null; $('edit-dialog').close(); });
function removeSelected() {
  if (readOnly() || openInProgress) return;
  const node = selection(); if (!node || isRoot(node.id)) return;
  const info = infoFor(node.id), count = (function count(n) { return 1 + children(n).reduce((s, c) => s + count(c.node), 0); })(node);
  if (!confirm(count > 1 ? `このノードと、その下の ${count - 1} 個のノードを削除しますか？` : 'このノードを削除しますか？')) return;
  const parentId = info.parent.id;
  if (mutate(() => deleteNode(doc, node.id))) choose(parentId);
}

function editingState() {
  return JSON.stringify({ document: doc, draft: inlineDraft ? { id: inlineDraft.id, value: inlineDraft.value } : null });
}
async function loadFile(file, handle = null, request = null) {
  const text = await file.text();
  const loaded = parseMap(text);
  // A slow picker or Drive read must not silently discard edits made meanwhile.
  if (request && (request.sequence !== openSequence || request.before !== editingState())) {
    if (request.sequence === openSequence) saveProblem('読み込み中にマップが変更されたため、ファイルの切り替えを中止しました。編集内容を保存してから開き直してください。');
    return false;
  }
  // Any drag started while reading still references the previous map's DOM.
  if (pointer) clearDrag();
  doc = loaded; filename = file.name; selectedId = getRoot(doc).id;
  activeFileHandle = handle;
  fileRevision = handle ? { text, size: file.size, lastModified: file.lastModified } : null;
  savedSnapshot = snapshot(); undoStack = []; redoStack = [];
  render(); updateControls(); requestAnimationFrame(fit);
  if (readOnly()) notice('未対応のノード間リンクがあるため、このファイルは閲覧のみです。');
  else notice('ファイルを開きました。');
  return true;
}
async function openFilePicker() {
  if (saveInProgress || openInProgress) return;
  if (pointer) clearDrag();
  if (inlineDraft) finishInlineDraft();
  if (dirty() && !confirm('未保存の変更があります。別のファイルを開きますか？')) return;
  const request = { sequence: ++openSequence, before: editingState() };
  function useFallback() {
    pendingFallback = request;
    $('file').value = ''; $('file').click();
  }
  if (typeof window.showOpenFilePicker === 'function') {
    openInProgress = true; updateControls();
    try {
      // No extension filter: existing MindMup files may have no extension.
      let handles;
      try { handles = await window.showOpenFilePicker({ multiple: false }); }
      catch (error) {
        if (error?.name === 'AbortError') return;
        if (error?.name === 'SecurityError' || error?.name === 'NotAllowedError') {
          notice('この画面では別名保存用の方法でファイルを開きます。');
          useFallback(); return;
        }
        throw error;
      }
      if (!handles?.length) return;
      await loadFile(await handles[0].getFile(), handles[0], request);
    } catch (error) {
      if (error?.name === 'AbortError') return;
      notice(error?.message || 'ファイルを開けませんでした。');
    } finally {
      openInProgress = false; updateControls();
    }
    return;
  }
  useFallback();
}
for (const id of ['open', 'open-empty']) $(id).addEventListener('click', openFilePicker);
$('file').addEventListener('change', async event => {
  const file = event.target.files?.[0]; if (!file) return;
  const request = pendingFallback; pendingFallback = null;
  if (!request || request.sequence !== openSequence || openInProgress || saveInProgress) return;
  openInProgress = true; updateControls();
  try {
    await loadFile(file, null, request);
  } catch (error) { notice(error.message || 'ファイルを開けませんでした。'); }
  finally { openInProgress = false; updateControls(); }
});
function saveProblem(message) {
  notice(message);
  if (typeof window.alert === 'function') window.alert(message);
}
async function overwriteFile() {
  if (!doc || saveInProgress || openInProgress || readOnly()) return;
  if (!activeFileHandle || !fileRevision) {
    notice('上書き保存には、対応ブラウザでファイルを開き直してください。');
    return;
  }
  if (pointer) clearDrag();
  if (inlineDraft) finishInlineDraft();
  const handle = activeFileHandle, expected = fileRevision;
  // Capture what will actually be written; edits made during async I/O remain unsaved.
  const writtenSnapshot = snapshot(), text = serializeMap(doc);
  saveInProgress = true; updateControls();
  let writable = null;
  try {
    const permission = await handle.requestPermission({ mode: 'readwrite' });
    if (permission !== 'granted') {
      saveProblem('書き込みが許可されなかったため、上書きできません。別名で保存も利用できます。');
      return;
    }
    const current = await handle.getFile(), currentText = await current.text();
    if (currentText !== expected.text || current.size !== expected.size || current.lastModified !== expected.lastModified) {
      saveProblem('ファイルが外部で変更されたため、上書きを中止しました。必要なら別名で保存し、元ファイルを確認してください。');
      return;
    }
    writable = await handle.createWritable();
    await writable.write(text);
    // Staged writes are not committed until close. Recheck immediately before
    // that commit so another editor's changes during write are not discarded.
    const beforeClose = await handle.getFile(), beforeCloseText = await beforeClose.text();
    if (beforeCloseText !== expected.text || beforeClose.size !== expected.size || beforeClose.lastModified !== expected.lastModified) {
      if (typeof writable.abort === 'function') await writable.abort();
      writable = null;
      saveProblem('保存中にファイルが外部で変更されたため、上書きを中止しました。必要なら別名で保存し、元ファイルを確認してください。');
      return;
    }
    await writable.close();
    writable = null;
    const writtenFile = await handle.getFile(), actual = await writtenFile.text();
    if (actual !== text) throw new Error('保存後の内容を確認できませんでした。');
    fileRevision = { text: actual, size: writtenFile.size, lastModified: writtenFile.lastModified };
    savedSnapshot = writtenSnapshot;
    notice(dirty() ? '上書き保存しました。保存後の変更は未保存です。' : '上書き保存しました。');
  } catch (error) {
    if (writable && typeof writable.abort === 'function') { try { await writable.abort(); } catch {} }
    if (error?.name !== 'AbortError') saveProblem('上書き保存を完了できませんでした。保存先を確認するか、別名で保存してください。');
    else notice('上書き保存を取り消しました。');
  } finally {
    saveInProgress = false; updateControls();
  }
}
$('overwrite').addEventListener('click', overwriteFile);
$('save').addEventListener('click', () => {
  if (!doc || saveInProgress || openInProgress) return;
  if (inlineDraft) finishInlineDraft();
  const text = serializeMap(doc), blob = new Blob([text], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob), link = document.createElement('a');
  const base = filename.replace(/\.(mup|json)$/i, '');
  link.href = url; link.download = `${base}_編集済み.mup`; document.body.appendChild(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  updateControls(); notice('別名ファイルのダウンロードを開始しました。保存先を確認してください。');
});
$('add-child').addEventListener('click', () => openDialog('child'));
$('add-sibling').addEventListener('click', () => openDialog('sibling'));
$('edit').addEventListener('click', () => openDialog('edit'));
$('delete').addEventListener('click', removeSelected);
$('undo').addEventListener('click', undo); $('redo').addEventListener('click', redo);
$('zoom-in').addEventListener('click', () => zoom(1.2)); $('zoom-out').addEventListener('click', () => zoom(1 / 1.2)); $('fit').addEventListener('click', fit);
window.addEventListener('beforeunload', event => { if (dirty()) { event.preventDefault(); event.returnValue = ''; } });
window.addEventListener('keydown', event => {
  if (event.key === 'Escape' && pointer) { event.preventDefault(); clearDrag(); return; }
  if (event.isComposing || $('edit-dialog').open || !doc || openInProgress) return;
  const meta = event.ctrlKey || event.metaKey;
  if (meta && event.key.toLowerCase() === 'z') { event.preventDefault(); event.shiftKey ? redo() : undo(); }
  else if (meta && event.key.toLowerCase() === 'y') { event.preventDefault(); redo(); }
  else if (event.target === canvas && !meta && event.key === 'Tab') { event.preventDefault(); openDialog('child'); }
  else if (event.target === canvas && !meta && event.key === 'Enter') { event.preventDefault(); openDialog('sibling'); }
  else if (event.target === canvas && !meta && (event.key === 'Delete' || event.key === 'Backspace')) { event.preventDefault(); removeSelected(); }
});
updateControls();
