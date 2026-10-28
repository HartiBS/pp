CREATE TABLE IF NOT EXISTS user_roles (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role VARCHAR(50) NOT NULL
    CHECK (role IN ('admin', 'projektmanager', 'entwickler', 'beobachter')),
  PRIMARY KEY (user_id, role)
);

INSERT INTO user_roles (user_id, role)
SELECT id, role FROM users
ON CONFLICT (user_id, role) DO NOTHING;

CREATE TABLE IF NOT EXISTS role_permissions (
  role VARCHAR(50) NOT NULL
    CHECK (role IN ('admin', 'projektmanager', 'entwickler', 'beobachter')),
  permission VARCHAR(50) NOT NULL,
  PRIMARY KEY (role, permission)
);

INSERT INTO role_permissions (role, permission) VALUES
  ('admin', 'view_project'),
  ('admin', 'edit_project'),
  ('admin', 'delete_project'),
  ('admin', 'manage_members'),
  ('admin', 'create_task'),
  ('admin', 'edit_task'),
  ('admin', 'delete_task'),
  ('admin', 'manage_users'),
  ('admin', 'manage_settings'),
  ('projektmanager', 'view_project'),
  ('projektmanager', 'edit_project'),
  ('projektmanager', 'delete_project'),
  ('projektmanager', 'manage_members'),
  ('projektmanager', 'create_task'),
  ('projektmanager', 'edit_task'),
  ('projektmanager', 'delete_task'),
  ('entwickler', 'view_project'),
  ('entwickler', 'create_task'),
  ('entwickler', 'edit_task'),
  ('beobachter', 'view_project')
ON CONFLICT (role, permission) DO NOTHING;
