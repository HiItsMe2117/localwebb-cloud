import { useState } from 'react';
import { X, LogOut, CreditCard, Zap, User, Loader2 } from 'lucide-react';
import axios from 'axios';
import { useAuth } from '../contexts/AuthContext';

interface AccountSettingsModalProps {
  onClose: () => void;
  onUpgrade: () => void;
}

const ROLE_LABELS: Record<string, string> = {
  admin: 'Admin',
  elite: 'Elite',
  pro: 'Pro',
  basic: 'Basic',
  standard: 'Free',
};

export default function AccountSettingsModal({ onClose, onUpgrade }: AccountSettingsModalProps) {
  const { user, role, hasAIPrivileges, logout } = useAuth();
  const [billingLoading, setBillingLoading] = useState(false);

  const handleBilling = async () => {
    setBillingLoading(true);
    try {
      const res = await axios.post('/api/billing/create-portal-session');
      window.location.href = res.data.url;
    } catch {
      setBillingLoading(false);
    }
  };

  const handleSignOut = async () => {
    await logout();
    onClose();
  };

  const planLabel = ROLE_LABELS[role || ''] || 'Free';

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="bg-[#1C1C1E] border border-[rgba(84,84,88,0.65)] rounded-2xl p-6 w-full max-w-[360px] shadow-2xl">
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-[17px] font-bold text-white">Account</h2>
          <button onClick={onClose} className="p-1 hover:bg-[#2C2C2E] rounded-lg transition-colors">
            <X size={16} className="text-[rgba(235,235,245,0.4)]" />
          </button>
        </div>

        {/* User info */}
        <div className="bg-[#2C2C2E] border border-[rgba(84,84,88,0.65)] rounded-xl p-4 mb-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-[#007AFF]/20 flex items-center justify-center shrink-0">
              <User size={18} className="text-[#007AFF]" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-[14px] font-medium text-white truncate">
                {user?.email}
              </p>
              <p className="text-[12px] text-[rgba(235,235,245,0.4)]">
                {planLabel} plan
              </p>
            </div>
          </div>
        </div>

        {/* Actions */}
        <div className="flex flex-col gap-2">
          {hasAIPrivileges ? (
            <button
              onClick={handleBilling}
              disabled={billingLoading}
              className="w-full flex items-center gap-3 bg-[#2C2C2E] border border-[rgba(84,84,88,0.65)] rounded-xl px-4 py-3 text-left hover:border-[rgba(84,84,88,1)] transition-colors disabled:opacity-50"
            >
              {billingLoading ? (
                <Loader2 size={16} className="text-[#30D158] animate-spin" />
              ) : (
                <CreditCard size={16} className="text-[#30D158]" />
              )}
              <span className="text-[14px] text-white">Manage Billing</span>
            </button>
          ) : (
            <button
              onClick={() => { onClose(); onUpgrade(); }}
              className="w-full flex items-center gap-3 bg-[#2C2C2E] border border-[rgba(84,84,88,0.65)] rounded-xl px-4 py-3 text-left hover:border-[rgba(84,84,88,1)] transition-colors"
            >
              <Zap size={16} className="text-[#007AFF]" />
              <span className="text-[14px] text-white">Upgrade Plan</span>
            </button>
          )}

          <button
            onClick={handleSignOut}
            className="w-full flex items-center gap-3 bg-[#2C2C2E] border border-[rgba(84,84,88,0.65)] rounded-xl px-4 py-3 text-left hover:border-[rgba(84,84,88,1)] transition-colors"
          >
            <LogOut size={16} className="text-[#FF453A]" />
            <span className="text-[14px] text-[#FF453A]">Sign Out</span>
          </button>
        </div>
      </div>
    </div>
  );
}
