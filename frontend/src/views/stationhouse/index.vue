<template>
  <section class="page" data-module="stationhouse">
    <header class="page-head">
      <div>
        <h2>站房维护管理</h2>
        <p class="page-desc">维护批次、验收待办与费用汇总同一条链路：批量验收一次提交，列表、汇总、待办同时更新或一起回退。</p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="exportRows">导出站房维护清单</button>
      </div>
    </header>

    <div v-if="notices.length" class="notice-box">
      <div class="notice-head">
        <strong>检测到历史部分成功批次，已按「整批回退为验收待办」口径恢复（原维护日期保留）：</strong>
        <button class="link" type="button" @click="clearNotices">知道了</button>
      </div>
      <ul class="notice-list">
        <li v-for="(item, index) in notices" :key="index">{{ item }}</li>
      </ul>
    </div>

    <div class="stat-row">
      <article v-for="item in board.stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">验收待办</span>
        <strong class="stat-value">{{ board.acceptanceTodo.length }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">已验收费用合计（元）</span>
        <strong class="stat-value">{{ summary.totalFee.toFixed(2) }}</strong>
      </article>
    </div>

    <div class="tabs">
      <button
        v-for="tab in tabs"
        :key="tab.key"
        class="tab-btn"
        :class="{ active: activeTab === tab.key }"
        type="button"
        @click="switchTab(tab.key)"
      >
        {{ tab.label }}
        <span v-if="tab.key === 'acceptance' && board.acceptanceTodo.length" class="tab-badge">
          {{ board.acceptanceTodo.length }}
        </span>
      </button>
    </div>

    <p v-if="activeTab === 'list'" class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <!-- 维护列表 -->
    <template v-if="activeTab === 'list'">
      <form class="filter-bar" @submit.prevent="reload">
        <label class="filter-item">
          <span>记录编号</span>
          <input v-model="filters['记录编号']" placeholder="按记录编号检索" />
        </label>
        <label class="filter-item">
          <span>站点编号</span>
          <input v-model="filters['站点编号']" placeholder="按站点编号检索" />
        </label>
        <label class="filter-item">
          <span>维护类型</span>
          <input v-model="filters['维护类型']" placeholder="按维护类型检索" />
        </label>
        <button class="btn" type="submit">查询</button>
        <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
        <button
          class="btn primary"
          type="button"
          :disabled="!arrangeSelection.length"
          @click="batchArrange"
        >
          批量安排（{{ arrangeSelection.length }}）
        </button>
      </form>

      <table class="data-table">
        <thead>
          <tr>
            <th class="check-col"><input type="checkbox" :checked="allVisibleArrange" @change="toggleAllArrange" /></th>
            <th v-for="column in listColumns" :key="column.key">{{ column.label }}</th>
            <th>当前状态</th>
            <th>可执行动作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in rows" :key="String(row.id)">
            <td class="check-col">
              <input
                v-if="row.status === '待安排'"
                type="checkbox"
                :checked="arrangeSelection.includes(Number(row.id))"
                @change="toggleArrange(Number(row.id))"
              />
            </td>
            <td v-for="column in listColumns" :key="column.key">{{ cellText(row, column.key) }}</td>
            <td>{{ row.status }}</td>
            <td class="row-actions">
              <button
                v-for="action in availableActions(row.status)"
                :key="action"
                class="link"
                type="button"
                @click="runAction(action, row)"
              >
                {{ action }}
              </button>
            </td>
          </tr>
          <tr v-if="!rows.length">
            <td :colspan="listColumns.length + 3" class="empty-state">暂无站房维护数据</td>
          </tr>
        </tbody>
      </table>
    </template>

    <!-- 验收处理 -->
    <template v-else-if="activeTab === 'acceptance'">
      <h3 class="section-title">验收待办（仅「已完成」记录可验收，已验收记录不会再次出现）</h3>
      <table class="data-table">
        <thead>
          <tr>
            <th class="check-col"><input type="checkbox" :checked="allTodoSelected" @change="toggleAllTodo" /></th>
            <th>记录编号</th>
            <th>站点编号</th>
            <th>维护类型</th>
            <th>维护单位</th>
            <th>维护日期</th>
            <th>维护批次</th>
            <th>费用支出（元）</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in board.acceptanceTodo" :key="String(row.id)">
            <td class="check-col">
              <input
                type="checkbox"
                :checked="acceptSelection.includes(Number(row.id))"
                @change="toggleAccept(Number(row.id))"
              />
            </td>
            <td>{{ row['记录编号'] }}</td>
            <td>{{ row['站点编号'] }}</td>
            <td>{{ row['维护类型'] }}</td>
            <td>{{ row['维护单位'] }}</td>
            <td>{{ row['维护日期'] }}</td>
            <td>{{ row['维护批次ID'] || '—' }}</td>
            <td>{{ feeText(row) }}</td>
          </tr>
          <tr v-if="!board.acceptanceTodo.length">
            <td colspan="8" class="empty-state">没有待验收记录</td>
          </tr>
        </tbody>
      </table>
      <div class="batch-bar">
        <button
          class="btn primary"
          type="button"
          :disabled="!acceptSelection.length || accepting"
          @click="batchAccept"
        >
          {{ accepting ? '验收提交中…' : `批量验收（${acceptSelection.length}）` }}
        </button>
        <span class="batch-tip">
          选中 {{ acceptSelection.length }} 条，待验收费用合计
          <strong>{{ todoFeeTotal.toFixed(2) }}</strong> 元；重复提交只形成一批，任一费用落库失败整组回退。
        </span>
      </div>

      <h3 class="section-title">验收批次链路（含历史回退批次）</h3>
      <table class="data-table">
        <thead>
          <tr>
            <th>验收批次</th>
            <th>验收日期</th>
            <th>记录数</th>
            <th>费用合计（元）</th>
            <th>状态</th>
            <th>覆盖记录</th>
            <th>说明</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="batch in board.acceptanceBatches" :key="batch.id">
            <td>{{ batch.id }}</td>
            <td>{{ batch['验收日期'] }}</td>
            <td>{{ batch.entryIds.length }}</td>
            <td>{{ batch.totalFee.toFixed(2) }}</td>
            <td>{{ batch.status }}</td>
            <td>{{ batch.entryIds.join('、') }}</td>
            <td>{{ batch.note || '—' }}</td>
          </tr>
        </tbody>
      </table>

      <h3 class="section-title">维护批次</h3>
      <table class="data-table">
        <thead>
          <tr>
            <th>维护批次</th>
            <th>安排日期</th>
            <th>覆盖记录</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="batch in board.maintenanceBatches" :key="batch.id">
            <td>{{ batch.id }}</td>
            <td>{{ batch['安排日期'] }}</td>
            <td>{{ batch.entryIds.join('、') }}</td>
          </tr>
        </tbody>
      </table>
    </template>

    <!-- 费用汇总 -->
    <template v-else>
      <div class="stat-row">
        <article class="stat-card">
          <span class="stat-label">已验收费用合计（元）</span>
          <strong class="stat-value">{{ summary.totalFee.toFixed(2) }}</strong>
        </article>
        <article class="stat-card">
          <span class="stat-label">本月验收费用（元）</span>
          <strong class="stat-value">{{ summary.monthFee.toFixed(2) }}</strong>
        </article>
        <article class="stat-card">
          <span class="stat-label">已入账费用笔数</span>
          <strong class="stat-value">{{ summary.acceptedCount }}</strong>
        </article>
        <article class="stat-card">
          <span class="stat-label">本月入账笔数</span>
          <strong class="stat-value">{{ summary.monthAcceptedCount }}</strong>
        </article>
      </div>

      <h3 class="section-title">按验收月份汇总</h3>
      <table class="data-table">
        <thead>
          <tr><th>验收月份</th><th>笔数</th><th>费用（元）</th></tr>
        </thead>
        <tbody>
          <tr v-for="row in summary.byMonth" :key="row.key">
            <td>{{ row.key }}</td>
            <td>{{ row.count }}</td>
            <td>{{ row.fee.toFixed(2) }}</td>
          </tr>
          <tr v-if="!summary.byMonth.length">
            <td colspan="3" class="empty-state">暂无已验收费用</td>
          </tr>
        </tbody>
      </table>

      <h3 class="section-title">按站点汇总</h3>
      <table class="data-table">
        <thead>
          <tr><th>站点编号</th><th>笔数</th><th>费用（元）</th></tr>
        </thead>
        <tbody>
          <tr v-for="row in summary.byStation" :key="row.key">
            <td>{{ row.key }}</td>
            <td>{{ row.count }}</td>
            <td>{{ row.fee.toFixed(2) }}</td>
          </tr>
          <tr v-if="!summary.byStation.length">
            <td colspan="3" class="empty-state">暂无已验收费用</td>
          </tr>
        </tbody>
      </table>

      <h3 class="section-title">费用台账（汇总的唯一数据来源，保留原维护日期）</h3>
      <table class="data-table">
        <thead>
          <tr>
            <th>记录编号</th>
            <th>站点编号</th>
            <th>维护日期</th>
            <th>验收日期</th>
            <th>验收批次</th>
            <th>金额（元）</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="fee in summary.fees" :key="fee.id">
            <td>{{ fee['记录编号'] }}</td>
            <td>{{ fee['站点编号'] }}</td>
            <td>{{ fee['维护日期'] }}</td>
            <td>{{ fee['验收日期'] }}</td>
            <td>{{ fee['验收批次ID'] }}</td>
            <td>{{ fee.amount.toFixed(2) }}</td>
          </tr>
          <tr v-if="!summary.fees.length">
            <td colspan="6" class="empty-state">暂无费用台账记录</td>
          </tr>
        </tbody>
      </table>
    </template>

    <footer class="page-foot">
      <span>共 {{ total }} 条站房维护记录</span>
      <span v-if="message" :class="messageOk ? 'ok-text' : 'error-text'">{{ message }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import { downloadEntries } from '@/api/local-service'
import {
  acceptInBatch,
  arrangeBatch,
  feeSummary,
  listStationhouse,
  runStationhouseAction,
  stationhouseBoard,
  stationhouseNotices,
  dismissStationhouseNotices,
} from '@/api/stationhouse-service'
import type { FeeSummary as Summary, StationhouseBoard as Board } from '@/data/stationhouse-types'
import type { EntryRow } from '@/data/types'

const listColumns = [
  { key: '记录编号', label: '记录编号' },
  { key: '站点编号', label: '站点编号' },
  { key: '维护类型', label: '维护类型' },
  { key: '维护内容', label: '维护内容' },
  { key: '维护单位', label: '维护单位' },
  { key: '维护日期', label: '维护日期' },
  { key: '费用支出', label: '费用支出（元）' },
  { key: '维护批次ID', label: '维护批次' },
  { key: '验收批次ID', label: '验收批次' },
  { key: '验收日期', label: '验收日期' },
]

const tabs = [
  { key: 'list', label: '维护列表' },
  { key: 'acceptance', label: '验收处理' },
  { key: 'fees', label: '费用汇总' },
] as const
type TabKey = (typeof tabs)[number]['key']

const rows = ref<EntryRow[]>([])
const total = ref(0)
const filters = ref<Record<string, string>>({})
const activeTab = ref<TabKey>('list')
const notices = ref<string[]>([])
const message = ref('')
const messageOk = ref(true)
const arrangeSelection = ref<number[]>([])
const acceptSelection = ref<number[]>([])
const accepting = ref(false)

const board = ref<Board>({
  stats: [],
  acceptanceTodo: [],
  acceptanceBatches: [],
  maintenanceBatches: [],
})
const summary = ref<Summary>({
  totalFee: 0,
  monthFee: 0,
  acceptedCount: 0,
  monthAcceptedCount: 0,
  byMonth: [],
  byStation: [],
  fees: [],
})

const statuses = ['待安排', '已安排', '施工中', '已完成', '已验收']
const statusSummary = computed(() =>
  statuses.map((status) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

const allVisibleArrange = computed(
  () =>
    rows.value.some((row) => row.status === '待安排') &&
    rows.value
      .filter((row) => row.status === '待安排')
      .every((row) => arrangeSelection.value.includes(Number(row.id))),
)

const allTodoSelected = computed(
  () =>
    board.value.acceptanceTodo.length > 0 &&
    board.value.acceptanceTodo.every((row) => acceptSelection.value.includes(Number(row.id))),
)

const todoFeeTotal = computed(() => {
  const selected = new Set(acceptSelection.value)
  return round(
    board.value.acceptanceTodo
      .filter((row) => selected.has(Number(row.id)))
      .reduce((sum, row) => sum + feeNumber(row), 0),
  )
})

function round(value: number): number {
  return Math.round(value * 100) / 100
}

function feeNumber(row: EntryRow): number {
  const raw = row['费用支出']
  const value = typeof raw === 'number' ? raw : Number(String(raw ?? '').trim())
  return Number.isFinite(value) ? value : 0
}

function feeText(row: EntryRow): string {
  return feeNumber(row).toFixed(2)
}

function cellText(row: EntryRow, column: string): string {
  const value = row[column]
  if (value === undefined || value === null || value === '') {
    return column.startsWith('验收') || column === '维护批次ID' ? '—' : ''
  }
  return String(value)
}

function availableActions(status: string): string[] {
  // 已验收是终态：不再出现任何前行动作，杜绝「已验收记录还能再次安排」。
  switch (status) {
    case '待安排':
      return ['安排维护']
    case '已安排':
      return ['开始施工']
    case '施工中':
      return ['确认完工']
    case '已完成':
      return ['通过验收']
    default:
      return []
  }
}

function flash(ok: boolean, text: string) {
  messageOk.value = ok
  message.value = text
}

function reload() {
  message.value = ''
  try {
    const payload = listStationhouse(filters.value)
    rows.value = payload.items
    total.value = payload.total
    board.value = stationhouseBoard()
    summary.value = feeSummary()
    notices.value = stationhouseNotices()
    arrangeSelection.value = arrangeSelection.value.filter((id) =>
      rows.value.some((row) => Number(row.id) === id && row.status === '待安排'),
    )
    acceptSelection.value = acceptSelection.value.filter((id) =>
      board.value.acceptanceTodo.some((row) => Number(row.id) === id),
    )
  } catch (error) {
    flash(false, error instanceof Error ? error.message : '站房维护数据读取失败')
  }
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries('stationhouse')
}

function clearNotices() {
  dismissStationhouseNotices()
  notices.value = []
}

function switchTab(tab: TabKey) {
  activeTab.value = tab
  reload()
}

function runAction(action: string, row: EntryRow) {
  const result = runStationhouseAction(Number(row.id), action)
  flash(result.ok, result.message)
  reload()
}

function toggleArrange(id: number) {
  const set = new Set(arrangeSelection.value)
  if (set.has(id)) {
    set.delete(id)
  } else {
    set.add(id)
  }
  arrangeSelection.value = [...set]
}

function toggleAllArrange(event: Event) {
  const checked = (event.target as HTMLInputElement).checked
  const ids = rows.value.filter((row) => row.status === '待安排').map((row) => Number(row.id))
  arrangeSelection.value = checked
    ? [...new Set([...arrangeSelection.value, ...ids])]
    : arrangeSelection.value.filter((id) => !ids.includes(id))
}

function batchArrange() {
  const result = arrangeBatch(arrangeSelection.value)
  flash(result.ok, result.message)
  arrangeSelection.value = []
  reload()
}

function toggleAccept(id: number) {
  const set = new Set(acceptSelection.value)
  if (set.has(id)) {
    set.delete(id)
  } else {
    set.add(id)
  }
  acceptSelection.value = [...set]
}

function toggleAllTodo(event: Event) {
  const checked = (event.target as HTMLInputElement).checked
  const ids = board.value.acceptanceTodo.map((row) => Number(row.id))
  acceptSelection.value = checked
    ? [...new Set([...acceptSelection.value, ...ids])]
    : acceptSelection.value.filter((id) => !ids.includes(id))
}

function nextRequestKey(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }
  return `accept-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function batchAccept() {
  if (accepting.value) {
    return
  }
  accepting.value = true
  // 一次点击一把请求钥匙：重复提交（含按钮连击）只返回同一批次，不会形成两批。
  const key = nextRequestKey()
  const selected = [...acceptSelection.value]
  try {
    const result = acceptInBatch(selected, key)
    flash(result.ok, result.message)
    if (result.ok) {
      acceptSelection.value = []
    }
    reload()
  } finally {
    accepting.value = false
  }
}

onMounted(reload)
</script>

<style scoped>
.notice-box {
  background: #fff7ed;
  border: 1px solid #fdba74;
  border-radius: 8px;
  padding: 10px 12px;
  margin-bottom: 12px;
}
.notice-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 13px;
}
.notice-list {
  margin: 6px 0 0;
  padding-left: 18px;
  font-size: 12px;
  color: #9a3412;
}
.tabs {
  display: flex;
  gap: 8px;
  margin-bottom: 12px;
}
.tab-btn {
  border: 1px solid var(--border);
  background: #fff;
  border-radius: 6px 6px 0 0;
  padding: 8px 16px;
  cursor: pointer;
  font-size: 13px;
}
.tab-btn.active {
  background: var(--brand);
  border-color: var(--brand);
  color: #fff;
}
.tab-badge {
  background: #b42318;
  color: #fff;
  border-radius: 999px;
  padding: 0 7px;
  font-size: 11px;
  margin-left: 4px;
}
.check-col {
  width: 36px;
  text-align: center;
}
.section-title {
  font-size: 14px;
  margin: 16px 0 8px;
}
.batch-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 10px 0;
}
.batch-tip {
  font-size: 12px;
  color: var(--muted);
}
.ok-text {
  color: #067647;
}
.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
