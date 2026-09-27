#!/usr/bin/env node

import 'dotenv/config'
import http from 'node:http'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import RpcEngine from 'rpc-engine'
import * as oauth from './oauth.js'
import * as google from './google.js'
import * as api from './api/index.js'
import { tools, executeTool } from './mcp.js'
import { getBody } from './util.js'

export { server }

const dirname = path.dirname(fileURLToPath(import.meta.url))

const host = process.env.HOST || '::1'
const port = process.env.PORT || '8080'
const appUrl = process.env.APP_URL || 'http://localhost:8080'

function resolveToken (req) {
	const auth = req.headers.authorization || ''
	return auth.replace(/^Bearer\s+/i, '').trim() || req.headers['x-api-key'] || null
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
			data = JSON.stringify(data)
			return data
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
		'tools/call': params => {
			return rpcMethods['tools/call'](params, token)
		}
	}
	const request = await getBody(req)
	await rpc.receive(request)
	if (!res.writableEnded) {
		rpc.send()
	}
}

const server = http.createServer(async (req, res) => {
	const start = Date.now()
	res.on('finish', () => {
		if (process.env.NODE_ENV !== 'test') {
			const duration = Date.now() - start
			console.log(`[${res.statusCode}] ${req.method} ${req.url} (${duration}ms)`)
		}
	})
	res.setHeader('access-control-allow-origin', '*')
	res.setHeader('access-control-allow-methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS')
	res.setHeader('access-control-allow-headers', 'authorization, content-type, mcp-session-id, x-api-key, accept')
	if (req.method === 'OPTIONS') {
		res.statusCode = 204
		res.end()
		return
	}
	const url = new URL(req.url, 'http://localhost')
	const query = Object.fromEntries(url.searchParams)
	for (const key of ['services', 'write']) {
		const all = url.searchParams.getAll(key)
		if (all.length > 1) query[key] = all.join(',')
	}
	const pathname = url.pathname.replace(/\/+$/, '') || '/'
	try {
		if (pathname === '/') {
			const indexHtml = await fs.readFile(path.join(dirname, 'public/index.html'), 'utf8')
			const html = indexHtml.replaceAll('{{APP_URL}}', appUrl.replace(/\/$/, ''))
			res.statusCode = 200
			res.setHeader('content-type', 'text/html; charset=utf-8')
			res.end(html)
			return
		}
		if (pathname === '/api/health') {
			res.statusCode = 200
			res.setHeader('content-type', 'text/plain')
			res.end('ok\n')
			return
		}
		if (pathname === '/api/whoami') {
			if (req.method !== 'GET') {
				const err = new Error('Method Not Allowed')
				err.code = 405
				throw err
			}
			const token = resolveToken(req)
			const result = await api.auth.whoami(token)
			res.statusCode = 200
			res.setHeader('content-type', 'application/json; charset=utf-8')
			res.end(JSON.stringify(result, null, '\t'))
			return
		}
		if (pathname === '/api/sessions') {
			const token = resolveToken(req)
			if (req.method === 'GET') {
				const result = await api.auth.list(token)
				res.statusCode = 200
				res.setHeader('content-type', 'application/json; charset=utf-8')
				res.end(JSON.stringify(result, null, '\t'))
				return
			}
			if (req.method === 'DELETE') {
				const result = await api.auth.revoke(token, {
					allOthers: query.allOthers === 'true'
				})
				res.statusCode = 200
				res.setHeader('content-type', 'application/json; charset=utf-8')
				res.end(JSON.stringify(result, null, '\t'))
				return
			}
			const err = new Error('Method Not Allowed')
			err.code = 405
			throw err
		}
		if (pathname.startsWith('/api/sessions/')) {
			const token = resolveToken(req)
			const sessionId = pathname.slice('/api/sessions/'.length)
			if (req.method === 'GET') {
				const result = await api.auth.get(token, sessionId)
				res.statusCode = 200
				res.setHeader('content-type', 'application/json; charset=utf-8')
				res.end(JSON.stringify(result, null, '\t'))
				return
			}
			if (req.method === 'DELETE') {
				const result = await api.auth.revoke(token, { sessionId })
				res.statusCode = 200
				res.setHeader('content-type', 'application/json; charset=utf-8')
				res.end(JSON.stringify(result, null, '\t'))
				return
			}
			const err = new Error('Method Not Allowed')
			err.code = 405
			throw err
		}
		if (pathname === '/api/google' || pathname.startsWith('/api/google/')) {
			const token = resolveToken(req)
			let targetUrl = pathname.startsWith('/api/google/') ? pathname.slice('/api/google/'.length) : (query.url || '')
			let body = undefined
			if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
				body = await getBody(req)
				if (typeof body === 'string' && body.trim().startsWith('{')) {
					try {
						body = JSON.parse(body)
					} catch {}
				}
				if (!targetUrl && body?.url) {
					targetUrl = body.url
					delete body.url
				}
			}
			const result = await api.google.request({
				url: targetUrl,
				method: req.method,
				query,
				body
			}, token)
			if (result?.binary) {
				res.statusCode = 200
				res.setHeader('content-type', result.mimeType || 'application/octet-stream')
				res.end(Buffer.from(result.data, 'base64'))
				return
			}
			res.statusCode = 200
			res.setHeader('content-type', 'application/json; charset=utf-8')
			res.end(typeof result === 'string' ? result : JSON.stringify(result, null, '\t'))
			return
		}
		if (pathname === '/.well-known/oauth-protected-resource') {
			await oauth.handleProtectedResourceMetadata(req, res)
			return
		}
		if (pathname === '/.well-known/oauth-authorization-server') {
			await oauth.handleAuthServerMetadata(req, res)
			return
		}
		if (pathname === '/mcp') {
			const token = resolveToken(req)
			await handleMcp(req, res, token)
			return
		}
		if (pathname === '/oauth/authorize') {
			await oauth.handleAuthorize(req, res, query)
			return
		}
		if (pathname === '/oauth/authorize/consent') {
			await oauth.handleAuthorizeConsent(req, res)
			return
		}
		if (pathname === '/oauth/callback') {
			await oauth.handleCallback(req, res, query)
			return
		}
		if (pathname === '/oauth/token') {
			await oauth.handleToken(req, res)
			return
		}
		if (pathname === '/oauth/revoke') {
			await oauth.handleRevoke(req, res)
			return
		}
		const err = new Error('not found')
		err.code = 404
		throw err
	} catch (err) {
		const statusCode = typeof err.code === 'number' ? err.code : (err.status || 500)
		let message = err.message
		if (statusCode >= 500) {
			console.error(err)
			message = 'Internal Server Error'
		}
		res.statusCode = statusCode
		res.setHeader('content-type', 'application/json; charset=utf-8')
		res.end(JSON.stringify({ error: message }))
	}
})

if (process.env.NODE_ENV !== 'test') {
	server.listen(port, host, () => {
		console.log(`google-mcp listening on ${host}:${port}`)
	})
}
