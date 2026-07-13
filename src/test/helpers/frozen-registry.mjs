import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'

const tarball = readFileSync(process.argv[2])
const sha1 = createHash('sha1').update(tarball).digest('hex')
const integrity = `sha512-${createHash('sha512').update(tarball).digest('base64')}`

const server = createServer((request, response) => {
  const base = `http://127.0.0.1:${server.address().port}`
  const path = new URL(request.url, base).pathname
  if (path === '/ms') {
    const body = Buffer.from(JSON.stringify({
      name: 'ms',
      'dist-tags': { latest: '2.1.3' },
      versions: {
        '2.1.3': {
          name: 'ms',
          version: '2.1.3',
          dist: {
            tarball: `${base}/ms/-/ms-2.1.3.tgz`,
            shasum: sha1,
            integrity,
          },
        },
      },
    }))
    response.writeHead(200, {
      'content-type': 'application/json',
      'content-length': String(body.length),
    })
    if (request.method !== 'HEAD') response.end(body)
    else response.end()
    return
  }
  if (path === '/ms/-/ms-2.1.3.tgz') {
    response.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': String(tarball.length),
    })
    if (request.method !== 'HEAD') response.end(tarball)
    else response.end()
    return
  }
  response.writeHead(404, { 'content-type': 'application/json' })
  response.end(JSON.stringify({ error: 'not found' }))
})

server.listen(0, '127.0.0.1', () => {
  process.stdout.write(`${server.address().port}\n`)
})

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => server.close(() => process.exit(0)))
}
