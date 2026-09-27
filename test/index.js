import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const dirname = path.dirname(fileURLToPath(import.meta.url))
const testDbPath = path.join(dirname, 'test.db')
process.env.DB_PATH = testDbPath
process.env.NODE_ENV = 'test'
process.env.GOOGLE_CLIENT_ID = 'test-client-id'
process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret'
process.env.ALLOWED_REDIRECT_DOMAINS = 'localhost,127.0.0.1,chatgpt.com'

fs.rmSync(testDbPath, { force: true })
fs.rmSync(`${testDbPath}-wal`, { force: true })
fs.rmSync(`${testDbPath}-shm`, { force: true })

const { server } = await import('../index.js')
const db = await import('../db/index.js')
const { readResponseBody, isGoogleApiUrl } = await import('../google.js')
const { executeTool } = await import('../mcp.js')
const api = await import('../api/index.js')
const { evaluatePolicy, matchPattern, parsePolicy, validatePolicy } = await import('../policy.js')

test('setup server', (t, done) => {
	server.listen(0, '127.0.0.1', done)
})

test('health endpoint', async () => {
	const addr = server.address()
	const res = await fetch(`http://127.0.0.1:${addr.port}/api/health`)
	assert.equal(res.status, 200)
	const text = await res.text()
	assert.equal(text, 'ok\n')
})

test('root endpoint', async () => {
	const addr = server.address()
	const res = await fetch(`http://127.0.0.1:${addr.port}/`)
	assert.equal(res.status, 200)
	assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8')
	const text = await res.text()
	assert.match(text, /google-mcp/)
	assert.match(text, /\/mcp/)
	assert.match(text, /href="\/oauth\/authorize"/)
})

test('mcp initialize & tools/list', async () => {
	const addr = server.address()
	const initRes = await fetch(`http://127.0.0.1:${addr.port}/mcp`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			jsonrpc: '2.0',
			id: 1,
			method: 'initialize',
			params: {}
		})
	})
	assert.equal(initRes.status, 200)
	const initData = await initRes.json()
	assert.equal(initData.result.serverInfo.name, 'google-mcp')

	const notifRes = await fetch(`http://127.0.0.1:${addr.port}/mcp`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			jsonrpc: '2.0',
			method: 'notifications/initialized',
			params: {}
		})
	})
	assert.equal(notifRes.status, 202)

	const listRes = await fetch(`http://127.0.0.1:${addr.port}/mcp`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			jsonrpc: '2.0',
			id: 2,
			method: 'tools/list',
			params: {}
		})
	})
	assert.equal(listRes.status, 200)
	const listData = await listRes.json()
	const toolNames = listData.result.tools.map(t => t.name)
	assert.deepEqual(toolNames, ['auth', 'google_api'])
})

test('mcp auth tool without auth', async () => {
	const addr = server.address()
	const res = await fetch(`http://127.0.0.1:${addr.port}/mcp`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			jsonrpc: '2.0',
			id: 3,
			method: 'tools/call',
			params: {
				name: 'auth',
				arguments: { action: 'status' }
			}
		})
	})
	assert.equal(res.status, 200)
	const data = await res.json()
	const parsed = JSON.parse(data.result.content[0].text)
	assert.equal(parsed.authenticated, false)
})

test('mcp google_api tool requires auth', async () => {
	const addr = server.address()
	const res = await fetch(`http://127.0.0.1:${addr.port}/mcp`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			jsonrpc: '2.0',
			id: 4,
			method: 'tools/call',
			params: {
				name: 'google_api',
				arguments: { url: 'drive/v3/files' }
			}
		})
	})
	assert.equal(res.status, 200)
	const data = await res.json()
	assert.equal(data.result.isError, true)
	assert.match(data.result.content[0].text, /Authentication required/)
})

test('mcp rejects tool call without name', async () => {
	const addr = server.address()
	const res = await fetch(`http://127.0.0.1:${addr.port}/mcp`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			jsonrpc: '2.0',
			id: 5,
			method: 'tools/call',
			params: {
				arguments: { action: 'status' }
			}
		})
	})
	assert.equal(res.status, 200)
	const data = await res.json()
	assert.equal(data.result.isError, true)
	assert.equal(data.result.content[0].text, 'Tool name is required')
})

test('mcp rejects unknown tool call', async () => {
	const addr = server.address()
	const res = await fetch(`http://127.0.0.1:${addr.port}/mcp`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			jsonrpc: '2.0',
			id: 6,
			method: 'tools/call',
			params: {
				name: 'non_existent_tool',
				arguments: {}
			}
		})
	})
	assert.equal(res.status, 200)
	const data = await res.json()
	assert.equal(data.result.isError, true)
	assert.equal(data.result.content[0].text, 'Unknown tool: non_existent_tool')
})

test('isGoogleApiUrl domain restrictions', () => {
	assert.equal(isGoogleApiUrl('https://www.googleapis.com/drive/v3/files'), true)
	assert.equal(isGoogleApiUrl('https://sheets.googleapis.com/v4/spreadsheets'), true)
	assert.equal(isGoogleApiUrl('https://docs.googleapis.com/v1/documents'), true)
	assert.equal(isGoogleApiUrl('https://calendar.googleapis.com/calendar/v3/events'), true)
	assert.equal(isGoogleApiUrl('https://googleapis.com/test'), true)
	assert.equal(isGoogleApiUrl('http://www.googleapis.com/test'), false)
	assert.equal(isGoogleApiUrl('https://evil.com'), false)
	assert.equal(isGoogleApiUrl('https://evilgoogleapis.com'), false)
	assert.equal(isGoogleApiUrl('https://localhost:8080'), false)
	assert.equal(isGoogleApiUrl('not-a-url'), false)
})

test('rejects non-googleapis URLs in google_api tool', async () => {
	const user = db.users.upsert({ email: 'user@example.com' })
	const session = db.sessions.create({
		userId: user.id,
		accessToken: 'ya29.fake-token'
	})
	const result = await executeTool('google_api', {
		url: 'https://evil.com/steal-token'
	}, session.token)
	assert.equal(result.isError, true)
	assert.match(result.content[0].text, /Target URL domain not allowed/)
})

test('mcp google_api tool ignores body on GET requests', async () => {
	const user = db.users.upsert({ email: 'getbody@example.com' })
	const session = db.sessions.create({
		userId: user.id,
		accessToken: 'ya29.fake-token'
	})
	const result = await executeTool('google_api', {
		url: 'https://www.googleapis.com/drive/v3/files',
		method: 'GET',
		body: { unwanted: 'payload' }
	}, session.token)
	assert.ok(result)
})

test('oauth state flow', async () => {
	const state = db.oauthStates.create({
		clientRedirectUri: 'https://example.com/oauth/return',
		clientState: 'random-state',
		ip: '127.0.0.1'
	})
	assert.ok(state)
	const consumed = db.oauthStates.consume(state)
	assert.equal(consumed.clientState, 'random-state')
	assert.equal(consumed.clientRedirectUri, 'https://example.com/oauth/return')
	assert.equal(db.oauthStates.consume(state), null)
})

test('oauth code exchange flow', async () => {
	const user = db.users.upsert({ email: 'test@example.com', name: 'Test User' })
	const session = db.sessions.create({
		userId: user.id,
		accessToken: 'ya29.fake-token',
		refreshToken: '1//fake-refresh'
	})
	const code = db.oauthCodes.create({
		sessionId: session.id,
		clientRedirectUri: 'https://chatgpt.com/callback'
	})
	assert.ok(code)
	const addr = server.address()
	const mismatchRes = await fetch(`http://127.0.0.1:${addr.port}/oauth/token`, {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			code,
			redirect_uri: 'https://evil.com/callback',
			grant_type: 'authorization_code'
		}).toString()
	})
	assert.equal(mismatchRes.status, 400)
	const mismatchData = await mismatchRes.json()
	assert.equal(mismatchData.error, 'invalid_grant')

	const code2 = db.oauthCodes.create({
		sessionId: session.id,
		clientRedirectUri: 'https://chatgpt.com/callback'
	})
	const res = await fetch(`http://127.0.0.1:${addr.port}/oauth/token`, {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			code: code2,
			redirect_uri: 'https://chatgpt.com/callback',
			grant_type: 'authorization_code'
		}).toString()
	})
	assert.equal(res.status, 200)
	const data = await res.json()
	assert.equal(data.access_token, session.token)
	assert.equal(data.token_type, 'Bearer')
	assert.equal(db.oauthCodes.consume(code2), null)
})

test('well-known oauth discovery endpoints', async () => {
	const addr = server.address()
	const resResource = await fetch(`http://127.0.0.1:${addr.port}/.well-known/oauth-protected-resource`)
	assert.equal(resResource.status, 200)
	const resourceData = await resResource.json()
	assert.ok(Array.isArray(resourceData.authorization_servers))
	const resAuth = await fetch(`http://127.0.0.1:${addr.port}/.well-known/oauth-authorization-server`)
	assert.equal(resAuth.status, 200)
	const authData = await resAuth.json()
	assert.ok(authData.authorization_endpoint.endsWith('/oauth/authorize'))
	assert.ok(authData.token_endpoint.endsWith('/oauth/token'))
	assert.ok(authData.revocation_endpoint.endsWith('/oauth/revoke'))
	assert.deepEqual(authData.code_challenge_methods_supported, ['S256'])
	assert.equal(authData.client_id_metadata_document_supported, true)
})

test('oauth pkce flow with S256', async () => {
	const user = db.users.upsert({ email: 'pkce@example.com', name: 'PKCE User' })
	const session = db.sessions.create({
		userId: user.id,
		accessToken: 'ya29.fake-pkce-token',
		refreshToken: '1//fake-pkce-refresh'
	})
	const addr = server.address()
	const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'
	const challenge = createHash('sha256').update(verifier).digest('base64url')
	const codeMissing = db.oauthCodes.create({
		sessionId: session.id,
		clientRedirectUri: 'https://chatgpt.com/callback',
		codeChallenge: challenge,
		codeChallengeMethod: 'S256'
	})
	const missingVerifierRes = await fetch(`http://127.0.0.1:${addr.port}/oauth/token`, {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			code: codeMissing,
			redirect_uri: 'https://chatgpt.com/callback',
			grant_type: 'authorization_code'
		}).toString()
	})
	assert.equal(missingVerifierRes.status, 400)
	const missingData = await missingVerifierRes.json()
	assert.equal(missingData.error_description, 'Missing code_verifier')
	const codeWrong = db.oauthCodes.create({
		sessionId: session.id,
		clientRedirectUri: 'https://chatgpt.com/callback',
		codeChallenge: challenge,
		codeChallengeMethod: 'S256'
	})
	const wrongVerifierRes = await fetch(`http://127.0.0.1:${addr.port}/oauth/token`, {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			code: codeWrong,
			redirect_uri: 'https://chatgpt.com/callback',
			code_verifier: 'wrong-verifier-length-must-be-at-least-43-chars-long'
		}).toString()
	})
	assert.equal(wrongVerifierRes.status, 400)
	const wrongData = await wrongVerifierRes.json()
	assert.equal(wrongData.error_description, 'Invalid code_verifier')
	const codeSuccess = db.oauthCodes.create({
		sessionId: session.id,
		clientRedirectUri: 'https://chatgpt.com/callback',
		codeChallenge: challenge,
		codeChallengeMethod: 'S256'
	})
	const successRes = await fetch(`http://127.0.0.1:${addr.port}/oauth/token`, {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			code: codeSuccess,
			redirect_uri: 'https://chatgpt.com/callback',
			code_verifier: verifier
		}).toString()
	})
	assert.equal(successRes.status, 200)
	const successData = await successRes.json()
	assert.equal(successData.access_token, session.token)
})

test('oauth pkce authorize endpoint validation and state propagation', async () => {
	const addr = server.address()
	const methodWithoutChallengeRes = await fetch(`http://127.0.0.1:${addr.port}/oauth/authorize?code_challenge_method=S256`)
	assert.equal(methodWithoutChallengeRes.status, 400)
	const methodWithoutChallengeData = await methodWithoutChallengeRes.json()
	assert.equal(methodWithoutChallengeData.error, 'invalid_request')
	const unsupportedMethodRes = await fetch(`http://127.0.0.1:${addr.port}/oauth/authorize?code_challenge=xyz&code_challenge_method=unsupported`)
	assert.equal(unsupportedMethodRes.status, 400)
	const unsupportedMethodData = await unsupportedMethodRes.json()
	assert.equal(unsupportedMethodData.error, 'invalid_request')
	const plainMethodRes = await fetch(`http://127.0.0.1:${addr.port}/oauth/authorize?code_challenge=xyz&code_challenge_method=plain`)
	assert.equal(plainMethodRes.status, 400)
	const plainMethodData = await plainMethodRes.json()
	assert.equal(plainMethodData.error, 'invalid_request')
	const unauthorizedRedirectRes = await fetch(`http://127.0.0.1:${addr.port}/oauth/authorize?redirect_uri=https://evil.com/callback&code_challenge=xyz`)
	assert.equal(unauthorizedRedirectRes.status, 400)
	const unauthorizedRedirectData = await unauthorizedRedirectRes.json()
	assert.equal(unauthorizedRedirectData.error, 'invalid_request')
	assert.match(unauthorizedRedirectData.error_description, /redirect_uri is not allowed/)
	const missingPkceRes = await fetch(`http://127.0.0.1:${addr.port}/oauth/authorize?redirect_uri=https://chatgpt.com/callback`)
	assert.equal(missingPkceRes.status, 400)
	const missingPkceData = await missingPkceRes.json()
	assert.equal(missingPkceData.error, 'invalid_request')
	assert.match(missingPkceData.error_description, /code_challenge required/)
	const challenge = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'
	const authRes = await fetch(`http://127.0.0.1:${addr.port}/oauth/authorize?redirect_uri=https://chatgpt.com/callback&state=test-state&code_challenge=${challenge}&code_challenge_method=S256`)
	assert.equal(authRes.status, 200)
	assert.equal(authRes.headers.get('content-type'), 'text/html; charset=utf-8')
	const authHtml = await authRes.text()
	assert.match(authHtml, /"redirect_uri":"https:\/\/chatgpt\.com\/callback"/)
	assert.match(authHtml, /"state":"test-state"/)
	assert.match(authHtml, /"code_challenge":"E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"/)
	assert.match(authHtml, /"code_challenge_method":"S256"/)
})

test('oauth consent html page and post consent flow', async () => {
	const addr = server.address()
	const challenge = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'
	const pageRes = await fetch(`http://127.0.0.1:${addr.port}/oauth/authorize?redirect_uri=https://chatgpt.com/callback&state=client-state-123&code_challenge=${challenge}&code_challenge_method=S256`)
	assert.equal(pageRes.status, 200)
	assert.equal(pageRes.headers.get('content-type'), 'text/html; charset=utf-8')
	const html = await pageRes.text()
	assert.match(html, /google-mcp/)
	assert.match(html, /action="\/oauth\/authorize\/consent"/)
	assert.match(html, /"redirect_uri":"https:\/\/chatgpt\.com\/callback"/)
	assert.match(html, /"state":"client-state-123"/)

	const consentBody = new URLSearchParams({
		redirect_uri: 'https://chatgpt.com/callback',
		state: 'client-state-123',
		code_challenge: challenge,
		code_challenge_method: 'S256'
	})
	for (const id of ['drive', 'docs', 'sheets', 'slides', 'forms', 'calendar', 'tasks', 'keep', 'meet', 'contacts', 'chat', 'gmail', 'photos', 'youtube']) {
		consentBody.append('services', id)
	}

	const consentRes = await fetch(`http://127.0.0.1:${addr.port}/oauth/authorize/consent`, {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: consentBody.toString(),
		redirect: 'manual'
	})
	assert.equal(consentRes.status, 302)
	const location = consentRes.headers.get('location')
	assert.ok(location)
	const targetUrl = new URL(location)
	assert.match(targetUrl.searchParams.get('scope'), /drive\.readonly/)
	assert.match(targetUrl.searchParams.get('scope'), /calendar\.readonly/)
	assert.match(targetUrl.searchParams.get('scope'), /gmail\.readonly/)
	assert.match(targetUrl.searchParams.get('scope'), /tasks\.readonly/)
	assert.match(targetUrl.searchParams.get('scope'), /keep\.readonly/)
	assert.match(targetUrl.searchParams.get('scope'), /meetings\.space\.readonly/)
	assert.match(targetUrl.searchParams.get('scope'), /contacts\.readonly/)
	assert.match(targetUrl.searchParams.get('scope'), /chat\.spaces\.readonly/)
	assert.match(targetUrl.searchParams.get('scope'), /chat\.messages\.readonly/)
	assert.match(targetUrl.searchParams.get('scope'), /photoslibrary\.readonly\.appcreateddata/)
	assert.match(targetUrl.searchParams.get('scope'), /youtube\.readonly/)
	const stateParam = targetUrl.searchParams.get('state')
	assert.ok(stateParam)
	const stateRow = db.oauthStates.consume(stateParam)
	assert.equal(stateRow.clientRedirectUri, 'https://chatgpt.com/callback')
	assert.equal(stateRow.clientState, 'client-state-123')
})

test('oauth consent with dynamic service and write selection', async () => {
	const addr = server.address()
	const challenge = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'
	const consentParams = new URLSearchParams()
	consentParams.set('redirect_uri', 'https://chatgpt.com/callback')
	consentParams.set('state', 'client-state-dynamic')
	consentParams.set('code_challenge', challenge)
	consentParams.set('code_challenge_method', 'S256')
	consentParams.append('services', 'drive')
	consentParams.append('services', 'calendar')
	consentParams.append('write', 'calendar')

	const consentRes = await fetch(`http://127.0.0.1:${addr.port}/oauth/authorize/consent`, {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: consentParams.toString(),
		redirect: 'manual'
	})
	assert.equal(consentRes.status, 302)
	const location = consentRes.headers.get('location')
	assert.ok(location)
	const targetUrl = new URL(location)
	const scopeParam = targetUrl.searchParams.get('scope')

	assert.match(scopeParam, /drive\.readonly/)
	assert.equal(scopeParam.split(' ').includes('https://www.googleapis.com/auth/drive'), false)
	assert.match(scopeParam, /auth\/calendar\b/)
	assert.doesNotMatch(scopeParam, /calendar\.readonly/)
	assert.doesNotMatch(scopeParam, /gmail/)
	assert.doesNotMatch(scopeParam, /tasks/)

	const stateRow = db.oauthStates.consume(targetUrl.searchParams.get('state'))
	assert.ok(stateRow)
})

test('direct browser authorize without redirect_uri', async () => {
	const addr = server.address()
	const pageRes = await fetch(`http://127.0.0.1:${addr.port}/oauth/authorize`)
	assert.equal(pageRes.status, 200)
	assert.equal(pageRes.headers.get('content-type'), 'text/html; charset=utf-8')
	const html = await pageRes.text()
	assert.match(html, /google-mcp/)
	assert.match(html, /action="\/oauth\/authorize\/consent"/)
	const consentBody = new URLSearchParams()
	consentBody.append('services', 'drive')
	const consentRes = await fetch(`http://127.0.0.1:${addr.port}/oauth/authorize/consent`, {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: consentBody.toString(),
		redirect: 'manual'
	})
	assert.equal(consentRes.status, 302)
	const location = consentRes.headers.get('location')
	assert.ok(location)
	const targetUrl = new URL(location)
	const stateRow = db.oauthStates.consume(targetUrl.searchParams.get('state'))
	assert.equal(stateRow.clientRedirectUri, null)
	assert.equal(stateRow.codeChallenge, null)
})

test('authorize page with policy and service query params', async () => {
	const addr = server.address()
	const policyJson = JSON.stringify([{ action: 'allow', path: '/drive/**' }])
	const res = await fetch(`http://127.0.0.1:${addr.port}/oauth/authorize?services=drive,calendar&write=calendar&policy=${encodeURIComponent(policyJson)}`)
	assert.equal(res.status, 200)
	const html = await res.text()
	assert.match(html, /"policy":/)
	assert.match(html, /"services":"drive,calendar"/)
	assert.match(html, /"write":"calendar"/)
})

test('authorize page with repeated query parameters', async () => {
	const addr = server.address()
	const res = await fetch(`http://127.0.0.1:${addr.port}/oauth/authorize?services=drive&services=calendar&write=drive&write=calendar`)
	assert.equal(res.status, 200)
	const html = await res.text()
	assert.match(html, /"services":"drive,calendar"/)
	assert.match(html, /"write":"drive,calendar"/)
})

test('cors preflight options request', async () => {
	const addr = server.address()
	const res = await fetch(`http://127.0.0.1:${addr.port}/oauth/token`, {
		method: 'OPTIONS'
	})
	assert.equal(res.status, 204)
	assert.equal(res.headers.get('access-control-allow-origin'), '*')
	assert.match(res.headers.get('access-control-allow-methods'), /POST/)
})

test('not found returns 404 json', async () => {
	const addr = server.address()
	const res = await fetch(`http://127.0.0.1:${addr.port}/unknown-route`)
	assert.equal(res.status, 404)
	const data = await res.json()
	assert.equal(data.error, 'not found')
})

test('unknown rpc method returns -32601 error', async () => {
	const addr = server.address()
	const res = await fetch(`http://127.0.0.1:${addr.port}/mcp`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			jsonrpc: '2.0',
			id: 99,
			method: 'nonexistent/method',
			params: {}
		})
	})
	assert.equal(res.status, 200)
	const data = await res.json()
	assert.ok(data.error, 'response should contain an error')
	assert.equal(data.error.code, -32601)
})

test('mcp invalid json returns jsonrpc parse error', async () => {
	const addr = server.address()
	const res = await fetch(`http://127.0.0.1:${addr.port}/mcp`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: '{"invalid_json'
	})
	const data = await res.json()
	assert.equal(data.jsonrpc, '2.0')
	assert.equal(data.error?.code, -32700)
})

test('mcp non-POST request returns 405 Method Not Allowed', async () => {
	const addr = server.address()
	const res = await fetch(`http://127.0.0.1:${addr.port}/mcp`, {
		method: 'GET'
	})
	assert.equal(res.status, 405)
	const data = await res.json()
	assert.equal(data.error, 'Method Not Allowed')
})

test('readResponseBody enforces size limit on streams', async () => {
	const stream = new ReadableStream({
		start (controller) {
			controller.enqueue(new Uint8Array(500))
			controller.enqueue(new Uint8Array(600))
			controller.close()
		}
	})
	const response = new Response(stream)
	await assert.rejects(
		async () => {
			await readResponseBody(response, 1000)
		},
		err => {
			assert.equal(err.status, 413)
			assert.match(err.message, /File too large/)
			return true
		}
	)
	const smallStream = new ReadableStream({
		start (controller) {
			controller.enqueue(new TextEncoder().encode('hello world'))
			controller.close()
		}
	})
	const smallResponse = new Response(smallStream)
	const buf = await readResponseBody(smallResponse, 1000)
	assert.equal(buf.toString(), 'hello world')
})

test('rfc 7009 /oauth/revoke endpoint', async () => {
	const addr = server.address()
	const methodRes = await fetch(`http://127.0.0.1:${addr.port}/oauth/revoke`, {
		method: 'GET'
	})
	assert.equal(methodRes.status, 405)
	const missingRes = await fetch(`http://127.0.0.1:${addr.port}/oauth/revoke`, {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: ''
	})
	assert.equal(missingRes.status, 400)
	const missingData = await missingRes.json()
	assert.equal(missingData.error, 'invalid_request')
	const unknownRes = await fetch(`http://127.0.0.1:${addr.port}/oauth/revoke`, {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({ token: 'nonexistent-token' }).toString()
	})
	assert.equal(unknownRes.status, 200)
	const user = db.users.upsert({ email: 'revoke-endpoint@example.com' })
	const session = db.sessions.create({
		userId: user.id,
		accessToken: 'ya29.revoke-access-token',
		refreshToken: '1//revoke-refresh-token'
	})
	assert.ok(db.sessions.get(session.id))
	const revokeRes = await fetch(`http://127.0.0.1:${addr.port}/oauth/revoke`, {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({ token: session.token }).toString()
	})
	assert.equal(revokeRes.status, 200)
	assert.equal(db.sessions.get(session.id), null)
	const sessionJson = db.sessions.create({
		userId: user.id,
		accessToken: 'ya29.revoke-json-access-token'
	})
	assert.ok(db.sessions.get(sessionJson.id))
	const revokeJsonRes = await fetch(`http://127.0.0.1:${addr.port}/oauth/revoke`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ token: sessionJson.token })
	})
	assert.equal(revokeJsonRes.status, 200)
	assert.equal(db.sessions.get(sessionJson.id), null)
})

test('mcp auth status, list, and revoke', async () => {
	const user = db.users.upsert({ email: 'sessions-tool@example.com' })
	const session1 = db.sessions.create({
		userId: user.id,
		accessToken: 'ya29.session-1-token',
		refreshToken: '1//session-1-refresh',
		ip: '192.168.1.10',
		ua: 'ClaudeDesktop/1.0',
		scope: 'https://www.googleapis.com/auth/drive.readonly'
	})
	const session2 = db.sessions.create({
		userId: user.id,
		accessToken: 'ya29.session-2-token',
		refreshToken: '1//session-2-refresh',
		ip: '10.0.0.5',
		ua: 'ChatGPT/2.0'
	})
	const listResult = await executeTool('auth', { action: 'list' }, session1.token)
	assert.equal(listResult.isError, undefined)
	const listParsed = JSON.parse(listResult.content[0].text)
	assert.equal(listParsed.sessions.length, 2)
	const current = listParsed.sessions.find(s => s.isCurrent)
	assert.equal(current.id, session1.id)
	assert.equal(current.ip, '192.168.1.10')
	assert.equal(current.ua, 'ClaudeDesktop/1.0')
	const other = listParsed.sessions.find(s => !s.isCurrent)
	assert.equal(other.id, session2.id)
	assert.equal(other.ip, '10.0.0.5')
	assert.equal(other.ua, 'ChatGPT/2.0')
	const revokeOtherResult = await executeTool('auth', { action: 'revoke', allOthers: true }, session1.token)
	assert.equal(revokeOtherResult.isError, undefined)
	const revokeOtherParsed = JSON.parse(revokeOtherResult.content[0].text)
	assert.equal(revokeOtherParsed.revoked, true)
	assert.equal(revokeOtherParsed.count, 1)
	assert.equal(db.sessions.get(session2.id), null)
	assert.ok(db.sessions.get(session1.id))
	const revokeCurrentResult = await executeTool('auth', { action: 'revoke' }, session1.token)
	assert.equal(revokeCurrentResult.isError, undefined)
	const revokeCurrentParsed = JSON.parse(revokeCurrentResult.content[0].text)
	assert.equal(revokeCurrentParsed.revoked, true)
	assert.equal(db.sessions.get(session1.id), null)
})

test('matchPattern matching logic', () => {
	assert.equal(matchPattern('*', 'anything'), true)
	assert.equal(matchPattern('**', '/nested/path/to/resource'), true)
	assert.equal(matchPattern('/calendar/v3/calendars/*/events', '/calendar/v3/calendars/work/events'), true)
	assert.equal(matchPattern('/calendar/v3/calendars/*/events', '/calendar/v3/calendars/work/other/events'), false)
	assert.equal(matchPattern('/calendar/v3/calendars/**/events', '/calendar/v3/calendars/work/sub/events'), true)
	assert.equal(matchPattern('/drive/v3/files/*', '/drive/v3/files/file123'), true)
	assert.equal(matchPattern('/drive/v3/files/*', '/drive/v3/files/file123/comments'), false)
	assert.equal(matchPattern('/drive/v3/files/**', '/drive/v3/files/file123/comments'), true)
	assert.equal(matchPattern('/drive/**/files', '/drive/files'), true)
	assert.equal(matchPattern('/drive/**/files', '/drive/v3/files'), true)
	assert.equal(matchPattern('/drive/**/files', '/drive/a/b/files'), true)
	assert.equal(matchPattern('/**/files', '/files'), true)
	assert.equal(matchPattern('/**/files', '/a/files'), true)
	assert.equal(matchPattern('/*/events', '/calendar/events'), true)
	assert.equal(matchPattern('/*/events', '/calendar/work/events'), false)
	assert.equal(matchPattern('/**/events', '/events'), true)
	assert.equal(matchPattern('/**/events', '/calendar/events'), true)
	assert.equal(matchPattern('/**/events', '/calendar/work/events'), true)
	assert.equal(matchPattern('/**/**/**/**/**/**/**/**/**/**/**/**/**/**/**/**/x', '/a/a/a/a/a/a/a/a/a/a/a/a/a'), false)
	assert.equal(matchPattern(null, 'test'), false)
	assert.equal(matchPattern('test', null), false)
	assert.equal(matchPattern('test', undefined), false)
})

test('parsePolicy helper parses valid JSON and returns null for invalid or empty policy', () => {
	const policy = [{ action: 'allow', path: '/**' }]
	assert.deepEqual(parsePolicy(JSON.stringify(policy)), policy)
	assert.deepEqual(parsePolicy(policy), policy)
	assert.equal(parsePolicy(null), null)
	assert.equal(parsePolicy(''), null)
	assert.equal(parsePolicy('invalid-json'), null)
	assert.equal(parsePolicy([{ invalid: 'rule' }]), null)
})

test('evaluatePolicy allows all when policy is null or empty', () => {
	assert.equal(evaluatePolicy(null, { url: '/calendar/v3/calendars/primary/events', method: 'GET' }).allowed, true)
	assert.equal(evaluatePolicy('', { url: '/calendar/v3/calendars/primary/events', method: 'GET' }).allowed, true)
	assert.equal(evaluatePolicy('[]', { url: '/calendar/v3/calendars/primary/events', method: 'GET' }).allowed, true)
	assert.equal(evaluatePolicy([], { url: '/calendar/v3/calendars/primary/events', method: 'GET' }).allowed, true)
})

test('evaluatePolicy denylist mode defaults to allow', () => {
	const policy = [
		{
			action: 'deny',
			methods: ['DELETE']
		}
	]
	assert.equal(evaluatePolicy(policy, { url: '/calendar/v3/calendars/primary/events', method: 'GET' }).allowed, true)
	assert.equal(evaluatePolicy(policy, { url: '/calendar/v3/calendars/primary/events', method: 'POST' }).allowed, true)
	assert.equal(evaluatePolicy(policy, { url: '/calendar/v3/calendars/primary/events/123', method: 'DELETE' }).allowed, false)
})

test('evaluatePolicy sequential evaluation for calendar allowlist with catch-all deny', () => {
	const policy = [
		{
			action: 'allow',
			methods: ['GET'],
			path: '/calendar/v3/calendars/team-schedule@group.calendar.google.com'
		},
		{
			action: 'allow',
			path: '/calendar/v3/calendars/team-schedule@group.calendar.google.com/events/**'
		},
		{
			action: 'deny',
			description: 'Only the team-schedule calendar is accessible'
		}
	]

	const allowedGetCal = evaluatePolicy(policy, {
		url: 'https://www.googleapis.com/calendar/v3/calendars/team-schedule@group.calendar.google.com',
		method: 'GET'
	})
	assert.equal(allowedGetCal.allowed, true)

	const deniedDeleteCal = evaluatePolicy(policy, {
		url: 'https://www.googleapis.com/calendar/v3/calendars/team-schedule@group.calendar.google.com',
		method: 'DELETE'
	})
	assert.equal(deniedDeleteCal.allowed, false)
	assert.equal(deniedDeleteCal.reason, 'Only the team-schedule calendar is accessible')

	const allowedGetEvents = evaluatePolicy(policy, {
		url: '/calendar/v3/calendars/team-schedule@group.calendar.google.com/events',
		method: 'GET'
	})
	assert.equal(allowedGetEvents.allowed, true)

	const allowedPostEvents = evaluatePolicy(policy, {
		url: '/calendar/v3/calendars/team-schedule@group.calendar.google.com/events',
		method: 'POST'
	})
	assert.equal(allowedPostEvents.allowed, true)

	const allowedDeleteEvents = evaluatePolicy(policy, {
		url: '/calendar/v3/calendars/team-schedule@group.calendar.google.com/events/evt123',
		method: 'DELETE'
	})
	assert.equal(allowedDeleteEvents.allowed, true)

	const deniedOtherCal = evaluatePolicy(policy, {
		url: '/calendar/v3/calendars/other-team@group.calendar.google.com/events',
		method: 'GET'
	})
	assert.equal(deniedOtherCal.allowed, false)
	assert.equal(deniedOtherCal.reason, 'Only the team-schedule calendar is accessible')

	const allowedEncodedEvents = evaluatePolicy(policy, {
		url: '/calendar/v3/calendars/team-schedule%40group.calendar.google.com/events',
		method: 'GET'
	})
	assert.equal(allowedEncodedEvents.allowed, true)

	const deniedEncodedOtherCal = evaluatePolicy(policy, {
		url: '/calendar/v3/calendars/other-team%40group.calendar.google.com/events',
		method: 'GET'
	})
	assert.equal(deniedEncodedOtherCal.allowed, false)
})

test('evaluatePolicy matches relative paths and origin-scoped rules', () => {
	const relPolicy = [
		{ action: 'deny', path: 'drive/v3/files/**' }
	]
	assert.equal(evaluatePolicy(relPolicy, { url: '/drive/v3/files/123', method: 'GET' }).allowed, false)
	assert.equal(evaluatePolicy(relPolicy, { url: '/calendar/v3/calendars', method: 'GET' }).allowed, true)

	const originPolicy = [
		{ action: 'allow', origin: 'https://sheets.googleapis.com', path: '/v4/spreadsheets/**' },
		{ action: 'deny' }
	]
	assert.equal(evaluatePolicy(originPolicy, { url: 'https://sheets.googleapis.com/v4/spreadsheets/123', method: 'GET' }).allowed, true)
	assert.equal(evaluatePolicy(originPolicy, { url: 'https://docs.googleapis.com/v4/spreadsheets/123', method: 'GET' }).allowed, false)
	assert.equal(evaluatePolicy(originPolicy, { url: 'https://www.googleapis.com/drive/v3/files', method: 'GET' }).allowed, false)

	const traversalResult = evaluatePolicy(originPolicy, { url: 'https://sheets.googleapis.com/v4/spreadsheets/public/%2e%2e/secret', method: 'GET' })
	assert.equal(traversalResult.allowed, false)
	assert.match(traversalResult.reason, /path traversal/i)
})

test('evaluatePolicy matches URLs with query parameters in url string', () => {
	const sheetPolicy = [
		{ action: 'allow', origin: 'https://sheets.googleapis.com', path: '/v4/spreadsheets/123' },
		{ action: 'deny' }
	]
	assert.equal(evaluatePolicy(sheetPolicy, { url: 'https://sheets.googleapis.com/v4/spreadsheets/123?includeGridData=true' }).allowed, true)
})

test('executeTool google_api enforces session policy and auth tools decode policy', async () => {
	const user = db.users.upsert({ email: 'policy-test@example.com' })
	const policyObj = [
		{
			action: 'deny',
			methods: ['DELETE'],
			description: 'Deletions are forbidden'
		},
		{
			action: 'allow',
			path: '/calendar/v3/calendars/work/**'
		},
		{
			action: 'deny',
			description: 'Work calendar only'
		}
	]
	const session = db.sessions.create({
		userId: user.id,
		accessToken: 'ya29.policy-token',
		policy: JSON.stringify(policyObj)
	})

	const noTokenSession = db.sessions.create({
		userId: user.id,
		policy: JSON.stringify(policyObj)
	})

	const statusRes = await executeTool('auth', { action: 'status' }, noTokenSession.token)
	assert.equal(statusRes.isError, undefined)
	const statusParsed = JSON.parse(statusRes.content[0].text)
	assert.deepEqual(statusParsed.policy, policyObj)

	const listRes = await executeTool('auth', { action: 'list' }, session.token)
	assert.equal(listRes.isError, undefined)
	const listParsed = JSON.parse(listRes.content[0].text)
	const foundSession = listParsed.sessions.find(s => s.id === session.id)
	assert.deepEqual(foundSession.policy, policyObj)

	const deniedDeleteRes = await executeTool('google_api', {
		url: 'https://www.googleapis.com/calendar/v3/calendars/work/events/123',
		method: 'DELETE'
	}, session.token)
	assert.equal(deniedDeleteRes.isError, true)
	assert.match(deniedDeleteRes.content[0].text, /Policy violation/)
	assert.match(deniedDeleteRes.content[0].text, /Deletions are forbidden/)

	const deniedPathRes = await executeTool('google_api', {
		url: 'https://www.googleapis.com/calendar/v3/calendars/personal/events',
		method: 'GET'
	}, session.token)
	assert.equal(deniedPathRes.isError, true)
	assert.match(deniedPathRes.content[0].text, /Policy violation/)
	assert.match(deniedPathRes.content[0].text, /Work calendar only/)
})

test('oauth consent flow with policy', async () => {
	const addr = server.address()
	const challenge = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'
	const policyStr = JSON.stringify([
		{ action: 'deny', methods: ['DELETE'] },
		{ action: 'allow', path: '/calendar/v3/calendars/my-cal/**' }
	])
	const consentBody = new URLSearchParams({
		redirect_uri: 'https://chatgpt.com/callback',
		state: 'client-state-policy',
		code_challenge: challenge,
		code_challenge_method: 'S256',
		policy: policyStr
	})
	consentBody.append('services', 'calendar')
	consentBody.append('write', 'calendar')
	const consentRes = await fetch(`http://127.0.0.1:${addr.port}/oauth/authorize/consent`, {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: consentBody.toString(),
		redirect: 'manual'
	})
	assert.equal(consentRes.status, 302)
	const location = consentRes.headers.get('location')
	const targetUrl = new URL(location)
	const stateParam = targetUrl.searchParams.get('state')
	assert.ok(stateParam)
	const stateRow = db.oauthStates.consume(stateParam)
	assert.equal(stateRow.policy, policyStr)
})

test('oauth consent flow rejects invalid json policy', async () => {
	const addr = server.address()
	const challenge = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'
	const consentBody = new URLSearchParams({
		redirect_uri: 'https://chatgpt.com/callback',
		state: 'client-state-policy',
		code_challenge: challenge,
		code_challenge_method: 'S256',
		policy: '{ invalid-json'
	})
	consentBody.append('services', 'calendar')

	const consentRes = await fetch(`http://127.0.0.1:${addr.port}/oauth/authorize/consent`, {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: consentBody.toString()
	})
	assert.equal(consentRes.status, 400)
	const data = await consentRes.json()
	assert.equal(data.error, 'invalid_request')
	assert.match(data.error_description, /Invalid JSON policy/)
})

test('validatePolicy validates schema and fails fast on errors', () => {
	assert.equal(validatePolicy(null).valid, true)
	assert.equal(validatePolicy('').valid, true)
	assert.equal(validatePolicy('[]').valid, true)
	assert.equal(validatePolicy([]).valid, true)
	assert.equal(validatePolicy('not json').valid, false)
	assert.match(validatePolicy('not json').error, /Invalid JSON policy/)
	assert.equal(validatePolicy('{}').valid, false)
	assert.match(validatePolicy('{}').error, /Policy must be a JSON array of rules/)
	assert.equal(validatePolicy({ rules: [] }).valid, false)
	assert.match(validatePolicy({ rules: [] }).error, /Policy must be a JSON array of rules/)
	assert.equal(validatePolicy(['not-an-object']).valid, false)
	assert.match(validatePolicy(['not-an-object']).error, /Rule at index 0 must be an object/)
	assert.equal(validatePolicy([{ action: 'invalid' }]).valid, false)
	assert.match(validatePolicy([{ action: 'invalid' }]).error, /Rule at index 0 action must be "allow" or "deny"/)
	assert.equal(validatePolicy([{ action: 'allow', method: 'GET' }]).valid, false)
	assert.match(validatePolicy([{ action: 'allow', method: 'GET' }]).error, /Rule at index 0 has unknown property "method"/)
	assert.equal(validatePolicy([{ action: 'allow', methods: 'GET' }]).valid, false)
	assert.match(validatePolicy([{ action: 'allow', methods: 'GET' }]).error, /methods must be an array of HTTP method strings/)
	assert.equal(validatePolicy([{ action: 'allow', methods: [] }]).valid, false)
	assert.match(validatePolicy([{ action: 'allow', methods: [] }]).error, /methods must be an array of HTTP method strings/)
	assert.equal(validatePolicy([{ action: 'allow', methods: ['INVALID_VERB'] }]).valid, false)
	assert.match(validatePolicy([{ action: 'allow', methods: ['INVALID_VERB'] }]).error, /contains invalid HTTP method "INVALID_VERB"/)
	assert.equal(validatePolicy([{ action: 'allow', origin: 123 }]).valid, false)
	assert.match(validatePolicy([{ action: 'allow', origin: 123 }]).error, /Rule at index 0 origin must be an HTTPS origin/)
	assert.equal(validatePolicy([{ action: 'allow', origin: 'sheets.googleapis.com' }]).valid, false)
	assert.match(validatePolicy([{ action: 'allow', origin: 'sheets.googleapis.com' }]).error, /Rule at index 0 origin must be an HTTPS origin/)
	assert.equal(validatePolicy([{ action: 'allow', origin: 'https://sheets.googleapis.com/v4' }]).valid, false)
	assert.match(validatePolicy([{ action: 'allow', origin: 'https://sheets.googleapis.com/v4' }]).error, /must not contain a path or query/)
	assert.equal(validatePolicy([{ action: 'allow', path: 123 }]).valid, false)
	assert.match(validatePolicy([{ action: 'allow', path: 123 }]).error, /Rule at index 0 path must be a non-empty string/)
	assert.equal(validatePolicy([{ action: 'allow', path: '' }]).valid, false)
	assert.match(validatePolicy([{ action: 'allow', path: '' }]).error, /Rule at index 0 path must be a non-empty string/)
	assert.equal(validatePolicy([{ action: 'allow', path: '   ' }]).valid, false)
	assert.match(validatePolicy([{ action: 'allow', path: '   ' }]).error, /Rule at index 0 path must be a non-empty string/)
	assert.equal(validatePolicy([{ action: 'allow', path: '/drive/v3/files?q=*' }]).valid, false)
	assert.match(validatePolicy([{ action: 'allow', path: '/drive/v3/files?q=*' }]).error, /Rule at index 0 path must not contain query parameters/)
	assert.equal(validatePolicy([{ action: 'allow', path: 'https://sheets.googleapis.com/v4/**' }]).valid, false)
	assert.match(validatePolicy([{ action: 'allow', path: 'https://sheets.googleapis.com/v4/**' }]).error, /use "origin" to specify hostnames/)
	assert.equal(validatePolicy([{ action: 'allow', description: 123 }]).valid, false)
	assert.match(validatePolicy([{ action: 'allow', description: 123 }]).error, /Rule at index 0 description must be a string/)
	const validPolicy = [
		{ action: 'allow', methods: ['GET'], origin: 'https://sheets.googleapis.com', path: '/v4/**', description: 'Allow sheets GET' },
		{ action: 'deny' }
	]
	assert.equal(validatePolicy(validPolicy).valid, true)
	assert.equal(validatePolicy([{ action: 'allow', origin: 'https://sheets.googleapis.com/' }]).valid, true)
})

test('oauth consent flow rejects invalid schema policy', async () => {
	const addr = server.address()
	const challenge = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'
	const consentBody = new URLSearchParams({
		redirect_uri: 'https://chatgpt.com/callback',
		state: 'client-state-policy-invalid',
		code_challenge: challenge,
		code_challenge_method: 'S256',
		policy: JSON.stringify([{ action: 'allow', method: 'GET' }])
	})
	consentBody.append('services', 'calendar')

	const consentRes = await fetch(`http://127.0.0.1:${addr.port}/oauth/authorize/consent`, {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: consentBody.toString()
	})
	assert.equal(consentRes.status, 400)
	const data = await consentRes.json()
	assert.equal(data.error, 'invalid_request')
	assert.match(data.error_description, /unknown property "method"/)
})

test('rest api /api/whoami, /api/sessions, and /api/sessions/:id', async () => {
	const addr = server.address()
	const unauthRes = await fetch(`http://127.0.0.1:${addr.port}/api/whoami`)
	assert.equal(unauthRes.status, 200)
	const unauthData = await unauthRes.json()
	assert.equal(unauthData.authenticated, false)
	assert.match(unauthData.signInUrl, /\/oauth\/authorize/)
	const unauthSessions = await fetch(`http://127.0.0.1:${addr.port}/api/sessions`)
	assert.equal(unauthSessions.status, 401)
	const user = db.users.upsert({ email: 'rest-test@example.com' })
	const session1 = db.sessions.create({
		userId: user.id,
		accessToken: 'ya29.rest-session-1',
		refreshToken: '1//rest-refresh-1',
		ip: '127.0.0.1',
		ua: 'TestClient/1.0'
	})
	const session2 = db.sessions.create({
		userId: user.id,
		accessToken: 'ya29.rest-session-2',
		refreshToken: '1//rest-refresh-2'
	})
	const whoamiRes = await fetch(`http://127.0.0.1:${addr.port}/api/whoami`, {
		headers: { authorization: `Bearer ${session1.token}` }
	})
	assert.equal(whoamiRes.status, 200)
	const whoamiData = await whoamiRes.json()
	assert.equal(whoamiData.authenticated, true)
	assert.equal(whoamiData.email, 'rest-test@example.com')
	assert.equal(whoamiData.currentSession.id, session1.id)
	const listRes = await fetch(`http://127.0.0.1:${addr.port}/api/sessions`, {
		headers: { authorization: `Bearer ${session1.token}` }
	})
	assert.equal(listRes.status, 200)
	const listData = await listRes.json()
	assert.equal(listData.sessions.length, 2)
	const getRes = await fetch(`http://127.0.0.1:${addr.port}/api/sessions/${session2.id}`, {
		headers: { authorization: `Bearer ${session1.token}` }
	})
	assert.equal(getRes.status, 200)
	const getData = await getRes.json()
	assert.equal(getData.session.id, session2.id)
	const delSpecificRes = await fetch(`http://127.0.0.1:${addr.port}/api/sessions/${session2.id}`, {
		method: 'DELETE',
		headers: { authorization: `Bearer ${session1.token}` }
	})
	assert.equal(delSpecificRes.status, 200)
	const delData = await delSpecificRes.json()
	assert.equal(delData.revoked, true)
	assert.equal(db.sessions.get(session2.id), null)
	const delAllRes = await fetch(`http://127.0.0.1:${addr.port}/api/sessions`, {
		method: 'DELETE',
		headers: { authorization: `Bearer ${session1.token}` }
	})
	assert.equal(delAllRes.status, 200)
	assert.equal(db.sessions.get(session1.id), null)
})

test('mcp auth tool with whoami and get actions', async () => {
	const user = db.users.upsert({ email: 'mcp-whoami@example.com' })
	const session = db.sessions.create({
		userId: user.id,
		accessToken: 'ya29.mcp-session',
		refreshToken: '1//mcp-refresh'
	})
	const whoamiResult = await executeTool('auth', { action: 'whoami' }, session.token)
	assert.equal(whoamiResult.isError, undefined)
	const parsedWhoami = JSON.parse(whoamiResult.content[0].text)
	assert.equal(parsedWhoami.authenticated, true)
	assert.equal(parsedWhoami.email, 'mcp-whoami@example.com')
	const getResult = await executeTool('auth', { action: 'get', sessionId: session.id }, session.token)
	assert.equal(getResult.isError, undefined)
	const parsedGet = JSON.parse(getResult.content[0].text)
	assert.equal(parsedGet.session.id, session.id)
})

test('teardown server', (t, done) => {
	server.close(() => {
		fs.rmSync(testDbPath, { force: true })
		fs.rmSync(`${testDbPath}-wal`, { force: true })
		fs.rmSync(`${testDbPath}-shm`, { force: true })
		done()
	})
})
