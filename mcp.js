import RpcEngine from 'rpc-engine'
import * as api from './api/index.js'
import { getBody } from './util.js'

export {
	tools,
	executeTool,
	handleMcp
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
					description: 'Full https://*.googleapis.com URL or relative path with optional query parameters (e.g. "drive/v3/files?pageSize=10", "calendar/v3/calendars/primary/events", or "https://sheets.googleapis.com/v4/spreadsheets/ID").'
				},
				method: {
					type: 'string',
					description: 'HTTP method (GET, POST, PUT, PATCH, DELETE). Defaults to GET.'
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

const authActions = {
	whoami: (args, token) => api.auth.whoami(token),
	status: (args, token) => api.auth.whoami(token),
	list: (args, token) => api.auth.list(token),
	get: (args, token) => api.auth.get(token, args.sessionId),
	revoke: (args, token) => api.auth.revoke(token, args)
}

const toolHandlers = {
	auth (args, token) {
		const action = args.action || 'whoami'
		const handle = authActions[action]
		if (!handle) {
			console.warn(`[mcp] auth action rejected: Unknown action "${action}"`)
			const err = new Error(`Unknown action: ${action}`)
			err.status = 400
			throw err
		}
		return handle(args, token)
	},
	google_api (args, token) {
		return api.google.request(args, token)
	}
}

function formatContent (result) {
	if (result?.binary) {
		if (result.mimeType?.startsWith('image/')) {
			return [{ type: 'image', data: result.data, mimeType: result.mimeType }]
		}
		return [{
			type: 'text',
			text: JSON.stringify({
				mimeType: result.mimeType,
				...(result.charset && { charset: result.charset }),
				encoding: 'base64',
				data: result.data
			}, null, '\t')
		}]
	}
	return [{
		type: 'text',
		text: typeof result === 'string' ? result : JSON.stringify(result, null, '\t')
	}]
}

function formatError (err) {
	if (err.message?.startsWith('Policy violation:')) {
		console.warn(`[mcp] google_api policy violation: ${err.message.replace(/^Policy violation:\s*/, '')}`)
	} else if (err.message?.startsWith('Authentication required:')) {
		console.warn('[mcp] google_api rejected: Authentication required')
	} else if (err.message?.startsWith('Failed to refresh Google access token:')) {
		console.warn(`[mcp] ${err.message}`)
	} else if (err.status) {
		console.warn(`[mcp] google_api error (${err.status}): ${err.message}`)
		return {
			isError: true,
			content: [{ type: 'text', text: `Google API Error (${err.status}): ${err.message}` }]
		}
	}
	return {
		isError: true,
		content: [{ type: 'text', text: err.message }]
	}
}

async function executeTool (name, args = {}, token) {
	if (!name || typeof name !== 'string') {
		console.warn('[mcp] tools/call rejected: Missing tool name')
		return { isError: true, content: [{ type: 'text', text: 'Tool name is required' }] }
	}
	const handler = toolHandlers[name]
	if (!handler) {
		console.warn(`[mcp] tools/call rejected: Unknown tool "${name}"`)
		return { isError: true, content: [{ type: 'text', text: `Unknown tool: ${name}` }] }
	}
	try {
		const result = await handler(args, token)
		return { content: formatContent(result) }
	} catch (err) {
		return formatError(err)
	}
}

const rpcMethods = {
	initialize: params => {
		if (process.env.NODE_ENV !== 'test') {
			const client = params?.clientInfo ? `${params.clientInfo.name || 'unknown'}/${params.clientInfo.version || ''}` : 'unknown'
			console.log(`[mcp] initialize (client: ${client}, protocol: ${params?.protocolVersion || 'unknown'})`)
		}
		return {
			protocolVersion: '2024-11-05',
			capabilities: { tools: { listChanged: false } },
			serverInfo: { name: 'google-mcp', version: '1.0.0' }
		}
	},
	'notifications/initialized': () => {
		if (process.env.NODE_ENV !== 'test') {
			console.log('[mcp] notifications/initialized')
		}
		return {}
	},
	ping: () => {
		if (process.env.NODE_ENV !== 'test') {
			console.log('[mcp] ping')
		}
		return {}
	},
	'tools/list': () => {
		if (process.env.NODE_ENV !== 'test') {
			console.log('[mcp] tools/list')
		}
		return { tools }
	},
	'tools/call': (params, token) => {
		const name = params?.name
		const args = { ...params?.arguments }
		if (process.env.NODE_ENV !== 'test') {
			console.log(`[mcp] tools/call: name=${name || '(missing)'} args=${JSON.stringify(args)}`)
		}
		return executeTool(name, args, token)
	}
}

async function handleMcp (req, res, token) {
	if (req.method !== 'POST') {
		console.warn(`[mcp] Rejected non-POST request to /mcp: ${req.method}`)
		const err = new Error('Method Not Allowed')
		err.code = 405
		throw err
	}
	const rpc = new RpcEngine({
		objectMode: true,
		deserialize: data => {
			try {
				return JSON.parse(data)
			} catch (err) {
				console.warn(`[mcp] JSON-RPC parse error: ${err.message}`)
				throw err
			}
		},
		serialize: data => {
			data = typeof data === 'object' && !data?.jsonrpc
				? { ...data, jsonrpc: '2.0' }
				: data
			return JSON.stringify(data)
		},
		send: data => {
			if (data) {
				res.statusCode = 200
				res.setHeader('content-type', 'application/json; charset=utf-8')
				res.end(data)
			} else {
				res.statusCode = 202
				res.setHeader('content-type', 'application/json; charset=utf-8')
				res.end(JSON.stringify({ status: 'accepted' }))
			}
		}
	})
	rpc.methods = {
		...rpcMethods,
		'tools/call': params => rpcMethods['tools/call'](params, token)
	}
	const request = await getBody(req)
	await rpc.receive(request)
	if (!res.writableEnded) {
		rpc.send()
	}
}
