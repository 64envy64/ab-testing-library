import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { App } from './App'
import { createDemoClient } from './client'
import { API_BASE, DEMO_ADMIN_TOKEN } from './config'
import './styles.css'

const rootElement = document.getElementById('root')
if (!rootElement) {
  throw new Error('Root element "#root" was not found in index.html')
}

const { client, connection, eventLog } = createDemoClient()

createRoot(rootElement).render(
  <StrictMode>
    <App
      client={client}
      connection={connection}
      eventLog={eventLog}
      apiBase={API_BASE}
      adminToken={DEMO_ADMIN_TOKEN}
    />
  </StrictMode>,
)
