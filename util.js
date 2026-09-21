export { getBody }

function getBody (req, maxBytes = 1024 * 1024) {
	return new Promise((resolve, reject) => {
		let size = 0
		const buffers = []
		req.on('data', chunk => {
			size += chunk.length
			if (size > maxBytes) {
				const err = new Error('Payload Too Large')
				err.code = 413
				req.destroy(err)
				reject(err)
				return
			}
			buffers.push(chunk)
		})
		req.on('error', reject)
		req.on('end', () => {
			resolve(Buffer.concat(buffers).toString('utf8'))
		})
	})
}
