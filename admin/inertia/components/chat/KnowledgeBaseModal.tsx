import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useRef, useState } from 'react'
import FileUploader from '~/components/file-uploader'
import StyledButton from '~/components/StyledButton'
import StyledSectionHeader from '~/components/StyledSectionHeader'
import StyledTable from '~/components/StyledTable'
import { useNotifications } from '~/context/NotificationContext'
import api from '~/lib/api'
import { IconX } from '@tabler/icons-react'
import { useModals } from '~/context/ModalContext'
import StyledModal from '../StyledModal'
import ActiveEmbedJobs from '~/components/ActiveEmbedJobs'
import type { ZimFileWithMetadata } from '../../../../types/zim'

interface KnowledgeBaseModalProps {
  aiAssistantName?: string
  onClose: () => void
}

type KnowledgeBaseEntry = {
  key: string
  displayName: string
  sourceType: 'uploaded' | 'zim'
  source: string
  deleteValue: string
}

function sourceToDisplayName(source: string): string {
  const parts = source.split(/[/\\]/)
  return parts[parts.length - 1]
}

export default function KnowledgeBaseModal({ aiAssistantName = "AI Assistant", onClose }: KnowledgeBaseModalProps) {
  const { addNotification } = useNotifications()
  const [files, setFiles] = useState<File[]>([])
  const [isUploading, setIsUploading] = useState(false)
  const [confirmDeleteSource, setConfirmDeleteSource] = useState<string | null>(null)
  const fileUploaderRef = useRef<React.ComponentRef<typeof FileUploader>>(null)
  const { openModal, closeModal } = useModals()
  const queryClient = useQueryClient()

  const { data: storedFiles = [], isLoading: isLoadingFiles } = useQuery({
    queryKey: ['storedFiles'],
    queryFn: () => api.getStoredRAGFiles(),
    select: (data) => data || [],
  })

  const { data: connectedZimFiles = [], isLoading: isLoadingZimFiles } = useQuery({
    queryKey: ['connected-zim-files'],
    queryFn: async () => {
      const response = await api.listZimFiles()
      return (response?.files || []) as ZimFileWithMetadata[]
    },
  })

  const uploadMutation = useMutation({
    mutationFn: (file: File) => api.uploadDocument(file),
  })

  const deleteMutation = useMutation({
    mutationFn: async (entry: KnowledgeBaseEntry) => {
      if (entry.sourceType === 'zim') {
        return api.deleteZimFile(entry.deleteValue)
      }
      return api.deleteRAGFile(entry.deleteValue)
    },
    onSuccess: () => {
      addNotification({ type: 'success', message: 'File removed from knowledge base.' })
      setConfirmDeleteSource(null)
      queryClient.invalidateQueries({ queryKey: ['storedFiles'] })
      queryClient.invalidateQueries({ queryKey: ['connected-zim-files'] })
    },
    onError: (error: any) => {
      addNotification({ type: 'error', message: error?.message || 'Failed to delete file.' })
      setConfirmDeleteSource(null)
    },
  })

  const cleanupFailedMutation = useMutation({
    mutationFn: () => api.cleanupFailedEmbedJobs(),
    onSuccess: (data) => {
      addNotification({ type: 'success', message: data?.message || 'Failed jobs cleaned up.' })
      queryClient.invalidateQueries({ queryKey: ['failedEmbedJobs'] })
    },
    onError: (error: any) => {
      addNotification({ type: 'error', message: error?.message || 'Failed to clean up jobs.' })
    },
  })

  const syncMutation = useMutation({
    mutationFn: () => api.syncRAGStorage(),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['embed-jobs'] })
      queryClient.invalidateQueries({ queryKey: ['failedEmbedJobs'] })
      queryClient.invalidateQueries({ queryKey: ['storedFiles'] })
      addNotification({
        type: 'success',
        message: data?.message || 'Storage synced successfully. If new files were found, they have been queued for processing.',
      })
    },
    onError: (error: any) => {
      addNotification({
        type: 'error',
        message: error?.message || 'Failed to sync storage',
      })
    },
  })

  const handleUpload = async () => {
    if (files.length === 0) return
    setIsUploading(true)
    const successMessages: string[] = []
    const failedNames: string[] = []

    for (const file of files) {
      try {
        const result = await uploadMutation.mutateAsync(file)
        successMessages.push(result?.message || `${file.name} queued for processing.`)
      } catch (error: any) {
        failedNames.push(file.name)
      }
    }

    setIsUploading(false)
    setFiles([])
    fileUploaderRef.current?.clear()
    queryClient.invalidateQueries({ queryKey: ['embed-jobs'] })
    queryClient.invalidateQueries({ queryKey: ['storedFiles'] })

    for (const message of successMessages) {
      addNotification({ type: 'success', message })
    }
    for (const name of failedNames) {
      addNotification({ type: 'error', message: `Failed to upload: ${name}` })
    }
  }

  const handleConfirmSync = () => {
    openModal(
      <StyledModal
        title='Confirm Sync?'
        onConfirm={() => {
          syncMutation.mutate()
          queryClient.invalidateQueries({ queryKey: ['embed-jobs'] })
          closeModal(
            "confirm-sync-modal"
          )
        }}
        onCancel={() => closeModal("confirm-sync-modal")}
        open={true}
        confirmText='Confirm Sync'
        cancelText='Cancel'
        confirmVariant='primary'
      >
        <p className='text-text-primary'>
          This will scan the NOMAD's storage directories for any new files and queue them for processing. This is useful if you've manually added files to the storage or want to ensure everything is up to date.
          This may cause a temporary increase in resource usage if new files are found and being processed. Are you sure you want to proceed?
        </p>
      </StyledModal>,
      "confirm-sync-modal"
    )
  }

  const knowledgeBaseEntries: KnowledgeBaseEntry[] = [
    ...storedFiles.map((source) => ({
      key: `uploaded:${source}`,
      displayName: sourceToDisplayName(source),
      sourceType: 'uploaded' as const,
      source,
      deleteValue: source,
    })),
    ...connectedZimFiles.map((file) => ({
      key: `zim:${file.key}`,
      displayName: file.title || file.name,
      sourceType: 'zim' as const,
      source: file.key,
      deleteValue: file.name,
    })),
  ].sort((a, b) => a.displayName.localeCompare(b.displayName))

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/30 backdrop-blur-sm transition-opacity">
      <div className="bg-surface-primary rounded-lg shadow-xl max-w-4xl w-full max-h-[90vh] overflow-hidden flex flex-col">
        <div className="flex items-center justify-between p-6 border-b border-border-subtle shrink-0">
          <h2 className="text-2xl font-semibold text-text-primary">Knowledge Base</h2>
          <button
            onClick={onClose}
            className="p-2 hover:bg-surface-secondary rounded-lg transition-colors"
          >
            <IconX className="h-6 w-6 text-text-muted" />
          </button>
        </div>
        <div className="overflow-y-auto flex-1 p-6">
          <div className="bg-surface-primary rounded-lg border shadow-md overflow-hidden">
            <div className="p-6">
              <FileUploader
                ref={fileUploaderRef}
                minFiles={1}
                maxFiles={5}
                onUpload={(uploadedFiles) => {
                  setFiles(Array.from(uploadedFiles))
                }}
              />
              <div className="mt-3 text-sm text-text-secondary text-center">
                Upload PDFs, text files, images, EPUBs, or ZIP archives. ZIPs are unpacked automatically and supported files are added to the Knowledge Base.
              </div>
              <div className="flex justify-center gap-4 my-6">
                <StyledButton
                  variant="primary"
                  size="lg"
                  icon="IconUpload"
                  onClick={handleUpload}
                  disabled={files.length === 0 || isUploading}
                  loading={isUploading}
                >
                  Upload
                </StyledButton>
              </div>
            </div>
            <div className="border-t bg-surface-primary p-6">
              <h3 className="text-lg font-semibold text-desert-green mb-4">
                Why upload documents to your Knowledge Base?
              </h3>
              <div className="space-y-3">
                <div className="flex items-start gap-3">
                  <div className="shrink-0 w-6 h-6 rounded-full bg-desert-green text-white flex items-center justify-center text-sm font-bold">
                    1
                  </div>
                  <div>
                    <p className="font-medium text-desert-stone-dark">
                      {aiAssistantName} Knowledge Base Integration
                    </p>
                    <p className="text-sm text-desert-stone">
                      When you upload documents to your Knowledge Base, NOMAD processes and embeds
                      the content, making it directly accessible to {aiAssistantName}. This allows{' '}
                      {aiAssistantName} to reference your specific documents during conversations,
                      providing more accurate and personalized responses based on your uploaded
                      data.
                    </p>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <div className="shrink-0 w-6 h-6 rounded-full bg-desert-green text-white flex items-center justify-center text-sm font-bold">
                    2
                  </div>
                  <div>
                    <p className="font-medium text-desert-stone-dark">
                      Enhanced Document Processing with OCR
                    </p>
                    <p className="text-sm text-desert-stone">
                      NOMAD includes built-in Optical Character Recognition (OCR) capabilities,
                      allowing it to extract text from image-based documents such as scanned PDFs or
                      photos. This means that even if your documents are not in a standard text
                      format, NOMAD can still process and embed their content for AI access.
                    </p>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <div className="shrink-0 w-6 h-6 rounded-full bg-desert-green text-white flex items-center justify-center text-sm font-bold">
                    3
                  </div>
                  <div>
                    <p className="font-medium text-desert-stone-dark">
                      Information Library Integration
                    </p>
                    <p className="text-sm text-desert-stone">
                      NOMAD will automatically discover and extract any content you save to your
                      Information Library (if installed), making it instantly available to {aiAssistantName} without any extra steps.
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </div>
          <div className="my-8">
            <div className="flex items-center justify-between mb-4">
              <StyledSectionHeader title="Processing Queue" className="!mb-0" />
              <StyledButton
                variant="danger"
                size="md"
                icon="IconTrash"
                onClick={() => cleanupFailedMutation.mutate()}
                loading={cleanupFailedMutation.isPending}
                disabled={cleanupFailedMutation.isPending}
              >
                Clean Up Failed
              </StyledButton>
            </div>
            <ActiveEmbedJobs withHeader={false} />
          </div>

          <div className="my-12">
            <div className='flex items-center justify-between mb-6'>
              <StyledSectionHeader title="Knowledge Base Files" className='!mb-0' />
              <StyledButton
                variant="secondary"
                size="md"
                icon='IconRefresh'
                onClick={handleConfirmSync}
                disabled={syncMutation.isPending || isUploading}
                loading={syncMutation.isPending || isUploading}
              >
                Sync Storage
              </StyledButton>
            </div>
            <div className="mb-4 grid gap-3 md:grid-cols-2">
              <div className="rounded-lg border border-border-subtle bg-surface-secondary/60 px-4 py-3">
                <div className="text-xs uppercase tracking-wide text-text-muted">Uploaded Library</div>
                <div className="mt-1 text-2xl font-semibold text-text-primary">{storedFiles.length}</div>
                <div className="text-sm text-text-secondary">User-uploaded PDFs, docs, and personal files</div>
              </div>
              <div className="rounded-lg border border-border-subtle bg-surface-secondary/60 px-4 py-3">
                <div className="text-xs uppercase tracking-wide text-text-muted">Installed ZIM Sources</div>
                <div className="mt-1 text-2xl font-semibold text-text-primary">
                  {isLoadingZimFiles ? '…' : connectedZimFiles.length}
                </div>
                <div className="text-sm text-text-secondary">Offline libraries like Wikipedia and other knowledge packs</div>
              </div>
            </div>
            <StyledTable<KnowledgeBaseEntry>
              className="font-semibold"
              rowLines={true}
              columns={[
                {
                  accessor: 'displayName',
                  title: 'File Name',
                  render(record) {
                    return <span className="text-text-primary">{record.displayName}</span>
                  },
                },
                {
                  accessor: 'sourceType',
                  title: 'Type',
                  render(record) {
                    return (
                      <span className="rounded-full border border-border-subtle bg-surface-secondary px-2 py-1 text-xs text-text-secondary">
                        {record.sourceType === 'zim' ? 'ZIM' : 'Uploaded'}
                      </span>
                    )
                  },
                },
                {
                  accessor: 'key',
                  title: '',
                  render(record) {
                    const isConfirming = confirmDeleteSource === record.key
                    const isDeleting = deleteMutation.isPending && confirmDeleteSource === record.key
                    if (isConfirming) {
                      return (
                        <div className="flex items-center gap-2 justify-end">
                          <span className="text-sm text-text-secondary">Remove from knowledge base?</span>
                          <StyledButton
                            variant='danger'
                            size='sm'
                            onClick={() => deleteMutation.mutate(record)}
                            disabled={isDeleting}
                          >
                            {isDeleting ? 'Deleting…' : 'Confirm'}
                          </StyledButton>
                          <StyledButton
                            variant='ghost'
                            size='sm'
                            onClick={() => setConfirmDeleteSource(null)}
                            disabled={isDeleting}
                          >
                            Cancel
                          </StyledButton>
                        </div>
                      )
                    }
                    return (
                      <div className="flex justify-end">
                        <StyledButton
                          variant="danger"
                          size="sm"
                          icon="IconTrash"
                          onClick={() => setConfirmDeleteSource(record.key)}
                          disabled={deleteMutation.isPending}
                          loading={deleteMutation.isPending && confirmDeleteSource === record.key}
                        >Delete</StyledButton>
                      </div>
                    )
                  },
                },
              ]}
              data={knowledgeBaseEntries}
              loading={isLoadingFiles || isLoadingZimFiles}
            />
            {!isLoadingFiles && !isLoadingZimFiles && knowledgeBaseEntries.length === 0 && (
              <div className="mt-4 text-sm text-text-secondary">
                No uploaded files or ZIM libraries are currently registered.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
