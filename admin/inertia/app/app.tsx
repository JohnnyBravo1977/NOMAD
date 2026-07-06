/// <reference path="../../adonisrc.ts" />
/// <reference path="../../config/inertia.ts" />

import '../css/app.css'
import { createRoot } from 'react-dom/client'
import { createInertiaApp } from '@inertiajs/react'
import { resolvePageComponent } from '@adonisjs/inertia/helpers'
import ModalsProvider from '~/providers/ModalProvider'
import { TransmitProvider } from 'react-adonis-transmit'
import { generateUUID } from '~/lib/util'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ReactQueryDevtools } from '@tanstack/react-query-devtools'
import NotificationsProvider from '~/providers/NotificationProvider'
import { ThemeProvider } from '~/providers/ThemeProvider'
import { UsePageProps } from '../../types/system'

const appName = import.meta.env.VITE_APP_NAME || 'Project N.O.M.A.D.'
const queryClient = new QueryClient()
const SERVICE_WORKER_PATH = '/service-worker.js'

const LOCKED_VIEWPORT_CONTENT =
  'width=device-width, initial-scale=1, minimum-scale=1, maximum-scale=1, user-scalable=no, shrink-to-fit=no, viewport-fit=cover, interactive-widget=resizes-content'

// Patch the global crypto object for non-HTTPS/localhost contexts
if (!window.crypto?.randomUUID) {
  // @ts-ignore
  if (!window.crypto) window.crypto = {}
  // @ts-ignore
  window.crypto.randomUUID = generateUUID
}

const enforceLockedViewport = () => {
  const viewportMeta = document.querySelector('meta[name="viewport"]')
  if (!viewportMeta) return

  if (viewportMeta.getAttribute('content') !== LOCKED_VIEWPORT_CONTENT) {
    viewportMeta.setAttribute('content', LOCKED_VIEWPORT_CONTENT)
  }
}

enforceLockedViewport()
window.addEventListener('focusin', enforceLockedViewport)
window.addEventListener('focusout', enforceLockedViewport)
window.addEventListener('resize', enforceLockedViewport)
window.addEventListener('orientationchange', enforceLockedViewport)
window.visualViewport?.addEventListener('resize', enforceLockedViewport)

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(SERVICE_WORKER_PATH).catch((error) => {
      console.warn('NOMAD service worker registration failed:', error)
    })
  })
}

createInertiaApp({
  progress: { color: '#424420' },

  title: (title) => `${title} - ${appName}`,

  resolve: (name) => {
    return resolvePageComponent(`../pages/${name}.tsx`, import.meta.glob('../pages/**/*.tsx'))
  },

  setup({ el, App, props }) {
    const environment = (props.initialPage.props as unknown as UsePageProps).environment
    const showDevtools = ['development', 'staging'].includes(environment)
    createRoot(el).render(
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <TransmitProvider baseUrl={window.location.origin} enableLogging={environment === 'development'}>
            <NotificationsProvider>
              <ModalsProvider>
                <App {...props} />
                {showDevtools && <ReactQueryDevtools initialIsOpen={false} buttonPosition='bottom-left' />}
              </ModalsProvider>
            </NotificationsProvider>
          </TransmitProvider>
        </ThemeProvider>
      </QueryClientProvider>
    )
  },
})
