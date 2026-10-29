const db = require('../config/database');

const VALID_FIELD_TYPES = ['text', 'number', 'date', 'checkbox', 'dropdown'];

/**
 * Validiert eine Custom-Field-Definition.
 * Gibt { ok, error } zurück.
 */
function validateFieldDefinition({ name, field_type, options, is_required }) {
  if (!name || typeof name !== 'string' || !name.trim()) {
    return { ok: false, error: 'Name ist erforderlich' };
  }
  if (name.trim().length > 100) {
    return { ok: false, error: 'Name darf maximal 100 Zeichen haben' };
  }
  if (!VALID_FIELD_TYPES.includes(field_type)) {
    return { ok: false, error: `Ungültiger Feldtyp. Erlaubt: ${VALID_FIELD_TYPES.join(', ')}` };
  }
  if (field_type === 'dropdown') {
    if (!Array.isArray(options) || options.length === 0) {
      return { ok: false, error: 'Dropdown-Felder benötigen mindestens eine Option' };
    }
    if (options.some(o => !o || typeof o !== 'string' || !o.trim())) {
      return { ok: false, error: 'Dropdown-Optionen dürfen nicht leer sein' };
    }
  }
  return { ok: true };
}

/**
 * Validiert einen Task-Custom-Field-Wert gegen die Definition.
 */
function validateFieldValue(fieldDef, value) {
  if (value === null || value === undefined) {
    return fieldDef.is_required ? { ok: false, error: `"${fieldDef.name}" ist ein Pflichtfeld` } : { ok: true };
  }
  switch (fieldDef.field_type) {
    case 'text':
      if (typeof value !== 'string') return { ok: false, error: `"${fieldDef.name}" muss ein Text sein` };
      break;
    case 'number':
      if (typeof value !== 'number' || isNaN(value)) return { ok: false, error: `"${fieldDef.name}" muss eine Zahl sein` };
      break;
    case 'date':
      if (typeof value !== 'string' || isNaN(Date.parse(value))) {
        return { ok: false, error: `"${fieldDef.name}" muss ein gültiges Datum sein` };
      }
      break;
    case 'checkbox':
      if (typeof value !== 'boolean') return { ok: false, error: `"${fieldDef.name}" muss ein Boolean sein` };
      break;
    case 'dropdown':
      if (typeof value !== 'string' || !fieldDef.options.includes(value)) {
        return { ok: false, error: `"${fieldDef.name}" muss eine der Optionen sein: ${fieldDef.options.join(', ')}` };
      }
      break;
  }
  return { ok: true };
}

/**
 * Holt alle globalen Custom-Field-Definitionen.
 */
async function getAllDefinitions() {
  const { rows } = await db.query(
    'SELECT * FROM custom_field_definitions ORDER BY id ASC'
  );
  return rows;
}

/**
 * Erstellt eine neue Custom-Field-Definition.
 */
async function createDefinition({ name, field_type, options, is_required }) {
  const { rows } = await db.query(
    `INSERT INTO custom_field_definitions (name, field_type, options, is_required)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [name.trim(), field_type, field_type === 'dropdown' ? options : [], is_required || false]
  );
  return rows[0];
}

/**
 * Aktualisiert eine Custom-Field-Definition.
 */
async function updateDefinition(id, { name, field_type, options, is_required }) {
  const { rows } = await db.query(
    `UPDATE custom_field_definitions
     SET name = COALESCE($1, name),
         field_type = COALESCE($2, field_type),
         options = COALESCE($3, options),
         is_required = COALESCE($4, is_required),
         updated_at = NOW()
     WHERE id = $5 RETURNING *`,
    [
      name !== undefined ? name.trim() : null,
      field_type || null,
      field_type === 'dropdown' && Array.isArray(options) ? options : (options !== undefined ? options : null),
      is_required !== undefined ? is_required : null,
      id,
    ]
  );
  return rows[0] || null;
}

/**
 * Löscht eine Custom-Field-Definition (CASCADE löscht auch project_custom_fields).
 */
async function deleteDefinition(id) {
  const { rowCount } = await db.query(
    'DELETE FROM custom_field_definitions WHERE id = $1',
    [id]
  );
  return rowCount > 0;
}

/**
 * Holt die für ein Projekt aktivierten Custom-Field-Definitionen.
 */
async function getProjectFieldDefinitions(projectId) {
  const { rows } = await db.query(
    `SELECT cfd.*, pcf.is_enabled, pcf.position
     FROM custom_field_definitions cfd
     JOIN project_custom_fields pcf ON pcf.field_definition_id = cfd.id
     WHERE pcf.project_id = $1
     ORDER BY pcf.position ASC, cfd.id ASC`,
    [projectId]
  );
  return rows;
}

/**
 * Holt alle Definitionen mit ihrem Aktivierungsstatus für ein Projekt.
 */
async function getProjectFieldDefinitionsWithStatus(projectId) {
  const { rows } = await db.query(
    `SELECT cfd.*,
            COALESCE(pcf.is_enabled, FALSE) AS is_enabled,
            COALESCE(pcf.position, 0) AS position
     FROM custom_field_definitions cfd
     LEFT JOIN project_custom_fields pcf ON pcf.field_definition_id = cfd.id AND pcf.project_id = $1
     ORDER BY cfd.id ASC`,
    [projectId]
  );
  return rows;
}

/**
 * Aktiviert/Deaktiviert Custom Fields für ein Projekt (Bulk-Update).
 * @param {number} projectId
 * @param {Array<{field_definition_id: number, is_enabled: boolean}>} fields
 */
async function setProjectFields(projectId, fields) {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    // Erst alle bestehenden Einträge für dieses Projekt löschen
    await client.query(
      'DELETE FROM project_custom_fields WHERE project_id = $1',
      [projectId]
    );
    // Dann die aktivierten neu einfügen
    let position = 0;
    for (const f of fields) {
      if (f.is_enabled) {
        await client.query(
          `INSERT INTO project_custom_fields (project_id, field_definition_id, is_enabled, position)
           VALUES ($1, $2, TRUE, $3)`,
          [projectId, f.field_definition_id, position++]
        );
      }
    }
    await client.query('COMMIT');
    return true;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Validiert und bereinigt custom_fields eines Tasks gegen die aktiven Projekt-Definitionen.
 * Gibt { ok, error, cleaned } zurück.
 */
async function validateTaskCustomFields(projectId, customFields) {
  if (!customFields || typeof customFields !== 'object' || Array.isArray(customFields)) {
    return { ok: true, cleaned: {} };
  }
  const activeDefs = await getProjectFieldDefinitions(projectId);
  const cleaned = {};
  for (const def of activeDefs) {
    const key = String(def.id);
    const value = customFields[key];
    const result = validateFieldValue(def, value);
    if (!result.ok) {
      return { ok: false, error: result.error };
    }
    if (value !== null && value !== undefined) {
      cleaned[key] = value;
    }
  }
  // Prüfe auf Pflichtfelder
  for (const def of activeDefs) {
    const key = String(def.id);
    if (def.is_required && (cleaned[key] === undefined || cleaned[key] === null)) {
      return { ok: false, error: `"${def.name}" ist ein Pflichtfeld` };
    }
  }
  return { ok: true, cleaned };
}

module.exports = {
  VALID_FIELD_TYPES,
  validateFieldDefinition,
  validateFieldValue,
  getAllDefinitions,
  createDefinition,
  updateDefinition,
  deleteDefinition,
  getProjectFieldDefinitions,
  getProjectFieldDefinitionsWithStatus,
  setProjectFields,
  validateTaskCustomFields,
};
