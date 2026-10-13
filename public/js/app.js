/* The Gilded Cage — client JS. No frameworks, no inline scripts (CSP-safe). */
(function () {
  'use strict';

  var root = document.documentElement;

  /* ---------- Theme: dark default, persisted in localStorage 'tgc-theme' ---------- */
  try {
    var saved = localStorage.getItem('tgc-theme');
    root.setAttribute('data-theme', (saved === 'dark' || saved === 'light') ? saved : 'dark');
  } catch (e) {
    root.setAttribute('data-theme', 'dark');
  }
  var themeBtn = document.getElementById('themeBtn');
  if (themeBtn) {
    var syncThemeLabel = function () {
      var dark = root.getAttribute('data-theme') !== 'light';
      themeBtn.setAttribute('aria-label', dark ? 'Switch to light mode' : 'Switch to dark mode');
    };
    syncThemeLabel();
    themeBtn.addEventListener('click', function () {
      var next = root.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
      root.setAttribute('data-theme', next);
      try { localStorage.setItem('tgc-theme', next); } catch (e) {}
      syncThemeLabel();
    });
  }

  /* ---------- Session context ---------- */
  var csrfMeta = document.querySelector('meta[name="csrf-token"]');
  var csrfToken = csrfMeta ? csrfMeta.getAttribute('content') : null;
  var loggedIn = !!csrfToken;
  var profileBtn = document.getElementById('profileBtn');
  var myUsername = profileBtn ? profileBtn.getAttribute('data-username') : null;
  var isAdmin = document.body.getAttribute('data-is-admin') === '1';

  /* ---------- Profile dropdown ---------- */
  var profileMenu = document.getElementById('profileMenu');
  if (profileBtn && profileMenu) {
    var closeMenu = function () {
      profileMenu.hidden = true;
      profileBtn.setAttribute('aria-expanded', 'false');
    };
    profileBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      var willOpen = profileMenu.hidden;
      if (willOpen) {
        profileMenu.hidden = false;
        profileBtn.setAttribute('aria-expanded', 'true');
      } else {
        closeMenu();
      }
    });
    document.addEventListener('click', function (e) {
      if (!profileMenu.hidden && !e.target.closest('.profile-menu')) closeMenu();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !profileMenu.hidden) { closeMenu(); profileBtn.focus(); }
    });
  }

  /* ---------- Footer year ---------- */
  var year = document.getElementById('year');
  if (year) year.textContent = new Date().getFullYear();

  /* ---------- Toasts ---------- */
  var toastWrap = document.getElementById('toastWrap');
  window.toast = function (msg, isError) {
    if (!toastWrap) return;
    var t = document.createElement('div');
    t.className = 'toast' + (isError ? ' error' : '');
    t.textContent = msg;
    toastWrap.appendChild(t);
    setTimeout(function () { t.remove(); }, 4200);
  };
  try {
    var params = new URLSearchParams(location.search);
    if (params.get('ok')) { toast('Done.'); history.replaceState(null, '', location.pathname + location.hash); }
  } catch (e) {}

  /* ---------- Confirm dialogs for destructive forms ---------- */
  document.querySelectorAll('form[data-confirm]').forEach(function (form) {
    form.addEventListener('submit', function (e) {
      if (!window.confirm(form.getAttribute('data-confirm'))) e.preventDefault();
    });
  });

  /* ---------- Reading progress ---------- */
  var progressFill = document.getElementById('readProgress');
  var reader = document.querySelector('.reader');
  if (progressFill && reader) {
    var update = function () {
      var r = reader.getBoundingClientRect();
      var total = r.height - window.innerHeight + r.top;
      var done = Math.min(Math.max(-r.top, 0), Math.max(total, 1));
      progressFill.style.width = (total > 0 ? (done / total) * 100 : 0).toFixed(1) + '%';
    };
    document.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    update();
  }

  /* ---------- JSON API helper ---------- */
  function api(method, url, data) {
    return fetch(url, {
      method: method,
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrfToken || '' },
      body: data ? JSON.stringify(data) : undefined,
    }).then(function (res) {
      return res.json().catch(function () { return { ok: false, error: 'Request failed.' }; }).then(function (json) {
        if (!res.ok || !json.ok) throw new Error((json && json.error) || 'Request failed.');
        return json;
      });
    });
  }

  function requireLogin() {
    if (loggedIn) return true;
    toast('Please log in first.', true);
    window.location.href = '/login?next=' + encodeURIComponent(location.pathname + location.hash);
    return false;
  }

  /* ---------- DOM helpers (textContent only — XSS-safe) ---------- */
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function smallBtn(label, cls) {
    var b = el('button', 'btn btn-sm ' + (cls || 'btn-ghost'), label);
    b.type = 'button';
    return b;
  }
  function fmtTime(iso) {
    try {
      return new Date(iso + 'Z').toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    } catch (e) { return ''; }
  }

  var AVATAR_EMOJI = { lantern: '🪔', key: '🔑', rose: '🌹', crown: '👑', dove: '🕊️', moon: '🌙', door: '🚪', mask: '🎭' };
  function avatarFor(name) { return AVATAR_EMOJI[name] || AVATAR_EMOJI.lantern; }

  /* ---------- Voting (delegated: works for server-rendered + thread-rendered widgets) ---------- */
  document.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-vote]');
    if (!btn) return;
    e.preventDefault();
    if (!requireLogin()) return;
    var type = btn.getAttribute('data-vote');
    var id = Number(btn.getAttribute('data-id'));
    var value = Number(btn.getAttribute('data-value'));
    if (!id || (value !== 1 && value !== -1)) return;
    var widget = btn.closest('[data-vote-widget]');
    btn.disabled = true;
    api('POST', '/api/vote', { target_type: type, target_id: id, value: value })
      .then(function (json) {
        if (widget) {
          var scoreEl = widget.querySelector('.vote-score');
          if (scoreEl) scoreEl.textContent = json.score;
          widget.querySelectorAll('[data-vote]').forEach(function (b) {
            b.setAttribute('aria-pressed', String(Number(b.getAttribute('data-value')) === json.userVote));
          });
        }
      })
      .catch(function (err) { toast(err.message, true); })
      .then(function () { btn.disabled = false; });
  });

  /* ---------- Comment threads ---------- */
  function makeVoteWidget(targetType, id, score, userVote) {
    var w = el('div', 'vote vote-compact');
    w.setAttribute('data-vote-widget', '');
    var svgUp = '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M8 3.2 13.4 11H2.6Z" fill="currentColor"/></svg>';
    var svgDown = '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M8 12.8 2.6 5h10.8Z" fill="currentColor"/></svg>';
    var up = el('button', 'vote-btn vote-up');
    up.type = 'button';
    up.setAttribute('data-vote', targetType);
    up.setAttribute('data-id', String(id));
    up.setAttribute('data-value', '1');
    up.setAttribute('aria-pressed', userVote === 1 ? 'true' : 'false');
    up.setAttribute('aria-label', 'Upvote');
    up.innerHTML = svgUp;
    var sc = el('span', 'vote-score', String(score));
    var down = el('button', 'vote-btn vote-down');
    down.type = 'button';
    down.setAttribute('data-vote', targetType);
    down.setAttribute('data-id', String(id));
    down.setAttribute('data-value', '-1');
    down.setAttribute('aria-pressed', userVote === -1 ? 'true' : 'false');
    down.setAttribute('aria-label', 'Downvote');
    down.innerHTML = svgDown;
    w.appendChild(up); w.appendChild(sc); w.appendChild(down);
    return w;
  }

  function renderComment(node) {
    var wrap = el('article', 'comment');
    wrap.setAttribute('data-comment-id', String(node.id));
    var head = el('div', 'comment-head');
    var uname = (node.user && node.user.username) || 'unknown';

    if (node.replies && node.replies.length) {
      var coll = el('button', 'collapse-btn', '–');
      coll.type = 'button';
      coll.setAttribute('aria-expanded', 'true');
      coll.setAttribute('aria-label', 'Collapse replies');
      head.appendChild(coll);
    }
    var av = el('span', 'avatar avatar-xs', avatarFor(node.user && node.user.avatar));
    av.setAttribute('role', 'img');
    av.setAttribute('aria-label', 'avatar');
    head.appendChild(av);
    var ulink = el('a', 'comment-user', uname);
    ulink.href = '/u/' + encodeURIComponent(uname);
    head.appendChild(ulink);
    var t = el('time', 'comment-time muted', fmtTime(node.created_at));
    if (node.created_at) t.setAttribute('datetime', node.created_at);
    head.appendChild(t);
    wrap.appendChild(head);
    wrap.appendChild(el('p', 'comment-body', node.body));

    var actions = el('div', 'comment-actions');
    actions.appendChild(makeVoteWidget('comment', node.id, node.score || 0, node.userVote || 0));
    var mine = loggedIn && myUsername && uname === myUsername;
    if (loggedIn) {
      var replyBtn = smallBtn('Reply');
      replyBtn.setAttribute('aria-label', 'Reply to ' + uname);
      replyBtn.addEventListener('click', function () { toggleReplyForm(wrap, node); });
      actions.appendChild(replyBtn);
    }
    if (mine) {
      var editBtn = smallBtn('Edit');
      editBtn.addEventListener('click', function () { startEdit(wrap, node); });
      actions.appendChild(editBtn);
    }
    if (mine || isAdmin) {
      var delBtn = smallBtn('Delete', 'btn-danger-ghost');
      delBtn.addEventListener('click', function () {
        if (!window.confirm('Delete this comment?')) return;
        api('DELETE', '/api/comments/' + node.id)
          .then(function () { toast('Comment deleted.'); loadThread(wrap.closest('[data-thread]')); })
          .catch(function (err) { toast(err.message, true); });
      });
      actions.appendChild(delBtn);
    }
    if (loggedIn && !mine) {
      var repBtn = smallBtn('Report');
      repBtn.addEventListener('click', function () {
        var reason = window.prompt('Why are you reporting this comment? (optional)');
        if (reason === null) return;
        api('POST', '/api/reports', { target_type: 'comment', target_id: node.id, reason: reason })
          .then(function () { toast('Reported. Thanks for flagging.'); })
          .catch(function (err) { toast(err.message, true); });
      });
      actions.appendChild(repBtn);
    }
    wrap.appendChild(actions);

    if (node.replies && node.replies.length) {
      var rc = el('div', 'replies');
      node.replies.forEach(function (r) { rc.appendChild(renderComment(r)); });
      wrap.appendChild(rc);
      coll.addEventListener('click', function () {
        var collapsed = !rc.hasAttribute('hidden');
        if (collapsed) {
          rc.setAttribute('hidden', '');
          coll.textContent = '+';
          coll.setAttribute('aria-expanded', 'false');
          coll.setAttribute('aria-label', 'Expand replies');
        } else {
          rc.removeAttribute('hidden');
          coll.textContent = '–';
          coll.setAttribute('aria-expanded', 'true');
          coll.setAttribute('aria-label', 'Collapse replies');
        }
      });
    }
    return wrap;
  }

  function toggleReplyForm(wrap, node) {
    var existing = wrap.querySelector(':scope > .reply-form');
    if (existing) { existing.remove(); return; }
    if (!requireLogin()) return;
    var form = el('form', 'comment-form reply-form');
    var ta = el('textarea');
    ta.rows = 2; ta.maxLength = 2000; ta.required = true;
    ta.placeholder = 'Write a reply…';
    ta.id = 'reply-' + node.id;
    var label = el('label', 'sr-only', 'Write a reply');
    label.setAttribute('for', ta.id);
    var row = el('div', 'form-row');
    var spacer = el('span');
    var cancel = smallBtn('Cancel');
    cancel.addEventListener('click', function () { form.remove(); });
    var submit = el('button', 'btn btn-primary btn-sm', 'Reply');
    submit.type = 'submit';
    row.appendChild(spacer); row.appendChild(cancel); row.appendChild(submit);
    form.appendChild(label); form.appendChild(ta); form.appendChild(row);
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var body = ta.value.trim();
      if (!body) return;
      var box = wrap.closest('[data-thread]');
      submit.disabled = true;
      api('POST', '/api/thread/' + encodeURIComponent(box.getAttribute('data-thread')) + '/' + encodeURIComponent(box.getAttribute('data-id')) + '/comments', { parent_id: node.id, body: body })
        .then(function () { toast('Reply posted.'); loadThread(box); })
        .catch(function (err) { toast(err.message, true); submit.disabled = false; });
    });
    wrap.appendChild(form);
    ta.focus();
  }

  function startEdit(wrap, node) {
    if (wrap.querySelector(':scope > .edit-form')) return;
    var bodyP = wrap.querySelector(':scope > .comment-body');
    var form = el('form', 'comment-form edit-form');
    var ta = el('textarea');
    ta.rows = 3; ta.maxLength = 2000; ta.required = true;
    ta.value = node.body;
    ta.id = 'edit-' + node.id;
    var label = el('label', 'sr-only', 'Edit comment');
    label.setAttribute('for', ta.id);
    var row = el('div', 'form-row');
    var spacer = el('span');
    var cancel = smallBtn('Cancel');
    var save = el('button', 'btn btn-primary btn-sm', 'Save');
    save.type = 'submit';
    row.appendChild(spacer); row.appendChild(cancel); row.appendChild(save);
    form.appendChild(label); form.appendChild(ta); form.appendChild(row);
    cancel.addEventListener('click', function () { form.remove(); bodyP.style.display = ''; });
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var body = ta.value.trim();
      if (!body) { toast('Comment cannot be empty.', true); return; }
      save.disabled = true;
      api('PUT', '/api/comments/' + node.id, { body: body })
        .then(function () { toast('Comment updated.'); loadThread(wrap.closest('[data-thread]')); })
        .catch(function (err) { toast(err.message, true); save.disabled = false; });
    });
    bodyP.style.display = 'none';
    wrap.insertBefore(form, bodyP.nextSibling);
    ta.focus();
  }

  function loadThread(box) {
    if (!box) return;
    var type = box.getAttribute('data-thread');
    var id = box.getAttribute('data-id');
    box.innerHTML = '';
    var loading = el('div', 'loading', null);
    loading.setAttribute('role', 'status');
    loading.appendChild(el('span', 'spinner'));
    loading.appendChild(el('span', null, 'Loading comments…'));
    box.appendChild(loading);
    fetch('/api/thread/' + encodeURIComponent(type) + '/' + encodeURIComponent(id) + '/comments', { credentials: 'same-origin' })
      .then(function (res) { return res.json().catch(function () { return { ok: false }; }); })
      .then(function (json) {
        box.innerHTML = '';
        if (!json.ok || !json.comments || !json.comments.length) {
          var empty = el('div', 'empty-state empty-inline');
          empty.appendChild(el('p', 'empty-icon', '💬'));
          empty.appendChild(el('p', 'muted', 'No comments yet — be the first to share your thoughts.'));
          box.appendChild(empty);
          return;
        }
        var list = el('div', 'comment-list');
        json.comments.forEach(function (c) { list.appendChild(renderComment(c)); });
        box.appendChild(list);
      })
      .catch(function () {
        box.innerHTML = '';
        var errBox = el('div', 'empty-state empty-inline');
        errBox.appendChild(el('p', 'muted', 'Could not load comments. Check your connection and try again.'));
        var retry = el('button', 'btn btn-ghost btn-sm', 'Retry');
        retry.type = 'button';
        retry.addEventListener('click', function () { loadThread(box); });
        errBox.appendChild(retry);
        box.appendChild(errBox);
      });
  }

  function initThread(box) {
    var count = Number(box.getAttribute('data-count') || '0');
    box.innerHTML = '';
    var btn = el('button', 'btn btn-ghost btn-block',
      count > 0 ? ('Show ' + count + ' comment' + (count === 1 ? '' : 's')) : 'Start the discussion');
    btn.type = 'button';
    btn.addEventListener('click', function () { loadThread(box); });
    box.appendChild(btn);
    if (window.location.hash === '#comments') loadThread(box);
  }
  document.querySelectorAll('[data-thread]').forEach(initThread);

  /* ---------- Top-level comment forms ---------- */
  document.querySelectorAll('form[data-comment-form]').forEach(function (form) {
    var type = form.getAttribute('data-thread-type');
    var id = form.getAttribute('data-thread-id');
    var ta = form.querySelector('textarea');
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (!requireLogin()) return;
      var body = ta.value.trim();
      if (!body) { toast('Write something first.', true); return; }
      var submit = form.querySelector('[type="submit"]');
      if (submit) submit.disabled = true;
      api('POST', '/api/thread/' + encodeURIComponent(type) + '/' + encodeURIComponent(id) + '/comments', { body: body })
        .then(function () {
          ta.value = '';
          toast('Comment posted.');
          var box = document.querySelector('[data-thread="' + type + '"][data-id="' + id + '"]');
          if (box) loadThread(box);
        })
        .catch(function (err) { toast(err.message, true); })
        .then(function () { if (submit) submit.disabled = false; });
    });
  });

  /* ---------- New post (community page) ---------- */
  var newPostToggle = document.getElementById('newPostToggle');
  var newPostCard = document.getElementById('newPostCard');
  if (newPostToggle && newPostCard) {
    newPostToggle.setAttribute('aria-expanded', 'false');
    newPostToggle.setAttribute('aria-controls', 'newPostCard');
    newPostToggle.addEventListener('click', function () {
      var willShow = newPostCard.hidden;
      newPostCard.hidden = !willShow;
      newPostToggle.setAttribute('aria-expanded', String(willShow));
      if (willShow) { var t = document.getElementById('postTitle'); if (t) t.focus(); }
    });
  }
  var newPostForm = document.getElementById('newPostForm');
  if (newPostForm) {
    newPostForm.addEventListener('submit', function (e) {
      e.preventDefault();
      if (!requireLogin()) return;
      var fd = new FormData(newPostForm);
      var communityId = Number(fd.get('community_id'));
      var ptitle = String(fd.get('title') || '').trim();
      var pbody = String(fd.get('body') || '').trim();
      if (!communityId) { toast('Community is missing. Please reload the page.', true); return; }
      if (!ptitle || !pbody) { toast('Title and body are required.', true); return; }
      var submit = newPostForm.querySelector('[type="submit"]');
      if (submit) submit.disabled = true;
      api('POST', '/api/posts', { community_id: communityId, title: ptitle, body: pbody })
        .then(function (json) {
          toast('Post published.');
          window.location.href = json.url || (json.id ? '/p/' + json.id : window.location.pathname);
        })
        .catch(function (err) { toast(err.message, true); if (submit) submit.disabled = false; });
    });
  }

  /* ---------- Post edit / delete / report (post page) ---------- */
  var postEditToggle = document.getElementById('postEditToggle');
  var postEditForm = document.getElementById('postEditForm');
  if (postEditToggle && postEditForm) {
    postEditToggle.addEventListener('click', function () {
      var willShow = postEditForm.hidden;
      postEditForm.hidden = !willShow;
      postEditToggle.setAttribute('aria-expanded', String(willShow));
    });
    var postEditCancel = document.getElementById('postEditCancel');
    if (postEditCancel) postEditCancel.addEventListener('click', function () { postEditForm.hidden = true; });
    postEditForm.addEventListener('submit', function (e) {
      e.preventDefault();
      var pid = postEditForm.getAttribute('data-post-id');
      var fd = new FormData(postEditForm);
      var ptitle = String(fd.get('title') || '').trim();
      var pbody = String(fd.get('body') || '').trim();
      if (!ptitle || !pbody) { toast('Title and body are required.', true); return; }
      api('PUT', '/api/posts/' + encodeURIComponent(pid), { title: ptitle, body: pbody })
        .then(function () { toast('Post updated.'); window.location.reload(); })
        .catch(function (err) { toast(err.message, true); });
    });
  }
  var postDelete = document.getElementById('postDelete');
  if (postDelete) {
    postDelete.addEventListener('click', function () {
      if (!window.confirm('Delete this post? This cannot be undone.')) return;
      api('DELETE', '/api/posts/' + encodeURIComponent(postDelete.getAttribute('data-post-id')))
        .then(function () { window.location.href = '/'; })
        .catch(function (err) { toast(err.message, true); });
    });
  }
  var postReport = document.getElementById('postReport');
  if (postReport) {
    postReport.addEventListener('click', function () {
      var reason = window.prompt('Why are you reporting this post? (optional)');
      if (reason === null) return;
      api('POST', '/api/reports', { target_type: 'post', target_id: Number(postReport.getAttribute('data-post-id')), reason: reason })
        .then(function () { toast('Reported. Thanks for flagging.'); })
        .catch(function (err) { toast(err.message, true); });
    });
  }

  /* ---------- Notifications: mark all read ---------- */
  var markAllRead = document.getElementById('markAllRead');
  if (markAllRead) {
    markAllRead.addEventListener('click', function () {
      markAllRead.disabled = true;
      api('POST', '/api/notifications/read', { all: true })
        .then(function () {
          document.querySelectorAll('.notif.unread').forEach(function (n) { n.classList.remove('unread'); });
          toast('All caught up.');
        })
        .catch(function (err) { toast(err.message, true); markAllRead.disabled = false; });
    });
  }

  /* ---------- Character counters ---------- */
  document.querySelectorAll('textarea[data-autocount]').forEach(function (ta) {
    var target = document.getElementById(ta.getAttribute('data-autocount'));
    if (!target) return;
    var update = function () { target.textContent = String(ta.value.length); };
    ta.addEventListener('input', update);
    update();
  });
})();
