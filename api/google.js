import { proxyGoogleApi, getFreshGoogleToken } from '../google.js'
import { evaluatePolicy } from '../policy.js'

export {
	request
}

async function request ({ url, method = 'GET', body, headers } = {}, token) {
	if (!url) {
		const err = new Error('URL is required')
		err.status = 400
		throw err
	}
	let authInfo = null
	try {
		authInfo = await getFreshGoogleToken(token)
	} catch (err) {
		const error = new Error(`Failed to refresh Google access token: ${err.message}`)
		error.status = 401
		throw error
	}
	const googleToken = authInfo?.token || null
	if (!googleToken) {
		const appUrl = process.env.APP_URL || 'http://localhost:8080'
		const err = new Error(`Authentication required: ${appUrl.replace(/\/$/, '')}/oauth/authorize`)
		err.status = 401
		throw err
	}
	const normalizedMethod = (method || 'GET').toUpperCase()
	const session = authInfo.session
	if (session?.policy) {
		const check = evaluatePolicy(session.policy, {
			url,
			method: normalizedMethod
		})
		if (!check.allowed) {
			const err = new Error(`Policy violation: ${check.reason || 'Operation not permitted by session policy'}`)
			err.status = 403
			throw err
		}
	}
	return proxyGoogleApi({
		token: googleToken,
		url,
		method: normalizedMethod,
		body,
		headers
	})
}
