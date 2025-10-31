import { motion } from 'framer-motion';
import {
  ArrowRight,
  Award,
  BarChart3,
  Calendar,
  CheckCircle,
  Clock,
  DollarSign,
  Globe,
  Sparkles,
  Target,
  Wallet,
  Zap,
} from 'lucide-react';
import { useEffect, useState } from 'react';

const fadeInUp = {
  initial: { opacity: 0, y: 60 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.6 },
};

const staggerContainer = {
  animate: {
    transition: {
      staggerChildren: 0.1,
    },
  },
};

function App() {
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    setIsVisible(true);
  }, []);

  return (
    <div className="min-h-screen bg-white" style={{ scrollBehavior: 'smooth' }}>
      {/* Navigation */}
      <nav className="fixed top-0 w-full bg-white/95 backdrop-blur-sm border-b border-gray-100 z-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center h-16">
            <div className="flex items-center">
              <div className="flex items-center space-x-3">
                <div className="w-8 h-8 rounded-lg overflow-hidden flex items-center justify-center">
                  <img
                    src="/icons/icon-192x192.png"
                    alt="Scani - Portfolio Tracking Platform Logo"
                    className="w-full h-full object-contain"
                  />
                </div>
                <div className="text-2xl font-bold bg-gradient-to-r from-gray-900 to-black bg-clip-text text-transparent">
                  Scani
                </div>
              </div>
            </div>
            <div className="hidden md:flex items-center space-x-8">
              <a href="#features" className="text-gray-600 hover:text-gray-900 transition-colors">
                Features
              </a>
              <a
                href="#how-it-works"
                className="text-gray-600 hover:text-gray-900 transition-colors"
              >
                How It Works
              </a>
              <button
                type="button"
                className="bg-black text-white px-6 py-2 rounded-lg hover:bg-gray-800 transition-colors flex items-center gap-2"
                onClick={() => window.open('https://app.scani.xyz', '_blank')}
              >
                Get Started
                <ArrowRight className="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>
      </nav>

      {/* Hero Section */}
      <section className="relative pt-32 pb-20 px-4 sm:px-6 lg:px-8 overflow-hidden">
        {/* Background Elements */}
        <div className="absolute inset-0 bg-gradient-to-br from-gray-50 via-white to-gray-100"></div>
        <div className="absolute top-0 left-1/2 transform -translate-x-1/2 w-96 h-96 bg-gray-400/5 rounded-full blur-3xl"></div>
        <div className="absolute bottom-0 right-0 w-96 h-96 bg-gray-400/5 rounded-full blur-3xl"></div>

        <div className="relative max-w-7xl mx-auto">
          <motion.div
            initial="initial"
            animate={isVisible ? 'animate' : 'initial'}
            variants={staggerContainer}
            className="text-center"
          >
            <motion.div variants={fadeInUp} className="mb-8">
              <div className="inline-flex items-center px-4 py-2 rounded-full bg-gradient-to-r from-gray-100 to-gray-200 border border-gray-300 text-gray-700 text-sm font-medium mb-6 backdrop-blur-sm">
                <Sparkles className="w-4 h-4 mr-2 text-gray-600" />
                Alpha Release - Early Access
              </div>
              <h1 className="text-4xl sm:text-6xl lg:text-7xl font-bold text-gray-900 mb-6 leading-tight">
                Portfolio Tracking That
                <span className="block bg-gradient-to-r from-gray-900 to-black bg-clip-text text-transparent">
                  Works Everywhere
                </span>
              </h1>
              <p className="text-xl text-gray-600 max-w-3xl mx-auto mb-8 leading-relaxed">
                Scani is currently in alpha development. We're building the most comprehensive
                portfolio tracking platform for investors managing international wealth across
                multiple currencies and asset classes.
              </p>
            </motion.div>

            <motion.div
              variants={fadeInUp}
              className="flex flex-col sm:flex-row gap-4 justify-center mb-12"
            >
              <button
                type="button"
                className="group bg-gradient-to-r from-gray-900 to-black text-white px-8 py-4 rounded-xl hover:from-black hover:to-gray-900 transition-all duration-200 flex items-center justify-center gap-2 text-lg font-semibold shadow-lg hover:shadow-xl transform hover:-translate-y-0.5"
                onClick={() => window.open('https://app.scani.xyz', '_blank')}
              >
                Join Alpha
                <ArrowRight className="w-5 h-5 group-hover:translate-x-1 transition-transform" />
              </button>
            </motion.div>

            <motion.div
              variants={fadeInUp}
              className="flex flex-wrap items-center justify-center gap-6 text-sm text-gray-500 mb-12"
            >
              <div className="flex items-center gap-2">
                <CheckCircle className="w-4 h-4 text-green-500" />
                <span className="font-medium">No credit card required</span>
              </div>
            </motion.div>
          </motion.div>
        </div>
      </section>

      {/* Features Section */}
      {/** biome-ignore lint/correctness/useUniqueElementIds: types */}
      <section id="features" className="py-20 pb-8 px-4 sm:px-6 lg:px-8 bg-gray-50">
        <div className="max-w-7xl mx-auto">
          <motion.div
            initial={{ opacity: 0, y: 30 }}
            whileInView={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6 }}
            viewport={{ once: true }}
            className="text-center mb-16"
          >
            <h2 className="text-3xl sm:text-4xl font-bold text-gray-900 mb-4">
              Core Features in Development
            </h2>
            <p className="text-xl text-gray-600 max-w-2xl mx-auto">
              We're building powerful tools for international wealth management. Here's what's
              currently available and what's coming next.
            </p>
          </motion.div>

          <motion.div
            initial="initial"
            whileInView="animate"
            viewport={{ once: true }}
            variants={staggerContainer}
            className="grid md:grid-cols-2 lg:grid-cols-3 gap-8 mb-16"
          >
            {[
              {
                icon: Globe,
                title: 'Multi-Currency Support',
                description:
                  'Track assets in multiple currencies with automatic conversion. Support for major global currencies and exchange rates.',
                available: true,
                highlight: 'Available Now',
              },
              {
                icon: BarChart3,
                title: 'Portfolio Dashboard',
                description:
                  'View your complete portfolio overview with asset allocation and key financial metrics.',
                available: true,
                highlight: 'Available Now',
              },
              {
                icon: Target,
                title: 'Manual Data Entry',
                description:
                  'Easily add and manage your accounts, holdings, and institutions through our intuitive data entry interface.',
                available: true,
                highlight: 'Available Now',
              },
              {
                icon: Zap,
                title: 'AI Screenshot Intelligence',
                description:
                  'Upload portfolio screenshots and let AI extract your financial data automatically. No more manual entry.',
                available: true,
                highlight: 'Available Now',
              },
              {
                icon: Wallet,
                title: 'Crypto Wallet Integration',
                description:
                  'Import holdings from cryptocurrency wallets and exchanges. Support for major blockchains and token types.',
                available: true,
                highlight: 'Available Now',
              },
            ].map((feature) => (
              <motion.div
                key={feature.title}
                variants={fadeInUp}
                className="bg-white p-8 rounded-2xl border border-gray-100 hover:shadow-xl transition-all duration-300 hover:-translate-y-2 group"
              >
                <div className="w-14 h-14 bg-gradient-to-br from-gray-900 to-black rounded-xl flex items-center justify-center mb-6 group-hover:scale-110 transition-transform">
                  <feature.icon className="w-7 h-7 text-white" />
                </div>
                <h3 className="text-xl font-semibold text-gray-900 mb-3">{feature.title}</h3>
                <p className="text-gray-600 leading-relaxed mb-4">{feature.description}</p>
                <div className="flex items-center text-green-600 text-sm font-medium">
                  <CheckCircle className="w-4 h-4 mr-2" />
                  {feature.highlight}
                </div>
              </motion.div>
            ))}
          </motion.div>

          {/* Coming Soon Teaser */}
          <motion.div
            initial={{ opacity: 0, y: 30 }}
            whileInView={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6 }}
            viewport={{ once: true }}
            className="text-center mb-12"
          >
            <div className="inline-flex items-center px-6 py-3 rounded-full bg-gradient-to-r from-gray-100 to-gray-200 border border-gray-300 text-gray-700 text-lg font-medium mb-6">
              <Clock className="w-5 h-5 mr-3 text-gray-600" />
              Development Status
            </div>
            <p className="text-lg text-gray-600 max-w-2xl mx-auto">
              We're actively building powerful tools for international wealth management.
            </p>
          </motion.div>
        </div>
      </section>

      {/* Coming Soon Section */}
      <section className="py-20 px-4 sm:px-6 lg:px-8">
        <div className="max-w-7xl mx-auto">
          <motion.div
            initial={{ opacity: 0, y: 30 }}
            whileInView={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6 }}
            viewport={{ once: true }}
            className="text-center mb-16"
          >
            <h2 className="text-3xl sm:text-4xl font-bold text-gray-900 mb-4">What's Next</h2>
            <p className="text-xl text-gray-600 max-w-3xl mx-auto mb-8">
              We're methodically building advanced financial tools for international investors.
            </p>
          </motion.div>

          <motion.div
            initial="initial"
            whileInView="animate"
            viewport={{ once: true }}
            variants={staggerContainer}
            className="grid md:grid-cols-2 lg:grid-cols-3 gap-8"
          >
            {[
              {
                icon: DollarSign,
                title: 'Crypto Token Support',
                description:
                  'Full support for cryptocurrency tokens with automatic balance discovery, price tracking, and protocol integration. Your entire crypto portfolio in one unified view.',
                impact: 'High',
                beta: true,
              },
              {
                icon: Calendar,
                title: 'Income Scheduling & Planning',
                description:
                  'Plan your money distribution in advance. Schedule income allocation across different holdings and get a clear overview of your future portfolio composition and growth projections.',
                impact: 'High',
                beta: true,
              },
              {
                icon: Target,
                title: 'Smart Savings Automation',
                description:
                  'Track high-yield savings accounts with automatic interest calculation, compounding projections, and intelligent savings recommendations.',
                impact: 'High',
                beta: true,
              },
            ].map((feature) => (
              <motion.div
                key={feature.title}
                variants={fadeInUp}
                className="bg-white p-8 rounded-2xl border border-gray-200 hover:shadow-2xl transition-all duration-300 hover:-translate-y-1 group relative overflow-hidden"
              >
                <div className="w-14 h-14 bg-gradient-to-br from-gray-900 to-black rounded-xl flex items-center justify-center mb-6 group-hover:scale-110 transition-transform">
                  <feature.icon className="w-7 h-7 text-white" />
                </div>
                <h3 className="text-xl font-semibold text-gray-900 mb-3 pr-20">{feature.title}</h3>
                <p className="text-gray-600 leading-relaxed mb-4">{feature.description}</p>
                <div className="flex items-center justify-between mb-3">
                  <span className="text-sm text-gray-600 font-medium">In Development</span>
                  <span
                    className={`text-xs font-bold px-2 py-1 rounded-full ${
                      feature.impact === 'Revolutionary'
                        ? 'bg-gray-900 text-white'
                        : feature.impact === 'High'
                          ? 'bg-gray-700 text-white'
                          : 'bg-gray-500 text-white'
                    }`}
                  >
                    {feature.impact} Impact
                  </span>
                </div>
                <div className="flex items-center text-gray-600 text-sm font-medium">
                  <Clock className="w-4 h-4 mr-2" />
                  Coming Soon
                </div>
              </motion.div>
            ))}
          </motion.div>

          {/* Urgency Section */}
          <motion.div
            initial={{ opacity: 0, y: 30 }}
            whileInView={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6 }}
            viewport={{ once: true }}
            className="mt-16 text-center"
          >
            <div className="bg-gradient-to-r from-gray-50 to-gray-100 p-8 rounded-2xl border border-gray-200">
              <h3 className="text-2xl font-bold text-gray-900 mb-4">Join Our Alpha Program</h3>
              <p className="text-lg text-gray-700 mb-6">
                Be among the first to experience the future of international wealth management.
                Alpha access provides early feature access and direct developer feedback.
              </p>
              <div className="flex flex-col sm:flex-row gap-4 justify-center items-center">
                <button
                  type="button"
                  className="bg-gradient-to-r from-gray-900 to-black text-white px-8 py-3 rounded-xl hover:from-black hover:to-gray-900 transition-all duration-200 flex items-center justify-center gap-2 text-lg font-semibold shadow-lg"
                  onClick={() => window.open('https://app.scani.xyz', '_blank')}
                >
                  Request Alpha Access
                  <ArrowRight className="w-5 h-5" />
                </button>
              </div>
            </div>
          </motion.div>
        </div>
      </section>

      {/* How It Works */}
      {/** biome-ignore lint/correctness/useUniqueElementIds: types */}
      <section id="how-it-works" className="py-20 px-4 sm:px-6 lg:px-8">
        <div className="max-w-7xl mx-auto">
          <motion.div
            initial={{ opacity: 0, y: 30 }}
            whileInView={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6 }}
            viewport={{ once: true }}
            className="text-center mb-16"
          >
            <h2 className="text-3xl sm:text-4xl font-bold text-gray-900 mb-4">How It Works</h2>
            <p className="text-xl text-gray-600 max-w-2xl mx-auto">
              Get started in minutes, not hours
            </p>
          </motion.div>

          <motion.div
            initial="initial"
            whileInView="animate"
            viewport={{ once: true }}
            variants={staggerContainer}
            className="grid md:grid-cols-2 lg:grid-cols-4 gap-8"
          >
            {[
              {
                step: '01',
                title: 'Connect Your Accounts',
                description:
                  'Import crypto wallets or upload financial documents. No bank connections required.',
              },
              {
                step: '02',
                title: 'AI Processes Your Data',
                description:
                  'Our AI automatically categorizes and extracts financial information from your uploads.',
              },
              {
                step: '03',
                title: 'Track & Analyze',
                description: 'Get hourly portfolio insights and detailed analytics.',
              },
              {
                step: '04',
                title: 'Stay Informed',
                description:
                  'Receive alerts, reports, and insights to make better financial decisions.',
              },
            ].map((step) => (
              <motion.div key={step.step} variants={fadeInUp} className="text-center">
                <div className="w-16 h-16 bg-gray-900 text-white rounded-full flex items-center justify-center text-xl font-bold mx-auto mb-6">
                  {step.step}
                </div>
                <h3 className="text-xl font-semibold text-gray-900 mb-3">{step.title}</h3>
                <p className="text-gray-600 leading-relaxed">{step.description}</p>
              </motion.div>
            ))}
          </motion.div>
        </div>
      </section>

      {/* CTA Section */}
      <section className="py-20 px-4 sm:px-6 lg:px-8 bg-gradient-to-br from-gray-900 via-black to-gray-900 relative overflow-hidden">
        {/* Background Elements */}
        <div className="absolute inset-0 bg-black/10"></div>
        <div className="absolute top-0 left-1/4 w-96 h-96 bg-white/5 rounded-full blur-3xl"></div>
        <div className="absolute bottom-0 right-1/4 w-96 h-96 bg-white/5 rounded-full blur-3xl"></div>

        <div className="max-w-5xl mx-auto text-center relative z-10">
          <motion.div
            initial={{ opacity: 0, y: 30 }}
            whileInView={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6 }}
            viewport={{ once: true }}
          >
            <div className="inline-flex items-center px-6 py-3 rounded-full bg-white/10 backdrop-blur-sm border border-white/20 text-white text-lg font-medium mb-8">
              <Sparkles className="w-5 h-5 mr-3 text-gray-300" />
              Alpha Access
            </div>

            <h2 className="text-4xl sm:text-5xl lg:text-6xl font-bold text-white mb-6 leading-tight">
              Global Wealth
              <br />
              <span className="bg-gradient-to-r from-white to-gray-200 bg-clip-text text-transparent">
                Made Simple
              </span>
            </h2>

            <p className="text-xl text-gray-200 mb-8 max-w-3xl mx-auto leading-relaxed">
              Scani is designed for serious investors managing international portfolios. Join our
              alpha program to experience intelligent wealth management that understands global
              finance.
            </p>

            {/* Alpha Benefits */}
            <div className="flex flex-wrap justify-center items-center gap-8 mb-10 text-gray-200">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 bg-gray-700 rounded-full flex items-center justify-center">
                  <CheckCircle className="w-4 h-4 text-white" />
                </div>
                <span className="font-medium">Multi-Currency Support</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 bg-gray-600 rounded-full flex items-center justify-center">
                  <Award className="w-4 h-4 text-white" />
                </div>
                <span className="font-medium">Global Asset Tracking</span>
              </div>
            </div>

            <div className="flex flex-col sm:flex-row gap-4 justify-center mb-8">
              <button
                type="button"
                onClick={() => window.open('https://app.scani.xyz', '_blank')}
                className="group bg-white text-gray-900 px-10 py-5 rounded-2xl hover:bg-gray-50 transition-all duration-200 flex items-center justify-center gap-3 text-xl font-bold shadow-2xl hover:shadow-white/25 transform hover:-translate-y-1"
              >
                Request Alpha Access
                <ArrowRight className="w-6 h-6 group-hover:translate-x-2 transition-transform" />
              </button>
            </div>

            <div className="bg-white/10 backdrop-blur-sm rounded-2xl p-6 max-w-2xl mx-auto">
              <p className="text-white text-lg font-medium mb-4">
                🎯 <strong>Alpha Program:</strong> Exclusive access for serious investors
              </p>
              <div className="flex flex-wrap justify-center gap-6 text-gray-200 text-sm">
                <div className="flex items-center gap-2">
                  <CheckCircle className="w-4 h-4 text-gray-300" />
                  <span>Early feature access</span>
                </div>
                <div className="flex items-center gap-2">
                  <CheckCircle className="w-4 h-4 text-gray-300" />
                  <span>Direct developer feedback</span>
                </div>
              </div>
            </div>
          </motion.div>
        </div>
      </section>

      {/* Footer */}
      <footer className="bg-gray-900 text-white py-8 px-6">
        <div className="max-w-7xl mx-auto">
          <div className="border-gray-800 flex flex-col md:flex-row justify-between items-center">
            <p className="text-gray-400 text-sm">© 2025 Scani. All rights reserved.</p>
            <div className="flex items-center gap-4 mt-4 md:mt-0">
              <span className="text-gray-400 text-sm">Made with ❤️ for digital nomads</span>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}

export default App;
