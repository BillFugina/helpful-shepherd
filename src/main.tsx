import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createTRPCClient, httpBatchLink } from '@trpc/client'
import { StrictMode, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { createBrowserRouter, RouterProvider } from 'react-router'
import superjson from 'superjson'
import type { AppRouter } from '../server/routers/index.js'
import { TRPCProvider } from './lib/trpc'
import { AccessPage } from './pages/AccessPage'
import { AuditPage } from './pages/AuditPage'
import { HomePage } from './pages/HomePage'
import { Layout } from './pages/Layout'
import { PeoplePage } from './pages/PeoplePage'
import { SetupTwoFactorPage } from './pages/SetupTwoFactorPage'
import { SignInPage } from './pages/SignInPage'
import { RequireStaff } from './pages/RequireStaff'
import './styles.css'

const router = createBrowserRouter([
  {
    element: <Layout />,
    children: [
      { path: '/', element: <HomePage /> },
      { path: '/sign-in', element: <SignInPage /> },
      { path: '/setup-2fa', element: <SetupTwoFactorPage /> },
      {
        element: <RequireStaff />,
        children: [
          { path: '/people', element: <PeoplePage /> },
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

const root = document.getElementById('root')
if (!root) throw new Error('#root missing')
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
