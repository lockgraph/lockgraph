import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'

const defaultTarball = readFileSync(process.argv[2])
const fseventsTarball = process.argv[3] === undefined
  ? defaultTarball
  : readFileSync(process.argv[3])
const fsevents232Tarball = process.argv[4] === undefined
  ? fseventsTarball
  : readFileSync(process.argv[4])
const resolveTarball = process.argv[5] === undefined
  ? defaultTarball
  : readFileSync(process.argv[5])
const typescriptTarball = process.argv[6] === undefined
  ? defaultTarball
  : readFileSync(process.argv[6])
const fixtures = {
  ms: {
    latest: '2.1.3',
    versions: {
      '2.1.3': { extra: {}, tarball: defaultTarball },
    },
  },
  fsevents: {
    latest: '2.3.3',
    versions: {
      '2.3.2': {
        extra: {
          os: ['darwin'],
          scripts: { build: 'node-gyp rebuild' },
        },
        tarball: fsevents232Tarball,
      },
      '2.3.3': {
        extra: {
          os: ['darwin'],
          scripts: { build: 'node-gyp rebuild' },
        },
        tarball: fseventsTarball,
      },
    },
  },
  'node-gyp': {
    latest: '11.5.0',
    versions: {
      '11.5.0': { extra: {}, tarball: defaultTarball },
    },
  },
  resolve: {
    latest: '1.22.8',
    versions: {
      '1.22.8': {
        extra: {
          dependencies: {
            'is-core-module': '^2.13.0',
            'path-parse': '^1.0.7',
            'supports-preserve-symlinks-flag': '^1.0.0',
          },
          bin: { resolve: 'bin/resolve' },
        },
        tarball: resolveTarball,
      },
    },
  },
  'is-core-module': {
    latest: '2.13.1',
    versions: {
      '2.13.1': { extra: {}, tarball: defaultTarball },
    },
  },
  'path-parse': {
    latest: '1.0.7',
    versions: {
      '1.0.7': { extra: {}, tarball: defaultTarball },
    },
  },
  'supports-preserve-symlinks-flag': {
    latest: '1.0.0',
    versions: {
      '1.0.0': { extra: {}, tarball: defaultTarball },
    },
  },
  typescript: {
    latest: '5.6.2',
    versions: {
      '5.6.2': {
        extra: {
          bin: {
            tsc: 'bin/tsc',
            tsserver: 'bin/tsserver',
          },
        },
        tarball: typescriptTarball,
      },
    },
  },
}

const server = createServer((request, response) => {
  const base = `http://127.0.0.1:${server.address().port}`
  const requestedPath = new URL(request.url, base).pathname
  // source-override oracle: the target prefix serves the exact same
  // package bytes as the registry root so frozen PMs validate rewritten locks.
  const path = requestedPath.startsWith('/mirror/')
    ? requestedPath.slice('/mirror'.length)
    : requestedPath
  const packageName = path.slice(1)
  const fixture = fixtures[packageName]
  if (fixture !== undefined) {
    const versions = Object.fromEntries(Object.entries(fixture.versions).map(
      ([version, versionFixture]) => {
        const sha1 = createHash('sha1').update(versionFixture.tarball).digest('hex')
        const integrity =
          `sha512-${createHash('sha512').update(versionFixture.tarball).digest('base64')}`
        return [version, {
          name: packageName,
          version,
          ...versionFixture.extra,
          dist: {
            tarball: `${base}/${packageName}/-/${packageName}-${version}.tgz`,
            shasum: sha1,
            integrity,
          },
        }]
      },
    ))
    const body = Buffer.from(JSON.stringify({
      name: packageName,
      'dist-tags': { latest: fixture.latest },
      versions,
    }))
    response.writeHead(200, {
      'content-type': 'application/json',
      'content-length': String(body.length),
    })
    if (request.method !== 'HEAD') response.end(body)
    else response.end()
    return
  }
  const tarballMatch =
    /^\/(ms|fsevents|node-gyp|resolve|typescript|is-core-module|path-parse|supports-preserve-symlinks-flag)\/-\/[^/]+-(\d+\.\d+\.\d+)\.tgz$/.exec(path)
  if (tarballMatch !== null) {
    const versionFixture = fixtures[tarballMatch[1]].versions[tarballMatch[2]]
    if (versionFixture === undefined) {
      response.writeHead(404, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: 'not found' }))
      return
    }
    const body = versionFixture.tarball
    response.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': String(body.length),
    })
    if (request.method !== 'HEAD') response.end(body)
    else response.end()
    return
  }
  response.writeHead(404, { 'content-type': 'application/json' })
  response.end(JSON.stringify({ error: 'not found' }))
})

server.once('error', error => {
  process.stdout.write(`${JSON.stringify({
    status: 'unavailable',
    code: typeof error?.code === 'string' ? error.code : 'UNKNOWN',
    message: error instanceof Error ? error.message : 'local frozen registry failed',
  })}\n`)
})

server.listen(0, '127.0.0.1', () => {
  process.stdout.write(`${JSON.stringify({
    status: 'ready',
    port: server.address().port,
  })}\n`)
})

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => server.close(() => process.exit(0)))
}
