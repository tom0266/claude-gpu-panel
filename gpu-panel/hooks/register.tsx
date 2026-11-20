import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Agents, Detail, Gpu, GpuDetail, Job, Limit } from '../types'

// 한도 알림 임계치(%). 창이 초기화되면(resetsAt 이 바뀌면) 다시 알린다.
const THRESHOLD: Record<string, number> = { five_hour: 80, seven_day: 70 }
const LABEL: Record<string, string> = { five_hour: '5h', seven_day: '7d' }
const EFFORTS = ['low', 'medium', 'high', 'xhigh'] as const
const MODELS = ['fable', 'opus', 'sonnet'] as const
const NO_AGENTS: Agents = { running: 0, done: 0, failed: 0, models: '' }
const PANE = 'gpu-panel-detail'
const QUIET_STATUS = ['no active cases', 'waste≈0']

// 색은 여기서만 바꾼다(hex 또는 테마 키). 어두운 테마 기준.
const C = {
  border: '#4b5263',
  label: '#7f8798',
  ok: '#7ee787',
  warn: '#f2cc60',
  bad: '#ff7b72',
  chipBg: '#2d323d', // 선택 안 된 버튼
  chipFg: '#c9d1d9',
  effort: '#d19a66', // 선택된 effort
  model: '#61afef', // 현재 모델
  action: '#c678dd', // compact
  onColor: '#1b1f27', // 색 버튼 위 글자
}

const limits = atom({ plugin: 'gpu-panel', key: 'limits' } as const, [] as Limit[])
const contextPercent = atom({ plugin: 'gpu-panel', key: 'contextPercent' } as const, null as number | null)
const agents = atom({ plugin: 'gpu-panel', key: 'agents' } as const, NO_AGENTS)
const model = atom({ plugin: 'gpu-panel', key: 'model' } as const, '')
const effort = atom({ plugin: 'gpu-panel', key: 'effort' } as const, '')
const gpus = atom({ plugin: 'gpu-panel', key: 'gpus' } as const, null as Gpu[] | null)
const versions = atom({ plugin: 'gpu-panel', key: 'versions' } as const, {} as Record<string, string>)
const jobs = atom({ plugin: 'gpu-panel', key: 'jobs' } as const, 0)
const detail = atom({ plugin: 'gpu-panel', key: 'detail' } as const, { gpus: [], jobs: [] } as Detail)
const sessionName = atom({ plugin: 'gpu-panel', key: 'sessionName' } as const, '')
const warned = atom({ plugin: 'gpu-panel', key: 'warned' } as const, [] as string[])

const shortModel = (id?: string) =>
  ['fable', 'opus', 'sonnet', 'haiku'].find(k => (id ?? '').toLowerCase().includes(k)) ?? '?'

// 'claude-opus-5-5[1m]' → '5.5'. 날짜 접미사(8자리)는 버전으로 읽지 않는다.
const versionOf = (id?: string) => {
  const m = /(?:fable|opus|sonnet|haiku)-(\d{1,2})(?:-(\d{1,2}))?(?!\d)/.exec((id ?? '').toLowerCase())
  return m ? (m[2] ? `${m[1]}.${m[2]}` : m[1]!) : ''
}

const bar = (pct: number, cells = 8) => {
  const filled = Math.max(0, Math.min(cells, Math.round((pct / 100) * cells)))
  return ['━'.repeat(filled), '━'.repeat(cells - filled)] as const
}

const pctColor = (pct: number) => (pct >= 85 ? C.bad : pct >= 60 ? C.warn : C.ok)

function remaining(resetsAt: string | undefined, nowMs: number): string {
  const ms = resetsAt ? Date.parse(resetsAt) - nowMs : NaN
  if (!(ms > 0)) return ''
  const min = Math.floor(ms / 60000)
  if (min < 60) return `${min}m`
  const h = Math.floor(min / 60)
  return h < 24 ? `${h}h${String(min % 60).padStart(2, '0')}m` : `${Math.floor(h / 24)}d${h % 24}h`
}

async function refreshAgents($: EngineInterface) {
  const list = await $.agent.list()
  const running = list.filter(a => a.taskStatus === 'running' || a.taskStatus === 'pending')
  const counts: Record<string, number> = {}
  for (const a of running) counts[shortModel(a.model)] = (counts[shortModel(a.model)] ?? 0) + 1
  const next: Agents = {
    running: running.length,
    done: list.filter(a => a.taskStatus === 'completed').length,
    failed: list.filter(a => a.taskStatus === 'failed' || a.taskStatus === 'killed').length,
    models: Object.entries(counts).map(([m, n]) => `${m} ${n}`).join(', '),
  }
  const prev = await read($, agents)
  // 값이 같으면 쓰지 않는다(쓰면 band 가 다시 그려진다).
  if (JSON.stringify(prev) !== JSON.stringify(next)) await update($, agents, () => next)

  const id = await $.session.model()
  const m = shortModel(id)
  if ((await read($, model)) !== m) await update($, model, () => m)

  // 별칭이 어느 버전인지 알려 주는 API 가 없어, 실제로 본 모델 id 에서 배워 둔다(세션 간 저장).
  const known = await read($, versions)
  const seenNow: Record<string, string> = {}
  for (const mid of [id, ...list.map(a => a.model)]) {
    const v = versionOf(mid)
    if (v !== '' && known[shortModel(mid)] !== v) seenNow[shortModel(mid)] = v
  }
  if (Object.keys(seenNow).length > 0) {
    const merged = { ...known, ...seenNow }
    await update($, versions, () => merged)
    await $.store.set('versions', merged)
  }
}

// nvidia-smi 가 없는 기기(Mac)에서는 null 로 남아 GPU 칸이 그려지지 않는다.
async function refreshGpus($: EngineInterface) {
  const { exitCode, stdout } = await $.process.run(
    ['nvidia-smi', '--query-gpu=index,utilization.gpu,memory.used', '--format=csv,noheader,nounits'],
    { timeoutMs: 3000 },
  )
  if (exitCode !== 0) return
  const next: Gpu[] = stdout
    .trim()
    .split('\n')
    .map(line => line.split(',').map(v => Number(v.trim())))
    .filter(v => v.length === 3 && v.every(Number.isFinite))
    .map(([index = 0, util = 0, memMb = 0]) => ({ index, util, memGb: Math.floor(memMb / 1024) }))
  const prev = await read($, gpus)
  if (JSON.stringify(prev) !== JSON.stringify(next)) await update($, gpus, () => next)
}

// 내 프로세스 중 감시 패턴(~/.claude/statusline-jobs.txt, 한 줄에 하나)에 걸리는 명령줄 수.
// 예전 statusline.py 와 같은 규칙: 같은 명령줄은 한 번만 센다.
async function refreshJobs($: EngineInterface) {
  const home = (await $.env.get('HOME')) ?? ''
  const user = (await $.env.get('USER')) ?? ''
  const patterns = (await $.fs.read(`${home}/.claude/statusline-jobs.txt`))
    .split('\n')
    .map(l => l.trim())
    .filter(l => l !== '' && !l.startsWith('#'))
  if (patterns.length === 0 || user === '') return
  const { stdout } = await $.process.run(['ps', '-u', user, '-o', 'args='], { timeoutMs: 3000 })
  const seen = new Set(
    stdout.split('\n').filter(l => patterns.some(p => l.includes(p))).map(l => l.trim().slice(0, 160)),
  )
  if ((await read($, jobs)) !== seen.size) await update($, jobs, () => seen.size)
}

// 상세 pane 용: GPU 4장 전체(누가 쓰는지 포함)와 내 감시 대상 job 목록. pane 을 연 뒤에만 돈다.
async function refreshDetail($: EngineInterface) {
  const smi = (query: string, fields: string) =>
    $.process.run(['nvidia-smi', `--query-${query}=${fields}`, '--format=csv,noheader,nounits'], { timeoutMs: 3000 })
  const rows = (out: string) => out.trim().split('\n').filter(l => l !== '').map(l => l.split(',').map(v => v.trim()))

  const cards = rows((await smi('gpu', 'uuid,index,utilization.gpu,memory.used,memory.total,temperature.gpu')).stdout)
  const apps = rows((await smi('compute-apps', 'gpu_uuid,pid,used_memory')).stdout)
  const pids = apps.map(a => a[1] ?? '').filter(v => v !== '')
  const owner: Record<string, string> = {}
  if (pids.length > 0) {
    const { stdout } = await $.process.run(['ps', '-o', 'pid=,user=', '-p', pids.join(',')], { timeoutMs: 3000 })
    for (const line of stdout.split('\n')) {
      const [pid, user] = line.trim().split(/\s+/)
      if (pid && user) owner[pid] = user
    }
  }
  const gpuList: GpuDetail[] = cards.map(([uuid = '', index, util, used, total, temp]) => ({
    index: Number(index),
    util: Number(util),
    memGb: Math.round(Number(used) / 1024),
    totalGb: Math.round(Number(total) / 1024),
    temp: Number(temp),
    users: apps
      .filter(a => a[0] === uuid)
      .map(a => `${owner[a[1] ?? ''] ?? '?'} ${Math.round(Number(a[2]) / 1024)}G`)
      .join(', '),
  }))

  const home = (await $.env.get('HOME')) ?? ''
  const user = (await $.env.get('USER')) ?? ''
  const patterns = (await $.fs.read(`${home}/.claude/statusline-jobs.txt`))
    .split('\n')
    .map(l => l.trim())
    .filter(l => l !== '' && !l.startsWith('#'))
  const { stdout } = await $.process.run(['ps', '-u', user, '-o', 'pid=,etime=,args='], { timeoutMs: 3000 })
  const seen = new Set<string>()
  const jobList: Job[] = []
  for (const line of stdout.split('\n')) {
    const m = /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(line)
    if (!m || !patterns.some(p => m[3]!.includes(p)) || seen.has(m[3]!.slice(0, 160))) continue
    seen.add(m[3]!.slice(0, 160))
    jobList.push({ pid: m[1]!, elapsed: m[2]!, command: m[3]! })
  }

  const next: Detail = { gpus: gpuList, jobs: jobList }
  if (JSON.stringify(await read($, detail)) !== JSON.stringify(next)) await update($, detail, () => next)
}

// 누른 직후 바로 연다: 조회를 먼저 기다리면 "사람이 연 창"으로 취급되지 않아 좁은 화면에서 안 뜬다.
async function openDetail($: EngineInterface) {
  const opened = await $.ui.open({ id: PANE, title: 'GPU · jobs' })
  if (!opened.isPlaced) $.ui.toast(`GPU 창을 열지 못함: ${opened.reason}`)
  await refreshDetail($).catch(() => {})
}

// 세션 이름을 주는 API 가 없어 기록 파일에서 읽는다: /rename 한 이름이 우선, 없으면 자동 제목.
async function refreshName($: EngineInterface) {
  const { transcriptPath } = await $.session.info()
  const { stdout } = await $.process.run(
    ['grep', '-oE', '"(customTitle|aiTitle)":"[^"]*"', transcriptPath],
    { timeoutMs: 3000 },
  )
  const last = (key: string) => {
    const hit = stdout.split('\n').filter(l => l.startsWith(`"${key}"`)).pop()
    return hit ? hit.slice(key.length + 4, -1) : ''
  }
  const name = last('customTitle') || last('aiTitle')
  if (name && (await read($, sessionName)) !== name) await update($, sessionName, () => name)
}

async function seedEffort($: EngineInterface) {
  const level = (await $.process.hookEnv()).CLAUDE_EFFORT
  if (level && !(await read($, effort))) await update($, effort, () => level)
}

async function applyUsage(
  $: EngineInterface,
  usage: { rateLimits: Limit[]; context: { percent?: number } },
) {
  await update($, limits, () => usage.rateLimits.map(l => ({ ...l })))
  await update($, contextPercent, () => usage.context.percent ?? null)

  const seen = await read($, warned)
  for (const l of usage.rateLimits) {
    const at = THRESHOLD[l.kind]
    const id = `${l.kind}@${l.resetsAt ?? ''}`
    if (at === undefined || l.percentUsed < at || seen.includes(id)) continue
    $.ui.toast(`${LABEL[l.kind] ?? l.kind} 한도 ${l.percentUsed}% (임계치 ${at}%)`)
    await update($, warned, w => [...w.slice(-8), id])
  }
}

async function setEffort($: EngineInterface, level: string) {
  await $.command.run({ command: 'effort', args: level })
  await update($, effort, () => level)
}

async function setModel($: EngineInterface, name: string) {
  await $.command.run({ command: 'model', args: name })
  await refreshAgents($)
}

export const register: Register = on => {
  let timer: { cancel: () => void } | undefined
  let isDetailOpen = false

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await applyUsage($, await $.session.usage())
    await $.command.register({ name: 'gpu', description: 'GPU 4장 전체와 내 학습 job 목록을 옆 창으로 연다' })
    const stored = await $.store.get('versions')
    if (stored && typeof stored === 'object') await update($, versions, () => stored as Record<string, string>)
    await refreshAgents($)
    void refreshGpus($).catch(() => {})
    void refreshName($).catch(() => {})
    void refreshJobs($).catch(() => {})
    void seedEffort($).catch(() => {})
    timer?.cancel()
    let tick = 0
    timer = $.clock.every(5000, () => {
      void refreshAgents($).catch(() => {})
      if (++tick % 2 === 0) {
        void refreshGpus($).catch(() => {}) // GPU·job 은 10초마다
        void refreshJobs($).catch(() => {})
        if (isDetailOpen) void refreshDetail($).catch(() => {})
      }
      if (tick % 6 === 0) void refreshName($).catch(() => {}) // 이름은 30초마다
    })
    return result
  })

  on('command.run', { command: 'gpu' }, async $ => {
    isDetailOpen = true
    await openDetail($)
    return { text: 'GPU · jobs 창을 열었습니다.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const d = await read($, detail)
    const width = Math.max(20, (e.viewport?.columns ?? 60) - 22)
    return (
      <Box flexDirection="column">
        <Text bold color={C.model}>GPU</Text>
        {d.gpus.length === 0 && <Text color={C.label}>nvidia-smi 결과 없음</Text>}
        {d.gpus.map(g => {
          const [filled, empty] = bar(g.util, 8)
          return (
            <Box key={`g-${g.index}`} flexDirection="column">
              <Text>
                <Text bold>{g.index} </Text>
                <Text color={pctColor(g.util)}>{filled}</Text>
                <Text color={C.chipBg}>{empty}</Text>
                <Text color={pctColor(g.util)}> {String(g.util).padStart(3)}%</Text>
                <Text color={C.label}> {String(g.memGb).padStart(2)}/{g.totalGb}G {g.temp}°C</Text>
              </Text>
              <Text color={g.users === '' ? C.ok : C.chipFg} wrap="truncate-end">  {g.users === '' ? 'free' : g.users}</Text>
            </Box>
          )
        })}
        <Box marginTop={1}>
          <Text bold color={C.model}>Jobs</Text>
        </Box>
        {d.jobs.length === 0 && <Text color={C.label}>감시 대상 job 없음</Text>}
        {d.jobs.map(j => (
          <Text key={`j-${j.pid}`} wrap="truncate-end">
            <Text color={C.label}>{j.pid} </Text>
            <Text color={C.effort}>{j.elapsed} </Text>
            {j.command.slice(0, width)}
          </Text>
        ))}
      </Box>
    )
  })

  // /effort 를 직접 입력해 바꿔도 강조가 따라가게 한다.
  on('command.run', { command: 'effort' }, async ($, e, next) => {
    const result = await next(e)
    const level = String(e.args ?? '').trim()
    if ((EFFORTS as readonly string[]).includes(level)) await update($, effort, () => level)
    return result
  }).catch(($, e, next) => next(e))

  // 다른 mod 의 상태 줄 중 "할 말 없음"에 해당하는 것은 지운다(실제 경고는 그대로 둔다).
  on('ui.status', ($, e, next) =>
    next(e.text !== undefined && QUIET_STATUS.some(q => e.text!.includes(q)) ? { ...e, text: undefined } : e),
  ).catch(($, e, next) => next(e))

  on('session.measure', async ($, e, next) => {
    await applyUsage($, e)
    return next(e)
  })

  // 서브에이전트 생성을 막는 자리이므로 여기서는 절대 실패를 내보내지 않는다.
  on('agent.spawn', async ($, e, next) => {
    const result = await next(e)
    void refreshAgents($).catch(() => {})
    return result
  }).catch(($, e, next) => next(e))

  // 프롬프트 아래 힌트 줄 자리: 엔진의 힌트 줄은 그대로 두고 그 밑에 패널을 붙인다.
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const hint = await next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    const now = await $.clock.now()
    const ls = await read($, limits)
    const ctx = await read($, contextPercent)
    const ag = await read($, agents)
    const gs = await read($, gpus)
    const currentModel = await read($, model)
    const currentEffort = await read($, effort)
    const name = await read($, sessionName)
    const jobCount = await read($, jobs)
    const vs = await read($, versions)
    // 110칸 미만이면 테두리·막대·라벨을 빼고 두 줄에 맞춘다.
    const isNarrow = (e.viewport?.columns ?? 120) < 110
    const nameMax = isNarrow ? 14 : 28

    // 연산 중이면 사용률, 메모리만 잡혀 있으면 용량(statusline.py 와 같은 규칙).
    const busy = (gs ?? []).filter(g => g.util >= 5 || g.memGb >= 1)

    const chip = (key: string, label: string, isOn: boolean, onColor: string, press: () => void) => (
      <Button key={key} plain onPress={press}>
        <Text bold={isOn} color={isOn ? C.onColor : C.chipFg} backgroundColor={isOn ? onColor : C.chipBg}>
          {` ${label} `}
        </Text>
      </Button>
    )

    return (
      <Box flexDirection="column">
        {hint}
      <Box flexDirection="column" borderStyle={isNarrow ? undefined : 'round'} borderColor={C.border} paddingX={isNarrow ? 2 : 1}>
        <Box flexWrap="wrap" columnGap={isNarrow ? 2 : 3}>
          {name !== '' && <Text bold color={C.action}>{name.length > nameMax ? `${name.slice(0, nameMax - 1)}…` : name}</Text>}
          {ls.filter(l => LABEL[l.kind]).map(l => {
            const [filled, empty] = isNarrow ? ['', ''] : bar(l.percentUsed, 8)
            return (
              <Text key={l.kind}>
                <Text color={C.label}>{LABEL[l.kind]} </Text>
                <Text color={pctColor(l.percentUsed)}>{filled}</Text>
                <Text color={C.chipBg}>{empty}</Text>
                <Text bold color={pctColor(l.percentUsed)}>{isNarrow ? '' : ' '}{Math.round(l.percentUsed)}%</Text>
                <Text color={C.label}> {remaining(l.resetsAt, now)}</Text>
              </Text>
            )
          })}
          {ctx !== null && (
            <Text>
              <Text color={C.label}>ctx </Text>
              <Text bold color={pctColor(ctx)}>{ctx}%</Text>
            </Text>
          )}
          {gs !== null && (
            <Button key="gpu" plain onPress={() => { isDetailOpen = true; void openDetail($).catch(() => {}) }}>
              <Text color={C.label}>gpu </Text>
              {busy.length === 0 ? (
                <Text color={C.ok}>free</Text>
              ) : (
                busy.map((g, i) => (
                  <Text key={`gpu-${g.index}`} color={g.util >= 5 ? pctColor(g.util) : C.label}>
                    {i > 0 ? ' ' : ''}
                    {g.index}:{g.util >= 5 ? `${g.util}%` : `${g.memGb}G`}
                  </Text>
                ))
              )}
            </Button>
          )}
          {jobCount > 0 && (
            <Text>
              <Text color={C.label}>job </Text>
              <Text bold color={C.model}>{jobCount}</Text>
            </Text>
          )}
          {(!isNarrow || ag.running + ag.failed > 0) && <Text>
            <Text color={C.label}>agents </Text>
            {ag.running > 0 ? (
              <Text bold color={C.ok}>{ag.running} running ({ag.models})</Text>
            ) : (
              <Text color={C.label}>idle</Text>
            )}
            {ag.done > 0 && <Text color={C.label}> · {ag.done} done</Text>}
            {ag.failed > 0 && <Text color={C.bad}> · {ag.failed} failed</Text>}
          </Text>}
        </Box>
        <Box flexWrap="wrap" columnGap={1}>
          {!isNarrow && <Text color={C.label}>effort</Text>}
          {EFFORTS.map(level =>
            chip(`effort-${level}`, isNarrow && level !== 'high' ? level.slice(0, 3) : level, level === currentEffort, C.effort, () =>
              void setEffort($, level).catch(() => {}),
            ),
          )}
          <Text color={C.border}>{isNarrow ? '│' : ' │ '}</Text>
          {!isNarrow && <Text color={C.label}>model</Text>}
          {MODELS.map(name =>
            chip(`model-${name}`, vs[name] ? `${name} ${vs[name]}` : name, name === currentModel, C.model, () => void setModel($, name).catch(() => {})),
          )}
          <Text color={C.border}>{isNarrow ? '│' : ' │ '}</Text>
          <Button key="compact" plain onPress={() => void $.session.compact()}>
            <Text bold color={C.onColor} backgroundColor={C.action}>{isNarrow ? ' ⟲ ' : ' ⟲ compact '}</Text>
          </Button>
        </Box>
      </Box>
      </Box>
    )
  })
}
