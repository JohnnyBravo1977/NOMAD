import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useNotifications } from '~/context/NotificationContext'
import api from '~/lib/api'

type UserSpaceSwitcherProps = {
  compact?: boolean
}

export default function UserSpaceSwitcher({ compact = false }: UserSpaceSwitcherProps) {
  const queryClient = useQueryClient()
  const { addNotification } = useNotifications()

  const { data, isLoading } = useQuery({
    queryKey: ['user-space-context'],
    queryFn: () => api.getUserSpaceContext(),
    staleTime: 15_000,
  })

  const switchMutation = useMutation({
    mutationFn: (userId: number) => api.selectUserSpace(userId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['user-space-context'] })
      queryClient.invalidateQueries({ queryKey: ['chatSessions'] })
      addNotification({ type: 'success', message: 'User space switched.' })
      window.location.reload()
    },
    onError: (error: any) => {
      addNotification({
        type: 'error',
        message:
          error?.response?.data?.error || error?.message || 'Failed to switch user space.',
      })
    },
  })

  if (isLoading || !data?.current || !data?.users?.length) {
    return null
  }

  const currentUserId = data.current.user.id

  return (
    <div className={compact ? 'flex items-center gap-2' : 'rounded-lg border border-border-subtle bg-surface-primary p-3'}>
      {!compact && (
        <div className="mb-2">
          <div className="text-xs uppercase tracking-wide text-text-muted">User Space</div>
          <div className="text-sm text-text-primary">
            {data.family?.name || 'Family'} · {data.current.user.role}
          </div>
        </div>
      )}
      <select
        value={String(currentUserId)}
        disabled={switchMutation.isPending}
        onChange={(event) => {
          const nextUserId = Number(event.target.value)
          if (!Number.isFinite(nextUserId) || nextUserId === currentUserId) return
          switchMutation.mutate(nextUserId)
        }}
        className="block w-full rounded-md border border-border-default bg-surface-primary px-3 py-2 text-sm text-text-primary focus:outline focus:outline-2 focus:-outline-offset-2 focus:outline-primary"
      >
        {data.users.map((user) => (
          <option key={user.id} value={user.id}>
            {user.displayName} {user.role === 'admin' ? '(Admin)' : ''}
          </option>
        ))}
      </select>
    </div>
  )
}
