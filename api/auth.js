import * as db from '../db/index.js'
import { getFreshGoogleToken, getUserInfo, revokeGoogleToken } from '../google.js'
import { parsePolicy } from '../policy.js'

export {
	whoami,
	list,
	get,
	revoke
}

async function whoami (token) {
	const appUrl = process.env.APP_URL || 'http://localhost:8080'
	const session = db.sessions.getByToken(token)
	if (!session) {
		return {
			authenticated: false,
			signInUrl: `${appUrl.replace(/\/$/, '')}/oauth/authorize`,
			message: 'Missing or expired Google Bearer token.'
		}
	}
	let authInfo = null
	try {
		authInfo = await getFreshGoogleToken(token)
	} catch (err) {
		const error = new Error(`Failed to refresh Google access token: ${err.message}`)
		error.status = 401
		throw error
	}
	return {
		authenticated: true,
		email: session.email,
		scope: session.scope ?? null,
		policy: parsePolicy(session.policy),
		currentSession: {
			id: session.id,
			ip: session.ip,
			ua: session.ua,
			created: session.created,
			updated: session.updated
		}
	}
}

async function list (token) {
	const appUrl = process.env.APP_URL || 'http://localhost:8080'
	const session = db.sessions.getByToken(token)
	if (!session) {
		const error = new Error(`Authentication required: ${appUrl.replace(/\/$/, '')}/oauth/authorize`)
		error.status = 401
		throw error
	}
	const rawSessions = db.sessions.listByUserId(session.userId)
	const sessions = rawSessions.map(s => ({ ...s, policy: parsePolicy(s.policy), isCurrent: s.id === session.id }))
	return { sessions }
}

async function get (token, sessionId) {
	const appUrl = process.env.APP_URL || 'http://localhost:8080'
	const session = db.sessions.getByToken(token)
	if (!session) {
		const error = new Error(`Authentication required: ${appUrl.replace(/\/$/, '')}/oauth/authorize`)
		error.status = 401
		throw error
	}
	const targetSession = db.sessions.get(sessionId)
	if (!targetSession || targetSession.userId !== session.userId) {
		const error = new Error(`Session not found: ${sessionId}`)
		error.status = 404
		throw error
	}
	return {
		session: {
			...targetSession,
			policy: parsePolicy(targetSession.policy),
			isCurrent: targetSession.id === session.id
		}
	}
}

async function revoke (token, { sessionId, allOthers } = {}) {
	const session = db.sessions.getByToken(token)
	if (!session) {
		return {
			revoked: false,
			message: 'No active session found for the provided token.'
		}
	}
	if (allOthers) {
		const userSessions = db.sessions.listByUserId(session.userId)
		const others = userSessions.filter(s => s.id !== session.id)
		for (const s of others) {
			const fullSession = db.sessions.get(s.id)
			if (fullSession) {
				const upstreamToken = fullSession.refreshToken || fullSession.accessToken
				if (upstreamToken) await revokeGoogleToken(upstreamToken)
				db.sessions.remove(fullSession.id)
			}
		}
		return {
			revoked: true,
			count: others.length,
			message: `Revoked ${others.length} other session(s).`
		}
	}
	if (sessionId) {
		const targetSession = db.sessions.get(sessionId)
		if (!targetSession || targetSession.userId !== session.userId) {
			return {
				revoked: false,
				message: `Session not found: ${sessionId}`
			}
		}
		const upstreamToken = targetSession.refreshToken || targetSession.accessToken
		if (upstreamToken) await revokeGoogleToken(upstreamToken)
		db.sessions.remove(targetSession.id)
		return {
			revoked: true,
			sessionId: targetSession.id,
			isCurrent: targetSession.id === session.id,
			message: 'Session revoked.'
		}
	}
	const upstreamToken = session.refreshToken || session.accessToken
	if (upstreamToken) await revokeGoogleToken(upstreamToken)
	db.sessions.remove(session.id)
	return {
		revoked: true,
		sessionId: session.id,
		isCurrent: true,
		message: 'Current session revoked.'
	}
}
