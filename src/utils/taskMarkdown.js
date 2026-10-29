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
 * @returns {string} Markdown-String
 */
function taskToMarkdown(task, { customFieldDefs = [], subtasks = [] } = {}) {
  const meta = {
    pp: true,
    status: task.status,
    priority: task.priority || 'normal',
    issue_type: task.issue_type || 'task',
    labels: task.labels || [],
    due_date: task.due_date || null,
    estimated_hours: task.estimated_hours != null ? Number(task.estimated_hours) : null,
    spent_hours: task.spent_hours != null ? Number(task.spent_hours) : null,
    custom_fields: task.custom_fields || {},
  };

  const lines = [];

  // Metadaten-Block (unsichtbar in GitLab-Rendering)
  lines.push(`${META_START}${JSON.stringify(meta)}${META_END}`);
  lines.push('');

  // Menschenlesbarer Metadaten-Bereich
  lines.push('---');
  lines.push('');
  lines.push(`**Typ:** ${TYPE_LABELS[meta.issue_type] || meta.issue_type}  `);
  lines.push(`**Status:** ${STATUS_LABELS[meta.status] || meta.status}  `);
  lines.push(`**Priorität:** ${PRIORITY_LABELS[meta.priority] || meta.priority}`);
  if (meta.due_date) {
    lines.push(`**Fällig:** ${meta.due_date}  `);
  }
  if (meta.estimated_hours != null || meta.spent_hours != null) {
    const parts = [];
    if (meta.estimated_hours != null) parts.push(`Geschätzt: ${meta.estimated_hours}h`);
    if (meta.spent_hours != null) parts.push(`Aufgewendet: ${meta.spent_hours}h`);
    lines.push(`**Zeit:** ${parts.join(' · ')}  `);
  }
  if (meta.labels.length > 0) {
    lines.push(`**Labels:** ${meta.labels.map(l => `\`${l}\``).join(' ')}`);
  }
  lines.push('');
  lines.push('---');
  lines.push('');

  // Beschreibung (Freitext)
  if (task.description) {
    lines.push('## Beschreibung');
    lines.push('');
    lines.push(task.description);
    lines.push('');
  }

  // Custom Fields
  if (customFieldDefs.length > 0 && Object.keys(meta.custom_fields).length > 0) {
    lines.push('## Zusatzfelder');
    lines.push('');
    lines.push('| Feld | Wert |');
    lines.push('|------|------|');
    for (const def of customFieldDefs) {
      const key = String(def.id);
      const value = meta.custom_fields[key];
      if (value === null || value === undefined) continue;
      const displayValue = def.field_type === 'checkbox'
        ? (value ? '✅ Ja' : '❌ Nein')
        : String(value);
      lines.push(`| ${escapeMd(def.name)} | ${escapeMd(displayValue)} |`);
    }
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

  return lines.join('\n').trim() + '\n';
}

/**
 * Parst eine Markdown-Beschreibung (von GitLab) zurück in Task-Felder.
 *
 * @param {string} markdown - Die Markdown-Beschreibung
 * @returns {{ meta: object|null, description: string }} Extrahierte Felder
 */
function markdownToTaskFields(markdown) {
  if (!markdown || typeof markdown !== 'string') {
    return { meta: null, description: '' };
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
  return { meta, description: description || '' };
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

module.exports = {
  taskToMarkdown,
  markdownToTaskFields,
  META_START,
  META_END,
};
