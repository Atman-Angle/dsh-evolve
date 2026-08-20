/**
 * STRATEGY_RESET intervention: build the model-visible reset message using the
 * official `plugin` message source, exactly like DSH's own goal wrap-up and
 * repeat-tool-reminder plugins.
 *
 * The message is constructed structurally (id + content + plugin source) so
 * the plugin has NO runtime dependency on any `@deepseek-ai/*` package — those
 * are type-only peers supplied by the DSH installation. This keeps the plugin
 * installable into any DSH profile without a private registry.
 *
 * @module dsh-evolve/intervention/strategy-reset
 */

import { randomUUID } from 'node:crypto'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { DEFAULT_RESET_TEMPLATE } from '../policy/recipe.js'

/**
 * Build the strategy-reset message.
 * @param template - message text; defaults to the recipe template.
 * @returns a user message carrying the `dsh-evolve` plugin source.
 */
export function buildStrategyResetMessage(template: string = DEFAULT_RESET_TEMPLATE): UserMessage {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: template }],
    source: {
      kind: 'plugin',
      plugin: 'dsh-evolve',
      form: 'notice',
      summary: 'strategy reset: stuck trajectory detected',
    },
  } as unknown as UserMessage
}