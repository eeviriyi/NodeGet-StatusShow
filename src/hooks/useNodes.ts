import { useEffect, useMemo, useState } from 'react'
import { BackendPool } from '../api/pool'
import {
  dynamicSummaryMulti,
  kvGetMulti,
  listAgentUuids,
  staticDataMulti,
  taskQuery,
  type TaskQueryResult,
} from '../api/methods'
import { isOnline } from '../utils/status'
import type { DynamicSummary, HistorySample, LatencyStats, Node, NodeMeta, SiteConfig } from '../types'

type Agent = Pick<Node, 'uuid' | 'source' | 'meta' | 'static'>

interface BackendError {
  source: string
  error: unknown
}

const STATIC_FIELDS = ['cpu', 'system']
const DYNAMIC_FIELDS = [
  'cpu_usage',
  'used_memory',
  'total_memory',
  'available_memory',
  'used_swap',
  'total_swap',
  'total_space',
  'available_space',
  'read_speed',
  'write_speed',
  'receive_speed',
  'transmit_speed',
  'total_received',
  'total_transmitted',
  'load_one',
  'load_five',
  'load_fifteen',
  'uptime',
  'boot_time',
  'process_count',
  'tcp_connections',
  'udp_connections',
]
const META_KEYS = [
  'metadata_name',
  'metadata_region',
  'metadata_tags',
  'metadata_hidden',
  'metadata_virtualization',
  'metadata_latitude',
  'metadata_longitude',
  'metadata_order',
]
const DYN_INTERVAL_MS = 2000
const HISTORY_LIMIT = 60
const DEFAULT_LATENCY_WINDOW_MINUTES = 24 * 60
const DEFAULT_LATENCY_REFRESH_MS = 30_000
const LATENCY_LIMIT = 2_000

function emptyMeta(): NodeMeta {
  return { name: '', region: '', tags: [], hidden: false, virtualization: '', lat: null, lng: null, order: 0 }
}

function blankAgent(uuid: string, source: string): Agent {
  return { uuid, source, meta: emptyMeta(), static: {} }
}

function parseMeta(raw: Record<string, unknown>): NodeMeta {
  const lat = Number(raw.metadata_latitude)
  const lng = Number(raw.metadata_longitude)
  const order = Number(raw.metadata_order)
  return {
    name: raw.metadata_name ? String(raw.metadata_name) : '',
    region: raw.metadata_region ? String(raw.metadata_region) : '',
    tags: Array.isArray(raw.metadata_tags) ? raw.metadata_tags.filter(Boolean) : [],
    hidden: Boolean(raw.metadata_hidden),
    virtualization: raw.metadata_virtualization ? String(raw.metadata_virtualization) : '',
    lat: Number.isFinite(lat) ? lat : null,
    lng: Number.isFinite(lng) ? lng : null,
    order: Number.isFinite(order) ? order : 0,
  }
}

function sampleFrom(row: DynamicSummary): HistorySample {
  const memTotal = row.total_memory || 0
  const diskTotal = row.total_space || 0
  return {
    t: row.timestamp,
    cpu: row.cpu_usage ?? null,
    mem: memTotal && row.used_memory != null ? (row.used_memory / memTotal) * 100 : null,
    disk:
      diskTotal && row.available_space != null
        ? ((diskTotal - row.available_space) / diskTotal) * 100
        : null,
    netIn: row.receive_speed ?? 0,
    netOut: row.transmit_speed ?? 0,
  }
}

function latencyType(config: SiteConfig): 'ping' | 'tcp_ping' {
  return config.latency?.type === 'ping' ? 'ping' : 'tcp_ping'
}

function latencyTypes(config: SiteConfig): Array<'ping' | 'tcp_ping'> {
  if (config.latency?.type === 'ping') return ['ping']
  if (config.latency?.type === 'tcp_ping') return ['tcp_ping']
  return ['tcp_ping', 'ping']
}

function latencyWindowMs(config: SiteConfig): number {
  const minutes = config.latency?.window_minutes
  return (Number.isFinite(minutes) && minutes && minutes > 0
    ? minutes
    : DEFAULT_LATENCY_WINDOW_MINUTES) * 60 * 1000
}

function latencyRefreshMs(config: SiteConfig): number {
  const interval = config.latency?.refresh_interval_ms
  return Number.isFinite(interval) && interval && interval >= 10_000
    ? interval
    : DEFAULT_LATENCY_REFRESH_MS
}

function computeLatency(rows: TaskQueryResult[], type: 'ping' | 'tcp_ping'): LatencyStats {
  const sorted = rows.slice().sort((a, b) => a.timestamp - b.timestamp)
  const samples = sorted
    .filter(row => row.success && typeof row.task_event_result?.[type] === 'number')
    .map(row => ({
      t: row.timestamp,
      latency: row.task_event_result?.[type] as number,
    }))
  const values = samples.map(row => row.latency)
  const latest = values.length ? values[values.length - 1] : null
  const avg = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null
  const jitter =
    values.length >= 2
      ? values
          .slice(1)
          .reduce((sum, value, index) => sum + Math.abs(value - values[index]!), 0) /
        (values.length - 1)
      : null

  return {
    type,
    latest,
    avg,
    jitter,
    lossRate: sorted.length ? ((sorted.length - values.length) / sorted.length) * 100 : 0,
    samples: values.length,
    total: sorted.length,
    updatedAt: sorted.length ? sorted[sorted.length - 1]!.timestamp : null,
    history: samples.slice(-LATENCY_LIMIT),
  }
}

function chooseLatencyStats(
  stats: LatencyStats[],
  fallbackType: 'ping' | 'tcp_ping',
): LatencyStats {
  const withSamples = stats.filter(stat => stat.total > 0)
  const withValues = withSamples.find(stat => stat.latest != null)
  return withValues ?? withSamples[0] ?? computeLatency([], fallbackType)
}

async function queryLatencyStats(
  client: Parameters<typeof taskQuery>[0],
  uuid: string,
  type: 'ping' | 'tcp_ping',
  from: number,
  now: number,
) {
  const rows = await taskQuery(client, [
    { uuid },
    { timestamp_from_to: [from, now] },
    { type },
    { limit: LATENCY_LIMIT },
  ])
  if (rows?.length) return computeLatency(rows, type)

  const latestRows = await taskQuery(client, [{ uuid }, { type }, { limit: LATENCY_LIMIT }])
  return computeLatency(latestRows || [], type)
}

export function useNodes(config: SiteConfig | null) {
  const [agents, setAgents] = useState<Map<string, Agent>>(new Map())
  const [live, setLive] = useState<Map<string, DynamicSummary>>(new Map())
  const [history, setHistory] = useState<Map<string, HistorySample[]>>(new Map())
  const [latency, setLatency] = useState<Map<string, LatencyStats>>(new Map())
  const [errors, setErrors] = useState<BackendError[]>([])
  const [loading, setLoading] = useState(true)
  const [tick, setTick] = useState(0)
  const [pool, setPool] = useState<BackendPool | null>(null)

  useEffect(() => {
    if (!config?.site_tokens?.length) {
      setLoading(false)
      return
    }
    const pool = new BackendPool(config.site_tokens)
    setPool(pool)
    const sourceUuids = new Map<string, string[]>()

    const bootstrap = async () => {
      const agentsRes = await pool.fanout(listAgentUuids)
      setErrors(prev => [...prev, ...agentsRes.errors])

      const seed = new Map<string, Agent>()
      for (const { source, rows } of agentsRes.ok) {
        const uuids = rows ?? []
        sourceUuids.set(source, uuids)
        for (const uuid of uuids) seed.set(uuid, blankAgent(uuid, source))
      }
      setAgents(seed)

      await Promise.all(
        pool.entries.map(async entry => {
          const uuids = sourceUuids.get(entry.name) || []
          if (!uuids.length) return

          const kvItems = uuids.flatMap(u => META_KEYS.map(k => ({ namespace: u, key: k })))
          const [meta, stat] = await Promise.allSettled([
            kvGetMulti(entry.client, kvItems),
            staticDataMulti(entry.client, uuids, STATIC_FIELDS),
          ])

          setAgents(prev => {
            const next = new Map(prev)

            if (meta.status === 'fulfilled' && meta.value) {
              const grouped = new Map<string, Record<string, unknown>>()
              for (const row of meta.value) {
                if (!row || row.value == null) continue
                let bucket = grouped.get(row.namespace)
                if (!bucket) grouped.set(row.namespace, (bucket = {}))
                bucket[row.key] = row.value
              }
              for (const uuid of uuids) {
                const cur = next.get(uuid) ?? blankAgent(uuid, entry.name)
                next.set(uuid, { ...cur, meta: parseMeta(grouped.get(uuid) ?? {}) })
              }
            }

            if (stat.status === 'fulfilled' && stat.value) {
              for (const row of stat.value) {
                if (!row.uuid) continue
                const cur = next.get(row.uuid) ?? blankAgent(row.uuid, entry.name)
                next.set(row.uuid, { ...cur, static: row })
              }
            }
            return next
          })
        }),
      )

      await tickDynamic()
      await tickLatency()
      setLoading(false)
    }

    const tickDynamic = async () => {
      const updates: DynamicSummary[] = []
      await Promise.allSettled(
        pool.entries.map(async entry => {
          const uuids = sourceUuids.get(entry.name) || []
          if (!uuids.length) return
          try {
            const rows = await dynamicSummaryMulti(entry.client, uuids, DYNAMIC_FIELDS)
            for (const row of rows || []) updates.push(row)
          } catch {}
        }),
      )
      if (!updates.length) return

      setLive(prev => {
        const next = new Map(prev)
        for (const row of updates) next.set(row.uuid, row)
        return next
      })
      setHistory(prev => {
        const next = new Map(prev)
        for (const row of updates) {
          const arr = next.get(row.uuid) || []
          const sample = sampleFrom(row)
          const dedup = arr.length && arr[arr.length - 1].t === sample.t ? arr : arr.concat(sample)
          next.set(row.uuid, dedup.slice(-HISTORY_LIMIT))
        }
        return next
      })
    }

    const tickLatency = async () => {
      if (config.latency?.enabled === false) {
        setLatency(new Map())
        return
      }

      const types = latencyTypes(config)
      const now = Date.now()
      const from = now - latencyWindowMs(config)
      const updates = new Map<string, LatencyStats>()

      await Promise.allSettled(
        pool.entries.map(async entry => {
          const uuids = sourceUuids.get(entry.name) || []
          if (!uuids.length) return

          await Promise.allSettled(
            uuids.map(async uuid => {
              const settled = await Promise.allSettled(
                types.map(type => queryLatencyStats(entry.client, uuid, type, from, now)),
              )
              const stats = settled
                .filter((item): item is PromiseFulfilledResult<LatencyStats> => item.status === 'fulfilled')
                .map(item => item.value)
              if (stats.length) updates.set(uuid, chooseLatencyStats(stats, latencyType(config)))
            }),
          )
        }),
      )

      setLatency(prev => {
        const next = new Map(prev)
        for (const [uuid, stat] of updates) next.set(uuid, stat)
        return next
      })
    }

    bootstrap().catch((e: unknown) => {
      setErrors(prev => [...prev, { source: '*', error: e }])
      setLoading(false)
    })

    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        tickDynamic()
        tickLatency()
      }
    }
    document.addEventListener('visibilitychange', onVisible)

    const dynTimer = setInterval(tickDynamic, DYN_INTERVAL_MS)
    const latencyTimer = setInterval(tickLatency, latencyRefreshMs(config))
    const clockTimer = setInterval(() => setTick(t => t + 1), 5000)

    return () => {
      clearInterval(dynTimer)
      clearInterval(latencyTimer)
      clearInterval(clockTimer)
      document.removeEventListener('visibilitychange', onVisible)
      setPool(null)
      pool.close()
    }
  }, [config])

  const nodes = useMemo(() => {
    const now = Date.now()
    const out = new Map<string, Node>()
    for (const [uuid, a] of agents) {
      const dyn = live.get(uuid) || null
      out.set(uuid, {
        ...a,
        dynamic: dyn,
        history: history.get(uuid) || [],
        latency: latency.get(uuid) || null,
        online: isOnline(dyn?.timestamp, now),
      })
    }
    return out
  }, [agents, live, history, latency, tick])

  return { nodes, errors, loading, pool }
}
