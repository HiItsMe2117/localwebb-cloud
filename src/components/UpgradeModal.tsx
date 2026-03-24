import { useState } from 'react';
import { X, Zap, Crown, Loader2, Check, Info } from 'lucide-react';
import axios from 'axios';

interface UpgradeModalProps {
  onClose: () => void;
}

interface Feature {
  label: string;
  description: string;
}

const TIERS: {
  id: string;
  name: string;
  price: string;
  icon: typeof Zap;
  color: string;
  features: Feature[];
}[] = [
  {
    id: 'basic',
    name: 'Basic',
    price: '$49/mo',
    icon: Zap,
    color: '#007AFF',
    features: [
      { label: 'AI-powered investigations', description: 'Ask questions in natural language and get sourced answers drawn from indexed documents and evidence.' },
      { label: 'Case management', description: 'Create and organize cases to track entities, evidence, and connections across your investigations.' },
      { label: 'Knowledge graph', description: 'Visualize relationships between people, organizations, and events in an interactive network map.' },
      { label: 'Standard query limits', description: 'A set number of AI-powered queries per month suitable for routine research.' },
    ],
  },
  {
    id: 'pro',
    name: 'Pro',
    price: '$100/mo',
    icon: Crown,
    color: '#FFD60A',
    features: [
      { label: 'Everything in Basic', description: 'All Basic features included — investigations, case management, and knowledge graph.' },
      { label: 'Unlimited investigations', description: 'No caps on AI-powered queries. Investigate as deeply and as often as you need.' },
      { label: 'Theory analysis', description: 'Build and test investigative theories by asking the AI to find supporting or contradicting evidence across all sources.' },
      { label: 'Priority processing', description: 'Your queries are processed ahead of the queue for faster response times.' },
    ],
  },
];

function FeatureItem({ feature, color }: { feature: Feature; color: string }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <li className="text-[12px] text-[rgba(235,235,245,0.6)]">
      <div className="flex items-center gap-2">
        <Check size={12} style={{ color }} className="shrink-0" />
        <span className="flex-1">{feature.label}</span>
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); setExpanded(!expanded); }}
          className={`shrink-0 p-0.5 rounded transition-colors ${expanded ? 'text-white' : 'text-[rgba(235,235,245,0.25)] hover:text-[rgba(235,235,245,0.5)]'}`}
        >
          <Info size={12} />
        </button>
      </div>
      {expanded && (
        <p className="mt-1 ml-5 text-[11px] text-[rgba(235,235,245,0.4)] leading-relaxed">
          {feature.description}
        </p>
      )}
    </li>
  );
}

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
                    <span className="text-[12px] text-[rgba(235,235,245,0.4)] font-medium">{tier.price}</span>
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
                    <FeatureItem key={f.label} feature={f} color={tier.color} />
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
