/** 站房维护业务域类型：维护批次、验收待办（验收批次）、费用汇总（费用台账）共用同一套模型。 */

import type { EntryRow } from './types'

/** 站房维护记录在通用记录上追加的批次链路字段。 */
export type StationhouseEntry = EntryRow & {
  维护批次ID?: string
  验收批次ID?: string
  验收日期?: string
}

/** 维护批次：「安排维护」时生成，一批可以容纳多条维护记录。 */
export type MaintenanceBatch = {
  id: string
  安排日期: string
  entryIds: number[]
}

/** 验收批次：一次批量验收只落一条；已回退的批次只保留链路痕迹。 */
export type AcceptanceBatch = {
  id: string
  验收日期: string
  entryIds: number[]
  totalFee: number
  status: '已验收' | '已回退'
  /** 历史半批恢复（统一按整批回退口径）时记录原因。 */
  note?: string
}

/** 费用台账：只有验收成功才落库，是费用汇总的唯一数据来源。 */
export type FeeRow = {
  id: number
  entryId: number
  记录编号: string
  站点编号: string
  维护日期: string
  验收日期: string
  验收批次ID: string
  amount: number
}

/** 批量验收请求的幂等记录：同一提交（重复点击）只形成一批验收。 */
export type RequestRecord = {
  key: string
  batchId: string
  /** 本次请求覆盖的记录，用于识别同一批待办的重复提交。 */
  entryIds: number[]
}

export type StationhouseDomain = {
  maintenanceBatches: MaintenanceBatch[]
  acceptanceBatches: AcceptanceBatch[]
  fees: FeeRow[]
  requests: RequestRecord[]
  notices: string[]
  feeSeq: number
}

export type AcceptanceReceipt = {
  batchId: string
  count: number
  totalFee: number
  repeated: boolean
}

export type FeeSummary = {
  /** 台账总费用（全部已验收批次）。 */
  totalFee: number
  /** 本月（验收日期所在月）验收费用。 */
  monthFee: number
  acceptedCount: number
  monthAcceptedCount: number
  byMonth: { key: string; count: number; fee: number }[]
  byStation: { key: string; count: number; fee: number }[]
  fees: FeeRow[]
}

export type StationhouseBoard = {
  stats: { label: string; value: number | string }[]
  acceptanceTodo: StationhouseEntry[]
  acceptanceBatches: AcceptanceBatch[]
  maintenanceBatches: MaintenanceBatch[]
}

export const STATIONHOUSE_KEY = 'stationhouse'
export const STATIONHOUSE_DOMAIN_KEY = 'hydrology-monitor-station:stationhouse-domain'

export const STATIONHOUSE_STATUSES = ['待安排', '已安排', '施工中', '已完成', '已验收'] as const

/** 允许的单条状态流转：已验收记录不能再「安排维护」，只能在链路上顺序前进。 */
export const STATIONHOUSE_TRANSITIONS: Record<string, string> = {
  安排维护: '已安排',
  开始施工: '施工中',
  确认完工: '已完成',
  通过验收: '已验收',
}
