import { createHash, timingSafeEqual } from 'node:crypto'
import * as db from './db/index.js'
import { getUserInfo } from './google.js'
import { getBody } from './util.js'

export {
	handleAuthorize,
	handleCallback,
	handleToken,
	handleProtectedResourceMetadata,
	handleAuthServerMetadata,
	isAllowedRedirectUri
}

const appUrl = process.env.APP_URL || 'http://localhost:8080'
const clientId = process.env.GOOGLE_CLIENT_ID
const clientSecret = process.env.GOOGLE_CLIENT_SECRET
const scopes = [
	'https://www.googleapis.com/auth/drive',
	'https://www.googleapis.com/auth/spreadsheets',
	'https://www.googleapis.com/auth/documents',
	'https://www.googleapis.com/auth/userinfo.email',
	'https://www.googleapis.com/auth/userinfo.profile'
].join(' ')

function getClientIp (req) {
	return req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || null
}

function verifyCodeChallenge (verifier, challenge, method) {
	if (typeof verifier !== 'string' || typeof challenge !== 'string') return false
	if (method === 'S256') {
		const hash = createHash('sha256').update(verifier).digest('base64url')
		const bufHash = Buffer.from(hash)
		const bufChallenge = Buffer.from(challenge)
		if (bufHash.byteLength !== bufChallenge.byteLength) return false
		return timingSafeEqual(bufHash, bufChallenge)
	}
	return false
}

function isAllowedRedirectUri (redirectUri) {
	if (!redirectUri) return false
	let url
	try {
		url = new URL(redirectUri)
	} catch {
		return false
	}
	const envDomains = process.env.ALLOWED_REDIRECT_DOMAINS || 'localhost,127.0.0.1,chatgpt.com,chat.openai.com,claude.ai,claude.com,typingmind.com,dify.ai,coze.com,poe.com,mistral.ai'
	const allowedDomains = envDomains.split(',').map(d => d.trim().toLowerCase()).filter(Boolean)
	const hostname = url.hostname.toLowerCase()
	return allowedDomains.some(domain => hostname === domain || hostname.endsWith(`.${domain}`))
}

async function handleProtectedResourceMetadata (req, res) {
	const base = appUrl.replace(/\/$/, '')
	const meta = {
		resource: `${base}/mcp`,
		authorization_servers: [base]
	}
	res.statusCode = 200
	res.setHeader('content-type', 'application/json; charset=utf-8')
	res.end(JSON.stringify(meta, null, '\t'))
}

async function handleAuthServerMetadata (req, res) {
	const base = appUrl.replace(/\/$/, '')
	const meta = {
		issuer: base,
		authorization_endpoint: `${base}/oauth/authorize`,
		token_endpoint: `${base}/oauth/token`,
		response_types_supported: ['code'],
		grant_types_supported: ['authorization_code'],
		token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
		code_challenge_methods_supported: ['S256'],
		client_id_metadata_document_supported: true
	}
	res.statusCode = 200
	res.setHeader('content-type', 'application/json; charset=utf-8')
	res.end(JSON.stringify(meta, null, '\t'))
}

async function handleAuthorize (req, res, query) {
	if (!clientId) {
		res.statusCode = 500
		res.setHeader('content-type', 'text/plain')
		res.end('GOOGLE_CLIENT_ID missing')
		return
	}
	if (query.redirect_uri) {
		if (!isAllowedRedirectUri(query.redirect_uri)) {
			console.warn(`[oauth] Unauthorized redirect_uri: "${query.redirect_uri}". Add domain to ALLOWED_REDIRECT_DOMAINS to allow.`)
			res.statusCode = 400
			res.setHeader('content-type', 'application/json; charset=utf-8')
			res.end(JSON.stringify({ error: 'invalid_request', error_description: `redirect_uri is not allowed: ${query.redirect_uri}` }))
			return
		}
		if (!query.code_challenge) {
			res.statusCode = 400
			res.setHeader('content-type', 'application/json; charset=utf-8')
			res.end(JSON.stringify({ error: 'invalid_request', error_description: 'code_challenge required when redirect_uri is provided' }))
			return
		}
	}
	if (query.code_challenge_method && !query.code_challenge) {
		res.statusCode = 400
		res.setHeader('content-type', 'application/json; charset=utf-8')
		res.end(JSON.stringify({ error: 'invalid_request', error_description: 'code_challenge_method provided without code_challenge' }))
		return
	}
	const codeChallenge = query.code_challenge || null
	const codeChallengeMethod = query.code_challenge_method || (codeChallenge ? 'S256' : null)
	if (codeChallengeMethod && codeChallengeMethod !== 'S256') {
		res.statusCode = 400
		res.setHeader('content-type', 'application/json; charset=utf-8')
		res.end(JSON.stringify({ error: 'invalid_request', error_description: 'unsupported code_challenge_method' }))
		return
	}
	const callbackUrl = `${appUrl.replace(/\/$/, '')}/oauth/callback`
	const ip = getClientIp(req)
	const stateToken = db.oauthStates.create({
		clientRedirectUri: query.redirect_uri || null,
		clientState: query.state || null,
		codeChallenge,
		codeChallengeMethod,
		ip
	})
	const u = new URL('https://accounts.google.com/o/oauth2/v2/auth')
	u.searchParams.set('client_id', clientId)
	u.searchParams.set('redirect_uri', callbackUrl)
	u.searchParams.set('response_type', 'code')
	u.searchParams.set('scope', scopes)
	u.searchParams.set('access_type', 'offline')
	u.searchParams.set('prompt', 'consent')
	u.searchParams.set('state', stateToken)
	res.statusCode = 302
	res.setHeader('location', u.toString())
	res.end()
}

async function handleCallback (req, res, query) {
	const code = query.code
	const rawState = query.state
	if (!code) {
		res.statusCode = 400
		res.setHeader('content-type', 'text/plain')
		res.end(`Google Auth Error: ${query.error || 'no code'}`)
		return
	}
	const oauthState = db.oauthStates.consume(rawState)
	if (!oauthState) {
		res.statusCode = 403
		res.setHeader('content-type', 'text/plain')
		res.end('Invalid or expired OAuth state (CSRF verification failed). Please try initiating sign-in again.')
		return
	}
	const callbackUrl = `${appUrl.replace(/\/$/, '')}/oauth/callback`
	const params = new URLSearchParams({
		code,
		client_id: clientId,
		client_secret: clientSecret,
		redirect_uri: callbackUrl,
		grant_type: 'authorization_code'
	})
	const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: params.toString()
	})
	const tokenData = await tokenRes.json()
	if (!tokenRes.ok) {
		console.error('Google token exchange failed:', tokenData)
		res.statusCode = 502
		res.setHeader('content-type', 'text/plain')
		res.end('Failed to exchange authorization code with Google')
		return
	}
	const googleUser = await getUserInfo(tokenData.access_token)
	const email = (googleUser.email || '').toLowerCase()
	if (!email) {
		res.statusCode = 400
		res.setHeader('content-type', 'text/plain')
		res.end('Could not retrieve user email from Google account.')
		return
	}
	const user = db.users.upsert({
		email,
		name: googleUser.name || null,
		picture: googleUser.picture || null
	})
	const ip = getClientIp(req)
	const ua = req.headers['user-agent'] || null
	const session = db.sessions.create({
		userId: user.id,
		refreshToken: tokenData.refresh_token || null,
		accessToken: tokenData.access_token,
		expiresAt: Date.now() + ((tokenData.expires_in || 3600) * 1000),
		ip,
		ua
	})
	if (oauthState.clientRedirectUri) {
		const authCode = db.oauthCodes.create({
			sessionId: session.id,
			clientRedirectUri: oauthState.clientRedirectUri,
			codeChallenge: oauthState.codeChallenge,
			codeChallengeMethod: oauthState.codeChallengeMethod
		})
		const target = new URL(oauthState.clientRedirectUri)
		target.searchParams.set('code', authCode)
		if (oauthState.clientState) target.searchParams.set('state', oauthState.clientState)
		res.statusCode = 302
		res.setHeader('location', target.toString())
		res.end()
		return
	}
	res.statusCode = 200
	res.setHeader('content-type', 'text/plain; charset=utf-8')
	res.end(`user: ${email}\ntoken: ${session.token}\n\nheader:\nAuthorization: Bearer ${session.token}\n`)
}

async function handleToken (req, res) {
	if (req.method !== 'POST') {
		res.statusCode = 405
		res.end('Method Not Allowed')
		return
	}
	const rawBody = await getBody(req)
	let code = null
	let redirectUri = null
	let codeVerifier = null
	const contentType = req.headers['content-type'] || ''
	if (contentType.includes('application/json')) {
		let parsed
		try {
			parsed = JSON.parse(rawBody)
		} catch (err) {
			const parseErr = new Error('invalid_request: Malformed JSON body')
			parseErr.code = 400
			throw parseErr
		}
		code = parsed?.code
		redirectUri = parsed?.redirect_uri
		codeVerifier = parsed?.code_verifier
	}
	if (!code) {
		const params = new URLSearchParams(rawBody)
		code = params.get('code')
		redirectUri = redirectUri || params.get('redirect_uri')
		codeVerifier = codeVerifier || params.get('code_verifier')
	}
	if (!code) {
		res.statusCode = 400
		res.setHeader('content-type', 'application/json; charset=utf-8')
		res.end(JSON.stringify({ error: 'invalid_request', error_description: 'Missing code' }))
		return
	}
	const authCode = db.oauthCodes.consume(code)
	if (!authCode) {
		res.statusCode = 400
		res.setHeader('content-type', 'application/json; charset=utf-8')
		res.end(JSON.stringify({ error: 'invalid_grant', error_description: 'Invalid or expired authorization code' }))
		return
	}
	if (authCode.clientRedirectUri && authCode.clientRedirectUri !== redirectUri) {
		res.statusCode = 400
		res.setHeader('content-type', 'application/json; charset=utf-8')
		res.end(JSON.stringify({ error: 'invalid_grant', error_description: 'redirect_uri mismatch' }))
		return
	}
	if (authCode.codeChallenge) {
		if (!codeVerifier) {
			res.statusCode = 400
			res.setHeader('content-type', 'application/json; charset=utf-8')
			res.end(JSON.stringify({ error: 'invalid_grant', error_description: 'Missing code_verifier' }))
			return
		}
		if (typeof codeVerifier !== 'string' || codeVerifier.length < 43 || codeVerifier.length > 128) {
			res.statusCode = 400
			res.setHeader('content-type', 'application/json; charset=utf-8')
			res.end(JSON.stringify({ error: 'invalid_grant', error_description: 'Invalid code_verifier' }))
			return
		}
		if (!verifyCodeChallenge(codeVerifier, authCode.codeChallenge, authCode.codeChallengeMethod)) {
			res.statusCode = 400
			res.setHeader('content-type', 'application/json; charset=utf-8')
			res.end(JSON.stringify({ error: 'invalid_grant', error_description: 'Invalid code_verifier' }))
			return
		}
	}
	const session = db.sessions.get(authCode.sessionId)
	if (!session) {
		res.statusCode = 400
		res.setHeader('content-type', 'application/json; charset=utf-8')
		res.end(JSON.stringify({ error: 'invalid_grant', error_description: 'Session not found' }))
		return
	}
	res.statusCode = 200
	res.setHeader('content-type', 'application/json; charset=utf-8')
	res.end(JSON.stringify({
		access_token: session.token,
		token_type: 'bearer',
		expires_in: 30 * 24 * 60 * 60
	}))
}
