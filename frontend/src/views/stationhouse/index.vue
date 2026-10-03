<template>
  <section class="page" data-module="stationhouse">
    <header class="page-head">
      <div>
        <h2>站房维护管理</h2>
        <p class="page-desc">维护站房维护记录，围绕记录编号、站点编号、维护类型、维护内容做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记站房维护记录</button>
        <button class="btn" type="button" @click="exportRows">导出站房维护清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
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
          <td :colspan="columns.length + 2" class="empty-state">暂无站房维护数据，可先登记站房维护记录</td>
        </tr>
      </tbody>
    </table>
    <p class="panel-hint">验收不在单条记录上操作：请在下方「验收待办」勾选后批量验收，费用随批次一次入账，整批要么一起生效、要么一起回退。</p>

    <section class="panel">
      <header class="panel-head">
        <h3>验收待办</h3>
        <span class="panel-desc">共 {{ todoRows.length }} 项「已完成」记录待验收，勾选后一次提交形成一批验收。</span>
      </header>
      <table class="data-table">
        <thead>
          <tr>
            <th>
              <input
                type="checkbox"
                :checked="allTodoSelected"
                :disabled="!todoRows.length"
                @change="toggleSelectAll"
              />
            </th>
            <th>记录编号</th>
            <th>站点编号</th>
            <th>维护类型</th>
            <th>维护日期</th>
            <th>费用支出</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in todoRows" :key="Number(row.id)">
            <td><input v-model="selectedIds" type="checkbox" :value="Number(row.id)" /></td>
            <td>{{ row['记录编号'] }}</td>
            <td>{{ row['站点编号'] }}</td>
            <td>{{ row['维护类型'] }}</td>
            <td>{{ row['维护日期'] }}</td>
            <td>{{ formatFee(row['费用支出']) }}</td>
          </tr>
          <tr v-if="!todoRows.length">
            <td colspan="6" class="empty-state">暂无待验收记录</td>
          </tr>
        </tbody>
      </table>
      <footer class="panel-foot">
        <span>已选 {{ selectedIds.length }} 项，费用合计 {{ selectedFeeTotal }} 元</span>
        <button class="btn primary" type="button" :disabled="!selectedIds.length || submitting" @click="submitBatch">
          {{ submitting ? '正在提交…' : '批量验收' }}
        </button>
      </footer>
    </section>

    <section class="panel">
      <header class="panel-head">
        <h3>维护批次</h3>
        <span class="panel-desc">每次批量验收生成一个批次，重复提交只保留第一批。</span>
      </header>
      <table class="data-table">
        <thead>
          <tr>
            <th>批次号</th>
            <th>验收日期</th>
            <th>验收人</th>
            <th>记录数</th>
            <th>费用合计</th>
            <th>验收记录</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="batch in batches" :key="String(batch['批次号'])">
            <td>{{ batch['批次号'] }}</td>
            <td>{{ batch['验收日期'] }}</td>
            <td>{{ batch['验收人'] }}</td>
            <td>{{ batch['记录数'] }}</td>
            <td>{{ formatFee(batch['费用合计']) }}</td>
            <td>{{ batchRecordLabels(batch) }}</td>
          </tr>
          <tr v-if="!batches.length">
            <td colspan="6" class="empty-state">暂无验收批次</td>
          </tr>
        </tbody>
      </table>
    </section>

    <section class="panel">
      <header class="panel-head">
        <h3>费用汇总</h3>
        <span class="panel-desc">按维护月份汇总已入账费用，与验收批次同源，验收成功即更新。</span>
      </header>
      <table class="data-table">
        <thead>
          <tr>
            <th>维护月份</th>
            <th>验收记录数</th>
            <th>费用合计（元）</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in feeSummary.rows" :key="row.月份">
            <td>{{ row.月份 }}</td>
            <td>{{ row.验收记录数 }}</td>
            <td>{{ row.费用合计.toFixed(2) }}</td>
          </tr>
          <tr v-if="!feeSummary.rows.length">
            <td colspan="3" class="empty-state">暂无已入账费用</td>
          </tr>
        </tbody>
        <tfoot v-if="feeSummary.rows.length">
          <tr>
            <td>合计</td>
            <td>{{ feeSummary.记录总数 }}</td>
            <td>{{ feeSummary.费用总计.toFixed(2) }}</td>
          </tr>
        </tfoot>
      </table>
    </section>

    <footer class="page-foot">
      <span>共 {{ total }} 条站房维护记录</span>
      <span v-if="noticeMessage" class="notice-text">{{ noticeMessage }}</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import {
  acceptBatch,
  ensureStationhouseConsistency,
  feeSummaryByMonth,
  listAcceptanceBatches,
  listAcceptanceTodo,
  newRequestId,
} from '@/api/stationhouse-service'
import type { FeeSummary } from '@/api/stationhouse-service'
import type { EntryRow } from '@/data/types'
import { useSessionStore } from '@/stores/session'

const meta = moduleMeta('stationhouse')
const columns = ["记录编号", "站点编号", "维护类型", "维护内容", "维护单位", "维护日期", "费用支出", "维护状态"]
const actions = ["安排维护", "确认完工"]
const statuses = ["待安排", "已安排", "施工中", "已完成", "已验收"]

const store = useSessionStore()

const rows = ref<EntryRow[]>([])
const labelRows = ref<EntryRow[]>([])
const todoRows = ref<EntryRow[]>([])
const batches = ref<EntryRow[]>([])
const feeSummary = ref<FeeSummary>({ rows: [], 记录总数: 0, 费用总计: 0 })
const total = ref(0)
const errorMessage = ref('')
const noticeMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const selectedIds = ref<number[]>([])
const requestId = ref(newRequestId())
const submitting = ref(false)

const now = new Date()
const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`

const stats = computed(() => [
  { label: '待维护项数', value: labelRows.value.filter((row) => String(row.status) === '待安排').length },
  { label: '施工中项数', value: labelRows.value.filter((row) => String(row.status) === '施工中').length },
  {
    label: '本月已验收',
    value: labelRows.value.filter(
      (row) =>
        String(row.status) === '已验收' &&
        String(row['验收日期'] ?? row['维护日期'] ?? '').startsWith(currentMonth),
    ).length,
  },
])

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

const allTodoSelected = computed(
  () =>
    todoRows.value.length > 0 &&
    todoRows.value.every((row) => selectedIds.value.includes(Number(row.id))),
)

const selectedFeeTotal = computed(() => {
  const chosen = new Set(selectedIds.value)
  const sum = todoRows.value
    .filter((row) => chosen.has(Number(row.id)))
    .reduce((totalFee, row) => totalFee + (Number(row['费用支出']) || 0), 0)
  return sum.toFixed(2)
})

// 勾选变化视为一次新的提交意图：换发提交标识，幂等防护只拦截同一批的重复点击/重试。
watch(selectedIds, () => {
  requestId.value = newRequestId()
})

function toggleSelectAll(event: Event) {
  const checked = (event.target as HTMLInputElement).checked
  selectedIds.value = checked ? todoRows.value.map((row) => Number(row.id)) : []
}

function formatFee(value: unknown): string {
  const num = Number(value)
  return Number.isFinite(num) ? num.toFixed(2) : '0.00'
}

function batchRecordLabels(batch: EntryRow): string {
  const labelById = new Map(labelRows.value.map((row) => [Number(row.id), String(row['记录编号'] ?? row.id)]))
  return String(batch['记录ids'] ?? '')
    .split(',')
    .map((item) => Number(item.trim()))
    .filter((id) => Number.isFinite(id) && id > 0)
    .map((id) => labelById.get(id) ?? `#${id}`)
    .join('、')
}

function resetFilters() {
  filters.value = {}
  errorMessage.value = ''
  noticeMessage.value = ''
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '站房维护记录登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  noticeMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function submitBatch() {
  if (submitting.value || selectedIds.value.length === 0) {
    return
  }
  submitting.value = true
  errorMessage.value = ''
  noticeMessage.value = ''
  try {
    const result = acceptBatch(selectedIds.value, requestId.value, store.operator)
    if (result.ok) {
      noticeMessage.value = result.message
      selectedIds.value = []
    } else {
      // 失败时保留勾选和提交标识：重试同一批仍是幂等的，不会形成第二批。
      errorMessage.value = result.message
    }
  } finally {
    submitting.value = false
    reload()
  }
}

function reload() {
  try {
    ensureStationhouseConsistency()
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    labelRows.value = listEntries(meta.key).items
    todoRows.value = listAcceptanceTodo()
    batches.value = listAcceptanceBatches()
    feeSummary.value = feeSummaryByMonth()
    const todoIds = new Set(todoRows.value.map((row) => Number(row.id)))
    selectedIds.value = selectedIds.value.filter((id) => todoIds.has(id))
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '站房维护列表读取失败'
  }
}

onMounted(reload)
</script>
