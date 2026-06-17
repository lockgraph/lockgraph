# `cloud-registries` — AWS CodeArtifact · Google Artifact Registry · Azure Artifacts

> Status: draft (vendor-doc-derived; auth-gated, not probe-able; GCP addressing /
> auth now sourced to the GAR npm tooling).
> Updated: 2026-06-16
> Provenance: **Official** (vendor docs).
> Family: **npm-shape** — the cloud-gated subset.

The three hyperscaler npm registries share one profile: **mandatory auth**
(short-lived tokens, IAM / PAT), **own auth-gated tarballs**, an **optional npmjs
upstream** (so they *can* proxy public npm, unlike [`github-packages`](./github-packages.md)),
and **no npm-audit API**. The real divergence is **addressing + token acquisition**,
captured per vendor below. `dist.integrity` is preserved (enrich works);
`dist.signatures` are not re-emitted.

## AWS CodeArtifact

- **Addressing:** `https://<domain>-<acct>.d.codeartifact.<region>.amazonaws.com/npm/<repo>/`.
- **Auth:** mandatory Bearer from `aws codeartifact get-authorization-token`
  (**~12 h** default TTL), IAM-gated; `//…/:_authToken=`, `always-auth=true` for
  npm 6 compat.
- **Tarball:** `own`, auth-gated. **Upstream:** repos can attach an npmjs upstream
  (proxy / cache).
- **Advisories / keys:** absent → route advisories elsewhere.
- **Quirk:** npm 8+ can hang on the S3 tarball redirect (`progress=false` mitigates);
  the token must be refreshed (~12 h).
- **Source:** [CodeArtifact npm auth](https://docs.aws.amazon.com/codeartifact/latest/ug/npm-auth.html) (2026-06-08).

## Google Artifact Registry

- **Addressing:** `https://<region>-npm.pkg.dev/<project>/<repo>/`.
- **Auth:** mandatory; short-lived access token (`gcloud auth … print-access-token`,
  ~1 h) or the `google-artifactregistry-auth` helper, or a base64 service-account
  key (Basic `:_password`); IAM-gated. **Standard** (hosted) + **virtual** (proxy)
  repo types.
- **Tarball:** `own`, auth-gated. **Upstream:** virtual repos proxy npmjs.
- **Advisories / keys:** absent → route advisories elsewhere.
- **Auth helper:** `google-artifactregistry-auth` writes a transient `:_authToken`
  (refreshed each run) into `.npmrc` for the `https://<region>-npm.pkg.dev/<project>/<repo>/`
  registry; `gcloud artifacts print-settings npm` emits the same `.npmrc` block. Source:
  [artifact-registry-npm-tools](https://github.com/GoogleCloudPlatform/artifact-registry-npm-tools)
  + [Artifact Registry docs](https://cloud.google.com/artifact-registry/docs) (2026-06-09).

## Azure Artifacts

- **Addressing:** `https://pkgs.dev.azure.com/<org>/<project>/_packaging/<feed>/npm/registry/`
  (the org-scoped variant drops `<project>`).
- **Auth:** mandatory; PAT (Packaging scope) base64 via Basic `:_password` (any
  username) or `:_authToken`; `vsts-npm-auth` helper on Windows. PAT TTL up to 1 y.
  `always-auth=true` required (Azure gates tarball GETs).
- **Tarball:** `own`, auth-gated. **Upstream:** feeds attach npmjs upstream sources.
- **Advisories / keys:** absent → route advisories elsewhere.
- **Source:** [Azure Artifacts npm](https://learn.microsoft.com/azure/devops/artifacts/get-started-npm),
  [npmrc](https://learn.microsoft.com/azure/devops/artifacts/npm/npmrc),
  [upstreams](https://learn.microsoft.com/azure/devops/artifacts/npm/upstream-sources) (2026-06-08).

## Shared profile (all three)

- **Mandatory auth**, short-lived tokens (CodeArtifact ~12 h, GAR ~1 h, Azure PAT up
  to 1 y); anonymous → 401.
- **Own auth-gated tarballs**; `dist.tarball` on the vendor host.
- **Optional npmjs upstream** — can proxy / cache public npm.
- **No npm-audit API** (`/-/npm/v1/security/*`, `/keys` absent) → route advisories to
  GHSA / public npm ([§8.3](./_common.md#83-the-no-advisories-class)).
- **No re-signing** — `dist.signatures` absent; install falls back to `integrity`.
- **Corgi:** undocumented per vendor (Open).
- **Adapter:** `headers()` = the vendor token; tarball remap `own` + auth; degraded
  facts = signatures / advisories / keys.

## Others

**Cloudsmith** (managed SaaS) and **Gitea / Forgejo** (self-hosted) also expose
npm-shape registries with the same auth-gated, own-tarball, no-audit profile and an
optional npmjs upstream. Stubs — auth specifics per vendor docs (Cloudsmith API
tokens; Gitea / Forgejo basic / token).

## Open questions

> **Open:** corgi `Accept` support per vendor.
> **Open:** confirm GAR addressing / auth against a live instance (doc fetch was
> redirect-blocked).
> **Open:** do any of the three preserve upstream `dist.signatures` on proxied
> (upstream) entries (like verdaccio passthrough), or strip them?

## Sources

- AWS — https://docs.aws.amazon.com/codeartifact/latest/ug/npm-auth.html
- GCP — https://cloud.google.com/artifact-registry/docs (partial)
- Azure — https://learn.microsoft.com/azure/devops/artifacts/get-started-npm ,
  /npm/npmrc , /npm/upstream-sources
- (all 2026-06-08)
