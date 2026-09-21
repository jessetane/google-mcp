import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import * as users from './users.js'
import * as sessions from './sessions.js'
import * as oauthStates from './oauth-states.js'
import * as oauthCodes from './oauth-codes.js'

const dbPath = process.env.DB_PATH || './data.db'

const prevUmask = process.umask(0o077)
const sqlite = new DatabaseSync(dbPath)
process.umask(prevUmask)

sqlite.exec('PRAGMA journal_mode = WAL;')
sqlite.exec('PRAGMA foreign_keys = ON;')

for (const ext of ['', '-wal', '-shm']) {
	const file = `${dbPath}${ext}`
	if (fs.existsSync(file)) fs.chmodSync(file, 0o600)
}

users.init()
sessions.init()
oauthStates.init()
oauthCodes.init()
sessions.pruneExpired()

export {
	sqlite,
	users,
	sessions,
	oauthStates,
	oauthCodes
}
