#!/usr/bin/env node

import 'dotenv/config'
import http from 'node:http'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { handleOauth } from './oauth.js'
import { handleMcp } from './mcp.js'
import { handleRest } from './rest.js'

export { server }

const dirname = path.dirname(fileURLToPath(import.meta.url))
const host = process.env.HOST || '::1'
const port = process.env.PORT || '8080'
const appUrl = process.env.APP_URL || 'http://localhost:8080'
const corsOrigin = process.env.CORS_ORIGIN || '*'

function resolveToken (req) {
	const auth = req.headers.authorization || ''
	return auth.replace(/^Bearer\s+/i, '').trim() || req.headers['x-api-key'] || null
}

const server = http.createServer(async (req, res) => {
	const start = Date.now()
	res.on('finish', () => {
		if (process.env.NODE_ENV !== 'test') {
			const duration = Date.now() - start
			console.log(`[${res.statusCode}] ${req.method} ${req.url} (${duration}ms)`)
		}
	})
	res.setHeader('access-control-allow-origin', corsOrigin)
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
	const token = resolveToken(req)
	try {
		if (pathname === '/') {
			const indexHtml = await fs.readFile(path.join(dirname, 'public/index.html'), 'utf8')
			res.statusCode = 200
			res.setHeader('content-type', 'text/html; charset=utf-8')
			res.end(indexHtml.replaceAll('{{APP_URL}}', appUrl.replace(/\/$/, '')))
			return
		}
		if (pathname.startsWith('/api/')) {
			await handleRest(req, res, { pathname, url, query, token })
			return
		}
		if (pathname === '/mcp') {
			await handleMcp(req, res, token)
			return
		}
		if (pathname.startsWith('/oauth/') || pathname.startsWith('/.well-known/oauth-')) {
			await handleOauth(req, res, { pathname, query })
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
		if (!res.headersSent && !res.writableEnded) {
			res.statusCode = statusCode
			res.setHeader('content-type', 'application/json; charset=utf-8')
			res.end(JSON.stringify({ error: message }))
		}
	}
})

if (process.env.NODE_ENV !== 'test') {
	server.listen(port, host, () => {
		console.log(`google-mcp listening on ${host}:${port}`)
	})
}
