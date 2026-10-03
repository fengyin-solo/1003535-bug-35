/**
 * 站房维护业务服务：维护批次 → 验收待办 → 费用台账/汇总 全链路在这里闭环。
 *
 * 约定（与需求对应）：
 * - 批量验收是一个事务：记录状态、验收批次、费用台账要么一起提交，要么整组回退；
 * - 重复提交同一批待办只形成一批验收（幂等），返回同一批次回执；
 * - 任一费用落库失败，维护列表、费用汇总、验收待办一起恢复；
 * - 历史部分成功批次统一按「整批回退到验收待办」口径恢复，原维护日期原样保留。
 */

import { filterRows } from '@/api/local-service'
import {
  commitStationhouse,
  resetStationhouse,
  stationhouseSnapshot,
} from '@/data/local-store'
import {
  STATIONHOUSE_KEY,
  STATIONHOUSE_STATUSES,
  STATIONHOUSE_TRANSITIONS,
  type AcceptanceBatch,
  type AcceptanceReceipt,
  type FeeRow,
  type FeeSummary,
  type StationhouseBoard,
  type StationhouseDomain,
  type StationhouseEntry,
} from '@/data/stationhouse-types'
import type { ActionResult, PageResult } from '@/data/types'

const ENTITY = '站房维护记录'
const FINAL_STATUS = '已验收'
const DONE_STATUS = '已完成'
const PENDING_ARRANGE = '待安排'
const ARRANGED = '已安排'

function todayText(): string {
  return new Date().toISOString().slice(0, 10)
}

function monthOf(date: string): string {
  return (date || '').slice(0, 7)
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

/** 费用落库前的校验：必须是不小于 0 的有限数值，否则本次事务整体失败。 */
function parseFee(entry: StationhouseEntry): number {
  const raw = entry['费用支出']
  const amount = typeof raw === 'number' ? raw : Number(String(raw ?? '').trim())
  if (!Number.isFinite(amount) || amount < 0) {
    throw new Error(`记录 ${entry['记录编号']} 的费用支出「${String(raw)}」无法入账`)
  }
  return round2(amount)
}

function feeKey(fee: FeeRow): string {
  return `${fee.entryId}|${fee['验收批次ID']}`
}

function nextBatchId(
  domain: StationhouseDomain,
  prefix: 'WX' | 'YS',
  date: string,
): string {
  const ym = date.slice(0, 7).replace('-', '')
  const sequence =
    [...domain.maintenanceBatches, ...domain.acceptanceBatches]
      .map((batch) => batch.id)
      .filter((id) => id.startsWith(`${prefix}-${ym}-`))
      .map((id) => Number(id.slice(`${prefix}-${ym}-`.length)))
      .filter((num) => Number.isInteger(num))
      .reduce((max, num) => Math.max(max, num), 0) + 1
  return `${prefix}-${ym}-${String(sequence).padStart(3, '0')}`
}

/**
 * 历史数据恢复：扫描记录、验收批次、费用台账三方一致性。
 *
 * 口径：部分成功的验收批次一律整批回退——记录退回「已完成」重新进入验收待办，
 * 对应费用整批清除、批次标记「已回退」；重复费用去重、孤儿费用清除；
 * 全程不触碰「维护日期」字段。
 */
function reconcile(draft: {
  entries: StationhouseEntry[]
  domain: StationhouseDomain
}): string[] {
  const { entries, domain } = draft
  const notices: string[] = []
  const entryById = new Map(entries.map((entry) => [Number(entry.id), entry]))

  // 1. 费用台账去重：同一记录同一批次只保留一条，重复的丢掉（半批重复显示的来源）。
  const seenFees = new Map<string, FeeRow>()
  const duplicateEntryIds = new Set<number>()
  for (const fee of domain.fees) {
    const key = feeKey(fee)
    if (seenFees.has(key)) {
      duplicateEntryIds.add(fee.entryId)
    } else {
      seenFees.set(key, fee)
    }
  }

  // 2. 清掉找不到验收批次、或批次已回退的孤儿费用（半批残留，避免汇总凭空多出钱）。
  const batchById = new Map(domain.acceptanceBatches.map((batch) => [batch.id, batch]))
  const validFees: FeeRow[] = []
  for (const fee of seenFees.values()) {
    const batch = batchById.get(fee['验收批次ID'])
    if (!batch || batch.status === '已回退') {
      notices.push(
        `清理孤儿费用：记录 ${fee['记录编号']} 的 ${fee.amount} 元找不到有效验收批次，未计入汇总`,
      )
      continue
    }
    validFees.push(fee)
  }

  // 3. 校验每个验收批次：批次内记录与费用必须一一对应，否则整批回退。
  const feesByBatch = new Map<string, FeeRow[]>()
  for (const fee of validFees) {
    const list = feesByBatch.get(fee['验收批次ID']) ?? []
    list.push(fee)
    feesByBatch.set(fee['验收批次ID'], list)
  }

  for (const batch of domain.acceptanceBatches) {
    if (batch.status !== '已验收') {
      continue
    }
    const batchFees = feesByBatch.get(batch.id) ?? []
    const feeEntryIds = new Set(batchFees.map((fee) => fee.entryId))
    const batchEntries = batch.entryIds
      .map((id) => entryById.get(Number(id)))
      .filter((entry): entry is StationhouseEntry => Boolean(entry))

    const entriesConsistent =
      batchEntries.length === batch.entryIds.length &&
      batchEntries.every((entry) => entry.status === FINAL_STATUS) &&
      batchEntries.every((entry) => entry['验收批次ID'] === batch.id)
    const feesConsistent =
      batchFees.length === batch.entryIds.length &&
      batch.entryIds.every((id) => feeEntryIds.has(Number(id)))

    if (!entriesConsistent || !feesConsistent) {
      // 整批回退口径：记录、费用、批次一起恢复到待办；维护日期保持原样。
      for (const entry of batchEntries) {
        entry.status = DONE_STATUS
        entry.pending = true
        delete entry['验收批次ID']
        delete entry['验收日期']
      }
      batch.status = '已回退'
      batch.note =
        '历史部分成功批次：记录与费用台账不一致，按整批回退口径恢复为验收待办，原维护日期保留'
      for (const fee of batchFees) {
        notices.push(
          `回退批次 ${batch.id}：冲销记录 ${fee['记录编号']} 已入账费用 ${fee.amount} 元（维护日期 ${fee['维护日期']} 保留）`,
        )
      }
      notices.push(
        `验收批次 ${batch.id}（${batch.entryIds.length} 条）曾部分落库，已整批回退为验收待办，可重新提交验收`,
      )
      continue
    }

    // 一致的批次：修正可能过时的费用合计与记录冗余字段，保证汇总按台账最新值走。
    const totalFee = round2(batchFees.reduce((sum, fee) => sum + fee.amount, 0))
    if (round2(batch.totalFee) !== totalFee) {
      notices.push(`修正验收批次 ${batch.id} 的费用合计：${batch.totalFee} → ${totalFee}`)
      batch.totalFee = totalFee
    }
  }

  // 回退后的费用从台账中移除，汇总只统计仍有效的验收批次。
  const liveBatchIds = new Set(
    domain.acceptanceBatches.filter((batch) => batch.status === '已验收').map((b) => b.id),
  )
  domain.fees = validFees.filter((fee) => liveBatchIds.has(fee['验收批次ID']))

  if (duplicateEntryIds.size > 0) {
    // 重复费用的所属批次若完整，会在这里提示去重；若批次已整体回退，则费用已随批清除。
    const codes = [...duplicateEntryIds].map((id) => entryById.get(id)?.['记录编号'] ?? id)
    notices.push(`验收费用重复落库的记录已按一批保留：${codes.join('、')}`)
  }

  // 4. 记录状态自检：已完成/已验收之外不得挂验收批次；pending 与状态对齐。
  for (const entry of entries) {
    if (entry.status !== FINAL_STATUS) {
      if (entry['验收批次ID']) {
        delete entry['验收批次ID']
        delete entry['验收日期']
      }
    }
    entry.pending = entry.status !== FINAL_STATUS
  }

  // 5. pending 与最终状态已在上面统一对齐；维护批次只是链路记录，状态随其记录自然反映。
  domain.notices = notices.length > 0 ? notices : []
  return notices
}

let booted = false
let bootNotices: string[] = []

/** 首次访问站房模块时做一次一致性恢复（在同一事务里提交，恢复本身也保证原子）。 */
function ensureRecovered(): { notices: string[]; changed: boolean } {
  if (booted) {
    return { notices: bootNotices, changed: false }
  }
  const before = stationhouseSnapshot()
  const notices = commitStationhouse((draft) => reconcile(draft))
  booted = true
  bootNotices = notices
  return { notices, changed: notices.length > 0 || !shallowEqual(before.domain.notices, notices) }
}

function shallowEqual(a: unknown[], b: unknown[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index])
}

export function listStationhouse(filters: Record<string, string> = {}): PageResult {
  ensureRecovered()
  const { entries } = stationhouseSnapshot()
  const matched = filterRows(entries, filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export function stationhouseNotices(): string[] {
  ensureRecovered()
  return stationhouseSnapshot().domain.notices
}

export function dismissStationhouseNotices(): void {
  commitStationhouse((draft) => {
    draft.domain.notices = []
  })
  bootNotices = []
}

function actionAllowed(entry: StationhouseEntry, action: string): string | null {
  const target = STATIONHOUSE_TRANSITIONS[action]
  if (!target) {
    return `没有登记「${action}」这个动作`
  }
  const current = entry.status
  if (current === target) {
    return `${ENTITY}已经是「${target}」，不用重复操作`
  }
  const fromIndex = STATIONHOUSE_STATUSES.indexOf(current as (typeof STATIONHOUSE_STATUSES)[number])
  const toIndex = STATIONHOUSE_STATUSES.indexOf(target as (typeof STATIONHOUSE_STATUSES)[number])
  if (fromIndex < 0 || toIndex !== fromIndex + 1) {
    return `${ENTITY}当前「${current}」不能${action}，请按 待安排→已安排→施工中→已完成→已验收 的链路操作`
  }
  return null
}

/** 单条动作：已验收记录不能再次安排，只能沿链路顺序前进。 */
export function runStationhouseAction(id: number, action: string): ActionResult {
  ensureRecovered()
  try {
    const message = commitStationhouse((draft) => {
      const entry = draft.entries.find((item) => Number(item.id) === id)
      if (!entry) {
        return `没有找到编号为 ${id} 的${ENTITY}`
      }
      const rejected = actionAllowed(entry, action)
      if (rejected) {
        return rejected
      }
      const target = STATIONHOUSE_TRANSITIONS[action]
      entry.status = target
      entry.pending = target !== FINAL_STATUS
      if (target === ARRANGED && !entry['维护批次ID']) {
        const batchId = nextBatchId(draft.domain, 'WX', todayText())
        entry['维护批次ID'] = batchId
        draft.domain.maintenanceBatches.push({
          id: batchId,
          安排日期: todayText(),
          entryIds: [Number(entry.id)],
        })
      }
      return ''
    })
    if (message) {
      return { ok: false, message }
    }
    return { ok: true, message: `${ENTITY}已${action}` }
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : `${action}失败，数据已回退`,
    }
  }
}

/** 批量安排：同一事务给一批「待安排」记录挂同一个维护批次。 */
export function arrangeBatch(ids: number[]): ActionResult & { batchId?: string } {
  ensureRecovered()
  const uniqueIds = [...new Set(ids.map(Number))]
  if (uniqueIds.length === 0) {
    return { ok: false, message: '请先勾选需要安排维护的记录' }
  }
  try {
    const batchId = commitStationhouse((draft) => {
      const targets = uniqueIds
        .map((id) => draft.entries.find((entry) => Number(entry.id) === id))
        .filter((entry): entry is StationhouseEntry => Boolean(entry))
      if (targets.length !== uniqueIds.length) {
        throw new Error('部分记录不存在，请刷新后重试')
      }
      const illegal = targets.find((entry) => entry.status !== PENDING_ARRANGE)
      if (illegal) {
        throw new Error(
          `记录 ${illegal['记录编号']} 当前为「${illegal.status}」，只有待安排记录能批量安排；已验收记录不会再进入安排`,
        )
      }
      const id = nextBatchId(draft.domain, 'WX', todayText())
      draft.domain.maintenanceBatches.push({
        id,
        安排日期: todayText(),
        entryIds: targets.map((entry) => Number(entry.id)),
      })
      for (const entry of targets) {
        entry.status = ARRANGED
        entry.pending = true
        entry['维护批次ID'] = id
      }
      return id
    })
    return { ok: true, message: `已安排 ${uniqueIds.length} 条维护记录（批次 ${batchId}）`, batchId }
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : '批量安排失败，数据已回退',
    }
  }
}

/**
 * 批量验收（核心事务）。
 *
 * - requestKey 相同的重复提交直接返回原批次回执，只形成一批验收；
 * - 全部待办记录、验收批次、费用台账在同一事务内一次提交；
 * - 任一费用不合格 / 落库失败：记录不翻转、待办不减少、汇总不增加，整组回退。
 */
export function acceptInBatch(
  ids: number[],
  requestKey?: string,
): ActionResult & { receipt?: AcceptanceReceipt } {
  ensureRecovered()
  const uniqueIds = [...new Set(ids.map(Number))]
  if (uniqueIds.length === 0) {
    return { ok: false, message: '请先勾选需要验收的待办记录' }
  }
  try {
    const receipt = commitStationhouse((draft) => {
      // 幂等：同一 requestKey 的重复提交只取原批次。
      if (requestKey) {
        const previous = draft.domain.requests.find((item) => item.key === requestKey)
        if (previous) {
          const batch = draft.domain.acceptanceBatches.find((b) => b.id === previous.batchId)
          if (batch && batch.status === '已验收') {
            return {
              batchId: batch.id,
              count: batch.entryIds.length,
              totalFee: batch.totalFee,
              repeated: true,
            } satisfies AcceptanceReceipt
          }
        }
      }

      const targets = uniqueIds
        .map((id) => draft.entries.find((entry) => Number(entry.id) === id))
        .filter((entry): entry is StationhouseEntry => Boolean(entry))
      if (targets.length !== uniqueIds.length) {
        throw new Error('部分待办记录不存在，请刷新后重试')
      }
      for (const entry of targets) {
        if (entry.status === FINAL_STATUS) {
          throw new Error(`记录 ${entry['记录编号']} 已验收，不能重复安排进同一批验收`)
        }
        if (entry.status !== DONE_STATUS) {
          throw new Error(
            `记录 ${entry['记录编号']} 当前为「${entry.status}」，只有已完成记录能进入验收`,
          )
        }
      }

      // 费用先全部校验再落库：任一条不合格，整组一起回退。
      const acceptDate = todayText()
      const fees = targets.map((entry) => ({ entry, amount: parseFee(entry) }))
      const totalFee = round2(fees.reduce((sum, item) => sum + item.amount, 0))
      const batchId = nextBatchId(draft.domain, 'YS', acceptDate)
      const batch: AcceptanceBatch = {
        id: batchId,
        验收日期: acceptDate,
        entryIds: targets.map((entry) => Number(entry.id)),
        totalFee,
        status: '已验收',
      }
      draft.domain.acceptanceBatches.push(batch)

      let seq = draft.domain.feeSeq
      for (const { entry, amount } of fees) {
        seq += 1
        draft.domain.fees.push({
          id: seq,
          entryId: Number(entry.id),
          记录编号: String(entry['记录编号'] ?? ''),
          站点编号: String(entry['站点编号'] ?? ''),
          维护日期: String(entry['维护日期'] ?? ''),
          验收日期: acceptDate,
          验收批次ID: batchId,
          amount,
        })
        entry.status = FINAL_STATUS
        entry.pending = false
        entry['验收批次ID'] = batchId
        entry['验收日期'] = acceptDate
      }
      draft.domain.feeSeq = seq
      if (requestKey) {
        draft.domain.requests.push({ key: requestKey, batchId, entryIds: batch.entryIds })
      }
      return { batchId, count: targets.length, totalFee, repeated: false } satisfies AcceptanceReceipt
    })
    return {
      ok: true,
      receipt,
      message: receipt.repeated
        ? `该验收提交已处理过，仍为同一批 ${receipt.batchId}（${receipt.count} 条）`
        : `验收批次 ${receipt.batchId} 已提交：${receipt.count} 条，合计 ${receipt.totalFee} 元`,
    }
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : '批量验收失败，列表、汇总与待办已一起回退',
    }
  }
}

/** 费用汇总：始终按费用台账实时计算，不再保留会过期的旧汇总值。 */
export function feeSummary(): FeeSummary {
  ensureRecovered()
  const { domain } = stationhouseSnapshot()
  const fees = domain.fees
  const month = monthOf(todayText())

  const byMonthMap = new Map<string, { count: number; fee: number }>()
  const byStationMap = new Map<string, { count: number; fee: number }>()
  for (const fee of fees) {
    const mKey = monthOf(fee['验收日期'])
    const monthBucket = byMonthMap.get(mKey) ?? { count: 0, fee: 0 }
    monthBucket.count += 1
    monthBucket.fee = round2(monthBucket.fee + fee.amount)
    byMonthMap.set(mKey, monthBucket)

    const sKey = fee['站点编号']
    const stationBucket = byStationMap.get(sKey) ?? { count: 0, fee: 0 }
    stationBucket.count += 1
    stationBucket.fee = round2(stationBucket.fee + fee.amount)
    byStationMap.set(sKey, stationBucket)
  }

  const byMonth = [...byMonthMap.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .map(([key, value]) => ({ key, ...value }))
  const byStation = [...byStationMap.entries()]
    .sort((a, b) => b[1].fee - a[1].fee)
    .map(([key, value]) => ({ key, ...value }))
  const monthFees = fees.filter((fee) => monthOf(fee['验收日期']) === month)

  return {
    totalFee: round2(fees.reduce((sum, fee) => sum + fee.amount, 0)),
    monthFee: round2(monthFees.reduce((sum, fee) => sum + fee.amount, 0)),
    acceptedCount: fees.length,
    monthAcceptedCount: monthFees.length,
    byMonth,
    byStation,
    fees: [...fees].sort((a, b) => (a['验收日期'] < b['验收日期'] ? 1 : -1)),
  }
}

/** 看板数据：待办、批次链路、顶部指标都从同一快照取，三处口径天然一致。 */
export function stationhouseBoard(): StationhouseBoard {
  ensureRecovered()
  const { entries, domain } = stationhouseSnapshot()
  const month = monthOf(todayText())
  const acceptanceTodo = entries.filter((entry) => entry.status === DONE_STATUS)
  const pendingArrange = entries.filter((entry) => entry.status === PENDING_ARRANGE).length
  const constructing = entries.filter((entry) => entry.status === '施工中').length
  const monthAccepted = entries.filter(
    (entry) =>
      entry.status === FINAL_STATUS && monthOf(String(entry['验收日期'] ?? '')) === month,
  ).length

  return {
    stats: [
      { label: '待维护项数', value: pendingArrange },
      { label: '施工中项数', value: constructing },
      { label: '本月已验收', value: monthAccepted },
    ],
    acceptanceTodo,
    acceptanceBatches: [...domain.acceptanceBatches].sort((a, b) =>
      a['验收日期'] < b['验收日期'] ? 1 : -1,
    ),
    maintenanceBatches: [...domain.maintenanceBatches].sort((a, b) =>
      a.id < b.id ? 1 : -1,
    ),
  }
}

export function resetStationhouseData(): void {
  resetStationhouse()
  booted = true
  bootNotices = []
}

export { STATIONHOUSE_KEY }
