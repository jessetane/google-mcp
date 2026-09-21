import * as db from './db/index.js'

export {
	getFreshGoogleToken,
	proxyGoogleApi,
	getUserInfo
}

const clientId = process.env.GOOGLE_CLIENT_ID
const clientSecret = process.env.GOOGLE_CLIENT_SECRET

async function refreshGoogleAccessToken (session) {
	const params = new URLSearchParams({
		client_id: clientId,
		client_secret: clientSecret,
		refresh_token: session.refreshToken,
		grant_type: 'refresh_token'
	})
	const res = await fetch('https://oauth2.googleapis.com/token', {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: params.toString()
	})
	const data = await res.json()
	if (!res.ok) {
		const err = new Error(data.error_description || data.error || 'Failed to refresh Google token')
		err.status = res.status
		err.data = data
		throw err
	}
	const expiresAt = Date.now() + ((data.expires_in || 3600) * 1000)
	db.sessions.updateTokens(session.id, {
		accessToken: data.access_token,
		expiresAt,
		refreshToken: data.refresh_token || null
	})
	return data.access_token
}

async function getFreshGoogleToken (token) {
	if (!token) return null
	const session = db.sessions.getByToken(token)
	if (session) {
		if (session.refreshToken && (!session.expiresAt || Date.now() > session.expiresAt - 60000)) {
			return await refreshGoogleAccessToken(session)
		}
		return session.accessToken
	}
	return null
}

async function getUserInfo (googleToken) {
	const res = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
		headers: { authorization: `Bearer ${googleToken}` }
	})
	if (!res.ok) {
		const data = await res.json().catch(function () { return null })
		const err = new Error(data?.error_description || data?.error?.message || 'Failed to fetch user info')
		err.status = res.status
		err.data = data
		throw err
	}
	return await res.json()
}

async function proxyGoogleApi (opts = {}) {
	const { token, baseUrl, path, method = 'GET', query, body, headers = {} } = opts
	let url = `${baseUrl.replace(/\/$/, '')}/${path.replace(/^\//, '')}`
	if (query && typeof query === 'object' && Object.keys(query).length > 0) {
		const params = new URLSearchParams()
		for (const [k, v] of Object.entries(query)) {
			if (v !== undefined && v !== null) params.append(k, String(v))
		}
		const q = params.toString()
		if (q) url += (url.includes('?') ? '&' : '?') + q
	}
	const reqHeaders = {
		authorization: `Bearer ${token}`,
		...headers
	}
	let reqBody
	if (body !== undefined && body !== null) {
		if (typeof body === 'object') {
			reqHeaders['content-type'] = reqHeaders['content-type'] || 'application/json'
			reqBody = JSON.stringify(body)
		} else {
			reqBody = String(body)
		}
	}
	const res = await fetch(url, {
		method: method.toUpperCase(),
		headers: reqHeaders,
		body: reqBody
	})
	const contentType = (res.headers.get('content-type') || '').split(';')[0].trim()
	let result
	if (contentType === 'application/json') {
		result = await res.json()
	} else if (contentType.startsWith('text/')) {
		result = await res.text()
	} else {
		const buf = await res.arrayBuffer()
		result = { binary: true, mimeType: contentType, data: Buffer.from(buf).toString('base64') }
	}
	if (!res.ok) {
		const msg = result?.binary ? `Binary error response (${contentType})`
			: typeof result === 'object' ? JSON.stringify(result)
			: result
		const err = new Error(msg)
		err.status = res.status
		err.data = result
		throw err
	}
	return result
}
