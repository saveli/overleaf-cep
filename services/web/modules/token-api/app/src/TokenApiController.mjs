import { RequestFailedError } from '@overleaf/fetch-utils'
import ChatApiHandler from '../../../../app/src/Features/Chat/ChatApiHandler.mjs'
import DocstoreManager from '../../../../app/src/Features/Docstore/DocstoreManager.mjs'
import DocumentUpdaterHandler from '../../../../app/src/Features/DocumentUpdater/DocumentUpdaterHandler.mjs'
import EditorRealTimeController from '../../../../app/src/Features/Editor/EditorRealTimeController.mjs'
import ProjectEntityHandler from '../../../../app/src/Features/Project/ProjectEntityHandler.mjs'
import ProjectGetter from '../../../../app/src/Features/Project/ProjectGetter.mjs'
import UserGetter from '../../../../app/src/Features/User/UserGetter.mjs'
import UserInfoController from '../../../../app/src/Features/User/UserInfoController.mjs'
import UserInfoManager from '../../../../app/src/Features/User/UserInfoManager.mjs'
import { notFound } from './TokenApiAuthMiddleware.mjs'

const ID_REGEX = /^[0-9a-f]{24}$/
// Same limit as the chat service (MessageHttpSchemas MAX_MESSAGE_LENGTH).
const MAX_MESSAGE_LENGTH = 10 * 1024

// Chat or document-updater answered 404 (unknown thread/doc) -> our 404 body.
function handleWriteError(err, res, next) {
  if (err instanceof RequestFailedError && err.response?.status === 404) {
    return notFound(res)
  }
  next(err)
}

function iso(value) {
  return value == null ? null : new Date(value).toISOString()
}

// '2026-10-10T12:34:56.789Z' -> '2026-10-10 12:34'
function shortTime(isoString) {
  return isoString ? isoString.slice(0, 16).replace('T', ' ') : '?'
}

function lineAt(text, offset) {
  return text.slice(0, offset).split('\n').length
}

function byFileLine(a, b) {
  if (a.file !== b.file) {
    if (a.file == null) return 1
    if (b.file == null) return -1
    return a.file < b.file ? -1 : 1
  }
  if (a.line !== b.line) {
    if (a.line == null) return 1
    if (b.line == null) return -1
    return a.line - b.line
  }
  return 0
}

async function getAuthors(userIds) {
  const ids = [...new Set(userIds.filter(id => id && ID_REGEX.test(id)))]
  const users = await UserGetter.promises.getUsers(ids, {
    first_name: 1,
    last_name: 1,
  })
  const names = new Map()
  for (const user of users) {
    const name = `${user.first_name || ''} ${user.last_name || ''}`.trim()
    names.set(user._id.toString(), name || null)
  }
  return id => (id ? { id, name: names.get(id) ?? null } : null)
}

function toMarkdown(view) {
  const out = [
    `# ${view.project.name}: review comments (${shortTime(view.generated_at)} UTC)`,
  ]
  let currentFile
  for (const thread of view.threads) {
    if (thread.file !== currentFile) {
      currentFile = thread.file
      out.push('', `## ${thread.file ?? '(no file)'}`)
    }
    const state = thread.resolved ? 'resolved' : 'open'
    const where = thread.line != null ? `Line ${thread.line}` : 'Thread'
    out.push('', `### ${where} (${state})`)
    if (thread.quote != null) {
      out.push(...thread.quote.split('\n').map(line => `> ${line}`))
    }
    if (thread.messages.length > 0) out.push('')
    for (const message of thread.messages) {
      const name = message.author?.name ?? message.author?.id ?? 'unknown'
      out.push(
        `- **${name}**, ${shortTime(message.time)}: ${message.content.replaceAll('\n', '\n  ')}`
      )
    }
  }
  if (view.changes.length > 0) {
    out.push('', '## Tracked changes')
    for (const change of view.changes) {
      const name = change.author?.name ?? change.author?.id ?? 'unknown'
      const where = `${change.file ?? '(no file)'}:${change.line ?? '?'}`
      out.push(
        `- ${where} ${change.type} by ${name}, ${shortTime(change.time)}: \`${change.text}\``
      )
    }
  }
  return out.join('\n') + '\n'
}

const TokenApiController = {
  async getRanges(req, res, next) {
    try {
      const { project_id } = req.params
      // Flush unflushed edits to docstore (docs stay loaded), then read all docs from there.
      await DocumentUpdaterHandler.promises.flushProjectToMongo(project_id)
      const docs = await DocstoreManager.promises.getAllRanges(project_id)
      res.json(docs.map(doc => ({ id: doc._id, ranges: doc.ranges ?? {} })))
    } catch (err) {
      next(err)
    }
  },

  async getThreads(req, res, next) {
    try {
      const { project_id } = req.params
      await DocumentUpdaterHandler.promises.flushProjectToMongo(project_id)
      const [project, allDocs, rangeDocs, chatThreads] = await Promise.all([
        ProjectGetter.promises.getProject(project_id, { name: 1 }),
        ProjectEntityHandler.promises.getAllDocs(project_id),
        DocstoreManager.promises.getAllRanges(project_id),
        ChatApiHandler.promises.getThreads(project_id),
      ])

      const docsById = new Map()
      for (const [path, doc] of Object.entries(allDocs)) {
        docsById.set(doc._id.toString(), {
          path: path.replace(/^\//, ''),
          text: doc.lines.join('\n'),
        })
      }

      const anchors = new Map()
      const rawChanges = []
      for (const rangeDoc of rangeDocs) {
        const doc = docsById.get(rangeDoc._id.toString())
        const locate = p =>
          doc
            ? { file: doc.path, line: lineAt(doc.text, p) }
            : { file: null, line: null }
        for (const comment of rangeDoc.ranges?.comments ?? []) {
          anchors.set(String(comment.op.t), {
            ...locate(comment.op.p),
            quote: comment.op.c,
          })
        }
        for (const change of rangeDoc.ranges?.changes ?? []) {
          rawChanges.push({ change, ...locate(change.op.p) })
        }
      }

      const userIds = []
      for (const thread of Object.values(chatThreads)) {
        userIds.push(thread.resolved_by_user_id)
        for (const message of thread.messages ?? []) userIds.push(message.user_id)
      }
      for (const { change } of rawChanges) userIds.push(change.metadata?.user_id)
      const author = await getAuthors(userIds.map(id => (id ? String(id) : null)))

      const threadIds = new Set([...Object.keys(chatThreads), ...anchors.keys()])
      const threads = [...threadIds].map(id => {
        const chat = chatThreads[id] ?? {}
        const anchor = anchors.get(id) ?? { file: null, line: null, quote: null }
        return {
          id,
          file: anchor.file,
          line: anchor.line,
          quote: anchor.quote,
          resolved: !!chat.resolved,
          resolved_at: iso(chat.resolved_at),
          resolved_by: chat.resolved_by_user_id
            ? author(String(chat.resolved_by_user_id))
            : null,
          messages: (chat.messages ?? []).map(m => ({
            id: m.id,
            author: m.user_id ? author(String(m.user_id)) : null,
            time: iso(m.timestamp),
            edited_at: iso(m.edited_at),
            content: m.content,
          })),
        }
      })
      const firstTime = t => t.messages[0]?.time ?? ''
      threads.sort(
        (a, b) => byFileLine(a, b) || firstTime(a).localeCompare(firstTime(b))
      )

      const changes = rawChanges.map(({ change, file, line }) => ({
        id: change.id,
        file,
        line,
        type: change.op.i != null ? 'insert' : 'delete',
        text: change.op.i ?? change.op.d,
        author: change.metadata?.user_id
          ? author(String(change.metadata.user_id))
          : null,
        time: iso(change.metadata?.ts),
      }))
      changes.sort(byFileLine)

      const view = {
        project: { id: project_id, name: project?.name ?? null },
        generated_at: new Date().toISOString(),
        threads,
        changes,
      }
      if (req.query.format === 'md') {
        res.type('text/markdown; charset=utf-8').send(toMarkdown(view))
      } else {
        res.json(view)
      }
    } catch (err) {
      next(err)
    }
  },

  async sendMessage(req, res, next) {
    const content = req.body?.content
    if (
      typeof content !== 'string' ||
      content.trim() === '' ||
      content.length > MAX_MESSAGE_LENGTH
    ) {
      return res.status(400).json({ error: 'bad request' })
    }
    try {
      const { project_id, thread_id } = req.params
      const userId = req.tokenUserId
      const message = await ChatApiHandler.promises.sendComment(
        project_id,
        thread_id,
        userId,
        content
      )
      const user = await UserInfoManager.promises.getPersonalInfo(userId)
      message.user = UserInfoController.formatPersonalInfo(user)
      EditorRealTimeController.emitToRoom(
        project_id,
        'new-comment',
        thread_id,
        message
      )
      res.status(201).json({
        id: message.id,
        time: iso(message.timestamp),
        content: message.content,
      })
    } catch (err) {
      handleWriteError(err, res, next)
    }
  },

  async resolveThread(req, res, next) {
    try {
      const { project_id, doc_id, thread_id } = req.params
      const userId = req.tokenUserId
      const user = await UserInfoManager.promises.getPersonalInfo(userId)
      await ChatApiHandler.promises.resolveThread(project_id, thread_id, userId)
      EditorRealTimeController.emitToRoom(
        project_id,
        'resolve-thread',
        thread_id,
        UserInfoController.formatPersonalInfo(user)
      )
      await DocumentUpdaterHandler.promises.resolveThread(
        project_id,
        doc_id,
        thread_id,
        userId
      )
      res.sendStatus(204)
    } catch (err) {
      handleWriteError(err, res, next)
    }
  },

  async reopenThread(req, res, next) {
    try {
      const { project_id, doc_id, thread_id } = req.params
      await ChatApiHandler.promises.reopenThread(project_id, thread_id)
      EditorRealTimeController.emitToRoom(project_id, 'reopen-thread', thread_id)
      await DocumentUpdaterHandler.promises.reopenThread(
        project_id,
        doc_id,
        thread_id,
        req.tokenUserId
      )
      res.sendStatus(204)
    } catch (err) {
      handleWriteError(err, res, next)
    }
  },
}

export default TokenApiController
