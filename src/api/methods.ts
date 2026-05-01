import type { RpcClient } from './client'
import type { DynamicSummary, StaticData } from '../types'

export interface TaskQueryResult {
  task_id: number
  uuid: string
  timestamp: number
  success: boolean
  error_message: string | null
  task_event_result: Record<string, unknown> | null
  cron_source?: string | null
}

export const listAgentUuids = (c: RpcClient) =>
  c.call<{ uuids?: string[] }>('nodeget-server_list_all_agent_uuid', {}).then(r => r?.uuids || [])

export const staticDataMulti = (c: RpcClient, uuids: string[], fields: string[]) =>
  c.call<StaticData[]>('agent_static_data_multi_last_query', { uuids, fields })

export const dynamicSummaryMulti = (c: RpcClient, uuids: string[], fields: string[]) =>
  c.call<DynamicSummary[]>('agent_dynamic_summary_multi_last_query', { uuids, fields })

export const kvGetMulti = (
  c: RpcClient,
  items: { namespace: string; key: string }[],
) => c.call<{ namespace: string; key: string; value: unknown }[]>('kv_get_multi_value', { namespace_key: items })

export const taskQuery = (
  c: RpcClient,
  condition: Array<Record<string, unknown>>,
) => c.call<TaskQueryResult[]>('task_query', { task_data_query: { condition } })
