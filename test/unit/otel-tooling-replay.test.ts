import type { ReadableSpan } from '@opentelemetry/sdk-trace'
import { retry } from 'next-test-utils'
import type { TraceEvent } from '../../packages/next/src/trace/types'

// Replay is an ordering/bounded-storage algorithm. Keep its edge cases here;
// file compatibility and actual process lifecycle are covered by the e2e suites.
describe('tooling OTel replay', () => {
  const previousGate = process.env.NEXT_EXPERIMENTAL_OTEL_TOOLING
  // Use emitted package types; the root test TS project does not load the
  // framework's internal ambient declarations for the reporter's dependencies.
  let tracing: typeof import('next/dist/trace/trace')
  let recorder: typeof import('next/dist/server/lib/trace/local-span-recorder')
  let requestRecorder: typeof import('next/dist/server/lib/trace/request-span-recorder')
  let nextTracer: ReturnType<
    typeof import('next/dist/server/lib/trace/tracer').getTracer
  >
  let types: typeof import('next/dist/server/lib/trace/constants')
  let api: typeof import('@opentelemetry/api')
  let sdk: typeof import('@opentelemetry/sdk-trace')
  let backend: typeof import('../../packages/next/src/trace/otel')
  let reporting: typeof import('../../packages/next/src/trace/otel-reporting')
  let local: TraceEvent[]
  let exported: ReadableSpan[]

  beforeEach(() => {
    jest.resetModules()
    api = require('next/dist/compiled/@opentelemetry/api')
    api.trace.disable()
    local = []
    exported = []
    process.env.NEXT_EXPERIMENTAL_OTEL_TOOLING = '1'
    jest.doMock('../../packages/next/src/trace/report', () => ({
      reporter: { report: (event: TraceEvent) => local.push(event) },
    }))
    jest.doMock('../../packages/next/src/trace/otel-reporting', () => {
      const actual = jest.requireActual<typeof reporting>(
        '../../packages/next/src/trace/otel-reporting'
      )
      return {
        ...actual,
        startReporting: jest.fn(actual.startReporting),
        endReporting: jest.fn(actual.endReporting),
      }
    })
    sdk = require('@opentelemetry/sdk-trace')
    backend = require('../../packages/next/src/trace/otel')
    reporting = require('../../packages/next/src/trace/otel-reporting')
    tracing = require('../../packages/next/src/trace/trace')
    recorder = require('../../packages/next/src/server/lib/trace/local-span-recorder')
    requestRecorder = require('../../packages/next/src/server/lib/trace/request-span-recorder')
    nextTracer =
      require('../../packages/next/src/server/lib/trace/tracer').getTracer()
    types = require('../../packages/next/src/server/lib/trace/constants')
  })

  afterEach(async () => {
    await backend.flushReporting()
    if (previousGate === undefined)
      delete process.env.NEXT_EXPERIMENTAL_OTEL_TOOLING
    else process.env.NEXT_EXPERIMENTAL_OTEL_TOOLING = previousGate
    jest.dontMock('../../packages/next/src/trace/report')
    jest.dontMock('../../packages/next/src/trace/otel-reporting')
    api.trace.disable()
    api.context.disable()
    jest.restoreAllMocks()
    jest.useRealTimers()
  })

  function installApplicationProvider(sample = true) {
    const provider = new sdk.TracerProvider({
      sampler: sample ? new sdk.AlwaysOnSampler() : new sdk.AlwaysOffSampler(),
      spanProcessors: [
        {
          onStart() {},
          onEnd(span) {
            exported.push(span)
          },
          async forceFlush() {},
          async shutdown() {},
        },
      ],
    })
    // Local recording must not register any provider of its own.
    expect(api.trace.setGlobalTracerProvider(provider)).toBe(true)
    return api.trace.getTracerProvider()
  }

  function span(
    id: number,
    parentId?: number,
    reportingParent?: import('@opentelemetry/api').Span
  ) {
    return nextTracer.startSpan(
      id === 1
        ? types.ToolingSpan.nextBuild
        : types.ToolingSpan.runWebpackCompiler,
      {
        spanName: `operation-${id}`,
        parent: reportingParent ?? parentId,
      }
    )
  }

  function stopSpan(state: import('@opentelemetry/api').Span, end?: bigint) {
    state.end(end === undefined ? undefined : tracing.toolingSpanTime(end))
  }

  it('keeps zero and detached coarse parents without a second source parent option', async () => {
    installApplicationProvider()
    tracing.initializeTraceState({
      lastId: 0,
      defaultParentSpanId: 77,
      shouldSaveTraceEvents: false,
    })
    nextTracer.trace(types.ToolingSpan.nextBuild, (root) => {
      nextTracer.trace(
        types.ToolingSpan.runWebpackCompiler,
        { parent: 0 },
        () => {}
      )
      nextTracer.trace(
        types.ToolingSpan.runWebpackCompiler,
        { parent: null },
        () => {}
      )
      nextTracer.trace(
        types.ToolingSpan.runWebpackCompiler,
        { parent: root },
        () => {}
      )
    })
    expect(local.map(({ id, parentId }) => ({ id, parentId }))).toEqual([
      { id: 2, parentId: 0 },
      { id: 3, parentId: undefined },
      { id: 4, parentId: 1 },
      { id: 1, parentId: 77 },
    ])
    backend.enableReporting()
    await backend.flushReporting()
    expect(exported).toHaveLength(4)
    expect(
      exported.find((entry) => entry.attributes['next.tooling.id'] === 2)
        ?.attributes['next.tooling.parent_id']
    ).toBe(0)
  })

  it('preserves original local timing, normalized tags, errors and idempotent end', async () => {
    installApplicationProvider()
    const start = process.hrtime.bigint()
    const tags = Object.fromEntries(
      Array.from({ length: 200 }, (_, i) => [`tag-${i}`, i])
    )
    const state = nextTracer.startSpan(types.ToolingSpan.runWebpackCompiler, {
      spanName: 'backdated',
      monotonicStartTime: start,
      wallStartTimeMs: 1_700_000_000_000,
      attributes: tags,
    })
    state.setAttributes(
      tracing.normalizeToolingAttributes({
        structured: {
          unicode: '世界',
          values: [1, 2],
        },
      })
    )
    state.setAttribute('failed', true)
    stopSpan(state, start + BigInt(543_000))
    stopSpan(state)
    backend.enableReporting()
    expect(local).toHaveLength(1)
    expect(local[0]).toMatchObject({
      id: 1,
      timestamp: Number(start / BigInt(1000)),
      duration: 543,
      startTime: 1_700_000_000_000,
    })
    expect(local[0].tags).toMatchObject({
      ...tags,
      failed: true,
      structured: '{"unicode":"世界","values":[1,2]}',
    })
    expect(exported).toHaveLength(0)
    await backend.flushReporting()
    expect(exported).toHaveLength(1)
    expect(exported[0].status.code).toBe(api.SpanStatusCode.ERROR)
    expect(exported[0].duration).toEqual([0, 543_000])
    expect(exported[0].attributes['next.tooling.id']).toBe(1)
  })

  it('joins early, live and later children to the same ended startup parent without changing active context', async () => {
    const root = span(1)
    backend.configureState(1, false)
    const early = span(2, 1, root)
    stopSpan(early)
    const provider = installApplicationProvider()
    const contextManager = new sdk.StackContextManager()
    api.context.setGlobalContextManager(contextManager)
    const key = api.createContextKey('tooling-replay-test')
    const context = api.ROOT_CONTEXT.setValue(key, 'application')
    api.context.with(context, () => {
      backend.enableReporting()
      backend.enableReporting()
      stopSpan(root)
      stopSpan(span(3, 1, root))
      stopSpan(span(4, 1))
      expect(api.context.active().getValue(key)).toBe('application')
      expect(api.trace.getTracerProvider()).toBe(provider)
    })
    await backend.flushReporting()
    expect(exported).toHaveLength(4)
    const parent = exported.find((entry) => entry.name === 'operation-1')!
    for (const child of exported.filter((entry) => entry !== parent)) {
      expect(child.parentSpanContext?.spanId).toBe(parent.spanContext().spanId)
    }
  })

  it('preserves the original numeric parent while falling back to the known reporting root', async () => {
    const root = span(1)
    backend.configureState(1, false)
    stopSpan(span(2, 1, root))
    installApplicationProvider()
    backend.enableReporting()
    stopSpan(root)
    await retry(() => expect(exported).toHaveLength(2))
    stopSpan(span(3, 2))
    await backend.flushReporting()
    const parent = exported.find((entry) => entry.name === 'operation-1')!
    const later = exported.find((entry) => entry.name === 'operation-3')!
    expect(later.parentSpanContext?.spanId).toBe(parent.spanContext().spanId)
    expect(later.attributes['next.tooling.parent_id']).toBe(2)
    expect(local.find((entry) => entry.id === 3)?.parentId).toBe(2)
  })

  it('retains local records when the application sampler drops every span', async () => {
    installApplicationProvider(false)
    backend.enableReporting()
    stopSpan(span(1))
    expect(local).toHaveLength(1)
    await backend.flushReporting()
    expect(exported).toHaveLength(0)
  })

  it('imports every local worker record but replays only explicit coarse selections and their nearest coarse parents', async () => {
    const root = span(1)
    const timestamp = Number(process.hrtime.bigint() / BigInt(1000))
    const records: TraceEvent[] = [
      { id: 5, parentId: 4, name: 'worker-fine', timestamp, duration: 2 },
      {
        id: 4,
        parentId: 3,
        name: 'worker-compiler-phase',
        timestamp,
        duration: 10,
      },
      {
        id: 3,
        parentId: 2,
        name: 'worker-fine-ancestor',
        timestamp,
        duration: 5,
      },
      {
        id: 2,
        parentId: 1,
        name: 'worker-coarse-root',
        timestamp,
        duration: 20,
      },
      { id: 6, parentId: 1, name: 'unmarked-native', timestamp, duration: 1 },
    ]
    const selections = [
      { id: 2, parentId: 1 },
      { id: 4, parentId: 2 },
    ]
    tracing.recordTraceEvents(records, selections)
    tracing.recordTraceEvents(records, selections)
    root.end()
    expect(local).toHaveLength(6)
    expect(local.find((event) => event.id === 4)?.parentId).toBe(3)
    installApplicationProvider()
    backend.enableReporting()
    await backend.flushReporting()
    expect(exported).toHaveLength(3)
    const worker = exported.find(
      (entry) => entry.name === 'worker-coarse-root'
    )!
    const phase = exported.find(
      (entry) => entry.name === 'worker-compiler-phase'
    )!
    expect(phase.parentSpanContext?.spanId).toBe(worker.spanContext().spanId)
    expect(phase.attributes['next.tooling.parent_id']).toBe(3)
    expect(phase.duration).toEqual([0, 10_000])
    expect(worker.duration).toEqual([0, 20_000])
  })

  it('transports selected worker identity through fine ancestors without worker SDK work or file schema changes', async () => {
    tracing.initializeTraceState({
      lastId: 10,
      defaultParentSpanId: 1,
      shouldSaveTraceEvents: true,
    })
    installApplicationProvider()
    const worker = nextTracer.startSpan(types.ToolingSpan.workerMain, {
      spanName: 'worker-main-server',
    })
    const fine = recorder.createLocalSpan({
      name: 'worker-fine-parent',
      parent: worker,
    })
    nextTracer
      .startSpan(types.ToolingSpan.runWebpackCompiler, { parent: fine })
      .end()
    fine.end()
    worker.end()
    expect(tracing.exportTraceState().toolingSpanSelections).toEqual([
      { id: 11, parentId: 1 },
      { id: 13, parentId: 11 },
    ])
    expect(
      tracing.getTraceEvents().map(({ id, parentId }) => ({ id, parentId }))
    ).toEqual([
      { id: 13, parentId: 12 },
      { id: 12, parentId: 11 },
      { id: 11, parentId: 1 },
    ])
    for (const event of local) {
      expect(event).not.toHaveProperty('toolingSpanSelections')
      expect(event.tags).not.toHaveProperty('toolingSpanSelections')
    }
    backend.enableReporting()
    await backend.flushReporting()
    expect(exported).toHaveLength(0)
    tracing.clearTraceEvents()
    expect(tracing.exportTraceState().toolingSpanSelections).toEqual([])
  })

  it('replays completion-ordered worker records once under the live coordinator root', async () => {
    const root = span(1)
    const timestamp = Number(process.hrtime.bigint() / BigInt(1000))
    const records: TraceEvent[] = [
      { id: 3, parentId: 2, name: 'worker-leaf', timestamp, duration: 10 },
      { id: 2, parentId: 1, name: 'worker-parent', timestamp, duration: 20 },
    ]
    backend.replayWorkerEvents(backend.freshWorkerEvents(records), records)
    expect(backend.freshWorkerEvents(records)).toEqual([])
    installApplicationProvider()
    backend.enableReporting()
    stopSpan(root)
    expect(exported).toHaveLength(0)
    await backend.flushReporting()
    expect(exported).toHaveLength(3)
    const parent = exported.find((entry) => entry.name === 'worker-parent')!
    const leaf = exported.find((entry) => entry.name === 'worker-leaf')!
    const coordinator = exported.find((entry) => entry.name === 'operation-1')!
    expect(parent.parentSpanContext?.spanId).toBe(
      coordinator.spanContext().spanId
    )
    expect(leaf.parentSpanContext?.spanId).toBe(parent.spanContext().spanId)
  })

  it('bounds event-count replay, warns once, and never drops local diagnostics', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
    for (let id = 1; id <= reporting.REPLAY_EVENT_LIMIT + 2; id++)
      stopSpan(span(id))
    installApplicationProvider()
    backend.enableReporting()
    expect(local).toHaveLength(reporting.REPLAY_EVENT_LIMIT + 2)
    await backend.flushReporting()
    expect(exported).toHaveLength(reporting.REPLAY_EVENT_LIMIT)
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('bounds retained data size independently of event count', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
    stopSpan(span(1))
    const state = nextTracer.startSpan(types.ToolingSpan.runWebpackCompiler, {
      spanName: 'oversized',
      attributes: { large: 'x'.repeat(reporting.REPLAY_BYTE_LIMIT) },
    })
    stopSpan(state)
    installApplicationProvider()
    backend.enableReporting()
    expect(local).toHaveLength(2)
    expect(local[1].tags!.large).toHaveLength(reporting.REPLAY_BYTE_LIMIT)
    await backend.flushReporting()
    expect(exported).toHaveLength(2)
    expect(
      exported.find((entry) => entry.name === 'oversized')!.attributes.large
    ).toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('does not export separately from compiler workers', async () => {
    backend.configureState(1, true)
    installApplicationProvider()
    stopSpan(span(2, 1))
    backend.enableReporting()
    expect(local).toHaveLength(1)
    await backend.flushReporting()
    expect(exported).toHaveLength(0)
  })

  it('does not let a root marker override compiler-worker suppression', async () => {
    backend.configureState(1, true)
    installApplicationProvider()
    const hook = jest.fn()
    const root = nextTracer.startSpan(types.ToolingSpan.nextBuild, {
      spanName: 'worker root',
    })
    root.end()
    backend.enableReporting(hook)
    await backend.flushReporting()
    expect(local).toHaveLength(1)
    expect(exported).toHaveLength(0)
    expect(hook).not.toHaveBeenCalled()
  })

  it('mirrors coarse Next tracer spans into files and the application Next tracer backend', async () => {
    installApplicationProvider()
    const { getTracer } =
      require('../../packages/next/src/server/lib/trace/tracer') as typeof import('next/dist/server/lib/trace/tracer')
    const { ToolingSpan } =
      require('../../packages/next/src/server/lib/trace/constants') as typeof import('next/dist/server/lib/trace/constants')
    const state = getTracer().startSpan(ToolingSpan.runTurbopack, {
      attributes: { 'next.route': '/coarse' },
    })
    expect(state).toBeInstanceOf(recorder.LocalRecordingSpan)
    state.end()
    state.end()
    expect(local).toHaveLength(1)
    expect(local[0]).toMatchObject({
      name: 'run-turbopack',
      tags: { 'next.route': '/coarse' },
    })
    backend.enableReporting()
    await backend.flushReporting()
    expect(exported).toHaveLength(1)
    expect(exported[0].instrumentationScope.name).toBe('next.js')
    expect(exported[0].attributes['next.tooling.id']).toBe(local[0].id)
  })

  it.each([
    ['build', '0'],
    ['build', '1'],
    ['dev', '0'],
    ['dev', '1'],
  ])(
    'exposes coarse active scope without changing request parenting in %s mode with gate %s',
    async (mode, gate) => {
      const previousDev = process.env.__NEXT_DEV_SERVER
      const store =
        require('../../packages/next/src/server/lib/trace/span-store') as typeof import('next/dist/server/lib/trace/span-store')
      const requestRecords: import('next/dist/server/lib/trace/span-store').SpanStoreRecord[] =
        []
      try {
        if (mode === 'dev') {
          process.env.__NEXT_DEV_SERVER = '1'
          requestRecorder.registerLocalSpanRecorder()
          store.setSpanRecorderForTest((record) => requestRecords.push(record))
        } else {
          delete process.env.__NEXT_DEV_SERVER
        }
        process.env.NEXT_EXPERIMENTAL_OTEL_TOOLING = gate
        installApplicationProvider()
        api.context.setGlobalContextManager(new sdk.StackContextManager())
        const key = api.createContextKey('active-tooling-scope')
        const application = api.ROOT_CONTEXT.setValue(key, 'application')
        api.context.with(application, () => {
          nextTracer.trace(types.ToolingSpan.nextBuild, (coarse) => {
            expect(nextTracer.getActiveScopeSpan()).toBe(coarse)
            nextTracer.trace(types.ToolingSpan.runWebpackCompiler, (child) => {
              expect(nextTracer.getActiveScopeSpan()).toBe(child)
            })
            expect(nextTracer.getActiveScopeSpan()).toBe(coarse)
            nextTracer.trace(types.NodeSpan.runHandler, (request) => {
              expect(request).toBeDefined()
              expect(recorder.getToolingSpanSource(request!)).toBeUndefined()
              expect(nextTracer.getActiveScopeSpan()).toBe(request)
            })
            const request = nextTracer.startSpan(types.NodeSpan.runHandler)
            expect(recorder.getToolingSpanSource(request)).toBeUndefined()
            nextTracer.withSpan(request, () =>
              expect(nextTracer.getActiveScopeSpan()).toBe(request)
            )
            request.end()
            expect(nextTracer.getActiveScopeSpan()).toBe(coarse)
          })
          expect(api.context.active()).toBe(application)
          expect(nextTracer.getActiveScopeSpan()).toBeUndefined()
        })
        backend.enableReporting()
        await backend.flushReporting()
        expect(local).toHaveLength(2)
        expect(
          local.find((entry) => entry.name === 'run-webpack-compiler')?.parentId
        ).toBe(local.find((entry) => entry.name === 'next-build')!.id)
        const requests = exported.filter(
          (entry) => entry.name === types.NodeSpan.runHandler
        )
        expect(requests).toHaveLength(2)
        for (const request of requests) {
          expect(request.parentSpanContext).toBeUndefined()
          expect(request.attributes['next.tooling.id']).toBeUndefined()
        }
        expect(exported).toHaveLength(gate === '1' ? 4 : 2)
        expect(requestRecords).toHaveLength(mode === 'dev' ? 2 : 0)
      } finally {
        store.setSpanRecorderForTest(undefined)
        if (previousDev === undefined) delete process.env.__NEXT_DEV_SERVER
        else process.env.__NEXT_DEV_SERVER = previousDev
      }
    }
  )

  it.each([
    ['build', '0'],
    ['build', '1'],
    ['dev', '0'],
    ['dev', '1'],
  ])(
    'uses the existing Next callback for setup and compilation in %s mode with gate %s',
    async (mode, gate) => {
      const previousDev = process.env.__NEXT_DEV_SERVER
      try {
        if (mode === 'dev') process.env.__NEXT_DEV_SERVER = '1'
        else delete process.env.__NEXT_DEV_SERVER
        process.env.NEXT_EXPERIMENTAL_OTEL_TOOLING = gate
        installApplicationProvider()
        api.context.setGlobalContextManager(new sdk.StackContextManager())
        const key = api.createContextKey('compiler-setup-scope')
        const application = api.ROOT_CONTEXT.setValue(key, 'application')
        const start = process.hrtime.bigint() - BigInt(5_000_000)
        let compiler: import('@opentelemetry/api').Span | undefined
        const pending = api.context.with(application, () => {
          const result = nextTracer.trace(
            types.ToolingSpan.runWebpackCompiler,
            {
              monotonicStartTime: start,
              wallStartTimeMs: 1_700_000_000_000,
            },
            async (span) => {
              compiler = span
              expect(nextTracer.getActiveScopeSpan()).toBe(span)
              expect(api.context.active().getValue(key)).toBeUndefined()
              await recorder.traceLocalSpan(
                { name: 'prepare-config', parent: span },
                () => 1
              )
              // The same coarse source owns children on both sides of setup.
              expect(nextTracer.getActiveScopeSpan()).toBe(span)
              await recorder.traceLocalSpan(
                { name: 'compile-module', parent: span },
                () => 2
              )
              return 'compiled'
            }
          )
          expect(api.context.active()).toBe(application)
          return result
        })
        expect(await pending).toBe('compiled')
        compiler!.end()
        expect(nextTracer.getActiveScopeSpan()).toBeUndefined()
        expect(local.map((event) => event.name)).toEqual([
          'prepare-config',
          'compile-module',
          'run-webpack-compiler',
        ])
        const completed = local[2]
        expect(completed).toMatchObject({
          id: recorder.getToolingSpanSource(compiler!)!.id,
          timestamp: Number(start / BigInt(1_000)),
          startTime: 1_700_000_000_000,
        })
        for (const child of local.slice(0, 2)) {
          expect(child.parentId).toBe(completed.id)
          expect(child.timestamp).toBeGreaterThanOrEqual(completed.timestamp)
          expect(child.timestamp + child.duration).toBeLessThanOrEqual(
            completed.timestamp + completed.duration
          )
        }

        for (const failureKind of ['sync', 'async']) {
          const failure = new Error(`${failureKind} config setup failure`)
          let caught: unknown
          try {
            await nextTracer.trace(
              types.ToolingSpan.runWebpackCompiler,
              { spanName: `${failureKind}-setup` },
              () => {
                if (failureKind === 'async') return Promise.reject(failure)
                throw failure
              }
            )
          } catch (error) {
            caught = error
          }
          expect(caught).toBe(failure)
          expect(nextTracer.getActiveScopeSpan()).toBeUndefined()
          expect(
            local.filter((event) => event.name === `${failureKind}-setup`)
          ).toEqual([
            expect.objectContaining({
              tags: expect.objectContaining({ failed: true }),
            }),
          ])
        }
        backend.enableReporting()
        await backend.flushReporting()
        expect(jest.mocked(reporting.startReporting)).toHaveBeenCalledTimes(
          gate === '1' ? 3 : 0
        )
        expect(jest.mocked(reporting.endReporting)).toHaveBeenCalledTimes(
          gate === '1' ? 3 : 0
        )
        expect(exported).toHaveLength(gate === '1' ? 3 : 0)
        for (const failure of exported.filter((entry) =>
          entry.name.endsWith('-setup')
        )) {
          expect(failure.status.code).toBe(api.SpanStatusCode.ERROR)
          expect(failure.attributes.failed).toBe(true)
        }
      } finally {
        if (previousDev === undefined) delete process.env.__NEXT_DEV_SERVER
        else process.env.__NEXT_DEV_SERVER = previousDev
      }
    }
  )

  it('keeps coarse files when the prototype is disabled despite an installed provider', async () => {
    installApplicationProvider()
    process.env.NEXT_EXPERIMENTAL_OTEL_TOOLING = '0'
    const result = nextTracer.trace(types.ToolingSpan.runTurbopack, () => 42)
    expect(result).toBe(42)
    expect(local.map((event) => event.name)).toEqual(['run-turbopack'])
    expect(jest.mocked(reporting.startReporting)).not.toHaveBeenCalled()
    expect(jest.mocked(reporting.endReporting)).not.toHaveBeenCalled()
    backend.enableReporting()
    await backend.flushReporting()
    expect(exported).toHaveLength(0)
  })

  it('parents coarse descendants through fine local work without promoting fine or request spans', async () => {
    installApplicationProvider()
    api.context.setGlobalContextManager(new sdk.StackContextManager())
    const key = api.createContextKey('coarse-scope-restoration')
    const applicationContext = api.ROOT_CONTEXT.setValue(key, 'application')
    const failure = new TypeError('original tooling failure')
    api.context.with(applicationContext, () => {
      expect(() =>
        nextTracer.trace(types.ToolingSpan.nextBuild, (root) => {
          expect(api.context.active().getValue(key)).toBeUndefined()
          const fine = recorder.createLocalSpan({
            name: 'fine-transform',
            parent: root,
          })
          expect(
            nextTracer.trace(
              types.ToolingSpan.runWebpackCompiler,
              { parent: fine },
              () => 7
            )
          ).toBe(7)
          expect(recorder.getLocalParentSpan(undefined)).toBeUndefined()
          requestRecorder.traceRequestSpan(
            { name: 'request-local', synchronous: true },
            (request) => {
              expect(recorder.getToolingSpanSource(request)).toBeUndefined()
              expect(request.spanContext().traceId).not.toBe(
                root!.spanContext().traceId
              )
            }
          )
          fine.end()
          throw failure
        })
      ).toThrow(failure)
      expect(api.context.active()).toBe(applicationContext)
    })
    expect(
      local.map(({ name, id, parentId }) => ({ name, id, parentId }))
    ).toEqual([
      { name: 'run-webpack-compiler', id: 3, parentId: 2 },
      { name: 'fine-transform', id: 2, parentId: 1 },
      { name: 'next-build', id: 1, parentId: undefined },
    ])
    expect(local[2].tags!.failed).toBe(true)
    expect(jest.mocked(reporting.startReporting)).toHaveBeenCalledTimes(2)
    expect(jest.mocked(reporting.endReporting)).toHaveBeenCalledTimes(2)
    backend.enableReporting()
    await backend.flushReporting()
    expect(exported).toHaveLength(2)
    const root = exported.find((entry) => entry.name === 'next-build')!
    const child = exported.find(
      (entry) => entry.name === 'run-webpack-compiler'
    )!
    expect(child.parentSpanContext?.spanId).toBe(root.spanContext().spanId)
    expect(child.attributes['next.tooling.parent_id']).toBe(2)
    expect(root.status.code).toBe(api.SpanStatusCode.ERROR)
  })

  it('reuses coarse callback and precreated wrap lifecycles for asynchronous results and errors', async () => {
    installApplicationProvider()
    const result = { value: 42 }
    const wrapped = nextTracer.wrap(
      types.ToolingSpan.runTurbopack,
      async () => result
    )
    await expect(wrapped()).resolves.toBe(result)
    const failure = new Error('async tooling failure')
    await expect(
      nextTracer.trace(types.ToolingSpan.runWebpackCompiler, async () => {
        throw failure
      })
    ).rejects.toBe(failure)
    expect(local).toHaveLength(2)
    expect(local[1].tags!.failed).toBe(true)
    backend.enableReporting()
    await backend.flushReporting()
    expect(exported).toHaveLength(2)
    expect(
      exported.find((entry) => entry.name === 'run-webpack-compiler')!.status
        .code
    ).toBe(api.SpanStatusCode.ERROR)
  })

  it('keeps high-volume fine helpers and imported observations out of the SDK lane', async () => {
    installApplicationProvider()
    const starts = jest.mocked(reporting.startReporting)
    const terminals = jest.mocked(reporting.endReporting)
    const { recordSpans } =
      require('../../packages/next/src/server/lib/trace/span-store') as typeof import('next/dist/server/lib/trace/span-store')
    for (let index = 0; index < 1000; index++) {
      expect(
        recorder.traceLocalSpan(
          { name: 'fine-transform', synchronous: true },
          () => index
        )
      ).toBe(index)
    }
    recordSpans(
      [{ name: 'native-observation', attributes: { detail: { kept: true } } }],
      'tooling',
      undefined
    )
    tracing.recordTraceEvents([
      { id: 10_000, name: 'worker-local', timestamp: 100, duration: 10 },
    ])
    expect(local).toHaveLength(1002)
    expect(starts).not.toHaveBeenCalled()
    expect(terminals).not.toHaveBeenCalled()
    backend.enableReporting()
    await backend.flushReporting()
    expect(exported).toHaveLength(0)
  })

  it('defers coarse replay SDK work and progresses before root completion', async () => {
    const starts = jest.fn()
    const ends = jest.fn()
    const samples = jest.fn(() => ({
      decision: sdk.SamplingDecision.RECORD_AND_SAMPLED,
    }))
    const provider = new sdk.TracerProvider({
      sampler: { shouldSample: samples, toString: () => 'application' },
      spanProcessors: [
        {
          onStart: starts,
          onEnd: ends,
          async forceFlush() {},
          async shutdown() {},
        },
      ],
    })
    api.trace.setGlobalTracerProvider(provider)
    const getTracer = jest.spyOn(api.trace, 'getTracer')
    const root = span(1)
    backend.configureState(1, false)
    backend.enableReporting()
    const child = nextTracer.startSpan(types.ToolingSpan.runWebpackCompiler, {
      spanName: 'child',
      parent: root,
      attributes: { initial: true },
    })
    child.setAttribute('final', 'value')
    child.end()
    backend.replayWorkerEvents(
      [{ id: 20, parentId: 1, name: 'worker', timestamp: 10, duration: 5 }],
      [{ id: 20, parentId: 1 }]
    )
    expect(getTracer).not.toHaveBeenCalled()
    expect(starts).not.toHaveBeenCalled()
    expect(ends).not.toHaveBeenCalled()
    expect(samples).not.toHaveBeenCalled()
    await retry(() => expect(ends).toHaveBeenCalledTimes(2))
    expect(starts).toHaveBeenCalledTimes(3)
    expect(ends).toHaveBeenCalledTimes(2)
    // The real unfinished root is open, not artificially ended to make progress.
    expect(local.map((event) => event.name)).toEqual(['child'])
    root.end()
    expect(ends).toHaveBeenCalledTimes(2)
    await backend.flushReporting()
    expect(ends).toHaveBeenCalledTimes(3)
  })

  it('samples completed records with final attributes but live ancestors with correlation only', async () => {
    const sampled = new Map<string, Record<string, unknown>>()
    const provider = new sdk.TracerProvider({
      sampler: {
        shouldSample(_context, _id, name, _kind, attrs) {
          sampled.set(name, { ...attrs })
          return { decision: sdk.SamplingDecision.RECORD_AND_SAMPLED }
        },
        toString: () => 'application',
      },
      spanProcessors: [
        {
          onStart() {},
          onEnd: (entry) => exported.push(entry),
          async forceFlush() {},
          async shutdown() {},
        },
      ],
    })
    api.trace.setGlobalTracerProvider(provider)
    const root = nextTracer.startSpan(types.ToolingSpan.nextBuild, {
      spanName: 'root',
      attributes: { initial: 'root' },
    })
    const nested = { value: 'original' }
    const child = nextTracer.startSpan(types.ToolingSpan.runWebpackCompiler, {
      spanName: 'completed',
      parent: root,
      attributes: { nested },
    })
    child.setAttribute('final', true)
    child.end()
    nested.value = 'mutated after completion'
    backend.enableReporting()
    await retry(() => expect(sampled.has('completed')).toBe(true))
    expect(sampled.get('root')).toEqual({ 'next.tooling.id': 1 })
    expect(sampled.get('completed')).toMatchObject({
      nested: '{"value":"original"}',
      final: true,
    })
    root.setAttribute('final', 'root')
    root.end()
    await backend.flushReporting()
    expect(
      exported.find((entry) => entry.name === 'root')!.attributes
    ).toMatchObject({ initial: 'root', final: 'root' })
    expect(sampled.get('root')).not.toHaveProperty('final')
  })

  it('keeps exact terminal metadata after oversized payload loss on an already started recorder', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
    installApplicationProvider()
    const start = process.hrtime.bigint()
    const state = nextTracer.startSpan(types.ToolingSpan.runWebpackCompiler, {
      spanName: 'loss',
      monotonicStartTime: start,
    })
    backend.enableReporting()
    await retry(() =>
      expect(
        recorder.getToolingSpanSource(state)!.reporting!.span
      ).toBeDefined()
    )
    state.setAttribute('payload', '🌏'.repeat(reporting.REPLAY_BYTE_LIMIT / 4))
    state.setAttribute('failed', true)
    state.end(tracing.toolingSpanTime(start + BigInt(777)))
    expect(exported).toHaveLength(0)
    await backend.flushReporting()
    expect(exported).toHaveLength(1)
    expect(exported[0].duration).toEqual([0, 777])
    expect(exported[0].status.code).toBe(api.SpanStatusCode.ERROR)
    expect(exported[0].attributes.payload).toBeUndefined()
    expect(local[0].tags!.payload).toBeDefined()
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('keeps adapter terminal metadata when a cyclic payload reaches the adapter directly', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
    installApplicationProvider()
    const start = BigInt(1_700_000_000_000_000_000)
    const record = reporting.startReporting(1, undefined, 'cyclic loss', start)
    backend.enableReporting()
    await retry(() => expect(record!.span).toBeDefined())
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    reporting.endReporting(record, start + BigInt(777), {
      payload: cyclic,
      failed: true,
    })
    expect(exported).toHaveLength(0)
    await backend.flushReporting()
    expect(exported).toHaveLength(1)
    expect(exported[0].duration).toEqual([0, 777])
    expect(exported[0].status.code).toBe(api.SpanStatusCode.ERROR)
    expect(exported[0].attributes.payload).toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('omits cyclic local tooling values without entering the adapter or declaring payload loss', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
    installApplicationProvider()
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    const state = recorder.createLocalSpan({
      name: 'normalized',
      attributes: { payload: cyclic, omitted: null, keep: true },
    })
    state.setAttributes(
      tracing.normalizeToolingAttributes({ later: cyclic, unset: undefined })
    )
    state.end()
    backend.enableReporting()
    await backend.flushReporting()
    expect(local[0].tags).toEqual({ keep: true })
    expect(exported).toHaveLength(0)
    expect(jest.mocked(reporting.startReporting)).not.toHaveBeenCalled()
    expect(jest.mocked(reporting.endReporting)).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
  })

  it('releases heavy descriptor references but preserves direct late-parent context', async () => {
    installApplicationProvider()
    const root = span(1)
    const parent = nextTracer.startSpan(types.ToolingSpan.runWebpackCompiler, {
      spanName: 'parent',
      parent: root,
    })
    // Inspect the source's adapter handle, not SDK private state.
    const handle = recorder.getToolingSpanSource(parent)!.reporting!
    parent.end()
    backend.enableReporting()
    await retry(() => expect(handle.retained).toBe(false))
    expect(handle).toMatchObject({ name: '', size: 0, retained: false })
    expect(handle.encoded).toBeUndefined()
    expect(handle.parent).toBeUndefined()
    expect(handle.span).toBeUndefined()
    expect(handle.context).toBeDefined()
    nextTracer
      .startSpan(types.ToolingSpan.runWebpackCompiler, {
        spanName: 'late',
        parent: parent,
      })
      .end()
    root.end()
    await backend.flushReporting()
    const late = exported.find((entry) => entry.name === 'late')!
    expect(late.parentSpanContext?.spanId).toBe(handle.context!.spanId)
  })

  it('reserves count and byte capacity for a root captured after ordinary starts', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
    const start = BigInt(1_700_000_000_000_000_000)
    const admitted = []
    for (let id = 1; id <= reporting.REPLAY_EVENT_LIMIT; id++) {
      const record = reporting.startReporting(id, undefined, 'ordinary', start)
      if (record) admitted.push(record)
    }
    expect(admitted).toHaveLength(reporting.REPLAY_EVENT_LIMIT - 1)
    const root = reporting.startReporting(
      20_000,
      undefined,
      'coordinator',
      start,
      undefined,
      true
    )!
    expect(root).toBeDefined()
    for (const record of admitted)
      reporting.endReporting(record, start + BigInt(1000), {})
    reporting.endReporting(root, start + BigInt(2000), {})
    installApplicationProvider()
    backend.enableReporting()
    await backend.flushReporting()
    expect(exported).toHaveLength(reporting.REPLAY_EVENT_LIMIT)
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('accounts UTF-16 metadata bytes independently and keeps the reserved root', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {})
    const start = BigInt(0)
    expect(
      reporting.startReporting(
        1,
        undefined,
        '界'.repeat(reporting.REPLAY_BYTE_LIMIT / 2),
        start
      )
    ).toBeUndefined()
    const root = reporting.startReporting(
      2,
      undefined,
      'root',
      start,
      undefined,
      true
    )
    expect(root).toBeDefined()
    reporting.endReporting(root, BigInt(1000), {})
    installApplicationProvider()
    backend.enableReporting()
    await backend.flushReporting()
    expect(exported).toHaveLength(1)
  })

  it('falls back to the real coordinator when a worker parent cannot be admitted', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {})
    const root = span(1)
    backend.replayWorkerEvents(
      [
        { id: 3, parentId: 2, name: 'leaf', timestamp: 100, duration: 11 },
        {
          id: 2,
          parentId: 1,
          name: '界'.repeat(reporting.REPLAY_BYTE_LIMIT / 2),
          timestamp: 90,
          duration: 30,
        },
      ],
      [
        { id: 3, parentId: 2 },
        { id: 2, parentId: 1 },
      ]
    )
    installApplicationProvider()
    backend.enableReporting()
    root.end()
    await backend.flushReporting()
    const parent = exported.find((entry) => entry.name === 'operation-1')!
    const leaf = exported.find((entry) => entry.name === 'leaf')!
    expect(exported).toHaveLength(2)
    expect(leaf.parentSpanContext?.spanId).toBe(parent.spanContext().spanId)
    expect(leaf.attributes['next.tooling.parent_id']).toBe(2)
    expect(leaf.duration).toEqual([0, 11_000])
    expect(leaf.startTime).toEqual([
      Number(backend.epochTime(BigInt(100_000)) / BigInt(1_000_000_000)),
      Number(backend.epochTime(BigInt(100_000)) % BigInt(1_000_000_000)),
    ])
  })

  it('drops unknown worker roots rather than fabricating a coordinator', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
    backend.replayWorkerEvents(
      [
        { id: 3, parentId: 2, name: 'orphan', timestamp: 1, duration: 1 },
        {
          id: 2,
          parentId: 1,
          name: 'unknown coordinator child',
          timestamp: 1,
          duration: 2,
        },
      ],
      [
        { id: 3, parentId: 2 },
        { id: 2, parentId: 1 },
      ]
    )
    installApplicationProvider()
    backend.enableReporting()
    await backend.flushReporting()
    expect(exported).toHaveLength(0)
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('iteratively resolves deep completion-ordered worker trees and breaks cycles nonfatally', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {})
    const root = span(1)
    const records = Array.from({ length: 4000 }, (_, index) => ({
      id: index + 2,
      parentId: index + 1,
      name: `deep-${index}`,
      timestamp: 1,
      duration: 2,
    })).reverse()
    backend.replayWorkerEvents(records, records)
    backend.replayWorkerEvents(
      [
        {
          id: 5000,
          parentId: 5001,
          name: 'cycle-a',
          timestamp: 1,
          duration: 2,
        },
        {
          id: 5001,
          parentId: 5000,
          name: 'cycle-b',
          timestamp: 1,
          duration: 2,
        },
      ],
      [
        { id: 5000, parentId: 5001 },
        { id: 5001, parentId: 5000 },
      ]
    )
    installApplicationProvider()
    backend.enableReporting()
    root.end()
    await backend.flushReporting()
    expect(exported).toHaveLength(4003)
    const byId = new Map(
      exported.map((entry) => [entry.attributes['next.tooling.id'], entry])
    )
    for (let id = 2; id <= 4001; id++) {
      expect(byId.get(id)!.parentSpanContext?.spanId).toBe(
        byId.get(id - 1)!.spanContext().spanId
      )
    }
  })

  it('captures completion even if the existing local reporter throws', async () => {
    const reporter = require('../../packages/next/src/trace/report').reporter
    jest.spyOn(reporter, 'report').mockImplementationOnce(() => {
      throw new Error('local writer failure')
    })
    installApplicationProvider()
    backend.enableReporting()
    const state = span(1)
    expect(() => state.end()).toThrow('local writer failure')
    await backend.flushReporting()
    expect(exported).toHaveLength(1)
  })

  it('has one yielding drain owner, prioritizes terminals and never spins on live spans', async () => {
    jest.useFakeTimers()
    installApplicationProvider()
    const root = span(1)
    for (let id = 2; id < 140; id++) span(id, 1, root)
    const terminal = nextTracer.startSpan(
      types.ToolingSpan.runWebpackCompiler,
      {
        spanName: 'terminal',
        parent: root,
      }
    )
    terminal.end()
    backend.enableReporting()
    backend.enableReporting()
    expect(jest.getTimerCount()).toBe(1)
    await jest.runOnlyPendingTimersAsync()
    expect(exported.map((entry) => entry.name)).toEqual(['terminal'])
    expect(jest.getTimerCount()).toBe(1)
    await jest.runAllTimersAsync()
    expect(jest.getTimerCount()).toBe(0)
    expect(exported).toHaveLength(1)
    root.end()
    const first = backend.flushReporting()
    expect(backend.flushReporting()).toBe(first)
    await jest.runAllTimersAsync()
    await first
    expect(exported).toHaveLength(2)
    expect(jest.getTimerCount()).toBe(0)
  })

  it('closes before the hook and rejects stale callbacks and captures until a new root', async () => {
    jest.useFakeTimers()
    installApplicationProvider()
    const old = span(1)
    old.end()
    const firstHook = jest.fn(() => {
      span(10).end()
    })
    backend.enableReporting(firstHook)
    const first = backend.flushReporting()
    await jest.runAllTimersAsync()
    await first
    expect(firstHook).toHaveBeenCalledTimes(1)
    expect(exported.map((entry) => entry.name)).toEqual(['operation-1'])
    span(11).end()
    const root = nextTracer.startSpan(types.ToolingSpan.nextBuild, {
      spanName: 'new generation',
    })
    backend.enableReporting()
    root.end()
    const second = backend.flushReporting()
    await jest.runAllTimersAsync()
    await second
    expect(exported.map((entry) => entry.name)).toEqual([
      'operation-1',
      'new generation',
    ])
    expect(firstHook).toHaveBeenCalledTimes(1)
    expect(jest.getTimerCount()).toBe(0)
  })

  it('cancels old queued work when a new root starts before a scheduled turn', async () => {
    jest.useFakeTimers()
    installApplicationProvider()
    span(1).end()
    const oldHook = jest.fn()
    backend.enableReporting(oldHook)
    const root = nextTracer.startSpan(types.ToolingSpan.nextBuild, {
      spanName: 'replacement',
    })
    root.end()
    backend.enableReporting()
    const flush = backend.flushReporting()
    await jest.runAllTimersAsync()
    await flush
    expect(oldHook).not.toHaveBeenCalled()
    expect(exported.map((entry) => entry.name)).toEqual(['replacement'])
  })

  it('uses separate cooperative drain and hook budgets and still calls the hook after drain loss', async () => {
    jest.useFakeTimers()
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
    const starts = jest.fn(() => {
      jest.advanceTimersByTime(reporting.FLUSH_TIMEOUT_MS + 1)
    })
    const provider = new sdk.TracerProvider({
      spanProcessors: [
        {
          onStart: starts,
          onEnd: (entry) => exported.push(entry),
          async forceFlush() {},
          async shutdown() {},
        },
      ],
    })
    api.trace.setGlobalTracerProvider(provider)
    const root = span(1)
    nextTracer
      .startSpan(types.ToolingSpan.runWebpackCompiler, {
        spanName: 'waiting',
        parent: root,
      })
      .end()
    const hook = jest.fn(() => new Promise<void>(() => {}))
    backend.enableReporting(hook)
    const flush = backend.flushReporting()
    await jest.runOnlyPendingTimersAsync()
    expect(starts).toHaveBeenCalledTimes(1)
    expect(exported).toHaveLength(0)
    expect(hook).toHaveBeenCalledTimes(1)
    await jest.advanceTimersByTimeAsync(reporting.FLUSH_TIMEOUT_MS)
    await flush
    expect(warn).toHaveBeenCalledTimes(2)
    expect(jest.getTimerCount()).toBe(0)
  })

  it.each(['missing', 'synchronous'])(
    'supports a %s cooperative hook',
    async (kind) => {
      const hook = jest.fn()
      backend.enableReporting(kind === 'missing' ? undefined : hook)
      await backend.flushReporting()
      expect(hook).toHaveBeenCalledTimes(kind === 'missing' ? 0 : 1)
    }
  )

  it('treats a rejecting flush hook as a nonfatal diagnostic', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
    backend.enableReporting(async () => {
      throw new Error('export failed')
    })
    await expect(backend.flushReporting()).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('bounds a hanging flush hook and clears its timeout', async () => {
    jest.useFakeTimers()
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
    backend.enableReporting(() => new Promise(() => {}))
    const flush = backend.flushReporting()
    await jest.advanceTimersByTimeAsync(reporting.FLUSH_TIMEOUT_MS)
    await expect(flush).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(jest.getTimerCount()).toBe(0)
  })
})
