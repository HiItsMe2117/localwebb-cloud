import { useState } from 'react';
import { X, Loader2, Lock, Eye, EyeOff, Check } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';

interface PasswordResetModalProps {
  onClose: () => void;
}

export default function PasswordResetModal({ onClose }: PasswordResetModalProps) {
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [success, setSuccess] = useState(false);
  const { setIsRecovering } = useAuth();

  const handleSubmit = async () => {
    if (!password.trim() || !confirmPassword.trim() || isLoading) return;

    if (password !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }

    if (password.length < 6) {
      setError('Password must be at least 6 characters');
      return;
    }

    setIsLoading(true);
    setError('');

    try {
      const { error: updateError } = await supabase.auth.updateUser({ password });
      if (updateError) throw updateError;
      setSuccess(true);
      setTimeout(() => {
        setIsRecovering(false);
        onClose();
      }, 1500);
    } catch (err: any) {
      setError(err.message || 'Failed to update password');
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
              {success ? <Check size={16} className="text-[#30D158]" /> : <Lock size={16} className="text-[#007AFF]" />}
            </div>
            <h2 className="text-[17px] font-bold text-white">{success ? 'Password Updated' : 'Set New Password'}</h2>
          </div>
          <button onClick={() => { setIsRecovering(false); onClose(); }} className="p-1 hover:bg-[#2C2C2E] rounded-lg transition-colors">
            <X size={16} className="text-[rgba(235,235,245,0.4)]" />
          </button>
        </div>

        {success ? (
          <p className="text-[13px] text-[#30D158] text-center py-2">Your password has been updated. Redirecting...</p>
        ) : (
          <>
            <div className="relative">
              <input
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder="New password"
                autoFocus
                autoComplete="new-password"
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

            <input
              type={showPassword ? 'text' : 'password'}
              value={confirmPassword}
              onChange={e => setConfirmPassword(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleSubmit(); }}
              placeholder="Confirm new password"
              autoComplete="new-password"
              className="w-full bg-[#2C2C2E] border border-[rgba(84,84,88,0.65)] rounded-xl px-4 py-2.5 text-[13px] text-white focus:outline-none focus:border-[#007AFF] transition-colors placeholder:text-[rgba(235,235,245,0.2)]"
            />

            {error && (
              <p className="text-[12px] text-[#FF453A] text-center">{error}</p>
            )}

            <button
              onClick={handleSubmit}
              disabled={!password.trim() || !confirmPassword.trim() || isLoading}
              className="w-full flex items-center justify-center gap-2 bg-[#007AFF] hover:bg-[#0071E3] disabled:opacity-30 px-4 py-2.5 rounded-xl text-[13px] font-semibold transition-colors"
            >
              {isLoading ? <Loader2 size={14} className="animate-spin" /> : <Lock size={14} />}
              Update Password
            </button>
          </>
        )}
      </div>
    </div>
  );
}
