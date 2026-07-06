import { useState } from 'react'
import Footer from '~/components/Footer'
import ChatButton from '~/components/chat/ChatButton'
import ChatModal from '~/components/chat/ChatModal'
import useServiceInstalledStatus from '~/hooks/useServiceInstalledStatus'
import { SERVICE_NAMES } from '../../constants/service_names'
import { Link, router, usePage } from '@inertiajs/react'
import { IconArrowLeft } from '@tabler/icons-react'
import classNames from 'classnames'
import StyledButton from '~/components/StyledButton'
import api from '~/lib/api'

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const [isChatOpen, setIsChatOpen] = useState(false)
  const aiAssistantInstalled = useServiceInstalledStatus(SERVICE_NAMES.OLLAMA)
  const { userSpace } = usePage<{
    userSpace?: {
      user: { displayName: string; role: 'admin' | 'user' }
    } | null
  }>().props

  return (
    <div className="min-h-[100dvh] flex flex-col overflow-x-hidden">
      {
        window.location.pathname !== '/home' && (
          <Link
            href="/home"
            className="absolute top-4 left-4 z-20 flex items-center rounded-full border border-border-subtle bg-surface-primary/95 px-3 py-2 shadow-sm"
          >
            <IconArrowLeft className="mr-2" size={20} />
            <p className="text-sm md:text-base text-text-secondary">Back to Home</p>
          </Link>
        )}
      <div
        className={classNames(
          'relative p-4 md:p-2 flex gap-2 flex-col items-center justify-center cursor-pointer',
          window.location.pathname !== '/home' ? 'pt-16 md:pt-10' : 'pt-4'
        )}
        onClick={() => router.visit('/home')}
      >
        {userSpace && (
          <div className="absolute top-4 right-4 flex items-center gap-2 md:gap-3 rounded-lg border border-border-subtle bg-surface-primary px-3 py-2 shadow-sm max-w-[calc(100vw-1.5rem)]">
            <div className="text-right">
              <div className="text-sm font-semibold text-text-primary">{userSpace.user.displayName}</div>
              <div className="text-xs uppercase tracking-wide text-text-muted">{userSpace.user.role}</div>
            </div>
            <StyledButton
              size="sm"
              variant="outline"
              onClick={async (event) => {
                event.stopPropagation()
                await api.logout()
                window.location.href = '/login'
              }}
            >
              Log Out
            </StyledButton>
          </div>
        )}
        <img src="/project_nomad_logo.webp" alt="Project Nomad Logo" className="h-24 w-24 md:h-40 md:w-40" />
        <h1 className="text-3xl md:text-5xl font-bold text-desert-green text-center">Command Center</h1>
      </div>
      <hr className={
        classNames(
          'text-desert-green font-semibold h-[1.5px] bg-desert-green border-none',
          window.location.pathname !== '/home' ? 'mt-2 md:mt-0' : 'mt-0'
        )} />
      <div className="flex-1 w-full min-w-0 overflow-x-hidden bg-desert">{children}</div>
      <Footer />

      {!aiAssistantInstalled.loading && aiAssistantInstalled.isInstalled && (
        <>
          <ChatButton onClick={() => setIsChatOpen(true)} />
          <ChatModal open={isChatOpen} onClose={() => setIsChatOpen(false)} />
        </>
      )}
    </div>
  )
}
