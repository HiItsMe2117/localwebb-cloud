import { useState } from 'react';
import { X, Zap, Crown, Loader2, Check } from 'lucide-react';
import axios from 'axios';

interface UpgradeModalProps {
  onClose: () => void;
}

const TIERS = [
  {
    id: 'basic',
    name: 'Basic',
    icon: Zap,
    color: '#007AFF',
    features: [
      'AI-powered investigations',
      'Case management',
      'Knowledge graph access',
      'Standard query limits',
    ],
  },
  {
    id: 'pro',
    name: 'Pro',
    icon: Crown,
    color: '#FFD60A',
    features: [
      'Everything in Basic',
      'Unlimited investigations',
      'Theory analysis',
      'Priority processing',
    ],
  },
] as const;

export default function UpgradeModal({ onClose }: UpgradeModalProps) {
  const [loadingTier, setLoadingTier] = useState<string | null>(null);
  const [error, setError] = useState('');

  const handleUpgrade = async (tier: string) => {
    setLoadingTier(tier);
    setError('');

    try {
      const res = await axios.post('/api/billing/create-checkout-session', null, {
        params: { tier },
      });
      window.location.href = res.data.url;
    } catch (err: any) {
      setError(err.response?.data?.detail || 'Failed to start checkout');
      setLoadingTier(null);
    }
  };

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="bg-[#1C1C1E] border border-[rgba(84,84,88,0.65)] rounded-2xl p-6 w-full max-w-[420px] shadow-2xl">
        <div className="flex items-center justify-between mb-5">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 bg-[#007AFF]/20 rounded-lg flex items-center justify-center">
              <Zap size={16} className="text-[#007AFF]" />
            </div>
            <h2 className="text-[17px] font-bold text-white">Upgrade Plan</h2>
          </div>
          <button onClick={onClose} className="p-1 hover:bg-[#2C2C2E] rounded-lg transition-colors">
            <X size={16} className="text-[rgba(235,235,245,0.4)]" />
          </button>
        </div>

        <p className="text-[13px] text-[rgba(235,235,245,0.6)] mb-5">
          Unlock AI-powered investigations and deep analysis tools.
        </p>

        <div className="flex flex-col gap-3">
          {TIERS.map((tier) => {
            const Icon = tier.icon;
            const isLoading = loadingTier === tier.id;
            const isDisabled = loadingTier !== null;

            return (
              <button
                key={tier.id}
                onClick={() => handleUpgrade(tier.id)}
                disabled={isDisabled}
                className={`w-full text-left bg-[#2C2C2E] border rounded-xl p-4 transition-all ${
                  isDisabled && !isLoading
                    ? 'opacity-40 border-[rgba(84,84,88,0.65)]'
                    : 'border-[rgba(84,84,88,0.65)] hover:border-[rgba(84,84,88,1)] active:scale-[0.98]'
                }`}
              >
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <Icon size={16} style={{ color: tier.color }} />
                    <span className="text-[15px] font-bold text-white">{tier.name}</span>
                  </div>
                  {isLoading ? (
                    <Loader2 size={16} className="text-[#007AFF] animate-spin" />
                  ) : (
                    <span className="text-[12px] font-semibold px-2.5 py-1 rounded-full" style={{ color: tier.color, backgroundColor: `${tier.color}15` }}>
                      Select
                    </span>
                  )}
                </div>
                <ul className="space-y-1.5">
                  {tier.features.map((f) => (
                    <li key={f} className="flex items-center gap-2 text-[12px] text-[rgba(235,235,245,0.6)]">
                      <Check size={12} style={{ color: tier.color }} className="shrink-0" />
                      {f}
                    </li>
                  ))}
                </ul>
              </button>
            );
          })}
        </div>

        {error && (
          <p className="text-[12px] text-[#FF453A] text-center mt-4">{error}</p>
        )}
      </div>
    </div>
  );
}
