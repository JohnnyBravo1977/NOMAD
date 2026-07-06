import { Head } from '@inertiajs/react'
import { useMutation } from '@tanstack/react-query'
import { useState } from 'react'
import StyledButton from '~/components/StyledButton'
import Input from '~/components/inputs/Input'
import { useNotifications } from '~/context/NotificationContext'
import api from '~/lib/api'

type LoginPageProps = {
  loginSupport?: {
    defaultRole?: 'admin' | 'user'
    privateDataNotice?: string
  }
}

export default function LoginPage({ loginSupport }: LoginPageProps) {
  const { addNotification } = useNotifications()
  const [username, setUsername] = useState('')
  const [pin, setPin] = useState('')
  const [showQuickCreate, setShowQuickCreate] = useState(false)
  const [adminUsername, setAdminUsername] = useState('')
  const [adminPin, setAdminPin] = useState('')
  const [newName, setNewName] = useState('')
  const [newUsername, setNewUsername] = useState('')
  const [newPin, setNewPin] = useState('')
  const [newRole, setNewRole] = useState<'admin' | 'user'>(loginSupport?.defaultRole || 'user')

  const loginMutation = useMutation({
    mutationFn: () => api.login({ username, pin }),
    onSuccess: () => {
      window.location.href = '/home'
    },
    onError: (error: any) => {
      addNotification({
        type: 'error',
        message: error?.response?.data?.error || error?.message || 'Login failed.',
      })
    },
  })

  const quickCreateMutation = useMutation({
    mutationFn: () =>
      api.quickCreateUserFromLogin({
        adminUsername,
        adminPin,
        displayName: newName,
        username: newUsername,
        pin: newPin,
        role: newRole,
      }),
    onSuccess: (result) => {
      addNotification({
        type: 'success',
        message: `${result?.user?.displayName || 'User'} created. They can sign in now.`,
      })
      setUsername(newUsername)
      setPin(newPin)
      setAdminUsername('')
      setAdminPin('')
      setNewName('')
      setNewUsername('')
      setNewPin('')
      setNewRole(loginSupport?.defaultRole || 'user')
      setShowQuickCreate(false)
    },
    onError: (error: any) => {
      addNotification({
        type: 'error',
        message: error?.response?.data?.error || error?.message || 'Failed to create user.',
      })
    },
  })

  return (
    <div className="min-h-screen bg-desert flex items-center justify-center px-4 sm:px-6 py-6">
      <Head title="Login | Project N.O.M.A.D." />
      <div className="w-full max-w-md rounded-2xl border border-border-subtle bg-surface-primary p-6 sm:p-8 shadow-xl">
        <div className="mb-6 text-center">
          <img
            src="/project_nomad_logo.webp"
            alt="Project Nomad Logo"
            className="mx-auto mb-4 h-20 w-20 sm:h-24 sm:w-24"
          />
          <h1 className="text-2xl sm:text-3xl font-bold text-desert-green">Welcome Back</h1>
          <p className="mt-2 text-sm text-text-muted">
            Sign in with your username and PIN to open your N.O.M.A.D. space.
          </p>
        </div>

        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault()
            loginMutation.mutate()
          }}
        >
          <Input
            name="username"
            label="Username"
            value={username}
            autoComplete="username"
            onChange={(event) => setUsername(event.target.value)}
          />
          <Input
            name="pin"
            label="PIN"
            type="password"
            inputMode="numeric"
            autoComplete="current-password"
            value={pin}
            onChange={(event) => setPin(event.target.value)}
            helpText="Use the PIN your admin created for this user."
          />
          <StyledButton
            type="submit"
            fullWidth
            loading={loginMutation.isPending}
            disabled={!username.trim() || !pin.trim()}
          >
            Sign In
          </StyledButton>
        </form>

        <div className="mt-6 rounded-xl border border-border-subtle bg-surface-secondary/70 p-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-sm font-semibold text-text-primary">Need to add someone first?</h2>
              <p className="mt-1 text-sm text-text-muted">
                Admin can create a user right here without going into Settings first.
              </p>
            </div>
            <StyledButton
              variant={showQuickCreate ? 'ghost' : 'outline'}
              size="sm"
              onClick={() => setShowQuickCreate((value) => !value)}
            >
              {showQuickCreate ? 'Hide' : 'Create User'}
            </StyledButton>
          </div>

          {showQuickCreate && (
            <form
              className="mt-4 space-y-4"
              onSubmit={(event) => {
                event.preventDefault()
                quickCreateMutation.mutate()
              }}
            >
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Input
                  name="adminUsername"
                  label="Admin Username"
                  value={adminUsername}
                  autoComplete="username"
                  onChange={(event) => setAdminUsername(event.target.value.toLowerCase())}
                />
                <Input
                  name="adminPin"
                  label="Admin PIN"
                  type="password"
                  inputMode="numeric"
                  autoComplete="current-password"
                  value={adminPin}
                  onChange={(event) => setAdminPin(event.target.value)}
                />
              </div>

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Input
                  name="newDisplayName"
                  label="New User Name"
                  value={newName}
                  onChange={(event) => setNewName(event.target.value)}
                />
                <Input
                  name="newUsername"
                  label="New Username"
                  value={newUsername}
                  onChange={(event) => setNewUsername(event.target.value.toLowerCase())}
                  helpText="Lowercase letters, numbers, and dashes only."
                />
                <Input
                  name="newPin"
                  label="New PIN"
                  type="password"
                  inputMode="numeric"
                  value={newPin}
                  onChange={(event) => setNewPin(event.target.value)}
                />
                <div>
                  <label className="block text-base/6 font-medium text-text-primary">Role</label>
                  <select
                    value={newRole}
                    onChange={(event) => setNewRole(event.target.value as 'admin' | 'user')}
                    className="mt-1.5 block w-full rounded-md border border-border-default bg-surface-primary px-3 py-2 text-sm text-text-primary"
                  >
                    <option value="user">User</option>
                    <option value="admin">Admin</option>
                  </select>
                </div>
              </div>

              <div className="rounded-lg bg-surface-primary p-3 text-sm text-text-muted">
                {loginSupport?.privateDataNotice ||
                  'Each user keeps their own chats and private memory. Only family-shared memory is shared across users.'}
              </div>

              <StyledButton
                type="submit"
                fullWidth
                loading={quickCreateMutation.isPending}
                disabled={
                  !adminUsername.trim() ||
                  !adminPin.trim() ||
                  !newName.trim() ||
                  !newUsername.trim() ||
                  !newPin.trim()
                }
              >
                Create User
              </StyledButton>
            </form>
          )}
        </div>
      </div>
    </div>
  )
}
