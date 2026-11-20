import { expect, test } from 'claude-code/testing'

const BAND = {
  plugin: 'gpu-panel',
  component: 'PromptHint',
  surface: 'terminal',
  props: { isDraft: false, isWorking: false, hint: '? for shortcuts' },
} as const

const MEASURE = {
  context: { window: 1_000_000, tokens: 170_000, percent: 17 },
  changed: [] as never[],
  rateLimits: [
    { kind: 'five_hour', percentUsed: 82, resetsAt: '2026-11-19T12:00:00Z' },
    { kind: 'seven_day', percentUsed: 12, resetsAt: '2026-11-24T00:00:00Z' },
  ],
}

test('한도가 임계치를 넘으면 한 번만 알리고, 패널에 한도·컨텍스트를 그린다', async ($, on) => {
  const toasts: string[] = []
  on('ui.toast', (_, e) => {
    toasts.push(typeof e === 'string' ? e : JSON.stringify(e))
    return { value: undefined }
  })
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('clock.now', () => ({ value: Date.parse('2026-11-19T09:00:00Z') }))

  await $.session.measure(MEASURE)
  await $.session.measure(MEASURE) // 같은 창에서 다시 측정돼도 알림은 한 번

  expect(toasts.length).toBe(1)
  expect(toasts[0]).toMatch(/5h 한도 82%/)

  const ui = await $.ui.mount(BAND)
  expect((await ui.find({ type: 'Text', text: /82%/ }))?.text).toMatch(/82%/)
  expect((await ui.find({ type: 'Text', text: /17%/ }))?.text).toMatch(/17%/)
  expect((await ui.find({ type: 'Text', text: /idle/ }))?.text).toMatch(/idle/)
  expect(await ui.find({ type: 'Button', key: 'compact' })).toBeTruthy()
  await ui.unmount()
})

test('임계치 아래에서는 알리지 않는다', async ($, on) => {
  const toasts: unknown[] = []
  on('ui.toast', (_, e) => {
    toasts.push(e)
    return { value: undefined }
  })
  on('session.measure', (_, e) => ({ changed: e.changed }))

  await $.session.measure({
    ...MEASURE,
    rateLimits: [{ kind: 'five_hour', percentUsed: 79.9, resetsAt: '2026-11-19T12:00:00Z' }],
  })

  expect(toasts.length).toBe(0)
})

test('좁은 화면에서는 테두리·막대 없이 줄여 그린다', async ($, on) => {
  on('clock.now', () => ({ value: Date.parse('2026-11-19T09:00:00Z') }))
  const ui = await $.ui.mount({ ...BAND, viewport: { columns: 70, rows: 40 } })
  expect((await ui.find({ type: 'Text', text: /^ med $/ }))?.text).toBe(' med ')
  expect(await ui.find({ type: 'Text', text: /idle/ })).toBeFalsy()
  await ui.unmount()
})
