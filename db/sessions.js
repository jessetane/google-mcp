import { sqlite } from './index.js'
import { randomUUID } from 'node:crypto'

export {
	init,
	create,
	get,
	getByToken,
	updateTokens,
	pruneExpired
}

function init () {
	sqlite.exec(`
		CREATE TABLE IF NOT EXISTS sessions (
			id TEXT PRIMARY KEY,
			user_id TEXT NOT NULL,
			token TEXT UNIQUE NOT NULL,
			refresh_token TEXT,
			access_token TEXT,
			expires_at INTEGER,
			ip TEXT,
			ua TEXT,
			created TEXT NOT NULL,
			updated TEXT NOT NULL,
			FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
		);
		CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);
		CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
	`)
}

function formatSession (row) {
	if (!row) return null
	return {
		id: row.id,
		userId: row.user_id,
		token: row.token,
		refreshToken: row.refresh_token,
		accessToken: row.access_token,
		expiresAt: row.expires_at,
		ip: row.ip,
		ua: row.ua,
		created: row.created,
		updated: row.updated,
		email: row.email,
		userName: row.user_name
	}
}

function create (opts = {}) {
	const {
		id = randomUUID(),
		userId,
		token = randomUUID(),
		refreshToken = null,
		accessToken = null,
		expiresAt = null,
		ip = null,
		ua = null
	} = opts
	pruneExpired()
	const now = new Date().toISOString()
	sqlite.prepare(`
		INSERT INTO sessions (id, user_id, token, refresh_token, access_token, expires_at, ip, ua, created, updated)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`).run(id, userId, token, refreshToken, accessToken, expiresAt, ip, ua, now, now)
	return get(id)
}

function get (id) {
	if (!id) return null
	const row = sqlite.prepare(`
		SELECT sessions.*, users.email, users.name AS user_name
		FROM sessions
		JOIN users ON sessions.user_id = users.id
		WHERE sessions.id = ?
	`).get(id)
	return formatSession(row)
}

function getByToken (token) {
	if (!token) return null
	const row = sqlite.prepare(`
		SELECT sessions.*, users.email, users.name AS user_name
		FROM sessions
		JOIN users ON sessions.user_id = users.id
		WHERE sessions.token = ?
	`).get(token)
	return formatSession(row)
}

function updateTokens (id, opts = {}) {
	const { accessToken, expiresAt, refreshToken = null } = opts
	const now = new Date().toISOString()
	if (refreshToken) {
		sqlite.prepare(`
			UPDATE sessions
			SET access_token = ?, expires_at = ?, refresh_token = ?, updated = ?
			WHERE id = ?
		`).run(accessToken, expiresAt, refreshToken, now, id)
	} else {
		sqlite.prepare(`
			UPDATE sessions
			SET access_token = ?, expires_at = ?, updated = ?
			WHERE id = ?
		`).run(accessToken, expiresAt, now, id)
	}
	return get(id)
}

function pruneExpired (maxAgeMs = 30 * 24 * 60 * 60 * 1000) {
	const minDate = new Date(Date.now() - maxAgeMs).toISOString()
	sqlite.prepare('DELETE FROM sessions WHERE updated < ?').run(minDate)
}
