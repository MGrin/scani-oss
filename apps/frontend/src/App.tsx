import { Route, BrowserRouter as Router, Routes } from 'react-router-dom';
import { Layout } from '@/components/Layout';
import { Toaster } from '@/components/ui/toaster';
import { ThemeLoader, ThemeProvider } from '@/contexts/ThemeContext';
import { SessionStatusIndicator, SessionTimeoutProvider } from '@/hooks/useSessionTimeout';
import { TRPCProvider } from '@/lib/trpc-provider';
import { Accounts } from '@/pages/Accounts';
import { Analytics } from '@/pages/Analytics';
import { Dashboard } from '@/pages/Dashboard';
import { Holdings } from '@/pages/Holdings';
import { Institutions } from '@/pages/Institutions';
import { Settings } from '@/pages/Settings';
import { Transactions } from '@/pages/Transactions';

function App() {
  // Handle session timeout - in a real app this would trigger logout/redirect
  const handleSessionTimeout = () => {
    console.warn('Session expired due to inactivity');
    // Here you would typically:
    // 1. Clear user session/tokens
    // 2. Redirect to login page
    // 3. Show appropriate messaging
    // For demo purposes, we'll just log a warning
  };

  return (
    <TRPCProvider>
      <ThemeProvider>
        <ThemeLoader>
          <SessionTimeoutProvider
            onTimeout={handleSessionTimeout}
            config={{
              timeoutMinutes: 30, // 30 minute timeout
              warningMinutes: 5, // Show warning 5 minutes before
              checkIntervalSeconds: 30, // Check every 30 seconds
            }}
          >
            <Router>
              <Layout>
                <Routes>
                  <Route path="/" element={<Dashboard />} />
                  <Route path="/analytics" element={<Analytics />} />
                  <Route path="/holdings" element={<Holdings />} />
                  <Route path="/transactions" element={<Transactions />} />
                  <Route path="/accounts" element={<Accounts />} />
                  <Route path="/institutions" element={<Institutions />} />
                  <Route path="/settings" element={<Settings />} />
                </Routes>
              </Layout>
              <SessionStatusIndicator />
              <Toaster />
            </Router>
          </SessionTimeoutProvider>
        </ThemeLoader>
      </ThemeProvider>
    </TRPCProvider>
  );
}

export default App;
