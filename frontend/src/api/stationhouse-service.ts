import { commitAll, listRows } from '@/data/local-store'
import type { ActionResult, EntryRow } from '@/data/types'

// 站房维护的验收链路：维护记录（stationhouse）、验收批次（stationhouse_batches）、
// 费用流水（stationhouse_fees）三张表共用一次原子提交。维护列表、验收待办、费用汇总
// 都从这份数据推导：任何一条费用落库失败，整批回退，三处一起恢复；重复提交只形成一批。
const MODULE_KEY = 'stationhouse'
const BATCH_KEY = 'stationhouse_batches'
const FEE_KEY = 'stationhouse_fees'

const STATUS_DONE = '已完成'
const STATUS_ACCEPTED = '已验收'
const BATCH_STATUS = '已生效'
const FEE_STATUS = '已入账'

export type FeeSummaryRow = {
  月份: string
  验收记录数: number
  费用合计: number
}

export type FeeSummary = {
  rows: FeeSummaryRow[]
  记录总数: number
  费用总计: number
}

export type BatchAcceptResult = ActionResult & {
  /** 同一提交标识重复提交时为 true：直接返回已生成的批次，不再落库。 */
  duplicated?: boolean
  batchId?: string
}

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100
}

function todayString(): string {
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

function moduleRows(): EntryRow[] {
  return listRows(MODULE_KEY)
}

function batchRows(): EntryRow[] {
  return listRows(BATCH_KEY)
}

function feeRows(): EntryRow[] {
  return listRows(FEE_KEY)
}

function nextNumericId(rows: EntryRow[]): number {
  return rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
}

function batchMemberIds(batch: EntryRow): number[] {
  return String(batch['记录ids'] ?? '')
    .split(',')
    .map((item) => Number(item.trim()))
    .filter((id) => Number.isFinite(id) && id > 0)
}

function nextBatchId(): string {
  const stamp = todayString().replace(/-/g, '')
  const sequence = String(batchRows().length + 1).padStart(4, '0')
  return `ACC-${stamp}-${sequence}`
}

/** 每次「批量验收」对话框打开/勾选变化时换发一个提交标识，用来挡住重复提交。 */
export function newRequestId(): string {
  const globalCrypto = typeof window !== 'undefined' ? window.crypto : undefined
  if (globalCrypto && typeof globalCrypto.randomUUID === 'function') {
    return globalCrypto.randomUUID()
  }
  return `req-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

/** 验收待办：状态为「已完成」、等待验收的维护记录。 */
export function listAcceptanceTodo(): EntryRow[] {
  ensureStationhouseConsistency()
  return moduleRows().filter((row) => String(row.status) === STATUS_DONE)
}

/** 维护批次：按生成时间倒序。 */
export function listAcceptanceBatches(): EntryRow[] {
  ensureStationhouseConsistency()
  return [...batchRows()].sort((a, b) => Number(b.id) - Number(a.id))
}

/** 费用汇总：按维护月份从费用流水实时聚合，与验收批次同源，验收成功即更新。 */
export function feeSummaryByMonth(): FeeSummary {
  ensureStationhouseConsistency()
  const byMonth = new Map<string, FeeSummaryRow>()
  for (const fee of feeRows()) {
    const month = String(fee['维护日期'] ?? '').slice(0, 7) || '未登记维护日期'
    const bucket = byMonth.get(month) ?? { 月份: month, 验收记录数: 0, 费用合计: 0 }
    bucket.验收记录数 += 1
    bucket.费用合计 = round2(bucket.费用合计 + Number(fee['金额']))
    byMonth.set(month, bucket)
  }
  const rows = [...byMonth.values()].sort((a, b) => a.月份.localeCompare(b.月份))
  return {
    rows,
    记录总数: rows.reduce((sum, row) => sum + row.验收记录数, 0),
    费用总计: round2(rows.reduce((sum, row) => sum + row.费用合计, 0)),
  }
}

/**
 * 批量验收：整批一次提交，要么全部生效、要么整组回退。
 * - 幂等：同一 requestId 只形成一批验收，重复提交返回已生成的批次；
 * - 校验：记录必须全部处于「已完成」，费用必须全部可入账，否则整批不提交；
 * - 原子：记录状态、验收批次、费用流水在同一个 commitAll 里落库，
 *   任何一条费用落库失败，列表、费用汇总、验收待办一起保持提交前的状态。
 */
export function acceptBatch(recordIds: number[], requestId: string, operator = '值班管理员'): BatchAcceptResult {
  ensureStationhouseConsistency()
  const ids = [...new Set(recordIds.map((id) => Number(id)))].sort((a, b) => a - b)
  if (ids.length === 0) {
    return { ok: false, message: '请先勾选要验收的维护记录' }
  }
  const requestKey = requestId.trim()
  if (!requestKey) {
    return { ok: false, message: '缺少提交标识，无法保证重复提交只形成一批，请刷新页面后重试' }
  }

  const existed = batchRows().find((batch) => String(batch['requestId']) === requestKey)
  if (existed) {
    const sameMembers = [...batchMemberIds(existed)].sort((a, b) => a - b).join(',') === ids.join(',')
    if (!sameMembers) {
      return { ok: false, message: `提交标识与批次 ${existed['批次号']} 的记录范围不一致，请刷新待办后重新勾选` }
    }
    return {
      ok: true,
      duplicated: true,
      batchId: String(existed['批次号']),
      message: `该批已验收过（批次号 ${existed['批次号']}），重复提交未生成新批次`,
    }
  }

  const rows = moduleRows()
  const rowById = new Map(rows.map((row) => [Number(row.id), row]))
  const missing = ids.filter((id) => !rowById.has(id))
  if (missing.length > 0) {
    return { ok: false, message: `没有找到编号为 ${missing.join('、')} 的站房维护记录，整批未提交` }
  }
  const notReady = ids.filter((id) => String(rowById.get(id)?.status) !== STATUS_DONE)
  if (notReady.length > 0) {
    return {
      ok: false,
      message: `记录 ${notReady.join('、')} 当前不是「${STATUS_DONE}」，不能验收；整批未提交，请刷新验收待办后重选`,
    }
  }

  // 费用先校验再落库：任何一条费用无法入账都视为落库失败，整批回退。
  const invalidFee = ids.filter((id) => {
    const fee = Number(rowById.get(id)?.['费用支出'])
    return !Number.isFinite(fee) || fee < 0
  })
  if (invalidFee.length > 0) {
    return {
      ok: false,
      message: `记录 ${invalidFee.join('、')} 的费用支出无法入账，整批已回退，请修正费用后重新提交`,
    }
  }

  const today = todayString()
  const batchId = nextBatchId()
  const feeTotal = round2(ids.reduce((sum, id) => sum + Number(rowById.get(id)?.['费用支出']), 0))
  const batch: EntryRow = {
    id: nextNumericId(batchRows()),
    status: BATCH_STATUS,
    pending: false,
    abnormal: false,
    批次号: batchId,
    requestId: requestKey,
    记录ids: ids.join(','),
    记录数: ids.length,
    费用合计: feeTotal,
    验收日期: today,
    验收人: operator,
  }
  const feeStartId = nextNumericId(feeRows())
  const feeEntries: EntryRow[] = ids.map((id, index) => {
    const source = rowById.get(id)!
    return {
      id: feeStartId + index,
      status: FEE_STATUS,
      pending: false,
      abnormal: false,
      批次号: batchId,
      记录id: id,
      记录编号: source['记录编号'],
      站点编号: source['站点编号'],
      维护类型: source['维护类型'],
      维护日期: source['维护日期'],
      金额: Number(source['费用支出']),
      入账日期: today,
    }
  })
  const nextRows = rows.map((row) =>
    ids.includes(Number(row.id))
      ? { ...row, status: STATUS_ACCEPTED, pending: false, 验收批次号: batchId, 验收日期: today, 验收人: operator }
      : row,
  )

  try {
    commitAll({
      [MODULE_KEY]: nextRows,
      [BATCH_KEY]: [...batchRows(), batch],
      [FEE_KEY]: [...feeRows(), ...feeEntries],
    })
  } catch (error) {
    return {
      ok: false,
      message: `验收批次落库失败，整批已回退：${error instanceof Error ? error.message : '未知错误'}`,
    }
  }
  return {
    ok: true,
    batchId,
    message: `批次 ${batchId} 验收完成：${ids.length} 条记录、费用合计 ${feeTotal.toFixed(2)} 元已入账`,
  }
}

/**
 * 历史部分成功批次的恢复口径：整组回退。
 * 一批验收只要「批次记录、成员记录状态、费用流水」三样对不上，整组退回「已完成」，
 * 重新进入验收待办，由值班人员重新走一次原子验收；记录的原维护日期、费用支出等
 * 登记信息一律保留，不做任何重置。健康的历史批次原样保留。
 */
export function ensureStationhouseConsistency(): void {
  try {
    rollbackPartialBatches()
  } catch (error) {
    // commitAll 失败时状态保持原样，这里只告警，下次读取会再尝试恢复。
    console.warn('站房维护历史批次恢复失败，保持现状待下次重试', error)
  }
}

function rollbackPartialBatches(): void {
  const rows = moduleRows()
  const batches = batchRows()
  const fees = feeRows()
  const hasAccepted = rows.some((row) => String(row.status) === STATUS_ACCEPTED)
  if (!hasAccepted && batches.length === 0 && fees.length === 0) {
    return
  }

  const completeBatchIds = new Set(
    batches.filter((batch) => isBatchComplete(batch, rows, fees)).map((batch) => String(batch['批次号'])),
  )

  const nextRows = rows.map((row) => {
    if (String(row.status) !== STATUS_ACCEPTED) {
      return row
    }
    if (completeBatchIds.has(String(row['验收批次号'] ?? ''))) {
      return row
    }
    // 整组回退：只清验收相关字段，原维护日期等登记信息保留。
    return { ...row, status: STATUS_DONE, pending: true, 验收批次号: '', 验收日期: '', 验收人: '' }
  })
  const nextBatches = batches.filter((batch) => completeBatchIds.has(String(batch['批次号'])))
  const nextFees = fees.filter((fee) => completeBatchIds.has(String(fee['批次号'])))

  const changed =
    nextRows.some((row, index) => row !== rows[index]) ||
    nextBatches.length !== batches.length ||
    nextFees.length !== fees.length
  if (!changed) {
    return
  }
  commitAll({ [MODULE_KEY]: nextRows, [BATCH_KEY]: nextBatches, [FEE_KEY]: nextFees })
}

/** 一批验收是否完整：批次、成员状态、费用流水三样互相印证，缺一样都算半批。 */
function isBatchComplete(batch: EntryRow, rows: EntryRow[], fees: EntryRow[]): boolean {
  const batchId = String(batch['批次号'] ?? '')
  const memberIds = batchMemberIds(batch)
  if (!batchId || memberIds.length === 0) {
    return false
  }
  const rowById = new Map(rows.map((row) => [Number(row.id), row]))
  for (const id of memberIds) {
    const row = rowById.get(id)
    if (!row || String(row.status) !== STATUS_ACCEPTED || String(row['验收批次号'] ?? '') !== batchId) {
      return false
    }
  }
  const claimedOutside = rows.some(
    (row) => String(row['验收批次号'] ?? '') === batchId && !memberIds.includes(Number(row.id)),
  )
  if (claimedOutside) {
    return false
  }
  const batchFees = fees.filter((fee) => String(fee['批次号'] ?? '') === batchId)
  if (batchFees.length !== memberIds.length) {
    return false
  }
  if (!memberIds.every((id) => batchFees.filter((fee) => Number(fee['记录id']) === id).length === 1)) {
    return false
  }
  const feeSum = round2(batchFees.reduce((sum, fee) => sum + Number(fee['金额']), 0))
  return feeSum === round2(Number(batch['费用合计']))
}
