import { getManager } from '../../../plugin/pty/manager.ts'
import {
  checkCommandPermission,
  checkWorkdirPermission,
  defaultWorkdir,
} from '../../../plugin/pty/permissions.ts'
import type { BunRequest } from 'bun'
import { JsonResponse, ErrorResponse } from './responses.ts'
import type { routes } from '../../shared/routes.ts'

export function getSessions() {
  const sessions = getManager().list()
  return new JsonResponse(sessions)
}

export async function createSession(req: Request) {
  let body: {
    command: string
    args?: string[]
    description?: string
    workdir?: string
    timeoutSeconds?: number
  }

  try {
    body = (await req.json()) as typeof body
  } catch {
    return new ErrorResponse('Invalid JSON in request body', 400)
  }

  if (!body.command || typeof body.command !== 'string' || body.command.trim() === '') {
    return new ErrorResponse('Command is required', 400)
  }

  try {
    const args = body.args || []
    await checkCommandPermission(body.command, args)
    const workdir = defaultWorkdir(body.workdir)
    await checkWorkdirPermission(workdir)

    const session = getManager().spawn({
      command: body.command,
      args,
      title: body.description,
      description: body.description,
      workdir,
      timeoutSeconds: body.timeoutSeconds,
      parentSessionId: 'web-api',
    })
    return new JsonResponse(session)
  } catch (error) {
    return new ErrorResponse(
      error instanceof Error ? error.message : 'Failed to create session',
      400
    )
  }
}

export function clearSessions() {
  getManager().clearAllSessions()
  return new JsonResponse({ success: true })
}

export function getSession(req: BunRequest<typeof routes.session.path>) {
  const session = getManager().get(req.params.id)
  if (!session) {
    return new ErrorResponse('Session not found', 404)
  }
  return new JsonResponse(session)
}

export async function sendInput(
  req: BunRequest<typeof routes.session.input.path>
): Promise<Response> {
  try {
    const body = (await req.json()) as { data: string }
    if (!body.data || typeof body.data !== 'string') {
      return new ErrorResponse('Data field is required and must be a string', 400)
    }
    const success = getManager().write(req.params.id, body.data)
    if (!success) {
      return new ErrorResponse('Failed to write to session', 400)
    }
    return new JsonResponse({ success: true })
  } catch {
    return new ErrorResponse('Invalid JSON in request body', 400)
  }
}

export function cleanupSession(req: BunRequest<typeof routes.session.cleanup.path>) {
  const success = getManager().kill(req.params.id, true)
  if (!success) {
    return new ErrorResponse('Failed to kill session', 400)
  }
  return new JsonResponse({ success: true })
}

export function killSession(req: BunRequest<typeof routes.session.path>) {
  const success = getManager().kill(req.params.id)
  if (!success) {
    return new ErrorResponse('Failed to kill session', 400)
  }
  return new JsonResponse({ success: true })
}

export function getRawBuffer(req: BunRequest<typeof routes.session.buffer.raw.path>) {
  const bufferData = getManager().getRawBuffer(req.params.id)
  if (!bufferData) {
    return new ErrorResponse('Session not found', 404)
  }

  return new JsonResponse(bufferData)
}

export function getPlainBuffer(req: BunRequest<typeof routes.session.buffer.plain.path>) {
  const snapshot = getManager().snapshot(req.params.id)
  if (!snapshot) {
    return new ErrorResponse('Session not found', 404)
  }

  return new JsonResponse({
    plain: snapshot.text,
    byteLength: new TextEncoder().encode(snapshot.text).length,
  })
}
