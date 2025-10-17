import { Route, BrowserRouter as Router, Routes } from 'react-router-dom';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { Layout } from '@/components/Layout';
import { OnboardingWizard } from '@/components/onboarding/OnboardingWizard';
import { ProtectedRoute } from '@/components/ProtectedRoute';
import { Toaster } from '@/components/ui/toaster';
import { AuthProvider } from '@/contexts/AuthContext';
import { EntityDataProvider } from '@/contexts/EntityDataContext';
import { ThemeLoader, ThemeProvider } from '@/contexts/ThemeContext';
import { TRPCProvider } from '@/lib/trpc-provider';
import { Accounts } from '@/pages/Accounts';
import { AddData } from '@/pages/AddData';
import { Auth } from '@/pages/Auth';
import { AuthCallback } from '@/pages/AuthCallback';
import { Dashboard } from '@/pages/Dashboard';
import { Holdings } from '@/pages/Holdings';
import { Institutions } from '@/pages/Institutions';
import { Settings } from '@/pages/Settings';
import { Tokens } from '@/pages/Tokens';

function App() {
  return (
    <ErrorBoundary>
      <AuthProvider>
        <TRPCProvider>
          <EntityDataProvider>
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
                      path="/add-data"
                      element={
                        <ProtectedRoute>
                          <Layout>
                            <AddData />
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
                  <OnboardingWizard />
                  <Toaster />
                </Router>
              </ThemeLoader>
            </ThemeProvider>
          </EntityDataProvider>
        </TRPCProvider>
      </AuthProvider>
    </ErrorBoundary>
  );
}

export default App;
