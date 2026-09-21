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
		CREATE TABLE IF NOT EXISTS oauth_states (
			state TEXT PRIMARY KEY,
			client_redirect_uri TEXT,
			client_state TEXT,
			code_challenge TEXT,
			code_challenge_method TEXT,
			ip TEXT,
			created_at INTEGER NOT NULL
		);
		CREATE INDEX IF NOT EXISTS idx_oauth_states_created ON oauth_states(created_at);
	`)
	const columns = sqlite.prepare('PRAGMA table_info(oauth_states)').all().map(c => c.name)
	if (!columns.includes('code_challenge')) sqlite.exec('ALTER TABLE oauth_states ADD COLUMN code_challenge TEXT;')
	if (!columns.includes('code_challenge_method')) sqlite.exec('ALTER TABLE oauth_states ADD COLUMN code_challenge_method TEXT;')
}

function create (opts = {}) {
	const { clientRedirectUri = null, clientState = null, codeChallenge = null, codeChallengeMethod = null, ip = null } = opts
	pruneExpired()
	const state = randomBytes(24).toString('base64url')
	const now = Date.now()
	sqlite.prepare(`
		INSERT INTO oauth_states (state, client_redirect_uri, client_state, code_challenge, code_challenge_method, ip, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?)
	`).run(state, clientRedirectUri, clientState, codeChallenge, codeChallengeMethod, ip, now)
	return state
}

function consume (state) {
	if (!state) return null
	pruneExpired()
	const row = sqlite.prepare('SELECT * FROM oauth_states WHERE state = ?').get(state)
	if (!row) return null
	sqlite.prepare('DELETE FROM oauth_states WHERE state = ?').run(state)
	return {
		state: row.state,
		clientRedirectUri: row.client_redirect_uri,
		clientState: row.client_state,
		codeChallenge: row.code_challenge,
		codeChallengeMethod: row.code_challenge_method,
		ip: row.ip,
		createdAt: row.created_at
	}
}

function pruneExpired (maxAgeMs = 15 * 60 * 1000) {
	const minTime = Date.now() - maxAgeMs
	sqlite.prepare('DELETE FROM oauth_states WHERE created_at < ?').run(minTime)
}
