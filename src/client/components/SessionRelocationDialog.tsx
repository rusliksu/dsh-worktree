import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { SessionRelocationApi } from '../lib/api'
import type { SessionRelocationInfo, SessionRelocationRequest, SessionRelocationResult, WorkspacesService } from '../lib/types'
import { useT } from '../lib/i18n'
import { pathKey } from '../lib/paths'
import { Button, Dialog, DialogContent, DialogDescription, DialogTitle, Select } from './ui'

export interface SessionRelocationTarget { sessionId: string; title: string }

const refusalKeys: Record<string, string> = {
  'session/relocate-busy': 'moveBusy',
  'session/relocate-conflict': 'moveConflict',
  'session/relocate-target-invalid': 'moveTargetInvalid',
  'session/relocate-unsupported': 'moveUnsupported',
  'session/relocate-recovery-required': 'moveRecovery',
  'session/relocate-draft-state': 'moveDraftState',
  'gateway/bad-request': 'moveTargetInvalid',
}

export function SessionRelocationDialog({ target, api, workspaces, beforeMove, onMoved, onClose }: {
  target: SessionRelocationTarget
  api: SessionRelocationApi
  workspaces: WorkspacesService
  beforeMove: () => void
  onMoved: (result: SessionRelocationResult) => Promise<void>
  onClose: () => void
}) {
  const t = useT()
  const snapshot = useSyncExternalStore(listener => workspaces.list.subscribe(listener), () => workspaces.list.getSnapshot())
  const [info, setInfo] = useState<SessionRelocationInfo | null>(null)
  const [readAttempt, setReadAttempt] = useState(0)
  const [workspaceId, setWorkspaceId] = useState('')
  const [errorKey, setErrorKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [uncertain, setUncertain] = useState(false)
  const [confirmed, setConfirmed] = useState<SessionRelocationResult | null>(null)
  const busyRef = useRef(false)
  const intent = useRef<SessionRelocationRequest | null>(null)

  useEffect(() => {
    let active = true
    const controller = new AbortController()
    setInfo(null)
    setErrorKey('')
    api.info(target.sessionId, controller.signal).then(value => {
      if (active) { setInfo(value); if (!value.supported) setErrorKey('moveUnsupported') }
    }).catch(() => { if (active) setErrorKey('moveReadFailed') })
    return () => { active = false; controller.abort() }
  }, [api, target.sessionId, readAttempt])

  const choices = snapshot.items.filter(item => !item.path.includes('://') && (!info?.supported || pathKey(item.path) !== pathKey(info.cwd)))
  const selected = choices.find(item => item.workspaceId === workspaceId)
  const locked = busy || uncertain
  const close = () => { if (!busyRef.current && !uncertain) onClose() }
  const ready = confirmed !== null || uncertain || info?.supported && selected !== undefined && snapshot.phase === 'ready'

  const confirm = async () => {
    if (busyRef.current || !ready) return
    busyRef.current = true
    setBusy(true)
    setErrorKey('')
    let result = confirmed
    try {
      if (result === null) {
        if (intent.current === null) {
          if (!info?.supported || !selected || snapshot.phase !== 'ready') return
          beforeMove()
          intent.current = Object.freeze({ sessionId: target.sessionId, targetWorkspaceId: selected.workspaceId,
            expectedCwd: info.cwd, expectedRevision: info.revision, operationId: crypto.randomUUID() })
        }
        result = await api.relocate(intent.current)
        setConfirmed(result)
        setUncertain(false)
      }
      try { await onMoved(result) }
      catch { setErrorKey('moveOpenFailed') }
    } catch (error) {
      const code = error !== null && typeof error === 'object' && 'code' in error ? String(error.code) : ''
      const pending = intent.current !== null && (!refusalKeys[code] || code === 'session/relocate-recovery-required')
      setUncertain(pending)
      setErrorKey(refusalKeys[code] ?? (pending ? 'moveUnconfirmed' : 'moveReadFailed'))
      if (!pending) intent.current = null
    } finally { busyRef.current = false; setBusy(false) }
  }

  return <Dialog open onOpenChange={open => { if (!open) close() }}>
    <DialogContent busy={locked}>
      <header className="dswt-dialog-heading">
        <DialogTitle className="dswt-dialog-title">{t(confirmed ? 'moveCompleted' : 'moveChat')}</DialogTitle>
        <DialogDescription className="dswt-form-note">{t('moveDescription')}</DialogDescription>
      </header>
      <div className="dswt-dialog-body">
      <p>{target.title || target.sessionId}</p>
      {info?.supported && <p className="dswt-muted">{t('moveCurrent')} <code>{info.cwd}</code></p>}
      <label className="dswt-field-label">{t('moveDestination')}
        <Select aria-label={t('moveDestination')} value={workspaceId} disabled={locked || confirmed !== null || !info?.supported}
          onChange={event => { setWorkspaceId(event.target.value); setErrorKey('') }}>
          <option value="">{t('moveChoose')}</option>
          {choices.map(item => <option key={item.workspaceId} value={item.workspaceId}>{item.title} — {item.path}</option>)}
        </Select>
      </label>
      {selected && <p><code style={{ overflowWrap: 'anywhere' }}>{selected.path}</code></p>}
      {info === null && !errorKey && <p role="status">{t('moveChecking')}</p>}
      {info?.supported && choices.length === 0 && <p>{t('moveNoDestination')}</p>}
      {errorKey && <p className="dswt-error" role="alert">{t(errorKey)}</p>}
      </div>
      <footer className="dswt-dialog-footer">
        <Button disabled={locked} onClick={close}>{t('cancel')}</Button>
        {!locked && confirmed === null && errorKey && <Button onClick={() => { intent.current = null; setReadAttempt(value => value + 1) }}>{t('refresh')}</Button>}
        <Button className="dswt-button-primary" disabled={busy || !ready} onClick={() => { void confirm() }}>{t(busy ? 'moveWorking' : confirmed ? 'moveOpen' : uncertain ? 'moveCheckResult' : 'moveConfirm')}</Button>
      </footer>
    </DialogContent>
  </Dialog>
}
