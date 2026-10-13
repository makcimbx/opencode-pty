import { getManager } from '../../plugin/pty/manager'
import type { PTYSessionInfo } from '../../plugin/pty/types'
import type { WSMessageServerSessionUpdate, WSMessageServerRawData } from '../shared/types'

export class CallbackManager implements Disposable {
  private readonly manager = getManager()
  constructor(private server: Bun.Server<undefined>) {
    this.server = server
    this.manager.sessionUpdateCallbacks.push(this.sessionUpdateCallback)
    this.manager.rawOutputCallbacks.push(this.rawOutputCallback)
  }

  private sessionUpdateCallback = (session: PTYSessionInfo): void => {
    const message: WSMessageServerSessionUpdate = { type: 'session_update', session }
    this.server.publish('sessions:update', JSON.stringify(message))
  }

  private rawOutputCallback = (session: PTYSessionInfo, rawData: string): void => {
    const message: WSMessageServerRawData = { type: 'raw_data', session, rawData }
    this.server.publish(`session:${session.id}`, JSON.stringify(message))
  };

  [Symbol.dispose]() {
    const updateIndex = this.manager.sessionUpdateCallbacks.indexOf(this.sessionUpdateCallback)
    if (updateIndex !== -1) this.manager.sessionUpdateCallbacks.splice(updateIndex, 1)
    const outputIndex = this.manager.rawOutputCallbacks.indexOf(this.rawOutputCallback)
    if (outputIndex !== -1) this.manager.rawOutputCallbacks.splice(outputIndex, 1)
  }
}
