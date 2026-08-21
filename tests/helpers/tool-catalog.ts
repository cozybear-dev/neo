import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTools as scopeTools } from '../../plugins/neo-tools-scope/src/tools.ts'
import { createTools as memoryTools } from '../../plugins/neo-tools-memory/src/tools.ts'
import { createTools as issueTools } from '../../plugins/neo-tools-issues/src/tools.ts'
import { createTools as oastTools } from '../../plugins/neo-tools-oast/src/tools.ts'
import { createTools as sandboxTools } from '../../plugins/neo-sandbox-docker/src/tools.ts'
import { createTools as browserTools } from '../../plugins/neo-tools-browser/src/tools.ts'
import { createTools as trafficTools } from '../../plugins/neo-tools-traffic/src/tools.ts'
import { createTools as deployTools } from '../../plugins/neo-tools-deploy/src/tools.ts'
import { createTools as orchTools } from '../../plugins/neo-orchestrator/src/tools.ts'

export const NEO_TOOL_NAMES = [
  'scope_check', 'memory_get', 'memory_update', 'task_update',
  'issue_create', 'issue_query', 'issue_update',
  'oast_register', 'oast_poll',
  'sandbox_exec',
  'browser_navigate', 'browser_act', 'browser_eval', 'browser_screenshot', 'browser_network',
  'traffic_search', 'traffic_replay',
  'deploy_up', 'deploy_down',
  'delegate',
] as const

export const DSH_BUILTIN_TOOLS = [
  'bash', 'read', 'write', 'glob', 'grep', 'skill', 'web_search',
] as const

export { DSH_AGENT_PLANE_TOOLS } from '../../plugins/neo-orchestrator/src/delegate.ts'

export function allNeoToolDefs() {
  return [
    ...scopeTools(),
    ...memoryTools(),
    ...issueTools(),
    ...oastTools(),
    ...sandboxTools(),
    ...browserTools(),
    ...trafficTools(),
    ...deployTools(),
    ...orchTools({ presets: undefined, workspaceDir: mkdtempSync(join(tmpdir(), 'neo-contract-')) }),
  ]
}
