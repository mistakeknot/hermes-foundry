import { createElement } from 'react'
import { ThreadChat } from '@get-bb/plugin-sdk/app'
import { PlaceholderThread, type ThreadComponent, type ThreadProps } from './thread-port'

// The Foundry pane's thread area (mk-ps6ow.14.11): the selection chip and edit history with Undo on top, and bb's own
// chat for the one Foundry thread below. While the thread is being found or made, or if that failed, the placeholder
// alone is shown with a line saying so.

export type ChatState =
  | { status: 'loading' }
  | { status: 'ready'; projectId: string; threadId: string }
  | { status: 'error'; message: string }

const MUTED = { color: 'var(--muted-foreground)', fontSize: 12, padding: '0 10px 8px' }

/** A thread component for the pane. Its identity changes only when the chat state does, which remounts this area alone. */
export function chatThreadFor(chat: ChatState): ThreadComponent {
  const ChatArea: ThreadComponent = (props: ThreadProps) => {
    const top = createElement(PlaceholderThread, props)
    if (chat.status !== 'ready') {
      return createElement('div', { 'data-foundry': 'chat-area', style: { display: 'flex', flexDirection: 'column', flex: '1 1 0%', minHeight: 0 } },
        top,
        createElement('div', { 'data-foundry': 'chat-status', role: chat.status === 'error' ? 'alert' : undefined, style: MUTED },
          chat.status === 'error' ? `Couldn't open the Foundry chat: ${chat.message}` : 'Opening the Foundry chat…'))
    }
    return createElement('div', { 'data-foundry': 'chat-area', style: { display: 'flex', flexDirection: 'column', flex: '1 1 0%', minHeight: 0 } },
      createElement('div', { style: { display: 'flex', flexDirection: 'column', flex: '0 1 auto', maxHeight: '35%', minHeight: 0, overflowY: 'auto' } }, top),
      createElement('div', { 'data-foundry': 'chat', style: { display: 'flex', flexDirection: 'column', flex: '1 1 0%', minHeight: 0, borderTop: '1px solid var(--border)' } },
        createElement(ThreadChat, { threadId: chat.threadId, variant: 'compact' })))
  }
  return ChatArea
}
