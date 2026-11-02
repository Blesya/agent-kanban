/* agent-kanban frontend.
 * Multi-project (URL /p/{slug}, card links /p/{slug}/t/{id} and /t/{id}),
 * drag-drop, search+filter, collapsible cols, compact mode, quick-add,
 * keyboard shortcuts, polling /api/board every 10 s.
 */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const STATUS_TITLE = {
  backlog: "Backlog",
  approved: "Approved",
  analyst: "Analyst",
  in_progress: "In progress",
  testing: "Testing",
  uat: "UAT",
  done: "Done",
  blocked: "Blocked",
  cancelled: "Cancelled",
};

const LS = {
  DENSITY: "kb.density",
  SIDEBAR: "kb.sidebar",
  COLLAPSED_COLS: "kb.collapsedCols",
  EXPANDED_COLS: "kb.expandedCols",
  ARCHIVE_OPEN: "kb.archiveOpen",
  THEME: "kb.theme",
  PROFILE: "kb.profile",
  LAST_PROJECT: "kb.lastProject",
};

const PROFILES = ["standard", "cyberpunk", "horizon"];
const PROFILE_LABELS = {
  standard: "Standard",
  cyberpunk: "Cyberpunk",
  horizon:   "Horizon",
};

// ----------------------------------------------------------- State

const state = {
  projectId: null,                  // picked from URL or the first project
  project: null,                   // full metadata for the current project
  projects: [],                    // all projects (active + archived)
  board: { columns: [], tasks: {} },
  search: "",
  filters: new Set(),              // 'prio:high', 'blocked', 'assignee:claude', ...
  density: localStorage.getItem(LS.DENSITY) || "comfortable",
  theme: document.documentElement.getAttribute("data-theme") || "dark",
  sidebarCollapsed: localStorage.getItem(LS.SIDEBAR) === "collapsed",
  collapsedCols: _loadJSON(LS.COLLAPSED_COLS),
  expandedCols:  _loadJSON(LS.EXPANDED_COLS),
  isDragging: false,
  showArchived: false,             // include archived cards on the board
  tags: [],                        // tag vocabulary of the current project
  projSearch: "",                  // sidebar project filter
  projDragging: false,             // reorder in progress
  projDragEndedAt: 0,              // swallow the click that follows a drag
  automationPaused: false,
  modalTask: null,                 // task currently open in the modal
};

// Columns where "how long has it been sitting here" matters.
const AGE_COLUMNS = new Set(["approved", "analyst", "in_progress", "testing", "uat", "blocked"]);

function _loadJSON(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}
function saveCollapsed() {
  localStorage.setItem(LS.COLLAPSED_COLS, JSON.stringify(state.collapsedCols));
  localStorage.setItem(LS.EXPANDED_COLS, JSON.stringify(state.expandedCols));
}

// ----------------------------------------------------------- API

async function api(method, path, body) {
  const opts = { method, headers: { "Content-Type": "application/json" } };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const r = await fetch(path, opts);
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`HTTP ${r.status}: ${text}`);
  }
  if (r.status === 204) return null;
  return r.json();
}

// ----------------------------------------------------------- Toast

function toast(msg, kind = "info") {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.toggle("toast--err", kind === "err");
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.hidden = true; }, 2400);
}

// ----------------------------------------------------------- URL routing

function parseRoute() {
  const m = location.pathname.match(/^\/p\/([a-z][a-z0-9-]*)(?:\/t\/[^/]+)?\/?$/);
  return m ? m[1] : null;     // null = not picked yet, will fall back to first project
}

function parseTaskRoute() {
  const m = location.pathname.match(/^(?:\/p\/[a-z][a-z0-9-]*)?\/t\/([^/]+)\/?$/);
  return m ? decodeURIComponent(m[1]) : null;
}

function navigateTo(projectId, { replace = false } = {}) {
  const url = `/p/${projectId}`;
  if (replace) history.replaceState({ projectId }, "", url);
  else history.pushState({ projectId }, "", url);
  state.projectId = projectId;
  localStorage.setItem(LS.LAST_PROJECT, projectId);
}

// ----------------------------------------------------------- Helpers

function escapeHTML(s) {
  return String(s ?? "").replace(/[&<>"']/g, (m) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[m]);
}

function localTime(ts, withDate = true) {
  // History timestamps are UTC ISO strings; show them in the viewer's zone.
  const d = new Date(ts);
  if (isNaN(d)) return ts;
  const opts = { hour: "2-digit", minute: "2-digit" };
  if (withDate) Object.assign(opts, { day: "2-digit", month: "2-digit" });
  return d.toLocaleString(undefined, opts);
}

function ageLabel(ts) {
  const ms = Date.now() - new Date(ts).getTime();
  if (!(ms >= 0)) return "";
  const h = ms / 3600000;
  if (h < 1) return `${Math.max(1, Math.round(ms / 60000))}m`;
  if (h < 48) return `${Math.round(h)}h`;
  return `${Math.round(h / 24)}d`;
}

function ownerLabel(owner) {
  if (owner === "user") return "user";
  if (owner === "agent") return "agent";
  if (owner === "any") return "—";
  return "";
}

// ----------------------------------------------------------- Sidebar

function projectMatchesSearch(p) {
  const q = (state.projSearch || "").trim().toLowerCase();
  if (!q) return true;
  return `${p.name} ${p.id} ${p.path || ""}`.toLowerCase().includes(q);
}

function projIcon(p) {
  return (p.icon || p.name[0] || "?").toUpperCase().slice(0, 2);
}

function renderSidebar() {
  // A 10s poll must not replace the rows in the middle of a drag.
  if (state.projDragging) return;
  const openMenuFor = $("#proj-menu") && !$("#proj-menu").hidden ? projMenuProjectId : null;
  const list = $("#proj-list");
  list.innerHTML = "";
  const active = state.projects.filter(p => !p.archived && projectMatchesSearch(p));
  for (const p of active) list.appendChild(projectEl(p));
  // Keep an open actions menu attached to its row across the 10s re-render.
  if (openMenuFor) {
    const row = list.querySelector(`.proj[data-proj="${openMenuFor}"]`);
    const btn = row && row.querySelector(".proj__menu");
    if (btn) {
      row.classList.add("is-menu-open");
      positionProjMenu(btn);
    } else {
      closeProjMenu();
    }
  }

  const empty = $("#proj-empty");
  if (empty) {
    const q = (state.projSearch || "").trim();
    empty.textContent = q
      ? `No projects match “${q}”`
      : "No projects yet — press + to create one";
    empty.hidden = active.length > 0;
  }

  // archive section
  const archived = state.projects.filter(p => p.archived);
  const archiveBox = $("#proj-archive");
  if (archived.length === 0) {
    archiveBox.hidden = true;
  } else {
    archiveBox.hidden = false;
    $("#archive-count").textContent = archived.length;
    const archList = $("#proj-archive-list");
    archList.innerHTML = "";
    for (const p of archived) archList.appendChild(projectEl(p));
    const open = localStorage.getItem(LS.ARCHIVE_OPEN) === "1";
    archiveBox.classList.toggle("is-open", open);
    archList.hidden = !open;
  }

  // sidebar collapsed state
  $("#sidebar").classList.toggle("is-collapsed", state.sidebarCollapsed);
}

function projectEl(p) {
  const a = document.createElement("a");
  a.className = "proj";
  if (p.id === state.projectId) {
    a.classList.add("proj--active");
    a.setAttribute("aria-current", "page");
  }
  a.dataset.proj = p.id;
  a.href = `/p/${p.id}`;
  a.draggable = false;

  const counts = p.task_counts || {};
  const approved = counts.approved || 0;
  const blocked = counts.blocked || 0;
  const total = p.total_tasks || 0;
  // The total is only worth a badge when nothing more actionable is shown —
  // three badges in a 203px row squeeze the project name to four letters.
  const showTotal = !approved && !blocked;
  const tip = [`${total} active task${total === 1 ? "" : "s"}`];
  if (approved) tip.push(`${approved} approved`);
  if (blocked) tip.push(`${blocked} blocked`);
  if (p.path) tip.push(p.path);
  a.title = `${p.name} — ${tip.join(", ")}`;

  a.innerHTML = `
    <span class="proj__grip" aria-hidden="true">⠿</span>
    <span class="proj__mark" style="background:${escapeHTML(p.color)}">${escapeHTML(projIcon(p))}</span>
    ${approved || blocked ? `<span class="proj__dot${approved ? "" : " proj__dot--blocked"}" aria-hidden="true">${approved || blocked}</span>` : ""}
    <span class="proj__name">${escapeHTML(p.name)}</span>
    <span class="proj__badges">
      ${approved ? `<span class="badge badge--approved" title="${approved} approved — waiting for an agent">${approved}</span>` : ""}
      ${blocked ? `<span class="badge badge--blocked" title="${blocked} blocked">${blocked}</span>` : ""}
      ${showTotal ? `<span class="badge badge--total" title="${total} active task${total === 1 ? "" : "s"}">${total}</span>` : ""}
    </span>
    <button class="proj__menu" type="button" title="Project actions" aria-label="Project actions" aria-haspopup="menu">⋯</button>
  `;

  a.addEventListener("click", (e) => {
    // A drag just ended — do not navigate/open the card on the same click.
    if (Date.now() - (state.projDragEndedAt || 0) < 250) {
      e.preventDefault();
      return;
    }
    if (e.target.closest(".proj__menu")) {
      e.preventDefault();
      e.stopPropagation();
      openProjMenu(p, e.target.closest(".proj__menu"));
      return;
    }
    e.preventDefault();
    if (p.id === state.projectId) return;
    closeProjMenu();
    navigateTo(p.id);
    loadBoard();
    renderSidebar();
  });
  return a;
}

// --- project search -------------------------------------------------------

function onProjSearchInput(e) {
  state.projSearch = e.target.value;
  $("#btn-proj-search-clear").hidden = !e.target.value;
  renderSidebar();
}

function clearProjSearch() {
  state.projSearch = "";
  const input = $("#proj-search");
  input.value = "";
  $("#btn-proj-search-clear").hidden = true;
  renderSidebar();
  input.focus();
}

function moveProjFocus(delta) {
  const rows = $$("#proj-list .proj");
  if (!rows.length) return;
  const cur = rows.indexOf(document.activeElement);
  const next = cur < 0
    ? (delta > 0 ? 0 : rows.length - 1)
    : Math.min(rows.length - 1, Math.max(0, cur + delta));
  rows[next].focus();
}

// --- project actions menu -------------------------------------------------

const PROJ_MENU_ICONS = {
  rename: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>',
  archive: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8"/><path d="M10 12h4"/></svg>',
  restore: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/></svg>',
  connect: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M13.8 10.2a4 4 0 0 1 0 5.7l-2.8 2.8a4 4 0 0 1-5.7-5.7l1.6-1.6"/><path d="M10.2 13.8a4 4 0 0 1 0-5.7l2.8-2.8a4 4 0 0 1 5.7 5.7l-1.6 1.6"/></svg>',
  path: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 7V5a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v2"/><path d="M9 3v18h10a1 1 0 0 0 1-1v-4H9"/></svg>',
};

let projMenuProjectId = null;

function openProjMenu(p, btn) {
  const menu = $("#proj-menu");
  if (!menu) return;
  projMenuProjectId = p.id;
  const items = [
    { act: "rename", label: "Rename…", icon: "rename" },
    p.archived
      ? { act: "archive", label: "Restore to sidebar", icon: "restore" }
      : { act: "archive", label: "Archive project", icon: "archive", danger: true },
    { act: "connect", label: "Connect Claude Code", icon: "connect" },
    { act: "path", label: "Copy path", icon: "path", disabled: !p.path },
  ];
  menu.innerHTML = items.map(it => `<button class="pmi${it.danger ? " pmi--danger" : ""}" type="button"
      role="menuitem" data-act="${it.act}"${it.disabled ? " disabled" : ""}>
      ${PROJ_MENU_ICONS[it.icon] || ""}<span>${escapeHTML(it.label)}</span>
    </button>`).join("");
  menu.hidden = false;

  const row = btn.closest(".proj");
  if (row) row.classList.add("is-menu-open");
  positionProjMenu(btn);
}

function positionProjMenu(btn) {
  const menu = $("#proj-menu");
  if (!menu || menu.hidden) return;
  const r = btn.getBoundingClientRect();
  const w = menu.offsetWidth || 204;
  const h = menu.offsetHeight || 150;
  const left = Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8));
  const below = r.bottom + 4;
  menu.style.left = `${left}px`;
  menu.style.top = `${below + h > window.innerHeight - 8 ? Math.max(8, r.top - h - 4) : below}px`;
}

function closeProjMenu() {
  const menu = $("#proj-menu");
  projMenuProjectId = null;
  if (!menu || menu.hidden) return;
  menu.hidden = true;
  $$(".proj.is-menu-open").forEach(el => el.classList.remove("is-menu-open"));
}

async function runProjMenuAction(act, p) {
  if (act === "rename") {
    openEditProj(p);
    return;
  }
  if (act === "connect") {
    if (!p.path) {
      toast("Set the project directory first", "err");
      return;
    }
    try {
      await api("POST", `/api/projects/${encodeURIComponent(p.id)}/connect`, {});
      toast(`MCP config written for ${p.name}`);
    } catch (e) {
      toast(`Error: ${e.message}`, "err");
    }
    return;
  }
  if (act === "path") {
    try {
      await navigator.clipboard.writeText(p.path || "");
      toast("Path copied");
    } catch {
      toast(p.path || "");
    }
    return;
  }
  if (act === "archive") {
    const toArchive = !p.archived;
    if (toArchive && !confirm(`Archive project “${p.name}”? Its cards stay in the database.`)) return;
    try {
      await api("POST", `/api/projects/${encodeURIComponent(p.id)}/archive`, { archived: toArchive });
      toast(toArchive ? `${p.name} archived` : `${p.name} restored`);
      await loadProjects();
      if (toArchive && state.projectId === p.id) {
        const next = state.projects.find(x => !x.archived);
        if (next) {
          navigateTo(next.id);
          await loadBoard();
        }
      }
      renderSidebar();
    } catch (e) {
      toast(`Error: ${e.message}`, "err");
    }
  }
}

// --- sidebar drag-reorder -------------------------------------------------

function initProjSortable() {
  const list = $("#proj-list");
  if (!list || typeof Sortable === "undefined") return;
  Sortable.create(list, {
    animation: 120,
    draggable: ".proj",
    ghostClass: "sortable-ghost",
    onStart: () => {
      state.projDragging = true;
      closeProjMenu();
    },
    onEnd: async () => {
      state.projDragging = false;
      state.projDragEndedAt = Date.now();
      const ids = $$("#proj-list .proj").map(el => el.dataset.proj);
      await persistProjOrder(ids);
    },
  });
}

async function persistProjOrder(ids) {
  for (let i = 0; i < ids.length; i++) {
    const p = state.projects.find(x => x.id === ids[i]);
    if (!p || p.sort_order === i) continue;
    try {
      await api("PATCH", `/api/projects/${encodeURIComponent(p.id)}`, { sort_order: i });
    } catch (e) {
      toast(`Reorder failed: ${e.message}`, "err");
      break;
    }
  }
  await loadProjects();
}

// ----------------------------------------------------------- Board render

// Inline icons for the card (no emoji, no icon font, works offline).
const CARD_ICONS = {
  bug: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m8 2 1.88 1.88M14.12 3.88 16 2M9 7.13v-1a3.003 3.003 0 1 1 6 0v1"/><path d="M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3c0 3.3-2.7 6-6 6"/><path d="M12 20v-9"/><path d="M6.53 9C4.6 8.8 3 7.1 3 5"/><path d="M6 13H2"/><path d="M3 21c0-2.1 1.7-3.9 3.8-4"/><path d="M20.97 5c0 2.1-1.6 3.8-3.5 4"/><path d="M22 13h-4"/><path d="M17.2 17c2.1.1 3.8 1.9 3.8 4"/></svg>',
  arrow: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 15l7-7 7 7"/></svg>',
  alert: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 9v4m0 4h.01M10.3 3.9L2.4 17a2 2 0 001.7 3h15.8a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z"/></svg>',
  link: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13.8 10.2a4 4 0 010 5.7l-2.8 2.8a4 4 0 01-5.7-5.7l1.6-1.6"/><path d="M10.2 13.8a4 4 0 010-5.7l2.8-2.8a4 4 0 015.7 5.7l-1.6 1.6"/></svg>',
  clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
};

// Tags that mean "defect" — the card then shows a bug icon.
const BUG_TAGS = new Set(["bug", "bugs", "bugfix", "bug-fix", "defect", "regression"]);

function cardIsBug(t) {
  return (t.tags || []).some(tag => BUG_TAGS.has(tag) || tag.startsWith("bug"));
}

function actorInitials(who) {
  const s = String(who || "")
    .replace(/^agent:/, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
  if (!s) return "?";
  const parts = s.split(/\s+/);
  const raw = parts.length > 1 ? parts[0][0] + parts[1][0] : s.slice(0, 2);
  return raw.toUpperCase();
}

function actorTone(who) {
  const w = String(who || "");
  if (w === "user") return "card__avatar--user";
  if (w === "claude" || w.startsWith("agent:")) return "card__avatar--agent";
  return "";
}

function render(board) {
  state.board = board;
  if (board.project) {
    state.project = board.project;
    $("#topbar-title").textContent = board.project.name;
    $("#proj-mark").style.background = board.project.color;
    document.title = `Kanban — ${board.project.name}`;
  }
  const root = $("#board");
  root.innerHTML = "";
  let total = 0;
  let visible = 0;
  for (const col of board.columns) {
    const list = board.tasks[col.id] || [];
    total += list.length;
    const colEl = document.createElement("section");
    colEl.className = "col";
    colEl.dataset.status = col.id;
    if (isColEffectivelyCollapsed(col.id, list.length > 0)) {
      colEl.classList.add("is-collapsed");
    }
    colEl.innerHTML = `
      <header class="col__head">
        <span class="col__chevron">▾</span>
        <span class="col__title">${escapeHTML(col.title)}</span>
        <span class="col__count">${list.length}</span>
        <button class="col__quickadd" title="Quick add (n)" aria-label="Add">+</button>
      </header>
      <div class="col__list" data-status="${col.id}"></div>
    `;
    root.appendChild(colEl);
    const listEl = colEl.querySelector(".col__list");
    for (const t of list) {
      const card = cardEl(t);
      if (!matchesFilters(t)) card.classList.add("is-hidden");
      else visible++;
      listEl.appendChild(card);
    }
    Sortable.create(listEl, {
      group: "tasks",
      animation: 140,
      ghostClass: "sortable-ghost",
      chosenClass: "sortable-chosen",
      dragClass: "sortable-drag",
      onStart: () => { state.isDragging = true; },
      onEnd: handleDrop,
    });
    // col head click toggles collapse
    colEl.querySelector(".col__head").addEventListener("click", (e) => {
      if (e.target.closest(".col__quickadd")) return;
      toggleColCollapse(col.id, list.length > 0);
    });
    colEl.querySelector(".col__quickadd").addEventListener("click", (e) => {
      e.stopPropagation();
      // If the column is collapsed — expand first, then open quickadd
      if (colEl.classList.contains("is-collapsed")) {
        toggleColCollapse(col.id, list.length > 0);
        setTimeout(() => openQuickAdd(col.id, colEl), 220);
      } else {
        openQuickAdd(col.id, colEl);
      }
    });
  }
  // density
  root.classList.toggle("is-compact", state.density === "compact");
  // stats
  renderStats(visible, total);
}

function renderStats(visible, total) {
  const filterLabel = (state.search || state.filters.size > 0)
    ? `${visible} / ${total}` : `${total}`;
  const el = $("#stats");
  el.textContent = `${filterLabel} tasks`;
  const archived = state.board.archived_count || 0;
  if (archived || state.showArchived) {
    const a = document.createElement("button");
    a.className = "stats__archived";
    a.title = "Archived cards are hidden from the board; their status is kept";
    a.textContent = state.showArchived ? " · hide archived" : ` · ${archived} archived`;
    a.addEventListener("click", () => {
      state.showArchived = !state.showArchived;
      loadBoard();
    });
    el.appendChild(a);
  }
}

function cardEl(t) {
  const div = document.createElement("article");
  div.className = "card";
  if (t.priority === "high" || t.priority === "critical") div.classList.add("is-prio-high");
  if (t.archived_at) div.classList.add("is-archived");
  div.dataset.taskId = t.id;
  const running = (t.running || []).length > 0;
  const age = AGE_COLUMNS.has(t.status) && t.moved_at ? ageLabel(t.moved_at) : "";
  const tags = t.tags || [];
  const blockers = (t.blockers || []).length;
  const priorityChip =
    t.priority === "critical"
      ? `<span class="chip chip--prio chip--prio-critical">${CARD_ICONS.alert}CRIT</span>`
      : t.priority === "high"
        ? `<span class="chip chip--prio chip--prio-high">${CARD_ICONS.arrow}HIGH</span>`
        : "";
  const footCounters =
    (blockers ? `<span class="card__counter" title="Waits for ${blockers} blocker(s)">${CARD_ICONS.link}${blockers}</span>` : "") +
    (age ? `<span class="card__counter" title="In this column since ${escapeHTML(localTime(t.moved_at))}">${CARD_ICONS.clock}${age}</span>` : "");
  const footAvatar = t.assignee
    ? `<span class="card__avatar ${actorTone(t.assignee)}" title="Assigned to ${escapeHTML(t.assignee)}">${escapeHTML(actorInitials(t.assignee))}</span>`
    : "";
  const foot = footCounters || footAvatar
    ? `<div class="card__divider"></div>
       <div class="card__foot">
         <div class="card__counters">${footCounters}</div>
         <div class="card__right">${footAvatar}</div>
       </div>`
    : "";
  div.innerHTML = `
    <div class="card__head">
      ${cardIsBug(t) ? `<span class="card__type" title="Bug">${CARD_ICONS.bug}</span>` : ""}
      <span class="card__id">${escapeHTML(t.id)}</span>
      <span class="card__flags">
        ${running ? `<span class="chip chip--running" title="Running now: ${escapeHTML((t.running || []).join(", "))}">▶ agent</span>` : ""}
        ${t.archived_at ? `<span class="chip chip--age" title="Archived ${escapeHTML(localTime(t.archived_at))}">archived</span>` : ""}
      </span>
    </div>
    <h3 class="card__title">${escapeHTML(t.title)}</h3>
    <div class="card__chips">
      ${priorityChip}
      <span class="chip chip--size-${escapeHTML(t.size)}">${escapeHTML(t.size)}</span>
      ${tags.map(tag =>
        `<span class="chip chip--tag" data-tag="${escapeHTML(tag)}" title="Filter by #${escapeHTML(tag)}">#${escapeHTML(tag)}</span>`
      ).join("")}
    </div>
    ${t.external_blocker ? `<div class="card__meta"><span class="card__blocker" title="${escapeHTML(t.external_blocker)}">${escapeHTML(t.external_blocker)}</span></div>` : ""}
    ${foot}
  `;
  div.addEventListener("click", (e) => {
    const tagEl = e.target.closest(".chip--tag");
    if (tagEl) {
      e.stopPropagation();
      toggleFilter(`tag:${tagEl.dataset.tag}`);
      return;
    }
    if (state.isDragging) return;
    openTaskModal(t.id);
  });
  return div;
}

// ----------------------------------------------------------- Filters

function matchesFilters(t) {
  // search
  if (state.search) {
    const q = state.search.toLowerCase();
    const hay = `${t.id} ${t.title} ${(t.tags || []).join(" ")}`.toLowerCase();
    if (!hay.includes(q)) return false;
  }
  // filter chips
  for (const f of state.filters) {
    if (f === "prio:high" && t.priority !== "high") return false;
    if (f === "blocked" && !t.external_blocker) return false;
    if (f === "unassigned" && t.assignee) return false;
    if (f.startsWith("tag:")) {
      const want = f.slice("tag:".length);
      if (!(t.tags || []).includes(want)) return false;
    }
    if (f.startsWith("assignee:")) {
      const want = f.slice("assignee:".length);
      const have = t.assignee || "";
      if (want === "agent") {
        if (!(have === "claude" || have.startsWith("agent:"))) return false;
      } else if (have !== want) return false;
    }
  }
  return true;
}

function applyFilters() {
  // hide/unhide cards without a full re-render (faster)
  let visible = 0; let total = 0;
  for (const col of state.board.columns) {
    const tasks = state.board.tasks[col.id] || [];
    total += tasks.length;
    for (const t of tasks) {
      const card = $(`.card[data-task-id="${t.id}"]`);
      if (!card) continue;
      if (matchesFilters(t)) {
        card.classList.remove("is-hidden");
        visible++;
      } else {
        card.classList.add("is-hidden");
      }
    }
  }
  renderStats(visible, total);
}

// ----------------------------------------------------------- Collapsed columns
//
// "Effectively collapsed" logic:
//   - manually collapsed (in collapsedCols) → ALWAYS collapsed
//   - manually expanded (in expandedCols)   → ALWAYS expanded
//   - default: empty column → collapsed, non-empty → expanded
//
// This auto-collapses empty columns but still respects an explicit user choice
// (click on the header).

function isColEffectivelyCollapsed(colId, hasTasks) {
  const proj = state.projectId;
  const manualC = (state.collapsedCols[proj] || []).includes(colId);
  if (manualC) return true;
  const manualE = (state.expandedCols[proj] || []).includes(colId);
  if (manualE) return false;
  return !hasTasks;
}

function toggleColCollapse(colId, hasTasks) {
  const proj = state.projectId;
  const collapsedList = state.collapsedCols[proj] || [];
  const expandedList = state.expandedCols[proj] || [];
  const wasCollapsed = isColEffectivelyCollapsed(colId, hasTasks);

  // remove colId from both lists (for cleanliness)
  const cIdx = collapsedList.indexOf(colId);
  if (cIdx >= 0) collapsedList.splice(cIdx, 1);
  const eIdx = expandedList.indexOf(colId);
  if (eIdx >= 0) expandedList.splice(eIdx, 1);

  // add to the opposite list
  if (wasCollapsed) expandedList.push(colId);
  else              collapsedList.push(colId);

  state.collapsedCols[proj] = collapsedList;
  state.expandedCols[proj]  = expandedList;
  saveCollapsed();

  const colEl = $(`.col[data-status="${colId}"]`);
  if (colEl) colEl.classList.toggle("is-collapsed");
}

// ----------------------------------------------------------- Quick-add

function openQuickAdd(status, colEl) {
  // If a quickadd-form already exists — focus it
  let form = colEl.querySelector(".col__quickadd-form");
  if (form) { form.querySelector("input").focus(); return; }
  form = document.createElement("div");
  form.className = "col__quickadd-form";
  form.innerHTML = `<input type="text" placeholder="Title (Enter — create, Esc — cancel)" />`;
  const list = colEl.querySelector(".col__list");
  colEl.insertBefore(form, list);
  const input = form.querySelector("input");
  input.focus();
  input.addEventListener("keydown", async (e) => {
    if (e.key === "Enter") {
      const title = input.value.trim();
      if (!title) return;
      try {
        await api("POST", "/api/tasks", {
          title,
          status,
          priority: "normal",
          size: "M",
          project_id: state.projectId,
        });
        toast("Created");
        form.remove();
        await loadBoard();
        await loadProjects();
      } catch (err) {
        toast(`Error: ${err.message}`, "err");
      }
    } else if (e.key === "Escape") {
      form.remove();
    }
  });
  input.addEventListener("blur", () => {
    if (!input.value.trim()) form.remove();
  });
}

// ----------------------------------------------------------- Drag-drop

async function handleDrop(evt) {
  setTimeout(() => { state.isDragging = false; }, 80);
  const taskId = evt.item.dataset.taskId;
  const toStatus = evt.to.dataset.status;
  // newDraggableIndex is among non-hidden; we pass newIndex relative to all elements
  const newOrder = evt.newDraggableIndex;
  try {
    await api("POST", `/api/tasks/${taskId}/move`, {
      to_status: toStatus,
      column_order: newOrder,
    });
    toast(`${taskId} → ${STATUS_TITLE[toStatus] || toStatus}`);
    await loadBoard();
    await loadProjects();
  } catch (e) {
    toast(`Error: ${e.message}`, "err");
    await loadBoard();
  }
}

// ----------------------------------------------------------- Task modal

const HISTORY_LIMIT = 200;

async function openTaskModal(taskId) {
  let t;
  try {
    t = await api("GET", `/api/tasks/${encodeURIComponent(taskId)}?history_limit=${HISTORY_LIMIT}`);
  } catch (e) {
    toast(`Failed to load ${taskId}`, "err");
    return;
  }
  state.modalTask = t;
  $("#modal").dataset.taskId = t.id;
  $("#m-id").textContent = t.id;
  $("#m-id").title = "Copy link to this card";
  $("#m-status").textContent = (STATUS_TITLE[t.status] || t.status) + (t.archived_at ? " · archived" : "");
  $("#m-title").value = t.title || "";
  $("#m-priority").value = t.priority || "normal";
  $("#m-size").value = t.size || "M";
  $("#m-assignee").value = t.assignee || "";
  $("#m-description").value = t.description || "";
  $("#m-acceptance").value = t.acceptance || "";
  $("#m-blocker").value = t.external_blocker || "";
  tagPickerEdit.set(t.tags || []);
  $("#btn-archive-task").textContent = t.archived_at ? "Unarchive" : "Archive";
  renderLinks(t.links);
  renderHistory(t.history, t.history_total);
  $("#m-comment").value = "";
  $("#modal").hidden = false;
  history.replaceState(history.state, "", `/p/${t.project_id}/t/${encodeURIComponent(t.id)}`);
}

async function copyTaskLink() {
  const t = state.modalTask;
  if (!t) return;
  const url = `${location.origin}/p/${t.project_id}/t/${encodeURIComponent(t.id)}`;
  try {
    await navigator.clipboard.writeText(url);
    toast("Link copied");
  } catch {
    toast(url);
  }
}

async function toggleArchiveTask() {
  const t = state.modalTask;
  if (!t) return;
  try {
    await api("POST", `/api/tasks/${encodeURIComponent(t.id)}/archive`, { archived: !t.archived_at });
    toast(t.archived_at ? `${t.id} restored to the board` : `${t.id} archived`);
    closeModal();
    await loadBoard();
    await loadProjects();
  } catch (e) {
    toast(`Error: ${e.message}`, "err");
  }
}

function renderLinks(links) {
  const el = $("#m-links");
  el.innerHTML = "";
  for (const l of (links || [])) {
    const a = document.createElement("a");
    if (l.type === "url" || l.type === "pr") a.href = l.value;
    a.target = "_blank";
    a.rel = "noopener";
    a.innerHTML = `<span class="link-type">${l.type}</span>${escapeHTML(l.value)}`;
    el.appendChild(a);
  }
}

function renderHistory(history, total) {
  const el = $("#m-history");
  el.innerHTML = "";
  const hidden = (total || 0) - (history || []).length;
  if (hidden > 0) {
    const more = document.createElement("div");
    more.className = "h-row h-more";
    more.textContent = `${hidden} older entries not shown (GET /api/tasks/{id}/history pages through them)`;
    el.appendChild(more);
  }
  for (const h of (history || [])) {
    const row = document.createElement("div");
    row.className = "h-row";
    const ts = localTime(h.ts);
    const text = h.action === "move"
      ? `${h.from_status || "—"} → ${h.to_status || "—"}` + (h.comment ? ` — ${h.comment}` : "")
      : (h.comment || "");
    row.innerHTML = `
      <span class="h-ts">${ts}</span>
      <span class="h-actor">${escapeHTML(h.actor)}</span>
      <span class="h-act">${h.action}</span>
      <span class="h-text">${escapeHTML(text)}</span>
    `;
    el.appendChild(row);
  }
  if (!history || !history.length) {
    el.innerHTML = `<span class="h-text" style="color: var(--muted)">empty</span>`;
  }
}

function closeModal() {
  const wasOpen = !$("#modal").hidden;
  $("#modal").hidden = true;
  delete $("#modal").dataset.taskId;
  state.modalTask = null;
  if (wasOpen && state.projectId && parseTaskRoute()) {
    history.replaceState(history.state, "", `/p/${state.projectId}`);
  }
}

async function saveModal() {
  const taskId = $("#modal").dataset.taskId;
  if (!taskId) return;
  const payload = {
    title: $("#m-title").value.trim(),
    description: $("#m-description").value,
    acceptance: $("#m-acceptance").value,
    priority: $("#m-priority").value,
    size: $("#m-size").value,
    // "" clears the blocker (null would mean "leave unchanged")
    external_blocker: $("#m-blocker").value.trim(),
    tags: tagPickerEdit.get(),
  };
  const assignee = $("#m-assignee").value.trim();
  try {
    await api("PATCH", `/api/tasks/${taskId}`, payload);
    if (state.modalTask && (state.modalTask.assignee || "") !== assignee) {
      await api("POST", `/api/tasks/${taskId}/assign`, { assignee: assignee || null });
    }
    toast(`${taskId} saved`);
    closeModal();
    await loadBoard();
  } catch (e) {
    toast(`Error: ${e.message}`, "err");
  }
}

async function addLink() {
  const taskId = $("#modal").dataset.taskId;
  if (!taskId) return;
  const type = $("#m-link-type").value;
  const value = $("#m-link-value").value.trim();
  if (!value) return;
  try {
    await api("POST", `/api/tasks/${taskId}/links`, { type, value });
    $("#m-link-value").value = "";
    const t = await api("GET", `/api/tasks/${taskId}?history_limit=0`);
    renderLinks(t.links);
  } catch (e) {
    toast(`Error: ${e.message}`, "err");
  }
}

async function addComment() {
  const taskId = $("#modal").dataset.taskId;
  if (!taskId) return;
  const text = $("#m-comment").value.trim();
  if (!text) return;
  try {
    await api("POST", `/api/tasks/${taskId}/comment`, { text });
    $("#m-comment").value = "";
    const t = await api("GET", `/api/tasks/${taskId}?history_limit=${HISTORY_LIMIT}`);
    renderHistory(t.history, t.history_total);
  } catch (e) {
    toast(`Error: ${e.message}`, "err");
  }
}

// ----------------------------------------------------------- New task

function openNewModal() {
  $("#n-title").value = "";
  $("#n-description").value = "";
  $("#n-acceptance").value = "";
  $("#n-priority").value = "normal";
  $("#n-size").value = "M";
  $("#n-status").value = "backlog";
  tagPickerNew.set([]);
  $("#n-proj-chip").textContent = state.project ? state.project.name : state.projectId;
  $("#new-modal").hidden = false;
  $("#n-title").focus();
}

function closeNewModal() {
  $("#new-modal").hidden = true;
}

async function createTask() {
  const title = $("#n-title").value.trim();
  if (!title) {
    toast("Title is required", "err");
    return;
  }
  const payload = {
    title,
    description: $("#n-description").value,
    acceptance: $("#n-acceptance").value,
    priority: $("#n-priority").value,
    size: $("#n-size").value,
    status: $("#n-status").value,
    tags: tagPickerNew.get(),
    project_id: state.projectId,
  };
  try {
    const t = await api("POST", `/api/tasks`, payload);
    toast(`${t.id} created`);
    closeNewModal();
    await loadBoard();
    await loadProjects();
  } catch (e) {
    toast(`Error: ${e.message}`, "err");
  }
}

// ----------------------------------------------------------- Project modal (create + edit)

// editingProjId — null when creating a new project, otherwise id of the project being edited.
let editingProjId = null;
// activeSourceTab — which task-source tab is selected in the wizard ('new'|'local'|'git').
let activeSourceTab = "new";
// selectedPlanFiles — Set of plan-file paths selected in the current wizard session.
let selectedPlanFiles = new Set();

function resetSourceWizard() {
  activeSourceTab = "new";
  $$(".source-tab").forEach(t =>
    t.classList.toggle("is-active", t.dataset.source === "new")
  );
  $$(".source-pane").forEach(p =>
    p.hidden = p.dataset.pane !== "new"
  );
  selectedPlanFiles = new Set();
  $("#src-git-url").value = "";
  $("#src-git-token").value = "";
  $("#source-current").hidden = true;
  $("#source-current-text").textContent = "—";
}

function selectSourceTab(name) {
  activeSourceTab = name;
  $$(".source-tab").forEach(t =>
    t.classList.toggle("is-active", t.dataset.source === name)
  );
  $$(".source-pane").forEach(p =>
    p.hidden = p.dataset.pane !== name
  );
  if (name === "local") loadPlanCandidates();
}

// ----- Plan candidates list -----

function _humanSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function _humanTime(ts) {
  const now = Date.now() / 1000;
  const diff = now - ts;
  if (diff < 60)        return "just now";
  if (diff < 3600)      return `${Math.floor(diff / 60)} min ago`;
  if (diff < 86400)     return `${Math.floor(diff / 3600)} h ago`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)} d ago`;
  return new Date(ts * 1000).toISOString().slice(0, 10);
}

async function loadPlanCandidates() {
  const box = $("#src-candidates");
  const path = $("#p-path").value.trim();
  if (!path) {
    box.innerHTML = `
      <div class="src-candidates__empty">
        First specify the project directory.<br>
        <button type="button" class="btn btn--ghost" data-action="pick-folder" style="margin-top:8px;">Specify directory…</button>
      </div>`;
    return;
  }
  box.innerHTML = '<div class="src-candidates__empty">Scanning…</div>';
  try {
    // Always use path from input — in edit mode the user may have just
    // picked a new path via the picker, and it isn't saved to the DB yet.
    const r = await api("GET", `/api/system/list-md-files?path=${encodeURIComponent(path)}`);
    if (!r.items || r.items.length === 0) {
      box.innerHTML = `<div class="src-candidates__empty">No .md files found in the directory. Use "Choose another folder…" below.</div>`;
      $("#src-local-file").value = "";
      return;
    }
    renderCandidates(r.items);
  } catch (e) {
    box.innerHTML = `<div class="src-candidates__empty">Error: ${escapeHTML(e.message)}</div>`;
  }
}

function renderCandidates(items) {
  const box = $("#src-candidates");
  box.innerHTML = "";
  // Auto-select all plan-files (prio ≤ 5: PLAN/BACKLOG/TASKS/TODO/ROADMAP).
  // CLAUDE.md/README.md/etc. are prio 7+, left unchecked.
  selectedPlanFiles = new Set(
    items.filter(it => it.prio <= 5).map(it => it.file)
  );
  // If none qualify (all low-priority) — check the first so the wizard isn't empty.
  if (selectedPlanFiles.size === 0 && items.length > 0) {
    selectedPlanFiles.add(items[0].file);
  }
  for (const it of items) {
    box.appendChild(_candidateEl(it));
  }
  _updateCandidatesCounter();
}

function _candidateEl(it) {
  const sel = selectedPlanFiles.has(it.file);
  const el = document.createElement("div");
  el.className = "src-candidate";
  if (sel) el.classList.add("is-selected");
  el.dataset.file = it.file;
  el.innerHTML = `
    <span class="src-candidate__check">${sel ? "☑" : "☐"}</span>
    <span class="src-candidate__name">${escapeHTML(it.file)}</span>
    <span class="src-candidate__meta">${_humanSize(it.size)} · ${_humanTime(it.modified)}</span>
  `;
  el.addEventListener("click", () => toggleCandidate(it.file));
  return el;
}

function toggleCandidate(file) {
  if (selectedPlanFiles.has(file)) selectedPlanFiles.delete(file);
  else selectedPlanFiles.add(file);
  const el = $(`.src-candidate[data-file="${CSS.escape(file)}"]`);
  if (el) {
    const sel = selectedPlanFiles.has(file);
    el.classList.toggle("is-selected", sel);
    const check = el.querySelector(".src-candidate__check");
    if (check) check.textContent = sel ? "☑" : "☐";
  }
  _updateCandidatesCounter();
}

function _updateCandidatesCounter() {
  const counter = $("#src-candidates-counter");
  if (counter) counter.textContent = `Selected: ${selectedPlanFiles.size}`;
}


async function showCurrentSource(projectId) {
  // Fetch the project's current source (if any). 404 = none.
  try {
    const src = await api("GET", `/api/projects/${projectId}/source`);
    let label;
    if (src.type === "plan_md") {
      const files = src.config.files || (src.config.file ? [src.config.file] : []);
      label = files.length > 0
        ? `Plan files (${files.length}): ${files.join(", ")}`
        : `Plan: ${JSON.stringify(src.config)}`;
    } else if (src.type === "git") {
      label = `Git: ${src.config.repo_url}`;
    } else {
      label = `${src.type}: ${JSON.stringify(src.config)}`;
    }
    if (src.last_sync_at) label += ` · sync: ${src.last_sync_at.slice(5,16).replace("T"," ")}`;
    $("#source-current").hidden = false;
    $("#source-current-text").textContent = label;
  } catch (e) {
    $("#source-current").hidden = true;
  }
}

function openNewProj() {
  editingProjId = null;
  $("#proj-modal-title").textContent = "New project";
  $("#btn-create-proj").textContent = "Create";
  $("#p-name").value = "";
  $("#p-id").value = "";
  $("#p-id").disabled = false;
  $("#p-path").value = "";
  $$(".swatch").forEach(s => s.classList.toggle("is-active", s.dataset.color === "#F10D30"));
  resetSourceWizard();
  $("#p-connect").checked = true;    // new project: offer .mcp.json by default
  $("#proj-modal").hidden = false;
  $("#p-name").focus();
}

function openEditProj(p) {
  editingProjId = p.id;
  $("#proj-modal-title").textContent = `Project: ${p.name}`;
  $("#btn-create-proj").textContent = "Save";
  $("#p-name").value = p.name;
  $("#p-id").value = p.id;
  $("#p-id").disabled = true;     // id is immutable (FK on tasks)
  $("#p-path").value = p.path || "";
  $$(".swatch").forEach(s => s.classList.toggle("is-active", s.dataset.color === p.color));
  resetSourceWizard();
  showCurrentSource(p.id);
  // Editing (renaming, recolouring) must not rewrite .mcp.json behind the
  // user's back — only when they tick the box.
  $("#p-connect").checked = false;
  $("#proj-modal").hidden = false;
  $("#p-name").focus();
}

function closeNewProj() {
  $("#proj-modal").hidden = true;
  editingProjId = null;
}

async function saveProj() {
  const name = $("#p-name").value.trim();
  const id = $("#p-id").value.trim();
  const path = $("#p-path").value.trim();
  const colorEl = $(".swatch.is-active");
  const color = colorEl ? colorEl.dataset.color : "#F10D30";
  // The icon is auto-generated from the first letter of the name; the
  // backend does the same when icon is empty (see Store.create_project).
  const icon = "";
  if (!name) { toast("Name is required", "err"); return; }

  // Pre-validation: types new/local require a path. Otherwise the wizard does
  // nothing and the user ends up with an empty board.
  if ((activeSourceTab === "new" || activeSourceTab === "local") && !path) {
    toast("First specify the project directory (field \"Project directory\")", "err");
    $("#p-path").focus();
    $("#p-path").classList.add("field--error");
    setTimeout(() => $("#p-path").classList.remove("field--error"), 2000);
    return;
  }
  if (activeSourceTab === "local") {
    if (selectedPlanFiles.size === 0) {
      toast("Tick at least one plan file", "err");
      return;
    }
  }
  if (activeSourceTab === "git") {
    const url = $("#src-git-url").value.trim();
    if (!url) {
      toast("Enter the repository URL (or switch to another source)", "err");
      $("#src-git-url").focus();
      return;
    }
  }

  // Save base project (create or edit)
  let savedId = editingProjId;
  if (editingProjId) {
    try {
      await api("PATCH", `/api/projects/${editingProjId}`, { name, color, icon, path });
    } catch (e) {
      toast(`Error: ${e.message}`, "err");
      return;
    }
  } else {
    if (!id) { toast("ID is required", "err"); return; }
    if (!/^[a-z][a-z0-9-]{1,31}$/.test(id)) {
      toast("ID: latin lowercase, 2-32 characters", "err");
      return;
    }
    try {
      await api("POST", "/api/projects", { id, name, color, icon, path });
      savedId = id;
    } catch (e) {
      toast(`Error: ${e.message}`, "err");
      return;
    }
  }

  // Setup source
  const results = [];
  const sourceResult = await applySourceWizard(savedId, path);
  if (sourceResult) results.push(sourceResult);
  // Give agents in that directory the kanban tools (.mcp.json + CLAUDE.md).
  if (path && $("#p-connect").checked) {
    try {
      const c = await api("POST", `/api/projects/${savedId}/connect`, {});
      results.push(`.mcp.json → server "${c.alias}"`);
    } catch (e) {
      toast(`Connect Claude Code: ${e.message}`, "err");
    }
  }
  const suffix = results.length ? " · " + results.join(" · ") : "";

  toast(editingProjId ? `Project ${name} saved${suffix}` : `Project ${name} created${suffix}`);
  closeNewProj();
  await loadProjects();
  if (!editingProjId) navigateTo(savedId);
  await loadBoard();
  renderSidebar();
}

// Apply the source-wizard outcome for `projectId`. Returns a short
// description for the toast, or null if nothing was done.
async function applySourceWizard(projectId, path) {
  const tab = activeSourceTab;
  // Types new/local need a path. Git does not.
  if ((tab === "new" || tab === "local") && !path) {
    return null;          // user did not specify a directory — skip setup
  }
  try {
    if (tab === "new") {
      const r = await api("POST", `/api/projects/${projectId}/source/plan-new`);
      return `created ${r.plan_md.split("/").pop()}`;
    }
    if (tab === "local") {
      const files = Array.from(selectedPlanFiles);
      if (files.length === 0) return null;
      const r = await api("POST", `/api/projects/${projectId}/source/plan-local`, { files });
      const c = r.imported || {};
      return `imported from ${files.length} file(s): ${c.created || 0} created, ${c.skipped || 0} skipped`;
    }
    if (tab === "git") {
      const repo_url = $("#src-git-url").value.trim();
      const token = $("#src-git-token").value;
      if (!repo_url) return null;
      await api("POST", `/api/projects/${projectId}/source/git`, { repo_url, token });
      return token ? "git connected · token saved" : "git connected";
    }
  } catch (e) {
    toast(`Task source: ${e.message}`, "err");
  }
  return null;
}

// Open the native folder picker (macOS Finder / Linux zenity / Windows FBD).
async function pickFolder() {
  const btn = $("#btn-pick-folder");
  if (btn) {
    btn.disabled = true;
    btn.dataset.oldText = btn.textContent;
    btn.textContent = "Opening…";
  }
  try {
    const r = await api("POST", "/api/system/pick-folder");
    if (r.cancelled) return;
    if (r.path) {
      $("#p-path").value = r.path;
      $("#p-path").classList.remove("field--error");
      // If local is active — reload candidates with the new path.
      if (activeSourceTab === "local") loadPlanCandidates();
    }
  } catch (e) {
    if (String(e.message).includes("HTTP 501")) {
      toast("Native picker not available — enter the path manually", "err");
    } else {
      toast(`Picker: ${e.message}`, "err");
    }
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = btn.dataset.oldText || "Choose…";
    }
  }
}

// Auto-fill id from name (only in create mode)
function autoFillProjId() {
  if (editingProjId) return;
  const idInput = $("#p-id");
  if (idInput.value) return;
  const slug = $("#p-name").value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  if (slug && /^[a-z]/.test(slug)) idInput.value = slug;
}

// ----------------------------------------------------------- Snapshot

async function snapshot() {
  try {
    const r = await api("POST", `/api/snapshot`);
    toast(`Snapshot → ${r.path.split("/").pop()}`);
  } catch (e) {
    toast(`Error: ${e.message}`, "err");
  }
}

// ----------------------------------------------------------- Density

function toggleDensity() {
  state.density = state.density === "compact" ? "comfortable" : "compact";
  localStorage.setItem(LS.DENSITY, state.density);
  $("#board").classList.toggle("is-compact", state.density === "compact");
}

// ----------------------------------------------------------- Sidebar toggle

function toggleSidebar() {
  state.sidebarCollapsed = !state.sidebarCollapsed;
  localStorage.setItem(LS.SIDEBAR, state.sidebarCollapsed ? "collapsed" : "open");
  $("#sidebar").classList.toggle("is-collapsed", state.sidebarCollapsed);
}

// ----------------------------------------------------------- Theme

function toggleTheme() {
  state.theme = state.theme === "light" ? "dark" : "light";
  localStorage.setItem(LS.THEME, state.theme);
  document.documentElement.setAttribute("data-theme", state.theme);
}

// ----------------------------------------------------------- Claude auth indicator

async function refreshClaudeAuth() {
  const btn = $("#btn-claude-auth");
  if (!btn) return;
  try {
    const r = await api("GET", "/api/system/claude-auth-status");
    btn.classList.remove("claude-auth--ok", "claude-auth--no", "claude-auth--unknown", "is-busy");
    if (!r.available) {
      btn.classList.add("claude-auth--no");
      btn.title = "Claude CLI not found — install Claude Code";
    } else if (r.loggedIn) {
      btn.classList.add("claude-auth--ok");
      btn.title = `Claude CLI: signed in (${r.authMethod || "ok"})`;
    } else {
      btn.classList.add("claude-auth--no");
      btn.title = "Claude CLI: NOT signed in — click to log in";
    }
  } catch (e) {
    btn.classList.remove("claude-auth--ok", "claude-auth--unknown");
    btn.classList.add("claude-auth--no");
    btn.title = `Status check failed: ${e.message}`;
  }
}

async function clickClaudeAuth() {
  const btn = $("#btn-claude-auth");
  if (!btn) return;
  // If already signed in — click does nothing (just a status toast).
  if (btn.classList.contains("claude-auth--ok")) {
    toast("Claude CLI is signed in");
    return;
  }
  btn.classList.add("is-busy");
  try {
    const r = await api("POST", "/api/system/claude-auth-login");
    toast(`Browser login launched (pid ${r.pid}). Finish OAuth and wait ~10 s.`);
    // Re-poll after 10/30/60 s.
    [10, 25, 60].forEach(sec => setTimeout(refreshClaudeAuth, sec * 1000));
  } catch (e) {
    toast(`Auth login: ${e.message}`, "err");
    btn.classList.remove("is-busy");
  }
}

// ----------------------------------------------------------- Profile

function toggleProfile() {
  const cur = document.documentElement.getAttribute("data-profile") || "standard";
  const idx = PROFILES.indexOf(cur);
  const next = PROFILES[(idx + 1) % PROFILES.length];
  document.documentElement.setAttribute("data-profile", next);
  localStorage.setItem(LS.PROFILE, next);
  toast(`Profile: ${PROFILE_LABELS[next]}`);
}

// ----------------------------------------------------------- Loaders

// ----------------------------------------------------------- Automation pause

async function refreshAutomation() {
  try {
    const st = await api("GET", "/api/automation/status");
    state.automationPaused = !!(st.rules && st.rules.paused);
  } catch { return; }
  const btn = $("#btn-automation");
  btn.classList.toggle("is-paused", state.automationPaused);
  btn.textContent = state.automationPaused ? "▶" : "⏸";
  btn.title = state.automationPaused
    ? "Automation is PAUSED — rules and agent launches are off. Click to resume."
    : "Pause automation (rules, agent launches)";
  $("#paused-banner").hidden = !state.automationPaused;
}

async function toggleAutomation() {
  const next = !state.automationPaused;
  try {
    await api("POST", "/api/automation/pause", { paused: next });
    toast(next ? "Automation paused" : "Automation resumed");
  } catch (e) {
    toast(`Error: ${e.message}`, "err");
  }
  await refreshAutomation();
}

async function loadProjects() {
  try {
    const r = await api("GET", "/api/projects?include_archived=true");
    state.projects = r.projects;
    renderSidebar();
  } catch (e) {
    toast(`Failed to load projects: ${e.message}`, "err");
  }
}

async function loadBoard() {
  if (!state.projectId) return;
  if (state.isDragging) return;
  if ($("#modal").hidden === false) return;
  if ($("#new-modal").hidden === false) return;
  if ($("#proj-modal").hidden === false) return;
  try {
    const qs = `project=${encodeURIComponent(state.projectId)}` +
      (state.showArchived ? "&include_archived=true" : "");
    const board = await api("GET", `/api/board?${qs}`);
    render(board);
    loadTags();
  } catch (e) {
    if (String(e.message).includes("HTTP 404")) {
      // Project not found — fall back to the first available
      const fallback = state.projects.find(p => !p.archived);
      if (fallback && fallback.id !== state.projectId) {
        navigateTo(fallback.id, { replace: true });
        await loadBoard();
      } else {
        toast("No projects available", "err");
      }
    } else {
      toast(`Network: ${e.message}`, "err");
    }
  }
}

// ----------------------------------------------------------- Search

let searchDebounce = null;
function onSearchInput(e) {
  const v = e.target.value;
  $("#btn-search-clear").hidden = !v;
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(() => {
    state.search = v.trim();
    applyFilters();
  }, 120);
}

function clearSearch() {
  $("#search").value = "";
  $("#btn-search-clear").hidden = true;
  state.search = "";
  applyFilters();
}

// ----------------------------------------------------------- Filter chips

function toggleFilter(filter) {
  if (state.filters.has(filter)) state.filters.delete(filter);
  else state.filters.add(filter);
  $$(`#filters .filter-chip, #tagbar .tag-chip`).forEach(b => {
    b.classList.toggle("is-on", state.filters.has(b.dataset.filter));
  });
  applyFilters();
}

// ----------------------------------------------------------- Tags
//
// Tags are derived from the cards of the current project (/api/tags), so the
// picker only offers labels that already exist there — plus the one being
// typed, which is created on save.

function normalizeTagClient(raw) {
  return String(raw || "").trim().toLowerCase().replace(/\s+/g, "-");
}

function createTagPicker({ valuesId, addId, menuId, searchId, listId }) {
  const valuesEl = $(valuesId);
  const addBtn = $(addId);
  const menuEl = $(menuId);
  const searchEl = $(searchId);
  const listEl = $(listId);
  const chosen = [];

  function vocabulary() { return state.tags || []; }
  function isOpen() { return !menuEl.hidden; }

  function renderValues() {
    if (!chosen.length) {
      valuesEl.innerHTML = `<span class="tagpicker__hint">none</span>`;
      return;
    }
    valuesEl.innerHTML = chosen.map(tag =>
      `<span class="tagpill">#${escapeHTML(tag)}<button type="button" class="tagpill__x"` +
      ` data-tag="${escapeHTML(tag)}" aria-label="Remove tag">×</button></span>`
    ).join("");
    valuesEl.querySelectorAll(".tagpill__x").forEach(b => {
      b.addEventListener("click", () => { remove(b.dataset.tag); });
    });
  }

  function renderList() {
    const q = normalizeTagClient(searchEl.value);
    const known = vocabulary();
    const chosenSet = new Set(chosen);
    const rows = known
      .filter(it => !q || it.name.includes(q))
      .map(it => {
        const on = chosenSet.has(it.name);
        return `<button type="button" class="tagopt${on ? " is-on" : ""}" data-tag="${escapeHTML(it.name)}">` +
          `<span class="tagopt__check">${on ? "✓" : ""}</span>` +
          `<span class="tagopt__name">#${escapeHTML(it.name)}</span>` +
          `<span class="tagopt__count">${it.count}</span></button>`;
      });
    if (q && !known.some(it => it.name === q)) {
      rows.unshift(`<button type="button" class="tagopt tagopt--new" data-new="${escapeHTML(q)}">` +
        `<span class="tagopt__check">+</span>` +
        `<span class="tagopt__name">create #${escapeHTML(q)}</span></button>`);
    }
    listEl.innerHTML = rows.join("") ||
      `<div class="tagpicker__empty">no tags in this project yet — type to create one</div>`;
    listEl.querySelectorAll(".tagopt").forEach(b => {
      b.addEventListener("click", () => {
        if (b.dataset.new !== undefined) add(b.dataset.new);
        else toggle(b.dataset.tag);
        searchEl.value = "";
        searchEl.focus();
        renderList();
      });
    });
  }

  function add(raw) {
    const tag = normalizeTagClient(raw);
    if (!tag || chosen.includes(tag)) return;
    chosen.push(tag);
    chosen.sort();
    renderValues();
  }

  function remove(tag) {
    const i = chosen.indexOf(tag);
    if (i >= 0) chosen.splice(i, 1);
    renderValues();
  }

  function toggle(tag) {
    if (chosen.includes(tag)) remove(tag);
    else add(tag);
  }

  function open() {
    menuEl.hidden = false;
    addBtn.classList.add("is-open");
    searchEl.value = "";
    renderList();
    searchEl.focus();
  }

  function close() {
    menuEl.hidden = true;
    addBtn.classList.remove("is-open");
  }

  addBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (isOpen()) close();
    else open();
  });
  searchEl.addEventListener("input", renderList);
  searchEl.addEventListener("keydown", (e) => {
    // Escape closes the panel, not the whole modal.
    if (e.key === "Escape") {
      e.stopPropagation();
      close();
      addBtn.focus();
    } else if (e.key === "Enter") {
      e.preventDefault();
      const q = normalizeTagClient(searchEl.value);
      if (!q) return;
      toggle(q);
      searchEl.value = "";
      renderList();
    }
  });
  document.addEventListener("click", (e) => {
    if (isOpen() && !menuEl.contains(e.target) && !addBtn.contains(e.target)) close();
  });

  renderValues();
  return {
    set(tags) {
      chosen.length = 0;
      (tags || []).forEach(add);
      renderValues();
      if (isOpen()) renderList();
    },
    get() { return [...chosen]; },
    refresh() { if (isOpen()) renderList(); },
  };
}

const tagPickerEdit = createTagPicker({
  valuesId: "#m-tags", addId: "#m-tag-add", menuId: "#m-tag-menu",
  searchId: "#m-tag-search", listId: "#m-tag-list",
});
const tagPickerNew = createTagPicker({
  valuesId: "#n-tags", addId: "#n-tag-add", menuId: "#n-tag-menu",
  searchId: "#n-tag-search", listId: "#n-tag-list",
});

async function loadTags() {
  if (!state.projectId) return;
  const wanted = state.projectId;
  try {
    const r = await api("GET", `/api/tags?project=${encodeURIComponent(wanted)}`);
    if (state.projectId !== wanted) return;   // project switched meanwhile
    state.tags = r.tags || [];
  } catch {
    state.tags = [];
  }
  renderTagbar();
  tagPickerEdit.refresh();
  tagPickerNew.refresh();
}

function renderTagbar() {
  const el = $("#tagbar");
  const tags = state.tags || [];
  if (!tags.length) {
    el.hidden = true;
    el.innerHTML = "";
    return;
  }
  el.hidden = false;
  el.innerHTML = `<span class="tagbar__label">Tags</span>` + tags.map(t => {
    const filter = `tag:${t.name}`;
    const on = state.filters.has(filter) ? " is-on" : "";
    return `<button class="filter-chip tag-chip${on}" data-filter="${escapeHTML(filter)}"` +
      ` title="${t.count} card(s)">#${escapeHTML(t.name)}` +
      `<span class="tag-chip__count">${t.count}</span></button>`;
  }).join("");
  el.querySelectorAll(".tag-chip").forEach(b => {
    b.addEventListener("click", () => toggleFilter(b.dataset.filter));
  });
}

// ----------------------------------------------------------- Middle-click pan

function initMiddleClickPan() {
  const board = $("#board");
  if (!board) return;
  let panning = false;
  let startX = 0;
  let startScrollLeft = 0;

  board.addEventListener("mousedown", (e) => {
    if (e.button !== 1) return;     // middle button only
    e.preventDefault();             // suppress the native autoscroll cursor
    panning = true;
    startX = e.clientX;
    startScrollLeft = board.scrollLeft;
    document.body.style.cursor = "grabbing";
    board.style.cursor = "grabbing";
  });

  document.addEventListener("mousemove", (e) => {
    if (!panning) return;
    e.preventDefault();
    const dx = e.clientX - startX;
    board.scrollLeft = startScrollLeft - dx;
  });

  const stop = () => {
    if (!panning) return;
    panning = false;
    document.body.style.cursor = "";
    board.style.cursor = "";
  };
  document.addEventListener("mouseup", (e) => {
    if (e.button === 1) stop();
  });
  // Release if the window loses focus
  window.addEventListener("blur", stop);
}

// ----------------------------------------------------------- Init

document.addEventListener("DOMContentLoaded", async () => {
  state.projectId = parseRoute();

  // Modal close handlers
  $$("[data-close]").forEach((el) => el.addEventListener("click", closeModal));
  $$("[data-close-new]").forEach((el) => el.addEventListener("click", closeNewModal));
  $$("[data-close-proj]").forEach((el) => el.addEventListener("click", closeNewProj));

  // Buttons
  $("#btn-save").addEventListener("click", saveModal);
  $("#btn-add-link").addEventListener("click", addLink);
  $("#btn-add-comment").addEventListener("click", addComment);
  $("#btn-new").addEventListener("click", openNewModal);
  $("#btn-create").addEventListener("click", createTask);
  $("#btn-refresh").addEventListener("click", () => { loadBoard(); loadProjects(); });
  $("#btn-snapshot").addEventListener("click", snapshot);
  $("#btn-density").addEventListener("click", toggleDensity);
  $("#btn-theme").addEventListener("click", toggleTheme);
  $("#btn-profile").addEventListener("click", toggleProfile);
  $("#btn-claude-auth").addEventListener("click", clickClaudeAuth);
  $("#btn-automation").addEventListener("click", toggleAutomation);
  $("#btn-resume-automation").addEventListener("click", toggleAutomation);
  $("#btn-archive-task").addEventListener("click", toggleArchiveTask);
  $("#m-id").addEventListener("click", copyTaskLink);
  refreshAutomation();
  setInterval(refreshAutomation, 30000);
  $("#btn-sidebar").addEventListener("click", toggleSidebar);
  // Initial claude auth state + periodic refresh every 60 s
  refreshClaudeAuth();
  setInterval(refreshClaudeAuth, 60000);
  $("#btn-new-proj").addEventListener("click", openNewProj);
  $("#btn-create-proj").addEventListener("click", saveProj);
  // Source-wizard tabs
  $$(".source-tab").forEach(t =>
    t.addEventListener("click", () => selectSourceTab(t.dataset.source))
  );
  // On path change — refetch candidates (if local mode is active)
  $("#p-path").addEventListener("change", () => {
    if (activeSourceTab === "local") loadPlanCandidates();
  });

  // Delegated click handler for [data-action="..."] — works for
  // dynamically inserted buttons (inline in src-candidates__empty)
  // and across pane re-renders.
  document.body.addEventListener("click", (e) => {
    const target = e.target.closest("[data-action]");
    if (!target) return;
    const action = target.dataset.action;
    console.log("[kanban] action:", action);   // diagnostic
    if (action === "pick-folder") {
      e.preventDefault();
      pickFolder();
    } else if (action === "refresh-candidates") {
      e.preventDefault();
      loadPlanCandidates();
    }
  });

  // Project name → auto-slug
  $("#p-name").addEventListener("input", autoFillProjId);

  // Color palette
  $$(".swatch").forEach(s => s.addEventListener("click", () => {
    $$(".swatch").forEach(x => x.classList.remove("is-active"));
    s.classList.add("is-active");
  }));

  // Archive section toggle
  $("#btn-archive-toggle").addEventListener("click", () => {
    const box = $("#proj-archive");
    const list = $("#proj-archive-list");
    const open = !box.classList.contains("is-open");
    box.classList.toggle("is-open", open);
    list.hidden = !open;
    localStorage.setItem(LS.ARCHIVE_OPEN, open ? "1" : "0");
  });

  // Search
  $("#search").addEventListener("input", onSearchInput);
  $("#btn-search-clear").addEventListener("click", clearSearch);

  // Sidebar: project search, keyboard navigation, actions menu
  $("#proj-search").addEventListener("input", onProjSearchInput);
  $("#btn-proj-search-clear").addEventListener("click", clearProjSearch);
  $("#proj-search").addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      moveProjFocus(1);
    } else if (e.key === "Escape") {
      e.stopPropagation();
      clearProjSearch();
    }
  });
  $("#proj-list").addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      moveProjFocus(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      moveProjFocus(-1);
    }
  });
  $("#proj-menu").addEventListener("click", (e) => {
    const item = e.target.closest(".pmi");
    if (!item || item.disabled) return;
    const p = state.projects.find(x => x.id === projMenuProjectId);
    closeProjMenu();
    if (p) runProjMenuAction(item.dataset.act, p);
  });
  document.addEventListener("click", (e) => {
    if ($("#proj-menu").hidden) return;
    if (e.target.closest("#proj-menu") || e.target.closest(".proj__menu")) return;
    closeProjMenu();
  });
  window.addEventListener("scroll", closeProjMenu, true);
  $("#proj-list").addEventListener("scroll", closeProjMenu);
  initProjSortable();

  // Filter chips
  $$("#filters .filter-chip").forEach(b => {
    b.addEventListener("click", () => toggleFilter(b.dataset.filter));
  });

  // Keyboard
  document.addEventListener("keydown", (e) => {
    // skip if typing in input/textarea
    const tag = (e.target.tagName || "").toLowerCase();
    const inField = tag === "input" || tag === "textarea" || tag === "select";
    if (e.key === "Escape") {
      closeProjMenu();
      closeModal();
      closeNewModal();
      closeNewProj();
      if (state.search) clearSearch();
      return;
    }
    if (inField) return;
    if (e.key === "/" || e.key === "?") {
      e.preventDefault();
      $("#search").focus();
    } else if (e.key === "n") {
      e.preventDefault();
      openNewModal();
    } else if (e.key === "d") {
      toggleDensity();
    } else if (e.key === "t") {
      toggleTheme();
    } else if (e.key === "p") {
      toggleProfile();
    } else if (e.key === "\\") {
      toggleSidebar();
    } else if (e.key === "r") {
      loadBoard();
    }
  });

  // Middle-click panning: hold the wheel on the board and drag left/right.
  // Does not conflict with SortableJS drag-drop (which reacts to left-click).
  initMiddleClickPan();

  // Browser back/forward
  window.addEventListener("popstate", () => {
    const next = parseRoute();
    if (next) {
      state.projectId = next;
      loadBoard();
      renderSidebar();
    }
  });

  // Initial load: projects first, then select + board
  await loadProjects();
  const linkedTask = parseTaskRoute();
  let linked = null;
  if (linkedTask) {
    try {
      linked = await api("GET", `/api/tasks/${encodeURIComponent(linkedTask)}?history_limit=0`);
      state.projectId = linked.project_id;
      if (linked.archived_at) state.showArchived = true;
    } catch {
      toast(`Card ${linkedTask} not found`, "err");
    }
  }
  if (!state.projectId && state.projects.length > 0) {
    // URL without /p/X — priority:
    // 1) last opened from localStorage (if it still exists and isn't archived)
    // 2) first active project
    const last = localStorage.getItem(LS.LAST_PROJECT);
    const lastP = last && state.projects.find(p => p.id === last && !p.archived);
    const first = lastP || state.projects.find(p => !p.archived) || state.projects[0];
    state.projectId = first.id;
    navigateTo(state.projectId, { replace: true });
  }
  if (state.projectId) {
    await loadBoard();
    renderSidebar();
  }
  if (linked) await openTaskModal(linked.id);

  // Polling
  setInterval(() => { loadBoard(); loadProjects(); }, 10000);
});
