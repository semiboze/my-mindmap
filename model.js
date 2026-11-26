/** MindMup v3 document model. Unrecognised data stays in the original object. */
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function parseMap(text) {
  let doc;
  try { doc = JSON.parse(text); }
  catch { throw new Error('ファイルをJSONとして読み取れませんでした。'); }
  if (!isObject(doc) || doc.formatVersion !== 3 || !isObject(doc.ideas)) {
    throw new Error('形式バージョン3のMindMupファイルではありません。');
  }
  const roots = Object.values(doc.ideas);
  if (roots.length !== 1) throw new Error('中心ノードが1つのマップにのみ対応しています。');
  const ids = new Set();
  function validate(node) {
    if (!isObject(node) || !['string', 'number'].includes(typeof node.id) || typeof node.title !== 'string') {
      throw new Error('ノードのIDまたは文字列を読み取れません。');
    }
    const id = String(node.id);
    if (ids.has(id)) throw new Error('同じIDを持つノードが複数あります。');
    ids.add(id);
    if (node.ideas !== undefined) {
      if (!isObject(node.ideas)) throw new Error('枝の情報が正しくありません。');
      const ranks = new Set();
      for (const [key, child] of Object.entries(node.ideas)) {
        const rank = Number(key);
        if (!Number.isFinite(rank) || rank === 0 || ranks.has(rank)) throw new Error('枝の順序情報が正しくありません。');
        ranks.add(rank);
        validate(child);
      }
    }
  }
  validate(roots[0]);
  return doc;
}

export const serializeMap = doc => JSON.stringify(doc, null, 2);
export const getRoot = doc => Object.values(doc.ideas)[0];

/** Siblings in top-to-bottom order. Side on deeper nodes is inherited by the view. */
export function children(node) {
  return Object.entries(node.ideas || {}).map(([rank, child]) => ({
    node: child, rank, side: Number(rank) < 0 ? 'left' : 'right'
  })).sort((a, b) => Math.abs(Number(a.rank)) - Math.abs(Number(b.rank)));
}

function locate(doc, id) {
  const target = String(id);
  let found = null;
  function visit(node, parent = null, rank = null) {
    if (String(node.id) === target) { found = { node, parent, rank }; return; }
    for (const [childRank, child] of Object.entries(node.ideas || {})) {
      if (!found) visit(child, node, childRank);
    }
  }
  visit(getRoot(doc));
  return found;
}

export function findNode(doc, id) { return locate(doc, id)?.node ?? null; }
function requireNode(doc, id) {
  const item = locate(doc, id);
  if (!item) throw new Error('対象のノードが見つかりません。');
  return item;
}

function assertEditable(doc) {
  // Non-empty cross-links can refer to deleted or moved IDs. Their semantics
  // are outside this editor's tested support, so don't silently damage them.
  if (doc.links !== undefined && (!Array.isArray(doc.links) || doc.links.length)) {
    throw new Error('このファイルには未対応のノード間リンクがあるため編集できません。');
  }
}

function freshId(doc) {
  const prefix = 'local-' + Date.now().toString(36) + '-';
  let counter = 0, id;
  do { id = prefix + (++counter).toString(36); } while (findNode(doc, id));
  return id;
}

function insert(parent, child, index, side, root) {
  if (parent.ideas === undefined) parent.ideas = {};
  const sign = parent === root && side === 'left' ? -1 : 1;
  const peers = children(parent).filter(item => (Number(item.rank) < 0 ? -1 : 1) === sign);
  const i = Math.max(0, Math.min(Number.isInteger(index) ? index : peers.length, peers.length));
  const before = i ? Math.abs(Number(peers[i - 1].rank)) : 0;
  const after = i < peers.length ? Math.abs(Number(peers[i].rank)) : null;
  let rank = after === null ? before + 1 : before + (after - before) / 2;
  // Extremely dense floats are exceptional; preserve order by spacing these
  // siblings again, while retaining all node objects and their other data.
  if (!Number.isFinite(rank) || rank <= before || (after !== null && rank >= after)) {
    for (const peer of peers) delete parent.ideas[peer.rank];
    const ordered = peers.map(peer => peer.node);
    ordered.splice(i, 0, child);
    ordered.forEach((node, n) => { parent.ideas[String(sign * (n + 1))] = node; });
    return;
  }
  parent.ideas[String(sign * rank)] = child;
}

export function addNode(doc, parentId, title = '', side = 'right') {
  assertEditable(doc);
  if (typeof title !== 'string') throw new Error('文字列を入力してください。');
  const parent = requireNode(doc, parentId).node;
  const node = { id: freshId(doc), title };
  insert(parent, node, undefined, side, getRoot(doc));
  return node;
}

export function setTitle(doc, id, title) {
  assertEditable(doc);
  if (typeof title !== 'string') throw new Error('文字列を入力してください。');
  const node = requireNode(doc, id).node;
  node.title = title;
  return node;
}

export function deleteNode(doc, id) {
  assertEditable(doc);
  const item = requireNode(doc, id);
  if (!item.parent) throw new Error('中心ノードは削除できません。');
  delete item.parent.ideas[item.rank];
  return item.node;
}

/** index is the top-to-bottom insertion index on the target side after removal. */
export function moveNode(doc, id, parentId, index, side = 'right') {
  assertEditable(doc);
  const item = requireNode(doc, id);
  const parent = requireNode(doc, parentId).node;
  if (!item.parent) throw new Error('中心ノードは移動できません。');
  function contains(node, wanted) {
    return node === wanted || Object.values(node.ideas || {}).some(child => contains(child, wanted));
  }
  if (contains(item.node, parent)) throw new Error('自分自身や子孫の中には移動できません。');
  delete item.parent.ideas[item.rank];
  insert(parent, item.node, index, side, getRoot(doc));
  return item.node;
}
