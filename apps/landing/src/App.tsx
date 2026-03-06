import { motion } from 'framer-motion';
import {
  ArrowRight,
  BarChart3,
  Bot,
  CheckCircle,
  Code2,
  Globe,
  Key,
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

function FadeInSection({ children, delay = 0 }: { children: React.ReactNode; delay?: number }) {
  const [ref, inView] = useInView({
    triggerOnce: true,
    threshold: 0.1,
  });

  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0, y: 30 }}
      animate={inView ? { opacity: 1, y: 0 } : { opacity: 0, y: 30 }}
      transition={{ duration: 0.45, delay, ease: 'easeOut' }}
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

  const navLinks = [
    { label: 'For Agents', href: '#for-agents' },
    { label: 'Integrations', href: '#integrations' },
    { label: 'Features', href: '#features' },
  ];

  return (
    <div className="min-h-screen bg-white text-gray-900">
      {/* Navigation */}
      <nav className="fixed top-0 w-full bg-white/95 backdrop-blur-sm border-b border-gray-100 z-50">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center h-14">
            <a href="/" className="flex items-center gap-2.5">
              <div className="w-7 h-7 rounded-md overflow-hidden">
                <img
                  src="/icons/icon-192x192.png"
                  alt="Scani"
                  className="w-full h-full object-contain"
                />
              </div>
              <span className="text-lg font-semibold tracking-tight">Scani</span>
            </a>

            <div className="hidden md:flex items-center gap-7">
              {navLinks.map((link) => (
                <a
                  key={link.href}
                  href={link.href}
                  className="text-sm text-gray-500 hover:text-gray-900 transition-colors font-medium"
                >
                  {link.label}
                </a>
              ))}
              <a
                href="https://github.com/MGrin/scani"
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm text-gray-500 hover:text-gray-900 transition-colors font-medium"
              >
                GitHub
              </a>
              <button
                type="button"
                onClick={() => window.open('https://app.scani.xyz', '_blank')}
                className="text-sm bg-gray-900 text-white px-4 py-1.5 rounded-md hover:bg-gray-700 transition-colors font-medium"
              >
                Open app
              </button>
            </div>

            <button
              type="button"
              className="md:hidden p-1.5 text-gray-500"
              onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
              aria-label="Toggle menu"
            >
              {mobileMenuOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
            </button>
          </div>
        </div>

        {mobileMenuOpen && (
          <div className="md:hidden border-t border-gray-100 bg-white px-4 py-3 space-y-2">
            {navLinks.map((link) => (
              <a
                key={link.href}
                href={link.href}
                className="block py-1.5 text-sm text-gray-600 hover:text-gray-900 font-medium"
                onClick={() => setMobileMenuOpen(false)}
              >
                {link.label}
              </a>
            ))}
            <a
              href="https://github.com/MGrin/scani"
              target="_blank"
              rel="noopener noreferrer"
              className="block py-1.5 text-sm text-gray-600 hover:text-gray-900 font-medium"
              onClick={() => setMobileMenuOpen(false)}
            >
              GitHub
            </a>
            <button
              type="button"
              onClick={() => {
                setMobileMenuOpen(false);
                window.open('https://app.scani.xyz', '_blank');
              }}
              className="w-full mt-2 text-sm bg-gray-900 text-white px-4 py-2 rounded-md hover:bg-gray-700 transition-colors font-medium"
            >
              Open app
            </button>
          </div>
        )}
      </nav>

      {/* Hero */}
      <section className="pt-28 pb-20 px-4 sm:px-6 lg:px-8">
        <div className="max-w-4xl mx-auto">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5 }}
            className="mb-5"
          >
            <span className="inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1 rounded-full bg-green-50 text-green-700 border border-green-200">
              <span className="w-1.5 h-1.5 rounded-full bg-green-500 inline-block" />
              Alpha — free to use
            </span>
          </motion.div>

          <motion.h1
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.05 }}
            className="text-5xl sm:text-6xl font-bold tracking-tight text-gray-900 leading-[1.1] mb-6"
          >
            Your finances,
            <br />
            queryable by AI.
          </motion.h1>

          <motion.p
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.1 }}
            className="text-xl text-gray-500 max-w-2xl leading-relaxed mb-8"
          >
            Scani aggregates your crypto exchanges, blockchain wallets, and bank accounts into one
            place. Then exposes everything through an MCP server — so AI agents can actually use it.
          </motion.p>

          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.15 }}
            className="flex flex-col sm:flex-row gap-3"
          >
            <button
              type="button"
              onClick={() => window.open('https://app.scani.xyz', '_blank')}
              className="group inline-flex items-center justify-center gap-2 bg-gray-900 text-white px-6 py-3 rounded-lg text-base font-semibold hover:bg-gray-700 transition-colors"
            >
              Get started — it's free
              <ArrowRight className="w-4 h-4 group-hover:translate-x-0.5 transition-transform" />
            </button>
            <a
              href="https://github.com/MGrin/scani"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center justify-center gap-2 bg-white text-gray-700 px-6 py-3 rounded-lg text-base font-semibold border border-gray-200 hover:bg-gray-50 transition-colors"
            >
              View on GitHub
            </a>
          </motion.div>

          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.5, delay: 0.25 }}
            className="mt-10 flex flex-wrap gap-5 text-sm text-gray-500"
          >
            {['No credit card required', 'Open source', 'MCP server included'].map((item) => (
              <span key={item} className="flex items-center gap-1.5">
                <CheckCircle className="w-4 h-4 text-green-500 flex-shrink-0" />
                {item}
              </span>
            ))}
          </motion.div>
        </div>
      </section>

      {/* For Agents / MCP */}
      <section id="for-agents" className="py-20 px-4 sm:px-6 lg:px-8 bg-gray-950 text-white">
        <div className="max-w-6xl mx-auto">
          <FadeInSection>
            <div className="flex items-center gap-2 mb-4">
              <Bot className="w-5 h-5 text-indigo-400" />
              <span className="text-sm font-semibold text-indigo-400 uppercase tracking-widest">
                Agentic-ready
              </span>
            </div>
            <h2 className="text-3xl sm:text-4xl font-bold mb-4 max-w-2xl leading-tight">
              Built for the age of AI agents
            </h2>
            <p className="text-gray-400 text-lg max-w-2xl leading-relaxed mb-14">
              Scani ships with a full MCP (Model Context Protocol) server. Any AI agent — Claude,
              GPT, your own LLM — can authenticate, query your portfolio, and manage your financial
              data. No screen-scraping, no hacks.
            </p>
          </FadeInSection>

          <div className="grid md:grid-cols-2 gap-8 mb-12">
            <FadeInSection>
              <div className="rounded-xl bg-gray-900 border border-gray-800 overflow-hidden h-full">
                <div className="flex items-center gap-2 px-4 py-3 border-b border-gray-800">
                  <div className="w-2.5 h-2.5 rounded-full bg-red-500/70" />
                  <div className="w-2.5 h-2.5 rounded-full bg-yellow-500/70" />
                  <div className="w-2.5 h-2.5 rounded-full bg-green-500/70" />
                  <span className="ml-2 text-xs text-gray-500 font-mono">
                    claude_desktop_config.json
                  </span>
                </div>
                <pre className="p-5 text-sm font-mono text-gray-300 overflow-x-auto leading-relaxed whitespace-pre">
                  {`{
  "mcpServers": {
    "scani": {
      "url": "https://api.scani.xyz/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_API_KEY"
      }
    }
  }
}`}
                </pre>
              </div>
            </FadeInSection>

            <FadeInSection delay={0.05}>
              <div className="space-y-5">
                {[
                  {
                    icon: Key,
                    title: 'Self-registration',
                    body: 'Agents call agent_register to self-issue an API key. Link the agent to your Scani account once to grant it access. You can revoke any key at any time.',
                  },
                  {
                    icon: Code2,
                    title: '30+ MCP tools',
                    body: 'Full CRUD for accounts, holdings, institutions, blockchain wallets, and tokens. Plus dashboard summary and asset allocation.',
                  },
                  {
                    icon: Shield,
                    title: 'Scoped by user',
                    body: 'Every tool call is automatically scoped to the authenticated user. Agents can only see and modify your data.',
                  },
                  {
                    icon: Zap,
                    title: 'Batch operations',
                    body: 'Create holdings with all dependencies in one call. Efficient for AI agents that need to populate your portfolio quickly.',
                  },
                ].map((item) => (
                  <div key={item.title} className="flex gap-4">
                    <div className="w-9 h-9 rounded-lg bg-indigo-500/15 flex items-center justify-center flex-shrink-0 mt-0.5">
                      <item.icon className="w-4 h-4 text-indigo-400" />
                    </div>
                    <div>
                      <h3 className="font-semibold text-white mb-1">{item.title}</h3>
                      <p className="text-gray-400 text-sm leading-relaxed">{item.body}</p>
                    </div>
                  </div>
                ))}
              </div>
            </FadeInSection>
          </div>

          <FadeInSection>
            <div className="rounded-xl border border-indigo-500/30 bg-indigo-950/30 p-6 flex flex-col sm:flex-row sm:items-center gap-4">
              <div className="flex-1">
                <p className="text-sm font-semibold text-indigo-300 mb-1">MCP endpoint</p>
                <code className="text-white font-mono text-sm">https://api.scani.xyz/mcp</code>
                <p className="text-gray-500 text-sm mt-1">
                  Compatible with Claude Desktop, Cursor, and any MCP-capable client.
                </p>
              </div>
              <a
                href="https://app.scani.xyz/settings"
                target="_blank"
                rel="noopener noreferrer"
                className="flex-shrink-0 inline-flex items-center gap-2 bg-indigo-600 hover:bg-indigo-500 text-white px-5 py-2.5 rounded-lg text-sm font-semibold transition-colors"
              >
                Get API key
                <ArrowRight className="w-4 h-4" />
              </a>
            </div>
          </FadeInSection>
        </div>
      </section>

      {/* Integrations */}
      <section id="integrations" className="py-20 px-4 sm:px-6 lg:px-8 bg-white">
        <div className="max-w-6xl mx-auto">
          <FadeInSection>
            <div className="mb-12">
              <h2 className="text-3xl sm:text-4xl font-bold mb-4 leading-tight">
                Connect your accounts
              </h2>
              <p className="text-gray-500 text-lg max-w-2xl leading-relaxed">
                Scani pulls in data from where you actually keep your money. Here's what's working
                right now.
              </p>
            </div>
          </FadeInSection>

          <div className="grid md:grid-cols-3 gap-6 mb-10">
            {[
              {
                icon: Wallet,
                label: 'Live',
                labelColor: 'bg-green-50 text-green-700 border-green-200',
                title: 'Crypto exchanges',
                desc: 'Direct API connection — balances sync automatically.',
                items: ['Binance', 'Kraken'],
              },
              {
                icon: Network,
                label: 'Live',
                labelColor: 'bg-green-50 text-green-700 border-green-200',
                title: 'Blockchain wallets',
                desc: 'Paste a public address, Scani imports all holdings.',
                items: ['Bitcoin', 'Ethereum + all EVM chains', 'Solana', 'TON', 'TRON'],
              },
              {
                icon: TrendingUp,
                label: 'Coming soon',
                labelColor: 'bg-amber-50 text-amber-700 border-amber-200',
                title: 'Banks & brokers',
                desc: 'Plaid integration for US banks and brokerage accounts.',
                items: ['US banks', 'US brokerages', 'International support planned'],
              },
            ].map((card) => (
              <FadeInSection key={card.title}>
                <div className="p-6 rounded-xl border border-gray-200 hover:border-gray-300 hover:shadow-sm transition-all h-full">
                  <div className="flex items-center justify-between mb-5">
                    <div className="w-10 h-10 bg-gray-100 rounded-lg flex items-center justify-center">
                      <card.icon className="w-5 h-5 text-gray-700" />
                    </div>
                    <span
                      className={`text-xs font-medium px-2.5 py-1 rounded-full border ${card.labelColor}`}
                    >
                      {card.label}
                    </span>
                  </div>
                  <h3 className="font-semibold text-gray-900 mb-2">{card.title}</h3>
                  <p className="text-gray-500 text-sm leading-relaxed mb-4">{card.desc}</p>
                  <ul className="space-y-1.5">
                    {card.items.map((item) => (
                      <li key={item} className="flex items-center gap-2 text-sm text-gray-600">
                        <span className="w-1 h-1 rounded-full bg-gray-400 flex-shrink-0" />
                        {item}
                      </li>
                    ))}
                  </ul>
                </div>
              </FadeInSection>
            ))}
          </div>

          <FadeInSection>
            <div className="rounded-xl bg-gray-50 border border-gray-200 p-7">
              <div className="flex items-start gap-4">
                <div className="w-10 h-10 rounded-lg bg-gray-900 flex items-center justify-center flex-shrink-0">
                  <Zap className="w-5 h-5 text-white" />
                </div>
                <div>
                  <h3 className="font-semibold text-gray-900 mb-1">AI screenshot import</h3>
                  <p className="text-gray-600 text-sm leading-relaxed max-w-xl">
                    No native integration for your broker? Take a screenshot of your portfolio page
                    and upload it. AI parses the image and creates all holdings automatically. Works
                    with any institution worldwide.
                  </p>
                </div>
              </div>
            </div>
          </FadeInSection>
        </div>
      </section>

      {/* Features */}
      <section id="features" className="py-20 px-4 sm:px-6 lg:px-8 bg-gray-50">
        <div className="max-w-6xl mx-auto">
          <FadeInSection>
            <div className="mb-12">
              <h2 className="text-3xl sm:text-4xl font-bold mb-4 leading-tight">
                What you actually get
              </h2>
              <p className="text-gray-500 text-lg max-w-2xl">
                A straightforward list of what works today.
              </p>
            </div>
          </FadeInSection>

          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-5">
            {[
              {
                icon: BarChart3,
                title: 'Asset allocation',
                body: 'Break down your portfolio by token, asset type, account, institution, or geography. Live charts.',
              },
              {
                icon: Globe,
                title: 'Multi-currency',
                body: 'Track everything in your chosen base currency. Live exchange rates. Switch at any time.',
              },
              {
                icon: Zap,
                title: 'Real-time sync',
                body: 'WebSocket updates push price changes instantly. No polling, no manual refresh.',
              },
              {
                icon: Network,
                title: 'Price tracking',
                body: 'Token prices sourced from CoinGecko and DefiLlama. Force-refresh any holding on demand.',
              },
              {
                icon: Bot,
                title: 'AI chat assistant',
                body: 'Ask questions about your portfolio in plain language. Powered by OpenAI.',
              },
              {
                icon: Shield,
                title: 'API key management',
                body: 'Create scoped API keys for agents or third-party tools. Revoke any key at any time.',
              },
            ].map((feature) => (
              <FadeInSection key={feature.title}>
                <div className="bg-white p-6 rounded-xl border border-gray-200 hover:shadow-sm transition-all">
                  <div className="w-9 h-9 bg-gray-100 rounded-lg flex items-center justify-center mb-4">
                    <feature.icon className="w-[18px] h-[18px] text-gray-700" />
                  </div>
                  <h3 className="font-semibold text-gray-900 mb-2">{feature.title}</h3>
                  <p className="text-gray-500 text-sm leading-relaxed">{feature.body}</p>
                </div>
              </FadeInSection>
            ))}
          </div>
        </div>
      </section>

      {/* Pricing / Alpha */}
      <section className="py-20 px-4 sm:px-6 lg:px-8 bg-white">
        <div className="max-w-3xl mx-auto text-center">
          <FadeInSection>
            <span className="inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1 rounded-full bg-green-50 text-green-700 border border-green-200 mb-6">
              <span className="w-1.5 h-1.5 rounded-full bg-green-500 inline-block" />
              Currently in alpha
            </span>
            <h2 className="text-3xl sm:text-4xl font-bold mb-4 leading-tight">
              Free while we build it together
            </h2>
            <p className="text-gray-500 text-lg leading-relaxed mb-10 max-w-xl mx-auto">
              Scani is in active development. Early users get full access at no cost and will
              receive meaningful discounts when paid plans arrive.
            </p>
          </FadeInSection>

          <FadeInSection delay={0.05}>
            <div className="rounded-2xl border-2 border-gray-200 p-8 sm:p-10 text-left">
              <div className="flex items-start justify-between mb-7 gap-4">
                <div>
                  <h3 className="text-2xl font-bold text-gray-900 mb-1">Alpha access</h3>
                  <p className="text-gray-500 text-sm">Full platform. No limits. No card.</p>
                </div>
                <div className="text-right flex-shrink-0">
                  <span className="text-4xl font-bold text-gray-900">$0</span>
                  <span className="text-gray-400 text-sm ml-1">/mo</span>
                </div>
              </div>

              <div className="grid sm:grid-cols-2 gap-x-8 gap-y-2.5 mb-8">
                {[
                  'Crypto exchange integrations (live)',
                  'Blockchain wallet import (live)',
                  'MCP server access',
                  'AI screenshot import',
                  'Multi-currency dashboard',
                  'Real-time price tracking',
                  'AI chat assistant',
                  'Priority feedback channel',
                  'Discount when paid plans launch',
                ].map((item) => (
                  <div key={item} className="flex items-center gap-2 text-sm text-gray-700">
                    <CheckCircle className="w-4 h-4 text-green-500 flex-shrink-0" />
                    {item}
                  </div>
                ))}
              </div>

              <button
                type="button"
                onClick={() => window.open('https://app.scani.xyz', '_blank')}
                className="group w-full sm:w-auto inline-flex items-center justify-center gap-2 bg-gray-900 text-white px-8 py-3 rounded-lg text-base font-semibold hover:bg-gray-700 transition-colors"
              >
                Create free account
                <ArrowRight className="w-4 h-4 group-hover:translate-x-0.5 transition-transform" />
              </button>
            </div>
          </FadeInSection>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-gray-200 py-12 px-4 sm:px-6 lg:px-8 bg-white">
        <div className="max-w-6xl mx-auto">
          <div className="flex flex-col md:flex-row justify-between gap-8">
            <div className="max-w-xs">
              <a href="/" className="flex items-center gap-2.5 mb-3">
                <div className="w-7 h-7 rounded-md overflow-hidden">
                  <img
                    src="/icons/icon-192x192.png"
                    alt="Scani"
                    className="w-full h-full object-contain"
                  />
                </div>
                <span className="text-base font-semibold">Scani</span>
              </a>
              <p className="text-sm text-gray-400 leading-relaxed">
                Personal finance tracker with an MCP server. Track everything, let agents query it.
              </p>
            </div>

            <div className="grid grid-cols-2 gap-8 text-sm">
              <div>
                <h4 className="font-semibold text-gray-700 mb-3">Product</h4>
                <ul className="space-y-2 text-gray-400">
                  <li>
                    <a href="#for-agents" className="hover:text-gray-700 transition-colors">
                      For agents
                    </a>
                  </li>
                  <li>
                    <a href="#integrations" className="hover:text-gray-700 transition-colors">
                      Integrations
                    </a>
                  </li>
                  <li>
                    <a href="#features" className="hover:text-gray-700 transition-colors">
                      Features
                    </a>
                  </li>
                  <li>
                    <a
                      href="https://app.scani.xyz"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="hover:text-gray-700 transition-colors"
                    >
                      Dashboard
                    </a>
                  </li>
                </ul>
              </div>
              <div>
                <h4 className="font-semibold text-gray-700 mb-3">Developers</h4>
                <ul className="space-y-2 text-gray-400">
                  <li>
                    <a
                      href="https://github.com/MGrin/scani"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="hover:text-gray-700 transition-colors"
                    >
                      GitHub
                    </a>
                  </li>
                  <li>
                    <code className="text-xs text-gray-500">api.scani.xyz/mcp</code>
                  </li>
                </ul>
              </div>
            </div>
          </div>

          <div className="mt-10 pt-6 border-t border-gray-100 flex flex-col sm:flex-row justify-between items-center gap-3 text-xs text-gray-400">
            <span>© {new Date().getFullYear()} Scani. All rights reserved.</span>
            <span>Made with ❤️ for digital nomads &amp; AI enthusiasts</span>
          </div>
        </div>
      </footer>
    </div>
  );
}

export default App;
