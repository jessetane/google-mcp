import { proxyGoogleApi, getFreshGoogleToken, getUserInfo } from './google.js'

export {
	tools,
	executeTool
}

const tools = [
	{
		name: 'authStatus',
		description: 'Check if the current request has a valid Google authentication token.',
		inputSchema: {
			type: 'object',
			properties: {}
		}
	},
	{
		name: 'driveApi',
		description: 'Dumb proxy to Google Drive API v3 (e.g. GET /files, GET /files/{fileId}, POST /files).',
		inputSchema: {
			type: 'object',
			properties: {
				path: {
					type: 'string',
					description: 'Path relative to https://www.googleapis.com/drive/v3/ (e.g. "files", "files/FILE_ID").'
				},
				method: {
					type: 'string',
					description: 'HTTP method (GET, POST, PATCH, PUT, DELETE). Default: GET.'
				},
				query: {
					type: 'object',
					description: 'Query parameters (e.g. { q: "name contains \'Recipe\'" }).'
				},
				body: {
					type: 'object',
					description: 'Request JSON payload for POST/PATCH/PUT.'
				},
				headers: {
					type: 'object',
					description: 'Extra HTTP headers to send (e.g. { "accept": "application/pdf" } for file export).'
				}
			},
			required: ['path']
		}
	},
	{
		name: 'sheetsApi',
		description: 'Dumb proxy to Google Sheets API v4 (e.g. GET /spreadsheets/{id}/values/{range}, POST /spreadsheets/{id}/values/{range}:append).',
		inputSchema: {
			type: 'object',
			properties: {
				path: {
					type: 'string',
					description: 'Path relative to https://sheets.googleapis.com/v4/ (e.g. "spreadsheets/ID/values/Sheet1!A1:D10").'
				},
				method: {
					type: 'string',
					description: 'HTTP method (GET, POST, PUT, DELETE). Default: GET.'
				},
				query: {
					type: 'object',
					description: 'Query parameters (e.g. { valueInputOption: "USER_ENTERED" }).'
				},
				body: {
					type: 'object',
					description: 'Request JSON payload.'
				},
				headers: {
					type: 'object',
					description: 'Extra HTTP headers to send.'
				}
			},
			required: ['path']
		}
	},
	{
		name: 'docsApi',
		description: 'Dumb proxy to Google Docs API v1 (e.g. GET /documents/{id}, POST /documents/{id}:batchUpdate).',
		inputSchema: {
			type: 'object',
			properties: {
				path: {
					type: 'string',
					description: 'Path relative to https://docs.googleapis.com/v1/ (e.g. "documents/DOCUMENT_ID").'
				},
				method: {
					type: 'string',
					description: 'HTTP method (GET, POST). Default: GET.'
				},
				query: {
					type: 'object',
					description: 'Query parameters.'
				},
				body: {
					type: 'object',
					description: 'Request JSON payload.'
				},
				headers: {
					type: 'object',
					description: 'Extra HTTP headers to send.'
				}
			},
			required: ['path']
		}
	}
]

async function executeTool (name, args = {}, token) {
	let googleToken = null
	try {
		googleToken = await getFreshGoogleToken(token)
	} catch (err) {
		return {
			isError: true,
			content: [{
				type: 'text',
				text: `Failed to refresh Google access token: ${err.message}`
			}]
		}
	}

	if (name === 'authStatus') {
		if (googleToken) {
			try {
				const user = await getUserInfo(googleToken)
				return {
					content: [{
						type: 'text',
						text: JSON.stringify({ authenticated: true, email: user.email }, null, '\t')
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

	try {
		let baseUrl
		if (name === 'driveApi') baseUrl = 'https://www.googleapis.com/drive/v3'
		else if (name === 'sheetsApi') baseUrl = 'https://sheets.googleapis.com/v4'
		else if (name === 'docsApi') baseUrl = 'https://docs.googleapis.com/v1'
		else throw new Error(`Unknown tool: ${name}`)

		const result = await proxyGoogleApi({
			token: googleToken,
			baseUrl,
			path: args.path,
			method: args.method || 'GET',
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
					text: JSON.stringify({ mimeType: result.mimeType, encoding: 'base64', data: result.data }, null, '\t')
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
