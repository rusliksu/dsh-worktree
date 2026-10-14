import { useEffect, useState } from 'react'
import { FileDiff, Loader2, RefreshCw } from 'lucide-react'
import { useT } from '../lib/i18n'
import type { ReviewMode, ReviewSummary } from '../lib/types'
import type { createWorktreeApi } from '../lib/api'
import { Button, Dialog, DialogContent, DialogDescription, DialogTitle, Input } from './ui'

interface Props {
  path: string
  api: ReturnType<typeof createWorktreeApi>
  onClose: () => void
}

export function GitReviewDialog({ path, api, onClose }: Props) {
  const t = useT()
  const [mode, setMode] = useState<ReviewMode>('working')
  const [baseText, setBaseText] = useState('')
  const [baseRef, setBaseRef] = useState('')
  const [refresh, setRefresh] = useState(0)
  const [summary, setSummary] = useState<ReviewSummary | null>(null)
  const [file, setFile] = useState('')
  const [patch, setPatch] = useState<{ file: string; mode: ReviewMode; text: string } | null>(null)
  const [loading, setLoading] = useState(false)
  const [diffLoading, setDiffLoading] = useState(false)
  const [error, setError] = useState('')
  const errorText = (reason: unknown) => /too large|500 files/.test(String(reason)) ? t('reviewTooLarge') : t('reviewError')

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true); setSummary(null); setFile(''); setError('')
    api.reviewSummary(path, mode, baseRef || undefined, controller.signal).then(value => {
      if (controller.signal.aborted) return
      setSummary(value)
      setFile(value.files.find(row => !row.protected)?.path ?? '')
    }).catch(reason => { if (!controller.signal.aborted) setError(errorText(reason)) })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [api, path, mode, baseRef, refresh, t])

  const current = summary?.mode === mode ? summary : null
  useEffect(() => {
    const controller = new AbortController()
    setPatch(null); setError(''); setDiffLoading(false)
    if (!current || !file) return () => controller.abort()
    setDiffLoading(true)
    api.reviewDiff(current.path, mode, file, current.baseCommit, controller.signal).then(value => {
      if (!controller.signal.aborted) setPatch({ file, mode, text: value.patch })
    }).catch(reason => { if (!controller.signal.aborted) setError(errorText(reason)) })
      .finally(() => { if (!controller.signal.aborted) setDiffLoading(false) })
    return () => controller.abort()
  }, [api, current, file, mode, t])

  const text = patch?.file === file && patch.mode === mode ? patch.text : ''
  return <Dialog open onOpenChange={open => { if (!open) onClose() }}>
    <DialogContent className="dswt-review-dialog">
      <div className="dswt-dialog-heading"><DialogTitle className="dswt-dialog-title">{t('reviewChanges')}</DialogTitle><DialogDescription className="dswt-form-note">{t('reviewDescription')}</DialogDescription><p className="dswt-review-path">{path}</p></div>
      <div className="dswt-review-toolbar">
        <div className="dswt-filters" role="group" aria-label={t('reviewComparison')}>
          {(['working', 'staged', 'branch'] as const).map(value => <button type="button" key={value} aria-pressed={mode === value} onClick={() => setMode(value)}>{t(`review_${value}`)}</button>)}
        </div>
        <Button className="dswt-icon-button" aria-label={t('refresh')} disabled={loading} onClick={() => setRefresh(value => value + 1)}><RefreshCw size={16} /></Button>
      </div>
      {mode === 'branch' ? <form className="dswt-review-base" onSubmit={event => { event.preventDefault(); setBaseRef(baseText.trim()); setRefresh(value => value + 1) }}><label htmlFor="dswt-review-base">{t('reviewBase')}</label><Input id="dswt-review-base" placeholder={t('reviewBaseDefault')} value={baseText} onChange={event => setBaseText(event.target.value)} /><Button type="submit" disabled={loading}>{t('reviewCompare')}</Button></form> : null}
      {error ? <div className="dswt-error" role="alert">{error}</div> : null}
      <div className="dswt-review-body" aria-busy={loading || diffLoading}>
        <nav className="dswt-review-files" aria-label={t('reviewFiles')}>
          {loading ? <span role="status"><Loader2 size={14} className="dswt-spin" />{t('loadingRepository')}</span> : null}
          {current?.files.map(row => <button type="button" key={row.path} disabled={row.protected} aria-pressed={file === row.path} onClick={() => setFile(row.path)} title={row.protected ? t('reviewProtected') : row.path}><FileDiff size={14} /><span>{row.path}</span><small>{t(row.protected ? 'reviewPathOnly' : row.status === 'A' ? 'reviewAdded' : row.status === 'D' ? 'reviewDeleted' : 'reviewModified')}</small></button>)}
        </nav>
        <div className="dswt-review-patch">
          {diffLoading ? <p role="status"><Loader2 size={14} className="dswt-spin" />{t('reviewLoadingDiff')}</p> : null}
          {!loading && current?.files.length === 0 ? <p>{t('reviewNoChanges')}</p> : null}
          {!loading && current && current.files.length > 0 && !file ? <p>{t('reviewProtected')}</p> : null}
          {text ? <><h3>{file}</h3><pre aria-label={t('reviewDiff')}><code>{text.split('\n').map((line, index) => <span key={index} className={line.startsWith('@@') ? 'dswt-diff-hunk' : line.startsWith('+') && !line.startsWith('+++') ? 'dswt-diff-added' : line.startsWith('-') && !line.startsWith('---') ? 'dswt-diff-deleted' : undefined}>{line}{'\n'}</span>)}</code></pre></> : null}
        </div>
      </div>
      <p className="dswt-review-note">{t('reviewTrackedOnly')}</p>
    </DialogContent>
  </Dialog>
}
