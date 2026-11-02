import { nextTestSetup } from 'e2e-utils'
import { retry } from 'next-test-utils'
import stripAnsi from 'strip-ansi'

// @force-gate dev
describe('server-stack-overflow-stack-frames', () => {
  const { next, skipped } = nextTestSetup({
    files: __dirname,
  })

  if (skipped) {
    return
  }

  async function getLoggedOverflowFrames(route: string): Promise<string[]> {
    const outputIndex = next.cliOutput.length

    await next.fetch(route)

    let lines: string[] = []

    await retry(async () => {
      lines = stripAnsi(next.cliOutput.slice(outputIndex)).split('\n')
      expect(
        lines.some((line) =>
          line.includes('RangeError: Maximum call stack size exceeded')
        )
      ).toBe(true)
    })

    const headerIndex = lines.findIndex((line) =>
      line.includes('RangeError: Maximum call stack size exceeded')
    )
    const frames: string[] = []

    for (const line of lines.slice(headerIndex + 1)) {
      if (!/^\s+at /.test(line)) {
        break
      }
      frames.push(line.trim())
    }

    return frames
  }

  it('logs a located frame when the overflow is thrown inside React', async () => {
    const frames = await getLoggedOverflowFrames('/react-internal-overflow')

    expect(frames[0]).toBe(
      'at Recursive (app/react-internal-overflow/page.tsx:2:10)'
    )
  })

  it('logs a located frame when the overflow is thrown in application code', async () => {
    const frames = await getLoggedOverflowFrames('/app-code-overflow')

    expect(frames[0]).toBe('at recurse (app/app-code-overflow/page.tsx:2:3)')
  })
})
