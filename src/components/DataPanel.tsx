import { useState, useEffect, useRef, useCallback } from 'react';
// Build ID: FIX-TS-6133-V3
import {
  AlertCircle,
  RefreshCw,
  Loader2,
  Download,
  Activity,
  Cloud,
  Database,
  Server,
  ChevronDown,
} from 'lucide-react';

const DATASET_INFO: Record<string, { name: string; description: string }> = {
  '1': { name: 'FBI Interviews & Police Reports', description: 'Palm Beach PD 2005-2008, FBI summaries' },
  '2': { name: 'Victim Statements', description: 'Police reports and victim statements' },
  '3': { name: 'Grand Jury Materials', description: 'Federal grand jury transcripts (2007)' },
  '4': { name: 'Prosecution Memos', description: 'SDNY investigative memos, co-conspirator analysis' },
  '5': { name: 'Correspondence', description: 'Internal DOJ/FBI correspondence' },
  '6': { name: 'Court Filings', description: 'Legal motions and court orders' },
  '7': { name: 'Witness Interviews', description: 'Additional witness statements' },
  '8': { name: 'Evidence Collection', description: 'Search warrant inventories, seized materials' },
  '9': { name: 'Emails & Communications', description: 'Email chains and digital correspondence' },
  '10': { name: 'Media (Excluded)', description: 'Images and videos -- excluded from text analysis' },
  '11': { name: 'Financial Records', description: 'Ledgers, flight manifests, property seizure records' },
  '12': { name: 'Late Production', description: '~150 late-production supplemental documents' },
};

interface DatasetStats {
  name: string;
  description: string;
  discovered: number;
  scraped: number;
  vectorized: number;
  failed_ocr: number;
  size_mb: number;
}

interface PipelineStatus {
  datasets: Record<string, DatasetStats>;
  totals: {
    discovered: number;
    scraped: number;
    vectorized: number;
    failed_ocr: number;
    vectors: number;
    size_mb: number;
  };
  last_updated: string | null;
}

function StatusDot({ scraped, vectorized, discovered }: { scraped: number; vectorized: number; discovered: number }) {
  if (scraped === 0 && discovered === 0) {
    return <div className="w-2 h-2 rounded-full bg-[rgba(235,235,245,0.3)]" />;
  }
  if (vectorized >= scraped && scraped >= discovered && discovered > 0) {
    return <div className="w-2 h-2 rounded-full bg-[#30D158]" />;
  }
  return <div className="w-2 h-2 rounded-full bg-[#FF9F0A]" />;
}

function ProgressBar({ value, max, color }: { value: number; max: number; color: string }) {
  const pct = max > 0 ? Math.min((value / max) * 100, 100) : 0;
  return (
    <div className="h-1.5 w-full bg-[#3A3A3C] rounded-full overflow-hidden">
      <div
        className="h-full rounded-full transition-all duration-500"
        style={{ width: `${pct}%`, backgroundColor: color }}
      />
    </div>
  );
}

interface ScrapeProgress {
  active: boolean;
  dataset?: number;
  current_index?: number;
  total_urls?: number;
  files_uploaded?: number;
  files_skipped?: number;
  files_failed?: number;
  started_at?: string;
  last_updated?: string;
  phase?: 'discovering' | 'downloading';
  pages_crawled?: number;
}

function ScrapeProgressCard({ progress, onRefresh }: { progress: ScrapeProgress; onRefresh: () => void }) {
  const {
    dataset = 0,
    current_index = 0,
    total_urls = 0,
    files_uploaded = 0,
    // files_skipped also available in progress
    files_failed = 0,
    started_at,
    last_updated,
    phase,
    pages_crawled = 0,
  } = progress;

  const isDiscovering = phase === 'discovering';
  const dsInfo = DATASET_INFO[String(dataset)];
  const dsName = dsInfo ? `${dataset}. ${dsInfo.name}` : `Dataset ${dataset}`;
  const pct = total_urls > 0 ? Math.min((current_index / total_urls) * 100, 100) : 0;

  // Compute files/min and ETA (download phase only)
  let filesPerMin = 0;
  let etaText = '—';
  if (!isDiscovering && started_at && files_uploaded > 0) {
    const elapsedMs = Date.now() - new Date(started_at).getTime();
    const elapsedMin = elapsedMs / 60000;
    if (elapsedMin > 0) {
      filesPerMin = Math.round(files_uploaded / elapsedMin);
      const remaining = total_urls - current_index;
      if (filesPerMin > 0) {
        const etaMin = remaining / filesPerMin;
        if (etaMin < 60) {
          etaText = `~${Math.round(etaMin)}m`;
        } else if (etaMin < 1440) {
          etaText = `~${(etaMin / 60).toFixed(1)}h`;
        } else {
          etaText = `~${(etaMin / 1440).toFixed(1)}d`;
        }
      }
    }
  }

  // Pages/min and discovery ETA
  let pagesPerMin = 0;
  if (isDiscovering && started_at && pages_crawled > 0) {
    const elapsedMs = Date.now() - new Date(started_at).getTime();
    const elapsedMin = elapsedMs / 60000;
    if (elapsedMin > 0) {
      pagesPerMin = Math.round(pages_crawled / elapsedMin);
    }
  }

  // "Last updated X ago"
  let lastUpdatedText = '';
  if (last_updated) {
    const ago = Math.round((Date.now() - new Date(last_updated).getTime()) / 1000);
    if (ago < 60) lastUpdatedText = `${ago}s ago`;
    else if (ago < 3600) lastUpdatedText = `${Math.round(ago / 60)}m ago`;
    else lastUpdatedText = `${(ago / 3600).toFixed(1)}h ago`;
  }

  return (
    <div className="bg-[#1C1C1E] border border-[#0A84FF] rounded-2xl p-4 mb-4 relative overflow-hidden">
      {/* Subtle blue glow at top */}
      <div className="absolute inset-x-0 top-0 h-px bg-[#0A84FF]" />

      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2.5">
          <span className="relative flex h-2.5 w-2.5">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[#0A84FF] opacity-75" />
            <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-[#0A84FF]" />
          </span>
          <div>
            <h3 className="text-[15px] font-semibold text-white flex items-center gap-2">
              <Download size={14} className="text-[#0A84FF]" />
              {dsName}
              <span className="text-[11px] font-normal text-[#0A84FF]">
                {isDiscovering ? 'Discovering URLs...' : 'Downloading...'}
              </span>
            </h3>
          </div>
        </div>
        <button
          onClick={onRefresh}
          className="text-[11px] text-[rgba(235,235,245,0.4)] hover:text-[rgba(235,235,245,0.6)] transition-colors"
        >
          <RefreshCw size={12} />
        </button>
      </div>

      {isDiscovering ? (
        <>
          {/* Discovery phase — show pages crawled and URLs found */}
          <div className="mb-3">
            <div className="flex items-center gap-2 mb-2">
              <Loader2 size={14} className="text-[#0A84FF] animate-spin" />
              <span className="text-[13px] text-[rgba(235,235,245,0.6)]">
                Crawling DOJ pagination pages...
              </span>
            </div>
            <div className="h-2.5 w-full bg-[#3A3A3C] rounded-full overflow-hidden">
              <div className="h-full rounded-full bg-[#0A84FF] animate-pulse" style={{ width: '100%', opacity: 0.4 }} />
            </div>
          </div>

          <div className="grid grid-cols-3 gap-3 mb-2">
            <div className="text-center">
              <p className="text-[15px] font-bold text-white">{pages_crawled.toLocaleString()}</p>
              <p className="text-[10px] text-[rgba(235,235,245,0.4)]">Pages Crawled</p>
            </div>
            <div className="text-center">
              <p className="text-[15px] font-bold text-[#0A84FF]">{current_index.toLocaleString()}</p>
              <p className="text-[10px] text-[rgba(235,235,245,0.4)]">URLs Found</p>
            </div>
            <div className="text-center">
              <p className="text-[15px] font-bold text-[rgba(235,235,245,0.6)]">{pagesPerMin}</p>
              <p className="text-[10px] text-[rgba(235,235,245,0.4)]">Pages/min</p>
            </div>
          </div>
        </>
      ) : (
        <>
          {/* Download phase — existing progress bar and stats */}
          <div className="mb-3">
            <div className="flex justify-between items-center mb-1.5">
              <span className="text-[13px] font-mono text-[rgba(235,235,245,0.6)]">
                {current_index.toLocaleString()} / {total_urls.toLocaleString()}
              </span>
              <span className="text-[13px] font-mono text-[#0A84FF]">{pct.toFixed(1)}%</span>
            </div>
            <div className="h-2.5 w-full bg-[#3A3A3C] rounded-full overflow-hidden">
              <div
                className="h-full rounded-full transition-all duration-700 bg-[#0A84FF]"
                style={{ width: `${pct}%` }}
              />
            </div>
          </div>

          <div className="grid grid-cols-4 gap-3 mb-2">
            <div className="text-center">
              <p className="text-[15px] font-bold text-white">{files_uploaded.toLocaleString()}</p>
              <p className="text-[10px] text-[rgba(235,235,245,0.4)]">Uploaded</p>
            </div>
            <div className="text-center">
              <p className="text-[15px] font-bold text-[rgba(235,235,245,0.6)]">{filesPerMin}</p>
              <p className="text-[10px] text-[rgba(235,235,245,0.4)]">Files/min</p>
            </div>
            <div className="text-center">
              <p className="text-[15px] font-bold text-[#0A84FF]">{etaText}</p>
              <p className="text-[10px] text-[rgba(235,235,245,0.4)]">ETA</p>
            </div>
            <div className="text-center">
              <p className={`text-[15px] font-bold ${files_failed > 0 ? 'text-[#FF453A]' : 'text-[rgba(235,235,245,0.6)]'}`}>
                {files_failed.toLocaleString()}
              </p>
              <p className="text-[10px] text-[rgba(235,235,245,0.4)]">Errors</p>
            </div>
          </div>
        </>
      )}

      {lastUpdatedText && (
        <p className="text-[10px] text-[rgba(235,235,245,0.25)] text-right">
          Updated {lastUpdatedText}
        </p>
      )}
    </div>
  );
}

interface ReindexProgress {
  active: boolean;
  files_completed?: number;
  files_failed?: number;
  total_files?: number;
  vectors_upserted?: number;
  started_at?: string;
  last_updated?: string;
  files_this_run?: number;
}

function ReindexProgressCard({ progress, onRefresh }: { progress: ReindexProgress; onRefresh: () => void }) {
  const {
    files_completed = 0,
    files_failed = 0,
    total_files = 0,
    vectors_upserted = 0,
    started_at,
    last_updated,
    files_this_run = 0,
  } = progress;

  const pct = total_files > 0 ? Math.min((files_completed / total_files) * 100, 100) : 0;

  let filesPerMin = 0;
  let etaText = '—';
  // Use files_this_run for accurate rate calculation (avoids counting prior runs)
  const rateBase = files_this_run > 0 ? files_this_run : files_completed;
  if (started_at && rateBase > 0) {
    const elapsedMs = Date.now() - new Date(started_at).getTime();
    const elapsedMin = elapsedMs / 60000;
    if (elapsedMin > 0) {
      filesPerMin = Math.round(rateBase / elapsedMin);
      const remaining = total_files - files_completed;
      if (filesPerMin > 0) {
        const etaMin = remaining / filesPerMin;
        if (etaMin < 60) {
          etaText = `~${Math.round(etaMin)}m`;
        } else if (etaMin < 1440) {
          etaText = `~${(etaMin / 60).toFixed(1)}h`;
        } else {
          etaText = `~${(etaMin / 1440).toFixed(1)}d`;
        }
      }
    }
  }

  let lastUpdatedText = '';
  if (last_updated) {
    const ago = Math.round((Date.now() - new Date(last_updated).getTime()) / 1000);
    if (ago < 60) lastUpdatedText = `${ago}s ago`;
    else if (ago < 3600) lastUpdatedText = `${Math.round(ago / 60)}m ago`;
    else lastUpdatedText = `${(ago / 3600).toFixed(1)}h ago`;
  }

  return (
    <div className="bg-[#1C1C1E] border border-[#AF52DE] rounded-2xl p-4 mb-4 relative overflow-hidden">
      <div className="absolute inset-x-0 top-0 h-px bg-[#AF52DE]" />

      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2.5">
          <span className="relative flex h-2.5 w-2.5">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[#AF52DE] opacity-75" />
            <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-[#AF52DE]" />
          </span>
          <h3 className="text-[15px] font-semibold text-white flex items-center gap-2">
            <Database size={14} className="text-[#AF52DE]" />
            Vectorizing Documents
          </h3>
        </div>
        <button
          onClick={onRefresh}
          className="text-[11px] text-[rgba(235,235,245,0.4)] hover:text-[rgba(235,235,245,0.6)] transition-colors"
        >
          <RefreshCw size={12} />
        </button>
      </div>

      <div className="mb-3">
        <div className="flex justify-between items-center mb-1.5">
          <span className="text-[13px] font-mono text-[rgba(235,235,245,0.6)]">
            {files_completed.toLocaleString()} / {total_files.toLocaleString()}
          </span>
          <span className="text-[13px] font-mono text-[#AF52DE]">{pct.toFixed(1)}%</span>
        </div>
        <div className="h-2.5 w-full bg-[#3A3A3C] rounded-full overflow-hidden">
          <div
            className="h-full rounded-full transition-all duration-700 bg-[#AF52DE]"
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>

      <div className="grid grid-cols-5 gap-3 mb-2">
        <div className="text-center">
          <p className="text-[15px] font-bold text-white">{vectors_upserted.toLocaleString()}</p>
          <p className="text-[10px] text-[rgba(235,235,245,0.4)]">Vectors</p>
        </div>
        <div className="text-center">
          <p className="text-[15px] font-bold text-[rgba(235,235,245,0.6)]">{filesPerMin}</p>
          <p className="text-[10px] text-[rgba(235,235,245,0.4)]">Files/min</p>
        </div>
        <div className="text-center">
          <p className="text-[15px] font-bold text-[#AF52DE]">{etaText}</p>
          <p className="text-[10px] text-[rgba(235,235,245,0.4)]">ETA</p>
        </div>
        <div className="text-center">
          <p className={`text-[15px] font-bold ${files_failed > 0 ? 'text-[#FF453A]' : 'text-[rgba(235,235,245,0.6)]'}`}>
            {files_failed.toLocaleString()}
          </p>
          <p className="text-[10px] text-[rgba(235,235,245,0.4)]">Failed</p>
        </div>
        <div className="text-center">
          <p className="text-[15px] font-bold text-[#30D158]">{files_completed.toLocaleString()}</p>
          <p className="text-[10px] text-[rgba(235,235,245,0.4)]">Done</p>
        </div>
      </div>

      {lastUpdatedText && (
        <p className="text-[10px] text-[rgba(235,235,245,0.25)] text-right">
          Updated {lastUpdatedText}
        </p>
      )}
    </div>
  );
}

interface ServiceHealth {
  service: string;
  status: 'healthy' | 'down';
  latency_ms: number;
  error?: string;
  metrics: Record<string, any>;
}

interface InfraHealth {
  services: ServiceHealth[];
  checked_at: string;
}

const SERVICE_META: Record<string, { label: string; icon: typeof Cloud; color: string }> = {
  gcs: { label: 'GCS', icon: Cloud, color: '#0A84FF' },
  pinecone: { label: 'Pinecone', icon: Database, color: '#AF52DE' },
  supabase: { label: 'Supabase', icon: Database, color: '#30D158' },
  api: { label: 'API', icon: Server, color: '#FF9F0A' },
};

function formatMetric(service: string, metrics: Record<string, any>): string {
  switch (service) {
    case 'gcs': {
      const count = metrics.blob_count || 0;
      const sizeMb = metrics.size_mb || 0;
      const sizeStr = sizeMb >= 1024 ? `${(sizeMb / 1024).toFixed(1)} GB` : `${sizeMb} MB`;
      return `${count >= 1000 ? `${(count / 1000).toFixed(1)}K` : count} blobs · ${sizeStr}`;
    }
    case 'pinecone': {
      const v = metrics.total_vectors || 0;
      const vStr = v >= 1_000_000 ? `${(v / 1_000_000).toFixed(1)}M` : v >= 1000 ? `${(v / 1000).toFixed(1)}K` : String(v);
      return `${vStr} vectors · ${metrics.index_fullness ?? 0}% full`;
    }
    case 'supabase': {
      const chunks = metrics.document_chunks || 0;
      const cStr = chunks >= 1000 ? `${(chunks / 1000).toFixed(1)}K` : String(chunks);
      return `${cStr} chunks · ${metrics.nodes || 0} nodes · ${metrics.edges || 0} edges`;
    }
    case 'api':
      return `Up ${metrics.uptime || '?'} · Python ${metrics.python_version || '?'}`;
    default:
      return '';
  }
}

function InfrastructureCard() {
  const [health, setHealth] = useState<InfraHealth | null>(null);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchHealth = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/infrastructure-health');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: InfraHealth = await res.json();
      setHealth(data);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchHealth(); }, []);

  const statusColor = (s: string) =>
    s === 'healthy' ? '#30D158' : s === 'down' ? '#FF453A' : 'rgba(235,235,245,0.3)';

  return (
    <div className="bg-[#1C1C1E] border border-[rgba(84,84,88,0.65)] rounded-2xl p-4 mb-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Activity size={14} className="text-[rgba(235,235,245,0.6)]" />
          <h3 className="text-[15px] font-semibold text-white">Infrastructure</h3>
        </div>
        <button
          onClick={fetchHealth}
          disabled={loading}
          className="text-[11px] text-[rgba(235,235,245,0.4)] hover:text-[rgba(235,235,245,0.6)] transition-colors"
        >
          {loading ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
        </button>
      </div>

      {error && !health && (
        <p className="text-[12px] text-[#FF453A]">Failed to check: {error}</p>
      )}

      {loading && !health && (
        <div className="flex items-center gap-2 py-2">
          <Loader2 size={14} className="text-[rgba(235,235,245,0.4)] animate-spin" />
          <span className="text-[13px] text-[rgba(235,235,245,0.4)]">Checking services...</span>
        </div>
      )}

      {health && (
        <>
          <div className="grid grid-cols-2 gap-3">
            {health.services.map((svc) => {
              const meta = SERVICE_META[svc.service] || { label: svc.service, icon: Server, color: '#8E8E93' };
              const Icon = meta.icon;
              return (
                <div key={svc.service} className="flex items-start gap-2.5">
                  <div className="mt-0.5">
                    <div className="w-2 h-2 rounded-full" style={{ backgroundColor: statusColor(svc.status) }} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <Icon size={11} style={{ color: meta.color }} />
                      <span className="text-[13px] font-medium text-white">{meta.label}</span>
                      <span className="text-[11px] font-mono text-[rgba(235,235,245,0.3)] ml-auto">
                        {svc.latency_ms > 0 ? `${svc.latency_ms}ms` : ''}
                      </span>
                    </div>
                    <p className="text-[10px] text-[rgba(235,235,245,0.4)] truncate mt-0.5">
                      {svc.status === 'down' ? (svc.error || 'Unreachable') : formatMetric(svc.service, svc.metrics)}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>

          <button
            onClick={() => setExpanded(!expanded)}
            className="flex items-center gap-1 mt-3 text-[11px] text-[rgba(235,235,245,0.3)] hover:text-[rgba(235,235,245,0.5)] transition-colors"
          >
            <ChevronDown size={10} className={`transition-transform ${expanded ? 'rotate-180' : ''}`} />
            {expanded ? 'Hide details' : 'Show details'}
          </button>

          {expanded && (
            <div className="mt-3 space-y-3 border-t border-[rgba(84,84,88,0.35)] pt-3">
              {health.services.map((svc) => (
                <div key={`${svc.service}-detail`}>
                  <p className="text-[11px] font-medium text-[rgba(235,235,245,0.6)] mb-1">
                    {(SERVICE_META[svc.service]?.label || svc.service).toUpperCase()}
                  </p>
                  <div className="text-[11px] text-[rgba(235,235,245,0.3)] font-mono space-y-0.5">
                    {Object.entries(svc.metrics).map(([key, val]) => (
                      <div key={key} className="flex justify-between">
                        <span>{key}</span>
                        <span className="text-[rgba(235,235,245,0.5)]">
                          {typeof val === 'object' ? JSON.stringify(val) : String(val)}
                        </span>
                      </div>
                    ))}
                    {svc.error && (
                      <div className="flex justify-between text-[#FF453A]">
                        <span>error</span>
                        <span>{svc.error}</span>
                      </div>
                    )}
                  </div>
                </div>
              ))}
              {health.checked_at && (
                <p className="text-[10px] text-[rgba(235,235,245,0.2)] text-right">
                  Checked {new Date(health.checked_at).toLocaleTimeString()}
                </p>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function DatasetCard({ num, stats }: { num: string; stats: DatasetStats }) {
  const info = DATASET_INFO[num] || { name: `Dataset ${num}`, description: '' };
  const scrapeMax = Math.max(stats.discovered, stats.scraped, 1);
  const vectorMax = Math.max(stats.scraped, stats.vectorized, 1);

  return (
    <div className="bg-[#1C1C1E] border border-[rgba(84,84,88,0.65)] rounded-2xl p-4">
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <StatusDot scraped={stats.scraped} vectorized={stats.vectorized} discovered={stats.discovered} />
          <div className="min-w-0">
            <h3 className="text-[15px] font-semibold text-white truncate">
              {num}. {info.name}
            </h3>
            <p className="text-[11px] text-[rgba(235,235,245,0.4)] truncate">{info.description}</p>
          </div>
        </div>
        {stats.failed_ocr > 0 && (
          <span className="shrink-0 flex items-center gap-1 bg-[rgba(255,159,10,0.15)] text-[#FF9F0A] text-[11px] font-medium px-2 py-0.5 rounded-full">
            <AlertCircle size={10} />
            {stats.failed_ocr}
          </span>
        )}
      </div>

      <div className="mb-2">
        <div className="flex justify-between items-center mb-1">
          <span className="text-[11px] text-[rgba(235,235,245,0.4)]">Scraped</span>
          <span className="text-[11px] font-mono text-[rgba(235,235,245,0.6)]">
            {stats.scraped}{stats.discovered > 0 ? `/${stats.discovered}` : ''}
          </span>
        </div>
        <ProgressBar value={stats.scraped} max={scrapeMax} color="#007AFF" />
      </div>

      <div>
        <div className="flex justify-between items-center mb-1">
          <span className="text-[11px] text-[rgba(235,235,245,0.4)]">Vectorized</span>
          <span className="text-[11px] font-mono text-[rgba(235,235,245,0.6)]">
            {stats.vectorized}/{stats.scraped || 0}
          </span>
        </div>
        <ProgressBar value={stats.vectorized} max={vectorMax} color="#30D158" />
      </div>

      {stats.size_mb > 0 && (
        <p className="text-[11px] text-[rgba(235,235,245,0.3)] mt-2 text-right">{stats.size_mb} MB</p>
      )}
    </div>
  );
}

export default function DataPanel() {
  const [status, setStatus] = useState<PipelineStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [scrapeProgress, setScrapeProgress] = useState<ScrapeProgress | null>(null);
  const [reindexProgress, setReindexProgress] = useState<ReindexProgress | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const reindexPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchScrapeProgress = useCallback(async () => {
    try {
      const res = await fetch('/api/scrape-progress');
      if (!res.ok) return;
      const data: ScrapeProgress = await res.json();
      setScrapeProgress(data.active ? data : null);
      if (!data.active && pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    } catch {}
  }, []);

  const fetchReindexProgress = useCallback(async () => {
    try {
      const res = await fetch('/api/reindex-progress');
      if (!res.ok) return;
      const data: ReindexProgress = await res.json();
      setReindexProgress(data.active ? data : null);
      if (!data.active && reindexPollRef.current) {
        clearInterval(reindexPollRef.current);
        reindexPollRef.current = null;
      }
    } catch {}
  }, []);

  const fetchStatus = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/datasets');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setStatus(data);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchStatus();
    fetchScrapeProgress();
    fetchReindexProgress();
    pollRef.current = setInterval(fetchScrapeProgress, 30000);
    reindexPollRef.current = setInterval(fetchReindexProgress, 30000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      if (reindexPollRef.current) clearInterval(reindexPollRef.current);
    };
  }, [fetchScrapeProgress, fetchReindexProgress]);

  const datasetNums = Object.keys(DATASET_INFO).sort((a, b) => parseInt(a) - parseInt(b));

  return (
    <div className="flex-1 flex flex-col overflow-y-auto">
      <header className="shrink-0 px-5 pt-4 pb-2 bg-black flex items-center justify-between">
        <h1 className="text-[28px] font-bold tracking-tight text-white">Data</h1>
        <button
          onClick={() => { fetchStatus(); fetchScrapeProgress(); fetchReindexProgress(); }}
          disabled={loading}
          className="flex items-center gap-2 bg-[#1C1C1E] px-3 py-1.5 rounded-full text-[13px] font-medium border border-[rgba(84,84,88,0.65)]"
        >
          <RefreshCw size={12} className={`text-[rgba(235,235,245,0.3)] ${loading ? 'animate-spin' : ''}`} />
          <span className="text-[rgba(235,235,245,0.6)]">Refresh</span>
        </button>
      </header>

      <div className="flex-1 px-5 pb-4">
        <div className="max-w-4xl mx-auto w-full">

          {scrapeProgress && (
            <ScrapeProgressCard progress={scrapeProgress} onRefresh={fetchScrapeProgress} />
          )}

          {reindexProgress && (
            <ReindexProgressCard progress={reindexProgress} onRefresh={fetchReindexProgress} />
          )}

          <InfrastructureCard />

          {status?.totals && (
            <div className="bg-[#1C1C1E] border border-[rgba(84,84,88,0.65)] rounded-2xl p-4 mb-4">
              <div className="grid grid-cols-3 sm:grid-cols-5 gap-4">
                <div className="text-center">
                  <p className="text-[22px] font-bold text-white">{status.totals.scraped}</p>
                  <p className="text-[11px] text-[rgba(235,235,245,0.4)]">Files Scraped</p>
                </div>
                <div className="text-center">
                  <p className="text-[22px] font-bold text-[#30D158]">{status.totals.vectorized}</p>
                  <p className="text-[11px] text-[rgba(235,235,245,0.4)]">Vectorized</p>
                </div>
                <div className="text-center">
                  <p className="text-[22px] font-bold text-[#FF9F0A]">{status.totals.failed_ocr}</p>
                  <p className="text-[11px] text-[rgba(235,235,245,0.4)]">Failed OCR</p>
                </div>
                <div className="text-center">
                  <p className="text-[22px] font-bold text-[#007AFF]">{status.totals.vectors.toLocaleString()}</p>
                  <p className="text-[11px] text-[rgba(235,235,245,0.4)]">Vectors</p>
                </div>
                <div className="text-center">
                  <p className="text-[22px] font-bold text-[rgba(235,235,245,0.6)]">{status.totals.size_mb}</p>
                  <p className="text-[11px] text-[rgba(235,235,245,0.4)]">MB Total</p>
                </div>
              </div>
              {status.last_updated && (
                <p className="text-[11px] text-[rgba(235,235,245,0.3)] text-center mt-3">
                  Last updated: {new Date(status.last_updated).toLocaleString()}
                </p>
              )}
            </div>
          )}

          {loading && !status && (
            <div className="flex flex-col items-center justify-center py-20">
              <Loader2 size={32} className="text-[#007AFF] animate-spin mb-3" />
              <p className="text-[15px] text-[rgba(235,235,245,0.6)]">Loading pipeline status...</p>
            </div>
          )}

          {error && !status && (
            <div className="flex flex-col items-center justify-center py-20">
              <AlertCircle size={32} className="text-[#FF453A] mb-3" />
              <p className="text-[15px] text-[rgba(235,235,245,0.6)]">Failed to load status</p>
              <p className="text-[13px] text-[rgba(235,235,245,0.3)] mt-1">{error}</p>
              <button
                onClick={fetchStatus}
                className="mt-4 bg-[#007AFF] hover:bg-[#0071E3] px-4 py-2 rounded-full text-[13px] font-semibold transition-colors"
              >
                Retry
              </button>
            </div>
          )}

          {status && (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {datasetNums.map((num) => {
                const ds = status.datasets[num];
                const stats: DatasetStats = ds || {
                  name: DATASET_INFO[num]?.name || `Dataset ${num}`,
                  description: DATASET_INFO[num]?.description || '',
                  discovered: 0,
                  scraped: 0,
                  vectorized: 0,
                  failed_ocr: 0,
                  size_mb: 0,
                };
                return <DatasetCard key={num} num={num} stats={stats} />;
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
