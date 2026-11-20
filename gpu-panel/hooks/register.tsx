import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Agents, Detail, Gpu, Limit } from '../types'
import {
  appPids, bar, countJobs, gpuDetails, isQuietStatus, listJobs, paletteOf, parseGpus, parseOwners, parsePatterns, pctColor,
  remaining, shortModel, stringsOf, thresholdsOf, versionOf,
} from './lib'
import type { Strings } from './lib'

const LABEL: Record<string, string> = { five_hour: '5h', seven_day: '7d' }
const EFFORTS = ['low', 'medium', 'high', 'xhigh'] as const
const MODELS = ['fable', 'opus', 'sonnet'] as const
const NO_AGENTS: Agents = { running: 0, done: 0, failed: 0, models: '' }
const PANE = 'gpu-panel-detail'

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
  // Skip the write when nothing changed (a write redraws the panel).
  if (JSON.stringify(prev) !== JSON.stringify(next)) await update($, agents, () => next)

  const id = await $.session.model()
  const m = shortModel(id)
  if ((await read($, model)) !== m) await update($, model, () => m)

  // No API says which version an alias means, so learn it from model ids actually seen (kept across sessions).
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

// On a machine without nvidia-smi (a Mac) this stays null and the GPU field is not drawn.
async function refreshGpus($: EngineInterface) {
  const { exitCode, stdout } = await $.process.run(
    ['nvidia-smi', '--query-gpu=index,utilization.gpu,memory.used', '--format=csv,noheader,nounits'],
    { timeoutMs: 3000 },
  )
  if (exitCode !== 0) return
  const next: Gpu[] = parseGpus(stdout)
  const prev = await read($, gpus)
  if (JSON.stringify(prev) !== JSON.stringify(next)) await update($, gpus, () => next)
}

// How many of my processes match a watch pattern (~/.claude/statusline-jobs.txt, one per line).
// Identical command lines are counted once.
async function refreshJobs($: EngineInterface) {
  const home = (await $.env.get('HOME')) ?? ''
  const user = (await $.env.get('USER')) ?? ''
  const patterns = parsePatterns(await $.fs.read(`${home}/.claude/statusline-jobs.txt`))
  if (patterns.length === 0 || user === '') return
  const { stdout } = await $.process.run(['ps', '-u', user, '-o', 'args='], { timeoutMs: 3000 })
  const count = countJobs(stdout, patterns)
  if ((await read($, jobs)) !== count) await update($, jobs, () => count)
}

// For the detail pane: every card (with who is on it) and my watched jobs. Runs only while the pane is open.
async function refreshDetail($: EngineInterface) {
  const smi = (query: string, fields: string) =>
    $.process.run(['nvidia-smi', `--query-${query}=${fields}`, '--format=csv,noheader,nounits'], { timeoutMs: 3000 })

  const cardsOut = (await smi('gpu', 'uuid,index,utilization.gpu,memory.used,memory.total,temperature.gpu')).stdout
  const appsOut = (await smi('compute-apps', 'gpu_uuid,pid,used_memory')).stdout
  const pids = appPids(appsOut)
  const owner =
    pids.length > 0
      ? parseOwners((await $.process.run(['ps', '-o', 'pid=,user=', '-p', pids.join(',')], { timeoutMs: 3000 })).stdout)
      : {}

  const home = (await $.env.get('HOME')) ?? ''
  const user = (await $.env.get('USER')) ?? ''
  const patterns = parsePatterns(await $.fs.read(`${home}/.claude/statusline-jobs.txt`))
  const { stdout } = await $.process.run(['ps', '-u', user, '-o', 'pid=,etime=,args='], { timeoutMs: 3000 })

  const next: Detail = { gpus: gpuDetails(cardsOut, appsOut, owner), jobs: listJobs(stdout, patterns) }
  if (JSON.stringify(await read($, detail)) !== JSON.stringify(next)) await update($, detail, () => next)
}

// Open first, query after: awaiting the query first loses the "opened by a person" allowance and the pane will not open in a narrow terminal.
async function openDetail($: EngineInterface, t: Strings) {
  const opened = await $.ui.open({ id: PANE, title: 'GPU · jobs' })
  if (!opened.isPlaced) $.ui.toast(t.paneFailed(opened.reason))
  await refreshDetail($).catch(() => {})
}

// No API gives the session name, so read it from the transcript: the /rename name first, else the generated title.
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
  thresholds: Record<string, number>,
  t: Strings,
) {
  await update($, limits, () => usage.rateLimits.map(l => ({ ...l })))
  await update($, contextPercent, () => usage.context.percent ?? null)

  const seen = await read($, warned)
  for (const l of usage.rateLimits) {
    const at = thresholds[l.kind]
    const id = `${l.kind}@${l.resetsAt ?? ''}`
    if (at === undefined || l.percentUsed < at || seen.includes(id)) continue
    $.ui.toast(t.usage(LABEL[l.kind] ?? l.kind, l.percentUsed, at))
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

export const register: Register = (on, options) => {
  // Options come from the manifest's userConfig; each has a default, so a plain install behaves as before
  // except that other mods' status lines are left alone unless hideQuietStatus is turned on.
  const C = paletteOf(options.palette)
  const t = stringsOf(options.language)
  const thresholds = thresholdsOf(options.fiveHourThreshold, options.sevenDayThreshold)
  let timer: { cancel: () => void } | undefined
  let isDetailOpen = false

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await applyUsage($, await $.session.usage(), thresholds, t)
    await $.command.register({ name: 'gpu', description: t.gpuCommand })
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
        void refreshGpus($).catch(() => {}) // GPUs and jobs every 10 s
        void refreshJobs($).catch(() => {})
        if (isDetailOpen) void refreshDetail($).catch(() => {})
      }
      if (tick % 6 === 0) void refreshName($).catch(() => {}) // session name every 30 s
    })
    return result
  })

  on('command.run', { command: 'gpu' }, async $ => {
    isDetailOpen = true
    await openDetail($, t)
    return { text: t.opened }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const d = await read($, detail)
    const width = Math.max(20, (e.viewport?.columns ?? 60) - 22)
    return (
      <Box flexDirection="column">
        <Text bold color={C.model}>GPU</Text>
        {d.gpus.length === 0 && <Text color={C.label}>{t.noGpus}</Text>}
        {d.gpus.map(g => {
          const [filled, empty] = bar(g.util, 8)
          return (
            <Box key={`g-${g.index}`} flexDirection="column">
              <Text>
                <Text bold>{g.index} </Text>
                <Text color={pctColor(C, g.util)}>{filled}</Text>
                <Text color={C.track}>{empty}</Text>
                <Text color={pctColor(C, g.util)}> {String(g.util).padStart(3)}%</Text>
                <Text color={C.label}> {String(g.memGb).padStart(2)}/{g.totalGb}G {g.temp}°C</Text>
              </Text>
              <Text color={g.users === '' ? C.ok : C.chipFg} wrap="truncate-end">  {g.users === '' ? 'free' : g.users}</Text>
            </Box>
          )
        })}
        <Box marginTop={1}>
          <Text bold color={C.model}>Jobs</Text>
        </Box>
        {d.jobs.length === 0 && <Text color={C.label}>{t.noJobs}</Text>}
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

  // Keep the highlight in step when /effort is typed by hand.
  on('command.run', { command: 'effort' }, async ($, e, next) => {
    const result = await next(e)
    const level = String(e.args ?? '').trim()
    if ((EFFORTS as readonly string[]).includes(level)) await update($, effort, () => level)
    return result
  }).catch(($, e, next) => next(e))

  // Opt-in: drop other mods' status lines that say nothing is wrong (real warnings stay).
  // Off by default, because it removes another mod's output.
  if (options.hideQuietStatus === true) {
    on('ui.status', ($, e, next) =>
      next(isQuietStatus(e.text) ? { ...e, text: undefined } : e),
    ).catch(($, e, next) => next(e))
  }

  on('session.measure', async ($, e, next) => {
    await applyUsage($, e, thresholds, t)
    return next(e)
  })

  // This hook can block a subagent from starting, so it must never let a failure out.
  on('agent.spawn', async ($, e, next) => {
    const result = await next(e)
    void refreshAgents($).catch(() => {})
    return result
  }).catch(($, e, next) => next(e))

  // The hint slot under the prompt: keep the engine's hint line and stack the panel below it.
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
    // Under 110 columns, drop the border, bars and labels and fit in two lines.
    const isNarrow = (e.viewport?.columns ?? 120) < 110
    const nameMax = isNarrow ? 14 : 28

    // Utilization when computing; memory when a card is only holding memory.
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
                <Text color={pctColor(C, l.percentUsed)}>{filled}</Text>
                <Text color={C.track}>{empty}</Text>
                <Text bold color={pctColor(C, l.percentUsed)}>{isNarrow ? '' : ' '}{Math.round(l.percentUsed)}%</Text>
                <Text color={C.label}> {remaining(l.resetsAt, now)}</Text>
              </Text>
            )
          })}
          {ctx !== null && (
            <Text>
              <Text color={C.label}>ctx </Text>
              <Text bold color={pctColor(C, ctx)}>{ctx}%</Text>
            </Text>
          )}
          {gs !== null && (
            <Button key="gpu" plain onPress={() => { isDetailOpen = true; void openDetail($, t).catch(() => {}) }}>
              <Text color={C.label}>gpu </Text>
              {busy.length === 0 ? (
                <Text color={C.ok}>free</Text>
              ) : (
                busy.map((g, i) => (
                  <Text key={`gpu-${g.index}`} color={g.util >= 5 ? pctColor(C, g.util) : C.label}>
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
