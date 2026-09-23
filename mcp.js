import * as db from './db/index.js'
import { proxyGoogleApi, getFreshGoogleToken, getUserInfo, revokeGoogleToken } from './google.js'

export {
	tools,
	executeTool
}

const tools = [
	{
		name: 'auth',
		description: 'Inspect authentication status, list active sessions for the current user, or revoke sessions.',
		inputSchema: {
			type: 'object',
			properties: {
				action: {
					type: 'string',
					enum: ['status', 'list', 'revoke'],
					description: 'Action to perform: "status" (check current authentication state and session info), "list" (list all active sessions for current user), or "revoke" (revoke current session, a specific session by sessionId, or all other sessions). Defaults to "status".'
				},
				sessionId: {
					type: 'string',
					description: 'Specific session ID to revoke when action is "revoke". Omit to revoke the current session.'
				},
				allOthers: {
					type: 'boolean',
					description: 'When action is "revoke", set to true to revoke all other active sessions for this user except the current session.'
				}
			}
		}
	},
	{
		name: 'google_api',
		description: 'Make HTTP requests directly to Google APIs (e.g. Drive, Docs, Sheets, Calendar, Gmail, Tasks) restricted to *.googleapis.com. Automatically attaches the user\'s Google OAuth Bearer token.',
		inputSchema: {
			type: 'object',
			properties: {
				url: {
					type: 'string',
					description: 'Full https://*.googleapis.com URL or relative path (e.g. "drive/v3/files", "calendar/v3/calendars/primary/events", or "https://sheets.googleapis.com/v4/spreadsheets/ID").'
				},
				method: {
					type: 'string',
					description: 'HTTP method (GET, POST, PUT, PATCH, DELETE). Defaults to GET.'
				},
				query: {
					type: 'object',
					description: 'Query parameters as key-value pairs.'
				},
				body: {
					type: ['object', 'string'],
					description: 'JSON body object or string payload for POST/PUT/PATCH requests.'
				},
				headers: {
					type: 'object',
					description: 'Optional additional HTTP headers to include with the request.'
				}
			},
			required: ['url']
		}
	}
]

async function executeTool (name, args = {}, token) {
	if (name === 'auth') {
		const action = args.action || 'status'
		const appUrl = process.env.APP_URL || 'http://localhost:8080'
		const session = db.sessions.getByToken(token)
		if (action === 'status') {
			if (session) {
				let googleToken = null
				try {
					const authInfo = await getFreshGoogleToken(token)
					googleToken = authInfo?.token || null
				} catch (err) {
					console.warn('Failed to refresh Google token during status check:', err.message)
				}
				if (googleToken) {
					try {
						const user = await getUserInfo(googleToken)
						return {
							content: [{
								type: 'text',
								text: JSON.stringify({
									authenticated: true,
									email: user.email,
									scope: session.scope ?? null,
									currentSession: {
										id: session.id,
										ip: session.ip,
										ua: session.ua,
										created: session.created,
										updated: session.updated
									}
								}, null, '\t')
							}]
						}
					} catch (err) {
						return {
							isError: true,
							content: [{
								type: 'text',
								text: `Failed to verify Google token: ${err.message}`
							}]
						}
					}
				}
				return {
					content: [{
						type: 'text',
						text: JSON.stringify({
							authenticated: true,
							email: session.email,
							scope: session.scope ?? null,
							currentSession: {
								id: session.id,
								ip: session.ip,
								ua: session.ua,
								created: session.created,
								updated: session.updated
							}
						}, null, '\t')
					}]
				}
			}
			return {
				content: [{
					type: 'text',
					text: JSON.stringify({
						authenticated: false,
						signInUrl: `${appUrl.replace(/\/$/, '')}/oauth/authorize`,
						message: 'Missing or expired Google Bearer token.'
					}, null, '\t')
				}]
			}
		}
		if (action === 'list') {
			if (!session) {
				return {
					isError: true,
					content: [{
						type: 'text',
						text: `Authentication required: ${appUrl.replace(/\/$/, '')}/oauth/authorize`
					}]
				}
			}
			const rawSessions = db.sessions.listByUserId(session.userId)
			const sessions = rawSessions.map(s => ({ ...s, isCurrent: s.id === session.id }))
			return {
				content: [{
					type: 'text',
					text: JSON.stringify({ sessions }, null, '\t')
				}]
			}
		}
		if (action === 'revoke') {
			if (!session) {
				return {
					content: [{
						type: 'text',
						text: JSON.stringify({
							revoked: false,
							message: 'No active session found for the provided token.'
						}, null, '\t')
					}]
				}
			}
			if (args.allOthers) {
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
					content: [{
						type: 'text',
						text: JSON.stringify({
							revoked: true,
							count: others.length,
							message: `Revoked ${others.length} other session(s).`
						}, null, '\t')
					}]
				}
			}
			if (args.sessionId) {
				const targetSession = db.sessions.get(args.sessionId)
				if (!targetSession || targetSession.userId !== session.userId) {
					return {
						content: [{
							type: 'text',
							text: JSON.stringify({
								revoked: false,
								message: `Session not found: ${args.sessionId}`
							}, null, '\t')
						}]
					}
				}
				const upstreamToken = targetSession.refreshToken || targetSession.accessToken
				if (upstreamToken) await revokeGoogleToken(upstreamToken)
				db.sessions.remove(targetSession.id)
				return {
					content: [{
						type: 'text',
						text: JSON.stringify({
							revoked: true,
							sessionId: targetSession.id,
							isCurrent: targetSession.id === session.id,
							message: 'Session revoked.'
						}, null, '\t')
					}]
				}
			}
			const upstreamToken = session.refreshToken || session.accessToken
			if (upstreamToken) await revokeGoogleToken(upstreamToken)
			db.sessions.remove(session.id)
			return {
				content: [{
					type: 'text',
					text: JSON.stringify({
						revoked: true,
						sessionId: session.id,
						isCurrent: true,
						message: 'Current session revoked.'
					}, null, '\t')
				}]
			}
		}
		return {
			isError: true,
			content: [{
				type: 'text',
				text: `Unknown action: ${action}`
			}]
		}
	}

	let authInfo = null
	try {
		authInfo = await getFreshGoogleToken(token)
	} catch (err) {
		return {
			isError: true,
			content: [{
				type: 'text',
				text: `Failed to refresh Google access token: ${err.message}`
			}]
		}
	}

	const googleToken = authInfo?.token || null
	if (!googleToken) {
		const appUrl = process.env.APP_URL || 'http://localhost:8080'
		return {
			isError: true,
			content: [{
				type: 'text',
				text: `Authentication required: ${appUrl.replace(/\/$/, '')}/oauth/authorize`
			}]
		}
	}

	if (name !== 'google_api') {
		return {
			isError: true,
			content: [{
				type: 'text',
				text: `Unknown tool: ${name}`
			}]
		}
	}

	const method = (args.method || 'GET').toUpperCase()

	try {
		const result = await proxyGoogleApi({
			token: googleToken,
			url: args.url,
			method,
			query: args.query,
			body: args.body,
			headers: args.headers
		})
		if (result?.binary) {
			if (result.mimeType.startsWith('image/')) {
				return {
					content: [{
						type: 'image',
						data: result.data,
						mimeType: result.mimeType
					}]
				}
			}
			return {
				content: [{
					type: 'text',
					text: JSON.stringify({
						mimeType: result.mimeType,
						...(result.charset && { charset: result.charset }),
						encoding: 'base64',
						data: result.data
					}, null, '\t')
				}]
			}
		}
		return {
			content: [{
				type: 'text',
				text: typeof result === 'string' ? result : JSON.stringify(result, null, '\t')
			}]
		}
	} catch (err) {
		return {
			isError: true,
			content: [{
				type: 'text',
				text: `Google API Error (${err.status || 500}): ${err.message}`
			}]
		}
	}
}
