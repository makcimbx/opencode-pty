import { ptySpawn } from './spawn.ts'
import { ptyWrite } from './write.ts'
import { ptyRead } from './read.ts'
import { ptyList } from './list.ts'
import { ptyKill } from './kill.ts'
import { ptySnapshot } from './snapshot.ts'
import { ptySnapshotWait } from './snapshot-wait.ts'
import { ptyWait } from './wait.ts'

export const ptyTools = {
  pty_spawn: ptySpawn,
  pty_write: ptyWrite,
  pty_read: ptyRead,
  pty_snapshot: ptySnapshot,
  pty_snapshot_wait: ptySnapshotWait,
  pty_list: ptyList,
  pty_kill: ptyKill,
  pty_wait: ptyWait,
}
