-- Pro-Issue-Sync: Sobald fuer einen Task einmal der Sync mit dem externen
-- Tracker aktiviert wurde (Issue existiert/angelegt), darf der Sync nicht mehr
-- ausgeschaltet werden. sync_active = TRUE wird bei der ersten erfolgreichen
-- Synchronisation gesetzt und nie wieder zurueckgesetzt.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS sync_active BOOLEAN NOT NULL DEFAULT FALSE;

-- Bestand: Tasks mit verknuepftem externen Issue gelten als synchronisiert.
UPDATE tasks SET sync_active = TRUE WHERE gitlab_iid IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_tasks_sync_active ON tasks(sync_active);
