import { useState, useEffect } from 'react';
import {
  Database,
  FileText,
  CheckCircle,
  AlertCircle,
  RefreshCw,
  Loader2,
  HardDrive,
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

      {/* Scraped progress */}
      <div className="mb-2">
        <div className="flex justify-between items-center mb-1">
          <span className="text-[11px] text-[rgba(235,235,245,0.4)]">Scraped</span>
          <span className="text-[11px] font-mono text-[rgba(235,235,245,0.6)]">
            {stats.scraped}{stats.discovered > 0 ? `/${stats.discovered}` : ''}
          </span>
        </div>
        <ProgressBar value={stats.scraped} max={scrapeMax} color="#007AFF" />
      </div>

      {/* Vectorized progress */}
      <div>
        <div className="flex justify-between items-center mb-1">
          <span className="text-[11px] text-[rgba(235,235,245,0.4)]">Vectorized</span>
          <span className="text-[11px] font-mono text-[rgba(235,235,245,0.6)]">
            {stats.vectorized}/{stats.scraped || 0}
          </span>
        </div>
        <ProgressBar value={stats.vectorized} max={vectorMax} color="#30D158" />
      </div>

      {/* Size */}
      {stats.size_mb > 0 && (
        <p className="text-[11px] text-[rgba(235,235,245,0.3)] mt-2 text-right">{stats.size_mb} MB</p>
      )}
    </div>
  );
}

export default function DatasetPanel() {
  const [status, setStatus] = useState<PipelineStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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
  }, []);

  const datasetNums = Object.keys(DATASET_INFO).sort((a, b) => parseInt(a) - parseInt(b));

  return (
    <div className="flex-1 flex flex-col overflow-y-auto">
      <header className="shrink-0 px-5 pt-4 pb-2 bg-black flex items-center justify-between">
        <h1 className="text-[28px] font-bold tracking-tight text-white">Data</h1>
        <button
          onClick={fetchStatus}
          disabled={loading}
          className="flex items-center gap-2 bg-[#1C1C1E] px-3 py-1.5 rounded-full text-[13px] font-medium border border-[rgba(84,84,88,0.65)]"
        >
          <RefreshCw size={12} className={`text-[rgba(235,235,245,0.3)] ${loading ? 'animate-spin' : ''}`} />
          <span className="text-[rgba(235,235,245,0.6)]">Refresh</span>
        </button>
      </header>

      <div className="flex-1 px-5 pb-4">
        <div className="max-w-4xl mx-auto w-full">

          {/* Totals banner */}
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

          {/* Loading state */}
          {loading && !status && (
            <div className="flex flex-col items-center justify-center py-20">
              <Loader2 size={32} className="text-[#007AFF] animate-spin mb-3" />
              <p className="text-[15px] text-[rgba(235,235,245,0.6)]">Loading pipeline status...</p>
            </div>
          )}

          {/* Error state */}
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

          {/* Dataset grid */}
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
