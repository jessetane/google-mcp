import * as db from './db/index.js'

export {
	getFreshGoogleToken,
	proxyGoogleApi,
	getUserInfo,
	readResponseBody
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
