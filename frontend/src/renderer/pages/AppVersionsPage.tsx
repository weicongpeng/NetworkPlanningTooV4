import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Package, Upload, Download, Pencil, Trash2, RefreshCw,
  Loader2, X, Check, Circle
} from 'lucide-react'
import { appVersionsApi } from '../services/api'

interface AppVersionItem {
  id: number
  version: string
  changelog?: string
  apk_filename: string
  file_size?: number
  file_size_display?: string
  is_latest: boolean
  created_at: string
  updated_at?: string
}

function formatDate(dateStr: string): string {
  try {
    const d = new Date(dateStr)
    return d.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
  } catch {
    return dateStr
  }
}

export function AppVersionsPage() {
  const { t } = useTranslation()

  const [versions, setVersions] = useState<AppVersionItem[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [pageSize] = useState(20)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  // Upload modal
  const [showUpload, setShowUpload] = useState(false)
  const [uploadFile, setUploadFile] = useState<File | null>(null)
  const [uploadVersion, setUploadVersion] = useState('')
  const [uploadChangelog, setUploadChangelog] = useState('')
  const [uploadIsLatest, setUploadIsLatest] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState('')

  // Edit modal
  const [showEdit, setShowEdit] = useState(false)
  const [editItem, setEditItem] = useState<AppVersionItem | null>(null)
  const [editVersion, setEditVersion] = useState('')
  const [editChangelog, setEditChangelog] = useState('')
  const [editIsLatest, setEditIsLatest] = useState(false)
  const [editing, setEditing] = useState(false)
  const [editError, setEditError] = useState('')

  const fetchVersions = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const result = await appVersionsApi.list(page, pageSize)
      if (result.success && result.data) {
        setVersions(result.data.items || [])
        setTotal(result.data.total || 0)
      }
    } catch (err: any) {
      setError(err?.message || t('common.loading', '加载失败'))
    } finally {
      setLoading(false)
    }
  }, [page, pageSize, t])

  useEffect(() => { fetchVersions() }, [fetchVersions])

  const totalPages = Math.max(1, Math.ceil(total / pageSize))

  // --- Upload ---
  const resetUpload = () => {
    setUploadFile(null)
    setUploadVersion('')
    setUploadChangelog('')
    setUploadIsLatest(false)
    setUploadError('')
  }

  const handleUpload = async () => {
    if (!uploadFile) { setUploadError(t('appVersions.selectFile')); return }
    if (!uploadVersion.trim()) { setUploadError(t('appVersions.versionRequired')); return }
    setUploading(true)
    setUploadError('')
    try {
      const fd = new FormData()
      fd.append('file', uploadFile)
      fd.append('version', uploadVersion.trim())
      fd.append('changelog', uploadChangelog.trim())
      if (uploadIsLatest) fd.append('is_latest', 'true')
      const result = await appVersionsApi.upload(fd)
      if (result.success) {
        setShowUpload(false)
        resetUpload()
        fetchVersions()
      } else {
        setUploadError(result.message || t('appVersions.uploadFailed'))
      }
    } catch (err: any) {
      setUploadError(err?.message || t('appVersions.uploadFailed'))
    } finally {
      setUploading(false)
    }
  }

  // --- Edit ---
  const openEdit = (item: AppVersionItem) => {
    setEditItem(item)
    setEditVersion(item.version)
    setEditChangelog(item.changelog || '')
    setEditIsLatest(item.is_latest)
    setEditError('')
    setShowEdit(true)
  }

  const handleEdit = async () => {
    if (!editItem) return
    if (!editVersion.trim()) { setEditError(t('appVersions.versionRequired')); return }
    setEditing(true)
    setEditError('')
    try {
      const result = await appVersionsApi.update(editItem.id, {
        version: editVersion.trim(),
        changelog: editChangelog.trim(),
        is_latest: editIsLatest,
      })
      if (result.success) {
        setShowEdit(false)
        fetchVersions()
      } else {
        setEditError(result.message || t('appVersions.editFailed'))
      }
    } catch (err: any) {
      setEditError(err?.message || t('appVersions.editFailed'))
    } finally {
      setEditing(false)
    }
  }

  // --- Delete ---
  const handleDelete = async (item: AppVersionItem) => {
    if (!confirm(t('appVersions.deleteConfirm', `确定删除版本 ${item.version} ？`))) return
    try {
      const result = await appVersionsApi.delete(item.id)
      if (result.success) {
        fetchVersions()
      }
    } catch (err: any) {
      setError(err?.message || t('appVersions.deleteFailed'))
    }
  }

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="p-2 bg-primary/10 rounded-lg">
          <Package size={24} className="text-primary" />
        </div>
        <h1 className="text-base font-bold text-foreground">{t('appVersions.title')}</h1>
      </div>

      {/* Toolbar */}
      <div className="flex gap-3 items-center">
        <div className="text-sm text-muted-foreground">
          {t('common.total', '共')} <span className="text-foreground font-medium">{total}</span> {t('common.count', '个版本')}
        </div>
        <button
          onClick={fetchVersions}
          className="px-3 py-2 border border-border rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          title={t('common.refresh')}
        >
          <RefreshCw size={16} />
        </button>
        <button
          onClick={() => { resetUpload(); setShowUpload(true) }}
          className="ml-auto px-4 py-2 bg-primary text-primary-foreground rounded-lg hover:opacity-90 transition-opacity flex items-center gap-2"
        >
          <Upload size={16} />
          {t('appVersions.upload')}
        </button>
      </div>

      {/* Error */}
      {error && (
        <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-lg text-red-500 text-sm">
          {error}
        </div>
      )}

      {/* Table */}
      <div className="bg-card border border-border rounded-lg overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/50">
                <th className="text-left py-3 px-4 font-medium text-muted-foreground">{t('appVersions.version')}</th>
                <th className="text-left py-3 px-4 font-medium text-muted-foreground">{t('appVersions.changelog')}</th>
                <th className="text-left py-3 px-4 font-medium text-muted-foreground">{t('appVersions.fileSize')}</th>
                <th className="text-left py-3 px-4 font-medium text-muted-foreground">{t('appVersions.status')}</th>
                <th className="text-left py-3 px-4 font-medium text-muted-foreground">{t('appVersions.createdAt')}</th>
                <th className="text-left py-3 px-4 font-medium text-muted-foreground">{t('common.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={6} className="py-8 text-center text-muted-foreground">
                    <Loader2 size={20} className="animate-spin inline-block mr-2" />
                    {t('common.loading')}
                  </td>
                </tr>
              ) : versions.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-8 text-center text-muted-foreground">
                    {t('common.noData')}
                  </td>
                </tr>
              ) : versions.map((v) => (
                <tr key={v.id} className="border-b border-border hover:bg-muted/30 transition-colors">
                  <td className="py-3 px-4 font-medium">{v.version}</td>
                  <td className="py-3 px-4 text-muted-foreground max-w-xs truncate">
                    {v.changelog || '-'}
                  </td>
                  <td className="py-3 px-4 text-muted-foreground">{v.file_size_display || '-'}</td>
                  <td className="py-3 px-4">
                    {v.is_latest ? (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-green-500/10 text-green-500 border border-green-500/20">
                        <Check size={12} />
                        {t('appVersions.latest')}
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-muted text-muted-foreground">
                        <Circle size={12} />
                        {t('appVersions.old')}
                      </span>
                    )}
                  </td>
                  <td className="py-3 px-4 text-muted-foreground text-xs">{formatDate(v.created_at)}</td>
                  <td className="py-3 px-4">
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => window.open(`/api/v1/app-versions/download/${v.id}`, '_blank')}
                        className="p-1.5 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                        title={t('common.download')}
                      >
                        <Download size={14} />
                      </button>
                      <button
                        onClick={() => openEdit(v)}
                        className="p-1.5 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                        title={t('common.edit')}
                      >
                        <Pencil size={14} />
                      </button>
                      <button
                        onClick={() => handleDelete(v)}
                        className="p-1.5 rounded-md hover:bg-muted text-muted-foreground hover:text-red-500 transition-colors"
                        title={t('common.delete')}
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-border">
            <div className="text-sm text-muted-foreground">
              {t('common.pageInfo', '第 {{page}}/{{total}} 页', { page, total: totalPages })}
            </div>
            <div className="flex items-center gap-2">
              <button
                disabled={page <= 1}
                onClick={() => setPage(p => p - 1)}
                className="px-3 py-1.5 text-sm border border-border rounded-md disabled:opacity-30 hover:bg-muted transition-colors"
              >
                {t('common.prevPage', '上一页')}
              </button>
              <button
                disabled={page >= totalPages}
                onClick={() => setPage(p => p + 1)}
                className="px-3 py-1.5 text-sm border border-border rounded-md disabled:opacity-30 hover:bg-muted transition-colors"
              >
                {t('common.nextPage', '下一页')}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Upload Modal */}
      {showUpload && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-card border border-border rounded-xl w-full max-w-md mx-4 shadow-2xl">
            <div className="flex items-center justify-between px-5 py-4 border-b border-border">
              <h2 className="font-semibold text-foreground">{t('appVersions.upload')}</h2>
              <button onClick={() => setShowUpload(false)} className="p-1 rounded-md hover:bg-muted text-muted-foreground">
                <X size={18} />
              </button>
            </div>
            <div className="p-5 space-y-4">
              {uploadError && (
                <div className="p-2.5 bg-red-500/10 border border-red-500/20 rounded-lg text-red-500 text-xs">{uploadError}</div>
              )}
              <div>
                <label className="block text-sm font-medium text-foreground mb-1.5">{t('appVersions.selectFile')}</label>
                <input
                  type="file"
                  accept=".apk"
                  onChange={(e) => setUploadFile(e.target.files?.[0] || null)}
                  className="w-full text-sm file:mr-3 file:py-1.5 file:px-3 file:rounded-md file:border-0 file:text-sm file:bg-primary/10 file:text-primary hover:file:bg-primary/20"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-foreground mb-1.5">{t('appVersions.version')}</label>
                <input
                  type="text"
                  value={uploadVersion}
                  onChange={(e) => setUploadVersion(e.target.value)}
                  placeholder="1.2.0"
                  className="w-full px-3 py-2 bg-background border border-border rounded-lg text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/50 text-sm"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-foreground mb-1.5">{t('appVersions.changelog')}</label>
                <textarea
                  value={uploadChangelog}
                  onChange={(e) => setUploadChangelog(e.target.value)}
                  rows={3}
                  placeholder={t('appVersions.changelogPlaceholder')}
                  className="w-full px-3 py-2 bg-background border border-border rounded-lg text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/50 text-sm resize-none"
                />
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={uploadIsLatest}
                  onChange={(e) => setUploadIsLatest(e.target.checked)}
                  className="rounded border-border"
                />
                <span className="text-foreground">{t('appVersions.markAsLatest')}</span>
              </label>
              <div className="flex justify-end gap-2 pt-2">
                <button
                  onClick={() => setShowUpload(false)}
                  className="px-4 py-2 border border-border rounded-lg text-sm text-muted-foreground hover:bg-muted transition-colors"
                >
                  {t('common.cancel')}
                </button>
                <button
                  onClick={handleUpload}
                  disabled={uploading}
                  className="px-4 py-2 bg-primary text-primary-foreground rounded-lg text-sm hover:opacity-90 transition-opacity disabled:opacity-50 flex items-center gap-2"
                >
                  {uploading && <Loader2 size={14} className="animate-spin" />}
                  {t('common.upload')}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Edit Modal */}
      {showEdit && editItem && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-card border border-border rounded-xl w-full max-w-md mx-4 shadow-2xl">
            <div className="flex items-center justify-between px-5 py-4 border-b border-border">
              <h2 className="font-semibold text-foreground">{t('appVersions.editTitle')}</h2>
              <button onClick={() => setShowEdit(false)} className="p-1 rounded-md hover:bg-muted text-muted-foreground">
                <X size={18} />
              </button>
            </div>
            <div className="p-5 space-y-4">
              {editError && (
                <div className="p-2.5 bg-red-500/10 border border-red-500/20 rounded-lg text-red-500 text-xs">{editError}</div>
              )}
              <div>
                <label className="block text-sm font-medium text-foreground mb-1.5">{t('appVersions.version')}</label>
                <input
                  type="text"
                  value={editVersion}
                  onChange={(e) => setEditVersion(e.target.value)}
                  className="w-full px-3 py-2 bg-background border border-border rounded-lg text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50 text-sm"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-foreground mb-1.5">{t('appVersions.changelog')}</label>
                <textarea
                  value={editChangelog}
                  onChange={(e) => setEditChangelog(e.target.value)}
                  rows={3}
                  className="w-full px-3 py-2 bg-background border border-border rounded-lg text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50 text-sm resize-none"
                />
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={editIsLatest}
                  onChange={(e) => setEditIsLatest(e.target.checked)}
                  className="rounded border-border"
                />
                <span className="text-foreground">{t('appVersions.markAsLatest')}</span>
              </label>
              <div className="flex justify-end gap-2 pt-2">
                <button
                  onClick={() => setShowEdit(false)}
                  className="px-4 py-2 border border-border rounded-lg text-sm text-muted-foreground hover:bg-muted transition-colors"
                >
                  {t('common.cancel')}
                </button>
                <button
                  onClick={handleEdit}
                  disabled={editing}
                  className="px-4 py-2 bg-primary text-primary-foreground rounded-lg text-sm hover:opacity-90 transition-opacity disabled:opacity-50 flex items-center gap-2"
                >
                  {editing && <Loader2 size={14} className="animate-spin" />}
                  {t('common.save')}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
