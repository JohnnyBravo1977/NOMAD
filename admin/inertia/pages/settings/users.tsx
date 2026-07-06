import { Head } from '@inertiajs/react'
import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import SettingsLayout from '~/layouts/SettingsLayout'
import StyledButton from '~/components/StyledButton'
import Input from '~/components/inputs/Input'
import Switch from '~/components/inputs/Switch'
import { useNotifications } from '~/context/NotificationContext'
import api from '~/lib/api'

type UserRecord = {
  id: number
  slug: string
  display_name: string
  role: 'admin' | 'user'
  is_active: boolean
}

function UserCard({
  user,
  isCurrent,
  onSave,
}: {
  user: UserRecord
  isCurrent: boolean
  onSave: (
    userId: number,
    data: {
      displayName?: string
      username?: string
      pin?: string
      role?: 'admin' | 'user'
      isActive?: boolean
    }
  ) => void
}) {
  const [displayName, setDisplayName] = useState(user.display_name)
  const [username, setUsername] = useState(user.slug)
  const [pin, setPin] = useState('')

  return (
    <div className="rounded-lg border border-border-subtle bg-surface-secondary p-4">
      <div className="mb-3 text-sm text-text-muted">
        {isCurrent ? 'Current user' : 'Family user'} · {user.is_active ? 'active' : 'inactive'}
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-4 items-end">
        <Input
          name={`display-${user.id}`}
          label="Display Name"
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
        />
        <Input
          name={`username-${user.id}`}
          label="Username"
          value={username}
          onChange={(event) => setUsername(event.target.value.toLowerCase())}
        />
        <Input
          name={`pin-${user.id}`}
          label="Reset PIN"
          type="password"
          inputMode="numeric"
          value={pin}
          onChange={(event) => setPin(event.target.value)}
          helpText="Leave blank to keep the current PIN."
        />
        <div>
          <label className="block text-base/6 font-medium text-text-primary">Role</label>
          <select
            value={user.role}
            onChange={(event) =>
              onSave(user.id, {
                role: event.target.value as 'admin' | 'user',
              })
            }
            className="mt-1.5 block w-full rounded-md border border-border-default bg-surface-primary px-3 py-2 text-sm text-text-primary"
          >
            <option value="user">User</option>
            <option value="admin">Admin</option>
          </select>
        </div>
        <div className="flex items-center gap-3">
          <Switch
            checked={user.is_active}
            label="Active"
            onChange={(checked) => onSave(user.id, { isActive: checked })}
          />
          <StyledButton
            variant="outline"
            onClick={() =>
              onSave(user.id, {
                displayName: displayName.trim(),
                username: username.trim(),
                pin: pin.trim() || undefined,
              })
            }
          >
            Save
          </StyledButton>
        </div>
      </div>
    </div>
  )
}

export default function UsersPage(props: {
  userSpaces: {
    current: any
    users: UserRecord[]
    family: {
      id: number
      name: string
      slug: string
      allowMemberFamilyUploads: boolean
    }
  }
}) {
  const queryClient = useQueryClient()
  const { addNotification } = useNotifications()
  const [newName, setNewName] = useState('')
  const [newUsername, setNewUsername] = useState('')
  const [newPin, setNewPin] = useState('')
  const [newRole, setNewRole] = useState<'admin' | 'user'>('user')
  const [familyUploadsAllowed, setFamilyUploadsAllowed] = useState(
    props.userSpaces.family.allowMemberFamilyUploads
  )

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['user-space-context'] })
    window.location.reload()
  }

  const createUser = useMutation({
    mutationFn: () =>
      api.createUser({
        displayName: newName,
        username: newUsername,
        pin: newPin,
        role: newRole,
      }),
    onSuccess: () => {
      addNotification({ type: 'success', message: 'User created.' })
      setNewName('')
      setNewUsername('')
      setNewPin('')
      setNewRole('user')
      refresh()
    },
    onError: (error: any) => {
      addNotification({
        type: 'error',
        message: error?.response?.data?.message || error?.message || 'Failed to create user.',
      })
    },
  })

  const updateFamily = useMutation({
    mutationFn: (allowMemberFamilyUploads: boolean) =>
      api.updateFamilySettings({ allowMemberFamilyUploads }),
    onSuccess: () => {
      addNotification({ type: 'success', message: 'Family settings updated.' })
    },
    onError: (error: any) => {
      addNotification({
        type: 'error',
        message:
          error?.response?.data?.message || error?.message || 'Failed to update family settings.',
      })
    },
  })

  const updateUser = useMutation({
    mutationFn: (payload: {
      userId: number
      data: {
        displayName?: string
        username?: string
        pin?: string
        role?: 'admin' | 'user'
        isActive?: boolean
      }
    }) => api.updateUser(payload.userId, payload.data),
    onSuccess: () => {
      addNotification({ type: 'success', message: 'User updated.' })
      refresh()
    },
    onError: (error: any) => {
      addNotification({
        type: 'error',
        message: error?.response?.data?.message || error?.message || 'Failed to update user.',
      })
    },
  })

  return (
    <SettingsLayout>
      <Head title="Users | Project N.O.M.A.D." />
      <div className="xl:pl-72 w-full">
        <main className="px-6 lg:px-12 py-6 lg:py-8 max-w-5xl">
          <div className="mb-8">
            <h1 className="text-4xl font-bold text-desert-green mb-2">Users</h1>
            <p className="text-text-muted">
              Manage family users, roles, usernames, PINs, and shared-space behavior for this
              device.
            </p>
          </div>

          <section className="rounded-xl border border-border-subtle bg-surface-primary p-6 mb-8">
            <h2 className="text-xl font-semibold text-text-primary mb-4">Family Settings</h2>
            <div className="mb-4 text-sm text-text-muted">
              Family: <span className="text-text-primary">{props.userSpaces.family.name}</span>
            </div>
            <Switch
              checked={familyUploadsAllowed}
              label="Allow non-admin family-shared uploads"
              description="When off, only admins can upload directly into the family shared library."
              onChange={(checked) => {
                setFamilyUploadsAllowed(checked)
                updateFamily.mutate(checked)
              }}
            />
          </section>

          <section className="rounded-xl border border-border-subtle bg-surface-primary p-6 mb-8">
            <h2 className="text-xl font-semibold text-text-primary mb-4">Create User</h2>
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4 items-end">
              <Input
                name="displayName"
                label="Display Name"
                value={newName}
                onChange={(event) => setNewName(event.target.value)}
              />
              <Input
                name="username"
                label="Username"
                value={newUsername}
                onChange={(event) => setNewUsername(event.target.value.toLowerCase())}
              />
              <Input
                name="pin"
                label="PIN"
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
            <div className="mt-4">
              <StyledButton
                onClick={() => createUser.mutate()}
                disabled={!newName.trim() || !newUsername.trim() || !newPin.trim()}
                loading={createUser.isPending}
              >
                Add User
              </StyledButton>
            </div>
          </section>

          <section className="rounded-xl border border-border-subtle bg-surface-primary p-6">
            <h2 className="text-xl font-semibold text-text-primary mb-4">Existing Users</h2>
            <div className="space-y-4">
              {props.userSpaces.users.map((user) => (
                <UserCard
                  key={user.id}
                  user={user}
                  isCurrent={props.userSpaces.current.user.id === user.id}
                  onSave={(userId, data) => updateUser.mutate({ userId, data })}
                />
              ))}
            </div>
          </section>
        </main>
      </div>
    </SettingsLayout>
  )
}
