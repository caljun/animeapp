import { createCleanupHandler } from '../server/cleanup.mjs'

export default { fetch: createCleanupHandler() }
