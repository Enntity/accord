
CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE leader(singleton INTEGER PRIMARY KEY CHECK(singleton=1), token TEXT NOT NULL, epoch INTEGER NOT NULL, until_ms INTEGER NOT NULL);
CREATE TABLE actors(id TEXT PRIMARY KEY, token_hash TEXT UNIQUE NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','worker')));
CREATE TABLE resources(id TEXT PRIMARY KEY, generation INTEGER NOT NULL DEFAULT 0);
CREATE TABLE tasks(id TEXT PRIMARY KEY, title TEXT NOT NULL, input TEXT NOT NULL, expected_hash TEXT NOT NULL,
 resource TEXT NOT NULL REFERENCES resources(id), dependency TEXT REFERENCES tasks(id), state TEXT NOT NULL,
 checkpoint TEXT, result TEXT, created_at INTEGER NOT NULL, max_attempts INTEGER NOT NULL);
CREATE TABLE claims(id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), resource TEXT NOT NULL REFERENCES resources(id),
 actor TEXT NOT NULL REFERENCES actors(id), generation INTEGER NOT NULL, state TEXT NOT NULL,
 deadline INTEGER NOT NULL, outcome TEXT, error TEXT, result TEXT, created_at INTEGER NOT NULL);
CREATE UNIQUE INDEX one_holder ON claims(resource) WHERE state IN ('preparing','running','releasing','revoking');
CREATE UNIQUE INDEX one_attempt ON claims(task_id) WHERE state IN ('preparing','running','releasing','revoking');
CREATE TABLE commands(actor TEXT NOT NULL, key TEXT NOT NULL, payload_hash TEXT NOT NULL, response TEXT NOT NULL, PRIMARY KEY(actor,key));
CREATE TABLE events(seq INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL);
