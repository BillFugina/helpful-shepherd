import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createTRPCClient, httpBatchLink } from '@trpc/client'
import { StrictMode, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { createBrowserRouter, RouterProvider } from 'react-router'
import superjson from 'superjson'
import type { AppRouter } from '../server/routers/index.js'
import { registerServiceWorker } from './lib/push'
import { TRPCProvider } from './lib/trpc'
import { AccessPage } from './pages/AccessPage'
import { AgentsPage } from './pages/AgentsPage'
import { AlertsPage } from './pages/AlertsPage'
import { ArrivalsPage } from './pages/ArrivalsPage'
import { AuditPage } from './pages/AuditPage'
import { ConnectionsPage } from './pages/ConnectionsPage'
import { ContractPage, ContractSettingsPage, ProductionContractsPage } from './pages/ContractPages'
import { ConnectPage } from './pages/ConnectPage'
import { DemoPage } from './pages/DemoPage'
import { DocumentSettingsPage, DocumentsPage, ProductionDocumentsPage, UploadPage } from './pages/DocumentPages'
import { DraftsPage } from './pages/DraftsPage'
import { EngagementPage } from './pages/EngagementPage'
import { FastEntryPage } from './pages/FastEntryPage'
import { HomePage } from './pages/HomePage'
import { HousingPage, HousingPlanPage } from './pages/HousingPage'
import { ImportPage } from './pages/ImportPage'
import { Layout } from './pages/Layout'
import { PeoplePage } from './pages/PeoplePage'
import { PersonPage } from './pages/PersonPage'
import { SeasonPage } from './pages/SeasonPage'
import { SeasonsPage } from './pages/SeasonsPage'
import { RequestPasswordLinkPage, SetPasswordPage } from './pages/SetPasswordPage'
import { SetupTwoFactorPage } from './pages/SetupTwoFactorPage'
import { SignInPage } from './pages/SignInPage'
import { TravelPage } from './pages/TravelPage'
import { RequireStaff } from './pages/RequireStaff'
import './styles.css'

const router = createBrowserRouter([
  // Opened from an upload link by someone with no account: no app chrome.
  { path: '/upload/:token', element: <UploadPage /> },
  {
    element: <Layout />,
    children: [
      { path: '/', element: <HomePage /> },
      { path: '/sign-in', element: <SignInPage /> },
      { path: '/set-password', element: <RequestPasswordLinkPage /> },
      { path: '/set-password/:token', element: <SetPasswordPage /> },
      { path: '/demo', element: <DemoPage /> },
      { path: '/setup-2fa', element: <SetupTwoFactorPage /> },
      { path: '/connect', element: <ConnectPage /> },
      {
        element: <RequireStaff />,
        children: [
          { path: '/seasons', element: <SeasonsPage /> },
          { path: '/seasons/:seasonId', element: <SeasonPage /> },
          { path: '/productions/:productionId/add', element: <FastEntryPage /> },
          { path: '/productions/:productionId/import', element: <ImportPage /> },
          { path: '/engagements/:engagementId', element: <EngagementPage /> },
          { path: '/engagements/:engagementId/travel', element: <TravelPage /> },
          { path: '/productions/:productionId/contracts', element: <ProductionContractsPage /> },
          { path: '/contracts/settings', element: <ContractSettingsPage /> },
          { path: '/contracts/:contractId', element: <ContractPage /> },
          { path: '/productions/:productionId/documents', element: <ProductionDocumentsPage /> },
          { path: '/documents', element: <DocumentsPage /> },
          { path: '/documents/settings', element: <DocumentSettingsPage /> },
          { path: '/arrivals', element: <ArrivalsPage /> },
          { path: '/housing', element: <HousingPage /> },
          { path: '/housing/plan', element: <HousingPlanPage /> },
          { path: '/people', element: <PeoplePage /> },
          { path: '/people/:personId', element: <PersonPage /> },
          { path: '/agents', element: <AgentsPage /> },
          { path: '/drafts', element: <DraftsPage /> },
          { path: '/settings/connections', element: <ConnectionsPage /> },
          { path: '/settings/alerts', element: <AlertsPage /> },
          { path: '/admin/access', element: <AccessPage /> },
          { path: '/admin/audit', element: <AuditPage /> },
        ],
      },
    ],
  },
])

function App() {
  const [queryClient] = useState(
    () => new QueryClient({ defaultOptions: { queries: { staleTime: 30_000, retry: false } } }),
  )
  const [trpcClient] = useState(() =>
    createTRPCClient<AppRouter>({
      links: [httpBatchLink({ url: '/api/trpc', transformer: superjson })],
    }),
  )
  return (
    <QueryClientProvider client={queryClient}>
      <TRPCProvider trpcClient={trpcClient} queryClient={queryClient}>
        <RouterProvider router={router} />
      </TRPCProvider>
    </QueryClientProvider>
  )
}

// For phone alerts: the browser needs the service worker registered to wake it later.
registerServiceWorker()

const root = document.getElementById('root')
if (!root) throw new Error('#root missing')
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
