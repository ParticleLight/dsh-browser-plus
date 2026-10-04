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
import type { Context } from '@deepseek-ai/cordis';
export declare const name = "browser-command";
export declare const inject: string[];
/** Register the command. */
export declare function apply(ctx: Context, _config?: unknown): void;
