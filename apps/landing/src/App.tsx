import { motion } from 'framer-motion';
import {
  ArrowRight,
  BarChart3,
  CheckCircle,
  Database,
  Globe,
  Lock,
  Menu,
  Network,
  Shield,
  TrendingUp,
  Wallet,
  X,
  Zap,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { useInView } from 'react-intersection-observer';

const fadeInUp = {
  initial: { opacity: 0, y: 40 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.5, ease: 'easeOut' },
};

const staggerContainer = {
  animate: {
    transition: {
      staggerChildren: 0.08,
    },
  },
};

function FadeInSection({ children, delay = 0 }: { children: React.ReactNode; delay?: number }) {
  const [ref, inView] = useInView({
    triggerOnce: true,
    threshold: 0.1,
  });

  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0, y: 40 }}
      animate={inView ? { opacity: 1, y: 0 } : { opacity: 0, y: 40 }}
      transition={{ duration: 0.5, delay, ease: 'easeOut' }}
    >
      {children}
    </motion.div>
  );
}

function App() {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && mobileMenuOpen) {
        setMobileMenuOpen(false);
      }
    };

    if (mobileMenuOpen) {
      document.addEventListener('keydown', handleEscape);
      return () => document.removeEventListener('keydown', handleEscape);
    }
  }, [mobileMenuOpen]);

  return (
    <div className="min-h-screen bg-white">
      {/* Navigation */}
      <nav className="fixed top-0 w-full bg-white/95 backdrop-blur-md border-b border-gray-200 z-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center h-16">
            <div className="flex items-center">
              <div className="flex items-center space-x-3">
                <div className="w-8 h-8 rounded-lg overflow-hidden flex items-center justify-center">
                  <img
                    src="/icons/icon-192x192.png"
                    alt="Scani Logo"
                    className="w-full h-full object-contain"
                  />
                </div>
                <div className="text-2xl font-semibold text-gray-900">Scani</div>
              </div>
            </div>

            {/* Desktop Navigation */}
            <div className="hidden md:flex items-center space-x-8">
              <a
                href="#integrations"
                className="text-gray-600 hover:text-gray-900 transition-colors text-sm font-medium"
              >
                Integrations
              </a>
              <a
                href="#analytics"
                className="text-gray-600 hover:text-gray-900 transition-colors text-sm font-medium"
              >
                Analytics
              </a>
              <a
                href="#security"
                className="text-gray-600 hover:text-gray-900 transition-colors text-sm font-medium"
              >
                Security
              </a>
              <button
                type="button"
                className="bg-gray-900 text-white px-5 py-2 rounded-lg hover:bg-gray-800 transition-colors text-sm font-medium flex items-center gap-2"
                onClick={() => window.open('https://app.scani.xyz', '_blank')}
              >
                Sign In
                <ArrowRight className="w-4 h-4" />
              </button>
            </div>

            {/* Mobile menu button */}
            <div className="md:hidden">
              <button
                type="button"
                onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
                className="text-gray-600 hover:text-gray-900 transition-colors p-2"
                aria-label="Toggle menu"
              >
                {mobileMenuOpen ? <X className="w-6 h-6" /> : <Menu className="w-6 h-6" />}
              </button>
            </div>
          </div>
        </div>

        {/* Mobile Navigation Menu */}
        {mobileMenuOpen && (
          <div className="md:hidden bg-white border-t border-gray-200">
            <div className="px-4 py-4 space-y-3">
              {/* biome-ignore lint/a11y/useValidAnchor: Hash navigation for same-page sections */}
              <a
                href="#integrations"
                className="block text-gray-600 hover:text-gray-900 transition-colors py-2 text-sm font-medium"
                onClick={() => setMobileMenuOpen(false)}
              >
                Integrations
              </a>
              {/* biome-ignore lint/a11y/useValidAnchor: Hash navigation for same-page sections */}
              <a
                href="#analytics"
                className="block text-gray-600 hover:text-gray-900 transition-colors py-2 text-sm font-medium"
                onClick={() => setMobileMenuOpen(false)}
              >
                Analytics
              </a>
              {/* biome-ignore lint/a11y/useValidAnchor: Hash navigation for same-page sections */}
              <a
                href="#security"
                className="block text-gray-600 hover:text-gray-900 transition-colors py-2 text-sm font-medium"
                onClick={() => setMobileMenuOpen(false)}
              >
                Security
              </a>
              <button
                type="button"
                className="w-full bg-gray-900 text-white px-5 py-2 rounded-lg hover:bg-gray-800 transition-colors text-sm font-medium flex items-center justify-center gap-2"
                onClick={() => {
                  setMobileMenuOpen(false);
                  window.open('https://app.scani.xyz', '_blank');
                }}
              >
                Sign In
                <ArrowRight className="w-4 h-4" />
              </button>
            </div>
          </div>
        )}
      </nav>

      {/* Hero Section */}
      <section className="relative pt-24 pb-16 px-4 sm:px-6 lg:px-8 overflow-hidden bg-gradient-to-b from-gray-50 to-white">
        <div className="absolute inset-0">
          <div className="absolute top-0 left-1/4 w-96 h-96 bg-gray-200/30 rounded-full blur-3xl" />
          <div className="absolute bottom-0 right-1/4 w-96 h-96 bg-gray-200/20 rounded-full blur-3xl" />
        </div>

        <div className="relative max-w-7xl mx-auto">
          <motion.div
            initial="initial"
            animate="animate"
            variants={staggerContainer}
            className="text-center max-w-4xl mx-auto"
          >
            <motion.div variants={fadeInUp} className="mb-6">
              <div className="inline-flex items-center px-4 py-2 rounded-full bg-gray-100 border border-gray-200 text-gray-700 text-sm font-medium mb-8">
                <Zap className="w-4 h-4 mr-2 text-gray-600" />
                Unified Wealth Management Platform
              </div>
              <h1 className="text-5xl sm:text-6xl lg:text-7xl font-bold text-gray-900 mb-6 leading-tight tracking-tight">
                Comprehensive wealth view for modern investors
              </h1>
              <p className="text-xl text-gray-600 max-w-3xl mx-auto mb-10 leading-relaxed">
                Aggregate accounts across brokers, banks, and crypto exchanges. Real-time analytics,
                multi-currency support, and institutional-grade portfolio insights.
              </p>
            </motion.div>

            <motion.div
              variants={fadeInUp}
              className="flex flex-col sm:flex-row gap-4 justify-center mb-12"
            >
              <button
                type="button"
                className="group bg-gray-900 text-white px-8 py-4 rounded-lg hover:bg-gray-800 transition-all duration-200 flex items-center justify-center gap-2 text-lg font-semibold shadow-lg hover:shadow-xl"
                onClick={() => window.open('https://app.scani.xyz', '_blank')}
              >
                Open Dashboard
                <ArrowRight className="w-5 h-5 group-hover:translate-x-1 transition-transform" />
              </button>
              <button
                type="button"
                className="group bg-white text-gray-900 px-8 py-4 rounded-lg hover:bg-gray-50 transition-all duration-200 flex items-center justify-center gap-2 text-lg font-semibold border border-gray-200 shadow-sm"
                onClick={() =>
                  document.getElementById('integrations')?.scrollIntoView({ behavior: 'smooth' })
                }
              >
                View Integrations
              </button>
            </motion.div>

            <motion.div
              variants={fadeInUp}
              className="flex flex-wrap items-center justify-center gap-6 text-sm text-gray-500"
            >
              <div className="flex items-center gap-2">
                <CheckCircle className="w-4 h-4 text-green-600" />
                <span className="font-medium">Multi-currency tracking</span>
              </div>
              <div className="flex items-center gap-2">
                <CheckCircle className="w-4 h-4 text-green-600" />
                <span className="font-medium">Real-time portfolio sync</span>
              </div>
              <div className="flex items-center gap-2">
                <CheckCircle className="w-4 h-4 text-green-600" />
                <span className="font-medium">Institutional security</span>
              </div>
            </motion.div>
          </motion.div>
        </div>
      </section>

      {/* Integrations Section */}
      <section id="integrations" className="py-20 px-4 sm:px-6 lg:px-8 bg-white">
        <div className="max-w-7xl mx-auto">
          <FadeInSection>
            <div className="text-center mb-16">
              <h2 className="text-4xl sm:text-5xl font-bold text-gray-900 mb-4">
                Connect all your accounts
              </h2>
              <p className="text-xl text-gray-600 max-w-2xl mx-auto">
                Comprehensive integration with brokers, banks, and cryptocurrency platforms.
                Centralize your wealth in one unified view.
              </p>
            </div>
          </FadeInSection>

          <div className="grid md:grid-cols-3 gap-8 mb-16">
            {[
              {
                icon: Wallet,
                title: 'Cryptocurrency Exchanges',
                description:
                  'Direct API integration with Binance and Kraken. Automatic balance sync, real-time holdings import, and multi-asset tracking.',
                items: ['Binance', 'Kraken', 'More coming soon'],
                status: 'active',
              },
              {
                icon: Database,
                title: 'Banks & Brokers',
                description:
                  'Secure connections via Plaid for banking and brokerage accounts. Read-only access with OAuth-based authentication.',
                items: ['Plaid integration', 'US banks & brokers', 'International support'],
                status: 'coming-soon',
                badge: 'Coming Soon',
              },
              {
                icon: Network,
                title: 'Blockchain Wallets',
                description:
                  'Import holdings from cryptocurrency wallets across multiple blockchains. Support for all major EVM-compatible networks and token standards.',
                items: [
                  'Bitcoin',
                  'Ethereum',
                  'Polygon',
                  'Arbitrum',
                  'Optimism',
                  'Base',
                  'Almost all EVM chains',
                  'Solana',
                  'Tron',
                  'TON',
                ],
                status: 'active',
              },
            ].map((integration) => (
              <FadeInSection key={integration.title}>
                <div className="bg-gray-50 p-8 rounded-xl border border-gray-200 hover:shadow-lg transition-all duration-300 h-full relative">
                  {integration.badge && (
                    <div className="absolute top-4 right-4">
                      <span className="inline-flex items-center px-3 py-1 rounded-full text-xs font-medium bg-yellow-100 text-yellow-800 border border-yellow-200">
                        {integration.badge}
                      </span>
                    </div>
                  )}
                  <div className="w-12 h-12 bg-gray-900 rounded-lg flex items-center justify-center mb-6">
                    <integration.icon className="w-6 h-6 text-white" />
                  </div>
                  <h3 className="text-xl font-semibold text-gray-900 mb-3">{integration.title}</h3>
                  <p className="text-gray-600 leading-relaxed mb-4">{integration.description}</p>
                  <ul className="space-y-2">
                    {integration.items.map((item) => (
                      <li key={item} className="flex items-center text-sm text-gray-700">
                        <CheckCircle
                          className={`w-4 h-4 mr-2 flex-shrink-0 ${
                            integration.status === 'coming-soon'
                              ? 'text-yellow-600'
                              : 'text-green-600'
                          }`}
                        />
                        {item}
                      </li>
                    ))}
                  </ul>
                </div>
              </FadeInSection>
            ))}
          </div>

          <FadeInSection>
            <div className="bg-gradient-to-r from-gray-900 to-gray-800 rounded-2xl p-8 sm:p-12 text-white">
              <div className="max-w-3xl">
                <h3 className="text-2xl sm:text-3xl font-bold mb-4">AI-Powered Data Ingestion</h3>
                <p className="text-gray-200 text-lg mb-6 leading-relaxed">
                  Upload portfolio screenshots or bank statements and let AI extract your financial
                  data automatically. Works with <strong>any institution worldwide</strong> — if you
                  can see it, Scani can read it. Powered by OpenAI, Perplexity, and DeepSeek. No
                  manual entry required.
                </p>
                <div className="flex flex-wrap gap-4">
                  <div className="flex items-center gap-2 bg-white/10 px-4 py-2 rounded-lg backdrop-blur-sm">
                    <Zap className="w-4 h-4" />
                    <span className="text-sm font-medium">Screenshot analysis</span>
                  </div>
                  <div className="flex items-center gap-2 bg-white/10 px-4 py-2 rounded-lg backdrop-blur-sm">
                    <CheckCircle className="w-4 h-4" />
                    <span className="text-sm font-medium">Bank statements (coming soon)</span>
                  </div>
                  <div className="flex items-center gap-2 bg-white/10 px-4 py-2 rounded-lg backdrop-blur-sm">
                    <Globe className="w-4 h-4" />
                    <span className="text-sm font-medium">Works with any institution</span>
                  </div>
                </div>
              </div>
            </div>
          </FadeInSection>
        </div>
      </section>

      {/* Analytics Section */}
      <section id="analytics" className="py-20 px-4 sm:px-6 lg:px-8 bg-gray-50">
        <div className="max-w-7xl mx-auto">
          <FadeInSection>
            <div className="text-center mb-16">
              <h2 className="text-4xl sm:text-5xl font-bold text-gray-900 mb-4">
                Portfolio analytics & insights
              </h2>
              <p className="text-xl text-gray-600 max-w-2xl mx-auto">
                Institutional-grade reporting and analysis tools for comprehensive wealth
                management.
              </p>
            </div>
          </FadeInSection>

          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-8">
            {[
              {
                icon: BarChart3,
                title: 'Asset Allocation',
                description:
                  'Analyze portfolio composition by token, token type, account, institution, or geography. Real-time breakdown with visual charts.',
              },
              {
                icon: TrendingUp,
                title: 'Performance Tracking',
                description:
                  'Monitor portfolio performance over time with detailed analytics. Track gains, losses, and benchmark comparisons.',
              },
              {
                icon: Globe,
                title: 'Multi-Currency Support',
                description:
                  'Track assets in any currency with automatic conversion. Real-time exchange rates and multi-currency reporting.',
              },
              {
                icon: Zap,
                title: 'Real-Time Updates',
                description:
                  'WebSocket-powered live synchronization. Instant portfolio updates as market conditions change.',
              },
              {
                icon: Database,
                title: 'Historical Data',
                description:
                  'Complete transaction history and holding records. Export data for tax reporting and compliance.',
              },
              {
                icon: Shield,
                title: 'Custom Portfolios',
                description:
                  'Create custom portfolio views and tags. Organize investments by strategy, risk level, or time horizon.',
              },
            ].map((feature) => (
              <FadeInSection key={feature.title}>
                <div className="bg-white p-8 rounded-xl border border-gray-200 hover:shadow-lg transition-all duration-300">
                  <div className="w-12 h-12 bg-gray-100 rounded-lg flex items-center justify-center mb-6">
                    <feature.icon className="w-6 h-6 text-gray-900" />
                  </div>
                  <h3 className="text-xl font-semibold text-gray-900 mb-3">{feature.title}</h3>
                  <p className="text-gray-600 leading-relaxed">{feature.description}</p>
                </div>
              </FadeInSection>
            ))}
          </div>
        </div>
      </section>

      {/* Security Section */}
      <section id="security" className="py-20 px-4 sm:px-6 lg:px-8 bg-white">
        <div className="max-w-7xl mx-auto">
          <FadeInSection>
            <div className="text-center mb-16">
              <h2 className="text-4xl sm:text-5xl font-bold text-gray-900 mb-4">
                Security & infrastructure
              </h2>
              <p className="text-xl text-gray-600 max-w-2xl mx-auto">
                Built with institutional-grade security and modern infrastructure practices.
              </p>
            </div>
          </FadeInSection>

          <div className="grid md:grid-cols-2 gap-12 mb-16">
            <FadeInSection>
              <div className="space-y-6">
                <div className="flex items-start gap-4">
                  <div className="w-10 h-10 bg-gray-900 rounded-lg flex items-center justify-center flex-shrink-0">
                    <Lock className="w-5 h-5 text-white" />
                  </div>
                  <div>
                    <h3 className="text-lg font-semibold text-gray-900 mb-2">
                      Authentication & Authorization
                    </h3>
                    <p className="text-gray-600 leading-relaxed">
                      Supabase Auth with JWT token-based security. All API endpoints protected with
                      authentication. User data automatically scoped to prevent unauthorized access.
                    </p>
                  </div>
                </div>

                <div className="flex items-start gap-4">
                  <div className="w-10 h-10 bg-gray-900 rounded-lg flex items-center justify-center flex-shrink-0">
                    <Shield className="w-5 h-5 text-white" />
                  </div>
                  <div>
                    <h3 className="text-lg font-semibold text-gray-900 mb-2">Data Encryption</h3>
                    <p className="text-gray-600 leading-relaxed">
                      Encrypted credential storage with secure key management. All sensitive data
                      encrypted at rest and in transit using industry-standard protocols.
                    </p>
                  </div>
                </div>

                <div className="flex items-start gap-4">
                  <div className="w-10 h-10 bg-gray-900 rounded-lg flex items-center justify-center flex-shrink-0">
                    <Database className="w-5 h-5 text-white" />
                  </div>
                  <div>
                    <h3 className="text-lg font-semibold text-gray-900 mb-2">
                      PostgreSQL Database
                    </h3>
                    <p className="text-gray-600 leading-relaxed">
                      Enterprise-grade PostgreSQL with Drizzle ORM for type-safe queries. Automatic
                      data isolation per user with comprehensive audit logging.
                    </p>
                  </div>
                </div>
              </div>
            </FadeInSection>

            <FadeInSection>
              <div className="space-y-6">
                <div className="flex items-start gap-4">
                  <div className="w-10 h-10 bg-gray-900 rounded-lg flex items-center justify-center flex-shrink-0">
                    <Network className="w-5 h-5 text-white" />
                  </div>
                  <div>
                    <h3 className="text-lg font-semibold text-gray-900 mb-2">API Security</h3>
                    <p className="text-gray-600 leading-relaxed">
                      Rate limiting on external API calls. Secure credential validation before
                      storage. OAuth-based authentication for third-party integrations.
                    </p>
                  </div>
                </div>

                <div className="flex items-start gap-4">
                  <div className="w-10 h-10 bg-gray-900 rounded-lg flex items-center justify-center flex-shrink-0">
                    <Zap className="w-5 h-5 text-white" />
                  </div>
                  <div>
                    <h3 className="text-lg font-semibold text-gray-900 mb-2">Type Safety</h3>
                    <p className="text-gray-600 leading-relaxed">
                      End-to-end type safety with TypeScript and tRPC. Zod schema validation for all
                      inputs. Compile-time error detection prevents runtime issues.
                    </p>
                  </div>
                </div>

                <div className="flex items-start gap-4">
                  <div className="w-10 h-10 bg-gray-900 rounded-lg flex items-center justify-center flex-shrink-0">
                    <CheckCircle className="w-5 h-5 text-white" />
                  </div>
                  <div>
                    <h3 className="text-lg font-semibold text-gray-900 mb-2">Testing & Quality</h3>
                    <p className="text-gray-600 leading-relaxed">
                      93%+ test coverage with comprehensive test suite. Database isolation for
                      tests. Automated CI/CD pipeline for quality assurance.
                    </p>
                  </div>
                </div>
              </div>
            </FadeInSection>
          </div>

          <FadeInSection>
            <div className="bg-gray-50 rounded-2xl p-8 border border-gray-200">
              <div className="text-center">
                <h3 className="text-2xl font-bold text-gray-900 mb-4">
                  Built for serious investors
                </h3>
                <p className="text-gray-600 text-lg max-w-2xl mx-auto">
                  No exaggerated claims. Just solid engineering, institutional security practices,
                  and reliable wealth management infrastructure.
                </p>
              </div>
            </div>
          </FadeInSection>
        </div>
      </section>

      {/* For Whom Section */}
      <section className="py-20 px-4 sm:px-6 lg:px-8 bg-gray-50">
        <div className="max-w-7xl mx-auto">
          <FadeInSection>
            <div className="text-center mb-16">
              <h2 className="text-4xl sm:text-5xl font-bold text-gray-900 mb-4">
                Who benefits from Scani
              </h2>
              <p className="text-xl text-gray-600 max-w-2xl mx-auto">
                Built for investors managing complex, international portfolios across multiple asset
                classes.
              </p>
            </div>
          </FadeInSection>

          <div className="grid md:grid-cols-3 gap-8">
            {[
              {
                title: 'Active Investors',
                description:
                  'Manage diverse portfolios across crypto, stocks, and traditional assets. Track performance in real-time with multi-currency support.',
                benefits: [
                  'Multi-exchange crypto tracking',
                  'Broker & bank integration',
                  'Real-time portfolio analytics',
                ],
              },
              {
                title: 'International Wealth',
                description:
                  'Expatriates and digital nomads managing assets across multiple countries and currencies. Unified view of global wealth.',
                benefits: [
                  'Multi-currency tracking',
                  'Global exchange support',
                  'Timezone-aware reporting',
                ],
              },
              {
                title: 'Crypto-First Investors',
                description:
                  'Track holdings across multiple wallets and chains. Support for DeFi protocols, NFTs, and emerging blockchain networks.',
                benefits: [
                  'Multi-chain wallet import',
                  'Exchange API integration',
                  'Token price tracking',
                ],
              },
            ].map((persona) => (
              <FadeInSection key={persona.title}>
                <div className="bg-white p-8 rounded-xl border border-gray-200 h-full">
                  <h3 className="text-2xl font-bold text-gray-900 mb-4">{persona.title}</h3>
                  <p className="text-gray-600 leading-relaxed mb-6">{persona.description}</p>
                  <ul className="space-y-3">
                    {persona.benefits.map((benefit) => (
                      <li key={benefit} className="flex items-start">
                        <CheckCircle className="w-5 h-5 mr-3 text-green-600 flex-shrink-0 mt-0.5" />
                        <span className="text-gray-700">{benefit}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </FadeInSection>
            ))}
          </div>
        </div>
      </section>

      {/* Pricing Section - Alpha Program */}
      <section className="py-20 px-4 sm:px-6 lg:px-8 bg-white">
        <div className="max-w-7xl mx-auto">
          <FadeInSection>
            <div className="text-center mb-16">
              <div className="inline-flex items-center px-4 py-2 rounded-full bg-green-100 border border-green-200 text-green-800 text-sm font-medium mb-6">
                <Zap className="w-4 h-4 mr-2" />
                Alpha Program - Free Access
              </div>
              <h2 className="text-4xl sm:text-5xl font-bold text-gray-900 mb-4">
                Join us during alpha
              </h2>
              <p className="text-xl text-gray-600 max-w-2xl mx-auto">
                Scani is currently in alpha stage. Early adopters get full access for free and will
                receive significant discounts when we launch paid plans.
              </p>
            </div>
          </FadeInSection>

          <div className="max-w-4xl mx-auto">
            <FadeInSection>
              <div className="bg-gradient-to-br from-gray-50 to-white rounded-2xl border-2 border-gray-200 p-8 sm:p-12">
                <div className="text-center mb-8">
                  <h3 className="text-3xl font-bold text-gray-900 mb-2">Alpha Access</h3>
                  <div className="flex items-baseline justify-center gap-2 mb-4">
                    <span className="text-5xl font-bold text-gray-900">$0</span>
                    <span className="text-gray-600 text-lg">/month</span>
                  </div>
                  <p className="text-gray-600">Full platform access during alpha development</p>
                </div>

                <div className="grid md:grid-cols-2 gap-6 mb-8">
                  <div>
                    <h4 className="font-semibold text-gray-900 mb-4">What's included:</h4>
                    <ul className="space-y-3">
                      <li className="flex items-start">
                        <CheckCircle className="w-5 h-5 mr-3 text-green-600 flex-shrink-0 mt-0.5" />
                        <span className="text-gray-700">Unlimited accounts & institutions</span>
                      </li>
                      <li className="flex items-start">
                        <CheckCircle className="w-5 h-5 mr-3 text-green-600 flex-shrink-0 mt-0.5" />
                        <span className="text-gray-700">All cryptocurrency integrations</span>
                      </li>
                      <li className="flex items-start">
                        <CheckCircle className="w-5 h-5 mr-3 text-green-600 flex-shrink-0 mt-0.5" />
                        <span className="text-gray-700">AI-powered data extraction</span>
                      </li>
                      <li className="flex items-start">
                        <CheckCircle className="w-5 h-5 mr-3 text-green-600 flex-shrink-0 mt-0.5" />
                        <span className="text-gray-700">Real-time portfolio analytics</span>
                      </li>
                      <li className="flex items-start">
                        <CheckCircle className="w-5 h-5 mr-3 text-green-600 flex-shrink-0 mt-0.5" />
                        <span className="text-gray-700">Multi-currency support</span>
                      </li>
                    </ul>
                  </div>
                  <div>
                    <h4 className="font-semibold text-gray-900 mb-4">Alpha benefits:</h4>
                    <ul className="space-y-3">
                      <li className="flex items-start">
                        <CheckCircle className="w-5 h-5 mr-3 text-green-600 flex-shrink-0 mt-0.5" />
                        <span className="text-gray-700">Shape product development</span>
                      </li>
                      <li className="flex items-start">
                        <CheckCircle className="w-5 h-5 mr-3 text-green-600 flex-shrink-0 mt-0.5" />
                        <span className="text-gray-700">Direct feedback channel</span>
                      </li>
                      <li className="flex items-start">
                        <CheckCircle className="w-5 h-5 mr-3 text-green-600 flex-shrink-0 mt-0.5" />
                        <span className="text-gray-700">Priority feature requests</span>
                      </li>
                      <li className="flex items-start">
                        <CheckCircle className="w-5 h-5 mr-3 text-green-600 flex-shrink-0 mt-0.5" />
                        <span className="text-gray-700">Early access to new features</span>
                      </li>
                      <li className="flex items-start">
                        <CheckCircle className="w-5 h-5 mr-3 text-green-600 flex-shrink-0 mt-0.5" />
                        <span className="text-gray-700">
                          <strong>Exclusive discounts</strong> when paid plans launch
                        </span>
                      </li>
                    </ul>
                  </div>
                </div>

                <div className="text-center">
                  <button
                    type="button"
                    onClick={() => window.open('https://app.scani.xyz', '_blank')}
                    className="bg-gray-900 text-white px-10 py-4 rounded-lg hover:bg-gray-800 transition-all duration-200 inline-flex items-center gap-3 text-lg font-semibold shadow-lg hover:shadow-xl"
                  >
                    Join Alpha Program
                    <ArrowRight className="w-5 h-5" />
                  </button>
                  <p className="text-gray-500 text-sm mt-4">
                    No credit card required • Instant access • Cancel anytime
                  </p>
                </div>
              </div>
            </FadeInSection>

            <FadeInSection>
              <div className="mt-12 bg-blue-50 border border-blue-200 rounded-xl p-6">
                <div className="flex items-start gap-4">
                  <div className="w-10 h-10 bg-blue-600 rounded-lg flex items-center justify-center flex-shrink-0">
                    <Zap className="w-5 h-5 text-white" />
                  </div>
                  <div>
                    <h4 className="font-semibold text-gray-900 mb-2">Future Pricing</h4>
                    <p className="text-gray-700 leading-relaxed">
                      We're currently building Scani in alpha. Paid plans will be introduced in the
                      future with transparent pricing based on features and usage.{' '}
                      <strong>Alpha users will receive substantial discounts</strong> as a thank you
                      for being early adopters and helping us shape the product.
                    </p>
                  </div>
                </div>
              </div>
            </FadeInSection>
          </div>
        </div>
      </section>

      {/* CTA Section */}
      <section className="py-20 px-4 sm:px-6 lg:px-8 bg-gradient-to-br from-gray-900 via-black to-gray-900 relative overflow-hidden">
        <div className="absolute inset-0">
          <div className="absolute top-0 left-1/4 w-96 h-96 bg-white/5 rounded-full blur-3xl" />
          <div className="absolute bottom-0 right-1/4 w-96 h-96 bg-white/5 rounded-full blur-3xl" />
        </div>

        <div className="max-w-4xl mx-auto text-center relative z-10">
          <FadeInSection>
            <h2 className="text-4xl sm:text-5xl lg:text-6xl font-bold text-white mb-6 leading-tight">
              Start managing your
              <br />
              <span className="bg-gradient-to-r from-white to-gray-300 bg-clip-text text-transparent">
                global wealth today
              </span>
            </h2>

            <p className="text-xl text-gray-300 mb-10 max-w-2xl mx-auto leading-relaxed">
              Professional portfolio management for investors who need more than basic tracking.
              Real integrations, real analytics, real security.
            </p>

            <div className="flex flex-col sm:flex-row gap-4 justify-center mb-10">
              <button
                type="button"
                onClick={() => window.open('https://app.scani.xyz', '_blank')}
                className="group bg-white text-gray-900 px-10 py-4 rounded-lg hover:bg-gray-50 transition-all duration-200 flex items-center justify-center gap-3 text-lg font-semibold shadow-2xl"
              >
                Open Dashboard
                <ArrowRight className="w-5 h-5 group-hover:translate-x-2 transition-transform" />
              </button>
            </div>

            <div className="flex flex-wrap justify-center gap-8 text-gray-300">
              <div className="flex items-center gap-2">
                <CheckCircle className="w-5 h-5" />
                <span className="font-medium">No credit card required</span>
              </div>
              <div className="flex items-center gap-2">
                <CheckCircle className="w-5 h-5" />
                <span className="font-medium">Free to start</span>
              </div>
              <div className="flex items-center gap-2">
                <CheckCircle className="w-5 h-5" />
                <span className="font-medium">Full feature access</span>
              </div>
            </div>
          </FadeInSection>
        </div>
      </section>

      {/* Footer */}
      <footer className="bg-gray-900 text-white py-12 px-6">
        <div className="max-w-7xl mx-auto">
          <div className="grid md:grid-cols-4 gap-8 mb-8">
            <div>
              <div className="flex items-center space-x-3 mb-4">
                <div className="w-8 h-8 rounded-lg overflow-hidden flex items-center justify-center">
                  <img
                    src="/icons/icon-192x192.png"
                    alt="Scani Logo"
                    className="w-full h-full object-contain"
                  />
                </div>
                <div className="text-xl font-semibold">Scani</div>
              </div>
              <p className="text-gray-400 text-sm leading-relaxed">
                Unified wealth management for modern investors.
              </p>
            </div>

            <div>
              <h3 className="font-semibold mb-4">Product</h3>
              <ul className="space-y-2 text-sm text-gray-400">
                <li>
                  <a href="#integrations" className="hover:text-white transition-colors">
                    Integrations
                  </a>
                </li>
                <li>
                  <a href="#analytics" className="hover:text-white transition-colors">
                    Analytics
                  </a>
                </li>
                <li>
                  <a href="#security" className="hover:text-white transition-colors">
                    Security
                  </a>
                </li>
              </ul>
            </div>

            <div>
              <h3 className="font-semibold mb-4">Resources</h3>
              <ul className="space-y-2 text-sm text-gray-400">
                <li>
                  <a
                    href="https://github.com/MGrin/scani"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="hover:text-white transition-colors"
                  >
                    Documentation
                  </a>
                </li>
                <li>
                  <a
                    href="https://github.com/MGrin/scani"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="hover:text-white transition-colors"
                  >
                    GitHub
                  </a>
                </li>
              </ul>
            </div>

            <div>
              <h3 className="font-semibold mb-4">Connect</h3>
              <button
                type="button"
                onClick={() => window.open('https://app.scani.xyz', '_blank')}
                className="bg-white text-gray-900 px-5 py-2 rounded-lg hover:bg-gray-100 transition-colors text-sm font-medium w-full flex items-center justify-center gap-2"
              >
                Sign In
                <ArrowRight className="w-4 h-4" />
              </button>
            </div>
          </div>

          <div className="border-t border-gray-800 pt-8 flex flex-col md:flex-row justify-between items-center text-sm text-gray-400">
            <p>© 2025 Scani. All rights reserved.</p>
            <p className="mt-4 md:mt-0">
              Made with <span className="text-red-500">❤️</span> for digital nomads
            </p>
          </div>
        </div>
      </footer>
    </div>
  );
}

export default App;
