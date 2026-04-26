
export type TDependencies = Record<string, string>

export type TDependenciesMeta = Record<string, { optional: boolean }>

export interface THashes {
    sha512?: string
    sha256?: string
    sha1?: string
    checksum?: string
    md5?: string
}

export type TSourceType = 'npm' | 'github' | 'file' | 'workspace' | 'semver' | 'patch'

export interface TSource {
    type: TSourceType
    id: string
    registry?: string
    name?: string
    hash?: string
    alias?: string
}

export interface TResolution extends TSource {
    name?: string
    hash?: string
}

export interface TEntry {
    name: string
    version: string
    ranges: string[]
    hashes: THashes
    source: TSource

    manifest?: TManifest
    conditions?: string
    dependencies?: TDependencies
    dependenciesMeta?: TDependenciesMeta
    devDependencies?: TDependencies
    optionalDependencies?: TDependencies
    peerDependencies?: TDependencies
    peerDependenciesMeta?: TDependenciesMeta
    bin?: Record<string, string>
    engines?: Record<string, string>
    funding?: Record<string, string>
    license?: string
    patch?: {
        resolution: string,
        refs: string[]
        checksum: string
    }
}

export interface TManifest {
    name: string
    dependencies?: TDependencies
    devDependencies?: TDependencies
    optionalDependencies?: TDependencies
    peerDependencies?: TDependencies
    [key: string]: any
}

export type TSnapshot = Record<string, TEntry>

export interface TSnapshotIndex {
    snapshot: TSnapshot
    entries: TEntry[]
    roots: TEntry[]
    edges: [string, string][]
    tree: Record<string, {
        name: string
        version: string
        id: string
        key: string
        chunks: string[]
        parents: TEntry[]
        entry: TEntry
        depth: number
    }>
    prod: Set<TEntry>
    bound(from: TEntry, to: TEntry): void
    getEntryId ({name, version}: TEntry): string
    getEntry (name: string, version?: string): TEntry | undefined,
    getEntryByRange (name: string, range: string): TEntry | undefined
    getEntryDeps(entry: TEntry): TEntry[]
}

export type IParse = (lockfile: string, ...pkgJsons: string[]) => TSnapshot

export type IFormatOpts = {
    meta?: Record<string, Partial<TEntry>>
    [index: string]: any
}

export type IFormat = (snapshot: TSnapshot, opts?: IFormatOpts) => string

export type IFormatReference = (value: string, opts: any) => string | number

export type IPreformat<T> = (idx: TSnapshotIndex, opts?: IFormatOpts) => T

export type ICheck = (input: string) => boolean

export type IParseResolution = (input: string) => TResolution

export type IFormatResolution = (resolution: TResolution) => string
