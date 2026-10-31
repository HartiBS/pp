const db = require('../config/database');
const taskMarkdown = require('./taskMarkdown');

/**
 * Tracker-Feld-Mapping (Admin-Konfigurationsseite "Tracker-Mapping"):
 * Ordnet Felder der externen Issues (GitHub/GitLab) den eigenen Task-Feldern zu.
 * Eigene Felder, die nicht gemappt sind, werden beim Push als Markdown in das
 * Kommentarfeld (description/body) geschrieben; externe Felder, die nicht gemappt
 * sind, werden beim Pull als Markdown an die lokale Beschreibung angehängt.
 */

const CUSTOM_FIELD_PREFIX = 'custom_field:';

const PP_FIELDS = [
  { value: 'title', label: 'Titel', kind: 'scalar' },
  { value: 'description', label: 'Beschreibung', kind: 'scalar' },
  { value: 'status', label: 'Status', kind: 'scalar' },
  { value: 'priority', label: 'Priorität', kind: 'scalar' },
  { value: 'issue_type', label: 'Typ', kind: 'scalar' },
  { value: 'labels', label: 'Labels', kind: 'array' },
  { value: 'due_date', label: 'Fälligkeitsdatum', kind: 'scalar' },
  { value: 'estimated_hours', label: 'Geschätzte Stunden', kind: 'scalar' },
  { value: 'spent_hours', label: 'Aufgewendete Stunden', kind: 'scalar' },
  { value: 'assignee', label: 'Bearbeiter', kind: 'scalar' },
  { value: 'milestone', label: 'Milestone', kind: 'scalar' },
];

const TRACKER_FIELDS = {
  gitlab: [
    { value: 'title', label: 'Titel (title)' },
    { value: 'description', label: 'Beschreibung (description)' },
    { value: 'state', label: 'Status (state: opened/closed)' },
    { value: 'labels', label: 'Labels (labels)' },
    { value: 'milestone', label: 'Milestone (milestone_id)' },
    { value: 'due_date', label: 'Fällig (due_date)' },
    { value: 'assignee_username', label: 'Bearbeiter (assignee_username)' },
    { value: 'time_estimate', label: ' Zeitschätzung in Sekunden (time_estimate)' },
    { value: 'time_spent', label: 'Aufgewendete Zeit in Sekunden (time_spent)' },
  ],
  github: [
    { value: 'title', label: 'Titel (title)' },
    { value: 'body', label: 'Beschreibung (body)' },
    { value: 'state', label: 'Status (state: open/closed)' },
    { value: 'labels', label: 'Labels (labels)' },
    { value: 'milestone', label: 'Milestone (milestone)' },
    { value: 'assignees', label: 'Bearbeiter (assignees)' },
  ],
};

// Erlaubte Ziel-Felder pro eigenem Feld (abhängig vom Tracker-Typ)
function allowedTargets(ppField, trackerType) {
  const base = {
    title: ['title'],
    description: trackerType === 'github' ? ['body'] : ['description'],
    status: ['state'],
    labels: ['labels'],
    due_date: trackerType === 'github' ? [] : ['due_date'],
    assignee: trackerType === 'github' ? ['assignees'] : ['assignee_username'],
    milestone: ['milestone'],
    priority: ['labels'],
    issue_type: ['labels'],
    estimated_hours: trackerType === 'github' ? ['labels'] : ['labels', 'time_estimate'],
    spent_hours: trackerType === 'github' ? ['labels'] : ['labels', 'time_spent'],
  };
  if (ppField.startsWith(CUSTOM_FIELD_PREFIX)) return ['labels'];
  return base[ppField] || [];
}

const DIRECTIONS = ['both', 'push', 'pull'];

// Felder der externen API, die nie als "ungenutzt" ins Markdown wandern
const IGNORE_RAW_FIELDS = new Set([
  'id', 'iid', 'number', 'project_id', 'web_url', 'html_url', 'url',
  'created_at', 'updated_at', 'closed_at', 'merged_at', 'author', 'user',
  'pull_request', 'comments', 'references', '_links', 'task_completion_status',
  'blocking_issues_count', 'body_html', 'imported', 'imported_from',
  'subscribed', 'upvotes', 'downvotes', 'user_notes_count', 'merge_requests_count',
  'service_account_username',
]);

function defaultMappings(trackerType) {
  const descField = trackerType === 'github' ? 'body' : 'description';
  return [
    { pp_field: 'title', tracker_field: 'title', direction: 'both', position: 0 },
    { pp_field: 'description', tracker_field: descField, direction: 'both', position: 1 },
    { pp_field: 'status', tracker_field: 'state', direction: 'both', position: 2 },
    { pp_field: 'labels', tracker_field: 'labels', direction: 'both', position: 3 },
  ];
}

async function getMappings(trackerType) {
  const { rows } = await db.query(
    `SELECT id, tracker_type, pp_field, tracker_field, direction, position
     FROM tracker_field_mappings
     WHERE tracker_type = $1
     ORDER BY position ASC, id ASC`,
    [trackerType]
  );
  return rows;
}

async function getAvailablePpFields() {
  const { rows: defs } = await db.query(
    'SELECT id, name, field_type FROM custom_field_definitions ORDER BY id ASC'
  );
  return [
    ...PP_FIELDS,
    ...defs.map(d => ({
      value: `${CUSTOM_FIELD_PREFIX}${d.id}`,
      label: `Zusatzfeld: ${d.name}`,
      kind: 'custom_field',
      field_type: d.field_type,
    })),
  ];
}

async function validateMappings(trackerType, mappings) {
  if (!['gitlab', 'github'].includes(trackerType)) {
    return { ok: false, error: 'Ungültiger Tracker-Typ (gitlab oder github)' };
  }
  if (!Array.isArray(mappings)) {
    return { ok: false, error: 'mappings muss ein Array sein' };
  }
  const ppFields = await getAvailablePpFields();
  const validPp = new Set(ppFields.map(f => f.value));
  const seen = new Set();
  const cleaned = [];
  for (const m of mappings) {
    if (!m || typeof m !== 'object') return { ok: false, error: 'Ungültiger Mapping-Eintrag' };
    const ppField = String(m.pp_field || '');
    const trackerField = String(m.tracker_field || '');
    const direction = String(m.direction || 'both');
    if (!validPp.has(ppField)) return { ok: false, error: `Unbekanntes eigenes Feld: ${ppField}` };
    if (!TRACKER_FIELDS[trackerType].some(f => f.value === trackerField)) {
      return { ok: false, error: `Unbekanntes ${trackerType}-Feld: ${trackerField}` };
    }
    if (!allowedTargets(ppField, trackerType).includes(trackerField)) {
      return { ok: false, error: `Mapping nicht erlaubt: ${ppField} → ${trackerField}` };
    }
    if (!DIRECTIONS.includes(direction)) {
      return { ok: false, error: `Ungültige Richtung: ${direction}` };
    }
    if (seen.has(ppField)) return { ok: false, error: `Feld doppelt gemappt: ${ppField}` };
    seen.add(ppField);
    cleaned.push({ pp_field: ppField, tracker_field: trackerField, direction, position: cleaned.length });
  }
  return { ok: true, cleaned };
}

async function saveMappings(trackerType, mappings) {
  const validation = await validateMappings(trackerType, mappings);
  if (!validation.ok) {
    const err = new Error(validation.error);
    err.status = 400;
    throw err;
  }
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM tracker_field_mappings WHERE tracker_type = $1', [trackerType]);
    for (const m of validation.cleaned) {
      await client.query(
        `INSERT INTO tracker_field_mappings (tracker_type, pp_field, tracker_field, direction, position)
         VALUES ($1, $2, $3, $4, $5)`,
        [trackerType, m.pp_field, m.tracker_field, m.direction, m.position]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return getMappings(trackerType);
}

/* ===== Push: eigene Task-Felder → externe Issue-Felder ===== */

function ppFieldValue(ppField, task, customFieldDefs) {
  if (ppField.startsWith(CUSTOM_FIELD_PREFIX)) {
    const id = ppField.slice(CUSTOM_FIELD_PREFIX.length);
    return (task.custom_fields || {})[id];
  }
  return task[ppField];
}

function formatCustomValue(def, value) {
  if (value === null || value === undefined) return '';
  if (def && def.field_type === 'checkbox') return value ? 'true' : 'false';
  return String(value);
}

function labelFor(ppField, value, customFieldDefs) {
  if (ppField.startsWith(CUSTOM_FIELD_PREFIX)) {
    const id = ppField.slice(CUSTOM_FIELD_PREFIX.length);
    const def = (customFieldDefs || []).find(d => String(d.id) === String(id));
    return `${def ? def.name : ppField}: ${formatCustomValue(def, value)}`;
  }
  return `${ppField}: ${value}`;
}

/**
 * Baut das Payload für den externen Tracker aus einem Task.
 * Gemappte Felder landen in den entsprechenden Tracker-Feldern, alle nicht
 * gemappten eigenen Felder (inkl. Custom Fields) als Markdown im Kommentarfeld.
 */
function buildTrackerPayload(trackerType, task, mappings, {
  customFieldDefs = [], subtasks = [], parent = null, children = [], related = [],
  assigneeUsername = null, milestoneExternalId = null,
} = {}) {
  const push = mappings.filter(m => m.direction === 'push' || m.direction === 'both');
  const mappedPpFields = new Set(push.map(m => m.pp_field));
  const payload = { title: task.title };
  const extraLabels = [];
  let descriptionMapped = false;

  for (const m of push) {
    const val = ppFieldValue(m.pp_field, task, customFieldDefs);
    if (val === undefined || val === null || val === '') continue;
    switch (m.tracker_field) {
      case 'title':
        payload.title = String(val);
        break;
      case 'description':
      case 'body':
        descriptionMapped = true;
        break;
      case 'state':
        payload.state_event = val === 'done' ? 'close' : 'reopen';
        payload.state = trackerType === 'github'
          ? (val === 'done' ? 'closed' : 'open')
          : (val === 'done' ? 'closed' : 'opened');
        break;
      case 'labels':
        if (m.pp_field === 'labels') {
          payload.labels = Array.isArray(val) ? val : [];
        } else {
          extraLabels.push(labelFor(m.pp_field, val, customFieldDefs));
        }
        break;
      case 'due_date':
        payload.due_date = val;
        break;
      case 'assignee_username':
        if (assigneeUsername) payload.assignee_username = assigneeUsername;
        break;
      case 'assignees':
        if (assigneeUsername) payload.assignees = [assigneeUsername];
        break;
      case 'milestone':
        if (milestoneExternalId != null) {
          payload.milestone = milestoneExternalId;
          payload.milestone_id = milestoneExternalId;
        }
        break;
      case 'time_estimate':
        if (val != null) payload.time_estimate = Math.round(Number(val) * 3600);
        break;
      case 'time_spent':
        if (val != null) payload.time_spent = Math.round(Number(val) * 3600);
        break;
      default:
        payload[m.tracker_field] = val;
    }
  }

  if (payload.labels) payload.labels = [...payload.labels, ...extraLabels];
  else if (extraLabels.length > 0) payload.labels = extraLabels;

  // Nicht gemappte eigene Felder landen als Markdown ins Kommentarfeld
  const md = taskMarkdown.taskToMarkdown(task, {
    customFieldDefs, subtasks, parent, children, related,
    excludeFields: [...mappedPpFields],
  });
  const parts = [];
  if (descriptionMapped && task.description) parts.push(task.description);
  parts.push(md);
  payload.description = parts.join('\n\n').trim() + '\n';
  if (trackerType === 'github') payload.body = payload.description;

  return { payload, mappedPpFields };
}

/* ===== Pull: externe Issue-Felder → eigene Task-Felder ===== */

const PRIORITIES = ['low', 'normal', 'high', 'critical'];
const ISSUE_TYPES = ['epic', 'user_story', 'task', 'bug'];

function parseLabelMapping(ppField, label, customFieldDefs) {
  if (ppField.startsWith(CUSTOM_FIELD_PREFIX)) {
    const id = ppField.slice(CUSTOM_FIELD_PREFIX.length);
    const def = (customFieldDefs || []).find(d => String(d.id) === String(id));
    const prefix = `${def ? def.name : ppField}: `;
    if (!label.startsWith(prefix)) return null;
    const raw = label.slice(prefix.length);
    switch (def ? def.field_type : 'text') {
      case 'number': { const n = Number(raw); return isNaN(n) ? null : n; }
      case 'checkbox': return raw === 'true' || raw === '1' || raw === 'Ja' || raw === '✅';
      default: return raw;
    }
  }
  const prefix = `${ppField}: `;
  if (!label.startsWith(prefix)) return null;
  const raw = label.slice(prefix.length);
  if (ppField === 'priority') return PRIORITIES.includes(raw) ? raw : null;
  if (ppField === 'issue_type') return ISSUE_TYPES.includes(raw) ? raw : null;
  if (ppField === 'estimated_hours' || ppField === 'spent_hours') {
    const n = Number(raw);
    return isNaN(n) ? null : n;
  }
  return raw;
}

function collectUnmapped(raw, mappedTrackerFields, trackerType) {
  const out = [];
  for (const [key, value] of Object.entries(raw || {})) {
    if (mappedTrackerFields.has(key)) continue;
    if (IGNORE_RAW_FIELDS.has(key)) continue;
    if (value === null || value === undefined || value === '' || value === false) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    if (typeof value === 'object') {
      if (key === 'milestone' && value.title) { out.push([key, value.title]); continue; }
      if (key === 'assignee' && value.username) { out.push([key, value.username]); continue; }
      out.push([key, JSON.stringify(value).slice(0, 200)]);
      continue;
    }
    out.push([key, String(value).slice(0, 200)]);
  }
  return out;
}

function unmappedToMarkdown(unmapped, trackerType) {
  if (!unmapped.length) return '';
  const name = trackerType === 'github' ? 'GitHub' : 'GitLab';
  const lines = ['', `## Zusatzdaten aus ${name} (nicht gemappt)`, '', '| Feld | Wert |', '|------|------|'];
  for (const [k, v] of unmapped) {
    lines.push(`| ${taskMarkdown.escapeMd(k)} | ${taskMarkdown.escapeMd(v)} |`);
  }
  return lines.join('\n');
}

/**
 * Wendet Pull-Mappings auf ein rohes externes Issue an.
 * Rückgabe: { fields, unmappedMarkdown }
 * fields enthält nur gesetzte Werte (title, status, labels, due_date, assignee_id,
 * estimated_hours, spent_hours, custom_fields, milestone_external_id, rawDescription).
 */
function applyPullMapping(trackerType, raw, mappings, { customFieldDefs = [] } = {}) {
  const pull = mappings.filter(m => m.direction === 'pull' || m.direction === 'both');
  const mappedTrackerFields = new Set(pull.map(m => m.tracker_field));
  const fields = {};
  const customFields = {};
  const labelList = Array.isArray(raw.labels)
    ? raw.labels.map(l => (typeof l === 'string' ? l : l && l.name)).filter(Boolean)
    : [];

  for (const m of pull) {
    switch (m.tracker_field) {
      case 'title':
        if (raw.title) fields.title = raw.title;
        break;
      case 'description':
      case 'body':
        fields.rawDescription = raw.description !== undefined ? raw.description : (raw.body || '');
        break;
      case 'state': {
        const s = raw.state;
        fields.status = (s === 'closed') ? 'done' : null; // null = lokal beibehalten
        break;
      }
      case 'labels':
        if (m.pp_field === 'labels') fields.labels = labelList;
        else {
          for (const l of labelList) {
            const parsed = parseLabelMapping(m.pp_field, l, customFieldDefs);
            if (parsed === null) continue;
            if (m.pp_field.startsWith(CUSTOM_FIELD_PREFIX)) {
              customFields[m.pp_field.slice(CUSTOM_FIELD_PREFIX.length)] = parsed;
            } else {
              fields[m.pp_field] = parsed;
            }
            break;
          }
        }
        break;
      case 'due_date':
        if (raw.due_date) fields.due_date = raw.due_date;
        break;
      case 'assignee_username':
      case 'assignees':
        break; // Bearbeiter-Auflösung erfolgt asynchron in issueTracker.applyPullToTask
      case 'milestone':
        if (raw.milestone && raw.milestone.id != null) fields.milestone_external_id = raw.milestone.id;
        break;
      case 'time_estimate':
        if (raw.time_estimate != null) fields.estimated_hours = Number(raw.time_estimate) / 3600;
        break;
      case 'time_spent':
        if (raw.time_spent != null) fields.spent_hours = Number(raw.time_spent) / 3600;
        break;
      default:
        break;
    }
  }

  if (Object.keys(customFields).length > 0) fields.custom_fields = customFields;
  const unmapped = collectUnmapped(raw, mappedTrackerFields, trackerType);
  return { fields, unmappedMarkdown: unmappedToMarkdown(unmapped, trackerType) };
}

module.exports = {
  CUSTOM_FIELD_PREFIX,
  PP_FIELDS,
  TRACKER_FIELDS,
  DIRECTIONS,
  defaultMappings,
  getMappings,
  getAvailablePpFields,
  validateMappings,
  saveMappings,
  buildTrackerPayload,
  applyPullMapping,
};
