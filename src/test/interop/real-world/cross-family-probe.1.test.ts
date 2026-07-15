// Shard 1/2 of the cross-family probe matrix — see defineProbeShard in _probe.ts.
// Sharded across sibling files so vitest runs the ~600-case CPU matrix on
// multiple cores instead of one. Fixtures are partitioned by index; the two
// shards together cover the whole corpus exactly once.
import { defineProbeShard } from './_probe.ts'

defineProbeShard(0)
