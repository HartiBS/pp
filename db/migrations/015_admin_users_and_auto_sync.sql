-- Review-Fixes: Admin-User ohne E-Mail (#54) + projektweiter Auto-Sync (#83)

-- #54: Beim Anlegen durch den Admin reichen Username, Passwort und Rolle.
-- E-Mail ist dann optional (Registrierung durch den User selbst bleibt vollstaendig Pflicht).
ALTER TABLE users ALTER COLUMN email DROP NOT NULL;

-- #83: Projektweite Auto-Sync-Einstellung.
-- Default TRUE: Sobald ein Tracker (GitLab/GitHub) konfiguriert ist, wird beim
-- Speichern eines Tasks automatisch synchronisiert. Pro-Task-Checkbox im Frontend
-- kann dies weiterhin individuell uebersteuern (auto_sync im Request-Body).
ALTER TABLE projects ADD COLUMN IF NOT EXISTS auto_sync BOOLEAN NOT NULL DEFAULT TRUE;
