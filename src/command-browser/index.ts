/**
 * Human-facing `/browser` command: puts the shared browser window on screen
 * without going through the model.
 *
 * The window is normally created as a side effect of the first browser tool
 * call, so a human who wants to browse (or take over) before any agent call had
 * no way to raise it. `/browser` is that way in: it spawns the host and shows
 * the window when nothing is open, and raises the existing window otherwise.
 *
 * The command registry is declared structurally instead of imported from
 * `@deepseek-ai/dsh-commands`: the registry is a peer service the profile
 * provides, and depending on that package only for its types would make this
 * row fail to load wherever the service exists but the dependency does not.
 * @module dsh-browser-plus/command-browser
 */

import type { Context } from '@deepseek-ai/cordis'

/** The invocation the dispatcher hands a handler. */
interface CommandInvocation {
  /** Everything after the command name, verbatim. */
  readonly rawInput: string
}

/** What the dispatching UI renders for one settled execution. */
type CommandOutcome =
  | { readonly kind: 'success'; readonly text?: string }
  | { readonly kind: 'error'; readonly text: string }

/** One definition accepted by the registry. */
interface CommandDefinition {
  readonly name: string
  readonly description: string
  readonly handler: (invocation: CommandInvocation) => Promise<CommandOutcome> | CommandOutcome
}

/** The registry this plugin registers into, satisfied by `@deepseek-ai/dsh-commands`. */
interface CommandRegistry {
  register(definition: CommandDefinition): void
}

export const name = 'browser-command'
export const inject = ['browser', 'commands']

/** Register the command. */
export function apply(ctx: Context, _config: unknown = {}): void {
  const commands = (ctx as unknown as { readonly commands: CommandRegistry }).commands
  commands.register({
    name: 'browser',
    description: '打开并前置共享浏览器窗口',
    handler: async () => {
      try {
        await ctx.browser.ensureWindowVisible()
        return { kind: 'success', text: '浏览器窗口已打开。' }
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        return { kind: 'error', text: `打开浏览器窗口失败：${detail}` }
      }
    },
  })
}
