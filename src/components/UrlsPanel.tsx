import { useState, useEffect, useCallback } from 'react';
import {
  Globe,
  ExternalLink,
  Copy,
  Check,
  RefreshCw,
  Loader2,
} from 'lucide-react';
import axios from 'axios';
import { useAuth } from '../contexts/AuthContext';

interface UrlItem {
  url: string;
  domain?: string;
  count: number;
  junk?: boolean;
  sources: { filename: string; page: number | null }[];
}

function UrlRow({ item }: { item: UrlItem }) {
  const [copied, setCopied] = useState(false);
  const domain = item.domain || (() => {
    try { return new URL(item.url).hostname.replace('www.', ''); } catch { return ''; }
  })();

  return (
    <div className="flex items-start gap-2 px-2.5 py-2 bg-[#2C2C2E]/50 rounded-lg group hover:bg-[#2C2C2E] transition-colors">
      <ExternalLink size={12} className="text-[#5AC8FA] mt-0.5 shrink-0" />
      <div className="flex-1 min-w-0">
        <a
          href={item.url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-[12px] text-[#5AC8FA] hover:underline break-all leading-snug"
        >
          {item.url.length > 90 ? item.url.slice(0, 87) + '...' : item.url}
        </a>
        <div className="flex items-center gap-2 mt-0.5">
          {domain && <span className="text-[10px] text-[rgba(235,235,245,0.3)]">{domain}</span>}
          <span className="text-[10px] text-[rgba(235,235,245,0.2)]">&middot;</span>
          <span className="text-[10px] text-[rgba(235,235,245,0.3)]">
            {item.count} {item.count === 1 ? 'mention' : 'mentions'}
          </span>
          {item.sources[0]?.filename && (
            <>
              <span className="text-[10px] text-[rgba(235,235,245,0.2)]">&middot;</span>
              <span className="text-[10px] text-[rgba(235,235,245,0.3)] truncate max-w-[150px]">
                {item.sources[0].filename}
              </span>
            </>
          )}
        </div>
      </div>
      <button
        onClick={() => { navigator.clipboard.writeText(item.url); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
        className="p-1 opacity-0 group-hover:opacity-100 transition-opacity text-[rgba(235,235,245,0.3)] hover:text-white"
        title="Copy URL"
      >
        {copied ? <Check size={12} className="text-[#30D158]" /> : <Copy size={12} />}
      </button>
    </div>
  );
}

export default function UrlsPanel() {
  const { isAdmin, user } = useAuth();
  const [urls, setUrls] = useState<UrlItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [extracting, setExtracting] = useState(false);
  const [urlsTab, setUrlsTab] = useState<'clean' | 'junk'>('clean');
  const [urlsExpanded, setUrlsExpanded] = useState(false);
  const [total, setTotal] = useState(0);
  const [junkCount, setJunkCount] = useState(0);
  const [cleanCount, setCleanCount] = useState(0);
  const [extractedAt, setExtractedAt] = useState<string | null>(null);

  const fetchSavedUrls = useCallback(async () => {
    setLoading(true);
    try {
      const res = await axios.get('/api/urls/saved');
      setUrls(res.data.urls || []);
      setTotal(res.data.total || 0);
      setJunkCount(res.data.junk_count || 0);
      setCleanCount(res.data.clean_count || 0);
      setExtractedAt(res.data.extracted_at || null);
    } catch (err) {
      console.error('Failed to fetch saved URLs:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  const triggerExtraction = useCallback(async () => {
    setExtracting(true);
    try {
      const res = await axios.post('/api/urls/extract');
      setUrls(res.data.urls || []);
      setTotal(res.data.total || 0);
      setJunkCount(res.data.junk_count || 0);
      setCleanCount(res.data.clean_count || 0);
      setExtractedAt(new Date().toISOString());
      setUrlsExpanded(false);
      setUrlsTab('clean');
    } catch (err) {
      console.error('Failed to extract URLs:', err);
    } finally {
      setExtracting(false);
    }
  }, []);

  useEffect(() => {
    if (user) fetchSavedUrls();
  }, [user, fetchSavedUrls]);

  const formatRelativeTime = (iso: string) => {
    const diff = Date.now() - new Date(iso).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  };

  const filtered = urls.filter(u => urlsTab === 'clean' ? !u.junk : u.junk);
  const tabCount = urlsTab === 'clean' ? cleanCount : junkCount;

  if (!user) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center px-5">
        <Globe size={32} className="text-[rgba(235,235,245,0.2)] mb-3" />
        <p className="text-[15px] text-[rgba(235,235,245,0.4)]">Sign in to view extracted URLs</p>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col overflow-y-auto">
      <header className="shrink-0 px-5 pt-4 pb-2 bg-black flex items-center justify-between">
        <div>
          <h1 className="text-[28px] font-bold tracking-tight text-white">URLs</h1>
          {extractedAt && (
            <p className="text-[11px] text-[rgba(235,235,245,0.3)] mt-0.5">
              Last extracted {formatRelativeTime(extractedAt)}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          {isAdmin && (
            <button
              onClick={triggerExtraction}
              disabled={extracting}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-[#1C1C1E] border border-[rgba(84,84,88,0.65)] rounded-full text-[13px] font-medium text-[rgba(235,235,245,0.6)] hover:border-[#5AC8FA]/50 transition-colors disabled:opacity-50"
            >
              {extracting ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} className="text-[rgba(235,235,245,0.3)]" />}
              {extracting ? 'Extracting...' : total > 0 ? 'Re-extract' : 'Extract URLs'}
            </button>
          )}
          {!extracting && total > 0 && (
            <button
              onClick={fetchSavedUrls}
              disabled={loading}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-[#1C1C1E] border border-[rgba(84,84,88,0.65)] rounded-full text-[13px] font-medium text-[rgba(235,235,245,0.6)] hover:border-[#5AC8FA]/50 transition-colors disabled:opacity-50"
            >
              <RefreshCw size={12} className={`text-[rgba(235,235,245,0.3)] ${loading ? 'animate-spin' : ''}`} />
              Refresh
            </button>
          )}
        </div>
      </header>

      <div className="flex-1 px-5 pb-4">
        <div className="max-w-4xl mx-auto w-full">

          {loading && total === 0 && (
            <div className="flex flex-col items-center justify-center py-20">
              <Loader2 size={24} className="text-[#5AC8FA] animate-spin mb-3" />
              <p className="text-[13px] text-[rgba(235,235,245,0.4)]">Loading URLs...</p>
            </div>
          )}

          {!loading && total === 0 && (
            <div className="flex flex-col items-center justify-center py-20">
              <Globe size={32} className="text-[rgba(235,235,245,0.15)] mb-3" />
              <p className="text-[15px] text-[rgba(235,235,245,0.4)] mb-1">No URLs extracted yet</p>
              <p className="text-[12px] text-[rgba(235,235,245,0.25)]">
                {isAdmin
                  ? 'Click "Extract URLs" to scan all documents for embedded URLs.'
                  : 'An admin needs to run the URL extraction first.'}
              </p>
            </div>
          )}

          {extracting && (
            <div className="bg-[#1C1C1E] border border-[#5AC8FA]/30 rounded-2xl p-4 mb-4">
              <div className="flex items-center gap-3">
                <Loader2 size={16} className="text-[#5AC8FA] animate-spin" />
                <div>
                  <p className="text-[13px] font-medium text-white">Scanning documents for URLs...</p>
                  <p className="text-[11px] text-[rgba(235,235,245,0.3)]">This may take up to a minute. Results will be saved automatically.</p>
                </div>
              </div>
            </div>
          )}

          {total > 0 && (
            <div className="bg-[#1C1C1E] border border-[rgba(84,84,88,0.65)] rounded-2xl p-4">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <Globe size={14} className="text-[#5AC8FA]" />
                  <span className="text-[13px] font-semibold text-white">URLs Found in Documents</span>
                  <span className="text-[11px] text-[rgba(235,235,245,0.4)] bg-[#2C2C2E] px-2 py-0.5 rounded-full">
                    {total.toLocaleString()}
                  </span>
                </div>
              </div>

              {/* Tabs */}
              <div className="flex gap-1 mb-3">
                <button
                  onClick={() => { setUrlsTab('clean'); setUrlsExpanded(false); }}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-medium transition-all ${
                    urlsTab === 'clean'
                      ? 'bg-[#5AC8FA]/20 text-[#5AC8FA] border border-[#5AC8FA]/30'
                      : 'bg-[#2C2C2E] text-[rgba(235,235,245,0.4)] border border-transparent hover:text-[rgba(235,235,245,0.6)]'
                  }`}
                >
                  Relevant
                  <span className="text-[10px] opacity-70">{cleanCount.toLocaleString()}</span>
                </button>
                <button
                  onClick={() => { setUrlsTab('junk'); setUrlsExpanded(false); }}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-medium transition-all ${
                    urlsTab === 'junk'
                      ? 'bg-[#FF9F0A]/20 text-[#FF9F0A] border border-[#FF9F0A]/30'
                      : 'bg-[#2C2C2E] text-[rgba(235,235,245,0.4)] border border-transparent hover:text-[rgba(235,235,245,0.6)]'
                  }`}
                >
                  Possible Junk
                  <span className="text-[10px] opacity-70">{junkCount.toLocaleString()}</span>
                </button>
              </div>

              {urlsTab === 'junk' && (
                <p className="text-[11px] text-[#FF9F0A]/60 mb-2">
                  OCR artifacts, internal systems, email wrappers — review in case something important is hiding here.
                </p>
              )}

              <div className="space-y-1.5 max-h-[calc(100dvh-280px)] overflow-y-auto pr-1 custom-scrollbar">
                {(urlsExpanded ? filtered : filtered.slice(0, 20)).map((item, i) => (
                  <UrlRow key={i} item={item} />
                ))}
              </div>

              {filtered.length > 20 && (
                <button
                  onClick={() => setUrlsExpanded(!urlsExpanded)}
                  className="mt-2 text-[12px] text-[#5AC8FA] hover:underline"
                >
                  {urlsExpanded ? 'Show less' : `Show all ${tabCount.toLocaleString()} URLs`}
                </button>
              )}

              {filtered.length === 0 && (
                <p className="text-[12px] text-[rgba(235,235,245,0.3)]">
                  {urlsTab === 'junk' ? 'No junk URLs detected.' : 'No relevant URLs found.'}
                </p>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
