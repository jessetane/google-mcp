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

fs.rmSync(testDbPath, { force: true })
fs.rmSync(`${testDbPath}-wal`, { force: true })
fs.rmSync(`${testDbPath}-shm`, { force: true })

const { server } = await import('../index.js')
const db = await import('../db/index.js')

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
	const text = await res.text()
	assert.match(text, /endpoints:/)
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
	assert.equal(initData.result.serverInfo.name, 'gdrive-mcp')

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
	assert.deepEqual(toolNames, ['authStatus', 'driveApi', 'sheetsApi', 'docsApi'])
})

test('mcp authStatus tool without auth', async () => {
	const addr = server.address()
	const res = await fetch(`http://127.0.0.1:${addr.port}/mcp`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			jsonrpc: '2.0',
			id: 3,
			method: 'tools/call',
			params: {
				name: 'authStatus',
				arguments: {}
			}
		})
	})
	assert.equal(res.status, 200)
	const data = await res.json()
	const parsed = JSON.parse(data.result.content[0].text)
	assert.equal(parsed.authenticated, false)
})

test('mcp driveApi tool requires auth', async () => {
	const addr = server.address()
	const res = await fetch(`http://127.0.0.1:${addr.port}/mcp`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			jsonrpc: '2.0',
			id: 4,
			method: 'tools/call',
			params: {
				name: 'driveApi',
				arguments: { path: 'files' }
			}
		})
	})
	assert.equal(res.status, 200)
	const data = await res.json()
	assert.equal(data.result.isError, true)
	assert.match(data.result.content[0].text, /Authentication required/)
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
	assert.equal(data.token_type, 'bearer')
	assert.equal(db.oauthCodes.consume(code2), null)

	const badJsonRes = await fetch(`http://127.0.0.1:${addr.port}/oauth/token`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: '{"invalid_json'
	})
	assert.equal(badJsonRes.status, 400)
	const badJsonData = await badJsonRes.json()
	assert.match(badJsonData.error, /invalid_request/)
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
	assert.deepEqual(authData.code_challenge_methods_supported, ['S256'])
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
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			code: codeWrong,
			redirect_uri: 'https://chatgpt.com/callback',
			code_verifier: 'wrong-verifier-length-must-be-at-least-43-chars-long'
		})
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
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			code: codeSuccess,
			redirect_uri: 'https://chatgpt.com/callback',
			code_verifier: verifier
		})
	})
	assert.equal(successRes.status, 200)
	const successData = await successRes.json()
	assert.equal(successData.access_token, session.token)
	const shortVerifierRes = await fetch(`http://127.0.0.1:${addr.port}/oauth/token`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			code: db.oauthCodes.create({
				sessionId: session.id,
				clientRedirectUri: 'https://chatgpt.com/callback',
				codeChallenge: challenge,
				codeChallengeMethod: 'S256'
			}),
			redirect_uri: 'https://chatgpt.com/callback',
			code_verifier: 'short'
		})
	})
	assert.equal(shortVerifierRes.status, 400)
	const shortData = await shortVerifierRes.json()
	assert.equal(shortData.error_description, 'Invalid code_verifier')
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
	const authRes = await fetch(`http://127.0.0.1:${addr.port}/oauth/authorize?redirect_uri=https://chatgpt.com/callback&state=test-state&code_challenge=${challenge}&code_challenge_method=S256`, {
		redirect: 'manual'
	})
	assert.equal(authRes.status, 302)
	const location = authRes.headers.get('location')
	assert.ok(location)
	const targetUrl = new URL(location)
	const stateParam = targetUrl.searchParams.get('state')
	assert.ok(stateParam)
	const stateRow = db.oauthStates.consume(stateParam)
	assert.equal(stateRow.clientRedirectUri, 'https://chatgpt.com/callback')
	assert.equal(stateRow.clientState, 'test-state')
	assert.equal(stateRow.codeChallenge, challenge)
	assert.equal(stateRow.codeChallengeMethod, 'S256')
	const directAuthRes = await fetch(`http://127.0.0.1:${addr.port}/oauth/authorize`, {
		redirect: 'manual'
	})
	assert.equal(directAuthRes.status, 302)
	const directLocation = directAuthRes.headers.get('location')
	assert.ok(directLocation)
	const directStateParam = new URL(directLocation).searchParams.get('state')
	const directStateRow = db.oauthStates.consume(directStateParam)
	assert.equal(directStateRow.clientRedirectUri, null)
	assert.equal(directStateRow.codeChallenge, null)
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

test('teardown server', (t, done) => {
	server.close(() => {
		fs.rmSync(testDbPath, { force: true })
		fs.rmSync(`${testDbPath}-wal`, { force: true })
		fs.rmSync(`${testDbPath}-shm`, { force: true })
		done()
	})
})
