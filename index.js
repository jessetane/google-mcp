#!/usr/bin/env node

import 'dotenv/config'
import http from 'node:http'
import RpcEngine from 'rpc-engine'
import * as oauth from './oauth.js'
import * as google from './google.js'
import { tools, executeTool } from './mcp.js'
import { getBody } from './util.js'

export { server }

const host = process.env.HOST || '::1'
const port = process.env.PORT || '8080'

function resolveToken (req) {
	const auth = req.headers.authorization || ''
	return auth.replace(/^Bearer\s+/i, '').trim() || req.headers['x-api-key'] || null
}

const rpcMethods = {
	initialize: () => {
		return {
			protocolVersion: '2024-11-05',
			capabilities: { tools: { listChanged: false } },
			serverInfo: { name: 'gdrive-mcp', version: '1.0.0' }
		}
	},
	'notifications/initialized': () => {
		return {}
	},
	ping: () => {
		return {}
	},
	'tools/list': () => {
		return { tools }
	},
	'tools/call': params => {
		const name = params?.name
		const args = { ...params?.arguments }
		return executeTool(name, args, params?.token)
	}
}

async function handleMcp (req, res, token) {
	if (req.method !== 'POST') {
		const err = new Error('Method Not Allowed')
		err.code = 405
		throw err
	}
	const rpc = new RpcEngine({
		objectMode: true,
		deserialize: data => {
			data = JSON.parse(data)
			return data
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
			return rpcMethods['tools/call']({ ...params, token })
		}
	}
	const request = await getBody(req)
	await rpc.receive(request)
	if (!res.writableEnded) {
		rpc.send()
	}
}

const server = http.createServer(async (req, res) => {
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
	const pathname = url.pathname.replace(/\/+$/, '') || '/'
	try {
		if (pathname === '/') {
			res.statusCode = 200
			res.setHeader('content-type', 'text/plain; charset=utf-8')
			res.end('gdrive-mcp\n\nendpoints:\n  POST /mcp\n  GET  /oauth/authorize\n  POST /oauth/token\n')
			return
		}
		if (pathname === '/api/health') {
			res.statusCode = 200
			res.setHeader('content-type', 'text/plain')
			res.end('ok\n')
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
		if (pathname === '/oauth/callback') {
			await oauth.handleCallback(req, res, query)
			return
		}
		if (pathname === '/oauth/token') {
			await oauth.handleToken(req, res)
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
		console.log(`gdrive-mcp listening on ${host}:${port}`)
	})
}
