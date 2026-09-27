import * as api from './api/index.js'
import { getBody } from './util.js'

export {
	handleRest
}

function sendJson (res, data, status = 200) {
	res.statusCode = status
	res.setHeader('content-type', 'application/json; charset=utf-8')
	res.end(typeof data === 'string' ? data : JSON.stringify(data, null, '\t'))
}

function sendBinary (res, data, mimeType = 'application/octet-stream') {
	res.statusCode = 200
	res.setHeader('content-type', mimeType)
	res.end(Buffer.from(data, 'base64'))
}

async function handleGoogle (req, res, pathname, url, token) {
	const targetPath = pathname.slice('/api/google/'.length)
	if (!targetPath) {
		const err = new Error('not found')
		err.code = 404
		throw err
	}
	const search = url?.search || ''
	const targetUrl = `${targetPath}${search}`
	let body = undefined
	if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
		body = await getBody(req)
		if (typeof body === 'string' && (body.trim().startsWith('{') || body.trim().startsWith('['))) {
			try {
				body = JSON.parse(body)
			} catch {}
		}
	}
	const result = await api.google.request({
		url: targetUrl,
		method: req.method,
		body
	}, token)
	if (result?.binary) {
		sendBinary(res, result.data, result.mimeType)
		return
	}
	sendJson(res, result)
}

const routes = {
	'/api/health': {
		GET (req, res) {
			res.statusCode = 200
			res.setHeader('content-type', 'text/plain')
			res.end('ok\n')
		}
	},
	'/api/whoami': {
		async GET (req, res, { token }) {
			const result = await api.auth.whoami(token)
			sendJson(res, result)
		}
	},
	'/api/sessions': {
		async GET (req, res, { token }) {
			const result = await api.auth.list(token)
			sendJson(res, result)
		},
		async DELETE (req, res, { token, query }) {
			const result = await api.auth.revoke(token, { allOthers: query.allOthers === 'true' })
			sendJson(res, result)
		}
	}
}

async function handleRest (req, res, { pathname, url, query, token }) {
	if (pathname.startsWith('/api/google/')) {
		await handleGoogle(req, res, pathname, url, token)
		return
	}
	if (pathname.startsWith('/api/sessions/')) {
		const sessionId = pathname.slice('/api/sessions/'.length)
		if (req.method === 'GET') {
			const result = await api.auth.get(token, sessionId)
			sendJson(res, result)
			return
		}
		if (req.method === 'DELETE') {
			const result = await api.auth.revoke(token, { sessionId })
			sendJson(res, result)
			return
		}
		const err = new Error('Method Not Allowed')
		err.code = 405
		throw err
	}
	const route = routes[pathname]
	if (!route) {
		const err = new Error('not found')
		err.code = 404
		throw err
	}
	const handler = route[req.method]
	if (!handler) {
		const err = new Error('Method Not Allowed')
		err.code = 405
		throw err
	}
	await handler(req, res, { token, query })
}
