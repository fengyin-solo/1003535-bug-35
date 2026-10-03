import { SEED_ROWS } from './seed'
import {
  STATIONHOUSE_DOMAIN_KEY,
  STATIONHOUSE_KEY,
  type StationhouseDomain,
  type StationhouseEntry,
} from './stationhouse-types'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'hydrology-monitor-station:entries'

// stationhouseDomain 是业务域对象而非记录集合，单独存在另一个键里，不能混进通用列表。
const DOMAIN_SEED_KEYS = new Set(['stationhouseDomain'])

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function entrySeed(): Record<string, EntryRow[]> {
  const result: Record<string, EntryRow[]> = {}
  for (const [key, value] of Object.entries(SEED_ROWS)) {
    if (!DOMAIN_SEED_KEYS.has(key)) {
      result[key] = clone(value as EntryRow[])
    }
  }
  return result
}

function writeEntries(next: Record<string, EntryRow[]>): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
}

function readEntriesStorage(): Record<string, EntryRow[]> {
  const fallback = entrySeed()
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    writeEntries(fallback)
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    for (const domainKey of DOMAIN_SEED_KEYS) {
      delete parsed[domainKey]
    }
    return { ...fallback, ...parsed }
  } catch {
    writeEntries(fallback)
    return fallback
  }
}

let cache: Record<string, EntryRow[]> | null = null

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readEntriesStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  const next = { ...allRows(), [key]: rows }
  cache = next
  writeEntries(next)
}

export function resetRows(key: string): EntryRow[] {
  if (key === STATIONHOUSE_KEY) {
    return resetStationhouse().entries as EntryRow[]
  }
  const rows = clone((SEED_ROWS[key] as EntryRow[]) ?? [])
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}

function defaultDomain(): StationhouseDomain {
  return clone((SEED_ROWS.stationhouseDomain as StationhouseDomain) ?? emptyDomain())
}

function emptyDomain(): StationhouseDomain {
  return {
    maintenanceBatches: [],
    acceptanceBatches: [],
    fees: [],
    requests: [],
    notices: [],
    feeSeq: 0,
  }
}

function readDomain(): StationhouseDomain {
  const fallback = defaultDomain()
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STATIONHOUSE_DOMAIN_KEY)
  if (!raw) {
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as Partial<StationhouseDomain>
    return { ...fallback, ...parsed }
  } catch {
    return fallback
  }
}

let domainCache: StationhouseDomain | null = null

export function stationhouseDomain(): StationhouseDomain {
  if (domainCache === null) {
    domainCache = readDomain()
  }
  return domainCache
}

/**
 * 站房维护链路的事务边界：维护列表（记录）与费用台账/批次域必须一起改。
 *
 * - 校验与变更先在内存草稿上做完，任一条费用不合格直接抛错，缓存和 localStorage 都不动；
 * - 落库阶段任何一步失败，都把记录集合和业务域恢复成提交前的快照，列表、汇总、待办一起回退；
 * - 两步持久化都成功才算一次提交完成。
 */
export function commitStationhouse<T>(
  mutate: (draft: { entries: StationhouseEntry[]; domain: StationhouseDomain }) => T,
): T {
  const entriesBefore = clone(listRows(STATIONHOUSE_KEY) as StationhouseEntry[])
  const domainBefore = clone(stationhouseDomain())

  const draft = {
    entries: clone(entriesBefore),
    domain: clone(domainBefore),
  }
  // 校验/计算失败在这里抛出：尚未发生任何写入，调用方按业务错误处理即可。
  const result = mutate(draft)

  const entriesNext = draft.entries
  const domainNext = draft.domain
  try {
    cache = { ...allRows(), [STATIONHOUSE_KEY]: entriesNext as EntryRow[] }
    domainCache = domainNext
    writeEntries(cache)
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.setItem(STATIONHOUSE_DOMAIN_KEY, JSON.stringify(domainNext))
    }
  } catch (error) {
    // 落库失败：记录集合与业务域整组恢复，绝不留半批。
    cache = { ...allRows(), [STATIONHOUSE_KEY]: entriesBefore as EntryRow[] }
    domainCache = domainBefore
    try {
      writeEntries(cache)
      if (typeof window !== 'undefined' && window.localStorage) {
        window.localStorage.setItem(STATIONHOUSE_DOMAIN_KEY, JSON.stringify(domainBefore))
      }
    } catch {
      // 恢复写也失败时保留内存里的回退快照，避免内存与界面继续按半批数据展示。
    }
    throw error instanceof Error
      ? new Error(`费用落库失败，整组已回退：${error.message}`)
      : new Error('费用落库失败，整组已回退')
  }
  return result
}

/** 只读快照：不改数据，只取当前一致的记录与业务域。 */
export function stationhouseSnapshot(): {
  entries: StationhouseEntry[]
  domain: StationhouseDomain
} {
  return {
    entries: clone(listRows(STATIONHOUSE_KEY) as StationhouseEntry[]),
    domain: clone(stationhouseDomain()),
  }
}

/** 连同记录与业务域一起回到种子数据。 */
export function resetStationhouse(): {
  entries: StationhouseEntry[]
  domain: StationhouseDomain
} {
  const entries = clone(SEED_ROWS[STATIONHOUSE_KEY] as StationhouseEntry[])
  const domain = defaultDomain()
  cache = { ...allRows(), [STATIONHOUSE_KEY]: entries as EntryRow[] }
  domainCache = domain
  writeEntries(cache)
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STATIONHOUSE_DOMAIN_KEY, JSON.stringify(domain))
  }
  return { entries, domain }
}
