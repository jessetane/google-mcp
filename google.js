import * as db from './db/index.js'

export {
	getFreshGoogleToken,
	proxyGoogleApi,
	getUserInfo,
	readResponseBody,
	isGoogleApiUrl
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
		refreshToken: data.refresh_token || null,
		scope: data.scope || null
	})
	return {
		token: data.access_token,
		session: db.sessions.get(session.id)
	}
}

async function getFreshGoogleToken (token) {
	if (!token) return null
	const session = db.sessions.getByToken(token)
	if (session) {
		if (session.refreshToken && (!session.expiresAt || Date.now() > session.expiresAt - 60000)) {
			const refreshed = await refreshGoogleAccessToken(session)
			return {
				token: refreshed.token,
				session: refreshed.session
			}
		}
		return {
			token: session.accessToken,
			session
		}
	}
	return null
}

async function getUserInfo (googleToken) {
	const res = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
		headers: { authorization: `Bearer ${googleToken}` }
	})
	if (!res.ok) {
		let data = await res.text()
		try {
			data = JSON.parse(data)
		} catch (e) {}
		const msg = typeof data === 'object'
			? (data?.error_description || data?.error?.message || JSON.stringify(data))
			: (data || 'Failed to fetch user info')
		const err = new Error(msg)
		err.status = res.status
		err.data = data
		throw err
	}
	return await res.json()
}

function isGoogleApiUrl (urlString) {
	try {
		const parsed = new URL(urlString)
		if (parsed.protocol !== 'https:') return false
		const hostname = parsed.hostname.toLowerCase()
		return hostname === 'googleapis.com' || hostname.endsWith('.googleapis.com')
	} catch {
		return false
	}
}

async function readResponseBody (res, maxBytes) {
	if (!res.body) return Buffer.alloc(0)
	const chunks = []
	let totalBytes = 0
	const reader = res.body.getReader()
	try {
		while (true) {
			const { done, value } = await reader.read()
			if (done) break
			totalBytes += value.byteLength
			if (totalBytes > maxBytes) {
				await reader.cancel()
				const sizeMb = (totalBytes / (1024 * 1024)).toFixed(1)
				const limitMb = (maxBytes / (1024 * 1024)).toFixed(0)
				const err = new Error(`File too large: size (${sizeMb} MB) exceeds server limit of ${limitMb} MB. Consider exporting specific sheets, ranges, or text sections instead.`)
				err.status = 413
				throw err
			}
			chunks.push(value)
		}
	} finally {
		reader.releaseLock?.()
	}
	return Buffer.concat(chunks)
}

async function proxyGoogleApi (opts = {}) {
	const { token, url: targetUrl, method = 'GET', query, body, headers = {} } = opts
	if (!targetUrl) {
		const err = new Error('Missing url parameter')
		err.status = 400
		throw err
	}
	let fullUrl = targetUrl.startsWith('http://') || targetUrl.startsWith('https://')
		? targetUrl
		: `https://www.googleapis.com/${targetUrl.replace(/^\//, '')}`

	if (!isGoogleApiUrl(fullUrl)) {
		const err = new Error(`Target URL domain not allowed. Requests must target *.googleapis.com, got: ${fullUrl}`)
		err.status = 403
		throw err
	}

	if (query && typeof query === 'object' && Object.keys(query).length > 0) {
		const parsed = new URL(fullUrl)
		for (const [k, v] of Object.entries(query)) {
			if (v !== undefined && v !== null) parsed.searchParams.append(k, String(v))
		}
		fullUrl = parsed.toString()
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
	const reqMethod = method.toUpperCase()
	const fetchOpts = {
		method: reqMethod,
		headers: reqHeaders
	}
	if (reqMethod !== 'GET' && reqMethod !== 'HEAD' && reqBody !== undefined) {
		fetchOpts.body = reqBody
	}
	const res = await fetch(fullUrl, fetchOpts)
	const maxFileSizeMb = Number(process.env.MAX_FILE_SIZE_MB) || 10
	const maxFileSizeBytes = maxFileSizeMb * 1024 * 1024
	const contentLength = res.headers.get('content-length')
	if (contentLength && Number(contentLength) > maxFileSizeBytes) {
		const sizeMb = (Number(contentLength) / (1024 * 1024)).toFixed(1)
		const limitMb = (maxFileSizeBytes / (1024 * 1024)).toFixed(0)
		const err = new Error(`File too large: size (${sizeMb} MB) exceeds server limit of ${limitMb} MB. Consider exporting specific sheets, ranges, or text sections instead.`)
		err.status = 413
		throw err
	}
	const rawContentType = res.headers.get('content-type') || ''
	const contentType = rawContentType.split(';')[0].trim()
	const charsetMatch = rawContentType.match(/charset=([^;]+)/i)
	const charset = charsetMatch ? charsetMatch[1].trim().replace(/^["']|["']$/g, '') : undefined
	const buf = await readResponseBody(res, maxFileSizeBytes)
	let result
	if (contentType === 'application/json') {
		const str = buf.toString('utf8')
		try {
			result = str ? JSON.parse(str) : {}
		} catch {
			result = str
		}
	} else if (contentType.startsWith('text/')) {
		result = buf.toString(charset || 'utf8')
	} else {
		result = { binary: true, mimeType: contentType, ...(charset && { charset }), data: buf.toString('base64') }
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
