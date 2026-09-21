import { sqlite } from './index.js'
import { randomUUID } from 'node:crypto'

export {
	init,
	upsert,
	getByEmail
}

function init () {
	sqlite.exec(`
		CREATE TABLE IF NOT EXISTS users (
			id TEXT PRIMARY KEY,
			email TEXT UNIQUE NOT NULL,
			name TEXT,
			picture TEXT,
			created TEXT NOT NULL,
			updated TEXT NOT NULL
		);
		CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
	`)
}

function upsert (opts = {}) {
	const { id = randomUUID(), email, name = null, picture = null } = opts
	const now = new Date().toISOString()
	const normalizedEmail = email.toLowerCase()
	sqlite.prepare(`
		INSERT INTO users (id, email, name, picture, created, updated)
		VALUES (?, ?, ?, ?, ?, ?)
		ON CONFLICT(email) DO UPDATE SET
			name = COALESCE(excluded.name, users.name),
			picture = COALESCE(excluded.picture, users.picture),
			updated = excluded.updated
	`).run(id, normalizedEmail, name, picture, now, now)
	return getByEmail(normalizedEmail)
}

function getByEmail (email) {
	if (!email) return null
	return sqlite.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase()) || null
}
