import { useState, useEffect } from 'react';
import { Loader2, CreditCard, LogOut, Zap, ExternalLink, Clock, User, XCircle, RotateCcw } from 'lucide-react';
import axios from 'axios';
import { useAuth } from '../contexts/AuthContext';

interface AccountPanelProps {
  onUpgrade: () => void;
}

interface UsageByEndpoint {
  tokens: number;
  requests: number;
}

interface Invoice {
  date: number;
  amount: number;
  status: string;
  pdf: string | null;
}

interface AccountData {
  email: string;
  username: string | null;
  role: string;
  subscription_status: string;
  cancel_at_period_end: boolean;
  current_period_end: string | null;
  member_since: string | null;
  usage: {
    total_tokens: number;
    total_requests: number;
    by_endpoint: Record<string, UsageByEndpoint>;
  };
  billing: {
    total_spent: number;
    invoices: Invoice[];
  };
}

const ROLE_LABELS: Record<string, string> = {
  admin: 'Admin',
  elite: 'Elite',
  pro: 'Pro',
  basic: 'Basic',
  standard: 'Free',
};

const ENDPOINT_LABELS: Record<string, string> = {
  '/api/query': 'Investigations',
  '/api/investigate': 'Deep Research',
  '/api/theories/investigate': 'Theory Analysis',
  '/api/theories/follow-up': 'Theory Follow-up',
  '/api/cases/investigate': 'Case Research',
  '/api/cases/consolidate': 'Case Reports',
  '/api/cases/graph/analyze': 'Graph Analysis',
  '/api/cases/graph/chat': 'Graph Chat',
  '/api/cases/graph/case-chat': 'Case Chat',
};

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toString();
}

function formatDate(d: string | number | null): string {
  if (!d) return '—';
  const date = new Date(typeof d === 'number' ? d * 1000 : d);
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export default function AccountPanel({ onUpgrade }: AccountPanelProps) {
  const { logout, refreshSession } = useAuth();
  const [data, setData] = useState<AccountData | null>(null);
  const [loading, setLoading] = useState(true);
  const [billingLoading, setBillingLoading] = useState(false);
  const [cancelLoading, setCancelLoading] = useState(false);
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);

  const fetchAccount = () => {
    axios.get('/api/billing/account')
      .then(res => setData(res.data))
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  useEffect(() => { fetchAccount(); }, []);

  const handleBilling = async () => {
    setBillingLoading(true);
    try {
      const res = await axios.post('/api/billing/create-portal-session');
      window.location.href = res.data.url;
    } catch {
      setBillingLoading(false);
    }
  };

  const handleCancel = async () => {
    setCancelLoading(true);
    try {
      await axios.post('/api/billing/cancel');
      await refreshSession();
      fetchAccount();
      setShowCancelConfirm(false);
    } catch {
    } finally {
      setCancelLoading(false);
    }
  };

  const handleReactivate = async () => {
    setCancelLoading(true);
    try {
      await axios.post('/api/billing/reactivate');
      await refreshSession();
      fetchAccount();
    } catch {
    } finally {
      setCancelLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 size={24} className="text-[#007AFF] animate-spin" />
      </div>
    );
  }

  if (!data) {
    return (
      <div className="flex-1 flex items-center justify-center text-[rgba(235,235,245,0.4)] text-sm">
        Failed to load account data.
      </div>
    );
  }

  const planLabel = ROLE_LABELS[data.role] || 'Free';
  const isActive = data.subscription_status === 'active' || data.subscription_status === 'canceling';
  const isCanceling = data.subscription_status === 'canceling' || data.cancel_at_period_end;
  const sortedEndpoints = Object.entries(data.usage.by_endpoint)
    .sort(([, a], [, b]) => b.tokens - a.tokens);
  const maxTokens = sortedEndpoints.length > 0 ? sortedEndpoints[0][1].tokens : 1;

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-2xl mx-auto px-4 py-6 space-y-4">

        {/* Profile */}
        <div className="bg-[#1C1C1E] border border-[rgba(84,84,88,0.65)] rounded-2xl p-5">
          <div className="flex items-center gap-4 mb-4">
            <div className="w-12 h-12 rounded-full bg-[#007AFF]/20 flex items-center justify-center shrink-0">
              <User size={22} className="text-[#007AFF]" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-[16px] font-bold text-white truncate">{data.email}</p>
              {data.username && (
                <p className="text-[13px] text-[rgba(235,235,245,0.4)]">@{data.username}</p>
              )}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="bg-[#2C2C2E] rounded-xl px-3.5 py-2.5">
              <p className="text-[11px] text-[rgba(235,235,245,0.4)] uppercase tracking-wider">Plan</p>
              <p className="text-[15px] font-semibold text-white">{planLabel}</p>
            </div>
            <div className="bg-[#2C2C2E] rounded-xl px-3.5 py-2.5">
              <p className="text-[11px] text-[rgba(235,235,245,0.4)] uppercase tracking-wider">Member Since</p>
              <p className="text-[15px] font-semibold text-white">{formatDate(data.member_since)}</p>
            </div>
          </div>
        </div>

        {/* Subscription */}
        <div className="bg-[#1C1C1E] border border-[rgba(84,84,88,0.65)] rounded-2xl p-5">
          <h3 className="text-[13px] font-semibold text-[rgba(235,235,245,0.6)] uppercase tracking-wider mb-3">Subscription</h3>
          {isActive && !isCanceling ? (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full bg-[#30D158]" />
                  <span className="text-[14px] text-white">Active</span>
                </div>
                <div className="flex items-center gap-1.5 text-[13px] text-[rgba(235,235,245,0.4)]">
                  <Clock size={12} />
                  <span>Renews {formatDate(data.current_period_end)}</span>
                </div>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={handleBilling}
                  disabled={billingLoading}
                  className="flex-1 flex items-center justify-center gap-2 bg-[#2C2C2E] border border-[rgba(84,84,88,0.65)] rounded-xl px-4 py-2.5 text-[14px] text-white hover:border-[rgba(84,84,88,1)] transition-colors disabled:opacity-50"
                >
                  {billingLoading ? <Loader2 size={14} className="animate-spin" /> : <CreditCard size={14} />}
                  Manage Billing
                </button>
                <button
                  onClick={() => setShowCancelConfirm(true)}
                  className="flex items-center justify-center gap-2 bg-[#2C2C2E] border border-[rgba(84,84,88,0.65)] rounded-xl px-4 py-2.5 text-[14px] text-[#FF453A] hover:border-[#FF453A]/30 transition-colors"
                >
                  <XCircle size={14} />
                  Cancel
                </button>
              </div>
            </div>
          ) : isCanceling ? (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full bg-[#FF9F0A]" />
                  <span className="text-[14px] text-[#FF9F0A]">Canceling</span>
                </div>
                <div className="flex items-center gap-1.5 text-[13px] text-[rgba(235,235,245,0.4)]">
                  <Clock size={12} />
                  <span>Access until {formatDate(data.current_period_end)}</span>
                </div>
              </div>
              <p className="text-[13px] text-[rgba(235,235,245,0.4)]">
                Your subscription will end on {formatDate(data.current_period_end)}. You won't be charged again.
              </p>
              <button
                onClick={handleReactivate}
                disabled={cancelLoading}
                className="w-full flex items-center justify-center gap-2 bg-[#007AFF] rounded-xl px-4 py-2.5 text-[14px] font-semibold text-white hover:bg-[#0071E3] transition-colors disabled:opacity-50"
              >
                {cancelLoading ? <Loader2 size={14} className="animate-spin" /> : <RotateCcw size={14} />}
                Keep My Subscription
              </button>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <div className="w-2 h-2 rounded-full bg-[rgba(235,235,245,0.3)]" />
                <span className="text-[14px] text-[rgba(235,235,245,0.4)]">No active subscription</span>
              </div>
              <button
                onClick={onUpgrade}
                className="w-full flex items-center justify-center gap-2 bg-[#007AFF] rounded-xl px-4 py-2.5 text-[14px] font-semibold text-white hover:bg-[#0071E3] transition-colors"
              >
                <Zap size={14} />
                Upgrade Plan
              </button>
            </div>
          )}
        </div>

        {/* Cancel Confirmation */}
        {showCancelConfirm && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm px-4">
            <div className="bg-[#1C1C1E] border border-[rgba(84,84,88,0.65)] rounded-2xl p-6 max-w-sm w-full space-y-4">
              <h3 className="text-[17px] font-bold text-white text-center">Cancel Subscription?</h3>
              <p className="text-[14px] text-[rgba(235,235,245,0.6)] text-center leading-relaxed">
                You'll keep full access until <span className="text-white font-medium">{formatDate(data.current_period_end)}</span>.
                After that, your account will switch to the free plan.
              </p>
              <div className="space-y-2 pt-1">
                <button
                  onClick={handleCancel}
                  disabled={cancelLoading}
                  className="w-full flex items-center justify-center gap-2 bg-[#FF453A] rounded-xl px-4 py-3 text-[15px] font-semibold text-white hover:bg-[#FF453A]/90 transition-colors disabled:opacity-50"
                >
                  {cancelLoading ? <Loader2 size={14} className="animate-spin" /> : <XCircle size={14} />}
                  Yes, Cancel Subscription
                </button>
                <button
                  onClick={() => setShowCancelConfirm(false)}
                  className="w-full flex items-center justify-center gap-2 bg-[#2C2C2E] border border-[rgba(84,84,88,0.65)] rounded-xl px-4 py-3 text-[15px] text-white hover:border-[rgba(84,84,88,1)] transition-colors"
                >
                  Never Mind
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Billing History */}
        {data.billing.invoices.length > 0 && (
          <div className="bg-[#1C1C1E] border border-[rgba(84,84,88,0.65)] rounded-2xl p-5">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-[13px] font-semibold text-[rgba(235,235,245,0.6)] uppercase tracking-wider">Billing History</h3>
              <span className="text-[13px] font-semibold text-white">${data.billing.total_spent.toFixed(2)} total</span>
            </div>
            <div className="space-y-1">
              {data.billing.invoices.map((inv, i) => (
                <div key={i} className="flex items-center justify-between py-2 border-b border-[rgba(84,84,88,0.3)] last:border-0">
                  <div className="flex items-center gap-2">
                    <span className="text-[13px] text-[rgba(235,235,245,0.6)]">{formatDate(inv.date)}</span>
                    {inv.status === 'paid' && (
                      <span className="text-[10px] font-medium text-[#30D158] bg-[#30D158]/10 px-1.5 py-0.5 rounded">Paid</span>
                    )}
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-[14px] font-medium text-white">${inv.amount.toFixed(2)}</span>
                    {inv.pdf && (
                      <a href={inv.pdf} target="_blank" rel="noopener noreferrer" className="text-[rgba(235,235,245,0.3)] hover:text-white transition-colors">
                        <ExternalLink size={12} />
                      </a>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Usage */}
        <div className="bg-[#1C1C1E] border border-[rgba(84,84,88,0.65)] rounded-2xl p-5">
          <h3 className="text-[13px] font-semibold text-[rgba(235,235,245,0.6)] uppercase tracking-wider mb-3">Usage</h3>
          <div className="grid grid-cols-2 gap-3 mb-4">
            <div className="bg-[#2C2C2E] rounded-xl px-3.5 py-2.5">
              <p className="text-[11px] text-[rgba(235,235,245,0.4)] uppercase tracking-wider">Total Tokens</p>
              <p className="text-[20px] font-bold text-white">{formatNumber(data.usage.total_tokens)}</p>
            </div>
            <div className="bg-[#2C2C2E] rounded-xl px-3.5 py-2.5">
              <p className="text-[11px] text-[rgba(235,235,245,0.4)] uppercase tracking-wider">AI Requests</p>
              <p className="text-[20px] font-bold text-white">{formatNumber(data.usage.total_requests)}</p>
            </div>
          </div>
          {sortedEndpoints.length > 0 ? (
            <div className="space-y-2">
              {sortedEndpoints.map(([endpoint, stats]) => (
                <div key={endpoint}>
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-[12px] text-[rgba(235,235,245,0.6)]">
                      {ENDPOINT_LABELS[endpoint] || endpoint.split('/').pop()}
                    </span>
                    <span className="text-[11px] text-[rgba(235,235,245,0.4)]">
                      {formatNumber(stats.tokens)} tokens · {stats.requests} calls
                    </span>
                  </div>
                  <div className="h-1.5 bg-[#2C2C2E] rounded-full overflow-hidden">
                    <div
                      className="h-full bg-[#007AFF] rounded-full transition-all"
                      style={{ width: `${Math.max((stats.tokens / maxTokens) * 100, 2)}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-[13px] text-[rgba(235,235,245,0.4)] text-center py-4">No usage yet</p>
          )}
        </div>

        {/* Sign Out */}
        <button
          onClick={logout}
          className="w-full flex items-center justify-center gap-2 bg-[#1C1C1E] border border-[rgba(84,84,88,0.65)] rounded-2xl px-4 py-3 text-[14px] text-[#FF453A] font-medium hover:border-[#FF453A]/30 transition-colors"
        >
          <LogOut size={14} />
          Sign Out
        </button>

      </div>
    </div>
  );
}
