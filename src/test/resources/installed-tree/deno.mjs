const raw = (repository, commit, path) =>
  `https://raw.githubusercontent.com/${repository}/${commit}/${path}`

export const fixtures = [
  {
    id: 'deno-v4-deno-chmod',
    family: 'deno',
    format: 'deno-v4',
    treeSurface: 'none',
    lockfile: 'deno.lock',
    repository: 'ayakovlenko/deno-chmod',
    commit: 'ced17bb0f0f2b4a4cc1c27b9b405acb00c426e0b',
    repositoryPath: 'deno.lock',
    files: [
      { path: 'deno.json', sha256: 'f0a995ac1b0f1d9fc6270e00a07af5fca84b142a9261258bf677372ace722e31' },
      { path: 'deno.lock', sha256: 'e80b2f39cd1f581fdffbc6b6e938581f01e48d30fa9200801e3cdf7e4dc6fe23' },
    ],
    tool: {
      alias: 'deno-2.2.8',
      version: '2.2.8',
      runtime: 'native',
      path: 'tmp/deno-oracle/2.2.8/deno',
    },
    commands: {
      online: ['install', '--frozen'],
      offline: ['install', '--frozen', '--cached-only'],
    },
    allowedOrigins: [
      'https://raw.githubusercontent.com',
      'https://jsr.io',
      'https://registry.npmjs.org',
    ],
  },
  {
    id: 'deno-v5-simple-xls-toolbox',
    family: 'deno',
    format: 'deno-v5',
    treeSurface: 'none',
    lockfile: 'deno.lock',
    repository: 'simonneutert/simple-xls-toolbox',
    commit: '9931365f98b76df9f6fc8e6f6a6d948877852e87',
    repositoryPath: 'deno.lock',
    files: [
      { path: 'deno.json', sha256: 'e2ce7720188f34527117d47ae3342a66650a249dbb77c17519ba83b54aef3c63' },
      { path: 'deno.lock', sha256: '297bc2988d08b7c319af4e6e774bea7d92823894e56738d71fc4a562091a07ee' },
    ],
    tool: {
      alias: 'deno-2.9.6',
      version: '2.9.6',
      runtime: 'native',
      path: 'tmp/deno-oracle/2.9.6/deno',
    },
    commands: {
      online: ['install', '--frozen', '--allow-import'],
      offline: ['install', '--frozen', '--cached-only', '--allow-import'],
    },
    allowedOrigins: [
      'https://raw.githubusercontent.com',
      'https://jsr.io',
      'https://registry.npmjs.org',
      'https://cdn.sheetjs.com',
    ],
  },
]

for (const fixture of fixtures) {
  for (const file of fixture.files) file.url = raw(fixture.repository, fixture.commit, file.path)
}
