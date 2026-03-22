import { useState } from 'react';
import { X, Loader2, Lock, Eye, EyeOff, UserPlus, Mail } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';

interface LoginModalProps {
  onClose: () => void;
}

export default function LoginModal({ onClose }: LoginModalProps) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [username, setUsername] = useState('');
  const [isSignUp, setIsSignUp] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [resetSent, setResetSent] = useState(false);
  const { refreshSession } = useAuth();

  const handleSubmit = async () => {
    if (!email.trim() || !password.trim() || isLoading) return;
    if (isSignUp && !username.trim()) {
      setError('Username is required for sign up');
      return;
    }
    
    setIsLoading(true);
    setError('');
    
    try {
      if (isSignUp) {
        const { error: signUpError } = await supabase.auth.signUp({
          email: email.trim(),
          password: password.trim(),
          options: {
            data: {
              username: username.trim(),
            }
          }
        });
        if (signUpError) throw signUpError;
        // After sign up, depending on Supabase settings, they might be logged in or need to confirm email.
        // Assuming auto-login for this flow:
        await refreshSession();
        onClose();
      } else {
        const { error: signInError } = await supabase.auth.signInWithPassword({
          email: email.trim(),
          password: password.trim(),
        });
        if (signInError) throw signInError;
        await refreshSession();
        onClose();
      }
    } catch (err: any) {
      setError(err.message || 'Authentication failed');
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
              {isSignUp ? <UserPlus size={16} className="text-[#007AFF]" /> : <Lock size={16} className="text-[#007AFF]" />}
            </div>
            <h2 className="text-[17px] font-bold text-white">{isSignUp ? 'Create Account' : 'Sign In'}</h2>
          </div>
          <button onClick={onClose} className="p-1 hover:bg-[#2C2C2E] rounded-lg transition-colors">
            <X size={16} className="text-[rgba(235,235,245,0.4)]" />
          </button>
        </div>

        {isSignUp && (
          <input
            type="text"
            value={username}
            onChange={e => setUsername(e.target.value)}
            placeholder="Username"
            autoComplete="username"
            className="w-full bg-[#2C2C2E] border border-[rgba(84,84,88,0.65)] rounded-xl px-4 py-2.5 text-[13px] text-white focus:outline-none focus:border-[#007AFF] transition-colors placeholder:text-[rgba(235,235,245,0.2)]"
          />
        )}

        <input
          type="email"
          value={email}
          onChange={e => setEmail(e.target.value)}
          placeholder="Email Address"
          autoFocus
          autoComplete="email"
          className="w-full bg-[#2C2C2E] border border-[rgba(84,84,88,0.65)] rounded-xl px-4 py-2.5 text-[13px] text-white focus:outline-none focus:border-[#007AFF] transition-colors placeholder:text-[rgba(235,235,245,0.2)]"
        />

        <div className="relative">
          <input
            type={showPassword ? 'text' : 'password'}
            value={password}
            onChange={e => setPassword(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleSubmit(); }}
            placeholder="Password"
            autoComplete={isSignUp ? 'new-password' : 'current-password'}
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

        {!isSignUp && !resetSent && (
          <button
            type="button"
            onClick={async () => {
              if (!email.trim()) {
                setError('Enter your email first');
                return;
              }
              setIsLoading(true);
              setError('');
              try {
                const { error: resetError } = await supabase.auth.resetPasswordForEmail(email.trim());
                if (resetError) throw resetError;
                setResetSent(true);
              } catch (err: any) {
                setError(err.message || 'Failed to send reset email');
              } finally {
                setIsLoading(false);
              }
            }}
            className="w-full text-right text-[12px] text-[rgba(235,235,245,0.4)] hover:text-[#007AFF] transition-colors -mt-2"
          >
            Forgot password?
          </button>
        )}

        {resetSent && (
          <div className="flex items-center gap-2 bg-[#007AFF]/10 rounded-xl px-4 py-2.5">
            <Mail size={14} className="text-[#007AFF] shrink-0" />
            <p className="text-[12px] text-[#007AFF]">Check your email for a reset link.</p>
          </div>
        )}

        {error && (
          <p className="text-[12px] text-[#FF453A] text-center">{error}</p>
        )}

        {!resetSent && (
          <button
            onClick={handleSubmit}
            disabled={!email.trim() || !password.trim() || (isSignUp && !username.trim()) || isLoading}
            className="w-full flex items-center justify-center gap-2 bg-[#007AFF] hover:bg-[#0071E3] disabled:opacity-30 px-4 py-2.5 rounded-xl text-[13px] font-semibold transition-colors"
          >
            {isLoading ? <Loader2 size={14} className="animate-spin" /> : (isSignUp ? <UserPlus size={14} /> : <Lock size={14} />)}
            {isSignUp ? 'Create Account' : 'Sign In'}
          </button>
        )}

        <button
          onClick={() => {
            setIsSignUp(!isSignUp);
            setError('');
            setResetSent(false);
          }}
          className="w-full text-center text-[12px] text-[rgba(235,235,245,0.6)] hover:text-white transition-colors mt-2"
        >
          {isSignUp ? 'Already have an account? Sign in' : "Don't have an account? Sign up"}
        </button>
      </div>
    </div>
  );
}
