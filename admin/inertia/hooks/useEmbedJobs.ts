import { useEffect, useRef } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import api from '~/lib/api'
import { EmbedJobWithProgress } from '../../types/rag'

const useEmbedJobs = (props: { enabled?: boolean } = {}) => {
  const queryClient = useQueryClient()
  const prevCountRef = useRef<number>(0)
  const lastNonEmptyJobsRef = useRef<EmbedJobWithProgress[]>([])
  const lastNonEmptyAtRef = useRef<number>(0)
  const EMPTY_GRACE_MS = 15000

  const queryData = useQuery({
    queryKey: ['embed-jobs'],
    queryFn: () => api.getActiveEmbedJobs().then((data) => data ?? []),
    refetchInterval: (query) => {
      const data = query.state.data
      // Poll quickly while jobs are active. If the queue briefly reports empty between transitions,
      // keep polling quickly for a short grace window to avoid UI flicker.
      if (data && data.length > 0) return 2000
      const hadRecentJobs = Date.now() - lastNonEmptyAtRef.current < EMPTY_GRACE_MS
      return hadRecentJobs ? 2000 : 30000
    },
    enabled: props.enabled ?? true,
  })

  useEffect(() => {
    const current = queryData.data ?? []
    if (current.length > 0) {
      lastNonEmptyJobsRef.current = current
      lastNonEmptyAtRef.current = Date.now()
    }
  }, [queryData.data])

  const effectiveData =
    (queryData.data?.length ?? 0) > 0
      ? queryData.data
      : Date.now() - lastNonEmptyAtRef.current < EMPTY_GRACE_MS
        ? lastNonEmptyJobsRef.current
        : queryData.data

  // When jobs drain to zero, refresh stored files so they appear without reopening the modal
  useEffect(() => {
    const currentCount = effectiveData?.length ?? 0
    if (prevCountRef.current > 0 && currentCount === 0) {
      queryClient.invalidateQueries({ queryKey: ['storedFiles'] })
    }
    prevCountRef.current = currentCount
  }, [effectiveData, queryClient])

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['embed-jobs'] })
  }

  return { ...queryData, data: effectiveData, invalidate }
}

export default useEmbedJobs
