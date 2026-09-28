const raw = (repository, commit, path) =>
  `https://raw.githubusercontent.com/${repository}/${commit}/${path}`

export const fixtures = [
  {
    id: 'npm-v2-ungap-custom-elements',
    family: 'npm',
    format: 'npm-2',
    lockfile: 'package-lock.json',
    repository: 'ungap/custom-elements',
    commit: 'f9010ee553923eafbe7eb36b6113c7007ff5244c',
    files: [
      {
        path: 'package.json',
        sha256: 'e1dba65fa2442508f7f8f2bc5f6f77557f4d156d581aed8e39b5dea587322619',
      },
      {
        path: 'package-lock.json',
        sha256: '0dcc1be72d3a3f253c26eae35364d3ac38893955da2041b2cc218243678eed44',
      },
    ],
    tool: {
      alias: 'pm-npm-8',
      version: '8.19.4',
      runtime: 'node18',
      bin: 'bin/npm-cli.js',
    },
    commands: {
      online: ['ci', '--ignore-scripts', '--no-audit', '--no-fund'],
      offline: ['ci', '--offline', '--ignore-scripts', '--no-audit', '--no-fund'],
    },
    allowedOrigins: ['https://raw.githubusercontent.com', 'https://registry.npmjs.org'],
  },
  {
    id: 'npm-v3-jeresig-romaji-name',
    family: 'npm',
    format: 'npm-3',
    lockfile: 'package-lock.json',
    repository: 'jeresig/node-romaji-name',
    commit: '94383717e2581e87e5d673893dc57804b2e089bf',
    files: [
      {
        path: 'package.json',
        sha256: 'bb43ad107692e2e196184a411f1850a410a72b771849d8d85a52256d64c99522',
      },
      {
        path: 'package-lock.json',
        sha256: '05eeef2fcc2d95003f9fb1bce4d90eec9abad204a6a32e02cca7c8b2659cebc6',
      },
    ],
    tool: {
      alias: 'pm-npm-11',
      version: '11.20.0',
      runtime: 'node22',
      bin: 'bin/npm-cli.js',
    },
    commands: {
      online: ['ci', '--ignore-scripts', '--no-audit', '--no-fund'],
      offline: ['ci', '--offline', '--ignore-scripts', '--no-audit', '--no-fund'],
    },
    allowedOrigins: ['https://raw.githubusercontent.com', 'https://registry.npmjs.org'],
  },
]

for (const fixture of fixtures) {
  for (const file of fixture.files) {
    file.url = raw(fixture.repository, fixture.commit, file.path)
  }
}
