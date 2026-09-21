import { sqlite } from './index.js'
import { randomBytes } from 'node:crypto'

export {
	init,
	create,
	consume,
	pruneExpired
}

function init () {
	sqlite.exec(`
		CREATE TABLE IF NOT EXISTS oauth_codes (
			code TEXT PRIMARY KEY,
			session_id TEXT NOT NULL,
			client_redirect_uri TEXT,
			code_challenge TEXT,
			code_challenge_method TEXT,
			created_at INTEGER NOT NULL,
			FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
		);
		CREATE INDEX IF NOT EXISTS idx_oauth_codes_created ON oauth_codes(created_at);
	`)
	const columns = sqlite.prepare('PRAGMA table_info(oauth_codes)').all().map(c => c.name)
	if (!columns.includes('code_challenge')) sqlite.exec('ALTER TABLE oauth_codes ADD COLUMN code_challenge TEXT;')
	if (!columns.includes('code_challenge_method')) sqlite.exec('ALTER TABLE oauth_codes ADD COLUMN code_challenge_method TEXT;')
}

function create (opts = {}) {
	const { sessionId, clientRedirectUri = null, codeChallenge = null, codeChallengeMethod = null } = opts
	pruneExpired()
	const code = randomBytes(24).toString('base64url')
	const now = Date.now()
	sqlite.prepare(`
		INSERT INTO oauth_codes (code, session_id, client_redirect_uri, code_challenge, code_challenge_method, created_at)
		VALUES (?, ?, ?, ?, ?, ?)
	`).run(code, sessionId, clientRedirectUri, codeChallenge, codeChallengeMethod, now)
	return code
}

function consume (code) {
	if (!code) return null
	pruneExpired()
	const row = sqlite.prepare('SELECT * FROM oauth_codes WHERE code = ?').get(code)
	if (!row) return null
	sqlite.prepare('DELETE FROM oauth_codes WHERE code = ?').run(code)
	return {
		code: row.code,
		sessionId: row.session_id,
		clientRedirectUri: row.client_redirect_uri,
		codeChallenge: row.code_challenge,
		codeChallengeMethod: row.code_challenge_method,
		createdAt: row.created_at
	}
}

function pruneExpired (maxAgeMs = 10 * 60 * 1000) {
	const minTime = Date.now() - maxAgeMs
	sqlite.prepare('DELETE FROM oauth_codes WHERE created_at < ?').run(minTime)
}
