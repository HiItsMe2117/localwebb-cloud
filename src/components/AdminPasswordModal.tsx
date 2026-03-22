import { useState } from 'react';
import { X, Loader2, Lock, Eye, EyeOff } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import axios from 'axios';

interface AdminPasswordModalProps {
  onClose: () => void;
}

export default function AdminPasswordModal({ onClose }: AdminPasswordModalProps) {
  const [password, setPassword] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const { refreshSession } = useAuth();

  const handleSubmit = async () => {
    if (!password.trim() || isLoading) return;

    setIsLoading(true);
    setError('');

    try {
      // Verify password with backend and get magic-link token
      const res = await axios.post('/api/admin/auth', { password: password.trim() });
      const { token_hash } = res.data;

      // Exchange token for a Supabase session
      const { error: verifyError } = await supabase.auth.verifyOtp({
        token_hash,
        type: 'magiclink',
      });

      if (verifyError) throw verifyError;

      await refreshSession();
      onClose();
    } catch (err: any) {
      setError(err.response?.data?.detail || err.message || 'Authentication failed');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-[#1C1C1E] border border-[rgba(84,84,88,0.65)] rounded-2xl p-6 w-[320px] space-y-4 shadow-2xl">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 bg-[#007AFF]/20 rounded-lg flex items-center justify-center">
              <Lock size={16} className="text-[#007AFF]" />
            </div>
            <h2 className="text-[17px] font-bold text-white">Admin Access</h2>
          </div>
          <button onClick={onClose} className="p-1 hover:bg-[#2C2C2E] rounded-lg transition-colors">
            <X size={16} className="text-[rgba(235,235,245,0.4)]" />
          </button>
        </div>

        <div className="relative">
          <input
            type={showPassword ? 'text' : 'password'}
            value={password}
            onChange={e => setPassword(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleSubmit(); }}
            placeholder="Enter admin password"
            autoFocus
            autoComplete="current-password"
            className="w-full bg-[#2C2C2E] border border-[rgba(84,84,88,0.65)] rounded-xl px-4 py-2.5 pr-10 text-[13px] text-white focus:outline-none focus:border-[#007AFF] transition-colors placeholder:text-[rgba(235,235,245,0.2)]"
          />
          <button
            type="button"
            onClick={() => setShowPassword(!showPassword)}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-[rgba(235,235,245,0.4)] hover:text-white transition-colors"
          >
            {showPassword ? <EyeOff size={14} /> : <Eye size={14} />}
          </button>
        </div>

        {error && (
          <p className="text-[12px] text-[#FF453A] text-center">{error}</p>
        )}

        <button
          onClick={handleSubmit}
          disabled={!password.trim() || isLoading}
          className="w-full flex items-center justify-center gap-2 bg-[#007AFF] hover:bg-[#0071E3] disabled:opacity-30 px-4 py-2.5 rounded-xl text-[13px] font-semibold transition-colors"
        >
          {isLoading ? <Loader2 size={14} className="animate-spin" /> : <Lock size={14} />}
          Unlock
        </button>
      </div>
    </div>
  );
}
