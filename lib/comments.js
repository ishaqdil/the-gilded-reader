// Comment tree building + @mention parsing for the unified comment system.
// buildTree expects rows ordered oldest-first, each row carrying:
//   id, parent_id, body, created_at, score, userVote (precomputed by the caller),
//   user_id (or uid), username, avatar, and optionally edited.
const MAX_DEPTH = 6;

// Depth counting: a top-level comment is depth 1. Replies deeper than
// MAX_DEPTH are attached to their nearest ancestor at depth MAX_DEPTH
// (which then sits at depth MAX_DEPTH itself).
function buildTree(rows) {
  const byId = new Map();
  const parentOf = new Map();
  const roots = [];

  for (const r of rows) {
    const node = {
      id: r.id,
      body: r.body,
      created_at: r.created_at,
      score: Number(r.score) || 0,
      userVote: Number(r.userVote) || 0,
      user: {
        id: r.user_id !== undefined ? r.user_id : r.uid,
        username: r.username,
        avatar: r.avatar === undefined ? null : r.avatar,
      },
      replies: [],
    };
    if (r.edited !== undefined) node.edited = !!r.edited;
    // depth: effective position in the tree (top-level = 1).
    // parentEntry: the entry this node was actually attached to, which may
    // differ from the row's parent_id when the depth cap re-attached it.
    byId.set(r.id, { node, depth: 1, parentEntry: null });
    parentOf.set(r.id, r.parent_id);
  }

  for (const [id, entry] of byId) {
    const rowParentId = parentOf.get(id);
    // Cycle guard: if this entry is reachable from its anchor via effective
    // parents, attaching would create a circular tree (only possible via
    // manual DB tampering — the API requires the parent to exist first).
    const createsCycle = (anchorEntry) => {
      let cur = anchorEntry;
      const seenUp = new Set();
      while (cur && !seenUp.has(cur)) {
        if (cur === entry) return true;
        seenUp.add(cur);
        cur = cur.parentEntry;
      }
      return false;
    };
    if (rowParentId && rowParentId !== id && byId.has(rowParentId) && !createsCycle(byId.get(rowParentId))) {
      let anchor = byId.get(rowParentId);
      let depth = anchor.depth + 1;
      // Climb the *effective* parent chain until the node would sit at
      // depth <= MAX_DEPTH. Guarded against corrupt cycles.
      const seen = new Set([entry]);
      while (depth > MAX_DEPTH && anchor.parentEntry && !seen.has(anchor.parentEntry)) {
        anchor = anchor.parentEntry;
        seen.add(anchor);
        depth = anchor.depth + 1;
      }
      anchor.node.replies.push(entry.node);
      entry.depth = Math.min(depth, MAX_DEPTH);
      entry.parentEntry = anchor;
    } else {
      // No parent, self-parent, or parent missing/hidden (orphan) -> top level.
      roots.push(entry.node);
      entry.depth = 1;
      entry.parentEntry = null;
    }
  }

  return roots;
}

const MENTION_RE = /@([A-Za-z0-9_]{3,24})/g;

// Unique usernames mentioned via @name, in order of first appearance.
function parseMentions(text) {
  const seen = new Set();
  const out = [];
  if (typeof text !== 'string') return out;
  MENTION_RE.lastIndex = 0;
  let m;
  while ((m = MENTION_RE.exec(text)) !== null) {
    if (!seen.has(m[1])) {
      seen.add(m[1]);
      out.push(m[1]);
    }
  }
  return out;
}

module.exports = { buildTree, parseMentions, MAX_DEPTH };
