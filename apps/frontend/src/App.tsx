import { Route, BrowserRouter as Router, Routes } from 'react-router-dom';
import { Layout } from '@/components/Layout';
import { ProtectedRoute } from '@/components/ProtectedRoute';
import { Toaster } from '@/components/ui/toaster';
import { AuthProvider } from '@/contexts/AuthContext';
import { ThemeLoader, ThemeProvider } from '@/contexts/ThemeContext';
import { TRPCProvider } from '@/lib/trpc-provider';
import { Accounts } from '@/pages/Accounts';
import { Analytics } from '@/pages/Analytics';
import { Auth } from '@/pages/Auth';
import { AuthCallback } from '@/pages/AuthCallback';
import { Dashboard } from '@/pages/Dashboard';
import { Holdings } from '@/pages/Holdings';
import { Institutions } from '@/pages/Institutions';
import { QuickAddHolding } from '@/pages/QuickAddHolding';
import { Settings } from '@/pages/Settings';
import { Tokens } from '@/pages/Tokens';
import { Transactions } from '@/pages/Transactions';

function App() {
  return (
    <AuthProvider>
      <TRPCProvider>
        <ThemeProvider>
          <ThemeLoader>
            <Router
              future={{
                v7_startTransition: true,
                v7_relativeSplatPath: true,
              }}
            >
              <Routes>
                {/* Public routes */}
                <Route path="/auth" element={<Auth />} />
                <Route path="/signin" element={<Auth />} />
                <Route path="/signup" element={<Auth />} />
                <Route path="/auth/callback" element={<AuthCallback />} />

                {/* Protected routes */}
                <Route
                  path="/"
                  element={
                    <ProtectedRoute>
                      <Layout>
                        <Dashboard />
                      </Layout>
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="/analytics"
                  element={
                    <ProtectedRoute>
                      <Layout>
                        <Analytics />
                      </Layout>
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="/holdings"
                  element={
                    <ProtectedRoute>
                      <Layout>
                        <Holdings />
                      </Layout>
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="/transactions"
                  element={
                    <ProtectedRoute>
                      <Layout>
                        <Transactions />
                      </Layout>
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="/accounts"
                  element={
                    <ProtectedRoute>
                      <Layout>
                        <Accounts />
                      </Layout>
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="/institutions"
                  element={
                    <ProtectedRoute>
                      <Layout>
                        <Institutions />
                      </Layout>
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="/institutions/:institutionId"
                  element={
                    <ProtectedRoute>
                      <Layout>
                        <Accounts />
                      </Layout>
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="/institutions/:institutionId/accounts/:accountId"
                  element={
                    <ProtectedRoute>
                      <Layout>
                        <Holdings />
                      </Layout>
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="/institutions/:institutionId/accounts/:accountId/holdings/:holdingId"
                  element={
                    <ProtectedRoute>
                      <Layout>
                        <Transactions />
                      </Layout>
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="/tokens"
                  element={
                    <ProtectedRoute>
                      <Layout>
                        <Tokens />
                      </Layout>
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="/quick-add-holding"
                  element={
                    <ProtectedRoute>
                      <Layout>
                        <QuickAddHolding />
                      </Layout>
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="/settings"
                  element={
                    <ProtectedRoute>
                      <Layout>
                        <Settings />
                      </Layout>
                    </ProtectedRoute>
                  }
                />
              </Routes>
            </Router>
            <Toaster />
          </ThemeLoader>
        </ThemeProvider>
      </TRPCProvider>
    </AuthProvider>
  );
}

export default App;
