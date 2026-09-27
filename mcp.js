import * as api from './api/index.js'

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
					enum: ['whoami', 'status', 'list', 'get', 'revoke'],
					description: 'Action to perform: "whoami" (or "status", check current authentication state and session info), "list" (list all active sessions for current user), "get" (get details of a session by sessionId), or "revoke" (revoke current session, a specific session by sessionId, or all other sessions). Defaults to "whoami".'
				},
				sessionId: {
					type: 'string',
					description: 'Specific session ID when action is "get" or "revoke".'
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
	if (!name || typeof name !== 'string') {
		console.warn('[mcp] tools/call rejected: Missing tool name')
		return {
			isError: true,
			content: [{
				type: 'text',
				text: 'Tool name is required'
			}]
		}
	}
	if (name !== 'auth' && name !== 'google_api') {
		console.warn(`[mcp] tools/call rejected: Unknown tool "${name}"`)
		return {
			isError: true,
			content: [{
				type: 'text',
				text: `Unknown tool: ${name}`
			}]
		}
	}
	if (name === 'auth') {
		const action = args.action || 'whoami'
		try {
			if (action === 'whoami' || action === 'status') {
				const result = await api.auth.whoami(token)
				return {
					content: [{
						type: 'text',
						text: JSON.stringify(result, null, '\t')
					}]
				}
			}
			if (action === 'list') {
				const result = await api.auth.list(token)
				return {
					content: [{
						type: 'text',
						text: JSON.stringify(result, null, '\t')
					}]
				}
			}
			if (action === 'get') {
				const result = await api.auth.get(token, args.sessionId)
				return {
					content: [{
						type: 'text',
						text: JSON.stringify(result, null, '\t')
					}]
				}
			}
			if (action === 'revoke') {
				const result = await api.auth.revoke(token, {
					sessionId: args.sessionId,
					allOthers: args.allOthers
				})
				return {
					content: [{
						type: 'text',
						text: JSON.stringify(result, null, '\t')
					}]
				}
			}
		} catch (err) {
			return {
				isError: true,
				content: [{
					type: 'text',
					text: err.message
				}]
			}
		}
		console.warn(`[mcp] auth action rejected: Unknown action "${action}"`)
		return {
			isError: true,
			content: [{
				type: 'text',
				text: `Unknown action: ${action}`
			}]
		}
	}
	try {
		const result = await api.google.request({
			url: args.url,
			method: args.method,
			query: args.query,
			body: args.body,
			headers: args.headers
		}, token)
		if (result?.binary) {
			if (result.mimeType?.startsWith('image/')) {
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
		if (err.message?.startsWith('Policy violation:')) {
			console.warn(`[mcp] google_api policy violation: ${err.message.replace(/^Policy violation:\s*/, '')}`)
			return {
				isError: true,
				content: [{
					type: 'text',
					text: err.message
				}]
			}
		}
		if (err.message?.startsWith('Authentication required:')) {
			console.warn('[mcp] google_api rejected: Authentication required')
			return {
				isError: true,
				content: [{
					type: 'text',
					text: err.message
				}]
			}
		}
		if (err.message?.startsWith('Failed to refresh Google access token:')) {
			console.warn(`[mcp] ${err.message}`)
			return {
				isError: true,
				content: [{
					type: 'text',
					text: err.message
				}]
			}
		}
		console.warn(`[mcp] google_api error (${err.status || 500}): ${err.message}`)
		return {
			isError: true,
			content: [{
				type: 'text',
				text: err.status ? `Google API Error (${err.status}): ${err.message}` : err.message
			}]
		}
	}
}
