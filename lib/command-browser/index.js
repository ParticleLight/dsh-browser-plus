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
export const name = 'browser-command';
export const inject = ['browser', 'commands'];
/** Register the command. */
export function apply(ctx, _config = {}) {
    const commands = ctx.commands;
    commands.register({
        name: 'browser',
        description: '打开并前置共享浏览器窗口',
        handler: async () => {
            try {
                await ctx.browser.ensureWindowVisible();
                return { kind: 'success', text: '浏览器窗口已打开。' };
            }
            catch (error) {
                const detail = error instanceof Error ? error.message : String(error);
                return { kind: 'error', text: `打开浏览器窗口失败：${detail}` };
            }
        },
    });
}
