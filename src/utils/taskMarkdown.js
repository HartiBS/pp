/**
 * Issue #72: Übersetzt strukturierte Task-Daten in Markdown (für GitLab-Push)
 * und parst Markdown zurück in Task-Felder (für GitLab-Pull).
 *
 * Der Metadaten-Block wird als HTML-Kommentar mit JSON-Payload eingebettet:
 *   <!-- pp-meta {"priority":"high","labels":["bug"],"..."} -->
 * Das bleibt in GitLab unsichtbar, ist aber maschinenlesbar.
 */

const META_START = '<!-- pp-meta ';
const META_END = ' -->';

const STATUS_LABELS = {
  todo: 'To Do',
  in_progress: 'In Progress',
  review: 'Review',
  done: 'Done',
};

const PRIORITY_LABELS = {
  low: 'Niedrig',
  normal: 'Normal',
  high: 'Hoch',
  critical: 'Kritisch',
};

const TYPE_LABELS = {
  task: 'Task',
  user_story: 'User Story',
  epic: 'Epic',
  bug: 'Bug',
};

/**
 * Konvertiert einen Task in eine Markdown-Beschreibung für GitLab.
 *
 * @param {object} task - Der Task (aus DB)
 * @param {object} opts - Optionen
 * @param {Array}  opts.customFieldDefs - Aktive Custom-Field-Definitionen des Projekts
 * @param {Array}  opts.subtasks - Subtasks des Tasks
 * @param {Array}  opts.excludeFields - Eigene Felder (pp_field-Namen, z. B. 'status',
 *                   'custom_field:3'), die bereits ueber das Tracker-Mapping in ein
 *                   externes Feld geschrieben werden und deshalb NICHT zusaetzlich
 *                   in den Markdown-Block aufgenommen werden sollen.
 * @returns {string} Markdown-String
 */
function taskToMarkdown(task, { customFieldDefs = [], subtasks = [], parent = null, children = [], related = [], excludeFields = [] } = {}) {
  const excluded = new Set(excludeFields);
  const meta = { pp: true };
  if (!excluded.has('status')) meta.status = task.status;
  if (!excluded.has('priority')) meta.priority = task.priority || 'normal';
  if (!excluded.has('issue_type')) meta.issue_type = task.issue_type || 'task';
  if (!excluded.has('labels')) meta.labels = task.labels || [];
  if (!excluded.has('due_date')) meta.due_date = task.due_date || null;
  if (!excluded.has('estimated_hours')) meta.estimated_hours = task.estimated_hours != null ? Number(task.estimated_hours) : null;
  if (!excluded.has('spent_hours')) meta.spent_hours = task.spent_hours != null ? Number(task.spent_hours) : null;
  const metaCustomFields = {};
  for (const [k, v] of Object.entries(task.custom_fields || {})) {
    if (!excluded.has(`custom_field:${k}`)) metaCustomFields[k] = v;
  }
  meta.custom_fields = metaCustomFields;

  // #74: Parent/Child-Relationen in Meta-Block aufnehmen
  if (parent) {
    meta.parent = { id: parent.id, title: parent.title, gitlab_iid: parent.gitlab_iid || null };
  }
  if (children && children.length > 0) {
    meta.children = children.map(c => ({ id: c.id, title: c.title, gitlab_iid: c.gitlab_iid || null }));
  }
  if (related && related.length > 0) {
    meta.related = related.map(r => ({ id: r.id, title: r.title, gitlab_iid: r.gitlab_iid || null, direction: r.direction }));
  }

  const lines = [];

  // Metadaten-Block (unsichtbar in GitLab-Rendering)
  lines.push(`${META_START}${JSON.stringify(meta)}${META_END}`);
  lines.push('');

  // Menschenlesbarer Metadaten-Bereich (nur Felder, die nicht extern gemappt sind):
  // jedes Feld als eigene Markdown-Überschrift mit dem Wert darunter.
  if (meta.issue_type) {
    lines.push('## Typ');
    lines.push('');
    lines.push(TYPE_LABELS[meta.issue_type] || meta.issue_type);
    lines.push('');
  }
  if (meta.status) {
    lines.push('## Status');
    lines.push('');
    lines.push(STATUS_LABELS[meta.status] || meta.status);
    lines.push('');
  }
  if (meta.priority) {
    lines.push('## Priorität');
    lines.push('');
    lines.push(PRIORITY_LABELS[meta.priority] || meta.priority);
    lines.push('');
  }
  if (meta.due_date) {
    lines.push('## Fälligkeitsdatum');
    lines.push('');
    lines.push(meta.due_date);
    lines.push('');
  }
  if (meta.estimated_hours != null || meta.spent_hours != null) {
    const parts = [];
    if (meta.estimated_hours != null) parts.push(`Geschätzt: ${meta.estimated_hours}h`);
    if (meta.spent_hours != null) parts.push(`Aufgewendet: ${meta.spent_hours}h`);
    lines.push('## Zeiterfassung');
    lines.push('');
    lines.push(parts.join(' · '));
    lines.push('');
  }
  if (meta.labels && meta.labels.length > 0) {
    lines.push('## Labels');
    lines.push('');
    lines.push(meta.labels.map(l => `\`${l}\``).join(' '));
    lines.push('');
  }

  // Beschreibung (Freitext)
  if (task.description) {
    lines.push('## Beschreibung');
    lines.push('');
    lines.push(task.description);
    lines.push('');
  }

  // Custom Fields: jedes Feld als eigene Markdown-Überschrift mit dem Wert darunter
  for (const def of customFieldDefs) {
    const key = String(def.id);
    const value = meta.custom_fields[key];
    if (value === null || value === undefined) continue;
    const displayValue = def.field_type === 'checkbox'
      ? (value ? '✅ Ja' : '❌ Nein')
      : String(value);
    lines.push(`## ${def.name}`);
    lines.push('');
    lines.push(displayValue);
    lines.push('');
  }

  // Subtasks / Checkliste
  if (subtasks.length > 0) {
    lines.push('## Checkliste');
    lines.push('');
    for (const s of subtasks) {
      const checkbox = s.is_done ? '- [x]' : '- [ ]';
      const assignee = s.assignee_name ? ` (@${s.assignee_name})` : '';
      lines.push(`${checkbox} ${escapeMd(s.title)}${assignee}`);
    }
    const doneCount = subtasks.filter(s => s.is_done).length;
    lines.push('');
    lines.push(`*Fortschritt: ${doneCount}/${subtasks.length} erledigt*`);
    lines.push('');
  }

  // #74: Verknüpfte Tasks (Parent/Children/Related)
  if (parent || (children && children.length > 0) || (related && related.length > 0)) {
    lines.push('## Verknüpfte Tasks');
    lines.push('');
    if (parent) {
      lines.push(`- **⬆ Parent:** ${escapeMd(parent.title)}`);
    }
    if (children && children.length > 0) {
      lines.push(`- **⬇ Children (${children.length}):**`);
      for (const c of children) {
        lines.push(`  - ${escapeMd(c.title)}`);
      }
    }
    if (related && related.length > 0) {
      lines.push(`- **🔗 Verknüpft (${related.length}):**`);
      for (const r of related) {
        const arrow = r.direction === 'parent' ? '←' : '→';
        lines.push(`  - ${arrow} ${escapeMd(r.title)}`);
      }
    }
    lines.push('');
  }

  return lines.join('\n').trim() + '\n';
}

/**
 * Parst eine Markdown-Beschreibung (von GitLab/GitHub) zurück in Task-Felder.
 *
 * @param {string} markdown - Die Markdown-Beschreibung
 * @param {object} [opts]
 * @param {Array}  [opts.customFieldDefs] - Aktive Custom-Field-Definitionen des Projekts.
 *   Wird die menschenlesbare "## Zusatzfelder"-Tabelle gefunden, werden die Werte
 *   anhand der Definitionen (Name + Typ) zurück in custom_fields übernommen.
 * @returns {{ meta: object|null, description: string, customFields: object }}
 */
function markdownToTaskFields(markdown, { customFieldDefs = [] } = {}) {
  if (!markdown || typeof markdown !== 'string') {
    return { meta: null, description: '', customFields: {} };
  }

  // Metadaten-Block extrahieren
  let meta = null;
  let description = markdown;

  const startIdx = markdown.indexOf(META_START);
  if (startIdx !== -1) {
    const endIdx = markdown.indexOf(META_END, startIdx);
    if (endIdx !== -1) {
      const jsonStr = markdown.slice(startIdx + META_START.length, endIdx).trim();
      try {
        const parsed = JSON.parse(jsonStr);
        if (parsed && parsed.pp === true) {
          meta = parsed;
        }
      } catch {
        // Ungültiges JSON im Meta-Block — ignorieren, Beschreibung 1:1 übernehmen
      }
      // Meta-Block aus der Beschreibung entfernen (inkl. berikutender Leerzeile)
      let removeEnd = endIdx + META_END.length;
      // Überspringe folgende Leerzeilen
      while (removeEnd < markdown.length && markdown[removeEnd] === '\n') removeEnd++;
      description = (markdown.slice(0, startIdx) + markdown.slice(removeEnd)).trim();
    }
  }

  // Wenn kein Meta-Block gefunden: Beschreibung 1:1 (Abwärtskompatibilität)
  const customFields = parseCustomFieldsSection(description, customFieldDefs);
  if (Object.keys(customFields).length > 0) {
    description = stripCustomFieldsSection(description);
  }
  return { meta, description: description || '', customFields };
}

/**
 * Parst den menschenlesbaren "## Zusatzfelder"-Markdown-Block (Tabelle
 * | Feld | Wert |) zurück in custom_fields-Werte anhand der Definitionen.
 */
function parseCustomFieldsSection(markdown, customFieldDefs) {
  const result = {};
  if (!customFieldDefs || !customFieldDefs.length) return result;
  const sectionRe = /^##\s+Zusatzfelder\s*$/im;
  const match = sectionRe.exec(markdown);
  if (!match) return result;
  const rest = markdown.slice(match.index + match[0].length);
  const tableRe = /\|\s*Feld\s*\|\s*Wert\s*\|/i;
  const tableMatch = tableRe.exec(rest);
  if (!tableMatch) return result;
  const tableLines = rest.slice(tableMatch.index).split('\n');
  for (const line of tableLines) {
    const rowMatch = /^\|\s*([^|]+?)\s*\|\s*([^|]*?)\s*\|\s*$/.exec(line.trim());
    if (!rowMatch) {
      if (line.trim() === '' || /^\|[-\s|]+\|$/.test(line.trim())) continue;
      break;
    }
    const name = unescapeMd(rowMatch[1].trim());
    const rawValue = unescapeMd(rowMatch[2].trim());
    if (!name || rawValue === '') continue;
    const def = customFieldDefs.find(d => d.name === name);
    if (!def) continue;
    const value = coerceCustomFieldValue(def, rawValue);
    if (value !== null) result[String(def.id)] = value;
  }
  return result;
}

/**
 * Entfernt den "## Zusatzfelder"-Block inkl. Tabelle aus der Beschreibung.
 */
function stripCustomFieldsSection(markdown) {
  const lines = String(markdown).split('\n');
  const out = [];
  let skipping = false;
  for (const line of lines) {
    if (/^##\s+Zusatzfelder\s*$/i.test(line.trim())) {
      skipping = true;
      continue;
    }
    if (skipping && /^##\s/.test(line.trim())) skipping = false;
    if (!skipping) out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function unescapeMd(str) {
  return str.replace(/\\\|/g, '|').replace(/\\\\/g, '\\');
}

function coerceCustomFieldValue(def, raw) {
  switch (def.field_type) {
    case 'number': {
      const n = Number(raw.replace(',', '.'));
      return isNaN(n) ? null : n;
    }
    case 'checkbox':
      return raw === '✅ Ja' || raw === 'true' || raw === '1' || raw === 'Ja';
    case 'date':
      return isNaN(Date.parse(raw)) ? null : raw;
    case 'dropdown':
      return (def.options || []).includes(raw) ? raw : null;
    default:
      return raw;
  }
}

/**
 * Hilfsfunktion: Maskiert Sonderzeichen für Markdown-Tabellen.
 * Entschärft zuerst Backslashes (sonst doppeltes Escaping), dann Pipes
 * und ersetzt Zeilenumbrüche durch Leerzeichen.
 */
function escapeMd(str) {
  return String(str)
    .replace(/\\/g, '\\\\')   // Backslash zuerst escapen
    .replace(/\|/g, '\\|')     // Pipe escapen
    .replace(/\r?\n/g, ' ');   // Zeilenumbrüche entfernen
}

/**
 * Bettet Custom-Field-Werte in eine bestehende Markdown-Beschreibung ein
 * (z. B. GitHub-Issue-Body): aktualisiert den pp-meta-JSON-Block und schreibt
 * die menschenlesbare "## Zusatzfelder"-Tabelle neu bzw. legt sie an.
 * @returns {string} aktualisierter Markdown-String
 */
function mergeCustomFieldsIntoMarkdown(markdown, customFieldDefs, values) {
  const body = typeof markdown === 'string' ? markdown : '';
  const parsed = markdownToTaskFields(body, { customFieldDefs });
  const merged = { ...(parsed.customFields || {}), ...(parsed.meta && parsed.meta.custom_fields ? parsed.meta.custom_fields : {}), ...(values || {}) };
  let out = parsed.description || '';

  // pp-meta-Block aktualisieren (an erster Stelle neu einfuegen, falls vorhanden)
  if (parsed.meta) {
    parsed.meta.custom_fields = merged;
    out = `${META_START}${JSON.stringify(parsed.meta)}${META_END}\n\n${out}`.trim() + '\n';
  }

  // Menschenlesbare Tabelle neu schreiben
  const defsWithValues = (customFieldDefs || []).filter(d => merged[String(d.id)] !== undefined && merged[String(d.id)] !== null);
  if (defsWithValues.length > 0) {
    const lines = ['', '## Zusatzfelder', '', '| Feld | Wert |', '|------|------|'];
    for (const def of customFieldDefs) {
      const value = merged[String(def.id)];
      if (value === undefined || value === null) continue;
      const displayValue = def.field_type === 'checkbox'
        ? (value ? '\u2705 Ja' : '\u274c Nein')
        : String(value);
      lines.push(`| ${escapeMd(def.name)} | ${escapeMd(displayValue)} |`);
    }
    out = stripCustomFieldsSection(out).trim() + '\n\n' + lines.join('\n') + '\n';
  }
  return out.trim() + '\n';
}

module.exports = {
  taskToMarkdown,
  markdownToTaskFields,
  parseCustomFieldsSection,
  mergeCustomFieldsIntoMarkdown,
  escapeMd,
  META_START,
  META_END,
};
