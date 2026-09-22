import { proxyGoogleApi, getFreshGoogleToken, getUserInfo } from './google.js'

export {
	tools,
	executeTool
}

const tools = [
	{
		name: 'auth_status',
		description: 'Check if the current request has a valid Google authentication token, identity, and granted scopes.',
		inputSchema: {
			type: 'object',
			properties: {}
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
	const session = authInfo?.session || null

	if (name === 'auth_status') {
		if (googleToken) {
			try {
				const user = await getUserInfo(googleToken)
				return {
					content: [{
						type: 'text',
						text: JSON.stringify({
							authenticated: true,
							email: user.email,
							scope: session?.scope ?? null
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
		const appUrl = process.env.APP_URL || 'http://localhost:8080'
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
